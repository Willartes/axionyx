import os from 'node:os'
import { router, audit, paged, Where, metrics, can, requirePerm } from '../core/http'
import { db, tx, pool } from '../core/db'
import { v, parse, onlyDigits, isValidCNPJ } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden } from '../core/errors'
import { hashPassword, passwordPolicy, randomCode } from '../core/crypto'
import { PERMISSIONS, ALL_PERMISSIONS } from '../core/permissions'
import { bootstrapCompany } from '../services/bootstrap'
import { getSettings, sanitizeSettings } from '../services/settings'
import { requirePlatform } from '../core/platform'

const address = v.object({ cep: v.string().optional(), logradouro: v.string().optional(), numero: v.string().optional(), complemento: v.string().optional(),
  bairro: v.string().optional(), cidade: v.string().optional(), uf: v.string({ max: 2 }).optional(), codigoMunicipio: v.string({ max: 7 }).optional() }).optional()

// ---------- Empresas e filiais ----------
router.get('/api/admin/companies', { perm: 'admin.empresas' }, async (ctx) => {
  const where = ctx.user.isSuperadmin ? '' : 'WHERE c.id = $1'
  return db.many(`SELECT c.*, (SELECT count(*)::int FROM branches b WHERE b.company_id = c.id) AS branches,
                         (SELECT count(*)::int FROM user_companies uc WHERE uc.company_id = c.id AND uc.active AND NOT EXISTS (SELECT 1 FROM users sx WHERE sx.id = uc.user_id AND sx.is_superadmin)) AS users
                    FROM companies c ${where} ORDER BY c.name`, ctx.user.isSuperadmin ? [] : [ctx.user.companyId])
})

router.post('/api/admin/companies', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'empresas.criar')
  const b = parse(v.object({ name: v.string({ min: 2, max: 150 }), tradeName: v.string({ max: 100 }).optional(), cnpj: v.string().optional(), ie: v.string().optional(),
    taxRegime: v.enum(['simples', 'presumido', 'real', 'mei'] as const).default('simples'), address, branchName: v.string({ min: 2 }).default('Matriz'),
    segment: v.enum(['moda', 'hortifruti', 'adega', 'mercado', 'cosmeticos', 'odontologia', 'estetica', 'salao', 'oficina', 'geral'] as const).default('moda') }), ctx.body)
  if (b.cnpj && !isValidCNPJ(b.cnpj)) throw unprocessable('CNPJ inválido.')
  return tx(async (c) => {
    const r = await bootstrapCompany(c, { name: b.name, tradeName: b.tradeName, cnpj: b.cnpj ? onlyDigits(b.cnpj) : null, ie: b.ie, taxRegime: b.taxRegime, crt: b.taxRegime === 'simples' || b.taxRegime === 'mei' ? 1 : 3,
      address: b.address, segment: b.segment, branch: { code: '001', name: b.branchName, cnpj: b.cnpj ? onlyDigits(b.cnpj) : null, ie: b.ie, address: b.address } })
    await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches) VALUES ($1,$2,$3,true)`, [ctx.user.id, r.company.id, r.roles['Administrador']])
    await audit(c, ctx, 'empresa.criada', 'company', r.company.id, { name: b.name, segment: b.segment }, 'warning', { companyId: r.company.id })
    return r.company
  })
})

router.put('/api/admin/companies/:id', { perm: 'admin.empresas' }, async (ctx) => {
  if (!ctx.user.isSuperadmin && ctx.params.id !== ctx.user.companyId) throw forbidden()
  const b: any = parse(v.object({ name: v.string({ min: 2 }).optional(), trade_name: v.string().optional(), cnpj: v.string().optional(), ie: v.string().optional(),
    tax_regime: v.enum(['simples', 'presumido', 'real', 'mei'] as const).optional(), crt: v.int({ min: 1, max: 4 }).optional(), address, phone: v.string().optional(), email: v.email().optional(), color: v.string().optional(),
    modules: v.array(v.string()).optional(), active: v.boolean().optional() }), ctx.body)
  if (b.cnpj) { if (!isValidCNPJ(b.cnpj)) throw unprocessable('CNPJ inválido.'); b.cnpj = onlyDigits(b.cnpj) }
  const keys = Object.keys(b)
  if (!keys.length) throw unprocessable('Nada para alterar.')
  const r = await db.one(`UPDATE companies SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [ctx.params.id, ...keys.map((k) => (k === 'address' ? JSON.stringify(b[k]) : b[k]))])
  if (!r) throw notFound('Empresa')
  await audit(null, ctx, 'empresa.alterada', 'company', r.id, b, 'warning')
  return r
})

