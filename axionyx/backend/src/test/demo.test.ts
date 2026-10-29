import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, teardown, call, login } from './helpers'
import { demo, installDemoNetworkGuard, demoBlocks, isDemoAccount, demoLinkUrl } from '../demo/mode'
import { demoDatabaseCheck } from '../demo/reset'
import { secret } from '../config'

/**
 * Ambiente de demonstração: integrações externas desligadas, comunicação só com o próprio servidor, ações restritas
 * para a conta de demonstração e recusa de rodar num banco com empresas reais (proteção da produção).
 */
before(async () => { await setup() })
after(async () => { delete process.env.DEMO_MODE; await teardown() })

test('banco com empresas reais nunca é tratado como demonstração', async () => {
  const chk = await demoDatabaseCheck()
  assert.equal(chk.ok, false); assert.match(chk.reason!, /empresa\(s\) real/)
})

test('link da produção para a demonstração: só https, só a origem', async () => {
  process.env.DEMO_URL = 'https://axionyx-demo.up.railway.app/qualquer?x=1'
  assert.equal(demoLinkUrl(), 'https://axionyx-demo.up.railway.app')
  assert.deepEqual((await call('GET', '/api/public/demo')).body, { demo: false, url: 'https://axionyx-demo.up.railway.app' })
  for (const bad of ['http://exemplo.com', 'javascript:alert(1)', 'https://u:p@exemplo.com', 'nada'])
  { process.env.DEMO_URL = bad; assert.equal(demoLinkUrl(), null, bad) }
  delete process.env.DEMO_URL
  assert.deepEqual((await call('GET', '/api/public/demo')).body, { demo: false })
})

test('modo demonstração: integrações desligadas, rede externa bloqueada, conta restrita', async () => {
  process.env.DEMO_MODE = 'true'; process.env.DEMO_LOGIN_EMAIL = 'demo@exemplo.com'
  process.env.MP_ACCESS_TOKEN = 'TEST-123'; process.env.RESEND_API_KEY = 're_x'
  assert.equal(secret('MP_ACCESS_TOKEN'), undefined); assert.equal(secret('RESEND_API_KEY'), undefined)
  installDemoNetworkGuard()
  await assert.rejects(fetch('https://api.mercadopago.com/v1/payments'), /demonstração/)
  // o próprio servidor continua acessível (montagem dos dados)
  assert.equal((await call('GET', '/api/health')).status, 200)
  assert.equal(isDemoAccount('DEMO@exemplo.com'), true); assert.equal(isDemoAccount('outro@exemplo.com'), false)
  for (const [m, p] of [['POST', '/api/auth/password'], ['POST', '/api/auth/mfa/setup'], ['POST', '/api/admin/users'], ['PUT', '/api/settings'], ['GET', '/api/admin/export'], ['POST', '/api/integrations/x/retry']])
    assert.equal(demoBlocks(m, p), true, `${m} ${p}`)
  for (const [m, p] of [['POST', '/api/sales'], ['GET', '/api/admin/users'], ['POST', '/api/customers']]) assert.equal(demoBlocks(m, p), false, `${m} ${p}`)
  const info = await call('GET', '/api/public/demo')
  assert.equal(info.body.demo, true); assert.equal(info.body.password, undefined) // credenciais só com DEMO_PUBLIC_LOGIN=true
  const A = await login('admin.a@teste.local')
  assert.equal((await call('POST', '/api/demo/reset', { token: A.token })).status, 403) // usuário comum não restaura
  assert.equal(demo.resetting, false)
  for (const k of ['MP_ACCESS_TOKEN', 'RESEND_API_KEY', 'DEMO_LOGIN_EMAIL']) delete process.env[k]
})
