import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, teardown, call, login, db, createCompanyWithAdmin, createUser } from './helpers'

/**
 * Clínica de saúde multiprofissional: perfis de recepção e gerência sem acesso clínico, conselho profissional,
 * sigilo de prontuário (psicologia), atendimento por convênio virando guia (e não cobrança no PDV), lote, retorno com glosa,
 * repasse do profissional, documentos clínicos emitidos pelo próprio profissional e painel.
 */
const key = () => 'k-' + Math.random().toString(36).slice(2) + Date.now()
const H = () => ({ 'idempotency-key': key() })
function nextMonday() { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d.toISOString().slice(0, 10) }
const MON = nextMonday()
let S: { token: string; companyId: string; branchId: string }
let R: string, G: string, P: string
let cid: string
let dr: any, psi: any, consulta: any, sessao: any, unimed: any, pac: any, ap: any

before(async () => {
  await setup()
  cid = await createCompanyWithAdmin('Clínica Vida Teste', 'saude', 'admin.sa@teste.local')
  S = await login('admin.sa@teste.local')
  await createUser(cid, 'Recepcionista Teste', 'recep.sa@teste.local', 'Recepcionista')
  await createUser(cid, 'Gerente Teste', 'ger.sa@teste.local', 'Gerente da clínica')
  const psiUser = await createUser(cid, 'Psicóloga Teste', 'psi.sa@teste.local', 'Profissional')
  R = (await login('recep.sa@teste.local')).token
  G = (await login('ger.sa@teste.local')).token
  P = (await login('psi.sa@teste.local')).token
  psi = (await call('POST', '/api/professionals', { token: S.token, body: { name: 'Psicóloga Teste', specialty: 'Psicologia', council: 'CRP', council_number: '06/123456', council_uf: 'SP', restrict_records: true, user_id: psiUser, commission_services_pct: 60 } })).body
  assert.ok(psi.id, JSON.stringify(psi))
})
after(teardown)

test('segmento saúde: módulos, vocabulário, perfis e conselho profissional', async () => {
  const me = await call('GET', '/api/auth/me', { token: S.token })
  assert.equal(me.body.segment.id, 'saude'); assert.equal(me.body.segment.terms.cliente, 'Paciente')
  for (const m of ['agenda', 'prontuario', 'saude']) assert.ok(me.body.company.modules.includes(m), m)
  const roles = (await db.query(`SELECT name, permissions FROM roles WHERE company_id = $1`, [cid])).rows
  const recep = roles.find((r: any) => r.name === 'Recepcionista'); const ger = roles.find((r: any) => r.name === 'Gerente da clínica')
  assert.ok(recep && ger)
  for (const r of [recep, ger]) assert.ok(!r.permissions.some((p: string) => p.startsWith('prontuario.')), r.name + ' não pode ter acesso clínico')
  assert.equal(psi.council_id, 'CRP-SP 06/123456'); assert.equal(psi.restrict_records, true)
  dr = (await call('POST', '/api/professionals/me', { token: S.token, body: { specialty: 'Clínica médica' } })).body
  const up = await call('PUT', `/api/professionals/${dr.id}`, { token: S.token, body: { council: 'CRM', council_number: '123456', council_uf: 'SP', commission_services_pct: 50 } })
  assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.council_id, 'CRM-SP 123456')
  const cat = await call('GET', '/api/health/catalog', { token: R })
  assert.ok(cat.body.councils.includes('CREFITO') && cat.body.documentKinds.length === 8)
  consulta = (await call('POST', '/api/services', { token: S.token, body: { kind: 'servico', name: 'Consulta clínica', sale_price: 300, duration_min: 30 } })).body
  sessao = (await call('POST', '/api/services', { token: S.token, body: { kind: 'servico', name: 'Sessão de psicoterapia', sale_price: 200, duration_min: 50 } })).body
  assert.ok(consulta.id && sessao.id)
})

