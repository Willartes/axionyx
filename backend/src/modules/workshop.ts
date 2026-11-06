import { router, audit, paged, Where, can, Ctx, r2, today, addDays } from '../core/http'
import { db, tx, nextNumber, Q } from '../core/db'
import { v, parse, onlyDigits } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden } from '../core/errors'
import { getSettings } from '../services/settings'
import { checkQty } from '../services/retail'
import { createVariants } from './produtos'
import { WoStatus, WO_LABEL, canMove, EDITABLE, woEvent, woTotals, deliverWorkOrder } from '../services/workshop'

/**
 * Oficina mecânica (carro e moto): veículos, ordens de serviço, orçamento com aprovação, mão de obra por serviço ou por hora,
 * peças e produtos do estoque, cobrança no PDV (itens da OS viram itens da venda), garantia e lembretes de revisão.
 */
const PLATE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/
const normPlate = (p?: string | null) => (p ? p.toUpperCase().replace(/[^A-Z0-9]/g, '') : null)
const CHECK_STATES = ['ok', 'avaria', 'ausente', 'na'] as const

async function getWo(c: Q, ctx: Ctx, id: string, lock = false) {
  const wo = await c.one(`SELECT * FROM work_orders WHERE id = $1 AND company_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, ctx.user.companyId])
  if (!wo) throw notFound('Ordem de serviço')
  return wo
}
function editable(wo: any) { if (!EDITABLE.includes(wo.status)) throw unprocessable(`OS ${WO_LABEL[wo.status as WoStatus].toLowerCase()} não pode ser alterada.`) }

/** Produto "Mão de obra (hora)" usado nas linhas de mão de obra por tempo (criado na primeira vez). */
async function laborProduct(c: Q, companyId: string, userId: string, rate: number) {
  let p = await c.one(`SELECT p.id, v.id AS variant_id FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.company_id = $1 AND p.code = 'MO-HORA' LIMIT 1`, [companyId])
  if (p) return p
  const cat = await c.one(`SELECT id FROM categories WHERE company_id = $1 AND name = 'Serviços — revisão e manutenção'`, [companyId])
  const prod = await c.one(`INSERT INTO products(company_id, created_by, kind, code, name, description, category_id, sale_price, cost_price, active, track_stock, unit, cfop)
                            VALUES ($1,$2,'servico','MO-HORA','Mão de obra (hora)','Hora de mão de obra da oficina — quantidade em horas (ex.: 1,5)',$3,$4,0,true,false,'H','5933') RETURNING *`,
    [companyId, userId, cat?.id ?? null, rate])
  const [variant] = await createVariants(c, companyId, prod, [{ size_id: null, color_id: null }])
  return { id: prod.id, variant_id: variant.id }
}

// =====================================================================  Veículos
router.get('/api/vehicles', { perm: 'oficina.ver' }, async (ctx) => {
  const w = new Where([['v.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.customer, 'v.customer_id = ?', ctx.query.customer)
  if (ctx.query.q) { const q = ctx.query.q.trim(); w.add(`(upper(v.plate) LIKE ? OR v.model ILIKE ? OR v.brand ILIKE ? OR cu.name ILIKE ?)`, `%${normPlate(q)}%`, `%${q}%`, `%${q}%`, `%${q}%`) }
  if (ctx.query.active !== 'all') w.add('v.active')
  return paged(db, `SELECT v.*, cu.name AS customer_name, cu.whatsapp, cu.phone,
                           (SELECT count(*)::int FROM work_orders w WHERE w.vehicle_id = v.id AND w.status <> 'cancelada') AS orders,
                           (SELECT max(created_at) FROM work_orders w WHERE w.vehicle_id = v.id) AS last_visit,
                           (SELECT count(*)::int FROM vehicle_reminders r WHERE r.vehicle_id = v.id AND r.status = 'aberto' AND r.due_date <= current_date + 15) AS reminders_due
                      FROM vehicles v LEFT JOIN customers cu ON cu.id = v.customer_id ${w.sql} ORDER BY v.updated_at DESC`, w.params, ctx.query, 50)
})

router.get('/api/vehicles/:id', { perm: 'oficina.ver' }, async (ctx) => {
  const v0 = await db.one(`SELECT v.*, cu.name AS customer_name, cu.whatsapp, cu.phone, cu.email FROM vehicles v LEFT JOIN customers cu ON cu.id = v.customer_id WHERE v.id = $1 AND v.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!v0) throw notFound('Veículo')
  const orders = await db.many(`SELECT w.id, w.number, w.status, w.km_in, w.complaint, w.created_at, w.delivered_at, w.warranty_until,
                                       (SELECT COALESCE(sum(total),0)::float8 FROM work_order_items i WHERE i.work_order_id = w.id AND i.status = 'aprovado') AS total,
                                       (SELECT string_agg(i.description, ' · ' ORDER BY i.sort) FROM work_order_items i WHERE i.work_order_id = w.id AND i.status = 'aprovado') AS items
                                  FROM work_orders w WHERE w.vehicle_id = $1 ORDER BY w.created_at DESC`, [v0.id])
  const reminders = await db.many(`SELECT r.*, w.number AS work_order_number FROM vehicle_reminders r LEFT JOIN work_orders w ON w.id = r.work_order_id WHERE r.vehicle_id = $1 ORDER BY r.status, r.due_date NULLS LAST`, [v0.id])
  return { ...v0, orders, reminders }
})

