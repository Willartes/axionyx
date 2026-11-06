import { pool } from '../core/db'
import { migrate } from '../db/migrate'
import { demo } from './mode'
import { hashPassword } from '../core/crypto'
import { seedDemoInstance, markDemoDatabase } from './seed'

/**
 * Proteção principal: o banco só é tratado como de demonstração se NÃO houver nenhuma empresa real (is_demo = false).
 * Assim, ligar DEMO_MODE por engano no serviço de produção nunca apaga nada.
 */
export async function demoDatabaseCheck(): Promise<{ ok: boolean; empty: boolean; reason?: string }> {
  const hasTable = (await pool.query(`SELECT to_regclass('public.companies') IS NOT NULL AS ok`)).rows[0].ok
  if (!hasTable) return { ok: true, empty: true }
  const r = (await pool.query(`SELECT count(*) FILTER (WHERE NOT is_demo)::int AS real, count(*)::int AS total FROM companies`)).rows[0]
  if (r.real > 0) return { ok: false, empty: false, reason: `o banco tem ${r.real} empresa(s) real(is): DEMO_MODE só pode ser usado com um banco exclusivo de demonstração.` }
  const marked = (await pool.query(`SELECT to_regclass('public.demo_instance') IS NOT NULL AS ok`)).rows[0].ok
  if (r.total > 0 && !marked) return { ok: false, empty: false, reason: 'o banco não foi criado pelo ambiente de demonstração (sem a marca demo_instance).' }
  return { ok: true, empty: r.total === 0 }
}

let running: Promise<void> | null = null
/** Apaga e recria o banco de demonstração do zero (estrutura + dados fictícios). */
export function resetDemo(base: string): Promise<void> {
  if (running) return running
  running = (async () => {
    const chk = await demoDatabaseCheck()
    if (!chk.ok) throw new Error('Restauração recusada: ' + chk.reason)
    demo.resetting = true
    try {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
      await migrate(false)
      await markDemoDatabase()
      await seedDemoInstance(base)
      demo.lastResetAt = new Date()
    } finally { demo.resetting = false; running = null }
  })()
  return running
}

/** Restauração automática diária (horário do servidor, TZ da aplicação). */
export function scheduleDemoReset(base: string) {
  const t = setInterval(async () => {
    if (!demo.enabled || demo.resetting) return
    const now = new Date()
    if (now.getHours() !== demo.resetHour) return
    const last = (await pool.query(`SELECT last_reset_at FROM demo_instance WHERE id = 1`).catch(() => ({ rows: [] as any[] }))).rows[0]?.last_reset_at
    if (last && new Date(last).toDateString() === now.toDateString()) return
    console.log('[demo] restauração diária iniciada')
    resetDemo(base).catch((e) => console.error('[demo] falha na restauração:', e.message))
  }, 5 * 60_000)
  t.unref()
}

/**
 * Na subida do serviço: alinha a conta de demonstração com DEMO_LOGIN_EMAIL / DEMO_LOGIN_PASSWORD.
 * - senha trocada na variável → passa a valer sem precisar restaurar;
 * - e-mail trocado, conta ausente ou montagem incompleta (menos de 10 empresas) → pede uma nova montagem.
 */
export async function syncDemoAccount(): Promise<'ok' | 'rebuild' | 'missing'> {
  if (!demo.email || demo.password.length < 10) return 'missing'
  const u = (await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [demo.email])).rows[0]
  const n = (await pool.query(`SELECT count(*)::int AS n FROM companies WHERE is_demo`)).rows[0].n
  if (!u || n < 10) return 'rebuild'
  await pool.query(`UPDATE users SET password_hash = $2, must_change_password = false, mfa_enabled = false, mfa_secret = NULL,
    pending_activation = false, active = true, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1`, [u.id, hashPassword(demo.password)])
  return 'ok'
}
