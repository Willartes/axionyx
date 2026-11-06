import { router, audit, paged, Where } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound } from '../core/errors'
import { loyaltyBalance, adjustCashback, expireCashback } from '../services/loyalty'
import { getSettings } from '../services/settings'

router.get('/api/loyalty/overview', { perm: 'fidelidade.ver' }, async (ctx) => {
  const id = ctx.user.companyId
  const settings = (await getSettings(db, id)).fidelidade
  const totals = await db.one(`
    SELECT COALESCE(sum(remaining) FILTER (WHERE remaining > 0 AND (expires_at IS NULL OR expires_at >= current_date)),0) AS liability,
           COALESCE(sum(amount) FILTER (WHERE kind = 'credito' AND created_at >= date_trunc('month', now())),0) AS earned_month,
           COALESCE(-sum(amount) FILTER (WHERE kind = 'resgate' AND created_at >= date_trunc('month', now())),0) AS redeemed_month,
           COALESCE(-sum(amount) FILTER (WHERE kind = 'expiracao' AND created_at >= date_trunc('month', now())),0) AS expired_month,
           COALESCE(sum(remaining) FILTER (WHERE remaining > 0 AND expires_at BETWEEN current_date AND current_date + 15),0) AS expiring_15d,
           count(DISTINCT customer_id) FILTER (WHERE remaining > 0)::int AS customers_with_balance
      FROM loyalty_ledger WHERE company_id = $1`, [id])
  return { settings, totals }
})

router.get('/api/loyalty/customers', { perm: 'fidelidade.ver' }, async (ctx) => {
  const w = new Where([['c.company_id = ?', ctx.user.companyId], ['c.anonymized_at IS NULL']])
  if (ctx.query.q) w.add('(c.name ILIKE ? OR c.cpf_cnpj LIKE ?)', `%${ctx.query.q}%`, `%${ctx.query.q.replace(/\D/g, '')}%`)
  return paged(db, `
    SELECT c.id, c.code, c.name, c.whatsapp,
           COALESCE(sum(l.remaining) FILTER (WHERE l.remaining > 0 AND (l.expires_at IS NULL OR l.expires_at >= current_date)),0) AS balance,
           min(l.expires_at) FILTER (WHERE l.remaining > 0 AND l.expires_at >= current_date) AS next_expiry,
           COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'credito'),0) AS total_earned, COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'resgate'),0) AS total_redeemed
      FROM customers c JOIN loyalty_ledger l ON l.customer_id = c.id ${w.sql} GROUP BY c.id ORDER BY balance DESC`, w.params, ctx.query)
})

router.get('/api/loyalty/customers/:id', { perm: ['fidelidade.ver', 'vendas.criar'] }, async (ctx) => {
  const c = await db.one(`SELECT id, name FROM customers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!c) throw notFound('Cliente')
  const balance = await loyaltyBalance(db, ctx.user.companyId, c.id)
  const ledger = await db.many(`SELECT l.*, u.name AS user_name FROM loyalty_ledger l LEFT JOIN users u ON u.id = l.user_id WHERE l.customer_id = $1 ORDER BY l.created_at DESC LIMIT 200`, [c.id])
  const settings = (await getSettings(db, ctx.user.companyId)).fidelidade
  return { customer: c, balance, ledger, settings }
})

router.post('/api/loyalty/customers/:id/adjust', { perm: 'fidelidade.editar' }, async (ctx) => {
  const b = parse(v.object({ amount: v.money(), notes: v.string({ min: 5, max: 200 }) }), ctx.body)
  return tx(async (c) => {
    const cu = await c.one(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!cu) throw notFound('Cliente')
    await adjustCashback(c, ctx.user.companyId, cu.id, b.amount, b.notes, ctx.user.id)
    await audit(c, ctx, 'fidelidade.ajuste', 'customer', cu.id, b, 'warning')
    return { balance: await loyaltyBalance(c, ctx.user.companyId, cu.id) }
  })
})

router.post('/api/loyalty/expire', { perm: 'fidelidade.editar' }, async (ctx) => {
  const n = await tx((c) => expireCashback(c, ctx.user.companyId))
  await audit(null, ctx, 'fidelidade.expiracao_manual', 'loyalty', null, { expired: n })
  return { expired: n }
})
