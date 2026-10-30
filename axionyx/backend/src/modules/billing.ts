import { sendActivation, inviteOrFallback, unusablePasswordHash } from '../services/activation'
import { resolveDelivery } from './admin'
import { rateLimit, router, audit, paged, Where, Ctx, today, addMonths, r2 } from '../core/http'
import { db, tx } from '../core/db'
import { v, parse, onlyDigits, isValidCNPJ, isValidCPF } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden, HttpError } from '../core/errors'
import { hashPassword, randomCode } from '../core/crypto'
import { bootstrapCompany } from '../services/bootstrap'
import { mercadopago, verifyWebhookSignature } from '../integrations/mercadopago'
import { secret } from '../config'
import { requirePlatform } from '../core/platform'
import {
  assessRisk, setStatus, openReview, autoResolve, createCharge, ensureCheckout, applyApproved, processGatewayEvent, runBilling,
  billingSummary, webhookUrl, publicUrl, clientBackUrl, ACTIVE_STATUSES,
} from '../services/billing'

/** Rotas da carteira de clientes do AXIONYX — exclusivas do superadministrador da plataforma. */
function sa(ctx: Ctx, perm = 'carteira.ver') { requirePlatform(ctx, perm) }
const SA = { perm: 'admin.empresas' }
const SEGMENTS = ['moda', 'hortifruti', 'adega', 'mercado', 'cosmeticos', 'odontologia', 'estetica', 'salao', 'oficina', 'saude', 'geral'] as const
const MODES = ['assinatura_cartao', 'link_mensal', 'manual'] as const
const address = v.object({ cep: v.string().optional(), logradouro: v.string().optional(), numero: v.string().optional(), complemento: v.string().optional(),
  bairro: v.string().optional(), cidade: v.string().optional(), uf: v.string({ max: 2 }).optional(), codigoMunicipio: v.string({ max: 7 }).optional() }).optional()

async function getContract(id: string) {
  const k = await db.one(`SELECT * FROM saas_contracts WHERE id = $1`, [id])
  if (!k) throw notFound('Contrato')
  return k
}
const who = (ctx: Ctx) => ({ userId: ctx.user.id, userName: ctx.user.name })

// =====================================================================  Painel da carteira
router.get('/api/saas/dashboard', SA, async (ctx) => {
  sa(ctx)
  const k = await db.one(`SELECT
      count(*) FILTER (WHERE status IN ('ativo','inadimplente'))::int AS active,
      count(*) FILTER (WHERE status = 'ativo')::int AS ok,
      count(*) FILTER (WHERE status = 'inadimplente')::int AS overdue,
      count(*) FILTER (WHERE status = 'suspenso')::int AS suspended,
      count(*) FILTER (WHERE status = 'cancelado')::int AS cancelled,
      count(*) FILTER (WHERE status = 'em_analise')::int AS in_review,
      count(*) FILTER (WHERE status = 'aguardando_pagamento')::int AS awaiting,
      COALESCE(sum(price) FILTER (WHERE status IN ('ativo','inadimplente')),0)::float8 AS mrr,
      COALESCE(sum(price) FILTER (WHERE status = 'aguardando_pagamento'),0)::float8 AS mrr_pipeline
    FROM saas_contracts`)
  const month = await db.one(`SELECT
      COALESCE(sum(paid_amount) FILTER (WHERE status = 'paga' AND paid_at >= date_trunc('month', now())),0)::float8 AS received,
      COALESCE(sum(fee_amount) FILTER (WHERE status = 'paga' AND paid_at >= date_trunc('month', now())),0)::float8 AS fees,
      COALESCE(sum(amount) FILTER (WHERE status = 'pendente' AND due_date >= current_date AND due_date < date_trunc('month', now()) + interval '1 month'),0)::float8 AS to_receive,
      COALESCE(sum(amount) FILTER (WHERE status = 'pendente' AND due_date < current_date),0)::float8 AS overdue_amount,
      COALESCE(sum(paid_amount) FILTER (WHERE status = 'paga' AND paid_at >= date_trunc('year', now())),0)::float8 AS received_year,
      COALESCE(sum(paid_amount) FILTER (WHERE status = 'paga'),0)::float8 AS received_total,
      COALESCE(sum(paid_amount) FILTER (WHERE status IN ('estornada','contestada')),0)::float8 AS lost
    FROM saas_charges`)
  const flow = await db.one(`SELECT
      count(*) FILTER (WHERE to_status = 'ativo' AND from_status = 'aguardando_pagamento' AND created_at >= date_trunc('month', now()))::int AS new_month,
      count(*) FILTER (WHERE to_status = 'cancelado' AND created_at >= date_trunc('month', now()))::int AS churn_month
    FROM saas_contract_events`)
  const startActive = await db.one(`SELECT count(*)::int AS n FROM saas_contracts k CROSS JOIN LATERAL (SELECT to_status FROM saas_contract_events e WHERE e.contract_id = k.id AND e.created_at < date_trunc('month', now()) ORDER BY e.created_at DESC, e.id DESC LIMIT 1) e WHERE e.to_status IN ('ativo','inadimplente')`)
  const series = await db.many(`WITH months AS (SELECT generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), interval '1 month')::date AS m)
    SELECT to_char(m, 'YYYY-MM') AS month,
      (SELECT COALESCE(sum(e.price),0) FROM saas_contracts k CROSS JOIN LATERAL (SELECT to_status, price FROM saas_contract_events ev WHERE ev.contract_id = k.id AND ev.created_at < (m + interval '1 month') ORDER BY ev.created_at DESC, ev.id DESC LIMIT 1) e WHERE e.to_status IN ('ativo','inadimplente'))::float8 AS mrr,
      (SELECT count(*) FROM saas_contracts k CROSS JOIN LATERAL (SELECT to_status FROM saas_contract_events ev WHERE ev.contract_id = k.id AND ev.created_at < (m + interval '1 month') ORDER BY ev.created_at DESC, ev.id DESC LIMIT 1) e WHERE e.to_status IN ('ativo','inadimplente'))::int AS clients,
      (SELECT COALESCE(sum(paid_amount),0) FROM saas_charges WHERE status = 'paga' AND paid_at >= m AND paid_at < m + interval '1 month')::float8 AS received
    FROM months ORDER BY m`)
  const byPlan = await db.many(`SELECT COALESCE(p.name, 'Sem plano') AS label, count(*)::int AS clients, sum(k.price)::float8 AS value FROM saas_contracts k LEFT JOIN saas_plans p ON p.id = k.plan_id WHERE k.status IN ('ativo','inadimplente') GROUP BY 1 ORDER BY value DESC`)
  const bySegment = await db.many(`SELECT k.segment AS label, count(*)::int AS clients, sum(k.price)::float8 AS value FROM saas_contracts k WHERE k.status IN ('ativo','inadimplente') GROUP BY 1 ORDER BY value DESC`)
  const byMethod = await db.many(`SELECT COALESCE(method, 'outro') AS label, count(*)::int AS n, sum(paid_amount)::float8 AS value FROM saas_charges WHERE status = 'paga' AND paid_at > now() - interval '12 months' GROUP BY 1 ORDER BY value DESC`)
  const upcoming = await db.many(`SELECT ch.id, ch.amount, ch.due_date, ch.status, ch.checkout_url, k.id AS contract_id, k.company_name, k.trade_name, k.billing_mode, k.status AS contract_status
                                    FROM saas_charges ch JOIN saas_contracts k ON k.id = ch.contract_id WHERE ch.status = 'pendente' AND ch.due_date <= current_date + 15 ORDER BY ch.due_date LIMIT 20`)
  const reviews = await db.one(`SELECT count(*)::int AS open, count(*) FILTER (WHERE severity = 'alta')::int AS high FROM saas_reviews WHERE status = 'aberta'`)
  const leads = await db.one(`SELECT count(*) FILTER (WHERE status = 'novo')::int AS new, count(*) FILTER (WHERE status = 'em_contato')::int AS contacting FROM site_leads`)
  const legacy = await db.one(`SELECT count(*)::int AS n FROM companies c WHERE NOT c.is_demo AND c.active AND NOT EXISTS (SELECT 1 FROM saas_contracts k WHERE k.company_id = c.id)`)
  const churnPct = startActive.n ? r2((flow.churn_month / startActive.n) * 100) : 0
  return {
    kpis: { ...k, ...month, ...flow, arr: r2(k.mrr * 12), ticket: k.active ? r2(k.mrr / k.active) : 0, churnPct, activeAtMonthStart: startActive.n,
      netMonth: r2(month.received - month.fees), delinquencyPct: k.mrr ? r2((month.overdue_amount / k.mrr) * 100) : 0 },
    series, byPlan, bySegment, byMethod, upcoming, reviews, leads, legacyCompanies: legacy.n,
    gateway: { configured: mercadopago().configured(), webhookSecret: !!secret('MP_WEBHOOK_SECRET'), publicUrl: !!publicUrl() },
  }
})

