import { Q } from '../core/db'
import { DEFAULT_ROLES } from '../core/permissions'
import { applySegment, segmentOf, SegmentId } from './segments'

export interface NewCompany {
  name: string; tradeName?: string; cnpj?: string | null; ie?: string | null; taxRegime?: string; crt?: number; address?: any; isDemo?: boolean; color?: string
  segment?: SegmentId
  branch: { code: string; name: string; cnpj?: string | null; ie?: string | null; address?: any }
}

const FIN_CATEGORIES: [string, string, 'receita' | 'despesa', string, string | null][] = [
  ['1.01', 'Vendas de mercadorias', 'receita', 'receita_bruta', 'venda'],
  ['1.02', 'Recebimentos de crediário', 'receita', 'receita_bruta', 'recebimento_crediario'],
  ['1.03', 'Juros e multas recebidos', 'receita', 'receitas_financeiras', 'juros_recebidos'],
  ['1.04', 'Outras receitas', 'receita', 'outras', 'outras_receitas'],
  ['2.01', 'Devoluções de vendas', 'despesa', 'deducoes', 'devolucao'],
  ['2.02', 'Impostos sobre vendas', 'despesa', 'deducoes', 'impostos'],
  ['3.01', 'Compra de mercadorias', 'despesa', 'cmv', 'compra_mercadoria'],
  ['4.01', 'Salários e encargos', 'despesa', 'despesas_pessoal', 'salarios'],
  ['4.02', 'Comissões de vendedores', 'despesa', 'despesas_comerciais', 'comissoes'],
  ['4.03', 'Aluguel e condomínio', 'despesa', 'despesas_administrativas', 'aluguel'],
  ['4.04', 'Energia, água e internet', 'despesa', 'despesas_administrativas', 'utilidades'],
  ['4.05', 'Marketing e publicidade', 'despesa', 'despesas_comerciais', 'marketing'],
  ['4.06', 'Fretes e entregas', 'despesa', 'despesas_comerciais', 'fretes'],
  ['4.07', 'Sistemas e serviços', 'despesa', 'despesas_administrativas', 'servicos'],
  ['5.01', 'Taxas de cartão e meios de pagamento', 'despesa', 'despesas_financeiras', 'taxa_cartao'],
  ['5.02', 'Juros e tarifas bancárias', 'despesa', 'despesas_financeiras', 'tarifas'],
  ['6.01', 'Sangria de caixa', 'despesa', 'outras', 'sangria'],
  ['6.02', 'Suprimento de caixa', 'receita', 'outras', 'suprimento'],
]

const CHART: [string, string, string, string, boolean][] = [
  ['1', 'ATIVO', 'Ativo', 'Devedora', false], ['1.1', 'Ativo Circulante', 'Ativo', 'Devedora', false],
  ['1.1.01', 'Caixa e Equivalentes', 'Ativo', 'Devedora', true], ['1.1.02', 'Bancos Conta Movimento', 'Ativo', 'Devedora', true],
  ['1.1.03', 'Clientes (Crediário)', 'Ativo', 'Devedora', true], ['1.1.04', 'Cartões a Receber', 'Ativo', 'Devedora', true],
  ['1.1.05', 'Estoque de Mercadorias', 'Ativo', 'Devedora', true], ['1.2', 'Ativo Não Circulante', 'Ativo', 'Devedora', false],
  ['1.2.01', 'Imobilizado', 'Ativo', 'Devedora', true],
  ['2', 'PASSIVO', 'Passivo', 'Credora', false], ['2.1', 'Passivo Circulante', 'Passivo', 'Credora', false],
  ['2.1.01', 'Fornecedores', 'Passivo', 'Credora', true], ['2.1.02', 'Obrigações Trabalhistas', 'Passivo', 'Credora', true],
  ['2.1.03', 'Obrigações Tributárias', 'Passivo', 'Credora', true], ['2.1.04', 'Vales-troca e Cashback a Resgatar', 'Passivo', 'Credora', true],
  ['2.3', 'Patrimônio Líquido', 'Patrimônio Líquido', 'Credora', false], ['2.3.01', 'Capital Social', 'Patrimônio Líquido', 'Credora', true],
  ['3', 'RECEITAS', 'Receita', 'Credora', false], ['3.1.01', 'Receita de Vendas', 'Receita', 'Credora', true], ['3.1.02', 'Receitas Financeiras', 'Receita', 'Credora', true],
  ['4', 'CUSTOS E DESPESAS', 'Despesa', 'Devedora', false], ['4.1.01', 'Custo das Mercadorias Vendidas', 'Custo', 'Devedora', true],
  ['4.2.01', 'Despesas com Pessoal', 'Despesa', 'Devedora', true], ['4.2.02', 'Despesas Administrativas', 'Despesa', 'Devedora', true],
  ['4.2.03', 'Despesas Comerciais', 'Despesa', 'Devedora', true], ['4.2.04', 'Despesas Financeiras', 'Despesa', 'Devedora', true],
]

