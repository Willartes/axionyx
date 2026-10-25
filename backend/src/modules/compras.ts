import { router, audit, paged, Where, branchScope, r2, today, addDays } from '../core/http'
import { db, tx, nextNumber, Q } from '../core/db'
import { v, parse, onlyDigits, isValidCNPJ, isValidGTIN, gtinCheckDigit } from '../core/validate'
import { notFound, unprocessable, conflict, badRequest } from '../core/errors'
import { parseXml, find, children, child, text, XNode } from '../core/xml'
import { moveStock } from '../services/stock'
import { systemCategory, defaultAccount } from '../services/finance'

interface ParsedNfe {
  key: string; number: string; series: string; issueDate: string; protocol: string | null; cStat: string | null
  supplier: { cnpj: string; name: string; tradeName: string; ie: string; address: any }
  destCnpj: string
  items: { line: number; code: string; ean: string | null; description: string; ncm: string; cfop: string; unit: string; qty: number; unitCost: number; total: number; discount: number; freight: number }[]
  totals: { products: number; freight: number; discount: number; other: number; total: number }
  installments: { number: string; due: string; amount: number }[]
}

export function parseNfe(xml: string): ParsedNfe {
  let root: XNode
  try { root = parseXml(xml) } catch (e: any) { throw unprocessable(`Arquivo XML inválido: ${e.message}`) }
  const inf = find(root, 'infNFe')
  if (!inf) throw unprocessable('O arquivo não é uma NF-e (infNFe não encontrado).')
  const key = (inf.attrs.Id || '').replace(/^NFe/, '')
  if (!/^\d{44}$/.test(key)) throw unprocessable('Chave de acesso da NF-e inválida.')
  const ide = child(inf, 'ide'), emit = child(inf, 'emit'), dest = child(inf, 'dest'), tot = find(inf, 'ICMSTot')
  const prot = find(root, 'infProt')
  const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0 }
  const items = children(inf, 'det').map((d) => {
    const p = child(d, 'prod')
    const ean = text(p, 'cEAN')
    const qty = num(text(p, 'qCom'))
    return {
      line: parseInt(d.attrs.nItem || '0', 10), code: text(p, 'cProd'), ean: ean && ean !== 'SEM GTIN' ? ean : null, description: text(p, 'xProd'),
      ncm: text(p, 'NCM'), cfop: text(p, 'CFOP'), unit: text(p, 'uCom'), qty, unitCost: num(text(p, 'vUnCom')), total: num(text(p, 'vProd')),
      discount: num(text(p, 'vDesc')), freight: num(text(p, 'vFrete')),
    }
  })
  const ender = child(emit, 'enderEmit')
  return {
    key, number: text(ide, 'nNF'), series: text(ide, 'serie'), issueDate: (text(ide, 'dhEmi') || text(ide, 'dEmi')).slice(0, 10),
    protocol: prot ? text(prot, 'nProt') : null, cStat: prot ? text(prot, 'cStat') : null,
    supplier: { cnpj: onlyDigits(text(emit, 'CNPJ')), name: text(emit, 'xNome'), tradeName: text(emit, 'xFant'), ie: text(emit, 'IE'),
      address: ender ? { logradouro: text(ender, 'xLgr'), numero: text(ender, 'nro'), bairro: text(ender, 'xBairro'), cidade: text(ender, 'xMun'), uf: text(ender, 'UF'), cep: text(ender, 'CEP'), codigoMunicipio: text(ender, 'cMun') } : {} },
    destCnpj: onlyDigits(text(dest, 'CNPJ')),
    items,
    totals: { products: num(text(tot, 'vProd')), freight: num(text(tot, 'vFrete')), discount: num(text(tot, 'vDesc')), other: num(text(tot, 'vOutro')), total: num(text(tot, 'vNF')) },
    installments: children(find(inf, 'cobr'), 'dup').map((d) => ({ number: text(d, 'nDup'), due: text(d, 'dVenc'), amount: num(text(d, 'vDup')) })),
  }
}

