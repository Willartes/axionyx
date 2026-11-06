import { Q } from '../core/db'
import { decryptSecret } from '../core/crypto'
import { whatsapp, WaCreds } from '../integrations/adapters'
import { loyaltyBalance } from './loyalty'

const brlText = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n || 0)
const dateText = (d: any) => { const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); const [y, m, dd] = s.split('-'); return `${dd}/${m}/${y}` }

/** Dados do sistema que podem preencher as variáveis {{1}}, {{2}}... de um modelo aprovado. */
export const TEMPLATE_FIELDS: Record<string, string> = {
  nome: 'Primeiro nome do cliente', nome_completo: 'Nome completo do cliente', loja: 'Nome da loja (fantasia)', telefone_loja: 'WhatsApp da loja',
  valor: 'Valor em aberto (cobrança)', vencimento: 'Vencimento (cobrança: mais antigo; condicional: data de devolução)', parcelas: 'Quantidade de parcelas em aberto',
  numero: 'Número do condicional', pecas: 'Quantidade de peças do condicional', cashback: 'Saldo de cashback', texto: 'Texto livre digitado na tela',
  data: 'Data do agendamento', hora: 'Horário do agendamento', profissional: 'Profissional do agendamento', servico: 'Serviço(s) do agendamento / último serviço (retorno)',
}
export const PURPOSES = ['pos_venda', 'aniversario', 'cobranca', 'condicional', 'campanha', 'atendimento', 'agendamento', 'retorno'] as const

export interface CompanyWa extends WaCreds {
  integrationId: string | null; source: 'empresa' | 'servidor'; status: string; displayPhone?: string; verifiedName?: string; wabaId?: string; appSecret?: string | null
}

/** Credenciais do WhatsApp da empresa: as cadastradas na tela (prioridade) ou as globais do servidor. */
export async function companyWhatsapp(c: Q, companyId: string): Promise<CompanyWa | null> {
  const i = await c.one(`SELECT id, status, config, secret_enc FROM integrations WHERE company_id = $1 AND kind = 'whatsapp' ORDER BY created_at LIMIT 1`, [companyId])
  if (i?.secret_enc && i.config?.phoneNumberId) {
    let sec: any = null
    try { sec = JSON.parse(decryptSecret(i.secret_enc) || 'null') } catch { sec = null }
    if (sec?.accessToken) return { integrationId: i.id, source: 'empresa', status: i.status, phoneNumberId: i.config.phoneNumberId, token: sec.accessToken, appSecret: sec.appSecret ?? null,
      displayPhone: i.config.displayPhone, verifiedName: i.config.verifiedName, wabaId: i.config.wabaId }
  }
  const env = whatsapp.envCreds()
  if (env) return { ...env, integrationId: i?.id ?? null, source: 'servidor', status: i?.status ?? 'ativo', appSecret: process.env.WHATSAPP_APP_SECRET?.trim() || null }
  return null
}

/** Pronta para enviar: credenciais presentes e integração ativa. */
export async function whatsappReady(c: Q, companyId: string) {
  const w = await companyWhatsapp(c, companyId)
  return w && (w.source === 'servidor' || w.status === 'ativo') ? w : null
}

export const onlyPhone = (s: string | null | undefined) => (s || '').replace(/\D/g, '')
/** Compara telefones ignorando DDI 55 e o 9º dígito (a Meta às vezes devolve sem ele). */
export function samePhone(a: string, b: string) {
  const norm = (x: string) => { let d = onlyPhone(x); if (d.startsWith('55') && d.length >= 12) d = d.slice(2); return d.length === 11 ? d.slice(0, 2) + d.slice(3) : d }
  return !!a && !!b && norm(a) === norm(b)
}

/** Calcula as variáveis disponíveis para um cliente e uma finalidade. */
export async function templateVars(c: Q, companyId: string, customer: any, purpose: string, refType?: string | null, refId?: string | null, text?: string | null) {
  const co = await c.one(`SELECT name, trade_name FROM companies WHERE id = $1`, [companyId])
  const integ = await c.one(`SELECT config FROM integrations WHERE company_id = $1 AND kind = 'whatsapp' LIMIT 1`, [companyId])
  const vars: Record<string, string> = {
    nome: String(customer.name || '').split(' ')[0], nome_completo: customer.name || '', loja: co?.trade_name || co?.name || '', telefone_loja: integ?.config?.displayPhone || '', texto: text || '',
  }
  if (purpose === 'cobranca') {
    const r = await c.one(`SELECT COALESCE(sum(amount - paid_amount),0) AS bal, min(due_date) AS due, count(*)::int AS n FROM receivables
                            WHERE company_id = $1 AND customer_id = $2 AND status IN ('aberto','parcial') AND due_date <= current_date + 3`, [companyId, customer.id])
    vars.valor = brlText(Number(r?.bal ?? 0)); vars.vencimento = r?.due ? dateText(r.due) : ''; vars.parcelas = String(r?.n ?? 0)
  }
  if (purpose === 'condicional' || refType === 'conditional') {
    const id = String(refId || '').split(':')[0]
    const k = /^[0-9a-f-]{36}$/i.test(id) ? await c.one(`SELECT k.number, k.due_date, (SELECT COALESCE(sum(qty_sent - qty_returned - qty_sold),0)::int FROM conditional_items WHERE conditional_id = k.id) AS pecas
                                                        FROM conditionals k WHERE k.id = $1 AND k.company_id = $2`, [id, companyId]) : null
    if (k) { vars.numero = String(k.number); vars.vencimento = dateText(k.due_date); vars.pecas = String(k.pecas) }
  }
  if (refType === 'appointment' && /^[0-9a-f-]{36}$/i.test(String(refId || ''))) {
    const ap = await c.one(`SELECT to_char(a.start_at AT TIME ZONE COALESCE(co.settings->'agenda'->>'fusoHorario', 'America/Sao_Paulo'), 'DD/MM/YYYY') AS data,
                                   to_char(a.start_at AT TIME ZONE COALESCE(co.settings->'agenda'->>'fusoHorario', 'America/Sao_Paulo'), 'HH24:MI') AS hora, pr.name AS profissional,
                                   (SELECT string_agg(p.name, ', ' ORDER BY s.sort) FROM appointment_services s JOIN products p ON p.id = s.product_id WHERE s.appointment_id = a.id) AS servico
                              FROM appointments a JOIN professionals pr ON pr.id = a.professional_id JOIN companies co ON co.id = a.company_id WHERE a.id = $1 AND a.company_id = $2`, [refId, companyId])
    if (ap) Object.assign(vars, { data: ap.data, hora: ap.hora, profissional: ap.profissional, servico: ap.servico || '' })
  }
  if (purpose === 'retorno') {
    const last = await c.one(`SELECT p.name FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                               WHERE s.company_id = $1 AND s.customer_id = $2 AND s.status <> 'cancelada' AND p.kind = 'servico' ORDER BY s.created_at DESC LIMIT 1`, [companyId, customer.id])
    if (last && !vars.servico) vars.servico = last.name
  }
  vars.cashback = brlText(await loyaltyBalance(c, companyId, customer.id))
  return vars
}

