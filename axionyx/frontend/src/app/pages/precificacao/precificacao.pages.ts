import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, ModuleTabsComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { CHARTS, Series } from '../../shared/charts';
import { Api, newIdempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, addDaysIso, brl, num, pct, todayIso } from '../../core/format';

export const PRICING_TABS = [
  { path: '/precificacao', label: 'Painel' }, { path: '/precificar-produto', label: 'Precificar Produto' }, { path: '/custos-fixos', label: 'Custos Fixos' },
  { path: '/custos-variaveis', label: 'Custos Variáveis e Parâmetros' }, { path: '/analise-precos', label: 'Análise de Produtos' }, { path: '/historico-precos', label: 'Histórico e Metas' },
];
export const FIXED_CATEGORIES: [string, string][] = [['ocupacao', 'Ocupação (aluguel, condomínio, IPTU)'], ['pessoal', 'Pessoal (salários e encargos)'], ['pro_labore', 'Pró-labore'],
  ['administrativo', 'Administrativo (energia, sistemas, contador)'], ['comercial', 'Comercial (marketing fixo)'], ['financeiro', 'Financeiro (tarifas, juros fixos)'], ['depreciacao', 'Depreciação'], ['outros', 'Outros']];
export const VARIABLE_CATEGORIES: [string, string][] = [['impostos', 'Impostos sobre vendas'], ['cartao', 'Taxa de cartão / adquirente'], ['comissao', 'Comissão de vendas'], ['marketplace', 'Comissão de marketplace'],
  ['frete', 'Frete de venda'], ['embalagem', 'Embalagem / etiqueta'], ['perdas', 'Perdas e quebras'], ['royalties', 'Royalties / franquia'], ['outros', 'Outros']];
const CAT_LABEL = Object.fromEntries([...FIXED_CATEGORIES, ...VARIABLE_CATEGORIES].map(([k, l]) => [k, l.split(' (')[0]]));
const CHANNEL_LABEL: Record<string, string> = { todos: 'Todos os canais', loja: 'Loja física', ecommerce: 'E-commerce', marketplace: 'Marketplace' };
const ROUNDING: [string, string][] = [['centavos_90', 'Terminar em ,90'], ['centavos_99', 'Terminar em ,99'], ['inteiro', 'Real inteiro'], ['nenhum', 'Sem arredondamento']];
const STATUS: Record<string, [string, string]> = {
  ok: ['Margem OK', 'badge-success'], abaixo_meta: ['Abaixo da meta', 'badge-warning'], abaixo_minimo: ['Abaixo do mínimo', 'badge-danger'],
  prejuizo: ['Prejuízo líquido', 'badge-danger'], prejuizo_variavel: ['Não cobre custo variável', 'badge-danger'], sem_custo: ['Sem custo cadastrado', 'badge-muted'],
};
const COLORS = ['#0875D1', '#18864B', '#D99000', '#C2185B', '#6B4FBB', '#00838F', '#E07800', '#647687'];

const H1 = 'font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px';
const SUB = 'font-size:13px;color:#647687';
const KL = 'font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px';

