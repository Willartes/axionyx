import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from '../config'
import { db, Q } from './db'
import { HttpError, forbidden, unauthorized, fromPg, badRequest, conflict, unprocessable } from './errors'
import { verifyJwt, sha256 } from './crypto'

export type Stage = 'mfa' | 'context' | 'full'

export interface AuthUser {
  id: string
  name: string
  email: string
  sessionId: string
  stage: Stage
  isSuperadmin: boolean
  companyId: string
  branchId: string
  roleId: string
  roleName: string
  permissions: Set<string>
  maxDiscountPct: number
  allBranches: boolean
  branchIds: string[]
  isSeller: boolean
  /** Situação da assinatura AXIONYX da empresa (null = sem contrato/empresa da casa) */
  billingStatus: string | null
}

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  method: string
  path: string
  params: Record<string, string>
  query: Record<string, string>
  body: any
  rawBody: Buffer
  ip: string
  user: AuthUser
  idemKey?: string
  /** Define cabeçalhos/status de resposta customizados */
  reply?: { status?: number; headers?: Record<string, string>; raw?: Buffer | string }
}

export interface RouteOpts {
  /** 'none' = público; 'mfa'/'context' = etapas intermediárias do login; padrão: 'full' */
  auth?: 'none' | Stage
  perm?: string | string[]
  /** Exige cabeçalho Idempotency-Key e guarda a resposta para repetições */
  idempotent?: boolean
  /** Corpo bruto (upload de arquivos) até N bytes */
  maxBody?: number
}
type Handler = (ctx: Ctx) => Promise<unknown>
interface Route { method: string; re: RegExp; keys: string[]; opts: RouteOpts; handler: Handler; pattern: string }

const routes: Route[] = []

export const router = {
  add(method: string, pattern: string, opts: RouteOpts, handler: Handler) {
    const keys: string[] = []
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_m, k) => { keys.push(k); return '/([^/]+)' }) + '/?$')
    routes.push({ method, re, keys, opts, handler, pattern })
  },
  get: (p: string, o: RouteOpts, h: Handler) => router.add('GET', p, o, h),
  post: (p: string, o: RouteOpts, h: Handler) => router.add('POST', p, o, h),
  put: (p: string, o: RouteOpts, h: Handler) => router.add('PUT', p, o, h),
  patch: (p: string, o: RouteOpts, h: Handler) => router.add('PATCH', p, o, h),
  delete: (p: string, o: RouteOpts, h: Handler) => router.add('DELETE', p, o, h),
  list: () => routes.map((r) => `${r.method} ${r.pattern}`),
}

// ---------- Métricas simples para o monitor ----------
export const metrics = { startedAt: Date.now(), requests: 0, errors: 0, byStatus: {} as Record<string, number>, totalMs: 0, slow: [] as { path: string; ms: number; at: string }[] }

