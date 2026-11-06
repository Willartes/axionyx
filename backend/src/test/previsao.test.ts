import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setup, teardown, call, login } from './helpers'
import { db } from '../core/db'
import { shiftSale } from '../db/seed'
import { METODOS, compararHoldout, compararProducao, selecionarMelhor, JavaRandom, olsComIntercepto, SingularMatrixError } from '../forecast/methods'

/**
 * Previsão de demanda: equivalência com o AXIONYX ERP original (JavaFX) e série corrigida.
 * O arquivo fixtures/previsao-java.json foi gerado executando o código Java ORIGINAL, sem alterações
 * (ForecastService.compararModelosHoldout / compararModelos / selecionarMelhor, commons-math 3.6.1), sobre 7 séries
 * (tendência + sazonalidade em 104 semanas, intermitente, mensal, curta, constante, queda brusca) e horizontes 1, 3, 6 e 12.
 */
const goldenPath = [path.join(__dirname, 'fixtures', 'previsao-java.json'), path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'previsao-java.json')].find((p) => fs.existsSync(p))!
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))
const dif = (a: number, b: number | null) => (b === null ? (Number.isFinite(a) ? Infinity : 0) : Math.abs(a - b) / Math.max(1, Math.abs(b)))

test('gerador java.util.Random com semente 42: mesma sequência do Java', () => {
  const r = new JavaRandom(42)
  for (const v of golden.random42) assert.equal(r.nextDouble(), v)
})

test('os 6 métodos reproduzem o sistema original (holdout 80/20, produção e método recomendado)', () => {
  assert.deepEqual(METODOS.map((m) => m.nome), ['Naive', 'Media Movel (3)', 'Suavizacao Exponencial (alpha=0.3)', 'Regressao Linear', 'ARIMA(1,1,1)', 'RNA PMC/MLP (janela=3, ocultos=5)'])
  assert.equal(golden.casos.length, 28)
  for (const c of golden.casos) {
    const ho = compararHoldout(c.valores, 0.8, c.horizonte).resultados, pr = compararProducao(c.valores, c.horizonte)
    assert.equal(selecionarMelhor(ho), c.melhor, `método recomendado em ${c.serie} h=${c.horizonte}`)
    for (const [lista, ref, tag] of [[ho, c.holdout, 'holdout'], [pr, c.producao, 'produção']] as const) {
      lista.forEach((r, i) => {
        const j = (ref as any[])[i], ctx = `${c.serie} h=${c.horizonte} ${tag} ${j.nome}`
        // rede neural: só a última casa decimal pode diferir (Math.exp do Java × JavaScript); os demais são idênticos
        const tol = i === 5 ? 1e-12 : 0
        assert.equal(r.nome, j.nome, ctx)
        for (const f of ['mae', 'rmse', 'mape', 'bias', 'smape', 'r2'] as const) assert.ok(dif(r[f], j[f]) <= tol, `${ctx} ${f}: ${r[f]} × ${j[f]}`)
        assert.equal(r.previsao.length, j.previsao.length, ctx)
        r.previsao.forEach((v, t) => assert.ok(dif(v, j.previsao[t]) <= tol, `${ctx} previsão[${t}]: ${v} × ${j.previsao[t]}`))
        r.ajuste.forEach((v, t) => assert.ok(dif(v, j.ajuste[t]) <= tol, `${ctx} ajuste[${t}]`))
      })
    }
  }
})