// ─── Painel ─────────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-precificacao',
  imports: [IconComponent, ModuleTabsComponent, StateComponent, ...CHARTS, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <div><h1 style="${H1}">Precificação — Painel Gerencial</h1>
        <p style="${SUB}">Margem de contribuição, ponto de equilíbrio e margem de segurança calculados com os custos cadastrados e as vendas reais</p></div>
      <div style="display:flex;gap:8px">
        <button class="btn-secondary" (click)="router.navigateByUrl('/custos-fixos')"><ax-icon name="building-2" [size]="14" /> Custos fixos</button>
        <button class="btn-primary" (click)="router.navigateByUrl('/precificar-produto')"><ax-icon name="calculator" [size]="14" /> Precificar produto</button>
      </div>
    </div>
    <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
    @if (d(); as d) {
      <div class="state-info" style="margin:0 0 16px"><ax-icon name="info" [size]="14" />
        <span>Base de faturamento: <b>{{ d.basis.mode === 'manual' ? 'informada manualmente' : 'média mensal das vendas dos últimos 3 meses' }}</b> ({{ d.basis.revenueBase | brl }}/mês).
          Custos variáveis e fixos vêm das telas de cadastro desta seção. Indicadores gerenciais — não substituem a contabilidade oficial.</span></div>
      @if (!d.current.fixedCosts) { <div class="state-warning" style="margin:0 0 16px"><ax-icon name="alert-triangle" [size]="14" /><span>Nenhum custo fixo cadastrado: ponto de equilíbrio e margem de segurança ficam sem significado. <a style="cursor:pointer;color:#0875D1" (click)="router.navigateByUrl('/custos-fixos')">Cadastrar custos fixos</a>.</span></div> }
      @if (!d.current.revenue) { <div class="state-warning" style="margin:0 0 16px"><ax-icon name="alert-triangle" [size]="14" /><span>Sem vendas nos últimos 3 meses. Informe um faturamento mensal de referência em <a style="cursor:pointer;color:#0875D1" (click)="router.navigateByUrl('/custos-variaveis')">Parâmetros</a>.</span></div> }
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:12px">
        @for (k of kpis(); track k.label) {
          <div class="kpi-card"><div style="${KL}">{{ k.label }}</div><div style="font-size:22px;font-weight:700" [style.color]="k.color || '#172B3A'">{{ k.value }}</div>
            <div style="font-size:11px;color:#647687;margin-top:2px">{{ k.sub }}</div></div>
        }
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:20px">
        @for (k of kpis2(); track k.label) {
          <div class="kpi-card"><div style="${KL}">{{ k.label }}</div><div style="font-size:22px;font-weight:700" [style.color]="k.color || '#172B3A'">{{ k.value }}</div>
            <div style="font-size:11px;color:#647687;margin-top:2px">{{ k.sub }}</div></div>
        }
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card" style="padding:16px">
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:4px">Faturamento × Ponto de equilíbrio (6 meses)</div>
          <div style="font-size:11px;color:#647687;margin-bottom:10px">Ponto de equilíbrio de cada mês = custos fixos atuais ÷ índice de margem de contribuição do mês</div>
          <ax-line-chart [labels]="labels()" [series]="series()" [height]="200" [legend]="true" [fmt]="brlFmt" />
        </div>
        <div class="card" style="padding:16px">
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:10px">Estrutura do faturamento médio</div>
          @for (s of structure(); track s.label) {
            <div style="margin-bottom:10px">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>{{ s.label }}</span><span class="mono">{{ s.value | brl }} · {{ s.pct | pct }}</span></div>
              <div style="height:8px;background:#F0F4F8;border-radius:4px"><div [style.width.%]="s.bar" [style.background]="s.color" style="height:100%;border-radius:4px"></div></div>
            </div>
          }
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card" style="padding:16px">
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:10px">Custos fixos por categoria ({{ d.current.fixedCosts | brl }}/mês)</div>
          @if (donut().length) { <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><ax-donut [data]="donut()" [size]="130" [fmt]="brlFmt" />
            <div style="flex:1;min-width:180px">@for (x of donut(); track x.label) { <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span style="display:flex;align-items:center;gap:6px"><span [style.background]="x.color" style="width:8px;height:8px;border-radius:2px"></span>{{ x.label }}</span><span class="mono">{{ x.value | brl }}</span></div> }</div></div>
          } @else { <div class="empty-state">Nenhum custo fixo ativo.</div> }
        </div>
        <div class="card" style="padding:16px">
          <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:10px">Como os indicadores são calculados</div>
          <div style="font-size:12px;color:#455A6E;line-height:1.7">
            <div><b>Margem de contribuição</b> = faturamento − CMV − despesas variáveis</div>
            <div><b>Índice de MC</b> = margem de contribuição ÷ faturamento</div>
            <div><b>Ponto de equilíbrio</b> = custos fixos ÷ índice de MC</div>
            <div><b>Margem de segurança</b> = (faturamento − ponto de equilíbrio) ÷ faturamento</div>
            <div><b>Grau de alavancagem operacional</b> = MC ÷ resultado operacional</div>
            <div><b>Preço pelo markup divisor</b> = custo unitário ÷ [1 − (despesas variáveis% + custos fixos% + margem%)]</div>
          </div>
        </div>
      </div>
    }
  </div>`,
})
export class PrecificacaoPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router);
  readonly tabs = PRICING_TABS; readonly brlFmt = (v: number) => brl(v);
  readonly d = signal<any>(null); readonly loading = signal(true); readonly error = signal<string | null>(null);
  async ngOnInit() { await this.load(); }
  async load() {
    this.loading.set(true); this.error.set(null);
    try { this.d.set(await this.api.get('/pricing/indicators')); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); }
  }
  readonly kpis = computed(() => {
    const c = this.d()?.current; if (!c) return [];
    return [
      { label: 'Faturamento médio/mês', value: brl(c.revenue), sub: `CMV ${pct(c.cmvPct)} · desp. variáveis ${pct(c.variableExpensesPct)}` },
      { label: 'Margem de contribuição', value: brl(c.contribution), sub: `Índice de MC: ${pct(c.contributionPct)}`, color: c.contribution < 0 ? '#C93636' : '#18864B' },
      { label: 'Custos fixos/mês', value: brl(c.fixedCosts), sub: `${pct(c.fixedPct)} do faturamento` },
      { label: 'Resultado operacional', value: brl(c.operatingProfit), sub: `Margem líquida ${pct(c.netMarginPct)}`, color: c.operatingProfit < 0 ? '#C93636' : '#18864B' },
    ];
  });
  readonly kpis2 = computed(() => {
    const c = this.d()?.current; if (!c) return [];
    return [
      { label: 'Ponto de equilíbrio', value: c.breakevenRevenue != null ? brl(c.breakevenRevenue) : '—', sub: c.breakevenRevenue != null ? 'faturamento mínimo mensal para não ter prejuízo' : 'MC não cobre os custos' },
      { label: 'Margem de segurança', value: c.safetyMarginPct != null ? pct(c.safetyMarginPct) : '—', sub: c.safetyMarginValue != null ? `${brl(c.safetyMarginValue)} acima do equilíbrio` : '—', color: (c.safetyMarginPct ?? 0) < 0 ? '#C93636' : (c.safetyMarginPct ?? 0) < 10 ? '#D99000' : '#18864B' },
      { label: 'Alavancagem operacional', value: c.operatingLeverage != null ? num(c.operatingLeverage, 2) + 'x' : '—', sub: c.operatingLeverage != null ? `+10% em vendas ≈ +${num(c.operatingLeverage * 10, 0)}% no lucro` : 'sem lucro operacional no período' },
      { label: `Faturamento p/ ${num(c.desiredMarginPct, 0)}% de lucro`, value: c.revenueForTarget != null ? brl(c.revenueForTarget) : '—', sub: 'meta mensal com a estrutura atual' },
    ];
  });
  readonly labels = computed(() => (this.d()?.series ?? []).map((s: any) => { const [y, m] = s.month.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''); }));
  readonly series = computed<Series[]>(() => {
    const s = this.d()?.series ?? [];
    return [{ name: 'Faturamento', values: s.map((x: any) => x.revenue), color: '#0875D1' }, { name: 'Ponto de equilíbrio', values: s.map((x: any) => x.breakevenRevenue), color: '#C93636' }];
  });
  readonly structure = computed(() => {
    const c = this.d()?.current; if (!c || !c.revenue) return [];
    const rows = [
      { label: 'CMV (custo das mercadorias)', value: c.cmv, pct: c.cmvPct, color: '#647687' },
      { label: 'Despesas variáveis', value: c.variableExpenses, pct: c.variableExpensesPct, color: '#D99000' },
      { label: 'Custos fixos', value: c.fixedCosts, pct: c.fixedPct, color: '#6B4FBB' },
      { label: c.operatingProfit >= 0 ? 'Lucro operacional' : 'Prejuízo operacional', value: c.operatingProfit, pct: c.netMarginPct, color: c.operatingProfit >= 0 ? '#18864B' : '#C93636' },
    ];
    return rows.map((r) => ({ ...r, bar: Math.min(100, Math.abs(r.pct)) }));
  });
  readonly donut = computed(() => (this.d()?.fixedByCategory ?? []).map((r: any, i: number) => ({ label: CAT_LABEL[r.category] ?? r.category, value: Number(r.total), color: COLORS[i % COLORS.length] })));
}

// ─── Custos fixos ───────────────────────────────────────────────────────────
@Component({
  selector: 'ax-custos-fixos',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, StateComponent, PagerComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div><h1 style="${H1}">Custos Fixos</h1><p style="${SUB}">Gastos mensais que não variam com o volume de vendas — usados no rateio do preço e no ponto de equilíbrio</p></div>
      @if (canEdit) { <div style="display:flex;gap:8px">
        <button class="btn-secondary" (click)="openSuggest()"><ax-icon name="download" [size]="14" /> Importar das contas a pagar</button>
        <button class="btn-primary" (click)="edit(null)"><ax-icon name="plus" [size]="14" /> Novo custo fixo</button></div> }
    </div>
    <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:16px">
      <div class="kpi-card"><div style="${KL}">Total mensal (ativos)</div><div style="font-size:22px;font-weight:700">{{ ctx()?.fixedTotal | brl }}</div><div style="font-size:11px;color:#647687">{{ ctx()?.fixedCount ?? 0 }} item(ns) ativo(s)</div></div>
      <div class="kpi-card"><div style="${KL}">Faturamento de referência</div><div style="font-size:22px;font-weight:700">{{ ctx()?.revenueBase | brl }}</div><div style="font-size:11px;color:#647687">{{ ctx()?.settings?.revenue_base_mode === 'manual' ? 'informado manualmente' : 'média dos últimos 3 meses' }}</div></div>
      <div class="kpi-card"><div style="${KL}">Custo fixo % do faturamento</div><div style="font-size:22px;font-weight:700" [style.color]="(ctx()?.fixedPctRaw ?? 0) > 40 ? '#C93636' : '#172B3A'">{{ ctx()?.revenueBase ? (ctx()?.fixedPctRaw | pct:2) : '—' }}</div><div style="font-size:11px;color:#647687">{{ ctx()?.settings?.include_fixed_costs ? 'rateado no preço' : 'não rateado no preço (parâmetro)' }}</div></div>
      <div class="kpi-card"><div style="${KL}">Custo fixo por dia</div><div style="font-size:22px;font-weight:700">{{ (ctx()?.fixedTotal ?? 0) / 30 | brl }}</div><div style="font-size:11px;color:#647687">base de 30 dias</div></div>
    </div>
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #EEF2F6">
        <input class="input-field" style="max-width:260px" placeholder="Buscar descrição…" [(ngModel)]="q" (keyup.enter)="search()" />
        <button class="btn-secondary" (click)="search()"><ax-icon name="search" [size]="13" /> Buscar</button>
        <span style="flex:1"></span>
        @for (c of byCategory(); track c.category) { <span class="chip">{{ label(c.category) }}: {{ c.total | brl }}</span> }
      </div>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum custo fixo cadastrado. Cadastre aluguel, folha, energia, sistemas, pró-labore etc." (retry)="list.reload()" />
      @if (list.items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Descrição</th><th>Categoria</th><th>Abrangência</th><th class="num">Valor mensal</th><th class="num">% do total</th><th>Situação</th><th></th></tr></thead>
          <tbody>@for (r of list.items(); track r.id) {
            <tr [style.opacity]="r.active ? 1 : 0.55"><td style="font-weight:500">{{ r.description }}@if (r.notes) { <div style="font-size:11px;color:#647687">{{ r.notes }}</div> }</td>
              <td><span class="badge badge-muted">{{ label(r.category) }}</span></td><td style="font-size:12px">{{ branchName(r.branch_id) }}</td>
              <td class="num" style="font-weight:600">{{ r.monthly_amount | brl }}</td><td class="num">{{ ctx()?.fixedTotal ? ((r.active ? r.monthly_amount : 0) / ctx()!.fixedTotal * 100 | pct) : '—' }}</td>
              <td><span class="badge" [class.badge-success]="r.active" [class.badge-muted]="!r.active">{{ r.active ? 'Ativo' : 'Inativo' }}</span></td>
              <td style="text-align:right;white-space:nowrap">@if (canEdit) {
                <button class="btn-ghost" title="Editar" (click)="edit(r)"><ax-icon name="pencil" [size]="13" /></button>
                <button class="btn-ghost" [title]="r.active ? 'Inativar' : 'Reativar'" (click)="toggle(r)"><ax-icon [name]="r.active ? 'pause' : 'play'" [size]="13" /></button>
                <button class="btn-ghost" title="Excluir" style="color:#C93636" (click)="remove(r)"><ax-icon name="trash-2" [size]="13" /></button> }</td></tr>
          }</tbody></table></div>
        <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
      }
    </div>
  </div>
  <ax-modal [open]="!!f" (closed)="f = null" [title]="f?.id ? 'Editar custo fixo' : 'Novo custo fixo'" icon="building-2" [width]="560">
    @if (f) {
      <div class="form-grid-2">
        <div class="span-all"><label class="field-label">Descrição *</label><input class="input-field" [(ngModel)]="f.description" maxlength="150" placeholder="Ex.: Aluguel da loja, Folha de pagamento, Contador" /></div>
        <div><label class="field-label">Categoria *</label><select class="input-field" [(ngModel)]="f.category">@for (c of cats; track c[0]) { <option [value]="c[0]">{{ c[1] }}</option> }</select></div>
        <div><label class="field-label">Valor mensal (R$) *</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.monthly_amount" /></div>
        <div><label class="field-label">Abrangência</label><select class="input-field" [(ngModel)]="f.branch_id"><option value="">Empresa toda</option>@for (b of lk.data()?.branches ?? []; track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select></div>
        <div style="display:flex;align-items:flex-end"><label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.active" /> Ativo (entra no cálculo)</label></div>
        <div class="span-all"><label class="field-label">Observação</label><input class="input-field" [(ngModel)]="f.notes" maxlength="500" /></div>
      </div>
      <p style="font-size:11px;color:#647687;margin-top:8px">Valores anuais (IPTU, seguro, 13º) devem ser divididos por 12. Custos que variam com cada venda (taxa de cartão, comissão, impostos) vão em Custos Variáveis.</p>
    }
    <div footer><button class="btn-secondary" (click)="f = null">Cancelar</button><button class="btn-primary" [disabled]="busy() || !f?.description || !(f?.monthly_amount >= 0)" (click)="save()">Salvar</button></div>
  </ax-modal>
  <ax-modal [open]="suggestOpen()" (closed)="suggestOpen.set(false)" title="Importar custos fixos das contas a pagar" icon="download" [width]="720">
    <p style="font-size:12px;color:#647687;margin-bottom:10px">Despesas recorrentes (2 ou mais títulos) dos últimos 90 dias nas categorias de despesas da DRE, com a média mensal. Taxas de cartão e comissões ficam de fora porque são custos variáveis. Revise antes de importar.</p>
    <ax-state [loading]="suggestLoading()" [empty]="!suggestLoading() && !suggestions().length" emptyText="Nenhuma despesa recorrente encontrada nas contas a pagar." />
    @if (suggestions().length) {
      <div style="max-height:360px;overflow:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
        <thead><tr><th></th><th>Descrição</th><th>Categoria</th><th class="num">Títulos</th><th class="num">Média mensal</th></tr></thead>
        <tbody>@for (s of suggestions(); track $index) {
          <tr><td><input type="checkbox" [(ngModel)]="s.pick" [disabled]="s.already" /></td><td>{{ s.description }}@if (s.already) { <span class="badge badge-muted" style="margin-left:6px">já cadastrado</span> }</td>
            <td><select class="input-field" style="padding:4px 6px;font-size:12px" [(ngModel)]="s.category">@for (c of cats; track c[0]) { <option [value]="c[0]">{{ c[1].split(' (')[0] }}</option> }</select></td>
            <td class="num">{{ s.titles }}</td><td class="num"><input type="number" min="0" step="0.01" class="input-field mono" style="width:110px;padding:4px 6px;font-size:12px;text-align:right" [(ngModel)]="s.monthly_amount" /></td></tr>
        }</tbody></table></div>
    }
    <div footer><button class="btn-secondary" (click)="suggestOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy() || !picked()" (click)="importSuggestions()">Importar {{ picked() }} item(ns)</button></div>
  </ax-modal>`,
})
export class CustosFixosPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); readonly lk = inject(LookupsService); private auth = inject(AuthService);
  readonly tabs = PRICING_TABS; readonly cats = FIXED_CATEGORIES; readonly canEdit = this.auth.can('precificacao.editar');
  readonly list = new ListState((q) => this.api.get('/pricing/fixed-costs', { ...q, size: 100 }));
  readonly ctx = signal<any>(null); readonly busy = signal(false);
  readonly allRows = signal<any[]>([]);
  readonly suggestOpen = signal(false); readonly suggestLoading = signal(false); readonly suggestions = signal<any[]>([]); readonly tick = signal(0);
  q = ''; f: any = null;
  constructor() { this.lk.ensure(); }
  async ngOnInit() { await this.refresh(); }
  async refresh() {
    await this.list.load(this.list.page());
    try {
      const [c, all] = await Promise.all([this.api.get('/pricing/settings'), this.api.get<any>('/pricing/fixed-costs', { size: 500 })]);
      this.ctx.set(c); this.allRows.set(all.items);
    } catch (e) { this.toast.error(e); }
  }
  readonly byCategory = computed(() => {
    const m = new Map<string, number>();
    for (const r of this.allRows()) if (r.active) m.set(r.category, (m.get(r.category) ?? 0) + Number(r.monthly_amount));
    return [...m.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
  });
  label(c: string) { return CAT_LABEL[c] ?? c; }
  branchName(id: string | null) { return id ? (this.lk.data()?.branches ?? []).find((b: any) => b.id === id)?.name ?? 'Filial' : 'Empresa toda'; }
  search() { this.list.query = { q: this.q }; this.list.load(1); }
  edit(r: any) { this.f = r ? { ...r, branch_id: r.branch_id || '', notes: r.notes || '' } : { category: 'ocupacao', description: '', monthly_amount: null, branch_id: '', active: true, notes: '' }; }
  async save() {
    this.busy.set(true);
    const body = { category: this.f.category, description: this.f.description, monthly_amount: +this.f.monthly_amount, branch_id: this.f.branch_id || null, active: !!this.f.active, notes: this.f.notes || null };
    try {
      if (this.f.id) await this.api.put(`/pricing/fixed-costs/${this.f.id}`, body); else await this.api.post('/pricing/fixed-costs', body);
      this.toast.success('Custo fixo salvo.'); this.f = null; await this.refresh();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async toggle(r: any) { try { await this.api.put(`/pricing/fixed-costs/${r.id}`, { active: !r.active }); await this.refresh(); } catch (e) { this.toast.error(e); } }
  async remove(r: any) {
    if (!confirm(`Excluir o custo fixo "${r.description}"? Para manter o histórico, prefira inativar.`)) return;
    try { await this.api.delete(`/pricing/fixed-costs/${r.id}`); this.toast.success('Custo fixo excluído.'); await this.refresh(); } catch (e) { this.toast.error(e); }
  }
  async openSuggest() {
    this.suggestOpen.set(true); this.suggestLoading.set(true);
    try { this.suggestions.set((await this.api.get<any[]>('/pricing/fixed-costs-suggestions')).map((s) => ({ ...s, monthly_amount: Number(s.monthly_amount), pick: false }))); }
    catch (e) { this.toast.error(e); } finally { this.suggestLoading.set(false); }
  }
  picked() { return this.suggestions().filter((s) => s.pick).length; }
  async importSuggestions() {
    this.busy.set(true); let n = 0;
    try {
      for (const s of this.suggestions().filter((x) => x.pick)) {
        await this.api.post('/pricing/fixed-costs', { category: s.category, description: s.description, monthly_amount: +s.monthly_amount, notes: `Média de ${s.titles} título(s) das contas a pagar (90 dias)` }); n++;
      }
      this.toast.success(`${n} custo(s) fixo(s) importado(s).`); this.suggestOpen.set(false); await this.refresh();
    } catch (e) { this.toast.error(e); if (n) await this.refresh(); } finally { this.busy.set(false); }
  }
}

// ─── Custos variáveis e parâmetros ─────────────────────────────────────────
@Component({
  selector: 'ax-custos-variaveis',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, StateComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div><h1 style="${H1}">Custos Variáveis e Parâmetros</h1><p style="${SUB}">Despesas que acompanham cada venda (impostos, cartão, comissão, marketplace, embalagem) e regras de formação do preço</p></div>
      @if (canEdit) { <button class="btn-primary" (click)="edit(null)"><ax-icon name="plus" [size]="14" /> Novo custo variável</button> }
    </div>
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;margin-bottom:16px">
      @for (c of channels; track c) {
        <div class="kpi-card"><div style="${KL}">{{ chLabel[c] }}</div><div style="font-size:22px;font-weight:700">{{ totals()[c]?.variablePct ?? 0 | pct:2 }}</div>
          <div style="font-size:11px;color:#647687">sobre o preço + {{ totals()[c]?.unitVariable ?? 0 | brl }} por unidade</div></div>
      }
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" class="pricing-split">
      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Custos e despesas variáveis</div>
        <ax-state [loading]="loading()" [empty]="!loading() && !rows().length" emptyText="Nenhum custo variável cadastrado." />
        @if (rows().length) {
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>Descrição</th><th>Canal</th><th class="num">Valor</th><th></th></tr></thead>
            <tbody>@for (r of rows(); track r.id) {
              <tr [style.opacity]="r.active ? 1 : 0.55"><td><div style="font-weight:500">{{ r.description }}</div><div style="font-size:11px;color:#647687">{{ catLabel(r.category) }}@if (!r.active) { · inativo }</div></td>
                <td style="font-size:12px">{{ chLabel[r.channel] }}</td>
                <td class="num" style="font-weight:600">{{ r.kind === 'percentual' ? (r.value | pct:2) : (r.value | brl) + '/un.' }}</td>
                <td style="text-align:right;white-space:nowrap">@if (canEdit) {
                  <button class="btn-ghost" title="Editar" (click)="edit(r)"><ax-icon name="pencil" [size]="13" /></button>
                  <button class="btn-ghost" [title]="r.active ? 'Inativar' : 'Reativar'" (click)="toggle(r)"><ax-icon [name]="r.active ? 'pause' : 'play'" [size]="13" /></button>
                  <button class="btn-ghost" title="Excluir" style="color:#C93636" (click)="remove(r)"><ax-icon name="trash-2" [size]="13" /></button> }</td></tr>
            }</tbody></table></div>
        }
        <p style="font-size:11px;color:#647687;padding:10px 16px">Percentuais incidem sobre o preço de venda (entram no divisor do markup). Valores por unidade somam ao custo unitário. Itens "Todos os canais" valem para qualquer canal; os específicos somam apenas no canal indicado. A alíquota de impostos é uma estimativa — confirme com o seu contador.</p>
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:12px">Parâmetros de formação de preço</div>
        @if (s) {
          <div class="form-grid-2">
            <div><label class="field-label">Margem de lucro líquido desejada (%)</label><input type="number" step="0.1" class="input-field mono" [(ngModel)]="s.desired_margin_pct" [disabled]="!canEdit" /></div>
            <div><label class="field-label">Margem líquida mínima — alerta (%)</label><input type="number" step="0.1" class="input-field mono" [(ngModel)]="s.min_margin_pct" [disabled]="!canEdit" /></div>
            <div class="span-all"><label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="s.include_fixed_costs" [disabled]="!canEdit" /> Ratear custos fixos no preço (percentual sobre o faturamento)</label></div>
            <div><label class="field-label">Faturamento de referência</label><select class="input-field" [(ngModel)]="s.revenue_base_mode" [disabled]="!canEdit"><option value="media_3m">Média das vendas (3 meses)</option><option value="manual">Informar manualmente</option></select></div>
            <div><label class="field-label">Faturamento mensal (R$)</label>
              @if (s.revenue_base_mode === 'manual') { <input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="s.revenue_base_manual" [disabled]="!canEdit" /> }
              @else { <input class="input-field mono" [value]="(ctx()?.revenueAuto | brl)" disabled /> }</div>
            <div class="span-all"><label class="field-label">Arredondamento do preço sugerido</label><select class="input-field" [(ngModel)]="s.rounding" [disabled]="!canEdit">@for (r of rounding; track r[0]) { <option [value]="r[0]">{{ r[1] }}</option> }</select></div>
          </div>
          <div class="state-info" style="margin:12px 0 0"><ax-icon name="calculator" [size]="14" /><span>Com os parâmetros atuais (loja física): custos fixos = <b>{{ ctx()?.fixedPct | pct:2 }}</b> do faturamento, despesas variáveis = <b>{{ ctx()?.variablePct | pct:2 }}</b>, margem = <b>{{ s.desired_margin_pct | pct:1 }}</b>.
            Markup divisor = <b>{{ divisor() | num:4 }}</b> → multiplicador <b>{{ divisor() > 0 ? (1 / divisor() | num:4) : '—' }}</b> sobre o custo unitário.</span></div>
          @if (divisor() <= 0) { <div class="state-error" style="margin:8px 0 0"><ax-icon name="alert-triangle" [size]="14" /><span>A soma de despesas variáveis, custos fixos e margem chega a 100% ou mais: não existe preço que atenda. Reduza a margem, revise os custos ou aumente o faturamento de referência.</span></div> }
          @if (canEdit) { <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn-primary" [disabled]="busy()" (click)="saveSettings()">Salvar parâmetros</button></div> }
        }
      </div>
    </div>
  </div>
  <ax-modal [open]="!!f" (closed)="f = null" [title]="f?.id ? 'Editar custo variável' : 'Novo custo variável'" icon="percent" [width]="540">
    @if (f) {
      <div class="form-grid-2">
        <div class="span-all"><label class="field-label">Descrição *</label><input class="input-field" [(ngModel)]="f.description" maxlength="150" placeholder="Ex.: Simples Nacional, Taxa crédito parcelado, Comissão vendedores" /></div>
        <div><label class="field-label">Categoria *</label><select class="input-field" [(ngModel)]="f.category">@for (c of cats; track c[0]) { <option [value]="c[0]">{{ c[1] }}</option> }</select></div>
        <div><label class="field-label">Canal</label><select class="input-field" [(ngModel)]="f.channel">@for (c of allChannels; track c) { <option [value]="c">{{ chLabel[c] }}</option> }</select></div>
        <div><label class="field-label">Tipo *</label><select class="input-field" [(ngModel)]="f.kind"><option value="percentual">% sobre o preço de venda</option><option value="valor_unitario">R$ por unidade vendida</option></select></div>
        <div><label class="field-label">{{ f.kind === 'percentual' ? 'Percentual (%)' : 'Valor por unidade (R$)' }} *</label><input type="number" min="0" [max]="f.kind === 'percentual' ? 99.99 : null" step="0.01" class="input-field mono" [(ngModel)]="f.value" /></div>
        <div class="span-all"><label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.active" /> Ativo (entra no cálculo)</label></div>
      </div>
    }
    <div footer><button class="btn-secondary" (click)="f = null">Cancelar</button><button class="btn-primary" [disabled]="busy() || !f?.description || !(f?.value >= 0) || (f?.kind === 'percentual' && f?.value >= 100)" (click)="save()">Salvar</button></div>
  </ax-modal>`,
})
export class CustosVariaveisPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); private auth = inject(AuthService);
  readonly tabs = PRICING_TABS; readonly cats = VARIABLE_CATEGORIES; readonly rounding = ROUNDING; readonly chLabel = CHANNEL_LABEL;
  readonly channels = ['loja', 'ecommerce', 'marketplace'] as const; readonly allChannels = ['todos', 'loja', 'ecommerce', 'marketplace'];
  readonly canEdit = this.auth.can('precificacao.editar');
  readonly rows = signal<any[]>([]); readonly loading = signal(true); readonly busy = signal(false);
  readonly ctx = signal<any>(null); readonly totals = signal<Record<string, any>>({}); readonly sv = signal(0);
  s: any = null; f: any = null;
  async ngOnInit() { await this.refresh(); }
  async refresh() {
    this.loading.set(true);
    try {
      const [list, ...ch] = await Promise.all([this.api.get<any>('/pricing/variable-costs', { size: 500 }), ...this.channels.map((c) => this.api.get('/pricing/settings', { channel: c }))]);
      this.rows.set(list.items); this.totals.set(Object.fromEntries(this.channels.map((c, i) => [c, ch[i]])));
      this.ctx.set(ch[0]); if (!this.s) this.s = { ...ch[0].settings, revenue_base_manual: ch[0].settings.revenue_base_manual ?? null };
      this.sv.update((x) => x + 1);
    } catch (e) { this.toast.error(e); } finally { this.loading.set(false); }
  }
  divisor() {
    const c = this.ctx(); if (!c || !this.s) return 1;
    const rev = this.s.revenue_base_mode === 'manual' ? +this.s.revenue_base_manual || 0 : c.revenueAuto;
    const fixed = this.s.include_fixed_costs && rev > 0 ? (c.fixedTotal / rev) * 100 : 0;
    return 1 - (c.variablePct + fixed + (+this.s.desired_margin_pct || 0)) / 100;
  }
  catLabel(c: string) { return CAT_LABEL[c] ?? c; }
  edit(r: any) { this.f = r ? { ...r } : { category: 'impostos', description: '', kind: 'percentual', value: null, channel: 'todos', active: true }; }
  async save() {
    this.busy.set(true);
    const body = { category: this.f.category, description: this.f.description, kind: this.f.kind, value: +this.f.value, channel: this.f.channel, active: !!this.f.active };
    try {
      if (this.f.id) await this.api.put(`/pricing/variable-costs/${this.f.id}`, body); else await this.api.post('/pricing/variable-costs', body);
      this.toast.success('Custo variável salvo.'); this.f = null; await this.refresh();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async toggle(r: any) { try { await this.api.put(`/pricing/variable-costs/${r.id}`, { active: !r.active }); await this.refresh(); } catch (e) { this.toast.error(e); } }
  async remove(r: any) {
    if (!confirm(`Excluir "${r.description}"?`)) return;
    try { await this.api.delete(`/pricing/variable-costs/${r.id}`); this.toast.success('Custo variável excluído.'); await this.refresh(); } catch (e) { this.toast.error(e); }
  }
  async saveSettings() {
    this.busy.set(true);
    try {
      await this.api.put('/pricing/settings', { desired_margin_pct: +this.s.desired_margin_pct, min_margin_pct: +this.s.min_margin_pct || 0, include_fixed_costs: !!this.s.include_fixed_costs,
        revenue_base_mode: this.s.revenue_base_mode, revenue_base_manual: this.s.revenue_base_mode === 'manual' ? +this.s.revenue_base_manual || null : null, rounding: this.s.rounding });
      this.toast.success('Parâmetros de precificação salvos.'); this.s = null; await this.refresh();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}

// ─── Precificar produto ─────────────────────────────────────────────────────
@Component({
  selector: 'ax-precificar-produto',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:16px"><h1 style="${H1}">Precificar Produto</h1><p style="${SUB}">Calcule o preço de venda pelo markup divisor, compare cenários e aplique o preço ao cadastro</p></div>
    <div class="pricing-split" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start">
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:10px">1. Produto</div>
        <div style="position:relative;margin-bottom:10px">
          <input class="input-field" placeholder="Buscar produto por nome ou código (ou deixe em branco para simulação livre)" [ngModel]="pq()" (ngModelChange)="searchProducts($event)" (blur)="hideResults()" />
          @if (presults().length) {
            <div class="autocomplete-list" style="position:absolute;left:0;right:0;top:100%;z-index:20;background:#fff;border:1px solid #DCE4EC;border-radius:8px;max-height:260px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.08)">
              @for (p of presults(); track p.id) { <div class="autocomplete-item" style="padding:8px 10px;cursor:pointer" (mousedown)="pickProduct(p)"><div style="display:flex;justify-content:space-between"><span style="font-weight:500">{{ p.name }}</span><span class="mono">{{ p.sale_price | brl }}</span></div><div style="font-size:11px;color:#647687">{{ p.code }} · {{ p.brand || 'sem marca' }} · custo {{ p.cost_price | brl }}</div></div> }
            </div>
          }
        </div>
        @if (product(); as p) {
          <div style="display:flex;justify-content:space-between;align-items:center;background:#F6F9FC;border-radius:8px;padding:10px 12px;margin-bottom:10px">
            <div><div style="font-weight:600">{{ p.name }}</div><div style="font-size:11px;color:#647687">{{ p.code }} · preço atual {{ currentPrice() | brl }} · custo cadastrado {{ currentCost() | brl }}</div></div>
            <button class="btn-ghost" title="Limpar" (click)="clearProduct()"><ax-icon name="x" [size]="14" /></button>
          </div>
          @if (variants().length > 1) {
            <label class="field-label">Variação (opcional — precifica só a variação; vazio = produto inteiro)</label>
            <select class="input-field" style="margin-bottom:10px" [(ngModel)]="variantId" (ngModelChange)="pickVariant()"><option value="">Produto (todas as variações)</option>
              @for (v of variants(); track v.id) { <option [value]="v.id">{{ v.sku }} — {{ v.color }} {{ v.size }}@if (v.sale_price) { · {{ v.sale_price | brl }} }</option> }</select>
          }
        }
        <div style="font-size:13px;font-weight:600;margin:6px 0 10px">2. Custo unitário</div>
        <div class="form-grid-3">
          <div><label class="field-label">Custo de aquisição *</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.acquisitionCost" (ngModelChange)="recalc()" /></div>
          <div><label class="field-label">Frete de compra</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.freight" (ngModelChange)="recalc()" /></div>
          <div><label class="field-label">Seguro</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.insurance" (ngModelChange)="recalc()" /></div>
          <div><label class="field-label">Embalagem extra</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.packaging" (ngModelChange)="recalc()" /></div>
          <div><label class="field-label">Armazenagem</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.storage" (ngModelChange)="recalc()" /></div>
          <div><label class="field-label">Outros custos</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.otherCosts" (ngModelChange)="recalc()" /></div>
          <div><label class="field-label">Perdas (% s/ custo)</label><input type="number" min="0" max="100" step="0.1" class="input-field mono" [(ngModel)]="f.lossesPct" (ngModelChange)="recalc()" /></div>
          <div><label class="field-label">Custo variável R$/un.</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.unitVariableCosts" (ngModelChange)="recalc()" [placeholder]="ctx()?.unitVariable" /></div>
          <div><label class="field-label">Canal de venda</label><select class="input-field" [(ngModel)]="f.channel" (ngModelChange)="channelChanged()"><option value="loja">Loja física</option><option value="ecommerce">E-commerce</option><option value="marketplace">Marketplace</option></select></div>
        </div>
        <div style="font-size:13px;font-weight:600;margin:14px 0 10px">3. Despesas e margem</div>
        <div class="form-grid-3">
          <div><label class="field-label">Despesas variáveis (%)</label><input type="number" min="0" max="99.99" step="0.01" class="input-field mono" [(ngModel)]="f.variablePct" (ngModelChange)="recalc()" [placeholder]="ctx()?.variablePct" /></div>
          <div><label class="field-label">Custos fixos (%)</label><input type="number" min="0" max="99.99" step="0.01" class="input-field mono" [(ngModel)]="f.fixedPct" (ngModelChange)="recalc()" [disabled]="!f.includeFixedCosts" [placeholder]="ctx()?.fixedPctRaw | num:2" /></div>
          <div style="display:flex;align-items:flex-end"><label style="display:flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" [(ngModel)]="f.includeFixedCosts" (ngModelChange)="recalc()" /> Ratear custos fixos</label></div>
          <div><label class="field-label">Calcular por</label><select class="input-field" [(ngModel)]="f.mode" (ngModelChange)="recalc()"><option value="margem">Margem líquida desejada</option><option value="markup">Markup direto (multiplicador)</option><option value="preco">Preço informado (analisar)</option></select></div>
          @if (f.mode === 'margem') { <div><label class="field-label">Margem líquida (%)</label><input type="number" step="0.1" class="input-field mono" [(ngModel)]="f.desiredMarginPct" (ngModelChange)="recalc()" /></div> }
          @if (f.mode === 'markup') { <div><label class="field-label">Markup (ex.: 2,5)</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.markup" (ngModelChange)="recalc()" /></div> }
          @if (f.mode === 'preco') { <div><label class="field-label">Preço de venda (R$)</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.price" (ngModelChange)="recalc()" /></div> }
          <div><label class="field-label">Arredondamento</label><select class="input-field" [(ngModel)]="f.rounding" (ngModelChange)="recalc()">@for (r of rounding; track r[0]) { <option [value]="r[0]">{{ r[1] }}</option> }</select></div>
        </div>
        <p style="font-size:11px;color:#647687;margin-top:10px">Campos vazios usam os valores cadastrados em Custos Variáveis e Parâmetros (canal {{ chLabel[f.channel] }}: {{ ctx()?.variablePct | pct:2 }} variáveis, {{ ctx()?.fixedPctRaw | pct:2 }} fixos, margem {{ ctx()?.settings?.desired_margin_pct | pct:1 }}).</p>
      </div>

      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card" style="padding:16px">
          @if (error()) { <div class="state-error" style="margin:0 0 10px"><ax-icon name="alert-triangle" [size]="14" /><span>{{ error() }}</span></div> }
          @if (r(); as r) {
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
              <div><div style="${KL}">{{ f.mode === 'preco' ? 'Preço analisado' : 'Preço sugerido' }}</div><div style="font-size:32px;font-weight:800;color:#0875D1">{{ r.suggestedPrice | brl }}</div>
                @if (r.currentPrice) { <div style="font-size:12px" [style.color]="r.suggestedPrice >= r.currentPrice ? '#18864B' : '#C93636'">Atual {{ r.currentPrice | brl }} · {{ (r.suggestedPrice - r.currentPrice) >= 0 ? '+' : '' }}{{ r.suggestedPrice - r.currentPrice | brl }} ({{ (r.suggestedPrice / r.currentPrice - 1) * 100 | pct }})</div> }</div>
              <div style="text-align:right"><div style="${KL}">Markup</div><div style="font-size:22px;font-weight:700">{{ r.markupMultiplier | num:4 }}x</div><div style="font-size:11px;color:#647687">divisor {{ r.divisor | num:4 }} · {{ r.markupOnCost | pct }} s/ custo</div></div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;margin:14px 0">
              <div style="background:#F6F9FC;border-radius:8px;padding:8px 10px"><div style="font-size:10px;color:#647687;text-transform:uppercase">Piso (cobre variáveis)</div><div class="mono" style="font-weight:700">{{ r.floorPrice | brl }}</div></div>
              <div style="background:#F6F9FC;border-radius:8px;padding:8px 10px"><div style="font-size:10px;color:#647687;text-transform:uppercase">Mínimo (lucro zero)</div><div class="mono" style="font-weight:700">{{ r.minimumPrice != null ? (r.minimumPrice | brl) : '—' }}</div></div>
              <div style="background:#F6F9FC;border-radius:8px;padding:8px 10px"><div style="font-size:10px;color:#647687;text-transform:uppercase">Equilíbrio (unid./mês)</div><div class="mono" style="font-weight:700">{{ r.breakevenUnits != null ? (r.breakevenUnits | num) : '—' }}</div></div>
            </div>
            <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px">
              <tbody>
                <tr><td>Preço de venda</td><td class="num" style="font-weight:600">{{ r.suggestedPrice | brl }}</td><td class="num">100,0%</td></tr>
                <tr><td>(−) Custo unitário</td><td class="num">{{ r.unitCost | brl }}</td><td class="num">{{ r.unitCost / r.suggestedPrice * 100 | pct }}</td></tr>
                <tr><td>(−) Despesas variáveis ({{ r.variablePct | pct:2 }})</td><td class="num">{{ r.variableExpenses | brl }}</td><td class="num">{{ r.variablePct | pct }}</td></tr>
                <tr style="background:#F2FAF5"><td style="font-weight:600">(=) Margem de contribuição</td><td class="num" style="font-weight:700" [style.color]="r.contributionUnit < 0 ? '#C93636' : '#18864B'">{{ r.contributionUnit | brl }}</td><td class="num" style="font-weight:600">{{ r.contributionPct | pct }}</td></tr>
                <tr><td>(−) Rateio de custos fixos ({{ r.fixedPct | pct:2 }})</td><td class="num">{{ r.fixedShare | brl }}</td><td class="num">{{ r.fixedPct | pct }}</td></tr>
                <tr style="background:#F6F9FC"><td style="font-weight:600">(=) Lucro líquido por unidade</td><td class="num" style="font-weight:700" [style.color]="r.netProfitUnit < 0 ? '#C93636' : '#172B3A'">{{ r.netProfitUnit | brl }}</td><td class="num" style="font-weight:600">{{ r.netMarginPct | pct }}</td></tr>
                <tr><td>Margem bruta (preço − custo de aquisição)</td><td class="num"></td><td class="num">{{ r.grossMarginPct | pct }}</td></tr>
              </tbody>
            </table>
            @if (r.breakevenRevenue != null) { <p style="font-size:11px;color:#647687;margin-top:8px">Vendendo só este produto, seriam necessárias <b>{{ r.breakevenUnits | num }}</b> unidades/mês ({{ r.breakevenRevenue | brl }}) para cobrir os custos fixos de {{ ctx()?.fixedTotal | brl }}.</p> }
            @if (r.currentAnalysis; as ca) {
              <div style="margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12px" [style.background]="ca.belowMinimum ? '#FDECEC' : '#F6F9FC'">
                <b>Preço atual ({{ r.currentPrice | brl }}):</b> MC {{ ca.contributionUnit | brl }} ({{ ca.contributionPct | pct }}) · lucro {{ ca.netProfitUnit | brl }} ({{ ca.netMarginPct | pct }}) · markup {{ ca.markupMultiplier | num:2 }}x
                @if (ca.belowFloor) { <div style="color:#C93636;font-weight:600;margin-top:2px">Abaixo do piso: cada venda não cobre nem os custos variáveis.</div> }
                @else if (ca.belowMinimum) { <div style="color:#C93636;font-weight:600;margin-top:2px">Abaixo do preço mínimo: não cobre a parcela de custos fixos.</div> }
              </div>
            }
            @for (w of r.warnings; track $index) { <div class="state-warning" style="margin:8px 0 0;font-size:12px"><ax-icon name="alert-triangle" [size]="13" /><span>{{ w }}</span></div> }
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;justify-content:flex-end">
              <button class="btn-secondary" (click)="addScenario()" [disabled]="scenarios().length >= 4"><ax-icon name="columns-2" [size]="13" /> Comparar cenário</button>
              @if (canEdit) { <button class="btn-secondary" (click)="saveOpen.set(true)"><ax-icon name="save" [size]="13" /> Salvar simulação</button> }
              @if (canEdit && product()) { <button class="btn-secondary" (click)="openGoal()"><ax-icon name="target" [size]="13" /> Definir como meta</button> }
              @if (canApply && product()) { <button class="btn-primary" (click)="openApply()"><ax-icon name="check-circle-2" [size]="13" /> Aplicar preço ao produto</button> }
            </div>
          } @else if (!error()) { <div class="empty-state"><ax-icon name="calculator" [size]="28" color="#A0AFBF" /><div style="margin-top:8px">Selecione um produto ou informe o custo de aquisição para calcular.</div></div> }
        </div>

        @if (scenarios().length) {
          <div class="card" style="overflow:hidden">
            <div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;font-weight:600">Comparação de cenários</span><button class="btn-ghost" style="font-size:12px" (click)="scenarios.set([])">Limpar</button></div>
            <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr><th>Indicador</th>@for (s of scenarios(); track $index) { <th class="num">{{ s.name }} <button class="btn-ghost" style="padding:0 2px" (click)="removeScenario($index)"><ax-icon name="x" [size]="11" /></button></th> }</tr></thead>
              <tbody>
                @for (row of compareRows; track row.k) {
                  <tr><td>{{ row.label }}</td>@for (s of scenarios(); track $index) { <td class="num" [style.font-weight]="row.bold ? 700 : 400">{{ fmtCell(s.r[row.k], row.f) }}</td> }</tr>
                }
              </tbody>
            </table></div>
          </div>
        }
      </div>
    </div>
  </div>

  <ax-modal [open]="saveOpen()" (closed)="saveOpen.set(false)" title="Salvar simulação" icon="save" [width]="420">
    <label class="field-label">Nome do cenário</label><input class="input-field" [(ngModel)]="scenarioName" maxlength="60" placeholder="Ex.: Black Friday, Coleção nova, Margem 20%" />
    <p style="font-size:11px;color:#647687;margin-top:8px">A simulação fica no histórico com todos os parâmetros usados. O preço do produto não é alterado.</p>
    <div footer><button class="btn-secondary" (click)="saveOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy()" (click)="saveSimulation()">Salvar</button></div>
  </ax-modal>

  <ax-modal [open]="applyOpen()" (closed)="applyOpen.set(false)" title="Aplicar preço ao cadastro" icon="check-circle-2" [width]="480">
    @if (product(); as p) {
      <div style="font-size:13px;margin-bottom:10px"><b>{{ p.name }}</b> @if (variantId) { — variação {{ variantSku() }} } <div style="font-size:12px;color:#647687">Preço atual: {{ currentPrice() | brl }}</div></div>
      <label class="field-label">Novo preço de venda (R$) *</label><input type="number" min="0.01" step="0.01" class="input-field mono" style="font-size:18px;font-weight:700" [(ngModel)]="applyPrice" />
      @if (!variantId && variantPrices() > 0) { <label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:10px"><input type="checkbox" [(ngModel)]="clearVariantPrices" /> Remover preços próprios de {{ variantPrices() }} variação(ões) para que todas usem o novo preço</label> }
      @if (r() && applyPrice < (r()!.minimumPrice ?? 0)) { <div class="state-warning" style="margin:10px 0 0"><ax-icon name="alert-triangle" [size]="13" /><span>O preço informado está abaixo do preço mínimo ({{ r()!.minimumPrice | brl }}) e não cobre a parcela de custos fixos.</span></div> }
      <p style="font-size:11px;color:#647687;margin-top:10px">O servidor recalcula a análise, grava o histórico de preço e a auditoria. Se houver integração de e-commerce ativa, o produto entra na fila de sincronização.</p>
    }
    <div footer><button class="btn-secondary" (click)="applyOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy() || !(applyPrice > 0)" (click)="apply()">Confirmar novo preço</button></div>
  </ax-modal>

  <ax-modal [open]="goalOpen()" (closed)="goalOpen.set(false)" title="Definir meta de vendas do produto" icon="target" [width]="520">
    @if (g) {
      <div class="form-grid-2">
        <div class="span-all"><label class="field-label">Nome da meta *</label><input class="input-field" [(ngModel)]="g.name" maxlength="150" /></div>
        <div><label class="field-label">Início *</label><input type="date" class="input-field" [(ngModel)]="g.startDate" /></div>
        <div><label class="field-label">Fim *</label><input type="date" class="input-field" [(ngModel)]="g.endDate" /></div>
        <div><label class="field-label">Preço unitário</label><input type="number" min="0.01" step="0.01" class="input-field mono" [(ngModel)]="g.unitPrice" /></div>
        <div><label class="field-label">Meta de unidades *</label><input type="number" min="0" step="1" class="input-field mono" [(ngModel)]="g.targetUnits" /></div>
      </div>
      <p style="font-size:12px;color:#647687;margin-top:10px">Faturamento-alvo: <b>{{ (g.targetUnits || 0) * (g.unitPrice || 0) | brl }}</b>. Ponto de equilíbrio deste produto: {{ r()?.breakevenUnits != null ? (r()!.breakevenUnits | num) + ' un./mês' : '—' }}.
        Uma meta ativa anterior deste produto é marcada como substituída (o histórico é mantido).</p>
    }
    <div footer><button class="btn-secondary" (click)="goalOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy() || !g?.name || !g?.startDate || !g?.endDate" (click)="saveGoal()">Salvar meta</button></div>
  </ax-modal>`,
})
export class PrecificarProdutoPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); private auth = inject(AuthService); private router = inject(Router);
  readonly productId = input<string>();
  readonly tabs = PRICING_TABS; readonly rounding = ROUNDING; readonly chLabel = CHANNEL_LABEL;
  readonly canEdit = this.auth.can('precificacao.editar'); readonly canApply = this.auth.can('precificacao.aplicar');
  readonly ctx = signal<any>(null); readonly r = signal<any>(null); readonly error = signal<string | null>(null); readonly busy = signal(false);
  readonly pq = signal(''); readonly presults = signal<any[]>([]); readonly product = signal<any>(null); readonly variants = signal<any[]>([]);
  readonly scenarios = signal<{ name: string; r: any }[]>([]);
  readonly saveOpen = signal(false); readonly applyOpen = signal(false); readonly goalOpen = signal(false);
  f: any = this.blank(); variantId = ''; scenarioName = ''; applyPrice = 0; clearVariantPrices = false; g: any = null;
  private t: any; private st: any; private seq = 0;
  readonly compareRows = [
    { k: 'unitCost', label: 'Custo unitário', f: 'brl' }, { k: 'suggestedPrice', label: 'Preço', f: 'brl', bold: true }, { k: 'markupMultiplier', label: 'Markup', f: 'x' },
    { k: 'contributionUnit', label: 'Margem de contribuição (R$)', f: 'brl' }, { k: 'contributionPct', label: 'Margem de contribuição (%)', f: 'pct' },
    { k: 'netProfitUnit', label: 'Lucro líquido/un.', f: 'brl', bold: true }, { k: 'netMarginPct', label: 'Margem líquida', f: 'pct' }, { k: 'minimumPrice', label: 'Preço mínimo', f: 'brl' },
    { k: 'breakevenUnits', label: 'Equilíbrio (un./mês)', f: 'num' },
  ];
  blank() { return { acquisitionCost: null, freight: null, insurance: null, packaging: null, storage: null, otherCosts: null, lossesPct: null, unitVariableCosts: null, variablePct: null, fixedPct: null,
    includeFixedCosts: true, mode: 'margem', desiredMarginPct: null, markup: null, price: null, rounding: '', channel: 'loja' }; }
  async ngOnInit() {
    await this.loadCtx();
    const id = this.productId() || new URLSearchParams(location.search).get('productId');
    if (id) { try { await this.pickProduct(await this.api.get(`/products/${id}`)); } catch (e) { this.toast.error(e); } }
  }
  async loadCtx() {
    try {
      const c = await this.api.get('/pricing/settings', { channel: this.f.channel }); this.ctx.set(c);
      if (this.f.desiredMarginPct === null) this.f.desiredMarginPct = Number(c.settings.desired_margin_pct);
      if (!this.f.rounding) this.f.rounding = c.settings.rounding;
      this.f.includeFixedCosts = this.f.includeFixedCosts && c.settings.include_fixed_costs;
    } catch (e) { this.toast.error(e); }
  }
  async channelChanged() { await this.loadCtx(); this.recalc(); }
  searchProducts(v: string) {
    this.pq.set(v); clearTimeout(this.st);
    if (v.trim().length < 2) { this.presults.set([]); return; }
    this.st = setTimeout(async () => { try { this.presults.set((await this.api.get<any>('/products', { q: v.trim(), size: 12, active: true })).items); } catch { /* */ } }, 250);
  }
  hideResults() { setTimeout(() => this.presults.set([]), 200); }
  async pickProduct(p: any) {
    this.presults.set([]); this.pq.set('');
    const full = p.variants && Array.isArray(p.variants) ? p : await this.api.get(`/products/${p.id}`);
    this.product.set(full); this.variants.set(full.variants ?? []); this.variantId = '';
    this.f.acquisitionCost = Number(full.cost_price) || null; this.recalc(0);
  }
  pickVariant() {
    const v = this.variants().find((x) => x.id === this.variantId);
    this.f.acquisitionCost = Number(v?.cost_price ?? this.product()?.cost_price) || null; this.recalc(0);
  }
  clearProduct() { this.product.set(null); this.variants.set([]); this.variantId = ''; this.recalc(0); }
  currentPrice() { const v = this.variants().find((x) => x.id === this.variantId); return Number(v?.sale_price ?? this.product()?.sale_price ?? 0); }
  currentCost() { const v = this.variants().find((x) => x.id === this.variantId); return Number(v?.cost_price ?? this.product()?.cost_price ?? 0); }
  variantSku() { return this.variants().find((x) => x.id === this.variantId)?.sku ?? ''; }
  variantPrices() { const base = Number(this.product()?.sale_price); return this.variants().filter((v) => v.sale_price != null && Number(v.sale_price) !== base).length; }
  private body(extra: any = {}) {
    const n = (x: any) => (x === null || x === undefined || x === '' ? undefined : +x);
    return { productId: this.product()?.id, variantId: this.variantId || undefined, channel: this.f.channel,
      acquisitionCost: n(this.f.acquisitionCost), freight: n(this.f.freight), insurance: n(this.f.insurance), packaging: n(this.f.packaging), storage: n(this.f.storage), otherCosts: n(this.f.otherCosts),
      lossesPct: n(this.f.lossesPct), unitVariableCosts: n(this.f.unitVariableCosts), variablePct: n(this.f.variablePct), fixedPct: n(this.f.fixedPct), includeFixedCosts: !!this.f.includeFixedCosts,
      desiredMarginPct: n(this.f.desiredMarginPct), mode: this.f.mode, markup: n(this.f.markup), price: n(this.f.price), rounding: this.f.rounding || undefined, ...extra };
  }
  recalc(delay = 350) {
    clearTimeout(this.t);
    this.t = setTimeout(async () => {
      if (!this.product() && !(+this.f.acquisitionCost > 0)) { this.r.set(null); this.error.set(null); return; }
      if (this.f.mode === 'markup' && !(+this.f.markup > 0)) return;
      if (this.f.mode === 'preco' && !(+this.f.price > 0)) return;
      const my = ++this.seq;
      try { const res: any = await this.api.post('/pricing/calculate', this.body()); if (my === this.seq) { this.r.set(res.result); this.error.set(null); } }
      catch (e: any) { if (my === this.seq) { this.r.set(null); this.error.set(e.details?.length ? e.details.map((d: any) => `${d.path}: ${d.message}`).join(' · ') : e.message); } }
    }, delay);
  }
  addScenario() {
    const r = this.r(); if (!r) return;
    const label = this.f.mode === 'margem' ? `Margem ${num(this.f.desiredMarginPct, 1)}%` : this.f.mode === 'markup' ? `Markup ${num(this.f.markup, 2)}` : `Preço ${brl(this.f.price)}`;
    this.scenarios.update((s) => [...s, { name: `${s.length + 1}. ${label}`, r }]);
  }
  removeScenario(i: number) { this.scenarios.update((s) => s.filter((_, k) => k !== i)); }
  fmtCell(v: any, f: string) { if (v === null || v === undefined) return '—'; return f === 'brl' ? brl(v) : f === 'pct' ? pct(v) : f === 'x' ? num(v, 4) + 'x' : num(v); }
  async saveSimulation() {
    this.busy.set(true);
    try { await this.api.post('/pricing/calculate', this.body({ save: true, scenarioName: this.scenarioName || undefined })); this.toast.success('Simulação salva no histórico.'); this.saveOpen.set(false); this.scenarioName = ''; }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  openApply() { this.applyPrice = this.r()?.suggestedPrice ?? 0; this.clearVariantPrices = false; this.applyOpen.set(true); }
  async apply() {
    this.busy.set(true);
    try {
      const res: any = await this.api.post('/pricing/apply', { ...this.body({ price: +this.applyPrice }), productId: this.product().id, clearVariantPrices: this.clearVariantPrices }, { idempotent: newIdempotencyKey() });
      this.toast.success(`Preço alterado de ${brl(res.previousPrice)} para ${brl(res.price)}.`); this.applyOpen.set(false);
      await this.pickProduct({ id: this.product().id });
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  openGoal() {
    const r = this.r(); const start = todayIso();
    this.g = { name: `Meta ${this.product()?.code} — ${new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}`, startDate: start, endDate: addDaysIso(start, 30),
      unitPrice: r?.suggestedPrice ?? this.currentPrice(), targetUnits: r?.breakevenUnits ?? 0 };
    this.goalOpen.set(true);
  }
  async saveGoal() {
    this.busy.set(true);
    try {
      const r = this.r();
      await this.api.post('/pricing/goals', { productId: this.product().id, name: this.g.name, startDate: this.g.startDate, endDate: this.g.endDate, targetUnits: +this.g.targetUnits, unitPrice: +this.g.unitPrice,
        unitContribution: r?.contributionUnit, breakevenUnits: r?.breakevenUnits ?? undefined });
      this.toast.success('Meta registrada. Acompanhe em Histórico e Metas.'); this.goalOpen.set(false);
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}

// ─── Análise de produtos ────────────────────────────────────────────────────
@Component({
  selector: 'ax-analise-precos',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, StateComponent, PagerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:16px"><h1 style="${H1}">Análise de Preços dos Produtos</h1><p style="${SUB}">Margem de contribuição e lucro de cada produto no preço atual, comparados com o preço sugerido pelos parâmetros da empresa</p></div>
    @if (list.extra()?.params; as p) {
      <div class="state-info" style="margin:0 0 12px"><ax-icon name="info" [size]="14" /><span>Parâmetros usados (loja física): despesas variáveis {{ p.variablePct | pct:2 }} + {{ p.unitVariable | brl }}/un. · custos fixos {{ p.fixedPct | pct:2 }} · margem desejada {{ p.desiredMarginPct | pct:1 }}. Custos de frete/seguro na compra não estão no cadastro — use Precificar Produto para incluí-los.</span></div>
    }
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      <span class="chip" [class.active]="!status" (click)="setStatus('')">Todos</span>
      @for (s of statusList; track s) { <span class="chip" [class.active]="status === s" (click)="setStatus(s)">{{ st[s][0] }} ({{ list.extra()?.summary?.[s] ?? 0 }})</span> }
    </div>
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;display:flex;gap:8px;border-bottom:1px solid #EEF2F6"><input class="input-field" style="max-width:280px" placeholder="Buscar produto…" [(ngModel)]="q" (keyup.enter)="search()" /><button class="btn-secondary" (click)="search()"><ax-icon name="search" [size]="13" /> Buscar</button></div>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" (retry)="list.reload()" />
      @if (list.items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Produto</th><th class="num">Custo un.</th><th class="num">Preço atual</th><th class="num">MC %</th><th class="num">Margem líq.</th><th class="num">Markup</th><th class="num">Preço mínimo</th><th class="num">Sugerido</th><th class="num">Vend. 90d</th><th>Situação</th><th></th></tr></thead>
          <tbody>@for (r of list.items(); track r.id) {
            <tr><td><div style="font-weight:500">{{ r.name }}</div><div style="font-size:11px;color:#647687">{{ r.code }} · {{ r.brand || '—' }}@if (r.variant_prices) { · {{ r.variant_prices }} variação(ões) com preço próprio }@if (r.last_applied) { · preço revisado em {{ r.last_applied | dt }} }</div></td>
              <td class="num">{{ r.analysis?.unitCost ?? r.cost | brl }}</td><td class="num" style="font-weight:600">{{ r.price | brl }}</td>
              <td class="num">{{ r.analysis?.contributionPct | pct }}</td><td class="num" [style.color]="(r.analysis?.netMarginPct ?? 0) < 0 ? '#C93636' : null">{{ r.analysis?.netMarginPct | pct }}</td>
              <td class="num">{{ r.analysis ? (r.analysis.markupMultiplier | num:2) + 'x' : '—' }}</td><td class="num">{{ r.analysis?.minimumPrice | brl }}</td>
              <td class="num" [style.color]="r.suggested && r.suggested > r.price ? '#C93636' : '#18864B'">{{ r.suggested | brl }}</td><td class="num">{{ r.sold_90d }}</td>
              <td><span style="white-space:nowrap" [class]="'badge ' + st[r.status][1]">{{ st[r.status][0] }}</span></td>
              <td><button class="btn-ghost" title="Precificar" (click)="price(r)"><ax-icon name="calculator" [size]="14" /></button></td></tr>
          }</tbody></table></div>
        <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
      }
    </div>
  </div>`,
})
export class AnalisePrecosPage implements OnInit {
  private api = inject(Api); private router = inject(Router);
  readonly tabs = PRICING_TABS; readonly st = STATUS; readonly statusList = ['ok', 'abaixo_meta', 'abaixo_minimo', 'prejuizo', 'prejuizo_variavel', 'sem_custo'];
  readonly list = new ListState((q) => this.api.get('/pricing/products', { ...q, size: 50 }));
  q = ''; status = '';
  ngOnInit() { this.list.load(1); }
  search() { this.list.query = { q: this.q, status: this.status }; this.list.load(1); }
  setStatus(s: string) { this.status = s; this.search(); }
  price(r: any) { this.router.navigate(['/precificar-produto'], { queryParams: { productId: r.id } }); }
}

// ─── Histórico e metas ──────────────────────────────────────────────────────
@Component({
  selector: 'ax-historico-precos',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, StateComponent, PagerComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:16px"><h1 style="${H1}">Histórico de Preços e Metas</h1><p style="${SUB}">Todas as simulações salvas e alterações de preço feitas pela precificação, com os parâmetros usados</p></div>
    <div class="card" style="overflow:hidden;margin-bottom:16px">
      <div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:13px;font-weight:600">Metas de vendas por produto</span>
        <select class="input-field" style="max-width:180px" [(ngModel)]="goalStatus" (ngModelChange)="loadGoals()"><option value="ativa">Ativas</option><option value="todas">Todas</option></select></div>
      <ax-state [loading]="goalsLoading()" [empty]="!goalsLoading() && !goals().length" emptyText="Nenhuma meta. Defina metas a partir da tela Precificar Produto." />
      @if (goals().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Meta</th><th>Período</th><th class="num">Preço</th><th class="num">Equilíbrio</th><th class="num">Meta (un.)</th><th class="num">Realizado</th><th style="width:160px">Progresso</th><th>Status</th><th></th></tr></thead>
          <tbody>@for (g of goals(); track g.id) {
            <tr><td><div style="font-weight:500">{{ g.name }}</div><div style="font-size:11px;color:#647687">{{ g.code }} · {{ g.product }}</div></td><td style="font-size:12px">{{ g.start_date | dt }} a {{ g.end_date | dt }}</td>
              <td class="num">{{ g.unit_price | brl }}</td><td class="num">{{ g.breakeven_units != null ? (g.breakeven_units | num) : '—' }}</td><td class="num">{{ g.target_units | num }}</td>
              <td class="num">{{ g.realized_units | num }} <div style="font-size:11px;color:#647687">{{ g.realized_revenue | brl }}</div></td>
              <td><div style="height:6px;background:#F0F4F8;border-radius:3px"><div [style.width.%]="progress(g)" [style.background]="progress(g) >= 100 ? '#18864B' : '#0875D1'" style="height:100%;border-radius:3px"></div></div><div style="font-size:10px;color:#647687;margin-top:2px">{{ progress(g) | num:0 }}%</div></td>
              <td><span class="badge" [class.badge-success]="g.status === 'ativa'" [class.badge-muted]="g.status !== 'ativa'">{{ g.status }}</span></td>
              <td>@if (g.status === 'ativa' && canEdit) { <button class="btn-ghost" style="font-size:12px" (click)="closeGoal(g)">Encerrar</button> }</td></tr>
          }</tbody></table></div>
      }
    </div>
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid #EEF2F6">
        <input class="input-field" style="max-width:260px" placeholder="Buscar produto…" [(ngModel)]="q" (keyup.enter)="search()" />
        <select class="input-field" style="max-width:200px" [(ngModel)]="kind" (ngModelChange)="search()"><option value="">Simulações e aplicações</option><option value="simulacao">Somente simulações</option><option value="aplicacao">Somente preços aplicados</option></select>
        <button class="btn-secondary" (click)="search()"><ax-icon name="search" [size]="13" /> Buscar</button>
      </div>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum registro de precificação." (retry)="list.reload()" />
      @if (list.items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Data</th><th>Tipo</th><th>Produto / cenário</th><th class="num">Custo un.</th><th class="num">Preço anterior</th><th class="num">Sugerido</th><th class="num">Aplicado</th><th class="num">MC %</th><th class="num">Margem líq.</th><th>Usuário</th><th></th></tr></thead>
          <tbody>@for (h of list.items(); track h.id) {
            <tr><td style="font-size:12px;white-space:nowrap">{{ h.created_at | dtt }}</td><td><span class="badge" [class.badge-info]="h.kind === 'simulacao'" [class.badge-success]="h.kind === 'aplicacao'">{{ h.kind === 'simulacao' ? 'Simulação' : 'Preço aplicado' }}</span></td>
              <td><div style="font-weight:500">{{ h.product || 'Simulação livre' }}@if (h.sku) { <span class="mono" style="font-size:11px"> · {{ h.sku }}</span> }</div>@if (h.scenario_name) { <div style="font-size:11px;color:#647687">{{ h.scenario_name }}</div> }</td>
              <td class="num">{{ h.unit_cost | brl }}</td><td class="num">{{ h.previous_price | brl }}</td><td class="num">{{ h.suggested_price | brl }}</td><td class="num" style="font-weight:600">{{ h.applied_price | brl }}</td>
              <td class="num">{{ h.contribution_pct | pct }}</td><td class="num">{{ h.net_margin_pct | pct }}</td><td style="font-size:12px">{{ h.user_name }}</td>
              <td><button class="btn-ghost" title="Detalhes" (click)="open(h)"><ax-icon name="eye" [size]="14" /></button></td></tr>
          }</tbody></table></div>
        <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
      }
    </div>
  </div>
  <ax-modal [open]="!!detail()" (closed)="detail.set(null)" title="Detalhes da precificação" icon="file-text" [width]="620">
    @if (detail(); as d) {
      <div style="font-size:12px;color:#647687;margin-bottom:8px">{{ d.created_at | dtt }} · {{ d.product || 'Simulação livre' }}</div>
      <div class="form-grid-2" style="font-size:12px">
        @for (row of detailRows(d); track row[0]) { <div style="display:flex;justify-content:space-between;border-bottom:1px solid #F0F4F8;padding:4px 0"><span style="color:#647687">{{ row[0] }}</span><span class="mono">{{ row[1] }}</span></div> }
      </div>
      @if (d.result?.warnings?.length) { @for (w of d.result.warnings; track $index) { <div class="state-warning" style="margin:8px 0 0;font-size:12px"><span>{{ w }}</span></div> } }
    }
    <div footer><button class="btn-secondary" (click)="detail.set(null)">Fechar</button></div>
  </ax-modal>`,
})
export class HistoricoPrecosPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); private auth = inject(AuthService);
  readonly tabs = PRICING_TABS; readonly canEdit = this.auth.can('precificacao.editar');
  readonly list = new ListState((q) => this.api.get('/pricing/history', { ...q, size: 30 }));
  readonly goals = signal<any[]>([]); readonly goalsLoading = signal(true); readonly detail = signal<any>(null);
  q = ''; kind = ''; goalStatus = 'ativa';
  ngOnInit() { this.list.load(1); this.loadGoals(); }
  search() { this.list.query = { q: this.q, kind: this.kind }; this.list.load(1); }
  async loadGoals() { this.goalsLoading.set(true); try { this.goals.set(await this.api.get<any[]>('/pricing/goals', { status: this.goalStatus })); } catch (e) { this.toast.error(e); } finally { this.goalsLoading.set(false); } }
  progress(g: any) { return Number(g.target_units) > 0 ? Math.min(100, (Number(g.realized_units) / Number(g.target_units)) * 100) : 0; }
  async closeGoal(g: any) {
    if (!confirm(`Encerrar a meta "${g.name}"?`)) return;
    try { await this.api.post(`/pricing/goals/${g.id}/close`); this.toast.success('Meta encerrada.'); this.loadGoals(); } catch (e) { this.toast.error(e); }
  }
  async open(h: any) { try { this.detail.set(await this.api.get(`/pricing/history/${h.id}`)); } catch (e) { this.toast.error(e); } }
  detailRows(d: any): [string, string][] {
    const i = d.input ?? {}, r = d.result ?? {};
    return [
      ['Custo de aquisição', brl(i.acquisitionCost)], ['Custo unitário total', brl(r.unitCost)], ['Despesas variáveis', pct(i.variablePct, 2)], ['Custo variável/un.', brl(i.unitVariableCosts)],
      ['Custos fixos rateados', pct(i.fixedPct, 2)], ['Canal', CHANNEL_LABEL[i.channel] ?? '—'], ['Modo', i.mode === 'markup' ? `Markup ${num(i.markup, 2)}` : i.mode === 'preco' ? 'Preço informado' : `Margem ${pct(i.desiredMarginPct)}`],
      ['Preço calculado', brl(r.suggestedPrice)], ['Margem de contribuição', `${brl(r.contributionUnit)} (${pct(r.contributionPct)})`], ['Lucro líquido/un.', `${brl(r.netProfitUnit)} (${pct(r.netMarginPct)})`],
      ['Markup', num(r.markupMultiplier, 4) + 'x'], ['Preço mínimo', brl(r.minimumPrice)], ['Equilíbrio (un./mês)', r.breakevenUnits != null ? num(r.breakevenUnits) : '—'], ['Custos fixos/mês', brl(i.monthlyFixedCosts)],
    ];
  }
}
