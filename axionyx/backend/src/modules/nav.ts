import { router, can } from '../core/http'
import { platformCan } from '../core/platform'
import { db } from '../core/db'

/** Contadores reais para o menu lateral e notificações (substitui os números fixos do protótipo). */
router.get('/api/nav/badges', {}, async (ctx) => {
  const id = ctx.user.companyId, br = ctx.user.branchId
  const r = await db.one(`SELECT
      (SELECT count(*)::int FROM sales WHERE company_id = $1 AND type = 'orcamento' AND status = 'orcamento') AS quotes_open,
      (SELECT count(*)::int FROM purchase_entries WHERE company_id = $1 AND status = 'rascunho') AS entries_pending,
      (SELECT count(*)::int FROM (SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND sb.branch_id = $2
          WHERE v.company_id = $1 AND v.active AND p.active AND p.track_stock GROUP BY v.id, v.min_stock, p.min_stock
         HAVING COALESCE(sum(sb.qty),0) <= COALESCE(v.min_stock, p.min_stock) AND COALESCE(v.min_stock, p.min_stock) > 0) x) AS low_stock,
      (SELECT count(*)::int FROM receivables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date < current_date AND method_kind IN ('crediario','a_prazo','boleto')) AS overdue_receivables,
      (SELECT count(*)::int FROM payables WHERE company_id = $1 AND status IN ('aberto','parcial') AND due_date <= current_date + 3) AS payables_due,
      (SELECT count(*)::int FROM conditionals WHERE company_id = $1 AND status = 'aberto' AND due_date < current_date) AS conditionals_overdue,
      (SELECT count(*)::int FROM conditionals WHERE company_id = $1 AND status = 'aberto') AS conditionals_open,
      (SELECT count(*)::int FROM legal_cases WHERE company_id = $1 AND next_deadline BETWEEN current_date AND current_date + 7) AS legal_deadlines,
      (SELECT count(*)::int FROM fiscal_documents WHERE company_id = $1 AND status IN ('invalido','erro','rejeitado','contingencia')) AS fiscal_issues,
      (SELECT count(*)::int FROM outbox WHERE company_id = $1 AND status = 'erro') AS integration_errors,
      (SELECT count(*)::int FROM stock_transfers WHERE company_id = $1 AND to_branch_id = $2 AND status = 'enviada') AS transfers_in,
      (SELECT count(*)::int FROM stock_lots WHERE company_id = $1 AND branch_id = $2 AND qty_remaining > 0 AND expiry_date <= current_date
          + COALESCE(NULLIF((SELECT settings->'validade'->>'alertaDias' FROM companies WHERE id = $1), '')::int, 3)) AS expiring_lots,
      (SELECT count(*)::int FROM appointments a WHERE a.company_id = $1 AND a.branch_id = $2 AND a.status IN ('agendado','confirmado','em_atendimento')
          AND (a.start_at AT TIME ZONE COALESCE((SELECT settings->'agenda'->>'fusoHorario' FROM companies WHERE id = $1), 'America/Sao_Paulo'))::date
            = (now() AT TIME ZONE COALESCE((SELECT settings->'agenda'->>'fusoHorario' FROM companies WHERE id = $1), 'America/Sao_Paulo'))::date
          AND ($3::boolean OR a.professional_id IN (SELECT id FROM professionals WHERE company_id = $1 AND user_id = $4))) AS appointments_today,
      (SELECT count(*)::int FROM treatment_plans WHERE company_id = $1 AND status = 'apresentado') AS plans_presented,
      (SELECT count(*)::int FROM work_orders WHERE company_id = $1 AND status NOT IN ('entregue','cancelada')) AS wo_open,
      (SELECT count(*)::int FROM work_orders WHERE company_id = $1 AND promised_at < now() AND status NOT IN ('pronta','entregue','cancelada')) AS wo_late,
      (SELECT count(*)::int FROM work_orders WHERE company_id = $1 AND status = 'pronta') AS wo_ready,
      (SELECT count(*)::int FROM vehicle_reminders WHERE company_id = $1 AND status = 'aberto' AND due_date <= current_date + 7) AS vehicle_reminders,
      (SELECT count(*)::int FROM insurance_claims WHERE company_id = $1 AND status = 'a_faturar') AS claims_to_bill,
      (SELECT count(*)::int FROM insurance_batches WHERE company_id = $1 AND status IN ('enviado','pago_parcial') AND expected_at < current_date) AS batches_late,
      (SELECT count(*)::int FROM appointments a WHERE a.company_id = $1 AND a.branch_id = $2 AND a.arrived_at IS NOT NULL AND a.status IN ('agendado','confirmado')
          AND a.arrived_at > now() - interval '18 hours'
          AND ($3::boolean OR a.professional_id IN (SELECT id FROM professionals WHERE company_id = $1 AND user_id = $4))) AS waiting_room`, [id, br, can(ctx.user, 'agenda.todas'), ctx.user.id])
  const notifications: { icon: string; text: string; link: string; tone: string }[] = []
  if (r.low_stock && can(ctx.user, 'estoque.ver')) notifications.push({ icon: 'boxes', text: `${r.low_stock} variação(ões) no estoque mínimo nesta filial`, link: '/estoque-posicao', tone: 'warning' })
  if (r.overdue_receivables && can(ctx.user, 'financeiro.ver')) notifications.push({ icon: 'wallet', text: `${r.overdue_receivables} título(s) a receber vencido(s)`, link: '/contas-receber', tone: 'danger' })
  if (r.payables_due && can(ctx.user, 'financeiro.ver')) notifications.push({ icon: 'credit-card', text: `${r.payables_due} conta(s) a pagar vencendo em até 3 dias`, link: '/contas-pagar', tone: 'warning' })
  if (r.conditionals_overdue && can(ctx.user, 'condicional.ver')) notifications.push({ icon: 'shopping-bag', text: `${r.conditionals_overdue} condicional(is) com prazo vencido`, link: '/condicionais', tone: 'danger' })
  if (r.entries_pending && can(ctx.user, 'compras.ver')) notifications.push({ icon: 'file-input', text: `${r.entries_pending} entrada(s) de NF aguardando conferência`, link: '/recebimentos', tone: 'info' })
  if (r.transfers_in && can(ctx.user, 'estoque.ver')) notifications.push({ icon: 'arrow-left-right', text: `${r.transfers_in} transferência(s) a receber nesta filial`, link: '/transferencias', tone: 'info' })
  if (r.fiscal_issues && can(ctx.user, 'fiscal.ver')) notifications.push({ icon: 'receipt-text', text: `${r.fiscal_issues} documento(s) fiscal(is) com pendência`, link: '/nfe', tone: 'danger' })
  if (r.legal_deadlines && can(ctx.user, 'juridico.ver')) notifications.push({ icon: 'scale', text: `${r.legal_deadlines} prazo(s) jurídico(s) nos próximos 7 dias`, link: '/processos', tone: 'warning' })
  if (r.expiring_lots && can(ctx.user, 'estoque.ver')) notifications.push({ icon: 'calendar-clock', text: `${r.expiring_lots} lote(s) vencido(s) ou perto do vencimento`, link: '/validade', tone: 'warning' })
  if (r.plans_presented && can(ctx.user, 'prontuario.ver')) notifications.push({ icon: 'clipboard-list', text: `${r.plans_presented} plano(s) de tratamento aguardando aprovação do paciente`, link: '/planos-tratamento', tone: 'info' })
  if (r.wo_late && can(ctx.user, 'oficina.ver')) notifications.push({ icon: 'wrench', text: `${r.wo_late} OS com prazo de entrega vencido`, link: '/oficina', tone: 'danger' })
  if (r.wo_ready && can(ctx.user, 'oficina.ver')) notifications.push({ icon: 'car', text: `${r.wo_ready} veículo(s) pronto(s) para entrega`, link: '/oficina', tone: 'info' })
  if (r.vehicle_reminders && can(ctx.user, 'oficina.ver')) notifications.push({ icon: 'calendar-clock', text: `${r.vehicle_reminders} revisão(ões) de clientes vencendo nos próximos 7 dias`, link: '/oficina-painel', tone: 'info' })
  if (r.waiting_room && can(ctx.user, 'agenda.ver')) notifications.push({ icon: 'armchair', text: `${r.waiting_room} paciente(s) na sala de espera`, link: '/recepcao', tone: 'info' })
  if (r.claims_to_bill && can(ctx.user, 'convenios.ver')) notifications.push({ icon: 'file-stack', text: `${r.claims_to_bill} guia(s) de convênio a faturar`, link: '/convenios', tone: 'info' })
  if (r.batches_late && can(ctx.user, 'convenios.ver')) notifications.push({ icon: 'hourglass', text: `${r.batches_late} lote(s) de convênio com pagamento atrasado`, link: '/convenios', tone: 'warning' })
  if (r.integration_errors && can(ctx.user, 'integracoes.ver')) notifications.push({ icon: 'plug', text: `${r.integration_errors} evento(s) de integração com erro`, link: '/integracoes', tone: 'danger' })
  if (platformCan(ctx.user, 'carteira.ver')) {
    const sx = await db.one(`SELECT (SELECT count(*)::int FROM saas_reviews WHERE status = 'aberta') AS saas_reviews,
                                    (SELECT count(*)::int FROM saas_reviews WHERE status = 'aberta' AND severity = 'alta') AS saas_reviews_high,
                                    (SELECT count(*)::int FROM saas_contracts WHERE status = 'em_analise') AS saas_proposals`)
    Object.assign(r, sx)
    if (sx.saas_proposals) notifications.unshift({ icon: 'clipboard-list', text: `${sx.saas_proposals} proposta(s) de assinatura aguardando auditoria`, link: '/saas-auditoria', tone: 'info' })
    if (sx.saas_reviews_high) notifications.unshift({ icon: 'shield-alert', text: `${sx.saas_reviews_high} exceção(ões) de alta prioridade na carteira`, link: '/saas-auditoria', tone: 'danger' })
  }
  return { ...r, notifications }
})

