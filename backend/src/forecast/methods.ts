/**
 * Métodos de previsão de demanda portados FIELMENTE do AXIONYX ERP (JavaFX), pacote com.axionyx.erp.forecast.method:
 * Naive, Média Móvel (3), Suavização Exponencial (α=0,3), Regressão Linear, ARIMA(1,1,1) por Hannan-Rissanen e
 * RNA PMC/MLP (janela 3, 5 neurônios ocultos, 300 épocas, taxa 0,1, semente 42).
 *
 * Cada método tem:
 *  - gerar(historico, horizonte): ajuste sobre a série inteira + previsão futura (produção);
 *  - avaliarHoldout(serie, nTreino, horizonte): parâmetros ajustados SÓ no treino e, sem retreinar, previsões para o
 *    teste em rodadas de `horizonte` passos; a janela de cada rodada é recomposta com valores REAIS já observados.
 *
 * A equivalência numérica com o código Java original é conferida em src/test/previsao.test.ts contra resultados
 * gerados pelo próprio Java (inclusive o gerador java.util.Random e a decomposição QR do commons-math 3.6.1).
 */

export interface Resultado {
  nome: string
  ajuste: number[]   // valor ajustado para cada ponto (NaN quando indefinido); no holdout: NaN no treino + previsões do teste
  previsao: number[] // produção: próximos `horizonte` períodos; holdout: previsões do teste
  mae: number; rmse: number; mape: number; bias: number; smape: number; r2: number
  fallback?: boolean // dados insuficientes: usou o Naive
}

// ---------------- métricas (MetodoForecast.calcularMetricas / calcularMetricasCompletas) ----------------
export function metricas(reais: number[], ajustados: number[]): [number, number, number, number] {
  let somaAbs = 0, somaQuad = 0, somaPerc = 0, somaErro = 0, n = 0, nPerc = 0
  for (let i = 0; i < reais.length; i++) {
    const a = ajustados[i]
    if (a === undefined || a === null || Number.isNaN(a)) continue
    const real = reais[i], erro = real - a
    somaAbs += Math.abs(erro); somaQuad += erro * erro; somaErro += erro; n++
    if (real !== 0) { somaPerc += Math.abs(erro / real); nPerc++ }
  }
  if (n === 0) return [NaN, NaN, NaN, NaN]
  return [somaAbs / n, Math.sqrt(somaQuad / n), nPerc > 0 ? (somaPerc / nPerc) * 100 : NaN, somaErro / n]
}
export function metricasCompletas(reais: number[], ajustados: number[]): [number, number, number, number, number, number] {
  const b = metricas(reais, ajustados)
  let somaSmape = 0, somaRes = 0, somaTot = 0, nSmape = 0, n = 0
  const media = reais.length ? reais.reduce((s, v) => s + v, 0) / reais.length : 0
  for (let i = 0; i < reais.length; i++) {
    const a = ajustados[i]
    if (a === undefined || a === null || Number.isNaN(a)) continue
    const real = reais[i], erro = real - a
    n++
    const den = Math.abs(real) + Math.abs(a)
    if (den > 1e-9) { somaSmape += Math.abs(erro) / den; nSmape++ }
    somaRes += erro * erro; somaTot += (real - media) * (real - media)
  }
  const smape = nSmape > 0 ? (somaSmape / nSmape) * 200 : NaN
  const r2 = n > 0 && somaTot > 1e-9 ? 1 - somaRes / somaTot : NaN
  return [b[0], b[1], b[2], b[3], smape, r2]
}
const placeholderHoldout = (nTreino: number, prev: number[]) => [...Array<number>(nTreino).fill(NaN), ...prev]
const mk = (nome: string, ajuste: number[], previsao: number[], m: number[]): Resultado =>
  ({ nome, ajuste, previsao, mae: m[0], rmse: m[1], mape: m[2], bias: m[3], smape: m[4] ?? NaN, r2: m[5] ?? NaN })
/** Score de seleção do Java (ResultadoForecast.getScore): RMSE + MAPE (MAPE indefinido vale 999). */
export const score = (r: Resultado) => r.rmse + (Number.isFinite(r.mape) ? r.mape : 999)

