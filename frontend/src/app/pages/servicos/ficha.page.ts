import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, addDaysIso, todayIso } from '../../core/format';
import { APPT_STATUS } from './agenda.page';

export const PLAN_STATUS: Record<string, [string, string]> = {
  rascunho: ['Rascunho', 'badge-muted'], apresentado: ['Aguardando aprovação', 'badge-warning'], aprovado: ['Aprovado', 'badge-info'], em_andamento: ['Em andamento', 'badge-info'],
  concluido: ['Concluído', 'badge-success'], recusado: ['Recusado', 'badge-danger'], cancelado: ['Cancelado', 'badge-danger'],
};
const KINDS: [string, string][] = [['evolucao', 'Evolução / procedimento realizado'], ['ficha_tecnica', 'Ficha técnica (ex.: fórmula de coloração)'], ['avaliacao', 'Avaliação'], ['observacao', 'Observação']];
const KIND_LABEL: Record<string, string> = { anamnese: 'Anamnese', evolucao: 'Evolução', ficha_tecnica: 'Ficha técnica', avaliacao: 'Avaliação', observacao: 'Observação' };
export const CONDITIONS: [string, string, string][] = [
  ['higido', 'Hígido', '#FFFFFF'], ['carie', 'Cárie', '#F5B7B1'], ['restaurado', 'Restaurado', '#AED6F1'], ['canal', 'Tratamento de canal', '#D7BDE2'], ['coroa', 'Coroa', '#F9E79F'],
  ['implante', 'Implante', '#A9DFBF'], ['protese', 'Prótese', '#FAD7A0'], ['extracao_indicada', 'Extração indicada', '#E74C3C'], ['ausente', 'Ausente', '#D5D8DC'],
  ['fratura', 'Fratura', '#F1948A'], ['selante', 'Selante', '#D1F2EB'], ['mobilidade', 'Mobilidade', '#FDEBD0'], ['outro', 'Outro', '#EAECEE'],
];
const COND = Object.fromEntries(CONDITIONS.map((c) => [c[0], c]));
const UP = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const LOW = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
const UP_D = [55, 54, 53, 52, 51, 61, 62, 63, 64, 65];
const LOW_D = [85, 84, 83, 82, 81, 71, 72, 73, 74, 75];
const FACES: [string, string][] = [['M', 'Mesial'], ['D', 'Distal'], ['O', 'Oclusal'], ['I', 'Incisal'], ['V', 'Vestibular'], ['L', 'Lingual'], ['P', 'Palatina']];

