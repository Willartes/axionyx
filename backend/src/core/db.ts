import pg, { Pool, PoolClient } from 'pg'
import { config } from '../config'

// numeric -> number (valores monetários com 2 casas; somas críticas são feitas no SQL)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)))
// int8 -> number (contadores e numerações cabem com folga em Number)
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)))
// date -> string 'YYYY-MM-DD' (evita deslocamento por fuso horário)
pg.types.setTypeParser(1082, (v) => v)

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DB_POOL_MAX || 15),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'axionyx-api',
  options: `-c TimeZone=${config.timezone}`,
})
pool.on('error', (err) => console.error('[db] erro no pool', err.message))

export interface Q {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>
  one<R = any>(sql: string, params?: unknown[]): Promise<R | null>
  many<R = any>(sql: string, params?: unknown[]): Promise<R[]>
}

function wrap(client: { query: (s: string, p?: unknown[]) => Promise<any> }): Q {
  return {
    query: (sql, params) => client.query(sql, params),
    one: async (sql, params) => (await client.query(sql, params)).rows[0] ?? null,
    many: async (sql, params) => (await client.query(sql, params)).rows,
  }
}

export const db: Q = wrap(pool)

/** Executa `fn` dentro de uma transação. Qualquer exceção faz ROLLBACK. */
export async function tx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(wrap(client))
    await client.query('COMMIT')
    return result
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* conexão perdida */ }
    throw e
  } finally {
    client.release()
  }
}

/** Próximo número sequencial legível por empresa (bloqueia a linha até o fim da transação). */
export async function nextNumber(c: Q, companyId: string, name: string): Promise<number> {
  const r = await c.one<{ value: number }>(
    `INSERT INTO counters(company_id, name, value) VALUES ($1,$2,1)
     ON CONFLICT (company_id, name) DO UPDATE SET value = counters.value + 1 RETURNING value`,
    [companyId, name],
  )
  return r!.value
}
