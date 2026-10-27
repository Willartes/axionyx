import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CustomerPickerComponent, ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';
import { NewWorkOrderComponent } from './new-wo.component';
import { VEHICLE_TYPE, WO_STATUS, formatPlate } from './oficina-shared';

/** Veículos atendidos: busca por placa, histórico de OS, quilometragem e revisões previstas. */
@Component({
  selector: 'ax-veiculos',
  imports: [FormsModule, IconComponent, ModalComponent, PagerComponent, StateComponent, CustomerPickerComponent, NewWorkOrderComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .plate { font-family:'JetBrains Mono',monospace; font-weight:700; letter-spacing:.06em; background:#F1F4F7; border:1px solid #CBD6E1; border-radius:6px; padding:1px 7px; font-size:12px; white-space:nowrap; }
    .kv { display:flex; justify-content:space-between; gap:12px; font-size:12.5px; padding:5px 0; border-bottom:1px dashed #EEF2F6; }
    .kv span:first-child { color:#647687; }
    .sec { font-size:11px; font-weight:700; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin:14px 0 8px; }
  `],
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A">Veículos</h1><p style="font-size:13px;color:#647687">Carros e motos atendidos, com histórico por placa e revisões previstas</p></div>
      @if (auth.can('oficina.editar')) { <button class="btn-primary" (click)="edit(null)"><ax-icon name="plus" [size]="13" /> Novo veículo</button> }
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px"><input class="input-field" style="max-width:320px" placeholder="Placa, modelo, marca ou cliente" [(ngModel)]="q" (keyup.enter)="page.set(1); load()" /><button class="btn-secondary" (click)="page.set(1); load()"><ax-icon name="search" [size]="13" /> Buscar</button></div>
    <div class="card" style="overflow:hidden">
      <ax-state [loading]="loading()" [empty]="!loading() && !items().length" emptyText="Nenhum veículo encontrado." emptyIcon="car" />
      @if (items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Placa</th><th>Veículo</th><th>Cliente</th><th class="num">Km</th><th class="num">OS</th><th>Última visita</th><th>Revisão</th><th></th></tr></thead>
          <tbody>@for (v of items(); track v.id) {
            <tr style="cursor:pointer" (click)="open(v)">
              <td><span class="plate">{{ fp(v.plate) }}</span></td>
              <td><ax-icon [name]="vt(v.type).icon" [size]="14" color="#647687" /> {{ v.brand }} {{ v.model }} {{ v.year_model || '' }}</td>
              <td>{{ v.customer_name || '—' }}</td><td class="num">{{ v.km_current ? (v.km_current | num) : '—' }}</td><td class="num">{{ v.orders }}</td>
              <td style="font-size:12px">{{ v.last_visit ? (v.last_visit | dt) : '—' }}</td>
              <td>@if (v.reminders_due) { <span class="badge badge-warning">Revisão próxima</span> } @else { <span class="muted" style="font-size:12px">—</span> }</td>
              <td><button class="btn-ghost" style="font-size:12px" (click)="$event.stopPropagation(); open(v)">Abrir</button></td></tr>
          }</tbody></table></div>
      }
    </div>
    @if (pages() > 1) { <ax-pager [page]="page()" [pages]="pages()" [total]="total()" (go)="page.set($event); load()" /> }
  </div>

  <ax-modal [(open)]="detOpen" [title]="det() ? fp(det().plate) + ' · ' + (det().brand || '') + ' ' + det().model : 'Veículo'" icon="car" [width]="820">
    @if (det(); as v) {
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        @if (auth.can('oficina.editar')) { <button class="btn-primary" (click)="newWo(v)"><ax-icon name="wrench" [size]="13" /> Nova OS para este veículo</button><button class="btn-secondary" (click)="edit(v)"><ax-icon name="pencil" [size]="13" /> Editar</button> }
      </div>
      <div class="form-grid-2">
        <div><div class="sec">Veículo</div>
          <div class="kv"><span>Tipo</span><span>{{ vt(v.type).label }}</span></div><div class="kv"><span>Ano</span><span>{{ v.year_fab || '—' }}/{{ v.year_model || '—' }}</span></div>
          <div class="kv"><span>Cor</span><span>{{ v.color || '—' }}</span></div><div class="kv"><span>Combustível</span><span>{{ v.fuel || '—' }}</span></div>
          <div class="kv"><span>Motor</span><span>{{ v.engine || '—' }}</span></div><div class="kv"><span>Chassi</span><span class="mono">{{ v.vin || '—' }}</span></div>
          <div class="kv"><span>Quilometragem</span><span>{{ v.km_current ? (v.km_current | num) + ' km' : '—' }}</span></div></div>
        <div><div class="sec">Cliente</div>
          <div class="kv"><span>Nome</span><span>{{ v.customer_name || '—' }}</span></div><div class="kv"><span>WhatsApp</span><span>{{ v.whatsapp ? (v.whatsapp | phone) : '—' }}</span></div>
          <div class="kv"><span>Telefone</span><span>{{ v.phone ? (v.phone | phone) : '—' }}</span></div>
          @if (v.notes) { <div style="font-size:12.5px;margin-top:8px">{{ v.notes }}</div> }</div>
      </div>
      <div class="sec">Revisões previstas</div>
      @for (r of v.reminders; track r.id) {
        <div style="font-size:12.5px;padding:6px 0;border-bottom:1px dashed #EEF2F6;display:flex;gap:8px;align-items:center" [style.opacity]="r.status === 'aberto' ? 1 : .55">
          <ax-icon name="calendar-clock" [size]="13" [color]="r.status === 'aberto' ? '#D99000' : '#8796A5'" /><span style="flex:1"><b>{{ r.description }}</b>{{ r.due_km ? ' · aos ' + (r.due_km | num) + ' km' : '' }}{{ r.due_date ? ' · até ' + (r.due_date | dt) : '' }}</span>
          <span class="muted" style="font-size:11px">{{ r.status === 'aberto' ? 'em aberto' : r.status }}{{ r.work_order_number ? ' · OS ' + r.work_order_number : '' }}</span></div>
      } @empty { <div class="muted" style="font-size:12.5px">Nenhuma revisão prevista. Serviços com "revisão a cada km/dias" geram lembretes na entrega.</div> }
      <div class="sec">Histórico de ordens de serviço</div>
      @for (o of v.orders; track o.id) {
        <div style="font-size:12.5px;padding:8px 0;border-bottom:1px dashed #EEF2F6;cursor:pointer" (click)="detOpen.set(false); router.navigate(['/os-detail', o.id])">
          <div style="display:flex;gap:8px;align-items:center"><b>OS {{ o.number }}</b><span class="badge" [class]="'badge ' + ws(o.status).cls">{{ ws(o.status).label }}</span><span class="muted">{{ o.created_at | dt }}{{ o.km_in ? ' · ' + (o.km_in | num) + ' km' : '' }}</span><span style="margin-left:auto"><b>{{ o.total | brl }}</b></span></div>
          <div class="muted" style="margin-top:2px">{{ o.items || o.complaint || '—' }}{{ o.warranty_until ? ' · garantia até ' + (o.warranty_until | dt) : '' }}</div></div>
      } @empty { <div class="muted" style="font-size:12.5px">Nenhuma OS ainda.</div> }
    }
  </ax-modal>

  <ax-modal [(open)]="formOpen" [title]="f.id ? 'Editar veículo' : 'Novo veículo'" icon="car" [width]="720">
    <div style="margin-bottom:10px"><label class="field-label">Cliente (proprietário)</label><ax-customer-picker [(value)]="owner" /></div>
    <div class="form-grid-3">
      <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="f.type">@for (t of types; track t[0]) { <option [value]="t[0]">{{ t[1].label }}</option> }</select></div>
      <div><label class="field-label">Placa</label><input class="input-field mono" style="text-transform:uppercase" maxlength="8" [(ngModel)]="f.plate" placeholder="ABC1D23" /></div>
      <div><label class="field-label">Marca</label><input class="input-field" [(ngModel)]="f.brand" /></div>
      <div><label class="field-label">Modelo *</label><input class="input-field" [(ngModel)]="f.model" /></div>
      <div><label class="field-label">Versão</label><input class="input-field" [(ngModel)]="f.version" /></div>
      <div><label class="field-label">Cor</label><input class="input-field" [(ngModel)]="f.color" /></div>
      <div><label class="field-label">Ano fabricação</label><input class="input-field mono" type="number" [(ngModel)]="f.yearFab" /></div>
      <div><label class="field-label">Ano modelo</label><input class="input-field mono" type="number" [(ngModel)]="f.yearModel" /></div>
      <div><label class="field-label">Combustível</label><select class="input-field" [(ngModel)]="f.fuel"><option value="">—</option>@for (x of fuels; track x) { <option [value]="x">{{ x }}</option> }</select></div>
      <div><label class="field-label">Motor</label><input class="input-field" [(ngModel)]="f.engine" placeholder="Ex.: 1.0 turbo, 160 cc" /></div>
      <div><label class="field-label">Chassi</label><input class="input-field mono" style="text-transform:uppercase" maxlength="20" [(ngModel)]="f.vin" /></div>
      <div><label class="field-label">Quilometragem</label><input class="input-field mono" type="number" min="0" [(ngModel)]="f.kmCurrent" /></div>
      <div class="span-3"><label class="field-label">Observações</label><textarea class="input-field" rows="2" [(ngModel)]="f.notes"></textarea></div>
    </div>
    <div footer><button class="btn-secondary" (click)="formOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="save()" [disabled]="busy()">Salvar</button></div>
  </ax-modal>
  <ax-new-wo [(open)]="woOpen" [presetVehicle]="woVehicle()" (created)="router.navigate(['/os-detail', $event])" />`,
})
export class VeiculosPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly router = inject(Router);
  readonly items = signal<any[]>([]); readonly loading = signal(true); readonly page = signal(1); readonly pages = signal(1); readonly total = signal(0); readonly busy = signal(false);
  readonly detOpen = signal(false); readonly det = signal<any>(null); readonly formOpen = signal(false); readonly owner = signal<any>(null);
  readonly woOpen = signal(false); readonly woVehicle = signal<any>(null);
  q = ''; f: any = {};
  readonly types = Object.entries(VEHICLE_TYPE); readonly fuels = ['Flex', 'Gasolina', 'Etanol', 'Diesel', 'GNV', 'Elétrico', 'Híbrido'];
  readonly vt = (t: string) => VEHICLE_TYPE[t] ?? VEHICLE_TYPE['carro']; readonly ws = (s: string) => WO_STATUS[s] ?? WO_STATUS['orcamento']; readonly fp = formatPlate;
  ngOnInit() { this.load(); }
  async load() {
    this.loading.set(true);
    try { const r = await this.api.get<any>('/vehicles', { q: this.q, page: this.page() }); this.items.set(r.items); this.pages.set(r.pages); this.total.set(r.total); }
    catch (e) { this.toast.error(e); } finally { this.loading.set(false); }
  }
  async open(v: any) { try { this.det.set(await this.api.get('/vehicles/' + v.id)); this.detOpen.set(true); } catch (e) { this.toast.error(e); } }
  async edit(v: any) {
    this.f = v ? { id: v.id, type: v.type, plate: v.plate || '', brand: v.brand || '', model: v.model, version: v.version || '', color: v.color || '', yearFab: v.year_fab, yearModel: v.year_model, fuel: v.fuel || '', engine: v.engine || '', vin: v.vin || '', kmCurrent: v.km_current, notes: v.notes || '' }
      : { type: 'carro', plate: '', model: '' };
    this.owner.set(null);
    if (v?.customer_id) { try { this.owner.set(await this.api.get('/customers/' + v.customer_id)); } catch { /* */ } }
    this.formOpen.set(true);
  }
  async save() {
    const f = this.f; const n = (x: any) => (x === '' || x === null || x === undefined ? undefined : Number(x)); const s = (x: any) => (x ? String(x) : undefined);
    const body = { customerId: this.owner()?.id, type: f.type, plate: s(f.plate), brand: s(f.brand), model: f.model, version: s(f.version), color: s(f.color), yearFab: n(f.yearFab), yearModel: n(f.yearModel),
      fuel: s(f.fuel), engine: s(f.engine), vin: s(f.vin), kmCurrent: n(f.kmCurrent), notes: s(f.notes) };
    this.busy.set(true);
    try { if (f.id) await this.api.put('/vehicles/' + f.id, body); else await this.api.post('/vehicles', body); this.toast.success('Veículo salvo.'); this.formOpen.set(false); this.load(); if (f.id && this.detOpen()) this.open({ id: f.id }); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  newWo(v: any) { this.woVehicle.set(v); this.detOpen.set(false); this.woOpen.set(true); }
}
