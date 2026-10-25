import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, teardown, call, login, db, Env, baseUrl, createCompanyWithAdmin } from './helpers'

let env: Env
let A: { token: string; companyId: string; branchId: string }
let V: { token: string }
let B: { token: string }
let lk: any
let product: any
let customer: any
const m = (kind: string) => lk.paymentMethods.find((x: any) => x.kind === kind).id
const key = () => 'k-' + Math.random().toString(36).slice(2) + Date.now()
const stockOf = async (variantId: string) => Number((await db.query(`SELECT COALESCE(sum(qty),0) AS q FROM stock_balances WHERE variant_id = $1`, [variantId])).rows[0].q)

before(async () => {
  env = await setup()
  A = await login('admin.a@teste.local')
  V = await login('vend.a@teste.local')
  B = await login('admin.b@teste.local')
  lk = (await call('GET', '/api/lookups', { token: A.token })).body
})
after(teardown)

test('autenticação: senha errada é recusada e não revela se o usuário existe', async () => {
  const r1 = await call('POST', '/api/auth/login', { body: { email: 'admin.a@teste.local', password: 'errada' } })
  const r2 = await call('POST', '/api/auth/login', { body: { email: 'ninguem@teste.local', password: 'errada' } })
  assert.equal(r1.status, 401); assert.equal(r2.status, 401)
  assert.equal(r1.body.error.message, r2.body.error.message)
})

test('autenticação: rotas protegidas exigem token válido', async () => {
  assert.equal((await call('GET', '/api/products')).status, 401)
  assert.equal((await call('GET', '/api/products', { token: 'abc.def.ghi' })).status, 401)
})

test('cadastro: CPF inválido é rejeitado pelo servidor', async () => {
  const r = await call('POST', '/api/customers', { token: A.token, body: { name: 'Cliente X', cpf_cnpj: '111.111.111-11' } })
  assert.equal(r.status, 422)
})

test('produto com grade cria uma variação por cor × tamanho, com EAN válido', async () => {
  const c1 = await call('POST', '/api/colors', { token: A.token, body: { name: 'Preto', code: 'PRE', hex: '#000000' } })
  const c2 = await call('POST', '/api/colors', { token: A.token, body: { name: 'Branco', code: 'BRA', hex: '#FFFFFF' } })
  assert.equal(c1.status, 200, JSON.stringify(c1.body))
  const sizes = lk.sizes.filter((s: any) => ['P', 'M', 'G'].includes(s.code)).slice(0, 3)
  const r = await call('POST', '/api/products', { token: A.token, body: { code: 'BLU-T1', name: 'Blusa Teste', sale_price: 100, cost_price: 40, ncm: '61061000', grid: { sizeIds: sizes.map((s: any) => s.id), colorIds: [c1.body.id, c2.body.id] } } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.variants.length, sizes.length * 2)
  for (const v of r.body.variants) assert.match(v.barcode, /^\d{13}$/)
  product = r.body
  const dup = await call('POST', '/api/products', { token: A.token, body: { code: 'BLU-T1', name: 'Duplicado' } })
  assert.equal(dup.status, 409)
})

test('isolamento: empresa B não enxerga nem altera produto da empresa A', async () => {
  assert.equal((await call('GET', `/api/products/${product.id}`, { token: B.token })).status, 404)
  assert.equal((await call('PUT', `/api/products/${product.id}`, { token: B.token, body: { name: 'Invadido' } })).status, 404)
  const list = await call('GET', '/api/products', { token: B.token })
  assert.equal(list.body.items.length, 0)
})

test('permissões: vendedor não acessa financeiro nem administração', async () => {
  assert.equal((await call('GET', '/api/payables', { token: V.token })).status, 403)
  assert.equal((await call('GET', '/api/admin/users', { token: V.token })).status, 403)
  assert.equal((await call('PUT', '/api/settings', { token: V.token, body: { vendas: { permitirEstoqueNegativo: true } } })).status, 403)
})

test('estoque: entrada registra histórico e saldo por variação', async () => {
  const v = product.variants[0]
  const r = await call('POST', '/api/stock/movements', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { type: 'entrada', reason: 'Carga de teste', items: product.variants.map((x: any) => ({ variantId: x.id, qty: x.id === v.id ? 1 : 5 })) } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(await stockOf(v.id), 1)
  const hist = await db.query(`SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1`, [v.id])
  assert.equal(hist.rows[0].n, 1)
})

test('venda: idempotência impede venda duplicada com a mesma chave', async () => {
  const regs = await call('GET', '/api/cash/registers', { token: A.token })
  const open = await call('POST', '/api/cash/open', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { registerId: regs.body[0].id, openingAmount: 100 } })
  assert.equal(open.status, 200, JSON.stringify(open.body))
  const v = product.variants[1]
  const before = await stockOf(v.id)
  const k = key()
  const body = { items: [{ variantId: v.id, qty: 1 }], payments: [{ methodId: m('pix'), amount: 100 }] }
  const s1 = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': k }, body })
  const s2 = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': k }, body })
  assert.equal(s1.status, 200, JSON.stringify(s1.body))
  assert.equal(s2.body.id, s1.body.id)
  assert.equal(await stockOf(v.id), before - 1)
  const n = await db.query(`SELECT count(*)::int AS n FROM sales WHERE company_id = $1 AND type = 'venda'`, [A.companyId])
  assert.equal(n.rows[0].n, 1)
})

test('concorrência: duas vendas simultâneas da última peça — apenas uma é concluída', async () => {
  const v = product.variants[0] // saldo 1
  const body = { items: [{ variantId: v.id, qty: 1 }], payments: [{ methodId: m('pix'), amount: 100 }] }
  const [r1, r2] = await Promise.all([
    call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body }),
    call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body }),
  ])
  const ok = [r1, r2].filter((r) => r.status === 200)
  assert.equal(ok.length, 1, `respostas: ${r1.status} ${r2.status}`)
  assert.equal(await stockOf(v.id), 0)
})

