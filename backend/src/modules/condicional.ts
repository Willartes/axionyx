import { router, audit, paged, Where, branchScope, r2, today, addDays } from '../core/http'
import { db, tx, nextNumber, Q } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, conflict } from '../core/errors'
import { moveStock } from '../services/stock'
import { createSale, actorOf } from '../services/sales'
import { getSettings } from '../services/settings'

const paymentSchema = v.object({ methodId: v.uuid(), amount: v.money({ min: 0.01 }), installments: v.int({ min: 1, max: 24 }).optional(), firstDueDate: v.date().optional(), storeCreditCode: v.string().optional() })

async function event(c: Q, table: 'conditional_events' | 'consignment_events', key: string, id: string, type: string, data: unknown, userId: string) {
  await c.query(`INSERT INTO ${table}(${key}, type, data, user_id) VALUES ($1,$2,$3,$4)`, [id, type, JSON.stringify(data ?? {}), userId])
}

// =====================================================================
// CONDICIONAL / BAG DELIVERY
// =====================================================================
router.get('/api/conditionals', { perm: 'condicional.ver' }, async (ctx) => {
  const q = ctx.query
  const branches = branchScope(ctx, q.branch)
  const w = new Where([['k.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('k.branch_id = ANY(?::uuid[])', branches)
  w.addIf(q.kind, 'k.kind = ?', q.kind).addIf(q.customer, 'k.customer_id = ?', q.customer)
  if (q.status === 'atrasado') w.add(`k.status = 'aberto' AND k.due_date < current_date`)
  else w.addIf(q.status, 'k.status = ?', q.status)
  if (q.q) w.add('(k.number::text = ? OR cu.name ILIKE ?)', q.q, `%${q.q}%`)
  return paged(db, `
    SELECT k.id, k.number, k.kind, k.status, k.due_date, k.created_at, k.closed_at, cu.name AS customer, cu.whatsapp, u.name AS responsible, s.name AS seller,
           (k.status = 'aberto' AND k.due_date < current_date) AS overdue,
           COALESCE(sum(i.qty_sent),0)::int AS sent, COALESCE(sum(i.qty_returned),0)::int AS returned, COALESCE(sum(i.qty_sold),0)::int AS sold,
           COALESCE(sum((i.qty_sent - i.qty_returned - i.qty_sold) * i.unit_price),0) AS open_value, COALESCE(sum(i.qty_sent * i.unit_price),0) AS sent_value
      FROM conditionals k JOIN customers cu ON cu.id = k.customer_id JOIN users u ON u.id = k.responsible_id LEFT JOIN users s ON s.id = k.seller_id
      LEFT JOIN conditional_items i ON i.conditional_id = k.id
      ${w.sql} GROUP BY k.id, cu.name, cu.whatsapp, u.name, s.name ORDER BY k.created_at DESC`, w.params, q)
})

router.get('/api/conditionals/:id', { perm: 'condicional.ver' }, async (ctx) => {
  const k = await db.one(`SELECT k.*, cu.name AS customer, cu.whatsapp, cu.phone, cu.address AS customer_address, u.name AS responsible, s.name AS seller, (k.status = 'aberto' AND k.due_date < current_date) AS overdue
                            FROM conditionals k JOIN customers cu ON cu.id = k.customer_id JOIN users u ON u.id = k.responsible_id LEFT JOIN users s ON s.id = k.seller_id
                           WHERE k.id = $1 AND k.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!k) throw notFound('Condicional')
  k.items = await db.many(`SELECT i.*, (i.qty_sent - i.qty_returned - i.qty_sold) AS pending, v.sku, v.barcode, p.name, sz.code AS size, co.name AS color
                             FROM conditional_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
                             LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id WHERE i.conditional_id = $1 ORDER BY p.name`, [k.id])
  k.events = await db.many(`SELECT e.*, u.name AS user_name FROM conditional_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.conditional_id = $1 ORDER BY e.id`, [k.id])
  k.sales = await db.many(`SELECT id, number, total, status, created_at FROM sales WHERE origin_type = 'conditional' AND origin_id = $1 ORDER BY created_at`, [k.id])
  return k
})

async function addConditionalItems(c: Q, ctx: any, k: any, items: { variantId: string; qty: number }[]) {
  const settings = await getSettings(c, ctx.user.companyId)
  for (const it of items) {
    const price = await c.one(`SELECT COALESCE(v.sale_price, p.sale_price) AS price FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND v.company_id = $2 AND v.active AND p.active`, [it.variantId, ctx.user.companyId])
    if (!price) throw unprocessable('Produto inválido ou inativo.')
    await c.query(`INSERT INTO conditional_items(conditional_id, variant_id, qty_sent, unit_price) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (conditional_id, variant_id) DO UPDATE SET qty_sent = conditional_items.qty_sent + EXCLUDED.qty_sent`, [k.id, it.variantId, it.qty, price.price])
    await moveStock(c, { companyId: ctx.user.companyId, branchId: k.branch_id, variantId: it.variantId, qty: -it.qty, type: 'condicional_saida', refType: 'conditional', refId: k.id, userId: ctx.user.id, notes: `${k.kind === 'bag_delivery' ? 'Bag' : 'Condicional'} nº ${k.number}` })
  }
  const total = await c.one(`SELECT COALESCE(sum(qty_sent),0)::int AS n FROM conditional_items WHERE conditional_id = $1`, [k.id])
  if (total.n > settings.condicional.maxPecas) throw unprocessable(`Limite de ${settings.condicional.maxPecas} peças por condicional/bag excedido.`)
}

router.post('/api/conditionals', { perm: 'condicional.editar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({
    kind: v.enum(['condicional', 'bag_delivery'] as const).default('condicional'), customerId: v.uuid(), responsibleId: v.uuid().optional(), sellerId: v.uuid().optional(),
    dueDate: v.date().optional(), notes: v.string({ max: 1000 }).optional(),
    delivery: v.object({ address: v.string({ max: 300 }).optional(), fee: v.money({ min: 0 }).optional(), carrier: v.string({ max: 80 }).optional(), scheduledAt: v.string({ max: 40 }).optional(), tracking: v.string({ max: 60 }).optional() }).optional(),
    items: v.array(v.object({ variantId: v.uuid(), qty: v.int({ min: 1, max: 50 }) }), { min: 1, max: 100 }),
  }), ctx.body)
  return tx(async (c) => {
    const s = await getSettings(c, ctx.user.companyId)
    const cust = await c.one(`SELECT id, active FROM customers WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL`, [b.customerId, ctx.user.companyId])
    if (!cust?.active) throw unprocessable('Cliente inválido ou inativo.')
    const overdue = await c.one(`SELECT count(*)::int AS n FROM conditionals WHERE customer_id = $1 AND status = 'aberto' AND due_date < current_date`, [b.customerId])
    if (overdue.n > 0) throw conflict('Cliente possui condicional em atraso. Regularize antes de liberar novas peças.')
    if (b.kind === 'bag_delivery' && !b.delivery?.address) throw unprocessable('Informe o endereço de entrega da bag.')
    const number = await nextNumber(c, ctx.user.companyId, 'condicional')
    const k = await c.one(`INSERT INTO conditionals(company_id, branch_id, number, kind, customer_id, responsible_id, seller_id, due_date, delivery, notes, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.user.companyId, ctx.user.branchId, number, b.kind, b.customerId, b.responsibleId ?? ctx.user.id, b.sellerId ?? ctx.user.id, b.dueDate ?? addDays(today(), s.condicional.prazoPadraoDias),
        JSON.stringify(b.delivery ?? {}), b.notes ?? null, ctx.user.id])
    await addConditionalItems(c, ctx, k, b.items)
    await event(c, 'conditional_events', 'conditional_id', k.id, 'criado', { items: b.items.length, dueDate: k.due_date }, ctx.user.id)
    await audit(c, ctx, `${b.kind}.criado`, 'conditional', k.id, { number, items: b.items.length })
    return k
  })
})

router.post('/api/conditionals/:id/items', { perm: 'condicional.editar' }, async (ctx) => {
  const b = parse(v.object({ items: v.array(v.object({ variantId: v.uuid(), qty: v.int({ min: 1, max: 50 }) }), { min: 1 }) }), ctx.body)
  return tx(async (c) => {
    const k = await c.one(`SELECT * FROM conditionals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!k) throw notFound('Condicional')
    if (k.status !== 'aberto') throw conflict('Condicional já finalizado.')
    await addConditionalItems(c, ctx, k, b.items)
    await event(c, 'conditional_events', 'conditional_id', k.id, 'itens_adicionados', { items: b.items }, ctx.user.id)
    return { ok: true }
  })
})

/**
 * Retorno (parcial ou total): peças devolvidas voltam ao estoque; peças compradas viram venda efetiva
 * (com pagamentos, contas a receber, comissão, cashback e documento fiscal), sem nova baixa de estoque.
 */
router.post('/api/conditionals/:id/return', { perm: 'condicional.editar', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({
    items: v.array(v.object({ variantId: v.uuid(), returned: v.int({ min: 0 }).default(0), sold: v.int({ min: 0 }).default(0), discount: v.money({ min: 0 }).optional() }), { min: 1 }),
    payments: v.array(paymentSchema).optional(), discountTotal: v.money({ min: 0 }).optional(), notes: v.string({ max: 500 }).optional(),
    discountAuthorization: v.object({ email: v.email(), password: v.string({ trim: false }) }).optional(), emitFiscal: v.boolean().optional(),
  }), ctx.body)
  return tx(async (c) => {
    const k = await c.one(`SELECT * FROM conditionals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!k) throw notFound('Condicional')
    if (k.status !== 'aberto') throw conflict('Condicional já finalizado.')
    const items = await c.many(`SELECT * FROM conditional_items WHERE conditional_id = $1 FOR UPDATE`, [k.id])
    const map = new Map(items.map((i) => [i.variant_id, i]))
    const sold: any[] = []
    for (const r of b.items) {
      const it = map.get(r.variantId)
      if (!it) throw unprocessable('Peça não pertence a este condicional.')
      const pending = it.qty_sent - it.qty_returned - it.qty_sold
      if (r.returned + r.sold > pending) throw unprocessable(`Quantidade informada excede o pendente (${pending}) para uma das peças.`)
      if (r.returned > 0) {
        await moveStock(c, { companyId: k.company_id, branchId: k.branch_id, variantId: r.variantId, qty: r.returned, type: 'condicional_retorno', refType: 'conditional', refId: k.id, userId: ctx.user.id, notes: `Retorno condicional nº ${k.number}` })
      }
      await c.query(`UPDATE conditional_items SET qty_returned = qty_returned + $2, qty_sold = qty_sold + $3 WHERE id = $1`, [it.id, r.returned, r.sold])
      if (r.sold > 0) sold.push({ variantId: r.variantId, qty: r.sold, discount: r.discount, unitPriceOverride: Number(it.unit_price) })
    }
    let sale: any = null
    if (sold.length) {
      if (!b.payments?.length) throw unprocessable('Informe o pagamento das peças compradas.')
      sale = await createSale(c, actorOf(ctx), {
        customerId: k.customer_id, sellerId: k.seller_id, items: sold, payments: b.payments, discountTotal: b.discountTotal, notes: b.notes ?? `Venda do ${k.kind === 'bag_delivery' ? 'Bag Delivery' : 'condicional'} nº ${k.number}`,
        channel: k.kind, originType: 'conditional', originId: k.id, skipStock: true, discountAuthorization: b.discountAuthorization, emitFiscal: b.emitFiscal,
      }, ctx)
      if (!k.sale_id) await c.query(`UPDATE conditionals SET sale_id = $2 WHERE id = $1`, [k.id, sale.id])
    }
    const rem = await c.one(`SELECT COALESCE(sum(qty_sent - qty_returned - qty_sold),0)::int AS n FROM conditional_items WHERE conditional_id = $1`, [k.id])
    const finished = rem.n === 0
    if (finished) await c.query(`UPDATE conditionals SET status = 'finalizado', closed_at = now() WHERE id = $1`, [k.id])
    await event(c, 'conditional_events', 'conditional_id', k.id, finished ? 'finalizado' : 'retorno_parcial', { items: b.items, saleId: sale?.id ?? null, saleNumber: sale?.number ?? null }, ctx.user.id)
    await audit(c, ctx, 'condicional.retorno', 'conditional', k.id, { number: k.number, sold: sold.length, finished })
    return { finished, pending: rem.n, sale }
  })
})

router.post('/api/conditionals/:id/extend', { perm: 'condicional.editar' }, async (ctx) => {
  const b = parse(v.object({ dueDate: v.date() }), ctx.body)
  return tx(async (c) => {
    const k = await c.one(`UPDATE conditionals SET due_date = $3 WHERE id = $1 AND company_id = $2 AND status = 'aberto' RETURNING *`, [ctx.params.id, ctx.user.companyId, b.dueDate])
    if (!k) throw conflict('Condicional não está aberto.')
    await event(c, 'conditional_events', 'conditional_id', k.id, 'prazo_prorrogado', b, ctx.user.id)
    return k
  })
})

router.post('/api/conditionals/:id/cancel', { perm: 'condicional.editar' }, async (ctx) => {
  const b = parse(v.object({ reason: v.string({ min: 3, max: 300 }) }), ctx.body)
  return tx(async (c) => {
    const k = await c.one(`SELECT * FROM conditionals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!k) throw notFound('Condicional')
    if (k.status !== 'aberto') throw conflict('Condicional já finalizado.')
    const items = await c.many(`SELECT * FROM conditional_items WHERE conditional_id = $1`, [k.id])
    if (items.some((i) => i.qty_sold > 0)) throw conflict('Já há peças vendidas neste condicional; registre o retorno das demais em vez de cancelar.')
    for (const it of items) {
      const pending = it.qty_sent - it.qty_returned
      if (pending > 0) await moveStock(c, { companyId: k.company_id, branchId: k.branch_id, variantId: it.variant_id, qty: pending, type: 'condicional_retorno', refType: 'conditional', refId: k.id, userId: ctx.user.id, notes: `Cancelamento condicional nº ${k.number}` })
      await c.query(`UPDATE conditional_items SET qty_returned = qty_sent WHERE id = $1`, [it.id])
    }
    await c.query(`UPDATE conditionals SET status = 'cancelado', closed_at = now() WHERE id = $1`, [k.id])
    await event(c, 'conditional_events', 'conditional_id', k.id, 'cancelado', b, ctx.user.id)
    await audit(c, ctx, 'condicional.cancelado', 'conditional', k.id, { number: k.number, reason: b.reason }, 'warning')
    return { ok: true }
  })
})

// =====================================================================
// CONSIGNAÇÃO
// =====================================================================
router.get('/api/consignments', { perm: 'consignacao.ver' }, async (ctx) => {
  const branches = branchScope(ctx, ctx.query.branch)
  const w = new Where([['k.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('k.branch_id = ANY(?::uuid[])', branches)
  w.addIf(ctx.query.status, 'k.status = ?', ctx.query.status)
  if (ctx.query.q) w.add('(k.number::text = ? OR cu.name ILIKE ?)', ctx.query.q, `%${ctx.query.q}%`)
  return paged(db, `
    SELECT k.*, cu.name AS partner, COALESCE(sum(i.qty_sent),0)::int AS sent, COALESCE(sum(i.qty_sold),0)::int AS sold, COALESCE(sum(i.qty_returned),0)::int AS returned,
           COALESCE(sum((i.qty_sent - i.qty_sold - i.qty_returned) * i.unit_price),0) AS open_value,
           (SELECT COALESCE(sum(net_amount),0) FROM consignment_settlements st WHERE st.consignment_id = k.id) AS settled_net
      FROM consignments k JOIN customers cu ON cu.id = k.partner_id LEFT JOIN consignment_items i ON i.consignment_id = k.id
      ${w.sql} GROUP BY k.id, cu.name ORDER BY k.created_at DESC`, w.params, ctx.query)
})

router.get('/api/consignments/:id', { perm: 'consignacao.ver' }, async (ctx) => {
  const k = await db.one(`SELECT k.*, cu.name AS partner, cu.whatsapp, cu.cpf_cnpj FROM consignments k JOIN customers cu ON cu.id = k.partner_id WHERE k.id = $1 AND k.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!k) throw notFound('Consignação')
  k.items = await db.many(`SELECT i.*, (i.qty_sent - i.qty_sold - i.qty_returned) AS pending, v.sku, v.barcode, p.name, sz.code AS size, co.name AS color FROM consignment_items i
                            JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
                           WHERE i.consignment_id = $1 ORDER BY p.name`, [k.id])
  k.settlements = await db.many(`SELECT st.*, s.number AS sale_number, u.name AS created_by_name FROM consignment_settlements st LEFT JOIN sales s ON s.id = st.sale_id LEFT JOIN users u ON u.id = st.created_by WHERE st.consignment_id = $1 ORDER BY st.number`, [k.id])
  k.events = await db.many(`SELECT e.*, u.name AS user_name FROM consignment_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.consignment_id = $1 ORDER BY e.id`, [k.id])
  return k
})

async function shipConsignment(c: Q, ctx: any, k: any, items: { variantId: string; qty: number }[]) {
  for (const it of items) {
    const price = await c.one(`SELECT COALESCE(v.sale_price, p.sale_price) AS price FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND v.company_id = $2 AND v.active`, [it.variantId, ctx.user.companyId])
    if (!price) throw unprocessable('Produto inválido.')
    await c.query(`INSERT INTO consignment_items(consignment_id, variant_id, qty_sent, unit_price) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (consignment_id, variant_id) DO UPDATE SET qty_sent = consignment_items.qty_sent + EXCLUDED.qty_sent`, [k.id, it.variantId, it.qty, price.price])
    await moveStock(c, { companyId: ctx.user.companyId, branchId: k.branch_id, variantId: it.variantId, qty: -it.qty, type: 'consignacao_saida', refType: 'consignment', refId: k.id, userId: ctx.user.id, notes: `Consignação nº ${k.number}` })
  }
}

router.post('/api/consignments', { perm: 'consignacao.editar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ partnerId: v.uuid(), dueDate: v.date().optional(), commissionPct: v.number({ min: 0, max: 90 }).default(0), notes: v.string({ max: 1000 }).optional(),
    items: v.array(v.object({ variantId: v.uuid(), qty: v.int({ min: 1 }) }), { min: 1, max: 500 }) }), ctx.body)
  return tx(async (c) => {
    const p = await c.one(`SELECT id, is_partner FROM customers WHERE id = $1 AND company_id = $2 AND active`, [b.partnerId, ctx.user.companyId])
    if (!p) throw unprocessable('Parceira inválida.')
    if (!p.is_partner) await c.query(`UPDATE customers SET is_partner = true WHERE id = $1`, [p.id])
    const number = await nextNumber(c, ctx.user.companyId, 'consignacao')
    const k = await c.one(`INSERT INTO consignments(company_id, branch_id, number, partner_id, due_date, commission_pct, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.user.companyId, ctx.user.branchId, number, b.partnerId, b.dueDate ?? null, b.commissionPct, b.notes ?? null, ctx.user.id])
    await shipConsignment(c, ctx, k, b.items)
    await event(c, 'consignment_events', 'consignment_id', k.id, 'remessa', { items: b.items }, ctx.user.id)
    await audit(c, ctx, 'consignacao.criada', 'consignment', k.id, { number, items: b.items.length })
    return k
  })
})

router.post('/api/consignments/:id/ship', { perm: 'consignacao.editar' }, async (ctx) => {
  const b = parse(v.object({ items: v.array(v.object({ variantId: v.uuid(), qty: v.int({ min: 1 }) }), { min: 1 }) }), ctx.body)
  return tx(async (c) => {
    const k = await c.one(`SELECT * FROM consignments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!k) throw notFound('Consignação')
    if (k.status !== 'aberto') throw conflict('Consignação encerrada.')
    await shipConsignment(c, ctx, k, b.items)
    await event(c, 'consignment_events', 'consignment_id', k.id, 'remessa', { items: b.items }, ctx.user.id)
    return { ok: true }
  })
})

