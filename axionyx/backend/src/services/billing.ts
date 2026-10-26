import { db, tx, Q } from '../core/db'
import { audit, today, addDays, addMonths, r2 } from '../core/http'
import { secret } from '../config'
import { onlyDigits } from '../core/validate'
import { mercadopago, MpPayment } from '../integrations/mercadopago'

/**
 * Assinaturas do AXIONYX
 * - Primeiro contrato: auditoria ANTES do pagamento (proposta "em_analise" → aprovação cria a empresa → cobrança → pagamento libera).
 * - Renovações: cobrança automática (assinatura no cartão ou link mensal Pix/cartão); a fila de auditoria recebe só exceções
 *   (inadimplência, suspensão, chargeback, estorno, troca de titular, pagamento divergente, assinatura cancelada no cartão).
 * - Nada é apagado: inadimplência mantém o acesso no período de tolerância; depois fica somente consulta.
 */
export type ContractStatus = 'em_analise' | 'recusado' | 'aguardando_pagamento' | 'ativo' | 'inadimplente' | 'suspenso' | 'cancelado'
export const ACTIVE_STATUSES: ContractStatus[] = ['ativo', 'inadimplente']
export const BLOCKED_STATUSES = ['em_analise', 'recusado', 'aguardando_pagamento']
export const READ_ONLY_STATUSES = ['suspenso', 'cancelado']

export const publicUrl = () => (secret('APP_PUBLIC_URL') || '').replace(/\/$/, '')
export const webhookUrl = () => (publicUrl() ? `${publicUrl()}/api/public/billing/mercadopago` : '')
export const clientBackUrl = () => (publicUrl() ? `${publicUrl()}/minha-assinatura` : '')
const SYSTEM = { userName: 'Sistema de cobrança' }

