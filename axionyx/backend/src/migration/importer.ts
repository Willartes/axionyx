import { db, nextNumber, type Q } from '../core/db'
import { FIELDS, type Kind, money, qty, date, gtinOk, docOk, norm } from './fields'
import { createVariants } from '../modules/produtos'
import { moveStock } from '../services/stock'
import { createReceivable, systemCategory } from '../services/finance'

/**
 * Validação (prévia) e gravação das planilhas. Nada é gravado na prévia; a gravação acontece numa única transação
 * (se uma linha falhar, nada do lote entra) e registra o que foi criado, para o "desfazer".
 * Registros que já existem (mesmo CPF/CNPJ, mesmo código de produto) são mantidos como estão.
 */
export interface Item { line: number; data: Record<string, any>; errors: string[]; warnings: string[]; action: 'novo' | 'existente' | 'erro' }
export interface Preview { items: Item[]; summary: { total: number; novos: number; existentes: number; erros: number; avisos: number; extra?: Record<string, number> } }

const get = (row: string[], headers: string[], col: string | null | undefined) => { if (!col) return ''; const i = headers.indexOf(col); return i < 0 ? '' : String(row[i] ?? '').trim() }

export async function validate(kind: Kind, headers: string[], rows: string[][], mapping: Record<string, string | null>, companyId: string): Promise<Preview> {
  const fields = FIELDS[kind]
  const items: Item[] = rows.map((row, i) => {
    const data: Record<string, any> = {}, errors: string[] = [], warnings: string[] = []
    for (const f of fields) {
      const raw = get(row, headers, mapping[f.key])
      if (!raw) { if (f.required) errors.push(`${f.label} não informado`); continue }
      switch (f.type) {
        case 'valor': { const n = money(raw); if (Number.isNaN(n)) errors.push(`${f.label} inválido: "${raw}"`); else data[f.key] = n; break }
        case 'numero': { const n = qty(raw); if (Number.isNaN(n)) errors.push(`${f.label} inválido: "${raw}"`); else data[f.key] = n; break }
        case 'data': { const d = date(raw); if (d === 'invalida') errors.push(`${f.label} inválida: "${raw}"`); else data[f.key] = d; break }
        case 'doc': { const d = docOk(raw); if (!d.ok) errors.push(`${f.label} inválido: "${raw}"`); else if (d.digits) { data[f.key] = d.digits; data._tipo = d.type } break }
        case 'ean': { const d = raw.replace(/\D/g, ''); if (!d || /^sem/i.test(raw)) break; if (!gtinOk(d)) warnings.push(`Código de barras "${raw}" inválido: será gerado um interno`); else data[f.key] = d; break }
        case 'ncm': { const d = raw.replace(/\D/g, ''); if (d.length === 8) data[f.key] = d; else warnings.push(`NCM "${raw}" ignorado (precisa de 8 dígitos)`); break }
        case 'uf': { const u = raw.toUpperCase().slice(0, 2); if (/^[A-Z]{2}$/.test(u)) data[f.key] = u; break }
        case 'cep': { const d = raw.replace(/\D/g, ''); if (d.length === 8) data[f.key] = d; else warnings.push(`CEP "${raw}" ignorado`); break }
        case 'telefone': { const d = raw.replace(/\D/g, ''); if (d.length >= 10 && d.length <= 13) data[f.key] = d; else if (d) warnings.push(`${f.label} "${raw}" ignorado`); break }
        case 'email': { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) data[f.key] = raw.toLowerCase(); else warnings.push(`E-mail "${raw}" ignorado`); break }
        default: data[f.key] = raw.slice(0, 300)
      }
    }
    if (kind === 'produtos' && data.nome && data.nome.length < 2) errors.push('Descrição muito curta')
    if ((kind === 'receber' || kind === 'pagar') && data.valor !== undefined && data.valor <= 0) errors.push('Valor precisa ser maior que zero')
    if (kind === 'estoque' && data.quantidade !== undefined && data.quantidade < 0) errors.push('Quantidade negativa')
    return { line: i + 2, data, errors, warnings, action: errors.length ? 'erro' : 'novo' }
  })
  const extra: Record<string, number> = {}
  const ok = () => items.filter((x) => x.action !== 'erro')

  if (kind === 'clientes' || kind === 'fornecedores') {
    const key = kind === 'clientes' ? 'cpf_cnpj' : 'cnpj'
    const docs = ok().map((x) => x.data[key]).filter(Boolean)
    const existing = new Set((await db.many(kind === 'clientes' ? `SELECT cpf_cnpj AS d FROM customers WHERE company_id = $1 AND cpf_cnpj = ANY($2)` : `SELECT cnpj AS d FROM suppliers WHERE company_id = $1 AND cnpj = ANY($2)`, [companyId, docs])).map((r: any) => r.d))
    const seen = new Set<string>()
    for (const it of ok()) { const d = it.data[key]; if (!d) { it.warnings.push('Sem CPF/CNPJ: será cadastrado só pelo nome'); continue } if (existing.has(d)) it.action = 'existente'; else if (seen.has(d)) { it.errors.push('CPF/CNPJ repetido na planilha'); it.action = 'erro' } seen.add(d) }
  }
  if (kind === 'produtos') {
    const codes = [...new Set(ok().map((x) => String(x.data.codigo)))]
    const existing = new Set((await db.many(`SELECT code FROM products WHERE company_id = $1 AND code = ANY($2)`, [companyId, codes])).map((r: any) => r.code))
    const eans = ok().map((x) => x.data.ean).filter(Boolean)
    const usedEan = new Set((await db.many(`SELECT barcode FROM product_variants WHERE company_id = $1 AND barcode = ANY($2)`, [companyId, eans])).map((r: any) => r.barcode))
    const seen = new Set<string>(), seenEan = new Set<string>()
    for (const it of ok()) {
      const k = `${it.data.codigo}|${norm(it.data.cor ?? '')}|${norm(it.data.tamanho ?? '')}`
      if (existing.has(String(it.data.codigo))) { it.action = 'existente'; continue }
      if (seen.has(k)) { it.errors.push('Produto/variação repetido na planilha'); it.action = 'erro'; continue }
      if (it.data.ean && (usedEan.has(it.data.ean) || seenEan.has(it.data.ean))) { it.warnings.push(`Código de barras ${it.data.ean} já usado: será gerado um interno`); delete it.data.ean }
      seen.add(k); if (it.data.ean) seenEan.add(it.data.ean)
    }
    extra.produtos = new Set(ok().filter((x) => x.action === 'novo').map((x) => x.data.codigo)).size
  }
  if (kind === 'estoque') {
    const vars = await db.many(`SELECT v.id, v.sku, v.barcode, p.code, p.unit, p.sale_by_weight, (SELECT count(*)::int FROM product_variants v2 WHERE v2.product_id = p.id) AS nvar
                                  FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.company_id = $1`, [companyId])
    const by = new Map<string, any>()
    for (const v of vars) { by.set('b:' + v.barcode, v); by.set('s:' + norm(v.sku), v); if (v.nvar === 1) by.set('c:' + norm(v.code), v) }
    const branches = await db.many(`SELECT id, code FROM branches WHERE company_id = $1 AND active ORDER BY code`, [companyId])
    const seen = new Set<string>()
    for (const it of ok()) {
      const p = String(it.data.produto)
      const v = by.get('b:' + p.replace(/\D/g, '')) ?? by.get('s:' + norm(p)) ?? by.get('c:' + norm(p))
      if (!v) { it.errors.push(`Produto "${p}" não encontrado (importe os produtos antes, ou use o SKU da variação)`); it.action = 'erro'; continue }
      const fractional = v.sale_by_weight || /^(kg|g|l|ml|m)$/i.test(v.unit || '')
      if (!fractional && !Number.isInteger(it.data.quantidade)) { it.errors.push('Produto controlado por unidade: quantidade precisa ser inteira'); it.action = 'erro'; continue }
      const br = it.data.filial ? branches.find((b: any) => norm(b.code) === norm(String(it.data.filial))) : branches[0]
      if (!br) { it.errors.push(`Filial "${it.data.filial}" não encontrada`); it.action = 'erro'; continue }
      const key = v.id + '|' + br.id
      if (seen.has(key)) { it.errors.push('Mesmo produto e filial repetidos na planilha'); it.action = 'erro'; continue }
      seen.add(key); it.data._variant = v.id; it.data._sku = v.sku; it.data._branch = br.id
    }
  }
  if (kind === 'receber' || kind === 'pagar') {
    const people = kind === 'receber' ? await db.many(`SELECT id, name, cpf_cnpj AS doc FROM customers WHERE company_id = $1 AND active`, [companyId]) : await db.many(`SELECT id, name, cnpj AS doc FROM suppliers WHERE company_id = $1 AND active`, [companyId])
    const byDoc = new Map(people.filter((p: any) => p.doc).map((p: any) => [p.doc, p.id]))
    const byName = new Map<string, string[]>(); for (const p of people) byName.set(norm(p.name), [...(byName.get(norm(p.name)) ?? []), p.id])
    const who = kind === 'receber' ? 'cliente' : 'fornecedor'
    for (const it of ok()) {
      const raw = String(it.data[who] ?? '')
      if (!raw) continue
      const d = docOk(raw)
      const id = (d.digits && byDoc.get(d.digits)) || (byName.get(norm(raw))?.length === 1 ? byName.get(norm(raw))![0] : null)
      if (id) it.data._person = id
      else if (d.digits && d.ok && d.type) { it.data._newDoc = d.digits; it.warnings.push(`${who === 'cliente' ? 'Cliente' : 'Fornecedor'} ${raw} não cadastrado: será criado`) }
      else if (byName.get(norm(raw))?.length) { it.errors.push(`Mais de um ${who} com o nome "${raw}": use o CPF/CNPJ`); it.action = 'erro' }
      else it.warnings.push(`${who === 'cliente' ? 'Cliente' : 'Fornecedor'} "${raw}" não cadastrado: será criado`)
    }
    if (kind === 'receber') for (const it of ok()) if (!it.data.cliente) { it.errors.push('Cliente não informado'); it.action = 'erro' }
  }
  const summary = { total: items.length, novos: items.filter((x) => x.action === 'novo').length, existentes: items.filter((x) => x.action === 'existente').length, erros: items.filter((x) => x.action === 'erro').length, avisos: items.filter((x) => x.warnings.length).length, extra }
  return { items, summary }
}

