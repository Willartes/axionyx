import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, PagerComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, todayIso } from '../../core/format';
import { BATCH_STATUS, CLAIM_STATUS, downloadCsv } from './saude-shared';

/**
 * Convênios e faturamento: cadastro das operadoras, tabela de preços (TUSS), guias geradas pelos atendimentos concluídos,
 * montagem de lotes, registro do retorno (pagamento e glosa com motivo) e exportação em CSV. Não envia XML TISS:
 * o envio é feito no portal da operadora e o protocolo é registrado aqui.
 */
@Component({
  selector: 'ax-convenios',
  imports: [FormsModule, IconComponent, ModalComponent, PagerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:20px 24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="file-stack" [size]="20" color="#0875D1" /> Convênios e Faturamento</h1>
        <p style="font-size:13px;color:#647687">Atendimentos por convênio concluídos viram guias a faturar. Monte o lote, envie pelo portal da operadora e registre o retorno (pagamento ou glosa).</p></div>
      @if (auth.can('convenios.editar') && tab() === 'convenios') { <button class="btn-primary" style="font-size:12px" (click)="openIns(null)"><ax-icon name="plus" [size]="13" /> Novo convênio</button> }
    </div>
    <div class="tabs-bar" style="margin:0 0 14px">
      @for (t of tabs; track t[0]) { <div class="tab-item" [class.active]="tab() === t[0]" (click)="setTab(t[0])">{{ t[1] }}</div> }
    </div>

    @if (tab() === 'guias') {
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <select class="input-field" style="max-width:220px" [(ngModel)]="fIns" (ngModelChange)="loadClaims(1)"><option value="">Todos os convênios</option>@for (i of insurers(); track i.id) { <option [value]="i.id">{{ i.name }}</option> }</select>
        @for (s of statusList; track s[0]) { <span class="chip" [class.active]="fStatus === s[0]" (click)="fStatus = s[0]; fBatch = ''; loadClaims(1)">{{ s[1] }}</span> }
        <input type="date" class="input-field" style="width:150px" [(ngModel)]="fFrom" (ngModelChange)="loadClaims(1)" title="Atendimentos a partir de" />
        <input type="date" class="input-field" style="width:150px" [(ngModel)]="fTo" (ngModelChange)="loadClaims(1)" title="até" />
        <span style="flex:1"></span>
        <button class="btn-ghost" style="font-size:12px" (click)="exportClaims()"><ax-icon name="download" [size]="13" /> CSV</button>
      </div>
      @if (claims(); as c) {
        @if (fStatus === 'a_faturar' && auth.can('convenios.editar')) {
          <div class="card" style="padding:10px 14px;margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12.5px">
            <span><b>{{ selectedIds().length }}</b> guia(s) selecionada(s) · <b class="mono">{{ selectedTotal() | brl }}</b></span>
            <span class="muted">Selecione guias de um mesmo convênio para montar o lote.</span><span style="flex:1"></span>
            <button class="btn-primary" style="font-size:12px" [disabled]="!selectedIds().length" (click)="openBatch()"><ax-icon name="send" [size]="13" /> Montar lote</button>
          </div>
        }
        @if (fStatus === 'enviado' && auth.can('convenios.editar')) {
          <div class="card" style="padding:10px 14px;margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12.5px">
            <span><b>{{ selectedIds().length }}</b> guia(s) selecionada(s)</span><span style="flex:1"></span>
            <button class="btn-primary" style="font-size:12px" [disabled]="!selectedIds().length" (click)="openSettle()"><ax-icon name="badge-dollar-sign" [size]="13" /> Registrar retorno do convênio</button>
          </div>
        }
        <div class="card" style="overflow:hidden">
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead><tr>@if (selectable()) { <th style="width:30px"><input type="checkbox" [checked]="allSelected()" (change)="toggleAll()" aria-label="Selecionar todas" /></th> }
              <th>Data</th><th>{{ auth.term('cliente') }}</th><th>Procedimento</th><th>Convênio</th><th>Carteirinha / guia / autorização</th><th>{{ auth.term('profissional') }}</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead>
            <tbody>@for (x of c.items; track x.id) {
              <tr><td>@if (selectable()) { <input type="checkbox" [checked]="!!sel()[x.id]" (change)="toggle(x)" [attr.aria-label]="'Selecionar ' + x.description" /> }</td>
                <td>{{ x.service_date | dt }}</td><td>{{ x.patient || '—' }}</td><td>{{ x.description }}@if (x.tuss_code) { <div class="mono muted" style="font-size:11px">TUSS {{ x.tuss_code }}</div> }</td>
                <td>{{ x.insurer_name }}</td>
                <td class="mono" style="font-size:11.5px">{{ x.insurance_card || '—' }} / {{ x.guide_number || '—' }} / @if (x.authorization_code) { {{ x.authorization_code }} } @else { <span style="color:#B07400">sem autorização</span> }</td>
                <td>{{ x.professional || '—' }}</td>
                <td class="num">{{ x.amount | brl }}@if (x.paid_amount !== null && x.status !== 'a_faturar') { <div style="font-size:11px;color:#18864B">pago {{ x.paid_amount | brl }}</div> }</td>
                <td><span class="badge" style="white-space:nowrap" [class]="'badge ' + cs(x.status)[1]" [title]="x.gloss_reason || ''">{{ cs(x.status)[0] }}</span>@if (x.batch_number) { <div class="muted" style="font-size:11px">lote {{ x.batch_number }}</div> }
                  @if (x.gloss_reason) { <div style="font-size:11px;color:#C93636;max-width:200px">{{ x.gloss_reason }}</div> }</td>
                <td style="white-space:nowrap">@if (x.status === 'a_faturar' && auth.can('convenios.editar')) { <button class="btn-ghost" style="font-size:11px" (click)="openClaim(x)">Corrigir</button><button class="btn-ghost" style="font-size:11px;color:#C93636" (click)="cancelClaim(x)">Cancelar</button> }</td></tr>
            } @empty { <tr><td [attr.colspan]="10"><div class="empty-state">Nenhuma guia {{ fStatus ? cs(fStatus)[0].toLowerCase() : '' }}. As guias são geradas quando um atendimento marcado como “Convênio” é concluído na agenda ou na recepção.</div></td></tr> }</tbody>
          </table></div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;font-size:12px;flex-wrap:wrap;gap:8px;border-top:1px solid #EEF2F6">
            <span>{{ c.totals.n }} guia(s) · faturado <b class="mono">{{ c.totals.amount | brl }}</b> · recebido <b class="mono">{{ c.totals.paid | brl }}</b></span>
            <ax-pager [page]="c.page" [pages]="c.pages" [total]="c.total" (go)="loadClaims($event)" />
          </div>
        </div>
      } @else { <div class="skeleton" style="height:160px"></div> }
    }

    @if (tab() === 'lotes') {
      <div class="card" style="overflow:hidden"><div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr><th>Lote</th><th>Convênio</th><th>Competência</th><th>Enviado em</th><th>Protocolo</th><th class="num">Guias</th><th class="num">Faturado</th><th class="num">Recebido</th><th class="num">Glosa</th><th>Previsão</th><th>Situação</th></tr></thead>
        <tbody>@for (b of batches(); track b.id) {
          <tr style="cursor:pointer" (click)="fStatus = ''; fBatch = b.id; setTab('guias')"><td class="mono">{{ b.number }}</td><td>{{ b.insurer_name }}</td><td>{{ b.reference }}</td><td>{{ b.sent_at | dt }}</td><td class="mono">{{ b.protocol || '—' }}</td>
            <td class="num">{{ b.claims }}{{ b.open_claims ? ' (' + b.open_claims + ' em aberto)' : '' }}</td><td class="num">{{ b.total | brl }}</td><td class="num" style="color:#18864B">{{ b.paid_total | brl }}</td><td class="num" style="color:#C93636">{{ b.gloss_total | brl }}</td>
            <td [style.color]="late(b) ? '#C93636' : null">{{ b.expected_at | dt }}{{ late(b) ? ' · atrasado' : '' }}</td><td><span class="badge" [class]="'badge ' + bs(b.status)[1]">{{ bs(b.status)[0] }}</span></td></tr>
        } @empty { <tr><td colspan="11"><div class="empty-state">Nenhum lote enviado.</div></td></tr> }</tbody></table></div></div>
    }

    @if (tab() === 'convenios') {
      <div class="card" style="overflow:hidden"><div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr><th>Convênio</th><th>Registro ANS</th><th>Prazo de pagamento</th><th>Autorização prévia</th><th class="num">Pacientes</th><th class="num">A faturar</th><th class="num">Aguardando</th><th></th></tr></thead>
        <tbody>@for (i of insurersAll(); track i.id) {
          <tr [style.opacity]="i.active ? 1 : .5"><td><b>{{ i.name }}</b>@if (i.portal_url) { <div><a [href]="i.portal_url" target="_blank" rel="noopener" style="font-size:11px;color:#0875D1">portal da operadora</a></div> }</td>
            <td class="mono">{{ i.ans_code || '—' }}</td><td>{{ i.payment_days }} dias</td><td>{{ i.requires_authorization ? 'Exige' : 'Não exige' }}</td>
            <td class="num">{{ i.patients }}</td><td class="num">{{ i.to_bill | brl }}</td><td class="num">{{ i.sent | brl }}</td>
            <td style="white-space:nowrap"><button class="btn-ghost" style="font-size:11px" (click)="openPrices(i)"><ax-icon name="table" [size]="12" /> Tabela ({{ i.prices }})</button>
              @if (auth.can('convenios.editar')) { <button class="btn-ghost" style="font-size:11px" (click)="openIns(i)"><ax-icon name="pencil" [size]="12" /> Editar</button> }</td></tr>
        } @empty { <tr><td colspan="8"><div class="empty-state">Nenhum convênio cadastrado. Cadastre as operadoras com que a clínica tem contrato (o atendimento particular não precisa de cadastro).</div></td></tr> }</tbody></table></div></div>
    }
  </div>

  <ax-modal [(open)]="insOpen" [title]="insForm.id ? 'Editar convênio' : 'Novo convênio'" icon="building-2" [width]="620">
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 140px;gap:10px" class="grid-2-resp">
      <div><label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="insForm.name" /></div>
      <div><label class="field-label">Registro ANS</label><input class="input-field mono" [(ngModel)]="insForm.ansCode" maxlength="10" /></div>
      <div><label class="field-label">CNPJ</label><input class="input-field mono" [(ngModel)]="insForm.cnpj" /></div>
      <div><label class="field-label">Prazo (dias)</label><input type="number" min="0" class="input-field mono" [(ngModel)]="insForm.paymentDays" /></div>
      <div><label class="field-label">Telefone</label><input class="input-field" [(ngModel)]="insForm.phone" /></div>
      <div><label class="field-label">E-mail</label><input class="input-field" [(ngModel)]="insForm.email" /></div>
    </div>
    <label class="field-label" style="margin-top:8px">Portal da operadora (link)</label><input class="input-field" [(ngModel)]="insForm.portalUrl" placeholder="https://" />
    <label style="font-size:12.5px;display:flex;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" [(ngModel)]="insForm.requiresAuthorization" /> Exige senha/autorização prévia para faturar</label>
    @if (insForm.id) { <label style="font-size:12.5px;display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" [(ngModel)]="insForm.active" /> Ativo</label> }
    <label class="field-label" style="margin-top:8px">Observações (regras, contatos, prazos de envio)</label><textarea class="input-field" rows="2" [(ngModel)]="insForm.notes"></textarea>
    <div footer><button class="btn-secondary" (click)="insOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveIns()">Salvar</button></div>
  </ax-modal>

  <ax-modal [open]="!!prices()" (closed)="prices.set(null)" [title]="'Tabela de preços — ' + (prices()?.insurer?.name ?? '')" icon="table" [width]="760">
    <p style="font-size:12px;color:#647687;margin-bottom:8px">Valor acordado com o convênio por procedimento e o código TUSS. Sem valor, a guia usa o preço particular do serviço.</p>
    <div style="max-height:56vh;overflow:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr><th>Procedimento</th><th class="num">Particular</th><th style="width:130px">TUSS</th><th style="width:130px">Valor convênio</th></tr></thead>
      <tbody>@for (r of prices()?.items ?? []; track r.product_id) {
        <tr><td>{{ r.name }}</td><td class="num">{{ r.private_price | brl }}</td>
          <td><input class="input-field mono" style="font-size:12px" [(ngModel)]="r.tuss_code" [disabled]="!auth.can('convenios.editar')" /></td>
          <td><input type="number" min="0" step="0.01" class="input-field mono" style="font-size:12px" [(ngModel)]="r.price" [disabled]="!auth.can('convenios.editar')" /></td></tr>
      } @empty { <tr><td colspan="4"><div class="empty-state">Cadastre os procedimentos em Serviços.</div></td></tr> }</tbody></table></div>
    <div footer><button class="btn-secondary" (click)="prices.set(null)">Fechar</button>@if (auth.can('convenios.editar')) { <button class="btn-primary" (click)="savePrices()">Salvar tabela</button> }</div>
  </ax-modal>

  <ax-modal [(open)]="batchOpen" title="Montar lote de faturamento" icon="send" [width]="520">
    <div style="font-size:13px;margin-bottom:10px"><b>{{ selectedIds().length }}</b> guia(s) · <b class="mono">{{ selectedTotal() | brl }}</b> · {{ selectedInsurerName() }}</div>
    <div style="display:grid;grid-template-columns:140px minmax(0,1fr);gap:10px"><div><label class="field-label">Competência</label><input type="month" class="input-field" [(ngModel)]="bRef" /></div>
      <div><label class="field-label">Protocolo do envio no portal</label><input class="input-field mono" [(ngModel)]="bProtocol" placeholder="opcional" /></div></div>
    <label class="field-label" style="margin-top:8px">Observações</label><input class="input-field" [(ngModel)]="bNotes" />
    <p style="font-size:11.5px;color:#647687;margin-top:8px">O sistema não transmite o lote à operadora: envie as guias pelo portal do convênio (ou exporte o CSV) e registre aqui o protocolo. As guias passam para “Enviada”.</p>
    <div footer><button class="btn-secondary" (click)="batchOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="sendBatch()">Confirmar envio</button></div>
  </ax-modal>

  <ax-modal [(open)]="settleOpen" title="Retorno do convênio" icon="badge-dollar-sign" [width]="760">
    <div style="display:grid;grid-template-columns:160px minmax(0,1fr);gap:10px;margin-bottom:10px"><div><label class="field-label">Data do pagamento</label><input type="date" class="input-field" [(ngModel)]="sDate" /></div>
      <div style="font-size:12px;color:#647687;align-self:end">Valor recebido entra no Financeiro (conta bancária padrão) e gera o repasse do profissional. Pagamento menor que o faturado é glosa e exige o motivo.</div></div>
    <div style="max-height:50vh;overflow:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr><th>Guia</th><th class="num">Faturado</th><th style="width:120px">Pago</th><th>Motivo da glosa</th></tr></thead>
      <tbody>@for (r of settleRows(); track r.id) {
        <tr><td>{{ r.description }}<div class="muted" style="font-size:11px">{{ r.patient }} · {{ r.service_date | dt }}</div></td><td class="num">{{ r.amount | brl }}</td>
          <td><input type="number" min="0" step="0.01" class="input-field mono" style="font-size:12px" [(ngModel)]="r.paid" /></td>
          <td><input class="input-field" style="font-size:12px" [(ngModel)]="r.reason" [disabled]="+r.paid >= +r.amount" [placeholder]="+r.paid < +r.amount ? 'obrigatório' : ''" /></td></tr>
      }</tbody></table></div>
    <div footer><button class="btn-secondary" (click)="settleOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="settle()">Registrar</button></div>
  </ax-modal>

  <ax-modal [open]="!!claimEdit()" (closed)="claimEdit.set(null)" title="Corrigir guia" icon="pencil" [width]="480">
    @if (claimEdit(); as x) {
      <div style="font-size:12.5px;margin-bottom:8px">{{ x.description }} · {{ x.patient }} · {{ x.service_date | dt }}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><label class="field-label">Carteirinha</label><input class="input-field mono" [(ngModel)]="x.insurance_card" /></div>
        <div><label class="field-label">Nº da guia</label><input class="input-field mono" [(ngModel)]="x.guide_number" /></div>
        <div><label class="field-label">Autorização</label><input class="input-field mono" [(ngModel)]="x.authorization_code" /></div>
        <div><label class="field-label">TUSS</label><input class="input-field mono" [(ngModel)]="x.tuss_code" /></div>
        <div><label class="field-label">Valor</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="x.amount" /></div>
      </div>
    }
    <div footer><button class="btn-secondary" (click)="claimEdit.set(null)">Cancelar</button><button class="btn-primary" (click)="saveClaim()">Salvar</button></div>
  </ax-modal>`,
})
export class ConveniosPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly tabs: [string, string][] = [['guias', 'Guias'], ['lotes', 'Lotes enviados'], ['convenios', 'Convênios e tabelas']];
  readonly statusList: [string, string][] = [['a_faturar', 'A faturar'], ['enviado', 'Enviadas'], ['pago', 'Pagas'], ['glosado', 'Glosadas'], ['', 'Todas']];
  readonly tab = signal('guias'); readonly insurersAll = signal<any[]>([]); readonly claims = signal<any>(null); readonly batches = signal<any[]>([]);
  readonly insurers = computed(() => this.insurersAll().filter((i) => i.active));
  readonly sel = signal<Record<string, any>>({});
  fIns = ''; fStatus = 'a_faturar'; fFrom = ''; fTo = ''; fBatch = '';
  cs(s: string) { return CLAIM_STATUS[s] ?? [s, 'badge-muted']; }
  bs(s: string) { return BATCH_STATUS[s] ?? [s, 'badge-muted']; }
  late(b: any) { return (b.status === 'enviado' || b.status === 'pago_parcial') && b.expected_at && String(b.expected_at).slice(0, 10) < todayIso(); }
  selectable() { return (this.fStatus === 'a_faturar' || this.fStatus === 'enviado') && this.auth.can('convenios.editar'); }
  readonly selectedIds = computed(() => Object.keys(this.sel()));
  readonly selectedTotal = computed(() => Object.values(this.sel()).reduce((s: number, x: any) => s + Number(x.amount), 0));
  selectedInsurerName() { return [...new Set(Object.values(this.sel()).map((x: any) => x.insurer_name))].join(', '); }
  allSelected() { const it = this.claims()?.items ?? []; return it.length > 0 && it.every((x: any) => this.sel()[x.id]); }
  toggle(x: any) { const s = { ...this.sel() }; if (s[x.id]) delete s[x.id]; else s[x.id] = x; this.sel.set(s); }
  toggleAll() { const it = this.claims()?.items ?? []; if (this.allSelected()) this.sel.set({}); else this.sel.set(Object.fromEntries(it.map((x: any) => [x.id, x]))); }

  ngOnInit() { this.loadInsurers(); this.loadClaims(1); }
  setTab(t: string) { this.tab.set(t); if (t === 'guias') this.loadClaims(1); if (t === 'lotes') this.loadBatches(); if (t === 'convenios') this.loadInsurers(); }
  async loadInsurers() { try { this.insurersAll.set(await this.api.get('/insurers', { all: 1 })); } catch (e) { this.toast.error(e); } }
  async loadBatches() { try { this.batches.set(await this.api.get('/insurance-batches')); } catch (e) { this.toast.error(e); } }
  private q(page: number, size?: number) { return { page, size, status: this.fStatus || undefined, insurer: this.fIns || undefined, from: this.fFrom || undefined, to: this.fTo || undefined, batch: this.fBatch || undefined }; }
  async loadClaims(page: number) {
    this.sel.set({});
    try { this.claims.set(await this.api.get('/insurance-claims', this.q(page))); } catch (e) { this.toast.error(e); }
  }
  async exportClaims() {
    try {
      const r: any = await this.api.get('/insurance-claims', this.q(1, 500));
      downloadCsv(`guias-convenio-${todayIso()}.csv`, [['Data', 'Paciente', 'Procedimento', 'TUSS', 'Convênio', 'Carteirinha', 'Guia', 'Autorização', 'Profissional', 'Valor', 'Situação', 'Lote', 'Pago', 'Motivo glosa'],
        ...r.items.map((x: any) => [String(x.service_date).slice(0, 10), x.patient, x.description, x.tuss_code, x.insurer_name, x.insurance_card, x.guide_number, x.authorization_code, x.professional,
          String(x.amount).replace('.', ','), this.cs(x.status)[0], x.batch_number, x.paid_amount !== null ? String(x.paid_amount).replace('.', ',') : '', x.gloss_reason])]);
    } catch (e) { this.toast.error(e); }
  }

  // convênio
  readonly insOpen = signal(false); insForm: any = {};
  openIns(i: any) {
    this.insForm = i ? { id: i.id, name: i.name, ansCode: i.ans_code || '', cnpj: i.cnpj || '', phone: i.phone || '', email: i.email || '', portalUrl: i.portal_url || '', paymentDays: i.payment_days, requiresAuthorization: i.requires_authorization, notes: i.notes || '', active: i.active }
      : { name: '', ansCode: '', cnpj: '', phone: '', email: '', portalUrl: '', paymentDays: 30, requiresAuthorization: false, notes: '', active: true };
    this.insOpen.set(true);
  }
  async saveIns() {
    const f = this.insForm; const body: any = { name: f.name?.trim(), paymentDays: Number(f.paymentDays || 0), requiresAuthorization: !!f.requiresAuthorization, active: f.active !== false };
    for (const k of ['ansCode', 'cnpj', 'phone', 'email', 'portalUrl', 'notes']) if (f[k]) body[k] = f[k];
    try { if (f.id) await this.api.put(`/insurers/${f.id}`, body); else await this.api.post('/insurers', body); this.toast.success('Convênio salvo.'); this.insOpen.set(false); this.loadInsurers(); } catch (e) { this.toast.error(e); }
  }
  readonly prices = signal<any>(null);
  async openPrices(i: any) { try { const r: any = await this.api.get(`/insurers/${i.id}/prices`); r.items.forEach((x: any) => { x.price = x.price === null ? null : Number(x.price); }); this.prices.set(r); } catch (e) { this.toast.error(e); } }
  async savePrices() {
    const p = this.prices();
    const items = p.items.map((x: any) => ({ productId: x.product_id, price: x.price === null || x.price === '' || x.price === undefined ? null : Number(x.price), tussCode: x.tuss_code || null }));
    try { const r: any = await this.api.put(`/insurers/${p.insurer.id}/prices`, { items }); this.toast.success(`Tabela salva (${r.saved} procedimento(s) com valor).`); this.prices.set(null); this.loadInsurers(); } catch (e) { this.toast.error(e); }
  }

  // lote
  readonly batchOpen = signal(false); bRef = ''; bProtocol = ''; bNotes = '';
  openBatch() {
    const ins = new Set(Object.values(this.sel()).map((x: any) => x.insurer_id));
    if (ins.size > 1) { this.toast.error('Selecione guias de um único convênio por lote.'); return; }
    this.bRef = todayIso().slice(0, 7); this.bProtocol = ''; this.bNotes = ''; this.batchOpen.set(true);
  }
  async sendBatch() {
    const first: any = Object.values(this.sel())[0];
    try {
      const b: any = await this.api.post('/insurance-batches', { insurerId: first.insurer_id, claimIds: this.selectedIds(), reference: this.bRef || undefined, protocol: this.bProtocol || undefined, notes: this.bNotes || undefined });
      this.toast.success(`Lote nº ${b.number} registrado.`); this.batchOpen.set(false); this.loadClaims(1);
    } catch (e) { this.toast.error(e); }
  }
  // retorno
  readonly settleOpen = signal(false); readonly settleRows = signal<any[]>([]); sDate = todayIso();
  openSettle() { this.settleRows.set(Object.values(this.sel()).map((x: any) => ({ ...x, paid: Number(x.amount), reason: '' }))); this.sDate = todayIso(); this.settleOpen.set(true); }
  async settle() {
    const items = this.settleRows().map((r) => ({ claimId: r.id, paidAmount: Number(r.paid || 0), glossReason: Number(r.paid || 0) < Number(r.amount) ? (r.reason || undefined) : undefined }));
    try { const r: any = await this.api.post('/insurance-claims/settle', { items, paidAt: this.sDate }); this.toast.success(`Retorno registrado: recebido ${r.received.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`); this.settleOpen.set(false); this.loadClaims(1); }
    catch (e) { this.toast.error(e); }
  }
  // guia
  readonly claimEdit = signal<any>(null);
  openClaim(x: any) { this.claimEdit.set({ ...x, amount: Number(x.amount) }); }
  async saveClaim() {
    const x = this.claimEdit();
    try { await this.api.put(`/insurance-claims/${x.id}`, { insuranceCard: x.insurance_card || null, guideNumber: x.guide_number || null, authorizationCode: x.authorization_code || null, tussCode: x.tuss_code || null, amount: Number(x.amount) });
      this.claimEdit.set(null); this.toast.success('Guia corrigida.'); this.loadClaims(this.claims()?.page ?? 1); } catch (e) { this.toast.error(e); }
  }
  async cancelClaim(x: any) {
    const reason = prompt('Motivo do cancelamento da guia (ex.: atendimento lançado por engano):'); if (!reason) return;
    try { await this.api.post(`/insurance-claims/${x.id}/cancel`, { reason }); this.loadClaims(this.claims()?.page ?? 1); } catch (e) { this.toast.error(e); }
  }
}