/** Sugere tamanho/cor a partir da descrição, com base nos cadastros da empresa. */
function suggestSizeColor(desc: string, sizes: string[], colors: string[]) {
  const tokens = desc.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[\s\-\/_.,;]+/).filter(Boolean)
  const size = [...tokens].reverse().find((t) => sizes.includes(t)) ?? null
  const plain = (s: string) => s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const color = colors.find((c) => tokens.join(' ').includes(plain(c))) ?? null
  return { size, color }
}

router.get('/api/purchase-entries', { perm: 'compras.ver' }, async (ctx) => {
  const branches = branchScope(ctx, ctx.query.branch)
  const w = new Where([['e.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('e.branch_id = ANY(?::uuid[])', branches)
  w.addIf(ctx.query.status, 'e.status = ?', ctx.query.status)
  if (ctx.query.q) w.add('(s.name ILIKE ? OR e.nfe_number = ? OR e.nfe_key = ?)', `%${ctx.query.q}%`, ctx.query.q, ctx.query.q)
  return paged(db, `SELECT e.id, e.number, e.source, e.nfe_number, e.nfe_series, e.nfe_key, e.issue_date, e.total, e.status, e.created_at, e.confirmed_at, s.name AS supplier, b.name AS branch,
                           (SELECT count(*)::int FROM purchase_entry_items i WHERE i.entry_id = e.id) AS items,
                           (SELECT count(*)::int FROM purchase_entry_items i WHERE i.entry_id = e.id AND i.match_status = 'pendente') AS pending
                      FROM purchase_entries e LEFT JOIN suppliers s ON s.id = e.supplier_id JOIN branches b ON b.id = e.branch_id ${w.sql} ORDER BY e.created_at DESC`, w.params, ctx.query)
})

router.get('/api/purchase-entries/:id', { perm: 'compras.ver' }, async (ctx) => {
  const e = await db.one(`SELECT e.*, s.name AS supplier, s.cnpj AS supplier_cnpj FROM purchase_entries e LEFT JOIN suppliers s ON s.id = e.supplier_id WHERE e.id = $1 AND e.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!e) throw notFound('Entrada')
  delete e.xml
  e.items = await db.many(`SELECT i.*, v.sku, p.name AS product_name, p.id AS product_id, sz.code AS size, co.name AS color FROM purchase_entry_items i
                             LEFT JOIN product_variants v ON v.id = i.variant_id LEFT JOIN products p ON p.id = v.product_id LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
                            WHERE i.entry_id = $1 ORDER BY i.line`, [e.id])
  return e
})

/** Importa XML de NF-e de compra: valida, identifica fornecedor e sugere vínculos — nada entra no estoque até a confirmação. */
router.post('/api/purchase-entries/import-xml', { perm: 'compras.editar', maxBody: 5_000_000 }, async (ctx) => {
  const xml = (ctx.body?.xml ? String(ctx.body.xml) : ctx.rawBody.toString('utf8')).replace(/^\uFEFF/, '').trim()
  if (!xml.startsWith('<')) throw badRequest('Envie o conteúdo do arquivo XML.')
  const nf = parseNfe(xml)
  return tx(async (c) => {
    const warnings: string[] = []
    const company = await c.one(`SELECT cnpj FROM companies WHERE id = $1`, [ctx.user.companyId])
    const branch = await c.one(`SELECT cnpj FROM branches WHERE id = $1`, [ctx.user.branchId])
    const ours = [onlyDigits(company?.cnpj), onlyDigits(branch?.cnpj)].filter(Boolean)
    if (ours.length && nf.destCnpj && !ours.includes(nf.destCnpj)) warnings.push(`O destinatário da nota (CNPJ ${nf.destCnpj}) não corresponde a esta empresa/filial.`)
    if (nf.cStat && nf.cStat !== '100') warnings.push(`Situação da autorização no XML: cStat ${nf.cStat} (100 = autorizada). Verifique a nota na SEFAZ antes de confirmar.`)
    if (!nf.protocol) warnings.push('XML sem protocolo de autorização (pode ser apenas a NF-e assinada, sem nfeProc).')
    if (!isValidCNPJ(nf.supplier.cnpj)) warnings.push('CNPJ do emitente inválido.')
    const sumItems = r2(nf.items.reduce((s, i) => s + i.total, 0))
    if (Math.abs(sumItems - nf.totals.products) > 0.05) warnings.push(`Soma dos itens (${sumItems.toFixed(2)}) difere do total de produtos (${nf.totals.products.toFixed(2)}).`)
    const dup = await c.one(`SELECT number FROM purchase_entries WHERE company_id = $1 AND nfe_key = $2 AND status <> 'cancelada'`, [ctx.user.companyId, nf.key])
    if (dup) throw conflict(`Esta NF-e já foi importada (entrada nº ${dup.number}).`)
    let supplier = await c.one(`SELECT id FROM suppliers WHERE company_id = $1 AND cnpj = $2`, [ctx.user.companyId, nf.supplier.cnpj])
    if (!supplier) {
      supplier = await c.one(`INSERT INTO suppliers(company_id, name, trade_name, cnpj, ie, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.user.companyId, nf.supplier.name, nf.supplier.tradeName || null, nf.supplier.cnpj, nf.supplier.ie || null, JSON.stringify(nf.supplier.address)])
      warnings.push(`Fornecedor ${nf.supplier.name} cadastrado automaticamente.`)
    }
    const number = await nextNumber(c, ctx.user.companyId, 'entrada')
    const entry = await c.one(
      `INSERT INTO purchase_entries(company_id, branch_id, number, supplier_id, supplier_data, source, nfe_key, nfe_number, nfe_series, issue_date, total_products, total_freight, total_discount, total_other, total, installments, xml, warnings, created_by)
       VALUES ($1,$2,$3,$4,$5,'xml',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id, number`,
      [ctx.user.companyId, ctx.user.branchId, number, supplier.id, JSON.stringify(nf.supplier), nf.key, nf.number, nf.series, nf.issueDate || today(), nf.totals.products, nf.totals.freight,
        nf.totals.discount, nf.totals.other, nf.totals.total, JSON.stringify(nf.installments), xml, JSON.stringify(warnings), ctx.user.id])
    const sizes = (await c.many(`SELECT DISTINCT upper(code) AS code FROM sizes WHERE company_id = $1`, [ctx.user.companyId])).map((r) => r.code)
    const colors = (await c.many(`SELECT name FROM colors WHERE company_id = $1`, [ctx.user.companyId])).map((r) => r.name)
    let matched = 0
    for (const it of nf.items) {
      const fracUnit = /^(KG|KGS|L|LT|M|M2|M3)$/i.test(String(it.unit || '').trim())
      if (!(it.qty > 0) || (!fracUnit && !Number.isInteger(it.qty))) throw unprocessable(`Item ${it.line} (${it.code}) com quantidade fracionada ou inválida (${it.qty} ${it.unit || ''}). Ajuste a unidade antes de importar.`)
      let variantId: string | null = null
      const learned = await c.one(`SELECT variant_id FROM supplier_product_codes WHERE supplier_id = $1 AND supplier_code = $2`, [supplier.id, it.code])
      if (learned) variantId = learned.variant_id
      if (!variantId && it.ean) { const byEan = await c.one(`SELECT id FROM product_variants WHERE company_id = $1 AND barcode = $2`, [ctx.user.companyId, it.ean]); variantId = byEan?.id ?? null }
      const sug = suggestSizeColor(it.description, sizes, colors)
      if (variantId) matched++
      await c.query(
        `INSERT INTO purchase_entry_items(entry_id, line, variant_id, supplier_code, ean, description, ncm, cfop, unit, qty, unit_cost, total, suggested_size, suggested_color, match_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [entry.id, it.line, variantId, it.code, it.ean, it.description, it.ncm, it.cfop, it.unit, it.qty, it.unitCost, it.total, sug.size, sug.color, variantId ? 'vinculado' : 'pendente'])
    }
    await audit(c, ctx, 'compra.xml_importado', 'purchase_entry', entry.id, { key: nf.key, number: nf.number, items: nf.items.length, matched })
    return { id: entry.id, number: entry.number, items: nf.items.length, matched, pending: nf.items.length - matched, warnings }
  })
})

router.put('/api/purchase-entries/:id/items/:itemId', { perm: 'compras.editar' }, async (ctx) => {
  const b = parse(v.object({ variantId: v.uuid().nullable(), ignore: v.boolean().optional() }), ctx.body)
  return tx(async (c) => {
    const e = await c.one(`SELECT status FROM purchase_entries WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!e) throw notFound('Entrada')
    if (e.status !== 'rascunho') throw conflict('Entrada já confirmada.')
    if (b.variantId) {
      const vv = await c.one(`SELECT 1 FROM product_variants WHERE id = $1 AND company_id = $2`, [b.variantId, ctx.user.companyId])
      if (!vv) throw unprocessable('Variação inválida.')
    }
    return c.one(`UPDATE purchase_entry_items SET variant_id = $3, match_status = $4 WHERE id = $2 AND entry_id = $1 RETURNING *`,
      [ctx.params.id, ctx.params.itemId, b.ignore ? null : b.variantId ?? null, b.ignore ? 'ignorado' : b.variantId ? 'vinculado' : 'pendente'])
  })
})

/** Cria produtos com grade a partir de itens da nota (agrupando cores/tamanhos do mesmo modelo). */
router.post('/api/purchase-entries/:id/create-products', { perm: ['compras.editar'] }, async (ctx) => {
  const b = parse(v.object({ groups: v.array(v.object({
    code: v.string({ min: 1, max: 40 }), name: v.string({ min: 2, max: 150 }), salePrice: v.money({ min: 0.01 }),
    brandId: v.uuid().optional(), categoryId: v.uuid().optional(), collectionId: v.uuid().optional(),
    items: v.array(v.object({ itemId: v.uuid(), sizeId: v.uuid().nullable(), colorId: v.uuid().nullable() }), { min: 1 }),
  }), { min: 1 }) }), ctx.body)
  return tx(async (c) => {
    const e = await c.one(`SELECT * FROM purchase_entries WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!e) throw notFound('Entrada')
    if (e.status !== 'rascunho') throw conflict('Entrada já confirmada.')
    const created: any[] = []
    for (const g of b.groups) {
      const items = await c.many(`SELECT * FROM purchase_entry_items WHERE entry_id = $1 AND id = ANY($2::uuid[])`, [e.id, g.items.map((i) => i.itemId)])
      if (items.length !== g.items.length) throw unprocessable('Item inválido no agrupamento.')
      const first = items[0]
      const cost = r2(items.reduce((s, i) => s + Number(i.total), 0) / items.reduce((s, i) => s + i.qty, 0))
      const p = await c.one(
        `INSERT INTO products(company_id, code, name, brand_id, category_id, collection_id, supplier_id, supplier_ref, ncm, cost_price, sale_price, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, code`,
        [ctx.user.companyId, g.code, g.name, g.brandId ?? null, g.categoryId ?? null, g.collectionId ?? null, e.supplier_id, first.supplier_code, /^\d{8}$/.test(first.ncm || '') ? first.ncm : null, cost, g.salePrice, ctx.user.id])
      for (const gi of g.items) {
        const it = items.find((x) => x.id === gi.itemId)!
        const size = gi.sizeId ? await c.one(`SELECT code FROM sizes WHERE id = $1 AND company_id = $2`, [gi.sizeId, ctx.user.companyId]) : null
        const color = gi.colorId ? await c.one(`SELECT name, code FROM colors WHERE id = $1 AND company_id = $2`, [gi.colorId, ctx.user.companyId]) : null
        let variant = await c.one(`SELECT id FROM product_variants WHERE product_id = $1 AND size_id IS NOT DISTINCT FROM $2 AND color_id IS NOT DISTINCT FROM $3`, [p.id, gi.sizeId, gi.colorId])
        if (!variant) {
          const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
          const sku = [slug(p.code), color ? slug(color.code || color.name).slice(0, 4) : null, size ? slug(size.code) : null].filter(Boolean).join('-')
          let barcode: string | null = it.ean && isValidGTIN(it.ean) ? it.ean : null
          if (barcode && (await c.one(`SELECT 1 FROM product_variants WHERE company_id = $1 AND barcode = $2`, [ctx.user.companyId, barcode]))) barcode = null
          if (!barcode) {
            const n = await nextNumber(c, ctx.user.companyId, 'ean_interno')
            const body = '2' + String(n).padStart(11, '0'); barcode = body + gtinCheckDigit(body)
          }
          variant = await c.one(`INSERT INTO product_variants(company_id, product_id, size_id, color_id, sku, barcode) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [ctx.user.companyId, p.id, gi.sizeId, gi.colorId, sku, barcode])
        }
        await c.query(`UPDATE purchase_entry_items SET variant_id = $2, match_status = 'novo' WHERE id = $1`, [it.id, variant!.id])
      }
      created.push(p)
    }
    await audit(c, ctx, 'compra.produtos_criados', 'purchase_entry', e.id, { products: created.map((p) => p.code) })
    return { created }
  })
})

