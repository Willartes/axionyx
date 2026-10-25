import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, PagerComponent, ModalComponent, StateComponent } from '../../shared/ui';
import { Api, ApiError } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, PAYMENT_LABEL } from '../../core/format';

// ─── Central de Cadastros ───────────────────────────────────────────────────
@Component({
  selector: 'ax-cadastros',
  imports: [IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:24px">
      <h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Central de Cadastros</h1>
      <p style="font-size:13px;color:#647687">Gerencie todos os cadastros do sistema em um único lugar.</p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:14px">
      @for (c of cards(); track c.id) {
        <div class="card" style="padding:20px;cursor:pointer;transition:box-shadow 0.15s" (click)="router.navigate(['/' + c.route], { queryParams: c.query })"
          (mouseenter)="$any($event.currentTarget).style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)'" (mouseleave)="$any($event.currentTarget).style.boxShadow = 'none'">
          <div style="display:flex;align-items:flex-start;gap:14px">
            <div [style.background]="c.bg" style="width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><ax-icon [name]="c.icon" [size]="22" [color]="c.color" /></div>
            <div style="flex:1">
              <div style="font-size:15px;font-weight:600;color:#172B3A;margin-bottom:2px">{{ c.label }}</div>
              <div style="font-size:12px;color:#647687;margin-bottom:6px">{{ c.desc }}</div>
              <div style="font-size:20px;font-weight:700;color:#172B3A">{{ c.count === null ? '—' : (c.count | num) }}</div>
            </div>
            <ax-icon name="chevron-right" [size]="16" color="#A0AFBF" />
          </div>
        </div>
      }
    </div>
  </div>`,
})
export class CadastrosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); private auth = inject(AuthService);
  readonly counts = signal<any>(null);
  readonly cards = computed(() => {
    const c = this.counts() ?? {};
    const all = [
      { id: 'clientes', route: 'clientes', label: 'Clientes', count: c.customers ?? null, icon: 'users', color: '#0875D1', bg: '#E3EFF9', desc: `${c.customers_active ?? 0} ativos · ${c.partners ?? 0} revendedora(s)`, perm: 'clientes.ver' },
      { id: 'fornecedores', route: 'fornecedores', label: 'Fornecedores', count: c.suppliers ?? null, icon: 'truck', color: '#18864B', bg: '#E8F5EE', desc: 'Fornecedores ativos', perm: 'cadastros.ver' },
      { id: 'produtos', route: 'produtos', label: 'Produtos', count: c.products ?? null, icon: 'package', color: '#D99000', bg: '#FFF4E0', desc: this.auth.has('grade') ? `${c.variants ?? 0} SKUs (cor × tamanho)` : `${c.variants ?? 0} SKUs`, perm: 'produtos.ver' },
      { id: 'marcas', route: 'auxiliares', query: { tab: 'marcas' }, label: this.auth.has('colecoes') ? 'Marcas e Coleções' : 'Marcas', count: (c.brands ?? 0) + (this.auth.has('colecoes') ? (c.collections ?? 0) : 0), icon: 'tag', color: '#2878C7', bg: '#E3EFF9', desc: this.auth.has('colecoes') ? `${c.brands ?? 0} marcas · ${c.collections ?? 0} coleções` : `${c.brands ?? 0} marcas`, perm: 'produtos.ver' },
      ...(this.auth.has('grade') ? [{ id: 'grades', route: 'auxiliares', query: { tab: 'tamanhos' }, label: this.auth.term('grade') === 'Grade' ? 'Grades, Tamanhos e Cores' : this.auth.term('tamanhos') + ' e ' + this.auth.term('cores'), count: (c.colors ?? 0), icon: 'palette', color: '#647687', bg: '#EEF2F6', desc: `${c.grids ?? 0} grades · ${c.colors ?? 0} cores`, perm: 'produtos.ver' }] : []),
      ...(this.auth.has('combos') ? [{ id: 'combos', route: 'combos', label: 'Combos e Kits', count: null, icon: 'package-plus', color: '#C2185B', bg: '#FCE4EC', desc: 'Kits com preço fechado', perm: 'produtos.ver' }] : []),
      { id: 'categorias', route: 'auxiliares', query: { tab: 'categorias' }, label: 'Categorias', count: c.categories ?? null, icon: 'layers', color: '#0875D1', bg: '#E3EFF9', desc: 'Grupos e subgrupos', perm: 'produtos.ver' },
      { id: 'pagamentos', route: 'auxiliares', query: { tab: 'pagamentos' }, label: 'Formas de Pagamento', count: c.payment_methods ?? null, icon: 'credit-card', color: '#18864B', bg: '#E8F5EE', desc: 'Taxas, prazos e parcelas', perm: 'vendas.ver' },
    ];
    return all.filter((x) => this.auth.can(x.perm));
  });
  async ngOnInit() { try { this.counts.set(await this.api.get('/cadastros/counts')); } catch { /* exibe — */ } }
}

// ─── Clientes ───────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-clientes',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;height:100%">
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:16px 24px;border-bottom:1px solid #DCE4EC;background:white;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1">
          <h1 style="font-size:16px;font-weight:700;color:#172B3A">{{ auth.term('clientes') }}</h1>
          <p style="font-size:12px;color:#647687">{{ list.total() | num }} registro(s)</p>
        </div>
        <div style="display:flex;gap:4px">
          @for (s of segments; track s.id) { <span class="chip" [class.active]="segment() === s.id" (click)="setSegment(s.id)">{{ s.label }}</span> }
        </div>
        @if (auth.can('clientes.editar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/cliente-detail')"><ax-icon name="plus" [size]="13" /> Novo cliente</button> }
      </div>
      <div style="padding:10px 24px;background:white;border-bottom:1px solid #F0F4F8;display:flex;gap:10px;align-items:center">
        <div style="position:relative;max-width:360px;flex:1">
          <ax-icon name="search" [size]="14" color="#A0AFBF" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" />
          <input class="input-field" style="padding-left:32px;font-size:13px" placeholder="Buscar por nome, CPF/CNPJ, telefone, e-mail..." [(ngModel)]="q" (ngModelChange)="search()" />
        </div>
        @if (segment() !== 'todos') { <span class="muted" style="font-size:12px">{{ segmentHint() }}</span> }
      </div>
      <div style="flex:1;overflow-y:auto">
        @if (segment() === 'todos') {
          <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
            <thead style="position:sticky;top:0"><tr>
              <th>Código</th><th>Nome / Razão Social</th><th>CPF / CNPJ</th><th>Tipo</th><th>Cidade</th><th>WhatsApp</th><th>Última Compra</th><th class="num">Total Comprado</th><th class="num">Em Aberto</th><th>Status</th><th style="width:70px">Ações</th>
            </tr></thead>
            <tbody>
              @for (c of list.items(); track c.id) {
                <tr class="clickable" [class.selected]="selected()?.id === c.id" (click)="selected.set(c)" (dblclick)="open(c)">
                  <td class="mono" style="font-size:12px;color:#0875D1;font-weight:500">CLI-{{ c.code }}</td>
                  <td style="font-weight:500">{{ c.name }} @if (c.is_partner) { <span class="badge badge-cyan" style="margin-left:4px">Revendedora</span> } @for (t of c.tags; track t) { <span class="badge badge-muted" style="margin-left:4px">{{ t }}</span> }</td>
                  <td class="mono" style="font-size:12px">{{ c.cpf_cnpj | doc }}</td>
                  <td><span class="badge" [class]="c.type === 'PJ' ? 'badge badge-info' : 'badge badge-muted'">{{ c.type }}</span></td>
                  <td style="color:#647687;font-size:12px">{{ c.city ? c.city + ' - ' + c.uf : '—' }}</td>
                  <td class="mono" style="font-size:12px">{{ c.whatsapp | phone }}</td>
                  <td class="mono" style="font-size:12px">{{ c.last_purchase | dt }}</td>
                  <td class="num" style="font-size:12px;font-weight:600">{{ c.total_purchases | brl }}</td>
                  <td class="num" style="font-size:12px" [style.color]="c.open_balance > 0 ? '#D99000' : '#647687'">{{ c.open_balance | brl }}</td>
                  <td><span class="badge" [class]="c.active ? 'badge badge-success' : 'badge badge-muted'">{{ c.active ? 'Ativo' : 'Inativo' }}</span></td>
                  <td (click)="$event.stopPropagation()"><button class="btn-ghost" style="padding:3px 5px" (click)="open(c)" title="Abrir ficha"><ax-icon name="eye" [size]="13" /></button></td>
                </tr>
              }
            </tbody>
          </table>
          <ax-state [loading]="list.loading() && !list.items().length" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum cliente encontrado." (retry)="list.reload()" />
        } @else {
          <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
            <thead style="position:sticky;top:0"><tr><th style="width:36px"><input type="checkbox" [checked]="allChecked()" (change)="toggleAll()" /></th><th>Cliente</th><th>Aniversário</th><th>Última compra</th><th>WhatsApp</th><th>Consentimento</th><th></th></tr></thead>
            <tbody>
              @for (c of segRows(); track c.id) {
                <tr>
                  <td><input type="checkbox" [checked]="checked().has(c.id)" (change)="toggle(c.id)" [disabled]="!c.whatsapp_consent" /></td>
                  <td style="font-weight:500">{{ c.name }}</td><td class="mono" style="font-size:12px">{{ c.birth_date | dt }}</td>
                  <td class="mono" style="font-size:12px">{{ c.last_purchase | dt }}</td><td class="mono" style="font-size:12px">{{ c.whatsapp | phone }}</td>
                  <td>@if (c.whatsapp_consent) { <span class="badge badge-success">WhatsApp autorizado</span> } @else { <span class="badge badge-muted">Sem consentimento</span> }</td>
                  <td><button class="btn-ghost" style="padding:3px 6px" (click)="router.navigateByUrl('/cliente-detail/' + c.id)"><ax-icon name="eye" [size]="13" /></button></td>
                </tr>
              }
            </tbody>
          </table>
          <ax-state [loading]="segLoading()" [empty]="!segLoading() && !segRows().length" emptyText="Nenhum cliente neste segmento." />
        }
      </div>
      @if (segment() === 'todos') { <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" /> }
      @else if (auth.can('mensagens.enviar')) {
        <div class="pager"><span style="font-size:12px;color:#647687">{{ checked().size }} selecionado(s) — somente clientes com consentimento podem receber mensagens.</span>
          <button class="btn-primary" style="font-size:12px" [disabled]="!checked().size" (click)="msgOpen.set(true)"><ax-icon name="message-circle" [size]="13" /> Enviar WhatsApp</button></div>
      }
    </div>

    @if (selected(); as c) {
      <div style="width:280px;border-left:1px solid #DCE4EC;background:white;padding:16px;overflow-y:auto;flex-shrink:0">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
          <div style="width:40px;height:40px;background:#E3EFF9;border-radius:10px;display:flex;align-items:center;justify-content:center"><ax-icon name="users" [size]="20" color="#0875D1" /></div>
          <div style="flex:1"><div style="font-size:13px;font-weight:700;color:#172B3A">{{ c.name }}</div><span class="badge" [class]="c.active ? 'badge badge-success' : 'badge badge-danger'">{{ c.active ? 'Ativo' : 'Inativo' }}</span></div>
          <button class="btn-ghost" style="padding:3px" (click)="selected.set(null)"><ax-icon name="x" [size]="14" /></button>
        </div>
        @for (row of [['Código', 'CLI-' + c.code], ['CPF/CNPJ', (c.cpf_cnpj | doc)], ['E-mail', c.email || '—'], ['WhatsApp', (c.whatsapp | phone)], ['Nascimento', (c.birth_date | dt)], ['Compras', c.purchases + ' · ' + (c.total_purchases | brl)], ['Limite de crediário', (c.credit_limit | brl)], ['Em aberto', (c.open_balance | brl)], ['Última compra', (c.last_purchase | dt)]]; track row[0]) {
          <div style="margin-bottom:10px"><div class="field-label" style="font-size:10px">{{ row[0] }}</div><div style="font-size:13px;color:#172B3A">{{ row[1] }}</div></div>
        }
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:16px">
          <button class="btn-primary" style="justify-content:center;font-size:12px" (click)="open(c)">Abrir ficha completa</button>
          @if (auth.has('prontuario') && auth.can('prontuario.ver')) { <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="router.navigateByUrl('/ficha/' + c.id)">{{ auth.term('prontuario') }}</button> }
          @if (auth.has('agenda') && auth.can('agenda.editar')) { <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="router.navigate(['/agenda'], { queryParams: { cliente: c.id } })">Agendar</button> }
          @if (auth.can('vendas.criar')) { <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="router.navigate(['/pdv'], { queryParams: { cliente: c.id } })">Nova venda no PDV</button> }
          @if (auth.can('condicional.editar') && auth.has('condicional')) { <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="router.navigate(['/condicional-detail'], { queryParams: { cliente: c.id } })">Separar condicional / bag</button> }
          <button class="btn-secondary" style="justify-content:center;font-size:12px" (click)="router.navigate(['/pedidos'], { queryParams: { cliente: c.id } })">Ver compras</button>
        </div>
      </div>
    }
  </div>

  <ax-modal [(open)]="msgOpen" title="Enviar mensagem por WhatsApp" icon="message-circle">
    <div class="state-info" style="margin-bottom:12px"><ax-icon name="info" [size]="14" />Envio somente pela API oficial (WhatsApp Business Platform). Sem credenciais configuradas, as mensagens ficam registradas como "pendente de configuração".</div>
    <label class="field-label">Finalidade</label>
    <select class="input-field" [(ngModel)]="msg.purpose" style="margin-bottom:10px"><option value="aniversario">Aniversário</option><option value="pos_venda">Pós-venda</option><option value="campanha">Campanha</option></select>
    <label class="field-label">Mensagem ({{ '{' }}nome{{ '}' }} é substituído pelo primeiro nome)</label>
    <textarea class="input-field" rows="4" [(ngModel)]="msg.body"></textarea>
    <div footer><button class="btn-secondary" (click)="msgOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="sending()" (click)="sendBulk()">Enviar para {{ checked().size }}</button></div>
  </ax-modal>`,
})
export class ClientesPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); private route = inject(ActivatedRoute);
  readonly list = new ListState<any>((q) => this.api.get('/customers', q));
  readonly selected = signal<any>(null);
  readonly segment = signal('todos');
  readonly segRows = signal<any[]>([]); readonly segLoading = signal(false); readonly checked = signal(new Set<string>());
  readonly msgOpen = signal(false); readonly sending = signal(false);
  msg = { purpose: 'aniversario', body: 'Olá, {nome}! Feliz aniversário! Preparamos um mimo especial para você na loja. 🎉' };
  readonly segments = [{ id: 'todos', label: 'Todos' }, { id: 'aniversariantes', label: 'Aniversariantes do mês' }, { id: 'inativos', label: 'Inativos' }, { id: 'pos-venda', label: 'Pós-venda' }];
  q = ''; private t: any;
  ngOnInit() {
    const seg = this.route.snapshot.queryParamMap.get('segmento');
    if (seg) this.setSegment(seg); else this.list.load();
  }
  search() { clearTimeout(this.t); this.t = setTimeout(() => { this.list.query = { q: this.q }; this.list.load(1); }, 300); }
  open(c: any) { this.router.navigateByUrl('/cliente-detail/' + c.id); }
  segmentHint() { return ({ aniversariantes: 'Clientes que fazem aniversário neste mês.', inativos: 'Sem compras há mais dias que o configurado (Configurações › Segmentos).', 'pos-venda': 'Compraram recentemente — ideal para contato de pós-venda.' } as any)[this.segment()] || ''; }
  async setSegment(s: string) {
    this.segment.set(s); this.checked.set(new Set());
    if (s === 'todos') { this.list.load(1); return; }
    this.segLoading.set(true);
    try { this.segRows.set(await this.api.get('/customers-segments/' + s)); } catch (e) { this.toast.error(e); } finally { this.segLoading.set(false); }
  }
  toggle(id: string) { const s = new Set(this.checked()); s.has(id) ? s.delete(id) : s.add(id); this.checked.set(s); }
  allChecked() { const ok = this.segRows().filter((r) => r.whatsapp_consent); return ok.length > 0 && ok.every((r) => this.checked().has(r.id)); }
  toggleAll() { const ok = this.segRows().filter((r) => r.whatsapp_consent); this.checked.set(this.allChecked() ? new Set() : new Set(ok.map((r) => r.id))); }
  async sendBulk() {
    this.sending.set(true);
    try {
      const r: any = await this.api.post('/messages/bulk', { customerIds: [...this.checked()], purpose: this.msg.purpose, body: this.msg.body, refId: `${this.msg.purpose}-${new Date().toISOString().slice(0, 7)}` });
      this.toast.success('Mensagens processadas: ' + Object.entries(r).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', '));
      this.msgOpen.set(false);
    } catch (e) { this.toast.error(e); } finally { this.sending.set(false); }
  }
}

