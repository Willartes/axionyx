import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CustomerPickerComponent, ModalComponent } from '../../shared/ui';
import { Api, ApiError, newIdempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, todayIso, addDaysIso } from '../../core/format';

export const APPT_STATUS: Record<string, [string, string, string]> = {
  agendado: ['Agendado', 'badge-info', '#E3EFF9'], confirmado: ['Confirmado', 'badge-success', '#E8F5EE'], em_atendimento: ['Em atendimento', 'badge-warning', '#FFF5E0'],
  concluido: ['Concluído', 'badge-muted', '#F1F4F7'], cancelado: ['Cancelado', 'badge-danger', '#FDECEC'], faltou: ['Faltou', 'badge-danger', '#FDECEC'],
};
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DOW = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
interface Line { productId: string; professionalId: string; customerPackageId: string; planItemId?: string }

/** Agenda por profissional (colunas) com horários, bloqueios, status e cobrança do atendimento no PDV. */
@Component({
  selector: 'ax-agenda',
  imports: [FormsModule, IconComponent, ModalComponent, CustomerPickerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .grid-wrap { overflow:auto; background:white; border:1px solid #DCE4EC; border-radius:10px; max-height:calc(100vh - 290px); min-height:420px; }
    .grid { display:grid; grid-template-columns:var(--cols); position:relative; min-width:100%; }
    .col-head { position:sticky; top:0; z-index:3; background:white; border-bottom:1px solid #DCE4EC; padding:8px 10px; font-size:12.5px; font-weight:600; color:#172B3A; display:flex; align-items:center; gap:6px; min-width:170px; }
    .time-col { position:sticky; left:0; z-index:2; background:#FAFCFE; border-right:1px solid #EEF2F6; }
    .time-label { position:absolute; right:6px; font-size:10.5px; color:#8696A7; transform:translateY(-6px); }
    .col { position:relative; border-right:1px solid #F0F4F8; min-width:170px; cursor:copy; }
    .hour-line { position:absolute; left:0; right:0; border-top:1px solid #EEF2F6; }
    .half-line { position:absolute; left:0; right:0; border-top:1px dashed #F3F6F9; }
    .off { position:absolute; left:0; right:0; background:repeating-linear-gradient(135deg,#F5F7FA,#F5F7FA 6px,#EEF2F6 6px,#EEF2F6 12px); pointer-events:none; }
    .block { position:absolute; left:3px; right:3px; background:repeating-linear-gradient(45deg,#E9EDF2,#E9EDF2 5px,#DDE3EA 5px,#DDE3EA 10px); border-radius:6px; font-size:10.5px; color:#647687; padding:3px 6px; overflow:hidden; cursor:pointer; z-index:1; }
    .appt { position:absolute; left:4px; right:4px; border-radius:7px; border-left:4px solid; padding:4px 7px; font-size:11.5px; overflow:hidden; cursor:pointer; z-index:1; box-shadow:0 1px 2px rgba(16,24,40,.06); }
    .appt:hover { box-shadow:0 3px 10px rgba(16,24,40,.14); z-index:4; }
    .appt.cancel { opacity:.55; text-decoration:line-through; }
    .now-line { position:absolute; left:0; right:0; border-top:2px solid #C93636; z-index:2; pointer-events:none; }
    .slot-chip { padding:4px 9px; border:1px solid #DCE4EC; border-radius:6px; font-size:12px; cursor:pointer; background:white; font-family:'JetBrains Mono',monospace; }
    .slot-chip.active { background:#0875D1; color:white; border-color:#0875D1; }
    .svc-row { display:grid; grid-template-columns:1fr 150px 30px; gap:6px; align-items:center; margin-bottom:6px; }
    @media (max-width:760px) { .svc-row { grid-template-columns:1fr 30px; } .svc-row .svc-prof { grid-column:1 / 2; } }
  `],
  template: `
  <div style="padding:20px 24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Agenda</h1>
        <p style="font-size:13px;color:#647687">{{ dowLabel() }}, {{ date() | dt }} · {{ data()?.canSeeAll ? 'todos os profissionais' : 'sua agenda' }}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn-ghost" style="padding:6px 8px" (click)="shift(-1)" aria-label="Dia anterior"><ax-icon name="chevron-left" [size]="15" /></button>
        <button class="btn-secondary" style="font-size:12px" (click)="go(today)">Hoje</button>
        <input type="date" class="input-field" style="width:150px" [ngModel]="date()" (ngModelChange)="go($event)" />
        <button class="btn-ghost" style="padding:6px 8px" (click)="shift(1)" aria-label="Próximo dia"><ax-icon name="chevron-right" [size]="15" /></button>
        <span class="chip" [class.active]="view() === 'dia'" (click)="setView('dia')">Dia</span>
        <span class="chip" [class.active]="view() === 'lista'" (click)="setView('lista')">Próximos 7 dias</span>
        @if (auth.can('agenda.editar')) {
          <button class="btn-secondary" style="font-size:12px" (click)="openReminders()"><ax-icon name="message-circle" [size]="13" /> Lembretes</button>
          <button class="btn-secondary" style="font-size:12px" (click)="openBlock()"><ax-icon name="ban" [size]="13" /> Bloquear horário</button>
          <button class="btn-primary" style="font-size:12px" (click)="openNew()"><ax-icon name="calendar-plus" [size]="13" /> Agendar</button>
        }
      </div>
    </div>

    @if (data(); as d) {
      @if (!d.professionals.length) {
        <div class="card" style="padding:28px;text-align:center">
          <ax-icon name="user-cog" [size]="30" color="#A0AFBF" />
          <div style="font-size:14px;font-weight:600;margin-top:8px">{{ d.canSeeAll ? 'Nenhum profissional cadastrado nesta filial' : 'Seu usuário ainda não está vinculado a um profissional' }}</div>
          <p style="font-size:12.5px;color:#647687;margin:6px 0 12px">Cadastre quem atende (inclusive você, se também atende) com horários e serviços.</p>
          @if (auth.can('profissionais.editar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/profissionais')"><ax-icon name="plus" [size]="13" /> Cadastrar profissionais</button> }
        </div>
      } @else {
        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px" class="kpi-grid-4">
          <div class="kpi-card"><div class="kpi-l">{{ term('atendimentos') }} no período</div><div class="kpi-v">{{ d.summary.total }}</div></div>
          <div class="kpi-card"><div class="kpi-l">Concluídos</div><div class="kpi-v" style="color:#18864B">{{ d.summary.concluidos }}</div></div>
          <div class="kpi-card"><div class="kpi-l">Faltas</div><div class="kpi-v" [style.color]="d.summary.faltas ? '#C93636' : null">{{ d.summary.faltas }}</div></div>
          <div class="kpi-card"><div class="kpi-l">Previsto em serviços</div><div class="kpi-v">{{ d.summary.previsto | brl }}</div></div>
        </div>
        @if (d.canSeeAll && allProfs().length > 1) {
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            <span class="chip" [class.active]="!profFilter()" (click)="setProf('')">Todos</span>
            @for (p of allProfs(); track p.id) { <span class="chip" [class.active]="profFilter() === p.id" (click)="setProf(p.id)"><span [style.background]="p.color" style="width:8px;height:8px;border-radius:50%"></span>{{ p.name }}</span> }
          </div>
        }

        @if (view() === 'dia') {
          <div class="grid-wrap">
            <div class="grid" [style.--cols]="'56px repeat(' + d.professionals.length + ', minmax(170px, 1fr))'">
              <div class="col-head time-col" style="z-index:4;min-width:0"></div>
              @for (p of d.professionals; track p.id) {
                <div class="col-head"><span [style.background]="p.color" style="width:10px;height:10px;border-radius:50%"></span>{{ p.name }}
                  @if (p.id === d.mine) { <span class="badge badge-info" style="font-size:9.5px">você</span> }</div>
              }
              <div class="time-col" [style.height.px]="gridHeight()">
                @for (h of hours(); track h) { <div class="time-label" [style.top.px]="(h * 60 - startMin()) * ppm" [style.transform]="h * 60 === startMin() ? 'translateY(3px)' : null">{{ h }}:00</div> }
              </div>
              @for (p of d.professionals; track p.id) {
                <div class="col" [style.height.px]="gridHeight()" (click)="clickGrid($event, p)">
                  @for (h of hours(); track h) { <div class="hour-line" [style.top.px]="(h * 60 - startMin()) * ppm"></div><div class="half-line" [style.top.px]="(h * 60 + 30 - startMin()) * ppm"></div> }
                  @for (o of offRanges(p); track $index) { <div class="off" [style.top.px]="o[0]" [style.height.px]="o[1]"></div> }
                  @for (b of blocksOf(p.id); track b.id) {
                    <div class="block" [style.top.px]="topOf(b.start_local)" [style.height.px]="heightOf(b.start_local, b.end_local)" (click)="$event.stopPropagation(); removeBlock(b)" title="Clique para remover o bloqueio">
                      <ax-icon name="ban" [size]="10" /> {{ b.reason || 'Bloqueado' }}</div>
                  }
                  @for (a of apptsOf(p.id); track a.id) {
                    <div class="appt" [class.cancel]="a.status === 'cancelado' || a.status === 'faltou'" [style.top.px]="topOf(a.start_local)" [style.height.px]="heightOf(a.start_local, a.end_local)"
                      [style.border-left-color]="p.color" [style.background]="bg(a.status)" (click)="$event.stopPropagation(); openDetail(a)">
                      <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ a.start_local.slice(11) }} · {{ a.customer }}</div>
                      <div style="color:#475B6E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ svcNames(a) }}</div>
                      @if (a.status !== 'agendado') { <div style="font-size:10px;color:#647687">{{ statusLabel(a.status) }}{{ a.sale_number ? ' · venda ' + a.sale_number : '' }}</div> }
                    </div>
                  }
                  @if (isToday() && nowMin() >= startMin() && nowMin() <= endMin()) { <div class="now-line" [style.top.px]="(nowMin() - startMin()) * ppm"></div> }
                </div>
              }
            </div>
          </div>
          <p style="font-size:11px;color:#647687;margin-top:8px">Clique em um horário vazio para agendar. Áreas listradas: fora do expediente. Blocos cinza: bloqueios (clique para remover).</p>
        } @else {
          <div class="card" style="overflow:hidden">
            @for (g of byDay(); track g.date) {
              <div style="padding:8px 16px;background:#F7FAFD;border-bottom:1px solid #EEF2F6;font-size:12px;font-weight:600;color:#475B6E">{{ g.label }}</div>
              @for (a of g.items; track a.id) {
                <div style="display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid #F0F4F8;cursor:pointer" (click)="openDetail(a)">
                  <span class="mono" style="font-weight:600;width:96px">{{ a.start_local.slice(11) }}–{{ a.end_local.slice(11) }}</span>
                  <span [style.background]="a.color" style="width:8px;height:8px;border-radius:50%"></span>
                  <div style="flex:1;min-width:0"><div style="font-weight:600">{{ a.customer }}</div><div style="font-size:12px;color:#647687">{{ svcNames(a) }} · {{ a.professional }}</div></div>
                  <span class="badge" [class]="badge(a.status)">{{ statusLabel(a.status) }}</span>
                  <span class="mono" style="width:90px;text-align:right">{{ a.total | brl }}</span>
                </div>
              }
            } @empty { <div class="empty-state">Nenhum atendimento nos próximos 7 dias.</div> }
          </div>
        }
      }
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:240px"></div></div> }
  </div>

  <!-- Novo / remarcar -->
  <ax-modal [(open)]="formOpen" [title]="editing() ? 'Remarcar ' + term('atendimento').toLowerCase() + ' nº ' + editing().number : 'Novo agendamento'" icon="calendar-plus" [width]="640">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <label class="field-label" style="margin:0;flex:1">{{ term('cliente') }}</label>
      <label style="font-size:12px;color:#647687;display:flex;gap:6px;align-items:center"><input type="checkbox" [(ngModel)]="guest" /> sem cadastro (encaixe)</label>
    </div>
    @if (!guest) { <ax-customer-picker [(value)]="fCustomer" (valueChange)="loadPackages()" /> }
    @else { <div style="display:grid;grid-template-columns:1fr 160px;gap:8px"><input class="input-field" placeholder="Nome" [(ngModel)]="fGuestName" /><input class="input-field" placeholder="Telefone" [(ngModel)]="fGuestPhone" /></div> }
    @if (alerts().length) { <div class="state-warning" style="margin:8px 0 0"><ax-icon name="alert-triangle" [size]="14" /><span><b>Atenção (ficha):</b> {{ alerts().join(' · ') }}</span></div> }

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px">
      <div><label class="field-label">{{ term('profissional') }}</label>
        <select class="input-field" [(ngModel)]="fProf" (ngModelChange)="onProfChange()">@for (p of formProfs(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></div>
      <div><label class="field-label">{{ term('sala') }} (opcional)</label><input class="input-field" [(ngModel)]="fRoom" /></div>
    </div>

    <label class="field-label" style="margin-top:12px">{{ term('servicos') }}</label>
    @for (l of lines(); track $index; let i = $index) {
      <div class="svc-row">
        <div>
          <select class="input-field" [ngModel]="l.productId" (ngModelChange)="setLine(i, 'productId', $event)">
            <option value="">Selecione…</option>
            @for (s of services(); track s.id) { <option [value]="s.id">{{ s.name }} · {{ s.duration_min || interval() }} min · {{ s.sale_price | brl }}</option> }
          </select>
          @if (pkgFor(l.productId).length) {
            <select class="input-field" style="margin-top:4px;font-size:12px" [ngModel]="l.customerPackageId" (ngModelChange)="setLine(i, 'customerPackageId', $event)">
              <option value="">Cobrar normalmente</option>
              @for (k of pkgFor(l.productId); track k.id) { <option [value]="k.id">Usar pacote “{{ k.package_name }}” ({{ k.remaining }} sessão(ões) restante(s))</option> }
            </select>
          }
        </div>
        <select class="input-field svc-prof" style="font-size:12px" [ngModel]="l.professionalId" (ngModelChange)="setLine(i, 'professionalId', $event)" title="Profissional deste serviço">
          @for (p of formProfs(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
        </select>
        <button class="btn-ghost" style="padding:4px;color:#C93636" (click)="removeLine(i)" [disabled]="lines().length === 1" aria-label="Remover serviço"><ax-icon name="x" [size]="14" /></button>
      </div>
    }
    <button class="btn-ghost" style="font-size:12px" (click)="addLine()"><ax-icon name="plus" [size]="12" /> Adicionar serviço</button>
    <div style="font-size:12px;color:#647687;margin-top:4px">Duração total: <b>{{ totalDuration() }} min</b> · Valor: <b>{{ totalPrice() | brl }}</b></div>

    <div style="display:grid;grid-template-columns:170px 1fr;gap:10px;margin-top:12px;align-items:start">
      <div><label class="field-label">Data</label><input type="date" class="input-field" [(ngModel)]="fDate" (ngModelChange)="loadSlots()" /></div>
      <div><label class="field-label">Horário</label>
        <div style="display:flex;gap:6px;align-items:center"><input type="time" step="300" class="input-field" style="width:120px" [(ngModel)]="fTime" />
          <span style="font-size:11px;color:#647687">ou escolha um horário livre:</span></div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;max-height:92px;overflow:auto">
          @for (s of slots(); track s) { <span class="slot-chip" [class.active]="fTime === s" (click)="fTime = s">{{ s }}</span> }
          @empty { <span style="font-size:11px;color:#8696A7">{{ slotsLoaded() ? 'Sem horários livres para esta duração.' : 'Selecione os serviços para ver os horários livres.' }}</span> }
        </div>
      </div>
    </div>
    <label class="field-label" style="margin-top:12px">Observações</label>
    <textarea class="input-field" rows="2" [(ngModel)]="fNotes"></textarea>
    @if (outside()) {
      <div class="state-warning" style="margin-top:10px"><ax-icon name="alert-triangle" [size]="14" /><span>{{ outside() }}</span></div>
      @if (data()?.canSeeAll) { <label style="display:flex;gap:6px;font-size:12px;margin-top:6px"><input type="checkbox" [(ngModel)]="ignoreHours" /> Agendar mesmo fora do expediente</label> }
    }
    <div footer><button class="btn-secondary" (click)="formOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="busy()" (click)="save()">{{ editing() ? 'Salvar alterações' : 'Agendar' }}</button></div>
  </ax-modal>

  <!-- Detalhe -->
  <ax-modal [open]="!!detail()" (closed)="detail.set(null)" [title]="term('atendimento') + ' nº ' + (detail()?.number ?? '')" icon="calendar-days" [width]="560">
    @if (detail(); as a) {
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div><div style="font-size:16px;font-weight:700">{{ a.customer }}</div>
          <div style="font-size:12px;color:#647687">{{ a.phone ? (a.phone | phone) : 'sem telefone' }}{{ a.customer_id ? '' : ' · sem cadastro' }}</div></div>
        <span class="badge" [class]="badge(a.status)">{{ statusLabel(a.status) }}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0;font-size:12.5px">
        <div><span class="muted">Quando</span><div style="font-weight:600">{{ a.start_local.slice(0, 10) | dt }} · {{ a.start_local.slice(11) }}–{{ a.end_local.slice(11) }}</div></div>
        <div><span class="muted">{{ term('profissional') }}</span><div style="font-weight:600">{{ a.professional }}</div></div>
        @if (a.room) { <div><span class="muted">{{ term('sala') }}</span><div>{{ a.room }}</div></div> }
        @if (a.sale_number) { <div><span class="muted">Venda</span><div><a style="color:#0875D1;cursor:pointer" (click)="router.navigateByUrl('/pedido-detail/' + a.sale_id)">nº {{ a.sale_number }}</a></div></div> }
      </div>
      <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr><th>{{ term('servico') }}</th><th>{{ term('profissional') }}</th><th class="num">Valor</th></tr></thead>
        <tbody>@for (s of a.services; track s.id) {
          <tr><td>{{ s.name }} <span class="muted">({{ s.duration_min }} min)</span>
              @if (s.customer_package_id) { <span class="badge badge-info" style="margin-left:4px">Pacote</span> }
              @if (s.plan_item_id) { <span class="badge badge-info" style="margin-left:4px">Plano de tratamento</span> }
              @if (s.billed) { <span class="badge badge-success" style="margin-left:4px">Cobrado</span> }</td>
            <td>{{ s.professional }}</td><td class="num">{{ s.price | brl }}</td></tr>
        }</tbody>
      </table>
      @if (a.notes) { <div style="margin-top:10px;font-size:12.5px;background:#F7FAFD;border-radius:8px;padding:8px 10px">{{ a.notes }}</div> }
    }
    <div footer style="flex-wrap:wrap;gap:6px">
      @if (detail(); as a) {
        @if (a.customer_id) { <button class="btn-ghost" style="font-size:12px" (click)="openFicha(a)"><ax-icon name="clipboard-list" [size]="13" /> {{ auth.has('prontuario') && auth.can('prontuario.ver') ? term('prontuario') : 'Ficha do cliente' }}</button> }
        @if (auth.can('agenda.editar')) {
          @if (a.status === 'agendado' || a.status === 'confirmado') {
            <button class="btn-ghost" style="font-size:12px" (click)="remind(a)"><ax-icon name="message-circle" [size]="13" /> Lembrete</button>
            <button class="btn-ghost" style="font-size:12px" (click)="openEdit(a)"><ax-icon name="pencil" [size]="13" /> Remarcar</button>
            <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="setStatus(a, 'cancelado')">Cancelar</button>
            @if (isPast(a)) { <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="setStatus(a, 'faltou')">Faltou</button> }
          }
          @if (a.status === 'agendado') { <button class="btn-secondary" style="font-size:12px" (click)="setStatus(a, 'confirmado')"><ax-icon name="check" [size]="13" /> Confirmar</button> }
          @if (a.status === 'agendado' || a.status === 'confirmado') { <button class="btn-secondary" style="font-size:12px" (click)="setStatus(a, 'em_atendimento')"><ax-icon name="play" [size]="13" /> Iniciar</button> }
          @if (a.status === 'faltou') { <button class="btn-ghost" style="font-size:12px" (click)="setStatus(a, 'agendado')">Desfazer falta</button> }
          @if (a.status !== 'cancelado' && a.status !== 'faltou' && a.status !== 'concluido') { <button class="btn-secondary" style="font-size:12px" (click)="complete(a)"><ax-icon name="check-check" [size]="13" /> Concluir sem cobrar</button> }
        }
        @if (billable(a) && auth.can('vendas.criar') && a.status !== 'cancelado' && a.status !== 'faltou') { <button class="btn-primary" style="font-size:12px" (click)="checkout(a)"><ax-icon name="scan-barcode" [size]="13" /> Cobrar no PDV</button> }
      }
    </div>
  </ax-modal>

  <!-- Bloqueio -->
  <ax-modal [(open)]="blockOpen" title="Bloquear horário" icon="ban" [width]="440">
    <label class="field-label">{{ term('profissional') }}</label>
    <select class="input-field" [(ngModel)]="bProf" style="margin-bottom:8px">@for (p of formProfs(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
      <div><label class="field-label">Data</label><input type="date" class="input-field" [(ngModel)]="bDate" /></div>
      <div><label class="field-label">Início</label><input type="time" class="input-field" [(ngModel)]="bStart" /></div>
      <div><label class="field-label">Fim</label><input type="time" class="input-field" [(ngModel)]="bEnd" /></div>
    </div>
    <label class="field-label" style="margin-top:8px">Motivo</label><input class="input-field" [(ngModel)]="bReason" placeholder="Folga, curso, consulta médica…" />
    <div footer><button class="btn-secondary" (click)="blockOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveBlock()">Bloquear</button></div>
  </ax-modal>

  <!-- Lembretes -->
  <ax-modal [(open)]="remOpen" title="Lembretes por WhatsApp" icon="message-circle" [width]="620">
    <div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px">
      <div><label class="field-label">Atendimentos do dia</label><input type="date" class="input-field" [(ngModel)]="remDate" (ngModelChange)="loadReminders()" /></div>
      <span style="flex:1"></span>
      <button class="btn-primary" style="font-size:12px" [disabled]="!remPending().length" (click)="remindAll()"><ax-icon name="send" [size]="13" /> Enviar para {{ remPending().length }} com consentimento</button>
    </div>
    @for (r of reminders(); track r.id) {
      <div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #F0F4F8;font-size:12.5px">
        <span class="mono" style="width:44px;font-weight:600">{{ r.start_local.slice(11) }}</span>
        <div style="flex:1;min-width:0"><div style="font-weight:600">{{ r.customer }}</div><div class="muted" style="font-size:11.5px">{{ svcNames(r) }} · {{ r.professional }}</div></div>
        @if (r.reminder_status) { <span class="badge badge-info">{{ r.reminder_status }}</span> }
        @else if (!r.customer_id) { <span class="badge badge-muted">sem cadastro</span> }
        @else if (!r.whatsapp_consent) { <span class="badge badge-muted">sem consentimento</span> }
        @else { <button class="btn-ghost" style="font-size:11px" (click)="remind(r, true)">Enviar</button> }
      </div>
    } @empty { <div class="empty-state">Nenhum atendimento agendado nesta data.</div> }
    <p style="font-size:11px;color:#647687;margin-top:8px">O envio usa o WhatsApp oficial da empresa (Integrações › WhatsApp) e só vai para clientes que autorizaram mensagens. Fora da janela de 24 h, cadastre um modelo aprovado com a finalidade “agendamento”.</p>
  </ax-modal>`,
})
export class AgendaPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); private route = inject(ActivatedRoute);
  readonly ppm = 1.4; // pixels por minuto
  readonly today = todayIso();
  readonly date = signal(todayIso()); readonly view = signal<'dia' | 'lista'>('dia'); readonly profFilter = signal('');
  readonly data = signal<any>(null); readonly allProfs = signal<any[]>([]); readonly services = signal<any[]>([]);
  readonly nowMin = signal(new Date().getHours() * 60 + new Date().getMinutes());
  term(k: string) { return this.auth.term(k); }

  async ngOnInit() {
    const qd = this.route.snapshot.queryParamMap.get('data'); if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) this.date.set(qd);
    await this.load();
    try { const r = await this.api.get<any>('/services', { size: 500 }); this.services.set(r.items); } catch { /* sem permissão */ }
    const cid = this.route.snapshot.queryParamMap.get('cliente');
    if (cid && this.auth.can('agenda.editar')) {
      try {
        const c = await this.api.get('/customers/' + cid); const qp = this.route.snapshot.queryParamMap;
        this.openNew(qp.get('profissional') || undefined); this.fCustomer.set(c); this.loadPackages();
        const svc = qp.get('servico');
        if (svc) { this.lines.set([{ productId: svc, professionalId: this.fProf, customerPackageId: '', planItemId: qp.get('planoItem') || undefined }]); this.loadSlots(); }
      } catch { /* */ }
    }
    setInterval(() => this.nowMin.set(new Date().getHours() * 60 + new Date().getMinutes()), 60_000);
  }
  async load() {
    try {
      const d = await this.api.get<any>('/agenda', { date: this.date(), days: this.view() === 'lista' ? 7 : 1, professional: this.profFilter() || undefined });
      if (!this.profFilter()) this.allProfs.set(d.professionals);
      this.data.set(d);
    } catch (e) { this.toast.error(e); }
  }
  go(d: string) { if (!d) return; this.date.set(d); this.load(); }
  shift(n: number) { this.go(addDaysIso(this.date(), this.view() === 'lista' ? 7 * n : n)); }
  setView(v: 'dia' | 'lista') { this.view.set(v); this.load(); }
  setProf(id: string) { this.profFilter.set(id); this.load(); }
  readonly dowLabel = computed(() => DOW[new Date(this.date() + 'T12:00:00Z').getUTCDay()]);
  readonly isToday = computed(() => this.date() === todayIso());
  readonly interval = computed(() => Number(this.data()?.settings?.intervaloMin || 30));

  // ---------- grade ----------
  readonly startMin = computed(() => {
    const d = this.data(); if (!d) return 8 * 60;
    let m = 24 * 60;
    for (const p of d.professionals) for (const iv of (p.work_hours?.[String(new Date(this.date() + 'T12:00:00Z').getUTCDay())] ?? [])) m = Math.min(m, toMin(iv[0]));
    for (const a of d.appointments) if (a.start_local.slice(0, 10) === this.date()) m = Math.min(m, toMin(a.start_local.slice(11)));
    return m === 24 * 60 ? 8 * 60 : Math.floor(m / 60) * 60;
  });
  readonly endMin = computed(() => {
    const d = this.data(); if (!d) return 19 * 60;
    let m = 0;
    for (const p of d.professionals) for (const iv of (p.work_hours?.[String(new Date(this.date() + 'T12:00:00Z').getUTCDay())] ?? [])) m = Math.max(m, toMin(iv[1]));
    for (const a of d.appointments) if (a.end_local.slice(0, 10) === this.date()) m = Math.max(m, toMin(a.end_local.slice(11)));
    if (!m) m = 19 * 60;
    return Math.min(24 * 60, Math.ceil(m / 60) * 60);
  });
  readonly hours = computed(() => { const out: number[] = []; for (let h = this.startMin() / 60; h < this.endMin() / 60; h++) out.push(h); return out; });
  readonly gridHeight = computed(() => (this.endMin() - this.startMin()) * this.ppm);
  topOf(local: string) { const m = local.slice(0, 10) < this.date() ? this.startMin() : toMin(local.slice(11)); return Math.max(0, (m - this.startMin()) * this.ppm); }
  heightOf(a: string, b: string) {
    const s = a.slice(0, 10) < this.date() ? this.startMin() : toMin(a.slice(11));
    const e = b.slice(0, 10) > this.date() ? this.endMin() : toMin(b.slice(11));
    return Math.max(22, (Math.min(e, this.endMin()) - Math.max(s, this.startMin())) * this.ppm - 2);
  }
  offRanges(p: any): [number, number][] {
    const day: [string, string][] = Object.keys(p.work_hours || {}).length ? (p.work_hours[String(new Date(this.date() + 'T12:00:00Z').getUTCDay())] ?? []) : [[fmtMin(this.startMin()), fmtMin(this.endMin())]];
    const out: [number, number][] = []; let cur = this.startMin();
    for (const [a, b] of day) { if (toMin(a) > cur) out.push([(cur - this.startMin()) * this.ppm, (toMin(a) - cur) * this.ppm]); cur = Math.max(cur, toMin(b)); }
    if (cur < this.endMin()) out.push([(cur - this.startMin()) * this.ppm, (this.endMin() - cur) * this.ppm]);
    return out;
  }
  apptsOf(id: string) { return (this.data()?.appointments ?? []).filter((a: any) => a.professional_id === id && a.start_local.slice(0, 10) <= this.date() && a.end_local.slice(0, 10) >= this.date()); }
  blocksOf(id: string) { return (this.data()?.blocks ?? []).filter((b: any) => b.professional_id === id && b.start_local.slice(0, 10) <= this.date() && b.end_local.slice(0, 10) >= this.date()); }
  bg(s: string) { return APPT_STATUS[s]?.[2] ?? '#F1F4F7'; }
  badge(s: string) { return 'badge ' + (APPT_STATUS[s]?.[1] ?? 'badge-muted'); }
  statusLabel(s: string) { return APPT_STATUS[s]?.[0] ?? s; }
  svcNames(a: any) { return (a.services ?? []).map((s: any) => s.name).join(', '); }
  isPast(a: any) { return a.start_local <= `${todayIso()}T${fmtMin(this.nowMin())}`; }
  billable(a: any) { return (a.services ?? []).some((s: any) => !s.customer_package_id && !s.plan_item_id && !s.billed && Number(s.price) > 0); }
  readonly byDay = computed(() => {
    const groups: { date: string; label: string; items: any[] }[] = [];
    for (const a of this.data()?.appointments ?? []) {
      const d = a.start_local.slice(0, 10); let g = groups.find((x) => x.date === d);
      if (!g) { g = { date: d, label: `${DOW[new Date(d + 'T12:00:00Z').getUTCDay()]}, ${d.slice(8, 10)}/${d.slice(5, 7)}`, items: [] }; groups.push(g); }
      g.items.push(a);
    }
    return groups;
  });
  clickGrid(e: MouseEvent, p: any) {
    if (!this.auth.can('agenda.editar')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const m = this.startMin() + Math.floor(((e.clientY - rect.top) / this.ppm) / 15) * 15;
    this.openNew(p.id, fmtMin(m));
  }

  // ---------- formulário ----------
  readonly formOpen = signal(false); readonly editing = signal<any>(null); readonly busy = signal(false);
  readonly fCustomer = signal<any>(null); readonly lines = signal<Line[]>([]); readonly packages = signal<any[]>([]); readonly alerts = signal<string[]>([]);
  readonly slots = signal<string[]>([]); readonly slotsLoaded = signal(false); readonly outside = signal('');
  guest = false; fGuestName = ''; fGuestPhone = ''; fProf = ''; fRoom = ''; fDate = ''; fTime = ''; fNotes = ''; ignoreHours = false;
  private idem = newIdempotencyKey();
  readonly formProfs = computed(() => this.allProfs().length ? this.allProfs() : (this.data()?.professionals ?? []));
  readonly totalDuration = computed(() => this.lines().reduce((s, l) => s + Number(this.services().find((x) => x.id === l.productId)?.duration_min || (l.productId ? this.interval() : 0)), 0));
  readonly totalPrice = computed(() => this.lines().reduce((s, l) => s + (l.customerPackageId || !l.productId ? 0 : Number(this.services().find((x) => x.id === l.productId)?.sale_price || 0)), 0));
  pkgFor(productId: string) { return productId ? this.packages().filter((k) => k.status === 'ativo' && !k.expired && k.service_product_id === productId && Number(k.remaining) > 0) : []; }

  openNew(profId?: string, time?: string) {
    this.editing.set(null); this.guest = false; this.fGuestName = ''; this.fGuestPhone = ''; this.fCustomer.set(null); this.packages.set([]); this.alerts.set([]);
    this.fProf = profId || this.data()?.mine || this.formProfs()[0]?.id || ''; this.fRoom = ''; this.fNotes = ''; this.fDate = this.date(); this.fTime = time || '';
    this.lines.set([{ productId: '', professionalId: this.fProf, customerPackageId: '' }]); this.outside.set(''); this.ignoreHours = false; this.slots.set([]); this.slotsLoaded.set(false);
    this.idem = newIdempotencyKey(); this.formOpen.set(true);
  }
  openEdit(a: any) {
    this.detail.set(null);
    this.editing.set(a); this.guest = !a.customer_id; this.fGuestName = a.guest_name || ''; this.fGuestPhone = a.guest_phone || '';
    this.fCustomer.set(a.customer_id ? { id: a.customer_id, name: a.customer } : null); this.fProf = a.professional_id; this.fRoom = a.room || ''; this.fNotes = a.notes || '';
    this.fDate = a.start_local.slice(0, 10); this.fTime = a.start_local.slice(11);
    this.lines.set(a.services.map((s: any) => ({ productId: s.product_id, professionalId: s.professional_id, customerPackageId: s.customer_package_id || '', planItemId: s.plan_item_id || undefined })));
    this.outside.set(''); this.ignoreHours = false; this.formOpen.set(true); this.loadPackages(); this.loadSlots();
  }
  onProfChange() { const old = this.lines(); this.lines.set(old.map((l, i) => (i === 0 || !l.professionalId ? { ...l, professionalId: this.fProf } : l))); this.loadSlots(); }
  setLine(i: number, k: keyof Line, v: string) { const l = [...this.lines()]; l[i] = { ...l[i], [k]: v } as Line; if (k === 'productId') l[i].customerPackageId = this.pkgFor(v)[0]?.id ?? ''; this.lines.set(l); this.loadSlots(); }
  addLine() { this.lines.update((l) => [...l, { productId: '', professionalId: this.fProf, customerPackageId: '' }]); }
  removeLine(i: number) { this.lines.update((l) => l.filter((_, k) => k !== i)); this.loadSlots(); }
  async loadPackages() {
    const c = this.fCustomer(); this.packages.set([]); this.alerts.set([]);
    if (!c) return;
    try { this.packages.set(await this.api.get<any[]>(`/customers/${c.id}/packages`)); } catch { /* */ }
    if (this.auth.can('prontuario.ver') && this.auth.has('prontuario')) { try { const f: any = await this.api.get(`/customers/${c.id}/clinical`); this.alerts.set(f.alerts ?? []); } catch { /* */ } }
  }
  async loadSlots() {
    this.slotsLoaded.set(false);
    if (!this.fProf || !this.fDate || !this.totalDuration()) { this.slots.set([]); return; }
    try { const r: any = await this.api.get('/agenda/slots', { professionalId: this.fProf, date: this.fDate, duration: this.totalDuration() }); this.slots.set(r.slots); this.slotsLoaded.set(true); }
    catch { this.slots.set([]); }
  }
  async save() {
    const lines = this.lines().filter((l) => l.productId);
    if (!lines.length) { this.toast.error('Selecione pelo menos um serviço.'); return; }
    if (!this.fTime || !this.fDate) { this.toast.error('Informe data e horário.'); return; }
    if (!this.guest && !this.fCustomer()) { this.toast.error('Selecione o cliente ou marque “sem cadastro”.'); return; }
    const body: any = {
      professionalId: this.fProf, start: `${this.fDate}T${this.fTime.slice(0, 5)}`, room: this.fRoom || null, notes: this.fNotes || null, ignoreHours: this.ignoreHours || undefined,
      services: lines.map((l) => ({ productId: l.productId, professionalId: l.professionalId || undefined, customerPackageId: l.customerPackageId || undefined, planItemId: l.planItemId || undefined })),
      ...(this.guest ? { customerId: null, guestName: this.fGuestName.trim(), guestPhone: this.fGuestPhone || null } : { customerId: this.fCustomer().id }),
    };
    this.busy.set(true);
    try {
      if (this.editing()) await this.api.put(`/appointments/${this.editing().id}`, body);
      else await this.api.post('/appointments', body, { idempotent: this.idem });
      this.toast.success(this.editing() ? 'Atendimento remarcado.' : 'Agendado.'); this.formOpen.set(false);
      if (this.fDate !== this.date()) this.date.set(this.fDate);
      this.load();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'fora_do_expediente') this.outside.set(e.message);
      else { this.toast.error(e); if (!(e instanceof ApiError && e.status === 409)) this.idem = newIdempotencyKey(); }
    } finally { this.busy.set(false); }
  }

  // ---------- detalhe e ações ----------
  readonly detail = signal<any>(null);
  openDetail(a: any) { this.detail.set(a); }
  openFicha(a: any) { this.router.navigateByUrl(this.auth.has('prontuario') && this.auth.can('prontuario.ver') ? `/ficha/${a.customer_id}` : `/cliente-detail/${a.customer_id}`); }
  async setStatus(a: any, status: string) {
    let reason: string | undefined;
    if (status === 'cancelado') { reason = prompt('Motivo do cancelamento:') ?? undefined; if (!reason) return; }
    if (status === 'faltou') reason = 'Não compareceu';
    try { await this.api.post(`/appointments/${a.id}/status`, { status, reason }); this.toast.success('Atualizado.'); this.detail.set(null); this.load(); } catch (e) { this.toast.error(e); }
  }
  async complete(a: any) {
    if (this.billable(a) && !confirm('Há serviços com valor ainda não cobrados. Concluir sem cobrar agora? (Você poderá cobrar depois pelo PDV.)')) return;
    try { await this.api.post(`/appointments/${a.id}/complete`, {}, { idempotent: true }); this.toast.success('Atendimento concluído.'); this.detail.set(null); this.load(); } catch (e) { this.toast.error(e); }
  }
  checkout(a: any) { this.router.navigate(['/pdv'], { queryParams: { atendimento: a.id } }); }
  async remind(a: any, inList = false) {
    try {
      const m: any = await this.api.post(`/appointments/${a.id}/remind`, {});
      const st = m?.duplicate ? 'já enviado' : m?.status;
      this.toast.show(st === 'fila' ? 'Lembrete na fila de envio.' : `Lembrete: ${st}${m?.error ? ' — ' + m.error : ''}`, st === 'fila' ? 'success' : 'info');
      if (inList) this.loadReminders();
    } catch (e) { this.toast.error(e); }
  }

  // ---------- bloqueios ----------
  readonly blockOpen = signal(false); bProf = ''; bDate = ''; bStart = '12:00'; bEnd = '13:00'; bReason = '';
  openBlock() { this.bProf = this.data()?.mine || this.formProfs()[0]?.id || ''; this.bDate = this.date(); this.bReason = ''; this.blockOpen.set(true); }
  async saveBlock() {
    try { await this.api.post('/schedule-blocks', { professionalId: this.bProf, start: `${this.bDate}T${this.bStart}`, end: `${this.bDate}T${this.bEnd}`, reason: this.bReason || undefined }); this.toast.success('Horário bloqueado.'); this.blockOpen.set(false); this.load(); }
    catch (e) { this.toast.error(e); }
  }
  async removeBlock(b: any) {
    if (!this.auth.can('agenda.editar') || !confirm(`Remover o bloqueio "${b.reason || 'Bloqueado'}"?`)) return;
    try { await this.api.delete(`/schedule-blocks/${b.id}`); this.load(); } catch (e) { this.toast.error(e); }
  }

  // ---------- lembretes ----------
  readonly remOpen = signal(false); readonly reminders = signal<any[]>([]); remDate = addDaysIso(todayIso(), 1);
  readonly remPending = computed(() => this.reminders().filter((r) => r.customer_id && r.whatsapp_consent && !r.reminder_status));
  openReminders() { this.remOpen.set(true); this.loadReminders(); }
  async loadReminders() { try { this.reminders.set(await this.api.get<any[]>('/appointments-reminders', { date: this.remDate })); } catch (e) { this.toast.error(e); } }
  async remindAll() {
    let ok = 0;
    for (const r of this.remPending()) { try { await this.api.post(`/appointments/${r.id}/remind`, {}); ok++; } catch { /* segue */ } }
    this.toast.success(`${ok} lembrete(s) processado(s).`); this.loadReminders();
  }
}
