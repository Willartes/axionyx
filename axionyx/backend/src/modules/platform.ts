import { router, audit, Ctx } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden } from '../core/errors'
import { hashPassword, passwordPolicy, randomCode } from '../core/crypto'
import { PLATFORM_PERMISSIONS, PLATFORM_KEYS, requirePlatform } from '../core/platform'

/**
 * Equipe da plataforma AXIONYX: superadministradores (proprietários e agentes operacionais com permissões limitadas).
 * Regras: só proprietário cria/edita proprietário; ninguém concede permissão que não tem; ninguém altera o próprio acesso;
 * sempre resta pelo menos um proprietário ativo. Membros da equipe nunca aparecem nem contam como usuários das empresas.
 */
const tempPassword = () => `Ax${randomCode(6)}${Math.floor(Math.random() * 90 + 10)}`
const mine = (ctx: Ctx) => (ctx.user.platformOwner ? new Set(PLATFORM_KEYS) : ctx.user.platformPerms)
function checkGrant(ctx: Ctx, perms: string[]) {
  const bad = perms.filter((p) => !PLATFORM_KEYS.includes(p))
  if (bad.length) throw unprocessable(`Permissão desconhecida: ${bad.join(', ')}`)
  const have = mine(ctx)
  const over = perms.filter((p) => !have.has(p))
  if (over.length) throw forbidden(`Você não pode conceder permissões que não possui: ${over.map((p) => PLATFORM_PERMISSIONS.find((x) => x.key === p)?.label).join(', ')}.`)
}
async function target(id: string, ctx: Ctx, forUpdate = false) {
  const t = await db.one(`SELECT id, name, email, active, platform_owner, platform_permissions FROM users WHERE id = $1 AND is_superadmin ${forUpdate ? '' : ''}`, [id])
  if (!t) throw notFound('Membro da equipe')
  if (t.id === ctx.user.id) throw unprocessable('Use Configurações › Minha conta para alterar seus próprios dados.')
  if (t.platform_owner && !ctx.user.platformOwner) throw forbidden('Somente um proprietário pode alterar outro proprietário.')
  return t
}

router.get('/api/platform/permissions', { perm: 'admin.empresas' }, async (ctx) => { requirePlatform(ctx, 'plataforma.equipe'); return PLATFORM_PERMISSIONS })

router.get('/api/platform/team', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'plataforma.equipe')
  return db.many(`SELECT u.id, u.name, u.email, u.active, u.platform_owner, u.platform_permissions, u.platform_title, u.mfa_enabled, u.must_change_password, u.last_login_at, u.locked_until, u.created_at,
                         cb.name AS created_by_name,
                         (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
                         (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now() AND s.stage = 'full') AS active_sessions,
                         (SELECT string_agg(c.trade_name_or, ', ') FROM (SELECT COALESCE(c.trade_name, c.name) AS trade_name_or FROM user_companies uc JOIN companies c ON c.id = uc.company_id WHERE uc.user_id = u.id AND uc.active ORDER BY c.name LIMIT 3) c) AS companies
                    FROM users u LEFT JOIN users cb ON cb.id = u.created_by WHERE u.is_superadmin ORDER BY u.platform_owner DESC, u.active DESC, u.name`)
})

const memberSchema = { name: v.string({ min: 3, max: 120 }), title: v.string({ max: 60 }).optional(), permissions: v.array(v.string(), { max: 30 }).default([]), owner: v.boolean().default(false) }

router.post('/api/platform/team', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'plataforma.equipe')
  const b = parse(v.object({ ...memberSchema, email: v.email(), baseCompanyId: v.uuid().optional(), password: v.string({ trim: false }).optional() }), ctx.body)
  if (b.owner && !ctx.user.platformOwner) throw forbidden('Somente um proprietário pode criar outro proprietário.')
  const perms = b.owner ? [] : [...new Set(b.permissions)]
  if (!b.owner) checkGrant(ctx, perms)
  const pwd = b.password || tempPassword()
  const pol = passwordPolicy(pwd); if (pol) throw unprocessable(pol)
  return tx(async (c) => {
    if (await c.one(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [b.email])) throw conflict('Já existe um usuário com este e-mail. Use outro e-mail para o membro da equipe (contas de clientes não viram superadministrador).')
    const u = await c.one(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner, platform_permissions, platform_title, must_change_password, created_by)
                           VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8) RETURNING id`, [b.name, b.email, hashPassword(pwd), b.owner, perms, b.title ?? null, !b.password, ctx.user.id])
    // empresa base: onde o agente entra quando não pode acessar empresas clientes (padrão: a empresa atual de quem cadastrou)
    const companyId = b.baseCompanyId ?? ctx.user.companyId
    const role = await c.one(`SELECT id FROM roles WHERE company_id = $1 AND name = 'Administrador'`, [companyId])
    if (!role) throw unprocessable('Empresa base sem perfil Administrador.')
    await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`, [u.id, companyId, role.id])
    await audit(c, ctx, 'plataforma.membro_criado', 'user', u.id, { name: b.name, email: b.email, owner: b.owner, permissions: perms }, 'critical')
    return { id: u.id, temporaryPassword: b.password ? undefined : pwd }
  })
})

