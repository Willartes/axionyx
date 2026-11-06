import { router, audit, paged, Where, can, branchScope } from '../core/http'
import { db, tx, nextNumber, Q } from '../core/db'
import { v, parse, isValidGTIN, gtinCheckDigit, onlyDigits } from '../core/validate'
import { notFound, unprocessable, conflict } from '../core/errors'
import { findPackagingOrCombo, resolveScale } from '../services/retail'
import { getSettings } from '../services/settings'

const productSchema = {
  code: v.string({ min: 1, max: 40 }),
  name: v.string({ min: 2, max: 150 }),
  short_name: v.string({ max: 60 }).optional(),
  description: v.string({ max: 4000 }).optional(),
  brand_id: v.uuid().optional(), collection_id: v.uuid().optional(), category_id: v.uuid().optional(), supplier_id: v.uuid().optional(),
  supplier_ref: v.string({ max: 60 }).optional(),
  gender: v.enum(['Feminino', 'Masculino', 'Unissex', 'Infantil'] as const).optional(),
  unit: v.string({ max: 6 }).optional(),
  ncm: v.string({ pattern: /^\d{8}$/, patternMsg: 'NCM deve ter 8 dígitos.' }).optional(),
  cest: v.string({ pattern: /^\d{7}$/, patternMsg: 'CEST deve ter 7 dígitos.' }).optional(),
  origin: v.int({ min: 0, max: 8 }).optional(),
  cfop: v.string({ pattern: /^\d{4}$/, patternMsg: 'CFOP deve ter 4 dígitos.' }).optional(),
  cst_csosn: v.string({ pattern: /^\d{2,3}$/, patternMsg: 'CST/CSOSN inválido.' }).optional(),
  cost_price: v.money({ min: 0 }).optional(),
  sale_price: v.money({ min: 0 }).optional(),
  min_stock: v.int({ min: 0 }).optional(),
  track_stock: v.boolean().optional(),
  weight_kg: v.number({ min: 0 }).optional(),
  tags: v.array(v.string({ max: 30 })).optional(),
  active: v.boolean().optional(),
  sale_by_weight: v.boolean().optional(),
  plu_code: v.string({ pattern: /^\d{1,6}$/, patternMsg: 'O código de balança (PLU) tem até 6 dígitos.' }).nullable().optional(),
  shelf_life_days: v.int({ min: 0, max: 3650 }).nullable().optional(),
  age_restricted: v.boolean().optional(),
  track_lots: v.boolean().optional(),
  attributes: v.json().optional(),
}
const variantSchema = v.object({
  size_id: v.uuid().nullable(), color_id: v.uuid().nullable(),
  sku: v.string({ max: 60 }).optional(), barcode: v.string({ max: 14 }).optional(),
  sale_price: v.money({ min: 0 }).optional(), cost_price: v.money({ min: 0 }).optional(), min_stock: v.int({ min: 0 }).optional(),
})

/** EAN-13 interno (prefixo 2 = circulação restrita), único por empresa. */
async function internalEan(c: Q, companyId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const n = await nextNumber(c, companyId, 'ean_interno')
    const body = '2' + String(n).padStart(11, '0')
    const code = body + gtinCheckDigit(body)
    const used = await c.one(`SELECT 1 FROM product_variants WHERE company_id = $1 AND barcode = $2`, [companyId, code])
    if (!used) return code
  }
  throw conflict('Não foi possível gerar código de barras único.')
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()

