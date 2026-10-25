import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { StateComponent } from '../../shared/ui';
import { CHARTS } from '../../shared/charts';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { LookupsService } from '../../core/lookups.service';
import { PAYMENT_LABEL, addDaysIso, brl, dateBr, num, todayIso } from '../../core/format';

interface Rep { id: string; name: string; endpoint?: string; link?: string; params?: Record<string, string>; perm: string | string[]; period?: number; filters?: ('sales' | 'branch' | 'days' | 'future')[]; rowsKey?: string; chart?: boolean; }
const CATS: { nome: string; icon: string; reps: Rep[] }[] = [
  { nome: 'Comercial', icon: 'shopping-cart', reps: [
    { id: 'v-dia', name: 'Resumo de vendas (por dia)', endpoint: '/reports/sales', params: { group: 'dia' }, perm: 'relatorios.ver', period: 30, filters: ['sales', 'branch'], rowsKey: 'rows', chart: true },
    { id: 'v-mes', name: 'Vendas por mês', endpoint: '/reports/sales', params: { group: 'mes' }, perm: 'relatorios.ver', period: 365, filters: ['sales', 'branch'], rowsKey: 'rows', chart: true },
    { id: 'v-vend', name: 'Vendas por vendedor', endpoint: '/reports/sellers', perm: 'relatorios.ver', period: 30, filters: ['branch'] },
    { id: 'v-canal', name: 'Vendas por canal', endpoint: '/reports/sales', params: { group: 'canal' }, perm: 'relatorios.ver', period: 30, filters: ['branch'], rowsKey: 'rows' },
    { id: 'v-filial', name: 'Vendas por filial', endpoint: '/reports/sales', params: { group: 'filial' }, perm: 'relatorios.ver', period: 30, filters: ['branch'], rowsKey: 'rows' },
    { id: 'v-pag', name: 'Formas de pagamento', endpoint: '/reports/payments', perm: 'relatorios.ver', period: 30, filters: ['branch'] },
    { id: 'v-com', name: 'Comissões e metas', link: '/comissoes', perm: 'comissoes.ver' },
  ] },
  { nome: 'Produtos e Grade', icon: 'shirt', reps: [
    { id: 'p-prod', name: 'Vendas por produto', endpoint: '/reports/sales', params: { group: 'produto' }, perm: 'relatorios.ver', period: 30, filters: ['sales', 'branch'], rowsKey: 'rows' },
    { id: 'p-marca', name: 'Vendas por marca', endpoint: '/reports/sales', params: { group: 'marca' }, perm: 'relatorios.ver', period: 30, filters: ['sales', 'branch'], rowsKey: 'rows', chart: true },
    { id: 'p-col', name: 'Vendas por coleção', endpoint: '/reports/sales', params: { group: 'colecao' }, perm: 'relatorios.ver', period: 90, filters: ['sales', 'branch'], rowsKey: 'rows', chart: true },
    { id: 'p-cat', name: 'Vendas por categoria', endpoint: '/reports/sales', params: { group: 'categoria' }, perm: 'relatorios.ver', period: 30, filters: ['sales', 'branch'], rowsKey: 'rows', chart: true },
    { id: 'p-tam', name: 'Vendas por tamanho', endpoint: '/reports/sales', params: { group: 'tamanho' }, perm: 'relatorios.ver', period: 30, filters: ['sales', 'branch'], rowsKey: 'rows', chart: true },
    { id: 'p-cor', name: 'Vendas por cor', endpoint: '/reports/sales', params: { group: 'cor' }, perm: 'relatorios.ver', period: 30, filters: ['sales', 'branch'], rowsKey: 'rows', chart: true },
  ] },
  { nome: 'Estoque', icon: 'warehouse', reps: [
    { id: 'e-marca', name: 'Posição por marca', endpoint: '/reports/stock', params: { group: 'marca' }, perm: ['relatorios.ver', 'estoque.ver'], filters: ['branch'] },
    { id: 'e-col', name: 'Posição por coleção', endpoint: '/reports/stock', params: { group: 'colecao' }, perm: ['relatorios.ver', 'estoque.ver'], filters: ['branch'] },
    { id: 'e-tam', name: 'Posição por tamanho', endpoint: '/reports/stock', params: { group: 'tamanho' }, perm: ['relatorios.ver', 'estoque.ver'], filters: ['branch'] },
    { id: 'e-cor', name: 'Posição por cor', endpoint: '/reports/stock', params: { group: 'cor' }, perm: ['relatorios.ver', 'estoque.ver'], filters: ['branch'] },
    { id: 'e-prod', name: 'Posição por produto', endpoint: '/reports/stock', params: { group: 'produto' }, perm: ['relatorios.ver', 'estoque.ver'], filters: ['branch'] },
    { id: 'e-filial', name: 'Posição por filial', endpoint: '/reports/stock', params: { group: 'filial' }, perm: ['relatorios.ver', 'estoque.ver'] },
    { id: 'e-giro', name: 'Giro e cobertura', endpoint: '/reports/stock-turnover', perm: ['relatorios.ver', 'estoque.ver'], filters: ['days', 'branch'] },
    { id: 'e-abc', name: 'Curva ABC', link: '/curva-abc', perm: 'estoque.ver' },
  ] },
  { nome: 'Financeiro', icon: 'dollar-sign', reps: [
    { id: 'f-dre', name: 'DRE gerencial', link: '/dre', perm: ['contabilidade.ver', 'financeiro.ver'] },
    { id: 'f-fluxo', name: 'Fluxo de caixa', link: '/fluxo-caixa', perm: 'financeiro.ver' },
    { id: 'f-venc', name: 'Vencimentos (a receber e a pagar)', endpoint: '/reports/due', perm: 'financeiro.ver', filters: ['future'], rowsKey: 'rows' },
    { id: 'f-inad', name: 'Inadimplência por cliente', endpoint: '/reports/delinquency', perm: 'financeiro.ver', rowsKey: 'rows' },
  ] },
  { nome: 'Compras', icon: 'truck', reps: [
    { id: 'c-forn', name: 'Compras por fornecedor', endpoint: '/reports/purchases', params: { group: 'fornecedor' }, perm: ['relatorios.ver', 'compras.ver'], period: 90 },
    { id: 'c-mes', name: 'Compras por mês', endpoint: '/reports/purchases', params: { group: 'mes' }, perm: ['relatorios.ver', 'compras.ver'], period: 365, chart: true },
  ] },
  { nome: 'Clientes e Fiscal', icon: 'users', reps: [
    { id: 'cl-top', name: 'Melhores clientes', endpoint: '/reports/customers', perm: ['relatorios.ver', 'clientes.ver'], period: 90, rowsKey: 'top' },
    { id: 'fi-docs', name: 'Documentos fiscais por mês', endpoint: '/reports/fiscal', perm: ['relatorios.ver', 'fiscal.ver'], period: 90 },
  ] },
];
const LABEL: Record<string, string> = { label: 'Agrupamento', sales: 'Vendas', items: 'Peças', returned_items: 'Peças devolvidas', gross: 'Bruto', discount: 'Descontos', net: 'Líquido', returned_value: 'Devoluções', net_after_returns: 'Líquido após devoluções',
  ticket: 'Ticket médio', items_per_sale: 'Peças/venda', cost: 'Custo (CMV)', margin_pct: 'Margem %', name: 'Nome', revenue: 'Faturamento', discounts: 'Descontos', commission: 'Comissão', returns: 'Devoluções', kind: 'Tipo', method: 'Forma',
  total: 'Total', change: 'Troco', skus: 'SKUs', qty: 'Peças', value_sale: 'Valor de venda', value_cost: 'Valor de custo', code: 'Código', stock: 'Estoque', sold: 'Vendidas', daily_avg: 'Média/dia', coverage_days: 'Cobertura (dias)',
  type: 'Tipo', due_date: 'Vencimento', document: 'Documento', installment_no: 'Parcela', installments_total: 'de', party: 'Cliente/fornecedor', balance: 'Saldo', titles: 'Títulos', overdue: 'Vencido', max_days: 'Maior atraso (dias)', oldest_due: 'Mais antigo',
  whatsapp: 'WhatsApp', entries: 'Entradas', pieces: 'Peças', purchases: 'Compras', last_purchase: 'Última compra', month: 'Mês', model: 'Modelo', status: 'Situação', is_test: 'Teste', n: 'Qtd.' };