const vehicleSchema = {
  customerId: v.uuid().optional(), type: v.enum(['carro', 'moto', 'utilitario', 'caminhao', 'outro'] as const).default('carro'), plate: v.string({ max: 10 }).optional(),
  brand: v.string({ max: 40 }).optional(), model: v.string({ min: 1, max: 60 }), version: v.string({ max: 60 }).optional(), yearFab: v.int({ min: 1900, max: 2100 }).optional(),
  yearModel: v.int({ min: 1900, max: 2100 }).optional(), color: v.string({ max: 30 }).optional(), fuel: v.string({ max: 30 }).optional(), engine: v.string({ max: 30 }).optional(),
  vin: v.string({ max: 20 }).optional(), kmCurrent: v.int({ min: 0, max: 5000000 }).optional(), notes: v.string({ max: 1000 }).optional(),
}
async function saveVehicle(c: Q, ctx: Ctx, b: any, id?: string) {
  const plate = normPlate(b.plate)
  if (plate && !PLATE.test(plate)) throw unprocessable('Placa inválida: use o padrão antigo (ABC1234) ou Mercosul (ABC1D23).')
  if (b.customerId && !(await c.one(`SELECT 1 FROM customers WHERE id = $1 AND company_id = $2`, [b.customerId, ctx.user.companyId]))) throw unprocessable('Cliente inválido.')
  if (plate) {
    const dup = await c.one(`SELECT id FROM vehicles WHERE company_id = $1 AND upper(plate) = $2 AND id <> COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000')`, [ctx.user.companyId, plate, id ?? null])
    if (dup) throw conflict(`A placa ${plate} já está cadastrada.`, { vehicleId: dup.id })
  }
  const vals = [b.customerId ?? null, b.type ?? 'carro', plate, b.brand ?? null, b.model, b.version ?? null, b.yearFab ?? null, b.yearModel ?? null, b.color ?? null, b.fuel ?? null, b.engine ?? null,
    b.vin ? b.vin.toUpperCase() : null, b.kmCurrent ?? null, b.notes ?? null]
  if (id) return c.one(`UPDATE vehicles SET customer_id = $3, type = $4, plate = $5, brand = $6, model = $7, version = $8, year_fab = $9, year_model = $10, color = $11, fuel = $12, engine = $13, vin = $14,
                         km_current = $15, notes = $16, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`, [id, ctx.user.companyId, ...vals])
  return c.one(`INSERT INTO vehicles(company_id, customer_id, type, plate, brand, model, version, year_fab, year_model, color, fuel, engine, vin, km_current, notes)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [ctx.user.companyId, ...vals])
}
router.post('/api/vehicles', { perm: 'oficina.editar' }, async (ctx) => {
  const b = parse(v.object(vehicleSchema), ctx.body)
  return tx(async (c) => { const r = await saveVehicle(c, ctx, b); await audit(c, ctx, 'oficina.veiculo_criado', 'vehicle', r.id, { plate: r.plate, model: r.model }); return r })
})
router.put('/api/vehicles/:id', { perm: 'oficina.editar' }, async (ctx) => {
  const b = parse(v.object({ ...vehicleSchema, active: v.boolean().optional() }), ctx.body)
  return tx(async (c) => {
    const r = await saveVehicle(c, ctx, b, ctx.params.id)
    if (!r) throw notFound('Veículo')
    if (b.active !== undefined) await c.query(`UPDATE vehicles SET active = $2 WHERE id = $1`, [r.id, b.active])
    await audit(c, ctx, 'oficina.veiculo_alterado', 'vehicle', r.id, b)
    return r
  })
})

// =====================================================================  Ordens de serviço
router.get('/api/work-orders', { perm: 'oficina.ver' }, async (ctx) => {
  const w = new Where([['w.company_id = ?', ctx.user.companyId]])
  if (ctx.query.status === 'abertas') w.add(`w.status NOT IN ('entregue','cancelada')`)
  else w.addIf(ctx.query.status, 'w.status = ?', ctx.query.status)
  w.addIf(ctx.query.professional, 'w.professional_id = ?', ctx.query.professional)
  w.addIf(ctx.query.vehicle, 'w.vehicle_id = ?', ctx.query.vehicle)
  if (ctx.query.q) {
    const q = ctx.query.q.trim()
    if (/^\d+$/.test(q)) w.add(`(w.number = ? OR upper(ve.plate) LIKE ?)`, Number(q), `%${q}%`)
    else w.add(`(upper(ve.plate) LIKE ? OR ve.model ILIKE ? OR cu.name ILIKE ?)`, `%${normPlate(q)}%`, `%${q}%`, `%${q}%`)
  }
  const res = await paged(db, `SELECT w.id, w.number, w.status, w.km_in, w.complaint, w.promised_at, w.created_at, w.delivered_at, w.sale_id, w.professional_id,
                                      ve.plate, ve.brand, ve.model, ve.type AS vehicle_type, cu.name AS customer_name, cu.whatsapp, pr.name AS professional,
                                      (SELECT COALESCE(sum(total) FILTER (WHERE status <> 'recusado'),0)::float8 FROM work_order_items i WHERE i.work_order_id = w.id) AS total,
                                      (SELECT count(*)::int FROM work_order_items i WHERE i.work_order_id = w.id AND i.status = 'pendente') AS pending_items,
                                      (SELECT count(*)::int FROM work_order_items i WHERE i.work_order_id = w.id AND i.status = 'aprovado' AND i.sale_item_id IS NULL) AS unbilled_items,
                                      (w.promised_at IS NOT NULL AND w.promised_at < now() AND w.status NOT IN ('pronta','entregue','cancelada')) AS late
                                 FROM work_orders w JOIN vehicles ve ON ve.id = w.vehicle_id JOIN customers cu ON cu.id = w.customer_id LEFT JOIN professionals pr ON pr.id = w.professional_id
                                ${w.sql} ORDER BY CASE w.status WHEN 'entregue' THEN 2 WHEN 'cancelada' THEN 3 ELSE 1 END, w.promised_at NULLS LAST, w.created_at DESC`, w.params, ctx.query, 100)
  const counts = await db.many(`SELECT status, count(*)::int AS n FROM work_orders WHERE company_id = $1 AND (status NOT IN ('entregue','cancelada') OR created_at > now() - interval '30 days') GROUP BY status`, [ctx.user.companyId])
  return { ...res, counts: Object.fromEntries(counts.map((x) => [x.status, x.n])) }
})

async function detail(id: string, companyId: string, q: Q = db) {
  const wo = await q.one(`SELECT w.*, ve.plate, ve.brand, ve.model, ve.version, ve.type AS vehicle_type, ve.year_model, ve.color, ve.km_current, ve.fuel AS vehicle_fuel,
                                  cu.name AS customer_name, cu.cpf_cnpj, cu.whatsapp, cu.phone, cu.email, pr.name AS professional, u.name AS created_by_name, s.number AS sale_number
                             FROM work_orders w JOIN vehicles ve ON ve.id = w.vehicle_id JOIN customers cu ON cu.id = w.customer_id LEFT JOIN professionals pr ON pr.id = w.professional_id
                             LEFT JOIN users u ON u.id = w.created_by LEFT JOIN sales s ON s.id = w.sale_id WHERE w.id = $1 AND w.company_id = $2`, [id, companyId])
  if (!wo) throw notFound('Ordem de serviço')
  const [items, events, history, totals] = await Promise.all([
    q.many(`SELECT i.*, p.code, p.unit, p.track_stock, pr.name AS professional,
                    (SELECT COALESCE(sum(sb.qty),0)::float8 FROM stock_balances sb WHERE sb.variant_id = i.variant_id AND sb.branch_id = $2) AS stock
               FROM work_order_items i JOIN products p ON p.id = i.product_id LEFT JOIN professionals pr ON pr.id = i.professional_id WHERE i.work_order_id = $1 ORDER BY i.sort, i.created_at`, [id, wo.branch_id]),
    q.many(`SELECT e.*, u.name AS user_name FROM work_order_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.work_order_id = $1 ORDER BY e.id DESC`, [id]),
    q.many(`SELECT w.id, w.number, w.status, w.km_in, w.created_at, w.warranty_until,
                    (SELECT string_agg(i.description, ' · ' ORDER BY i.sort) FROM work_order_items i WHERE i.work_order_id = w.id AND i.status = 'aprovado') AS items
               FROM work_orders w WHERE w.vehicle_id = $1 AND w.id <> $2 AND w.status <> 'cancelada' ORDER BY w.created_at DESC LIMIT 10`, [wo.vehicle_id, id]),
    woTotals(q, id),
  ])
  // garantia vigente de OS anterior do mesmo veículo (retorno em garantia)
  const warranty = await q.one(`SELECT number, warranty_until FROM work_orders WHERE vehicle_id = $1 AND id <> $2 AND status = 'entregue' AND warranty_until >= current_date ORDER BY delivered_at DESC LIMIT 1`, [wo.vehicle_id, id])
  return { ...wo, items, events, history, totals, warrantyActive: warranty, statusLabel: WO_LABEL[wo.status as WoStatus] }
}
router.get('/api/work-orders/:id', { perm: 'oficina.ver' }, async (ctx) => detail(ctx.params.id, ctx.user.companyId))

const checklistSchema = v.array(v.object({ item: v.string({ min: 1, max: 60 }), state: v.enum(CHECK_STATES).default('ok'), note: v.string({ max: 200 }).optional() }), { max: 60 })

router.post('/api/work-orders', { perm: 'oficina.editar', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({
    customerId: v.uuid(), vehicleId: v.uuid().optional(), vehicle: v.object(vehicleSchema).optional(), kmIn: v.int({ min: 0, max: 5000000 }).optional(),
    fuelLevel: v.enum(['reserva', '1/4', '1/2', '3/4', 'cheio'] as const).optional(), complaint: v.string({ max: 2000 }).optional(), checklist: checklistSchema.default([]),
    professionalId: v.uuid().optional(), promisedAt: v.string({ max: 30 }).optional(), notesCustomer: v.string({ max: 2000 }).optional(),
  }), ctx.body)
  if (!b.vehicleId && !b.vehicle) throw unprocessable('Selecione ou cadastre o veículo.')
  return tx(async (c) => {
    const cu = await c.one(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [b.customerId, ctx.user.companyId])
    if (!cu) throw unprocessable('Cliente inválido.')
    let vehicle = b.vehicleId ? await c.one(`SELECT * FROM vehicles WHERE id = $1 AND company_id = $2`, [b.vehicleId, ctx.user.companyId]) : null
    if (b.vehicleId && !vehicle) throw unprocessable('Veículo inválido.')
    if (!vehicle) vehicle = await saveVehicle(c, ctx, { ...b.vehicle, customerId: b.vehicle.customerId ?? b.customerId })
    if (!vehicle.customer_id) await c.query(`UPDATE vehicles SET customer_id = $2 WHERE id = $1`, [vehicle.id, b.customerId])
    if (b.kmIn !== undefined && vehicle.km_current && b.kmIn < vehicle.km_current) throw unprocessable(`Quilometragem menor que a última registrada (${vehicle.km_current.toLocaleString('pt-BR')} km). Confira o hodômetro.`)
    if (b.professionalId && !(await c.one(`SELECT 1 FROM professionals WHERE id = $1 AND company_id = $2 AND active`, [b.professionalId, ctx.user.companyId]))) throw unprocessable('Mecânico inválido.')
    const st = await getSettings(c, ctx.user.companyId)
    const number = await nextNumber(c, ctx.user.companyId, 'ordem_servico')
    const wo = await c.one(`INSERT INTO work_orders(company_id, branch_id, number, customer_id, vehicle_id, km_in, fuel_level, complaint, checklist, professional_id, labor_rate, promised_at, warranty_days, notes_customer, created_by)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [ctx.user.companyId, ctx.user.branchId, number, b.customerId, vehicle.id, b.kmIn ?? null, b.fuelLevel ?? null, b.complaint ?? null, JSON.stringify(b.checklist), b.professionalId ?? null,
        st.oficina.valorHora, b.promisedAt || null, st.oficina.garantiaDias, b.notesCustomer ?? null, ctx.user.id])
    if (b.kmIn !== undefined) await c.query(`UPDATE vehicles SET km_current = GREATEST(COALESCE(km_current,0), $2), updated_at = now() WHERE id = $1`, [vehicle.id, b.kmIn])
    await woEvent(c, wo.id, null, 'orcamento', `OS aberta${b.kmIn !== undefined ? ` com ${b.kmIn.toLocaleString('pt-BR')} km` : ''}`, ctx.user.id)
    await audit(c, ctx, 'oficina.os_aberta', 'work_order', wo.id, { number, plate: vehicle.plate })
    return wo
  })
})

router.put('/api/work-orders/:id', { perm: 'oficina.editar' }, async (ctx) => {
  const b: any = parse(v.object({ complaint: v.string({ max: 2000 }).optional(), diagnosis: v.string({ max: 4000 }).optional(), checklist: checklistSchema.optional(),
    kmIn: v.int({ min: 0, max: 5000000 }).optional(), fuelLevel: v.enum(['reserva', '1/4', '1/2', '3/4', 'cheio'] as const).optional(), professionalId: v.uuid().nullable().optional(),
    promisedAt: v.string({ max: 30 }).nullable().optional(), warrantyDays: v.int({ min: 0, max: 3650 }).optional(), laborRate: v.money({ min: 0, max: 100000 }).optional(),
    notesCustomer: v.string({ max: 2000 }).optional(), notesInternal: v.string({ max: 2000 }).optional() }), ctx.body)
  return tx(async (c) => {
    const wo = await getWo(c, ctx, ctx.params.id, true); editable(wo)
    if ((b.laborRate !== undefined && Number(b.laborRate) !== Number(wo.labor_rate)) || (b.warrantyDays !== undefined && b.warrantyDays !== wo.warranty_days))
      if (!can(ctx.user, 'oficina.aprovar')) throw forbidden('Alterar valor-hora ou garantia exige a permissão de aprovar OS.')
    if (b.professionalId && !(await c.one(`SELECT 1 FROM professionals WHERE id = $1 AND company_id = $2 AND active`, [b.professionalId, ctx.user.companyId]))) throw unprocessable('Mecânico inválido.')
    const map: Record<string, string> = { complaint: 'complaint', diagnosis: 'diagnosis', checklist: 'checklist', kmIn: 'km_in', fuelLevel: 'fuel_level', professionalId: 'professional_id',
      promisedAt: 'promised_at', warrantyDays: 'warranty_days', laborRate: 'labor_rate', notesCustomer: 'notes_customer', notesInternal: 'notes_internal' }
    const keys = Object.keys(b).filter((k) => map[k])
    if (!keys.length) throw unprocessable('Nada para alterar.')
    await c.query(`UPDATE work_orders SET ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [wo.id, ...keys.map((k) => (k === 'checklist' ? JSON.stringify(b[k]) : b[k] === '' ? null : b[k]))])
    if (b.kmIn !== undefined) await c.query(`UPDATE vehicles SET km_current = GREATEST(COALESCE(km_current,0), $2), updated_at = now() WHERE id = $1`, [wo.vehicle_id, b.kmIn])
    if (b.laborRate !== undefined && Number(b.laborRate) !== Number(wo.labor_rate)) await woEvent(c, wo.id, null, null, `Valor-hora alterado de ${Number(wo.labor_rate).toFixed(2)} para ${Number(b.laborRate).toFixed(2)} (vale para novas linhas de mão de obra)`, ctx.user.id)
    await audit(c, ctx, 'oficina.os_alterada', 'work_order', wo.id, b)
    return detail(wo.id, ctx.user.companyId, c)
  })
})

// ---------- Itens ----------
const itemSchema = {
  kind: v.enum(['servico', 'mao_de_obra', 'peca', 'produto'] as const), productId: v.uuid().optional(), variantId: v.uuid().optional(), hours: v.number({ min: 0.05, max: 500 }).optional(),
  qty: v.number({ min: 0.001, max: 100000 }).optional(), unitPrice: v.money({ min: 0, max: 1000000 }).optional(), discount: v.money({ min: 0, max: 1000000 }).optional(),
  professionalId: v.uuid().nullable().optional(), description: v.string({ max: 200 }).optional(),
}
function checkDiscount(ctx: Ctx, gross: number, disc: number) {
  if (disc > gross) throw unprocessable('Desconto maior que o valor do item.')
  if (gross > 0 && (disc / gross) * 100 > ctx.user.maxDiscountPct + 0.0001 && !can(ctx.user, 'oficina.aprovar') && !can(ctx.user, 'vendas.desconto_extra'))
    throw forbidden(`Desconto acima do seu limite (${ctx.user.maxDiscountPct}%).`)
}

router.post('/api/work-orders/:id/items', { perm: 'oficina.editar' }, async (ctx) => {
  const b: any = parse(v.object(itemSchema), ctx.body)
  return tx(async (c) => {
    const wo = await getWo(c, ctx, ctx.params.id, true); editable(wo)
    if (b.unitPrice !== undefined && !can(ctx.user, 'oficina.aprovar') && b.kind !== 'mao_de_obra') {
      // preço livre só com permissão (serviço/peça usam o preço de cadastro)
      const p = b.productId ? await c.one(`SELECT sale_price FROM products WHERE id = $1`, [b.productId]) : null
      if (!p || Number(p.sale_price) !== Number(b.unitPrice)) throw forbidden('Alterar o preço do item exige a permissão de aprovar OS.')
    }
    let product: any, variantId: string, qty: number, unit: number, description: string
    if (b.kind === 'mao_de_obra') {
      if (!b.hours) throw unprocessable('Informe as horas de mão de obra (ex.: 1,5).')
      if (b.unitPrice !== undefined && Number(b.unitPrice) !== Number(wo.labor_rate) && !can(ctx.user, 'oficina.aprovar')) throw forbidden('Alterar o valor-hora exige a permissão de aprovar OS.')
      const lp = await laborProduct(c, ctx.user.companyId, ctx.user.id, Number(wo.labor_rate))
      product = { id: lp.id }; variantId = lp.variant_id
      qty = Math.round(b.hours * 100) / 100; unit = b.unitPrice ?? Number(wo.labor_rate)
      description = `Mão de obra${b.description ? ' — ' + b.description : ''} (${String(qty).replace('.', ',')} h)`
    } else {
      if (!b.productId) throw unprocessable('Selecione o serviço ou o produto.')
      product = await c.one(`SELECT id, kind, name, sale_price, unit, sale_by_weight, active, code FROM products WHERE id = $1 AND company_id = $2`, [b.productId, ctx.user.companyId])
      if (!product || !product.active) throw unprocessable('Item inválido ou inativo.')
      if (b.kind === 'servico' && product.kind !== 'servico') throw unprocessable('Selecione um serviço cadastrado (Cadastros › Serviços).')
      if ((b.kind === 'peca' || b.kind === 'produto') && product.kind !== 'produto') throw unprocessable('Peças e produtos vêm do cadastro de produtos (estoque).')
      const variant = b.variantId ? await c.one(`SELECT id, sale_price FROM product_variants WHERE id = $1 AND product_id = $2 AND active`, [b.variantId, product.id])
        : await c.one(`SELECT id, sale_price FROM product_variants WHERE product_id = $1 AND active ORDER BY created_at LIMIT 1`, [product.id])
      if (!variant) throw unprocessable('Variação do produto não encontrada.')
      variantId = variant.id
      qty = checkQty(b.qty ?? 1, { ...product, sku: product.code }, 'Quantidade')
      unit = b.unitPrice ?? Number(variant.sale_price ?? product.sale_price)
      description = b.description || product.name
    }
    const gross = r2(unit * qty), disc = r2(b.discount ?? 0)
    checkDiscount(ctx, gross, disc)
    if (b.professionalId && !(await c.one(`SELECT 1 FROM professionals WHERE id = $1 AND company_id = $2 AND active`, [b.professionalId, ctx.user.companyId]))) throw unprocessable('Mecânico inválido.')
    const given = 'professionalId' in ctx.body
    const prof = b.kind === 'servico' || b.kind === 'mao_de_obra' ? (given ? b.professionalId : wo.professional_id) : (given ? b.professionalId : null)
    const after = !['orcamento', 'aguardando_aprovacao'].includes(wo.status)
    const sort = (await c.one(`SELECT COALESCE(max(sort),0) + 1 AS n FROM work_order_items WHERE work_order_id = $1`, [wo.id])).n
    const st = await getSettings(c, ctx.user.companyId)
    // sem exigência de aprovação, itens incluídos durante a execução já entram aprovados
    const status = after && !st.oficina.exigirAprovacao ? 'aprovado' : 'pendente'
    const it = await c.one(`INSERT INTO work_order_items(company_id, work_order_id, kind, product_id, variant_id, description, qty, unit_price, discount, total, professional_id, status, added_after_approval, sort, created_by)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [ctx.user.companyId, wo.id, b.kind, product.id, variantId, description, qty, unit, disc, r2(gross - disc), prof ?? null, status, after, sort, ctx.user.id])
    if (after) await woEvent(c, wo.id, null, null, `Item adicional: ${description} (${r2(gross - disc).toFixed(2)})${status === 'pendente' ? ' — aguardando aprovação do cliente' : ''}`, ctx.user.id)
    return it
  })
})

router.put('/api/work-orders/:id/items/:itemId', { perm: 'oficina.editar' }, async (ctx) => {
  const b: any = parse(v.object({ qty: v.number({ min: 0.001, max: 100000 }).optional(), unitPrice: v.money({ min: 0, max: 1000000 }).optional(), discount: v.money({ min: 0, max: 1000000 }).optional(),
    professionalId: v.uuid().nullable().optional(), description: v.string({ min: 1, max: 200 }).optional() }), ctx.body)
  return tx(async (c) => {
    const wo = await getWo(c, ctx, ctx.params.id, true); editable(wo)
    const it = await c.one(`SELECT i.*, p.unit, p.sale_by_weight, p.code FROM work_order_items i JOIN products p ON p.id = i.product_id WHERE i.id = $1 AND i.work_order_id = $2 FOR UPDATE OF i`, [ctx.params.itemId, wo.id])
    if (!it) throw notFound('Item da OS')
    if (it.sale_item_id) throw unprocessable('Item já cobrado não pode ser alterado.')
    const money = b.qty !== undefined || b.unitPrice !== undefined || b.discount !== undefined
    if (money && it.status === 'aprovado' && !can(ctx.user, 'oficina.aprovar')) throw forbidden('Item já aprovado pelo cliente: alterar valores exige a permissão de aprovar OS.')
    if (b.unitPrice !== undefined && Number(b.unitPrice) !== Number(it.unit_price) && !can(ctx.user, 'oficina.aprovar')) throw forbidden('Alterar o preço do item exige a permissão de aprovar OS.')
    const qty = b.qty !== undefined ? (it.kind === 'mao_de_obra' ? Math.round(b.qty * 100) / 100 : checkQty(b.qty, { ...it, sku: it.code }, 'Quantidade')) : Number(it.qty)
    const unit = b.unitPrice ?? Number(it.unit_price), disc = r2(b.discount ?? Number(it.discount)), gross = r2(unit * qty)
    checkDiscount(ctx, gross, disc)
    if (b.professionalId && !(await c.one(`SELECT 1 FROM professionals WHERE id = $1 AND company_id = $2 AND active`, [b.professionalId, ctx.user.companyId]))) throw unprocessable('Mecânico inválido.')
    let description = b.description ?? it.description
    if (it.kind === 'mao_de_obra' && b.qty !== undefined && !b.description) description = description.replace(/\(([\d.,]+) h\)$/, `(${String(qty).replace('.', ',')} h)`)
    const r = await c.one(`UPDATE work_order_items SET qty = $2, unit_price = $3, discount = $4, total = $5, professional_id = CASE WHEN $7 THEN $6 ELSE professional_id END, description = $8 WHERE id = $1 RETURNING *`,
      [it.id, qty, unit, disc, r2(gross - disc), b.professionalId ?? null, 'professionalId' in ctx.body, description])
    if (money && it.status === 'aprovado') await woEvent(c, wo.id, null, null, `Item aprovado alterado: ${description} de ${Number(it.total).toFixed(2)} para ${Number(r.total).toFixed(2)}`, ctx.user.id)
    return r
  })
})