// ---------- gravação ----------
async function track(c: Q, batchId: string, entity: string, id: string, seq = 0) { await c.query(`INSERT INTO migration_items(batch_id, entity, entity_id, seq) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [batchId, entity, id, seq]) }
const addr = (d: any) => { const a: Record<string, string> = {}; for (const k of ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf']) if (d[k]) a[k] = d[k]; return a }
async function findOrCreate(c: Q, table: 'brands' | 'categories' | 'colors', companyId: string, name: string, cache: Map<string, string>, batchId: string): Promise<string> {
  const k = table + ':' + norm(name)
  if (cache.has(k)) return cache.get(k)!
  let r = await c.one(`SELECT id FROM ${table} WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, name])
  if (!r) { r = await c.one(`INSERT INTO ${table}(company_id, name) VALUES ($1,$2) RETURNING id`, [companyId, name.slice(0, 80)]); await track(c, batchId, table, r.id) }
  cache.set(k, r.id); return r.id
}

export async function commit(c: Q, kind: Kind, items: Item[], o: { batchId: string; companyId: string; branchId: string; userId: string; onProgress?: (done: number, total: number) => void }): Promise<Record<string, number>> {
  const rows = items.filter((x) => x.action === 'novo')
  const out: Record<string, number> = {}
  const inc = (k: string, n = 1) => { out[k] = (out[k] ?? 0) + n }
  const cache = new Map<string, string>()
  let done = 0
  const tick = () => { if (++done % 50 === 0) o.onProgress?.(done, rows.length) }

  if (kind === 'clientes') for (const it of rows) {
    const d = it.data
    const code = await nextNumber(c, o.companyId, 'cliente')
    const r = await c.one(`INSERT INTO customers(company_id, code, type, name, trade_name, cpf_cnpj, ie, email, phone, whatsapp, birth_date, address, credit_limit, notes, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [o.companyId, code, d._tipo === 'PJ' ? 'PJ' : 'PF', d.nome, d.fantasia ?? null, d.cpf_cnpj ?? null, d.ie ?? null, d.email ?? null, d.telefone ?? null, d.whatsapp ?? null, d.nascimento ?? null, JSON.stringify(addr(d)), d.limite ?? 0, d.observacoes ?? null, o.userId])
    await track(c, o.batchId, 'customers', r.id); inc('clientes'); tick()
  }
  if (kind === 'fornecedores') for (const it of rows) {
    const d = it.data
    const r = await c.one(`INSERT INTO suppliers(company_id, name, trade_name, cnpj, ie, email, phone, address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [o.companyId, d.nome, d.fantasia ?? null, d.cnpj ?? null, d.ie ?? null, d.email ?? null, d.telefone ?? null, JSON.stringify(addr(d))])
    await track(c, o.batchId, 'suppliers', r.id); inc('fornecedores'); tick()
  }
  if (kind === 'produtos') {
    const groups = new Map<string, Item[]>()
    for (const it of rows) groups.set(String(it.data.codigo), [...(groups.get(String(it.data.codigo)) ?? []), it])
    for (const [code, list] of groups) {
      const d = list[0].data
      const p = await c.one(`INSERT INTO products(company_id, created_by, code, name, description, unit, ncm, cest, sale_price, cost_price, brand_id, category_id, min_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, code`,
        [o.companyId, o.userId, code.slice(0, 40), String(d.nome).slice(0, 150), d.descricao ?? null, (d.unidade ?? 'UN').slice(0, 6).toUpperCase(), d.ncm ?? null, /^\d{7}$/.test(d.cest ?? '') ? d.cest : null,
          d.preco ?? 0, d.custo ?? null, d.marca ? await findOrCreate(c, 'brands', o.companyId, d.marca, cache, o.batchId) : null,
          d.categoria ? await findOrCreate(c, 'categories', o.companyId, d.categoria, cache, o.batchId) : null, d.minimo ?? 0])
      const vlist = []
      for (const it of list) {
        const size = it.data.tamanho ? await (async () => {
          const k = 'size:' + norm(it.data.tamanho); if (cache.has(k)) return cache.get(k)!
          let s = await c.one(`SELECT id FROM sizes WHERE company_id = $1 AND lower(code) = lower($2) ORDER BY grid LIMIT 1`, [o.companyId, it.data.tamanho])
          if (!s) { s = await c.one(`INSERT INTO sizes(company_id, code, sort) VALUES ($1,$2,99) RETURNING id`, [o.companyId, String(it.data.tamanho).slice(0, 10)]); await track(c, o.batchId, 'sizes', s.id) }
          cache.set(k, s.id); return s.id as string })() : null
        const color = it.data.cor ? await findOrCreate(c, 'colors', o.companyId, it.data.cor, cache, o.batchId) : null
        vlist.push({ size_id: size, color_id: color, barcode: it.data.ean, sale_price: list.length > 1 && it.data.preco !== d.preco ? it.data.preco : null, cost_price: list.length > 1 && it.data.custo !== d.custo ? it.data.custo : null })
      }
      await createVariants(c, o.companyId, p, vlist)
      await track(c, o.batchId, 'products', p.id); inc('produtos'); inc('variacoes', vlist.length)
      for (let k = 0; k < list.length; k++) tick()
    }
  }
  if (kind === 'estoque') for (const it of rows) {
    const cur = await c.one(`SELECT COALESCE(qty,0)::float8 AS q FROM stock_balances WHERE branch_id = $1 AND variant_id = $2`, [it.data._branch, it.data._variant])
    const diff = Math.round((it.data.quantidade - Number(cur?.q ?? 0)) * 1000) / 1000
    if (diff !== 0) {
      await moveStock(c, { companyId: o.companyId, branchId: it.data._branch, variantId: it.data._variant, type: 'ajuste', qty: diff, unitCost: it.data.custo ?? undefined, refType: 'migracao', refId: o.batchId, notes: 'Saldo inicial (migração)', userId: o.userId, allowNegative: true } as any)
      inc('ajustes')
    } else inc('sem_alteracao')
    if (it.data.custo) await c.query(`UPDATE product_variants SET cost_price = $2 WHERE id = $1 AND cost_price IS NULL`, [it.data._variant, it.data.custo])
    tick()
  }
  if (kind === 'receber') {
    const cat = await systemCategory(c, o.companyId, 'venda')
    for (const it of rows) {
      const d = it.data
      let customer = d._person ?? null
      if (!customer) {
        const doc = d._newDoc ?? null
        const code = await nextNumber(c, o.companyId, 'cliente')
        customer = (await c.one(`INSERT INTO customers(company_id, code, type, name, cpf_cnpj, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [o.companyId, code, doc && doc.length === 14 ? 'PJ' : 'PF', doc ? `Cliente ${doc}` : String(d.cliente).slice(0, 150), doc, o.userId])).id
        await track(c, o.batchId, 'customers', customer); inc('clientes_criados')
      }
      const f = norm(d.forma ?? '')
      const method = /credi|carne/.test(f) ? 'crediario' : /boleto/.test(f) ? 'boleto' : /cart/.test(f) ? 'cartao_credito' : /prazo|duplicata|cheque/.test(f) ? 'a_prazo' : 'outro'
      const id = await createReceivable(c, { companyId: o.companyId, branchId: o.branchId, customerId: customer, sourceType: 'migracao', document: String(d.documento ?? `MIG-${it.line}`).slice(0, 40), methodKind: method,
        categoryId: cat, issueDate: d.emissao ?? undefined, dueDate: d.vencimento, amount: d.valor, description: d.descricao ?? 'Título importado na migração', userId: o.userId })
      await track(c, o.batchId, 'receivables', id); inc('titulos'); inc('valor_centavos', Math.round(d.valor * 100)); tick()
    }
  }
  if (kind === 'pagar') {
    const cats = await c.many(`SELECT id, name, system_key FROM financial_categories WHERE company_id = $1 AND type = 'despesa' AND active`, [o.companyId])
    const fallback = cats.find((x: any) => x.system_key === 'servicos')?.id ?? cats.find((x: any) => !['compra_mercadoria', 'devolucao', 'impostos', 'sangria'].includes(x.system_key))?.id ?? cats[0]?.id
    for (const it of rows) {
      const d = it.data
      let supplier = d._person ?? null
      if (!supplier && d.fornecedor) {
        const doc = d._newDoc ?? null
        supplier = (await c.one(`INSERT INTO suppliers(company_id, name, cnpj) VALUES ($1,$2,$3) RETURNING id`, [o.companyId, doc ? `Fornecedor ${doc}` : String(d.fornecedor).slice(0, 150), doc])).id
        await track(c, o.batchId, 'suppliers', supplier); inc('fornecedores_criados')
      }
      const cat = d.categoria ? cats.find((x: any) => norm(x.name) === norm(d.categoria))?.id ?? fallback : fallback
      const r = await c.one(`INSERT INTO payables(company_id, branch_id, supplier_id, source_type, document, installment_no, installments_total, category_id, due_date, amount, description, created_by)
                             VALUES ($1,$2,$3,'migracao',$4,1,1,$5,$6,$7,$8,$9) RETURNING id`,
        [o.companyId, o.branchId, supplier, String(d.documento).slice(0, 40), cat, d.vencimento, d.valor, d.descricao ?? 'Título importado na migração', o.userId])
      await track(c, o.batchId, 'payables', r.id); inc('titulos'); inc('valor_centavos', Math.round(d.valor * 100)); tick()
    }
  }
  return out
}

// ---------- desfazer ----------
/** Tenta apagar; se o registro já foi usado (ex.: produto vendido), mantém e conta. */
async function tryDelete(c: Q, sqls: [string, unknown[]][]): Promise<boolean> {
  await c.query('SAVEPOINT desfazer')
  try { for (const [s, p] of sqls) await c.query(s, p); await c.query('RELEASE SAVEPOINT desfazer'); return true }
  catch { await c.query('ROLLBACK TO SAVEPOINT desfazer'); return false }
}
export async function undo(c: Q, batch: { id: string; kind: string; company_id: string }, userId: string): Promise<{ removed: number; kept: number; details: Record<string, number> }> {
  const items = await c.many(`SELECT entity, entity_id FROM migration_items WHERE batch_id = $1`, [batch.id])
  let removed = 0, kept = 0
  const details: Record<string, number> = {}
  // estoque: movimento inverso de cada ajuste do lote
  const moves = await c.many(`SELECT branch_id, variant_id, qty FROM stock_movements WHERE company_id = $1 AND ref_type = 'migracao' AND ref_id = $2`, [batch.company_id, batch.id])
  for (const m of moves) { await moveStock(c, { companyId: batch.company_id, branchId: m.branch_id, variantId: m.variant_id, type: 'ajuste', qty: -Number(m.qty), refType: 'migracao_desfeita', refId: batch.id, notes: 'Desfazer migração', userId, allowNegative: true } as any); removed++ }
  if (moves.length) details.ajustes_revertidos = moves.length
  // histórico de vendas do XML
  const sales = await c.many(`SELECT id FROM sales WHERE company_id = $1 AND origin_type = 'migracao' AND origin_id = $2`, [batch.company_id, batch.id])
  for (const s of sales) { if (await tryDelete(c, [[`DELETE FROM sale_items WHERE sale_id = $1`, [s.id]], [`DELETE FROM sales WHERE id = $1`, [s.id]]])) removed++; else kept++ }
  if (sales.length) details.vendas_historicas = sales.length
  const order = ['receivables', 'payables', 'products', 'customers', 'suppliers', 'colors', 'sizes', 'categories', 'brands']
  for (const ent of order) {
    for (const it of items.filter((x: any) => x.entity === ent)) {
      const id = it.entity_id
      const sql: [string, unknown[]][] =
        ent === 'receivables' ? [[`DELETE FROM receivables WHERE id = $1 AND paid_amount = 0`, [id]]]
        : ent === 'payables' ? [[`DELETE FROM payables WHERE id = $1 AND paid_amount = 0`, [id]]]
        : ent === 'products' ? [[`DELETE FROM stock_balances WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1) AND qty = 0`, [id]], [`DELETE FROM product_variants WHERE product_id = $1`, [id]], [`DELETE FROM products WHERE id = $1`, [id]]]
        : [[`DELETE FROM ${ent} WHERE id = $1`, [id]]]
      const ok = await tryDelete(c, sql)
      if (ok) { const still = ent === 'receivables' || ent === 'payables' ? await c.one(`SELECT 1 FROM ${ent} WHERE id = $1`, [id]) : null; if (still) { kept++; continue } removed++; details[ent] = (details[ent] ?? 0) + 1 } else kept++
    }
  }
  return { removed, kept, details }
}