test('convênio, tabela de preços e perfil do paciente (campos clínicos só para profissional)', async () => {
  assert.equal((await call('POST', '/api/insurers', { token: R, body: { name: 'X' + 'y' } })).status, 403)
  const bad = await call('POST', '/api/insurers', { token: G, body: { name: 'Plano Teste', cnpj: '11.111.111/1111-11' } })
  assert.equal(bad.status, 422)
  const ins = await call('POST', '/api/insurers', { token: G, body: { name: 'Plano Saúde Teste', ansCode: '000000', paymentDays: 30, requiresAuthorization: true } })
  assert.equal(ins.status, 200, JSON.stringify(ins.body)); unimed = ins.body
  assert.equal((await call('POST', '/api/insurers', { token: G, body: { name: 'plano saúde teste' } })).status, 409)
  const pr = await call('PUT', `/api/insurers/${unimed.id}/prices`, { token: G, body: { items: [{ productId: consulta.id, price: 180, tussCode: '10101012' }] } })
  assert.equal(pr.status, 200); assert.equal(pr.body.saved, 1)
  const tab = await call('GET', `/api/insurers/${unimed.id}/prices`, { token: R })
  assert.equal(Number(tab.body.items.find((i: any) => i.product_id === consulta.id).price), 180)

  pac = (await call('POST', '/api/customers', { token: R, body: { name: 'Maria Paciente', whatsapp: '11966665555' } })).body
  assert.ok(pac.id)
  // recepção cadastra convênio e responsável, mas não informações clínicas
  const prof = await call('PUT', `/api/patients/${pac.id}/profile`, { token: R, body: { socialName: 'Mari', insurerId: unimed.id, insuranceCard: '0001234', emergencyName: 'João', emergencyPhone: '11955554444' } })
  assert.equal(prof.status, 200, JSON.stringify(prof.body))
  assert.equal((await call('PUT', `/api/patients/${pac.id}/profile`, { token: R, body: { allergies: 'Dipirona' } })).status, 403)
  assert.equal((await call('PUT', `/api/patients/${pac.id}/profile`, { token: S.token, body: { allergies: 'Dipirona', bloodType: 'O+' } })).status, 200)
  const vr = await call('GET', `/api/patients/${pac.id}/profile`, { token: R })
  assert.equal(vr.body.profile.insurance_card, '0001234'); assert.equal(vr.body.profile.allergies, undefined); assert.equal(vr.body.clinicalVisible, false)
  const vs = await call('GET', `/api/patients/${pac.id}/profile`, { token: S.token })
  assert.equal(vs.body.profile.allergies, 'Dipirona'); assert.equal(vs.body.customer.social_name, 'Mari')
})

