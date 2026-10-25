import { router, audit, paged, Where, branchScope, can } from '../core/http'
import { db, tx, nextNumber } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden } from '../core/errors'
import { moveStock } from '../services/stock'

/** Posição de estoque por variação com filtros de moda (tamanho, cor, marca, coleção). */
router.get('/api/stock', { perm: 'estoque.ver' }, async (ctx) => {
  const q = ctx.query
  const branches = branchScope(ctx, q.branch)
  const w = new Where([['v.company_id = ?', ctx.user.companyId]])
  w.addIf(q.brand, 'p.brand_id = ?', q.brand).addIf(q.collection, 'p.collection_id = ?', q.collection).addIf(q.category, 'p.category_id = ?', q.category)
    .addIf(q.size, 'sz.code = ?', q.size).addIf(q.color, 'v.color_id = ?', q.color).addIf(q.product, 'p.id = ?', q.product)
  if (q.q) w.add('(p.name ILIKE ? OR p.code ILIKE ? OR v.sku ILIKE ? OR v.barcode = ?)', `%${q.q}%`, `%${q.q}%`, `%${q.q}%`, q.q)
  const bp = w.p(branches.length ? branches : null)
  const showCost = can(ctx.user, 'produtos.custo')
  let sql = `
    SELECT v.id AS variant_id, v.sku, v.barcode, p.id AS product_id, p.code, p.name, sz.code AS size, sz.sort AS size_sort, co.name AS color, b.name AS brand, cl.name AS collection, ca.name AS category,
           COALESCE(sum(sb.qty),0)::float8 AS qty, COALESCE(v.min_stock, p.min_stock) AS min_stock, COALESCE(v.sale_price, p.sale_price) AS price
           ${showCost ? ', COALESCE(v.cost_price, p.cost_price) AS cost' : ''}
      FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
      LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN collections cl ON cl.id = p.collection_id LEFT JOIN categories ca ON ca.id = p.category_id
      LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND (${bp}::uuid[] IS NULL OR sb.branch_id = ANY(${bp}::uuid[]))
      ${w.sql} AND v.active AND p.track_stock
     GROUP BY v.id, p.id, sz.code, sz.sort, co.name, b.name, cl.name, ca.name`
  const filter = q.status === 'critico' ? 'WHERE x.qty <= 0' : q.status === 'baixo' ? 'WHERE x.qty > 0 AND x.qty <= x.min_stock' : q.status === 'abaixo_minimo' ? 'WHERE x.qty <= x.min_stock' : q.status === 'normal' ? 'WHERE x.qty > x.min_stock' : ''
  sql = `SELECT * FROM (${sql}) x ${filter} ORDER BY x.name, x.color NULLS FIRST, x.size_sort NULLS FIRST`
  const result = await paged(db, sql, w.params, q, 50)
  const totals = await db.one(`SELECT count(*)::int AS skus, COALESCE(sum(qty),0)::float8 AS pieces, COALESCE(sum(qty * price),0) AS value_sale
                                 ${showCost ? ', COALESCE(sum(qty * cost),0) AS value_cost' : ''},
                                 count(*) FILTER (WHERE qty <= 0)::int AS critical, count(*) FILTER (WHERE qty > 0 AND qty <= min_stock)::int AS low
                                 FROM (${sql}) t`, w.params)
  return { ...result, totals }
})

/** Grade tamanho × cor de um produto com saldos (visão típica de loja de moda). */
router.get('/api/stock/grid/:productId', { perm: 'estoque.ver' }, async (ctx) => {
  const branches = branchScope(ctx, ctx.query.branch)
  const rows = await db.many(
    `SELECT v.id, v.sku, sz.code AS size, sz.sort, co.name AS color, co.hex, COALESCE(sum(sb.qty),0)::float8 AS qty
       FROM product_variants v LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
       LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND ($3::uuid[] IS NULL OR sb.branch_id = ANY($3::uuid[]))
      WHERE v.product_id = $1 AND v.company_id = $2 AND v.active GROUP BY v.id, sz.code, sz.sort, co.name, co.hex ORDER BY co.name, sz.sort`,
    [ctx.params.productId, ctx.user.companyId, branches.length ? branches : null])
  const sizes = [...new Map(rows.map((r) => [r.size ?? '—', r.sort ?? 0])).entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0])
  const colors = [...new Set(rows.map((r) => r.color ?? '—'))]
  return { sizes, colors, cells: rows }
})