// =====================================================================  Planos
router.get('/api/saas/plans', SA, async (ctx) => {
  sa(ctx)
  return db.many(`SELECT p.*, (SELECT count(*)::int FROM saas_contracts k WHERE k.plan_id = p.id AND k.status IN ('ativo','inadimplente')) AS clients FROM saas_plans p ORDER BY p.active DESC, p.price_monthly`)
})
const planSchema = { name: v.string({ min: 2, max: 60 }), description: v.string({ max: 500 }).optional(), priceMonthly: v.money({ min: 0 }), maxUsers: v.int({ min: 1, max: 10000 }).optional(), maxBranches: v.int({ min: 1, max: 1000 }).optional(), active: v.boolean().default(true) }
router.post('/api/saas/plans', SA, async (ctx) => {
  sa(ctx, 'carteira.configurar')
  const b = parse(v.object(planSchema), ctx.body)
  const r = await db.one(`INSERT INTO saas_plans(name, description, price_monthly, max_users, max_branches, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [b.name, b.description ?? null, b.priceMonthly, b.maxUsers ?? null, b.maxBranches ?? null, b.active])
  await audit(null, ctx, 'saas.plano_criado', 'saas_plan', r.id, b)
  return r
})
router.put('/api/saas/plans/:id', SA, async (ctx) => {
  sa(ctx, 'carteira.configurar')
  const b = parse(v.object(planSchema), ctx.body)
  const r = await db.one(`UPDATE saas_plans SET name = $2, description = $3, price_monthly = $4, max_users = $5, max_branches = $6, active = $7, updated_at = now() WHERE id = $1 RETURNING *`,
    [ctx.params.id, b.name, b.description ?? null, b.priceMonthly, b.maxUsers ?? null, b.maxBranches ?? null, b.active])
  if (!r) throw notFound('Plano')
  await audit(null, ctx, 'saas.plano_alterado', 'saas_plan', r.id, b)
  return r
})

// =====================================================================  Contratos (clientes)
router.get('/api/saas/contracts', SA, async (ctx) => {
  sa(ctx)
  const w = new Where()
  w.addIf(ctx.query.status, 'k.status = ?', ctx.query.status)
  w.addIf(ctx.query.plan, 'k.plan_id = ?', ctx.query.plan)
  w.addIf(ctx.query.segment, 'k.segment = ?', ctx.query.segment)
  if (ctx.query.q) w.add(`(k.company_name ILIKE ? OR k.trade_name ILIKE ? OR k.cnpj LIKE ? OR k.contact_name ILIKE ? OR k.contact_email ILIKE ?)`, `%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${onlyDigits(ctx.query.q) || ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`)
  return paged(db, `SELECT k.id, k.number, k.status, k.company_id, k.company_name, k.trade_name, k.cnpj, k.segment, k.contact_name, k.contact_email, k.contact_phone, k.price, k.billing_mode,
                           k.paid_until, k.started_at, k.risk_level, k.created_at, p.name AS plan_name,
                           (SELECT count(*)::int FROM saas_reviews r WHERE r.contract_id = k.id AND r.status = 'aberta') AS open_reviews,
                           (SELECT min(due_date) FROM saas_charges ch WHERE ch.contract_id = k.id AND ch.status = 'pendente') AS next_due,
                           (SELECT COALESCE(sum(paid_amount),0)::float8 FROM saas_charges ch WHERE ch.contract_id = k.id AND ch.status = 'paga') AS ltv,
                           (SELECT count(*)::int FROM user_companies uc JOIN users u ON u.id = uc.user_id WHERE uc.company_id = k.company_id AND NOT u.is_superadmin AND ((uc.active AND u.active AND NOT uc.invite_pending) OR uc.invite_pending)) AS users,
                           (SELECT count(*)::int FROM branches b WHERE b.company_id = k.company_id AND b.active) AS branches,
                           COALESCE(k.max_users_override, p.max_users) AS users_limit, COALESCE(k.max_branches_override, p.max_branches) AS branches_limit,
                           (SELECT max(s.last_seen_at) FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.company_id = k.company_id AND NOT u.is_superadmin) AS last_access
                      FROM saas_contracts k LEFT JOIN saas_plans p ON p.id = k.plan_id ${w.sql}
                     ORDER BY CASE k.status WHEN 'em_analise' THEN 0 WHEN 'inadimplente' THEN 1 WHEN 'suspenso' THEN 2 WHEN 'aguardando_pagamento' THEN 3 WHEN 'ativo' THEN 4 ELSE 5 END, k.company_name`, w.params, ctx.query, 50)
})

router.get('/api/saas/contracts/:id', SA, async (ctx) => {
  sa(ctx)
  const k = await db.one(`SELECT k.*, p.name AS plan_name, p.max_users AS plan_max_users, p.max_branches AS plan_max_branches FROM saas_contracts k LEFT JOIN saas_plans p ON p.id = k.plan_id WHERE k.id = $1`, [ctx.params.id])
  if (!k) throw notFound('Contrato')
  const [charges, reviews, events, company] = await Promise.all([
    db.many(`SELECT * FROM saas_charges WHERE contract_id = $1 ORDER BY period_start DESC, created_at DESC`, [k.id]),
    db.many(`SELECT r.*, u.name AS resolved_by_name FROM saas_reviews r LEFT JOIN users u ON u.id = r.resolved_by WHERE r.contract_id = $1 ORDER BY r.created_at DESC`, [k.id]),
    db.many(`SELECT e.*, u.name AS user_name FROM saas_contract_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.contract_id = $1 ORDER BY e.created_at DESC, e.id DESC`, [k.id]),
    k.company_id ? db.one(`SELECT c.id, c.name, c.active, c.created_at,
        (SELECT count(*)::int FROM branches b WHERE b.company_id = c.id AND b.active) AS branches,
        (SELECT count(*)::int FROM user_companies uc JOIN users u ON u.id = uc.user_id WHERE uc.company_id = c.id AND NOT u.is_superadmin AND ((uc.active AND u.active AND NOT uc.invite_pending) OR uc.invite_pending)) AS users,
        (SELECT max(s.last_seen_at) FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.company_id = c.id AND NOT u.is_superadmin) AS last_access,
        (SELECT count(*)::int FROM sales sl WHERE sl.company_id = c.id AND sl.created_at > now() - interval '30 days') AS sales_30d
      FROM companies c WHERE c.id = $1`, [k.company_id]) : null,
  ])
  return { ...k, charges, reviews, events, company }
})

const contractSchema = {
  companyName: v.string({ min: 2, max: 150 }), tradeName: v.string({ max: 100 }).optional(), cnpj: v.string().optional(), segment: v.enum(SEGMENTS).default('geral'),
  taxRegime: v.enum(['simples', 'presumido', 'real', 'mei'] as const).default('simples'), contactName: v.string({ min: 2, max: 120 }), contactEmail: v.email(), contactPhone: v.string({ max: 20 }).optional(),
  contactDoc: v.string().optional(), address, planId: v.uuid().optional(), price: v.money({ min: 0 }).optional(), billingMode: v.enum(MODES).default('link_mensal'),
  graceDays: v.int({ min: 0, max: 60 }).default(5), notes: v.string({ max: 2000 }).optional(), leadId: v.uuid().optional(),
}

/** Nova proposta (fica em análise) — ou, com existingCompanyId, vincula um cliente que já usa o sistema (entra ativo). */
router.post('/api/saas/contracts', SA, async (ctx) => {
  sa(ctx, 'carteira.propostas')
  const b: any = parse(v.object({ ...contractSchema, existingCompanyId: v.uuid().optional(), paidUntil: v.date().optional() }), ctx.body)
  if (b.cnpj) { if (!isValidCNPJ(b.cnpj)) throw unprocessable('CNPJ inválido.'); b.cnpj = onlyDigits(b.cnpj) }
  if (b.contactDoc) { if (!isValidCPF(b.contactDoc)) throw unprocessable('CPF do responsável inválido.'); b.contactDoc = onlyDigits(b.contactDoc) }
  const plan = b.planId ? await db.one(`SELECT * FROM saas_plans WHERE id = $1`, [b.planId]) : null
  if (b.planId && !plan) throw unprocessable('Plano inválido.')
  const price = b.price ?? (plan ? Number(plan.price_monthly) : undefined)
  if (price === undefined) throw unprocessable('Informe o plano ou o valor mensal.')
  return tx(async (c) => {
    if (b.existingCompanyId) {
      const co = await c.one(`SELECT * FROM companies WHERE id = $1`, [b.existingCompanyId])
      if (!co) throw notFound('Empresa')
      if (await c.one(`SELECT 1 FROM saas_contracts WHERE company_id = $1`, [co.id])) throw conflict('Esta empresa já tem contrato.')
      if (!b.paidUntil) throw unprocessable('Informe até quando a empresa já está paga (próximo vencimento).')
      const k = await c.one(`INSERT INTO saas_contracts(company_id, plan_id, status, company_name, trade_name, cnpj, segment, tax_regime, contact_name, contact_email, contact_phone, contact_doc, address, price, billing_mode, grace_days, paid_until, started_at, notes, created_by, reviewed_by, reviewed_at, review_note)
                             VALUES ($1,$2,'ativo',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,current_date,$17,$18,$18,now(),'Cliente já existente vinculado à carteira') RETURNING *`,
        [co.id, b.planId ?? null, co.name, co.trade_name, co.cnpj, co.segment || b.segment, co.tax_regime, b.contactName, b.contactEmail, b.contactPhone ? onlyDigits(b.contactPhone) : null, b.contactDoc ?? null,
          JSON.stringify(co.address || {}), price, b.billingMode, b.graceDays, b.paidUntil, b.notes ?? null, ctx.user.id])
      await c.query(`INSERT INTO saas_contract_events(contract_id, from_status, to_status, price, reason, user_id) VALUES ($1,NULL,'ativo',$2,'Cliente existente vinculado à carteira',$3)`, [k.id, price, ctx.user.id])
      await audit(c, ctx, 'saas.contrato_vinculado', 'saas_contract', k.id, { company: co.name, price, paidUntil: b.paidUntil }, 'warning', { companyId: co.id })
      return k
    }
    const risk = await assessRisk(c, { cnpj: b.cnpj, companyName: b.companyName, contactEmail: b.contactEmail, contactDoc: b.contactDoc })
    const k = await c.one(`INSERT INTO saas_contracts(lead_id, plan_id, status, company_name, trade_name, cnpj, segment, tax_regime, contact_name, contact_email, contact_phone, contact_doc, address, price, billing_mode, grace_days, notes, risk_level, risk_flags, created_by)
                           VALUES ($1,$2,'em_analise',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [b.leadId ?? null, b.planId ?? null, b.companyName, b.tradeName ?? null, b.cnpj ?? null, b.segment, b.taxRegime, b.contactName, b.contactEmail, b.contactPhone ? onlyDigits(b.contactPhone) : null, b.contactDoc ?? null,
        JSON.stringify(b.address ?? {}), price, b.billingMode, b.graceDays, b.notes ?? null, risk.level, JSON.stringify(risk.flags), ctx.user.id])
    await c.query(`INSERT INTO saas_contract_events(contract_id, from_status, to_status, price, reason, user_id) VALUES ($1,NULL,'em_analise',$2,'Proposta cadastrada',$3)`, [k.id, price, ctx.user.id])
    await openReview(c, k.id, 'novo_contrato', `Nova proposta: ${b.tradeName || b.companyName}`, risk.level === 'alto' ? 'alta' : risk.level === 'medio' ? 'media' : 'baixa', { risk })
    if (b.leadId) await c.query(`UPDATE site_leads SET status = 'em_contato', updated_at = now() WHERE id = $1 AND status = 'novo'`, [b.leadId])
    await audit(c, ctx, 'saas.proposta_criada', 'saas_contract', k.id, { company: b.companyName, price, risk: risk.level })
    return k
  })
})

