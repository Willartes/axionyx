/**
 * Motor de precificação (cálculo puro, sem banco — testável isoladamente).
 *
 * Método do markup divisor (padrão em varejo):
 *   custo variável unitário (CVu) = custo de aquisição + frete + seguro + embalagem + armazenagem + outros + perdas + custos variáveis por unidade
 *   despesas variáveis (DV%)     = impostos + cartão + comissão + marketplace + ... (percentuais sobre o PREÇO)
 *   rateio de custos fixos (CF%) = custos fixos mensais ÷ faturamento mensal de referência (opcional)
 *   divisor                      = 1 − (DV% + CF% + margem líquida desejada%)
 *   preço sugerido               = CVu ÷ divisor            (markup multiplicador = 1 ÷ divisor)
 *
 * Por que não "custo + margem": somar a margem sobre o custo e só depois pagar taxas percentuais entrega menos
 * lucro do que o desejado. O divisor garante que, do preço, sobrem exatamente as taxas, o rateio fixo e a margem.
 *
 * Todos os percentuais de entrada/saída estão em pontos percentuais (30 = 30%).
 */

export type PricingMode = 'margem' | 'markup' | 'preco'
export type Rounding = 'nenhum' | 'centavos_90' | 'centavos_99' | 'inteiro'

export interface PricingInput {
  acquisitionCost: number
  freight?: number
  insurance?: number
  packaging?: number
  storage?: number
  otherCosts?: number
  lossesPct?: number            // perdas/avarias sobre o custo de aquisição (%)
  unitVariableCosts?: number    // soma dos custos variáveis cadastrados "por unidade"
  variablePct: number           // soma das despesas variáveis sobre o preço (%)
  fixedPct?: number             // rateio de custos fixos sobre o faturamento (%) — 0 se não ratear
  desiredMarginPct?: number     // lucro líquido desejado sobre o preço (%)
  mode?: PricingMode
  markup?: number               // multiplicador desejado (modo 'markup')
  price?: number                // preço informado (modo 'preco' — analisa um preço existente/praticado)
  rounding?: Rounding
  monthlyFixedCosts?: number    // para ponto de equilíbrio por produto
  currentPrice?: number | null  // preço atual cadastrado (comparação)
}

export interface PricingResult {
  unitCost: number              // custo variável unitário total (CVu)
  costBreakdown: { acquisition: number; freight: number; insurance: number; packaging: number; storage: number; other: number; losses: number; unitVariable: number }
  variablePct: number
  fixedPct: number
  desiredMarginPct: number
  divisor: number               // markup divisor
  markupMultiplier: number      // índice multiplicador sobre o CVu (1/divisor no modo margem)
  floorPrice: number            // cobre só custos e despesas variáveis (margem de contribuição zero)
  minimumPrice: number          // cobre variáveis + rateio fixo (lucro zero) — preço de equilíbrio
  suggestedPrice: number        // preço final (após arredondamento)
  rawPrice: number              // preço antes do arredondamento
  variableExpenses: number      // R$ de despesas variáveis no preço final
  contributionUnit: number      // margem de contribuição unitária (R$)
  contributionPct: number       // margem de contribuição (% do preço)
  fixedShare: number            // R$ de rateio de custos fixos no preço
  netProfitUnit: number         // lucro líquido unitário (R$)
  netMarginPct: number          // margem líquida (% do preço)
  grossMarginPct: number        // margem bruta: (preço − CVu) ÷ preço
  markupOnCost: number          // markup sobre o custo: (preço ÷ CVu − 1) em %
  breakevenUnits: number | null // unidades/mês deste produto para cobrir sozinho os custos fixos
  breakevenRevenue: number | null
  currentPrice: number | null
  currentAnalysis: { contributionUnit: number; contributionPct: number; netProfitUnit: number; netMarginPct: number; markupMultiplier: number; belowMinimum: boolean; belowFloor: boolean } | null
  warnings: string[]
}

export class PricingError extends Error {}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
const r4 = (v: number) => Math.round((v + Number.EPSILON) * 10000) / 10000
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

export function roundPrice(p: number, rule: Rounding = 'nenhum'): number {
  if (!(p > 0)) return r2(p)
  switch (rule) {
    case 'centavos_90': { const b = Math.floor(p); return b + 0.9 >= p - 1e-9 ? r2(b + 0.9) : r2(b + 1.9) }
    case 'centavos_99': { const b = Math.floor(p); return b + 0.99 >= p - 1e-9 ? r2(b + 0.99) : r2(b + 1.99) }
    case 'inteiro': return Math.ceil(p - 1e-9)
    default: return r2(p)
  }
}

