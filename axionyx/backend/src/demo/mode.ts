import crypto from 'node:crypto'

/**
 * Ambiente de DEMONSTRAÇÃO (serviço e banco separados da produção). Ligado com DEMO_MODE=true.
 * - Nenhuma comunicação externa: fetch só para o próprio servidor (loopback); e-mail, WhatsApp, Mercado Pago, NF-e e
 *   integrações ficam desligados mesmo que alguém configure as variáveis.
 * - Conta de demonstração (DEMO_LOGIN_EMAIL / DEMO_LOGIN_PASSWORD) acessa todas as empresas de demonstração, sem poder
 *   trocar a própria senha, ativar MFA, cadastrar usuários ou mexer em integrações.
 * - Restaurado todo dia de madrugada (DEMO_RESET_HOUR, padrão 3h) e pelo botão "Restaurar demonstração".
 * - Só funciona num banco que contenha EXCLUSIVAMENTE empresas de demonstração (proteção contra ligar por engano na produção).
 */
export const demo = {
  get enabled() { return (process.env.DEMO_MODE || '').toLowerCase() === 'true' },
  get email() { return (process.env.DEMO_LOGIN_EMAIL || '').trim().toLowerCase() },
  get password() { return process.env.DEMO_LOGIN_PASSWORD || '' },
  /** mostra o e-mail e a senha na tela de login (para apresentações abertas). Padrão: não mostra. */
  get publicLogin() { return (process.env.DEMO_PUBLIC_LOGIN || '').toLowerCase() === 'true' },
  get resetHour() { const h = Number(process.env.DEMO_RESET_HOUR ?? 3); return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 3 },
  resetting: false,
  /** token interno (por processo) que permite ao próprio servidor montar os dados durante a restauração */
  internalToken: crypto.randomBytes(24).toString('hex'),
  lastResetAt: null as Date | null,
}

/**
 * Endereço do serviço de demonstração, configurado na PRODUÇÃO (DEMO_URL), para o link discreto da página de
 * apresentação e o atalho /demo. Aceita só https (ou http em localhost) e devolve apenas a origem (sem caminho).
 */
export function demoLinkUrl(): string | null {
  if (demo.enabled) return null
  const raw = (process.env.DEMO_URL || '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    const local = ['localhost', '127.0.0.1'].includes(u.hostname)
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null
    if (u.username || u.password) return null
    return u.origin
  } catch { return null }
}

/** Variáveis de integrações externas: ignoradas no ambiente de demonstração. */
const EXTERNAL_KEYS = /^(MP_|WHATSAPP_|RESEND_|BREVO_|SMTP_|EMAIL_|FISCAL_|ECOMMERCE_|LOGISTICS_|CNPJ_LOOKUP)/
export function demoBlocksSecret(name: string): boolean { return demo.enabled && EXTERNAL_KEYS.test(name) }

let guarded = false
/** Bloqueia qualquer requisição HTTP para fora do próprio servidor. */
export function installDemoNetworkGuard() {
  if (!demo.enabled || guarded) return
  guarded = true
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return original(input, init)
    throw new Error('Comunicação externa desativada no ambiente de demonstração.')
  }) as typeof fetch
}

/** Usuário é a conta pública de demonstração? */
export function isDemoAccount(email?: string | null) { return demo.enabled && !!demo.email && (email || '').toLowerCase() === demo.email }

/** Ações que a conta de demonstração não pode fazer (protegem a própria conta e evitam uso indevido do ambiente). */
const BLOCKED = [/^\/api\/auth\/password/, /^\/api\/auth\/mfa\//, /^\/api\/admin\/users/, /^\/api\/admin\/roles/, /^\/api\/admin\/companies/, /^\/api\/admin\/branches/,
  /^\/api\/integrations/, /^\/api\/whatsapp/, /^\/api\/platform/, /^\/api\/saas/, /^\/api\/settings/, /^\/api\/admin\/export/, /^\/api\/fiscal\/documents\/[^/]+\/(transmit|cancel)/]
export function demoBlocks(method: string, path: string): boolean {
  if (method === 'GET' && !/^\/api\/admin\/export/.test(path)) return false
  return BLOCKED.some((r) => r.test(path))
}

