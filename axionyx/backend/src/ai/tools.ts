import { db } from '../core/db'
import { can, r2, today, type AuthUser } from '../core/http'
import { BALANCE_SQL } from '../services/finance'
import { profitDiagnosis, resolvePeriods, type PeriodKey } from '../services/diagnosis'
import { dre } from '../modules/relatorios'
import type { ToolDef } from './providers'
import type { CompanyAI } from './config'
import { searchDocuments, readDocument } from './documents'

/**
 * Ferramentas que a IA pode chamar. Cada uma roda com a EMPRESA e as PERMISSÕES de quem perguntou (as mesmas das telas):
 * a IA nunca alcança dado que a pessoa não poderia ver. Somente consultas — nenhuma ferramenta altera dados.
 * Ficam de fora, sempre: prontuário e dados clínicos, salários, CPF/telefone/endereço de clientes.
 */
export type Source = { type: 'tela'; label: string; link: string } | { type: 'documento'; id: string; name: string; page: number | null; pages?: number[] }
export interface ToolCtx { user: AuthUser; ai: CompanyAI; sources: Source[]; docsUsed: Map<string, { id: string; name: string; pages: number[] }> }
interface Tool { def: ToolDef; perms?: string[]; docs?: boolean; run: (a: any, t: ToolCtx) => Promise<unknown> }

const PERIODOS = ['hoje', '7d', '30d', 'mes', 'mes_anterior', '90d']
const periodo = { type: 'string', enum: PERIODOS, description: 'hoje, 7d (últimos 7 dias), 30d, mes (este mês até hoje), mes_anterior, 90d' }
const range = (p: string) => (p === 'hoje' ? { from: today(), to: today(), label: 'hoje' } : (() => { const r = resolvePeriods((PERIODOS.includes(p) ? p : '30d') as PeriodKey); return { from: r.from, to: r.to, label: r.label } })())
const tela = (t: ToolCtx, label: string, link: string) => { if (!t.sources.some((s) => s.type === 'tela' && s.link === link)) t.sources.push({ type: 'tela', label, link }) }
const anyOf = (u: AuthUser, perms?: string[]) => !perms || perms.some((p) => can(u, p))

