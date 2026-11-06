import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';
import { NewWorkOrderComponent } from './new-wo.component';
import { VEHICLE_TYPE, WO_STATUS, formatPlate } from './oficina-shared';

/** Ordens de serviço da oficina: andamento por etapa, atrasos, pendências de aprovação e de cobrança. */
@Component({
  selector: 'ax-oficina',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, NewWorkOrderComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .steps { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; margin-bottom:14px; }
    .step { padding:12px 14px; border-radius:12px; background:#fff; border:1px solid #E3EAF1; cursor:pointer; text-align:left; font:inherit; }
    .step.on { border:2px solid #0875D1; }
    .step b { font-size:22px; display:block; margin-top:4px; color:#172B3A; }
    .step span { font-size:11.5px; color:#647687; display:flex; align-items:center; gap:6px; }
    .plate { font-family:'JetBrains Mono',monospace; font-weight:700; letter-spacing:.06em; background:#F1F4F7; border:1px solid #CBD6E1; border-radius:6px; padding:1px 7px; font-size:12px; white-space:nowrap; }
    @media (max-width:1100px) { .steps { grid-template-columns:repeat(3,minmax(0,1fr)); } }
    @media (max-width:640px) { .steps { grid-template-columns:repeat(2,minmax(0,1fr)); } .step b { font-size:18px; } }
  `],
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A">Ordens de Serviço</h1>
        <p style="font-size:13px;color:#647687">Do orçamento à entrega: aprovação do cliente, execução, peças e cobrança no PDV</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-secondary" (click)="router.navigateByUrl('/veiculos')"><ax-icon name="car" [size]="13" /> Veículos</button>
        @if (auth.can('oficina.editar')) { <button class="btn-primary" (click)="newOpen.set(true)"><ax-icon name="plus" [size]="13" /> Nova OS</button> }
      </div>
    </div>
    <div class="steps">
      @for (s of steps; track s[0]) {
        <button class="step" [class.on]="status() === s[0]" (click)="setStatus(status() === s[0] ? 'abertas' : s[0])">
          <span><ax-icon [name]="st(s[0]).icon" [size]="13" [color]="st(s[0]).color" /> {{ s[1] }}</span><b>{{ counts()[s[0]] || 0 }}</b>
        </button>
      }
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <span class="chip" [class.active]="status() === 'abertas'" (click)="setStatus('abertas')">Em aberto</span>
      <span class="chip" [class.active]="status() === 'entregue'" (click)="setStatus('entregue')">Entregues</span>
      <span class="chip" [class.active]="status() === 'cancelada'" (click)="setStatus('cancelada')">Canceladas</span>
      <span class="chip" [class.active]="status() === ''" (click)="setStatus('')">Todas</span>
      <div style="flex:1"></div>
      <input class="input-field" style="max-width:280px" placeholder="Placa, nº da OS, cliente ou modelo" [(ngModel)]="q" (keyup.enter)="page.set(1); load()" />
    </div>
    <div class="card" style="overflow:hidden">
      <ax-state [loading]="loading()" [empty]="!loading() && !items().length" emptyText="Nenhuma OS neste filtro." emptyIcon="wrench" />
      @if (items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>OS</th><th>Veículo</th><th>Cliente</th><th>Situação</th><th>{{ auth.term('profissional') }}</th><th>Previsão</th><th class="num">Valor</th><th></th></tr></thead>
          <tbody>@for (w of items(); track w.id) {
            <tr style="cursor:pointer" (click)="open(w.id)">
              <td><b class="mono">#{{ w.number }}</b><div class="muted" style="font-size:11px">{{ w.created_at | dt }}</div></td>
              <td><div style="display:flex;gap:8px;align-items:center"><ax-icon [name]="vt(w.vehicle_type).icon" [size]="15" color="#647687" /><span class="plate">{{ fp(w.plate) }}</span></div><div style="font-size:12px;margin-top:2px">{{ w.brand }} {{ w.model }}</div></td>
              <td>{{ w.customer_name }}</td>
              <td><span class="badge" [class]="'badge ' + st(w.status).cls">{{ st(w.status).label }}</span>
                @if (w.late) { <span class="badge badge-danger" style="margin-left:4px">Atrasada</span> }
                @if (w.pending_items && w.status !== 'orcamento' && w.status !== 'aguardando_aprovacao') { <div style="font-size:11px;color:#D99000;margin-top:2px">{{ w.pending_items }} adicional(is) p/ aprovar</div> }
                @if (w.unbilled_items && w.status === 'pronta') { <div style="font-size:11px;color:#0875D1;margin-top:2px">Cobrar no PDV</div> }</td>
              <td style="font-size:12.5px">{{ w.professional || '—' }}</td>
              <td style="font-size:12px" [style.color]="w.late ? '#C93636' : null">{{ w.promised_at ? (w.promised_at | dtt) : '—' }}</td>
              <td class="num">{{ w.total | brl }}</td>
              <td><button class="btn-ghost" style="font-size:12px" (click)="$event.stopPropagation(); open(w.id)">Abrir</button></td></tr>
          }</tbody></table></div>
      }
    </div>
    @if (pages() > 1) { <ax-pager [page]="page()" [pages]="pages()" [total]="total()" (go)="page.set($event); load()" /> }
  </div>
  <ax-new-wo [(open)]="newOpen" (created)="open($event)" />`,
})
export class OficinaPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly router = inject(Router); private route = inject(ActivatedRoute);
  readonly items = signal<any[]>([]); readonly counts = signal<Record<string, number>>({}); readonly loading = signal(true);
  readonly page = signal(1); readonly pages = signal(1); readonly total = signal(0); readonly status = signal('abertas'); readonly newOpen = signal(false);
  q = '';
  readonly steps: [string, string][] = [['orcamento', 'Orçamento'], ['aguardando_aprovacao', 'Aguardando aprovação'], ['em_execucao', 'Em execução'], ['aguardando_peca', 'Aguardando peça'], ['pronta', 'Prontas'], ['aprovada', 'Aprovadas']];
  readonly st = (s: string) => WO_STATUS[s] ?? WO_STATUS['orcamento'];
  readonly vt = (t: string) => VEHICLE_TYPE[t] ?? VEHICLE_TYPE['carro'];
  readonly fp = formatPlate;
  ngOnInit() { if (this.route.snapshot.queryParamMap.get('nova')) this.newOpen.set(true); this.load(); }
  setStatus(s: string) { this.status.set(s); this.page.set(1); this.load(); }
  async load() {
    this.loading.set(true);
    try { const r = await this.api.get<any>('/work-orders', { status: this.status(), q: this.q, page: this.page() }); this.items.set(r.items); this.counts.set(r.counts); this.pages.set(r.pages); this.total.set(r.total); }
    catch (e) { this.toast.error(e); } finally { this.loading.set(false); }
  }
  open(id: string) { this.router.navigate(['/os-detail', id]); }
}
