import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { setup, teardown, call, login, PASSWORD, baseUrl } from './helpers'
import { db } from '../core/db'
import { hashPassword } from '../core/crypto'
import { processOutbox } from '../integrations/worker'
import { assertStoreUrl, isPrivateIp } from '../integrations/adapters'
import { ecommerceWebhookSecret } from '../modules/integracoes'

/**
 * Loja virtual por empresa: credenciais cifradas por empresa, cada evento vai só para a loja da própria empresa,
 * proteção contra endereços internos, frete na venda, cancelamento/estorno vindos da loja e pendências.
 */
type Hit = { method: string; url: string; auth: string; body: any }
function fakeStore(token: string, health: 'ok' | '404' = 'ok') {
  const hits: Hit[] = []
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      hits.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization || ''), body: raw ? JSON.parse(raw) : null })
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return }
      if (req.url!.endsWith('/health')) { if (health === '404') { res.writeHead(404); res.end('{}') } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') } return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'ext-' + hits.length }))
    })
  })
  return { srv, hits, url: () => `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api` }
}
const storeA = fakeStore('token-da-loja-A-123456'), storeB = fakeStore('token-da-loja-B-654321', '404')
let env: any, A: string, B: string, V: string, OWNER: string, intA = '', intB = ''
const key = () => crypto.randomUUID()
async function hook(integrationId: string, body: any) {
  const raw = JSON.stringify(body)
  const sig = crypto.createHmac('sha256', ecommerceWebhookSecret(integrationId)!).update(raw).digest('hex')
  const r = await fetch(baseUrl() + `/api/webhooks/ecommerce/${integrationId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: raw })
  return { status: r.status === 201 ? 200 : r.status, body: await r.json().catch(() => null) as any }
}
async function product(token: string, code: string, qty: number) {
  const p = await call('POST', '/api/products', { token, body: { code, name: 'Produto ' + code, sale_price: 100, cost_price: 40 } })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  if (qty) await call('POST', '/api/stock/movements', { token, headers: { 'Idempotency-Key': key() }, body: { type: 'entrada', reason: 'Carga', items: [{ variantId: p.body.variants[0].id, qty }] } })
  return p.body
}
const balance = async (variantId: string) => Number((await db.query(`SELECT COALESCE(sum(qty),0) AS q FROM stock_balances WHERE variant_id = $1`, [variantId])).rows[0].q)

before(async () => {
  process.env.ECOMMERCE_ALLOW_PRIVATE = 'true'
  process.env.ECOMMERCE_WEBHOOK_SECRET = 'segredo-da-plataforma-para-webhooks-1234567890'
  await new Promise<void>((r) => storeA.srv.listen(0, '127.0.0.1', () => r()))
  await new Promise<void>((r) => storeB.srv.listen(0, '127.0.0.1', () => r()))
  env = await setup()
  A = (await login('admin.a@teste.local')).token; B = (await login('admin.b@teste.local')).token; V = (await login('vend.a@teste.local')).token
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner) VALUES ('Dono', 'dono@axionyx.test', $1, true, true)`, [hashPassword(PASSWORD)])
  OWNER = (await login('dono@axionyx.test', env.companyA.company.id)).token
})
after(async () => { await teardown(); storeA.srv.close(); storeB.srv.close(); delete process.env.ECOMMERCE_ALLOW_PRIVATE; delete process.env.ECOMMERCE_WEBHOOK_SECRET; delete process.env.MP_ACCESS_TOKEN; delete process.env.MP_API_URL })

test('endereço da loja: só https público (bloqueia rede interna e metadados da nuvem)', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateIp(ip), true, ip)
  for (const ip of ['8.8.8.8', '200.160.2.3', '2001:4860:4860::8888']) assert.equal(isPrivateIp(ip), false, ip)
  delete process.env.ECOMMERCE_ALLOW_PRIVATE
  try {
    await assert.rejects(assertStoreUrl('http://loja.exemplo.com.br'), /https/)
    await assert.rejects(assertStoreUrl('https://127.0.0.1/api'), /interno|privado/)
    await assert.rejects(assertStoreUrl('https://169.254.169.254/latest'), /interno|privado/)
    await assert.rejects(assertStoreUrl('https://localhost/api'), /interno/)
    await assert.rejects(assertStoreUrl('https://usuario:senha@loja.com.br'), /usuário ou senha/)
    await assert.rejects(assertStoreUrl('https://servico.railway.internal'), /interno/)
    assert.equal((await call('PUT', '/api/ecommerce/config', { token: A, body: { url: 'https://10.1.2.3/api', token: 'qualquer-token-123' } })).status, 422)
  } finally { process.env.ECOMMERCE_ALLOW_PRIVATE = 'true' }
})

