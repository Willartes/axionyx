// Declarações mínimas do driver `pg` usadas pelo projeto (evita dependência de @types/pg).
declare module 'pg' {
  export interface QueryResult<R = any> { rows: R[]; rowCount: number | null; command: string }
  export interface PoolClient {
    query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>
    release(err?: Error | boolean): void
  }
  export interface PoolConfig {
    connectionString?: string
    max?: number
    idleTimeoutMillis?: number
    connectionTimeoutMillis?: number
    application_name?: string
    statement_timeout?: number
    options?: string
  }
  export class Pool {
    constructor(config?: PoolConfig)
    query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>
    connect(): Promise<PoolClient>
    end(): Promise<void>
    on(event: 'error', listener: (err: Error) => void): this
    totalCount: number
    idleCount: number
    waitingCount: number
  }
  export const types: { setTypeParser(oid: number, parser: (v: string) => unknown): void }
  const pg: { Pool: typeof Pool; types: typeof types }
  export default pg
}
