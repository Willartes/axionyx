import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT } from '../../core/format';

/** Catálogo de serviços (com duração, comissão e retorno sugerido) e pacotes de sessões. */
@Component({
  selector: 'ax-servicos',
  imports: [FormsModule, IconComponent, ModalComponent, PagerComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">{{ auth.term('servicos') }} e Pacotes</h1>
        <p style="font-size:13px;color:#647687">Serviços com duração para a agenda, comissão e intervalo de retorno; pacotes de sessões com saldo na ficha do cliente</p></div>
      @if (auth.can('servicos.editar')) { <button class="btn-primary" style="font-size:12px" (click)="openNew()"><ax-icon name="plus" [size]="13" /> {{ tab() === 0 ? 'Novo serviço' : 'Novo pacote' }}</button> }
    </div>
    <div class="tabs-bar" style="margin:0 0 14px">
      <div class="tab-item" [class.active]="tab() === 0" (click)="setTab(0)">{{ auth.term('servicos') }}</div>
      @if (auth.has('pacotes')) { <div class="tab-item" [class.active]="tab() === 1" (click)="setTab(1)">Pacotes de sessões</div> }
    </div>
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #EEF2F6;flex-wrap:wrap">
        <input class="input-field" style="max-width:260px" placeholder="Buscar por nome ou código…" [(ngModel)]="q" (keyup.enter)="reload()" />
        <span class="chip" [class.active]="active === 'true'" (click)="active = 'true'; reload()">Ativos</span>
        <span class="chip" [class.active]="active === 'false'" (click)="active = 'false'; reload()">Inativos</span>
      </div>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" [emptyText]="tab() === 0 ? 'Nenhum serviço cadastrado. Cadastre os serviços com duração e preço para usar a agenda.' : 'Nenhum pacote cadastrado.'" (retry)="list.reload()" />
      @if (list.items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Código</th><th>Nome</th><th>Categoria</th>
            @if (tab() === 0) { <th class="num">Duração</th><th class="num">Comissão</th><th class="num">Retorno</th> } @else { <th>Serviço incluído</th><th class="num">Sessões</th><th class="num">Validade</th> }
            <th class="num">Preço</th><th class="num">Vendidos 90 d</th><th></th></tr></thead>
          <tbody>@for (s of list.items(); track s.id) {
            <tr [style.opacity]="s.active ? 1 : .55">
              <td class="mono" style="font-size:12px">{{ s.code }}</td><td style="font-weight:500">{{ s.name }}</td><td>{{ s.category || '—' }}</td>
              @if (tab() === 0) {
                <td class="num">{{ s.duration_min ? s.duration_min + ' min' : 'padrão' }}</td>
                <td class="num">{{ s.commission_pct !== null ? (s.commission_pct | pct:1) : 'do profissional' }}</td>
                <td class="num">{{ s.return_days ? s.return_days + ' dias' : 'automático' }}</td>
              } @else {
                <td>{{ s.package_service }}</td><td class="num">{{ s.package_sessions }}</td><td class="num">{{ s.package_validity_days ? s.package_validity_days + ' dias' : 'sem validade' }}</td>
              }
              <td class="num" style="font-weight:600">{{ s.sale_price | brl }}@if (tab() === 1 && s.package_sessions) { <div style="font-size:10.5px;color:#647687;font-weight:400">{{ s.sale_price / s.package_sessions | brl }}/sessão</div> }</td>
              <td class="num">{{ s.sold_90d | num }}</td>
              <td>@if (auth.can('servicos.editar')) { <button class="btn-ghost" style="font-size:12px" (click)="openEdit(s)"><ax-icon name="pencil" [size]="12" /> Editar</button> }</td>
            </tr>
          }</tbody></table></div>
        <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
      }
    </div>
    <p style="font-size:11px;color:#647687;margin-top:8px">
      Serviços não movimentam estoque e não entram na NFC-e (serviços são tributados pelo ISS e documentados por NFS-e da prefeitura). Comissão: a do serviço vale para todos os profissionais, salvo percentual específico no cadastro do profissional.
      Retorno “automático”: a Inteligência de Serviços calcula o intervalo típico pelo histórico dos clientes.</p>
  </div>

  <ax-modal [(open)]="formOpen" [title]="(form.id ? 'Editar ' : 'Novo ') + (form.kind === 'pacote' ? 'pacote' : 'serviço')" [icon]="form.kind === 'pacote' ? 'ticket' : 'scissors'" [width]="560">
    <div style="display:grid;grid-template-columns:1fr 130px;gap:10px">
      <div><label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="form.name" /></div>
      <div><label class="field-label">Código</label><input class="input-field mono" [(ngModel)]="form.code" [disabled]="!!form.id" placeholder="automático" /></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <div><label class="field-label">Categoria</label><select class="input-field" [(ngModel)]="form.category_id"><option [ngValue]="null">—</option>@for (c of lk.data()?.categories ?? []; track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }</select></div>
      <div><label class="field-label">Preço (R$) *</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="form.sale_price" /></div>
    </div>
    @if (form.kind === 'servico') {
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
        <div><label class="field-label">Duração (min)</label><input type="number" min="5" step="5" class="input-field mono" [(ngModel)]="form.duration_min" /></div>
        <div><label class="field-label">Comissão (%)</label><input type="number" min="0" max="100" step="0.5" class="input-field mono" [(ngModel)]="form.commission_pct" placeholder="do profissional" /></div>
        <div><label class="field-label">Retorno sugerido (dias)</label><input type="number" min="1" class="input-field mono" [(ngModel)]="form.return_days" placeholder="automático" /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
        @if (auth.can('produtos.custo')) { <div><label class="field-label">Custo de material (R$)</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="form.cost_price" /></div> }
        <div><label class="field-label">Código do serviço (LC 116 / NFS-e)</label><input class="input-field mono" [(ngModel)]="form.service_code" placeholder="ex.: 06.01" /></div>
      </div>
    } @else {
      <div style="display:grid;grid-template-columns:1fr 110px 130px;gap:10px;margin-top:10px">
        <div><label class="field-label">Serviço incluído *</label><select class="input-field" [(ngModel)]="form.package_service_id"><option [ngValue]="null">Selecione…</option>@for (s of servicesList(); track s.id) { <option [ngValue]="s.id">{{ s.name }} ({{ s.sale_price | brl }})</option> }</select></div>
        <div><label class="field-label">Sessões *</label><input type="number" min="1" class="input-field mono" [(ngModel)]="form.package_sessions" /></div>
        <div><label class="field-label">Validade (dias)</label><input type="number" min="1" class="input-field mono" [(ngModel)]="form.package_validity_days" placeholder="sem validade" /></div>
      </div>
      @if (economy(); as e) { <div style="font-size:12px;color:#18864B;margin-top:6px">{{ e }}</div> }
      <p style="font-size:11px;color:#647687;margin-top:6px">O saldo de sessões fica na ficha do cliente. A cada atendimento com o pacote, uma sessão é baixada e a comissão do profissional é calculada sobre o valor da sessão.</p>
    }
    <label class="field-label" style="margin-top:10px">Descrição</label><textarea class="input-field" rows="2" [(ngModel)]="form.description"></textarea>
    @if (form.id) { <label style="display:flex;gap:6px;align-items:center;font-size:12.5px;margin-top:8px"><input type="checkbox" [(ngModel)]="form.active" /> Ativo</label> }
    <div footer><button class="btn-secondary" (click)="formOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="save()">Salvar</button></div>
  </ax-modal>`,
})
export class ServicosPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tab = signal(0); readonly formOpen = signal(false); readonly servicesList = signal<any[]>([]);
  q = ''; active = 'true'; form: any = {};
  readonly list = new ListState<any>((q) => this.api.get('/services', { ...q, kind: this.tab() === 1 ? 'pacote' : 'servico', q: this.q || undefined, active: this.active }));
  ngOnInit() { this.lk.ensure(); this.list.load(); }
  setTab(i: number) { this.tab.set(i); this.list.load(1); }
  reload() { this.list.load(1); }
  async loadServices() { try { const r: any = await this.api.get('/services', { kind: 'servico', size: 500 }); this.servicesList.set(r.items); } catch { /* */ } }
  openNew() {
    this.form = { kind: this.tab() === 1 ? 'pacote' : 'servico', name: '', code: '', category_id: null, sale_price: null, duration_min: this.auth.me()?.settings?.agenda?.intervaloMin ?? 30, commission_pct: null, return_days: null, cost_price: 0, service_code: '',
      package_service_id: null, package_sessions: 4, package_validity_days: 180, description: '' };
    if (this.form.kind === 'pacote') this.loadServices();
    this.formOpen.set(true);
  }
  openEdit(s: any) { this.form = { ...s, kind: s.kind, cost_price: s.cost_price ?? undefined }; if (s.kind === 'pacote') this.loadServices(); this.formOpen.set(true); }
  economy() {
    const f = this.form; const svc = this.servicesList().find((x) => x.id === f.package_service_id);
    if (!svc || !f.package_sessions || !f.sale_price) return '';
    const full = Number(svc.sale_price) * f.package_sessions, diff = full - Number(f.sale_price);
    return diff > 0 ? `Economia para o cliente: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(diff)} (${Math.round((diff / full) * 100)}% sobre ${f.package_sessions} sessões avulsas).` : '';
  }
  async save() {
    const f = this.form;
    const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));
    const body: any = { name: f.name, category_id: f.category_id || null, sale_price: Number(f.sale_price || 0), description: f.description || undefined };
    if (f.kind === 'servico') Object.assign(body, { duration_min: num(f.duration_min), commission_pct: num(f.commission_pct), return_days: num(f.return_days), service_code: f.service_code || null, ...(this.auth.can('produtos.custo') ? { cost_price: Number(f.cost_price || 0) } : {}) });
    else Object.assign(body, { package_service_id: f.package_service_id, package_sessions: num(f.package_sessions), package_validity_days: num(f.package_validity_days) });
    try {
      if (f.id) await this.api.put(`/services/${f.id}`, { ...body, active: !!f.active });
      else await this.api.post('/services', { ...body, kind: f.kind, code: f.code || undefined });
      this.toast.success('Salvo.'); this.formOpen.set(false); this.list.reload();
    } catch (e) { this.toast.error(e); }
  }
}