// ---------- Rate limit em memória (login e rotas sensíveis) ----------
const buckets = new Map<string, { n: number; reset: number }>()
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return }
  b.n++
  if (b.n > max) throw new HttpError(429, 'muitas_tentativas', 'Muitas tentativas. Aguarde alguns minutos e tente novamente.')
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) { reject(new HttpError(413, 'corpo_grande', 'Conteúdo excede o tamanho máximo permitido.')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function clientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for']
  return (typeof xf === 'string' ? xf.split(',')[0].trim() : '') || req.socket.remoteAddress || ''
}

/** Resolve a sessão a partir do Bearer token e carrega permissões do perfil na empresa selecionada. */
async function authenticate(req: IncomingMessage, required: Stage): Promise<AuthUser> {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!token) throw unauthorized()
  const payload = verifyJwt<{ sid: string; uid: string; stg: Stage }>(token, config.jwtSecret)
  if (!payload) throw unauthorized()
  const s = await db.one(
    `SELECT s.id, s.stage, s.company_id, s.branch_id, s.expires_at, s.revoked_at,
            u.id AS user_id, u.name, u.email, u.active, u.is_superadmin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2`, [payload.sid, payload.uid])
  if (!s || s.revoked_at || new Date(s.expires_at) < new Date() || !s.active) throw unauthorized()
  if (s.stage !== required) {
    if (required === 'full') throw unauthorized('Selecione a empresa e a filial para continuar.')
    throw unauthorized('Etapa de autenticação inválida.')
  }
  const user: AuthUser = {
    id: s.user_id, name: s.name, email: s.email, sessionId: s.id, stage: s.stage, isSuperadmin: s.is_superadmin,
    companyId: s.company_id, branchId: s.branch_id, roleId: '', roleName: '', permissions: new Set(), maxDiscountPct: 0,
    allBranches: false, branchIds: [], isSeller: false, billingStatus: null,
  }
  if (required === 'full') {
    const r = await db.one(
      `SELECT uc.role_id, uc.all_branches, uc.is_seller, r.name AS role_name, r.permissions, r.max_discount_pct,
              COALESCE((SELECT array_agg(branch_id) FROM user_branches ub WHERE ub.user_id = uc.user_id AND ub.company_id = uc.company_id), '{}') AS branch_ids,
              (SELECT sc.status FROM saas_contracts sc WHERE sc.company_id = uc.company_id) AS billing_status
         FROM user_companies uc JOIN roles r ON r.id = uc.role_id
        WHERE uc.user_id = $1 AND uc.company_id = $2 AND uc.active`, [s.user_id, s.company_id])
    if (!r) throw unauthorized('Seu acesso a esta empresa foi removido.')
    user.roleId = r.role_id; user.roleName = r.role_name
    user.permissions = new Set(r.permissions as string[])
    user.maxDiscountPct = Number(r.max_discount_pct)
    user.allBranches = r.all_branches || s.is_superadmin
    user.branchIds = r.branch_ids
    user.isSeller = r.is_seller
    user.billingStatus = r.billing_status ?? null
    if (!user.allBranches && !user.branchIds.includes(s.branch_id)) throw unauthorized('Seu acesso a esta filial foi removido.')
    // atualiza "visto por último" no máximo 1x/min
    db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [s.id]).catch(() => {})
  }
  return user
}

export function can(user: AuthUser, perm: string): boolean {
  return user.isSuperadmin || user.permissions.has(perm)
}
export function requirePerm(user: AuthUser, perm: string | string[]) {
  const list = Array.isArray(perm) ? perm : [perm]
  if (!list.some((p) => can(user, p))) throw forbidden()
}

/** Filiais que o usuário pode consultar. `requested` = 'all' ou id de filial. */
export function branchScope(ctx: Ctx, requested?: string): string[] {
  const u = ctx.user
  if (!requested || requested === 'current') return [u.branchId]
  if (requested === 'all') {
    if (!u.allBranches && !can(u, 'relatorios.todas_filiais')) return u.branchIds.length ? u.branchIds : [u.branchId]
    return [] // vazio = todas as filiais da empresa
  }
  if (!u.allBranches && !u.branchIds.includes(requested)) throw forbidden('Você não tem acesso a esta filial.')
  return [requested]
}

// ---------- Assinatura AXIONYX: bloqueio por situação do contrato ----------
/** Sem pagamento confirmado: só login, perfil e "Minha assinatura". Suspenso/cancelado: somente consulta (dados preservados e exportáveis). */
function billingGate(ctx: Ctx) {
  const st = ctx.user.billingStatus
  if (ctx.path.startsWith('/api/auth/') || ctx.path.startsWith('/api/billing/')) return
  if (st === 'aguardando_pagamento' || st === 'em_analise' || st === 'recusado')
    throw new HttpError(402, 'assinatura_pendente', 'O acesso será liberado assim que o pagamento da assinatura for confirmado. Veja em "Minha assinatura".')
  if ((st === 'suspenso' || st === 'cancelado') && ctx.method !== 'GET')
    throw new HttpError(402, 'assinatura_suspensa', st === 'suspenso'
      ? 'Assinatura suspensa por falta de pagamento: o sistema está em modo somente consulta. Regularize em "Minha assinatura".'
      : 'Assinatura cancelada: o sistema está em modo somente consulta. Seus dados continuam disponíveis para consulta e exportação.')
}