router.get('/api/stock/movements', { perm: 'estoque.ver' }, async (ctx) => {
  const q = ctx.query
  const branches = branchScope(ctx, q.branch)
  const w = new Where([['m.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('m.branch_id = ANY(?::uuid[])', branches)
  w.addIf(q.variant, 'm.variant_id = ?', q.variant).addIf(q.product, 'v.product_id = ?', q.product).addIf(q.type, 'm.type = ?', q.type)
    .addIf(q.from, 'm.created_at >= ?::date', q.from).addIf(q.to, "m.created_at < ?::date + interval '1 day'", q.to)
  if (q.q) w.add('(p.name ILIKE ? OR v.sku ILIKE ?)', `%${q.q}%`, `%${q.q}%`)
  return paged(db, `
    SELECT m.id, m.created_at, m.type, m.qty, m.balance_after, m.ref_type, m.ref_id, m.notes, v.sku, p.name, sz.code AS size, co.name AS color, br.name AS branch, u.name AS user_name
      FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
      LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id JOIN branches br ON br.id = m.branch_id LEFT JOIN users u ON u.id = m.user_id
      ${w.sql} ORDER BY m.id DESC`, w.params, q, 50)
})

/** Lançamento manual: entrada, saída ou ajuste (para quantidade absoluta). */
router.post('/api/stock/movements', { perm: 'estoque.movimentar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({
    type: v.enum(['entrada', 'saida', 'ajuste'] as const),
    reason: v.string({ min: 3, max: 200 }),
    items: v.array(v.object({ variantId: v.uuid(), qty: v.number({ min: 0, max: 1000000 }), unitCost: v.money({ min: 0 }).optional() }), { min: 1, max: 500 }),
  }), ctx.body)
  return tx(async (c) => {
    const results = []
    for (const it of b.items) {
      let delta = it.qty
      if (b.type === 'saida') delta = -it.qty
      if (b.type === 'ajuste') {
        const cur = await c.one(`SELECT qty FROM stock_balances WHERE branch_id = $1 AND variant_id = $2 FOR UPDATE`, [ctx.user.branchId, it.variantId])
        delta = Math.round((it.qty - Number(cur?.qty ?? 0)) * 1000) / 1000
      }
      if (delta === 0) continue
      const bal = await moveStock(c, { companyId: ctx.user.companyId, branchId: ctx.user.branchId, variantId: it.variantId, qty: delta, type: b.type, refType: 'manual', unitCost: it.unitCost, notes: b.reason, userId: ctx.user.id })
      results.push({ variantId: it.variantId, delta, balance: bal })
    }
    await audit(c, ctx, `estoque.${b.type}`, 'stock', null, { reason: b.reason, items: results }, b.type === 'ajuste' ? 'warning' : 'info')
    return { items: results }
  })
})

// ---------- Transferências entre filiais ----------
router.get('/api/transfers', { perm: 'estoque.ver' }, async (ctx) => {
  const w = new Where([['t.company_id = ?', ctx.user.companyId]])
  if (!ctx.user.allBranches) w.add('(t.from_branch_id = ANY(?::uuid[]) OR t.to_branch_id = ANY(?::uuid[]))', ctx.user.branchIds, ctx.user.branchIds)
  w.addIf(ctx.query.status, 't.status = ?', ctx.query.status)
  return paged(db, `SELECT t.*, fb.name AS from_branch, tb.name AS to_branch, u.name AS created_by_name,
                           (SELECT COALESCE(sum(qty),0)::float8 FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS pieces
                      FROM stock_transfers t JOIN branches fb ON fb.id = t.from_branch_id JOIN branches tb ON tb.id = t.to_branch_id LEFT JOIN users u ON u.id = t.created_by
                      ${w.sql} ORDER BY t.created_at DESC`, w.params, ctx.query)
})

