import { Q } from '../core/db'
import { conflict, unprocessable } from '../core/errors'
import { r2, addDays, today } from '../core/http'
import { getSettings } from './settings'

/** Saldo disponível = soma do "restante" de créditos não expirados. */
export async function loyaltyBalance(c: Q, companyId: string, customerId: string): Promise<number> {
  const r = await c.one<{ s: number }>(
    `SELECT COALESCE(sum(remaining),0) AS s FROM loyalty_ledger
      WHERE company_id = $1 AND customer_id = $2 AND remaining > 0 AND (expires_at IS NULL OR expires_at >= current_date)`, [companyId, customerId])
  return Number(r?.s ?? 0)
}

/** Credita cashback de uma venda. Protegido contra duplicidade por (venda, 'credito'). */
export async function earnCashback(c: Q, companyId: string, customerId: string, saleId: string, base: number, userId?: string): Promise<number> {
  const s = (await getSettings(c, companyId)).fidelidade
  if (!s.ativo || base <= 0 || base < s.compraMinima) return 0
  const amount = r2(base * s.cashbackPct / 100)
  if (amount <= 0) return 0
  const r = await c.query(
    `INSERT INTO loyalty_ledger(company_id, customer_id, kind, amount, remaining, expires_at, source_type, source_id, user_id, notes)
     VALUES ($1,$2,'credito',$3,$3,$4,'venda',$5,$6,$7) ON CONFLICT DO NOTHING`,
    [companyId, customerId, amount, s.validadeDias > 0 ? addDays(today(), s.validadeDias) : null, saleId, userId ?? null, `Cashback ${s.cashbackPct}% sobre R$ ${base.toFixed(2)}`])
  return r.rowCount ? amount : 0
}

/** Consome saldo FIFO (vencimento mais próximo primeiro). */
async function consume(c: Q, companyId: string, customerId: string, amount: number) {
  let left = r2(amount)
  const credits = await c.many(
    `SELECT id, remaining FROM loyalty_ledger WHERE company_id = $1 AND customer_id = $2 AND remaining > 0
        AND (expires_at IS NULL OR expires_at >= current_date) ORDER BY expires_at NULLS LAST, id FOR UPDATE`, [companyId, customerId])
  for (const cr of credits) {
    if (left <= 0) break
    const take = Math.min(left, Number(cr.remaining))
    await c.query(`UPDATE loyalty_ledger SET remaining = remaining - $2 WHERE id = $1`, [cr.id, take])
    left = r2(left - take)
  }
  if (left > 0.001) throw conflict('Saldo de cashback insuficiente.')
}

export async function redeemCashback(c: Q, companyId: string, customerId: string, amount: number, saleId: string, saleTotal: number, userId?: string) {
  const s = (await getSettings(c, companyId)).fidelidade
  if (!s.ativo) throw unprocessable('Programa de fidelidade desativado.')
  const balance = await loyaltyBalance(c, companyId, customerId)
  if (balance < s.saldoMinimoResgate) throw unprocessable(`Saldo mínimo para resgate: R$ ${s.saldoMinimoResgate.toFixed(2)}.`)
  const max = r2(saleTotal * s.resgateMaxPct / 100)
  if (amount > max + 0.001) throw unprocessable(`Resgate máximo nesta compra: R$ ${max.toFixed(2)} (${s.resgateMaxPct}% do total).`)
  await consume(c, companyId, customerId, amount)
  const r = await c.query(
    `INSERT INTO loyalty_ledger(company_id, customer_id, kind, amount, source_type, source_id, user_id, notes)
     VALUES ($1,$2,'resgate',$3,'venda',$4,$5,'Resgate na venda') ON CONFLICT DO NOTHING`, [companyId, customerId, -r2(amount), saleId, userId ?? null])
  if (!r.rowCount) throw conflict('Resgate já registrado para esta venda.')
}

