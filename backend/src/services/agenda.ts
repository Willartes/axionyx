import { Q } from '../core/db'
import { conflict, notFound, unprocessable, HttpError } from '../core/errors'
import { r2 } from '../core/http'
import { getSettings } from './settings'

/**
 * Agenda de serviços (odontologia, estética, salão): horários por profissional, conflito de horários,
 * bloqueios, pacotes de sessões e comissão por profissional.
 * Horários trafegam como hora local da empresa ("AAAA-MM-DDTHH:MM") e são convertidos no banco pelo fuso configurado.
 */
export const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
export const ACTIVE_STATUSES = ['agendado', 'confirmado', 'em_atendimento', 'concluido']
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
export const TZ_OK = /^(America\/(Sao_Paulo|Bahia|Fortaleza|Recife|Maceio|Belem|Araguaina|Manaus|Cuiaba|Campo_Grande|Porto_Velho|Boa_Vista|Rio_Branco|Eirunepe|Santarem|Noronha)|UTC)$/

export async function companyTz(c: Q, companyId: string): Promise<string> {
  const s = await getSettings(c, companyId)
  const tz = String((s.agenda as any).fusoHorario || 'America/Sao_Paulo')
  return TZ_OK.test(tz) ? tz : 'America/Sao_Paulo'
}

/** Valida e normaliza o expediente: {"1": [["08:00","12:00"],["13:00","18:00"]], ...} (0 = domingo … 6 = sábado). */
export function normalizeWorkHours(input: any): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [day, list] of Object.entries(input)) {
    if (!/^[0-6]$/.test(day)) throw unprocessable(`Dia da semana inválido no expediente: ${day}.`)
    if (!Array.isArray(list)) throw unprocessable('Expediente inválido.')
    if (list.length > 4) throw unprocessable('Máximo de 4 intervalos de expediente por dia.')
    const ints = list.map((x: any) => {
      if (!Array.isArray(x) || x.length !== 2 || !HHMM.test(x[0]) || !HHMM.test(x[1]) || x[0] >= x[1]) throw unprocessable('Intervalo de expediente inválido (use HH:MM e início antes do fim).')
      return [x[0], x[1]] as [string, string]
    }).sort((a: any, b: any) => a[0].localeCompare(b[0]))
    for (let i = 1; i < ints.length; i++) if (ints[i][0] < ints[i - 1][1]) throw unprocessable('Intervalos de expediente sobrepostos.')
    if (ints.length) out[day] = ints
  }
  return out
}

export interface SlotInput {
  companyId: string; branchId: string; professionalId: string; startLocal: string; durationMin: number
  excludeAppointmentId?: string | null; allowOutsideHours?: boolean
}
/**
 * Confere e reserva o horário: trava o profissional (FOR UPDATE) para serializar agendamentos concorrentes,
 * verifica expediente, bloqueios e conflito com outros atendimentos. Deve rodar dentro da transação que grava o agendamento.
 */
