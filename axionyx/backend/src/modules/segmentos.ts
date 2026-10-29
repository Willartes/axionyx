import { router, audit, paged, Where, rateLimit, r2 } from '../core/http'
import { requirePlatform } from '../core/platform'
import { db, tx } from '../core/db'
import { v, parse, onlyDigits, isValidGTIN } from '../core/validate'
import { notFound, unprocessable, forbidden, conflict } from '../core/errors'
import { publicSegments, applySegment, SEGMENTS, SegmentId, FEATURE_MODULES, segmentInfo } from '../services/segments'
import { moveStock } from '../services/stock'
import { getSettings } from '../services/settings'
import { consumeLots, resolveScale, buildScaleBarcode, checkQty, findPackagingOrCombo, r3 } from '../services/retail'

// =====================================================================
// Segmentos
// =====================================================================
router.get('/api/segments', { auth: 'none' }, async () => ({ segments: publicSegments(), featureModules: FEATURE_MODULES }))

router.get('/api/company/segment', {}, async (ctx) => {
  const co = await db.one(`SELECT segment, modules FROM companies WHERE id = $1`, [ctx.user.companyId])
  return { ...segmentInfo(co?.segment), modules: co?.modules ?? [] }
})

/** Aplica (ou troca) o segmento de uma empresa. Só acrescenta módulos/categorias/parâmetros; nada é apagado. */
router.post('/api/admin/companies/:id/segment', { perm: 'admin.empresas' }, async (ctx) => {
  // segmento define os módulos contratados: só a equipe da plataforma aplica
  if (!ctx.user.isSuperadmin || !(ctx.user.platformOwner || ctx.user.platformPerms.has('suporte.editar'))) throw forbidden('O segmento e os módulos seguem o contrato: peça a alteração ao suporte AXIONYX.')
  const b: any = parse(v.object({ segment: v.enum(Object.keys(SEGMENTS) as [SegmentId, ...SegmentId[]]) }), ctx.body)
  if (SEGMENTS[b.segment as SegmentId].status !== 'disponivel') throw unprocessable('Este segmento ainda está em preparação.')
  return tx(async (c) => {
    const co = await c.one(`SELECT id, segment FROM companies WHERE id = $1`, [ctx.params.id])
    if (!co) throw notFound('Empresa')
    const r = await applySegment(c, co.id, b.segment)
    await audit(c, ctx, 'empresa.segmento_aplicado', 'company', co.id, { de: co.segment, para: b.segment, ...r }, 'warning', { companyId: co.id })
    return r
  })
})

// =====================================================================
// Lotes e validade
// =====================================================================
router.get('/api/stock/lots', { perm: 'estoque.ver' }, async (ctx) => {
  const settings = await getSettings(db, ctx.user.companyId)
  const alert = Number(ctx.query.days || settings.validade.alertaDias || 3)
  const w = new Where([['l.company_id = ?', ctx.user.companyId], ['l.qty_remaining > 0']])
  if (ctx.query.branch !== 'all') w.add('l.branch_id = ?', ctx.user.branchId)
  if (ctx.query.status === 'vencido') w.add('l.expiry_date < current_date')
  else if (ctx.query.status === 'vencendo') w.add(`l.expiry_date >= current_date AND l.expiry_date <= current_date + ?::int`, alert)
  else if (ctx.query.status === 'ok') w.add(`(l.expiry_date IS NULL OR l.expiry_date > current_date + ?::int)`, alert)
  if (ctx.query.q) w.add('(p.name ILIKE ? OR v.sku ILIKE ? OR l.lot_code ILIKE ?)', `%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`)
  const res = await paged(db, `SELECT l.*, v.sku, p.name, p.unit, p.sale_by_weight, br.name AS branch, (l.expiry_date - current_date) AS days_left,
                                      COALESCE(l.unit_cost, v.cost_price, p.cost_price, 0) * l.qty_remaining AS value_at_cost
                                 FROM stock_lots l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id JOIN branches br ON br.id = l.branch_id
                                 ${w.sql} ORDER BY l.expiry_date NULLS LAST, p.name`, w.params, ctx.query, 50)
  const summary = await db.one(`SELECT count(*) FILTER (WHERE expiry_date < current_date)::int AS vencidos,
                                       count(*) FILTER (WHERE expiry_date >= current_date AND expiry_date <= current_date + $3::int)::int AS vencendo,
                                       COALESCE(sum(COALESCE(l.unit_cost, 0) * qty_remaining) FILTER (WHERE expiry_date < current_date + $3::int), 0) AS valor_em_risco
                                  FROM stock_lots l WHERE company_id = $1 AND qty_remaining > 0 AND ($2::uuid IS NULL OR branch_id = $2)`,
    [ctx.user.companyId, ctx.query.branch === 'all' ? null : ctx.user.branchId, alert])
  return { ...res, summary: { ...summary, alertDays: alert } }
})

