import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, teardown, call, login, db, createCompanyWithAdmin, createUser } from './helpers'

/**
 * Prestadores de serviço: salão (com estética), clínica de estética e odontologia.
 * Agenda sem conflito, expediente e bloqueios, gerente que também atende, cobrança no PDV com comissão por profissional,
 * pacotes de sessões, prontuário com consentimento, odontograma e plano de tratamento cobrado no crediário.
 */
const key = () => 'k-' + Math.random().toString(36).slice(2) + Date.now()
const H = () => ({ 'idempotency-key': key() })
/** Próxima segunda-feira (data local), pelo menos 2 dias à frente. */
function nextMonday() {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 2)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
const MON = nextMonday()
let S: { token: string; companyId: string; branchId: string }
let salonId: string
let lk: any
let corte: any, manicure: any, shampoo: any, pacote: any
let me: any, ana: any
let cliente: any

before(async () => {
  await setup()
  salonId = await createCompanyWithAdmin('Salão Teste', 'salao', 'admin.s@teste.local')
  S = await login('admin.s@teste.local')
  lk = (await call('GET', '/api/lookups', { token: S.token })).body
})
after(teardown)
const pix = () => lk.paymentMethods.find((x: any) => x.kind === 'pix').id

test('salão: segmento, serviços, gerente que também atende e profissional com serviços restritos', async () => {
  const meRes = await call('GET', '/api/auth/me', { token: S.token })
  assert.equal(meRes.body.segment.id, 'salao'); assert.equal(meRes.body.segment.terms.prontuario, 'Ficha técnica')
  for (const m of ['agenda', 'pacotes', 'prontuario', 'combos', 'validade']) assert.ok(meRes.body.company.modules.includes(m), m)
  assert.ok((await db.query(`SELECT 1 FROM roles WHERE company_id = $1 AND name = 'Profissional'`, [salonId])).rowCount === 1)
  corte = (await call('POST', '/api/services', { token: S.token, body: { kind: 'servico', name: 'Corte feminino', sale_price: 80, duration_min: 60, return_days: 30 } })).body
  assert.ok(corte.variant_id, JSON.stringify(corte)); assert.equal(corte.track_stock, false); assert.equal(corte.code, 'SRV0001')
  manicure = (await call('POST', '/api/services', { token: S.token, body: { kind: 'servico', name: 'Manicure', sale_price: 40, duration_min: 45 } })).body
  const badPkg = await call('POST', '/api/services', { token: S.token, body: { kind: 'pacote', name: 'Pacote sem serviço', sale_price: 100 } })
  assert.equal(badPkg.status, 422)
  pacote = (await call('POST', '/api/services', { token: S.token, body: { kind: 'pacote', name: '4 cortes', sale_price: 240, package_service_id: corte.id, package_sessions: 4, package_validity_days: 120 } })).body
  assert.equal(pacote.kind, 'pacote')
  const p = await call('POST', '/api/products', { token: S.token, body: { code: 'SH-01', name: 'Shampoo profissional', sale_price: 60, cost_price: 25 } })
  shampoo = p.body.variants[0]
  await call('POST', '/api/stock/movements', { token: S.token, body: { type: 'entrada', reason: 'Carga inicial', items: [{ variantId: shampoo.id, qty: 10 }] }, headers: H() })
  // a lista de produtos não mistura serviços
  const prods = await call('GET', '/api/products', { token: S.token })
  assert.ok(prods.body.items.every((x: any) => x.name !== 'Corte feminino'))
  // gerente/dono também atende
  me = (await call('POST', '/api/professionals/me', { token: S.token, body: { specialty: 'Cabeleireira' } })).body
  assert.ok(me.user_id)
  const again = await call('POST', '/api/professionals/me', { token: S.token, body: {} })
  assert.equal(again.body.id, me.id)
  await call('PUT', `/api/professionals/${me.id}`, { token: S.token, body: { commission_services_pct: 50 } })
  ana = (await call('POST', '/api/professionals', { token: S.token, body: { name: 'Ana Manicure', commission_services_pct: 40, commission_products_pct: 10, services: [{ product_id: manicure.id }] } })).body
  assert.ok(ana.id)
  const badHours = await call('PUT', `/api/professionals/${ana.id}`, { token: S.token, body: { work_hours: { 1: [['18:00', '09:00']] } } })
  assert.equal(badHours.status, 422)
  const list = await call('GET', '/api/professionals', { token: S.token })
  assert.equal(list.body.mine, me.id); assert.equal(list.body.items.length, 2)
})