export interface Metodo { nome: string; gerar(h: number[], horizonte: number): Resultado; avaliarHoldout(s: number[], nTreino: number, horizonte: number): Resultado }

// ---------------- Naive ----------------
export const naive: Metodo = {
  nome: 'Naive',
  gerar(h, horizonte) {
    const ajuste = [NaN]
    for (let i = 1; i < h.length; i++) ajuste.push(h[i - 1])
    const ultimo = h.length ? h[h.length - 1] : 0
    return mk('Naive', h.length ? ajuste : [NaN], Array(horizonte).fill(ultimo), metricasCompletas(h, ajuste))
  },
  avaliarHoldout(s, nTreino, horizonte) {
    const n = s.length, prev: number[] = []
    for (let ini = nTreino; ini < n; ini += horizonte) { const fim = Math.min(ini + horizonte, n), ult = s[ini - 1]; for (let t = ini; t < fim; t++) prev.push(ult) }
    return mk('Naive', placeholderHoldout(nTreino, prev), prev, metricasCompletas(s.slice(nTreino), prev))
  },
}

// ---------------- Média Móvel ----------------
export function mediaMovel(janela: number): Metodo {
  const nome = `Media Movel (${janela})`
  return {
    nome,
    gerar(h, horizonte) {
      const ajuste: number[] = []
      for (let i = 0; i < h.length; i++) { if (i < janela) ajuste.push(NaN); else { let s = 0; for (let j = i - janela; j < i; j++) s += h[j]; ajuste.push(s / janela) } }
      const n = h.length
      let media: number
      if (n >= janela) { let s = 0; for (let j = n - janela; j < n; j++) s += h[j]; media = s / janela } else media = n ? h.reduce((a, b) => a + b, 0) / n : 0
      return mk(nome, ajuste, Array(horizonte).fill(media), metricas(h, ajuste))
    },
    avaliarHoldout(s, nTreino, horizonte) {
      const n = s.length, prev: number[] = []
      for (let ini = nTreino; ini < n; ini += horizonte) {
        const fim = Math.min(ini + horizonte, n)
        let m: number
        if (ini >= janela) { let x = 0; for (let j = ini - janela; j < ini; j++) x += s[j]; m = x / janela } else m = ini ? s.slice(0, ini).reduce((a, b) => a + b, 0) / ini : 0
        for (let t = ini; t < fim; t++) prev.push(m)
      }
      return mk(nome, placeholderHoldout(nTreino, prev), prev, metricas(s.slice(nTreino), prev))
    },
  }
}

// ---------------- Suavização Exponencial Simples ----------------
export function suavizacaoExponencial(alpha: number): Metodo {
  const nome = `Suavizacao Exponencial (alpha=${javaDouble(alpha)})`
  const nivelAte = (s: number[], fimExcl: number) => { if (fimExcl <= 0) return 0; let nv = s[0]; for (let k = 1; k < fimExcl; k++) nv = alpha * s[k] + (1 - alpha) * nv; return nv }
  return {
    nome,
    gerar(h, horizonte) {
      const ajuste = [NaN]
      let nivel = h.length ? h[0] : 0
      for (let i = 1; i < h.length; i++) { ajuste.push(nivel); nivel = alpha * h[i - 1] + (1 - alpha) * nivel }
      if (h.length) nivel = alpha * h[h.length - 1] + (1 - alpha) * nivel
      return mk(nome, h.length ? ajuste : [NaN], Array(horizonte).fill(nivel), metricas(h, ajuste))
    },
    avaliarHoldout(s, nTreino, horizonte) {
      const n = s.length, prev: number[] = []
      for (let ini = nTreino; ini < n; ini += horizonte) { const fim = Math.min(ini + horizonte, n), nv = nivelAte(s, ini); for (let t = ini; t < fim; t++) prev.push(nv) }
      return mk(nome, placeholderHoldout(nTreino, prev), prev, metricas(s.slice(nTreino), prev))
    },
  }
}

