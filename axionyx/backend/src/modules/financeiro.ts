import { router, audit, paged, Where, branchScope, r2, today, addDays, splitInstallments, can } from '../core/http'
import { db, tx, nextNumber } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden } from '../core/errors'
import { payTitle, reversePayment, chargesFor, createReceivable, addTransaction, BALANCE_SQL, dueDates, systemCategory, defaultAccount } from '../services/finance'
import { crud } from '../core/crud'

// ---------- Contas financeiras e categorias ----------
crud({ table: 'financial_accounts', path: '/api/financial-accounts', entity: 'conta_financeira', label: 'Conta', view: 'financeiro.ver', edit: 'financeiro.editar', softDelete: true, order: 't.type, t.name', json: ['bank'],
  schema: { name: v.string({ min: 2, max: 80 }), type: v.enum(['caixa', 'banco', 'carteira_digital', 'adquirente'] as const), branch_id: v.uuid().optional(),
    bank: v.json().optional(), opening_balance: v.money().optional(), active: v.boolean().optional() } })
crud({ table: 'financial_categories', path: '/api/financial-categories', entity: 'categoria_financeira', label: 'Categoria', view: 'financeiro.ver', edit: 'financeiro.editar', softDelete: true, order: 't.code',
  schema: { code: v.string({ min: 1, max: 20 }), name: v.string({ min: 2, max: 80 }), type: v.enum(['receita', 'despesa'] as const),
    dre_group: v.enum(['receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_pessoal', 'despesas_administrativas', 'despesas_comerciais', 'receitas_financeiras', 'despesas_financeiras', 'outras'] as const), active: v.boolean().optional() } })

router.get('/api/financial-accounts-balances', { perm: 'financeiro.ver' }, async (ctx) =>
  db.many(`SELECT a.id, a.name, a.type, a.opening_balance,
                  a.opening_balance + COALESCE(sum(CASE WHEN t.direction = 'entrada' THEN t.amount ELSE -t.amount END),0) AS balance,
                  COALESCE(sum(t.amount) FILTER (WHERE t.direction = 'entrada' AND t.date >= date_trunc('month', current_date)),0) AS month_in,
                  COALESCE(sum(t.amount) FILTER (WHERE t.direction = 'saida' AND t.date >= date_trunc('month', current_date)),0) AS month_out,
                  count(t.id) FILTER (WHERE NOT t.reconciled)::int AS unreconciled
             FROM financial_accounts a LEFT JOIN financial_transactions t ON t.account_id = a.id
            WHERE a.company_id = $1 AND a.active GROUP BY a.id ORDER BY a.type, a.name`, [ctx.user.companyId]))

// ---------- Visão geral ----------
router.get('/api/finance/overview', { perm: 'financeiro.ver' }, async (ctx) => {
  const id = ctx.user.companyId
  const [rec, pay, cash, aging] = await Promise.all([
    db.one(`SELECT COALESCE(sum(${BALANCE_SQL}),0) AS open, COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE due_date < current_date),0) AS overdue,
                   COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE due_date >= current_date),0) AS to_due, count(*) FILTER (WHERE due_date < current_date)::int AS overdue_count,
                   COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE method_kind = 'crediario'),0) AS crediario,
                   COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE method_kind IN ('cartao_credito','cartao_debito')),0) AS cards
              FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial')`, [id]),
    db.one(`SELECT COALESCE(sum(${BALANCE_SQL}),0) AS open, COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE due_date < current_date),0) AS overdue,
                   COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE due_date >= current_date),0) AS to_due, COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE due_date BETWEEN current_date AND current_date + 7),0) AS next7
              FROM payables WHERE company_id = $1 AND status IN ('aberto','parcial')`, [id]),
    db.one(`SELECT COALESCE(sum(amount) FILTER (WHERE direction = 'entrada'),0) AS inflow, COALESCE(sum(amount) FILTER (WHERE direction = 'saida'),0) AS outflow
              FROM financial_transactions WHERE company_id = $1 AND date >= date_trunc('month', current_date)`, [id]),
    db.many(`SELECT bucket, COALESCE(sum(balance),0) AS total, count(*)::int AS n FROM (
               SELECT ${BALANCE_SQL} AS balance, CASE WHEN current_date - due_date <= 0 THEN 'a_vencer' WHEN current_date - due_date <= 30 THEN '1-30' WHEN current_date - due_date <= 60 THEN '31-60'
                      WHEN current_date - due_date <= 90 THEN '61-90' ELSE '+90' END AS bucket
                 FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial')) x GROUP BY bucket`, [id]),
  ])
  return { receivables: rec, payables: pay, month: { ...cash, balance: r2(Number(cash.inflow) - Number(cash.outflow)) }, aging }
})

