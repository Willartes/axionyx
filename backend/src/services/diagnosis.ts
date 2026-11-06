import { db } from '../core/db'
import { r2, today } from '../core/http'
import { dre } from '../modules/relatorios'

/**
 * Pré-diagnóstico do lucro (motor de regras e estatística sobre os dados do AXIONYX, sem IA generativa).
 *
 * Compara o DRE gerencial de dois períodos e decompõe a variação do Resultado Líquido em parcelas que SOMAM
 * EXATAMENTE a diferença:
 *   Contribuição das vendas  S = Receita × (1 − imposto estimado) − Custo das vendas
 *     → movimento (nº de vendas) + ticket médio + margem
 *   Devoluções, despesas por grupo do DRE e resultado financeiro.
 * Em seguida reúne as evidências que explicam cada parcela (custo e preço dos mesmos produtos, desconto, mix,
 * filiais, clientes que não voltaram, categorias de despesa) e aponta por onde começar.
 */

export type PeriodKey = '7d' | '30d' | '90d' | 'mes' | 'mes_anterior'
export interface Periods { key: PeriodKey; label: string; from: string; to: string; prevFrom: string; prevTo: string; days: number }

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (s: string, n: number) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d) }
const br = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

export function resolvePeriods(key: PeriodKey = '30d', ref: string = today()): Periods {
  const [y, m, d] = ref.split('-').map(Number)
  if (key === 'mes' || key === 'mes_anterior') {
    if (key === 'mes') {
      const from = `${ref.slice(0, 8)}01`
      const py = m === 1 ? y - 1 : y, pm = m === 1 ? 11 : m - 2
      const prevFrom = iso(new Date(Date.UTC(py, pm, 1)))
      const prevTo = iso(new Date(Date.UTC(py, pm, Math.min(d, monthEnd(py, pm)))))
      return { key, label: 'este mês até hoje', from, to: ref, prevFrom, prevTo, days: d }
    }
    const ly = m === 1 ? y - 1 : y, lm = m === 1 ? 11 : m - 2
    const from = iso(new Date(Date.UTC(ly, lm, 1))), to = iso(new Date(Date.UTC(ly, lm, monthEnd(ly, lm))))
    const py = lm === 0 ? ly - 1 : ly, pm = lm === 0 ? 11 : lm - 1
    return { key, label: 'mês passado', from, to, prevFrom: iso(new Date(Date.UTC(py, pm, 1))), prevTo: iso(new Date(Date.UTC(py, pm, monthEnd(py, pm)))), days: monthEnd(ly, lm) }
  }
  const days = key === '7d' ? 7 : key === '90d' ? 90 : 30
  const from = addDays(ref, -(days - 1))
  return { key, label: `últimos ${days} dias`, from, to: ref, prevFrom: addDays(from, -days), prevTo: addDays(from, -1), days }
}

/** Período pedido na pergunta em linguagem natural (sem acentos, minúsculas). */
export function periodFromQuestion(q: string): PeriodKey {
  if (/semana/.test(q)) return '7d'
  if (/(mes passado|mes anterior|ultimo mes)/.test(q)) return 'mes_anterior'
  if (/(trimestre|90 dias|3 meses|tres meses)/.test(q)) return '90d'
  if (/(este mes|neste mes|esse mes|nesse mes|do mes|no mes|mes atual)/.test(q)) return 'mes'
  return '30d'
}

export interface Driver { key: string; label: string; impact: number; detail: string; evidence: string[]; link?: string; linkLabel?: string; minor?: boolean }
export interface Diagnosis {
  focus: 'lucro' | 'vendas'
  periods: Periods & { currentLabel: string; previousLabel: string }
  headline: { metric: string; current: number; previous: number; delta: number; pct: number | null; direction: 'caiu' | 'subiu' | 'estavel' }
  kpis: Record<string, { current: number; previous: number }>
  drivers: Driver[]          // somam exatamente headline.delta
  attention: string[]        // sinais que não entram na soma (cancelamentos, taxas, comissões)
  actions: { text: string; link?: string; linkLabel?: string }[]
  confidence: { level: 'alta' | 'media' | 'baixa'; reasons: string[] }
  method: string
  generatedAt: string
}

