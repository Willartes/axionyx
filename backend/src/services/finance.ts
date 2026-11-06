import { Q } from '../core/db'
import { conflict, notFound, unprocessable } from '../core/errors'
import { r2, today, addDays } from '../core/http'
import { getSettings } from './settings'

export const BALANCE_SQL = `(amount + interest + fine - discount - paid_amount)`

export async function systemCategory(c: Q, companyId: string, key: string): Promise<string | null> {
  const r = await c.one<{ id: string }>('SELECT id FROM financial_categories WHERE company_id = $1 AND system_key = $2', [companyId, key])
  return r?.id ?? null
}

export async function defaultAccount(c: Q, companyId: string, branchId: string | null, type: 'caixa' | 'banco' | 'adquirente' | 'carteira_digital'): Promise<string> {
  const r = await c.one<{ id: string }>(
    `SELECT id FROM financial_accounts WHERE company_id = $1 AND type = $2 AND active
      ORDER BY (branch_id = $3) DESC NULLS LAST, created_at LIMIT 1`, [companyId, type, branchId])
  if (r) return r.id
  const any = await c.one<{ id: string }>(`SELECT id FROM financial_accounts WHERE company_id = $1 AND active ORDER BY created_at LIMIT 1`, [companyId])
  if (!any) throw unprocessable('Nenhuma conta financeira cadastrada. Cadastre uma conta em Financeiro > Contas.')
  return any.id
}

