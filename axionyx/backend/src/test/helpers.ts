/**
 * Infraestrutura dos testes de integração: sobe a API em porta aleatória contra um banco DEDICADO de testes.
 * Exige TEST_DATABASE_URL apontando para um banco cujo nome termina em "_test" (o esquema é recriado a cada execução).
 */
import type { AddressInfo } from 'node:net'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl) throw new Error('Defina TEST_DATABASE_URL (ex.: postgres://usuario:senha@localhost:5432/axionyx_test).')
if (!/_test(\?|$)/.test(new URL(testUrl).pathname + (new URL(testUrl).search ? '?' : ''))) throw new Error('Por segurança, o banco de testes deve ter nome terminado em "_test".')
process.env.DATABASE_URL = testUrl
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste-' + 'x'.repeat(40)
process.env.RUN_WORKER = 'false'
for (const k of ['FISCAL_PROVIDER', 'FISCAL_PROVIDER_URL', 'FISCAL_PROVIDER_TOKEN', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'ECOMMERCE_API_URL', 'ECOMMERCE_API_TOKEN', 'LOGISTICS_API_URL', 'LOGISTICS_API_TOKEN', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'APP_PUBLIC_URL']) delete process.env[k]
process.env.CNPJ_LOOKUP = 'off'

/* eslint-disable @typescript-eslint/no-require-imports */
const { pool, tx } = require('../core/db') as typeof import('../core/db')
const { migrate } = require('../db/migrate') as typeof import('../db/migrate')
const { createServer } = require('../server') as typeof import('../server')
const { bootstrapCompany } = require('../services/bootstrap') as typeof import('../services/bootstrap')
const { hashPassword } = require('../core/crypto') as typeof import('../core/crypto')

export const PASSWORD = 'Teste-Senha-2026'
let base = ''
let server: ReturnType<typeof createServer> | null = null

export interface Env { companyA: any; companyB: any; adminA: string; vendedorA: string; adminB: string }

/** Recria o esquema, aplica migrações e cria duas empresas isoladas com usuários. */
export async function setup(): Promise<Env> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await migrate(false)
  const env = await tx(async (c) => {
    const a = await bootstrapCompany(c, { name: 'Loja Teste A Ltda', cnpj: '11222333000181', ie: '110042490114', taxRegime: 'simples', crt: 1,
      address: { logradouro: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP', cep: '01000000', codigoMunicipio: '3550308' },
      branch: { code: '001', name: 'Matriz A', cnpj: '11222333000181', ie: '110042490114' } })
    const b = await bootstrapCompany(c, { name: 'Loja Teste B Ltda', branch: { code: '001', name: 'Matriz B' } })
    const mk = async (name: string, email: string, co: any, role: string, seller = false) => {
      const u = await c.one(`INSERT INTO users(name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`, [name, email, hashPassword(PASSWORD)])
      await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches, is_seller) VALUES ($1,$2,$3,true,$4)`, [u.id, co.company.id, co.roles[role], seller])
      return u.id as string
    }
    return { companyA: a, companyB: b, adminA: await mk('Admin A', 'admin.a@teste.local', a, 'Administrador'), vendedorA: await mk('Vendedor A', 'vend.a@teste.local', a, 'Vendedor', true), adminB: await mk('Admin B', 'admin.b@teste.local', b, 'Administrador') }
  })
  server = createServer()
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  return env
}

export async function teardown() {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  await pool.end()
}

export interface Res { status: number; body: any }
export async function call(method: string, path: string, opts: { token?: string; body?: any; raw?: string; type?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers || {}) }
  if (opts.token) headers.authorization = 'Bearer ' + opts.token
  let body: any
  if (opts.raw !== undefined) { body = opts.raw; headers['content-type'] = opts.type || 'text/plain' }
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] = 'application/json' }
  const r = await fetch(base + path, { method, headers, body })
  const text = await r.text()
  let parsed: any = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* texto puro */ }
  // 201 (criado) é tratado como sucesso equivalente a 200 nas asserções
  return { status: r.status === 201 ? 200 : r.status, body: parsed }
}

/** Login completo (credenciais → contexto empresa/filial) e retorna o token de sessão plena. */
export async function login(email: string, companyId?: string): Promise<{ token: string; companyId: string; branchId: string }> {
  const l = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } })
  if (l.status !== 200) throw new Error('login falhou: ' + JSON.stringify(l.body).slice(0, 300))
  const co = companyId ? l.body.companies.find((c: any) => c.id === companyId) : l.body.companies[0]
  const br = await call('GET', `/api/auth/companies/${co.id}/branches`, { token: l.body.token })
  const ctx = await call('POST', '/api/auth/context', { token: l.body.token, body: { companyId: co.id, branchId: br.body[0].id } })
  if (ctx.status !== 200) throw new Error('contexto falhou: ' + JSON.stringify(ctx.body).slice(0, 300))
  return { token: ctx.body.token, companyId: co.id, branchId: br.body[0].id }
}

export const db = pool
export const baseUrl = () => base

/** Cria uma empresa de um segmento com um administrador (para testes de segmentos). */
export async function createCompanyWithAdmin(name: string, segment: 'moda' | 'hortifruti' | 'adega' | 'mercado' | 'cosmeticos' | 'odontologia' | 'estetica' | 'salao' | 'geral', email: string) {
  return tx(async (c) => {
    const r = await bootstrapCompany(c, { name, segment, branch: { code: '001', name: 'Matriz' } })
    await c.query(`UPDATE companies SET settings = settings || jsonb_build_object('vendas', COALESCE(settings->'vendas', '{}'::jsonb) || '{"exigirCaixaAberto": false}'::jsonb) WHERE id = $1`, [r.company.id])
    const u = await c.one(`INSERT INTO users(name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`, ['Admin ' + name, email, hashPassword(PASSWORD)])
    await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches) VALUES ($1,$2,$3,true)`, [u.id, r.company.id, r.roles['Administrador']])
    return r.company.id as string
  })
}

/** Cria um usuário adicional em uma empresa com o perfil indicado. */
export async function createUser(companyId: string, name: string, email: string, roleName: string) {
  return tx(async (c) => {
    const role = await c.one(`SELECT id FROM roles WHERE company_id = $1 AND name = $2`, [companyId, roleName])
    const u = await c.one(`INSERT INTO users(name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`, [name, email, hashPassword(PASSWORD)])
    await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches) VALUES ($1,$2,$3,true)`, [u.id, companyId, role.id])
    return u.id as string
  })
}
