import { router, audit, paged, Where, can, r2, today, addDays, Ctx } from '../core/http'
import { db, tx, nextNumber, Q } from '../core/db'
import { v, parse } from '../core/validate'
import { notFound, unprocessable, forbidden, conflict } from '../core/errors'
import { createVariants } from './produtos'
import { getSettings } from '../services/settings'
import { anamneseTemplates, ANAMNESE } from '../services/segments'
import { checkSlot, resolveServices, completeAppointment, normalizeWorkHours, companyTz, refreshPlanStatus, LOCAL_DT, ACTIVE_STATUSES } from '../services/agenda'
import { systemCategory } from '../services/finance'
import { queueMessage } from './integracoes'

// =====================================================================
// Prestadores de serviço (odontologia, estética, salão): serviços, pacotes, profissionais, agenda,
// comissões por profissional, prontuário/fichas, odontograma, planos de tratamento e inteligência de serviços.
// =====================================================================
const localDt = () => v.string({ pattern: LOCAL_DT, patternMsg: 'Data/hora inválida (use AAAA-MM-DDTHH:MM).' })
const seeAll = (ctx: Ctx) => can(ctx.user, 'agenda.todas')
async function myProfessional(c: Q, ctx: Ctx) {
  return c.one(`SELECT * FROM professionals WHERE company_id = $1 AND user_id = $2`, [ctx.user.companyId, ctx.user.id])
}
/** Sem "agenda.todas", o usuário só vê/age na agenda do profissional vinculado a ele. */
async function assertProfessionalScope(c: Q, ctx: Ctx, professionalId: string) {
  if (seeAll(ctx)) return
  const me = await myProfessional(c, ctx)
  if (!me || me.id !== professionalId) throw forbidden('Você só pode agir na sua própria agenda.')
}
async function moduleOn(companyId: string, mod: string) {
  const r = await db.one(`SELECT $2 = ANY(modules) AS on FROM companies WHERE id = $1`, [companyId, mod])
  return !!r?.on
}
const customerName = `COALESCE(cu.name, a.guest_name, 'Cliente sem cadastro')`

// =====================================================================
// Serviços e pacotes (catálogo)
// =====================================================================
router.get('/api/services', { perm: ['produtos.ver', 'agenda.ver'] }, async (ctx) => {
  const q = ctx.query
  const w = new Where([['p.company_id = ?', ctx.user.companyId]])
  if (q.kind === 'todos') w.add(`p.kind IN ('servico','pacote')`)
  else w.add('p.kind = ?', q.kind === 'pacote' ? 'pacote' : 'servico')
  if (q.active !== 'all') w.add('p.active = ?', q.active !== 'false')
  if (q.q) w.add('(p.name ILIKE ? OR p.code ILIKE ?)', `%${q.q}%`, `%${q.q}%`)
  w.addIf(q.category, 'p.category_id = ?', q.category)
  const rows = await paged(db, `SELECT p.id, p.code, p.name, p.kind, p.sale_price, ${can(ctx.user, 'produtos.custo') ? 'p.cost_price,' : ''} p.duration_min, p.commission_pct, p.return_days, p.return_km, p.service_code,
                                       p.package_service_id, p.package_sessions, p.package_validity_days, p.active, p.description, p.category_id, ca.name AS category, ps.name AS package_service,
                                       (SELECT id FROM product_variants v WHERE v.product_id = p.id AND v.active ORDER BY v.created_at LIMIT 1) AS variant_id,
                                       (SELECT count(*)::int FROM professional_services x WHERE x.product_id = p.id) AS professionals,
                                       (SELECT COALESCE(sum(si.qty - si.returned_qty),0)::float8 FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id
                                         WHERE v.product_id = p.id AND s.status <> 'cancelada' AND s.type = 'venda' AND s.created_at > now() - interval '90 days') AS sold_90d
                                  FROM products p LEFT JOIN categories ca ON ca.id = p.category_id LEFT JOIN products ps ON ps.id = p.package_service_id
                                  ${w.sql} ORDER BY p.name`, w.params, q, 100)
  return rows
})

const serviceSchema = {
  kind: v.enum(['servico', 'pacote'] as const),
  code: v.string({ max: 40 }).optional(),
  name: v.string({ min: 2, max: 150 }),
  description: v.string({ max: 2000 }).optional(),
  category_id: v.uuid().nullable().optional(),
  sale_price: v.money({ min: 0, max: 1000000 }),
  cost_price: v.money({ min: 0, max: 1000000 }).optional(),
  duration_min: v.int({ min: 5, max: 720 }).nullable().optional(),
  commission_pct: v.number({ min: 0, max: 100 }).nullable().optional(),
  return_days: v.int({ min: 1, max: 730 }).nullable().optional(),
  return_km: v.int({ min: 100, max: 200000 }).nullable().optional(),
  service_code: v.string({ max: 10 }).nullable().optional(),
  package_service_id: v.uuid().nullable().optional(),
  package_sessions: v.int({ min: 1, max: 500 }).nullable().optional(),
  package_validity_days: v.int({ min: 1, max: 1825 }).nullable().optional(),
  active: v.boolean().optional(),
}
async function checkServiceRefs(c: Q, companyId: string, b: any, selfId?: string) {
  if (b.category_id && !(await c.one(`SELECT 1 FROM categories WHERE id = $1 AND company_id = $2`, [b.category_id, companyId]))) throw unprocessable('Categoria inválida.')
  if (b.kind === 'pacote') {
    if (!b.package_service_id || !b.package_sessions) throw unprocessable('Pacote exige o serviço incluído e a quantidade de sessões.')
    const s = await c.one(`SELECT kind FROM products WHERE id = $1 AND company_id = $2`, [b.package_service_id, companyId])
    if (!s || s.kind !== 'servico' || b.package_service_id === selfId) throw unprocessable('O pacote deve incluir um serviço cadastrado.')
  }
}

router.post('/api/services', { perm: 'servicos.editar' }, async (ctx) => {
  const b: any = parse(v.object(serviceSchema), ctx.body)
  return tx(async (c) => {
    await checkServiceRefs(c, ctx.user.companyId, b)
    const code = b.code || `${b.kind === 'pacote' ? 'PCT' : 'SRV'}${String(await nextNumber(c, ctx.user.companyId, 'codigo_' + b.kind)).padStart(4, '0')}`
    if (await c.one(`SELECT 1 FROM products WHERE company_id = $1 AND code = $2`, [ctx.user.companyId, code])) throw conflict(`Já existe item com o código ${code}.`)
    const p = await c.one(`INSERT INTO products(company_id, created_by, kind, code, name, description, category_id, sale_price, cost_price, duration_min, commission_pct, return_days, service_code,
                             package_service_id, package_sessions, package_validity_days, active, track_stock, unit, cfop, return_km)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17,true),false,$18,'5933',$19) RETURNING *`,
      [ctx.user.companyId, ctx.user.id, b.kind, code, b.name, b.description ?? null, b.category_id ?? null, b.sale_price, b.cost_price ?? 0, b.kind === 'servico' ? b.duration_min ?? null : null,
        b.commission_pct ?? null, b.return_days ?? null, b.service_code ?? null, b.kind === 'pacote' ? b.package_service_id : null, b.kind === 'pacote' ? b.package_sessions : null,
        b.kind === 'pacote' ? b.package_validity_days ?? null : null, b.active ?? null, b.kind === 'pacote' ? 'PCT' : 'UN', b.kind === 'servico' ? b.return_km ?? null : null])
    const [variant] = await createVariants(c, ctx.user.companyId, p, [{ size_id: null, color_id: null }])
    await audit(c, ctx, b.kind === 'pacote' ? 'pacote.criado' : 'servico.criado', 'product', p.id, { code, name: b.name, price: b.sale_price })
    return { ...p, variant_id: variant?.id }
  })
})

router.put('/api/services/:id', { perm: 'servicos.editar' }, async (ctx) => {
  const partial: any = {}
  for (const [k, s] of Object.entries(serviceSchema)) if (k !== 'kind') partial[k] = (s as any).optional()
  const b: any = parse(v.object(partial), ctx.body)
  return tx(async (c) => {
    const cur = await c.one(`SELECT * FROM products WHERE id = $1 AND company_id = $2 AND kind IN ('servico','pacote') FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!cur) throw notFound('Serviço')
    const merged = { ...cur, ...b, kind: cur.kind }
    await checkServiceRefs(c, ctx.user.companyId, merged, cur.id)
    const keys = Object.keys(partial).filter((k) => k in ctx.body && k !== 'code' && !(k === 'cost_price' && !can(ctx.user, 'produtos.custo')))
    if (!keys.length) throw unprocessable('Nada para alterar.')
    const r = await c.one(`UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [cur.id, ctx.user.companyId, ...keys.map((k) => b[k] ?? null)])
    await audit(c, ctx, 'servico.alterado', 'product', cur.id, { ...b, preco_anterior: cur.sale_price }, Number(cur.sale_price) !== Number(r.sale_price) ? 'warning' : 'info')
    return r
  })
})

// =====================================================================
// Profissionais
// =====================================================================
router.get('/api/professionals', { perm: ['agenda.ver', 'profissionais.editar', 'comissoes.ver'] }, async (ctx) => {
  const w = new Where([['pr.company_id = ?', ctx.user.companyId]])
  if (ctx.query.active !== 'all') w.add('pr.active')
  const rows = await db.many(`SELECT pr.*, u.name AS user_name, u.email AS user_email, b.name AS branch,
                                     COALESCE((SELECT json_agg(json_build_object('product_id', ps.product_id, 'name', p.name, 'commission_pct', ps.commission_pct, 'duration_min', ps.duration_min) ORDER BY p.name)
                                                 FROM professional_services ps JOIN products p ON p.id = ps.product_id WHERE ps.professional_id = pr.id), '[]') AS services
                                FROM professionals pr LEFT JOIN users u ON u.id = pr.user_id LEFT JOIN branches b ON b.id = pr.branch_id ${w.sql} ORDER BY pr.active DESC, pr.name`, w.params)
  const me = rows.find((r) => r.user_id === ctx.user.id)
  return { items: rows, mine: me?.id ?? null, canSeeAll: seeAll(ctx) }
})

