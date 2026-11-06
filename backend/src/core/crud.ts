import { router, audit, paged, Where } from './http'
import { db } from './db'
import { Schema, parse, v } from './validate'
import { notFound } from './errors'

interface CrudOpts {
  table: string
  path: string
  entity: string
  label: string
  view: string
  edit: string
  schema: Record<string, Schema<any>>
  search?: string[]
  order?: string
  /** colunas JSON que devem ser serializadas */
  json?: string[]
  softDelete?: boolean
  select?: string
  extraWhere?: string
  /** oculta campos sensíveis conforme permissão (aplicado em todas as respostas) */
  mask?: (row: any, ctx: any) => any
  /** validação extra de escrita (ex.: campo que exige permissão específica) */
  guard?: (body: any, ctx: any) => void
}

/** Registra rotas REST padrão (listar/obter/criar/alterar/excluir) com isolamento por empresa e auditoria. */
export function crud(o: CrudOpts) {
  const cols = Object.keys(o.schema)
  const sel = o.select || `t.*`
  router.get(o.path, { perm: o.view }, async (ctx) => {
    const w = new Where([['t.company_id = ?', ctx.user.companyId]])
    if (ctx.query.q && o.search?.length) w.add('(' + o.search.map((s) => `${s} ILIKE ?`).join(' OR ') + ')', ...o.search.map(() => `%${ctx.query.q}%`))
    if (ctx.query.active !== undefined && o.softDelete) w.add('t.active = ?', ctx.query.active === 'true')
    if (o.extraWhere) w.parts.push(o.extraWhere)
    const res = await paged(db, `SELECT ${sel} FROM ${o.table} t ${w.sql} ORDER BY ${o.order || 't.created_at DESC'}`, w.params, ctx.query, 100)
    if (o.mask) res.items = res.items.map((r) => o.mask!(r, ctx))
    return res
  })
  router.get(o.path + '/:id', { perm: o.view }, async (ctx) => {
    const r = await db.one(`SELECT ${sel} FROM ${o.table} t WHERE t.id = $1 AND t.company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!r) throw notFound(o.label)
    return o.mask ? o.mask(r, ctx) : r
  })
  router.post(o.path, { perm: o.edit }, async (ctx) => {
    const b: any = parse(v.object(o.schema), ctx.body)
    o.guard?.(b, ctx)
    const keys = cols.filter((k) => b[k] !== undefined)
    const vals = keys.map((k) => (o.json?.includes(k) ? JSON.stringify(b[k]) : b[k]))
    const r = await db.one(`INSERT INTO ${o.table}(company_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`, [ctx.user.companyId, ...vals])
    await audit(null, ctx, `${o.entity}.criado`, o.entity, r.id, b)
    return o.mask ? o.mask(r, ctx) : r
  })
  router.put(o.path + '/:id', { perm: o.edit }, async (ctx) => {
    const partial: Record<string, Schema<any>> = {}
    for (const k of cols) partial[k] = o.schema[k].optional()
    const b: any = parse(v.object(partial), ctx.body)
    const keys = cols.filter((k) => k in ctx.body)
    o.guard?.(Object.fromEntries(keys.map((k) => [k, b[k]])), ctx)
    if (!keys.length) return db.one(`SELECT * FROM ${o.table} WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    const vals = keys.map((k) => (b[k] === undefined ? null : o.json?.includes(k) ? JSON.stringify(b[k]) : b[k]))
    const r = await db.one(`UPDATE ${o.table} SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`, [ctx.params.id, ctx.user.companyId, ...vals])
    if (!r) throw notFound(o.label)
    await audit(null, ctx, `${o.entity}.alterado`, o.entity, r.id, b)
    return o.mask ? o.mask(r, ctx) : r
  })
  router.delete(o.path + '/:id', { perm: o.edit }, async (ctx) => {
    const r = o.softDelete
      ? await db.one(`UPDATE ${o.table} SET active = false WHERE id = $1 AND company_id = $2 RETURNING id`, [ctx.params.id, ctx.user.companyId])
      : await db.one(`DELETE FROM ${o.table} WHERE id = $1 AND company_id = $2 RETURNING id`, [ctx.params.id, ctx.user.companyId])
    if (!r) throw notFound(o.label)
    await audit(null, ctx, `${o.entity}.${o.softDelete ? 'inativado' : 'excluido'}`, o.entity, r.id, null, 'warning')
    return { ok: true }
  })
}
