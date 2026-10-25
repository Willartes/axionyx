import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://nao-usado@127.0.0.1:1/nao_usado'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-' + 'x'.repeat(40)
/* eslint-disable @typescript-eslint/no-require-imports */
const { isValidCPF, isValidCNPJ, isValidGTIN, gtinCheckDigit, v, parse } = require('../core/validate') as typeof import('../core/validate')
const { parseXml, text } = require('../core/xml') as typeof import('../core/xml')
const { hashPassword, verifyPassword, passwordPolicy, signJwt, verifyJwt, totp, verifyTotp, generateTotpSecret } = require('../core/crypto') as typeof import('../core/crypto')
const { splitInstallments } = require('../core/http') as typeof import('../core/http')

test('CPF/CNPJ: dígitos verificadores', () => {
  assert.equal(isValidCPF('529.982.247-25'), true)
  assert.equal(isValidCPF('111.111.111-11'), false)
  assert.equal(isValidCPF('529.982.247-24'), false)
  assert.equal(isValidCNPJ('11.222.333/0001-81'), true)
  assert.equal(isValidCNPJ('11.222.333/0001-80'), false)
})

test('GTIN/EAN-13: cálculo e validação do dígito', () => {
  assert.equal(gtinCheckDigit('789100031550'), 7)
  assert.equal(isValidGTIN('7891000315507'), true)
  assert.equal(isValidGTIN('7891000315508'), false)
})

test('parcelamento distribui centavos sem perder valor', () => {
  const p = splitInstallments(100, 3)
  assert.equal(p.length, 3)
  assert.equal(Math.round(p.reduce((a, b) => a + b, 0) * 100), 10000)
  assert.ok(Math.max(...p) - Math.min(...p) <= 0.011)
})

test('validação de entrada rejeita tipos e limites inválidos', () => {
  const schema = v.object({ qty: v.int({ min: 1 }), price: v.money({ min: 0 }), email: v.email().optional() })
  assert.throws(() => parse(schema, { qty: 0, price: 10 }))
  assert.throws(() => parse(schema, { qty: 1, price: -1 }))
  assert.throws(() => parse(schema, { qty: 1, price: 1, email: 'x' }))
  assert.deepEqual(parse(schema, { qty: 2, price: 9.99 }), { qty: 2, price: 9.99 })
})

test('parser XML seguro: lê NF-e e recusa DOCTYPE/entidades', () => {
  const n = parseXml('<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>12</nNF></ide><emit><xNome>A &amp; B</xNome></emit></infNFe></NFe></nfeProc>')
  assert.equal(text(n, 'nfeProc/NFe/infNFe/ide/nNF'), '12')
  assert.equal(text(n, 'nfeProc/NFe/infNFe/emit/xNome'), 'A & B')
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'))
})

test('senhas: hash com sal, verificação e política mínima', () => {
  const h = hashPassword('Senha-Forte-2026')
  assert.notEqual(h, hashPassword('Senha-Forte-2026'))
  assert.equal(verifyPassword('Senha-Forte-2026', h), true)
  assert.equal(verifyPassword('outra', h), false)
  assert.ok(passwordPolicy('123'))
  assert.equal(passwordPolicy('Senha-Forte-2026'), null)
})

test('JWT: assinatura, expiração e adulteração', () => {
  const t = signJwt({ uid: 'u1' }, 's'.repeat(40), 60)
  assert.equal(verifyJwt<any>(t, 's'.repeat(40)).uid, 'u1')
  assert.equal(verifyJwt(t, 'outro'.repeat(10)), null)
  const [h, , sig] = t.split('.')
  const forged = [h, Buffer.from(JSON.stringify({ uid: 'admin', exp: 9e9 })).toString('base64url'), sig].join('.')
  assert.equal(verifyJwt(forged, 's'.repeat(40)), null)
  assert.equal(verifyJwt(signJwt({ uid: 'u1' }, 's'.repeat(40), -10), 's'.repeat(40)), null)
})

test('TOTP (RFC 6238): código válido na janela e inválido fora dela', () => {
  const s = generateTotpSecret()
  const now = Date.now()
  assert.equal(verifyTotp(s, totp(s, now)), true)
  assert.equal(verifyTotp(s, totp(s, now - 10 * 60_000)), false)
})

// ---------- Precificação (markup divisor) ----------
const { calculatePrice, companyIndicators, roundPrice, PricingError } = require('../services/pricing') as typeof import('../services/pricing')

test('precificação: markup divisor reproduz o cálculo de referência', () => {
  // custo 100, despesas variáveis 10%, margem 20%, sem custos fixos → preço = 100 / (1 − 0,30)
  const r = calculatePrice({ acquisitionCost: 100, variablePct: 10, fixedPct: 0, desiredMarginPct: 20 })
  assert.equal(r.suggestedPrice, 142.86)
  assert.equal(r.variableExpenses, 14.29)
  assert.equal(r.netProfitUnit, 28.57)
  assert.equal(r.markupMultiplier, 1.4286)
  assert.equal(Math.round(r.grossMarginPct * 100) / 100, 30)
  assert.equal(r.floorPrice, 111.11)            // cobre só custo + variáveis
})

