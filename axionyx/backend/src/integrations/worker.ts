import { db, tx } from '../core/db'
import { whatsapp, ecommerce, NotConfiguredError } from './adapters'
import { sha256 } from '../core/crypto'
import { expireCashback } from '../services/loyalty'
import { whatsappReady } from '../services/whatsapp'
import { runBilling } from '../services/billing'

/**
 * Worker da outbox: entrega eventos às integrações com retentativas exponenciais e registro em log.
 * Também executa rotinas periódicas (expiração de cashback, expiração de orçamentos).
 */
let timer: NodeJS.Timeout | null = null
let running = false
let lastHousekeeping = 0
let lastBilling = 0

async function log(companyId: string, integrationId: string | null, topic: string, status: string, message: string, request?: unknown, response?: unknown) {
  await db.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message, request, response) VALUES ($1,$2,'saida',$3,$4,$5,$6,$7)`,
    [companyId, integrationId, topic, status, message.slice(0, 1000), request ? JSON.stringify(request) : null, response ? JSON.stringify(response) : null])
}

async function deliver(ev: any) {
  switch (ev.topic) {
    case 'whatsapp.mensagem': {
      const m = await db.one(`SELECT * FROM messages WHERE id = $1`, [ev.payload.messageId])
      if (!m || ['enviado', 'entregue', 'lido'].includes(m.status)) return { skipped: true }
      const creds = await whatsappReady(db, ev.company_id)
      if (!creds) throw new NotConfiguredError('WhatsApp da empresa')
      const r = await whatsapp.send(creds, m.to_address, ev.payload.template ? { template: ev.payload.template } : { text: m.body })
      await db.query(`UPDATE messages SET status = 'enviado', provider_message_id = $2, sent_at = now(), error = NULL WHERE id = $1`, [m.id, r.id ?? null])
      return { id: r.id }
    }
    case 'ecommerce.estoque': {
      const v = await db.one(`SELECT v.sku, COALESCE(sum(sb.qty),0)::float8 AS qty FROM product_variants v LEFT JOIN stock_balances sb ON sb.variant_id = v.id WHERE v.id = $1 GROUP BY v.sku`, [ev.payload.variantId])
      if (!v) return { skipped: true }
      await ecommerce.updateStock(v.sku, Math.max(0, v.qty))
      return { sku: v.sku, qty: v.qty }
    }
    case 'ecommerce.produto': {
      const p = await db.one(`SELECT id, code, name, description, sale_price, active, company_id FROM products WHERE id = $1`, [ev.payload.productId])
      if (!p) return { skipped: true }
      const variants = await db.many(`SELECT v.id, v.sku, v.barcode, sz.code AS size, co.name AS color, COALESCE(v.sale_price, $2) AS price, COALESCE((SELECT sum(qty) FROM stock_balances WHERE variant_id = v.id),0)::int AS stock
                                        FROM product_variants v LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id WHERE v.product_id = $1 AND v.active`, [p.id, p.sale_price])
      const payload = { reference: p.code, name: p.name, description: p.description, price: Number(p.sale_price), active: p.active, variants }
      const hash = sha256(JSON.stringify(payload))
      const ext = await db.one(`SELECT external_id, payload_hash FROM external_ids WHERE integration_id = $1 AND entity = 'produto' AND local_id = $2`, [ev.integration_id, p.id])
      if (ext?.payload_hash === hash) return { unchanged: true }
      const r = await ecommerce.upsertProduct(payload, ext?.external_id)
      const externalId = String(r?.id ?? ext?.external_id ?? p.code)
      await db.query(`INSERT INTO external_ids(company_id, integration_id, entity, local_id, external_id, payload_hash) VALUES ($1,$2,'produto',$3,$4,$5)
                      ON CONFLICT (integration_id, entity, local_id) DO UPDATE SET external_id = EXCLUDED.external_id, payload_hash = EXCLUDED.payload_hash, synced_at = now()`,
        [p.company_id, ev.integration_id, p.id, externalId, hash])
      return { externalId }
    }
    default:
      throw new Error(`Tópico desconhecido: ${ev.topic}`)
  }
}

export async function processOutbox(limit = 20) {
  if (running) return 0
  running = true
  let processed = 0
  try {
    const events = await tx(async (c) => {
      const rows = await c.many(`SELECT * FROM outbox WHERE status IN ('pendente','erro') AND next_attempt_at <= now() AND attempts < 8 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])
      if (rows.length) await c.query(`UPDATE outbox SET status = 'processando' WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)])
      return rows
    })
    for (const ev of events) {
      try {
        const res = await deliver(ev)
        await db.query(`UPDATE outbox SET status = 'enviado', attempts = attempts + 1, processed_at = now(), last_error = NULL WHERE id = $1`, [ev.id])
        await log(ev.company_id, ev.integration_id, ev.topic, 'sucesso', 'Entregue', ev.payload, res)
        processed++
      } catch (e: any) {
        if (e instanceof NotConfiguredError) {
          await db.query(`UPDATE outbox SET status = 'aguardando_configuracao', last_error = $2 WHERE id = $1`, [ev.id, e.message])
          if (ev.topic === 'whatsapp.mensagem') await db.query(`UPDATE messages SET status = 'pendente_configuracao', error = $2 WHERE id = $1`, [ev.payload.messageId, e.message])
          await log(ev.company_id, ev.integration_id, ev.topic, 'pendente_configuracao', e.message, ev.payload)
          continue
        }
        const attempts = ev.attempts + 1
        const delayMin = Math.min(240, 2 ** attempts)
        const final = attempts >= 8 || e.retryable === false
        await db.query(`UPDATE outbox SET status = 'erro', attempts = $2, next_attempt_at = now() + ($3 || ' minutes')::interval, last_error = $4 WHERE id = $1`,
          [ev.id, final ? 8 : attempts, String(delayMin), String(e.message).slice(0, 500)])
        if (ev.topic === 'whatsapp.mensagem' && final) await db.query(`UPDATE messages SET status = 'erro', error = $2 WHERE id = $1`, [ev.payload.messageId, String(e.message).slice(0, 300)])
        if (ev.integration_id) await db.query(`UPDATE integrations SET last_error = $2, updated_at = now() WHERE id = $1`, [ev.integration_id, String(e.message).slice(0, 300)])
        await log(ev.company_id, ev.integration_id, ev.topic, 'erro', `Tentativa ${attempts}: ${e.message}`, ev.payload)
      }
    }
  } finally { running = false }
  return processed
}

async function housekeeping() {
  if (Date.now() - lastHousekeeping < 60 * 60_000) return
  lastHousekeeping = Date.now()
  try {
    await tx((c) => expireCashback(c))
    await db.query(`UPDATE sales SET status = 'orcamento_expirado' WHERE type = 'orcamento' AND status = 'orcamento' AND valid_until < current_date`)
    await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`)
    await db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`)
  } catch (e: any) { console.error('[worker] rotina periódica falhou:', e.message) }
}

/** Régua de cobrança das assinaturas AXIONYX: a cada hora (e 1 min após iniciar). */
async function billing() {
  if (lastBilling === 0) { lastBilling = Date.now() - 59 * 60_000; return }
  if (Date.now() - lastBilling < 60 * 60_000) return
  lastBilling = Date.now()
  try {
    const r = await runBilling()
    if (r.errors.length) await db.query(`INSERT INTO system_events(level, source, message, data) VALUES ('warning','billing',$1,$2)`, [`Rotina de cobrança com ${r.errors.length} erro(s)`, JSON.stringify(r)])
  } catch (e: any) { console.error('[worker] rotina de cobrança falhou:', e.message) }
}

export function startWorker(intervalMs = 5000) {
  if (timer) return
  timer = setInterval(() => { processOutbox().catch((e) => console.error('[worker]', e.message)); housekeeping(); billing() }, intervalMs)
  timer.unref()
}
export function stopWorker() { if (timer) clearInterval(timer); timer = null }