router.get('/api/transfers/:id', { perm: 'estoque.ver' }, async (ctx) => {
  const t = await db.one(`SELECT t.*, fb.name AS from_branch, tb.name AS to_branch FROM stock_transfers t JOIN branches fb ON fb.id = t.from_branch_id JOIN branches tb ON tb.id = t.to_branch_id WHERE t.id = $1 AND t.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!t) throw notFound('Transferência')
  t.items = await db.many(`SELECT i.*, v.sku, v.barcode, p.name, sz.code AS size, co.name AS color FROM stock_transfer_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
                            LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id WHERE i.transfer_id = $1 ORDER BY p.name`, [t.id])
  return t
})

router.post('/api/transfers', { perm: 'estoque.transferir' }, async (ctx) => {
  const b = parse(v.object({ toBranchId: v.uuid(), notes: v.string({ max: 500 }).optional(), send: v.boolean().optional(),
    items: v.array(v.object({ variantId: v.uuid(), qty: v.number({ min: 0.001, max: 1000000 }) }), { min: 1, max: 1000 }) }), ctx.body)
  if (b.toBranchId === ctx.user.branchId) throw unprocessable('A filial de destino deve ser diferente da filial atual.')
  return tx(async (c) => {
    const dest = await c.one(`SELECT id FROM branches WHERE id = $1 AND company_id = $2 AND active`, [b.toBranchId, ctx.user.companyId])
    if (!dest) throw unprocessable('Filial de destino inválida.')
    const number = await nextNumber(c, ctx.user.companyId, 'transferencia')
    const t = await c.one(`INSERT INTO stock_transfers(company_id, number, from_branch_id, to_branch_id, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ctx.user.companyId, number, ctx.user.branchId, b.toBranchId, b.notes ?? null, ctx.user.id])
    const merged = new Map<string, number>()
    for (const it of b.items) merged.set(it.variantId, (merged.get(it.variantId) || 0) + it.qty)
    for (const [variantId, qty] of merged) await c.query(`INSERT INTO stock_transfer_items(transfer_id, variant_id, qty) VALUES ($1,$2,$3)`, [t.id, variantId, qty])
    await audit(c, ctx, 'transferencia.criada', 'transfer', t.id, { number, to: b.toBranchId, items: merged.size })
    if (b.send) return sendTransfer(c, ctx, t.id)
    return t
  })
})

async function sendTransfer(c: any, ctx: any, id: string) {
  const t = await c.one(`SELECT * FROM stock_transfers WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, ctx.user.companyId])
  if (!t) throw notFound('Transferência')
  if (t.status !== 'rascunho') throw conflict('Transferência já enviada ou finalizada.')
  if (t.from_branch_id !== ctx.user.branchId && !ctx.user.allBranches) throw forbidden('Somente a filial de origem pode enviar.')
  const items = await c.many(`SELECT * FROM stock_transfer_items WHERE transfer_id = $1`, [id])
  for (const it of items) await moveStock(c, { companyId: t.company_id, branchId: t.from_branch_id, variantId: it.variant_id, qty: -it.qty, type: 'transferencia_saida', refType: 'transfer', refId: id, userId: ctx.user.id, notes: `Transferência nº ${t.number}` })
  await audit(c, ctx, 'transferencia.enviada', 'transfer', id, { number: t.number })
  return c.one(`UPDATE stock_transfers SET status = 'enviada', sent_at = now(), sent_by = $2 WHERE id = $1 RETURNING *`, [id, ctx.user.id])
}

router.post('/api/transfers/:id/send', { perm: 'estoque.transferir' }, async (ctx) => tx((c) => sendTransfer(c, ctx, ctx.params.id)))

router.post('/api/transfers/:id/receive', { perm: 'estoque.transferir' }, async (ctx) => {
  const b = parse(v.object({ items: v.array(v.object({ variantId: v.uuid(), qtyReceived: v.number({ min: 0, max: 1000000 }) })).optional(), notes: v.string({ max: 500 }).optional() }), ctx.body)
  return tx(async (c) => {
    const t = await c.one(`SELECT * FROM stock_transfers WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!t) throw notFound('Transferência')
    if (t.status !== 'enviada') throw conflict('Somente transferências enviadas podem ser recebidas.')
    if (!ctx.user.allBranches && !ctx.user.branchIds.includes(t.to_branch_id)) throw forbidden('Somente a filial de destino pode receber.')
    const items = await c.many(`SELECT * FROM stock_transfer_items WHERE transfer_id = $1`, [t.id])
    const informed = new Map((b.items ?? []).map((i) => [i.variantId, i.qtyReceived]))
    const divergences: any[] = []
    for (const it of items) {
      const rec = informed.has(it.variant_id) ? informed.get(it.variant_id)! : it.qty
      if (rec > it.qty) throw unprocessable('Quantidade recebida maior que a enviada.')
      if (rec > 0) await moveStock(c, { companyId: t.company_id, branchId: t.to_branch_id, variantId: it.variant_id, qty: rec, type: 'transferencia_entrada', refType: 'transfer', refId: t.id, userId: ctx.user.id, notes: `Transferência nº ${t.number}` })
      if (rec < it.qty) {
        // diferença volta para a origem como pendência a apurar (registrada como entrada na origem)
        await moveStock(c, { companyId: t.company_id, branchId: t.from_branch_id, variantId: it.variant_id, qty: it.qty - rec, type: 'transferencia_entrada', refType: 'transfer', refId: t.id, userId: ctx.user.id, notes: `Divergência no recebimento da transferência nº ${t.number}` })
        divergences.push({ variantId: it.variant_id, sent: it.qty, received: rec })
      }
      await c.query(`UPDATE stock_transfer_items SET qty_received = $2 WHERE id = $1`, [it.id, rec])
    }
    await audit(c, ctx, 'transferencia.recebida', 'transfer', t.id, { number: t.number, divergences }, divergences.length ? 'warning' : 'info')
    return c.one(`UPDATE stock_transfers SET status = 'recebida', received_at = now(), received_by = $2, notes = COALESCE(notes,'') || $3 WHERE id = $1 RETURNING *`,
      [t.id, ctx.user.id, b.notes ? `\nRecebimento: ${b.notes}` : ''])
  })
})