test('precificação: custos fixos, ponto de equilíbrio e arredondamento', () => {
  const r = calculatePrice({ acquisitionCost: 40, freight: 2, lossesPct: 5, unitVariableCosts: 1.8, variablePct: 12, fixedPct: 25, desiredMarginPct: 15, rounding: 'centavos_90', monthlyFixedCosts: 10000 })
  // custo unitário = 40 + 2 de frete + 5% de perdas sobre a aquisição (2) + 1,80
  assert.equal(r.unitCost, 45.8)
  assert.equal(r.minimumPrice, Math.round(45.8 / (1 - 0.37) * 100) / 100)
  assert.ok(r.suggestedPrice >= r.rawPrice && String(r.suggestedPrice.toFixed(2)).endsWith('.90'))
  assert.equal(r.breakevenUnits, Math.ceil(10000 / r.contributionUnit))
  assert.equal(roundPrice(57.82, 'centavos_90'), 57.9)
  assert.equal(roundPrice(57.95, 'centavos_90'), 58.9)
  assert.equal(roundPrice(57.12, 'inteiro'), 58)
})

test('precificação: modos markup e preço informado', () => {
  const m = calculatePrice({ acquisitionCost: 50, variablePct: 10, fixedPct: 20, mode: 'markup', markup: 2.5 })
  assert.equal(m.suggestedPrice, 125)
  const p = calculatePrice({ acquisitionCost: 50, variablePct: 10, fixedPct: 20, mode: 'preco', price: 60, currentPrice: 60 })
  assert.equal(p.contributionUnit, 4)              // 60 − 50 − 6
  assert.ok(p.netProfitUnit < 0)                   // 4 − 12 de rateio fixo
  assert.equal(p.currentAnalysis?.belowMinimum, true)
})

test('precificação: parâmetros inviáveis são recusados', () => {
  assert.throws(() => calculatePrice({ acquisitionCost: 0, variablePct: 10 }), PricingError)
  assert.throws(() => calculatePrice({ acquisitionCost: 10, variablePct: 60, fixedPct: 30, desiredMarginPct: 15 }), PricingError)
  assert.throws(() => calculatePrice({ acquisitionCost: 10, variablePct: 100 }), PricingError)
})

test('precificação: indicadores gerenciais (MC, equilíbrio, margem de segurança, alavancagem)', () => {
  const i = companyIndicators({ revenue: 100000, cmv: 40000, variablePct: 10, unitVariableTotal: 0, fixedCosts: 30000, desiredMarginPct: 10 })
  assert.equal(i.contribution, 50000)
  assert.equal(i.contributionPct, 50)
  assert.equal(i.operatingProfit, 20000)
  assert.equal(i.breakevenRevenue, 60000)
  assert.equal(i.safetyMarginPct, 40)
  assert.equal(i.operatingLeverage, 2.5)
  assert.equal(i.revenueForTarget, 75000)          // 30000 / (0,5 − 0,1)
})

// ---------- Varejo por segmento: etiqueta de balança e quantidades ----------
const { parseScaleBarcode, buildScaleBarcode, checkQty } = require('../services/retail') as typeof import('../services/retail')
test('etiqueta de balança: gera e lê EAN-13 com preço ou peso embutido', () => {
  const cfgP = { prefixo: '2', digitosCodigo: 5, digitosValor: 5, tipoValor: 'preco' as const, baudRate: 9600 }
  const code = buildScaleBarcode('101', 7.43, cfgP)
  assert.equal(code.length, 13); assert.equal(isValidGTIN(code), true); assert.ok(code.startsWith('200101'))
  assert.deepEqual(parseScaleBarcode(code, cfgP), { plu: '101', value: 7.43, kind: 'preco' })
  const cfgW = { ...cfgP, tipoValor: 'peso' as const, digitosCodigo: 4 }
  const w = buildScaleBarcode('25', 1.234, cfgW)
  assert.deepEqual(parseScaleBarcode(w, cfgW), { plu: '25', value: 1.234, kind: 'peso' })
  assert.equal(parseScaleBarcode('7891234567895', cfgP), null)        // EAN comum
  assert.equal(parseScaleBarcode(code.slice(0, 12) + '0', cfgP), null) // dígito verificador errado
})
test('quantidades: inteiras por unidade e até 3 casas por peso', () => {
  assert.equal(checkQty(2, { unit: 'UN' }), 2)
  assert.throws(() => checkQty(1.5, { unit: 'UN' }))
  assert.equal(checkQty(1.2345 - 0.0005, { unit: 'KG' }), 1.234)
  assert.throws(() => checkQty(1.2345, { sale_by_weight: true }))
  assert.throws(() => checkQty(0, { unit: 'KG' }))
})