/** Monta o texto do modelo trocando {{n}} pelos valores (para o histórico). */
export function renderTemplate(body: string | null, params: string[]) {
  return (body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? `{{${n}}}`)
}
export function countPlaceholders(body: string | null) {
  const nums = [...(body || '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
  return nums.length ? Math.max(...nums) : 0
}

/** Processa o corpo de um webhook da Meta (mensagens recebidas e status das enviadas). */
export async function processWebhook(c: Q, companyId: string, integrationId: string, payload: any, phoneNumberId?: string) {
  const out = { received: 0, statuses: 0, ignored: 0 }
  for (const entry of payload?.entry ?? []) for (const ch of entry?.changes ?? []) {
    const val = ch?.value ?? {}
    if (phoneNumberId && val?.metadata?.phone_number_id && String(val.metadata.phone_number_id) !== String(phoneNumberId)) { out.ignored++; continue }
    for (const m of val.messages ?? []) {
      const from = onlyPhone(m.from)
      const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? `[${m.type || 'mensagem'}]`
      const custs = await c.many(`SELECT id, whatsapp, phone FROM customers WHERE company_id = $1 AND anonymized_at IS NULL AND (whatsapp IS NOT NULL OR phone IS NOT NULL)
                                   AND right(regexp_replace(COALESCE(whatsapp, phone), '\\D', '', 'g'), 8) = right($2, 8)`, [companyId, from])
      const cust = custs.find((x) => samePhone(x.whatsapp || x.phone, from))
      const dup = await c.one(`SELECT 1 FROM messages WHERE company_id = $1 AND provider_message_id = $2`, [companyId, m.id])
      if (dup) continue
      await c.query(`INSERT INTO messages(company_id, customer_id, purpose, to_address, body, status, provider_message_id, direction, sent_at)
                     VALUES ($1,$2,'atendimento',$3,$4,'recebido',$5,'entrada', to_timestamp($6))`, [companyId, cust?.id ?? null, from, String(text).slice(0, 4000), m.id, Number(m.timestamp) || Date.now() / 1000])
      if (cust) await c.query(`UPDATE customers SET whatsapp_last_inbound_at = GREATEST(COALESCE(whatsapp_last_inbound_at, 'epoch'), to_timestamp($2)) WHERE id = $1`, [cust.id, Number(m.timestamp) || Date.now() / 1000])
      out.received++
    }
    for (const s of val.statuses ?? []) {
      const map: Record<string, string> = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'erro' }
      const st = map[s.status]; if (!st) continue
      const err = s.errors?.[0] ? `${s.errors[0].code ?? ''} ${s.errors[0].title ?? ''} ${s.errors[0].error_data?.details ?? ''}`.trim() : null
      // não regride status (lido > entregue > enviado), exceto falha
      await c.query(`UPDATE messages SET status = CASE WHEN $3 = 'erro' THEN 'erro'
                                                       WHEN status = 'lido' THEN status WHEN status = 'entregue' AND $3 = 'enviado' THEN status ELSE $3 END,
                                         error = COALESCE($4, error), delivered_at = CASE WHEN $3 IN ('entregue','lido') THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
                                         read_at = CASE WHEN $3 = 'lido' THEN now() ELSE read_at END
                      WHERE company_id = $1 AND provider_message_id = $2 AND direction = 'saida'`, [companyId, s.id, st, err])
      out.statuses++
    }
  }
  await c.query(`INSERT INTO integration_logs(company_id, integration_id, direction, topic, status, message) VALUES ($1,$2,'entrada','whatsapp.webhook','sucesso',$3)`,
    [companyId, integrationId, `Recebidas: ${out.received} · status: ${out.statuses}${out.ignored ? ' · ignoradas: ' + out.ignored : ''}`])
  return out
}