test('cadastro por empresa: token cifrado, nunca devolvido; só quem edita integrações; teste ativa', async () => {
  assert.equal((await call('PUT', '/api/ecommerce/config', { token: V, body: { url: storeA.url(), token: 'token-da-loja-A-123456' } })).status, 403)
  const s = await call('PUT', '/api/ecommerce/config', { token: A, body: { url: storeA.url(), token: 'token-da-loja-A-123456' } })
  assert.equal(s.status, 200, JSON.stringify(s.body)); intA = s.body.integrationId
  assert.equal(s.body.status, 'pendente_configuracao'); assert.equal(s.body.tokenHint, '••••3456')
  assert.ok(!JSON.stringify(s.body).includes('token-da-loja-A'))
  const row = (await db.query(`SELECT secret_enc, config FROM integrations WHERE id = $1`, [intA])).rows[0]
  assert.ok(row.secret_enc && !row.secret_enc.includes('token-da-loja-A')); assert.ok(!JSON.stringify(row.config).includes('token-da-loja-A'))
  assert.ok(!JSON.stringify((await call('GET', '/api/ecommerce/config', { token: A })).body).includes('token-da-loja-A'))
  assert.ok(!JSON.stringify((await call('GET', '/api/integrations', { token: A })).body).includes('token-da-loja-A'))
  // token errado: a loja recusa e nada é ativado
  await call('PUT', '/api/ecommerce/config', { token: A, body: { url: storeA.url(), token: 'token-errado-000000' } })
  const bad = await call('POST', '/api/ecommerce/test', { token: A })
  assert.equal(bad.status, 422); assert.match(bad.body.error.message, /recusou o token/)
  await call('PUT', '/api/ecommerce/config', { token: A, body: { url: storeA.url(), token: 'token-da-loja-A-123456' } })
  const t = await call('POST', '/api/ecommerce/test', { token: A })
  assert.equal(t.status, 200, JSON.stringify(t.body)); assert.equal(t.body.status, 'ativo'); assert.match(t.body.message, /Conexão confirmada/)
  // empresa B: loja sem /health → ativa com aviso (token não confirmado)
  const sb = await call('PUT', '/api/ecommerce/config', { token: B, body: { url: storeB.url(), token: 'token-da-loja-B-654321' } }); intB = sb.body.integrationId
  const tb = await call('POST', '/api/ecommerce/test', { token: B })
  assert.equal(tb.body.status, 'ativo'); assert.match(tb.body.message, /não tem \/health/)
  assert.notEqual(intA, intB)
})

