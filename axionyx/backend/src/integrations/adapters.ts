import { secret } from '../config'

/**
 * Adaptadores de integrações externas. Cada um declara se está configurado (credenciais presentes no ambiente).
 * Sem credenciais, NADA é enviado e o sistema registra o status "pendente de configuração".
 */
export class NotConfiguredError extends Error { constructor(what: string) { super(`${what} não configurado(a): defina as variáveis de ambiente indicadas em docs/INTEGRACOES.md.`) } }

async function httpJson(url: string, init: RequestInit & { timeoutMs?: number }) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 500) } }
  if (!res.ok) { const e: any = new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`); e.status = res.status; e.retryable = res.status >= 500 || res.status === 429; throw e }
  return data
}

// ---------------- WhatsApp Business Platform (Cloud API oficial da Meta) ----------------
/** Credenciais de um número: por empresa (cadastradas na tela de Integrações, token cifrado no banco) ou globais (variáveis de ambiente). */
export interface WaCreds { phoneNumberId: string; token: string; version?: string }
export const whatsapp = {
  /** Credenciais globais do servidor (compatibilidade com a configuração por variáveis de ambiente). */
  envCreds: (): WaCreds | null => {
    const token = secret('WHATSAPP_TOKEN'), id = secret('WHATSAPP_PHONE_NUMBER_ID')
    return token && id ? { token, phoneNumberId: id, version: secret('WHATSAPP_API_VERSION') } : null
  },
  configured: () => !!whatsapp.envCreds(),
  async graph(creds: WaCreds, method: string, path: string, body?: unknown) {
    const version = creds.version || secret('WHATSAPP_API_VERSION') || 'v21.0'
    return httpJson(`${(secret('WHATSAPP_GRAPH_URL') || 'https://graph.facebook.com').replace(/\/$/, '')}/${version}/${path.replace(/^\//, '')}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.token}` }, body: body ? JSON.stringify(body) : undefined })
  },
  /** Envia mensagem de texto (janela de atendimento de 24 h) ou modelo aprovado (mensagens iniciadas pela empresa). */
  async send(creds: WaCreds | null, to: string, msg: { text?: string; template?: { name: string; language?: string; params?: string[] } }) {
    if (!creds) throw new NotConfiguredError('WhatsApp')
    const digits = to.replace(/\D/g, '')
    const body: any = { messaging_product: 'whatsapp', to: digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits}` }
    if (msg.template) {
      body.type = 'template'
      body.template = { name: msg.template.name, language: { code: msg.template.language || 'pt_BR' },
        components: msg.template.params?.length ? [{ type: 'body', parameters: msg.template.params.map((t) => ({ type: 'text', text: t || '-' })) }] : undefined }
    } else { body.type = 'text'; body.text = { body: msg.text || '' } }
    const data = await whatsapp.graph(creds, 'POST', `${creds.phoneNumberId}/messages`, body)
    return { id: data?.messages?.[0]?.id as string | undefined, raw: data }
  },
}

// ---------------- E-commerce (adaptador REST genérico) ----------------
export const ecommerce = {
  configured: () => !!(secret('ECOMMERCE_API_URL') && secret('ECOMMERCE_API_TOKEN')),
  async call(method: string, path: string, body?: unknown) {
    if (!ecommerce.configured()) throw new NotConfiguredError('E-commerce')
    return httpJson(secret('ECOMMERCE_API_URL')!.replace(/\/$/, '') + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${secret('ECOMMERCE_API_TOKEN')}` }, body: body ? JSON.stringify(body) : undefined })
  },
  upsertProduct: (p: unknown, externalId?: string | null) => (externalId ? ecommerce.call('PUT', `/products/${encodeURIComponent(externalId)}`, p) : ecommerce.call('POST', '/products', p)),
  updateStock: (sku: string, qty: number) => ecommerce.call('PUT', `/inventory/${encodeURIComponent(sku)}`, { sku, quantity: qty }),
}

// ---------------- Logística (adaptador REST genérico de cotação e etiquetas) ----------------
export const logistics = {
  configured: () => !!(secret('LOGISTICS_API_URL') && secret('LOGISTICS_API_TOKEN')),
  async call(path: string, body: unknown) {
    if (!logistics.configured()) throw new NotConfiguredError('Serviço de logística')
    return httpJson(secret('LOGISTICS_API_URL')!.replace(/\/$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret('LOGISTICS_API_TOKEN')}` }, body: JSON.stringify(body) })
  },
  quote: (payload: unknown) => logistics.call('/quotes', payload),
  label: (payload: unknown) => logistics.call('/labels', payload),
}

export function adapterStatus() {
  return {
    whatsapp: whatsapp.configured(), ecommerce: ecommerce.configured(), logistica: logistics.configured(),
    fiscal: !!(secret('FISCAL_PROVIDER') && secret('FISCAL_PROVIDER_URL') && secret('FISCAL_PROVIDER_TOKEN')), assistente_ia: false, banco: false,
  } as Record<string, boolean>
}
