import zlib from 'node:zlib'

/**
 * Extração de texto de documentos SEM dependências externas: texto puro, CSV, XML (inclui NF-e), Word (.docx),
 * Excel (.xlsx) e PDF com texto (fluxos FlateDecode, fontes com ToUnicode). PDF escaneado (imagem) não tem texto:
 * fica marcado como "sem texto" (a leitura por OCR fica para uma etapa futura).
 */
export interface Extracted { method: string; pages: { page: number | null; text: string }[]; status: 'lido' | 'sem_texto' | 'nao_suportado'; note?: string }

const MAX_TEXT = 2_000_000

export function extractText(name: string, mime: string, buf: Buffer): Extracted {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (/^(txt|csv|tsv|md|json|log)$/.test(ext) || /^text\/(plain|csv)/.test(mime)) return wrap('texto', [{ page: null, text: decodeText(buf) }])
  if (ext === 'xml' || /xml$/.test(mime) && !/openxml/.test(mime)) return wrap('xml', [{ page: null, text: xmlToText(decodeText(buf)) }])
  if (ext === 'docx' || /wordprocessingml/.test(mime)) return wrap('docx', [{ page: null, text: docxText(buf) }])
  if (ext === 'xlsx' || /spreadsheetml/.test(mime)) return wrap('xlsx', xlsxText(buf))
  if (ext === 'pdf' || mime === 'application/pdf') {
    const r = pdfText(buf)
    if (r.encrypted) return { method: 'pdf', pages: [], status: 'nao_suportado', note: 'PDF protegido por senha/criptografia.' }
    return wrap('pdf', r.pages, 'PDF sem texto selecionável (provavelmente escaneado). A leitura de imagens (OCR) ainda não está disponível.')
  }
  if (/^image\//.test(mime) || /^(png|jpe?g|webp)$/.test(ext)) return { method: 'imagem', pages: [], status: 'nao_suportado', note: 'Imagem: a leitura de imagens (OCR) ainda não está disponível.' }
  return { method: ext || 'desconhecido', pages: [], status: 'nao_suportado', note: 'Formato ainda não lido pela IA (use PDF, Word .docx, Excel .xlsx, CSV, XML ou texto).' }
}

function wrap(method: string, pages: { page: number | null; text: string }[], emptyNote?: string): Extracted {
  let total = 0
  const clean = pages.map((p) => ({ page: p.page, text: tidy(p.text) })).filter((p) => { if (total > MAX_TEXT) return false; total += p.text.length; return p.text.length > 0 })
  const letters = clean.reduce((a, p) => a + (p.text.match(/[A-Za-zÀ-ÿ]/g)?.length ?? 0), 0)
  if (letters < 20) return { method, pages: [], status: 'sem_texto', note: emptyNote ?? 'Documento sem texto legível.' }
  return { method, pages: clean, status: 'lido' }
}
const tidy = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()

function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3)
  const utf = buf.toString('utf8')
  // muitos arquivos brasileiros (CSV do Excel) vêm em Windows-1252
  return (utf.match(/�/g)?.length ?? 0) > 2 ? buf.toString('latin1') : utf
}
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const unent = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m))

/** XML: cada valor vira "campo: valor" (útil para NF-e, onde o nome da tag explica o dado). */
function xmlToText(xml: string): string {
  const lines: string[] = []
  const re = /<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]+)<\/(?:[A-Za-z_][\w.-]*:)?\2>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) { const v = unent(m[3]).trim(); if (v) lines.push(`${m[2]}: ${v}`) }
  return lines.length ? lines.join('\n') : unent(xml.replace(/<[^>]+>/g, ' '))
}

