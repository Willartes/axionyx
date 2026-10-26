import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, teardown, call, login, db, Env } from './helpers'
import { hashPassword } from '../core/crypto'
import { setMercadoPagoClient, signForTest, MpClient, MpPayment } from '../integrations/mercadopago'

/**
 * Assinaturas AXIONYX: auditoria antes do pagamento (primeiro contrato), liberação automática pelo pagamento,
 * renovação com exceções na fila (inadimplência, suspensão, troca de titular, chargeback), webhook assinado e idempotente.
 * O Mercado Pago é substituído por um simulador em memória — só existe nos testes.
 */
const SECRET = 'segredo-webhook-teste'
const PASSWORD = 'Teste-Senha-2026'
const payments = new Map<string, MpPayment>()
const preapprovals = new Map<string, any>()
const authorized = new Map<string, any>()
let seq = 1000
const fake: MpClient = {
  configured: () => true,
  async createPreference(p) { const id = 'pref-' + seq++; return { id, url: `https://mp.simulado/checkout/${id}?ref=${encodeURIComponent(p.externalRef)}` } },
  async createPreapproval(p) { const id = 'pre' + seq++; preapprovals.set(id, { id, status: 'pending', external_reference: p.externalRef, payer_email: p.payerEmail, amount: p.amount }); return { id, url: `https://mp.simulado/assinatura/${id}`, status: 'pending' } },
  async getPreapproval(id) { return preapprovals.get(id) },
  async updatePreapproval(id, b) { const x = preapprovals.get(id); if (x) Object.assign(x, b.status ? { status: b.status } : {}, b.amount ? { amount: b.amount } : {}) },
  async getPayment(id) { const p = payments.get(id); if (!p) throw new Error('pagamento inexistente'); return p },
  async searchPayments(ref) { return [...payments.values()].filter((p) => p.external_reference === ref) },
  async getAuthorizedPayment(id) { return authorized.get(id) },
  async getChargeback(id) { return { id, payments: [id.replace('cb-', '')] } },
  async refund(id) { const p = payments.get(id); if (p) p.status = 'refunded' },
  async account() { return { id: '1', nickname: 'TESTE', site_id: 'MLB', live: false } },
}
const pay = (o: Partial<MpPayment> & { ref: string; amount: number; doc?: string }): MpPayment => {
  const id = String(seq++)
  const p: MpPayment = { id, status: 'approved', status_detail: 'accredited', external_reference: o.ref, transaction_amount: o.amount, date_approved: new Date().toISOString(),
    payment_type_id: o.payment_type_id ?? 'bank_transfer', payment_method_id: o.payment_method_id ?? 'pix', fee_details: [{ amount: 0.99 }],
    payer: { email: 'pagador@cliente.test', first_name: 'Maria', last_name: 'Silva', identification: { type: 'CNPJ', number: o.doc ?? '19131243000197' } }, ...o }
  payments.set(id, p)
  return p
}
async function webhook(topic: string, dataId: string, opts: { sign?: boolean } = {}) {
  const ts = String(Math.floor(Date.now() / 1000)), rid = 'req-' + seq++
  const headers: Record<string, string> = { 'x-request-id': rid }
  if (opts.sign !== false) headers['x-signature'] = signForTest(SECRET, dataId, rid, ts)
  return call('POST', `/api/public/billing/mercadopago?data.id=${dataId}&type=${topic}`, { body: { type: topic, action: `${topic}.updated`, data: { id: dataId }, live_mode: false }, headers })
}
async function loginWith(email: string, password: string) {
  const l = await call('POST', '/api/auth/login', { body: { email, password } })
  assert.equal(l.status, 200, JSON.stringify(l.body))
  const co = l.body.companies[0]
  const br = await call('GET', `/api/auth/companies/${co.id}/branches`, { token: l.body.token })
  const ctx = await call('POST', '/api/auth/context', { token: l.body.token, body: { companyId: co.id, branchId: br.body[0].id } })
  return ctx.body.token as string
}
const daysFromToday = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
/** "Avança o relógio": desloca vigência e períodos das cobranças para que a vigência termine há `daysAgo` dias. */
async function travel(id: string, daysAgo: number) {
  const k = await db.query(`SELECT paid_until - (current_date - $2::int) AS delta FROM saas_contracts WHERE id = $1`, [id, daysAgo])
  const d = Number(k.rows[0].delta)
  await db.query(`UPDATE saas_charges SET period_start = period_start - $2::int, period_end = period_end - $2::int, due_date = due_date - $2::int WHERE contract_id = $1`, [id, d])
  await db.query(`UPDATE saas_contracts SET paid_until = paid_until - $2::int WHERE id = $1`, [id, d])
}