/** Entrada com lote/validade (e safra): lança a entrada no estoque e registra o lote, na mesma transação. */
router.post('/api/stock/lots', { perm: ['estoque.lotes', 'estoque.movimentar'], idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({ variantId: v.uuid(), qty: v.number({ min: 0.001, max: 1000000 }), lotCode: v.string({ max: 40 }).optional(), expiryDate: v.date().optional(),
    vintage: v.int({ min: 1900, max: 2100 }).optional(), unitCost: v.money({ min: 0 }).optional(), notes: v.string({ max: 300 }).optional(), addToStock: v.boolean().default(true) }), ctx.body)
  return tx(async (c) => {
    const p = await c.one(`SELECT v.sku, p.unit, p.sale_by_weight, p.shelf_life_days, COALESCE(v.cost_price, p.cost_price) AS cost FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND v.company_id = $2`, [b.variantId, ctx.user.companyId])
    if (!p) throw notFound('Produto')
    const qty = checkQty(b.qty, p)
    let expiry = b.expiryDate ?? null
    if (!expiry && p.shelf_life_days != null) expiry = (await c.one(`SELECT (current_date + $1::int)::text AS d`, [p.shelf_life_days])).d
    if (expiry && expiry < (await c.one(`SELECT current_date::text AS d`)).d) throw unprocessable('A validade informada já passou.')
    const lot = await c.one(`INSERT INTO stock_lots(company_id, branch_id, variant_id, lot_code, vintage, expiry_date, qty_initial, qty_remaining, unit_cost, source, notes, created_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.user.companyId, ctx.user.branchId, b.variantId, b.lotCode ?? null, b.vintage ?? null, expiry, qty, b.unitCost ?? p.cost ?? null, b.addToStock ? 'entrada' : 'registro', b.notes ?? null, ctx.user.id])
    if (b.addToStock) await moveStock(c, { companyId: ctx.user.companyId, branchId: ctx.user.branchId, variantId: b.variantId, qty, type: 'entrada', refType: 'lot', refId: lot.id,
      unitCost: b.unitCost ?? p.cost, notes: `Entrada lote ${b.lotCode ?? ''}${expiry ? ' val. ' + expiry : ''}`.trim(), userId: ctx.user.id })
    await audit(c, ctx, 'estoque.lote_registrado', 'stock_lot', lot.id, { sku: p.sku, qty, expiry, vintage: b.vintage ?? null, entrada: b.addToStock })
    return lot
  })
})

// =====================================================================
// Perdas
// =====================================================================
const LOSS_REASONS = ['vencido', 'avariado', 'quebra', 'furto', 'consumo_interno', 'degustacao', 'amostra', 'outros'] as const
router.post('/api/stock/losses', { perm: 'estoque.perdas', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({ variantId: v.uuid().optional(), lotId: v.uuid().optional(), qty: v.number({ min: 0.001, max: 1000000 }).optional(), reason: v.enum(LOSS_REASONS), notes: v.string({ max: 300 }).optional() }), ctx.body)
  return tx(async (c) => {
    let lot: any = null
    if (b.lotId) {
      lot = await c.one(`SELECT * FROM stock_lots WHERE id = $1 AND company_id = $2 FOR UPDATE`, [b.lotId, ctx.user.companyId])
      if (!lot) throw notFound('Lote')
      if (b.variantId && b.variantId !== lot.variant_id) throw unprocessable('O lote não pertence a este produto.')
    }
    const variantId = lot?.variant_id ?? b.variantId
    if (!variantId) throw unprocessable('Informe o produto ou o lote.')
    const p = await c.one(`SELECT v.sku, p.name, p.unit, p.sale_by_weight, COALESCE(v.cost_price, p.cost_price, 0) AS cost FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND v.company_id = $2`, [variantId, ctx.user.companyId])
    if (!p) throw notFound('Produto')
    const qty = checkQty(b.qty ?? Number(lot?.qty_remaining ?? 0), p)
    if (lot && qty > Number(lot.qty_remaining) + 1e-9) throw unprocessable(`O lote tem apenas ${Number(lot.qty_remaining)} disponível.`)
    const branchId = lot?.branch_id ?? ctx.user.branchId
    const unitCost = Number(lot?.unit_cost ?? p.cost ?? 0)
    await moveStock(c, { companyId: ctx.user.companyId, branchId, variantId, qty: -qty, type: 'perda', refType: 'loss', unitCost, notes: `Perda: ${b.reason}${b.notes ? ' — ' + b.notes : ''}`, userId: ctx.user.id, allowNegative: true })
    if (lot) await c.query(`UPDATE stock_lots SET qty_remaining = qty_remaining - $2 WHERE id = $1`, [lot.id, qty])
    else await consumeLots(c, branchId, variantId, qty)
    const loss = await c.one(`INSERT INTO stock_losses(company_id, branch_id, variant_id, lot_id, qty, unit_cost, total_cost, reason, notes, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.user.companyId, branchId, variantId, lot?.id ?? null, qty, unitCost, r2(unitCost * qty), b.reason, b.notes ?? null, ctx.user.id])
    await audit(c, ctx, 'estoque.perda', 'stock_loss', loss.id, { sku: p.sku, qty, reason: b.reason, custo: loss.total_cost }, 'warning')
    return loss
  })
})

