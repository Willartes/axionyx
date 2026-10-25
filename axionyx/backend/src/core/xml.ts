/**
 * Parser XML mínimo e seguro (sem DTD/entidades externas) suficiente para NF-e.
 * Rejeita DOCTYPE/ENTITY para evitar ataques XXE/"billion laughs".
 */
export interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string }

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
  return ENT[e] ?? m
})
const local = (n: string) => (n.includes(':') ? n.split(':')[1] : n)

export function parseXml(xml: string): XNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML com DOCTYPE/ENTITY não é aceito.')
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XNode[] = [root]
  let i = 0
  const len = xml.length
  while (i < len) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    if (lt > i) { const t = xml.slice(i, lt); if (t.trim()) stack[stack.length - 1].text += decode(t) }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); i = e < 0 ? len : e + 3; continue }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt); stack[stack.length - 1].text += xml.slice(lt + 9, e < 0 ? len : e); i = e < 0 ? len : e + 3; continue }
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt); i = e < 0 ? len : e + 2; continue }
    const gt = xml.indexOf('>', lt)
    if (gt < 0) throw new Error('XML malformado.')
    const raw = xml.slice(lt + 1, gt)
    i = gt + 1
    if (raw.startsWith('/')) {
      const name = local(raw.slice(1).trim())
      const top = stack.pop()
      if (!top || top.name !== name) throw new Error(`XML malformado: fechamento inesperado </${name}>.`)
      continue
    }
    const selfClose = raw.endsWith('/')
    const body = selfClose ? raw.slice(0, -1) : raw
    const m = body.match(/^\s*([^\s/>]+)/)
    if (!m) throw new Error('XML malformado.')
    const node: XNode = { name: local(m[1]), attrs: {}, children: [], text: '' }
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let a: RegExpExecArray | null
    const rest = body.slice(m[0].length)
    while ((a = attrRe.exec(rest))) node.attrs[local(a[1])] = decode(a[3] ?? a[4] ?? '')
    stack[stack.length - 1].children.push(node)
    if (!selfClose) stack.push(node)
  }
  if (stack.length !== 1) throw new Error('XML malformado: elementos não fechados.')
  return root
}

export function child(n: XNode | undefined, name: string): XNode | undefined { return n?.children.find((c) => c.name === name) }
export function children(n: XNode | undefined, name: string): XNode[] { return n ? n.children.filter((c) => c.name === name) : [] }
/** Busca em profundidade o primeiro elemento com o nome. */
export function find(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined
  for (const c of n.children) { if (c.name === name) return c; const f = find(c, name); if (f) return f }
  return undefined
}
export function path(n: XNode | undefined, p: string): XNode | undefined { return p.split('/').reduce<XNode | undefined>((acc, k) => child(acc, k), n) }
export function text(n: XNode | undefined, p?: string): string { const t = p ? path(n, p) : n; return (t?.text ?? '').trim() }
