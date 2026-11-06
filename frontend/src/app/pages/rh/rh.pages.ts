import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { EntityDocsComponent } from '../../shared/docs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, brl, monthIso } from '../../core/format';

const ST_CLASS: Record<string, string> = { Ativo: 'badge-success', Férias: 'badge-warning', Afastado: 'badge-info', Desligado: 'badge-muted' };

/** Formulário de colaborador reaproveitado na lista e no detalhe. */
@Component({
  selector: 'ax-employee-form',
  imports: [FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-modal [open]="!!value()" (closed)="close()" [title]="f.id ? 'Editar colaborador' : 'Novo colaborador'" icon="user" [width]="620">
    <div class="form-grid-2">
      <div class="span-all"><label class="field-label">Nome completo *</label><input class="input-field" [(ngModel)]="f.name" /></div>
      <div><label class="field-label">CPF</label><input class="input-field mono" [(ngModel)]="f.cpf" maxlength="14" /></div>
      <div><label class="field-label">Status</label><select class="input-field" [(ngModel)]="f.status">@for (s of ['Ativo','Férias','Afastado','Desligado']; track s) { <option>{{ s }}</option> }</select></div>
      <div><label class="field-label">E-mail</label><input type="email" class="input-field" [(ngModel)]="f.email" /></div>
      <div><label class="field-label">Telefone</label><input class="input-field" [(ngModel)]="f.phone" /></div>
      <div><label class="field-label">Cargo</label><input class="input-field" [(ngModel)]="f.job_title" /></div>
      <div><label class="field-label">Departamento</label><input class="input-field" [(ngModel)]="f.department" list="deps" /><datalist id="deps"><option>Loja</option><option>Administrativo</option><option>Financeiro</option><option>Estoque</option></datalist></div>
      <div><label class="field-label">Admissão</label><input type="date" class="input-field" [(ngModel)]="f.admission_date" /></div>
      @if (auth.can('rh.salarios')) { <div><label class="field-label">Salário base</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.salary" /></div> }
      <div><label class="field-label">Filial</label><select class="input-field" [(ngModel)]="f.branch_id"><option [ngValue]="null">—</option>@for (b of lk.data()?.branches ?? []; track b.id) { <option [ngValue]="b.id">{{ b.name }}</option> }</select></div>
      <div><label class="field-label">Usuário do sistema (vendas/comissões)</label><select class="input-field" [(ngModel)]="f.user_id"><option [ngValue]="null">—</option>@for (s of lk.data()?.sellers ?? []; track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }</select></div>
    </div>
    <div footer><button class="btn-secondary" (click)="close()">Cancelar</button><button class="btn-primary" [disabled]="(f.name || '').trim().length < 3" (click)="save()">Salvar</button></div>
  </ax-modal>`,
})
export class EmployeeFormComponent {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly value = input<any>(null); readonly done = input<(saved: boolean) => void>(() => {});
  f: any = {};
  constructor() { this.lk.ensure(); }
  ngOnChanges() { const v = this.value(); if (v) this.f = { status: 'Ativo', branch_id: null, user_id: null, ...v }; }
  close() { this.done()(false); }
  async save() {
    const f = this.f; const body: any = { name: f.name.trim(), cpf: f.cpf || undefined, email: f.email || undefined, phone: f.phone || undefined, job_title: f.job_title || undefined, department: f.department || undefined,
      admission_date: f.admission_date || undefined, status: f.status, branch_id: f.branch_id || undefined, user_id: f.user_id || undefined };
    if (this.auth.can('rh.salarios') && f.salary !== null && f.salary !== undefined && f.salary !== '') body.salary = +f.salary;
    try { if (f.id) await this.api.put('/employees-admin/' + f.id, body); else await this.api.post('/employees-admin', body); this.toast.success('Colaborador salvo.'); this.done()(true); } catch (e) { this.toast.error(e); }
  }
}

@Component({
  selector: 'ax-rh',
  imports: [StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:24px"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Recursos Humanos</h1><p style="font-size:13px;color:#647687">{{ month }} · {{ s()?.active ?? '—' }} colaboradores ativos</p></div>
    <ax-state [loading]="!s()" />
    @if (s()) {
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:20px">
        @for (k of kpis(); track k.label) { <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">{{ k.label }}</div>
          <div [style.color]="k.color" style="font-size:22px;font-weight:700">{{ k.value }}</div><div style="font-size:11px;color:#647687">{{ k.sub }}</div></div> }
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:10px">
        @for (b of quick; track b.label) { <button class="btn-secondary" style="justify-content:center;padding:10px;font-size:13px" (click)="router.navigateByUrl(b.screen)">{{ b.label }}</button> }
      </div>
      <p style="font-size:11px;color:#647687;margin-top:16px">Ponto eletrônico, férias e folha de pagamento oficial são processados no sistema de departamento pessoal / contabilidade. Aqui ficam o cadastro, documentos e o desempenho comercial da equipe.</p>
    }
  </div>`,
})
export class RhPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router);
  readonly s = signal<any>(null); readonly com = signal<any[]>([]);
  readonly month = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^\w/, (c) => c.toUpperCase());
  readonly quick = [{ label: 'Colaboradores', screen: '/colaboradores' }, { label: 'Comissões', screen: '/comissoes' }, { label: 'Metas', screen: '/comissoes' }, { label: 'Usuários e acessos', screen: '/admin-usuarios' }];
  async ngOnInit() { const r: any = await this.api.get('/employees', { size: 1 }); const c: any = await this.api.get('/commissions', { month: monthIso() }).catch(() => null); this.com.set(Array.isArray(c) ? c : []); this.s.set(r.stats); }
  readonly kpis = computed(() => { const s = this.s(); const totalCom = this.com().reduce((a, r) => a + Number(r.commission || 0), 0); return [
    { label: 'Colaboradores ativos', value: s.active, sub: `+${s.hires_month} contratação(ões) no mês`, color: '#0875D1' },
    { label: 'Folha base (salários)', value: s.payroll !== undefined ? brl(s.payroll) : 'restrito', sub: s.payroll !== undefined ? 'soma dos salários cadastrados' : 'requer permissão de salários', color: '#172B3A' },
    { label: 'Férias / afastados', value: `${s.vacation} / ${s.away}`, sub: 'conforme status do cadastro', color: '#D99000' },
    { label: 'Comissões do mês', value: brl(totalCom), sub: 'calculadas nas vendas', color: '#18864B' }]; });
}