router.put('/api/platform/team/:id', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'plataforma.equipe')
  const b = parse(v.object({ name: v.string({ min: 3, max: 120 }).optional(), title: v.string({ max: 60 }).optional(), permissions: v.array(v.string(), { max: 30 }).optional(), owner: v.boolean().optional(), active: v.boolean().optional() }), ctx.body)
  const t = await target(ctx.params.id, ctx)
  if (b.owner !== undefined && b.owner !== t.platform_owner && !ctx.user.platformOwner) throw forbidden('Somente um proprietário pode promover ou rebaixar proprietários.')
  const owner = b.owner ?? t.platform_owner
  let perms: string[] = t.platform_permissions
  if (b.permissions) {
    const next = [...new Set(b.permissions)]
    // só valida as permissões que estão sendo ACRESCENTADAS (as que o alvo já tinha podem permanecer)
    checkGrant(ctx, next.filter((p) => !(t.platform_permissions as string[]).includes(p)))
    perms = next
  }
  return tx(async (c) => {
    if ((t.platform_owner && (!owner || b.active === false))) {
      const others = await c.one(`SELECT count(*)::int AS n FROM users WHERE is_superadmin AND platform_owner AND active AND id <> $1`, [t.id])
      if (!others.n) throw unprocessable('É preciso manter pelo menos um proprietário ativo.')
    }
    await c.query(`UPDATE users SET name = COALESCE($2, name), platform_title = CASE WHEN $3::boolean THEN $4 ELSE platform_title END, platform_owner = $5, platform_permissions = $6,
                     active = COALESCE($7, active), updated_at = now() WHERE id = $1`,
      [t.id, b.name ?? null, b.title !== undefined, b.title ?? null, owner, owner ? [] : perms, b.active ?? null])
    // mudou acesso: derruba as sessões para valer na hora
    if (b.active === false || b.permissions || b.owner !== undefined) await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.id])
    await audit(c, ctx, 'plataforma.membro_alterado', 'user', t.id, { ...b, antes: { owner: t.platform_owner, permissions: t.platform_permissions, active: t.active } }, 'critical')
    return { ok: true }
  })
})

router.post('/api/platform/team/:id/reset-password', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'plataforma.equipe')
  const t = await target(ctx.params.id, ctx)
  const temp = tempPassword()
  await db.query(`UPDATE users SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL, password_changed_at = now() WHERE id = $1`, [t.id, hashPassword(temp)])
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.id])
  await audit(null, ctx, 'plataforma.senha_redefinida', 'user', t.id, null, 'critical')
  return { temporaryPassword: temp }
})

router.post('/api/platform/team/:id/reset-mfa', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'plataforma.equipe')
  const t = await target(ctx.params.id, ctx)
  await db.query(`UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`, [t.id])
  await audit(null, ctx, 'plataforma.mfa_redefinido', 'user', t.id, null, 'critical')
  return { ok: true }
})

/** Ações recentes de um membro (auditoria em todas as empresas). */
router.get('/api/platform/team/:id/activity', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'plataforma.equipe')
  const t = await db.one(`SELECT id FROM users WHERE id = $1 AND is_superadmin`, [ctx.params.id])
  if (!t) throw notFound('Membro da equipe')
  return db.many(`SELECT a.id, a.action, a.entity, a.severity, a.created_at, a.ip, COALESCE(c.trade_name, c.name) AS company FROM audit_log a LEFT JOIN companies c ON c.id = a.company_id
                   WHERE a.user_id = $1 ORDER BY a.id DESC LIMIT 100`, [t.id])
})
