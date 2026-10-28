import { Q } from '../core/db'
import { DEFAULT_ROLES, HEALTH_ROLES } from '../core/permissions'

/**
 * Segmentos de negócio. Cada segmento é um "pacote": módulos ativos (menu e telas), vocabulário,
 * categorias e unidades iniciais e parâmetros padrão. O núcleo (vendas, estoque, financeiro, fiscal...)
 * é o mesmo para todos; aplicar um pacote só ADICIONA módulos, categorias e parâmetros — nunca apaga dados.
 */
export type SegmentId = 'moda' | 'hortifruti' | 'adega' | 'mercado' | 'cosmeticos' | 'odontologia' | 'estetica' | 'salao' | 'oficina' | 'saude' | 'geral'

/** Módulos que dependem do ramo (além dos módulos gerais do sistema). */
export const FEATURE_MODULES: Record<string, { name: string; desc: string; icon: string }> = {
  grade: { name: 'Grade cor × tamanho', desc: 'Variações por cor e tamanho com SKU/EAN por variação', icon: 'grid-3x3' },
  colecoes: { name: 'Coleções', desc: 'Organização do catálogo por coleção/estação', icon: 'layers' },
  peso: { name: 'Venda por peso e balança', desc: 'Produtos vendidos por kg, leitura de balança no PDV e etiqueta de balança', icon: 'scale' },
  validade: { name: 'Lotes, validade e perdas', desc: 'Entrada com lote e validade, alertas de vencimento, consumo FEFO e registro de perdas', icon: 'calendar-clock' },
  embalagens: { name: 'Embalagens (unidade/caixa)', desc: 'Venda por unidade ou caixa com código de barras próprio da embalagem', icon: 'package' },
  combos: { name: 'Combos e kits', desc: 'Kits com preço promocional que baixam o estoque de cada item', icon: 'gift' },
  precos_quantidade: { name: 'Preço por quantidade (atacarejo)', desc: 'Preço unitário menor a partir de N unidades (ex.: leve 6, pague menos), aplicado automaticamente no PDV', icon: 'trending-down' },
  maioridade: { name: 'Controle de maioridade', desc: 'Confirmação obrigatória de idade no PDV para produtos restritos', icon: 'shield-check' },
  agenda: { name: 'Agenda, serviços e profissionais', desc: 'Agenda por profissional, serviços com duração, bloqueios, comissão por profissional e cobrança do atendimento no PDV', icon: 'calendar-days' },
  pacotes: { name: 'Pacotes de sessões', desc: 'Venda de pacotes (ex.: 10 sessões) com controle de saldo, validade e baixa a cada atendimento', icon: 'ticket' },
  prontuario: { name: 'Prontuário e fichas', desc: 'Anamnese com consentimento, evolução, ficha técnica e histórico de atendimentos (dados de saúde com acesso auditado)', icon: 'clipboard-list' },
  saude: { name: 'Clínica: recepção, convênios e documentos clínicos', desc: 'Sala de espera, convênios com tabela de preços e faturamento de guias, receitas, atestados, pedidos de exame e encaminhamentos, prontuário por especialidade com sigilo, sinais vitais e CID', icon: 'stethoscope' },
  oficina: { name: 'Oficina: ordens de serviço e veículos', desc: 'Ordem de serviço com checklist de entrada, orçamento com aprovação, mão de obra por serviço ou por hora, peças do estoque, garantia, histórico por placa e lembrete de revisão', icon: 'wrench' },
  odontograma: { name: 'Odontograma e planos de tratamento', desc: 'Odontograma por dente e face, plano de tratamento com aprovação e cobrança parcelada', icon: 'smile' },
}

const CORE = ['vendas', 'estoque', 'financeiro', 'fiscal', 'fidelidade', 'crm', 'contabilidade', 'intelligence', 'precificacao']

export interface SegmentDef {
  id: SegmentId; name: string; short: string; icon: string; status: 'disponivel' | 'em_breve'; description: string
  modules: string[]; terms: Record<string, string>; categories: string[]; defaultUnit: string; units: string[]
  sizeGrids?: [string, string[]][]; settings?: Record<string, any>
}

