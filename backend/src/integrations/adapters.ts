import dns from 'node:dns/promises'
import net from 'node:net'
import { secret } from '../config'

/**
 * Adaptadores de integrações externas. Cada um declara se está configurado. WhatsApp e loja virtual usam credenciais por empresa (cifradas no banco).
 * Sem credenciais, NADA é enviado e o sistema registra o status "pendente de configuração".
 */
export class NotConfiguredError extends Error { constructor(what: string) { super(`${what} não configurado(a): defina as variáveis de ambiente indicadas em docs/INTEGRACOES.md.`) } }

async function httpJson(url: string, init: RequestInit & { timeoutMs?: number }) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 500) } }
  if (res.status >= 300 && res.status < 400) { const e: any = new Error(`HTTP ${res.status}: redirecionamento não é seguido (use o endereço final da API)`); e.status = res.status; e.retryable = false; throw e }
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
/** Credenciais da loja virtual de UMA empresa (cadastradas na tela Integrações; token cifrado no banco). */
export interface EcomCreds { url: string; token: string }

const v4Private = (ip: string) => {
  const p = ip.split('.').map(Number)
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 192 && p[1] === 0 && p[2] === 0) || (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || p[0] >= 224
}
/** Endereço de rede interno (localhost, rede privada, link-local, metadados da nuvem): o servidor não pode ser usado para sondar a própria rede. */
export function isPrivateIp(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (net.isIPv4(a)) return v4Private(a)
  if (!net.isIPv6(a)) return true
  if (a === '::' || a === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (mapped) return v4Private(mapped[1])
  return /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || /^64:ff9b:/.test(a) || /^2001:db8:/.test(a)
}
/** Só desenvolvimento/testes: ECOMMERCE_ALLOW_PRIVATE=true libera http e rede local (ignorado em produção). */
const allowPrivate = () => (process.env.ECOMMERCE_ALLOW_PRIVATE || '').toLowerCase() === 'true' && process.env.NODE_ENV !== 'production'

/** Valida o endereço da loja informado pelo cliente: https, sem usuário/senha embutidos e resolvendo só para IPs públicos. */
export async function assertStoreUrl(raw: string): Promise<string> {
  let u: URL
  try { u = new URL(String(raw || '').trim()) } catch { throw new StoreUrlError('Endereço inválido. Use o formato https://api.sualoja.com.br') }
  if (u.username || u.password) throw new StoreUrlError('Não inclua usuário ou senha no endereço: use o campo Token.')
  if (u.search || u.hash) throw new StoreUrlError('Informe só o endereço base da API, sem parâmetros (?…) nem âncora (#…).')
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) throw new StoreUrlError('O endereço precisa começar com https:// (conexão segura).')
  if (u.port && !['443', ''].includes(u.port) && !allowPrivate()) throw new StoreUrlError('Use a porta padrão do https (443).')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!allowPrivate()) {
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.railway\.internal)$/i.test(host)) throw new StoreUrlError('Endereço interno não é permitido: informe o endereço público da loja.')
    let addrs: string[]
    try { addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true, verbatim: true })).map((x) => x.address) } catch { throw new StoreUrlError(`O domínio ${host} não foi encontrado. Confira o endereço.`) }
    if (!addrs.length || addrs.some(isPrivateIp)) throw new StoreUrlError('Endereço interno ou privado não é permitido: informe o endereço público da loja.')
  }
  return u.toString().replace(/\/+$/, '')
}
export class StoreUrlError extends Error { retryable = false }

export const ecommerce = {
  async call(creds: EcomCreds | null, method: string, path: string, body?: unknown) {
    if (!creds?.url || !creds?.token) throw new NotConfiguredError('Loja virtual da empresa')
    const base = await assertStoreUrl(creds.url)
    return httpJson(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.token}` }, body: body ? JSON.stringify(body) : undefined })
  },
  upsertProduct: (creds: EcomCreds | null, p: unknown, externalId?: string | null) => (externalId ? ecommerce.call(creds, 'PUT', `/products/${encodeURIComponent(externalId)}`, p) : ecommerce.call(creds, 'POST', '/products', p)),
  updateStock: (creds: EcomCreds | null, sku: string, qty: number) => ecommerce.call(creds, 'PUT', `/inventory/${encodeURIComponent(sku)}`, { sku, quantity: qty }),
  /** Teste de conexão (GET /health, opcional no contrato). */
  health: (creds: EcomCreds) => ecommerce.call(creds, 'GET', '/health'),
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
    whatsapp: whatsapp.configured(), ecommerce: false, logistica: logistics.configured(),
    fiscal: !!(secret('FISCAL_PROVIDER') && secret('FISCAL_PROVIDER_URL') && secret('FISCAL_PROVIDER_TOKEN')), assistente_ia: false, banco: false,
  } as Record<string, boolean>
}
