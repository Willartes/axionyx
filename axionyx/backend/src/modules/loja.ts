import { router, audit, rateLimit } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse } from '../core/validate'
import { unprocessable } from '../core/errors'
import { encryptSecret } from '../core/crypto'
import { ecommerce, assertStoreUrl, StoreUrlError } from '../integrations/adapters'
import { storeIntegration, storeSecrets } from '../services/ecommerce'
import { ecommerceWebhookSecret } from './integracoes'

/**
 * Loja virtual por empresa: o administrador da empresa (ou a equipe da plataforma dentro da empresa) cadastra o
 * endereço da API e o token da loja. O token fica cifrado no banco e nunca volta para o navegador.
 */
function publicBase(ctx: any) {
  const proto = String(ctx.req.headers['x-forwarded-proto'] || '').split(',')[0] || 'https'
  const host = String(ctx.req.headers['x-forwarded-host'] || ctx.req.headers.host || '')
  return `${host.startsWith('localhost') || host.startsWith('127.') ? 'http' : proto}://${host}`
}
async function view(i: any, ctx: any) {
  const s = storeSecrets(i)
  const branches = await db.many(`SELECT id, code, name FROM branches WHERE company_id = $1 AND active ORDER BY code`, [i.company_id])
  return {
    integrationId: i.id, status: i.status, lastError: i.last_error, lastSyncAt: i.last_sync_at,
    url: i.config.url ?? '', branchId: i.config.branchId ?? '', hasToken: !!s.token, tokenHint: s.token ? '••••' + s.token.slice(-4) : null,
    testedAt: i.config.testedAt ?? null, testResult: i.config.testResult ?? null, branches,
    webhookUrl: `${publicBase(ctx)}/api/webhooks/ecommerce/${i.id}`, webhookSecretAvailable: !!ecommerceWebhookSecret(i.id),
  }
}

router.get('/api/ecommerce/config', { perm: 'integracoes.ver' }, async (ctx) => view(await storeIntegration(db, ctx.user.companyId), ctx))

router.put('/api/ecommerce/config', { perm: 'integracoes.editar' }, async (ctx) => {
  const b: any = parse(v.object({ url: v.string({ min: 10, max: 300 }), token: v.string({ min: 8, max: 2000 }).optional(), branchId: v.uuid().optional().nullable() }), ctx.body)
  let url: string
  try { url = await assertStoreUrl(b.url) } catch (e: any) { throw unprocessable(e instanceof StoreUrlError ? e.message : 'Endereço inválido.') }
  if (b.branchId && !(await db.one(`SELECT 1 FROM branches WHERE id = $1 AND company_id = $2 AND active`, [b.branchId, ctx.user.companyId]))) throw unprocessable('Filial inválida.')
  return tx(async (c) => {
    const i = await storeIntegration(c, ctx.user.companyId, true)
    const s = storeSecrets(i)
    if (b.token) s.token = b.token.trim()
    if (!s.token) throw unprocessable('Informe o token de acesso da API da loja.')
    const changed = !!b.token || i.config.url !== url
    const config = { ...i.config, url, branchId: b.branchId || null, ...(changed ? { testedAt: null, testResult: null } : {}) }
    // credencial nova exige novo teste antes de enviar qualquer coisa
    const status = changed ? 'pendente_configuracao' : i.status
    const r = await c.one(`UPDATE integrations SET config = $2, secret_enc = $3, status = $4, last_error = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [i.id, JSON.stringify(config), encryptSecret(JSON.stringify(s)), status])
    await audit(c, ctx, 'loja_virtual.configurada', 'integration', i.id, { url, branchId: b.branchId || null, tokenAlterado: !!b.token }, 'warning')
    return view(r, ctx)
  })
})

/** Testa a conexão (GET /health da loja). Respondeu → ativa e libera os eventos que aguardavam configuração. */
router.post('/api/ecommerce/test', { perm: 'integracoes.editar' }, async (ctx) => {
  rateLimit('loja-teste:' + ctx.user.companyId, 20, 10 * 60_000)
  const i = await storeIntegration(db, ctx.user.companyId)
  const s = storeSecrets(i)
  if (!i.config.url || !s.token) throw unprocessable('Salve o endereço e o token da loja antes de testar.')
  let result: 'ok' | 'sem_health'
  try { await ecommerce.health({ url: i.config.url, token: s.token }); result = 'ok' }
  catch (e: any) {
    if (e.status === 404) result = 'sem_health'
    else {
      const msg = e instanceof StoreUrlError ? e.message
        : e.status === 401 || e.status === 403 ? `A loja recusou o token (HTTP ${e.status}). Confira o token de acesso da API.`
        : e.status >= 300 && e.status < 400 ? `A loja respondeu com redirecionamento (HTTP ${e.status}). Informe o endereço final da API.`
        : e.status ? `A loja respondeu com erro (HTTP ${e.status}). Tente de novo em instantes ou fale com o suporte da loja.`
        : `A loja não respondeu (${String(e.message).slice(0, 120)}). Confira o endereço.`
      await db.query(`UPDATE integrations SET status = 'erro', last_error = $2, updated_at = now() WHERE id = $1`, [i.id, msg.slice(0, 300)])
      await db.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message) VALUES ($1,$2,'saida','ecommerce.teste','erro',$3)`, [i.company_id, i.id, msg])
      throw unprocessable(msg)
    }
  }
  return tx(async (c) => {
    const config = { ...i.config, testedAt: new Date().toISOString(), testResult: result }
    const row = await c.one(`UPDATE integrations SET status = 'ativo', last_error = NULL, config = $2, updated_at = now() WHERE id = $1 RETURNING *`, [i.id, JSON.stringify(config)])
    const rel = await c.query(`UPDATE outbox SET status = 'pendente', next_attempt_at = now() WHERE integration_id = $1 AND status = 'aguardando_configuracao'`, [i.id])
    const message = result === 'ok' ? 'Conexão confirmada' : 'A loja não tem /health: endereço alcançado, token não confirmado (acompanhe o primeiro envio no log)'
    await c.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message) VALUES ($1,$2,'saida','ecommerce.teste','sucesso',$3)`, [i.company_id, i.id, message])
    await audit(c, ctx, 'loja_virtual.ativada', 'integration', i.id, { result, liberados: rel.rowCount }, 'warning')
    return { ...(await view(row, ctx)), released: rel.rowCount, message }
  })
})

router.post('/api/ecommerce/deactivate', { perm: 'integracoes.editar' }, async (ctx) => {
  const i = await storeIntegration(db, ctx.user.companyId)
  const r = await db.one(`UPDATE integrations SET status = 'desativado', updated_at = now() WHERE id = $1 RETURNING *`, [i.id])
  await audit(null, ctx, 'loja_virtual.desativada', 'integration', i.id, null, 'warning')
  return view(r, ctx)
})

/** Remove endereço e token (ex.: troca de plataforma da loja). Os vínculos de produtos já enviados ficam guardados. */
router.delete('/api/ecommerce/config', { perm: 'integracoes.editar' }, async (ctx) => {
  const i = await storeIntegration(db, ctx.user.companyId)
  const config = { ...i.config }; delete config.url; delete config.testedAt; delete config.testResult
  const r = await db.one(`UPDATE integrations SET status = 'pendente_configuracao', secret_enc = NULL, config = $2, updated_at = now() WHERE id = $1 RETURNING *`, [i.id, JSON.stringify(config)])
  await audit(null, ctx, 'loja_virtual.credenciais_removidas', 'integration', i.id, null, 'warning')
  return view(r, ctx)
})