test('cada evento vai só para a loja da própria empresa', async () => {
  storeA.hits.length = 0; storeB.hits.length = 0
  const pa = await product(A, 'LOJA-A1', 5)
  const pb = await product(B, 'LOJA-B1', 3)
  assert.equal((await call('POST', `/api/integrations/${intA}/sync-products`, { token: A })).status, 200)
  assert.equal((await call('POST', `/api/integrations/${intB}/sync-products`, { token: B })).status, 200)
  assert.equal((await call('POST', `/api/integrations/${intA}/sync-products`, { token: B })).status, 404, 'B não sincroniza a loja da A')
  for (let k = 0; k < 5; k++) await processOutbox(50)
  const aSkus = storeA.hits.filter((h) => h.method !== 'GET').map((h) => JSON.stringify(h.body))
  const bSkus = storeB.hits.filter((h) => h.method !== 'GET').map((h) => JSON.stringify(h.body))
  assert.ok(aSkus.some((x) => x.includes('LOJA-A1')), 'produto da A chegou na loja A')
  assert.ok(bSkus.some((x) => x.includes('LOJA-B1')), 'produto da B chegou na loja B')
  assert.ok(!aSkus.some((x) => x.includes('LOJA-B1')), 'nada da B na loja A'); assert.ok(!bSkus.some((x) => x.includes('LOJA-A1')), 'nada da A na loja B')
  assert.ok(storeA.hits.every((h) => h.auth === 'Bearer token-da-loja-A-123456')); assert.ok(storeB.hits.every((h) => h.auth === 'Bearer token-da-loja-B-654321'))
  const stock = storeA.hits.find((h) => h.url.includes('/inventory/') && h.body?.sku === pa.variants[0].sku)
  assert.ok(stock); assert.equal(stock!.body.quantity, 5)
  // sem credenciais: evento fica aguardando configuração e nada sai
  await call('DELETE', '/api/ecommerce/config', { token: B })
  await db.query(`UPDATE integrations SET status = 'ativo' WHERE id = $1`, [intB]) // mesmo forçando "ativo"
  storeB.hits.length = 0
  await call('POST', '/api/stock/movements', { token: B, headers: { 'Idempotency-Key': key() }, body: { type: 'entrada', reason: 'Carga', items: [{ variantId: pb.variants[0].id, qty: 1 }] } })
  for (let k = 0; k < 3; k++) await processOutbox(50)
  assert.equal(storeB.hits.length, 0)
  assert.ok((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE integration_id = $1 AND status = 'aguardando_configuracao'`, [intB])).rows[0].n >= 1)
  // ativar pela tela genérica sem credenciais é recusado
  await db.query(`UPDATE integrations SET status = 'desativado' WHERE id = $1`, [intB])
  assert.equal((await call('PUT', `/api/integrations/${intB}`, { token: B, body: { status: 'ativo' } })).status, 422)
  // a tela genérica não troca o endereço validado
  await call('PUT', `/api/integrations/${intA}`, { token: A, body: { config: { url: 'http://169.254.169.254' } } })
  assert.equal((await db.query(`SELECT config->>'url' AS u FROM integrations WHERE id = $1`, [intA])).rows[0].u, storeA.url())
})

test('pedido com frete; cancelamento e estorno vindos da loja', async () => {
  const p = await product(A, 'LOJA-A2', 10)
  const sku = p.variants[0].sku, vid = p.variants[0].id
  const order = { id: 'PED-9001', customer: { name: 'Cliente da Loja', document: '52998224725' }, items: [{ sku, qty: 2, price: 100 }], payment: { kind: 'pix' }, shippingFee: 25.5 }
  const r = await hook(intA, order)
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.total, 225.5)
  const sale = (await db.query(`SELECT id, total, subtotal, surcharge, status FROM sales WHERE id = $1`, [r.body.saleId])).rows[0]
  assert.deepEqual([Number(sale.subtotal), Number(sale.surcharge), Number(sale.total)], [200, 25.5, 225.5])
  assert.equal(Number((await db.query(`SELECT sum(amount) AS s FROM sale_payments WHERE sale_id = $1`, [sale.id])).rows[0].s), 225.5)
  assert.equal(await balance(vid), 8)
  assert.equal((await hook(intA, order)).body.duplicate, true)
  // estorno parcial sem devolver ao estoque
  const e1 = await hook(intA, { type: 'pedido.estornado', id: 'PED-9001', eventId: 'est-1', items: [{ sku, qty: 1 }], reason: 'produto com defeito' })
  assert.equal(e1.status, 200, JSON.stringify(e1.body)); assert.equal(e1.body.returned, true); assert.equal(e1.body.amount, 100)
  assert.equal(await balance(vid), 8, 'sem restock: estoque não volta')
  assert.equal((await hook(intA, { type: 'pedido.estornado', id: 'PED-9001', eventId: 'est-1', items: [{ sku, qty: 1 }] })).body.duplicate, true)
  // cancelamento depois de devolução parcial: não é automático → pendência (202)
  const c1 = await hook(intA, { type: 'pedido.cancelado', id: 'PED-9001', eventId: 'canc-1' })
  assert.equal(c1.status, 202); assert.equal(c1.body.pending, true)
  // pedido novo cancelado: venda cancelada, estoque de volta, financeiro estornado
  const r2 = await hook(intA, { ...order, id: 'PED-9002', shippingFee: 0 })
  assert.equal(await balance(vid), 6)
  const c2 = await hook(intA, { type: 'pedido.cancelado', id: 'PED-9002', reason: 'cliente desistiu' })
  assert.equal(c2.status, 200, JSON.stringify(c2.body)); assert.equal(c2.body.cancelled, true)
  assert.equal((await db.query(`SELECT status FROM sales WHERE id = $1`, [r2.body.saleId])).rows[0].status, 'cancelada')
  assert.equal(await balance(vid), 8)
  assert.equal((await hook(intA, { type: 'pedido.cancelado', id: 'PED-9002' })).body.duplicate, true)
  // estorno com devolução ao estoque
  await hook(intA, { ...order, id: 'PED-9003', shippingFee: 0 })
  const e3 = await hook(intA, { type: 'pedido.estornado', id: 'PED-9003', items: [{ sku, qty: 2, restock: true }] })
  assert.equal(e3.body.returned, true); assert.equal(await balance(vid), 8)
  // nota fiscal autorizada: nada é desfeito, vira pendência e aviso no sino
  const r4 = await hook(intA, { ...order, id: 'PED-9004', shippingFee: 0 })
  const br = (await db.query(`SELECT branch_id FROM sales WHERE id = $1`, [r4.body.saleId])).rows[0].branch_id
  await db.query(`INSERT INTO fiscal_documents(company_id, branch_id, model, environment, series, sale_id, status) VALUES ($1,$2,'65','homologacao',1,$3,'autorizado')`, [env.companyA.company.id, br, r4.body.saleId])
  const c4 = await hook(intA, { type: 'pedido.cancelado', id: 'PED-9004' })
  assert.equal(c4.status, 202); assert.match(c4.body.reason, /documento fiscal autorizado/)
  assert.equal((await db.query(`SELECT status FROM sales WHERE id = $1`, [r4.body.saleId])).rows[0].status, 'concluida')
  const nav = await call('GET', '/api/nav/badges', { token: A })
  assert.equal(nav.status, 200); assert.match(JSON.stringify(nav.body), /aviso\(s\) da loja virtual/)
  // pedido desconhecido e tipo inválido
  assert.equal((await hook(intA, { type: 'pedido.cancelado', id: 'NAO-EXISTE' })).status, 404)
  assert.equal((await hook(intA, { type: 'pedido.qualquer', id: 'X' })).status, 422)
  // assinatura de outra loja não vale
  const raw = JSON.stringify({ type: 'pedido.cancelado', id: 'PED-9001' })
  const sigB = crypto.createHmac('sha256', ecommerceWebhookSecret(intB)!).update(raw).digest('hex')
  assert.equal((await fetch(baseUrl() + `/api/webhooks/ecommerce/${intA}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sigB }, body: raw })).status, 401)
})

