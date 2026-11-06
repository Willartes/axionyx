import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { once } from 'node:events'
import { pool, db, type Q } from '../core/db'
import { companyPlan, systemPlan, readSchema, type Plan, type TableInfo } from './schema'
import { storageKind, objectKey, putFile, getFile } from './storage'

/**
 * Formato do arquivo (.axbak): "AXBK" + versão + IV(12) + [gzip de NDJSON cifrado em AES-256-GCM] + tag(16).
 * NDJSON: 1ª linha = cabeçalho (escopo, empresa, versão do sistema, migrações), depois {"t": tabela, "r": [linhas]} em
 * lotes, e por fim {"end": true, "counts": {...}}. Leitura com fotografia consistente do banco (REPEATABLE READ).
 */
const MAGIC = Buffer.from('AXBK'), VERSION = 1

// ---------- chave ----------
function backupKey(): { key: Buffer; source: string } {
  const own = (process.env.BACKUP_ENCRYPTION_KEY || '').trim()
  if (own) return { key: crypto.createHash('sha256').update(own).digest(), source: 'BACKUP_ENCRYPTION_KEY' }
  const base = (process.env.ENCRYPTION_KEY || '').trim() ? 'ENCRYPTION_KEY' : 'JWT_SECRET'
  const secret = process.env[base] || ''
  if (!secret) throw new Error('Defina BACKUP_ENCRYPTION_KEY (ou ENCRYPTION_KEY/JWT_SECRET) para cifrar os backups.')
  return { key: Buffer.from(crypto.hkdfSync('sha256', secret, 'axionyx', 'axionyx-backup-v1', 32)), source: base }
}
export const keySource = () => { try { return backupKey().source } catch { return null } }
export const keyFingerprint = () => crypto.createHash('sha256').update(backupKey().key).digest('hex').slice(0, 12)

// ---------- serialização ----------
const toJson = (v: unknown): unknown => (Buffer.isBuffer(v) ? '\\x' + v.toString('hex') : v)
const rowJson = (r: Record<string, unknown>) => { const o: Record<string, unknown> = {}; for (const k in r) o[k] = toJson(r[k]); return o }

export interface BackupHeader { axionyx_backup: number; scope: 'empresa' | 'sistema'; company: { id: string; name: string } | null; created_at: string; app_version: string; migrations: string[]; include_documents: boolean; key: string; order: string[] }
export interface BackupResult { size: number; sha256: string; tables: number; rows: number; counts: Record<string, number>; migrations: string[]; data: Buffer }

/** Gera o arquivo cifrado em memória (comprimido). */
export async function buildBackup(o: { scope: 'empresa' | 'sistema'; companyId?: string; includeDocuments: boolean; appVersion: string; onProgress?: (p: { table: string; done: number; total: number }) => void }): Promise<BackupResult> {
  const { key } = backupKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const gz = zlib.createGzip({ level: 6 })
  const chunks: Buffer[] = [Buffer.concat([MAGIC, Buffer.from([VERSION]), iv])]
  gz.on('data', (c: Buffer) => chunks.push(cipher.update(c)))
  const write = async (obj: unknown) => { if (!gz.write(JSON.stringify(obj) + '\n')) await once(gz, 'drain') }
  const client = await pool.connect()
  const counts: Record<string, number> = {}
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const q: Q = { query: (s: string, p?: any[]) => client.query(s, p), one: async (s: string, p?: any[]) => (await client.query(s, p)).rows[0] ?? null, many: async (s: string, p?: any[]) => (await client.query(s, p)).rows } as any
    const plan: Plan = o.scope === 'empresa' ? await companyPlan(q) : await systemPlan(q)
    const tables = plan.order.filter((t) => o.includeDocuments || t !== 'documents')
    let company: { id: string; name: string } | null = null
    if (o.scope === 'empresa') {
      const co = (await client.query(`SELECT id, name FROM companies WHERE id = $1`, [o.companyId])).rows[0]
      if (!co) throw new Error('Empresa não encontrada.')
      company = { id: co.id, name: co.name }
    }
    const migrations = (await client.query(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name)
    const header: BackupHeader = { axionyx_backup: VERSION, scope: o.scope, company, created_at: new Date().toISOString(), app_version: o.appVersion, migrations, include_documents: o.includeDocuments, key: keyFingerprint(), order: tables }
    await write(header)
    let i = 0
    for (const t of tables) {
      const info = plan.tables.get(t)!
      const where = o.scope === 'empresa' ? `WHERE ${info.pred}` : ''
      const cols = info.columns.filter((c) => !info.generated.includes(c)).map((c) => `"${c}"`).join(', ')
      await client.query(`DECLARE bk NO SCROLL CURSOR FOR SELECT ${cols} FROM "${t}" ${where}`, o.scope === 'empresa' ? [o.companyId] : [])
      counts[t] = 0
      for (;;) {
        const r = await client.query('FETCH 500 FROM bk')
        if (!r.rows.length) break
        counts[t] += r.rows.length
        await write({ t, r: r.rows.map(rowJson) })
      }
      await client.query('CLOSE bk')
      o.onProgress?.({ table: t, done: ++i, total: tables.length })
    }
    await write({ end: true, counts })
    await client.query('COMMIT')
    gz.end(); await once(gz, 'end')
    chunks.push(cipher.final(), cipher.getAuthTag())
    const data = Buffer.concat(chunks)
    const rows = Object.values(counts).reduce((a, b) => a + b, 0)
    return { data, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), tables: tables.length, rows, counts, migrations }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); gz.destroy(); throw e }
  finally { client.release() }
}

