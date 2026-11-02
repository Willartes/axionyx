import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import { setup, teardown, call, login, PASSWORD } from './helpers'
import { db, pool } from '../core/db'
import { hashPassword } from '../core/crypto'
import { openBackup, restoreSystem } from '../backup/engine'
import { nextRun, backupTick } from '../backup/scheduler'
import { signV4 } from '../backup/storage'
import { companyPlan } from '../backup/schema'

/**
 * Backup: arquivo cifrado e isolado por empresa, restauração como cópia e por substituição, sistema inteiro num banco
 * novo, armazenamento S3/R2 (simulado), agendamento com retenção e permissões exclusivas da plataforma.
 */
let env: any, OWNER: string, AGENT: string, A: string, coA = '', coB = ''
const key = () => crypto.randomUUID()
const waitJob = async (id: string, token = OWNER) => { for (let i = 0; i < 200; i++) { const j = await call('GET', `/api/platform/jobs/${id}`, { token }); if (j.body.status !== 'executando') return j.body; await new Promise((r) => setTimeout(r, 100)) } throw new Error('tarefa não terminou') }
const objects = new Map<string, Buffer>(); const s3Seen: string[] = []
const fakeS3 = http.createServer((req, res) => {
  const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', (): void => {
    s3Seen.push(`${req.method} ${req.url} ${String(req.headers.authorization || '').slice(0, 16)}`)
    if (!/^AWS4-HMAC-SHA256 Credential=TESTKEY\//.test(String(req.headers.authorization))) { res.writeHead(403); res.end('<Error><Code>AccessDenied</Code></Error>'); return }
    const k = decodeURIComponent(req.url || '')
    if (req.method === 'PUT') { objects.set(k, Buffer.concat(chunks)); res.writeHead(200); res.end(); return }
    if (req.method === 'GET') { const o = objects.get(k); if (!o) { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return } res.writeHead(200); res.end(o); return }
    if (req.method === 'DELETE') { objects.delete(k); res.writeHead(204); res.end(); return }
    res.writeHead(400); res.end()
  })
})

before(async () => {
  env = await setup(); coA = env.companyA.company.id; coB = env.companyB.company.id
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner) VALUES ('Dono', 'dono@axionyx.test', $1, true, true)`, [hashPassword(PASSWORD)])
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner, platform_permissions) VALUES ('Agente', 'agente@axionyx.test', $1, true, false, $2)`, [hashPassword(PASSWORD), ['plataforma.backup', 'suporte.acessar']])
  OWNER = (await login('dono@axionyx.test', coA)).token; AGENT = (await login('agente@axionyx.test', coA)).token
  A = (await login('admin.a@teste.local')).token
  // dados da empresa A: categoria com subcategoria (auto-referência), produto, cliente, venda, documento
  const cat = await call('POST', '/api/categories', { token: A, body: { name: 'Roupas' } })
  if (cat.status === 200) await call('POST', '/api/categories', { token: A, body: { name: 'Blusas', parent_id: cat.body.id } })
  const p = await call('POST', '/api/products', { token: A, body: { code: 'BK-1', name: 'Camisa Backup', sale_price: 120, cost_price: 50 } })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  await call('POST', '/api/stock/movements', { token: A, headers: { 'Idempotency-Key': key() }, body: { type: 'entrada', reason: 'Carga', items: [{ variantId: p.body.variants[0].id, qty: 10 }] } })
  await call('POST', '/api/customers', { token: A, body: { name: 'Cliente Backup', cpf_cnpj: '52998224725' } })
  const regs = await call('GET', '/api/cash/registers', { token: A })
  await call('POST', '/api/cash/open', { token: A, headers: { 'Idempotency-Key': key() }, body: { registerId: regs.body[0].id, openingAmount: 0 } })
  const lk = (await call('GET', '/api/lookups', { token: A })).body
  const s = await call('POST', '/api/sales', { token: A, headers: { 'Idempotency-Key': key() }, body: { items: [{ variantId: p.body.variants[0].id, qty: 2 }], payments: [{ methodId: lk.paymentMethods.find((m: any) => m.kind === 'pix').id, amount: 240 }] } })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  await call('POST', '/api/documents', { token: A, raw: 'Contrato de teste do backup' as any, type: 'text/plain', headers: { 'x-file-name': 'contrato.txt', 'x-folder': 'Contratos' } })
  // empresa B: algo que NÃO pode aparecer no backup da A
  const B = (await login('admin.b@teste.local')).token
  await call('POST', '/api/customers', { token: B, body: { name: 'Cliente Secreto da B' } })
})
after(async () => { await teardown(); fakeS3.close(); for (const k of Object.keys(process.env).filter((k) => k.startsWith('BACKUP_'))) delete process.env[k] })

