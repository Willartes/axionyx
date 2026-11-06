import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
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
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));gap:12px">
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
    { label: 'Diagnóstico do Lucro', icon: 'activity', color: '#C93636', bg: '#FDECEC', screen: '/diagnostico-lucro', sub: 'Por que o resultado mudou' },
    { label: 'Previsão de Demanda', icon: 'trending-up', color: '#0875D1', bg: '#E3EFF9', screen: '/forecast', sub: '6 métodos com rede neural, semanal ou mensal' },
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

// ─── Previsão de demanda: 6 métodos do sistema original (inclui rede neural MLP), holdout 80/20, semanal ou mensal ────
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
@Component({
  selector: 'ax-forecast',
  imports: [FormsModule, IconComponent, StateComponent, ...CHARTS],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .seg { display:inline-flex; border:1px solid #D4DEE8; border-radius:8px; overflow:hidden; }
    .seg button { border:none; background:#fff; padding:7px 14px; font-size:12px; font-weight:600; color:#3B5266; cursor:pointer; }
    .seg button.on { background:#0875D1; color:#fff; }
    .kpis { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:10px; }
    .k { background:#fff; border:1px solid #E3EAF1; border-radius:10px; padding:12px 14px; }
    .k small { display:block; font-size:10px; font-weight:600; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; }
    .k b { font-size:19px; color:#172B3A; } .k span { display:block; font-size:11px; color:#647687; margin-top:2px; }
    .legend { display:flex; gap:16px; font-size:11px; color:#647687; flex-wrap:wrap; margin-bottom:10px; }
    .legend i { display:inline-block; width:14px; vertical-align:middle; margin-right:4px; }
    .why { background:#F3F8FD; border:1px solid #CFE2F3; border-radius:10px; padding:12px 14px; font-size:13px; color:#172B3A; line-height:1.5; }
    .warn { background:#FFF7E6; border:1px solid #F5D9A0; color:#7A5200; border-radius:8px; padding:8px 12px; font-size:12px; }
    tr.sel td { background:#F0F7FF; }
    td.num, th.num { white-space:nowrap; }
    @media (max-width: 1000px) { .kpis { grid-template-columns:1fr 1fr; } }
  `],
  template: `
  <div style="padding:24px;display:flex;flex-direction:column;gap:14px;max-width:1280px">
    <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Previsão de Demanda</h1>
        <p style="font-size:13px;color:#647687">6 métodos comparados por holdout cronológico (80% treino / 20% teste) · o recomendado tem o menor RMSE + MAPE no teste</p></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select class="input-field" style="width:250px;font-size:12px" [ngModel]="productId" (ngModelChange)="productId = $event; run()"><option value="">Faturamento total (R$)</option>@for (p of products(); track p.id) { <option [value]="p.id">{{ p.code }} · {{ p.name }}</option> }</select>
        <div class="seg" role="group" aria-label="Período"><button [class.on]="periodo() === 'semanal'" (click)="setPeriodo('semanal')">Semanal</button><button [class.on]="periodo() === 'mensal'" (click)="setPeriodo('mensal')">Mensal</button></div>
        <select class="input-field" style="width:130px;font-size:12px" [ngModel]="horizon" (ngModelChange)="horizon = $event; run()">@for (h of horizontes(); track h) { <option [ngValue]="h">{{ h }} {{ h === 1 ? (periodo() === 'mensal' ? 'mês' : 'semana') : (periodo() === 'mensal' ? 'meses' : 'semanas') }}</option> }</select>
      </div>
    </div>
    <ax-state [loading]="loading()" />
    @if (!loading() && r(); as g) {
      @if (g.insuficiente) { <div class="card" style="padding:28px;text-align:center;color:#647687;font-size:13px"><ax-icon name="info" [size]="20" /><div style="margin-top:6px">{{ g.mensagem }}</div></div> }
      @else {
        @for (a of g.avisos; track a) { <div class="warn">{{ a }}</div> }
        <div class="kpis">
          <div class="k"><small>Demanda prevista</small><b class="mono">{{ f(total()) }}</b><span>próximos {{ g.horizonte }} {{ un(g.horizonte) }}</span></div>
          <div class="k"><small>Média por {{ periodo() === 'mensal' ? 'mês' : 'semana' }}</small><b class="mono">{{ f(total() / g.horizonte) }}</b><span>histórico: {{ f(mediaHist()) }}</span></div>
          <div class="k"><small>Método {{ selIdx() === g.melhor ? 'recomendado' : 'selecionado' }}</small><b style="font-size:14px">{{ cur().nome }}</b><span>{{ cur().fallback ? 'usou o Naive (pouco histórico)' : 'clique na tabela para comparar' }}</span></div>
          <div class="k"><small>Erro no teste (RMSE · MAE)</small><b class="mono">{{ f(cur().rmse) }}</b><span>MAE {{ f(cur().mae) }} · sMAPE {{ pct(cur().smape) }}</span></div>
          <div class="k"><small>Confiança</small><b style="text-transform:capitalize">{{ g.avaliacao.confianca }}</b><span>{{ g.serie.length }} {{ un(g.serie.length) }} de histórico</span></div>
        </div>
        <div class="card" style="padding:16px">
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:6px">{{ productId ? 'Unidades vendidas' : 'Faturamento líquido' }} por {{ periodo() === 'mensal' ? 'mês' : 'semana' }} · teste e previsão</div>
          <div class="legend">
            <span><i style="border-top:2px solid #0875D1"></i>Real (treino)</span>
            <span><i style="border-top:2px solid #172B3A"></i>Real (teste)</span>
            <span><i style="border-top:2px dashed #E8A317"></i>Previsto no teste</span>
            <span><i style="border-top:2px dashed #00A6D6"></i>Previsão</span>
            <span><i style="height:8px;background:rgba(0,166,214,.15)"></i>Faixa aproximada (±1,28 × RMSE do teste)</span>
          </div>
          <ax-line-chart [labels]="labels()" [series]="series()" [bandValues]="band()" [height]="260" [area]="false" [fmt]="fmtFn()" />
          @if (g.atual?.inicio) { <div class="muted" style="font-size:11px;margin-top:6px">{{ periodo() === 'mensal' ? 'O mês' : 'A semana' }} em andamento ({{ lab(g.atual.inicio) }}, {{ f(g.atual.valor) }} até agora) não entra no treino: é o primeiro ponto da previsão.</div> }
        </div>
        <div class="why"><b>Por que {{ g.metodos[g.melhor].nome }}?</b> {{ g.avaliacao.conclusao }}
          <div style="font-size:12px;color:#3B5266;margin-top:6px">{{ g.avaliacao.justificativa }} {{ g.avaliacao.recomendacao }}</div></div>
        <div class="card" style="overflow:hidden">
          <div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600;color:#172B3A">Comparação dos métodos <span class="muted" style="font-weight:400;font-size:11px">— teste com os últimos {{ g.serie.length - g.nTreino }} {{ un(g.serie.length - g.nTreino) }}, em rodadas de {{ g.horizonte }}</span></div>
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>Método</th><th class="num">RMSE</th><th class="num">MAE</th><th class="num">MAPE</th><th class="num">sMAPE</th><th class="num">Viés</th><th class="num">Score (RMSE+MAPE)</th><th class="num">Previsão total</th><th></th></tr></thead>
            <tbody>@for (m of g.metodos; track m.nomeOriginal; let i = $index) {
              <tr [class.sel]="i === selIdx()" style="cursor:pointer" (click)="sel.set(i)">
                <td [style.font-weight]="i === g.melhor ? 700 : 400">@if (i === g.melhor) { <ax-icon name="axionyx" [size]="13" color="#00A6D6" /> } {{ m.nome }}@if (m.fallback) { <span class="badge badge-warning" style="margin-left:6px" title="Pouco histórico para este método: usou o Naive">Naive</span> }</td>
                <td class="num mono">{{ f(m.rmse) }}</td><td class="num mono">{{ f(m.mae) }}</td><td class="num mono">{{ pct(m.mape) }}</td><td class="num mono">{{ pct(m.smape) }}</td>
                <td class="num mono">{{ m.bias === null ? '—' : (m.bias > 0 ? '+' : '') + f(m.bias) }}</td>
                <td class="num mono">{{ m.score === null ? '—' : dec(m.score) }}</td>
                <td class="num mono">{{ f(sum(m.previsao)) }}</td>
                <td>@if (i === g.melhor) { <span class="badge badge-cyan">Recomendado</span> } @else if (i === selIdx()) { <span class="badge badge-info">No gráfico</span> }</td>
              </tr>
            }</tbody>
          </table></div>
        </div>
        <details style="font-size:12px;color:#647687"><summary style="cursor:pointer">Detalhes e limitações</summary>
          <ul style="margin:8px 0 0 18px;line-height:1.6">@for (x of g.avaliacao.fatos; track x) { <li>{{ x }}</li> }@for (x of g.avaliacao.limitacoes; track x) { <li>{{ x }}</li> }
            <li>Série: períodos sem venda entram como zero; vendas canceladas ficam de fora; devoluções e descontos são descontados; frete não entra no faturamento. O período em andamento e um primeiro período incompleto (início do uso do sistema) não entram no treino.</li>
            <li>sMAPE só é calculado para Naive, ARIMA e rede neural, como no sistema original.</li>
            <li>Viés = média de (real − previsto) no teste: positivo indica que o método previu abaixo do real.</li></ul></details>
      }
    }
  </div>`,
})
export class ForecastPage implements OnInit {
  private api = inject(Api);
  readonly r = signal<any>(null); readonly loading = signal(true); readonly products = signal<any[]>([]);
  readonly periodo = signal<'semanal' | 'mensal' | ''>(''); readonly sel = signal(0);
  productId = ''; horizon: number | null = null;
  ngOnInit() { this.api.get<any>('/products', { size: 300, active: 'true' }).then((x) => this.products.set(x.items)).catch(() => {}); this.run(); }
  setPeriodo(p: 'semanal' | 'mensal') { if (this.periodo() === p) return; this.periodo.set(p); this.horizon = null; this.run(); }
  async run() {
    this.loading.set(true);
    try {
      const g: any = await this.api.get('/intelligence/forecast', { product: this.productId || undefined, periodo: this.periodo() || undefined, horizon: this.horizon ?? undefined });
      this.periodo.set(g.periodo); this.horizon = g.horizonte; this.r.set(g); this.sel.set(g.melhor ?? 0);
    } catch { this.r.set(null); } finally { this.loading.set(false); }
  }
  readonly horizontes = computed<number[]>(() => this.r()?.horizontes ?? (this.periodo() === 'mensal' ? [1, 2, 3, 6, 12] : [1, 2, 3, 4, 6, 8, 12]));
  readonly selIdx = computed(() => this.sel());
  readonly cur = computed(() => this.r()?.metodos?.[this.sel()] ?? { nome: '—', previsao: [], teste: [] });
  readonly total = computed(() => this.sum(this.cur().previsao));
  readonly mediaHist = computed(() => { const s = this.r()?.serie ?? []; return s.length ? s.reduce((a: number, p: any) => a + p.valor, 0) / s.length : 0; });
  sum(v: number[]) { return (v ?? []).reduce((a, b) => a + b, 0); }
  un(n: number) { return this.periodo() === 'mensal' ? (n === 1 ? 'mês' : 'meses') : (n === 1 ? 'semana' : 'semanas'); }
  lab(d: string) { const [y, m, dd] = d.split('-'); return this.periodo() === 'mensal' ? `${MESES[Number(m) - 1]}/${y.slice(2)}` : `${dd}/${m}`; }
  readonly labels = computed(() => { const g = this.r(); if (!g?.serie) return []; return [...g.serie.map((p: any) => p.inicio), ...(g.futuro ?? [])].map((d: string) => this.lab(d)); });
  readonly series = computed<Series[]>(() => {
    const g = this.r(); if (!g?.serie) return [];
    const ys = g.serie.map((p: any) => p.valor), n = ys.length, nt = g.nTreino, h = g.futuro.length, m = this.cur();
    const pad = (k: number) => Array(k).fill(null);
    return [
      { name: 'Real (treino)', color: '#0875D1', values: [...ys.slice(0, nt), ...pad(n - nt + h)] },
      { name: 'Real (teste)', color: '#172B3A', values: [...pad(nt - 1), ...ys.slice(nt - 1), ...pad(h)] },
      { name: 'Previsto no teste', color: '#E8A317', dashed: true, values: [...pad(nt - 1), ys[nt - 1], ...m.teste, ...pad(h)] },
      { name: 'Previsão', color: '#00A6D6', dashed: true, values: [...pad(n - 1), ys[n - 1], ...m.previsao] },
    ] as any;
  });
  readonly band = computed<[(number | null)[], (number | null)[]] | null>(() => {
    const g = this.r(); if (!g?.serie) return null; const sd = this.cur().rmse ?? 0, n = g.serie.length, fc: number[] = this.cur().previsao;
    return [[...Array(n).fill(null), ...fc.map((v, i) => Math.max(0, v - 1.28 * sd * Math.sqrt(i + 1)))], [...Array(n).fill(null), ...fc.map((v, i) => v + 1.28 * sd * Math.sqrt(i + 1))]];
  });
  readonly fmtFn = computed(() => (this.productId ? (v: number) => num(v, 0) : (v: number) => brl(v)));
  f(v: number | null | undefined) { if (v === null || v === undefined || !Number.isFinite(v)) return '—'; return this.productId ? num(v, 1) : brl(v); }
  pct(v: number | null) { return v === null || v === undefined ? '—' : v.toFixed(1).replace('.', ',') + '%'; }
  dec(v: number) { return v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }); }
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

// ─── Diagnóstico do lucro (causas que somam a variação entre dois períodos) ─
const DIAG_PERIODS = [{ k: '7d', l: '7 dias' }, { k: '30d', l: '30 dias' }, { k: 'mes', l: 'Este mês' }, { k: 'mes_anterior', l: 'Mês passado' }, { k: '90d', l: '90 dias' }];
@Component({
  selector: 'ax-diagnostico-lucro',
  imports: [IconComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .dg-wrap { padding:24px; display:flex; flex-direction:column; gap:16px; max-width:1100px; }
    .dg-seg { display:inline-flex; border:1px solid #DCE4EC; border-radius:8px; overflow:hidden; background:white; flex-wrap:wrap; }
    .dg-seg button { border:0; background:transparent; padding:7px 12px; font-size:12px; color:#3A4D5E; cursor:pointer; font-weight:500; }
    .dg-seg button.on { background:#0875D1; color:white; }
    .dg-head { display:grid; grid-template-columns: 1.3fr 1fr; gap:16px; }
    .dg-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; }
    .dg-row { display:grid; grid-template-columns: minmax(0, 1.2fr) minmax(120px, 1fr) 120px; gap:14px; align-items:center; padding:12px 16px; border-top:1px solid #F0F4F8; }
    .dg-row:first-child { border-top:0; }
    .dg-bar { height:12px; border-radius:6px; }
    .dg-ev { grid-column: 1 / -1; margin:-4px 0 0; padding:0 0 2px 0; display:flex; flex-direction:column; gap:3px; }
    .dg-ev div { font-size:12px; color:#4A5D6E; line-height:1.45; padding-left:14px; position:relative; }
    .dg-ev div::before { content:''; position:absolute; left:3px; top:7px; width:5px; height:5px; border-radius:50%; background:#A0AFBF; }
    @media (max-width: 860px) {
      .dg-wrap { padding:16px; } .dg-head { grid-template-columns: 1fr; } .dg-kpis { grid-template-columns:repeat(2, 1fr); }
      .dg-row { grid-template-columns: minmax(0, 1fr) 96px; } .dg-row .dg-barcell { grid-column: 1 / -1; order:3; } .dg-ev { order:4; }
    }
  `],
  template: `
  <div class="dg-wrap">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div><div style="display:flex;align-items:center;gap:10px"><div style="width:34px;height:34px;background:linear-gradient(135deg,#0875D1,#00A6D6);border-radius:9px;display:flex;align-items:center;justify-content:center"><ax-icon name="activity" [size]="18" color="white" /></div>
        <h1 style="font-size:20px;font-weight:700;color:#172B3A">{{ focus() === 'lucro' ? 'Diagnóstico do lucro' : 'Diagnóstico do faturamento' }}</h1></div>
        <p style="font-size:13px;color:#647687;margin-top:4px">O que fez o {{ focus() === 'lucro' ? 'resultado' : 'faturamento' }} mudar entre dois períodos, com as causas e as evidências tiradas dos seus dados.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        @if (canProfit) { <div class="dg-seg" role="group" aria-label="Analisar"><button [class.on]="focus() === 'lucro'" (click)="setFocus('lucro')">Lucro</button><button [class.on]="focus() === 'vendas'" (click)="setFocus('vendas')">Faturamento</button></div> }
        <div class="dg-seg" role="group" aria-label="Período">@for (p of periods; track p.k) { <button [class.on]="period() === p.k" (click)="setPeriod(p.k)">{{ p.l }}</button> }</div>
      </div>
    </div>
    <ax-state [loading]="loading()" [error]="error()" />
    @if (!loading() && d(); as d) {
      <div class="dg-head">
        <div class="card" style="padding:18px 20px">
          <div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:.04em">{{ d.headline.metric }} · {{ d.periods.label }}</div>
          <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-top:8px">
            <span class="mono" style="font-size:28px;font-weight:800" [style.color]="d.headline.current < 0 ? '#C93636' : '#172B3A'">{{ brl(d.headline.current) }}</span>
            <span class="mono" style="font-size:15px;font-weight:700" [style.color]="color(d.headline.delta)">{{ signed(d.headline.delta) }}@if (pctLabel(d)) { <span style="font-weight:600"> · {{ pctLabel(d) }}</span> }</span>
          </div>
          <div style="font-size:12px;color:#647687;margin-top:4px">{{ d.periods.currentLabel }} · antes: <span class="mono">{{ brl(d.headline.previous) }}</span> ({{ d.periods.previousLabel }})</div>
          <div style="margin-top:12px;font-size:13px;color:#172B3A;line-height:1.5">{{ summary(d) }}</div>
        </div>
        <div class="card" style="padding:18px 20px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;font-weight:600;color:#647687">Confiança do pré-diagnóstico</span>
            <span class="badge" [class]="d.confidence.level === 'alta' ? 'badge badge-success' : d.confidence.level === 'media' ? 'badge badge-warning' : 'badge badge-danger'">{{ d.confidence.level === 'media' ? 'Média' : d.confidence.level === 'alta' ? 'Alta' : 'Baixa' }}</span></div>
          @if (d.confidence.reasons.length) { @for (r of d.confidence.reasons; track r) { <div style="font-size:12px;color:#4A5D6E;line-height:1.45">• {{ r }}</div> } }
          @else { <div style="font-size:12px;color:#4A5D6E">{{ d.focus === 'lucro' ? 'Há vendas, custos e despesas suficientes nos dois períodos para comparar.' : 'Há vendas suficientes nos dois períodos para comparar.' }}</div> }
          <div style="font-size:11px;color:#8496A7;margin-top:auto;line-height:1.45">{{ d.method }}</div>
        </div>
      </div>

      <div class="dg-kpis">
        @for (k of kpis(d); track k.label) {
          <div class="kpi-card"><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:.04em">{{ k.label }}</div>
            <div class="mono" style="font-size:17px;font-weight:700;color:#172B3A;margin-top:4px">{{ k.cur }}</div>
            <div style="font-size:11px;margin-top:2px" [style.color]="k.good === null ? '#647687' : k.good ? '#18864B' : '#C93636'">antes {{ k.prev }}</div></div>
        }
      </div>

      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <span style="font-size:13px;font-weight:700;color:#172B3A">De {{ brl(d.headline.previous) }} para {{ brl(d.headline.current) }}: o que explica a diferença</span>
          <span style="font-size:11px;color:#647687">as causas somam exatamente {{ signed(d.headline.delta) }}</span>
        </div>
        @for (x of main(d); track x.key) {
          <div class="dg-row">
            <div style="min-width:0"><div style="font-size:13px;font-weight:600;color:#172B3A">{{ x.label }}</div><div style="font-size:12px;color:#647687">{{ x.detail }}</div></div>
            <div class="dg-barcell" style="display:flex" [style.justify-content]="x.impact < 0 ? 'flex-end' : 'flex-start'" [style.padding-left]="x.impact >= 0 ? '50%' : '0'" [style.padding-right]="x.impact < 0 ? '50%' : '0'">
              <div class="dg-bar" [style.width.%]="barW(d, x.impact)" [style.background]="x.impact < 0 ? '#E06666' : '#3FAE6A'"></div>
            </div>
            <div style="text-align:right"><div class="mono" style="font-size:14px;font-weight:700" [style.color]="color(x.impact)">{{ signed(x.impact) }}</div>
              @if (x.link) { <a class="link" style="font-size:11px" (click)="go(x.link)">{{ x.linkLabel || 'Abrir' }}</a> }</div>
            @if (x.evidence.length) { <div class="dg-ev">@for (e of x.evidence; track e) { <div>{{ e }}</div> }</div> }
          </div>
        }
        @if (minorSum(d) !== 0) { <div class="dg-row" style="color:#647687;font-size:12px"><div>Outros efeitos pequenos</div><div class="dg-barcell"></div><div class="mono" style="text-align:right">{{ signed(minorSum(d)) }}</div></div> }
        @if (!main(d).length) { <div style="padding:16px;font-size:13px;color:#647687">Nenhuma diferença relevante entre os dois períodos.</div> }
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:16px">
        @if (d.actions.length) {
          <div class="card" style="padding:16px">
            <div style="font-size:13px;font-weight:700;color:#172B3A;margin-bottom:10px;display:flex;gap:8px;align-items:center"><ax-icon name="check-circle-2" [size]="15" color="#0875D1" /> Por onde começar</div>
            @for (a of d.actions; track a.text) {
              <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid #F0F4F8"><div style="flex:1;font-size:13px;color:#172B3A;line-height:1.45">{{ a.text }}</div>
                @if (a.link) { <button class="btn-ghost" style="font-size:11px;flex-shrink:0" (click)="go(a.link)">{{ a.linkLabel || 'Abrir' }}</button> }</div>
            }
          </div>
        }
        @if (d.attention.length) {
          <div class="card" style="padding:16px">
            <div style="font-size:13px;font-weight:700;color:#172B3A;margin-bottom:10px;display:flex;gap:8px;align-items:center"><ax-icon name="alert-triangle" [size]="15" color="#D99000" /> Também vale olhar</div>
            @for (a of d.attention; track a) { <div style="font-size:13px;color:#172B3A;line-height:1.45;padding:8px 0;border-top:1px solid #F0F4F8">{{ a }}</div> }
          </div>
        }
      </div>
      <p style="font-size:11px;color:#8496A7">Pré-diagnóstico automático calculado com regras e estatística sobre os dados do AXIONYX (sem IA generativa). Use como ponto de partida e confira os lançamentos antes de decisões importantes.</p>
    }
  </div>`,
})
export class DiagnosticoLucroPage implements OnInit {
  private api = inject(Api); private router = inject(Router); private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  readonly periods = DIAG_PERIODS;
  readonly canProfit = this.auth.can(['financeiro.ver', 'contabilidade.ver']);
  readonly period = signal('30d'); readonly focus = signal<'lucro' | 'vendas'>('lucro');
  readonly d = signal<any>(null); readonly loading = signal(true); readonly error = signal('');
  readonly brl = brl;
  ngOnInit() {
    const q = this.route.snapshot.queryParamMap;
    if (DIAG_PERIODS.some((p) => p.k === q.get('periodo'))) this.period.set(q.get('periodo')!);
    this.focus.set(q.get('foco') === 'vendas' || !this.canProfit ? 'vendas' : 'lucro');
    this.load();
  }
  setPeriod(k: string) { if (k === this.period()) return; this.period.set(k); this.sync(); this.load(); }
  setFocus(f: 'lucro' | 'vendas') { if (f === this.focus()) return; this.focus.set(f); this.sync(); this.load(); }
  private sync() { this.router.navigate([], { queryParams: { periodo: this.period(), foco: this.focus() === 'vendas' ? 'vendas' : null }, replaceUrl: true }); }
  async load() {
    this.loading.set(true); this.error.set('');
    try { this.d.set(await this.api.get('/intelligence/profit-diagnosis', { period: this.period(), focus: this.focus() })); }
    catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); }
  }
  main(d: any) { return d.drivers.filter((x: any) => !x.minor); }
  minorSum(d: any) { return Math.round(d.drivers.filter((x: any) => x.minor).reduce((a: number, x: any) => a + x.impact, 0)) ; }
  barW(d: any, v: number) { const max = Math.max(...this.main(d).map((x: any) => Math.abs(x.impact)), 1); return Math.max(2, Math.abs(v) / max * 100); }
  color(v: number) { return v < 0 ? '#C93636' : v > 0 ? '#18864B' : '#647687'; }
  signed(v: number) { return (v > 0 ? '+' : v < 0 ? '−' : '') + brl(Math.abs(v)); }
  pctLabel(d: any) { const h = d.headline; if (h.previous > 0 && h.current < 0) return 'virou prejuízo'; if (h.previous < 0 && h.current > 0) return 'saiu do prejuízo'; if (h.previous <= 0 || h.pct === null) return ''; return (h.pct > 0 ? '+' : '−') + num(Math.abs(h.pct), 1) + '%'; }
  summary(d: any) {
    const neg = this.main(d).filter((x: any) => x.impact < 0), pos = this.main(d).filter((x: any) => x.impact > 0);
    const h = d.headline;
    if (h.direction === 'estavel') return `Praticamente estável.${neg[0] ? ` O ponto mais negativo foi: ${neg[0].label.toLowerCase()}.` : ''}`;
    if (h.direction === 'caiu') return `A maior causa da queda foi ${neg[0]?.label.toLowerCase() ?? '—'} (${this.signed(neg[0]?.impact ?? 0)})${neg[1] ? `, seguida de ${neg[1].label.toLowerCase()} (${this.signed(neg[1].impact)})` : ''}.`;
    return `Subiu, puxado por ${pos[pos.length - 1]?.label.toLowerCase() ?? '—'}${neg[0] ? `. Mesmo assim, ${neg[0].label.toLowerCase()} pesou ${this.signed(neg[0].impact)}` : ''}.`;
  }
  kpis(d: any) {
    const k = d.kpis; const up = (a: number, b: number) => (a === b ? null : a > b);
    return [
      { label: 'Faturamento', cur: brl(k.revenue.current), prev: brl(k.revenue.previous), good: up(k.revenue.current, k.revenue.previous) },
      { label: 'Vendas', cur: num(k.sales.current, 0), prev: num(k.sales.previous, 0), good: up(k.sales.current, k.sales.previous) },
      { label: 'Ticket médio', cur: brl(k.ticket.current), prev: brl(k.ticket.previous), good: up(k.ticket.current, k.ticket.previous) },
      ...(k.grossMarginPct ? [{ label: 'Margem bruta', cur: num(k.grossMarginPct.current, 1) + '%', prev: num(k.grossMarginPct.previous, 1) + '%', good: up(k.grossMarginPct.current, k.grossMarginPct.previous) }] : []),
      { label: 'Desconto médio', cur: num(k.discountPct.current, 1) + '%', prev: num(k.discountPct.previous, 1) + '%', good: k.discountPct.current === k.discountPct.previous ? null : k.discountPct.current < k.discountPct.previous },
    ];
  }
  go(link: string) { this.router.navigateByUrl('/' + link); }
}
