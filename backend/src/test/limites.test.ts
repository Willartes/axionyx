import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, teardown, call, login, PASSWORD } from './helpers'
import { db } from '../core/db'
import { hashPassword } from '../core/crypto'

/**
 * Limites de usuários e filiais: vêm do plano do contrato (ou do limite específico do contrato), contam convites
 * pendentes, valem para criar, convidar e reativar, e não afetam empresas sem contrato.
 */
let env: any, OWNER: string, A: string, B: string, roleV = '', roleVB = '', contractId = ''
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const newUser = (token: string, email: string, roleId = roleV) => call('POST', '/api/admin/users', { token, body: { name: 'Pessoa ' + email.split('@')[0], email, roleId, allBranches: true, password: PASSWORD } })
const newBranch = (token: string, code: string) => call('POST', '/api/admin/branches', { token, body: { code, name: 'Filial ' + code } })

before(async () => {
  env = await setup()
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner) VALUES ('Dono', 'dono@axionyx.test', $1, true, true)`, [hashPassword(PASSWORD)])
  OWNER = (await login('dono@axionyx.test', env.companyA.company.id)).token
  A = (await login('admin.a@teste.local')).token; B = (await login('admin.b@teste.local')).token
  roleV = (await call('GET', '/api/admin/roles', { token: A })).body.find((r: any) => r.name === 'Vendedor').id
  roleVB = (await call('GET', '/api/admin/roles', { token: B })).body.find((r: any) => r.name === 'Vendedor').id
  const plan = await call('POST', '/api/saas/plans', { token: OWNER, body: { name: 'Essencial', priceMonthly: 199, maxUsers: 3, maxBranches: 1 } })
  assert.equal(plan.status, 200, JSON.stringify(plan.body))
  const k = await call('POST', '/api/saas/contracts', { token: OWNER, body: { existingCompanyId: env.companyA.company.id, companyName: 'Loja Teste A Ltda', contactName: 'Admin A', contactEmail: 'admin.a@teste.local', planId: plan.body.id, paidUntil: day(20) } })
  assert.equal(k.status, 200, JSON.stringify(k.body)); contractId = k.body.id
})
after(teardown)

test('empresa sem contrato: sem limite', async () => {
  const l = await call('GET', '/api/admin/limits', { token: B })
  assert.equal(l.status, 200); assert.equal(l.body.contract, false); assert.equal(l.body.users.limit, null); assert.equal(l.body.branches.limit, null)
  for (const n of [1, 2, 3, 4]) { const r = await newUser(B, `b${n}@teste.local`, roleVB); assert.equal(r.status, 200, JSON.stringify(r.body)) }
  assert.equal((await newBranch(B, '002')).status, 200)
})

test('usuários: limite do plano vale para criar, convidar conta existente e reativar', async () => {
  let l = await call('GET', '/api/admin/limits', { token: A })
  assert.deepEqual(l.body.users, { used: 2, limit: 3, source: 'plano' }); assert.equal(l.body.plan, 'Essencial')
  assert.equal((await newUser(A, 'a3@teste.local')).status, 200)
  const over = await newUser(A, 'a4@teste.local')
  assert.equal(over.status, 422); assert.match(over.body.error.message, /O plano desta empresa permite até 3 usuário\(s\) e a empresa já tem 3/)
  // convite para conta que já existe em outra empresa também conta
  assert.equal((await newUser(A, 'b1@teste.local')).status, 422)
  // desativar libera a vaga; reativar quando já está cheio é bloqueado
  const users = (await call('GET', '/api/admin/users', { token: A })).body.items
  const a3 = users.find((u: any) => u.email === 'a3@teste.local')
  assert.equal((await call('PUT', `/api/admin/users/${a3.id}`, { token: A, body: { active: false } })).status, 200)
  l = await call('GET', '/api/admin/limits', { token: A }); assert.equal(l.body.users.used, 2)
  assert.equal((await newUser(A, 'a5@teste.local')).status, 200)
  const re = await call('PUT', `/api/admin/users/${a3.id}`, { token: A, body: { active: true } })
  assert.equal(re.status, 422); assert.match(re.body.error.message, /permite até 3/)
  // editar outros dados de um usuário ativo continua permitido no limite
  const a5 = (await call('GET', '/api/admin/users', { token: A })).body.items.find((u: any) => u.email === 'a5@teste.local')
  assert.equal((await call('PUT', `/api/admin/users/${a5.id}`, { token: A, body: { name: 'Pessoa Cinco' } })).status, 200)
})

test('convite pendente conta; cancelar o convite libera a vaga', async () => {
  const users = (await call('GET', '/api/admin/users', { token: A })).body.items
  const a5 = users.find((u: any) => u.email === 'a5@teste.local')
  await call('PUT', `/api/admin/users/${a5.id}`, { token: A, body: { active: false } })
  const inv = await newUser(A, 'b2@teste.local') // conta de outra empresa: vira convite pendente
  assert.equal(inv.status, 200); assert.equal(inv.body.invitedExisting, true)
  assert.equal((await call('GET', '/api/admin/limits', { token: A })).body.users.used, 3)
  assert.equal((await newUser(A, 'a6@teste.local')).status, 422)
  assert.equal((await call('PUT', `/api/admin/users/${inv.body.id}`, { token: A, body: { active: false } })).body.inviteCancelled, true)
  assert.equal((await call('GET', '/api/admin/limits', { token: A })).body.users.used, 2)
})

test('filiais: limite do plano, limite específico do contrato e reativação', async () => {
  const over = await newBranch(A, '002')
  assert.equal(over.status, 422); assert.match(over.body.error.message, /permite até 1 filial\(is\) ativa\(s\)/)
  // a plataforma amplia só para esta empresa
  assert.equal((await call('PUT', `/api/saas/contracts/${contractId}`, { token: A, body: { maxBranchesOverride: 2 } })).status, 403)
  assert.equal((await call('PUT', `/api/saas/contracts/${contractId}`, { token: OWNER, body: { maxBranchesOverride: 2 } })).status, 200)
  let l = await call('GET', '/api/admin/limits', { token: A }); assert.deepEqual(l.body.branches, { used: 1, limit: 2, source: 'contrato' })
  const b2 = await newBranch(A, '002'); assert.equal(b2.status, 200)
  assert.equal((await newBranch(A, '003')).status, 422)
  assert.equal((await call('PUT', `/api/admin/branches/${b2.body.id}`, { token: A, body: { active: false } })).status, 200)
  const b3 = await newBranch(A, '003'); assert.equal(b3.status, 200)
  const re = await call('PUT', `/api/admin/branches/${b2.body.id}`, { token: A, body: { active: true } })
  assert.equal(re.status, 422)
  // renomear filial ativa no limite continua permitido
  assert.equal((await call('PUT', `/api/admin/branches/${b3.body.id}`, { token: A, body: { name: 'Filial Três' } })).status, 200)
  // voltar a seguir o plano (vazio): nada é desativado sozinho, só bloqueia novas
  assert.equal((await call('PUT', `/api/saas/contracts/${contractId}`, { token: OWNER, body: { maxBranchesOverride: null } })).status, 200)
  l = await call('GET', '/api/admin/limits', { token: A }); assert.deepEqual(l.body.branches, { used: 2, limit: 1, source: 'plano' })
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM branches WHERE company_id = $1 AND active`, [env.companyA.company.id])).rows[0].n, 2)
})