test('rede neural: sem vazamento do teste, determinística e com substituto quando falta histórico', () => {
  const s = golden.casos.find((c: any) => c.serie === 'semanal_104_tendencia_sazonal').valores as number[]
  const mlp = METODOS[5]
  const nTreino = Math.floor(0.8 * s.length)
  // alterar o teste (exceto os pontos usados como janela de entrada) não muda a rede treinada: as previsões da 1ª rodada são iguais
  const alterada = s.map((v, i) => (i >= nTreino ? v * 10 : v))
  const a = mlp.avaliarHoldout(s, nTreino, 1).previsao[0], b = mlp.avaliarHoldout(alterada, nTreino, 1).previsao[0]
  assert.equal(a, b)
  assert.deepEqual(mlp.gerar(s, 4).previsao, mlp.gerar(s, 4).previsao)
  const curta = mlp.gerar([3, 4, 5, 6, 7], 2)
  assert.equal(curta.fallback, true); assert.match(curta.nome, /Naive como fallback/)
  // regressão sem solução (variável constante) é detectada como no commons-math
  assert.throws(() => olsComIntercepto([[1], [1], [1]], [1, 2, 3]), SingularMatrixError)
})

// ---------------- série real e API ----------------
let A: any, V: any, B: any, variant = '', productId = ''
const key = () => crypto.randomUUID()
before(async () => {
  await setup()
  A = await login('admin.a@teste.local'); V = await login('vend.a@teste.local'); B = await login('admin.b@teste.local')
  const p = await call('POST', '/api/products', { token: A.token, body: { code: 'PREV-1', name: 'Camiseta Previsão', sale_price: 50, cost_price: 20 } })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  variant = p.body.variants[0].id; productId = p.body.id
  await call('POST', '/api/stock/movements', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { type: 'entrada', reason: 'Carga', items: [{ variantId: variant, qty: 500 }] } })
  const regs = await call('GET', '/api/cash/registers', { token: A.token })
  await call('POST', '/api/cash/open', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { registerId: regs.body[0].id, openingAmount: 0 } })
})
after(async () => { await teardown() })

async function sell(qty: number, daysAgo: number, extra = 0) {
  const lk = (await call('GET', '/api/lookups', { token: A.token })).body
  const pix = lk.paymentMethods.find((x: any) => x.kind === 'pix').id
  const s = await call('POST', '/api/sales', { token: A.token, headers: { 'Idempotency-Key': key() }, body: { items: [{ variantId: variant, qty }], discountTotal: extra || undefined, payments: [{ methodId: pix, amount: qty * 50 - extra }] } })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  await shiftSale(db as any, s.body.id, daysAgo, 12)
  return s.body.id as string
}

test('série semanal: zeros nos períodos sem venda, sem canceladas, devoluções e descontos descontados, período atual fora do treino', async () => {
  for (let w = 12; w >= 5; w--) await sell(1, 7 * w)       // 8 semanas com 1 unidade
  const devolvida = await sell(4, 7 * 4)                     // 4 vendidas, 1 devolvida
  await db.query(`UPDATE sale_items SET returned_qty = 1 WHERE sale_id = $1`, [devolvida])
  await sell(2, 7 * 3)
  const cancelada = await sell(5, 7 * 3)                     // cancelada: não conta
  await db.query(`UPDATE sales SET status = 'cancelada' WHERE id = $1`, [cancelada])
  // semana -2: nenhuma venda (deve aparecer como zero)
  await sell(3, 7 * 1, 30)                                   // 3 unidades com R$ 30 de desconto
  await sell(7, 0)                                           // semana atual (em andamento)

  const r = await call('GET', `/api/intelligence/forecast?product=${productId}&periodo=semanal&horizon=4`, { token: A.token })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const g = r.body
  assert.equal(g.periodo, 'semanal'); assert.equal(g.unidade, 'quantidade'); assert.equal(g.horizonte, 4)
  // a empresa começou a vender no meio da semana -12: essa semana incompleta fica fora; depois, zeros onde não houve venda
  const ini = (await db.query(`SELECT to_char(date_trunc('week', min(created_at) AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS w, (min(created_at) AT TIME ZONE 'America/Sao_Paulo') > date_trunc('week', min(created_at) AT TIME ZONE 'America/Sao_Paulo') + interval '1 day' AS parcial FROM sales WHERE company_id = (SELECT company_id FROM products WHERE id = $1)`, [productId])).rows[0]
  const esperado = [1, 1, 1, 1, 1, 1, 1, 1, 3, 2, 0, 3]
  assert.deepEqual(g.serie.map((p: any) => p.valor), ini.parcial ? esperado.slice(1) : esperado)
  if (ini.parcial) assert.ok(g.serie[0].inicio > ini.w, 'primeira semana incompleta não entra')
  assert.equal(g.atual.valor, 7, 'semana em andamento fica separada')
  assert.equal(g.metodos.length, 6); assert.ok(g.melhor >= 0 && g.melhor < 6)
  const n = g.serie.length
  assert.equal(g.nTreino, Math.floor(0.8 * n))
  assert.equal(g.futuro.length, 4); assert.equal(g.futuro[0], g.atual.inicio)
  for (const m of g.metodos) { assert.equal(m.previsao.length, 4); assert.equal(m.teste.length, n - g.nTreino); assert.ok(m.previsao.every((v: number) => v >= 0)) }
  assert.ok(g.metodos.find((m: any) => /Rede neural/.test(m.nome)))
  assert.match(g.avaliacao.conclusao, /apresentou o melhor desempenho/)
  assert.equal(g.avaliacao.confianca, 'baixa') // menos de 12 semanas completas
  // faturamento: líquido de desconto e de devolução (sem filtro de produto = empresa toda)
  const f = await call('GET', `/api/intelligence/forecast?periodo=semanal`, { token: A.token })
  assert.equal(f.body.unidade, 'faturamento')
  assert.deepEqual(f.body.serie.slice(-4).map((p: any) => p.valor), [150, 100, 0, 120])
  // horizonte fora da lista volta para o padrão da empresa
  assert.equal((await call('GET', `/api/intelligence/forecast?product=${productId}&periodo=semanal&horizon=5`, { token: A.token })).body.horizonte, 4)
})

