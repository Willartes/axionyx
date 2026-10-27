import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { CHARTS, Series } from '../../shared/charts';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AuthService } from '../../core/auth.service';
import { FMT, brl } from '../../core/format';
import { CHARGE_STATUS, CONTRACT_STATUS, METHOD_LABEL, MODE_SHORT, REVIEW_KIND, RISK, SEGMENT_LABEL, SEVERITY, copyText } from './saas-shared';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mLabel = (ym: string) => { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]}/${y.slice(2)}`; };
const PALETTE = ['#0875D1', '#00A6D6', '#18864B', '#D99000', '#7A5AF8', '#C93636', '#647687', '#E07B00'];

// ═══════════════════════════════════════════════════════════════  Painel da carteira
@Component({
  selector: 'ax-saas-carteira',
  imports: [IconComponent, ...CHARTS, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .alert-row { display:flex; gap:10px; align-items:center; padding:10px 14px; border-radius:10px; font-size:13px; cursor:pointer; }
    .alert-row b { font-weight:700; }
    .kv { display:flex; justify-content:space-between; font-size:12.5px; padding:6px 0; border-bottom:1px dashed #EEF2F6; }
    .kv:last-child { border-bottom:0; }
  `],
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="axionyx" [size]="20" color="#0875D1" /> Painel da Carteira</h1>
        <p style="font-size:13px;color:#647687">Clientes, receita recorrente e saúde da carteira do AXIONYX — valores reais das assinaturas e cobranças</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        @if (pc('carteira.financeiro')) { <button class="btn-secondary" (click)="run()" [disabled]="running()"><ax-icon name="refresh-cw" [size]="13" /> Rodar cobrança agora</button> }
        @if (pc('carteira.propostas')) { <button class="btn-primary" (click)="router.navigate(['/saas-clientes'], { queryParams: { novo: 1 } })"><ax-icon name="plus" [size]="13" /> Nova proposta</button> }
      </div>
    </div>
    @if (d(); as d) {
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
        @if (!d.gateway.configured) { <div class="alert-row" style="background:#FFF7E6;color:#8A5B00" (click)="router.navigateByUrl('/saas-gateway')"><ax-icon name="plug" [size]="15" /><span style="flex:1"><b>Mercado Pago não configurado.</b> As cobranças ficam sem link de pagamento até você definir as credenciais.</span><ax-icon name="chevron-right" [size]="14" /></div> }
        @if (d.kpis.in_review) { <div class="alert-row" style="background:#F0F7FD;color:#0B4F8A" (click)="router.navigateByUrl('/saas-auditoria')"><ax-icon name="clipboard-list" [size]="15" /><span style="flex:1"><b>{{ d.kpis.in_review }} proposta(s)</b> aguardando sua auditoria.</span><ax-icon name="chevron-right" [size]="14" /></div> }
        @if (d.reviews.high) { <div class="alert-row" style="background:#FDECEC;color:#A12A2A" (click)="router.navigateByUrl('/saas-auditoria')"><ax-icon name="shield-alert" [size]="15" /><span style="flex:1"><b>{{ d.reviews.high }} exceção(ões) de alta prioridade</b> aguardando decisão na fila.</span><ax-icon name="chevron-right" [size]="14" /></div> }
        @if (d.legacyCompanies) { <div class="alert-row" style="background:#F1F4F7;color:#4A5B6B" (click)="router.navigate(['/saas-clientes'], { queryParams: { vincular: 1 } })"><ax-icon name="building-2" [size]="15" /><span style="flex:1"><b>{{ d.legacyCompanies }} empresa(s)</b> usando o sistema sem contrato na carteira (não entram no MRR nem são cobradas).</span><ax-icon name="chevron-right" [size]="14" /></div> }
      </div>

      <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px">
        <div class="kpi-card"><div class="kpi-l">MRR (receita recorrente)</div><div class="kpi-v">{{ d.kpis.mrr | brl }}</div><div class="muted" style="font-size:11.5px">ARR {{ d.kpis.arr | brl }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Clientes ativos</div><div class="kpi-v">{{ d.kpis.active }}</div><div class="muted" style="font-size:11.5px">ticket médio {{ d.kpis.ticket | brl }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Recebido no mês</div><div class="kpi-v" style="color:#18864B">{{ d.kpis.received | brl }}</div><div class="muted" style="font-size:11.5px">líquido {{ d.kpis.netMonth | brl }} · taxas {{ d.kpis.fees | brl }}</div></div>
        <div class="kpi-card"><div class="kpi-l">A receber no mês</div><div class="kpi-v">{{ d.kpis.to_receive | brl }}</div><div class="muted" style="font-size:11.5px">pipeline {{ d.kpis.mrr_pipeline | brl }}/mês aguardando pagamento</div></div>
      </div>
      <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px">
        <div class="kpi-card"><div class="kpi-l">Em atraso</div><div class="kpi-v" [style.color]="d.kpis.overdue_amount ? '#C93636' : null">{{ d.kpis.overdue_amount | brl }}</div><div class="muted" style="font-size:11.5px">{{ d.kpis.overdue }} inadimplente(s) · {{ d.kpis.suspended }} suspenso(s)</div></div>
        <div class="kpi-card"><div class="kpi-l">Novos no mês</div><div class="kpi-v">{{ d.kpis.new_month }}</div><div class="muted" style="font-size:11.5px">{{ d.kpis.awaiting }} aguardando 1º pagamento</div></div>
        <div class="kpi-card"><div class="kpi-l">Churn do mês</div><div class="kpi-v" [style.color]="d.kpis.churn_month ? '#C93636' : null">{{ d.kpis.churnPct | pct:1 }}</div><div class="muted" style="font-size:11.5px">{{ d.kpis.churn_month }} cancelamento(s) de {{ d.kpis.activeAtMonthStart }} no início do mês</div></div>
        <div class="kpi-card"><div class="kpi-l">Recebido no ano</div><div class="kpi-v">{{ d.kpis.received_year | brl }}</div><div class="muted" style="font-size:11.5px">total histórico {{ d.kpis.received_total | brl }}</div></div>
      </div>

      <div class="grid-2-resp" style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:14px;margin-bottom:14px">
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:2px">MRR e recebimentos — 12 meses</div><div class="muted" style="font-size:11.5px;margin-bottom:8px">MRR no fim de cada mês (contratos ativos/inadimplentes) × valor efetivamente recebido</div>
          <ax-line-chart [labels]="labels()" [series]="mrrSeries()" [height]="200" [legend]="true" [fmt]="fmt" /></div>
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:8px">Clientes ativos por mês</div>
          <ax-bar-chart [labels]="labels()" [series]="clientSeries()" [height]="200" [fmt]="intFmt" /></div>
      </div>
      <div class="grid-2-resp" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:14px">
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">MRR por plano</div>
          @if (d.byPlan.length) { <ax-donut [data]="donut(d.byPlan)" [fmt]="fmt" /> } @else { <div class="empty-state">Sem clientes ativos.</div> }</div>
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">MRR por segmento</div>
          @if (d.bySegment.length) { <ax-donut [data]="donut(d.bySegment, true)" [fmt]="fmt" /> } @else { <div class="empty-state">Sem clientes ativos.</div> }</div>
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">Meios de pagamento (12 meses)</div>
          @for (m of d.byMethod; track m.label) { <div class="kv"><span>{{ method(m.label) }} <span class="muted">({{ m.n }})</span></span><b>{{ m.value | brl }}</b></div> }
          @empty { <div class="empty-state">Nenhum pagamento ainda.</div> }
          <div class="kv" style="margin-top:6px"><span>Estornos e contestações</span><b [style.color]="d.kpis.lost ? '#C93636' : null">{{ d.kpis.lost | brl }}</b></div>
          <div class="kv"><span>Inadimplência sobre o MRR</span><b>{{ d.kpis.delinquencyPct | pct:1 }}</b></div>
          <div class="kv"><span>Contatos do site (novos / em contato)</span><b>{{ d.leads.new }} / {{ d.leads.contacting }}</b></div>
        </div>
      </div>
      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Vencimentos dos próximos 15 dias e em atraso</div>
        <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Cliente</th><th>Vencimento</th><th class="num">Valor</th><th>Cobrança</th><th>Contrato</th><th></th></tr></thead>
          <tbody>@for (u of d.upcoming; track u.id) {
            <tr><td style="font-weight:500">{{ u.trade_name || u.company_name }}</td><td class="mono" [style.color]="u.due_date < today ? '#C93636' : null">{{ u.due_date | dt }}</td><td class="num">{{ u.amount | brl }}</td>
              <td style="font-size:12px">{{ mode(u.billing_mode) }}</td><td><span class="badge" [class]="'badge ' + st(u.contract_status).cls">{{ st(u.contract_status).label }}</span></td>
              <td><button class="btn-ghost" style="font-size:12px" (click)="router.navigate(['/saas-clientes'], { queryParams: { id: u.contract_id } })">Abrir</button></td></tr>
          } @empty { <tr><td colspan="6"><div class="empty-state">Nenhum vencimento próximo.</div></td></tr> }</tbody></table>
      </div>
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:120px"></div></div> }
  </div>`,
})
export class SaasCarteiraPage implements OnInit {
  readonly pc = (p: string) => this.authSvc.pcan(p); private authSvc = inject(AuthService);
  private api = inject(Api); private toast = inject(ToastService); readonly router = inject(Router);
  readonly d = signal<any>(null); readonly running = signal(false);
  readonly today = new Date().toISOString().slice(0, 10);
  readonly fmt = (v: number) => brl(v); readonly intFmt = (v: number) => String(Math.round(v));
  readonly labels = computed(() => (this.d()?.series ?? []).map((s: any) => mLabel(s.month)));
  readonly mrrSeries = computed<Series[]>(() => [
    { name: 'MRR', color: '#0875D1', values: (this.d()?.series ?? []).map((s: any) => s.mrr) },
    { name: 'Recebido', color: '#18864B', values: (this.d()?.series ?? []).map((s: any) => s.received), dashed: true },
  ]);
  readonly clientSeries = computed<Series[]>(() => [{ name: 'Clientes', color: '#00A6D6', values: (this.d()?.series ?? []).map((s: any) => s.clients) }]);
  readonly st = (s: string) => CONTRACT_STATUS[s] ?? { label: s, cls: 'badge-muted' };
  readonly mode = (m: string) => MODE_SHORT[m] ?? m;
  readonly method = (m: string) => METHOD_LABEL[m] ?? m;
  donut(rows: any[], seg = false) { return rows.map((r, i) => ({ label: seg ? (SEGMENT_LABEL[r.label] ?? r.label) : r.label, value: r.value, color: PALETTE[i % PALETTE.length] })); }
  ngOnInit() { this.load(); }
  async load() { try { this.d.set(await this.api.get('/saas/dashboard')); } catch (e) { this.toast.error(e); } }
  async run() {
    this.running.set(true);
    try {
      const r = await this.api.post<any>('/saas/run-billing', {});
      this.toast.success(`Rotina concluída: ${r.charges} cobrança(s), ${r.links} link(s), ${r.overdue} vencido(s), ${r.suspended} suspenso(s), ${r.reconciled} conciliado(s).`);
      if (r.errors?.length) this.toast.warning(r.errors.slice(0, 2).join(' | '));
      this.load();
    } catch (e) { this.toast.error(e); } finally { this.running.set(false); }
  }
}

// ═══════════════════════════════════════════════════════════════  Fila de auditoria
@Component({
  selector: 'ax-saas-auditoria',
  imports: [FormsModule, IconComponent, ModalComponent, StateComponent, PagerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .item { padding:14px 16px; display:flex; gap:14px; align-items:flex-start; border-bottom:1px solid #EEF2F6; }
    .item:last-child { border-bottom:0; }
    .ico { width:38px; height:38px; border-radius:10px; display:grid; place-items:center; flex:none; }
    .flags { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .flag { font-size:11.5px; padding:3px 8px; border-radius:999px; background:#F1F4F7; color:#4A5B6B; }
    .flag.w1 { background:#FFF7E6; color:#8A5B00; } .flag.w2, .flag.w3 { background:#FDECEC; color:#A12A2A; }
    .acts { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    @media (max-width:760px) { .item { flex-wrap:wrap; } .acts { width:100%; justify-content:stretch; } .acts > * { flex:1; justify-content:center; } }
  `],
  template: `
  <div style="padding:24px">
    <h1 style="font-size:20px;font-weight:700;color:#172B3A">Auditoria de Assinaturas</h1>
    <p style="font-size:13px;color:#647687;margin-bottom:14px">Novas propostas são auditadas <b>antes</b> do pagamento. Nas renovações, só caem aqui as exceções: inadimplência, suspensão, chargeback, estorno, troca de titular e pagamento divergente.</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      <span class="chip" [class.active]="status() === 'aberta'" (click)="setStatus('aberta')">Abertas</span>
      <span class="chip" [class.active]="status() === 'resolvida'" (click)="setStatus('resolvida')">Resolvidas</span>
      <span style="width:1px;background:#DCE4EC;margin:0 4px"></span>
      <span class="chip" [class.active]="!kind()" (click)="setKind('')">Todas</span>
      @for (k of kinds; track k[0]) { <span class="chip" [class.active]="kind() === k[0]" (click)="setKind(k[0])">{{ k[1].label }}</span> }
    </div>
    <div class="card" style="overflow:hidden">
      <ax-state [loading]="loading()" [empty]="!loading() && !items().length" [emptyText]="status() === 'aberta' ? 'Fila vazia: nenhuma exceção aguardando decisão.' : 'Nenhum item resolvido.'" emptyIcon="shield-check" />
      @for (r of items(); track r.id) {
        <div class="item">
          <div class="ico" [style.background]="sev(r.severity).bg"><ax-icon [name]="kindOf(r.kind).icon" [size]="18" [color]="sev(r.severity).color" /></div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><b style="font-size:13.5px">{{ r.title }}</b>
              <span class="badge" [style.background]="sev(r.severity).bg" [style.color]="sev(r.severity).color">{{ sev(r.severity).label }}</span>
              <span class="badge badge-muted">{{ kindOf(r.kind).label }}</span></div>
            <div style="font-size:12.5px;color:#4A5B6B;margin-top:3px">#{{ r.contract_number }} · {{ r.trade_name || r.company_name }}{{ r.cnpj ? ' · ' + (r.cnpj | doc) : '' }} · {{ r.price | brl }}/mês · <span [style.color]="st(r.contract_status).color">{{ st(r.contract_status).label }}</span></div>
            <div class="muted" style="font-size:11.5px;margin-top:2px">{{ r.created_at | dtt }}{{ r.charge_amount ? ' · cobrança ' + (r.charge_amount | brl) : '' }}{{ r.payer_name ? ' · pagador ' + r.payer_name : '' }}{{ r.payer_doc ? ' (' + (r.payer_doc | doc) + ')' : '' }}</div>
            @if (r.kind === 'novo_contrato') {
              <div class="flags"><span class="flag" [style.background]="risk(r.risk_level).bg" [style.color]="risk(r.risk_level).color"><b>{{ risk(r.risk_level).label }}</b></span>
                @for (f of r.risk_flags; track f.code) { <span class="flag" [class]="'flag w' + f.weight">{{ f.label }}</span> }</div>
              <div style="font-size:12px;color:#4A5B6B;margin-top:6px">Responsável: {{ r.contact_name }} · {{ r.contact_email }}</div>
            }
            @if (r.details?.anterior || r.details?.pagador) { <div style="font-size:12px;margin-top:6px">Documento anterior: <b class="mono">{{ (r.details.anterior || r.details.cadastro) | doc }}</b> → pagador: <b class="mono">{{ (r.details.atual || r.details.pagador) | doc }}</b></div> }
            @if (r.status === 'resolvida') { <div style="font-size:12px;margin-top:6px;color:#18864B"><ax-icon name="check-circle-2" [size]="12" /> {{ r.resolution }} — {{ r.resolved_by_name || 'Sistema' }}, {{ r.resolved_at | dtt }}</div> }
          </div>
          <div class="acts">
            <button class="btn-secondary" style="font-size:12px" (click)="open(r)">Abrir contrato</button>
            @if (r.status === 'aberta') {
              @if (pc('carteira.aprovar')) {
                @if (r.kind === 'novo_contrato') { <button class="btn-primary" style="font-size:12px" (click)="open(r)">Auditar proposta</button> }
                @else { <button class="btn-primary" style="font-size:12px" (click)="resolveOpen(r)">Resolver</button> }
              }
            }
          </div>
        </div>
      }
    </div>
    @if (pages() > 1) { <ax-pager [page]="page()" [pages]="pages()" (go)="page.set($event); load()" /> }
  </div>
  <ax-modal [(open)]="resOpen" title="Resolver exceção" icon="shield-check" [width]="560">
    @if (cur(); as r) {
      <p style="font-size:13px;margin-bottom:12px"><b>{{ r.title }}</b><br><span class="muted">{{ r.trade_name || r.company_name }} — {{ st(r.contract_status).label }}</span></p>
      <label class="field-label">Decisão sobre o acesso</label>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px">
        @for (a of actions; track a[0]) {
          <button type="button" class="card" style="padding:10px;text-align:left;cursor:pointer;font:inherit" [style.border]="action === a[0] ? '2px solid #0875D1' : null" (click)="action = a[0]"><b style="font-size:12.5px">{{ a[1] }}</b><div class="muted" style="font-size:11.5px">{{ a[2] }}</div></button>
        }
      </div>
      <label class="field-label">Justificativa (fica registrada na auditoria) *</label>
      <textarea class="input-field" rows="3" [(ngModel)]="resolution" placeholder="Ex.: cliente confirmou a troca de cartão do sócio"></textarea>
    }
    <div footer><button class="btn-secondary" (click)="resOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="resolve()" [disabled]="resolution.trim().length < 3">Confirmar</button></div>
  </ax-modal>`,
})
export class SaasAuditoriaPage implements OnInit {
  readonly pc = (p: string) => this.authSvc.pcan(p); private authSvc = inject(AuthService);
  private api = inject(Api); private toast = inject(ToastService); private router = inject(Router);
  readonly items = signal<any[]>([]); readonly loading = signal(true); readonly page = signal(1); readonly pages = signal(1);
  readonly status = signal('aberta'); readonly kind = signal('');
  readonly kinds = Object.entries(REVIEW_KIND);
  readonly resOpen = signal(false); readonly cur = signal<any>(null); action = 'manter'; resolution = '';
  readonly actions: [string, string, string][] = [['manter', 'Manter como está', 'Só registra a análise'], ['reativar', 'Reativar acesso', 'Cortesia ou acordo'], ['suspender', 'Suspender', 'Somente consulta'], ['cancelar', 'Cancelar contrato', 'Encerra a assinatura']];
  readonly sev = (s: string) => SEVERITY[s] ?? SEVERITY['baixa'];
  readonly kindOf = (k: string) => REVIEW_KIND[k] ?? { label: k, icon: 'info' };
  readonly st = (s: string) => CONTRACT_STATUS[s] ?? { label: s, cls: 'badge-muted', color: '#647687' };
  readonly risk = (r: string) => RISK[r] ?? RISK['baixo'];
  ngOnInit() { this.load(); }
  setStatus(s: string) { this.status.set(s); this.page.set(1); this.load(); }
  setKind(k: string) { this.kind.set(k); this.page.set(1); this.load(); }
  async load() {
    this.loading.set(true);
    try { const r = await this.api.get<any>('/saas/reviews', { status: this.status(), kind: this.kind(), page: this.page() }); this.items.set(r.items); this.pages.set(r.pages); }
    catch (e) { this.toast.error(e); } finally { this.loading.set(false); }
  }
  open(r: any) { this.router.navigate(['/saas-clientes'], { queryParams: { id: r.contract_id } }); }
  resolveOpen(r: any) { this.cur.set(r); this.action = 'manter'; this.resolution = ''; this.resOpen.set(true); }
  async resolve() {
    try { await this.api.post(`/saas/reviews/${this.cur().id}/resolve`, { resolution: this.resolution.trim(), action: this.action }); this.toast.success('Exceção resolvida.'); this.resOpen.set(false); this.load(); }
    catch (e) { this.toast.error(e); }
  }
}