@Component({
  selector: 'ax-colaboradores',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, EmployeeFormComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Colaboradores</h1><p style="font-size:12px;color:#647687">{{ st()?.active ?? 0 }} ativos · {{ st()?.vacation ?? 0 }} em férias · {{ st()?.away ?? 0 }} afastados</p></div>
      <input class="input-field" style="width:220px" placeholder="Nome, cargo ou departamento" [(ngModel)]="q" (keyup.enter)="search()" />
      <select class="input-field" style="width:140px" [(ngModel)]="status" (ngModelChange)="search()"><option value="">Todos</option>@for (s of ['Ativo','Férias','Afastado','Desligado']; track s) { <option>{{ s }}</option> }</select>
      @if (auth.can('rh.editar')) { <button class="btn-primary" style="font-size:12px" (click)="form.set({})"><ax-icon name="plus" [size]="13" /> Novo colaborador</button> }
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Nome</th><th>Cargo</th><th>Departamento</th><th>Filial</th><th>Admissão</th><th class="num">Salário</th><th class="num">Vendas no mês</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>@for (c of list.items(); track c.id) {
          <tr><td style="font-weight:500" class="link" (click)="router.navigateByUrl('/colaborador-detail/' + c.id)">{{ c.name }}</td><td style="font-size:12px">{{ c.job_title || '—' }}</td><td>@if (c.department) { <span class="badge badge-muted">{{ c.department }}</span> }</td>
            <td style="font-size:12px">{{ c.branch || '—' }}</td><td class="mono" style="font-size:12px">{{ c.admission_date | dt }}</td><td class="num" style="font-weight:600">{{ c.salary === null ? '•••' : (c.salary | brl) }}</td>
            <td class="num">{{ c.user_id ? (c.sales_month | brl) : '—' }}</td><td><span class="badge" [class]="'badge ' + (ST[c.status] || 'badge-muted')">{{ c.status }}</span></td>
            <td><div style="display:flex;gap:4px"><button class="btn-ghost" style="padding:3px 5px" (click)="router.navigateByUrl('/colaborador-detail/' + c.id)" aria-label="Ver"><ax-icon name="eye" [size]="13" /></button>
              @if (auth.can('rh.editar')) { <button class="btn-ghost" style="padding:3px 5px" (click)="edit(c)" aria-label="Editar"><ax-icon name="pencil" [size]="13" /></button> }</div></td></tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum colaborador cadastrado." emptyIcon="users" />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-employee-form [value]="form()" [done]="onDone" />`,
})
export class ColaboradoresPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService);
  readonly ST = ST_CLASS; readonly form = signal<any>(null); q = ''; status = '';
  readonly list = new ListState<any>((q) => this.api.get('/employees', q));
  readonly st = computed(() => this.list.extra()?.stats);
  readonly onDone = (saved: boolean) => { this.form.set(null); if (saved) this.list.reload(); };
  ngOnInit() { this.list.load(); }
  search() { this.list.query = { q: this.q || undefined, status: this.status || undefined }; this.list.load(1); }
  async edit(c: any) { try { this.form.set(await this.api.get('/employees-admin/' + c.id)); } catch { this.form.set({ ...c }); } }
}