/** Ficha do cliente/paciente: alertas de saúde, anamnese com consentimento, evolução, odontograma, planos de tratamento, pacotes e atendimentos. */
@Component({
  selector: 'ax-ficha',
  imports: [FormsModule, IconComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .tooth { width:38px; height:46px; border:1.5px solid #B8C4D0; border-radius:8px 8px 12px 12px; display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; font-size:11px; font-weight:700; color:#172B3A; position:relative; }
    .tooth:hover { border-color:#0875D1; box-shadow:0 0 0 2px #E3EFF9; }
    .tooth .f { font-size:8.5px; font-weight:500; color:#475B6E; }
    .tooth.planejado { border-style:dashed; border-color:#D99000; }
    .arch { display:flex; gap:4px; justify-content:center; flex-wrap:nowrap; }
    .arch .gap { width:14px; }
    .rec { border-left:3px solid #DCE4EC; padding:8px 12px; margin-bottom:10px; background:white; border-radius:0 8px 8px 0; }
    .q-row { display:grid; grid-template-columns:1fr 220px; gap:10px; align-items:center; padding:6px 0; border-bottom:1px solid #F3F6F9; font-size:12.5px; }
    @media (max-width:760px) { .q-row { grid-template-columns:1fr; } }
    @media print { :host .no-print { display:none !important; } }
  `],
  template: `
  <div style="padding:20px 24px" class="no-print">
    @if (data(); as d) {
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div><div style="font-size:12px;color:#647687">{{ auth.term('prontuario') }}</div>
          <h1 style="font-size:20px;font-weight:700;color:#172B3A">{{ d.customer.name }}</h1>
          <div style="font-size:12.5px;color:#647687">{{ d.customer.birth_date ? (d.customer.birth_date | dt) + ' · ' + age(d.customer.birth_date) + ' anos · ' : '' }}{{ (d.customer.whatsapp || d.customer.phone) ? ((d.customer.whatsapp || d.customer.phone) | phone) : 'sem telefone' }}</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-ghost" style="font-size:12px" (click)="router.navigateByUrl('/cliente-detail/' + id)"><ax-icon name="user" [size]="13" /> Cadastro</button>
          @if (auth.can('agenda.editar')) { <button class="btn-secondary" style="font-size:12px" (click)="router.navigate(['/agenda'], { queryParams: { cliente: id } })"><ax-icon name="calendar-plus" [size]="13" /> Agendar</button> }
        </div>
      </div>
      @if (d.alerts.length) { <div class="state-warning" style="margin:0 0 12px"><ax-icon name="alert-triangle" [size]="15" /><span><b>Alertas da anamnese:</b> {{ d.alerts.join(' · ') }}</span></div> }
      @else if (!d.anamnese) { <div class="state-info" style="margin:0 0 12px;display:flex;gap:8px;align-items:center;font-size:12.5px;background:#F0F7FD;border:1px solid #CFE3F5;border-radius:8px;padding:9px 12px"><ax-icon name="info" [size]="14" color="#0875D1" />Sem anamnese registrada. Preencha antes do primeiro procedimento.</div> }

      <div class="tabs-bar" style="margin:0 0 14px">
        @for (t of tabs(); track t[0]) { <div class="tab-item" [class.active]="tab() === t[0]" (click)="setTab(t[0])">{{ t[1] }}</div> }
      </div>

      @if (tab() === 'historico') {
        @if (auth.can('prontuario.editar')) {
          <div class="card" style="padding:14px;margin-bottom:14px">
            <div style="display:grid;grid-template-columns:240px 1fr;gap:10px" class="grid-2-resp">
              <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="rKind">@for (k of kinds; track k[0]) { <option [value]="k[0]">{{ k[1] }}</option> }</select></div>
              <div><label class="field-label">Título (opcional)</label><input class="input-field" [(ngModel)]="rTitle" /></div>
            </div>
            @if (amending()) { <div style="font-size:12px;color:#D99000;margin-top:6px">Adendo ao registro de {{ amending().created_at | dtt }} — o registro original é preservado. <a style="cursor:pointer;color:#0875D1" (click)="amending.set(null)">cancelar adendo</a></div> }
            <label class="field-label" style="margin-top:8px">Descrição</label>
            <textarea class="input-field" rows="4" [(ngModel)]="rContent" placeholder="Procedimento realizado, materiais, orientações, fórmula, observações…"></textarea>
            <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
              <select class="input-field" style="max-width:320px" [(ngModel)]="rAppt"><option value="">Sem vínculo com atendimento</option>@for (a of d.appointments.slice(0, 15); track a.id) { <option [value]="a.id">{{ a.start_local.slice(0, 10) | dt }} {{ a.start_local.slice(11) }} · {{ svc(a) }}</option> }</select>
              <span style="flex:1"></span>
              <button class="btn-primary" style="font-size:12px" (click)="saveRecord()"><ax-icon name="save" [size]="13" /> Registrar</button>
            </div>
          </div>
        }
        @for (r of d.records; track r.id) {
          <div class="rec" [style.border-left-color]="r.kind === 'anamnese' ? '#D99000' : r.amends_id ? '#7A4CC2' : '#0875D1'">
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#647687">
              <span><b style="color:#172B3A">{{ kl(r.kind) }}</b>{{ r.title ? ' — ' + r.title : '' }}{{ r.amends_id ? ' (adendo)' : '' }}</span>
              <span>{{ r.created_at | dtt }} · {{ r.professional || r.author }}</span>
            </div>
            @if (r.kind === 'anamnese') { <div style="font-size:12.5px;margin-top:4px">{{ anamneseSummary(r) }}</div> }
            @if (r.content) { <div style="font-size:13px;white-space:pre-wrap;margin-top:4px">{{ r.content }}</div> }
            @if (auth.can('prontuario.editar') && r.kind !== 'anamnese') { <a style="font-size:11px;color:#0875D1;cursor:pointer" (click)="amend(r)">Adicionar adendo</a> }
          </div>
        } @empty { <div class="empty-state">Nenhum registro ainda.</div> }
        <p style="font-size:11px;color:#647687">Registros clínicos não podem ser editados nem excluídos: correções são feitas por adendo, preservando o histórico. Cada acesso a esta ficha é registrado na auditoria.</p>
      }

      @if (tab() === 'anamnese') {
        <div class="card" style="padding:14px">
          <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px">
            <div><label class="field-label">Modelo</label><select class="input-field" [(ngModel)]="tplId" (ngModelChange)="pickTpl()">@for (t of templates(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }</select></div>
            @if (d.anamnese) { <span style="font-size:12px;color:#647687">Última atualização: {{ d.anamnese.created_at | dtt }} — preencher de novo cria uma nova versão.</span> }
          </div>
          @for (f of tplFields(); track f.key) {
            <div class="q-row"><span>{{ f.label }}@if (f.alert) { <ax-icon name="alert-triangle" [size]="11" color="#D99000" /> }</span>
              @if (f.type === 'sim_nao') {
                <div style="display:flex;gap:12px"><label><input type="radio" [name]="f.key" [checked]="answers[f.key] === true" (change)="answers[f.key] = true" /> Sim</label><label><input type="radio" [name]="f.key" [checked]="answers[f.key] === false" (change)="answers[f.key] = false" /> Não</label></div>
              } @else if (f.type === 'opcoes') {
                <select class="input-field" [(ngModel)]="answers[f.key]"><option [ngValue]="undefined">—</option>@for (o of f.options; track o) { <option [value]="o">{{ o }}</option> }</select>
              } @else { <input class="input-field" [(ngModel)]="answers[f.key]" /> }
            </div>
          }
          <label class="field-label" style="margin-top:10px">Observações</label><textarea class="input-field" rows="2" [(ngModel)]="aNotes"></textarea>
          <label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;margin-top:10px;background:#F7FAFD;border:1px solid #DCE4EC;border-radius:8px;padding:9px 11px">
            <input type="checkbox" [(ngModel)]="consent" style="margin-top:2px" />
            <span>O cliente declarou que as informações são verdadeiras e <b>autorizou o registro e o uso dos seus dados de saúde</b> para este atendimento (LGPD, art. 11). As informações são acessíveis apenas a usuários autorizados.</span></label>
          @if (auth.can('prontuario.editar')) { <div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn-primary" style="font-size:12px" [disabled]="!consent" (click)="saveAnamnese()"><ax-icon name="save" [size]="13" /> Salvar anamnese</button></div> }
        </div>
      }

      @if (tab() === 'odontograma') {
        <div class="card" style="padding:16px;overflow-x:auto">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
            <div style="font-size:13px;font-weight:600">Odontograma</div>
            <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" [(ngModel)]="deciduous" /> Mostrar dentes decíduos</label>
          </div>
          <div style="min-width:680px">
            <div class="arch">@for (t of up; track t; let i = $index) { @if (i === 8) { <span class="gap"></span> } <div class="tooth" [class.planejado]="cur(t)?.status === 'planejado'" [style.background]="color(t)" (click)="openTooth(t)" [title]="title(t)">{{ t }}<span class="f">{{ cur(t)?.faces?.join('') }}</span></div> }</div>
            @if (deciduous) {
              <div class="arch" style="margin-top:6px">@for (t of upD; track t; let i = $index) { @if (i === 5) { <span class="gap"></span> } <div class="tooth" style="width:32px;height:38px" [class.planejado]="cur(t)?.status === 'planejado'" [style.background]="color(t)" (click)="openTooth(t)" [title]="title(t)">{{ t }}</div> }</div>
              <div class="arch" style="margin-top:14px">@for (t of lowD; track t; let i = $index) { @if (i === 5) { <span class="gap"></span> } <div class="tooth" style="width:32px;height:38px;border-radius:12px 12px 8px 8px" [class.planejado]="cur(t)?.status === 'planejado'" [style.background]="color(t)" (click)="openTooth(t)" [title]="title(t)">{{ t }}</div> }</div>
            }
            <div class="arch" style="margin-top:14px">@for (t of low; track t; let i = $index) { @if (i === 8) { <span class="gap"></span> } <div class="tooth" style="border-radius:12px 12px 8px 8px" [class.planejado]="cur(t)?.status === 'planejado'" [style.background]="color(t)" (click)="openTooth(t)" [title]="title(t)">{{ t }}<span class="f">{{ cur(t)?.faces?.join('') }}</span></div> }</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;font-size:11px;color:#475B6E">
            @for (c of conditions; track c[0]) { <span style="display:inline-flex;gap:4px;align-items:center"><span [style.background]="c[2]" style="width:12px;height:12px;border:1px solid #B8C4D0;border-radius:3px"></span>{{ c[1] }}</span> }
            <span style="display:inline-flex;gap:4px;align-items:center"><span style="width:12px;height:12px;border:1.5px dashed #D99000;border-radius:3px"></span>Planejado</span>
          </div>
        </div>
        @if (odo()?.history?.length) {
          <div class="card" style="margin-top:12px;overflow:hidden"><div style="padding:10px 14px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Histórico</div>
            <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr><th>Data</th><th>Dente</th><th>Faces</th><th>Condição</th><th>Situação</th><th>Observação</th><th>Profissional</th></tr></thead>
              <tbody>@for (h of odo().history; track h.id) { <tr><td>{{ h.created_at | dtt }}</td><td class="mono">{{ h.tooth }}</td><td>{{ h.faces.join(', ') || '—' }}</td><td>{{ condLabel(h.condition) }}</td><td>{{ h.status }}</td><td>{{ h.notes || '' }}</td><td>{{ h.professional || h.author }}</td></tr> }</tbody></table></div>
        }
      }

      @if (tab() === 'planos') {
        <div style="display:flex;justify-content:flex-end;margin-bottom:10px">@if (auth.can('prontuario.editar')) { <button class="btn-primary" style="font-size:12px" (click)="openPlan(null)"><ax-icon name="plus" [size]="13" /> Novo plano de tratamento</button> }</div>
        @for (p of plans(); track p.id) {
          <div class="card" style="padding:14px;margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
              <div><div style="font-weight:700">Plano nº {{ p.number }}{{ p.title ? ' — ' + p.title : '' }}</div><div style="font-size:12px;color:#647687">{{ p.created_at | dtt }} · {{ p.professional || 'sem profissional' }} · válido até {{ p.valid_until | dt }}</div></div>
              <div style="display:flex;gap:6px;align-items:center"><span class="badge" [class]="planBadge(p.status)">{{ planLabel(p.status) }}</span><b class="mono" style="font-size:16px">{{ p.total | brl }}</b></div>
            </div>
            <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px">
              <thead><tr><th>Procedimento</th><th>Dente/faces</th><th class="num">Qtd.</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead>
              <tbody>@for (i of p.items; track i.id) {
                <tr [style.opacity]="i.status === 'cancelado' ? .5 : 1"><td>{{ i.name }}{{ i.description ? ' — ' + i.description : '' }}</td><td class="mono">{{ i.tooth || '—' }} {{ i.faces?.join('') }}</td><td class="num">{{ i.qty }}</td>
                  <td class="num">{{ i.total | brl }}@if (i.discount > 0) { <div style="font-size:10.5px;color:#647687">desc. {{ i.discount | brl }}</div> }</td>
                  <td>{{ i.status === 'realizado' ? 'Realizado ' + (i.performed_at | dt) : i.status === 'cancelado' ? 'Cancelado' : 'Pendente' }}@if (i.sale_number) { <span class="badge badge-success" style="margin-left:4px">venda {{ i.sale_number }}</span> }</td>
                  <td style="white-space:nowrap">@if (i.status === 'pendente' && (p.status === 'aprovado' || p.status === 'em_andamento') && auth.can('prontuario.editar')) {
                    @if (auth.can('agenda.editar')) { <a style="font-size:11px;color:#0875D1;cursor:pointer;margin-right:8px" (click)="schedule(p, i)">Agendar</a> }
                    <a style="font-size:11px;color:#18864B;cursor:pointer;margin-right:8px" (click)="itemAction(i, 'done')">Realizado</a>
                    @if (!i.sale_id) { <a style="font-size:11px;color:#C93636;cursor:pointer" (click)="itemAction(i, 'cancel')">Cancelar</a> } }</td></tr>
              }</tbody>
            </table>
            @if (p.notes) { <div style="font-size:12px;color:#475B6E;margin-top:6px">{{ p.notes }}</div> }
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;margin-top:10px">
              <button class="btn-ghost" style="font-size:12px" (click)="print(p)"><ax-icon name="printer" [size]="13" /> Imprimir para o {{ auth.term('cliente').toLowerCase() }}</button>
              @if (auth.can('prontuario.editar')) {
                @if (p.status === 'rascunho' || p.status === 'apresentado') {
                  <button class="btn-ghost" style="font-size:12px" (click)="openPlan(p)"><ax-icon name="pencil" [size]="13" /> Editar</button>
                  @if (p.status === 'rascunho') { <button class="btn-secondary" style="font-size:12px" (click)="planStatus(p, 'apresentado')">Marcar como apresentado</button> }
                  <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="planStatus(p, 'recusado')">Recusado</button>
                  <button class="btn-primary" style="font-size:12px" (click)="planStatus(p, 'aprovado')"><ax-icon name="check" [size]="13" /> Aprovado pelo {{ auth.term('cliente').toLowerCase() }}</button>
                }
                @if (p.status === 'aprovado' || p.status === 'em_andamento') { <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="planStatus(p, 'cancelado')">Cancelar plano</button> }
              }
              @if ((p.status === 'aprovado' || p.status === 'em_andamento' || p.status === 'concluido') && unbilled(p) > 0 && auth.can('vendas.criar')) {
                <button class="btn-primary" style="font-size:12px" (click)="router.navigate(['/pdv'], { queryParams: { plano: p.id } })"><ax-icon name="scan-barcode" [size]="13" /> Cobrar {{ unbilled(p) | brl }} no PDV</button>
              }
            </div>
          </div>
        } @empty { <div class="empty-state">Nenhum plano de tratamento.</div> }
      }

      @if (tab() === 'pacotes') {
        <div class="card" style="overflow:hidden">
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Pacote</th><th>Serviço</th><th class="num">Sessões</th><th>Validade</th><th>Situação</th></tr></thead>
            <tbody>@for (k of d.packages; track k.id) { <tr><td>{{ k.package_name }}</td><td>{{ k.service_name }}</td><td class="num"><b>{{ k.sessions_total - k.sessions_used }}</b> de {{ k.sessions_total }} restantes</td><td>{{ k.expires_at ? (k.expires_at | dt) : 'sem validade' }}</td><td>{{ k.status }}</td></tr> }
              @empty { <tr><td colspan="5"><div class="empty-state">Nenhum pacote. Pacotes vendidos no PDV aparecem aqui com o saldo de sessões.</div></td></tr> }</tbody></table>
        </div>
      }

      @if (tab() === 'atendimentos') {
        <div class="card" style="overflow:hidden">
          <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data</th><th>{{ auth.term('servicos') }}</th><th>{{ auth.term('profissional') }}</th><th>Situação</th><th class="num">Valor</th></tr></thead>
            <tbody>@for (a of d.appointments; track a.id) { <tr><td>{{ a.start_local.slice(0, 10) | dt }} {{ a.start_local.slice(11) }}</td><td>{{ svc(a) }}</td><td>{{ a.professional }}</td><td><span class="badge" [class]="apptBadge(a.status)">{{ apptLabel(a.status) }}</span></td><td class="num">{{ a.total | brl }}</td></tr> }
              @empty { <tr><td colspan="5"><div class="empty-state">Nenhum atendimento.</div></td></tr> }</tbody></table>
        </div>
      }
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:200px"></div></div> }
  </div>

  <!-- Dente -->
  <ax-modal [open]="!!tooth()" (closed)="tooth.set(null)" [title]="'Dente ' + tooth()" icon="smile" [width]="460">
    <label class="field-label">Condição</label>
    <select class="input-field" [(ngModel)]="tCond">@for (c of conditions; track c[0]) { <option [value]="c[0]">{{ c[1] }}</option> }</select>
    <label class="field-label" style="margin-top:8px">Faces</label>
    <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:12.5px">@for (f of faces; track f[0]) { <label><input type="checkbox" [checked]="tFaces.includes(f[0])" (change)="toggleFace(f[0])" /> {{ f[1] }} ({{ f[0] }})</label> }</div>
    <label class="field-label" style="margin-top:8px">Situação</label>
    <select class="input-field" [(ngModel)]="tStatus"><option value="existente">Existente (achado clínico)</option><option value="planejado">Planejado</option><option value="realizado">Realizado</option></select>
    <label class="field-label" style="margin-top:8px">Observação</label><input class="input-field" [(ngModel)]="tNotes" />
    <div footer><button class="btn-secondary" (click)="tooth.set(null)">Cancelar</button>@if (auth.can('prontuario.editar')) { <button class="btn-primary" (click)="saveTooth()">Registrar</button> }</div>
  </ax-modal>

  <!-- Plano -->
  <ax-modal [(open)]="planOpen" [title]="planForm.id ? 'Editar plano nº ' + planForm.number : 'Novo plano de tratamento'" icon="clipboard-list" [width]="760">
    <div style="display:grid;grid-template-columns:1fr 1fr 150px;gap:10px" class="grid-2-resp">
      <div><label class="field-label">Título</label><input class="input-field" [(ngModel)]="planForm.title" placeholder="ex.: Reabilitação superior" /></div>
      <div><label class="field-label">{{ auth.term('profissional') }}</label><select class="input-field" [(ngModel)]="planForm.professionalId"><option [ngValue]="null">—</option>@for (p of lk.data()?.professionals ?? []; track p.id) { <option [ngValue]="p.id">{{ p.name }}</option> }</select></div>
      <div><label class="field-label">Válido até</label><input type="date" class="input-field" [(ngModel)]="planForm.validUntil" /></div>
    </div>
    <div style="margin-top:12px">
      @for (it of planItems(); track $index; let i = $index) {
        <div style="display:grid;grid-template-columns:1fr 70px 90px 60px 100px 90px 28px;gap:6px;align-items:center;margin-bottom:6px">
          <select class="input-field" style="font-size:12px" [(ngModel)]="it.productId" (ngModelChange)="pickPlanSvc(i, $event)"><option value="">Procedimento…</option>@for (s of services(); track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select>
          <input type="number" class="input-field mono" style="font-size:12px" placeholder="dente" [(ngModel)]="it.tooth" />
          <input class="input-field mono" style="font-size:12px;text-transform:uppercase" placeholder="faces" [(ngModel)]="it.faces" />
          <input type="number" min="1" class="input-field mono" style="font-size:12px" [(ngModel)]="it.qty" (ngModelChange)="touch()" />
          <input type="number" min="0" step="0.01" class="input-field mono" style="font-size:12px" [(ngModel)]="it.unitPrice" (ngModelChange)="touch()" title="Valor unitário" />
          <input type="number" min="0" step="0.01" class="input-field mono" style="font-size:12px" [(ngModel)]="it.discount" (ngModelChange)="touch()" title="Desconto (R$)" placeholder="desc." />
          <button class="btn-ghost" style="padding:3px;color:#C93636" (click)="rmPlanItem(i)" aria-label="Remover"><ax-icon name="x" [size]="13" /></button>
        </div>
      }
      <div style="display:grid;grid-template-columns:1fr 70px 90px 60px 100px 90px 28px;gap:6px;font-size:10.5px;color:#8696A7;margin:-2px 0 6px"><span></span><span>dente</span><span>faces (MODVLP)</span><span>qtd.</span><span>valor unit.</span><span>desconto</span><span></span></div>
      <button class="btn-ghost" style="font-size:12px" (click)="addPlanItem()"><ax-icon name="plus" [size]="12" /> Adicionar procedimento</button>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:14px;align-items:center;margin-top:8px;font-size:13px;flex-wrap:wrap">
      <span>Subtotal <b class="mono">{{ planSubtotal() | brl }}</b></span>
      <span style="display:flex;gap:6px;align-items:center">Desconto geral <input type="number" min="0" step="0.01" class="input-field mono" style="width:100px" [(ngModel)]="planForm.discount" (ngModelChange)="touch()" /></span>
      <span>Total <b class="mono" style="font-size:16px">{{ planTotal() | brl }}</b></span>
    </div>
    <label class="field-label" style="margin-top:8px">Observações (condições de pagamento, orientações)</label><textarea class="input-field" rows="2" [(ngModel)]="planForm.notes"></textarea>
    <div footer><button class="btn-secondary" (click)="planOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="savePlan()">Salvar plano</button></div>
  </ax-modal>

  <!-- Impressão do plano -->
  @if (printPlan(); as p) {
    <div id="receipt" class="print-only" style="padding:24px;font-family:Inter,Arial,sans-serif;font-size:12px;color:#000;width:100%">
      <div style="font-size:16px;font-weight:700">{{ auth.me()?.company?.trade_name || auth.me()?.company?.name }}</div>
      <div style="margin:4px 0 12px">Plano de tratamento nº {{ p.number }} — {{ data()?.customer?.name }} — {{ p.created_at | dt }}</div>
      <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4"><tr><th align="left">Procedimento</th><th>Dente</th><th>Qtd.</th><th align="right">Valor</th></tr>
        @for (i of p.items; track i.id) { @if (i.status !== 'cancelado') { <tr><td>{{ i.name }}</td><td align="center">{{ i.tooth || '' }} {{ i.faces?.join('') }}</td><td align="center">{{ i.qty }}</td><td align="right">{{ i.total | brl }}</td></tr> } }
        <tr><td colspan="3" align="right"><b>Total</b></td><td align="right"><b>{{ p.total | brl }}</b></td></tr></table>
      @if (p.notes) { <p>{{ p.notes }}</p> }
      <p>Válido até {{ p.valid_until | dt }}. Profissional: {{ p.professional || '—' }}.</p>
      <p style="margin-top:40px">______________________________________<br />Assinatura do {{ auth.term('cliente').toLowerCase() }} (aprovação)</p>
    </div>
  }`,
})
export class FichaPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); private route = inject(ActivatedRoute); readonly lk = inject(LookupsService);
  id = ''; readonly data = signal<any>(null); readonly tab = signal('historico');
  readonly kinds = KINDS; readonly conditions = CONDITIONS; readonly faces = FACES; readonly up = UP; readonly low = LOW; readonly upD = UP_D; readonly lowD = LOW_D;
  readonly tabs = computed(() => {
    const t: [string, string][] = [['historico', 'Histórico'], ['anamnese', this.auth.term('prontuario') === 'Ficha técnica' ? 'Ficha / anamnese' : 'Anamnese']];
    if (this.auth.has('odontograma')) t.push(['odontograma', 'Odontograma'], ['planos', 'Planos de tratamento']);
    if (this.auth.has('pacotes')) t.push(['pacotes', 'Pacotes']);
    t.push(['atendimentos', this.auth.term('atendimentos')]);
    return t;
  });
  async ngOnInit() {
    this.id = this.route.snapshot.paramMap.get('id') || '';
    const t = this.route.snapshot.queryParamMap.get('aba'); if (t) this.tab.set(t);
    this.lk.ensure();
    await this.load();
    try { this.templates.set(await this.api.get<any[]>('/clinical/templates')); this.tplId = this.data()?.anamnese?.data?.template || this.templates()[0]?.id || ''; this.pickTpl(); } catch { /* */ }
    try { const r: any = await this.api.get('/services', { kind: 'servico', size: 500 }); this.services.set(r.items); } catch { /* */ }
    if (this.tab() === 'odontograma') this.loadOdo();
    if (this.tab() === 'planos') this.loadPlans();
  }
  async load() { try { this.data.set(await this.api.get(`/customers/${this.id}/clinical`)); } catch (e) { this.toast.error(e); } }
  setTab(t: string) { this.tab.set(t); if (t === 'odontograma') this.loadOdo(); if (t === 'planos') this.loadPlans(); }
  age(b: string) { const d = new Date(b + 'T12:00:00Z'), n = new Date(); let a = n.getFullYear() - d.getUTCFullYear(); if (n.getMonth() < d.getUTCMonth() || (n.getMonth() === d.getUTCMonth() && n.getDate() < d.getUTCDate())) a--; return a; }
  kl(k: string) { return KIND_LABEL[k] ?? k; }
  svc(a: any) { return (a.services ?? []).map((s: any) => s.name).join(', '); }
  apptBadge(s: string) { return 'badge ' + (APPT_STATUS[s]?.[1] ?? 'badge-muted'); }
  apptLabel(s: string) { return APPT_STATUS[s]?.[0] ?? s; }
  planBadge(s: string) { return 'badge ' + (PLAN_STATUS[s]?.[1] ?? 'badge-muted'); }
  planLabel(s: string) { return PLAN_STATUS[s]?.[0] ?? s; }

  // ---------- registros ----------
  rKind = 'evolucao'; rTitle = ''; rContent = ''; rAppt = ''; readonly amending = signal<any>(null);
  amend(r: any) { this.amending.set(r); this.rKind = r.kind; this.rTitle = r.title ? 'Adendo: ' + r.title : 'Adendo'; window.scrollTo({ top: 0, behavior: 'smooth' }); }
  async saveRecord() {
    if (!this.rContent.trim()) { this.toast.error('Descreva o registro.'); return; }
    try {
      await this.api.post(`/customers/${this.id}/clinical-records`, { kind: this.rKind, title: this.rTitle || undefined, content: this.rContent, appointmentId: this.rAppt || undefined, amendsId: this.amending()?.id });
      this.rContent = ''; this.rTitle = ''; this.rAppt = ''; this.amending.set(null); this.toast.success('Registrado.'); this.load();
    } catch (e) { this.toast.error(e); }
  }

  // ---------- anamnese ----------
  readonly templates = signal<any[]>([]); tplId = ''; answers: Record<string, any> = {}; aNotes = ''; consent = false;
  readonly tplFields = signal<any[]>([]);
  pickTpl() {
    const t = this.templates().find((x) => x.id === this.tplId); this.tplFields.set(t?.fields ?? []);
    const last = this.data()?.anamnese;
    this.answers = last?.data?.template === this.tplId ? { ...(last.data.answers ?? {}) } : {};
  }
  anamneseSummary(r: any) {
    const t = this.templates().find((x) => x.id === r.data?.template); const a = r.data?.answers ?? {};
    const parts = (t?.fields ?? []).filter((f: any) => a[f.key] !== undefined && a[f.key] !== '' && a[f.key] !== null).map((f: any) => `${f.label.replace(/\?.*$/, '')}: ${a[f.key] === true ? 'sim' : a[f.key] === false ? 'não' : a[f.key]}`);
    return (t ? t.name + ' — ' : '') + (parts.join(' · ') || 'sem respostas') + (r.data?.consentimento ? ' · consentimento registrado' : '');
  }
  async saveAnamnese() {
    try {
      await this.api.post(`/customers/${this.id}/clinical-records`, { kind: 'anamnese', title: this.templates().find((x) => x.id === this.tplId)?.name, content: this.aNotes || undefined,
        data: { template: this.tplId, consentimento: true, consentimentoEm: new Date().toISOString(), answers: this.answers } });
      this.toast.success('Anamnese salva.'); this.consent = false; this.aNotes = ''; await this.load(); this.tab.set('historico');
    } catch (e) { this.toast.error(e); }
  }

  // ---------- odontograma ----------
  readonly odo = signal<any>(null); readonly tooth = signal<number | null>(null); deciduous = false; tCond = 'carie'; tFaces: string[] = []; tStatus = 'existente'; tNotes = '';
  async loadOdo() { try { this.odo.set(await this.api.get(`/customers/${this.id}/odontogram`)); } catch (e) { this.toast.error(e); } }
  cur(t: number) { return (this.odo()?.current ?? []).find((x: any) => x.tooth === t) ?? null; }
  color(t: number) { const c = this.cur(t); return c ? (COND[c.condition]?.[2] ?? '#fff') : '#fff'; }
  title(t: number) { const c = this.cur(t); return c ? `${t}: ${COND[c.condition]?.[1]} (${c.status})${c.notes ? ' — ' + c.notes : ''}` : `${t}: sem registro`; }
  condLabel(c: string) { return COND[c]?.[1] ?? c; }
  openTooth(t: number) { const c = this.cur(t); this.tCond = c?.condition ?? 'carie'; this.tFaces = [...(c?.faces ?? [])]; this.tStatus = c?.status ?? 'existente'; this.tNotes = ''; this.tooth.set(t); }
  toggleFace(f: string) { this.tFaces = this.tFaces.includes(f) ? this.tFaces.filter((x) => x !== f) : [...this.tFaces, f]; }
  async saveTooth() {
    try { await this.api.post(`/customers/${this.id}/odontogram`, { entries: [{ tooth: this.tooth(), faces: this.tFaces, condition: this.tCond, status: this.tStatus, notes: this.tNotes || undefined }] }); this.tooth.set(null); this.loadOdo(); }
    catch (e) { this.toast.error(e); }
  }

  // ---------- planos ----------
  readonly plans = signal<any[]>([]); readonly services = signal<any[]>([]); readonly planOpen = signal(false); readonly planItems = signal<any[]>([]); readonly rev = signal(0);
  readonly printPlan = signal<any>(null);
  planForm: any = {};
  async loadPlans() {
    try {
      const list: any = await this.api.get('/treatment-plans', { customer: this.id, size: 50 });
      this.plans.set(await Promise.all(list.items.map((p: any) => this.api.get(`/treatment-plans/${p.id}`))));
    } catch (e) { this.toast.error(e); }
  }
  unbilled(p: any) { return p.items.filter((i: any) => i.status !== 'cancelado' && !i.sale_id).reduce((s: number, i: any) => s + Number(i.total), 0); }
  openPlan(p: any) {
    if (p) {
      this.planForm = { id: p.id, number: p.number, title: p.title || '', professionalId: p.professional_id, validUntil: p.valid_until?.slice(0, 10), notes: p.notes || '', discount: 0 };
      this.planItems.set(p.items.filter((i: any) => i.status !== 'cancelado').map((i: any) => ({ productId: i.product_id, tooth: i.tooth, faces: (i.faces || []).join(''), qty: i.qty, unitPrice: Number(i.unit_price), discount: Number(i.discount), description: i.description })));
    } else {
      this.planForm = { title: '', professionalId: this.lk.data()?.professionals?.find((x) => x.user_id === this.auth.me()?.user.id)?.id ?? null, validUntil: addDaysIso(todayIso(), 30), notes: '', discount: 0 };
      this.planItems.set([{ productId: '', tooth: null, faces: '', qty: 1, unitPrice: null, discount: 0 }]);
    }
    this.planOpen.set(true);
  }
  touch() { this.rev.update((x) => x + 1); }
  pickPlanSvc(i: number, id: string) { const s = this.services().find((x) => x.id === id); const l = [...this.planItems()]; l[i] = { ...l[i], productId: id, unitPrice: s ? Number(s.sale_price) : null }; this.planItems.set(l); }
  addPlanItem() { this.planItems.update((l) => [...l, { productId: '', tooth: null, faces: '', qty: 1, unitPrice: null, discount: 0 }]); }
  rmPlanItem(i: number) { this.planItems.update((l) => l.filter((_, k) => k !== i)); }
  readonly planSubtotal = computed(() => { this.rev(); return this.planItems().reduce((s, i) => s + Number(i.unitPrice || 0) * Number(i.qty || 1) - Number(i.discount || 0), 0); });
  readonly planTotal = computed(() => { this.rev(); return Math.max(0, this.planSubtotal() - Number(this.planForm.discount || 0)); });
  async savePlan() {
    const items = this.planItems().filter((i) => i.productId).map((i) => ({ productId: i.productId, tooth: i.tooth ? Number(i.tooth) : null, faces: String(i.faces || '').toUpperCase().split('').filter((f) => 'MDOIVLP'.includes(f)),
      qty: Number(i.qty || 1), unitPrice: i.unitPrice === null || i.unitPrice === '' ? undefined : Number(i.unitPrice), discount: Number(i.discount || 0) || undefined, description: i.description || undefined }));
    if (!items.length) { this.toast.error('Inclua pelo menos um procedimento.'); return; }
    const body = { customerId: this.id, professionalId: this.planForm.professionalId || null, title: this.planForm.title || undefined, notes: this.planForm.notes || undefined, validUntil: this.planForm.validUntil || undefined, discount: Number(this.planForm.discount || 0) || undefined, items };
    try {
      if (this.planForm.id) await this.api.put(`/treatment-plans/${this.planForm.id}`, body); else await this.api.post('/treatment-plans', body);
      this.toast.success('Plano salvo.'); this.planOpen.set(false); this.loadPlans();
    } catch (e) { this.toast.error(e); }
  }
  async planStatus(p: any, status: string) {
    let reason: string | undefined;
    if (status === 'recusado' || status === 'cancelado') { reason = prompt('Motivo:') ?? undefined; if (reason === undefined) return; }
    try { await this.api.post(`/treatment-plans/${p.id}/status`, { status, reason }); this.toast.success('Plano atualizado.'); this.loadPlans(); } catch (e) { this.toast.error(e); }
  }
  async itemAction(i: any, action: 'done' | 'cancel') {
    if (action === 'cancel' && !confirm('Cancelar este procedimento do plano?')) return;
    try { await this.api.post(`/treatment-plans/items/${i.id}/${action}`, {}); this.loadPlans(); } catch (e) { this.toast.error(e); }
  }
  schedule(p: any, i: any) { this.router.navigate(['/agenda'], { queryParams: { cliente: this.id, servico: i.product_id, planoItem: i.id, profissional: i.professional_id || p.professional_id || undefined } }); }
  print(p: any) { this.printPlan.set(p); document.body.classList.add('printing-receipt'); setTimeout(() => { window.print(); document.body.classList.remove('printing-receipt'); this.printPlan.set(null); }, 80); }
}