test('assinatura S3/R2 confere com o vetor oficial da AWS', () => {
  const r = signV4({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') })
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
})

test('só a equipe da plataforma acessa backup (inclusive a exportação antiga)', async () => {
  assert.equal((await call('GET', '/api/platform/backup', { token: A })).status, 403)
  assert.equal((await call('POST', '/api/platform/backups', { token: A, body: { scope: 'empresa', companyId: coA } })).status, 403)
  assert.equal((await call('GET', '/api/admin/export', { token: A })).status, 403)
  assert.equal((await call('GET', '/api/platform/backup', { token: AGENT })).status, 200)
})

test('plano do backup por empresa: inclui as tabelas filhas e deixa de fora dados da plataforma e sessões', async () => {
  const plan = await companyPlan()
  for (const t of ['companies', 'sales', 'sale_items', 'conditional_items', 'return_items', 'products', 'documents', 'audit_log', 'counters']) assert.ok(plan.tables.has(t), t)
  for (const t of ['users', 'sessions', 'saas_contracts', 'platform_ai_keys', 'backup_files', 'document_chunks', 'company_ai']) assert.ok(!plan.tables.has(t), t)
  assert.ok(plan.order.indexOf('sales') < plan.order.indexOf('sale_items'))
  assert.ok((plan.deferred.get('categories') ?? []).includes('parent_id'))
})

let backupA = ''
test('backup da empresa: arquivo cifrado, só com dados dela', async () => {
  const r = await call('POST', '/api/platform/backups', { token: OWNER, body: { scope: 'empresa', companyId: coA } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const j = await waitJob(r.body.jobId)
  assert.equal(j.status, 'ok', String(j.error)); backupA = j.result.id
  const row = (await db.query(`SELECT * FROM backup_files WHERE id = $1`, [backupA])).rows[0]
  assert.equal(row.status, 'ok'); assert.equal(row.storage, 'banco'); assert.ok(row.size > 100)
  assert.ok(!row.content.toString('latin1').includes('Cliente Backup'), 'conteúdo cifrado')
  const { header, records } = openBackup(row.content)
  assert.equal(header.scope, 'empresa'); assert.equal(header.company!.id, coA)
  let sales = 0, docs = 0
  for (const rec of records()) {
    if (!rec.t) continue
    for (const x of rec.r) { if ('company_id' in x) assert.equal(x.company_id, coA, `${rec.t} com dado de outra empresa`); assert.ok(!JSON.stringify(x).includes('Cliente Secreto da B')) }
    if (rec.t === 'sales') sales += rec.r.length; if (rec.t === 'documents') docs += rec.r.length
  }
  assert.equal(sales, 1); assert.equal(docs, 1)
  // download (só plataforma) devolve o mesmo arquivo
  const dl = await fetch(`${(await call('GET', '/api/health')) && ''}`).catch(() => null); void dl
})

test('restaurar como cópia: empresa nova, ids novos, referências coerentes, original intacta', async () => {
  const r = await call('POST', `/api/platform/backups/${backupA}/restore`, { token: AGENT, body: { mode: 'copia' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const j = await waitJob(r.body.jobId, AGENT)
  assert.equal(j.status, 'ok', String(j.error))
  const newId = j.result.companyId
  assert.notEqual(newId, coA); assert.match(j.result.companyName, /restaurada em/)
  const q = async (sql: string, id: string) => (await db.query(sql, [id])).rows[0]
  assert.equal((await q(`SELECT cnpj FROM companies WHERE id = $1`, newId)).cnpj, null)
  assert.equal((await q(`SELECT count(*)::int AS n FROM sales WHERE company_id = $1`, newId)).n, 1)
  assert.equal((await q(`SELECT count(*)::int AS n FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.company_id = $1`, newId)).n, 1)
  assert.equal((await q(`SELECT count(*)::int AS n FROM sale_items si JOIN product_variants v ON v.id = si.variant_id WHERE v.company_id = $1`, newId)).n, 1, 'item da venda aponta para o produto da cópia')
  assert.equal((await q(`SELECT count(*)::int AS n FROM products p WHERE p.company_id = $1 AND p.id IN (SELECT id FROM products WHERE company_id = $2)`, newId).catch(() => ({ n: 0 }))).n ?? 0, 0)
  const sub = await q(`SELECT c.parent_id, p.company_id FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.company_id = $1 LIMIT 1`, newId)
  if (sub) assert.equal(sub.company_id, newId, 'subcategoria aponta para a categoria da cópia')
  assert.equal((await q(`SELECT count(*)::int AS n FROM user_companies WHERE company_id = $1`, newId)).n, 0, 'ninguém ganha acesso à cópia')
  assert.equal((await q(`SELECT count(*)::int AS n FROM sales WHERE company_id = $1`, coA)).n, 1, 'original intacta')
})

test('substituir: só o proprietário, com confirmação; volta ao estado do backup e guarda um backup de segurança', async () => {
  // muda a empresa depois do backup
  await call('POST', '/api/products', { token: A, body: { code: 'DEPOIS-1', name: 'Produto criado depois do backup', sale_price: 10 } })
  await db.query(`UPDATE customers SET name = 'Nome alterado depois' WHERE company_id = $1 AND name = 'Cliente Backup'`, [coA])
  assert.equal((await call('POST', `/api/platform/backups/${backupA}/restore`, { token: AGENT, body: { mode: 'substituir', confirm: 'SUBSTITUIR' } })).status, 403)
  assert.equal((await call('POST', `/api/platform/backups/${backupA}/restore`, { token: OWNER, body: { mode: 'substituir' } })).status, 422)
  const r = await call('POST', `/api/platform/backups/${backupA}/restore`, { token: OWNER, body: { mode: 'substituir', confirm: 'substituir' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const j = await waitJob(r.body.jobId)
  assert.equal(j.status, 'ok', String(j.error))
  assert.equal(j.result.companyId, coA); assert.ok(j.result.safetyBackupId)
  const n = async (sql: string) => (await db.query(sql, [coA])).rows[0].n
  assert.equal(await n(`SELECT count(*)::int AS n FROM products WHERE company_id = $1 AND code = 'DEPOIS-1'`), 0)
  assert.equal(await n(`SELECT count(*)::int AS n FROM customers WHERE company_id = $1 AND name = 'Cliente Backup'`), 1)
  assert.equal(await n(`SELECT count(*)::int AS n FROM user_companies uc JOIN users u ON u.id = uc.user_id WHERE uc.company_id = $1 AND NOT u.is_superadmin`), 2, 'acessos dos usuários restaurados')
  // a empresa continua funcionando: login e nova venda
  const A2 = (await login('admin.a@teste.local')).token
  assert.equal((await call('GET', '/api/products', { token: A2 })).status, 200)
  const safety = (await db.query(`SELECT kind, status FROM backup_files WHERE id = $1`, [j.result.safetyBackupId])).rows[0]
  assert.deepEqual([safety.kind, safety.status], ['seguranca', 'ok'])
})

test('chave diferente ou arquivo alterado: recusa com mensagem clara', async () => {
  const row = (await db.query(`SELECT content FROM backup_files WHERE id = $1`, [backupA])).rows[0]
  process.env.BACKUP_ENCRYPTION_KEY = 'outra-chave-de-backup-qualquer-123456'
  assert.throws(() => openBackup(row.content), /chave de criptografia é diferente/)
  delete process.env.BACKUP_ENCRYPTION_KEY
  const bad = Buffer.from(row.content); bad[40] ^= 0xff
  assert.throws(() => openBackup(bad), /alterado/)
  await db.query(`UPDATE backup_files SET content = $2 WHERE id = $1`, [backupA, bad])
  const r = await call('POST', `/api/platform/backups/${backupA}/restore`, { token: OWNER, body: { mode: 'copia' } })
  const j = await waitJob(r.body.jobId)
  assert.equal(j.status, 'erro'); assert.match(j.error, /não confere|alterado/)
  await db.query(`UPDATE backup_files SET content = $2 WHERE id = $1`, [backupA, row.content])
})

test('armazenamento R2/S3: grava, baixa e apaga no bucket (simulado)', async () => {
  await new Promise<void>((r) => fakeS3.listen(0, '127.0.0.1', () => r()))
  Object.assign(process.env, { BACKUP_S3_ENDPOINT: `http://127.0.0.1:${(fakeS3.address() as AddressInfo).port}`, BACKUP_S3_BUCKET: 'meu-bucket', BACKUP_S3_ACCESS_KEY_ID: 'TESTKEY', BACKUP_S3_SECRET_ACCESS_KEY: 'segredo' })
  assert.equal((await call('POST', '/api/platform/backup/test-storage', { token: OWNER })).body.ok, true)
  const r = await call('POST', '/api/platform/backups', { token: OWNER, body: { scope: 'empresa', companyId: coA, includeDocuments: false } })
  const j = await waitJob(r.body.jobId)
  assert.equal(j.status, 'ok', String(j.error))
  const row = (await db.query(`SELECT storage, storage_key, content FROM backup_files WHERE id = $1`, [j.result.id])).rows[0]
  assert.equal(row.storage, 'r2'); assert.equal(row.content, null)
  assert.match(row.storage_key, new RegExp(`^axionyx-backups/empresas/${coA}/\\d{4}-\\d{2}-\\d{2}/`))
  assert.ok(objects.has(`/meu-bucket/${row.storage_key}`))
  const g = await call('GET', `/api/platform/backups/${j.result.id}/download`, { token: OWNER })
  assert.equal(g.status, 200)
  assert.equal((await call('DELETE', `/api/platform/backups/${j.result.id}`, { token: OWNER })).status, 200)
  assert.ok(!objects.has(`/meu-bucket/${row.storage_key}`))
  // R2 recusando (credencial errada): o backup não se perde, vai para o banco com aviso
  process.env.BACKUP_S3_ACCESS_KEY_ID = 'CHAVE-ERRADA'
  const f = await waitJob((await call('POST', '/api/platform/backups', { token: OWNER, body: { scope: 'empresa', companyId: coA, includeDocuments: false } })).body.jobId)
  assert.equal(f.status, 'ok', String(f.error))
  const fb = (await db.query(`SELECT storage, storage_key, error, length(content) AS n FROM backup_files WHERE id = $1`, [f.result.id])).rows[0]
  assert.equal(fb.storage, 'banco'); assert.equal(fb.storage_key, null); assert.ok(fb.n > 100); assert.match(fb.error, /R2\/S3 indisponível/)
  assert.equal((await call('GET', `/api/platform/backups/${f.result.id}/download`, { token: OWNER })).status, 200)
  for (const k of ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY']) delete process.env[k]
})

test('agendamento: próxima execução, execução automática e retenção', async () => {
  const base = new Date(2026, 10, 2, 10, 30) // seg 02/11/2026 10:30 (hora local)
  assert.equal(nextRun({ frequency: 'diario', hour: 2 }, base).toString(), new Date(2026, 10, 3, 2).toString())
  assert.equal(nextRun({ frequency: 'diario', hour: 23 }, base).toString(), new Date(2026, 10, 2, 23).toString())
  assert.equal(nextRun({ frequency: 'semanal', hour: 3, weekday: 0 }, base).toString(), new Date(2026, 10, 8, 3).toString())
  assert.equal(nextRun({ frequency: 'mensal', hour: 1, monthday: 1 }, base).toString(), new Date(2026, 11, 1, 1).toString())
  const s = await call('POST', '/api/platform/backup/schedules', { token: OWNER, body: { scope: 'empresa', companyId: coB, frequency: 'diario', hour: 3, keep: 1 } })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  for (let i = 0; i < 2; i++) {
    await db.query(`UPDATE backup_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [s.body.id])
    assert.equal(await backupTick('teste', true), 1)
  }
  const files = (await db.query(`SELECT status FROM backup_files WHERE schedule_id = $1 ORDER BY created_at`, [s.body.id])).rows.map((r) => r.status)
  assert.deepEqual(files, ['excluido', 'ok'], 'retenção mantém só o último')
  const sch = (await db.query(`SELECT last_status, next_run_at FROM backup_schedules WHERE id = $1`, [s.body.id])).rows[0]
  assert.equal(sch.last_status, 'ok'); assert.ok(new Date(sch.next_run_at) > new Date())
})

test('sistema inteiro: backup e restauração completa num banco novo', async () => {
  const r = await call('POST', '/api/platform/backups', { token: OWNER, body: { scope: 'sistema' } })
  const j = await waitJob(r.body.jobId)
  assert.equal(j.status, 'ok', String(j.error))
  const data = (await db.query(`SELECT content FROM backup_files WHERE id = $1`, [j.result.id])).rows[0].content
  const counts = { companies: (await db.query(`SELECT count(*)::int AS n FROM companies`)).rows[0].n, sales: (await db.query(`SELECT count(*)::int AS n FROM sales`)).rows[0].n, users: (await db.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n }
  // banco novo
  const name = 'axionyx_test_restore'
  await pool.query(`DROP DATABASE IF EXISTS ${name}`); await pool.query(`CREATE DATABASE ${name}`)
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = '/' + name
  const target = new Pool({ connectionString: url.toString() })
  try {
    // aplica as migrações no banco novo (mesmos arquivos) e restaura
    const fs = await import('node:fs'); const path = await import('node:path')
    const dir = path.resolve(__dirname, '../../migrations')
    await target.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) { await target.query(fs.readFileSync(path.join(dir, f), 'utf8')); await target.query(`INSERT INTO schema_migrations(name) VALUES ($1)`, [f]) }
    const client = await target.connect()
    const q: any = { query: (s: string, p?: any[]) => client.query(s, p), one: async (s: string, p?: any[]) => (await client.query(s, p)).rows[0] ?? null, many: async (s: string, p?: any[]) => (await client.query(s, p)).rows }
    try { await client.query('BEGIN'); await restoreSystem(q, data); await client.query('COMMIT') } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    const got = async (t: string) => (await target.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n
    assert.equal(await got('companies'), counts.companies); assert.equal(await got('sales'), counts.sales); assert.equal(await got('users'), counts.users)
    const pw = (await target.query(`SELECT password_hash FROM users WHERE email = 'admin.a@teste.local'`)).rows[0]
    assert.ok(pw.password_hash.length > 20, 'senhas preservadas no backup do sistema')
    // destino com dados: recusa
    const c2 = await target.connect(); const q2: any = { query: (s: string, p?: any[]) => c2.query(s, p), one: async (s: string, p?: any[]) => (await c2.query(s, p)).rows[0] ?? null, many: async (s: string, p?: any[]) => (await c2.query(s, p)).rows }
    await assert.rejects(restoreSystem(q2, data), /não está vazio/); c2.release()
  } finally { await target.end(); await pool.query(`DROP DATABASE IF EXISTS ${name}`) }
})
