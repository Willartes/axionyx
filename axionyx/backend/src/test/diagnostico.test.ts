import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { setup, teardown, call, login } from './helpers'
import { db } from '../core/db'
import { shiftSale } from '../db/seed'
import { resolvePeriods, periodFromQuestion } from '../services/diagnosis'

/**
 * Pré-diagnóstico do lucro: as causas somam exatamente a variação do resultado do DRE, a alta de custo e de despesa
 * aparecem como evidência, e quem não tem acesso ao financeiro não vê lucro nem margem.
 */
let A: any, V: any, Bco: any
const key = () => crypto.randomUUID()
before(async () => {
  await setup()
  A = await login('admin.a@teste.local'); V = await login('vend.a@teste.local'); Bco = await login('admin.b@teste.local')
})
after(async () => { await teardown() })

test('períodos: mês até hoje, mês passado e janelas móveis', () => {
  assert.deepEqual(resolvePeriods('mes', '2026-03-31'), { key: 'mes', label: 'este mês até hoje', from: '2026-03-01', to: '2026-03-31', prevFrom: '2026-02-01', prevTo: '2026-02-28', days: 31 })
  const mp = resolvePeriods('mes_anterior', '2026-01-15')
  assert.deepEqual([mp.from, mp.to, mp.prevFrom, mp.prevTo], ['2025-12-01', '2025-12-31', '2025-11-01', '2025-11-30'])
  const w = resolvePeriods('7d', '2026-10-30')
  assert.deepEqual([w.from, w.to, w.prevFrom, w.prevTo], ['2026-10-24', '2026-10-30', '2026-10-17', '2026-10-23'])
  assert.equal(periodFromQuestion('por que meu lucro caiu essa semana'), '7d')
  assert.equal(periodFromQuestion('por que o resultado caiu no mes passado'), 'mes_anterior')
  assert.equal(periodFromQuestion('por que minha margem caiu este mes'), 'mes')
  assert.equal(periodFromQuestion('por que meu lucro caiu'), '30d')
})