// ---------- Títulos a receber ----------
router.get('/api/receivables', { perm: 'financeiro.ver' }, async (ctx) => {
  const q = ctx.query
  const branches = branchScope(ctx, q.branch || 'all')
  const w = new Where([['r.company_id = ?', ctx.user.companyId]])
  if (branches.length) w.add('(r.branch_id = ANY(?::uuid[]) OR r.branch_id IS NULL)', branches)
  if (q.status === 'vencido') w.add(`r.status IN ('aberto','parcial') AND r.due_date < current_date`)
  else if (q.status === 'em_aberto') w.add(`r.status IN ('aberto','parcial')`)
  else w.addIf(q.status, 'r.status = ?', q.status)
  w.addIf(q.kind, 'r.method_kind = ?', q.kind).addIf(q.customer, 'r.customer_id = ?', q.customer).addIf(q.sale, 'r.sale_id = ?', q.sale)
    .addIf(q.from, 'r.due_date >= ?', q.from).addIf(q.to, 'r.due_date <= ?', q.to)
  if (q.q) w.add('(r.document ILIKE ? OR cu.name ILIKE ?)', `%${q.q}%`, `%${q.q}%`)
  const sql = `SELECT r.*, ${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'r.$1')} AS balance, cu.name AS customer, cu.whatsapp, pm.name AS method,
                      GREATEST(0, current_date - r.due_date) AS days_late
                 FROM receivables r LEFT JOIN customers cu ON cu.id = r.customer_id LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id ${w.sql}
                ORDER BY ${q.sort === 'recentes' ? 'r.created_at DESC' : 'r.due_date, r.document, r.installment_no'}`
  const res = await paged(db, sql, w.params, q, 50)
  const totals = await db.one(`SELECT COALESCE(sum(amount),0) AS amount, COALESCE(sum(balance),0) AS balance, COALESCE(sum(balance) FILTER (WHERE due_date < current_date AND status IN ('aberto','parcial')),0) AS overdue,
                                      COALESCE(sum(paid_amount),0) AS paid, count(*)::int AS n FROM (${sql}) t`, w.params)
  return { ...res, totals }
})

router.get('/api/receivables/:id', { perm: 'financeiro.ver' }, async (ctx) => {
  const r = await db.one(`SELECT r.*, ${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'r.$1')} AS balance, cu.name AS customer, s.number AS sale_number
                            FROM receivables r LEFT JOIN customers cu ON cu.id = r.customer_id LEFT JOIN sales s ON s.id = r.sale_id WHERE r.id = $1 AND r.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!r) throw notFound('Título')
  r.payments = await db.many(`SELECT p.*, u.name AS user_name, a.name AS account FROM title_payments p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN financial_accounts a ON a.id = p.account_id WHERE p.title_type = 'receber' AND p.title_id = $1 ORDER BY p.created_at`, [r.id])
  r.charges = await chargesFor(db, ctx.user.companyId, { due_date: r.due_date, balance: Number(r.balance) })
  r.audit = await db.many(`SELECT action, user_name, created_at, data FROM audit_log WHERE entity = 'receivable' AND entity_id = $1 ORDER BY created_at`, [r.id])
  return r
})

router.get('/api/receivables/:id/quote', { perm: 'financeiro.ver' }, async (ctx) => {
  const r = await db.one(`SELECT due_date, ${BALANCE_SQL} AS balance, method_kind FROM receivables WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!r) throw notFound('Título')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date || '') ? ctx.query.date : today()
  const ch = r.method_kind === 'crediario' || r.method_kind === 'a_prazo' ? await chargesFor(db, ctx.user.companyId, { due_date: r.due_date, balance: Number(r.balance) }, date) : { daysLate: 0, fine: 0, interest: 0 }
  return { balance: Number(r.balance), ...ch, total: r2(Number(r.balance) + ch.fine + ch.interest) }
})

router.post('/api/receivables', { perm: 'financeiro.editar' }, async (ctx) => {
  const b = parse(v.object({ customerId: v.uuid().optional(), document: v.string({ min: 1, max: 40 }), description: v.string({ max: 300 }).optional(), categoryId: v.uuid().optional(),
    amount: v.money({ min: 0.01 }), installments: v.int({ min: 1, max: 60 }).default(1), firstDue: v.date(), methodKind: v.enum(['boleto', 'crediario', 'a_prazo', 'outro'] as const).default('outro') }), ctx.body)
  return tx(async (c) => {
    const parts = splitInstallments(b.amount, b.installments)
    const dates = dueDates(b.firstDue, b.installments)
    const ref = (await c.one(`SELECT gen_random_uuid() AS id`)).id
    const ids: string[] = []
    for (let i = 0; i < b.installments; i++) ids.push(await createReceivable(c, { companyId: ctx.user.companyId, branchId: ctx.user.branchId, customerId: b.customerId, sourceType: 'manual', sourceId: ref,
      document: b.document, installmentNo: i + 1, installmentsTotal: b.installments, methodKind: b.methodKind, categoryId: b.categoryId, dueDate: dates[i], amount: parts[i], description: b.description, userId: ctx.user.id }))
    await audit(c, ctx, 'receber.criado', 'receivable', ids[0], b)
    return { ids }
  })
})

