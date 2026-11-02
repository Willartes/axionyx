import { db } from '../core/db'

/**
 * Tarefas demoradas (backup, restauração, importação) rodam em segundo plano; a tela acompanha pelo id.
 * Ao reiniciar o servidor, tarefas que estavam rodando são marcadas como interrompidas.
 */
export async function startJob(kind: string, companyId: string | null, userId: string | null, fn: (progress: (p: Record<string, unknown>) => void) => Promise<unknown>): Promise<string> {
  const j = await db.one(`INSERT INTO platform_jobs(kind, company_id, created_by, status, started_at) VALUES ($1,$2,$3,'executando',now()) RETURNING id`, [kind, companyId, userId])
  let last = 0, pending: Record<string, unknown> | null = null
  const progress = (p: Record<string, unknown>) => {
    pending = p
    if (Date.now() - last < 700) return
    last = Date.now(); const v = pending; pending = null
    db.query(`UPDATE platform_jobs SET progress = $2 WHERE id = $1 AND status = 'executando'`, [j.id, JSON.stringify(v)]).catch(() => {})
  }
  setImmediate(async () => {
    try {
      const result = await fn(progress)
      await db.query(`UPDATE platform_jobs SET status = 'ok', result = $2, progress = COALESCE($3, progress), finished_at = now() WHERE id = $1`, [j.id, JSON.stringify(result ?? null), pending ? JSON.stringify(pending) : null])
    } catch (e: any) {
      await db.query(`UPDATE platform_jobs SET status = 'erro', error = $2, finished_at = now() WHERE id = $1`, [j.id, String(e?.message || e).slice(0, 1000)]).catch(() => {})
    }
  })
  return j.id
}
export async function getJob(id: string) {
  return db.one(`SELECT id, kind, status, company_id, progress, result, error, created_at, started_at, finished_at FROM platform_jobs WHERE id = $1`, [id])
}
/** Na subida do servidor: tarefas que ficaram "executando" foram interrompidas pelo reinício. */
export async function failInterruptedJobs() {
  await db.query(`UPDATE platform_jobs SET status = 'erro', error = 'Interrompida pelo reinício do servidor. Execute de novo.', finished_at = now() WHERE status = 'executando'`).catch(() => {})
  await db.query(`UPDATE backup_files SET status = 'erro', error = 'Interrompido pelo reinício do servidor.', finished_at = now() WHERE status = 'gerando'`).catch(() => {})
  await db.query(`UPDATE migration_batches SET status = 'erro', error = 'Interrompida pelo reinício do servidor.' WHERE status = 'importando'`).catch(() => {})
}
