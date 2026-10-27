import { Q } from '../core/db'
import { audit, today, addDays, r2 } from '../core/http'
import { unprocessable } from '../core/errors'

/**
 * Oficina: ordem de serviço (OS) do orçamento à entrega.
 * orcamento → aguardando_aprovacao → aprovada → em_execucao ⇄ aguardando_peca → pronta → entregue  (cancelada a qualquer momento antes da entrega)
 * Itens: serviço (preço fechado), mão de obra (horas × valor-hora), peça e produto (do estoque, baixados na cobrança).
 * O cliente aprova item a item; itens incluídos depois da aprovação ficam pendentes até nova aprovação.
 */
export type WoStatus = 'orcamento' | 'aguardando_aprovacao' | 'aprovada' | 'em_execucao' | 'aguardando_peca' | 'pronta' | 'entregue' | 'cancelada'
export const WO_LABEL: Record<WoStatus, string> = {
  orcamento: 'Orçamento', aguardando_aprovacao: 'Aguardando aprovação', aprovada: 'Aprovada', em_execucao: 'Em execução',
  aguardando_peca: 'Aguardando peça', pronta: 'Pronta para entrega', entregue: 'Entregue', cancelada: 'Cancelada',
}
const NEXT: Record<WoStatus, WoStatus[]> = {
  orcamento: ['aguardando_aprovacao', 'aprovada', 'cancelada'],
  aguardando_aprovacao: ['orcamento', 'aprovada', 'cancelada'],
  aprovada: ['em_execucao', 'aguardando_peca', 'pronta', 'cancelada'],
  em_execucao: ['aguardando_peca', 'pronta', 'cancelada'],
  aguardando_peca: ['em_execucao', 'pronta', 'cancelada'],
  pronta: ['em_execucao', 'entregue'],
  entregue: [],
  cancelada: [],
}
export const canMove = (from: WoStatus, to: WoStatus) => NEXT[from]?.includes(to)
export const EDITABLE: WoStatus[] = ['orcamento', 'aguardando_aprovacao', 'aprovada', 'em_execucao', 'aguardando_peca', 'pronta']

export async function woEvent(c: Q, woId: string, from: string | null, to: string | null, note: string | null, userId?: string | null) {
  await c.query(`INSERT INTO work_order_events(work_order_id, from_status, to_status, note, user_id) VALUES ($1,$2,$3,$4,$5)`, [woId, from, to, note, userId ?? null])
}

export async function woTotals(c: Q, woId: string) {
  return c.one(`SELECT
      COALESCE(sum(total) FILTER (WHERE status <> 'recusado'),0)::float8 AS quoted,
      COALESCE(sum(total) FILTER (WHERE status = 'aprovado'),0)::float8 AS approved,
      COALESCE(sum(total) FILTER (WHERE status = 'aprovado' AND kind IN ('servico','mao_de_obra')),0)::float8 AS labor,
      COALESCE(sum(total) FILTER (WHERE status = 'aprovado' AND kind IN ('peca','produto')),0)::float8 AS parts,
      COALESCE(sum(qty) FILTER (WHERE status = 'aprovado' AND kind = 'mao_de_obra'),0)::float8 AS hours,
      COALESCE(sum(total) FILTER (WHERE status = 'aprovado' AND sale_item_id IS NOT NULL),0)::float8 AS billed,
      COALESCE(sum(total) FILTER (WHERE status = 'aprovado' AND sale_item_id IS NULL),0)::float8 AS to_bill,
      count(*) FILTER (WHERE status = 'pendente')::int AS pending,
      count(*) FILTER (WHERE status = 'aprovado' AND sale_item_id IS NULL)::int AS unbilled,
      count(*) FILTER (WHERE status <> 'recusado')::int AS items
    FROM work_order_items WHERE work_order_id = $1`, [woId])
}

/** Entrega: garantia, quilometragem do veículo e lembretes de revisão (óleo, filtros, correia...). */
export async function deliverWorkOrder(c: Q, wo: any, userId: string | null, note?: string | null) {
  const t = await woTotals(c, wo.id)
  if (t.pending) throw unprocessable('Há itens aguardando aprovação do cliente: aprove ou recuse antes de entregar.')
  if (t.unbilled) throw unprocessable(`Há ${t.unbilled} item(ns) aprovado(s) ainda não cobrado(s): cobre a OS no PDV antes de entregar.`)
  const warrantyUntil = wo.warranty_days > 0 ? addDays(today(), wo.warranty_days) : null
  await c.query(`UPDATE work_orders SET status = 'entregue', delivered_at = now(), finished_at = COALESCE(finished_at, now()), warranty_until = $2, updated_at = now() WHERE id = $1`, [wo.id, warrantyUntil])
  await woEvent(c, wo.id, wo.status, 'entregue', note ?? (warrantyUntil ? `Garantia dos serviços até ${warrantyUntil.split('-').reverse().join('/')}` : null), userId)
  if (wo.km_in) await c.query(`UPDATE vehicles SET km_current = GREATEST(COALESCE(km_current, 0), $2), updated_at = now() WHERE id = $1`, [wo.vehicle_id, wo.km_in])
  const items = await c.many(`SELECT DISTINCT ON (i.product_id) i.product_id, i.description, p.return_km, p.return_days FROM work_order_items i JOIN products p ON p.id = i.product_id
                               WHERE i.work_order_id = $1 AND i.status = 'aprovado' AND (p.return_km IS NOT NULL OR p.return_days IS NOT NULL)`, [wo.id])
  for (const it of items) {
    await c.query(`UPDATE vehicle_reminders SET status = 'feito' WHERE vehicle_id = $1 AND product_id = $2 AND status = 'aberto'`, [wo.vehicle_id, it.product_id])
    await c.query(`INSERT INTO vehicle_reminders(company_id, vehicle_id, product_id, work_order_id, description, due_km, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [wo.company_id, wo.vehicle_id, it.product_id, wo.id, it.description, it.return_km && wo.km_in ? wo.km_in + it.return_km : null, it.return_days ? addDays(today(), it.return_days) : null])
  }
  return { warrantyUntil, reminders: items.length }
}

/** Chamado pela venda quando itens da OS são cobrados no PDV. OS pronta e totalmente cobrada é entregue automaticamente. */
export async function workOrderBilled(c: Q, actor: { companyId: string; userId: string }, woId: string, saleId: string) {
  const wo = await c.one(`SELECT * FROM work_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`, [woId, actor.companyId])
  if (!wo) return
  await c.query(`UPDATE work_orders SET sale_id = $2, updated_at = now() WHERE id = $1`, [woId, saleId])
  const t = await woTotals(c, woId)
  await woEvent(c, woId, null, null, `Cobrada no PDV (${r2(t.billed).toFixed(2)})`, actor.userId)
  if (wo.status === 'pronta' && !t.pending && !t.unbilled) await deliverWorkOrder(c, { ...wo, sale_id: saleId }, actor.userId, 'Entregue na cobrança')
  await audit(c, null, 'oficina.os_cobrada', 'work_order', woId, { number: wo.number, saleId }, 'info', { companyId: actor.companyId, userId: actor.userId })
}
