import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { setup, teardown, call, login, db, PASSWORD, Env } from './helpers'
import { setEmailTransport, sendEmail, EmailMessage } from '../integrations/email'
import { hashPassword } from '../core/crypto'

/**
 * Convite por e-mail com link de ativação: o link é de uso único, expira, só o hash fica no banco, nenhuma senha trafega;
 * redefinição por link; alternativa por senha temporária quando o envio falha; cliente SMTP próprio (STARTTLS/AUTH/DATA).
 */
let E: Env
let A: { token: string; companyId: string; branchId: string }
const sent: (EmailMessage & { from: string })[] = []
let failNext = false
const tokenOf = (m: EmailMessage) => (m.text.match(/ativar\?token=([A-Za-z0-9_-]+)/) || [])[1]
const loginStatus = async (email: string, password: string) => (await call('POST', '/api/auth/login', { body: { email, password } })).status

before(async () => {
  E = await setup()
  setEmailTransport(async (m) => { if (failNext) { failNext = false; throw new Error('provedor indisponível') } sent.push(m); return { provider: 'teste', id: 'msg-' + sent.length } })
  A = await login('admin.a@teste.local')
})
after(async () => { setEmailTransport(null); await teardown() })

test('novo usuário recebe link de ativação por e-mail; nenhuma senha é exibida nem enviada', async () => {
  const st = await call('GET', '/api/email/status', { token: A.token })
  assert.equal(st.body.available, true)
  const roles = (await call('GET', '/api/admin/roles', { token: A.token })).body
  const r = await call('POST', '/api/admin/users', { token: A.token, body: { name: 'Carla Convidada', email: 'carla@teste.local', roleId: roles.find((x: any) => x.name === 'Vendedor').id, allBranches: true } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.invite.sent, true); assert.equal(r.body.temporaryPassword, undefined)
  const m = sent[sent.length - 1]
  assert.equal(m.to, 'carla@teste.local'); assert.match(m.subject, /Ative seu acesso/); assert.ok(m.html.includes('Ativar meu acesso'))
  const tk = tokenOf(m); assert.ok(tk && tk.length >= 40)
  // só o hash fica no banco
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM user_tokens WHERE token_hash = $1`, [tk])).rows[0].n, 0)
  const u = (await db.query(`SELECT pending_activation, must_change_password FROM users WHERE email = 'carla@teste.local'`)).rows[0]
  assert.equal(u.pending_activation, true); assert.equal(u.must_change_password, false)
  const list = await call('GET', '/api/admin/users', { token: A.token })
  const row = list.body.items.find((x: any) => x.email === 'carla@teste.local')
  assert.equal(row.pending_activation, true); assert.equal(row.last_email.status, 'enviado')
  // não consegue entrar antes de ativar
  assert.equal(await loginStatus('carla@teste.local', PASSWORD), 401)

  const info = await call('GET', `/api/public/activation?token=${tk}`)
  assert.equal(info.status, 200); assert.equal(info.body.name, 'Carla'); assert.equal(info.body.email, 'ca***@teste.local'); assert.equal(info.body.kind, 'ativacao')
  assert.equal((await call('POST', '/api/public/activation', { body: { token: tk, password: '123' } })).status, 422)
  const ok = await call('POST', '/api/public/activation', { body: { token: tk, password: 'Carla-Senha-2026' } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal((await call('POST', '/api/public/activation', { body: { token: tk, password: 'Outra-Senha-2026' } })).status, 410)
  assert.equal((await call('GET', `/api/public/activation?token=${tk}`)).status, 410)
  assert.equal(await loginStatus('carla@teste.local', 'Carla-Senha-2026'), 200)
  const after2 = (await db.query(`SELECT pending_activation FROM users WHERE email = 'carla@teste.local'`)).rows[0]
  assert.equal(after2.pending_activation, false)
})

test('reenvio invalida o link anterior; link expirado não funciona', async () => {
  const roles = (await call('GET', '/api/admin/roles', { token: A.token })).body
  const r = await call('POST', '/api/admin/users', { token: A.token, body: { name: 'Davi Teste', email: 'davi@teste.local', roleId: roles.find((x: any) => x.name === 'Vendedor').id, allBranches: true } })
  const first = tokenOf(sent[sent.length - 1])
  const again = await call('POST', `/api/admin/users/${r.body.id}/reset-password`, { token: A.token, body: { delivery: 'email' } })
  assert.equal(again.body.invite.sent, true)
  const second = tokenOf(sent[sent.length - 1])
  assert.notEqual(first, second)
  assert.equal((await call('GET', `/api/public/activation?token=${first}`)).status, 410)
  await db.query(`UPDATE user_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [r.body.id])
  assert.equal((await call('POST', '/api/public/activation', { body: { token: second, password: 'Davi-Senha-2026' } })).status, 410)
  assert.equal((await call('GET', `/api/public/activation?token=${'x'.repeat(43)}`)).status, 410)
})

test('redefinição por link: senha atual vale até o uso; depois as sessões são encerradas', async () => {
  const S = await login('vend.a@teste.local')
  const r = await call('POST', `/api/admin/users/${E.vendedorA}/reset-password`, { token: A.token, body: { delivery: 'email' } })
  assert.equal(r.body.invite.sent, true)
  const m = sent[sent.length - 1]; assert.match(m.subject, /Redefinição de senha/)
  assert.equal(await loginStatus('vend.a@teste.local', PASSWORD), 200) // ainda vale
  assert.equal((await call('POST', '/api/public/activation', { body: { token: tokenOf(m), password: 'Vendedor-Nova-2026' } })).status, 200)
  assert.equal(await loginStatus('vend.a@teste.local', PASSWORD), 401)
  assert.equal(await loginStatus('vend.a@teste.local', 'Vendedor-Nova-2026'), 200)
  assert.equal((await call('GET', '/api/auth/me', { token: S.token })).status, 401) // sessão antiga encerrada
  await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [E.vendedorA, hashPassword(PASSWORD)])
})