// ---------------- Regressão Linear ----------------
function retaMQ(y: number[], n: number): [number, number] {
  let sx = 0, sy = 0, sxy = 0, sx2 = 0
  for (let i = 0; i < n; i++) { const x = i, v = y[i]; sx += x; sy += v; sxy += x * v; sx2 += x * x }
  const b = (n * sxy - sx * sy) / (n * sx2 - sx * sx)
  return [(sy - b * sx) / n, b]
}
export const regressaoLinear: Metodo = {
  nome: 'Regressao Linear',
  gerar(h, horizonte) {
    const n = h.length
    if (n < 2) { const v = n === 1 ? h[0] : 0; const aj = Array(n).fill(NaN); return mk('Regressao Linear', aj, Array(horizonte).fill(v), metricas(h, aj)) }
    const [a, b] = retaMQ(h, n)
    const ajuste = h.map((_, i) => a + b * i)
    const prev = Array.from({ length: horizonte }, (_, i) => Math.max(0, a + b * (n + i)))
    return mk('Regressao Linear', ajuste, prev, metricas(h, ajuste))
  },
  avaliarHoldout(s, nTreino, horizonte) {
    const n = s.length
    let a: number, b: number
    if (nTreino < 2) { a = nTreino === 1 ? s[0] : 0; b = 0 } else [a, b] = retaMQ(s, nTreino)
    const prev: number[] = []
    for (let t = nTreino; t < n; t++) prev.push(Math.max(0, a + b * t))
    return mk('Regressao Linear', placeholderHoldout(nTreino, prev), prev, metricas(s.slice(nTreino), prev))
  },
}

// ---------------- OLS com intercepto via QR de Householder (commons-math 3.6.1, limiar 0) ----------------
export class SingularMatrixError extends Error {}
/** Equivale a OLSMultipleLinearRegression.newSampleData(y, x) + estimateRegressionParameters(): [intercepto, b1..bk]. */
export function olsComIntercepto(x: number[][], y: number[]): number[] {
  if (x.length !== y.length || x.length === 0) throw new SingularMatrixError('amostra inválida')
  if (x[0].length + 1 > x.length) throw new SingularMatrixError('poucas observações para o número de variáveis')
  const m = x.length, n = x[0].length + 1
  // qrt = transposta de [1 | x]
  const qrt: number[][] = Array.from({ length: n }, (_, c) => Array.from({ length: m }, (_, r) => (c === 0 ? 1 : x[r][c - 1])))
  const rDiag = new Array<number>(Math.min(m, n))
  for (let minor = 0; minor < Math.min(m, n); minor++) {
    const qm = qrt[minor]
    let xNormSqr = 0
    for (let row = minor; row < qm.length; row++) { const c = qm[row]; xNormSqr += c * c }
    const a = qm[minor] > 0 ? -Math.sqrt(xNormSqr) : Math.sqrt(xNormSqr)
    rDiag[minor] = a
    if (a !== 0) {
      qm[minor] -= a
      for (let col = minor + 1; col < n; col++) {
        const qc = qrt[col]
        let alpha = 0
        for (let row = minor; row < qc.length; row++) alpha -= qc[row] * qm[row]
        alpha /= a * qm[minor]
        for (let row = minor; row < qc.length; row++) qc[row] -= alpha * qm[row]
      }
    }
  }
  for (const d of rDiag) if (Math.abs(d) <= 0) throw new SingularMatrixError('matriz singular')
  const out = new Array<number>(n), yy = y.slice()
  for (let minor = 0; minor < Math.min(m, n); minor++) {
    const qm = qrt[minor]
    let dot = 0
    for (let row = minor; row < m; row++) dot += yy[row] * qm[row]
    dot /= rDiag[minor] * qm[minor]
    for (let row = minor; row < m; row++) yy[row] += dot * qm[row]
  }
  for (let row = rDiag.length - 1; row >= 0; --row) {
    yy[row] /= rDiag[row]
    const yRow = yy[row], qr = qrt[row]
    out[row] = yRow
    for (let i = 0; i < row; i++) yy[i] -= yRow * qr[i]
  }
  return out
}