// ---------- ZIP (docx/xlsx) ----------
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('arquivo compactado inválido')
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    p += 46 + nlen + xlen + clen
    if (!/\.(xml|rels)$/.test(name) || csize > 60_000_000) continue
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28)
    const data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize)
    try { out.set(name, method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : Buffer.alloc(0)) } catch { /* entrada corrompida */ }
  }
  return out
}
function docxText(buf: Buffer): string {
  const z = unzip(buf)
  const parts = ['word/document.xml', ...[...z.keys()].filter((k) => /^word\/(header|footer|footnotes)\d*\.xml$/.test(k))]
  return parts.map((k) => z.get(k)?.toString('utf8') ?? '').map((xml) =>
    unent(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, ' | ').replace(/<[^>]+>/g, ''))).join('\n')
}
function xlsxText(buf: Buffer): { page: number | null; text: string }[] {
  const z = unzip(buf)
  const shared = [...(z.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unent(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')))
  const wb = z.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => unent(m[1]))
  const sheets = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/(\d+)\.xml/)![1]) - Number(b.match(/(\d+)\.xml/)![1]))
  return sheets.map((k, i) => {
    const xml = z.get(k)!.toString('utf8')
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 5000).map((r) =>
      [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const t = /t="(\w+)"/.exec(c[1])?.[1]; const inner = c[2] ?? ''
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        if (t === 's' && v !== undefined) return shared[Number(v)] ?? ''
        if (t === 'inlineStr') return unent((/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1]) ?? '')
        return v !== undefined ? unent(v) : ''
      }).join(' | ').replace(/( \| )+$/, ''))
    return { page: i + 1, text: `Planilha: ${names[i] ?? 'Planilha ' + (i + 1)}\n` + rows.filter((r) => r.trim()).join('\n') }
  })
}