/** Analisa um preço: margem de contribuição, rateio fixo e lucro, dados CVu e percentuais. */
function analyze(price: number, unitCost: number, variablePct: number, fixedPct: number) {
  const variableExpenses = price * variablePct / 100
  const contributionUnit = price - unitCost - variableExpenses
  const fixedShare = price * fixedPct / 100
  const netProfitUnit = contributionUnit - fixedShare
  return {
    variableExpenses, contributionUnit, fixedShare, netProfitUnit,
    contributionPct: price > 0 ? contributionUnit / price * 100 : 0,
    netMarginPct: price > 0 ? netProfitUnit / price * 100 : 0,
    markupMultiplier: unitCost > 0 ? price / unitCost : 0,
  }
}

export function calculatePrice(input: PricingInput): PricingResult {
  const acquisition = Math.max(0, n(input.acquisitionCost))
  const b = {
    acquisition, freight: Math.max(0, n(input.freight)), insurance: Math.max(0, n(input.insurance)), packaging: Math.max(0, n(input.packaging)),
    storage: Math.max(0, n(input.storage)), other: Math.max(0, n(input.otherCosts)), losses: acquisition * Math.max(0, n(input.lossesPct)) / 100,
    unitVariable: Math.max(0, n(input.unitVariableCosts)),
  }
  const unitCost = b.acquisition + b.freight + b.insurance + b.packaging + b.storage + b.other + b.losses + b.unitVariable
  const variablePct = Math.max(0, n(input.variablePct))
  const fixedPct = Math.max(0, n(input.fixedPct))
  const desiredMarginPct = n(input.desiredMarginPct)
  const mode: PricingMode = input.mode ?? 'margem'
  const warnings: string[] = []

  if (unitCost <= 0) throw new PricingError('Informe o custo do produto (custo de aquisição maior que zero).')
  if (variablePct >= 100) throw new PricingError('A soma das despesas variáveis sobre o preço não pode chegar a 100%.')
  if (variablePct + fixedPct >= 100) throw new PricingError(`Despesas variáveis (${variablePct.toFixed(2)}%) + rateio de custos fixos (${fixedPct.toFixed(2)}%) chegam a 100% ou mais: não existe preço que cubra os custos. Revise os custos fixos ou o faturamento de referência.`)

  const floorPrice = unitCost / (1 - variablePct / 100)
  const minimumPrice = unitCost / (1 - (variablePct + fixedPct) / 100)

  let rawPrice: number
  let divisor: number
  if (mode === 'markup') {
    const mk = n(input.markup)
    if (mk <= 0) throw new PricingError('Informe o markup multiplicador desejado (ex.: 2,2).')
    rawPrice = unitCost * mk
    divisor = 1 / mk
  } else if (mode === 'preco') {
    rawPrice = n(input.price)
    if (rawPrice <= 0) throw new PricingError('Informe o preço a analisar.')
    divisor = unitCost / rawPrice
  } else {
    divisor = 1 - (variablePct + fixedPct + desiredMarginPct) / 100
    if (divisor <= 0) throw new PricingError(`Despesas variáveis + rateio fixo + margem desejada somam ${(100 - divisor * 100).toFixed(2)}%: não existe preço que atinja essa margem. Reduza a margem desejada ou os percentuais.`)
    rawPrice = unitCost / divisor
  }
  const suggestedPrice = mode === 'preco' ? r2(rawPrice) : roundPrice(rawPrice, input.rounding ?? 'nenhum')
  const a = analyze(suggestedPrice, unitCost, variablePct, fixedPct)

  const monthlyFixed = Math.max(0, n(input.monthlyFixedCosts))
  let breakevenUnits: number | null = null, breakevenRevenue: number | null = null
  if (monthlyFixed > 0 && a.contributionUnit > 0) {
    breakevenUnits = Math.ceil(monthlyFixed / a.contributionUnit - 1e-9)
    breakevenRevenue = r2(breakevenUnits * suggestedPrice)
  }

  if (a.contributionUnit <= 0) warnings.push('Margem de contribuição negativa ou zero: cada venda neste preço aumenta o prejuízo.')
  else if (a.netProfitUnit < 0) warnings.push('O preço cobre os custos variáveis, mas não a parcela de custos fixos: lucro líquido negativo.')
  if (mode !== 'margem' && desiredMarginPct && a.netMarginPct < desiredMarginPct - 0.01) warnings.push(`Margem líquida (${a.netMarginPct.toFixed(2)}%) abaixo da desejada (${desiredMarginPct.toFixed(2)}%).`)
  if (mode === 'margem' && suggestedPrice !== r2(rawPrice)) warnings.push(`Preço arredondado de ${r2(rawPrice).toFixed(2)} para ${suggestedPrice.toFixed(2)}.`)

  let currentAnalysis: PricingResult['currentAnalysis'] = null
  const cur = input.currentPrice != null ? n(input.currentPrice) : null
  if (cur && cur > 0) {
    const c = analyze(cur, unitCost, variablePct, fixedPct)
    currentAnalysis = { contributionUnit: r2(c.contributionUnit), contributionPct: r4(c.contributionPct), netProfitUnit: r2(c.netProfitUnit), netMarginPct: r4(c.netMarginPct),
      markupMultiplier: r4(c.markupMultiplier), belowMinimum: cur < minimumPrice - 0.005, belowFloor: cur < floorPrice - 0.005 }
  }

  return {
    unitCost: r2(unitCost), costBreakdown: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, r2(v)])) as PricingResult['costBreakdown'],
    variablePct: r4(variablePct), fixedPct: r4(fixedPct), desiredMarginPct: r4(desiredMarginPct),
    divisor: r4(divisor), markupMultiplier: r4(unitCost > 0 ? suggestedPrice / unitCost : 0),
    floorPrice: r2(floorPrice), minimumPrice: r2(minimumPrice), suggestedPrice, rawPrice: r2(rawPrice),
    variableExpenses: r2(a.variableExpenses), contributionUnit: r2(a.contributionUnit), contributionPct: r4(a.contributionPct),
    fixedShare: r2(a.fixedShare), netProfitUnit: r2(a.netProfitUnit), netMarginPct: r4(a.netMarginPct),
    grossMarginPct: r4(suggestedPrice > 0 ? (suggestedPrice - unitCost) / suggestedPrice * 100 : 0),
    markupOnCost: r4(unitCost > 0 ? (suggestedPrice / unitCost - 1) * 100 : 0),
    breakevenUnits, breakevenRevenue, currentPrice: cur, currentAnalysis, warnings,
  }
}

