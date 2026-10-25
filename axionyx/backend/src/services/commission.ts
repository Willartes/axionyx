import { Q } from '../core/db'
import { r2 } from '../core/http'
import { getSettings } from './settings'

interface ItemInfo { net: number; category_id: string | null; brand_id: string | null; collection_id: string | null; sku: string }

/** Resolve o percentual por item: vendedor > coleção > marca > categoria > percentual do vendedor > padrão. */
export async function computeCommission(c: Q, companyId: string, sellerId: string, items: ItemInfo[]) {
  const rules = await c.many(`SELECT * FROM commission_rules WHERE company_id = $1 AND active ORDER BY priority DESC, created_at`, [companyId])
  const seller = await c.one<{ commission_pct: number | null }>(`SELECT commission_pct FROM user_companies WHERE user_id = $1 AND company_id = $2`, [sellerId, companyId])
  const settings = await getSettings(c, companyId)
  const fallback = seller?.commission_pct ?? rules.find((r) => r.scope === 'padrao')?.pct ?? settings.comissoes.percentualPadrao
  const sellerRule = rules.find((r) => r.scope === 'vendedor' && r.ref_id === sellerId)
  let total = 0, base = 0
  const details = items.map((it) => {
    const rule = sellerRule
      || rules.find((r) => r.scope === 'colecao' && r.ref_id && r.ref_id === it.collection_id)
      || rules.find((r) => r.scope === 'marca' && r.ref_id && r.ref_id === it.brand_id)
      || rules.find((r) => r.scope === 'categoria' && r.ref_id && r.ref_id === it.category_id)
    const pct = Number(rule?.pct ?? fallback)
    const amount = r2(it.net * pct / 100)
    total += amount; base += it.net
    return { sku: it.sku, base: r2(it.net), pct, amount, rule: rule?.name ?? 'padrão' }
  })
  return { base: r2(base), amount: r2(total), details }
}

export async function recordCommission(c: Q, p: { companyId: string; branchId: string; sellerId: string; saleId: string; refType: 'venda' | 'cancelamento' | 'devolucao'; refId: string; base: number; amount: number; details: unknown }) {
  if (p.amount === 0 && p.base === 0) return
  await c.query(
    `INSERT INTO commissions(company_id, branch_id, seller_id, sale_id, ref_type, ref_id, base_amount, amount, competence, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,date_trunc('month', now())::date,$9) ON CONFLICT (ref_type, ref_id, seller_id) DO NOTHING`,
    [p.companyId, p.branchId, p.sellerId, p.saleId, p.refType, p.refId, p.base, p.amount, JSON.stringify(p.details)])
}