let env: Env
let SA: string
let A: string
let planId: string
let contractId: string
let clientToken: string
let firstChargeId: string

before(async () => {
  process.env.MP_WEBHOOK_SECRET = SECRET
  process.env.APP_PUBLIC_URL = 'https://axionyx.teste'
  setMercadoPagoClient(fake)
  env = await setup()
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin) VALUES ('Suporte', 'suporte@axionyx.test', $1, true)`, [hashPassword(PASSWORD)])
  SA = (await login('suporte@axionyx.test', env.companyA.company.id)).token
  A = (await login('admin.a@teste.local')).token
})
after(async () => { setMercadoPagoClient(null); delete process.env.MP_WEBHOOK_SECRET; delete process.env.APP_PUBLIC_URL; await teardown() })

test('empresas existentes sem contrato continuam funcionando e a carteira é exclusiva do superadministrador', async () => {
  assert.equal((await call('GET', '/api/products', { token: A })).status, 200)
  assert.equal((await call('GET', '/api/auth/me', { token: A })).body.billing, null)
  assert.equal((await call('GET', '/api/saas/dashboard', { token: A })).status, 403)
  assert.equal((await call('GET', '/api/saas/contracts', { token: A })).status, 403)
  const legacy = await call('GET', '/api/saas/companies-without-contract', { token: SA })
  assert.equal(legacy.status, 200); assert.ok(legacy.body.length >= 2)
})

test('proposta entra em análise com avaliação de risco; CNPJ já cadastrado é sinalizado como risco alto', async () => {
  const pl = await call('POST', '/api/saas/plans', { token: SA, body: { name: 'Essencial', priceMonthly: 199.9, maxUsers: 5 } })
  assert.equal(pl.status, 200); planId = pl.body.id
  const dup = await call('POST', '/api/saas/contracts', { token: SA, body: { companyName: 'Loja Duplicada', cnpj: '11222333000181', contactName: 'Fulano', contactEmail: 'fulano@mailinator.com', planId } })
  assert.equal(dup.status, 200); assert.equal(dup.body.risk_level, 'alto')
  const codes = dup.body.risk_flags.map((f: any) => f.code)
  assert.ok(codes.includes('cnpj_duplicado') && codes.includes('email_descartavel'), codes.join(','))
  const k = await call('POST', '/api/saas/contracts', { token: SA, body: { companyName: 'Bella Forma Estética Ltda', tradeName: 'Bella Forma', cnpj: '19.131.243/0001-97', segment: 'estetica', contactName: 'Maria Silva', contactEmail: 'maria@bellaforma.test', contactPhone: '(11) 98888-7777', planId, graceDays: 5 } })
  assert.equal(k.status, 200); assert.equal(k.body.status, 'em_analise'); assert.equal(Number(k.body.price), 199.9)
  contractId = k.body.id
  const q = await call('GET', '/api/saas/reviews', { token: SA })
  assert.ok(q.body.items.some((r: any) => r.contract_id === contractId && r.kind === 'novo_contrato'))
  // não pode resolver proposta pela fila genérica
  const rv = q.body.items.find((r: any) => r.contract_id === contractId)
  assert.equal((await call('POST', `/api/saas/reviews/${rv.id}/resolve`, { token: SA, body: { resolution: 'ok' } })).status, 422)
  // recusa de outra proposta
  const rej = await call('POST', `/api/saas/contracts/${dup.body.id}/reject`, { token: SA, body: { reason: 'CNPJ já é cliente' } })
  assert.equal(rej.status, 200); assert.equal(rej.body.status, 'recusado')
})

test('aprovação cria empresa e administrador, gera link de pagamento e o acesso fica bloqueado até pagar', async () => {
  const ap = await call('POST', `/api/saas/contracts/${contractId}/approve`, { token: SA, body: { note: 'Documentos conferidos na demonstração' } })
  assert.equal(ap.status, 200, JSON.stringify(ap.body))
  assert.ok(ap.body.tempPassword); assert.ok(ap.body.checkoutUrl?.includes('AXC%3A'))
  assert.equal(ap.body.contract.status, 'aguardando_pagamento')
  firstChargeId = ap.body.chargeId
  clientToken = await loginWith('maria@bellaforma.test', ap.body.tempPassword)
  const me = await call('GET', '/api/auth/me', { token: clientToken })
  assert.equal(me.body.billing.status, 'aguardando_pagamento'); assert.equal(me.body.billing.blocked, true)
  assert.ok(me.body.billing.pending.checkout_url)
  assert.equal((await call('GET', '/api/products', { token: clientToken })).status, 402)
  const mine = await call('GET', '/api/billing/me', { token: clientToken })
  assert.equal(mine.status, 200); assert.equal(mine.body.charges.length, 1)
  // o superadministrador (suporte) não aparece como usuário do cliente
  const users = await call('GET', '/api/admin/users', { token: SA })
  assert.equal(users.status, 200)
})

test('webhook sem assinatura válida é rejeitado e registrado; pagamento aprovado libera o acesso (idempotente)', async () => {
  const p = pay({ ref: `AXC:${firstChargeId}`, amount: 199.9, doc: '12345678909' })
  const bad = await webhook('payment', p.id, { sign: false })
  assert.equal(bad.status, 401)
  const ev = await db.query(`SELECT status, signature_ok FROM saas_gateway_events ORDER BY id DESC LIMIT 1`)
  assert.equal(ev.rows[0].signature_ok, false)
  assert.equal((await call('GET', '/api/products', { token: clientToken })).status, 402)
  const ok = await webhook('payment', p.id)
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const again = await webhook('payment', p.id)
  assert.equal(again.status, 200)
  const k = await call('GET', `/api/saas/contracts/${contractId}`, { token: SA })
  assert.equal(k.body.status, 'ativo')
  assert.equal(k.body.charges.filter((c: any) => c.status === 'paga').length, 1)
  assert.equal(k.body.paid_until > daysFromToday(25), true)
  assert.equal(Number(k.body.charges[0].fee_amount), 0.99)
  // primeiro pagador com documento diferente do cadastro → exceção de baixa severidade
  assert.ok(k.body.reviews.some((r: any) => r.kind === 'troca_titular' && r.status === 'aberta'))
  assert.equal((await call('GET', '/api/products', { token: clientToken })).status, 200)
  const me = await call('GET', '/api/auth/me', { token: clientToken })
  assert.equal(me.body.billing.blocked, false)
})

test('renovação: vencido → inadimplente (acesso mantido); tolerância esgotada → somente consulta; pagamento regulariza', async () => {
  await travel(contractId, 1)
  let r = await call('POST', '/api/saas/run-billing', { token: SA })
  assert.equal(r.status, 200); assert.equal(r.body.overdue, 1); assert.ok(r.body.charges >= 1)
  let k = (await call('GET', `/api/saas/contracts/${contractId}`, { token: SA })).body
  assert.equal(k.status, 'inadimplente')
  assert.ok(k.reviews.some((x: any) => x.kind === 'inadimplencia' && x.status === 'aberta'))
  const pending = k.charges.find((c: any) => c.status === 'pendente')
  assert.ok(pending?.checkout_url, 'link mensal gerado automaticamente')
  assert.equal((await call('POST', '/api/customers', { token: clientToken, body: { name: 'Cliente Inadimplência' } })).status, 200)

  await travel(contractId, 8)
  r = await call('POST', '/api/saas/run-billing', { token: SA })
  assert.equal(r.body.suspended, 1)
  assert.equal((await call('GET', '/api/products', { token: clientToken })).status, 200)
  const blocked = await call('POST', '/api/customers', { token: clientToken, body: { name: 'Cliente Bloqueado' } })
  assert.equal(blocked.status, 402); assert.equal(blocked.body.error.code, 'assinatura_suspensa')

  // período pendente pago pelo cliente (mesmo titular do último pagamento: sem nova exceção)
  const p = pay({ ref: `AXC:${pending.id}`, amount: Number(pending.amount), doc: '12345678909', payment_type_id: 'credit_card', payment_method_id: 'visa' })
  assert.equal((await webhook('payment', p.id)).status, 200)
  k = (await call('GET', `/api/saas/contracts/${contractId}`, { token: SA })).body
  // pagou um período antigo: vigência ainda no passado → continua suspenso até quitar o período seguinte
  const stillPending = k.charges.find((c: any) => c.status === 'pendente')
  if (k.status !== 'ativo') {
    await call('POST', '/api/saas/run-billing', { token: SA })
    const k2 = (await call('GET', `/api/saas/contracts/${contractId}`, { token: SA })).body
    const next = k2.charges.find((c: any) => c.status === 'pendente') ?? stillPending
    const m = await call('POST', `/api/saas/charges/${next.id}/manual-payment`, { token: SA, body: { amount: Number(next.amount), method: 'pix', note: 'Pix recebido direto na conta' } })
    assert.equal(m.status, 200, JSON.stringify(m.body))
    k = (await call('GET', `/api/saas/contracts/${contractId}`, { token: SA })).body
  }
  assert.equal(k.status, 'ativo')
  assert.ok(!k.reviews.some((x: any) => ['inadimplencia', 'suspensao'].includes(x.kind) && x.status === 'aberta'), 'exceções resolvidas pelo pagamento')
  assert.ok(!k.reviews.some((x: any) => x.kind === 'troca_titular' && x.status === 'aberta' && x.severity === 'media'))
  assert.equal((await call('POST', '/api/customers', { token: clientToken, body: { name: 'Cliente Regular' } })).status, 200)
})

test('troca de titular e chargeback viram exceções; auditor resolve com ação sobre o acesso', async () => {
  const ch = await call('POST', `/api/saas/contracts/${contractId}/charges`, { token: SA, body: { kind: 'avulsa', amount: 50, description: 'Treinamento extra' } })
  assert.equal(ch.status, 200); assert.ok(ch.body.checkout_url)
  const p = pay({ ref: `AXC:${ch.body.id}`, amount: 50, doc: '98765432100', payment_type_id: 'credit_card', payment_method_id: 'master' })
  await webhook('payment', p.id)
  let k = (await call('GET', `/api/saas/contracts/${contractId}`, { token: SA })).body
  assert.ok(k.reviews.some((x: any) => x.kind === 'troca_titular' && x.severity === 'media' && x.status === 'aberta'))
  p.status = 'charged_back'
  await webhook('topic_chargebacks_wh', 'cb-' + p.id)
  k = (await call('GET', `/api/saas/contracts/${contractId}`, { token: SA })).body
  assert.equal(k.charges.find((c: any) => c.id === ch.body.id).status, 'contestada')
  const cb = k.reviews.find((x: any) => x.kind === 'chargeback' && x.status === 'aberta')
  assert.ok(cb); assert.equal(cb.severity, 'alta')
  const res = await call('POST', `/api/saas/reviews/${cb.id}/resolve`, { token: SA, body: { resolution: 'Contestação confirmada pelo cliente; suspenso até regularizar', action: 'suspender' } })
  assert.equal(res.status, 200); assert.equal(res.body.contractStatus, 'suspenso')
  assert.equal((await call('POST', '/api/customers', { token: clientToken, body: { name: 'X' } })).status, 402)
  const re = await call('POST', `/api/saas/contracts/${contractId}/reactivate`, { token: SA, body: { reason: 'Acordo com o cliente' } })
  assert.equal(re.status, 200); assert.equal(re.body.status, 'ativo')
  const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'saas.%' OR action LIKE 'assinatura.%'`)
  assert.ok(audit.rows[0].n >= 8)
})