/** Entrada manual (sem XML). */
router.post('/api/purchase-entries', { perm: 'compras.editar' }, async (ctx) => {
  const b = parse(v.object({
    supplierId: v.uuid(), document: v.string({ max: 20 }).optional(), issueDate: v.date().optional(), freight: v.money({ min: 0 }).optional(), discount: v.money({ min: 0 }).optional(),
    installments: v.array(v.object({ due: v.date(), amount: v.money({ min: 0.01 }) })).optional(),
    items: v.array(v.object({ variantId: v.uuid(), qty: v.number({ min: 0.001, max: 1000000 }), unitCost: v.money({ min: 0 }) }), { min: 1 }),
  }), ctx.body)
  return tx(async (c) => {
    const sup = await c.one(`SELECT id FROM suppliers WHERE id = $1 AND company_id = $2`, [b.supplierId, ctx.user.companyId])
    if (!sup) throw unprocessable('Fornecedor inválido.')
    const number = await nextNumber(c, ctx.user.companyId, 'entrada')
    const products = r2(b.items.reduce((s, i) => s + i.qty * i.unitCost, 0))
    const total = r2(products + (b.freight ?? 0) - (b.discount ?? 0))
    const e = await c.one(
      `INSERT INTO purchase_entries(company_id, branch_id, number, supplier_id, source, nfe_number, issue_date, total_products, total_freight, total_discount, total, installments, created_by)
       VALUES ($1,$2,$3,$4,'manual',$5,COALESCE($6::date,current_date),$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ctx.user.companyId, ctx.user.branchId, number, b.supplierId, b.document ?? null, b.issueDate ?? null, products, b.freight ?? 0, b.discount ?? 0, total,
        JSON.stringify((b.installments ?? []).map((x, i) => ({ number: String(i + 1), due: x.due, amount: x.amount }))), ctx.user.id])
    let line = 0
    for (const it of b.items) {
      const vv = await c.one(`SELECT v.id, p.name, sz.code AS size, co.name AS color FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id WHERE v.id = $1 AND v.company_id = $2`, [it.variantId, ctx.user.companyId])
      if (!vv) throw unprocessable('Variação inválida.')
      await c.query(`INSERT INTO purchase_entry_items(entry_id, line, variant_id, description, qty, unit_cost, total, match_status) VALUES ($1,$2,$3,$4,$5,$6,$7,'vinculado')`,
        [e.id, ++line, it.variantId, [vv.name, vv.color, vv.size].filter(Boolean).join(' '), it.qty, it.unitCost, r2(it.qty * it.unitCost)])
    }
    await audit(c, ctx, 'compra.entrada_manual', 'purchase_entry', e.id, { number, total })
    return e
  })
})

/** Confirma a entrada: estoque, custo médio/último custo, contas a pagar e aprendizado dos códigos do fornecedor. */
router.post('/api/purchase-entries/:id/confirm', { perm: 'compras.editar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ updateCost: v.boolean().default(true), firstDue: v.date().optional() }), ctx.body)
  return tx(async (c) => {
    const e = await c.one(`SELECT * FROM purchase_entries WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!e) throw notFound('Entrada')
    if (e.status !== 'rascunho') throw conflict('Entrada já confirmada ou cancelada.')
    const items = await c.many(`SELECT * FROM purchase_entry_items WHERE entry_id = $1 ORDER BY line`, [e.id])
    const pending = items.filter((i) => i.match_status === 'pendente')
    if (pending.length) throw unprocessable(`${pending.length} item(ns) sem vínculo com produto. Vincule, crie o produto ou marque como ignorado.`, pending.map((p) => ({ line: p.line, description: p.description })))
    const valid = items.filter((i) => i.variant_id)
    const base = valid.reduce((s, i) => s + Number(i.total), 0) || 1
    const extra = Number(e.total_freight) + Number(e.total_other) - Number(e.total_discount)
    for (const it of valid) {
      const share = extra * (Number(it.total) / base)
      const unitCost = r2((Number(it.total) + share) / it.qty)
      await moveStock(c, { companyId: e.company_id, branchId: e.branch_id, variantId: it.variant_id, qty: it.qty, type: 'compra', refType: 'purchase_entry', refId: e.id, unitCost, userId: ctx.user.id, notes: `Entrada nº ${e.number}${e.nfe_number ? ` · NF ${e.nfe_number}` : ''}` })
      if (b.updateCost) {
        await c.query(`UPDATE product_variants SET cost_price = $2 WHERE id = $1`, [it.variant_id, unitCost])
        await c.query(`UPDATE products SET cost_price = $2, updated_at = now() WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [it.variant_id, unitCost])
      }
      if (e.supplier_id && it.supplier_code) await c.query(`INSERT INTO supplier_product_codes(company_id, supplier_id, supplier_code, variant_id) VALUES ($1,$2,$3,$4) ON CONFLICT (supplier_id, supplier_code) DO UPDATE SET variant_id = EXCLUDED.variant_id`,
        [e.company_id, e.supplier_id, it.supplier_code, it.variant_id])
    }
    // contas a pagar (duplicatas da nota ou vencimento único)
    let inst: { number: string; due: string; amount: number }[] = Array.isArray(e.installments) ? e.installments : []
    if (!inst.length && Number(e.total) > 0) inst = [{ number: '1', due: b.firstDue || addDays(today(), 30), amount: Number(e.total) }]
    const cat = await systemCategory(c, e.company_id, 'compra_mercadoria')
    const acc = await defaultAccount(c, e.company_id, null, 'banco')
    let n = 0
    for (const d of inst) {
      n++
      await c.query(
        `INSERT INTO payables(company_id, branch_id, supplier_id, source_type, source_id, document, installment_no, installments_total, category_id, account_id, issue_date, due_date, amount, description, created_by)
         VALUES ($1,$2,$3,'purchase_entry',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
        [e.company_id, e.branch_id, e.supplier_id, e.id, e.nfe_number ? `NF ${e.nfe_number}` : `ENT ${e.number}`, n, inst.length, cat, acc, e.issue_date || today(), d.due, d.amount, `Compra — entrada nº ${e.number}`, ctx.user.id])
    }
    await audit(c, ctx, 'compra.entrada_confirmada', 'purchase_entry', e.id, { number: e.number, items: valid.length, total: e.total })
    return c.one(`UPDATE purchase_entries SET status = 'confirmada', confirmed_at = now(), confirmed_by = $2 WHERE id = $1 RETURNING id, number, status`, [e.id, ctx.user.id])
  })
})

router.post('/api/purchase-entries/:id/cancel', { perm: 'compras.editar' }, async (ctx) => tx(async (c) => {
  const e = await c.one(`SELECT * FROM purchase_entries WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
  if (!e) throw notFound('Entrada')
  if (e.status === 'cancelada') throw conflict('Entrada já cancelada.')
  if (e.status === 'confirmada') {
    const paid = await c.one(`SELECT count(*)::int AS n FROM payables WHERE source_type = 'purchase_entry' AND source_id = $1 AND paid_amount > 0`, [e.id])
    if (paid.n) throw conflict('Há parcelas pagas desta compra. Estorne os pagamentos antes de cancelar.')
    const items = await c.many(`SELECT * FROM purchase_entry_items WHERE entry_id = $1 AND variant_id IS NOT NULL`, [e.id])
    for (const it of items) await moveStock(c, { companyId: e.company_id, branchId: e.branch_id, variantId: it.variant_id, qty: -it.qty, type: 'estorno_compra', refType: 'purchase_entry', refId: e.id, userId: ctx.user.id, notes: `Cancelamento da entrada nº ${e.number}` })
    await c.query(`UPDATE payables SET status = 'cancelado', updated_at = now() WHERE source_type = 'purchase_entry' AND source_id = $1 AND status IN ('aberto','parcial')`, [e.id])
  }
  await audit(c, ctx, 'compra.entrada_cancelada', 'purchase_entry', e.id, { number: e.number }, 'warning')
  return c.one(`UPDATE purchase_entries SET status = 'cancelada' WHERE id = $1 RETURNING id, status`, [e.id])
}))

router.get('/api/purchase-entries/:id/labels', { perm: 'compras.ver' }, async (ctx) => {
  return db.many(`SELECT v.id, v.sku, v.barcode, p.code, p.name, sz.code AS size, co.name AS color, b.name AS brand, COALESCE(v.sale_price, p.sale_price) AS price, i.qty
                    FROM purchase_entry_items i JOIN purchase_entries e ON e.id = i.entry_id JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
                    LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id LEFT JOIN brands b ON b.id = p.brand_id
                   WHERE e.id = $1 AND e.company_id = $2 ORDER BY i.line`, [ctx.params.id, ctx.user.companyId])
})

// ---------- Pedidos de compra ----------
router.get('/api/purchase-orders', { perm: 'compras.ver' }, async (ctx) => {
  const w = new Where([['o.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.status, 'o.status = ?', ctx.query.status)
  return paged(db, `SELECT o.*, s.name AS supplier, b.name AS branch, (SELECT count(*)::int FROM purchase_order_items i WHERE i.order_id = o.id) AS items
                      FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN branches b ON b.id = o.branch_id ${w.sql} ORDER BY o.created_at DESC`, w.params, ctx.query)
})
router.get('/api/purchase-orders/:id', { perm: 'compras.ver' }, async (ctx) => {
  const o = await db.one(`SELECT o.*, s.name AS supplier FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = $1 AND o.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!o) throw notFound('Pedido de compra')
  o.items = await db.many(`SELECT i.*, v.sku, p.name, sz.code AS size, co.name AS color FROM purchase_order_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
                            LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id WHERE i.order_id = $1`, [o.id])
  return o
})
router.post('/api/purchase-orders', { perm: 'compras.editar' }, async (ctx) => {
  const b = parse(v.object({ supplierId: v.uuid(), expectedDate: v.date().optional(), notes: v.string({ max: 1000 }).optional(),
    items: v.array(v.object({ variantId: v.uuid(), qty: v.number({ min: 0.001, max: 1000000 }), unitCost: v.money({ min: 0 }) }), { min: 1 }) }), ctx.body)
  return tx(async (c) => {
    const number = await nextNumber(c, ctx.user.companyId, 'pedido_compra')
    const total = r2(b.items.reduce((s, i) => s + i.qty * i.unitCost, 0))
    const o = await c.one(`INSERT INTO purchase_orders(company_id, branch_id, number, supplier_id, expected_date, total, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.user.companyId, ctx.user.branchId, number, b.supplierId, b.expectedDate ?? null, total, b.notes ?? null, ctx.user.id])
    for (const it of b.items) await c.query(`INSERT INTO purchase_order_items(order_id, variant_id, qty, unit_cost) VALUES ($1,$2,$3,$4)`, [o.id, it.variantId, it.qty, it.unitCost])
    await audit(c, ctx, 'pedido_compra.criado', 'purchase_order', o.id, { number, total })
    return o
  })
})
router.post('/api/purchase-orders/:id/status', { perm: 'compras.editar' }, async (ctx) => {
  const b = parse(v.object({ status: v.enum(['aprovado', 'enviado', 'recebido', 'cancelado'] as const) }), ctx.body)
  const r = await db.one(`UPDATE purchase_orders SET status = $3, approved_by = CASE WHEN $3 = 'aprovado' THEN $4 ELSE approved_by END WHERE id = $1 AND company_id = $2 AND status NOT IN ('recebido','cancelado') RETURNING *`,
    [ctx.params.id, ctx.user.companyId, b.status, ctx.user.id])
  if (!r) throw conflict('Pedido não pode ser alterado.')
  await audit(null, ctx, 'pedido_compra.status', 'purchase_order', r.id, { status: b.status })
  return r
})

router.get('/api/purchases/dashboard', { perm: 'compras.ver' }, async (ctx) => {
  const id = ctx.user.companyId
  return db.one(`SELECT
      (SELECT count(*)::int FROM purchase_orders WHERE company_id = $1 AND status IN ('rascunho','aprovado','enviado','parcial')) AS orders_open,
      (SELECT COALESCE(sum(total),0) FROM purchase_orders WHERE company_id = $1 AND status IN ('rascunho','aprovado','enviado','parcial')) AS orders_open_value,
      (SELECT count(*)::int FROM purchase_orders WHERE company_id = $1 AND status IN ('aprovado','enviado','parcial') AND expected_date < current_date) AS orders_late,
      (SELECT count(*)::int FROM purchase_entries WHERE company_id = $1 AND status = 'rascunho') AS entries_pending,
      (SELECT count(*)::int FROM purchase_entries WHERE company_id = $1 AND status = 'confirmada' AND confirmed_at >= date_trunc('month', now())) AS entries_month,
      (SELECT COALESCE(sum(total),0) FROM purchase_entries WHERE company_id = $1 AND status = 'confirmada' AND confirmed_at >= date_trunc('month', now())) AS entries_month_value,
      (SELECT count(*)::int FROM suppliers WHERE company_id = $1 AND active) AS suppliers,
      (SELECT count(*)::int FROM (
         SELECT si.variant_id FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.created_at > now() - interval '30 days'
          GROUP BY si.variant_id HAVING COALESCE((SELECT sum(qty) FROM stock_balances sb WHERE sb.variant_id = si.variant_id),0) < sum(si.qty - si.returned_qty) * 45.0 / 30) x) AS needs`, [id])
})

/** Comparativo de custo por fornecedor (últimos 12 meses) a partir das entradas confirmadas. */
router.get('/api/purchases/price-map', { perm: 'compras.ver' }, async (ctx) => {
  const rows = await db.many(`
    WITH c AS (
      SELECT p.id AS product_id, p.code, p.name, s.id AS supplier_id, s.name AS supplier, i.unit_cost, e.issue_date,
             row_number() OVER (PARTITION BY p.id, s.id ORDER BY e.issue_date DESC, e.created_at DESC) AS rn,
             count(*) OVER (PARTITION BY p.id, s.id) AS purchases,
             avg(e.issue_date - (SELECT max(issue_date) FROM purchase_entries pe WHERE pe.company_id = e.company_id AND pe.issue_date < e.issue_date AND pe.supplier_id = s.id)) OVER (PARTITION BY s.id) AS cadence
        FROM purchase_entry_items i JOIN purchase_entries e ON e.id = i.entry_id JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id JOIN suppliers s ON s.id = e.supplier_id
       WHERE e.company_id = $1 AND e.status = 'confirmada' AND e.issue_date > current_date - 365)
    SELECT product_id, code, name, supplier_id, supplier, round(unit_cost::numeric, 2) AS last_cost, issue_date AS last_date, purchases
      FROM c WHERE rn = 1 ORDER BY name, last_cost`, [ctx.user.companyId])
  const byProduct = new Map<string, any>()
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, { product_id: r.product_id, code: r.code, name: r.name, quotes: [] })
    byProduct.get(r.product_id).quotes.push({ supplier_id: r.supplier_id, supplier: r.supplier, last_cost: Number(r.last_cost), last_date: r.last_date, purchases: Number(r.purchases) })
  }
  const suppliers = [...new Map(rows.map((r) => [r.supplier_id, { id: r.supplier_id, name: r.supplier }])).values()]
  return { suppliers, products: [...byProduct.values()].map((p) => ({ ...p, best: p.quotes.reduce((a: any, b: any) => (b.last_cost < a.last_cost ? b : a)) })) }
})
