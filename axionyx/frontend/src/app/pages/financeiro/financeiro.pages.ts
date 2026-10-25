import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CustomerPickerComponent, ListState, ModalComponent, ModuleTabsComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { CHARTS, Series } from '../../shared/charts';
import { Api, newIdempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, PAYMENT_LABEL, STATUS_PIPES, addDaysIso, brl, dateBr, todayIso } from '../../core/format';

export const FIN_TABS = [{ path: '/financeiro', label: 'Visão geral' }, { path: '/contas-receber', label: 'Contas a Receber' }, { path: '/contas-pagar', label: 'Contas a Pagar' },
  { path: '/crediario', label: 'Crediário e Inadimplência' }, { path: '/fluxo-caixa', label: 'Fluxo de Caixa e Movimentos' }, { path: '/conciliacao', label: 'Conciliação Bancária' }];
const METHODS = [['pix', 'PIX'], ['transferencia', 'Transferência/TED'], ['dinheiro', 'Dinheiro (caixa aberto)'], ['boleto', 'Boleto'], ['cartao', 'Cartão'], ['debito_automatico', 'Débito automático'], ['outro', 'Outro']];
const brlFmt = (v: number) => brl(v);

// ─── Visão geral ────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-financeiro',
  imports: [IconComponent, ModuleTabsComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Financeiro — Visão Geral</h1><p style="font-size:13px;color:#647687">{{ month }} · Saldo consolidado de todas as contas</p></div>
    </div>
    <ax-state [loading]="!o()" />
    @if (o(); as o) {
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:20px">
        @for (k of kpis(); track k.label) {
          <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl(k.screen)">
            <div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">{{ k.label }}</div>
            <div style="font-size:22px;font-weight:700;color:#172B3A">{{ k.value }}</div>
            <div [style.color]="k.trend === 'up' ? '#18864B' : k.trend === 'down' ? '#C93636' : '#647687'" style="font-size:11px;display:flex;align-items:center;gap:4px;margin-top:2px">
              @if (k.trend === 'up') { <ax-icon name="trending-up" [size]="11" /> } @if (k.trend === 'down') { <ax-icon name="trending-down" [size]="11" /> } {{ k.sub }}</div>
          </div>
        }
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:10px;margin-bottom:20px">
        @for (b of quick; track b.label) { <button class="btn-secondary" style="justify-content:center;padding:10px;font-size:13px" (click)="router.navigateByUrl(b.screen)">{{ b.label }} <ax-icon name="arrow-right" [size]="13" /></button> }
      </div>
      <div class="card" style="padding:16px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:12px">Aging — Contas a Receber por faixa de vencimento</div>
        <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:12px">
          @for (a of aging(); track a.label) {
            <div style="text-align:center"><div style="font-size:11px;color:#647687;margin-bottom:6px">{{ a.label }}</div><div [style.color]="a.color" style="font-size:18px;font-weight:700">{{ a.value | brl }}</div>
              <div style="height:4px;background:#F0F4F8;border-radius:2px;margin-top:6px"><div [style.width.%]="a.pct" [style.background]="a.color" style="height:100%;border-radius:2px"></div></div>
              <div style="font-size:10px;color:#647687;margin-top:3px">{{ a.pct | num:1 }}% · {{ a.n }} título(s)</div></div>
          }
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card" style="overflow:hidden"><div style="padding:12px 16px;font-size:13px;font-weight:600">Saldos por conta</div>
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Conta</th><th>Tipo</th><th class="num">Entradas mês</th><th class="num">Saídas mês</th><th class="num">Saldo</th></tr></thead>
            <tbody>@for (a of accounts(); track a.id) { <tr><td style="font-weight:500">{{ a.name }}</td><td><span class="badge badge-muted">{{ a.type }}</span></td><td class="num" style="color:#18864B">{{ a.month_in | brl }}</td><td class="num" style="color:#C93636">{{ a.month_out | brl }}</td>
              <td class="num" style="font-weight:700" [style.color]="a.balance < 0 ? '#C93636' : null">{{ a.balance | brl }}</td></tr> }</tbody></table></div>
        <div class="card" style="overflow:hidden"><div style="padding:12px 16px;font-size:13px;font-weight:600">Recebíveis em aberto por forma de pagamento</div>
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Forma</th><th class="num">Títulos</th><th class="num">Taxas previstas</th><th class="num">Vencido</th><th class="num">Saldo</th></tr></thead>
            <tbody>@for (m of byMethod(); track $index) { <tr><td>{{ m.method || PAY[m.method_kind] || m.method_kind }}</td><td class="num">{{ m.titles }}</td><td class="num">{{ m.fees | brl }}</td><td class="num" [style.color]="m.overdue > 0 ? '#C93636' : null">{{ m.overdue | brl }}</td><td class="num" style="font-weight:600">{{ m.balance | brl }}</td></tr> }</tbody></table></div>
      </div>
    }
  </div>`,
})
export class FinanceiroPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router);
  readonly tabs = FIN_TABS; readonly PAY = PAYMENT_LABEL;
  readonly o = signal<any>(null); readonly accounts = signal<any[]>([]); readonly byMethod = signal<any[]>([]); readonly delinq = signal<any>(null);
  readonly month = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^\w/, (c) => c.toUpperCase());
  readonly quick = [{ label: 'Contas a Receber', screen: '/contas-receber' }, { label: 'Contas a Pagar', screen: '/contas-pagar' }, { label: 'Conciliação Bancária', screen: '/conciliacao' }, { label: 'Fluxo de Caixa', screen: '/fluxo-caixa' }];
  async ngOnInit() {
    const [o, a, m, d] = await Promise.all([this.api.get('/finance/overview'), this.api.get<any[]>('/financial-accounts-balances'), this.api.get<any[]>('/receivables-by-method'), this.api.get('/reports/delinquency').catch(() => null)]);
    this.accounts.set(a); this.byMethod.set(m); this.delinq.set(d); this.o.set(o);
  }
  readonly kpis = computed(() => {
    const o = this.o(); if (!o) return [];
    const cash = this.accounts().reduce((s, a) => s + Number(a.balance), 0);
    const rate = this.delinq()?.totals?.rate_pct;
    return [
      { label: 'Saldo de Caixa', value: brl(cash), sub: `${o.month.balance >= 0 ? '+' : ''}${brl(o.month.balance)} no mês`, trend: o.month.balance >= 0 ? 'up' : 'down', screen: '/fluxo-caixa' },
      { label: 'Contas a Receber', value: brl(o.receivables.open), sub: `${brl(o.receivables.overdue)} vencidos`, trend: o.receivables.overdue > 0 ? 'down' : 'neutral', screen: '/contas-receber' },
      { label: 'Contas a Pagar', value: brl(o.payables.open), sub: `${brl(o.payables.next7)} próx. 7d · ${brl(o.payables.overdue)} vencidos`, trend: o.payables.overdue > 0 ? 'down' : 'neutral', screen: '/contas-pagar' },
      { label: 'Inadimplência', value: rate != null ? rate.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—', sub: 'crediário/boletos vencidos ÷ carteira', trend: rate > 0 ? 'down' : 'neutral', screen: '/crediario' },
    ];
  });
  readonly aging = computed(() => {
    const rows = this.o()?.aging ?? []; const total = rows.reduce((s: number, r: any) => s + Number(r.total), 0) || 1;
    const def = [['a_vencer', 'A vencer', '#18864B'], ['1-30', '1-30 dias', '#D99000'], ['31-60', '31-60 dias', '#E07800'], ['61-90', '61-90 dias', '#C93636'], ['+90', '+90 dias', '#8B0000']];
    return def.map(([k, label, color]) => { const r = rows.find((x: any) => x.bucket === k); return { label, color, value: Number(r?.total ?? 0), n: r?.n ?? 0, pct: (Number(r?.total ?? 0) / total) * 100 }; });
  });
}

// ─── Baixa de título (receber/pagar) ───────────────────────────────────────
@Component({
  selector: 'ax-title-pay',
  imports: [FormsModule, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-modal [open]="!!title()" (closed)="closed.emit()" [title]="(type() === 'receber' ? 'Baixar recebimento' : 'Baixar pagamento') + ' — ' + (title()?.document ?? '')" icon="check-circle-2" [width]="520">
    @if (title(); as t) {
      <div style="font-size:12px;color:#647687;margin-bottom:10px">{{ t.customer || t.supplier || '—' }} · parcela {{ t.installment_no }}/{{ t.installments_total }} · vencimento {{ t.due_date | dt }} · saldo <b>{{ t.balance | brl }}</b></div>
      @if (quote()?.daysLate > 0) { <div class="state-warning" style="margin:0 0 10px"><span>{{ quote().daysLate }} dia(s) de atraso: multa {{ quote().fine | brl }} + juros {{ quote().interest | brl }} conforme regras do crediário.</span></div> }
      <div class="form-grid-2">
        <div><label class="field-label">Data do pagamento</label><input type="date" class="input-field" [(ngModel)]="f.date" (ngModelChange)="requote()" [max]="today" /></div>
        <div><label class="field-label">Forma</label><select class="input-field" [(ngModel)]="f.method">@for (m of methods; track m[0]) { <option [value]="m[0]">{{ m[1] }}</option> }</select></div>
        <div><label class="field-label">Multa</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.fine" (ngModelChange)="calc()" /></div>
        <div><label class="field-label">Juros</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.interest" (ngModelChange)="calc()" /></div>
        <div><label class="field-label">Desconto @if (type() === 'receber') { <span class="muted">(exige permissão)</span> }</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.discount" (ngModelChange)="calc()" [disabled]="type() === 'receber' && !auth.can('financeiro.renegociar')" /></div>
        <div><label class="field-label">Valor pago *</label><input type="number" min="0.01" step="0.01" class="input-field mono" style="font-weight:700" [(ngModel)]="f.amount" /></div>
        @if (f.method !== 'dinheiro') { <div class="span-all"><label class="field-label">Conta</label><select class="input-field" [(ngModel)]="f.accountId"><option value="">Conta padrão</option>@for (a of lk.data()?.accounts ?? []; track a.id) { <option [value]="a.id">{{ a.name }}</option> }</select></div> }
        <div class="span-all"><label class="field-label">Observação</label><input class="input-field" [(ngModel)]="f.notes" /></div>
      </div>
      <p style="font-size:11px;color:#647687;margin-top:8px">Total devido com encargos: <b>{{ due() | brl }}</b>. Valor menor que o devido gera baixa parcial; o saldo continua em aberto.</p>
    }
    <div footer><button class="btn-secondary" (click)="closed.emit()">Cancelar</button><button class="btn-primary" [disabled]="busy() || !(f.amount > 0)" (click)="save()">Confirmar baixa</button></div>
  </ax-modal>`,
})
export class TitlePayComponent {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly type = input<'receber' | 'pagar'>('receber'); readonly title = input<any>(null);
  readonly closed = output<void>(); readonly paid = output<void>();
  readonly quote = signal<any>(null); readonly busy = signal(false); readonly due = signal(0);
  readonly methods = METHODS; readonly today = todayIso();
  f: any = {}; private idem = '';
  constructor() { this.lk.ensure(); }
  ngOnChanges() { const t = this.title(); if (!t) return; this.idem = newIdempotencyKey(); this.f = { date: todayIso(), method: this.type() === 'receber' ? 'pix' : 'transferencia', fine: 0, interest: 0, discount: 0, amount: Number(t.balance), accountId: t.account_id || '', notes: '' }; this.due.set(Number(t.balance)); this.requote(); }
  async requote() {
    if (this.type() !== 'receber') { this.quote.set(null); return; }
    try { const q: any = await this.api.get(`/receivables/${this.title().id}/quote`, { date: this.f.date }); this.quote.set(q); this.f.fine = q.fine; this.f.interest = q.interest; this.calc(true); } catch { /* */ }
  }
  calc(setAmount = false) { const d = Math.round((Number(this.title().balance) + (+this.f.fine || 0) + (+this.f.interest || 0) - (+this.f.discount || 0)) * 100) / 100; this.due.set(d); if (setAmount || this.f.amount > d) this.f.amount = d; }
  async save() {
    this.busy.set(true);
    try {
      await this.api.post(`/${this.type() === 'receber' ? 'receivables' : 'payables'}/${this.title().id}/pay`, { amount: +this.f.amount, fine: +this.f.fine || undefined, interest: +this.f.interest || undefined, discount: +this.f.discount || undefined,
        date: this.f.date, method: this.f.method, accountId: this.f.accountId || undefined, notes: this.f.notes || undefined }, { idempotent: this.idem });
      this.toast.success('Baixa registrada.'); this.paid.emit(); this.closed.emit();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}

// ─── Detalhe do título (pagamentos, estorno, trilha) ───────────────────────
@Component({
  selector: 'ax-title-detail',
  imports: [FormsModule, ModalComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-modal [open]="!!d()" (closed)="closed.emit()" [title]="'Título ' + (d()?.document ?? '')" icon="receipt" [width]="640">
    @if (d(); as t) {
      <div class="form-grid-3" style="font-size:12px;margin-bottom:12px">
        <div><div class="muted">{{ type() === 'receber' ? 'Cliente' : 'Fornecedor' }}</div><b>{{ t.customer || t.supplier || '—' }}</b></div>
        <div><div class="muted">Parcela</div>{{ t.installment_no }}/{{ t.installments_total }}</div><div><div class="muted">Status</div><span class="badge" [class]="'badge ' + (t.status | statusClass)">{{ t.status | statusLabel }}</span></div>
        <div><div class="muted">Vencimento</div>{{ t.due_date | dt }}</div><div><div class="muted">Valor</div>{{ t.amount | brl }}</div><div><div class="muted">Saldo</div><b>{{ t.balance | brl }}</b></div>
        @if (t.sale_number) { <div><div class="muted">Venda</div>nº {{ t.sale_number }}</div> }
        @if (t.description) { <div class="span-all"><div class="muted">Descrição</div>{{ t.description }}</div> }
      </div>
      <div class="section-title" style="margin-bottom:6px">Pagamentos</div>
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data</th><th>Forma</th><th class="num">Valor</th><th class="num">Encargos</th><th class="num">Desconto</th><th>Usuário</th><th></th></tr></thead>
        <tbody>@for (p of t.payments; track p.id) { <tr [style.opacity]="p.reversed_at ? 0.5 : 1"><td class="mono" style="font-size:12px">{{ p.date | dt }}</td><td>{{ p.method || '—' }}</td><td class="num">{{ p.amount | brl }}</td><td class="num">{{ (+p.interest + +p.fine) | brl }}</td><td class="num">{{ p.discount | brl }}</td><td style="font-size:12px">{{ p.user_name }}</td>
          <td>@if (p.reversed_at) { <span class="badge badge-muted">Estornado</span> } @else if (auth.can('financeiro.baixar')) { <button class="btn-ghost" style="font-size:11px;color:#C93636" (click)="reverse(p)">Estornar</button> }</td></tr> }
        @empty { <tr><td colspan="7" class="muted" style="text-align:center">Nenhum pagamento.</td></tr> }</tbody></table>
      @if (t.audit?.length) { <div class="section-title" style="margin:12px 0 6px">Trilha de auditoria</div>
        @for (a of t.audit; track $index) { <div style="font-size:11px;color:#647687">{{ a.created_at | dtt }} · {{ a.user_name }} · {{ a.action }}</div> } }
    }
  </ax-modal>`,
})
export class TitleDetailComponent {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly type = input<'receber' | 'pagar'>('receber'); readonly id = input<string | null>(null);
  readonly closed = output<void>(); readonly changed = output<void>();
  readonly d = signal<any>(null);
  async ngOnChanges() { this.d.set(null); if (this.id()) try { this.d.set(await this.api.get(`/${this.type() === 'receber' ? 'receivables' : 'payables'}/${this.id()}`)); } catch (e) { this.toast.error(e); this.closed.emit(); } }
  async reverse(p: any) {
    const reason = prompt('Motivo do estorno (mín. 5 caracteres):'); if (!reason || reason.trim().length < 5) return;
    try { await this.api.post(`/title-payments/${p.id}/reverse`, { reason: reason.trim() }); this.toast.success('Pagamento estornado.'); this.changed.emit(); this.ngOnChanges(); } catch (e) { this.toast.error(e); }
  }
}

// ─── Renegociação de crediário ─────────────────────────────────────────────
@Component({
  selector: 'ax-renegotiation',
  imports: [FormsModule, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-modal [open]="!!customer()" (closed)="closed.emit()" [title]="'Renegociar — ' + (customer()?.name ?? '')" icon="handshake" [width]="720">
    <p style="font-size:12px;color:#647687;margin-bottom:8px">Os títulos selecionados são encerrados como "renegociado" e substituídos por um novo parcelamento. A operação fica registrada na auditoria com os valores originais.</p>
    <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th style="width:30px"></th><th>Documento</th><th>Vencimento</th><th class="num">Atraso</th><th class="num">Saldo</th><th class="num">Encargos hoje</th></tr></thead>
      <tbody>@for (t of titles(); track t.id) { <tr><td><input type="checkbox" [checked]="sel().includes(t.id)" (change)="toggle(t.id)" /></td><td class="mono" style="font-size:12px">{{ t.document }} {{ t.installment_no }}/{{ t.installments_total }}</td>
        <td class="mono" style="font-size:12px">{{ t.due_date | dt }}</td><td class="num">{{ t.days_late || '—' }}</td><td class="num">{{ t.balance | brl }}</td><td class="num">{{ (t.q?.fine + t.q?.interest) || 0 | brl }}</td></tr> }
      @empty { <tr><td colspan="6" class="muted" style="text-align:center">Nenhum título em aberto.</td></tr> }</tbody></table>
    <div class="form-grid-3" style="margin-top:12px">
      <div><label class="field-label">Saldo selecionado</label><div class="input-field mono" style="background:#F4F7FA">{{ original() | brl }}</div></div>
      <div><label class="field-label">Encargos a incluir</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.interest" (ngModelChange)="tick.set(tick() + 1)" /><div class="muted" style="font-size:11px">calculado: {{ charges() | brl }}</div></div>
      <div><label class="field-label">Desconto concedido</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.discount" (ngModelChange)="tick.set(tick() + 1)" /></div>
      <div><label class="field-label">Nº de parcelas</label><select class="input-field" [(ngModel)]="f.installments" (ngModelChange)="tick.set(tick() + 1)">@for (n of [1,2,3,4,5,6,8,10,12]; track n) { <option [ngValue]="n">{{ n }}x</option> }</select></div>
      <div><label class="field-label">1º vencimento</label><input type="date" class="input-field" [(ngModel)]="f.firstDue" [min]="today" /></div>
      <div><label class="field-label">Novo total</label><div class="input-field mono" style="background:#F4F7FA;font-weight:700">{{ newTotal() | brl }} <span class="muted">({{ f.installments }}x {{ newTotal() / f.installments | brl }})</span></div></div>
      <div class="span-all"><label class="field-label">Observações</label><input class="input-field" [(ngModel)]="f.notes" /></div>
    </div>
    <div footer><button class="btn-secondary" (click)="closed.emit()">Cancelar</button><button class="btn-primary" [disabled]="busy() || !sel().length || newTotal() <= 0" (click)="save()">Confirmar renegociação</button></div>
  </ax-modal>`,
})
export class RenegotiationComponent {
  private api = inject(Api); private toast = inject(ToastService); private router = inject(Router);
  readonly customer = input<{ id: string; name: string } | null>(null); readonly preselect = input<string[]>([]);
  readonly closed = output<void>(); readonly done = output<void>();
  readonly titles = signal<any[]>([]); readonly sel = signal<string[]>([]); readonly busy = signal(false); readonly tick = signal(0); readonly today = todayIso();
  f: any = {}; private idem = '';
  readonly original = computed(() => Math.round(this.titles().filter((t) => this.sel().includes(t.id)).reduce((s, t) => s + Number(t.balance), 0) * 100) / 100);
  readonly charges = computed(() => Math.round(this.titles().filter((t) => this.sel().includes(t.id)).reduce((s, t) => s + (t.q?.fine ?? 0) + (t.q?.interest ?? 0), 0) * 100) / 100);
  readonly newTotal = computed(() => { this.tick(); return Math.round((this.original() + (+this.f.interest || 0) - (+this.f.discount || 0)) * 100) / 100; });
  async ngOnChanges() {
    const c = this.customer(); if (!c) return;
    this.idem = newIdempotencyKey(); this.f = { interest: 0, discount: 0, installments: 3, firstDue: addDaysIso(todayIso(), 30), notes: '' };
    const r: any = await this.api.get('/receivables', { customer: c.id, status: 'em_aberto', size: 100 });
    const list = r.items.filter((t: any) => ['crediario', 'a_prazo', 'boleto'].includes(t.method_kind));
    await Promise.all(list.map(async (t: any) => { if (t.days_late > 0) try { t.q = await this.api.get(`/receivables/${t.id}/quote`); } catch { /* */ } }));
    this.titles.set(list); this.sel.set(this.preselect().length ? this.preselect().filter((id) => list.some((t: any) => t.id === id)) : list.filter((t: any) => t.days_late > 0).map((t: any) => t.id));
    this.f.interest = this.charges(); this.tick.set(this.tick() + 1);
  }
  toggle(id: string) { this.sel.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])); this.f.interest = this.charges(); this.tick.set(this.tick() + 1); }
  async save() {
    this.busy.set(true);
    try {
      const rn: any = await this.api.post('/receivables/renegotiate', { customerId: this.customer()!.id, ids: this.sel(), interest: +this.f.interest || 0, discount: +this.f.discount || 0, installments: this.f.installments, firstDue: this.f.firstDue, notes: this.f.notes || undefined }, { idempotent: this.idem });
      this.toast.success(`Renegociação nº ${rn.number} registrada.`); this.done.emit(); this.closed.emit();
      this.router.navigate(['/carne'], { queryParams: { renegociacao: rn.id } });
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}

// ─── Contas a receber ──────────────────────────────────────────────────────
@Component({
  selector: 'ax-contas-receber',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModalComponent, ModuleTabsComponent, CustomerPickerComponent, TitlePayComponent, TitleDetailComponent, RenegotiationComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:240px"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Contas a Receber</h1>
        <p style="font-size:12px;color:#647687">{{ list.total() }} títulos · {{ t()?.balance | brl }} em aberto no filtro · {{ t()?.overdue | brl }} vencidos</p></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        @if (auth.can('financeiro.baixar')) { <button class="btn-ghost" style="font-size:12px" [disabled]="!cardSel().length" (click)="settleCards()">Liquidar cartões ({{ cardSel().length }})</button> }
        @if (auth.can('financeiro.renegociar')) { <button class="btn-ghost" style="font-size:12px" [disabled]="!renegCustomer()" (click)="reneg.set(renegCustomer())" title="Selecione títulos de um mesmo cliente">Renegociar</button> }
        @if (auth.can('mensagens.enviar')) { <button class="btn-ghost" style="font-size:12px" [disabled]="!sel().length" (click)="charge()">Enviar cobrança</button> }
        <button class="btn-ghost" style="font-size:12px" (click)="csv()"><ax-icon name="download" [size]="12" /> CSV</button>
        @if (auth.can('financeiro.editar')) { <button class="btn-primary" style="font-size:12px" (click)="openNew()"><ax-icon name="plus" [size]="13" /> Novo lançamento</button> }
      </div>
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="padding:0 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;gap:0;align-items:center">
      @for (s of statuses; track s.v) { <div class="tab-item" [class.active]="status() === s.v" (click)="status.set(s.v); apply()">{{ s.l }}</div> }
      <div style="margin-left:auto;display:flex;gap:6px;padding:6px 0">
        <select class="input-field" style="width:150px;font-size:12px" [(ngModel)]="kind" (ngModelChange)="apply()"><option value="">Todas as formas</option>@for (k of kinds; track k) { <option [value]="k">{{ PAY[k] }}</option> }</select>
        <input type="date" class="input-field" style="width:135px;font-size:12px" [(ngModel)]="from" (change)="apply()" title="Vencimento de" /><input type="date" class="input-field" style="width:135px;font-size:12px" [(ngModel)]="to" (change)="apply()" title="Vencimento até" />
        <input class="input-field" style="width:180px;font-size:12px" placeholder="Cliente ou documento" [(ngModel)]="q" (keyup.enter)="apply()" />
      </div>
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0;z-index:1"><tr><th style="width:40px"><input type="checkbox" (change)="toggleAll($any($event.target).checked)" /></th><th>Título</th><th>Cliente</th><th>Forma</th><th>Emissão</th><th>Vencimento</th><th class="num">Valor</th><th class="num">Saldo</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>@for (r of list.items(); track r.id) {
          <tr>
            <td><input type="checkbox" [checked]="sel().includes(r.id)" (change)="toggle(r.id)" [disabled]="!['aberto','parcial'].includes(r.status)" /></td>
            <td class="mono link" style="font-size:12px" (click)="detail.set(r.id)">{{ r.document }}-{{ r.installment_no }}/{{ r.installments_total }}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">{{ r.customer || '—' }}</td>
            <td style="font-size:12px">{{ r.method || PAY[r.method_kind] || r.method_kind }}</td><td class="mono" style="font-size:12px">{{ r.issue_date | dt }}</td>
            <td class="mono" style="font-size:12px" [style.color]="r.days_late > 0 && open(r) ? '#C93636' : '#172B3A'" [style.font-weight]="r.days_late > 0 && open(r) ? 600 : 400">{{ r.due_date | dt }} @if (r.days_late > 0 && open(r)) { <span style="font-size:10px">({{ r.days_late }}d)</span> }</td>
            <td class="num">{{ r.amount | brl }}</td><td class="num" style="font-weight:600">{{ r.balance | brl }}</td>
            <td>@if (open(r) && r.days_late > 0) { <span class="badge badge-danger">Vencido</span> } @else if (open(r)) { <span class="badge badge-info">{{ r.status === 'parcial' ? 'Parcial' : 'A vencer' }}</span> } @else { <span class="badge" [class]="'badge ' + (r.status | statusClass)">{{ r.status === 'pago' ? 'Baixado' : (r.status | statusLabel) }}</span> }</td>
            <td><div style="display:flex;gap:4px">
              @if (open(r) && auth.can('financeiro.baixar')) { <button class="btn-ghost" style="font-size:11px;padding:3px 6px" (click)="pay.set(r)">Baixar</button> }
              @if (r.sale_id && r.method_kind === 'crediario') { <button class="btn-ghost" style="font-size:11px;padding:3px 6px" (click)="router.navigate(['/carne'], { queryParams: { venda: r.sale_id } })">Carnê</button> }
              @if (r.status === 'aberto' && +r.paid_amount === 0 && auth.can('financeiro.editar')) { <button class="btn-ghost" style="font-size:11px;padding:3px 6px;color:#C93636" (click)="cancel(r)">Cancelar</button> }
            </div></td>
          </tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum título no filtro." />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-title-pay type="receber" [title]="pay()" (closed)="pay.set(null)" (paid)="list.reload()" />
  <ax-title-detail type="receber" [id]="detail()" (closed)="detail.set(null)" (changed)="list.reload()" />
  <ax-renegotiation [customer]="reneg()" [preselect]="sel()" (closed)="reneg.set(null)" (done)="list.reload()" />
  <ax-modal [(open)]="newOpen" title="Novo título a receber" icon="plus" [width]="560">
    <div class="form-grid-2">
      <div class="span-all"><label class="field-label">Cliente</label><ax-customer-picker [(value)]="nCustomer" /></div>
      <div><label class="field-label">Documento *</label><input class="input-field" [(ngModel)]="n.document" /></div>
      <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="n.methodKind"><option value="outro">Outro</option><option value="boleto">Boleto</option><option value="a_prazo">A prazo</option><option value="crediario">Crediário</option></select></div>
      <div><label class="field-label">Valor total *</label><input type="number" min="0.01" step="0.01" class="input-field mono" [(ngModel)]="n.amount" /></div>
      <div><label class="field-label">Parcelas</label><input type="number" min="1" max="60" class="input-field mono" [(ngModel)]="n.installments" /></div>
      <div><label class="field-label">1º vencimento *</label><input type="date" class="input-field" [(ngModel)]="n.firstDue" /></div>
      <div><label class="field-label">Categoria</label><select class="input-field" [(ngModel)]="n.categoryId"><option value="">—</option>@for (c of revCats(); track c.id) { <option [value]="c.id">{{ c.code }} {{ c.name }}</option> }</select></div>
      <div class="span-all"><label class="field-label">Descrição</label><input class="input-field" [(ngModel)]="n.description" /></div>
    </div>
    <div footer><button class="btn-secondary" (click)="newOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!n.document || !(n.amount > 0) || !n.firstDue" (click)="saveNew()">Criar título(s)</button></div>
  </ax-modal>`,
})
export class ContasReceberPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tabs = FIN_TABS; readonly PAY = PAYMENT_LABEL;
  readonly list = new ListState<any>((q) => this.api.get('/receivables', q));
  readonly t = computed(() => this.list.extra()?.totals);
  readonly status = signal('em_aberto'); kind = ''; from = ''; to = ''; q = '';
  readonly statuses = [{ v: '', l: 'Todos' }, { v: 'em_aberto', l: 'Em aberto' }, { v: 'vencido', l: 'Vencidos' }, { v: 'pago', l: 'Baixados' }, { v: 'renegociado', l: 'Renegociados' }, { v: 'cancelado', l: 'Cancelados' }];
  readonly kinds = ['crediario', 'cartao_credito', 'cartao_debito', 'boleto', 'a_prazo', 'outro'];
  readonly sel = signal<string[]>([]); readonly pay = signal<any>(null); readonly detail = signal<string | null>(null); readonly reneg = signal<any>(null);
  readonly newOpen = signal(false); readonly nCustomer = signal<any>(null); n: any = {};
  readonly selRows = computed(() => this.list.items().filter((r) => this.sel().includes(r.id)));
  readonly cardSel = computed(() => this.selRows().filter((r) => ['cartao_credito', 'cartao_debito'].includes(r.method_kind)).map((r) => r.id));
  readonly renegCustomer = computed(() => { const rows = this.selRows(); if (!rows.length || !rows[0].customer_id || rows.some((r) => r.customer_id !== rows[0].customer_id)) return null; return { id: rows[0].customer_id, name: rows[0].customer }; });
  readonly revCats = computed(() => (this.lk.data()?.finCategories ?? []).filter((c) => c.type === 'receita'));
  ngOnInit() { this.lk.ensure(); this.apply(); }
  open(r: any) { return ['aberto', 'parcial'].includes(r.status); }
  apply() { this.sel.set([]); this.list.query = { status: this.status(), kind: this.kind || undefined, from: this.from || undefined, to: this.to || undefined, q: this.q || undefined }; this.list.load(1); }
  toggle(id: string) { this.sel.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])); }
  toggleAll(on: boolean) { this.sel.set(on ? this.list.items().filter((r) => this.open(r)).map((r) => r.id) : []); }
  async settleCards() {
    if (!confirm(`Liquidar ${this.cardSel().length} recebível(is) de cartão? A taxa prevista da adquirente será lançada como despesa.`)) return;
    try { const r: any = await this.api.post('/receivables/settle-cards', { ids: this.cardSel() }, { idempotent: true }); this.toast.success(`${r.settled} liquidado(s): líquido ${brl(r.net)}, taxas ${brl(r.fees)}.`); this.apply(); } catch (e) { this.toast.error(e); }
  }
  async charge() {
    const rows = this.selRows().filter((r) => r.customer_id); const by = new Map<string, any[]>();
    rows.forEach((r) => by.set(r.customer_id, [...(by.get(r.customer_id) || []), r]));
    let ok = 0, blocked = 0;
    for (const [cid, ts] of by) {
      const total = ts.reduce((s, t) => s + Number(t.balance), 0);
      try { const m: any = await this.api.post('/messages', { customerId: cid, purpose: 'cobranca', refType: 'cobranca', refId: ts.map((t) => t.id).sort().join(',').slice(0, 80) + ':' + todayIso(),
          body: `Olá {nome}! Identificamos ${ts.length} parcela(s) em aberto (${brl(total)}), com vencimento em ${ts.map((t) => dateBr(t.due_date)).join(', ')}. Se já pagou, desconsidere. Podemos ajudar?` });
        if (m.status === 'fila') ok++; else blocked++; } catch { blocked++; }
    }
    this.toast.success(`Cobrança: ${ok} enfileirada(s); ${blocked} não enviada(s) (sem consentimento, sem número ou WhatsApp não configurado — ver Mensagens).`);
  }
  csv() { this.api.download('/reports/due', { format: 'csv', from: this.from || undefined, to: this.to || undefined }, 'vencimentos.csv'); }
  async cancel(r: any) { const reason = prompt('Motivo do cancelamento (mín. 5 caracteres):'); if (!reason || reason.trim().length < 5) return; try { await this.api.post(`/receivables/${r.id}/cancel`, { reason: reason.trim() }); this.list.reload(); } catch (e) { this.toast.error(e); } }
  openNew() { this.n = { document: '', methodKind: 'outro', amount: null, installments: 1, firstDue: addDaysIso(todayIso(), 30), categoryId: '', description: '' }; this.nCustomer.set(null); this.newOpen.set(true); }
  async saveNew() {
    try { await this.api.post('/receivables', { customerId: this.nCustomer()?.id, document: this.n.document, methodKind: this.n.methodKind, amount: +this.n.amount, installments: +this.n.installments || 1, firstDue: this.n.firstDue, categoryId: this.n.categoryId || undefined, description: this.n.description || undefined });
      this.toast.success('Título(s) criado(s).'); this.newOpen.set(false); this.list.reload(); } catch (e) { this.toast.error(e); }
  }
}

// ─── Contas a pagar ────────────────────────────────────────────────────────
@Component({
  selector: 'ax-contas-pagar',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModalComponent, ModuleTabsComponent, TitlePayComponent, TitleDetailComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Contas a Pagar</h1><p style="font-size:12px;color:#647687">{{ list.total() }} títulos · {{ t()?.balance | brl }} em carteira · {{ t()?.overdue | brl }} vencidos</p></div>
      @if (auth.can('financeiro.editar')) { <button class="btn-primary" style="font-size:12px" (click)="openNew()"><ax-icon name="plus" [size]="13" /> Novo lançamento</button> }
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="padding:0 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center">
      @for (s of statuses; track s.v) { <div class="tab-item" [class.active]="status() === s.v" (click)="status.set(s.v); apply()">{{ s.l }}</div> }
      <div style="margin-left:auto;display:flex;gap:6px;padding:6px 0">
        <select class="input-field" style="width:170px;font-size:12px" [(ngModel)]="category" (ngModelChange)="apply()"><option value="">Todas as categorias</option>@for (c of expCats(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }</select>
        <input type="date" class="input-field" style="width:135px;font-size:12px" [(ngModel)]="from" (change)="apply()" /><input type="date" class="input-field" style="width:135px;font-size:12px" [(ngModel)]="to" (change)="apply()" />
        <input class="input-field" style="width:180px;font-size:12px" placeholder="Fornecedor, documento" [(ngModel)]="q" (keyup.enter)="apply()" />
      </div>
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Título</th><th>Fornecedor</th><th>Documento</th><th>Categoria</th><th>Origem</th><th>Vencimento</th><th class="num">Valor</th><th class="num">Saldo</th><th>Situação</th><th></th></tr></thead>
        <tbody>@for (p of list.items(); track p.id) {
          <tr>
            <td class="mono link" style="font-size:12px" (click)="detail.set(p.id)">{{ p.installment_no }}/{{ p.installments_total }}</td><td style="font-size:13px">{{ p.supplier || p.description || '—' }}</td>
            <td class="mono" style="font-size:12px">{{ p.document }}</td><td><span class="badge badge-muted">{{ p.category || '—' }}</span></td><td style="font-size:12px;color:#647687">{{ ORIGIN[p.source_type] || p.source_type }}</td>
            <td class="mono" style="font-size:12px" [style.color]="p.days_late > 0 && open(p) ? '#C93636' : '#172B3A'" [style.font-weight]="p.days_late > 0 && open(p) ? 600 : 400">{{ p.due_date | dt }}</td>
            <td class="num">{{ p.amount | brl }}</td><td class="num" style="font-weight:600">{{ p.balance | brl }}</td>
            <td>@if (open(p) && p.days_late > 0) { <span class="badge badge-danger">Vencido</span> } @else if (open(p)) { <span class="badge badge-info">A vencer</span> } @else { <span class="badge" [class]="'badge ' + (p.status | statusClass)">{{ p.status | statusLabel }}</span> }</td>
            <td style="white-space:nowrap">@if (open(p) && auth.can('financeiro.baixar')) { <button class="btn-ghost" style="font-size:11px;padding:3px 6px" (click)="pay.set(p)">Pagar</button> }
              @if (p.status === 'aberto' && +p.paid_amount === 0 && auth.can('financeiro.editar')) { <button class="btn-ghost" style="font-size:11px;padding:3px 6px;color:#C93636" (click)="cancel(p)">Cancelar</button> }</td>
          </tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum título no filtro." />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-title-pay type="pagar" [title]="pay()" (closed)="pay.set(null)" (paid)="list.reload()" />
  <ax-title-detail type="pagar" [id]="detail()" (closed)="detail.set(null)" (changed)="list.reload()" />
  <ax-modal [(open)]="newOpen" title="Nova conta a pagar" icon="plus" [width]="560">
    <div class="form-grid-2">
      <div class="span-all"><label class="field-label">Fornecedor</label><select class="input-field" [(ngModel)]="n.supplierId"><option value="">— (despesa sem fornecedor)</option>@for (s of lk.data()?.suppliers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select></div>
      <div><label class="field-label">Documento *</label><input class="input-field" [(ngModel)]="n.document" /></div>
      <div><label class="field-label">Categoria *</label><select class="input-field" [(ngModel)]="n.categoryId">@for (c of expCats(); track c.id) { <option [value]="c.id">{{ c.code }} {{ c.name }}</option> }</select></div>
      <div><label class="field-label">Valor {{ n.recurrence === 'mensal' ? 'mensal' : 'total' }} *</label><input type="number" min="0.01" step="0.01" class="input-field mono" [(ngModel)]="n.amount" /></div>
      <div><label class="field-label">Recorrência</label><select class="input-field" [(ngModel)]="n.recurrence"><option value="unica">Parcelado (divide o total)</option><option value="mensal">Mensal (repete o valor)</option></select></div>
      <div><label class="field-label">{{ n.recurrence === 'mensal' ? 'Nº de meses' : 'Parcelas' }}</label><input type="number" min="1" max="60" class="input-field mono" [(ngModel)]="n.installments" /></div>
      <div><label class="field-label">1º vencimento *</label><input type="date" class="input-field" [(ngModel)]="n.firstDue" /></div>
      <div class="span-all"><label class="field-label">Conta de pagamento</label><select class="input-field" [(ngModel)]="n.accountId"><option value="">Conta padrão</option>@for (a of lk.data()?.accounts ?? []; track a.id) { <option [value]="a.id">{{ a.name }}</option> }</select></div>
      <div class="span-all"><label class="field-label">Descrição</label><input class="input-field" [(ngModel)]="n.description" /></div>
    </div>
    <div footer><button class="btn-secondary" (click)="newOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!n.document || !n.categoryId || !(n.amount > 0) || !n.firstDue" (click)="saveNew()">Lançar</button></div>
  </ax-modal>`,
})
export class ContasPagarPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tabs = FIN_TABS; readonly ORIGIN: Record<string, string> = { manual: 'Manual', purchase_entry: 'Compra', taxa_cartao: 'Taxa cartão', comissao: 'Comissão', folha: 'Folha' };
  readonly list = new ListState<any>((q) => this.api.get('/payables', q));
  readonly t = computed(() => this.list.extra()?.totals);
  readonly status = signal('em_aberto'); category = ''; from = ''; to = ''; q = '';
  readonly statuses = [{ v: '', l: 'Todos' }, { v: 'em_aberto', l: 'Em aberto' }, { v: 'vencido', l: 'Vencidos' }, { v: 'pago', l: 'Pagos' }, { v: 'cancelado', l: 'Cancelados' }];
  readonly pay = signal<any>(null); readonly detail = signal<string | null>(null); readonly newOpen = signal(false); n: any = {};
  readonly expCats = computed(() => (this.lk.data()?.finCategories ?? []).filter((c) => c.type === 'despesa'));
  ngOnInit() { this.lk.ensure(); this.apply(); }
  open(p: any) { return ['aberto', 'parcial'].includes(p.status); }
  apply() { this.list.query = { status: this.status(), category: this.category || undefined, from: this.from || undefined, to: this.to || undefined, q: this.q || undefined }; this.list.load(1); }
  async cancel(p: any) { const reason = prompt('Motivo do cancelamento (mín. 5 caracteres):'); if (!reason || reason.trim().length < 5) return; try { await this.api.post(`/payables/${p.id}/cancel`, { reason: reason.trim() }); this.list.reload(); } catch (e) { this.toast.error(e); } }
  openNew() { this.n = { supplierId: '', document: '', categoryId: this.expCats()[0]?.id ?? '', amount: null, recurrence: 'unica', installments: 1, firstDue: todayIso(), accountId: '', description: '' }; this.newOpen.set(true); }
  async saveNew() {
    try { await this.api.post('/payables', { supplierId: this.n.supplierId || undefined, document: this.n.document, categoryId: this.n.categoryId, amount: +this.n.amount, recurrence: this.n.recurrence, installments: +this.n.installments || 1, firstDue: this.n.firstDue, accountId: this.n.accountId || undefined, description: this.n.description || undefined });
      this.toast.success('Conta lançada.'); this.newOpen.set(false); this.list.reload(); } catch (e) { this.toast.error(e); }
  }
}

// ─── Crediário e inadimplência ─────────────────────────────────────────────
@Component({
  selector: 'ax-crediario',
  imports: [FormsModule, IconComponent, StateComponent, ModuleTabsComponent, RenegotiationComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Crediário e Inadimplência</h1><p style="font-size:13px;color:#647687">Carteira própria (crediário, a prazo e boletos) · juros {{ rules().jurosMensalPct }}% a.m. · multa {{ rules().multaPct }}% · carência {{ rules().carenciaDias ?? 0 }} dia(s)</p></div>
      <div style="display:flex;gap:8px"><button class="btn-secondary" style="font-size:12px" (click)="api.download('/reports/delinquency', { format: 'csv' }, 'inadimplencia.csv')"><ax-icon name="download" [size]="13" /> CSV</button>
        @if (auth.can('mensagens.enviar')) { <button class="btn-secondary" style="font-size:12px" [disabled]="!d()?.rows?.length" (click)="chargeAll()"><ax-icon name="message-circle" [size]="13" /> Cobrar todos (WhatsApp)</button> }</div>
    </div>
    <ax-state [loading]="!d()" />
    @if (d(); as d) {
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
        <div class="kpi-card"><div class="muted" style="font-size:11px;font-weight:600;text-transform:uppercase">Carteira</div><div style="font-size:22px;font-weight:700">{{ d.totals.portfolio | brl }}</div></div>
        <div class="kpi-card"><div class="muted" style="font-size:11px;font-weight:600;text-transform:uppercase">Vencido</div><div style="font-size:22px;font-weight:700;color:#C93636">{{ d.totals.overdue | brl }}</div></div>
        <div class="kpi-card"><div class="muted" style="font-size:11px;font-weight:600;text-transform:uppercase">Inadimplência</div><div style="font-size:22px;font-weight:700" [style.color]="d.totals.rate_pct > 5 ? '#C93636' : '#D99000'">{{ d.totals.rate_pct | num:1 }}%</div></div>
        <div class="kpi-card"><div class="muted" style="font-size:11px;font-weight:600;text-transform:uppercase">Clientes em atraso</div><div style="font-size:22px;font-weight:700">{{ d.rows.length }}</div></div>
      </div>
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Cód.</th><th>Cliente</th><th>WhatsApp</th><th class="num">Parcelas vencidas</th><th>Vencimento mais antigo</th><th class="num">Maior atraso</th><th class="num">Valor vencido</th><th>Ações</th></tr></thead>
          <tbody>@for (r of d.rows; track r.id) {
            <tr><td class="mono" style="font-size:12px">{{ r.code }}</td><td class="link" style="font-weight:500" (click)="router.navigateByUrl('/cliente-detail/' + r.id)">{{ r.name }}</td><td style="font-size:12px">{{ r.whatsapp | phone }}</td><td class="num">{{ r.titles }}</td>
              <td class="mono" style="font-size:12px">{{ r.oldest_due | dt }}</td><td class="num"><span class="badge" [class]="r.max_days > 60 ? 'badge badge-danger' : r.max_days > 30 ? 'badge badge-warning' : 'badge badge-muted'">{{ r.max_days }} dias</span></td>
              <td class="num" style="font-weight:700;color:#C93636">{{ r.overdue | brl }}</td>
              <td style="white-space:nowrap"><button class="btn-ghost" style="font-size:11px;padding:3px 6px" (click)="router.navigate(['/contas-receber'], { queryParams: {} }); ">Títulos</button>
                @if (auth.can('financeiro.renegociar')) { <button class="btn-ghost" style="font-size:11px;padding:3px 6px" (click)="reneg.set({ id: r.id, name: r.name })">Renegociar</button> }</td></tr>
          }</tbody>
        </table>
        <ax-state [empty]="!d.rows.length" emptyText="Nenhum cliente com parcelas vencidas." emptyIcon="badge-check" />
      </div>
      <p style="font-size:11px;color:#647687;margin-top:8px">Regras de juros, multa, carência e limite de crédito são definidas em Configurações → Crediário. A baixa calcula os encargos automaticamente; dispensa ou desconto exige permissão de renegociação e fica auditado.</p>
    }
  </div>
  <ax-renegotiation [customer]="reneg()" (closed)="reneg.set(null)" (done)="load()" />`,
})
export class CrediarioPage implements OnInit {
  readonly api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly tabs = FIN_TABS; readonly d = signal<any>(null); readonly reneg = signal<any>(null);
  readonly rules = computed(() => this.auth.me()?.settings?.crediario ?? {});
  ngOnInit() { this.load(); }
  async load() { try { this.d.set(await this.api.get('/reports/delinquency')); } catch (e) { this.toast.error(e); this.d.set({ rows: [], totals: {} }); } }
  async chargeAll() {
    const rows = this.d().rows; if (!confirm(`Enfileirar mensagem de cobrança para ${rows.length} cliente(s)? Apenas clientes com consentimento de WhatsApp receberão.`)) return;
    try { const r: any = await this.api.post('/messages/bulk', { customerIds: rows.map((x: any) => x.id), purpose: 'cobranca', refId: 'cobranca:' + todayIso(),
        body: 'Olá {nome}! Consta parcela em atraso no seu crediário. Se já pagou, desconsidere; caso contrário, fale com a gente para regularizar.' });
      this.toast.success('Resultado: ' + Object.entries(r).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')); } catch (e) { this.toast.error(e); }
  }
}

// ─── Carnê ─────────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-carne',
  imports: [IconComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="no-print" style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px">
    <div style="flex:1"><h1 style="font-size:16px;font-weight:700">Carnê de pagamento</h1><p style="font-size:12px;color:#647687">{{ venda() ? 'Venda' : 'Renegociação' }} · {{ d()?.titles?.length ?? 0 }} parcela(s) · documento sem valor fiscal</p></div>
    <button class="btn-secondary" style="font-size:12px" (click)="history.back()"><ax-icon name="arrow-left" [size]="13" /> Voltar</button>
    <button class="btn-primary" style="font-size:12px" [disabled]="!d()" (click)="print()"><ax-icon name="printer" [size]="13" /> Imprimir</button>
  </div>
  <ax-state [loading]="!d() && !err()" [error]="err()" />
  @if (d(); as d) {
    <div style="padding:20px;display:flex;flex-direction:column;gap:10px;max-width:880px;margin:0 auto" class="carne">
      @for (t of d.titles; track t.id) {
        <div style="display:grid;grid-template-columns:200px 1fr;border:1px dashed #A0AFBF;background:white;border-radius:4px;page-break-inside:avoid;font-size:12px">
          <div style="padding:10px;border-right:1px dashed #A0AFBF">
            <div style="font-weight:700">{{ d.company.trade_name || d.company.name }}</div><div class="muted" style="font-size:10px">Via da loja</div>
            <div style="margin-top:6px">Parcela <b>{{ t.installment_no }}/{{ t.installments_total }}</b></div><div>Venc.: <b>{{ t.due_date | dt }}</b></div><div>Valor: <b>{{ t.amount | brl }}</b></div>
            <div style="font-size:10px;margin-top:4px">{{ d.customer.name }}</div><div class="mono" style="font-size:10px">{{ t.document }}</div>
          </div>
          <div style="padding:10px">
            <div style="display:flex;justify-content:space-between"><div><div style="font-weight:700;font-size:13px">{{ d.company.trade_name || d.company.name }}</div><div style="font-size:10px">CNPJ {{ d.company.cnpj | doc }} · {{ d.company.branch }} @if (d.company.phone) { · {{ d.company.phone | phone }} }</div></div>
              <div style="text-align:right"><div style="font-size:10px" class="muted">Vencimento</div><div style="font-size:16px;font-weight:700">{{ t.due_date | dt }}</div></div></div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px">
              <div><div class="muted" style="font-size:10px">Cliente</div>{{ d.customer.name }} @if (d.customer.cpf_cnpj) { <div style="font-size:10px">{{ d.customer.cpf_cnpj | doc }}</div> }</div>
              <div><div class="muted" style="font-size:10px">Documento / parcela</div><span class="mono">{{ t.document }}</span> · {{ t.installment_no }}/{{ t.installments_total }}</div>
              <div style="text-align:right"><div class="muted" style="font-size:10px">Valor da parcela</div><div style="font-size:16px;font-weight:700">{{ t.amount | brl }}</div></div>
            </div>
            <div style="font-size:10px;color:#647687;margin-top:8px">Após o vencimento: multa de {{ d.rules.multaPct }}% e juros de {{ d.rules.jurosMensalPct }}% ao mês, pro rata die. Pague na loja (dinheiro, PIX ou cartão). @if (t.status !== 'aberto') { <b>Situação atual: {{ t.status }}</b> }</div>
          </div>
        </div>
      }
    </div>
  }`,
})
export class CarnePage implements OnInit {
  private api = inject(Api);
  readonly venda = input<string>(); readonly renegociacao = input<string>();
  readonly d = signal<any>(null); readonly err = signal<string | null>(null); readonly history = history;
  async ngOnInit() { if (!this.venda() && !this.renegociacao()) { this.err.set('Abra o carnê a partir de uma venda no crediário ou de uma renegociação.'); return; } try { this.d.set(await this.api.get('/receivables-carne', { sale: this.venda() || undefined, renegotiation: this.renegociacao() || undefined })); } catch (e: any) { this.err.set(e.message); } }
  print() { window.print(); }
}

// ─── Fluxo de caixa e movimentos ───────────────────────────────────────────
@Component({
  selector: 'ax-fluxo-caixa',
  imports: [FormsModule, IconComponent, StateComponent, PagerComponent, ModalComponent, ModuleTabsComponent, ...CHARTS, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:16px;display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Fluxo de Caixa</h1><p style="font-size:12px;color:#647687">Realizado (movimentos) até hoje + previsto (títulos em aberto por vencimento) · saldo inicial {{ cf()?.opening | brl }}</p></div>
      <div><label class="field-label">De</label><input type="date" class="input-field" [(ngModel)]="from" (change)="load()" /></div>
      <div><label class="field-label">Até</label><input type="date" class="input-field" [(ngModel)]="to" (change)="load()" /></div>
      <div><label class="field-label">Agrupar</label><select class="input-field" [(ngModel)]="group" (ngModelChange)="load()"><option value="day">Dia</option><option value="week">Semana</option><option value="month">Mês</option></select></div>
    </div>
    <div class="card" style="padding:16px;margin-bottom:16px">
      <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:12px">Entradas × Saídas × Saldo</div>
      @if (cf()) { <ax-bar-chart [labels]="labels()" [series]="series()" [height]="240" [legend]="true" [fmt]="fmt" /> } @else { <ax-state [loading]="true" /> }
    </div>
    <div class="card" style="overflow:hidden;margin-bottom:16px">
      <table class="data-table" style="width:100%;border-collapse:collapse">
        <thead><tr><th>Período</th><th class="num">Entradas realizadas</th><th class="num">Saídas realizadas</th><th class="num">Entradas previstas</th><th class="num">Saídas previstas</th><th class="num">Saldo projetado</th><th>Alerta</th></tr></thead>
        <tbody>@for (f of cf()?.series ?? []; track f.period) { <tr><td class="mono" style="font-size:12px">{{ f.period | dt }}</td><td class="num" style="color:#18864B">{{ f.inflow | brl }}</td><td class="num" style="color:#C93636">{{ f.outflow | brl }}</td>
          <td class="num" style="color:#18864B;opacity:.75">{{ f.projected_in | brl }}</td><td class="num" style="color:#C93636;opacity:.75">{{ f.projected_out | brl }}</td>
          <td class="num" style="font-weight:700" [style.color]="f.balance < 0 ? '#C93636' : '#18864B'">{{ f.balance | brl }}</td><td>@if (f.balance < 0) { <span class="badge badge-danger">Risco caixa</span> } @else { <span class="badge badge-success">OK</span> }</td></tr> }</tbody>
      </table>
    </div>
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;display:flex;align-items:center;gap:8px"><div style="flex:1;font-size:13px;font-weight:600">Movimentos financeiros</div>
        <select class="input-field" style="width:180px;font-size:12px" [(ngModel)]="account" (ngModelChange)="loadTx()"><option value="">Todas as contas</option>@for (a of lk.data()?.accounts ?? []; track a.id) { <option [value]="a.id">{{ a.name }}</option> }</select>
        @if (auth.can('financeiro.editar')) { <button class="btn-secondary" style="font-size:12px" (click)="openTx()"><ax-icon name="plus" [size]="12" /> Lançamento</button><button class="btn-secondary" style="font-size:12px" (click)="openTr()"><ax-icon name="arrow-left-right" [size]="12" /> Transferência</button> }</div>
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data</th><th>Conta</th><th>Descrição</th><th>Categoria</th><th>Origem</th><th class="num">Valor</th><th>Conc.</th></tr></thead>
        <tbody>@for (t of tx.items(); track t.id) { <tr><td class="mono" style="font-size:12px">{{ t.date | dt }}</td><td style="font-size:12px">{{ t.account }}</td><td style="font-size:12px">{{ t.description }}</td><td style="font-size:12px">{{ t.category || '—' }}</td><td style="font-size:11px;color:#647687">{{ t.source_type }}</td>
          <td class="num" style="font-weight:600" [style.color]="t.direction === 'entrada' ? '#18864B' : '#C93636'">{{ t.direction === 'entrada' ? '+' : '−' }}{{ t.amount | brl }}</td><td>@if (t.reconciled) { <ax-icon name="check" [size]="13" color="#18864B" /> }</td></tr> }</tbody></table>
      <ax-pager [page]="tx.page()" [pages]="tx.pages()" [total]="tx.total()" (go)="tx.load($event)" />
    </div>
  </div>
  <ax-modal [(open)]="txOpen" title="Lançamento manual" icon="plus" [width]="480">
    <div class="form-grid-2">
      <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="m.direction"><option value="entrada">Entrada</option><option value="saida">Saída</option></select></div>
      <div><label class="field-label">Data</label><input type="date" class="input-field" [(ngModel)]="m.date" /></div>
      <div class="span-all"><label class="field-label">Conta *</label><select class="input-field" [(ngModel)]="m.accountId">@for (a of lk.data()?.accounts ?? []; track a.id) { <option [value]="a.id">{{ a.name }}</option> }</select></div>
      <div><label class="field-label">Valor *</label><input type="number" min="0.01" step="0.01" class="input-field mono" [(ngModel)]="m.amount" /></div>
      <div><label class="field-label">Categoria</label><select class="input-field" [(ngModel)]="m.categoryId"><option value="">—</option>@for (c of cats(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }</select></div>
      <div class="span-all"><label class="field-label">Descrição *</label><input class="input-field" [(ngModel)]="m.description" /></div>
    </div>
    <p style="font-size:11px;color:#647687;margin-top:8px">Use para tarifas, rendimentos e ajustes. Lançamentos manuais ficam registrados na auditoria.</p>
    <div footer><button class="btn-secondary" (click)="txOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!m.accountId || !(m.amount > 0) || (m.description || '').length < 3" (click)="saveTx()">Lançar</button></div>
  </ax-modal>
  <ax-modal [(open)]="trOpen" title="Transferência entre contas" icon="arrow-left-right" [width]="460">
    <div class="form-grid-2">
      <div><label class="field-label">De *</label><select class="input-field" [(ngModel)]="tr.fromAccountId">@for (a of lk.data()?.accounts ?? []; track a.id) { <option [value]="a.id">{{ a.name }}</option> }</select></div>
      <div><label class="field-label">Para *</label><select class="input-field" [(ngModel)]="tr.toAccountId">@for (a of lk.data()?.accounts ?? []; track a.id) { <option [value]="a.id">{{ a.name }}</option> }</select></div>
      <div><label class="field-label">Valor *</label><input type="number" min="0.01" step="0.01" class="input-field mono" [(ngModel)]="tr.amount" /></div>
      <div><label class="field-label">Data</label><input type="date" class="input-field" [(ngModel)]="tr.date" /></div>
      <div class="span-all"><label class="field-label">Descrição</label><input class="input-field" [(ngModel)]="tr.description" placeholder="Ex.: sangria do caixa para o banco" /></div>
    </div>
    <div footer><button class="btn-secondary" (click)="trOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!(tr.amount > 0) || tr.fromAccountId === tr.toAccountId" (click)="saveTr()">Transferir</button></div>
  </ax-modal>`,
})
export class FluxoCaixaPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tabs = FIN_TABS; readonly fmt = brlFmt;
  readonly cf = signal<any>(null); from = addDaysIso(todayIso(), -28); to = addDaysIso(todayIso(), 56); group = 'week'; account = '';
  readonly tx = new ListState<any>((q) => this.api.get('/transactions', q));
  readonly txOpen = signal(false); readonly trOpen = signal(false); m: any = {}; tr: any = {};
  readonly cats = computed(() => (this.lk.data()?.finCategories ?? []).filter((c) => (this.m.direction === 'entrada' ? c.type === 'receita' : c.type === 'despesa')));
  readonly labels = computed(() => (this.cf()?.series ?? []).map((s: any) => dateBr(s.period).slice(0, this.group === 'month' ? 10 : 5)));
  readonly series = computed<Series[]>(() => { const s = this.cf()?.series ?? []; return [
    { name: 'Entradas', color: '#18864B', values: s.map((x: any) => Number(x.inflow) + Number(x.projected_in)) },
    { name: 'Saídas', color: '#C93636', values: s.map((x: any) => Number(x.outflow) + Number(x.projected_out)) },
    { name: 'Saldo', color: '#0875D1', values: s.map((x: any) => Number(x.balance)) }]; });
  ngOnInit() { this.lk.ensure(); this.load(); this.loadTx(); }
  async load() { try { this.cf.set(await this.api.get('/cashflow', { from: this.from, to: this.to, group: this.group })); } catch (e) { this.toast.error(e); } }
  loadTx() { this.tx.query = { account: this.account || undefined }; this.tx.load(1); }
  openTx() { this.m = { direction: 'saida', date: todayIso(), accountId: this.lk.data()?.accounts?.[0]?.id ?? '', amount: null, categoryId: '', description: '' }; this.txOpen.set(true); }
  openTr() { const a = this.lk.data()?.accounts ?? []; this.tr = { fromAccountId: a[0]?.id, toAccountId: a[1]?.id ?? a[0]?.id, amount: null, date: todayIso(), description: '' }; this.trOpen.set(true); }
  async saveTx() { try { await this.api.post('/transactions', { ...this.m, amount: +this.m.amount, categoryId: this.m.categoryId || undefined }); this.txOpen.set(false); this.toast.success('Lançado.'); this.load(); this.loadTx(); } catch (e) { this.toast.error(e); } }
  async saveTr() { try { await this.api.post('/transactions/transfer', { ...this.tr, amount: +this.tr.amount, description: this.tr.description || undefined }); this.trOpen.set(false); this.toast.success('Transferência registrada.'); this.loadTx(); } catch (e) { this.toast.error(e); } }
}

// ─── Conciliação bancária ──────────────────────────────────────────────────
@Component({
  selector: 'ax-conciliacao',
  imports: [FormsModule, IconComponent, StateComponent, ModuleTabsComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Conciliação Bancária</h1><p style="font-size:12px;color:#647687">{{ accName() }} · últimos 60 dias · {{ d()?.summary?.unmatched ?? 0 }} lançamento(s) do extrato sem correspondência</p></div>
      <select class="input-field" style="width:220px" [(ngModel)]="accountId" (ngModelChange)="load()">@for (a of banks(); track a.id) { <option [value]="a.id">{{ a.name }}</option> }</select>
      <label class="btn-primary" style="font-size:12px;cursor:pointer"><ax-icon name="upload" [size]="13" /> Importar extrato (OFX/CSV)<input type="file" accept=".ofx,.csv,.txt" style="display:none" (change)="importFile($event)" /></label>
    </div>
    <ax-module-tabs [tabs]="tabs" />
    @if (!banks().length) { <div class="state-info" style="margin:20px"><ax-icon name="info" [size]="14" />Cadastre uma conta bancária em Configurações → Financeiro para conciliar.</div> }
    <div style="flex:1;display:grid;grid-template-columns:1fr auto 1fr;gap:0;overflow:hidden">
      <div style="display:flex;flex-direction:column;border-right:1px solid #DCE4EC;overflow:hidden">
        <div style="padding:10px 16px;background:#F4F7FA;border-bottom:1px solid #DCE4EC"><div style="font-size:12px;font-weight:700;color:#172B3A">Movimentos Bancários (extrato)</div>
          <div style="font-size:11px;color:#647687">{{ d()?.lines?.length ?? 0 }} movimentos · {{ d()?.summary?.statement_total | brl }}</div></div>
        <div style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px">
          @for (l of d()?.lines ?? []; track l.id) {
            <div (click)="!l.matched_transaction_id && line.set(l)" [style.border]="l.matched_transaction_id ? '1.5px solid #18864B' : line()?.id === l.id ? '1.5px solid #0875D1' : '1px solid #DCE4EC'" [style.background]="l.matched_transaction_id ? '#F0FBF4' : 'white'" style="padding:8px 12px;border-radius:7px;cursor:pointer">
              <div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="font-size:11px;color:#647687">{{ l.date | dt }}</span>
                <span class="mono" [style.color]="l.amount >= 0 ? '#18864B' : '#C93636'" style="font-size:12px;font-weight:700">{{ l.amount >= 0 ? '+' : '−' }}{{ abs(l.amount) | brl }}</span></div>
              <div style="font-size:11px;color:#172B3A">{{ l.description }}</div>
              @if (l.matched_transaction_id) { <div style="font-size:10px;color:#18864B;display:flex;justify-content:space-between">↔ {{ l.matched_description }} <a class="link" (click)="$event.stopPropagation(); unmatch(l)">desfazer</a></div> }
            </div>
          } @empty { <div class="empty-state">Importe o arquivo OFX ou CSV (data;descrição;valor) exportado do internet banking.</div> }
        </div>
      </div>
      <div style="width:60px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#F4F7FA;border-right:1px solid #DCE4EC;gap:16px;padding:8px">
        <div title="Selecione um lançamento do extrato e um do ERP" [style.background]="line() && txSel() ? '#18864B' : '#DCE4EC'" [style.color]="line() && txSel() ? 'white' : '#A0AFBF'" style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px" (click)="match()">↔</div>
        @if (line() && !txSel() && auth.can('financeiro.editar')) { <button class="btn-ghost" style="font-size:10px;padding:2px;text-align:center" (click)="createFromLine()" title="Criar lançamento a partir do extrato (ex.: tarifa)">criar</button> }
      </div>
      <div style="display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:10px 16px;background:#F4F7FA;border-bottom:1px solid #DCE4EC"><div style="font-size:12px;font-weight:700;color:#172B3A">Lançamentos do ERP não conciliados</div><div style="font-size:11px;color:#647687">{{ d()?.pending?.length ?? 0 }} lançamentos</div></div>
        <div style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px">
          @for (t of pendingSorted(); track t.id) {
            <div (click)="txSel.set(txSel()?.id === t.id ? null : t)" [style.border]="txSel()?.id === t.id ? '1.5px solid #0875D1' : '1px solid #DCE4EC'" [style.background]="suggested(t) ? '#F5FAFF' : 'white'" style="padding:8px 12px;border-radius:7px;cursor:pointer">
              <div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="font-size:11px;color:#647687">{{ t.date | dt }} @if (suggested(t)) { · <b style="color:#0875D1">valor igual</b> }</span>
                <span class="mono" [style.color]="t.direction === 'entrada' ? '#18864B' : '#C93636'" style="font-size:12px;font-weight:700">{{ t.direction === 'entrada' ? '+' : '−' }}{{ t.amount | brl }}</span></div>
              <div style="font-size:11px;color:#172B3A">{{ t.description }}</div>
            </div>
          } @empty { <div class="empty-state">Nenhum lançamento pendente.</div> }
        </div>
      </div>
    </div>
  </div>`,
})
export class ConciliacaoPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tabs = FIN_TABS; readonly d = signal<any>(null); readonly line = signal<any>(null); readonly txSel = signal<any>(null); accountId = '';
  readonly banks = computed(() => (this.lk.data()?.accounts ?? []).filter((a) => a.type !== 'caixa'));
  readonly accName = computed(() => { this.d(); return this.banks().find((a) => a.id === this.accountId)?.name ?? '—'; });
  readonly pendingSorted = computed(() => { const l = this.line(); const p = [...(this.d()?.pending ?? [])]; return l ? p.sort((a, b) => Number(this.suggested(b)) - Number(this.suggested(a))) : p; });
  abs = Math.abs;
  async ngOnInit() { await this.lk.ensure(); this.accountId = (this.banks().find((a) => a.type === 'banco') ?? this.banks()[0])?.id ?? ''; this.load(); }
  suggested(t: any) { const l = this.line(); return !!l && Math.abs(Number(l.amount)) === Number(t.amount) && (Number(l.amount) >= 0) === (t.direction === 'entrada'); }
  async load() { if (!this.accountId) return; this.line.set(null); this.txSel.set(null); try { this.d.set(await this.api.get('/reconciliation/' + this.accountId)); } catch (e) { this.toast.error(e); } }
  async importFile(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0]; (ev.target as HTMLInputElement).value = ''; if (!f) return;
    try { const r: any = await this.api.raw(`/reconciliation/${this.accountId}/import`, await f.text(), 'text/plain'); this.toast.success(`${r.imported} lançamento(s) importado(s), ${r.duplicates} já existente(s), ${r.autoMatched} conciliado(s) automaticamente.`); this.load(); }
    catch (e) { this.toast.error(e); }
  }
  async match() { if (!this.line() || !this.txSel()) return; try { await this.api.post('/reconciliation/match', { lineId: this.line().id, transactionId: this.txSel().id }); this.load(); } catch (e) { this.toast.error(e); } }
  async createFromLine() { try { await this.api.post('/reconciliation/match', { lineId: this.line().id, createTransaction: { description: this.line().description } }); this.toast.success('Lançamento criado e conciliado.'); this.load(); } catch (e) { this.toast.error(e); } }
  async unmatch(l: any) { try { await this.api.post('/reconciliation/unmatch', { lineId: l.id }); this.load(); } catch (e) { this.toast.error(e); } }
}