test('suporte da plataforma recebe a orientação de ajustar o contrato; carteira mostra o uso', async () => {
  const r = await newBranch(OWNER, '009')
  assert.equal(r.status, 422); assert.match(r.body.error.message, /Minha Carteira › Clientes e Contratos/)
  const list = await call('GET', '/api/saas/contracts', { token: OWNER })
  const k = list.body.items.find((x: any) => x.id === contractId)
  assert.equal(k.users_limit, 3); assert.equal(k.branches_limit, 1); assert.equal(k.branches, 2)
  const det = await call('GET', `/api/saas/contracts/${contractId}`, { token: OWNER })
  assert.equal(det.body.plan_max_users, 3); assert.equal(det.body.max_branches_override, null)
})

test('concorrência: duas criações simultâneas com uma vaga — só uma passa', async () => {
  await call('PUT', `/api/saas/contracts/${contractId}`, { token: OWNER, body: { maxUsersOverride: 3 } })
  const used = (await call('GET', '/api/admin/limits', { token: A })).body.users.used
  assert.equal(used, 2)
  const [r1, r2] = await Promise.all([newUser(A, 'c1@teste.local'), newUser(A, 'c2@teste.local')])
  assert.deepEqual([r1.status, r2.status].sort(), [200, 422])
  assert.equal((await call('GET', '/api/admin/limits', { token: A })).body.users.used, 3)
})
