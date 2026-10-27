import { Q } from '../core/db'
import { unprocessable } from '../core/errors'
import { r2 } from '../core/http'
import { gtinCheckDigit, isValidGTIN } from '../core/validate'
import { Settings } from './settings'

/**
 * Recursos de varejo por segmento: quantidades fracionadas (kg), etiqueta de balança,
 * lotes/validade com consumo FEFO, embalagens (unidade/caixa) e combos.
 */
export const FRACTIONAL_UNITS = ['KG', 'L', 'M', 'M2', 'M3', 'H']
export const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000
export const isFractional = (p: { sale_by_weight?: boolean; unit?: string | null }) => !!p.sale_by_weight || FRACTIONAL_UNITS.includes(String(p.unit || '').toUpperCase())

/** Valida a quantidade conforme o produto: inteira, ou até 3 casas para produtos por peso/medida. */
export function checkQty(qty: number, p: { sale_by_weight?: boolean; unit?: string | null; sku?: string }, label = 'Quantidade') {
  if (!Number.isFinite(qty) || qty <= 0) throw unprocessable(`${label} inválida${p.sku ? ` para ${p.sku}` : ''}.`)
  if (isFractional(p)) { if (Math.abs(r3(qty) - qty) > 1e-9) throw unprocessable(`${label} com mais de 3 casas decimais${p.sku ? ` (${p.sku})` : ''}.`); return r3(qty) }
  if (!Number.isInteger(qty)) throw unprocessable(`${p.sku ?? 'Este produto'} é vendido por unidade: a quantidade deve ser inteira.`)
  return qty
}

// ---------------- Etiqueta de balança ----------------
export interface ScaleParse { plu: string; value: number; kind: 'peso' | 'preco' }
/**
 * Etiqueta de balança no padrão EAN-13 de circulação restrita: [prefixo][código PLU][zeros][valor][dígito].
 * Valor = peso em gramas ou preço total em centavos (configurável em Configurações › Balança).
 */
export function parseScaleBarcode(code: string, cfg: Settings['balanca']): ScaleParse | null {
  const d = String(code || '').replace(/\D/g, '')
  const prefix = String(cfg.prefixo ?? '2')
  if (d.length !== 13 || !d.startsWith(prefix) || !isValidGTIN(d)) return null
  const nCode = Number(cfg.digitosCodigo) || 5, nVal = Number(cfg.digitosValor) || 5
  if (prefix.length + nCode + nVal > 12) return null
  const plu = d.slice(prefix.length, prefix.length + nCode)
  const value = Number(d.slice(12 - nVal, 12))
  if (!Number.isFinite(value) || value <= 0) return null
  return { plu: String(Number(plu)), value: cfg.tipoValor === 'peso' ? value / 1000 : value / 100, kind: cfg.tipoValor === 'peso' ? 'peso' : 'preco' }
}

/** Gera o código EAN-13 de uma etiqueta de balança (para imprimir etiquetas de produtos pesados no estoque). */
export function buildScaleBarcode(plu: string, value: number, cfg: Settings['balanca']) {
  const prefix = String(cfg.prefixo ?? '2')
  const nCode = Number(cfg.digitosCodigo) || 5, nVal = Number(cfg.digitosValor) || 5
  const v = cfg.tipoValor === 'peso' ? Math.round(value * 1000) : Math.round(value * 100)
  if (String(v).length > nVal) throw unprocessable('Valor maior do que cabe na etiqueta de balança configurada.')
  const pluDigits = String(plu).replace(/\D/g, '')
  if (!pluDigits || pluDigits.length > nCode) throw unprocessable(`O código de balança (PLU) deve ter até ${nCode} dígitos.`)
  const body = (prefix + pluDigits.padStart(nCode, '0')).padEnd(12 - nVal, '0') + String(v).padStart(nVal, '0')
  return body + gtinCheckDigit(body)
}

