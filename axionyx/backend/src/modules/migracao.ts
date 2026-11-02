import { router, audit, rateLimit } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, conflict } from '../core/errors'
import { requirePlatform } from '../core/platform'
import { parseSpreadsheet } from '../migration/parse'
import { FIELDS, autoMap, type Kind } from '../migration/fields'
import { validate, commit, undo, type Preview } from '../migration/importer'
import { analyzeZip, commitXml, type Note } from '../migration/xml'
import { startJob } from '../backup/jobs'
import { platformAI, providerKey, modelOf } from '../ai/config'
import { runLoop } from '../ai/providers'

/**
 * Central de Migração: exclusiva da equipe da plataforma com a permissão "Migração de dados".
 * Fluxo: enviar arquivo → conferir colunas → prévia (nada gravado) → importar (uma transação) → desfazer em até 7 dias.
 */
const P = { perm: 'admin.empresas' } as const
const guard = (ctx: any) => requirePlatform(ctx, 'plataforma.migracao')
const KINDS = ['clientes', 'fornecedores', 'produtos', 'estoque', 'receber', 'pagar'] as const
const UNDO_DAYS = 7

async function company(id: string) {
  const c = await db.one(`SELECT id, name, trade_name, is_demo FROM companies WHERE id = $1`, [id])
  if (!c) throw notFound('Empresa')
  return c
}
async function loadBatch(id: string) {
  const b = await db.one(`SELECT * FROM migration_batches WHERE id = $1`, [id])
  if (!b) throw notFound('Lote')
  return b
}
/** Para a tela: todos os erros (até 1000) e uma amostra das linhas válidas. */
function view(p: Preview) {
  const bad = p.items.filter((x) => x.action === 'erro' || x.warnings.length).slice(0, 1000)
  const sample = p.items.filter((x) => x.action !== 'erro').slice(0, 30)
  const strip = (x: any) => ({ ...x, data: Object.fromEntries(Object.entries(x.data).filter(([k]) => !k.startsWith('_'))) })
  return { summary: p.summary, issues: bad.map(strip), sample: sample.map(strip) }
}
async function previewOf(b: any) {
  if (b.kind === 'xml') return { summary: b.summary, issues: (b.summary?.problems ?? []), sample: [] }
  const p = await validate(b.kind as Kind, b.rows_data.headers, b.rows_data.rows, b.mapping ?? {}, b.company_id)
  return view(p)
}
const pub = (b: any) => { const { rows_data, ...rest } = b; return { ...rest, headers: rows_data?.headers ?? [], rowsCount: rows_data?.rows?.length ?? rows_data?.notes?.length ?? 0, canUndo: b.status === 'importado' && Date.now() - new Date(b.imported_at).getTime() < UNDO_DAYS * 86400_000 } }

router.get('/api/platform/migration/meta', P, async (ctx) => {
  guard(ctx)
  const [companies, profiles, ai] = await Promise.all([
    db.many(`SELECT c.id, c.name, c.trade_name, c.is_demo, (SELECT json_agg(json_build_object('id', b.id, 'code', b.code, 'name', b.name) ORDER BY b.code) FROM branches b WHERE b.company_id = c.id AND b.active) AS branches
               FROM companies c WHERE c.active ORDER BY c.name`),
    db.many(`SELECT id, name, kind, mapping FROM migration_profiles ORDER BY name`),
    platformAI().then(async (p) => !!(p.provider && (await providerKey(p.provider)))).catch(() => false),
  ])
  return { kinds: KINDS, fields: Object.fromEntries(KINDS.map((k) => [k, FIELDS[k].map(({ key, label, required, type }) => ({ key, label, required: !!required, type: type ?? 'texto' }))])), companies, profiles, ai, undoDays: UNDO_DAYS }
})

router.get('/api/platform/migration/batches', P, async (ctx) => {
  guard(ctx)
  const rows = await db.many(`SELECT b.id, b.company_id, c.name AS company_name, b.branch_id, b.kind, b.source_name, b.status, b.summary, b.created_at, b.imported_at, b.undone_at, b.error, u.name AS created_by_name,
                                     jsonb_array_length(COALESCE(b.rows_data->'rows', b.rows_data->'notes', '[]'::jsonb)) AS rows_count
                                FROM migration_batches b JOIN companies c ON c.id = b.company_id LEFT JOIN users u ON u.id = b.created_by
                               WHERE ($1::uuid IS NULL OR b.company_id = $1) ORDER BY b.created_at DESC LIMIT 100`, [ctx.query.company || null])
  return rows.map((b: any) => ({ ...b, canUndo: b.status === 'importado' && Date.now() - new Date(b.imported_at).getTime() < UNDO_DAYS * 86400_000 }))
})