// ---------- Auditoria ----------
const SENSITIVE = /password|senha|secret|token|mfa|cpf|cnpj|salary|salario/i
function scrub(data: any, depth = 0): any {
  if (data === null || typeof data !== 'object' || depth > 4) return data
  if (Array.isArray(data)) return data.slice(0, 50).map((d) => scrub(d, depth + 1))
  const out: any = {}
  for (const [k, val] of Object.entries(data)) out[k] = SENSITIVE.test(k) ? '[protegido]' : scrub(val, depth + 1)
  return out
}
export async function audit(c: Q | null, ctx: Ctx | null, action: string, entity: string | null, entityId: string | null, data?: unknown, severity: 'info' | 'warning' | 'critical' = 'info', override?: { companyId?: string; userId?: string; userName?: string }) {
  const q = c ?? db
  await q.query(
    `INSERT INTO audit_log(company_id, branch_id, user_id, user_name, action, entity, entity_id, data, ip, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [override?.companyId ?? ctx?.user?.companyId ?? null, ctx?.user?.branchId ?? null, override?.userId ?? ctx?.user?.id ?? null,
      override?.userName ?? ctx?.user?.name ?? null, action, entity, entityId, data === undefined ? null : JSON.stringify(scrub(data)), ctx?.ip ?? null, severity],
  )
}

// ---------- Idempotência ----------
async function idemBegin(ctx: Ctx): Promise<{ replay?: { status: number; body: unknown } }> {
  const key = String(ctx.req.headers['idempotency-key'] || '')
  if (!key || key.length < 8 || key.length > 100) throw badRequest('Cabeçalho Idempotency-Key ausente ou inválido para esta operação.')
  ctx.idemKey = key
  const hash = sha256(ctx.method + ctx.path + ctx.rawBody.toString('utf8'))
  const ins = await db.query(
    `INSERT INTO idempotency_keys(company_id, key, method, path, request_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [ctx.user.companyId, key, ctx.method, ctx.path, hash])
  if (ins.rowCount === 1) return {}
  const row = await db.one(`SELECT * FROM idempotency_keys WHERE company_id = $1 AND key = $2`, [ctx.user.companyId, key])
  if (!row) return {}
  if (row.request_hash !== hash) throw unprocessable('Idempotency-Key já utilizada com outro conteúdo.')
  if (row.status_code === null) throw conflict('Esta operação ainda está sendo processada. Aguarde.')
  return { replay: { status: row.status_code, body: row.response } }
}
async function idemFinish(ctx: Ctx, status: number, body: unknown) {
  await db.query(`UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE company_id = $1 AND key = $2`,
    [ctx.user.companyId, ctx.idemKey, status, JSON.stringify(body ?? null)])
}
async function idemAbort(ctx: Ctx) {
  if (ctx.idemKey) await db.query(`DELETE FROM idempotency_keys WHERE company_id = $1 AND key = $2 AND status_code IS NULL`, [ctx.user.companyId, ctx.idemKey]).catch(() => {})
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    res.writeHead(status, headers); res.end(body); return
  }
  const json = JSON.stringify(body === undefined ? { ok: true } : body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(json)
}

export function securityHeaders(res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost')
  const method = (req.method || 'GET').toUpperCase()
  if (!url.pathname.startsWith('/api/')) return false
  const t0 = Date.now()
  metrics.requests++
  let status = 200
  let ctx: Ctx | null = null
  try {
    const route = routes.find((r) => r.method === method && r.re.test(url.pathname))
    if (!route) {
      const exists = routes.some((r) => r.re.test(url.pathname))
      throw new HttpError(exists ? 405 : 404, 'rota_inexistente', exists ? 'Método não permitido.' : 'Recurso não encontrado.')
    }
    const m = url.pathname.match(route.re)!
    const params: Record<string, string> = {}
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])))
    const query: Record<string, string> = {}
    url.searchParams.forEach((v, k) => (query[k] = v))
    const raw = ['GET', 'HEAD', 'DELETE'].includes(method) ? Buffer.alloc(0) : await readBody(req, route.opts.maxBody || 2_000_000)
    let body: any = {}
    const ctype = String(req.headers['content-type'] || '')
    if (raw.length && ctype.includes('application/json')) {
      try { body = JSON.parse(raw.toString('utf8')) } catch { throw badRequest('JSON inválido.') }
    }
    ctx = { req, res, method, path: url.pathname, params, query, body, rawBody: raw, ip: clientIp(req), user: null as any }
    const authMode = route.opts.auth ?? 'full'
    if (authMode !== 'none') ctx.user = await authenticate(req, authMode)
    if (ctx.user?.billingStatus && !ctx.user.isSuperadmin) billingGate(ctx)
    if (route.opts.perm) requirePerm(ctx.user, route.opts.perm)
    if (route.opts.idempotent) {
      const { replay } = await idemBegin(ctx)
      if (replay) { status = replay.status; send(res, status, replay.body, { 'idempotent-replay': 'true' }); return true }
    }
    let result: unknown
    try {
      result = await route.handler(ctx)
    } catch (e) {
      if (route.opts.idempotent) await idemAbort(ctx)
      throw e
    }
    status = ctx.reply?.status ?? (method === 'POST' ? 201 : 200)
    if (route.opts.idempotent) await idemFinish(ctx, status, result)
    send(res, status, ctx.reply?.raw ?? result, ctx.reply?.headers)
  } catch (e: any) {
    const he: HttpError = e instanceof HttpError ? e : fromPg(e) ?? new HttpError(500, 'erro_interno', 'Erro interno. A equipe técnica pode consultar os logs.')
    status = he.status
    if (status >= 500) {
      metrics.errors++
      console.error(`[api] ${method} ${url.pathname}`, e?.stack || e)
      db.query(`INSERT INTO system_events(level, source, message, data) VALUES ('error','api',$1,$2)`, [`${method} ${url.pathname}: ${e?.message}`, JSON.stringify({ code: e?.code })]).catch(() => {})
    }
    send(res, status, { error: { code: he.code, message: he.message, details: he.details } })
  } finally {
    const ms = Date.now() - t0
    metrics.totalMs += ms
    metrics.byStatus[String(status)] = (metrics.byStatus[String(status)] || 0) + 1
    if (ms > 800) { metrics.slow.unshift({ path: `${method} ${url.pathname}`, ms, at: new Date().toISOString() }); metrics.slow.length = Math.min(metrics.slow.length, 20) }
  }
  return true
}