export async function checkSlot(c: Q, s: SlotInput) {
  if (!LOCAL_DT.test(s.startLocal)) throw unprocessable('Data/hora inválida (use AAAA-MM-DDTHH:MM).')
  if (!(s.durationMin >= 5 && s.durationMin <= 720)) throw unprocessable('Duração do atendimento inválida.')
  const tz = await companyTz(c, s.companyId)
  const prof = await c.one(`SELECT * FROM professionals WHERE id = $1 AND company_id = $2 FOR UPDATE`, [s.professionalId, s.companyId])
  if (!prof) throw notFound('Profissional')
  if (!prof.active) throw unprocessable(`${prof.name} está inativo(a).`)
  if (prof.branch_id && prof.branch_id !== s.branchId) throw unprocessable(`${prof.name} não atende nesta filial.`)
  const t = await c.one(`SELECT ($1::timestamp AT TIME ZONE $3) AS start_at, (($1::timestamp + make_interval(mins => $2)) AT TIME ZONE $3) AS end_at,
                                extract(dow FROM $1::timestamp)::int AS dow, to_char($1::timestamp, 'HH24:MI') AS t0,
                                to_char($1::timestamp + make_interval(mins => $2), 'HH24:MI') AS t1,
                                ($1::timestamp + make_interval(mins => $2))::date = $1::timestamp::date AS same_day`, [s.startLocal, s.durationMin, tz])
  // expediente
  const wh = prof.work_hours || {}
  if (Object.keys(wh).length && !s.allowOutsideHours) {
    const day: [string, string][] = wh[String(t.dow)] || []
    const inside = t.same_day && day.some(([a, b]) => t.t0 >= a && t.t1 <= b)
    if (!inside) throw new HttpError(409, 'fora_do_expediente', `Fora do expediente de ${prof.name} (${day.length ? day.map(([a, b]) => `${a}–${b}`).join(', ') : 'não atende neste dia'}).`,
      { professional: prof.name, hours: day })
  }
  const block = await c.one(`SELECT reason, to_char(start_at AT TIME ZONE $4, 'DD/MM HH24:MI') AS ini, to_char(end_at AT TIME ZONE $4, 'HH24:MI') AS fim
                               FROM schedule_blocks WHERE professional_id = $1 AND start_at < $3 AND end_at > $2 LIMIT 1`, [prof.id, t.start_at, t.end_at, tz])
  if (block) throw new HttpError(409, 'horario_bloqueado', `Agenda de ${prof.name} bloqueada (${block.ini}–${block.fim}${block.reason ? ': ' + block.reason : ''}).`)
  const clash = await c.one(`SELECT a.number, COALESCE(cu.name, 'cliente sem cadastro') AS customer, to_char(a.start_at AT TIME ZONE $5, 'HH24:MI') AS ini, to_char(a.end_at AT TIME ZONE $5, 'HH24:MI') AS fim
                               FROM appointments a LEFT JOIN customers cu ON cu.id = a.customer_id
                              WHERE a.professional_id = $1 AND a.status = ANY($4) AND a.start_at < $3 AND a.end_at > $2 AND a.id IS DISTINCT FROM $6 LIMIT 1`,
    [prof.id, t.start_at, t.end_at, ACTIVE_STATUSES, tz, s.excludeAppointmentId ?? null])
  if (clash) throw new HttpError(409, 'horario_ocupado', `${prof.name} já tem atendimento das ${clash.ini} às ${clash.fim} (${clash.customer}, nº ${clash.number}).`)
  return { startAt: t.start_at as Date, endAt: t.end_at as Date, professional: prof, tz }
}