export const BASE_TERMS: Record<string, string> = {
  colecao: 'Coleção', colecoes: 'Coleções', grade: 'Grade', cor: 'Cor', cores: 'Cores', tamanho: 'Tamanho', tamanhos: 'Tamanhos', variacao: 'Variação',
  produto: 'Produto', produtos: 'Produtos', lote: 'Lote', safra: 'Safra',
  cliente: 'Cliente', clientes: 'Clientes', profissional: 'Profissional', profissionais: 'Profissionais', atendimento: 'Atendimento', atendimentos: 'Atendimentos',
  prontuario: 'Ficha', servico: 'Serviço', servicos: 'Serviços', sala: 'Sala',
}

export const SEGMENTS: Record<SegmentId, SegmentDef> = {
  moda: {
    id: 'moda', name: 'Moda e vestuário', short: 'Moda', icon: 'shirt', status: 'disponivel',
    description: 'Lojas de roupas, calçados e acessórios: grade cor × tamanho, condicional, bag delivery, consignação, coleções e crediário.',
    modules: [...CORE, 'grade', 'colecoes', 'condicional', 'consignacao', 'rh', 'juridico'],
    terms: {}, defaultUnit: 'UN', units: ['UN', 'PC', 'PAR', 'KIT'],
    categories: ['Camisetas', 'Blusas', 'Vestidos', 'Calças', 'Bermudas', 'Saias', 'Jaquetas', 'Moda Praia', 'Calçados', 'Acessórios'],
    sizeGrids: [['Adulto', ['PP', 'P', 'M', 'G', 'GG', 'XG']], ['Numérica', ['34', '36', '38', '40', '42', '44', '46', '48']], ['Calçados', ['33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44']], ['Único', ['U']]],
  },
  hortifruti: {
    id: 'hortifruti', name: 'Hortifrúti e quitanda', short: 'Hortifrúti', icon: 'apple', status: 'disponivel',
    description: 'Quitandas, sacolões e hortifrútis: venda por peso com balança, etiqueta de balança, validade curta e controle de perdas.',
    modules: [...CORE, 'peso', 'validade', 'combos'],
    terms: { produto: 'Produto', variacao: 'Item' }, defaultUnit: 'KG', units: ['KG', 'UN', 'MÇ', 'BDJ', 'DZ', 'CX'],
    categories: ['Frutas', 'Verduras', 'Legumes', 'Temperos e ervas', 'Ovos', 'Orgânicos', 'Mercearia', 'Laticínios', 'Bebidas'],
    settings: { vendas: { permitirEstoqueNegativo: true }, validade: { alertaDias: 2 } },
  },
  adega: {
    id: 'adega', name: 'Adega e bebidas', short: 'Adega', icon: 'wine', status: 'disponivel',
    description: 'Adegas, empórios e distribuidoras de bebidas: garrafa ou caixa, safra/lote/validade, confirmação de maioridade e combos.',
    modules: [...CORE, 'embalagens', 'validade', 'combos', 'maioridade'],
    terms: { lote: 'Lote/safra' }, defaultUnit: 'UN', units: ['UN', 'GRF', 'CX', 'LT', 'FD'],
    categories: ['Vinhos tintos', 'Vinhos brancos', 'Vinhos rosés', 'Espumantes', 'Destilados', 'Cervejas', 'Licores', 'Sem álcool', 'Acessórios', 'Petiscos'],
    settings: { maioridade: { exigirConfirmacao: true }, validade: { alertaDias: 30 } },
  },
  mercado: {
    id: 'mercado', name: 'Mercadinho e conveniência', short: 'Mercado', icon: 'shopping-basket', status: 'disponivel',
    description: 'Mercadinhos, minimercados e lojas de conveniência: código de barras do fabricante, venda por peso, preço por quantidade (atacarejo), validade por lote, fardos/caixas, combos, maioridade e fiado no crediário.',
    modules: [...CORE, 'peso', 'validade', 'embalagens', 'combos', 'maioridade', 'precos_quantidade'],
    terms: { variacao: 'Item' }, defaultUnit: 'UN', units: ['UN', 'KG', 'CX', 'FD', 'PCT', 'LT', 'DZ'],
    categories: ['Mercearia', 'Bebidas', 'Bebidas alcoólicas', 'Frios e laticínios', 'Hortifrúti', 'Padaria', 'Congelados', 'Limpeza', 'Higiene e perfumaria', 'Bomboniere', 'Utilidades', 'Tabacaria'],
    settings: { validade: { alertaDias: 7 }, maioridade: { exigirConfirmacao: true } },
  },
  cosmeticos: {
    id: 'cosmeticos', name: 'Cosméticos e perfumaria', short: 'Cosméticos', icon: 'sparkles', status: 'disponivel',
    description: 'Lojas de cosméticos, perfumarias e maquiagem: variações por tonalidade e volume, lote e validade, kits presenteáveis, testers e amostras, revendedoras (consignação), cashback e CRM.',
    modules: [...CORE, 'grade', 'validade', 'combos', 'consignacao', 'precos_quantidade'],
    terms: { cor: 'Tonalidade', cores: 'Tonalidades', tamanho: 'Volume/tamanho', tamanhos: 'Volumes/tamanhos', grade: 'Variações', colecao: 'Linha', colecoes: 'Linhas' },
    defaultUnit: 'UN', units: ['UN', 'KIT', 'ML', 'G', 'PC'],
    categories: ['Perfumes femininos', 'Perfumes masculinos', 'Perfumes unissex', 'Maquiagem', 'Skincare', 'Cabelos', 'Corpo e banho', 'Unhas', 'Dermocosméticos', 'Kits e presentes', 'Acessórios'],
    sizeGrids: [['Volume', ['5ml', '15ml', '30ml', '50ml', '75ml', '100ml', '150ml', '200ml']], ['Peso', ['10g', '30g', '50g', '100g', '200g', '500g']], ['Tamanho', ['P', 'M', 'G']], ['Único', ['U']]],
    settings: { validade: { alertaDias: 60 } },
  },
  odontologia: {
    id: 'odontologia', name: 'Odontologia', short: 'Odontologia', icon: 'smile', status: 'disponivel',
    description: 'Consultórios e clínicas odontológicas: agenda por dentista, prontuário com anamnese, odontograma, plano de tratamento com aprovação e parcelamento, comissão por profissional e venda de produtos.',
    modules: [...CORE, 'agenda', 'prontuario', 'odontograma', 'pacotes'],
    terms: { cliente: 'Paciente', clientes: 'Pacientes', atendimento: 'Consulta', atendimentos: 'Consultas', prontuario: 'Prontuário', sala: 'Consultório' },
    defaultUnit: 'UN', units: ['UN', 'SESSAO', 'CX', 'KIT'],
    categories: ['Consultas e avaliações', 'Prevenção', 'Dentística', 'Endodontia', 'Periodontia', 'Cirurgia', 'Prótese', 'Implantodontia', 'Ortodontia', 'Estética dental', 'Odontopediatria', 'Produtos de higiene'],
    settings: { agenda: { intervaloMin: 30, antecedenciaLembreteHoras: 24 } },
  },
  estetica: {
    id: 'estetica', name: 'Clínica de estética', short: 'Estética', icon: 'sparkles', status: 'disponivel',
    description: 'Clínicas de estética facial e corporal, depilação e bem-estar: agenda por profissional e sala, pacotes de sessões, ficha de avaliação com anamnese, comissões e venda de dermocosméticos.',
    modules: [...CORE, 'agenda', 'prontuario', 'pacotes', 'combos', 'validade'],
    terms: { prontuario: 'Ficha de avaliação', atendimento: 'Sessão', atendimentos: 'Sessões', sala: 'Sala' },
    defaultUnit: 'UN', units: ['UN', 'SESSAO', 'ML', 'G', 'KIT'],
    categories: ['Estética facial', 'Estética corporal', 'Depilação', 'Massagem e bem-estar', 'Sobrancelhas e cílios', 'Pacotes', 'Dermocosméticos', 'Skincare', 'Corpo e banho'],
    settings: { agenda: { intervaloMin: 30, antecedenciaLembreteHoras: 24 }, validade: { alertaDias: 60 } },
  },
  salao: {
    id: 'salao', name: 'Salão de beleza e estética', short: 'Salão', icon: 'scissors', status: 'disponivel',
    description: 'Salões de beleza, barbearias, esmalterias e espaços com estética: agenda por profissional, comissão por serviço e por produto, pacotes, ficha técnica (ex.: fórmula de coloração), estética no mesmo cadastro e venda de produtos.',
    modules: [...CORE, 'agenda', 'prontuario', 'pacotes', 'combos', 'validade'],
    terms: { prontuario: 'Ficha técnica', sala: 'Cadeira/sala' },
    defaultUnit: 'UN', units: ['UN', 'SESSAO', 'ML', 'G', 'KIT'],
    categories: ['Cabelo — corte', 'Cabelo — coloração', 'Cabelo — tratamentos', 'Escova e penteado', 'Barbearia', 'Manicure e pedicure', 'Sobrancelhas e cílios', 'Maquiagem', 'Depilação',
      'Estética facial', 'Estética corporal', 'Pacotes', 'Produtos para cabelo', 'Produtos para unhas', 'Cosméticos'],
    settings: { agenda: { intervaloMin: 15, antecedenciaLembreteHoras: 24 }, validade: { alertaDias: 60 } },
  },
  saude: {
    id: 'saude', name: 'Clínica e consultório de saúde', short: 'Saúde', icon: 'stethoscope', status: 'disponivel',
    description: 'Consultórios e clínicas de todas as especialidades (medicina, psicologia, fisioterapia, nutrição, fonoaudiologia, enfermagem, terapias…), do profissional autônomo à clínica com recepção, gerente e vários profissionais: agenda, sala de espera, prontuário por especialidade com sigilo, documentos clínicos, convênios e particular.',
    modules: [...CORE, 'agenda', 'prontuario', 'pacotes', 'saude'],
    terms: { cliente: 'Paciente', clientes: 'Pacientes', atendimento: 'Atendimento', atendimentos: 'Atendimentos', prontuario: 'Prontuário', sala: 'Consultório', servico: 'Procedimento', servicos: 'Procedimentos' },
    defaultUnit: 'UN', units: ['UN', 'SESSAO', 'CX', 'ML', 'KIT'],
    categories: ['Consultas', 'Retornos', 'Teleconsultas', 'Avaliações', 'Sessões', 'Procedimentos', 'Exames', 'Aplicações e vacinas', 'Pacotes de sessões', 'Produtos e materiais'],
    settings: { agenda: { intervaloMin: 30, antecedenciaLembreteHoras: 24 } },
  },
  oficina: {
    id: 'oficina', name: 'Oficina mecânica (carro e moto)', short: 'Oficina', icon: 'wrench', status: 'disponivel',
    description: 'Oficinas mecânicas, centros automotivos e oficinas de moto: ordem de serviço com checklist e aprovação do orçamento, mão de obra por serviço ou por hora, peças e produtos do estoque repassados ao cliente, comissão por mecânico, garantia, histórico por placa e lembrete de revisão.',
    modules: [...CORE, 'oficina', 'agenda', 'combos'],
    terms: { profissional: 'Mecânico', profissionais: 'Mecânicos', atendimento: 'Ordem de serviço', atendimentos: 'Ordens de serviço', sala: 'Box/elevador', variacao: 'Item' },
    defaultUnit: 'UN', units: ['UN', 'L', 'H', 'KIT', 'JG', 'PAR', 'PC', 'M'],
    categories: ['Serviços — revisão e manutenção', 'Serviços — motor', 'Serviços — freios', 'Serviços — suspensão e direção', 'Serviços — elétrica e injeção', 'Serviços — ar-condicionado',
      'Serviços — moto', 'Óleos e lubrificantes', 'Filtros', 'Peças — motor', 'Peças — freios', 'Peças — suspensão', 'Peças — elétrica', 'Peças — moto', 'Baterias', 'Pneus e câmaras',
      'Aditivos e fluidos', 'Acessórios', 'Limpeza automotiva'],
    settings: { oficina: { valorHora: 120, garantiaDias: 90 }, agenda: { intervaloMin: 30, antecedenciaLembreteHoras: 24 } },
  },
  geral: {
    id: 'geral', name: 'Varejo geral', short: 'Varejo', icon: 'store', status: 'disponivel',
    description: 'Outros ramos de varejo: núcleo completo de vendas, estoque e financeiro; ative os módulos que precisar.',
    modules: [...CORE], terms: {}, defaultUnit: 'UN', units: ['UN', 'PC', 'CX', 'KG'],
    categories: ['Geral'],
  },
}

