import crypto from 'node:crypto'
import { db } from '../core/db'
import { secret } from '../config'
import { demo } from '../demo/mode'

/**
 * Provedores de IA generativa (opcional). A plataforma escolhe qual provedor oferece às empresas; cada empresa liga a IA
 * com aceite do administrador. Chaves: variável de ambiente (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) ou
 * digitadas no painel da plataforma — nesse caso ficam CIFRADAS no banco (AES-256-GCM) e nunca voltam ao navegador.
 */
export type Provider = 'anthropic' | 'openai' | 'gemini'
export const PROVIDERS: Provider[] = ['anthropic', 'openai', 'gemini']
export const PROVIDER_INFO: Record<Provider, { label: string; vendor: string; env: string; defaultModel: string; console: string }> = {
  anthropic: { label: 'Claude', vendor: 'Anthropic', env: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5-5', console: 'https://console.anthropic.com' },
  openai: { label: 'ChatGPT', vendor: 'OpenAI', env: 'OPENAI_API_KEY', defaultModel: 'gpt-5-mini', console: 'https://platform.openai.com' },
  gemini: { label: 'Gemini', vendor: 'Google', env: 'GEMINI_API_KEY', defaultModel: 'gemini-2.5-flash', console: 'https://aistudio.google.com' },
}

// ---------- cifragem das chaves ----------
/** Chave mestra: ENCRYPTION_KEY (recomendado) ou derivada do JWT_SECRET. */
function masterKey(): Buffer {
  const own = (process.env.ENCRYPTION_KEY || '').trim()
  if (own) return crypto.createHash('sha256').update(own).digest()
  const jwt = process.env.JWT_SECRET || ''
  if (!jwt) throw new Error('Defina ENCRYPTION_KEY ou JWT_SECRET para cifrar as chaves de IA.')
  return Buffer.from(crypto.hkdfSync('sha256', jwt, 'axionyx', 'axionyx-ai-keys-v1', 32))
}
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}
export function decryptSecret(enc: string): string | null {
  try {
    const [v, iv, tag, ct] = enc.split(':')
    if (v !== 'v1') return null
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
  } catch { return null } // chave mestra trocada: a chave precisa ser digitada de novo
}

// ---------- leitura da configuração ----------
export interface PlatformAI { provider: Provider | null; models: Partial<Record<Provider, string>>; availability: 'todas' | 'liberadas'; defaultMonthlyLimit: number }
export async function platformAI(): Promise<PlatformAI> {
  const r = await db.one(`SELECT provider, models, availability, default_monthly_limit FROM platform_ai_settings WHERE id = 1`)
  return { provider: r?.provider ?? null, models: r?.models ?? {}, availability: r?.availability ?? 'liberadas', defaultMonthlyLimit: r?.default_monthly_limit ?? 300 }
}
export const modelOf = (p: PlatformAI, prov: Provider) => (p.models[prov] || PROVIDER_INFO[prov].defaultModel)

/** Chave do provedor: variável de ambiente tem prioridade; depois a chave cifrada do painel. No ambiente de demonstração, nenhuma. */
export async function providerKey(prov: Provider): Promise<{ key: string; source: 'env' | 'painel' } | null> {
  if (demo.enabled) return null
  const env = secret(PROVIDER_INFO[prov].env)
  if (env) return { key: env, source: 'env' }
  const r = await db.one(`SELECT key_enc FROM platform_ai_keys WHERE provider = $1`, [prov])
  const key = r ? decryptSecret(r.key_enc) : null
  return key ? { key, source: 'painel' } : null
}
/** Situação das chaves para o painel (sem revelar nenhuma). */
export async function keysStatus() {
  const rows = await db.many(`SELECT k.provider, k.last4, k.updated_at, k.key_enc, u.name AS updated_by FROM platform_ai_keys k LEFT JOIN users u ON u.id = k.updated_by`)
  const out: Record<string, any> = {}
  for (const p of PROVIDERS) {
    const row = rows.find((r: any) => r.provider === p)
    const env = !demo.enabled && !!secret(PROVIDER_INFO[p].env)
    out[p] = { env, saved: !!row, last4: row?.last4 ?? null, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null,
      unreadable: !!row && !decryptSecret(row.key_enc), configured: env || (!!row && !!decryptSecret(row.key_enc)) }
  }
  return out
}

export async function monthUsage(companyId: string): Promise<number> {
  const r = await db.one(`SELECT count(*)::int AS n FROM ai_usage WHERE company_id = $1 AND engine = 'ia' AND status = 'ok' AND created_at >= date_trunc('month', now())`, [companyId])
  return r.n
}

export type Reason = 'demo' | 'sem_provedor' | 'sem_chave' | 'nao_liberada' | 'nao_ativada' | 'limite' | null
export const REASON_TEXT: Record<Exclude<Reason, null>, string> = {
  demo: 'A IA generativa fica desligada no ambiente de demonstração.',
  sem_provedor: 'A plataforma ainda não escolheu um provedor de IA.',
  sem_chave: 'O provedor de IA escolhido pela plataforma está sem chave configurada.',
  nao_liberada: 'A IA generativa ainda não foi liberada para esta empresa. Fale com o suporte AXIONYX.',
  nao_ativada: 'A IA generativa ainda não foi ativada pelo administrador da empresa (Administração › Inteligência Artificial).',
  limite: 'O limite mensal de perguntas à IA desta empresa foi atingido. As respostas voltam a usar o motor de regras até o próximo mês.',
}

export interface CompanyAI {
  available: boolean; reason: Reason; reasonText: string | null
  provider: Provider | null; providerLabel: string | null; model: string | null
  platformAllowed: boolean; enabled: boolean; acceptedAt: string | null; acceptedBy: string | null
  documentsEnabled: boolean; blockedFolders: string[]; used: number; limit: number
}
export async function companyAI(companyId: string): Promise<CompanyAI> {
  const p = await platformAI()
  const c = await db.one(`SELECT ca.*, u.name AS accepted_by_name FROM company_ai ca LEFT JOIN users u ON u.id = ca.accepted_by WHERE ca.company_id = $1`, [companyId])
  const used = await monthUsage(companyId)
  const limit = c?.monthly_limit ?? p.defaultMonthlyLimit
  const allowed = p.availability === 'todas' || !!c?.platform_allowed
  let reason: Reason = null
  if (demo.enabled) reason = 'demo'
  else if (!p.provider) reason = 'sem_provedor'
  else if (!(await providerKey(p.provider))) reason = 'sem_chave'
  else if (!allowed) reason = 'nao_liberada'
  else if (!c?.enabled) reason = 'nao_ativada'
  else if (used >= limit) reason = 'limite'
  return {
    available: reason === null, reason, reasonText: reason ? REASON_TEXT[reason] : null,
    provider: p.provider, providerLabel: p.provider ? `${PROVIDER_INFO[p.provider].label} (${PROVIDER_INFO[p.provider].vendor})` : null, model: p.provider ? modelOf(p, p.provider) : null,
    platformAllowed: allowed, enabled: !!c?.enabled, acceptedAt: c?.accepted_at ?? null, acceptedBy: c?.accepted_by_name ?? null,
    documentsEnabled: c ? !!c.documents_enabled : true, blockedFolders: c?.blocked_folders ?? [], used, limit,
  }
}