test('agenda: conflito de horário, expediente, bloqueio, concorrência e horários livres', async () => {
  cliente = (await call('POST', '/api/customers', { token: S.token, body: { name: 'Maria Cliente', whatsapp: '11988887777', credit_limit: 2000 } })).body
  const notHers = await call('POST', '/api/appointments', { token: S.token, body: { professionalId: ana.id, customerId: cliente.id, start: `${MON}T10:00`, services: [{ productId: corte.id }] }, headers: H() })
  assert.equal(notHers.status, 422); assert.match(notHers.body.error.message, /não executa/)
  const ok = await call('POST', '/api/appointments', { token: S.token, body: { professionalId: ana.id, customerId: cliente.id, start: `${MON}T10:00`, services: [{ productId: manicure.id }] }, headers: H() })
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.end_local, `${MON}T10:45`); assert.equal(Number(ok.body.total), 40)
  const clash = await call('POST', '/api/appointments', { token: S.token, body: { professionalId: ana.id, guestName: 'Encaixe', start: `${MON}T10:30`, services: [{ productId: manicure.id }] }, headers: H() })
  assert.equal(clash.status, 409); assert.equal(clash.body.error.code, 'horario_ocupado')
  const late = await call('POST', '/api/appointments', { token: S.token, body: { professionalId: ana.id, guestName: 'Noite', start: `${MON}T21:00`, services: [{ productId: manicure.id }] }, headers: H() })
  assert.equal(late.status, 409); assert.equal(late.body.error.code, 'fora_do_expediente')
  const forced = await call('POST', '/api/appointments', { token: S.token, body: { professionalId: ana.id, guestName: 'Noite', start: `${MON}T21:00`, services: [{ productId: manicure.id }], ignoreHours: true }, headers: H() })
  assert.equal(forced.status, 200, JSON.stringify(forced.body))
  const blk = await call('POST', '/api/schedule-blocks', { token: S.token, body: { professionalId: ana.id, start: `${MON}T14:00`, end: `${MON}T15:00`, reason: 'Curso' } })
  assert.equal(blk.status, 200, JSON.stringify(blk.body))
  const inBlock = await call('POST', '/api/appointments', { token: S.token, body: { professionalId: ana.id, guestName: 'X', start: `${MON}T14:30`, services: [{ productId: manicure.id }] }, headers: H() })
  assert.equal(inBlock.status, 409); assert.equal(inBlock.body.error.code, 'horario_bloqueado')
  // duas reservas simultâneas do mesmo horário: apenas uma é aceita
  const both = await Promise.all([0, 1].map(() => call('POST', '/api/appointments', { token: S.token, body: { professionalId: ana.id, guestName: 'Concorrente', start: `${MON}T16:00`, services: [{ productId: manicure.id }] }, headers: H() })))
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409])
  const slots = await call('GET', `/api/agenda/slots?professionalId=${ana.id}&date=${MON}&duration=45`, { token: S.token })
  assert.ok(!slots.body.slots.includes('10:00') && !slots.body.slots.includes('14:00') && slots.body.slots.includes('09:00'), JSON.stringify(slots.body.slots))
  const ag = await call('GET', `/api/agenda?date=${MON}`, { token: S.token })
  assert.equal(ag.body.appointments.length, 3); assert.equal(ag.body.blocks.length, 1)
  // remarcar para horário livre e cancelar exige motivo
  const re = await call('PUT', `/api/appointments/${forced.body.id}`, { token: S.token, body: { start: `${MON}T17:00` } })
  assert.equal(re.status, 200, JSON.stringify(re.body)); assert.equal(re.body.start_local, `${MON}T17:00`)
  assert.equal((await call('POST', `/api/appointments/${forced.body.id}/status`, { token: S.token, body: { status: 'cancelado' } })).status, 422)
  assert.equal((await call('POST', `/api/appointments/${forced.body.id}/status`, { token: S.token, body: { status: 'cancelado', reason: 'Cliente desistiu' } })).status, 200)
})