test('série mensal e período padrão da empresa', async () => {
  const w = await call('GET', `/api/intelligence/forecast?product=${productId}&periodo=semanal`, { token: A.token })
  const m = await call('GET', `/api/intelligence/forecast?product=${productId}&periodo=mensal&horizon=3`, { token: A.token })
  assert.equal(m.status, 200); assert.equal(m.body.periodo, 'mensal')
  const tot = (g: any) => g.serie.reduce((a: number, p: any) => a + p.valor, 0) + g.atual.valor
  // total do mensal = vendas líquidas desde o primeiro mês da série (mês incompleto do início fica fora)
  const desde = async (inicio: string) => Number((await db.query(`SELECT COALESCE(sum(si.qty - si.returned_qty),0) AS q FROM sales s JOIN sale_items si ON si.sale_id = s.id
      WHERE si.variant_id = $1 AND s.status <> 'cancelada' AND (s.created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date`, [variant, inicio])).rows[0].q)
  if (m.body.serie.length) assert.equal(tot(m.body), await desde(m.body.serie[0].inicio))
  assert.equal(tot(w.body), await desde(w.body.serie[0].inicio))
  assert.ok(m.body.serie.every((p: any) => p.inicio.endsWith('-01')))
  // padrão da empresa: mensal
  assert.equal((await call('PUT', '/api/settings', { token: A.token, body: { previsao: { periodo: 'mensal', horizonteMeses: 6 } } })).status, 200)
  const d = await call('GET', `/api/intelligence/forecast?product=${productId}`, { token: A.token })
  assert.equal(d.body.periodo, 'mensal'); assert.ok(d.body.insuficiente || d.body.horizonte === 6)
  assert.notEqual((await call('PUT', '/api/settings', { token: A.token, body: { previsao: { periodo: 'diario' } } })).status, 200)
  await call('PUT', '/api/settings', { token: A.token, body: { previsao: { periodo: 'semanal' } } })
})

test('isolamento e permissão', async () => {
  assert.equal((await call('GET', `/api/intelligence/forecast?product=${productId}`, { token: B.token })).status, 404, 'produto de outra empresa')
  const v = await call('GET', `/api/intelligence/forecast?product=${productId}`, { token: V.token })
  assert.ok([200, 403].includes(v.status))
})
