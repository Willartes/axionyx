import crypto from 'node:crypto'
import { router, audit } from '../core/http'
import { db, tx, Q } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, unauthorized } from '../core/errors'
import { encryptSecret, decryptSecret } from '../core/crypto'
import { whatsapp } from '../integrations/adapters'
import { companyWhatsapp, processWebhook, countPlaceholders, TEMPLATE_FIELDS, PURPOSES, onlyPhone } from '../services/whatsapp'

/**
 * WhatsApp por empresa (WhatsApp Business Platform — Cloud API oficial da Meta).
 * O administrador informa o número da empresa e as credenciais na tela Plataforma › Integrações › WhatsApp;
 * o token fica cifrado no banco e nunca volta para o navegador.
 */
async function integration(c: Q, companyId: string, lock = false) {
  let i = await c.one(`SELECT * FROM integrations WHERE company_id = $1 AND kind = 'whatsapp' ORDER BY created_at LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`, [companyId])
  if (!i) i = await c.one(`INSERT INTO integrations(company_id, kind, provider, name) VALUES ($1,'whatsapp','meta_cloud_api','WhatsApp Business Platform') RETURNING *`, [companyId])
  return i
}
function secrets(i: any): { accessToken?: string; appSecret?: string } {
  try { return JSON.parse(decryptSecret(i.secret_enc) || '{}') || {} } catch { return {} }
}
function publicBase(ctx: any) {
  const proto = String(ctx.req.headers['x-forwarded-proto'] || '').split(',')[0] || 'https'
  const host = String(ctx.req.headers['x-forwarded-host'] || ctx.req.headers.host || '')
  return `${host.startsWith('localhost') || host.startsWith('127.') ? 'http' : proto}://${host}`
}
function view(i: any, ctx: any) {
  const s = secrets(i)
  return {
    integrationId: i.id, status: i.status, lastError: i.last_error, lastSyncAt: i.last_sync_at,
    displayPhone: i.config.displayPhone ?? '', phoneNumberId: i.config.phoneNumberId ?? '', wabaId: i.config.wabaId ?? '', apiVersion: i.config.apiVersion ?? '',
    verifiedName: i.config.verifiedName ?? null, qualityRating: i.config.qualityRating ?? null, testedAt: i.config.testedAt ?? null,
    hasToken: !!s.accessToken, tokenHint: s.accessToken ? '••••' + s.accessToken.slice(-4) : null, hasAppSecret: !!s.appSecret,
    webhookUrl: `${publicBase(ctx)}/api/webhooks/whatsapp/${i.id}`, verifyToken: i.webhook_verify_token, webhookVerifiedAt: i.config.webhookVerifiedAt ?? null,
    serverFallback: !s.accessToken && !!whatsapp.envCreds(),
  }
}

router.get('/api/whatsapp/config', { perm: 'integracoes.ver' }, async (ctx) => {
  const i = await integration(db, ctx.user.companyId)
  const stats = await db.one(`SELECT count(*) FILTER (WHERE direction = 'saida' AND created_at > now() - interval '30 days')::int AS sent_30d,
                                     count(*) FILTER (WHERE direction = 'entrada' AND created_at > now() - interval '30 days')::int AS received_30d,
                                     count(*) FILTER (WHERE status = 'erro' AND created_at > now() - interval '7 days')::int AS errors_7d,
                                     count(*) FILTER (WHERE status = 'pendente_configuracao')::int AS waiting
                                FROM messages WHERE company_id = $1`, [ctx.user.companyId])
  return { ...view(i, ctx), stats, fields: TEMPLATE_FIELDS, purposes: PURPOSES }
})