/** Cria empresa com estrutura mínima de operação (perfis, plano financeiro, formas de pagamento, conta, caixa, grades). */
export async function bootstrapCompany(c: Q, input: NewCompany) {
  const co = await c.one(
    `INSERT INTO companies(name, trade_name, cnpj, ie, tax_regime, crt, address, is_demo, color, modules, segment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [input.name, input.tradeName ?? null, input.cnpj ?? null, input.ie ?? null, input.taxRegime ?? 'simples', input.crt ?? 1, JSON.stringify(input.address ?? {}),
      !!input.isDemo, input.color ?? '#0875D1', segmentOf(input.segment).modules, segmentOf(input.segment).id])
  const br = await c.one(`INSERT INTO branches(company_id, code, name, cnpj, ie, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [co.id, input.branch.code, input.branch.name, input.branch.cnpj ?? null, input.branch.ie ?? null, JSON.stringify(input.branch.address ?? input.address ?? {})])
  const roles: Record<string, string> = {}
  for (const r of DEFAULT_ROLES) {
    const row = await c.one(`INSERT INTO roles(company_id, name, description, permissions, max_discount_pct, is_system) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
      [co.id, r.name, r.description, r.permissions, r.maxDiscount])
    roles[r.name] = row.id
  }
  for (const [code, name, type, group, key] of FIN_CATEGORIES)
    await c.query(`INSERT INTO financial_categories(company_id, code, name, type, dre_group, system_key) VALUES ($1,$2,$3,$4,$5,$6)`, [co.id, code, name, type, group, key])
  for (const [code, name, type, nature, analytic] of CHART)
    await c.query(`INSERT INTO chart_of_accounts(company_id, code, name, type, nature, analytic) VALUES ($1,$2,$3,$4,$5,$6)`, [co.id, code, name, type, nature, analytic])
  const caixa = await c.one(`INSERT INTO financial_accounts(company_id, branch_id, name, type) VALUES ($1,$2,$3,'caixa') RETURNING id`, [co.id, br.id, `Caixa ${input.branch.name}`])
  const banco = await c.one(`INSERT INTO financial_accounts(company_id, name, type) VALUES ($1,'Conta Bancária Principal','banco') RETURNING id`, [co.id])
  const adq = await c.one(`INSERT INTO financial_accounts(company_id, name, type) VALUES ($1,'Adquirente de Cartões','adquirente') RETURNING id`, [co.id])
  await c.query(`INSERT INTO cash_registers(company_id, branch_id, name, account_id) VALUES ($1,$2,'Caixa 01',$3)`, [co.id, br.id, caixa.id])
  const methods: [string, string, number, number, number, string | null, number][] = [
    ['Dinheiro', 'dinheiro', 0, 0, 1, caixa.id, 1], ['PIX', 'pix', 0, 0, 1, banco.id, 2], ['Cartão de Débito', 'debito', 1.5, 1, 1, adq.id, 3],
    ['Cartão de Crédito', 'credito', 3.2, 30, 10, adq.id, 4], ['Crediário', 'crediario', 0, 0, 10, null, 5], ['Vale-troca', 'vale_troca', 0, 0, 1, null, 6],
    ['Cashback', 'cashback', 0, 0, 1, null, 7], ['Boleto', 'boleto', 1.0, 2, 1, banco.id, 8],
  ]
  for (const [name, kind, fee, days, maxInst, acc, sort] of methods)
    await c.query(`INSERT INTO payment_methods(company_id, name, kind, fee_pct, settlement_days, max_installments, account_id, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [co.id, name, kind, fee, days, maxInst, acc, sort])
  // módulos, categorias, unidades, grades (moda) e parâmetros do segmento escolhido
  await applySegment(c, co.id, segmentOf(input.segment).id, { replaceModules: true })
  await c.query(`INSERT INTO commission_rules(company_id, name, scope, pct, priority) VALUES ($1,'Comissão padrão','padrao',3,0)`, [co.id])
  const integrations: [string, string, string][] = [
    ['ecommerce', 'generico', 'Loja virtual (adaptador REST)'], ['logistica', 'generico', 'Cotação de frete e etiquetas'],
    ['whatsapp', 'meta_cloud_api', 'WhatsApp Business Platform (oficial)'], ['fiscal', 'provedor_nfe', 'Provedor de NF-e/NFC-e'],
    ['assistente_ia', 'llm', 'Modelo de linguagem para a AXIA'],
  ]
  for (const [kind, provider, name] of integrations)
    await c.query(`INSERT INTO integrations(company_id, kind, provider, name) VALUES ($1,$2,$3,$4)`, [co.id, kind, provider, name])
  // precificação: parâmetros e despesas variáveis iniciais (revisáveis pelo lojista)
  await c.query(`INSERT INTO pricing_settings(company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [co.id])
  for (const [cat, desc, val] of [['impostos', 'Impostos sobre vendas (alíquota estimada — revise com o contador)', 6], ['cartao', 'Taxa média de cartão', 3.2], ['comissao', 'Comissão de vendas (percentual padrão)', 3]] as [string, string, number][])
    await c.query(`INSERT INTO variable_costs(company_id, category, description, kind, value) VALUES ($1,$2,$3,'percentual',$4)`, [co.id, cat, desc, val])
  return { company: co, branch: br, roles, accounts: { caixa: caixa.id, banco: banco.id, adquirente: adq.id } }
}
