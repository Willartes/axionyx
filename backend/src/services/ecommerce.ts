import type { Q } from '../core/db'
import { decryptSecret } from '../core/crypto'
import type { EcomCreds } from '../integrations/adapters'

/**
 * Loja virtual por empresa: cada empresa cadastra o endereço da API da própria loja e o token (cifrado em AES-256-GCM
 * em integrations.secret_enc). Não existe credencial global: um evento só é entregue com as credenciais da empresa dona dele.
 */
export interface CompanyStore { integration: any; creds: EcomCreds | null }

export function storeSecrets(i: any): { token?: string } {
  if (!i?.secret_enc) return {}
  try { return JSON.parse(decryptSecret(i.secret_enc) || '{}') || {} } catch { return {} }
}

/** Integração de e-commerce da empresa (cria a linha se não existir). */
export async function storeIntegration(c: Q, companyId: string, lock = false) {
  let i = await c.one(`SELECT * FROM integrations WHERE company_id = $1 AND kind = 'ecommerce' ORDER BY created_at LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`, [companyId])
  if (!i) i = await c.one(`INSERT INTO integrations(company_id, kind, provider, name) VALUES ($1,'ecommerce','generico','Loja virtual (adaptador REST)') RETURNING *`, [companyId])
  return i
}

/** Credenciais de uma integração, conferindo que ela pertence à empresa do evento. */
export async function storeCreds(c: Q, integrationId: string | null, companyId: string): Promise<CompanyStore | null> {
  if (!integrationId) return null
  const i = await c.one(`SELECT * FROM integrations WHERE id = $1 AND company_id = $2 AND kind = 'ecommerce'`, [integrationId, companyId])
  if (!i) return null
  const s = storeSecrets(i)
  return { integration: i, creds: i.config?.url && s.token ? { url: i.config.url, token: s.token } : null }
}

export const hasStoreCreds = (i: any) => !!(i?.config?.url && i?.secret_enc && storeSecrets(i).token)
