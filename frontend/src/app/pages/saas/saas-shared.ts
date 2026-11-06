/** Rótulos e cores da carteira de assinaturas do AXIONYX. */
export const CONTRACT_STATUS: Record<string, { label: string; cls: string; color: string }> = {
  em_analise: { label: 'Em análise', cls: 'badge-info', color: '#0875D1' },
  recusado: { label: 'Recusado', cls: 'badge-muted', color: '#8796A5' },
  aguardando_pagamento: { label: 'Aguardando pagamento', cls: 'badge-warning', color: '#D99000' },
  ativo: { label: 'Ativo', cls: 'badge-success', color: '#18864B' },
  inadimplente: { label: 'Inadimplente', cls: 'badge-warning', color: '#E07B00' },
  suspenso: { label: 'Suspenso', cls: 'badge-danger', color: '#C93636' },
  cancelado: { label: 'Cancelado', cls: 'badge-muted', color: '#647687' },
};
export const CHARGE_STATUS: Record<string, { label: string; cls: string }> = {
  pendente: { label: 'Pendente', cls: 'badge-warning' }, paga: { label: 'Paga', cls: 'badge-success' }, cancelada: { label: 'Cancelada', cls: 'badge-muted' },
  estornada: { label: 'Estornada', cls: 'badge-muted' }, contestada: { label: 'Contestada', cls: 'badge-danger' },
};
export const MODE_LABEL: Record<string, string> = { assinatura_cartao: 'Assinatura no cartão (automática)', link_mensal: 'Link mensal (Pix ou cartão)', manual: 'Manual (fora do gateway)' };
export const MODE_SHORT: Record<string, string> = { assinatura_cartao: 'Cartão recorrente', link_mensal: 'Link mensal', manual: 'Manual' };
export const METHOD_LABEL: Record<string, string> = { pix: 'Pix', cartao: 'Cartão', transferencia: 'Transferência', boleto: 'Boleto', dinheiro: 'Dinheiro', outro: 'Outro', account_money: 'Saldo Mercado Pago' };
export const REVIEW_KIND: Record<string, { label: string; icon: string }> = {
  novo_contrato: { label: 'Nova proposta', icon: 'clipboard-list' }, inadimplencia: { label: 'Inadimplência', icon: 'hourglass' }, suspensao: { label: 'Suspensão', icon: 'lock' },
  chargeback: { label: 'Chargeback', icon: 'shield-alert' }, estorno: { label: 'Estorno', icon: 'undo-2' }, troca_titular: { label: 'Troca de titular', icon: 'user-x' },
  pagamento_divergente: { label: 'Pagamento divergente', icon: 'alert-triangle' }, assinatura_cartao: { label: 'Assinatura no cartão', icon: 'credit-card' },
  pagamento_recusado: { label: 'Pagamento recusado', icon: 'x-circle' },
};
export const SEVERITY: Record<string, { label: string; color: string; bg: string }> = {
  alta: { label: 'Alta', color: '#C93636', bg: '#FDECEC' }, media: { label: 'Média', color: '#D99000', bg: '#FFF7E6' }, baixa: { label: 'Baixa', color: '#0875D1', bg: '#F0F7FD' },
};
export const RISK: Record<string, { label: string; color: string; bg: string }> = {
  alto: { label: 'Risco alto', color: '#C93636', bg: '#FDECEC' }, medio: { label: 'Risco médio', color: '#D99000', bg: '#FFF7E6' }, baixo: { label: 'Risco baixo', color: '#18864B', bg: '#E8F5EE' },
};
export const SEGMENT_LABEL: Record<string, string> = { moda: 'Moda', hortifruti: 'Hortifrúti', adega: 'Adega', mercado: 'Mercado', cosmeticos: 'Cosméticos', odontologia: 'Odontologia', estetica: 'Estética', salao: 'Salão de beleza', geral: 'Geral' };
export async function copyText(t: string) { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } }
