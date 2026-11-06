import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CHARTS, Series } from '../../shared/charts';
import { BarcodeComponent } from '../../shared/barcode';
import { ListState, PagerComponent, StateComponent, ModalComponent, ModuleTabsComponent, VariantPickerComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, STATUS_PIPES, MOVEMENT_LABEL, brl, num, dateBr, todayIso, addDaysIso } from '../../core/format';

export const ESTOQUE_TABS = [
  { path: '/estoque', label: 'Dashboard' }, { path: '/estoque-posicao', label: 'Posição' }, { path: '/movimentacoes', label: 'Movimentações' },
  { path: '/transferencias', label: 'Transferências' }, { path: '/inventario', label: 'Inventário' }, { path: '/curva-abc', label: 'Curva ABC' }, { path: '/etiquetas', label: 'Etiquetas' },
];
const mLabel = (ym: string) => { const [y, m] = ym.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '').replace(/^\w/, (c) => c.toUpperCase()); };

// ─── Dashboard de estoque ───────────────────────────────────────────────────
@Component({
  selector: 'ax-estoque-dashboard',
  imports: [IconComponent, StateComponent, ModuleTabsComponent, ...CHARTS, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;flex-wrap:wrap;gap:10px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Dashboard de Estoque</h1>
        <p style="font-size:13px;color:#647687">{{ auth.me()?.user?.allBranches ? 'Todas as filiais' : auth.me()?.branch?.name }} · Atualizado às {{ at() }}</p></div>
      <div style="display:flex;gap:8px">
        <button class="btn-ghost" style="font-size:12px" (click)="router.navigateByUrl('/inventario')">Inventário</button>
        <button class="btn-secondary" style="font-size:12px" (click)="router.navigateByUrl('/estoque-posicao')">Posição atual</button>
        <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/curva-abc')">Curva ABC</button>
      </div>
    </div>
    <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
    @if (d(); as d) {
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;margin-bottom:20px">
        @for (k of kpis(); track k.label) {
          <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">{{ k.label }}</div>
            <div [style.color]="k.color" style="font-size:22px;font-weight:700">{{ k.value }}</div><div style="font-size:11px;color:#647687;margin-top:2px">{{ k.sub }}</div></div>
        }
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px">
        <div class="card" style="padding:16px">
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:4px">Movimentações — últimos 7 meses</div>
          <div style="font-size:11px;color:#647687;margin-bottom:12px">Peças · Entradas vs. Saídas</div>
          <ax-bar-chart [labels]="movLabels()" [series]="movSeries()" [height]="200" [legend]="true" />
        </div>
        <div class="card" style="padding:16px">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px"><ax-icon name="alert-triangle" [size]="14" color="#C93636" /><div style="font-size:13px;font-weight:600;color:#172B3A">Produtos Críticos</div></div>
          <div style="display:flex;flex-direction:column;gap:8px">
            @for (p of d.critical; track $index) {
              <div>
                <div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="font-size:12px;color:#172B3A">{{ p.name }} <span class="muted">{{ p.color }} {{ p.size }}</span></span>
                  <span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#C93636;font-weight:600">{{ p.qty }}/{{ p.min }}</span></div>
                <div style="height:4px;background:#F0F4F8;border-radius:2px"><div [style.width.%]="p.min ? (p.qty / p.min * 100 > 100 ? 100 : (p.qty < 0 ? 0 : p.qty / p.min * 100)) : 0" style="height:100%;background:#C93636;border-radius:2px"></div></div>
              </div>
            } @empty { <div class="empty-state" style="padding:20px">Nenhuma variação abaixo do mínimo.</div> }
          </div>
          <button class="btn-primary" style="width:100%;justify-content:center;font-size:12px;margin-top:14px" (click)="router.navigateByUrl('/estoque-inteligente')">Ver sugestões de reposição</button>
        </div>
      </div>
      <div class="card" style="padding:16px;margin-top:16px">
        <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:12px">Mapa de Calor — Peças vendidas por Produto × Mês</div>
        <div style="overflow-x:auto">
          <table style="border-collapse:collapse;font-size:11px">
            <thead><tr><th style="padding:6px 12px;text-align:left;color:#647687;font-weight:600;min-width:200px">Produto</th>@for (m of heatMonths(); track m) { <th style="padding:6px 8px;text-align:center;color:#647687;font-weight:600;width:60px">{{ m }}</th> }</tr></thead>
            <tbody>@for (row of heatRows(); track row.name) {
              <tr><td style="padding:6px 12px;font-size:12px;font-weight:500;color:#172B3A">{{ row.name }}</td>
                @for (v of row.vals; track $index) {
                  <td [style.background]="'rgba(8,117,209,' + (0.1 + (row.max ? v / row.max : 0) * 0.7) + ')'" [style.color]="row.max && v / row.max > 0.6 ? 'white' : '#172B3A'" [style.font-weight]="row.max && v / row.max > 0.7 ? 700 : 400"
                    style="padding:6px 8px;text-align:center;font-family:'JetBrains Mono',monospace;border-radius:3px">{{ v }}</td>
                }</tr>
            } @empty { <tr><td class="empty-state">Sem vendas no período.</td></tr> }</tbody>
          </table>
        </div>
      </div>
    }
  </div>`,
})
export class EstoqueDashboardPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService);
  readonly tabs = ESTOQUE_TABS;
  readonly d = signal<any>(null); readonly loading = signal(false); readonly error = signal<string | null>(null); readonly at = signal('—');
  ngOnInit() { this.load(); }
  async load() { this.loading.set(true); this.error.set(null); try { this.d.set(await this.api.get('/stock/dashboard')); this.at.set(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); } }
  readonly kpis = computed(() => {
    const k = this.d()?.kpis; if (!k) return [];
    return [
      { label: 'Valor total em estoque', value: k.value_cost !== null ? brl(k.value_cost) : brl(k.value_sale), sub: k.value_cost !== null ? `${brl(k.value_sale)} a preço de venda` : 'a preço de venda', color: '#0875D1' },
      { label: 'SKUs ativos', value: num(k.skus), sub: `${num(k.no_turnover)} com saldo e sem saída em 30 dias`, color: '#647687' },
      { label: 'Produtos críticos', value: num(k.critical), sub: `Abaixo do mínimo · ${num(k.zero)} zerados`, color: '#C93636' },
      { label: 'Giro (30 dias)', value: k.turnover_ratio !== null ? num(k.turnover_ratio, 2) + 'x' : '—', sub: `${num(k.sold_30d)} peças vendidas / ${num(k.pieces)} em estoque`, color: '#D99000' },
      { label: 'Cobertura média', value: k.coverage_days !== null ? num(k.coverage_days) + ' dias' : '—', sub: 'pelo ritmo de vendas dos últimos 30 dias', color: '#2878C7' },
      { label: 'Inventário pendente', value: num(k.inventories_open), sub: k.last_inventory ? 'Último fechado: ' + dateBr(k.last_inventory) : 'Nenhum inventário fechado', color: '#18864B' },
    ];
  });
  readonly movLabels = computed(() => (this.d()?.movements ?? []).map((m: any) => mLabel(m.month)));
  readonly movSeries = computed<Series[]>(() => { const m = this.d()?.movements ?? []; return [{ name: 'Entradas', color: '#0875D1', values: m.map((x: any) => x.inflow) }, { name: 'Saídas', color: '#00A6D6', values: m.map((x: any) => x.outflow) }]; });
  readonly heatMonths = computed(() => [...new Set((this.d()?.heatmap ?? []).map((h: any) => h.month))].map((m: any) => mLabel(m)));
  readonly heatRows = computed(() => {
    const by = new Map<string, number[]>();
    for (const h of this.d()?.heatmap ?? []) { if (!by.has(h.name)) by.set(h.name, []); by.get(h.name)!.push(h.qty); }
    return [...by.entries()].map(([name, vals]) => ({ name, vals, max: Math.max(...vals) }));
  });
}

// ─── Posição de estoque ─────────────────────────────────────────────────────
@Component({
  selector: 'ax-estoque-posicao',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModuleTabsComponent, ModalComponent, VariantPickerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header">
      <div style="flex:1"><h1>Posição Atual do Estoque</h1><p>Saldo por produto e variação (cor × tamanho) com filtros de moda</p></div>
      @if (auth.can('estoque.movimentar')) { <button class="btn-secondary" style="font-size:12px" (click)="openMov()"><ax-icon name="sliders-horizontal" [size]="13" /> Entrada / saída / ajuste</button> }
      <button class="btn-ghost" style="font-size:12px" (click)="exportCsv()"><ax-icon name="download" [size]="13" /> Exportar</button>
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="padding:10px 24px;background:white;border-bottom:1px solid #F0F4F8;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <div style="position:relative"><ax-icon name="search" [size]="14" color="#A0AFBF" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" />
        <input class="input-field" style="padding-left:32px;width:220px" placeholder="Produto, SKU ou código de barras" [(ngModel)]="f.q" (ngModelChange)="search()" /></div>
      @if (auth.me()?.user?.allBranches) { <select class="input-field" style="width:170px" [(ngModel)]="f.branch" (change)="apply()"><option value="current">Filial atual</option><option value="all">Todas as filiais</option>@for (b of lk.data()?.branches ?? []; track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select> }
      <select class="input-field" style="width:150px" [(ngModel)]="f.brand" (change)="apply()"><option value="">Marca</option>@for (x of lk.data()?.brands ?? []; track x.id) { <option [value]="x.id">{{ x.name }}</option> }</select>
      <select class="input-field" style="width:150px" [(ngModel)]="f.collection" (change)="apply()"><option value="">Coleção</option>@for (x of lk.data()?.collections ?? []; track x.id) { <option [value]="x.id">{{ x.name }}</option> }</select>
      <select class="input-field" style="width:150px" [(ngModel)]="f.category" (change)="apply()"><option value="">Categoria</option>@for (x of lk.data()?.categories ?? []; track x.id) { <option [value]="x.id">{{ x.name }}</option> }</select>
      <select class="input-field" style="width:120px" [(ngModel)]="f.size" (change)="apply()"><option value="">Tamanho</option>@for (x of sizeCodes(); track x) { <option [value]="x">{{ x }}</option> }</select>
      <select class="input-field" style="width:130px" [(ngModel)]="f.color" (change)="apply()"><option value="">Cor</option>@for (x of lk.data()?.colors ?? []; track x.id) { <option [value]="x.id">{{ x.name }}</option> }</select>
      <select class="input-field" style="width:150px" [(ngModel)]="f.status" (change)="apply()"><option value="">Situação</option><option value="normal">Normal</option><option value="baixo">Baixo</option><option value="critico">Zerado / negativo</option><option value="abaixo_minimo">No mínimo ou abaixo</option></select>
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>SKU</th><th>Descrição</th><th>Cor</th><th>Tam.</th><th>Marca</th><th>Coleção</th><th class="num">Estoque Atual</th><th class="num">Estoque Mínimo</th><th class="num">Preço</th>@if (auth.can('produtos.custo')) { <th class="num">Custo</th> }<th>Situação</th></tr></thead>
        <tbody>@for (r of list.items(); track r.variant_id) {
          <tr class="clickable" (click)="router.navigate(['/movimentacoes'], { queryParams: { variante: r.variant_id } })">
            <td class="mono" style="font-size:12px;color:#0875D1">{{ r.sku }}</td><td style="font-weight:500">{{ r.name }}</td><td style="font-size:12px">{{ r.color || '—' }}</td><td><span class="badge badge-muted">{{ r.size || '—' }}</span></td>
            <td style="font-size:12px">{{ r.brand || '—' }}</td><td style="font-size:12px">{{ r.collection || '—' }}</td>
            <td class="num" style="font-weight:700" [style.color]="r.qty <= 0 ? '#C93636' : r.qty <= r.min_stock ? '#D99000' : '#172B3A'">{{ r.qty | num }}</td><td class="num">{{ r.min_stock | num }}</td>
            <td class="num">{{ r.price | brl }}</td>@if (auth.can('produtos.custo')) { <td class="num" style="color:#647687">{{ r.cost | brl }}</td> }
            <td><span class="badge" [class]="r.qty <= 0 ? 'badge badge-danger' : r.qty <= r.min_stock ? 'badge badge-warning' : 'badge badge-success'">{{ r.qty <= 0 ? 'Crítico' : r.qty <= r.min_stock ? 'Baixo' : 'Normal' }}</span></td>
          </tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading() && !list.items().length" [error]="list.error()" [empty]="!list.loading() && !list.items().length" (retry)="list.reload()" />
    </div>
    @if (list.extra()?.totals; as t) {
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:12px 24px;background:#F4F7FA;border-top:1px solid #DCE4EC">
        <div class="kpi-card" style="padding:10px 14px"><div style="font-size:11px;color:#647687">SKUs no filtro</div><div style="font-size:18px;font-weight:700">{{ t.skus | num }}</div></div>
        <div class="kpi-card" style="padding:10px 14px"><div style="font-size:11px;color:#647687">Peças</div><div style="font-size:18px;font-weight:700">{{ t.pieces | num }}</div></div>
        <div class="kpi-card" style="padding:10px 14px"><div style="font-size:11px;color:#647687">{{ t.value_cost !== undefined ? 'Valor do estoque (custo)' : 'Valor (venda)' }}</div><div style="font-size:18px;font-weight:700;color:#18864B">{{ (t.value_cost ?? t.value_sale) | brl }}</div></div>
        <div class="kpi-card" style="padding:10px 14px"><div style="font-size:11px;color:#647687">Baixo / crítico</div><div style="font-size:18px;font-weight:700;color:#C93636">{{ t.low }} / {{ t.critical }}</div></div>
      </div>
    }
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="movOpen" title="Movimentação manual de estoque" icon="sliders-horizontal" [width]="640">
    <div class="form-grid" style="margin-bottom:10px">
      <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="mv.type"><option value="entrada">Entrada (soma)</option><option value="saida">Saída (subtrai)</option><option value="ajuste">Ajuste (define saldo)</option></select></div>
      <div><label class="field-label">Motivo *</label><input class="input-field" [(ngModel)]="mv.reason" placeholder="Ex.: avaria, brinde, correção" /></div>
    </div>
    <ax-variant-picker (selected)="addMv($event)" />
    <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:10px">
      <thead><tr><th>SKU</th><th>Produto</th><th class="num">Saldo</th><th class="num">{{ mv.type === 'ajuste' ? 'Novo saldo' : 'Quantidade' }}</th><th></th></tr></thead>
      <tbody>@for (i of mvItems(); track i.v.id) { <tr><td class="mono" style="font-size:12px">{{ i.v.sku }}</td><td>{{ i.v.name }} {{ i.v.color }} {{ i.v.size }}</td><td class="num">{{ i.v.stock }}</td>
        <td class="num"><input type="number" min="0" class="input-field mono" style="width:80px;padding:4px 6px;text-align:right" [(ngModel)]="i.qty" /></td><td><button class="btn-ghost" style="padding:2px" (click)="rmMv(i)"><ax-icon name="x" [size]="13" /></button></td></tr> }</tbody>
    </table>
    <div footer><button class="btn-secondary" (click)="movOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!mvItems().length || mv.reason.trim().length < 3" (click)="saveMv()">Registrar</button></div>
  </ax-modal>`,
})
export class EstoquePosicaoPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); readonly lk = inject(LookupsService); private toast = inject(ToastService);
  readonly tabs = ESTOQUE_TABS;
  readonly list = new ListState<any>((q) => this.api.get('/stock', q));
  readonly sizeCodes = computed(() => [...new Set((this.lk.data()?.sizes ?? []).map((s) => s.code))]);
  readonly movOpen = signal(false); readonly mvItems = signal<{ v: any; qty: number }[]>([]);
  f: any = { q: '', branch: 'current', brand: '', collection: '', category: '', size: '', color: '', status: '' }; mv = { type: 'entrada', reason: '' }; private t: any;
  ngOnInit() { this.lk.ensure(); this.apply(); }
  search() { clearTimeout(this.t); this.t = setTimeout(() => this.apply(), 300); }
  apply() { this.list.query = { ...this.f }; this.list.load(1); }
  exportCsv() {
    const rows = this.list.items(); if (!rows.length) return;
    const head = ['SKU', 'Produto', 'Cor', 'Tamanho', 'Marca', 'Coleção', 'Estoque', 'Mínimo', 'Preço'];
    const csv = '﻿' + head.join(';') + '\n' + rows.map((r) => [r.sku, r.name, r.color, r.size, r.brand, r.collection, r.qty, r.min_stock, r.price].map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'posicao-estoque.csv'; a.click();
  }
  openMov() { this.mvItems.set([]); this.mv = { type: 'entrada', reason: '' }; this.movOpen.set(true); }
  addMv(v: any) { if (!this.mvItems().find((i) => i.v.id === v.id)) this.mvItems.update((l) => [...l, { v, qty: 1 }]); }
  rmMv(i: any) { this.mvItems.update((l) => l.filter((x) => x !== i)); }
  async saveMv() {
    try { const r: any = await this.api.post('/stock/movements', { type: this.mv.type, reason: this.mv.reason, items: this.mvItems().map((i) => ({ variantId: i.v.id, qty: Math.max(0, Math.floor(+i.qty || 0)) })) }, { idempotent: true });
      this.toast.success(`${r.items.length} movimentação(ões) registrada(s).`); this.movOpen.set(false); this.list.reload(); }
    catch (e) { this.toast.error(e); }
  }
}

