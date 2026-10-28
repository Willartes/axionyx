import { router, audit, paged, Where, can, Ctx, r2, today, addDays } from '../core/http'
import { db, tx, nextNumber, Q } from '../core/db'
import { v, parse, onlyDigits, isValidCNPJ } from '../core/validate'
import { notFound, unprocessable, conflict, forbidden } from '../core/errors'
import { sha256 } from '../core/crypto'
import { companyTz, addProfessionalCommission, commissionPct } from '../services/agenda'
import { addTransaction, defaultAccount, systemCategory } from '../services/finance'

/**
 * Clínicas e consultórios de saúde (todas as especialidades): convênios e faturamento de guias, perfil de saúde do paciente,
 * recepção (chegada e chamada), documentos clínicos e painel. Conteúdo clínico só para quem pode ver o prontuário;
 * registros e documentos sigilosos só para o autor. Nada clínico é apagado: cancelamento/retificação com motivo e auditoria.
 */
export const COUNCILS = ['CRM', 'CRP', 'CREFITO', 'CRN', 'CRFa', 'COREN', 'CRO', 'CREF', 'CRF', 'CRBM', 'COFFITO', 'CRTO', 'CRESS', 'Outro']
export const SPECIALTIES = ['Clínica médica', 'Medicina de família', 'Cardiologia', 'Dermatologia', 'Endocrinologia', 'Gastroenterologia', 'Geriatria', 'Ginecologia e obstetrícia', 'Neurologia',
  'Oftalmologia', 'Ortopedia', 'Otorrinolaringologia', 'Pediatria', 'Psiquiatria', 'Urologia', 'Psicologia', 'Fisioterapia', 'Nutrição', 'Fonoaudiologia', 'Enfermagem', 'Terapia ocupacional',
  'Odontologia', 'Educação física', 'Farmácia clínica', 'Biomedicina', 'Acupuntura', 'Podologia', 'Psicopedagogia', 'Outra']
const DOC_KINDS = ['receita', 'atestado', 'declaracao', 'exames', 'encaminhamento', 'laudo', 'orientacoes', 'consentimento'] as const
const DOC_LABEL: Record<string, string> = { receita: 'Receituário', atestado: 'Atestado', declaracao: 'Declaração de comparecimento', exames: 'Solicitação de exames', encaminhamento: 'Encaminhamento',
  laudo: 'Relatório / laudo', orientacoes: 'Orientações', consentimento: 'Termo de consentimento' }
// documentos que exigem profissional habilitado (registro no conselho)
const NEEDS_COUNCIL = ['receita', 'atestado', 'exames', 'encaminhamento', 'laudo']

router.get('/api/health/catalog', {}, async () => ({ councils: COUNCILS, specialties: SPECIALTIES, documentKinds: DOC_KINDS.map((k) => ({ id: k, name: DOC_LABEL[k] })) }))

// =====================================================================  Convênios
router.get('/api/insurers', { perm: ['convenios.ver', 'agenda.ver'] }, async (ctx) =>
  db.many(`SELECT i.*, (SELECT count(*)::int FROM insurer_prices p WHERE p.insurer_id = i.id) AS prices,
                  (SELECT count(*)::int FROM patient_profiles pp WHERE pp.insurer_id = i.id) AS patients,
                  (SELECT COALESCE(sum(amount),0)::float8 FROM insurance_claims c WHERE c.insurer_id = i.id AND c.status = 'a_faturar') AS to_bill,
                  (SELECT COALESCE(sum(amount),0)::float8 FROM insurance_claims c WHERE c.insurer_id = i.id AND c.status = 'enviado') AS sent
             FROM insurers i WHERE i.company_id = $1 ${ctx.query.all ? '' : 'AND i.active'} ORDER BY i.active DESC, i.name`, [ctx.user.companyId]))

const insurerSchema = { name: v.string({ min: 2, max: 100 }), ansCode: v.string({ max: 10 }).optional(), cnpj: v.string().optional(), phone: v.string({ max: 20 }).optional(), email: v.email().optional(),
  portalUrl: v.string({ max: 300 }).optional(), paymentDays: v.int({ min: 0, max: 365 }).default(30), requiresAuthorization: v.boolean().default(false), notes: v.string({ max: 1000 }).optional(), active: v.boolean().default(true) }