export const segmentOf = (id: string | null | undefined): SegmentDef => SEGMENTS[(id as SegmentId) || 'moda'] ?? SEGMENTS.moda

/** Informações enviadas ao front: vocabulário, módulos e unidades do segmento da empresa. */
export function segmentInfo(id: string | null | undefined) {
  const s = segmentOf(id)
  return { id: s.id, name: s.name, short: s.short, icon: s.icon, terms: { ...BASE_TERMS, ...s.terms }, units: s.units, defaultUnit: s.defaultUnit }
}

export function publicSegments() {
  return Object.values(SEGMENTS).map((s) => ({ id: s.id, name: s.name, short: s.short, icon: s.icon, status: s.status, description: s.description,
    modules: s.modules, categories: s.categories, defaultUnit: s.defaultUnit }))
}

function deepMergeMissing(base: any, add: any): any {
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(add || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMergeMissing(out[k], v)
    else if (out[k] === undefined) out[k] = v
  }
  return out
}

/**
 * Aplica o pacote do segmento à empresa: grava o segmento, ACRESCENTA os módulos do pacote, cria as categorias
 * e grades que faltarem e completa parâmetros ainda não definidos. Nada existente é removido ou sobrescrito.
 */
export async function applySegment(c: Q, companyId: string, segmentId: SegmentId, opts: { replaceModules?: boolean } = {}) {
  const s = segmentOf(segmentId)
  const co = await c.one(`SELECT modules, settings FROM companies WHERE id = $1 FOR UPDATE`, [companyId])
  const modules = opts.replaceModules ? [...new Set(s.modules)] : [...new Set([...(co?.modules ?? []), ...s.modules])]
  const settings = deepMergeMissing(co?.settings, s.settings)
  await c.query(`UPDATE companies SET segment = $2, modules = $3, settings = $4, updated_at = now() WHERE id = $1`, [companyId, s.id, modules, JSON.stringify(settings)])
  let categories = 0, sizes = 0
  for (const name of s.categories) {
    const r = await c.query(`INSERT INTO categories(company_id, name) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE company_id = $1 AND lower(name) = lower($2))`, [companyId, name])
    categories += r.rowCount ?? 0
  }
  for (const [grid, codes] of s.sizeGrids ?? []) {
    let i = 0
    for (const code of codes) {
      const r = await c.query(`INSERT INTO sizes(company_id, grid, code, sort) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM sizes WHERE company_id = $1 AND grid = $2 AND code = $3)`, [companyId, grid, code, i++])
      sizes += r.rowCount ?? 0
    }
  }
  // ramos de serviço: garante o perfil "Profissional" (empresas antigas foram criadas antes dele existir)
  const roles = [...(s.modules.includes('agenda') ? [DEFAULT_ROLES.find((r) => r.name === 'Profissional')!] : []), ...(s.modules.includes('saude') ? HEALTH_ROLES : [])]
  for (const role of roles) {
    await c.query(`INSERT INTO roles(company_id, name, description, permissions, max_discount_pct, is_system) SELECT $1,$2,$3,$4,$5,true
                    WHERE NOT EXISTS (SELECT 1 FROM roles WHERE company_id = $1 AND name = $2)`, [companyId, role.name, role.description, role.permissions, role.maxDiscount])
  }
  return { segment: s.id, modules, categoriesAdded: categories, sizesAdded: sizes }
}

