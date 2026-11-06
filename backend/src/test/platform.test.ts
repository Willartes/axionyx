import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, teardown, call, login, db, Env } from './helpers'
import { hashPassword } from '../core/crypto'

/**
 * Equipe da plataforma: proprietário cria agentes com permissões limitadas; agente só faz o que recebeu,
 * não concede o que não tem, não mexe em proprietário e não aparece/conta como usuário das empresas.
 * Senha temporária obriga a troca antes de usar o sistema.
 */
const PASSWORD = 'Teste-Senha-2026'
let env: Env
let OWNER: string
let A: string
async function loginPwd(email: string, password: string, companyId?: string) {
  const l = await call('POST', '/api/auth/login', { body: { email, password } })
  if (l.status !== 200) return { status: l.status, companies: [] as any[], token: '' }
  const co = companyId ? l.body.companies.find((c: any) => c.id === companyId) : l.body.companies[0]
  if (!co) return { status: 403, companies: l.body.companies, token: '' }
  const br = await call('GET', `/api/auth/companies/${co.id}/branches`, { token: l.body.token })
  const ctx = await call('POST', '/api/auth/context', { token: l.body.token, body: { companyId: co.id, branchId: br.body[0].id } })
  return { status: ctx.status, companies: l.body.companies, token: ctx.body.token as string }
}

