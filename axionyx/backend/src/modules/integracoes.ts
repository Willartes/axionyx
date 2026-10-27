import crypto from 'node:crypto'
import { router, audit, paged, Where, can, r2, Ctx } from '../core/http'
import { db, tx, Q, nextNumber } from '../core/db'
import { v, parse, onlyDigits } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden, unauthorized } from '../core/errors'
import { adapterStatus, logistics } from '../integrations/adapters'
import { processOutbox } from '../integrations/worker'
import { secret } from '../config'
import { createSale } from '../services/sales'
import { companyWhatsapp, whatsappReady, templateVars, renderTemplate, countPlaceholders } from '../services/whatsapp'

router.get('/api/integrations', { perm: 'integracoes.ver' }, async (ctx) => {
  const st = adapterStatus()
  const rows = await db.many(`SELECT i.*, (SELECT count(*)::int FROM outbox o WHERE o.integration_id = i.id AND o.status IN ('pendente','erro','aguardando_configuracao')) AS queued,
                                     (SELECT count(*)::int FROM integration_logs l WHERE l.integration_id = i.id AND l.created_at > now() - interval '24 hours') AS calls_24h,
                                     (SELECT count(*)::int FROM integration_logs l WHERE l.integration_id = i.id AND l.status = 'erro' AND l.created_at > now() - interval '24 hours') AS errors_24h
                                FROM integrations i WHERE i.company_id = $1 ORDER BY i.kind`, [ctx.user.companyId])
  const queue = await db.one(`SELECT count(*) FILTER (WHERE status = 'pendente')::int AS pending, count(*) FILTER (WHERE status = 'erro')::int AS errors,
                                     count(*) FILTER (WHERE status = 'aguardando_configuracao')::int AS waiting, count(*) FILTER (WHERE status = 'enviado' AND processed_at > now() - interval '24 hours')::int AS sent_24h
                                FROM outbox WHERE company_id = $1`, [ctx.user.companyId])
  const wa = await companyWhatsapp(db, ctx.user.companyId)
  return { items: rows.map(({ secret_enc, webhook_verify_token, ...r }) => ({ ...r, credentials_present: r.kind === 'whatsapp' ? !!wa : !!st[r.kind], credentials_source: r.kind === 'whatsapp' ? wa?.source ?? null : null })), queue }
})

