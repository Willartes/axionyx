import { db, nextNumber, type Q } from '../core/db'
import { parseXml, find, child, children, text, type XNode } from '../core/xml'
import { unzip } from '../ai/extract'
import { createVariants } from '../modules/produtos'
import { norm, gtinOk } from './fields'

/**
 * Migração por XML de NF-e: um .zip com os XMLs que a empresa emitiu e recebeu (o contador ou o ERP antigo exporta).
 * Monta catálogo (a partir das vendas), fornecedores, clientes e o histórico de vendas, sem mexer em estoque nem financeiro.
 * Notas canceladas (evento 110111 ou protocolo 101/135/155) e notas já importadas (mesma chave) são ignoradas.
 */
export const MAX_NOTES = 10_000
const dig = (s: string) => s.replace(/\D/g, '')
const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0 }

export interface Note {
  key: string; kind: 'venda' | 'compra'; number: string; series: string; issuedAt: string; emitCnpj: string; destDoc: string
  party: { doc: string; name: string; tradeName?: string; ie?: string; email?: string; phone?: string; address?: Record<string, string> } | null
  items: { code: string; ean: string | null; name: string; ncm: string; cest: string; unit: string; qty: number; unitPrice: number; discount: number; total: number }[]
  total: number; discount: number
}
export interface XmlAnalysis { notes: Note[]; summary: Record<string, number>; problems: { file: string; error: string }[] }

function addr(e: XNode | undefined) {
  if (!e) return undefined
  const a: Record<string, string> = { logradouro: text(e, 'xLgr'), numero: text(e, 'nro'), complemento: text(e, 'xCpl'), bairro: text(e, 'xBairro'), cidade: text(e, 'xMun'), uf: text(e, 'UF'), cep: text(e, 'CEP') }
  for (const k of Object.keys(a)) if (!a[k]) delete a[k]
  return a
}