// ---------------------------------------------------------------- risco (auditoria semiautomática)
export interface RiskFlag { code: string; label: string; weight: number }
const DISPOSABLE = ['mailinator.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com', 'guerrillamail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'emailondeck.com', 'mohmal.com']
const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(ltda|me|epp|eireli|s\/?a|sa|limitada|comercio|servicos|de|da|do|e)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

/** Consulta pública do CNPJ (BrasilAPI). Opcional: CNPJ_LOOKUP=off desliga. Falha não bloqueia, só sinaliza. */
async function lookupCnpj(cnpj: string): Promise<{ ok: boolean; situacao?: string; razao?: string; error?: string }> {
  const mode = (process.env.CNPJ_LOOKUP || (process.env.NODE_ENV === 'test' ? 'off' : 'brasilapi')).toLowerCase()
  if (mode === 'off') return { ok: false, error: 'consulta desativada' }
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` }
    const d: any = await r.json()
    return { ok: true, situacao: String(d.descricao_situacao_cadastral || '').toUpperCase(), razao: d.razao_social }
  } catch (e: any) { return { ok: false, error: e.message } }
}

export async function assessRisk(c: Q, input: { contractId?: string; cnpj?: string | null; companyName: string; contactEmail: string; contactDoc?: string | null }) {
  const flags: RiskFlag[] = []
  const cnpj = onlyDigits(input.cnpj)
  const self = input.contractId ?? '00000000-0000-0000-0000-000000000000'
  if (!cnpj) flags.push({ code: 'sem_cnpj', label: 'Sem CNPJ informado (pessoa física ou MEI sem CNPJ?)', weight: 1 })
  else {
    if (await c.one(`SELECT 1 FROM companies WHERE cnpj = $1`, [cnpj])) flags.push({ code: 'cnpj_duplicado', label: 'Já existe uma empresa com este CNPJ no sistema', weight: 3 })
    else if (await c.one(`SELECT 1 FROM saas_contracts WHERE cnpj = $1 AND id <> $2 AND status NOT IN ('recusado','cancelado')`, [cnpj, self])) flags.push({ code: 'cnpj_em_outro_contrato', label: 'CNPJ já está em outro contrato em andamento', weight: 3 })
    if (await c.one(`SELECT 1 FROM saas_contracts WHERE cnpj = $1 AND id <> $2 AND status = 'recusado'`, [cnpj, self])) flags.push({ code: 'recusado_antes', label: 'Este CNPJ já teve uma proposta recusada', weight: 3 })
    const rf = await lookupCnpj(cnpj)
    if (!rf.ok) flags.push({ code: 'cnpj_nao_verificado', label: `Situação do CNPJ não verificada (${rf.error})`, weight: 0 })
    else {
      if (rf.situacao !== 'ATIVA') flags.push({ code: 'cnpj_inativo', label: `CNPJ com situação "${rf.situacao || 'desconhecida'}" na Receita Federal`, weight: 3 })
      else flags.push({ code: 'cnpj_ativo', label: `CNPJ ativo na Receita Federal${rf.razao ? ` — ${rf.razao}` : ''}`, weight: 0 })
      if (rf.razao && input.companyName) {
        const a = new Set(norm(rf.razao).split(' ').filter((w) => w.length > 2)), b = norm(input.companyName).split(' ').filter((w) => w.length > 2)
        if (a.size && b.length && !b.some((w) => a.has(w))) flags.push({ code: 'razao_diferente', label: `Razão social informada difere da Receita (${rf.razao})`, weight: 1 })
      }
    }
  }
  const domain = (input.contactEmail.split('@')[1] || '').toLowerCase()
  if (DISPOSABLE.includes(domain)) flags.push({ code: 'email_descartavel', label: `E-mail de domínio descartável (${domain})`, weight: 2 })
  if (await c.one(`SELECT 1 FROM saas_contracts WHERE lower(contact_email) = lower($1) AND id <> $2 AND status IN ('recusado','cancelado')`, [input.contactEmail, self]))
    flags.push({ code: 'email_historico', label: 'E-mail do responsável ligado a contrato recusado ou cancelado', weight: 2 })
  const score = flags.reduce((s, f) => s + f.weight, 0)
  return { flags, level: (score >= 3 ? 'alto' : score >= 1 ? 'medio' : 'baixo') as 'baixo' | 'medio' | 'alto', score }
}

// ---------------------------------------------------------------- status, eventos e fila
export async function setStatus(c: Q, contract: any, to: ContractStatus, reason: string, userId?: string | null, userName?: string) {
  if (contract.status === to) return contract
  const k = await c.one(`UPDATE saas_contracts SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`, [contract.id, to])
  await c.query(`INSERT INTO saas_contract_events(contract_id, from_status, to_status, price, reason, user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [contract.id, contract.status, to, k.price, reason, userId ?? null])
  await audit(c, null, 'assinatura.status', 'saas_contract', contract.id, { de: contract.status, para: to, motivo: reason }, ['suspenso', 'cancelado', 'recusado'].includes(to) ? 'warning' : 'info',
    { companyId: k.company_id ?? undefined, userId: userId ?? undefined, userName: userName ?? SYSTEM.userName })
  return k
}

export async function openReview(c: Q, contractId: string, kind: string, title: string, severity: 'baixa' | 'media' | 'alta', details: Record<string, any> = {}, chargeId?: string | null) {
  await c.query(`INSERT INTO saas_reviews(contract_id, charge_id, kind, severity, title, details) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [contractId, chargeId ?? null, kind, severity, title, JSON.stringify(details)])
}
export async function autoResolve(c: Q, contractId: string, kinds: string[], resolution: string) {
  await c.query(`UPDATE saas_reviews SET status = 'resolvida', resolution = $3, resolved_at = now() WHERE contract_id = $1 AND kind = ANY($2::text[]) AND status = 'aberta'`, [contractId, kinds, resolution])
}

// ---------------------------------------------------------------- cobranças
const monthLabel = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export async function createCharge(c: Q, contract: any, o: { kind: 'primeira' | 'mensalidade' | 'avulsa'; periodStart: string; amount?: number; dueDate?: string; userId?: string | null; checkoutUrl?: string | null }) {
  const amount = r2(o.amount ?? Number(contract.price))
  return c.one(`INSERT INTO saas_charges(contract_id, kind, period_start, period_end, amount, due_date, created_by, checkout_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [contract.id, o.kind, o.periodStart, addMonths(o.periodStart, 1), amount, o.dueDate ?? o.periodStart, o.userId ?? null, o.checkoutUrl ?? null])
}

/** Gera (ou reaproveita) o link do Checkout Pro para uma cobrança pendente. Sem credenciais, não faz nada. */
export async function ensureCheckout(chargeId: string, force = false): Promise<string | null> {
  const ch = await db.one(`SELECT ch.*, k.billing_mode, k.contact_email, k.company_name, k.trade_name, k.mp_checkout_url, p.name AS plan_name
                             FROM saas_charges ch JOIN saas_contracts k ON k.id = ch.contract_id LEFT JOIN saas_plans p ON p.id = k.plan_id WHERE ch.id = $1`, [chargeId])
  if (!ch || ch.status !== 'pendente') return null
  if (ch.checkout_url && !force) return ch.checkout_url
  if (ch.billing_mode === 'manual' || !mercadopago().configured()) return null
  if (ch.billing_mode === 'assinatura_cartao') return ch.mp_checkout_url ?? null
  const title = `AXIONYX ${ch.plan_name ? '— ' + ch.plan_name + ' ' : ''}— ${ch.kind === 'avulsa' ? 'cobrança avulsa' : 'mensalidade ' + monthLabel(ch.period_start)}`
  const pref = await mercadopago().createPreference({ title: title.slice(0, 250), amount: Number(ch.amount), externalRef: `AXC:${ch.id}`, payerEmail: ch.contact_email,
    notificationUrl: webhookUrl() || undefined, backUrl: clientBackUrl() || undefined })
  await db.query(`UPDATE saas_charges SET mp_preference_id = $2, checkout_url = $3, updated_at = now() WHERE id = $1`, [ch.id, pref.id, pref.url])
  return pref.url
}

// ---------------------------------------------------------------- aplicação de pagamentos
const methodOf = (p: MpPayment) => (p.payment_method_id === 'pix' ? 'pix' : ['credit_card', 'debit_card', 'prepaid_card'].includes(p.payment_type_id || '') ? 'cartao' : p.payment_type_id || 'outro')
const payerDoc = (p: MpPayment) => onlyDigits(p.payer?.identification?.number) || null

/** Localiza contrato e cobrança de um pagamento do Mercado Pago. */
async function resolveTarget(c: Q, p: MpPayment, contractHint?: any) {
  let charge = await c.one(`SELECT * FROM saas_charges WHERE mp_payment_id = $1 FOR UPDATE`, [p.id])
  const ref = String(p.external_reference || '')
  if (!charge && ref.startsWith('AXC:')) charge = await c.one(`SELECT * FROM saas_charges WHERE id::text = $1 FOR UPDATE`, [ref.slice(4)])
  let contract = charge ? await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [charge.contract_id]) : null
  if (!contract && contractHint) contract = await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [contractHint.id])
  if (!contract && ref.startsWith('AXK:')) contract = await c.one(`SELECT * FROM saas_contracts WHERE id::text = $1 FOR UPDATE`, [ref.slice(4)])
  const preId = p.metadata?.preapproval_id
  if (!contract && preId) contract = await c.one(`SELECT * FROM saas_contracts WHERE mp_preapproval_id = $1 FOR UPDATE`, [String(preId)])
  return { charge, contract }
}

