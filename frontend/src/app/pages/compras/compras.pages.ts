import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, PagerComponent, StateComponent, ModalComponent, ModuleTabsComponent, VariantPickerComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, STATUS_PIPES, brl, num } from '../../core/format';

export const COMPRAS_TABS = [{ path: '/compras', label: 'Dashboard' }, { path: '/recebimentos', label: 'Entradas (XML / manual)' }, { path: '/pedidos-compra', label: 'Pedidos de Compra' }, { path: '/mapa-cotacao', label: 'Mapa Comparativo' }];

// ─── Dashboard de compras ───────────────────────────────────────────────────
@Component({
  selector: 'ax-compras-dashboard',
  imports: [IconComponent, ModuleTabsComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Dashboard de Compras</h1><p style="font-size:13px;color:#647687">{{ month }} · indicadores calculados das entradas e pedidos</p></div>
      @if (auth.can('compras.editar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/recebimentos')"><ax-icon name="file-input" [size]="13" /> Importar XML de NF-e</button> }
    </div>
    <ax-state [loading]="!d()" />
    @if (d(); as d) {
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:20px">
        @for (k of kpis(); track k.label) {
          <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">{{ k.label }}</div>
            <div [style.color]="k.color" style="font-size:28px;font-weight:700">{{ k.value }}</div><div style="font-size:11px;color:#647687;margin-top:2px">{{ k.sub }}</div></div>
        }
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px">
        @for (c of cards(); track c.label) {
          <div class="card" style="padding:20px;cursor:pointer" (click)="router.navigateByUrl(c.screen)" (mouseenter)="$any($event.currentTarget).style.boxShadow='0 4px 12px rgba(0,0,0,0.08)'" (mouseleave)="$any($event.currentTarget).style.boxShadow='none'">
            <div style="width:40px;height:40px;border-radius:10px;background:#E3EFF9;display:flex;align-items:center;justify-content:center;margin-bottom:10px"><ax-icon [name]="c.icon" [size]="20" color="#0875D1" /></div>
            <div style="font-size:14px;font-weight:600;color:#172B3A;margin-bottom:4px">{{ c.label }}</div><div style="font-size:12px;color:#647687">{{ c.desc }}</div>
          </div>
        }
      </div>
    }
  </div>`,
})
export class ComprasDashboardPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService);
  readonly tabs = COMPRAS_TABS; readonly d = signal<any>(null);
  readonly month = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^\w/, (c) => c.toUpperCase());
  async ngOnInit() { try { this.d.set(await this.api.get('/purchases/dashboard')); } catch { /* */ } }
  readonly kpis = computed(() => { const d = this.d(); if (!d) return []; return [
    { label: 'Pedidos em aberto', value: num(d.orders_open), sub: `${brl(d.orders_open_value)} em carteira`, color: '#0875D1' },
    { label: 'Entradas a conferir', value: num(d.entries_pending), sub: 'XML importado aguardando confirmação', color: '#D99000' },
    { label: 'Entradas no mês', value: num(d.entries_month), sub: brl(d.entries_month_value), color: '#2878C7' },
    { label: 'Necessidades de reposição', value: num(d.needs), sub: 'SKUs com cobertura < 45 dias', color: '#18864B' },
  ]; });
  readonly cards = computed(() => [
    { label: 'Entradas de Mercadoria', desc: 'Importar XML da NF-e e conferir', screen: '/recebimentos', icon: 'file-input' },
    { label: 'Pedidos de Compra', desc: `${this.d()?.orders_open ?? 0} pedido(s) em aberto`, screen: '/pedidos-compra', icon: 'clipboard-list' },
    { label: 'Mapa Comparativo', desc: 'Último custo por fornecedor', screen: '/mapa-cotacao', icon: 'chart-column' },
    { label: 'Reposição Inteligente', desc: 'Sugestões pelo ritmo de vendas', screen: '/estoque-inteligente', icon: 'flask-conical' },
  ]);
}

// ─── Entradas (recebimentos) ────────────────────────────────────────────────
@Component({
  selector: 'ax-recebimentos',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModalComponent, ModuleTabsComponent, VariantPickerComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Entradas de Mercadoria</h1><p>Importe o XML da NF-e do fornecedor: nada entra no estoque antes da conferência e confirmação</p></div>
      @if (auth.can('compras.editar')) {
        <label class="btn-primary" style="font-size:12px;cursor:pointer"><ax-icon name="file-input" [size]="13" /> Importar XML<input type="file" accept=".xml,text/xml,application/xml" multiple style="display:none" (change)="importFiles($event)" /></label>
        <button class="btn-secondary" style="font-size:12px" (click)="openManual()"><ax-icon name="plus" [size]="13" /> Entrada manual</button>
      }
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto;padding:20px">
      @if (importing()) { <div class="state-info" style="margin-bottom:12px"><span class="spinner"></span> Processando XML...</div> }
      @for (r of results(); track $index) {
        <div [class]="r.error ? 'state-error' : 'state-info'" style="margin:0 0 10px">
          <ax-icon [name]="r.error ? 'alert-triangle' : 'check-circle-2'" [size]="14" />
          <div style="flex:1">@if (r.error) { <b>{{ r.file }}:</b> {{ r.error }} } @else { <b>{{ r.file }}:</b> entrada nº {{ r.number }} criada — {{ r.items }} item(ns), {{ r.matched }} vinculado(s) automaticamente, {{ r.pending }} a conferir.
            @for (w of r.warnings; track w) { <div style="color:#8A5B00">⚠ {{ w }}</div> } }</div>
          @if (!r.error) { <button class="btn-ghost" style="font-size:12px" (click)="router.navigateByUrl('/entrada-detail/' + r.id)">Conferir</button> }
        </div>
      }
      <div class="card" style="overflow:hidden">
        <div style="padding:10px 14px;border-bottom:1px solid #F0F4F8;display:flex;gap:8px">
          @for (s of statuses; track s.v) { <span class="chip" [class.active]="status() === s.v" (click)="status.set(s.v); apply()">{{ s.l }}</span> }
        </div>
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Entrada</th><th>Origem</th><th>Fornecedor</th><th>NF</th><th>Emissão</th><th class="num">Itens</th><th class="num">Valor</th><th>Status</th><th></th></tr></thead>
          <tbody>@for (e of list.items(); track e.id) {
            <tr class="clickable" (click)="router.navigateByUrl('/entrada-detail/' + e.id)">
              <td class="mono" style="font-size:12px;color:#0875D1">ENT-{{ e.number }}</td><td><span class="badge" [class]="e.source === 'xml' ? 'badge badge-info' : 'badge badge-muted'">{{ e.source === 'xml' ? 'XML NF-e' : 'Manual' }}</span></td>
              <td style="font-weight:500">{{ e.supplier || '—' }}</td><td class="mono" style="font-size:12px">{{ e.nfe_number ? e.nfe_number + '/' + (e.nfe_series || '') : '—' }}</td><td class="mono" style="font-size:12px">{{ e.issue_date | dt }}</td>
              <td class="num">{{ e.items }} @if (e.pending > 0 && e.status === 'rascunho') { <span style="color:#D99000">({{ e.pending }} pend.)</span> }</td><td class="num" style="font-weight:600">{{ e.total | brl }}</td>
              <td><span class="badge" [class]="'badge ' + (e.status | statusClass)">{{ e.status === 'rascunho' ? 'A conferir' : (e.status | statusLabel) }}</span></td><td><ax-icon name="chevron-right" [size]="13" color="#A0AFBF" /></td>
            </tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhuma entrada. Importe o XML da NF-e de compra." />
      </div>
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="manualOpen" title="Entrada manual de mercadoria" icon="package-plus" [width]="720">
    <div class="form-grid-3" style="margin-bottom:10px">
      <div class="span-2"><label class="field-label">Fornecedor *</label><select class="input-field" [(ngModel)]="m.supplierId">@for (s of lk.data()?.suppliers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select></div>
      <div><label class="field-label">Documento</label><input class="input-field" [(ngModel)]="m.document" /></div>
      <div><label class="field-label">Emissão</label><input type="date" class="input-field" [(ngModel)]="m.issueDate" /></div>
      <div><label class="field-label">Frete</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="m.freight" /></div>
      <div><label class="field-label">1º vencimento</label><input type="date" class="input-field" [(ngModel)]="m.due" /></div>
    </div>
    <ax-variant-picker (selected)="addManual($event)" />
    <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:10px"><thead><tr><th>SKU</th><th>Produto</th><th class="num">Qtd.</th><th class="num">Custo unit.</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>@for (i of mItems(); track i.v.id) { <tr><td class="mono" style="font-size:12px">{{ i.v.sku }}</td><td>{{ i.v.name }} {{ i.v.color }} {{ i.v.size }}</td>
        <td class="num"><input type="number" min="1" class="input-field mono" style="width:70px;padding:4px 6px;text-align:right" [(ngModel)]="i.qty" /></td>
        <td class="num"><input type="number" min="0" step="0.01" class="input-field mono" style="width:90px;padding:4px 6px;text-align:right" [(ngModel)]="i.cost" /></td>
        <td class="num">{{ i.qty * i.cost | brl }}</td><td><button class="btn-ghost" style="padding:2px" (click)="rmManual(i)"><ax-icon name="x" [size]="13" /></button></td></tr> }</tbody></table>
    <div footer><button class="btn-secondary" (click)="manualOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!mItems().length || !m.supplierId" (click)="saveManual()">Criar entrada (rascunho)</button></div>
  </ax-modal>`,
})
export class RecebimentosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tabs = COMPRAS_TABS;
  readonly list = new ListState<any>((q) => this.api.get('/purchase-entries', q));
  readonly status = signal(''); readonly statuses = [{ v: '', l: 'Todas' }, { v: 'rascunho', l: 'A conferir' }, { v: 'confirmada', l: 'Confirmadas' }, { v: 'cancelada', l: 'Canceladas' }];
  readonly importing = signal(false); readonly results = signal<any[]>([]); readonly manualOpen = signal(false); readonly mItems = signal<{ v: any; qty: number; cost: number }[]>([]);
  m: any = {};
  ngOnInit() { this.lk.ensure(); this.list.load(); }
  apply() { this.list.query = { status: this.status() }; this.list.load(1); }
  async importFiles(ev: Event) {
    const files = Array.from((ev.target as HTMLInputElement).files || []); (ev.target as HTMLInputElement).value = '';
    if (!files.length) return;
    this.importing.set(true); const out: any[] = [];
    for (const f of files) {
      try { const xml = await f.text(); const r = await this.api.raw<any>('/purchase-entries/import-xml', xml, 'application/xml'); out.push({ file: f.name, ...r }); }
      catch (e: any) { out.push({ file: f.name, error: e.message }); }
    }
    this.results.set(out); this.importing.set(false); this.list.reload();
    if (out.length === 1 && !out[0].error) this.router.navigateByUrl('/entrada-detail/' + out[0].id);
  }
  openManual() { this.m = { supplierId: this.lk.data()?.suppliers?.[0]?.id ?? '', issueDate: new Date().toISOString().slice(0, 10), freight: 0, due: '' }; this.mItems.set([]); this.manualOpen.set(true); }
  async addManual(v: any) {
    if (this.mItems().find((i) => i.v.id === v.id)) return;
    let cost = 0; try { const p: any = await this.api.get('/products/' + v.product_id); cost = Number(p.variants.find((x: any) => x.id === v.id)?.cost_price ?? p.cost_price ?? 0); } catch { /* sem permissão de custo */ }
    this.mItems.update((l) => [...l, { v, qty: 1, cost }]);
  }
  rmManual(i: any) { this.mItems.update((l) => l.filter((x) => x !== i)); }
  async saveManual() {
    const items = this.mItems().map((i) => ({ variantId: i.v.id, qty: Math.max(1, Math.floor(+i.qty)), unitCost: +i.cost || 0 }));
    const total = items.reduce((s, i) => s + i.qty * i.unitCost, 0) + (+this.m.freight || 0);
    try { const e: any = await this.api.post('/purchase-entries', { supplierId: this.m.supplierId, document: this.m.document || undefined, issueDate: this.m.issueDate, freight: +this.m.freight || undefined, items,
        installments: this.m.due ? [{ due: this.m.due, amount: Math.round(total * 100) / 100 }] : undefined });
      this.toast.success('Entrada criada. Confira e confirme para lançar no estoque.'); this.manualOpen.set(false); this.router.navigateByUrl('/entrada-detail/' + e.id); }
    catch (e) { this.toast.error(e); }
  }
}

// ─── Conferência da entrada (vínculo de itens / criação de produtos com grade) ──
@Component({
  selector: 'ax-entrada-detail',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, VariantPickerComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
  @if (e(); as e) {
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header">
      <div style="flex:1;min-width:260px">
        <div style="display:flex;align-items:center;gap:10px"><h1>Entrada ENT-{{ e.number }}</h1><span class="badge" [class]="'badge ' + (e.status | statusClass)">{{ e.status === 'rascunho' ? 'A conferir' : (e.status | statusLabel) }}</span>@if (e.source === 'xml') { <span class="badge badge-info">XML NF-e</span> }</div>
        <p>{{ e.supplier || e.supplier_data?.name }} @if (e.supplier_cnpj) { · CNPJ {{ e.supplier_cnpj | doc }} } @if (e.nfe_number) { · NF {{ e.nfe_number }}/{{ e.nfe_series }} } · emissão {{ e.issue_date | dt }}</p>
        @if (e.nfe_key) { <p class="mono" style="font-size:11px">Chave: {{ e.nfe_key }}</p> }
      </div>
      @if (e.status === 'rascunho' && auth.can('compras.editar')) {
        <button class="btn-secondary" style="font-size:12px" [disabled]="!selected().length" (click)="openCreate()"><ax-icon name="shirt" [size]="13" /> Criar produto com os selecionados ({{ selected().length }})</button>
        <button class="btn-primary" style="font-size:12px" [disabled]="pending() > 0 || busy()" (click)="confirmOpen.set(true)"><ax-icon name="check" [size]="13" /> Confirmar entrada</button>
        <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="cancel()">Descartar</button>
      }
      @if (e.status === 'confirmada') {
        <button class="btn-secondary" style="font-size:12px" (click)="router.navigate(['/etiquetas'], { queryParams: { entrada: e.id } })"><ax-icon name="tag" [size]="13" /> Imprimir etiquetas</button>
        @if (auth.can('compras.editar')) { <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="cancel()">Cancelar entrada</button> }
      }
    </div>
    <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px">
      @for (w of e.warnings; track w) { <div class="state-warning"><ax-icon name="alert-triangle" [size]="14" />{{ w }}</div> }
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">
        @for (k of [['Produtos', (e.total_products | brl)], ['Frete', (e.total_freight | brl)], ['Desconto', (e.total_discount | brl)], ['Total da nota', (e.total | brl)], ['Itens a conferir', pending() + ' de ' + e.items.length]]; track k[0]) {
          <div class="kpi-card" style="padding:12px"><div style="font-size:11px;color:#647687">{{ k[0] }}</div><div style="font-size:17px;font-weight:700">{{ k[1] }}</div></div>
        }
      </div>
      @if (e.installments?.length) { <div style="font-size:12px;color:#647687">Duplicatas: @for (d of e.installments; track $index) { <span class="badge badge-muted" style="margin-right:4px">{{ d.number }} · {{ d.due | dt }} · {{ d.amount | brl }}</span> } (viram contas a pagar na confirmação)</div> }
      @if (e.status === 'rascunho') { <div class="state-info"><ax-icon name="info" [size]="14" />Itens reconhecidos pelo código do fornecedor (aprendido nas notas anteriores) ou pelo EAN são vinculados automaticamente. Para os demais: vincule a um SKU existente, ou selecione os itens do mesmo modelo e crie o produto com a grade (cor × tamanho sugeridos a partir da descrição).</div> }
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr>@if (e.status === 'rascunho') { <th style="width:30px"></th> }<th>#</th><th>Cód. forn.</th><th>EAN</th><th>Descrição na NF</th><th>NCM</th><th class="num">Qtd.</th><th class="num">Custo unit.</th><th class="num">Total</th><th>Vínculo no AXIONYX</th>@if (e.status === 'rascunho') { <th></th> }</tr></thead>
          <tbody>@for (it of e.items; track it.id) {
            <tr>
              @if (e.status === 'rascunho') { <td><input type="checkbox" [checked]="selected().includes(it.id)" (change)="toggle(it.id)" [disabled]="it.match_status !== 'pendente'" /></td> }
              <td class="mono" style="font-size:12px">{{ it.line }}</td><td class="mono" style="font-size:11px">{{ it.supplier_code || '—' }}</td><td class="mono" style="font-size:11px">{{ it.ean || '—' }}</td>
              <td style="font-size:12px;max-width:260px">{{ it.description }} @if (it.suggested_size || it.suggested_color) { <div style="font-size:10px;color:#647687">sugestão: {{ it.suggested_color || '—' }} / {{ it.suggested_size || '—' }}</div> }</td>
              <td class="mono" style="font-size:11px">{{ it.ncm || '—' }}</td><td class="num">{{ it.qty }}</td><td class="num">{{ it.unit_cost | brl }}</td><td class="num">{{ it.total | brl }}</td>
              <td style="font-size:12px">
                @if (it.match_status === 'pendente') { <span class="badge badge-warning">Pendente</span> }
                @else if (it.match_status === 'ignorado') { <span class="badge badge-muted">Ignorado</span> }
                @else { <span class="badge" [class]="it.match_status === 'novo' ? 'badge badge-cyan' : 'badge badge-success'">{{ it.match_status === 'novo' ? 'Produto criado' : 'Vinculado' }}</span> <span class="mono" style="font-size:11px;margin-left:4px">{{ it.sku }}</span> <span class="muted" style="font-size:11px;margin-left:4px">{{ it.color }} {{ it.size }}</span> }
              </td>
              @if (e.status === 'rascunho') { <td style="white-space:nowrap">
                <button class="btn-ghost" style="padding:3px 6px;font-size:11px" (click)="openLink(it)">Vincular</button>
                @if (it.match_status !== 'ignorado') { <button class="btn-ghost" style="padding:3px 6px;font-size:11px;color:#647687" (click)="ignore(it)" title="Não lançar no estoque">Ignorar</button> }
              </td> }
            </tr>
          }</tbody>
        </table>
      </div>
    </div>
  </div>
  <ax-modal [(open)]="linkOpen" title="Vincular item a um SKU" icon="link" [width]="560">
    <p style="font-size:12px;color:#647687;margin-bottom:8px">Item da nota: <b>{{ linkItem()?.description }}</b>. O vínculo é memorizado para as próximas notas deste fornecedor.</p>
    <ax-variant-picker (selected)="link($event)" />
  </ax-modal>
  <ax-modal [(open)]="createOpen" title="Criar produto com grade a partir da nota" icon="shirt" [width]="760">
    <div class="form-grid-3" style="margin-bottom:12px">
      <div><label class="field-label">Referência *</label><input class="input-field mono" [(ngModel)]="np.code" /></div>
      <div class="span-2"><label class="field-label">Descrição *</label><input class="input-field" [(ngModel)]="np.name" /></div>
      <div><label class="field-label">Preço de venda *</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="np.salePrice" />
        <div style="font-size:11px;color:#647687;margin-top:2px">Custo médio: {{ avgCost() | brl }} · markup {{ np.salePrice && avgCost() ? (np.salePrice / avgCost() | num:2) + 'x' : '—' }}</div></div>
      <div><label class="field-label">Marca</label><select class="input-field" [(ngModel)]="np.brandId"><option [ngValue]="undefined">—</option>@for (x of lk.data()?.brands ?? []; track x.id) { <option [ngValue]="x.id">{{ x.name }}</option> }</select></div>
      <div><label class="field-label">Categoria</label><select class="input-field" [(ngModel)]="np.categoryId"><option [ngValue]="undefined">—</option>@for (x of lk.data()?.categories ?? []; track x.id) { <option [ngValue]="x.id">{{ x.name }}</option> }</select></div>
      <div><label class="field-label">Coleção</label><select class="input-field" [(ngModel)]="np.collectionId"><option [ngValue]="undefined">—</option>@for (x of lk.data()?.collections ?? []; track x.id) { <option [ngValue]="x.id">{{ x.name }}</option> }</select></div>
    </div>
    <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Item da nota</th><th>Cor</th><th>Tamanho</th></tr></thead>
      <tbody>@for (g of np.items; track g.itemId) { <tr><td style="font-size:12px">{{ g.description }}</td>
        <td><select class="input-field" style="padding:4px 28px 4px 8px" [(ngModel)]="g.colorId"><option [ngValue]="null">—</option>@for (c of lk.data()?.colors ?? []; track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }</select></td>
        <td><select class="input-field" style="padding:4px 28px 4px 8px" [(ngModel)]="g.sizeId"><option [ngValue]="null">—</option>@for (s of lk.data()?.sizes ?? []; track s.id) { <option [ngValue]="s.id">{{ s.grid }} · {{ s.code }}</option> }</select></td></tr> }</tbody></table>
    <p style="font-size:11px;color:#647687;margin-top:8px">O EAN da nota é reaproveitado como código de barras quando válido; caso contrário, é gerado um EAN-13 interno.</p>
    <div footer><button class="btn-secondary" (click)="createOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="createProduct()">Criar produto e vincular</button></div>
  </ax-modal>
  <ax-modal [(open)]="confirmOpen" title="Confirmar entrada" icon="check" [width]="460">
    <p style="font-size:13px;margin-bottom:10px">Ao confirmar: as peças entram no estoque da filial, o custo dos SKUs é atualizado (rateando frete/descontos) e as duplicatas viram contas a pagar.</p>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:8px"><input type="checkbox" [(ngModel)]="updateCost" /> Atualizar preço de custo dos produtos</label>
    @if (!e.installments?.length) { <label class="field-label">Vencimento (nota sem duplicatas)</label><input type="date" class="input-field" [(ngModel)]="firstDue" /> }
    <div footer><button class="btn-secondary" (click)="confirmOpen.set(false)">Voltar</button><button class="btn-primary" [disabled]="busy()" (click)="confirm()">Confirmar entrada</button></div>
  </ax-modal>
  }`,
})
export class EntradaDetailPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly id = input.required<string>();
  readonly e = signal<any>(null); readonly loading = signal(false); readonly error = signal<string | null>(null); readonly busy = signal(false);
  readonly selected = signal<string[]>([]); readonly linkOpen = signal(false); readonly linkItem = signal<any>(null); readonly createOpen = signal(false); readonly confirmOpen = signal(false);
  readonly pending = computed(() => (this.e()?.items ?? []).filter((i: any) => i.match_status === 'pendente').length);
  np: any = {}; updateCost = true; firstDue = '';
  ngOnInit() { this.lk.ensure(); this.load(); }
  async load() { this.loading.set(true); this.error.set(null); try { this.e.set(await this.api.get('/purchase-entries/' + this.id())); this.selected.set([]); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); } }
  toggle(id: string) { this.selected.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])); }
  avgCost() { const its = (this.np.items || []).map((g: any) => this.e().items.find((i: any) => i.id === g.itemId)); const q = its.reduce((s: number, i: any) => s + i.qty, 0); return q ? its.reduce((s: number, i: any) => s + Number(i.total), 0) / q : 0; }
  openLink(it: any) { this.linkItem.set(it); this.linkOpen.set(true); }
  async link(v: any) { try { await this.api.put(`/purchase-entries/${this.id()}/items/${this.linkItem().id}`, { variantId: v.id }); this.linkOpen.set(false); this.toast.success(`Vinculado a ${v.sku}.`); this.load(); } catch (e) { this.toast.error(e); } }
  async ignore(it: any) { try { await this.api.put(`/purchase-entries/${this.id()}/items/${it.id}`, { variantId: null, ignore: true }); this.load(); } catch (e) { this.toast.error(e); } }
  openCreate() {
    const items = this.e().items.filter((i: any) => this.selected().includes(i.id));
    const sizes = this.lk.data()?.sizes ?? [], colors = this.lk.data()?.colors ?? [];
    const words = items[0].description.split(/\s+/);
    const base = words.filter((w: string) => !sizes.some((s) => s.code.toUpperCase() === w.toUpperCase()) && !colors.some((c) => c.name.toUpperCase().includes(w.toUpperCase()) && w.length > 2)).join(' ');
    const avg = items.reduce((s: number, i: any) => s + Number(i.total), 0) / items.reduce((s: number, i: any) => s + i.qty, 0);
    this.np = {
      code: (items[0].supplier_code || '').replace(/[-_.\s]?(PP|P|M|G|GG|XG|\d{2})$/i, '').slice(0, 30), name: base.replace(/\b\w/g, (c: string) => c.toUpperCase()).toLowerCase().replace(/(^|\s)\S/g, (c: string) => c.toUpperCase()),
      salePrice: Math.round(avg * 2.6 * 10) / 10 - 0.1, brandId: undefined, categoryId: undefined, collectionId: undefined,
      items: items.map((i: any) => ({ itemId: i.id, description: i.description, sizeId: sizes.find((s) => s.code.toUpperCase() === (i.suggested_size || '').toUpperCase())?.id ?? null, colorId: colors.find((c) => c.name === i.suggested_color)?.id ?? null })),
    };
    this.createOpen.set(true);
  }
  async createProduct() {
    try { await this.api.post(`/purchase-entries/${this.id()}/create-products`, { groups: [{ code: this.np.code, name: this.np.name, salePrice: +this.np.salePrice, brandId: this.np.brandId, categoryId: this.np.categoryId, collectionId: this.np.collectionId,
        items: this.np.items.map((g: any) => ({ itemId: g.itemId, sizeId: g.sizeId, colorId: g.colorId })) }] });
      this.toast.success('Produto criado com a grade e itens vinculados.'); this.createOpen.set(false); this.lk.invalidate(); this.load(); }
    catch (e) { this.toast.error(e); }
  }
  async confirm() {
    this.busy.set(true);
    try { await this.api.post(`/purchase-entries/${this.id()}/confirm`, { updateCost: this.updateCost, firstDue: this.firstDue || undefined }, { idempotent: true }); this.toast.success('Entrada confirmada: estoque e contas a pagar atualizados.'); this.confirmOpen.set(false); this.load(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async cancel() {
    if (!confirm(this.e().status === 'confirmada' ? 'Cancelar a entrada confirmada? O estoque será estornado e as contas a pagar em aberto canceladas.' : 'Descartar esta entrada?')) return;
    try { await this.api.post(`/purchase-entries/${this.id()}/cancel`); this.toast.success('Entrada cancelada.'); this.load(); } catch (e) { this.toast.error(e); }
  }
}

// ─── Pedidos de compra ──────────────────────────────────────────────────────
@Component({
  selector: 'ax-pedidos-compra',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModalComponent, ModuleTabsComponent, VariantPickerComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Pedidos de Compra</h1><p>{{ list.total() }} pedido(s)</p></div>
      @if (auth.can('compras.editar')) { <button class="btn-primary" style="font-size:12px" (click)="openNew()"><ax-icon name="plus" [size]="13" /> Novo pedido</button> }</div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto;padding:20px">
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Pedido</th><th>Fornecedor</th><th>Filial</th><th>Emissão</th><th>Previsão</th><th class="num">Itens</th><th class="num">Total</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>@for (o of list.items(); track o.id) {
            <tr><td class="mono link" (click)="view(o)">PC-{{ o.number }}</td><td style="font-weight:500">{{ o.supplier }}</td><td>{{ o.branch }}</td><td class="mono" style="font-size:12px">{{ o.created_at | dt }}</td>
              <td class="mono" style="font-size:12px">{{ o.expected_date | dt }}</td><td class="num">{{ o.items }}</td><td class="num" style="font-weight:600">{{ o.total | brl }}</td>
              <td><span class="badge" [class]="'badge ' + (o.status | statusClass)">{{ o.status | statusLabel }}</span></td>
              <td>@if (auth.can('compras.editar') && !['recebido','cancelado'].includes(o.status)) {
                <select class="input-field" style="padding:3px 26px 3px 8px;font-size:12px;width:140px" (change)="setStatus(o, $any($event.target).value)"><option value="">Alterar status…</option><option value="aprovado">Aprovar</option><option value="enviado">Enviado ao fornecedor</option><option value="recebido">Recebido</option><option value="cancelado">Cancelar</option></select> }</td></tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum pedido de compra." />
      </div>
      <p style="font-size:11px;color:#647687;margin-top:8px">O recebimento físico é registrado em "Entradas" (XML da NF-e ou manual), que atualiza estoque e contas a pagar.</p>
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="newOpen" title="Novo pedido de compra" icon="clipboard-list" [width]="720">
    <div class="form-grid-3" style="margin-bottom:10px">
      <div class="span-2"><label class="field-label">Fornecedor *</label><select class="input-field" [(ngModel)]="o.supplierId">@for (s of lk.data()?.suppliers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select></div>
      <div><label class="field-label">Previsão de entrega</label><input type="date" class="input-field" [(ngModel)]="o.expectedDate" /></div>
      <div class="span-all"><label class="field-label">Observações</label><input class="input-field" [(ngModel)]="o.notes" /></div>
    </div>
    <ax-variant-picker (selected)="addItem($event)" />
    <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:10px"><thead><tr><th>SKU</th><th>Produto</th><th class="num">Qtd.</th><th class="num">Custo unit.</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>@for (i of items(); track i.v.id) { <tr><td class="mono" style="font-size:12px">{{ i.v.sku }}</td><td>{{ i.v.name }} {{ i.v.color }} {{ i.v.size }}</td>
        <td class="num"><input type="number" min="1" class="input-field mono" style="width:70px;padding:4px 6px;text-align:right" [(ngModel)]="i.qty" /></td>
        <td class="num"><input type="number" min="0" step="0.01" class="input-field mono" style="width:90px;padding:4px 6px;text-align:right" [(ngModel)]="i.cost" /></td><td class="num">{{ i.qty * i.cost | brl }}</td>
        <td><button class="btn-ghost" style="padding:2px" (click)="rm(i)"><ax-icon name="x" [size]="13" /></button></td></tr> }</tbody></table>
    <div footer><button class="btn-secondary" (click)="newOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!items().length" (click)="save()">Criar pedido</button></div>
  </ax-modal>
  <ax-modal [(open)]="viewOpen" [title]="'Pedido PC-' + (cur()?.number ?? '')" icon="clipboard-list" [width]="620">
    @if (cur(); as c) { <p style="font-size:12px;color:#647687;margin-bottom:8px">{{ c.supplier }} · {{ c.status | statusLabel }} · total {{ c.total | brl }}</p>
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>SKU</th><th>Produto</th><th class="num">Qtd.</th><th class="num">Custo</th></tr></thead>
        <tbody>@for (i of c.items; track i.id) { <tr><td class="mono" style="font-size:12px">{{ i.sku }}</td><td>{{ i.name }} {{ i.color }} {{ i.size }}</td><td class="num">{{ i.qty }}</td><td class="num">{{ i.unit_cost | brl }}</td></tr> }</tbody></table> }
  </ax-modal>`,
})
export class PedidosCompraPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tabs = COMPRAS_TABS;
  readonly list = new ListState<any>((q) => this.api.get('/purchase-orders', q));
  readonly newOpen = signal(false); readonly viewOpen = signal(false); readonly cur = signal<any>(null); readonly items = signal<{ v: any; qty: number; cost: number }[]>([]);
  o: any = {};
  ngOnInit() { this.lk.ensure(); this.list.load(); }
  openNew() { this.o = { supplierId: this.lk.data()?.suppliers?.[0]?.id ?? '', expectedDate: '', notes: '' }; this.items.set([]); this.newOpen.set(true); }
  addItem(v: any) { if (!this.items().find((i) => i.v.id === v.id)) this.items.update((l) => [...l, { v, qty: 6, cost: 0 }]); }
  rm(i: any) { this.items.update((l) => l.filter((x) => x !== i)); }
  async save() {
    try { await this.api.post('/purchase-orders', { supplierId: this.o.supplierId, expectedDate: this.o.expectedDate || undefined, notes: this.o.notes || undefined, items: this.items().map((i) => ({ variantId: i.v.id, qty: Math.max(1, Math.floor(+i.qty)), unitCost: +i.cost || 0 })) });
      this.toast.success('Pedido criado.'); this.newOpen.set(false); this.list.reload(); }
    catch (e) { this.toast.error(e); }
  }
  async view(o: any) { try { this.cur.set(await this.api.get('/purchase-orders/' + o.id)); this.viewOpen.set(true); } catch (e) { this.toast.error(e); } }
  async setStatus(o: any, s: string) { if (!s) return; try { await this.api.post(`/purchase-orders/${o.id}/status`, { status: s }); this.list.reload(); } catch (e) { this.toast.error(e); } }
}

