import { Q, nextNumber } from '../core/db'
import { conflict, forbidden, notFound, unprocessable, HttpError } from '../core/errors'
import { r2, today, addDays, splitInstallments, audit, Ctx } from '../core/http'
import { verifyPassword } from '../core/crypto'
import { moveStock } from './stock'
import { getSettings } from './settings'
import { addTransaction, createReceivable, defaultAccount, systemCategory, reverseTransactionsOf, dueDates, BALANCE_SQL } from './finance'
import { earnCashback, redeemCashback, reverseLoyalty } from './loyalty'
import { computeCommission, recordCommission } from './commission'
import { createDocumentForSale } from './fiscal'
import { randomCode } from '../core/crypto'
import { expandItems, checkQty, isFractional, consumeLots, r3, RawItem } from './retail'
import { addProfessionalCommission, commissionPct, completeAppointment, refreshPlanStatus } from './agenda'
import { workOrderBilled } from './workshop'

export interface SaleItemInput { variantId?: string; qty: number; discount?: number; unitPriceOverride?: number; packagingId?: string; comboId?: string; scaleCode?: string
  professionalId?: string; appointmentServiceId?: string; planItemId?: string; workOrderItemId?: string }
export interface PaymentInput { methodId: string; amount: number; installments?: number; firstDueDate?: string; storeCreditCode?: string; details?: Record<string, unknown> }
export interface SaleInput {
  type?: 'venda' | 'orcamento'
  customerId?: string | null
  sellerId?: string | null
  items: SaleItemInput[]
  discountTotal?: number // desconto adicional no total (R$)
  payments?: PaymentInput[]
  notes?: string
  channel?: 'loja' | 'ecommerce' | 'condicional' | 'bag_delivery' | 'consignacao' | 'whatsapp'
  originType?: string
  originId?: string
  externalId?: string
  /** Itens já saíram do estoque (condicional/consignação) */
  skipStock?: boolean
  /** Venda sem pagamento imediato (gera título a receber único) */
  onAccount?: { dueDate: string; description?: string }
  discountAuthorization?: { email: string; password: string }
  validUntil?: string
  emitFiscal?: boolean
  /** Confirmação de maioridade (obrigatória quando há produto restrito e o módulo está ativo) */
  ageConfirmed?: boolean
}

export interface Actor { companyId: string; branchId: string; userId: string; userName: string; permissions: Set<string>; isSuperadmin: boolean; maxDiscountPct: number }
export const actorOf = (ctx: Ctx): Actor => ({ companyId: ctx.user.companyId, branchId: ctx.user.branchId, userId: ctx.user.id, userName: ctx.user.name, permissions: ctx.user.permissions, isSuperadmin: ctx.user.isSuperadmin, maxDiscountPct: ctx.user.maxDiscountPct })
const has = (a: Actor, p: string) => a.isSuperadmin || a.permissions.has(p)

async function authorizeDiscount(c: Q, a: Actor, pct: number, auth?: { email: string; password: string }): Promise<string | null> {
  if (pct <= a.maxDiscountPct + 0.0001) return null
  if (has(a, 'vendas.desconto_extra')) return a.userId
  if (!auth?.email || !auth?.password) throw new HttpError(403, 'desconto_requer_autorizacao', `Desconto de ${pct.toFixed(2)}% excede seu limite (${a.maxDiscountPct}%). Solicite autorização de um supervisor.`, { pct, limit: a.maxDiscountPct })
  const sup = await c.one(
    `SELECT u.id, u.password_hash, r.permissions, r.max_discount_pct, u.is_superadmin FROM users u
       JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $2 AND uc.active JOIN roles r ON r.id = uc.role_id
      WHERE lower(u.email) = lower($1) AND u.active`, [auth.email, a.companyId])
  if (!sup || !verifyPassword(auth.password, sup.password_hash)) throw forbidden('Credenciais do supervisor inválidas.')
  const ok = sup.is_superadmin || ((sup.permissions as string[]).includes('vendas.desconto_extra') && Number(sup.max_discount_pct) >= pct)
  if (!ok) throw forbidden('O supervisor informado não pode autorizar este percentual de desconto.')
  return sup.id
}

/**
 * Registra uma venda (ou orçamento) de ponta a ponta, em uma única transação:
 * itens, estoque, pagamentos divididos, caixa, contas a receber, crediário, vale-troca, cashback, comissão e documento fiscal.
 */