const MONEY = new Set(['gross', 'discount', 'net', 'returned_value', 'net_after_returns', 'ticket', 'cost', 'revenue', 'discounts', 'commission', 'returns', 'total', 'change', 'value_sale', 'value_cost', 'balance', 'overdue']);
const NO_SUM = new Set(['ticket', 'items_per_sale', 'margin_pct', 'daily_avg', 'coverage_days', 'max_days', 'installment_no', 'installments_total']);
const HIDE = new Set(['key', 'id', 'seller_id']);

@Component({
  selector: 'ax-relatorios',
  imports: [FormsModule, IconComponent, StateComponent, ...CHARTS],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:24px;display:flex;align-items:flex-start"><div style="flex:1"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Central de Relatórios</h1><p style="font-size:13px;color:#647687">Relatórios gerenciais calculados diretamente dos registros, com filtros e exportação CSV</p></div>
      @if (rep()) { <button class="btn-secondary" style="font-size:12px" (click)="rep.set(null)"><ax-icon name="layout-grid" [size]="13" /> Todos os relatórios</button> }</div>
    @if (!rep()) {
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:16px">
        @for (cat of cats(); track cat.nome) {
          <div class="card" style="overflow:hidden">
            <div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;display:flex;align-items:center;gap:8px;background:#F8FAFC"><ax-icon [name]="cat.icon" [size]="15" color="#0875D1" /><span style="font-size:13px;font-weight:700;color:#172B3A">{{ cat.nome }}</span></div>
            <div style="padding:8px 0">
              @for (r of cat.reps; track r.id) {
                <div class="rep-row" style="padding:7px 16px;display:flex;align-items:center;justify-content:space-between;cursor:pointer" (click)="open(r)">
                  <span style="font-size:13px;color:#172B3A">{{ r.name }}</span>
                  <div style="display:flex;gap:4px;opacity:0.6">
                    @if (r.link) { <ax-icon name="external-link" [size]="12" /> } @else { <button class="btn-ghost" style="padding:2px 4px" aria-label="Visualizar"><ax-icon name="eye" [size]="12" /></button><button class="btn-ghost" style="padding:2px 4px" (click)="$event.stopPropagation(); csvDirect(r)" aria-label="CSV"><ax-icon name="download" [size]="12" /></button> }
                  </div>
                </div>
              }
            </div>
          </div>
        }
      </div>
    } @else {
      @let r = rep()!;
      <div class="card" style="padding:14px 16px;margin-bottom:14px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:1;min-width:220px"><div style="font-size:15px;font-weight:700;color:#172B3A">{{ r.name }}</div><div class="muted" style="font-size:11px">{{ subtitle() }}</div></div>
        @if (r.period || has('future')) { <div><label class="field-label">De</label><input type="date" class="input-field" [(ngModel)]="f.from" /></div><div><label class="field-label">Até</label><input type="date" class="input-field" [(ngModel)]="f.to" /></div> }
        @if (has('days')) { <div><label class="field-label">Janela de vendas</label><select class="input-field" [(ngModel)]="f.days"><option [ngValue]="30">30 dias</option><option [ngValue]="60">60 dias</option><option [ngValue]="90">90 dias</option><option [ngValue]="180">180 dias</option></select></div> }
        @if (has('branch')) { <div><label class="field-label">Filial</label><select class="input-field" [(ngModel)]="f.branch"><option value="current">Filial atual</option>@if (auth.me()?.user?.allBranches) { <option value="all">Todas</option> }
          @for (b of lk.data()?.branches ?? []; track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select></div> }
        @if (has('sales')) {
          <div><label class="field-label">Marca</label><select class="input-field" style="width:130px" [(ngModel)]="f.brand"><option value="">Todas</option>@for (x of lk.data()?.brands ?? []; track x.id) { <option [value]="x.id">{{ x.name }}</option> }</select></div>
          <div><label class="field-label">Coleção</label><select class="input-field" style="width:130px" [(ngModel)]="f.collection"><option value="">Todas</option>@for (x of lk.data()?.collections ?? []; track x.id) { <option [value]="x.id">{{ x.name }}</option> }</select></div>
          <div><label class="field-label">Tamanho</label><select class="input-field" style="width:90px" [(ngModel)]="f.size"><option value="">Todos</option>@for (x of sizeCodes(); track x) { <option [value]="x">{{ x }}</option> }</select></div>
          <div><label class="field-label">Cor</label><select class="input-field" style="width:120px" [(ngModel)]="f.color"><option value="">Todas</option>@for (x of lk.data()?.colors ?? []; track x.id) { <option [value]="x.id">{{ x.name }}</option> }</select></div>
          @if (auth.can('vendas.todas')) { <div><label class="field-label">Vendedor</label><select class="input-field" style="width:140px" [(ngModel)]="f.seller"><option value="">Todos</option>@for (x of lk.data()?.sellers ?? []; track x.id) { <option [value]="x.id">{{ x.name }}</option> }</select></div> }
        }
        <button class="btn-primary" style="font-size:12px" (click)="run()"><ax-icon name="play" [size]="13" /> Gerar</button>
        <button class="btn-secondary" style="font-size:12px" [disabled]="!rows().length" (click)="csv()"><ax-icon name="download" [size]="13" /> CSV</button>
        <button class="btn-secondary" style="font-size:12px" [disabled]="!rows().length" (click)="print()"><ax-icon name="printer" [size]="13" /> Imprimir</button>
      </div>
      <ax-state [loading]="loading()" [error]="error()" [empty]="!loading() && !error() && !rows().length" emptyText="Nenhum dado no período/filtro." />
      @if (!loading() && rows().length) {
        @if (r.chart && chartSeries().length) { <div class="card no-print" style="padding:16px;margin-bottom:14px"><ax-bar-chart [labels]="chartLabels()" [series]="chartSeries()" [height]="200" [fmt]="moneyFmt" /></div> }
        @if (check(); as c) { <div class="state-info" style="margin:0 0 10px;font-size:12px"><ax-icon name="check-circle-2" [size]="13" />Conferência: {{ c.sales }} venda(s), total {{ money(c.total) }} pelos cabeçalhos das vendas no mesmo período/filtro.</div> }
        <div class="card" style="overflow:auto" id="report-area">
          <table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr>@for (c of cols(); track c) { <th [class.num]="isNum(c)">{{ LABEL[c] || c }}</th> }</tr></thead>
            <tbody>@for (row of rows(); track $index) { <tr>@for (c of cols(); track c) { <td [class.num]="isNum(c)" [class.mono]="isNum(c)" style="font-size:12px">{{ cell(c, row[c]) }}</td> }</tr> }</tbody>
            <tfoot><tr style="font-weight:700;background:#F8FAFC">@for (c of cols(); track c; let i = $index) { <td [class.num]="isNum(c)" class="mono" style="font-size:12px">{{ i === 0 ? 'Total (' + rows().length + ')' : totals()[c] === undefined ? '' : cell(c, totals()[c]) }}</td> }</tr></tfoot>
          </table>
        </div>
      }
    }
  </div>`,
  styles: [`.rep-row:hover { background:#F4F7FA; }`],
})
export class RelatoriosPage implements OnInit {
  private api = inject(Api); private router = inject(Router); readonly auth = inject(AuthService); readonly lk = inject(LookupsService);
  readonly LABEL = LABEL; readonly moneyFmt = (v: number) => brl(v);
  readonly rep = signal<Rep | null>(null); readonly data = signal<any>(null); readonly loading = signal(false); readonly error = signal<string | null>(null);
  f: any = {};
  readonly cats = computed(() => CATS.map((c) => ({ ...c, reps: c.reps.filter((r) => this.auth.can(r.perm as any)) })).filter((c) => c.reps.length));
  readonly sizeCodes = computed(() => [...new Set((this.lk.data()?.sizes ?? []).map((s) => s.code))]);
  readonly rows = computed<any[]>(() => { const d = this.data(); const r = this.rep(); if (!d || !r) return []; return (r.rowsKey ? d[r.rowsKey] : d) ?? []; });
  readonly check = computed(() => this.data()?.check ?? null);
  readonly cols = computed(() => { const first = this.rows()[0]; return first ? Object.keys(first).filter((k) => !HIDE.has(k)) : []; });
  readonly totals = computed(() => { const t: Record<string, number> = {}; for (const c of this.cols()) { if (NO_SUM.has(c) || c === 'label') continue; const vals = this.rows().map((r) => r[c]); if (vals.every((v) => typeof v === 'number' || (v !== null && v !== '' && !isNaN(Number(v)) && typeof v !== 'boolean' && !/^\d{4}-/.test(String(v))))) t[c] = vals.reduce((s, v) => s + Number(v || 0), 0); } return t; });
  readonly chartLabels = computed(() => this.rows().slice(0, 24).map((r) => String(r.label ?? '').slice(0, 14)));
  readonly chartSeries = computed(() => { const k = this.rows()[0]?.net_after_returns !== undefined ? 'net_after_returns' : this.rows()[0]?.total !== undefined ? 'total' : null; return k ? [{ name: 'Valor', color: '#0875D1', values: this.rows().slice(0, 24).map((r) => Number(r[k])) }] : []; });
  readonly subtitle = computed(() => { const d = this.data(); return d?.from ? `Período ${dateBr(d.from)} a ${dateBr(d.to)}` : 'Valores calculados no momento da consulta'; });
  ngOnInit() { this.lk.ensure(); }
  has(x: string) { return !!this.rep()?.filters?.includes(x as any); }
  open(r: Rep) {
    if (r.link) { this.router.navigateByUrl(r.link); return; }
    this.rep.set(r); this.data.set(null);
    this.f = { from: r.filters?.includes('future') ? todayIso() : addDaysIso(todayIso(), -((r.period ?? 30) - 1)), to: r.filters?.includes('future') ? addDaysIso(todayIso(), 30) : todayIso(), branch: 'current', days: 30, brand: '', collection: '', size: '', color: '', seller: '' };
    this.run();
  }
  query(format?: string) {
    const r = this.rep()!; const q: any = { ...(r.params ?? {}), format };
    if (r.period || this.has('future')) { q.from = this.f.from; q.to = this.f.to; }
    if (this.has('branch')) q.branch = this.f.branch;
    if (this.has('days')) q.days = this.f.days;
    if (this.has('sales')) Object.assign(q, { brand: this.f.brand || undefined, collection: this.f.collection || undefined, size: this.f.size || undefined, color: this.f.color || undefined, seller: this.f.seller || undefined });
    return q;
  }
  async run() { this.loading.set(true); this.error.set(null); try { this.data.set(await this.api.get(this.rep()!.endpoint!, this.query())); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); } }
  csv() { this.api.download(this.rep()!.endpoint!, this.query('csv'), this.rep()!.id + '.csv'); }
  csvDirect(r: Rep) { this.rep.set(r); this.f = { from: addDaysIso(todayIso(), -((r.period ?? 30) - 1)), to: r.filters?.includes('future') ? addDaysIso(todayIso(), 30) : todayIso(), branch: 'current', days: 30 }; if (r.filters?.includes('future')) this.f.from = todayIso(); this.csv(); this.run(); }
  print() { window.print(); }
  isNum(c: string) { const v = this.rows()[0]?.[c]; return MONEY.has(c) || NO_SUM.has(c) || typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)) && !/^\d{4}-/.test(v) && c !== 'whatsapp' && c !== 'code' && c !== 'document'); }
  money(v: any) { return brl(v); }
  cell(c: string, v: any) {
    if (v === null || v === undefined || v === '') return '—';
    if (MONEY.has(c)) return brl(v);
    if (c === 'margin_pct') return num(v, 1) + '%';
    if (c === 'daily_avg' || c === 'items_per_sale') return num(v, 2);
    if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
    if (c === 'kind' || c === 'method') return PAYMENT_LABEL[v] ?? v;
    if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return dateBr(v);
    if (typeof v === 'number' || (!isNaN(Number(v)) && c !== 'whatsapp' && c !== 'code' && c !== 'document' && c !== 'label')) return num(v, 0);
    return String(v);
  }
}