/** Modelos de anamnese/ficha por ramo (as respostas ficam no registro clínico do cliente). */
export interface AnamneseField { key: string; label: string; type: 'sim_nao' | 'texto' | 'opcoes'; options?: string[]; alert?: boolean }
const COMMON_HEALTH: AnamneseField[] = [
  { key: 'alergias', label: 'Possui alergia (medicamentos, látex, cosméticos, alimentos)? Quais?', type: 'texto', alert: true },
  { key: 'medicamentos', label: 'Usa algum medicamento contínuo? Quais?', type: 'texto' },
  { key: 'gestante', label: 'Está gestante ou amamentando?', type: 'sim_nao', alert: true },
]
export const ANAMNESE: Record<string, AnamneseField[]> = {
  odontologia: [
    ...COMMON_HEALTH,
    { key: 'hipertensao', label: 'Hipertensão arterial?', type: 'sim_nao', alert: true },
    { key: 'diabetes', label: 'Diabetes?', type: 'sim_nao', alert: true },
    { key: 'cardiopatia', label: 'Problema cardíaco, uso de marca-passo ou prótese valvar?', type: 'sim_nao', alert: true },
    { key: 'anticoagulante', label: 'Usa anticoagulante ou tem problema de coagulação/sangramento?', type: 'sim_nao', alert: true },
    { key: 'anestesia', label: 'Já teve reação à anestesia odontológica?', type: 'sim_nao', alert: true },
    { key: 'bisfosfonato', label: 'Usa ou já usou bisfosfonatos (osteoporose)?', type: 'sim_nao', alert: true },
    { key: 'infecciosas', label: 'Hepatite, HIV ou outra doença infecciosa (informação opcional e sigilosa)?', type: 'texto' },
    { key: 'fumante', label: 'Fumante?', type: 'sim_nao' },
    { key: 'queixa', label: 'Queixa principal', type: 'texto' },
  ],
  estetica: [
    ...COMMON_HEALTH,
    { key: 'fototipo', label: 'Fototipo (Fitzpatrick)', type: 'opcoes', options: ['I', 'II', 'III', 'IV', 'V', 'VI'] },
    { key: 'isotretinoina', label: 'Usou isotretinoína (ex.: Roacutan) nos últimos 6 meses?', type: 'sim_nao', alert: true },
    { key: 'acidos', label: 'Usa ácidos ou retinoides na pele atualmente?', type: 'sim_nao', alert: true },
    { key: 'marcapasso', label: 'Usa marca-passo, prótese metálica ou DIU de cobre?', type: 'sim_nao', alert: true },
    { key: 'queloide', label: 'Tem tendência a queloide ou manchas pós-inflamatórias?', type: 'sim_nao', alert: true },
    { key: 'doencas_pele', label: 'Doenças de pele, herpes recorrente ou lesões na área a tratar?', type: 'texto', alert: true },
    { key: 'procedimentos', label: 'Procedimentos estéticos anteriores (preenchimento, toxina, laser...)', type: 'texto' },
    { key: 'objetivo', label: 'Objetivo / queixa principal', type: 'texto' },
  ],
  saude_geral: [
    { key: 'queixa', label: 'Queixa principal e história da doença atual', type: 'texto' },
    { key: 'alergias', label: 'Alergias (medicamentos, alimentos, látex)? Quais?', type: 'texto', alert: true },
    { key: 'medicamentos', label: 'Medicamentos em uso', type: 'texto' },
    { key: 'doencas', label: 'Doenças crônicas (hipertensão, diabetes, cardiopatia, asma…)', type: 'texto', alert: true },
    { key: 'cirurgias', label: 'Cirurgias e internações anteriores', type: 'texto' },
    { key: 'familiar', label: 'Histórico familiar relevante', type: 'texto' },
    { key: 'gestante', label: 'Está gestante ou amamentando?', type: 'sim_nao', alert: true },
    { key: 'tabagismo', label: 'Tabagismo', type: 'opcoes', options: ['Nunca fumou', 'Ex-fumante', 'Fumante'] },
    { key: 'alcool', label: 'Consumo de álcool', type: 'opcoes', options: ['Não', 'Social', 'Frequente'] },
    { key: 'atividade', label: 'Atividade física', type: 'opcoes', options: ['Sedentário', '1–2x por semana', '3x ou mais por semana'] },
  ],
  psicologia: [
    { key: 'demanda', label: 'Demanda / motivo da procura', type: 'texto' },
    { key: 'historico', label: 'Histórico de acompanhamento psicológico ou psiquiátrico', type: 'texto' },
    { key: 'medicacao', label: 'Usa medicação psiquiátrica? Qual e quem prescreveu?', type: 'texto', alert: true },
    { key: 'risco', label: 'Relato atual de ideação suicida ou autolesão?', type: 'sim_nao', alert: true },
    { key: 'sono', label: 'Sono e alimentação', type: 'texto' },
    { key: 'rede', label: 'Rede de apoio (família, amigos, trabalho)', type: 'texto' },
    { key: 'expectativas', label: 'Expectativas com o acompanhamento', type: 'texto' },
  ],
  fisioterapia: [
    { key: 'queixa', label: 'Queixa principal e região acometida', type: 'texto' },
    { key: 'dor', label: 'Intensidade da dor (EVA 0–10)', type: 'opcoes', options: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] },
    { key: 'inicio', label: 'Início e mecanismo da lesão', type: 'texto' },
    { key: 'exames', label: 'Exames de imagem / laudos trazidos', type: 'texto' },
    { key: 'cirurgia', label: 'Cirurgia ortopédica prévia ou prótese?', type: 'sim_nao', alert: true },
    { key: 'contraindicacoes', label: 'Marca-passo, gestação, trombose, neoplasia ou outra contraindicação?', type: 'texto', alert: true },
    { key: 'objetivo', label: 'Objetivo funcional do paciente', type: 'texto' },
  ],
  nutricao: [
    { key: 'objetivo', label: 'Objetivo (emagrecimento, ganho de massa, saúde, patologia…)', type: 'texto' },
    { key: 'patologias', label: 'Diabetes, hipertensão, dislipidemia, doença renal ou intestinal?', type: 'texto', alert: true },
    { key: 'alergias', label: 'Alergias ou intolerâncias alimentares', type: 'texto', alert: true },
    { key: 'restricoes', label: 'Restrições / preferências (vegetariano, religião…)', type: 'texto' },
    { key: 'rotina', label: 'Rotina alimentar e horários', type: 'texto' },
    { key: 'agua', label: 'Ingestão de água por dia', type: 'opcoes', options: ['Menos de 1 L', '1 a 2 L', 'Mais de 2 L'] },
    { key: 'suplementos', label: 'Usa suplementos? Quais?', type: 'texto' },
  ],
  fonoaudiologia: [
    { key: 'queixa', label: 'Queixa (fala, voz, audição, deglutição, linguagem, motricidade orofacial)', type: 'texto' },
    { key: 'desenvolvimento', label: 'Desenvolvimento (para crianças: marcos de fala e linguagem)', type: 'texto' },
    { key: 'audicao', label: 'Já fez avaliação auditiva? Resultado', type: 'texto' },
    { key: 'disfagia', label: 'Engasgos ou dificuldade para engolir?', type: 'sim_nao', alert: true },
    { key: 'uso_voz', label: 'Uso profissional da voz?', type: 'sim_nao' },
    { key: 'escola', label: 'Escola / trabalho e queixas relacionadas', type: 'texto' },
  ],
  salao: [
    { key: 'alergias', label: 'Alergia a produtos químicos (tintura, amônia, formol, esmaltes)? Quais?', type: 'texto', alert: true },
    { key: 'gestante', label: 'Está gestante ou amamentando?', type: 'sim_nao', alert: true },
    { key: 'couro', label: 'Couro cabeludo sensível, lesões ou queda acentuada?', type: 'sim_nao', alert: true },
    { key: 'tipo_fio', label: 'Tipo de fio', type: 'opcoes', options: ['Liso', 'Ondulado', 'Cacheado', 'Crespo'] },
    { key: 'quimica', label: 'Histórico de química (coloração, progressiva, descoloração) e data da última', type: 'texto' },
    { key: 'teste_mecha', label: 'Teste de mecha/alergia realizado antes da química?', type: 'sim_nao' },
    { key: 'unhas', label: 'Unhas: micose, fragilidade ou alergia a esmaltes/gel?', type: 'texto' },
    { key: 'preferencias', label: 'Preferências (produtos, temperatura, profissional)', type: 'texto' },
  ],
}

/** Modelos de ficha disponíveis para o ramo (salão com estética usa os dois). */
export function anamneseTemplates(segment: string | null | undefined) {
  const ids = segment === 'salao' ? ['salao', 'estetica'] : segment === 'odontologia' ? ['odontologia'] : segment === 'estetica' ? ['estetica']
    : segment === 'saude' ? ['saude_geral', 'psicologia', 'fisioterapia', 'nutricao', 'fonoaudiologia', 'odontologia', 'estetica'] : ['salao', 'estetica', 'odontologia']
  const names: Record<string, string> = { odontologia: 'Anamnese odontológica', estetica: 'Ficha de avaliação estética', salao: 'Ficha do salão (cabelo e unhas)',
    saude_geral: 'Anamnese clínica geral (medicina, enfermagem, terapias)', psicologia: 'Entrevista inicial — psicologia', fisioterapia: 'Avaliação fisioterapêutica', nutricao: 'Anamnese nutricional', fonoaudiologia: 'Anamnese fonoaudiológica' }
  return ids.map((id) => ({ id, name: names[id], fields: ANAMNESE[id] }))
}
