import { router, audit, rateLimit } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { forbidden, notFound, unprocessable } from '../core/errors'
import { requirePlatform } from '../core/platform'
import { APP_VERSION } from './nav'
import { runBackup, loadBackupFile, restoreCompany, openBackup, keySource, keyFingerprint } from '../backup/engine'
import { s3Config, storageKind, testStorage, deleteFile, putFile, objectKey } from '../backup/storage'
import { startJob, getJob } from '../backup/jobs'
import { nextRun } from '../backup/scheduler'
import { indexPending } from '../ai/documents'
import crypto from 'node:crypto'

/** Backup e restauração: exclusivo da equipe da plataforma com a permissão "Backup e restauração". */
const P = { perm: 'admin.empresas' } as const
const guard = (ctx: any) => requirePlatform(ctx, 'plataforma.backup')

router.get('/api/platform/backup', P, async (ctx) => {
  guard(ctx)
  const cfg = s3Config()
  const [files, schedules, companies, jobs] = await Promise.all([
    db.many(`SELECT b.id, b.scope, b.company_id, b.company_name, b.kind, b.status, b.storage, b.size, b.tables, b.rows, b.include_documents, b.app_version, b.created_at, b.finished_at, b.error, u.name AS created_by_name
               FROM backup_files b LEFT JOIN users u ON u.id = b.created_by WHERE b.status <> 'excluido' ORDER BY b.created_at DESC LIMIT 150`),
    db.many(`SELECT s.*, c.name AS company_name FROM backup_schedules s LEFT JOIN companies c ON c.id = s.company_id ORDER BY s.scope DESC, c.name NULLS FIRST`),
    db.many(`SELECT id, name, trade_name, is_demo FROM companies WHERE active ORDER BY name`),
    db.many(`SELECT id, kind, status, company_id, progress, error, created_at, finished_at FROM platform_jobs WHERE kind LIKE 'backup%' OR kind LIKE 'restaur%' ORDER BY created_at DESC LIMIT 10`),
  ])
  return { storage: storageKind(), s3: cfg ? { endpoint: new URL(cfg.endpoint).host, bucket: cfg.bucket, prefix: cfg.prefix } : null, key: { source: keySource(), fingerprint: (() => { try { return keyFingerprint() } catch { return null } })() },
    files, schedules, companies, jobs, canReplace: ctx.user.platformOwner }
})

router.post('/api/platform/backup/test-storage', P, async (ctx) => { guard(ctx); rateLimit('bk-teste:' + ctx.user.id, 10, 10 * 60_000); return testStorage() })

router.post('/api/platform/backups', P, async (ctx) => {
  guard(ctx)
  const b = parse(v.object({ scope: v.enum(['sistema', 'empresa'] as const), companyId: v.uuid().optional(), includeDocuments: v.boolean().default(true) }), ctx.body)
  if (b.scope === 'empresa' && !b.companyId) throw unprocessable('Escolha a empresa.')
  if (b.scope === 'empresa' && !(await db.one(`SELECT 1 FROM companies WHERE id = $1`, [b.companyId]))) throw notFound('Empresa')
  rateLimit('bk-manual:' + ctx.user.id, 20, 60 * 60_000)
  const busy = await db.one(`SELECT 1 FROM backup_files WHERE status = 'gerando' AND scope = $1 AND company_id IS NOT DISTINCT FROM $2`, [b.scope, b.scope === 'empresa' ? b.companyId : null])
  if (busy) throw unprocessable('Já existe um backup sendo gerado para este escopo. Aguarde terminar.')
  await audit(null, ctx, 'backup.solicitado', b.scope === 'empresa' ? 'company' : null, b.companyId ?? null, b, 'warning', b.companyId ? { companyId: b.companyId } : undefined)
  const jobId = await startJob('backup', b.companyId ?? null, ctx.user.id, (progress) =>
    runBackup({ scope: b.scope, companyId: b.companyId, kind: 'manual', includeDocuments: b.includeDocuments, userId: ctx.user.id, appVersion: APP_VERSION, onProgress: progress }))
  return { jobId }
})

router.get('/api/platform/jobs/:id', P, async (ctx) => {
  if (!ctx.user.isSuperadmin) throw forbidden()
  const j = await getJob(ctx.params.id)
  if (!j) throw notFound('Tarefa')
  return j
})

