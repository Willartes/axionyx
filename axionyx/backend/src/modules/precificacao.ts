import { router, audit, paged, Where, can, r2 } from '../core/http'
import { db, tx, Q } from '../core/db'
import { crud } from '../core/crud'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, forbidden } from '../core/errors'
import { calculatePrice, companyIndicators, PricingError, PricingInput } from '../services/pricing'

const CHANNELS = ['loja', 'ecommerce', 'marketplace'] as const

// ---------- Cadastros: custos fixos e variáveis ----------
crud({ table: 'fixed_costs', path: '/api/pricing/fixed-costs', entity: 'custo_fixo', label: 'Custo fixo', view: 'precificacao.ver', edit: 'precificacao.editar', order: 't.category, t.description',
  search: ['t.description'], schema: { category: v.enum(['ocupacao', 'pessoal', 'administrativo', 'comercial', 'financeiro', 'depreciacao', 'pro_labore', 'outros'] as const),
    description: v.string({ min: 2, max: 150 }), monthly_amount: v.money({ min: 0 }), branch_id: v.uuid().optional(), active: v.boolean().optional(), notes: v.string({ max: 500 }).optional() } })

crud({ table: 'variable_costs', path: '/api/pricing/variable-costs', entity: 'custo_variavel', label: 'Custo variável', view: 'precificacao.ver', edit: 'precificacao.editar', order: 't.kind, t.category, t.description',
  search: ['t.description'], schema: { category: v.enum(['impostos', 'cartao', 'comissao', 'marketplace', 'frete', 'embalagem', 'perdas', 'royalties', 'outros'] as const),
    description: v.string({ min: 2, max: 150 }), kind: v.enum(['percentual', 'valor_unitario'] as const), value: v.number({ min: 0, max: 1000000 }),
    channel: v.enum(['todos', 'loja', 'ecommerce', 'marketplace'] as const).optional(), active: v.boolean().optional() },
  guard: (b) => { if (b.kind === 'percentual' && b.value !== undefined && b.value >= 100) throw unprocessable('Percentual deve ser menor que 100%.') } })

