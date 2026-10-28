import crypto from 'node:crypto'
import { db, Q } from '../core/db'
import { sha256, hashPassword, randomCode } from '../core/crypto'
import { config, secret } from '../config'
import { emailConfigured, sendEmail } from '../integrations/email'

/**
 * Convite e redefinição de senha por link de uso único.
 * - Token aleatório de 256 bits; no banco fica só o SHA-256. Validade: ACTIVATION_HOURS (padrão 48 h).
 * - Gerar um novo link invalida os anteriores do mesmo usuário.
 * - Enquanto não ativa, a conta tem uma senha aleatória que ninguém conhece (não dá para entrar).
 */
export type TokenKind = 'ativacao' | 'redefinicao'
export const activationHours = () => Math.min(168, Math.max(1, Number(secret('ACTIVATION_HOURS') || 48)))
/** Senha que ninguém conhece (conta aguardando ativação ou redefinição por link). */
export const unusablePasswordHash = () => hashPassword(crypto.randomBytes(32).toString('base64url') + 'Aa1!')

/** Endereço público do sistema para montar o link (APP_PUBLIC_URL). Nunca usa o cabeçalho Host da requisição. */
export function publicUrl(): string | null {
  const u = secret('APP_PUBLIC_URL') || (config.env !== 'production' ? config.corsOrigin : '')
  return u ? u.replace(/\/+$/, '') : null
}
/** Envio por e-mail disponível: provedor configurado e endereço público definido. */
export const emailDeliveryAvailable = () => emailConfigured() && !!publicUrl()

export async function createToken(c: Q, userId: string, kind: TokenKind, opts: { companyId?: string | null; createdBy?: string | null } = {}) {
  await c.query(`UPDATE user_tokens SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId])
  const raw = crypto.randomBytes(32).toString('base64url')
  const t = await c.one(`INSERT INTO user_tokens(user_id, kind, token_hash, company_id, expires_at, created_by) VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval,$6) RETURNING id, expires_at`,
    [userId, kind, sha256(raw), opts.companyId ?? null, String(activationHours()), opts.createdBy ?? null])
  return { token: raw, id: t.id, expiresAt: t.expires_at as Date }
}

/** Busca um token válido (não usado, não revogado, não vencido). */
export async function findToken(c: Q, raw: string) {
  if (!raw || raw.length < 20 || raw.length > 100) return null
  return c.one(`SELECT t.*, u.name, u.email, u.active, u.is_superadmin, co.name AS company_name, co.trade_name AS company_trade
                  FROM user_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN companies co ON co.id = t.company_id
                 WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()`, [sha256(raw)])
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))

export function activationEmail(p: { kind: TokenKind; name: string; link: string; company?: string | null; invitedBy?: string | null; hours: number }) {
  const first = p.name.split(' ')[0]
  const isInvite = p.kind === 'ativacao'
  const subject = isInvite ? `Ative seu acesso ao AXIONYX${p.company ? ' — ' + p.company : ''}` : 'Redefinição de senha do AXIONYX'
  const intro = isInvite
    ? `${p.invitedBy ? p.invitedBy + ' criou' : 'Foi criado'} um acesso para você ao AXIONYX${p.company ? `, na empresa ${p.company}` : ''}. Para começar, defina sua senha pelo botão abaixo.`
    : `Foi solicitada a redefinição da sua senha de acesso ao AXIONYX${p.invitedBy ? ` por ${p.invitedBy}` : ''}. Defina uma nova senha pelo botão abaixo.`
  const button = isInvite ? 'Ativar meu acesso' : 'Definir nova senha'
  const text = [`Olá, ${first}!`, '', intro, '', `${button}: ${p.link}`, '', `O link é pessoal, vale por ${p.hours} horas e só pode ser usado uma vez.`,
    'Se você não esperava este e-mail, ignore-o: nenhuma senha foi enviada e nada muda na sua conta.', '', 'AXIONYX — este é um e-mail automático, não responda.'].join('\n')
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F3F6F9;font-family:Arial,Helvetica,sans-serif;color:#172B3A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F6F9;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #DCE4EC;border-radius:12px">
<tr><td style="padding:22px 28px;border-bottom:1px solid #EEF2F6;font-size:20px;font-weight:700;letter-spacing:.04em;color:#0875D1">AXIONYX</td></tr>
<tr><td style="padding:26px 28px 8px;font-size:15px;line-height:1.55">
<p style="margin:0 0 12px">Olá, <b>${esc(first)}</b>!</p>
<p style="margin:0 0 22px">${esc(intro)}</p>
<p style="margin:0 0 24px;text-align:center"><a href="${esc(p.link)}" style="display:inline-block;background:#0875D1;color:#FFFFFF;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:8px">${button}</a></p>
<p style="margin:0 0 8px;font-size:12.5px;color:#475B6E">Se o botão não funcionar, copie e cole este endereço no navegador:<br><span style="word-break:break-all;color:#0875D1">${esc(p.link)}</span></p>
<p style="margin:16px 0 0;font-size:12.5px;color:#475B6E">O link é pessoal, vale por <b>${p.hours} horas</b> e só pode ser usado uma vez. Se você não esperava este e-mail, ignore-o: nenhuma senha foi enviada e nada muda na sua conta.</p>
</td></tr>
<tr><td style="padding:18px 28px 22px;font-size:11.5px;color:#8696A7">E-mail automático do AXIONYX — não responda.</td></tr>
</table></td></tr></table></body></html>`
  return { subject, text, html }
}