router.put('/api/whatsapp/config', { perm: 'integracoes.editar' }, async (ctx) => {
  const b: any = parse(v.object({
    displayPhone: v.string({ min: 10, max: 20 }), phoneNumberId: v.string({ pattern: /^\d{8,20}$/, patternMsg: 'O Phone Number ID tem só números (veja em WhatsApp › Configuração da API, no painel da Meta).' }),
    wabaId: v.string({ pattern: /^\d{8,20}$/, patternMsg: 'O ID da conta do WhatsApp Business tem só números.' }).optional(),
    apiVersion: v.string({ pattern: /^v\d{2}\.\d$/, patternMsg: 'Use o formato v21.0' }).optional(),
    accessToken: v.string({ min: 20, max: 1000 }).optional(), appSecret: v.string({ min: 16, max: 200 }).optional(),
  }), ctx.body)
  if (onlyPhone(b.displayPhone).length < 10) throw unprocessable('Informe o número com DDD (ex.: (11) 99999-9999).')
  return tx(async (c) => {
    const i = await integration(c, ctx.user.companyId, true)
    const s = secrets(i)
    if (b.accessToken) s.accessToken = b.accessToken.trim()
    if (b.appSecret) s.appSecret = b.appSecret.trim()
    if (!s.accessToken) throw unprocessable('Informe o token de acesso permanente gerado no Meta Business (usuário do sistema).')
    const changedNumber = i.config.phoneNumberId && i.config.phoneNumberId !== b.phoneNumberId
    const config = { ...i.config, displayPhone: b.displayPhone, phoneNumberId: b.phoneNumberId, wabaId: b.wabaId ?? null, apiVersion: b.apiVersion ?? null,
      ...(b.accessToken || changedNumber ? { verifiedName: null, testedAt: null, qualityRating: null } : {}) }
    const verify = i.webhook_verify_token || crypto.randomBytes(18).toString('base64url')
    // credenciais novas exigem novo teste antes de enviar
    const status = b.accessToken || changedNumber ? 'pendente_configuracao' : i.status
    const r = await c.one(`UPDATE integrations SET config = $2, secret_enc = $3, webhook_verify_token = $4, status = $5, provider = 'meta_cloud_api', updated_at = now() WHERE id = $1 RETURNING *`,
      [i.id, JSON.stringify(config), encryptSecret(JSON.stringify(s)), verify, status])
    await audit(c, ctx, 'whatsapp.configurado', 'integration', i.id, { displayPhone: b.displayPhone, phoneNumberId: b.phoneNumberId, wabaId: b.wabaId ?? null,
      tokenAlterado: !!b.accessToken, appSecretAlterado: !!b.appSecret }, 'warning')
    return view(r, ctx)
  })
})

/** Testa as credenciais na Meta; se responder, ativa o WhatsApp da empresa e libera as mensagens que aguardavam configuração. */
router.post('/api/whatsapp/test', { perm: 'integracoes.editar' }, async (ctx) => {
  const i = await integration(db, ctx.user.companyId)
  const s = secrets(i)
  if (!s.accessToken || !i.config.phoneNumberId) throw unprocessable('Salve o número, o Phone Number ID e o token antes de testar.')
  let info: any
  try {
    info = await whatsapp.graph({ token: s.accessToken, phoneNumberId: i.config.phoneNumberId, version: i.config.apiVersion || undefined }, 'GET',
      `${i.config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`)
  } catch (e: any) {
    await db.query(`UPDATE integrations SET status = 'erro', last_error = $2, updated_at = now() WHERE id = $1`, [i.id, String(e.message).slice(0, 300)])
    await db.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message) VALUES ($1,$2,'saida','whatsapp.teste','erro',$3)`, [ctx.user.companyId, i.id, String(e.message).slice(0, 900)])
    if (!e.status) throw unprocessable(`Não foi possível conectar à Meta (${String(e.message).slice(0, 120)}). Verifique a conexão do servidor com graph.facebook.com e tente de novo.`)
    throw unprocessable(`A Meta recusou as credenciais: ${String(e.message).slice(0, 300)}. Confira o Phone Number ID e se o token é permanente e tem as permissões whatsapp_business_messaging e whatsapp_business_management.`)
  }
  const r = await tx(async (c) => {
    const config = { ...i.config, verifiedName: info?.verified_name ?? null, qualityRating: info?.quality_rating ?? null, metaDisplayPhone: info?.display_phone_number ?? null, testedAt: new Date().toISOString() }
    const row = await c.one(`UPDATE integrations SET status = 'ativo', last_error = NULL, config = $2, updated_at = now() WHERE id = $1 RETURNING *`, [i.id, JSON.stringify(config)])
    const rel = await c.query(`UPDATE outbox SET status = 'pendente', next_attempt_at = now(), integration_id = $2 WHERE company_id = $1 AND topic = 'whatsapp.mensagem' AND status = 'aguardando_configuracao'`, [ctx.user.companyId, i.id])
    await c.query(`UPDATE messages SET status = 'fila', error = NULL WHERE company_id = $1 AND status = 'pendente_configuracao'`, [ctx.user.companyId])
    await c.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message) VALUES ($1,$2,'saida','whatsapp.teste','sucesso',$3)`,
      [ctx.user.companyId, i.id, `Número ${info?.display_phone_number ?? ''} (${info?.verified_name ?? ''}) validado`])
    await audit(c, ctx, 'whatsapp.ativado', 'integration', i.id, { verifiedName: info?.verified_name, number: info?.display_phone_number, liberadas: rel.rowCount }, 'warning')
    return { ...view(row, ctx), released: rel.rowCount }
  })
  return r
})