router.get('/api/platform/backups/:id/download', P, async (ctx) => {
  guard(ctx)
  rateLimit('bk-download:' + ctx.user.id, 30, 60 * 60_000)
  let f
  try { f = await loadBackupFile(ctx.params.id) } catch (e: any) { throw unprocessable(e.message) }
  await audit(null, ctx, 'backup.baixado', 'backup', f.row.id, { scope: f.row.scope, company: f.row.company_name }, 'critical', f.row.company_id ? { companyId: f.row.company_id } : undefined)
  const name = `axionyx-${f.row.scope === 'sistema' ? 'sistema' : (f.row.company_name || 'empresa').normalize('NFD').replace(/[^\w]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.axbak`
  ctx.reply = { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' }, raw: f.data }
  return null
})

/** Envia um arquivo .axbak (ex.: de outra instalação ou guardado fora) para poder restaurá-lo aqui. */
router.post('/api/platform/backups/upload', { ...P, maxBody: 300_000_000 }, async (ctx) => {
  guard(ctx)
  if (!ctx.rawBody?.length) throw unprocessable('Envie o arquivo .axbak.')
  let header
  try { header = openBackup(ctx.rawBody).header } catch (e: any) { throw unprocessable(e.message) }
  const row = await db.one(`INSERT INTO backup_files(scope, company_id, company_name, kind, storage, include_documents, created_by, app_version, migrations, status)
                            VALUES ($1, (SELECT id FROM companies WHERE id = $2), $3, 'enviado', $4, $5, $6, $7, $8, 'gerando') RETURNING id, created_at`,
    [header.scope, header.company?.id ?? null, header.company?.name ?? null, storageKind(), header.include_documents, ctx.user.id, header.app_version, header.migrations])
  const key = storageKind() === 'r2' ? objectKey(header.scope, header.company?.id ?? 'enviados', row.id, new Date(row.created_at)) : null
  const put = await putFile(row.id, key, ctx.rawBody)
  await db.query(`UPDATE backup_files SET status = 'ok', storage = $2, storage_key = $3, size = $4, sha256 = $5, error = $6, finished_at = now() WHERE id = $1`,
    [row.id, put.storage, put.key, ctx.rawBody.length, crypto.createHash('sha256').update(ctx.rawBody).digest('hex'), put.warning])
  await audit(null, ctx, 'backup.enviado', 'backup', row.id, { scope: header.scope, company: header.company?.name, created_at: header.created_at }, 'warning')
  return { id: row.id, header: { scope: header.scope, company: header.company, created_at: header.created_at, app_version: header.app_version } }
})

router.post('/api/platform/backups/:id/restore', P, async (ctx) => {
  guard(ctx)
  const b = parse(v.object({ mode: v.enum(['copia', 'substituir'] as const), confirm: v.string({ max: 40 }).optional() }), ctx.body)
  const f = await db.one(`SELECT id, scope, company_id, company_name, status FROM backup_files WHERE id = $1`, [ctx.params.id])
  if (!f || f.status !== 'ok') throw notFound('Backup')
  if (f.scope !== 'empresa') throw unprocessable('O backup do sistema inteiro é restaurado num banco novo, pelo procedimento descrito em docs/BACKUP.md.')
  if (b.mode === 'substituir') {
    if (!ctx.user.platformOwner) throw forbidden('Substituir os dados de uma empresa é exclusivo do proprietário da plataforma.')
    if ((b.confirm || '').trim().toUpperCase() !== 'SUBSTITUIR') throw unprocessable('Para substituir, digite SUBSTITUIR no campo de confirmação.')
    if (!f.company_id) throw unprocessable('A empresa original não existe neste sistema. Restaure como cópia.')
  }
  rateLimit('bk-restaurar:' + ctx.user.id, 10, 60 * 60_000)
  await audit(null, ctx, b.mode === 'copia' ? 'backup.restauracao_copia' : 'backup.restauracao_substituir', 'backup', f.id, { company: f.company_name }, 'critical', f.company_id ? { companyId: f.company_id } : undefined)
  const actor = ctx.user.id
  const jobId = await startJob('restauracao', f.company_id, actor, async (progress) => {
    let safety: string | null = null
    if (b.mode === 'substituir') { progress({ step: 'Backup de segurança da situação atual' }); safety = (await runBackup({ scope: 'empresa', companyId: f.company_id, kind: 'seguranca', includeDocuments: true, userId: actor, appVersion: APP_VERSION })).id }
    progress({ step: 'Lendo e conferindo o arquivo' })
    const { data } = await loadBackupFile(f.id)
    const r = await tx((c) => restoreCompany(c, data, { mode: b.mode, actorId: actor, targetCompanyId: f.company_id ?? undefined, onProgress: (p) => progress({ step: 'Gravando ' + p.table, done: p.done, total: p.total }) }))
    await db.query(`INSERT INTO audit_log(company_id, user_id, user_name, action, entity, entity_id, data, severity) VALUES ($1,$2,$3,$4,'backup',$5,$6,'critical')`,
      [r.companyId, actor, ctx.user.name, b.mode === 'copia' ? 'backup.restaurado_como_copia' : 'backup.restaurado_substituindo', f.id, JSON.stringify({ origem: f.company_name, seguranca: safety })])
    indexPending(r.companyId).catch(() => {}) // releitura dos documentos para a IA
    return { ...r, safetyBackupId: safety }
  })
  return { jobId }
})

router.delete('/api/platform/backups/:id', P, async (ctx) => {
  guard(ctx)
  const f = await db.one(`SELECT id, storage, storage_key, scope, company_name, company_id FROM backup_files WHERE id = $1 AND status IN ('ok','erro')`, [ctx.params.id])
  if (!f) throw notFound('Backup')
  await deleteFile(f)
  await audit(null, ctx, 'backup.excluido', 'backup', f.id, { scope: f.scope, company: f.company_name }, 'warning', f.company_id ? { companyId: f.company_id } : undefined)
  return { ok: true }
})

// ---------- agendamentos ----------
const scheduleSchema = { scope: v.enum(['sistema', 'empresa'] as const), companyId: v.uuid().optional(), frequency: v.enum(['diario', 'semanal', 'mensal'] as const), hour: v.int({ min: 0, max: 23 }),
  weekday: v.int({ min: 0, max: 6 }).optional(), monthday: v.int({ min: 1, max: 28 }).optional(), keep: v.int({ min: 1, max: 365 }).default(7), includeDocuments: v.boolean().default(true), active: v.boolean().default(true) }

router.post('/api/platform/backup/schedules', P, async (ctx) => {
  guard(ctx)
  const b = parse(v.object(scheduleSchema), ctx.body)
  if (b.scope === 'empresa' && !b.companyId) throw unprocessable('Escolha a empresa.')
  if (b.scope === 'sistema') b.companyId = undefined
  const r = await db.one(`INSERT INTO backup_schedules(scope, company_id, frequency, hour, weekday, monthday, keep, include_documents, active, next_run_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.scope, b.companyId ?? null, b.frequency, b.hour, b.frequency === 'semanal' ? b.weekday ?? 1 : null, b.frequency === 'mensal' ? b.monthday ?? 1 : null, b.keep, b.includeDocuments, b.active, nextRun(b as any), ctx.user.id])
  await audit(null, ctx, 'backup.agendamento_criado', 'backup_schedule', r.id, b, 'warning')
  return r
})
router.put('/api/platform/backup/schedules/:id', P, async (ctx) => {
  guard(ctx)
  const partial: any = {}; for (const [k, s] of Object.entries(scheduleSchema)) if (k !== 'scope' && k !== 'companyId') partial[k] = (s as any).optional()
  const b: any = parse(v.object(partial), ctx.body)
  const cur = await db.one(`SELECT * FROM backup_schedules WHERE id = $1`, [ctx.params.id])
  if (!cur) throw notFound('Agendamento')
  const m = { frequency: b.frequency ?? cur.frequency, hour: b.hour ?? cur.hour, weekday: 'weekday' in ctx.body ? b.weekday : cur.weekday, monthday: 'monthday' in ctx.body ? b.monthday : cur.monthday }
  const r = await db.one(`UPDATE backup_schedules SET frequency = $2, hour = $3, weekday = $4, monthday = $5, keep = COALESCE($6, keep), include_documents = COALESCE($7, include_documents), active = COALESCE($8, active), next_run_at = $9 WHERE id = $1 RETURNING *`,
    [cur.id, m.frequency, m.hour, m.frequency === 'semanal' ? m.weekday ?? 1 : null, m.frequency === 'mensal' ? m.monthday ?? 1 : null, b.keep ?? null, b.includeDocuments ?? null, b.active ?? null, nextRun(m as any)])
  await audit(null, ctx, 'backup.agendamento_alterado', 'backup_schedule', r.id, b, 'warning')
  return r
})
router.delete('/api/platform/backup/schedules/:id', P, async (ctx) => {
  guard(ctx)
  const r = await db.one(`DELETE FROM backup_schedules WHERE id = $1 RETURNING id`, [ctx.params.id])
  if (!r) throw notFound('Agendamento')
  await audit(null, ctx, 'backup.agendamento_excluido', 'backup_schedule', r.id, null, 'warning')
  return { ok: true }
})