const TOOLS: Tool[] = [
  { def: { name: 'empresa', description: 'Dados gerais da empresa: nome, segmento, filiais e data de hoje.', parameters: { type: 'object', properties: {} } },
    run: async (_a, t) => {
      const c = await db.one(`SELECT name, trade_name, segment, (SELECT count(*)::int FROM branches b WHERE b.company_id = c.id) AS branches FROM companies c WHERE id = $1`, [t.user.companyId])
      return { nome: c.trade_name || c.name, segmento: c.segment, filiais: c.branches, hoje: today() }
    } },
  { def: { name: 'resumo_vendas', description: 'Faturamento, número de vendas, ticket médio, itens e desconto médio de um período, total e por filial.', parameters: { type: 'object', properties: { periodo }, required: ['periodo'] } },
    perms: ['vendas.ver', 'relatorios.ver', 'dashboard.ver'],
    run: async (a, t) => {
      const r = range(a.periodo)
      const rows = await db.many(`SELECT b.name AS filial, count(s.id)::int AS vendas, COALESCE(sum(s.total),0)::float8 AS faturamento, COALESCE(sum(s.items_count),0)::int AS itens,
                                         COALESCE(sum(s.discount_total),0)::float8 AS desconto, COALESCE(sum(s.subtotal),0)::float8 AS bruto
                                    FROM branches b LEFT JOIN sales s ON s.branch_id = b.id AND s.type = 'venda' AND s.status <> 'cancelada' AND s.created_at >= $2::date AND s.created_at < $3::date + interval '1 day'
                                   WHERE b.company_id = $1 GROUP BY b.name ORDER BY 3 DESC`, [t.user.companyId, r.from, r.to])
      const tot = rows.reduce((s: any, x: any) => ({ vendas: s.vendas + x.vendas, faturamento: s.faturamento + x.faturamento, itens: s.itens + x.itens, desconto: s.desconto + x.desconto, bruto: s.bruto + x.bruto }), { vendas: 0, faturamento: 0, itens: 0, desconto: 0, bruto: 0 })
      tela(t, 'Relatórios de vendas', 'relatorios')
      return { periodo: r.label, de: r.from, ate: r.to, vendas: tot.vendas, faturamento: r2(tot.faturamento), ticket_medio: tot.vendas ? r2(tot.faturamento / tot.vendas) : 0, itens: tot.itens,
        desconto_medio_pct: tot.bruto ? r2(tot.desconto / tot.bruto * 100) : 0, por_filial: rows.map((x: any) => ({ filial: x.filial, vendas: x.vendas, faturamento: r2(x.faturamento) })) }
    } },
  { def: { name: 'diagnostico_lucro', description: 'Pré-diagnóstico: por que o lucro (ou o faturamento) mudou entre o período e o período anterior. Causas que somam a variação, com evidências.',
      parameters: { type: 'object', properties: { periodo: { type: 'string', enum: ['7d', '30d', 'mes', 'mes_anterior', '90d'] }, foco: { type: 'string', enum: ['lucro', 'vendas'] } }, required: ['periodo'] } },
    perms: ['financeiro.ver', 'contabilidade.ver', 'vendas.ver', 'relatorios.ver'],
    run: async (a, t) => {
      const canProfit = can(t.user, 'financeiro.ver') || can(t.user, 'contabilidade.ver')
      const d = await profitDiagnosis(t.user.companyId, (['7d', '30d', 'mes', 'mes_anterior', '90d'].includes(a.periodo) ? a.periodo : '30d') as PeriodKey,
        { focus: a.foco === 'vendas' || !canProfit ? 'vendas' : 'lucro', showCosts: can(t.user, 'produtos.custo') })
      tela(t, 'Diagnóstico do Lucro', `diagnostico-lucro?periodo=${d.periods.key}${d.focus === 'vendas' ? '&foco=vendas' : ''}`)
      return { foco: d.focus, periodo: `${d.periods.label} (${d.periods.currentLabel}) x ${d.periods.previousLabel}`, indicador: d.headline,
        causas: d.drivers.filter((x) => !x.minor).map((x) => ({ causa: x.label, impacto: x.impact, detalhe: x.detail, evidencias: x.evidence })),
        tambem_vale_olhar: d.attention, por_onde_comecar: d.actions.map((x) => x.text), confianca: d.confidence, metodo: d.method }
    } },
  { def: { name: 'dre', description: 'DRE gerencial (receita, CMV, lucro bruto, despesas por grupo, resultado) entre duas datas (AAAA-MM-DD).',
      parameters: { type: 'object', properties: { de: { type: 'string', description: 'AAAA-MM-DD' }, ate: { type: 'string', description: 'AAAA-MM-DD' } }, required: ['de', 'ate'] } },
    perms: ['financeiro.ver', 'contabilidade.ver'],
    run: async (a, t) => {
      const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s || '')
      if (!ok(a.de) || !ok(a.ate)) return { erro: 'Datas no formato AAAA-MM-DD.' }
      const d = await dre(t.user.companyId, a.de, a.ate)
      tela(t, 'DRE', 'dre')
      return { de: d.from, ate: d.to, linhas: d.lines.map((l: any) => ({ conta: l.label, valor: l.value })), margens_pct: d.margins, despesas_por_categoria: d.details.map((e: any) => ({ grupo: e.dre_group, categoria: e.name, total: Number(e.total) })) }
    } },
  { def: { name: 'contas', description: 'Contas a receber ou a pagar: vencidas ou a vencer nos próximos dias. Total e principais títulos.',
      parameters: { type: 'object', properties: { tipo: { type: 'string', enum: ['receber', 'pagar'] }, situacao: { type: 'string', enum: ['vencidas', 'a_vencer'] }, dias: { type: 'integer', description: 'janela para a vencer (padrão 30)' } }, required: ['tipo', 'situacao'] } },
    perms: ['financeiro.ver'],
    run: async (a, t) => {
      const table = a.tipo === 'pagar' ? 'payables' : 'receivables'
      const who = a.tipo === 'pagar' ? `(SELECT name FROM suppliers s WHERE s.id = x.supplier_id)` : `(SELECT name FROM customers c WHERE c.id = x.customer_id)`
      const dias = Math.min(365, Math.max(1, Number(a.dias) || 30))
      const cond = a.situacao === 'vencidas' ? `x.due_date < current_date` : `x.due_date BETWEEN current_date AND current_date + $2::int`
      const rows = await db.many(`SELECT x.document, x.description, x.due_date, ${BALANCE_SQL} AS saldo, ${who} AS nome FROM ${table} x
                                   WHERE x.company_id = $1 AND x.status IN ('aberto','parcial') AND ${cond} ORDER BY x.due_date LIMIT 300`, a.situacao === 'vencidas' ? [t.user.companyId] : [t.user.companyId, dias])
      tela(t, a.tipo === 'pagar' ? 'Contas a pagar' : 'Contas a receber', a.tipo === 'pagar' ? 'contas-pagar' : 'contas-receber')
      const total = rows.reduce((s: number, r: any) => s + Number(r.saldo), 0)
      return { tipo: a.tipo, situacao: a.situacao, janela_dias: a.situacao === 'a_vencer' ? dias : undefined, titulos: rows.length, total: r2(total),
        principais: [...rows].sort((x: any, y: any) => Number(y.saldo) - Number(x.saldo)).slice(0, 10).map((r: any) => ({ documento: r.document, nome: r.nome, descricao: r.description, vencimento: r.due_date, saldo: r2(Number(r.saldo)) })) }
    } },
  { def: { name: 'estoque', description: 'Situação do estoque: abaixo do mínimo, risco de ruptura (cobertura < 14 dias) ou parado (sem venda há 60 dias).',
      parameters: { type: 'object', properties: { tipo: { type: 'string', enum: ['abaixo_minimo', 'ruptura', 'parado'] } }, required: ['tipo'] } },
    perms: ['estoque.ver'],
    run: async (a, t) => {
      tela(t, 'Estoque', a.tipo === 'ruptura' ? 'estoque-inteligente' : 'estoque-posicao')
      if (a.tipo === 'parado') {
        const r = await db.many(`SELECT p.name, sum(sb.qty)::float8 AS qtd FROM stock_balances sb JOIN product_variants v ON v.id = sb.variant_id JOIN products p ON p.id = v.product_id
                                  WHERE sb.company_id = $1 AND sb.qty > 0 AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.variant_id = v.id AND s.created_at > now() - interval '60 days' AND s.status <> 'cancelada')
                                  GROUP BY p.name ORDER BY 2 DESC LIMIT 15`, [t.user.companyId])
        return { tipo: 'parado (sem venda há 60 dias)', itens: r.map((x: any) => ({ produto: x.name, quantidade: x.qtd })) }
      }
      if (a.tipo === 'ruptura') {
        const r = await db.many(`WITH sold AS (SELECT si.variant_id, sum(si.qty)::numeric / 30 AS d FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.created_at > now() - interval '30 days' GROUP BY 1)
                                 SELECT p.name, COALESCE(st.q,0)::float8 AS estoque, round(sold.d, 2)::float8 AS venda_dia, round(COALESCE(st.q,0) / sold.d)::int AS cobertura_dias
                                   FROM sold JOIN product_variants v ON v.id = sold.variant_id JOIN products p ON p.id = v.product_id
                                   LEFT JOIN (SELECT variant_id, sum(qty) AS q FROM stock_balances WHERE company_id = $1 GROUP BY 1) st ON st.variant_id = sold.variant_id
                                  WHERE sold.d > 0 AND COALESCE(st.q,0) / sold.d < 14 ORDER BY 4 LIMIT 15`, [t.user.companyId])
        return { tipo: 'risco de ruptura', itens: r }
      }
      const r = await db.many(`SELECT p.name, COALESCE(sum(sb.qty),0)::float8 AS qtd, COALESCE(v.min_stock, p.min_stock) AS minimo FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN stock_balances sb ON sb.variant_id = v.id
                                WHERE v.company_id = $1 AND v.active AND p.track_stock GROUP BY v.id, p.name, p.min_stock HAVING COALESCE(sum(sb.qty),0) <= COALESCE(v.min_stock, p.min_stock) AND COALESCE(v.min_stock, p.min_stock) > 0 ORDER BY 2 LIMIT 15`, [t.user.companyId])
      return { tipo: 'abaixo do mínimo', itens: r.map((x: any) => ({ produto: x.name, quantidade: x.qtd, minimo: Number(x.minimo) })) }
    } },
  { def: { name: 'mais_vendidos', description: 'Produtos ou serviços mais vendidos (quantidade e faturamento) nos últimos N dias.', parameters: { type: 'object', properties: { dias: { type: 'integer' } } } },
    perms: ['vendas.ver', 'relatorios.ver'],
    run: async (a, t) => {
      const dias = Math.min(365, Math.max(1, Number(a.dias) || 30))
      const r = await db.many(`SELECT p.name, sum(si.qty)::float8 AS qtd, sum(si.total)::float8 AS faturamento FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                                WHERE s.company_id = $1 AND s.status <> 'cancelada' AND s.type = 'venda' AND s.created_at > now() - ($2::int * interval '1 day') GROUP BY p.name ORDER BY 3 DESC LIMIT 10`, [t.user.companyId, dias])
      tela(t, 'Relatórios de vendas', 'relatorios')
      return { dias, itens: r.map((x: any) => ({ produto: x.name, quantidade: x.qtd, faturamento: r2(x.faturamento) })) }
    } },
  { def: { name: 'alertas', description: 'Alertas automáticos do sistema (ruptura, estoque parado, condicionais vencidos, inadimplência, concentração, descontos, aniversariantes).', parameters: { type: 'object', properties: {} } },
    perms: ['dashboard.ver'],
    run: async (_a, t) => {
      const { insights } = await import('../modules/outros')
      tela(t, 'IA Insights', 'ia-insights')
      return (await insights(t.user.companyId, { finance: can(t.user, 'financeiro.ver') })).map((i) => ({ alerta: i.text, gravidade: i.severity }))
    } },
  { def: { name: 'processos_juridicos', description: 'Processos e casos jurídicos cadastrados no módulo Jurídico (número, assunto, situação, risco, próximo prazo).',
      parameters: { type: 'object', properties: { somente_prazo_proximo: { type: 'boolean', description: 'apenas com prazo nos próximos 30 dias' } } } },
    perms: ['juridico.ver'],
    run: async (a, t) => {
      const r = await db.many(`SELECT number, title, kind, court, counterpart, status, risk, amount, next_deadline FROM legal_cases WHERE company_id = $1 ${a.somente_prazo_proximo ? `AND next_deadline BETWEEN current_date AND current_date + 30` : ''} ORDER BY next_deadline NULLS LAST LIMIT 30`, [t.user.companyId])
      tela(t, 'Jurídico › Processos', 'processos')
      return r.map((x: any) => ({ numero: x.number, assunto: x.title, tipo: x.kind, vara: x.court, parte_contraria: x.counterpart, situacao: x.status, risco: x.risk, valor: x.amount === null ? null : Number(x.amount), proximo_prazo: x.next_deadline }))
    } },
  { def: { name: 'buscar_documentos', description: 'Busca nos documentos enviados pela empresa (contratos, políticas, notas, planilhas). Devolve trechos com nome do documento e página. Use antes de responder sobre documentos ou dúvidas jurídicas.',
      parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'palavras-chave em português' }, pasta: { type: 'string', description: 'opcional: limitar a uma pasta' } }, required: ['consulta'] } },
    perms: ['documentos.ver'], docs: true,
    run: async (a, t) => {
      const r = await searchDocuments(t.user.companyId, String(a.consulta || ''), { blocked: t.ai.blockedFolders, folder: a.pasta || undefined })
      for (const x of r) { const u = t.docsUsed.get(x.documentId) ?? { id: x.documentId, name: x.name, pages: [] as number[] }; if (x.page && !u.pages.includes(x.page)) u.pages.push(x.page); t.docsUsed.set(x.documentId, u) }
      return r.length ? r.map((x) => ({ documento_id: x.documentId, documento: x.name, pasta: x.folder, pagina: x.page, trecho: x.excerpt })) : { resultado: 'Nenhum trecho encontrado nos documentos da empresa para esses termos.' }
    } },
  { def: { name: 'ler_documento', description: 'Lê o texto de um documento da empresa (todo ou uma página). Use o documento_id retornado por buscar_documentos ou listar_documentos.',
      parameters: { type: 'object', properties: { documento_id: { type: 'string' }, pagina: { type: 'integer' } }, required: ['documento_id'] } },
    perms: ['documentos.ver'], docs: true,
    run: async (a, t) => {
      if (!/^[0-9a-f-]{36}$/i.test(String(a.documento_id || ''))) return { erro: 'documento_id inválido.' }
      const r: any = await readDocument(t.user.companyId, a.documento_id, { blocked: t.ai.blockedFolders, page: Number(a.pagina) || undefined })
      if (r.text) { const u = t.docsUsed.get(r.documentId) ?? { id: r.documentId, name: r.name, pages: [] as number[] }; if (a.pagina && !u.pages.includes(Number(a.pagina))) u.pages.push(Number(a.pagina)); t.docsUsed.set(r.documentId, u) }
      return r
    } },
  { def: { name: 'listar_documentos', description: 'Lista os documentos enviados pela empresa (nome, pasta, data, se a IA consegue ler).', parameters: { type: 'object', properties: { pasta: { type: 'string' } } } },
    perms: ['documentos.ver'], docs: true,
    run: async (a, t) => {
      const r = await db.many(`SELECT d.id, d.name, d.folder, d.created_at, COALESCE(dt.status, 'nao_lido') AS leitura FROM documents d LEFT JOIN document_texts dt ON dt.document_id = d.id
                                WHERE d.company_id = $1 AND ($2::text IS NULL OR lower(d.folder) = lower($2)) AND NOT (lower(d.folder) = ANY($3::text[])) ORDER BY d.created_at DESC LIMIT 60`,
        [t.user.companyId, a.pasta || null, t.ai.blockedFolders.map((b) => b.toLowerCase())])
      tela(t, 'Documentos', 'documentos')
      return r.map((x: any) => ({ documento_id: x.id, nome: x.name, pasta: x.folder, enviado_em: x.created_at, leitura: x.leitura }))
    } },
]

/** Ferramentas oferecidas a este usuário (só as que ele tem permissão). */
export function toolsFor(user: AuthUser, ai: CompanyAI): Tool[] {
  return TOOLS.filter((x) => anyOf(user, x.perms) && (!x.docs || ai.documentsEnabled))
}
export async function execTool(tools: Tool[], name: string, args: any, t: ToolCtx): Promise<unknown> {
  const tool = tools.find((x) => x.def.name === name)
  if (!tool) return { erro: `Ferramenta "${name}" não disponível para este usuário.` }
  if (!anyOf(t.user, tool.perms)) return { erro: 'Sem permissão para esta consulta.' }
  try { return await tool.run(args && typeof args === 'object' ? args : {}, t) }
  catch (e: any) { return { erro: 'Falha na consulta: ' + String(e?.message || e).slice(0, 160) } }
}
