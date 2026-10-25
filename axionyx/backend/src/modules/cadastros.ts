import { router, audit, paged, Where, can, Ctx } from '../core/http'
import { db, tx, nextNumber } from '../core/db'
import { crud } from '../core/crud'
import { v, parse, isValidDoc, onlyDigits, isValidCNPJ } from '../core/validate'
import { notFound, unprocessable, forbidden } from '../core/errors'
import { loyaltyBalance } from '../services/loyalty'
import { BALANCE_SQL } from '../services/finance'
import { getSettings } from '../services/settings'

const address = v.object({
  cep: v.string({ max: 9 }).optional(), logradouro: v.string({ max: 200 }).optional(), numero: v.string({ max: 20 }).optional(),
  complemento: v.string({ max: 100 }).optional(), bairro: v.string({ max: 100 }).optional(), cidade: v.string({ max: 100 }).optional(),
  uf: v.string({ max: 2 }).optional(), codigoMunicipio: v.string({ max: 7 }).optional(),
}).optional()

// ---------- Cadastros auxiliares ----------
crud({ table: 'brands', path: '/api/brands', entity: 'marca', label: 'Marca', view: 'produtos.ver', edit: 'cadastros.editar', softDelete: true, order: 't.name',
  search: ['t.name'], schema: { name: v.string({ min: 1, max: 80 }), active: v.boolean().optional() } })
crud({ table: 'collections', path: '/api/collections', entity: 'colecao', label: 'Coleção', view: 'produtos.ver', edit: 'cadastros.editar', softDelete: true, order: 't.year DESC NULLS LAST, t.name',
  search: ['t.name'], schema: { name: v.string({ min: 1, max: 80 }), season: v.string({ max: 40 }).optional(), year: v.int({ min: 2000, max: 2100 }).optional(),
    starts_on: v.date().optional(), ends_on: v.date().optional(), active: v.boolean().optional() } })
crud({ table: 'categories', path: '/api/categories', entity: 'categoria', label: 'Categoria', view: 'produtos.ver', edit: 'cadastros.editar', softDelete: true, order: 't.name',
  search: ['t.name'], schema: { name: v.string({ min: 1, max: 80 }), parent_id: v.uuid().optional(), active: v.boolean().optional() } })
