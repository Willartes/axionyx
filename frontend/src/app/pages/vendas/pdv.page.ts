import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CustomerPickerComponent, ModalComponent, VariantPickerComponent } from '../../shared/ui';
import { Api, ApiError, newIdempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT } from '../../core/format';
import { ScaleService } from '../../core/scale.service';

interface CartItem { variant: any; qty: number; discount: number; key: string; kind?: 'unidade' | 'peso' | 'embalagem' | 'combo' | 'balanca' | 'atendimento' | 'plano' | 'os'; packagingId?: string; comboId?: string; scaleCode?: string; lineTotal?: number
  professionalId?: string; professionalName?: string; appointmentServiceId?: string; planItemId?: string; workOrderItemId?: string }
/** Preço unitário considerando o preço por quantidade (atacarejo) do produto; o servidor recalcula e é a referência. */
const unitPrice = (i: CartItem) => {
  if (i.kind && i.kind !== 'peso') return Number(i.variant.price);
  const t = (i.variant.price_tiers ?? []).filter((x: any) => i.qty + 1e-9 >= Number(x.min_qty)).pop();
  return t ? Number(t.unit_price) : Number(i.variant.price);
};
const lineGross = (i: CartItem) => i.lineTotal ?? Math.round(unitPrice(i) * i.qty * 100) / 100;
interface Pay { methodId: string; kind: string; name: string; amount: number; installments: number; storeCreditCode?: string; firstDueDate?: string }

