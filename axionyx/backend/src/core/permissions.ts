/** Catálogo de permissões verificadas no servidor. Os perfis guardam a lista de códigos concedidos. */
export const PERMISSIONS: { group: string; items: { code: string; label: string }[] }[] = [
  { group: 'Painel', items: [{ code: 'dashboard.ver', label: 'Ver dashboards e indicadores' }] },
  { group: 'Cadastros', items: [
    { code: 'cadastros.ver', label: 'Ver cadastros auxiliares' },
    { code: 'cadastros.editar', label: 'Editar marcas, coleções, categorias, grades, cores, fornecedores' },
  ]},
  { group: 'Clientes', items: [
    { code: 'clientes.ver', label: 'Ver clientes' },
    { code: 'clientes.editar', label: 'Cadastrar/editar clientes' },
    { code: 'clientes.dados_pessoais', label: 'Exportar/anonimizar dados pessoais (LGPD)' },
  ]},
  { group: 'Produtos e Estoque', items: [
    { code: 'produtos.ver', label: 'Ver produtos' },
    { code: 'produtos.editar', label: 'Cadastrar/editar produtos e grades' },
    { code: 'produtos.custo', label: 'Ver custos e margens' },
    { code: 'estoque.ver', label: 'Ver estoque e movimentações' },
    { code: 'estoque.movimentar', label: 'Lançar entradas, saídas e ajustes' },
    { code: 'estoque.transferir', label: 'Transferir entre filiais' },
    { code: 'estoque.inventario', label: 'Executar inventário' },
    { code: 'estoque.lotes', label: 'Lançar lotes e validades' },
    { code: 'estoque.perdas', label: 'Registrar perdas (vencido, avaria, quebra)' },
    { code: 'combos.editar', label: 'Cadastrar combos, kits e embalagens' },
  ]},
  { group: 'Compras', items: [
    { code: 'compras.ver', label: 'Ver compras e entradas' },
    { code: 'compras.editar', label: 'Importar XML e confirmar entradas' },
  ]},
  { group: 'Vendas', items: [
    { code: 'vendas.ver', label: 'Ver vendas' },
    { code: 'vendas.criar', label: 'Registrar vendas (PDV)' },
    { code: 'vendas.cancelar', label: 'Cancelar vendas' },
    { code: 'vendas.devolver', label: 'Registrar trocas e devoluções' },
    { code: 'vendas.desconto_extra', label: 'Autorizar desconto acima do limite' },
    { code: 'vendas.todas', label: 'Ver vendas de todos os vendedores' },
    { code: 'caixa.operar', label: 'Abrir caixa, sangria e suprimento' },
    { code: 'caixa.fechar', label: 'Fechar caixa' },
  ]},
  { group: 'Agenda e Atendimento', items: [
    { code: 'agenda.ver', label: 'Ver a agenda' },
    { code: 'agenda.editar', label: 'Agendar, remarcar, confirmar e concluir atendimentos' },
    { code: 'agenda.todas', label: 'Ver e agendar para todos os profissionais (sem marcar: só a própria agenda)' },
    { code: 'servicos.editar', label: 'Cadastrar serviços e pacotes de sessões' },
    { code: 'profissionais.editar', label: 'Cadastrar profissionais, horários e comissões' },
    { code: 'prontuario.ver', label: 'Ver prontuário, fichas, odontograma e planos de tratamento (dados de saúde)' },
    { code: 'prontuario.editar', label: 'Registrar anamnese, evolução, odontograma e planos de tratamento' },
    { code: 'prontuario.documentos', label: 'Emitir receitas, atestados, declarações, pedidos de exame e encaminhamentos (só no próprio nome, com registro no conselho)' },
    { code: 'convenios.ver', label: 'Ver convênios, carteirinhas e guias' },
    { code: 'convenios.editar', label: 'Cadastrar convênios e tabelas de preço, enviar lotes e registrar pagamentos e glosas' },
  ]},
  { group: 'Oficina', items: [
    { code: 'oficina.ver', label: 'Ver ordens de serviço e veículos' },
    { code: 'oficina.editar', label: 'Abrir OS, cadastrar veículos, lançar serviços/peças e atualizar o andamento' },
    { code: 'oficina.aprovar', label: 'Registrar aprovação do orçamento, alterar preço de item e cancelar OS' },
  ]},
  { group: 'Condicional e Consignação', items: [
    { code: 'condicional.ver', label: 'Ver condicionais/bags' },
    { code: 'condicional.editar', label: 'Criar e baixar condicionais/bags' },
    { code: 'consignacao.ver', label: 'Ver consignações' },
    { code: 'consignacao.editar', label: 'Criar consignações e acertos' },
  ]},
  { group: 'Comissões e Metas', items: [
    { code: 'comissoes.ver', label: 'Ver comissões e metas' },
    { code: 'comissoes.editar', label: 'Configurar regras e metas' },
  ]},
  { group: 'Financeiro', items: [
    { code: 'financeiro.ver', label: 'Ver financeiro' },
    { code: 'financeiro.editar', label: 'Lançar títulos e contas' },
    { code: 'financeiro.baixar', label: 'Baixar/estornar pagamentos' },
    { code: 'financeiro.renegociar', label: 'Renegociar crediário, juros e descontos' },
    { code: 'financeiro.conciliar', label: 'Conciliação bancária' },
  ]},
  { group: 'Fiscal', items: [
    { code: 'fiscal.ver', label: 'Ver documentos fiscais' },
    { code: 'fiscal.emitir', label: 'Emitir/cancelar documentos fiscais' },
  ]},
  { group: 'Fidelidade', items: [
    { code: 'fidelidade.ver', label: 'Ver saldos de cashback' },
    { code: 'fidelidade.editar', label: 'Configurar programa e ajustar saldos' },
  ]},
  { group: 'Integrações e Mensagens', items: [
    { code: 'integracoes.ver', label: 'Ver integrações e logs' },
    { code: 'integracoes.editar', label: 'Configurar integrações e reprocessar' },
    { code: 'mensagens.enviar', label: 'Enviar mensagens (WhatsApp)' },
  ]},
  { group: 'Relatórios', items: [
    { code: 'relatorios.ver', label: 'Ver relatórios' },
    { code: 'relatorios.todas_filiais', label: 'Consolidar todas as filiais' },
  ]},
  { group: 'Precificação', items: [
    { code: 'precificacao.ver', label: 'Ver precificação, custos e indicadores' },
    { code: 'precificacao.editar', label: 'Cadastrar custos fixos/variáveis, parâmetros e simular' },
    { code: 'precificacao.aplicar', label: 'Aplicar preço calculado aos produtos' },
  ]},
  { group: 'Outros módulos', items: [
    { code: 'crm.ver', label: 'Ver CRM' }, { code: 'crm.editar', label: 'Editar oportunidades' },
    { code: 'rh.ver', label: 'Ver RH' }, { code: 'rh.editar', label: 'Editar colaboradores' }, { code: 'rh.salarios', label: 'Ver salários' },
    { code: 'juridico.ver', label: 'Ver jurídico' }, { code: 'juridico.editar', label: 'Editar processos' },
    { code: 'contabilidade.ver', label: 'Ver contabilidade/DRE' }, { code: 'contabilidade.editar', label: 'Editar plano de contas' },
    { code: 'documentos.ver', label: 'Ver documentos' }, { code: 'documentos.editar', label: 'Enviar/excluir documentos' },
  ]},
  { group: 'Administração', items: [
    { code: 'admin.empresas', label: 'Gerenciar empresa e filiais' },
    { code: 'admin.usuarios', label: 'Gerenciar usuários' },
    { code: 'admin.perfis', label: 'Gerenciar perfis e permissões' },
    { code: 'auditoria.ver', label: 'Ver trilha de auditoria' },
    { code: 'config.editar', label: 'Alterar configurações da empresa' },
    { code: 'monitor.ver', label: 'Ver monitoramento do sistema' },
  ]},
]