test('falha no envio: alternativa por senha temporária; senha temporária explícita continua disponível', async () => {
  const roles = (await call('GET', '/api/admin/roles', { token: A.token })).body
  const vend = roles.find((x: any) => x.name === 'Vendedor').id
  failNext = true
  const r = await call('POST', '/api/admin/users', { token: A.token, body: { name: 'Elisa Teste', email: 'elisa@teste.local', roleId: vend, allBranches: true } })
  assert.equal(r.status, 200); assert.equal(r.body.invite.sent, false); assert.ok(r.body.temporaryPassword)
  assert.equal(await loginStatus('elisa@teste.local', r.body.temporaryPassword), 200)
  const log = (await db.query(`SELECT status, error FROM email_log WHERE to_email = 'elisa@teste.local'`)).rows[0]
  assert.equal(log.status, 'erro'); assert.match(log.error, /indisponível/)
  const s = await call('POST', '/api/admin/users', { token: A.token, body: { name: 'Fabio Teste', email: 'fabio@teste.local', roleId: vend, allBranches: true, delivery: 'senha' } })
  assert.ok(s.body.temporaryPassword); assert.equal(s.body.invite, undefined)
  // vendedor não consulta a configuração de e-mail
  const V = await login('vend.a@teste.local')
  assert.equal((await call('GET', '/api/email/status', { token: V.token })).status, 403)
})

test('equipe da plataforma: convite por e-mail e e-mail de teste', async () => {
  await db.query(`UPDATE users SET is_superadmin = true, platform_owner = true WHERE email = 'admin.b@teste.local'`)
  const P = await login('admin.b@teste.local')
  const r = await call('POST', '/api/platform/team', { token: P.token, body: { name: 'Gabi Suporte', email: 'gabi@axionyx.local', permissions: ['suporte.acessar'] } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.invite.sent, true); assert.equal(r.body.temporaryPassword, undefined)
  const team = await call('GET', '/api/platform/team', { token: P.token })
  assert.equal(team.body.find((m: any) => m.email === 'gabi@axionyx.local').pending_activation, true)
  const cfg = await call('GET', '/api/platform/email', { token: P.token })
  assert.equal(cfg.status, 200); assert.equal(cfg.body.available, true); assert.ok(cfg.body.recent.length >= 1)
  const t = await call('POST', '/api/platform/email/test', { token: P.token, body: { to: 'teste@exemplo.com' } })
  assert.equal(t.body.sent, true)
  assert.equal((await call('GET', '/api/platform/email', { token: A.token })).status, 403)
})

test('cliente SMTP: STARTTLS opcional só em teste local, AUTH LOGIN, MIME UTF-8 e ponto escapado', async () => {
  const got: string[] = []
  let data = ''
  const srv = net.createServer((s) => {
    s.setEncoding('utf8'); s.write('220 teste ESMTP\r\n')
    let inData = false, buf = ''
    s.on('data', (d: string) => {
      buf += d
      if (inData) { if (buf.endsWith('\r\n.\r\n')) { data = buf; buf = ''; inData = false; s.write('250 OK id=123\r\n') } return }
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); got.push(line)
        if (/^EHLO/.test(line)) s.write('250-teste\r\n250 AUTH LOGIN\r\n')
        else if (line === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n')
        else if (got.length && got[got.length - 2] === 'AUTH LOGIN') s.write('334 UGFzc3dvcmQ6\r\n')
        else if (got[got.length - 3] === 'AUTH LOGIN') s.write('235 ok\r\n')
        else if (/^MAIL FROM/.test(line) || /^RCPT TO/.test(line)) s.write('250 ok\r\n')
        else if (line === 'DATA') { s.write('354 go\r\n'); inData = true; return }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end() }
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as net.AddressInfo).port
  setEmailTransport(null)
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'u@teste.local', SMTP_PASS: 'segredo', EMAIL_FROM: 'nao-responda@axionyx.local', SMTP_ALLOW_INSECURE: 'true' })
  try {
    const r = await sendEmail({ to: 'dest@teste.local', toName: 'José Ávila', subject: 'Ação necessária', text: 'linha\n.começa com ponto', html: '<p>Olá</p>' })
    assert.equal(r.provider, 'smtp')
    assert.ok(got.includes('MAIL FROM:<nao-responda@axionyx.local>')); assert.ok(got.includes('RCPT TO:<dest@teste.local>'))
    assert.ok(got.includes(Buffer.from('u@teste.local').toString('base64')))
    assert.match(data, /Subject: =\?UTF-8\?B\?/); assert.match(data, /multipart\/alternative/)
    const parts = data.split(/\r\n\r\n/).slice(1).join('\n')
    assert.ok(parts.includes(Buffer.from('<p>Olá</p>').toString('base64')))
    // sem STARTTLS e sem a permissão de teste: recusa enviar sem criptografia
    delete process.env.SMTP_ALLOW_INSECURE
    await assert.rejects(sendEmail({ to: 'dest@teste.local', subject: 'x', text: 'x', html: 'x' }), /STARTTLS/)
  } finally {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'SMTP_ALLOW_INSECURE']) delete process.env[k]
    srv.close()
    setEmailTransport(async (m) => { sent.push(m); return { provider: 'teste' } })
  }
})