// ---------- Utilitários de paginação/consulta ----------
export function paging(q: Record<string, string>, defSize = 25) {
  const page = Math.max(1, parseInt(q.page || '1', 10) || 1)
  const size = Math.min(500, Math.max(1, parseInt(q.size || String(defSize), 10) || defSize))
  return { page, size, offset: (page - 1) * size }
}
export async function paged<T>(c: Q, sql: string, params: unknown[], q: Record<string, string>, defSize = 25) {
  const { page, size, offset } = paging(q, defSize)
  const rows = await c.many<T & { __total: number }>(`SELECT *, count(*) OVER() AS __total FROM (${sql}) t LIMIT ${size} OFFSET ${offset}`, params)
  const total = rows.length ? Number(rows[0].__total) : offset > 0 ? (await c.one<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`, params))!.n : 0
  rows.forEach((r) => delete (r as any).__total)
  return { items: rows as T[], total, page, size, pages: Math.max(1, Math.ceil(total / size)) }
}
/** Monta cláusulas WHERE incrementais com parâmetros numerados. */
export class Where {
  parts: string[] = []
  params: unknown[] = []
  constructor(initial?: [string, ...unknown[]][]) { initial?.forEach(([s, ...p]) => this.add(s, ...p)) }
  add(sql: string, ...vals: unknown[]) {
    let s = sql
    for (const val of vals) { this.params.push(val); s = s.replace('?', `$${this.params.length}`) }
    this.parts.push(s); return this
  }
  addIf(cond: unknown, sql: string, ...vals: unknown[]) { if (cond !== undefined && cond !== null && cond !== '') this.add(sql, ...vals); return this }
  get sql() { return this.parts.length ? 'WHERE ' + this.parts.join(' AND ') : '' }
  get and() { return this.parts.length ? ' AND ' + this.parts.join(' AND ') : '' }
  p(v: unknown) { this.params.push(v); return `$${this.params.length}` }
}

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
export const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10)
}
export function addMonths(date: string, months: number): string {
  const d = new Date(date + 'T12:00:00Z'); const day = d.getUTCDate()
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10)
}
/** Divide `total` em `n` parcelas com centavos ajustados na primeira. */
export function splitInstallments(total: number, n: number): number[] {
  const cents = Math.round(total * 100)
  const base = Math.floor(cents / n)
  const arr = Array(n).fill(base)
  arr[0] += cents - base * n
  return arr.map((c) => c / 100)
}
