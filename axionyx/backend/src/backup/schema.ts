import { db, type Q } from '../core/db'

/**
 * Leitura automática do esquema para o backup: quais tabelas pertencem a uma empresa (coluna company_id, ou filha de
 * uma tabela que tem), em que ordem gravar (pais antes dos filhos) e quais colunas precisam ser preenchidas depois
 * (auto-referência e ciclos). Assim, tabelas criadas em versões futuras entram no backup sem ninguém lembrar de incluir.
 */
export interface FK { col: string; parent: string; notnull: boolean }
export interface TableInfo {
  name: string; columns: string[]; types: Record<string, string>; notnull: Record<string, boolean>
  /** colunas GENERATED ALWAYS AS IDENTITY (precisam de OVERRIDING SYSTEM VALUE) e colunas calculadas (nunca gravadas) */
  identity: string[]; generated: string[]
  pk: string[]; fks: FK[]; hasCompany: boolean
  /** predicado SQL que seleciona as linhas de uma empresa ($1 = id da empresa) */
  pred?: string
}
export interface Plan { order: string[]; tables: Map<string, TableInfo>; deferred: Map<string, string[]> }

/** Nunca vão para o backup: sessões, tokens, controles internos e conteúdo que pode ser recalculado. */
const VOLATILE = new Set(['sessions', 'user_tokens', 'idempotency_keys', 'schema_migrations', 'demo_instance', 'document_chunks', 'document_texts', 'platform_jobs', 'backup_files'])
/** Dados da PLATAFORMA (contrato, cobrança, IA, migração): ficam fora do backup de uma empresa. */
const PLATFORM = /^(saas_|platform_|backup_|migration_)|^(site_leads|system_events|company_ai|ai_usage|email_log|users|outbox)$/

export async function readSchema(c: Q | typeof db = db): Promise<Map<string, TableInfo>> {
  const cols = await c.many(`SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.identity_generation, c.is_generated FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
                              WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position`)
  const pks = await c.many(`SELECT t.relname AS tbl, array_agg(a.attname::text ORDER BY k.ord) AS cols FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                              CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                             WHERE n.nspname = 'public' AND ix.indisprimary GROUP BY t.relname`)
  const fks = await c.many(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent, a.attname::text AS col, a.attnotnull AS notnull
                              FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] JOIN pg_namespace n ON n.oid = c.connamespace
                             WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND n.nspname = 'public'`)
  const map = new Map<string, TableInfo>()
  for (const r of cols) {
    const t: TableInfo = map.get(r.table_name) ?? { name: r.table_name, columns: [], types: {}, notnull: {}, identity: [], generated: [], pk: [], fks: [], hasCompany: false }
    if (r.identity_generation === 'ALWAYS') t.identity.push(r.column_name)
    if (r.is_generated === 'ALWAYS') t.generated.push(r.column_name)
    t.columns.push(r.column_name); t.types[r.column_name] = r.data_type === 'ARRAY' ? r.udt_name : r.data_type; t.notnull[r.column_name] = r.is_nullable === 'NO'
    if (r.column_name === 'company_id') t.hasCompany = true
    map.set(r.table_name, t)
  }
  for (const p of pks) { const t = map.get(p.tbl); if (t) t.pk = p.cols }
  for (const f of fks) { const t = map.get(f.child.replace(/^public\./, '')); if (t) t.fks.push({ col: f.col, parent: f.parent.replace(/^public\./, ''), notnull: f.notnull }) }
  return map
}

/** Ordena (pais antes) e marca as colunas que só podem ser preenchidas depois de todas as tabelas gravadas. */
function order(names: string[], tables: Map<string, TableInfo>): { order: string[]; deferred: Map<string, string[]> } {
  const set = new Set(names), done = new Set<string>(), out: string[] = []
  const deferred = new Map<string, string[]>()
  const deps = (t: string) => tables.get(t)!.fks.filter((f) => f.parent !== t && set.has(f.parent) && !(deferred.get(t) ?? []).includes(f.col))
  while (out.length < names.length) {
    const ready = names.filter((t) => !done.has(t) && deps(t).every((f) => done.has(f.parent)))
    if (ready.length) { for (const t of ready.sort()) { done.add(t); out.push(t) }; continue }
    // ciclo: adia a coluna anulável que aponta para uma tabela ainda não gravada
    const t = names.find((x) => !done.has(x) && deps(x).some((f) => !done.has(f.parent) && !f.notnull))
    if (!t) throw new Error('Ciclo de chaves sem coluna anulável: ' + names.filter((x) => !done.has(x)).join(', '))
    const f = deps(t).find((x) => !done.has(x.parent) && !x.notnull)!
    deferred.set(t, [...(deferred.get(t) ?? []), f.col])
  }
  // auto-referência (ex.: categoria-pai) também é preenchida depois
  for (const t of names) for (const f of tables.get(t)!.fks) if (f.parent === t && !(deferred.get(t) ?? []).includes(f.col)) deferred.set(t, [...(deferred.get(t) ?? []), f.col])
  return { order: out, deferred }
}

/** Tabelas de UMA empresa, com o predicado de cada uma. */
export async function companyPlan(c: Q | typeof db = db): Promise<Plan> {
  const tables = await readSchema(c)
  const scoped = new Map<string, TableInfo>()
  const companies = tables.get('companies')!
  companies.pred = 'id = $1'; scoped.set('companies', companies)
  for (const t of tables.values()) if (t.hasCompany && !VOLATILE.has(t.name) && !PLATFORM.test(t.name)) { t.pred = 'company_id = $1'; scoped.set(t.name, t) }
  // filhas sem company_id: herdam pela chave do pai (repete até não achar mais)
  for (let changed = true; changed;) {
    changed = false
    for (const t of tables.values()) {
      if (scoped.has(t.name) || VOLATILE.has(t.name) || PLATFORM.test(t.name)) continue
      const f = [...t.fks].sort((a, b) => Number(b.notnull) - Number(a.notnull)).find((x) => scoped.has(x.parent) && x.parent !== t.name)
      if (!f) continue
      const parent = scoped.get(f.parent)!
      const ppk = parent.pk.length === 1 ? parent.pk[0] : 'id'
      t.pred = `${f.col} IN (SELECT ${ppk} FROM ${parent.name} WHERE ${parent.pred})`
      scoped.set(t.name, t); changed = true
    }
  }
  const o = order([...scoped.keys()], scoped)
  return { order: o.order, tables: scoped, deferred: o.deferred }
}

/** Todas as tabelas do sistema (backup completo). */
export async function systemPlan(c: Q | typeof db = db): Promise<Plan> {
  const tables = await readSchema(c)
  const names = [...tables.keys()].filter((t) => !VOLATILE.has(t))
  const sub = new Map(names.map((n) => [n, tables.get(n)!]))
  const o = order(names, sub)
  return { order: o.order, tables: sub, deferred: o.deferred }
}
