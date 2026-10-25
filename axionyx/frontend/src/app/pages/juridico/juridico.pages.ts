import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { EntityDocsComponent } from '../../shared/docs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, brl, todayIso } from '../../core/format';

/** Classificação de perda conforme prática contábil (CPC 25): provável → provisionar; possível → divulgar; remota → sem registro. */
const RISK: Record<string, { label: string; cls: string; treatment: string }> = {
  Alto: { label: 'Provável', cls: 'badge-danger', treatment: 'Provisionar' }, Médio: { label: 'Possível', cls: 'badge-warning', treatment: 'Divulgar em nota' }, Baixo: { label: 'Remota', cls: 'badge-muted', treatment: 'Sem registro' },
};
const daysTo = (d: string | null) => (d ? Math.round((new Date(d + 'T12:00:00').getTime() - new Date(todayIso() + 'T12:00:00').getTime()) / 86400000) : null);

@Component({
  selector: 'ax-legal-form',
  imports: [FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-modal [open]="!!value()" (closed)="done()(false)" [title]="f.id ? 'Editar processo' : 'Novo processo'" icon="scale" [width]="640">
    <div class="form-grid-2">
      <div><label class="field-label">Número (CNJ) *</label><input class="input-field mono" [(ngModel)]="f.number" placeholder="0000000-00.0000.0.00.0000" /></div>
      <div><label class="field-label">Tipo *</label><input class="input-field" [(ngModel)]="f.kind" list="kinds" /><datalist id="kinds"><option>Cível</option><option>Trabalhista</option><option>Tributário</option><option>Consumidor</option><option>Administrativo</option></datalist></div>
      <div class="span-all"><label class="field-label">Título / objeto *</label><input class="input-field" [(ngModel)]="f.title" /></div>
      <div><label class="field-label">Tribunal / vara</label><input class="input-field" [(ngModel)]="f.court" /></div>
      <div><label class="field-label">Parte contrária</label><input class="input-field" [(ngModel)]="f.counterpart" /></div>
      <div><label class="field-label">Advogado / escritório</label><input class="input-field" [(ngModel)]="f.lawyer" /></div>
      <div><label class="field-label">Status</label><input class="input-field" [(ngModel)]="f.status" list="sts" /><datalist id="sts"><option>Em andamento</option><option>Aguardando audiência</option><option>Recurso</option><option>Acordo</option><option>Encerrado</option></datalist></div>
      <div><label class="field-label">Valor da causa</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.amount" /></div>
      <div><label class="field-label">Probabilidade de perda</label><select class="input-field" [(ngModel)]="f.risk"><option value="Alto">Provável</option><option value="Médio">Possível</option><option value="Baixo">Remota</option></select></div>
      <div><label class="field-label">Próximo prazo</label><input type="date" class="input-field" [(ngModel)]="f.next_deadline" /></div>
      <div class="span-all"><label class="field-label">Anotações / andamento</label><textarea class="input-field" rows="4" [(ngModel)]="f.notes"></textarea></div>
    </div>
    <div footer><button class="btn-secondary" (click)="done()(false)">Cancelar</button><button class="btn-primary" [disabled]="!f.number || !f.title || !f.kind" (click)="save()">Salvar</button></div>
  </ax-modal>`,
})
export class LegalFormComponent {
  private api = inject(Api); private toast = inject(ToastService);
  readonly value = input<any>(null); readonly done = input<(saved: boolean) => void>(() => {});
  f: any = {};
  ngOnChanges() { const v = this.value(); if (v) this.f = { status: 'Em andamento', risk: 'Médio', amount: 0, ...v }; }
  async save() {
    const f = this.f; const body = { number: f.number.trim(), title: f.title.trim(), kind: f.kind.trim(), court: f.court || undefined, counterpart: f.counterpart || undefined, status: f.status || undefined, risk: f.risk,
      amount: +f.amount || 0, next_deadline: f.next_deadline || undefined, lawyer: f.lawyer || undefined, notes: f.notes || undefined };
    try { if (f.id) await this.api.put('/legal-cases/' + f.id, body); else await this.api.post('/legal-cases', body); this.toast.success('Processo salvo.'); this.done()(true); } catch (e) { this.toast.error(e); }
  }
}

@Component({
  selector: 'ax-juridico',
  imports: [IconComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:24px"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Jurídico</h1><p style="font-size:13px;color:#647687">Gestão de processos, prazos e riscos legais</p></div>
    <ax-state [loading]="!rows()" />
    @if (rows()) {
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:20px">
        @for (k of kpis(); track k.label) { <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl('/processos')"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">{{ k.label }}</div>
          <div [style.color]="k.color" style="font-size:20px;font-weight:700">{{ k.value }}</div><div style="font-size:11px;color:#647687">{{ k.sub }}</div></div> }
      </div>
      <div style="display:flex;gap:10px;margin-bottom:20px"><button class="btn-secondary" style="font-size:13px" (click)="router.navigateByUrl('/processos')">Ver processos</button><button class="btn-secondary" style="font-size:13px" (click)="router.navigateByUrl('/documentos')"><ax-icon name="folder" [size]="13" /> Documentos</button></div>
      @if (upcoming().length) {
        <div class="card" style="overflow:hidden;max-width:820px"><div style="padding:12px 16px;font-size:13px;font-weight:600">Prazos nos próximos 30 dias</div>
          @for (p of upcoming(); track p.id) { <div class="clickable" style="display:flex;gap:10px;align-items:center;padding:10px 16px;border-top:1px solid #F0F4F8;font-size:13px" (click)="router.navigateByUrl('/processo-detail/' + p.id)">
            <span class="badge" [class]="p.d <= 3 ? 'badge badge-danger' : p.d <= 7 ? 'badge badge-warning' : 'badge badge-muted'">{{ p.d === 0 ? 'hoje' : p.d < 0 ? 'vencido' : p.d + ' dia(s)' }}</span>
            <span class="mono" style="font-size:12px">{{ p.next_deadline.split('-').reverse().join('/') }}</span><span style="flex:1">{{ p.title }}</span><span class="muted" style="font-size:12px">{{ p.lawyer }}</span></div> }
        </div>
      }
    }
  </div>`,
})
export class JuridicoPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router);
  readonly rows = signal<any[] | null>(null);
  async ngOnInit() { const r: any = await this.api.get('/legal-cases', { size: 500 }); this.rows.set(r.items); }
  readonly active = computed(() => (this.rows() ?? []).filter((p) => p.status !== 'Encerrado'));
  readonly upcoming = computed(() => this.active().map((p) => ({ ...p, d: daysTo(p.next_deadline) })).filter((p) => p.d !== null && p.d <= 30).sort((a, b) => a.d! - b.d!));
  readonly kpis = computed(() => { const a = this.active(); const prov = a.filter((p) => p.risk === 'Alto').reduce((s, p) => s + Number(p.amount), 0); const poss = a.filter((p) => p.risk === 'Médio').reduce((s, p) => s + Number(p.amount), 0);
    return [
      { label: 'Processos ativos', value: a.length, sub: `${a.filter((p) => /audi/i.test(p.status)).length} aguardando audiência`, color: '#C93636' },
      { label: 'Provisão sugerida', value: brl(prov), sub: 'perda provável (valor da causa)', color: '#D99000' },
      { label: 'Passivo possível', value: brl(poss), sub: 'divulgação em nota explicativa', color: '#0875D1' },
      { label: 'Prazos próximos', value: this.upcoming().filter((p) => p.d! <= 7).length, sub: 'nos próximos 7 dias', color: '#C93636' }]; });
}

