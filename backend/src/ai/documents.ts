import { db, tx } from '../core/db'
import { extractText } from './extract'

/**
 * Índice dos documentos para a IA: texto em trechos com a página, busca em português (sem acentos) pelo próprio
 * PostgreSQL. Documentos clínicos (prontuário, exames, laudos) NUNCA são lidos; pastas bloqueadas pela empresa ficam
 * fora das buscas.
 */
const HEALTH = new Set(['saude', 'odontologia', 'estetica'])
const CLINICAL_FOLDER = /(prontu|exame|laudo|clinic|receitu|receita medica|atestado|anamnese|odontograma)/

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Documento com dado de saúde: nunca vai para a IA (nem é indexado). */
export function isClinical(doc: { folder: string; entity: string | null }, segment: string | null) {
  return CLINICAL_FOLDER.test(norm(doc.folder || '')) || (HEALTH.has(segment || '') && doc.entity === 'customer')
}
export function isBlocked(folder: string, blocked: string[]) { const f = norm(folder || ''); return blocked.some((b) => norm(b) === f) }

function chunks(pages: { page: number | null; text: string }[], size = 1400): { page: number | null; text: string }[] {
  const out: { page: number | null; text: string }[] = []
  for (const p of pages) {
    const paras = p.text.split(/\n{1,}/)
    let cur = ''
    for (const para of paras) {
      if (para.length > size) { if (cur) { out.push({ page: p.page, text: cur }); cur = '' } for (let k = 0; k < para.length; k += size) out.push({ page: p.page, text: para.slice(k, k + size) }); continue }
      if ((cur + '\n' + para).length > size && cur) { out.push({ page: p.page, text: cur }); cur = para } else cur = cur ? cur + '\n' + para : para
    }
    if (cur.trim()) out.push({ page: p.page, text: cur })
  }
  return out.slice(0, 4000)
}

/** Extrai e indexa um documento (substitui a leitura anterior). */
export async function indexDocument(documentId: string): Promise<{ status: string; chunks: number; note?: string }> {
  const d = await db.one(`SELECT d.id, d.company_id, d.name, d.mime, d.folder, d.entity, d.content, c.segment FROM documents d JOIN companies c ON c.id = d.company_id WHERE d.id = $1`, [documentId])
  if (!d) return { status: 'erro', chunks: 0, note: 'documento não encontrado' }
  if (isClinical(d, d.segment)) {
    await save(d, { method: 'bloqueado', pages: null, status: 'bloqueado', chars: 0, note: 'Documento de saúde: não é lido pela IA.' }, [])
    return { status: 'bloqueado', chunks: 0 }
  }
  let ex
  try { ex = extractText(d.name, d.mime, d.content) }
  catch (e: any) { await save(d, { method: 'erro', pages: null, status: 'erro', chars: 0, note: String(e?.message || e).slice(0, 200) }, []); return { status: 'erro', chunks: 0 } }
  const cs = ex.status === 'lido' ? chunks(ex.pages) : []
  const chars = ex.pages.reduce((a, p) => a + p.text.length, 0)
  const pages = ex.pages.reduce((a, p) => Math.max(a, p.page ?? 0), 0) || null
  await save(d, { method: ex.method, pages, status: ex.status, chars, note: ex.note }, cs)
  return { status: ex.status, chunks: cs.length, note: ex.note }
}
async function save(d: any, meta: { method: string; pages: number | null; status: string; chars: number; note?: string }, cs: { page: number | null; text: string }[]) {
  await tx(async (c) => {
    // leituras simultâneas do mesmo documento (envio + "ler de novo") não duplicam trechos
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('doc-index:' || $1))`, [d.id])
    await c.query(`DELETE FROM document_chunks WHERE document_id = $1`, [d.id])
    await c.query(`INSERT INTO document_texts(document_id, company_id, method, pages, chars, status, error, extracted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
                   ON CONFLICT (document_id) DO UPDATE SET method = EXCLUDED.method, pages = EXCLUDED.pages, chars = EXCLUDED.chars, status = EXCLUDED.status, error = EXCLUDED.error, extracted_at = now()`,
      [d.id, d.company_id, meta.method, meta.pages, meta.chars, meta.status, meta.note ?? null])
    for (let k = 0; k < cs.length; k += 200) {
      const part = cs.slice(k, k + 200)
      const vals: any[] = []; const rows: string[] = []
      part.forEach((ch, j) => { const b = vals.length; vals.push(d.id, d.company_id, k + j, ch.page, ch.text, norm(ch.text)); rows.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},to_tsvector('portuguese', $${b + 6}))`) })
      await c.query(`INSERT INTO document_chunks(document_id, company_id, idx, page, content, tsv) VALUES ${rows.join(',')}`, vals)
    }
  })
}