export const ALL_PERMISSIONS = PERMISSIONS.flatMap((g) => g.items.map((i) => i.code))

export const DEFAULT_ROLES: { name: string; description: string; maxDiscount: number; permissions: string[] }[] = [
  { name: 'Administrador', description: 'Acesso total à empresa', maxDiscount: 100, permissions: ALL_PERMISSIONS },
  { name: 'Gerente de Loja', description: 'Operação completa da loja, sem administração do sistema', maxDiscount: 30,
    permissions: ALL_PERMISSIONS.filter((p) => !p.startsWith('admin.') && p !== 'config.editar' && p !== 'rh.salarios' && p !== 'clientes.dados_pessoais') },
  { name: 'Vendedor', description: 'PDV, clientes, condicional e consulta de estoque', maxDiscount: 10,
    permissions: ['dashboard.ver', 'clientes.ver', 'clientes.editar', 'produtos.ver', 'estoque.ver', 'vendas.ver', 'vendas.criar', 'caixa.operar',
      'condicional.ver', 'condicional.editar', 'comissoes.ver', 'fidelidade.ver', 'crm.ver', 'agenda.ver', 'agenda.editar', 'agenda.todas', 'oficina.ver', 'oficina.editar'] },
  { name: 'Profissional', description: 'Atende na agenda (dentista, esteticista, cabeleireiro, mecânico...): própria agenda, prontuário e venda no PDV', maxDiscount: 10,
    permissions: ['dashboard.ver', 'clientes.ver', 'clientes.editar', 'produtos.ver', 'estoque.ver', 'vendas.ver', 'vendas.criar', 'comissoes.ver', 'fidelidade.ver',
      'agenda.ver', 'agenda.editar', 'prontuario.ver', 'prontuario.editar', 'prontuario.documentos', 'convenios.ver', 'oficina.ver', 'oficina.editar'] },
  { name: 'Financeiro', description: 'Contas a pagar/receber, crediário e conciliação', maxDiscount: 0,
    permissions: ['dashboard.ver', 'clientes.ver', 'financeiro.ver', 'financeiro.editar', 'financeiro.baixar', 'financeiro.renegociar', 'financeiro.conciliar',
      'relatorios.ver', 'fiscal.ver', 'vendas.ver', 'vendas.todas', 'contabilidade.ver', 'comissoes.ver', 'compras.ver', 'documentos.ver', 'precificacao.ver', 'precificacao.editar'] },
  { name: 'Estoquista', description: 'Entradas, transferências, inventário e etiquetas', maxDiscount: 0,
    permissions: ['dashboard.ver', 'produtos.ver', 'produtos.editar', 'cadastros.ver', 'cadastros.editar', 'estoque.ver', 'estoque.movimentar', 'estoque.transferir',
      'estoque.inventario', 'estoque.lotes', 'estoque.perdas', 'compras.ver', 'compras.editar', 'relatorios.ver'] },
]