router.delete('/api/work-orders/:id/items/:itemId', { perm: 'oficina.editar' }, async (ctx) => tx(async (c) => {
  const wo = await getWo(c, ctx, ctx.params.id, true); editable(wo)
  const it = await c.one(`SELECT * FROM work_order_items WHERE id = $1 AND work_order_id = $2 FOR UPDATE`, [ctx.params.itemId, wo.id])
  if (!it) throw notFound('Item da OS')
  if (it.sale_item_id) throw unprocessable('Item já cobrado não pode ser removido.')
  if (it.status === 'aprovado' && !can(ctx.user, 'oficina.aprovar')) throw forbidden('Item já aprovado pelo cliente: remover exige a permissão de aprovar OS.')
  await c.query(`DELETE FROM work_order_items WHERE id = $1`, [it.id])
  if (it.status === 'aprovado') await woEvent(c, wo.id, null, null, `Item aprovado removido: ${it.description} (${Number(it.total).toFixed(2)})`, ctx.user.id)
  return { ok: true }
}))

/** Registra a aprovação do cliente (item a item). Itens não marcados ficam recusados. */
router.post('/api/work-orders/:id/approve', { perm: 'oficina.aprovar' }, async (ctx) => {
  const b = parse(v.object({ itemIds: v.array(v.uuid(), { max: 300 }), approvedBy: v.string({ min: 2, max: 120 }), channel: v.enum(['presencial', 'telefone', 'whatsapp', 'email', 'outro'] as const) }), ctx.body)
  return tx(async (c) => {
    const wo = await getWo(c, ctx, ctx.params.id, true); editable(wo)
    const pending = await c.many(`SELECT id, description, total FROM work_order_items WHERE work_order_id = $1 AND status = 'pendente'`, [wo.id])
    if (!pending.length) throw unprocessable('Não há itens aguardando aprovação.')
    const ids = new Set(b.itemIds)
    if ([...ids].some((id) => !pending.some((p) => p.id === id))) throw unprocessable('Item inválido na aprovação.')
    const approved = pending.filter((p) => ids.has(p.id)), refused = pending.filter((p) => !ids.has(p.id))
    if (approved.length) await c.query(`UPDATE work_order_items SET status = 'aprovado' WHERE id = ANY($1::uuid[])`, [approved.map((p) => p.id)])
    if (refused.length) await c.query(`UPDATE work_order_items SET status = 'recusado' WHERE id = ANY($1::uuid[])`, [refused.map((p) => p.id)])
    const sum = (l: any[]) => r2(l.reduce((s, x) => s + Number(x.total), 0)).toFixed(2)
    const first = ['orcamento', 'aguardando_aprovacao'].includes(wo.status)
    if (first) {
      const anyApproved = approved.length || (await c.one(`SELECT 1 FROM work_order_items WHERE work_order_id = $1 AND status = 'aprovado'`, [wo.id]))
      const to = anyApproved ? 'aprovada' : wo.status
      await c.query(`UPDATE work_orders SET status = $2, approved_at = now(), approved_by_name = $3, approval_channel = $4, updated_at = now() WHERE id = $1`, [wo.id, to, b.approvedBy, b.channel])
      await woEvent(c, wo.id, wo.status, to, `Orçamento ${anyApproved ? 'aprovado' : 'recusado'} por ${b.approvedBy} (${b.channel}): ${approved.length} item(ns) aprovado(s) = ${sum(approved)}${refused.length ? `; ${refused.length} recusado(s) = ${sum(refused)}` : ''}`, ctx.user.id)
    } else await woEvent(c, wo.id, null, null, `Adicional ${approved.length ? 'aprovado' : 'recusado'} por ${b.approvedBy} (${b.channel}): ${approved.length} aprovado(s) = ${sum(approved)}${refused.length ? `; ${refused.length} recusado(s)` : ''}`, ctx.user.id)
    await audit(c, ctx, 'oficina.orcamento_aprovado', 'work_order', wo.id, { number: wo.number, approved: approved.length, refused: refused.length, by: b.approvedBy, channel: b.channel })
    return detail(wo.id, ctx.user.companyId, c)
  })
})