router.get('/api/stock/losses', { perm: 'estoque.ver' }, async (ctx) => {
  const from = ctx.query.from || (await db.one(`SELECT (date_trunc('month', now()))::date::text AS d`)).d
  const to = ctx.query.to || (await db.one(`SELECT current_date::text AS d`)).d
  const w = new Where([['l.company_id = ?', ctx.user.companyId], ['l.created_at >= ?::date', from], [`l.created_at < ?::date + interval '1 day'`, to]])
  w.addIf(ctx.query.reason, 'l.reason = ?', ctx.query.reason)
  const res = await paged(db, `SELECT l.*, v.sku, p.name, p.unit, br.name AS branch, u.name AS user_name, sl.lot_code, sl.expiry_date
                                 FROM stock_losses l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id JOIN branches br ON br.id = l.branch_id
                                 LEFT JOIN users u ON u.id = l.user_id LEFT JOIN stock_lots sl ON sl.id = l.lot_id ${w.sql} ORDER BY l.created_at DESC`, w.params, ctx.query, 50)
  const byReason = await db.many(`SELECT reason, count(*)::int AS n, COALESCE(sum(total_cost),0) AS cost FROM stock_losses l ${w.sql} GROUP BY reason ORDER BY 3 DESC`, w.params)
  const topProducts = await db.many(`SELECT p.name, sum(l.qty)::float8 AS qty, sum(l.total_cost) AS cost, p.unit FROM stock_losses l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
                                      ${w.sql} GROUP BY p.name, p.unit ORDER BY 3 DESC LIMIT 10`, w.params)
  const revenue = await db.one(`SELECT COALESCE(sum(total),0) AS revenue, COALESCE(sum(cost_total),0) AS cmv FROM sales WHERE company_id = $1 AND type = 'venda' AND status IN ('concluida','devolvida_parcial')
                                  AND created_at >= $2::date AND created_at < $3::date + interval '1 day'`, [ctx.user.companyId, from, to])
  const totalCost = byReason.reduce((s, r) => s + Number(r.cost), 0)
  return { ...res, period: { from, to }, byReason, topProducts, totals: { cost: r2(totalCost), revenue: Number(revenue.revenue), pctOfRevenue: Number(revenue.revenue) > 0 ? r2((totalCost / Number(revenue.revenue)) * 100) : null,
    pctOfCmv: Number(revenue.cmv) > 0 ? r2((totalCost / Number(revenue.cmv)) * 100) : null } }
})

