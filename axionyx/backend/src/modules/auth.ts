import { segmentInfo } from '../services/segments'
import { router, audit, rateLimit, Ctx, can, PLATFORM_BLOCKED } from '../core/http'
import { ALL_PERMISSIONS } from '../core/permissions'
import { demo, isDemoAccount } from '../demo/mode'
import { db } from '../core/db'
import { config } from '../config'
import { v, parse } from '../core/validate'
import { hashPassword, verifyPassword, verifyPasswordAsync, needsRehash, signJwt, generateTotpSecret, verifyTotp, totpStep, passwordPolicy } from '../core/crypto'
import { unauthorized, forbidden, unprocessable, notFound, HttpError } from '../core/errors'
import { sendActivation, emailDeliveryAvailable } from '../services/activation'
import { getSettings } from '../services/settings'
import { billingSummary } from '../services/billing'
import { PLATFORM_KEYS } from '../core/platform'

async function newSession(userId: string, stage: 'mfa' | 'context' | 'full', ctx: Ctx, opts: { companyId?: string; branchId?: string; minutes?: number } = {}) {
  const minutes = opts.minutes ?? (stage === 'full' ? config.sessionHours * 60 : 15)
  const s = await db.one(
    `INSERT INTO sessions(user_id, stage, company_id, branch_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval) RETURNING id, expires_at`,
    [userId, stage, opts.companyId ?? null, opts.branchId ?? null, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 300), String(minutes)])
  const token = signJwt({ sid: s.id, uid: userId, stg: stage }, config.jwtSecret, minutes * 60)
  return { token, expiresAt: s.expires_at, stage }
}

/** Superadministrador vê todas as empresas se for proprietário ou tiver "Acessar empresas clientes"; senão, só as vinculadas. */
async function seesAllCompanies(userId: string): Promise<boolean> {
  const u = await db.one(`SELECT is_superadmin, platform_owner, platform_permissions FROM users WHERE id = $1`, [userId])
  return !!u?.is_superadmin && (u.platform_owner || (u.platform_permissions as string[]).includes('suporte.acessar'))
}
async function companiesFor(userId: string, _superadmin?: boolean) {
  const superadmin = await seesAllCompanies(userId)
  return db.many(
    `SELECT c.id, c.name, c.trade_name, c.cnpj, c.color, c.is_demo, r.name AS role
       FROM companies c LEFT JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1 AND uc.active
       LEFT JOIN roles r ON r.id = uc.role_id
      WHERE c.active AND (uc.user_id IS NOT NULL OR $2) ORDER BY c.name`, [userId, superadmin])
}

/**
 * Login. Proteções: limite por IP e por e-mail+IP; tempo de resposta igual exista ou não o e-mail; mensagem única para
 * qualquer falha (não revela se a conta existe ou está bloqueada); bloqueio da conta só após muitas falhas vindas de
 * vários lugares (evita que alguém bloqueie a conta de outra pessoa com poucas tentativas).
 */
