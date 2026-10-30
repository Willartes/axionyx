import { router, audit, rateLimit, can } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { forbidden, notFound, unprocessable } from '../core/errors'
import { requirePlatform } from '../core/platform'
import { PROVIDERS, PROVIDER_INFO, platformAI, keysStatus, providerKey, encryptSecret, companyAI, modelOf, type Provider } from '../ai/config'
import { listModels, runLoop, AiError } from '../ai/providers'
import { indexDocument, indexPending } from '../ai/documents'

// =====================================================================
// PLATAFORMA: provedores, chaves (cifradas), modelos e liberação por empresa
// =====================================================================
const prov = (s: string): Provider => { if (!(PROVIDERS as string[]).includes(s)) throw unprocessable('Provedor inválido.'); return s as Provider }

router.get('/api/platform/ai', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.configurar')
  const p = await platformAI()
  const companies = await db.many(`
    SELECT c.id, c.name, c.trade_name, c.segment, c.is_demo, COALESCE(ca.platform_allowed, false) AS allowed, ca.monthly_limit, COALESCE(ca.enabled, false) AS enabled, ca.accepted_at,
           (SELECT count(*)::int FROM ai_usage u WHERE u.company_id = c.id AND u.engine = 'ia' AND u.status = 'ok' AND u.created_at >= date_trunc('month', now())) AS used,
           (SELECT COALESCE(sum(COALESCE(u.input_tokens,0) + COALESCE(u.output_tokens,0)),0)::bigint FROM ai_usage u WHERE u.company_id = c.id AND u.engine = 'ia' AND u.created_at >= date_trunc('month', now())) AS tokens
      FROM companies c LEFT JOIN company_ai ca ON ca.company_id = c.id WHERE c.active ORDER BY c.name`)
  return {
    provider: p.provider, availability: p.availability, defaultMonthlyLimit: p.defaultMonthlyLimit,
    providers: PROVIDERS.map((k) => ({ id: k, label: PROVIDER_INFO[k].label, vendor: PROVIDER_INFO[k].vendor, env: PROVIDER_INFO[k].env, console: PROVIDER_INFO[k].console, model: modelOf(p, k), defaultModel: PROVIDER_INFO[k].defaultModel })),
    keys: await keysStatus(), companies, encryption: process.env.ENCRYPTION_KEY ? 'ENCRYPTION_KEY' : 'JWT_SECRET',
  }
})

router.put('/api/platform/ai', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.configurar')
  const b = parse(v.object({ provider: v.string({ max: 20 }).optional(), models: v.object({ anthropic: v.string({ max: 100 }).optional(), openai: v.string({ max: 100 }).optional(), gemini: v.string({ max: 100 }).optional() }).optional(),
    availability: v.enum(['todas', 'liberadas'] as const).optional(), defaultMonthlyLimit: v.int({ min: 0, max: 100000 }).optional() }), ctx.body)
  const cur = await platformAI()
  let provider: Provider | null = cur.provider
  if (b.provider !== undefined) provider = b.provider ? prov(b.provider) : null
  if (provider && provider !== cur.provider && !(await providerKey(provider))) throw unprocessable(`Cadastre a chave do ${PROVIDER_INFO[provider].label} antes de oferecê-lo às empresas.`)
  const models = { ...cur.models }
  for (const k of PROVIDERS) { const m = (b.models as any)?.[k]; if (m !== undefined) { const t = String(m).trim(); if (t && !/^[\w.\-:/@]+$/.test(t)) throw unprocessable('Nome de modelo inválido.'); if (t) models[k] = t; else delete models[k] } }
  await db.query(`UPDATE platform_ai_settings SET provider = $1, models = $2, availability = $3, default_monthly_limit = $4, updated_by = $5, updated_at = now() WHERE id = 1`,
    [provider, JSON.stringify(models), b.availability ?? cur.availability, b.defaultMonthlyLimit ?? cur.defaultMonthlyLimit, ctx.user.id])
  await audit(null, ctx, 'plataforma.ia_config', null, null, { provider, models, availability: b.availability ?? cur.availability, defaultMonthlyLimit: b.defaultMonthlyLimit ?? cur.defaultMonthlyLimit }, 'warning')
  return { ok: true }
})

/** Grava a chave do provedor CIFRADA. Corpo vazio remove. A chave nunca é devolvida. */
router.put('/api/platform/ai/keys/:provider', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.configurar')
  const p = prov(ctx.params.provider)
  const b = parse(v.object({ key: v.string({ max: 400 }).optional() }), ctx.body)
  const key = (b.key || '').trim()
  if (!key) {
    const cur = await platformAI()
    if (cur.provider === p && !process.env[PROVIDER_INFO[p].env]) throw unprocessable('Este provedor está oferecido às empresas. Escolha outro provedor (ou nenhum) antes de remover a chave.')
    await db.query(`DELETE FROM platform_ai_keys WHERE provider = $1`, [p])
    await audit(null, ctx, 'plataforma.ia_chave_removida', null, null, { provider: p }, 'warning')
    return { ok: true, removed: true }
  }
  if (key.length < 20 || /\s/.test(key)) throw unprocessable('Chave em formato inválido. Copie a chave inteira, sem espaços.')
  await db.query(`INSERT INTO platform_ai_keys(provider, key_enc, last4, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())
                  ON CONFLICT (provider) DO UPDATE SET key_enc = EXCLUDED.key_enc, last4 = EXCLUDED.last4, updated_by = EXCLUDED.updated_by, updated_at = now()`, [p, encryptSecret(key), key.slice(-4), ctx.user.id])
  await audit(null, ctx, 'plataforma.ia_chave_gravada', null, null, { provider: p, last4: key.slice(-4) }, 'warning')
  return { ok: true }
})

router.get('/api/platform/ai/models/:provider', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.configurar')
  const p = prov(ctx.params.provider)
  const key = await providerKey(p)
  if (!key) throw unprocessable('Cadastre a chave deste provedor primeiro.')
  rateLimit('ia-modelos:' + ctx.user.id, 20, 10 * 60_000)
  try { return { models: await listModels(p, key.key) } } catch (e: any) { return { models: [], error: e.message } }
})

/** Teste real: uma pergunta curta ao provedor com o modelo escolhido. */
router.post('/api/platform/ai/test', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.configurar')
  const b = parse(v.object({ provider: v.string({ max: 20 }), model: v.string({ max: 100 }).optional() }), ctx.body)
  const p = prov(b.provider)
  const key = await providerKey(p)
  if (!key) throw unprocessable('Cadastre a chave deste provedor primeiro.')
  rateLimit('ia-teste:' + ctx.user.id, 10, 10 * 60_000)
  const model = (b.model || '').trim() || modelOf(await platformAI(), p)
  const t0 = Date.now()
  try {
    const r = await runLoop({ provider: p, key: key.key, model, system: 'Responda apenas com a palavra OK.', history: [{ role: 'user', text: 'Teste de conexão do AXIONYX. Responda OK.' }], tools: [], exec: async () => null, maxSteps: 1, maxTokens: 50, timeoutMs: 45_000 })
    await audit(null, ctx, 'plataforma.ia_teste', null, null, { provider: p, model, ok: true })
    return { ok: true, model, reply: r.text.slice(0, 80), ms: Date.now() - t0 }
  } catch (e: any) { return { ok: false, model, error: e.message, ms: Date.now() - t0 } }
})

router.put('/api/platform/ai/companies/:id', { perm: 'admin.empresas' }, async (ctx) => {
  requirePlatform(ctx, 'carteira.configurar')
  const b = parse(v.object({ allowed: v.boolean().optional(), monthlyLimit: v.int({ min: 0, max: 100000 }).nullable().optional() }), ctx.body)
  const c = await db.one(`SELECT id, name FROM companies WHERE id = $1`, [ctx.params.id])
  if (!c) throw notFound('Empresa')
  await db.query(`INSERT INTO company_ai(company_id, platform_allowed, monthly_limit) VALUES ($1, COALESCE($2, false), $3)
                  ON CONFLICT (company_id) DO UPDATE SET platform_allowed = COALESCE($2, company_ai.platform_allowed), monthly_limit = CASE WHEN $4 THEN $3 ELSE company_ai.monthly_limit END, updated_at = now()`,
    [c.id, b.allowed ?? null, b.monthlyLimit ?? null, b.monthlyLimit !== undefined])
  await audit(null, ctx, 'plataforma.ia_empresa', 'company', c.id, { company: c.name, ...b })
  return { ok: true }
})

// =====================================================================
// EMPRESA: situação, ativação com aceite, documentos e pastas bloqueadas
// =====================================================================
router.get('/api/ai/status', {}, async (ctx) => {
  const s = await companyAI(ctx.user.companyId)
  return { available: s.available, reason: s.reason, reasonText: s.reasonText, providerLabel: s.providerLabel, documents: s.documentsEnabled && can(ctx.user, 'documentos.ver'), used: s.used, limit: s.limit }
})

