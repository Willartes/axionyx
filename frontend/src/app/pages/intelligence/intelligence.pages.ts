import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, StateComponent } from '../../shared/ui';
import { CHARTS, Series } from '../../shared/charts';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, brl, dateBr, num } from '../../core/format';

const TITLE: Record<string, string> = { 'estoque-inteligente': 'Risco de ruptura de estoque', 'estoque-posicao': 'Estoque parado', condicionais: 'Condicionais vencidos', crediario: 'Inadimplência no crediário', clientes: 'Concentração / relacionamento com clientes', relatorios: 'Desconto médio em alta' };
const SOURCE: Record<string, string> = { 'estoque-inteligente': 'Estoque + vendas 30 dias', 'estoque-posicao': 'Estoque + vendas 60 dias', condicionais: 'Condicional', crediario: 'Contas a receber', clientes: 'Vendas 90 dias / cadastro', relatorios: 'Vendas 60 dias' };
const DISMISS_KEY = 'axionyx.insights.dismissed';
const readDismissed = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}'); } catch { return {}; } };

/** Lista de descobertas (regras sobre dados reais, cada uma com evidência numérica). */
@Component({
  selector: 'ax-insights-list',
  imports: [IconComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px"><ax-icon name="axionyx" [size]="15" color="#00A6D6" /><span style="font-size:14px;font-weight:700;color:#172B3A">Principais Descobertas</span>
      <span class="badge badge-cyan">{{ visible().length }} insights</span>@if (hidden() > 0) { <a class="link" style="font-size:11px" (click)="restore()">mostrar {{ hidden() }} ignorado(s)</a> }</div>
    <ax-state [loading]="!data()" [empty]="!!data() && !visible().length" emptyText="Nenhum alerta relevante no momento." emptyIcon="badge-check" />
    <div style="display:flex;flex-direction:column;gap:10px">
      @for (ins of visible(); track ins.key) {
        <div [style.border]="'1px solid ' + (ins.type === 'danger' ? '#F4CCCC' : ins.type === 'warning' ? '#F5E0B0' : '#C8DFEF')" style="background:white;border-radius:8px;padding:14px 16px;display:flex;gap:16px;align-items:flex-start">
          <div [style.background]="ins.type === 'danger' ? '#C93636' : ins.type === 'warning' ? '#D99000' : '#2878C7'" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:5px"></div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="font-size:13px;font-weight:600;color:#172B3A">{{ ins.title }}</span>
              <span class="badge" [class]="ins.type === 'danger' ? 'badge badge-danger' : ins.type === 'warning' ? 'badge badge-warning' : 'badge badge-info'">{{ ins.severity }}</span></div>
            <p style="font-size:12px;color:#647687;line-height:1.5;margin-bottom:6px">{{ ins.text }}</p>
            <div style="font-size:11px;color:#647687">Fonte: <strong>{{ ins.source }}</strong> · regra determinística sobre os dados do sistema</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn-ghost" style="font-size:11px" (click)="router.navigateByUrl('/' + ins.action)">{{ ins.label || 'Investigar' }}</button>
            <button class="btn-ghost" style="font-size:11px" (click)="router.navigateByUrl('/simulacoes')">Simular</button>
            <button class="btn-ghost" style="font-size:11px;color:#A0AFBF" (click)="dismiss(ins.key)">Ignorar</button>
          </div>
        </div>
      }
    </div>
  </div>`,
})
export class InsightsListComponent implements OnInit {
  private api = inject(Api); readonly router = inject(Router);
  readonly data = signal<any>(null); readonly dismissed = signal<Record<string, string>>(readDismissed());
  readonly all = computed(() => (this.data()?.items ?? []).map((i: any) => ({ ...i, key: i.action + ':' + i.text, title: TITLE[i.action] ?? 'Alerta', source: SOURCE[i.action] ?? 'AXIONYX' })));
  readonly visible = computed(() => this.all().filter((i: any) => !this.dismissed()[i.key]));
  readonly hidden = computed(() => this.all().length - this.visible().length);
  async ngOnInit() { try { this.data.set(await this.api.get('/intelligence/insights')); } catch { this.data.set({ items: [] }); } }
  dismiss(k: string) { const d = { ...this.dismissed(), [k]: new Date().toISOString() }; this.dismissed.set(d); try { localStorage.setItem(DISMISS_KEY, JSON.stringify(d)); } catch { /* */ } }
  restore() { this.dismissed.set({}); try { localStorage.removeItem(DISMISS_KEY); } catch { /* */ } }
}

@Component({
  selector: 'ax-intelligence',
  imports: [IconComponent, InsightsListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px;display:flex;flex-direction:column;gap:20px">
    <div><div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="width:36px;height:36px;background:linear-gradient(135deg,#0875D1,#00A6D6);border-radius:9px;display:flex;align-items:center;justify-content:center"><ax-icon name="brain" [size]="20" color="white" /></div>
      <h1 style="font-size:22px;font-weight:800;color:#172B3A;letter-spacing:-0.5px">AXIONYX Intelligence Center</h1></div>
      <p style="font-size:13px;color:#647687;padding-left:46px">Estatística e regras de negócio sobre os dados reais da empresa · sem modelos externos · atualizado em {{ now }}</p></div>
    <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px">
      @for (m of modules; track m.label) {
        <div class="card" style="padding:16px;cursor:pointer" (click)="router.navigateByUrl(m.screen)" (mouseenter)="$any($event.currentTarget).style.boxShadow='0 4px 12px rgba(0,0,0,0.08)'" (mouseleave)="$any($event.currentTarget).style.boxShadow='none'">
          <div [style.background]="m.bg" style="width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:10px"><ax-icon [name]="m.icon" [size]="20" [color]="m.color" /></div>
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:2px">{{ m.label }}</div><div style="font-size:11px;color:#647687">{{ m.sub }}</div>
        </div>
      }
    </div>
    <ax-insights-list />
  </div>`,
})
export class IntelligencePage {
  readonly router = inject(Router);
  readonly now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  readonly modules = [
    { label: 'Previsão de Demanda', icon: 'trending-up', color: '#0875D1', bg: '#E3EFF9', screen: '/forecast', sub: '5 métodos comparados por backtest' },
    { label: 'Estoque Inteligente', icon: 'flask-conical', color: '#18864B', bg: '#E8F5EE', screen: '/estoque-inteligente', sub: 'Reposição por ritmo de vendas' },
    { label: 'Pesquisa Operacional', icon: 'git-branch', color: '#D99000', bg: '#FFF4E0', screen: '/pesquisa-operacional', sub: 'Mix de compra ótimo por orçamento' },
    { label: 'Simulações', icon: 'layers', color: '#2878C7', bg: '#E3EFF9', screen: '/simulacoes', sub: 'Cenários sobre a base dos últimos 90 dias' },
  ];
}

@Component({
  selector: 'ax-ia-insights',
  imports: [InsightsListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div style="padding:24px"><div style="margin-bottom:20px"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Insights</h1><p style="font-size:13px;color:#647687">Descobertas automáticas a partir de regras sobre os dados do sistema · {{ month }}</p></div><ax-insights-list /></div>`,
})
export class IaInsightsPage { readonly month = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); }

// ─── Previsão de demanda (backtest de 5 métodos sobre 12 semanas reais) ────
type Model = { name: string; fit: (ys: number[]) => number; };
const MODELS: Model[] = [
  { name: 'Naive (última semana)', fit: (ys) => ys[ys.length - 1] },
  { name: 'Média móvel (4 semanas)', fit: (ys) => { const t = ys.slice(-4); return t.reduce((a, b) => a + b, 0) / t.length; } },
  { name: 'Suavização exponencial (α=0,3)', fit: (ys) => ys.reduce((s, y, i) => (i === 0 ? y : 0.3 * y + 0.7 * s), 0) },
  { name: 'Regressão linear', fit: (ys) => { const n = ys.length; if (n < 2) return ys[0] ?? 0; const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0; ys.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; }); const b = sxy / sxx; return Math.max(0, my + b * (n - mx)); } },
  { name: 'Média histórica', fit: (ys) => ys.reduce((a, b) => a + b, 0) / ys.length },
];
function backtest(ys: number[], m: Model) {
  const errs: { e: number; y: number }[] = [];
  for (let t = 4; t < ys.length; t++) errs.push({ e: m.fit(ys.slice(0, t)) - ys[t], y: ys[t] });
  const n = errs.length || 1;
  const mae = errs.reduce((a, x) => a + Math.abs(x.e), 0) / n;
  const rmse = Math.sqrt(errs.reduce((a, x) => a + x.e ** 2, 0) / n);
  const nz = errs.filter((x) => x.y > 0);
  const mape = nz.length ? (nz.reduce((a, x) => a + Math.abs(x.e) / x.y, 0) / nz.length) * 100 : null;
  const sumY = errs.reduce((a, x) => a + x.y, 0);
  const bias = sumY ? (errs.reduce((a, x) => a + x.e, 0) / sumY) * 100 : 0;
  return { mae, rmse, mape, bias, sd: rmse };
}

@Component({
  selector: 'ax-forecast',
  imports: [FormsModule, IconComponent, StateComponent, ...CHARTS],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px;display:flex;flex-direction:column;gap:16px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Previsão de Demanda</h1>
        <p style="font-size:13px;color:#647687">Método: {{ model() }} · {{ product() ? 'Produto: ' + product().name + ' (peças)' : 'Faturamento total (R$)' }} · Horizonte: {{ horizon }} semanas</p></div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="input-field" style="width:240px;font-size:12px" [ngModel]="productId" (ngModelChange)="productId = $event; run()"><option value="">Faturamento total</option>@for (p of products(); track p.id) { <option [value]="p.id">{{ p.code }} · {{ p.name }}</option> }</select>
        <select class="input-field" style="width:230px;font-size:12px" [ngModel]="model()" (ngModelChange)="model.set($event)">@for (m of ranking(); track m.name) { <option [value]="m.name">{{ m.name }}</option> }</select>
        <select class="input-field" style="width:120px;font-size:12px" [(ngModel)]="horizon" (ngModelChange)="tick.set(tick() + 1)">@for (h of [2,4,6,8]; track h) { <option [ngValue]="h">{{ h }} semanas</option> }</select>
        <button class="btn-primary" style="font-size:12px" (click)="run()"><ax-icon name="play" [size]="13" /> Executar previsão</button>
      </div>
    </div>
    <ax-state [loading]="!hist()" />
    @if (hist()) {
      <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:10px">
        @for (k of metrics(); track k[0]) { <div class="kpi-card" style="text-align:center"><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">{{ k[0] }}</div><div class="mono" style="font-size:20px;font-weight:700;color:#0875D1">{{ k[1] }}</div></div> }
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:4px">Série histórica semanal + Previsão</div>
        <div style="display:flex;gap:16px;font-size:11px;color:#647687;margin-bottom:12px">
          <span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:2px;background:#0875D1;display:inline-block"></span> Real</span>
          <span style="display:flex;align-items:center;gap:4px"><span style="width:12px;border-top:2px dashed #00A6D6;display:inline-block"></span> Previsão</span>
          <span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:8px;background:rgba(0,166,214,0.15);display:inline-block"></span> Intervalo ~80% (±1,28 × RMSE do backtest)</span>
        </div>
        <ax-line-chart [labels]="labels()" [series]="series()" [bandValues]="band()" [height]="240" [area]="false" [fmt]="fmt()" />
      </div>
      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600;color:#172B3A">Comparação de Métodos <span class="muted" style="font-weight:400;font-size:11px">— backtest de previsão 1 semana à frente sobre as últimas {{ (hist()?.length ?? 4) - 4 }} semanas</span></div>
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Método</th><th style="text-align:center">MAPE</th><th style="text-align:center">MAE</th><th style="text-align:center">RMSE</th><th style="text-align:center">Viés</th><th style="text-align:center">Status</th></tr></thead>
          <tbody>@for (m of ranking(); track m.name; let i = $index) {
            <tr [style.background]="i === 0 ? '#F0F7FF' : null" style="cursor:pointer" (click)="model.set(m.name)">
              <td [style.font-weight]="i === 0 ? 700 : 400">@if (i === 0) { <ax-icon name="axionyx" [size]="13" color="#00A6D6" /> } {{ m.name }}</td>
              <td class="mono" style="text-align:center;font-size:12px" [style.color]="m.mape !== null && m.mape < 20 ? '#18864B' : '#D99000'">{{ m.mape === null ? '—' : m.mape.toFixed(1).replace('.', ',') + '%' }}</td>
              <td class="mono" style="text-align:center;font-size:12px">{{ f(m.mae) }}</td><td class="mono" style="text-align:center;font-size:12px">{{ f(m.rmse) }}</td>
              <td class="mono" style="text-align:center;font-size:12px">{{ (m.bias > 0 ? '+' : '') + m.bias.toFixed(1).replace('.', ',') }}%</td>
              <td style="text-align:center">@if (i === 0) { <span class="badge badge-cyan">Recomendado</span> } @else if (m.name === model()) { <span class="badge badge-info">Selecionado</span> } @else { <span class="badge badge-muted">Disponível</span> }</td></tr>
          }</tbody>
        </table>
      </div>
      <p style="font-size:11px;color:#647687">Com apenas 12 semanas de histórico, sazonalidade anual não é capturada. Use a previsão como apoio à decisão de compra, não como garantia.</p>
    }
  </div>`,
})
export class ForecastPage implements OnInit {
  private api = inject(Api);
  readonly hist = signal<any[] | null>(null); readonly products = signal<any[]>([]); readonly product = signal<any>(null); readonly model = signal(''); readonly tick = signal(0);
  productId = ''; horizon = 4;
  async ngOnInit() { this.api.get<any>('/products', { size: 200, active: 'true' }).then((r) => this.products.set(r.items)).catch(() => {}); this.run(); }
  async run() {
    this.hist.set(null); this.product.set(this.products().find((p) => p.id === this.productId) ?? null);
    const r: any = await this.api.get('/intelligence/forecast', { product: this.productId || undefined });
    this.hist.set(r.history); this.model.set(this.ranking()[0]?.name ?? MODELS[3].name);
  }
  readonly ys = computed(() => (this.hist() ?? []).map((h) => Number(this.productId ? h.qty : h.revenue)));
  readonly ranking = computed(() => { const ys = this.ys(); if (ys.length < 6) return MODELS.map((m) => ({ name: m.name, mae: 0, rmse: 0, mape: null as number | null, bias: 0 }));
    return MODELS.map((m) => ({ name: m.name, ...backtest(ys, m) })).sort((a, b) => (a.mape ?? 1e9) - (b.mape ?? 1e9) || a.rmse - b.rmse); });
  readonly cur = computed(() => this.ranking().find((m) => m.name === this.model()) ?? this.ranking()[0]);
  readonly forecast = computed(() => { this.tick(); const m = MODELS.find((x) => x.name === this.model()) ?? MODELS[3]; const ys = [...this.ys()]; const out: number[] = [];
    for (let k = 0; k < this.horizon; k++) { const v = Math.max(0, m.fit(ys)); out.push(v); ys.push(v); } return out; });
  readonly labels = computed(() => { this.tick(); const h = this.hist() ?? []; const last = h.length ? new Date(h[h.length - 1].week + 'T12:00:00') : new Date();
    const fut = Array.from({ length: this.horizon }, (_, i) => { const d = new Date(last); d.setDate(d.getDate() + 7 * (i + 1)); return d.toISOString().slice(0, 10); });
    return [...h.map((x) => x.week), ...fut].map((w) => dateBr(w).slice(0, 5)); });
  readonly series = computed<Series[]>(() => { const ys = this.ys(); const fc = this.forecast(); const n = ys.length;
    return [{ name: 'Real', color: '#0875D1', values: [...ys, ...fc.map(() => null)] as any }, { name: 'Previsão', color: '#00A6D6', dashed: true, values: [...ys.map((_, i) => (i === n - 1 ? ys[i] : null)), ...fc] as any }]; });
  readonly band = computed<[(number | null)[], (number | null)[]]>(() => { const n = this.ys().length; const sd = this.cur()?.rmse ?? 0; const fc = this.forecast();
    return [[...Array(n).fill(null), ...fc.map((v, i) => Math.max(0, v - 1.28 * sd * Math.sqrt(i + 1)))], [...Array(n).fill(null), ...fc.map((v, i) => v + 1.28 * sd * Math.sqrt(i + 1))]]; });
  readonly fmt = computed(() => (this.productId ? (v: number) => num(v, 0) : (v: number) => brl(v)));
  f(v: number) { return this.productId ? num(v, 1) : brl(v); }
  readonly metrics = computed(() => { const c = this.cur(); const fc = this.forecast(); return [['MAE', this.f(c?.mae ?? 0)], ['MAPE', c?.mape === null || c?.mape === undefined ? '—' : c.mape.toFixed(1).replace('.', ',') + '%'], ['RMSE', this.f(c?.rmse ?? 0)],
    ['Viés', ((c?.bias ?? 0) > 0 ? '+' : '') + (c?.bias ?? 0).toFixed(1).replace('.', ',') + '%'], ['Total previsto', this.f(fc.reduce((a, b) => a + b, 0))]]; });
}

// ─── Estoque inteligente (reposição) ───────────────────────────────────────
@Component({
  selector: 'ax-estoque-inteligente',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:16px;gap:12px;flex-wrap:wrap">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Estoque Inteligente</h1>
        <p style="font-size:13px;color:#647687">Sugestão = média diária (30 dias) × (prazo de reposição + cobertura desejada) − saldo · {{ urgent() }} reposição(ões) recomendada(s)</p></div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div><label class="field-label">Prazo do fornecedor (dias)</label><input type="number" min="1" max="120" class="input-field mono" style="width:110px" [(ngModel)]="lead" (change)="load()" /></div>
        <div><label class="field-label">Cobertura (dias)</label><input type="number" min="1" max="120" class="input-field mono" style="width:110px" [(ngModel)]="cover" (change)="load()" /></div>
        @if (auth.can('compras.editar')) { <button class="btn-primary" style="font-size:12px" [disabled]="!sel().length" (click)="openOrder()">Gerar Pedido de Compra ({{ sel().length }})</button> }
      </div>
    </div>
    <div class="card" style="overflow:hidden">
      <table class="data-table" style="width:100%;border-collapse:collapse">
        <thead style="position:sticky;top:0"><tr><th style="width:40px"><input type="checkbox" (change)="all($any($event.target).checked)" /></th><th>Produto</th><th style="text-align:center">Estoque Atual</th><th style="text-align:center">Venda média/dia</th><th style="text-align:center">Cobertura</th><th style="text-align:center">Qtd. Sugerida</th><th>Fornecedor</th><th class="num">Custo Estimado</th><th>Urgência</th></tr></thead>
        <tbody>@for (r of rows(); track r.variant_id) {
          <tr [style.background]="r.risk === 'alto' ? '#FEF8F8' : null">
            <td><input type="checkbox" [checked]="sel().includes(r.variant_id)" (change)="toggle(r.variant_id)" [disabled]="!r.suggested" /></td>
            <td><div class="mono" style="font-size:11px;color:#647687">{{ r.sku }}</div><div style="font-size:12px;font-weight:500">{{ r.name }} {{ r.color }} {{ r.size }}</div></td>
            <td class="mono" style="text-align:center;font-size:12px;font-weight:600" [style.color]="r.risk === 'alto' ? '#C93636' : '#172B3A'">{{ r.stock }}</td>
            <td class="mono" style="text-align:center;font-size:12px">{{ r.daily_avg | num:2 }}</td>
            <td class="mono" style="text-align:center;font-size:12px">{{ r.coverage_days === null ? '—' : r.coverage_days + 'd' }}</td>
            <td class="mono" style="text-align:center;font-size:12px;font-weight:700" [style.color]="r.suggested > 0 ? '#0875D1' : '#A0AFBF'">{{ r.suggested || '—' }}</td>
            <td style="font-size:12px">{{ r.supplier || '—' }}</td><td class="num" style="font-weight:600">{{ r.cost === null ? '—' : (r.suggested * r.cost | brl) }}</td>
            <td><span class="badge" [class]="r.risk === 'alto' ? 'badge badge-danger' : r.risk === 'medio' ? 'badge badge-warning' : 'badge badge-success'">{{ r.risk === 'alto' ? 'Urgente' : r.risk === 'medio' ? 'Alto' : 'OK' }}</span></td>
          </tr>
        }</tbody>
      </table>
      <ax-state [loading]="loading()" [empty]="!loading() && !rows().length" emptyText="Sem vendas nos últimos 30 dias para calcular reposição." />
    </div>
  </div>
  <ax-modal [(open)]="orderOpen" title="Gerar pedido de compra" icon="clipboard-list" [width]="520">
    <p style="font-size:12px;color:#647687;margin-bottom:8px">{{ sel().length }} SKU(s), {{ selQty() }} peça(s), custo estimado {{ selCost() | brl }}. O pedido é criado em aberto para revisão.</p>
    <label class="field-label">Fornecedor *</label><select class="input-field" [(ngModel)]="supplierId">@for (s of lk.data()?.suppliers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select>
    <div footer><button class="btn-secondary" (click)="orderOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!supplierId" (click)="createOrder()">Criar pedido</button></div>
  </ax-modal>`,
})
export class EstoqueInteligentePage implements OnInit {
  private api = inject(Api); private router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly rows = signal<any[]>([]); readonly loading = signal(true); readonly sel = signal<string[]>([]); readonly orderOpen = signal(false);
  lead = 15; cover = 30; supplierId = '';
  readonly urgent = computed(() => this.rows().filter((r) => r.risk !== 'baixo' && r.suggested > 0).length);
  readonly selRows = computed(() => this.rows().filter((r) => this.sel().includes(r.variant_id)));
  readonly selQty = computed(() => this.selRows().reduce((s, r) => s + r.suggested, 0));
  readonly selCost = computed(() => this.selRows().reduce((s, r) => s + r.suggested * Number(r.cost || 0), 0));
  ngOnInit() { this.lk.ensure(); this.load(); }
  async load() { this.loading.set(true); try { const r: any = await this.api.get('/intelligence/replenishment', { leadDays: this.lead, coverDays: this.cover }); this.rows.set(r.items); this.sel.set(r.items.filter((x: any) => x.risk === 'alto' && x.suggested > 0).map((x: any) => x.variant_id)); } finally { this.loading.set(false); } }
  toggle(id: string) { this.sel.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])); }
  all(on: boolean) { this.sel.set(on ? this.rows().filter((r) => r.suggested > 0).map((r) => r.variant_id) : []); }
  openOrder() { const sup = this.selRows().find((r) => r.supplier_id)?.supplier_id; this.supplierId = sup ?? this.lk.data()?.suppliers?.[0]?.id ?? ''; this.orderOpen.set(true); }
  async createOrder() {
    try { const o: any = await this.api.post('/purchase-orders', { supplierId: this.supplierId, notes: `Gerado pelo Estoque Inteligente (prazo ${this.lead}d, cobertura ${this.cover}d)`, items: this.selRows().map((r) => ({ variantId: r.variant_id, qty: r.suggested, unitCost: Number(r.cost || 0) })) });
      this.toast.success(`Pedido de compra PC-${o.number} criado.`); this.orderOpen.set(false); this.router.navigateByUrl('/pedidos-compra'); } catch (e) { this.toast.error(e); }
  }
}

// ─── Pesquisa operacional: mix de compra ótimo ─────────────────────────────
@Component({
  selector: 'ax-pesquisa-operacional',
  imports: [FormsModule, IconComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px;display:flex;flex-direction:column;gap:16px">
    <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Pesquisa Operacional — Otimização do Mix de Compra</h1>
      <p style="font-size:13px;color:#647687">Programação linear: maximizar a margem bruta esperada sujeita ao orçamento de compras e ao limite de demanda prevista de cada SKU</p></div>
    <div style="display:grid;grid-template-columns:360px 1fr;gap:16px;align-items:start">
      <div class="card" style="padding:18px">
        <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:14px">Parâmetros de Entrada</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div><label class="field-label">Orçamento de compras (R$)</label><input type="number" min="0" step="100" class="input-field mono" [(ngModel)]="budget" /></div>
          <div><label class="field-label">Horizonte de demanda (dias)</label><input type="number" min="7" max="120" class="input-field mono" [(ngModel)]="days" /></div>
          <div><label class="field-label">Considerar estoque atual</label><select class="input-field" [(ngModel)]="useStock"><option [ngValue]="true">Sim — comprar só o que falta</option><option [ngValue]="false">Não</option></select></div>
          <div style="font-size:11px;color:#647687;line-height:1.5">Variáveis: quantidade xᵢ por SKU. Objetivo: max Σ (preçoᵢ − custoᵢ)·xᵢ. Restrições: Σ custoᵢ·xᵢ ≤ orçamento; 0 ≤ xᵢ ≤ demandaᵢ. Com uma única restrição de orçamento a solução ótima é obtida ordenando pela razão margem/custo (método exato para o problema contínuo; quantidades arredondadas para baixo).</div>
        </div>
        <button class="btn-primary" style="width:100%;justify-content:center;margin-top:14px;font-size:12px" [disabled]="busy()" (click)="solve()"><ax-icon name="play" [size]="13" /> Resolver modelo</button>
      </div>
      <div class="card" style="padding:18px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px"><div style="font-size:13px;font-weight:600;color:#172B3A">Resultado Ótimo</div>@if (res()) { <span class="badge badge-success">Solução encontrada</span> }</div>
        @if (res(); as r) {
          <div style="display:flex;gap:28px;margin-bottom:14px">
            <div><div style="font-size:24px;font-weight:800;color:#18864B">{{ r.margin | brl }}</div><div style="font-size:12px;color:#647687">margem bruta esperada</div></div>
            <div><div style="font-size:24px;font-weight:800;color:#172B3A">{{ r.spent | brl }}</div><div style="font-size:12px;color:#647687">de {{ budget | brl }} utilizados ({{ r.spent / budget * 100 | num:0 }}%)</div></div>
            <div><div style="font-size:24px;font-weight:800;color:#0875D1">{{ r.units }}</div><div style="font-size:12px;color:#647687">peças · {{ r.items.length }} SKU(s)</div></div>
          </div>
          <div style="max-height:420px;overflow:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>SKU</th><th>Produto</th><th style="text-align:center">Demanda</th><th style="text-align:center">Qtd. Ótima</th><th class="num">Margem Unit.</th><th class="num">Custo</th><th class="num">Margem</th></tr></thead>
            <tbody>@for (x of r.items; track x.variant_id) { <tr><td class="mono" style="font-size:11px">{{ x.sku }}</td><td style="font-size:12px">{{ x.name }} {{ x.color }} {{ x.size }}</td><td class="mono" style="text-align:center;font-size:12px">{{ x.demand }}</td>
              <td class="mono" style="text-align:center;font-size:12px;font-weight:600">{{ x.qty }}</td><td class="num">{{ x.unitMargin | brl }}</td><td class="num">{{ x.qty * x.cost | brl }}</td><td class="num" style="font-weight:700;color:#18864B">{{ x.qty * x.unitMargin | brl }}</td></tr> }</tbody></table></div>
          @if (r.skipped) { <p style="font-size:11px;color:#647687;margin-top:8px">{{ r.skipped }} SKU(s) com demanda ficaram fora por limite de orçamento ou margem não positiva.</p> }
        } @else if (error()) { <div class="state-warning" style="margin:0">{{ error() }}</div> }
        @else { <div style="text-align:center;padding:40px;color:#A0AFBF"><ax-icon name="settings-2" [size]="36" color="#A0AFBF" /><div style="font-size:13px;margin-top:8px">Configure os parâmetros e execute o modelo</div></div> }
      </div>
    </div>
  </div>`,
})
export class PesquisaOperacionalPage {
  private api = inject(Api);
  budget = 5000; days = 30; useStock = true;
  readonly res = signal<any>(null); readonly busy = signal(false); readonly error = signal<string | null>(null);
  async solve() {
    this.busy.set(true); this.error.set(null); this.res.set(null);
    try {
      const r: any = await this.api.get('/intelligence/replenishment', { leadDays: 1, coverDays: Math.max(1, this.days - 1) });
      if (r.items.some((x: any) => x.cost === null)) { this.error.set('O cálculo exige a permissão de visualizar custos dos produtos.'); return; }
      const cand = r.items.map((x: any) => { const demand = Math.max(0, Math.ceil(Number(x.daily_avg) * this.days) - (this.useStock ? x.stock : 0)); const cost = Number(x.cost), price = Number(x.price);
        return { ...x, demand, cost, unitMargin: Math.round((price - cost) * 100) / 100 }; }).filter((x: any) => x.demand > 0 && x.cost > 0 && x.unitMargin > 0)
        .sort((a: any, b: any) => b.unitMargin / b.cost - a.unitMargin / a.cost);
      let left = +this.budget; const items: any[] = [];
      for (const c of cand) { const qty = Math.min(c.demand, Math.floor(left / c.cost)); if (qty <= 0) continue; items.push({ ...c, qty }); left -= qty * c.cost; }
      const spent = +this.budget - left;
      this.res.set({ items, spent, margin: items.reduce((s, x) => s + x.qty * x.unitMargin, 0), units: items.reduce((s, x) => s + x.qty, 0), skipped: r.items.length - items.length });
    } catch (e: any) { this.error.set(e.message); } finally { this.busy.set(false); }
  }
}

// ─── Simulações de cenário ──────────────────────────────────────────────────
interface Vars { volume: number; preco: number; cmv: number; despesas: number; inadimplencia: number; }
@Component({
  selector: 'ax-simulacoes',
  imports: [FormsModule, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px;display:flex;flex-direction:column;gap:16px">
    <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Scenario Builder — Simulações</h1>
      <p style="font-size:13px;color:#647687">Base real: média mensal dos últimos 90 dias (vendas, CMV e despesas lançadas). Ajuste as variáveis e compare o impacto mensal.</p></div>
    <ax-state [loading]="!b()" />
    @if (b(); as b) {
      @if (b.costMonth === null) { <div class="state-warning" style="margin:0">Sem permissão para custos: margem e lucro não podem ser calculados.</div> }
      <div style="display:flex;gap:10px">
        @for (c of names; track c) { <button (click)="active.set(c)" [style.border]="'2px solid ' + (active() === c ? '#0875D1' : '#DCE4EC')" [style.background]="active() === c ? '#0875D1' : 'white'" [style.color]="active() === c ? 'white' : '#172B3A'" style="padding:8px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">{{ c }}</button> }
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:14px">
        @for (c of names; track c) {
          <div class="card" style="padding:18px" [style.border]="c === active() ? '2px solid #0875D1' : '1px solid #DCE4EC'">
            <div style="font-size:13px;font-weight:700;color:#172B3A;margin-bottom:16px">{{ c }}</div>
            @for (k of result(c); track k[0]) { <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="font-size:12px;color:#647687">{{ k[0] }}</span>
              <span class="mono" style="font-size:13px;font-weight:700" [style.color]="k[2] ? (k[1].startsWith('-') ? '#C93636' : '#18864B') : '#172B3A'">{{ k[1] }}</span></div> }
          </div>
        }
      </div>
      <div class="card" style="padding:18px">
        <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:14px">Variáveis por Cenário <span class="muted" style="font-weight:400;font-size:11px">(variação % sobre a base; inadimplência em % da receita a prazo perdida)</span></div>
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Variável</th>@for (c of names; track c) { <th style="text-align:center" [style.color]="c === 'Otimista' ? '#18864B' : c === 'Pessimista' ? '#C93636' : null">{{ c }}</th> }</tr></thead>
          <tbody>@for (v of varDefs; track v.key) {
            <tr><td style="font-size:13px">{{ v.label }}</td>
              @for (c of names; track c) { <td style="text-align:center"><input type="number" step="0.5" class="input-field mono" style="width:90px;padding:4px 6px;text-align:center;margin:0 auto" [ngModel]="vars()[c][v.key]" (ngModelChange)="set(c, v.key, $event)" [disabled]="c === 'Base'" /></td> }</tr>
          }</tbody>
        </table>
      </div>
    }
  </div>`,
})
export class SimulacoesPage implements OnInit {
  private api = inject(Api);
  readonly names = ['Base', 'Otimista', 'Pessimista', 'Personalizado'];
  readonly varDefs: { key: keyof Vars; label: string }[] = [{ key: 'volume', label: 'Volume de vendas (%)' }, { key: 'preco', label: 'Preço médio (%)' }, { key: 'cmv', label: 'Custo unitário / CMV (%)' }, { key: 'despesas', label: 'Despesas operacionais (%)' }, { key: 'inadimplencia', label: 'Perda por inadimplência (% receita)' }];
  readonly b = signal<any>(null); readonly active = signal('Base');
  readonly vars = signal<Record<string, Vars>>({ Base: { volume: 0, preco: 0, cmv: 0, despesas: 0, inadimplencia: 0 }, Otimista: { volume: 10, preco: 3, cmv: -2, despesas: 0, inadimplencia: 0 },
    Pessimista: { volume: -12, preco: -5, cmv: 4, despesas: 3, inadimplencia: 1.5 }, Personalizado: { volume: 0, preco: 0, cmv: 0, despesas: 0, inadimplencia: 0 } });
  async ngOnInit() { this.b.set(await this.api.get('/intelligence/baseline')); }
  set(c: string, k: keyof Vars, v: any) { this.vars.update((all) => ({ ...all, [c]: { ...all[c], [k]: +v || 0 } })); }
  result(c: string): [string, string, boolean][] {
    const b = this.b(); const v = this.vars()[c];
    const revenue = b.revenueMonth * (1 + v.volume / 100) * (1 + v.preco / 100);
    const cost = b.costMonth === null ? null : b.costMonth * (1 + v.volume / 100) * (1 + v.cmv / 100);
    const losses = revenue * v.inadimplencia / 100; const expenses = b.expensesMonth * (1 + v.despesas / 100);
    const gross = cost === null ? null : revenue - cost; const profit = gross === null ? null : gross - expenses - losses;
    return [['Receita', brl(revenue), false], ['Margem bruta', gross === null ? '—' : ((gross / revenue) * 100).toFixed(1).replace('.', ',') + '%', false], ['Despesas', brl(expenses + losses), false],
      ['Lucro operacional', profit === null ? '—' : brl(profit), true], ['Ticket médio', brl(b.ticket * (1 + v.preco / 100)), false]];
  }
}
