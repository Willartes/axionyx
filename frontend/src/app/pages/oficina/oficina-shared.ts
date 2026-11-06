/** Rótulos e cores da oficina. */
export const WO_STATUS: Record<string, { label: string; cls: string; color: string; icon: string }> = {
  orcamento: { label: 'Orçamento', cls: 'badge-muted', color: '#647687', icon: 'file-text' },
  aguardando_aprovacao: { label: 'Aguardando aprovação', cls: 'badge-warning', color: '#D99000', icon: 'hourglass' },
  aprovada: { label: 'Aprovada', cls: 'badge-info', color: '#0875D1', icon: 'check-circle-2' },
  em_execucao: { label: 'Em execução', cls: 'badge-cyan', color: '#00A6D6', icon: 'wrench' },
  aguardando_peca: { label: 'Aguardando peça', cls: 'badge-warning', color: '#E07B00', icon: 'package' },
  pronta: { label: 'Pronta p/ entrega', cls: 'badge-success', color: '#18864B', icon: 'car' },
  entregue: { label: 'Entregue', cls: 'badge-muted', color: '#4A5B6B', icon: 'check-check' },
  cancelada: { label: 'Cancelada', cls: 'badge-danger', color: '#C93636', icon: 'x-circle' },
};
export const ITEM_KIND: Record<string, string> = { servico: 'Serviço', mao_de_obra: 'Mão de obra', peca: 'Peça', produto: 'Produto' };
export const ITEM_STATUS: Record<string, { label: string; cls: string }> = { pendente: { label: 'Aguardando aprovação', cls: 'badge-warning' }, aprovado: { label: 'Aprovado', cls: 'badge-success' }, recusado: { label: 'Recusado', cls: 'badge-muted' } };
export const VEHICLE_TYPE: Record<string, { label: string; icon: string }> = { carro: { label: 'Carro', icon: 'car' }, moto: { label: 'Moto', icon: 'bike' }, utilitario: { label: 'Utilitário', icon: 'truck' }, caminhao: { label: 'Caminhão', icon: 'truck' }, outro: { label: 'Outro', icon: 'car' } };
export const FUEL_LEVELS = ['reserva', '1/4', '1/2', '3/4', 'cheio'];
export const CHECK_STATE: Record<string, { label: string; color: string }> = { ok: { label: 'OK', color: '#18864B' }, avaria: { label: 'Avaria', color: '#C93636' }, ausente: { label: 'Ausente', color: '#D99000' }, na: { label: 'N/A', color: '#8796A5' } };
export const CHECKLIST_CARRO = ['Para-choque dianteiro', 'Para-choque traseiro', 'Lataria / pintura', 'Para-brisa e vidros', 'Faróis e lanternas', 'Retrovisores', 'Rodas e calotas', 'Pneus', 'Estepe', 'Macaco e chave de roda', 'Triângulo', 'Tapetes', 'Bancos e forração', 'Rádio / multimídia', 'Documento do veículo', 'Objetos de valor'];
export const CHECKLIST_MOTO = ['Carenagem', 'Tanque', 'Banco', 'Retrovisores', 'Farol e lanterna', 'Piscas', 'Pneus', 'Rodas', 'Escapamento', 'Guidão e manetes', 'Kit relação', 'Painel', 'Capacete deixado', 'Documento do veículo'];
export const formatPlate = (p?: string | null) => (p && p.length === 7 ? `${p.slice(0, 3)}-${p.slice(3)}` : p || 'sem placa');