router.get('/api/ai/settings', { perm: 'config.editar' }, async (ctx) => {
  const s = await companyAI(ctx.user.companyId)
  const docs = await db.many(`SELECT COALESCE(t.status, 'nao_lido') AS status, count(*)::int AS n FROM documents d LEFT JOIN document_texts t ON t.document_id = d.id WHERE d.company_id = $1 GROUP BY 1`, [ctx.user.companyId])
  const folders = await db.many(`SELECT DISTINCT folder FROM documents WHERE company_id = $1 ORDER BY folder`, [ctx.user.companyId])
  const recent = await db.many(`SELECT u.created_at, u.mode, u.status, u.provider, u.tools_used, us.name AS user_name FROM ai_usage u LEFT JOIN users us ON us.id = u.user_id
                                 WHERE u.company_id = $1 AND u.engine = 'ia' ORDER BY u.created_at DESC LIMIT 20`, [ctx.user.companyId])
  return { ...s, documentsStatus: docs, folders: folders.map((f: any) => f.folder), recent }
})

router.put('/api/ai/settings', { perm: 'config.editar' }, async (ctx) => {
  const b = parse(v.object({ enabled: v.boolean().optional(), accept: v.boolean().optional(), documentsEnabled: v.boolean().optional(), blockedFolders: v.array(v.string({ min: 1, max: 80 }), { max: 50 }).optional() }), ctx.body)
  const s = await companyAI(ctx.user.companyId)
  if (b.enabled === true && !s.enabled) {
    if (!s.platformAllowed) throw forbidden('A IA generativa ainda não foi liberada para esta empresa pela plataforma.')
    if (!b.accept) throw unprocessable('Para ativar, é preciso aceitar os termos de uso da IA.')
  }
  await db.query(`INSERT INTO company_ai(company_id, enabled, accepted_by, accepted_at, documents_enabled, blocked_folders) VALUES ($1, COALESCE($2,false), CASE WHEN $2 THEN $3::uuid END, CASE WHEN $2 THEN now() END, COALESCE($4,true), COALESCE($5,'{}'::text[]))
                  ON CONFLICT (company_id) DO UPDATE SET
                    enabled = COALESCE($2, company_ai.enabled),
                    accepted_by = CASE WHEN $2 AND NOT company_ai.enabled THEN $3::uuid ELSE company_ai.accepted_by END,
                    accepted_at = CASE WHEN $2 AND NOT company_ai.enabled THEN now() ELSE company_ai.accepted_at END,
                    documents_enabled = COALESCE($4, company_ai.documents_enabled), blocked_folders = COALESCE($5, company_ai.blocked_folders), updated_at = now()`,
    [ctx.user.companyId, b.enabled ?? null, ctx.user.id, b.documentsEnabled ?? null, b.blockedFolders ?? null])
  await audit(null, ctx, b.enabled === true && !s.enabled ? 'ia.ativada' : b.enabled === false && s.enabled ? 'ia.desativada' : 'ia.configuracao', null, null, b, b.enabled !== undefined ? 'warning' : 'info')
  return { ok: true }
})