@Component({
  selector: 'ax-pdv',
  imports: [FormsModule, IconComponent, CustomerPickerComponent, VariantPickerComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .pay-btn { display:flex; flex-direction:column; align-items:center; gap:4px; padding:10px 6px; border:1px solid #DCE4EC; border-radius:8px; background:white; cursor:pointer; font-size:11px; font-weight:500; color:#172B3A; }
    .pay-btn:hover { border-color:#0875D1; background:#F5F9FE; }
    .pay-btn.active { border-color:#0875D1; background:#E3EFF9; color:#0875D1; }
    .qty-btn { width:24px; height:24px; border:1px solid #DCE4EC; border-radius:5px; background:white; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
    .tot-row { display:flex; justify-content:space-between; font-size:13px; padding:4px 0; }
    @media print { :host .no-receipt { display:none !important; } }
  `],
  template: `
  <div class="no-receipt pdv-layout" style="display:flex;height:100%;min-height:600px">
    <!-- Itens -->
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0">
      <div class="page-header" style="gap:10px">
        <div style="flex:1;min-width:200px">
          <h1>PDV — Frente de Caixa</h1>
          @if (session(); as s) { <p><span style="color:#18864B;font-weight:600">● {{ s.register_name }} aberto</span> por {{ s.opened_by_name }} às {{ s.opened_at | dtt }} · {{ s.summary?.sales?.n || 0 }} venda(s) na sessão</p> }
          @else { <p style="color:#C93636">● Caixa fechado — abra o caixa para vender</p> }
        </div>
        @if (session()) {
          <button class="btn-ghost" style="font-size:12px" (click)="router.navigateByUrl('/caixa')"><ax-icon name="wallet" [size]="13" /> Caixa (sangria/fechamento)</button>
        } @else if (auth.can('caixa.operar')) {
          <button class="btn-primary" style="font-size:12px" (click)="openCash()"><ax-icon name="unlock" [size]="13" /> Abrir caixa</button>
        }
        <button class="btn-ghost" style="font-size:12px" (click)="router.navigateByUrl('/trocas')"><ax-icon name="repeat" [size]="13" /> Trocas</button>
        <button class="btn-ghost" style="font-size:12px;color:#C93636" [disabled]="!cart().length" (click)="clearSale()"><ax-icon name="trash-2" [size]="13" /> Cancelar (Esc)</button>
      </div>

      <div style="padding:14px 24px;background:white;border-bottom:1px solid #F0F4F8">
        <ax-variant-picker #picker [big]="true" [placeholder]="auth.has('agenda') ? 'Bipe o código, digite produto/serviço e Enter (F2)' : 'Bipe o código de barras ou digite nome/SKU e Enter (F2)'" (selected)="add($event)" />
        @if (origin(); as o) { <div style="margin-top:8px;font-size:12px;background:#F0F7FD;border:1px solid #CFE3F5;border-radius:8px;padding:7px 10px;display:flex;gap:8px;align-items:center"><ax-icon name="info" [size]="13" color="#0875D1" /><span>{{ o }}</span></div> }
      </div>

      <div style="flex:1;overflow-y:auto;background:white">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead style="position:sticky;top:0"><tr><th style="width:36px">#</th><th>Produto</th>@if (auth.has('grade')) { <th>{{ auth.term('cor') }} / {{ auth.term('tamanho') }}</th> }@if (auth.has('agenda')) { <th>{{ auth.term('profissional') }}</th> }<th class="num">Preço</th><th style="text-align:center">Qtd.</th><th class="num">Desconto</th><th class="num">Total</th><th style="width:40px"></th></tr></thead>
          <tbody>
            @for (it of cart(); track it.key; let i = $index) {
              <tr>
                <td class="mono" style="color:#647687;font-size:12px">{{ i + 1 }}</td>
                <td><div style="font-weight:500">{{ it.variant.name }}@if (it.kind === 'combo') { <span class="badge badge-info" style="margin-left:6px">Combo</span> }@if (it.kind === 'atendimento') { <span class="badge badge-info" style="margin-left:6px">Atendimento</span> }@if (it.kind === 'plano') { <span class="badge badge-info" style="margin-left:6px">Plano de tratamento</span> }@if (it.kind === 'os') { <span class="badge badge-info" style="margin-left:6px">OS</span> }@if (it.variant.kind === 'servico' && !it.kind) { <span class="badge badge-muted" style="margin-left:6px">Serviço</span> }@if (it.variant.kind === 'pacote') { <span class="badge badge-info" style="margin-left:6px">Pacote</span> }@if (it.kind === 'embalagem') { <span class="badge badge-muted" style="margin-left:6px">Embalagem</span> }@if (it.variant.age_restricted) { <span class="badge badge-warning" style="margin-left:6px">+18</span> }</div>
                  <div class="mono" style="font-size:11px;color:#647687">{{ it.variant.sku }}{{ it.variant.barcode ? ' · ' + it.variant.barcode : '' }}{{ it.kind === 'balanca' ? ' · etiqueta de balança' : '' }}</div>
                  @if (it.variant.track_stock && it.qty > it.variant.stock && !it.kind) { <div style="font-size:11px;color:#C93636">Saldo na filial: {{ it.variant.stock }}</div> }</td>
                @if (auth.has('grade')) { <td><span style="display:inline-flex;align-items:center;gap:5px;font-size:12px">@if (it.variant.color) { <span [style.background]="it.variant.color_hex || '#ccc'" style="width:9px;height:9px;border-radius:50%;border:1px solid #DCE4EC"></span>{{ it.variant.color }} } @if (it.variant.size) { <span class="badge badge-muted">{{ it.variant.size }}</span> }</span></td> }
                @if (auth.has('agenda')) { <td>@if (it.kind === 'atendimento' || it.kind === 'plano' || it.kind === 'os') { <span style="font-size:12px">{{ it.professionalName || '—' }}</span> } @else if (it.variant.kind !== 'pacote') {
                  <select class="input-field" style="font-size:12px;padding:3px 6px;min-width:120px" [ngModel]="it.professionalId || ''" (ngModelChange)="setProf(i, $event)"><option value="">{{ it.variant.kind === 'servico' ? 'Selecione…' : '— vendedor —' }}</option>@for (p of lk.data()?.professionals ?? []; track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select> } @else { <span class="muted" style="font-size:11px">na execução</span> }</td> }
                <td class="num">{{ unit(it) | brl }}{{ it.kind === 'peso' || it.kind === 'balanca' ? '/kg' : '' }}@if (unit(it) < it.variant.price && !it.kind) { <div style="font-size:10px;color:#18864B">preço por quantidade</div> }@else if (it.variant.price_tiers?.length && !it.kind) { <div style="font-size:10px;color:#647687">a partir de {{ it.variant.price_tiers[0].min_qty }}: {{ it.variant.price_tiers[0].unit_price | brl }}</div> }</td>
                <td style="text-align:center;white-space:nowrap">
                  @if (it.kind === 'peso' || it.kind === 'balanca') {
                    <button class="btn-ghost mono" style="font-weight:600;padding:3px 8px" [disabled]="it.kind === 'balanca'" (click)="editWeight(i)" title="Alterar peso">{{ it.qty | num:3 }} kg</button>
                  } @else if (it.kind === 'atendimento' || it.kind === 'plano' || it.kind === 'os') {
                    <span class="mono" style="font-weight:600">{{ it.qty }}</span>
                  } @else {
                    <button class="qty-btn" (click)="setQty(i, it.qty - 1)" aria-label="Diminuir"><ax-icon name="minus" [size]="12" /></button>
                    <span class="mono" style="display:inline-block;min-width:28px;text-align:center;font-weight:600">{{ it.qty }}</span>
                    <button class="qty-btn" (click)="setQty(i, it.qty + 1)" aria-label="Aumentar"><ax-icon name="plus" [size]="12" /></button>
                  }
                </td>
                <td class="num"><input type="number" min="0" step="0.01" class="input-field mono" style="width:90px;padding:4px 6px;text-align:right;font-size:12px" [ngModel]="it.discount" (ngModelChange)="setDisc(i, $event)" /></td>
                <td class="num" style="font-weight:600">{{ gross(it) - it.discount | brl }}</td>
                <td><button class="btn-ghost" style="padding:3px;color:#C93636" (click)="remove(i)" aria-label="Remover"><ax-icon name="x" [size]="14" /></button></td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="7 + (auth.has('grade') ? 1 : 0) + (auth.has('agenda') ? 1 : 0)"><div class="empty-state" style="padding:70px 20px"><ax-icon name="scan-barcode" [size]="40" color="#C8D6E3" /><div style="margin-top:10px;font-size:14px">Bipe ou busque um produto para iniciar a venda</div><div style="font-size:12px;margin-top:4px"><span class="kbd">F2</span> buscar · <span class="kbd">F9</span> finalizar · <span class="kbd">Esc</span> cancelar</div></div></td></tr>
            }
          </tbody>
        </table>
      </div>
      <div style="padding:10px 24px;background:white;border-top:1px solid #DCE4EC;display:flex;justify-content:space-between;font-size:13px;color:#647687">
        <span>{{ totalQty() }} {{ auth.has('grade') ? 'peça(s)' : 'unidade(s)' }} · {{ cart().length }} item(ns)</span>
        <span>Subtotal <b style="color:#172B3A;font-size:15px" class="mono">{{ subtotal() | brl }}</b></span>
      </div>
    </div>

    <!-- Resumo / pagamento -->
    <div class="pdv-side" style="width:380px;border-left:1px solid #DCE4EC;background:white;display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto">
      <div style="padding:14px 16px;border-bottom:1px solid #F0F4F8">
        <div class="field-label">Cliente</div>
        <ax-customer-picker [(value)]="customer" (valueChange)="onCustomer()" [disabled]="lockCustomer()" />
        @if (customer()) {
          <div style="display:flex;gap:10px;margin-top:8px;font-size:11px;color:#647687;flex-wrap:wrap">
            <span>Cashback: <b style="color:#18864B">{{ cashback() | brl }}</b></span>
            @if (customer().credit_limit > 0) { <span>Crediário disponível: <b style="color:#172B3A">{{ (customer().credit_limit - (customer().open_balance || 0)) | brl }}</b></span> }
            @if (customer().open_balance > 0) { <span style="color:#D99000">Em aberto: {{ customer().open_balance | brl }}</span> }
          </div>
        }
        <div class="field-label" style="margin-top:10px">Vendedor(a)</div>
        <select class="input-field" [(ngModel)]="sellerId">@for (s of lk.data()?.sellers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select>
      </div>

      <div style="padding:14px 16px;border-bottom:1px solid #F0F4F8">
        <div class="tot-row"><span class="muted">Subtotal</span><span class="mono">{{ subtotal() | brl }}</span></div>
        <div class="tot-row"><span class="muted">Descontos nos itens</span><span class="mono" style="color:#D99000">- {{ itemDiscounts() | brl }}</span></div>
        <div class="tot-row" style="align-items:center"><span class="muted">Desconto no total</span>
          <span style="display:flex;gap:4px;align-items:center">
            <input type="number" min="0" step="0.5" class="input-field mono" style="width:70px;padding:4px 6px;text-align:right;font-size:12px" [ngModel]="discountPct()" (ngModelChange)="setDiscountPct($event)" title="%" /><span class="muted" style="font-size:11px">%</span>
            <input type="number" min="0" step="0.01" class="input-field mono" style="width:90px;padding:4px 6px;text-align:right;font-size:12px" [ngModel]="discountTotal()" (ngModelChange)="discountTotal.set(+$event || 0)" title="R$" />
          </span></div>
        @if (discountPctTotal() > (me()?.user?.maxDiscountPct ?? 0)) { <div style="font-size:11px;color:#D99000;text-align:right">Desconto de {{ discountPctTotal() | num:1 }}% acima do seu limite ({{ me()?.user?.maxDiscountPct }}%) — exigirá autorização.</div> }
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:8px;padding-top:8px;border-top:1px solid #F0F4F8">
          <span style="font-size:13px;font-weight:600">Total</span><span class="mono" style="font-size:24px;font-weight:700;color:#172B3A">{{ total() | brl }}</span>
        </div>
      </div>

      <div style="padding:14px 16px;flex:1">
        <div class="field-label">Formas de pagamento</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px">
          @for (m of methods(); track m.id) {
            <button class="pay-btn" [class.active]="curMethod()?.id === m.id" (click)="selectMethod(m)"><ax-icon [name]="iconOf(m.kind)" [size]="16" />{{ m.name }}</button>
          }
        </div>
        @if (curMethod(); as m) {
          <div style="background:#F7FAFD;border:1px solid #DCE4EC;border-radius:8px;padding:10px;margin-bottom:10px">
            <div style="display:flex;gap:8px;align-items:flex-end">
              <div style="flex:1"><label class="field-label">Valor ({{ m.name }})</label><input id="pay-amount" type="number" min="0" step="0.01" class="input-field mono" style="font-size:15px" [(ngModel)]="payAmount" (keydown.enter)="addPayment()" /></div>
              @if (m.kind === 'credito' || m.kind === 'crediario') {
                <div style="width:90px"><label class="field-label">Parcelas</label><select class="input-field" [(ngModel)]="payInst">@for (n of instOptions(m); track n) { <option [ngValue]="n">{{ n }}x</option> }</select></div>
              }
            </div>
            @if (m.kind === 'crediario') { <div style="margin-top:6px"><label class="field-label">1º vencimento</label><input type="date" class="input-field" [(ngModel)]="payFirstDue" /></div> }
            @if (m.kind === 'vale_troca') { <div style="margin-top:6px"><label class="field-label">Código do vale-troca</label><div style="display:flex;gap:6px"><input class="input-field mono" style="text-transform:uppercase" [(ngModel)]="payCode" /><button class="btn-secondary" style="font-size:12px" (click)="checkCredit()">Consultar</button></div>
              @if (creditInfo()) { <div style="font-size:11px;color:#647687;margin-top:4px">Saldo: <b>{{ creditInfo().balance | brl }}</b> · {{ creditInfo().status }} @if (creditInfo().customer) { · {{ creditInfo().customer }} }</div> }</div> }
            @if (m.kind === 'cashback' && !customer()) { <div style="font-size:11px;color:#C93636;margin-top:6px">Selecione o cliente para usar o cashback.</div> }
            @if (m.kind === 'crediario' && !customer()) { <div style="font-size:11px;color:#C93636;margin-top:6px">Crediário exige cliente identificado.</div> }
            <button class="btn-primary" style="width:100%;justify-content:center;margin-top:8px;font-size:12px" (click)="addPayment()"><ax-icon name="plus" [size]="13" /> Adicionar pagamento</button>
          </div>
        }
        @for (p of payments(); track $index) {
          <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #F0F4F8;font-size:13px">
            <ax-icon [name]="iconOf(p.kind)" [size]="14" color="#0875D1" />
            <span style="flex:1">{{ p.name }}@if (p.installments > 1) { <span class="muted"> · {{ p.installments }}x de {{ p.amount / p.installments | brl }}</span> }@if (p.storeCreditCode) { <span class="muted"> · {{ p.storeCreditCode }}</span> }</span>
            <span class="mono" style="font-weight:600">{{ p.amount | brl }}</span>
            <button class="btn-ghost" style="padding:2px;color:#C93636" (click)="removePayment($index)" aria-label="Remover pagamento"><ax-icon name="x" [size]="13" /></button>
          </div>
        }
        <div style="margin-top:10px">
          @if (remaining() > 0.004) { <div class="tot-row"><span style="color:#D99000;font-weight:600">Falta pagar</span><span class="mono" style="color:#D99000;font-weight:700">{{ remaining() | brl }}</span></div> }
          @if (change() > 0.004) { <div class="tot-row"><span style="color:#18864B;font-weight:600">Troco</span><span class="mono" style="color:#18864B;font-weight:700;font-size:16px">{{ change() | brl }}</span></div> }
        </div>
      </div>

      <div style="padding:12px 16px;border-top:1px solid #DCE4EC;display:flex;flex-direction:column;gap:6px;position:sticky;bottom:0;background:white">
        <label style="display:flex;gap:8px;align-items:center;font-size:12px;color:#647687"><input type="checkbox" [(ngModel)]="emitFiscal" /> Gerar NFC-e após a venda</label>
        @if (emitFiscal && hasServices()) { <div style="font-size:11px;color:#647687;margin-top:-2px">A NFC-e inclui só os produtos; serviços são documentados por NFS-e da prefeitura.</div> }
        <button class="btn-primary" style="justify-content:center;padding:12px 0;font-size:14px" [disabled]="!canFinish() || busy()" (click)="finish()">
          @if (busy()) { <span class="spinner" style="border-color:rgba(255,255,255,.4);border-top-color:white"></span> } <ax-icon name="check" [size]="16" /> Finalizar venda (F9)
        </button>
        <button class="btn-secondary" style="justify-content:center;font-size:12px" [disabled]="!cart().length || busy()" (click)="saveQuote()"><ax-icon name="file-text" [size]="13" /> Salvar como orçamento</button>
      </div>
    </div>
  </div>

  <!-- Peso -->
  <ax-modal [open]="!!weigh()" (closed)="weigh.set(null)" title="Informe o peso" icon="scale" [width]="420">
    @if (weigh(); as w) {
      <div style="font-size:15px;font-weight:600">{{ w.variant.name }}</div>
      <div style="font-size:12px;color:#647687;margin-bottom:12px">{{ w.variant.price | brl }} por kg</div>
      <label class="field-label">Peso (kg)</label>
      <input id="weigh-input" type="number" min="0.001" step="0.005" class="input-field mono" style="font-size:24px;font-weight:700;text-align:right" [(ngModel)]="weightKg" (keydown.enter)="confirmWeight()" />
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
        @if (scale.supported) { <button class="btn-secondary" style="font-size:12px" [disabled]="reading()" (click)="readScale()"><ax-icon name="scale" [size]="13" /> {{ reading() ? 'Lendo…' : 'Ler balança' }}</button> }
        @else { <span style="font-size:11px;color:#647687">Leitura automática disponível no Chrome/Edge.</span> }
        <span style="font-size:18px;font-weight:700">{{ (w.variant.price * (weightKg || 0)) | brl }}</span>
      </div>
    }
    <div footer><button class="btn-secondary" (click)="weigh.set(null)">Cancelar</button><button class="btn-primary" [disabled]="!((weightKg || 0) > 0)" (click)="confirmWeight()">Confirmar</button></div>
  </ax-modal>

  <!-- Maioridade -->
  <ax-modal [(open)]="ageOpen" title="Confirmação de maioridade" icon="shield-check" [width]="440" [dismissable]="false">
    <div class="state-warning" style="margin:0 0 12px"><ax-icon name="alert-triangle" [size]="14" /><span>{{ ageMsg() || 'Esta venda tem produto proibido para menores de ' + (me()?.settings?.maioridade?.idadeMinima || 18) + ' anos.' }}</span></div>
    <p style="font-size:13px;line-height:1.6">Confira um documento com foto do cliente antes de concluir. A confirmação fica registrada na venda com o seu usuário.</p>
    <div footer><button class="btn-secondary" (click)="ageOpen.set(false)">Não vender</button><button class="btn-primary" (click)="confirmAge()">Cliente tem {{ me()?.settings?.maioridade?.idadeMinima || 18 }} anos ou mais</button></div>
  </ax-modal>

  <!-- Abrir caixa -->
  <ax-modal [(open)]="cashOpen" title="Abrir caixa" icon="unlock" [width]="420">
    <label class="field-label">Terminal</label>
    <select class="input-field" [(ngModel)]="cashRegister" style="margin-bottom:10px">@for (r of registers(); track r.id) { <option [value]="r.id" [disabled]="!!r.open_session">{{ r.name }}{{ r.open_session ? ' (aberto por ' + r.open_session.opened_by_name + ')' : '' }}</option> }</select>
    <label class="field-label">Fundo de troco (R$)</label>
    <input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="cashAmount" />
    <div footer><button class="btn-secondary" (click)="cashOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="doOpenCash()">Abrir caixa</button></div>
  </ax-modal>

  <!-- Autorização de desconto -->
  <ax-modal [(open)]="authOpen" title="Autorização de desconto" icon="shield-check" [width]="420">
    <div class="state-warning" style="margin-bottom:12px"><ax-icon name="alert-triangle" [size]="14" />{{ authMsg() }}</div>
    <label class="field-label">E-mail do supervisor</label><input class="input-field" [(ngModel)]="supEmail" style="margin-bottom:8px" autocomplete="off" />
    <label class="field-label">Senha</label><input type="password" class="input-field" [(ngModel)]="supPass" (keydown.enter)="authorize()" autocomplete="new-password" />
    <div footer><button class="btn-secondary" (click)="authOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="authorize()">Autorizar e finalizar</button></div>
  </ax-modal>

  <!-- Venda concluída -->
  <ax-modal [(open)]="doneOpen" title="Venda concluída" icon="check-circle-2" [width]="460" [dismissable]="false">
    @if (done(); as d) {
      <div style="text-align:center;padding:6px 0 10px">
        <div style="font-size:12px;color:#647687">Venda nº</div><div class="mono" style="font-size:28px;font-weight:700;color:#0875D1">{{ d.number }}</div>
        <div style="font-size:20px;font-weight:700;margin-top:6px">{{ d.total | brl }}</div>
        @if (d.change > 0) { <div style="margin-top:10px;background:#E8F5EE;border-radius:8px;padding:10px;color:#18864B;font-weight:700;font-size:18px">Troco: {{ d.change | brl }}</div> }
        @if (d.cashback_earned > 0) { <div style="margin-top:8px;font-size:12px;color:#18864B">Cliente ganhou {{ d.cashback_earned | brl }} de cashback</div> }
        @if (d.fiscal_document_id) { <div style="margin-top:8px;font-size:12px;color:#647687">Documento fiscal gerado — acompanhe em Fiscal › Documentos.</div> }
      </div>
    }
    <div footer style="flex-wrap:wrap">
      <button class="btn-ghost" (click)="printReceipt()"><ax-icon name="printer" [size]="13" /> Comprovante</button>
      @if (done()?.hasCrediario) { <button class="btn-ghost" (click)="router.navigate(['/carne'], { queryParams: { venda: done().id } })"><ax-icon name="notebook-pen" [size]="13" /> Carnê</button> }
      <button class="btn-ghost" (click)="router.navigateByUrl('/pedido-detail/' + done()?.id)">Ver venda</button>
      <button class="btn-primary" (click)="newSale()">Nova venda</button>
    </div>
  </ax-modal>

  <!-- Comprovante não fiscal (impressão) -->
  @if (receipt(); as r) {
    <div id="receipt" class="print-only" style="font-family:'JetBrains Mono',monospace;font-size:11px;width:280px;padding:8px">
      <div style="text-align:center;font-weight:700">{{ me()?.company?.trade_name || me()?.company?.name }}</div>
      <div style="text-align:center">{{ me()?.branch?.name }}</div>
      <div style="text-align:center;margin:4px 0">COMPROVANTE DE VENDA Nº {{ r.number }}<br />NÃO É DOCUMENTO FISCAL</div>
      <div>{{ r.date }}</div><div>Cliente: {{ r.customer || 'Consumidor' }}</div><div>Vendedor: {{ r.seller }}</div>
      <div style="border-top:1px dashed #000;margin:4px 0"></div>
      @for (i of r.items; track $index) { <div>{{ i.name }} {{ i.color }} {{ i.size }}</div><div style="display:flex;justify-content:space-between"><span>{{ i.qty }} x {{ i.price | brl }}</span><span>{{ i.total | brl }}</span></div> }
      <div style="border-top:1px dashed #000;margin:4px 0"></div>
      <div style="display:flex;justify-content:space-between"><span>Descontos</span><span>{{ r.discount | brl }}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:700"><span>TOTAL</span><span>{{ r.total | brl }}</span></div>
      @for (p of r.payments; track $index) { <div style="display:flex;justify-content:space-between"><span>{{ p.name }}{{ p.installments > 1 ? ' ' + p.installments + 'x' : '' }}</span><span>{{ p.amount | brl }}</span></div> }
      @if (r.change > 0) { <div style="display:flex;justify-content:space-between"><span>Troco</span><span>{{ r.change | brl }}</span></div> }
      <div style="text-align:center;margin-top:6px">Trocas em até {{ me()?.settings?.trocas?.prazoDias || 30 }} dias com este comprovante.</div>
    </div>
  }`,
})
export class PdvPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService); private route = inject(ActivatedRoute);
  readonly picker = viewChild<VariantPickerComponent>('picker');
  readonly me = this.auth.me;
  readonly session = signal<any>(null); readonly registers = signal<any[]>([]);
  readonly cart = signal<CartItem[]>([]); readonly customer = signal<any>(null); readonly cashback = signal(0);
  readonly payments = signal<Pay[]>([]); readonly discountTotal = signal(0); readonly curMethod = signal<any>(null); readonly creditInfo = signal<any>(null);
  readonly busy = signal(false); readonly cashOpen = signal(false); readonly authOpen = signal(false); readonly authMsg = signal(''); readonly doneOpen = signal(false); readonly done = signal<any>(null); readonly receipt = signal<any>(null);
  sellerId = ''; payAmount: number | null = null; payInst = 1; payCode = ''; payFirstDue = ''; cashRegister = ''; cashAmount = 200; supEmail = ''; supPass = ''; emitFiscal = false;
  private idemKey = newIdempotencyKey();

  readonly methods = computed(() => (this.lk.data()?.paymentMethods ?? []));
  readonly subtotal = computed(() => this.cart().reduce((s, i) => s + lineGross(i), 0));
  readonly itemDiscounts = computed(() => this.cart().reduce((s, i) => s + (i.discount || 0), 0));
  readonly total = computed(() => Math.max(0, Math.round((this.subtotal() - this.itemDiscounts() - this.discountTotal()) * 100) / 100));
  readonly totalQty = computed(() => this.cart().reduce((s, i) => s + (i.kind === 'peso' || i.kind === 'balanca' ? 1 : i.qty), 0));
  readonly discountPct = computed(() => { const base = this.subtotal() - this.itemDiscounts(); return base > 0 ? Math.round((this.discountTotal() / base) * 10000) / 100 : 0; });
  readonly discountPctTotal = computed(() => (this.subtotal() > 0 ? ((this.itemDiscounts() + this.discountTotal()) / this.subtotal()) * 100 : 0));
  readonly paid = computed(() => this.payments().reduce((s, p) => s + p.amount, 0));
  readonly remaining = computed(() => Math.max(0, Math.round((this.total() - this.paid()) * 100) / 100));
  readonly change = computed(() => Math.max(0, Math.round((this.paid() - this.total()) * 100) / 100));
  readonly canFinish = computed(() => this.cart().length > 0 && this.remaining() <= 0.004 && this.total() > 0);

  async ngOnInit() {
    await this.lk.ensure();
    this.sellerId = this.me()!.user.id;
    if (!this.lk.data()?.sellers?.find((s) => s.id === this.sellerId)) this.sellerId = this.me()!.user.id;
    this.loadSession();
    await this.loadOrigin();
    const cid = this.route.snapshot.queryParamMap.get('cliente');
    if (cid) { try { const c = await this.api.get<any>('/customers/' + cid); this.customer.set({ ...c, open_balance: c.open_balance }); this.onCustomer(); } catch { /* ignora */ } }
    setTimeout(() => this.picker()?.focus(), 100);
  }
  readonly origin = signal(''); readonly lockCustomer = signal(false);
  readonly hasServices = computed(() => this.cart().some((i) => i.variant.kind === 'servico' || i.variant.kind === 'pacote' || i.kind === 'atendimento' || i.kind === 'plano' || i.kind === 'os'));
  private myProfessional() { const uid = this.me()?.user?.id; return this.lk.data()?.professionals?.find((p) => p.user_id === uid)?.id; }
  setProf(i: number, id: string) { const l = [...this.cart()]; l[i] = { ...l[i], professionalId: id || undefined }; this.cart.set(l); }
  private async loadOrigin() {
    const q = this.route.snapshot.queryParamMap; const ap = q.get('atendimento'), pl = q.get('plano'), os = q.get('os');
    if (os) { await this.loadWorkOrder(os); return; }
    if (!ap && !pl) return;
    try {
      const r: any = await this.api.get(ap ? `/appointments/${ap}/checkout` : `/treatment-plans/${pl}/checkout`);
      if (r.customer) { this.customer.set(r.customer); this.onCustomer(); this.lockCustomer.set(true); }
      const items: CartItem[] = r.items.map((x: any) => ap
        ? { key: 'as:' + x.appointment_service_id, kind: 'atendimento', appointmentServiceId: x.appointment_service_id, professionalName: x.professional, qty: 1, discount: 0,
            variant: { id: x.variant_id, name: x.name, sku: x.sku, barcode: x.barcode, price: Number(x.price), track_stock: false, kind: 'servico' } }
        : { key: 'pi:' + x.plan_item_id, kind: 'plano', planItemId: x.plan_item_id, professionalName: x.professional, qty: x.qty, discount: 0, lineTotal: Number(x.total),
            variant: { id: x.variant_id, name: x.name + (x.tooth ? ' (dente ' + x.tooth + ')' : ''), sku: x.sku, barcode: x.barcode, price: Number(x.unit_price), track_stock: false, kind: 'servico' } });
      this.cart.set(items);
      const covered = (r.covered ?? []).length;
      this.origin.set(ap ? `Cobrança do atendimento nº ${r.appointment.number}${covered ? ` — ${covered} serviço(s) coberto(s) por pacote/plano não são cobrados aqui` : ''}. Você pode incluir produtos vendidos no atendimento.`
        : `Cobrança do plano de tratamento nº ${r.plan.number} (valores e descontos aprovados no plano). Use o crediário para parcelar.`);
      if (!items.length) this.toast.show('Nada a cobrar: os serviços já foram cobrados ou são cobertos por pacote/plano.', 'info');
    } catch (e) { this.toast.error(e); }
  }
  /** Cobrança da ordem de serviço: itens aprovados com preços e descontos da OS (peças baixam do estoque na venda). */
  private async loadWorkOrder(id: string) {
    try {
      const r: any = await this.api.get(`/work-orders/${id}/checkout`);
      if (r.customer) { this.customer.set(r.customer); this.onCustomer(); this.lockCustomer.set(true); }
      this.cart.set(r.items.map((x: any) => ({ key: 'wo:' + x.work_order_item_id, kind: 'os', workOrderItemId: x.work_order_item_id, professionalName: x.professional, qty: Number(x.qty), discount: 0, lineTotal: Number(x.total),
        variant: { id: x.variant_id, name: x.description, sku: x.sku, barcode: x.barcode, price: Number(x.unit_price), track_stock: x.track_stock, kind: x.kind === 'servico' || x.kind === 'mao_de_obra' ? 'servico' : 'produto', unit: x.unit } })));
      this.origin.set(`Cobrança da OS nº ${r.workOrder.number} — ${r.workOrder.model} (${r.workOrder.plate || 'sem placa'}): valores aprovados pelo cliente.${r.pending ? ` ${r.pending} item(ns) ainda aguardam aprovação e não entram aqui.` : ''} Ao concluir, a OS pronta é entregue automaticamente.`);
      if (!r.items.length) this.toast.show('Nada a cobrar: os itens aprovados desta OS já foram cobrados.', 'info');
    } catch (e) { this.toast.error(e); }
  }
  async loadSession() { try { this.session.set(await this.api.get('/cash/current')); } catch { this.session.set(null); } }
  iconOf(k: string) { return ({ dinheiro: 'banknote', pix: 'qr-code', debito: 'credit-card', credito: 'credit-card', crediario: 'notebook-pen', vale_troca: 'ticket', cashback: 'gift', boleto: 'barcode' } as any)[k] || 'wallet'; }
  instOptions(m: any) { const max = m.kind === 'crediario' ? (this.me()?.settings?.crediario?.maxParcelas ?? 10) : Math.max(1, m.max_installments); return Array.from({ length: max }, (_, i) => i + 1); }

  readonly scale = inject(ScaleService);
  readonly weigh = signal<{ variant: any; index: number | null } | null>(null); readonly reading = signal(false); weightKg: number | null = null;
  readonly ageOpen = signal(false); readonly ageMsg = signal(''); private ageConfirmed = false;
  gross(i: CartItem) { return lineGross(i); }
  unit(i: CartItem) { return unitPrice(i); }
  add(v: any) {
    if (v.kind === 'balanca') {
      this.cart.update((l) => [...l, { key: 'bal:' + v.scaleCode + ':' + Date.now(), kind: 'balanca', scaleCode: v.scaleCode, variant: { id: v.id, name: v.name, sku: v.sku, price: Number(v.unit_price), track_stock: false }, qty: Number(v.qty), discount: 0, lineTotal: Number(v.price) }]);
      return;
    }
    if (v.kind === 'embalagem' || v.kind === 'combo') {
      const key = v.kind + ':' + v.id; const items = [...this.cart()]; const i = items.findIndex((x) => x.key === key);
      if (i >= 0) items[i] = { ...items[i], qty: items[i].qty + 1 };
      else items.push({ key, kind: v.kind, packagingId: v.kind === 'embalagem' ? v.id : undefined, comboId: v.kind === 'combo' ? v.id : undefined,
        variant: { id: v.id, name: v.kind === 'embalagem' ? `${v.product} — ${v.name}` : v.name, sku: v.kind === 'embalagem' ? `${v.sku} ×${v.units}` : v.code, barcode: v.barcode, price: Number(v.price), track_stock: false, age_restricted: !!v.age_restricted }, qty: 1, discount: 0 });
      this.cart.set(items); return;
    }
    if (v.sale_by_weight) { this.weightKg = null; this.weigh.set({ variant: v, index: null }); setTimeout(() => (document.getElementById('weigh-input') as HTMLInputElement)?.focus(), 50); return; }
    if (v.kind === 'servico') { this.cart.update((l) => [...l, { key: 'srv:' + v.id + ':' + Date.now(), variant: v, qty: 1, discount: 0, professionalId: this.myProfessional() }]); return; }
    if (v.kind === 'pacote' && !this.customer()) this.toast.show('Pacote: selecione o cliente — o saldo de sessões fica na ficha dele.', 'info');
    const items = [...this.cart()];
    const i = items.findIndex((x) => x.key === v.id);
    if (i >= 0) items[i] = { ...items[i], qty: items[i].qty + 1 }; else items.push({ key: v.id, variant: v, qty: 1, discount: 0 });
    this.cart.set(items);
    if (v.track_stock && (i >= 0 ? items[i].qty : 1) > v.stock) this.toast.show(`Atenção: saldo de ${v.sku} nesta filial é ${v.stock}.`, 'info');
  }
  editWeight(i: number) { const it = this.cart()[i]; this.weightKg = it.qty; this.weigh.set({ variant: it.variant, index: i }); setTimeout(() => (document.getElementById('weigh-input') as HTMLInputElement)?.select(), 50); }
  confirmWeight() {
    const w = this.weigh(); const kg = Math.round((+(this.weightKg || 0)) * 1000) / 1000;
    if (!w || !(kg > 0)) return;
    if (w.index !== null) { const l = [...this.cart()]; l[w.index] = { ...l[w.index], qty: kg }; this.cart.set(l); }
    else this.cart.update((l) => [...l, { key: 'peso:' + w.variant.id + ':' + Date.now(), kind: 'peso', variant: w.variant, qty: kg, discount: 0 }]);
    this.weigh.set(null); setTimeout(() => this.picker()?.focus());
  }
  async readScale() {
    this.reading.set(true);
    try { this.weightKg = await this.scale.read(this.me()?.settings?.balanca?.baudRate || 9600); } catch (e: any) { this.toast.error(e.message || e); } finally { this.reading.set(false); }
  }
  confirmAge() { this.ageConfirmed = true; this.ageOpen.set(false); this.finish(); }
  setQty(i: number, q: number) { if (q <= 0) return this.remove(i); const l = [...this.cart()]; l[i] = { ...l[i], qty: q }; this.cart.set(l); }
  setDisc(i: number, d: any) { const l = [...this.cart()]; const max = lineGross(l[i]); l[i] = { ...l[i], discount: Math.min(Math.max(0, +d || 0), max) }; this.cart.set(l); }
  remove(i: number) { this.cart.set(this.cart().filter((_, k) => k !== i)); }
  setDiscountPct(p: any) { const base = this.subtotal() - this.itemDiscounts(); this.discountTotal.set(Math.round(base * (Math.max(0, +p || 0) / 100) * 100) / 100); }
  async onCustomer() {
    this.cashback.set(0);
    const c = this.customer(); if (!c) return;
    try { const l: any = await this.api.get('/loyalty/customers/' + c.id); this.cashback.set(l.balance); } catch { /* sem permissão */ }
  }
  selectMethod(m: any) {
    this.curMethod.set(m); this.payInst = 1; this.payCode = ''; this.creditInfo.set(null);
    this.payAmount = m.kind === 'cashback' ? Math.min(this.remaining(), this.cashback()) : this.remaining();
    if (m.kind === 'crediario') { const d = new Date(); d.setDate(d.getDate() + 30); this.payFirstDue = d.toISOString().slice(0, 10); }
    setTimeout(() => (document.getElementById('pay-amount') as HTMLInputElement)?.select(), 30);
  }
  async checkCredit() { try { this.creditInfo.set(await this.api.get('/store-credits/' + this.payCode.trim().toUpperCase())); } catch (e) { this.creditInfo.set(null); this.toast.error(e); } }
  addPayment() {
    const m = this.curMethod(); const amount = Math.round((+(this.payAmount || 0)) * 100) / 100;
    if (!m || amount <= 0) return;
    if ((m.kind === 'crediario' || m.kind === 'cashback') && !this.customer()) { this.toast.error('Selecione o cliente.'); return; }
    if (m.kind !== 'dinheiro' && amount > this.remaining() + 0.004) { this.toast.error('Somente pagamento em dinheiro pode exceder o total (troco).'); return; }
    if (m.kind === 'vale_troca' && !this.payCode.trim()) { this.toast.error('Informe o código do vale-troca.'); return; }
    this.payments.update((l) => [...l, { methodId: m.id, kind: m.kind, name: m.name, amount, installments: this.payInst || 1, storeCreditCode: m.kind === 'vale_troca' ? this.payCode.trim().toUpperCase() : undefined, firstDueDate: m.kind === 'crediario' ? this.payFirstDue : undefined }]);
    this.curMethod.set(null); this.payAmount = null;
  }
  removePayment(i: number) { this.payments.update((l) => l.filter((_, k) => k !== i)); }
  clearSale() { if (this.cart().length && !confirm('Cancelar a venda em andamento?')) return; this.reset(); }
  reset() { this.origin.set(''); this.lockCustomer.set(false); if (this.route.snapshot.queryParamMap.keys.length) this.router.navigate([], { queryParams: {} }); this.cart.set([]); this.payments.set([]); this.discountTotal.set(0); this.customer.set(null); this.cashback.set(0); this.curMethod.set(null); this.ageConfirmed = false; this.idemKey = newIdempotencyKey(); setTimeout(() => this.picker()?.focus()); }

  private body(extra: any = {}) {
    return {
      customerId: this.customer()?.id, sellerId: this.sellerId || undefined,
      items: this.cart().map((i) => i.kind === 'atendimento' ? { appointmentServiceId: i.appointmentServiceId, qty: 1, discount: i.discount || undefined }
        : i.kind === 'plano' ? { planItemId: i.planItemId, qty: i.qty, discount: i.discount || undefined }
        : i.kind === 'os' ? { workOrderItemId: i.workOrderItemId, qty: i.qty, discount: i.discount || undefined }
        : i.kind === 'balanca' ? { scaleCode: i.scaleCode, qty: i.qty, discount: i.discount || undefined, professionalId: i.professionalId }
        : i.kind === 'embalagem' ? { packagingId: i.packagingId, qty: i.qty, discount: i.discount || undefined, professionalId: i.professionalId }
        : i.kind === 'combo' ? { comboId: i.comboId, qty: i.qty, discount: i.discount || undefined, professionalId: i.professionalId }
        : { variantId: i.variant.id, qty: i.qty, discount: i.discount || undefined, professionalId: i.professionalId }),
      discountTotal: this.discountTotal() || undefined, emitFiscal: this.emitFiscal || undefined, ageConfirmed: this.ageConfirmed || undefined, ...extra,
    };
  }
  async finish(auth?: { email: string; password: string }) {
    if (!this.canFinish() || this.busy()) return;
    if (this.cart().some((i) => i.variant.kind === 'servico' && !i.kind && !i.professionalId) && this.auth.has('agenda') && !confirm('Há serviço sem profissional informado (a comissão não será calculada para ninguém além do vendedor). Continuar?')) return;
    if (!this.ageConfirmed && this.auth.has('maioridade') && this.me()?.settings?.maioridade?.exigirConfirmacao !== false && this.cart().some((i) => i.variant.age_restricted)) { this.ageMsg.set(''); this.ageOpen.set(true); return; }
    this.busy.set(true);
    const payments = this.payments().map((p) => ({ methodId: p.methodId, amount: p.amount, installments: p.installments > 1 ? p.installments : undefined, storeCreditCode: p.storeCreditCode, firstDueDate: p.firstDueDate }));
    try {
      const sale: any = await this.api.post('/sales', this.body({ payments, discountAuthorization: auth }), { idempotent: this.idemKey });
      this.authOpen.set(false); this.supPass = '';
      this.receipt.set({
        number: sale.number, date: new Date().toLocaleString('pt-BR'), customer: this.customer()?.name, seller: this.lk.data()?.sellers.find((s) => s.id === this.sellerId)?.name,
        items: this.cart().map((i) => ({ name: i.variant.name, color: i.variant.color || '', size: i.variant.size || '', qty: i.kind === 'peso' || i.kind === 'balanca' ? i.qty.toLocaleString('pt-BR', { minimumFractionDigits: 3 }) + ' kg' : i.qty, price: i.variant.price, total: lineGross(i) - i.discount })),
        discount: this.itemDiscounts() + this.discountTotal(), total: this.total(), payments: this.payments(), change: this.change(),
      });
      this.done.set({ ...sale, change: this.change(), hasCrediario: this.payments().some((p) => p.kind === 'crediario') });
      this.doneOpen.set(true);
      this.loadSession();
    } catch (e: any) {
      // Falhas não consomem a chave (o servidor a descarta no rollback); só uma venda concluída a "gasta".
      if (e instanceof ApiError && e.code === 'desconto_requer_autorizacao') { this.authMsg.set(e.message); this.authOpen.set(true); }
      else if (e instanceof ApiError && e.code === 'maioridade_requerida') { this.ageMsg.set(e.message); this.ageOpen.set(true); }
      else this.toast.error(e);
    } finally { this.busy.set(false); }
  }
  authorize() { this.finish({ email: this.supEmail.trim(), password: this.supPass }); }
  newSale() { this.doneOpen.set(false); this.receipt.set(null); this.done.set(null); this.reset(); }
  printReceipt() { document.body.classList.add('printing-receipt'); setTimeout(() => { window.print(); document.body.classList.remove('printing-receipt'); }, 50); }
  async saveQuote() {
    this.busy.set(true);
    try { const q: any = await this.api.post('/sales', this.body({ type: 'orcamento' }), { idempotent: true }); this.toast.success(`Orçamento nº ${q.number} salvo.`); this.reset(); }
    catch (e: any) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async openCash() {
    try { const r = await this.api.get<any[]>('/cash/registers'); this.registers.set(r); this.cashRegister = r.find((x) => !x.open_session)?.id ?? ''; this.cashOpen.set(true); } catch (e) { this.toast.error(e); }
  }
  async doOpenCash() {
    try { await this.api.post('/cash/open', { registerId: this.cashRegister, openingAmount: +this.cashAmount || 0 }, { idempotent: true }); this.toast.success('Caixa aberto.'); this.cashOpen.set(false); this.loadSession(); }
    catch (e) { this.toast.error(e); }
  }
  @HostListener('document:keydown', ['$event']) keys(e: KeyboardEvent) {
    if (e.key === 'F2') { e.preventDefault(); this.picker()?.focus(); }
    else if (e.key === 'F9') { e.preventDefault(); this.finish(); }
    else if (e.key === 'Escape' && !this.doneOpen() && !this.authOpen() && !this.cashOpen() && this.cart().length && (e.target as HTMLElement)?.tagName !== 'INPUT') this.clearSale();
  }
}
