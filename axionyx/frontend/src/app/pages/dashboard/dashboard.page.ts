import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LogoComponent } from '../../shared/logo.component';
import { IconComponent } from '../../shared/icon.component';
import { CHARTS, Series } from '../../shared/charts';
import { StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { brl, num, pct, dateBr, BrlPipe } from '../../core/format';

interface Kpi { label: string; value: string; sub: string; trend: 'up' | 'down' | 'neutral'; icon: string; color: string; bg: string; screen: string }

@Component({
  selector: 'ax-dashboard',
  imports: [LogoComponent, IconComponent, StateComponent, BrlPipe, ...CHARTS],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="screen-page dashboard-page" style="padding:24px;display:flex;flex-direction:column;gap:20px">
    <div class="screen-heading" style="display:flex;align-items:flex-start;justify-content:space-between">
      <div>
        <h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Dashboard Executivo</h1>
        <p style="font-size:13px;color:#647687">{{ me()?.company?.name }} · {{ monthLabel }} · Atualizado às {{ updatedAt() }}</p>
      </div>
      <div style="display:flex;gap:8px">
        @if (me()?.user?.allBranches) {
          <select class="input-field" style="width:auto;font-size:12px;padding:6px 30px 6px 10px" [value]="branch()" (change)="setBranch($any($event.target).value)">
            <option value="all">Todas as filiais</option>
            @for (b of me()?.branches ?? []; track b.id) { <option [value]="b.id">{{ b.name }}</option> }
          </select>
        }
        <button class="btn-secondary" style="font-size:12px" (click)="load()"><ax-icon name="refresh-cw" [size]="13" /> Atualizar</button>
        <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/intelligence')"><ax-icon name="axionyx" [size]="13" /> Analisar com IA</button>
      </div>
    </div>

    <ax-state [loading]="loading() && !data()" [error]="error()" (retry)="load()" />

    @if (today(); as t) {
      <div class="card" style="padding:14px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <div style="display:flex;gap:8px;align-items:center"><ax-icon name="calendar-days" [size]="16" color="#0875D1" /><span style="font-size:13px;font-weight:600">Hoje na agenda</span>
            <span style="font-size:12px;color:#647687">{{ t.summary.total }} {{ auth.term('atendimentos').toLowerCase() }} · {{ t.summary.concluidos }} concluído(s) · previsto {{ t.summary.previsto | brl }}</span></div>
          <button class="btn-ghost" style="font-size:11px" (click)="router.navigateByUrl('/agenda')">Abrir agenda <ax-icon name="arrow-right" [size]="12" /></button>
        </div>
        <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:2px">
          @for (a of t.next; track a.id) {
            <div style="min-width:170px;border:1px solid #DCE4EC;border-left:4px solid;border-radius:8px;padding:7px 10px;font-size:12px;cursor:pointer" [style.border-left-color]="a.color" (click)="router.navigateByUrl('/agenda')">
              <div style="font-weight:700">{{ a.start_local.slice(11) }} · {{ a.customer }}</div><div style="color:#647687;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ a.professional }} · {{ a.services[0]?.name }}</div></div>
          } @empty { <span style="font-size:12px;color:#647687">Nenhum atendimento restante hoje.</span> }
        </div>
      </div>
    }
    @if (data(); as d) {
      <div class="dashboard-kpis" style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px">
        @for (k of kpis(); track k.label) {
          <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl('/' + k.screen)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em">{{ k.label }}</span>
              <div [style.background]="k.bg" style="width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center"><ax-icon [name]="k.icon" [size]="16" [color]="k.color" /></div>
            </div>
            <div style="font-size:22px;font-weight:700;color:#172B3A;letter-spacing:-0.5px">{{ k.value }}</div>
            <div [style.color]="k.trend === 'up' ? '#18864B' : k.trend === 'down' ? '#C93636' : '#647687'" style="font-size:11px;display:flex;align-items:center;gap:4px;margin-top:2px">
              @if (k.trend === 'up') { <ax-icon name="trending-up" [size]="11" /> } @else if (k.trend === 'down') { <ax-icon name="trending-down" [size]="11" /> }
              {{ k.sub }}
            </div>
          </div>
        }
      </div>

      <div class="dashboard-primary-grid" style="display:grid;grid-template-columns:2fr 1fr;gap:16px">
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <div><div style="font-size:13px;font-weight:600;color:#172B3A">Faturamento — Últimos 12 Meses</div><div style="font-size:11px;color:#647687">Vendas concluídas (R$)</div></div>
            <button class="btn-ghost" style="font-size:11px" (click)="router.navigateByUrl('/relatorios')">Ver relatório <ax-icon name="arrow-right" [size]="12" /></button>
          </div>
          <ax-line-chart [labels]="months()" [series]="revenueSeries()" [height]="180" [fmt]="brlFmt" />
        </div>
        <div class="card" style="padding:16px">
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:4px">Fluxo de Caixa — {{ monthShort }}</div>
          <div style="font-size:11px;color:#647687;margin-bottom:12px">Por semana · movimentos realizados</div>
          @if (d.finance) { <ax-bar-chart [labels]="weekLabels()" [series]="cashSeries()" [height]="180" [fmt]="brlFmt" /> }
          @else { <div class="empty-state">Disponível para perfis com acesso ao financeiro.</div> }
        </div>
      </div>

      <div class="dashboard-secondary-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card" style="padding:16px">
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:4px">Receita × Custos × Despesas</div>
          <div style="font-size:11px;color:#647687;margin-bottom:12px">Últimos 3 meses · CMV pelo custo das peças vendidas</div>
          <ax-bar-chart [labels]="last3()" [series]="rcdSeries()" [height]="160" [legend]="true" [fmt]="brlFmt" />
        </div>
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="font-size:13px;font-weight:600;color:#172B3A">Top 5 Produtos <span style="font-weight:400;color:#647687;font-size:11px">· 30 dias</span></div>
            <button class="btn-ghost" style="font-size:11px" (click)="router.navigateByUrl('/produtos')">Ver todos</button>
          </div>
          <ax-rank [data]="topProducts()" [fmt]="brlFmt" />
        </div>
      </div>

      <div class="card" style="padding:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
          <ax-logo [size]="28" />
          <div>
            <div style="font-size:13px;font-weight:700;color:#172B3A">IA Insights — AXIA</div>
            <div style="font-size:11px;color:#647687">{{ insights().length }} descoberta(s) relevante(s) · regras sobre os dados atuais</div>
          </div>
          <button class="btn-primary" style="margin-left:auto;font-size:12px" (click)="router.navigateByUrl('/intelligence')">Ver Intelligence Center <ax-icon name="chevron-right" [size]="13" /></button>
        </div>
        <div class="dashboard-insights-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          @for (ins of insights().slice(0, 4); track $index) {
            <div [style.border]="'1px solid ' + (ins.type === 'danger' ? '#F4CCCC' : ins.type === 'warning' ? '#F5E0B0' : '#C8DFEF')" [style.background]="ins.type === 'danger' ? '#FEF8F8' : ins.type === 'warning' ? '#FFFBF0' : '#F5F9FE'" style="border-radius:8px;padding:12px 14px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <ax-icon name="alert-triangle" [size]="13" [color]="ins.type === 'danger' ? '#C93636' : ins.type === 'warning' ? '#D99000' : '#2878C7'" />
                <span class="badge" [style.background]="ins.type === 'danger' ? '#FCEAEA' : ins.type === 'warning' ? '#FFF4E0' : '#E3EFF9'" [style.color]="ins.type === 'danger' ? '#C93636' : ins.type === 'warning' ? '#D99000' : '#2878C7'">{{ ins.severity }}</span>
                <span style="font-size:10px;color:#647687;margin-left:auto">baseado em dados</span>
              </div>
              <p style="font-size:12px;color:#172B3A;line-height:1.5;margin-bottom:8px">{{ ins.text }}</p>
              <button (click)="router.navigateByUrl('/' + ins.action)" style="font-size:11px;color:#0875D1;background:none;border:none;cursor:pointer;padding:0;display:flex;align-items:center;gap:4px;font-weight:500">{{ ins.label }} <ax-icon name="chevron-right" [size]="11" /></button>
            </div>
          } @empty { <div class="empty-state" style="grid-column:1/-1">Nenhum alerta relevante nos dados atuais.</div> }
        </div>
      </div>
    }
  </div>`,
})
export class DashboardPage implements OnInit {
  private api = inject(Api);
  readonly auth = inject(AuthService);
  readonly router = inject(Router);
  readonly me = this.auth.me;
  readonly data = signal<any>(null);
  readonly insights = signal<any[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly branch = signal(this.auth.me()?.user?.allBranches ? 'all' : 'current');
  readonly updatedAt = signal('—');
  readonly brlFmt = (v: number) => brl(v);
  readonly monthLabel = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^\w/, (c) => c.toUpperCase());
  readonly monthShort = new Date().toLocaleDateString('pt-BR', { month: 'long' }).replace(/^\w/, (c) => c.toUpperCase());

  readonly today = signal<any>(null);
  ngOnInit() {
    this.load();
    if (this.auth.has('agenda') && this.auth.can('agenda.ver')) this.api.get<any>('/agenda').then((r) => {
      const now = new Date(); const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      this.today.set({ summary: r.summary, next: r.appointments.filter((a: any) => ['agendado', 'confirmado', 'em_atendimento'].includes(a.status) && a.end_local.slice(11) >= hm).slice(0, 8) });
    }, () => {});
  }
  setBranch(v: string) { this.branch.set(v); this.load(); }
  async load() {
    this.loading.set(true); this.error.set(null);
    try {
      const [d, ins] = await Promise.all([this.api.get('/dashboard', { branch: this.branch() }), this.api.get<any>('/intelligence/insights').catch(() => ({ items: [] }))]);
      this.data.set(d); this.insights.set(ins.items);
      this.updatedAt.set(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); }
  }

  private mLabel(ym: string) { const [y, m] = ym.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '').replace(/^\w/, (c) => c.toUpperCase()); }
  readonly months = computed(() => (this.data()?.series ?? []).map((s: any) => this.mLabel(s.month)));
  readonly revenueSeries = computed<Series[]>(() => [{ name: 'Faturamento', color: '#0875D1', values: (this.data()?.series ?? []).map((s: any) => Number(s.revenue)) }]);
  readonly weekLabels = computed(() => (this.data()?.finance?.weeks ?? []).map((w: any) => w.label));
  readonly cashSeries = computed<Series[]>(() => {
    const w = this.data()?.finance?.weeks ?? [];
    return [{ name: 'Entradas', color: '#18864B', values: w.map((x: any) => Number(x.inflow)) }, { name: 'Saídas', color: '#C93636', values: w.map((x: any) => Number(x.outflow)) }];
  });
  readonly last3 = computed(() => (this.data()?.series ?? []).slice(-3).map((s: any) => this.mLabel(s.month)));
  readonly rcdSeries = computed<Series[]>(() => {
    const s = (this.data()?.series ?? []).slice(-3);
    const exp = this.data()?.finance?.expenses3m ?? [];
    const out: Series[] = [{ name: 'Receita', color: '#0875D1', values: s.map((x: any) => Number(x.revenue)) }];
    if (s.length && s[0].cost !== null) out.push({ name: 'CMV', color: '#00A6D6', values: s.map((x: any) => Number(x.cost)) });
    if (this.data()?.finance) out.push({ name: 'Despesas', color: '#DCE4EC', values: s.map((x: any) => Number(exp.find((e: any) => e.month === x.month)?.value ?? 0)) });
    return out;
  });
  readonly topProducts = computed(() => (this.data()?.topProducts ?? []).map((p: any) => ({ label: p.name, value: Number(p.value) })));

  readonly kpis = computed<Kpi[]>(() => {
    const d = this.data(); if (!d) return [];
    const k = d.kpis, f = d.finance;
    const trend = (v: number | null) => (v === null || v === undefined ? 'neutral' : v >= 0 ? 'up' : 'down') as Kpi['trend'];
    const varTxt = (v: number | null) => (v === null || v === undefined ? 'sem base no mês anterior' : `${v >= 0 ? '+' : ''}${num(v, 1)}% vs. mês ant. (mesmo período)`);
    const list: Kpi[] = [
      { label: 'Faturamento do Mês', value: brl(k.revenue), sub: varTxt(k.revenueVar), trend: trend(k.revenueVar), icon: 'dollar-sign', color: '#0875D1', bg: '#E3EFF9', screen: 'relatorios' },
      k.grossProfit !== null
        ? { label: 'Lucro Bruto', value: brl(k.grossProfit), sub: `Margem bruta ${pct(k.grossMarginPct)}`, trend: 'neutral', icon: 'trending-up', color: '#18864B', bg: '#E8F5EE', screen: 'dre' }
        : { label: 'Vendas no Mês', value: num(k.sales), sub: varTxt(k.salesVar), trend: trend(k.salesVar), icon: 'shopping-cart', color: '#18864B', bg: '#E8F5EE', screen: 'pedidos' },
      { label: 'Ticket Médio', value: brl(k.ticket), sub: `${num(k.itemsPerSale, 2)} peças por venda · ${varTxt(k.ticketVar)}`, trend: trend(k.ticketVar), icon: 'receipt', color: '#D99000', bg: '#FFF4E0', screen: 'relatorios' },
      { label: 'Clientes Ativos', value: num(k.activeCustomers), sub: `${num(k.customersMonth)} compraram este mês (90 dias)`, trend: 'neutral', icon: 'users', color: '#18864B', bg: '#E8F5EE', screen: 'clientes' },
      { label: 'Condicionais em Aberto', value: num(k.conditionalsOpen), sub: k.conditionalsOverdue ? `${k.conditionalsOverdue} com prazo vencido` : 'nenhum atrasado', trend: k.conditionalsOverdue ? 'down' : 'neutral', icon: 'shopping-bag', color: '#2878C7', bg: '#E3EFF9', screen: 'condicionais' },
      { label: 'Estoque Total', value: k.stockValueCost !== null ? brl(k.stockValueCost) : num(k.stockPieces) + ' pç', sub: `${num(k.stockPieces)} peças · ${num(k.stockSkus)} SKUs · ${brl(k.stockValueSale)} a preço de venda`, trend: 'neutral', icon: 'boxes', color: '#647687', bg: '#EEF2F6', screen: 'estoque' },
    ];
    if (f) list.push(
      { label: 'Contas a Receber', value: brl(f.receivable), sub: `${brl(f.receivable_overdue)} vencidos`, trend: Number(f.receivable_overdue) > 0 ? 'down' : 'neutral', icon: 'wallet', color: '#D99000', bg: '#FFF4E0', screen: 'contas-receber' },
      { label: 'Contas a Pagar', value: brl(f.payable), sub: f.next_payable_date ? `Próx. vencimento: ${dateBr(f.next_payable_date)}` : 'sem vencimentos', trend: 'neutral', icon: 'credit-card', color: '#C93636', bg: '#FCEAEA', screen: 'contas-pagar' },
      { label: 'Saldo de Caixa', value: brl(f.cash_balance), sub: `${Number(f.cash_today) >= 0 ? '+' : ''}${brl(f.cash_today)} hoje`, trend: Number(f.cash_today) >= 0 ? 'up' : 'down', icon: 'landmark', color: '#18864B', bg: '#E8F5EE', screen: 'financeiro' },
    );
    return list;
  });
}