@Component({
  selector: 'ax-colaborador-detail',
  imports: [IconComponent, StateComponent, EmployeeFormComponent, EntityDocsComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-state [loading]="!e() && !err()" [error]="err()" />
  @if (e(); as e) {
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#0875D1,#00A6D6);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:white">{{ initials() }}</div>
        <div style="flex:1"><div style="display:flex;align-items:center;gap:10px"><h1 style="font-size:17px;font-weight:700;color:#172B3A">{{ e.name }}</h1><span class="badge" [class]="'badge ' + (ST[e.status] || 'badge-muted')">{{ e.status }}</span></div>
          <p style="font-size:12px;color:#647687">{{ e.job_title || 'Cargo não informado' }} · {{ e.department || '—' }} @if (e.admission_date) { · Admissão em {{ e.admission_date | dt }} }</p></div>
        @if (auth.can('rh.editar')) { <button class="btn-ghost" style="font-size:12px" (click)="form.set(e)"><ax-icon name="pencil" [size]="13" /> Editar</button> }
      </div>
      <div style="display:flex;gap:0;border-bottom:1px solid #DCE4EC;margin-bottom:-1px;overflow-x:auto">
        @for (t of tabs; track t; let i = $index) { <div class="tab-item" [class.active]="tab() === i" (click)="tab.set(i)">{{ t }}</div> }
      </div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:24px">
      @switch (tab()) {
        @case (0) {
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="card" style="padding:20px"><div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:14px">Dados Pessoais</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">@for (r of [['Nome completo', e.name], ['CPF', (e.cpf | doc) || '—']]; track r[0]) { <div><div class="lbl">{{ r[0] }}</div><div style="font-size:13px">{{ r[1] }}</div></div> }</div></div>
            <div class="card" style="padding:20px"><div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:14px">Contato</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">@for (r of [['E-mail', e.email || '—'], ['Telefone', (e.phone | phone) || '—']]; track r[0]) { <div><div class="lbl">{{ r[0] }}</div><div style="font-size:13px">{{ r[1] }}</div></div> }</div></div>
          </div>
        }
        @case (1) {
          <div class="card" style="padding:20px;max-width:600px"><div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:14px">Dados do Contrato</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              @for (r of contract(); track r[0]) { <div><div class="lbl">{{ r[0] }}</div><div style="font-size:13px;font-weight:600">{{ r[1] }}</div></div> }
            </div></div>
        }
        @case (2) {
          @if (!e.user_id) { <div class="state-info" style="margin:0"><ax-icon name="info" [size]="14" />Vincule um usuário do sistema ao colaborador para acompanhar vendas e comissões.</div> }
          @else {
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;max-width:720px">
              <div class="kpi-card"><div class="lbl">Vendas no mês</div><div style="font-size:20px;font-weight:700">{{ e.sales_month | brl }}</div></div>
              <div class="kpi-card"><div class="lbl">Comissão do mês</div><div style="font-size:20px;font-weight:700;color:#18864B">{{ com()?.commission ?? 0 | brl }}</div></div>
              <div class="kpi-card"><div class="lbl">Nº de vendas</div><div style="font-size:20px;font-weight:700">{{ com()?.sales ?? 0 }}</div></div>
            </div>
            <button class="btn-secondary" style="margin-top:12px;font-size:12px" (click)="router.navigate(['/pedidos'], { queryParams: { seller: e.user_id } })">Ver vendas do colaborador</button>
          }
        }
        @case (3) { <div style="max-width:720px"><ax-entity-docs entity="colaborador" [entityId]="e.id" folder="RH" /></div> }
        @case (4) {
          <div class="card" style="padding:16px;max-width:720px">
            @for (a of hist(); track a.id) { <div style="font-size:12px;padding:6px 0;border-bottom:1px solid #F0F4F8"><span class="mono muted">{{ a.created_at | dtt }}</span> · {{ a.user_name }} · <b>{{ a.action }}</b></div> }
            @empty { <div class="empty-state">Sem alterações registradas.</div> }
          </div>
        }
      }
    </div>
  </div>
  <ax-employee-form [value]="form()" [done]="onDone" />
  }`,
  styles: [`.lbl { font-size:10px; font-weight:600; color:#647687; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:2px; }`],
})
export class ColaboradorDetailPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private lk = inject(LookupsService);
  readonly id = input.required<string>();
  readonly ST = ST_CLASS; readonly tabs = ['Dados Pessoais', 'Contrato', 'Desempenho comercial', 'Documentos', 'Histórico'];
  readonly e = signal<any>(null); readonly err = signal<string | null>(null); readonly tab = signal(0); readonly form = signal<any>(null); readonly hist = signal<any[]>([]); readonly com = signal<any>(null);
  readonly onDone = (saved: boolean) => { this.form.set(null); if (saved) this.load(); };
  readonly initials = computed(() => (this.e()?.name ?? '').split(' ').filter(Boolean).map((p: string) => p[0]).slice(0, 2).join('').toUpperCase());
  readonly contract = computed(() => { const e = this.e(); const br = this.lk.data()?.branches.find((b) => b.id === e.branch_id)?.name;
    return [['Admissão', e.admission_date ? e.admission_date.split('-').reverse().join('/') : '—'], ['Cargo', e.job_title || '—'], ['Departamento', e.department || '—'], ['Filial', br || '—'],
      ['Salário base', this.auth.can('rh.salarios') ? (e.salary !== null && e.salary !== undefined ? brl(e.salary) : '—') : 'restrito'], ['Usuário do sistema', this.lk.data()?.sellers.find((s) => s.id === e.user_id)?.name || (e.user_id ? 'vinculado' : '—')]]; });
  ngOnInit() { this.lk.ensure(); this.load(); }
  async load() {
    try {
      const e: any = await this.api.get('/employees-admin/' + this.id());
      if (!this.auth.can('rh.salarios')) e.salary = null;
      const list: any = await this.api.get('/employees', { q: e.name, size: 5 }); e.sales_month = list.items.find((x: any) => x.id === e.id)?.sales_month ?? 0;
      this.e.set(e);
      if (e.user_id && this.auth.can('comissoes.ver')) this.api.get<any>('/commissions', { month: monthIso() }).then((c) => this.com.set((Array.isArray(c) ? c : []).find((r: any) => r.seller_id === e.user_id) ?? null)).catch(() => {});
      if (this.auth.can('auditoria.ver')) this.api.get<any>('/audit', { entity: 'colaborador', entityId: e.id, size: 50 }).then((r) => this.hist.set(r.items)).catch(() => {});
    } catch (x: any) { this.err.set(x.message); }
  }
}