// ---------- Contexto de precificação (parâmetros + totais reais) ----------
export async function pricingContext(c: Q, companyId: string, channel = 'loja') {
  await c.query(`INSERT INTO pricing_settings(company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [companyId])
  const s = await c.one(`SELECT * FROM pricing_settings WHERE company_id = $1`, [companyId])
  const fixed = await c.one(`SELECT COALESCE(sum(monthly_amount),0) AS total, count(*)::int AS n FROM fixed_costs WHERE company_id = $1 AND active`, [companyId])
  const vars = await c.one(`SELECT COALESCE(sum(value) FILTER (WHERE kind = 'percentual'),0) AS pct, COALESCE(sum(value) FILTER (WHERE kind = 'valor_unitario'),0) AS unit
                              FROM variable_costs WHERE company_id = $1 AND active AND channel IN ('todos', $2)`, [companyId, channel])
  const hist = await c.one(`SELECT COALESCE(sum(total),0) / 3 AS revenue, COALESCE(sum(cost_total),0) / 3 AS cmv, COALESCE(sum(items_count),0)::numeric / 3 AS pieces
                              FROM sales WHERE company_id = $1 AND type = 'venda' AND status IN ('concluida','devolvida_parcial') AND created_at >= now() - interval '90 days'`, [companyId])
  const revenueAuto = r2(Number(hist.revenue))
  const revenueBase = s.revenue_base_mode === 'manual' && Number(s.revenue_base_manual) > 0 ? Number(s.revenue_base_manual) : revenueAuto
  const fixedTotal = Number(fixed.total)
  const fixedPctRaw = revenueBase > 0 ? (fixedTotal / revenueBase) * 100 : 0
  return {
    settings: s, channel, fixedTotal, fixedCount: fixed.n, variablePct: Number(vars.pct), unitVariable: Number(vars.unit),
    revenueAuto, revenueBase, cmvAuto: r2(Number(hist.cmv)), piecesAuto: Number(hist.pieces),
    fixedPct: s.include_fixed_costs ? Math.round(fixedPctRaw * 10000) / 10000 : 0, fixedPctRaw: Math.round(fixedPctRaw * 10000) / 10000,
    revenueMissing: s.include_fixed_costs && fixedTotal > 0 && revenueBase <= 0,
  }
}

router.get('/api/pricing/settings', { perm: 'precificacao.ver' }, async (ctx) => {
  const channel = (CHANNELS as readonly string[]).includes(ctx.query.channel) ? ctx.query.channel : 'loja'
  return pricingContext(db, ctx.user.companyId, channel)
})

router.put('/api/pricing/settings', { perm: 'precificacao.editar' }, async (ctx) => {
  const b: any = parse(v.object({ desired_margin_pct: v.number({ min: -50, max: 90 }).optional(), include_fixed_costs: v.boolean().optional(),
    revenue_base_mode: v.enum(['media_3m', 'manual'] as const).optional(), revenue_base_manual: v.money({ min: 0 }).nullable().optional(),
    min_margin_pct: v.number({ min: -50, max: 90 }).optional(), rounding: v.enum(['nenhum', 'centavos_90', 'centavos_99', 'inteiro'] as const).optional() }), ctx.body)
  const keys = Object.keys(b).filter((k) => b[k] !== undefined || k === 'revenue_base_manual')
  if (!keys.length) throw unprocessable('Nada para alterar.')
  await db.query(`INSERT INTO pricing_settings(company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ctx.user.companyId])
  await db.query(`UPDATE pricing_settings SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE company_id = $1`,
    [ctx.user.companyId, ctx.user.id, ...keys.map((k) => b[k] ?? null)])
  await audit(null, ctx, 'precificacao.parametros', 'pricing_settings', ctx.user.companyId, b, 'warning')
  return pricingContext(db, ctx.user.companyId)
})

/** Sugestão de custos fixos a partir das contas a pagar recorrentes dos últimos 3 meses (não grava nada). */
router.get('/api/pricing/fixed-costs-suggestions', { perm: 'precificacao.editar' }, async (ctx) => {
  const rentRe = /aluguel|condom[ií]nio|iptu/i
  const map: Record<string, string> = { despesas_pessoal: 'pessoal', despesas_administrativas: 'administrativo', despesas_comerciais: 'comercial', despesas_operacionais: 'ocupacao', despesas_financeiras: 'financeiro' }
  const rows = await db.many(`
    SELECT COALESCE(p.description, fc.name) AS description, fc.dre_group, round(sum(p.amount) / 3, 2) AS monthly_amount, count(*)::int AS titles
      FROM payables p JOIN financial_categories fc ON fc.id = p.category_id
     WHERE p.company_id = $1 AND p.status <> 'cancelado' AND p.due_date > current_date - 90 AND p.due_date <= current_date
       AND fc.dre_group IN ('despesas_pessoal','despesas_administrativas','despesas_comerciais','despesas_operacionais','despesas_financeiras')
       AND p.source_type NOT IN ('taxa_cartao','comissao')
     GROUP BY 1, 2 HAVING count(*) >= 2 ORDER BY 3 DESC LIMIT 50`, [ctx.user.companyId])
  const existing = new Set((await db.many(`SELECT lower(description) AS d FROM fixed_costs WHERE company_id = $1`, [ctx.user.companyId])).map((r) => r.d))
  return rows.map((r) => ({ ...r, category: rentRe.test(String(r.description)) ? 'ocupacao' : map[r.dre_group] ?? 'outros', already: existing.has(String(r.description).toLowerCase()) }))
})

