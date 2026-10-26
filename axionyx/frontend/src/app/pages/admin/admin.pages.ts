import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT } from '../../core/format';

const REGIME: Record<string, string> = { simples: 'Simples Nacional', presumido: 'Lucro Presumido', real: 'Lucro Real', mei: 'MEI' };
const onlyDigits = (s: string) => (s || '').replace(/\D/g, '');

// ─── Empresas e filiais ─────────────────────────────────────────────────────
@Component({
  selector: 'ax-admin-empresas',
  imports: [FormsModule, IconComponent, ModalComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;margin-bottom:20px"><div><h1 style="font-size:20px;font-weight:700;color:#172B3A">Empresas</h1><p style="font-size:13px;color:#647687">{{ companies().length }} empresa(s) acessível(is)</p></div>
      @if (auth.me()?.user?.is_superadmin) { <button class="btn-primary" style="font-size:12px" (click)="newCo()"><ax-icon name="plus" [size]="13" /> Nova empresa</button> }</div>
    <ax-state [loading]="loading()" />
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:14px;margin-bottom:24px">
      @for (e of companies(); track e.id) {
        <div class="card" style="padding:18px" [style.border]="e.id === auth.me()?.company?.id ? '2px solid #0875D1' : null">
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
            <div [style.background]="e.color || '#0875D1'" style="width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center"><ax-icon name="building-2" [size]="22" color="white" /></div>
            <div style="flex:1"><div style="font-size:13px;font-weight:700;color:#172B3A">{{ e.name }}</div><div style="font-size:12px;color:#647687">{{ e.trade_name || '—' }}</div></div>
            <span class="badge" [class]="e.active === false ? 'badge badge-muted' : 'badge badge-success'">{{ e.active === false ? 'Inativa' : 'Ativa' }}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
            @for (r of [['Segmento', segName(e.segment)], ['CNPJ', (e.cnpj | doc)], ['Regime', R[e.tax_regime] || e.tax_regime], ['Filiais', e.branches], ['Usuários', e.users]]; track r[0]) {
              <div style="display:flex;justify-content:space-between"><span style="font-size:12px;color:#647687">{{ r[0] }}</span><span class="mono" style="font-size:12px;font-weight:600">{{ r[1] }}</span></div> }
            @if (e.is_demo) { <span class="badge badge-warning" style="align-self:flex-start">Empresa de demonstração</span> }
          </div>
          @if (e.id === auth.me()?.company?.id) { <button class="btn-secondary" style="font-size:11px;width:100%;justify-content:center" (click)="editCo(e)"><ax-icon name="pencil" [size]="11" /> Editar dados fiscais e endereço</button> }
          @else { <div class="muted" style="font-size:11px;text-align:center">Troque de empresa no topo para editá-la</div> }
        </div>
      }
    </div>
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;display:flex;align-items:center"><div style="flex:1;font-size:13px;font-weight:600">Filiais de {{ auth.me()?.company?.trade_name || auth.me()?.company?.name }}</div>
        <button class="btn-secondary" style="font-size:12px" (click)="editBr(null)"><ax-icon name="plus" [size]="12" /> Nova filial</button></div>
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Código</th><th>Nome</th><th>CNPJ</th><th>IE</th><th>Cidade/UF</th><th class="num">Usuários</th><th>Status</th><th></th></tr></thead>
        <tbody>@for (b of branches(); track b.id) { <tr><td class="mono">{{ b.code }}</td><td style="font-weight:500">{{ b.name }}</td><td class="mono" style="font-size:12px">{{ b.cnpj | doc }}</td><td class="mono" style="font-size:12px">{{ b.ie || '—' }}</td>
          <td style="font-size:12px">{{ b.address?.cidade || '—' }}{{ b.address?.uf ? '/' + b.address.uf : '' }}</td><td class="num">{{ b.users }}</td>
          <td><span class="badge" [class]="b.active === false ? 'badge badge-muted' : 'badge badge-success'">{{ b.active === false ? 'Inativa' : 'Ativa' }}</span></td>
          <td><button class="btn-ghost" style="font-size:11px" (click)="editBr(b)">Editar</button></td></tr> }</tbody></table>
    </div>
    @if (auth.me()?.user?.is_superadmin) {
      <div class="card" style="overflow:hidden;margin-top:16px">
        <div style="padding:12px 16px;display:flex;align-items:center;gap:8px"><ax-icon name="inbox" [size]="15" color="#0875D1" /><div style="flex:1;font-size:13px;font-weight:600">Contatos do site (pedidos de demonstração)</div><span class="muted" style="font-size:12px">{{ leads().length }} contato(s)</span></div>
        @if (leads().length) {
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data</th><th>Nome</th><th>Contato</th><th>Empresa</th><th>Segmento</th><th>Lojas</th><th>Mensagem</th><th>Situação</th><th></th></tr></thead>
            <tbody>@for (l of leads(); track l.id) { <tr><td class="mono" style="font-size:11px">{{ l.created_at | dtt }}</td><td style="font-weight:500">{{ l.name }}</td><td style="font-size:12px">{{ l.email || '' }}@if (l.phone) { <div>{{ l.phone | phone }}</div> }</td>
              <td style="font-size:12px">{{ l.company_name || '—' }}</td><td style="font-size:12px">{{ l.segment || '—' }}</td><td style="font-size:12px">{{ l.stores || '—' }}</td><td style="font-size:12px;max-width:280px">{{ l.message || '—' }}</td>
              <td><select class="input-field" style="font-size:12px;padding:3px 6px" [value]="l.status" (change)="leadStatus(l, $any($event.target).value)"><option value="novo">Novo</option><option value="em_contato">Em contato</option><option value="convertido">Convertido</option><option value="descartado">Descartado</option></select></td>
              <td><button class="btn-ghost" style="font-size:11px;white-space:nowrap" (click)="router.navigate(['/saas-clientes'], { queryParams: { lead: l.id } })"><ax-icon name="clipboard-list" [size]="11" /> Criar proposta</button></td></tr> }</tbody></table></div>
        } @else { <div class="empty-state" style="padding:20px">Nenhum contato recebido pelo site ainda.</div> }
      </div>
    }
  </div>
  <ax-modal [(open)]="coOpen" [title]="co.id ? 'Editar empresa' : 'Nova empresa'" icon="building-2" [width]="720">
    <div class="form-grid-3">
      <div class="span-2"><label class="field-label">Razão social *</label><input class="input-field" [(ngModel)]="co.name" /></div>
      <div><label class="field-label">Nome fantasia</label><input class="input-field" [(ngModel)]="co.trade_name" /></div>
      <div><label class="field-label">CNPJ</label><input class="input-field mono" [(ngModel)]="co.cnpj" /></div>
      <div><label class="field-label">Inscrição estadual</label><input class="input-field mono" [(ngModel)]="co.ie" /></div>
      <div><label class="field-label">Regime tributário</label><select class="input-field" [(ngModel)]="co.tax_regime">@for (r of regimes; track r[0]) { <option [value]="r[0]">{{ r[1] }}</option> }</select></div>
      @if (co.id) { <div><label class="field-label">Telefone</label><input class="input-field" [(ngModel)]="co.phone" /></div><div><label class="field-label">E-mail</label><input class="input-field" [(ngModel)]="co.email" /></div>
        <div><label class="field-label">Cor da marca</label><input type="color" class="input-field" style="height:34px;padding:2px" [(ngModel)]="co.color" /></div> }
      @else { <div class="span-2"><label class="field-label">Nome da primeira filial</label><input class="input-field" [(ngModel)]="co.branchName" /></div> }
    </div>
    @if (!co.id) {
      <div class="section-title" style="margin:14px 0 8px">Segmento da empresa</div>
      <p style="font-size:12px;color:#647687;margin:-4px 0 10px">Define os módulos, o menu, o vocabulário e as categorias iniciais. Pode ser ajustado depois em Administração › Módulos.</p>
      <div style="display:grid;grid-template-columns:repeat(2, minmax(0,1fr));gap:10px">
        @for (sg of segments(); track sg.id) {
          <button type="button" class="card" style="padding:12px;text-align:left;cursor:pointer;font:inherit" [style.border]="co.segment === sg.id ? '2px solid #0875D1' : null" [style.opacity]="sg.status === 'disponivel' ? 1 : 0.55" [disabled]="sg.status !== 'disponivel'" (click)="co.segment = sg.id">
            <div style="display:flex;gap:10px;align-items:center"><ax-icon [name]="sg.icon" [size]="18" color="#0875D1" /><b style="font-size:13px">{{ sg.name }}</b>@if (sg.status !== 'disponivel') { <span class="badge badge-warning">Em breve</span> }</div>
            <div style="font-size:11.5px;color:#647687;margin-top:4px">{{ sg.description }}</div>
          </button>
        }
      </div>
    }
    <div class="section-title" style="margin:14px 0 8px">Endereço (usado na NF-e)</div>
    <div class="form-grid-4">
      <div><label class="field-label">CEP</label><input class="input-field mono" [(ngModel)]="co.address.cep" /></div><div class="span-2"><label class="field-label">Logradouro</label><input class="input-field" [(ngModel)]="co.address.logradouro" /></div>
      <div><label class="field-label">Número</label><input class="input-field" [(ngModel)]="co.address.numero" /></div><div><label class="field-label">Bairro</label><input class="input-field" [(ngModel)]="co.address.bairro" /></div>
      <div><label class="field-label">Cidade</label><input class="input-field" [(ngModel)]="co.address.cidade" /></div><div><label class="field-label">UF</label><input class="input-field" maxlength="2" [(ngModel)]="co.address.uf" /></div>
      <div><label class="field-label">Cód. IBGE município</label><input class="input-field mono" maxlength="7" [(ngModel)]="co.address.codigoMunicipio" /></div>
    </div>
    <div footer><button class="btn-secondary" (click)="coOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveCo()">Salvar</button></div>
  </ax-modal>
  <ax-modal [(open)]="brOpen" [title]="br.id ? 'Editar filial' : 'Nova filial'" icon="store" [width]="680">
    <div class="form-grid-3">
      <div><label class="field-label">Código *</label><input class="input-field mono" [(ngModel)]="br.code" [disabled]="!!br.id" /></div>
      <div class="span-2"><label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="br.name" /></div>
      <div><label class="field-label">CNPJ</label><input class="input-field mono" [(ngModel)]="br.cnpj" /></div><div><label class="field-label">IE</label><input class="input-field mono" [(ngModel)]="br.ie" /></div>
      <div><label class="field-label">Telefone</label><input class="input-field" [(ngModel)]="br.phone" /></div>
    </div>
    <div class="form-grid-4" style="margin-top:12px">
      <div><label class="field-label">CEP</label><input class="input-field mono" [(ngModel)]="br.address.cep" /></div><div class="span-2"><label class="field-label">Logradouro</label><input class="input-field" [(ngModel)]="br.address.logradouro" /></div>
      <div><label class="field-label">Número</label><input class="input-field" [(ngModel)]="br.address.numero" /></div><div><label class="field-label">Bairro</label><input class="input-field" [(ngModel)]="br.address.bairro" /></div>
      <div><label class="field-label">Cidade</label><input class="input-field" [(ngModel)]="br.address.cidade" /></div><div><label class="field-label">UF</label><input class="input-field" maxlength="2" [(ngModel)]="br.address.uf" /></div>
      <div><label class="field-label">Cód. IBGE</label><input class="input-field mono" maxlength="7" [(ngModel)]="br.address.codigoMunicipio" /></div>
    </div>
    @if (br.id) { <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:10px"><input type="checkbox" [(ngModel)]="br.active" /> Filial ativa</label> }
    @else { <p style="font-size:11px;color:#647687;margin-top:8px">Ao criar a filial, são criados também a conta "Caixa" e o "Caixa 01" para o PDV.</p> }
    <div footer><button class="btn-secondary" (click)="brOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveBr()">Salvar</button></div>
  </ax-modal>`,
})
export class AdminEmpresasPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); private lk = inject(LookupsService); readonly router = inject(Router);
  readonly R = REGIME; readonly regimes = Object.entries(REGIME);
  readonly companies = signal<any[]>([]); readonly branches = signal<any[]>([]); readonly loading = signal(true);
  readonly coOpen = signal(false); readonly brOpen = signal(false); co: any = { address: {} }; br: any = { address: {} };
  readonly segments = signal<any[]>([]); readonly leads = signal<any[]>([]);
  ngOnInit() { this.load(); this.api.get<any>('/segments').then((r) => this.segments.set(r.segments), () => {}); if (this.auth.me()?.user?.is_superadmin) this.loadLeads(); }
  async loadLeads() { try { this.leads.set((await this.api.get<any>('/admin/leads', { size: 100 })).items); } catch { /* sem permissão */ } }
  async leadStatus(l: any, status: string) { try { await this.api.put('/admin/leads/' + l.id, { status }); this.loadLeads(); } catch (e) { this.toast.error(e); } }
  async load() { this.loading.set(true); try { const [c, b] = await Promise.all([this.api.get<any[]>('/admin/companies'), this.api.get<any[]>('/admin/branches')]); this.companies.set(c); this.branches.set(b); } finally { this.loading.set(false); } }
  newCo() { this.co = { name: '', trade_name: '', cnpj: '', ie: '', tax_regime: 'simples', branchName: 'Matriz', address: {}, segment: 'moda' }; this.coOpen.set(true); }
  segName(id: string) { return this.segments().find((x) => x.id === id)?.name ?? (id || 'Moda e vestuário'); }
  editCo(e: any) { this.co = { ...e, address: { ...(e.address || {}) } }; this.coOpen.set(true); }
  async saveCo() {
    const c = this.co; const address = { ...c.address, cep: onlyDigits(c.address.cep) || undefined, uf: (c.address.uf || '').toUpperCase() || undefined };
    try {
      if (c.id) await this.api.put('/admin/companies/' + c.id, { name: c.name, trade_name: c.trade_name || undefined, cnpj: c.cnpj ? onlyDigits(c.cnpj) : undefined, ie: c.ie || undefined, tax_regime: c.tax_regime, crt: c.tax_regime === 'simples' || c.tax_regime === 'mei' ? 1 : 3, phone: c.phone || undefined, email: c.email || undefined, color: c.color || undefined, address });
      else await this.api.post('/admin/companies', { name: c.name, tradeName: c.trade_name || undefined, cnpj: c.cnpj ? onlyDigits(c.cnpj) : undefined, ie: c.ie || undefined, taxRegime: c.tax_regime, branchName: c.branchName || 'Matriz', address, segment: c.segment || 'moda' });
      this.toast.success('Empresa salva.'); this.coOpen.set(false); this.load(); if (c.id) this.auth.loadMe();
    } catch (e) { this.toast.error(e); }
  }
  editBr(b: any) { this.br = b ? { ...b, address: { ...(b.address || {}) } } : { code: String(this.branches().length + 1).padStart(3, '0'), name: '', cnpj: '', ie: '', phone: '', address: {} }; this.brOpen.set(true); }
  async saveBr() {
    const b = this.br; const address = { ...b.address, cep: onlyDigits(b.address.cep) || undefined, uf: (b.address.uf || '').toUpperCase() || undefined };
    try {
      if (b.id) await this.api.put('/admin/branches/' + b.id, { name: b.name, cnpj: b.cnpj ? onlyDigits(b.cnpj) : undefined, ie: b.ie || undefined, phone: b.phone || undefined, address, active: !!b.active });
      else await this.api.post('/admin/branches', { code: b.code, name: b.name, cnpj: b.cnpj ? onlyDigits(b.cnpj) : undefined, ie: b.ie || undefined, phone: b.phone || undefined, address });
      this.toast.success('Filial salva.'); this.brOpen.set(false); this.lk.invalidate(); this.load();
    } catch (e) { this.toast.error(e); }
  }
}

// ─── Usuários ──────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-admin-usuarios',
  imports: [FormsModule, IconComponent, ModalComponent, PagerComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Usuários</h1><p style="font-size:12px;color:#647687">{{ list.total() }} usuário(s) · {{ activeCount() }} ativo(s) na página</p></div>
      <input class="input-field" style="width:220px" placeholder="Nome ou e-mail" [(ngModel)]="q" (keyup.enter)="search()" />
      @if (auth.can('admin.perfis')) { <button class="btn-secondary" style="font-size:12px" (click)="router.navigateByUrl('/admin-permissoes')"><ax-icon name="shield" [size]="13" /> Gerenciar permissões</button> }
      <button class="btn-primary" style="font-size:12px" (click)="edit(null)"><ax-icon name="plus" [size]="13" /> Novo usuário</button>
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Filiais</th><th>MFA</th><th>Último acesso</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>@for (u of list.items(); track u.id) {
          <tr>
            <td><div style="display:flex;align-items:center;gap:8px"><div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#0875D1,#1464A5);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white">{{ ini(u.name) }}</div>
              <span style="font-size:13px;font-weight:500">{{ u.name }}</span>@if (u.is_seller) { <span class="badge badge-cyan">vendedor</span> }</div></td>
            <td class="mono" style="font-size:12px">{{ u.email }}</td><td><span class="badge badge-info">{{ u.role }}</span></td>
            <td style="font-size:12px">{{ u.all_branches ? 'Todas' : (u.branches || '—') }}</td>
            <td>@if (u.mfa_enabled) { <ax-icon name="shield-check" [size]="14" color="#18864B" /> } @else { <span class="muted" style="font-size:11px">não</span> }</td>
            <td class="mono" style="font-size:12px">{{ u.last_login_at | dtt }}</td>
            <td>@if (locked(u)) { <span class="badge badge-danger">Bloqueado</span> } @else { <span class="badge" [class]="u.active ? 'badge badge-success' : 'badge badge-muted'">{{ u.active ? 'Ativo' : 'Inativo' }}</span> }</td>
            <td><div style="display:flex;gap:4px">
              <button class="btn-ghost" style="padding:3px 5px" (click)="edit(u)" aria-label="Editar"><ax-icon name="pencil" [size]="13" /></button>
              <button class="btn-ghost" style="padding:3px 5px;font-size:11px" (click)="resetPwd(u)">Senha</button>
              @if (u.mfa_enabled) { <button class="btn-ghost" style="padding:3px 5px;font-size:11px" (click)="resetMfa(u)">Zerar MFA</button> }
              @if (u.id !== auth.me()?.user?.id) { <button class="btn-ghost" style="padding:3px 5px;font-size:11px" [style.color]="u.active ? '#C93636' : '#18864B'" (click)="toggle(u)">{{ u.active ? 'Desativar' : 'Ativar' }}</button> }
            </div></td>
          </tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="open" [title]="f.id ? 'Editar usuário' : 'Novo usuário'" icon="user" [width]="600">
    <div class="form-grid-2">
      <div class="span-all"><label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="f.name" /></div>
      <div class="span-all"><label class="field-label">E-mail *</label><input type="email" class="input-field" [(ngModel)]="f.email" [disabled]="!!f.id" /></div>
      <div><label class="field-label">Perfil *</label><select class="input-field" [(ngModel)]="f.roleId">@for (r of roles(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }</select></div>
      <div><label class="field-label">Comissão própria (%)</label><input type="number" min="0" max="100" step="0.5" class="input-field mono" [(ngModel)]="f.commissionPct" placeholder="regra padrão" /></div>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.isSeller" /> É vendedor(a)</label>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.allBranches" /> Acesso a todas as filiais</label>
      @if (!f.allBranches) { <div class="span-all"><label class="field-label">Filiais permitidas *</label><div style="display:flex;gap:12px;flex-wrap:wrap">
        @for (b of lk.data()?.branches ?? []; track b.id) { <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" [checked]="f.branchIds.includes(b.id)" (change)="toggleBr(b.id)" /> {{ b.name }}</label> }</div></div> }
      @if (!f.id) { <div class="span-all"><label class="field-label">Senha inicial (opcional)</label><input type="password" class="input-field" [(ngModel)]="f.password" autocomplete="new-password" placeholder="em branco = gerar senha temporária" /></div> }
    </div>
    <div footer><button class="btn-secondary" (click)="open.set(false)">Cancelar</button><button class="btn-primary" (click)="save()">Salvar</button></div>
  </ax-modal>
  <ax-modal [(open)]="tempOpen" title="Senha temporária" icon="key" [width]="420">
    <p style="font-size:13px;margin-bottom:10px">Repasse a senha ao usuário por canal seguro. Ela não será exibida novamente; recomende a troca no primeiro acesso (Configurações → Segurança).</p>
    <div class="mono" style="font-size:20px;font-weight:700;text-align:center;background:#F4F7FA;padding:12px;border-radius:6px;user-select:all">{{ temp() }}</div>
    <div footer><button class="btn-primary" (click)="tempOpen.set(false)">Entendi</button></div>
  </ax-modal>`,
})
export class AdminUsuariosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly list = new ListState<any>((q) => this.api.get('/admin/users', q));
  readonly roles = signal<any[]>([]); readonly open = signal(false); readonly tempOpen = signal(false); readonly temp = signal('');
  q = ''; f: any = { branchIds: [] };
  readonly activeCount = computed(() => this.list.items().filter((u) => u.active).length);
  ngOnInit() { this.lk.ensure(); this.list.load(); this.api.get<any[]>('/admin/roles').then((r) => this.roles.set(r)); }
  ini(n: string) { return n.split(' ').filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase(); }
  locked(u: any) { return u.locked_until && new Date(u.locked_until) > new Date(); }
  search() { this.list.query = { q: this.q || undefined }; this.list.load(1); }
  edit(u: any) { this.f = u ? { id: u.id, name: u.name, email: u.email, roleId: u.role_id, isSeller: u.is_seller, allBranches: u.all_branches, branchIds: [...(u.branch_ids || [])], commissionPct: u.commission_pct }
    : { name: '', email: '', roleId: this.roles().find((r) => r.name === 'Vendedor')?.id ?? this.roles()[0]?.id, isSeller: false, allBranches: false, branchIds: [this.auth.me()?.branch?.id].filter(Boolean), commissionPct: null, password: '' }; this.open.set(true); }
  toggleBr(id: string) { this.f.branchIds = this.f.branchIds.includes(id) ? this.f.branchIds.filter((x: string) => x !== id) : [...this.f.branchIds, id]; }
  async save() {
    const f = this.f; const body: any = { name: f.name, roleId: f.roleId, isSeller: !!f.isSeller, allBranches: !!f.allBranches, branchIds: f.allBranches ? [] : f.branchIds };
    if (f.commissionPct !== null && f.commissionPct !== '' && f.commissionPct !== undefined) body.commissionPct = +f.commissionPct;
    try {
      if (f.id) await this.api.put('/admin/users/' + f.id, body);
      else { const r: any = await this.api.post('/admin/users', { ...body, email: f.email, password: f.password || undefined }); if (r.temporaryPassword) { this.temp.set(r.temporaryPassword); this.tempOpen.set(true); } }
      this.toast.success('Usuário salvo.'); this.open.set(false); this.list.reload(); this.lk.invalidate();
    } catch (e) { this.toast.error(e); }
  }
  async toggle(u: any) { try { await this.api.put('/admin/users/' + u.id, { active: !u.active }); this.list.reload(); } catch (e) { this.toast.error(e); } }
  async resetPwd(u: any) { if (!confirm(`Gerar nova senha temporária para ${u.name}? As sessões abertas serão encerradas.`)) return; try { const r: any = await this.api.post(`/admin/users/${u.id}/reset-password`); this.temp.set(r.temporaryPassword); this.tempOpen.set(true); this.list.reload(); } catch (e) { this.toast.error(e); } }
  async resetMfa(u: any) { if (!confirm(`Desativar a autenticação em dois fatores de ${u.name}?`)) return; try { await this.api.post(`/admin/users/${u.id}/reset-mfa`); this.toast.success('MFA redefinido.'); this.list.reload(); } catch (e) { this.toast.error(e); } }
}

// ─── Perfis e permissões ───────────────────────────────────────────────────
@Component({
  selector: 'ax-admin-permissoes',
  imports: [FormsModule, IconComponent, ModalComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Perfis e Permissões</h1><p style="font-size:12px;color:#647687">{{ roles().length }} perfis · as permissões são verificadas no servidor em cada operação</p></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        @for (r of roles(); track r.id) { <button (click)="pick(r)" [style.border]="'1.5px solid ' + (cur()?.id === r.id ? '#0875D1' : '#DCE4EC')" [style.background]="cur()?.id === r.id ? '#E3EFF9' : 'white'" [style.color]="cur()?.id === r.id ? '#0875D1' : '#647687'" style="padding:5px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">{{ r.name }} <span style="font-weight:400">({{ r.users }})</span></button> }
        <button class="btn-ghost" style="font-size:12px" (click)="newOpen.set(true)"><ax-icon name="plus" [size]="12" /> Novo perfil</button>
      </div>
    </div>
    <ax-state [loading]="!cur()" />
    @if (cur(); as r) {
      <div style="padding:10px 24px;background:#F8FAFC;border-bottom:1px solid #DCE4EC;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <input class="input-field" style="width:200px" [(ngModel)]="name" [disabled]="r.is_system" />
        <input class="input-field" style="flex:1;min-width:200px" placeholder="Descrição" [(ngModel)]="desc" />
        <label style="font-size:12px;display:flex;gap:6px;align-items:center">Desconto máx. (%) <input type="number" min="0" max="100" class="input-field mono" style="width:80px" [(ngModel)]="maxDisc" /></label>
        <span class="muted" style="font-size:12px">{{ sel().size }} de {{ total() }} permissões</span>
        @if (!r.is_system && r.users === 0) { <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="remove(r)">Excluir</button> }
        <button class="btn-primary" style="font-size:12px" [disabled]="!dirty()" (click)="save()">Salvar alterações</button>
      </div>
      <div style="flex:1;overflow:auto">
        <table style="width:100%;border-collapse:collapse;background:white;font-size:12px">
          <thead style="position:sticky;top:0"><tr style="background:#F4F7FA;border-bottom:1px solid #DCE4EC"><th style="padding:10px 16px;text-align:left;font-weight:600;color:#647687;text-transform:uppercase;font-size:11px;letter-spacing:0.04em;width:200px">Recurso</th>
            <th style="padding:10px 12px;text-align:left;font-weight:600;color:#647687;text-transform:uppercase;font-size:11px;letter-spacing:0.04em">Permissões</th><th style="width:110px"></th></tr></thead>
          <tbody>@for (g of perms(); track g.group; let i = $index) {
            <tr [style.background]="i % 2 === 0 ? 'white' : '#FAFBFD'" style="border-bottom:1px solid #F0F4F8;vertical-align:top">
              <td style="padding:9px 16px;font-weight:600;color:#172B3A">{{ g.group }}</td>
              <td style="padding:6px 12px"><div style="display:flex;flex-wrap:wrap;gap:6px 18px">
                @for (p of g.items; track p.code) {
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;min-width:220px" [title]="p.code">
                    <span (click)="flip(p.code)" [style.border]="'1.5px solid ' + (sel().has(p.code) ? '#18864B' : '#DCE4EC')" [style.background]="sel().has(p.code) ? '#E8F5EE' : 'white'" style="width:18px;height:18px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">@if (sel().has(p.code)) { <span style="width:10px;height:10px;background:#18864B;border-radius:2px"></span> }</span>
                    <span (click)="flip(p.code)" [style.color]="p.code.startsWith('admin.') ? '#C93636' : '#172B3A'">{{ p.label }}</span></label>
                }</div></td>
              <td style="padding:6px"><button class="btn-ghost" style="font-size:11px" (click)="group(g, true)">todas</button><button class="btn-ghost" style="font-size:11px" (click)="group(g, false)">nenhuma</button></td>
            </tr>
          }</tbody>
        </table>
      </div>
    }
  </div>
  <ax-modal [(open)]="newOpen" title="Novo perfil" icon="key" [width]="420">
    <label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="newName" />
    <label class="field-label" style="margin-top:8px">Copiar permissões de</label><select class="input-field" [(ngModel)]="copyFrom"><option value="">— nenhuma —</option>@for (r of roles(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }</select>
    <div footer><button class="btn-secondary" (click)="newOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="newName.trim().length < 2" (click)="create()">Criar</button></div>
  </ax-modal>`,
})
export class AdminPermissoesPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); private auth = inject(AuthService);
  readonly roles = signal<any[]>([]); readonly perms = signal<any[]>([]); readonly cur = signal<any>(null); readonly sel = signal<Set<string>>(new Set()); readonly newOpen = signal(false);
  name = ''; desc = ''; maxDisc = 0; newName = ''; copyFrom = '';
  readonly total = computed(() => this.perms().reduce((s, g) => s + g.items.length, 0));
  readonly dirty = signal(false);
  async ngOnInit() { const [r, p] = await Promise.all([this.api.get<any[]>('/admin/roles'), this.api.get<any[]>('/admin/permissions')]); this.perms.set(p); this.roles.set(r); this.pick(this.cur() ? r.find((x) => x.id === this.cur().id) ?? r[0] : r[0]); }
  pick(r: any) { if (!r) return; this.cur.set(r); this.sel.set(new Set(r.permissions)); this.name = r.name; this.desc = r.description || ''; this.maxDisc = Number(r.max_discount_pct); this.dirty.set(false); }
  flip(code: string) { const s = new Set(this.sel()); s.has(code) ? s.delete(code) : s.add(code); this.sel.set(s); this.dirty.set(true); }
  group(g: any, on: boolean) { const s = new Set(this.sel()); g.items.forEach((p: any) => (on ? s.add(p.code) : s.delete(p.code))); this.sel.set(s); this.dirty.set(true); }
  async save() {
    try { await this.api.put('/admin/roles/' + this.cur().id, { name: this.name, description: this.desc, permissions: [...this.sel()], maxDiscountPct: +this.maxDisc || 0 }); this.toast.success('Perfil salvo. Usuários com este perfil recebem as novas permissões na próxima requisição.'); this.ngOnInit(); }
    catch (e) { this.toast.error(e); }
  }
  async create() {
    const src = this.roles().find((r) => r.id === this.copyFrom);
    try { const r: any = await this.api.post('/admin/roles', { name: this.newName.trim(), permissions: src?.permissions ?? ['dashboard.ver'], maxDiscountPct: src ? Number(src.max_discount_pct) : 0 }); this.newOpen.set(false); this.newName = ''; this.cur.set(r); this.ngOnInit(); }
    catch (e) { this.toast.error(e); }
  }
  async remove(r: any) { if (!confirm(`Excluir o perfil ${r.name}?`)) return; try { await this.api.delete('/admin/roles/' + r.id); this.cur.set(null); this.ngOnInit(); } catch (e) { this.toast.error(e); } }
}

// ─── Módulos ───────────────────────────────────────────────────────────────
const MODULES = [
  { id: 'vendas', nome: 'Vendas e PDV', desc: 'PDV, pedidos, orçamentos, trocas, caixa e comissões', icon: 'shopping-cart', core: true },
  { id: 'estoque', nome: 'Estoque e Compras', desc: 'Grade, movimentos, transferências, inventário, XML de NF-e', icon: 'boxes', core: true },
  { id: 'financeiro', nome: 'Financeiro', desc: 'Receber, pagar, crediário, conciliação e fluxo de caixa', icon: 'dollar-sign', core: true },
  { id: 'condicional', nome: 'Condicional e Bag Delivery', desc: 'Peças em poder da cliente com retorno e venda', icon: 'shopping-bag' },
  { id: 'consignacao', nome: 'Consignação', desc: 'Remessas para parceiras com acerto e comissão', icon: 'handshake' },
  { id: 'fidelidade', nome: 'Fidelidade e Cashback', desc: 'Crédito por compra com validade e resgate no PDV', icon: 'gift' },
  { id: 'crm', nome: 'CRM', desc: 'Funil de oportunidades', icon: 'user-check' },
  { id: 'fiscal', nome: 'Fiscal', desc: 'NF-e/NFC-e via provedor homologado', icon: 'receipt-text' },
  { id: 'precificacao', nome: 'Precificação', desc: 'Custos fixos e variáveis, markup, margem de contribuição, ponto de equilíbrio e margem de segurança', icon: 'calculator' },
  { id: 'contabilidade', nome: 'Contabilidade', desc: 'Lançamentos gerenciais, DRE e plano de contas', icon: 'book-open' },
  { id: 'rh', nome: 'Recursos Humanos', desc: 'Colaboradores, documentos e desempenho', icon: 'graduation-cap' },
  { id: 'juridico', nome: 'Jurídico', desc: 'Processos, prazos e provisões', icon: 'scale' },
  { id: 'intelligence', nome: 'Intelligence', desc: 'Previsão, reposição, otimização e simulações', icon: 'brain' },
];
const SEGMENT_MODULES = [
  { id: 'grade', nome: 'Grade cor × tamanho', desc: 'Variações por cor e tamanho com SKU/EAN por variação (moda)', icon: 'grid-3x3' },
  { id: 'colecoes', nome: 'Coleções', desc: 'Organização do catálogo por coleção/estação', icon: 'layers' },
  { id: 'peso', nome: 'Venda por peso e balança', desc: 'Produtos por kg, leitura de balança no PDV e etiqueta de balança', icon: 'scale' },
  { id: 'validade', nome: 'Lotes, validade e perdas', desc: 'Entrada com lote e validade, alertas, consumo FEFO e perdas', icon: 'calendar-clock' },
  { id: 'embalagens', nome: 'Embalagens (unidade/caixa)', desc: 'Venda por unidade ou caixa com código de barras próprio', icon: 'package' },
  { id: 'combos', nome: 'Combos e kits', desc: 'Kits com preço promocional que baixam o estoque de cada item', icon: 'gift' },
  { id: 'precos_quantidade', nome: 'Preço por quantidade (atacarejo)', desc: 'Preço unitário menor a partir de N unidades, aplicado no PDV', icon: 'trending-down' },
  { id: 'maioridade', nome: 'Controle de maioridade', desc: 'Confirmação de idade obrigatória no PDV para produtos restritos', icon: 'shield-check' },
  { id: 'agenda', nome: 'Agenda, serviços e profissionais', desc: 'Agenda por profissional, serviços com duração, bloqueios, comissão por profissional e cobrança no PDV', icon: 'calendar-days' },
  { id: 'pacotes', nome: 'Pacotes de sessões', desc: 'Pacotes (ex.: 10 sessões) com saldo, validade e baixa a cada atendimento', icon: 'ticket' },
  { id: 'prontuario', nome: 'Prontuário e fichas', desc: 'Anamnese com consentimento, evolução e ficha técnica com acesso auditado', icon: 'clipboard-list' },
  { id: 'odontograma', nome: 'Odontograma e planos de tratamento', desc: 'Odontograma por dente/face e plano de tratamento com aprovação e cobrança parcelada', icon: 'smile' },
];
@Component({
  selector: 'ax-admin-modulos',
  imports: [IconComponent, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:18px"><h1 style="font-size:20px;font-weight:700;color:#172B3A">Central de Módulos</h1><p style="font-size:13px;color:#647687">Ative ou oculte módulos para esta empresa (os dados são preservados ao desativar) · versão {{ version() }}</p></div>
    <div class="card" style="padding:16px;margin-bottom:18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="width:44px;height:44px;border-radius:10px;background:#0B1F33;display:flex;align-items:center;justify-content:center"><ax-icon [name]="auth.me()?.segment?.icon || 'store'" [size]="22" color="#fff" /></div>
      <div style="flex:1;min-width:220px"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase">Segmento da empresa</div><div style="font-size:16px;font-weight:700">{{ auth.me()?.segment?.name || 'Moda e vestuário' }}</div>
        <div style="font-size:12px;color:#647687">O pacote do segmento ativa os módulos e categorias do ramo. Aplicar outro segmento só acrescenta — nada é apagado.</div></div>
      <button class="btn-secondary" style="font-size:12px" (click)="segOpen.set(true)"><ax-icon name="repeat" [size]="13" /> Aplicar outro segmento</button>
    </div>
    <div class="section-title" style="margin:0 0 10px">Recursos do segmento</div>
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:14px;margin-bottom:22px">
      @for (m of segMods; track m.id) {
        <div class="card" style="padding:18px">
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px">
            <div style="width:44px;height:44px;border-radius:10px;background:#E3F6EC;display:flex;align-items:center;justify-content:center"><ax-icon [name]="m.icon" [size]="22" color="#18864B" /></div>
            <div style="flex:1"><div style="font-size:14px;font-weight:700;color:#172B3A">{{ m.nome }}</div><div style="font-size:12px;color:#647687;margin-top:2px">{{ m.desc }}</div></div>
            <span class="badge" [class]="on(m.id) ? 'badge badge-success' : 'badge badge-muted'">{{ on(m.id) ? 'Ativo' : 'Inativo' }}</span>
          </div>
          <button [class]="on(m.id) ? 'btn-ghost' : 'btn-secondary'" style="font-size:11px" [style.color]="on(m.id) ? '#C93636' : null" (click)="toggle(m.id)">{{ on(m.id) ? 'Desativar' : 'Ativar' }}</button>
        </div>
      }
    </div>
    <div class="section-title" style="margin:0 0 10px">Módulos gerais</div>
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:14px">
      @for (m of mods; track m.id) {
        <div class="card" style="padding:18px">
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px">
            <div style="width:44px;height:44px;border-radius:10px;background:#E3EFF9;display:flex;align-items:center;justify-content:center"><ax-icon [name]="m.icon" [size]="22" color="#0875D1" /></div>
            <div style="flex:1"><div style="font-size:14px;font-weight:700;color:#172B3A">{{ m.nome }}</div><div style="font-size:12px;color:#647687;margin-top:2px">{{ m.desc }}</div></div>
            <span class="badge" [class]="on(m.id) ? 'badge badge-success' : 'badge badge-muted'">{{ on(m.id) ? 'Ativo' : 'Inativo' }}</span>
          </div>
          @if (m.core) { <div class="muted" style="font-size:11px">Módulo essencial — sempre ativo.</div> }
          @else { <button [class]="on(m.id) ? 'btn-ghost' : 'btn-secondary'" style="font-size:11px" [style.color]="on(m.id) ? '#C93636' : null" (click)="toggle(m.id)">{{ on(m.id) ? 'Desativar' : 'Ativar' }}</button> }
        </div>
      }
    </div>
  </div>
  <ax-modal [(open)]="segOpen" title="Aplicar segmento" icon="repeat" [width]="640">
    <p style="font-size:12px;color:#647687;margin:0 0 10px">O sistema ativa os módulos do segmento escolhido, cria as categorias que faltarem e completa os parâmetros padrão. Nenhum produto, venda, módulo ou configuração existente é apagado.</p>
    <div style="display:grid;grid-template-columns:repeat(2, minmax(0,1fr));gap:10px">
      @for (sg of segments(); track sg.id) {
        <button type="button" class="card" style="padding:12px;text-align:left;cursor:pointer;font:inherit" [style.border]="segPick === sg.id ? '2px solid #0875D1' : null" [style.opacity]="sg.status === 'disponivel' ? 1 : 0.55" [disabled]="sg.status !== 'disponivel'" (click)="segPick = sg.id">
          <div style="display:flex;gap:10px;align-items:center"><ax-icon [name]="sg.icon" [size]="18" color="#0875D1" /><b style="font-size:13px">{{ sg.name }}</b>@if (sg.id === auth.me()?.segment?.id) { <span class="badge badge-info">Atual</span> }@if (sg.status !== 'disponivel') { <span class="badge badge-warning">Em breve</span> }</div>
          <div style="font-size:11.5px;color:#647687;margin-top:4px">{{ sg.description }}</div>
        </button>
      }
    </div>
    <div footer><button class="btn-secondary" (click)="segOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!segPick || busy()" (click)="applySeg()">Aplicar segmento</button></div>
  </ax-modal>`,
})
export class AdminModulosPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly mods = MODULES; readonly segMods = SEGMENT_MODULES; readonly active = signal<Set<string>>(new Set()); readonly version = signal('');
  readonly segOpen = signal(false); readonly segments = signal<any[]>([]); readonly busy = signal(false); segPick = '';
  ngOnInit() { this.active.set(new Set(this.auth.me()?.company?.modules ?? [])); this.api.get<any>('/health').then((h) => this.version.set(h.version)).catch(() => {}); this.api.get<any>('/segments').then((r) => this.segments.set(r.segments), () => {}); this.segPick = this.auth.me()?.segment?.id ?? ''; }
  async applySeg() {
    this.busy.set(true);
    try { const r: any = await this.api.post(`/admin/companies/${this.auth.me()!.company.id}/segment`, { segment: this.segPick }); await this.auth.loadMe(); this.active.set(new Set(this.auth.me()?.company?.modules ?? []));
      this.toast.success(`Segmento aplicado: ${r.categoriesAdded} categoria(s) criada(s).`); this.segOpen.set(false); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  on(id: string) { return MODULES.find((m) => m.id === id)?.core || this.active().has(id); }
  async toggle(id: string) {
    const s = new Set(this.active()); s.has(id) ? s.delete(id) : s.add(id);
    try { await this.api.put('/admin/companies/' + this.auth.me()!.company.id, { modules: [...s] }); this.active.set(s); await this.auth.loadMe(); this.toast.success('Módulos atualizados.'); } catch (e) { this.toast.error(e); }
  }
}

// ─── Auditoria ─────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-auditoria',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;height:100%">
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Central de Auditoria</h1><p style="font-size:12px;color:#647687">{{ list.total() | num }} evento(s) no filtro · últimas 24h: {{ st()?.total ?? 0 }} eventos, {{ st()?.critical ?? 0 }} críticos, {{ st()?.users ?? 0 }} usuário(s)</p></div>
        <input class="input-field" style="width:200px;font-size:12px" placeholder="Ação, usuário ou ID" [(ngModel)]="q" (keyup.enter)="apply()" />
        <input type="date" class="input-field" style="width:135px;font-size:12px" [(ngModel)]="from" (change)="apply()" /><input type="date" class="input-field" style="width:135px;font-size:12px" [(ngModel)]="to" (change)="apply()" />
        <button class="btn-ghost" style="font-size:12px" (click)="exportCsv()"><ax-icon name="download" [size]="13" /> Exportar</button>
      </div>
      <div style="padding:8px 24px;background:white;border-bottom:1px solid #F0F4F8;display:flex;gap:8px">
        @for (f of sevs; track f[0]) { <button (click)="sev.set(f[0]); apply()" [style.border]="'1px solid ' + (sev() === f[0] ? '#0875D1' : '#DCE4EC')" [style.background]="sev() === f[0] ? '#E3EFF9' : 'white'" [style.color]="sev() === f[0] ? '#0875D1' : '#647687'" style="padding:3px 10px;border-radius:5px;font-size:12px;cursor:pointer">{{ f[1] }}</button> }
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
          <thead style="position:sticky;top:0"><tr><th>Data/Hora</th><th>Usuário</th><th>Módulo</th><th>Ação</th><th>Registro</th><th>IP</th><th>Severidade</th><th>Ver</th></tr></thead>
          <tbody>@for (l of list.items(); track l.id) {
            <tr style="cursor:pointer" [style.background]="sel()?.id === l.id ? '#F0F7FF' : null" (click)="sel.set(l)">
              <td class="mono" style="font-size:11px">{{ l.created_at | dtt }}</td><td style="font-size:12px;font-weight:500">{{ l.user_name || 'Sistema' }}</td>
              <td><span class="badge badge-muted">{{ l.entity || '—' }}</span></td><td style="font-size:12px">{{ l.action }}</td><td class="mono" style="font-size:11px;color:#0875D1">{{ (l.entity_id || '—').slice(0, 13) }}</td>
              <td class="mono" style="font-size:11px;color:#647687">{{ l.ip || '—' }}</td>
              <td><span class="badge" [class]="l.severity === 'critical' ? 'badge badge-danger' : l.severity === 'warning' ? 'badge badge-warning' : 'badge badge-info'">{{ S[l.severity] }}</span></td>
              <td><button class="btn-ghost" style="padding:3px 6px" aria-label="Detalhes"><ax-icon name="eye" [size]="13" /></button></td>
            </tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum evento no filtro." />
      </div>
      <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
    </div>
    @if (sel(); as s) {
      <div style="width:360px;border-left:1px solid #DCE4EC;background:white;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:12px 16px;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:10px"><ax-icon name="shield" [size]="15" color="#0875D1" /><span style="font-size:13px;font-weight:700;color:#172B3A;flex:1">Detalhes do Evento</span>
          <button class="btn-ghost" style="padding:3px 5px" (click)="sel.set(null)" aria-label="Fechar"><ax-icon name="x" [size]="14" /></button></div>
        <div style="flex:1;overflow-y:auto;padding:16px">
          @for (r of [['Data/Hora', (s.created_at | dtt)], ['Usuário', s.user_name || 'Sistema'], ['IP', s.ip || '—'], ['Módulo / entidade', s.entity || '—'], ['Ação', s.action], ['Registro', s.entity_id || '—'], ['Severidade', S[s.severity]]]; track r[0]) {
            <div style="margin-bottom:12px"><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">{{ r[0] }}</div><div style="font-size:13px;color:#172B3A;word-break:break-all">{{ r[1] }}</div></div>
          }
          <div style="margin-top:16px;border:1px solid #DCE4EC;border-radius:8px;overflow:hidden">
            <div style="padding:8px 12px;font-size:11px;font-weight:700;color:#0875D1;background:#F5FAFF;border-bottom:1px solid #DCE4EC">DADOS REGISTRADOS</div>
            <pre class="mono" style="padding:10px 12px;font-size:11px;margin:0;white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto">{{ json(s.data) }}</pre>
          </div>
          <p class="muted" style="font-size:11px;margin-top:8px">A trilha é somente inclusão: eventos não podem ser alterados nem excluídos pela aplicação.</p>
        </div>
      </div>
    }
  </div>`,
})
export class AuditoriaPage implements OnInit {
  private api = inject(Api);
  readonly S: Record<string, string> = { info: 'Info', warning: 'Atenção', critical: 'Crítico' };
  readonly sevs = [['', 'Todos'], ['critical', 'Crítico'], ['warning', 'Atenção'], ['info', 'Info']];
  readonly list = new ListState<any>((q) => this.api.get('/audit', q));
  readonly st = computed(() => this.list.extra()?.stats);
  readonly sev = signal(''); readonly sel = signal<any>(null); q = ''; from = ''; to = '';
  ngOnInit() { this.list.load(); }
  apply() { this.list.query = { severity: this.sev() || undefined, q: this.q || undefined, from: this.from || undefined, to: this.to || undefined }; this.list.load(1); }
  json(d: any) { return d ? JSON.stringify(d, null, 2) : '—'; }
  async exportCsv() {
    const rows: any[] = []; let page = 1, pages = 1;
    do { const r: any = await this.api.get('/audit', { ...this.list.query, page, size: 500 }); rows.push(...r.items); pages = r.pages; page++; } while (page <= pages && page <= 20);
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['data;usuario;acao;entidade;registro;ip;severidade;dados', ...rows.map((r) => [r.created_at, esc(r.user_name), esc(r.action), esc(r.entity), esc(r.entity_id), esc(r.ip), r.severity, esc(JSON.stringify(r.data ?? {}))].join(';'))].join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })); a.download = 'auditoria.csv'; a.click();
  }
}