router.post('/api/receivables/:id/pay', { perm: 'financeiro.baixar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ amount: v.money({ min: 0.01 }), interest: v.money({ min: 0 }).optional(), fine: v.money({ min: 0 }).optional(), discount: v.money({ min: 0 }).optional(),
    date: v.date().optional(), accountId: v.uuid().optional(), method: v.string({ max: 40 }).optional(), notes: v.string({ max: 300 }).optional() }), ctx.body)
  return tx(async (c) => {
    // descontos e dispensa de encargos sugeridos exigem permissão de renegociação
    const t = await c.one(`SELECT due_date, ${BALANCE_SQL} AS balance, method_kind FROM receivables WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!t) throw notFound('Título')
    if ((b.discount ?? 0) > 0 && !can(ctx.user, 'financeiro.renegociar')) throw forbidden('Conceder desconto requer permissão de renegociação.')
    if (t.method_kind === 'crediario') {
      const sug = await chargesFor(c, ctx.user.companyId, { due_date: t.due_date, balance: Number(t.balance) }, b.date || today())
      if (((b.interest ?? 0) < sug.interest - 0.009 || (b.fine ?? 0) < sug.fine - 0.009) && !can(ctx.user, 'financeiro.renegociar'))
        throw forbidden(`Juros (R$ ${sug.interest.toFixed(2)}) e multa (R$ ${sug.fine.toFixed(2)}) são devidos. Dispensa requer permissão de renegociação.`)
    }
    // recebimento em dinheiro no caixa aberto
    if (b.method === 'dinheiro') {
      const s = await c.one(`SELECT cs.id, cr.account_id FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.register_id WHERE cs.company_id = $1 AND cs.branch_id = $2 AND cs.status = 'aberto' ORDER BY (cs.opened_by = $3) DESC LIMIT 1`, [ctx.user.companyId, ctx.user.branchId, ctx.user.id])
      if (!s) throw conflict('Abra o caixa para receber em dinheiro.')
      b.accountId = b.accountId || s.account_id
      const pay = await payTitle(c, 'receber', ctx.user.companyId, ctx.params.id, { ...b, idempotencyKey: ctx.idemKey }, ctx.user)
      await c.query(`INSERT INTO cash_movements(company_id, session_id, type, amount, ref_type, ref_id, user_id, notes) VALUES ($1,$2,'recebimento',$3,'title_payment',$4,$5,'Recebimento de título')`, [ctx.user.companyId, s.id, b.amount, pay.id, ctx.user.id])
      await audit(c, ctx, 'receber.baixa', 'receivable', ctx.params.id, b, (b.discount ?? 0) > 0 ? 'warning' : 'info')
      return pay
    }
    const pay = await payTitle(c, 'receber', ctx.user.companyId, ctx.params.id, { ...b, idempotencyKey: ctx.idemKey }, ctx.user)
    await audit(c, ctx, 'receber.baixa', 'receivable', ctx.params.id, b, (b.discount ?? 0) > 0 ? 'warning' : 'info')
    return pay
  })
})

router.post('/api/title-payments/:id/reverse', { perm: 'financeiro.baixar' }, async (ctx) => {
  const b = parse(v.object({ reason: v.string({ min: 5, max: 300 }) }), ctx.body)
  return tx(async (c) => {
    const p = await c.one(`SELECT title_type, title_id FROM title_payments WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!p) throw notFound('Pagamento')
    const r = await reversePayment(c, ctx.user.companyId, ctx.params.id, ctx.user.id)
    await audit(c, ctx, 'titulo.estorno_baixa', p.title_type === 'receber' ? 'receivable' : 'payable', p.title_id, { paymentId: ctx.params.id, reason: b.reason }, 'warning')
    return r
  })
})

router.post('/api/receivables/:id/cancel', { perm: 'financeiro.editar' }, async (ctx) => {
  const b = parse(v.object({ reason: v.string({ min: 5, max: 300 }) }), ctx.body)
  const r = await db.one(`UPDATE receivables SET status = 'cancelado', description = COALESCE(description,'') || $3, updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'aberto' AND paid_amount = 0 RETURNING id`,
    [ctx.params.id, ctx.user.companyId, ` | Cancelado: ${b.reason}`])
  if (!r) throw conflict('Somente títulos em aberto e sem pagamentos podem ser cancelados.')
  await audit(null, ctx, 'receber.cancelado', 'receivable', r.id, b, 'warning')
  return { ok: true }
})

/** Baixa em lote de recebíveis de cartão (liquidação da adquirente), com lançamento da taxa. */
router.post('/api/receivables/settle-cards', { perm: 'financeiro.baixar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ ids: v.array(v.uuid(), { min: 1, max: 500 }), date: v.date().optional(), accountId: v.uuid().optional() }), ctx.body)
  return tx(async (c) => {
    let total = 0, fees = 0
    const acc = b.accountId || (await defaultAccount(c, ctx.user.companyId, null, 'banco'))
    for (const id of b.ids) {
      const t = await c.one(`SELECT *, ${BALANCE_SQL} AS balance FROM receivables WHERE id = $1 AND company_id = $2 AND method_kind IN ('cartao_credito','cartao_debito') AND status IN ('aberto','parcial')`, [id, ctx.user.companyId])
      if (!t) continue
      const fee = r2(Number(t.fee_amount))
      const net = r2(Number(t.balance) - fee)
      await payTitle(c, 'receber', ctx.user.companyId, id, { amount: net, discount: fee, date: b.date, accountId: acc, method: 'liquidacao_cartao', notes: 'Liquidação adquirente', idempotencyKey: `${ctx.idemKey}:${id}` }, ctx.user)
      if (fee > 0) {
        // taxa como despesa financeira (o desconto no título representa a retenção da adquirente)
        await c.query(`INSERT INTO payables(company_id, branch_id, source_type, source_id, document, category_id, account_id, due_date, amount, paid_amount, status, description, created_by, paid_at)
                       VALUES ($1,$2,'taxa_cartao',$3,$4,$5,$6,COALESCE($7::date,current_date),$8,$8,'pago','Taxa retida pela adquirente',$9,now()) ON CONFLICT DO NOTHING`,
          [ctx.user.companyId, t.branch_id, id, t.document, await systemCategory(c, ctx.user.companyId, 'taxa_cartao'), acc, b.date ?? null, fee, ctx.user.id])
      }
      total += net; fees += fee
    }
    await audit(c, ctx, 'receber.liquidacao_cartoes', 'receivable', null, { count: b.ids.length, net: r2(total), fees: r2(fees) })
    return { settled: b.ids.length, net: r2(total), fees: r2(fees) }
  })
})

