import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, PagerComponent, StateComponent, VariantPickerComponent } from '../../shared/ui';
import { Api, newIdempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, todayIso } from '../../core/format';

const REASONS: [string, string][] = [['vencido', 'Vencido'], ['avariado', 'Avariado / estragado'], ['quebra', 'Quebra'], ['furto', 'Furto / extravio'], ['consumo_interno', 'Consumo interno'], ['degustacao', 'Degustação'], ['amostra', 'Amostra / tester'], ['outros', 'Outros']];
const REASON_LABEL = Object.fromEntries(REASONS);

/** Lotes e validade (FEFO) + registro e relatório de perdas. */
@Component({
  selector: 'ax-validade',
  imports: [FormsModule, IconComponent, ModalComponent, PagerComponent, StateComponent, VariantPickerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Validade e Perdas</h1>
        <p style="font-size:13px;color:#647687">Lotes com validade{{ isAdega() ? ' e safra' : '' }}, consumo pelo vencimento mais próximo (FEFO) nas vendas e controle das perdas da loja</p></div>
      <div style="display:flex;gap:8px">
        @if (auth.can('estoque.perdas')) { <button class="btn-secondary" style="font-size:12px" (click)="openLoss(null)"><ax-icon name="trash-2" [size]="13" /> Registrar perda</button> }
        @if (auth.can(['estoque.lotes', 'estoque.movimentar'])) { <button class="btn-primary" style="font-size:12px" (click)="openLot()"><ax-icon name="plus" [size]="13" /> Entrada com lote</button> }
      </div>
    </div>
    <div class="tabs-bar" style="margin:0 0 16px">@for (t of ['Lotes e validade', 'Perdas']; track t; let i = $index) { <div class="tab-item" [class.active]="tab() === i" (click)="tab.set(i); i === 1 ? loadLosses() : lots.load(1)">{{ t }}</div> }</div>

    @if (tab() === 0) {
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;margin-bottom:14px">
        <div class="kpi-card" style="cursor:pointer" (click)="setStatus('vencido')"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">Lotes vencidos</div><div style="font-size:22px;font-weight:700" [style.color]="(lots.extra()?.summary?.vencidos ?? 0) > 0 ? '#C93636' : null">{{ lots.extra()?.summary?.vencidos ?? 0 }}</div><div style="font-size:11px;color:#647687">retire da venda e registre a perda</div></div>
        <div class="kpi-card" style="cursor:pointer" (click)="setStatus('vencendo')"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">Vencendo em {{ lots.extra()?.summary?.alertDays ?? 3 }} dias</div><div style="font-size:22px;font-weight:700" [style.color]="(lots.extra()?.summary?.vencendo ?? 0) > 0 ? '#D99000' : null">{{ lots.extra()?.summary?.vencendo ?? 0 }}</div><div style="font-size:11px;color:#647687">ótimo momento para promoção ou combo</div></div>
        <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">Valor em risco (custo)</div><div style="font-size:22px;font-weight:700">{{ lots.extra()?.summary?.valor_em_risco ?? 0 | brl }}</div><div style="font-size:11px;color:#647687">vencidos + vencendo no período de alerta</div></div>
      </div>
      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #EEF2F6">
          @for (s of statuses; track s[0]) { <span class="chip" [class.active]="status() === s[0]" (click)="setStatus(s[0])">{{ s[1] }}</span> }
          <span style="flex:1"></span>
          <input class="input-field" style="max-width:240px" placeholder="Produto, SKU ou lote…" [(ngModel)]="q" (keyup.enter)="setStatus(status())" />
        </div>
        <ax-state [loading]="lots.loading()" [error]="lots.error()" [empty]="!lots.loading() && !lots.items().length" emptyText="Nenhum lote nesta situação. Use “Entrada com lote” para registrar mercadorias com validade." (retry)="lots.reload()" />
        @if (lots.items().length) {
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>Produto</th><th>Lote</th>@if (isAdega()) { <th>Safra</th> }<th>Validade</th><th class="num">Saldo do lote</th><th class="num">Valor (custo)</th><th>Situação</th><th></th></tr></thead>
            <tbody>@for (l of lots.items(); track l.id) {
              <tr><td><div style="font-weight:500">{{ l.name }}</div><div class="mono" style="font-size:11px;color:#647687">{{ l.sku }} · {{ l.branch }}</div></td>
                <td class="mono" style="font-size:12px">{{ l.lot_code || '—' }}</td>@if (isAdega()) { <td class="mono">{{ l.vintage || '—' }}</td> }
                <td>{{ l.expiry_date ? (l.expiry_date | dt) : 'sem validade' }}</td>
                <td class="num">{{ l.qty_remaining | num:(l.sale_by_weight ? 3 : 0) }} {{ (l.unit || 'un').toLowerCase() }}</td><td class="num">{{ l.value_at_cost | brl }}</td>
                <td>@if (l.days_left === null) { <span class="badge badge-muted">Sem validade</span> } @else if (l.days_left < 0) { <span class="badge badge-danger">Vencido há {{ -l.days_left }} d</span> }
                    @else if (l.days_left <= (lots.extra()?.summary?.alertDays ?? 3)) { <span class="badge badge-warning">{{ l.days_left === 0 ? 'Vence hoje' : 'Vence em ' + l.days_left + ' d' }}</span> } @else { <span class="badge badge-success">{{ l.days_left }} dias</span> }</td>
                <td>@if (auth.can('estoque.perdas')) { <button class="btn-ghost" style="font-size:11px" (click)="openLoss(l)">Baixar perda</button> }</td></tr>
            }</tbody></table></div>
          <ax-pager [page]="lots.page()" [pages]="lots.pages()" [total]="lots.total()" (go)="lots.load($event)" />
        }
      </div>
      <p style="font-size:11px;color:#647687;margin-top:8px">As vendas baixam primeiro os lotes com vencimento mais próximo. Cancelamentos e devoluções voltam ao estoque sem recompor o lote (o saldo do lote é informativo para o controle de validade).</p>
    }

    @if (tab() === 1) {
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px">
        <div><label class="field-label">De</label><input type="date" class="input-field" [(ngModel)]="from" (change)="loadLosses()" /></div>
        <div><label class="field-label">Até</label><input type="date" class="input-field" [(ngModel)]="to" (change)="loadLosses()" /></div>
        <div><label class="field-label">Motivo</label><select class="input-field" [(ngModel)]="reason" (ngModelChange)="loadLosses()"><option value="">Todos</option>@for (r of reasons; track r[0]) { <option [value]="r[0]">{{ r[1] }}</option> }</select></div>
      </div>
      @if (losses(); as L) {
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;margin-bottom:14px">
          <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">Perdas no período (custo)</div><div style="font-size:22px;font-weight:700;color:#C93636">{{ L.totals.cost | brl }}</div><div style="font-size:11px;color:#647687">{{ L.total }} registro(s)</div></div>
          <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">% do faturamento</div><div style="font-size:22px;font-weight:700">{{ L.totals.pctOfRevenue !== null ? (L.totals.pctOfRevenue | pct:2) : '—' }}</div><div style="font-size:11px;color:#647687">faturamento {{ L.totals.revenue | brl }}</div></div>
          <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">% do CMV</div><div style="font-size:22px;font-weight:700">{{ L.totals.pctOfCmv !== null ? (L.totals.pctOfCmv | pct:2) : '—' }}</div><div style="font-size:11px;color:#647687">use em Precificação › custos variáveis (perdas)</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:8px">Por motivo</div>
            @for (r of L.byReason; track r.reason) { <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:4px 0;border-bottom:1px solid #F0F4F8"><span>{{ rl(r.reason) }} <span class="muted">({{ r.n }})</span></span><span class="mono">{{ r.cost | brl }}</span></div> }
            @empty { <div class="muted" style="font-size:12px">Sem perdas no período.</div> }</div>
          <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:8px">Produtos com mais perdas</div>
            @for (r of L.topProducts; track r.name) { <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:4px 0;border-bottom:1px solid #F0F4F8"><span>{{ r.name }} <span class="muted">{{ r.qty | num:3 }} {{ (r.unit || 'un').toLowerCase() }}</span></span><span class="mono">{{ r.cost | brl }}</span></div> }
            @empty { <div class="muted" style="font-size:12px">—</div> }</div>
        </div>
        <div class="card" style="overflow:hidden">
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>Data</th><th>Produto</th><th>Motivo</th><th class="num">Quantidade</th><th class="num">Custo</th><th>Lote</th><th>Usuário</th><th>Observação</th></tr></thead>
            <tbody>@for (l of L.items; track l.id) {
              <tr><td class="mono" style="font-size:11px">{{ l.created_at | dtt }}</td><td><div style="font-weight:500">{{ l.name }}</div><div class="mono" style="font-size:11px;color:#647687">{{ l.sku }}</div></td>
                <td><span class="badge badge-muted">{{ rl(l.reason) }}</span></td><td class="num">{{ l.qty | num:3 }} {{ (l.unit || 'un').toLowerCase() }}</td><td class="num" style="font-weight:600">{{ l.total_cost | brl }}</td>
                <td class="mono" style="font-size:11px">{{ l.lot_code || '—' }}</td><td style="font-size:12px">{{ l.user_name }}</td><td style="font-size:12px;color:#647687">{{ l.notes || '' }}</td></tr>
            } @empty { <tr><td colspan="8" class="empty-state">Nenhuma perda registrada no período.</td></tr> }</tbody></table></div>
        </div>
      } @else { <ax-state [loading]="true" /> }
    }
  </div>

  <ax-modal [open]="lotOpen()" (closed)="lotOpen.set(false)" title="Entrada com lote e validade" icon="calendar-clock" [width]="560">
    <label class="field-label">Produto *</label>
    @if (lf.item) { <div style="display:flex;justify-content:space-between;align-items:center;background:#F6F9FC;border-radius:8px;padding:8px 10px;margin-bottom:8px"><div><b>{{ lf.item.name }}</b> <span class="mono" style="font-size:11px">{{ lf.item.sku }}</span></div><button class="btn-ghost" (click)="lf.item = null"><ax-icon name="x" [size]="13" /></button></div> }
    @else { <ax-variant-picker placeholder="Busque o produto pelo nome, SKU ou código" (selected)="lf.item = $event" /> }
    <div class="form-grid-2" style="margin-top:8px">
      <div><label class="field-label">Quantidade * {{ lf.item?.sale_by_weight ? '(kg)' : '' }}</label><input type="number" min="0.001" [step]="lf.item?.sale_by_weight ? 0.001 : 1" class="input-field mono" [(ngModel)]="lf.qty" /></div>
      <div><label class="field-label">Código do lote</label><input class="input-field mono" maxlength="40" [(ngModel)]="lf.lotCode" /></div>
      <div><label class="field-label">Validade</label><input type="date" class="input-field" [min]="today" [(ngModel)]="lf.expiryDate" /></div>
      @if (isAdega()) { <div><label class="field-label">Safra</label><input type="number" min="1900" max="2100" class="input-field mono" [(ngModel)]="lf.vintage" /></div> }
      @if (auth.can('produtos.custo')) { <div><label class="field-label">Custo unitário</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="lf.unitCost" /></div> }
      <div class="span-all"><label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="lf.addToStock" /> Lançar a quantidade como entrada no estoque (desmarque se a mercadoria já entrou por nota e você só quer registrar o lote)</label></div>
    </div>
    <p style="font-size:11px;color:#647687;margin-top:8px">Sem validade informada, o sistema usa a validade padrão (em dias) cadastrada no produto.</p>
    <div footer><button class="btn-secondary" (click)="lotOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy() || !lf.item || !(lf.qty > 0)" (click)="saveLot()">Registrar lote</button></div>
  </ax-modal>

  <ax-modal [open]="lossOpen()" (closed)="lossOpen.set(false)" title="Registrar perda" icon="trash-2" [width]="520">
    @if (lsf.lot) { <div style="background:#F6F9FC;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:13px"><b>{{ lsf.lot.name }}</b> · lote {{ lsf.lot.lot_code || 's/ código' }} · saldo {{ lsf.lot.qty_remaining | num:3 }}</div> }
    @else {
      <label class="field-label">Produto *</label>
      @if (lsf.item) { <div style="display:flex;justify-content:space-between;align-items:center;background:#F6F9FC;border-radius:8px;padding:8px 10px;margin-bottom:8px"><div><b>{{ lsf.item.name }}</b> <span class="mono" style="font-size:11px">{{ lsf.item.sku }}</span></div><button class="btn-ghost" (click)="lsf.item = null"><ax-icon name="x" [size]="13" /></button></div> }
      @else { <ax-variant-picker placeholder="Busque o produto" (selected)="lsf.item = $event" /> }
    }
    <div class="form-grid-2" style="margin-top:8px">
      <div><label class="field-label">Quantidade *</label><input type="number" min="0.001" step="0.001" class="input-field mono" [(ngModel)]="lsf.qty" /></div>
      <div><label class="field-label">Motivo *</label><select class="input-field" [(ngModel)]="lsf.reason">@for (r of reasons; track r[0]) { <option [value]="r[0]">{{ r[1] }}</option> }</select></div>
      <div class="span-all"><label class="field-label">Observação</label><input class="input-field" maxlength="300" [(ngModel)]="lsf.notes" /></div>
    </div>
    <p style="font-size:11px;color:#647687;margin-top:8px">A perda baixa o estoque, entra no relatório com o custo do produto e fica registrada na auditoria.</p>
    <div footer><button class="btn-secondary" (click)="lossOpen.set(false)">Cancelar</button><button class="btn-danger" [disabled]="busy() || !(lsf.lot || lsf.item) || !(lsf.qty > 0)" (click)="saveLoss()">Registrar perda</button></div>
  </ax-modal>`,
})
export class ValidadePage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly reasons = REASONS; readonly today = todayIso();
  readonly statuses: [string, string][] = [['', 'Todos com saldo'], ['vencido', 'Vencidos'], ['vencendo', 'Vencendo'], ['ok', 'Dentro da validade']];
  readonly tab = signal(0); readonly status = signal(''); readonly busy = signal(false);
  readonly lotOpen = signal(false); readonly lossOpen = signal(false); readonly losses = signal<any>(null);
  readonly lots = new ListState((q) => this.api.get('/stock/lots', { ...q, size: 50 }));
  q = ''; reason = ''; from = this.today.slice(0, 8) + '01'; to = this.today;
  lf: any = {}; lsf: any = {};
  ngOnInit() { this.lots.load(1); }
  isAdega() { return this.auth.me()?.segment?.id === 'adega'; }
  rl(r: string) { return REASON_LABEL[r] || r; }
  setStatus(s: string) { this.status.set(s); this.tab.set(0); this.lots.query = { status: s || undefined, q: this.q || undefined }; this.lots.load(1); }
  async loadLosses() { this.losses.set(null); try { this.losses.set(await this.api.get('/stock/losses', { from: this.from, to: this.to, reason: this.reason || undefined, size: 100 })); } catch (e) { this.toast.error(e); } }
  openLot() { this.lf = { item: null, qty: null, lotCode: '', expiryDate: '', vintage: null, unitCost: null, addToStock: true }; this.lotOpen.set(true); }
  openLoss(lot: any) { this.lsf = { lot, item: null, qty: lot ? Number(lot.qty_remaining) : null, reason: lot && lot.days_left !== null && lot.days_left < 0 ? 'vencido' : 'avariado', notes: '' }; this.lossOpen.set(true); }
  async saveLot() {
    this.busy.set(true);
    try {
      await this.api.post('/stock/lots', { variantId: this.lf.item.id, qty: +this.lf.qty, lotCode: this.lf.lotCode || undefined, expiryDate: this.lf.expiryDate || undefined, vintage: this.lf.vintage ? +this.lf.vintage : undefined,
        unitCost: this.lf.unitCost !== null && this.lf.unitCost !== '' ? +this.lf.unitCost : undefined, addToStock: !!this.lf.addToStock }, { idempotent: newIdempotencyKey() });
      this.toast.success('Lote registrado.'); this.lotOpen.set(false); this.lots.reload();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async saveLoss() {
    this.busy.set(true);
    try {
      const r: any = await this.api.post('/stock/losses', { lotId: this.lsf.lot?.id, variantId: this.lsf.lot ? undefined : this.lsf.item.id, qty: +this.lsf.qty, reason: this.lsf.reason, notes: this.lsf.notes || undefined }, { idempotent: newIdempotencyKey() });
      this.toast.success(`Perda registrada (custo ${Number(r.total_cost).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}).`); this.lossOpen.set(false); this.lots.reload(); if (this.tab() === 1) this.loadLosses();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}