test('venda: pagamento menor que o total é recusado', async () => {
  const r = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { items: [{ variantId: product.variants[2].id, qty: 1 }], payments: [{ methodId: m('pix'), amount: 50 }] } })
  assert.equal(r.status, 422)
})

test('desconto acima do limite do perfil exige autorização', async () => {
  const r = await call('POST', '/api/sales', { token: V.token, headers: { 'Idempotency-Key': key() }, body: { items: [{ variantId: product.variants[2].id, qty: 1 }], discountTotal: 60, payments: [{ methodId: m('pix'), amount: 40 }] } })
  assert.ok([403, 422].includes(r.status), JSON.stringify(r.body))
})

test('crediário: gera parcelas, aceita baixa parcial e estorno sem lançamento duplicado', async () => {
  const c = await call('POST', '/api/customers', { token: A.token, body: { name: 'Maria Teste', cpf_cnpj: '529.982.247-25', credit_limit: 1000, whatsapp: '11999990000' } })
  assert.equal(c.status, 200, JSON.stringify(c.body)); customer = c.body
  const s = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { customerId: customer.id, items: [{ variantId: product.variants[3].id, qty: 3 }], payments: [{ methodId: m('crediario'), amount: 300, installments: 3 }] } })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const rec = await call('GET', `/api/receivables?sale=${s.body.id}&status=em_aberto`, { token: A.token })
  assert.equal(rec.body.items.length, 3)
  assert.equal(rec.body.items.reduce((a: number, r: any) => a + Number(r.amount), 0), 300)
  const t = rec.body.items[0]
  const k = key()
  const p1 = await call('POST', `/api/receivables/${t.id}/pay`, { token: A.token, headers: { 'Idempotency-Key': k }, body: { amount: 40, method: 'pix' } })
  const p1b = await call('POST', `/api/receivables/${t.id}/pay`, { token: A.token, headers: { 'Idempotency-Key': k }, body: { amount: 40, method: 'pix' } })
  assert.equal(p1.status, 200, JSON.stringify(p1.body)); assert.equal(p1b.body.id, p1.body.id)
  let d = await call('GET', `/api/receivables/${t.id}`, { token: A.token })
  assert.equal(d.body.status, 'parcial'); assert.equal(Number(d.body.balance), 60)
  const tx1 = await db.query(`SELECT count(*)::int AS n FROM financial_transactions WHERE source_type = 'title_payment' AND source_id = $1`, [p1.body.id])
  assert.equal(tx1.rows[0].n, 1)
  const rv = await call('POST', `/api/title-payments/${p1.body.id}/reverse`, { token: A.token, body: { reason: 'Lançado errado (teste)' } })
  assert.equal(rv.status, 200, JSON.stringify(rv.body))
  d = await call('GET', `/api/receivables/${t.id}`, { token: A.token })
  assert.equal(d.body.status, 'aberto'); assert.equal(Number(d.body.balance), 100)
  const again = await call('POST', `/api/title-payments/${p1.body.id}/reverse`, { token: A.token, body: { reason: 'Segunda vez (teste)' } })
  assert.notEqual(again.status, 200)
})

test('crediário: limite de crédito é respeitado', async () => {
  const r = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { customerId: customer.id, items: [{ variantId: product.variants[4].id, qty: 5 }, { variantId: product.variants[5].id, qty: 5 }], payments: [{ methodId: m('crediario'), amount: 1000, installments: 4 }] } })
  assert.equal(r.status, 422, JSON.stringify(r.body))
})

test('troca: devolve a peça ao estoque e gera vale-troca', async () => {
  const v = product.variants[4]
  const s = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { customerId: customer.id, items: [{ variantId: v.id, qty: 1 }], payments: [{ methodId: m('pix'), amount: 100 }] } })
  const before = await stockOf(v.id)
  const sale = await call('GET', `/api/sales/${s.body.id}`, { token: A.token })
  const r = await call('POST', '/api/returns', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { saleId: s.body.id, type: 'troca', refundMode: 'vale_troca', items: [{ saleItemId: sale.body.items[0].id, qty: 1 }], reason: 'Tamanho' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(await stockOf(v.id), before + 1)
  const credit = await db.query(`SELECT balance FROM store_credits WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1`, [customer.id])
  assert.equal(Number(credit.rows[0].balance), 100)
  const dup = await call('POST', '/api/returns', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { saleId: s.body.id, type: 'troca', refundMode: 'vale_troca', items: [{ saleItemId: sale.body.items[0].id, qty: 1 }] } })
  assert.ok([409, 422].includes(dup.status), 'não pode devolver mais do que foi vendido')
})

test('condicional: saída baixa estoque, retorno devolve e compra vira venda sem baixa dupla', async () => {
  const v = product.variants[5]
  const s0 = await stockOf(v.id)
  const k = await call('POST', '/api/conditionals', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { customerId: customer.id, items: [{ variantId: v.id, qty: 2 }] } })
  assert.equal(k.status, 200, JSON.stringify(k.body))
  assert.equal(await stockOf(v.id), s0 - 2)
  const r = await call('POST', `/api/conditionals/${k.body.id}/return`, { token: A.token, headers: { 'Idempotency-Key': key() }, body: { items: [{ variantId: v.id, returned: 1, sold: 1 }], payments: [{ methodId: m('pix'), amount: 100 }] } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.finished, true); assert.ok(r.body.sale?.id)
  assert.equal(await stockOf(v.id), s0 - 1)
})

test('cancelamento de venda estorna estoque e financeiro', async () => {
  const v = product.variants[2]
  const s0 = await stockOf(v.id)
  const s = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { items: [{ variantId: v.id, qty: 1 }], payments: [{ methodId: m('pix'), amount: 100 }] } })
  assert.equal(await stockOf(v.id), s0 - 1)
  const c = await call('POST', `/api/sales/${s.body.id}/cancel`, { token: A.token, headers: { 'Idempotency-Key': key() }, body: { reason: 'Teste de cancelamento' } })
  assert.equal(c.status, 200, JSON.stringify(c.body))
  assert.equal(await stockOf(v.id), s0)
  const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [s.body.id])
  assert.ok(audit.rows[0].n >= 2, 'venda e cancelamento auditados')
})