export async function createVariants(c: Q, companyId: string, product: { id: string; code: string }, list: any[]) {
  const created: any[] = []
  for (const it of list) {
    const size = it.size_id ? await c.one(`SELECT code FROM sizes WHERE id = $1 AND company_id = $2`, [it.size_id, companyId]) : null
    const color = it.color_id ? await c.one(`SELECT name, code FROM colors WHERE id = $1 AND company_id = $2`, [it.color_id, companyId]) : null
    if (it.size_id && !size) throw unprocessable('Tamanho inválido.')
    if (it.color_id && !color) throw unprocessable('Cor inválida.')
    const sku = it.sku || [slug(product.code), color ? slug(color.code || color.name).slice(0, 4) : null, size ? slug(size.code) : null].filter(Boolean).join('-')
    let barcode = it.barcode ? onlyDigits(it.barcode) : null
    if (barcode && !isValidGTIN(barcode)) throw unprocessable(`Código de barras inválido para ${sku} (dígito verificador).`)
    if (!barcode) barcode = await internalEan(c, companyId)
    const exists = await c.one(`SELECT id FROM product_variants WHERE product_id = $1 AND size_id IS NOT DISTINCT FROM $2 AND color_id IS NOT DISTINCT FROM $3`, [product.id, it.size_id ?? null, it.color_id ?? null])
    if (exists) continue
    created.push(await c.one(
      `INSERT INTO product_variants(company_id, product_id, size_id, color_id, sku, barcode, sale_price, cost_price, min_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, product.id, it.size_id ?? null, it.color_id ?? null, sku, barcode, it.sale_price ?? null, it.cost_price ?? null, it.min_stock ?? null]))
  }
  return created
}

function gridToList(grid?: { sizeIds?: string[]; colorIds?: string[] }) {
  if (!grid) return []
  const sizes = grid.sizeIds?.length ? grid.sizeIds : [null]
  const colors = grid.colorIds?.length ? grid.colorIds : [null]
  const out: any[] = []
  for (const color_id of colors) for (const size_id of sizes) out.push({ size_id, color_id })
  return out
}

router.get('/api/products', { perm: 'produtos.ver' }, async (ctx) => {
  const q = ctx.query
  const branches = branchScope(ctx, q.branch)
  const w = new Where([['p.company_id = ?', ctx.user.companyId]])
  if (q.q) w.add(`(p.name ILIKE ? OR p.code ILIKE ? OR p.supplier_ref ILIKE ? OR EXISTS (SELECT 1 FROM product_variants x WHERE x.product_id = p.id AND (x.sku ILIKE ? OR x.barcode = ?)))`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`, q.q)
  if (q.kind !== 'all') w.add('p.kind = ?', ['servico', 'pacote'].includes(q.kind) ? q.kind : 'produto')
  w.addIf(q.brand, 'p.brand_id = ?', q.brand).addIf(q.collection, 'p.collection_id = ?', q.collection).addIf(q.category, 'p.category_id = ?', q.category).addIf(q.supplier, 'p.supplier_id = ?', q.supplier)
  if (q.active) w.add('p.active = ?', q.active === 'true')
  const bp = w.p(branches.length ? branches : null)
  const sql = `
    SELECT p.id, p.code, p.name, p.sale_price, ${can(ctx.user, 'produtos.custo') ? 'p.cost_price,' : ''} p.active, p.ncm, p.min_stock, p.gender, p.images,
           b.name AS brand, co.name AS collection, ca.name AS category, s.name AS supplier,
           (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.active) AS variants,
           (SELECT COALESCE(sum(sb.qty),0)::float8 FROM stock_balances sb JOIN product_variants v ON v.id = sb.variant_id WHERE v.product_id = p.id AND (${bp}::uuid[] IS NULL OR sb.branch_id = ANY(${bp}::uuid[]))) AS stock,
           (SELECT min(barcode) FROM product_variants v WHERE v.product_id = p.id) AS barcode
      FROM products p LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN collections co ON co.id = p.collection_id
      LEFT JOIN categories ca ON ca.id = p.category_id LEFT JOIN suppliers s ON s.id = p.supplier_id
      ${w.sql}`
  const wrapped = q.low === 'true' ? `SELECT * FROM (${sql}) x WHERE x.stock <= x.min_stock ORDER BY x.name` : `${sql} ORDER BY p.name`
  return paged(db, wrapped, w.params, q)
})

router.get('/api/products/:id', { perm: 'produtos.ver' }, async (ctx) => {
  const p = await db.one(
    `SELECT p.*, b.name AS brand, co.name AS collection, ca.name AS category, s.name AS supplier FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN collections co ON co.id = p.collection_id LEFT JOIN categories ca ON ca.id = p.category_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1 AND p.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!p) throw notFound('Produto')
  if (!can(ctx.user, 'produtos.custo')) delete p.cost_price
  const variants = await db.many(
    `SELECT v.*, sz.code AS size, sz.sort AS size_sort, sz.grid, co.name AS color, co.hex AS color_hex,
            COALESCE(v.sale_price, $2) AS price,
            COALESCE((SELECT json_object_agg(sb.branch_id, sb.qty) FROM stock_balances sb WHERE sb.variant_id = v.id), '{}') AS stock_by_branch,
            COALESCE((SELECT sum(qty) FROM stock_balances sb WHERE sb.variant_id = v.id),0)::int AS stock_total
       FROM product_variants v LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
      WHERE v.product_id = $1 ORDER BY co.name NULLS FIRST, sz.sort NULLS FIRST`, [p.id, p.sale_price])
  if (!can(ctx.user, 'produtos.custo')) variants.forEach((x) => delete x.cost_price)
  const sales = await db.one(`SELECT COALESCE(sum(si.qty - si.returned_qty),0)::float8 AS qty_90d, COALESCE(sum(si.total),0) AS revenue_90d FROM sale_items si JOIN sales s ON s.id = si.sale_id
                               JOIN product_variants v ON v.id = si.variant_id WHERE v.product_id = $1 AND s.status <> 'cancelada' AND s.type = 'venda' AND s.created_at > now() - interval '90 days'`, [p.id])
  return { ...p, variants, sales }
})

router.post('/api/products', { perm: 'produtos.editar' }, async (ctx) => {
  const b: any = parse(v.object({ ...productSchema, grid: v.object({ sizeIds: v.array(v.uuid()).optional(), colorIds: v.array(v.uuid()).optional() }).optional(), variants: v.array(variantSchema).optional() }), ctx.body)
  return tx(async (c) => {
    const keys = Object.keys(productSchema).filter((k) => b[k] !== undefined)
    const p = await c.one(`INSERT INTO products(company_id, created_by, ${keys.join(', ')}) VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
      [ctx.user.companyId, ctx.user.id, ...keys.map((k) => b[k])])
    let list = b.variants?.length ? b.variants : gridToList(b.grid)
    if (!list.length) list = [{ size_id: null, color_id: null }]
    const variants = await createVariants(c, ctx.user.companyId, p, list)
    await audit(c, ctx, 'produto.criado', 'product', p.id, { code: p.code, name: p.name, variants: variants.length })
    return { ...p, variants }
  })
})

