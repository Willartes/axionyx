import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, model, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { IconComponent } from './icon.component';
import { Api, Paged } from '../core/api.service';
import { BrlPipe, DocPipe } from '../core/format';
import { LookupsService } from '../core/lookups.service';

/** Estado de lista paginada com carregamento/erro. */
export class ListState<T = any> {
  readonly items = signal<T[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pages = signal(1);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly extra = signal<any>(null);
  query: Record<string, any> = {};
  private seq = 0;
  constructor(private fetcher: (q: Record<string, any>) => Promise<Paged<T>>) {}
  async load(page = 1) {
    const my = ++this.seq;
    this.loading.set(true); this.error.set(null);
    try {
      const r = await this.fetcher({ ...this.query, page });
      if (my !== this.seq) return;
      this.items.set(r.items); this.total.set(r.total); this.page.set(r.page); this.pages.set(r.pages);
      const { items, total, page: _p, size, pages, ...rest } = r as any;
      this.extra.set(rest);
    } catch (e: any) { if (my === this.seq) this.error.set(e?.message || 'Falha ao carregar.'); }
    finally { if (my === this.seq) this.loading.set(false); }
  }
  reload() { return this.load(this.page()); }
}

/** Carregador simples para objetos. */
export class Loader<T = any> {
  readonly data = signal<T | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  constructor(private fn: () => Promise<T>) {}
  async load() {
    this.loading.set(true); this.error.set(null);
    try { this.data.set(await this.fn()); } catch (e: any) { this.error.set(e?.message || 'Falha ao carregar.'); }
    finally { this.loading.set(false); }
  }
}

@Component({
  selector: 'ax-pager',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="pager">
    <span style="font-size:12px;color:#647687">{{ total() === 0 ? 'Nenhum registro' : 'Página ' + page() + ' de ' + pages() + ' · ' + total().toLocaleString('pt-BR') + ' registro(s)' }}</span>
    <div style="display:flex;gap:4px">
      <button [disabled]="page() <= 1" (click)="go.emit(page() - 1)" aria-label="Anterior"><ax-icon name="chevron-left" [size]="13" /></button>
      @for (p of nums(); track $index) {
        @if (p === 0) { <span style="padding:0 4px;color:#A0AFBF">…</span> } @else { <button [class.active]="p === page()" (click)="go.emit(p)">{{ p }}</button> }
      }
      <button [disabled]="page() >= pages()" (click)="go.emit(page() + 1)" aria-label="Próxima"><ax-icon name="chevron-right" [size]="13" /></button>
    </div>
  </div>`,
})
export class PagerComponent {
  readonly page = input(1); readonly pages = input(1); readonly total = input(0);
  readonly go = output<number>();
  readonly nums = computed(() => {
    const p = this.page(), n = this.pages(); const set = new Set([1, n, p - 1, p, p + 1].filter((x) => x >= 1 && x <= n));
    const arr = [...set].sort((a, b) => a - b); const out: number[] = [];
    arr.forEach((x, i) => { if (i && x - arr[i - 1] > 1) out.push(0); out.push(x); });
    return out;
  });
}

@Component({
  selector: 'ax-modal',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (open()) {
    <div class="modal-backdrop" (mousedown)="backdrop($event)">
      <div class="modal fade-in" [style.max-width.px]="width()" role="dialog" aria-modal="true" (mousedown)="$event.stopPropagation()">
        <div class="modal-header">
          @if (icon()) { <ax-icon [name]="icon()!" [size]="16" color="#0875D1" /> }
          <h3>{{ title() }}</h3>
          <button class="btn-ghost" style="padding:4px 6px" (click)="close()" aria-label="Fechar"><ax-icon name="x" [size]="15" /></button>
        </div>
        <div class="modal-body"><ng-content /></div>
        <div class="modal-footer"><ng-content select="[footer]" /></div>
      </div>
    </div>
  }`,
})
export class ModalComponent {
  readonly open = model(false);
  readonly title = input('');
  readonly icon = input<string | null>(null);
  readonly width = input(560);
  readonly dismissable = input(true);
  readonly closed = output<void>();
  close() { this.open.set(false); this.closed.emit(); }
  backdrop(e: MouseEvent) { if (this.dismissable() && e.target === e.currentTarget) this.close(); }
}

@Component({
  selector: 'ax-state',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (loading()) {
    <div style="padding:24px;display:flex;flex-direction:column;gap:10px">
      @for (i of [1,2,3,4]; track i) { <div class="skeleton" style="height:14px" [style.width.%]="100 - i * 12"></div> }
    </div>
  } @else if (error()) {
    <div class="state-error" role="alert"><ax-icon name="alert-triangle" [size]="15" /><div style="flex:1">{{ error() }}</div>
      @if (retry) { <button class="btn-ghost" style="font-size:12px;padding:2px 8px;color:#C93636" (click)="retry.emit()">Tentar novamente</button> }</div>
  } @else if (empty()) {
    <div class="empty-state"><ax-icon [name]="emptyIcon()" [size]="28" color="#A0AFBF" /><div style="margin-top:8px">{{ emptyText() }}</div></div>
  }`,
})
export class StateComponent {
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly empty = input(false);
  readonly emptyText = input('Nenhum registro encontrado.');
  readonly emptyIcon = input('inbox');
  readonly retry = output<void>();
}

/** Busca de clientes com autocompletar. */
@Component({
  selector: 'ax-customer-picker',
  imports: [FormsModule, IconComponent, DocPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="autocomplete">
    @if (value(); as c) {
      <div class="input-field" style="display:flex;align-items:center;gap:8px;min-height:34px">
        <ax-icon name="user" [size]="14" color="#0875D1" />
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>{{ c.name }}</b> @if (c.cpf_cnpj) { <span class="muted"> · {{ c.cpf_cnpj | doc }}</span> }</span>
        @if (!disabled()) { <button class="btn-ghost" style="padding:2px 4px" (click)="clear()" aria-label="Remover cliente"><ax-icon name="x" [size]="13" /></button> }
      </div>
    } @else {
      <div style="position:relative">
        <ax-icon name="search" [size]="14" color="#A0AFBF" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" />
        <input class="input-field" style="padding-left:32px" [placeholder]="placeholder()" [ngModel]="q()" (ngModelChange)="search($event)" (focus)="open.set(true)" (blur)="blur()" [disabled]="disabled()" />
      </div>
      @if (open() && (results().length || q().length >= 2)) {
        <div class="autocomplete-list">
          @for (c of results(); track c.id) {
            <div class="autocomplete-item" (mousedown)="pick(c)">
              <div style="font-weight:500">{{ c.name }}</div>
              <div style="font-size:11px;color:#647687">{{ c.cpf_cnpj ? (c.cpf_cnpj | doc) : 'sem documento' }} · cód. {{ c.code }} @if (c.open_balance > 0) { · <span style="color:#D99000">em aberto</span> }</div>
            </div>
          } @empty { @if (!busy()) { <div class="autocomplete-item muted">Nenhum cliente encontrado.</div> } }
          @if (busy()) { <div class="autocomplete-item muted"><span class="spinner" style="width:12px;height:12px"></span> Buscando...</div> }
        </div>
      }
    }
  </div>`,
})
export class CustomerPickerComponent {
  private api = inject(Api);
  readonly value = model<any | null>(null);
  readonly placeholder = input('Buscar cliente por nome, CPF, telefone...');
  readonly disabled = input(false);
  readonly partner = input<boolean | null>(null);
  readonly q = signal(''); readonly results = signal<any[]>([]); readonly open = signal(false); readonly busy = signal(false);
  private t: any;
  search(v: string) {
    this.q.set(v); clearTimeout(this.t);
    if (v.trim().length < 2) { this.results.set([]); return; }
    this.t = setTimeout(async () => {
      this.busy.set(true);
      try { const r = await this.api.get<Paged<any>>('/customers', { q: v, size: 8, active: 'true', partner: this.partner() ?? undefined }); this.results.set(r.items); }
      catch { this.results.set([]); } finally { this.busy.set(false); }
    }, 250);
  }
  pick(c: any) { this.value.set(c); this.q.set(''); this.results.set([]); this.open.set(false); }
  clear() { this.value.set(null); }
  blur() { setTimeout(() => this.open.set(false), 150); }
}

/** Campo de bipagem/busca de produtos (código de barras, SKU ou nome) respeitando variações e saldo. */
@Component({
  selector: 'ax-variant-picker',
  imports: [FormsModule, IconComponent, BrlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="autocomplete">
    <div style="position:relative">
      <ax-icon name="scan-barcode" [size]="16" color="#0875D1" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" />
      <input #inp class="input-field" [style.padding-left.px]="34" [style.font-size.px]="big() ? 15 : 13" [style.height.px]="big() ? 42 : 34" [placeholder]="placeholder()"
        [ngModel]="q()" (ngModelChange)="type($event)" (keydown)="key($event)" (blur)="blur()" autocomplete="off" />
      @if (busy()) { <span class="spinner" style="position:absolute;right:12px;top:50%;margin-top:-8px"></span> }
    </div>
    @if (results().length) {
      <div class="autocomplete-list">
        @for (v of results(); track v.id; let i = $index) {
          <div class="autocomplete-item" [class.active]="i === active()" (mousedown)="pick(v)">
            <div style="display:flex;justify-content:space-between;gap:8px">
              <span style="font-weight:500">{{ v.name }}</span><span class="mono" style="font-size:12px">{{ v.price | brl }}</span>
            </div>
            <div style="font-size:11px;color:#647687;display:flex;gap:8px;align-items:center">
              <span class="mono">{{ v.sku }}</span>
              @if (v.color) { <span style="display:inline-flex;align-items:center;gap:3px"><span [style.background]="v.color_hex || '#ccc'" style="width:8px;height:8px;border-radius:50%;border:1px solid #DCE4EC"></span>{{ v.color }}</span> }
              @if (v.size) { <span class="badge badge-muted" style="padding:0 5px">{{ v.size }}</span> }
              <span [style.color]="v.stock > 0 ? '#18864B' : '#C93636'">Estoque: {{ v.stock }}</span>
            </div>
          </div>
        }
      </div>
    }
    @if (message()) { <div class="field-error">{{ message() }}</div> }
  </div>`,
})
export class VariantPickerComponent {
  private api = inject(Api);
  readonly placeholder = input('Bipe o código de barras ou busque por nome/SKU (Enter)');
  readonly big = input(false);
  readonly branch = input<string | null>(null);
  readonly selected = output<any>();
  readonly inp = viewChild<ElementRef<HTMLInputElement>>('inp');
  readonly q = signal(''); readonly results = signal<any[]>([]); readonly busy = signal(false); readonly active = signal(0); readonly message = signal('');
  private t: any;
  focus() { this.inp()?.nativeElement.focus(); }
  type(v: string) {
    this.q.set(v); this.message.set(''); clearTimeout(this.t);
    if (v.trim().length >= 3 && !/^\d{8,14}$/.test(v.trim())) this.t = setTimeout(() => this.search(false), 300);
    else this.results.set([]);
  }
  async search(enter: boolean) {
    const q = this.q().trim(); if (!q) return;
    this.busy.set(true);
    try {
      const r = await this.api.get<any[]>('/variants/search', { q, branch: this.branch() ?? undefined });
      if (enter && r.length === 1 && r[0].exact) { this.pick(r[0]); return; }
      if (enter && !r.length) this.message.set('Nenhum produto encontrado para "' + q + '".');
      this.results.set(r); this.active.set(0);
    } catch (e: any) { this.message.set(e.message); } finally { this.busy.set(false); }
  }
  key(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); if (this.results().length && this.results()[this.active()] && !/^\d{8,14}$/.test(this.q())) this.pick(this.results()[this.active()]); else this.search(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.active.update((a) => Math.min(a + 1, this.results().length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.active.update((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Escape') this.results.set([]);
  }
  pick(v: any) {
    if (!v.active) { this.message.set(`${v.sku} está inativo.`); return; }
    this.selected.emit(v); this.q.set(''); this.results.set([]); this.message.set(''); setTimeout(() => this.focus());
  }
  blur() { setTimeout(() => this.results.set([]), 200); }
}

/** Abas de navegação de módulo no padrão .tab-item */
@Component({
  selector: 'ax-module-tabs',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="tabs-bar no-print">@for (t of tabs(); track t.path) { <a class="tab-item" [routerLink]="t.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" style="text-decoration:none">{{ t.label }}</a> }</div>`,
})
export class ModuleTabsComponent {
  readonly tabs = input<{ path: string; label: string }[]>([]);
}


export interface PaymentRow { methodId: string; amount: number; installments: number; firstDueDate?: string; storeCreditCode?: string }
/** Editor de pagamentos (formas múltiplas) reaproveitado por condicional, consignação e baixas. */
@Component({
  selector: 'ax-payments-editor',
  imports: [FormsModule, IconComponent, BrlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;gap:6px">
    @for (p of rows(); track $index; let i = $index) {
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select class="input-field" style="flex:1;min-width:150px" [ngModel]="p.methodId" (ngModelChange)="set(i, 'methodId', $event)">
          @for (m of methods(); track m.id) { <option [value]="m.id">{{ m.name }}</option> }
        </select>
        <input type="number" min="0.01" step="0.01" class="input-field mono" style="width:110px;text-align:right" [ngModel]="p.amount" (ngModelChange)="set(i, 'amount', +$event)" aria-label="Valor" />
        @if ((method(p.methodId)?.max_installments ?? 1) > 1) {
          <select class="input-field" style="width:80px" [ngModel]="p.installments" (ngModelChange)="set(i, 'installments', +$event)" aria-label="Parcelas">
            @for (n of range(method(p.methodId).max_installments); track n) { <option [ngValue]="n">{{ n }}x</option> }
          </select>
        }
        @if (method(p.methodId)?.kind === 'crediario') { <input type="date" class="input-field" style="width:140px" [ngModel]="p.firstDueDate" (ngModelChange)="set(i, 'firstDueDate', $event)" title="1º vencimento" /> }
        @if (method(p.methodId)?.kind === 'vale_troca') { <input class="input-field mono" style="width:130px" placeholder="Código do vale" [ngModel]="p.storeCreditCode" (ngModelChange)="set(i, 'storeCreditCode', $event)" /> }
        <button class="btn-ghost" style="padding:4px" (click)="remove(i)" aria-label="Remover forma"><ax-icon name="x" [size]="13" /></button>
      </div>
    }
    <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
      <button class="btn-ghost" style="font-size:12px;padding:3px 6px" (click)="add()" [disabled]="remaining() <= 0.004"><ax-icon name="plus" [size]="12" /> Adicionar forma de pagamento</button>
      <span [style.color]="Math.abs(remaining()) < 0.005 ? '#18864B' : '#C93636'">@if (remaining() > 0.004) { Falta {{ remaining() | brl }} } @else if (remaining() < -0.004) { Excede {{ -remaining() | brl }} } @else { Pagamento completo }</span>
    </div>
  </div>`,
})
export class PaymentsEditorComponent {
  private lk = inject(LookupsService);
  readonly total = input(0);
  readonly rows = model<PaymentRow[]>([]);
  readonly Math = Math;
  readonly methods = computed(() => (this.lk.data()?.paymentMethods ?? []).filter((m) => m.kind !== 'cashback'));
  readonly remaining = computed(() => Math.round((this.total() - this.rows().reduce((s, r) => s + (+r.amount || 0), 0)) * 100) / 100);
  constructor() { this.lk.ensure(); }
  method(id: string): any { return this.methods().find((m) => m.id === id); }
  range(n: number) { return Array.from({ length: n }, (_, i) => i + 1); }
  add() { const m = this.methods()[0]; if (m) this.rows.update((l) => [...l, { methodId: m.id, amount: Math.max(0, this.remaining()), installments: 1 }]); }
  set(i: number, k: keyof PaymentRow, v: any) { this.rows.update((l) => l.map((r, j) => (j === i ? { ...r, [k]: v, ...(k === 'methodId' ? { installments: 1 } : {}) } : r))); }
  remove(i: number) { this.rows.update((l) => l.filter((_, j) => j !== i)); }
  /** Converte para o formato da API. */
  static toApi(rows: PaymentRow[]) { return rows.filter((r) => +r.amount > 0).map((r) => ({ methodId: r.methodId, amount: Math.round(+r.amount * 100) / 100, installments: r.installments > 1 ? r.installments : undefined, firstDueDate: r.firstDueDate || undefined, storeCreditCode: r.storeCreditCode?.trim().toUpperCase() || undefined })); }
}

export const UI = [PaymentsEditorComponent, PagerComponent, ModalComponent, StateComponent, CustomerPickerComponent, VariantPickerComponent, ModuleTabsComponent];