router.get('/api/admin/branches', { perm: 'admin.empresas' }, async (ctx) =>
  db.many(`SELECT b.*, (SELECT count(*)::int FROM user_branches ub WHERE ub.branch_id = b.id) AS users FROM branches b WHERE b.company_id = $1 ORDER BY b.code`, [ctx.user.companyId]))

router.post('/api/admin/branches', { perm: 'admin.empresas' }, async (ctx) => {
  const b = parse(v.object({ code: v.string({ min: 1, max: 10 }), name: v.string({ min: 2, max: 100 }), cnpj: v.string().optional(), ie: v.string().optional(), address, phone: v.string().optional() }), ctx.body)
  if (b.cnpj && !isValidCNPJ(b.cnpj)) throw unprocessable('CNPJ inválido.')
  return tx(async (c) => {
    const r = await c.one(`INSERT INTO branches(company_id, code, name, cnpj, ie, address, phone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ctx.user.companyId, b.code, b.name, b.cnpj ? onlyDigits(b.cnpj) : null, b.ie ?? null, JSON.stringify(b.address ?? {}), b.phone ?? null])
    const acc = await c.one(`INSERT INTO financial_accounts(company_id, branch_id, name, type) VALUES ($1,$2,$3,'caixa') RETURNING id`, [ctx.user.companyId, r.id, `Caixa ${b.name}`])
    await c.query(`INSERT INTO cash_registers(company_id, branch_id, name, account_id) VALUES ($1,$2,'Caixa 01',$3)`, [ctx.user.companyId, r.id, acc.id])
    await audit(c, ctx, 'filial.criada', 'branch', r.id, b, 'warning')
    return r
  })
})

router.put('/api/admin/branches/:id', { perm: 'admin.empresas' }, async (ctx) => {
  const b: any = parse(v.object({ name: v.string({ min: 2 }).optional(), cnpj: v.string().optional(), ie: v.string().optional(), address, phone: v.string().optional(), active: v.boolean().optional() }), ctx.body)
  if (b.cnpj) { if (!isValidCNPJ(b.cnpj)) throw unprocessable('CNPJ inválido.'); b.cnpj = onlyDigits(b.cnpj) }
  const keys = Object.keys(b)
  if (!keys.length) throw unprocessable('Nada para alterar.')
  const r = await db.one(`UPDATE branches SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
    [ctx.params.id, ctx.user.companyId, ...keys.map((k) => (k === 'address' ? JSON.stringify(b[k]) : b[k]))])
  if (!r) throw notFound('Filial')
  await audit(null, ctx, 'filial.alterada', 'branch', r.id, b, 'warning')
  return r
})

router.post('/api/admin/cash-registers', { perm: 'admin.empresas' }, async (ctx) => {
  const b = parse(v.object({ branchId: v.uuid(), name: v.string({ min: 2, max: 40 }) }), ctx.body)
  const br = await db.one(`SELECT id FROM branches WHERE id = $1 AND company_id = $2`, [b.branchId, ctx.user.companyId])
  if (!br) throw notFound('Filial')
  const acc = await db.one(`SELECT id FROM financial_accounts WHERE company_id = $1 AND branch_id = $2 AND type = 'caixa' LIMIT 1`, [ctx.user.companyId, b.branchId])
  return db.one(`INSERT INTO cash_registers(company_id, branch_id, name, account_id) VALUES ($1,$2,$3,$4) RETURNING *`, [ctx.user.companyId, b.branchId, b.name, acc?.id ?? null])
})

// ---------- Usuários ----------
router.get('/api/admin/users', { perm: 'admin.usuarios' }, async (ctx) => {
  const w = new Where([['uc.company_id = ?', ctx.user.companyId]])
  // o superadministrador (suporte da plataforma) não aparece nem conta como usuário da empresa cliente
  w.add('NOT u.is_superadmin')
  if (ctx.query.q) w.add('(u.name ILIKE ? OR u.email ILIKE ?)', `%${ctx.query.q}%`, `%${ctx.query.q}%`)
  return paged(db, `SELECT u.id, u.name, u.email, u.active AND uc.active AS active, u.mfa_enabled, u.last_login_at, u.locked_until, u.created_at, r.id AS role_id, r.name AS role,
                           uc.all_branches, uc.is_seller, uc.commission_pct,
                           COALESCE((SELECT array_agg(ub.branch_id) FROM user_branches ub WHERE ub.user_id = u.id AND ub.company_id = uc.company_id), '{}') AS branch_ids,
                           COALESCE((SELECT string_agg(b.name, ', ') FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = u.id AND ub.company_id = uc.company_id), '') AS branches
                      FROM user_companies uc JOIN users u ON u.id = uc.user_id JOIN roles r ON r.id = uc.role_id ${w.sql} ORDER BY u.name`, w.params, ctx.query, 100)
})

const userSchema = { name: v.string({ min: 3, max: 120 }), email: v.email(), roleId: v.uuid(), allBranches: v.boolean().default(false), branchIds: v.array(v.uuid()).default([]),
  isSeller: v.boolean().default(false), commissionPct: v.number({ min: 0, max: 100 }).optional(), password: v.string({ trim: false }).optional() }

async function saveBranches(c: any, companyId: string, userId: string, all: boolean, ids: string[]) {
  await c.query(`DELETE FROM user_branches WHERE user_id = $1 AND company_id = $2`, [userId, companyId])
  if (all) return
  if (!ids.length) throw unprocessable('Selecione pelo menos uma filial ou marque "todas as filiais".')
  const valid = await c.many(`SELECT id FROM branches WHERE company_id = $1 AND id = ANY($2::uuid[])`, [companyId, ids])
  if (valid.length !== ids.length) throw unprocessable('Filial inválida.')
  for (const b of ids) await c.query(`INSERT INTO user_branches(user_id, company_id, branch_id) VALUES ($1,$2,$3)`, [userId, companyId, b])
}

router.post('/api/admin/users', { perm: 'admin.usuarios' }, async (ctx) => {
  const b = parse(v.object(userSchema), ctx.body)
  const temp = b.password || `Ax${randomCode(6)}${Math.floor(Math.random() * 90 + 10)}`
  const pol = passwordPolicy(temp); if (pol) throw unprocessable(pol)
  return tx(async (c) => {
    const role = await c.one(`SELECT id, permissions FROM roles WHERE id = $1 AND company_id = $2`, [b.roleId, ctx.user.companyId])
    if (!role) throw unprocessable('Perfil inválido.')
    if ((role.permissions as string[]).some((p) => p.startsWith('admin.')) && !can(ctx.user, 'admin.perfis')) throw forbidden('Você não pode atribuir um perfil administrativo.')
    let u = await c.one(`SELECT id FROM users WHERE lower(email) = lower($1)`, [b.email])
    if (u) {
      const linked = await c.one(`SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2`, [u.id, ctx.user.companyId])
      if (linked) throw conflict('Usuário já vinculado a esta empresa.')
    } else {
      u = await c.one(`INSERT INTO users(name, email, password_hash, must_change_password) VALUES ($1,$2,$3,$4) RETURNING id`, [b.name, b.email, hashPassword(temp), !b.password])
    }
    await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches, is_seller, commission_pct) VALUES ($1,$2,$3,$4,$5,$6)`,
      [u.id, ctx.user.companyId, b.roleId, b.allBranches, b.isSeller, b.commissionPct ?? null])
    await saveBranches(c, ctx.user.companyId, u.id, b.allBranches, b.branchIds)
    await audit(c, ctx, 'usuario.criado', 'user', u.id, { name: b.name, email: b.email, roleId: b.roleId }, 'warning')
    return { id: u.id, temporaryPassword: b.password ? undefined : temp }
  })
})

router.put('/api/admin/users/:id', { perm: 'admin.usuarios' }, async (ctx) => {
  const partial: any = {}; for (const [k, s] of Object.entries(userSchema)) partial[k] = (s as any).optional()
  const b: any = parse(v.object({ ...partial, active: v.boolean().optional() }), ctx.body)
  return tx(async (c) => {
    const uc = await c.one(`SELECT * FROM user_companies uc WHERE uc.user_id = $1 AND uc.company_id = $2 AND NOT EXISTS (SELECT 1 FROM users sx WHERE sx.id = uc.user_id AND sx.is_superadmin) FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!uc) throw notFound('Usuário')
    if (ctx.params.id === ctx.user.id && (b.active === false || (b.roleId && b.roleId !== uc.role_id))) throw unprocessable('Você não pode desativar ou alterar o próprio perfil.')
    if (b.name) await c.query(`UPDATE users SET name = $2, updated_at = now() WHERE id = $1`, [ctx.params.id, b.name])
    if (b.roleId) { const r = await c.one(`SELECT 1 FROM roles WHERE id = $1 AND company_id = $2`, [b.roleId, ctx.user.companyId]); if (!r) throw unprocessable('Perfil inválido.') }
    await c.query(`UPDATE user_companies SET role_id = COALESCE($3, role_id), all_branches = COALESCE($4, all_branches), is_seller = COALESCE($5, is_seller),
                     commission_pct = CASE WHEN $7 THEN $6 ELSE commission_pct END, active = COALESCE($8, active) WHERE user_id = $1 AND company_id = $2`,
      [ctx.params.id, ctx.user.companyId, b.roleId ?? null, b.allBranches ?? null, b.isSeller ?? null, b.commissionPct ?? null, 'commissionPct' in ctx.body, b.active ?? null])
    if (b.allBranches !== undefined || b.branchIds) await saveBranches(c, ctx.user.companyId, ctx.params.id, b.allBranches ?? uc.all_branches, b.branchIds ?? [])
    if (b.active === false) await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND company_id = $2 AND revoked_at IS NULL`, [ctx.params.id, ctx.user.companyId])
    await audit(c, ctx, 'usuario.alterado', 'user', ctx.params.id, b, 'warning')
    return { ok: true }
  })
})

router.post('/api/admin/users/:id/reset-password', { perm: 'admin.usuarios' }, async (ctx) => {
  const linked = await db.one(`SELECT 1 FROM user_companies uc WHERE uc.user_id = $1 AND uc.company_id = $2 AND NOT EXISTS (SELECT 1 FROM users sx WHERE sx.id = uc.user_id AND sx.is_superadmin)`, [ctx.params.id, ctx.user.companyId])
  if (!linked) throw notFound('Usuário')
  const temp = `Ax${randomCode(6)}${Math.floor(Math.random() * 90 + 10)}`
  await db.query(`UPDATE users SET password_hash = $2, failed_attempts = 0, locked_until = NULL, password_changed_at = now(), must_change_password = true WHERE id = $1`, [ctx.params.id, hashPassword(temp)])
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [ctx.params.id])
  await audit(null, ctx, 'usuario.senha_redefinida', 'user', ctx.params.id, null, 'critical')
  return { temporaryPassword: temp }
})

router.post('/api/admin/users/:id/reset-mfa', { perm: 'admin.usuarios' }, async (ctx) => {
  const linked = await db.one(`SELECT 1 FROM user_companies uc WHERE uc.user_id = $1 AND uc.company_id = $2 AND NOT EXISTS (SELECT 1 FROM users sx WHERE sx.id = uc.user_id AND sx.is_superadmin)`, [ctx.params.id, ctx.user.companyId])
  if (!linked) throw notFound('Usuário')
  await db.query(`UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`, [ctx.params.id])
  await audit(null, ctx, 'usuario.mfa_redefinido', 'user', ctx.params.id, null, 'critical')
  return { ok: true }
})

// ---------- Perfis e permissões ----------
router.get('/api/admin/permissions', { perm: ['admin.perfis', 'admin.usuarios'] }, async () => PERMISSIONS)
router.get('/api/admin/roles', { perm: ['admin.perfis', 'admin.usuarios'] }, async (ctx) =>
  db.many(`SELECT r.*, (SELECT count(*)::int FROM user_companies uc WHERE uc.role_id = r.id AND uc.active AND NOT EXISTS (SELECT 1 FROM users sx WHERE sx.id = uc.user_id AND sx.is_superadmin)) AS users FROM roles r WHERE r.company_id = $1 ORDER BY r.name`, [ctx.user.companyId]))

const roleSchema = { name: v.string({ min: 2, max: 60 }), description: v.string({ max: 200 }).optional(), permissions: v.array(v.string()), maxDiscountPct: v.number({ min: 0, max: 100 }).default(0) }
router.post('/api/admin/roles', { perm: 'admin.perfis' }, async (ctx) => {
  const b = parse(v.object(roleSchema), ctx.body)
  const perms = b.permissions.filter((p) => ALL_PERMISSIONS.includes(p))
  const r = await db.one(`INSERT INTO roles(company_id, name, description, permissions, max_discount_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [ctx.user.companyId, b.name, b.description ?? null, perms, b.maxDiscountPct])
  await audit(null, ctx, 'perfil.criado', 'role', r.id, b, 'warning')
  return r
})
router.put('/api/admin/roles/:id', { perm: 'admin.perfis' }, async (ctx) => {
  const partial: any = {}; for (const [k, s] of Object.entries(roleSchema)) partial[k] = (s as any).optional()
  const b: any = parse(v.object(partial), ctx.body)
  const cur = await db.one(`SELECT * FROM roles WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!cur) throw notFound('Perfil')
  if (cur.id === ctx.user.roleId && b.permissions && !b.permissions.includes('admin.perfis')) throw unprocessable('Você não pode remover a permissão de perfis do seu próprio perfil.')
  const perms = b.permissions ? b.permissions.filter((p: string) => ALL_PERMISSIONS.includes(p)) : null
  const r = await db.one(`UPDATE roles SET name = COALESCE($3,name), description = COALESCE($4,description), permissions = COALESCE($5,permissions), max_discount_pct = COALESCE($6,max_discount_pct) WHERE id = $1 AND company_id = $2 RETURNING *`,
    [ctx.params.id, ctx.user.companyId, b.name ?? null, b.description ?? null, perms, b.maxDiscountPct ?? null])
  await audit(null, ctx, 'perfil.alterado', 'role', r.id, { ...b, antes: cur.permissions.length, depois: r.permissions.length }, 'critical')
  return r
})
router.delete('/api/admin/roles/:id', { perm: 'admin.perfis' }, async (ctx) => {
  const used = await db.one(`SELECT count(*)::int AS n FROM user_companies WHERE role_id = $1`, [ctx.params.id])
  if (used.n) throw conflict('Perfil em uso por usuários.')
  const r = await db.one(`DELETE FROM roles WHERE id = $1 AND company_id = $2 AND NOT is_system RETURNING id`, [ctx.params.id, ctx.user.companyId])
  if (!r) throw conflict('Perfil do sistema não pode ser excluído.')
  await audit(null, ctx, 'perfil.excluido', 'role', ctx.params.id, null, 'critical')
  return { ok: true }
})

// ---------- Configurações ----------
router.get('/api/settings', {}, async (ctx) => getSettings(db, ctx.user.companyId))
router.put('/api/settings', { perm: 'config.editar' }, async (ctx) => {
  let clean: any
  try { clean = sanitizeSettings(ctx.body) } catch (e: any) { throw unprocessable(e.message) }
  if (clean.fiscal?.ambiente === 'producao') requirePerm(ctx.user, 'fiscal.emitir')
  const cur = (await db.one(`SELECT settings FROM companies WHERE id = $1`, [ctx.user.companyId])).settings || {}
  const merged: any = { ...cur }
  for (const [k, val] of Object.entries(clean)) merged[k] = { ...(cur[k] || {}), ...(val as any) }
  await db.query(`UPDATE companies SET settings = $2, updated_at = now() WHERE id = $1`, [ctx.user.companyId, JSON.stringify(merged)])
  await audit(null, ctx, 'configuracoes.alteradas', 'company', ctx.user.companyId, clean, 'warning')
  return getSettings(db, ctx.user.companyId)
})

// ---------- Auditoria ----------
router.get('/api/audit', { perm: 'auditoria.ver' }, async (ctx) => {
  const q = ctx.query
  const w = new Where([['a.company_id = ?', ctx.user.companyId]])
  w.addIf(q.user, 'a.user_id = ?', q.user).addIf(q.entity, 'a.entity = ?', q.entity).addIf(q.entityId, 'a.entity_id = ?', q.entityId).addIf(q.severity, 'a.severity = ?', q.severity)
    .addIf(q.from, 'a.created_at >= ?::date', q.from).addIf(q.to, "a.created_at < ?::date + interval '1 day'", q.to)
  if (q.q) w.add('(a.action ILIKE ? OR a.user_name ILIKE ? OR a.entity_id = ?)', `%${q.q}%`, `%${q.q}%`, q.q)
  const res = await paged<any>(db, `SELECT a.*, EXISTS (SELECT 1 FROM users sx WHERE sx.id = a.user_id AND sx.is_superadmin) AS by_support FROM audit_log a ${w.sql} ORDER BY a.id DESC`, w.params, q, 50)
  // ações do suporte da plataforma aparecem como "Suporte AXIONYX" para a empresa cliente
  res.items = res.items.map(({ by_support, ...r }: any) => (by_support && !ctx.user.isSuperadmin ? { ...r, user_name: 'Suporte AXIONYX', user_id: null } : r))
  const stats = await db.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE severity = 'critical')::int AS critical, count(*) FILTER (WHERE severity = 'warning')::int AS warning,
                                     count(DISTINCT user_id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM users sx WHERE sx.id = audit_log.user_id AND sx.is_superadmin))::int AS users FROM audit_log WHERE company_id = $1 AND created_at > now() - interval '24 hours'`, [ctx.user.companyId])
  return { ...res, stats }
})

// ---------- Monitoramento ----------
router.get('/api/monitor', { perm: 'monitor.ver' }, async (ctx) => {
  const t0 = Date.now()
  await db.query('SELECT 1')
  const dbLatency = Date.now() - t0
  const size = await db.one(`SELECT pg_database_size(current_database()) AS bytes, version() AS version`)
  const tables = await db.many(`SELECT relname AS table, n_live_tup::int AS rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 12`)
  const errors = await db.many(`SELECT level, source, message, created_at FROM system_events ORDER BY id DESC LIMIT 20`)
  const outbox = await db.one(`SELECT count(*) FILTER (WHERE status IN ('pendente','processando'))::int AS pending, count(*) FILTER (WHERE status = 'erro')::int AS errors FROM outbox WHERE company_id = $1`, [ctx.user.companyId])
  // sessões ativas da empresa, sem contar o suporte da plataforma (o superadministrador vê o total geral)
  const sessions = ctx.user.isSuperadmin
    ? await db.one(`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now() AND stage = 'full' AND last_seen_at > now() - interval '15 minutes'`)
    : await db.one(`SELECT count(*)::int AS n FROM sessions s WHERE s.company_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.stage = 'full' AND s.last_seen_at > now() - interval '15 minutes'
                      AND NOT EXISTS (SELECT 1 FROM users sx WHERE sx.id = s.user_id AND sx.is_superadmin)`, [ctx.user.companyId])
  const mem = process.memoryUsage()
  return {
    api: { uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000), requests: metrics.requests, errors5xx: metrics.errors, byStatus: metrics.byStatus,
      avgMs: metrics.requests ? Math.round(metrics.totalMs / metrics.requests) : 0, slow: metrics.slow, node: process.version, memoryMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
    host: { platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, load: os.loadavg(), freeMemMb: Math.round(os.freemem() / 1048576), totalMemMb: Math.round(os.totalmem() / 1048576) },
    database: { latencyMs: dbLatency, sizeMb: Math.round(Number(size.bytes) / 1048576), version: size.version, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }, tables },
    outbox, activeSessions: sessions.n, recentErrors: errors,
  }
})

/** Exportação dos dados da empresa (backup lógico em JSON). Para backup completo, use pg_dump (docs/OPERACAO.md). */
router.get('/api/admin/export', { perm: 'admin.empresas' }, async (ctx) => {
  const id = ctx.user.companyId
  const tables = ['companies', 'branches', 'roles', 'customers', 'suppliers', 'brands', 'collections', 'categories', 'sizes', 'colors', 'products', 'product_variants', 'stock_balances',
    'sales', 'sale_items', 'sale_payments', 'returns', 'receivables', 'payables', 'financial_accounts', 'financial_transactions', 'conditionals', 'conditional_items', 'consignments', 'consignment_items', 'loyalty_ledger', 'fiscal_documents']
  const data: Record<string, unknown[]> = {}
  for (const t of tables) {
    if (t === 'companies') data[t] = await db.many(`SELECT * FROM companies WHERE id = $1`, [id])
    else if (['sale_items', 'sale_payments'].includes(t)) data[t] = await db.many(`SELECT x.* FROM ${t} x WHERE x.company_id = $1`, [id])
    else if (['conditional_items'].includes(t)) data[t] = await db.many(`SELECT x.* FROM conditional_items x JOIN conditionals k ON k.id = x.conditional_id WHERE k.company_id = $1`, [id])
    else if (['consignment_items'].includes(t)) data[t] = await db.many(`SELECT x.* FROM consignment_items x JOIN consignments k ON k.id = x.consignment_id WHERE k.company_id = $1`, [id])
    else data[t] = await db.many(`SELECT * FROM ${t} WHERE company_id = $1`, [id])
  }
  for (const r of data['fiscal_documents'] as any[]) delete r.xml
  await audit(null, ctx, 'backup.exportacao', 'company', id, { tables: tables.length }, 'critical')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  ctx.reply = { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="axionyx-backup-${stamp}.json"` }, raw: JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data }) }
  return null
})

router.get('/api/admin/backups', { perm: 'admin.empresas' }, async (ctx) =>
  db.many(`SELECT id, CASE WHEN EXISTS (SELECT 1 FROM users sx WHERE sx.id = user_id AND sx.is_superadmin) THEN 'Suporte AXIONYX' ELSE user_name END AS user_name, created_at, data FROM audit_log WHERE company_id = $1 AND action = 'backup.exportacao' ORDER BY id DESC LIMIT 50`, [ctx.user.companyId]))