/** Resolve uma etiqueta de balança para a variação do produto (pelo PLU) com quantidade (kg) e valor da etiqueta. */
export async function resolveScale(c: Q, companyId: string, code: string, cfg: Settings['balanca']) {
  const s = parseScaleBarcode(code, cfg)
  if (!s) return null
  const p = await c.one(`SELECT p.id, p.name, p.unit, p.sale_by_weight, v.id AS variant_id, v.sku, COALESCE(v.sale_price, p.sale_price) AS price
                           FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active
                          WHERE p.company_id = $1 AND p.plu_code = $2 AND p.active ORDER BY v.created_at LIMIT 1`, [companyId, s.plu])
  if (!p) return null
  const price = Number(p.price)
  if (!(price > 0)) throw unprocessable(`${p.name}: sem preço por kg cadastrado.`)
  const qty = s.kind === 'peso' ? r3(s.value) : r3(s.value / price)
  const total = s.kind === 'peso' ? r2(qty * price) : r2(s.value)
  return { ...s, variantId: p.variant_id, sku: p.sku, name: p.name, unitPrice: price, qty, total }
}

// ---------------- Lotes e validade (FEFO) ----------------
/** Baixa dos lotes mais próximos do vencimento (FEFO). Não bloqueia a venda se os lotes não cobrirem tudo. */
export async function consumeLots(c: Q, branchId: string, variantId: string, qty: number) {
  let left = r3(qty)
  if (left <= 0) return []
  const lots = await c.many(`SELECT id, qty_remaining FROM stock_lots WHERE branch_id = $1 AND variant_id = $2 AND qty_remaining > 0
                              ORDER BY expiry_date NULLS LAST, created_at FOR UPDATE`, [branchId, variantId])
  const used: { lotId: string; qty: number }[] = []
  for (const l of lots) {
    if (left <= 0) break
    const take = r3(Math.min(left, Number(l.qty_remaining)))
    await c.query(`UPDATE stock_lots SET qty_remaining = qty_remaining - $2 WHERE id = $1`, [l.id, take])
    used.push({ lotId: l.id, qty: take }); left = r3(left - take)
  }
  return used
}

// ---------------- Expansão de itens da venda (embalagens, combos, balança) ----------------
export interface RawItem { variantId?: string; qty: number; discount?: number; packagingId?: string; comboId?: string; scaleCode?: string; unitPriceOverride?: number
  professionalId?: string; appointmentServiceId?: string; planItemId?: string; workOrderItemId?: string }
export interface ExpandedItem { variantId: string; qty: number; discount?: number; unitPriceOverride?: number; grossOverride?: number; packagingId?: string; comboId?: string
  professionalId?: string | null; appointmentServiceId?: string; planItemId?: string; preApprovedDiscount?: number; expectCustomerId?: string | null; appointmentId?: string; workOrderItemId?: string; workOrderId?: string }