// ---------------- ARIMA(p,d,q) por Hannan-Rissanen ----------------
export function arima(p: number, d: number, q: number): Metodo {
  p = Math.max(0, p); d = Math.max(0, d); q = Math.max(0, q)
  const nome = `ARIMA(${p},${d},${q})`
  const minimo = p + d + q + 3
  const diferenciar = (s: number[], vezes: number) => { let at = s; for (let k = 0; k < vezes; k++) { const px: number[] = []; for (let i = 1; i < at.length; i++) px.push(at[i] - at[i - 1]); at = px } return at }
  const desenho = (s: number[], ordem: number) => { const x: number[][] = []; for (let t = ordem; t < s.length; t++) { const row: number[] = []; for (let lag = 1; lag <= ordem; lag++) row.push(s[t - lag]); x.push(row) } return x }
  const alvo = (s: number[], ordem: number) => s.slice(ordem)
  const residuos = (s: number[], ordem: number, c: number[]) => s.map((v, t) => { if (t < ordem) return NaN; let pr = c[0]; for (let lag = 1; lag <= ordem; lag++) pr += c[lag] * s[t - lag]; return v - pr })
  const fallback = (r: Resultado, msg: string): Resultado => ({ ...r, nome: `${nome} (${msg})`, fallback: true })
  return {
    nome,
    gerar(h, horizonte) {
      if (h.length < minimo) return fallback(naive.gerar(h, horizonte), `dados insuficientes - usando Naive como fallback, precisa de pelo menos ${minimo} observacoes, tem ${h.length}`)
      const dif = diferenciar(h, d)
      let ar = [0], resAr = dif.slice()
      if (p > 0 && dif.length > p) {
        try { ar = olsComIntercepto(desenho(dif, p), alvo(dif, p)); resAr = residuos(dif, p, ar) } catch { ar = new Array(p + 1).fill(0) }
      }
      let ma = [0]
      if (q > 0 && resAr.length > q + p) {
        try { const rv = resAr.slice(p); if (rv.length > q + 1) ma = olsComIntercepto(desenho(rv, q), alvo(rv, q)) } catch { ma = [0] }
      }
      // ajuste combinado AR + MA no domínio diferenciado
      const ajDif = dif.map((_, t) => {
        if (t < p) return NaN
        let pa = ar[0]; for (let lag = 1; lag <= p; lag++) pa += ar[lag] * dif[t - lag]
        let pm = 0
        if (q > 0 && ma.length > 1) { pm = ma[0]; for (let lag = 1; lag <= q; lag++) { const idx = t - lag; if (idx >= 0 && idx < resAr.length && !Number.isNaN(resAr[idx])) pm += ma[lag] * resAr[idx] } }
        return pa + pm
      })
      const ajuste: number[] = Array(d).fill(NaN)
      ajDif.forEach((v, i) => ajuste.push(Number.isNaN(v) ? NaN : h[i + d - 1] + v))
      // previsão: resíduos futuros = 0 (só AR) e integração a partir do último valor real
      const ext = dif.slice(), prevDif: number[] = []
      for (let k = 0; k < horizonte; k++) { const t = ext.length; let pa = ar[0]; for (let lag = 1; lag <= p && lag <= t; lag++) pa += ar[lag] * ext[t - lag]; prevDif.push(pa); ext.push(pa) }
      const prev: number[] = []
      let acc = h[h.length - 1]
      for (const dl of prevDif) { if (d > 0) { acc += dl; prev.push(acc) } else prev.push(dl) }
      return mk(nome, ajuste, prev, metricasCompletas(h, ajuste))
    },
    avaliarHoldout(s, nTreino, horizonte) {
      if (nTreino < minimo) return fallback(naive.avaliarHoldout(s, nTreino, horizonte), `dados insuficientes no treino - usando Naive como fallback, precisa de pelo menos ${minimo} observacoes de treino, tem ${nTreino}`)
      const difC = diferenciar(s, d)
      const difT = difC.slice(0, nTreino - d)
      let ar = [0]
      if (p > 0 && difT.length > p) { try { ar = olsComIntercepto(desenho(difT, p), alvo(difT, p)) } catch { ar = new Array(p + 1).fill(0) } }
      const n = s.length, prev: number[] = []
      for (let ini = nTreino; ini < n; ini += horizonte) {
        const fim = Math.min(ini + horizonte, n), hr = fim - ini, iniDif = ini - d
        const ext = difC.slice(0, iniDif), pd: number[] = []
        for (let k = 0; k < hr; k++) { const t = ext.length; let pa = ar[0]; for (let lag = 1; lag <= p && lag <= t; lag++) pa += ar[lag] * ext[t - lag]; pd.push(pa); ext.push(pa) }
        let acc = s[ini - 1]
        for (const dl of pd) { if (d > 0) { acc += dl; prev.push(acc) } else prev.push(dl) }
      }
      return mk(nome, placeholderHoldout(nTreino, prev), prev, metricasCompletas(s.slice(nTreino), prev))
    },
  }
}