/** Aprovação: marca a cobrança como paga, estende a vigência e libera o acesso (idempotente). */
export async function applyApproved(c: Q, contract: any, charge: any | null, pay: { paymentId?: string | null; authorizedId?: string | null; amount: number; method: string; paidAt?: string | null; payerEmail?: string | null; payerDoc?: string | null; payerName?: string | null; fee?: number | null; note?: string | null; userId?: string | null; userName?: string }) {
  if (!charge) {
    charge = await c.one(`SELECT * FROM saas_charges WHERE contract_id = $1 AND status = 'pendente' ORDER BY period_start LIMIT 1 FOR UPDATE`, [contract.id])
    if (!charge) charge = await createCharge(c, contract, { kind: contract.paid_until ? 'mensalidade' : 'primeira', periodStart: contract.paid_until && contract.paid_until > today() ? contract.paid_until : today() })
  }
  if (charge.status === 'paga') {
    if (pay.paymentId && charge.mp_payment_id === pay.paymentId) return { charge, contract, duplicate: true }
    await openReview(c, contract.id, 'pagamento_divergente', 'Pagamento em duplicidade para uma cobrança já paga', 'alta', { paymentId: pay.paymentId, amount: pay.amount }, charge.id)
    return { charge, contract, duplicate: true }
  }
  if (['cancelada', 'estornada'].includes(charge.status) || contract.status === 'cancelado' || contract.status === 'recusado') {
    await openReview(c, contract.id, 'pagamento_divergente', `Pagamento recebido para ${contract.status === 'cancelado' ? 'contrato cancelado' : contract.status === 'recusado' ? 'proposta recusada' : 'cobrança ' + charge.status} — avalie o estorno`, 'alta', { paymentId: pay.paymentId, amount: pay.amount }, charge.id)
    return { charge, contract, duplicate: false }
  }
  if (pay.amount + 0.009 < Number(charge.amount)) {
    await c.query(`UPDATE saas_charges SET last_status_detail = $2, updated_at = now() WHERE id = $1`, [charge.id, `pago a menor: ${pay.amount}`])
    await openReview(c, contract.id, 'pagamento_divergente', `Pagamento a menor: recebido ${pay.amount.toFixed(2)} de ${Number(charge.amount).toFixed(2)}`, 'alta', { paymentId: pay.paymentId, amount: pay.amount }, charge.id)
    return { charge, contract, duplicate: false }
  }
  charge = await c.one(`UPDATE saas_charges SET status = 'paga', mp_payment_id = COALESCE($2, mp_payment_id), mp_authorized_payment_id = COALESCE($3, mp_authorized_payment_id), paid_amount = $4, method = $5,
                          paid_at = COALESCE($6::timestamptz, now()), payer_email = $7, payer_doc = $8, payer_name = $9, fee_amount = $10, manual_note = $11, last_status_detail = 'aprovado', updated_at = now()
                         WHERE id = $1 RETURNING *`,
    [charge.id, pay.paymentId ?? null, pay.authorizedId ?? null, r2(pay.amount), pay.method, pay.paidAt ?? null, pay.payerEmail ?? null, pay.payerDoc ?? null, pay.payerName ?? null, pay.fee ?? null, pay.note ?? null])
  // troca de titular: documento do pagador diferente do último pagador aprovado
  const doc = pay.payerDoc ? onlyDigits(pay.payerDoc) : ''
  if (doc && contract.payer_doc && contract.payer_doc !== doc)
    await openReview(c, contract.id, 'troca_titular', 'Pagamento feito por outro titular (documento diferente do último pagamento)', 'media', { anterior: contract.payer_doc, atual: doc }, charge.id)
  else if (doc && !contract.payer_doc && doc !== onlyDigits(contract.cnpj) && doc !== onlyDigits(contract.contact_doc))
    await openReview(c, contract.id, 'troca_titular', 'Primeiro pagamento feito por documento diferente do CNPJ/CPF cadastrado', 'baixa', { cadastro: contract.cnpj || contract.contact_doc, pagador: doc }, charge.id)
  const paidUntil = !contract.paid_until || charge.period_end > contract.paid_until ? charge.period_end : contract.paid_until
  contract = await c.one(`UPDATE saas_contracts SET paid_until = $2, started_at = COALESCE(started_at, current_date), payer_doc = COALESCE($3, payer_doc), updated_at = now() WHERE id = $1 RETURNING *`, [contract.id, paidUntil, doc || null])
  await audit(c, null, 'assinatura.pagamento', 'saas_charge', charge.id, { valor: pay.amount, metodo: pay.method, ate: paidUntil, manual: !!pay.note }, 'info',
    { companyId: contract.company_id ?? undefined, userId: pay.userId ?? undefined, userName: pay.userName ?? SYSTEM.userName })
  if (['aguardando_pagamento', 'inadimplente', 'suspenso'].includes(contract.status) && paidUntil >= today()) {
    const first = contract.status === 'aguardando_pagamento'
    contract = await setStatus(c, contract, 'ativo', first ? 'Primeiro pagamento confirmado — acesso liberado' : 'Pagamento regularizado', pay.userId, pay.userName)
    await autoResolve(c, contract.id, ['inadimplencia', 'suspensao', 'pagamento_recusado'], `Regularizado pelo pagamento de ${pay.amount.toFixed(2)} em ${today()}`)
  }
  return { charge, contract, duplicate: false }
}

