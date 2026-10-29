import { router, audit, paged, Where, can, r2, branchScope, today } from '../core/http'
import { db } from '../core/db'
import { crud } from '../core/crud'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, forbidden } from '../core/errors'
import { BALANCE_SQL } from '../services/finance'

// ---------- CRM ----------
crud({ table: 'opportunities', path: '/api/opportunities', entity: 'oportunidade', label: 'Oportunidade', view: 'crm.ver', edit: 'crm.editar', order: 't.updated_at DESC',
  select: `t.*, (SELECT name FROM customers c WHERE c.id = t.customer_id) AS customer, (SELECT name FROM users u WHERE u.id = t.owner_id) AS owner`,
  search: ['t.title', 't.contact'], schema: { title: v.string({ min: 2, max: 150 }), customer_id: v.uuid().optional(), contact: v.string({ max: 100 }).optional(), value: v.money({ min: 0 }).optional(),
    probability: v.int({ min: 0, max: 100 }).optional(), stage: v.enum(['Prospecção', 'Qualificação', 'Proposta', 'Negociação', 'Fechamento', 'Perdido'] as const).optional(), owner_id: v.uuid().optional(), notes: v.string({ max: 2000 }).optional() } })

// ---------- RH ----------
router.get('/api/employees', { perm: 'rh.ver' }, async (ctx) => {
  const w = new Where([['e.company_id = ?', ctx.user.companyId]])
  if (ctx.query.q) w.add('(e.name ILIKE ? OR e.job_title ILIKE ? OR e.department ILIKE ?)', `%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`)
  w.addIf(ctx.query.status, 'e.status = ?', ctx.query.status)
  const sal = can(ctx.user, 'rh.salarios') ? 'e.salary' : 'NULL::numeric AS salary'
  const res = await paged(db, `SELECT e.id, e.name, e.cpf, e.email, e.phone, e.job_title, e.department, e.admission_date, e.status, e.user_id, ${sal}, b.name AS branch,
                                     (SELECT COALESCE(sum(s.total),0) FROM sales s WHERE s.seller_id = e.user_id AND s.status <> 'cancelada' AND s.created_at >= date_trunc('month', now())) AS sales_month
                                FROM employees e LEFT JOIN branches b ON b.id = e.branch_id ${w.sql} ORDER BY e.name`, w.params, ctx.query, 100)
  const stats = await db.one(`SELECT count(*) FILTER (WHERE status <> 'Desligado')::int AS active, count(*) FILTER (WHERE status = 'Férias')::int AS vacation, count(*) FILTER (WHERE status = 'Afastado')::int AS away,
                                     count(*) FILTER (WHERE admission_date >= date_trunc('month', now()))::int AS hires_month ${can(ctx.user, 'rh.salarios') ? ', COALESCE(sum(salary) FILTER (WHERE status <> \'Desligado\'),0) AS payroll' : ''}
                                FROM employees WHERE company_id = $1`, [ctx.user.companyId])
  return { ...res, stats }
})
crud({ table: 'employees', path: '/api/employees-admin', entity: 'colaborador', label: 'Colaborador', view: 'rh.ver', edit: 'rh.editar', order: 't.name',
  schema: { name: v.string({ min: 3, max: 120 }), cpf: v.string({ max: 14 }).optional(), email: v.email().optional(), phone: v.string({ max: 20 }).optional(), job_title: v.string({ max: 80 }).optional(),
    department: v.string({ max: 80 }).optional(), admission_date: v.date().optional(), salary: v.money({ min: 0 }).optional(), status: v.enum(['Ativo', 'Férias', 'Afastado', 'Desligado'] as const).optional(),
    branch_id: v.uuid().optional(), user_id: v.uuid().optional() },
  mask: (r, ctx) => (can(ctx.user, 'rh.salarios') ? r : { ...r, salary: null }),
  guard: (b, ctx) => { if ('salary' in b && b.salary !== undefined && !can(ctx.user, 'rh.salarios')) throw forbidden('Alterar salário exige a permissão de salários.') } })