test('lucro em queda: causas somam a variação do DRE e mostram custo e despesa em alta', async () => {
  const lk = (await call('GET', '/api/lookups', { token: A.token })).body
  const m = (kind: string) => lk.paymentMethods.find((x: any) => x.kind === kind).id
  const p = await call('POST', '/api/products', { token: A.token, body: { code: 'DIAG-1', name: 'Bolsa Couro Diagnóstico', sale_price: 100, cost_price: 40 } })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const variant = p.body.variants[0].id
  await call('POST', '/api/stock/movements', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { type: 'entrada', reason: 'Carga', items: [{ variantId: variant, qty: 100 }] } })
  const regs = await call('GET', '/api/cash/registers', { token: A.token })
  await call('POST', '/api/cash/open', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { registerId: regs.body[0].id, openingAmount: 0 } })
  const sell = async (days: number) => {
    const s = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { items: [{ variantId: variant, qty: 1 }], payments: [{ methodId: m('pix'), amount: 100 }] } })
    assert.equal(s.status, 200, JSON.stringify(s.body))
    await shiftSale(db as any, s.body.id, days, 12)
  }
  // período anterior (30 a 59 dias atrás): 12 vendas com custo 40
  for (let i = 0; i < 12; i++) await sell(35 + i)
  // custo sobe para 70 e o movimento cai: 8 vendas no período atual
  assert.equal((await call('PUT', `/api/products/${p.body.id}`, { token: A.token, body: { cost_price: 70 } })).status, 200)
  for (let i = 0; i < 8; i++) await sell(2 + i)
  // aluguel: R$ 1.000 antes, R$ 1.600 agora
  const cats = (await call('GET', '/api/financial-categories', { token: A.token })).body
  const rent = (cats.items ?? cats).find((c: any) => c.system_key === 'aluguel' || /aluguel/i.test(c.name))
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  const d = (n: number) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10)
  for (const [amount, days] of [[1000, 40], [1600, 5]] as const) {
    const r = await call('POST', '/api/payables', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { document: 'ALUG-' + days, description: 'Aluguel da loja', categoryId: rent.id, amount, firstDue: d(days) } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  }

  const r = await call('GET', '/api/intelligence/profit-diagnosis?period=30d', { token: A.token })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const g = r.body
  assert.equal(g.focus, 'lucro')
  // soma exata
  const sum = g.drivers.reduce((a: number, x: any) => a + x.impact, 0)
  assert.ok(Math.abs(sum - g.headline.delta) < 0.011, `soma ${sum} ≠ delta ${g.headline.delta}`)
  // mesma variação do DRE gerencial
  const dreA = await call('GET', `/api/reports/dre?from=${g.periods.from}&to=${g.periods.to}`, { token: A.token })
  const dreB = await call('GET', `/api/reports/dre?from=${g.periods.prevFrom}&to=${g.periods.prevTo}`, { token: A.token })
  const net = (x: any) => x.body.lines.find((l: any) => l.code === '8').value
  assert.ok(Math.abs(g.headline.delta - (net(dreA) - net(dreB))) < 0.011)
  assert.equal(g.headline.direction, 'caiu')
  const by = (k: string) => g.drivers.find((x: any) => x.key === k)
  assert.ok(by('movimento').impact < 0, 'menos vendas deve pesar')
  assert.equal(by('movimento').detail.startsWith('12 → 8'), true)
  assert.ok(by('margem').impact < 0, 'margem deve cair')
  assert.ok(by('margem').evidence.some((e: string) => /Custo dos mesmos produtos subiu/.test(e) && /Bolsa Couro/.test(e)), JSON.stringify(by('margem').evidence))
  assert.ok(Math.abs(by('despesa_administrativas').impact - -600) < 0.011)
  assert.ok(by('despesa_administrativas').evidence.some((e: string) => /Aluguel/.test(e)))
  assert.ok(g.actions.some((a: any) => /Reprecifique|renegocie/.test(a.text)))
  // AXIA
  const ax = await call('POST', '/api/assistant/ask', { token: A.token, body: { question: 'Por que meu lucro caiu?' } })
  assert.equal(ax.status, 200)
  if (process.env.DIAG_PRINT) console.log(ax.body.text)
  assert.match(ax.body.text, /Pré-diagnóstico do lucro/)
  assert.match(ax.body.text, /Margem menor/)
  assert.match(ax.body.link, /^diagnostico-lucro\?periodo=30d/)
  // perguntas comuns continuam com as respostas de antes
  const other = await call('POST', '/api/assistant/ask', { token: A.token, body: { question: 'Quais produtos estão abaixo do estoque mínimo?' } })
  assert.doesNotMatch(other.body.text, /Pré-diagnóstico/)
})

test('sem acesso ao financeiro: não vê lucro nem margem; vê só o diagnóstico das vendas', async () => {
  const ax = await call('POST', '/api/assistant/ask', { token: V.token, body: { question: 'Por que meu lucro caiu?' } })
  assert.match(ax.body.text, /acesso ao financeiro/)
  const r = await call('GET', '/api/intelligence/profit-diagnosis?period=30d&focus=lucro', { token: V.token })
  if (r.status === 200) {
    assert.equal(r.body.focus, 'vendas')
    assert.equal(r.body.kpis.net, undefined); assert.equal(r.body.kpis.grossMarginPct, undefined)
    assert.ok(!r.body.drivers.some((x: any) => x.key === 'margem' || x.key.startsWith('despesa_')))
  } else assert.equal(r.status, 403)
})

test('isolamento: a empresa B não enxerga as vendas da empresa A', async () => {
  const r = await call('GET', '/api/intelligence/profit-diagnosis?period=30d', { token: Bco.token })
  assert.equal(r.status, 200)
  assert.equal(r.body.kpis.sales.current, 0); assert.equal(r.body.kpis.sales.previous, 0)
  assert.equal(r.body.confidence.level, 'baixa')
})