// ---------------- java.util.Random (LCG de 48 bits) ----------------
/** Mesmo gerador do Java: mesma semente → mesma sequência, para a RNA começar com os MESMOS pesos do sistema original. */
export class JavaRandom {
  private seed: bigint
  private static readonly MULT = 0x5DEECE66Dn
  private static readonly MASK = (1n << 48n) - 1n
  constructor(seed: number | bigint) { this.seed = (BigInt(seed) ^ JavaRandom.MULT) & JavaRandom.MASK }
  private next(bits: number): bigint {
    this.seed = (this.seed * JavaRandom.MULT + 0xBn) & JavaRandom.MASK
    return this.seed >> BigInt(48 - bits)
  }
  nextDouble(): number { return Number((this.next(26) << 27n) + this.next(27)) * 2 ** -53 }
}

// ---------------- RNA PMC/MLP (1 camada oculta, sigmoide, backpropagation) ----------------
interface Rede { w1: number[][]; b1: number[]; w2: number[]; b2: number[] }
const sig = (z: number) => 1 / (1 + Math.exp(-z))
export function mlp(janela: number, ocultos: number, epocas: number, taxa: number, semente: number): Metodo {
  const nome = `RNA PMC/MLP (janela=${janela}, ocultos=${ocultos})`
  const treinar = (x: number[]): Rede => {
    const rnd = new JavaRandom(semente)
    const w1 = Array.from({ length: ocultos }, () => Array.from({ length: janela }, () => (rnd.nextDouble() - 0.5) * 0.5))
    const b1 = new Array<number>(ocultos).fill(0)
    const w2 = Array.from({ length: ocultos }, () => (rnd.nextDouble() - 0.5) * 0.5)
    const b2 = [0]
    const ent = new Array<number>(janela), oc = new Array<number>(ocultos), d1 = new Array<number>(ocultos)
    for (let ep = 0; ep < epocas; ep++) {
      for (let t = janela; t < x.length; t++) {
        for (let i = 0; i < janela; i++) ent[i] = x[t - janela + i]
        const alvo = x[t]
        for (let j = 0; j < ocultos; j++) { let z = b1[j]; for (let i = 0; i < janela; i++) z += w1[j][i] * ent[i]; oc[j] = sig(z) }
        let zs = b2[0]; for (let j = 0; j < ocultos; j++) zs += w2[j] * oc[j]
        const y = sig(zs)
        const d2 = (y - alvo) * y * (1 - y)
        for (let j = 0; j < ocultos; j++) d1[j] = d2 * w2[j] * oc[j] * (1 - oc[j])
        for (let j = 0; j < ocultos; j++) {
          w2[j] -= taxa * d2 * oc[j]
          for (let i = 0; i < janela; i++) w1[j][i] -= taxa * d1[j] * ent[i]
          b1[j] -= taxa * d1[j]
        }
        b2[0] -= taxa * d2
      }
    }
    return { w1, b1, w2, b2 }
  }
  const prever = (e: number[], r: Rede) => {
    const oc = new Array<number>(ocultos)
    for (let j = 0; j < ocultos; j++) { let z = r.b1[j]; for (let i = 0; i < janela; i++) z += r.w1[j][i] * e[i]; oc[j] = sig(z) }
    let zs = r.b2[0]; for (let j = 0; j < ocultos; j++) zs += r.w2[j] * oc[j]
    return sig(zs)
  }
  const escala = (v: number[]) => { const mn = Math.min(...v), mx = Math.max(...v); return { mn, amp: mx - mn < 1e-9 ? 1 : mx - mn } }
  const fallback = (r: Resultado, msg: string): Resultado => ({ ...r, nome: `${nome} (${msg})`, fallback: true })
  return {
    nome,
    gerar(h, horizonte) {
      const n = h.length
      if (n < janela + 3) return fallback(naive.gerar(h, horizonte), `dados insuficientes - usando Naive como fallback, precisa de pelo menos ${janela + 3} observacoes, tem ${n}`)
      const { mn, amp } = escala(h)
      const x = h.map((v) => (v - mn) / amp)
      const rede = treinar(x)
      const ajuste: number[] = Array(janela).fill(NaN)
      for (let t = janela; t < x.length; t++) ajuste.push(prever(x.slice(t - janela, t), rede) * amp + mn)
      const jan = x.slice(x.length - janela), prev: number[] = []
      for (let k = 0; k < horizonte; k++) { const y = prever(jan, rede); prev.push(y * amp + mn); jan.shift(); jan.push(y) }
      return mk(nome, ajuste, prev, metricasCompletas(h, ajuste))
    },
    avaliarHoldout(s, nTreino, horizonte) {
      if (nTreino < janela + 3) return fallback(naive.avaliarHoldout(s, nTreino, horizonte), `dados insuficientes no treino - usando Naive como fallback, precisa de pelo menos ${janela + 3} observacoes de treino, tem ${nTreino}`)
      // normalização fixada SÓ pelo treino (sem vazamento de informação do teste)
      const { mn, amp } = escala(s.slice(0, nTreino))
      const rede = treinar(s.slice(0, nTreino).map((v) => (v - mn) / amp))
      const n = s.length, prev: number[] = []
      for (let ini = nTreino; ini < n; ini += horizonte) {
        const fim = Math.min(ini + horizonte, n)
        const jan: number[] = []
        for (let i = ini - janela; i < ini; i++) jan.push((s[i] - mn) / amp)
        for (let t = ini; t < fim; t++) { const y = prever(jan, rede); prev.push(y * amp + mn); jan.shift(); jan.push(y) }
      }
      return mk(nome, placeholderHoldout(nTreino, prev), prev, metricasCompletas(s.slice(nTreino), prev))
    },
  }
}