before(async () => {
  env = await setup()
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner) VALUES ('Dono', 'dono@axionyx.test', $1, true, true)`, [hashPassword(PASSWORD)])
  OWNER = (await login('dono@axionyx.test', env.companyA.company.id)).token
  A = (await login('admin.a@teste.local')).token
})
after(teardown)

let agentId: string, agentTemp: string, agentToken: string

test('proprietário cadastra agente com permissões; senha temporária obriga a troca', async () => {
  assert.equal((await call('GET', '/api/platform/team', { token: A })).status, 403)
  const perms = await call('GET', '/api/platform/permissions', { token: OWNER })
  assert.ok(perms.body.some((p: any) => p.key === 'suporte.acessar'))
  const r = await call('POST', '/api/platform/team', { token: OWNER, body: { name: 'Agente Operacional', email: 'agente@axionyx.test', title: 'Suporte N1', permissions: ['suporte.acessar', 'carteira.ver'] } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.temporaryPassword)
  agentId = r.body.id; agentTemp = r.body.temporaryPassword
  const s = await loginPwd('agente@axionyx.test', agentTemp, env.companyB.company.id)
  assert.equal(s.status, 200)
  // vê todas as empresas (acessar empresas clientes)
  assert.ok(s.companies.length >= 2)
  const me = await call('GET', '/api/auth/me', { token: s.token })
  assert.equal(me.body.user.must_change_password, true)
  assert.deepEqual(me.body.platform.permissions.sort(), ['carteira.ver', 'suporte.acessar'])
  const blocked = await call('GET', '/api/products', { token: s.token })
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'troca_de_senha')
  const pw = await call('POST', '/api/auth/password', { token: s.token, body: { current: agentTemp, next: 'Agente-Nova-2026' } })
  assert.equal(pw.status, 200)
  agentToken = (await loginPwd('agente@axionyx.test', 'Agente-Nova-2026', env.companyB.company.id)).token
  assert.equal((await call('GET', '/api/products', { token: agentToken })).status, 200)
})

test('agente sem "Alterar dados" só consulta as empresas e só usa a carteira para leitura', async () => {
  const w = await call('POST', '/api/customers', { token: agentToken, body: { name: 'Cliente Pelo Suporte' } })
  assert.equal(w.status, 403)
  assert.equal((await call('GET', '/api/saas/dashboard', { token: agentToken })).status, 200)
  assert.equal((await call('POST', '/api/saas/plans', { token: agentToken, body: { name: 'X', priceMonthly: 10 } })).status, 403)
  assert.equal((await call('POST', '/api/saas/run-billing', { token: agentToken, body: {} })).status, 403)
  assert.equal((await call('GET', '/api/platform/team', { token: agentToken })).status, 403)
  assert.equal((await call('POST', '/api/admin/companies', { token: agentToken, body: { name: 'Nova Ltda' } })).status, 403)
  // pode trocar a própria senha mesmo sendo somente consulta
  assert.equal((await call('POST', '/api/auth/password', { token: agentToken, body: { current: 'Agente-Nova-2026', next: 'Agente-Outra-2026' } })).status, 200)
})

test('superadministradores não aparecem nem contam como usuários da empresa cliente', async () => {
  const users = await call('GET', '/api/admin/users', { token: A })
  assert.ok(!users.body.items.some((u: any) => /axionyx\.test/.test(u.email)))
  const cos = await call('GET', '/api/admin/companies', { token: OWNER })
  const b = cos.body.find((c: any) => c.id === env.companyB.company.id)
  assert.equal(b.users, 1, 'só o Admin B, sem o dono e o agente que entraram na empresa')
  const roles = await call('GET', '/api/admin/roles', { token: A })
  assert.equal(roles.body.find((r: any) => r.name === 'Administrador').users, 1)
  // o admin da empresa não consegue redefinir a senha de um superadministrador
  assert.equal((await call('POST', `/api/admin/users/${agentId}/reset-password`, { token: A })).status, 404)
})

test('regras da equipe: não concede o que não tem, não mexe em proprietário, mantém um proprietário', async () => {
  // agente com permissão de equipe, mas sem financeiro
  const m = await call('POST', '/api/platform/team', { token: OWNER, body: { name: 'Coordenadora', email: 'coord@axionyx.test', permissions: ['plataforma.equipe', 'carteira.ver', 'carteira.propostas'], password: 'Coord-Senha-2026' } })
  assert.equal(m.status, 200)
  const C = (await loginPwd('coord@axionyx.test', 'Coord-Senha-2026')).token
  assert.ok(C)
  const over = await call('POST', '/api/platform/team', { token: C, body: { name: 'Novo', email: 'novo@axionyx.test', permissions: ['carteira.financeiro'] } })
  assert.equal(over.status, 403)
  const owner = await call('POST', '/api/platform/team', { token: C, body: { name: 'Novo Dono', email: 'novodono@axionyx.test', owner: true } })
  assert.equal(owner.status, 403)
  const ok = await call('POST', '/api/platform/team', { token: C, body: { name: 'Estagiário', email: 'estag@axionyx.test', permissions: ['carteira.ver'] } })
  assert.equal(ok.status, 200)
  // não altera proprietário nem a si mesmo
  const ownerId = (await db.query(`SELECT id FROM users WHERE email = 'dono@axionyx.test'`)).rows[0].id
  assert.equal((await call('PUT', `/api/platform/team/${ownerId}`, { token: C, body: { active: false } })).status, 403)
  const coordId = (await db.query(`SELECT id FROM users WHERE email = 'coord@axionyx.test'`)).rows[0].id
  assert.equal((await call('PUT', `/api/platform/team/${coordId}`, { token: C, body: { permissions: PLATFORM_ALL } })).status, 422)
  // proprietário não pode se desativar e não pode ficar sem nenhum proprietário
  assert.equal((await call('PUT', `/api/platform/team/${ownerId}`, { token: OWNER, body: { active: false } })).status, 422)
  // proprietário amplia o agente: vale na hora (sessões derrubadas)
  const up = await call('PUT', `/api/platform/team/${agentId}`, { token: OWNER, body: { permissions: ['suporte.acessar', 'suporte.editar', 'carteira.ver'] } })
  assert.equal(up.status, 200)
  assert.equal((await call('GET', '/api/products', { token: agentToken })).status, 401)
  const t2 = (await loginPwd('agente@axionyx.test', 'Agente-Outra-2026', env.companyB.company.id)).token
  assert.equal((await call('POST', '/api/customers', { token: t2, body: { name: 'Cliente Pelo Suporte' } })).status, 200)
  // desativado: não entra mais
  await call('PUT', `/api/platform/team/${agentId}`, { token: OWNER, body: { active: false } })
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'agente@axionyx.test', password: 'Agente-Outra-2026' } })).status, 401)
  const team = await call('GET', '/api/platform/team', { token: OWNER })
  assert.equal(team.body.length, 4)
  const act = await call('GET', `/api/platform/team/${agentId}/activity`, { token: OWNER })
  assert.ok(act.body.some((a: any) => a.action === 'auth.login'))
})

test('agente sem "Acessar empresas clientes" só entra na empresa base', async () => {
  const r = await call('POST', '/api/platform/team', { token: OWNER, body: { name: 'Financeiro', email: 'fin@axionyx.test', permissions: ['carteira.ver', 'carteira.financeiro'], password: 'Financ-Senha-2026' } })
  assert.equal(r.status, 200)
  const l = await call('POST', '/api/auth/login', { body: { email: 'fin@axionyx.test', password: 'Financ-Senha-2026' } })
  assert.equal(l.body.companies.length, 1); assert.equal(l.body.companies[0].id, env.companyA.company.id)
  const br = await call('GET', `/api/auth/companies/${env.companyB.company.id}/branches`, { token: l.body.token })
  assert.equal(br.status, 403)
})

const PLATFORM_ALL = ['suporte.acessar', 'suporte.editar', 'empresas.criar', 'carteira.ver', 'carteira.propostas', 'carteira.aprovar', 'carteira.financeiro', 'carteira.configurar', 'plataforma.equipe']
