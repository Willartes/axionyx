import { secret } from '../config'

/**
 * Camada desacoplada para provedores de NF-e/NFC-e.
 * O AXIONYX NÃO assina XML nem se comunica diretamente com a SEFAZ: isso exige certificado digital A1/A3,
 * CSC (NFC-e) e credenciamento, normalmente delegados a um provedor homologado. Enquanto não houver provedor
 * configurado, os documentos ficam em "pendente_configuracao" — nenhuma autorização é simulada.
 */
export interface FiscalResult {
  status: 'autorizado' | 'rejeitado' | 'denegado' | 'processando' | 'contingencia' | 'erro' | 'pendente_configuracao' | 'cancelado'
  accessKey?: string
  protocol?: string
  xml?: string
  danfeUrl?: string
  providerRef?: string
  messages: { code?: string; text: string }[]
}
export interface FiscalDocInput {
  id: string; model: '55' | '65'; environment: 'homologacao' | 'producao'; series: number; number: number; payload: any
  accessKey?: string | null; protocol?: string | null; providerRef?: string | null
}
export interface FiscalAdapter {
  readonly name: string
  configured(): boolean
  emit(doc: FiscalDocInput): Promise<FiscalResult>
  cancel(doc: FiscalDocInput, reason: string): Promise<FiscalResult>
  query(doc: FiscalDocInput): Promise<FiscalResult>
}

class NotConfiguredAdapter implements FiscalAdapter {
  readonly name = 'nao_configurado'
  configured() { return false }
  private pending(): FiscalResult {
    return { status: 'pendente_configuracao', messages: [{ code: 'CFG', text: 'Provedor fiscal não configurado. Defina FISCAL_PROVIDER, FISCAL_PROVIDER_URL e FISCAL_PROVIDER_TOKEN (veja docs/INTEGRACOES.md). Nenhum documento foi enviado à SEFAZ.' }] }
  }
  async emit() { return this.pending() }
  async cancel() { return this.pending() }
  async query() { return this.pending() }
}

/**
 * Adaptador REST genérico. Contrato documentado em docs/INTEGRACOES.md — para um provedor específico,
 * implemente o mapeamento aqui (ou exponha um proxy que siga este contrato).
 */
class GenericHttpAdapter implements FiscalAdapter {
  readonly name = 'http'
  constructor(private url: string, private token: string) {}
  configured() { return true }
  private async call(method: string, path: string, body?: unknown): Promise<FiscalResult> {
    try {
      const res = await fetch(this.url.replace(/\/$/, '') + path, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
      })
      const data: any = await res.json().catch(() => ({}))
      if (!res.ok && !data?.status) return { status: 'erro', messages: [{ code: String(res.status), text: data?.mensagem || `Provedor respondeu HTTP ${res.status}` }] }
      return {
        status: data.status, accessKey: data.chave, protocol: data.protocolo, xml: data.xml, danfeUrl: data.danfe_url, providerRef: data.id,
        messages: Array.isArray(data.mensagens) ? data.mensagens.map((m: any) => ({ code: m.codigo, text: m.texto })) : [],
      }
    } catch (e: any) {
      return { status: 'erro', messages: [{ code: 'REDE', text: `Falha de comunicação com o provedor fiscal: ${e?.message || e}` }] }
    }
  }
  emit(doc: FiscalDocInput) { return this.call('POST', '/documentos', { modelo: doc.model, ambiente: doc.environment, serie: doc.series, numero: doc.number, referencia: doc.id, dados: doc.payload }) }
  cancel(doc: FiscalDocInput, reason: string) { return this.call('POST', `/documentos/${encodeURIComponent(doc.providerRef || doc.id)}/cancelamento`, { justificativa: reason, chave: doc.accessKey }) }
  query(doc: FiscalDocInput) { return this.call('GET', `/documentos/${encodeURIComponent(doc.providerRef || doc.id)}`) }
}

export function getFiscalAdapter(): FiscalAdapter {
  const provider = secret('FISCAL_PROVIDER')
  if (provider === 'http') {
    const url = secret('FISCAL_PROVIDER_URL'), token = secret('FISCAL_PROVIDER_TOKEN')
    if (url && token) return new GenericHttpAdapter(url, token)
  }
  return new NotConfiguredAdapter()
}