const GENERIC_FAIL = 'E-mail ou senha inválidos. Após várias tentativas o acesso fica bloqueado por alguns minutos.'
router.post('/api/auth/login', { auth: 'none' }, async (ctx) => {
  rateLimit('login:' + ctx.ip, 20, 10 * 60_000)
  const b = parse(v.object({ email: v.email(), password: v.string({ min: 1, max: 200, trim: false }) }), ctx.body)
  const em = b.email.toLowerCase()
  rateLimit('login-user-ip:' + em + '|' + ctx.ip, 6, 15 * 60_000)
  rateLimit('login-user:' + em, 40, 15 * 60_000)
  const u = await db.one(`SELECT * FROM users WHERE lower(email) = lower($1)`, [b.email])
  const ok = await verifyPasswordAsync(b.password, u?.password_hash ?? '')
  const locked = !!(u?.locked_until && new Date(u.locked_until) > new Date())
  if (!u || !u.active || locked || !ok) {
    if (u && !ok) await db.query(`UPDATE users SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= 30 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id])
    await audit(null, ctx, 'auth.login_falhou', 'user', u?.id ?? null, { email: b.email, reason: !u ? 'usuario_inexistente' : !u.active ? 'inativo' : locked ? 'bloqueado' : 'senha_incorreta' }, 'warning', { userId: u?.id, userName: u?.name })
    throw unauthorized(GENERIC_FAIL)
  }
  await db.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [u.id])
  if (needsRehash(u.password_hash)) await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [u.id, hashPassword(b.password)]).catch(() => {})
  if (u.mfa_enabled) {
    const s = await newSession(u.id, 'mfa', ctx, { minutes: 5 })
    const masked = u.email.replace(/^(.{3}).*(@.*)$/, '$1****$2')
    return { ...s, mfaRequired: true, maskedEmail: masked }
  }
  await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id])
  await audit(null, ctx, 'auth.login', 'user', u.id, { mfa: false }, 'info', { userId: u.id, userName: u.name })
  const s = await newSession(u.id, 'context', ctx)
  return { ...s, mfaRequired: false, user: { id: u.id, name: u.name, email: u.email, mfaEnabled: u.mfa_enabled }, companies: await companiesFor(u.id, u.is_superadmin), invitations: await invitationsFor(u.id) }
})

/** Convites pendentes (vínculos a outras empresas que a própria pessoa ainda não aceitou). */
async function invitationsFor(userId: string) {
  return db.many(`SELECT c.id AS company_id, COALESCE(c.trade_name, c.name) AS company, r.name AS role, uc.invited_at, iu.name AS invited_by
                    FROM user_companies uc JOIN companies c ON c.id = uc.company_id JOIN roles r ON r.id = uc.role_id LEFT JOIN users iu ON iu.id = uc.invited_by
                   WHERE uc.user_id = $1 AND uc.invite_pending AND c.active ORDER BY uc.invited_at DESC`, [userId])
}
router.get('/api/auth/invitations', { auth: 'context' }, async (ctx) => invitationsFor(ctx.user.id))
router.post('/api/auth/invitations/:companyId', { auth: 'context' }, async (ctx) => {
  const b = parse(v.object({ accept: v.boolean() }), ctx.body)
  const r = await db.one(`SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2 AND invite_pending`, [ctx.user.id, ctx.params.companyId])
  if (!r) throw notFound('Convite')
  if (b.accept) await db.query(`UPDATE user_companies SET invite_pending = false, active = true WHERE user_id = $1 AND company_id = $2`, [ctx.user.id, ctx.params.companyId])
  else {
    await db.query(`DELETE FROM user_branches WHERE user_id = $1 AND company_id = $2`, [ctx.user.id, ctx.params.companyId])
    await db.query(`DELETE FROM user_companies WHERE user_id = $1 AND company_id = $2 AND invite_pending`, [ctx.user.id, ctx.params.companyId])
  }
  await audit(null, ctx, b.accept ? 'auth.convite_aceito' : 'auth.convite_recusado', 'company', ctx.params.companyId, null, 'warning', { companyId: ctx.params.companyId, userId: ctx.user.id, userName: ctx.user.name })
  return { companies: await companiesFor(ctx.user.id), invitations: await invitationsFor(ctx.user.id) }
})

/**
 * "Esqueci minha senha": envia link de redefinição se o e-mail existir (resposta sempre igual, sem revelar se existe).
 * Exige o envio de e-mail configurado.
 */
router.post('/api/public/password-reset', { auth: 'none' }, async (ctx) => {
  rateLimit('pwreset-ip:' + ctx.ip, 5, 60 * 60_000)
  const b = parse(v.object({ email: v.email() }), ctx.body)
  rateLimit('pwreset-user:' + b.email.toLowerCase(), 3, 60 * 60_000)
  if (!emailDeliveryAvailable()) return { ok: true, emailEnabled: false }
  const u = await db.one(`SELECT id, active, pending_activation FROM users WHERE lower(email) = lower($1)`, [b.email])
  if (u?.active) {
    const kind = u.pending_activation ? 'ativacao' : 'redefinicao'
    // envio fora do caminho da resposta: o tempo não revela se o e-mail existe
    setImmediate(() => { sendActivation(u.id, kind, { createdBy: null, invitedBy: null }).catch(() => {}) })
    await audit(null, ctx, 'auth.esqueci_senha', 'user', u.id, null, 'warning', { userId: u.id })
  }
  return { ok: true, emailEnabled: true }
})

router.post('/api/auth/mfa', { auth: 'mfa' }, async (ctx) => {
  rateLimit('mfa:' + ctx.user.id, 8, 5 * 60_000)
  const b = parse(v.object({ code: v.string({ min: 6, max: 6, pattern: /^\d{6}$/, patternMsg: 'Código deve ter 6 dígitos.' }) }), ctx.body)
  const u = await db.one(`SELECT * FROM users WHERE id = $1`, [ctx.user.id])
  const step = u?.mfa_secret ? totpStep(u.mfa_secret, b.code, 1, u.mfa_last_step === null ? null : Number(u.mfa_last_step)) : null
  if (step === null) {
    await audit(null, ctx, 'auth.mfa_falhou', 'user', ctx.user.id, null, 'warning', { userId: u?.id, userName: u?.name })
    throw unauthorized('Código inválido ou expirado.')
  }
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [ctx.user.sessionId])
  await db.query(`UPDATE users SET last_login_at = now(), mfa_last_step = $2 WHERE id = $1`, [u.id, step])
  await audit(null, ctx, 'auth.login', 'user', u.id, { mfa: true }, 'info', { userId: u.id, userName: u.name })
  const s = await newSession(u.id, 'context', ctx)
  return { ...s, user: { id: u.id, name: u.name, email: u.email, mfaEnabled: true }, companies: await companiesFor(u.id, u.is_superadmin), invitations: await invitationsFor(u.id) }
})

router.get('/api/auth/companies', { auth: 'context' }, async (ctx) => companiesFor(ctx.user.id, ctx.user.isSuperadmin))

router.get('/api/auth/companies/:id/branches', { auth: 'context' }, async (ctx) => {
  const uc = await db.one(`SELECT all_branches FROM user_companies WHERE user_id = $1 AND company_id = $2 AND active`, [ctx.user.id, ctx.params.id])
  const sees = ctx.user.isSuperadmin && (await seesAllCompanies(ctx.user.id))
  if (!uc && !sees) throw forbidden('Sem acesso a esta empresa.')
  const all = ctx.user.isSuperadmin || uc?.all_branches
  return db.many(
    `SELECT b.id, b.code, b.name, b.cnpj, b.address FROM branches b
      WHERE b.company_id = $1 AND b.active AND ($3 OR EXISTS (SELECT 1 FROM user_branches ub WHERE ub.branch_id = b.id AND ub.user_id = $2))
      ORDER BY b.code`, [ctx.params.id, ctx.user.id, !!all])
})

async function enterContext(ctx: Ctx, companyId: string, branchId: string) {
  const uc = await db.one(`SELECT uc.*, (SELECT true FROM user_branches ub WHERE ub.user_id = uc.user_id AND ub.branch_id = $3) AS has_branch
                             FROM user_companies uc WHERE uc.user_id = $1 AND uc.company_id = $2 AND uc.active`, [ctx.user.id, companyId, branchId])
  if (!ctx.user.isSuperadmin && (!uc || (!uc.all_branches && !uc.has_branch))) throw forbidden('Sem acesso a esta empresa/filial.')
  if (ctx.user.isSuperadmin && !uc && !(await seesAllCompanies(ctx.user.id))) throw forbidden('Seu perfil na equipe não permite acessar empresas clientes.')
  if (ctx.user.isSuperadmin && !uc) {
    // superadministrador sem vínculo: vincula como Administrador para rastreabilidade
    const role = await db.one(`SELECT id FROM roles WHERE company_id = $1 AND name = 'Administrador'`, [companyId])
    if (!role) throw unprocessable('Empresa sem perfil Administrador.')
    await db.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`, [ctx.user.id, companyId, role.id])
  }
  const branch = await db.one(`SELECT id FROM branches WHERE id = $1 AND company_id = $2 AND active`, [branchId, companyId])
  if (!branch) throw unprocessable('Filial inválida.')
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [ctx.user.sessionId])
  const s = await newSession(ctx.user.id, 'full', ctx, { companyId, branchId })
  await audit(null, ctx, 'auth.contexto', 'company', companyId, { branchId }, 'info', { companyId, userId: ctx.user.id, userName: ctx.user.name })
  return s
}

