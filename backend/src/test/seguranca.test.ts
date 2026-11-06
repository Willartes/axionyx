import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { setup, teardown, call, login, db, PASSWORD, Env } from './helpers'
import { totp, hashPassword, verifyPasswordAsync, needsRehash } from '../core/crypto'
import { clientIp } from '../core/http'
import { ecommerceWebhookSecret } from '../modules/integracoes'

/**
 * Proteções da auditoria de segurança (1.10.2): isolamento de contas entre empresas (convite com aceite; senha/MFA/nome
 * só em conta exclusiva), módulos pela plataforma, sessões por empresa, dados sensíveis fora do alcance do suporte,
 * IP confiável, respostas de login sem revelar contas, MFA sem reuso, webhooks e versão pública.
 */
let E: Env
let A: { token: string; companyId: string; branchId: string }
let B: { token: string; companyId: string; branchId: string }
before(async () => { E = await setup(); A = await login('admin.a@teste.local'); B = await login('admin.b@teste.local') })
after(teardown)
const vend = async (tk: string) => (await call('GET', '/api/admin/roles', { token: tk })).body.find((r: any) => r.name === 'Vendedor').id

test('conta de outra empresa vira convite: sem acesso até aceitar e sem alteração de senha, MFA ou nome', async () => {
  const r = await call('POST', '/api/admin/users', { token: B.token, body: { name: 'Outro Nome', email: 'vend.a@teste.local', roleId: await vend(B.token), allBranches: true } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.invitedExisting, true); assert.equal(r.body.temporaryPassword, undefined)
  const id = r.body.id
  assert.equal(id, E.vendedorA)
  // não ganha acesso à empresa B antes de aceitar
  const l = await call('POST', '/api/auth/login', { body: { email: 'vend.a@teste.local', password: PASSWORD } })
  assert.equal(l.status, 200)
  assert.ok(!l.body.companies.some((c: any) => c.id === B.companyId)); assert.equal(l.body.invitations[0].company_id, B.companyId)
  const br = await call('GET', `/api/auth/companies/${B.companyId}/branches`, { token: l.body.token })
  assert.equal(br.status, 403)
  // a empresa B não altera a conta (vínculo pendente) nem libera o acesso por conta própria
  for (const path of [`/api/admin/users/${id}/reset-password`, `/api/admin/users/${id}/reset-mfa`])
    assert.equal((await call('POST', path, { token: B.token, body: { delivery: 'senha' } })).status, 404, path)
  assert.equal((await call('PUT', `/api/admin/users/${id}`, { token: B.token, body: { active: true } })).status, 422)
  assert.equal((await db.query(`SELECT name FROM users WHERE id = $1`, [id])).rows[0].name, 'Vendedor A')
  assert.equal(await (async () => (await call('POST', '/api/auth/login', { body: { email: 'vend.a@teste.local', password: PASSWORD } })).status)(), 200) // senha intacta

  // aceitou: passa a acessar B, mas a conta é compartilhada — B continua sem poder trocar senha/MFA/nome
  const acc = await call('POST', `/api/auth/invitations/${B.companyId}`, { token: l.body.token, body: { accept: true } })
  assert.equal(acc.status, 200); assert.ok(acc.body.companies.some((c: any) => c.id === B.companyId))
  assert.equal((await call('POST', `/api/admin/users/${id}/reset-password`, { token: B.token, body: { delivery: 'senha' } })).status, 403)
  assert.equal((await call('POST', `/api/admin/users/${id}/reset-mfa`, { token: B.token, body: {} })).status, 403)
  await call('PUT', `/api/admin/users/${id}`, { token: B.token, body: { name: 'Nome Trocado' } })
  assert.equal((await db.query(`SELECT name FROM users WHERE id = $1`, [id])).rows[0].name, 'Vendedor A')
  const list = (await call('GET', '/api/admin/users', { token: B.token })).body.items.find((u: any) => u.id === id)
  assert.equal(list.shared_account, true)
  // B pode remover o acesso dele à empresa B (só o vínculo)
  assert.equal((await call('PUT', `/api/admin/users/${id}`, { token: B.token, body: { active: false } })).status, 200)
})

test('recusar convite remove o vínculo; conta exclusiva da empresa continua administrável por ela', async () => {
  const r = await call('POST', '/api/admin/users', { token: B.token, body: { name: 'Admin Convidado', email: 'admin.a@teste.local', roleId: await vend(B.token), allBranches: true } })
  assert.equal(r.body.invitedExisting, true, JSON.stringify(r.body))
  const l = await call('POST', '/api/auth/login', { body: { email: 'admin.a@teste.local', password: PASSWORD } })
  assert.equal((await call('POST', `/api/auth/invitations/${B.companyId}`, { token: l.body.token, body: { accept: false } })).status, 200)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM user_companies WHERE user_id = $1 AND company_id = $2`, [E.adminA, B.companyId])).rows[0].n, 0)
  // usuário criado pela própria empresa (exclusivo): a empresa redefine normalmente
  const n = await call('POST', '/api/admin/users', { token: A.token, body: { name: 'Exclusivo Teste', email: 'excl@teste.local', roleId: await vend(A.token), allBranches: true, delivery: 'senha' } })
  const rs = await call('POST', `/api/admin/users/${n.body.id}/reset-password`, { token: A.token, body: { delivery: 'senha' } })
  assert.equal(rs.status, 200); assert.ok(rs.body.temporaryPassword)
})

test('módulos/segmento só pela plataforma; sessão de outra empresa não pode ser encerrada', async () => {
  assert.equal((await call('PUT', `/api/admin/companies/${A.companyId}`, { token: A.token, body: { modules: ['fiscal', 'rh', 'juridico'] } })).status, 403)
  assert.equal((await call('PUT', `/api/admin/companies/${A.companyId}`, { token: A.token, body: { active: false } })).status, 403)
  assert.equal((await call('PUT', `/api/admin/companies/${A.companyId}`, { token: A.token, body: { phone: '11999990000' } })).status, 200)
  assert.equal((await call('POST', `/api/admin/companies/${A.companyId}/segment`, { token: A.token, body: { segment: 'adega' } })).status, 403)
  const sid = (await db.query(`SELECT id FROM sessions WHERE company_id = $1 AND revoked_at IS NULL LIMIT 1`, [A.companyId])).rows[0].id
  await call('DELETE', `/api/auth/sessions/${sid}`, { token: B.token })
  assert.equal((await db.query(`SELECT revoked_at FROM sessions WHERE id = $1`, [sid])).rows[0].revoked_at, null)
})

test('equipe da plataforma não lê prontuário nem salários dos clientes', async () => {
  await db.query(`UPDATE users SET is_superadmin = true, platform_owner = true WHERE email = 'admin.b@teste.local'`)
  const P = await login('admin.b@teste.local')
  const fake = '00000000-0000-0000-0000-000000000001'
  assert.equal((await call('GET', `/api/customers/${fake}/clinical`, { token: P.token })).status, 403)
  assert.equal((await call('GET', `/api/customers/${fake}/clinical-documents`, { token: P.token })).status, 403)
  const me = await call('GET', '/api/auth/me', { token: P.token })
  assert.ok(!me.body.permissions.includes('prontuario.ver') && !me.body.permissions.includes('*') && me.body.permissions.includes('vendas.criar'))
  await db.query(`UPDATE users SET is_superadmin = false, platform_owner = false WHERE email = 'admin.b@teste.local'`)
})

test('IP: cabeçalho forjado não engana o limite de tentativas', async () => {
  const req = (xff: string | undefined, remote = '10.0.0.9') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } }) as unknown as IncomingMessage
  process.env.TRUST_PROXY_HOPS = '1'
  assert.equal(clientIp(req('6.6.6.6, 200.1.2.3')), '200.1.2.3') // o proxy da infraestrutura acrescenta o IP real no fim
  process.env.TRUST_PROXY_HOPS = '0'
  assert.equal(clientIp(req('6.6.6.6')), '10.0.0.9')
  // sem proxy (testes): variar o cabeçalho não zera o limite
  let last = 0
  for (let i = 0; i < 22; i++) last = (await call('POST', '/api/auth/login', { body: { email: `ninguem${i}@teste.local`, password: 'x' }, headers: { 'x-forwarded-for': `9.9.9.${i}` } })).status
  assert.equal(last, 429)
  delete process.env.TRUST_PROXY_HOPS
})

test('senha: scrypt reforçado com migração transparente; login não revela se a conta existe', async () => {
  const old = 'scrypt$16384$8$' + Buffer.alloc(16, 1).toString('base64') + '$'
  assert.equal(needsRehash(hashPassword('Abcdefgh12')), false); assert.equal(needsRehash(old + 'x'), true)
  assert.equal(await verifyPasswordAsync('qualquer', ''), false)
})

test('MFA: o mesmo código não pode ser reutilizado', async () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
  await db.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $2, mfa_last_step = NULL WHERE id = $1`, [E.adminB, secret])
  const step = Math.floor(Date.now() / 30000)
  const code = totp(secret, step * 30000)
  const l1 = await call('POST', '/api/auth/login', { body: { email: 'admin.b@teste.local', password: PASSWORD }, headers: { 'x-forwarded-for': '1.1.1.1' } })
  assert.equal((await call('POST', '/api/auth/mfa', { token: l1.body.token, body: { code } })).status, 200)
  const l2 = await call('POST', '/api/auth/login', { body: { email: 'admin.b@teste.local', password: PASSWORD } })
  assert.equal((await call('POST', '/api/auth/mfa', { token: l2.body.token, body: { code } })).status, 401)
  await db.query(`UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_last_step = NULL WHERE id = $1`, [E.adminB])
})

