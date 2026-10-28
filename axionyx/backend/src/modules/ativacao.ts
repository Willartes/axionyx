import { router, audit, rateLimit, can } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { HttpError, unprocessable, forbidden } from '../core/errors'
import { hashPassword, passwordPolicy } from '../core/crypto'
import { requirePlatform } from '../core/platform'
import { emailStatus, sendEmail } from '../integrations/email'
import { findToken, publicUrl, activationHours, emailDeliveryAvailable } from '../services/activation'

/** Link de ativação/redefinição: consulta e definição da senha (rotas públicas, com limite de tentativas). */
const gone = () => new HttpError(410, 'link_invalido', 'Este link é inválido, já foi usado ou expirou. Peça ao administrador um novo convite.')
const mask = (e: string) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2')

router.get('/api/public/activation', { auth: 'none' }, async (ctx) => {
  rateLimit('ativacao-ver:' + ctx.ip, 30, 10 * 60_000)
  const t = await findToken(db, String(ctx.query.token || ''))
  if (!t || !t.active) throw gone()
  return { kind: t.kind, name: t.name.split(' ')[0], email: mask(t.email), company: t.company_trade || t.company_name || null, expiresAt: t.expires_at }
})

router.post('/api/public/activation', { auth: 'none' }, async (ctx) => {
  rateLimit('ativacao:' + ctx.ip, 10, 10 * 60_000)
  const b = parse(v.object({ token: v.string({ min: 20, max: 100 }), password: v.string({ trim: false }) }), ctx.body)
  const pol = passwordPolicy(b.password); if (pol) throw unprocessable(pol)
  return tx(async (c) => {
    const t = await findToken(c, b.token)
    if (!t || !t.active) throw gone()
    // trava o token: dois envios simultâneos não usam o mesmo link
    const lock = await c.one(`UPDATE user_tokens SET used_at = now(), used_ip = $2 WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`, [t.id, ctx.ip])
    if (!lock) throw gone()
    await c.query(`UPDATE users SET password_hash = $2, pending_activation = false, must_change_password = false, failed_attempts = 0, locked_until = NULL, password_changed_at = now(), updated_at = now() WHERE id = $1`,
      [t.user_id, hashPassword(b.password)])
    await c.query(`UPDATE user_tokens SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND used_at IS NULL AND revoked_at IS NULL`, [t.user_id, t.id])
    await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id])
    await audit(c, ctx, t.kind === 'ativacao' ? 'auth.conta_ativada' : 'auth.senha_redefinida_link', 'user', t.user_id, { ip: ctx.ip }, 'warning',
      { userId: t.user_id, userName: t.name, companyId: t.company_id ?? undefined })
    return { ok: true, email: t.email }
  })
})

/** Disponibilidade do envio por e-mail (para as telas de cadastro de usuários). */
router.get('/api/email/status', {}, async (ctx) => {
  if (!can(ctx.user, 'admin.usuarios') && !ctx.user.isSuperadmin) throw forbidden()
  return { available: emailDeliveryAvailable(), provider: emailStatus().provider, hours: activationHours() }
})

/** Configuração do e-mail da plataforma (somente equipe com "Planos e Mercado Pago"/configuração). */
router.get('/api/platform/email', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.configurar')
  const recent = await db.many(`SELECT el.created_at, el.to_email, el.kind, el.provider, el.status, el.error, u.name AS by_name FROM email_log el LEFT JOIN users u ON u.id = el.created_by ORDER BY el.created_at DESC LIMIT 30`)
  return { ...emailStatus(), publicUrl: publicUrl(), hours: activationHours(), available: emailDeliveryAvailable(), recent }
})

router.post('/api/platform/email/test', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.configurar')
  rateLimit('email-teste:' + ctx.user.id, 5, 10 * 60_000)
  const b = parse(v.object({ to: v.email() }), ctx.body)
  try {
    const r = await sendEmail({ to: b.to, subject: 'Teste de envio — AXIONYX', text: 'Este é um e-mail de teste do AXIONYX. Se você recebeu, o envio está configurado corretamente.',
      html: '<p style="font-family:Arial,sans-serif">Este é um e-mail de teste do <b>AXIONYX</b>. Se você recebeu, o envio está configurado corretamente.</p>' })
    await db.query(`INSERT INTO email_log(to_email, kind, provider, status, provider_id, created_by) VALUES ($1,'teste',$2,'enviado',$3,$4)`, [b.to, r.provider, r.id ?? null, ctx.user.id])
    await audit(null, ctx, 'plataforma.email_teste', null, null, { to: b.to, provider: r.provider })
    return { sent: true, provider: r.provider }
  } catch (e: any) {
    const error = String(e?.message || e).slice(0, 300)
    await db.query(`INSERT INTO email_log(to_email, kind, status, error, created_by) VALUES ($1,'teste','erro',$2,$3)`, [b.to, error, ctx.user.id])
    return { sent: false, error }
  }
})