// =====================================================================
// Balança
// =====================================================================
router.get('/api/scale/resolve', { perm: ['vendas.criar', 'produtos.ver'] }, async (ctx) => {
  const settings = await getSettings(db, ctx.user.companyId)
  const r = await resolveScale(db, ctx.user.companyId, String(ctx.query.code || ''), settings.balanca)
  if (!r) throw notFound('Produto da etiqueta de balança')
  return r
})

/** Etiquetas de balança para produtos pesados no estoque (embalados na loja): código com peso ou preço embutido. */
router.post('/api/scale/labels', { perm: 'produtos.ver' }, async (ctx) => {
  const b: any = parse(v.object({ items: v.array(v.object({ productId: v.uuid(), weightKg: v.number({ min: 0.001, max: 99.999 }), copies: v.int({ min: 1, max: 200 }).default(1),
    packedOn: v.date().optional() }), { min: 1, max: 100 }) }), ctx.body)
  const settings = await getSettings(db, ctx.user.companyId)
  const out: any[] = []
  for (const it of b.items) {
    const p = await db.one(`SELECT p.id, p.name, p.plu_code, p.shelf_life_days, p.unit, COALESCE(v.sale_price, p.sale_price) AS price FROM products p JOIN product_variants v ON v.product_id = p.id
                             WHERE p.id = $1 AND p.company_id = $2 ORDER BY v.created_at LIMIT 1`, [it.productId, ctx.user.companyId])
    if (!p) throw notFound('Produto')
    if (!p.plu_code) throw unprocessable(`${p.name}: cadastre o código de balança (PLU) no produto.`)
    const weight = r3(it.weightKg), total = r2(weight * Number(p.price))
    const packed = it.packedOn ?? (await db.one(`SELECT current_date::text AS d`)).d
    const expiry = p.shelf_life_days != null ? (await db.one(`SELECT ($1::date + $2::int)::text AS d`, [packed, p.shelf_life_days])).d : null
    const barcode = buildScaleBarcode(p.plu_code, settings.balanca.tipoValor === 'peso' ? weight : total, settings.balanca)
    out.push({ productId: p.id, name: p.name, plu: p.plu_code, pricePerKg: Number(p.price), weightKg: weight, total, packedOn: packed, expiryDate: expiry, barcode, copies: it.copies })
  }
  return out
})

// =====================================================================
// Embalagens (unidade/caixa)
// =====================================================================
router.get('/api/products/:id/packagings', { perm: 'produtos.ver' }, async (ctx) =>
  db.many(`SELECT pk.*, v.sku FROM product_packagings pk JOIN product_variants v ON v.id = pk.variant_id WHERE pk.product_id = $1 AND pk.company_id = $2 ORDER BY pk.units`, [ctx.params.id, ctx.user.companyId]))