export interface TxInput {
  companyId: string; branchId?: string | null; accountId: string; direction: 'entrada' | 'saida'; amount: number
  date?: string; description: string; categoryId?: string | null; receivableId?: string | null; payableId?: string | null
  saleId?: string | null; sourceType: string; sourceId?: string | null; sourceSeq?: number; userId?: string | null; reversalOf?: string | null
}
/** Lança movimento financeiro. Repetições com a mesma origem (source_type/source_id/seq) não duplicam. */
export async function addTransaction(c: Q, t: TxInput): Promise<string> {
  if (!(t.amount > 0)) throw unprocessable('Valor do lançamento deve ser maior que zero.')
  const r = await c.one<{ id: string }>(
    `INSERT INTO financial_transactions(company_id, branch_id, account_id, direction, amount, date, description, category_id,
        receivable_id, payable_id, sale_id, source_type, source_id, source_seq, created_by, reversal_of)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, current_date),$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (company_id, source_type, source_id, source_seq) WHERE source_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [t.companyId, t.branchId ?? null, t.accountId, t.direction, r2(t.amount), t.date ?? null, t.description, t.categoryId ?? null,
      t.receivableId ?? null, t.payableId ?? null, t.saleId ?? null, t.sourceType, t.sourceId ?? null, t.sourceSeq ?? 1, t.userId ?? null, t.reversalOf ?? null])
  if (r) return r.id
  const ex = await c.one<{ id: string }>(`SELECT id FROM financial_transactions WHERE company_id = $1 AND source_type = $2 AND source_id = $3 AND source_seq = $4`,
    [t.companyId, t.sourceType, t.sourceId, t.sourceSeq ?? 1])
  return ex!.id
}

/** Estorna (lança o inverso) todos os movimentos de uma origem ainda não estornados. */
export async function reverseTransactionsOf(c: Q, companyId: string, where: { saleId?: string; sourceType?: string; sourceId?: string }, reason: string, userId?: string) {
  const rows = await c.many(
    `SELECT t.* FROM financial_transactions t
      WHERE t.company_id = $1 AND t.reversal_of IS NULL
        AND ($2::uuid IS NULL OR t.sale_id = $2) AND ($3::text IS NULL OR t.source_type = $3) AND ($4::uuid IS NULL OR t.source_id = $4)
        AND NOT EXISTS (SELECT 1 FROM financial_transactions x WHERE x.reversal_of = t.id)`,
    [companyId, where.saleId ?? null, where.sourceType ?? null, where.sourceId ?? null])
  for (const t of rows) {
    await addTransaction(c, {
      companyId, branchId: t.branch_id, accountId: t.account_id, direction: t.direction === 'entrada' ? 'saida' : 'entrada', amount: Number(t.amount),
      description: `Estorno: ${t.description} (${reason})`, categoryId: t.category_id, saleId: t.sale_id, sourceType: 'estorno', sourceId: t.id, userId, reversalOf: t.id,
    })
  }
  return rows.length
}

export interface ReceivableInput {
  companyId: string; branchId?: string | null; customerId?: string | null; saleId?: string | null; sourceType: string; sourceId?: string | null
  document: string; installmentNo?: number; installmentsTotal?: number; methodKind: string; paymentMethodId?: string | null
  categoryId?: string | null; accountId?: string | null; issueDate?: string; dueDate: string; amount: number; feeAmount?: number
  description?: string; userId?: string | null; renegotiationId?: string | null
}
export async function createReceivable(c: Q, r: ReceivableInput): Promise<string> {
  const row = await c.one<{ id: string }>(
    `INSERT INTO receivables(company_id, branch_id, customer_id, sale_id, source_type, source_id, document, installment_no, installments_total,
        method_kind, payment_method_id, category_id, account_id, issue_date, due_date, amount, fee_amount, description, created_by, renegotiation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::date,current_date),$15,$16,$17,$18,$19,$20)
     ON CONFLICT (company_id, source_type, source_id, installment_no, method_kind) WHERE source_id IS NOT NULL DO NOTHING RETURNING id`,
    [r.companyId, r.branchId ?? null, r.customerId ?? null, r.saleId ?? null, r.sourceType, r.sourceId ?? null, r.document, r.installmentNo ?? 1,
      r.installmentsTotal ?? 1, r.methodKind, r.paymentMethodId ?? null, r.categoryId ?? null, r.accountId ?? null, r.issueDate ?? null, r.dueDate,
      r2(r.amount), r2(r.feeAmount ?? 0), r.description ?? null, r.userId ?? null, r.renegotiationId ?? null])
  if (row) return row.id
  const ex = await c.one<{ id: string }>(`SELECT id FROM receivables WHERE company_id = $1 AND source_type = $2 AND source_id = $3 AND installment_no = $4 AND method_kind = $5`,
    [r.companyId, r.sourceType, r.sourceId, r.installmentNo ?? 1, r.methodKind])
  return ex!.id
}

/** Sugestão de juros/multa para título vencido conforme configuração do crediário. */
export async function chargesFor(c: Q, companyId: string, title: { due_date: string; balance: number; method_kind?: string }, onDate = today()) {
  const s = (await getSettings(c, companyId)).crediario
  const due = new Date(title.due_date + 'T12:00:00Z').getTime()
  const at = new Date(onDate + 'T12:00:00Z').getTime()
  const daysLate = Math.max(0, Math.round((at - due) / 86400000))
  const effective = Math.max(0, daysLate - s.carenciaDias)
  if (effective <= 0 || title.balance <= 0) return { daysLate, fine: 0, interest: 0 }
  const fine = r2(title.balance * s.multaPct / 100)
  const interest = r2(title.balance * (s.jurosMensalPct / 100 / 30) * daysLate)
  return { daysLate, fine, interest }
}

export interface PayInput { amount: number; interest?: number; fine?: number; discount?: number; date?: string; accountId?: string | null; method?: string; notes?: string; idempotencyKey?: string }

/**
 * Baixa (total ou parcial) de título a receber/pagar. Bloqueia a linha (FOR UPDATE) e lança o movimento financeiro.
 * Repetição com a mesma chave de idempotência retorna o pagamento já existente.
 */
export async function payTitle(c: Q, kind: 'receber' | 'pagar', companyId: string, titleId: string, input: PayInput, user: { id: string; branchId?: string }) {
  if (input.idempotencyKey) {
    const ex = await c.one(`SELECT * FROM title_payments WHERE company_id = $1 AND idempotency_key = $2`, [companyId, input.idempotencyKey])
    if (ex) return ex
  }
  const table = kind === 'receber' ? 'receivables' : 'payables'
  const t = await c.one(`SELECT *, ${BALANCE_SQL} AS balance FROM ${table} WHERE id = $1 AND company_id = $2 FOR UPDATE`, [titleId, companyId])
  if (!t) throw notFound('Título')
  if (!['aberto', 'parcial'].includes(t.status)) throw conflict(`Título com situação "${t.status}" não pode ser baixado.`)
  const interest = r2(input.interest ?? 0), fine = r2(input.fine ?? 0), discount = r2(input.discount ?? 0), amount = r2(input.amount)
  if (amount <= 0) throw unprocessable('Valor pago deve ser maior que zero.')
  const newBalance = r2(Number(t.balance) + interest + fine - discount - amount)
  if (newBalance < -0.001) throw unprocessable(`Valor pago excede o saldo do título (saldo com encargos: ${r2(Number(t.balance) + interest + fine - discount).toFixed(2)}).`)
  const status = newBalance <= 0.001 ? 'pago' : 'parcial'
  const accountId = input.accountId || t.account_id || (await defaultAccount(c, companyId, t.branch_id, kind === 'receber' ? 'caixa' : 'banco'))
  const pay = await c.one(
    `INSERT INTO title_payments(company_id, title_type, title_id, date, amount, interest, fine, discount, account_id, method, idempotency_key, notes, user_id)
     VALUES ($1,$2,$3,COALESCE($4::date,current_date),$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [companyId, kind, titleId, input.date ?? null, amount, interest, fine, discount, accountId, input.method ?? null, input.idempotencyKey ?? null, input.notes ?? null, user.id])
  const catKey = kind === 'receber' ? (t.method_kind === 'crediario' ? 'recebimento_crediario' : 'venda') : 'compra_mercadoria'
  const txId = await addTransaction(c, {
    companyId, branchId: t.branch_id, accountId, direction: kind === 'receber' ? 'entrada' : 'saida', amount, date: input.date,
    description: `${kind === 'receber' ? 'Recebimento' : 'Pagamento'} ${t.document}${t.installments_total > 1 ? ` (${t.installment_no}/${t.installments_total})` : ''}`,
    categoryId: t.category_id || (await systemCategory(c, companyId, catKey)),
    receivableId: kind === 'receber' ? titleId : null, payableId: kind === 'pagar' ? titleId : null, saleId: t.sale_id ?? null,
    sourceType: 'title_payment', sourceId: pay.id, userId: user.id,
  })
  await c.query(`UPDATE title_payments SET transaction_id = $1 WHERE id = $2`, [txId, pay.id])
  await c.query(
    `UPDATE ${table} SET interest = interest + $2, fine = fine + $3, discount = discount + $4, paid_amount = paid_amount + $5,
            status = $6, paid_at = CASE WHEN $6 = 'pago' THEN now() ELSE paid_at END, updated_at = now() WHERE id = $1`,
    [titleId, interest, fine, discount, amount, status])
  return { ...pay, transaction_id: txId, status, balance: Math.max(0, newBalance) }
}