/** Lê os documentos ainda não lidos (ou todos de novo). */
router.post('/api/ai/documents/index', { perm: 'documentos.editar' }, async (ctx) => {
  const b = parse(v.object({ force: v.boolean().optional() }), ctx.body ?? {})
  rateLimit('ia-indexar:' + ctx.user.companyId, 3, 10 * 60_000)
  const n = await indexPending(ctx.user.companyId, !!b.force)
  return { ok: true, processed: n }
})
router.post('/api/documents/:id/reindex', { perm: 'documentos.editar' }, async (ctx) => {
  const d = await db.one(`SELECT id FROM documents WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!d) throw notFound('Documento')
  return indexDocument(d.id)
})

// =====================================================================
// CONSULTAS AO JURÍDICO (pré-análise da IA encaminhada)
// =====================================================================
router.post('/api/legal-consultations', {}, async (ctx) => {
  const b = parse(v.object({ question: v.string({ min: 5, max: 4000 }), aiAnswer: v.string({ max: 20000 }).optional(), aiProvider: v.string({ max: 80 }).optional(),
    sources: v.array(v.object({ type: v.string({ max: 20 }), id: v.string({ max: 60 }).optional(), name: v.string({ max: 300 }).optional(), page: v.int().nullable().optional(), label: v.string({ max: 120 }).optional(), link: v.string({ max: 200 }).optional() }), { max: 30 }).optional(),
    notes: v.string({ max: 2000 }).optional() }), ctx.body)
  rateLimit('consulta-juridica:' + ctx.user.id, 20, 60 * 60_000)
  // documentos citados precisam ser desta empresa
  const docIds = (b.sources ?? []).filter((s) => s.type === 'documento' && s.id).map((s) => s.id!)
  if (docIds.length) { const ok = await db.one(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND id::text = ANY($2::text[])`, [ctx.user.companyId, docIds]); if (ok.n !== new Set(docIds).size) throw unprocessable('Documento citado não pertence a esta empresa.') }
  const r = await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('legal_consultations:' || $1))`, [ctx.user.companyId])
    const n = await c.one(`SELECT COALESCE(max(number), 0) + 1 AS n FROM legal_consultations WHERE company_id = $1`, [ctx.user.companyId])
    return c.one(`INSERT INTO legal_consultations(company_id, number, asked_by, question, ai_answer, ai_provider, sources, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, number, status, created_at`,
      [ctx.user.companyId, n.n, ctx.user.id, b.question, b.aiAnswer ?? null, b.aiProvider ?? null, JSON.stringify(b.sources ?? []), b.notes ?? null])
  })
  await audit(null, ctx, 'juridico.consulta_encaminhada', 'legal_consultation', r.id, { number: r.number })
  return r
})

router.get('/api/legal-consultations', {}, async (ctx) => {
  const all = can(ctx.user, 'juridico.ver')
  const status = ['aberta', 'respondida', 'arquivada'].includes(ctx.query.status) ? ctx.query.status : null
  const items = await db.many(`SELECT lc.id, lc.number, lc.question, lc.status, lc.created_at, lc.responded_at, a.name AS asked_by_name, r.name AS responded_by_name
                                 FROM legal_consultations lc LEFT JOIN users a ON a.id = lc.asked_by LEFT JOIN users r ON r.id = lc.responded_by
                                WHERE lc.company_id = $1 AND ($2 OR lc.asked_by = $3) AND ($4::text IS NULL OR lc.status = $4) ORDER BY lc.created_at DESC LIMIT 200`, [ctx.user.companyId, all, ctx.user.id, status])
  const stats = await db.one(`SELECT count(*) FILTER (WHERE status = 'aberta')::int AS open, count(*) FILTER (WHERE status = 'respondida')::int AS answered FROM legal_consultations WHERE company_id = $1 AND ($2 OR asked_by = $3)`, [ctx.user.companyId, all, ctx.user.id])
  return { items, stats, canRespond: can(ctx.user, 'juridico.editar'), seesAll: all }
})

router.get('/api/legal-consultations/:id', {}, async (ctx) => {
  const r = await db.one(`SELECT lc.*, a.name AS asked_by_name, r.name AS responded_by_name FROM legal_consultations lc LEFT JOIN users a ON a.id = lc.asked_by LEFT JOIN users r ON r.id = lc.responded_by WHERE lc.id = $1 AND lc.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!r || (!can(ctx.user, 'juridico.ver') && r.asked_by !== ctx.user.id)) throw notFound('Consulta')
  return r
})

router.put('/api/legal-consultations/:id', { perm: 'juridico.editar' }, async (ctx) => {
  const b = parse(v.object({ response: v.string({ max: 20000 }).optional(), status: v.enum(['aberta', 'respondida', 'arquivada'] as const).optional() }), ctx.body)
  const r = await db.one(`UPDATE legal_consultations SET response = COALESCE($3, response), status = COALESCE($4, CASE WHEN $3 IS NOT NULL THEN 'respondida' ELSE status END),
                                 responded_by = CASE WHEN $3 IS NOT NULL THEN $5::uuid ELSE responded_by END, responded_at = CASE WHEN $3 IS NOT NULL THEN now() ELSE responded_at END
                           WHERE id = $1 AND company_id = $2 RETURNING id, number, status`, [ctx.params.id, ctx.user.companyId, b.response?.trim() || null, b.status ?? null, ctx.user.id])
  if (!r) throw notFound('Consulta')
  await audit(null, ctx, 'juridico.consulta_atualizada', 'legal_consultation', r.id, { number: r.number, status: r.status })
  return r
})

export { AiError }