const packSchema = { variantId: v.uuid(), name: v.string({ min: 2, max: 60 }), units: v.int({ min: 2, max: 1000 }), barcode: v.string({ max: 14 }).optional(), salePrice: v.money({ min: 0.01 }).optional(), active: v.boolean().optional() }
router.post('/api/products/:id/packagings', { perm: ['combos.editar', 'produtos.editar'] }, async (ctx) => {
  const b: any = parse(v.object(packSchema), ctx.body)
  const barcode = b.barcode ? onlyDigits(b.barcode) : null
  if (barcode && !isValidGTIN(barcode)) throw unprocessable('Código de barras da embalagem inválido (dígito verificador).')
  return tx(async (c) => {
    const vr = await c.one(`SELECT 1 FROM product_variants WHERE id = $1 AND product_id = $2 AND company_id = $3`, [b.variantId, ctx.params.id, ctx.user.companyId])
    if (!vr) throw notFound('Variação do produto')
    if (barcode && await c.one(`SELECT 1 FROM product_variants WHERE company_id = $1 AND barcode = $2`, [ctx.user.companyId, barcode])) throw conflict('Este código de barras já pertence a uma unidade de produto.')
    const r = await c.one(`INSERT INTO product_packagings(company_id, product_id, variant_id, name, units, barcode, sale_price, active) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true)) RETURNING *`,
      [ctx.user.companyId, ctx.params.id, b.variantId, b.name, b.units, barcode, b.salePrice ?? null, b.active ?? null])
    await audit(c, ctx, 'produto.embalagem_criada', 'product', ctx.params.id, { name: b.name, units: b.units, barcode })
    return r
  })
})
router.put('/api/packagings/:id', { perm: ['combos.editar', 'produtos.editar'] }, async (ctx) => {
  const b: any = parse(v.object({ name: v.string({ min: 2, max: 60 }).optional(), units: v.int({ min: 2, max: 1000 }).optional(), salePrice: v.money({ min: 0.01 }).nullable().optional(), active: v.boolean().optional() }), ctx.body)
  const r = await db.one(`UPDATE product_packagings SET name = COALESCE($3, name), units = COALESCE($4, units), sale_price = CASE WHEN $6 THEN $5 ELSE sale_price END, active = COALESCE($7, active)
                           WHERE id = $1 AND company_id = $2 RETURNING *`, [ctx.params.id, ctx.user.companyId, b.name ?? null, b.units ?? null, b.salePrice ?? null, 'salePrice' in ctx.body, b.active ?? null])
  if (!r) throw notFound('Embalagem')
  await audit(null, ctx, 'produto.embalagem_alterada', 'product', r.product_id, b)
  return r
})
router.delete('/api/packagings/:id', { perm: ['combos.editar', 'produtos.editar'] }, async (ctx) => {
  const used = await db.one(`SELECT 1 FROM sale_items WHERE packaging_id = $1 LIMIT 1`, [ctx.params.id])
  const r = used ? await db.one(`UPDATE product_packagings SET active = false WHERE id = $1 AND company_id = $2 RETURNING id, product_id`, [ctx.params.id, ctx.user.companyId])
    : await db.one(`DELETE FROM product_packagings WHERE id = $1 AND company_id = $2 RETURNING id, product_id`, [ctx.params.id, ctx.user.companyId])
  if (!r) throw notFound('Embalagem')
  await audit(null, ctx, used ? 'produto.embalagem_inativada' : 'produto.embalagem_excluida', 'product', r.product_id, null)
  return { ok: true, inactivated: !!used }
})

// =====================================================================
// Combos e kits
// =====================================================================
router.get('/api/combos', { perm: ['produtos.ver', 'vendas.criar'] }, async (ctx) => {
  const w = new Where([['c.company_id = ?', ctx.user.companyId]])
  if (ctx.query.q) w.add('(c.name ILIKE ? OR c.code ILIKE ? OR c.barcode = ?)', `%${ctx.query.q}%`, `%${ctx.query.q}%`, ctx.query.q)
  if (ctx.query.active) w.add('c.active = ?', ctx.query.active === 'true')
  return paged(db, `SELECT c.*,
      (SELECT json_agg(json_build_object('variantId', ci.variant_id, 'qty', ci.qty, 'sku', v.sku, 'name', p.name, 'price', COALESCE(v.sale_price, p.sale_price)) ORDER BY p.name)
         FROM combo_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id WHERE ci.combo_id = c.id) AS items,
      (SELECT COALESCE(sum(ci.qty * COALESCE(v.sale_price, p.sale_price)),0) FROM combo_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id WHERE ci.combo_id = c.id) AS regular_price,
      (SELECT count(DISTINCT si.sale_id)::int FROM sale_items si WHERE si.combo_id = c.id) AS sold
    FROM combos c ${w.sql} ORDER BY c.active DESC, c.name`, w.params, ctx.query, 50)
})

const comboSchema = { code: v.string({ min: 1, max: 30 }), name: v.string({ min: 2, max: 120 }), barcode: v.string({ max: 14 }).optional(), price: v.money({ min: 0.01 }),
  validUntil: v.date().optional(), active: v.boolean().optional(),
  items: v.array(v.object({ variantId: v.uuid(), qty: v.number({ min: 0.001, max: 1000 }) }), { min: 1, max: 30 }) }
