import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { secret, config } from '../config'

/**
 * Envio de e-mail transacional (convites e redefinição de senha), sem dependências externas.
 * Provedores (escolhidos por variável de ambiente — credenciais NUNCA no código):
 *  - smtp   : servidor SMTP do seu e-mail (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS). Porta 465 = TLS direto; 587 = STARTTLS.
 *             Atenção: o Railway só libera SMTP de saída no plano Pro (Free/Trial/Hobby bloqueiam as portas 25/465/587).
 *  - resend : serviço transacional por HTTPS (RESEND_API_KEY).
 *  - brevo  : serviço transacional por HTTPS (BREVO_API_KEY).
 * EMAIL_PROVIDER força o provedor; sem ele, usa o primeiro configurado (resend → brevo → smtp).
 * EMAIL_FROM (obrigatório) é o remetente, ex.: "nao-responda@axionyxerp.com.br"; EMAIL_FROM_NAME o nome exibido.
 */
export interface EmailMessage { to: string; toName?: string; subject: string; text: string; html: string }
export interface EmailResult { provider: string; id?: string }
type Provider = 'smtp' | 'resend' | 'brevo'

let testTransport: ((m: EmailMessage & { from: string; fromName: string }) => Promise<EmailResult>) | null = null
/** Somente para testes automatizados: captura os e-mails em vez de enviar. Bloqueado em produção. */
export function setEmailTransport(fn: typeof testTransport) {
  if (config.env === 'production' && fn) throw new Error('Transporte de teste de e-mail não pode ser usado em produção.')
  testTransport = fn
}

function provider(): Provider | null {
  const forced = (secret('EMAIL_PROVIDER') || '').toLowerCase()
  if (forced === 'smtp' || forced === 'resend' || forced === 'brevo') return forced
  if (secret('RESEND_API_KEY')) return 'resend'
  if (secret('BREVO_API_KEY')) return 'brevo'
  if (secret('SMTP_HOST')) return 'smtp'
  return null
}
function missing(p: Provider): string[] {
  const need: Record<Provider, string[]> = { smtp: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'], resend: ['RESEND_API_KEY'], brevo: ['BREVO_API_KEY'] }
  return [...need[p], 'EMAIL_FROM'].filter((k) => !secret(k))
}
const fromAddress = () => secret('EMAIL_FROM') || ''
const fromName = () => secret('EMAIL_FROM_NAME') || 'AXIONYX'

/** Situação da configuração (sem expor segredos). */
export function emailStatus() {
  if (testTransport) return { configured: true, provider: 'teste', from: 'teste@axionyx.local', missing: [] as string[] }
  const p = provider()
  if (!p) return { configured: false, provider: null, from: null, missing: ['EMAIL_FROM', 'RESEND_API_KEY ou BREVO_API_KEY ou SMTP_HOST/SMTP_USER/SMTP_PASS'] }
  const miss = missing(p)
  return { configured: miss.length === 0, provider: p, from: fromAddress() || null, missing: miss }
}
export const emailConfigured = () => emailStatus().configured

export async function sendEmail(m: EmailMessage): Promise<EmailResult> {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(m.to)) throw new Error('Destinatário inválido.')
  if (testTransport) return testTransport({ ...m, from: 'teste@axionyx.local', fromName: fromName() })
  const st = emailStatus()
  if (!st.configured || !st.provider) throw new Error(`E-mail não configurado (faltam: ${st.missing.join(', ')}).`)
  if (st.provider === 'resend') return sendResend(m)
  if (st.provider === 'brevo') return sendBrevo(m)
  return sendSmtp(m)
}

// ---------------------------------------------------------------- HTTPS
async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15_000)
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(j?.message || j?.error || j?.code || 'falha no envio').slice(0, 200)}`)
    return j
  } finally { clearTimeout(t) }
}
async function sendResend(m: EmailMessage): Promise<EmailResult> {
  const j = await postJson('https://api.resend.com/emails', { authorization: `Bearer ${secret('RESEND_API_KEY')}` },
    { from: `${fromName()} <${fromAddress()}>`, to: [m.to], subject: m.subject, html: m.html, text: m.text })
  return { provider: 'resend', id: j?.id }
}
async function sendBrevo(m: EmailMessage): Promise<EmailResult> {
  const j = await postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': secret('BREVO_API_KEY')! },
    { sender: { email: fromAddress(), name: fromName() }, to: [{ email: m.to, ...(m.toName ? { name: m.toName } : {}) }], subject: m.subject, htmlContent: m.html, textContent: m.text })
  return { provider: 'brevo', id: j?.messageId }
}

// ---------------------------------------------------------------- SMTP (RFC 5321) com STARTTLS/TLS e AUTH PLAIN/LOGIN
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd()
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`)
const addr = (email: string, name?: string) => (name ? `${encWord(name.replace(/["\r\n]/g, ''))} <${email}>` : `<${email}>`)