const profSchema = {
  name: v.string({ min: 2, max: 120 }),
  user_id: v.uuid().nullable().optional(),
  branch_id: v.uuid().nullable().optional(),
  specialty: v.string({ max: 120 }).nullable().optional(),
  council_id: v.string({ max: 40 }).nullable().optional(),
  phone: v.string({ max: 20 }).nullable().optional(),
  email: v.email().nullable().optional(),
  color: v.string({ pattern: /^#[0-9A-Fa-f]{6}$/, patternMsg: 'Cor inválida (use #RRGGBB).' }).optional(),
  commission_services_pct: v.number({ min: 0, max: 100 }).optional(),
  commission_products_pct: v.number({ min: 0, max: 100 }).optional(),
  work_hours: v.json().optional(),
  slot_min: v.int({ min: 5, max: 240 }).optional(),
  active: v.boolean().optional(),
  services: v.array(v.object({ product_id: v.uuid(), commission_pct: v.number({ min: 0, max: 100 }).nullable().optional(), duration_min: v.int({ min: 5, max: 720 }).nullable().optional() }), { max: 300 }).optional(),
}
async function saveProfessionalServices(c: Q, companyId: string, profId: string, list?: any[]) {
  if (!list) return
  await c.query(`DELETE FROM professional_services WHERE professional_id = $1`, [profId])
  for (const s of list) {
    const p = await c.one(`SELECT kind FROM products WHERE id = $1 AND company_id = $2`, [s.product_id, companyId])
    if (!p || p.kind !== 'servico') throw unprocessable('Serviço inválido na lista do profissional.')
    await c.query(`INSERT INTO professional_services(professional_id, product_id, company_id, commission_pct, duration_min) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [profId, s.product_id, companyId, s.commission_pct ?? null, s.duration_min ?? null])
  }
}
async function checkProfRefs(c: Q, companyId: string, b: any, selfId?: string) {
  if (b.user_id) {
    if (!(await c.one(`SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2 AND active`, [b.user_id, companyId]))) throw unprocessable('Usuário não pertence a esta empresa.')
    const dup = await c.one(`SELECT name FROM professionals WHERE company_id = $1 AND user_id = $2 AND id IS DISTINCT FROM $3`, [companyId, b.user_id, selfId ?? null])
    if (dup) throw conflict(`Este usuário já está vinculado ao profissional ${dup.name}.`)
  }
  if (b.branch_id && !(await c.one(`SELECT 1 FROM branches WHERE id = $1 AND company_id = $2`, [b.branch_id, companyId]))) throw unprocessable('Filial inválida.')
}
const DEFAULT_HOURS = { 1: [['09:00', '12:00'], ['13:00', '18:00']], 2: [['09:00', '12:00'], ['13:00', '18:00']], 3: [['09:00', '12:00'], ['13:00', '18:00']],
  4: [['09:00', '12:00'], ['13:00', '18:00']], 5: [['09:00', '12:00'], ['13:00', '18:00']], 6: [['09:00', '13:00']] }

router.post('/api/professionals', { perm: 'profissionais.editar' }, async (ctx) => {
  const b: any = parse(v.object(profSchema), ctx.body)
  return tx(async (c) => {
    await checkProfRefs(c, ctx.user.companyId, b)
    const hours = normalizeWorkHours(b.work_hours ?? DEFAULT_HOURS)
    const r = await c.one(`INSERT INTO professionals(company_id, branch_id, user_id, name, specialty, council_id, phone, email, color, commission_services_pct, commission_products_pct, work_hours, slot_min, active)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'#0875D1'),COALESCE($10,0),COALESCE($11,0),$12,COALESCE($13,30),COALESCE($14,true)) RETURNING *`,
      [ctx.user.companyId, b.branch_id ?? null, b.user_id ?? null, b.name, b.specialty ?? null, b.council_id ?? null, b.phone ?? null, b.email ?? null, b.color ?? null,
        b.commission_services_pct ?? null, b.commission_products_pct ?? null, JSON.stringify(hours), b.slot_min ?? null, b.active ?? null])
    await saveProfessionalServices(c, ctx.user.companyId, r.id, b.services)
    await audit(c, ctx, 'profissional.criado', 'professional', r.id, { name: b.name, user: b.user_id ?? null })
    return r
  })
})

router.put('/api/professionals/:id', { perm: 'profissionais.editar' }, async (ctx) => {
  const partial: any = {}
  for (const [k, s] of Object.entries(profSchema)) partial[k] = (s as any).optional()
  const b: any = parse(v.object(partial), ctx.body)
  return tx(async (c) => {
    const cur = await c.one(`SELECT * FROM professionals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!cur) throw notFound('Profissional')
    await checkProfRefs(c, ctx.user.companyId, { ...cur, ...b }, cur.id)
    if ('work_hours' in ctx.body) b.work_hours = JSON.stringify(normalizeWorkHours(b.work_hours))
    const keys = Object.keys(profSchema).filter((k) => k in ctx.body && k !== 'services')
    if (keys.length) await c.query(`UPDATE professionals SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND company_id = $2`,
      [cur.id, ctx.user.companyId, ...keys.map((k) => b[k] ?? (k === 'name' ? cur.name : null))])
    await saveProfessionalServices(c, ctx.user.companyId, cur.id, b.services)
    await audit(c, ctx, 'profissional.alterado', 'professional', cur.id, { ...b, work_hours: undefined, services: b.services?.length })
    return c.one(`SELECT * FROM professionals WHERE id = $1`, [cur.id])
  })
})