/** Altera dados comerciais (plano, valor, forma de cobrança, tolerância) e, em análise, os dados cadastrais. */
router.put('/api/saas/contracts/:id', SA, async (ctx) => {
  sa(ctx, 'carteira.propostas')
  const partial: any = {}; for (const [kk, s] of Object.entries(contractSchema)) if (kk !== 'leadId') partial[kk] = (s as any).optional()
  const b: any = parse(v.object({ ...partial, paidUntil: v.date().optional(),
    // limite específico deste cliente (vazio = segue o plano)
    maxUsersOverride: v.int({ min: 1, max: 100000 }).nullable().optional(), maxBranchesOverride: v.int({ min: 1, max: 10000 }).nullable().optional() }), ctx.body)
  if (b.cnpj) { if (!isValidCNPJ(b.cnpj)) throw unprocessable('CNPJ inválido.'); b.cnpj = onlyDigits(b.cnpj) }
  if (b.contactDoc) { if (!isValidCPF(b.contactDoc)) throw unprocessable('CPF do responsável inválido.'); b.contactDoc = onlyDigits(b.contactDoc) }
  return tx(async (c) => {
    const k = await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [ctx.params.id])
    if (!k) throw notFound('Contrato')
    if (b.planId && !(await c.one(`SELECT 1 FROM saas_plans WHERE id = $1`, [b.planId]))) throw unprocessable('Plano inválido.')
    const map: Record<string, string> = { planId: 'plan_id', price: 'price', billingMode: 'billing_mode', graceDays: 'grace_days', notes: 'notes', contactName: 'contact_name', contactEmail: 'contact_email', contactPhone: 'contact_phone', contactDoc: 'contact_doc', paidUntil: 'paid_until',
      maxUsersOverride: 'max_users_override', maxBranchesOverride: 'max_branches_override' }
    if (k.status === 'em_analise') Object.assign(map, { companyName: 'company_name', tradeName: 'trade_name', cnpj: 'cnpj', segment: 'segment', taxRegime: 'tax_regime', address: 'address' })
    const keys = Object.keys(b).filter((x) => map[x])
    if (!keys.length) throw unprocessable('Nada para alterar (dados cadastrais só podem mudar enquanto a proposta está em análise).')
    if (b.contactPhone) b.contactPhone = onlyDigits(b.contactPhone)
    const r = await c.one(`UPDATE saas_contracts SET ${keys.map((x, i) => `${map[x]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [k.id, ...keys.map((x) => (x === 'address' ? JSON.stringify(b[x] ?? {}) : b[x]))])
    if (b.price !== undefined && Number(b.price) !== Number(k.price)) {
      await c.query(`INSERT INTO saas_contract_events(contract_id, from_status, to_status, price, reason, user_id) VALUES ($1,$2,$2,$3,$4,$5)`, [k.id, k.status, b.price, `Valor alterado de ${Number(k.price).toFixed(2)} para ${Number(b.price).toFixed(2)}`, ctx.user.id])
      if (k.mp_preapproval_id && mercadopago().configured()) await mercadopago().updatePreapproval(k.mp_preapproval_id, { amount: Number(b.price) })
    }
    if (k.status === 'em_analise' && (b.cnpj !== undefined || b.contactEmail || b.companyName)) {
      const risk = await assessRisk(c, { contractId: k.id, cnpj: r.cnpj, companyName: r.company_name, contactEmail: r.contact_email, contactDoc: r.contact_doc })
      await c.query(`UPDATE saas_contracts SET risk_level = $2, risk_flags = $3 WHERE id = $1`, [k.id, risk.level, JSON.stringify(risk.flags)])
    }
    await audit(c, ctx, 'saas.contrato_alterado', 'saas_contract', k.id, b, 'warning', { companyId: k.company_id ?? undefined })
    return r
  })
})