const brl = (n: number) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace('-', '−')
const sbrl = (n: number) => (n >= 0 ? '+' : '−') + brl(Math.abs(n))
const pct = (n: number, d = 1) => `${n.toFixed(d).replace('.', ',')}%`
const ppt = (a: number, b: number) => `${pct(b)} → ${pct(a)}`

type Range = [string, string]

async function salesAgg(companyId: string, [from, to]: Range) {
  return db.one(`SELECT count(*)::int AS n, COALESCE(sum(total),0)::float8 AS revenue, COALESCE(sum(cost_total),0)::float8 AS cost,
                        COALESCE(sum(subtotal),0)::float8 AS subtotal, COALESCE(sum(discount_total),0)::float8 AS discount, COALESCE(sum(items_count),0)::float8 AS items
                   FROM sales WHERE company_id = $1 AND type = 'venda' AND status <> 'cancelada' AND created_at >= $2::date AND created_at < $3::date + interval '1 day'`, [companyId, from, to])
}
async function cancelled(companyId: string, [from, to]: Range) {
  return db.one(`SELECT count(*)::int AS n, COALESCE(sum(total),0)::float8 AS v FROM sales WHERE company_id = $1 AND type = 'venda' AND status = 'cancelada' AND created_at >= $2::date AND created_at < $3::date + interval '1 day'`, [companyId, from, to])
}
async function items(companyId: string, [from, to]: Range) {
  return db.many(`SELECT si.variant_id, p.id AS product_id, p.name || COALESCE(' ' || NULLIF(concat_ws(' ', co.name, sz.code), ''), '') AS name,
                         sum(si.qty)::float8 AS qty, sum(si.total)::float8 AS revenue, sum(si.qty * si.unit_cost)::float8 AS cost
                    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                    LEFT JOIN colors co ON co.id = v.color_id LEFT JOIN sizes sz ON sz.id = v.size_id
                   WHERE s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day'
                   GROUP BY si.variant_id, p.id, p.name, co.name, sz.code`, [companyId, from, to])
}
async function branches(companyId: string, [from, to]: Range) {
  return db.many(`SELECT b.id, b.name, count(s.id)::int AS n, COALESCE(sum(s.total),0)::float8 AS revenue, COALESCE(sum(s.cost_total),0)::float8 AS cost
                    FROM branches b LEFT JOIN sales s ON s.branch_id = b.id AND s.type = 'venda' AND s.status <> 'cancelada' AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day'
                   WHERE b.company_id = $1 GROUP BY b.id, b.name`, [companyId, from, to])
}
async function fees(companyId: string, [from, to]: Range) {
  return db.one(`SELECT COALESCE(sum(r.fee_amount),0)::float8 AS v FROM receivables r JOIN sales s ON s.id = r.sale_id
                  WHERE r.company_id = $1 AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day'`, [companyId, from, to])
}
async function commissionsSum(companyId: string, [from, to]: Range) {
  // data da venda que gerou a comissão (competência real); sem venda vinculada, a data de registro
  const a = await db.one(`SELECT COALESCE(sum(c.amount),0)::float8 AS v FROM commissions c LEFT JOIN sales s ON s.id = c.sale_id
                           WHERE c.company_id = $1 AND COALESCE(s.created_at::date, c.competence) BETWEEN $2 AND $3`, [companyId, from, to])
  const b = await db.one(`SELECT COALESCE(sum(pc.amount),0)::float8 AS v FROM professional_commissions pc LEFT JOIN sales s ON s.id = pc.sale_id
                           WHERE pc.company_id = $1 AND COALESCE(s.created_at, pc.created_at) >= $2::date AND COALESCE(s.created_at, pc.created_at) < $3::date + interval '1 day'`, [companyId, from, to]).catch(() => ({ v: 0 }))
  return Number(a.v) + Number(b.v)
}
/** Faturamento de PRODUTOS vendidos sem custo cadastrado (serviços não têm custo de mercadoria e ficam de fora). */
async function noCostProducts(companyId: string, [from, to]: Range) {
  return db.one(`SELECT COALESCE(sum(si.total) FILTER (WHERE si.unit_cost = 0),0)::float8 AS v, COALESCE(sum(si.total),0)::float8 AS products
                   FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                  WHERE s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada' AND COALESCE(p.kind, 'produto') = 'produto'
                    AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day'`, [companyId, from, to])
}
/** Clientes que compraram no período anterior e não voltaram no atual. */
async function lostCustomers(companyId: string, cur: Range, prev: Range) {
  return db.one(`WITH p AS (SELECT customer_id, sum(total)::float8 AS v FROM sales WHERE company_id = $1 AND type = 'venda' AND status <> 'cancelada' AND customer_id IS NOT NULL
                                AND created_at >= $4::date AND created_at < $5::date + interval '1 day' GROUP BY 1),
                      c AS (SELECT DISTINCT customer_id FROM sales WHERE company_id = $1 AND type = 'venda' AND status <> 'cancelada' AND customer_id IS NOT NULL
                                AND created_at >= $2::date AND created_at < $3::date + interval '1 day')
                 SELECT count(*)::int AS n, COALESCE(sum(p.v),0)::float8 AS v, (SELECT count(*)::int FROM p) AS base FROM p WHERE p.customer_id NOT IN (SELECT customer_id FROM c)`,
  [companyId, cur[0], cur[1], prev[0], prev[1]])
}