/** Acerto: registra vendidos (gera venda/recebível líquido da comissão da parceira) e devolvidos (voltam ao estoque). */
router.post('/api/consignments/:id/settle', { perm: 'consignacao.editar', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({
    sold: v.array(v.object({ variantId: v.uuid(), qty: v.int({ min: 1 }) })).default([]),
    returned: v.array(v.object({ variantId: v.uuid(), qty: v.int({ min: 1 }) })).default([]),
    payments: v.array(paymentSchema).optional(), dueDate: v.date().optional(), close: v.boolean().optional(),
  }), ctx.body)
  if (!b.sold.length && !b.returned.length && !b.close) throw unprocessable('Informe peças vendidas e/ou devolvidas.')
  return tx(async (c) => {
    const k = await c.one(`SELECT * FROM consignments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!k) throw notFound('Consignação')
    if (k.status !== 'aberto') throw conflict('Consignação encerrada.')
    const items = await c.many(`SELECT * FROM consignment_items WHERE consignment_id = $1 FOR UPDATE`, [k.id])
    const map = new Map(items.map((i) => [i.variant_id, { ...i }]))
    const check = (variantId: string, qty: number) => {
      const it = map.get(variantId)
      if (!it) throw unprocessable('Peça não pertence a esta consignação.')
      const pending = it.qty_sent - it.qty_sold - it.qty_returned
      if (qty > pending) throw unprocessable(`Quantidade excede o pendente (${pending}).`)
      return it
    }
    let gross = 0
    for (const s of b.sold) { const it = check(s.variantId, s.qty); it.qty_sold += s.qty; gross += s.qty * Number(it.unit_price) }
    for (const r of b.returned) { const it = check(r.variantId, r.qty); it.qty_returned += r.qty }
    gross = r2(gross)
    const commission = r2(gross * Number(k.commission_pct) / 100)
    const net = r2(gross - commission)
    for (const r of b.returned) await moveStock(c, { companyId: k.company_id, branchId: k.branch_id, variantId: r.variantId, qty: r.qty, type: 'consignacao_retorno', refType: 'consignment', refId: k.id, userId: ctx.user.id, notes: `Devolução consignação nº ${k.number}` })
    for (const it of map.values()) await c.query(`UPDATE consignment_items SET qty_sold = $2, qty_returned = $3 WHERE id = $1`, [it.id, it.qty_sold, it.qty_returned])
    let sale: any = null
    if (b.sold.length) {
      sale = await createSale(c, actorOf(ctx), {
        customerId: k.partner_id, items: b.sold.map((s: any) => ({ variantId: s.variantId, qty: s.qty, unitPriceOverride: Number(map.get(s.variantId)!.unit_price) })),
        discountTotal: commission, payments: b.payments?.length ? b.payments : undefined, onAccount: b.payments?.length ? undefined : { dueDate: b.dueDate || addDays(today(), 7), description: `Acerto consignação nº ${k.number}` },
        channel: 'consignacao', originType: 'consignment', originId: k.id, skipStock: true, notes: `Acerto da consignação nº ${k.number} (comissão parceira ${k.commission_pct}%)`,
      }, ctx)
    }
    const n = (await c.one(`SELECT COALESCE(max(number),0) + 1 AS n FROM consignment_settlements WHERE consignment_id = $1`, [k.id])).n
    const st = await c.one(`INSERT INTO consignment_settlements(consignment_id, number, gross_amount, commission_amount, net_amount, items, returned, sale_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [k.id, n, gross, commission, net, JSON.stringify(b.sold), JSON.stringify(b.returned), sale?.id ?? null, ctx.user.id])
    const rem = await c.one(`SELECT COALESCE(sum(qty_sent - qty_sold - qty_returned),0)::int AS n FROM consignment_items WHERE consignment_id = $1`, [k.id])
    if (b.close) {
      if (rem.n > 0) throw unprocessable(`Ainda há ${rem.n} peça(s) com a parceira. Registre venda ou devolução de todas para encerrar.`)
      await c.query(`UPDATE consignments SET status = 'encerrado', closed_at = now() WHERE id = $1`, [k.id])
    }
    await event(c, 'consignment_events', 'consignment_id', k.id, 'acerto', { settlement: n, gross, commission, net, sold: b.sold.length, returned: b.returned.length }, ctx.user.id)
    await audit(c, ctx, 'consignacao.acerto', 'consignment', k.id, { number: k.number, settlement: n, gross, net })
    return { settlement: st, sale, pending: rem.n }
  })
})