@Component({
  selector: 'ax-processos',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, LegalFormComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Processos Judiciais</h1><p style="font-size:12px;color:#647687">{{ list.total() }} processo(s)</p></div>
      <input class="input-field" style="width:240px" placeholder="Número, título ou parte" [(ngModel)]="q" (keyup.enter)="search()" />
      @if (auth.can('juridico.editar')) { <button class="btn-primary" style="font-size:12px" (click)="form.set({})"><ax-icon name="plus" [size]="13" /> Novo processo</button> }
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Número</th><th>Objeto</th><th>Tipo</th><th>Tribunal</th><th>Parte Contrária</th><th>Advogado</th><th class="num">Valor Causa</th><th>Probabilidade</th><th>Próx. prazo</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>@for (p of list.items(); track p.id) {
          <tr><td class="mono" style="font-size:10px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0875D1">{{ p.number }}</td><td style="font-size:12px;max-width:220px">{{ p.title }}</td><td><span class="badge badge-muted">{{ p.kind }}</span></td>
            <td style="font-size:12px">{{ p.court || '—' }}</td><td style="font-size:12px">{{ p.counterpart || '—' }}</td><td style="font-size:12px">{{ p.lawyer || '—' }}</td><td class="num">{{ p.amount | brl }}</td>
            <td><span class="badge" [class]="'badge ' + R[p.risk]?.cls">{{ R[p.risk]?.label }}</span></td>
            <td class="mono" style="font-size:12px" [style.color]="dl(p) !== null && dl(p)! <= 7 ? '#C93636' : null">{{ p.next_deadline | dt }}</td>
            <td><span class="badge" [class]="p.status === 'Encerrado' ? 'badge badge-muted' : 'badge badge-info'">{{ p.status }}</span></td>
            <td><button class="btn-ghost" style="padding:3px 6px" (click)="router.navigateByUrl('/processo-detail/' + p.id)" aria-label="Ver"><ax-icon name="eye" [size]="13" /></button></td></tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum processo cadastrado." emptyIcon="scale" />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-legal-form [value]="form()" [done]="onDone" />`,
})
export class ProcessosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService);
  readonly R = RISK; readonly form = signal<any>(null); q = '';
  readonly list = new ListState<any>((q) => this.api.get('/legal-cases', q));
  readonly onDone = (saved: boolean) => { this.form.set(null); if (saved) this.list.reload(); };
  dl(p: any) { return daysTo(p.next_deadline); }
  ngOnInit() { this.list.load(); }
  search() { this.list.query = { q: this.q || undefined }; this.list.load(1); }
}