export interface ServiceInput { productId: string; professionalId?: string; customerPackageId?: string; planItemId?: string }
/** Resolve os serviços do agendamento: preço, duração (do profissional, do serviço ou padrão), pacote e plano de tratamento. */
export async function resolveServices(c: Q, companyId: string, customerId: string | null, list: ServiceInput[], defaultProfessionalId: string) {
  if (!list.length) throw unprocessable('Inclua pelo menos um serviço.')
  const settings = await getSettings(c, companyId)
  const out: any[] = []
  for (const [i, s] of list.entries()) {
    const n = i + 1
    const p = await c.one(`SELECT p.id, p.name, p.kind, p.active, p.duration_min, p.sale_price, v.id AS variant_id, COALESCE(v.sale_price, p.sale_price) AS price
                             FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active
                            WHERE p.id = $1 AND p.company_id = $2 ORDER BY v.created_at LIMIT 1`, [s.productId, companyId])
    if (!p) throw unprocessable(`Serviço ${n}: não encontrado.`)
    if (p.kind !== 'servico') throw unprocessable(`${p.name}: somente serviços podem ser agendados.`)
    if (!p.active) throw unprocessable(`${p.name}: serviço inativo.`)
    const profId = s.professionalId || defaultProfessionalId
    const prof = await c.one(`SELECT id, name, active FROM professionals WHERE id = $1 AND company_id = $2`, [profId, companyId])
    if (!prof || !prof.active) throw unprocessable(`Serviço ${n}: profissional inválido ou inativo.`)
    const restricted = await c.one(`SELECT count(*)::int AS n, bool_or(product_id = $2) AS has, max(duration_min) FILTER (WHERE product_id = $2) AS dur
                                      FROM professional_services WHERE professional_id = $1`, [profId, p.id])
    if (restricted.n > 0 && !restricted.has) throw unprocessable(`${prof.name} não executa o serviço "${p.name}" (ajuste em Profissionais).`)
    const duration = Number(restricted.dur || p.duration_min || settings.agenda.intervaloMin || 30)
    let price = r2(Number(p.price)), pkg: any = null, planItem: any = null
    if (s.customerPackageId) {
      if (!customerId) throw unprocessable('Para usar pacote, identifique o cliente.')
      pkg = await c.one(`SELECT * FROM customer_packages WHERE id = $1 AND company_id = $2`, [s.customerPackageId, companyId])
      if (!pkg || pkg.customer_id !== customerId) throw unprocessable('Pacote não encontrado para este cliente.')
      if (pkg.status !== 'ativo') throw unprocessable('Pacote sem sessões disponíveis (concluído ou cancelado).')
      if (pkg.service_product_id !== p.id) throw unprocessable(`O pacote não é do serviço "${p.name}".`)
      if (pkg.expires_at && String(pkg.expires_at instanceof Date ? pkg.expires_at.toISOString().slice(0, 10) : pkg.expires_at) < new Date().toISOString().slice(0, 10)) throw unprocessable('Pacote vencido.')
      price = 0
    }
    if (s.planItemId) {
      planItem = await c.one(`SELECT i.*, tp.customer_id, tp.status AS plan_status FROM treatment_plan_items i JOIN treatment_plans tp ON tp.id = i.plan_id WHERE i.id = $1 AND i.company_id = $2`, [s.planItemId, companyId])
      if (!planItem || planItem.customer_id !== customerId) throw unprocessable('Item do plano de tratamento não encontrado para este paciente.')
      if (!['aprovado', 'em_andamento'].includes(planItem.plan_status)) throw unprocessable('O plano de tratamento precisa estar aprovado para agendar seus procedimentos.')
      if (planItem.status !== 'pendente') throw unprocessable('Este procedimento do plano já foi realizado ou cancelado.')
      if (planItem.product_id !== p.id) throw unprocessable('O procedimento do plano não corresponde ao serviço.')
      price = 0 // cobrado pelo plano de tratamento
    }
    out.push({ productId: p.id, variantId: p.variant_id, name: p.name, professionalId: profId, durationMin: duration, price, customerPackageId: pkg?.id ?? null, planItemId: planItem?.id ?? null })
  }
  return out
}

/** Percentual de comissão: serviço no cadastro do profissional > percentual do serviço/produto > padrão do profissional. */
export async function commissionPct(c: Q, professionalId: string, productId: string) {
  const r = await c.one(`SELECT pr.commission_services_pct, pr.commission_products_pct, p.kind, p.commission_pct AS product_pct, ps.commission_pct AS ps_pct
                           FROM professionals pr JOIN products p ON p.id = $2 LEFT JOIN professional_services ps ON ps.professional_id = pr.id AND ps.product_id = p.id
                          WHERE pr.id = $1`, [professionalId, productId])
  if (!r) return 0
  if (r.ps_pct != null) return Number(r.ps_pct)
  if (r.product_pct != null) return Number(r.product_pct)
  return Number(r.kind === 'produto' ? r.commission_products_pct : r.commission_services_pct)
}

export async function addProfessionalCommission(c: Q, p: { companyId: string; branchId: string | null; professionalId: string; kind: 'servico' | 'produto' | 'sessao_pacote';
  refType: 'venda' | 'cancelamento' | 'devolucao' | 'sessao' | 'estorno_sessao'; refKey: string; saleId?: string | null; saleItemId?: string | null; appointmentId?: string | null;
  description?: string; base: number; pct: number; amount?: number }) {
  const amount = p.amount ?? r2(p.base * p.pct / 100)
  if (amount === 0) return // 0% (ex.: dono que também atende) não gera lançamento
  await c.query(`INSERT INTO professional_commissions(company_id, branch_id, professional_id, kind, ref_type, ref_key, sale_id, sale_item_id, appointment_id, description, base_amount, pct, amount, competence)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,date_trunc('month', now())::date) ON CONFLICT (ref_type, ref_key) DO NOTHING`,
    [p.companyId, p.branchId, p.professionalId, p.kind, p.refType, p.refKey, p.saleId ?? null, p.saleItemId ?? null, p.appointmentId ?? null, p.description ?? null, r2(p.base), p.pct, amount])
}