/** Abre o arquivo: confere a autenticidade (tag GCM) ANTES de qualquer uso e devolve as linhas descomprimidas. */
export function openBackup(buf: Buffer): { header: BackupHeader; records: () => Generator<any> } {
  if (buf.length < 4 + 1 + 12 + 16 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('Arquivo não é um backup do AXIONYX.')
  if (buf[4] !== VERSION) throw new Error('Versão de arquivo de backup não suportada.')
  const iv = buf.subarray(5, 17), tag = buf.subarray(buf.length - 16), body = buf.subarray(17, buf.length - 16)
  const d = crypto.createDecipheriv('aes-256-gcm', backupKey().key, iv); d.setAuthTag(tag)
  let gzData: Buffer
  try { gzData = Buffer.concat([d.update(body), d.final()]) }
  catch { throw new Error('Não foi possível abrir o backup: a chave de criptografia é diferente da usada para gerá-lo, ou o arquivo foi alterado.') }
  const text = zlib.gunzipSync(gzData).toString('utf8')
  const nl = text.indexOf('\n')
  const header = JSON.parse(text.slice(0, nl)) as BackupHeader
  if (!header.axionyx_backup) throw new Error('Cabeçalho de backup inválido.')
  return {
    header,
    *records() { let p = nl + 1; while (p < text.length) { const e = text.indexOf('\n', p); const line = text.slice(p, e < 0 ? text.length : e); p = e < 0 ? text.length : e + 1; if (line) yield JSON.parse(line) } },
  }
}

// ---------- restauração ----------
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
export interface RestoreResult { companyId: string; companyName: string; mode: 'copia' | 'substituir'; counts: Record<string, number>; skipped: Record<string, string> }

async function insertRows(c: Q, t: TableInfo, rows: Record<string, unknown>[], o: { overriding: boolean; dropCols?: Set<string> }) {
  if (!rows.length) return
  const keys = new Set<string>(); for (const r of rows) for (const k in r) keys.add(k)
  const cols = t.columns.filter((x) => keys.has(x) && !t.generated.includes(x) && !o.dropCols?.has(x))
  const list = cols.map((x) => `"${x}"`).join(', ')
  const override = o.overriding && cols.some((x) => t.identity.includes(x)) ? ' OVERRIDING SYSTEM VALUE' : ''
  try { await c.query(`INSERT INTO "${t.name}" (${list})${override} SELECT ${list} FROM json_populate_recordset(NULL::"${t.name}", $1::json)`, [JSON.stringify(rows)]) }
  catch (e: any) { throw new Error(`Tabela ${t.name}: ${e.message}${process.env.BACKUP_DEBUG ? ' | cols=' + list : ''}`) }
}

/**
 * Restaura o backup de UMA empresa.
 *  - copia: cria uma empresa nova (ids novos, nome com "(restaurada em ...)"), sem tocar na original e sem dar acesso
 *    a ninguém além da equipe da plataforma;
 *  - substituir: troca os dados da própria empresa pelos do backup (tudo numa transação: se algo falhar, nada muda).
 */
export async function restoreCompany(c: Q, buf: Buffer, o: { mode: 'copia' | 'substituir'; actorId: string; targetCompanyId?: string; onProgress?: (p: { table: string; done: number; total: number }) => void }): Promise<RestoreResult> {
  const { header, records } = openBackup(buf)
  if (header.scope !== 'empresa' || !header.company) throw new Error('Este arquivo é um backup do sistema inteiro; restaure-o pelo procedimento de restauração completa (docs/BACKUP.md).')
  const applied = new Set((await c.many(`SELECT name FROM schema_migrations`)).map((r: any) => r.name))
  const newer = header.migrations.filter((m) => !applied.has(m))
  if (newer.length) throw new Error(`O backup foi gerado numa versão mais nova do sistema (${newer.join(', ')}). Atualize o sistema antes de restaurar.`)
  const schema = await readSchema(c)
  const plan = await companyPlan(c)
  const users = new Set((await c.many(`SELECT id FROM users`)).map((r: any) => r.id))
  const counts: Record<string, number> = {}, skipped: Record<string, string> = {}
  const deferredUpdates: { table: string; pk: string; id: unknown; values: Record<string, unknown> }[] = []
  const external: { table: TableInfo; col: string; parent: string; ppk: string; rows: any[]; mode: 'reinserir' | 'religar' }[] = []
  const map = new Map<string, string>()
  const copy = o.mode === 'copia'
  const targetId = copy ? crypto.randomUUID() : header.company.id
  if (!copy && o.targetCompanyId && o.targetCompanyId !== header.company.id) throw new Error('O backup é de outra empresa. Para trazer os dados para uma empresa diferente, restaure como cópia.')
  if (!copy && !(await c.one(`SELECT 1 FROM companies WHERE id = $1`, [targetId]))) throw new Error('A empresa original não existe mais neste sistema. Restaure como cópia.')
  const label = `${header.company.name} (restaurada em ${new Date().toLocaleDateString('pt-BR')})`

  // substituir: apaga os dados atuais da empresa (filhos antes dos pais; colunas adiadas zeradas antes)
  if (!copy) {
    const keepDocs = !header.include_documents
    for (const [t, cols] of plan.deferred) if (t !== 'companies') for (const col of cols) await c.query(`UPDATE "${t}" SET "${col}" = NULL WHERE ${plan.tables.get(t)!.pred} AND "${col}" IS NOT NULL`, [targetId])
    // tabelas fora do backup que apontam para dados da empresa (sessões, lotes de migração...): guarda essas linhas,
    // tira a referência e, no fim, devolve tudo o que continuar existindo (na substituição os ids são os mesmos)
    for (const t of schema.values()) {
      if (plan.tables.has(t.name)) continue
      for (const f of t.fks) {
        if (f.parent === 'companies' || !plan.tables.has(f.parent)) continue
        const parent = plan.tables.get(f.parent)!, ppk = parent.pk.length === 1 ? parent.pk[0] : 'id'
        const sub = `SELECT "${ppk}" FROM "${parent.name}" WHERE ${parent.pred}`
        if (f.notnull) {
          const rows = await c.many(`DELETE FROM "${t.name}" WHERE "${f.col}" IN (${sub}) RETURNING *`, [targetId])
          if (rows.length) external.push({ table: t, col: f.col, parent: parent.name, ppk, rows: rows.map(rowJson), mode: 'reinserir' })
        } else if (t.pk.length === 1) {
          const pk = t.pk[0]
          const rows = await c.many(`WITH old AS (SELECT "${pk}" AS pk, "${f.col}" AS val FROM "${t.name}" WHERE "${f.col}" IN (${sub}))
                                     UPDATE "${t.name}" x SET "${f.col}" = NULL FROM old WHERE x."${pk}" = old.pk RETURNING old.pk, old.val`, [targetId])
          if (rows.length) external.push({ table: t, col: f.col, parent: parent.name, ppk, rows, mode: 'religar' })
        }
      }
    }
    for (const t of [...plan.order].reverse()) {
      if (t === 'companies' || (keepDocs && t === 'documents')) continue
      await c.query(`DELETE FROM "${t}" WHERE ${plan.tables.get(t)!.pred}`, [targetId])
    }
  }
  map.set(header.company.id, targetId)

  const userCols = (t: TableInfo) => t.fks.filter((f) => f.parent === 'users')
  const order = header.order.filter((t) => schema.has(t))
  for (const t of header.order) if (!schema.has(t)) skipped[t] = 'tabela não existe mais nesta versão'
  let done = 0
  for (const rec of records()) {
    if (!rec.t) continue
    const t = schema.get(rec.t)
    if (!t) continue
    if (copy && (rec.t === 'user_companies' || rec.t === 'user_branches')) { skipped[rec.t] = 'acessos não são copiados (cópia só para conferência)'; continue }
    const pk = t.pk.length === 1 ? t.pk[0] : null
    const intPk = pk && /int/.test(t.types[pk])
    const deferredCols = plan.deferred.get(rec.t) ?? []
    let rows: Record<string, unknown>[] = rec.r
    if (copy) {
      // novos ids para as chaves primárias uuid; depois troca toda referência conhecida (inclusive dentro de textos e JSON)
      if (pk && !intPk) for (const r of rows) if (typeof r[pk] === 'string' && !map.has(r[pk] as string)) map.set(r[pk] as string, crypto.randomUUID())
      rows = rows.map((r) => JSON.parse(JSON.stringify(r).replace(UUID, (m) => map.get(m.toLowerCase()) ?? map.get(m) ?? m)))
      if (rec.t === 'companies') rows = rows.map((r) => ({ ...r, name: label, trade_name: r.trade_name ? `${r.trade_name} (restaurada)` : null, cnpj: null, active: true }))
    }
    // referências a usuários que não existem neste sistema: ficam vazias (ou com quem restaurou, se obrigatórias)
    for (const f of userCols(t)) for (const r of rows) if (r[f.col] && !users.has(r[f.col] as string)) r[f.col] = f.notnull ? o.actorId : null
    if (rec.t === 'user_companies' || rec.t === 'user_branches') { const before = rows.length; rows = rows.filter((r) => users.has(r.user_id as string)); if (rows.length < before) skipped[rec.t] = `${before - rows.length} acesso(s) de usuário(s) inexistente(s) ignorado(s)` }
    // colunas adiadas: grava vazio agora e preenche no fim
    if (deferredCols.length) {
      if (!pk || intPk) throw new Error(`Tabela ${rec.t} tem referência circular sem chave uuid; restauração não suportada.`)
      for (const r of rows) { const vals: Record<string, unknown> = {}; let any = false; for (const col of deferredCols) if (r[col] != null) { vals[col] = r[col]; r[col] = null; any = true }; if (any) deferredUpdates.push({ table: rec.t, pk, id: r[pk], values: vals }) }
    }
    if (rec.t === 'companies') {
      const r = rows[0]
      const cols = t.columns.filter((x) => x in r && x !== 'id' && !t.generated.includes(x))
      if (copy) await insertRows(c, t, rows, { overriding: true })
      else await c.query(`UPDATE companies SET (${cols.map((x) => `"${x}"`).join(', ')}) = (SELECT ${cols.map((x) => `"${x}"`).join(', ')} FROM json_populate_record(NULL::companies, $2::json)) WHERE id = $1`, [targetId, JSON.stringify(r)])
    } else {
      await insertRows(c, t, rows, { overriding: !copy, dropCols: copy && intPk ? new Set([pk!]) : undefined })
    }
    counts[rec.t] = (counts[rec.t] ?? 0) + rows.length
    o.onProgress?.({ table: rec.t, done: Math.min(++done, order.length), total: order.length })
  }
  for (const u of deferredUpdates) {
    const vals = copy ? JSON.parse(JSON.stringify(u.values).replace(UUID, (m) => map.get(m) ?? m)) : u.values
    const cols = Object.keys(vals)
    await c.query(`UPDATE "${u.table}" SET ${cols.map((x, i) => `"${x}" = $${i + 2}`).join(', ')} WHERE "${u.pk}" = $1`, [u.id, ...cols.map((x) => vals[x])])
  }
  // devolve as referências externas cujo destino continua existindo
  for (const e of external) {
    if (e.mode === 'religar') {
      for (const r of e.rows) await c.query(`UPDATE "${e.table.name}" SET "${e.col}" = $2 WHERE "${e.table.pk[0]}" = $1 AND EXISTS (SELECT 1 FROM "${e.parent}" WHERE "${e.ppk}" = $2)`, [r.pk, r.val])
    } else {
      const cols = e.table.columns.filter((x) => !e.table.generated.includes(x)).map((x) => `"${x}"`).join(', ')
      await c.query(`INSERT INTO "${e.table.name}" (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::"${e.table.name}", $1::json) r
                     WHERE EXISTS (SELECT 1 FROM "${e.parent}" p WHERE p."${e.ppk}" = r."${e.col}") ON CONFLICT DO NOTHING`, [JSON.stringify(e.rows)])
    }
  }
  return { companyId: targetId, companyName: copy ? label : header.company.name, mode: o.mode, counts, skipped }
}

/** Restauração COMPLETA num banco vazio (usada pelo script de linha de comando). */
export async function restoreSystem(c: Q, buf: Buffer, onProgress?: (t: string) => void): Promise<Record<string, number>> {
  const { header, records } = openBackup(buf)
  if (header.scope !== 'sistema') throw new Error('Este arquivo é o backup de uma empresa; restaure-o pela tela de Backup.')
  if (Number((await c.one(`SELECT count(*)::int AS n FROM companies`)).n) > 0) throw new Error('O banco de destino não está vazio. A restauração completa só é feita num banco novo.')
  const schema = await readSchema(c)
  const plan = await systemPlan(c)
  const counts: Record<string, number> = {}
  const later: { table: string; pk: string; id: unknown; values: Record<string, unknown> }[] = []
  for (const rec of records()) {
    if (!rec.t || !schema.has(rec.t) || rec.t === 'schema_migrations') continue
    const t = schema.get(rec.t)!
    const deferredCols = plan.deferred.get(rec.t) ?? []
    const pk = t.pk.length === 1 ? t.pk[0] : null
    if (deferredCols.length && pk) for (const r of rec.r) { const vals: Record<string, unknown> = {}; let any = false; for (const col of deferredCols) if (r[col] != null) { vals[col] = r[col]; r[col] = null; any = true }; if (any) later.push({ table: rec.t, pk, id: r[pk], values: vals }) }
    // tabelas preenchidas pelas próprias migrações (ex.: linha única de configuração) são substituídas pelo backup
    if (counts[rec.t] === undefined && pk) await c.query(`DELETE FROM "${rec.t}"`)
    await insertRows(c, t, rec.r, { overriding: true })
    counts[rec.t] = (counts[rec.t] ?? 0) + rec.r.length
    onProgress?.(rec.t)
  }
  for (const u of later) { const cols = Object.keys(u.values); await c.query(`UPDATE "${u.table}" SET ${cols.map((x, i) => `"${x}" = $${i + 2}`).join(', ')} WHERE "${u.pk}" = $1`, [u.id, ...cols.map((x) => u.values[x])]) }
  // sequências e identidades continuam depois do maior id restaurado
  const seqs = await c.many(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`)
  for (const s of seqs) await c.query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE((SELECT max("${s.column_name}") FROM "${s.table_name}"), 0), 1))`, [`public.${s.table_name}`, s.column_name]).catch(() => {})
  return counts
}

// ---------- ciclo completo: gerar + guardar ----------
export async function runBackup(o: { scope: 'empresa' | 'sistema'; companyId?: string; kind: 'manual' | 'agendado' | 'seguranca'; scheduleId?: string; includeDocuments: boolean; userId?: string | null; appVersion: string; onProgress?: (p: any) => void }): Promise<{ id: string; size: number; rows: number }> {
  const co = o.companyId ? await db.one(`SELECT name FROM companies WHERE id = $1`, [o.companyId]) : null
  const row = await db.one(`INSERT INTO backup_files(scope, company_id, company_name, kind, schedule_id, storage, include_documents, created_by, app_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
    [o.scope, o.companyId ?? null, co?.name ?? null, o.kind, o.scheduleId ?? null, storageKind(), o.includeDocuments, o.userId ?? null, o.appVersion])
  try {
    const b = await buildBackup({ scope: o.scope, companyId: o.companyId, includeDocuments: o.includeDocuments, appVersion: o.appVersion, onProgress: o.onProgress })
    const key = storageKind() === 'r2' ? objectKey(o.scope, o.companyId ?? null, row.id, new Date(row.created_at)) : null
    const put = await putFile(row.id, key, b.data)
    await db.query(`UPDATE backup_files SET status = 'ok', storage = $2, storage_key = $3, size = $4, sha256 = $5, tables = $6, rows = $7, counts = $8, migrations = $9, error = $10, finished_at = now() WHERE id = $1`,
      [row.id, put.storage, put.key, b.size, b.sha256, b.tables, b.rows, JSON.stringify(b.counts), b.migrations, put.warning])
    return { id: row.id, size: b.size, rows: b.rows }
  } catch (e: any) {
    await db.query(`UPDATE backup_files SET status = 'erro', error = $2, content = NULL, finished_at = now() WHERE id = $1`, [row.id, String(e?.message || e).slice(0, 500)])
    throw e
  }
}
export async function loadBackupFile(id: string): Promise<{ row: any; data: Buffer }> {
  const row = await db.one(`SELECT id, scope, company_id, company_name, storage, storage_key, status, sha256 FROM backup_files WHERE id = $1`, [id])
  if (!row || row.status !== 'ok') throw new Error('Backup não encontrado ou indisponível.')
  const data = await getFile(row)
  if (row.sha256 && crypto.createHash('sha256').update(data).digest('hex') !== row.sha256) throw new Error('O arquivo do backup não confere com a assinatura gravada (pode ter sido alterado).')
  return { row, data }
}
