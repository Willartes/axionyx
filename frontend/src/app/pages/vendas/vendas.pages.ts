import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, PagerComponent, StateComponent, ModalComponent, ModuleTabsComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, STATUS_PIPES, PAYMENT_LABEL, monthIso, todayIso, addDaysIso } from '../../core/format';

export const VENDAS_TABS = [
  { path: '/pedidos', label: 'Vendas' }, { path: '/orcamentos', label: 'Orçamentos' }, { path: '/trocas', label: 'Trocas e Devoluções' },
  { path: '/caixa', label: 'Caixa' }, { path: '/comissoes', label: 'Metas e Comissões' },
];
const CHANNEL: Record<string, string> = { loja: 'Loja', ecommerce: 'E-commerce', condicional: 'Condicional', bag_delivery: 'Bag Delivery', consignacao: 'Consignação', whatsapp: 'WhatsApp' };

// ─── Pedidos / Vendas ───────────────────────────────────────────────────────
@Component({
  selector: 'ax-pedidos',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModuleTabsComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:16px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1">
        <h1 style="font-size:16px;font-weight:700;color:#172B3A">Pedidos de Venda</h1>
        <p style="font-size:12px;color:#647687">{{ list.extra()?.totals?.n ?? 0 | num }} venda(s) no filtro · {{ list.extra()?.totals?.total | brl }}</p>
      </div>
      <div style="position:relative"><ax-icon name="search" [size]="14" color="#A0AFBF" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" />
        <input class="input-field" style="padding-left:32px;font-size:13px;width:220px" placeholder="Nº da venda, cliente ou CPF" [(ngModel)]="q" (ngModelChange)="search()" /></div>
      <input type="date" class="input-field" style="width:140px" [(ngModel)]="from" (change)="apply()" title="De" />
      <input type="date" class="input-field" style="width:140px" [(ngModel)]="to" (change)="apply()" title="Até" />
      @if (auth.can('vendas.todas')) { <select class="input-field" style="width:160px" [(ngModel)]="seller" (change)="apply()"><option value="">Todos os vendedores</option>@for (s of lk.data()?.sellers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select> }
      @if (auth.can('vendas.criar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/pdv')"><ax-icon name="plus" [size]="13" /> Nova venda</button> }
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="background:white;border-bottom:1px solid #DCE4EC;padding:0 24px;display:flex;gap:0">
      @for (t of statusTabs; track t.v) { <div class="tab-item" [class.active]="status() === t.v" (click)="status.set(t.v); apply()">{{ t.l }}</div> }
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Venda</th><th>Cliente</th><th>Emissão</th><th>Canal</th><th class="num">Peças</th><th class="num">Desconto</th><th class="num">Valor Total</th><th>Pagamento</th><th>Vendedor</th><th>Fiscal</th><th>Status</th><th style="width:50px"></th></tr></thead>
        <tbody>
          @for (p of list.items(); track p.id) {
            <tr class="clickable" (click)="router.navigateByUrl('/pedido-detail/' + p.id)">
              <td class="mono" style="font-size:12px;color:#0875D1;font-weight:500">V{{ p.number }}</td>
              <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ p.customer || 'Consumidor final' }}</td>
              <td class="mono" style="font-size:12px">{{ p.created_at | dtt }}</td>
              <td style="font-size:12px">{{ channel(p.channel) }}</td>
              <td class="num" style="font-size:12px">{{ p.items_count }}</td>
              <td class="num" style="font-size:12px;color:#D99000">{{ p.discount_total > 0 ? (p.discount_total | brl) : '—' }}</td>
              <td class="num" style="font-size:12px;font-weight:600">{{ p.total | brl }}</td>
              <td style="font-size:11px;color:#647687">{{ kinds(p.payment_kinds) }}</td>
              <td style="font-size:12px">{{ p.seller }}</td>
              <td>@if (p.fiscal_status) { <span class="badge" [class]="'badge ' + (p.fiscal_status | statusClass)">{{ p.fiscal_status | statusLabel }}</span> } @else { <span class="muted" style="font-size:11px">—</span> }</td>
              <td><span class="badge" [class]="'badge ' + (p.status | statusClass)">{{ p.status | statusLabel }}</span></td>
              <td><ax-icon name="eye" [size]="13" color="#647687" /></td>
            </tr>
          }
        </tbody>
      </table>
      <ax-state [loading]="list.loading() && !list.items().length" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhuma venda no período." (retry)="list.reload()" />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>`,
})
export class PedidosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); readonly lk = inject(LookupsService); private route = inject(ActivatedRoute);
  readonly tabs = VENDAS_TABS;
  readonly list = new ListState<any>((q) => this.api.get('/sales', q));
  readonly status = signal('');
  readonly statusTabs = [{ v: '', l: 'Todas' }, { v: 'concluida', l: 'Concluídas' }, { v: 'devolvida_parcial', l: 'Com devolução' }, { v: 'devolvida', l: 'Devolvidas' }, { v: 'cancelada', l: 'Canceladas' }];
  q = ''; from = addDaysIso(todayIso(), -30); to = todayIso(); seller = ''; customer = ''; private t: any;
  ngOnInit() { this.lk.ensure(); this.customer = this.route.snapshot.queryParamMap.get('cliente') || ''; if (this.customer) this.from = ''; this.apply(); }
  search() { clearTimeout(this.t); this.t = setTimeout(() => this.apply(), 300); }
  apply() { this.list.query = { q: this.q, from: this.from, to: this.to, seller: this.seller, status: this.status(), customer: this.customer, branch: this.auth.me()?.user?.allBranches ? 'all' : undefined }; this.list.load(1); }
  channel(c: string) { return CHANNEL[c] || c; }
  kinds(k: string) { return (k || '').split(',').filter(Boolean).map((x) => PAYMENT_LABEL[x] || x).join(' + ') || '—'; }
}