export interface CompanyIndicatorsInput {
  revenue: number          // faturamento mensal (média do período)
  cmv: number              // custo das mercadorias vendidas no mês (média)
  variablePct: number      // despesas variáveis sobre o faturamento (%)
  unitVariableTotal: number // custos variáveis "por unidade" × peças vendidas no mês
  fixedCosts: number       // custos fixos mensais
  desiredMarginPct: number // lucro líquido desejado (%)
}

/** Indicadores gerenciais da empresa: margem de contribuição, ponto de equilíbrio, margem de segurança, alavancagem. */
export function companyIndicators(i: CompanyIndicatorsInput) {
  const revenue = Math.max(0, n(i.revenue))
  const variableExpenses = revenue * n(i.variablePct) / 100 + Math.max(0, n(i.unitVariableTotal))
  const contribution = revenue - n(i.cmv) - variableExpenses
  const contributionPct = revenue > 0 ? contribution / revenue * 100 : 0
  const fixed = Math.max(0, n(i.fixedCosts))
  const operatingProfit = contribution - fixed
  const breakevenRevenue = contributionPct > 0 ? fixed / (contributionPct / 100) : null
  const safetyMarginValue = breakevenRevenue !== null ? revenue - breakevenRevenue : null
  const safetyMarginPct = breakevenRevenue !== null && revenue > 0 ? (revenue - breakevenRevenue) / revenue * 100 : null
  const operatingLeverage = operatingProfit > 0 ? contribution / operatingProfit : null
  const mcMinusTarget = contributionPct - n(i.desiredMarginPct)
  const revenueForTarget = mcMinusTarget > 0 ? fixed / (mcMinusTarget / 100) : null
  return {
    revenue: r2(revenue), cmv: r2(n(i.cmv)), cmvPct: r4(revenue > 0 ? n(i.cmv) / revenue * 100 : 0), variableExpenses: r2(variableExpenses),
    variableExpensesPct: r4(revenue > 0 ? variableExpenses / revenue * 100 : 0), contribution: r2(contribution), contributionPct: r4(contributionPct),
    fixedCosts: r2(fixed), fixedPct: r4(revenue > 0 ? fixed / revenue * 100 : 0), operatingProfit: r2(operatingProfit),
    netMarginPct: r4(revenue > 0 ? operatingProfit / revenue * 100 : 0),
    breakevenRevenue: breakevenRevenue === null ? null : r2(breakevenRevenue), safetyMarginValue: safetyMarginValue === null ? null : r2(safetyMarginValue),
    safetyMarginPct: safetyMarginPct === null ? null : r4(safetyMarginPct), operatingLeverage: operatingLeverage === null ? null : r4(operatingLeverage),
    revenueForTarget: revenueForTarget === null ? null : r2(revenueForTarget), desiredMarginPct: r4(n(i.desiredMarginPct)),
  }
}