test('profissional com perfil próprio vê e agenda só na própria agenda', async () => {
  await createUser(salonId, 'Ana Usuária', 'ana.s@teste.local', 'Profissional')
  const uid = (await db.query(`SELECT id FROM users WHERE email = 'ana.s@teste.local'`)).rows[0].id
  await call('PUT', `/api/professionals/${ana.id}`, { token: S.token, body: { user_id: uid } })
  const A2 = await login('ana.s@teste.local')
  const ag = await call('GET', `/api/agenda?date=${MON}`, { token: A2.token })
  assert.equal(ag.status, 200); assert.ok(ag.body.professionals.every((p: any) => p.id === ana.id)); assert.equal(ag.body.mine, ana.id)
  const other = await call('POST', '/api/appointments', { token: A2.token, body: { professionalId: me.id, guestName: 'Y', start: `${MON}T11:00`, services: [{ productId: corte.id }] }, headers: H() })
  assert.equal(other.status, 403)
  assert.equal((await call('GET', '/api/professional-commissions', { token: A2.token })).status, 200)
})

test('cobrança do atendimento no PDV: preço do agendamento, comissão por profissional, estoque e NFC-e só do produto', async () => {
  const appt = (await db.query(`SELECT id FROM appointments WHERE professional_id = $1 AND status = 'agendado' AND guest_name IS NULL`, [ana.id])).rows[0]
  const co = await call('GET', `/api/appointments/${appt.id}/checkout`, { token: S.token })
  assert.equal(co.status, 200); assert.equal(co.body.items.length, 1); assert.equal(Number(co.body.items[0].price), 40)
  const items = [{ appointmentServiceId: co.body.items[0].appointment_service_id, qty: 1 }, { variantId: shampoo.id, qty: 1, professionalId: ana.id }]
  const wrongCustomer = await call('POST', '/api/sales', { token: S.token, body: { items, payments: [{ methodId: pix(), amount: 100 }] }, headers: H() })
  assert.equal(wrongCustomer.status, 422)
  const sale = await call('POST', '/api/sales', { token: S.token, body: { customerId: cliente.id, items, payments: [{ methodId: pix(), amount: 100 }], emitFiscal: true }, headers: H() })
  assert.equal(sale.status, 200, JSON.stringify(sale.body)); assert.equal(Number(sale.body.total), 100)
  const ap = (await db.query(`SELECT status, sale_id FROM appointments WHERE id = $1`, [appt.id])).rows[0]
  assert.equal(ap.status, 'concluido'); assert.equal(ap.sale_id, sale.body.id)
  const pcs = (await db.query(`SELECT kind, amount FROM professional_commissions WHERE sale_id = $1 ORDER BY kind`, [sale.body.id])).rows
  assert.deepEqual(pcs.map((r: any) => [r.kind, Number(r.amount)]), [['produto', 6], ['servico', 16]])
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM commissions WHERE sale_id = $1`, [sale.body.id])).rows[0].n, 0) // nada para o vendedor
  assert.equal(Number((await db.query(`SELECT qty FROM stock_balances WHERE variant_id = $1`, [shampoo.id])).rows[0].qty), 9)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1`, [corte.variant_id])).rows[0].n, 0)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_balances WHERE variant_id = (SELECT variant_id FROM appointment_services WHERE appointment_id = $1)`, [appt.id])).rows[0].n, 0)
  const fd = (await db.query(`SELECT payload, status FROM fiscal_documents WHERE sale_id = $1`, [sale.body.id])).rows[0]
  assert.equal(fd.payload.itens.length, 1); assert.equal(fd.payload.totais.total, 60); assert.equal(fd.payload.pagamentos.reduce((s: number, p: any) => s + p.valor, 0), 60)
  assert.notEqual(fd.status, 'autorizado')
  // não cobra duas vezes
  const twice = await call('POST', '/api/sales', { token: S.token, body: { customerId: cliente.id, items: [items[0]], payments: [{ methodId: pix(), amount: 40 }] }, headers: H() })
  assert.equal(twice.status, 422)
  // cancelamento estorna comissões e libera o atendimento para nova cobrança
  await db.query(`UPDATE fiscal_documents SET status = 'cancelado' WHERE sale_id = $1`, [sale.body.id])
  const cancel = await call('POST', `/api/sales/${sale.body.id}/cancel`, { token: S.token, body: { reason: 'Teste de cancelamento' }, headers: H() })
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body))
  assert.equal(Number((await db.query(`SELECT COALESCE(sum(amount),0) AS s FROM professional_commissions WHERE sale_id = $1`, [sale.body.id])).rows[0].s), 0)
  assert.equal((await db.query(`SELECT sale_id FROM appointments WHERE id = $1`, [appt.id])).rows[0].sale_id, null)
  assert.equal(Number((await db.query(`SELECT qty FROM stock_balances WHERE variant_id = $1`, [shampoo.id])).rows[0].qty), 10)
})

test('pacotes: exige cliente, sessão baixa ao concluir (uma vez) com comissão por sessão e bloqueia cancelamento após uso', async () => {
  const noCust = await call('POST', '/api/sales', { token: S.token, body: { items: [{ variantId: pacote.variant_id, qty: 1 }], payments: [{ methodId: pix(), amount: 240 }] }, headers: H() })
  assert.equal(noCust.status, 422)
  const sold = await call('POST', '/api/sales', { token: S.token, body: { customerId: cliente.id, items: [{ variantId: pacote.variant_id, qty: 1 }], payments: [{ methodId: pix(), amount: 240 }] }, headers: H() })
  assert.equal(sold.status, 200, JSON.stringify(sold.body))
  const pk = (await call('GET', `/api/customers/${cliente.id}/packages`, { token: S.token })).body[0]
  assert.equal(pk.sessions_total, 4); assert.equal(Number(pk.unit_value), 60); assert.equal(Number(pk.remaining), 4)
  const ap = await call('POST', '/api/appointments', { token: S.token, body: { professionalId: me.id, customerId: cliente.id, start: `${MON}T09:00`, services: [{ productId: corte.id, customerPackageId: pk.id }] }, headers: H() })
  assert.equal(ap.status, 200, JSON.stringify(ap.body)); assert.equal(Number(ap.body.total), 0)
  assert.equal((await call('GET', `/api/appointments/${ap.body.id}/checkout`, { token: S.token })).body.items.length, 0)
  const c1 = await call('POST', `/api/appointments/${ap.body.id}/complete`, { token: S.token, headers: H() })
  assert.equal(c1.status, 200, JSON.stringify(c1.body))
  await call('POST', `/api/appointments/${ap.body.id}/complete`, { token: S.token, headers: H() })
  const after1 = (await call('GET', `/api/customers/${cliente.id}/packages`, { token: S.token })).body[0]
  assert.equal(after1.sessions_used, 1)
  const pc = (await db.query(`SELECT amount, kind FROM professional_commissions WHERE professional_id = $1 AND kind = 'sessao_pacote'`, [me.id])).rows
  assert.equal(pc.length, 1); assert.equal(Number(pc[0].amount), 30)
  const cancel = await call('POST', `/api/sales/${sold.body.id}/cancel`, { token: S.token, body: { reason: 'Desistência do pacote' }, headers: H() })
  assert.equal(cancel.status, 409)
  // fechamento de comissões gera conta a pagar
  const close = await call('POST', '/api/professional-commissions/close', { token: S.token, body: { professionalId: me.id, from: '2000-01-01', to: '2100-01-01' }, headers: H() })
  assert.equal(close.status, 200, JSON.stringify(close.body)); assert.equal(close.body.total, 30); assert.ok(close.body.payableId)
  assert.equal((await call('POST', '/api/professional-commissions/close', { token: S.token, body: { professionalId: me.id, from: '2000-01-01', to: '2100-01-01' }, headers: H() })).status, 422)
})

test('odontologia: prontuário com consentimento e acesso auditado, odontograma e plano aprovado cobrado no crediário', async () => {
  const odId = await createCompanyWithAdmin('Clínica Odonto Teste', 'odontologia', 'admin.o@teste.local')
  const O = await login('admin.o@teste.local')
  const meO = await call('GET', '/api/auth/me', { token: O.token })
  assert.equal(meO.body.segment.terms.cliente, 'Paciente')
  for (const m of ['agenda', 'prontuario', 'odontograma']) assert.ok(meO.body.company.modules.includes(m), m)
  const crediario = (await call('GET', '/api/lookups', { token: O.token })).body.paymentMethods.find((x: any) => x.kind === 'crediario').id
  const pac = (await call('POST', '/api/customers', { token: O.token, body: { name: 'João Paciente', credit_limit: 1000 } })).body
  const tpl = await call('GET', '/api/clinical/templates', { token: O.token })
  assert.equal(tpl.body[0].id, 'odontologia')
  const noConsent = await call('POST', `/api/customers/${pac.id}/clinical-records`, { token: O.token, body: { kind: 'anamnese', data: { template: 'odontologia', answers: { hipertensao: true } } } })
  assert.equal(noConsent.status, 422)
  const an = await call('POST', `/api/customers/${pac.id}/clinical-records`, { token: O.token, body: { kind: 'anamnese', data: { template: 'odontologia', consentimento: true, answers: { hipertensao: true, alergias: 'Penicilina', diabetes: false } } } })
  assert.equal(an.status, 200, JSON.stringify(an.body))
  const clin = await call('GET', `/api/customers/${pac.id}/clinical`, { token: O.token })
  assert.equal(clin.status, 200); assert.ok(clin.body.alerts.some((a: string) => /Hipertensão/.test(a))); assert.ok(clin.body.alerts.some((a: string) => /Penicilina/.test(a)))
  assert.ok((await db.query(`SELECT 1 FROM audit_log WHERE action = 'prontuario.acesso' AND entity_id = $1`, [pac.id])).rowCount! >= 1)
  const badTooth = await call('POST', `/api/customers/${pac.id}/odontogram`, { token: O.token, body: { entries: [{ tooth: 19, condition: 'carie' }] } })
  assert.equal(badTooth.status, 422)
  await call('POST', `/api/customers/${pac.id}/odontogram`, { token: O.token, body: { entries: [{ tooth: 16, faces: ['O', 'M'], condition: 'carie', status: 'planejado' }] } })
  await call('POST', `/api/customers/${pac.id}/odontogram`, { token: O.token, body: { entries: [{ tooth: 16, faces: ['O', 'M'], condition: 'restaurado', status: 'realizado' }] } })
  const odo = await call('GET', `/api/customers/${pac.id}/odontogram`, { token: O.token })
  assert.equal(odo.body.current.length, 1); assert.equal(odo.body.current[0].condition, 'restaurado'); assert.equal(odo.body.history.length, 2)
  // plano de tratamento
  const rest = (await call('POST', '/api/services', { token: O.token, body: { kind: 'servico', name: 'Restauração em resina', sale_price: 200, duration_min: 60 } })).body
  const limp = (await call('POST', '/api/services', { token: O.token, body: { kind: 'servico', name: 'Profilaxia', sale_price: 150, duration_min: 40 } })).body
  const dr = (await call('POST', '/api/professionals/me', { token: O.token, body: { specialty: 'Clínico geral' } })).body
  await call('PUT', `/api/professionals/${dr.id}`, { token: O.token, body: { council_id: 'CRO-SP 00000', commission_services_pct: 30 } })
  const plan = await call('POST', '/api/treatment-plans', { token: O.token, body: { customerId: pac.id, title: 'Plano inicial', discount: 35, items: [{ productId: rest.id, tooth: 16, faces: ['O', 'M'] }, { productId: limp.id }] } })
  assert.equal(plan.status, 200, JSON.stringify(plan.body)); assert.equal(Number(plan.body.total), 315)
  assert.equal((await call('GET', `/api/treatment-plans/${plan.body.id}/checkout`, { token: O.token })).status, 409) // ainda não aprovado
  assert.equal((await call('POST', `/api/treatment-plans/${plan.body.id}/status`, { token: O.token, body: { status: 'aprovado' } })).status, 200)
  assert.equal((await call('PUT', `/api/treatment-plans/${plan.body.id}`, { token: O.token, body: { items: [{ productId: limp.id }] } })).status, 409)
  const co = await call('GET', `/api/treatment-plans/${plan.body.id}/checkout`, { token: O.token })
  assert.equal(co.body.items.length, 2)
  const items = co.body.items.map((i: any) => ({ planItemId: i.plan_item_id, qty: i.qty }))
  const sale = await call('POST', '/api/sales', { token: O.token, body: { customerId: pac.id, items, payments: [{ methodId: crediario, amount: 315, installments: 3 }] }, headers: H() })
  assert.equal(sale.status, 200, JSON.stringify(sale.body)); assert.equal(Number(sale.body.total), 315)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM receivables WHERE sale_id = $1 AND method_kind = 'crediario'`, [sale.body.id])).rows[0].n, 3)
  const tp = await call('GET', `/api/treatment-plans/${plan.body.id}`, { token: O.token })
  assert.equal(tp.body.status, 'em_andamento'); assert.ok(tp.body.items.every((i: any) => i.sale_id === sale.body.id))
  assert.equal(Number((await db.query(`SELECT sum(amount) AS s FROM professional_commissions WHERE sale_id = $1`, [sale.body.id])).rows[0].s), 94.5)
  const twice = await call('POST', '/api/sales', { token: O.token, body: { customerId: pac.id, items, payments: [{ methodId: crediario, amount: 315 }] }, headers: H() })
  assert.equal(twice.status, 422)
  // procedimento realizado pela agenda (sem nova cobrança) conclui o plano quando nada mais está pendente
  for (const it of tp.body.items) assert.equal((await call('POST', `/api/treatment-plans/items/${it.id}/done`, { token: O.token, body: {} })).status, 200)
  assert.equal((await call('GET', `/api/treatment-plans/${plan.body.id}`, { token: O.token })).body.status, 'concluido')
  // permissões e isolamento
  await createUser(odId, 'Recepção', 'recep.o@teste.local', 'Vendedor')
  const R = await login('recep.o@teste.local')
  assert.equal((await call('GET', `/api/customers/${pac.id}/clinical`, { token: R.token })).status, 403)
  assert.equal((await call('GET', `/api/agenda`, { token: R.token })).status, 200)
  assert.equal((await call('GET', `/api/customers/${pac.id}/clinical`, { token: S.token })).status, 404)
  assert.equal((await call('GET', `/api/treatment-plans/${plan.body.id}`, { token: S.token })).status, 404)
})