test('teste do Mercado Pago: valida o token pelas formas de pagamento e explica 401/403', async () => {
  let mode: 'ok' | '401' = 'ok'
  const mp = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (mode === '401') { res.writeHead(401); res.end('{"message":"invalid access token"}'); return }
    if (req.url!.startsWith('/users/me')) { res.writeHead(403); res.end('{"message":"At least one policy returned UNAUTHORIZED."}'); return }
    if (req.url!.startsWith('/v1/payment_methods')) { res.writeHead(200); res.end('[{"id":"pix"},{"id":"visa"}]'); return }
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((r) => mp.listen(0, '127.0.0.1', () => r()))
  process.env.MP_API_URL = `http://127.0.0.1:${(mp.address() as AddressInfo).port}`
  process.env.MP_ACCESS_TOKEN = 'TEST-1234567890-abcdef-0000000000000000000000000000-123456789'
  try {
    const ok = await call('POST', '/api/saas/gateway/test', { token: OWNER, body: {} })
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.live, false); assert.equal(ok.body.methods, 2)
    mode = '401'
    const bad = await call('POST', '/api/saas/gateway/test', { token: OWNER, body: {} })
    assert.equal(bad.status, 502); assert.match(bad.body.error.message, /Public Key/)
  } finally { mp.close() }
})