// ─── Movimentações ──────────────────────────────────────────────────────────
@Component({
  selector: 'ax-movimentacoes',
  imports: [FormsModule, PagerComponent, StateComponent, ModuleTabsComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Movimentações de Estoque</h1><p>Histórico completo e rastreável: cada linha indica a origem (venda, compra, condicional, transferência, inventário...)</p></div></div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="padding:10px 24px;background:white;border-bottom:1px solid #F0F4F8;display:flex;gap:8px;flex-wrap:wrap">
      <input class="input-field" style="width:220px" placeholder="Produto ou SKU" [(ngModel)]="f.q" (ngModelChange)="search()" />
      <select class="input-field" style="width:190px" [(ngModel)]="f.type" (change)="apply()"><option value="">Todos os tipos</option>@for (t of types; track t[0]) { <option [value]="t[0]">{{ t[1] }}</option> }</select>
      <input type="date" class="input-field" style="width:145px" [(ngModel)]="f.from" (change)="apply()" /><input type="date" class="input-field" style="width:145px" [(ngModel)]="f.to" (change)="apply()" />
      @if (auth.me()?.user?.allBranches) { <select class="input-field" style="width:160px" [(ngModel)]="f.branch" (change)="apply()"><option value="current">Filial atual</option><option value="all">Todas</option></select> }
      @if (f.variant) { <span class="chip active" (click)="f.variant = ''; apply()">Filtrando 1 SKU ✕</span> }
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Data/Hora</th><th>Filial</th><th>SKU</th><th>Produto</th><th>Tipo</th><th class="num">Qtd.</th><th class="num">Saldo após</th><th>Origem</th><th>Usuário</th></tr></thead>
        <tbody>@for (m of list.items(); track m.id) {
          <tr><td class="mono" style="font-size:12px">{{ m.created_at | dtt }}</td><td style="font-size:12px">{{ m.branch }}</td><td class="mono" style="font-size:12px">{{ m.sku }}</td><td style="font-size:12px">{{ m.name }} <span class="muted">{{ m.color }} {{ m.size }}</span></td>
            <td><span class="badge" [class]="m.qty > 0 ? 'badge badge-success' : 'badge badge-warning'">{{ label(m.type) }}</span></td>
            <td class="num" [style.color]="m.qty > 0 ? '#18864B' : '#C93636'" style="font-weight:600">{{ m.qty > 0 ? '+' : '' }}{{ m.qty }}</td><td class="num">{{ m.balance_after }}</td>
            <td style="font-size:12px">@if (link(m); as l) { <span class="link" (click)="router.navigateByUrl(l)">{{ m.notes || m.ref_type }}</span> } @else { <span class="muted">{{ m.notes || m.ref_type || '—' }}</span> }</td>
            <td style="font-size:12px">{{ m.user_name || '—' }}</td></tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading() && !list.items().length" [error]="list.error()" [empty]="!list.loading() && !list.items().length" />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>`,
})
export class MovimentacoesPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private route = inject(ActivatedRoute);
  readonly tabs = ESTOQUE_TABS; readonly types = Object.entries(MOVEMENT_LABEL);
  readonly list = new ListState<any>((q) => this.api.get('/stock/movements', q));
  f: any = { q: '', type: '', from: addDaysIso(todayIso(), -30), to: todayIso(), branch: 'current', variant: '' }; private t: any;
  ngOnInit() { this.f.variant = this.route.snapshot.queryParamMap.get('variante') || ''; if (this.f.variant) { this.f.from = ''; this.f.branch = 'all'; } this.apply(); }
  search() { clearTimeout(this.t); this.t = setTimeout(() => this.apply(), 300); }
  apply() { this.list.query = { ...this.f }; this.list.load(1); }
  label(t: string) { return MOVEMENT_LABEL[t] || t; }
  link(m: any) { return ({ sale: '/pedido-detail/', conditional: '/condicional-detail/', consignment: '/consignacao-detail/', purchase_entry: '/entrada-detail/', return: null } as any)[m.ref_type] && m.ref_id ? ({ sale: '/pedido-detail/', conditional: '/condicional-detail/', consignment: '/consignacao-detail/', purchase_entry: '/entrada-detail/' } as any)[m.ref_type] + m.ref_id : m.ref_type === 'transfer' ? '/transferencias' : m.ref_type === 'inventory' ? '/inventario' : null; }
}

// ─── Transferências ─────────────────────────────────────────────────────────
@Component({
  selector: 'ax-transferencias',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModuleTabsComponent, ModalComponent, VariantPickerComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Transferências entre Filiais</h1><p>Rascunho → enviada (sai da origem) → recebida (entra no destino, com conferência de divergências)</p></div>
      @if (auth.can('estoque.transferir')) { <button class="btn-primary" style="font-size:12px" (click)="openNew()"><ax-icon name="plus" [size]="13" /> Nova transferência</button> }</div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto;padding:20px">
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Nº</th><th>Origem</th><th>Destino</th><th class="num">Peças</th><th>Criada</th><th>Enviada</th><th>Recebida</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>@for (t of list.items(); track t.id) {
            <tr><td class="mono link" (click)="view(t)">TR-{{ t.number }}</td><td>{{ t.from_branch }}</td><td>{{ t.to_branch }}</td><td class="num">{{ t.pieces }}</td>
              <td class="mono" style="font-size:12px">{{ t.created_at | dt }}</td><td class="mono" style="font-size:12px">{{ t.sent_at | dt }}</td><td class="mono" style="font-size:12px">{{ t.received_at | dt }}</td>
              <td><span class="badge" [class]="'badge ' + (t.status | statusClass)">{{ t.status | statusLabel }}</span></td>
              <td><div style="display:flex;gap:4px">
                <button class="btn-ghost" style="padding:3px 6px" (click)="view(t)"><ax-icon name="eye" [size]="13" /></button>
                @if (auth.can('estoque.transferir')) {
                  @if (t.status === 'rascunho') { <button class="btn-ghost" style="padding:3px 8px;font-size:12px;color:#0875D1" (click)="act(t, 'send')">Enviar</button> }
                  @if (t.status === 'enviada') { <button class="btn-ghost" style="padding:3px 8px;font-size:12px;color:#18864B" (click)="view(t, true)">Receber</button> }
                  @if (t.status === 'rascunho' || t.status === 'enviada') { <button class="btn-ghost" style="padding:3px 6px;color:#C93636" (click)="act(t, 'cancel')" title="Cancelar"><ax-icon name="ban" [size]="13" /></button> }
                }
              </div></td></tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhuma transferência." />
      </div>
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="newOpen" title="Nova transferência" icon="arrow-left-right" [width]="680">
    <div class="form-grid" style="margin-bottom:10px">
      <div><label class="field-label">Origem</label><div class="field-value" style="padding-top:8px">{{ auth.me()?.branch?.name }} (filial atual)</div></div>
      <div><label class="field-label">Destino *</label><select class="input-field" [(ngModel)]="dest">@for (b of destinations(); track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select></div>
      <div class="span-2"><label class="field-label">Observações</label><input class="input-field" [(ngModel)]="notes" /></div>
    </div>
    <ax-variant-picker (selected)="addItem($event)" />
    <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:10px"><thead><tr><th>SKU</th><th>Produto</th><th class="num">Saldo</th><th class="num">Qtd.</th><th></th></tr></thead>
      <tbody>@for (i of items(); track i.v.id) { <tr><td class="mono" style="font-size:12px">{{ i.v.sku }}</td><td>{{ i.v.name }} {{ i.v.color }} {{ i.v.size }}</td><td class="num">{{ i.v.stock }}</td>
        <td class="num"><input type="number" min="1" class="input-field mono" style="width:70px;padding:4px 6px;text-align:right" [(ngModel)]="i.qty" /></td><td><button class="btn-ghost" style="padding:2px" (click)="rmItem(i)"><ax-icon name="x" [size]="13" /></button></td></tr> }</tbody></table>
    <div footer><button class="btn-secondary" (click)="newOpen.set(false)">Cancelar</button><button class="btn-secondary" [disabled]="!items().length" (click)="create(false)">Salvar rascunho</button><button class="btn-primary" [disabled]="!items().length" (click)="create(true)">Criar e enviar</button></div>
  </ax-modal>
  <ax-modal [(open)]="viewOpen" [title]="'Transferência TR-' + (cur()?.number ?? '')" icon="arrow-left-right" [width]="640">
    @if (cur(); as t) {
      <p style="font-size:12px;color:#647687;margin-bottom:10px">{{ t.from_branch }} → {{ t.to_branch }} · {{ t.status | statusLabel }} @if (t.notes) { · {{ t.notes }} }</p>
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>SKU</th><th>Produto</th><th class="num">Enviado</th><th class="num">{{ receiving() ? 'Recebido (conferência)' : 'Recebido' }}</th></tr></thead>
        <tbody>@for (i of t.items; track i.id) { <tr><td class="mono" style="font-size:12px">{{ i.sku }}</td><td>{{ i.name }} {{ i.color }} {{ i.size }}</td><td class="num">{{ i.qty }}</td>
          <td class="num">@if (receiving()) { <input type="number" min="0" [max]="i.qty" class="input-field mono" style="width:70px;padding:4px 6px;text-align:right" [(ngModel)]="i.rec" /> } @else { {{ i.qty_received ?? '—' }} }</td></tr> }</tbody></table>
    }
    <div footer><button class="btn-secondary" (click)="viewOpen.set(false)">Fechar</button>@if (receiving()) { <button class="btn-primary" (click)="receive()">Confirmar recebimento</button> }</div>
  </ax-modal>`,
})
export class TransferenciasPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tabs = ESTOQUE_TABS;
  readonly list = new ListState<any>((q) => this.api.get('/transfers', q));
  readonly newOpen = signal(false); readonly viewOpen = signal(false); readonly cur = signal<any>(null); readonly receiving = signal(false); readonly items = signal<{ v: any; qty: number }[]>([]);
  readonly destinations = computed(() => (this.lk.data()?.branches ?? []).filter((b) => b.id !== this.auth.me()?.branch?.id));
  dest = ''; notes = '';
  ngOnInit() { this.lk.ensure(); this.list.load(); }
  openNew() { this.items.set([]); this.dest = this.destinations()[0]?.id ?? ''; this.notes = ''; this.newOpen.set(true); }
  addItem(v: any) { if (!this.items().find((i) => i.v.id === v.id)) this.items.update((l) => [...l, { v, qty: 1 }]); }
  rmItem(i: any) { this.items.update((l) => l.filter((x) => x !== i)); }
  async create(send: boolean) {
    try { await this.api.post('/transfers', { toBranchId: this.dest, notes: this.notes || undefined, send, items: this.items().map((i) => ({ variantId: i.v.id, qty: Math.max(1, Math.floor(+i.qty)) })) }); this.toast.success(send ? 'Transferência enviada.' : 'Rascunho salvo.'); this.newOpen.set(false); this.list.reload(); }
    catch (e) { this.toast.error(e); }
  }
  async view(t: any, receive = false) {
    try { const d: any = await this.api.get('/transfers/' + t.id); d.items.forEach((i: any) => (i.rec = i.qty)); this.cur.set(d); this.receiving.set(receive); this.viewOpen.set(true); } catch (e) { this.toast.error(e); }
  }
  async act(t: any, a: 'send' | 'cancel') {
    if (a === 'cancel' && !confirm('Cancelar a transferência? Se já enviada, as peças voltam para a origem.')) return;
    try { await this.api.post(`/transfers/${t.id}/${a}`); this.toast.success(a === 'send' ? 'Transferência enviada.' : 'Transferência cancelada.'); this.list.reload(); } catch (e) { this.toast.error(e); }
  }
  async receive() {
    try { await this.api.post(`/transfers/${this.cur().id}/receive`, { items: this.cur().items.map((i: any) => ({ variantId: i.variant_id, qtyReceived: Math.max(0, Math.floor(+i.rec)) })) }); this.toast.success('Recebimento registrado.'); this.viewOpen.set(false); this.list.reload(); }
    catch (e) { this.toast.error(e); }
  }
}

// ─── Inventário ─────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-inventario',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModuleTabsComponent, ModalComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Inventário</h1><p>Contagem por bipagem (soma) ou digitação; o fechamento gera os ajustes automaticamente</p></div>
      @if (auth.can('estoque.inventario') && !open()) { <button class="btn-primary" style="font-size:12px" (click)="create()"><ax-icon name="plus" [size]="13" /> Abrir inventário</button> }</div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
      @if (open(); as inv) {
        <div class="card" style="padding:16px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
            <b>Inventário nº {{ inv.number }}</b><span class="badge badge-warning">Aberto</span><span class="muted" style="font-size:12px">{{ inv.branch }} · aberto em {{ inv.created_at | dtt }}</span>
            <span style="margin-left:auto;font-size:12px">{{ inv.items.length }} SKU(s) · {{ countedPieces() }} peça(s) contadas</span>
          </div>
          @if (auth.can('estoque.inventario')) {
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
              <ax-icon name="scan-barcode" [size]="18" color="#0875D1" />
              <input id="inv-scan" class="input-field mono" style="max-width:320px;font-size:15px" placeholder="Bipe o código de barras" [(ngModel)]="scan" (keydown.enter)="count()" />
              <input type="number" min="1" class="input-field mono" style="width:80px" [(ngModel)]="scanQty" title="Quantidade" />
              <select class="input-field" style="width:130px" [(ngModel)]="mode"><option value="somar">Somar</option><option value="definir">Definir</option></select>
              <button class="btn-secondary" style="font-size:12px" (click)="count()">Lançar</button>
              <div style="flex:1"></div>
              <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="cancel()">Cancelar inventário</button>
              <button class="btn-primary" style="font-size:12px" (click)="closeOpen.set(true)"><ax-icon name="check" [size]="13" /> Fechar e ajustar</button>
            </div>
          }
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>SKU</th><th>Código</th><th>Produto</th><th class="num">Sistema</th><th class="num">Contado</th><th class="num">Diferença</th><th>Última contagem</th></tr></thead>
            <tbody>@for (i of inv.items; track i.variant_id) { <tr><td class="mono" style="font-size:12px">{{ i.sku }}</td><td class="mono" style="font-size:11px;color:#647687">{{ i.barcode }}</td><td>{{ i.name }} <span class="muted">{{ i.color }} {{ i.size }}</span></td>
              <td class="num">{{ i.expected_qty }}</td><td class="num" style="font-weight:700">{{ i.counted_qty }}</td><td class="num" [style.color]="i.counted_qty - i.expected_qty === 0 ? '#18864B' : '#C93636'">{{ i.counted_qty - i.expected_qty > 0 ? '+' : '' }}{{ i.counted_qty - i.expected_qty }}</td><td class="mono" style="font-size:11px">{{ i.counted_at | dtt }}</td></tr> }
              @empty { <tr><td colspan="7" class="empty-state">Nenhum item contado ainda. Bipe as peças para começar.</td></tr> }</tbody></table>
        </div>
      }
      <div class="card" style="overflow:hidden"><div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600">Histórico</div>
        <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Nº</th><th>Filial</th><th>Aberto em</th><th>Fechado em</th><th class="num">SKUs</th><th class="num">Peças contadas</th><th>Responsável</th><th>Status</th></tr></thead>
          <tbody>@for (i of list.items(); track i.id) { <tr><td class="mono">{{ i.number }}</td><td>{{ i.branch }}</td><td class="mono" style="font-size:12px">{{ i.created_at | dtt }}</td><td class="mono" style="font-size:12px">{{ i.closed_at | dtt }}</td><td class="num">{{ i.counted_skus }}</td><td class="num">{{ i.counted_pieces }}</td><td>{{ i.created_by_name }}</td>
            <td><span class="badge" [class]="'badge ' + (i.status | statusClass)">{{ i.status | statusLabel }}</span></td></tr> }</tbody></table>
        <ax-state [loading]="list.loading()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum inventário realizado." />
      </div>
    </div>
  </div>
  <ax-modal [(open)]="closeOpen" title="Fechar inventário" icon="check" [width]="460">
    <p style="font-size:13px;margin-bottom:10px">Os saldos dos SKUs contados serão ajustados para a quantidade contada (movimento "Inventário", com trilha de auditoria).</p>
    <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px"><input type="checkbox" [(ngModel)]="zero" style="margin-top:3px" /> Zerar SKUs com saldo que não foram contados (inventário completo da filial)</label>
    <div footer><button class="btn-secondary" (click)="closeOpen.set(false)">Voltar</button><button class="btn-primary" (click)="close()">Fechar e ajustar</button></div>
  </ax-modal>`,
})
export class InventarioPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly tabs = ESTOQUE_TABS;
  readonly list = new ListState<any>((q) => this.api.get('/inventories', q));
  readonly open = signal<any>(null); readonly closeOpen = signal(false);
  readonly countedPieces = computed(() => (this.open()?.items ?? []).reduce((s: number, i: any) => s + i.counted_qty, 0));
  scan = ''; scanQty = 1; mode: 'somar' | 'definir' = 'somar'; zero = false;
  ngOnInit() { this.load(); }
  async load() {
    await this.list.load();
    const o = this.list.items().find((i) => i.status === 'aberto' && i.branch === this.auth.me()?.branch?.name);
    this.open.set(o ? await this.api.get('/inventories/' + o.id) : null);
  }
  async create() { try { await this.api.post('/inventories', {}); this.toast.success('Inventário aberto.'); this.load(); setTimeout(() => document.getElementById('inv-scan')?.focus(), 300); } catch (e) { this.toast.error(e); } }
  async count() {
    if (!this.scan.trim()) return;
    try { await this.api.post(`/inventories/${this.open().id}/count`, { mode: this.mode, items: [{ barcode: this.scan.trim(), qty: Math.max(0, Math.floor(+this.scanQty || 0)) }] }); this.scan = ''; this.scanQty = 1;
      this.open.set(await this.api.get('/inventories/' + this.open().id)); document.getElementById('inv-scan')?.focus(); }
    catch (e) { this.toast.error(e); }
  }
  async close() {
    try { const r: any = await this.api.post(`/inventories/${this.open().id}/close`, { zeroUncounted: this.zero }); this.toast.success(`Inventário fechado: ${r.adjusted} ajuste(s) (+${r.plus} / -${r.minus}).`); this.closeOpen.set(false); this.load(); }
    catch (e) { this.toast.error(e); }
  }
  async cancel() { if (!confirm('Cancelar o inventário aberto? As contagens serão descartadas.')) return; try { await this.api.post(`/inventories/${this.open().id}/cancel`); this.load(); } catch (e) { this.toast.error(e); } }
}

// ─── Curva ABC ──────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-curva-abc',
  imports: [FormsModule, StateComponent, ModuleTabsComponent, ...CHARTS, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div><h1 style="font-size:16px;font-weight:700;color:#172B3A">Análise Curva ABC</h1><p style="font-size:12px;color:#647687">Classificação por faturamento: A = até 80% acumulado, B = até 95%, C = demais</p></div>
      <select class="input-field" style="width:160px" [(ngModel)]="days" (change)="load()"><option [ngValue]="30">30 dias</option><option [ngValue]="90">90 dias</option><option [ngValue]="180">180 dias</option><option [ngValue]="365">12 meses</option></select>
    </div>
    <ax-state [loading]="loading()" [error]="error()" [empty]="!loading() && !rows().length" emptyText="Sem vendas no período." />
    @if (rows().length) {
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
        @for (c of classes(); track c.cls) { <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase">Classe {{ c.cls }}</div><div style="font-size:22px;font-weight:700" [style.color]="c.color">{{ c.n }} produto(s)</div><div style="font-size:11px;color:#647687">{{ c.revenue | brl }} · {{ c.pct | num:1 }}% do faturamento</div></div> }
      </div>
      <div class="card" style="padding:16px;margin-bottom:16px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">Curva acumulada (%)</div>
        <ax-line-chart [labels]="labels()" [series]="series()" [height]="200" [area]="true" /></div>
      <div class="card" style="overflow:hidden"><table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>#</th><th>Produto</th><th class="num">Peças</th><th class="num">Faturamento</th><th class="num">% acumulado</th><th>Classe</th></tr></thead>
        <tbody>@for (r of rows(); track r.id; let i = $index) { <tr><td class="mono">{{ i + 1 }}</td><td>{{ r.code }} · {{ r.name }}</td><td class="num">{{ r.qty }}</td><td class="num">{{ r.revenue | brl }}</td><td class="num">{{ r.cum_pct | num:1 }}%</td>
          <td><span class="badge" [class]="r.class === 'A' ? 'badge badge-success' : r.class === 'B' ? 'badge badge-warning' : 'badge badge-muted'">{{ r.class }}</span></td></tr> }</tbody></table></div>
    }
  </div>`,
})
export class CurvaAbcPage implements OnInit {
  private api = inject(Api);
  readonly tabs = ESTOQUE_TABS;
  readonly rows = signal<any[]>([]); readonly loading = signal(false); readonly error = signal<string | null>(null);
  days = 90;
  ngOnInit() { this.load(); }
  async load() { this.loading.set(true); this.error.set(null); try { this.rows.set(await this.api.get('/stock/abc', { days: this.days, branch: 'all' })); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); } }
  readonly classes = computed(() => {
    const total = this.rows().reduce((s, r) => s + Number(r.revenue), 0) || 1;
    return (['A', 'B', 'C'] as const).map((cls) => { const l = this.rows().filter((r) => r.class === cls); const rev = l.reduce((s, r) => s + Number(r.revenue), 0); return { cls, n: l.length, revenue: rev, pct: (rev / total) * 100, color: cls === 'A' ? '#18864B' : cls === 'B' ? '#D99000' : '#647687' }; });
  });
  readonly labels = computed(() => this.rows().map((_, i) => String(i + 1)));
  readonly series = computed<Series[]>(() => [{ name: '% acumulado', color: '#0875D1', values: this.rows().map((r) => Number(r.cum_pct)) }]);
}

// ─── Etiquetas ──────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-etiquetas',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, VariantPickerComponent, BarcodeComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .label { width: 50mm; height: 30mm; border: 1px dashed #DCE4EC; padding: 2mm 3mm; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; background: white; break-inside: avoid; }
    @media print { :host .label { border: none; } }
  `],
  template: `
  <div class="no-print"><ax-module-tabs [tabs]="tabs" /></div>
  <div style="padding:24px">
    <div class="no-print" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <div>@if (auth.has('peso')) { <div style="display:flex;gap:6px;margin-bottom:8px"><span class="chip" [class.active]="mode() === 'produto'" (click)="mode.set('produto')">Etiquetas de produto</span><span class="chip" [class.active]="mode() === 'balanca'" (click)="mode.set('balanca')">Etiquetas de balança (peso)</span></div> }
        <h1 style="font-size:16px;font-weight:700;color:#172B3A">Etiquetas com Código de Barras</h1><p style="font-size:12px;color:#647687">EAN-13 (ou Code 128 para códigos não numéricos) · formato 50 × 30 mm · imprima em impressora térmica ou folha A4</p></div>
      <div style="display:flex;gap:8px"><button class="btn-ghost" style="font-size:12px" (click)="items.set([]); scaleItems.set([])">Limpar</button><button class="btn-primary" style="font-size:12px" [disabled]="!(mode() === 'balanca' ? scaleLabels().length : labels().length)" (click)="print()"><ax-icon name="printer" [size]="13" /> Imprimir {{ mode() === 'balanca' ? scaleLabels().length : labels().length }} etiqueta(s)</button></div>
    </div>
    @if (mode() === 'balanca') {
      <div class="no-print card" style="padding:16px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">Produtos pesados e embalados na loja</div>
        <p style="font-size:12px;color:#647687;margin:0 0 10px">O código de barras leva o código de balança (PLU) e o {{ me()?.settings?.balanca?.tipoValor === 'peso' ? 'peso' : 'preço total' }} — o PDV lê a etiqueta e lança o item com o valor certo. Formato configurado em Configurações › Balança.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:240px"><label class="field-label">Produto vendido por peso</label><ax-variant-picker placeholder="Busque o produto" (selected)="bw.item = $event" /></div>
          <div><label class="field-label">Peso (kg)</label><input type="number" min="0.001" step="0.005" class="input-field mono" style="width:110px" [(ngModel)]="bw.kg" /></div>
          <div><label class="field-label">Cópias</label><input type="number" min="1" max="200" class="input-field mono" style="width:80px" [(ngModel)]="bw.copies" /></div>
          <button class="btn-primary" style="font-size:12px" [disabled]="!bw.item || !(bw.kg > 0)" (click)="addScaleLabel()"><ax-icon name="plus" [size]="12" /> Adicionar</button>
        </div>
        @if (bw.item) { <div style="font-size:12px;color:#647687;margin-top:6px">Selecionado: <b>{{ bw.item.name }}</b> · {{ bw.item.price | brl }}/kg @if (!bw.item.plu_code) { <span style="color:#C93636">— cadastre o código de balança (PLU) no produto</span> }</div> }
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:3mm">
        @for (l of scaleLabels(); track $index) {
          <div class="label">
            <div style="font-size:8pt;font-weight:700;line-height:1.1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">{{ l.name }}</div>
            <div style="display:flex;justify-content:space-between;font-size:6.5pt"><span>{{ l.weightKg | num:3 }} kg × {{ l.pricePerKg | brl }}/kg</span>@if (l.expiryDate) { <span>Val. {{ l.expiryDate | dt }}</span> }</div>
            <ax-barcode [value]="l.barcode" [height]="26" [width]="170" />
            <div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:6pt">Emb. {{ l.packedOn | dt }}</span><span style="font-size:10pt;font-weight:800">{{ l.total | brl }}</span></div>
          </div>
        }
      </div>
    } @else {
    <div class="no-print card" style="padding:16px;margin-bottom:16px">
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;align-items:end">
        <div><label class="field-label">Adicionar SKU</label><ax-variant-picker (selected)="add($event)" /></div>
        <div style="display:flex;gap:12px;font-size:12px;padding-bottom:8px"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" [(ngModel)]="showPrice" /> Preço</label><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" [(ngModel)]="showBrand" /> Marca</label></div>
      </div>
      @if (items().length) {
        <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr><th>SKU</th><th>Produto</th><th>Código</th><th class="num">Preço</th><th class="num">Qtd. etiquetas</th><th></th></tr></thead>
          <tbody>@for (i of items(); track i.id) { <tr><td class="mono" style="font-size:12px">{{ i.sku }}</td><td>{{ i.name }} <span class="muted">{{ i.color }} {{ i.size }}</span></td><td class="mono" style="font-size:11px">{{ i.barcode || i.sku }}</td><td class="num">{{ i.price | brl }}</td>
            <td class="num"><input type="number" min="1" max="500" class="input-field mono" style="width:70px;padding:4px 6px;text-align:right" [ngModel]="i.qty" (ngModelChange)="setQty(i, $event)" /></td><td><button class="btn-ghost" style="padding:2px" (click)="rm(i)"><ax-icon name="x" [size]="13" /></button></td></tr> }</tbody></table>
      }
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:3mm">
      @for (l of labels(); track $index) {
        <div class="label">
          <div style="font-size:8pt;font-weight:700;line-height:1.1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">{{ l.name }}</div>
          <div style="display:flex;justify-content:space-between;font-size:7pt;color:#333"><span>{{ l.color }} @if (l.size) { · <b>{{ l.size }}</b> }</span>@if (showBrand && l.brand) { <span>{{ l.brand }}</span> }</div>
          <ax-barcode [value]="l.barcode || l.sku" [height]="28" [width]="170" />
          <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="mono" style="font-size:6.5pt">{{ l.sku }}</span>@if (showPrice) { <span style="font-size:10pt;font-weight:800">{{ l.price | brl }}</span> }</div>
        </div>
      }
    </div>
    }
  </div>`,
})
export class EtiquetasPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); private route = inject(ActivatedRoute);
  readonly tabs = ESTOQUE_TABS;
  readonly items = signal<any[]>([]);
  readonly labels = computed(() => this.items().flatMap((i) => Array(Math.min(500, Math.max(0, i.qty | 0))).fill(i)));
  readonly auth = inject(AuthService); readonly me = this.auth.me;
  readonly mode = signal<'produto' | 'balanca'>('produto'); readonly scaleItems = signal<any[]>([]);
  readonly scaleLabels = computed(() => this.scaleItems().flatMap((i) => Array(Math.min(200, i.copies || 1)).fill(i)));
  bw: any = { item: null, kg: null, copies: 1 };
  async addScaleLabel() {
    if (this.bw.item?.kind) { this.toast.error('Selecione o produto (não embalagem ou combo).'); return; }
    try { const r = await this.api.post<any[]>('/scale/labels', { items: [{ productId: this.bw.item.product_id, weightKg: +this.bw.kg, copies: +this.bw.copies || 1 }] }); this.scaleItems.update((l) => [...l, ...r]); this.bw = { item: this.bw.item, kg: null, copies: 1 }; }
    catch (e) { this.toast.error(e); }
  }
  showPrice = true; showBrand = true;
  async ngOnInit() {
    const q = this.route.snapshot.queryParamMap;
    try {
      if (q.get('entrada')) { const r = await this.api.get<any[]>(`/purchase-entries/${q.get('entrada')}/labels`); this.items.set(r); }
      else if (q.get('produto')) { const p: any = await this.api.get('/products/' + q.get('produto')); const r = await this.api.post<any[]>('/labels', { items: p.variants.filter((v: any) => v.active).map((v: any) => ({ variantId: v.id, qty: Math.max(1, v.stock_total || 1) })) }); this.items.set(r); }
    } catch (e) { this.toast.error(e); }
  }
  async add(v: any) {
    if (this.items().find((i) => i.id === v.id)) return;
    try { const r = await this.api.post<any[]>('/labels', { items: [{ variantId: v.id, qty: 1 }] }); this.items.update((l) => [...l, ...r]); } catch (e) { this.toast.error(e); }
  }
  setQty(i: any, q: any) { this.items.update((l) => l.map((x) => (x === i ? { ...x, qty: Math.max(1, Math.min(500, Math.floor(+q || 1))) } : x))); }
  rm(i: any) { this.items.update((l) => l.filter((x) => x !== i)); }
  print() { window.print(); }
}