export async function analyzeZip(buf: Buffer, companyId: string): Promise<XmlAnalysis> {
  let files: Map<string, Buffer>
  try { files = unzip(buf, /\.xml$/i) } catch { throw new Error('Arquivo .zip inválido.') }
  if (!files.size) throw new Error('Nenhum XML encontrado no .zip.')
  const own = new Set((await db.many(`SELECT cnpj FROM companies WHERE id = $1 AND cnpj IS NOT NULL UNION SELECT cnpj FROM branches WHERE company_id = $1 AND cnpj IS NOT NULL`, [companyId])).map((r: any) => dig(r.cnpj)))
  if (!own.size) throw new Error('Cadastre o CNPJ da empresa (ou das filiais) antes: é por ele que o sistema separa vendas de compras.')
  const cancelled = new Set<string>(), protoCancel = new Set<string>()
  const parsed: Note[] = []
  const problems: XmlAnalysis['problems'] = []
  const s = { arquivos: files.size, vendas: 0, compras: 0, canceladas: 0, duplicadas: 0, repetidas: 0, de_terceiros: 0, eventos: 0, invalidas: 0 }
  for (const [file, data] of files) {
    let root: XNode
    try { root = parseXml(data.toString('utf8')) } catch (e: any) { problems.push({ file, error: 'XML inválido' }); s.invalidas++; continue }
    const ev = find(root, 'infEvento')
    if (ev && !find(root, 'infNFe')) { s.eventos++; if (text(ev, 'tpEvento') === '110111') { const k = text(ev, 'chNFe'); const st = text(find(root, 'retEvento') ?? find(root, 'infEvento'), 'cStat'); if (/^\d{44}$/.test(k) && (!st || ['135', '136', '155'].includes(st) || !find(root, 'retEvento'))) cancelled.add(k) } continue }
    const inf = find(root, 'infNFe')
    if (!inf) { problems.push({ file, error: 'Não é NF-e/NFC-e' }); s.invalidas++; continue }
    const key = (inf.attrs.Id || '').replace(/^NFe/, '')
    if (!/^\d{44}$/.test(key)) { problems.push({ file, error: 'Chave de acesso inválida' }); s.invalidas++; continue }
    const cStat = text(find(root, 'infProt'), 'cStat')
    if (['101', '135', '151', '155'].includes(cStat)) { if (!cancelled.has(key)) s.canceladas++; cancelled.add(key); protoCancel.add(key); continue }
    const ide = child(inf, 'ide'), emit = child(inf, 'emit'), dest = child(inf, 'dest'), tot = find(inf, 'ICMSTot')
    const emitCnpj = dig(text(emit, 'CNPJ') || text(emit, 'CPF')), destDoc = dig(text(dest, 'CNPJ') || text(dest, 'CPF'))
    const tpNF = text(ide, 'tpNF')
    let kind: Note['kind'] | null = null
    if (own.has(emitCnpj) && tpNF === '1') kind = 'venda'
    else if (own.has(destDoc) && !own.has(emitCnpj)) kind = 'compra'
    if (!kind) { s.de_terceiros++; continue }
    const p = kind === 'venda' ? dest : emit
    const party = p && (kind === 'compra' || destDoc) ? { doc: kind === 'venda' ? destDoc : emitCnpj, name: text(p, 'xNome').slice(0, 150), tradeName: text(p, 'xFant') || undefined, ie: text(p, 'IE') || undefined, email: text(p, 'email').toLowerCase() || undefined,
      phone: dig(text(child(p, kind === 'venda' ? 'enderDest' : 'enderEmit'), 'fone')) || undefined, address: addr(child(p, kind === 'venda' ? 'enderDest' : 'enderEmit')) } : null
    parsed.push({
      key, kind, number: text(ide, 'nNF'), series: text(ide, 'serie'), issuedAt: text(ide, 'dhEmi') || (text(ide, 'dEmi') + 'T12:00:00-03:00'), emitCnpj, destDoc, party,
      items: children(inf, 'det').map((d) => { const pr = child(d, 'prod'); const e = dig(text(pr, 'cEAN')); return { code: text(pr, 'cProd').slice(0, 40), ean: e.length >= 8 && gtinOk(e) ? e : null, name: text(pr, 'xProd').slice(0, 150), ncm: dig(text(pr, 'NCM')), cest: dig(text(pr, 'CEST')), unit: text(pr, 'uCom').slice(0, 6).toUpperCase() || 'UN', qty: num(text(pr, 'qCom')), unitPrice: num(text(pr, 'vUnCom')), discount: num(text(pr, 'vDesc')), total: num(text(pr, 'vProd')) } }).filter((i) => i.qty > 0),
      total: num(text(tot, 'vNF')), discount: num(text(tot, 'vDesc')),
    })
  }
  const seen = new Set<string>()
  const dupes = new Set((await db.many(`SELECT external_id FROM sales WHERE company_id = $1 AND external_id = ANY($2)`, [companyId, parsed.map((n) => 'nfe:' + n.key)])).map((r: any) => r.external_id))
  const notes: Note[] = []
  for (const n of parsed) {
    if (cancelled.has(n.key)) { if (!protoCancel.has(n.key) && !seen.has(n.key)) s.canceladas++; seen.add(n.key); continue }
    if (seen.has(n.key)) { s.repetidas++; continue }
    seen.add(n.key)
    if (n.kind === 'venda' && dupes.has('nfe:' + n.key)) { s.duplicadas++; continue }
    if (notes.length >= MAX_NOTES) { problems.push({ file: '', error: `Limite de ${MAX_NOTES} notas por lote: divida o .zip` }); break }
    notes.push(n); s[n.kind === 'venda' ? 'vendas' : 'compras']++
  }
  // o que seria criado
  const docs = new Set(notes.filter((n) => n.kind === 'venda' && n.party?.doc).map((n) => n.party!.doc))
  const sups = new Set(notes.filter((n) => n.kind === 'compra').map((n) => n.emitCnpj))
  const codes = new Set(notes.filter((n) => n.kind === 'venda').flatMap((n) => n.items.map((i) => i.code)))
  const [c1, c2, c3] = await Promise.all([
    db.one(`SELECT count(*)::int AS n FROM customers WHERE company_id = $1 AND cpf_cnpj = ANY($2)`, [companyId, [...docs]]),
    db.one(`SELECT count(*)::int AS n FROM suppliers WHERE company_id = $1 AND cnpj = ANY($2)`, [companyId, [...sups]]),
    db.one(`SELECT count(*)::int AS n FROM products WHERE company_id = $1 AND code = ANY($2)`, [companyId, [...codes]]),
  ])
  return { notes, problems: problems.slice(0, 200), summary: { ...s, clientes_novos: docs.size - c1.n, fornecedores_novos: sups.size - c2.n, produtos_novos: codes.size - c3.n, valor_vendas_centavos: Math.round(notes.filter((n) => n.kind === 'venda').reduce((a, n) => a + n.total, 0) * 100) } }
}

