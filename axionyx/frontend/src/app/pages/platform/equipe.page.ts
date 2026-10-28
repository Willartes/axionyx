import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, initials } from '../../core/format';
import { AccessChoiceComponent, AccessDialogComponent, AccessDelivery, deliveryBody } from '../../shared/access';

interface Perm { key: string; group: string; label: string; description: string }
const PRESETS: { id: string; label: string; desc: string; perms: string[] }[] = [
  { id: 'n1', label: 'Suporte (consulta)', desc: 'Entra nas empresas só para ver e orientar', perms: ['suporte.acessar'] },
  { id: 'n2', label: 'Suporte completo', desc: 'Entra e corrige dados nas empresas', perms: ['suporte.acessar', 'suporte.editar'] },
  { id: 'com', label: 'Comercial', desc: 'Propostas e acompanhamento da carteira', perms: ['carteira.ver', 'carteira.propostas'] },
  { id: 'fin', label: 'Financeiro', desc: 'Cobranças, baixas, estornos e suspensões', perms: ['carteira.ver', 'carteira.financeiro'] },
  { id: 'aud', label: 'Auditor', desc: 'Aprova propostas e resolve a fila', perms: ['carteira.ver', 'carteira.aprovar'] },
];

/** Equipe da plataforma: proprietários e agentes operacionais com permissões limitadas. */
@Component({
  selector: 'ax-equipe',
  imports: [FormsModule, IconComponent, ModalComponent, StateComponent, AccessChoiceComponent, AccessDialogComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .member { display:flex; gap:14px; align-items:flex-start; padding:14px 16px; border-bottom:1px solid #EEF2F6; }
    .member:last-child { border-bottom:0; }
    .av { width:40px; height:40px; border-radius:50%; display:grid; place-items:center; color:#fff; font-weight:700; font-size:14px; flex:none; }
    .pchips { display:flex; flex-wrap:wrap; gap:5px; margin-top:6px; }
    .pchip { font-size:11px; padding:2px 8px; border-radius:999px; background:#EEF4FB; color:#0B4F8A; }
    .grp { font-size:11px; font-weight:700; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin:12px 0 6px; }
    .perm { display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border:1px solid #E3EAF1; border-radius:8px; margin-bottom:6px; cursor:pointer; }
    .perm.on { border-color:#0875D1; background:#F3F8FD; }
    .perm.off { opacity:.45; cursor:not-allowed; }
    .acts { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    .secret { font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:700; background:#F1F4F7; padding:10px 12px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; gap:8px; }
    @media (max-width:760px) { .member { flex-wrap:wrap; } .acts { width:100%; justify-content:stretch; } .acts > * { flex:1; justify-content:center; } }
  `],
  template: `
  <div style="padding:24px;max-width:1100px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A">Equipe da Plataforma</h1>
        <p style="font-size:13px;color:#647687">Superadministradores do AXIONYX. Agentes recebem só as permissões necessárias e <b>nunca aparecem nem contam como usuários</b> das empresas clientes.</p></div>
      <button class="btn-primary" (click)="openNew()"><ax-icon name="plus" [size]="13" /> Novo membro</button>
    </div>
    <div class="card" style="overflow:hidden">
      <ax-state [loading]="loading()" />
      @for (m of team(); track m.id) {
        <div class="member" [style.opacity]="m.active ? 1 : .55">
          <div class="av" [style.background]="m.platform_owner ? 'linear-gradient(135deg,#0A3D8F,#00B4D8)' : '#647687'">{{ ini(m.name) }}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><b style="font-size:13.5px">{{ m.name }}</b>
              @if (m.platform_owner) { <span class="badge badge-info">Proprietário</span> } @else { <span class="badge badge-muted">{{ m.platform_title || 'Agente' }}</span> }
              @if (!m.active) { <span class="badge badge-danger">Desativado</span> }
              @if (m.id === me()) { <span class="badge badge-cyan">Você</span> }
              @if (m.must_change_password) { <span class="badge badge-warning">Senha temporária</span> }
              @if (m.pending_activation) { <span class="badge badge-warning">Aguardando ativação</span> }
              @if (m.last_email?.status === 'erro') { <span class="badge badge-danger" [title]="m.last_email.error">E-mail não enviado</span> }
              @if (!m.mfa_enabled) { <span class="badge badge-warning" title="Recomendado ativar a verificação em duas etapas">Sem MFA</span> }</div>
            <div style="font-size:12.5px;color:#4A5B6B;margin-top:2px">{{ m.email }} · último acesso {{ m.last_seen_at ? (m.last_seen_at | dtt) : 'nunca' }}{{ m.active_sessions ? ' · ' + m.active_sessions + ' sessão(ões) ativa(s)' : '' }}</div>
            <div class="muted" style="font-size:11.5px">Empresa base: {{ m.companies || '—' }}{{ m.created_by_name ? ' · cadastrado por ' + m.created_by_name : '' }}</div>
            <div class="pchips">
              @if (m.platform_owner) { <span class="pchip">Acesso total</span> }
              @else { @for (k of m.platform_permissions; track k) { <span class="pchip">{{ label(k) }}</span> } @empty { <span class="pchip" style="background:#F1F4F7;color:#647687">Sem permissões</span> } }
            </div>
          </div>
          @if (m.id !== me() && (!m.platform_owner || owner())) {
            <div class="acts">
              <button class="btn-secondary" style="font-size:12px" (click)="openEdit(m)">Permissões</button>
              <button class="btn-ghost" style="font-size:12px" (click)="activity(m)">Atividade</button>
              <button class="btn-ghost" style="font-size:12px" (click)="resetPw(m)">{{ m.pending_activation ? 'Reenviar convite' : 'Acesso / senha' }}</button>
              @if (m.mfa_enabled) { <button class="btn-ghost" style="font-size:12px" (click)="resetMfa(m)">Zerar MFA</button> }
              <button class="btn-ghost" style="font-size:12px" [style.color]="m.active ? '#C93636' : '#18864B'" (click)="toggle(m)">{{ m.active ? 'Desativar' : 'Reativar' }}</button>
            </div>
          }
        </div>
      }
    </div>
    <div class="card" style="padding:12px 16px;margin-top:12px;font-size:12.5px;color:#4A5B6B;display:flex;gap:8px">
      <ax-icon name="shield-check" [size]="15" color="#18864B" />
      <span>Toda ação da equipe fica na auditoria com nome, empresa e horário. Para trocar a <b>sua</b> senha ou ativar a verificação em duas etapas, use o menu do seu nome › Minha senha e segurança.</span>
    </div>
  </div>

  <ax-modal [(open)]="formOpen" [title]="f.id ? 'Permissões de ' + f.name : 'Novo membro da equipe'" icon="user-cog" [width]="720">
    <div class="form-grid-2">
      <div><label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="f.name" /></div>
      <div><label class="field-label">Função (aparece para a equipe)</label><input class="input-field" [(ngModel)]="f.title" placeholder="Ex.: Suporte N1" /></div>
      @if (!f.id) {
        <div><label class="field-label">E-mail (login) *</label><input class="input-field" type="email" [(ngModel)]="f.email" /></div>
        <div><label class="field-label">Empresa base</label><select class="input-field" [(ngModel)]="f.baseCompanyId">@for (c of companies(); track c.id) { <option [value]="c.id">{{ c.trade_name || c.name }}</option> }</select>
          <div class="muted" style="font-size:11px;margin-top:2px">Onde entra quando não tiver acesso às empresas clientes.</div></div>
      }
    </div>
    @if (owner()) { <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:12px"><input type="checkbox" [(ngModel)]="f.owner" /> <b>Proprietário</b> — acesso total à plataforma, inclusive gerenciar outros proprietários</label> }
    @if (!f.owner) {
      <div class="grp">Modelos rápidos</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">@for (p of presets; track p.id) { <span class="chip" [title]="p.desc" (click)="preset(p.perms)">{{ p.label }}</span> }</div>
      @for (g of groups(); track g[0]) {
        <div class="grp">{{ g[0] }}</div>
        @for (p of g[1]; track p.key) {
          <div class="perm" [class.on]="f.perms.has(p.key)" [class.off]="!grantable(p.key) && !f.perms.has(p.key)" (click)="togglePerm(p.key)">
            <input type="checkbox" [checked]="f.perms.has(p.key)" [disabled]="!grantable(p.key) && !f.perms.has(p.key)" style="margin-top:2px" />
            <div><b style="font-size:12.5px">{{ p.label }}</b><div class="muted" style="font-size:11.5px">{{ p.description }}</div></div>
          </div>
        }
      }
      <div class="muted" style="font-size:11.5px;margin-top:6px">Permissões esmaecidas: você não pode conceder o que não tem. Alterações derrubam as sessões do membro para valerem na hora.</div>
    }
    @if (!f.id) { <div style="margin-top:12px"><ax-access-choice [(delivery)]="delivery" [(password)]="manualPwd" /></div> }
    <div footer><button class="btn-secondary" (click)="formOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="save()" [disabled]="busy()">{{ f.id ? 'Salvar' : 'Cadastrar' }}</button></div>
  </ax-modal>

  <ax-access-dialog [(open)]="accOpen" [user]="accUser()" [endpoint]="accEndpoint()" [result]="accResult()" (done)="load()" />

  <ax-modal [(open)]="actOpen" [title]="'Atividade de ' + (actFor()?.name || '')" icon="scroll-text" [width]="720">
    <div style="overflow-x:auto"><table class="data-table no-cards" style="width:100%;border-collapse:collapse"><thead><tr><th>Quando</th><th>Ação</th><th>Empresa</th><th>IP</th></tr></thead>
      <tbody>@for (a of acts(); track a.id) { <tr><td class="mono" style="font-size:11.5px">{{ a.created_at | dtt }}</td><td style="font-size:12px">{{ a.action }}</td><td style="font-size:12px">{{ a.company || '—' }}</td><td class="mono" style="font-size:11px">{{ a.ip || '—' }}</td></tr> }
      @empty { <tr><td colspan="4"><div class="empty-state">Nenhuma ação registrada.</div></td></tr> }</tbody></table></div>
  </ax-modal>`,
})
export class EquipePage implements OnInit {
  private api = inject(Api); private auth = inject(AuthService); private toast = inject(ToastService);
  readonly team = signal<any[]>([]); readonly perms = signal<Perm[]>([]); readonly companies = signal<any[]>([]); readonly loading = signal(true); readonly busy = signal(false);
  readonly formOpen = signal(false); readonly pwOpen = signal(false); readonly actOpen = signal(false);
  readonly pw = signal(''); readonly pwFor = signal('');
  readonly accOpen = signal(false); readonly accUser = signal<any>(null); readonly accEndpoint = signal<string | null>(null); readonly accResult = signal<any>(null);
  readonly delivery = signal<AccessDelivery>('senha'); readonly manualPwd = signal(''); readonly actFor = signal<any>(null); readonly acts = signal<any[]>([]);
  readonly presets = PRESETS;
  f: any = { perms: new Set<string>() };
  readonly me = () => this.auth.me()?.user?.id;
  readonly owner = () => !!this.auth.me()?.platform?.owner;
  readonly groups = computed(() => { const m = new Map<string, Perm[]>(); for (const p of this.perms()) m.set(p.group, [...(m.get(p.group) ?? []), p]); return [...m.entries()]; });
  ini = initials;
  label(k: string) { return this.perms().find((p) => p.key === k)?.label ?? k; }
  grantable(k: string) { return this.auth.pcan(k); }
  ngOnInit() {
    this.load();
    this.api.get<Perm[]>('/platform/permissions').then((p) => this.perms.set(p), () => {});
    this.companies.set(this.auth.me()?.companies ?? []);
  }
  async load() { this.loading.set(true); try { this.team.set(await this.api.get('/platform/team')); } catch (e) { this.toast.error(e); } finally { this.loading.set(false); } }
  openNew() { this.f = { name: '', title: '', email: '', owner: false, baseCompanyId: this.auth.me()?.company?.id, perms: new Set<string>() }; this.manualPwd.set(''); this.formOpen.set(true); }
  openEdit(m: any) { this.f = { id: m.id, name: m.name, title: m.platform_title || '', owner: m.platform_owner, perms: new Set<string>(m.platform_permissions), original: new Set<string>(m.platform_permissions) }; this.formOpen.set(true); }
  togglePerm(k: string) {
    const s = new Set<string>(this.f.perms);
    if (s.has(k)) s.delete(k); else if (this.grantable(k)) s.add(k);
    if (k === 'suporte.editar' && s.has(k)) s.add('suporte.acessar');
    if (k !== 'carteira.ver' && k.startsWith('carteira.') && s.has(k)) s.add('carteira.ver');
    this.f = { ...this.f, perms: s };
  }
  preset(list: string[]) { this.f = { ...this.f, perms: new Set(list.filter((k) => this.grantable(k))) }; }
  async save() {
    const f = this.f; const permissions = [...f.perms] as string[];
    this.busy.set(true);
    try {
      if (f.id) { await this.api.put('/platform/team/' + f.id, { name: f.name, title: f.title || undefined, permissions, ...(this.owner() ? { owner: !!f.owner } : {}) }); this.toast.success('Permissões atualizadas.'); }
      else {
        if (this.delivery() === 'manual' && !this.manualPwd()) { this.toast.error('Informe a senha ou escolha outra forma de acesso.'); return; }
        const r = await this.api.post<any>('/platform/team', { name: f.name, title: f.title || undefined, email: f.email, permissions, owner: !!f.owner, baseCompanyId: f.baseCompanyId || undefined, ...deliveryBody(this.delivery(), this.manualPwd()) });
        if (r.invite || r.temporaryPassword) { this.accUser.set({ name: f.name, email: f.email }); this.accEndpoint.set(null); this.accResult.set(r); this.accOpen.set(true); }
      }
      this.formOpen.set(false); this.load();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  resetPw(m: any) { this.accUser.set(m); this.accResult.set(null); this.accEndpoint.set(`/platform/team/${m.id}/reset-password`); this.accOpen.set(true); }
  async resetMfa(m: any) {
    if (!confirm(`Desativar a verificação em duas etapas de ${m.name}?`)) return;
    try { await this.api.post(`/platform/team/${m.id}/reset-mfa`, {}); this.toast.success('MFA zerado.'); this.load(); } catch (e) { this.toast.error(e); }
  }
  async toggle(m: any) {
    if (m.active && !confirm(`Desativar ${m.name}? Ele perde o acesso imediatamente.`)) return;
    try { await this.api.put('/platform/team/' + m.id, { active: !m.active }); this.toast.success(m.active ? 'Membro desativado.' : 'Membro reativado.'); this.load(); } catch (e) { this.toast.error(e); }
  }
  async activity(m: any) { this.actFor.set(m); this.acts.set([]); this.actOpen.set(true); try { this.acts.set(await this.api.get(`/platform/team/${m.id}/activity`)); } catch (e) { this.toast.error(e); } }
  async copy(t: string) { try { await navigator.clipboard.writeText(t); this.toast.success('Copiado.'); } catch { this.toast.info(t); } }
}