// ─── Detalhe da venda ───────────────────────────────────────────────────────
@Component({
  selector: 'ax-pedido-detail',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
  @if (s(); as s) {
  <div style="display:flex;height:100%">
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:12px 24px;background:white;border-bottom:1px solid #DCE4EC">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
          <div>
            <div style="display:flex;align-items:center;gap:10px"><h1 style="font-size:18px;font-weight:700;color:#172B3A">{{ s.type === 'orcamento' ? 'Orçamento' : 'Venda' }} nº {{ s.number }}</h1>
              <span class="badge" [class]="'badge ' + (s.status | statusClass)">{{ s.status | statusLabel }}</span><span class="badge badge-muted">{{ channel(s.channel) }}</span></div>
            <p style="font-size:12px;color:#647687">Criada em {{ s.created_at | dtt }} por {{ s.created_by_name }} · {{ s.branch }}@if (s.fiscal.length) { · {{ fiscalTxt() }} }</p>
          </div>
          <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
            @if (s.type === 'venda' && ['concluida','devolvida_parcial'].includes(s.status) && auth.can('vendas.devolver')) { <button class="btn-ghost" style="font-size:12px" (click)="router.navigate(['/trocas'], { queryParams: { venda: s.id } })"><ax-icon name="repeat" [size]="13" /> Troca / devolução</button> }
            @if (hasCrediario()) { <button class="btn-ghost" style="font-size:12px" (click)="router.navigate(['/carne'], { queryParams: { venda: s.id } })"><ax-icon name="notebook-pen" [size]="13" /> Carnê</button> }
            @if (s.type === 'orcamento' && s.status === 'orcamento' && auth.can('vendas.criar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigate(['/orcamentos'], { queryParams: { converter: s.id } })">Converter em venda</button> }
            @if (s.status === 'concluida' || s.status === 'orcamento') { @if (auth.can('vendas.cancelar')) { <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="cancelOpen.set(true)">Cancelar</button> } }
          </div>
        </div>
        @if (s.type === 'venda') {
          <div style="display:flex;align-items:center;gap:0;margin-bottom:12px">
            @for (st of timeline(); track st.label; let last = $last) {
              <div style="display:flex;align-items:center;flex:1">
                <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
                  <div [style.background]="st.done ? (st.danger ? '#C93636' : '#18864B') : '#DCE4EC'" style="width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center">@if (st.done) { <ax-icon [name]="st.danger ? 'x' : 'check'" [size]="13" color="white" /> }</div>
                  <div [style.color]="st.done ? (st.danger ? '#C93636' : '#18864B') : '#A0AFBF'" style="font-size:10px;font-weight:600;white-space:nowrap">{{ st.label }}</div>
                  <div style="font-size:9px;color:#A0AFBF">{{ st.date }}</div>
                </div>
                @if (!last) { <div [style.background]="st.done ? '#18864B' : '#DCE4EC'" style="flex:1;height:2px;margin:0 4px;margin-bottom:22px"></div> }
              </div>
            }
          </div>
        }
        <div style="display:flex;gap:0;border-bottom:1px solid #DCE4EC;margin-bottom:-1px">
          @for (t of tabsList; track t; let i = $index) { <div class="tab-item" [class.active]="tab() === i" (click)="tab.set(i)">{{ t }}</div> }
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px">
        @if (tab() === 0) {
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="card" style="padding:18px"><div style="font-size:12px;font-weight:600;color:#172B3A;margin-bottom:12px">Dados da Venda</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                @for (r of [['Cliente', s.customer || 'Consumidor final'], ['CPF/CNPJ', s.customer_doc ? (s.customer_doc | doc) : '—'], ['Vendedor', s.seller], ['Emissão', (s.created_at | dtt)], ['Canal', channel(s.channel)], ['Origem', s.origin_type ? s.origin_type : 'PDV']]; track r[0]) {
                  <div><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">{{ r[0] }}</div><div style="font-size:13px;color:#172B3A">{{ r[1] }}</div></div>
                }
              </div>
              @if (s.notes) { <div style="margin-top:12px;font-size:12px;color:#647687">Obs.: {{ s.notes }}</div> }
              @if (s.discount_authorized_by_name) { <div class="state-warning" style="margin-top:12px"><ax-icon name="shield-check" [size]="14" />Desconto autorizado por {{ s.discount_authorized_by_name }}.</div> }
              @if (s.status === 'cancelada') { <div class="state-error" style="margin-bottom:0"><ax-icon name="ban" [size]="14" />Cancelada em {{ s.cancelled_at | dtt }} por {{ s.cancelled_by_name }}: {{ s.cancel_reason }}</div> }
            </div>
            <div class="card" style="padding:18px"><div style="font-size:12px;font-weight:600;color:#172B3A;margin-bottom:12px">Pagamentos</div>
              @for (p of s.payments; track p.id) {
                <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px solid #F0F4F8"><span>{{ p.method || label(p.kind) }}@if (p.installments > 1) { <span class="muted"> · {{ p.installments }}x</span> }@if (p.details?.code) { <span class="muted mono"> · {{ p.details.code }}</span> }</span><span class="mono">{{ p.amount | brl }}</span></div>
                @if (p.change_amount > 0) { <div style="display:flex;justify-content:space-between;font-size:12px;color:#647687;padding:2px 0"><span>Troco</span><span class="mono">{{ p.change_amount | brl }}</span></div> }
              } @empty { <div class="muted" style="font-size:12px">{{ s.type === 'orcamento' ? 'Orçamento sem pagamento.' : 'Venda a prazo (título a receber).' }}</div> }
            </div>
          </div>
        }
        @if (tab() === 1) {
          <div class="card" style="overflow:hidden">
            <table class="data-table" style="width:100%;border-collapse:collapse">
              <thead><tr><th>SKU</th><th>Descrição</th><th>Cor</th><th>Tam.</th><th class="num">Qtd.</th><th class="num">Devolvido</th><th class="num">Preço Unit.</th><th class="num">Desc.</th><th class="num">Total</th></tr></thead>
              <tbody>@for (it of s.items; track it.id) {
                <tr><td class="mono" style="font-size:12px;color:#0875D1">{{ it.sku }}</td><td>{{ it.name }}</td><td style="font-size:12px">{{ it.color || '—' }}</td><td><span class="badge badge-muted">{{ it.size || '—' }}</span></td>
                  <td class="num">{{ it.qty }}</td><td class="num" [style.color]="it.returned_qty ? '#D99000' : '#A0AFBF'">{{ it.returned_qty }}</td><td class="num">{{ it.unit_price | brl }}</td><td class="num" style="color:#D99000">{{ it.discount | brl }}</td><td class="num" style="font-weight:600">{{ it.total | brl }}</td></tr>
              }</tbody>
            </table>
          </div>
        }
        @if (tab() === 2) {
          <div class="card" style="overflow:hidden">
            <table class="data-table" style="width:100%;border-collapse:collapse">
              <thead><tr><th>Documento</th><th>Tipo</th><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th class="num">Pago</th><th class="num">Saldo</th><th>Situação</th></tr></thead>
              <tbody>@for (r of s.receivables; track r.id) {
                <tr><td class="mono" style="font-size:12px">{{ r.document }}</td><td style="font-size:12px">{{ label(r.method_kind) }}</td><td>{{ r.installment_no }}/{{ r.installments_total }}</td><td class="mono" style="font-size:12px">{{ r.due_date | dt }}</td>
                  <td class="num">{{ r.amount | brl }}</td><td class="num">{{ r.paid_amount | brl }}</td><td class="num">{{ r.balance | brl }}</td><td><span class="badge" [class]="'badge ' + (r.status | statusClass)">{{ r.status | statusLabel }}</span></td></tr>
              } @empty { <tr><td colspan="8" class="empty-state">Sem títulos a receber (pagamento liquidado na hora: dinheiro/PIX/vale-troca/cashback).</td></tr> }</tbody>
            </table>
          </div>
          @if (s.commissions.length) {
            <div class="card" style="padding:14px;margin-top:14px"><div style="font-size:12px;font-weight:600;margin-bottom:8px">Comissões</div>
              @for (c of s.commissions; track c.id) { <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span>{{ c.seller }} · {{ c.ref_type }}</span><span class="mono" [style.color]="c.amount < 0 ? '#C93636' : '#172B3A'">{{ c.amount | brl }} (base {{ c.base_amount | brl }})</span></div> }
            </div>
          }
        }
        @if (tab() === 3) {
          @for (f of s.fiscal; track f.id) {
            <div class="card clickable" style="padding:14px;margin-bottom:10px;cursor:pointer" (click)="router.navigateByUrl('/nfe-detail/' + f.id)">
              <div style="display:flex;gap:10px;align-items:center"><ax-icon name="receipt-text" [size]="18" color="#0875D1" /><b>{{ f.model === '65' ? 'NFC-e' : 'NF-e' }} {{ f.number ? 'nº ' + f.number : '(sem número)' }}</b>
                <span class="badge" [class]="'badge ' + (f.status | statusClass)">{{ f.status | statusLabel }}</span>@if (f.is_test) { <span class="test-stamp">Sem valor fiscal</span> }<span class="muted" style="margin-left:auto;font-size:12px">{{ f.created_at | dtt }}</span></div>
            </div>
          } @empty { <div class="empty-state">Nenhum documento fiscal para esta venda.</div> }
          @if (auth.can('fiscal.emitir') && s.type === 'venda' && s.status !== 'cancelada') {
            <div style="display:flex;gap:8px;margin-top:10px"><button class="btn-secondary" style="font-size:12px" (click)="emit('65')">Gerar NFC-e</button><button class="btn-secondary" style="font-size:12px" (click)="emit('55')">Gerar NF-e</button></div>
          }
        }
        @if (tab() === 4) {
          @for (r of s.returns; track r.id) {
            <div class="card" style="padding:14px;margin-bottom:10px">
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>{{ r.type === 'troca' ? 'Troca' : 'Devolução' }} nº {{ r.number }}</b><span class="muted" style="font-size:12px">{{ r.created_at | dtt }} · {{ r.created_by_name }}</span>
                <span class="mono" style="margin-left:auto;font-weight:600">{{ r.total | brl }}</span></div>
              <div style="font-size:12px;color:#647687;margin-top:4px">Reembolso: {{ r.refund_mode }} @if (r.store_credit_code) { · vale-troca <b class="mono">{{ r.store_credit_code }}</b> } @if (r.reason) { · {{ r.reason }} }</div>
            </div>
          } @empty { <div class="empty-state">Nenhuma troca ou devolução.</div> }
        }
        @if (tab() === 5) {
          <div class="card" style="padding:16px">
            @for (e of s.timeline; track $index) { <div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #F7FAFD;font-size:12px"><span class="mono muted" style="width:130px">{{ e.created_at | dtt }}</span><b style="width:160px">{{ e.action }}</b><span>{{ e.user_name }}</span></div> }
            @for (l of s.loyalty; track $index) { <div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #F7FAFD;font-size:12px"><span class="mono muted" style="width:130px">{{ l.created_at | dtt }}</span><b style="width:160px">cashback.{{ l.kind }}</b><span class="mono">{{ l.amount | brl }}</span></div> }
          </div>
        }
      </div>
    </div>
    <div style="width:240px;border-left:1px solid #DCE4EC;background:white;padding:16px;flex-shrink:0;overflow-y:auto">
      <div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:14px">Resumo da Venda</div>
      @for (r of summary(); track r[0]) {
        <div [style.border-bottom]="r[2] ? '1px solid #F0F4F8' : 'none'" style="display:flex;justify-content:space-between;margin-bottom:8px;padding-bottom:8px">
          <span style="font-size:12px;color:#647687">{{ r[0] }}</span><span [style.font-weight]="r[0] === 'Total' ? 700 : 500" style="font-size:12px;color:#172B3A">{{ r[1] }}</span>
        </div>
      }
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:12px">
        @if (s.fiscal.length) { <button class="btn-primary" style="justify-content:center;font-size:12px" (click)="router.navigateByUrl('/nfe-detail/' + s.fiscal[0].id)"><ax-icon name="file-text" [size]="13" /> Ver documento fiscal</button> }
        @if (s.receivables.length && auth.can('financeiro.ver')) { <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="router.navigate(['/contas-receber'], { queryParams: { venda: s.id } })"><ax-icon name="dollar-sign" [size]="13" /> Ver títulos</button> }
        @if (s.customer_id) { <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="router.navigateByUrl('/cliente-detail/' + s.customer_id)"><ax-icon name="user" [size]="13" /> Ficha do cliente</button> }
      </div>
    </div>
  </div>
  <ax-modal [(open)]="cancelOpen" title="Cancelar venda" icon="ban">
    <p style="font-size:13px;margin-bottom:10px">O cancelamento devolve as peças ao estoque, cancela títulos em aberto, estorna recebimentos em dinheiro/PIX, devolve vale-troca e cashback utilizados e estorna a comissão. Vendas com documento fiscal autorizado exigem o cancelamento do documento antes.</p>
    <label class="field-label">Motivo *</label><textarea class="input-field" rows="3" [(ngModel)]="reason"></textarea>
    <div footer><button class="btn-secondary" (click)="cancelOpen.set(false)">Voltar</button><button class="btn-danger" [disabled]="reason.trim().length < 5 || busy()" (click)="cancel()">Confirmar cancelamento</button></div>
  </ax-modal>
  }`,
})
export class PedidoDetailPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly id = input.required<string>();
  readonly tabsList = ['Dados Gerais', 'Itens', 'Financeiro', 'Fiscal', 'Trocas e Devoluções', 'Histórico'];
  readonly s = signal<any>(null); readonly loading = signal(false); readonly error = signal<string | null>(null); readonly tab = signal(0);
  readonly cancelOpen = signal(false); readonly busy = signal(false); reason = '';
  ngOnInit() { this.load(); }
  async load() { this.loading.set(true); this.error.set(null); try { this.s.set(await this.api.get('/sales/' + this.id())); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); } }
  channel(c: string) { return CHANNEL[c] || c; }
  label(k: string) { return PAYMENT_LABEL[k] || k; }
  hasCrediario() { return (this.s()?.receivables ?? []).some((r: any) => r.method_kind === 'crediario'); }
  fiscalTxt() { const f = this.s().fiscal[0]; return `${f.model === '65' ? 'NFC-e' : 'NF-e'} ${f.number ?? ''} (${f.status.replace(/_/g, ' ')})`; }
  readonly timeline = computed(() => {
    const s = this.s(); if (!s) return [];
    const d = (v: any) => (v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
    const paid = s.receivables.length === 0 || s.receivables.every((r: any) => ['pago', 'cancelado'].includes(r.status));
    const f = s.fiscal.find((x: any) => x.status === 'autorizado');
    return [
      { label: 'Criada', date: d(s.created_at), done: true },
      { label: 'Paga', date: paid ? d(s.created_at) : 'em aberto', done: paid && s.status !== 'cancelada' },
      { label: 'Documento fiscal', date: f ? 'autorizado' : s.fiscal.length ? s.fiscal[0].status.replace(/_/g, ' ') : '—', done: !!f },
      s.status === 'cancelada' ? { label: 'Cancelada', date: d(s.cancelled_at), done: true, danger: true } : { label: s.returns.length ? 'Com devolução' : 'Concluída', date: s.returns.length ? d(s.returns[s.returns.length - 1].created_at) : '', done: true },
    ];
  });
  readonly summary = computed(() => {
    const s = this.s(); if (!s) return [];
    const brl = (v: number) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const rows: [string, string, boolean?][] = [['Cliente', s.customer || 'Consumidor'], ['Vendedor', s.seller], ['Peças', String(s.items_count)], ['Valor bruto', brl(s.subtotal)],
      ['Desconto', `-${brl(s.discount_total)} (${s.subtotal > 0 ? ((s.discount_total / s.subtotal) * 100).toFixed(1).replace('.', ',') : 0}%)`, true], ['Total', brl(s.total), true]];
    if (s.cost_total !== undefined) rows.push(['Margem bruta', s.total > 0 ? (((s.total - s.cost_total) / s.total) * 100).toFixed(1).replace('.', ',') + '%' : '—']);
    const ret = s.returns.reduce((a: number, r: any) => a + Number(r.total), 0);
    if (ret) rows.push(['Devolvido', brl(ret)]);
    return rows;
  });
  async cancel() {
    this.busy.set(true);
    try { await this.api.post(`/sales/${this.id()}/cancel`, { reason: this.reason }, { idempotent: true }); this.toast.success('Venda cancelada.'); this.cancelOpen.set(false); this.load(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async emit(model: '55' | '65') {
    try { const d: any = await this.api.post('/fiscal/documents/from-sale', { saleId: this.id(), model }); this.toast.success('Documento fiscal criado.'); this.router.navigateByUrl('/nfe-detail/' + d.id); }
    catch (e) { this.toast.error(e); }
  }
}

// ─── Orçamentos ─────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-orcamentos',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModalComponent, ModuleTabsComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header">
      <div style="flex:1"><h1>Orçamentos</h1><p>{{ list.total() | num }} orçamento(s) · criados no PDV com "Salvar como orçamento"</p></div>
      @if (auth.can('vendas.criar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/pdv')"><ax-icon name="plus" [size]="13" /> Novo orçamento</button> }
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto;padding:20px">
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Orçamento</th><th>Cliente</th><th>Emissão</th><th>Validade</th><th class="num">Peças</th><th class="num">Valor</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>@for (o of list.items(); track o.id) {
            <tr>
              <td class="mono" style="font-size:12px;color:#0875D1">ORC-{{ o.number }}</td><td>{{ o.customer || 'Consumidor' }}</td><td class="mono" style="font-size:12px">{{ o.created_at | dt }}</td><td class="mono" style="font-size:12px">{{ o.valid_until | dt }}</td>
              <td class="num">{{ o.items_count }}</td><td class="num" style="font-weight:600">{{ o.total | brl }}</td><td><span class="badge" [class]="'badge ' + (o.status | statusClass)">{{ o.status | statusLabel }}</span></td>
              <td><div style="display:flex;gap:4px">
                <button class="btn-ghost" style="padding:3px 6px" (click)="router.navigateByUrl('/pedido-detail/' + o.id)" title="Ver"><ax-icon name="eye" [size]="13" /></button>
                @if (o.status === 'orcamento' && auth.can('vendas.criar')) { <button class="btn-ghost" style="padding:3px 8px;font-size:12px;color:#0875D1" (click)="startConvert(o)">Converter</button> }
              </div></td>
            </tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum orçamento." />
      </div>
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="convOpen" title="Converter orçamento em venda" icon="shopping-cart" [width]="460">
    @if (conv(); as o) {
      <p style="font-size:13px;margin-bottom:12px">Orçamento ORC-{{ o.number }} · <b>{{ o.total | brl }}</b>. Os preços atuais dos produtos serão aplicados.</p>
      <label class="field-label">Forma de pagamento</label>
      <select class="input-field" [(ngModel)]="method" style="margin-bottom:8px">@for (m of methods(); track m.id) { <option [value]="m.id">{{ m.name }}</option> }</select>
      <label class="field-label">Parcelas</label><input type="number" min="1" max="12" class="input-field" [(ngModel)]="inst" />
      <p style="font-size:11px;color:#647687;margin-top:8px">Para pagamento dividido em várias formas, abra o PDV.</p>
    }
    <div footer><button class="btn-secondary" (click)="convOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy()" (click)="convert()">Converter</button></div>
  </ax-modal>`,
})
export class OrcamentosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService); private route = inject(ActivatedRoute);
  readonly tabs = VENDAS_TABS;
  readonly list = new ListState<any>((q) => this.api.get('/sales', { ...q, type: 'orcamento' }));
  readonly convOpen = signal(false); readonly conv = signal<any>(null); readonly busy = signal(false);
  readonly methods = computed(() => (this.lk.data()?.paymentMethods ?? []).filter((m) => !['vale_troca', 'cashback', 'crediario'].includes(m.kind)));
  method = ''; inst = 1;
  async ngOnInit() {
    await this.lk.ensure(); this.list.load();
    const c = this.route.snapshot.queryParamMap.get('converter');
    if (c) { try { const s = await this.api.get('/sales/' + c); this.startConvert(s); } catch { /* */ } }
  }
  startConvert(o: any) { this.conv.set(o); this.method = this.methods()[0]?.id ?? ''; this.inst = 1; this.convOpen.set(true); }
  async convert() {
    this.busy.set(true);
    try { const s: any = await this.api.post(`/sales/${this.conv().id}/convert`, { payments: [{ methodId: this.method, amount: Number(this.conv().total), installments: this.inst > 1 ? this.inst : undefined }] }, { idempotent: true });
      this.toast.success(`Venda nº ${s.number} criada.`); this.convOpen.set(false); this.router.navigateByUrl('/pedido-detail/' + s.id); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}

// ─── Trocas e devoluções ────────────────────────────────────────────────────
@Component({
  selector: 'ax-trocas',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModuleTabsComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Trocas e Devoluções</h1><p>Localize a venda, selecione as peças e escolha como reembolsar. Estoque, financeiro, comissão e cashback são ajustados automaticamente.</p></div></div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto;padding:20px;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;align-items:start">
      <div class="card" style="padding:18px">
        <div class="section-title">Nova troca / devolução</div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input class="input-field mono" placeholder="Número da venda" [(ngModel)]="saleNumber" (keydown.enter)="findSale()" style="width:180px" />
          <button class="btn-secondary" style="font-size:12px" (click)="findSale()"><ax-icon name="search" [size]="13" /> Localizar</button>
        </div>
        @if (sale(); as s) {
          <div style="font-size:13px;margin-bottom:10px"><b>Venda nº {{ s.number }}</b> · {{ s.created_at | dt }} · {{ s.customer || 'Consumidor final' }} · <span class="badge" [class]="'badge ' + (s.status | statusClass)">{{ s.status | statusLabel }}</span></div>
          <table class="data-table" style="width:100%;border-collapse:collapse;border:1px solid #F0F4F8">
            <thead><tr><th>Peça</th><th class="num">Vendida</th><th class="num">Já devolvida</th><th class="num">Valor unit. líquido</th><th class="num">Devolver</th><th>Retorna ao estoque</th></tr></thead>
            <tbody>@for (it of lines(); track it.id) {
              <tr><td>{{ it.name }} <span class="muted" style="font-size:11px">{{ it.color }} {{ it.size }}</span></td><td class="num">{{ it.qty }}</td><td class="num">{{ it.returned_qty }}</td><td class="num">{{ it.total / it.qty | brl }}</td>
                <td class="num"><input type="number" min="0" [max]="it.qty - it.returned_qty" class="input-field mono" style="width:70px;padding:4px 6px;text-align:right" [(ngModel)]="it.ret" (ngModelChange)="tick()" [disabled]="it.qty - it.returned_qty <= 0" /></td>
                <td style="text-align:center"><input type="checkbox" [(ngModel)]="it.restock" /></td></tr>
            }</tbody>
          </table>
          <div class="form-grid" style="margin-top:14px">
            <div><label class="field-label">Tipo</label><select class="input-field" [ngModel]="type" (ngModelChange)="setType($event)"><option value="troca">Troca (gera vale-troca)</option><option value="devolucao">Devolução</option></select></div>
            <div><label class="field-label">Reembolso</label><select class="input-field" [(ngModel)]="refund" [disabled]="type === 'troca'">
              <option value="vale_troca">Vale-troca / crédito na loja</option><option value="dinheiro">Dinheiro (caixa aberto)</option><option value="pix">PIX</option>
              <option value="estorno_cartao">Estorno no cartão (abate recebíveis)</option><option value="abatimento_crediario">Abater no crediário</option></select></div>
            <div class="span-2"><label class="field-label">Motivo</label><input class="input-field" [(ngModel)]="reason" placeholder="Ex.: troca de tamanho, defeito..." /></div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
            <span style="font-size:13px">Valor a reembolsar: <b class="mono" style="font-size:16px">{{ refundTotal() | brl }}</b></span>
            <button class="btn-primary" [disabled]="refundTotal() <= 0 || busy()" (click)="submit()"><ax-icon name="check" [size]="14" /> Confirmar</button>
          </div>
        } @else if (searchError()) { <div class="state-error">{{ searchError() }}</div> }
        @if (result(); as r) {
          <div class="state-info" style="margin-top:14px;flex-direction:column;gap:4px">
            <b>{{ r.type === 'troca' ? 'Troca' : 'Devolução' }} nº {{ r.number }} registrada — {{ r.total | brl }}</b>
            @if (r.store_credit) { <span>Vale-troca gerado: <b class="mono" style="font-size:14px">{{ r.store_credit.code }}</b> (válido até {{ r.store_credit.expires_at | dt }}). Use no PDV na forma de pagamento "Vale-troca".</span>
              <button class="btn-primary" style="font-size:12px;align-self:flex-start;margin-top:6px" (click)="router.navigate(['/pdv'], { queryParams: { cliente: sale()?.customer_id } })">Abrir PDV para a nova compra</button> }
          </div>
        }
      </div>
      <div class="card" style="overflow:hidden">
        <div style="padding:14px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600">Últimas trocas e devoluções</div>
        <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Nº</th><th>Venda</th><th>Tipo</th><th class="num">Valor</th><th>Vale</th></tr></thead>
          <tbody>@for (r of list.items(); track r.id) { <tr class="clickable" (click)="router.navigateByUrl('/pedido-detail/' + r.sale_id)"><td class="mono">{{ r.number }}</td><td class="mono">V{{ r.sale_number }}</td><td>{{ r.type }}</td><td class="num">{{ r.total | brl }}</td><td class="mono" style="font-size:11px">{{ r.store_credit_code || '—' }}</td></tr> }</tbody></table>
        <ax-state [loading]="list.loading()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhuma troca registrada." />
        <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
      </div>
    </div>
  </div>`,
})
export class TrocasPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); private toast = inject(ToastService); private route = inject(ActivatedRoute);
  readonly tabs = VENDAS_TABS;
  readonly list = new ListState<any>((q) => this.api.get('/returns', q));
  readonly sale = signal<any>(null); readonly lines = signal<any[]>([]); readonly searchError = signal(''); readonly busy = signal(false); readonly result = signal<any>(null); readonly ver = signal(0);
  saleNumber = ''; type: 'troca' | 'devolucao' = 'troca'; refund = 'vale_troca'; reason = '';
  readonly refundTotal = computed(() => { this.ver(); return this.lines().reduce((s, l) => s + (Number(l.ret) || 0) * (l.total / l.qty), 0); });
  async ngOnInit() { this.list.load(); const v = this.route.snapshot.queryParamMap.get('venda'); if (v) this.loadSale(v); }
  tick() { this.ver.update((x) => x + 1); }
  setType(t: 'troca' | 'devolucao') { this.type = t; if (t === 'troca') this.refund = 'vale_troca'; }
  async findSale() {
    this.searchError.set(''); this.sale.set(null); this.result.set(null);
    try { const r: any = await this.api.get('/sales', { q: this.saleNumber.trim(), branch: 'all', size: 1 }); if (!r.items.length) { this.searchError.set('Venda não encontrada.'); return; } this.loadSale(r.items[0].id); }
    catch (e: any) { this.searchError.set(e.message); }
  }
  async loadSale(id: string) {
    try { const s: any = await this.api.get('/sales/' + id); this.sale.set(s); this.saleNumber = String(s.number); this.lines.set(s.items.map((i: any) => ({ ...i, ret: 0, restock: true }))); this.tick(); }
    catch (e: any) { this.searchError.set(e.message); }
  }
  async submit() {
    this.busy.set(true);
    try {
      const r = await this.api.post('/returns', { saleId: this.sale().id, type: this.type, refundMode: this.refund, reason: this.reason || undefined,
        items: this.lines().filter((l) => Number(l.ret) > 0).map((l) => ({ saleItemId: l.id, qty: Number(l.ret), restock: l.restock })) }, { idempotent: true });
      this.result.set(r); this.toast.success('Registrado com sucesso.'); this.loadSale(this.sale().id); this.list.reload();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}

// ─── Caixa ──────────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-caixa',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, PagerComponent, ModuleTabsComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Caixa</h1><p>Abertura, sangria, suprimento e fechamento com conferência</p></div>
      @if (!cur() && auth.can('caixa.operar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/pdv')">Abrir caixa no PDV</button> }</div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
      @if (cur(); as c) {
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
          <div class="kpi-card"><div class="field-label">Sessão</div><div style="font-size:15px;font-weight:700">{{ c.register_name }}</div><div style="font-size:11px;color:#647687">aberto por {{ c.opened_by_name }} em {{ c.opened_at | dtt }}</div></div>
          <div class="kpi-card"><div class="field-label">Vendas na sessão</div><div style="font-size:20px;font-weight:700">{{ c.summary.sales.n }}</div><div style="font-size:11px;color:#647687">{{ c.summary.sales.total | brl }}</div></div>
          <div class="kpi-card"><div class="field-label">Dinheiro esperado na gaveta</div><div style="font-size:20px;font-weight:700;color:#18864B">{{ c.summary.expectedCash | brl }}</div></div>
          <div class="kpi-card" style="justify-content:center;gap:6px">
            <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="mov('sangria')"><ax-icon name="arrow-up-from-line" [size]="13" /> Sangria</button>
            <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="mov('suprimento')"><ax-icon name="arrow-down-to-line" [size]="13" /> Suprimento</button>
            @if (auth.can('caixa.fechar')) { <button class="btn-primary" style="justify-content:center;font-size:12px" (click)="closeOpen.set(true)"><ax-icon name="lock" [size]="13" /> Fechar caixa</button> }
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div class="card" style="padding:16px"><div class="section-title">Recebimentos por forma de pagamento</div>
            @for (m of c.summary.byMethod; track m.kind) { <div style="display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px solid #F7FAFD"><span>{{ label(m.kind) }} <span class="muted" style="font-size:11px">({{ m.sales }} venda(s))</span></span><span class="mono">{{ m.total | brl }}</span></div> }
            @empty { <div class="muted" style="font-size:12px">Sem vendas nesta sessão.</div> }</div>
          <div class="card" style="padding:16px"><div class="section-title">Movimentos de dinheiro</div>
            @for (m of c.summary.byType; track m.type) { <div style="display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px solid #F7FAFD"><span style="text-transform:capitalize">{{ m.type }} <span class="muted" style="font-size:11px">({{ m.n }})</span></span><span class="mono" [style.color]="m.total < 0 ? '#C93636' : '#172B3A'">{{ m.total | brl }}</span></div> }</div>
        </div>
      } @else if (!loading()) { <div class="state-warning"><ax-icon name="lock" [size]="14" />Nenhum caixa aberto nesta filial.</div> }
      @if (auth.can(['caixa.fechar','financeiro.ver'])) {
        <div class="card" style="overflow:hidden">
          <div style="padding:14px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600">Histórico de sessões</div>
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Terminal</th><th>Filial</th><th>Abertura</th><th>Fechamento</th><th class="num">Esperado</th><th class="num">Declarado</th><th class="num">Diferença</th><th>Situação</th></tr></thead>
            <tbody>@for (s of sessions.items(); track s.id) { <tr><td>{{ s.register_name }}</td><td>{{ s.branch }}</td><td class="mono" style="font-size:12px">{{ s.opened_at | dtt }} · {{ s.opened_by_name }}</td><td class="mono" style="font-size:12px">{{ s.closed_at | dtt }} {{ s.closed_by_name ? '· ' + s.closed_by_name : '' }}</td>
              <td class="num">{{ s.expected_amount | brl }}</td><td class="num">{{ s.declared_amount | brl }}</td><td class="num" [style.color]="s.difference && s.difference !== 0 ? '#C93636' : '#18864B'">{{ s.difference | brl }}</td>
              <td><span class="badge" [class]="s.status === 'aberto' ? 'badge badge-success' : 'badge badge-muted'">{{ s.status === 'aberto' ? 'Aberto' : 'Fechado' }}</span></td></tr> }</tbody></table>
          <ax-pager [page]="sessions.page()" [pages]="sessions.pages()" [total]="sessions.total()" (go)="sessions.load($event)" />
        </div>
      }
    </div>
  </div>
  <ax-modal [(open)]="movOpen" [title]="movType === 'sangria' ? 'Sangria de caixa' : 'Suprimento de caixa'" icon="wallet" [width]="420">
    <label class="field-label">Valor (R$)</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="movAmount" style="margin-bottom:8px" />
    <label class="field-label">Motivo</label><input class="input-field" [(ngModel)]="movNotes" placeholder="Ex.: depósito bancário, troco" />
    <div footer><button class="btn-secondary" (click)="movOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="doMov()">Confirmar</button></div>
  </ax-modal>
  <ax-modal [(open)]="closeOpen" title="Fechamento de caixa" icon="lock" [width]="440">
    <p style="font-size:13px;margin-bottom:10px">Conte o dinheiro da gaveta e informe o valor. A diferença em relação ao esperado ({{ cur()?.summary?.expectedCash | brl }}) fica registrada na auditoria.</p>
    <label class="field-label">Valor contado (R$)</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="declared" style="margin-bottom:8px" />
    <label class="field-label">Observações</label><input class="input-field" [(ngModel)]="closeNotes" />
    <div footer><button class="btn-secondary" (click)="closeOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="doClose()">Fechar caixa</button></div>
  </ax-modal>`,
})
export class CaixaPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly tabs = VENDAS_TABS;
  readonly cur = signal<any>(null); readonly loading = signal(true);
  readonly sessions = new ListState<any>((q) => this.api.get('/cash/sessions', { ...q, branch: this.auth.me()?.user?.allBranches ? 'all' : undefined }));
  readonly movOpen = signal(false); readonly closeOpen = signal(false);
  movType: 'sangria' | 'suprimento' = 'sangria'; movAmount = 0; movNotes = ''; declared = 0; closeNotes = '';
  ngOnInit() { this.load(); if (this.auth.can(['caixa.fechar', 'financeiro.ver'])) this.sessions.load(); }
  async load() { this.loading.set(true); try { this.cur.set(await this.api.get('/cash/current')); } catch (e) { this.toast.error(e); } finally { this.loading.set(false); } }
  label(k: string) { return PAYMENT_LABEL[k] || k; }
  mov(t: 'sangria' | 'suprimento') { this.movType = t; this.movAmount = 0; this.movNotes = ''; this.movOpen.set(true); }
  async doMov() {
    try { await this.api.post(`/cash/${this.cur().id}/movement`, { type: this.movType, amount: +this.movAmount, notes: this.movNotes }, { idempotent: true }); this.toast.success('Movimento registrado.'); this.movOpen.set(false); this.load(); }
    catch (e) { this.toast.error(e); }
  }
  async doClose() {
    try { const r: any = await this.api.post(`/cash/${this.cur().id}/close`, { declaredAmount: +this.declared, notes: this.closeNotes || undefined }, { idempotent: true });
      this.toast.show(`Caixa fechado. Diferença: ${Number(r.difference).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`, Math.abs(r.difference) > 0.009 ? 'info' : 'success'); this.closeOpen.set(false); this.load(); this.sessions.reload(); }
    catch (e) { this.toast.error(e); }
  }
}

// ─── Metas e comissões ──────────────────────────────────────────────────────
@Component({
  selector: 'ax-comissoes',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, ModuleTabsComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header">
      <div style="flex:1"><h1>Metas e Comissões</h1><p>Comissão calculada por item no momento da venda, com estornos automáticos em cancelamentos e devoluções</p></div>
      <input type="month" class="input-field" style="width:160px" [(ngModel)]="month" (change)="load()" />
      @if (auth.can('comissoes.editar')) { <button class="btn-secondary" style="font-size:12px" (click)="goalOpen.set(true)"><ax-icon name="target" [size]="13" /> Definir meta</button>
        <button class="btn-secondary" style="font-size:12px" (click)="ruleOpen.set(true)"><ax-icon name="percent" [size]="13" /> Nova regra</button>
        <button class="btn-ghost" style="font-size:12px" (click)="closeMonth()">Liberar comissões do mês</button> }
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
      <ax-state [loading]="loading()" [error]="error()" />
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Vendedor(a)</th><th class="num">Vendas</th><th class="num">Base (líquida)</th><th class="num">Meta</th><th style="width:200px">Atingimento</th><th class="num">Comissão</th><th class="num">Bônus meta</th><th class="num">Estornos</th></tr></thead>
          <tbody>@for (r of rows(); track r.seller_id) {
            <tr class="clickable" (click)="details(r)">
              <td style="font-weight:500">{{ r.seller }}</td><td class="num">{{ r.sales }}</td><td class="num">{{ r.base | brl }}</td><td class="num">{{ r.target ? (r.target | brl) : '—' }}</td>
              <td>@if (r.achievement_pct !== null) { <div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:6px;background:#EEF2F6;border-radius:3px"><div [style.width.%]="r.achievement_pct > 100 ? 100 : r.achievement_pct" [style.background]="r.achievement_pct >= 100 ? '#18864B' : '#0875D1'" style="height:100%;border-radius:3px"></div></div><span class="mono" style="font-size:11px">{{ r.achievement_pct | num:0 }}%</span></div> } @else { <span class="muted" style="font-size:11px">sem meta</span> }</td>
              <td class="num" style="font-weight:600">{{ r.commission | brl }}</td><td class="num" style="color:#18864B">{{ r.bonus | brl }}</td><td class="num">{{ r.reversals }}</td>
            </tr>
          } @empty { <tr><td colspan="8" class="empty-state">Sem comissões no mês.</td></tr> }</tbody>
        </table>
      </div>
      @if (det().length) {
        <div class="card" style="overflow:hidden"><div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600">Detalhamento — {{ detSeller() }}</div>
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data</th><th>Venda</th><th>Tipo</th><th class="num">Base</th><th class="num">Comissão</th><th>Status</th></tr></thead>
            <tbody>@for (d of det(); track d.id) { <tr><td class="mono" style="font-size:12px">{{ d.created_at | dtt }}</td><td class="mono link" (click)="router.navigateByUrl('/pedido-detail/' + d.sale_id)">V{{ d.sale_number }}</td><td>{{ d.ref_type }}</td><td class="num">{{ d.base_amount | brl }}</td><td class="num" [style.color]="d.amount < 0 ? '#C93636' : '#172B3A'">{{ d.amount | brl }}</td><td>{{ d.status }}</td></tr> }</tbody></table></div>
      }
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card" style="overflow:hidden"><div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600">Regras de comissão</div>
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Regra</th><th>Escopo</th><th>Referência</th><th class="num">%</th><th>Ativa</th></tr></thead>
            <tbody>@for (r of rules(); track r.id) { <tr><td>{{ r.name }}</td><td>{{ r.scope }}</td><td>{{ r.ref_name || '—' }}</td><td class="num">{{ r.pct | num:2 }}</td>
              <td><input type="checkbox" [checked]="r.active" [disabled]="!auth.can('comissoes.editar')" (change)="toggleRule(r)" /></td></tr> }</tbody></table>
          <div style="padding:10px 16px;font-size:11px;color:#647687">Prioridade: regra do vendedor › coleção › marca › categoria › % do cadastro do vendedor › padrão.</div></div>
        <div class="card" style="overflow:hidden"><div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600">Metas do mês</div>
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Escopo</th><th class="num">Meta</th><th class="num">Realizado</th><th class="num">Bônus</th><th></th></tr></thead>
            <tbody>@for (g of goals(); track g.id) { <tr><td>{{ g.seller || (g.branch ? 'Filial ' + g.branch : 'Loja (geral)') }}</td><td class="num">{{ g.target_amount | brl }}</td><td class="num">{{ g.achieved | brl }} ({{ g.achieved / g.target_amount * 100 | num:0 }}%)</td><td class="num">{{ g.bonus_pct | num:1 }}%</td>
              <td>@if (auth.can('comissoes.editar')) { <button class="btn-ghost" style="padding:2px;color:#C93636" (click)="delGoal(g)"><ax-icon name="trash-2" [size]="12" /></button> }</td></tr> }
              @empty { <tr><td colspan="5" class="empty-state">Nenhuma meta definida.</td></tr> }</tbody></table></div>
      </div>
    </div>
  </div>
  <ax-modal [(open)]="goalOpen" title="Definir meta mensal" icon="target" [width]="440">
    <div class="form-grid">
      <div class="span-2"><label class="field-label">Vendedor(a)</label><select class="input-field" [(ngModel)]="goal.sellerId"><option value="">Loja (meta geral)</option>@for (s of lk.data()?.sellers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select></div>
      <div><label class="field-label">Meta (R$)</label><input type="number" min="1" class="input-field mono" [(ngModel)]="goal.targetAmount" /></div>
      <div><label class="field-label">Bônus ao atingir (%)</label><input type="number" min="0" step="0.5" class="input-field mono" [(ngModel)]="goal.bonusPct" /></div>
    </div>
    <div footer><button class="btn-secondary" (click)="goalOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveGoal()">Salvar</button></div>
  </ax-modal>
  <ax-modal [(open)]="ruleOpen" title="Nova regra de comissão" icon="percent" [width]="460">
    <div class="form-grid">
      <div class="span-2"><label class="field-label">Nome</label><input class="input-field" [(ngModel)]="rule.name" /></div>
      <div><label class="field-label">Escopo</label><select class="input-field" [(ngModel)]="rule.scope"><option value="padrao">Padrão</option><option value="vendedor">Vendedor</option><option value="categoria">Categoria</option><option value="marca">Marca</option><option value="colecao">Coleção</option></select></div>
      <div><label class="field-label">Percentual</label><input type="number" min="0" max="100" step="0.1" class="input-field mono" [(ngModel)]="rule.pct" /></div>
      @if (rule.scope !== 'padrao') { <div class="span-2"><label class="field-label">Referência</label><select class="input-field" [(ngModel)]="rule.refId">@for (o of refOptions(); track o.id) { <option [value]="o.id">{{ o.name }}</option> }</select></div> }
      <div><label class="field-label">Prioridade</label><input type="number" class="input-field mono" [(ngModel)]="rule.priority" /></div>
    </div>
    <div footer><button class="btn-secondary" (click)="ruleOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveRule()">Salvar</button></div>
  </ax-modal>`,
})
export class ComissoesPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tabs = VENDAS_TABS;
  readonly rows = signal<any[]>([]); readonly rules = signal<any[]>([]); readonly goals = signal<any[]>([]); readonly det = signal<any[]>([]); readonly detSeller = signal('');
  readonly loading = signal(false); readonly error = signal<string | null>(null); readonly goalOpen = signal(false); readonly ruleOpen = signal(false);
  month = monthIso(); goal: any = { sellerId: '', targetAmount: 10000, bonusPct: 1 }; rule: any = { name: '', scope: 'marca', pct: 3, refId: '', priority: 10 };
  refOptions() { const d = this.lk.data(); if (!d) return []; return ({ vendedor: d.sellers, categoria: d.categories, marca: d.brands, colecao: d.collections } as any)[this.rule.scope] ?? []; }
  ngOnInit() { this.lk.ensure(); this.load(); }
  async load() {
    this.loading.set(true); this.error.set(null);
    try { const [r, ru, g] = await Promise.all([this.api.get<any[]>('/commissions', { month: this.month }), this.api.get<any[]>('/commission-rules'), this.api.get<any[]>('/goals', { month: this.month })]); this.rows.set(r); this.rules.set(ru); this.goals.set(g); this.det.set([]); }
    catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); }
  }
  async details(r: any) { try { this.det.set(await this.api.get('/commissions/details', { seller: r.seller_id, month: this.month })); this.detSeller.set(r.seller); } catch (e) { this.toast.error(e); } }
  async saveGoal() { try { await this.api.post('/goals', { month: this.month, sellerId: this.goal.sellerId || undefined, targetAmount: +this.goal.targetAmount, bonusPct: +this.goal.bonusPct }); this.toast.success('Meta salva.'); this.goalOpen.set(false); this.load(); } catch (e) { this.toast.error(e); } }
  async delGoal(g: any) { if (!confirm('Excluir meta?')) return; try { await this.api.delete('/goals/' + g.id); this.load(); } catch (e) { this.toast.error(e); } }
  async saveRule() { try { await this.api.post('/commission-rules', { name: this.rule.name, scope: this.rule.scope, refId: this.rule.scope === 'padrao' ? undefined : this.rule.refId, pct: +this.rule.pct, priority: +this.rule.priority }); this.toast.success('Regra criada (vale para as próximas vendas).'); this.ruleOpen.set(false); this.load(); } catch (e) { this.toast.error(e); } }
  async toggleRule(r: any) { try { await this.api.put('/commission-rules/' + r.id, { active: !r.active }); this.load(); } catch (e) { this.toast.error(e); } }
  async closeMonth() { if (!confirm(`Liberar as comissões de ${this.month} para pagamento?`)) return; try { const r: any = await this.api.post('/commissions/close', { month: this.month, status: 'liberada' }); this.toast.success(`${r.updated} lançamento(s) liberado(s).`); this.load(); } catch (e) { this.toast.error(e); } }
}