// ═══════════════════════════════════════════════════════════════  Cobranças
@Component({
  selector: 'ax-saas-cobrancas',
  imports: [FormsModule, IconComponent, StateComponent, PagerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <h1 style="font-size:20px;font-weight:700;color:#172B3A">Cobranças</h1>
    <p style="font-size:13px;color:#647687;margin-bottom:14px">Todas as mensalidades e cobranças avulsas da carteira, com meio de pagamento, taxas e pagador</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        @for (s of statuses; track s[0]) { <span class="chip" [class.active]="status() === s[0]" (click)="set('status', s[0])">{{ s[1] }}</span> }
        <span class="chip" [class.active]="overdue()" (click)="overdue.set(!overdue()); page.set(1); load()">Em atraso</span>
      </div>
      <div style="flex:1"></div>
      <div><label class="field-label">De</label><input type="date" class="input-field" [(ngModel)]="from" (change)="page.set(1); load()" /></div>
      <div><label class="field-label">Até</label><input type="date" class="input-field" [(ngModel)]="to" (change)="page.set(1); load()" /></div>
      <button class="btn-secondary" (click)="csv()"><ax-icon name="download" [size]="13" /> CSV</button>
    </div>
    @if (totals(); as t) {
      <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:12px">
        <div class="kpi-card"><div class="kpi-l">Recebido (filtro)</div><div class="kpi-v" style="color:#18864B">{{ t.paid | brl }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Taxas do gateway</div><div class="kpi-v">{{ t.fees | brl }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Pendente (filtro)</div><div class="kpi-v">{{ t.pending | brl }}</div></div>
      </div>
    }
    <div class="card" style="overflow:hidden">
      <ax-state [loading]="loading()" [empty]="!loading() && !items().length" emptyText="Nenhuma cobrança no filtro." />
      @if (items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Cliente</th><th>Referência</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th><th>Pago em</th><th>Meio</th><th class="num">Taxa</th><th>Pagador</th><th></th></tr></thead>
          <tbody>@for (c of items(); track c.id) {
            <tr><td style="font-weight:500">{{ c.trade_name || c.company_name }}</td><td style="font-size:12px">{{ c.kind === 'avulsa' ? 'Avulsa' : (c.period_start | dt) + ' → ' + (c.period_end | dt) }}</td>
              <td class="mono" [style.color]="c.status === 'pendente' && c.due_date < today ? '#C93636' : null">{{ c.due_date | dt }}</td><td class="num">{{ c.amount | brl }}</td>
              <td><span class="badge" [class]="'badge ' + cs(c.status).cls">{{ cs(c.status).label }}</span></td><td style="font-size:12px">{{ c.paid_at ? (c.paid_at | dtt) : '—' }}</td>
              <td style="font-size:12px">{{ c.method ? method(c.method) : '—' }}</td><td class="num">{{ c.fee_amount ? (c.fee_amount | brl) : '—' }}</td>
              <td style="font-size:12px">{{ c.payer_name || c.payer_email || '—' }}</td>
              <td><button class="btn-ghost" style="font-size:12px" (click)="router.navigate(['/saas-clientes'], { queryParams: { id: c.contract_id } })">Contrato</button></td></tr>
          }</tbody></table></div>
      }
    </div>
    @if (pages() > 1) { <ax-pager [page]="page()" [pages]="pages()" (go)="page.set($event); load()" /> }
  </div>`,
})
export class SaasCobrancasPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); readonly router = inject(Router);
  readonly items = signal<any[]>([]); readonly totals = signal<any>(null); readonly loading = signal(true); readonly page = signal(1); readonly pages = signal(1);
  readonly status = signal(''); readonly overdue = signal(false); from = ''; to = '';
  readonly today = new Date().toISOString().slice(0, 10);
  readonly statuses = [['', 'Todas'], ['pendente', 'Pendentes'], ['paga', 'Pagas'], ['estornada', 'Estornadas'], ['contestada', 'Contestadas'], ['cancelada', 'Canceladas']];
  readonly cs = (s: string) => CHARGE_STATUS[s] ?? { label: s, cls: 'badge-muted' };
  readonly method = (m: string) => METHOD_LABEL[m] ?? m;
  ngOnInit() { this.load(); }
  set(_k: string, v: string) { this.status.set(v); this.page.set(1); this.load(); }
  private q(extra: any = {}) { return { status: this.status(), overdue: this.overdue() ? 1 : '', from: this.from, to: this.to, page: this.page(), ...extra }; }
  async load() {
    this.loading.set(true);
    try { const r = await this.api.get<any>('/saas/charges', this.q()); this.items.set(r.items); this.totals.set(r.totals); this.pages.set(r.pages); }
    catch (e) { this.toast.error(e); } finally { this.loading.set(false); }
  }
  async csv() {
    try {
      const r = await this.api.get<any>('/saas/charges', this.q({ page: 1, size: 500 }));
      const head = ['cliente', 'tipo', 'inicio', 'fim', 'vencimento', 'valor', 'situacao', 'pago_em', 'valor_pago', 'meio', 'taxa', 'pagador', 'documento_pagador'];
      const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = r.items.map((c: any) => [c.trade_name || c.company_name, c.kind, c.period_start, c.period_end, c.due_date, c.amount, c.status, c.paid_at ?? '', c.paid_amount ?? '', c.method ?? '', c.fee_amount ?? '', c.payer_name ?? '', c.payer_doc ?? ''].map(esc).join(';'));
      const blob = new Blob(['﻿' + [head.join(';'), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `cobrancas-axionyx-${this.today}.csv`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { this.toast.error(e); }
  }
}

// ═══════════════════════════════════════════════════════════════  Planos
@Component({
  selector: 'ax-saas-planos',
  imports: [FormsModule, IconComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A">Planos</h1><p style="font-size:13px;color:#647687">Planos comerciais do AXIONYX. O valor de cada contrato pode ser negociado; mudar o plano não altera contratos já fechados.</p></div>
      @if (pc('carteira.configurar')) { <button class="btn-primary" (click)="edit(null)"><ax-icon name="plus" [size]="13" /> Novo plano</button> }
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px">
      @for (p of plans(); track p.id) {
        <div class="card" style="padding:18px;display:flex;flex-direction:column;gap:8px" [style.opacity]="p.active ? 1 : .6">
          <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:15px">{{ p.name }}</b>@if (!p.active) { <span class="badge badge-muted">Inativo</span> }</div>
          <div style="font-size:26px;font-weight:800;color:#0875D1">{{ p.price_monthly | brl }}<span style="font-size:12px;font-weight:500;color:#647687">/mês</span></div>
          <div class="muted" style="font-size:12.5px;min-height:34px">{{ p.description || '—' }}</div>
          <div style="font-size:12px;display:flex;gap:12px;flex-wrap:wrap"><span><ax-icon name="users" [size]="12" /> {{ p.max_users ? 'até ' + p.max_users + ' usuários' : 'usuários ilimitados' }}</span><span><ax-icon name="store" [size]="12" /> {{ p.max_branches ? 'até ' + p.max_branches + ' filiais' : 'filiais ilimitadas' }}</span></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span style="font-size:12px"><b>{{ p.clients }}</b> cliente(s) ativo(s)</span>@if (pc('carteira.configurar')) { <button class="btn-secondary" style="font-size:12px" (click)="edit(p)">Editar</button> }</div>
        </div>
      } @empty { <div class="card empty-state" style="padding:28px;grid-column:1/-1">Cadastre o primeiro plano para usar nas propostas.</div> }
    </div>
  </div>
  <ax-modal [(open)]="open" [title]="f.id ? 'Editar plano' : 'Novo plano'" icon="tag" [width]="560">
    <div class="form-grid-2">
      <div><label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="f.name" /></div>
      <div><label class="field-label">Valor mensal (R$) *</label><input class="input-field" type="number" min="0" step="0.01" [(ngModel)]="f.priceMonthly" /></div>
      <div><label class="field-label">Máx. usuários</label><input class="input-field" type="number" min="1" [(ngModel)]="f.maxUsers" placeholder="ilimitado" /></div>
      <div><label class="field-label">Máx. filiais</label><input class="input-field" type="number" min="1" [(ngModel)]="f.maxBranches" placeholder="ilimitado" /></div>
      <div class="span-2"><label class="field-label">Descrição</label><textarea class="input-field" rows="2" [(ngModel)]="f.description"></textarea></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:10px"><input type="checkbox" [(ngModel)]="f.active" /> Plano disponível para novas propostas</label>
    <div footer><button class="btn-secondary" (click)="open.set(false)">Cancelar</button><button class="btn-primary" (click)="save()">Salvar</button></div>
  </ax-modal>`,
})
export class SaasPlanosPage implements OnInit {
  readonly pc = (p: string) => this.authSvc.pcan(p); private authSvc = inject(AuthService);
  private api = inject(Api); private toast = inject(ToastService);
  readonly plans = signal<any[]>([]); readonly open = signal(false); f: any = {};
  ngOnInit() { this.load(); }
  async load() { try { this.plans.set(await this.api.get('/saas/plans')); } catch (e) { this.toast.error(e); } }
  edit(p: any) { this.f = p ? { id: p.id, name: p.name, priceMonthly: Number(p.price_monthly), maxUsers: p.max_users, maxBranches: p.max_branches, description: p.description, active: p.active } : { name: '', priceMonthly: null, active: true }; this.open.set(true); }
  async save() {
    const f = this.f; const body = { name: f.name, priceMonthly: Number(f.priceMonthly), maxUsers: f.maxUsers ? Number(f.maxUsers) : undefined, maxBranches: f.maxBranches ? Number(f.maxBranches) : undefined, description: f.description || undefined, active: !!f.active };
    try { if (f.id) await this.api.put('/saas/plans/' + f.id, body); else await this.api.post('/saas/plans', body); this.toast.success('Plano salvo.'); this.open.set(false); this.load(); }
    catch (e) { this.toast.error(e); }
  }
}

// ═══════════════════════════════════════════════════════════════  Mercado Pago (configuração e notificações)
@Component({
  selector: 'ax-saas-gateway',
  imports: [IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .chk { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-bottom:1px solid #EEF2F6; font-size:13px; }
    .chk:last-child { border-bottom:0; }
    .code { font-family:'JetBrains Mono',monospace; font-size:12px; background:#F1F4F7; padding:8px 10px; border-radius:8px; word-break:break-all; display:flex; gap:8px; align-items:center; }
    ol { padding-left:18px; margin:0; font-size:13px; line-height:1.7; color:#334B5F; }
  `],
  template: `
  <div style="padding:24px;max-width:1100px">
    <h1 style="font-size:20px;font-weight:700;color:#172B3A">Mercado Pago</h1>
    <p style="font-size:13px;color:#647687;margin-bottom:14px">Credenciais ficam somente nas variáveis de ambiente do servidor (Railway) — nunca no código nem no banco.</p>
    @if (g(); as g) {
      <div class="grid-2-resp" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:14px">
        <div class="card" style="padding:16px">
          <div style="font-size:14px;font-weight:700;margin-bottom:6px">Situação da integração</div>
          @for (c of checks(); track c[0]) {
            <div class="chk"><ax-icon [name]="c[1] ? 'check-circle-2' : 'x-circle'" [size]="16" [color]="c[1] ? '#18864B' : '#C93636'" /><div style="flex:1"><b>{{ c[0] }}</b><div class="muted" style="font-size:12px">{{ c[2] }}</div></div></div>
          }
          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
            <button class="btn-primary" (click)="test()" [disabled]="!g.configured || testing() || !pc('carteira.configurar')"><ax-icon name="plug" [size]="13" /> Testar conexão</button>
            @if (acct()) { <span style="font-size:12.5px;align-self:center;color:#18864B">Conectado: conta {{ acct().nickname || acct().id }} ({{ acct().live ? 'produção' : 'teste' }})</span> }
          </div>
        </div>
        <div class="card" style="padding:16px">
          <div style="font-size:14px;font-weight:700;margin-bottom:8px">URL do webhook (cole no painel do Mercado Pago)</div>
          @if (g.webhookUrl) { <div class="code"><span style="flex:1">{{ g.webhookUrl }}</span><button class="btn-ghost" style="font-size:11px" (click)="copy(g.webhookUrl)">Copiar</button></div> }
          @else { <div class="code" style="color:#C93636">Defina APP_PUBLIC_URL (ex.: https://seu-app.up.railway.app)</div> }
          <div style="font-size:12.5px;margin-top:10px;color:#4A5B6B">Eventos a marcar: <b>Pagamentos</b>, <b>Planos e assinaturas</b> (vínculo e pagamento recorrente) e <b>Contestações (chargebacks)</b>.</div>
          <div style="font-size:12.5px;margin-top:8px;color:#4A5B6B">Retorno do cliente após pagar: <span class="mono">{{ g.backUrl || '—' }}</span></div>
          <div style="font-size:12px;margin-top:8px" class="muted">Toda notificação é conferida pela assinatura (x-signature) e o pagamento é sempre consultado na API do Mercado Pago antes de liberar o acesso. Se uma notificação se perder, a rotina horária concilia os links pendentes.</div>
        </div>
      </div>
      <div class="card" style="padding:16px;margin-bottom:14px">
        <div style="font-size:14px;font-weight:700;margin-bottom:8px">Passo a passo</div>
        <ol>
          <li>Em <b>mercadopago.com.br/developers › Suas integrações</b>, crie uma aplicação (produto: Checkout Pro / Assinaturas).</li>
          <li>Copie o <b>Access Token</b> (comece com as credenciais de teste) e salve no Railway como <span class="mono">MP_ACCESS_TOKEN</span>.</li>
          <li>Em <b>Webhooks › Configurar notificações</b>, cole a URL acima, marque os eventos e copie a <b>assinatura secreta</b> para <span class="mono">MP_WEBHOOK_SECRET</span>.</li>
          <li>Defina <span class="mono">APP_PUBLIC_URL</span> com o endereço público do sistema e faça o redeploy.</li>
          <li>Clique em <b>Testar conexão</b>, crie uma proposta de teste, aprove e pague com um usuário comprador de teste.</li>
          <li>Funcionou? Troque o token pelo de <b>produção</b> e configure o webhook também no modo produção.</li>
        </ol>
      </div>
      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6;display:flex"><span style="flex:1">Últimas notificações recebidas</span><button class="btn-ghost" style="font-size:12px" (click)="load()"><ax-icon name="refresh-cw" [size]="12" /> Atualizar</button></div>
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Recebida</th><th>Tópico</th><th>Recurso</th><th>Assinatura</th><th>Modo</th><th>Situação</th><th>Detalhe</th><th></th></tr></thead>
          <tbody>@for (e of g.events; track e.id) {
            <tr><td class="mono" style="font-size:11.5px">{{ e.created_at | dtt }}</td><td style="font-size:12px">{{ e.topic || '—' }}</td><td class="mono" style="font-size:11.5px">{{ e.resource_id || '—' }}</td>
              <td>@if (e.signature_ok) { <span class="badge badge-success">válida</span> } @else { <span class="badge badge-danger">inválida</span> }</td>
              <td style="font-size:12px">{{ e.live_mode === null ? '—' : e.live_mode ? 'produção' : 'teste' }}</td>
              <td><span class="badge" [class]="e.status === 'processado' ? 'badge badge-success' : e.status === 'erro' ? 'badge badge-danger' : 'badge badge-muted'">{{ e.status }}</span></td>
              <td style="font-size:11.5px;max-width:260px">{{ e.error || '' }}</td>
              <td>@if (e.signature_ok && e.status === 'erro' && pc('carteira.configurar')) { <button class="btn-ghost" style="font-size:11px" (click)="reprocess(e)">Reprocessar</button> }</td></tr>
          } @empty { <tr><td colspan="8"><div class="empty-state">Nenhuma notificação recebida ainda.</div></td></tr> }</tbody></table></div>
      </div>
    }
  </div>`,
})
export class SaasGatewayPage implements OnInit {
  readonly pc = (p: string) => this.authSvc.pcan(p); private authSvc = inject(AuthService);
  private api = inject(Api); private toast = inject(ToastService);
  readonly g = signal<any>(null); readonly acct = signal<any>(null); readonly testing = signal(false);
  readonly checks = computed<[string, boolean, string][]>(() => {
    const g = this.g(); if (!g) return [];
    return [
      ['MP_ACCESS_TOKEN', g.configured, g.configured ? `Definido — modo ${g.mode}` : 'Access Token da aplicação no Mercado Pago'],
      ['MP_WEBHOOK_SECRET', g.webhookSecret, g.webhookSecret ? 'Definido — notificações são verificadas' : 'Sem ele, nenhuma notificação é aceita'],
      ['APP_PUBLIC_URL', !!g.publicUrl, g.publicUrl || 'Endereço público do sistema (links de retorno e webhook)'],
      ['Última notificação', !!g.lastEvent, g.lastEvent ? `${g.lastEvent.topic || '—'} em ${new Date(g.lastEvent.created_at).toLocaleString('pt-BR')} (${g.lastEvent.status})` : 'Nenhuma recebida ainda'],
    ];
  });
  ngOnInit() { this.load(); }
  async load() { try { this.g.set(await this.api.get('/saas/gateway')); } catch (e) { this.toast.error(e); } }
  async test() { this.testing.set(true); try { this.acct.set(await this.api.post('/saas/gateway/test', {})); this.toast.success('Conexão com o Mercado Pago OK.'); } catch (e) { this.toast.error(e); } finally { this.testing.set(false); } }
  async reprocess(e: any) { try { await this.api.post(`/saas/gateway/events/${e.id}/reprocess`, {}); this.toast.success('Notificação reprocessada.'); this.load(); } catch (err) { this.toast.error(err); } }
  async copy(t: string) { if (await copyText(t)) this.toast.success('Copiado.'); }
}
