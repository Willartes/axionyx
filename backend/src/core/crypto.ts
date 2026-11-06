import crypto from 'node:crypto'

// ---------- Senhas (scrypt) ----------
// N = 2^16 (64 MiB por cálculo). Hashes antigos (N menor) continuam válidos e são refeitos no próximo login.
const SCRYPT = { N: 65536, r: 8, p: 1, keylen: 64 }
const maxmem = (N: number, r: number) => 128 * N * r * 2 + 1024 * 1024
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: maxmem(SCRYPT.N, SCRYPT.r) })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}
function parseHash(stored: string) {
  const [alg, N, r, p, saltB64, hashB64] = String(stored || '').split('$')
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return null
  const n = +N, rr = +r, pp = +p
  if (!(n >= 1024 && n <= 1 << 20 && rr >= 1 && rr <= 32 && pp >= 1 && pp <= 4)) return null
  return { N: n, r: rr, p: pp, salt: Buffer.from(saltB64, 'base64'), expected: Buffer.from(hashB64, 'base64') }
}
export function verifyPassword(password: string, stored: string): boolean {
  const h = parseHash(stored); if (!h) return false
  const got = crypto.scryptSync(password, h.salt, h.expected.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmem(h.N, h.r) })
  return got.length === h.expected.length && crypto.timingSafeEqual(got, h.expected)
}
/** Versão assíncrona (não trava o servidor enquanto calcula) — usada no login. */
export function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored)
  // sem hash válido: calcula mesmo assim (tempo constante, não revela se o e-mail existe)
  const p = h ?? { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: DUMMY_SALT, expected: Buffer.alloc(SCRYPT.keylen) }
  return new Promise((resolve) => crypto.scrypt(password, p.salt, p.expected.length, { N: p.N, r: p.r, p: p.p, maxmem: maxmem(p.N, p.r) }, (err, got) => {
    resolve(!err && !!h && got.length === p.expected.length && crypto.timingSafeEqual(got, p.expected))
  }))
}
const DUMMY_SALT = crypto.randomBytes(16)
/** O hash usa parâmetros mais fracos que os atuais? (refazer após login bem-sucedido) */
export function needsRehash(stored: string): boolean { const h = parseHash(stored); return !h || h.N < SCRYPT.N || h.r !== SCRYPT.r }
export function passwordPolicy(pw: string): string | null {
  if (pw.length < 10) return 'A senha deve ter pelo menos 10 caracteres.'
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'A senha deve conter letras e números.'
  return null
}

// ---------- JWT HS256 ----------
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')
export function signJwt(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }))
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}
export function verifyJwt<T = any>(token: string, secret: string): T | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, b, s] = parts
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest()
  const got = Buffer.from(s, 'base64url')
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    if (header.alg !== 'HS256') return null
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString())
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload as T
  } catch { return null }
}

// ---------- TOTP (RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '')
  let bits = 0, value = 0; const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch); if (idx < 0) continue
    value = (value << 5) | idx; bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}
export function generateTotpSecret(): string { return base32Encode(crypto.randomBytes(20)) }
export function totp(secret: string, time = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(time / 1000 / step)
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const off = h[h.length - 1] & 15
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits).toString()
  return code.padStart(digits, '0')
}
export function verifyTotp(secret: string, code: string, window = 1): boolean { return totpStep(secret, code, window) !== null }
/** Intervalo (passo de 30 s) do código aceito, ou null. Guardar o passo usado impede reutilizar o mesmo código. */
export function totpStep(secret: string, code: string, window = 1, after: number | null = null): number | null {
  const c = (code || '').replace(/\D/g, '')
  if (c.length !== 6) return null
  const now = Math.floor(Date.now() / 1000 / 30)
  for (let w = -window; w <= window; w++) {
    const step = now + w
    if (after !== null && step <= after) continue
    const exp = totp(secret, step * 30_000)
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return step
  }
  return null
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
export const randomCode = (len = 8) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(len)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

// ---------- Cifragem de segredos guardados no banco (tokens de integrações) ----------
/**
 * AES-256-GCM. Chave: SECRETS_KEY (recomendado, qualquer texto longo) ou, na falta dela, derivada do JWT_SECRET (HKDF).
 * Se a chave mudar, os segredos gravados deixam de abrir e precisam ser informados de novo na tela de integrações.
 */
function secretsKey(): Buffer {
  const base = process.env.SECRETS_KEY?.trim() || process.env.JWT_SECRET?.trim()
  if (!base || base.length < 32) throw new Error('Defina SECRETS_KEY (ou JWT_SECRET) com pelo menos 32 caracteres para cifrar credenciais.')
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(base), Buffer.from('axionyx'), Buffer.from('integration-secrets-v1'), 32))
}
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', secretsKey(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`
}
export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null
  const [ver, iv, tag, data] = blob.split('.')
  if (ver !== 'v1' || !iv || !tag || !data) return null
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', secretsKey(), Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8')
  } catch { return null }
}