/** Envio do arquivo (corpo cru). Parâmetros: company, kind, branch (opcional), name, sheet. */
router.post('/api/platform/migration/upload', { ...P, maxBody: 60_000_000 }, async (ctx) => {
  guard(ctx)
  rateLimit('mig-up:' + ctx.user.id, 60, 60 * 60_000)
  const q = parse(v.object({ company: v.uuid(), kind: v.enum([...KINDS, 'xml'] as const), branch: v.uuid().optional(), name: v.string({ max: 200 }).default('arquivo'), sheet: v.string({ max: 3 }).optional(), profile: v.uuid().optional() }), ctx.query)
  const co = await company(q.company)
  const branch = q.branch ? await db.one(`SELECT id FROM branches WHERE id = $1 AND company_id = $2 AND active`, [q.branch, co.id]) : await db.one(`SELECT id FROM branches WHERE company_id = $1 AND active ORDER BY code LIMIT 1`, [co.id])
  if (!branch) throw unprocessable('A empresa não tem filial ativa.')
  if (!ctx.rawBody?.length) throw unprocessable('Envie o arquivo.')
  let data: any, mapping: any = null, summary: any
  try {
    if (q.kind === 'xml') {
      const a = await analyzeZip(ctx.rawBody, co.id)
      data = { notes: a.notes }; summary = { ...a.summary, problems: a.problems }
    } else {
      const sh = parseSpreadsheet(q.name, ctx.rawBody, Number(q.sheet ?? 0))
      if (!sh.rows.length) throw new Error('A planilha só tem o cabeçalho.')
      data = { headers: sh.headers, rows: sh.rows, sheets: sh.sheets }
      mapping = autoMap(q.kind, sh.headers)
      if (q.profile) { const p = await db.one(`SELECT mapping FROM migration_profiles WHERE id = $1 AND kind = $2`, [q.profile, q.kind]); if (p) for (const [k, col] of Object.entries(p.mapping as Record<string, string | null>)) if (col === null || sh.headers.includes(col)) mapping[k] = col }
    }
  } catch (e: any) { throw unprocessable(e.message) }
  const b = await db.one(`INSERT INTO migration_batches(company_id, branch_id, kind, source_name, status, mapping, summary, rows_data, created_by) VALUES ($1,$2,$3,$4,'previa',$5,$6,$7,$8) RETURNING *`,
    [co.id, branch.id, q.kind, q.name.slice(0, 200), JSON.stringify(mapping ?? {}), JSON.stringify(summary ?? {}), JSON.stringify(data), ctx.user.id])
  const preview = await previewOf(b)
  if (q.kind !== 'xml') await db.query(`UPDATE migration_batches SET summary = $2 WHERE id = $1`, [b.id, JSON.stringify(preview.summary)])
  await audit(null, ctx, 'migracao.enviada', 'migration_batch', b.id, { kind: q.kind, file: q.name, rows: data.rows?.length ?? data.notes?.length }, 'info', { companyId: co.id })
  return { batch: pub({ ...b, summary: preview.summary }), preview }
})

router.get('/api/platform/migration/batches/:id', P, async (ctx) => {
  guard(ctx)
  const b = await loadBatch(ctx.params.id)
  return { batch: pub(b), preview: b.status === 'previa' ? await previewOf(b) : null }
})

router.put('/api/platform/migration/batches/:id/mapping', P, async (ctx) => {
  guard(ctx)
  const b = await loadBatch(ctx.params.id)
  if (b.kind === 'xml' || b.status !== 'previa') throw conflict('Este lote não aceita mais alteração de colunas.')
  const m = ctx.body?.mapping
  if (!m || typeof m !== 'object') throw unprocessable('Envie o mapeamento.')
  const mapping: Record<string, string | null> = {}
  for (const f of FIELDS[b.kind as Kind]) { const col = m[f.key]; mapping[f.key] = typeof col === 'string' && b.rows_data.headers.includes(col) ? col : null }
  const nb = { ...b, mapping }
  const preview = await previewOf(nb)
  await db.query(`UPDATE migration_batches SET mapping = $2, summary = $3 WHERE id = $1`, [b.id, JSON.stringify(mapping), JSON.stringify(preview.summary)])
  return { batch: pub({ ...nb, summary: preview.summary }), preview }
})

