import { Pipe, PipeTransform } from '@angular/core';

const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const numFmt = new Intl.NumberFormat('pt-BR');

export const brl = (v: any) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? '—' : brlFmt.format(Number(v)));
export const num = (v: any, d = 0) => (v === null || v === undefined || isNaN(Number(v)) ? '—' : new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v)));
export const pct = (v: any, d = 1) => (v === null || v === undefined || isNaN(Number(v)) ? '—' : `${num(v, d)}%`);
/** Datas 'YYYY-MM-DD' (sem fuso) ou ISO com hora. */
export function dateBr(v: any): string {
  if (!v) return '—';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; }
  const dt = new Date(s); return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('pt-BR');
}
export function dateTimeBr(v: any): string {
  if (!v) return '—';
  const dt = new Date(v); return isNaN(dt.getTime()) ? '—' : `${dt.toLocaleDateString('pt-BR')} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}
export function doc(v: any): string {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return v || '—';
}
export function phone(v: any): string {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return v || '—';
}
export const todayIso = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
export const addDaysIso = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const monthIso = () => todayIso().slice(0, 7);
export const initials = (name: string) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

@Pipe({ name: 'brl' }) export class BrlPipe implements PipeTransform { transform(v: any) { return brl(v); } }
@Pipe({ name: 'num' }) export class NumPipe implements PipeTransform { transform(v: any, d = 0) { return num(v, d); } }
@Pipe({ name: 'pct' }) export class PctPipe implements PipeTransform { transform(v: any, d = 1) { return pct(v, d); } }
@Pipe({ name: 'dt' }) export class DatePipe implements PipeTransform { transform(v: any) { return dateBr(v); } }
@Pipe({ name: 'dtt' }) export class DateTimePipe implements PipeTransform { transform(v: any) { return dateTimeBr(v); } }
@Pipe({ name: 'doc' }) export class DocPipe implements PipeTransform { transform(v: any) { return doc(v); } }
@Pipe({ name: 'phone' }) export class PhonePipe implements PipeTransform { transform(v: any) { return phone(v); } }

export const FMT = [BrlPipe, NumPipe, PctPipe, DatePipe, DateTimePipe, DocPipe, PhonePipe];

/** Rótulos e classes de status reutilizados nas telas (badge-*) */
export const STATUS: Record<string, [string, string]> = {
  concluida: ['Concluída', 'badge-success'], cancelada: ['Cancelada', 'badge-danger'], devolvida_parcial: ['Devolução parcial', 'badge-warning'], devolvida: ['Devolvida', 'badge-muted'],
  orcamento: ['Em aberto', 'badge-info'], orcamento_convertido: ['Convertido', 'badge-success'], orcamento_expirado: ['Expirado', 'badge-muted'],
  aberto: ['Em aberto', 'badge-warning'], parcial: ['Parcial', 'badge-info'], pago: ['Pago', 'badge-success'], cancelado: ['Cancelado', 'badge-danger'], renegociado: ['Renegociado', 'badge-muted'],
  vencido: ['Vencido', 'badge-danger'], finalizado: ['Finalizado', 'badge-success'], encerrado: ['Encerrado', 'badge-success'],
  rascunho: ['Rascunho', 'badge-muted'], confirmada: ['Confirmada', 'badge-success'], enviada: ['Enviada', 'badge-info'], recebida: ['Recebida', 'badge-success'], fechado: ['Fechado', 'badge-muted'],
  invalido: ['Pendências', 'badge-danger'], pendente_configuracao: ['Pendente de configuração', 'badge-warning'], fila: ['Na fila', 'badge-info'], processando: ['Processando', 'badge-info'],
  autorizado: ['Autorizada', 'badge-success'], rejeitado: ['Rejeitada', 'badge-danger'], denegado: ['Denegada', 'badge-danger'], contingencia: ['Contingência', 'badge-warning'], erro: ['Erro', 'badge-danger'],
  ativo: ['Ativo', 'badge-success'], desativado: ['Desativado', 'badge-muted'], enviado: ['Enviado', 'badge-info'], entregue: ['Entregue', 'badge-success'], lido: ['Lido', 'badge-success'], bloqueado_sem_consentimento: ['Sem consentimento', 'badge-muted'],
  pendente: ['Pendente', 'badge-warning'], aguardando_configuracao: ['Aguardando configuração', 'badge-warning'], descartado: ['Descartado', 'badge-muted'],
  aprovado: ['Aprovado', 'badge-info'], recebido: ['Recebido', 'badge-success'], prevista: ['Prevista', 'badge-info'], liberada: ['Liberada', 'badge-warning'], paga: ['Paga', 'badge-success'],
}
@Pipe({ name: 'statusLabel' }) export class StatusLabelPipe implements PipeTransform { transform(v: string) { return STATUS[v]?.[0] ?? v; } }
@Pipe({ name: 'statusClass' }) export class StatusClassPipe implements PipeTransform { transform(v: string) { return STATUS[v]?.[1] ?? 'badge-muted'; } }
export const STATUS_PIPES = [StatusLabelPipe, StatusClassPipe];

export const PAYMENT_LABEL: Record<string, string> = { dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Débito', credito: 'Crédito', crediario: 'Crediário', vale_troca: 'Vale-troca', cashback: 'Cashback', boleto: 'Boleto', outro: 'Outro',
  cartao_credito: 'Cartão crédito', cartao_debito: 'Cartão débito', a_prazo: 'A prazo' };
export const MOVEMENT_LABEL: Record<string, string> = { entrada: 'Entrada', saida: 'Saída', ajuste: 'Ajuste', transferencia_saida: 'Transf. saída', transferencia_entrada: 'Transf. entrada', venda: 'Venda',
  cancelamento_venda: 'Cancel. venda', devolucao: 'Devolução', condicional_saida: 'Condicional (saída)', condicional_retorno: 'Condicional (retorno)', consignacao_saida: 'Consignação (saída)',
  consignacao_retorno: 'Consignação (retorno)', inventario: 'Inventário', compra: 'Compra', estorno_compra: 'Estorno compra' };