/** Trata o estado atual de um pagamento consultado no Mercado Pago. */
export async function handleMpPayment(p: MpPayment, contractHint?: any, authorizedId?: string) {
  return tx(async (c) => {
    const { charge, contract } = await resolveTarget(c, p, contractHint)
    if (!contract) return { ignored: 'pagamento não pertence a uma assinatura do AXIONYX' }
    const st = p.status
    if (st === 'approved') {
      const fee = (p.fee_details || []).reduce((s, f) => s + Number(f.amount || 0), 0)
      const name = [p.payer?.first_name, p.payer?.last_name].filter(Boolean).join(' ') || null
      const r = await applyApproved(c, contract, charge, { paymentId: p.id, authorizedId: authorizedId ?? null, amount: Number(p.transaction_amount), method: methodOf(p), paidAt: p.date_approved ?? null,
        payerEmail: p.payer?.email ?? null, payerDoc: payerDoc(p), payerName: name, fee: fee || null })
      return { applied: true, duplicate: r.duplicate, chargeId: r.charge.id, status: r.contract.status }
    }
    if (st === 'refunded' || st === 'charged_back') {
      const ch = charge ?? (await c.one(`SELECT * FROM saas_charges WHERE mp_payment_id = $1 FOR UPDATE`, [p.id]))
      if (!ch) return { ignored: 'estorno/contestação sem cobrança vinculada' }
      const to = st === 'refunded' ? 'estornada' : 'contestada'
      if (ch.status !== to) {
        await c.query(`UPDATE saas_charges SET status = $2, last_status_detail = $3, updated_at = now() WHERE id = $1`, [ch.id, to, p.status_detail ?? st])
        if (st === 'charged_back') await openReview(c, contract.id, 'chargeback', 'Contestação (chargeback) do pagamento no cartão', 'alta', { paymentId: p.id, amount: p.transaction_amount }, ch.id)
        else if (!(await c.one(`SELECT 1 FROM audit_log WHERE action = 'assinatura.estorno_solicitado' AND entity_id = $1`, [ch.id])))
          await openReview(c, contract.id, 'estorno', 'Pagamento estornado fora do AXIONYX (painel do Mercado Pago)', 'media', { paymentId: p.id }, ch.id)
        await audit(c, null, 'assinatura.' + to, 'saas_charge', ch.id, { paymentId: p.id }, 'warning', { companyId: contract.company_id ?? undefined, userName: SYSTEM.userName })
      }
      return { applied: true, status: to }
    }
    if (['rejected', 'cancelled'].includes(st) && charge && charge.status === 'pendente') {
      await c.query(`UPDATE saas_charges SET attempts = attempts + 1, last_status_detail = $2, updated_at = now() WHERE id = $1`, [charge.id, `${st}: ${p.status_detail ?? ''}`.slice(0, 200)])
      if (contract.billing_mode === 'assinatura_cartao' && ACTIVE_STATUSES.includes(contract.status))
        await openReview(c, contract.id, 'pagamento_recusado', 'Cobrança recorrente recusada no cartão (o Mercado Pago tenta novamente)', 'baixa', { paymentId: p.id, detail: p.status_detail }, charge.id)
      return { applied: true, status: 'recusado' }
    }
    if (charge && charge.status === 'pendente') await c.query(`UPDATE saas_charges SET last_status_detail = $2, updated_at = now() WHERE id = $1`, [charge.id, `${st}${p.status_detail ? ': ' + p.status_detail : ''}`.slice(0, 200)])
    return { applied: false, status: st }
  })
}