/** Andamento: enviar orçamento, iniciar, aguardar peça, pronta, entregar, cancelar. */
router.post('/api/work-orders/:id/status', { perm: 'oficina.editar' }, async (ctx) => {
  const b = parse(v.object({ to: v.enum(['orcamento', 'aguardando_aprovacao', 'em_execucao', 'aguardando_peca', 'pronta', 'entregue', 'cancelada'] as const), note: v.string({ max: 1000 }).optional() }), ctx.body)
  return tx(async (c) => {
    const wo = await getWo(c, ctx, ctx.params.id, true)
    if (!canMove(wo.status, b.to)) throw unprocessable(`Não é possível passar de "${WO_LABEL[wo.status as WoStatus]}" para "${WO_LABEL[b.to]}".`)
    const t = await woTotals(c, wo.id)
    const st = await getSettings(c, ctx.user.companyId)
    if (b.to === 'aguardando_aprovacao' && !t.items) throw unprocessable('Inclua serviços ou peças no orçamento antes de enviar ao cliente.')
    if (['em_execucao', 'pronta'].includes(b.to) && st.oficina.exigirAprovacao && !wo.approved_at) throw unprocessable('Registre a aprovação do cliente antes de executar o serviço.')
    if (b.to === 'cancelada') {
      if (!can(ctx.user, 'oficina.aprovar')) throw forbidden('Cancelar OS exige a permissão de aprovar OS.')
      if (!b.note || b.note.trim().length < 3) throw unprocessable('Informe o motivo do cancelamento.')
      if (t.billed > 0) throw unprocessable('OS com itens já cobrados: cancele a venda antes de cancelar a OS.')
      await c.query(`UPDATE work_orders SET status = 'cancelada', cancel_reason = $2, updated_at = now() WHERE id = $1`, [wo.id, b.note])
      await woEvent(c, wo.id, wo.status, 'cancelada', b.note, ctx.user.id)
      await audit(c, ctx, 'oficina.os_cancelada', 'work_order', wo.id, { number: wo.number, reason: b.note }, 'warning')
      return detail(wo.id, ctx.user.companyId, c)
    }
    if (b.to === 'entregue') { await deliverWorkOrder(c, wo, ctx.user.id, b.note); return detail(wo.id, ctx.user.companyId, c) }
    if (b.to === 'pronta' && t.pending) throw unprocessable('Há itens adicionais aguardando aprovação do cliente: aprove ou recuse antes de concluir.')
    const extra = b.to === 'em_execucao' ? ', started_at = COALESCE(started_at, now())' : b.to === 'pronta' ? ', finished_at = now()' : ''
    await c.query(`UPDATE work_orders SET status = $2${extra}, updated_at = now() WHERE id = $1`, [wo.id, b.to])
    await woEvent(c, wo.id, wo.status, b.to, b.note ?? null, ctx.user.id)
    return detail(wo.id, ctx.user.companyId, c)
  })
})