/** Renegociação de crediário: substitui títulos em aberto por novo parcelamento (trilha completa). */
router.post('/api/receivables/renegotiate', { perm: 'financeiro.renegociar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ customerId: v.uuid(), ids: v.array(v.uuid(), { min: 1 }), interest: v.money({ min: 0 }).default(0), discount: v.money({ min: 0 }).default(0),
    installments: v.int({ min: 1, max: 36 }), firstDue: v.date(), notes: v.string({ max: 500 }).optional() }), ctx.body)
  return tx(async (c) => {
    const titles = await c.many(`SELECT *, ${BALANCE_SQL} AS balance FROM receivables WHERE company_id = $1 AND customer_id = $2 AND id = ANY($3::uuid[]) AND status IN ('aberto','parcial') FOR UPDATE`,
      [ctx.user.companyId, b.customerId, b.ids])
    if (titles.length !== b.ids.length) throw unprocessable('Há títulos inválidos, de outro cliente ou já quitados na seleção.')
    const original = r2(titles.reduce((s, t) => s + Number(t.balance), 0))
    const newTotal = r2(original + b.interest - b.discount)
    if (newTotal <= 0) throw unprocessable('Valor renegociado deve ser maior que zero.')
    const number = await nextNumber(c, ctx.user.companyId, 'renegociacao')
    const rn = await c.one(`INSERT INTO renegotiations(company_id, customer_id, number, original_ids, original_balance, interest, discount, new_total, installments, first_due_date, notes, created_by)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ctx.user.companyId, b.customerId, number, b.ids, original, b.interest, b.discount, newTotal, b.installments, b.firstDue, b.notes ?? null, ctx.user.id])
    await c.query(`UPDATE receivables SET status = 'renegociado', renegotiation_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])`, [b.ids, rn.id])
    const parts = splitInstallments(newTotal, b.installments)
    const dates = dueDates(b.firstDue, b.installments)
    for (let i = 0; i < b.installments; i++) await createReceivable(c, { companyId: ctx.user.companyId, branchId: ctx.user.branchId, customerId: b.customerId, sourceType: 'renegociacao', sourceId: rn.id,
      document: `RN${number}`, installmentNo: i + 1, installmentsTotal: b.installments, methodKind: 'crediario', categoryId: await systemCategory(c, ctx.user.companyId, 'recebimento_crediario'),
      dueDate: dates[i], amount: parts[i], description: `Renegociação nº ${number}`, userId: ctx.user.id, renegotiationId: rn.id })
    await audit(c, ctx, 'crediario.renegociacao', 'renegotiation', rn.id, { number, original, interest: b.interest, discount: b.discount, newTotal, installments: b.installments, titles: b.ids.length }, 'critical')
    return rn
  })
})

/** Dados do carnê (venda ou renegociação) para impressão. */
router.get('/api/receivables-carne', { perm: ['financeiro.ver', 'vendas.criar'] }, async (ctx) => {
  const { sale, renegotiation } = ctx.query
  if (!sale && !renegotiation) throw unprocessable('Informe a venda ou a renegociação.')
  const titles = await db.many(`SELECT r.id, r.document, r.installment_no, r.installments_total, r.due_date, r.amount, r.status, ${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'r.$1')} AS balance
                                  FROM receivables r WHERE r.company_id = $1 AND r.method_kind = 'crediario' AND ${sale ? 'r.sale_id = $2' : 'r.renegotiation_id = $2 AND r.source_type = \'renegociacao\''} ORDER BY r.installment_no`,
    [ctx.user.companyId, sale || renegotiation])
  if (!titles.length) throw notFound('Parcelas de crediário')
  const first = await db.one(`SELECT r.customer_id FROM receivables r WHERE r.id = $1`, [titles[0].id])
  const customer = await db.one(`SELECT name, cpf_cnpj, address, phone FROM customers WHERE id = $1`, [first.customer_id])
  const company = await db.one(`SELECT c.name, c.trade_name, c.cnpj, c.phone, b.address, b.name AS branch FROM companies c JOIN branches b ON b.id = $2 WHERE c.id = $1`, [ctx.user.companyId, ctx.user.branchId])
  const settings = (await db.one(`SELECT settings FROM companies WHERE id = $1`, [ctx.user.companyId])).settings?.crediario || {}
  return { company, customer, titles, rules: { jurosMensalPct: settings.jurosMensalPct ?? 2, multaPct: settings.multaPct ?? 2 } }
})

// ---------- Contas a pagar ----------
router.get('/api/payables', { perm: 'financeiro.ver' }, async (ctx) => {
  const q = ctx.query
  const w = new Where([['p.company_id = ?', ctx.user.companyId]])
  if (q.status === 'vencido') w.add(`p.status IN ('aberto','parcial') AND p.due_date < current_date`)
  else if (q.status === 'em_aberto') w.add(`p.status IN ('aberto','parcial')`)
  else w.addIf(q.status, 'p.status = ?', q.status)
  w.addIf(q.supplier, 'p.supplier_id = ?', q.supplier).addIf(q.category, 'p.category_id = ?', q.category).addIf(q.from, 'p.due_date >= ?', q.from).addIf(q.to, 'p.due_date <= ?', q.to)
  if (q.q) w.add('(p.document ILIKE ? OR s.name ILIKE ? OR p.description ILIKE ?)', `%${q.q}%`, `%${q.q}%`, `%${q.q}%`)
  const sql = `SELECT p.*, ${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'p.$1')} AS balance, s.name AS supplier, fc.name AS category, GREATEST(0, current_date - p.due_date) AS days_late
                 FROM payables p LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN financial_categories fc ON fc.id = p.category_id ${w.sql} ORDER BY p.due_date, p.document`
  const res = await paged(db, sql, w.params, q, 50)
  const totals = await db.one(`SELECT COALESCE(sum(amount),0) AS amount, COALESCE(sum(balance),0) AS balance, COALESCE(sum(balance) FILTER (WHERE due_date < current_date AND status IN ('aberto','parcial')),0) AS overdue,
                                      COALESCE(sum(balance) FILTER (WHERE due_date >= current_date AND status IN ('aberto','parcial')),0) AS to_due, count(*)::int AS n FROM (${sql}) t`, w.params)
  return { ...res, totals }
})

router.get('/api/payables/:id', { perm: 'financeiro.ver' }, async (ctx) => {
  const p = await db.one(`SELECT p.*, ${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'p.$1')} AS balance, s.name AS supplier FROM payables p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1 AND p.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!p) throw notFound('Título')
  p.payments = await db.many(`SELECT tp.*, u.name AS user_name FROM title_payments tp LEFT JOIN users u ON u.id = tp.user_id WHERE tp.title_type = 'pagar' AND tp.title_id = $1 ORDER BY tp.created_at`, [p.id])
  return p
})

