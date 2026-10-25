/**
 * Redefine a senha de um usuário existente (recuperação de acesso pelo administrador do servidor).
 *   RESET_EMAIL=fulano@empresa.com RESET_PASSWORD='Nova-Senha-123' npm run reset-password
 * Também desbloqueia a conta (tentativas erradas) e encerra as sessões abertas. Não cria usuários.
 */
import { pool, tx } from '../core/db'
import { hashPassword, passwordPolicy } from '../core/crypto'

async function main() {
  const email = (process.env.RESET_EMAIL || '').trim()
  const password = process.env.RESET_PASSWORD || ''
  if (!email || !password) { console.log('[reset-password] RESET_EMAIL/RESET_PASSWORD não definidos — nada a fazer.'); return }
  const policy = passwordPolicy(password)
  if (policy) throw new Error(policy)
  await tx(async (c) => {
    const u = await c.one(`UPDATE users SET password_hash = $2, failed_attempts = 0, locked_until = NULL, active = true, password_changed_at = now(), updated_at = now()
                            WHERE lower(email) = lower($1) RETURNING id`, [email, hashPassword(password)])
    if (!u) throw new Error(`Usuário ${email} não encontrado. Rode o seed para criá-lo.`)
    await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id])
    await c.query(`INSERT INTO audit_log(user_id, action, entity, entity_id, data, severity) VALUES ($1::uuid, 'usuario.senha_redefinida_servidor', 'user', $2, '{"via":"reset-password"}', 'critical')`, [u.id, String(u.id)])
  })
  console.log(`[reset-password] Senha de ${email} redefinida; conta desbloqueada e sessões encerradas.`)
}

main().then(() => pool.end()).catch(async (e) => { console.error('[reset-password] Falha:', e.message); await pool.end(); process.exitCode = 1 })