/** Reavalia o risco (ex.: após corrigir dados ou com a consulta do CNPJ disponível). */
router.post('/api/saas/contracts/:id/risk', SA, async (ctx) => {
  sa(ctx, 'carteira.propostas')
  const k = await getContract(ctx.params.id)
  const risk = await assessRisk(db, { contractId: k.id, cnpj: k.cnpj, companyName: k.company_name, contactEmail: k.contact_email, contactDoc: k.contact_doc })
  await db.query(`UPDATE saas_contracts SET risk_level = $2, risk_flags = $3, updated_at = now() WHERE id = $1`, [k.id, risk.level, JSON.stringify(risk.flags)])
  return risk
})

/**
 * Aprova a proposta (auditoria ANTES do pagamento): cria a empresa e o administrador do cliente, gera a primeira cobrança
 * e o link de pagamento. O acesso só é liberado quando o pagamento for confirmado pelo gateway (ou registrado manualmente).
 */
router.post('/api/saas/contracts/:id/approve', SA, async (ctx) => {
  sa(ctx, 'carteira.aprovar')
  const b = parse(v.object({ note: v.string({ max: 1000 }).optional(), branchName: v.string({ min: 2, max: 100 }).default('Matriz'), delivery: v.enum(['email', 'senha'] as const).optional() }), ctx.body)
  const byEmail = resolveDelivery(undefined, b.delivery) === 'email'
  const res = await tx(async (c) => {
    const k = await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [ctx.params.id])
    if (!k) throw notFound('Contrato')
    if (k.status !== 'em_analise') throw unprocessable('Somente propostas em análise podem ser aprovadas.')
    if (k.cnpj && (await c.one(`SELECT 1 FROM companies WHERE cnpj = $1`, [k.cnpj]))) throw conflict('Já existe uma empresa com este CNPJ. Use "vincular empresa existente" ou corrija o CNPJ.')
    const crt = k.tax_regime === 'simples' || k.tax_regime === 'mei' ? 1 : 3
    const r = await bootstrapCompany(c, { name: k.company_name, tradeName: k.trade_name ?? undefined, cnpj: k.cnpj, taxRegime: k.tax_regime, crt, address: k.address, segment: k.segment,
      branch: { code: '001', name: b.branchName, cnpj: k.cnpj, address: k.address } })
    await c.query(`UPDATE companies SET email = $2, phone = $3 WHERE id = $1`, [r.company.id, k.contact_email, k.contact_phone])
    // suporte da plataforma vinculado (oculto para o cliente), como na criação manual de empresas
    await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`, [ctx.user.id, r.company.id, r.roles['Administrador']])
    let tempPassword: string | undefined
    let u = await c.one(`SELECT id, is_superadmin FROM users WHERE lower(email) = lower($1)`, [k.contact_email])
    if (u?.is_superadmin) throw unprocessable('O e-mail do responsável pertence a um superadministrador. Use outro e-mail.')
    let invite = false
    if (!u) {
      if (byEmail) {
        // administrador do cliente recebe o link de ativação por e-mail (nenhuma senha trafega)
        u = await c.one(`INSERT INTO users(name, email, password_hash, must_change_password, pending_activation) VALUES ($1,$2,$3,false,true) RETURNING id`, [k.contact_name, k.contact_email, unusablePasswordHash()])
        invite = true
      } else {
        tempPassword = `Ax${randomCode(6)}${Math.floor(Math.random() * 90 + 10)}`
        u = await c.one(`INSERT INTO users(name, email, password_hash, must_change_password) VALUES ($1,$2,$3,true) RETURNING id`, [k.contact_name, k.contact_email, hashPassword(tempPassword)])
      }
    }
    // conta já existente (de outra empresa): vínculo como convite pendente, aceito pela própria pessoa no login
    const existing = !invite && !tempPassword
    await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches, active, invite_pending, invited_by, invited_at) VALUES ($1,$2,$3,true,$4,$5,$6,CASE WHEN $5 THEN now() END) ON CONFLICT DO NOTHING`,
      [u!.id, r.company.id, r.roles['Administrador'], !existing, existing, existing ? ctx.user.id : null])
    let kk = await c.one(`UPDATE saas_contracts SET company_id = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4, updated_at = now() WHERE id = $1 RETURNING *`, [k.id, r.company.id, ctx.user.id, b.note ?? null])
    kk = await setStatus(c, kk, 'aguardando_pagamento', 'Proposta aprovada na auditoria', ctx.user.id, ctx.user.name)
    await autoResolve(c, k.id, ['novo_contrato'], `Aprovada por ${ctx.user.name}${b.note ? ': ' + b.note : ''}`)
    await c.query(`UPDATE saas_reviews SET resolved_by = $2 WHERE contract_id = $1 AND kind = 'novo_contrato' AND resolved_by IS NULL`, [k.id, ctx.user.id])
    if (k.lead_id) await c.query(`UPDATE site_leads SET status = 'convertido', updated_at = now() WHERE id = $1`, [k.lead_id])
    const charge = await createCharge(c, kk, { kind: 'primeira', periodStart: today(), userId: ctx.user.id })
    await audit(c, ctx, 'saas.proposta_aprovada', 'saas_contract', k.id, { company: k.company_name, adminEmail: k.contact_email, note: b.note }, 'warning', { companyId: r.company.id })
    return { contract: kk, chargeId: charge.id, companyId: r.company.id, adminEmail: k.contact_email, tempPassword, inviteUserId: invite ? (u!.id as string) : null }
  })
  // link de pagamento fora da transação (chamada externa)
  let checkoutUrl: string | null = null, gatewayError: string | undefined
  try {
    if (res.contract.billing_mode === 'assinatura_cartao' && mercadopago().configured()) {
      if (!clientBackUrl()) throw new Error('Defina APP_PUBLIC_URL para criar assinaturas no cartão (endereço de retorno obrigatório).')
      const pre = await mercadopago().createPreapproval({ reason: `AXIONYX — ${res.contract.trade_name || res.contract.company_name}`, amount: Number(res.contract.price), externalRef: `AXK:${res.contract.id}`, payerEmail: res.contract.contact_email, backUrl: clientBackUrl() })
      await db.query(`UPDATE saas_contracts SET mp_preapproval_id = $2, mp_preapproval_status = $3, mp_checkout_url = $4 WHERE id = $1`, [res.contract.id, pre.id, pre.status, pre.url])
      await db.query(`UPDATE saas_charges SET checkout_url = $2 WHERE id = $1`, [res.chargeId, pre.url])
      checkoutUrl = pre.url
    } else checkoutUrl = await ensureCheckout(res.chargeId)
  } catch (e: any) { gatewayError = e.message }
  const inv = res.inviteUserId ? await inviteOrFallback(res.inviteUserId, { companyId: res.companyId, createdBy: ctx.user.id, invitedBy: null }) : null
  return { ...res, tempPassword: res.tempPassword ?? inv?.temporaryPassword, checkoutUrl, gatewayConfigured: mercadopago().configured(), gatewayError, invite: inv?.invite ?? null }
})