router.put('/api/products/:id', { perm: 'produtos.editar' }, async (ctx) => {
  const partial: any = {}
  for (const [k, s] of Object.entries(productSchema)) partial[k] = (s as any).optional()
  const b: any = parse(v.object(partial), ctx.body)
  const keys = Object.keys(productSchema).filter((k) => k in ctx.body)
  if (!can(ctx.user, 'produtos.custo')) { const i = keys.indexOf('cost_price'); if (i >= 0) keys.splice(i, 1) }
  if (!keys.length) throw unprocessable('Nada para alterar.')
  const before = await db.one(`SELECT sale_price, cost_price FROM products WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!before) throw notFound('Produto')
  const r = await db.one(`UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
    [ctx.params.id, ctx.user.companyId, ...keys.map((k) => (b[k] === undefined ? (k === 'tags' ? [] : null) : b[k]))])
  await audit(null, ctx, 'produto.alterado', 'product', r.id, { ...b, preco_anterior: before.sale_price }, before.sale_price !== r.sale_price ? 'warning' : 'info')
  // e-commerce: reenvia o produto se houver integração ativa
  await db.query(`INSERT INTO outbox(company_id, integration_id, topic, payload, dedupe_key)
                  SELECT $1, i.id, 'ecommerce.produto', jsonb_build_object('productId', $2::text), 'produto:' || $2 || ':' || extract(epoch from now())::bigint
                    FROM integrations i WHERE i.company_id = $1 AND i.kind = 'ecommerce' AND i.status = 'ativo' ON CONFLICT DO NOTHING`, [ctx.user.companyId, r.id])
  return r
})