/** Estorna um pagamento de título (lança o inverso e recompõe o saldo). */
export async function reversePayment(c: Q, companyId: string, paymentId: string, userId: string) {
  const p = await c.one(`SELECT * FROM title_payments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [paymentId, companyId])
  if (!p) throw notFound('Pagamento')
  if (p.reversed_at) throw conflict('Este pagamento já foi estornado.')
  const table = p.title_type === 'receber' ? 'receivables' : 'payables'
  const t = await c.one(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [p.title_id])
  if (!t) throw notFound('Título')
  if (t.status === 'renegociado' || t.status === 'cancelado') throw conflict('Título renegociado/cancelado: o estorno não é permitido.')
  if (p.transaction_id) await reverseTransactionsOf(c, companyId, { sourceType: 'title_payment', sourceId: p.id }, 'estorno de baixa', userId)
  await c.query(`UPDATE title_payments SET reversed_at = now() WHERE id = $1`, [p.id])
  await c.query(
    `UPDATE ${table} SET interest = interest - $2, fine = fine - $3, discount = discount - $4, paid_amount = paid_amount - $5,
            status = CASE WHEN paid_amount - $5 <= 0 THEN 'aberto' ELSE 'parcial' END, paid_at = NULL, updated_at = now() WHERE id = $1`,
    [t.id, p.interest, p.fine, p.discount, p.amount])
  return { ok: true }
}

export function dueDates(first: string, n: number, intervalDays?: number): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    if (intervalDays) out.push(addDays(first, intervalDays * i))
    else {
      const d = new Date(first + 'T12:00:00Z'); const day = d.getUTCDate()
      d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + i)
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
      d.setUTCDate(Math.min(day, last)); out.push(d.toISOString().slice(0, 10))
    }
  }
  return out
}