router.post('/api/auth/context', { auth: 'context' }, async (ctx) => {
  const b = parse(v.object({ companyId: v.uuid(), branchId: v.uuid() }), ctx.body)
  return enterContext(ctx, b.companyId, b.branchId)
})

router.post('/api/auth/switch', { auth: 'full' }, async (ctx) => {
  const b = parse(v.object({ companyId: v.uuid(), branchId: v.uuid() }), ctx.body)
  return enterContext(ctx, b.companyId, b.branchId)
})

router.get('/api/auth/me', {}, async (ctx) => {
  const u = ctx.user
  const company = await db.one(`SELECT id, name, trade_name, cnpj, color, is_demo, modules, tax_regime, segment FROM companies WHERE id = $1`, [u.companyId])
  const branch = await db.one(`SELECT id, code, name, cnpj FROM branches WHERE id = $1`, [u.branchId])
  const branches = await db.many(`SELECT id, code, name FROM branches WHERE company_id = $1 AND active ${u.allBranches ? '' : 'AND id = ANY($2::uuid[])'} ORDER BY code`,
    u.allBranches ? [u.companyId] : [u.companyId, u.branchIds])
  const user = await db.one(`SELECT id, name, email, mfa_enabled, is_superadmin, last_login_at, must_change_password, platform_title FROM users WHERE id = $1`, [u.id])
  const settings = await getSettings(db, u.companyId)
  return {
    user: { ...user, role: u.roleName, isSeller: u.isSeller, maxDiscountPct: u.maxDiscountPct, allBranches: u.allBranches },
    company, segment: segmentInfo(company?.segment), branch, branches, permissions: u.isSuperadmin ? ALL_PERMISSIONS.filter((p) => !PLATFORM_BLOCKED.has(p)) : [...u.permissions], settings,
    companies: await companiesFor(u.id, u.isSuperadmin),
    billing: u.billingStatus ? await billingSummary(u.companyId) : null,
    demo: demo.enabled ? { environment: true, account: isDemoAccount(u.email), resetHour: demo.resetHour } : null,
    platform: u.isSuperadmin ? { owner: u.platformOwner, permissions: u.platformOwner ? PLATFORM_KEYS : [...u.platformPerms], title: user?.platform_title ?? null } : null,
  }
})