crud({ table: 'colors', path: '/api/colors', entity: 'cor', label: 'Cor', view: 'produtos.ver', edit: 'cadastros.editar', softDelete: true, order: 't.name',
  search: ['t.name', 't.code'], schema: { name: v.string({ min: 1, max: 60 }), code: v.string({ max: 10 }).optional(), hex: v.string({ pattern: /^#[0-9a-f]{6}$/i, patternMsg: 'Use o formato #RRGGBB.' }).optional(), active: v.boolean().optional() } })
crud({ table: 'sizes', path: '/api/sizes', entity: 'tamanho', label: 'Tamanho', view: 'produtos.ver', edit: 'cadastros.editar', softDelete: true, order: 't.grid, t.sort',
  search: ['t.code', 't.grid'], schema: { grid: v.string({ min: 1, max: 40 }), code: v.string({ min: 1, max: 10 }), sort: v.int().optional(), active: v.boolean().optional() } })

const supplierSchema = {
  name: v.string({ min: 2, max: 150 }), trade_name: v.string({ max: 150 }).optional(),
  cnpj: v.string({ max: 18 }).optional(), ie: v.string({ max: 20 }).optional(), email: v.email().optional(), phone: v.string({ max: 20 }).optional(),
  address, active: v.boolean().optional(),
}
crud({ table: 'suppliers', path: '/api/suppliers', entity: 'fornecedor', label: 'Fornecedor', view: 'cadastros.ver', edit: 'cadastros.editar', softDelete: true, order: 't.name',
  search: ['t.name', 't.trade_name', 't.cnpj'], json: ['address'], schema: supplierSchema })

router.get('/api/lookups', {}, async (ctx) => {
  const id = ctx.user.companyId
  const [brands, collections, categories, sizes, colors, suppliers, methods, sellers, branches, accounts, finCategories, professionals] = await Promise.all([
    db.many(`SELECT id, name FROM brands WHERE company_id = $1 AND active ORDER BY name`, [id]),
    db.many(`SELECT id, name, season, year FROM collections WHERE company_id = $1 AND active ORDER BY year DESC NULLS LAST, name`, [id]),
    db.many(`SELECT id, name, parent_id FROM categories WHERE company_id = $1 AND active ORDER BY name`, [id]),
    db.many(`SELECT id, grid, code, sort FROM sizes WHERE company_id = $1 AND active ORDER BY grid, sort`, [id]),
    db.many(`SELECT id, name, hex, code FROM colors WHERE company_id = $1 AND active ORDER BY name`, [id]),
    db.many(`SELECT id, name, cnpj FROM suppliers WHERE company_id = $1 AND active ORDER BY name`, [id]),
    db.many(`SELECT id, name, kind, max_installments, fee_pct, settlement_days FROM payment_methods WHERE company_id = $1 AND active ORDER BY sort, name`, [id]),
    db.many(`SELECT u.id, u.name, uc.commission_pct FROM user_companies uc JOIN users u ON u.id = uc.user_id WHERE uc.company_id = $1 AND uc.active AND u.active AND (NOT u.is_superadmin OR u.id = $2) ORDER BY uc.is_seller DESC, u.name`, [id, ctx.user.id]),
    db.many(`SELECT id, code, name FROM branches WHERE company_id = $1 AND active ORDER BY code`, [id]),
    db.many(`SELECT id, name, type, branch_id FROM financial_accounts WHERE company_id = $1 AND active ORDER BY type, name`, [id]),
    db.many(`SELECT id, code, name, type, dre_group FROM financial_categories WHERE company_id = $1 AND active ORDER BY code`, [id]),
    db.many(`SELECT id, name, color, user_id, specialty FROM professionals WHERE company_id = $1 AND active AND (branch_id IS NULL OR branch_id = $2) ORDER BY name`, [id, ctx.user.branchId]),
  ])
  return { brands, collections, categories, sizes, colors, suppliers, paymentMethods: methods, sellers, branches, accounts, finCategories, professionals }
})

// ---------- Clientes ----------
const customerSchema = {
  type: v.enum(['PF', 'PJ'] as const).default('PF'),
  name: v.string({ min: 2, max: 150 }),
  trade_name: v.string({ max: 150 }).optional(),
  cpf_cnpj: v.string({ max: 18 }).optional(),
  ie: v.string({ max: 20 }).optional(),
  email: v.email().optional(),
  phone: v.string({ max: 20 }).optional(),
  whatsapp: v.string({ max: 20 }).optional(),
  birth_date: v.date().optional(),
  gender: v.string({ max: 20 }).optional(),
  address,
  credit_limit: v.money({ min: 0 }).optional(),
  preferences: v.json().optional(),
  tags: v.array(v.string({ max: 30 })).optional(),
  notes: v.string({ max: 2000 }).optional(),
  is_partner: v.boolean().optional(),
  active: v.boolean().optional(),
}

function normalizeCustomer(b: any) {
  if (b.cpf_cnpj) {
    const d = onlyDigits(b.cpf_cnpj)
    if (!isValidDoc(d)) throw unprocessable('CPF/CNPJ inválido.', [{ path: 'cpf_cnpj', message: 'Documento inválido.' }])
    b.cpf_cnpj = d
    b.type = d.length === 14 ? 'PJ' : 'PF'
  }
  for (const k of ['phone', 'whatsapp']) if (b[k]) b[k] = onlyDigits(b[k])
  if (b.preferences) {
    const p = b.preferences
    b.preferences = {
      tamanhos: { superior: String(p.tamanhos?.superior ?? '').slice(0, 10), inferior: String(p.tamanhos?.inferior ?? '').slice(0, 10), calcado: String(p.tamanhos?.calcado ?? '').slice(0, 10) },
      marcas: Array.isArray(p.marcas) ? p.marcas.slice(0, 20).map(String) : [],
      estilos: Array.isArray(p.estilos) ? p.estilos.slice(0, 20).map(String) : [],
      cores: Array.isArray(p.cores) ? p.cores.slice(0, 20).map(String) : [],
      observacoes: String(p.observacoes ?? '').slice(0, 500),
    }
  }
  return b
}

const canSeeCredit = (ctx: Ctx) => can(ctx.user, 'financeiro.ver') || can(ctx.user, 'vendas.criar')

router.get('/api/customers', { perm: 'clientes.ver' }, async (ctx) => {
  const q = ctx.query
  const w = new Where([['c.company_id = ?', ctx.user.companyId], ['c.anonymized_at IS NULL']])
  if (q.q) { const d = onlyDigits(q.q); w.add(`(c.name ILIKE ? OR c.email ILIKE ? ${d.length >= 3 ? 'OR c.cpf_cnpj LIKE ? OR c.phone LIKE ? OR c.whatsapp LIKE ?' : ''} OR c.code::text = ?)`, `%${q.q}%`, `%${q.q}%`, ...(d.length >= 3 ? [`%${d}%`, `%${d}%`, `%${d}%`] : []), q.q) }
  if (q.active) w.add('c.active = ?', q.active === 'true')
  if (q.partner) w.add('c.is_partner = ?', q.partner === 'true')
  return paged(db, `
    SELECT c.id, c.code, c.type, c.name, c.trade_name, c.cpf_cnpj, c.email, c.phone, c.whatsapp, c.birth_date, c.active, c.is_partner, c.tags, c.created_at,
           (c.address->>'cidade') AS city, (c.address->>'uf') AS uf, c.credit_limit,
           s.last_purchase, COALESCE(s.total,0) AS total_purchases, COALESCE(s.n,0) AS purchases,
           COALESCE((SELECT sum(${BALANCE_SQL}) FROM receivables r WHERE r.customer_id = c.id AND r.status IN ('aberto','parcial') AND r.method_kind IN ('crediario','a_prazo','boleto')),0) AS open_balance
      FROM customers c
      LEFT JOIN LATERAL (SELECT max(created_at) AS last_purchase, sum(total) AS total, count(*) AS n FROM sales WHERE customer_id = c.id AND type = 'venda' AND status <> 'cancelada') s ON true
      ${w.sql} ORDER BY ${q.sort === 'recentes' ? 'c.created_at DESC' : 'c.name'}`, w.params, q)
})

router.get('/api/customers/:id', { perm: 'clientes.ver' }, async (ctx) => {
  const c = await db.one(`SELECT * FROM customers WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL`, [ctx.params.id, ctx.user.companyId])
  if (!c) throw notFound('Cliente')
  const [stats, consents, cashback, credits] = await Promise.all([
    db.one(`SELECT count(*)::int AS purchases, COALESCE(sum(total),0) AS total, COALESCE(avg(total),0) AS avg_ticket, max(created_at) AS last_purchase, min(created_at) AS first_purchase,
                   COALESCE(sum(items_count),0)::int AS items FROM sales WHERE customer_id = $1 AND type = 'venda' AND status <> 'cancelada'`, [c.id]),
    db.many(`SELECT DISTINCT ON (channel) channel, granted, source, created_at FROM customer_consents WHERE customer_id = $1 ORDER BY channel, created_at DESC`, [c.id]),
    loyaltyBalance(db, ctx.user.companyId, c.id),
    db.many(`SELECT id, code, balance, expires_at, status FROM store_credits WHERE customer_id = $1 AND status = 'ativo' ORDER BY created_at DESC`, [c.id]),
  ])
  const open = await db.one(`SELECT COALESCE(sum(${BALANCE_SQL}),0) AS open, COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE due_date < current_date),0) AS overdue
                               FROM receivables WHERE customer_id = $1 AND status IN ('aberto','parcial') AND method_kind IN ('crediario','a_prazo','boleto')`, [c.id])
  const topSizes = await db.many(`SELECT sz.code, sum(si.qty)::float8 AS qty FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id
                                    JOIN sizes sz ON sz.id = v.size_id WHERE s.customer_id = $1 AND s.status <> 'cancelada' GROUP BY sz.code ORDER BY 2 DESC LIMIT 5`, [c.id])
  const topBrands = await db.many(`SELECT b.name, sum(si.total) AS total FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id
                                    JOIN products p ON p.id = v.product_id JOIN brands b ON b.id = p.brand_id WHERE s.customer_id = $1 AND s.status <> 'cancelada' GROUP BY b.name ORDER BY 2 DESC LIMIT 5`, [c.id])
  if (!canSeeCredit(ctx)) delete (c as any).credit_limit
  return { ...c, stats, consents, cashback, store_credits: credits, open_balance: open.open, overdue_balance: open.overdue, top_sizes: topSizes, top_brands: topBrands }
})

router.get('/api/customers/:id/history', { perm: 'clientes.ver' }, async (ctx) => {
  const id = ctx.params.id
  const own = await db.one(`SELECT 1 FROM customers WHERE id = $1 AND company_id = $2`, [id, ctx.user.companyId])
  if (!own) throw notFound('Cliente')
  const [sales, conditionals, receivables, messages, loyalty] = await Promise.all([
    db.many(`SELECT s.id, s.number, s.created_at, s.total, s.status, s.items_count, s.channel, u.name AS seller FROM sales s LEFT JOIN users u ON u.id = s.seller_id
              WHERE s.customer_id = $1 AND s.type = 'venda' ORDER BY s.created_at DESC LIMIT 100`, [id]),
    db.many(`SELECT id, number, kind, status, due_date, created_at FROM conditionals WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    can(ctx.user, 'financeiro.ver') || can(ctx.user, 'vendas.criar')
      ? db.many(`SELECT id, document, installment_no, installments_total, due_date, amount, paid_amount, status, ${BALANCE_SQL} AS balance FROM receivables
                  WHERE customer_id = $1 AND method_kind IN ('crediario','a_prazo','boleto') ORDER BY due_date DESC LIMIT 100`, [id]) : Promise.resolve([]),
    db.many(`SELECT id, purpose, status, created_at, body FROM messages WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    db.many(`SELECT id, kind, amount, expires_at, notes, created_at FROM loyalty_ledger WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]),
  ])
  return { sales, conditionals, receivables, messages, loyalty }
})

router.post('/api/customers', { perm: 'clientes.editar' }, async (ctx) => {
  const b: any = normalizeCustomer(parse(v.object({ ...customerSchema, consents: v.json().optional() }), ctx.body))
  if (b.credit_limit !== undefined && !can(ctx.user, 'financeiro.renegociar') && !can(ctx.user, 'financeiro.editar')) delete b.credit_limit
  return tx(async (c) => {
    const code = await nextNumber(c, ctx.user.companyId, 'cliente')
    const r = await c.one(
      `INSERT INTO customers(company_id, code, type, name, trade_name, cpf_cnpj, ie, email, phone, whatsapp, birth_date, gender, address, credit_limit, preferences, tags, notes, is_partner, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [ctx.user.companyId, code, b.type, b.name, b.trade_name ?? null, b.cpf_cnpj ?? null, b.ie ?? null, b.email ?? null, b.phone ?? null, b.whatsapp ?? null,
        b.birth_date ?? null, b.gender ?? null, JSON.stringify(b.address ?? {}), b.credit_limit ?? 0, JSON.stringify(b.preferences ?? {}), b.tags ?? [], b.notes ?? null, b.is_partner ?? false, ctx.user.id])
    await saveConsents(c, ctx, r.id, b.consents)
    await audit(c, ctx, 'cliente.criado', 'customer', r.id, { name: b.name })
    return r
  })
})

router.put('/api/customers/:id', { perm: 'clientes.editar' }, async (ctx) => {
  const partial: any = {}
  for (const [k, s] of Object.entries(customerSchema)) partial[k] = (s as any).optional()
  const b: any = normalizeCustomer(parse(v.object({ ...partial, consents: v.json().optional() }), ctx.body))
  if ('credit_limit' in ctx.body && !can(ctx.user, 'financeiro.renegociar') && !can(ctx.user, 'financeiro.editar')) throw forbidden('Somente o financeiro pode alterar o limite de crédito.')
  return tx(async (c) => {
    const keys = Object.keys(customerSchema).filter((k) => k in ctx.body)
    const json = ['address', 'preferences']
    if (keys.length) {
      const vals = keys.map((k) => (b[k] === undefined ? (k === 'tags' ? [] : null) : json.includes(k) ? JSON.stringify(b[k] ?? {}) : b[k]))
      const r = await c.one(`UPDATE customers SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL RETURNING id`,
        [ctx.params.id, ctx.user.companyId, ...vals])
      if (!r) throw notFound('Cliente')
    }
    await saveConsents(c, ctx, ctx.params.id, b.consents)
    await audit(c, ctx, 'cliente.alterado', 'customer', ctx.params.id, b)
    return c.one(`SELECT * FROM customers WHERE id = $1`, [ctx.params.id])
  })
})

async function saveConsents(c: any, ctx: Ctx, customerId: string, consents?: Record<string, boolean>) {
  if (!consents) return
  const valid = ['whatsapp', 'email', 'sms', 'marketing', 'preferencias']
  for (const [channel, granted] of Object.entries(consents)) {
    if (!valid.includes(channel)) continue
    const cur = await c.one(`SELECT granted FROM customer_consents WHERE customer_id = $1 AND channel = $2 ORDER BY created_at DESC LIMIT 1`, [customerId, channel])
    if (cur && cur.granted === !!granted) continue
    await c.query(`INSERT INTO customer_consents(company_id, customer_id, channel, granted, source, ip, user_id) VALUES ($1,$2,$3,$4,'loja',$5,$6)`,
      [ctx.user.companyId, customerId, channel, !!granted, ctx.ip, ctx.user.id])
  }
}

/** LGPD: portabilidade (exporta dados pessoais e histórico do titular). */
router.get('/api/customers/:id/export', { perm: 'clientes.dados_pessoais' }, async (ctx) => {
  const c = await db.one(`SELECT * FROM customers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!c) throw notFound('Cliente')
  const sales = await db.many(`SELECT number, created_at, total, status FROM sales WHERE customer_id = $1 ORDER BY created_at`, [c.id])
  const consents = await db.many(`SELECT channel, granted, source, created_at FROM customer_consents WHERE customer_id = $1 ORDER BY created_at`, [c.id])
  const loyalty = await db.many(`SELECT kind, amount, created_at FROM loyalty_ledger WHERE customer_id = $1 ORDER BY created_at`, [c.id])
  await audit(null, ctx, 'lgpd.exportacao', 'customer', c.id, null, 'warning')
  ctx.reply = { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="dados-cliente-${c.code}.json"` }, raw: JSON.stringify({ titular: c, compras: sales, consentimentos: consents, fidelidade: loyalty, geradoEm: new Date().toISOString() }, null, 2) }
  return null
})

/** LGPD: anonimização (mantém registros fiscais/financeiros sem dados identificáveis). */
router.post('/api/customers/:id/anonymize', { perm: 'clientes.dados_pessoais' }, async (ctx) => {
  return tx(async (c) => {
    const open = await c.one(`SELECT count(*)::int AS n FROM receivables WHERE customer_id = $1 AND status IN ('aberto','parcial')`, [ctx.params.id])
    if (open.n > 0) throw unprocessable('Cliente possui títulos em aberto. A anonimização só é possível após a quitação (obrigação legal de cobrança).')
    const r = await c.one(`UPDATE customers SET name = 'Titular anonimizado #' || code, trade_name = NULL, cpf_cnpj = NULL, ie = NULL, email = NULL, phone = NULL, whatsapp = NULL,
                             birth_date = NULL, gender = NULL, address = '{}'::jsonb, preferences = '{}'::jsonb, notes = NULL, tags = '{}', active = false, anonymized_at = now()
                            WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL RETURNING id`, [ctx.params.id, ctx.user.companyId])
    if (!r) throw notFound('Cliente')
    await c.query(`INSERT INTO customer_consents(company_id, customer_id, channel, granted, source, user_id) SELECT $1, $2, ch, false, 'anonimizacao', $3 FROM unnest(ARRAY['whatsapp','email','sms','marketing','preferencias']) ch`, [ctx.user.companyId, ctx.params.id, ctx.user.id])
    await audit(c, ctx, 'lgpd.anonimizacao', 'customer', ctx.params.id, null, 'critical')
    return { ok: true }
  })
})

/** Segmentações para relacionamento: aniversariantes, inativos, pós-venda. */
router.get('/api/customers-segments/:segment', { perm: 'clientes.ver' }, async (ctx) => {
  const s = (await getSettings(db, ctx.user.companyId)).segmentos
  const base = `SELECT c.id, c.code, c.name, c.whatsapp, c.phone, c.email, c.birth_date,
                  (SELECT max(created_at) FROM sales WHERE customer_id = c.id AND status <> 'cancelada' AND type = 'venda') AS last_purchase,
                  (SELECT granted FROM customer_consents cc WHERE cc.customer_id = c.id AND cc.channel = 'whatsapp' ORDER BY created_at DESC LIMIT 1) AS whatsapp_consent
                 FROM customers c WHERE c.company_id = $1 AND c.active AND c.anonymized_at IS NULL`
  const month = parseInt(ctx.query.month || '', 10)
  switch (ctx.params.segment) {
    case 'aniversariantes':
      return db.many(`${base} AND c.birth_date IS NOT NULL AND extract(month from c.birth_date) = $2 ORDER BY extract(day from c.birth_date)`, [ctx.user.companyId, month >= 1 && month <= 12 ? month : new Date().getMonth() + 1])
    case 'inativos': {
      const days = parseInt(ctx.query.days || '', 10) || s.inativoDias
      return db.many(`SELECT * FROM (${base}) x WHERE x.last_purchase < now() - ($2 || ' days')::interval ORDER BY x.last_purchase`, [ctx.user.companyId, String(days)])
    }
    case 'pos-venda': {
      const days = parseInt(ctx.query.days || '', 10) || s.posVendaDias
      return db.many(`SELECT * FROM (${base}) x WHERE x.last_purchase BETWEEN now() - ($2 || ' days')::interval AND now() ORDER BY x.last_purchase DESC`, [ctx.user.companyId, String(days)])
    }
    case 'sem-compra':
      return db.many(`SELECT * FROM (${base}) x WHERE x.last_purchase IS NULL ORDER BY x.name`, [ctx.user.companyId])
    default: throw notFound('Segmento')
  }
})

// ---------- Formas de pagamento ----------
crud({ table: 'payment_methods', path: '/api/payment-methods', entity: 'forma_pagamento', label: 'Forma de pagamento', view: 'vendas.ver', edit: 'config.editar', softDelete: true, order: 't.sort, t.name',
  schema: { name: v.string({ min: 2, max: 60 }), kind: v.enum(['dinheiro', 'pix', 'debito', 'credito', 'crediario', 'vale_troca', 'cashback', 'boleto', 'outro'] as const),
    fee_pct: v.number({ min: 0, max: 30 }).optional(), settlement_days: v.int({ min: 0, max: 365 }).optional(), max_installments: v.int({ min: 1, max: 24 }).optional(),
    account_id: v.uuid().optional(), sort: v.int().optional(), active: v.boolean().optional() } })

export const _validCnpj = isValidCNPJ

router.get('/api/cadastros/counts', {}, async (ctx) => {
  return db.one(`SELECT
     (SELECT count(*)::int FROM customers WHERE company_id = $1 AND anonymized_at IS NULL) AS customers,
     (SELECT count(*)::int FROM customers WHERE company_id = $1 AND anonymized_at IS NULL AND active) AS customers_active,
     (SELECT count(*)::int FROM suppliers WHERE company_id = $1 AND active) AS suppliers,
     (SELECT count(*)::int FROM products WHERE company_id = $1 AND active) AS products,
     (SELECT count(*)::int FROM product_variants WHERE company_id = $1 AND active) AS variants,
     (SELECT count(*)::int FROM brands WHERE company_id = $1 AND active) AS brands,
     (SELECT count(*)::int FROM collections WHERE company_id = $1 AND active) AS collections,
     (SELECT count(*)::int FROM categories WHERE company_id = $1 AND active) AS categories,
     (SELECT count(*)::int FROM colors WHERE company_id = $1 AND active) AS colors,
     (SELECT count(DISTINCT grid)::int FROM sizes WHERE company_id = $1 AND active) AS grids,
     (SELECT count(*)::int FROM payment_methods WHERE company_id = $1 AND active) AS payment_methods,
     (SELECT count(*)::int FROM customers WHERE company_id = $1 AND is_partner AND active) AS partners`, [ctx.user.companyId])
})
