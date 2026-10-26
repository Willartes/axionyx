import crypto from 'node:crypto'
import { secret } from '../config'
import { NotConfiguredError } from './adapters'

/**
 * Cliente do Mercado Pago (API REST oficial) para a cobrança das assinaturas do AXIONYX.
 * - Checkout Pro (preferência): cobrança avulsa/mensal por link — Pix ou cartão, sem dados de cartão passarem pelo servidor.
 * - Assinatura (preapproval): cobrança recorrente automática no cartão.
 * - Webhook: assinatura HMAC-SHA256 do cabeçalho x-signature com a chave secreta do painel.
 * Credenciais SOMENTE por variáveis de ambiente (MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET). Sem elas nada é enviado.
 */
export interface MpPayment {
  id: string; status: string; status_detail?: string; external_reference?: string | null; transaction_amount: number
  date_approved?: string | null; date_created?: string; payment_type_id?: string; payment_method_id?: string
  payer?: { email?: string; first_name?: string; last_name?: string; identification?: { type?: string; number?: string } }
  fee_details?: { amount: number }[]; metadata?: Record<string, any>; live_mode?: boolean
  transaction_details?: { net_received_amount?: number }
}
export interface MpClient {
  configured(): boolean
  createPreference(p: { title: string; amount: number; externalRef: string; payerEmail?: string; notificationUrl?: string; backUrl?: string; expiresAt?: string }): Promise<{ id: string; url: string }>
  createPreapproval(p: { reason: string; amount: number; externalRef: string; payerEmail: string; backUrl: string }): Promise<{ id: string; url: string; status: string }>
  getPreapproval(id: string): Promise<{ id: string; status: string; external_reference?: string; payer_email?: string; auto_recurring?: any; next_payment_date?: string }>
  updatePreapproval(id: string, body: { status?: 'cancelled' | 'paused' | 'authorized'; amount?: number }): Promise<void>
  getPayment(id: string): Promise<MpPayment>
  searchPayments(externalRef: string): Promise<MpPayment[]>
  getAuthorizedPayment(id: string): Promise<{ id: string; preapproval_id: string; status: string; transaction_amount?: number; payment?: { id?: string | number; status?: string } }>
  getChargeback(id: string): Promise<{ id: string; payments: (string | number)[] }>
  refund(paymentId: string, idempotencyKey: string): Promise<void>
  account(): Promise<{ id: string; nickname?: string; site_id?: string; live: boolean }>
}

const apiBase = () => (secret('MP_API_URL') || 'https://api.mercadopago.com').replace(/\/$/, '')

async function mp(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const token = secret('MP_ACCESS_TOKEN')
  if (!token) throw new NotConfiguredError('Mercado Pago')
  const res = await fetch(apiBase() + path, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 300) } }
  if (!res.ok) {
    const e: any = new Error(`Mercado Pago HTTP ${res.status}: ${(data?.message || data?.error || JSON.stringify(data)).toString().slice(0, 300)}`)
    e.status = res.status; e.retryable = res.status >= 500 || res.status === 429
    throw e
  }
  return data
}

