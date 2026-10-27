import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, teardown, call, login, db, createCompanyWithAdmin, createUser } from './helpers'

/**
 * Oficina mecânica: veículo por placa, OS com checklist, orçamento com serviço de preço fechado, mão de obra por hora,
 * peças e produtos do estoque, aprovação item a item, adicional durante a execução, cobrança no PDV com comissão do mecânico,
 * baixa de estoque fracionada (litros), entrega automática com garantia e lembrete de revisão por km.
 */
const key = () => 'k-' + Math.random().toString(36).slice(2) + Date.now()
const H = () => ({ 'idempotency-key': key() })
let S: { token: string; companyId: string; branchId: string }
let V: string
let lk: any
let mec: any, trocaOleo: any, oleo: any, filtro: any, pastilha: any, aditivo: any, cliente: any
let wo: any
const pix = () => lk.paymentMethods.find((x: any) => x.kind === 'pix').id
const stockOf = async (variantId: string) => Number((await db.query(`SELECT COALESCE(sum(qty),0) AS q FROM stock_balances WHERE variant_id = $1`, [variantId])).rows[0].q)

before(async () => {
  await setup()
  const id = await createCompanyWithAdmin('Auto Center Teste', 'oficina', 'admin.of@teste.local')
  S = await login('admin.of@teste.local')
  await createUser(id, 'Atendente', 'atendente.of@teste.local', 'Vendedor')
  V = (await login('atendente.of@teste.local')).token
  lk = (await call('GET', '/api/lookups', { token: S.token })).body
})
after(teardown)

test('segmento oficina: módulos, vocabulário e cadastros base', async () => {
  const me = await call('GET', '/api/auth/me', { token: S.token })
  assert.equal(me.body.segment.id, 'oficina'); assert.equal(me.body.segment.terms.profissional, 'Mecânico')
  for (const m of ['oficina', 'agenda', 'combos']) assert.ok(me.body.company.modules.includes(m), m)
  assert.ok(me.body.permissions.includes('*') || me.body.permissions.includes('oficina.aprovar'))
  mec = (await call('POST', '/api/professionals', { token: S.token, body: { name: 'Carlos Mecânico', commission_services_pct: 30, commission_products_pct: 5 } })).body
  assert.ok(mec.id)
  trocaOleo = (await call('POST', '/api/services', { token: S.token, body: { kind: 'servico', name: 'Troca de óleo e filtro', sale_price: 50, return_km: 5000, return_days: 180 } })).body
  assert.equal(trocaOleo.return_km, 5000)
  const mk = async (code: string, name: string, price: number, unit: string, qty: number) => {
    const p = await call('POST', '/api/products', { token: S.token, body: { code, name, sale_price: price, cost_price: price / 2, unit } })
    assert.equal(p.status, 200, JSON.stringify(p.body))
    await call('POST', '/api/stock/movements', { token: S.token, body: { type: 'entrada', reason: 'Carga inicial', items: [{ variantId: p.body.variants[0].id, qty }] }, headers: H() })
    return { ...p.body, variant: p.body.variants[0] }
  }
  oleo = await mk('OL-5W30', 'Óleo 5W30 sintético', 45, 'L', 20)
  filtro = await mk('FO-01', 'Filtro de óleo', 35, 'UN', 5)
  pastilha = await mk('PF-01', 'Pastilha de freio dianteira (jogo)', 150, 'JG', 2)
  aditivo = await mk('AD-01', 'Aditivo de radiador', 30, 'UN', 6)
  cliente = (await call('POST', '/api/customers', { token: S.token, body: { name: 'Roberto Motorista', whatsapp: '11977776666' } })).body
})