/** Double.toString do Java para os nomes (0.3 → "0.3", 1 → "1.0"). */
function javaDouble(v: number) { return Number.isInteger(v) ? v.toFixed(1) : String(v) }

/** Os 6 métodos da tela "Previsão de Demanda" do sistema original, na mesma ordem e com os mesmos parâmetros (ForecastService). */
export const METODOS: Metodo[] = [naive, mediaMovel(3), suavizacaoExponencial(0.3), regressaoLinear, arima(1, 1, 1), mlp(3, 5, 300, 0.1, 42)]

/** ForecastService.compararModelosHoldout: corte floor(0,8·n), ao menos 1 ponto de treino e 1 de teste. */
export function compararHoldout(serie: number[], proporcaoTreino: number, horizonte: number, metodos = METODOS) {
  const n = serie.length
  const nTreino = Math.max(1, Math.min(Math.floor(proporcaoTreino * n), n - 1))
  return { nTreino, resultados: metodos.map((m) => { const t0 = performance.now(); const r = m.avaliarHoldout(serie, nTreino, horizonte); return { ...r, ms: performance.now() - t0 } }) }
}
/** ForecastService.compararModelos: todos os métodos ajustados na série inteira (previsão de produção). */
export function compararProducao(serie: number[], horizonte: number, metodos = METODOS) {
  return metodos.map((m) => { const t0 = performance.now(); const r = m.gerar(serie, horizonte); return { ...r, ms: performance.now() - t0 } })
}
/** ForecastService.selecionarMelhor: menor RMSE + MAPE (empate: o primeiro da lista). */
export function selecionarMelhor(rs: Resultado[]): number {
  // Double.compare do Java: NaN é maior que qualquer número
  const key = (r: Resultado) => { const v = score(r); return Number.isNaN(v) ? Infinity : v }
  let best = -1
  rs.forEach((r, i) => { if (best < 0 || key(r) < key(rs[best]) || (key(rs[best]) === Infinity && Number.isNaN(score(rs[best])) && !Number.isNaN(score(r)) && key(r) === Infinity)) best = i })
  return best
}