async function track(c: Q, batchId: string, entity: string, id: string) { await c.query(`INSERT INTO migration_items(batch_id, entity, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [batchId, entity, id]) }

export async function commitXml(c: Q, notes: Note[], o: { batchId: string; companyId: string; branchId: string; userId: string; onProgress?: (done: number, total: number) => void }): Promise<Record<string, number>> {
  const out: Record<string, number> = { clientes: 0, fornecedores: 0, produtos: 0, vendas: 0, custos_atualizados: 0, duplicadas: 0 }
  const branches = await c.many(`SELECT id, cnpj FROM branches WHERE company_id = $1`, [o.companyId])
  const branchOf = (cnpj: string) => branches.find((b: any) => b.cnpj && dig(b.cnpj) === cnpj)?.id ?? o.branchId
  // fornecedores
  const supByDoc = new Map<string, string>((await c.many(`SELECT id, cnpj FROM suppliers WHERE company_id = $1 AND cnpj IS NOT NULL`, [o.companyId])).map((r: any) => [r.cnpj, r.id]))
  for (const n of notes.filter((x) => x.kind === 'compra' && x.party)) {
    if (supByDoc.has(n.emitCnpj)) continue
    const p = n.party!
    const r = await c.one(`INSERT INTO suppliers(company_id, name, trade_name, cnpj, ie, email, phone, address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [o.companyId, p.name || `Fornecedor ${p.doc}`, p.tradeName ?? null, p.doc, p.ie ?? null, p.email ?? null, p.phone ?? null, JSON.stringify(p.address ?? {})])
    supByDoc.set(n.emitCnpj, r.id); await track(c, o.batchId, 'suppliers', r.id); out.fornecedores++
  }
  // clientes (só quem foi identificado na nota)
  const cusByDoc = new Map<string, string>((await c.many(`SELECT id, cpf_cnpj FROM customers WHERE company_id = $1 AND cpf_cnpj IS NOT NULL`, [o.companyId])).map((r: any) => [r.cpf_cnpj, r.id]))
  for (const n of notes.filter((x) => x.kind === 'venda' && x.party?.doc).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))) {
    const p = n.party!
    if (cusByDoc.has(p.doc) || !(p.doc.length === 11 || p.doc.length === 14)) continue
    const code = await nextNumber(c, o.companyId, 'cliente')
    const r = await c.one(`INSERT INTO customers(company_id, code, type, name, trade_name, cpf_cnpj, ie, email, phone, address, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [o.companyId, code, p.doc.length === 14 ? 'PJ' : 'PF', p.name || `Cliente ${p.doc}`, p.tradeName ?? null, p.doc, p.ie && p.ie !== 'ISENTO' ? p.ie : null, p.email ?? null, p.phone && p.phone.length >= 10 ? p.phone : null, JSON.stringify(p.address ?? {}), o.userId])
    cusByDoc.set(p.doc, r.id); await track(c, o.batchId, 'customers', r.id); out.clientes++
  }
  // catálogo: variantes existentes por código (produto de variação única), SKU ou código de barras
  const vars = await c.many(`SELECT v.id, v.sku, v.barcode, p.code, (SELECT count(*)::int FROM product_variants v2 WHERE v2.product_id = p.id) AS nvar FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.company_id = $1`, [o.companyId])
  const byCode = new Map<string, string>(), byEan = new Map<string, string>()
  for (const v of vars) { if (v.barcode) byEan.set(v.barcode, v.id); if (v.nvar === 1) byCode.set(norm(v.code), v.id); byCode.set(norm(v.sku), byCode.get(norm(v.sku)) ?? v.id) }
  const lastPrice = new Map<string, Note['items'][0]>()
  for (const n of notes.filter((x) => x.kind === 'venda').sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))) for (const i of n.items) lastPrice.set(i.code, i)
  for (const [code, i] of lastPrice) {
    if (byCode.has(norm(code)) || (i.ean && byEan.has(i.ean))) continue
    const taken = await c.one(`SELECT 1 FROM products WHERE company_id = $1 AND code = $2`, [o.companyId, code])
    const p = await c.one(`INSERT INTO products(company_id, created_by, code, name, unit, ncm, cest, sale_price, sale_by_weight) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code`,
      [o.companyId, o.userId, taken ? `${code}-NFE`.slice(0, 40) : code, i.name || code, i.unit, i.ncm.length === 8 ? i.ncm : null, i.cest.length === 7 ? i.cest : null, Math.round(i.unitPrice * 100) / 100, /^(KG|G|L|ML)$/.test(i.unit)])
    const ean = i.ean && !byEan.has(i.ean) ? i.ean : null
    const [v] = await createVariants(c, o.companyId, p, [{ size_id: null, color_id: null, barcode: ean }])
    byCode.set(norm(code), v.id); if (ean) byEan.set(ean, v.id)
    await track(c, o.batchId, 'products', p.id); out.produtos++
  }
  // custo: último custo de compra de itens com o mesmo código de barras (só onde o custo está vazio)
  const lastCost = new Map<string, number>()
  for (const n of notes.filter((x) => x.kind === 'compra').sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))) for (const i of n.items) if (i.ean && byEan.has(i.ean) && i.qty > 0) lastCost.set(byEan.get(i.ean)!, Math.round(((i.total - i.discount) / i.qty) * 100) / 100)
  for (const [vid, cost] of lastCost) { const r = await c.query(`UPDATE product_variants SET cost_price = $2 WHERE id = $1 AND cost_price IS NULL`, [vid, cost]); out.custos_atualizados += (r as any).rowCount ?? 0 }
  // histórico de vendas: sem estoque, sem financeiro, sem caixa
  const sales = notes.filter((x) => x.kind === 'venda').sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
  let done = 0
  for (const n of sales) {
    if (await c.one(`SELECT 1 FROM sales WHERE company_id = $1 AND external_id = $2`, [o.companyId, 'nfe:' + n.key])) { out.duplicadas++; continue }
    const items = n.items.map((i) => ({ ...i, variant: byCode.get(norm(i.code)) ?? (i.ean ? byEan.get(i.ean) : undefined) })).filter((i) => i.variant)
    if (!items.length) continue
    const subtotal = Math.round(items.reduce((a, i) => a + i.total, 0) * 100) / 100
    const disc = Math.round(items.reduce((a, i) => a + i.discount, 0) * 100) / 100
    const number = await nextNumber(c, o.companyId, 'venda')
    const s = await c.one(`INSERT INTO sales(company_id, branch_id, number, type, status, channel, customer_id, subtotal, discount_total, total, items_count, notes, origin_type, origin_id, external_id, created_by, created_at)
                           VALUES ($1,$2,$3,'venda','concluida','loja',$4,$5,$6,$7,$8,$9,'migracao',$10,$11,$12,$13) RETURNING id`,
      [o.companyId, branchOf(n.emitCnpj), number, n.party?.doc ? cusByDoc.get(n.party.doc) ?? null : null, subtotal, disc, Math.round((subtotal - disc) * 100) / 100, items.length,
        `Histórico importado: NF-e ${n.number}/${n.series}`, o.batchId, 'nfe:' + n.key, o.userId, n.issuedAt])
    let line = 0
    for (const i of items) await c.query(`INSERT INTO sale_items(sale_id, company_id, line, variant_id, qty, unit_price, discount, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.id, o.companyId, ++line, i.variant, i.qty, i.unitPrice, i.discount, Math.round((i.total - i.discount) * 100) / 100])
    out.vendas++
    if (++done % 100 === 0) o.onProgress?.(done, sales.length)
  }
  return out
}