router.post('/api/whatsapp/deactivate', { perm: 'integracoes.editar' }, async (ctx) => {
  const i = await integration(db, ctx.user.companyId)
  const r = await db.one(`UPDATE integrations SET status = 'desativado', updated_at = now() WHERE id = $1 RETURNING *`, [i.id])
  await audit(null, ctx, 'whatsapp.desativado', 'integration', i.id, null, 'warning')
  return view(r, ctx)
})

router.delete('/api/whatsapp/config', { perm: 'integracoes.editar' }, async (ctx) => {
  const i = await integration(db, ctx.user.companyId)
  const config = { ...i.config }; for (const k of ['displayPhone', 'phoneNumberId', 'wabaId', 'verifiedName', 'qualityRating', 'testedAt', 'webhookVerifiedAt', 'metaDisplayPhone']) delete config[k]
  const r = await db.one(`UPDATE integrations SET status = 'pendente_configuracao', secret_enc = NULL, config = $2, updated_at = now() WHERE id = $1 RETURNING *`, [i.id, JSON.stringify(config)])
  await audit(null, ctx, 'whatsapp.credenciais_removidas', 'integration', i.id, null, 'critical')
  return view(r, ctx)
})

// ---------- Modelos de mensagem (templates) ----------
router.get('/api/whatsapp/templates', { perm: ['integracoes.ver', 'mensagens.enviar'] }, async (ctx) =>
  db.many(`SELECT * FROM whatsapp_templates WHERE company_id = $1 ORDER BY purpose NULLS LAST, name`, [ctx.user.companyId]))

const tplSchema = {
  name: v.string({ pattern: /^[a-z0-9_]{1,512}$/, patternMsg: 'Use o nome exato do modelo na Meta (minúsculas, números e _).' }), language: v.string({ pattern: /^[a-z]{2}(_[A-Z]{2})?$/ }).default('pt_BR'),
  body: v.string({ max: 1024 }).optional(), category: v.string({ max: 40 }).optional(),
  purpose: v.enum(PURPOSES).nullable().optional(), variables: v.array(v.enum(Object.keys(TEMPLATE_FIELDS) as [string, ...string[]]), { max: 10 }).optional(),
}
router.post('/api/whatsapp/templates', { perm: 'integracoes.editar' }, async (ctx) => {
  const b: any = parse(v.object(tplSchema), ctx.body)
  return tx(async (c) => {
    if (b.purpose) await c.query(`UPDATE whatsapp_templates SET purpose = NULL WHERE company_id = $1 AND purpose = $2`, [ctx.user.companyId, b.purpose])
    const r = await c.one(`INSERT INTO whatsapp_templates(company_id, name, language, body, category, purpose, variables, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'manual')
                           ON CONFLICT (company_id, name, language) DO UPDATE SET body = COALESCE(EXCLUDED.body, whatsapp_templates.body), purpose = EXCLUDED.purpose, variables = EXCLUDED.variables, updated_at = now() RETURNING *`,
      [ctx.user.companyId, b.name, b.language, b.body ?? null, b.category ?? null, b.purpose ?? null, b.variables ?? []])
    await audit(c, ctx, 'whatsapp.modelo_salvo', 'whatsapp_template', r.id, b)
    return r
  })
})
router.put('/api/whatsapp/templates/:id', { perm: 'integracoes.editar' }, async (ctx) => {
  const b: any = parse(v.object({ purpose: v.enum(PURPOSES).nullable().optional(), variables: v.array(v.enum(Object.keys(TEMPLATE_FIELDS) as [string, ...string[]]), { max: 10 }).optional(),
    body: v.string({ max: 1024 }).optional() }), ctx.body)
  return tx(async (c) => {
    const t = await c.one(`SELECT * FROM whatsapp_templates WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!t) throw notFound('Modelo')
    const vars = b.variables ?? t.variables
    const need = countPlaceholders(b.body ?? t.body)
    if (b.variables && need && vars.length !== need) throw unprocessable(`Este modelo tem ${need} variável(is) ({{1}}…{{${need}}}); escolha um dado do sistema para cada uma.`)
    if ('purpose' in ctx.body && b.purpose) {
      if (t.status !== 'APPROVED') throw unprocessable('Só modelos aprovados pela Meta podem ser usados nos envios automáticos.')
      await c.query(`UPDATE whatsapp_templates SET purpose = NULL WHERE company_id = $1 AND purpose = $2 AND id <> $3`, [ctx.user.companyId, b.purpose, t.id])
    }
    const r = await c.one(`UPDATE whatsapp_templates SET purpose = $2, variables = $3, body = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [t.id, 'purpose' in ctx.body ? b.purpose ?? null : t.purpose, vars, b.body ?? t.body])
    await audit(c, ctx, 'whatsapp.modelo_alterado', 'whatsapp_template', t.id, b)
    return r
  })
})
router.delete('/api/whatsapp/templates/:id', { perm: 'integracoes.editar' }, async (ctx) => {
  const r = await db.one(`DELETE FROM whatsapp_templates WHERE id = $1 AND company_id = $2 RETURNING id`, [ctx.params.id, ctx.user.companyId])
  if (!r) throw notFound('Modelo')
  await audit(null, ctx, 'whatsapp.modelo_removido', 'whatsapp_template', r.id)
  return { ok: true }
})

