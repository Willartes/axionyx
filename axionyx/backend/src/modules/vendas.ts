import { router, audit, paged, Where, branchScope, can, r2 } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden } from '../core/errors'
import { createSale, cancelSale, registerReturn, actorOf } from '../services/sales'
import { addTransaction, defaultAccount, systemCategory } from '../services/finance'

// ---------- Caixa ----------
router.get('/api/cash/registers', { perm: ['caixa.operar', 'vendas.ver'] }, async (ctx) =>
  db.many(`SELECT r.*, (SELECT row_to_json(s) FROM (SELECT cs.id, cs.opened_at, cs.opening_amount, u.name AS opened_by_name FROM cash_sessions cs JOIN users u ON u.id = cs.opened_by WHERE cs.register_id = r.id AND cs.status = 'aberto') s) AS open_session
             FROM cash_registers r WHERE r.company_id = $1 AND r.branch_id = $2 AND r.active ORDER BY r.name`, [ctx.user.companyId, ctx.user.branchId]))

router.get('/api/cash/current', { perm: ['caixa.operar', 'vendas.criar'] }, async (ctx) => {
  const s = await db.one(`SELECT cs.*, cr.name AS register_name, u.name AS opened_by_name FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.register_id JOIN users u ON u.id = cs.opened_by
                           WHERE cs.company_id = $1 AND cs.branch_id = $2 AND cs.status = 'aberto' ORDER BY (cs.opened_by = $3) DESC, cs.opened_at DESC LIMIT 1`, [ctx.user.companyId, ctx.user.branchId, ctx.user.id])
  if (!s) return null
  return { ...s, summary: await sessionSummary(s.id) }
})

async function sessionSummary(sessionId: string) {
  const byType = await db.many(`SELECT type, COALESCE(sum(amount),0) AS total, count(*)::int AS n FROM cash_movements WHERE session_id = $1 GROUP BY type`, [sessionId])
  const byMethod = await db.many(`SELECT sp.kind, COALESCE(sum(sp.amount),0) AS total, count(DISTINCT s.id)::int AS sales FROM sales s JOIN sale_payments sp ON sp.sale_id = s.id
                                   WHERE s.cash_session_id = $1 AND s.status <> 'cancelada' GROUP BY sp.kind ORDER BY 2 DESC`, [sessionId])
  const sales = await db.one(`SELECT count(*)::int AS n, COALESCE(sum(total),0) AS total FROM sales WHERE cash_session_id = $1 AND status <> 'cancelada'`, [sessionId])
  const expectedCash = byType.reduce((s, t) => s + Number(t.total), 0)
  return { byType, byMethod, sales, expectedCash: r2(expectedCash) }
}