const line = (d: any, code: string) => Number(d.lines.find((l: any) => l.code === code)?.value ?? 0)

export async function profitDiagnosis(companyId: string, key: PeriodKey, opts: { showCosts: boolean; focus?: 'lucro' | 'vendas'; ref?: string }): Promise<Diagnosis> {
  const focus = opts.focus ?? 'lucro'
  const P = resolvePeriods(key, opts.ref)
  const A: Range = [P.from, P.to], B: Range = [P.prevFrom, P.prevTo]
  const [dA, dB, sA, sB, iA, iB, bA, bB, cA, cB, fA, fB, kA, kB, lost, ncA] = await Promise.all([
    dre(companyId, ...A), dre(companyId, ...B), salesAgg(companyId, A), salesAgg(companyId, B), items(companyId, A), items(companyId, B),
    branches(companyId, A), branches(companyId, B), cancelled(companyId, A), cancelled(companyId, B), fees(companyId, A), fees(companyId, B),
    commissionsSum(companyId, A), commissionsSum(companyId, B), lostCustomers(companyId, A, B), noCostProducts(companyId, A)])
  const t = Number(dA.estimatedTaxPct) / 100
  const RA = Number(sA.revenue), RB = Number(sB.revenue), CA = Number(sA.cost), CB = Number(sB.cost), NA = sA.n, NB = sB.n
  const SA = RA * (1 - t) - CA, SB = RB * (1 - t) - CB
  const TA = NA ? RA / NA : 0, TB = NB ? RB / NB : 0
  const mA = RA ? SA / RA : 0, mB = RB ? SB / RB : 0
  const dA_ = RA ? (RA - CA) / RA * 100 : 0, dB_ = RB ? (RB - CB) / RB * 100 : 0 // margem bruta "de balcão" (antes de impostos)
  const discA = Number(sA.subtotal) ? Number(sA.discount) / Number(sA.subtotal) * 100 : 0
  const discB = Number(sB.subtotal) ? Number(sB.discount) / Number(sB.subtotal) * 100 : 0

  // ---- evidências por produto (mesmas variações nos dois períodos) ----
  const mapB = new Map(iB.map((r: any) => [r.variant_id, r]))
  let costEffect = 0, priceEffect = 0
  const costUps: { name: string; pct: number; impact: number }[] = [], priceDowns: { name: string; pct: number; impact: number }[] = []
  for (const a of iA) {
    const b: any = mapB.get(a.variant_id)
    if (!b || !Number(a.qty) || !Number(b.qty)) continue
    const ucA = a.cost / a.qty, ucB = b.cost / b.qty, upA = a.revenue / a.qty, upB = b.revenue / b.qty
    const ce = (ucA - ucB) * a.qty, pe = (upA - upB) * a.qty * (1 - t)
    costEffect += ce; priceEffect += pe
    if (ucB > 0 && ucA > ucB * 1.03) costUps.push({ name: a.name, pct: (ucA / ucB - 1) * 100, impact: ce })
    if (upB > 0 && upA < upB * 0.97) priceDowns.push({ name: a.name, pct: (1 - upA / upB) * 100, impact: pe })
  }
  costUps.sort((x, y) => y.impact - x.impact); priceDowns.sort((x, y) => x.impact - y.impact)
  // contribuição por produto (agregado por produto)
  const byProduct = (rows: any[]) => { const m = new Map<string, { name: string; s: number; r: number }>()
    for (const r of rows) { const k = r.product_id; const cur = m.get(k) ?? { name: String(r.name).split(' ').slice(0, 6).join(' '), s: 0, r: 0 }; cur.s += r.revenue * (1 - t) - r.cost; cur.r += r.revenue; m.set(k, cur) } return m }
  const pA = byProduct(iA), pB = byProduct(iB)
  const prodDelta = [...new Set([...pA.keys(), ...pB.keys()])].map((k) => ({ name: (pA.get(k) ?? pB.get(k))!.name, ds: (pA.get(k)?.s ?? 0) - (pB.get(k)?.s ?? 0), dr: (pA.get(k)?.r ?? 0) - (pB.get(k)?.r ?? 0) }))
  const prodDown = [...prodDelta].sort((x, y) => (focus === 'vendas' ? x.dr - y.dr : x.ds - y.ds)).filter((x) => (focus === 'vendas' ? x.dr : x.ds) < 0).slice(0, 3)

  // ---- filiais ----
  const brB = new Map(bB.map((r: any) => [r.id, r]))
  const brDelta = bA.map((a: any) => { const b: any = brB.get(a.id) ?? { revenue: 0, cost: 0, n: 0 }
    return { name: a.name, dr: a.revenue - b.revenue, ds: (a.revenue * (1 - t) - a.cost) - (b.revenue * (1 - t) - b.cost), nA: a.n, nB: b.n } })
  const multiBranch = bA.filter((b: any) => b.n > 0).length + bB.filter((b: any) => b.n > 0).length > 2 || bA.length > 1

  const drivers: Driver[] = []
  const evProducts = (label: string) => prodDown.length ? [`${label}: ${prodDown.map((p) => `${p.name} (${sbrl(focus === 'vendas' ? p.dr : p.ds)})`).join(', ')}`] : []
  const evBranch = () => { if (!multiBranch) return [] as string[]; const w = [...brDelta].sort((x, y) => (focus === 'vendas' ? x.dr - y.dr : x.ds - y.ds))[0]
    return w && (focus === 'vendas' ? w.dr : w.ds) < 0 ? [`Filial que mais recuou: ${w.name} (${sbrl(focus === 'vendas' ? w.dr : w.ds)}; ${w.nB} → ${w.nA} vendas)`] : [] }
  const evLost = Number(lost.n) > 0 ? [`${lost.n} de ${lost.base} cliente(s) identificados no período anterior não voltaram a comprar (eles somaram ${brl(lost.v)} antes)`] : []

  let headline: Diagnosis['headline']
  if (focus === 'vendas') {
    // Receita = nº de vendas × ticket médio (decomposição exata)
    const empty = NA === 0 || NB === 0
    const volume = empty ? RA - RB : (NA - NB) * TB, ticket = empty ? 0 : NA * (TA - TB)
    drivers.push({ key: 'movimento', label: NA >= NB ? 'Mais vendas' : 'Menos vendas', impact: r2(volume), detail: `${NB} → ${NA} vendas`, evidence: [...evLost, ...evBranch()], link: 'clientes', linkLabel: 'Ver clientes' })
    drivers.push({ key: 'ticket', label: TA >= TB ? 'Ticket médio maior' : 'Ticket médio menor', impact: r2(ticket), detail: `${brl(TB)} → ${brl(TA)} por venda`,
      evidence: [...(Math.abs(discA - discB) >= 0.5 ? [`Desconto médio: ${ppt(discA, discB)}`] : []), ...evProducts('Produtos que mais perderam faturamento')], link: 'relatorios', linkLabel: 'Ver relatório de vendas' })
    headline = mk('Faturamento', RA, RB)
  } else {
    // sem vendas em um dos períodos, toda a diferença é de movimento
    const empty = NA === 0 || NB === 0
    const volume = empty ? SA - SB : (NA - NB) * (SB / NB)
    const ticket = empty ? 0 : NA * (TA - TB) * mB
    const margin = empty ? 0 : RA * (mA - mB)
    drivers.push({ key: 'movimento', label: NA >= NB ? 'Mais vendas' : 'Menos vendas', impact: r2(volume), detail: `${NB} → ${NA} vendas no período`, evidence: [...evLost, ...evBranch()], link: 'clientes', linkLabel: 'Ver clientes' })
    drivers.push({ key: 'ticket', label: TA >= TB ? 'Ticket médio maior' : 'Ticket médio menor', impact: r2(ticket), detail: `${brl(TB)} → ${brl(TA)} por venda`, evidence: NA && NB && Math.abs(Number(sA.items) / NA - Number(sB.items) / NB) >= 0.05 ? [`Itens por venda: ${(Number(sB.items) / NB).toFixed(2).replace('.', ',')} → ${(Number(sA.items) / NA).toFixed(2).replace('.', ',')}`] : [], link: 'relatorios', linkLabel: 'Ver relatório de vendas' })
    const mev: string[] = []
    if (Math.abs(dA_ - dB_) >= 0.1) mev.push(`Margem bruta: ${ppt(dA_, dB_)} da receita`)
    if (opts.showCosts && costEffect > 1 && costUps.length) mev.push(`Custo dos mesmos produtos subiu (≈ ${brl(costEffect)} a mais de custo): ${costUps.slice(0, 3).map((c) => `${c.name} +${pct(c.pct, 0)}`).join(', ')}`)
    else if (costEffect > 1) mev.push(`Custo dos mesmos produtos subiu (≈ ${brl(costEffect)} a mais de custo)`)
    if (discA - discB >= 0.5) mev.push(`Desconto médio subiu: ${ppt(discA, discB)} (≈ ${brl((discA - discB) / 100 * Number(sA.subtotal) * (1 - t))} a menos)`)
    if (priceEffect < -1 && priceDowns.length) mev.push(`Preço efetivo dos mesmos produtos caiu (≈ ${brl(-priceEffect)}): ${priceDowns.slice(0, 3).map((p) => `${p.name} −${pct(p.pct, 0)}`).join(', ')}`)
    mev.push(...evProducts('Produtos que mais perderam contribuição'))
    drivers.push({ key: 'margem', label: margin >= 0 ? 'Margem maior' : 'Margem menor', impact: r2(margin), detail: `cada R$ 100 vendidos deixaram ${brl(mB * 100)} → ${brl(mA * 100)} após custo e impostos`, evidence: mev, link: 'analise-precos', linkLabel: 'Ver margens por produto' })
    // devoluções (o DRE desconta a devolução e devolve o custo ao estoque)
    const retA = line(dA, '4') - SA, retB = line(dB, '4') - SB
    drivers.push({ key: 'devolucoes', label: retA >= retB ? 'Menos devoluções' : 'Mais devoluções', impact: r2(retA - retB), detail: `devoluções: ${brl(-line(dB, '1.1'))} → ${brl(-line(dA, '1.1'))}`, evidence: [], link: 'trocas', linkLabel: 'Ver trocas e devoluções' })
    // despesas por grupo
    const catDelta = (group: string[]) => {
      const sum = (d: any) => { const m = new Map<string, number>(); for (const e of d.details) if (group.includes(e.dre_group)) m.set(e.name, (m.get(e.name) ?? 0) + Number(e.total)); return m }
      const a = sum(dA), b = sum(dB)
      return [...new Set([...a.keys(), ...b.keys()])].map((k) => ({ k, d: (a.get(k) ?? 0) - (b.get(k) ?? 0) })).filter((x) => Math.abs(x.d) >= 0.01).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 3)
    }
    const groups: [string, string, string[]][] = [['pessoal', 'Despesas com pessoal', ['despesas_pessoal']], ['administrativas', 'Despesas administrativas', ['despesas_administrativas']],
      ['comerciais', 'Despesas comerciais', ['despesas_comerciais']], ['outras', 'Outras despesas operacionais', ['despesas_operacionais', 'outras']]]
    const codes: Record<string, string> = { pessoal: '5.1', administrativas: '5.2', comerciais: '5.3', outras: '5.4' }
    for (const [k, label, g] of groups) {
      const va = -line(dA, codes[k]), vb = -line(dB, codes[k])
      const cd = catDelta(g)
      drivers.push({ key: 'despesa_' + k, label: va > vb ? `${label} maiores` : va < vb ? `${label} menores` : label, impact: r2(-(va - vb)), detail: `${brl(vb)} → ${brl(va)}`,
        evidence: cd.length ? [cd.map((c) => `${c.k} ${sbrl(c.d)}`).join(', ')] : [], link: 'contas-pagar', linkLabel: 'Ver contas a pagar' })
    }
    const finA = line(dA, '7.1') + line(dA, '7.2'), finB = line(dB, '7.1') + line(dB, '7.2')
    drivers.push({ key: 'financeiro', label: finA >= finB ? 'Resultado financeiro melhor' : 'Resultado financeiro pior', impact: r2(finA - finB), detail: `juros recebidos e despesas financeiras: ${sbrl(finB)} → ${sbrl(finA)}`, evidence: [], link: 'contas-pagar', linkLabel: 'Ver contas a pagar' })
    headline = mk('Resultado líquido', line(dA, '8'), line(dB, '8'))
  }
  // garante a soma exata (arredondamentos de centavos vão para o maior item)
  const nonzero = drivers.filter((d) => Math.abs(d.impact) >= 0.005)
  const diff = r2(headline.delta - nonzero.reduce((s, d) => s + d.impact, 0))
  if (Math.abs(diff) >= 0.01 && nonzero.length) { const big = [...nonzero].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))[0]; big.impact = r2(big.impact + diff) }
  const ordered = nonzero.sort((a, b) => a.impact - b.impact)
  // efeitos pequenos (centavos, oscilações irrelevantes) continuam na soma, mas não são destacados
  const materiality = Math.max(1, Math.abs(headline.delta) * 0.005, Math.max(RA, RB) * 0.001)
  for (const d of ordered) if (Math.abs(d.impact) < materiality) d.minor = true

  // ---- sinais fora da soma ----
  const attention: string[] = []
  if (cA.n > cB.n && cA.v - cB.v > 0) attention.push(`Cancelamentos aumentaram: ${cB.n} → ${cA.n} venda(s) (${brl(cB.v)} → ${brl(cA.v)}).`)
  const share = (v: number, r: number) => (r ? v / r * 100 : 0)
  const fsA = share(Number(fA.v), RA), fsB = share(Number(fB.v), RB)
  if (Number(fA.v) > 1 && fsA - fsB >= 0.3) attention.push(`Taxas de cartão subiram de ${pct(fsB)} para ${pct(fsA)} do faturamento (${brl(fB.v)} → ${brl(fA.v)}). Só entram no DRE se forem lançadas em contas a pagar.`)
  const ksA = share(kA, RA), ksB = share(kB, RB)
  if (kA > 1 && ksA - ksB >= 1) attention.push(`Comissões subiram de ${pct(ksB)} para ${pct(ksA)} do faturamento (${brl(kB)} → ${brl(kA)}). Só entram no DRE quando lançadas em contas a pagar.`)

  // ---- confiança ----
  const reasons: string[] = []
  let level: 'alta' | 'media' | 'baixa' = 'alta'
  const noCostShare = RA ? Number(ncA.v) / RA * 100 : 0
  if (focus === 'lucro' && noCostShare >= 5) { level = noCostShare >= 20 ? 'baixa' : 'media'; reasons.push(`${pct(noCostShare, 0)} do faturamento do período veio de produtos sem custo cadastrado, o que deixa a margem maior do que a real`) }
  if (NA < 10 || NB < 10) { level = 'baixa'; reasons.push(`poucas vendas para comparar (${NB} no período anterior, ${NA} no atual)`) }
  const expA = dA.details.filter((e: any) => String(e.dre_group).startsWith('despesas')).length, expB = dB.details.filter((e: any) => String(e.dre_group).startsWith('despesas')).length
  if (focus === 'lucro' && (expA === 0 || expB === 0)) { if (level === 'alta') level = 'media'; reasons.push(expA === 0 && expB === 0 ? 'não há despesas lançadas em contas a pagar nos dois períodos: o resultado considera só as vendas' : `não há despesas lançadas em contas a pagar no período ${expA === 0 ? 'atual' : 'anterior'}`) }
  if (P.key === 'mes' && P.days < 7) { if (level === 'alta') level = 'media'; reasons.push('o mês começou há poucos dias') }

  // ---- por onde começar ----
  const actions: Diagnosis['actions'] = []
  for (const d of ordered.filter((x) => x.impact < 0 && !x.minor).slice(0, 3)) {
    if (d.key === 'movimento') actions.push({ text: Number(lost.n) > 0 ? `Reative os ${lost.n} clientes que não voltaram (lembrete ou oferta pelo WhatsApp, com consentimento).` : 'Reforce a captação: campanha para a base de clientes e divulgação no período de menor movimento.', link: 'clientes', linkLabel: 'Ver clientes' })
    else if (d.key === 'ticket') actions.push({ text: 'Aumente o ticket: sugira complementos e kits no PDV e destaque os mais vendidos.', link: 'relatorios', linkLabel: 'Ver mais vendidos' })
    else if (d.key === 'margem') {
      if (opts.showCosts && costUps.length) actions.push({ text: `Reprecifique ou renegocie os itens cujo custo subiu (${costUps.slice(0, 2).map((c) => c.name).join(', ')}).`, link: 'analise-precos', linkLabel: 'Ver precificação' })
      if (discA - discB >= 0.5) actions.push({ text: 'Revise a política de descontos e a alçada de aprovação.', link: 'relatorios', linkLabel: 'Ver descontos' })
      if (!(opts.showCosts && costUps.length) && !(discA - discB >= 0.5)) actions.push({ text: 'Dê destaque aos produtos de maior margem e confira os preços dos que perderam contribuição.', link: 'analise-precos', linkLabel: 'Ver margens' })
    }
    else if (d.key === 'devolucoes') actions.push({ text: 'Veja os motivos das devoluções do período e os produtos mais devolvidos.', link: 'trocas', linkLabel: 'Ver devoluções' })
    else if (d.key.startsWith('despesa_')) actions.push({ text: `Confira os lançamentos de ${d.label.toLowerCase().replace(/ maiores$/, '')}${d.evidence[0] ? ` (${d.evidence[0]})` : ''}: valor fora do comum ou lançado no mês errado?`, link: 'contas-pagar', linkLabel: 'Ver contas a pagar' })
    else if (d.key === 'financeiro') actions.push({ text: 'Confira tarifas e juros pagos no período.', link: 'contas-pagar', linkLabel: 'Ver contas a pagar' })
  }

  const kpis: Diagnosis['kpis'] = {
    revenue: { current: r2(RA), previous: r2(RB) }, sales: { current: NA, previous: NB }, ticket: { current: r2(TA), previous: r2(TB) },
    discountPct: { current: r2(discA), previous: r2(discB) },
    // margem e resultado só no diagnóstico do lucro (exige acesso ao financeiro/contabilidade)
    ...(focus === 'lucro' ? { grossMarginPct: { current: r2(dA_), previous: r2(dB_) }, net: { current: line(dA, '8'), previous: line(dB, '8') } } : {}),
  }
  return {
    focus, headline, kpis, drivers: ordered, attention, actions: dedupe(actions), confidence: { level, reasons },
    periods: { ...P, currentLabel: `${br(P.from)} a ${br(P.to)}`, previousLabel: `${br(P.prevFrom)} a ${br(P.prevTo)}` },
    method: focus === 'lucro'
      ? `Comparação do DRE gerencial (imposto estimado de ${pct(t * 100, 1)}) entre os dois períodos. As causas somam exatamente a variação do resultado. Empresa toda, todas as filiais.`
      : 'Faturamento = número de vendas × ticket médio. As causas somam exatamente a variação. Empresa toda, todas as filiais.',
    generatedAt: new Date().toISOString(),
  }
}