/** Indexa os documentos da empresa que ainda não foram lidos (ou todos, com force). */
export async function indexPending(companyId: string, force = false, max = 500): Promise<number> {
  const ids = await db.many(`SELECT d.id FROM documents d LEFT JOIN document_texts t ON t.document_id = d.id WHERE d.company_id = $1 AND ($2 OR t.document_id IS NULL) ORDER BY d.created_at DESC LIMIT $3`, [companyId, force, max])
  for (const r of ids) await indexDocument(r.id).catch(() => {})
  return ids.length
}

const STOP = new Set(['a', 'o', 'e', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'para', 'por', 'com', 'que', 'qual', 'quais', 'como', 'se', 'ao', 'aos', 'os', 'as', 'meu', 'minha', 'nosso', 'nossa', 'e', 'ou', 'pode', 'posso', 'tem', 'ha', 'sobre', 'isso', 'esse', 'essa', 'este', 'esta'])

/** Busca nos trechos (termos em OU, ordenados por relevância). */
export async function searchDocuments(companyId: string, query: string, opts: { blocked: string[]; folder?: string; limit?: number }) {
  const terms = [...new Set(norm(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)))].slice(0, 16)
  if (!terms.length) return []
  const tsq = terms.map((t) => `${t}:*`).join(' | ')
  const rows = await db.many(`
    SELECT ch.document_id, ch.page, ch.content, d.name, d.folder, d.created_at, ts_rank_cd(ch.tsv, q) AS rank
      FROM document_chunks ch JOIN documents d ON d.id = ch.document_id, to_tsquery('portuguese', $2) q
     WHERE ch.company_id = $1 AND ch.tsv @@ q AND ($3::text IS NULL OR lower(d.folder) = lower($3)) AND NOT (lower(d.folder) = ANY($4::text[]))
     ORDER BY rank DESC, d.created_at DESC LIMIT $5`, [companyId, tsq, opts.folder ?? null, opts.blocked.map((b) => b.toLowerCase()), opts.limit ?? 6])
  return rows.map((r: any) => ({ documentId: r.document_id, name: r.name, folder: r.folder, page: r.page, excerpt: String(r.content).slice(0, 1400) }))
}

/** Texto de um documento (limitado), com marcação de página. */
export async function readDocument(companyId: string, documentId: string, opts: { blocked: string[]; page?: number; maxChars?: number }) {
  const d = await db.one(`SELECT d.id, d.name, d.folder, t.status, t.pages, t.error FROM documents d LEFT JOIN document_texts t ON t.document_id = d.id WHERE d.id = $1 AND d.company_id = $2`, [documentId, companyId])
  if (!d) return { error: 'Documento não encontrado nesta empresa.' }
  if (isBlocked(d.folder, opts.blocked)) return { error: 'Este documento está numa pasta bloqueada para a IA.' }
  if (d.status !== 'lido') return { name: d.name, status: d.status ?? 'nao_lido', note: d.error ?? 'Documento ainda não lido.' }
  const rows = await db.many(`SELECT page, content FROM document_chunks WHERE document_id = $1 AND ($2::int IS NULL OR page = $2) ORDER BY idx`, [documentId, opts.page ?? null])
  const max = opts.maxChars ?? 14_000
  let text = '', lastPage: number | null | undefined
  for (const r of rows) { if (r.page !== lastPage && r.page != null) text += `\n[página ${r.page}]\n`; lastPage = r.page; text += r.content + '\n'; if (text.length > max) { text = text.slice(0, max) + '\n[...continua]'; break } }
  return { documentId, name: d.name, folder: d.folder, pages: d.pages, text: text.trim() }
}