test('versão só autenticada; "esqueci a senha" responde igual; webhooks endurecidos', async () => {
  const h = await call('GET', '/api/health')
  assert.equal(h.status, 200); assert.equal(h.body.version, undefined); assert.equal(h.body.migrations, undefined)
  assert.equal((await call('GET', '/api/version')).status, 401)
  assert.ok((await call('GET', '/api/version', { token: A.token })).body.version)
  const r1 = await call('POST', '/api/public/password-reset', { body: { email: 'admin.a@teste.local' } })
  const r2 = await call('POST', '/api/public/password-reset', { body: { email: 'nao-existe@teste.local' } })
  assert.equal(r1.status, 200); assert.deepEqual(r1.body, r2.body)
  const before = (await db.query(`SELECT count(*)::int AS n FROM saas_gateway_events WHERE payload IS NOT NULL`)).rows[0].n
  const wh = await call('POST', '/api/public/billing/mercadopago?data.id=123&type=payment', { body: { type: 'payment', data: { id: '123' }, lixo: 'x'.repeat(5000) } })
  assert.equal(wh.status, 401)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM saas_gateway_events WHERE payload IS NOT NULL`)).rows[0].n, before)
  process.env.ECOMMERCE_WEBHOOK_SECRET = 'segredo-da-plataforma-' + 'x'.repeat(20)
  const s1 = ecommerceWebhookSecret('11111111-1111-1111-1111-111111111111'), s2 = ecommerceWebhookSecret('22222222-2222-2222-2222-222222222222')
  assert.ok(s1 && s2 && s1 !== s2 && s1 !== process.env.ECOMMERCE_WEBHOOK_SECRET)
  delete process.env.ECOMMERCE_WEBHOOK_SECRET
})

test('administrador cancela convite pendente', async () => {
  const nb = await call('POST', '/api/admin/users', { token: B.token, body: { name: 'Novo da B', email: 'novo.b@teste.local', roleId: await vend(B.token), allBranches: true, delivery: 'senha' } })
  const r = await call('POST', '/api/admin/users', { token: A.token, body: { name: 'Novo da B', email: 'novo.b@teste.local', roleId: await vend(A.token), allBranches: true } })
  assert.equal(r.body.invitedExisting, true, JSON.stringify(r))
  const c = await call('PUT', `/api/admin/users/${r.body.id}`, { token: A.token, body: { active: false } })
  assert.equal(c.body.inviteCancelled, true)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM user_companies WHERE user_id = $1 AND company_id = $2`, [nb.body.id, A.companyId])).rows[0].n, 0)
})
