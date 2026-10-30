import fs from 'node:fs'
import path from 'node:path'

/** Carrega variáveis de um arquivo .env (sem sobrescrever as já definidas no ambiente). */
function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!m || line.trim().startsWith('#')) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadDotEnv()
// Fuso horário de negócio (datas de vencimento, competência, "hoje")
process.env.TZ = process.env.APP_TZ || process.env.TZ || 'America/Sao_Paulo'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name} (veja .env.example)`)
  return v
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),
  get jwtSecret(): string {
    const s = required('JWT_SECRET')
    if (s.length < 32) throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres')
    return s
  },
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  sessionHours: Number(process.env.SESSION_HOURS || 10),
  staticDir: process.env.STATIC_DIR || '',
  runWorker: (process.env.RUN_WORKER ?? 'true') !== 'false',
  env: process.env.NODE_ENV || 'development',
  timezone: process.env.TZ as string,
}

/** Lê uma variável de integração sem expô-la em logs. */
export function secret(name: string | null | undefined): string | undefined {
  if (!name) return undefined
  // ambiente de demonstração: integrações externas sempre desligadas
  if ((process.env.DEMO_MODE || '').toLowerCase() === 'true' && /^(MP_|WHATSAPP_|RESEND_|BREVO_|SMTP_|EMAIL_|FISCAL_|ECOMMERCE_|LOGISTICS_|CNPJ_LOOKUP|ANTHROPIC_|OPENAI_|GEMINI_|AI_)/.test(name)) return undefined
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}