// ---------- Jurídico ----------
crud({ table: 'legal_cases', path: '/api/legal-cases', entity: 'processo', label: 'Processo', view: 'juridico.ver', edit: 'juridico.editar', order: 't.next_deadline NULLS LAST, t.created_at DESC',
  search: ['t.number', 't.title', 't.counterpart'], schema: { number: v.string({ min: 3, max: 40 }), title: v.string({ min: 3, max: 200 }), kind: v.string({ min: 2, max: 60 }), court: v.string({ max: 120 }).optional(),
    counterpart: v.string({ max: 150 }).optional(), status: v.string({ max: 40 }).optional(), risk: v.enum(['Baixo', 'Médio', 'Alto'] as const).optional(), amount: v.money({ min: 0 }).optional(),
    next_deadline: v.date().optional(), lawyer: v.string({ max: 100 }).optional(), notes: v.string({ max: 4000 }).optional() } })

// ---------- Contabilidade ----------
crud({ table: 'chart_of_accounts', path: '/api/chart-of-accounts', entity: 'conta_contabil', label: 'Conta contábil', view: 'contabilidade.ver', edit: 'contabilidade.editar', order: 't.code',
  search: ['t.code', 't.name'], schema: { code: v.string({ min: 1, max: 20 }), name: v.string({ min: 2, max: 120 }), type: v.enum(['Ativo', 'Passivo', 'Patrimônio Líquido', 'Receita', 'Despesa', 'Custo'] as const),
    nature: v.enum(['Devedora', 'Credora'] as const), analytic: v.boolean().optional() } })