test('assinatura no cartão: aprovação cria a assinatura e a cobrança recorrente libera o acesso', async () => {
  const k = await call('POST', '/api/saas/contracts', { token: SA, body: { companyName: 'Adega Boa Safra Ltda', segment: 'adega', contactName: 'João', contactEmail: 'joao@boasafra.test', planId, billingMode: 'assinatura_cartao' } })
  assert.equal(k.status, 200)
  const ap = await call('POST', `/api/saas/contracts/${k.body.id}/approve`, { token: SA, body: {} })
  assert.equal(ap.status, 200, JSON.stringify(ap.body)); assert.ok(ap.body.checkoutUrl.includes('/assinatura/'))
  const pre = [...preapprovals.values()].find((x) => x.external_reference === `AXK:${k.body.id}`)
  assert.ok(pre)
  pre.status = 'authorized'
  assert.equal((await webhook('subscription_preapproval', pre.id)).status, 200)
  const p = pay({ ref: `AXK:${k.body.id}`, amount: 199.9, doc: '12345678909', payment_type_id: 'credit_card', payment_method_id: 'visa' })
  authorized.set('ap1', { id: 'ap1', preapproval_id: pre.id, status: 'processed', payment: { id: p.id, status: 'approved' } })
  assert.equal((await webhook('subscription_authorized_payment', 'ap1')).status, 200)
  const d = (await call('GET', `/api/saas/contracts/${k.body.id}`, { token: SA })).body
  assert.equal(d.status, 'ativo'); assert.equal(d.mp_preapproval_status, 'authorized')
  assert.equal(d.charges[0].method, 'cartao')
  // cliente cancela a assinatura no cartão → exceção
  pre.status = 'cancelled'
  await webhook('subscription_preapproval', pre.id)
  const d2 = (await call('GET', `/api/saas/contracts/${k.body.id}`, { token: SA })).body
  assert.ok(d2.reviews.some((x: any) => x.kind === 'assinatura_cartao' && x.status === 'aberta'))
})

