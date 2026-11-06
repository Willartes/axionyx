import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CustomerPickerComponent, ListState, ModalComponent, PagerComponent, PaymentRow, PaymentsEditorComponent, StateComponent, VariantPickerComponent } from '../../shared/ui';
import { Api, newIdempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, STATUS_PIPES, addDaysIso, todayIso } from '../../core/format';

const KIND_LABEL: Record<string, string> = { condicional: 'Condicional', bag_delivery: 'Bag Delivery' };
const EVENT_LABEL: Record<string, string> = { criado: 'Peças liberadas', itens_adicionados: 'Peças adicionadas', retorno_parcial: 'Retorno parcial', finalizado: 'Finalizado', prazo_prorrogado: 'Prazo prorrogado', cancelado: 'Cancelado', remessa: 'Remessa enviada', acerto: 'Acerto realizado' };

// ─── Lista de condicionais / bags ───────────────────────────────────────────
@Component({
  selector: 'ax-condicionais',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header">
      <div style="flex:1"><h1>Condicional e Bag Delivery</h1><p>Peças saem do estoque ao liberar e voltam na devolução; o que a cliente fica vira venda efetiva</p></div>
      @if (auth.can('condicional.editar')) {
        <button class="btn-secondary" style="font-size:12px" (click)="router.navigate(['/condicional-detail'], { queryParams: { tipo: 'bag_delivery' } })"><ax-icon name="truck" [size]="13" /> Nova Bag Delivery</button>
        <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/condicional-detail')"><ax-icon name="plus" [size]="13" /> Novo condicional</button>
      }
    </div>
    <div style="padding:16px 24px 0;display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
      @for (k of kpis(); track k.l) {
        <div class="kpi-card" style="padding:14px;cursor:pointer" (click)="status.set(k.s); apply()"><div style="font-size:11px;color:#647687;text-transform:uppercase;font-weight:600">{{ k.l }}</div><div [style.color]="k.c" style="font-size:22px;font-weight:700">{{ k.v }}</div></div>
      }
    </div>
    <div style="padding:12px 24px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <div style="position:relative;width:260px"><ax-icon name="search" [size]="14" color="#A0AFBF" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" />
        <input class="input-field" style="padding-left:32px" placeholder="Cliente ou número" [(ngModel)]="q" (keyup.enter)="apply()" /></div>
      @for (s of statuses; track s.v) { <span class="chip" [class.active]="status() === s.v" (click)="status.set(s.v); apply()">{{ s.l }}</span> }
      <select class="input-field" style="width:160px;margin-left:auto" [(ngModel)]="kind" (ngModelChange)="apply()"><option value="">Todos os tipos</option><option value="condicional">Condicional</option><option value="bag_delivery">Bag Delivery</option></select>
    </div>
    <div style="flex:1;overflow-y:auto;padding:0 24px 20px">
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Nº</th><th>Tipo</th><th>Cliente</th><th>Responsável</th><th>Saída</th><th>Devolver até</th><th class="num">Enviadas</th><th class="num">Compradas</th><th class="num">Devolvidas</th><th class="num">Em aberto</th><th>Status</th></tr></thead>
          <tbody>@for (k of list.items(); track k.id) {
            <tr class="clickable" (click)="router.navigateByUrl('/condicional-detail/' + k.id)">
              <td class="mono" style="color:#0875D1">{{ k.number }}</td><td><span class="badge" [class]="k.kind === 'bag_delivery' ? 'badge badge-cyan' : 'badge badge-muted'">{{ KIND[k.kind] }}</span></td>
              <td style="font-weight:500">{{ k.customer }}</td><td>{{ k.responsible }}</td><td class="mono" style="font-size:12px">{{ k.created_at | dt }}</td>
              <td class="mono" style="font-size:12px" [style.color]="k.overdue ? '#C93636' : null">{{ k.due_date | dt }}</td>
              <td class="num">{{ k.sent }}</td><td class="num" style="color:#18864B">{{ k.sold }}</td><td class="num">{{ k.returned }}</td><td class="num" style="font-weight:600">{{ k.open_value | brl }}</td>
              <td>@if (k.overdue) { <span class="badge badge-danger">Atrasado</span> } @else { <span class="badge" [class]="'badge ' + (k.status | statusClass)">{{ k.status | statusLabel }}</span> }</td>
            </tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum condicional encontrado." emptyIcon="shopping-bag" />
      </div>
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>`,
})
export class CondicionaisPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService);
  readonly KIND = KIND_LABEL;
  readonly list = new ListState<any>((q) => this.api.get('/conditionals', q));
  readonly status = signal('aberto'); q = ''; kind = '';
  readonly statuses = [{ v: 'aberto', l: 'Em aberto' }, { v: 'atrasado', l: 'Atrasados' }, { v: 'finalizado', l: 'Finalizados' }, { v: 'cancelado', l: 'Cancelados' }, { v: '', l: 'Todos' }];
  readonly counts = signal<Record<string, number>>({});
  readonly kpis = computed(() => { const c = this.counts(); return [
    { l: 'Em aberto', v: c['aberto'] ?? '—', c: '#0875D1', s: 'aberto' }, { l: 'Atrasados', v: c['atrasado'] ?? '—', c: '#C93636', s: 'atrasado' },
    { l: 'Finalizados', v: c['finalizado'] ?? '—', c: '#18864B', s: 'finalizado' }, { l: 'Cancelados', v: c['cancelado'] ?? '—', c: '#647687', s: 'cancelado' }]; });
  async ngOnInit() {
    this.apply();
    const out: Record<string, number> = {};
    await Promise.all(['aberto', 'atrasado', 'finalizado', 'cancelado'].map(async (s) => { try { out[s] = (await this.api.get<any>('/conditionals', { status: s, size: 1 })).total; } catch { /* */ } }));
    this.counts.set(out);
  }
  apply() { this.list.query = { status: this.status(), q: this.q || undefined, kind: this.kind || undefined }; this.list.load(1); }
}

// ─── Novo / detalhe do condicional ──────────────────────────────────────────
@Component({
  selector: 'ax-condicional-detail',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, CustomerPickerComponent, VariantPickerComponent, PaymentsEditorComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (!id()) {
    <!-- NOVO -->
    <div style="display:flex;flex-direction:column;height:100%">
      <div class="page-header"><div style="flex:1"><h1>{{ f.kind === 'bag_delivery' ? 'Nova Bag Delivery' : 'Novo condicional' }}</h1><p>As peças saem do estoque da filial e ficam sob responsabilidade da cliente até a devolução</p></div>
        <button class="btn-secondary" style="font-size:12px" (click)="router.navigateByUrl('/condicionais')">Cancelar</button>
        <button class="btn-primary" style="font-size:12px" [disabled]="busy() || !items().length || !customer()" (click)="create()"><ax-icon name="check" [size]="13" /> Liberar peças</button></div>
      <div style="flex:1;overflow-y:auto;padding:20px;display:grid;grid-template-columns:1fr 360px;gap:16px;align-items:start">
        <div class="card" style="padding:16px">
          <div class="section-title" style="margin-bottom:10px">Peças</div>
          <ax-variant-picker [big]="true" (selected)="add($event)" />
          <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr><th>SKU</th><th>Produto</th><th>Cor / Tam.</th><th class="num">Estoque</th><th class="num">Qtd.</th><th class="num">Preço</th><th></th></tr></thead>
            <tbody>@for (i of items(); track i.v.id) { <tr><td class="mono" style="font-size:12px">{{ i.v.sku }}</td><td>{{ i.v.name }}</td><td>{{ i.v.color || '—' }} / {{ i.v.size || '—' }}</td>
              <td class="num" [style.color]="i.v.stock < i.qty ? '#C93636' : null">{{ i.v.stock }}</td>
              <td class="num"><input type="number" min="1" max="50" class="input-field mono" style="width:64px;padding:4px 6px;text-align:right" [(ngModel)]="i.qty" (ngModelChange)="touch()" /></td>
              <td class="num">{{ i.v.price | brl }}</td><td><button class="btn-ghost" style="padding:2px" (click)="rm(i)"><ax-icon name="x" [size]="13" /></button></td></tr> }
            @empty { <tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Bipe ou busque as peças que vão para a cliente.</td></tr> }</tbody></table>
          @if (items().length) { <div style="text-align:right;margin-top:10px;font-size:13px">{{ pieces() }} peça(s) · valor total <b>{{ value() | brl }}</b></div> }
        </div>
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">
          <div class="section-title">Dados</div>
          <div style="display:flex;gap:6px">@for (t of ['condicional','bag_delivery']; track t) { <span class="chip" [class.active]="f.kind === t" (click)="f.kind = t; touch()">{{ KIND[t] }}</span> }</div>
          <div><label class="field-label">Cliente *</label><ax-customer-picker [(value)]="customer" (valueChange)="pickCustomer($event)" /></div>
          @if (customer()?.open_balance > 0) { <div class="state-warning" style="margin:0"><ax-icon name="alert-triangle" [size]="13" />Cliente com saldo em aberto no crediário.</div> }
          <div><label class="field-label">Devolver até</label><input type="date" class="input-field" [(ngModel)]="f.dueDate" /></div>
          <div><label class="field-label">Vendedor(a)</label><select class="input-field" [(ngModel)]="f.sellerId">@for (s of lk.data()?.sellers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select></div>
          @if (f.kind === 'bag_delivery') {
            <div><label class="field-label">Endereço de entrega *</label><textarea class="input-field" rows="2" [(ngModel)]="f.address"></textarea></div>
            <div class="form-grid-2"><div><label class="field-label">Taxa de entrega</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.fee" /></div>
              <div><label class="field-label">Entregador / transportadora</label><input class="input-field" [(ngModel)]="f.carrier" /></div></div>
            <div><label class="field-label">Agendamento</label><input type="datetime-local" class="input-field" [(ngModel)]="f.scheduledAt" /></div>
          }
          <div><label class="field-label">Observações</label><textarea class="input-field" rows="2" [(ngModel)]="f.notes"></textarea></div>
        </div>
      </div>
    </div>
  } @else {
    <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
    @if (k(); as k) {
    <div style="display:flex;flex-direction:column;height:100%">
      <div class="page-header">
        <div style="flex:1;min-width:260px">
          <div style="display:flex;align-items:center;gap:10px"><h1>{{ KIND[k.kind] }} nº {{ k.number }}</h1>
            @if (k.overdue) { <span class="badge badge-danger">Atrasado</span> } @else { <span class="badge" [class]="'badge ' + (k.status | statusClass)">{{ k.status | statusLabel }}</span> }</div>
          <p>{{ k.customer }} · liberado em {{ k.created_at | dtt }} por {{ k.responsible }} · devolver até <b [style.color]="k.overdue ? '#C93636' : null">{{ k.due_date | dt }}</b></p>
        </div>
        <button class="btn-secondary no-print" style="font-size:12px" (click)="print()"><ax-icon name="printer" [size]="13" /> Romaneio</button>
        @if (k.status === 'aberto' && auth.can('condicional.editar')) {
          @if (auth.can('mensagens.enviar')) { <button class="btn-secondary" style="font-size:12px" (click)="remind()"><ax-icon name="message-circle" [size]="13" /> Lembrete WhatsApp</button> }
          <button class="btn-secondary" style="font-size:12px" (click)="extendOpen.set(true)"><ax-icon name="calendar-clock" [size]="13" /> Prorrogar</button>
          <button class="btn-secondary" style="font-size:12px" (click)="addOpen.set(true)"><ax-icon name="plus" [size]="13" /> Adicionar peças</button>
          <button class="btn-primary" style="font-size:12px" (click)="openReturn()"><ax-icon name="undo-2" [size]="13" /> Registrar retorno</button>
          <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="cancelOpen.set(true)">Cancelar</button>
        }
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px;display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start">
        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="card" style="overflow:hidden">
            <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>SKU</th><th>Produto</th><th>Cor / Tam.</th><th class="num">Enviadas</th><th class="num">Compradas</th><th class="num">Devolvidas</th><th class="num">Pendentes</th><th class="num">Preço</th></tr></thead>
              <tbody>@for (i of k.items; track i.id) { <tr><td class="mono" style="font-size:12px">{{ i.sku }}</td><td>{{ i.name }}</td><td>{{ i.color || '—' }} / {{ i.size || '—' }}</td>
                <td class="num">{{ i.qty_sent }}</td><td class="num" style="color:#18864B">{{ i.qty_sold }}</td><td class="num">{{ i.qty_returned }}</td><td class="num" style="font-weight:600" [style.color]="i.pending > 0 ? '#D99000' : null">{{ i.pending }}</td><td class="num">{{ i.unit_price | brl }}</td></tr> }</tbody></table>
          </div>
          @if (k.sales.length) {
            <div class="card" style="padding:14px"><div class="section-title" style="margin-bottom:8px">Vendas geradas</div>
              @for (s of k.sales; track s.id) { <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0"><a class="link" (click)="router.navigateByUrl('/pedido-detail/' + s.id)">Venda nº {{ s.number }}</a><span>{{ s.created_at | dt }}</span><b>{{ s.total | brl }}</b></div> }</div>
          }
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="card" style="padding:14px;font-size:13px;display:flex;flex-direction:column;gap:6px">
            <div class="section-title">Cliente</div><div style="font-weight:600">{{ k.customer }}</div><div>{{ (k.whatsapp || k.phone) | phone }}</div>
            @if (k.seller) { <div class="muted">Vendedor(a): {{ k.seller }}</div> }
            @if (k.kind === 'bag_delivery') { <div class="section-title" style="margin-top:6px">Entrega</div><div>{{ k.delivery?.address || '—' }}</div>
              @if (k.delivery?.carrier) { <div class="muted">{{ k.delivery.carrier }} @if (k.delivery.fee) { · taxa {{ k.delivery.fee | brl }} }</div> }
              @if (k.delivery?.scheduledAt) { <div class="muted">Agendado: {{ k.delivery.scheduledAt | dtt }}</div> } }
            @if (k.notes) { <div class="muted" style="margin-top:6px">{{ k.notes }}</div> }
          </div>
          <div class="card" style="padding:14px"><div class="section-title" style="margin-bottom:8px">Histórico</div>
            @for (e of k.events; track e.id) { <div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #F0F4F8;font-size:12px"><ax-icon name="circle-dot" [size]="12" color="#0875D1" />
              <div style="flex:1"><div style="font-weight:500">{{ EVT[e.type] || e.type }} @if (e.data?.saleNumber) { · venda nº {{ e.data.saleNumber }} } @if (e.data?.dueDate && e.type === 'prazo_prorrogado') { · até {{ e.data.dueDate | dt }} } @if (e.data?.reason) { · {{ e.data.reason }} }</div><div class="muted">{{ e.created_at | dtt }} · {{ e.user_name }}</div></div></div> }
          </div>
        </div>
      </div>
    </div>
    <!-- romaneio para impressão -->
    <div id="receipt" class="print-only">
      <div style="text-align:center;font-weight:700">{{ auth.me()?.company?.name }}</div>
      <div style="text-align:center">ROMANEIO DE {{ KIND[k.kind].toUpperCase() }} Nº {{ k.number }}</div>
      <div style="text-align:center;font-size:10px">Documento sem valor fiscal</div><hr />
      <div>Cliente: {{ k.customer }}</div><div>Saída: {{ k.created_at | dtt }}</div><div>Devolver até: {{ k.due_date | dt }}</div><hr />
      @for (i of k.items; track i.id) { <div style="display:flex;justify-content:space-between"><span>{{ i.qty_sent }}x {{ i.name }} {{ i.color }} {{ i.size }}</span><span>{{ i.unit_price * i.qty_sent | brl }}</span></div> }
      <hr /><div style="display:flex;justify-content:space-between;font-weight:700"><span>Total</span><span>{{ sentValue() | brl }}</span></div>
      <div style="margin-top:28px;border-top:1px solid #000;text-align:center;font-size:10px">Assinatura da cliente — declaro ter recebido as peças acima</div>
    </div>

    <ax-modal [(open)]="returnOpen" title="Registrar retorno" icon="undo-2" [width]="780">
      <p style="font-size:12px;color:#647687;margin-bottom:8px">Informe, por peça, quantas a cliente <b>devolveu</b> e quantas <b>comprou</b>. Peças devolvidas voltam ao estoque; as compradas geram a venda com o pagamento abaixo. Retornos parciais mantêm o condicional aberto.</p>
      <div style="display:flex;gap:8px;margin-bottom:8px"><button class="btn-ghost" style="font-size:12px" (click)="fillAll('returned')">Devolveu tudo</button><button class="btn-ghost" style="font-size:12px" (click)="fillAll('sold')">Comprou tudo</button></div>
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Produto</th><th class="num">Pendentes</th><th class="num">Devolvidas</th><th class="num">Compradas</th><th class="num">Valor</th></tr></thead>
        <tbody>@for (r of ret(); track r.variantId) { <tr><td style="font-size:12px">{{ r.label }}</td><td class="num">{{ r.pending }}</td>
          <td class="num"><input type="number" min="0" [max]="r.pending" class="input-field mono" style="width:64px;padding:4px 6px;text-align:right" [(ngModel)]="r.returned" (ngModelChange)="touch()" /></td>
          <td class="num"><input type="number" min="0" [max]="r.pending" class="input-field mono" style="width:64px;padding:4px 6px;text-align:right" [(ngModel)]="r.sold" (ngModelChange)="touch()" /></td>
          <td class="num">{{ r.sold * r.price | brl }}</td></tr> }</tbody></table>
      @if (soldTotal() > 0) {
        <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center"><div class="section-title">Pagamento das peças compradas</div><b>{{ soldTotal() | brl }}</b></div>
        <ax-payments-editor [total]="soldTotal()" [(rows)]="pays" />
        @if (auth.can('fiscal.emitir')) { <label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:8px"><input type="checkbox" [(ngModel)]="emitFiscal" /> Gerar documento fiscal da venda (NFC-e/NF-e conforme configuração)</label> }
      }
      <div footer><button class="btn-secondary" (click)="returnOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy()" (click)="submitReturn()">Confirmar retorno</button></div>
    </ax-modal>
    <ax-modal [(open)]="addOpen" title="Adicionar peças" icon="plus" [width]="520">
      <ax-variant-picker (selected)="addToExisting($event)" />
      <p style="font-size:11px;color:#647687;margin-top:8px">Cada peça bipada é adicionada imediatamente (1 unidade) e baixada do estoque.</p>
    </ax-modal>
    <ax-modal [(open)]="extendOpen" title="Prorrogar prazo" icon="calendar-clock" [width]="380">
      <label class="field-label">Nova data de devolução</label><input type="date" class="input-field" [(ngModel)]="newDue" [min]="today" />
      <div footer><button class="btn-secondary" (click)="extendOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="extend()">Salvar</button></div>
    </ax-modal>
    <ax-modal [(open)]="cancelOpen" title="Cancelar condicional" icon="x-circle" [width]="420">
      <p style="font-size:12px;color:#647687;margin-bottom:8px">Todas as peças pendentes retornam ao estoque. Só é possível cancelar se nenhuma peça foi comprada.</p>
      <label class="field-label">Motivo *</label><input class="input-field" [(ngModel)]="reason" />
      <div footer><button class="btn-secondary" (click)="cancelOpen.set(false)">Voltar</button><button class="btn-danger" [disabled]="reason.trim().length < 3" (click)="cancel()">Cancelar condicional</button></div>
    </ax-modal>
    }
  }`,
})
export class CondicionalDetailPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly id = input<string>(); readonly tipo = input<string>();
  readonly KIND = KIND_LABEL; readonly EVT = EVENT_LABEL; readonly today = todayIso();
  readonly k = signal<any>(null); readonly loading = signal(false); readonly error = signal<string | null>(null); readonly busy = signal(false); private tick = signal(0);
  // novo
  readonly customer = signal<any>(null); readonly items = signal<{ v: any; qty: number }[]>([]);
  f: any = {}; private idem = newIdempotencyKey();
  readonly pieces = computed(() => { this.tick(); return this.items().reduce((s, i) => s + (+i.qty || 0), 0); });
  readonly value = computed(() => { this.tick(); return this.items().reduce((s, i) => s + (+i.qty || 0) * i.v.price, 0); });
  // detalhe
  readonly returnOpen = signal(false); readonly addOpen = signal(false); readonly extendOpen = signal(false); readonly cancelOpen = signal(false);
  readonly ret = signal<any[]>([]); pays = signal<PaymentRow[]>([]); emitFiscal = false; newDue = ''; reason = '';
  readonly soldTotal = computed(() => { this.tick(); return Math.round(this.ret().reduce((s, r) => s + (+r.sold || 0) * r.price, 0) * 100) / 100; });
  readonly sentValue = computed(() => (this.k()?.items ?? []).reduce((s: number, i: any) => s + i.qty_sent * i.unit_price, 0));

  async ngOnInit() {
    await this.lk.ensure();
    if (this.id()) this.load();
    else { this.f = { kind: this.tipo() === 'bag_delivery' ? 'bag_delivery' : 'condicional', dueDate: addDaysIso(todayIso(), 3), sellerId: this.auth.me()?.user?.id, address: '', fee: null, carrier: '', scheduledAt: '', notes: '' }; this.tick.update((x) => x + 1); }
  }
  touch() { this.tick.update((x) => x + 1); }
  pickCustomer(c: any) { if (c && this.f.kind === 'bag_delivery' && !this.f.address && c.address) { const a = c.address; this.f.address = [a.street, a.number, a.district, a.city].filter(Boolean).join(', '); this.touch(); } }
  add(v: any) { const ex = this.items().find((i) => i.v.id === v.id); if (ex) { ex.qty++; this.touch(); } else this.items.update((l) => [...l, { v, qty: 1 }]); if (v.stock <= 0) this.toast.warning(`${v.sku} sem saldo em estoque nesta filial.`); }
  rm(i: any) { this.items.update((l) => l.filter((x) => x !== i)); }
  async create() {
    this.busy.set(true);
    try {
      const body: any = { kind: this.f.kind, customerId: this.customer().id, sellerId: this.f.sellerId || undefined, dueDate: this.f.dueDate || undefined, notes: this.f.notes || undefined,
        items: this.items().map((i) => ({ variantId: i.v.id, qty: Math.max(1, Math.floor(+i.qty)) })) };
      if (this.f.kind === 'bag_delivery') body.delivery = { address: this.f.address || undefined, fee: this.f.fee ? +this.f.fee : undefined, carrier: this.f.carrier || undefined, scheduledAt: this.f.scheduledAt || undefined };
      const k: any = await this.api.post('/conditionals', body, { idempotent: this.idem });
      this.toast.success(`${KIND_LABEL[k.kind]} nº ${k.number} criado. Peças baixadas do estoque.`); this.router.navigateByUrl('/condicional-detail/' + k.id);
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async load() { this.loading.set(true); this.error.set(null); try { this.k.set(await this.api.get('/conditionals/' + this.id())); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); } }
  openReturn() {
    this.ret.set(this.k().items.filter((i: any) => i.pending > 0).map((i: any) => ({ variantId: i.variant_id, label: `${i.name} ${i.color ?? ''} ${i.size ?? ''} · ${i.sku}`, pending: i.pending, returned: 0, sold: 0, price: Number(i.unit_price) })));
    this.pays.set([]); this.emitFiscal = false; this.idem = newIdempotencyKey(); this.returnOpen.set(true);
  }
  fillAll(k: 'returned' | 'sold') { this.ret.update((l) => l.map((r) => ({ ...r, returned: k === 'returned' ? r.pending : 0, sold: k === 'sold' ? r.pending : 0 }))); }
  async submitReturn() {
    const items = this.ret().map((r) => ({ variantId: r.variantId, returned: Math.max(0, Math.floor(+r.returned || 0)), sold: Math.max(0, Math.floor(+r.sold || 0)) })).filter((r) => r.returned + r.sold > 0);
    if (!items.length) { this.toast.warning('Informe ao menos uma peça devolvida ou comprada.'); return; }
    this.busy.set(true);
    try {
      const r: any = await this.api.post(`/conditionals/${this.id()}/return`, { items, payments: this.soldTotal() > 0 ? PaymentsEditorComponent.toApi(this.pays()) : undefined, emitFiscal: this.emitFiscal || undefined }, { idempotent: this.idem });
      this.toast.success(r.finished ? 'Condicional finalizado.' : `Retorno registrado. ${r.pending} peça(s) ainda com a cliente.`);
      if (r.sale) this.toast.info(`Venda nº ${r.sale.number} gerada.`);
      this.returnOpen.set(false); this.load();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async addToExisting(v: any) { try { await this.api.post(`/conditionals/${this.id()}/items`, { items: [{ variantId: v.id, qty: 1 }] }); this.toast.success(`${v.sku} adicionada.`); this.load(); } catch (e) { this.toast.error(e); } }
  async extend() { if (!this.newDue) return; try { await this.api.post(`/conditionals/${this.id()}/extend`, { dueDate: this.newDue }); this.extendOpen.set(false); this.load(); } catch (e) { this.toast.error(e); } }
  async cancel() { try { await this.api.post(`/conditionals/${this.id()}/cancel`, { reason: this.reason.trim() }); this.cancelOpen.set(false); this.toast.success('Condicional cancelado; peças devolvidas ao estoque.'); this.load(); } catch (e) { this.toast.error(e); } }
  async remind() {
    const k = this.k();
    try { const m: any = await this.api.post('/messages', { customerId: k.customer_id, purpose: 'condicional', refType: 'conditional', refId: k.id + ':' + k.due_date,
        body: `Olá {nome}! Lembrete: as peças do seu ${KIND_LABEL[k.kind].toLowerCase()} nº ${k.number} devem ser devolvidas até ${k.due_date.split('-').reverse().join('/')}. Qualquer dúvida, estamos à disposição.` });
      if (m.duplicate) this.toast.info('Lembrete já registrado para este prazo.');
      else if (m.status === 'fila') this.toast.success('Lembrete enfileirado para envio.');
      else this.toast.warning(m.error || 'Mensagem registrada, mas não enviada.');
    } catch (e) { this.toast.error(e); }
  }
  print() { document.body.classList.add('printing-receipt'); setTimeout(() => { window.print(); document.body.classList.remove('printing-receipt'); }, 50); }
}

// ─── Consignação (parceiras / revendedoras) ─────────────────────────────────
@Component({
  selector: 'ax-consignacoes',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Consignação</h1><p>Remessas para parceiras/revendedoras com acerto periódico e comissão</p></div>
      @if (auth.can('consignacao.editar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/consignacao-detail')"><ax-icon name="plus" [size]="13" /> Nova remessa</button> }</div>
    <div style="padding:12px 24px;display:flex;gap:8px;align-items:center">
      <div style="position:relative;width:260px"><ax-icon name="search" [size]="14" color="#A0AFBF" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" /><input class="input-field" style="padding-left:32px" placeholder="Parceira ou número" [(ngModel)]="q" (keyup.enter)="apply()" /></div>
      @for (s of statuses; track s.v) { <span class="chip" [class.active]="status() === s.v" (click)="status.set(s.v); apply()">{{ s.l }}</span> }
    </div>
    <div style="flex:1;overflow-y:auto;padding:0 24px 20px">
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Nº</th><th>Parceira</th><th>Abertura</th><th>Acerto até</th><th class="num">Comissão</th><th class="num">Enviadas</th><th class="num">Vendidas</th><th class="num">Devolvidas</th><th class="num">Em poder da parceira</th><th class="num">Acertado (líq.)</th><th>Status</th></tr></thead>
          <tbody>@for (k of list.items(); track k.id) {
            <tr class="clickable" (click)="router.navigateByUrl('/consignacao-detail/' + k.id)"><td class="mono" style="color:#0875D1">{{ k.number }}</td><td style="font-weight:500">{{ k.partner }}</td><td class="mono" style="font-size:12px">{{ k.created_at | dt }}</td><td class="mono" style="font-size:12px">{{ k.due_date | dt }}</td>
              <td class="num">{{ k.commission_pct | pct }}</td><td class="num">{{ k.sent }}</td><td class="num" style="color:#18864B">{{ k.sold }}</td><td class="num">{{ k.returned }}</td><td class="num" style="font-weight:600">{{ k.open_value | brl }}</td><td class="num">{{ k.settled_net | brl }}</td>
              <td><span class="badge" [class]="'badge ' + (k.status | statusClass)">{{ k.status | statusLabel }}</span></td></tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhuma consignação." emptyIcon="handshake" />
      </div>
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>`,
})
export class ConsignacoesPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService);
  readonly list = new ListState<any>((q) => this.api.get('/consignments', q));
  readonly status = signal('aberto'); q = '';
  readonly statuses = [{ v: 'aberto', l: 'Em aberto' }, { v: 'encerrado', l: 'Encerradas' }, { v: '', l: 'Todas' }];
  ngOnInit() { this.apply(); }
  apply() { this.list.query = { status: this.status(), q: this.q || undefined }; this.list.load(1); }
}

@Component({
  selector: 'ax-consignacao-detail',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, CustomerPickerComponent, VariantPickerComponent, PaymentsEditorComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (!id()) {
    <div style="display:flex;flex-direction:column;height:100%">
      <div class="page-header"><div style="flex:1"><h1>Nova remessa em consignação</h1><p>As peças saem do estoque e ficam em poder da parceira até o acerto</p></div>
        <button class="btn-secondary" style="font-size:12px" (click)="router.navigateByUrl('/consignacoes')">Cancelar</button>
        <button class="btn-primary" style="font-size:12px" [disabled]="busy() || !items().length || !partner()" (click)="create()"><ax-icon name="check" [size]="13" /> Enviar remessa</button></div>
      <div style="flex:1;overflow-y:auto;padding:20px;display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start">
        <div class="card" style="padding:16px">
          <ax-variant-picker [big]="true" (selected)="add($event)" />
          <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr><th>SKU</th><th>Produto</th><th class="num">Estoque</th><th class="num">Qtd.</th><th class="num">Preço</th><th></th></tr></thead>
            <tbody>@for (i of items(); track i.v.id) { <tr><td class="mono" style="font-size:12px">{{ i.v.sku }}</td><td>{{ i.v.name }} {{ i.v.color }} {{ i.v.size }}</td><td class="num">{{ i.v.stock }}</td>
              <td class="num"><input type="number" min="1" class="input-field mono" style="width:64px;padding:4px 6px;text-align:right" [(ngModel)]="i.qty" (ngModelChange)="touch()" /></td><td class="num">{{ i.v.price | brl }}</td>
              <td><button class="btn-ghost" style="padding:2px" (click)="rm(i)"><ax-icon name="x" [size]="13" /></button></td></tr> }
            @empty { <tr><td colspan="6" class="muted" style="text-align:center;padding:24px">Bipe ou busque as peças da remessa.</td></tr> }</tbody></table>
          @if (items().length) { <div style="text-align:right;margin-top:10px;font-size:13px">{{ pieces() }} peça(s) · valor de venda <b>{{ value() | brl }}</b></div> }
        </div>
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">
          <div><label class="field-label">Parceira / revendedora *</label><ax-customer-picker [(value)]="partner" /></div>
          <div><label class="field-label">Comissão da parceira (%)</label><input type="number" min="0" max="90" step="0.5" class="input-field mono" [(ngModel)]="f.commissionPct" /></div>
          <div><label class="field-label">Data do acerto</label><input type="date" class="input-field" [(ngModel)]="f.dueDate" /></div>
          <div><label class="field-label">Observações</label><textarea class="input-field" rows="3" [(ngModel)]="f.notes"></textarea></div>
        </div>
      </div>
    </div>
  } @else {
    <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
    @if (k(); as k) {
    <div style="display:flex;flex-direction:column;height:100%">
      <div class="page-header">
        <div style="flex:1"><div style="display:flex;gap:10px;align-items:center"><h1>Consignação nº {{ k.number }}</h1><span class="badge" [class]="'badge ' + (k.status | statusClass)">{{ k.status | statusLabel }}</span></div>
          <p>{{ k.partner }} · comissão {{ k.commission_pct | pct }} · aberta em {{ k.created_at | dt }} @if (k.due_date) { · acerto até {{ k.due_date | dt }} }</p></div>
        @if (k.status === 'aberto' && auth.can('consignacao.editar')) {
          <button class="btn-secondary" style="font-size:12px" (click)="shipOpen.set(true)"><ax-icon name="package-plus" [size]="13" /> Nova remessa</button>
          <button class="btn-primary" style="font-size:12px" (click)="openSettle()"><ax-icon name="handshake" [size]="13" /> Fazer acerto</button>
        }
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px">
        <div class="card" style="overflow:hidden">
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>SKU</th><th>Produto</th><th class="num">Enviadas</th><th class="num">Vendidas</th><th class="num">Devolvidas</th><th class="num">Com a parceira</th><th class="num">Preço</th></tr></thead>
            <tbody>@for (i of k.items; track i.id) { <tr><td class="mono" style="font-size:12px">{{ i.sku }}</td><td>{{ i.name }} {{ i.color }} {{ i.size }}</td><td class="num">{{ i.qty_sent }}</td><td class="num" style="color:#18864B">{{ i.qty_sold }}</td><td class="num">{{ i.qty_returned }}</td><td class="num" style="font-weight:600">{{ i.pending }}</td><td class="num">{{ i.unit_price | brl }}</td></tr> }</tbody></table>
        </div>
        <div class="card" style="overflow:hidden"><div style="padding:12px 14px" class="section-title">Acertos</div>
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>#</th><th>Data</th><th>Responsável</th><th class="num">Bruto</th><th class="num">Comissão</th><th class="num">Líquido</th><th>Venda</th></tr></thead>
            <tbody>@for (s of k.settlements; track s.id) { <tr><td>{{ s.number }}</td><td class="mono" style="font-size:12px">{{ s.created_at | dtt }}</td><td>{{ s.created_by_name }}</td><td class="num">{{ s.gross_amount | brl }}</td><td class="num">{{ s.commission_amount | brl }}</td><td class="num" style="font-weight:600">{{ s.net_amount | brl }}</td>
              <td>@if (s.sale_id) { <a class="link" (click)="router.navigateByUrl('/pedido-detail/' + s.sale_id)">nº {{ s.sale_number }}</a> } @else { — }</td></tr> }
            @empty { <tr><td colspan="7" class="muted" style="text-align:center;padding:16px">Nenhum acerto ainda.</td></tr> }</tbody></table>
        </div>
      </div>
    </div>
    <ax-modal [(open)]="settleOpen" title="Acerto da consignação" icon="handshake" [width]="780">
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Produto</th><th class="num">Com a parceira</th><th class="num">Vendidas</th><th class="num">Devolvidas</th></tr></thead>
        <tbody>@for (r of rows(); track r.variantId) { <tr><td style="font-size:12px">{{ r.label }}</td><td class="num">{{ r.pending }}</td>
          <td class="num"><input type="number" min="0" [max]="r.pending" class="input-field mono" style="width:64px;padding:4px 6px;text-align:right" [(ngModel)]="r.sold" (ngModelChange)="touch()" /></td>
          <td class="num"><input type="number" min="0" [max]="r.pending" class="input-field mono" style="width:64px;padding:4px 6px;text-align:right" [(ngModel)]="r.returned" (ngModelChange)="touch()" /></td></tr> }</tbody></table>
      <div style="display:flex;gap:16px;justify-content:flex-end;margin:12px 0;font-size:13px"><span>Bruto: <b>{{ gross() | brl }}</b></span><span>Comissão: <b>{{ commission() | brl }}</b></span><span>Líquido a receber: <b style="color:#0875D1">{{ net() | brl }}</b></span></div>
      @if (net() > 0) {
        <div style="display:flex;gap:8px;margin-bottom:8px">@for (o of [['agora','Receber agora'],['prazo','Lançar a receber']]; track o[0]) { <span class="chip" [class.active]="payMode === o[0]" (click)="payMode = o[0]; touch()">{{ o[1] }}</span> }</div>
        @if (payMode === 'agora') { <ax-payments-editor [total]="net()" [(rows)]="pays" /> } @else { <label class="field-label">Vencimento</label><input type="date" class="input-field" style="width:180px" [(ngModel)]="due" /> }
      }
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:10px"><input type="checkbox" [(ngModel)]="close" /> Encerrar a consignação após este acerto (exige que todas as peças sejam vendidas ou devolvidas)</label>
      <div footer><button class="btn-secondary" (click)="settleOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy()" (click)="settle()">Confirmar acerto</button></div>
    </ax-modal>
    <ax-modal [(open)]="shipOpen" title="Nova remessa para a parceira" icon="package-plus" [width]="520">
      <ax-variant-picker (selected)="ship($event)" /><p style="font-size:11px;color:#647687;margin-top:8px">Cada peça bipada é enviada imediatamente (1 unidade).</p>
    </ax-modal>
    }
  }`,
})
export class ConsignacaoDetailPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly id = input<string>();
  readonly k = signal<any>(null); readonly loading = signal(false); readonly error = signal<string | null>(null); readonly busy = signal(false); private tick = signal(0);
  readonly partner = signal<any>(null); readonly items = signal<{ v: any; qty: number }[]>([]); f: any = { commissionPct: 30, dueDate: addDaysIso(todayIso(), 30), notes: '' };
  readonly pieces = computed(() => { this.tick(); return this.items().reduce((s, i) => s + (+i.qty || 0), 0); });
  readonly value = computed(() => { this.tick(); return this.items().reduce((s, i) => s + (+i.qty || 0) * i.v.price, 0); });
  readonly settleOpen = signal(false); readonly shipOpen = signal(false); readonly rows = signal<any[]>([]); pays = signal<PaymentRow[]>([]); payMode = 'prazo'; due = addDaysIso(todayIso(), 7); close = false;
  private idem = newIdempotencyKey();
  readonly gross = computed(() => { this.tick(); return Math.round(this.rows().reduce((s, r) => s + (+r.sold || 0) * r.price, 0) * 100) / 100; });
  readonly commission = computed(() => Math.round(this.gross() * Number(this.k()?.commission_pct ?? 0)) / 100);
  readonly net = computed(() => Math.round((this.gross() - this.commission()) * 100) / 100);
  ngOnInit() { if (this.id()) this.load(); }
  touch() { this.tick.update((x) => x + 1); }
  add(v: any) { const ex = this.items().find((i) => i.v.id === v.id); if (ex) { ex.qty++; this.touch(); } else this.items.update((l) => [...l, { v, qty: 1 }]); }
  rm(i: any) { this.items.update((l) => l.filter((x) => x !== i)); }
  async create() {
    this.busy.set(true);
    try { const k: any = await this.api.post('/consignments', { partnerId: this.partner().id, commissionPct: +this.f.commissionPct || 0, dueDate: this.f.dueDate || undefined, notes: this.f.notes || undefined,
        items: this.items().map((i) => ({ variantId: i.v.id, qty: Math.max(1, Math.floor(+i.qty)) })) }, { idempotent: this.idem });
      this.toast.success(`Consignação nº ${k.number} criada.`); this.router.navigateByUrl('/consignacao-detail/' + k.id); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async load() { this.loading.set(true); this.error.set(null); try { this.k.set(await this.api.get('/consignments/' + this.id())); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); } }
  openSettle() { this.rows.set(this.k().items.filter((i: any) => i.pending > 0).map((i: any) => ({ variantId: i.variant_id, label: `${i.name} ${i.color ?? ''} ${i.size ?? ''} · ${i.sku}`, pending: i.pending, sold: 0, returned: 0, price: Number(i.unit_price) })));
    this.pays.set([]); this.close = false; this.idem = newIdempotencyKey(); this.settleOpen.set(true); }
  async settle() {
    const sold = this.rows().filter((r) => +r.sold > 0).map((r) => ({ variantId: r.variantId, qty: Math.floor(+r.sold) }));
    const returned = this.rows().filter((r) => +r.returned > 0).map((r) => ({ variantId: r.variantId, qty: Math.floor(+r.returned) }));
    this.busy.set(true);
    try { const r: any = await this.api.post(`/consignments/${this.id()}/settle`, { sold, returned, close: this.close || undefined, payments: this.payMode === 'agora' && this.net() > 0 ? PaymentsEditorComponent.toApi(this.pays()) : undefined, dueDate: this.payMode === 'prazo' ? this.due : undefined }, { idempotent: this.idem });
      this.toast.success(`Acerto nº ${r.settlement.number} registrado${r.sale ? ' (venda nº ' + r.sale.number + ')' : ''}.`); this.settleOpen.set(false); this.load(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async ship(v: any) { try { await this.api.post(`/consignments/${this.id()}/ship`, { items: [{ variantId: v.id, qty: 1 }] }); this.toast.success(`${v.sku} enviada.`); this.load(); } catch (e) { this.toast.error(e); } }
}