async function saveInsurer(c: Q, ctx: Ctx, b: any, id?: string) {
  if (b.cnpj && !isValidCNPJ(b.cnpj)) throw unprocessable('CNPJ inválido.')
  const vals = [b.name, b.ansCode ?? null, b.cnpj ? onlyDigits(b.cnpj) : null, b.phone ? onlyDigits(b.phone) : null, b.email ?? null, b.portalUrl ?? null, b.paymentDays, b.requiresAuthorization, b.notes ?? null, b.active]
  if (id) return c.one(`UPDATE insurers SET name = $3, ans_code = $4, cnpj = $5, phone = $6, email = $7, portal_url = $8, payment_days = $9, requires_authorization = $10, notes = $11, active = $12, updated_at = now()
                         WHERE id = $1 AND company_id = $2 RETURNING *`, [id, ctx.user.companyId, ...vals])
  return c.one(`INSERT INTO insurers(company_id, name, ans_code, cnpj, phone, email, portal_url, payment_days, requires_authorization, notes, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [ctx.user.companyId, ...vals])
}
router.post('/api/insurers', { perm: 'convenios.editar' }, async (ctx) => {
  const b = parse(v.object(insurerSchema), ctx.body)
  return tx(async (c) => { const r = await saveInsurer(c, ctx, b); await audit(c, ctx, 'convenio.criado', 'insurer', r.id, { name: b.name }); return r })
})
router.put('/api/insurers/:id', { perm: 'convenios.editar' }, async (ctx) => {
  const b = parse(v.object(insurerSchema), ctx.body)
  return tx(async (c) => { const r = await saveInsurer(c, ctx, b, ctx.params.id); if (!r) throw notFound('Convênio'); await audit(c, ctx, 'convenio.alterado', 'insurer', r.id, b); return r })
})

/** Tabela de preços do convênio: todos os procedimentos com o preço particular e o preço/TUSS acordados. */
router.get('/api/insurers/:id/prices', { perm: ['convenios.ver', 'agenda.ver'] }, async (ctx) => {
  const ins = await db.one(`SELECT id, name FROM insurers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!ins) throw notFound('Convênio')
  const rows = await db.many(`SELECT p.id AS product_id, p.code, p.name, p.sale_price AS private_price, ip.price, ip.tuss_code FROM products p
                               LEFT JOIN insurer_prices ip ON ip.product_id = p.id AND ip.insurer_id = $1 WHERE p.company_id = $2 AND p.kind = 'servico' AND p.active ORDER BY p.name`, [ins.id, ctx.user.companyId])
  return { insurer: ins, items: rows }
})
router.put('/api/insurers/:id/prices', { perm: 'convenios.editar' }, async (ctx) => {
  const b = parse(v.object({ items: v.array(v.object({ productId: v.uuid(), price: v.money({ min: 0, max: 1000000 }).nullable().optional(), tussCode: v.string({ max: 12 }).nullable().optional() }), { max: 2000 }) }), ctx.body)
  return tx(async (c) => {
    const ins = await c.one(`SELECT id FROM insurers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!ins) throw notFound('Convênio')
    let saved = 0
    for (const it of b.items) {
      if (!(await c.one(`SELECT 1 FROM products WHERE id = $1 AND company_id = $2 AND kind = 'servico'`, [it.productId, ctx.user.companyId]))) throw unprocessable('Procedimento inválido na tabela.')
      if (it.price === null || it.price === undefined) { await c.query(`DELETE FROM insurer_prices WHERE insurer_id = $1 AND product_id = $2`, [ins.id, it.productId]); continue }
      await c.query(`INSERT INTO insurer_prices(insurer_id, product_id, company_id, price, tuss_code) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (insurer_id, product_id) DO UPDATE SET price = EXCLUDED.price, tuss_code = EXCLUDED.tuss_code`, [ins.id, it.productId, ctx.user.companyId, it.price, it.tussCode ?? null])
      saved++
    }
    await audit(c, ctx, 'convenio.tabela', 'insurer', ins.id, { itens: saved })
    return { saved }
  })
})

// =====================================================================  Perfil de saúde do paciente
const CLINICAL_FIELDS = ['blood_type', 'allergies', 'chronic_conditions', 'medications']
router.get('/api/patients/:id/profile', { perm: ['clientes.ver', 'agenda.ver'] }, async (ctx) => {
  const cu = await db.one(`SELECT id, name, social_name, cns, birth_date FROM customers WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL`, [ctx.params.id, ctx.user.companyId])
  if (!cu) throw notFound('Paciente')
  const p: any = (await db.one(`SELECT pp.*, i.name AS insurer_name FROM patient_profiles pp LEFT JOIN insurers i ON i.id = pp.insurer_id WHERE pp.customer_id = $1`, [cu.id])) ?? {}
  const clinical = can(ctx.user, 'prontuario.ver')
  if (!clinical) for (const k of CLINICAL_FIELDS) delete p[k]
  return { customer: cu, profile: p, clinicalVisible: clinical }
})
router.put('/api/patients/:id/profile', { perm: 'clientes.editar' }, async (ctx) => {
  const b: any = parse(v.object({ socialName: v.string({ max: 120 }).nullable().optional(), cns: v.string({ max: 20 }).nullable().optional(), insurerId: v.uuid().nullable().optional(),
    insurancePlan: v.string({ max: 60 }).nullable().optional(), insuranceCard: v.string({ max: 40 }).nullable().optional(), insuranceValidUntil: v.date().nullable().optional(),
    guardianName: v.string({ max: 120 }).nullable().optional(), guardianDoc: v.string({ max: 20 }).nullable().optional(), guardianRelation: v.string({ max: 40 }).nullable().optional(),
    emergencyName: v.string({ max: 120 }).nullable().optional(), emergencyPhone: v.string({ max: 20 }).nullable().optional(),
    bloodType: v.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const).nullable().optional(), allergies: v.string({ max: 1000 }).nullable().optional(),
    chronicConditions: v.string({ max: 1000 }).nullable().optional(), medications: v.string({ max: 1000 }).nullable().optional() }), ctx.body)
  const clinicalKeys = ['bloodType', 'allergies', 'chronicConditions', 'medications'].filter((k) => k in ctx.body)
  if (clinicalKeys.length && !can(ctx.user, 'prontuario.editar')) throw forbidden('Alergias, condições, medicamentos e tipo sanguíneo só podem ser alterados por profissional de saúde.')
  return tx(async (c) => {
    const cu = await c.one(`SELECT id FROM customers WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL`, [ctx.params.id, ctx.user.companyId])
    if (!cu) throw notFound('Paciente')
    if (b.insurerId && !(await c.one(`SELECT 1 FROM insurers WHERE id = $1 AND company_id = $2`, [b.insurerId, ctx.user.companyId]))) throw unprocessable('Convênio inválido.')
    if ('socialName' in ctx.body || 'cns' in ctx.body)
      await c.query(`UPDATE customers SET social_name = CASE WHEN $2 THEN $3 ELSE social_name END, cns = CASE WHEN $4 THEN $5 ELSE cns END, updated_at = now() WHERE id = $1`,
        [cu.id, 'socialName' in ctx.body, b.socialName ?? null, 'cns' in ctx.body, b.cns ? onlyDigits(b.cns) : null])
    const map: Record<string, string> = { insurerId: 'insurer_id', insurancePlan: 'insurance_plan', insuranceCard: 'insurance_card', insuranceValidUntil: 'insurance_valid_until', guardianName: 'guardian_name',
      guardianDoc: 'guardian_doc', guardianRelation: 'guardian_relation', emergencyName: 'emergency_name', emergencyPhone: 'emergency_phone', bloodType: 'blood_type', allergies: 'allergies',
      chronicConditions: 'chronic_conditions', medications: 'medications' }
    const keys = Object.keys(map).filter((k) => k in ctx.body)
    await c.query(`INSERT INTO patient_profiles(customer_id, company_id, updated_by) VALUES ($1,$2,$3) ON CONFLICT (customer_id) DO NOTHING`, [cu.id, ctx.user.companyId, ctx.user.id])
    if (keys.length) await c.query(`UPDATE patient_profiles SET ${keys.map((k, i) => `${map[k]} = $${i + 3}`).join(', ')}, updated_by = $2, updated_at = now() WHERE customer_id = $1`,
      [cu.id, ctx.user.id, ...keys.map((k) => (b[k] === '' ? null : b[k] ?? null))])
    await audit(c, ctx, 'paciente.perfil', 'customer', cu.id, { campos: keys, clinico: clinicalKeys.length > 0 }, clinicalKeys.length ? 'warning' : 'info')
    return { ok: true }
  })
})

// =====================================================================  Recepção / sala de espera
router.get('/api/reception', { perm: 'agenda.ver' }, async (ctx) => {
  const tz = await companyTz(db, ctx.user.companyId)
  const day = ctx.query.date && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date) ? ctx.query.date : null
  const rows = await db.many(`SELECT a.id, a.number, a.status, a.payer, a.visit_type, a.telehealth_url, a.room, a.notes, a.customer_id, a.professional_id, a.sale_id,
                                     to_char(a.start_at AT TIME ZONE $3, 'HH24:MI') AS start_time, to_char(a.end_at AT TIME ZONE $3, 'HH24:MI') AS end_time,
                                     a.arrived_at, a.called_at, a.completed_at, COALESCE(cu.social_name, cu.name, a.guest_name) AS patient, COALESCE(cu.whatsapp, cu.phone, a.guest_phone) AS phone,
                                     pr.name AS professional, pr.color, pr.specialty, i.name AS insurer_name, a.insurance_card, a.guide_number, a.authorization_code, i.requires_authorization,
                                     (SELECT string_agg(p.name, ', ' ORDER BY s.sort) FROM appointment_services s JOIN products p ON p.id = s.product_id WHERE s.appointment_id = a.id) AS services,
                                     (SELECT COALESCE(sum(s.price),0)::float8 FROM appointment_services s WHERE s.appointment_id = a.id AND s.customer_package_id IS NULL AND s.plan_item_id IS NULL AND s.sale_item_id IS NULL) AS to_charge,
                                     CASE WHEN a.arrived_at IS NOT NULL AND a.status IN ('agendado','confirmado') THEN (extract(epoch FROM now() - a.arrived_at) / 60)::int END AS waiting_min
                                FROM appointments a JOIN professionals pr ON pr.id = a.professional_id LEFT JOIN customers cu ON cu.id = a.customer_id LEFT JOIN insurers i ON i.id = a.insurer_id
                               WHERE a.company_id = $1 AND a.branch_id = $2 AND (a.start_at AT TIME ZONE $3)::date = COALESCE($4::date, (now() AT TIME ZONE $3)::date)
                                 ${can(ctx.user, 'agenda.todas') ? '' : 'AND pr.user_id = $5'}
                               ORDER BY a.start_at`, can(ctx.user, 'agenda.todas') ? [ctx.user.companyId, ctx.user.branchId, tz, day] : [ctx.user.companyId, ctx.user.branchId, tz, day, ctx.user.id])
  return { date: day, items: rows }
})
/** Paciente chegou: registra o horário (tempo de espera) e confirma a presença. */
router.post('/api/appointments/:id/arrive', { perm: 'agenda.editar' }, async (ctx) => tx(async (c) => {
  const a = await c.one(`SELECT * FROM appointments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
  if (!a) throw notFound('Agendamento')
  if (!['agendado', 'confirmado'].includes(a.status)) throw conflict('Só é possível registrar a chegada de atendimentos agendados ou confirmados.')
  const r = await c.one(`UPDATE appointments SET arrived_at = COALESCE(arrived_at, now()), status = 'confirmado', confirmed_at = COALESCE(confirmed_at, now()), updated_at = now() WHERE id = $1 RETURNING id, arrived_at, status`, [a.id])
  await audit(c, ctx, 'agenda.chegada', 'appointment', a.id, { number: a.number })
  return r
}))

// =====================================================================  Faturamento de convênio
router.get('/api/insurance-claims', { perm: 'convenios.ver' }, async (ctx) => {
  const w = new Where([['c.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.status, 'c.status = ?', ctx.query.status)
  w.addIf(ctx.query.insurer, 'c.insurer_id = ?', ctx.query.insurer)
  w.addIf(ctx.query.batch, 'c.batch_id = ?', ctx.query.batch)
  w.addIf(ctx.query.professional, 'c.professional_id = ?', ctx.query.professional)
  w.addIf(ctx.query.from, 'c.service_date >= ?', ctx.query.from)
  w.addIf(ctx.query.to, 'c.service_date <= ?', ctx.query.to)
  const res = await paged(db, `SELECT c.*, i.name AS insurer_name, COALESCE(cu.social_name, cu.name) AS patient, pr.name AS professional, b.number AS batch_number
                                 FROM insurance_claims c JOIN insurers i ON i.id = c.insurer_id LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN professionals pr ON pr.id = c.professional_id
                                 LEFT JOIN insurance_batches b ON b.id = c.batch_id ${w.sql} ORDER BY c.service_date DESC, c.created_at DESC`, w.params, ctx.query, 100)
  const totals = await db.one(`SELECT COALESCE(sum(amount),0)::float8 AS amount, COALESCE(sum(paid_amount),0)::float8 AS paid, count(*)::int AS n FROM insurance_claims c ${w.sql}`, w.params)
  return { ...res, totals }
})

router.put('/api/insurance-claims/:id', { perm: 'convenios.editar' }, async (ctx) => {
  const b = parse(v.object({ guideNumber: v.string({ max: 40 }).nullable().optional(), authorizationCode: v.string({ max: 40 }).nullable().optional(), insuranceCard: v.string({ max: 40 }).nullable().optional(),
    tussCode: v.string({ max: 12 }).nullable().optional(), amount: v.money({ min: 0, max: 1000000 }).optional() }), ctx.body)
  return tx(async (c) => {
    const cl = await c.one(`SELECT * FROM insurance_claims WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!cl) throw notFound('Guia')
    if (cl.status !== 'a_faturar') throw unprocessable('Só guias ainda não enviadas podem ser corrigidas.')
    const r = await c.one(`UPDATE insurance_claims SET guide_number = CASE WHEN $2 THEN $3 ELSE guide_number END, authorization_code = CASE WHEN $4 THEN $5 ELSE authorization_code END,
                             insurance_card = CASE WHEN $6 THEN $7 ELSE insurance_card END, tuss_code = CASE WHEN $8 THEN $9 ELSE tuss_code END, amount = COALESCE($10, amount), updated_at = now() WHERE id = $1 RETURNING *`,
      [cl.id, 'guideNumber' in ctx.body, b.guideNumber ?? null, 'authorizationCode' in ctx.body, b.authorizationCode ?? null, 'insuranceCard' in ctx.body, b.insuranceCard ?? null, 'tussCode' in ctx.body, b.tussCode ?? null, b.amount ?? null])
    await audit(c, ctx, 'convenio.guia_corrigida', 'insurance_claim', cl.id, b)
    return r
  })
})

/** Monta e envia um lote com guias a faturar do mesmo convênio. */
router.post('/api/insurance-batches', { perm: 'convenios.editar' }, async (ctx) => {
  const b = parse(v.object({ insurerId: v.uuid(), claimIds: v.array(v.uuid(), { min: 1, max: 1000 }), reference: v.string({ max: 10 }).optional(), protocol: v.string({ max: 60 }).optional(), notes: v.string({ max: 500 }).optional() }), ctx.body)
  return tx(async (c) => {
    const ins = await c.one(`SELECT * FROM insurers WHERE id = $1 AND company_id = $2`, [b.insurerId, ctx.user.companyId])
    if (!ins) throw notFound('Convênio')
    const claims = await c.many(`SELECT * FROM insurance_claims WHERE id = ANY($1::uuid[]) AND company_id = $2 FOR UPDATE`, [b.claimIds, ctx.user.companyId])
    if (claims.length !== b.claimIds.length) throw unprocessable('Guia inválida no lote.')
    if (claims.some((x) => x.insurer_id !== ins.id)) throw unprocessable('Todas as guias do lote devem ser do mesmo convênio.')
    if (claims.some((x) => x.status !== 'a_faturar')) throw unprocessable('Só guias "a faturar" podem entrar em um lote.')
    if (ins.requires_authorization) { const miss = claims.filter((x) => !x.authorization_code); if (miss.length) throw unprocessable(`${miss.length} guia(s) sem código de autorização — este convênio exige autorização prévia.`) }
    const number = await nextNumber(c, ctx.user.companyId, 'lote_convenio')
    const total = r2(claims.reduce((s, x) => s + Number(x.amount), 0))
    const batch = await c.one(`INSERT INTO insurance_batches(company_id, insurer_id, number, reference, total, protocol, notes, expected_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [ctx.user.companyId, ins.id, number, b.reference ?? today().slice(0, 7), total, b.protocol ?? null, b.notes ?? null, addDays(today(), ins.payment_days), ctx.user.id])
    await c.query(`UPDATE insurance_claims SET status = 'enviado', batch_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])`, [b.claimIds, batch.id])
    await audit(c, ctx, 'convenio.lote_enviado', 'insurance_batch', batch.id, { number, insurer: ins.name, guias: claims.length, total })
    return batch
  })
})
router.get('/api/insurance-batches', { perm: 'convenios.ver' }, async (ctx) =>
  db.many(`SELECT b.*, i.name AS insurer_name, (SELECT count(*)::int FROM insurance_claims c WHERE c.batch_id = b.id) AS claims,
                  (SELECT count(*)::int FROM insurance_claims c WHERE c.batch_id = b.id AND c.status = 'enviado') AS open_claims
             FROM insurance_batches b JOIN insurers i ON i.id = b.insurer_id WHERE b.company_id = $1 ORDER BY b.sent_at DESC LIMIT 200`, [ctx.user.companyId]))

async function refreshBatch(c: Q, batchId: string) {
  const t = await c.one(`SELECT COALESCE(sum(paid_amount) FILTER (WHERE status IN ('pago','glosado')),0)::float8 AS paid,
                                COALESCE(sum(amount - COALESCE(paid_amount,0)) FILTER (WHERE status IN ('pago','glosado')),0)::float8 AS gloss,
                                count(*) FILTER (WHERE status = 'enviado')::int AS open, count(*)::int AS n FROM insurance_claims WHERE batch_id = $1`, [batchId])
  await c.query(`UPDATE insurance_batches SET paid_total = $2, gloss_total = $3, status = CASE WHEN $4 = 0 THEN 'pago' WHEN $4 < $5 THEN 'pago_parcial' ELSE status END WHERE id = $1`, [batchId, t.paid, t.gloss, t.open, t.n])
}

/** Retorno do convênio: pago (integral ou parcial) ou glosado. O valor recebido entra no financeiro e gera o repasse do profissional. */
router.post('/api/insurance-claims/settle', { perm: 'convenios.editar' }, async (ctx) => {
  const b = parse(v.object({ items: v.array(v.object({ claimId: v.uuid(), paidAmount: v.money({ min: 0, max: 1000000 }), glossReason: v.string({ max: 300 }).optional() }), { min: 1, max: 1000 }),
    paidAt: v.date().optional(), accountId: v.uuid().optional() }), ctx.body)
  return tx(async (c) => {
    const paidAt = b.paidAt ?? today()
    const account = b.accountId ?? (await defaultAccount(c, ctx.user.companyId, ctx.user.branchId, 'banco'))
    const cat = (await systemCategory(c, ctx.user.companyId, 'outras_receitas'))
    const batches = new Set<string>()
    let received = 0
    for (const it of b.items) {
      const cl = await c.one(`SELECT c.*, i.name AS insurer_name FROM insurance_claims c JOIN insurers i ON i.id = c.insurer_id WHERE c.id = $1 AND c.company_id = $2 FOR UPDATE`, [it.claimId, ctx.user.companyId])
      if (!cl) throw notFound('Guia')
      if (cl.status !== 'enviado') throw unprocessable(`Guia de ${cl.description} não está aguardando retorno do convênio.`)
      if (it.paidAmount > Number(cl.amount) + 0.009) throw unprocessable(`Valor pago maior que o faturado em ${cl.description}.`)
      const gloss = it.paidAmount + 0.009 < Number(cl.amount)
      if (gloss && (!it.glossReason || it.glossReason.trim().length < 3)) throw unprocessable(`Informe o motivo da glosa de ${cl.description}.`)
      await c.query(`UPDATE insurance_claims SET status = $2, paid_amount = $3, gloss_reason = $4, paid_at = $5, updated_at = now() WHERE id = $1`,
        [cl.id, it.paidAmount > 0 ? 'pago' : 'glosado', it.paidAmount, gloss ? it.glossReason : null, paidAt])
      if (it.paidAmount > 0) {
        await addTransaction(c, { companyId: ctx.user.companyId, branchId: cl.branch_id, accountId: account, direction: 'entrada', amount: it.paidAmount, date: paidAt,
          description: `Convênio ${cl.insurer_name} — ${cl.description}${cl.guide_number ? ' (guia ' + cl.guide_number + ')' : ''}`, categoryId: cat, sourceType: 'convenio_guia', sourceId: cl.id, userId: ctx.user.id })
        if (cl.professional_id) {
          const pct = cl.product_id ? await commissionPct(c, cl.professional_id, cl.product_id) : 0
          if (pct > 0) await addProfessionalCommission(c, { companyId: ctx.user.companyId, branchId: cl.branch_id, professionalId: cl.professional_id, kind: 'servico', refType: 'convenio', refKey: 'claim:' + cl.id,
            appointmentId: cl.appointment_id, description: `Repasse convênio ${cl.insurer_name} — ${cl.description}`, base: it.paidAmount, pct })
        }
        received += it.paidAmount
      }
      if (cl.batch_id) batches.add(cl.batch_id)
    }
    for (const id of batches) await refreshBatch(c, id)
    await audit(c, ctx, 'convenio.retorno', null, null, { guias: b.items.length, recebido: r2(received) }, 'warning')
    return { received: r2(received), claims: b.items.length }
  })
})

router.post('/api/insurance-claims/:id/cancel', { perm: 'convenios.editar' }, async (ctx) => {
  const b = parse(v.object({ reason: v.string({ min: 3, max: 300 }) }), ctx.body)
  return tx(async (c) => {
    const cl = await c.one(`SELECT * FROM insurance_claims WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!cl) throw notFound('Guia')
    if (cl.status !== 'a_faturar') throw unprocessable('Só guias ainda não enviadas podem ser canceladas.')
    await c.query(`UPDATE insurance_claims SET status = 'cancelado', gloss_reason = $2, updated_at = now() WHERE id = $1`, [cl.id, b.reason])
    await audit(c, ctx, 'convenio.guia_cancelada', 'insurance_claim', cl.id, { reason: b.reason }, 'warning')
    return { ok: true }
  })
})

// =====================================================================  Documentos clínicos
async function myProfessionalRow(c: Q, ctx: Ctx) {
  return c.one(`SELECT * FROM professionals WHERE company_id = $1 AND user_id = $2 AND active`, [ctx.user.companyId, ctx.user.id])
}
const docItem = v.object({ name: v.string({ min: 1, max: 200 }), dose: v.string({ max: 200 }).optional(), qty: v.string({ max: 60 }).optional(), notes: v.string({ max: 300 }).optional() })
const docContent = v.object({
  items: v.array(docItem, { max: 40 }).optional(),        // receita (medicamento + posologia) ou exames
  text: v.string({ max: 8000 }).optional(),                // laudo, orientações, encaminhamento, consentimento
  days: v.int({ min: 1, max: 365 }).optional(),            // atestado
  cid: v.string({ max: 8 }).optional(), cidConsent: v.boolean().optional(),
  startTime: v.string({ max: 5 }).optional(), endTime: v.string({ max: 5 }).optional(), // declaração
  specialtyTo: v.string({ max: 80 }).optional(),           // encaminhamento
  clinicalIndication: v.string({ max: 500 }).optional(),   // exames
  procedure: v.string({ max: 200 }).optional(),            // consentimento
  date: v.date().optional(),
})

router.get('/api/customers/:id/clinical-documents', { perm: 'prontuario.ver' }, async (ctx) =>
  db.many(`SELECT d.*, pr.name AS professional FROM clinical_documents d JOIN professionals pr ON pr.id = d.professional_id
            WHERE d.customer_id = $1 AND d.company_id = $2 AND (d.visibility = 'equipe' OR d.created_by = $3 OR pr.user_id = $3) ORDER BY d.issued_at DESC`, [ctx.params.id, ctx.user.companyId, ctx.user.id]))

router.post('/api/customers/:id/clinical-documents', { perm: 'prontuario.documentos' }, async (ctx) => {
  const b: any = parse(v.object({ kind: v.enum(DOC_KINDS), content: docContent, appointmentId: v.uuid().optional(), visibility: v.enum(['equipe', 'restrito'] as const).optional() }), ctx.body)
  const k = b.kind, ct = b.content
  if ((k === 'receita' || k === 'exames') && !ct.items?.length) throw unprocessable(k === 'receita' ? 'Inclua pelo menos um medicamento.' : 'Inclua pelo menos um exame.')
  if (k === 'atestado' && !ct.days) throw unprocessable('Informe os dias de afastamento.')
  if (k === 'atestado' && ct.cid && !ct.cidConsent) throw unprocessable('O CID só pode constar no atestado com autorização expressa do paciente.')
  if (['laudo', 'orientacoes', 'consentimento', 'encaminhamento'].includes(k) && !ct.text?.trim()) throw unprocessable('Escreva o conteúdo do documento.')
  return tx(async (c) => {
    const cu = await c.one(`SELECT id, name, anonymized_at FROM customers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!cu || cu.anonymized_at) throw notFound('Paciente')
    // só o próprio profissional emite em seu nome
    const prof = await myProfessionalRow(c, ctx)
    if (!prof) throw forbidden('Documentos clínicos são emitidos pelo próprio profissional: vincule seu usuário a um cadastro de profissional.')
    if (NEEDS_COUNCIL.includes(k) && !prof.council_number && !prof.council_id) throw unprocessable('Cadastre seu registro no conselho profissional (ex.: CRM-SP 123456) antes de emitir este documento.')
    if (b.appointmentId && !(await c.one(`SELECT 1 FROM appointments WHERE id = $1 AND company_id = $2 AND customer_id = $3`, [b.appointmentId, ctx.user.companyId, cu.id]))) throw unprocessable('Atendimento não pertence a este paciente.')
    const number = await nextNumber(c, ctx.user.companyId, 'documento_clinico')
    const issuedAt = new Date().toISOString()
    const visibility = b.visibility ?? (prof.restrict_records ? 'restrito' : 'equipe')
    const content = { ...ct, cid: ct.cid ? ct.cid.toUpperCase() : undefined }
    const hash = sha256(JSON.stringify({ n: number, kind: k, patient: cu.id, professional: prof.id, council: prof.council_id, content, at: issuedAt }))
    const d = await c.one(`INSERT INTO clinical_documents(company_id, number, customer_id, professional_id, appointment_id, kind, content, visibility, content_hash, issued_at, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.user.companyId, number, cu.id, prof.id, b.appointmentId ?? null, k, JSON.stringify(content), visibility, hash, issuedAt, ctx.user.id])
    await audit(c, ctx, 'prontuario.documento', 'customer', cu.id, { kind: k, number, document: d.id }, 'warning')
    return d
  })
})

/** Documento para impressão: dados da clínica, do paciente e do profissional (com conselho) e código de verificação. */
router.get('/api/clinical-documents/:id', { perm: 'prontuario.ver' }, async (ctx) => {
  const d = await db.one(`SELECT d.*, pr.name AS professional, pr.specialty, pr.council_id, pr.council, pr.council_number, pr.council_uf, pr.rqe, pr.user_id AS prof_user,
                                 cu.name AS patient, cu.social_name, cu.birth_date, cu.cpf_cnpj, cu.cns, co.name AS company_name, co.trade_name AS company_trade, co.cnpj AS company_cnpj, co.address AS company_address, co.phone AS company_phone,
                                 to_char(a.start_at AT TIME ZONE COALESCE(co.settings->'agenda'->>'fusoHorario','America/Sao_Paulo'), 'YYYY-MM-DD HH24:MI') AS appointment_local
                            FROM clinical_documents d JOIN professionals pr ON pr.id = d.professional_id JOIN customers cu ON cu.id = d.customer_id JOIN companies co ON co.id = d.company_id
                            LEFT JOIN appointments a ON a.id = d.appointment_id WHERE d.id = $1 AND d.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!d) throw notFound('Documento')
  if (d.visibility === 'restrito' && d.created_by !== ctx.user.id && d.prof_user !== ctx.user.id) throw forbidden('Documento sigiloso: acesso restrito ao profissional que o emitiu.')
  await audit(null, ctx, 'prontuario.documento_visualizado', 'clinical_document', d.id, { number: d.number })
  return { ...d, label: DOC_LABEL[d.kind], verification: d.content_hash.slice(0, 16).toUpperCase() }
})

router.post('/api/clinical-documents/:id/cancel', { perm: 'prontuario.documentos' }, async (ctx) => {
  const b = parse(v.object({ reason: v.string({ min: 3, max: 300 }) }), ctx.body)
  return tx(async (c) => {
    const d = await c.one(`SELECT d.*, pr.user_id AS prof_user FROM clinical_documents d JOIN professionals pr ON pr.id = d.professional_id WHERE d.id = $1 AND d.company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!d) throw notFound('Documento')
    if (d.cancelled_at) throw unprocessable('Documento já cancelado.')
    if (d.prof_user !== ctx.user.id) throw forbidden('Só o profissional que emitiu pode cancelar o documento.')
    await c.query(`UPDATE clinical_documents SET cancelled_at = now(), cancel_reason = $2 WHERE id = $1`, [d.id, b.reason])
    await audit(c, ctx, 'prontuario.documento_cancelado', 'clinical_document', d.id, { number: d.number, reason: b.reason }, 'warning')
    return { ok: true }
  })
})

// =====================================================================  Painel da clínica
router.get('/api/health/summary', { perm: ['dashboard.ver', 'agenda.ver'] }, async (ctx) => {
  const id = ctx.user.companyId
  const days = Math.min(365, Math.max(7, Number(ctx.query.days || 30)))
  const tz = await companyTz(db, id)
  const iv = String(days)
  const todayRow = await db.one(`SELECT count(*)::int AS scheduled, count(*) FILTER (WHERE arrived_at IS NOT NULL AND status IN ('agendado','confirmado'))::int AS waiting,
                                        count(*) FILTER (WHERE status = 'em_atendimento')::int AS in_service, count(*) FILTER (WHERE status = 'concluido')::int AS done,
                                        COALESCE(avg(extract(epoch FROM called_at - arrived_at) / 60) FILTER (WHERE called_at IS NOT NULL AND arrived_at IS NOT NULL),0)::float8 AS avg_wait
                                   FROM appointments WHERE company_id = $1 AND (start_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date AND status <> 'cancelado'`, [id, tz])
  const period = await db.one(`SELECT count(*) FILTER (WHERE status = 'concluido')::int AS done, count(*) FILTER (WHERE status = 'faltou')::int AS no_show,
                                      count(*) FILTER (WHERE status IN ('concluido','faltou'))::int AS decided,
                                      count(*) FILTER (WHERE status = 'concluido' AND visit_type = 'primeira')::int AS first_visits,
                                      count(*) FILTER (WHERE status = 'concluido' AND visit_type = 'retorno')::int AS returns,
                                      count(*) FILTER (WHERE status = 'concluido' AND payer = 'convenio')::int AS by_insurer,
                                      count(*) FILTER (WHERE status = 'concluido' AND payer = 'particular')::int AS private,
                                      count(*) FILTER (WHERE status = 'concluido' AND visit_type = 'teleconsulta')::int AS tele,
                                      COALESCE(avg(extract(epoch FROM called_at - arrived_at) / 60) FILTER (WHERE called_at IS NOT NULL AND arrived_at IS NOT NULL),0)::float8 AS avg_wait
                                 FROM appointments WHERE company_id = $1 AND start_at > now() - ($2 || ' days')::interval AND start_at < date_trunc('day', now()) + interval '1 day'`, [id, iv])
  const privateRevenue = (await db.one(`SELECT COALESCE(sum(si.total),0)::float8 AS v FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN appointment_services aps ON aps.sale_item_id = si.id
                                          WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.created_at > now() - ($2 || ' days')::interval`, [id, iv])).v
  const insurers = await db.many(`SELECT i.id, i.name, COALESCE(sum(c.amount) FILTER (WHERE c.status = 'a_faturar'),0)::float8 AS to_bill, COALESCE(sum(c.amount) FILTER (WHERE c.status = 'enviado'),0)::float8 AS sent,
                                         COALESCE(sum(c.paid_amount) FILTER (WHERE c.status IN ('pago','glosado') AND c.paid_at > current_date - $2::int),0)::float8 AS received,
                                         COALESCE(sum(c.amount - COALESCE(c.paid_amount,0)) FILTER (WHERE c.status IN ('pago','glosado') AND c.paid_at > current_date - $2::int),0)::float8 AS glossed,
                                         COALESCE(sum(c.amount) FILTER (WHERE c.status IN ('pago','glosado') AND c.paid_at > current_date - $2::int),0)::float8 AS settled
                                    FROM insurers i LEFT JOIN insurance_claims c ON c.insurer_id = i.id WHERE i.company_id = $1 GROUP BY i.id, i.name ORDER BY i.name`, [id, days])
  const professionals = await db.many(`SELECT pr.id, pr.name, pr.specialty, count(a.id) FILTER (WHERE a.status = 'concluido')::int AS done, count(a.id) FILTER (WHERE a.status = 'faltou')::int AS no_show,
                                              count(DISTINCT a.customer_id) FILTER (WHERE a.status = 'concluido')::int AS patients
                                         FROM professionals pr LEFT JOIN appointments a ON a.professional_id = pr.id AND a.start_at > now() - ($2 || ' days')::interval AND a.start_at < date_trunc('day', now()) + interval '1 day'
                                        WHERE pr.company_id = $1 AND pr.active GROUP BY pr.id ORDER BY done DESC`, [id, iv])
  const specialties = await db.many(`SELECT COALESCE(pr.specialty, 'Sem especialidade') AS label, count(*)::int AS value FROM appointments a JOIN professionals pr ON pr.id = a.professional_id
                                      WHERE a.company_id = $1 AND a.status = 'concluido' AND a.start_at > now() - ($2 || ' days')::interval GROUP BY 1 ORDER BY 2 DESC`, [id, iv])
  const newPatients = (await db.one(`SELECT count(*)::int AS n FROM (SELECT customer_id, min(start_at) AS first FROM appointments WHERE company_id = $1 AND status = 'concluido' AND customer_id IS NOT NULL GROUP BY customer_id) t WHERE t.first > now() - ($2 || ' days')::interval`, [id, iv])).n
  const ins = insurers.reduce((a, x) => ({ to_bill: a.to_bill + x.to_bill, sent: a.sent + x.sent, received: a.received + x.received, glossed: a.glossed + x.glossed, settled: a.settled + x.settled }), { to_bill: 0, sent: 0, received: 0, glossed: 0, settled: 0 })
  return { days, today: todayRow, period: { ...period, noShowPct: period.decided ? r2((period.no_show / period.decided) * 100) : 0, newPatients, privateRevenue },
    insurance: { ...ins, glossPct: ins.settled ? r2((ins.glossed / ins.settled) * 100) : 0 }, insurers: insurers.filter((x) => x.to_bill || x.sent || x.received || x.glossed).sort((a, b) => b.to_bill + b.sent - a.to_bill - a.sent), professionals, specialties }
})
