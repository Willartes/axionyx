import type { Q } from '../core/db'
import { compararHoldout, compararProducao, selecionarMelhor, score, type Resultado } from './methods'

/**
 * Previsão de demanda com a mesma lógica da tela do AXIONYX ERP (JavaFX): holdout cronológico 80/20 em rodadas do
 * tamanho do horizonte, seleção pelo menor RMSE + MAPE e previsão de produção do MESMO método treinado na série toda.
 *
 * Diferenças deliberadas em relação ao original, só na SÉRIE (os algoritmos são idênticos):
 *  - períodos sem venda entram como zero (no original eles sumiam da série, distorcendo produtos que não vendem sempre);
 *  - vendas canceladas ficam de fora e as devoluções são descontadas;
 *  - faturamento é o valor líquido dos descontos (sem frete);
 *  - o período em andamento (semana ou mês atual, incompleto) não entra no treino, nem o primeiro período quando a
 *    empresa começou a usar o sistema no meio dele;
 *  - granularidade semanal ou mensal, conforme a empresa.
 */
export type Periodo = 'semanal' | 'mensal'
export const PROPORCAO_TREINO = 0.8
export const LIMITES = { semanal: { historico: 104, horizontes: [1, 2, 3, 4, 6, 8, 12] }, mensal: { historico: 36, horizontes: [1, 2, 3, 6, 12] } } as const