router.post('/api/payables', { perm: 'financeiro.editar' }, async (ctx) => {
  const b = parse(v.object({ supplierId: v.uuid().optional(), document: v.string({ min: 1, max: 40 }), description: v.string({ max: 300 }).optional(), categoryId: v.uuid(),
    accountId: v.uuid().optional(), amount: v.money({ min: 0.01 }), installments: v.int({ min: 1, max: 60 }).default(1), firstDue: v.date(), recurrence: v.enum(['mensal', 'unica'] as const).default('unica') }), ctx.body)
  return tx(async (c) => {
    const n = b.installments
    const parts = b.recurrence === 'mensal' ? Array(n).fill(b.amount) : splitInstallments(b.amount, n)
    const dates = dueDates(b.firstDue, n)
    const ref = (await c.one(`SELECT gen_random_uuid() AS id`)).id
    for (let i = 0; i < n; i++)
      await c.query(`INSERT INTO payables(company_id, branch_id, supplier_id, source_type, source_id, document, installment_no, installments_total, category_id, account_id, due_date, amount, description, created_by)
                     VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [ctx.user.companyId, ctx.user.branchId, b.supplierId ?? null, ref, b.document, i + 1, n, b.categoryId, b.accountId ?? null, dates[i], parts[i], b.description ?? null, ctx.user.id])
    await audit(c, ctx, 'pagar.criado', 'payable', ref, b)
    return { ok: true, installments: n }
  })
})

router.post('/api/payables/:id/pay', { perm: 'financeiro.baixar', idempotent: true }, async (ctx) => {
  const b = parse(v.object({ amount: v.money({ min: 0.01 }), interest: v.money({ min: 0 }).optional(), fine: v.money({ min: 0 }).optional(), discount: v.money({ min: 0 }).optional(),
    date: v.date().optional(), accountId: v.uuid().optional(), method: v.string({ max: 40 }).optional(), notes: v.string({ max: 300 }).optional() }), ctx.body)
  return tx(async (c) => {
    const pay = await payTitle(c, 'pagar', ctx.user.companyId, ctx.params.id, { ...b, idempotencyKey: ctx.idemKey }, ctx.user)
    await audit(c, ctx, 'pagar.baixa', 'payable', ctx.params.id, b)
    return pay
  })
})

router.post('/api/payables/:id/cancel', { perm: 'financeiro.editar' }, async (ctx) => {
  const b = parse(v.object({ reason: v.string({ min: 5, max: 300 }) }), ctx.body)
  const r = await db.one(`UPDATE payables SET status = 'cancelado', description = COALESCE(description,'') || $3, updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'aberto' AND paid_amount = 0 RETURNING id`,
    [ctx.params.id, ctx.user.companyId, ` | Cancelado: ${b.reason}`])
  if (!r) throw conflict('Somente títulos em aberto e sem pagamentos podem ser cancelados.')
  await audit(null, ctx, 'pagar.cancelado', 'payable', r.id, b, 'warning')
  return { ok: true }
})

// ---------- Movimentações e fluxo de caixa ----------
router.get('/api/transactions', { perm: 'financeiro.ver' }, async (ctx) => {
  const q = ctx.query
  const w = new Where([['t.company_id = ?', ctx.user.companyId]])
  w.addIf(q.account, 't.account_id = ?', q.account).addIf(q.from, 't.date >= ?', q.from).addIf(q.to, 't.date <= ?', q.to).addIf(q.direction, 't.direction = ?', q.direction).addIf(q.category, 't.category_id = ?', q.category)
  if (q.reconciled) w.add('t.reconciled = ?', q.reconciled === 'true')
  if (q.q) w.add('t.description ILIKE ?', `%${q.q}%`)
  const sql = `SELECT t.*, a.name AS account, fc.name AS category, u.name AS user_name FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id
                 LEFT JOIN financial_categories fc ON fc.id = t.category_id LEFT JOIN users u ON u.id = t.created_by ${w.sql} ORDER BY t.date DESC, t.created_at DESC`
  const res = await paged(db, sql, w.params, q, 50)
  const totals = await db.one(`SELECT COALESCE(sum(amount) FILTER (WHERE direction='entrada'),0) AS inflow, COALESCE(sum(amount) FILTER (WHERE direction='saida'),0) AS outflow FROM (${sql}) x`, w.params)
  return { ...res, totals }
})

router.post('/api/transactions', { perm: 'financeiro.editar' }, async (ctx) => {
  const b = parse(v.object({ accountId: v.uuid(), direction: v.enum(['entrada', 'saida'] as const), amount: v.money({ min: 0.01 }), date: v.date().optional(), description: v.string({ min: 3, max: 200 }), categoryId: v.uuid().optional() }), ctx.body)
  const id = await addTransaction(db, { companyId: ctx.user.companyId, branchId: ctx.user.branchId, accountId: b.accountId, direction: b.direction, amount: b.amount, date: b.date, description: b.description, categoryId: b.categoryId, sourceType: 'manual', userId: ctx.user.id })
  await audit(null, ctx, 'financeiro.lancamento_manual', 'transaction', id, b, 'warning')
  return { id }
})

router.post('/api/transactions/transfer', { perm: 'financeiro.editar' }, async (ctx) => {
  const b = parse(v.object({ fromAccountId: v.uuid(), toAccountId: v.uuid(), amount: v.money({ min: 0.01 }), date: v.date().optional(), description: v.string({ max: 200 }).optional() }), ctx.body)
  if (b.fromAccountId === b.toAccountId) throw unprocessable('Contas de origem e destino devem ser diferentes.')
  return tx(async (c) => {
    const ref = (await c.one(`SELECT gen_random_uuid() AS id`)).id
    await addTransaction(c, { companyId: ctx.user.companyId, accountId: b.fromAccountId, direction: 'saida', amount: b.amount, date: b.date, description: b.description || 'Transferência entre contas', sourceType: 'transferencia', sourceId: ref, sourceSeq: 1, userId: ctx.user.id })
    await addTransaction(c, { companyId: ctx.user.companyId, accountId: b.toAccountId, direction: 'entrada', amount: b.amount, date: b.date, description: b.description || 'Transferência entre contas', sourceType: 'transferencia', sourceId: ref, sourceSeq: 2, userId: ctx.user.id })
    await audit(c, ctx, 'financeiro.transferencia', 'transaction', ref, b)
    return { ok: true }
  })
})

/** Fluxo de caixa: realizado (movimentos) + previsto (títulos em aberto por vencimento). */
router.get('/api/cashflow', { perm: 'financeiro.ver' }, async (ctx) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.from || '') ? ctx.query.from : addDays(today(), -30)
  const to = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.to || '') ? ctx.query.to : addDays(today(), 60)
  const group = ['day', 'week', 'month'].includes(ctx.query.group) ? ctx.query.group : 'week'
  const id = ctx.user.companyId
  const opening = await db.one(`SELECT COALESCE((SELECT sum(opening_balance) FROM financial_accounts WHERE company_id = $1 AND active),0)
                                   + COALESCE((SELECT sum(CASE WHEN direction='entrada' THEN amount ELSE -amount END) FROM financial_transactions WHERE company_id = $1 AND date < $2),0) AS v`, [id, from])
  const rows = await db.many(`
    WITH real AS (
      SELECT date_trunc($4, date)::date AS period, sum(amount) FILTER (WHERE direction='entrada') AS inflow, sum(amount) FILTER (WHERE direction='saida') AS outflow
        FROM financial_transactions WHERE company_id = $1 AND date BETWEEN $2 AND LEAST($3::date, current_date) GROUP BY 1),
    prev_in AS (SELECT date_trunc($4, GREATEST(due_date, current_date))::date AS period, sum(${BALANCE_SQL} - fee_amount) AS v FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date <= $3 GROUP BY 1),
    prev_out AS (SELECT date_trunc($4, GREATEST(due_date, current_date))::date AS period, sum(${BALANCE_SQL}) AS v FROM payables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date <= $3 GROUP BY 1),
    periods AS (SELECT DISTINCT period FROM (SELECT period FROM real UNION SELECT period FROM prev_in UNION SELECT period FROM prev_out) p WHERE period >= date_trunc($4, $2::date))
    SELECT p.period, COALESCE(r.inflow,0) AS inflow, COALESCE(r.outflow,0) AS outflow, COALESCE(pi.v,0) AS projected_in, COALESCE(po.v,0) AS projected_out
      FROM periods p LEFT JOIN real r ON r.period = p.period LEFT JOIN prev_in pi ON pi.period = p.period LEFT JOIN prev_out po ON po.period = p.period ORDER BY p.period`,
    [id, from, to, group])
  let bal = Number(opening.v)
  const series = rows.map((r) => { bal = r2(bal + Number(r.inflow) - Number(r.outflow) + Number(r.projected_in) - Number(r.projected_out)); return { ...r, balance: bal } })
  return { opening: Number(opening.v), from, to, group, series }
})

// ---------- Conciliação bancária ----------
function parseStatement(content: string): { date: string; description: string; amount: number; fitId: string }[] {
  const out: { date: string; description: string; amount: number; fitId: string }[] = []
  if (/<OFX>/i.test(content)) {
    const blocks = content.split(/<STMTTRN>/i).slice(1)
    for (const blk of blocks) {
      const tag = (t: string) => (blk.match(new RegExp(`<${t}>([^<\\r\\n]+)`, 'i'))?.[1] ?? '').trim()
      const d = tag('DTPOSTED')
      const amount = parseFloat(tag('TRNAMT').replace(',', '.'))
      if (!d || !Number.isFinite(amount)) continue
      out.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, description: tag('MEMO') || tag('NAME') || 'Lançamento', amount, fitId: tag('FITID') || `${d}-${amount}-${out.length}` })
    }
    return out
  }
  // CSV: data;descrição;valor (data em DD/MM/AAAA ou AAAA-MM-DD)
  for (const [i, line] of content.split(/\r?\n/).entries()) {
    const cols = line.split(/[;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''))
    if (cols.length < 3) continue
    let d = cols[0]
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) d = `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    const amount = parseFloat(cols[2].replace(/\./g, '').replace(',', '.'))
    if (!Number.isFinite(amount)) continue
    out.push({ date: d, description: cols[1], amount, fitId: cols[3] || `csv-${d}-${amount}-${i}` })
  }
  return out
}

router.post('/api/reconciliation/:accountId/import', { perm: 'financeiro.conciliar', maxBody: 5_000_000 }, async (ctx) => {
  const acc = await db.one(`SELECT id FROM financial_accounts WHERE id = $1 AND company_id = $2`, [ctx.params.accountId, ctx.user.companyId])
  if (!acc) throw notFound('Conta')
  const content = ctx.body?.content ? String(ctx.body.content) : ctx.rawBody.toString('utf8')
  const lines = parseStatement(content)
  if (!lines.length) throw unprocessable('Nenhum lançamento reconhecido. Envie OFX ou CSV (data;descrição;valor).')
  let imported = 0
  for (const l of lines) {
    const r = await db.query(`INSERT INTO bank_statement_lines(company_id, account_id, date, description, amount, fit_id, imported_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (account_id, fit_id) DO NOTHING`,
      [ctx.user.companyId, acc.id, l.date, l.description.slice(0, 300), r2(l.amount), l.fitId, ctx.user.id])
    imported += r.rowCount || 0
  }
  const auto = await autoMatch(ctx.user.companyId, acc.id)
  await audit(null, ctx, 'conciliacao.importacao', 'account', acc.id, { lines: lines.length, imported, autoMatched: auto })
  return { lines: lines.length, imported, duplicates: lines.length - imported, autoMatched: auto }
})

async function autoMatch(companyId: string, accountId: string) {
  return tx(async (c) => {
    const lines = await c.many(`SELECT * FROM bank_statement_lines WHERE account_id = $1 AND matched_transaction_id IS NULL ORDER BY date`, [accountId])
    let n = 0
    for (const l of lines) {
      const dir = Number(l.amount) >= 0 ? 'entrada' : 'saida'
      const t = await c.one(`SELECT id FROM financial_transactions WHERE company_id = $1 AND account_id = $2 AND NOT reconciled AND direction = $3 AND amount = $4 AND date BETWEEN $5::date - 3 AND $5::date + 3
                              ORDER BY abs(date - $5::date) LIMIT 1 FOR UPDATE SKIP LOCKED`, [companyId, accountId, dir, Math.abs(Number(l.amount)), l.date])
      if (!t) continue
      await c.query(`UPDATE financial_transactions SET reconciled = true, statement_line_id = $2 WHERE id = $1`, [t.id, l.id])
      await c.query(`UPDATE bank_statement_lines SET matched_transaction_id = $2 WHERE id = $1`, [l.id, t.id])
      n++
    }
    return n
  })
}

router.get('/api/reconciliation/:accountId', { perm: 'financeiro.conciliar' }, async (ctx) => {
  const from = ctx.query.from || addDays(today(), -60), to = ctx.query.to || today()
  const lines = await db.many(`SELECT l.*, t.description AS matched_description FROM bank_statement_lines l LEFT JOIN financial_transactions t ON t.id = l.matched_transaction_id
                                WHERE l.account_id = $1 AND l.company_id = $2 AND l.date BETWEEN $3 AND $4 ORDER BY l.date DESC, l.id DESC`, [ctx.params.accountId, ctx.user.companyId, from, to])
  const pending = await db.many(`SELECT id, date, description, direction, amount FROM financial_transactions WHERE account_id = $1 AND company_id = $2 AND NOT reconciled AND date BETWEEN $3::date - 10 AND $4 ORDER BY date DESC`,
    [ctx.params.accountId, ctx.user.companyId, from, to])
  const summary = await db.one(`SELECT COALESCE(sum(amount),0) AS statement_total, count(*) FILTER (WHERE matched_transaction_id IS NULL)::int AS unmatched FROM bank_statement_lines WHERE account_id = $1 AND date BETWEEN $2 AND $3`, [ctx.params.accountId, from, to])
  return { lines, pending, summary }
})

router.post('/api/reconciliation/match', { perm: 'financeiro.conciliar' }, async (ctx) => {
  const b = parse(v.object({ lineId: v.int(), transactionId: v.uuid().optional(), createTransaction: v.object({ categoryId: v.uuid().optional(), description: v.string({ max: 200 }).optional() }).optional() }), ctx.body)
  return tx(async (c) => {
    const l = await c.one(`SELECT * FROM bank_statement_lines WHERE id = $1 AND company_id = $2 FOR UPDATE`, [b.lineId, ctx.user.companyId])
    if (!l) throw notFound('Lançamento do extrato')
    if (l.matched_transaction_id) throw conflict('Lançamento já conciliado.')
    let txId = b.transactionId
    if (!txId && b.createTransaction) {
      txId = await addTransaction(c, { companyId: ctx.user.companyId, accountId: l.account_id, direction: Number(l.amount) >= 0 ? 'entrada' : 'saida', amount: Math.abs(Number(l.amount)), date: l.date,
        description: b.createTransaction.description || l.description, categoryId: b.createTransaction.categoryId, sourceType: 'extrato', sourceId: null as any, userId: ctx.user.id })
    }
    if (!txId) throw unprocessable('Informe o movimento a conciliar ou crie um novo.')
    const t = await c.one(`SELECT * FROM financial_transactions WHERE id = $1 AND company_id = $2 AND account_id = $3 FOR UPDATE`, [txId, ctx.user.companyId, l.account_id])
    if (!t) throw unprocessable('Movimento inválido para esta conta.')
    if (t.reconciled) throw conflict('Movimento já conciliado.')
    await c.query(`UPDATE financial_transactions SET reconciled = true, statement_line_id = $2 WHERE id = $1`, [txId, l.id])
    await c.query(`UPDATE bank_statement_lines SET matched_transaction_id = $2 WHERE id = $1`, [l.id, txId])
    await audit(c, ctx, 'conciliacao.manual', 'transaction', txId!, { lineId: l.id })
    return { ok: true }
  })
})

router.post('/api/reconciliation/unmatch', { perm: 'financeiro.conciliar' }, async (ctx) => {
  const b = parse(v.object({ lineId: v.int() }), ctx.body)
  return tx(async (c) => {
    const l = await c.one(`SELECT * FROM bank_statement_lines WHERE id = $1 AND company_id = $2 FOR UPDATE`, [b.lineId, ctx.user.companyId])
    if (!l?.matched_transaction_id) throw conflict('Lançamento não está conciliado.')
    await c.query(`UPDATE financial_transactions SET reconciled = false, statement_line_id = NULL WHERE id = $1`, [l.matched_transaction_id])
    await c.query(`UPDATE bank_statement_lines SET matched_transaction_id = NULL WHERE id = $1`, [l.id])
    await audit(c, ctx, 'conciliacao.desfeita', 'transaction', l.matched_transaction_id, { lineId: l.id }, 'warning')
    return { ok: true }
  })
})

/** Recebíveis por forma de pagamento (cartões a liquidar, crediário, etc.). */
router.get('/api/receivables-by-method', { perm: 'financeiro.ver' }, async (ctx) =>
  db.many(`SELECT r.method_kind, pm.name AS method, count(*)::int AS titles, COALESCE(sum(${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'r.$1')}),0) AS balance,
                  COALESCE(sum(r.fee_amount),0) AS fees, min(r.due_date) AS next_due,
                  COALESCE(sum(${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'r.$1')}) FILTER (WHERE r.due_date < current_date),0) AS overdue
             FROM receivables r LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id
            WHERE r.company_id = $1 AND r.status IN ('aberto','parcial') GROUP BY r.method_kind, pm.name ORDER BY balance DESC`, [ctx.user.companyId]))