/** Processa uma notificação gravada em saas_gateway_events (consulta o recurso na API — nunca confia só no corpo). */
export async function processGatewayEvent(ev: { id: number; topic: string | null; resource_id: string | null }) {
  const mp = mercadopago()
  const id = ev.resource_id || ''
  let result: any = { ignored: 'tópico não tratado' }
  try {
    switch (ev.topic) {
      case 'payment': result = await handleMpPayment(await mp.getPayment(id)); break
      case 'subscription_authorized_payment': {
        const ap = await mp.getAuthorizedPayment(id)
        const contract = await db.one(`SELECT * FROM saas_contracts WHERE mp_preapproval_id = $1`, [String(ap.preapproval_id)])
        if (!contract) { result = { ignored: 'assinatura desconhecida' }; break }
        if (!ap.payment?.id) { result = { ignored: `cobrança recorrente sem pagamento (${ap.status})` }; break }
        result = await handleMpPayment(await mp.getPayment(String(ap.payment.id)), contract, String(ap.id))
        break
      }
      case 'subscription_preapproval': {
        const pre = await mp.getPreapproval(id)
        result = await tx(async (c) => {
          const k = await c.one(`SELECT * FROM saas_contracts WHERE mp_preapproval_id = $1 FOR UPDATE`, [String(pre.id)])
          if (!k) return { ignored: 'assinatura desconhecida' }
          await c.query(`UPDATE saas_contracts SET mp_preapproval_status = $2, updated_at = now() WHERE id = $1`, [k.id, pre.status])
          if (['cancelled', 'paused'].includes(pre.status) && !['cancelado', 'recusado'].includes(k.status))
            await openReview(c, k.id, 'assinatura_cartao', pre.status === 'cancelled' ? 'Assinatura no cartão cancelada no Mercado Pago' : 'Assinatura no cartão pausada no Mercado Pago', 'media', { preapproval: pre.id, status: pre.status })
          if (pre.status === 'authorized') await autoResolve(c, k.id, ['assinatura_cartao'], 'Assinatura no cartão reativada')
          return { status: pre.status }
        })
        break
      }
      case 'topic_chargebacks_wh':
      case 'chargebacks': {
        const cb = await mp.getChargeback(id)
        const out = []
        for (const pid of cb.payments || []) out.push(await handleMpPayment(await mp.getPayment(String(pid))))
        result = { payments: out.length }
        break
      }
    }
    await db.query(`UPDATE saas_gateway_events SET status = $2, error = NULL, processed_at = now(), payload = payload || jsonb_build_object('result', $3::jsonb) WHERE id = $1`,
      [ev.id, result?.ignored ? 'ignorado' : 'processado', JSON.stringify(result ?? {})])
    return result
  } catch (e: any) {
    await db.query(`UPDATE saas_gateway_events SET status = 'erro', error = $2 WHERE id = $1`, [ev.id, String(e.message).slice(0, 500)])
    throw e
  }
}