const NOMES: Record<string, string> = {
  'Naive': 'Naive (último período)', 'Media Movel (3)': 'Média móvel (3 períodos)', 'Suavizacao Exponencial (alpha=0.3)': 'Suavização exponencial (α = 0,3)',
  'Regressao Linear': 'Regressão linear', 'ARIMA(1,1,1)': 'ARIMA(1,1,1)', 'RNA PMC/MLP (janela=3, ocultos=5)': 'Rede neural MLP (janela 3, 5 neurônios)',
}
const nomeBase = (nome: string) => nome.replace(/ \(dados insuficientes.*$/, '')
export const nomeExibicao = (nome: string) => NOMES[nomeBase(nome)] ?? nomeBase(nome)

export interface Ponto { inicio: string; valor: number }
export async function serieHistorica(c: Q, o: { companyId: string; branches: string[]; productId: string | null; periodo: Periodo; tz: string }): Promise<{ pontos: Ponto[]; atual: { inicio: string; valor: number } }> {
  const unit = o.periodo === 'mensal' ? 'month' : 'week'
  const step = o.periodo === 'mensal' ? '1 month' : '1 week'
  const max = LIMITES[o.periodo].historico
  // valor de cada item: quantidade líquida de devoluções; faturamento líquido de descontos e proporcional ao que não foi devolvido
  const rows = await c.many(`
    WITH params AS (SELECT date_trunc('${unit}', (now() AT TIME ZONE $4)) AS atual),
    vendas AS (
      SELECT date_trunc('${unit}', s.created_at AT TIME ZONE $4) AS p,
             sum(si.qty - si.returned_qty)::float8 AS qtd,
             sum(CASE WHEN si.qty > 0 THEN si.total * (si.qty - si.returned_qty) / si.qty ELSE 0 END)::float8 AS fat
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
       WHERE s.company_id = $1 AND s.type = 'venda' AND s.status <> 'cancelada'
         AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[]))
         AND ($3::uuid IS NULL OR si.variant_id IN (SELECT id FROM product_variants WHERE product_id = $3 AND company_id = $1))
         AND s.created_at >= ((SELECT atual FROM params) - interval '${step}' * ${max}) AT TIME ZONE $4
       GROUP BY 1),
    -- empresa que começou a vender no meio de um período: esse primeiro período fica de fora (estaria incompleto)
    uso AS (SELECT min(created_at AT TIME ZONE $4) AS primeira FROM sales WHERE company_id = $1 AND type = 'venda' AND status <> 'cancelada'),
    inicio AS (SELECT GREATEST(min(p), (SELECT atual FROM params) - interval '${step}' * ${max},
                               (SELECT CASE WHEN primeira > date_trunc('${unit}', primeira) + interval '1 day' THEN date_trunc('${unit}', primeira) + interval '${step}' ELSE date_trunc('${unit}', primeira) END FROM uso)) AS ini
                 FROM vendas WHERE p < (SELECT atual FROM params))
    SELECT to_char(g, 'YYYY-MM-DD') AS inicio, COALESCE(${o.productId ? 'v.qtd' : 'v.fat'}, 0)::float8 AS valor, g = (SELECT atual FROM params) AS atual
      FROM inicio, generate_series(inicio.ini, (SELECT atual FROM params), interval '${step}') g
      LEFT JOIN vendas v ON v.p = g
     WHERE inicio.ini IS NOT NULL
     ORDER BY g`, [o.companyId, o.branches.length ? o.branches : null, o.productId, o.tz])
  const atualRow = rows.find((r: any) => r.atual)
  return {
    pontos: rows.filter((r: any) => !r.atual).map((r: any) => ({ inicio: r.inicio, valor: Math.round(Number(r.valor) * 1000) / 1000 })),
    atual: atualRow ? { inicio: atualRow.inicio, valor: Number(atualRow.valor) } : { inicio: '', valor: 0 },
  }
}

/** Datas de início dos próximos períodos (para o gráfico). */
export function proximosPeriodos(ultimo: string, periodo: Periodo, n: number, incluirAtual: string): string[] {
  const out: string[] = []
  let [y, m, d] = (incluirAtual || ultimo).split('-').map(Number)
  if (!incluirAtual) { const dt = new Date(Date.UTC(y, m - 1, d)); if (periodo === 'mensal') dt.setUTCMonth(dt.getUTCMonth() + 1); else dt.setUTCDate(dt.getUTCDate() + 7); [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()] }
  for (let k = 0; k < n; k++) {
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (periodo === 'mensal') dt.setUTCMonth(dt.getUTCMonth() + k); else dt.setUTCDate(dt.getUTCDate() + 7 * k)
    out.push(dt.toISOString().slice(0, 10))
  }
  return out
}

const arred = (v: number) => Math.round(v * 100) / 100
const br = (v: number) => arred(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
const fin = (v: number) => (Number.isFinite(v) ? v : null)

/** ForecastEvaluationService.avaliar com o modelo já escolhido (RMSE + MAPE): conclusão, fatos, limitações e confiança. */
export function avaliacao(rs: Resultado[], melhor: number, n: number, periodo: Periodo) {
  const m = rs[melhor]
  const un = periodo === 'mensal' ? 'meses' : 'semanas'
  const naive = rs.find((r) => nomeBase(r.nome) === 'Naive')
  const difNaive = naive && naive !== m && Number.isFinite(naive.rmse) && naive.rmse > 0 ? ((naive.rmse - m.rmse) / naive.rmse) * 100 : null
  const confianca = n >= 24 ? 'alta' : n >= 12 ? 'média' : 'baixa'
  const nome = nomeExibicao(m.nome)
  const fatos = [`${nome} teve a menor pontuação de seleção (RMSE ${br(m.rmse)}, MAE ${br(m.mae)}, sMAPE ${Number.isFinite(m.smape) ? br(m.smape) + '%' : 'não calculável'}).`]
  if (difNaive !== null) fatos.push(`${nome} ${difNaive >= 0 ? 'superou' : 'NÃO superou'} o Naive em ${br(Math.abs(difNaive))}% de RMSE.`)
  const limitacoes = ['Métricas medidas por holdout cronológico (80% treino / 20% teste, sem retreinamento): o erro é fora da amostra, mas não equivale a acompanhar a previsão em produção com dados novos.']
  if (periodo === 'semanal' && n < 104) limitacoes.push(`Apenas ${n} semanas de histórico: sazonalidade anual só é capturada com pelo menos 104 semanas (2 ciclos).`)
  if (periodo === 'mensal' && n < 24) limitacoes.push(`Apenas ${n} meses de histórico: sazonalidade anual precisa de pelo menos 24 meses (2 ciclos completos).`)
  if (rs.some((r) => r.fallback)) limitacoes.push('Métodos que exigem mais histórico (ARIMA e rede neural) usaram o Naive como substituto: veja a indicação na tabela.')
  let conclusao = `Para esta série e este horizonte, ${nome} apresentou o melhor desempenho, com RMSE de ${br(m.rmse)}, MAE de ${br(m.mae)}${Number.isFinite(m.smape) ? ` e sMAPE de ${br(m.smape)}%` : ''}. `
  if (difNaive !== null) conclusao += difNaive >= 0 ? `Superou o modelo Naive em ${br(Math.abs(difNaive))}%. ` : `Não superou o Naive (ficou ${br(Math.abs(difNaive))}% pior): vale considerar o Naive pela simplicidade. `
  conclusao += `A confiança é ${confianca}, pois há ${n} ${un} de histórico.`
  return {
    conclusao, fatos, limitacoes, confianca, diferencaNaivePct: difNaive === null ? null : arred(difNaive),
    justificativa: `Escolhido pela menor pontuação RMSE + MAPE entre os ${rs.length} métodos avaliados (o mesmo critério do sistema original), nunca por ser o mais complexo.`,
    recomendacao: confianca === 'baixa' ? 'Use como referência inicial: colete mais histórico antes de decidir compras com base nesta previsão.' : 'Adequada para apoiar decisões de reposição de estoque e planejamento de compras.',
  }
}

export function preverDemanda(pontos: Ponto[], horizonte: number, periodo: Periodo) {
  const valores = pontos.map((p) => p.valor)
  const ho = compararHoldout(valores, PROPORCAO_TREINO, horizonte)
  const melhor = selecionarMelhor(ho.resultados)
  const prod = compararProducao(valores, horizonte)
  const metodos = ho.resultados.map((r, i) => ({
    nome: nomeExibicao(r.nome), nomeOriginal: r.nome, fallback: !!r.fallback,
    mae: fin(r.mae), rmse: fin(r.rmse), mape: fin(r.mape), bias: fin(r.bias), smape: fin(r.smape), r2: fin(r.r2), score: fin(score(r)), ms: Math.round(r.ms * 10) / 10,
    teste: r.previsao.map((v) => Math.max(0, arred(v))),
    previsao: prod[i].previsao.map((v) => Math.max(0, arred(v))),
  }))
  return { nTreino: ho.nTreino, melhor, metodos, avaliacao: avaliacao(ho.resultados, melhor, valores.length, periodo) }
}