/** Lançamentos gerenciais derivados dos movimentos financeiros (partida dobrada simplificada por tipo de conta). */
router.get('/api/accounting/entries', { perm: 'contabilidade.ver' }, async (ctx) => {
  const w = new Where([['t.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.from, 't.date >= ?', ctx.query.from).addIf(ctx.query.to, 't.date <= ?', ctx.query.to)
  return paged(db, `
    SELECT t.id, t.date, t.description, t.amount, t.direction, a.name AS account, a.type AS account_type, fc.name AS category, fc.dre_group,
           CASE WHEN t.direction = 'entrada' THEN (CASE a.type WHEN 'caixa' THEN '1.1.01 Caixa' ELSE '1.1.02 Bancos' END) ELSE COALESCE(fc.code || ' ' || fc.name, 'Despesas diversas') END AS debit,
           CASE WHEN t.direction = 'entrada' THEN COALESCE(fc.code || ' ' || fc.name, 'Receitas diversas') ELSE (CASE a.type WHEN 'caixa' THEN '1.1.01 Caixa' ELSE '1.1.02 Bancos' END) END AS credit
      FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id LEFT JOIN financial_categories fc ON fc.id = t.category_id ${w.sql} ORDER BY t.date DESC, t.created_at DESC`, w.params, ctx.query, 50)
})

router.get('/api/accounting/summary', { perm: 'contabilidade.ver' }, async (ctx) => {
  const id = ctx.user.companyId
  return db.one(`SELECT
      (SELECT COALESCE(sum(opening_balance),0) FROM financial_accounts WHERE company_id = $1) + (SELECT COALESCE(sum(CASE WHEN direction='entrada' THEN amount ELSE -amount END),0) FROM financial_transactions WHERE company_id = $1) AS cash_and_banks,
      (SELECT COALESCE(sum(${BALANCE_SQL}),0) FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial')) AS receivables,
      (SELECT COALESCE(sum(sb.qty * COALESCE(v.cost_price, p.cost_price)),0) FROM stock_balances sb JOIN product_variants v ON v.id = sb.variant_id JOIN products p ON p.id = v.product_id WHERE sb.company_id = $1) AS inventory,
      (SELECT COALESCE(sum(${BALANCE_SQL}),0) FROM payables WHERE company_id = $1 AND status IN ('aberto','parcial')) AS payables,
      (SELECT COALESCE(sum(balance),0) FROM store_credits WHERE company_id = $1 AND status = 'ativo') + (SELECT COALESCE(sum(remaining),0) FROM loyalty_ledger WHERE company_id = $1 AND remaining > 0 AND (expires_at IS NULL OR expires_at >= current_date)) AS customer_credits,
      (SELECT count(*)::int FROM financial_transactions WHERE company_id = $1 AND date >= date_trunc('month', current_date)) AS entries_month`, [id])
})

// ---------- Documentos ----------
router.get('/api/documents', { perm: 'documentos.ver' }, async (ctx) => {
  const w = new Where([['d.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.folder, 'd.folder = ?', ctx.query.folder).addIf(ctx.query.entity, 'd.entity = ?', ctx.query.entity).addIf(ctx.query.entityId, 'd.entity_id = ?', ctx.query.entityId)
  if (ctx.query.q) w.add('d.name ILIKE ?', `%${ctx.query.q}%`)
  const res = await paged(db, `SELECT d.id, d.folder, d.name, d.mime, d.size, d.entity, d.entity_id, d.created_at, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by ${w.sql} ORDER BY d.created_at DESC`, w.params, ctx.query, 50)
  const folders = await db.many(`SELECT folder, count(*)::int AS n FROM documents WHERE company_id = $1 GROUP BY folder ORDER BY folder`, [ctx.user.companyId])
  return { ...res, folders }
})
router.post('/api/documents', { perm: 'documentos.editar', maxBody: 15_000_000 }, async (ctx) => {
  let name = '', folder = 'Geral'
  try { name = decodeURIComponent(String(ctx.req.headers['x-file-name'] || '')).replace(/[\x00-\x1f]/g, '').slice(0, 200); folder = decodeURIComponent(String(ctx.req.headers['x-folder'] || 'Geral')).replace(/[\x00-\x1f]/g, '').slice(0, 80) }
  catch { throw unprocessable('Nome do arquivo inválido.') }
  if (!name) throw unprocessable('Informe o nome do arquivo (cabeçalho X-File-Name).')
  if (!ctx.rawBody.length) throw unprocessable('Arquivo vazio.')
  const mime = String(ctx.req.headers['content-type'] || 'application/octet-stream').split(';')[0]
  const entity = ctx.req.headers['x-entity'] ? String(ctx.req.headers['x-entity']).replace(/[^a-z_]/g, '').slice(0, 40) : null
  const entityId = ctx.req.headers['x-entity-id'] ? String(ctx.req.headers['x-entity-id']) : null
  if (entityId && !/^[0-9a-f-]{36}$/i.test(entityId)) throw unprocessable('Vínculo inválido.')
  const allowed = /^(application\/pdf|image\/(png|jpeg|webp)|text\/(plain|csv|xml)|application\/(xml|zip|vnd\.openxmlformats-officedocument\..+|msword|vnd\.ms-excel)|application\/octet-stream)$/
  if (!allowed.test(mime)) throw unprocessable('Tipo de arquivo não permitido.')
  const r = await db.one(`INSERT INTO documents(company_id, folder, name, mime, size, content, uploaded_by, entity, entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, folder, name, mime, size, created_at`,
    [ctx.user.companyId, folder, name, mime, ctx.rawBody.length, ctx.rawBody, ctx.user.id, entity, entityId])
  await audit(null, ctx, 'documento.enviado', 'document', r.id, { name, folder, size: r.size })
  return r
})
router.get('/api/documents/:id/download', { perm: 'documentos.ver' }, async (ctx) => {
  const d = await db.one(`SELECT name, mime, content FROM documents WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!d) throw notFound('Documento')
  ctx.reply = { headers: { 'content-type': d.mime, 'content-disposition': `attachment; filename="${encodeURIComponent(d.name)}"` }, raw: d.content }
  return null
})
router.delete('/api/documents/:id', { perm: 'documentos.editar' }, async (ctx) => {
  const r = await db.one(`DELETE FROM documents WHERE id = $1 AND company_id = $2 RETURNING name`, [ctx.params.id, ctx.user.companyId])
  if (!r) throw notFound('Documento')
  await audit(null, ctx, 'documento.excluido', 'document', ctx.params.id, { name: r.name }, 'warning')
  return { ok: true }
})

// ---------- Intelligence (estatística sobre dados reais; sem modelos externos) ----------
/** Previsão semanal por média móvel com tendência linear (mínimos quadrados) das últimas 12 semanas. */
router.get('/api/intelligence/forecast', { perm: ['dashboard.ver', 'estoque.ver'] }, async (ctx) => {
  const branches = branchScope(ctx, ctx.query.branch || 'all')
  const product = ctx.query.product || null
  const hist = await db.many(`
    SELECT to_char(w, 'YYYY-MM-DD') AS week, COALESCE(sum(si.qty - si.returned_qty),0)::float8 AS qty, COALESCE(sum(si.total),0) AS revenue
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') w
      LEFT JOIN sales s ON date_trunc('week', s.created_at) = w AND s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[]))
      LEFT JOIN sale_items si ON si.sale_id = s.id AND ($3::uuid IS NULL OR si.variant_id IN (SELECT id FROM product_variants WHERE product_id = $3))
     GROUP BY w ORDER BY w`, [ctx.user.companyId, branches.length ? branches : null, product])
  const ys = hist.map((h) => Number(product ? h.qty : h.revenue))
  const n = ys.length, xs = ys.map((_, i) => i)
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / (xs.reduce((a, x) => a + (x - mx) ** 2, 0) || 1)
  const intercept = my - slope * mx
  const resid = Math.sqrt(ys.reduce((a, y, i) => a + (y - (intercept + slope * i)) ** 2, 0) / Math.max(1, n - 2))
  const forecast = [1, 2, 3, 4].map((k) => { const val = Math.max(0, intercept + slope * (n - 1 + k)); return { step: k, value: r2(val), low: r2(Math.max(0, val - 1.28 * resid)), high: r2(val + 1.28 * resid) } })
  const mape = ys.filter((y) => y > 0).length ? r2(ys.reduce((a, y, i) => (y > 0 ? a + Math.abs(y - (intercept + slope * i)) / y : a), 0) / ys.filter((y) => y > 0).length * 100) : null
  return { metric: product ? 'quantidade' : 'faturamento', history: hist, forecast, trendPerWeek: r2(slope), mapePct: mape, method: 'Regressão linear sobre 12 semanas (intervalo de 80%)' }
})

/** Sugestão de reposição: média diária de 30 dias × (prazo de reposição + cobertura) − saldo. */
router.get('/api/intelligence/replenishment', { perm: 'estoque.ver' }, async (ctx) => {
  const lead = Math.min(120, Math.max(1, parseInt(ctx.query.leadDays || '15', 10)))
  const cover = Math.min(120, Math.max(1, parseInt(ctx.query.coverDays || '30', 10)))
  const branches = branchScope(ctx, ctx.query.branch || 'current')
  const rows = await db.many(`
    WITH sold AS (SELECT si.variant_id, sum(si.qty - si.returned_qty)::numeric AS q FROM sale_items si JOIN sales s ON s.id = si.sale_id
                   WHERE s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND s.created_at > now() - interval '30 days' AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[])) GROUP BY 1),
         st AS (SELECT variant_id, sum(qty)::float8 AS qty FROM stock_balances WHERE company_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[])) GROUP BY 1)
    SELECT v.id AS variant_id, v.sku, p.name, sz.code AS size, co.name AS color, b.name AS brand, COALESCE(st.qty,0) AS stock, round(sold.q / 30, 3) AS daily_avg,
           CASE WHEN sold.q > 0 THEN round(COALESCE(st.qty,0) / (sold.q / 30)) END AS coverage_days,
           GREATEST(0, ceil((sold.q / 30) * ($3::int + $4::int) - COALESCE(st.qty,0)))::float8 AS suggested, COALESCE(v.cost_price, p.cost_price) AS cost, COALESCE(v.sale_price, p.sale_price) AS price, p.supplier_id, (SELECT name FROM suppliers su WHERE su.id = p.supplier_id) AS supplier, p.id AS product_id, p.code
      FROM sold JOIN product_variants v ON v.id = sold.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN st ON st.variant_id = v.id
      LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id LEFT JOIN brands b ON b.id = p.brand_id
     WHERE sold.q > 0 ORDER BY coverage_days NULLS FIRST, suggested DESC LIMIT 200`, [ctx.user.companyId, branches.length ? branches : null, lead, cover])
  return { leadDays: lead, coverDays: cover, items: rows.map((r) => ({ ...r, cost: can(ctx.user, 'produtos.custo') ? r.cost : null, risk: r.coverage_days === null ? 'alto' : Number(r.coverage_days) < lead ? 'alto' : Number(r.coverage_days) < lead + 7 ? 'medio' : 'baixo' })) }
})

/** Insights por regras sobre os dados do sistema (cada um traz a evidência numérica). */
export async function insights(companyId: string, perms: { finance: boolean }) {
  const out: { type: 'danger' | 'warning' | 'info'; severity: string; text: string; action: string; label: string; evidence?: any }[] = []
  const rupture = await db.one(`
    WITH sold AS (SELECT si.variant_id, sum(si.qty)::numeric / 30 AS d FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.created_at > now() - interval '30 days' GROUP BY 1)
    SELECT count(*)::int AS n FROM sold LEFT JOIN (SELECT variant_id, sum(qty) AS q FROM stock_balances WHERE company_id = $1 GROUP BY 1) st ON st.variant_id = sold.variant_id
     WHERE sold.d > 0 AND COALESCE(st.q,0) / sold.d < 14`, [companyId])
  if (rupture.n > 0) out.push({ type: 'warning', severity: 'Alto', text: `${rupture.n} variação(ões) com cobertura de estoque inferior a 14 dias pelo ritmo de vendas dos últimos 30 dias.`, action: 'estoque-inteligente', label: 'Ver reposição', evidence: rupture })
  const slow = await db.one(`SELECT count(DISTINCT v.product_id)::int AS n, COALESCE(sum(sb.qty * COALESCE(v.cost_price, p.cost_price)),0) AS value FROM stock_balances sb JOIN product_variants v ON v.id = sb.variant_id JOIN products p ON p.id = v.product_id
                              WHERE sb.company_id = $1 AND sb.qty > 0 AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.variant_id = v.id AND s.created_at > now() - interval '60 days' AND s.status <> 'cancelada')`, [companyId])
  if (slow.n > 0) out.push({ type: 'info', severity: 'Médio', text: `${slow.n} produto(s) com estoque e sem venda há 60 dias (capital parado de R$ ${Number(slow.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}). Avalie liquidação ou transferência.`, action: 'estoque-posicao', label: 'Ver estoque', evidence: slow })
  const cond = await db.one(`SELECT count(*)::int AS n FROM conditionals WHERE company_id = $1 AND status = 'aberto' AND due_date < current_date`, [companyId])
  if (cond.n > 0) out.push({ type: 'danger', severity: 'Alto', text: `${cond.n} condicional(is)/bag(s) com prazo de devolução vencido.`, action: 'condicionais', label: 'Ver condicionais', evidence: cond })
  if (perms.finance) {
    const od = await db.one(`SELECT COALESCE(sum(${BALANCE_SQL}),0) AS v, count(DISTINCT customer_id)::int AS c FROM receivables WHERE company_id = $1 AND method_kind = 'crediario' AND status IN ('aberto','parcial') AND due_date < current_date`, [companyId])
    if (Number(od.v) > 0) out.push({ type: 'danger', severity: 'Alto', text: `Crediário em atraso: R$ ${Number(od.v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} de ${od.c} cliente(s).`, action: 'crediario', label: 'Ver inadimplência', evidence: od })
    const conc = await db.one(`WITH t AS (SELECT customer_id, sum(total) AS v FROM sales WHERE company_id = $1 AND status <> 'cancelada' AND type = 'venda' AND customer_id IS NOT NULL AND created_at > now() - interval '90 days' GROUP BY 1)
                               SELECT COALESCE((SELECT sum(v) FROM (SELECT v FROM t ORDER BY v DESC LIMIT 3) x) / NULLIF((SELECT sum(total) FROM sales WHERE company_id = $1 AND status <> 'cancelada' AND type = 'venda' AND created_at > now() - interval '90 days'),0) * 100, 0) AS pct`, [companyId])
    if (Number(conc.pct) >= 25) out.push({ type: 'warning', severity: 'Médio', text: `Os 3 maiores clientes concentram ${r2(Number(conc.pct))}% do faturamento dos últimos 90 dias.`, action: 'clientes', label: 'Ver clientes', evidence: conc })
  }
  const disc = await db.one(`SELECT COALESCE(sum(discount_total) / NULLIF(sum(subtotal),0) * 100, 0) AS cur,
                                   (SELECT COALESCE(sum(discount_total) / NULLIF(sum(subtotal),0) * 100, 0) FROM sales WHERE company_id = $1 AND status <> 'cancelada' AND type = 'venda' AND created_at BETWEEN now() - interval '60 days' AND now() - interval '30 days') AS prev
                              FROM sales WHERE company_id = $1 AND status <> 'cancelada' AND type = 'venda' AND created_at > now() - interval '30 days'`, [companyId])
  if (Number(disc.cur) > Number(disc.prev) + 2) out.push({ type: 'warning', severity: 'Médio', text: `Desconto médio subiu de ${r2(Number(disc.prev))}% para ${r2(Number(disc.cur))}% nos últimos 30 dias.`, action: 'relatorios', label: 'Analisar vendas', evidence: disc })
  const birthdays = await db.one(`SELECT count(*)::int AS n FROM customers WHERE company_id = $1 AND active AND anonymized_at IS NULL AND extract(month from birth_date) = extract(month from current_date)`, [companyId])
  if (birthdays.n > 0) out.push({ type: 'info', severity: 'Baixo', text: `${birthdays.n} cliente(s) fazem aniversário neste mês — oportunidade de campanha (respeitando o consentimento).`, action: 'clientes', label: 'Ver aniversariantes', evidence: birthdays })
  return out
}
router.get('/api/intelligence/insights', { perm: 'dashboard.ver' }, async (ctx) => ({ generatedAt: new Date().toISOString(), method: 'Regras de negócio sobre os dados do AXIONYX (sem IA generativa)', items: await insights(ctx.user.companyId, { finance: can(ctx.user, 'financeiro.ver') }) }))

/** Base real para simulações (faturamento, margem e despesas dos últimos 3 meses). */
router.get('/api/intelligence/baseline', { perm: 'dashboard.ver' }, async (ctx) => {
  const b = await db.one(`SELECT COALESCE(sum(total)/3,0) AS revenue_month, COALESCE(sum(cost_total)/3,0) AS cost_month, COALESCE(avg(total),0) AS ticket, count(*)/3.0 AS sales_month, COALESCE(sum(discount_total)/NULLIF(sum(subtotal),0)*100,0) AS discount_pct
                            FROM sales WHERE company_id = $1 AND type = 'venda' AND status <> 'cancelada' AND created_at > now() - interval '90 days'`, [ctx.user.companyId])
  const exp = await db.one(`SELECT COALESCE(sum(p.amount)/3,0) AS v FROM payables p JOIN financial_categories fc ON fc.id = p.category_id WHERE p.company_id = $1 AND p.status <> 'cancelado' AND fc.dre_group LIKE 'despesas%' AND p.due_date > current_date - 90 AND p.due_date <= current_date`, [ctx.user.companyId])
  return { revenueMonth: r2(Number(b.revenue_month)), costMonth: can(ctx.user, 'produtos.custo') ? r2(Number(b.cost_month)) : null, ticket: r2(Number(b.ticket)), salesMonth: r2(Number(b.sales_month)), discountPct: r2(Number(b.discount_pct)), expensesMonth: r2(Number(exp.v)) }
})

// ---------- AXIA: assistente por regras (consultas reais; LLM pendente de configuração) ----------
router.post('/api/assistant/ask', {}, async (ctx) => {
  const b = parse(v.object({ question: v.string({ min: 2, max: 500 }) }), ctx.body)
  const q = b.question.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const id = ctx.user.companyId
  const brl = (n: number) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const answer = async (): Promise<{ text: string; link?: string; data?: any }> => {
    if (/(vend|fatur)/.test(q) && /hoje/.test(q) && can(ctx.user, 'vendas.ver')) {
      const r = await db.one(`SELECT count(*)::int AS n, COALESCE(sum(total),0) AS t FROM sales WHERE company_id = $1 AND branch_id = $2 AND type = 'venda' AND status <> 'cancelada' AND created_at >= current_date`, [id, ctx.user.branchId])
      return { text: `Hoje, nesta filial: ${r.n} venda(s), total de ${brl(r.t)}${r.n ? ` (ticket médio ${brl(r.t / r.n)})` : ''}.`, link: 'pedidos' }
    }
    if (/(vend|fatur)/.test(q) && /(mes|mensal)/.test(q) && can(ctx.user, 'vendas.ver')) {
      const r = await db.one(`SELECT count(*)::int AS n, COALESCE(sum(total),0) AS t, COALESCE(sum(items_count),0)::int AS i FROM sales WHERE company_id = $1 AND type = 'venda' AND status <> 'cancelada' AND created_at >= date_trunc('month', now())`, [id])
      return { text: `No mês: ${r.n} venda(s), ${brl(r.t)} faturados, ${r.i} peça(s). Ticket médio ${brl(r.n ? r.t / r.n : 0)}, ${r.n ? (r.i / r.n).toFixed(2) : 0} peças por venda.`, link: 'relatorios' }
    }
    if (/(estoque|ruptura|repor|reposicao)/.test(q) && can(ctx.user, 'estoque.ver')) {
      const r = await db.many(`SELECT p.name, sz.code AS size, co.name AS color, COALESCE(sum(sb.qty),0)::float8 AS qty, COALESCE(v.min_stock, p.min_stock) AS min FROM product_variants v JOIN products p ON p.id = v.product_id
                                LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id LEFT JOIN stock_balances sb ON sb.variant_id = v.id
                               WHERE v.company_id = $1 AND v.active AND p.track_stock GROUP BY v.id, p.name, sz.code, co.name, p.min_stock HAVING COALESCE(sum(sb.qty),0) <= COALESCE(v.min_stock, p.min_stock) AND COALESCE(v.min_stock, p.min_stock) > 0 ORDER BY 4 LIMIT 8`, [id])
      return { text: r.length ? `Itens no ou abaixo do mínimo:\n${r.map((x) => `• ${x.name} ${x.color ?? ''} ${x.size ?? ''}: ${x.qty} (mín. ${x.min})`).join('\n')}` : 'Nenhuma variação abaixo do estoque mínimo.', link: 'estoque-posicao' }
    }
    if (/(vencid|atras|inadimpl|cobranc)/.test(q) && can(ctx.user, 'financeiro.ver')) {
      const r = await db.one(`SELECT count(*)::int AS n, COALESCE(sum(${BALANCE_SQL}),0) AS t FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date < current_date`, [id])
      return { text: `Há ${r.n} título(s) a receber vencido(s), somando ${brl(r.t)}.`, link: 'contas-receber' }
    }
    if (/condiciona|bag/.test(q) && can(ctx.user, 'condicional.ver')) {
      const r = await db.one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE due_date < current_date)::int AS late FROM conditionals WHERE company_id = $1 AND status = 'aberto'`, [id])
      return { text: `${r.n} condicional(is)/bag(s) em aberto, ${r.late} com prazo vencido.`, link: 'condicionais' }
    }
    if (/aniversari/.test(q) && can(ctx.user, 'clientes.ver')) {
      const r = await db.many(`SELECT name, to_char(birth_date, 'DD/MM') AS d FROM customers WHERE company_id = $1 AND active AND anonymized_at IS NULL AND extract(month from birth_date) = extract(month from current_date) ORDER BY extract(day from birth_date) LIMIT 15`, [id])
      return { text: r.length ? `Aniversariantes do mês:\n${r.map((x) => `• ${x.d} — ${x.name}`).join('\n')}` : 'Nenhum aniversariante cadastrado neste mês.', link: 'clientes' }
    }
    if (/(mais vendid|top|campe)/.test(q) && can(ctx.user, 'vendas.ver')) {
      const r = await db.many(`SELECT p.name, sum(si.qty)::float8 AS q FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                                WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.created_at > now() - interval '30 days' GROUP BY p.name ORDER BY q DESC LIMIT 5`, [id])
      return { text: r.length ? `Mais vendidos (30 dias):\n${r.map((x, i) => `${i + 1}. ${x.name} — ${x.q} peça(s)`).join('\n')}` : 'Sem vendas nos últimos 30 dias.', link: 'relatorios' }
    }
    if (/insight|alerta|resumo|como estamos/.test(q)) {
      const items = await insights(id, { finance: can(ctx.user, 'financeiro.ver') })
      return { text: items.length ? items.map((i) => `• ${i.text}`).join('\n') : 'Nenhum alerta relevante no momento.', link: 'ia-insights' }
    }
    return { text: 'Posso responder sobre: vendas de hoje ou do mês, estoque abaixo do mínimo, títulos vencidos, condicionais em aberto, aniversariantes, produtos mais vendidos e um resumo de alertas. (Assistente baseado em regras — integração com modelo de linguagem pendente de configuração.)' }
  }
  const r = await answer()
  return { ...r, engine: 'regras', at: new Date().toISOString() }
})

export const _today = today