// ---------------------------------------------------------------- régua de cobrança (rodada pelo worker a cada hora)
export async function runBilling() {
  const out = { charges: 0, links: 0, overdue: 0, suspended: 0, reconciled: 0, reprocessed: 0, errors: [] as string[] }
  const t = today()
  // 1) mensalidade do próximo período, 7 dias antes do vencimento
  const due = await db.many(`SELECT k.* FROM saas_contracts k WHERE k.status IN ('ativo','inadimplente','suspenso') AND k.paid_until IS NOT NULL AND k.paid_until - 7 <= current_date
                               AND NOT EXISTS (SELECT 1 FROM saas_charges ch WHERE ch.contract_id = k.id AND ch.status IN ('pendente','paga') AND ch.period_start >= k.paid_until)`)
  for (const k of due) {
    try {
      const ch = await tx((c) => createCharge(c, k, { kind: 'mensalidade', periodStart: k.paid_until, dueDate: k.paid_until }))
      out.charges++
      if (k.billing_mode === 'link_mensal' && (await ensureCheckout(ch.id))) out.links++
    } catch (e: any) { out.errors.push(`contrato ${k.number}: ${e.message}`) }
  }
  // 1b) links que falharam antes (ex.: gateway configurado depois)
  if (mercadopago().configured()) {
    for (const ch of await db.many(`SELECT ch.id FROM saas_charges ch JOIN saas_contracts k ON k.id = ch.contract_id WHERE ch.status = 'pendente' AND ch.checkout_url IS NULL AND k.billing_mode = 'link_mensal' LIMIT 30`)) {
      try { if (await ensureCheckout(ch.id)) out.links++ } catch (e: any) { out.errors.push(`link ${ch.id}: ${e.message}`) }
    }
  }
  // 2) vencido → inadimplente (acesso mantido na tolerância) ; 3) tolerância esgotada → suspenso (somente consulta)
  for (const k of await db.many(`SELECT * FROM saas_contracts WHERE status = 'ativo' AND paid_until < current_date`)) {
    await tx(async (c) => {
      const kk = await setStatus(c, k, 'inadimplente', `Mensalidade vencida em ${k.paid_until}`)
      await openReview(c, kk.id, 'inadimplencia', `Mensalidade vencida em ${k.paid_until} (tolerância de ${k.grace_days} dia(s))`, 'media', { paidUntil: k.paid_until })
    })
    out.overdue++
  }
  for (const k of await db.many(`SELECT * FROM saas_contracts WHERE status = 'inadimplente' AND paid_until + grace_days < current_date`)) {
    await tx(async (c) => {
      const kk = await setStatus(c, k, 'suspenso', `Tolerância de ${k.grace_days} dia(s) esgotada — acesso somente para consulta`)
      await openReview(c, kk.id, 'suspensao', 'Acesso suspenso (somente consulta) por falta de pagamento', 'alta', { paidUntil: k.paid_until })
    })
    out.suspended++
  }
  // 4) conciliação: busca no gateway pagamentos de links pendentes (cobre notificações perdidas)
  if (mercadopago().configured()) {
    for (const ch of await db.many(`SELECT id FROM saas_charges WHERE status = 'pendente' AND mp_preference_id IS NOT NULL AND updated_at < now() - interval '15 minutes' AND created_at > now() - interval '60 days' ORDER BY updated_at LIMIT 40`)) {
      try {
        for (const p of await mercadopago().searchPayments(`AXC:${ch.id}`)) { const r: any = await handleMpPayment(p); if (r.applied) out.reconciled++ }
        await db.query(`UPDATE saas_charges SET updated_at = now() WHERE id = $1`, [ch.id])
      } catch (e: any) { out.errors.push(`conciliação ${ch.id}: ${e.message}`); break }
    }
    // 5) reprocessa notificações que falharam
    for (const ev of await db.many(`SELECT id, topic, resource_id FROM saas_gateway_events WHERE status = 'erro' AND signature_ok AND created_at > now() - interval '3 days' ORDER BY id LIMIT 20`)) {
      try { await processGatewayEvent(ev); out.reprocessed++ } catch { /* registrado no evento */ }
    }
  }
  void t
  return out
}