async function saveCombo(c: any, ctx: any, b: any, id?: string) {
  const barcode = b.barcode ? onlyDigits(b.barcode) : null
  if (barcode && !isValidGTIN(barcode)) throw unprocessable('Código de barras do combo inválido (dígito verificador).')
  const ids = [...new Set(b.items.map((i: any) => i.variantId))]
  if (ids.length !== b.items.length) throw unprocessable('Um mesmo produto aparece duas vezes no combo.')
  const vs = await c.many(`SELECT v.id, v.sku, p.unit, p.sale_by_weight FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.company_id = $1 AND v.id = ANY($2::uuid[])`, [ctx.user.companyId, ids])
  if (vs.length !== ids.length) throw unprocessable('Produto do combo não encontrado.')
  const vmap = new Map(vs.map((x: any) => [x.id, x]))
  for (const it of b.items) checkQty(it.qty, vmap.get(it.variantId) as any)
  const row = id
    ? await c.one(`UPDATE combos SET code = $3, name = $4, barcode = $5, price = $6, valid_until = $7, active = COALESCE($8, active) WHERE id = $1 AND company_id = $2 RETURNING *`,
        [id, ctx.user.companyId, b.code, b.name, barcode, b.price, b.validUntil ?? null, b.active ?? null])
    : await c.one(`INSERT INTO combos(company_id, code, name, barcode, price, valid_until, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true),$8) RETURNING *`,
        [ctx.user.companyId, b.code, b.name, barcode, b.price, b.validUntil ?? null, b.active ?? null, ctx.user.id])
  if (!row) throw notFound('Combo')
  await c.query(`DELETE FROM combo_items WHERE combo_id = $1`, [row.id])
  for (const it of b.items) await c.query(`INSERT INTO combo_items(combo_id, variant_id, qty) VALUES ($1,$2,$3)`, [row.id, it.variantId, it.qty])
  return row
}
router.post('/api/combos', { perm: 'combos.editar' }, async (ctx) => {
  const b: any = parse(v.object(comboSchema), ctx.body)
  return tx(async (c) => { const r = await saveCombo(c, ctx, b); await audit(c, ctx, 'combo.criado', 'combo', r.id, b); return r })
})
router.put('/api/combos/:id', { perm: 'combos.editar' }, async (ctx) => {
  const b: any = parse(v.object(comboSchema), ctx.body)
  return tx(async (c) => { const r = await saveCombo(c, ctx, b, ctx.params.id); await audit(c, ctx, 'combo.alterado', 'combo', r.id, b); return r })
})
router.delete('/api/combos/:id', { perm: 'combos.editar' }, async (ctx) => {
  const r = await db.one(`UPDATE combos SET active = false WHERE id = $1 AND company_id = $2 RETURNING id`, [ctx.params.id, ctx.user.companyId])
  if (!r) throw notFound('Combo')
  await audit(null, ctx, 'combo.inativado', 'combo', r.id)
  return { ok: true }
})

/** PDV: embalagem ou combo pelo código lido. */
router.get('/api/pos/lookup', { perm: 'vendas.criar' }, async (ctx) => {
  const code = String(ctx.query.code || '').trim()
  if (!code) return null
  const hit = await findPackagingOrCombo(db, ctx.user.companyId, code)
  if (hit) return hit
  const settings = await getSettings(db, ctx.user.companyId)
  const sc = /^\d{13}$/.test(code) ? await resolveScale(db, ctx.user.companyId, code, settings.balanca) : null
  return sc ? { ...sc, kind: 'balanca' } : null
})