/** Pesquisa global (⌘K): clientes, produtos e vendas pelo número. */
router.get('/api/search', {}, async (ctx) => {
  const q = (ctx.query.q || '').trim()
  if (q.length < 2) return { customers: [], products: [], sales: [] }
  const id = ctx.user.companyId
  const [customers, products, sales] = await Promise.all([
    can(ctx.user, 'clientes.ver') ? db.many(`SELECT id, name, cpf_cnpj FROM customers WHERE company_id = $1 AND anonymized_at IS NULL AND (name ILIKE $2 OR cpf_cnpj LIKE $3) ORDER BY name LIMIT 6`, [id, `%${q}%`, `%${q.replace(/\D/g, '') || '#'}%`]) : [],
    can(ctx.user, 'produtos.ver') ? db.many(`SELECT DISTINCT p.id, p.code, p.name FROM products p LEFT JOIN product_variants v ON v.product_id = p.id WHERE p.company_id = $1 AND (p.name ILIKE $2 OR p.code ILIKE $2 OR v.sku ILIKE $2 OR v.barcode = $3) ORDER BY p.name LIMIT 6`, [id, `%${q}%`, q]) : [],
    can(ctx.user, 'vendas.ver') && /^\d+$/.test(q) ? db.many(`SELECT id, number, total, status FROM sales WHERE company_id = $1 AND number = $2::bigint LIMIT 3`, [id, q]) : [],
  ])
  return { customers, products, sales }
})

/** Verificação de saúde (usada pela tela de abertura). */
export const APP_VERSION = '1.11.3'
/** Verificação pública: só diz se está no ar (sem versão/detalhes, que ajudariam a mapear o sistema). */
router.get('/api/health', { auth: 'none' }, async () => {
  await db.query('SELECT 1')
  return { ok: true, db: 'ok' }
})
/** Versão e migrações: só para usuários autenticados. */
router.get('/api/version', {}, async () => {
  const m = await db.one(`SELECT count(*)::int AS n FROM schema_migrations`)
  return { version: APP_VERSION, migrations: m.n }
})