function mk(metric: string, current: number, previous: number): Diagnosis['headline'] {
  const delta = r2(current - previous)
  const p = previous !== 0 ? r2(delta / Math.abs(previous) * 100) : null
  const rel = Math.abs(delta) <= Math.max(1, Math.abs(previous) * 0.01)
  return { metric, current: r2(current), previous: r2(previous), delta, pct: p, direction: rel ? 'estavel' : delta < 0 ? 'caiu' : 'subiu' }
}
function dedupe<T extends { text: string }>(xs: T[]) { const s = new Set<string>(); return xs.filter((x) => (s.has(x.text) ? false : (s.add(x.text), true))) }

/** Texto do pré-diagnóstico para a AXIA. */
export function diagnosisText(d: Diagnosis): string {
  const h = d.headline
  const out: string[] = []
  out.push(`Pré-diagnóstico ${d.focus === 'lucro' ? 'do lucro' : 'do faturamento'}: ${d.periods.label} (${d.periods.currentLabel}) comparado a ${d.periods.previousLabel}.`)
  const pctTxt = h.previous > 0 && h.current < 0 ? '; passou de lucro para prejuízo' : h.previous < 0 && h.current > 0 ? '; saiu do prejuízo' : h.previous < 0 ? '' : h.pct === null ? '' : `; ${h.pct > 0 ? '+' : '−'}${pct(Math.abs(h.pct))}`
  if (h.direction === 'estavel') out.push(`${h.metric} praticamente estável: ${brl(h.previous)} → ${brl(h.current)}.`)
  else out.push(`${h.metric}: ${brl(h.previous)} → ${brl(h.current)} (${sbrl(h.delta)}${pctTxt}).${h.direction === 'subiu' ? (d.drivers.some((x) => x.impact < 0 && !x.minor) ? ' Não houve queda no período; mesmo assim, veja o que puxou para baixo.' : ' Não houve queda no período.') : ''}`)
  const neg = d.drivers.filter((x) => x.impact < 0 && !x.minor), pos = d.drivers.filter((x) => x.impact > 0 && !x.minor).reverse()
  const minor = r2(d.drivers.filter((x) => x.minor).reduce((a, x) => a + x.impact, 0))
  if (neg.length) {
    out.push('', 'O que mais pesou:')
    neg.slice(0, 4).forEach((x, i) => { out.push(`${i + 1}. ${x.label}: ${sbrl(x.impact)} (${x.detail}).`); x.evidence.slice(0, 3).forEach((e) => out.push(`   • ${e}`)) })
  }
  if (pos.length) { out.push('', 'O que ajudou:'); pos.slice(0, 3).forEach((x) => out.push(`• ${x.label}: ${sbrl(x.impact)} (${x.detail}).`)) }
  if (Math.abs(minor) >= 1) out.push(`(Outros efeitos pequenos somam ${sbrl(minor)}.)`)
  if (d.attention.length) { out.push('', 'Também vale olhar:'); d.attention.forEach((a) => out.push(`• ${a}`)) }
  if (d.actions.length) { out.push('', 'Por onde começar:'); d.actions.forEach((a) => out.push(`• ${a.text}`)) }
  out.push('', `Confiança: ${d.confidence.level === 'media' ? 'média' : d.confidence.level}${d.confidence.reasons.length ? ` (${d.confidence.reasons.join('; ')})` : ''}.`)
  out.push(d.method)
  return out.join('\n')
}