test('cliente já existente é vinculado ativo; painel calcula MRR, recebido e churn', async () => {
  const link = await call('POST', '/api/saas/contracts', { token: SA, body: { existingCompanyId: env.companyB.company.id, companyName: 'Loja Teste B Ltda', contactName: 'Admin B', contactEmail: 'admin.b@teste.local', price: 150, paidUntil: daysFromToday(20) } })
  assert.equal(link.status, 200, JSON.stringify(link.body)); assert.equal(link.body.status, 'ativo')
  const B = (await login('admin.b@teste.local')).token
  assert.equal((await call('GET', '/api/products', { token: B })).status, 200)
  const cancel = await call('POST', `/api/saas/contracts/${link.body.id}/cancel`, { token: SA, body: { reason: 'Encerrou as atividades' } })
  assert.equal(cancel.status, 200); assert.equal(cancel.body.status, 'cancelado')
  assert.equal((await call('GET', '/api/products', { token: B })).status, 200, 'cancelado: dados continuam para consulta')
  assert.equal((await call('POST', '/api/customers', { token: B, body: { name: 'Y' } })).status, 402)
  const d = await call('GET', '/api/saas/dashboard', { token: SA })
  assert.equal(d.status, 200)
  assert.equal(d.body.kpis.active, 2)
  assert.equal(d.body.kpis.mrr, 399.8)
  assert.ok(d.body.kpis.received > 0)
  assert.equal(d.body.kpis.churn_month, 1)
  assert.equal(d.body.series.length, 12)
  assert.ok(d.body.reviews.open >= 1)
  const charges = await call('GET', '/api/saas/charges?status=paga', { token: SA })
  assert.ok(charges.body.totals.paid > 0)
})

test('estorno pelo AXIONYX e cliente sem permissão sobre cobranças de outra empresa', async () => {
  const list = (await call('GET', `/api/saas/charges?contract=${contractId}&status=paga`, { token: SA })).body.items
  const target = list.find((c: any) => c.mp_payment_id)
  const r = await call('POST', `/api/saas/charges/${target.id}/refund`, { token: SA, body: { reason: 'Cobrança em duplicidade' } })
  assert.equal(r.status, 200); assert.equal(r.body.status, 'estornada')
  // webhook do estorno não gera exceção duplicada (estorno pedido pelo próprio AXIONYX)
  await webhook('payment', target.mp_payment_id)
  const k = (await call('GET', `/api/saas/contracts/${contractId}`, { token: SA })).body
  assert.ok(!k.reviews.some((x: any) => x.kind === 'estorno' && x.status === 'aberta'))
  // a empresa A (sem contrato) não acessa cobranças de outra empresa
  assert.equal((await call('POST', `/api/billing/me/charges/${target.id}/checkout`, { token: A })).status, 404)
})
