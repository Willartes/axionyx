import { router, branchScope, can, r2, today, addDays, Ctx } from '../core/http'
import { db } from '../core/db'
import { unprocessable, forbidden } from '../core/errors'
import { BALANCE_SQL } from '../services/finance'

function period(q: Record<string, string>, defDays = 30) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today()
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : addDays(to, -defDays + 1)
  if (from > to) throw unprocessable('Período inválido.')
  return { from, to }
}
function toCsv(rows: any[]): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  const esc = (v: any) => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return '﻿' + cols.join(';') + '\n' + rows.map((r) => cols.map((c) => esc(r[c])).join(';')).join('\n')
}
function maybeCsv(ctx: Ctx, rows: any[], name: string) {
  if (ctx.query.format === 'csv') { ctx.reply = { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"` }, raw: toCsv(rows) }; return null }
  return rows
}

// ---------- Dashboard executivo (tudo calculado a partir dos registros) ----------
router.get('/api/dashboard', { perm: 'dashboard.ver' }, async (ctx) => {
  const id = ctx.user.companyId
  const branches = branchScope(ctx, ctx.query.branch || (ctx.user.allBranches ? 'all' : 'current'))
  const bp = branches.length ? branches : null
  const finance = can(ctx.user, 'financeiro.ver'), cost = can(ctx.user, 'produtos.custo')
  const salesBase = `FROM sales s WHERE s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[]))`
  const [month, prev, series, top, sellers, stock, customers, condOpen, alerts] = await Promise.all([
    db.one(`SELECT COALESCE(sum(total),0) AS revenue, COALESCE(sum(cost_total),0) AS cost, count(*)::int AS sales, COALESCE(sum(items_count),0)::int AS items ${salesBase} AND s.created_at >= date_trunc('month', now())`, [id, bp]),
    db.one(`SELECT COALESCE(sum(total),0) AS revenue, COALESCE(sum(cost_total),0) AS cost, count(*)::int AS sales, COALESCE(sum(items_count),0)::int AS items ${salesBase}
              AND s.created_at >= date_trunc('month', now()) - interval '1 month' AND s.created_at < date_trunc('month', now()) - interval '1 month' + (now() - date_trunc('month', now()))`, [id, bp]),
    db.many(`SELECT to_char(m, 'YYYY-MM') AS month, COALESCE(x.revenue,0) AS revenue, COALESCE(x.cost,0) AS cost FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
              LEFT JOIN (SELECT date_trunc('month', s.created_at) AS mm, sum(total) AS revenue, sum(cost_total) AS cost ${salesBase} GROUP BY 1) x ON x.mm = m ORDER BY m`, [id, bp]),
    db.many(`SELECT p.name, sum(si.total) AS value, sum(si.qty)::float8 AS qty FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
              WHERE s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[])) AND s.created_at >= now() - interval '30 days'
              GROUP BY p.name ORDER BY value DESC LIMIT 5`, [id, bp]),
    db.many(`SELECT u.name, sum(s.total) AS value, count(*)::int AS sales ${salesBase.replace('FROM sales s', 'FROM sales s JOIN users u ON u.id = s.seller_id')} AND s.created_at >= date_trunc('month', now()) GROUP BY u.name ORDER BY value DESC LIMIT 5`, [id, bp]),
    db.one(`SELECT COALESCE(sum(sb.qty),0)::float8 AS pieces, COALESCE(sum(sb.qty * COALESCE(v.sale_price, p.sale_price)),0) AS value_sale, COALESCE(sum(sb.qty * COALESCE(v.cost_price, p.cost_price)),0) AS value_cost,
                   count(DISTINCT v.id) FILTER (WHERE sb.qty > 0)::int AS skus
              FROM stock_balances sb JOIN product_variants v ON v.id = sb.variant_id JOIN products p ON p.id = v.product_id WHERE sb.company_id = $1 AND ($2::uuid[] IS NULL OR sb.branch_id = ANY($2::uuid[]))`, [id, bp]),
    db.one(`SELECT count(DISTINCT customer_id)::int AS active, count(DISTINCT customer_id) FILTER (WHERE s.created_at >= date_trunc('month', now()))::int AS month ${salesBase} AND s.created_at > now() - interval '90 days'`, [id, bp]),
    db.one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE due_date < current_date)::int AS overdue FROM conditionals WHERE company_id = $1 AND status = 'aberto' AND ($2::uuid[] IS NULL OR branch_id = ANY($2::uuid[]))`, [id, bp]),
    db.one(`SELECT
              (SELECT count(*)::int FROM (SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND ($2::uuid[] IS NULL OR sb.branch_id = ANY($2::uuid[]))
                 WHERE v.company_id = $1 AND v.active AND p.active AND p.track_stock GROUP BY v.id, v.min_stock, p.min_stock HAVING COALESCE(sum(sb.qty),0) <= COALESCE(v.min_stock, p.min_stock) AND COALESCE(v.min_stock, p.min_stock) > 0) x) AS low_stock,
              (SELECT count(*)::int FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date < current_date AND method_kind IN ('crediario','a_prazo','boleto')) AS overdue_titles,
              (SELECT count(*)::int FROM fiscal_documents WHERE company_id = $1 AND status IN ('invalido','pendente_configuracao','erro','rejeitado','contingencia')) AS fiscal_pending,
              (SELECT count(*)::int FROM purchase_entries WHERE company_id = $1 AND status = 'rascunho') AS entries_pending,
              (SELECT count(*)::int FROM payables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date BETWEEN current_date AND current_date + 3) AS payables_due`, [id, bp]),
  ])
  let fin: any = null
  if (finance) {
    fin = await db.one(`SELECT
        (SELECT COALESCE(sum(${BALANCE_SQL}),0) FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial')) AS receivable,
        (SELECT COALESCE(sum(${BALANCE_SQL}),0) FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date < current_date) AS receivable_overdue,
        (SELECT COALESCE(sum(${BALANCE_SQL}),0) FROM payables WHERE company_id = $1 AND status IN ('aberto','parcial')) AS payable,
        (SELECT min(due_date) FROM payables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date >= current_date) AS next_payable_date,
        (SELECT COALESCE(sum(opening_balance),0) FROM financial_accounts WHERE company_id = $1 AND active) + (SELECT COALESCE(sum(CASE WHEN direction='entrada' THEN amount ELSE -amount END),0) FROM financial_transactions WHERE company_id = $1) AS cash_balance,
        (SELECT COALESCE(sum(CASE WHEN direction='entrada' THEN amount ELSE -amount END),0) FROM financial_transactions WHERE company_id = $1 AND date = current_date) AS cash_today`, [id])
    fin.weeks = await db.many(`SELECT 'S' || (row_number() OVER (ORDER BY w))::text AS label, COALESCE(sum(t.amount) FILTER (WHERE t.direction='entrada'),0) AS inflow, COALESCE(sum(t.amount) FILTER (WHERE t.direction='saida'),0) AS outflow
                                 FROM generate_series(date_trunc('week', date_trunc('month', now())), date_trunc('week', now()), interval '1 week') w
                                 LEFT JOIN financial_transactions t ON t.company_id = $1 AND date_trunc('week', t.date) = w GROUP BY w ORDER BY w`, [id])
    fin.expenses3m = await db.many(`SELECT to_char(date_trunc('month', p.due_date), 'YYYY-MM') AS month, COALESCE(sum(p.amount),0) AS value FROM payables p JOIN financial_categories fc ON fc.id = p.category_id
                                     WHERE p.company_id = $1 AND p.status <> 'cancelado' AND fc.dre_group LIKE 'despesas%' AND p.due_date >= date_trunc('month', now()) - interval '2 months' AND p.due_date < date_trunc('month', now()) + interval '1 month' GROUP BY 1 ORDER BY 1`, [id])
  }
  const pct = (a: number, b: number) => (b ? r2(((a - b) / b) * 100) : null)
  const ticket = month.sales ? r2(month.revenue / month.sales) : 0
  const prevTicket = prev.sales ? r2(prev.revenue / prev.sales) : 0
  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      revenue: Number(month.revenue), revenueVar: pct(month.revenue, prev.revenue),
      grossProfit: cost ? r2(month.revenue - month.cost) : null, grossMarginPct: cost && month.revenue ? r2(((month.revenue - month.cost) / month.revenue) * 100) : null,
      sales: month.sales, salesVar: pct(month.sales, prev.sales), ticket, ticketVar: pct(ticket, prevTicket),
      itemsPerSale: month.sales ? r2(month.items / month.sales) : 0, activeCustomers: customers.active, customersMonth: customers.month,
      stockPieces: stock.pieces, stockValueSale: Number(stock.value_sale), stockValueCost: cost ? Number(stock.value_cost) : null, stockSkus: stock.skus,
      conditionalsOpen: condOpen.n, conditionalsOverdue: condOpen.overdue,
    },
    finance: fin, series: series.map((s) => ({ ...s, cost: cost ? s.cost : null })), topProducts: top, topSellers: sellers, alerts,
  }
})

// ---------- Vendas ----------
const SALE_GROUPS: Record<string, { key: string; label: string; item: boolean; order?: string }> = {
  dia: { key: `to_char(s.created_at, 'YYYY-MM-DD')`, label: `to_char(s.created_at, 'DD/MM/YYYY')`, item: false, order: 'key' },
  mes: { key: `to_char(s.created_at, 'YYYY-MM')`, label: `to_char(s.created_at, 'MM/YYYY')`, item: false, order: 'key' },
  vendedor: { key: 's.seller_id::text', label: `COALESCE(u.name,'—')`, item: false },
  filial: { key: 's.branch_id::text', label: 'br.name', item: false },
  canal: { key: 's.channel', label: 's.channel', item: false },
  produto: { key: 'p.id::text', label: `p.code || ' · ' || p.name`, item: true },
  marca: { key: `COALESCE(p.brand_id::text,'-')`, label: `COALESCE(b.name,'Sem marca')`, item: true },
  colecao: { key: `COALESCE(p.collection_id::text,'-')`, label: `COALESCE(cl.name,'Sem coleção')`, item: true },
  categoria: { key: `COALESCE(p.category_id::text,'-')`, label: `COALESCE(ca.name,'Sem categoria')`, item: true },
  tamanho: { key: `COALESCE(sz.code,'-')`, label: `COALESCE(sz.code,'Sem tamanho')`, item: true },
  cor: { key: `COALESCE(co.name,'-')`, label: `COALESCE(co.name,'Sem cor')`, item: true },
}

router.get('/api/reports/sales', { perm: 'relatorios.ver' }, async (ctx) => {
  const q = ctx.query
  const { from, to } = period(q)
  const g = Object.hasOwn(SALE_GROUPS, q.group || 'dia') ? SALE_GROUPS[q.group || 'dia'] : undefined
  if (!g) throw unprocessable('Agrupamento inválido.')
  const branches = branchScope(ctx, q.branch || 'current')
  const params: unknown[] = [ctx.user.companyId, from, to, branches.length ? branches : null, q.seller || null, q.brand || null, q.collection || null, q.size || null, q.color || null, q.category || null, q.product || null]
  if (!can(ctx.user, 'vendas.todas')) params[4] = ctx.user.id
  const filters = `s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day'
    AND ($4::uuid[] IS NULL OR s.branch_id = ANY($4::uuid[])) AND ($5::uuid IS NULL OR s.seller_id = $5)`
  const itemFilters = `AND ($6::uuid IS NULL OR p.brand_id = $6) AND ($7::uuid IS NULL OR p.collection_id = $7) AND ($8::text IS NULL OR sz.code = $8) AND ($9::uuid IS NULL OR v.color_id = $9) AND ($10::uuid IS NULL OR p.category_id = $10) AND ($11::uuid IS NULL OR p.id = $11)`
  const joins = `FROM sales s JOIN sale_items si ON si.sale_id = s.id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                 LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id LEFT JOIN brands b ON b.id = p.brand_id
                 LEFT JOIN collections cl ON cl.id = p.collection_id LEFT JOIN categories ca ON ca.id = p.category_id LEFT JOIN users u ON u.id = s.seller_id JOIN branches br ON br.id = s.branch_id`
  const showCost = can(ctx.user, 'produtos.custo')
  const rows = await db.many(`
    SELECT ${g.key} AS key, ${g.label} AS label, count(DISTINCT s.id)::int AS sales, sum(si.qty)::float8 AS items, sum(si.returned_qty)::float8 AS returned_items,
           sum(si.unit_price * si.qty) AS gross, sum(si.discount) AS discount, sum(si.total) AS net,
           sum(si.total * si.returned_qty / si.qty) AS returned_value ${showCost ? ', sum(si.unit_cost * si.qty) AS cost' : ''}
      ${joins} WHERE ${filters} ${itemFilters} GROUP BY 1, 2 ORDER BY ${g.order === 'key' ? '1' : 'net DESC'}`, params)
  const out = rows.map((r) => {
    const netAfter = r2(Number(r.net) - Number(r.returned_value))
    const o: any = { ...r, gross: r2(r.gross), discount: r2(r.discount), net: r2(r.net), returned_value: r2(r.returned_value), net_after_returns: netAfter,
      ticket: r.sales ? r2(Number(r.net) / r.sales) : 0, items_per_sale: r.sales ? r2(r.items / r.sales) : 0 }
    if (showCost) { o.cost = r2(r.cost); o.margin_pct = Number(r.net) ? r2(((Number(r.net) - Number(r.cost)) / Number(r.net)) * 100) : 0 }
    return o
  })
  if (ctx.query.format === 'csv') return maybeCsv(ctx, out, `vendas-${q.group || 'dia'}-${from}-${to}`)
  // totais conciliáveis com a lista de vendas (mesmos filtros de cabeçalho)
  const head = g.item || q.brand || q.collection || q.size || q.color || q.category || q.product ? null
    : await db.one(`SELECT count(*)::int AS sales, COALESCE(sum(total),0) AS total FROM sales s WHERE ${filters}`, params.slice(0, 5))
  return { from, to, group: q.group || 'dia', rows: out, check: head }
})

router.get('/api/reports/payments', { perm: 'relatorios.ver' }, async (ctx) => {
  const { from, to } = period(ctx.query)
  const branches = branchScope(ctx, ctx.query.branch || 'current')
  const rows = await db.many(`SELECT sp.kind, COALESCE(pm.name, sp.kind) AS method, count(DISTINCT s.id)::int AS sales, sum(sp.amount) AS total, sum(sp.change_amount) AS change
                                FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id LEFT JOIN payment_methods pm ON pm.id = sp.method_id
                               WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day' AND ($4::uuid[] IS NULL OR s.branch_id = ANY($4::uuid[]))
                               GROUP BY 1, 2 ORDER BY total DESC`, [ctx.user.companyId, from, to, branches.length ? branches : null])
  return maybeCsv(ctx, rows, `pagamentos-${from}-${to}`)
})

router.get('/api/reports/sellers', { perm: 'relatorios.ver' }, async (ctx) => {
  const { from, to } = period(ctx.query)
  const branches = branchScope(ctx, ctx.query.branch || 'current')
  const rows = await db.many(`
    SELECT u.id, u.name, count(*)::int AS sales, COALESCE(sum(s.total),0) AS revenue, COALESCE(sum(s.items_count),0)::int AS items, COALESCE(sum(s.discount_total),0) AS discounts,
           COALESCE((SELECT sum(c.amount) FROM commissions c WHERE c.seller_id = u.id AND c.company_id = $1 AND c.created_at >= $2::date AND c.created_at < $3::date + interval '1 day'),0) AS commission,
           COALESCE((SELECT sum(r.total) FROM returns r JOIN sales rs ON rs.id = r.sale_id WHERE rs.seller_id = u.id AND r.company_id = $1 AND r.created_at >= $2::date AND r.created_at < $3::date + interval '1 day'),0) AS returns
      FROM sales s JOIN users u ON u.id = s.seller_id
     WHERE s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day' AND ($4::uuid[] IS NULL OR s.branch_id = ANY($4::uuid[]))
       AND ($5::uuid IS NULL OR s.seller_id = $5)
     GROUP BY u.id, u.name ORDER BY revenue DESC`, [ctx.user.companyId, from, to, branches.length ? branches : null, can(ctx.user, 'vendas.todas') ? null : ctx.user.id])
  return maybeCsv(ctx, rows.map((r) => ({ ...r, ticket: r.sales ? r2(r.revenue / r.sales) : 0, items_per_sale: r.sales ? r2(r.items / r.sales) : 0 })), `vendedores-${from}-${to}`)
})

// ---------- Estoque ----------
router.get('/api/reports/stock', { perm: ['relatorios.ver', 'estoque.ver'] }, async (ctx) => {
  const groups: Record<string, [string, string]> = {
    produto: [`p.id::text`, `p.code || ' · ' || p.name`], marca: [`COALESCE(b.name,'Sem marca')`, `COALESCE(b.name,'Sem marca')`], colecao: [`COALESCE(cl.name,'Sem coleção')`, `COALESCE(cl.name,'Sem coleção')`],
    categoria: [`COALESCE(ca.name,'Sem categoria')`, `COALESCE(ca.name,'Sem categoria')`], tamanho: [`COALESCE(sz.code,'-')`, `COALESCE(sz.code,'Sem tamanho')`], cor: [`COALESCE(co.name,'-')`, `COALESCE(co.name,'Sem cor')`],
    filial: ['br.id::text', 'br.name'],
  }
  const g = Object.hasOwn(groups, ctx.query.group || 'marca') ? groups[ctx.query.group || 'marca'] : undefined
  if (!g) throw unprocessable('Agrupamento inválido.')
  const branches = branchScope(ctx, ctx.query.branch || 'all')
  const showCost = can(ctx.user, 'produtos.custo')
  const rows = await db.many(`
    SELECT ${g[0]} AS key, ${g[1]} AS label, count(DISTINCT v.id)::int AS skus, COALESCE(sum(sb.qty),0)::float8 AS qty, COALESCE(sum(sb.qty * COALESCE(v.sale_price, p.sale_price)),0) AS value_sale
           ${showCost ? ', COALESCE(sum(sb.qty * COALESCE(v.cost_price, p.cost_price)),0) AS value_cost' : ''}
      FROM stock_balances sb JOIN product_variants v ON v.id = sb.variant_id JOIN products p ON p.id = v.product_id JOIN branches br ON br.id = sb.branch_id
      LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN collections cl ON cl.id = p.collection_id LEFT JOIN categories ca ON ca.id = p.category_id
     WHERE sb.company_id = $1 AND ($2::uuid[] IS NULL OR sb.branch_id = ANY($2::uuid[])) GROUP BY 1, 2 HAVING COALESCE(sum(sb.qty),0) <> 0 ORDER BY value_sale DESC`, [ctx.user.companyId, branches.length ? branches : null])
  return maybeCsv(ctx, rows, `estoque-${ctx.query.group || 'marca'}`)
})

/** Giro e cobertura (dias de estoque) por produto. */
router.get('/api/reports/stock-turnover', { perm: ['relatorios.ver', 'estoque.ver'] }, async (ctx) => {
  const days = Math.min(365, Math.max(7, parseInt(ctx.query.days || '30', 10)))
  const branches = branchScope(ctx, ctx.query.branch || 'current')
  const rows = await db.many(`
    WITH st AS (SELECT v.product_id, sum(sb.qty)::float8 AS qty FROM stock_balances sb JOIN product_variants v ON v.id = sb.variant_id WHERE sb.company_id = $1 AND ($3::uuid[] IS NULL OR sb.branch_id = ANY($3::uuid[])) GROUP BY 1),
         sl AS (SELECT v.product_id, sum(si.qty - si.returned_qty)::float8 AS sold FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id
                 WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.type = 'venda' AND s.created_at > now() - ($2 || ' days')::interval AND ($3::uuid[] IS NULL OR s.branch_id = ANY($3::uuid[])) GROUP BY 1)
    SELECT p.id, p.code, p.name, COALESCE(st.qty,0) AS stock, COALESCE(sl.sold,0) AS sold, round(COALESCE(sl.sold,0)::numeric / $2::int, 3) AS daily_avg,
           CASE WHEN COALESCE(sl.sold,0) > 0 THEN round(COALESCE(st.qty,0) / (sl.sold::numeric / $2::int)) END AS coverage_days
      FROM products p LEFT JOIN st ON st.product_id = p.id LEFT JOIN sl ON sl.product_id = p.id
     WHERE p.company_id = $1 AND p.active AND p.kind = 'produto' AND (COALESCE(st.qty,0) > 0 OR COALESCE(sl.sold,0) > 0) ORDER BY coverage_days NULLS FIRST, sold DESC LIMIT 500`, [ctx.user.companyId, String(days), branches.length ? branches : null])
  return maybeCsv(ctx, rows, `giro-estoque-${days}d`)
})

// ---------- Compras ----------
router.get('/api/reports/purchases', { perm: ['relatorios.ver', 'compras.ver'] }, async (ctx) => {
  const { from, to } = period(ctx.query, 90)
  const group = ctx.query.group === 'mes' ? `to_char(e.issue_date, 'YYYY-MM')` : `COALESCE(s.name,'—')`
  const rows = await db.many(`SELECT ${group} AS label, count(*)::int AS entries, COALESCE(sum(e.total),0) AS total, COALESCE(sum((SELECT sum(qty) FROM purchase_entry_items i WHERE i.entry_id = e.id)),0)::int AS pieces
                                FROM purchase_entries e LEFT JOIN suppliers s ON s.id = e.supplier_id
                               WHERE e.company_id = $1 AND e.status = 'confirmada' AND e.issue_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY ${ctx.query.group === 'mes' ? '1' : 'total DESC'}`, [ctx.user.companyId, from, to])
  return maybeCsv(ctx, rows, `compras-${from}-${to}`)
})

// ---------- Financeiro / Crediário ----------
router.get('/api/reports/delinquency', { perm: ['relatorios.ver', 'financeiro.ver'] }, async (ctx) => {
  if (!can(ctx.user, 'financeiro.ver')) throw forbidden()
  const rows = await db.many(`
    SELECT c.id, c.code, c.name, c.whatsapp, count(*)::int AS titles, COALESCE(sum(${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'r.$1')}),0) AS overdue,
           max(current_date - r.due_date) AS max_days, min(r.due_date) AS oldest_due
      FROM receivables r JOIN customers c ON c.id = r.customer_id
     WHERE r.company_id = $1 AND r.status IN ('aberto','parcial') AND r.due_date < current_date AND r.method_kind IN ('crediario','a_prazo','boleto')
     GROUP BY c.id ORDER BY overdue DESC`, [ctx.user.companyId])
  const totals = await db.one(`SELECT COALESCE(sum(${BALANCE_SQL}) FILTER (WHERE due_date < current_date),0) AS overdue, COALESCE(sum(${BALANCE_SQL}),0) AS portfolio
                                 FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial') AND method_kind IN ('crediario','a_prazo','boleto')`, [ctx.user.companyId])
  if (ctx.query.format === 'csv') return maybeCsv(ctx, rows, 'inadimplencia')
  return { rows, totals: { ...totals, rate_pct: Number(totals.portfolio) ? r2((Number(totals.overdue) / Number(totals.portfolio)) * 100) : 0 } }
})

router.get('/api/reports/due', { perm: 'financeiro.ver' }, async (ctx) => {
  const { from, to } = period({ from: ctx.query.from || today(), to: ctx.query.to || addDays(today(), 30) })
  const rows = await db.many(`
    SELECT 'receber' AS type, r.due_date, r.document, r.installment_no, r.installments_total, c.name AS party, r.method_kind AS kind, ${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'r.$1')} AS balance
      FROM receivables r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.company_id = $1 AND r.status IN ('aberto','parcial') AND r.due_date BETWEEN $2 AND $3
    UNION ALL
    SELECT 'pagar', p.due_date, p.document, p.installment_no, p.installments_total, s.name, 'pagar', ${BALANCE_SQL.replace(/(amount|interest|fine|discount|paid_amount)/g, 'p.$1')}
      FROM payables p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.company_id = $1 AND p.status IN ('aberto','parcial') AND p.due_date BETWEEN $2 AND $3
    ORDER BY 2, 1`, [ctx.user.companyId, from, to])
  return maybeCsv(ctx, rows, `vencimentos-${from}-${to}`)
})

/** DRE gerencial: receita (vendas), deduções (devoluções e impostos estimados), CMV (custo das vendas), despesas por grupo (contas a pagar por competência). */
export async function dre(companyId: string, from: string, to: string) {
  const sales = await db.one(`SELECT COALESCE(sum(total),0) AS revenue, COALESCE(sum(cost_total),0) AS cost FROM sales WHERE company_id = $1 AND type = 'venda' AND status <> 'cancelada' AND created_at >= $2::date AND created_at < $3::date + interval '1 day'`, [companyId, from, to])
  const ret = await db.one(`SELECT COALESCE(sum(r.total),0) AS total, COALESCE(sum(ri.qty * si.unit_cost),0) AS cost FROM returns r JOIN return_items ri ON ri.return_id = r.id JOIN sale_items si ON si.id = ri.sale_item_id
                             WHERE r.company_id = $1 AND r.created_at >= $2::date AND r.created_at < $3::date + interval '1 day'`, [companyId, from, to])
  const settings = (await db.one(`SELECT settings FROM companies WHERE id = $1`, [companyId])).settings
  const taxPct = Number(settings?.fiscal?.aliquotaEstimadaPct ?? 6)
  const expenses = await db.many(`SELECT fc.dre_group, fc.name, COALESCE(sum(p.amount),0) AS total FROM payables p JOIN financial_categories fc ON fc.id = p.category_id
                                   WHERE p.company_id = $1 AND p.status <> 'cancelado' AND p.due_date BETWEEN $2 AND $3 AND fc.dre_group NOT IN ('cmv') GROUP BY 1, 2 ORDER BY 1, 3 DESC`, [companyId, from, to])
  const finIncome = await db.one(`SELECT COALESCE(sum(interest + fine),0) AS v FROM title_payments WHERE company_id = $1 AND title_type = 'receber' AND reversed_at IS NULL AND date BETWEEN $2 AND $3`, [companyId, from, to])
  const gross = Number(sales.revenue)
  const deductions = r2(Number(ret.total) + (gross - Number(ret.total)) * taxPct / 100)
  const netRevenue = r2(gross - deductions)
  const cmv = r2(Number(sales.cost) - Number(ret.cost))
  const grossProfit = r2(netRevenue - cmv)
  const group = (g: string) => r2(expenses.filter((e) => e.dre_group === g).reduce((s, e) => s + Number(e.total), 0))
  const opex = r2(['despesas_operacionais', 'despesas_pessoal', 'despesas_administrativas', 'despesas_comerciais', 'outras'].reduce((s, g) => s + group(g), 0) + group('deducoes') * 0)
  const finExp = group('despesas_financeiras')
  const ebitda = r2(grossProfit - opex)
  const net = r2(ebitda + Number(finIncome.v) - finExp)
  return {
    from, to, estimatedTaxPct: taxPct,
    lines: [
      { code: '1', label: 'Receita Bruta de Vendas', value: gross, level: 0 },
      { code: '1.1', label: '(-) Devoluções', value: -Number(ret.total), level: 1 },
      { code: '1.2', label: `(-) Impostos sobre vendas (estimado ${taxPct}%)`, value: -r2(deductions - Number(ret.total)), level: 1 },
      { code: '2', label: 'Receita Líquida', value: netRevenue, level: 0, total: true },
      { code: '3', label: '(-) CMV — Custo das Mercadorias Vendidas', value: -cmv, level: 0 },
      { code: '4', label: 'Lucro Bruto', value: grossProfit, level: 0, total: true },
      { code: '5.1', label: '(-) Despesas com Pessoal', value: -group('despesas_pessoal'), level: 1 },
      { code: '5.2', label: '(-) Despesas Administrativas', value: -group('despesas_administrativas'), level: 1 },
      { code: '5.3', label: '(-) Despesas Comerciais', value: -group('despesas_comerciais'), level: 1 },
      { code: '5.4', label: '(-) Outras Despesas Operacionais', value: -r2(group('despesas_operacionais') + group('outras')), level: 1 },
      { code: '6', label: 'Resultado Operacional (EBITDA)', value: ebitda, level: 0, total: true },
      { code: '7.1', label: '(+) Receitas Financeiras (juros e multas recebidos)', value: Number(finIncome.v), level: 1 },
      { code: '7.2', label: '(-) Despesas Financeiras (taxas de cartão, tarifas)', value: -finExp, level: 1 },
      { code: '8', label: 'Resultado Líquido do Período', value: net, level: 0, total: true },
    ],
    details: expenses,
    margins: { gross: netRevenue ? r2((grossProfit / netRevenue) * 100) : 0, net: netRevenue ? r2((net / netRevenue) * 100) : 0 },
  }
}
router.get('/api/reports/dre', { perm: ['contabilidade.ver', 'financeiro.ver'] }, async (ctx) => {
  const { from, to } = period(ctx.query, 30)
  return dre(ctx.user.companyId, from, to)
})

// ---------- Clientes ----------
router.get('/api/reports/customers', { perm: ['relatorios.ver', 'clientes.ver'] }, async (ctx) => {
  const { from, to } = period(ctx.query, 90)
  const top = await db.many(`SELECT c.id, c.name, count(*)::int AS purchases, sum(s.total) AS total, max(s.created_at) AS last_purchase FROM sales s JOIN customers c ON c.id = s.customer_id
                              WHERE s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day'
                              GROUP BY c.id ORDER BY total DESC LIMIT 50`, [ctx.user.companyId, from, to])
  const summary = await db.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at >= $2::date)::int AS new_in_period,
                                       (SELECT count(DISTINCT customer_id)::int FROM sales WHERE company_id = $1 AND status <> 'cancelada' AND created_at >= $2::date AND created_at < $3::date + interval '1 day') AS buyers,
                                       (SELECT count(*)::int FROM sales WHERE company_id = $1 AND type = 'venda' AND status <> 'cancelada' AND customer_id IS NULL AND created_at >= $2::date AND created_at < $3::date + interval '1 day') AS anonymous_sales
                                  FROM customers WHERE company_id = $1 AND anonymized_at IS NULL`, [ctx.user.companyId, from, to])
  const concentration = top.length ? r2(top.slice(0, 3).reduce((s, x) => s + Number(x.total), 0)) : 0
  if (ctx.query.format === 'csv') return maybeCsv(ctx, top, `clientes-${from}-${to}`)
  return { from, to, summary, top, top3Total: concentration }
})

// ---------- Fiscal ----------
router.get('/api/reports/fiscal', { perm: ['relatorios.ver', 'fiscal.ver'] }, async (ctx) => {
  const { from, to } = period(ctx.query, 90)
  const rows = await db.many(`SELECT to_char(created_at, 'YYYY-MM') AS month, model, status, is_test, count(*)::int AS n, COALESCE(sum((totals->>'total')::numeric),0) AS total
                                FROM fiscal_documents WHERE company_id = $1 AND created_at >= $2::date AND created_at < $3::date + interval '1 day' GROUP BY 1,2,3,4 ORDER BY 1,2,3`, [ctx.user.companyId, from, to])
  return maybeCsv(ctx, rows, `fiscal-${from}-${to}`)
})
