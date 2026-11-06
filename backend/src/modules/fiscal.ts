import { router, audit, paged, Where, branchScope } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound } from '../core/errors'
import { createDocumentForSale, revalidate, transmit, cancelDocument } from '../services/fiscal'
import { getFiscalAdapter } from '../integrations/fiscal-adapter'
import { getSettings } from '../services/settings'

router.get('/api/fiscal/status', { perm: 'fiscal.ver' }, async (ctx) => {
  const adapter = getFiscalAdapter()
  const s = (await getSettings(db, ctx.user.companyId)).fiscal
  const counts = await db.many(`SELECT status, model, count(*)::int AS n, COALESCE(sum((totals->>'total')::numeric),0) AS total FROM fiscal_documents
                                 WHERE company_id = $1 AND created_at >= date_trunc('month', now()) GROUP BY status, model`, [ctx.user.companyId])
  return {
    provider: adapter.name, configured: adapter.configured(), environment: s.ambiente, autoEmitNfce: s.emitirNfceAutomatico, counts,
    notice: adapter.configured() ? null : 'Nenhum provedor fiscal configurado: documentos são validados e armazenados, mas NÃO são enviados à SEFAZ. Não possuem valor fiscal.',
  }
})

router.get('/api/fiscal/documents', { perm: 'fiscal.ver' }, async (ctx) => {
  const q = ctx.query
  const branches = branchScope(ctx, q.branch)
  const w = new Where([['f.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('f.branch_id = ANY(?::uuid[])', branches)
  w.addIf(q.model, 'f.model = ?', q.model).addIf(q.status, 'f.status = ?', q.status).addIf(q.from, 'f.created_at >= ?::date', q.from).addIf(q.to, "f.created_at < ?::date + interval '1 day'", q.to)
  if (q.q) w.add(`(f.number::text = ? OR f.access_key = ? OR f.recipient->>'nome' ILIKE ? OR s.number::text = ?)`, q.q, q.q, `%${q.q}%`, q.q)
  const sql = `SELECT f.id, f.model, f.environment, f.series, f.number, f.status, f.is_test, f.access_key, f.protocol, f.created_at, f.authorized_at, f.operation,
                      f.recipient->>'nome' AS recipient_name, (f.totals->>'total')::numeric AS total, s.number AS sale_number, jsonb_array_length(f.validation) AS issues
                 FROM fiscal_documents f LEFT JOIN sales s ON s.id = f.sale_id ${w.sql} ORDER BY f.created_at DESC`
  const res = await paged(db, sql, w.params, q)
  const totals = await db.one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'autorizado')::int AS authorized, count(*) FILTER (WHERE status IN ('rascunho','invalido','pendente_configuracao','fila','processando','erro','contingencia'))::int AS pending,
                                      count(*) FILTER (WHERE status = 'cancelado')::int AS cancelled, count(*) FILTER (WHERE status IN ('rejeitado','denegado'))::int AS rejected FROM (${sql}) t`, w.params)
  return { ...res, totals }
})

router.get('/api/fiscal/documents/:id', { perm: 'fiscal.ver' }, async (ctx) => {
  const f = await db.one(`SELECT f.*, s.number AS sale_number FROM fiscal_documents f LEFT JOIN sales s ON s.id = f.sale_id WHERE f.id = $1 AND f.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!f) throw notFound('Documento fiscal')
  f.has_xml = !!f.xml; delete f.xml
  f.events = await db.many(`SELECT e.id, e.type, e.status, e.message, e.created_at, u.name AS user_name FROM fiscal_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.document_id = $1 ORDER BY e.id`, [f.id])
  return f
})

router.get('/api/fiscal/documents/:id/xml', { perm: 'fiscal.ver' }, async (ctx) => {
  const f = await db.one(`SELECT xml, access_key, number FROM fiscal_documents WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!f?.xml) throw notFound('XML do documento (disponível apenas após autorização pelo provedor)')
  ctx.reply = { headers: { 'content-type': 'application/xml', 'content-disposition': `attachment; filename="${f.access_key || f.number}.xml"` }, raw: f.xml }
  return null
})

router.post('/api/fiscal/documents/from-sale', { perm: 'fiscal.emitir' }, async (ctx) => {
  const b = parse(v.object({ saleId: v.uuid(), model: v.enum(['55', '65'] as const).default('65') }), ctx.body)
  return tx(async (c) => {
    const s = await c.one(`SELECT branch_id, status, type FROM sales WHERE id = $1 AND company_id = $2`, [b.saleId, ctx.user.companyId])
    if (!s) throw notFound('Venda')
    const doc = await createDocumentForSale(c, ctx.user.companyId, s.branch_id, b.saleId, b.model, ctx.user.id)
    await audit(c, ctx, 'fiscal.documento_criado', 'fiscal_document', doc.id, { model: b.model, saleId: b.saleId })
    return doc
  })
})

router.post('/api/fiscal/documents/:id/validate', { perm: 'fiscal.emitir' }, async (ctx) => tx((c) => revalidate(c, ctx.params.id, ctx.user.companyId)))

router.post('/api/fiscal/documents/:id/transmit', { perm: 'fiscal.emitir', idempotent: true }, async (ctx) => tx(async (c) => {
  const doc = await transmit(c, ctx.params.id, ctx.user.companyId, ctx.user.id)
  await audit(c, ctx, 'fiscal.transmissao', 'fiscal_document', doc.id, { status: doc.status })
  return doc
}))

router.post('/api/fiscal/documents/:id/cancel', { perm: 'fiscal.emitir' }, async (ctx) => {
  const b = parse(v.object({ reason: v.string({ min: 15, max: 255 }) }), ctx.body)
  return tx(async (c) => {
    const doc = await cancelDocument(c, ctx.params.id, ctx.user.companyId, b.reason, ctx.user.id)
    await audit(c, ctx, 'fiscal.cancelamento', 'fiscal_document', doc.id, { reason: b.reason }, 'critical')
    return doc
  })
})

router.get('/api/fiscal/pending-sales', { perm: 'fiscal.ver' }, async (ctx) =>
  db.many(`SELECT s.id, s.number, s.created_at, s.total, cu.name AS customer FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
            WHERE s.company_id = $1 AND s.branch_id = $2 AND s.type = 'venda' AND s.status IN ('concluida','devolvida_parcial') AND s.created_at > now() - interval '30 days'
              AND NOT EXISTS (SELECT 1 FROM fiscal_documents f WHERE f.sale_id = s.id AND f.status NOT IN ('cancelado','invalido','rejeitado','erro'))
            ORDER BY s.created_at DESC LIMIT 200`, [ctx.user.companyId, ctx.user.branchId]))