/**
 * Sugestão de colunas por IA. Só vão ao provedor os nomes das colunas e o "formato" de 3 valores de exemplo
 * (letras viram "a", dígitos viram "9"): nenhum dado de cliente sai do sistema.
 */
router.post('/api/platform/migration/batches/:id/ai-mapping', P, async (ctx) => {
  guard(ctx)
  rateLimit('mig-ia:' + ctx.user.id, 30, 60 * 60_000)
  const b = await loadBatch(ctx.params.id)
  if (b.kind === 'xml' || b.status !== 'previa') throw conflict('Lote sem colunas para mapear.')
  const p = await platformAI()
  const key = p.provider ? await providerKey(p.provider) : null
  if (!p.provider || !key) throw unprocessable('Configure um provedor de IA em Plataforma > IA generativa para usar esta sugestão.')
  const headers: string[] = b.rows_data.headers
  const shape = (s: string) => s.slice(0, 24).replace(/[A-Za-zÀ-ÿ]/g, 'a').replace(/\d/g, '9')
  const cols = headers.map((h, i) => ({ coluna: h, exemplos: b.rows_data.rows.slice(0, 3).map((r: string[]) => shape(r[i] ?? '')) }))
  const fields = FIELDS[b.kind as Kind].map((f) => ({ campo: f.key, descricao: f.label, obrigatorio: !!f.required }))
  const out = await runLoop({ provider: p.provider, key: key.key, model: modelOf(p, p.provider), tools: [], exec: async () => null, maxSteps: 1, maxTokens: 1500, timeoutMs: 60_000,
    system: 'Você mapeia colunas de planilhas exportadas de ERPs brasileiros para os campos do AXIONYX. Responda SOMENTE com um objeto JSON {"campo": "nome exato da coluna" ou null}. Use cada coluna no máximo uma vez. Não invente colunas.',
    history: [{ role: 'user', text: `Tipo de cadastro: ${b.kind}\nCampos do AXIONYX: ${JSON.stringify(fields)}\nColunas da planilha (exemplos só com o formato: a=letra, 9=dígito): ${JSON.stringify(cols)}` }] })
  let parsed: any
  try { parsed = JSON.parse((/\{[\s\S]*\}/.exec(out.text) ?? ['{}'])[0]) } catch { throw unprocessable('A IA não devolveu um mapeamento válido. Ajuste as colunas manualmente.') }
  const mapping: Record<string, string | null> = {}, used = new Set<string>()
  for (const f of FIELDS[b.kind as Kind]) { const col = parsed[f.key]; if (typeof col === 'string' && headers.includes(col) && !used.has(col)) { mapping[f.key] = col; used.add(col) } else mapping[f.key] = null }
  return { mapping, provider: p.provider }
})

router.post('/api/platform/migration/batches/:id/commit', P, async (ctx) => {
  guard(ctx)
  const b = await loadBatch(ctx.params.id)
  if (b.status !== 'previa') throw conflict('Este lote já foi importado ou descartado.')
  let items: any = null, preview: any = null
  if (b.kind !== 'xml') {
    const p = await validate(b.kind, b.rows_data.headers, b.rows_data.rows, b.mapping ?? {}, b.company_id)
    if (!p.summary.novos) throw unprocessable('Nenhuma linha nova para importar.')
    if (p.summary.erros && !ctx.body?.ignoreErrors) throw unprocessable(`Há ${p.summary.erros} linha(s) com erro. Corrija a planilha ou confirme importar só as linhas válidas.`)
    items = p.items; preview = p.summary
  } else if (!b.rows_data.notes?.length) throw unprocessable('Nenhuma nota para importar.')
  const lock = await db.one(`UPDATE migration_batches SET status = 'importando', error = NULL WHERE id = $1 AND status = 'previa' RETURNING id`, [b.id])
  if (!lock) throw conflict('Este lote já está sendo importado.')
  const userId = ctx.user.id
  const jobId = await startJob('migracao', b.company_id, userId, async (progress) => {
    try {
      const result = await tx(async (c) => {
        const o = { batchId: b.id, companyId: b.company_id, branchId: b.branch_id, userId, onProgress: (done: number, total: number) => progress({ done, total }) }
        return b.kind === 'xml' ? commitXml(c, b.rows_data.notes as Note[], o) : commit(c, b.kind, items, o)
      })
      await db.query(`UPDATE migration_batches SET status = 'importado', imported_at = now(), summary = summary || $2 WHERE id = $1`, [b.id, JSON.stringify({ importado: result, ...(preview ? { previa: preview } : {}) })])
      return result
    } catch (e: any) {
      await db.query(`UPDATE migration_batches SET status = 'previa', error = $2 WHERE id = $1`, [b.id, String(e.message).slice(0, 500)])
      throw e
    }
  })
  await audit(null, ctx, 'migracao.importada', 'migration_batch', b.id, { kind: b.kind, file: b.source_name }, 'warning', { companyId: b.company_id })
  return { jobId }
})