// =====================================================================
// Site institucional: contatos
// =====================================================================
router.post('/api/public/leads', { auth: 'none', maxBody: 20_000 }, async (ctx) => {
  rateLimit('lead:' + ctx.ip, 5, 60 * 60_000)
  const b: any = parse(v.object({ name: v.string({ min: 2, max: 120 }), email: v.email().optional(), phone: v.string({ min: 8, max: 20 }).optional(),
    companyName: v.string({ max: 150 }).optional(), segment: v.string({ max: 40 }).optional(), stores: v.string({ max: 20 }).optional(),
    message: v.string({ max: 2000 }).optional(), consent: v.boolean(), website: v.string({ max: 200 }).optional() }), ctx.body)
  if (b.website) return { ok: true } // campo-armadilha para robôs
  if (!b.email && !b.phone) throw unprocessable('Informe um e-mail ou um telefone para contato.')
  if (!b.consent) throw unprocessable('É preciso autorizar o contato para enviarmos a proposta.')
  await db.query(`INSERT INTO site_leads(name, email, phone, company_name, segment, stores, message, consent, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [b.name, b.email ?? null, b.phone ? onlyDigits(b.phone) : null, b.companyName ?? null, b.segment ?? null, b.stores ?? null, b.message ?? null, true, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 300)])
  return { ok: true }
})

router.get('/api/admin/leads', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.ver')
  const w = new Where()
  w.addIf(ctx.query.status, 'status = ?', ctx.query.status)
  return paged(db, `SELECT * FROM site_leads ${w.sql} ORDER BY created_at DESC`, w.params, ctx.query, 50)
})
router.put('/api/admin/leads/:id', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.propostas')
  const b: any = parse(v.object({ status: v.enum(['novo', 'em_contato', 'convertido', 'descartado'] as const), notes: v.string({ max: 2000 }).optional() }), ctx.body)
  const r = await db.one(`UPDATE site_leads SET status = $2, notes = COALESCE($3, notes), updated_at = now() WHERE id = $1 RETURNING *`, [ctx.params.id, b.status, b.notes ?? null])
  if (!r) throw notFound('Contato')
  await audit(null, ctx, 'site.contato_atualizado', 'site_lead', r.id, b)
  return r
})

// =====================================================================
// Preço por quantidade (atacarejo)
// =====================================================================
router.get('/api/products/:id/price-tiers', { perm: ['produtos.ver', 'vendas.criar'] }, async (ctx) =>
  db.many(`SELECT id, min_qty, unit_price FROM product_price_tiers WHERE product_id = $1 AND company_id = $2 ORDER BY min_qty`, [ctx.params.id, ctx.user.companyId]))

/** Substitui as faixas de preço do produto (lista completa). */
router.put('/api/products/:id/price-tiers', { perm: 'produtos.editar' }, async (ctx) => {
  const b: any = parse(v.object({ tiers: v.array(v.object({ minQty: v.number({ min: 1.001, max: 100000 }), unitPrice: v.money({ min: 0.01 }) }), { max: 10 }) }), ctx.body)
  return tx(async (c) => {
    const p = await c.one(`SELECT id, code, unit, sale_by_weight, sale_price FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!p) throw notFound('Produto')
    const tiers = [...b.tiers].sort((x: any, y: any) => x.minQty - y.minQty)
    const seen = new Set<number>()
    let last = Number(p.sale_price)
    for (const t of tiers) {
      checkQty(t.minQty, p, 'Quantidade mínima da faixa')
      if (seen.has(t.minQty)) throw unprocessable('Há duas faixas com a mesma quantidade mínima.')
      seen.add(t.minQty)
      if (last > 0 && t.unitPrice >= last) throw unprocessable(`A faixa a partir de ${t.minQty} deve ter preço menor que a faixa anterior (${last.toFixed(2)}).`)
      last = t.unitPrice
    }
    await c.query(`DELETE FROM product_price_tiers WHERE product_id = $1`, [p.id])
    for (const t of tiers) await c.query(`INSERT INTO product_price_tiers(company_id, product_id, min_qty, unit_price) VALUES ($1,$2,$3,$4)`, [ctx.user.companyId, p.id, t.minQty, t.unitPrice])
    await audit(c, ctx, 'produto.precos_quantidade', 'product', p.id, { code: p.code, tiers }, 'warning')
    return c.many(`SELECT id, min_qty, unit_price FROM product_price_tiers WHERE product_id = $1 ORDER BY min_qty`, [p.id])
  })
})