/** "Eu também atendo": vincula o usuário logado (ex.: gerente/dono) como profissional da agenda. */
router.post('/api/professionals/me', { perm: 'profissionais.editar' }, async (ctx) => {
  const b: any = parse(v.object({ specialty: v.string({ max: 120 }).optional(), color: v.string({ pattern: /^#[0-9A-Fa-f]{6}$/ }).optional() }), ctx.body || {})
  return tx(async (c) => {
    const ex = await myProfessional(c, ctx)
    if (ex) return ex
    const r = await c.one(`INSERT INTO professionals(company_id, user_id, name, email, specialty, color, work_hours) VALUES ($1,$2,$3,$4,$5,COALESCE($6,'#18864B'),$7) RETURNING *`,
      [ctx.user.companyId, ctx.user.id, ctx.user.name, ctx.user.email, b.specialty ?? null, b.color ?? null, JSON.stringify(DEFAULT_HOURS)])
    await audit(c, ctx, 'profissional.criado', 'professional', r.id, { name: ctx.user.name, user: ctx.user.id, proprio: true })
    return r
  })
})

// =====================================================================
// Agenda
// =====================================================================
const APPT_SELECT = (tz: string) => `
  SELECT a.id, a.number, a.professional_id, a.customer_id, a.guest_name, a.guest_phone, ${customerName} AS customer, COALESCE(cu.whatsapp, cu.phone, a.guest_phone) AS phone,
         to_char(a.start_at AT TIME ZONE '${tz}', 'YYYY-MM-DD"T"HH24:MI') AS start_local, to_char(a.end_at AT TIME ZONE '${tz}', 'YYYY-MM-DD"T"HH24:MI') AS end_local,
         (extract(epoch FROM a.end_at - a.start_at) / 60)::int AS duration_min, a.status, a.source, a.room, a.notes, a.sale_id, a.treatment_plan_id, pr.name AS professional, pr.color,
         COALESCE((SELECT json_agg(json_build_object('id', s.id, 'product_id', s.product_id, 'variant_id', s.variant_id, 'name', p.name, 'price', s.price, 'duration_min', s.duration_min,
                     'professional_id', s.professional_id, 'professional', sp.name, 'customer_package_id', s.customer_package_id, 'plan_item_id', s.plan_item_id, 'status', s.status, 'billed', s.sale_item_id IS NOT NULL) ORDER BY s.sort)
                     FROM appointment_services s JOIN products p ON p.id = s.product_id JOIN professionals sp ON sp.id = s.professional_id WHERE s.appointment_id = a.id), '[]') AS services,
         (SELECT COALESCE(sum(s.price),0) FROM appointment_services s WHERE s.appointment_id = a.id) AS total,
         (SELECT number FROM sales WHERE id = a.sale_id) AS sale_number
    FROM appointments a JOIN professionals pr ON pr.id = a.professional_id LEFT JOIN customers cu ON cu.id = a.customer_id`

router.get('/api/agenda', { perm: 'agenda.ver' }, async (ctx) => {
  const tz = await companyTz(db, ctx.user.companyId)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date || '') ? ctx.query.date : (await db.one(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [tz])).d
  const days = Math.min(7, Math.max(1, parseInt(ctx.query.days || '1', 10) || 1))
  const me = await myProfessional(db, ctx)
  const all = seeAll(ctx)
  const profs = await db.many(`SELECT id, name, color, specialty, work_hours, slot_min, user_id FROM professionals
                                WHERE company_id = $1 AND active AND (branch_id IS NULL OR branch_id = $2) AND ($3::uuid IS NULL OR id = $3) ORDER BY name`,
    [ctx.user.companyId, ctx.user.branchId, all ? (ctx.query.professional || null) : (me?.id ?? '00000000-0000-0000-0000-000000000000')])
  const ids = profs.map((p) => p.id)
  const range = await db.one(`SELECT ($1::date::timestamp AT TIME ZONE $3) AS ini, (($1::date + $2::int)::timestamp AT TIME ZONE $3) AS fim`, [date, days, tz])
  const appointments = ids.length ? await db.many(`${APPT_SELECT(tz)} WHERE a.company_id = $1 AND a.branch_id = $2 AND a.professional_id = ANY($3::uuid[]) AND a.start_at < $5 AND a.end_at > $4
                                                    ${ctx.query.cancelled === 'true' ? '' : `AND a.status NOT IN ('cancelado')`} ORDER BY a.start_at`, [ctx.user.companyId, ctx.user.branchId, ids, range.ini, range.fim]) : []
  const blocks = ids.length ? await db.many(`SELECT id, professional_id, reason, to_char(start_at AT TIME ZONE $4, 'YYYY-MM-DD"T"HH24:MI') AS start_local, to_char(end_at AT TIME ZONE $4, 'YYYY-MM-DD"T"HH24:MI') AS end_local
                                               FROM schedule_blocks WHERE professional_id = ANY($1::uuid[]) AND start_at < $3 AND end_at > $2 ORDER BY start_at`, [ids, range.ini, range.fim, tz]) : []
  const settings = await getSettings(db, ctx.user.companyId)
  const summary = {
    total: appointments.filter((a) => a.status !== 'cancelado').length,
    concluidos: appointments.filter((a) => a.status === 'concluido').length,
    faltas: appointments.filter((a) => a.status === 'faltou').length,
    previsto: r2(appointments.filter((a) => !['cancelado', 'faltou'].includes(a.status)).reduce((s, a) => s + Number(a.total), 0)),
  }
  return { tz, date, days, professionals: profs, appointments, blocks, mine: me?.id ?? null, canSeeAll: all, settings: settings.agenda, summary }
})

/** Horários livres de um profissional em um dia para a duração informada. */
router.get('/api/agenda/slots', { perm: 'agenda.ver' }, async (ctx) => {
  const professionalId = String(ctx.query.professionalId || '')
  const date = String(ctx.query.date || '')
  const duration = Math.min(720, Math.max(5, parseInt(ctx.query.duration || '30', 10) || 30))
  if (!/^[0-9a-f-]{36}$/i.test(professionalId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw unprocessable('Informe profissional e data.')
  const tz = await companyTz(db, ctx.user.companyId)
  const pr = await db.one(`SELECT * FROM professionals WHERE id = $1 AND company_id = $2`, [professionalId, ctx.user.companyId])
  if (!pr) throw notFound('Profissional')
  const d = await db.one(`SELECT extract(dow FROM $1::date)::int AS dow, to_char(now() AT TIME ZONE $2, 'YYYY-MM-DD"T"HH24:MI') AS now_local`, [date, tz])
  const day: [string, string][] = Object.keys(pr.work_hours || {}).length ? (pr.work_hours[String(d.dow)] || []) : [['08:00', '20:00']]
  const busy = await db.many(`SELECT to_char(start_at AT TIME ZONE $3, 'HH24:MI') AS a, to_char(end_at AT TIME ZONE $3, 'HH24:MI') AS b FROM appointments
                               WHERE professional_id = $1 AND status = ANY($4) AND (start_at AT TIME ZONE $3)::date = $2::date
                              UNION ALL
                              SELECT to_char(GREATEST(start_at, ($2::date::timestamp AT TIME ZONE $3)) AT TIME ZONE $3, 'HH24:MI'), CASE WHEN end_at >= (($2::date + 1)::timestamp AT TIME ZONE $3) THEN '24:00' ELSE to_char(end_at AT TIME ZONE $3, 'HH24:MI') END
                                FROM schedule_blocks WHERE professional_id = $1 AND start_at < (($2::date + 1)::timestamp AT TIME ZONE $3) AND end_at > ($2::date::timestamp AT TIME ZONE $3)`,
    [pr.id, date, tz, ACTIVE_STATUSES])
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const step = pr.slot_min || 30
  const slots: string[] = []
  for (const [a, b] of day) {
    for (let t = toMin(a); t + duration <= toMin(b); t += step) {
      const start = `${date}T${fmt(t)}`
      if (start <= d.now_local) continue
      if (busy.some((x) => t < toMin(x.b) && t + duration > toMin(x.a))) continue
      slots.push(fmt(t))
    }
  }
  return { date, professionalId: pr.id, duration, hours: day, slots }
})

const apptSchema = {
  professionalId: v.uuid(),
  customerId: v.uuid().nullable().optional(),
  guestName: v.string({ max: 120 }).nullable().optional(),
  guestPhone: v.string({ max: 20 }).nullable().optional(),
  start: localDt(),
  services: v.array(v.object({ productId: v.uuid(), professionalId: v.uuid().optional(), customerPackageId: v.uuid().optional(), planItemId: v.uuid().optional() }), { min: 1, max: 20 }),
  room: v.string({ max: 60 }).nullable().optional(),
  notes: v.string({ max: 1000 }).nullable().optional(),
  source: v.enum(['balcao', 'telefone', 'whatsapp', 'online', 'retorno', 'plano'] as const).optional(),
  ignoreHours: v.boolean().optional(),
}
async function allowOutside(c: Q, ctx: Ctx, requested?: boolean) {
  const s = await getSettings(c, ctx.user.companyId)
  return !!s.agenda.permitirForaDoExpediente || (!!requested && seeAll(ctx))
}
async function saveServices(c: Q, companyId: string, appointmentId: string, list: any[]) {
  await c.query(`DELETE FROM appointment_services WHERE appointment_id = $1`, [appointmentId])
  let i = 0
  for (const s of list) {
    await c.query(`INSERT INTO appointment_services(appointment_id, company_id, product_id, variant_id, professional_id, duration_min, price, customer_package_id, plan_item_id, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [appointmentId, companyId, s.productId, s.variantId, s.professionalId, s.durationMin, s.price, s.customerPackageId, s.planItemId, i++])
  }
}

router.post('/api/appointments', { perm: 'agenda.editar', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object(apptSchema), ctx.body)
  if (!b.customerId && !b.guestName) throw unprocessable('Selecione o cliente ou informe o nome de quem será atendido.')
  return tx(async (c) => {
    await assertProfessionalScope(c, ctx, b.professionalId)
    if (b.customerId) {
      const cu = await c.one(`SELECT id, active, anonymized_at FROM customers WHERE id = $1 AND company_id = $2`, [b.customerId, ctx.user.companyId])
      if (!cu || cu.anonymized_at || !cu.active) throw unprocessable('Cliente não encontrado ou inativo.')
    }
    const services = await resolveServices(c, ctx.user.companyId, b.customerId ?? null, b.services, b.professionalId)
    const duration = services.reduce((s, x) => s + x.durationMin, 0)
    const slot = await checkSlot(c, { companyId: ctx.user.companyId, branchId: ctx.user.branchId, professionalId: b.professionalId, startLocal: b.start, durationMin: duration, allowOutsideHours: await allowOutside(c, ctx, b.ignoreHours) })
    const number = await nextNumber(c, ctx.user.companyId, 'agendamento')
    const planId = services.find((s) => s.planItemId) ? (await c.one(`SELECT plan_id FROM treatment_plan_items WHERE id = $1`, [services.find((s) => s.planItemId)!.planItemId])).plan_id : null
    const a = await c.one(`INSERT INTO appointments(company_id, branch_id, number, professional_id, customer_id, guest_name, guest_phone, start_at, end_at, room, notes, source, treatment_plan_id, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, number`,
      [ctx.user.companyId, ctx.user.branchId, number, b.professionalId, b.customerId ?? null, b.customerId ? null : b.guestName, b.customerId ? null : (b.guestPhone ?? null),
        slot.startAt, slot.endAt, b.room ?? null, b.notes ?? null, b.source ?? (planId ? 'plano' : 'balcao'), planId, ctx.user.id])
    await saveServices(c, ctx.user.companyId, a.id, services)
    await audit(c, ctx, 'agenda.agendado', 'appointment', a.id, { number, professional: slot.professional.name, start: b.start, services: services.map((s) => s.name) })
    return (await c.one(`${APPT_SELECT(slot.tz)} WHERE a.id = $1`, [a.id]))
  })
})

router.get('/api/appointments/:id', { perm: 'agenda.ver' }, async (ctx) => {
  const tz = await companyTz(db, ctx.user.companyId)
  const a = await db.one(`${APPT_SELECT(tz)} WHERE a.id = $1 AND a.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!a) throw notFound('Agendamento')
  await assertProfessionalScope(db, ctx, a.professional_id)
  return a
})

router.put('/api/appointments/:id', { perm: 'agenda.editar' }, async (ctx) => {
  const partial: any = {}
  for (const [k, s] of Object.entries(apptSchema)) partial[k] = (s as any).optional()
  const b: any = parse(v.object(partial), ctx.body)
  return tx(async (c) => {
    const cur = await c.one(`SELECT * FROM appointments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!cur) throw notFound('Agendamento')
    await assertProfessionalScope(c, ctx, cur.professional_id)
    if (b.professionalId) await assertProfessionalScope(c, ctx, b.professionalId)
    if (!['agendado', 'confirmado'].includes(cur.status)) throw conflict('Só é possível remarcar atendimentos agendados ou confirmados.')
    const tz = await companyTz(c, ctx.user.companyId)
    const profId = b.professionalId ?? cur.professional_id
    const customerId = 'customerId' in ctx.body ? (b.customerId ?? null) : cur.customer_id
    let services: any[]
    if (b.services) services = await resolveServices(c, ctx.user.companyId, customerId, b.services, profId)
    else {
      const ex = await c.many(`SELECT product_id, professional_id, customer_package_id, plan_item_id FROM appointment_services WHERE appointment_id = $1 ORDER BY sort`, [cur.id])
      services = await resolveServices(c, ctx.user.companyId, customerId, ex.map((s) => ({ productId: s.product_id, professionalId: s.professional_id === cur.professional_id ? profId : s.professional_id,
        customerPackageId: s.customer_package_id ?? undefined, planItemId: s.plan_item_id ?? undefined })), profId)
    }
    const start = b.start ?? (await c.one(`SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD"T"HH24:MI') AS s`, [cur.start_at, tz])).s
    const duration = services.reduce((s, x) => s + x.durationMin, 0)
    const slot = await checkSlot(c, { companyId: ctx.user.companyId, branchId: cur.branch_id, professionalId: profId, startLocal: start, durationMin: duration, excludeAppointmentId: cur.id,
      allowOutsideHours: await allowOutside(c, ctx, b.ignoreHours) })
    await c.query(`UPDATE appointments SET professional_id = $2, customer_id = $3, start_at = $4, end_at = $5, room = $6, notes = $7, guest_name = $8, guest_phone = $9, updated_at = now() WHERE id = $1`,
      [cur.id, profId, customerId, slot.startAt, slot.endAt, 'room' in ctx.body ? b.room ?? null : cur.room, 'notes' in ctx.body ? b.notes ?? null : cur.notes,
        customerId ? null : (b.guestName ?? cur.guest_name), customerId ? null : (b.guestPhone ?? cur.guest_phone)])
    await saveServices(c, ctx.user.companyId, cur.id, services)
    await audit(c, ctx, 'agenda.remarcado', 'appointment', cur.id, { number: cur.number, start, professional: slot.professional.name })
    return c.one(`${APPT_SELECT(tz)} WHERE a.id = $1`, [cur.id])
  })
})

router.post('/api/appointments/:id/status', { perm: 'agenda.editar' }, async (ctx) => {
  const b: any = parse(v.object({ status: v.enum(['confirmado', 'em_atendimento', 'cancelado', 'faltou', 'agendado'] as const), reason: v.string({ max: 300 }).optional() }), ctx.body)
  return tx(async (c) => {
    const cur = await c.one(`SELECT * FROM appointments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!cur) throw notFound('Agendamento')
    await assertProfessionalScope(c, ctx, cur.professional_id)
    const allowed: Record<string, string[]> = {
      confirmado: ['agendado'], em_atendimento: ['agendado', 'confirmado'], cancelado: ['agendado', 'confirmado', 'em_atendimento'], faltou: ['agendado', 'confirmado'],
      agendado: ['faltou', 'confirmado'],
    }
    if (!allowed[b.status].includes(cur.status)) throw conflict(`Não é possível mudar de "${cur.status}" para "${b.status}".`)
    if (b.status === 'cancelado' && (!b.reason || b.reason.trim().length < 3)) throw unprocessable('Informe o motivo do cancelamento.')
    if (b.status === 'faltou' && new Date(cur.start_at).getTime() > Date.now()) throw unprocessable('Falta só pode ser registrada depois do horário marcado.')
    const r = await c.one(`UPDATE appointments SET status = $2, updated_at = now(),
                             confirmed_at = CASE WHEN $2 = 'confirmado' THEN now() ELSE confirmed_at END,
                             arrived_at = CASE WHEN $2 = 'em_atendimento' THEN now() ELSE arrived_at END,
                             cancelled_at = CASE WHEN $2 = 'cancelado' THEN now() ELSE cancelled_at END,
                             cancel_reason = CASE WHEN $2 IN ('cancelado','faltou') THEN $3 ELSE cancel_reason END
                           WHERE id = $1 RETURNING id, status`, [cur.id, b.status, b.reason ?? null])
    await audit(c, ctx, 'agenda.status', 'appointment', cur.id, { number: cur.number, de: cur.status, para: b.status, motivo: b.reason ?? null }, b.status === 'cancelado' ? 'warning' : 'info')
    return r
  })
})

/** Conclui sem cobrar (ex.: sessão de pacote, procedimento do plano já pago, retorno sem custo). */
router.post('/api/appointments/:id/complete', { perm: 'agenda.editar', idempotent: true }, async (ctx) => tx(async (c) => {
  const cur = await c.one(`SELECT professional_id, number FROM appointments WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!cur) throw notFound('Agendamento')
  await assertProfessionalScope(c, ctx, cur.professional_id)
  const r = await completeAppointment(c, { companyId: ctx.user.companyId, userId: ctx.user.id }, ctx.params.id)
  await audit(c, ctx, 'agenda.concluido', 'appointment', ctx.params.id, { number: cur.number })
  return r
}))

/** Itens para cobrar o atendimento no PDV (preço e profissional definidos no agendamento). */
router.get('/api/appointments/:id/checkout', { perm: ['agenda.ver', 'vendas.criar'] }, async (ctx) => {
  const a = await db.one(`SELECT a.*, cu.name AS customer_name FROM appointments a LEFT JOIN customers cu ON cu.id = a.customer_id WHERE a.id = $1 AND a.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!a) throw notFound('Agendamento')
  if (['cancelado', 'faltou'].includes(a.status)) throw conflict('Atendimento cancelado ou com falta.')
  const items = await db.many(`SELECT s.id AS appointment_service_id, s.price, s.professional_id, pr.name AS professional, s.customer_package_id, s.plan_item_id, s.sale_item_id,
                                      v.id AS variant_id, v.sku, v.barcode, p.name, p.kind
                                 FROM appointment_services s JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = s.product_id JOIN professionals pr ON pr.id = s.professional_id
                                WHERE s.appointment_id = $1 AND s.status <> 'cancelado' ORDER BY s.sort`, [a.id])
  const customer = a.customer_id ? await db.one(`SELECT c.*, (SELECT COALESCE(sum(amount + interest + fine - discount - paid_amount),0) FROM receivables r WHERE r.customer_id = c.id AND r.method_kind = 'crediario' AND r.status IN ('aberto','parcial')) AS open_balance
                                                   FROM customers c WHERE c.id = $1`, [a.customer_id]) : null
  return { appointment: { id: a.id, number: a.number, status: a.status, guest_name: a.guest_name, sale_id: a.sale_id }, customer,
    items: items.filter((i) => !i.customer_package_id && !i.plan_item_id && !i.sale_item_id && Number(i.price) > 0),
    covered: items.filter((i) => i.customer_package_id || i.plan_item_id), billed: items.filter((i) => i.sale_item_id) }
})

router.post('/api/schedule-blocks', { perm: 'agenda.editar' }, async (ctx) => {
  const b: any = parse(v.object({ professionalId: v.uuid(), start: localDt(), end: localDt(), reason: v.string({ max: 200 }).optional() }), ctx.body)
  if (b.end <= b.start) throw unprocessable('O fim do bloqueio deve ser depois do início.')
  return tx(async (c) => {
    await assertProfessionalScope(c, ctx, b.professionalId)
    const tz = await companyTz(c, ctx.user.companyId)
    const pr = await c.one(`SELECT id, name FROM professionals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [b.professionalId, ctx.user.companyId])
    if (!pr) throw notFound('Profissional')
    const clash = await c.one(`SELECT count(*)::int AS n FROM appointments WHERE professional_id = $1 AND status = ANY($4) AND start_at < ($3::timestamp AT TIME ZONE $5) AND end_at > ($2::timestamp AT TIME ZONE $5)`,
      [pr.id, b.start, b.end, ['agendado', 'confirmado', 'em_atendimento'], tz])
    if (clash.n > 0) throw conflict(`Há ${clash.n} atendimento(s) marcado(s) nesse período: remarque-os antes de bloquear.`)
    const r = await c.one(`INSERT INTO schedule_blocks(company_id, professional_id, start_at, end_at, reason, created_by) VALUES ($1,$2,($3::timestamp AT TIME ZONE $6),($4::timestamp AT TIME ZONE $6),$5,$7) RETURNING id`,
      [ctx.user.companyId, pr.id, b.start, b.end, b.reason ?? null, tz, ctx.user.id])
    await audit(c, ctx, 'agenda.bloqueio', 'professional', pr.id, { start: b.start, end: b.end, reason: b.reason ?? null })
    return r
  })
})
router.delete('/api/schedule-blocks/:id', { perm: 'agenda.editar' }, async (ctx) => tx(async (c) => {
  const bl = await c.one(`SELECT * FROM schedule_blocks WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!bl) throw notFound('Bloqueio')
  await assertProfessionalScope(c, ctx, bl.professional_id)
  await c.query(`DELETE FROM schedule_blocks WHERE id = $1`, [bl.id])
  await audit(c, ctx, 'agenda.bloqueio_removido', 'professional', bl.professional_id, null)
  return { ok: true }
}))

/** Lembretes: atendimentos do dia seguinte (ou da data) e situação do envio por WhatsApp. */
router.get('/api/appointments-reminders', { perm: 'agenda.ver' }, async (ctx) => {
  const tz = await companyTz(db, ctx.user.companyId)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date || '') ? ctx.query.date : (await db.one(`SELECT ((now() AT TIME ZONE $1)::date + 1)::text AS d`, [tz])).d
  const me = await myProfessional(db, ctx)
  return db.many(`${APPT_SELECT(tz)} WHERE a.company_id = $1 AND a.branch_id = $2 AND (a.start_at AT TIME ZONE '${tz}')::date = $3::date AND a.status IN ('agendado','confirmado')
                  AND ($4::uuid IS NULL OR a.professional_id = $4) ORDER BY a.start_at`, [ctx.user.companyId, ctx.user.branchId, date, seeAll(ctx) ? null : (me?.id ?? '00000000-0000-0000-0000-000000000000')])
    .then(async (rows) => {
      const msgs = rows.length ? await db.many(`SELECT ref_id, status FROM messages WHERE company_id = $1 AND ref_type = 'appointment' AND ref_id = ANY($2::text[]) ORDER BY created_at`, [ctx.user.companyId, rows.map((r) => r.id)]) : []
      const consent = rows.length ? await db.many(`SELECT DISTINCT ON (customer_id) customer_id, granted FROM customer_consents WHERE company_id = $1 AND channel = 'whatsapp' AND customer_id = ANY($2::uuid[]) ORDER BY customer_id, created_at DESC`,
        [ctx.user.companyId, rows.filter((r) => r.customer_id).map((r) => r.customer_id)]) : []
      return rows.map((r) => ({ ...r, reminder_status: msgs.filter((m) => m.ref_id === r.id).pop()?.status ?? null, whatsapp_consent: consent.find((x) => x.customer_id === r.customer_id)?.granted ?? false }))
    })
})

router.post('/api/appointments/:id/remind', { perm: ['agenda.editar', 'mensagens.enviar'] }, async (ctx) => {
  const a = await db.one(`SELECT id, customer_id, professional_id, number FROM appointments WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!a) throw notFound('Agendamento')
  if (!a.customer_id) throw unprocessable('Cliente sem cadastro: cadastre o cliente (com consentimento de WhatsApp) para enviar lembretes.')
  await assertProfessionalScope(db, ctx, a.professional_id)
  const m: any = await tx((c) => queueMessage(c, ctx, { customerId: a.customer_id, purpose: 'agendamento', refType: 'appointment', refId: a.id,
    body: 'Olá, {nome}! Lembrete do seu horário na {loja}: {servico} com {profissional} em {data} às {hora}. Responda esta mensagem para confirmar ou remarcar.' }))
  await audit(null, ctx, 'agenda.lembrete', 'appointment', a.id, { number: a.number, status: m?.status })
  return m
})

// =====================================================================
// Comissões por profissional
// =====================================================================
router.get('/api/professional-commissions', { perm: 'comissoes.ver' }, async (ctx) => {
  const from = ctx.query.from || (await db.one(`SELECT date_trunc('month', now())::date::text AS d`)).d
  const to = ctx.query.to || today()
  const me = await myProfessional(db, ctx)
  const own = !seeAll(ctx) && !can(ctx.user, 'comissoes.editar')
  const w = new Where([['pc.company_id = ?', ctx.user.companyId], ['pc.created_at >= ?::date', from], [`pc.created_at < ?::date + interval '1 day'`, to]])
  if (own) w.add('pc.professional_id = ?', me?.id ?? '00000000-0000-0000-0000-000000000000')
  else w.addIf(ctx.query.professional, 'pc.professional_id = ?', ctx.query.professional)
  w.addIf(ctx.query.status, 'pc.status = ?', ctx.query.status)
  const list = await paged(db, `SELECT pc.*, pr.name AS professional, s.number AS sale_number FROM professional_commissions pc JOIN professionals pr ON pr.id = pc.professional_id
                                  LEFT JOIN sales s ON s.id = pc.sale_id ${w.sql} ORDER BY pc.created_at DESC`, w.params, ctx.query, 50)
  const summary = await db.many(`SELECT pr.id, pr.name, pr.color,
                                        COALESCE(sum(pc.amount) FILTER (WHERE pc.kind = 'servico'),0) AS servicos,
                                        COALESCE(sum(pc.amount) FILTER (WHERE pc.kind = 'produto'),0) AS produtos,
                                        COALESCE(sum(pc.amount) FILTER (WHERE pc.kind = 'sessao_pacote'),0) AS sessoes,
                                        COALESCE(sum(pc.base_amount),0) AS base, COALESCE(sum(pc.amount),0) AS total,
                                        COALESCE(sum(pc.amount) FILTER (WHERE pc.status = 'prevista'),0) AS aberto, COALESCE(sum(pc.amount) FILTER (WHERE pc.status = 'paga'),0) AS fechado
                                   FROM professional_commissions pc JOIN professionals pr ON pr.id = pc.professional_id ${w.sql} GROUP BY pr.id ORDER BY total DESC`, w.params)
  return { ...list, summary, period: { from, to } }
})

/** Fecha as comissões em aberto do período e gera a conta a pagar do profissional. */
router.post('/api/professional-commissions/close', { perm: 'comissoes.editar', idempotent: true }, async (ctx) => {
  const b: any = parse(v.object({ professionalId: v.uuid(), from: v.date(), to: v.date(), dueDate: v.date().optional(), createPayable: v.boolean().default(true) }), ctx.body)
  return tx(async (c) => {
    const pr = await c.one(`SELECT * FROM professionals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [b.professionalId, ctx.user.companyId])
    if (!pr) throw notFound('Profissional')
    const rows = await c.many(`SELECT id, amount FROM professional_commissions WHERE company_id = $1 AND professional_id = $2 AND status = 'prevista'
                                AND created_at >= $3::date AND created_at < $4::date + interval '1 day' FOR UPDATE`, [ctx.user.companyId, pr.id, b.from, b.to])
    const total = r2(rows.reduce((s, r) => s + Number(r.amount), 0))
    if (!rows.length || total <= 0) throw unprocessable('Não há comissão em aberto (positiva) para fechar neste período.')
    await c.query(`UPDATE professional_commissions SET status = 'paga', paid_at = now(), paid_by = $2 WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id), ctx.user.id])
    let payableId: string | null = null
    if (b.createPayable) {
      const p = await c.one(`INSERT INTO payables(company_id, branch_id, source_type, document, category_id, due_date, amount, description, created_by)
                             VALUES ($1,$2,'comissao_profissional',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.user.companyId, pr.branch_id ?? ctx.user.branchId, `COM-${b.to.slice(0, 7).replace('-', '')}-${pr.name.split(' ')[0].toUpperCase().slice(0, 10)}`, await systemCategory(c, ctx.user.companyId, 'comissoes'),
          b.dueDate ?? addDays(today(), 5), total, `Comissão ${pr.name} — ${b.from} a ${b.to} (${rows.length} lançamento(s))`, ctx.user.id])
      payableId = p.id
    }
    await audit(c, ctx, 'comissao.profissional_fechada', 'professional', pr.id, { from: b.from, to: b.to, total, lancamentos: rows.length, payableId }, 'warning')
    return { total, count: rows.length, payableId }
  })
})

// =====================================================================
// Pacotes do cliente
// =====================================================================
router.get('/api/customers/:id/packages', { perm: ['clientes.ver', 'agenda.ver'] }, async (ctx) =>
  db.many(`SELECT cp.*, (cp.sessions_total - cp.sessions_used) AS remaining, pk.name AS package_name, sv.name AS service_name, s.number AS sale_number,
                  (cp.expires_at IS NOT NULL AND cp.expires_at < current_date) AS expired
             FROM customer_packages cp JOIN products pk ON pk.id = cp.package_product_id JOIN products sv ON sv.id = cp.service_product_id LEFT JOIN sales s ON s.id = cp.sale_id
            WHERE cp.customer_id = $1 AND cp.company_id = $2 ORDER BY (cp.status = 'ativo') DESC, cp.created_at DESC`, [ctx.params.id, ctx.user.companyId]))

// =====================================================================
// Prontuário / fichas (dados de saúde: acesso auditado, registros somente acrescentados)
// =====================================================================
router.get('/api/clinical/templates', { perm: 'prontuario.ver' }, async (ctx) => {
  const co = await db.one(`SELECT segment FROM companies WHERE id = $1`, [ctx.user.companyId])
  return anamneseTemplates(co?.segment)
})

function anamneseAlerts(rec: any) {
  if (!rec) return []
  const tpl = ANAMNESE[rec.data?.template] ?? []
  const out: string[] = []
  for (const f of tpl) {
    if (!f.alert) continue
    const val = rec.data?.answers?.[f.key]
    if (val === true || val === 'sim' || (typeof val === 'string' && val.trim() && !['nao', 'não', 'n'].includes(val.trim().toLowerCase()))) out.push(typeof val === 'string' && val !== 'sim' ? `${f.label.replace(/\?.*$/, '')}: ${val}` : f.label.replace(/\?$/, ''))
  }
  return out
}

router.get('/api/customers/:id/clinical', { perm: 'prontuario.ver' }, async (ctx) => {
  const cu = await db.one(`SELECT id, name, birth_date, phone, whatsapp, email, cpf_cnpj, anonymized_at FROM customers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!cu || cu.anonymized_at) throw notFound('Cliente')
  const tz = await companyTz(db, ctx.user.companyId)
  const [records, appointments, packages, plans] = await Promise.all([
    db.many(`SELECT r.*, pr.name AS professional, u.name AS author FROM clinical_records r LEFT JOIN professionals pr ON pr.id = r.professional_id LEFT JOIN users u ON u.id = r.created_by
              WHERE r.customer_id = $1 AND r.company_id = $2 ORDER BY r.created_at DESC LIMIT 200`, [cu.id, ctx.user.companyId]),
    db.many(`${APPT_SELECT(tz)} WHERE a.customer_id = $1 AND a.company_id = $2 ORDER BY a.start_at DESC LIMIT 60`, [cu.id, ctx.user.companyId]),
    db.many(`SELECT cp.id, cp.sessions_total, cp.sessions_used, cp.status, cp.expires_at, sv.name AS service_name, pk.name AS package_name FROM customer_packages cp
              JOIN products sv ON sv.id = cp.service_product_id JOIN products pk ON pk.id = cp.package_product_id WHERE cp.customer_id = $1 AND cp.company_id = $2 ORDER BY cp.created_at DESC`, [cu.id, ctx.user.companyId]),
    db.many(`SELECT id, number, title, status, total, created_at FROM treatment_plans WHERE customer_id = $1 AND company_id = $2 ORDER BY created_at DESC`, [cu.id, ctx.user.companyId]),
  ])
  const anamnese = records.find((r) => r.kind === 'anamnese') ?? null
  await audit(null, ctx, 'prontuario.acesso', 'customer', cu.id, { registros: records.length })
  return { customer: cu, records, anamnese, alerts: anamneseAlerts(anamnese), appointments, packages, plans }
})

router.post('/api/customers/:id/clinical-records', { perm: 'prontuario.editar' }, async (ctx) => {
  const b: any = parse(v.object({ kind: v.enum(['anamnese', 'evolucao', 'ficha_tecnica', 'avaliacao', 'observacao'] as const), title: v.string({ max: 150 }).optional(), content: v.string({ max: 20000 }).optional(),
    data: v.json().optional(), appointmentId: v.uuid().optional(), professionalId: v.uuid().optional(), amendsId: v.uuid().optional() }), ctx.body)
  if (!b.content?.trim() && !b.data) throw unprocessable('Registro vazio.')
  return tx(async (c) => {
    const cu = await c.one(`SELECT id, anonymized_at FROM customers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
    if (!cu || cu.anonymized_at) throw notFound('Cliente')
    if (b.kind === 'anamnese') {
      if (!b.data || b.data.consentimento !== true) throw unprocessable('A anamnese exige o consentimento do cliente para o tratamento de dados de saúde (LGPD).')
      if (b.data.template && !ANAMNESE[b.data.template]) throw unprocessable('Modelo de ficha inválido.')
      if (JSON.stringify(b.data).length > 20000) throw unprocessable('Ficha muito grande.')
    }
    if (b.appointmentId && !(await c.one(`SELECT 1 FROM appointments WHERE id = $1 AND company_id = $2 AND customer_id = $3`, [b.appointmentId, ctx.user.companyId, cu.id]))) throw unprocessable('Atendimento não pertence a este cliente.')
    if (b.amendsId && !(await c.one(`SELECT 1 FROM clinical_records WHERE id = $1 AND customer_id = $2`, [b.amendsId, cu.id]))) throw unprocessable('Registro a corrigir não encontrado.')
    let profId = b.professionalId ?? (await myProfessional(c, ctx))?.id ?? null
    if (profId && !(await c.one(`SELECT 1 FROM professionals WHERE id = $1 AND company_id = $2`, [profId, ctx.user.companyId]))) profId = null
    const r = await c.one(`INSERT INTO clinical_records(company_id, customer_id, professional_id, appointment_id, kind, title, content, data, amends_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.user.companyId, cu.id, profId, b.appointmentId ?? null, b.kind, b.title ?? null, b.content ?? null, JSON.stringify(b.data ?? {}), b.amendsId ?? null, ctx.user.id])
    await audit(c, ctx, 'prontuario.registro', 'customer', cu.id, { kind: b.kind, record: r.id, adendo: !!b.amendsId })
    return r
  })
})

// ---------- Odontograma ----------
const CONDITIONS = ['higido', 'carie', 'restaurado', 'ausente', 'extracao_indicada', 'canal', 'coroa', 'implante', 'protese', 'fratura', 'selante', 'mobilidade', 'outro'] as const
router.get('/api/customers/:id/odontogram', { perm: 'prontuario.ver' }, async (ctx) => {
  const cu = await db.one(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!cu) throw notFound('Paciente')
  const current = await db.many(`SELECT DISTINCT ON (tooth) e.*, pr.name AS professional FROM dental_chart_entries e LEFT JOIN professionals pr ON pr.id = e.professional_id
                                  WHERE e.customer_id = $1 AND e.company_id = $2 ORDER BY tooth, e.created_at DESC, e.id DESC`, [cu.id, ctx.user.companyId])
  const history = await db.many(`SELECT e.*, pr.name AS professional, u.name AS author FROM dental_chart_entries e LEFT JOIN professionals pr ON pr.id = e.professional_id LEFT JOIN users u ON u.id = e.created_by
                                  WHERE e.customer_id = $1 AND e.company_id = $2 ORDER BY e.created_at DESC, e.id DESC LIMIT 300`, [cu.id, ctx.user.companyId])
  return { current, history }
})
router.post('/api/customers/:id/odontogram', { perm: 'prontuario.editar' }, async (ctx) => {
  const b: any = parse(v.object({ entries: v.array(v.object({ tooth: v.int({ min: 11, max: 85 }), faces: v.array(v.enum(['M', 'D', 'O', 'I', 'V', 'L', 'P'] as const), { max: 5 }).optional(),
    condition: v.enum(CONDITIONS), status: v.enum(['existente', 'planejado', 'realizado'] as const).optional(), notes: v.string({ max: 500 }).optional() }), { min: 1, max: 52 }), professionalId: v.uuid().optional() }), ctx.body)
  const valid = (t: number) => [[11, 18], [21, 28], [31, 38], [41, 48], [51, 55], [61, 65], [71, 75], [81, 85]].some(([a, z]) => t >= a && t <= z)
  for (const e of b.entries) if (!valid(e.tooth)) throw unprocessable(`Dente ${e.tooth} inválido (numeração FDI).`)
  return tx(async (c) => {
    const cu = await c.one(`SELECT id FROM customers WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL`, [ctx.params.id, ctx.user.companyId])
    if (!cu) throw notFound('Paciente')
    const profId = b.professionalId ?? (await myProfessional(c, ctx))?.id ?? null
    for (const e of b.entries) await c.query(`INSERT INTO dental_chart_entries(company_id, customer_id, tooth, faces, condition, status, notes, professional_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.user.companyId, cu.id, e.tooth, [...new Set(e.faces ?? [])], e.condition, e.status ?? 'existente', e.notes ?? null, profId, ctx.user.id])
    await audit(c, ctx, 'prontuario.odontograma', 'customer', cu.id, { dentes: b.entries.map((e: any) => e.tooth) })
    return { ok: true, count: b.entries.length }
  })
})

// =====================================================================
// Planos de tratamento (orçamento clínico com aprovação; cobrança parcelada no PDV)
// =====================================================================
const planItemSchema = v.object({ productId: v.uuid(), description: v.string({ max: 200 }).optional(), tooth: v.int({ min: 11, max: 85 }).nullable().optional(),
  faces: v.array(v.enum(['M', 'D', 'O', 'I', 'V', 'L', 'P'] as const), { max: 5 }).optional(), qty: v.int({ min: 1, max: 100 }).default(1),
  unitPrice: v.money({ min: 0, max: 1000000 }).optional(), discount: v.money({ min: 0 }).optional(), professionalId: v.uuid().nullable().optional() })
const planSchema = { customerId: v.uuid(), professionalId: v.uuid().nullable().optional(), title: v.string({ max: 150 }).optional(), notes: v.string({ max: 4000 }).optional(),
  validUntil: v.date().optional(), discount: v.money({ min: 0 }).optional(), items: v.array(planItemSchema, { min: 1, max: 120 }) }

async function buildPlanItems(c: Q, ctx: Ctx, items: any[], planDiscount: number) {
  const out: any[] = []
  for (const [i, it] of items.entries()) {
    const p = await c.one(`SELECT p.id, p.name, p.kind, p.active, COALESCE(v.sale_price, p.sale_price) AS price, v.id AS variant_id FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active
                            WHERE p.id = $1 AND p.company_id = $2 ORDER BY v.created_at LIMIT 1`, [it.productId, ctx.user.companyId])
    if (!p || p.kind !== 'servico' || !p.active) throw unprocessable(`Item ${i + 1}: procedimento (serviço ativo) não encontrado.`)
    if (it.professionalId && !(await c.one(`SELECT 1 FROM professionals WHERE id = $1 AND company_id = $2`, [it.professionalId, ctx.user.companyId]))) throw unprocessable(`Item ${i + 1}: profissional inválido.`)
    const unit = it.unitPrice ?? r2(Number(p.price))
    const gross = r2(unit * it.qty)
    const disc = r2(it.discount ?? 0)
    if (disc > gross) throw unprocessable(`Item ${i + 1}: desconto maior que o valor.`)
    out.push({ ...it, name: p.name, variantId: p.variant_id, unit, gross, disc, listGross: r2(Number(p.price) * it.qty) })
  }
  // desconto geral do plano rateado nos itens
  const base = out.reduce((s, x) => s + x.gross - x.disc, 0)
  if (planDiscount > base + 0.001) throw unprocessable('Desconto do plano maior que o total.')
  let acc = 0
  out.forEach((x, k) => { const share = k === out.length - 1 ? r2(planDiscount - acc) : r2(base > 0 ? planDiscount * ((x.gross - x.disc) / base) : 0); acc = r2(acc + share); x.disc = r2(x.disc + share); x.total = r2(x.gross - x.disc) })
  // limite de desconto do operador (sobre o preço de tabela)
  const list = out.reduce((s, x) => s + x.listGross, 0), final = out.reduce((s, x) => s + x.total, 0)
  const pct = list > 0 ? ((list - final) / list) * 100 : 0
  if (pct > ctx.user.maxDiscountPct + 0.0001 && !can(ctx.user, 'vendas.desconto_extra')) throw forbidden(`Desconto de ${pct.toFixed(1)}% sobre a tabela excede seu limite (${ctx.user.maxDiscountPct}%).`)
  return out
}
async function writePlanItems(c: Q, companyId: string, planId: string, items: any[]) {
  await c.query(`DELETE FROM treatment_plan_items WHERE plan_id = $1`, [planId])
  let i = 0
  for (const x of items) await c.query(`INSERT INTO treatment_plan_items(plan_id, company_id, product_id, variant_id, description, tooth, faces, qty, unit_price, discount, total, professional_id, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [planId, companyId, x.productId, x.variantId, x.description ?? null, x.tooth ?? null, [...new Set(x.faces ?? [])], x.qty, x.unit, x.disc, x.total, x.professionalId ?? null, i++])
  const t = items.reduce((s, x) => ({ sub: s.sub + x.gross, disc: s.disc + x.disc }), { sub: 0, disc: 0 })
  await c.query(`UPDATE treatment_plans SET subtotal = $2, discount = $3, total = $4, updated_at = now() WHERE id = $1`, [planId, r2(t.sub), r2(t.disc), r2(t.sub - t.disc)])
}

router.get('/api/treatment-plans', { perm: 'prontuario.ver' }, async (ctx) => {
  const w = new Where([['tp.company_id = ?', ctx.user.companyId]])
  w.addIf(ctx.query.customer, 'tp.customer_id = ?', ctx.query.customer).addIf(ctx.query.status, 'tp.status = ?', ctx.query.status)
  if (ctx.query.q) w.add('(cu.name ILIKE ? OR tp.number::text = ?)', `%${ctx.query.q}%`, ctx.query.q)
  return paged(db, `SELECT tp.*, cu.name AS customer, pr.name AS professional,
                           (SELECT count(*)::int FROM treatment_plan_items i WHERE i.plan_id = tp.id AND i.status = 'pendente') AS pending_items,
                           (SELECT COALESCE(sum(total),0) FROM treatment_plan_items i WHERE i.plan_id = tp.id AND i.sale_id IS NOT NULL) AS billed
                      FROM treatment_plans tp JOIN customers cu ON cu.id = tp.customer_id LEFT JOIN professionals pr ON pr.id = tp.professional_id ${w.sql} ORDER BY tp.created_at DESC`, w.params, ctx.query)
})
router.get('/api/treatment-plans/:id', { perm: 'prontuario.ver' }, async (ctx) => {
  const tp = await db.one(`SELECT tp.*, cu.name AS customer, cu.whatsapp, cu.phone, pr.name AS professional FROM treatment_plans tp JOIN customers cu ON cu.id = tp.customer_id LEFT JOIN professionals pr ON pr.id = tp.professional_id
                            WHERE tp.id = $1 AND tp.company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!tp) throw notFound('Plano de tratamento')
  const items = await db.many(`SELECT i.*, p.name, pr.name AS professional, s.number AS sale_number FROM treatment_plan_items i JOIN products p ON p.id = i.product_id
                                LEFT JOIN professionals pr ON pr.id = i.professional_id LEFT JOIN sales s ON s.id = i.sale_id WHERE i.plan_id = $1 ORDER BY i.sort`, [tp.id])
  return { ...tp, items }
})
router.post('/api/treatment-plans', { perm: 'prontuario.editar' }, async (ctx) => {
  const b: any = parse(v.object(planSchema), ctx.body)
  return tx(async (c) => {
    if (!(await c.one(`SELECT 1 FROM customers WHERE id = $1 AND company_id = $2 AND anonymized_at IS NULL`, [b.customerId, ctx.user.companyId]))) throw unprocessable('Paciente não encontrado.')
    const profId = b.professionalId ?? (await myProfessional(c, ctx))?.id ?? null
    if (profId && !(await c.one(`SELECT 1 FROM professionals WHERE id = $1 AND company_id = $2`, [profId, ctx.user.companyId]))) throw unprocessable('Profissional inválido.')
    const items = await buildPlanItems(c, ctx, b.items, b.discount ?? 0)
    const number = await nextNumber(c, ctx.user.companyId, 'plano_tratamento')
    const tp = await c.one(`INSERT INTO treatment_plans(company_id, branch_id, number, customer_id, professional_id, title, notes, valid_until, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, number`,
      [ctx.user.companyId, ctx.user.branchId, number, b.customerId, profId, b.title ?? null, b.notes ?? null, b.validUntil ?? addDays(today(), 30), ctx.user.id])
    await writePlanItems(c, ctx.user.companyId, tp.id, items)
    await audit(c, ctx, 'plano.criado', 'treatment_plan', tp.id, { number, itens: items.length })
    return c.one(`SELECT * FROM treatment_plans WHERE id = $1`, [tp.id])
  })
})
router.put('/api/treatment-plans/:id', { perm: 'prontuario.editar' }, async (ctx) => {
  const partial: any = { ...planSchema, customerId: v.uuid().optional() }
  const b: any = parse(v.object(partial), ctx.body)
  return tx(async (c) => {
    const tp = await c.one(`SELECT * FROM treatment_plans WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!tp) throw notFound('Plano de tratamento')
    if (!['rascunho', 'apresentado'].includes(tp.status)) throw conflict('Plano aprovado não pode ser alterado: crie um novo plano para procedimentos adicionais.')
    const items = await buildPlanItems(c, ctx, b.items, b.discount ?? 0)
    await c.query(`UPDATE treatment_plans SET professional_id = COALESCE($2, professional_id), title = $3, notes = $4, valid_until = COALESCE($5, valid_until), updated_at = now() WHERE id = $1`,
      [tp.id, b.professionalId ?? null, b.title ?? tp.title, b.notes ?? tp.notes, b.validUntil ?? null])
    await writePlanItems(c, ctx.user.companyId, tp.id, items)
    await audit(c, ctx, 'plano.alterado', 'treatment_plan', tp.id, { number: tp.number, itens: items.length })
    return c.one(`SELECT * FROM treatment_plans WHERE id = $1`, [tp.id])
  })
})
router.post('/api/treatment-plans/:id/status', { perm: 'prontuario.editar' }, async (ctx) => {
  const b: any = parse(v.object({ status: v.enum(['apresentado', 'aprovado', 'recusado', 'cancelado'] as const), reason: v.string({ max: 300 }).optional() }), ctx.body)
  return tx(async (c) => {
    const tp = await c.one(`SELECT * FROM treatment_plans WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ctx.params.id, ctx.user.companyId])
    if (!tp) throw notFound('Plano de tratamento')
    const allowed: Record<string, string[]> = { apresentado: ['rascunho'], aprovado: ['rascunho', 'apresentado'], recusado: ['rascunho', 'apresentado'], cancelado: ['rascunho', 'apresentado', 'aprovado', 'em_andamento'] }
    if (!allowed[b.status].includes(tp.status)) throw conflict(`Não é possível mudar o plano de "${tp.status}" para "${b.status}".`)
    if (b.status === 'cancelado' && await c.one(`SELECT 1 FROM treatment_plan_items WHERE plan_id = $1 AND (sale_id IS NOT NULL OR status = 'realizado')`, [tp.id]))
      throw conflict('Plano com procedimentos já realizados ou cobrados não pode ser cancelado (cancele apenas os itens pendentes).')
    await c.query(`UPDATE treatment_plans SET status = $2, updated_at = now(), presented_at = CASE WHEN $2 = 'apresentado' THEN now() ELSE presented_at END,
                     approved_at = CASE WHEN $2 = 'aprovado' THEN now() ELSE approved_at END, approved_by = CASE WHEN $2 = 'aprovado' THEN $3::uuid ELSE approved_by END,
                     decline_reason = CASE WHEN $2 IN ('recusado','cancelado') THEN $4 ELSE decline_reason END WHERE id = $1`, [tp.id, b.status, ctx.user.id, b.reason ?? null])
    if (b.status === 'cancelado') await c.query(`UPDATE treatment_plan_items SET status = 'cancelado' WHERE plan_id = $1 AND status = 'pendente'`, [tp.id])
    await audit(c, ctx, 'plano.status', 'treatment_plan', tp.id, { number: tp.number, de: tp.status, para: b.status, total: tp.total }, b.status === 'aprovado' ? 'warning' : 'info')
    return { ok: true, status: b.status }
  })
})
router.post('/api/treatment-plans/items/:id/:action', { perm: 'prontuario.editar' }, async (ctx) => {
  if (!['done', 'cancel'].includes(ctx.params.action)) throw notFound('Ação')
  const b: any = parse(v.object({ professionalId: v.uuid().optional() }), ctx.body || {})
  return tx(async (c) => {
    const it = await c.one(`SELECT i.*, tp.status AS plan_status, tp.number FROM treatment_plan_items i JOIN treatment_plans tp ON tp.id = i.plan_id WHERE i.id = $1 AND i.company_id = $2 FOR UPDATE OF i`, [ctx.params.id, ctx.user.companyId])
    if (!it) throw notFound('Procedimento')
    if (!['aprovado', 'em_andamento'].includes(it.plan_status)) throw conflict('O plano precisa estar aprovado.')
    if (it.status !== 'pendente') throw conflict('Procedimento já realizado ou cancelado.')
    if (ctx.params.action === 'cancel') {
      if (it.sale_id) throw conflict('Procedimento já cobrado: faça a devolução da venda antes de cancelar.')
      await c.query(`UPDATE treatment_plan_items SET status = 'cancelado' WHERE id = $1`, [it.id])
    } else {
      const profId = b.professionalId ?? it.professional_id ?? (await myProfessional(c, ctx))?.id ?? null
      await c.query(`UPDATE treatment_plan_items SET status = 'realizado', performed_at = now(), professional_id = $2 WHERE id = $1`, [it.id, profId])
    }
    await refreshPlanStatus(c, it.id)
    await audit(c, ctx, ctx.params.action === 'done' ? 'plano.procedimento_realizado' : 'plano.procedimento_cancelado', 'treatment_plan', it.plan_id, { number: it.number, item: it.id })
    return { ok: true }
  })
})
router.get('/api/treatment-plans/:id/checkout', { perm: ['prontuario.ver', 'vendas.criar'] }, async (ctx) => {
  const tp = await db.one(`SELECT * FROM treatment_plans WHERE id = $1 AND company_id = $2`, [ctx.params.id, ctx.user.companyId])
  if (!tp) throw notFound('Plano de tratamento')
  if (!['aprovado', 'em_andamento', 'concluido'].includes(tp.status)) throw conflict('Aprove o plano antes de cobrar.')
  const items = await db.many(`SELECT i.id AS plan_item_id, i.qty, i.unit_price, i.discount, i.total, i.tooth, i.professional_id, pr.name AS professional, v.id AS variant_id, v.sku, v.barcode, p.name
                                 FROM treatment_plan_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = i.product_id LEFT JOIN professionals pr ON pr.id = COALESCE(i.professional_id, $2)
                                WHERE i.plan_id = $1 AND i.status <> 'cancelado' AND i.sale_id IS NULL ORDER BY i.sort`, [tp.id, tp.professional_id])
  const customer = await db.one(`SELECT c.*, (SELECT COALESCE(sum(amount + interest + fine - discount - paid_amount),0) FROM receivables r WHERE r.customer_id = c.id AND r.method_kind = 'crediario' AND r.status IN ('aberto','parcial')) AS open_balance
                                   FROM customers c WHERE c.id = $1`, [tp.customer_id])
  return { plan: { id: tp.id, number: tp.number, status: tp.status, professional_id: tp.professional_id }, customer, items }
})

// =====================================================================
// Inteligência de serviços: ocupação, horários ociosos, retorno de clientes, faltas, pacotes e planos
// =====================================================================
router.get('/api/service-intelligence', { perm: ['dashboard.ver', 'agenda.ver'] }, async (ctx) => {
  const id = ctx.user.companyId
  const tz = await companyTz(db, id)
  const days = Math.min(365, Math.max(14, parseInt(ctx.query.days || '60', 10) || 60))
  const profs = await db.many(`SELECT id, name, color, work_hours FROM professionals WHERE company_id = $1 AND active AND (branch_id IS NULL OR branch_id = $2) ORDER BY name`, [id, ctx.user.branchId])
  const todayLocal = (await db.one(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [tz])).d
  const dayList = (fromOffset: number, n: number) => Array.from({ length: n }, (_, k) => { const d = new Date(todayLocal + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + fromOffset + k); return d })
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
  const availMin = (wh: any, ds: Date[]) => ds.reduce((s, d) => s + ((wh?.[String(d.getUTCDay())] ?? []) as [string, string][]).reduce((a, [x, y]) => a + toMin(y) - toMin(x), 0), 0)
  // minutos agendados (passado: atendidos/agendados; futuro: agenda) por profissional
  const booked = await db.many(`SELECT professional_id,
                                       COALESCE(sum(extract(epoch FROM end_at - start_at) / 60) FILTER (WHERE start_at >= ($2::date - $3::int)::timestamp AT TIME ZONE $4 AND start_at < $2::date::timestamp AT TIME ZONE $4 AND status IN ('concluido','em_atendimento','confirmado','agendado')),0)::float8 AS past,
                                       COALESCE(sum(extract(epoch FROM end_at - start_at) / 60) FILTER (WHERE start_at >= $2::date::timestamp AT TIME ZONE $4 AND start_at < ($2::date + 7)::timestamp AT TIME ZONE $4 AND status IN ('agendado','confirmado','em_atendimento','concluido')),0)::float8 AS next7,
                                       count(*) FILTER (WHERE status = 'faltou' AND start_at >= ($2::date - $3::int)::timestamp AT TIME ZONE $4)::int AS no_shows,
                                       count(*) FILTER (WHERE status <> 'cancelado' AND start_at >= ($2::date - $3::int)::timestamp AT TIME ZONE $4 AND start_at < now())::int AS past_count
                                  FROM appointments WHERE company_id = $1 GROUP BY professional_id`, [id, todayLocal, days, tz])
  const revenue = await db.many(`SELECT si.professional_id, COALESCE(sum(si.total),0) AS revenue, count(DISTINCT s.id)::int AS sales
                                   FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.company_id = $1 AND s.status NOT IN ('cancelada') AND s.type = 'venda' AND si.professional_id IS NOT NULL
                                    AND s.created_at > now() - make_interval(days => $2) GROUP BY 1`, [id, days])
  const pastDays = dayList(-days, days), nextDays = dayList(0, 7)
  const professionals = profs.map((p) => {
    const b = booked.find((x) => x.professional_id === p.id) ?? { past: 0, next7: 0, no_shows: 0, past_count: 0 }
    const ap = availMin(p.work_hours, pastDays), an = availMin(p.work_hours, nextDays)
    const rv = revenue.find((x) => x.professional_id === p.id)
    return { id: p.id, name: p.name, color: p.color, occupancyPast: ap > 0 ? r2((b.past / ap) * 100) : null, occupancyNext7: an > 0 ? r2((b.next7 / an) * 100) : null,
      freeHoursNext7: an > 0 ? r2(Math.max(0, an - b.next7) / 60) : null, noShowRate: b.past_count > 0 ? r2((b.no_shows / b.past_count) * 100) : null, noShows: b.no_shows,
      revenue: Number(rv?.revenue ?? 0), revenuePerHour: b.past > 0 ? r2(Number(rv?.revenue ?? 0) / (b.past / 60)) : null }
  })
  // mapa de ocupação por dia da semana × hora (últimos N dias)
  const appts = await db.many(`SELECT professional_id, to_char(start_at AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI:SS') AS s, to_char(end_at AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI:SS') AS e FROM appointments
                                WHERE company_id = $1 AND status IN ('concluido','em_atendimento','confirmado','agendado') AND start_at >= ($2::date - $4::int)::timestamp AT TIME ZONE $3 AND start_at < $2::date::timestamp AT TIME ZONE $3 LIMIT 20000`,
    [id, todayLocal, tz, days])
  const heat: Record<string, { booked: number; avail: number }> = {}
  const key = (d: number, h: number) => `${d}-${h}`
  for (const p of profs) for (const d of pastDays) for (const [x, y] of ((p.work_hours?.[String(d.getUTCDay())] ?? []) as [string, string][])) {
    const end = toMin(y)
    for (let m = toMin(x); m < end;) { const h = Math.floor(m / 60), segEnd = Math.min((h + 1) * 60, end); (heat[key(d.getUTCDay(), h)] ??= { booked: 0, avail: 0 }).avail += segEnd - m; m = segEnd }
  }
  for (const a of appts) {
    const s = new Date(a.s + 'Z'), e = new Date(a.e + 'Z')
    for (let t = s.getTime(); t < e.getTime();) {
      const cur = new Date(t), next = new Date(t); next.setUTCMinutes(60, 0, 0)
      const end = Math.min(next.getTime(), e.getTime())
      const k = key(cur.getUTCDay(), cur.getUTCHours()); (heat[k] ??= { booked: 0, avail: 0 }).booked += (end - t) / 60000
      t = end
    }
  }
  const heatmap = Object.entries(heat).map(([k, val]) => { const [d, h] = k.split('-').map(Number); return { dow: d, hour: h, booked: Math.round(val.booked), available: Math.round(val.avail), occupancy: val.avail > 0 ? r2(Math.min(100, (val.booked / val.avail) * 100)) : null } })
    .filter((x) => x.available > 0).sort((a, b) => a.dow - b.dow || a.hour - b.hour)
  // serviços mais vendidos / rentáveis
  const topServices = await db.many(`SELECT p.id, p.name, count(*)::int AS times, COALESCE(sum(si.total),0) AS revenue, round(avg(si.total), 2) AS avg_ticket, p.duration_min,
                                            CASE WHEN p.duration_min > 0 THEN round(avg(si.total) / (p.duration_min / 60.0), 2) END AS revenue_per_hour
                                       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                                      WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.type = 'venda' AND p.kind = 'servico' AND s.created_at > now() - make_interval(days => $2)
                                      GROUP BY p.id ORDER BY revenue DESC LIMIT 12`, [id, days])
  // clientes para chamar de volta: intervalo de retorno do serviço (cadastro ou mediana observada) vencido e sem agendamento futuro
  const returnsDue = await db.many(`
    WITH ev AS (
      SELECT a.customer_id, s.product_id, a.start_at AS at FROM appointment_services s JOIN appointments a ON a.id = s.appointment_id
       WHERE a.company_id = $1 AND a.customer_id IS NOT NULL AND s.status = 'realizado'
      UNION
      SELECT sa.customer_id, v.product_id, sa.created_at FROM sale_items si JOIN sales sa ON sa.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
       WHERE sa.company_id = $1 AND sa.customer_id IS NOT NULL AND sa.status <> 'cancelada' AND sa.type = 'venda' AND p.kind = 'servico' AND si.appointment_service_id IS NULL),
    gaps AS (SELECT product_id, extract(epoch FROM at - lag(at) OVER (PARTITION BY customer_id, product_id ORDER BY at)) / 86400 AS gap FROM ev),
    med AS (SELECT product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap, count(*) AS n FROM gaps WHERE gap >= 3 GROUP BY product_id),
    last AS (SELECT DISTINCT ON (customer_id, product_id) customer_id, product_id, at FROM ev ORDER BY customer_id, product_id, at DESC)
    SELECT cu.id AS customer_id, cu.name AS customer, COALESCE(cu.whatsapp, cu.phone) AS phone, p.name AS service, to_char(l.at AT TIME ZONE $2, 'YYYY-MM-DD') AS last_date,
           round(COALESCE(p.return_days, CASE WHEN m.n >= 3 THEN m.median_gap END))::int AS interval_days,
           (current_date - (l.at AT TIME ZONE $2)::date - round(COALESCE(p.return_days, CASE WHEN m.n >= 3 THEN m.median_gap END))::int) AS overdue_days,
           COALESCE((SELECT granted FROM customer_consents cc WHERE cc.customer_id = cu.id AND cc.channel = 'whatsapp' ORDER BY cc.created_at DESC LIMIT 1), false) AS whatsapp_consent
      FROM last l JOIN products p ON p.id = l.product_id JOIN customers cu ON cu.id = l.customer_id LEFT JOIN med m ON m.product_id = l.product_id
     WHERE cu.anonymized_at IS NULL AND cu.active AND COALESCE(p.return_days, CASE WHEN m.n >= 3 THEN m.median_gap END) IS NOT NULL
       AND (l.at AT TIME ZONE $2)::date + round(COALESCE(p.return_days, CASE WHEN m.n >= 3 THEN m.median_gap END))::int <= current_date + 3
       AND (l.at AT TIME ZONE $2)::date > current_date - 365
       AND NOT EXISTS (SELECT 1 FROM appointments f WHERE f.customer_id = cu.id AND f.start_at > now() AND f.status IN ('agendado','confirmado'))
     ORDER BY overdue_days DESC LIMIT 60`, [id, tz])
  const packages = await db.many(`SELECT cp.id, cu.id AS customer_id, cu.name AS customer, COALESCE(cu.whatsapp, cu.phone) AS phone, sv.name AS service, cp.sessions_total, cp.sessions_used, cp.expires_at,
                                         (SELECT max(a.start_at) FROM package_usages u JOIN appointments a ON a.id = u.appointment_id WHERE u.customer_package_id = cp.id) AS last_session,
                                         (cp.sessions_total - cp.sessions_used) * cp.unit_value AS value_open
                                    FROM customer_packages cp JOIN customers cu ON cu.id = cp.customer_id JOIN products sv ON sv.id = cp.service_product_id
                                   WHERE cp.company_id = $1 AND cp.status = 'ativo' AND ((cp.expires_at IS NOT NULL AND cp.expires_at <= current_date + 30)
                                      OR NOT EXISTS (SELECT 1 FROM package_usages u WHERE u.customer_package_id = cp.id AND u.used_at > now() - interval '45 days'))
                                     AND NOT EXISTS (SELECT 1 FROM appointment_services s JOIN appointments a ON a.id = s.appointment_id WHERE s.customer_package_id = cp.id AND a.start_at > now() AND a.status IN ('agendado','confirmado'))
                                   ORDER BY cp.expires_at NULLS LAST LIMIT 40`, [id])
  const plans = await db.one(`SELECT count(*) FILTER (WHERE status = 'apresentado')::int AS presented, COALESCE(sum(total) FILTER (WHERE status = 'apresentado'),0) AS presented_value,
                                     count(*) FILTER (WHERE status IN ('aprovado','em_andamento'))::int AS in_progress,
                                     COALESCE((SELECT sum(i.total) FROM treatment_plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.company_id = $1 AND t.status IN ('aprovado','em_andamento') AND i.status = 'pendente' AND i.sale_id IS NULL),0) AS approved_unbilled,
                                     count(*) FILTER (WHERE status IN ('aprovado','em_andamento','concluido') AND created_at > now() - make_interval(days => $2))::int AS approved_period,
                                     count(*) FILTER (WHERE status IN ('apresentado','aprovado','em_andamento','concluido','recusado') AND created_at > now() - make_interval(days => $2))::int AS decided_period
                                FROM treatment_plans WHERE company_id = $1`, [id, days])
  const pendingPlans = await db.many(`SELECT tp.id, tp.number, tp.total, cu.id AS customer_id, cu.name AS customer, COALESCE(cu.whatsapp, cu.phone) AS phone, (current_date - tp.presented_at::date) AS days_waiting
                                        FROM treatment_plans tp JOIN customers cu ON cu.id = tp.customer_id WHERE tp.company_id = $1 AND tp.status = 'apresentado' ORDER BY tp.total DESC LIMIT 20`, [id])
  // descobertas em linguagem simples (sempre derivadas dos números acima)
  const insights: { tone: string; text: string }[] = []
  const DOW = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
  const enough = appts.length >= 20 // só tira conclusões de horário com histórico mínimo
  const pctTxt = (n: number | null) => `${Math.round(n ?? 0)}%`
  const idle = heatmap.filter((h) => h.occupancy !== null && h.available >= 120).sort((a, b) => (a.occupancy ?? 0) - (b.occupancy ?? 0)).slice(0, 3)
  if (enough && idle.length && (idle[0].occupancy ?? 100) < 35) insights.push({ tone: 'info', text: `Horários mais ociosos: ${idle.map((h) => `${DOW[h.dow]} ${h.hour}h (${pctTxt(h.occupancy)})`).join(', ')}. Use para campanhas de retorno, encaixes ou preço promocional nesses horários.` })
  const full = heatmap.filter((h) => (h.occupancy ?? 0) >= 85 && h.available >= 120)
  if (enough && full.length) insights.push({ tone: 'success', text: `${full.length} faixa(s) de horário com 85% ou mais de ocupação (ex.: ${DOW[full[0].dow]} ${full[0].hour}h). Avalie ampliar o expediente ou ajustar preço nesses horários.` })
  const ns = professionals.filter((p) => (p.noShowRate ?? 0) >= 10 && (booked.find((x) => x.professional_id === p.id)?.past_count ?? 0) >= 10)
  if (ns.length) insights.push({ tone: 'warning', text: `Taxa de faltas alta para ${ns.map((p) => `${p.name} (${pctTxt(p.noShowRate)})`).join(', ')}. Envie lembrete na véspera e peça confirmação.` })
  if (returnsDue.length) insights.push({ tone: 'info', text: `${returnsDue.length} cliente(s) já passaram do intervalo habitual de retorno e não têm horário marcado — chame-os pela lista "Hora de voltar".` })
  const pkgOpen = packages.reduce((s, p) => s + Number(p.value_open), 0)
  if (packages.length) insights.push({ tone: 'warning', text: `${packages.length} pacote(s) parado(s) ou perto do vencimento, com ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(pkgOpen)} em sessões a realizar. Agende as sessões para evitar insatisfação.` })
  if (plans.presented > 0) insights.push({ tone: 'info', text: `${plans.presented} plano(s) de tratamento aguardando aprovação (${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(plans.presented_value))}). Retome o contato com os pacientes.` })
  const lowOcc = professionals.filter((p) => p.occupancyNext7 !== null && p.occupancyNext7 < 40)
  if (lowOcc.length) insights.push({ tone: 'info', text: `Agenda dos próximos 7 dias com baixa ocupação: ${lowOcc.map((p) => `${p.name} (${pctTxt(p.occupancyNext7)}, ${String(p.freeHoursNext7).replace('.', ',')} h livres)`).join(', ')}.` })
  return { days, professionals, heatmap, enoughHistory: enough, pastAppointments: appts.length, topServices, returnsDue, packages, plans, pendingPlans, insights }
})