// ---------- PDF ----------
interface PdfObj { dict: string; stream?: Buffer }
function pdfText(buf: Buffer): { pages: { page: number; text: string }[]; encrypted: boolean } {
  const s = buf.toString('latin1')
  const objs = new Map<number, PdfObj>()
  const re = /(\d+)\s+\d+\s+obj\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length
    const end = s.indexOf('endobj', start)
    if (end < 0) break
    const body = s.slice(start, end)
    const si = body.search(/\bstream\r?\n/)
    if (si >= 0) {
      const dict = body.slice(0, si)
      const ds = start + si + body.slice(si).match(/^stream\r?\n/)![0].length
      const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)
      let de = len ? ds + Number(len[1]) : s.indexOf('endstream', ds)
      if (de < ds || de > end) de = s.indexOf('endstream', ds)
      objs.set(Number(m[1]), { dict, stream: buf.subarray(ds, de) })
    } else objs.set(Number(m[1]), { dict: body })
    re.lastIndex = end
  }
  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(s)
  // objetos dentro de fluxos de objetos (PDF 1.5+)
  for (const [, o] of [...objs]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue
    const data = decodeStream(o)?.toString('latin1'); if (!data) continue
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0), first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0)
    const nums = data.slice(0, first).trim().split(/\s+/).map(Number)
    for (let k = 0; k < n; k++) { const id = nums[k * 2], off = nums[k * 2 + 1], next = k + 1 < n ? nums[k * 2 + 3] : data.length - first
      if (!objs.has(id)) objs.set(id, { dict: data.slice(first + off, first + next) }) }
  }
  const ref = (str: string | undefined) => (str ? Number(/(\d+)\s+\d+\s+R/.exec(str)?.[1]) : NaN)
  const get = (id: number) => objs.get(id)
  // árvore de páginas em ordem
  const pages: { obj: PdfObj; chain: PdfObj[] }[] = []
  const catalog = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict))
  const walk = (id: number, chain: PdfObj[], depth = 0) => {
    const o = get(id); if (!o || depth > 40) return
    if (/\/Type\s*\/Pages\b/.test(o.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? ''
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), [o, ...chain], depth + 1)
    } else if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push({ obj: o, chain })
  }
  if (catalog) walk(ref(/\/Pages\s+(\d+\s+\d+\s+R)/.exec(catalog.dict)?.[1]), [])
  if (!pages.length) for (const o of objs.values()) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push({ obj: o, chain: [] })

  const dictOf = (raw: string | undefined): string => { if (!raw) return ''; const id = /^\s*(\d+)\s+\d+\s+R/.exec(raw); return id ? get(Number(id[1]))?.dict ?? '' : raw }
  const out: { page: number; text: string }[] = []
  pages.slice(0, 2000).forEach((p, idx) => {
    // recursos (podem ser herdados do nó pai)
    let resRaw = ''
    for (const o of [p.obj, ...p.chain]) { const r = /\/Resources\s*(\d+\s+\d+\s+R|<<)/.exec(o.dict); if (r) { resRaw = r[1] === '<<' ? balanced(o.dict, o.dict.indexOf('<<', r.index)) : dictOf(r[1]); break } }
    const fontsRaw = /\/Font\s*(\d+\s+\d+\s+R|<<)/.exec(resRaw)
    const fontsDict = fontsRaw ? (fontsRaw[1] === '<<' ? balanced(resRaw, resRaw.indexOf('<<', fontsRaw.index)) : dictOf(fontsRaw[1])) : ''
    const fonts = new Map<string, Map<string, string> & { bytes?: number }>()
    for (const f of fontsDict.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const fd = get(Number(f[2]))?.dict ?? ''
      const tu = ref(/\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(fd)?.[1])
      const cm = Number.isFinite(tu) ? get(tu) : undefined
      if (cm?.stream) { const txt = decodeStream(cm)?.toString('latin1'); if (txt) fonts.set(f[1], parseCMap(txt)) }
    }
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(p.obj.dict)?.[1] ?? ''
    const streams = [...contents.matchAll(/(\d+)\s+\d+\s+R/g)].map((c) => get(Number(c[1]))).filter((o): o is PdfObj => !!o?.stream)
    const data = streams.map((o) => decodeStream(o)?.toString('latin1') ?? '').join('\n')
    out.push({ page: idx + 1, text: contentText(data, fonts) })
  })
  return { pages: out, encrypted }
}
function balanced(s: string, start: number): string {
  let depth = 0
  for (let i = start; i < s.length - 1; i++) {
    if (s[i] === '<' && s[i + 1] === '<') { depth++; i++ } else if (s[i] === '>' && s[i + 1] === '>') { depth--; i++; if (depth === 0) return s.slice(start, i + 1) }
  }
  return s.slice(start)
}
function decodeStream(o: PdfObj): Buffer | null {
  if (!o.stream) return null
  const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(o.dict)?.[1] ?? ''
  if (!f) return o.stream
  if (/FlateDecode/.test(f) && !/(DCT|JPX|JBIG2|CCITT|LZW|ASCII85|RunLength)/.test(f)) {
    try { return zlib.inflateSync(o.stream) } catch { try { return zlib.inflateSync(o.stream, { finishFlush: zlib.constants.Z_SYNC_FLUSH }) } catch { return null } }
  }
  return null
}
function parseCMap(txt: string): Map<string, string> & { bytes?: number } {
  const map = new Map<string, string>() as Map<string, string> & { bytes?: number }
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(txt); map.bytes = cs ? cs[1].length / 2 : 1
  const hex = (h: string) => { let o = ''; for (let i = 0; i + 4 <= h.length; i += 4) o += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return o }
  for (const b of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const e of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(e[1].toLowerCase(), hex(e[2]))
  for (const b of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const e of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(e[1], 16), hi = parseInt(e[2], 16), w = e[1].length
      if (hi - lo > 5000) continue
      if (e[3].startsWith('[')) { const arr = [...e[3].matchAll(/<([0-9a-fA-F]+)>/g)]; for (let c = lo; c <= hi; c++) if (arr[c - lo]) map.set(c.toString(16).padStart(w, '0'), hex(arr[c - lo][1])) }
      else { const startHex = e[3].slice(1, -1); const base = parseInt(startHex.slice(-4), 16); const prefix = hex(startHex.slice(0, -4))
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(w, '0'), prefix + String.fromCharCode(base + c - lo)) }
    }
  }
  return map
}
// Operadores de texto do PDF: Tf (fonte), Tj, TJ, aspas (texto), Td, TD, T-estrela, Tm (posição → quebras de linha).
function contentText(d: string, fonts: Map<string, Map<string, string> & { bytes?: number }>): string {
  let out = '', font: (Map<string, string> & { bytes?: number }) | undefined, lastY: number | null = null
  const stack: (string | number | { arr: (string | number)[] } | { name: string })[] = []
  const decode = (raw: string) => {
    if (font && font.size) {
      const n = font.bytes ?? 1; let r = ''
      for (let i = 0; i + n <= raw.length; i += n) { let h = ''; for (let k = 0; k < n; k++) h += raw.charCodeAt(i + k).toString(16).padStart(2, '0'); r += font.get(h) ?? (n === 1 ? raw[i] : '') }
      return r
    }
    return raw
  }
  let i = 0
  const readLiteral = () => { let depth = 1, r = ''; i++
    while (i < d.length && depth > 0) { const c = d[i]
      if (c === '\\') { const n = d[i + 1]; const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
        if (esc[n] !== undefined) { r += esc[n]; i += 2; continue }
        if (/[0-7]/.test(n)) { const o = /^[0-7]{1,3}/.exec(d.slice(i + 1))![0]; r += String.fromCharCode(parseInt(o, 8) & 255); i += 1 + o.length; continue }
        if (n === '\r' || n === '\n') { i += 2; continue }
        i++; continue }
      if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) { i++; break } }
      r += c; i++ }
    return r }
  const readHex = () => { const e = d.indexOf('>', i); const h = d.slice(i + 1, e).replace(/\s+/g, ''); i = e + 1; let r = ''; const hh = h.length % 2 ? h + '0' : h; for (let k = 0; k < hh.length; k += 2) r += String.fromCharCode(parseInt(hh.slice(k, k + 2), 16)); return r }
  let arr: (string | number)[] | null = null
  while (i < d.length) {
    const c = d[i]
    if (c === '%') { const e = d.indexOf('\n', i); i = e < 0 ? d.length : e; continue }
    if (c === '(') { const s = readLiteral(); (arr ?? stack as any).push(s); continue }
    if (c === '<' && d[i + 1] !== '<') { const s = readHex(); (arr ?? stack as any).push(s); continue }
    if (c === '[') { arr = []; i++; continue }
    if (c === ']') { stack.push({ arr: arr ?? [] }); arr = null; i++; continue }
    if (c === '/') { const mm = /^\/[^\s/<>\[\]()%{}]+/.exec(d.slice(i, i + 128)); const nm = mm ? mm[0] : '/'; stack.push({ name: nm.slice(1) }); i += nm.length; continue }
    if (/[\s<>{}]/.test(c)) { i++; continue }
    const tok = /^[^\s/<>\[\]()%{}]+/.exec(d.slice(i, i + 64))?.[0] ?? c; i += tok.length
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) { (arr ?? stack as any).push(Number(tok)); continue }
    switch (tok) {
      case 'Tf': { const nm = stack.slice().reverse().find((x: any) => x && typeof x === 'object' && 'name' in x) as any; font = nm ? fonts.get(nm.name) : undefined; break }
      case 'Tj': case "'": case '"': { const sv = stack.slice().reverse().find((x) => typeof x === 'string') as string | undefined; if (tok !== 'Tj') out += '\n'; if (sv !== undefined) out += decode(sv); break }
      case 'TJ': { const a = stack.slice().reverse().find((x: any) => x && typeof x === 'object' && 'arr' in x) as any; if (a) for (const x of a.arr) { if (typeof x === 'string') out += decode(x); else if (x < -180) out += ' ' } break }
      case 'Td': case 'TD': { const ty = stack[stack.length - 1]; if (typeof ty === 'number' && Math.abs(ty) > 0.5) out += '\n'; else out += ' '; break }
      case 'Tm': { const y = stack[stack.length - 1]; if (typeof y === 'number') { if (lastY !== null && Math.abs(y - lastY) > 0.5) out += '\n'; else out += ' '; lastY = y } break }
      case 'T*': out += '\n'; break
      case 'ET': out += '\n'; break
    }
    stack.length = 0
  }
  return out
}
