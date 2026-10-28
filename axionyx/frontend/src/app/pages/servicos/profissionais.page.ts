import { COUNCILS, SPECIALTIES, UFS } from '../saude/saude-shared';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, PagerComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, todayIso, STATUS_PIPES } from '../../core/format';

const DAYS = [['1', 'Seg'], ['2', 'Ter'], ['3', 'Qua'], ['4', 'Qui'], ['5', 'Sex'], ['6', 'Sáb'], ['0', 'Dom']];
const COLORS = ['#0875D1', '#18864B', '#D99000', '#C93636', '#7A4CC2', '#00A6D6', '#D2558F', '#4B5E71'];
const KIND: Record<string, string> = { servico: 'Serviço', produto: 'Produto', sessao_pacote: 'Sessão de pacote' };

/** Profissionais (com usuário opcional — o gerente pode ser também profissional), expediente, serviços e comissões. */
@Component({
  selector: 'ax-profissionais',
  imports: [FormsModule, IconComponent, ModalComponent, PagerComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .pcard { background:white; border:1px solid #DCE4EC; border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:8px; }
    .hours-row { display:grid; grid-template-columns:52px 1fr; gap:8px; align-items:center; padding:5px 0; border-bottom:1px solid #F3F6F9; }
    .iv { display:inline-flex; align-items:center; gap:4px; margin:2px 6px 2px 0; }
    .iv input { width:92px; padding:4px 6px; font-size:12px; }
  `],
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">{{ auth.term('profissionais') }} e Comissões</h1>
        <p style="font-size:13px;color:#647687">Quem atende na agenda — inclusive o gerente ou dono que também atende —, expediente, serviços executados e comissões</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        @if (auth.can('profissionais.editar') && !mine()) { <button class="btn-secondary" style="font-size:12px" (click)="linkMe()"><ax-icon name="user-check" [size]="13" /> Eu também atendo</button> }
        @if (auth.can('profissionais.editar')) { <button class="btn-primary" style="font-size:12px" (click)="openNew()"><ax-icon name="plus" [size]="13" /> Novo profissional</button> }
      </div>
    </div>
    <div class="tabs-bar" style="margin:0 0 14px">
      <div class="tab-item" [class.active]="tab() === 0" (click)="tab.set(0)">{{ auth.term('profissionais') }}</div>
      @if (auth.can('comissoes.ver')) { <div class="tab-item" [class.active]="tab() === 1" (click)="tab.set(1); loadComm()">Comissões</div> }
    </div>

    @if (tab() === 0) {
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px">
        @for (p of items(); track p.id) {
          <div class="pcard" [style.opacity]="p.active ? 1 : .55">
            <div style="display:flex;gap:10px;align-items:center">
              <div [style.background]="p.color" style="width:38px;height:38px;border-radius:50%;color:white;display:flex;align-items:center;justify-content:center;font-weight:700">{{ initials(p.name) }}</div>
              <div style="flex:1;min-width:0"><div style="font-weight:600">{{ p.name }} @if (p.id === mine()) { <span class="badge badge-info">você</span> }</div>
                <div style="font-size:12px;color:#647687">{{ p.specialty || '—' }}{{ p.council_id ? ' · ' + p.council_id : '' }}</div></div>
            </div>
            <div style="font-size:12px;color:#475B6E">
              <div><ax-icon name="user" [size]="11" /> {{ p.user_name ? 'Usuário: ' + p.user_name : 'Sem acesso ao sistema' }}</div>
              <div><ax-icon name="clock" [size]="11" /> {{ hoursSummary(p) }}</div>
              <div><ax-icon name="percent" [size]="11" /> Serviços {{ p.commission_services_pct | pct:1 }} · Produtos {{ p.commission_products_pct | pct:1 }}</div>
              <div><ax-icon name="scissors" [size]="11" /> {{ p.services.length ? p.services.length + ' serviço(s) específico(s)' : 'Executa todos os serviços' }}</div>
            </div>
            @if (auth.can('profissionais.editar')) { <button class="btn-secondary" style="font-size:12px;justify-content:center" (click)="openEdit(p)"><ax-icon name="pencil" [size]="12" /> Editar</button> }
          </div>
        } @empty {
          <div class="card" style="padding:24px;grid-column:1 / -1;text-align:center;color:#647687">Nenhum profissional cadastrado. Se você também atende, use “Eu também atendo”.</div>
        }
      </div>
    }

    @if (tab() === 1) {
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px">
        <div><label class="field-label">De</label><input type="date" class="input-field" [(ngModel)]="from" (change)="loadComm()" /></div>
        <div><label class="field-label">Até</label><input type="date" class="input-field" [(ngModel)]="to" (change)="loadComm()" /></div>
        <div><label class="field-label">Situação</label><select class="input-field" [(ngModel)]="cstatus" (ngModelChange)="loadComm()"><option value="">Todas</option><option value="prevista">Em aberto</option><option value="paga">Fechadas</option></select></div>
      </div>
      @if (comm(); as C) {
        <div class="card" style="overflow:hidden;margin-bottom:12px">
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>{{ auth.term('profissional') }}</th><th class="num">Base</th><th class="num">Serviços</th><th class="num">Produtos</th><th class="num">Sessões de pacote</th><th class="num">Total</th><th class="num">Em aberto</th><th></th></tr></thead>
            <tbody>@for (s of C.summary; track s.id) {
              <tr><td><span [style.background]="s.color" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>{{ s.name }}</td>
                <td class="num">{{ s.base | brl }}</td><td class="num">{{ s.servicos | brl }}</td><td class="num">{{ s.produtos | brl }}</td><td class="num">{{ s.sessoes | brl }}</td>
                <td class="num" style="font-weight:700">{{ s.total | brl }}</td><td class="num" [style.color]="s.aberto > 0 ? '#D99000' : null">{{ s.aberto | brl }}</td>
                <td>@if (auth.can('comissoes.editar') && s.aberto > 0) { <button class="btn-ghost" style="font-size:11px" (click)="close(s)">Fechar e gerar conta a pagar</button> }</td></tr>
            } @empty { <tr><td colspan="8"><div class="empty-state">Sem comissões no período.</div></td></tr> }</tbody>
          </table></div>
        </div>
        <div class="card" style="overflow:hidden">
          <div style="padding:10px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Lançamentos</div>
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>Data</th><th>{{ auth.term('profissional') }}</th><th>Tipo</th><th>Descrição</th><th class="num">Base</th><th class="num">%</th><th class="num">Comissão</th><th>Situação</th></tr></thead>
            <tbody>@for (r of C.items; track r.id) {
              <tr><td>{{ r.created_at | dtt }}</td><td>{{ r.professional }}</td><td>{{ kind(r.kind) }}@if (r.ref_type !== 'venda' && r.ref_type !== 'sessao') { <span class="badge badge-danger" style="margin-left:4px">{{ r.ref_type }}</span> }</td>
                <td style="font-size:12px">{{ r.description }}</td><td class="num">{{ r.base_amount | brl }}</td><td class="num">{{ r.pct | num:1 }}</td><td class="num" style="font-weight:600">{{ r.amount | brl }}</td>
                <td><span class="badge" [class]="r.status | statusClass">{{ r.status === 'paga' ? 'Fechada' : 'Em aberto' }}</span></td></tr>
            }</tbody></table></div>
          <ax-pager [page]="C.page" [pages]="C.pages" [total]="C.total" (go)="loadComm($event)" />
        </div>
        <p style="font-size:11px;color:#647687;margin-top:8px">Comissão de serviço e de produto: lançada na venda (cancelamentos e devoluções estornam). Sessão de pacote: lançada quando a sessão é realizada, sobre o valor da sessão. “Fechar” marca os lançamentos e gera a conta a pagar no Financeiro.</p>
      }
    }
  </div>

  <ax-modal [(open)]="formOpen" [title]="form.id ? 'Editar profissional' : 'Novo profissional'" icon="user-cog" [width]="680">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px" class="grid-2-resp">
      <div><label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="form.name" /></div>
      <div><label class="field-label">Especialidade / função</label><input class="input-field" [(ngModel)]="form.specialty" [attr.list]="health() ? 'ax-specs' : null" [placeholder]="health() ? 'ex.: Cardiologia, Psicologia, Fisioterapia…' : 'Dentista, esteticista, cabeleireira…'" />
        <datalist id="ax-specs">@for (s of specialties; track s) { <option [value]="s"></option> }</datalist></div>
      @if (!health()) { <div><label class="field-label">Registro profissional</label><input class="input-field" [(ngModel)]="form.council_id" placeholder="ex.: CRO-SP 12345" /></div> }
      @else {
        <div style="display:grid;grid-template-columns:110px minmax(0,1fr) 80px;gap:6px"><div><label class="field-label">Conselho</label><select class="input-field" [(ngModel)]="form.council"><option [ngValue]="null">—</option>@for (c of councils; track c) { <option [value]="c">{{ c }}</option> }</select></div>
          <div><label class="field-label">Nº do registro</label><input class="input-field mono" [(ngModel)]="form.council_number" /></div>
          <div><label class="field-label">UF</label><select class="input-field" [(ngModel)]="form.council_uf"><option [ngValue]="null">—</option>@for (u of ufs; track u) { <option [value]="u">{{ u }}</option> }</select></div></div>
        <div><label class="field-label">RQE (especialista, opcional)</label><input class="input-field mono" [(ngModel)]="form.rqe" /></div>
        <label style="font-size:12px;display:flex;gap:6px;align-items:flex-start;align-self:end;padding-bottom:6px"><input type="checkbox" [(ngModel)]="form.restrict_records" style="margin-top:2px" /> <span><ax-icon name="lock" [size]="12" /> Registros sigilosos por padrão (ex.: psicologia) — só o próprio profissional vê o que escrever</span></label>
      }
      <div><label class="field-label">Acesso ao sistema (usuário)</label>
        <select class="input-field" [(ngModel)]="form.user_id"><option [ngValue]="null">Sem acesso (só agenda)</option>@for (u of lk.data()?.sellers ?? []; track u.id) { <option [ngValue]="u.id">{{ u.name }}</option> }</select></div>
      <div><label class="field-label">Telefone</label><input class="input-field" [(ngModel)]="form.phone" /></div>
      <div><label class="field-label">Filial</label><select class="input-field" [(ngModel)]="form.branch_id"><option [ngValue]="null">Todas</option>@for (b of lk.data()?.branches ?? []; track b.id) { <option [ngValue]="b.id">{{ b.name }}</option> }</select></div>
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-top:10px"><span class="field-label" style="margin:0">Cor na agenda</span>
      @for (c of colors; track c) { <span (click)="form.color = c" [style.background]="c" [style.outline]="form.color === c ? '2px solid #172B3A' : 'none'" style="width:20px;height:20px;border-radius:50%;cursor:pointer;outline-offset:2px"></span> }</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:12px">
      <div><label class="field-label">Comissão em serviços (%)</label><input type="number" min="0" max="100" step="0.5" class="input-field mono" [(ngModel)]="form.commission_services_pct" /></div>
      <div><label class="field-label">Comissão em produtos (%)</label><input type="number" min="0" max="100" step="0.5" class="input-field mono" [(ngModel)]="form.commission_products_pct" /></div>
      <div><label class="field-label">Intervalo da grade (min)</label><input type="number" min="5" max="240" step="5" class="input-field mono" [(ngModel)]="form.slot_min" /></div>
    </div>

    <div style="font-size:13px;font-weight:600;margin:14px 0 4px">Expediente</div>
    @for (d of days; track d[0]) {
      <div class="hours-row"><span style="font-size:12px;font-weight:600">{{ d[1] }}</span>
        <div>@for (iv of form.hours[d[0]]; track $index; let k = $index) {
            <span class="iv"><input type="time" class="input-field" [(ngModel)]="iv[0]" />–<input type="time" class="input-field" [(ngModel)]="iv[1]" /><button class="btn-ghost" style="padding:2px;color:#C93636" (click)="rmIv(d[0], k)" aria-label="Remover intervalo"><ax-icon name="x" [size]="12" /></button></span>
          } @empty { <span style="font-size:12px;color:#8696A7;margin-right:8px">Não atende</span> }
          <button class="btn-ghost" style="font-size:11px;padding:2px 6px" (click)="addIv(d[0])"><ax-icon name="plus" [size]="11" /> intervalo</button></div></div>
    }

    <div style="font-size:13px;font-weight:600;margin:14px 0 4px">Serviços que executa <span style="font-weight:400;font-size:12px;color:#647687">(nenhum marcado = todos)</span></div>
    <div style="max-height:200px;overflow:auto;border:1px solid #EEF2F6;border-radius:8px;padding:6px 10px">
      @for (s of services(); track s.id) {
        <div style="display:grid;grid-template-columns:1fr 110px 100px;gap:8px;align-items:center;padding:3px 0;font-size:12.5px">
          <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" [checked]="!!sel()[s.id]" (change)="toggle(s.id)" /> {{ s.name }}</label>
          @if (sel()[s.id]; as x) {
            <input type="number" class="input-field mono" style="padding:3px 6px;font-size:12px" placeholder="comissão %" [(ngModel)]="x.commission_pct" title="Comissão específica (%)" />
            <input type="number" class="input-field mono" style="padding:3px 6px;font-size:12px" placeholder="duração" [(ngModel)]="x.duration_min" title="Duração específica (min)" />
          }
        </div>
      } @empty { <div style="font-size:12px;color:#8696A7">Cadastre os serviços em “Serviços e Pacotes”.</div> }
    </div>
    @if (form.id) { <label style="display:flex;gap:6px;align-items:center;font-size:12.5px;margin-top:10px"><input type="checkbox" [(ngModel)]="form.active" /> Ativo</label> }
    <div footer><button class="btn-secondary" (click)="formOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="save()">Salvar</button></div>
  </ax-modal>`,
})
export class ProfissionaisPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly tab = signal(0); readonly items = signal<any[]>([]); readonly mine = signal<string | null>(null); readonly services = signal<any[]>([]);
  readonly formOpen = signal(false); readonly sel = signal<Record<string, { commission_pct: any; duration_min: any }>>({}); readonly comm = signal<any>(null);
  readonly health = computed(() => this.auth.has('saude')); readonly councils = COUNCILS; readonly ufs = UFS; readonly specialties = SPECIALTIES;
  readonly days = DAYS; readonly colors = COLORS; form: any = { hours: {} };
  from = todayIso().slice(0, 8) + '01'; to = todayIso(); cstatus = '';
  initials(n: string) { return n.split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase(); }
  kind(k: string) { return KIND[k] ?? k; }
  async ngOnInit() {
    this.lk.ensure(); await this.load();
    try { const r: any = await this.api.get('/services', { kind: 'servico', size: 500 }); this.services.set(r.items); } catch { /* */ }
    if (!this.auth.can(['agenda.ver', 'profissionais.editar']) && this.auth.can('comissoes.ver')) { this.tab.set(1); this.loadComm(); }
  }
  async load() { try { const r: any = await this.api.get('/professionals', { active: 'all' }); this.items.set(r.items); this.mine.set(r.mine); } catch (e) { this.toast.error(e); } }
  hoursSummary(p: any) {
    const wh = p.work_hours || {}; const on = DAYS.filter(([d]) => (wh[d] ?? []).length);
    if (!on.length) return 'Sem expediente definido (agenda livre)';
    const first = wh[on[0][0]]; return `${on.map((d) => d[1]).join(', ')} · ${first.map((iv: string[]) => iv.join('–')).join(', ')}${on.some(([d]) => JSON.stringify(wh[d]) !== JSON.stringify(first)) ? ' (varia)' : ''}`;
  }
  async linkMe() {
    try { await this.api.post('/professionals/me', {}); this.toast.success('Pronto: você aparece na agenda como profissional. Ajuste seu expediente e comissões.'); await this.load(); this.lk.invalidate(); }
    catch (e) { this.toast.error(e); }
  }
  private hoursCopy(wh: any) { const h: any = {}; for (const [d] of DAYS) h[d] = (wh?.[d] ?? []).map((iv: string[]) => [iv[0], iv[1]]); return h; }
  openNew() {
    this.form = { name: '', specialty: '', council_id: '', council: null, council_number: '', council_uf: null, rqe: '', restrict_records: false, user_id: null, phone: '', branch_id: null, color: COLORS[this.items().length % COLORS.length], commission_services_pct: 0, commission_products_pct: 0, slot_min: this.auth.me()?.settings?.agenda?.intervaloMin ?? 30,
      hours: this.hoursCopy({ 1: [['09:00', '12:00'], ['13:00', '18:00']], 2: [['09:00', '12:00'], ['13:00', '18:00']], 3: [['09:00', '12:00'], ['13:00', '18:00']], 4: [['09:00', '12:00'], ['13:00', '18:00']], 5: [['09:00', '12:00'], ['13:00', '18:00']], 6: [['09:00', '13:00']] }) };
    this.sel.set({}); this.formOpen.set(true);
  }
  openEdit(p: any) {
    this.form = { ...p, hours: this.hoursCopy(p.work_hours) };
    const s: any = {}; for (const x of p.services) s[x.product_id] = { commission_pct: x.commission_pct, duration_min: x.duration_min };
    this.sel.set(s); this.formOpen.set(true);
  }
  addIv(d: string) { const list = this.form.hours[d]; const last = list[list.length - 1]; list.push(last ? [last[1], last[1] < '18:00' ? '18:00' : '23:00'] : ['09:00', '18:00']); this.form = { ...this.form }; }
  rmIv(d: string, k: number) { this.form.hours[d].splice(k, 1); this.form = { ...this.form }; }
  toggle(id: string) { const s = { ...this.sel() }; if (s[id]) delete s[id]; else s[id] = { commission_pct: null, duration_min: null }; this.sel.set(s); }
  async save() {
    const f = this.form; const n = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));
    const work_hours: any = {}; for (const [d] of DAYS) if (f.hours[d]?.length) work_hours[d] = f.hours[d].filter((iv: string[]) => iv[0] && iv[1]);
    const body = { name: f.name, specialty: f.specialty || null, ...(this.health() ? { council: f.council || null, council_number: f.council_number || null, council_uf: f.council_uf || null, rqe: f.rqe || null, restrict_records: !!f.restrict_records } : { council_id: f.council_id || null }), user_id: f.user_id || null, phone: f.phone || null, branch_id: f.branch_id || null, color: f.color,
      commission_services_pct: Number(f.commission_services_pct || 0), commission_products_pct: Number(f.commission_products_pct || 0), slot_min: Number(f.slot_min || 30), work_hours,
      services: Object.entries(this.sel()).map(([product_id, x]) => ({ product_id, commission_pct: n(x.commission_pct), duration_min: n(x.duration_min) })), ...(f.id ? { active: !!f.active } : {}) };
    try {
      if (f.id) await this.api.put(`/professionals/${f.id}`, body); else await this.api.post('/professionals', body);
      this.toast.success('Profissional salvo.'); this.formOpen.set(false); this.load(); this.lk.invalidate();
    } catch (e) { this.toast.error(e); }
  }
  async loadComm(page = 1) { try { this.comm.set(await this.api.get('/professional-commissions', { from: this.from, to: this.to, status: this.cstatus || undefined, page })); } catch (e) { this.toast.error(e); } }
  async close(s: any) {
    if (!confirm(`Fechar ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(s.aberto)} de comissão de ${s.name} (${this.from} a ${this.to}) e gerar a conta a pagar?`)) return;
    try { const r: any = await this.api.post('/professional-commissions/close', { professionalId: s.id, from: this.from, to: this.to }, { idempotent: true }); this.toast.success(`Comissão fechada: ${r.count} lançamento(s). Conta a pagar gerada no Financeiro.`); this.loadComm(); }
    catch (e) { this.toast.error(e); }
  }
}