router.post('/api/products/:id/variants', { perm: 'produtos.editar' }, async (ctx) => {
  const b: any = parse(v.object({ grid: v.object({ sizeIds: v.array(v.uuid()).optional(), colorIds: v.array(v.uuid()).optional() }).optional(), variants: v.array(variantSchema).optional() }), ctx.body)
  return tx(async (c) => {
    const p = await c.one(`SELECT id, code FROM products WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!p) throw notFound('Produto')
    const created = await createVariants(c, ctx.user.companyId, p, b.variants?.length ? b.variants : gridToList(b.grid))
    await audit(c, ctx, 'produto.variacoes_adicionadas', 'product', p.id, { count: created.length })
    return created
  })
})

router.put('/api/variants/:id', { perm: 'produtos.editar' }, async (ctx) => {
  const b: any = parse(v.object({ sku: v.string({ min: 1, max: 60 }).optional(), barcode: v.string({ max: 14 }).optional(), sale_price: v.money({ min: 0 }).nullable(),
    cost_price: v.money({ min: 0 }).nullable(), min_stock: v.int({ min: 0 }).nullable(), active: v.boolean().optional() }), ctx.body)
  if (b.barcode) { b.barcode = onlyDigits(b.barcode); if (!isValidGTIN(b.barcode)) throw unprocessable('Código de barras inválido (dígito verificador).') }
  const keys = ['sku', 'barcode', 'sale_price', 'cost_price', 'min_stock', 'active'].filter((k) => k in ctx.body && (k !== 'cost_price' || can(ctx.user, 'produtos.custo')))
  if (!keys.length) throw unprocessable('Nada para alterar.')
  const r = await db.one(`UPDATE product_variants SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
    [ctx.params.id, ctx.user.companyId, ...keys.map((k) => b[k] ?? null)])
  if (!r) throw notFound('Variação')
  await audit(null, ctx, 'variacao.alterada', 'variant', r.id, b)
  return r
})

/** Busca rápida do PDV: código de barras/SKU exato primeiro, depois nome. Retorna saldo da filial atual. */
router.get('/api/variants/search', { perm: ['produtos.ver', 'vendas.criar'] }, async (ctx) => {
  const q = (ctx.query.q || '').trim()
  if (!q) return []
  const branch = ctx.query.branch && ctx.query.branch !== 'current' ? branchScope(ctx, ctx.query.branch)[0] : ctx.user.branchId
  const sel = `SELECT v.id, v.sku, v.barcode, v.product_id, p.code, p.name, sz.code AS size, co.name AS color, co.hex AS color_hex, b.name AS brand,
                      COALESCE(v.sale_price, p.sale_price) AS price, COALESCE(sb.qty, 0) AS stock, p.track_stock, v.active AND p.active AS active, p.unit, p.sale_by_weight, p.age_restricted, p.plu_code, p.kind, p.duration_min,
                      (SELECT json_agg(json_build_object('min_qty', t.min_qty, 'unit_price', t.unit_price) ORDER BY t.min_qty) FROM product_price_tiers t WHERE t.product_id = p.id) AS price_tiers
                 FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
                 LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND sb.branch_id = $2
                WHERE v.company_id = $1`
  const exact = await db.many(`${sel} AND (v.barcode = $3 OR upper(v.sku) = upper($3)) LIMIT 5`, [ctx.user.companyId, branch, q])
  if (exact.length) return exact.map((x) => ({ ...x, exact: true }))
  // embalagem (caixa), combo ou etiqueta de balança
  const hit = await findPackagingOrCombo(db, ctx.user.companyId, q)
  if (hit) return [{ ...hit, kind: hit.kind, exact: true, active: true, stock: null }]
  if (/^\d{13}$/.test(q)) {
    const sc = await resolveScale(db, ctx.user.companyId, q, (await getSettings(db, ctx.user.companyId)).balanca)
    if (sc) return [{ kind: 'balanca', exact: true, active: true, id: sc.variantId, sku: sc.sku, name: sc.name, price: sc.total, unit_price: sc.unitPrice, qty: sc.qty, scaleCode: q, stock: null }]
  }
  return db.many(`${sel} AND v.active AND p.active AND (p.name ILIKE $3 OR p.code ILIKE $3 OR v.sku ILIKE $3) ORDER BY p.name, co.name, sz.sort LIMIT 40`, [ctx.user.companyId, branch, `%${q}%`])
})

/** Dados para impressão de etiquetas (código de barras gerado no navegador). */
router.post('/api/labels', { perm: 'produtos.ver' }, async (ctx) => {
  const b = parse(v.object({ items: v.array(v.object({ variantId: v.uuid(), qty: v.int({ min: 1, max: 500 }) }), { min: 1, max: 300 }) }), ctx.body)
  const rows = await db.many(
    `SELECT v.id, v.sku, v.barcode, p.code, p.name, p.short_name, sz.code AS size, co.name AS color, b.name AS brand, COALESCE(v.sale_price, p.sale_price) AS price
       FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id LEFT JOIN brands b ON b.id = p.brand_id
      WHERE v.company_id = $1 AND v.id = ANY($2::uuid[])`, [ctx.user.companyId, b.items.map((i) => i.variantId)])
  const map = new Map(rows.map((r) => [r.id, r]))
  return b.items.filter((i) => map.has(i.variantId)).map((i) => ({ ...map.get(i.variantId), qty: i.qty }))
})