export const realClient: MpClient = {
  configured: () => !!secret('MP_ACCESS_TOKEN'),
  async createPreference(p) {
    const body: any = {
      items: [{ id: p.externalRef, title: p.title, quantity: 1, unit_price: p.amount, currency_id: 'BRL' }],
      external_reference: p.externalRef,
      statement_descriptor: 'AXIONYX',
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }], installments: 1 },
    }
    if (p.payerEmail) body.payer = { email: p.payerEmail }
    if (p.notificationUrl) body.notification_url = p.notificationUrl
    if (p.backUrl) { body.back_urls = { success: p.backUrl, pending: p.backUrl, failure: p.backUrl }; body.auto_return = 'approved' }
    if (p.expiresAt) { body.expires = true; body.expiration_date_to = p.expiresAt }
    const r = await mp('POST', '/checkout/preferences', body)
    return { id: String(r.id), url: String(r.init_point) }
  },
  async createPreapproval(p) {
    const r = await mp('POST', '/preapproval', {
      reason: p.reason, external_reference: p.externalRef, payer_email: p.payerEmail, back_url: p.backUrl, status: 'pending',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: p.amount, currency_id: 'BRL' },
    })
    return { id: String(r.id), url: String(r.init_point), status: String(r.status) }
  },
  getPreapproval: (id) => mp('GET', `/preapproval/${encodeURIComponent(id)}`),
  async updatePreapproval(id, b) {
    const body: any = {}
    if (b.status) body.status = b.status
    if (b.amount !== undefined) body.auto_recurring = { transaction_amount: b.amount, currency_id: 'BRL' }
    await mp('PUT', `/preapproval/${encodeURIComponent(id)}`, body)
  },
  async getPayment(id) { const r = await mp('GET', `/v1/payments/${encodeURIComponent(id)}`); return { ...r, id: String(r.id) } },
  async searchPayments(ref) {
    const r = await mp('GET', `/v1/payments/search?sort=date_created&criteria=desc&limit=20&external_reference=${encodeURIComponent(ref)}`)
    return (r?.results || []).map((x: any) => ({ ...x, id: String(x.id) }))
  },
  getAuthorizedPayment: (id) => mp('GET', `/authorized_payments/${encodeURIComponent(id)}`),
  getChargeback: (id) => mp('GET', `/v1/chargebacks/${encodeURIComponent(id)}`),
  async refund(paymentId, key) { await mp('POST', `/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {}, { 'X-Idempotency-Key': key }) },
  async account() {
    const r = await mp('GET', '/users/me')
    const token = secret('MP_ACCESS_TOKEN') || ''
    return { id: String(r.id), nickname: r.nickname, site_id: r.site_id, live: !token.startsWith('TEST-') }
  },
}

let client: MpClient = realClient
export const mercadopago = (): MpClient => client
/** Somente para testes automatizados: troca o cliente por um simulador em memória. */
export function setMercadoPagoClient(c: MpClient | null) {
  if (process.env.NODE_ENV === 'production') throw new Error('Cliente simulado do Mercado Pago não é permitido em produção.')
  client = c ?? realClient
}

/**
 * Valida a notificação: x-signature = "ts=<epoch>,v1=<hmac>" e o manifesto
 * "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" assinado com HMAC-SHA256 e a chave secreta do webhook.
 * O data.id vem da query string (em minúsculas quando alfanumérico). Partes ausentes são omitidas do manifesto.
 */
export function verifyWebhookSignature(xSignature: string | undefined, xRequestId: string | undefined, dataId: string | undefined, maxAgeSec = 0): { ok: boolean; reason?: string } {
  const key = secret('MP_WEBHOOK_SECRET')
  if (!key) return { ok: false, reason: 'MP_WEBHOOK_SECRET não configurado' }
  if (!xSignature) return { ok: false, reason: 'sem cabeçalho x-signature' }
  const parts = Object.fromEntries(xSignature.split(',').map((p) => p.trim().split('=').map((s) => s.trim())).filter((kv) => kv.length === 2)) as Record<string, string>
  const ts = parts.ts, v1 = parts.v1
  if (!ts || !v1) return { ok: false, reason: 'x-signature malformado' }
  if (maxAgeSec > 0) {
    const t = Number(ts) > 1e12 ? Number(ts) / 1000 : Number(ts)
    if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > maxAgeSec) return { ok: false, reason: 'notificação expirada' }
  }
  let manifest = ''
  if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`
  if (xRequestId) manifest += `request-id:${xRequestId};`
  manifest += `ts:${ts};`
  const expected = crypto.createHmac('sha256', key).update(manifest).digest('hex')
  const a = Buffer.from(expected), b = Buffer.from(v1)
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'assinatura não confere' }
}

/** Assina um manifesto como o Mercado Pago (usado pelos testes automatizados). */
export function signForTest(key: string, dataId: string, requestId: string, ts: string) {
  return `ts=${ts},v1=${crypto.createHmac('sha256', key).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex')}`
}