router.post('/api/saas/contracts/:id/reject', SA, async (ctx) => {
  sa(ctx, 'carteira.aprovar')
  const b = parse(v.object({ reason: v.string({ min: 3, max: 1000 }) }), ctx.body)
  return tx(async (c) => {
    const k = await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [ctx.params.id])
    if (!k) throw notFound('Contrato')
    if (k.status !== 'em_analise') throw unprocessable('Somente propostas em análise podem ser recusadas.')
    await c.query(`UPDATE saas_contracts SET reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [k.id, ctx.user.id, b.reason])
    const r = await setStatus(c, k, 'recusado', b.reason, ctx.user.id, ctx.user.name)
    await autoResolve(c, k.id, ['novo_contrato'], `Recusada por ${ctx.user.name}: ${b.reason}`)
    if (k.lead_id) await c.query(`UPDATE site_leads SET status = 'descartado', notes = COALESCE(notes || E'\\n', '') || $2, updated_at = now() WHERE id = $1`, [k.lead_id, 'Proposta recusada: ' + b.reason])
    return r
  })
})

/** Ações manuais do auditor sobre o acesso. Nenhuma apaga dados. */
async function manualStatus(ctx: Ctx, to: 'suspenso' | 'ativo' | 'cancelado', allowed: string[], reason: string) {
  return tx(async (c) => {
    const k = await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [ctx.params.id])
    if (!k) throw notFound('Contrato')
    if (!allowed.includes(k.status)) throw unprocessable(`Não é possível passar de "${k.status}" para "${to}".`)
    if (to === 'cancelado') await c.query(`UPDATE saas_contracts SET cancel_reason = $2, cancelled_at = now() WHERE id = $1`, [k.id, reason])
    const r = await setStatus(c, k, to, reason, ctx.user.id, ctx.user.name)
    if (to === 'cancelado') await c.query(`UPDATE saas_charges SET status = 'cancelada', updated_at = now() WHERE contract_id = $1 AND status = 'pendente'`, [k.id])
    if (to === 'ativo') await autoResolve(c, k.id, ['inadimplencia', 'suspensao'], `Reativado manualmente por ${ctx.user.name}: ${reason}`)
    return r
  })
}
const reasonBody = (ctx: Ctx) => parse(v.object({ reason: v.string({ min: 3, max: 1000 }) }), ctx.body).reason
router.post('/api/saas/contracts/:id/suspend', SA, async (ctx) => { sa(ctx, 'carteira.financeiro'); return manualStatus(ctx, 'suspenso', ['ativo', 'inadimplente'], reasonBody(ctx)) })
router.post('/api/saas/contracts/:id/reactivate', SA, async (ctx) => { sa(ctx, 'carteira.financeiro'); return manualStatus(ctx, 'ativo', ['suspenso', 'inadimplente', 'cancelado'], reasonBody(ctx)) })
router.post('/api/saas/contracts/:id/cancel', SA, async (ctx) => {
  sa(ctx, 'carteira.financeiro')
  const reason = reasonBody(ctx)
  const k = await getContract(ctx.params.id)
  let gatewayError: string | undefined
  if (k.mp_preapproval_id && mercadopago().configured()) { try { await mercadopago().updatePreapproval(k.mp_preapproval_id, { status: 'cancelled' }) } catch (e: any) { gatewayError = e.message } }
  const r = await manualStatus(ctx, 'cancelado', ['aguardando_pagamento', 'ativo', 'inadimplente', 'suspenso'], reason)
  return { ...r, gatewayError }
})

// =====================================================================  Cobranças
router.get('/api/saas/charges', SA, async (ctx) => {
  sa(ctx)
  const w = new Where()
  w.addIf(ctx.query.status, 'ch.status = ?', ctx.query.status)
  w.addIf(ctx.query.contract, 'ch.contract_id = ?', ctx.query.contract)
  w.addIf(ctx.query.from, 'COALESCE(ch.paid_at::date, ch.due_date) >= ?', ctx.query.from)
  w.addIf(ctx.query.to, 'COALESCE(ch.paid_at::date, ch.due_date) <= ?', ctx.query.to)
  if (ctx.query.overdue === '1') w.add(`ch.status = 'pendente' AND ch.due_date < current_date`)
  const res = await paged(db, `SELECT ch.*, k.company_name, k.trade_name, k.number AS contract_number, k.billing_mode FROM saas_charges ch JOIN saas_contracts k ON k.id = ch.contract_id ${w.sql}
                                ORDER BY COALESCE(ch.paid_at, ch.due_date::timestamptz) DESC`, w.params, ctx.query, 50)
  const totals = await db.one(`SELECT COALESCE(sum(ch.paid_amount) FILTER (WHERE ch.status = 'paga'),0)::float8 AS paid, COALESCE(sum(ch.amount) FILTER (WHERE ch.status = 'pendente'),0)::float8 AS pending,
                                      COALESCE(sum(ch.fee_amount) FILTER (WHERE ch.status = 'paga'),0)::float8 AS fees FROM saas_charges ch JOIN saas_contracts k ON k.id = ch.contract_id ${w.sql}`, w.params)
  return { ...res, totals }
})

router.post('/api/saas/contracts/:id/charges', SA, async (ctx) => {
  sa(ctx, 'carteira.financeiro')
  const b = parse(v.object({ kind: v.enum(['mensalidade', 'avulsa'] as const).default('avulsa'), amount: v.money({ min: 0.01 }).optional(), periodStart: v.date().optional(), dueDate: v.date().optional(), description: v.string({ max: 200 }).optional() }), ctx.body)
  const ch = await tx(async (c) => {
    const k = await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [ctx.params.id])
    if (!k) throw notFound('Contrato')
    if (['em_analise', 'recusado', 'cancelado'].includes(k.status)) throw unprocessable('Contrato sem cobrança possível neste status.')
    const periodStart = b.periodStart ?? (b.kind === 'mensalidade' ? (k.paid_until && k.paid_until > today() ? k.paid_until : today()) : today())
    if (b.kind === 'mensalidade' && (await c.one(`SELECT 1 FROM saas_charges WHERE contract_id = $1 AND period_start = $2 AND status IN ('pendente','paga')`, [k.id, periodStart]))) throw conflict('Já existe cobrança para este período.')
    const r = await createCharge(c, k, { kind: b.kind, periodStart, amount: b.amount, dueDate: b.dueDate ?? periodStart, userId: ctx.user.id })
    if (b.kind === 'avulsa') await c.query(`UPDATE saas_charges SET period_end = period_start, manual_note = $2 WHERE id = $1`, [r.id, b.description ?? null])
    await audit(c, ctx, 'saas.cobranca_criada', 'saas_charge', r.id, { contract: k.number, ...b }, 'info', { companyId: k.company_id ?? undefined })
    return r
  })
  let checkoutUrl: string | null = null, gatewayError: string | undefined
  try { checkoutUrl = await ensureCheckout(ch.id) } catch (e: any) { gatewayError = e.message }
  return { ...ch, checkout_url: checkoutUrl, gatewayError }
})

router.post('/api/saas/charges/:id/checkout', SA, async (ctx) => {
  sa(ctx, 'carteira.financeiro')
  if (!mercadopago().configured()) throw unprocessable('Mercado Pago não configurado: defina MP_ACCESS_TOKEN nas variáveis do servidor.')
  const url = await ensureCheckout(ctx.params.id, true)
  if (!url) throw unprocessable('Cobrança não está pendente ou é cobrada pela assinatura no cartão / manualmente.')
  return { checkoutUrl: url }
})

/** Baixa manual (ex.: Pix recebido direto na conta). Exige justificativa e fica na auditoria. */
router.post('/api/saas/charges/:id/manual-payment', SA, async (ctx) => {
  sa(ctx, 'carteira.financeiro')
  const b = parse(v.object({ amount: v.money({ min: 0.01 }), method: v.enum(['pix', 'transferencia', 'boleto', 'cartao', 'dinheiro', 'outro'] as const), paidAt: v.date().optional(), note: v.string({ min: 5, max: 500 }) }), ctx.body)
  return tx(async (c) => {
    const ch = await c.one(`SELECT * FROM saas_charges WHERE id = $1 FOR UPDATE`, [ctx.params.id])
    if (!ch) throw notFound('Cobrança')
    if (ch.status !== 'pendente') throw unprocessable('Somente cobranças pendentes podem receber baixa manual.')
    const k = await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [ch.contract_id])
    const r = await applyApproved(c, k, ch, { amount: b.amount, method: b.method, paidAt: b.paidAt ? b.paidAt + 'T12:00:00' : null, note: `Baixa manual por ${ctx.user.name}: ${b.note}`, ...who(ctx) })
    await audit(c, ctx, 'saas.baixa_manual', 'saas_charge', ch.id, b, 'warning', { companyId: k.company_id ?? undefined })
    return { charge: r.charge, contract: r.contract }
  })
})

router.post('/api/saas/charges/:id/refund', SA, async (ctx) => {
  sa(ctx, 'carteira.financeiro')
  const reason = reasonBody(ctx)
  const ch = await db.one(`SELECT ch.*, k.company_id FROM saas_charges ch JOIN saas_contracts k ON k.id = ch.contract_id WHERE ch.id = $1`, [ctx.params.id])
  if (!ch) throw notFound('Cobrança')
  if (ch.status !== 'paga') throw unprocessable('Somente cobranças pagas podem ser estornadas.')
  await audit(null, ctx, 'assinatura.estorno_solicitado', 'saas_charge', ch.id, { reason, paymentId: ch.mp_payment_id }, 'critical', { companyId: ch.company_id ?? undefined })
  if (ch.mp_payment_id) {
    if (!mercadopago().configured()) throw unprocessable('Mercado Pago não configurado.')
    try { await mercadopago().refund(ch.mp_payment_id, `refund-${ch.id}`) } catch (e: any) { throw new HttpError(502, 'gateway', `O Mercado Pago recusou o estorno: ${e.message}`) }
  }
  return tx(async (c) => {
    const r = await c.one(`UPDATE saas_charges SET status = 'estornada', last_status_detail = $2, updated_at = now() WHERE id = $1 RETURNING *`, [ch.id, `estorno: ${reason}`.slice(0, 200)])
    await autoResolve(c, ch.contract_id, ['pagamento_divergente', 'estorno', 'chargeback'], `Estornado por ${ctx.user.name}: ${reason}`)
    return { ...r, manual: !ch.mp_payment_id }
  })
})

router.post('/api/saas/charges/:id/cancel', SA, async (ctx) => {
  sa(ctx, 'carteira.financeiro')
  const reason = reasonBody(ctx)
  const r = await db.one(`UPDATE saas_charges SET status = 'cancelada', last_status_detail = $2, updated_at = now() WHERE id = $1 AND status = 'pendente' RETURNING *`, [ctx.params.id, `cancelada: ${reason}`.slice(0, 200)])
  if (!r) throw unprocessable('Somente cobranças pendentes podem ser canceladas.')
  await audit(null, ctx, 'saas.cobranca_cancelada', 'saas_charge', r.id, { reason }, 'warning')
  return r
})

// =====================================================================  Fila de auditoria
router.get('/api/saas/reviews', SA, async (ctx) => {
  sa(ctx)
  const w = new Where([['r.status = ?', ctx.query.status || 'aberta']])
  w.addIf(ctx.query.kind, 'r.kind = ?', ctx.query.kind)
  return paged(db, `SELECT r.*, k.number AS contract_number, k.company_name, k.trade_name, k.status AS contract_status, k.cnpj, k.contact_name, k.contact_email, k.price, k.risk_level, k.risk_flags, k.billing_mode, k.paid_until,
                           ch.amount AS charge_amount, ch.status AS charge_status, ch.payer_name, ch.payer_doc, u.name AS resolved_by_name
                      FROM saas_reviews r JOIN saas_contracts k ON k.id = r.contract_id LEFT JOIN saas_charges ch ON ch.id = r.charge_id LEFT JOIN users u ON u.id = r.resolved_by ${w.sql}
                     ORDER BY CASE r.severity WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, r.created_at`, w.params, ctx.query, 50)
})

/** Resolve uma exceção. Ação opcional sobre o acesso: manter, suspender, reativar ou cancelar. */
router.post('/api/saas/reviews/:id/resolve', SA, async (ctx) => {
  sa(ctx, 'carteira.aprovar')
  const b = parse(v.object({ resolution: v.string({ min: 3, max: 1000 }), action: v.enum(['manter', 'suspender', 'reativar', 'cancelar'] as const).default('manter') }), ctx.body)
  return tx(async (c) => {
    const r = await c.one(`SELECT * FROM saas_reviews WHERE id = $1 FOR UPDATE`, [ctx.params.id])
    if (!r) throw notFound('Item da auditoria')
    if (r.status !== 'aberta') throw unprocessable('Item já resolvido.')
    if (r.kind === 'novo_contrato') throw unprocessable('Propostas são decididas pelos botões Aprovar ou Recusar.')
    let k = await c.one(`SELECT * FROM saas_contracts WHERE id = $1 FOR UPDATE`, [r.contract_id])
    const why = `${b.resolution} (auditoria)`
    if (b.action === 'suspender' && ACTIVE_STATUSES.includes(k.status)) k = await setStatus(c, k, 'suspenso', why, ctx.user.id, ctx.user.name)
    if (b.action === 'reativar' && ['suspenso', 'inadimplente'].includes(k.status)) k = await setStatus(c, k, 'ativo', why, ctx.user.id, ctx.user.name)
    if (b.action === 'cancelar' && !['cancelado', 'recusado', 'em_analise'].includes(k.status)) {
      await c.query(`UPDATE saas_contracts SET cancel_reason = $2, cancelled_at = now() WHERE id = $1`, [k.id, why])
      k = await setStatus(c, k, 'cancelado', why, ctx.user.id, ctx.user.name)
      await c.query(`UPDATE saas_charges SET status = 'cancelada', updated_at = now() WHERE contract_id = $1 AND status = 'pendente'`, [k.id])
    }
    const out = await c.one(`UPDATE saas_reviews SET status = 'resolvida', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1 RETURNING *`, [r.id, `${b.resolution}${b.action !== 'manter' ? ` [ação: ${b.action}]` : ''}`, ctx.user.id])
    await audit(c, ctx, 'saas.auditoria_resolvida', 'saas_review', r.id, { kind: r.kind, action: b.action, resolution: b.resolution }, 'warning', { companyId: k.company_id ?? undefined })
    return { review: out, contractStatus: k.status }
  })
})

// =====================================================================  Gateway, rotina e clientes sem contrato
router.get('/api/saas/gateway', SA, async (ctx) => {
  sa(ctx)
  const token = secret('MP_ACCESS_TOKEN') || ''
  const last = await db.one(`SELECT created_at, topic, status FROM saas_gateway_events ORDER BY id DESC LIMIT 1`)
  return { configured: !!token, mode: token ? (token.startsWith('TEST-') ? 'teste' : 'producao') : null, webhookSecret: !!secret('MP_WEBHOOK_SECRET'), publicUrl: publicUrl() || null,
    webhookUrl: webhookUrl() || null, backUrl: clientBackUrl() || null, lastEvent: last,
    events: await db.many(`SELECT id, topic, action, resource_id, signature_ok, live_mode, status, error, created_at, processed_at FROM saas_gateway_events ORDER BY id DESC LIMIT 50`) }
})
router.post('/api/saas/gateway/test', SA, async (ctx) => {
  sa(ctx, 'carteira.configurar')
  if (!mercadopago().configured()) throw unprocessable('Defina MP_ACCESS_TOKEN nas variáveis do servidor (Railway) e reinicie.')
  try { return await mercadopago().account() } catch (e: any) { throw new HttpError(502, 'gateway', `Falha ao consultar o Mercado Pago: ${e.message}`) }
})
router.post('/api/saas/gateway/events/:id/reprocess', SA, async (ctx) => {
  sa(ctx, 'carteira.configurar')
  const ev = await db.one(`SELECT id, topic, resource_id, signature_ok FROM saas_gateway_events WHERE id = $1`, [ctx.params.id])
  if (!ev) throw notFound('Notificação')
  if (!ev.signature_ok) throw unprocessable('Notificação com assinatura inválida não é processada.')
  return processGatewayEvent(ev)
})
router.post('/api/saas/run-billing', SA, async (ctx) => { sa(ctx, 'carteira.financeiro'); const r = await runBilling(); await audit(null, ctx, 'saas.rotina_cobranca', null, null, r); return r })
router.get('/api/saas/companies-without-contract', SA, async (ctx) => {
  sa(ctx)
  return db.many(`SELECT c.id, c.name, c.trade_name, c.cnpj, c.segment, c.email, c.phone, c.created_at, c.is_demo,
                         (SELECT count(*)::int FROM user_companies uc JOIN users u ON u.id = uc.user_id WHERE uc.company_id = c.id AND uc.active AND NOT u.is_superadmin) AS users
                    FROM companies c WHERE c.active AND NOT EXISTS (SELECT 1 FROM saas_contracts k WHERE k.company_id = c.id) ORDER BY c.is_demo, c.name`)
})

// =====================================================================  Portal do cliente
router.get('/api/billing/me', {}, async (ctx) => {
  const s = await billingSummary(ctx.user.companyId)
  if (!s) return { hasContract: false }
  const charges = await db.many(`SELECT ch.id, ch.kind, ch.period_start, ch.period_end, ch.amount, ch.due_date, ch.status, ch.paid_at, ch.paid_amount, ch.method,
                                        CASE WHEN ch.status = 'pendente' THEN COALESCE(ch.checkout_url, CASE WHEN k.billing_mode = 'assinatura_cartao' THEN k.mp_checkout_url END) END AS checkout_url
                                   FROM saas_charges ch JOIN saas_contracts k ON k.id = ch.contract_id WHERE k.company_id = $1 AND ch.status <> 'cancelada' ORDER BY ch.period_start DESC LIMIT 24`, [ctx.user.companyId])
  return { hasContract: true, ...s, charges, gatewayConfigured: mercadopago().configured() }
})
/** O cliente pede (ou renova) o link de pagamento de uma cobrança pendente da própria empresa. */
router.post('/api/billing/me/charges/:id/checkout', {}, async (ctx) => {
  const ch = await db.one(`SELECT ch.id FROM saas_charges ch JOIN saas_contracts k ON k.id = ch.contract_id WHERE ch.id = $1 AND k.company_id = $2 AND ch.status = 'pendente'`, [ctx.params.id, ctx.user.companyId])
  if (!ch) throw notFound('Cobrança')
  const url = await ensureCheckout(ch.id)
  if (!url) throw unprocessable('Pagamento on-line indisponível no momento. A equipe AXIONYX enviará as instruções de pagamento.')
  return { checkoutUrl: url }
})

// =====================================================================  Webhook do Mercado Pago (público, assinado)
router.post('/api/public/billing/mercadopago', { auth: 'none', maxBody: 100_000 }, async (ctx) => {
  rateLimit('wh-mp:' + ctx.ip, 300, 60_000)
  const body = ctx.body || {}
  const topic = String(body.type || body.topic || ctx.query.type || ctx.query.topic || '') || null
  const dataId = String(ctx.query['data.id'] || ctx.query.id || body?.data?.id || '') || undefined
  const requestId = String(ctx.req.headers['x-request-id'] || '') || undefined
  const sig = verifyWebhookSignature(String(ctx.req.headers['x-signature'] || '') || undefined, requestId, dataId, Number(process.env.MP_WEBHOOK_MAX_AGE_SEC || 0))
  const ev = await db.one(`INSERT INTO saas_gateway_events(topic, action, resource_id, request_id, signature_ok, live_mode, payload, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, topic, resource_id`,
    [String(topic ?? '').slice(0, 60) || null, String(body.action ?? '').slice(0, 60) || null, String(dataId ?? '').slice(0, 60) || null, String(requestId ?? '').slice(0, 100) || null, sig.ok,
     typeof body.live_mode === 'boolean' ? body.live_mode : null, sig.ok ? JSON.stringify(body) : null, sig.ok ? 'recebido' : 'ignorado', sig.ok ? null : sig.reason]) // sem assinatura válida não guarda o conteúdo
  if (!sig.ok) { ctx.reply = { status: 401 }; return { ok: false, error: 'assinatura inválida' } }
  if (!dataId) { await db.query(`UPDATE saas_gateway_events SET status = 'ignorado', error = 'sem data.id' WHERE id = $1`, [ev.id]); ctx.reply = { status: 200 }; return { ok: true } }
  try { await processGatewayEvent(ev) } catch (e: any) {
    console.error('[billing] notificação', ev.id, e.message)
    ctx.reply = { status: 500 }; return { ok: false } // o Mercado Pago reenvia; o worker também reprocessa
  }
  ctx.reply = { status: 200 }
  return { ok: true }
})

void addMonths
