import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, VariantPickerComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, brl } from '../../core/format';
import { CHECK_STATE, ITEM_KIND, ITEM_STATUS, VEHICLE_TYPE, WO_STATUS, formatPlate } from './oficina-shared';

const EDITABLE = ['orcamento', 'aguardando_aprovacao', 'aprovada', 'em_execucao', 'aguardando_peca', 'pronta'];

/** Ordem de serviço: orçamento (serviço, mão de obra por hora, peças e produtos), aprovação, execução, cobrança no PDV e entrega. */
@Component({
  selector: 'ax-os-detail',
  imports: [FormsModule, IconComponent, ModalComponent, VariantPickerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .head { display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; }
    .plate { font-family:'JetBrains Mono',monospace; font-weight:800; letter-spacing:.08em; background:#fff; border:2px solid #172B3A; border-radius:8px; padding:4px 12px; font-size:18px; }
    .plate small { display:block; font-size:8px; letter-spacing:.2em; text-align:center; color:#0875D1; margin-bottom:-2px; }
    .acts { display:flex; gap:8px; flex-wrap:wrap; padding:12px; background:#F7F9FB; border-radius:12px; margin:12px 0; }
    .cols { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(0,1fr); gap:14px; }
    .sec { font-size:11px; font-weight:700; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin-bottom:8px; }
    .tot { display:flex; justify-content:space-between; font-size:13px; padding:5px 0; }
    .tot.big { font-size:16px; font-weight:800; border-top:1px solid #E3EAF1; margin-top:4px; padding-top:9px; }
    .addbar { display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap; }
    .tl div { font-size:12px; padding:6px 0 6px 14px; border-left:2px solid #DCE4EC; position:relative; }
    .tl div:before { content:''; position:absolute; left:-6px; top:10px; width:10px; height:10px; border-radius:50%; background:#0875D1; }
    .warn { display:flex; gap:8px; align-items:center; padding:10px 12px; border-radius:10px; font-size:13px; margin-bottom:10px; }
    .chk { display:flex; justify-content:space-between; gap:8px; font-size:12px; padding:4px 0; border-bottom:1px dashed #EEF2F6; }
    @media (max-width:1000px) { .cols { grid-template-columns:minmax(0,1fr); } }
  `],
  template: `
  @if (w(); as w) {
  <div style="padding:24px" class="no-print">
    <button class="btn-ghost" style="font-size:12px;margin-bottom:8px" (click)="router.navigateByUrl('/oficina')"><ax-icon name="arrow-left" [size]="13" /> Ordens de serviço</button>
    <div class="card" style="padding:16px">
      <div class="head">
        <div class="plate"><small>BRASIL</small>{{ fp(w.plate) }}</div>
        <div style="flex:1;min-width:220px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h1 style="font-size:19px;font-weight:800;color:#172B3A">OS nº {{ w.number }}</h1>
            <span class="badge" [class]="'badge ' + st(w.status).cls" style="font-size:12px">{{ st(w.status).label }}</span>
            @if (late()) { <span class="badge badge-danger">Prazo vencido</span> }</div>
          <div style="font-size:13.5px;margin-top:2px"><ax-icon [name]="vt(w.vehicle_type).icon" [size]="14" color="#647687" /> {{ w.brand }} {{ w.model }} {{ w.year_model || '' }} {{ w.color ? '· ' + w.color : '' }} · {{ w.km_in ? (w.km_in | num) + ' km' : 'km não informado' }}{{ w.fuel_level ? ' · combustível ' + w.fuel_level : '' }}</div>
          <div style="font-size:13px;color:#4A5B6B;margin-top:2px"><ax-icon name="user" [size]="13" /> {{ w.customer_name }}{{ w.whatsapp ? ' · ' + (w.whatsapp | phone) : w.phone ? ' · ' + (w.phone | phone) : '' }}</div>
        </div>
        <div style="font-size:12.5px;color:#4A5B6B;min-width:200px">
          <div>{{ auth.term('profissional') }}: <b>{{ w.professional || '—' }}</b></div>
          <div>Aberta em {{ w.created_at | dtt }} por {{ w.created_by_name || '—' }}</div>
          <div [style.color]="late() ? '#C93636' : null">Previsão: {{ w.promised_at ? (w.promised_at | dtt) : '—' }}</div>
          @if (w.warranty_until) { <div style="color:#18864B">Garantia até {{ w.warranty_until | dt }}</div> }
          @if (w.sale_number) { <div>Venda nº {{ w.sale_number }}</div> }
        </div>
      </div>
      <div class="acts">
        @if (canEdit()) {
          @switch (w.status) {
            @case ('orcamento') { <button class="btn-primary" (click)="move('aguardando_aprovacao')"><ax-icon name="send" [size]="13" /> Enviar orçamento ao cliente</button> }
            @case ('aguardando_aprovacao') { <button class="btn-secondary" (click)="move('orcamento')">Voltar para orçamento</button> }
            @case ('aprovada') { <button class="btn-primary" (click)="move('em_execucao')"><ax-icon name="play" [size]="13" /> Iniciar execução</button><button class="btn-secondary" (click)="move('aguardando_peca')">Aguardando peça</button> }
            @case ('em_execucao') { <button class="btn-primary" (click)="move('pronta')"><ax-icon name="check-circle-2" [size]="13" /> Serviço pronto</button><button class="btn-secondary" (click)="move('aguardando_peca')">Aguardando peça</button> }
            @case ('aguardando_peca') { <button class="btn-primary" (click)="move('em_execucao')"><ax-icon name="play" [size]="13" /> Peça chegou — retomar</button><button class="btn-secondary" (click)="move('pronta')">Serviço pronto</button> }
            @case ('pronta') { <button class="btn-secondary" (click)="move('em_execucao')">Voltar para execução</button> }
          }
        }
        @if (w.totals.pending && auth.can('oficina.aprovar') && editableNow()) { <button class="btn-primary" style="background:#D99000;border-color:#D99000" (click)="approveOpen()"><ax-icon name="check-check" [size]="13" /> Registrar aprovação do cliente</button> }
        @if (w.totals.unbilled && auth.can('vendas.criar') && !['orcamento','aguardando_aprovacao','cancelada'].includes(w.status)) { <button class="btn-primary" style="background:#18864B;border-color:#18864B" (click)="charge()"><ax-icon name="scan-barcode" [size]="13" /> Cobrar no PDV ({{ w.totals.to_bill | brl }})</button> }
        @if (w.status === 'pronta' && !w.totals.unbilled && !w.totals.pending && canEdit()) { <button class="btn-primary" style="background:#18864B;border-color:#18864B" (click)="move('entregue')"><ax-icon name="car" [size]="13" /> Entregar veículo</button> }
        <button class="btn-secondary" (click)="print()"><ax-icon name="printer" [size]="13" /> {{ ['orcamento','aguardando_aprovacao'].includes(w.status) ? 'Imprimir orçamento' : 'Imprimir OS' }}</button>
        <button class="btn-ghost" (click)="copySummary()"><ax-icon name="copy" [size]="13" /> Copiar resumo</button>
        @if (editableNow() && auth.can('oficina.aprovar') && !w.totals.billed) { <button class="btn-ghost" style="color:#C93636" (click)="cancelOpen.set(true)">Cancelar OS</button> }
      </div>
      @if (w.warrantyActive) { <div class="warn" style="background:#E8F5EE;color:#18864B"><ax-icon name="shield-check" [size]="15" /> Veículo em garantia da OS nº {{ w.warrantyActive.number }} até {{ w.warrantyActive.warranty_until | dt }} — verifique se é retorno de serviço.</div> }
      @if (w.totals.pending && !['orcamento','aguardando_aprovacao'].includes(w.status)) { <div class="warn" style="background:#FFF7E6;color:#8A5B00"><ax-icon name="alert-triangle" [size]="15" /> {{ w.totals.pending }} item(ns) adicional(is) aguardando aprovação do cliente — não serão executados nem cobrados antes disso.</div> }
      @if (w.status === 'cancelada') { <div class="warn" style="background:#FDECEC;color:#A12A2A"><ax-icon name="x-circle" [size]="15" /> Cancelada: {{ w.cancel_reason }}</div> }
    </div>

    <div class="cols" style="margin-top:14px">
      <div>
        <div class="card" style="padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px"><div class="sec" style="margin:0">Serviços, mão de obra e peças</div>
            <span class="muted" style="font-size:11.5px">Valor-hora desta OS: <b>{{ w.labor_rate | brl }}</b></span></div>
          @if (editableNow() && auth.can('oficina.editar')) {
            <div class="addbar">
              <span class="chip" [class.active]="addMode() === 'item'" (click)="addMode.set('item')"><ax-icon name="search" [size]="12" /> Serviço, peça ou produto</span>
              <span class="chip" [class.active]="addMode() === 'hora'" (click)="addMode.set('hora')"><ax-icon name="clock" [size]="12" /> Mão de obra por hora</span>
            </div>
            @if (addMode() === 'item') {
              @if (!picked()) { <ax-variant-picker placeholder="Busque serviço, peça ou produto por nome, código ou código de barras" (selected)="pick($event)" /> }
              @else {
                <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:10px;border:1px solid #DCE4EC;border-radius:10px">
                  <div style="flex:1;min-width:180px"><b style="font-size:13px">{{ picked().name }}</b><div class="muted" style="font-size:11.5px">{{ picked().kind === 'servico' ? 'Serviço' : 'Estoque: ' + (picked().stock ?? '—') + ' ' + (picked().unit || '') }} · {{ picked().price | brl }}</div></div>
                  @if (picked().kind !== 'servico') {
                    <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="add.kind"><option value="peca">Peça</option><option value="produto">Produto</option></select></div>
                    <div style="width:100px"><label class="field-label">Qtd ({{ picked().unit || 'UN' }})</label><input class="input-field mono" type="number" min="0.001" step="any" [(ngModel)]="add.qty" /></div>
                  } @else {
                    <div><label class="field-label">{{ auth.term('profissional') }}</label><select class="input-field" [(ngModel)]="add.professionalId"><option value="">{{ w.professional || '—' }}</option>@for (p of profs(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></div>
                  }
                  <div style="width:110px"><label class="field-label">Desconto (R$)</label><input class="input-field mono" type="number" min="0" step="0.01" [(ngModel)]="add.discount" /></div>
                  <button class="btn-primary" (click)="addItem()" [disabled]="busy()">Incluir</button><button class="btn-ghost" (click)="picked.set(null)">Trocar</button>
                </div>
              }
            } @else {
              <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:10px;border:1px solid #DCE4EC;border-radius:10px">
                <div style="flex:1;min-width:180px"><label class="field-label">Descrição do serviço</label><input class="input-field" [(ngModel)]="hour.description" placeholder="Ex.: diagnóstico elétrico, troca de embreagem" /></div>
                <div style="width:90px"><label class="field-label">Horas</label><input class="input-field mono" type="number" min="0.05" step="0.25" [(ngModel)]="hour.hours" /></div>
                <div><label class="field-label">{{ auth.term('profissional') }}</label><select class="input-field" [(ngModel)]="hour.professionalId"><option value="">{{ w.professional || '—' }}</option>@for (p of profs(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></div>
                <div style="font-size:12px;color:#4A5B6B;padding-bottom:8px">= {{ (hour.hours || 0) * w.labor_rate | brl }}</div>
                <button class="btn-primary" (click)="addHours()" [disabled]="busy()">Incluir</button>
              </div>
            }
          }
          <div style="overflow-x:auto;margin-top:10px"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th style="min-width:230px">Descrição</th><th>Tipo</th><th>{{ auth.term('profissional') }}</th><th class="num">Qtd</th><th class="num">Unit.</th><th class="num">Desc.</th><th class="num">Total</th><th>Situação</th><th></th></tr></thead>
            <tbody>@for (i of w.items; track i.id) {
              <tr [style.opacity]="i.status === 'recusado' ? .5 : 1">
                <td><span [style.text-decoration]="i.status === 'recusado' ? 'line-through' : null">{{ i.description }}</span>@if (i.added_after_approval) { <span class="badge badge-muted" style="margin-left:4px">adicional</span> }
                  @if ((i.kind === 'peca' || i.kind === 'produto') && i.track_stock && !i.sale_item_id && i.stock < i.qty && i.status !== 'recusado') { <div style="font-size:11px;color:#C93636">Estoque insuficiente ({{ i.stock }})</div> }</td>
                <td style="font-size:12px">{{ kind(i.kind) }}</td><td style="font-size:12px">{{ i.professional || '—' }}</td>
                <td class="num">{{ i.qty | num:(i.kind === 'mao_de_obra' || i.unit === 'L' ? 2 : 0) }}</td><td class="num">{{ i.unit_price | brl }}</td><td class="num">{{ i.discount > 0 ? (i.discount | brl) : '—' }}</td><td class="num"><b>{{ i.total | brl }}</b></td>
                <td><span class="badge" [class]="'badge ' + is(i.status).cls">{{ i.sale_item_id ? 'Cobrado' : is(i.status).label }}</span></td>
                <td style="white-space:nowrap">@if (!i.sale_item_id && editableNow() && auth.can('oficina.editar') && i.status !== 'recusado') {
                  <button class="btn-ghost" style="padding:2px 6px" (click)="editItem(i)" aria-label="Editar"><ax-icon name="pencil" [size]="12" /></button>
                  <button class="btn-ghost" style="padding:2px 6px;color:#C93636" (click)="removeItem(i)" aria-label="Remover"><ax-icon name="trash-2" [size]="12" /></button> }</td></tr>
            } @empty { <tr><td colspan="9"><div class="empty-state">Inclua os serviços, a mão de obra e as peças do orçamento.</div></td></tr> }</tbody></table></div>
        </div>
        <div class="card" style="padding:14px;margin-top:14px">
          <div class="sec">Reclamação e diagnóstico</div>
          <label class="field-label">Reclamação do cliente</label><textarea class="input-field" rows="2" [(ngModel)]="texts.complaint" [disabled]="!editableNow()"></textarea>
          <label class="field-label" style="margin-top:8px">Diagnóstico técnico</label><textarea class="input-field" rows="3" [(ngModel)]="texts.diagnosis" [disabled]="!editableNow()" placeholder="O que foi encontrado e o que precisa ser feito"></textarea>
          <label class="field-label" style="margin-top:8px">Observações para o cliente (saem na impressão)</label><textarea class="input-field" rows="2" [(ngModel)]="texts.notesCustomer" [disabled]="!editableNow()"></textarea>
          <label class="field-label" style="margin-top:8px">Observações internas</label><textarea class="input-field" rows="2" [(ngModel)]="texts.notesInternal" [disabled]="!editableNow()"></textarea>
          @if (editableNow() && auth.can('oficina.editar')) { <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn-secondary" (click)="saveTexts()">Salvar textos</button></div> }
        </div>
      </div>
      <div>
        <div class="card" style="padding:14px">
          <div class="sec">Valores</div>
          <div class="tot"><span>Serviços e mão de obra</span><b>{{ w.totals.labor | brl }}</b></div>
          <div class="tot"><span>Peças e produtos</span><b>{{ w.totals.parts | brl }}</b></div>
          @if (w.totals.hours) { <div class="tot muted"><span>Horas de mão de obra</span><span>{{ w.totals.hours | num:2 }} h</span></div> }
          <div class="tot big"><span>Total aprovado</span><span>{{ w.totals.approved | brl }}</span></div>
          @if (w.totals.pending) { <div class="tot" style="color:#D99000"><span>Aguardando aprovação</span><b>{{ w.totals.quoted - w.totals.approved | brl }}</b></div> }
          @if (w.totals.billed) { <div class="tot" style="color:#18864B"><span>Já cobrado</span><b>{{ w.totals.billed | brl }}</b></div> }
          @if (w.totals.to_bill && w.totals.billed) { <div class="tot"><span>A cobrar</span><b>{{ w.totals.to_bill | brl }}</b></div> }
          @if (w.approved_at) { <div class="muted" style="font-size:11.5px;margin-top:6px">Aprovado por {{ w.approved_by_name }} ({{ w.approval_channel }}) em {{ w.approved_at | dtt }}</div> }
          @if (editableNow() && auth.can('oficina.aprovar')) {
            <div style="display:flex;gap:8px;margin-top:10px">
              <div style="flex:1"><label class="field-label">Valor-hora</label><input class="input-field mono" type="number" min="0" step="5" [(ngModel)]="cfg.laborRate" /></div>
              <div style="flex:1"><label class="field-label">Garantia (dias)</label><input class="input-field mono" type="number" min="0" [(ngModel)]="cfg.warrantyDays" /></div>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:6px"><button class="btn-ghost" style="font-size:12px" (click)="saveCfg()">Salvar condições</button></div>
          }
        </div>
        <div class="card" style="padding:14px;margin-top:14px">
          <div class="sec">Checklist de entrada</div>
          @for (c of w.checklist; track c.item) { <div class="chk"><span>{{ c.item }}{{ c.note ? ' — ' + c.note : '' }}</span><b [style.color]="cs(c.state).color">{{ cs(c.state).label }}</b></div> }
          @empty { <div class="muted" style="font-size:12.5px">Sem checklist.</div> }
        </div>
        @if (w.history.length) {
          <div class="card" style="padding:14px;margin-top:14px">
            <div class="sec">Histórico do veículo</div>
            @for (h of w.history; track h.id) { <div style="font-size:12px;padding:6px 0;border-bottom:1px dashed #EEF2F6;cursor:pointer" (click)="router.navigate(['/os-detail', h.id])"><b>OS {{ h.number }}</b> · {{ h.created_at | dt }}{{ h.km_in ? ' · ' + (h.km_in | num) + ' km' : '' }}<div class="muted">{{ h.items || '—' }}</div></div> }
          </div>
        }
        <div class="card" style="padding:14px;margin-top:14px">
          <div class="sec">Linha do tempo</div>
          <div class="tl">@for (e of w.events; track e.id) { <div><b>{{ e.to_status ? st(e.to_status).label : 'Registro' }}</b> · {{ e.created_at | dtt }}{{ e.user_name ? ' · ' + e.user_name : '' }}@if (e.note) { <br><span class="muted">{{ e.note }}</span> }</div> }</div>
        </div>
      </div>
    </div>
  </div>

  <!-- impressão: orçamento / ordem de serviço -->
  <div id="receipt" class="print-only" style="padding:20px;font-family:Inter,Arial,sans-serif;font-size:11.5px;color:#000;width:100%">
    <div style="display:flex;justify-content:space-between;border-bottom:2px solid #000;padding-bottom:8px">
      <div><b style="font-size:16px">{{ auth.me()?.company?.trade_name || auth.me()?.company?.name }}</b><div>{{ auth.me()?.company?.cnpj ? 'CNPJ ' + (auth.me()?.company?.cnpj | doc) : '' }}</div></div>
      <div style="text-align:right"><b style="font-size:15px">{{ ['orcamento','aguardando_aprovacao'].includes(w.status) ? 'ORÇAMENTO' : 'ORDEM DE SERVIÇO' }} Nº {{ w.number }}</b><div>Emitido em {{ now | dtt }}</div></div>
    </div>
    <table style="width:100%;margin:8px 0;font-size:11.5px"><tr><td><b>Cliente:</b> {{ w.customer_name }}{{ w.cpf_cnpj ? ' — ' + (w.cpf_cnpj | doc) : '' }}</td><td><b>Telefone:</b> {{ (w.whatsapp || w.phone) | phone }}</td></tr>
      <tr><td><b>Veículo:</b> {{ w.brand }} {{ w.model }} {{ w.year_model || '' }} {{ w.color || '' }}</td><td><b>Placa:</b> {{ fp(w.plate) }} · <b>Km:</b> {{ w.km_in ? (w.km_in | num) : '—' }}</td></tr>
      <tr><td colspan="2"><b>Reclamação:</b> {{ w.complaint || '—' }}</td></tr>
      @if (w.diagnosis) { <tr><td colspan="2"><b>Diagnóstico:</b> {{ w.diagnosis }}</td></tr> }</table>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="border-bottom:1px solid #000"><th style="text-align:left">Descrição</th><th style="text-align:left">Tipo</th><th style="text-align:right">Qtd</th><th style="text-align:right">Unit.</th><th style="text-align:right">Desc.</th><th style="text-align:right">Total</th><th style="text-align:left">Situação</th></tr></thead>
      <tbody>@for (i of printItems(); track i.id) { <tr style="border-bottom:1px solid #ddd"><td>{{ i.description }}</td><td>{{ kind(i.kind) }}</td><td style="text-align:right">{{ i.qty | num:(i.kind === 'mao_de_obra' || i.unit === 'L' ? 2 : 0) }}</td><td style="text-align:right">{{ i.unit_price | brl }}</td><td style="text-align:right">{{ i.discount > 0 ? (i.discount | brl) : '' }}</td><td style="text-align:right">{{ i.total | brl }}</td><td>{{ is(i.status).label }}</td></tr> }</tbody>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-top:8px"><table style="font-size:12px"><tr><td>Serviços/mão de obra:</td><td style="text-align:right;padding-left:16px">{{ printTotals().labor | brl }}</td></tr><tr><td>Peças/produtos:</td><td style="text-align:right;padding-left:16px">{{ printTotals().parts | brl }}</td></tr><tr><td><b>Total:</b></td><td style="text-align:right;padding-left:16px"><b>{{ printTotals().total | brl }}</b></td></tr></table></div>
    @if (w.notes_customer) { <p style="margin-top:8px"><b>Observações:</b> {{ w.notes_customer }}</p> }
    <p style="margin-top:8px;font-size:10.5px">Garantia dos serviços: {{ w.warranty_days }} dias a partir da entrega{{ w.warranty_until ? ' (até ' + (w.warranty_until | dt) + ')' : '' }}. Peças com garantia do fabricante. Orçamento válido por 7 dias. Itens não aprovados não serão executados.</p>
    @if (w.checklist?.length) { <p style="font-size:10.5px"><b>Checklist de entrada:</b> @for (c of w.checklist; track c.item) { {{ c.item }}: {{ cs(c.state).label }}{{ c.note ? ' (' + c.note + ')' : '' }}; }</p> }
    <div style="display:flex;gap:40px;margin-top:40px"><div style="flex:1;border-top:1px solid #000;text-align:center;padding-top:4px">Cliente — autorizo a execução dos itens aprovados</div><div style="flex:1;border-top:1px solid #000;text-align:center;padding-top:4px">{{ auth.me()?.company?.trade_name || auth.me()?.company?.name }}</div></div>
  </div>

  <ax-modal [(open)]="apOpen" title="Aprovação do cliente" icon="check-check" [width]="640">
    <p style="font-size:12.5px;color:#4A5B6B;margin:-4px 0 10px">Marque o que o cliente autorizou. Os itens desmarcados ficam como <b>recusados</b> (não são executados nem cobrados).</p>
    @for (i of pendingItems(); track i.id) {
      <label style="display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid #E3EAF1;border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px">
        <input type="checkbox" [checked]="sel.has(i.id)" (change)="toggleSel(i.id)" /><span style="flex:1">{{ i.description }} <span class="muted">· {{ kind(i.kind) }}</span></span><b>{{ i.total | brl }}</b></label>
    }
    <div class="tot big"><span>Aprovado</span><span>{{ selTotal() | brl }}</span></div>
    <div class="form-grid-2" style="margin-top:8px">
      <div><label class="field-label">Quem aprovou *</label><input class="input-field" [(ngModel)]="ap.by" /></div>
      <div><label class="field-label">Canal *</label><select class="input-field" [(ngModel)]="ap.channel"><option value="presencial">Presencial (assinatura)</option><option value="whatsapp">WhatsApp</option><option value="telefone">Telefone</option><option value="email">E-mail</option><option value="outro">Outro</option></select></div>
    </div>
    <div footer><button class="btn-secondary" (click)="apOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="approve()" [disabled]="busy() || ap.by.trim().length < 2">Registrar</button></div>
  </ax-modal>

  <ax-modal [(open)]="itOpen" title="Editar item" icon="pencil" [width]="520">
    <div class="form-grid-2">
      <div class="span-2"><label class="field-label">Descrição</label><input class="input-field" [(ngModel)]="it.description" /></div>
      <div><label class="field-label">{{ it.kind === 'mao_de_obra' ? 'Horas' : 'Quantidade' }}</label><input class="input-field mono" type="number" min="0.001" step="any" [(ngModel)]="it.qty" /></div>
      <div><label class="field-label">Valor unitário</label><input class="input-field mono" type="number" min="0" step="0.01" [(ngModel)]="it.unitPrice" [disabled]="!auth.can('oficina.aprovar')" /></div>
      <div><label class="field-label">Desconto (R$)</label><input class="input-field mono" type="number" min="0" step="0.01" [(ngModel)]="it.discount" /></div>
      <div><label class="field-label">{{ auth.term('profissional') }}</label><select class="input-field" [(ngModel)]="it.professionalId"><option value="">—</option>@for (p of profs(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></div>
    </div>
    <div footer><button class="btn-secondary" (click)="itOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveItem()" [disabled]="busy()">Salvar</button></div>
  </ax-modal>

  <ax-modal [(open)]="cancelOpen" title="Cancelar OS" icon="x-circle" [width]="480">
    <label class="field-label">Motivo *</label><textarea class="input-field" rows="3" [(ngModel)]="cancelReason" placeholder="Ex.: cliente não aprovou o orçamento"></textarea>
    <div footer><button class="btn-secondary" (click)="cancelOpen.set(false)">Voltar</button><button class="btn-primary" style="background:#C93636;border-color:#C93636" (click)="move('cancelada', cancelReason)" [disabled]="cancelReason.trim().length < 3">Cancelar OS</button></div>
  </ax-modal>
  } @else { <div style="padding:24px"><div class="card" style="padding:24px"><div class="skeleton" style="height:120px"></div></div></div> }`,
})
export class OsDetailPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly router = inject(Router); private route = inject(ActivatedRoute); private lk = inject(LookupsService);
  readonly w = signal<any>(null); readonly profs = signal<any[]>([]); readonly busy = signal(false);
  readonly addMode = signal<'item' | 'hora'>('item'); readonly picked = signal<any>(null);
  readonly apOpen = signal(false); readonly itOpen = signal(false); readonly cancelOpen = signal(false);
  add: any = { kind: 'peca', qty: 1, discount: 0, professionalId: '' }; hour: any = { description: '', hours: 1, professionalId: '' };
  texts: any = {}; cfg: any = {}; ap: any = { by: '', channel: 'presencial' }; sel = new Set<string>(); it: any = {}; cancelReason = '';
  readonly now = new Date().toISOString();
  readonly st = (s: string) => WO_STATUS[s] ?? WO_STATUS['orcamento'];
  readonly is = (s: string) => ITEM_STATUS[s] ?? ITEM_STATUS['pendente'];
  readonly cs = (s: string) => CHECK_STATE[s] ?? CHECK_STATE['ok'];
  readonly vt = (t: string) => VEHICLE_TYPE[t] ?? VEHICLE_TYPE['carro'];
  readonly kind = (k: string) => ITEM_KIND[k] ?? k;
  readonly fp = formatPlate;
  readonly editableNow = computed(() => EDITABLE.includes(this.w()?.status));
  readonly canEdit = computed(() => this.auth.can('oficina.editar') && this.editableNow());
  readonly late = computed(() => { const w = this.w(); return !!w?.promised_at && new Date(w.promised_at) < new Date() && !['pronta', 'entregue', 'cancelada'].includes(w.status); });
  readonly pendingItems = computed(() => (this.w()?.items ?? []).filter((i: any) => i.status === 'pendente'));
  readonly printItems = computed(() => (this.w()?.items ?? []).filter((i: any) => i.status !== 'recusado'));
  readonly printTotals = computed(() => { const l = this.printItems(); const labor = l.filter((i: any) => i.kind === 'servico' || i.kind === 'mao_de_obra').reduce((s: number, i: any) => s + Number(i.total), 0); const parts = l.filter((i: any) => i.kind === 'peca' || i.kind === 'produto').reduce((s: number, i: any) => s + Number(i.total), 0); return { labor, parts, total: labor + parts }; });
  selTotal() { return this.pendingItems().filter((i: any) => this.sel.has(i.id)).reduce((s: number, i: any) => s + Number(i.total), 0); }
  ngOnInit() { this.load(); this.lk.ensure().then((d) => this.profs.set(d.professionals ?? []), () => {}); }
  private set(w: any) {
    this.w.set(w);
    this.texts = { complaint: w.complaint || '', diagnosis: w.diagnosis || '', notesCustomer: w.notes_customer || '', notesInternal: w.notes_internal || '' };
    this.cfg = { laborRate: Number(w.labor_rate), warrantyDays: w.warranty_days };
  }
  async load() { try { this.set(await this.api.get('/work-orders/' + this.route.snapshot.paramMap.get('id'))); } catch (e) { this.toast.error(e); } }
  async move(to: string, note?: string) {
    this.busy.set(true);
    try { this.set(await this.api.post(`/work-orders/${this.w().id}/status`, { to, note: note || undefined })); this.cancelOpen.set(false); this.toast.success(this.st(to).label); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  pick(v: any) { this.picked.set(v); this.add = { kind: 'peca', qty: 1, discount: 0, professionalId: '' }; }
  async addItem() {
    const p = this.picked(); if (!p) return;
    const body: any = { kind: p.kind === 'servico' ? 'servico' : this.add.kind, productId: p.product_id, variantId: p.kind === 'servico' ? undefined : p.id, discount: Number(this.add.discount) || undefined };
    if (p.kind !== 'servico') body.qty = Number(this.add.qty) || 1;
    if (p.kind === 'servico' && this.add.professionalId) body.professionalId = this.add.professionalId;
    await this.postItem(body); this.picked.set(null);
  }
  async addHours() {
    if (!(Number(this.hour.hours) > 0)) { this.toast.error('Informe as horas.'); return; }
    const body: any = { kind: 'mao_de_obra', hours: Number(this.hour.hours), description: this.hour.description || undefined };
    if (this.hour.professionalId) body.professionalId = this.hour.professionalId;
    await this.postItem(body); this.hour = { description: '', hours: 1, professionalId: '' };
  }
  private async postItem(body: any) {
    this.busy.set(true);
    try { const r: any = await this.api.post(`/work-orders/${this.w().id}/items`, body); if (r.status === 'pendente' && r.added_after_approval) this.toast.info('Item adicional incluído: registre a aprovação do cliente.'); await this.load(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  editItem(i: any) { this.it = { id: i.id, kind: i.kind, description: i.description, qty: Number(i.qty), unitPrice: Number(i.unit_price), discount: Number(i.discount), professionalId: i.professional_id || '' }; this.itOpen.set(true); }
  async saveItem() {
    const cur = this.w().items.find((x: any) => x.id === this.it.id); const body: any = {};
    if (this.it.description !== cur.description) body.description = this.it.description;
    if (Number(this.it.qty) !== Number(cur.qty)) body.qty = Number(this.it.qty);
    if (Number(this.it.unitPrice) !== Number(cur.unit_price)) body.unitPrice = Number(this.it.unitPrice);
    if (Number(this.it.discount) !== Number(cur.discount)) body.discount = Number(this.it.discount);
    if ((this.it.professionalId || null) !== (cur.professional_id || null)) body.professionalId = this.it.professionalId || null;
    if (!Object.keys(body).length) { this.itOpen.set(false); return; }
    this.busy.set(true);
    try { await this.api.put(`/work-orders/${this.w().id}/items/${this.it.id}`, body); this.itOpen.set(false); await this.load(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async removeItem(i: any) {
    if (!confirm(`Remover "${i.description}" da OS?`)) return;
    try { await this.api.delete(`/work-orders/${this.w().id}/items/${i.id}`); await this.load(); } catch (e) { this.toast.error(e); }
  }
  approveOpen() { this.sel = new Set(this.pendingItems().map((i: any) => i.id)); this.ap = { by: this.w().customer_name, channel: 'presencial' }; this.apOpen.set(true); }
  toggleSel(id: string) { const s = new Set(this.sel); if (s.has(id)) s.delete(id); else s.add(id); this.sel = s; }
  async approve() {
    this.busy.set(true);
    try { this.set(await this.api.post(`/work-orders/${this.w().id}/approve`, { itemIds: [...this.sel], approvedBy: this.ap.by.trim(), channel: this.ap.channel })); this.apOpen.set(false); this.toast.success('Aprovação registrada.'); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async saveTexts() {
    try { this.set(await this.api.put('/work-orders/' + this.w().id, { complaint: this.texts.complaint, diagnosis: this.texts.diagnosis, notesCustomer: this.texts.notesCustomer, notesInternal: this.texts.notesInternal })); this.toast.success('Salvo.'); }
    catch (e) { this.toast.error(e); }
  }
  async saveCfg() {
    try { this.set(await this.api.put('/work-orders/' + this.w().id, { laborRate: Number(this.cfg.laborRate), warrantyDays: Number(this.cfg.warrantyDays) })); this.toast.success('Condições salvas.'); }
    catch (e) { this.toast.error(e); }
  }
  charge() { this.router.navigate(['/pdv'], { queryParams: { os: this.w().id } }); }
  print() { document.body.classList.add('printing-receipt'); setTimeout(() => { window.print(); document.body.classList.remove('printing-receipt'); }, 80); }
  async copySummary() {
    const w = this.w(); const items = this.printItems();
    const txt = `${['orcamento', 'aguardando_aprovacao'].includes(w.status) ? 'Orçamento' : 'OS'} nº ${w.number} — ${w.brand || ''} ${w.model} (${formatPlate(w.plate)})\n` +
      items.map((i: any) => `• ${i.description}: ${brl(i.total)}${i.status === 'pendente' ? ' (aguardando sua aprovação)' : ''}`).join('\n') +
      `\nTotal: ${brl(this.printTotals().total)}\nGarantia dos serviços: ${w.warranty_days} dias.`;
    try { await navigator.clipboard.writeText(txt); this.toast.success('Resumo copiado — cole na conversa com o cliente.'); } catch { this.toast.info(txt); }
  }
}
