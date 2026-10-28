import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { IconComponent } from '../../shared/icon.component';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, addDaysIso, todayIso } from '../../core/format';
import { APPT_STATUS } from '../servicos/agenda.page';
import { VISIT_TYPES } from './saude-shared';

/** Recepção da clínica: chegada do paciente (tempo de espera), chamada para o atendimento, conclusão, cobrança particular ou guia do convênio. */
@Component({
  selector: 'ax-recepcao',
  imports: [IconComponent, NgTemplateOutlet, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .col { background:#F7FAFD; border:1px solid #E3EAF1; border-radius:12px; padding:10px; min-height:120px; }
    .col h3 { font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:#475B6E; display:flex; justify-content:space-between; margin:2px 4px 10px; }
    .pt { background:white; border:1px solid #E3EAF1; border-left:4px solid var(--c,#0875D1); border-radius:10px; padding:10px 12px; margin-bottom:8px; }
    .pt .n { font-weight:700; font-size:13.5px; color:#172B3A; }
    .pt .m { font-size:11.5px; color:#647687; margin-top:2px; }
    .pt .acts { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
    .wait { font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700; padding:1px 6px; border-radius:6px; background:#E8F6EE; color:#18864B; }
    .wait.warn { background:#FFF5E0; color:#B07400; } .wait.late { background:#FDECEC; color:#C93636; }
    .board { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    @media (max-width:1100px) { .board { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:640px) { .board { grid-template-columns:1fr; } }
  `],
  template: `
  <div style="padding:20px 24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="armchair" [size]="20" color="#0875D1" /> Recepção</h1>
        <p style="font-size:13px;color:#647687">Chegada, sala de espera e chamada dos {{ auth.term('clientes').toLowerCase() }} — atualiza a cada 30 segundos</p></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button class="btn-ghost" style="padding:6px" (click)="shift(-1)" aria-label="Dia anterior"><ax-icon name="chevron-left" [size]="16" /></button>
        <input type="date" class="input-field" style="width:150px" [value]="date()" (change)="go($any($event.target).value)" />
        <button class="btn-ghost" style="padding:6px" (click)="shift(1)" aria-label="Próximo dia"><ax-icon name="chevron-right" [size]="16" /></button>
        @if (date() !== today) { <button class="btn-ghost" style="font-size:12px" (click)="go(today)">Hoje</button> }
        @if (auth.can('agenda.editar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigate(['/agenda'], { queryParams: { data: date() } })"><ax-icon name="calendar-plus" [size]="13" /> Agendar / encaixe</button> }
      </div>
    </div>
    <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px">
      <div class="kpi-card"><div class="kpi-l">Agendados no dia</div><div class="kpi-v">{{ active().length }}</div></div>
      <div class="kpi-card"><div class="kpi-l">Na sala de espera</div><div class="kpi-v" style="color:#0875D1">{{ waiting().length }}</div><div class="muted" style="font-size:11.5px">{{ waiting().length ? 'espera máx. ' + maxWait() + ' min' : 'ninguém aguardando' }}</div></div>
      <div class="kpi-card"><div class="kpi-l">Em atendimento</div><div class="kpi-v">{{ inService().length }}</div></div>
      <div class="kpi-card"><div class="kpi-l">Concluídos</div><div class="kpi-v" style="color:#18864B">{{ done().length }}</div><div class="muted" style="font-size:11.5px">{{ toCharge().length }} a cobrar no caixa</div></div>
    </div>
    @if (loaded()) {
      <div class="board">
        <div class="col"><h3>A chegar <span>{{ expected().length }}</span></h3>
          @for (a of expected(); track a.id) { <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ $implicit: a }" /> } @empty { <div class="empty-state" style="font-size:12px">Nenhum.</div> }</div>
        <div class="col"><h3>Sala de espera <span>{{ waiting().length }}</span></h3>
          @for (a of waiting(); track a.id) { <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ $implicit: a }" /> } @empty { <div class="empty-state" style="font-size:12px">Ninguém aguardando.</div> }</div>
        <div class="col"><h3>Em atendimento <span>{{ inService().length }}</span></h3>
          @for (a of inService(); track a.id) { <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ $implicit: a }" /> } @empty { <div class="empty-state" style="font-size:12px">Nenhum.</div> }</div>
        <div class="col"><h3>Concluídos e faltas <span>{{ done().length + missed().length }}</span></h3>
          @for (a of done().concat(missed()); track a.id) { <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ $implicit: a }" /> } @empty { <div class="empty-state" style="font-size:12px">Nenhum.</div> }</div>
      </div>
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:160px"></div></div> }
  </div>

  <ng-template #card let-a>
    <div class="pt" [style.--c]="a.color || '#0875D1'">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div class="n">{{ a.start_time }} · {{ a.patient }}</div>
        @if (a.waiting_min !== null && a.waiting_min !== undefined) { <span class="wait" [class.warn]="a.waiting_min >= 15" [class.late]="a.waiting_min >= 30">{{ a.waiting_min }} min</span> }
      </div>
      <div class="m">{{ a.professional }}{{ a.specialty ? ' · ' + a.specialty : '' }}{{ a.room ? ' · ' + a.room : '' }}</div>
      <div class="m">{{ a.services }}</div>
      <div class="m" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
        @if (a.payer === 'convenio') { <span class="badge badge-info">{{ a.insurer_name || 'Convênio' }}</span>
          @if (a.requires_authorization && !a.authorization_code) { <span class="badge badge-warning" title="Este convênio exige autorização prévia">sem autorização</span> } }
        @else if (a.payer === 'cortesia') { <span class="badge badge-muted">Cortesia</span> }
        @else if (a.to_charge > 0) { <span class="badge badge-muted">Particular · {{ a.to_charge | brl }}</span> }
        @if (a.visit_type) { <span class="badge badge-muted">{{ visit(a.visit_type) }}</span> }
        @if (a.status === 'faltou' || a.status === 'cancelado') { <span class="badge" [class]="'badge ' + st(a.status)[1]">{{ st(a.status)[0] }}</span> }
        @if (a.sale_id) { <span class="badge badge-success">Cobrado</span> }
      </div>
      <div class="acts">
        @if (auth.can('agenda.editar')) {
          @if ((a.status === 'agendado' || a.status === 'confirmado') && !a.arrived_at) { <button class="btn-secondary" style="font-size:11.5px" (click)="arrive(a)"><ax-icon name="log-in" [size]="12" /> Chegou</button> }
          @if ((a.status === 'agendado' || a.status === 'confirmado') && a.arrived_at) { <button class="btn-primary" style="font-size:11.5px" (click)="status(a, 'em_atendimento')"><ax-icon name="megaphone" [size]="12" /> Chamar</button> }
          @if (a.status === 'em_atendimento') { <button class="btn-secondary" style="font-size:11.5px" (click)="complete(a)"><ax-icon name="check-check" [size]="12" /> Concluir</button> }
          @if (isPast(a) && (a.status === 'agendado' || a.status === 'confirmado') && !a.arrived_at) { <button class="btn-ghost" style="font-size:11.5px;color:#C93636" (click)="status(a, 'faltou')">Faltou</button> }
        }
        @if (a.payer === 'particular' && a.to_charge > 0 && !a.sale_id && a.status !== 'cancelado' && a.status !== 'faltou' && auth.can('vendas.criar')) {
          <button class="btn-ghost" style="font-size:11.5px;color:#18864B" (click)="router.navigate(['/pdv'], { queryParams: { atendimento: a.id } })"><ax-icon name="scan-barcode" [size]="12" /> Cobrar</button> }
        @if (a.telehealth_url) { <a class="btn-ghost" style="font-size:11.5px" [href]="a.telehealth_url" target="_blank" rel="noopener"><ax-icon name="video" [size]="12" /> Sala</a> }
        @if (a.customer_id && auth.can('prontuario.ver') && auth.has('prontuario')) { <button class="btn-ghost" style="font-size:11.5px" (click)="router.navigateByUrl('/ficha/' + a.customer_id)"><ax-icon name="clipboard-list" [size]="12" /> {{ auth.term('prontuario') }}</button> }
        @else if (a.customer_id && auth.can('clientes.ver')) { <button class="btn-ghost" style="font-size:11.5px" (click)="router.navigateByUrl('/cliente-detail/' + a.customer_id)"><ax-icon name="user" [size]="12" /> Cadastro</button> }
      </div>
    </div>
  </ng-template>`,
})
export class RecepcaoPage implements OnInit, OnDestroy {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly router = inject(Router);
  readonly today = todayIso(); readonly date = signal(todayIso()); readonly items = signal<any[]>([]); readonly loaded = signal(false);
  private timer: any;
  readonly active = computed(() => this.items().filter((a) => a.status !== 'cancelado'));
  readonly expected = computed(() => this.items().filter((a) => (a.status === 'agendado' || a.status === 'confirmado') && !a.arrived_at));
  readonly waiting = computed(() => this.items().filter((a) => (a.status === 'agendado' || a.status === 'confirmado') && a.arrived_at).sort((x, y) => (y.waiting_min ?? 0) - (x.waiting_min ?? 0)));
  readonly inService = computed(() => this.items().filter((a) => a.status === 'em_atendimento'));
  readonly done = computed(() => this.items().filter((a) => a.status === 'concluido'));
  readonly missed = computed(() => this.items().filter((a) => a.status === 'faltou'));
  readonly toCharge = computed(() => this.done().filter((a) => a.payer === 'particular' && a.to_charge > 0 && !a.sale_id));
  readonly maxWait = computed(() => Math.max(0, ...this.waiting().map((a) => a.waiting_min ?? 0)));
  visit(v: string) { return VISIT_TYPES[v] ?? v; }
  st(s: string) { return APPT_STATUS[s] ?? [s, 'badge-muted']; }
  isPast(a: any) { return this.date() < this.today || (this.date() === this.today && a.start_time <= new Date().toTimeString().slice(0, 5)); }
  ngOnInit() { this.load(); this.timer = setInterval(() => { if (!document.hidden) this.load(true); }, 30_000); }
  ngOnDestroy() { clearInterval(this.timer); }
  async load(silent = false) {
    try { const r: any = await this.api.get('/reception', { date: this.date() }); this.items.set(r.items); this.loaded.set(true); } catch (e) { if (!silent) this.toast.error(e); }
  }
  go(d: string) { if (!d) return; this.date.set(d); this.loaded.set(false); this.load(); }
  shift(n: number) { this.go(addDaysIso(this.date(), n)); }
  async arrive(a: any) { try { await this.api.post(`/appointments/${a.id}/arrive`, {}); this.toast.success(`${a.patient} na sala de espera.`); this.load(); } catch (e) { this.toast.error(e); } }
  async status(a: any, status: string) {
    try { await this.api.post(`/appointments/${a.id}/status`, { status, reason: status === 'faltou' ? 'Não compareceu' : undefined }); this.load(); } catch (e) { this.toast.error(e); }
  }
  async complete(a: any) {
    const msg = a.payer === 'convenio' ? 'Concluir e gerar a guia do convênio?' : a.payer === 'particular' && a.to_charge > 0 && !a.sale_id ? 'Concluir agora? O valor pode ser cobrado em seguida pelo botão "Cobrar".' : null;
    if (msg && !confirm(msg)) return;
    try { await this.api.post(`/appointments/${a.id}/complete`, {}, { idempotent: true }); this.toast.success('Atendimento concluído.'); this.load(); } catch (e) { this.toast.error(e); }
  }
}
