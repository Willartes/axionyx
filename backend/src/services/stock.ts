import { Q } from '../core/db'
import { conflict, notFound } from '../core/errors'
import { isFractional, r3 } from './retail'

export type MovementType =
  | 'entrada' | 'saida' | 'ajuste' | 'transferencia_saida' | 'transferencia_entrada' | 'venda' | 'cancelamento_venda'
  | 'devolucao' | 'condicional_saida' | 'condicional_retorno' | 'consignacao_saida' | 'consignacao_retorno' | 'inventario'
  | 'compra' | 'estorno_compra' | 'perda'

export interface MoveInput {
  companyId: string
  branchId: string
  variantId: string
  qty: number // com sinal: + entra, - sai
  type: MovementType
  refType?: string
  refId?: string
  unitCost?: number | null
  notes?: string
  userId?: string
  allowNegative?: boolean
}

/**
 * Movimenta o saldo de forma atômica (UPSERT com incremento) e registra o histórico.
 * Deve ser chamado dentro de uma transação; um saldo negativo não permitido aborta a transação inteira.
 */
export async function moveStock(c: Q, m: MoveInput): Promise<number> {
  const v = await c.one<{ sku: string; track_stock: boolean; unit: string; sale_by_weight: boolean }>(
    `SELECT v.sku, p.track_stock, p.unit, p.sale_by_weight FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = $1 AND v.company_id = $2`, [m.variantId, m.companyId])
  if (!v) throw notFound('Variação de produto')
  if (!Number.isFinite(m.qty) || m.qty === 0) throw conflict('Quantidade de movimentação inválida.')
  if (isFractional(v)) m = { ...m, qty: r3(m.qty) }
  else if (!Number.isInteger(m.qty)) throw conflict(`${v.sku} é controlado por unidade: a quantidade deve ser inteira.`)
  const r = await c.one<{ qty: number }>(
    `INSERT INTO stock_balances(company_id, branch_id, variant_id, qty) VALUES ($1,$2,$3,$4)
     ON CONFLICT (branch_id, variant_id) DO UPDATE SET qty = stock_balances.qty + EXCLUDED.qty, updated_at = now()
     RETURNING qty`, [m.companyId, m.branchId, m.variantId, m.qty])
  const balance = r!.qty
  if (balance < 0 && !m.allowNegative && v.track_stock) {
    throw conflict(`Estoque insuficiente para o SKU ${v.sku} (faltam ${r3(-balance)} ${isFractional(v) ? (v.unit || 'kg').toLowerCase() : 'un.'}).`, { variantId: m.variantId, sku: v.sku, missing: r3(-balance) })
  }
  await c.query(
    `INSERT INTO stock_movements(company_id, branch_id, variant_id, type, qty, balance_after, unit_cost, ref_type, ref_id, notes, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [m.companyId, m.branchId, m.variantId, m.type, m.qty, balance, m.unitCost ?? null, m.refType ?? null, m.refId ?? null, m.notes ?? null, m.userId ?? null])
  // sincronização com e-commerce (se houver integração ativa, o worker envia; caso contrário fica aguardando configuração)
  await c.query(
    `INSERT INTO outbox(company_id, integration_id, topic, payload, dedupe_key)
     SELECT $1, i.id, 'ecommerce.estoque', jsonb_build_object('variantId', $2::text), 'estoque:' || $2 || ':' || to_char(now(), 'YYYYMMDDHH24MISSMS')
       FROM integrations i WHERE i.company_id = $1 AND i.kind = 'ecommerce' AND i.status = 'ativo'
     ON CONFLICT (company_id, dedupe_key) DO NOTHING`, [m.companyId, m.variantId])
  return balance
}

export async function balanceOf(c: Q, branchId: string, variantId: string): Promise<number> {
  const r = await c.one<{ qty: number }>('SELECT qty FROM stock_balances WHERE branch_id = $1 AND variant_id = $2', [branchId, variantId])
  return r?.qty ?? 0
}