@Component({
  selector: 'ax-processo-detail',
  imports: [IconComponent, StateComponent, LegalFormComponent, EntityDocsComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-state [loading]="!p() && !err()" [error]="err()" />
  @if (p(); as p) {
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC">
      <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:14px">
        <div style="width:44px;height:44px;background:#FCEAEA;border-radius:10px;display:flex;align-items:center;justify-content:center"><ax-icon name="scale" [size]="22" color="#C93636" /></div>
        <div style="flex:1"><div style="display:flex;align-items:center;gap:10px"><h1 style="font-size:16px;font-weight:700;color:#172B3A">{{ p.title }}</h1><span class="badge" [class]="p.status === 'Encerrado' ? 'badge badge-muted' : 'badge badge-warning'">{{ p.status }}</span></div>
          <p class="mono" style="font-size:11px;color:#647687">{{ p.number }} · {{ p.court || 'tribunal não informado' }}</p></div>
        @if (auth.can('juridico.editar')) { <button class="btn-ghost" style="font-size:12px" (click)="form.set(p)"><ax-icon name="pencil" [size]="13" /> Editar</button> }
      </div>
      <div style="display:flex;gap:0;border-bottom:1px solid #DCE4EC;margin-bottom:-1px">@for (t of tabs; track t; let i = $index) { <div class="tab-item" [class.active]="tab() === i" (click)="tab.set(i)">{{ t }}</div> }</div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:24px">
      @switch (tab()) {
        @case (0) {
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="card" style="padding:18px"><div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:14px">Dados do Processo</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                @for (r of data(); track r[0]) { <div><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">{{ r[0] }}</div><div style="font-size:13px;color:#172B3A;font-weight:600">{{ r[1] }}</div></div> }
              </div></div>
            <div class="card" style="padding:18px"><div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:14px">Próximo Prazo</div>
              @if (p.next_deadline) { <div style="display:flex;justify-content:space-between;align-items:center"><span class="mono" style="font-size:16px;font-weight:700">{{ p.next_deadline | dt }}</span>
                <span class="badge" [class]="d()! <= 3 ? 'badge badge-danger' : d()! <= 7 ? 'badge badge-warning' : 'badge badge-muted'">{{ d()! < 0 ? 'vencido há ' + (-d()!) + ' dia(s)' : d() === 0 ? 'hoje' : 'em ' + d() + ' dia(s)' }}</span></div> }
              @else { <div class="muted" style="font-size:13px">Nenhum prazo cadastrado.</div> }
              <div style="font-size:12px;font-weight:700;color:#172B3A;margin:18px 0 8px">Tratamento contábil sugerido</div>
              <div style="font-size:13px">{{ R[p.risk]?.treatment }} — perda {{ R[p.risk]?.label.toLowerCase() }} @if (p.risk !== 'Baixo') { ({{ p.amount | brl }}) }</div>
              <div class="muted" style="font-size:11px;margin-top:4px">Critério CPC 25: provável → provisão; possível → divulgação; remota → sem registro. Confirme com o advogado responsável.</div>
            </div>
          </div>
        }
        @case (1) { <div class="card" style="padding:18px;max-width:820px;white-space:pre-wrap;font-size:13px;line-height:1.6">{{ p.notes || 'Sem anotações. Use "Editar" para registrar o andamento.' }}</div> }
        @case (2) { <div style="max-width:820px"><ax-entity-docs entity="processo" [entityId]="p.id" folder="Jurídico" /></div> }
        @case (3) { <div class="card" style="padding:16px;max-width:820px">@for (a of hist(); track a.id) { <div style="font-size:12px;padding:6px 0;border-bottom:1px solid #F0F4F8"><span class="mono muted">{{ a.created_at | dtt }}</span> · {{ a.user_name }} · <b>{{ a.action }}</b></div> } @empty { <div class="empty-state">Sem histórico.</div> }</div> }
      }
    </div>
  </div>
  <ax-legal-form [value]="form()" [done]="onDone" />
  }`,
})
export class ProcessoDetailPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService);
  readonly id = input.required<string>();
  readonly R = RISK; readonly tabs = ['Resumo', 'Andamento / anotações', 'Documentos', 'Histórico'];
  readonly p = signal<any>(null); readonly err = signal<string | null>(null); readonly tab = signal(0); readonly form = signal<any>(null); readonly hist = signal<any[]>([]);
  readonly onDone = (saved: boolean) => { this.form.set(null); if (saved) this.load(); };
  readonly d = computed(() => daysTo(this.p()?.next_deadline));
  readonly data = computed(() => { const p = this.p(); return [['Parte contrária', p.counterpart || '—'], ['Advogado resp.', p.lawyer || '—'], ['Valor da causa', brl(p.amount)], ['Probabilidade de perda', RISK[p.risk]?.label], ['Tipo', p.kind], ['Cadastrado em', new Date(p.created_at).toLocaleDateString('pt-BR')]]; });
  ngOnInit() { this.load(); }
  async load() {
    try { const p: any = await this.api.get('/legal-cases/' + this.id()); this.p.set(p);
      if (this.auth.can('auditoria.ver')) this.api.get<any>('/audit', { entity: 'processo', entityId: p.id, size: 50 }).then((r) => this.hist.set(r.items)).catch(() => {}); }
    catch (e: any) { this.err.set(e.message); }
  }
}