/** Itens aprovados e ainda não cobrados, para o PDV (preços e descontos da OS). */
router.get('/api/work-orders/:id/checkout', { perm: ['oficina.ver', 'vendas.criar'] }, async (ctx) => {
  const wo = await db.one(`SELECT w.*, ve.plate, ve.model FROM work_orders w JOIN vehicles ve ON ve.id = w.vehicle_id WHERE w.id = $1 AND w.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!wo) throw notFound('Ordem de serviço')
  if (['orcamento', 'aguardando_aprovacao', 'cancelada'].includes(wo.status)) throw conflict('A OS precisa estar aprovada para ser cobrada.')
  const items = await db.many(`SELECT i.id AS work_order_item_id, i.kind, i.qty, i.unit_price, i.discount, i.total, i.description, i.professional_id, pr.name AS professional,
                                      v.id AS variant_id, v.sku, v.barcode, p.name, p.track_stock, p.unit
                                 FROM work_order_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = i.product_id LEFT JOIN professionals pr ON pr.id = i.professional_id
                                WHERE i.work_order_id = $1 AND i.status = 'aprovado' AND i.sale_item_id IS NULL ORDER BY i.sort`, [wo.id])
  const pending = (await db.one(`SELECT count(*)::int AS n FROM work_order_items WHERE work_order_id = $1 AND status = 'pendente'`, [wo.id])).n
  const customer = await db.one(`SELECT c.*, (SELECT COALESCE(sum(amount + interest + fine - discount - paid_amount),0) FROM receivables r WHERE r.customer_id = c.id AND r.method_kind = 'crediario' AND r.status IN ('aberto','parcial')) AS open_balance
                                   FROM customers c WHERE c.id = $1`, [wo.customer_id])
  return { workOrder: { id: wo.id, number: wo.number, status: wo.status, plate: wo.plate, model: wo.model }, customer, items, pending }
})

// =====================================================================  Lembretes de revisão
router.get('/api/vehicle-reminders', { perm: 'oficina.ver' }, async (ctx) => {
  const days = Math.min(365, Math.max(0, Number(ctx.query.days || 30)))
  return db.many(`SELECT r.*, ve.plate, ve.brand, ve.model, ve.km_current, cu.id AS customer_id, cu.name AS customer_name, cu.whatsapp, cu.phone, w.number AS work_order_number
                    FROM vehicle_reminders r JOIN vehicles ve ON ve.id = r.vehicle_id LEFT JOIN customers cu ON cu.id = ve.customer_id LEFT JOIN work_orders w ON w.id = r.work_order_id
                   WHERE r.company_id = $1 AND r.status = 'aberto' AND ((r.due_date IS NOT NULL AND r.due_date <= current_date + $2::int) OR (r.due_km IS NOT NULL AND ve.km_current IS NOT NULL AND ve.km_current >= r.due_km - 500))
                   ORDER BY r.due_date NULLS LAST LIMIT 200`, [ctx.user.companyId, days])
})
router.post('/api/vehicle-reminders/:id', { perm: 'oficina.editar' }, async (ctx) => {
  const b = parse(v.object({ action: v.enum(['contatado', 'descartar', 'reabrir'] as const) }), ctx.body)
  const r = await db.one(`UPDATE vehicle_reminders SET status = CASE WHEN $3 = 'descartar' THEN 'descartado' WHEN $3 = 'reabrir' THEN 'aberto' ELSE status END,
                           contacted_at = CASE WHEN $3 = 'contatado' THEN now() ELSE contacted_at END WHERE id = $1 AND company_id = $2 RETURNING *`, [ctx.params.id, ctx.user.companyId, b.action])
  if (!r) throw notFound('Lembrete')
  return r
})

// =====================================================================  Painel da oficina
router.get('/api/workshop/summary', { perm: 'oficina.ver' }, async (ctx) => {
  const id = ctx.user.companyId
  const days = Math.min(365, Math.max(7, Number(ctx.query.days || 30)))
  const open = await db.one(`SELECT count(*) FILTER (WHERE status NOT IN ('entregue','cancelada'))::int AS open,
                                    count(*) FILTER (WHERE status IN ('orcamento','aguardando_aprovacao'))::int AS quotes,
                                    count(*) FILTER (WHERE status IN ('aprovada','em_execucao'))::int AS working,
                                    count(*) FILTER (WHERE status = 'aguardando_peca')::int AS waiting_parts,
                                    count(*) FILTER (WHERE status = 'pronta')::int AS ready,
                                    count(*) FILTER (WHERE promised_at < now() AND status NOT IN ('pronta','entregue','cancelada'))::int AS late
                               FROM work_orders WHERE company_id = $1`, [id])
  const period = await db.one(`SELECT count(DISTINCT w.id)::int AS delivered,
                                      COALESCE(sum(i.total) FILTER (WHERE i.kind IN ('servico','mao_de_obra')),0)::float8 AS labor,
                                      COALESCE(sum(i.total) FILTER (WHERE i.kind IN ('peca','produto')),0)::float8 AS parts,
                                      COALESCE(sum(i.qty) FILTER (WHERE i.kind = 'mao_de_obra'),0)::float8 AS hours,
                                      COALESCE(avg(EXTRACT(epoch FROM w.delivered_at - w.created_at) / 86400.0),0)::float8 AS avg_days
                                 FROM work_orders w LEFT JOIN work_order_items i ON i.work_order_id = w.id AND i.status = 'aprovado'
                                WHERE w.company_id = $1 AND w.status = 'entregue' AND w.delivered_at > now() - ($2 || ' days')::interval`, [id, String(days)])
  const approval = await db.one(`SELECT COALESCE(sum(i.total) FILTER (WHERE i.status = 'aprovado'),0)::float8 AS approved, COALESCE(sum(i.total) FILTER (WHERE i.status IN ('aprovado','recusado')),0)::float8 AS decided
                                   FROM work_order_items i JOIN work_orders w ON w.id = i.work_order_id WHERE w.company_id = $1 AND w.created_at > now() - ($2 || ' days')::interval`, [id, String(days)])
  const mechanics = await db.many(`SELECT pr.id, pr.name, COALESCE(sum(i.qty) FILTER (WHERE i.kind = 'mao_de_obra'),0)::float8 AS hours, COALESCE(sum(i.total),0)::float8 AS revenue, count(DISTINCT w.id)::int AS orders
                                     FROM work_order_items i JOIN work_orders w ON w.id = i.work_order_id JOIN professionals pr ON pr.id = i.professional_id
                                    WHERE w.company_id = $1 AND w.status = 'entregue' AND w.delivered_at > now() - ($2 || ' days')::interval AND i.status = 'aprovado' GROUP BY pr.id, pr.name ORDER BY revenue DESC`, [id, String(days)])
  const topParts = await db.many(`SELECT i.description AS label, sum(i.qty)::float8 AS qty, sum(i.total)::float8 AS value FROM work_order_items i JOIN work_orders w ON w.id = i.work_order_id
                                   WHERE w.company_id = $1 AND i.kind IN ('peca','produto') AND i.status = 'aprovado' AND w.created_at > now() - ($2 || ' days')::interval GROUP BY 1 ORDER BY value DESC LIMIT 8`, [id, String(days)])
  const reminders = (await db.one(`SELECT count(*)::int AS n FROM vehicle_reminders WHERE company_id = $1 AND status = 'aberto' AND due_date <= current_date + 15`, [id])).n
  const revenue = r2(period.labor + period.parts)
  return { days, open, period: { ...period, revenue, ticket: period.delivered ? r2(revenue / period.delivered) : 0, laborPct: revenue ? r2((period.labor / revenue) * 100) : 0 },
    approvalPct: approval.decided ? r2((approval.approved / approval.decided) * 100) : null, mechanics, topParts, reminders }
})

void addDays; void today; void onlyDigits