// ─── Mapa comparativo (custos reais por fornecedor) ─────────────────────────
@Component({
  selector: 'ax-mapa-cotacao',
  imports: [FormsModule, IconComponent, StateComponent, ModuleTabsComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:16px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Mapa Comparativo de Custos por Fornecedor</h1>
        <p style="font-size:12px;color:#647687">Último custo unitário pago (12 meses) · {{ d()?.products?.length ?? 0 }} produtos · {{ d()?.suppliers?.length ?? 0 }} fornecedor(es)</p></div>
    </div>
    <ax-module-tabs [tabs]="tabs" />
    @if (d()?.suppliers?.length === 1) {
      <div style="padding:10px 24px;background:linear-gradient(90deg, rgba(0,166,214,0.08), rgba(8,117,209,0.06));border-bottom:1px solid rgba(0,166,214,0.15);display:flex;align-items:center;gap:10px">
        <ax-icon name="axionyx" [size]="15" color="#00A6D6" /><span style="font-size:12px;color:#172B3A">Todos os produtos foram comprados de um único fornecedor no período: não há comparação possível. Registre entradas de outros fornecedores para habilitar o comparativo.</span>
      </div>
    }
    <div style="flex:1;overflow:auto">
      <ax-state [loading]="!d()" [empty]="!!d() && !d().products.length" emptyText="Nenhuma entrada confirmada nos últimos 12 meses." />
      @if (d(); as d) {
        @if (d.products.length) {
          <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
            <thead style="position:sticky;top:0"><tr><th>Produto</th>@for (s of d.suppliers; track s.id) { <th style="text-align:center;color:#0875D1">{{ s.name }}</th> }<th style="text-align:center">Melhor custo</th><th style="text-align:center">Economia vs. maior</th></tr></thead>
            <tbody>@for (p of d.products; track p.product_id) {
              <tr><td><div class="mono" style="font-size:11px;color:#647687">{{ p.code }}</div><div style="font-size:12px;font-weight:500">{{ p.name }}</div></td>
                @for (s of d.suppliers; track s.id) {
                  <td style="text-align:center">@if (quote(p, s.id); as q) { <div class="mono" style="font-size:12px;font-weight:600" [style.color]="q.supplier_id === p.best.supplier_id ? '#18864B' : '#172B3A'">{{ q.last_cost | brl }}</div><div style="font-size:10px;color:#647687">{{ q.last_date | dt }} · {{ q.purchases }} compra(s)</div> } @else { <span class="muted">—</span> }</td>
                }
                <td style="text-align:center"><span class="badge badge-success">{{ p.best.supplier }}</span></td>
                <td style="text-align:center" class="mono">{{ savings(p) | brl }}</td></tr>
            }</tbody>
          </table>
        }
      }
    </div>
  </div>`,
})
export class MapaCotacaoPage implements OnInit {
  private api = inject(Api);
  readonly tabs = COMPRAS_TABS; readonly d = signal<any>(null);
  async ngOnInit() { try { this.d.set(await this.api.get('/purchases/price-map')); } catch { this.d.set({ suppliers: [], products: [] }); } }
  quote(p: any, sid: string) { return p.quotes.find((q: any) => q.supplier_id === sid); }
  savings(p: any) { const max = Math.max(...p.quotes.map((q: any) => q.last_cost)); return max - p.best.last_cost; }
}