test('OS com veículo novo por placa (Mercosul), checklist e validações de placa e km', async () => {
  const bad = await call('POST', '/api/work-orders', { token: S.token, headers: H(), body: { customerId: cliente.id, vehicle: { model: 'Onix', plate: 'XX-12' } } })
  assert.equal(bad.status, 422)
  const r = await call('POST', '/api/work-orders', { token: S.token, headers: H(), body: {
    customerId: cliente.id, vehicle: { type: 'carro', brand: 'Chevrolet', model: 'Onix 1.0 Turbo', plate: 'abc-1d23', yearModel: 2022 }, kmIn: 42000, fuelLevel: '1/2',
    complaint: 'Barulho ao frear e revisão de óleo', professionalId: mec.id, checklist: [{ item: 'Para-choque', state: 'avaria', note: 'risco lateral' }, { item: 'Estepe', state: 'ok' }] } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'orcamento'); assert.equal(Number(r.body.labor_rate), 120)
  wo = r.body
  const dup = await call('POST', '/api/vehicles', { token: S.token, body: { model: 'Outro', plate: 'ABC1D23' } })
  assert.equal(dup.status, 409)
  const vehicles = await call('GET', '/api/vehicles?q=abc1d23', { token: S.token })
  assert.equal(vehicles.body.items.length, 1); assert.equal(vehicles.body.items[0].plate, 'ABC1D23'); assert.equal(vehicles.body.items[0].km_current, 42000)
  const lower = await call('POST', '/api/work-orders', { token: S.token, headers: H(), body: { customerId: cliente.id, vehicleId: vehicles.body.items[0].id, kmIn: 41000 } })
  assert.equal(lower.status, 422)
})

test('orçamento: serviço de preço fechado, mão de obra por hora, peças e produto fracionado (litros)', async () => {
  const add = (body: any, token = S.token) => call('POST', `/api/work-orders/${wo.id}/items`, { token, body })
  assert.equal((await add({ kind: 'servico', productId: trocaOleo.id })).status, 200)
  const mo = await add({ kind: 'mao_de_obra', hours: 1.5, description: 'Revisão dos freios' })
  assert.equal(mo.status, 200); assert.equal(Number(mo.body.total), 180); assert.equal(mo.body.professional_id, mec.id)
  assert.equal((await add({ kind: 'peca', productId: filtro.id, qty: 1 })).status, 200)
  const ol = await add({ kind: 'produto', productId: oleo.id, qty: 3.5 })
  assert.equal(ol.status, 200); assert.equal(Number(ol.body.total), 157.5)
  assert.equal((await add({ kind: 'peca', productId: pastilha.id, qty: 1 })).status, 200)
  // atendente não altera preço nem o valor-hora
  assert.equal((await add({ kind: 'peca', productId: filtro.id, qty: 1, unitPrice: 10 }, V)).status, 403)
  assert.equal((await add({ kind: 'mao_de_obra', hours: 1, unitPrice: 80 }, V)).status, 403)
  // serviço precisa ser do cadastro de serviços; peça precisa ser produto
  assert.equal((await add({ kind: 'servico', productId: filtro.id })).status, 422)
  // não executa antes da aprovação
  assert.equal((await call('POST', `/api/work-orders/${wo.id}/status`, { token: S.token, body: { to: 'em_execucao' } })).status, 422)
  assert.equal((await call('POST', `/api/work-orders/${wo.id}/status`, { token: S.token, body: { to: 'aguardando_aprovacao' } })).status, 200)
  const d = await call('GET', `/api/work-orders/${wo.id}`, { token: S.token })
  assert.equal(d.body.totals.quoted, 50 + 180 + 35 + 157.5 + 150)
  assert.equal(d.body.items.find((i: any) => i.product_id === oleo.id).stock, 20)
})

test('aprovação item a item; adicional durante a execução precisa de nova aprovação', async () => {
  const d = (await call('GET', `/api/work-orders/${wo.id}`, { token: S.token })).body
  const ids = d.items.filter((i: any) => i.product_id !== pastilha.id).map((i: any) => i.id)
  assert.equal((await call('POST', `/api/work-orders/${wo.id}/approve`, { token: V, body: { itemIds: ids, approvedBy: 'Roberto', channel: 'whatsapp' } })).status, 403)
  const ap = await call('POST', `/api/work-orders/${wo.id}/approve`, { token: S.token, body: { itemIds: ids, approvedBy: 'Roberto (cliente)', channel: 'whatsapp' } })
  assert.equal(ap.status, 200); assert.equal(ap.body.status, 'aprovada')
  assert.equal(ap.body.items.find((i: any) => i.product_id === pastilha.id).status, 'recusado')
  assert.equal(ap.body.totals.approved, 50 + 180 + 35 + 157.5)
  assert.equal((await call('POST', `/api/work-orders/${wo.id}/status`, { token: V, body: { to: 'em_execucao' } })).status, 200)
  const extra = await call('POST', `/api/work-orders/${wo.id}/items`, { token: V, body: { kind: 'produto', productId: aditivo.id, qty: 1 } })
  assert.equal(extra.body.status, 'pendente'); assert.equal(extra.body.added_after_approval, true)
  assert.equal((await call('POST', `/api/work-orders/${wo.id}/status`, { token: V, body: { to: 'pronta' } })).status, 422)
  await call('POST', `/api/work-orders/${wo.id}/approve`, { token: S.token, body: { itemIds: [extra.body.id], approvedBy: 'Roberto (cliente)', channel: 'telefone' } })
  // item aprovado: atendente não altera valor
  assert.equal((await call('PUT', `/api/work-orders/${wo.id}/items/${extra.body.id}`, { token: V, body: { qty: 2 } })).status, 403)
  const pr = await call('POST', `/api/work-orders/${wo.id}/status`, { token: V, body: { to: 'pronta' } })
  assert.equal(pr.status, 200); assert.equal(pr.body.status, 'pronta')
  // não entrega sem cobrar
  assert.equal((await call('POST', `/api/work-orders/${wo.id}/status`, { token: V, body: { to: 'entregue' } })).status, 422)
})

test('cobrança no PDV: preços da OS, comissão do mecânico, estoque em litros e entrega automática com garantia e lembrete', async () => {
  const co = await call('GET', `/api/work-orders/${wo.id}/checkout`, { token: S.token })
  assert.equal(co.status, 200); assert.equal(co.body.items.length, 5)
  const items = co.body.items.map((i: any) => ({ workOrderItemId: i.work_order_item_id, qty: Number(i.qty) }))
  const total = 50 + 180 + 35 + 157.5 + 30
  const wrong = await call('POST', '/api/sales', { token: S.token, headers: H(), body: { items, payments: [{ methodId: pix(), amount: total }] } })
  assert.equal(wrong.status, 422)
  const sale = await call('POST', '/api/sales', { token: S.token, headers: H(), body: { customerId: cliente.id, items, payments: [{ methodId: pix(), amount: total }] } })
  assert.equal(sale.status, 200, JSON.stringify(sale.body)); assert.equal(Number(sale.body.total), total)
  assert.equal(await stockOf(oleo.variant.id), 16.5)
  assert.equal(await stockOf(filtro.variant.id), 4)
  assert.equal(await stockOf(pastilha.variant.id), 2, 'peça recusada não sai do estoque')
  const pcs = (await db.query(`SELECT kind, sum(amount)::float8 AS amount FROM professional_commissions WHERE sale_id = $1 GROUP BY kind`, [sale.body.id])).rows
  assert.deepEqual(pcs.map((r: any) => [r.kind, Number(r.amount)]), [['servico', 69]])
  const hours = (await db.query(`SELECT si.qty FROM sale_items si JOIN products p ON p.id = (SELECT product_id FROM product_variants WHERE id = si.variant_id) WHERE si.sale_id = $1 AND p.code = 'MO-HORA'`, [sale.body.id])).rows[0]
  assert.equal(Number(hours.qty), 1.5)
  const d = (await call('GET', `/api/work-orders/${wo.id}`, { token: S.token })).body
  assert.equal(d.status, 'entregue'); assert.ok(d.warranty_until); assert.equal(d.sale_id, sale.body.id)
  const veh = (await call('GET', `/api/vehicles/${d.vehicle_id}`, { token: S.token })).body
  assert.equal(veh.orders.length, 1)
  const rem = veh.reminders.find((r: any) => r.product_id === trocaOleo.id)
  assert.ok(rem); assert.equal(rem.due_km, 47000)
  // de novo no PDV: nada a cobrar
  const again = await call('POST', '/api/sales', { token: S.token, headers: H(), body: { customerId: cliente.id, items: [items[0]], payments: [{ methodId: pix(), amount: 50 }] } })
  assert.equal(again.status, 422)
})

test('painel da oficina e lembretes', async () => {
  const s = await call('GET', '/api/workshop/summary', { token: S.token })
  assert.equal(s.status, 200)
  assert.equal(s.body.period.delivered, 1); assert.equal(s.body.period.hours, 1.5); assert.equal(s.body.period.labor, 230); assert.equal(s.body.period.parts, 222.5)
  assert.equal(s.body.mechanics[0].name, 'Carlos Mecânico')
  assert.ok(s.body.approvalPct > 70 && s.body.approvalPct < 100)
  await db.query(`UPDATE vehicles SET km_current = 46800 WHERE plate = 'ABC1D23'`)
  const r = await call('GET', '/api/vehicle-reminders', { token: S.token })
  assert.ok(r.body.some((x: any) => x.plate === 'ABC1D23' && x.due_km === 47000), 'perto da quilometragem de troca')
  const list = await call('GET', '/api/work-orders?status=abertas', { token: S.token })
  assert.equal(list.body.items.length, 0, 'a OS foi entregue e a de km menor foi recusada')
})