router.post('/api/cash/open', { perm: 'caixa.operar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ registerId: v.uuid(), openingAmount: v.money({ min: 0 }) }), ctx.body)
  return tx(async (c) => {
    const r = await c.one(`SELECT * FROM cash_registers WHERE id = $1 AND company_id = $2 AND branch_id = $3 AND active`, [b.registerId, ctx.user.companyId, ctx.user.branchId])
    if (!r) throw unprocessable('Caixa inválido para esta filial.')
    const s = await c.one(`INSERT INTO cash_sessions(company_id, branch_id, register_id, opened_by, opening_amount) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [ctx.user.companyId, ctx.user.branchId, r.id, ctx.user.id, b.openingAmount])
    if (b.openingAmount > 0) await c.query(`INSERT INTO cash_movements(company_id, session_id, type, amount, user_id, notes) VALUES ($1,$2,'abertura',$3,$4,'Fundo de troco')`, [ctx.user.companyId, s.id, b.openingAmount, ctx.user.id])
    await audit(c, ctx, 'caixa.aberto', 'cash_session', s.id, { register: r.name, openingAmount: b.openingAmount })
    return s
  })
})

router.post('/api/cash/:id/movement', { perm: 'caixa.operar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ type: v.enum(['sangria', 'suprimento'] as const), amount: v.money({ min: 0.01 }), notes: v.string({ min: 3, max: 200 }) }), ctx.body)
  return tx(async (c) => {
    const s = await c.one(`SELECT cs.*, cr.account_id FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.register_id WHERE cs.id = $1 AND cs.company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!s || s.status !== 'aberto') throw conflict('Caixa não está aberto.')
    if (b.type === 'sangria') {
      const bal = await c.one(`SELECT COALESCE(sum(amount),0) AS s FROM cash_movements WHERE session_id = $1`, [s.id])
      if (Number(bal.s) < b.amount) throw unprocessable(`Saldo em dinheiro insuficiente para a sangria (R$ ${Number(bal.s).toFixed(2)}).`)
    }
    const m = await c.one(`INSERT INTO cash_movements(company_id, session_id, type, amount, user_id, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ctx.user.companyId, s.id, b.type, b.type === 'sangria' ? -b.amount : b.amount, ctx.user.id, b.notes])
    // sangria: dinheiro sai do caixa da loja e vai para a conta bancária/cofre (transferência entre contas)
    const caixa = s.account_id || (await defaultAccount(c, ctx.user.companyId, ctx.user.branchId, 'caixa'))
    const banco = await defaultAccount(c, ctx.user.companyId, null, 'banco')
    if (caixa !== banco) {
      const from = b.type === 'sangria' ? caixa : banco, to = b.type === 'sangria' ? banco : caixa
      await addTransaction(c, { companyId: ctx.user.companyId, branchId: ctx.user.branchId, accountId: from, direction: 'saida', amount: b.amount, description: `${b.type === 'sangria' ? 'Sangria' : 'Suprimento'} de caixa: ${b.notes}`, categoryId: await systemCategory(c, ctx.user.companyId, b.type), sourceType: 'cash_movement', sourceId: null as any, userId: ctx.user.id })
      await addTransaction(c, { companyId: ctx.user.companyId, branchId: ctx.user.branchId, accountId: to, direction: 'entrada', amount: b.amount, description: `${b.type === 'sangria' ? 'Sangria' : 'Suprimento'} de caixa: ${b.notes}`, categoryId: await systemCategory(c, ctx.user.companyId, b.type), sourceType: 'cash_movement', sourceId: null as any, userId: ctx.user.id })
    }
    await audit(c, ctx, `caixa.${b.type}`, 'cash_session', s.id, { amount: b.amount, notes: b.notes }, 'warning')
    return m
  })
})

router.post('/api/cash/:id/close', { perm: 'caixa.fechar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ declaredAmount: v.money({ min: 0 }), notes: v.string({ max: 500 }).optional() }), ctx.body)
  return tx(async (c) => {
    const s = await c.one(`SELECT * FROM cash_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!s || s.status !== 'aberto') throw conflict('Caixa não está aberto.')
    const exp = await c.one(`SELECT COALESCE(sum(amount),0) AS s FROM cash_movements WHERE session_id = $1`, [s.id])
    const expected = r2(Number(exp.s)), diff = r2(b.declaredAmount - expected)
    const r = await c.one(`UPDATE cash_sessions SET status = 'fechado', closed_by = $2, closed_at = now(), declared_amount = $3, expected_amount = $4, difference = $5, notes = $6 WHERE id = $1 RETURNING *`,
      [s.id, ctx.user.id, b.declaredAmount, expected, diff, b.notes ?? null])
    await audit(c, ctx, 'caixa.fechado', 'cash_session', s.id, { expected, declared: b.declaredAmount, difference: diff }, Math.abs(diff) > 0.009 ? 'warning' : 'info')
    return { ...r, summary: await sessionSummary(s.id) }
  })
})