export async function expandItems(c: Q, companyId: string, items: RawItem[], settings: Settings): Promise<ExpandedItem[]> {
  const out: ExpandedItem[] = []
  const seen = new Set<string>()
  for (const [idx, it] of items.entries()) {
    const n = idx + 1
    if (it.appointmentServiceId) {
      // serviço do atendimento: preço e profissional vêm do agendamento (o cliente não define o valor)
      if (seen.has('as:' + it.appointmentServiceId)) throw unprocessable(`Item ${n}: serviço do atendimento repetido.`)
      seen.add('as:' + it.appointmentServiceId)
      const s = await c.one(`SELECT s.*, a.customer_id, a.status AS appt_status, p.name FROM appointment_services s JOIN appointments a ON a.id = s.appointment_id JOIN products p ON p.id = s.product_id
                              WHERE s.id = $1 AND s.company_id = $2 FOR UPDATE OF s`, [it.appointmentServiceId, companyId])
      if (!s) throw unprocessable(`Item ${n}: serviço do atendimento não encontrado.`)
      if (['cancelado', 'faltou'].includes(s.appt_status) || s.status === 'cancelado') throw unprocessable(`Item ${n}: atendimento cancelado.`)
      if (s.sale_item_id) throw unprocessable(`Item ${n}: "${s.name}" deste atendimento já foi cobrado.`)
      if (s.customer_package_id || s.plan_item_id) throw unprocessable(`Item ${n}: "${s.name}" é coberto por pacote/plano de tratamento e não é cobrado aqui.`)
      if (!(Number(s.price) > 0)) throw unprocessable(`Item ${n}: "${s.name}" está sem valor no atendimento.`)
      out.push({ variantId: s.variant_id, qty: 1, discount: it.discount, unitPriceOverride: Number(s.price), professionalId: s.professional_id,
        appointmentServiceId: s.id, appointmentId: s.appointment_id, expectCustomerId: s.customer_id })
      continue
    }
    if (it.planItemId) {
      // procedimento do plano de tratamento aprovado: preço e desconto negociados no plano
      if (seen.has('pi:' + it.planItemId)) throw unprocessable(`Item ${n}: procedimento do plano repetido.`)
      seen.add('pi:' + it.planItemId)
      const pi = await c.one(`SELECT i.*, tp.customer_id, tp.status AS plan_status, tp.professional_id AS plan_professional FROM treatment_plan_items i JOIN treatment_plans tp ON tp.id = i.plan_id
                               WHERE i.id = $1 AND i.company_id = $2 FOR UPDATE OF i`, [it.planItemId, companyId])
      if (!pi) throw unprocessable(`Item ${n}: procedimento do plano não encontrado.`)
      if (!['aprovado', 'em_andamento', 'concluido'].includes(pi.plan_status)) throw unprocessable(`Item ${n}: o plano de tratamento precisa estar aprovado para ser cobrado.`)
      if (pi.status === 'cancelado') throw unprocessable(`Item ${n}: procedimento cancelado no plano.`)
      if (pi.sale_id) throw unprocessable(`Item ${n}: procedimento do plano já cobrado.`)
      const gross = r2(Number(pi.unit_price) * pi.qty)
      out.push({ variantId: pi.variant_id, qty: pi.qty, grossOverride: gross, unitPriceOverride: Number(pi.unit_price), discount: r2(Number(pi.discount) + (it.discount ?? 0)),
        preApprovedDiscount: Number(pi.discount), professionalId: pi.professional_id ?? pi.plan_professional ?? null, planItemId: pi.id, expectCustomerId: pi.customer_id })
      continue
    }
    if (it.workOrderItemId) {
      // item aprovado da ordem de serviço: preço, desconto e mecânico vêm da OS (orçamento aprovado pelo cliente)
      if (seen.has('wo:' + it.workOrderItemId)) throw unprocessable(`Item ${n}: item da OS repetido.`)
      seen.add('wo:' + it.workOrderItemId)
      const wi = await c.one(`SELECT i.*, w.customer_id, w.status AS wo_status, w.number AS wo_number FROM work_order_items i JOIN work_orders w ON w.id = i.work_order_id
                               WHERE i.id = $1 AND i.company_id = $2 FOR UPDATE OF i`, [it.workOrderItemId, companyId])
      if (!wi) throw unprocessable(`Item ${n}: item da ordem de serviço não encontrado.`)
      if (['orcamento', 'aguardando_aprovacao', 'cancelada'].includes(wi.wo_status)) throw unprocessable(`Item ${n}: a OS nº ${wi.wo_number} precisa estar aprovada para ser cobrada.`)
      if (wi.status !== 'aprovado') throw unprocessable(`Item ${n}: "${wi.description}" não foi aprovado pelo cliente.`)
      if (wi.sale_item_id) throw unprocessable(`Item ${n}: "${wi.description}" já foi cobrado.`)
      const gross = r2(Number(wi.unit_price) * Number(wi.qty))
      out.push({ variantId: wi.variant_id, qty: Number(wi.qty), grossOverride: gross, unitPriceOverride: Number(wi.unit_price), discount: r2(Number(wi.discount) + (it.discount ?? 0)),
        preApprovedDiscount: Number(wi.discount), professionalId: wi.professional_id ?? null, workOrderItemId: wi.id, workOrderId: wi.work_order_id, expectCustomerId: wi.customer_id })
      continue
    }
    if (it.scaleCode) {
      const s = await resolveScale(c, companyId, it.scaleCode, settings.balanca)
      if (!s) throw unprocessable(`Item ${n}: etiqueta de balança não reconhecida (confira o código de balança do produto e a configuração da etiqueta).`)
      out.push({ variantId: s.variantId, qty: s.qty, discount: it.discount, unitPriceOverride: s.unitPrice, grossOverride: s.total, professionalId: it.professionalId ?? null })
    } else if (it.packagingId) {
      const pk = await c.one(`SELECT pk.*, COALESCE(v.sale_price, p.sale_price) AS unit_price FROM product_packagings pk JOIN product_variants v ON v.id = pk.variant_id JOIN products p ON p.id = pk.product_id
                               WHERE pk.id = $1 AND pk.company_id = $2 AND pk.active`, [it.packagingId, companyId])
      if (!pk) throw unprocessable(`Item ${n}: embalagem não encontrada ou inativa.`)
      if (!Number.isInteger(it.qty) || it.qty <= 0) throw unprocessable(`Item ${n}: quantidade de embalagens deve ser inteira.`)
      const units = it.qty * pk.units
      const gross = pk.sale_price ? r2(Number(pk.sale_price) * it.qty) : undefined
      out.push({ variantId: pk.variant_id, qty: units, discount: it.discount, packagingId: pk.id, grossOverride: gross, professionalId: it.professionalId ?? null,
        unitPriceOverride: pk.sale_price ? Math.round((Number(pk.sale_price) / pk.units) * 10000) / 10000 : undefined })
    } else if (it.comboId) {
      const cb = await c.one(`SELECT * FROM combos WHERE id = $1 AND company_id = $2 AND active AND (valid_until IS NULL OR valid_until >= current_date)`, [it.comboId, companyId])
      if (!cb) throw unprocessable(`Item ${n}: combo não encontrado, inativo ou vencido.`)
      if (!Number.isInteger(it.qty) || it.qty <= 0) throw unprocessable(`Item ${n}: quantidade de combos deve ser inteira.`)
      const comps = await c.many(`SELECT ci.variant_id, ci.qty, COALESCE(v.sale_price, p.sale_price) AS price FROM combo_items ci JOIN product_variants v ON v.id = ci.variant_id
                                   JOIN products p ON p.id = v.product_id WHERE ci.combo_id = $1 ORDER BY ci.variant_id`, [cb.id])
      if (!comps.length) throw unprocessable(`Item ${n}: combo sem itens.`)
      // rateia o preço do combo entre os itens, proporcional ao preço normal de cada um
      const total = r2(Number(cb.price) * it.qty)
      const base = comps.reduce((s, x) => s + Number(x.price) * Number(x.qty), 0) || comps.length
      let alloc = 0
      comps.forEach((x, i) => {
        const share = i === comps.length - 1 ? r2(total - alloc) : r2(total * ((Number(x.price) * Number(x.qty) || 1) / base))
        alloc = r2(alloc + share)
        const qty = r3(Number(x.qty) * it.qty)
        out.push({ variantId: x.variant_id, qty, comboId: cb.id, grossOverride: share, unitPriceOverride: Math.round((share / qty) * 10000) / 10000, professionalId: it.professionalId ?? null })
      })
    } else {
      if (!it.variantId) throw unprocessable(`Item ${n}: informe o produto.`)
      out.push({ variantId: it.variantId, qty: it.qty, discount: it.discount, unitPriceOverride: it.unitPriceOverride, professionalId: it.professionalId ?? null })
    }
  }
  return out
}

/** Busca rápida para o PDV: embalagem ou combo pelo código de barras/código. */
export async function findPackagingOrCombo(c: Q, companyId: string, code: string) {
  const pk = await c.one(`SELECT pk.id, pk.name, pk.units, pk.barcode, COALESCE(pk.sale_price, COALESCE(v.sale_price, p.sale_price) * pk.units) AS price, v.id AS variant_id, v.sku, p.name AS product, p.age_restricted
                            FROM product_packagings pk JOIN product_variants v ON v.id = pk.variant_id JOIN products p ON p.id = pk.product_id
                           WHERE pk.company_id = $1 AND pk.active AND pk.barcode = $2`, [companyId, code])
  if (pk) return { kind: 'embalagem' as const, ...pk }
  const cb = await c.one(`SELECT id, code, name, barcode, price, EXISTS (SELECT 1 FROM combo_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id WHERE ci.combo_id = combos.id AND p.age_restricted) AS age_restricted FROM combos WHERE company_id = $1 AND active AND (valid_until IS NULL OR valid_until >= current_date) AND (barcode = $2 OR upper(code) = upper($2))`, [companyId, code])
  if (cb) return { kind: 'combo' as const, ...cb }
  return null
}