router.post('/api/platform/migration/batches/:id/undo', P, async (ctx) => {
  guard(ctx)
  const b = await loadBatch(ctx.params.id)
  if (b.status !== 'importado') throw conflict('Só é possível desfazer um lote importado.')
  if (Date.now() - new Date(b.imported_at).getTime() > UNDO_DAYS * 86400_000) throw conflict(`O prazo para desfazer (${UNDO_DAYS} dias) acabou.`)
  const userId = ctx.user.id
  const jobId = await startJob('migracao_desfazer', b.company_id, userId, async () => {
    const r = await tx(async (c) => {
      const lock = await c.one(`SELECT id FROM migration_batches WHERE id = $1 AND status = 'importado' FOR UPDATE`, [b.id])
      if (!lock) throw new Error('Lote já desfeito.')
      const out = await undo(c, b, userId)
      await c.query(`UPDATE migration_batches SET status = 'desfeito', undone_at = now(), undone_by = $2, summary = summary || $3 WHERE id = $1`, [b.id, userId, JSON.stringify({ desfeito: out })])
      return out
    })
    return r
  })
  await audit(null, ctx, 'migracao.desfeita', 'migration_batch', b.id, { kind: b.kind, file: b.source_name }, 'warning', { companyId: b.company_id })
  return { jobId }
})

router.delete('/api/platform/migration/batches/:id', P, async (ctx) => {
  guard(ctx)
  const r = await db.one(`DELETE FROM migration_batches WHERE id = $1 AND status = 'previa' RETURNING id`, [ctx.params.id])
  if (!r) throw conflict('Só é possível descartar um lote que ainda não foi importado.')
  return { ok: true }
})

/** Relatório de erros/avisos em CSV (abre no Excel). */
router.get('/api/platform/migration/batches/:id/errors.csv', P, async (ctx) => {
  guard(ctx)
  const b = await loadBatch(ctx.params.id)
  const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
  let lines: string[]
  if (b.kind === 'xml') lines = ['Arquivo;Problema', ...((b.summary?.problems ?? []) as any[]).map((p) => [esc(p.file), esc(p.error)].join(';'))]
  else {
    const p = await validate(b.kind, b.rows_data.headers, b.rows_data.rows, b.mapping ?? {}, b.company_id)
    lines = ['Linha;Situação;Erros;Avisos;' + b.rows_data.headers.map(esc).join(';'),
      ...p.items.filter((x) => x.action === 'erro' || x.warnings.length).map((x) => [x.line, x.action === 'erro' ? 'Não será importada' : 'Importada com aviso', esc(x.errors.join(' | ')), esc(x.warnings.join(' | ')), ...b.rows_data.rows[x.line - 2].map(esc)].join(';'))]
  }
  ctx.reply = { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="erros-migracao-${b.id.slice(0, 8)}.csv"`, 'cache-control': 'no-store' }, raw: Buffer.from('﻿' + lines.join('\r\n'), 'utf8') }
})

router.post('/api/platform/migration/profiles', P, async (ctx) => {
  guard(ctx)
  const b = parse(v.object({ name: v.string({ min: 2, max: 80 }), kind: v.enum(KINDS), mapping: v.any() }), ctx.body)
  const r = await db.one(`INSERT INTO migration_profiles(name, kind, mapping) VALUES ($1,$2,$3) ON CONFLICT (name, kind) DO UPDATE SET mapping = EXCLUDED.mapping RETURNING id, name, kind, mapping`, [b.name, b.kind, JSON.stringify(b.mapping ?? {})])
  return r
})
router.delete('/api/platform/migration/profiles/:id', P, async (ctx) => { guard(ctx); await db.query(`DELETE FROM migration_profiles WHERE id = $1`, [ctx.params.id]); return { ok: true } })