/** Estorno total (cancelamento) ou parcial (devolução) de cashback creditado e resgatado. */
export async function reverseLoyalty(c: Q, companyId: string, saleId: string, ratio: number, sourceType: 'cancelamento' | 'devolucao', sourceId: string, userId?: string) {
  const earned = await c.one(`SELECT * FROM loyalty_ledger WHERE company_id = $1 AND source_type = 'venda' AND source_id = $2 AND kind = 'credito' FOR UPDATE`, [companyId, saleId])
  if (earned) {
    const amount = r2(Number(earned.amount) * ratio)
    if (amount > 0) {
      const ins = await c.query(
        `INSERT INTO loyalty_ledger(company_id, customer_id, kind, amount, source_type, source_id, user_id, notes)
         VALUES ($1,$2,'estorno_credito',$3,$4,$5,$6,'Estorno de cashback') ON CONFLICT DO NOTHING`,
        [companyId, earned.customer_id, -amount, sourceType, sourceId, userId ?? null])
      if (ins.rowCount) {
        // retira do restante do próprio crédito; se já foi usado, consome de outros créditos (pode ficar sem saldo)
        const fromSelf = Math.min(amount, Number(earned.remaining))
        if (fromSelf > 0) await c.query(`UPDATE loyalty_ledger SET remaining = remaining - $2 WHERE id = $1`, [earned.id, fromSelf])
        const rest = r2(amount - fromSelf)
        if (rest > 0) { try { await consume(c, companyId, earned.customer_id, rest) } catch { /* saldo já utilizado: registra apenas o estorno */ } }
      }
    }
  }
  if (sourceType === 'cancelamento') {
    const red = await c.one(`SELECT * FROM loyalty_ledger WHERE company_id = $1 AND source_type = 'venda' AND source_id = $2 AND kind = 'resgate'`, [companyId, saleId])
    if (red) {
      const s = (await getSettings(c, companyId)).fidelidade
      await c.query(
        `INSERT INTO loyalty_ledger(company_id, customer_id, kind, amount, remaining, expires_at, source_type, source_id, user_id, notes)
         VALUES ($1,$2,'estorno_resgate',$3,$3,$4,$5,$6,$7,'Devolução de saldo resgatado (venda cancelada)') ON CONFLICT DO NOTHING`,
        [companyId, red.customer_id, -Number(red.amount), s.validadeDias > 0 ? addDays(today(), s.validadeDias) : null, sourceType, sourceId, userId ?? null])
    }
  }
}

/** Expira créditos vencidos (idempotente: créditos expirados ficam com restante 0). */
export async function expireCashback(c: Q, companyId?: string): Promise<number> {
  const rows = await c.many(
    `SELECT id, company_id, customer_id, remaining FROM loyalty_ledger
      WHERE remaining > 0 AND expires_at < current_date AND ($1::uuid IS NULL OR company_id = $1) FOR UPDATE SKIP LOCKED`, [companyId ?? null])
  for (const r of rows) {
    await c.query(`UPDATE loyalty_ledger SET remaining = 0 WHERE id = $1`, [r.id])
    await c.query(
      `INSERT INTO loyalty_ledger(company_id, customer_id, kind, amount, source_type, notes) VALUES ($1,$2,'expiracao',$3,'expiracao',$4)`,
      [r.company_id, r.customer_id, -Number(r.remaining), `Expiração do crédito #${r.id}`])
  }
  return rows.length
}

export async function adjustCashback(c: Q, companyId: string, customerId: string, amount: number, notes: string, userId: string) {
  const s = (await getSettings(c, companyId)).fidelidade
  if (amount > 0) {
    await c.query(
      `INSERT INTO loyalty_ledger(company_id, customer_id, kind, amount, remaining, expires_at, source_type, notes, user_id)
       VALUES ($1,$2,'ajuste',$3,$3,$4,'ajuste',$5,$6)`, [companyId, customerId, r2(amount), s.validadeDias > 0 ? addDays(today(), s.validadeDias) : null, notes, userId])
  } else {
    await consume(c, companyId, customerId, -amount)
    await c.query(`INSERT INTO loyalty_ledger(company_id, customer_id, kind, amount, source_type, notes, user_id) VALUES ($1,$2,'ajuste',$3,'ajuste',$4,$5)`,
      [companyId, customerId, r2(amount), notes, userId])
  }
}
