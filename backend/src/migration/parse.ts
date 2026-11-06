import { unzip } from '../ai/extract'

/**
 * Leitura das planilhas exportadas de outros ERPs: CSV (separador ; , ou tab detectado, aspas, UTF-8 ou Windows-1252)
 * e Excel .xlsx (primeira planilha, ou a escolhida). Devolve cabeçalho + linhas como texto.
 */
export interface Sheet { headers: string[]; rows: string[][]; sheets?: string[] }
const MAX_ROWS = 20_000

export function parseSpreadsheet(name: string, buf: Buffer, sheetIndex = 0): Sheet {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'xlsx' || (buf[0] === 0x50 && buf[1] === 0x4b)) return parseXlsx(buf, sheetIndex)
  if (ext === 'xls') throw new Error('Arquivo .xls (Excel antigo): abra no Excel e salve como .xlsx ou .csv.')
  return parseCsv(decode(buf))
}

function decode(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3)
  const utf = buf.toString('utf8')
  return (utf.match(/�/g)?.length ?? 0) > 2 ? buf.toString('latin1') : utf
}

export function parseCsv(text: string): Sheet {
  const firstLine = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'))
  const sep = [';', '\t', ',', '|'].map((s) => ({ s, n: firstLine.split(s).length })).sort((a, b) => b.n - a.n)[0].s
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += ch; continue }
    if (ch === '"' && cell === '') { q = true; continue }
    if (ch === sep) { row.push(cell); cell = ''; continue }
    if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; if (rows.length > MAX_ROWS + 1) break; continue }
    cell += ch
  }
  if (cell || row.length) { row.push(cell); if (row.some((c) => c.trim())) rows.push(row) }
  if (!rows.length) throw new Error('Planilha vazia.')
  const headers = rows[0].map((h, i) => h.trim() || `Coluna ${i + 1}`)
  return { headers, rows: rows.slice(1, MAX_ROWS + 1).map((r) => headers.map((_, i) => (r[i] ?? '').trim())) }
}

const ent = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&')
const colIndex = (ref: string) => { const l = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'; let n = 0; for (const ch of l) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1 }

function parseXlsx(buf: Buffer, sheetIndex: number): Sheet {
  const z = unzip(buf)
  const shared = [...(z.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => ent(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')))
  const wb = z.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => ent(m[1]))
  const files = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]))
  const xml = z.get(files[Math.min(sheetIndex, files.length - 1)])?.toString('utf8')
  if (!xml) throw new Error('Planilha do Excel sem dados.')
  // datas do Excel vêm como número de série: as colunas com estilo de data são convertidas depois, na validação
  const rows: string[][] = []
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const out: string[] = []
    for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(c[1])?.[1] ?? ''
      const t = /t="(\w+)"/.exec(c[1])?.[1]; const inner = c[2] ?? ''
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      const val = t === 's' && v !== undefined ? shared[Number(v)] ?? '' : t === 'inlineStr' ? ent(/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '') : v !== undefined ? ent(v) : ''
      out[ref ? colIndex(ref) : out.length] = val
    }
    if (out.some((x) => x && x.trim())) rows.push(Array.from(out, (x) => (x ?? '').trim()))
    if (rows.length > MAX_ROWS + 1) break
  }
  if (!rows.length) throw new Error('Planilha do Excel sem dados.')
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length))
  const headers = Array.from({ length: width }, (_, i) => rows[0][i]?.trim() || `Coluna ${i + 1}`)
  return { headers, rows: rows.slice(1, MAX_ROWS + 1).map((r) => headers.map((_, i) => r[i] ?? '')), sheets }
}
