import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, ModuleTabsComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, brl, todayIso } from '../../core/format';

export const CONT_TABS = [{ path: '/contabilidade', label: 'Visão geral' }, { path: '/lancamentos', label: 'Lançamentos' }, { path: '/dre', label: 'DRE' }, { path: '/plano-contas', label: 'Plano de Contas' }];
const monthRange = (offset: number) => { const d = new Date(); const s = new Date(d.getFullYear(), d.getMonth() + offset, 1); const e = offset === 0 ? new Date() : new Date(d.getFullYear(), d.getMonth() + offset + 1, 0);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; return { from: iso(s), to: iso(e), label: s.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', '') }; };
const paren = (v: number) => (v < 0 ? `(${brl(Math.abs(v))})` : brl(v));

@Component({
  selector: 'ax-contabilidade',
  imports: [IconComponent, ModuleTabsComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:24px"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Contabilidade</h1>
      <p style="font-size:13px;color:#647687">Competência {{ cur.label }} · visão gerencial derivada das operações (a escrituração oficial é feita pelo contador a partir das exportações)</p></div>
    <ax-state [loading]="!s()" />
    @if (s(); as s) {
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:20px">
        @for (k of kpis(); track k.label) {
          <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl(k.screen)"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">{{ k.label }}</div>
            <div style="font-size:20px;font-weight:700" [style.color]="k.color || '#172B3A'">{{ k.value }}</div><div style="font-size:11px;color:#647687">{{ k.sub }}</div></div>
        }
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:10px">
        @for (b of quick; track b.label) { <button class="btn-secondary" style="justify-content:center;padding:10px;font-size:13px" (click)="router.navigateByUrl(b.screen)">{{ b.label }}</button> }
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px">
        <div class="card" style="padding:20px">
          <div style="font-size:13px;font-weight:700;color:#172B3A;margin-bottom:12px">Posição patrimonial gerencial</div>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            @for (r of position(); track r[0]) { <tr [style.font-weight]="r[2] ? 700 : 400" [style.border-top]="r[2] ? '1px solid #DCE4EC' : 'none'"><td style="padding:6px 0">{{ r[0] }}</td><td class="mono" style="text-align:right" [style.color]="+r[1] < 0 ? '#C93636' : null">{{ r[1] | brl }}</td></tr> }
          </table>
          <p style="font-size:11px;color:#647687;margin-top:8px">Estoque avaliado ao custo cadastrado. Não inclui imobilizado, tributos a recolher e obrigações trabalhistas não lançadas no sistema.</p>
        </div>
        <div class="card" style="padding:20px">
          <div style="font-size:13px;font-weight:700;color:#172B3A;margin-bottom:12px">Integração Automática de Lançamentos</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            @for (ev of rules; track ev.title) {
              <div style="border:1px solid #DCE4EC;border-radius:8px;overflow:hidden">
                <div style="background:#F4F7FA;padding:8px 12px;font-size:12px;font-weight:600;color:#172B3A">{{ ev.title }}</div>
                <table style="width:100%;border-collapse:collapse"><tbody>@for (r of ev.rows; track r[1]) { <tr><td class="mono" [style.color]="r[0] === 'D' ? '#C93636' : '#18864B'" style="padding:6px 10px;width:24px;font-weight:700;font-size:12px">{{ r[0] }}</td><td style="padding:6px 4px;font-size:11px;color:#172B3A">{{ r[1] }}</td></tr> }</tbody></table>
              </div>
            }
          </div>
        </div>
      </div>
    }
  </div>`,
})
export class ContabilidadePage implements OnInit {
  private api = inject(Api); readonly router = inject(Router);
  readonly tabs = CONT_TABS; readonly cur = monthRange(0);
  readonly s = signal<any>(null); readonly dre = signal<any>(null);
  readonly quick = [{ label: 'Lançamentos', screen: '/lancamentos' }, { label: 'Plano de Contas', screen: '/plano-contas' }, { label: 'DRE', screen: '/dre' }, { label: 'Relatórios', screen: '/relatorios' }];
  readonly rules = [
    { title: 'Recebimento de venda / título', rows: [['D', '1.1.01 Caixa ou 1.1.02 Bancos (conta financeira da baixa)'], ['C', 'Categoria de receita do título (ex.: Vendas de mercadorias)']] },
    { title: 'Pagamento de conta', rows: [['D', 'Categoria de despesa (ex.: Aluguel, Folha, Compra de mercadorias)'], ['C', '1.1.01 Caixa ou 1.1.02 Bancos']] },
    { title: 'Estoque e CMV (DRE)', rows: [['D', 'CMV — custo das peças vendidas no período'], ['C', 'Estoques — baixa ao custo cadastrado']] },
  ];
  async ngOnInit() { const [s, d] = await Promise.all([this.api.get('/accounting/summary'), this.api.get('/reports/dre', { from: this.cur.from, to: this.cur.to }).catch(() => null)]); this.dre.set(d); this.s.set(s); }
  readonly net = computed(() => { const l = this.dre()?.lines ?? []; return l.length ? Number(l[l.length - 1].value) : null; });
  readonly kpis = computed(() => { const s = this.s(); if (!s) return []; const n = this.net(); return [
    { label: 'Lançamentos no mês', value: String(s.entries_month), sub: 'movimentos financeiros com partida dobrada', screen: '/lancamentos' },
    { label: 'Saldo D vs C', value: brl(0), sub: 'Gerado em partidas dobradas — sempre equilibrado', screen: '/lancamentos', color: '#18864B' },
    { label: 'Resultado do mês', value: n === null ? '—' : brl(n), sub: n === null ? '' : n >= 0 ? 'Lucro (gerencial)' : 'Prejuízo (gerencial)', screen: '/dre', color: n !== null && n < 0 ? '#C93636' : undefined },
    { label: 'Fechamento', value: 'Aberto', sub: 'Competência ' + this.cur.label, screen: '/lancamentos' }]; });
  readonly position = computed(() => { const s = this.s(); if (!s) return []; const a = +s.cash_and_banks + +s.receivables + +s.inventory; const p = +s.payables + +s.customer_credits;
    return [['Caixa e bancos', s.cash_and_banks, false], ['Contas a receber', s.receivables, false], ['Estoques (custo)', s.inventory, false], ['Total do ativo circulante', a, true],
      ['Fornecedores e contas a pagar', s.payables, false], ['Créditos de clientes (vales e cashback)', s.customer_credits, false], ['Total do passivo circulante', p, true], ['Capital circulante líquido', a - p, true]] as [string, number, boolean][]; });
}

@Component({
  selector: 'ax-lancamentos',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, PagerComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Lançamentos Contábeis</h1><p style="font-size:12px;color:#647687">{{ list.total() }} lançamentos no período · gerados automaticamente a partir dos movimentos financeiros</p></div>
      <div style="display:flex;align-items:center;gap:8px;padding:6px 12px;background:#E8F5EE;border-radius:8px;border:1px solid #18864B"><ax-icon name="check-circle-2" [size]="14" color="#18864B" /><span style="font-size:12px;font-weight:600;color:#18864B">D = C — Balancete equilibrado</span></div>
      <input type="date" class="input-field" style="width:140px" [(ngModel)]="from" (change)="load()" /><input type="date" class="input-field" style="width:140px" [(ngModel)]="to" (change)="load()" />
      <button class="btn-secondary" style="font-size:12px" (click)="exportCsv()"><ax-icon name="download" [size]="13" /> Exportar CSV</button>
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Data</th><th>Lançamento</th><th>Histórico</th><th>Conta financeira</th><th>Conta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead>
        <tbody>@for (l of list.items(); track l.id) {
          <tr><td class="mono" style="font-size:11px" rowspan="1">{{ l.date | dt }}</td><td class="mono" style="font-size:11px;color:#0875D1">LC-{{ l.id.slice(0, 8).toUpperCase() }}</td><td style="font-size:12px">{{ l.description }}</td><td style="font-size:12px;color:#647687">{{ l.account }}</td>
            <td style="font-size:12px"><div>D {{ l.debit }}</div><div style="color:#647687">C {{ l.credit }}</div></td>
            <td class="num" style="font-size:12px;color:#C93636;font-weight:600">{{ l.amount | brl }}</td><td class="num" style="font-size:12px;color:#18864B;font-weight:600">{{ l.amount | brl }}</td></tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum lançamento no período." />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>`,
})
export class LancamentosPage implements OnInit {
  private api = inject(Api);
  readonly tabs = CONT_TABS; from = monthRange(0).from; to = todayIso();
  readonly list = new ListState<any>((q) => this.api.get('/accounting/entries', q));
  ngOnInit() { this.load(); }
  load() { this.list.query = { from: this.from, to: this.to }; this.list.load(1); }
  async exportCsv() {
    const rows: any[] = []; let page = 1, pages = 1;
    do { const r: any = await this.api.get('/accounting/entries', { from: this.from, to: this.to, page, size: 200 }); rows.push(...r.items); pages = r.pages; page++; } while (page <= pages && page <= 50);
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['data;historico;conta_debito;conta_credito;valor', ...rows.map((r) => [r.date, esc(r.description), esc(r.debit), esc(r.credit), String(r.amount).replace('.', ',')].join(';'))].join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })); a.download = `lancamentos-${this.from}-${this.to}.csv`; a.click();
  }
}