test('estética e inteligência de serviços: retorno vencido, ocupação e descobertas', async () => {
  await createCompanyWithAdmin('Estética Teste', 'estetica', 'admin.e@teste.local')
  const E = await login('admin.e@teste.local')
  const meE = await call('GET', '/api/auth/me', { token: E.token })
  assert.equal(meE.body.segment.id, 'estetica'); assert.equal(meE.body.segment.terms.prontuario, 'Ficha de avaliação')
  const intel = await call('GET', '/api/service-intelligence', { token: S.token })
  assert.equal(intel.status, 200, JSON.stringify(intel.body))
  assert.ok(Array.isArray(intel.body.professionals) && intel.body.professionals.length >= 2)
  assert.ok(Array.isArray(intel.body.insights))
  // retorno: corte (30 dias) realizado há 40 dias e sem horário futuro
  const cu = (await call('POST', '/api/customers', { token: S.token, body: { name: 'Cliente Sumida', whatsapp: '11977776666' } })).body
  await db.query(`INSERT INTO appointments(company_id, branch_id, number, professional_id, customer_id, start_at, end_at, status, completed_at)
                  SELECT company_id, branch_id, 9001, $2, $3, now() - interval '40 days', now() - interval '40 days' + interval '1 hour', 'concluido', now() - interval '40 days'
                    FROM appointments WHERE professional_id = $2 AND company_id = $1 LIMIT 1`, [salonId, me.id, cu.id])
  const apId = (await db.query(`SELECT id FROM appointments WHERE number = 9001 AND company_id = $1`, [salonId])).rows[0].id
  await db.query(`INSERT INTO appointment_services(appointment_id, company_id, product_id, variant_id, professional_id, duration_min, price, status) VALUES ($1,$2,$3,$4,$5,60,80,'realizado')`,
    [apId, salonId, corte.id, corte.variant_id, me.id])
  const intel2 = await call('GET', '/api/service-intelligence', { token: S.token })
  const due = intel2.body.returnsDue.find((r: any) => r.customer_id === cu.id)
  assert.ok(due, JSON.stringify(intel2.body.returnsDue)); assert.equal(due.interval_days, 30); assert.ok(due.overdue_days >= 9)
  // lembrete sem consentimento não é enviado
  const remind = await call('POST', `/api/appointments/${apId}/remind`, { token: S.token })
  assert.equal(remind.status, 200); assert.equal(remind.body.status, 'bloqueado_sem_consentimento')
})
