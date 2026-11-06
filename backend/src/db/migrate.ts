import fs from 'node:fs'
import path from 'node:path'
import { pool } from '../core/db'

/** Aplica, em ordem, os arquivos migrations/*.sql ainda não executados (cada um em sua transação). */
export async function migrate(log = true) {
  const dir = path.resolve(__dirname, '../../migrations')
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (done.has(f)) continue
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f])
      await client.query('COMMIT')
      if (log) console.log(`[migrate] aplicada ${f}`)
    } catch (e: any) {
      await client.query('ROLLBACK')
      throw new Error(`Falha na migração ${f}: ${e.message}`)
    } finally {
      client.release()
    }
  }
  if (log) console.log('[migrate] banco atualizado')
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1) })
}
