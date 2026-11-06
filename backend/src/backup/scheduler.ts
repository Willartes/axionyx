import { pool, db } from '../core/db'
import { runBackup } from './engine'
import { deleteFile } from './storage'
import { sendEmail } from '../integrations/email'
import { emailDeliveryAvailable } from '../services/activation'

/**
 * Agendador de backups: roda dentro do servidor, no máximo um por vez (trava no banco, vale também com várias instâncias).
 * Calcula a próxima execução ANTES de rodar (uma falha não fica repetindo em loop), aplica a retenção e avisa por e-mail
 * os proprietários da plataforma quando um backup agendado falha.
 */
export interface ScheduleTime { frequency: 'diario' | 'semanal' | 'mensal'; hour: number; weekday?: number | null; monthday?: number | null }

/** Próxima execução no fuso do servidor (TZ da aplicação), sempre depois de `from`. */
export function nextRun(s: ScheduleTime, from = new Date()): Date {
  const d = new Date(from); d.setMinutes(0, 0, 0); d.setHours(s.hour)
  if (s.frequency === 'diario') { if (d <= from) d.setDate(d.getDate() + 1); return d }
  if (s.frequency === 'semanal') {
    const wd = s.weekday ?? 1
    d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7))
    if (d <= from) d.setDate(d.getDate() + 7)
    return d
  }
  const md = Math.min(28, Math.max(1, s.monthday ?? 1))
  d.setDate(md)
  if (d <= from) { d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(md) }
  return d
}

export async function applyRetention(scheduleId: string, keep: number) {
  const old = await db.many(`SELECT id, storage, storage_key FROM backup_files WHERE schedule_id = $1 AND status = 'ok' ORDER BY created_at DESC OFFSET $2`, [scheduleId, keep])
  for (const b of old) await deleteFile(b).catch((e) => console.error('[backup] falha ao apagar backup antigo:', e.message))
  // backups de segurança (feitos antes de restaurações) ficam 30 dias
  const safety = await db.many(`SELECT id, storage, storage_key FROM backup_files WHERE kind = 'seguranca' AND status = 'ok' AND created_at < now() - interval '30 days'`)
  for (const b of safety) await deleteFile(b).catch(() => {})
  return old.length
}

async function notifyFailure(s: any, error: string) {
  try {
    if (!emailDeliveryAvailable()) return
    const owners = await db.many(`SELECT email, name FROM users WHERE is_superadmin AND platform_owner AND active`)
    const what = s.scope === 'sistema' ? 'do sistema inteiro' : `da empresa ${s.company_name ?? s.company_id}`
    for (const o of owners) await sendEmail({ to: o.email, toName: o.name, subject: `Falha no backup agendado ${what} — AXIONYX`,
      text: `O backup agendado ${what} falhou em ${new Date().toLocaleString('pt-BR')}.\n\nMotivo: ${error}\n\nConfira em Minha Carteira › Backup.`,
      html: `<p style="font-family:Arial,sans-serif">O backup agendado <b>${what}</b> falhou em ${new Date().toLocaleString('pt-BR')}.</p><p style="font-family:Arial,sans-serif">Motivo: ${error.replace(/</g, '&lt;')}</p><p style="font-family:Arial,sans-serif">Confira em Minha Carteira › Backup.</p>` }).catch(() => {})
  } catch { /* aviso é melhor esforço */ }
}

let running = false, lastCheck = 0
/** Chamado pelo worker a cada poucos segundos; verifica agendamentos vencidos no máximo 1 vez por minuto. */
export async function backupTick(appVersion: string, force = false): Promise<number> {
  if (running || (!force && Date.now() - lastCheck < 60_000)) return 0
  lastCheck = Date.now(); running = true
  const lock = await pool.connect()
  let ran = 0
  try {
    const got = (await lock.query(`SELECT pg_try_advisory_lock(hashtext('axionyx-backup-scheduler')) AS ok`)).rows[0].ok
    if (!got) return 0
    try {
      const due = await db.many(`SELECT s.*, c.name AS company_name FROM backup_schedules s LEFT JOIN companies c ON c.id = s.company_id WHERE s.active AND s.next_run_at <= now() ORDER BY s.next_run_at LIMIT 10`)
      for (const s of due) {
        await db.query(`UPDATE backup_schedules SET next_run_at = $2, last_run_at = now(), last_status = 'executando', last_error = NULL WHERE id = $1`, [s.id, nextRun(s)])
        try {
          await runBackup({ scope: s.scope, companyId: s.company_id ?? undefined, kind: 'agendado', scheduleId: s.id, includeDocuments: s.include_documents, userId: null, appVersion })
          await applyRetention(s.id, s.keep)
          await db.query(`UPDATE backup_schedules SET last_status = 'ok' WHERE id = $1`, [s.id])
        } catch (e: any) {
          const msg = String(e?.message || e).slice(0, 500)
          await db.query(`UPDATE backup_schedules SET last_status = 'erro', last_error = $2 WHERE id = $1`, [s.id, msg])
          console.error('[backup] agendado falhou:', msg)
          await notifyFailure(s, msg)
        }
        ran++
      }
    } finally { await lock.query(`SELECT pg_advisory_unlock(hashtext('axionyx-backup-scheduler'))`).catch(() => {}) }
  } catch (e: any) { console.error('[backup] agendador:', e.message) }
  finally { lock.release(); running = false }
  return ran
}