export function buildMime(m: EmailMessage, from: string, name: string, now = new Date()): string {
  const boundary = 'axb_' + crypto.randomBytes(12).toString('hex')
  const domain = from.split('@')[1] || 'axionyx.local'
  const headers = [
    `From: ${addr(from, name)}`, `To: ${addr(m.to, m.toName)}`, `Subject: ${encWord(m.subject.replace(/[\r\n]/g, ' '))}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`, 'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated', `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
  const part = (type: string, body: string) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap76(b64(body))].join('\r\n')
  return [...headers, '', part('text/plain', m.text), part('text/html', m.html), `--${boundary}--`, ''].join('\r\n')
}

class SmtpConn {
  private buf = ''; private waiters: ((l: string[]) => void)[] = []; private lines: string[] = []; private err: Error | null = null
  constructor(public sock: net.Socket | tls.TLSSocket) { this.attach(sock) }
  attach(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => { this.buf += d; this.flush() })
    sock.on('error', (e) => { this.err = e; this.waiters.splice(0).forEach((w) => w([])) })
  }
  private flush() {
    let i
    while ((i = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); this.lines.push(line)
      if (/^\d{3} /.test(line)) { const reply = this.lines.splice(0); const w = this.waiters.shift(); if (w) w(reply) }
    }
  }
  read(): Promise<string[]> { return new Promise((res) => this.waiters.push(res)) }
  async cmd(line: string | null, expect: number[], label: string): Promise<string[]> {
    if (line !== null) this.sock.write(line + '\r\n')
    const reply = await this.read()
    if (this.err) throw this.err
    const code = Number(reply[reply.length - 1]?.slice(0, 3))
    if (!expect.includes(code)) throw new Error(`SMTP ${label}: ${(reply[reply.length - 1] || 'sem resposta').slice(0, 200)}`)
    return reply
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let t: NodeJS.Timeout
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => { onTimeout(); rej(new Error('SMTP: tempo esgotado (o servidor não respondeu — no Railway, SMTP exige o plano Pro).')) }, ms) })]).finally(() => clearTimeout(t))
}

async function sendSmtp(m: EmailMessage): Promise<EmailResult> {
  const host = secret('SMTP_HOST')!, port = Number(secret('SMTP_PORT') || 587)
  const implicit = (secret('SMTP_SECURE') ?? String(port === 465)).toLowerCase() === 'true'
  const rejectUnauthorized = (secret('SMTP_TLS_REJECT_UNAUTHORIZED') ?? 'true') !== 'false'
  const user = secret('SMTP_USER')!, pass = secret('SMTP_PASS')!
  const from = fromAddress()
  let sock: net.Socket | tls.TLSSocket
  const connect = () => new Promise<net.Socket | tls.TLSSocket>((res, rej) => {
    const s = implicit ? tls.connect({ host, port, servername: host, rejectUnauthorized }, () => res(s)) : net.connect({ host, port }, () => res(s))
    s.once('error', rej)
  })
  const run = async () => {
    sock = await connect()
    const c = new SmtpConn(sock)
    await c.cmd(null, [220], 'saudação')
    const helo = `EHLO ${from.split('@')[1] || 'localhost'}`
    let ehlo = await c.cmd(helo, [250], 'EHLO')
    if (!implicit) {
      const insecureOk = config.env !== 'production' && secret('SMTP_ALLOW_INSECURE') === 'true' // só para servidor de testes local
      if (!ehlo.some((l) => /STARTTLS/i.test(l)) && !insecureOk) throw new Error('SMTP: o servidor não oferece STARTTLS (conexão sem criptografia não é permitida). Use a porta 465 ou 587.')
    }
    if (!implicit && ehlo.some((l) => /STARTTLS/i.test(l))) {
      await c.cmd('STARTTLS', [220], 'STARTTLS')
      sock.removeAllListeners('data')
      sock = await new Promise<tls.TLSSocket>((res, rej) => { const t = tls.connect({ socket: sock as net.Socket, servername: host, rejectUnauthorized }, () => res(t)); t.once('error', rej) })
      c.attach(sock)
      ehlo = await c.cmd(helo, [250], 'EHLO')
    }
    const auth = ehlo.find((l) => /AUTH/i.test(l)) || ''
    if (/PLAIN/i.test(auth)) await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`, [235], 'autenticação')
    else { await c.cmd('AUTH LOGIN', [334], 'autenticação'); await c.cmd(b64(user), [334], 'autenticação'); await c.cmd(b64(pass), [235], 'autenticação (usuário ou senha do SMTP)') }
    await c.cmd(`MAIL FROM:<${from}>`, [250], 'remetente')
    await c.cmd(`RCPT TO:<${m.to}>`, [250, 251], 'destinatário')
    await c.cmd('DATA', [354], 'DATA')
    const body = buildMime(m, from, fromName()).replace(/\r\n\./g, '\r\n..')
    const done = await c.cmd(body + '\r\n.', [250], 'envio')
    c.sock.write('QUIT\r\n'); c.sock.end()
    return { provider: 'smtp', id: done[done.length - 1]?.slice(4, 80) }
  }
  try { return await withTimeout(run(), 20_000, () => sock?.destroy()) }
  catch (e) { (sock! as net.Socket | undefined)?.destroy(); throw e }
}