/** Perfis criados ao aplicar o segmento de saúde: recepção e gestão SEM acesso ao conteúdo clínico (sigilo profissional / LGPD). */
const CLINICAL = ['prontuario.ver', 'prontuario.editar', 'prontuario.documentos']
export const HEALTH_ROLES: { name: string; description: string; maxDiscount: number; permissions: string[] }[] = [
  { name: 'Recepcionista', description: 'Agenda de todos, chegada e chamada de pacientes, cadastro, convênios (consulta) e caixa — sem acesso ao prontuário', maxDiscount: 5,
    permissions: ['dashboard.ver', 'clientes.ver', 'clientes.editar', 'produtos.ver', 'estoque.ver', 'vendas.ver', 'vendas.criar', 'caixa.operar', 'fidelidade.ver',
      'agenda.ver', 'agenda.editar', 'agenda.todas', 'convenios.ver', 'mensagens.enviar', 'crm.ver'] },
  { name: 'Gerente da clínica', description: 'Gestão administrativa e financeira da clínica (agenda, convênios, financeiro, relatórios) — sem acesso ao prontuário', maxDiscount: 30,
    permissions: ALL_PERMISSIONS.filter((p) => !p.startsWith('admin.') && p !== 'config.editar' && p !== 'rh.salarios' && p !== 'clientes.dados_pessoais' && !CLINICAL.includes(p)) },
]