export async function createSale(c: Q, a: Actor, input: SaleInput, ctx?: Ctx) {
  const type = input.type ?? 'venda'
  const settings = await getSettings(c, a.companyId)
  if (!input.items?.length) throw unprocessable('Inclua pelo menos um item.')
  // embalagens (caixa → unidades), combos (rateio do preço) e etiquetas de balança viram linhas de produto
  const expanded = await expandItems(c, a.companyId, input.items as RawItem[], settings)
  const variantIds = [...new Set(expanded.map((i) => i.variantId))]
  const variants = await c.many(
    `SELECT v.id, v.sku, v.active, p.id AS product_id, p.active AS product_active, p.name, p.category_id, p.brand_id, p.collection_id, p.unit, p.sale_by_weight, p.age_restricted,
            p.kind, p.package_service_id, p.package_sessions, p.package_validity_days,
            COALESCE(v.sale_price, p.sale_price) AS price, COALESCE(v.cost_price, p.cost_price) AS cost
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.company_id = $1 AND v.id = ANY($2::uuid[])`, [a.companyId, variantIds])
  const vmap = new Map(variants.map((v) => [v.id, v]))
  // preço por quantidade (atacarejo): maior faixa cuja quantidade mínima foi atingida
  const tierRows = await c.many(`SELECT product_id, min_qty, unit_price FROM product_price_tiers WHERE company_id = $1 AND product_id = ANY($2::uuid[]) ORDER BY min_qty DESC`,
    [a.companyId, [...new Set(variants.map((v) => v.product_id))]])
  const tierFor = (productId: string, qty: number) => tierRows.find((t) => t.product_id === productId && qty + 1e-9 >= Number(t.min_qty)) ?? null
  let subtotal = 0, lineDiscounts = 0, costTotal = 0, itemsCount = 0
  const lines = expanded.map((it, idx) => {
    const v = vmap.get(it.variantId)
    if (!v) throw unprocessable(`Item ${idx + 1}: produto/variação não encontrado.`)
    if (!v.active || !v.product_active) throw unprocessable(`Item ${idx + 1}: ${v.sku} está inativo.`)
    const qty = checkQty(it.qty, v, `Item ${idx + 1}: quantidade`)
    const tier = it.unitPriceOverride === undefined && it.grossOverride === undefined ? tierFor(v.product_id, qty) : null
    const unit = it.unitPriceOverride !== undefined ? Math.round(it.unitPriceOverride * 10000) / 10000 : tier ? Number(tier.unit_price) : r2(Number(v.price))
    if (unit <= 0) throw unprocessable(`Item ${idx + 1}: ${v.sku} sem preço de venda cadastrado.`)
    const gross = it.grossOverride !== undefined ? r2(it.grossOverride) : r2(unit * qty)
    const disc = r2(it.discount ?? 0)
    if (disc < 0 || disc > gross) throw unprocessable(`Item ${idx + 1}: desconto inválido.`)
    subtotal += gross; lineDiscounts += disc; costTotal += Number(v.cost) * qty; itemsCount += isFractional(v) ? 1 : qty
    return { v, qty, unit: r2(unit), gross, disc, net: r2(gross - disc), comboId: it.comboId ?? null, packagingId: it.packagingId ?? null, tierMin: tier ? Number(tier.min_qty) : null,
      professionalId: v.kind === 'pacote' ? null : (it.professionalId ?? null), appointmentServiceId: it.appointmentServiceId ?? null, appointmentId: it.appointmentId ?? null,
      planItemId: it.planItemId ?? null, workOrderItemId: it.workOrderItemId ?? null, workOrderId: it.workOrderId ?? null, preApproved: r2(it.preApprovedDiscount ?? 0), expectCustomerId: it.expectCustomerId ?? null, id: '' as string }
  })
  // atendimento/plano de tratamento: a venda precisa ser do mesmo cliente
  for (const l of lines) {
    if (l.expectCustomerId && l.expectCustomerId !== (input.customerId ?? null)) throw unprocessable(`"${l.v.name}" pertence ao atendimento/plano de outro cliente: selecione o cliente correto.`)
    if (l.v.kind === 'pacote' && type === 'venda' && !input.customerId) throw unprocessable(`Pacote "${l.v.name}" exige cliente identificado (o saldo de sessões fica na ficha dele).`)
  }
  // profissionais informados nos itens pertencem à empresa e estão ativos
  const profIds = [...new Set(lines.map((l) => l.professionalId).filter(Boolean))] as string[]
  if (profIds.length) {
    const ok = await c.many(`SELECT id FROM professionals WHERE company_id = $1 AND active AND id = ANY($2::uuid[])`, [a.companyId, profIds])
    if (ok.length !== profIds.length) throw unprocessable('Profissional inválido ou inativo em um dos itens.')
  }
  // maioridade: venda de produto restrito exige confirmação do operador (registrada na venda)
  const restricted = lines.filter((l) => l.v.age_restricted)
  let ageVerifiedBy: string | null = null
  if (restricted.length && type === 'venda' && settings.maioridade.exigirConfirmacao) {
    const mods = (await c.one(`SELECT modules FROM companies WHERE id = $1`, [a.companyId]))?.modules ?? []
    if (mods.includes('maioridade')) {
      if (!input.ageConfirmed) throw new HttpError(422, 'maioridade_requerida', `Venda de produto restrito (${restricted[0].v.name}): confirme que o cliente tem ${settings.maioridade.idadeMinima} anos ou mais e que o documento foi conferido.`)
      ageVerifiedBy = a.userId
    }
  }
  subtotal = r2(subtotal); lineDiscounts = r2(lineDiscounts)
  const extra = r2(input.discountTotal ?? 0)
  if (extra < 0 || extra > subtotal - lineDiscounts) throw unprocessable('Desconto no total inválido.')
  // rateia o desconto do total entre as linhas (para comissão, devolução e fiscal)
  if (extra > 0) {
    const base = subtotal - lineDiscounts
    let allocated = 0
    lines.forEach((l, i) => {
      const share = i === lines.length - 1 ? r2(extra - allocated) : r2(extra * (l.net / base))
      allocated = r2(allocated + share); l.disc = r2(l.disc + share); l.net = r2(l.gross - l.disc)
    })
  }
  const discountTotal = r2(lineDiscounts + extra)
  const total = r2(subtotal - discountTotal)
  const discountPct = subtotal > 0 ? (discountTotal / subtotal) * 100 : 0
  // descontos já aprovados no plano de tratamento não contam para o limite do operador
  const preApproved = r2(lines.reduce((acc, l) => acc + l.preApproved, 0))
  const discountPctToAuthorize = subtotal > 0 ? (Math.max(0, discountTotal - preApproved) / subtotal) * 100 : 0
  // descontos vindos de acerto de consignação (comissão da parceira) não passam pelo limite do vendedor
  const authorizedBy = input.channel === 'consignacao' ? null : await authorizeDiscount(c, a, discountPctToAuthorize, input.discountAuthorization)

  if (input.customerId) {
    const cu = await c.one(`SELECT id, active, anonymized_at FROM customers WHERE id = $1 AND company_id = $2`, [input.customerId, a.companyId])
    if (!cu || cu.anonymized_at) throw unprocessable('Cliente não encontrado.')
    if (!cu.active) throw unprocessable('Cliente inativo.')
  }
  const sellerId = input.sellerId || a.userId
  if (input.sellerId) {
    const s = await c.one(`SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2 AND active`, [input.sellerId, a.companyId])
    if (!s) throw unprocessable('Vendedor não pertence a esta empresa.')
  }

  const number = await nextNumber(c, a.companyId, type === 'orcamento' ? 'orcamento' : 'venda')
  // ---------- Orçamento: apenas registra ----------
  if (type === 'orcamento') {
    const sale = await c.one(
      `INSERT INTO sales(company_id, branch_id, number, type, status, channel, customer_id, seller_id, subtotal, discount_total, total, cost_total, items_count, notes, valid_until, created_by, discount_authorized_by)
       VALUES ($1,$2,$3,'orcamento','orcamento',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [a.companyId, a.branchId, number, input.channel ?? 'loja', input.customerId ?? null, sellerId, subtotal, discountTotal, total, r2(costTotal), itemsCount,
        input.notes ?? null, input.validUntil ?? addDays(today(), settings.vendas.validadeOrcamentoDias), a.userId, authorizedBy])
    await insertItems(c, a, sale.id, lines)
    if (ctx) await audit(c, ctx, 'orcamento.criado', 'sale', sale.id, { number, total })
    return sale
  }

  // ---------- Pagamentos ----------
  const payments = input.payments ?? []
  if (!payments.length && !input.onAccount) throw unprocessable('Informe as formas de pagamento.')
  const methods = payments.length ? await c.many(`SELECT * FROM payment_methods WHERE company_id = $1 AND id = ANY($2::uuid[]) AND active`, [a.companyId, payments.map((p) => p.methodId)]) : []
  const mmap = new Map(methods.map((m) => [m.id, m]))
  let paid = 0
  for (const p of payments) {
    const m = mmap.get(p.methodId)
    if (!m) throw unprocessable('Forma de pagamento inválida ou inativa.')
    if (!(p.amount > 0)) throw unprocessable(`Valor inválido para ${m.name}.`)
    const inst = p.installments ?? 1
    if (!Number.isInteger(inst) || inst < 1 || inst > Math.max(1, m.kind === 'crediario' ? settings.crediario.maxParcelas : m.max_installments))
      throw unprocessable(`Número de parcelas inválido para ${m.name}.`)
    paid = r2(paid + r2(p.amount))
  }
  let change = 0
  if (payments.length) {
    if (paid < total - 0.001) throw unprocessable(`Pagamentos (R$ ${paid.toFixed(2)}) não cobrem o total (R$ ${total.toFixed(2)}).`)
    change = r2(paid - total)
    if (change > 0) {
      const cash = payments.filter((p) => mmap.get(p.methodId).kind === 'dinheiro').reduce((s, p) => s + p.amount, 0)
      if (cash < change - 0.001) throw unprocessable('Troco só é permitido quando há pagamento em dinheiro suficiente.')
    }
  }
  const needsCash = payments.some((p) => mmap.get(p.methodId).kind === 'dinheiro')
  let session: any = null
  if (needsCash || (settings.vendas.exigirCaixaAberto && (input.channel ?? 'loja') === 'loja')) {
    session = await c.one(`SELECT cs.*, cr.account_id FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.register_id
                            WHERE cs.company_id = $1 AND cs.branch_id = $2 AND cs.status = 'aberto'
                            ORDER BY (cs.opened_by = $3) DESC, cs.opened_at DESC LIMIT 1`, [a.companyId, a.branchId, a.userId])
    if (!session && needsCash) throw conflict('Não há caixa aberto nesta filial. Abra o caixa para receber em dinheiro.')
    if (!session && settings.vendas.exigirCaixaAberto && (input.channel ?? 'loja') === 'loja') throw conflict('Abra o caixa antes de registrar vendas no PDV.')
  }

  const sale = await c.one(
    `INSERT INTO sales(company_id, branch_id, number, type, status, channel, customer_id, seller_id, cash_session_id, subtotal, discount_total, total, cost_total,
        items_count, notes, origin_type, origin_id, external_id, created_by, discount_authorized_by)
     VALUES ($1,$2,$3,'venda','concluida',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [a.companyId, a.branchId, number, input.channel ?? 'loja', input.customerId ?? null, sellerId, session?.id ?? null, subtotal, discountTotal, total,
      r2(costTotal), itemsCount, input.notes ?? null, input.originType ?? null, input.originId ?? null, input.externalId ?? null, a.userId, authorizedBy])
  await insertItems(c, a, sale.id, lines)
  if (ageVerifiedBy) await c.query(`UPDATE sales SET age_verified_by = $2, age_verified_at = now() WHERE id = $1`, [sale.id, ageVerifiedBy])

  // ---------- Estoque ----------
  if (!input.skipStock) {
    for (const l of lines) {
      if (l.v.kind && l.v.kind !== 'produto') continue // serviços e pacotes não movimentam estoque
      await moveStock(c, { companyId: a.companyId, branchId: a.branchId, variantId: l.v.id, qty: -l.qty, type: 'venda', refType: 'sale', refId: sale.id,
        unitCost: Number(l.v.cost), userId: a.userId, allowNegative: settings.vendas.permitirEstoqueNegativo, notes: `Venda nº ${number}` })
      await consumeLots(c, a.branchId, l.v.id, l.qty)
    }
  }

  // ---------- Financeiro ----------
  const catVenda = await systemCategory(c, a.companyId, 'venda')
  const doc = `V${number}`
  let earnBase = 0
  let seq = 0
  for (const p of payments) {
    const m = mmap.get(p.methodId)
    seq++
    const amount = m.kind === 'dinheiro' ? r2(p.amount - Math.min(change, p.amount)) : r2(p.amount)
    if (m.kind === 'dinheiro') change = r2(change - Math.min(change, p.amount))
    if (amount <= 0) continue
    const sp = await c.one(
      `INSERT INTO sale_payments(sale_id, company_id, method_id, kind, amount, installments, change_amount, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [sale.id, a.companyId, m.id, m.kind, amount, p.installments ?? 1, r2(p.amount - amount), JSON.stringify(p.details ?? {})])
    switch (m.kind) {
      case 'dinheiro': {
        await c.query(`INSERT INTO cash_movements(company_id, session_id, type, amount, ref_type, ref_id, user_id) VALUES ($1,$2,'venda',$3,'sale',$4,$5)`,
          [a.companyId, session.id, amount, sale.id, a.userId])
        await addTransaction(c, { companyId: a.companyId, branchId: a.branchId, accountId: session.account_id || m.account_id || (await defaultAccount(c, a.companyId, a.branchId, 'caixa')),
          direction: 'entrada', amount, description: `Venda ${doc} — dinheiro`, categoryId: catVenda, saleId: sale.id, sourceType: 'sale_payment', sourceId: sp.id, userId: a.userId })
        earnBase += amount; break
      }
      case 'pix': {
        await addTransaction(c, { companyId: a.companyId, branchId: a.branchId, accountId: m.account_id || (await defaultAccount(c, a.companyId, a.branchId, 'banco')),
          direction: 'entrada', amount, description: `Venda ${doc} — PIX`, categoryId: catVenda, saleId: sale.id, sourceType: 'sale_payment', sourceId: sp.id, userId: a.userId })
        earnBase += amount; break
      }
      case 'debito': case 'credito': case 'boleto': case 'outro': {
        const n = m.kind === 'credito' ? (p.installments ?? 1) : 1
        const parts = splitInstallments(amount, n)
        for (let i = 0; i < n; i++) {
          await createReceivable(c, { companyId: a.companyId, branchId: a.branchId, customerId: m.kind === 'boleto' || m.kind === 'outro' ? input.customerId : null, saleId: sale.id,
            sourceType: 'sale_payment', sourceId: sp.id, document: doc, installmentNo: i + 1, installmentsTotal: n,
            methodKind: m.kind === 'credito' ? 'cartao_credito' : m.kind === 'debito' ? 'cartao_debito' : m.kind, paymentMethodId: m.id, categoryId: catVenda,
            accountId: m.account_id, dueDate: addDays(today(), m.settlement_days + (m.kind === 'credito' ? 30 * i : 0)), amount: parts[i],
            feeAmount: r2(parts[i] * Number(m.fee_pct) / 100), description: `${m.name} — venda ${doc}`, userId: a.userId })
        }
        earnBase += amount; break
      }
      case 'crediario': {
        if (!input.customerId) throw unprocessable('Crediário exige cliente identificado.')
        const cust = await c.one(`SELECT credit_limit FROM customers WHERE id = $1 FOR UPDATE`, [input.customerId])
        const open = await c.one<{ s: number }>(`SELECT COALESCE(sum(${BALANCE_SQL}),0) AS s FROM receivables WHERE customer_id = $1 AND method_kind = 'crediario' AND status IN ('aberto','parcial')`, [input.customerId])
        const limit = Number(cust.credit_limit)
        if (settings.crediario.exigirLimite && limit <= 0) throw unprocessable('Cliente sem limite de crediário aprovado. Defina o limite no cadastro do cliente.')
        if (limit > 0 && Number(open!.s) + amount > limit + 0.001) throw unprocessable(`Limite de crediário excedido. Disponível: R$ ${Math.max(0, limit - Number(open!.s)).toFixed(2)}.`)
        const n = p.installments ?? 1
        const parts = splitInstallments(amount, n)
        if (n > 1 && parts[parts.length - 1] < settings.crediario.parcelaMinima) throw unprocessable(`Parcela mínima do crediário: R$ ${settings.crediario.parcelaMinima.toFixed(2)}.`)
        const dates = dueDates(p.firstDueDate || addDays(today(), 30), n)
        for (let i = 0; i < n; i++) {
          await createReceivable(c, { companyId: a.companyId, branchId: a.branchId, customerId: input.customerId, saleId: sale.id, sourceType: 'sale_payment', sourceId: sp.id,
            document: doc, installmentNo: i + 1, installmentsTotal: n, methodKind: 'crediario', paymentMethodId: m.id,
            categoryId: await systemCategory(c, a.companyId, 'recebimento_crediario'), dueDate: dates[i], amount: parts[i], description: `Crediário venda ${doc}`, userId: a.userId })
        }
        if (settings.fidelidade.acumularNoCrediario) earnBase += amount
        break
      }
      case 'vale_troca': {
        if (!p.storeCreditCode) throw unprocessable('Informe o código do vale-troca.')
        const cr = await c.one(`SELECT * FROM store_credits WHERE company_id = $1 AND code = $2 FOR UPDATE`, [a.companyId, p.storeCreditCode.toUpperCase()])
        if (!cr || cr.status !== 'ativo') throw unprocessable('Vale-troca inválido ou já utilizado.')
        if (cr.expires_at && cr.expires_at < today()) throw unprocessable('Vale-troca expirado.')
        if (Number(cr.balance) < amount - 0.001) throw unprocessable(`Saldo do vale-troca insuficiente (R$ ${Number(cr.balance).toFixed(2)}).`)
        const nb = r2(Number(cr.balance) - amount)
        await c.query(`UPDATE store_credits SET balance = $2, status = CASE WHEN $2 <= 0 THEN 'utilizado' ELSE status END WHERE id = $1`, [cr.id, nb])
        await c.query(`INSERT INTO store_credit_movements(credit_id, amount, ref_type, ref_id) VALUES ($1,$2,'sale',$3)`, [cr.id, -amount, sale.id])
        await c.query(`UPDATE sale_payments SET details = details || $2 WHERE id = $1`, [sp.id, JSON.stringify({ storeCreditId: cr.id, code: cr.code })])
        break
      }
      case 'cashback': {
        if (!input.customerId) throw unprocessable('Resgate de cashback exige cliente identificado.')
        await redeemCashback(c, a.companyId, input.customerId, amount, sale.id, total, a.userId)
        break
      }
    }
  }
  if (input.onAccount) {
    await createReceivable(c, { companyId: a.companyId, branchId: a.branchId, customerId: input.customerId, saleId: sale.id, sourceType: 'sale', sourceId: sale.id,
      document: doc, methodKind: 'a_prazo', categoryId: catVenda, dueDate: input.onAccount.dueDate, amount: total, description: input.onAccount.description || `Venda ${doc} a prazo`, userId: a.userId })
  }

  // ---------- Comissão ----------
  // vendedor: itens sem profissional (pacotes geram comissão na execução de cada sessão)
  const sellerLines = lines.filter((l) => !l.professionalId && l.v.kind !== 'pacote')
  if (sellerLines.length) {
    const comm = await computeCommission(c, a.companyId, sellerId, sellerLines.map((l) => ({ net: l.net, category_id: l.v.category_id, brand_id: l.v.brand_id, collection_id: l.v.collection_id, sku: l.v.sku })))
    await recordCommission(c, { companyId: a.companyId, branchId: a.branchId, sellerId, saleId: sale.id, refType: 'venda', refId: sale.id, base: comm.base, amount: comm.amount, details: comm.details })
  }
  // profissional: comissão por item (serviço ou produto) conforme o cadastro do profissional/serviço
  for (const l of lines.filter((x) => x.professionalId)) {
    const pct = await commissionPct(c, l.professionalId!, l.v.product_id)
    await addProfessionalCommission(c, { companyId: a.companyId, branchId: a.branchId, professionalId: l.professionalId!, kind: l.v.kind === 'produto' ? 'produto' : 'servico',
      refType: 'venda', refKey: 'sale_item:' + l.id, saleId: sale.id, saleItemId: l.id, appointmentId: l.appointmentId, description: `${l.v.name} — venda ${doc}`, base: l.net, pct })
  }

  // ---------- Pacotes de sessões ----------
  for (const l of lines.filter((x) => x.v.kind === 'pacote')) {
    const each = r2(l.net / l.qty)
    for (let k = 0; k < l.qty; k++) {
      await c.query(`INSERT INTO customer_packages(company_id, customer_id, package_product_id, service_product_id, sessions_total, price, unit_value, sale_id, sale_item_id, expires_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10::int IS NULL THEN NULL ELSE current_date + $10::int END)`,
        [a.companyId, input.customerId, l.v.product_id, l.v.package_service_id, l.v.package_sessions, each, Math.round((each / l.v.package_sessions) * 10000) / 10000, sale.id, l.id, l.v.package_validity_days ?? null])
    }
  }

  // ---------- Atendimentos e planos de tratamento cobrados ----------
  const apptIds = new Set<string>()
  const woIds = new Set<string>()
  for (const l of lines) {
    if (l.appointmentServiceId) {
      await c.query(`UPDATE appointment_services SET sale_item_id = $2 WHERE id = $1`, [l.appointmentServiceId, l.id])
      if (l.appointmentId) apptIds.add(l.appointmentId)
    }
    if (l.planItemId) {
      await c.query(`UPDATE treatment_plan_items SET sale_id = $2 WHERE id = $1`, [l.planItemId, sale.id])
      await refreshPlanStatus(c, l.planItemId)
    }
    if (l.workOrderItemId) {
      await c.query(`UPDATE work_order_items SET sale_item_id = $2 WHERE id = $1`, [l.workOrderItemId, l.id])
      await c.query(`UPDATE sale_items SET work_order_item_id = $2 WHERE id = $1`, [l.id, l.workOrderItemId])
      if (l.workOrderId) woIds.add(l.workOrderId)
    }
  }
  for (const id of woIds) await workOrderBilled(c, { companyId: a.companyId, userId: a.userId }, id, sale.id)
  for (const id of apptIds) {
    await c.query(`UPDATE appointments SET sale_id = $2 WHERE id = $1`, [id, sale.id])
    await completeAppointment(c, { companyId: a.companyId, userId: a.userId }, id)
  }

  // ---------- Fidelidade ----------
  let cashback = 0
  if (input.customerId && earnBase > 0) cashback = await earnCashback(c, a.companyId, input.customerId, sale.id, r2(earnBase), a.userId)

  // ---------- Fiscal ----------
  let fiscalDoc = null
  // NFC-e só para mercadorias; serviços (ISS) são documentados por NFS-e municipal
  if ((input.emitFiscal ?? settings.fiscal.emitirNfceAutomatico) && lines.some((l) => !l.v.kind || l.v.kind === 'produto')) fiscalDoc = await createDocumentForSale(c, a.companyId, a.branchId, sale.id, '65', a.userId)

  if (ctx) await audit(c, ctx, 'venda.concluida', 'sale', sale.id, { number, total, payments: payments.length, discountPct: r2(discountPct), authorizedBy }, authorizedBy && authorizedBy !== a.userId ? 'warning' : 'info')
  return { ...sale, cashback_earned: cashback, fiscal_document_id: fiscalDoc?.id ?? null }
}

async function insertItems(c: Q, a: Actor, saleId: string, lines: { v: any; qty: number; unit: number; disc: number; net: number; comboId?: string | null; packagingId?: string | null; tierMin?: number | null
  professionalId?: string | null; appointmentServiceId?: string | null; planItemId?: string | null; id?: string }[]) {
  let n = 0
  for (const l of lines) {
    n++
    const r = await c.one(`INSERT INTO sale_items(sale_id, company_id, line, variant_id, qty, unit_price, discount, total, unit_cost, combo_id, packaging_id, price_tier_min_qty, professional_id, appointment_service_id, plan_item_id)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [saleId, a.companyId, n, l.v.id, l.qty, l.unit, l.disc, l.net, Number(l.v.cost), l.comboId ?? null, l.packagingId ?? null, l.tierMin ?? null, l.professionalId ?? null, l.appointmentServiceId ?? null, l.planItemId ?? null])
    l.id = r.id
  }
}

/** Cancela uma venda revertendo estoque, financeiro, caixa, vale-troca, cashback e comissão. */
export async function cancelSale(c: Q, a: Actor, saleId: string, reason: string, ctx?: Ctx) {
  if (!reason || reason.trim().length < 5) throw unprocessable('Informe o motivo do cancelamento.')
  const s = await c.one(`SELECT * FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE`, [saleId, a.companyId])
  if (!s) throw notFound('Venda')
  if (s.status === 'cancelada') throw conflict('Venda já cancelada.')
  if (s.type === 'orcamento') {
    await c.query(`UPDATE sales SET status = 'cancelada', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`, [saleId, a.userId, reason])
    return { ok: true }
  }
  if (s.status !== 'concluida') throw conflict('Somente vendas concluídas e sem devoluções podem ser canceladas. Use troca/devolução.')
  if (s.channel === 'consignacao') throw conflict('Vendas de acerto de consignação devem ser revertidas pelo módulo de consignação.')
  const paidTitles = await c.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM receivables WHERE sale_id = $1 AND paid_amount > 0 AND status <> 'cancelado' AND method_kind IN ('crediario','a_prazo','boleto')`, [saleId])
  if (paidTitles!.n > 0) throw conflict('Há parcelas já recebidas desta venda. Estorne os recebimentos antes de cancelar.')
  const fd = await c.one(`SELECT id, status FROM fiscal_documents WHERE sale_id = $1 AND status = 'autorizado'`, [saleId])
  if (fd) throw conflict('Esta venda possui documento fiscal autorizado. Cancele o documento fiscal primeiro (Fiscal > Documentos).')

  const items = await c.many(`SELECT si.*, p.kind FROM sale_items si JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id WHERE si.sale_id = $1`, [saleId])
  // pacotes: só cancela se nenhuma sessão foi usada
  const usedPkg = await c.one(`SELECT count(*)::int AS n FROM customer_packages WHERE sale_id = $1 AND sessions_used > 0`, [saleId])
  if (usedPkg.n > 0) throw conflict('Esta venda tem pacote com sessões já utilizadas: registre a devolução apenas dos itens não usados.')
  await c.query(`UPDATE customer_packages SET status = 'cancelado' WHERE sale_id = $1`, [saleId])
  for (const it of items) {
    if (it.kind && it.kind !== 'produto') continue
    await moveStock(c, { companyId: a.companyId, branchId: s.branch_id, variantId: it.variant_id, qty: it.qty, type: 'cancelamento_venda', refType: 'sale', refId: saleId, userId: a.userId, allowNegative: true, notes: `Cancelamento venda nº ${s.number}` })
  }
  // títulos em aberto (cartão/crediário) -> cancelados
  await c.query(`UPDATE receivables SET status = 'cancelado', updated_at = now() WHERE sale_id = $1 AND status IN ('aberto','parcial')`, [saleId])
  // movimentos financeiros liquidados (dinheiro/pix) -> estorno
  await reverseTransactionsOf(c, a.companyId, { saleId, sourceType: 'sale_payment' }, `cancelamento venda ${s.number}`, a.userId)
  // caixa
  const cashPaid = await c.one<{ s: number }>(`SELECT COALESCE(sum(amount),0) AS s FROM cash_movements WHERE ref_type = 'sale' AND ref_id = $1 AND type = 'venda'`, [saleId])
  if (Number(cashPaid!.s) > 0) {
    const open = await c.one(`SELECT id FROM cash_sessions WHERE company_id = $1 AND branch_id = $2 AND status = 'aberto' ORDER BY (id = $3) DESC LIMIT 1`, [a.companyId, s.branch_id, s.cash_session_id])
    if (open) await c.query(`INSERT INTO cash_movements(company_id, session_id, type, amount, ref_type, ref_id, user_id, notes) VALUES ($1,$2,'estorno',$3,'sale',$4,$5,$6)`,
      [a.companyId, open.id, -Number(cashPaid!.s), saleId, a.userId, `Cancelamento venda nº ${s.number}`])
  }
  // vale-troca utilizado volta ao cliente
  const credits = await c.many(`SELECT m.credit_id, m.amount FROM store_credit_movements m WHERE m.ref_type = 'sale' AND m.ref_id = $1`, [saleId])
  for (const cr of credits) {
    await c.query(`UPDATE store_credits SET balance = balance + $2, status = 'ativo' WHERE id = $1`, [cr.credit_id, -Number(cr.amount)])
    await c.query(`INSERT INTO store_credit_movements(credit_id, amount, ref_type, ref_id) VALUES ($1,$2,'sale_cancel',$3) ON CONFLICT DO NOTHING`, [cr.credit_id, -Number(cr.amount), saleId])
  }
  await reverseLoyalty(c, a.companyId, saleId, 1, 'cancelamento', saleId, a.userId)
  const comm = await c.one(`SELECT * FROM commissions WHERE ref_type = 'venda' AND ref_id = $1`, [saleId])
  if (comm) await recordCommission(c, { companyId: a.companyId, branchId: s.branch_id, sellerId: comm.seller_id, saleId, refType: 'cancelamento', refId: saleId, base: -Number(comm.base_amount), amount: -Number(comm.amount), details: { motivo: reason } })
  // comissões de profissionais e vínculos com atendimento/plano
  const pcs = await c.many(`SELECT * FROM professional_commissions WHERE sale_id = $1 AND ref_type = 'venda'`, [saleId])
  for (const pc of pcs) await addProfessionalCommission(c, { companyId: a.companyId, branchId: s.branch_id, professionalId: pc.professional_id, kind: pc.kind, refType: 'cancelamento', refKey: pc.ref_key,
    saleId, saleItemId: pc.sale_item_id, appointmentId: pc.appointment_id, description: `Cancelamento venda ${s.number}`, base: -Number(pc.base_amount), pct: Number(pc.pct), amount: -Number(pc.amount) })
  await c.query(`UPDATE appointment_services SET sale_item_id = NULL WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = $1)`, [saleId])
  await c.query(`UPDATE appointments SET sale_id = NULL WHERE sale_id = $1`, [saleId])
  await c.query(`UPDATE treatment_plan_items SET sale_id = NULL WHERE sale_id = $1`, [saleId])
  // OS volta a ficar pendente de cobrança (não reabre a entrega: registra no histórico)
  const wos = await c.many(`SELECT DISTINCT i.work_order_id FROM work_order_items i JOIN sale_items si ON si.id = i.sale_item_id WHERE si.sale_id = $1`, [saleId])
  await c.query(`UPDATE work_order_items SET sale_item_id = NULL WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = $1)`, [saleId])
  for (const w of wos) {
    await c.query(`UPDATE work_orders SET sale_id = NULL, updated_at = now() WHERE id = $1 AND sale_id = $2`, [w.work_order_id, saleId])
    await c.query(`INSERT INTO work_order_events(work_order_id, note, user_id) VALUES ($1,$2,$3)`, [w.work_order_id, `Venda ${s.number} cancelada: itens voltaram a ficar pendentes de cobrança (${reason})`, a.userId])
  }
  await c.query(`UPDATE fiscal_documents SET status = 'cancelado', cancelled_at = now(), cancel_reason = $2 WHERE sale_id = $1 AND status IN ('rascunho','invalido','pendente_configuracao','erro','rejeitado')`, [saleId, 'Venda cancelada: ' + reason])
  await c.query(`UPDATE sales SET status = 'cancelada', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`, [saleId, a.userId, reason])
  if (ctx) await audit(c, ctx, 'venda.cancelada', 'sale', saleId, { number: s.number, total: s.total, reason }, 'warning')
  return { ok: true }
}

export interface ReturnInput {
  saleId: string
  type: 'devolucao' | 'troca'
  refundMode: 'vale_troca' | 'dinheiro' | 'pix' | 'estorno_cartao' | 'abatimento_crediario'
  items: { saleItemId: string; qty: number; restock?: boolean }[]
  reason?: string
}

/** Troca/devolução parcial ou total com ajustes de estoque, financeiro, comissão e cashback. */
export async function registerReturn(c: Q, a: Actor, input: ReturnInput, ctx?: Ctx) {
  const settings = await getSettings(c, a.companyId)
  const s = await c.one(`SELECT * FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE`, [input.saleId, a.companyId])
  if (!s) throw notFound('Venda')
  if (!['concluida', 'devolvida_parcial'].includes(s.status)) throw conflict('Esta venda não aceita devolução.')
  const days = Math.floor((Date.now() - new Date(s.created_at).getTime()) / 86400000)
  if (days > settings.trocas.prazoDias && !has(a, 'vendas.cancelar')) throw forbidden(`Prazo de troca/devolução (${settings.trocas.prazoDias} dias) expirado. Requer gerente.`)
  if (input.type === 'troca' && input.refundMode !== 'vale_troca') throw unprocessable('Trocas geram vale-troca para a nova compra.')
  if (!input.items?.length) throw unprocessable('Selecione os itens devolvidos.')
  const saleItems = await c.many(`SELECT si.*, p.kind FROM sale_items si JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id WHERE si.sale_id = $1 FOR UPDATE OF si`, [s.id])
  const map = new Map(saleItems.map((i) => [i.id, i]))
  let total = 0
  const lines = input.items.map((ri) => {
    const it = map.get(ri.saleItemId)
    if (!it) throw unprocessable('Item não pertence à venda.')
    const avail = r3(Number(it.qty) - Number(it.returned_qty))
    if (!(ri.qty > 0) || ri.qty > avail + 1e-9) throw unprocessable(`Quantidade inválida para devolução (disponível: ${avail}).`)
    const unitNet = Number(it.total) / it.qty
    const value = r2(unitNet * ri.qty)
    total = r2(total + value)
    return { it, qty: ri.qty, value, unit: r2(unitNet), restock: ri.restock !== false }
  })
  const number = await nextNumber(c, a.companyId, 'devolucao')
  const ret = await c.one(
    `INSERT INTO returns(company_id, branch_id, number, sale_id, customer_id, type, refund_mode, total, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [a.companyId, a.branchId, number, s.id, s.customer_id, input.type, input.refundMode, total, input.reason ?? null, a.userId])
  for (const l of lines) {
    await c.query(`INSERT INTO return_items(return_id, sale_item_id, variant_id, qty, unit_price, total, restock) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ret.id, l.it.id, l.it.variant_id, l.qty, l.unit, l.value, l.restock])
    await c.query(`UPDATE sale_items SET returned_qty = returned_qty + $2 WHERE id = $1`, [l.it.id, l.qty])
    if (l.it.kind === 'pacote') {
      // devolve pacotes não utilizados (os que já tiveram sessão não podem ser devolvidos)
      const free = await c.many(`SELECT id FROM customer_packages WHERE sale_item_id = $1 AND status = 'ativo' AND sessions_used = 0 ORDER BY created_at DESC LIMIT $2 FOR UPDATE`, [l.it.id, l.qty])
      if (free.length < l.qty) throw conflict('Pacote com sessões já utilizadas não pode ser devolvido.')
      await c.query(`UPDATE customer_packages SET status = 'cancelado' WHERE id = ANY($1::uuid[])`, [free.map((x) => x.id)])
    }
    const pc = await c.one(`SELECT * FROM professional_commissions WHERE sale_item_id = $1 AND ref_type = 'venda'`, [l.it.id])
    if (pc) {
      const ratioItem = l.qty / Number(l.it.qty)
      await addProfessionalCommission(c, { companyId: a.companyId, branchId: s.branch_id, professionalId: pc.professional_id, kind: pc.kind, refType: 'devolucao', refKey: `${ret.id}:${l.it.id}`,
        saleId: s.id, saleItemId: l.it.id, appointmentId: pc.appointment_id, description: `Devolução nº ${number} (venda ${s.number})`, base: -l.value, pct: Number(pc.pct), amount: -r2(Number(pc.amount) * ratioItem) })
    }
    if (l.restock && (!l.it.kind || l.it.kind === 'produto')) await moveStock(c, { companyId: a.companyId, branchId: a.branchId, variantId: l.it.variant_id, qty: l.qty, type: 'devolucao', refType: 'return', refId: ret.id, userId: a.userId, allowNegative: true, notes: `Devolução nº ${number} (venda ${s.number})` })
  }
  // Reembolso
  const catDev = await systemCategory(c, a.companyId, 'devolucao')
  let storeCredit: any = null
  switch (input.refundMode) {
    case 'vale_troca': {
      const code = 'VT' + randomCode(8)
      storeCredit = await c.one(
        `INSERT INTO store_credits(company_id, customer_id, code, origin_type, origin_id, amount, balance, expires_at) VALUES ($1,$2,$3,'return',$4,$5,$5,$6) RETURNING *`,
        [a.companyId, s.customer_id, code, ret.id, total, settings.trocas.validadeValeTrocaDias > 0 ? addDays(today(), settings.trocas.validadeValeTrocaDias) : null])
      await c.query(`UPDATE returns SET store_credit_id = $2 WHERE id = $1`, [ret.id, storeCredit.id])
      break
    }
    case 'dinheiro': {
      const session = await c.one(`SELECT cs.*, cr.account_id FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.register_id WHERE cs.company_id = $1 AND cs.branch_id = $2 AND cs.status = 'aberto' ORDER BY (cs.opened_by = $3) DESC LIMIT 1`, [a.companyId, a.branchId, a.userId])
      if (!session) throw conflict('Abra o caixa para devolver em dinheiro.')
      await c.query(`INSERT INTO cash_movements(company_id, session_id, type, amount, ref_type, ref_id, user_id) VALUES ($1,$2,'devolucao',$3,'return',$4,$5)`, [a.companyId, session.id, -total, ret.id, a.userId])
      await addTransaction(c, { companyId: a.companyId, branchId: a.branchId, accountId: session.account_id || (await defaultAccount(c, a.companyId, a.branchId, 'caixa')), direction: 'saida', amount: total, description: `Devolução nº ${number} (venda ${s.number}) — dinheiro`, categoryId: catDev, saleId: s.id, sourceType: 'return', sourceId: ret.id, userId: a.userId })
      break
    }
    case 'pix': {
      await addTransaction(c, { companyId: a.companyId, branchId: a.branchId, accountId: await defaultAccount(c, a.companyId, a.branchId, 'banco'), direction: 'saida', amount: total, description: `Devolução nº ${number} (venda ${s.number}) — PIX`, categoryId: catDev, saleId: s.id, sourceType: 'return', sourceId: ret.id, userId: a.userId })
      break
    }
    case 'estorno_cartao': case 'abatimento_crediario': {
      const kinds = input.refundMode === 'estorno_cartao' ? ['cartao_credito', 'cartao_debito'] : ['crediario']
      const open = await c.many(`SELECT *, ${BALANCE_SQL} AS balance FROM receivables WHERE sale_id = $1 AND method_kind = ANY($2) AND status IN ('aberto','parcial') ORDER BY due_date DESC FOR UPDATE`, [s.id, kinds])
      let left = total
      for (const t of open) {
        if (left <= 0) break
        const reduce = Math.min(left, Number(t.balance))
        await c.query(`UPDATE receivables SET amount = amount - $2, status = CASE WHEN amount - $2 + interest + fine - discount - paid_amount <= 0.001 THEN (CASE WHEN paid_amount > 0 THEN 'pago' ELSE 'cancelado' END) ELSE status END, description = COALESCE(description,'') || $3, updated_at = now() WHERE id = $1`,
          [t.id, r2(reduce), ` | abatido R$ ${reduce.toFixed(2)} pela devolução nº ${number}`])
        left = r2(left - reduce)
      }
      if (left > 0.009) throw unprocessable(`Saldo em aberto insuficiente para abater (faltam R$ ${left.toFixed(2)}). Escolha outra forma de reembolso.`)
      break
    }
  }
  const allQty = saleItems.reduce((acc, i) => acc + i.qty, 0)
  const returnedQty = saleItems.reduce((acc, i) => acc + i.returned_qty, 0) + lines.reduce((acc, l) => acc + l.qty, 0)
  await c.query(`UPDATE sales SET status = $2 WHERE id = $1`, [s.id, returnedQty >= allQty ? 'devolvida' : 'devolvida_parcial'])
  const ratio = Number(s.total) > 0 ? total / Number(s.total) : 0
  const comm = await c.one(`SELECT * FROM commissions WHERE ref_type = 'venda' AND ref_id = $1`, [s.id])
  // comissão do vendedor: só sobre os itens que entraram na base dele (sem profissional e sem pacote)
  const sellerBase = r2(lines.filter((l) => !l.it.professional_id && l.it.kind !== 'pacote').reduce((acc, l) => acc + l.value, 0))
  if (comm && sellerBase > 0) await recordCommission(c, { companyId: a.companyId, branchId: s.branch_id, sellerId: comm.seller_id, saleId: s.id, refType: 'devolucao', refId: ret.id, base: -sellerBase,
    amount: -r2(Number(comm.base_amount) > 0 ? Number(comm.amount) * sellerBase / Number(comm.base_amount) : 0), details: { devolucao: number } })
  await reverseLoyalty(c, a.companyId, s.id, ratio, 'devolucao', ret.id, a.userId)
  if (ctx) await audit(c, ctx, input.type === 'troca' ? 'venda.troca' : 'venda.devolucao', 'sale', s.id, { returnNumber: number, total, refundMode: input.refundMode }, 'warning')
  return { ...ret, store_credit: storeCredit }
}
