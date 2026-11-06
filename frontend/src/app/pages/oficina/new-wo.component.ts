import { ChangeDetectionStrategy, Component, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { CustomerPickerComponent, ModalComponent } from '../../shared/ui';
import { NumPipe } from '../../core/format';
import { Api, newIdempotencyKey } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { AuthService } from '../../core/auth.service';
import { CHECKLIST_CARRO, CHECKLIST_MOTO, CHECK_STATE, FUEL_LEVELS, VEHICLE_TYPE, formatPlate } from './oficina-shared';

/** Abertura de OS: busca pela placa (ou pelo cliente), veículo novo na hora, km, combustível, reclamação e checklist de entrada. */
@Component({
  selector: 'ax-new-wo',
  imports: [FormsModule, IconComponent, ModalComponent, CustomerPickerComponent, NumPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .vcard { display:flex; gap:10px; align-items:center; padding:10px 12px; border:1px solid #DCE4EC; border-radius:10px; cursor:pointer; font:inherit; background:#fff; text-align:left; width:100%; }
    .vcard.on { border:2px solid #0875D1; background:#F3F8FD; }
    .plate { font-family:'JetBrains Mono',monospace; font-weight:700; letter-spacing:.06em; background:#F1F4F7; border:1px solid #CBD6E1; border-radius:6px; padding:2px 8px; font-size:13px; }
    .chk { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px 10px; align-items:center; padding:6px 0; border-bottom:1px dashed #EEF2F6; font-size:12.5px; }
    .st { display:flex; gap:4px; }
    .st button { font:inherit; font-size:11px; padding:3px 8px; border-radius:999px; border:1px solid #DCE4EC; background:#fff; cursor:pointer; color:#4A5B6B; }
    .sec { font-size:11px; font-weight:700; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin:14px 0 8px; }
    @media (max-width:640px) { .chk { grid-template-columns:minmax(0,1fr); } }
  `],
  template: `
  <ax-modal [(open)]="open" title="Nova ordem de serviço" icon="wrench" [width]="820">
    <div class="sec" style="margin-top:0">Veículo</div>
    <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      <div style="flex:1;min-width:200px"><label class="field-label">Buscar pela placa</label><input class="input-field mono" style="text-transform:uppercase" [(ngModel)]="plateQ" (keyup.enter)="findPlate()" placeholder="ABC1D23" maxlength="8" /></div>
      <button class="btn-secondary" (click)="findPlate()"><ax-icon name="search" [size]="13" /> Buscar</button>
    </div>
    <div style="margin-top:10px"><label class="field-label">Cliente *</label><ax-customer-picker [(value)]="customer" (valueChange)="onCustomer()" /></div>
    @if (customer()) {
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;margin-top:10px">
        @for (v of vehicles(); track v.id) {
          <button type="button" class="vcard" [class.on]="vehicleId === v.id" (click)="vehicleId = v.id; kmMin = v.km_current">
            <ax-icon [name]="vt(v.type).icon" [size]="18" color="#0875D1" /><div style="min-width:0"><span class="plate">{{ fp(v.plate) }}</span><div style="font-size:12.5px;margin-top:3px">{{ v.brand }} {{ v.model }} {{ v.year_model || '' }}</div>
              <div class="muted" style="font-size:11px">{{ v.km_current ? (v.km_current | num) + ' km' : 'km não informado' }}</div></div>
          </button>
        }
        <button type="button" class="vcard" [class.on]="vehicleId === 'novo'" (click)="vehicleId = 'novo'"><ax-icon name="plus" [size]="18" color="#0875D1" /><b style="font-size:12.5px">Outro veículo</b></button>
      </div>
    }
    @if (customer() && vehicleId === 'novo') {
      <div class="form-grid-3" style="margin-top:10px">
        <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="nv.type" (ngModelChange)="resetChecklist()">@for (t of types; track t[0]) { <option [value]="t[0]">{{ t[1].label }}</option> }</select></div>
        <div><label class="field-label">Placa</label><input class="input-field mono" style="text-transform:uppercase" maxlength="8" [(ngModel)]="nv.plate" /></div>
        <div><label class="field-label">Marca</label><input class="input-field" [(ngModel)]="nv.brand" placeholder="Ex.: Honda" /></div>
        <div><label class="field-label">Modelo *</label><input class="input-field" [(ngModel)]="nv.model" placeholder="Ex.: CG 160 Fan" /></div>
        <div><label class="field-label">Ano modelo</label><input class="input-field mono" type="number" [(ngModel)]="nv.yearModel" /></div>
        <div><label class="field-label">Cor</label><input class="input-field" [(ngModel)]="nv.color" /></div>
      </div>
    }
    <div class="sec">Entrada</div>
    <div class="form-grid-3">
      <div><label class="field-label">Quilometragem</label><input class="input-field mono" type="number" min="0" [(ngModel)]="f.kmIn" [placeholder]="kmMin ? 'última: ' + kmMin : ''" /></div>
      <div><label class="field-label">{{ auth.term('profissional') }} responsável</label><select class="input-field" [(ngModel)]="f.professionalId"><option value="">—</option>@for (p of profs(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></div>
      <div><label class="field-label">Previsão de entrega</label><input class="input-field" type="datetime-local" [(ngModel)]="f.promisedAt" /></div>
      <div class="span-3"><label class="field-label">Combustível</label><div style="display:flex;gap:6px;flex-wrap:wrap">@for (l of fuels; track l) { <span class="chip" [class.active]="f.fuelLevel === l" (click)="f.fuelLevel = f.fuelLevel === l ? '' : l">{{ l }}</span> }</div></div>
      <div class="span-3"><label class="field-label">Reclamação do cliente</label><textarea class="input-field" rows="2" [(ngModel)]="f.complaint" placeholder="Ex.: barulho ao frear, luz da injeção acesa, revisão dos 40 mil km"></textarea></div>
    </div>
    <div class="sec" style="display:flex;align-items:center;gap:8px">Checklist de entrada <span class="muted" style="text-transform:none;font-weight:400;letter-spacing:0">(registra o estado do veículo na chegada)</span></div>
    @for (c of checklist; track c.item; let i = $index) {
      <div class="chk"><span>{{ c.item }}</span>
        <div class="st">@for (s of states; track s[0]) { <button type="button" [style.background]="c.state === s[0] ? s[1].color : null" [style.color]="c.state === s[0] ? '#fff' : null" [style.border-color]="c.state === s[0] ? s[1].color : null" (click)="c.state = s[0]">{{ s[1].label }}</button> }</div>
        @if (c.state === 'avaria' || c.state === 'ausente') { <input class="input-field" style="grid-column:1/-1;font-size:12px" [(ngModel)]="c.note" placeholder="Descreva (ex.: risco na porta traseira esquerda)" /> }
      </div>
    }
    <div footer><button class="btn-secondary" (click)="open.set(false)">Cancelar</button><button class="btn-primary" (click)="save()" [disabled]="busy()">Abrir OS</button></div>
  </ax-modal>`,
})
export class NewWorkOrderComponent {
  private api = inject(Api); private toast = inject(ToastService); private lk = inject(LookupsService); readonly auth = inject(AuthService);
  readonly open = model(false);
  readonly presetVehicle = input<any | null>(null);
  readonly created = output<string>();
  readonly customer = signal<any | null>(null); readonly vehicles = signal<any[]>([]); readonly busy = signal(false);
  readonly profs = signal<any[]>([]);
  readonly types = Object.entries(VEHICLE_TYPE); readonly fuels = FUEL_LEVELS; readonly states = Object.entries(CHECK_STATE);
  readonly vt = (t: string) => VEHICLE_TYPE[t] ?? VEHICLE_TYPE['carro']; readonly fp = formatPlate;
  plateQ = ''; vehicleId: string | null = null; kmMin: number | null = null;
  nv: any = { type: 'carro' }; f: any = {}; checklist: { item: string; state: string; note?: string }[] = [];
  private key = newIdempotencyKey();
  constructor() {
    effect(() => { if (this.open()) this.reset(); });
  }
  private async reset() {
    this.customer.set(null); this.vehicles.set([]); this.vehicleId = null; this.kmMin = null; this.plateQ = ''; this.nv = { type: 'carro' };
    this.f = { kmIn: null, professionalId: '', promisedAt: '', fuelLevel: '', complaint: '' }; this.key = newIdempotencyKey();
    this.resetChecklist();
    try { const d = await this.lk.ensure(); this.profs.set(d.professionals ?? []); } catch { /* sem profissionais */ }
    const pv = this.presetVehicle();
    if (pv) { await this.useVehicle(pv); }
  }
  resetChecklist(type?: string) { const t = type ?? (this.vehicleId && this.vehicleId !== 'novo' ? this.vehicles().find((v) => v.id === this.vehicleId)?.type : this.nv.type); this.checklist = (t === 'moto' ? CHECKLIST_MOTO : CHECKLIST_CARRO).map((item) => ({ item, state: 'ok' })); }
  private async useVehicle(v: any) {
    if (v.customer_id) { try { this.customer.set(await this.api.get('/customers/' + v.customer_id)); } catch { /* */ } }
    await this.onCustomer(); this.vehicleId = v.id; this.kmMin = v.km_current; this.resetChecklist(v.type);
  }
  async findPlate() {
    const q = this.plateQ.trim(); if (q.length < 3) return;
    try {
      const r = await this.api.get<any>('/vehicles', { q, size: 5 });
      if (r.items.length === 1) { await this.useVehicle(r.items[0]); this.toast.success(`Veículo ${formatPlate(r.items[0].plate)} encontrado.`); }
      else if (!r.items.length) { this.toast.info('Placa não cadastrada: selecione o cliente e cadastre o veículo.'); this.nv.plate = q.toUpperCase(); if (this.customer()) this.vehicleId = 'novo'; }
      else this.toast.info('Mais de um veículo encontrado: selecione o cliente.');
    } catch (e) { this.toast.error(e); }
  }
  async onCustomer() {
    const c = this.customer(); this.vehicles.set([]);
    if (!c) { this.vehicleId = null; return; }
    try { const r = await this.api.get<any>('/vehicles', { customer: c.id, size: 20 }); this.vehicles.set(r.items); this.vehicleId = r.items.length === 1 ? r.items[0].id : r.items.length ? null : 'novo'; if (r.items.length === 1) this.kmMin = r.items[0].km_current; }
    catch (e) { this.toast.error(e); }
  }
  async save() {
    if (!this.customer()) { this.toast.error('Selecione o cliente.'); return; }
    if (!this.vehicleId) { this.toast.error('Selecione o veículo.'); return; }
    const body: any = { customerId: this.customer().id, kmIn: this.f.kmIn !== null && this.f.kmIn !== '' ? Number(this.f.kmIn) : undefined, fuelLevel: this.f.fuelLevel || undefined,
      complaint: this.f.complaint || undefined, professionalId: this.f.professionalId || undefined, promisedAt: this.f.promisedAt ? new Date(this.f.promisedAt).toISOString() : undefined,
      checklist: this.checklist.map((c) => ({ item: c.item, state: c.state, note: c.note || undefined })) };
    if (this.vehicleId === 'novo') {
      if (!this.nv.model) { this.toast.error('Informe o modelo do veículo.'); return; }
      body.vehicle = { type: this.nv.type, plate: this.nv.plate || undefined, brand: this.nv.brand || undefined, model: this.nv.model, yearModel: this.nv.yearModel ? Number(this.nv.yearModel) : undefined, color: this.nv.color || undefined };
    } else body.vehicleId = this.vehicleId;
    this.busy.set(true);
    try { const r = await this.api.post<any>('/work-orders', body, { idempotent: this.key }); this.toast.success(`OS nº ${r.number} aberta.`); this.open.set(false); this.created.emit(r.id); }
    catch (e) { this.toast.error(e); this.key = newIdempotencyKey(); } finally { this.busy.set(false); }
  }
}