test('recepção: agendamento por convênio, chegada, chamada e conclusão vira guia (sem cobrança no PDV)', async () => {
  const r = await call('POST', '/api/appointments', { token: R, headers: H(), body: { professionalId: dr.id, customerId: pac.id, start: `${MON}T09:00`, services: [{ productId: consulta.id }], payer: 'convenio', visitType: 'primeira' } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); ap = r.body
  const d = await call('GET', `/api/appointments/${ap.id}`, { token: R })
  assert.equal(d.body.payer, 'convenio'); assert.equal(d.body.insurer_name, 'Plano Saúde Teste'); assert.equal(d.body.insurance_card, '0001234')
  // convênio exige paciente cadastrado
  const guest = await call('POST', '/api/appointments', { token: R, headers: H(), body: { professionalId: dr.id, guestName: 'Sem cadastro', start: `${MON}T11:00`, services: [{ productId: consulta.id }], payer: 'convenio', insurerId: unimed.id } })
  assert.equal(guest.status, 422)
  const arr = await call('POST', `/api/appointments/${ap.id}/arrive`, { token: R, body: {} })
  assert.equal(arr.status, 200); assert.equal(arr.body.status, 'confirmado'); assert.ok(arr.body.arrived_at)
  const rec = await call('GET', `/api/reception?date=${MON}`, { token: R })
  const row = rec.body.items.find((x: any) => x.id === ap.id)
  assert.ok(row); assert.equal(row.insurer_name, 'Plano Saúde Teste'); assert.equal(row.payer, 'convenio')
  assert.equal((await call('POST', `/api/appointments/${ap.id}/status`, { token: S.token, body: { status: 'em_atendimento' } })).status, 200)
  // checkout no PDV não cobra procedimento de convênio
  const co = await call('GET', `/api/appointments/${ap.id}/checkout`, { token: S.token })
  assert.equal(co.status, 200); assert.equal(co.body.items.length, 0)
  const asItem = await call('POST', '/api/sales', { token: S.token, headers: H(), body: { customerId: pac.id, items: [{ appointmentServiceId: d.body.services[0].id, qty: 1 }], payments: [] } })
  assert.equal(asItem.status, 422)
  const done = await call('POST', `/api/appointments/${ap.id}/complete`, { token: S.token, headers: H(), body: {} })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  const claims = (await call('GET', '/api/insurance-claims?status=a_faturar', { token: G })).body
  assert.equal(claims.items.length, 1); assert.equal(Number(claims.items[0].amount), 180); assert.equal(claims.items[0].tuss_code, '10101012')
  // concluir de novo não duplica a guia
  await call('POST', `/api/appointments/${ap.id}/complete`, { token: S.token, headers: H(), body: {} })
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM insurance_claims WHERE appointment_id = $1`, [ap.id])).rows[0].n, 1)
})

test('faturamento: lote exige autorização, retorno com glosa parcial entra no financeiro e gera repasse', async () => {
  const claim = (await call('GET', '/api/insurance-claims?status=a_faturar', { token: G })).body.items[0]
  assert.equal((await call('POST', '/api/insurance-batches', { token: G, body: { insurerId: unimed.id, claimIds: [claim.id] } })).status, 422) // sem autorização
  assert.equal((await call('PUT', `/api/insurance-claims/${claim.id}`, { token: G, body: { authorizationCode: 'AUT-999', guideNumber: 'G-1' } })).status, 200)
  const b = await call('POST', '/api/insurance-batches', { token: G, body: { insurerId: unimed.id, claimIds: [claim.id], protocol: 'PROT-1' } })
  assert.equal(b.status, 200, JSON.stringify(b.body)); assert.equal(Number(b.body.total), 180)
  assert.equal((await call('POST', '/api/insurance-batches', { token: G, body: { insurerId: unimed.id, claimIds: [claim.id] } })).status, 422) // já enviada
  assert.equal((await call('POST', '/api/insurance-claims/settle', { token: G, body: { items: [{ claimId: claim.id, paidAmount: 150 }] } })).status, 422) // glosa sem motivo
  assert.equal((await call('POST', '/api/insurance-claims/settle', { token: G, body: { items: [{ claimId: claim.id, paidAmount: 200 }] } })).status, 422) // maior que o faturado
  const st = await call('POST', '/api/insurance-claims/settle', { token: G, body: { items: [{ claimId: claim.id, paidAmount: 150, glossReason: 'Valor acima da tabela' }] } })
  assert.equal(st.status, 200, JSON.stringify(st.body)); assert.equal(st.body.received, 150)
  const batch = (await call('GET', '/api/insurance-batches', { token: G })).body[0]
  assert.equal(batch.status, 'pago'); assert.equal(Number(batch.paid_total), 150); assert.equal(Number(batch.gloss_total), 30)
  const ft = (await db.query(`SELECT amount FROM financial_transactions WHERE source_type = 'convenio_guia' AND source_id = $1`, [claim.id])).rows
  assert.equal(ft.length, 1); assert.equal(Number(ft[0].amount), 150)
  const com = (await db.query(`SELECT amount FROM professional_commissions WHERE ref_type = 'convenio' AND ref_key = $1`, ['claim:' + claim.id])).rows
  assert.equal(com.length, 1); assert.equal(Number(com[0].amount), 75)
  // repetir o retorno não lança de novo
  assert.equal((await call('POST', '/api/insurance-claims/settle', { token: G, body: { items: [{ claimId: claim.id, paidAmount: 150, glossReason: 'x'.repeat(5) }] } })).status, 422)
  const sum = await call('GET', '/api/health/summary?days=30', { token: G })
  assert.equal(sum.status, 200, JSON.stringify(sum.body)); assert.equal(sum.body.insurance.received, 150); assert.equal(sum.body.insurance.glossPct, 16.67)
})

test('prontuário: recepção e gerente sem acesso; registro sigiloso da psicóloga invisível aos demais; retificação só pelo autor', async () => {
  assert.equal((await call('GET', `/api/customers/${pac.id}/clinical`, { token: R })).status, 403)
  assert.equal((await call('GET', `/api/customers/${pac.id}/clinical`, { token: G })).status, 403)
  const c1 = await call('POST', `/api/customers/${pac.id}/clinical-records`, { token: S.token, body: { kind: 'consulta', title: 'Consulta', content: 'S: cefaleia. O: bom estado geral. A: cefaleia tensional. P: analgesia.', cidCodes: ['G44.2'],
    vitals: { pas: 120, pad: 80, peso: 70, altura: 170 } } })
  assert.equal(c1.status, 200, JSON.stringify(c1.body)); assert.equal(c1.body.visibility, 'equipe'); assert.ok(c1.body.content_hash)
  assert.equal(Number(c1.body.vitals.imc), 24.2)
  assert.equal((await call('POST', `/api/customers/${pac.id}/clinical-records`, { token: S.token, body: { kind: 'consulta', content: 'x', cidCodes: ['ZZZ'] } })).status, 422)
  const s1 = await call('POST', `/api/customers/${pac.id}/clinical-records`, { token: P, body: { kind: 'sessao', title: 'Sessão 1', content: 'Conteúdo sigiloso da sessão.' } })
  assert.equal(s1.status, 200, JSON.stringify(s1.body)); assert.equal(s1.body.visibility, 'restrito')
  const byAdmin = await call('GET', `/api/customers/${pac.id}/clinical`, { token: S.token })
  assert.ok(!byAdmin.body.records.some((r: any) => r.id === s1.body.id)); assert.equal(byAdmin.body.hiddenRecords, 1)
  assert.ok(byAdmin.body.alerts.some((a: string) => /Dipirona/.test(a)))
  const byPsi = await call('GET', `/api/customers/${pac.id}/clinical`, { token: P })
  assert.ok(byPsi.body.records.some((r: any) => r.id === s1.body.id))
  // só o autor retifica o registro sigiloso
  assert.equal((await call('POST', `/api/customers/${pac.id}/clinical-records`, { token: S.token, body: { kind: 'sessao', content: 'Retificação', amendsId: s1.body.id } })).status, 403)
  const am = await call('POST', `/api/customers/${pac.id}/clinical-records`, { token: P, body: { kind: 'sessao', content: 'Retificação do autor', amendsId: s1.body.id, visibility: 'equipe' } })
  assert.equal(am.status, 200, JSON.stringify(am.body)); assert.equal(am.body.visibility, 'restrito')
})

test('documentos clínicos: emitidos pelo próprio profissional com conselho; CID no atestado só com autorização; cancelar sem apagar', async () => {
  const rx = await call('POST', `/api/customers/${pac.id}/clinical-documents`, { token: S.token, body: { kind: 'receita', appointmentId: ap.id, content: { items: [{ name: 'Paracetamol 750 mg', dose: '1 comprimido de 6/6h se dor', qty: '1 caixa' }] } } })
  assert.equal(rx.status, 200, JSON.stringify(rx.body)); assert.equal(rx.body.number, 1)
  assert.equal((await call('POST', `/api/customers/${pac.id}/clinical-documents`, { token: S.token, body: { kind: 'receita', content: { items: [] } } })).status, 422)
  assert.equal((await call('POST', `/api/customers/${pac.id}/clinical-documents`, { token: S.token, body: { kind: 'atestado', content: { days: 2, cid: 'G44.2' } } })).status, 422)
  const at = await call('POST', `/api/customers/${pac.id}/clinical-documents`, { token: S.token, body: { kind: 'atestado', content: { days: 2, cid: 'g44.2', cidConsent: true } } })
  assert.equal(at.status, 200); assert.equal(at.body.content.cid, 'G44.2')
  // recepção não emite nem vê
  assert.equal((await call('POST', `/api/customers/${pac.id}/clinical-documents`, { token: R, body: { kind: 'declaracao', content: {} } })).status, 403)
  assert.equal((await call('GET', `/api/clinical-documents/${rx.body.id}`, { token: R })).status, 403)
  // profissional sem registro no conselho não emite receita
  await db.query(`UPDATE professionals SET council_number = NULL, council_id = NULL WHERE id = $1`, [psi.id])
  assert.equal((await call('POST', `/api/customers/${pac.id}/clinical-documents`, { token: P, body: { kind: 'laudo', content: { text: 'Relatório' } } })).status, 422)
  await db.query(`UPDATE professionals SET council_number = '06/123456', council_id = 'CRP-SP 06/123456' WHERE id = $1`, [psi.id])
  const lau = await call('POST', `/api/customers/${pac.id}/clinical-documents`, { token: P, body: { kind: 'laudo', content: { text: 'Relatório psicológico.' } } })
  assert.equal(lau.status, 200); assert.equal(lau.body.visibility, 'restrito')
  assert.equal((await call('GET', `/api/clinical-documents/${lau.body.id}`, { token: S.token })).status, 403)
  const pr = await call('GET', `/api/clinical-documents/${rx.body.id}`, { token: S.token })
  assert.equal(pr.status, 200); assert.equal(pr.body.council_id, 'CRM-SP 123456'); assert.equal(pr.body.verification.length, 16); assert.equal(pr.body.label, 'Receituário')
  // só quem emitiu cancela; o documento continua no histórico
  assert.equal((await call('POST', `/api/clinical-documents/${rx.body.id}/cancel`, { token: P, body: { reason: 'Engano' } })).status, 403)
  assert.equal((await call('POST', `/api/clinical-documents/${rx.body.id}/cancel`, { token: S.token, body: { reason: 'Dose errada' } })).status, 200)
  const list = await call('GET', `/api/customers/${pac.id}/clinical-documents`, { token: S.token })
  assert.ok(list.body.find((d: any) => d.id === rx.body.id).cancelled_at)
  assert.ok(!list.body.some((d: any) => d.id === lau.body.id))
})