test('fiscal: sem provedor configurado o documento nunca é marcado como autorizado', async () => {
  const s = await db.query(`SELECT id FROM sales WHERE company_id = $1 AND status = 'concluida' LIMIT 1`, [A.companyId])
  const d = await call('POST', '/api/fiscal/documents/from-sale', { token: A.token, body: { saleId: s.rows[0].id, model: '65' } })
  assert.equal(d.status, 200, JSON.stringify(d.body))
  const t = await call('POST', `/api/fiscal/documents/${d.body.id}/transmit`, { token: A.token, headers: { 'Idempotency-Key': key() }, body: {} })
  assert.notEqual(t.body.status, 'autorizado')
  assert.equal(t.body.access_key ?? null, null)
  assert.equal(t.body.is_test, true)
})

test('importação de XML: rejeita DOCTYPE (XXE) e nota duplicada', async () => {
  const evil = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><nfeProc>&e;</nfeProc>'
  const r1 = await call('POST', '/api/purchase-entries/import-xml', { token: A.token, raw: evil, type: 'application/xml' })
  assert.ok(r1.status >= 400 && r1.status < 500)
  const xml = `<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe35261011222333000181550010000099991000099990"><ide><nNF>9999</nNF><serie>1</serie><dhEmi>2026-10-20T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>11444777000161</CNPJ><xNome>Fornecedor Teste</xNome></emit><dest><CNPJ>11222333000181</CNPJ></dest>
    <det nItem="1"><prod><cProd>X1</cProd><cEAN>SEM GTIN</cEAN><xProd>BLUSA TESTE P</xProd><NCM>61061000</NCM><CFOP>6102</CFOP><uCom>UN</uCom><qCom>2</qCom><vUnCom>10.00</vUnCom><vProd>20.00</vProd></prod></det>
    <total><ICMSTot><vProd>20.00</vProd><vFrete>0</vFrete><vDesc>0</vDesc><vOutro>0</vOutro><vNF>20.00</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><cStat>100</cStat><nProt>1</nProt></infProt></protNFe></nfeProc>`
  const r2 = await call('POST', '/api/purchase-entries/import-xml', { token: A.token, raw: xml, type: 'application/xml' })
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  assert.equal(r2.body.pending, 1)
  const before = await db.query(`SELECT count(*)::int AS n FROM stock_movements WHERE ref_id = $1`, [r2.body.id])
  assert.equal(before.rows[0].n, 0, 'nada entra no estoque antes da confirmação')
  const r3 = await call('POST', '/api/purchase-entries/import-xml', { token: A.token, raw: xml, type: 'application/xml' })
  assert.equal(r3.status, 409)
  const conf = await call('POST', `/api/purchase-entries/${r2.body.id}/confirm`, { token: A.token, headers: { 'Idempotency-Key': key() }, body: {} })
  assert.equal(conf.status, 422, 'itens sem vínculo impedem a confirmação')
})