router.post('/api/transfers/:id/cancel', { perm: 'estoque.transferir' }, async (ctx) => tx(async (c) => {
  const t = await c.one(`SELECT * FROM stock_transfers WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
  if (!t) throw notFound('Transferência')
  if (t.status === 'recebida' || t.status === 'cancelada') throw conflict('Transferência já finalizada.')
  if (t.status === 'enviada') {
    const items = await c.many(`SELECT * FROM stock_transfer_items WHERE transfer_id = $1`, [t.id])
    for (const it of items) await moveStock(c, { companyId: t.company_id, branchId: t.from_branch_id, variantId: it.variant_id, qty: it.qty, type: 'transferencia_entrada', refType: 'transfer', refId: t.id, userId: ctx.user.id, notes: `Cancelamento da transferência nº ${t.number}` })
  }
  await audit(c, ctx, 'transferencia.cancelada', 'transfer', t.id, { number: t.number }, 'warning')
  return c.one(`UPDATE stock_transfers SET status = 'cancelada' WHERE id = $1 RETURNING *`, [t.id])
}))

// ---------- Inventário ----------
router.get('/api/inventories', { perm: 'estoque.ver' }, async (ctx) => {
  const branches = branchScope(ctx, ctx.query.branch)
  const w = new Where([['i.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('i.branch_id = ANY(?::uuid[])', branches)
  return paged(db, `SELECT i.*, b.name AS branch, u.name AS created_by_name, (SELECT count(*)::int FROM inventory_items x WHERE x.inventory_id = i.id) AS counted_skus,
                           (SELECT COALESCE(sum(counted_qty),0)::float8 FROM inventory_items x WHERE x.inventory_id = i.id) AS counted_pieces
                      FROM inventories i JOIN branches b ON b.id = i.branch_id LEFT JOIN users u ON u.id = i.created_by ${w.sql} ORDER BY i.created_at DESC`, w.params, ctx.query)
})

router.post('/api/inventories', { perm: 'estoque.inventario' }, async (ctx) => {
  const b = parse(v.object({ description: v.string({ max: 200 }).optional(), scope: v.object({ brandId: v.uuid().optional(), categoryId: v.uuid().optional(), collectionId: v.uuid().optional() }).optional() }), ctx.body)
  return tx(async (c) => {
    const open = await c.one(`SELECT number FROM inventories WHERE branch_id = $1 AND status = 'aberto'`, [ctx.user.branchId])
    if (open) throw conflict(`Já existe o inventário nº ${open.number} aberto nesta filial.`)
    const number = await nextNumber(c, ctx.user.companyId, 'inventario')
    const r = await c.one(`INSERT INTO inventories(company_id, branch_id, number, description, scope, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ctx.user.companyId, ctx.user.branchId, number, b.description ?? null, JSON.stringify(b.scope ?? {}), ctx.user.id])
    await audit(c, ctx, 'inventario.aberto', 'inventory', r.id, { number })
    return r
  })
})