// ─── Fornecedores ───────────────────────────────────────────────────────────
@Component({
  selector: 'ax-fornecedores',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header">
      <div style="flex:1"><h1>Fornecedores</h1><p>{{ list.total() | num }} fornecedor(es) · cadastrados manualmente ou automaticamente na importação de XML</p></div>
      <div style="position:relative"><ax-icon name="search" [size]="14" color="#A0AFBF" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" />
        <input class="input-field" style="padding-left:32px;width:240px" placeholder="Buscar fornecedor..." [(ngModel)]="q" (ngModelChange)="search()" /></div>
      @if (auth.can('cadastros.editar')) { <button class="btn-primary" style="font-size:12px" (click)="edit({})"><ax-icon name="plus" [size]="13" /> Novo fornecedor</button> }
    </div>
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Razão Social</th><th>Fantasia</th><th>CNPJ</th><th>IE</th><th>E-mail</th><th>Telefone</th><th>Cidade</th><th>Status</th><th></th></tr></thead>
        <tbody>
          @for (s of list.items(); track s.id) {
            <tr class="clickable" (click)="edit(s)">
              <td style="font-weight:500">{{ s.name }}</td><td>{{ s.trade_name || '—' }}</td><td class="mono" style="font-size:12px">{{ s.cnpj | doc }}</td><td class="mono" style="font-size:12px">{{ s.ie || '—' }}</td>
              <td style="font-size:12px">{{ s.email || '—' }}</td><td class="mono" style="font-size:12px">{{ s.phone | phone }}</td><td style="font-size:12px;color:#647687">{{ s.address?.cidade || '—' }}</td>
              <td><span class="badge" [class]="s.active ? 'badge badge-success' : 'badge badge-muted'">{{ s.active ? 'Ativo' : 'Inativo' }}</span></td>
              <td><ax-icon name="pencil" [size]="13" color="#647687" /></td>
            </tr>
          }
        </tbody>
      </table>
      <ax-state [loading]="list.loading() && !list.items().length" [error]="list.error()" [empty]="!list.loading() && !list.items().length" (retry)="list.reload()" />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="open" [title]="f.id ? 'Editar fornecedor' : 'Novo fornecedor'" icon="truck" [width]="640">
    @if (err()) { <div class="state-error" style="margin-top:0">{{ err() }}</div> }
    <div class="form-grid">
      <div class="span-2"><label class="field-label">Razão social *</label><input class="input-field" [class.invalid]="fe()['name']" [(ngModel)]="f.name" />@if (fe()['name']) { <div class="field-error">{{ fe()['name'] }}</div> }</div>
      <div><label class="field-label">Nome fantasia</label><input class="input-field" [(ngModel)]="f.trade_name" /></div>
      <div><label class="field-label">CNPJ</label><input class="input-field mono" [(ngModel)]="f.cnpj" /></div>
      <div><label class="field-label">Inscrição estadual</label><input class="input-field" [(ngModel)]="f.ie" /></div>
      <div><label class="field-label">E-mail</label><input class="input-field" [class.invalid]="fe()['email']" [(ngModel)]="f.email" /></div>
      <div><label class="field-label">Telefone</label><input class="input-field" [(ngModel)]="f.phone" /></div>
      <div><label class="field-label">Cidade / UF</label><div style="display:flex;gap:6px"><input class="input-field" [(ngModel)]="f.address.cidade" /><input class="input-field" style="width:60px" maxlength="2" [(ngModel)]="f.address.uf" /></div></div>
      <div class="span-2"><label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.active" /> Ativo</label></div>
    </div>
    <div footer><button class="btn-secondary" (click)="open.set(false)">Cancelar</button>@if (auth.can('cadastros.editar')) { <button class="btn-primary" [disabled]="saving()" (click)="save()">Salvar</button> }</div>
  </ax-modal>`,
})
export class FornecedoresPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly list = new ListState<any>((q) => this.api.get('/suppliers', q));
  readonly open = signal(false); readonly saving = signal(false); readonly err = signal(''); readonly fe = signal<Record<string, string>>({});
  f: any = { address: {} }; q = ''; private t: any;
  ngOnInit() { this.list.load(); }
  search() { clearTimeout(this.t); this.t = setTimeout(() => { this.list.query = { q: this.q }; this.list.load(1); }, 300); }
  edit(s: any) { this.f = { active: true, ...s, address: { ...(s.address || {}) } }; this.err.set(''); this.fe.set({}); this.open.set(true); }
  async save() {
    this.saving.set(true); this.err.set(''); this.fe.set({});
    const body = { name: this.f.name, trade_name: this.f.trade_name, cnpj: (this.f.cnpj || '').replace(/\D/g, '') || undefined, ie: this.f.ie, email: this.f.email, phone: this.f.phone, address: this.f.address, active: this.f.active };
    try {
      if (this.f.id) await this.api.put('/suppliers/' + this.f.id, body); else await this.api.post('/suppliers', body);
      this.toast.success('Fornecedor salvo.'); this.open.set(false); this.list.reload();
    } catch (e: any) { this.err.set(e.message); if (e instanceof ApiError) this.fe.set(e.fieldErrors); } finally { this.saving.set(false); }
  }
}

// ─── Cadastros auxiliares (marcas, coleções, categorias, cores, grades, formas de pagamento) ──
type AuxTab = 'marcas' | 'colecoes' | 'categorias' | 'cores' | 'tamanhos' | 'pagamentos';
const AUX: Record<AuxTab, { label: string; path: string; cols: { key: string; label: string; type?: string; options?: { v: string; l: string }[] }[]; editPerm: string }> = {
  marcas: { label: 'Marcas', path: '/brands', editPerm: 'cadastros.editar', cols: [{ key: 'name', label: 'Marca' }] },
  colecoes: { label: 'Coleções', path: '/collections', editPerm: 'cadastros.editar', cols: [{ key: 'name', label: 'Coleção' }, { key: 'season', label: 'Estação' }, { key: 'year', label: 'Ano', type: 'number' }, { key: 'starts_on', label: 'Início', type: 'date' }, { key: 'ends_on', label: 'Fim', type: 'date' }] },
  categorias: { label: 'Categorias', path: '/categories', editPerm: 'cadastros.editar', cols: [{ key: 'name', label: 'Categoria' }] },
  cores: { label: 'Cores', path: '/colors', editPerm: 'cadastros.editar', cols: [{ key: 'name', label: 'Cor' }, { key: 'code', label: 'Código (SKU)' }, { key: 'hex', label: 'Cor (hex)', type: 'color' }] },
  tamanhos: { label: 'Grades e Tamanhos', path: '/sizes', editPerm: 'cadastros.editar', cols: [{ key: 'grid', label: 'Grade' }, { key: 'code', label: 'Tamanho' }, { key: 'sort', label: 'Ordem', type: 'number' }] },
  pagamentos: { label: 'Formas de Pagamento', path: '/payment-methods', editPerm: 'config.editar', cols: [
    { key: 'name', label: 'Nome' }, { key: 'kind', label: 'Tipo', type: 'select', options: Object.entries(PAYMENT_LABEL).slice(0, 9).map(([v, l]) => ({ v, l })) },
    { key: 'fee_pct', label: 'Taxa %', type: 'number' }, { key: 'settlement_days', label: 'Prazo (dias)', type: 'number' }, { key: 'max_installments', label: 'Máx. parcelas', type: 'number' }] },
};

@Component({
  selector: 'ax-auxiliares',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header">
      <div style="flex:1"><h1>Cadastros de Produto</h1><p>{{ auth.has('grade') ? 'Marcas, coleções, categorias, cores, grades de tamanho e formas de pagamento' : 'Marcas, categorias e formas de pagamento' }}</p></div>
      @if (auth.can(cfg().editPerm)) { <button class="btn-primary" style="font-size:12px" (click)="edit({})"><ax-icon name="plus" [size]="13" /> Novo registro</button> }
    </div>
    <div class="tabs-bar">@for (t of tabs; track t) { <div class="tab-item" [class.active]="tab() === t" (click)="setTab(t)">{{ t === 'cores' ? auth.term('cores') : t === 'tamanhos' ? 'Grades e ' + auth.term('tamanhos') : t === 'colecoes' ? auth.term('colecoes') : AUX[t].label }}</div> }</div>
    <div style="flex:1;overflow-y:auto;padding:20px">
      @if (tab() === 'tamanhos') { <div class="state-info" style="margin-bottom:12px"><ax-icon name="info" [size]="14" />A ordem define a sequência na grade (ex.: PP, P, M, G). Use grades diferentes para numeração de calças, calçados e tamanho único.</div> }
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr>@for (c of cfg().cols; track c.key) { <th>{{ c.label }}</th> }<th>Status</th><th style="width:90px"></th></tr></thead>
          <tbody>
            @for (r of rows(); track r.id) {
              <tr>
                @for (c of cfg().cols; track c.key) {
                  <td>
                    @if (c.type === 'color') { <span style="display:inline-flex;align-items:center;gap:6px"><span [style.background]="r[c.key] || '#fff'" style="width:14px;height:14px;border-radius:50%;border:1px solid #DCE4EC"></span><span class="mono" style="font-size:12px">{{ r[c.key] || '—' }}</span></span> }
                    @else if (c.key === 'kind') { {{ label(r.kind) }} }
                    @else { {{ r[c.key] ?? '—' }} }
                  </td>
                }
                <td><span class="badge" [class]="r.active ? 'badge badge-success' : 'badge badge-muted'">{{ r.active ? 'Ativo' : 'Inativo' }}</span></td>
                <td>@if (auth.can(cfg().editPerm)) {
                  <button class="btn-ghost" style="padding:3px 5px" (click)="edit(r)" title="Editar"><ax-icon name="pencil" [size]="13" /></button>
                  @if (r.active) { <button class="btn-ghost" style="padding:3px 5px;color:#C93636" (click)="inactivate(r)" title="Inativar"><ax-icon name="ban" [size]="13" /></button> }
                }</td>
              </tr>
            }
          </tbody>
        </table>
        <ax-state [loading]="loading()" [error]="error()" [empty]="!loading() && !rows().length" />
      </div>
    </div>
  </div>
  <ax-modal [(open)]="open" [title]="(f.id ? 'Editar ' : 'Novo registro — ') + cfg().label" icon="tag">
    @if (err()) { <div class="state-error" style="margin-top:0">{{ err() }}</div> }
    <div class="form-grid">
      @for (c of cfg().cols; track c.key) {
        <div>
          <label class="field-label">{{ c.label }}</label>
          @if (c.type === 'select') { <select class="input-field" [(ngModel)]="f[c.key]">@for (o of c.options; track o.v) { <option [value]="o.v">{{ o.l }}</option> }</select> }
          @else if (c.type === 'color') { <div style="display:flex;gap:6px"><input type="color" [(ngModel)]="f[c.key]" style="width:40px;height:34px;border:1px solid #DCE4EC;border-radius:6px" /><input class="input-field mono" [(ngModel)]="f[c.key]" /></div> }
          @else { <input class="input-field" [type]="c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text'" [(ngModel)]="f[c.key]" /> }
        </div>
      }
      <div><label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:22px"><input type="checkbox" [(ngModel)]="f.active" /> Ativo</label></div>
    </div>
    <div footer><button class="btn-secondary" (click)="open.set(false)">Cancelar</button><button class="btn-primary" [disabled]="saving()" (click)="save()">Salvar</button></div>
  </ax-modal>`,
})
export class AuxiliaresPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); private route = inject(ActivatedRoute);
  readonly AUX = AUX; readonly tabs = (Object.keys(AUX) as AuxTab[]).filter((t) => (t !== 'colecoes' || this.auth.has('colecoes')) && ((t !== 'cores' && t !== 'tamanhos') || this.auth.has('grade')));
  readonly tab = signal<AuxTab>('marcas'); readonly cfg = computed(() => AUX[this.tab()]);
  readonly rows = signal<any[]>([]); readonly loading = signal(false); readonly error = signal<string | null>(null);
  readonly open = signal(false); readonly saving = signal(false); readonly err = signal('');
  f: any = {};
  ngOnInit() { const t = this.route.snapshot.queryParamMap.get('tab') as AuxTab; if (t && AUX[t]) this.tab.set(t); this.load(); }
  setTab(t: AuxTab) { this.tab.set(t); this.load(); }
  label(k: string) { return PAYMENT_LABEL[k] || k; }
  async load() {
    this.loading.set(true); this.error.set(null);
    try { this.rows.set((await this.api.get<any>(this.cfg().path, { size: 500 })).items); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); }
  }
  edit(r: any) { this.f = { active: true, ...(this.tab() === 'pagamentos' && !r.id ? { kind: 'outro', max_installments: 1 } : {}), ...r }; this.err.set(''); this.open.set(true); }
  async save() {
    this.saving.set(true); this.err.set('');
    const body: any = { active: this.f.active };
    for (const c of this.cfg().cols) { const v = this.f[c.key]; body[c.key] = v === '' ? undefined : c.type === 'number' && v !== undefined && v !== null ? Number(v) : v; }
    try {
      if (this.f.id) await this.api.put(this.cfg().path + '/' + this.f.id, body); else await this.api.post(this.cfg().path, body);
      this.toast.success('Registro salvo.'); this.open.set(false); this.load();
    } catch (e: any) { this.err.set(e.message + (e.details ? ' ' + (e.details || []).map((d: any) => d.message).join(' ') : '')); } finally { this.saving.set(false); }
  }
  async inactivate(r: any) {
    if (!confirm(`Inativar "${r.name || r.code}"? Ele deixa de aparecer nos cadastros, mas o histórico é preservado.`)) return;
    try { await this.api.delete(this.cfg().path + '/' + r.id); this.toast.success('Registro inativado.'); this.load(); } catch (e) { this.toast.error(e); }
  }
}