/**
 * Gera o link e envia o e-mail (fora de transação: chamada externa). Registra o resultado em email_log.
 * Retorna { sent, to, provider?, error?, expiresAt? } — nunca devolve o token/link para a tela.
 */
export async function sendActivation(userId: string, kind: TokenKind, opts: { companyId?: string | null; createdBy?: string | null; invitedBy?: string | null }) {
  const u = await db.one(`SELECT id, name, email FROM users WHERE id = $1`, [userId])
  if (!u) return { sent: false, to: null, error: 'Usuário não encontrado.' }
  const base = publicUrl()
  if (!emailConfigured() || !base) return { sent: false, to: u.email, error: !base ? 'APP_PUBLIC_URL não configurado.' : 'Envio de e-mail não configurado.' }
  const t = await createToken(db, u.id, kind, { companyId: opts.companyId, createdBy: opts.createdBy })
  const co = opts.companyId ? await db.one(`SELECT COALESCE(trade_name, name) AS n FROM companies WHERE id = $1`, [opts.companyId]) : null
  const msg = activationEmail({ kind, name: u.name, link: `${base}/ativar?token=${t.token}`, company: co?.n ?? null, invitedBy: opts.invitedBy ?? null, hours: activationHours() })
  try {
    const r = await sendEmail({ to: u.email, toName: u.name, ...msg })
    await db.query(`INSERT INTO email_log(user_id, company_id, to_email, kind, provider, status, provider_id, created_by) VALUES ($1,$2,$3,$4,$5,'enviado',$6,$7)`,
      [u.id, opts.companyId ?? null, u.email, kind, r.provider, r.id ?? null, opts.createdBy ?? null])
    return { sent: true, to: u.email, provider: r.provider, expiresAt: t.expiresAt }
  } catch (e: any) {
    // link não chegou: invalida para não ficar um token "solto"
    await db.query(`UPDATE user_tokens SET revoked_at = now() WHERE id = $1`, [t.id])
    const error = String(e?.message || e).slice(0, 300)
    await db.query(`INSERT INTO email_log(user_id, company_id, to_email, kind, provider, status, error, created_by) VALUES ($1,$2,$3,$4,$5,'erro',$6,$7)`,
      [u.id, opts.companyId ?? null, u.email, kind, null, error, opts.createdBy ?? null])
    return { sent: false, to: u.email, error }
  }
}

/** Última situação de convite por usuário (para as listas de usuários e da equipe). */
export const INVITE_SQL = (col: string) => `(SELECT json_build_object('status', el.status, 'at', el.created_at, 'kind', el.kind, 'error', el.error) FROM email_log el WHERE el.user_id = ${col} ORDER BY el.created_at DESC LIMIT 1) AS last_email`

/** Se o e-mail não pôde ser enviado: gera senha temporária (troca obrigatória no 1º acesso) para não deixar a conta sem acesso. */
export async function fallbackTempPassword(userId: string): Promise<string> {
  const temp = `Ax${randomCode(6)}${Math.floor(Math.random() * 90 + 10)}`
  await db.query(`UPDATE users SET password_hash = $2, must_change_password = true, pending_activation = false, password_changed_at = now() WHERE id = $1`, [userId, hashPassword(temp)])
  await db.query(`UPDATE user_tokens SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId])
  return temp
}
/** Convite de conta nova: envia o link; se falhar, devolve senha temporária como alternativa. */
export async function inviteOrFallback(userId: string, opts: { companyId?: string | null; createdBy?: string | null; invitedBy?: string | null }) {
  const invite = await sendActivation(userId, 'ativacao', opts)
  if (invite.sent) return { invite }
  return { invite, temporaryPassword: await fallbackTempPassword(userId) }
}