@Component({
  selector: 'ax-dre',
  imports: [FormsModule, ModuleTabsComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:20px;display:flex;align-items:flex-end;gap:12px">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">DRE — Demonstração do Resultado</h1><p style="font-size:12px;color:#647687">Gerencial · regime de competência das vendas · impostos sobre vendas estimados em {{ a()?.estimatedTaxPct ?? '—' }}% (ajuste em Configurações → Fiscal)</p></div>
      <div><label class="field-label">Mês</label><select class="input-field" style="width:160px" [(ngModel)]="offset" (ngModelChange)="load()">@for (m of months; track m.v) { <option [ngValue]="m.v">{{ m.l }}</option> }</select></div>
    </div>
    <ax-state [loading]="!a()" />
    @if (a()) {
      <div class="card" style="overflow:hidden;max-width:760px">
        <div style="padding:12px 16px;background:#0B1F33;display:flex;justify-content:space-between"><span style="font-size:12px;font-weight:700;color:#A8BCCF">CONTA</span>
          <div style="display:flex;gap:40px"><span style="font-size:12px;font-weight:700;color:#A8BCCF;min-width:120px;text-align:right">{{ curLabel() }}</span><span style="font-size:12px;font-weight:700;color:#A8BCCF;min-width:100px;text-align:right">{{ prevLabel() }}</span><span style="font-size:12px;font-weight:700;color:#A8BCCF;min-width:50px;text-align:right">AH%</span></div></div>
        @for (row of rows(); track row.code; let i = $index) {
          <div [style.padding]="row.total ? '10px 16px' : '7px 16px'" [style.background]="row.total ? (row.value >= 0 ? '#F0FBF4' : '#FEF8F8') : i % 2 === 0 ? '#FAFBFD' : 'white'" style="display:flex;justify-content:space-between;border-bottom:1px solid #F0F4F8">
            <span [style.font-weight]="row.total ? 700 : 400" [style.padding-left.px]="row.level === 2 ? 24 : row.level === 1 ? 8 : 0" style="font-size:13px;color:#172B3A">{{ row.label }}</span>
            <div style="display:flex;gap:40px;flex-shrink:0">
              <span class="mono" [style.font-weight]="row.total ? 700 : 400" [style.color]="row.value < 0 ? '#C93636' : '#172B3A'" style="font-size:13px;min-width:120px;text-align:right">{{ fmt(row.value) }}</span>
              <span class="mono" style="font-size:12px;color:#647687;min-width:100px;text-align:right">{{ row.prev === null ? '—' : fmt(row.prev) }}</span>
              <span class="mono" [style.color]="row.ah === null ? '#647687' : (row.ah >= 0) === (row.value >= 0) ? '#18864B' : '#C93636'" style="font-size:12px;min-width:50px;text-align:right">{{ row.ah === null ? '—' : (row.ah > 0 ? '+' : '') + row.ah.toFixed(1).replace('.', ',') + '%' }}</span>
            </div>
          </div>
        }
      </div>
      <p style="font-size:11px;color:#647687;margin-top:8px;max-width:760px">Receita e CMV pelas vendas do período (descontadas devoluções); despesas pelos títulos a pagar com vencimento no período, conforme o grupo DRE da categoria financeira. Valores gerenciais — não substituem as demonstrações contábeis oficiais.</p>
    }
  </div>`,
})
export class DrePage implements OnInit {
  private api = inject(Api);
  readonly tabs = CONT_TABS; offset = 0;
  readonly months = Array.from({ length: 12 }, (_, i) => ({ v: i === 0 ? 0 : -i, l: monthRange(-i).label + (i === 0 ? ' (até hoje)' : '') }));
  readonly a = signal<any>(null); readonly b = signal<any>(null);
  readonly curLabel = signal(''); readonly prevLabel = signal('');
  readonly fmt = paren;
  ngOnInit() { this.load(); }
  async load() {
    this.a.set(null); const c = monthRange(this.offset), p = monthRange(this.offset - 1);
    this.curLabel.set(c.label); this.prevLabel.set(p.label);
    const [a, b] = await Promise.all([this.api.get('/reports/dre', { from: c.from, to: c.to }), this.api.get('/reports/dre', { from: p.from, to: p.to }).catch(() => null)]);
    this.b.set(b); this.a.set(a);
  }
  readonly rows = computed(() => (this.a()?.lines ?? []).map((l: any) => { const pv = this.b()?.lines?.find((x: any) => x.code === l.code); const prev = pv ? Number(pv.value) : null; const value = Number(l.value);
    return { ...l, value, prev, ah: prev ? ((value - prev) / Math.abs(prev)) * 100 : null }; }));
}

@Component({
  selector: 'ax-plano-contas',
  imports: [FormsModule, IconComponent, ModalComponent, ModuleTabsComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:20px;display:flex;align-items:center"><div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Plano de Contas</h1><p style="font-size:12px;color:#647687">{{ items().length }} contas · referência para exportação ao escritório contábil</p></div>
      @if (auth.can('contabilidade.editar')) { <button class="btn-primary" style="font-size:12px" (click)="edit(null)"><ax-icon name="plus" [size]="13" /> Nova conta</button> }</div>
    <div class="card" style="overflow:hidden">
      <table class="data-table" style="width:100%;border-collapse:collapse">
        <thead><tr><th>Código</th><th>Descrição</th><th>Nat.</th><th>Grupo</th><th>Tipo</th><th></th></tr></thead>
        <tbody>@for (c of items(); track c.id) {
          <tr><td class="mono" [style.font-weight]="level(c) <= 1 ? 700 : 400" style="font-size:12px">{{ c.code }}</td><td [style.padding-left.px]="8 + level(c) * 16" [style.font-weight]="level(c) <= 1 ? 700 : 400" style="font-size:13px">{{ c.name }}</td>
            <td [style.color]="c.nature === 'Devedora' ? '#C93636' : '#18864B'" style="font-size:12px;font-weight:700">{{ c.nature === 'Devedora' ? 'D' : 'C' }}</td><td style="font-size:12px">{{ c.type }}</td>
            <td><span class="badge badge-muted">{{ c.analytic ? 'Analítica' : 'Sintética' }}</span></td>
            <td>@if (auth.can('contabilidade.editar')) { <button class="btn-ghost" style="font-size:11px;padding:3px 6px" (click)="edit(c)">Editar</button> }</td></tr>
        }</tbody>
      </table>
      <ax-state [loading]="loading()" [empty]="!loading() && !items().length" />
    </div>
  </div>
  <ax-modal [(open)]="open" [title]="f.id ? 'Editar conta' : 'Nova conta'" icon="book-open" [width]="480">
    <div class="form-grid-2">
      <div><label class="field-label">Código *</label><input class="input-field mono" [(ngModel)]="f.code" placeholder="1.1.03" /></div>
      <div><label class="field-label">Grupo *</label><select class="input-field" [(ngModel)]="f.type">@for (t of types; track t) { <option>{{ t }}</option> }</select></div>
      <div class="span-all"><label class="field-label">Descrição *</label><input class="input-field" [(ngModel)]="f.name" /></div>
      <div><label class="field-label">Natureza</label><select class="input-field" [(ngModel)]="f.nature"><option>Devedora</option><option>Credora</option></select></div>
      <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="f.analytic"><option [ngValue]="true">Analítica (recebe lançamentos)</option><option [ngValue]="false">Sintética (agrupadora)</option></select></div>
    </div>
    <div footer><button class="btn-secondary" (click)="open.set(false)">Cancelar</button><button class="btn-primary" (click)="save()">Salvar</button></div>
  </ax-modal>`,
})
export class PlanoContasPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly tabs = CONT_TABS; readonly items = signal<any[]>([]); readonly loading = signal(true); readonly open = signal(false); f: any = {};
  readonly types = ['Ativo', 'Passivo', 'Patrimônio Líquido', 'Receita', 'Custo', 'Despesa'];
  ngOnInit() { this.load(); }
  level(c: any) { return c.code.split('.').length - 1; }
  async load() { this.loading.set(true); try { const r: any = await this.api.get('/chart-of-accounts', { size: 500 }); this.items.set(r.items); } finally { this.loading.set(false); } }
  edit(c: any) { this.f = c ? { ...c } : { code: '', name: '', type: 'Despesa', nature: 'Devedora', analytic: true }; this.open.set(true); }
  async save() {
    const body = { code: this.f.code, name: this.f.name, type: this.f.type, nature: this.f.nature, analytic: this.f.analytic };
    try { if (this.f.id) await this.api.put('/chart-of-accounts/' + this.f.id, body); else await this.api.post('/chart-of-accounts', body); this.open.set(false); this.toast.success('Conta salva.'); this.load(); } catch (e) { this.toast.error(e); }
  }
}