router.put('/api/integrations/:id', { perm: 'integracoes.editar' }, async (ctx) => {
  const b = parse(v.object({ status: v.enum(['ativo', 'desativado', 'pendente_configuracao'] as const).optional(), config: v.json().optional() }), ctx.body)
  return tx(async (c) => {
    const i = await c.one(`SELECT * FROM integrations WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!i) throw notFound('Integração')
    if (b.status === 'ativo' && i.kind === 'whatsapp' && !(await companyWhatsapp(c, ctx.user.companyId))) throw unprocessable('Configure o número e as credenciais do WhatsApp da empresa (botão Configurar) antes de ativar.')
    if (b.status === 'ativo' && i.kind !== 'whatsapp' && !adapterStatus()[i.kind]) throw unprocessable('Credenciais desta integração não estão configuradas no servidor (variáveis de ambiente). A integração não pode ser ativada.')
    const config = b.config ? { ...i.config, ...b.config } : i.config
    for (const k of Object.keys(config)) if (/token|secret|senha|password|key/i.test(k)) delete config[k] // segredos nunca no banco
    const { secret_enc: _s, webhook_verify_token: _w, ...r } = await c.one(`UPDATE integrations SET status = COALESCE($2, status), config = $3, updated_at = now() WHERE id = $1 RETURNING *`, [i.id, b.status ?? null, JSON.stringify(config)])
    if (b.status === 'ativo') await c.query(`UPDATE outbox SET status = 'pendente', next_attempt_at = now() WHERE integration_id = $1 AND status = 'aguardando_configuracao'`, [i.id])
    await audit(c, ctx, 'integracao.alterada', 'integration', i.id, b, 'warning')
    return r
  })
})

router.get('/api/integrations/logs', { perm: 'integracoes.ver' }, async (ctx) => {
  const w = new Where([['l.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.integration, 'l.integration_id = ?', ctx.query.integration).addIf(ctx.query.status, 'l.status = ?', ctx.query.status)
  return paged(db, `SELECT l.id, l.direction, l.topic, l.status, l.message, l.created_at, i.name AS integration FROM integration_logs l LEFT JOIN integrations i ON i.id = l.integration_id ${w.sql} ORDER BY l.id DESC`, w.params, ctx.query, 50)
})

router.get('/api/integrations/outbox', { perm: 'integracoes.ver' }, async (ctx) => {
  const w = new Where([['o.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.status, 'o.status = ?', ctx.query.status)
  return paged(db, `SELECT o.*, i.name AS integration FROM outbox o LEFT JOIN integrations i ON i.id = o.integration_id ${w.sql} ORDER BY o.id DESC`, w.params, ctx.query, 50)
})

router.post('/api/integrations/outbox/:id/retry', { perm: 'integracoes.editar' }, async (ctx) => {
  const r = await db.one(`UPDATE outbox SET status = 'pendente', attempts = LEAST(attempts, 7), next_attempt_at = now() WHERE id = $1 AND company_id = $2 AND status IN ('erro','aguardando_configuracao') RETURNING id`, [ctx.params.id, ctx.user.companyId])
  if (!r) throw conflict('Evento não está em erro.')
  await processOutbox(5)
  return db.one(`SELECT * FROM outbox WHERE id = $1`, [ctx.params.id])
})

router.post('/api/integrations/:id/sync-products', { perm: 'integracoes.editar' }, async (ctx) => {
  const i = await db.one(`SELECT * FROM integrations WHERE id = $1 AND company_id = $2 AND kind = 'ecommerce'`, [ctx.params.id, ctx.user.companyId])
  if (!i) throw notFound('Integração de e-commerce')
  if (i.status !== 'ativo') throw unprocessable('Ative a integração (com credenciais configuradas) antes de sincronizar.')
  const r = await db.query(`INSERT INTO outbox(company_id, integration_id, topic, payload, dedupe_key)
                            SELECT $1, $2, 'ecommerce.produto', jsonb_build_object('productId', p.id::text), 'produto:' || p.id || ':full:' || to_char(now(),'YYYYMMDDHH24MI')
                              FROM products p WHERE p.company_id = $1 AND p.active ON CONFLICT DO NOTHING`, [ctx.user.companyId, i.id])
  await audit(null, ctx, 'integracao.sincronizacao_produtos', 'integration', i.id, { queued: r.rowCount })
  return { queued: r.rowCount }
})

/**
 * Webhook de pedidos da loja virtual (contrato genérico, ver docs/INTEGRACOES.md).
 * Autenticado por assinatura HMAC-SHA256 do corpo (cabeçalho X-Signature) com ECOMMERCE_WEBHOOK_SECRET.
 * Idempotente pelo id externo do pedido.
 */
router.post('/api/webhooks/ecommerce/:integrationId', { auth: 'none' }, async (ctx) => {
  const key = secret('ECOMMERCE_WEBHOOK_SECRET')
  if (!key) throw unauthorized('Webhook de e-commerce não configurado.')
  const sig = String(ctx.req.headers['x-signature'] || '')
  const expected = crypto.createHmac('sha256', key).update(ctx.rawBody).digest('hex')
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw unauthorized('Assinatura inválida.')
  const i = await db.one(`SELECT * FROM integrations WHERE id = $1 AND kind = 'ecommerce' AND status = 'ativo'`, [ctx.params.integrationId])
  if (!i) throw notFound('Integração ativa')
  const b: any = parse(v.object({
    id: v.string({ min: 1, max: 80 }),
    customer: v.object({ name: v.string({ min: 2 }), email: v.email().optional(), document: v.string().optional(), phone: v.string().optional() }),
    items: v.array(v.object({ sku: v.string(), qty: v.int({ min: 1 }), price: v.money({ min: 0.01 }) }), { min: 1 }),
    payment: v.object({ kind: v.enum(['credito', 'pix', 'boleto', 'outro'] as const), installments: v.int({ min: 1 }).optional() }),
    shippingFee: v.money({ min: 0 }).optional(),
  }), ctx.body)
  const existing = await db.one(`SELECT local_id FROM external_ids WHERE integration_id = $1 AND entity = 'pedido' AND external_id = $2`, [i.id, b.id])
  if (existing) { ctx.reply = { status: 200 }; return { duplicate: true, saleId: existing.local_id } }
  try {
    return await tx(async (c: Q) => {
      const branchId = i.config.branchId || (await c.one(`SELECT id FROM branches WHERE company_id = $1 AND active ORDER BY code LIMIT 1`, [i.company_id])).id
      const userId = i.config.userId || (await c.one(`SELECT uc.user_id FROM user_companies uc JOIN roles r ON r.id = uc.role_id WHERE uc.company_id = $1 AND r.name = 'Administrador' ORDER BY (SELECT is_superadmin FROM users WHERE id = uc.user_id), uc.created_at LIMIT 1`, [i.company_id])).user_id
      const doc = onlyDigits(b.customer.document)
      let cust = doc ? await c.one(`SELECT id FROM customers WHERE company_id = $1 AND cpf_cnpj = $2`, [i.company_id, doc]) : null
      if (!cust) {
        const code = await nextNumber(c, i.company_id, 'cliente')
        cust = await c.one(`INSERT INTO customers(company_id, code, name, email, cpf_cnpj, phone, tags) VALUES ($1,$2,$3,$4,$5,$6,ARRAY['e-commerce']) RETURNING id`,
          [i.company_id, code, b.customer.name, b.customer.email ?? null, doc || null, onlyDigits(b.customer.phone) || null])
      }
      const variants = await c.many(`SELECT id, sku FROM product_variants WHERE company_id = $1 AND sku = ANY($2)`, [i.company_id, b.items.map((x: any) => x.sku)])
      const vmap = new Map(variants.map((x) => [x.sku, x.id]))
      const missing = b.items.filter((x: any) => !vmap.has(x.sku)).map((x: any) => x.sku)
      if (missing.length) throw unprocessable(`SKU(s) inexistente(s) no ERP: ${missing.join(', ')}`)
      const method = await c.one(`SELECT id FROM payment_methods WHERE company_id = $1 AND kind = $2 AND active ORDER BY sort LIMIT 1`, [i.company_id, b.payment.kind])
      if (!method) throw unprocessable(`Forma de pagamento "${b.payment.kind}" não cadastrada no ERP.`)
      const total = r2(b.items.reduce((s: number, x: any) => s + x.qty * x.price, 0))
      const sale = await createSale(c, { companyId: i.company_id, branchId, userId, userName: 'Integração e-commerce', permissions: new Set(['vendas.desconto_extra']), isSuperadmin: false, maxDiscountPct: 100 }, {
        customerId: cust.id, items: b.items.map((x: any) => ({ variantId: vmap.get(x.sku)!, qty: x.qty, unitPriceOverride: x.price })),
        payments: [{ methodId: method.id, amount: total, installments: b.payment.installments }], channel: 'ecommerce', externalId: b.id, notes: `Pedido e-commerce ${b.id}`,
      })
      await c.query(`INSERT INTO external_ids(company_id, integration_id, entity, local_id, external_id) VALUES ($1,$2,'pedido',$3,$4)`, [i.company_id, i.id, sale.id, b.id])
      await c.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message) VALUES ($1,$2,'entrada','ecommerce.pedido','sucesso',$3)`, [i.company_id, i.id, `Pedido ${b.id} → venda nº ${sale.number}`])
      return { saleId: sale.id, number: sale.number }
    })
  } catch (e: any) {
    await db.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message, request) VALUES ($1,$2,'entrada','ecommerce.pedido','conflito',$3,$4)`,
      [i.company_id, i.id, `Pedido ${b.id}: ${e.message}`, JSON.stringify(b)])
    throw e
  }
})

// ---------- Logística ----------
router.post('/api/shipping/quote', { perm: ['vendas.criar', 'condicional.editar'] }, async (ctx) => {
  const b = parse(v.object({ cepDestino: v.string({ pattern: /^\d{5}-?\d{3}$/, patternMsg: 'CEP inválido.' }), weightKg: v.number({ min: 0.01 }).default(0.5), value: v.money({ min: 0 }).default(0) }), ctx.body)
  if (!logistics.configured()) return { status: 'pendente_configuracao', message: 'Serviço de cotação de frete não configurado. Registre o envio manualmente (transportadora, valor e rastreio).', options: [] }
  try { return { status: 'ok', options: await logistics.quote({ to: onlyDigits(b.cepDestino), weight: b.weightKg, insurance_value: b.value }) } }
  catch (e: any) { return { status: 'erro', message: e.message, options: [] } }
})

router.post('/api/shipments', { perm: ['vendas.criar', 'condicional.editar'] }, async (ctx) => {
  const b = parse(v.object({ refType: v.enum(['sale', 'conditional'] as const), refId: v.uuid(), provider: v.string({ max: 60 }).optional(), service: v.string({ max: 60 }).optional(),
    price: v.money({ min: 0 }).optional(), trackingCode: v.string({ max: 60 }).optional() }), ctx.body)
  const r = await db.one(`INSERT INTO shipments(company_id, ref_type, ref_id, provider, service, price, tracking_code, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING *`,
    [ctx.user.companyId, b.refType, b.refId, b.provider ?? null, b.service ?? null, b.price ?? null, b.trackingCode ?? null])
  await audit(null, ctx, 'logistica.envio_manual', b.refType, b.refId, b)
  return r
})
router.get('/api/shipments', { perm: ['vendas.ver', 'condicional.ver'] }, async (ctx) =>
  db.many(`SELECT * FROM shipments WHERE company_id = $1 AND ($2::uuid IS NULL OR ref_id = $2) ORDER BY created_at DESC LIMIT 200`, [ctx.user.companyId, ctx.query.ref || null]))

// ---------- Mensagens (WhatsApp) ----------
export async function queueMessage(c: Q, ctx: Ctx, input: { customerId: string; purpose: string; body?: string; template?: { name: string; params?: string[] }; refType?: string; refId?: string }) {
  if (input.purpose === 'cobranca' && !can(ctx.user, 'financeiro.ver')) throw forbidden('Mensagens de cobrança exigem acesso ao financeiro.')
  const companyId = ctx.user.companyId
  const cu = await c.one(`SELECT id, name, whatsapp, phone, whatsapp_last_inbound_at FROM customers WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL`, [input.customerId, companyId])
  if (!cu) throw notFound('Cliente')
  const to = cu.whatsapp || cu.phone
  const consent = await c.one(`SELECT granted FROM customer_consents WHERE customer_id = $1 AND channel = 'whatsapp' ORDER BY created_at DESC LIMIT 1`, [cu.id])
  const integ = await c.one(`SELECT id, config FROM integrations WHERE company_id = $1 AND kind = 'whatsapp' ORDER BY created_at LIMIT 1`, [companyId])
  const windowOpen = !!cu.whatsapp_last_inbound_at && new Date(cu.whatsapp_last_inbound_at).getTime() > Date.now() - 24 * 3600_000
  const windowKnown = !!integ?.config?.webhookVerifiedAt
  const vars = await templateVars(c, companyId, cu, input.purpose, input.refType, input.refId, input.body)
  const text = (input.body || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))

  // Escolha do formato: texto livre dentro da janela de 24 h; fora dela, o modelo aprovado cadastrado para a finalidade.
  let tpl: { name: string; language: string; params: string[]; body: string | null } | null = null
  if (input.template?.name) {
    const t = await c.one(`SELECT * FROM whatsapp_templates WHERE company_id = $1 AND name = $2 ORDER BY language = 'pt_BR' DESC LIMIT 1`, [companyId, input.template.name])
    tpl = { name: input.template.name, language: t?.language ?? 'pt_BR', body: t?.body ?? null,
      params: input.template.params ?? (t ? Array.from({ length: countPlaceholders(t.body) }, (_, k) => vars[t.variables[k]] ?? '') : []) }
  } else if (input.purpose !== 'atendimento' && !(windowOpen && text)) {
    const t = await c.one(`SELECT * FROM whatsapp_templates WHERE company_id = $1 AND purpose = $2 AND status = 'APPROVED'`, [companyId, input.purpose])
    if (t) tpl = { name: t.name, language: t.language, body: t.body, params: Array.from({ length: countPlaceholders(t.body) }, (_, k) => vars[t.variables[k]] ?? '') }
  }
  let status = 'fila'
  let error: string | null = null
  // atendimento iniciado pelo cliente não exige opt-in de marketing; demais finalidades exigem consentimento registrado
  if (input.purpose !== 'atendimento' && !consent?.granted) { status = 'bloqueado_sem_consentimento'; error = 'Cliente sem consentimento registrado para WhatsApp.' }
  if (!to) { status = 'erro'; error = 'Cliente sem número de WhatsApp.' }
  if (status === 'fila' && !tpl && !text) { status = 'erro'; error = 'Informe o texto da mensagem ou cadastre um modelo aprovado para esta finalidade.' }
  if (status === 'fila' && !tpl && windowKnown && !windowOpen) {
    status = 'erro'; error = `Fora da janela de 24 h (o cliente não escreveu para a loja nas últimas 24 horas). Cadastre um modelo aprovado para "${input.purpose}" em Integrações › WhatsApp.`
  }
  if (status === 'fila' && !(await whatsappReady(c, companyId))) { status = 'pendente_configuracao'; error = 'WhatsApp da empresa não configurado ou não ativado (Integrações › WhatsApp).' }
  const body = tpl ? renderTemplate(tpl.body, tpl.params) || `Modelo ${tpl.name}` : text
  const m = await c.one(
    `INSERT INTO messages(company_id, customer_id, purpose, template, template_params, to_address, body, ref_type, ref_id, status, error, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (company_id, purpose, customer_id, ref_type, ref_id) WHERE ref_id IS NOT NULL AND status NOT IN ('erro') DO NOTHING RETURNING *`,
    [companyId, cu.id, input.purpose, tpl?.name ?? null, tpl ? JSON.stringify(tpl.params) : null, to ?? null, body || null, input.refType ?? null, input.refId ?? null, status, error, ctx.user.id])
  if (!m) return { duplicate: true }
  if (status === 'fila' || status === 'pendente_configuracao') {
    await c.query(`INSERT INTO outbox(company_id, integration_id, topic, payload, dedupe_key, status) VALUES ($1,$2,'whatsapp.mensagem',$3,$4,$5)`,
      [companyId, integ?.id ?? null, JSON.stringify({ messageId: m.id, template: tpl ? { name: tpl.name, language: tpl.language, params: tpl.params } : null }), `msg:${m.id}`, status === 'fila' ? 'pendente' : 'aguardando_configuracao'])
  }
  return m
}

router.post('/api/messages', { perm: 'mensagens.enviar' }, async (ctx) => {
  const b: any = parse(v.object({ customerId: v.uuid(), purpose: v.enum(['atendimento', 'pos_venda', 'aniversario', 'cobranca', 'condicional', 'campanha', 'agendamento', 'retorno'] as const),
    body: v.string({ max: 1000 }).optional(), template: v.object({ name: v.string({ max: 100 }), params: v.array(v.string({ max: 200 })).optional() }).optional(),
    refType: v.string({ max: 40 }).optional(), refId: v.string({ max: 80 }).optional() }), ctx.body)
  if (!b.body && !b.template) throw unprocessable('Informe o texto ou o template da mensagem.')
  const m = await tx((c) => queueMessage(c, ctx, b))
  await audit(null, ctx, 'mensagem.enfileirada', 'customer', b.customerId, { purpose: b.purpose, status: (m as any).status })
  return m
})

router.post('/api/messages/bulk', { perm: 'mensagens.enviar' }, async (ctx) => {
  const b: any = parse(v.object({ customerIds: v.array(v.uuid(), { min: 1, max: 1000 }), purpose: v.enum(['pos_venda', 'aniversario', 'cobranca', 'condicional', 'campanha', 'retorno'] as const),
    body: v.string({ max: 1000 }).optional(), template: v.object({ name: v.string(), params: v.array(v.string()).optional() }).optional(), refId: v.string({ max: 80 }) }), ctx.body)
  const result: Record<string, number> = {}
  for (const id of b.customerIds) {
    const m: any = await tx((c) => queueMessage(c, ctx, { customerId: id, purpose: b.purpose, body: b.body, template: b.template, refType: b.purpose, refId: b.refId }))
    const k = m.duplicate ? 'duplicada' : m.status
    result[k] = (result[k] || 0) + 1
  }
  await audit(null, ctx, 'mensagem.lote', 'messages', null, { purpose: b.purpose, total: b.customerIds.length, result })
  return result
})

router.get('/api/messages', { perm: ['mensagens.enviar', 'integracoes.ver'] }, async (ctx) => {
  const w = new Where([['m.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.status, 'm.status = ?', ctx.query.status).addIf(ctx.query.purpose, 'm.purpose = ?', ctx.query.purpose).addIf(ctx.query.customer, 'm.customer_id = ?', ctx.query.customer)
  return paged(db, `SELECT m.*, c.name AS customer FROM messages m LEFT JOIN customers c ON c.id = m.customer_id ${w.sql} ORDER BY m.created_at DESC`, w.params, ctx.query, 50)
})