router.get('/api/inventories/:id', { perm: 'estoque.ver' }, async (ctx) => {
  const inv = await db.one(`SELECT i.*, b.name AS branch FROM inventories i JOIN branches b ON b.id = i.branch_id WHERE i.id = $1 AND i.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!inv) throw notFound('Inventário')
  inv.items = await db.many(
    `SELECT x.variant_id, x.counted_qty, COALESCE(x.expected_qty, sb.qty, 0) AS expected_qty, x.counted_at, v.sku, v.barcode, p.name, sz.code AS size, co.name AS color
       FROM inventory_items x JOIN product_variants v ON v.id = x.variant_id JOIN products p ON p.id = v.product_id
       LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id LEFT JOIN stock_balances sb ON sb.variant_id = x.variant_id AND sb.branch_id = $2
      WHERE x.inventory_id = $1 ORDER BY x.counted_at DESC`, [inv.id, inv.branch_id])
  return inv
})

/** Contagem: modo "somar" (bipagem) ou "definir" quantidade. */
router.post('/api/inventories/:id/count', { perm: 'estoque.inventario' }, async (ctx) => {
  const b = parse(v.object({ mode: v.enum(['somar', 'definir'] as const).default('somar'), items: v.array(v.object({ variantId: v.uuid().optional(), barcode: v.string().optional(), qty: v.number({ min: 0, max: 1000000 }) }), { min: 1, max: 2000 }) }), ctx.body)
  return tx(async (c) => {
    const inv = await c.one(`SELECT * FROM inventories WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!inv) throw notFound('Inventário')
    if (inv.status !== 'aberto') throw conflict('Inventário não está aberto.')
    const out = []
    for (const it of b.items) {
      let variantId = it.variantId
      if (!variantId && it.barcode) {
        const vv = await c.one(`SELECT id FROM product_variants WHERE company_id = $1 AND (barcode = $2 OR upper(sku) = upper($2))`, [ctx.user.companyId, it.barcode])
        if (!vv) throw unprocessable(`Código ${it.barcode} não encontrado.`)
        variantId = vv.id
      }
      if (!variantId) throw unprocessable('Informe a variação ou o código de barras.')
      const r = await c.one(
        `INSERT INTO inventory_items(inventory_id, variant_id, counted_qty) VALUES ($1,$2,$3)
         ON CONFLICT (inventory_id, variant_id) DO UPDATE SET counted_qty = ${b.mode === 'somar' ? 'inventory_items.counted_qty + EXCLUDED.counted_qty' : 'EXCLUDED.counted_qty'}, counted_at = now()
         RETURNING *`, [inv.id, variantId, it.qty])
      out.push(r)
    }
    return out
  })
})