// ---------- Cálculo de preço ----------
const calcSchema = v.object({
  productId: v.uuid().optional(), variantId: v.uuid().optional(), channel: v.enum(CHANNELS).default('loja'), scenarioName: v.string({ max: 60 }).optional(),
  acquisitionCost: v.number({ min: 0 }).optional(), freight: v.number({ min: 0 }).optional(), insurance: v.number({ min: 0 }).optional(), packaging: v.number({ min: 0 }).optional(),
  storage: v.number({ min: 0 }).optional(), otherCosts: v.number({ min: 0 }).optional(), lossesPct: v.number({ min: 0, max: 100 }).optional(),
  variablePct: v.number({ min: 0, max: 99.99 }).optional(), unitVariableCosts: v.number({ min: 0 }).optional(), fixedPct: v.number({ min: 0, max: 99.99 }).optional(),
  includeFixedCosts: v.boolean().optional(), desiredMarginPct: v.number({ min: -50, max: 95 }).optional(),
  mode: v.enum(['margem', 'markup', 'preco'] as const).default('margem'), markup: v.number({ min: 0 }).optional(), price: v.number({ min: 0 }).optional(),
  rounding: v.enum(['nenhum', 'centavos_90', 'centavos_99', 'inteiro'] as const).optional(), save: v.boolean().default(false),
})

async function loadTarget(c: Q, companyId: string, productId?: string, variantId?: string) {
  if (variantId) {
    const r = await c.one(`SELECT p.id AS product_id, p.code, p.name, v.id AS variant_id, v.sku, COALESCE(v.cost_price, p.cost_price) AS cost, COALESCE(v.sale_price, p.sale_price) AS price
                             FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND v.company_id = $2`, [variantId, companyId])
    if (!r) throw notFound('Variação')
    return r
  }
  if (productId) {
    const r = await c.one(`SELECT id AS product_id, code, name, NULL::uuid AS variant_id, NULL AS sku, cost_price AS cost, sale_price AS price FROM products WHERE id = $1 AND company_id = $2`, [productId, companyId])
    if (!r) throw notFound('Produto')
    return r
  }
  return null
}

async function runCalc(c: Q, ctx: any, b: any) {
  const pc = await pricingContext(c, ctx.user.companyId, b.channel)
  const target = await loadTarget(c, ctx.user.companyId, b.productId, b.variantId)
  const include = b.includeFixedCosts ?? pc.settings.include_fixed_costs
  const input: PricingInput = {
    acquisitionCost: b.acquisitionCost ?? Number(target?.cost ?? 0), freight: b.freight, insurance: b.insurance, packaging: b.packaging, storage: b.storage, otherCosts: b.otherCosts, lossesPct: b.lossesPct,
    unitVariableCosts: b.unitVariableCosts ?? pc.unitVariable, variablePct: b.variablePct ?? pc.variablePct,
    fixedPct: include ? (b.fixedPct ?? pc.fixedPctRaw) : 0, desiredMarginPct: b.desiredMarginPct ?? Number(pc.settings.desired_margin_pct),
    mode: b.mode, markup: b.markup, price: b.price, rounding: b.rounding ?? pc.settings.rounding, monthlyFixedCosts: pc.fixedTotal, currentPrice: target ? Number(target.price) : null,
  }
  let result
  try { result = calculatePrice(input) } catch (e: any) { if (e instanceof PricingError) throw unprocessable(e.message); throw e }
  if (include && pc.revenueMissing) result.warnings.unshift('Sem faturamento de referência: os custos fixos não puderam ser rateados no preço. Informe um faturamento mensal manual nos parâmetros.')
  if (Number(pc.settings.min_margin_pct) && result.netMarginPct < Number(pc.settings.min_margin_pct)) result.warnings.push(`Margem líquida abaixo do mínimo configurado (${Number(pc.settings.min_margin_pct)}%).`)
  return { pc, target, input: { ...input, channel: b.channel, includeFixedCosts: include }, result }
}