router.get('/api/cash/sessions', { perm: ['caixa.fechar', 'financeiro.ver'] }, async (ctx) => {
  const branches = branchScope(ctx, ctx.query.branch)
  const w = new Where([['cs.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('cs.branch_id = ANY(?::uuid[])', branches)
  return paged(db, `SELECT cs.*, cr.name AS register_name, ou.name AS opened_by_name, cu.name AS closed_by_name, b.name AS branch
                      FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.register_id JOIN branches b ON b.id = cs.branch_id JOIN users ou ON ou.id = cs.opened_by LEFT JOIN users cu ON cu.id = cs.closed_by
                      ${w.sql} ORDER BY cs.opened_at DESC`, w.params, ctx.query)
})

router.get('/api/cash/sessions/:id', { perm: ['caixa.operar', 'caixa.fechar', 'financeiro.ver'] }, async (ctx) => {
  const s = await db.one(`SELECT cs.*, cr.name AS register_name FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.register_id WHERE cs.id = $1 AND cs.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!s) throw notFound('Sessão de caixa')
  const movements = await db.many(`SELECT m.*, u.name AS user_name FROM cash_movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.session_id = $1 ORDER BY m.id`, [s.id])
  return { ...s, movements, summary: await sessionSummary(s.id) }
})

// ---------- Vendas ----------
const itemSchema = v.object({ variantId: v.uuid().optional(), qty: v.number({ min: 0.001, max: 100000 }), discount: v.money({ min: 0 }).optional(),
  packagingId: v.uuid().optional(), comboId: v.uuid().optional(), scaleCode: v.string({ pattern: /^\d{13}$/, patternMsg: 'Etiqueta de balança inválida.' }).optional(),
  professionalId: v.uuid().optional(), appointmentServiceId: v.uuid().optional(), planItemId: v.uuid().optional(), workOrderItemId: v.uuid().optional() })
const paymentSchema = v.object({ methodId: v.uuid(), amount: v.money({ min: 0.01 }), installments: v.int({ min: 1, max: 24 }).optional(), firstDueDate: v.date().optional(), storeCreditCode: v.string({ max: 20 }).optional(), details: v.json().optional() })
const saleSchema = v.object({
  type: v.enum(['venda', 'orcamento'] as const).default('venda'),
  customerId: v.uuid().optional(), sellerId: v.uuid().optional(),
  items: v.array(itemSchema, { min: 1, max: 300 }),
  discountTotal: v.money({ min: 0 }).optional(),
  payments: v.array(paymentSchema, { max: 10 }).optional(),
  notes: v.string({ max: 1000 }).optional(),
  discountAuthorization: v.object({ email: v.email(), password: v.string({ trim: false }) }).optional(),
  emitFiscal: v.boolean().optional(),
  validUntil: v.date().optional(),
  ageConfirmed: v.boolean().optional(),
})

router.post('/api/sales', { perm: 'vendas.criar', idempotent: true }, async (ctx) => {
  const b: any = parse(saleSchema, ctx.body)
  return tx((c) => createSale(c, actorOf(ctx), b, ctx))
})

router.get('/api/sales', { perm: 'vendas.ver' }, async (ctx) => {
  const q = ctx.query
  const branches = branchScope(ctx, q.branch)
  const w = new Where([['s.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('s.branch_id = ANY(?::uuid[])', branches)
  w.add('s.type = ?', q.type === 'orcamento' ? 'orcamento' : 'venda')
  if (!can(ctx.user, 'vendas.todas')) w.add('s.seller_id = ?', ctx.user.id)
  w.addIf(q.status, 's.status = ?', q.status).addIf(q.seller, 's.seller_id = ?', q.seller).addIf(q.customer, 's.customer_id = ?', q.customer).addIf(q.channel, 's.channel = ?', q.channel)
    .addIf(q.from, 's.created_at >= ?::date', q.from).addIf(q.to, "s.created_at < ?::date + interval '1 day'", q.to)
  if (q.q) w.add('(s.number::text = ? OR cu.name ILIKE ? OR cu.cpf_cnpj = ?)', q.q, `%${q.q}%`, q.q.replace(/\D/g, ''))
  const sql = `SELECT s.id, s.number, s.type, s.status, s.channel, s.created_at, s.total, s.discount_total, s.items_count, s.valid_until, cu.name AS customer, u.name AS seller, b.name AS branch,
                      (SELECT string_agg(DISTINCT sp.kind, ',') FROM sale_payments sp WHERE sp.sale_id = s.id) AS payment_kinds,
                      (SELECT status FROM fiscal_documents f WHERE f.sale_id = s.id ORDER BY f.created_at DESC LIMIT 1) AS fiscal_status
                 FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id LEFT JOIN users u ON u.id = s.seller_id JOIN branches b ON b.id = s.branch_id ${w.sql} ORDER BY s.created_at DESC`
  const result = await paged(db, sql, w.params, q)
  const totals = await db.one(`SELECT count(*)::int AS n, COALESCE(sum(total) FILTER (WHERE status NOT IN ('cancelada','orcamento_expirado')),0) AS total FROM (${sql}) t`, w.params)
  return { ...result, totals }
})

router.get('/api/sales/:id', { perm: 'vendas.ver' }, async (ctx) => {
  const s = await db.one(`SELECT s.*, cu.name AS customer, cu.cpf_cnpj AS customer_doc, cu.whatsapp AS customer_whatsapp, u.name AS seller, b.name AS branch, cb.name AS created_by_name, xb.name AS cancelled_by_name, ab.name AS discount_authorized_by_name
                           FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id LEFT JOIN users u ON u.id = s.seller_id JOIN branches b ON b.id = s.branch_id
                           LEFT JOIN users cb ON cb.id = s.created_by LEFT JOIN users xb ON xb.id = s.cancelled_by LEFT JOIN users ab ON ab.id = s.discount_authorized_by
                          WHERE s.id = $1 AND s.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!s) throw notFound('Venda')
  if (!can(ctx.user, 'vendas.todas') && s.seller_id !== ctx.user.id) throw forbidden()
  const [items, payments, receivables, returns, fiscal, commissions, loyalty] = await Promise.all([
    db.many(`SELECT si.*, v.sku, v.barcode, p.name, p.code, sz.code AS size, co.name AS color FROM sale_items si JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
              LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id WHERE si.sale_id = $1 ORDER BY si.line`, [s.id]),
    db.many(`SELECT sp.*, pm.name AS method FROM sale_payments sp LEFT JOIN payment_methods pm ON pm.id = sp.method_id WHERE sp.sale_id = $1`, [s.id]),
    db.many(`SELECT id, document, installment_no, installments_total, method_kind, due_date, amount, paid_amount, status, (amount + interest + fine - discount - paid_amount) AS balance FROM receivables WHERE sale_id = $1 ORDER BY method_kind, installment_no`, [s.id]),
    db.many(`SELECT r.*, sc.code AS store_credit_code, u.name AS created_by_name FROM returns r LEFT JOIN store_credits sc ON sc.id = r.store_credit_id LEFT JOIN users u ON u.id = r.created_by WHERE r.sale_id = $1 ORDER BY r.created_at`, [s.id]),
    db.many(`SELECT id, model, status, is_test, number, series, access_key, created_at FROM fiscal_documents WHERE sale_id = $1 ORDER BY created_at`, [s.id]),
    can(ctx.user, 'comissoes.ver') ? db.many(`SELECT c.*, u.name AS seller FROM commissions c JOIN users u ON u.id = c.seller_id WHERE c.sale_id = $1 ORDER BY c.created_at`, [s.id]) : Promise.resolve([]),
    db.many(`SELECT kind, amount, created_at FROM loyalty_ledger WHERE source_id = $1 OR (source_type IN ('devolucao') AND source_id IN (SELECT id FROM returns WHERE sale_id = $1)) ORDER BY created_at`, [s.id]),
  ])
  if (!can(ctx.user, 'produtos.custo')) { delete s.cost_total; items.forEach((i) => delete i.unit_cost) }
  const timeline = await db.many(`SELECT action, CASE WHEN EXISTS (SELECT 1 FROM users sx WHERE sx.id = user_id AND sx.is_superadmin) THEN 'Suporte AXIONYX' ELSE user_name END AS user_name, created_at, data FROM audit_log WHERE entity = 'sale' AND entity_id = $1 ORDER BY created_at`, [s.id])
  return { ...s, items, payments, receivables, returns, fiscal, commissions, loyalty, timeline }
})

router.post('/api/sales/:id/cancel', { perm: 'vendas.cancelar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ reason: v.string({ min: 5, max: 300 }) }), ctx.body)
  return tx((c) => cancelSale(c, actorOf(ctx), ctx.params.id, b.reason, ctx))
})

/** Converte orçamento em venda (com preços atuais e pagamentos informados). */
router.post('/api/sales/:id/convert', { perm: 'vendas.criar', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({ payments: v.array(paymentSchema, { min: 1 }), discountAuthorization: v.object({ email: v.email(), password: v.string({ trim: false }) }).optional() }), ctx.body)
  return tx(async (c) => {
    const q = await c.one(`SELECT * FROM sales WHERE id = $1 AND company_id = $2 AND type = 'orcamento' FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!q) throw notFound('Orçamento')
    if (q.status !== 'orcamento') throw conflict('Orçamento já convertido, expirado ou cancelado.')
    const items = await c.many(`SELECT variant_id, qty, discount FROM sale_items WHERE sale_id = $1 ORDER BY line`, [q.id])
    const sale = await createSale(c, actorOf(ctx), {
      customerId: q.customer_id, sellerId: q.seller_id, items: items.map((i) => ({ variantId: i.variant_id, qty: i.qty, discount: Number(i.discount) })),
      payments: b.payments, notes: q.notes, originType: 'orcamento', originId: q.id, discountAuthorization: b.discountAuthorization,
    }, ctx)
    await c.query(`UPDATE sales SET status = 'orcamento_convertido' WHERE id = $1`, [q.id])
    return sale
  })
})

// ---------- Trocas e devoluções ----------
router.post('/api/returns', { perm: 'vendas.devolver', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({
    saleId: v.uuid(), type: v.enum(['devolucao', 'troca'] as const), refundMode: v.enum(['vale_troca', 'dinheiro', 'pix', 'estorno_cartao', 'abatimento_crediario'] as const),
    items: v.array(v.object({ saleItemId: v.uuid(), qty: v.number({ min: 0.001 }), restock: v.boolean().optional() }), { min: 1 }), reason: v.string({ max: 300 }).optional(),
  }), ctx.body)
  return tx((c) => registerReturn(c, actorOf(ctx), b, ctx))
})

router.get('/api/returns', { perm: 'vendas.ver' }, async (ctx) => {
  const branches = branchScope(ctx, ctx.query.branch)
  const w = new Where([['r.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('r.branch_id = ANY(?::uuid[])', branches)
  return paged(db, `SELECT r.*, s.number AS sale_number, cu.name AS customer, sc.code AS store_credit_code, u.name AS created_by_name
                      FROM returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers cu ON cu.id = r.customer_id LEFT JOIN store_credits sc ON sc.id = r.store_credit_id LEFT JOIN users u ON u.id = r.created_by
                      ${w.sql} ORDER BY r.created_at DESC`, w.params, ctx.query)
})

router.get('/api/store-credits/:code', { perm: ['vendas.criar', 'vendas.ver'] }, async (ctx) => {
  const r = await db.one(`SELECT sc.*, cu.name AS customer FROM store_credits sc LEFT JOIN customers cu ON cu.id = sc.customer_id WHERE sc.company_id = $1 AND sc.code = upper($2)`, [ctx.user.companyId, ctx.params.code])
  if (!r) throw notFound('Vale-troca')
  return r
})

// ---------- Comissões e metas ----------
router.get('/api/commissions', { perm: 'comissoes.ver' }, async (ctx) => {
  const month = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month + '-01' : null
  const branches = branchScope(ctx, ctx.query.branch)
  const onlyMine = !can(ctx.user, 'vendas.todas')
  const rows = await db.many(
    `SELECT u.id AS seller_id, u.name AS seller, COALESCE(sum(c.base_amount),0) AS base, COALESCE(sum(c.amount),0) AS commission,
            count(*) FILTER (WHERE c.ref_type = 'venda')::int AS sales, count(*) FILTER (WHERE c.ref_type <> 'venda')::int AS reversals
       FROM commissions c JOIN users u ON u.id = c.seller_id
      WHERE c.company_id = $1 AND c.competence = COALESCE($2::date, date_trunc('month', now())::date) AND ($3::uuid[] IS NULL OR c.branch_id = ANY($3::uuid[])) AND ($4::uuid IS NULL OR c.seller_id = $4)
      GROUP BY u.id, u.name ORDER BY commission DESC`, [ctx.user.companyId, month, branches.length ? branches : null, onlyMine ? ctx.user.id : null])
  const goals = await db.many(`SELECT * FROM sales_goals WHERE company_id = $1 AND month = COALESCE($2::date, date_trunc('month', now())::date)`, [ctx.user.companyId, month])
  return rows.map((r) => {
    const g = goals.find((x) => x.seller_id === r.seller_id) || goals.find((x) => !x.seller_id && !x.branch_id)
    const target = g ? Number(g.target_amount) : null
    const pct = target ? r2((Number(r.base) / target) * 100) : null
    const bonus = g && pct !== null && pct >= 100 ? r2(Number(r.base) * Number(g.bonus_pct) / 100) : 0
    return { ...r, target, achievement_pct: pct, bonus }
  })
})

router.get('/api/commissions/details', { perm: 'comissoes.ver' }, async (ctx) => {
  const sellerId = !can(ctx.user, 'vendas.todas') ? ctx.user.id : ctx.query.seller
  const month = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month + '-01' : null
  return db.many(`SELECT c.*, s.number AS sale_number, s.created_at AS sale_date FROM commissions c JOIN sales s ON s.id = c.sale_id
                   WHERE c.company_id = $1 AND ($2::uuid IS NULL OR c.seller_id = $2) AND c.competence = COALESCE($3::date, date_trunc('month', now())::date) ORDER BY c.created_at DESC LIMIT 1000`,
    [ctx.user.companyId, sellerId || null, month])
})

router.get('/api/commission-rules', { perm: 'comissoes.ver' }, async (ctx) =>
  db.many(`SELECT r.*, COALESCE(u.name, b.name, ca.name, co.name) AS ref_name FROM commission_rules r
            LEFT JOIN users u ON r.scope = 'vendedor' AND u.id = r.ref_id LEFT JOIN brands b ON r.scope = 'marca' AND b.id = r.ref_id
            LEFT JOIN categories ca ON r.scope = 'categoria' AND ca.id = r.ref_id LEFT JOIN collections co ON r.scope = 'colecao' AND co.id = r.ref_id
           WHERE r.company_id = $1 ORDER BY r.active DESC, r.priority DESC, r.created_at`, [ctx.user.companyId]))

router.post('/api/commission-rules', { perm: 'comissoes.editar' }, async (ctx) => {
  const b = parse(v.object({ name: v.string({ min: 2, max: 80 }), scope: v.enum(['padrao', 'vendedor', 'categoria', 'marca', 'colecao'] as const), refId: v.uuid().optional(), pct: v.number({ min: 0, max: 100 }), priority: v.int().optional() }), ctx.body)
  if (b.scope !== 'padrao' && !b.refId) throw unprocessable('Selecione a referência da regra.')
  const r = await db.one(`INSERT INTO commission_rules(company_id, name, scope, ref_id, pct, priority) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.user.companyId, b.name, b.scope, b.refId ?? null, b.pct, b.priority ?? 0])
  await audit(null, ctx, 'comissao.regra_criada', 'commission_rule', r.id, b)
  return r
})
router.put('/api/commission-rules/:id', { perm: 'comissoes.editar' }, async (ctx) => {
  const b = parse(v.object({ name: v.string({ min: 2, max: 80 }).optional(), pct: v.number({ min: 0, max: 100 }).optional(), priority: v.int().optional(), active: v.boolean().optional() }), ctx.body)
  const r = await db.one(`UPDATE commission_rules SET name = COALESCE($3,name), pct = COALESCE($4,pct), priority = COALESCE($5,priority), active = COALESCE($6,active) WHERE id = $1 AND company_id = $2 RETURNING *`,
    [ctx.params.id, ctx.user.companyId, b.name ?? null, b.pct ?? null, b.priority ?? null, b.active ?? null])
  if (!r) throw notFound('Regra')
  await audit(null, ctx, 'comissao.regra_alterada', 'commission_rule', r.id, b)
  return r
})

router.get('/api/goals', { perm: 'comissoes.ver' }, async (ctx) => {
  const month = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month + '-01' : null
  return db.many(`SELECT g.*, u.name AS seller, b.name AS branch,
                         COALESCE((SELECT sum(s.total) FROM sales s WHERE s.company_id = g.company_id AND s.type = 'venda' AND s.status NOT IN ('cancelada')
                                    AND date_trunc('month', s.created_at)::date = g.month AND (g.seller_id IS NULL OR s.seller_id = g.seller_id) AND (g.branch_id IS NULL OR s.branch_id = g.branch_id)),0) AS achieved
                    FROM sales_goals g LEFT JOIN users u ON u.id = g.seller_id LEFT JOIN branches b ON b.id = g.branch_id
                   WHERE g.company_id = $1 AND g.month = COALESCE($2::date, date_trunc('month', now())::date) ORDER BY u.name NULLS FIRST`, [ctx.user.companyId, month])
})
router.post('/api/goals', { perm: 'comissoes.editar' }, async (ctx) => {
  const b = parse(v.object({ month: v.string({ pattern: /^\d{4}-\d{2}$/, patternMsg: 'Use AAAA-MM.' }), sellerId: v.uuid().optional(), branchId: v.uuid().optional(), targetAmount: v.money({ min: 1 }), bonusPct: v.number({ min: 0, max: 100 }).optional() }), ctx.body)
  const r = await db.one(
    `INSERT INTO sales_goals(company_id, branch_id, seller_id, month, target_amount, bonus_pct) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (company_id, coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid), coalesce(seller_id,'00000000-0000-0000-0000-000000000000'::uuid), month)
     DO UPDATE SET target_amount = EXCLUDED.target_amount, bonus_pct = EXCLUDED.bonus_pct RETURNING *`,
    [ctx.user.companyId, b.branchId ?? null, b.sellerId ?? null, b.month + '-01', b.targetAmount, b.bonusPct ?? 0])
  await audit(null, ctx, 'meta.definida', 'sales_goal', r.id, b)
  return r
})
router.delete('/api/goals/:id', { perm: 'comissoes.editar' }, async (ctx) => {
  await db.query(`DELETE FROM sales_goals WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  return { ok: true }
})

router.post('/api/commissions/close', { perm: 'comissoes.editar' }, async (ctx) => {
  const b = parse(v.object({ month: v.string({ pattern: /^\d{4}-\d{2}$/ }), status: v.enum(['liberada', 'paga'] as const) }), ctx.body)
  const r = await db.query(`UPDATE commissions SET status = $3 WHERE company_id = $1 AND competence = $2::date AND status <> 'paga'`, [ctx.user.companyId, b.month + '-01', b.status])
  await audit(null, ctx, 'comissao.fechamento', 'commission', null, { ...b, rows: r.rowCount }, 'warning')
  return { updated: r.rowCount }
})