/** Fecha o inventário gerando ajustes. Itens do escopo não contados podem ser zerados (opção). */
router.post('/api/inventories/:id/close', { perm: 'estoque.inventario' }, async (ctx) => {
  const b = parse(v.object({ zeroUncounted: v.boolean().default(false) }), ctx.body)
  return tx(async (c) => {
    const inv = await c.one(`SELECT * FROM inventories WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!inv) throw notFound('Inventário')
    if (inv.status !== 'aberto') throw conflict('Inventário não está aberto.')
    if (b.zeroUncounted) {
      const s = inv.scope || {}
      await c.query(
        `INSERT INTO inventory_items(inventory_id, variant_id, counted_qty)
         SELECT $1, sb.variant_id, 0 FROM stock_balances sb JOIN product_variants v ON v.id = sb.variant_id JOIN products p ON p.id = v.product_id
          WHERE sb.branch_id = $2 AND sb.qty <> 0 AND ($3::uuid IS NULL OR p.brand_id = $3) AND ($4::uuid IS NULL OR p.category_id = $4) AND ($5::uuid IS NULL OR p.collection_id = $5)
         ON CONFLICT DO NOTHING`, [inv.id, inv.branch_id, s.brandId ?? null, s.categoryId ?? null, s.collectionId ?? null])
    }
    const items = await c.many(`SELECT x.*, COALESCE(sb.qty,0) AS current FROM inventory_items x LEFT JOIN stock_balances sb ON sb.variant_id = x.variant_id AND sb.branch_id = $2 WHERE x.inventory_id = $1`, [inv.id, inv.branch_id])
    let adjusted = 0, plus = 0, minus = 0
    for (const it of items) {
      const delta = it.counted_qty - it.current
      await c.query(`UPDATE inventory_items SET expected_qty = $3 WHERE inventory_id = $1 AND variant_id = $2`, [inv.id, it.variant_id, it.current])
      if (delta === 0) continue
      await moveStock(c, { companyId: inv.company_id, branchId: inv.branch_id, variantId: it.variant_id, qty: delta, type: 'inventario', refType: 'inventory', refId: inv.id, userId: ctx.user.id, allowNegative: true, notes: `Inventário nº ${inv.number}` })
      adjusted++; if (delta > 0) plus += delta; else minus += -delta
    }
    await audit(c, ctx, 'inventario.fechado', 'inventory', inv.id, { number: inv.number, adjusted, plus, minus }, 'warning')
    return c.one(`UPDATE inventories SET status = 'fechado', closed_at = now(), closed_by = $2 WHERE id = $1 RETURNING *, $3::int AS adjusted, $4::int AS plus, $5::int AS minus`, [inv.id, ctx.user.id, adjusted, plus, minus])
  })
})

router.post('/api/inventories/:id/cancel', { perm: 'estoque.inventario' }, async (ctx) => {
  const r = await db.one(`UPDATE inventories SET status = 'cancelado', closed_at = now(), closed_by = $3 WHERE id = $1 AND company_id = $2 AND status = 'aberto' RETURNING *`, [ctx.params.id, ctx.user.companyId, ctx.user.id])
  if (!r) throw conflict('Inventário não está aberto.')
  await audit(null, ctx, 'inventario.cancelado', 'inventory', r.id, null, 'warning')
  return r
})

/** Curva ABC de produtos por faturamento no período. */
router.get('/api/stock/abc', { perm: 'estoque.ver' }, async (ctx) => {
  const days = Math.min(730, Math.max(7, parseInt(ctx.query.days || '90', 10)))
  const branches = branchScope(ctx, ctx.query.branch)
  const rows = await db.many(
    `WITH s AS (
       SELECT p.id, p.code, p.name, sum(si.total) AS revenue, sum(si.qty - si.returned_qty)::float8 AS qty
         FROM sale_items si JOIN sales sa ON sa.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
        WHERE sa.company_id = $1 AND sa.type = 'venda' AND sa.status <> 'cancelada' AND sa.created_at > now() - ($2 || ' days')::interval AND ($3::uuid[] IS NULL OR sa.branch_id = ANY($3::uuid[]))
        GROUP BY p.id)
     SELECT *, sum(revenue) OVER (ORDER BY revenue DESC ROWS UNBOUNDED PRECEDING) / NULLIF(sum(revenue) OVER (),0) * 100 AS cum_pct FROM s ORDER BY revenue DESC`,
    [ctx.user.companyId, String(days), branches.length ? branches : null])
  return rows.map((r) => ({ ...r, cum_pct: Number(r.cum_pct), class: Number(r.cum_pct) <= 80 ? 'A' : Number(r.cum_pct) <= 95 ? 'B' : 'C' }))
})

/** Indicadores do dashboard de estoque (todos calculados dos saldos e movimentações). */
router.get('/api/stock/dashboard', { perm: 'estoque.ver' }, async (ctx) => {
  const branches = branchScope(ctx, ctx.query.branch || (ctx.user.allBranches ? 'all' : 'current'))
  const bp = branches.length ? branches : null
  const id = ctx.user.companyId
  const showCost = can(ctx.user, 'produtos.custo')
  const [k, mov, critical, heat, inv] = await Promise.all([
    db.one(`WITH st AS (SELECT v.id, COALESCE(sum(sb.qty),0)::float8 AS qty, COALESCE(v.min_stock, p.min_stock) AS min, COALESCE(v.cost_price, p.cost_price) AS cost, COALESCE(v.sale_price, p.sale_price) AS price
                          FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND ($2::uuid[] IS NULL OR sb.branch_id = ANY($2::uuid[]))
                         WHERE v.company_id = $1 AND v.active AND p.active AND p.track_stock GROUP BY v.id, p.min_stock, p.cost_price, p.sale_price),
                 sold AS (SELECT COALESCE(sum(si.qty - si.returned_qty),0)::numeric AS q FROM sale_items si JOIN sales s ON s.id = si.sale_id
                           WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.type = 'venda' AND s.created_at > now() - interval '30 days' AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[]))),
                 nomove AS (SELECT count(*)::int AS n FROM st WHERE st.qty > 0 AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.variant_id = st.id AND m.qty < 0 AND m.created_at > now() - interval '30 days'))
            SELECT (SELECT COALESCE(sum(qty * cost),0) FROM st) AS value_cost, (SELECT COALESCE(sum(qty * price),0) FROM st) AS value_sale, (SELECT COALESCE(sum(qty),0)::float8 FROM st) AS pieces,
                   (SELECT count(*)::int FROM st) AS skus, (SELECT n FROM nomove) AS no_turnover, (SELECT count(*)::int FROM st WHERE qty <= min AND min > 0) AS critical,
                   (SELECT count(*)::int FROM st WHERE qty <= 0) AS zero, (SELECT q FROM sold) AS sold_30d`, [id, bp]),
    db.many(`SELECT to_char(m, 'YYYY-MM') AS month,
                    COALESCE((SELECT sum(qty) FROM stock_movements x WHERE x.company_id = $1 AND x.qty > 0 AND x.type IN ('compra','entrada','devolucao','transferencia_entrada','condicional_retorno','consignacao_retorno','cancelamento_venda') AND date_trunc('month', x.created_at) = m AND ($2::uuid[] IS NULL OR x.branch_id = ANY($2::uuid[]))),0)::int AS inflow,
                    COALESCE((SELECT -sum(qty) FROM stock_movements x WHERE x.company_id = $1 AND x.qty < 0 AND date_trunc('month', x.created_at) = m AND ($2::uuid[] IS NULL OR x.branch_id = ANY($2::uuid[]))),0)::int AS outflow
               FROM generate_series(date_trunc('month', now()) - interval '6 months', date_trunc('month', now()), interval '1 month') m ORDER BY m`, [id, bp]),
    db.many(`SELECT p.name, sz.code AS size, co.name AS color, COALESCE(sum(sb.qty),0)::float8 AS qty, COALESCE(v.min_stock, p.min_stock) AS min
               FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
               LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND ($2::uuid[] IS NULL OR sb.branch_id = ANY($2::uuid[]))
              WHERE v.company_id = $1 AND v.active AND p.active AND p.track_stock GROUP BY v.id, p.name, sz.code, co.name, p.min_stock
             HAVING COALESCE(sum(sb.qty),0) <= COALESCE(v.min_stock, p.min_stock) AND COALESCE(v.min_stock, p.min_stock) > 0 ORDER BY 4, 1 LIMIT 6`, [id, bp]),
    db.many(`WITH top AS (SELECT p.id, p.name FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                           WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.created_at > now() - interval '7 months' AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[])) GROUP BY p.id, p.name ORDER BY sum(si.qty) DESC LIMIT 6)
             SELECT top.name, to_char(m, 'YYYY-MM') AS month, COALESCE((SELECT sum(si.qty) FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id
                     WHERE v.product_id = top.id AND s.status <> 'cancelada' AND date_trunc('month', s.created_at) = m AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[]))),0)::int AS qty
               FROM top CROSS JOIN generate_series(date_trunc('month', now()) - interval '6 months', date_trunc('month', now()), interval '1 month') m ORDER BY top.name, m`, [id, bp]),
    db.one(`SELECT count(*) FILTER (WHERE status = 'aberto')::int AS open, max(closed_at) AS last_closed FROM inventories WHERE company_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[]))`, [id, bp]),
  ])
  const daily = Number(k.sold_30d) / 30
  return {
    kpis: { ...k, value_cost: showCost ? Number(k.value_cost) : null, coverage_days: daily > 0 ? Math.round(k.pieces / daily) : null, turnover_ratio: k.pieces > 0 ? Math.round((Number(k.sold_30d) / k.pieces) * 100) / 100 : null, inventories_open: inv.open, last_inventory: inv.last_closed },
    movements: mov, critical, heatmap: heat,
  }
})