// ---------------------------------------------------------------- resumo para o cliente
export async function billingSummary(companyId: string) {
  const k = await db.one(`SELECT k.id, k.status, k.price, k.billing_mode, k.paid_until, k.grace_days, k.mp_checkout_url, k.mp_preapproval_status, p.name AS plan_name
                            FROM saas_contracts k LEFT JOIN saas_plans p ON p.id = k.plan_id WHERE k.company_id = $1`, [companyId])
  if (!k) return null
  const pending = await db.one(`SELECT id, amount, due_date, period_start, period_end, checkout_url, kind FROM saas_charges WHERE contract_id = $1 AND status = 'pendente' ORDER BY period_start LIMIT 1`, [k.id])
  return {
    status: k.status, plan: k.plan_name, price: Number(k.price), billingMode: k.billing_mode, paidUntil: k.paid_until, graceDays: k.grace_days,
    suspendOn: k.paid_until ? addDays(k.paid_until, k.grace_days + 1) : null,
    blocked: BLOCKED_STATUSES.includes(k.status), readOnly: READ_ONLY_STATUSES.includes(k.status),
    pending: pending ? { ...pending, checkout_url: pending.checkout_url || (k.billing_mode === 'assinatura_cartao' ? k.mp_checkout_url : null) } : null,
  }
}