router.post('/api/auth/logout', { auth: 'full' }, async (ctx) => {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [ctx.user.sessionId])
  await audit(null, ctx, 'auth.logout', 'user', ctx.user.id)
  return { ok: true }
})

router.post('/api/auth/password', {}, async (ctx) => {
  rateLimit('pwchange:' + ctx.user.id, 8, 15 * 60_000)
  const b = parse(v.object({ current: v.string({ trim: false }), next: v.string({ trim: false }) }), ctx.body)
  const u = await db.one(`SELECT * FROM users WHERE id = $1`, [ctx.user.id])
  if (!verifyPassword(b.current, u.password_hash)) throw unprocessable('Senha atual incorreta.')
  const pol = passwordPolicy(b.next); if (pol) throw unprocessable(pol)
  if (verifyPassword(b.next, u.password_hash)) throw unprocessable('A nova senha precisa ser diferente da atual.')
  await db.query(`UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false, updated_at = now() WHERE id = $1`, [u.id, hashPassword(b.next)])
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [u.id, ctx.user.sessionId])
  await audit(null, ctx, 'auth.senha_alterada', 'user', u.id, null, 'warning')
  return { ok: true }
})

router.post('/api/auth/mfa/setup', {}, async (ctx) => {
  const u = await db.one(`SELECT email, mfa_enabled FROM users WHERE id = $1`, [ctx.user.id])
  if (u.mfa_enabled) throw unprocessable('MFA já está ativo. Desative antes de gerar um novo segredo.')
  const secret = generateTotpSecret()
  await db.query(`UPDATE users SET mfa_secret = $2 WHERE id = $1`, [ctx.user.id, secret])
  const label = encodeURIComponent(`AXIONYX:${u.email}`)
  return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=AXIONYX&algorithm=SHA1&digits=6&period=30` }
})

router.post('/api/auth/mfa/enable', {}, async (ctx) => {
  rateLimit('mfaenable:' + ctx.user.id, 8, 15 * 60_000)
  const b = parse(v.object({ code: v.string({ pattern: /^\d{6}$/, patternMsg: 'Código deve ter 6 dígitos.' }) }), ctx.body)
  const u = await db.one(`SELECT mfa_secret FROM users WHERE id = $1`, [ctx.user.id])
  if (!u.mfa_secret || !verifyTotp(u.mfa_secret, b.code)) throw unprocessable('Código inválido. Confira o horário do celular e tente novamente.')
  await db.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [ctx.user.id])
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [ctx.user.id, ctx.user.sessionId])
  await audit(null, ctx, 'auth.mfa_ativado', 'user', ctx.user.id, null, 'warning')
  return { ok: true }
})

router.post('/api/auth/mfa/disable', {}, async (ctx) => {
  rateLimit('mfadisable:' + ctx.user.id, 5, 15 * 60_000)
  const b = parse(v.object({ password: v.string({ trim: false }) }), ctx.body)
  const u = await db.one(`SELECT password_hash FROM users WHERE id = $1`, [ctx.user.id])
  if (!verifyPassword(b.password, u.password_hash)) throw unprocessable('Senha incorreta.')
  await db.query(`UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_last_step = NULL WHERE id = $1`, [ctx.user.id])
  await audit(null, ctx, 'auth.mfa_desativado', 'user', ctx.user.id, null, 'critical')
  return { ok: true }
})

router.get('/api/auth/sessions', {}, async (ctx) =>
  db.many(`SELECT id, ip, user_agent, created_at, last_seen_at, expires_at, (id = $2) AS current FROM sessions
            WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND stage = 'full' ORDER BY last_seen_at DESC`, [ctx.user.id, ctx.user.sessionId]))

router.delete('/api/auth/sessions/:id', {}, async (ctx) => {
  // próprio usuário; ou administrador encerrando sessão de usuário DESTA empresa (nunca de superadministrador)
  await db.query(`UPDATE sessions s SET revoked_at = now() WHERE s.id = $1 AND (s.user_id = $2 OR ($3 AND s.company_id = $4
                    AND EXISTS (SELECT 1 FROM user_companies uc JOIN users u ON u.id = uc.user_id WHERE uc.user_id = s.user_id AND uc.company_id = $4 AND NOT u.is_superadmin)))`,
    [ctx.params.id, ctx.user.id, can(ctx.user, 'admin.usuarios'), ctx.user.companyId])
  return { ok: true }
})