/** Busca na Meta os modelos da conta (exige o ID da conta do WhatsApp Business). Mantém finalidade e variáveis já escolhidas. */
router.post('/api/whatsapp/templates/sync', { perm: 'integracoes.editar' }, async (ctx) => {
  const i = await integration(db, ctx.user.companyId)
  const s = secrets(i)
  if (!s.accessToken || !i.config.wabaId) throw unprocessable('Informe o ID da conta do WhatsApp Business (WABA ID) e o token para sincronizar os modelos.')
  let data: any
  try { data = await whatsapp.graph({ token: s.accessToken, phoneNumberId: i.config.phoneNumberId, version: i.config.apiVersion || undefined }, 'GET', `${i.config.wabaId}/message_templates?limit=200&fields=name,language,status,category,components`) }
  catch (e: any) { throw unprocessable(`A Meta recusou a consulta de modelos: ${String(e.message).slice(0, 300)}`) }
  const list: any[] = data?.data ?? []
  return tx(async (c) => {
    let n = 0
    for (const t of list) {
      const body = (t.components ?? []).find((x: any) => x.type === 'BODY')?.text ?? null
      await c.query(`INSERT INTO whatsapp_templates(company_id, name, language, category, status, body, source) VALUES ($1,$2,$3,$4,$5,$6,'meta')
                     ON CONFLICT (company_id, name, language) DO UPDATE SET category = EXCLUDED.category, status = EXCLUDED.status, body = EXCLUDED.body, source = 'meta', updated_at = now()`,
        [ctx.user.companyId, t.name, t.language, t.category ?? null, t.status ?? 'APPROVED', body])
      n++
    }
    // modelo que deixou de ser aprovado não pode continuar em uso automático
    await c.query(`UPDATE whatsapp_templates SET purpose = NULL WHERE company_id = $1 AND status <> 'APPROVED' AND purpose IS NOT NULL`, [ctx.user.companyId])
    await c.query(`UPDATE integrations SET last_sync_at = now() WHERE id = $1`, [i.id])
    await audit(c, ctx, 'whatsapp.modelos_sincronizados', 'integration', i.id, { total: n })
    return { synced: n, items: await c.many(`SELECT * FROM whatsapp_templates WHERE company_id = $1 ORDER BY purpose NULLS LAST, name`, [ctx.user.companyId]) }
  })
})