router.post('/api/pricing/calculate', { perm: 'precificacao.ver' }, async (ctx) => {
  const b: any = parse(calcSchema, ctx.body)
  if (b.save && !can(ctx.user, 'precificacao.editar')) throw forbidden('Registrar simulações exige permissão de edição da precificação.')
  return tx(async (c) => {
    const { target, input, result } = await runCalc(c, ctx, b)
    let historyId: string | null = null
    if (b.save) {
      const h = await c.one(`INSERT INTO pricing_history(company_id, branch_id, product_id, variant_id, kind, scenario_name, unit_cost, previous_price, suggested_price, desired_margin_pct, contribution_pct, net_margin_pct, markup, input, result, user_id)
                             VALUES ($1,$2,$3,$4,'simulacao',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [ctx.user.companyId, ctx.user.branchId, target?.product_id ?? null, target?.variant_id ?? null, b.scenarioName ?? null, result.unitCost, target ? Number(target.price) : null, result.suggestedPrice,
          input.desiredMarginPct ?? null, result.contributionPct, result.netMarginPct, result.markupMultiplier, JSON.stringify(input), JSON.stringify(result), ctx.user.id])
      historyId = h.id
    }
    return { target, input, result, historyId }
  })
})

/** Aplica um preço ao produto/variação: recalcula no servidor, grava histórico e auditoria na mesma transação. */
router.post('/api/pricing/apply', { perm: 'precificacao.aplicar', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({ productId: v.uuid(), variantId: v.uuid().optional(), price: v.money({ min: 0.01 }),
    clearVariantPrices: v.boolean().default(false) }), ctx.body)
  const calcBody: any = parse(calcSchema, { ...ctx.body, price: undefined, save: false, mode: ctx.body?.mode === 'markup' ? 'markup' : 'margem' })
  return tx(async (c) => {
    const { target, input, result } = await runCalc(c, ctx, calcBody)
    if (!target) throw notFound('Produto')
    const price = r2(b.price)
    const check = calculatePrice({ ...input, mode: 'preco', price })
    if (b.variantId) {
      await c.query(`UPDATE product_variants SET sale_price = $3 WHERE id = $1 AND company_id = $2`, [b.variantId, ctx.user.companyId, price])
    } else {
      await c.query(`UPDATE products SET sale_price = $3, updated_at = now() WHERE id = $1 AND company_id = $2`, [b.productId, ctx.user.companyId, price])
      if (b.clearVariantPrices) await c.query(`UPDATE product_variants SET sale_price = NULL WHERE product_id = $1 AND company_id = $2`, [b.productId, ctx.user.companyId])
    }
    const h = await c.one(`INSERT INTO pricing_history(company_id, branch_id, product_id, variant_id, kind, scenario_name, unit_cost, previous_price, suggested_price, applied_price, desired_margin_pct, contribution_pct, net_margin_pct, markup, input, result, user_id)
                           VALUES ($1,$2,$3,$4,'aplicacao',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [ctx.user.companyId, ctx.user.branchId, b.productId, b.variantId ?? null, calcBody.scenarioName ?? null, check.unitCost, Number(target.price), result.suggestedPrice, price,
        input.desiredMarginPct ?? null, check.contributionPct, check.netMarginPct, check.markupMultiplier, JSON.stringify(input), JSON.stringify(check), ctx.user.id])
    await audit(c, ctx, 'precificacao.preco_aplicado', b.variantId ? 'product_variant' : 'product', b.variantId ?? b.productId,
      { produto: target.code, preco_anterior: Number(target.price), preco_novo: price, sugerido: result.suggestedPrice, margem_liquida: check.netMarginPct, historico: h.id }, 'warning')
    await c.query(`INSERT INTO outbox(company_id, integration_id, topic, payload, dedupe_key)
                   SELECT $1, i.id, 'ecommerce.produto', jsonb_build_object('productId', $2::text), 'produto:' || $2 || ':preco:' || $3
                     FROM integrations i WHERE i.company_id = $1 AND i.kind = 'ecommerce' AND i.status = 'ativo' ON CONFLICT DO NOTHING`, [ctx.user.companyId, b.productId, h.id])
    return { ok: true, historyId: h.id, previousPrice: Number(target.price), price, analysis: check }
  })
})

router.get('/api/pricing/history', { perm: 'precificacao.ver' }, async (ctx) => {
  const w = new Where([['h.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.kind, 'h.kind = ?', ctx.query.kind).addIf(ctx.query.product, 'h.product_id = ?', ctx.query.product)
  if (ctx.query.q) w.add('(p.name ILIKE ? OR p.code ILIKE ?)', `%${ctx.query.q}%`, `%${ctx.query.q}%`)
  return paged(db, `SELECT h.id, h.kind, h.scenario_name, h.unit_cost, h.previous_price, h.suggested_price, h.applied_price, h.desired_margin_pct, h.contribution_pct, h.net_margin_pct, h.markup, h.created_at,
                           p.code, p.name AS product, v.sku, u.name AS user_name
                      FROM pricing_history h LEFT JOIN products p ON p.id = h.product_id LEFT JOIN product_variants v ON v.id = h.variant_id LEFT JOIN users u ON u.id = h.user_id
                      ${w.sql} ORDER BY h.created_at DESC`, w.params, ctx.query, 50)
})
router.get('/api/pricing/history/:id', { perm: 'precificacao.ver' }, async (ctx) => {
  const h = await db.one(`SELECT h.*, p.code, p.name AS product FROM pricing_history h LEFT JOIN products p ON p.id = h.product_id WHERE h.id = $1 AND h.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!h) throw notFound('Registro de precificação')
  return h
})

// ---------- Indicadores da empresa ----------
router.get('/api/pricing/indicators', { perm: 'precificacao.ver' }, async (ctx) => {
  const pc = await pricingContext(db, ctx.user.companyId)
  const revenue = pc.revenueBase
  const cmv = pc.settings.revenue_base_mode === 'manual' && pc.revenueAuto > 0 ? pc.cmvAuto * (revenue / pc.revenueAuto) : pc.cmvAuto
  const pieces = pc.settings.revenue_base_mode === 'manual' && pc.revenueAuto > 0 ? pc.piecesAuto * (revenue / pc.revenueAuto) : pc.piecesAuto
  const current = companyIndicators({ revenue, cmv, variablePct: pc.variablePct, unitVariableTotal: pc.unitVariable * pieces, fixedCosts: pc.fixedTotal, desiredMarginPct: Number(pc.settings.desired_margin_pct) })
  // série mensal (6 meses) com o ponto de equilíbrio de cada mês, usando os custos fixos atuais
  const months = await db.many(`
    SELECT to_char(m, 'YYYY-MM') AS month, COALESCE(sum(s.total),0) AS revenue, COALESCE(sum(s.cost_total),0) AS cmv, COALESCE(sum(s.items_count),0)::int AS pieces
      FROM generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m
      LEFT JOIN sales s ON s.company_id = $1 AND s.type = 'venda' AND s.status IN ('concluida','devolvida_parcial') AND date_trunc('month', s.created_at) = m
     GROUP BY m ORDER BY m`, [ctx.user.companyId])
  const series = months.map((m) => ({ month: m.month, ...companyIndicators({ revenue: Number(m.revenue), cmv: Number(m.cmv), variablePct: pc.variablePct, unitVariableTotal: pc.unitVariable * m.pieces, fixedCosts: pc.fixedTotal, desiredMarginPct: Number(pc.settings.desired_margin_pct) }) }))
  const byCategory = await db.many(`SELECT category, COALESCE(sum(monthly_amount),0) AS total, count(*)::int AS n FROM fixed_costs WHERE company_id = $1 AND active GROUP BY category ORDER BY 2 DESC`, [ctx.user.companyId])
  const variableItems = await db.many(`SELECT category, description, kind, value, channel FROM variable_costs WHERE company_id = $1 AND active ORDER BY kind, value DESC`, [ctx.user.companyId])
  return { basis: { mode: pc.settings.revenue_base_mode, revenueAuto: pc.revenueAuto, revenueBase: pc.revenueBase, months: 3 }, current, series, fixedByCategory: byCategory, variableItems,
    settings: pc.settings, canSeeCost: can(ctx.user, 'produtos.custo') }
})

// ---------- Análise da carteira de produtos ----------
router.get('/api/pricing/products', { perm: 'precificacao.ver' }, async (ctx) => {
  const pc = await pricingContext(db, ctx.user.companyId)
  const w = new Where([['p.company_id = ?', ctx.user.companyId], ['p.active']])
  if (ctx.query.q) w.add('(p.name ILIKE ? OR p.code ILIKE ?)', `%${ctx.query.q}%`, `%${ctx.query.q}%`)
  w.addIf(ctx.query.brand, 'p.brand_id = ?', ctx.query.brand).addIf(ctx.query.category, 'p.category_id = ?', ctx.query.category).addIf(ctx.query.collection, 'p.collection_id = ?', ctx.query.collection)
  const rows = await db.many(`
    SELECT p.id, p.code, p.name, p.sale_price AS price, p.cost_price AS cost, b.name AS brand,
           (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.sale_price IS NOT NULL AND v.sale_price <> p.sale_price) AS variant_prices,
           COALESCE((SELECT sum(si.qty - si.returned_qty) FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id
                      WHERE v.product_id = p.id AND s.status IN ('concluida','devolvida_parcial') AND s.created_at > now() - interval '90 days'),0)::int AS sold_90d,
           (SELECT max(created_at) FROM pricing_history h WHERE h.product_id = p.id AND h.kind = 'aplicacao') AS last_applied
      FROM products p LEFT JOIN brands b ON b.id = p.brand_id ${w.sql} ORDER BY p.name`, w.params)
  const desired = Number(pc.settings.desired_margin_pct), minM = Number(pc.settings.min_margin_pct)
  const items = rows.map((r) => {
    const cost = Number(r.cost), price = Number(r.price)
    if (!(cost > 0) || !(price > 0)) return { ...r, status: 'sem_custo', analysis: null, suggested: null }
    const unitVar = pc.unitVariable
    const a = calculatePrice({ acquisitionCost: cost, unitVariableCosts: unitVar, variablePct: pc.variablePct, fixedPct: pc.fixedPct, desiredMarginPct: desired, mode: 'preco', price, monthlyFixedCosts: pc.fixedTotal })
    let suggested: number | null = null
    try { suggested = calculatePrice({ acquisitionCost: cost, unitVariableCosts: unitVar, variablePct: pc.variablePct, fixedPct: pc.fixedPct, desiredMarginPct: desired, rounding: pc.settings.rounding }).suggestedPrice } catch { /* parâmetros inviáveis */ }
    const status = a.contributionUnit <= 0 ? 'prejuizo_variavel' : a.netProfitUnit < 0 ? 'prejuizo' : a.netMarginPct < (minM || 0) ? 'abaixo_minimo' : a.netMarginPct < desired - 0.5 ? 'abaixo_meta' : 'ok'
    return { ...r, status, suggested, analysis: { unitCost: a.unitCost, contributionUnit: a.contributionUnit, contributionPct: a.contributionPct, netMarginPct: a.netMarginPct, markupMultiplier: a.markupMultiplier,
      minimumPrice: a.minimumPrice, floorPrice: a.floorPrice, breakevenUnits: a.breakevenUnits } }
  })
  const status = ctx.query.status
  const filtered = status ? items.filter((i) => i.status === status) : items
  const summary = items.reduce((acc: Record<string, number>, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc }, {})
  const page = Math.max(1, parseInt(ctx.query.page || '1', 10)), size = Math.min(200, Math.max(1, parseInt(ctx.query.size || '50', 10)))
  return { items: filtered.slice((page - 1) * size, page * size), total: filtered.length, page, size, pages: Math.max(1, Math.ceil(filtered.length / size)), summary,
    params: { variablePct: pc.variablePct, fixedPct: pc.fixedPct, unitVariable: pc.unitVariable, desiredMarginPct: desired } }
})

// ---------- Metas de precificação (venda mínima/alvo) ----------
router.post('/api/pricing/goals', { perm: 'precificacao.editar' }, async (ctx) => {
  const b: any = parse(v.object({ productId: v.uuid(), historyId: v.uuid().optional(), name: v.string({ min: 3, max: 150 }), startDate: v.date(), endDate: v.date(),
    targetUnits: v.number({ min: 0 }), unitPrice: v.money({ min: 0.01 }), unitContribution: v.number().optional(), breakevenUnits: v.number({ min: 0 }).optional() }), ctx.body)
  if (b.endDate < b.startDate) throw unprocessable('A data final deve ser posterior à inicial.')
  return tx(async (c) => {
    const p = await c.one(`SELECT id FROM products WHERE id = $1 AND company_id = $2`, [b.productId, ctx.user.companyId])
    if (!p) throw notFound('Produto')
    if (b.historyId) { const h = await c.one(`SELECT 1 FROM pricing_history WHERE id = $1 AND company_id = $2`, [b.historyId, ctx.user.companyId]); if (!h) throw notFound('Simulação') }
    const prev = await c.one(`UPDATE pricing_goals SET status = 'substituida' WHERE company_id = $1 AND product_id = $2 AND status = 'ativa' RETURNING id`, [ctx.user.companyId, b.productId])
    const g = await c.one(`INSERT INTO pricing_goals(company_id, product_id, history_id, name, start_date, end_date, target_units, target_revenue, breakeven_units, unit_price, unit_contribution, previous_goal_id, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [ctx.user.companyId, b.productId, b.historyId ?? null, b.name, b.startDate, b.endDate, b.targetUnits, r2(b.targetUnits * b.unitPrice), b.breakevenUnits ?? null, b.unitPrice, b.unitContribution ?? null, prev?.id ?? null, ctx.user.id])
    await audit(c, ctx, 'precificacao.meta_definida', 'pricing_goal', g.id, { ...b, substituiu: prev?.id ?? null })
    return g
  })
})

router.get('/api/pricing/goals', { perm: 'precificacao.ver' }, async (ctx) => {
  const status = ctx.query.status || 'ativa'
  return db.many(`
    SELECT g.*, p.code, p.name AS product,
           COALESCE((SELECT sum(si.qty - si.returned_qty) FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id
                      WHERE v.product_id = g.product_id AND s.company_id = g.company_id AND s.status IN ('concluida','devolvida_parcial') AND s.type = 'venda'
                        AND s.created_at >= g.start_date AND s.created_at < g.end_date + 1),0)::numeric AS realized_units,
           COALESCE((SELECT sum(si.total) FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id
                      WHERE v.product_id = g.product_id AND s.company_id = g.company_id AND s.status IN ('concluida','devolvida_parcial') AND s.type = 'venda'
                        AND s.created_at >= g.start_date AND s.created_at < g.end_date + 1),0) AS realized_revenue
      FROM pricing_goals g JOIN products p ON p.id = g.product_id
     WHERE g.company_id = $1 AND ($2 = 'todas' OR g.status = $2) ORDER BY g.created_at DESC LIMIT 200`, [ctx.user.companyId, status])
})

router.post('/api/pricing/goals/:id/close', { perm: 'precificacao.editar' }, async (ctx) => {
  const g = await db.one(`UPDATE pricing_goals SET status = 'encerrada' WHERE id = $1 AND company_id = $2 AND status = 'ativa' RETURNING id`, [ctx.params.id, ctx.user.companyId])
  if (!g) throw notFound('Meta ativa')
  await audit(null, ctx, 'precificacao.meta_encerrada', 'pricing_goal', g.id)
  return { ok: true }
})