test('WhatsApp: mensagem de marketing sem consentimento não é enviada', async () => {
  const r = await call('POST', '/api/messages', { token: A.token, body: { customerId: customer.id, purpose: 'campanha', body: 'Promoção {nome}' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.status, 'bloqueado_sem_consentimento')
})

test('integrações: não é possível ativar sem credenciais no servidor e segredos não são gravados', async () => {
  const list = await call('GET', '/api/integrations', { token: A.token })
  const wa = list.body.items.find((i: any) => i.kind === 'whatsapp')
  assert.equal((await call('PUT', `/api/integrations/${wa.id}`, { token: A.token, body: { status: 'ativo' } })).status, 422)
  const r = await call('PUT', `/api/integrations/${wa.id}`, { token: A.token, body: { config: { token: 'segredo', nota: 'ok' } } })
  assert.equal(r.status, 200); assert.equal(r.body.config.token, undefined); assert.equal(r.body.config.nota, 'ok')
})

test('salário de colaborador é ocultado sem permissão específica', async () => {
  const e = await call('POST', '/api/employees-admin', { token: A.token, body: { name: 'Colaboradora Teste', salary: 2500 } })
  assert.equal(e.status, 200, JSON.stringify(e.body))
  await db.query(`UPDATE roles SET permissions = array_append(permissions, 'rh.ver') WHERE company_id = $1 AND name = 'Vendedor'`, [A.companyId])
  const r = await call('GET', `/api/employees-admin/${e.body.id}`, { token: V.token })
  assert.equal(r.status, 200); assert.equal(r.body.salary, null)
})

test('relatório de vendas confere com os cabeçalhos das vendas', async () => {
  const r = await call('GET', '/api/reports/sales?group=dia&branch=all', { token: A.token })
  assert.equal(r.status, 200)
  const sum = r.body.rows.reduce((a: number, x: any) => a + Number(x.net), 0)
  assert.ok(Math.abs(sum - Number(r.body.check.total)) < 0.02, `itens ${sum} x vendas ${r.body.check.total}`)
})

// ---------- Precificação ----------
test('precificação: migração aplicada, custos fixos/variáveis e parâmetros por empresa', async () => {
  const s = await call('GET', '/api/pricing/settings', { token: A.token })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.settings.desired_margin_pct, 15)
  const f1 = await call('POST', '/api/pricing/fixed-costs', { token: A.token, body: { category: 'ocupacao', description: 'Aluguel teste', monthly_amount: 3000 } })
  assert.equal(f1.status, 200, JSON.stringify(f1.body))
  await call('POST', '/api/pricing/fixed-costs', { token: A.token, body: { category: 'pessoal', description: 'Folha teste', monthly_amount: 7000 } })
  const neg = await call('POST', '/api/pricing/fixed-costs', { token: A.token, body: { category: 'ocupacao', description: 'Negativo', monthly_amount: -1 } })
  assert.equal(neg.status, 422)
  const badPct = await call('POST', '/api/pricing/variable-costs', { token: A.token, body: { category: 'cartao', description: 'Taxa absurda', kind: 'percentual', value: 120 } })
  assert.equal(badPct.status, 422)
  // faturamento manual para que o rateio de fixos seja determinístico: 10.000 / 50.000 = 20%
  const put = await call('PUT', '/api/pricing/settings', { token: A.token, body: { revenue_base_mode: 'manual', revenue_base_manual: 50000, rounding: 'nenhum', desired_margin_pct: 10 } })
  assert.equal(put.status, 200, JSON.stringify(put.body))
  assert.equal(put.body.fixedTotal, 10000)
  assert.equal(put.body.fixedPct, 20)
  // isolamento: empresa B não vê os custos da A
  const bList = await call('GET', '/api/pricing/fixed-costs', { token: B.token })
  assert.ok(!bList.body.items.some((x: any) => x.description === 'Aluguel teste'))
  const bEdit = await call('PUT', `/api/pricing/fixed-costs/${f1.body.id}`, { token: B.token, body: { monthly_amount: 1 } })
  assert.ok([404, 200].includes(bEdit.status))
  const still = await db.query(`SELECT monthly_amount FROM fixed_costs WHERE id = $1`, [f1.body.id])
  assert.equal(Number(still.rows[0].monthly_amount), 3000)
})

test('precificação: cálculo no servidor, aplicação de preço com histórico, auditoria e permissão', async () => {
  const calc = await call('POST', '/api/pricing/calculate', { token: A.token, body: { productId: product.id, variablePct: 10, unitVariableCosts: 0 } })
  assert.equal(calc.status, 200, JSON.stringify(calc.body))
  // custo 40, variáveis 10%, fixos 20%, margem 10% → 40 / 0,60 = 66,67
  assert.equal(calc.body.result.suggestedPrice, 66.67)
  assert.equal(calc.body.result.currentPrice, 100)
  const deny = await call('POST', '/api/pricing/apply', { token: V.token, body: { productId: product.id, price: 66.67 }, headers: { 'idempotency-key': key() } })
  assert.equal(deny.status, 403)
  const k = key()
  const ap = await call('POST', '/api/pricing/apply', { token: A.token, body: { productId: product.id, price: 79.9, variablePct: 10, unitVariableCosts: 0 }, headers: { 'idempotency-key': k } })
  assert.equal(ap.status, 200, JSON.stringify(ap.body))
  assert.equal(ap.body.previousPrice, 100)
  const again = await call('POST', '/api/pricing/apply', { token: A.token, body: { productId: product.id, price: 79.9, variablePct: 10, unitVariableCosts: 0 }, headers: { 'idempotency-key': k } })
  assert.equal(again.body.historyId, ap.body.historyId)   // idempotente: não duplica
  const p = await db.query(`SELECT sale_price FROM products WHERE id = $1`, [product.id])
  assert.equal(Number(p.rows[0].sale_price), 79.9)
  const h = await db.query(`SELECT count(*)::int AS n FROM pricing_history WHERE product_id = $1 AND kind = 'aplicacao'`, [product.id])
  assert.equal(h.rows[0].n, 1)
  const au = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'precificacao.preco_aplicado' AND entity_id = $1`, [product.id])
  assert.equal(au.rows[0].n, 1)
  const inv = await call('POST', '/api/pricing/calculate', { token: A.token, body: { acquisitionCost: 10, variablePct: 70, fixedPct: 25, includeFixedCosts: true, desiredMarginPct: 10 } })
  assert.equal(inv.status, 422)
  const ind = await call('GET', '/api/pricing/indicators', { token: A.token })
  assert.equal(ind.status, 200); assert.equal(ind.body.current.fixedCosts, 10000); assert.equal(ind.body.series.length, 6)
  const an = await call('GET', '/api/pricing/products', { token: A.token })
  assert.equal(an.status, 200); assert.ok(an.body.items.some((x: any) => x.id === product.id && x.status))
  const g1 = await call('POST', '/api/pricing/goals', { token: A.token, body: { productId: product.id, name: 'Meta 1', startDate: '2026-01-01', endDate: '2026-01-31', targetUnits: 100, unitPrice: 79.9 } })
  const g2 = await call('POST', '/api/pricing/goals', { token: A.token, body: { productId: product.id, name: 'Meta 2', startDate: '2026-02-01', endDate: '2026-02-28', targetUnits: 120, unitPrice: 79.9 } })
  assert.equal(g2.status, 200, JSON.stringify(g2.body)); assert.equal(g2.body.previous_goal_id, g1.body.id)
  const goals = await call('GET', '/api/pricing/goals', { token: A.token })
  assert.equal(goals.body.filter((x: any) => x.product_id === product.id).length, 1)   // só uma ativa por produto
  const vs = await call('GET', '/api/pricing/settings', { token: V.token })
  assert.equal(vs.status, 403)
})

// ---------- WhatsApp por empresa (contra um servidor simulado da Graph API) ----------
test('WhatsApp por empresa: credenciais cifradas, ativação, modelos por finalidade, envio e webhook', async () => {
  const http = await import('node:http')
  const crypto = await import('node:crypto')
  const sent: any[] = []
  const mock = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.headers.authorization !== 'Bearer EAAG-token-de-teste-1234567890') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token' } })) }
      if (req.method === 'GET' && req.url!.startsWith('/v21.0/1234567890123?')) return res.end(JSON.stringify({ display_phone_number: '+55 11 4000-0000', verified_name: 'Loja Teste A', quality_rating: 'GREEN' }))
      if (req.method === 'GET' && req.url!.startsWith('/v21.0/9876543210987/message_templates')) return res.end(JSON.stringify({ data: [
        { name: 'lembrete_parcela', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá {{1}}, sua parcela de {{2}} vence em {{3}}.' }] },
        { name: 'promo_inverno', language: 'pt_BR', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Oi {{1}}!' }] }] }))
      if (req.method === 'POST' && req.url === '/v21.0/1234567890123/messages') { sent.push(JSON.parse(raw)); return res.end(JSON.stringify({ messages: [{ id: 'wamid.TESTE' + sent.length }] })) }
      res.statusCode = 404; return res.end('{}')
    })
  })
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()))
  process.env.WHATSAPP_GRAPH_URL = `http://127.0.0.1:${(mock.address() as any).port}`
  try {
    const deny = await call('PUT', '/api/whatsapp/config', { token: V.token, body: { displayPhone: '11940000000', phoneNumberId: '1234567890123', accessToken: 'EAAG-token-de-teste-1234567890' } })
    assert.equal(deny.status, 403)
    const bad = await call('PUT', '/api/whatsapp/config', { token: A.token, body: { displayPhone: '11940000000', phoneNumberId: 'abc', accessToken: 'x' } })
    assert.equal(bad.status, 422)
    const cfg = await call('PUT', '/api/whatsapp/config', { token: A.token, body: { displayPhone: '(11) 94000-0000', phoneNumberId: '1234567890123', wabaId: '9876543210987',
      accessToken: 'EAAG-token-de-teste-1234567890', appSecret: 'app-secret-de-teste-123' } })
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body))
    assert.equal(cfg.body.hasToken, true); assert.ok(!JSON.stringify(cfg.body).includes('EAAG-token')); assert.ok(cfg.body.verifyToken)
    const row = (await db.query(`SELECT secret_enc, config FROM integrations WHERE company_id = $1 AND kind = 'whatsapp'`, [A.companyId])).rows[0]
    assert.ok(row.secret_enc.startsWith('v1.')); assert.ok(!row.secret_enc.includes('EAAG')); assert.ok(!JSON.stringify(row.config).includes('EAAG'))
    // empresa B não enxerga a configuração da A
    const b = await call('GET', '/api/whatsapp/config', { token: B.token })
    assert.equal(b.body.hasToken, false); assert.equal(b.body.phoneNumberId, '')
    const t = await call('POST', '/api/whatsapp/test', { token: A.token })
    assert.equal(t.status, 200, JSON.stringify(t.body)); assert.equal(t.body.status, 'ativo'); assert.equal(t.body.verifiedName, 'Loja Teste A')
    const sync = await call('POST', '/api/whatsapp/templates/sync', { token: A.token })
    assert.equal(sync.body.synced, 2)
    const tpl = sync.body.items.find((x: any) => x.name === 'lembrete_parcela')
    const pend = sync.body.items.find((x: any) => x.name === 'promo_inverno')
    assert.equal((await call('PUT', `/api/whatsapp/templates/${pend.id}`, { token: A.token, body: { purpose: 'campanha' } })).status, 422)  // não aprovado
    assert.equal((await call('PUT', `/api/whatsapp/templates/${tpl.id}`, { token: A.token, body: { variables: ['nome'] } })).status, 422)  // faltam variáveis
    const up = await call('PUT', `/api/whatsapp/templates/${tpl.id}`, { token: A.token, body: { purpose: 'cobranca', variables: ['nome', 'valor', 'vencimento'] } })
    assert.equal(up.status, 200, JSON.stringify(up.body))
    // cliente com consentimento; fora da janela de 24 h → usa o modelo aprovado da finalidade
    const cu = await call('POST', '/api/customers', { token: A.token, body: { name: 'Joana Zap', whatsapp: '(11) 98888-7777', consents: { whatsapp: true } } })
    assert.equal(cu.status, 200, JSON.stringify(cu.body))
    const m = await call('POST', '/api/messages', { token: A.token, body: { customerId: cu.body.id, purpose: 'cobranca', body: 'texto livre', refType: 'cobranca', refId: 'teste-1' } })
    assert.equal(m.status, 200, JSON.stringify(m.body)); assert.equal(m.body.status, 'fila'); assert.equal(m.body.template, 'lembrete_parcela')
    assert.match(m.body.body, /^Olá Joana, sua parcela de R\$\s?0,00 vence em \./)
    const { processOutbox } = await import('../integrations/worker')
    await processOutbox(10)
    const out = sent.find((s) => s.type === 'template')
    assert.ok(out, 'modelo enviado à Meta'); assert.equal(out.to, '5511988887777'); assert.equal(out.template.name, 'lembrete_parcela')
    assert.equal(out.template.components[0].parameters[0].text, 'Joana')
    const msg = (await db.query(`SELECT status, provider_message_id FROM messages WHERE id = $1`, [m.body.id])).rows[0]
    assert.equal(msg.status, 'enviado'); assert.ok(msg.provider_message_id.startsWith('wamid.'))
    // webhook: verificação, assinatura, status e mensagem recebida
    const intId = cfg.body.integrationId
    const ver = await fetch(`${baseUrl()}/api/webhooks/whatsapp/${intId}?hub.mode=subscribe&hub.verify_token=${cfg.body.verifyToken}&hub.challenge=12345`)
    assert.equal(ver.status, 200); assert.equal(await ver.text(), '12345')
    const wrong = await fetch(`${baseUrl()}/api/webhooks/whatsapp/${intId}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`)
    assert.equal(wrong.status, 401)
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1234567890123' },
      statuses: [{ id: msg.provider_message_id, status: 'read' }],
      messages: [{ id: 'wamid.IN1', from: '5511988887777', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Oi, vou pagar hoje' } }] } }] }] })
    const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret-de-teste-123').update(payload).digest('hex')
    const forged = await fetch(`${baseUrl()}/api/webhooks/whatsapp/${intId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: payload })
    assert.equal(forged.status, 401)
    const hook = await fetch(`${baseUrl()}/api/webhooks/whatsapp/${intId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: payload })
    assert.equal(hook.status, 200, await hook.clone().text())
    assert.equal((await db.query(`SELECT status FROM messages WHERE id = $1`, [m.body.id])).rows[0].status, 'lido')
    const inbound = (await db.query(`SELECT customer_id, direction, status FROM messages WHERE provider_message_id = 'wamid.IN1'`)).rows[0]
    assert.equal(inbound.customer_id, cu.body.id); assert.equal(inbound.direction, 'entrada'); assert.equal(inbound.status, 'recebido')
    // dentro da janela de 24 h, texto livre passa a ser permitido (atendimento)
    const at = await call('POST', '/api/messages', { token: A.token, body: { customerId: cu.body.id, purpose: 'atendimento', body: 'Obrigada, {nome}!' } })
    assert.equal(at.body.status, 'fila'); assert.equal(at.body.template, null); assert.equal(at.body.body, 'Obrigada, Joana!')
  } finally {
    delete process.env.WHATSAPP_GRAPH_URL
    mock.close()
  }
})

// ---------- Segmentos: Moda (convertida), Hortifrúti e Adega ----------
test('segmentos: moda mantém grade/coleções; hortifrúti nasce com peso, validade e categorias próprias', async () => {
  const segs = await call('GET', '/api/segments')
  assert.equal(segs.status, 200); assert.ok(segs.body.segments.some((s: any) => s.id === 'hortifruti'))
  const meA = await call('GET', '/api/auth/me', { token: A.token })
  assert.equal(meA.body.segment.id, 'moda'); assert.ok(meA.body.company.modules.includes('grade')); assert.ok(meA.body.company.modules.includes('condicional'))
  const coId = await createCompanyWithAdmin('Quitanda Teste', 'hortifruti', 'admin.h@teste.local')
  const H = await login('admin.h@teste.local')
  const me = await call('GET', '/api/auth/me', { token: H.token })
  assert.equal(me.body.segment.id, 'hortifruti'); assert.equal(me.body.segment.defaultUnit, 'KG')
  assert.ok(me.body.company.modules.includes('peso') && me.body.company.modules.includes('validade'))
  assert.ok(!me.body.company.modules.includes('grade') && !me.body.company.modules.includes('condicional'))
  const cats = await db.query(`SELECT name FROM categories WHERE company_id = $1`, [coId])
  assert.ok(cats.rows.some((r: any) => r.name === 'Frutas'))
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM sizes WHERE company_id = $1`, [coId])).rows[0].n, 0)
  // aplicar outro segmento só acrescenta (nada é removido)
  const ap = await call('POST', `/api/admin/companies/${coId}/segment`, { token: H.token, body: { segment: 'adega' } })
  assert.equal(ap.status, 200, JSON.stringify(ap.body))
  assert.ok(ap.body.modules.includes('peso') && ap.body.modules.includes('maioridade'))
  assert.equal((await call('POST', `/api/admin/companies/${coId}/segment`, { token: H.token, body: { segment: 'petshop' } })).status, 422) // inexistente
  await call('POST', `/api/admin/companies/${coId}/segment`, { token: H.token, body: { segment: 'hortifruti' } })
  const deny = await call('POST', `/api/admin/companies/${A.companyId}/segment`, { token: H.token, body: { segment: 'adega' } })
  assert.equal(deny.status, 403)
})

test('hortifrúti: venda por peso, etiqueta de balança, lotes com validade (FEFO) e perdas', async () => {
  const H = await login('admin.h@teste.local')
  const lk = (await call('GET', '/api/lookups', { token: H.token })).body
  const pix = lk.paymentMethods.find((x: any) => x.kind === 'pix').id
  const p = await call('POST', '/api/products', { token: H.token, body: { code: 'TOM-01', name: 'Tomate italiano', unit: 'KG', sale_by_weight: true, plu_code: '101', sale_price: 9.9, cost_price: 4, shelf_life_days: 5 } })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const vId = p.body.variants[0].id
  const un = await call('POST', '/api/products', { token: H.token, body: { code: 'OVO-12', name: 'Ovos dúzia', unit: 'DZ', sale_price: 12, cost_price: 8 } })
  const lot = await call('POST', '/api/stock/lots', { token: H.token, body: { variantId: vId, qty: 10.5, lotCode: 'L1' }, headers: { 'idempotency-key': key() } })
  assert.equal(lot.status, 200, JSON.stringify(lot.body)); assert.ok(lot.body.expiry_date, 'validade padrão aplicada')
  await call('POST', '/api/stock/lots', { token: H.token, body: { variantId: un.body.variants[0].id, qty: 10 }, headers: { 'idempotency-key': key() } })
  // quantidade fracionada em produto por unidade é recusada
  const frac = await call('POST', '/api/sales', { token: H.token, body: { items: [{ variantId: un.body.variants[0].id, qty: 1.5 }], payments: [{ methodId: pix, amount: 18 }] }, headers: { 'idempotency-key': key() } })
  assert.equal(frac.status, 422)
  const s1 = await call('POST', '/api/sales', { token: H.token, body: { items: [{ variantId: vId, qty: 1.234 }], payments: [{ methodId: pix, amount: 12.22 }] }, headers: { 'idempotency-key': key() } })
  assert.equal(s1.status, 200, JSON.stringify(s1.body)); assert.equal(Number(s1.body.total), 12.22)
  const bal = async () => Number((await db.query(`SELECT qty FROM stock_balances WHERE variant_id = $1`, [vId])).rows[0].qty)
  assert.equal(await bal(), 9.266)
  assert.equal(Number((await db.query(`SELECT qty_remaining FROM stock_lots WHERE id = $1`, [lot.body.id])).rows[0].qty_remaining), 9.266)
  // etiqueta de balança gerada pelo sistema e lida no PDV (preço total embutido)
  const lab = await call('POST', '/api/scale/labels', { token: H.token, body: { items: [{ productId: p.body.id, weightKg: 0.75 }] } })
  assert.equal(lab.status, 200, JSON.stringify(lab.body)); const code = lab.body[0].barcode
  assert.match(code, /^2\d{12}$/); assert.equal(lab.body[0].total, 7.43)
  const look = await call('GET', `/api/variants/search?q=${code}`, { token: H.token })
  assert.equal(look.body[0].kind, 'balanca'); assert.equal(look.body[0].price, 7.43)
  const s2 = await call('POST', '/api/sales', { token: H.token, body: { items: [{ scaleCode: code, qty: 1 }], payments: [{ methodId: pix, amount: 7.43 }] }, headers: { 'idempotency-key': key() } })
  assert.equal(s2.status, 200, JSON.stringify(s2.body)); assert.equal(Number(s2.body.total), 7.43)
  const kg = look.body[0].qty // etiqueta com preço: o peso é derivado (preço ÷ preço por kg, 3 casas)
  assert.ok(Math.abs(kg - 0.75) < 0.002)
  assert.equal(await bal(), Math.round((9.266 - kg) * 1000) / 1000)
  const bad = await call('POST', '/api/sales', { token: H.token, body: { items: [{ scaleCode: '2999990012342', qty: 1 }], payments: [{ methodId: pix, amount: 1 }] }, headers: { 'idempotency-key': key() } })
  assert.equal(bad.status, 422)
  // perda
  const loss = await call('POST', '/api/stock/losses', { token: H.token, body: { lotId: lot.body.id, qty: 0.5, reason: 'avariado' }, headers: { 'idempotency-key': key() } })
  assert.equal(loss.status, 200, JSON.stringify(loss.body)); assert.equal(Number(loss.body.total_cost), 2)
  assert.equal(await bal(), Math.round((9.266 - kg - 0.5) * 1000) / 1000)
  const rep = await call('GET', '/api/stock/losses', { token: H.token })
  assert.equal(rep.body.totals.cost, 2); assert.ok(rep.body.byReason.some((r: any) => r.reason === 'avariado'))
  const lots = await call('GET', '/api/stock/lots', { token: H.token })
  assert.equal(lots.status, 200); assert.ok(lots.body.items.length >= 1)
  // vendedor de outra empresa não vê os lotes
  const other = await call('GET', '/api/stock/lots', { token: A.token })
  assert.ok(!other.body.items.some((l: any) => l.id === lot.body.id))
})

test('adega: embalagem caixa, maioridade obrigatória no servidor, safra e combos', async () => {
  await createCompanyWithAdmin('Adega Teste', 'adega', 'admin.ad@teste.local')
  const D = await login('admin.ad@teste.local')
  const lk = (await call('GET', '/api/lookups', { token: D.token })).body
  const pix = lk.paymentMethods.find((x: any) => x.kind === 'pix').id
  const wine = await call('POST', '/api/products', { token: D.token, body: { code: 'VT-01', name: 'Vinho Malbec', sale_price: 50, cost_price: 25, age_restricted: true, attributes: { volume_ml: 750, uva: 'Malbec' } } })
  assert.equal(wine.status, 200, JSON.stringify(wine.body)); assert.equal(wine.body.attributes.uva, 'Malbec')
  const glass = await call('POST', '/api/products', { token: D.token, body: { code: 'TC-01', name: 'Taça de cristal', sale_price: 30, cost_price: 12 } })
  const wv = wine.body.variants[0].id, gv = glass.body.variants[0].id
  const lot = await call('POST', '/api/stock/lots', { token: D.token, body: { variantId: wv, qty: 24, vintage: 2020, expiryDate: '2030-12-31' }, headers: { 'idempotency-key': key() } })
  assert.equal(lot.status, 200, JSON.stringify(lot.body)); assert.equal(lot.body.vintage, 2020)
  await call('POST', '/api/stock/lots', { token: D.token, body: { variantId: gv, qty: 10 }, headers: { 'idempotency-key': key() } })
  const box = await call('POST', `/api/products/${wine.body.id}/packagings`, { token: D.token, body: { variantId: wv, name: 'Caixa com 6', units: 6, barcode: '7891234567895', salePrice: 270 } })
  assert.equal(box.status, 200, JSON.stringify(box.body))
  const look = await call('GET', '/api/variants/search?q=7891234567895', { token: D.token })
  assert.equal(look.body[0].kind, 'embalagem')
  const noAge = await call('POST', '/api/sales', { token: D.token, body: { items: [{ packagingId: box.body.id, qty: 1 }], payments: [{ methodId: pix, amount: 270 }] }, headers: { 'idempotency-key': key() } })
  assert.equal(noAge.status, 422); assert.equal(noAge.body.error.code, 'maioridade_requerida')
  const ok = await call('POST', '/api/sales', { token: D.token, body: { items: [{ packagingId: box.body.id, qty: 1 }], payments: [{ methodId: pix, amount: 270 }], ageConfirmed: true }, headers: { 'idempotency-key': key() } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(Number(ok.body.total), 270)
  const sale = (await db.query(`SELECT age_verified_by, (SELECT qty FROM sale_items WHERE sale_id = s.id) AS qty FROM sales s WHERE id = $1`, [ok.body.id])).rows[0]
  assert.ok(sale.age_verified_by); assert.equal(Number(sale.qty), 6)
  assert.equal(Number((await db.query(`SELECT qty FROM stock_balances WHERE variant_id = $1`, [wv])).rows[0].qty), 18)
  // combo: vinho + taça por 70 (normal 80) — cada item baixa o próprio estoque, preço rateado
  const cb = await call('POST', '/api/combos', { token: D.token, body: { code: 'KIT-1', name: 'Vinho + taça', price: 70, items: [{ variantId: wv, qty: 1 }, { variantId: gv, qty: 1 }] } })
  assert.equal(cb.status, 200, JSON.stringify(cb.body))
  const sc = await call('POST', '/api/sales', { token: D.token, body: { items: [{ comboId: cb.body.id, qty: 2 }], payments: [{ methodId: pix, amount: 140 }], ageConfirmed: true }, headers: { 'idempotency-key': key() } })
  assert.equal(sc.status, 200, JSON.stringify(sc.body)); assert.equal(Number(sc.body.total), 140)
  const lines = (await db.query(`SELECT variant_id, qty, total, combo_id FROM sale_items WHERE sale_id = $1`, [sc.body.id])).rows
  assert.equal(lines.length, 2); assert.equal(lines.reduce((s: number, l: any) => s + Number(l.total), 0), 140); assert.ok(lines.every((l: any) => l.combo_id === cb.body.id))
  assert.equal(Number((await db.query(`SELECT qty FROM stock_balances WHERE variant_id = $1`, [gv])).rows[0].qty), 8)
  // empresa de moda não exige maioridade (módulo inativo)
  assert.ok(!(await call('GET', '/api/auth/me', { token: A.token })).body.company.modules.includes('maioridade'))
})

test('site: formulário de contato valida, ignora robôs e só o superadministrador lista', async () => {
  const noConsent = await call('POST', '/api/public/leads', { body: { name: 'Fulano', email: 'f@ex.com', consent: false } })
  assert.equal(noConsent.status, 422)
  const okLead = await call('POST', '/api/public/leads', { body: { name: 'Fulana Lojista', phone: '(11) 98888-7777', companyName: 'Loja X', segment: 'Moda e vestuário', consent: true } })
  assert.equal(okLead.status, 200)
  const bot = await call('POST', '/api/public/leads', { body: { name: 'Robo', email: 'r@ex.com', consent: true, website: 'http://spam' } })
  assert.equal(bot.status, 200)
  const n = (await db.query(`SELECT count(*)::int AS n FROM site_leads`)).rows[0].n
  assert.equal(n, 1)
  assert.equal((await call('GET', '/api/admin/leads', { token: A.token })).status, 403)
})

test('mercadinho: preço por quantidade (atacarejo) aplicado no servidor', async () => {
  await createCompanyWithAdmin('Mercadinho Teste', 'mercado', 'admin.m@teste.local')
  const M = await login('admin.m@teste.local')
  const me = await call('GET', '/api/auth/me', { token: M.token })
  assert.equal(me.body.segment.id, 'mercado')
  for (const m of ['peso', 'validade', 'embalagens', 'combos', 'maioridade', 'precos_quantidade']) assert.ok(me.body.company.modules.includes(m), m)
  const pix = (await call('GET', '/api/lookups', { token: M.token })).body.paymentMethods.find((x: any) => x.kind === 'pix').id
  const p = await call('POST', '/api/products', { token: M.token, body: { code: 'REF-LATA', name: 'Refrigerante lata 350ml', sale_price: 5, cost_price: 2.5, variants: [{ size_id: null, color_id: null, barcode: '7894900011517' }] } })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const badTier = await call('PUT', `/api/products/${p.body.id}/price-tiers`, { token: M.token, body: { tiers: [{ minQty: 6, unitPrice: 5.5 }] } })
  assert.equal(badTier.status, 422)  // faixa precisa ser mais barata
  const t = await call('PUT', `/api/products/${p.body.id}/price-tiers`, { token: M.token, body: { tiers: [{ minQty: 12, unitPrice: 4 }, { minQty: 6, unitPrice: 4.5 }] } })
  assert.equal(t.status, 200, JSON.stringify(t.body)); assert.equal(t.body.length, 2)
  const vId = p.body.variants[0].id
  await call('POST', '/api/stock/movements', { token: M.token, body: { type: 'entrada', reason: 'Carga inicial', items: [{ variantId: vId, qty: 48 }] }, headers: { 'idempotency-key': key() } })
  const sale = async (qty: number, amount: number) => call('POST', '/api/sales', { token: M.token, body: { items: [{ variantId: vId, qty }], payments: [{ methodId: pix, amount }] }, headers: { 'idempotency-key': key() } })
  assert.equal(Number((await sale(5, 25)).body.total), 25)
  assert.equal(Number((await sale(6, 27)).body.total), 27)      // 6 × 4,50
  const s12 = await sale(12, 48)
  assert.equal(Number(s12.body.total), 48)                       // 12 × 4,00
  assert.equal(Number((await db.query(`SELECT price_tier_min_qty FROM sale_items WHERE sale_id = $1`, [s12.body.id])).rows[0].price_tier_min_qty), 12)
  const search = await call('GET', '/api/variants/search?q=7894900011517', { token: M.token })
  assert.equal(search.body[0].price_tiers.length, 2)
})

test('cosméticos: tonalidade/volume, linha, validade, kits, revendedoras e baixa de testers', async () => {
  const coId = await createCompanyWithAdmin('Perfumaria Teste', 'cosmeticos', 'admin.c@teste.local')
  const C = await login('admin.c@teste.local')
  const me = await call('GET', '/api/auth/me', { token: C.token })
  assert.equal(me.body.segment.id, 'cosmeticos'); assert.equal(me.body.segment.terms.cor, 'Tonalidade'); assert.equal(me.body.segment.terms.tamanho, 'Volume/tamanho')
  for (const m of ['grade', 'validade', 'combos', 'consignacao']) assert.ok(me.body.company.modules.includes(m), m)
  assert.ok(!me.body.company.modules.includes('condicional'))
  const vols = (await db.query(`SELECT id, code FROM sizes WHERE company_id = $1 AND grid = 'Volume'`, [coId])).rows
  assert.ok(vols.some((r: any) => r.code === '100ml'))
  const p = await call('POST', '/api/products', { token: C.token, body: { code: 'PF-01', name: 'Perfume Floral', sale_price: 289, cost_price: 120, gender: 'Feminino', shelf_life_days: 1095,
    attributes: { familia: 'Floral', concentracao: 'Eau de Parfum (EDP)', anvisa: '25351.000000/2026-00' }, grid: { sizeIds: vols.filter((r: any) => ['50ml', '100ml'].includes(r.code)).map((r: any) => r.id) } } })
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.variants.length, 2); assert.equal(p.body.attributes.concentracao, 'Eau de Parfum (EDP)')
  const v = p.body.variants[0].id
  await call('POST', '/api/stock/lots', { token: C.token, body: { variantId: v, qty: 10, lotCode: 'LT2026A' }, headers: { 'idempotency-key': key() } })
  const tester = await call('POST', '/api/stock/losses', { token: C.token, body: { variantId: v, qty: 1, reason: 'amostra', notes: 'Tester da vitrine' }, headers: { 'idempotency-key': key() } })
  assert.equal(tester.status, 200, JSON.stringify(tester.body)); assert.equal(Number(tester.body.total_cost), 120)
  assert.equal(Number((await db.query(`SELECT qty FROM stock_balances WHERE variant_id = $1`, [v])).rows[0].qty), 9)
})