/** Mensagem de teste para um número (o do próprio administrador): modelo escolhido ou texto (texto só chega se esse número falou com a loja nas últimas 24 h). */
router.post('/api/whatsapp/send-test', { perm: 'integracoes.editar' }, async (ctx) => {
  const b: any = parse(v.object({ to: v.string({ min: 10, max: 20 }), templateId: v.uuid().optional(), text: v.string({ max: 1000 }).optional() }), ctx.body)
  const w = await companyWhatsapp(db, ctx.user.companyId)
  if (!w) throw unprocessable('Configure o WhatsApp da empresa antes de enviar o teste.')
  let msg: any
  if (b.templateId) {
    const t = await db.one(`SELECT * FROM whatsapp_templates WHERE id = $1 AND company_id = $2`, [b.templateId, ctx.user.companyId])
    if (!t) throw notFound('Modelo')
    const params = Array.from({ length: countPlaceholders(t.body) }, (_, k) => (t.variables[k] ? `[${t.variables[k]}]` : 'teste'))
    msg = { template: { name: t.name, language: t.language, params } }
  } else msg = { template: { name: 'hello_world', language: 'en_US' } }
  if (b.text) msg = { text: b.text }
  try {
    const r = await whatsapp.send(w, b.to, msg)
    await db.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message) VALUES ($1,$2,'saida','whatsapp.teste_envio','sucesso',$3)`, [ctx.user.companyId, w.integrationId, `Teste para ${onlyPhone(b.to).slice(-4).padStart(8, '*')}`])
    await audit(null, ctx, 'whatsapp.teste_envio', 'integration', w.integrationId, { to: '***' + onlyPhone(b.to).slice(-4), template: msg.template?.name ?? null })
    return { ok: true, id: r.id, note: msg.text ? 'Texto livre só é entregue se este número enviou mensagem para a loja nas últimas 24 horas.' : undefined }
  } catch (e: any) {
    throw unprocessable(`Falha no envio: ${String(e.message).slice(0, 300)}`)
  }
})

// ---------- Webhook da Meta (confirmações e mensagens recebidas) ----------
router.get('/api/webhooks/whatsapp/:integrationId', { auth: 'none' }, async (ctx) => {
  if (!/^[0-9a-f-]{36}$/i.test(ctx.params.integrationId)) throw notFound('Integração')
  const i = await db.one(`SELECT id, webhook_verify_token, config FROM integrations WHERE id = $1 AND kind = 'whatsapp'`, [ctx.params.integrationId])
  const token = String(ctx.query['hub.verify_token'] || '')
  if (!i || !i.webhook_verify_token || ctx.query['hub.mode'] !== 'subscribe' || token.length !== i.webhook_verify_token.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(i.webhook_verify_token))) throw unauthorized('Token de verificação inválido.')
  await db.query(`UPDATE integrations SET config = config || jsonb_build_object('webhookVerifiedAt', now()::text) WHERE id = $1`, [i.id])
  ctx.reply = { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, raw: String(ctx.query['hub.challenge'] || '') }
  return null
})

router.post('/api/webhooks/whatsapp/:integrationId', { auth: 'none', maxBody: 1_000_000 }, async (ctx) => {
  if (!/^[0-9a-f-]{36}$/i.test(ctx.params.integrationId)) throw notFound('Integração')
  const i = await db.one(`SELECT * FROM integrations WHERE id = $1 AND kind = 'whatsapp'`, [ctx.params.integrationId])
  if (!i) throw notFound('Integração')
  const appSecret = secrets(i).appSecret || (!i.secret_enc ? process.env.WHATSAPP_APP_SECRET?.trim() : undefined)
  if (!appSecret) throw unauthorized('Webhook sem "App Secret" configurado: cadastre-o na tela de WhatsApp.')
  const sig = String(ctx.req.headers['x-hub-signature-256'] || '')
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(ctx.rawBody).digest('hex')
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    await db.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message) VALUES ($1,$2,'entrada','whatsapp.webhook','erro','Assinatura inválida (confira o App Secret)')`, [i.company_id, i.id])
    throw unauthorized('Assinatura inválida.')
  }
  const r = await tx((c) => processWebhook(c, i.company_id, i.id, ctx.body, i.config.phoneNumberId))
  ctx.reply = { status: 200 }
  return r
})