/**
 * Conclui o atendimento: baixa as sessões de pacote (com trava do pacote), marca os procedimentos do plano como realizados
 * e lança a comissão das sessões de pacote. Idempotente: concluir de novo não baixa sessões em dobro.
 */
export async function completeAppointment(c: Q, a: { companyId: string; userId: string }, appointmentId: string) {
  const ap = await c.one(`SELECT * FROM appointments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [appointmentId, a.companyId])
  if (!ap) throw notFound('Agendamento')
  if (['cancelado', 'faltou'].includes(ap.status)) throw conflict('Agendamento cancelado ou com falta não pode ser concluído.')
  const services = await c.many(`SELECT s.*, p.name FROM appointment_services s JOIN products p ON p.id = s.product_id WHERE s.appointment_id = $1 AND s.status = 'pendente' ORDER BY s.sort`, [ap.id])
  for (const s of services) {
    if (s.customer_package_id) {
      const pkg = await c.one(`SELECT * FROM customer_packages WHERE id = $1 FOR UPDATE`, [s.customer_package_id])
      if (!pkg || pkg.status !== 'ativo' || pkg.sessions_used >= pkg.sessions_total) throw conflict(`Pacote de "${s.name}" sem sessões disponíveis.`)
      const usage = await c.one(`INSERT INTO package_usages(company_id, customer_package_id, appointment_id, appointment_service_id, professional_id, user_id) VALUES ($1,$2,$3,$4,$5,$6)
                                 ON CONFLICT (appointment_service_id) DO NOTHING RETURNING id`, [a.companyId, pkg.id, ap.id, s.id, s.professional_id, a.userId])
      if (usage) {
        const used = pkg.sessions_used + 1
        await c.query(`UPDATE customer_packages SET sessions_used = $2, status = CASE WHEN $2 >= sessions_total THEN 'concluido' ELSE status END WHERE id = $1`, [pkg.id, used])
        const pct = await commissionPct(c, s.professional_id, s.product_id)
        await addProfessionalCommission(c, { companyId: a.companyId, branchId: ap.branch_id, professionalId: s.professional_id, kind: 'sessao_pacote', refType: 'sessao', refKey: 'usage:' + usage.id,
          appointmentId: ap.id, description: `Sessão ${used}/${pkg.sessions_total} — ${s.name}`, base: Number(pkg.unit_value), pct })
      }
    }
    if (s.plan_item_id) {
      await c.query(`UPDATE treatment_plan_items SET status = 'realizado', performed_at = now(), professional_id = COALESCE(professional_id, $2) WHERE id = $1 AND status = 'pendente'`, [s.plan_item_id, s.professional_id])
      await refreshPlanStatus(c, s.plan_item_id)
    }
  }
  await c.query(`UPDATE appointment_services SET status = 'realizado' WHERE appointment_id = $1 AND status = 'pendente'`, [ap.id])
  return c.one(`UPDATE appointments SET status = 'concluido', completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = $1 RETURNING *`, [ap.id])
}

/** Plano vira "em andamento" no primeiro procedimento realizado/cobrado e "concluído" quando não resta nada pendente. */
export async function refreshPlanStatus(c: Q, planItemId: string) {
  await c.query(`UPDATE treatment_plans tp SET status = CASE
                    WHEN NOT EXISTS (SELECT 1 FROM treatment_plan_items i WHERE i.plan_id = tp.id AND i.status = 'pendente') THEN 'concluido'
                    ELSE 'em_andamento' END, updated_at = now()
                  WHERE tp.id = (SELECT plan_id FROM treatment_plan_items WHERE id = $1) AND tp.status IN ('aprovado','em_andamento')`, [planItemId])
}
