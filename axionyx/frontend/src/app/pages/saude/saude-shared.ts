import { ChangeDetectionStrategy, Component, OnChanges, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';
import { LookupsService } from '../../core/lookups.service';

export const COUNCILS = ['CRM', 'CRP', 'CREFITO', 'CRN', 'CRFa', 'COREN', 'CRO', 'CREF', 'CRF', 'CRBM', 'COFFITO', 'CRTO', 'CRESS', 'Outro'];
export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
export const SPECIALTIES = ['Clínica médica', 'Medicina de família', 'Cardiologia', 'Dermatologia', 'Endocrinologia', 'Gastroenterologia', 'Geriatria', 'Ginecologia e obstetrícia', 'Neurologia',
  'Oftalmologia', 'Ortopedia', 'Otorrinolaringologia', 'Pediatria', 'Psiquiatria', 'Urologia', 'Psicologia', 'Fisioterapia', 'Nutrição', 'Fonoaudiologia', 'Enfermagem', 'Terapia ocupacional',
  'Odontologia', 'Educação física', 'Farmácia clínica', 'Biomedicina', 'Acupuntura', 'Podologia', 'Psicopedagogia'];
export const PAYERS: Record<string, string> = { particular: 'Particular', convenio: 'Convênio', cortesia: 'Cortesia / sem custo' };
export const VISIT_TYPES: Record<string, string> = { primeira: 'Primeira consulta', retorno: 'Retorno', sessao: 'Sessão', procedimento: 'Procedimento', exame: 'Exame', teleconsulta: 'Teleconsulta' };
export const CLAIM_STATUS: Record<string, [string, string]> = {
  a_faturar: ['A faturar', 'badge-warning'], enviado: ['Enviada', 'badge-info'], pago: ['Paga', 'badge-success'], glosado: ['Glosada', 'badge-danger'], cancelado: ['Cancelada', 'badge-muted'],
};
export const BATCH_STATUS: Record<string, [string, string]> = { enviado: ['Aguardando pagamento', 'badge-info'], pago_parcial: ['Pago parcialmente', 'badge-warning'], pago: ['Concluído', 'badge-success'], cancelado: ['Cancelado', 'badge-muted'] };
export const DOC_KINDS: [string, string, string][] = [
  ['receita', 'Receituário', 'pill'], ['atestado', 'Atestado', 'file-check'], ['declaracao', 'Declaração de comparecimento', 'calendar-check'], ['exames', 'Solicitação de exames', 'test-tube'],
  ['encaminhamento', 'Encaminhamento', 'send'], ['laudo', 'Relatório / laudo', 'file-text'], ['orientacoes', 'Orientações', 'list-checks'], ['consentimento', 'Termo de consentimento', 'file-signature'],
];
export const DOC_LABEL: Record<string, string> = Object.fromEntries(DOC_KINDS.map((d) => [d[0], d[1]]));
export const VITALS: [string, string, string][] = [
  ['pas', 'PA sistólica', 'mmHg'], ['pad', 'PA diastólica', 'mmHg'], ['fc', 'Freq. cardíaca', 'bpm'], ['fr', 'Freq. respiratória', 'irpm'], ['temp', 'Temperatura', '°C'], ['spo2', 'SpO₂', '%'],
  ['peso', 'Peso', 'kg'], ['altura', 'Altura', 'cm'], ['cintura', 'Cintura', 'cm'], ['glicemia', 'Glicemia', 'mg/dL'], ['dor', 'Dor (0–10)', ''],
];
export function vitalsText(v: any): string {
  if (!v) return '';
  const p: string[] = [];
  if (v.pas && v.pad) p.push(`PA ${v.pas}/${v.pad} mmHg`);
  for (const [k, l, u] of VITALS) if (!['pas', 'pad'].includes(k) && v[k] !== undefined && v[k] !== null) p.push(`${l} ${String(v[k]).replace('.', ',')}${u ? ' ' + u : ''}`);
  if (v.imc) p.push(`IMC ${String(v.imc).replace('.', ',')}`);
  return p.join(' · ');
}
export function ageOf(b?: string | null) {
  if (!b) return null; const d = new Date(String(b).slice(0, 10) + 'T12:00:00Z'), n = new Date(); let a = n.getFullYear() - d.getUTCFullYear();
  if (n.getMonth() < d.getUTCMonth() || (n.getMonth() === d.getUTCMonth() && n.getDate() < d.getUTCDate())) a--; return a;
}
export function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const csv = '﻿' + rows.map((r) => r.map((c) => { const s = c === null || c === undefined ? '' : String(c); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Perfil de saúde do paciente: convênio, responsável, contato de emergência e (só para profissionais) alergias, condições e medicamentos. */
@Component({
  selector: 'ax-patient-profile',
  imports: [FormsModule, IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (loaded()) {
    <div class="card" style="padding:16px">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px;display:flex;gap:6px;align-items:center"><ax-icon name="id-card" [size]="15" color="#0875D1" /> Identificação e convênio</div>
      <div class="grid-3-resp" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">
        <div><label class="field-label">Nome social</label><input class="input-field" [(ngModel)]="f.socialName" placeholder="Como prefere ser chamado(a)" /></div>
        <div><label class="field-label">Cartão Nacional de Saúde (CNS)</label><input class="input-field mono" [(ngModel)]="f.cns" maxlength="15" /></div>
        <div><label class="field-label">Convênio</label><select class="input-field" [(ngModel)]="f.insurerId"><option [ngValue]="null">Particular (sem convênio)</option>@for (i of insurers(); track i.id) { <option [ngValue]="i.id">{{ i.name }}</option> }</select></div>
        <div><label class="field-label">Plano</label><input class="input-field" [(ngModel)]="f.insurancePlan" [disabled]="!f.insurerId" /></div>
        <div><label class="field-label">Nº da carteirinha</label><input class="input-field mono" [(ngModel)]="f.insuranceCard" [disabled]="!f.insurerId" /></div>
        <div><label class="field-label">Validade da carteirinha</label><input type="date" class="input-field" [(ngModel)]="f.insuranceValidUntil" [disabled]="!f.insurerId" /></div>
      </div>
      <div style="font-size:13px;font-weight:600;margin:16px 0 10px;display:flex;gap:6px;align-items:center"><ax-icon name="users" [size]="15" color="#0875D1" /> Responsável legal e emergência</div>
      <div class="grid-3-resp" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">
        <div><label class="field-label">Responsável (menor ou tutelado)</label><input class="input-field" [(ngModel)]="f.guardianName" /></div>
        <div><label class="field-label">CPF do responsável</label><input class="input-field mono" [(ngModel)]="f.guardianDoc" /></div>
        <div><label class="field-label">Parentesco</label><input class="input-field" [(ngModel)]="f.guardianRelation" placeholder="mãe, pai, tutor…" /></div>
        <div><label class="field-label">Contato de emergência</label><input class="input-field" [(ngModel)]="f.emergencyName" /></div>
        <div><label class="field-label">Telefone de emergência</label><input class="input-field mono" [(ngModel)]="f.emergencyPhone" /></div>
      </div>
      @if (clinical()) {
        <div style="font-size:13px;font-weight:600;margin:16px 0 10px;display:flex;gap:6px;align-items:center"><ax-icon name="heart-pulse" [size]="15" color="#C93636" /> Informações clínicas permanentes <span class="muted" style="font-weight:400;font-size:11.5px">(visíveis só para profissionais de saúde)</span></div>
        <div class="grid-2-resp" style="display:grid;grid-template-columns:140px minmax(0,1fr);gap:10px">
          <div><label class="field-label">Tipo sanguíneo</label><select class="input-field" [(ngModel)]="f.bloodType" [disabled]="!auth.can('prontuario.editar')"><option [ngValue]="null">—</option>@for (b of blood; track b) { <option [value]="b">{{ b }}</option> }</select></div>
          <div><label class="field-label">Alergias</label><input class="input-field" [(ngModel)]="f.allergies" [disabled]="!auth.can('prontuario.editar')" placeholder="Medicamentos, alimentos, látex… (aparece em destaque no prontuário)" /></div>
        </div>
        <div class="grid-2-resp" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-top:10px">
          <div><label class="field-label">Condições crônicas</label><textarea class="input-field" rows="2" [(ngModel)]="f.chronicConditions" [disabled]="!auth.can('prontuario.editar')"></textarea></div>
          <div><label class="field-label">Medicamentos em uso</label><textarea class="input-field" rows="2" [(ngModel)]="f.medications" [disabled]="!auth.can('prontuario.editar')"></textarea></div>
        </div>
      }
      @if (auth.can('clientes.editar')) { <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn-primary" style="font-size:12px" (click)="save()"><ax-icon name="save" [size]="13" /> Salvar</button></div> }
    </div>
  } @else { <div class="skeleton" style="height:180px"></div> }`,
})
export class PatientProfileComponent implements OnChanges {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly customerId = input.required<string>(); readonly saved = output<void>();
  readonly loaded = signal(false); readonly clinical = signal(false); readonly insurers = signal<any[]>([]);
  readonly blood = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  f: any = {}; private orig: any = {};
  async ngOnChanges() {
    try {
      const [r, ins]: any = await Promise.all([this.api.get(`/patients/${this.customerId()}/profile`), this.api.get('/insurers')]);
      const p = r.profile ?? {};
      this.f = { socialName: r.customer.social_name ?? '', cns: r.customer.cns ?? '', insurerId: p.insurer_id ?? null, insurancePlan: p.insurance_plan ?? '', insuranceCard: p.insurance_card ?? '',
        insuranceValidUntil: p.insurance_valid_until?.slice(0, 10) ?? '', guardianName: p.guardian_name ?? '', guardianDoc: p.guardian_doc ?? '', guardianRelation: p.guardian_relation ?? '',
        emergencyName: p.emergency_name ?? '', emergencyPhone: p.emergency_phone ?? '', bloodType: p.blood_type ?? null, allergies: p.allergies ?? '', chronicConditions: p.chronic_conditions ?? '', medications: p.medications ?? '' };
      this.orig = { ...this.f }; this.clinical.set(!!r.clinicalVisible); this.insurers.set(ins); this.loaded.set(true);
    } catch (e) { this.toast.error(e); }
  }
  async save() {
    const body: any = {};
    const clinicalKeys = ['bloodType', 'allergies', 'chronicConditions', 'medications'];
    for (const k of Object.keys(this.f)) {
      if (clinicalKeys.includes(k) && (!this.clinical() || !this.auth.can('prontuario.editar'))) continue;
      if (this.f[k] !== this.orig[k]) body[k] = this.f[k] === '' ? null : this.f[k];
    }
    if (!Object.keys(body).length) { this.toast.success('Nada a alterar.'); return; }
    try { await this.api.put(`/patients/${this.customerId()}/profile`, body); this.orig = { ...this.f }; this.toast.success('Dados do paciente salvos.'); this.saved.emit(); } catch (e) { this.toast.error(e); }
  }
}

/** Documentos clínicos do paciente: emissão pelo próprio profissional (receita, atestado, declaração, exames, encaminhamento, laudo, orientações, consentimento), impressão e cancelamento. */
@Component({
  selector: 'ax-clinical-docs',
  imports: [FormsModule, IconComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="no-print">
    @if (auth.can('prontuario.documentos')) {
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        @for (k of kinds; track k[0]) { <button class="btn-secondary" style="font-size:12px" (click)="openNew(k[0])"><ax-icon [name]="k[2]" [size]="13" /> {{ k[1] }}</button> }
      </div>
    }
    <div class="card" style="overflow:hidden">
      <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr><th>Nº</th><th>Documento</th><th>Emitido em</th><th>Profissional</th><th>Situação</th><th></th></tr></thead>
        <tbody>@for (d of docs(); track d.id) {
          <tr [style.opacity]="d.cancelled_at ? .55 : 1"><td class="mono">{{ d.number }}</td><td>{{ label(d.kind) }}@if (d.visibility === 'restrito') { <ax-icon name="lock" [size]="11" color="#7A4CC2" style="margin-left:4px" /> }</td>
            <td>{{ d.issued_at | dtt }}</td><td>{{ d.professional }}</td>
            <td>@if (d.cancelled_at) { <span class="badge badge-danger" [title]="d.cancel_reason || ''">Cancelado</span> } @else { <span class="badge badge-success">Válido</span> }</td>
            <td style="white-space:nowrap"><button class="btn-ghost" style="font-size:11px" (click)="print(d)"><ax-icon name="printer" [size]="12" /> Imprimir</button>
              @if (!d.cancelled_at && auth.can('prontuario.documentos')) { <button class="btn-ghost" style="font-size:11px;color:#C93636" (click)="cancel(d)">Cancelar</button> }</td></tr>
        } @empty { <tr><td colspan="6"><div class="empty-state">Nenhum documento emitido.</div></td></tr> }</tbody></table></div>
    </div>
    <p style="font-size:11px;color:#647687;margin-top:8px">Documentos são emitidos em nome do profissional logado, com o registro no conselho e um código de verificação de integridade. A impressão é para assinatura manuscrita (ou assinatura digital externa com certificado ICP-Brasil). Documentos não são apagados: o cancelamento fica registrado com o motivo.</p>
  </div>

  <ax-modal [open]="!!kind()" (closed)="kind.set(null)" [title]="label(kind() || '')" icon="file-text" [width]="680">
    @switch (kind()) {
      @case ('receita') {
        @for (it of items(); track $index; let i = $index) {
          <div style="display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1.4fr) 110px 28px;gap:6px;margin-bottom:6px" class="doc-row">
            <input class="input-field" [(ngModel)]="it.name" placeholder="Medicamento e concentração" />
            <input class="input-field" [(ngModel)]="it.dose" placeholder="Posologia (ex.: 1 cp de 8/8h por 7 dias)" />
            <input class="input-field" [(ngModel)]="it.qty" placeholder="Quantidade" />
            <button class="btn-ghost" style="padding:3px;color:#C93636" (click)="rm(i)" aria-label="Remover"><ax-icon name="x" [size]="13" /></button>
          </div>
        }
        <button class="btn-ghost" style="font-size:12px" (click)="add()"><ax-icon name="plus" [size]="12" /> Adicionar medicamento</button>
        <div class="state-info" style="font-size:11.5px;margin-top:8px;background:#F0F7FD;border:1px solid #CFE3F5;border-radius:8px;padding:8px 10px">Receituário simples. Medicamentos de controle especial (Portaria 344/98) exigem o receituário oficial próprio.</div>
      }
      @case ('exames') {
        @for (it of items(); track $index; let i = $index) {
          <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 28px;gap:6px;margin-bottom:6px" class="doc-row">
            <input class="input-field" [(ngModel)]="it.name" placeholder="Exame (ex.: Hemograma completo)" /><input class="input-field" [(ngModel)]="it.notes" placeholder="Observação / código" />
            <button class="btn-ghost" style="padding:3px;color:#C93636" (click)="rm(i)" aria-label="Remover"><ax-icon name="x" [size]="13" /></button>
          </div>
        }
        <button class="btn-ghost" style="font-size:12px" (click)="add()"><ax-icon name="plus" [size]="12" /> Adicionar exame</button>
        <label class="field-label" style="margin-top:8px">Indicação clínica</label><input class="input-field" [(ngModel)]="c.clinicalIndication" />
      }
      @case ('atestado') {
        <div style="display:grid;grid-template-columns:140px 140px;gap:10px"><div><label class="field-label">Dias de afastamento</label><input type="number" min="1" class="input-field mono" [(ngModel)]="c.days" /></div>
          <div><label class="field-label">A partir de</label><input type="date" class="input-field" [(ngModel)]="c.date" /></div></div>
        <div style="display:grid;grid-template-columns:140px minmax(0,1fr);gap:10px;margin-top:8px;align-items:end"><div><label class="field-label">CID (opcional)</label><input class="input-field mono" style="text-transform:uppercase" [(ngModel)]="c.cid" placeholder="ex.: J06.9" /></div>
          <label style="font-size:12px;display:flex;gap:6px;align-items:flex-start"><input type="checkbox" [(ngModel)]="c.cidConsent" style="margin-top:2px" /> O paciente autorizou expressamente a inclusão do CID no atestado.</label></div>
        <label class="field-label" style="margin-top:8px">Observação</label><input class="input-field" [(ngModel)]="c.text" />
      }
      @case ('declaracao') {
        <div style="display:grid;grid-template-columns:150px 110px 110px;gap:10px"><div><label class="field-label">Data</label><input type="date" class="input-field" [(ngModel)]="c.date" /></div>
          <div><label class="field-label">Das</label><input type="time" class="input-field" [(ngModel)]="c.startTime" /></div><div><label class="field-label">Até</label><input type="time" class="input-field" [(ngModel)]="c.endTime" /></div></div>
        <label class="field-label" style="margin-top:8px">Observação</label><input class="input-field" [(ngModel)]="c.text" placeholder="ex.: acompanhado(a) de responsável" />
      }
      @case ('encaminhamento') {
        <label class="field-label">Encaminhar para (especialidade ou serviço)</label><input class="input-field" [(ngModel)]="c.specialtyTo" list="ax-spec" />
        <datalist id="ax-spec">@for (s of specialties; track s) { <option [value]="s"></option> }</datalist>
        <label class="field-label" style="margin-top:8px">Motivo / resumo clínico</label><textarea class="input-field" rows="6" [(ngModel)]="c.text"></textarea>
      }
      @case ('consentimento') {
        <label class="field-label">Procedimento</label><input class="input-field" [(ngModel)]="c.procedure" />
        <label class="field-label" style="margin-top:8px">Texto do termo (riscos, benefícios, alternativas e cuidados)</label><textarea class="input-field" rows="9" [(ngModel)]="c.text"></textarea>
      }
      @default { <label class="field-label">Conteúdo</label><textarea class="input-field" rows="10" [(ngModel)]="c.text"></textarea> }
    }
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:12px">
      @if (appointments().length) { <select class="input-field" style="max-width:320px" [(ngModel)]="apptId"><option value="">Sem vínculo com atendimento</option>@for (a of appointments().slice(0, 10); track a.id) { <option [value]="a.id">{{ a.start_local.slice(0, 10) | dt }} {{ a.start_local.slice(11) }} · {{ a.professional }}</option> }</select> }
      <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" [(ngModel)]="restricted" /> <ax-icon name="lock" [size]="12" /> Sigiloso (só eu vejo)</label>
    </div>
    <div footer><button class="btn-secondary" (click)="kind.set(null)">Cancelar</button><button class="btn-primary" (click)="emit()"><ax-icon name="check" [size]="13" /> Emitir e imprimir</button></div>
  </ax-modal>

  @if (printing(); as d) {
    <div id="receipt" class="print-only" style="padding:28px 32px;font-family:Inter,Arial,sans-serif;font-size:12.5px;color:#000;width:100%;line-height:1.5">
      <div style="display:flex;justify-content:space-between;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:16px">
        <div><div style="font-size:16px;font-weight:700">{{ d.company_trade || d.company_name }}</div>
          <div style="font-size:11px">{{ addr(d.company_address) }}{{ d.company_phone ? ' · ' + (d.company_phone | phone) : '' }}{{ d.company_cnpj ? ' · CNPJ ' + (d.company_cnpj | doc) : '' }}</div></div>
        <div style="text-align:right;font-size:11px">Nº {{ d.number }}<br />{{ d.issued_at | dt }}</div>
      </div>
      <div style="text-align:center;font-size:15px;font-weight:700;letter-spacing:.04em;margin-bottom:14px;text-transform:uppercase">{{ d.label }}{{ d.cancelled_at ? ' — CANCELADO' : '' }}</div>
      <div style="margin-bottom:12px"><b>Paciente:</b> {{ d.social_name ? d.social_name + ' (' + d.patient + ')' : d.patient }}{{ d.birth_date ? ' · nascimento ' + (d.birth_date | dt) : '' }}{{ d.cpf_cnpj ? ' · CPF ' + (d.cpf_cnpj | doc) : '' }}{{ d.cns ? ' · CNS ' + d.cns : '' }}</div>
      @switch (d.kind) {
        @case ('receita') { <ol style="padding-left:18px">@for (it of d.content.items; track $index) { <li style="margin-bottom:10px"><b>{{ it.name }}</b>{{ it.qty ? ' — ' + it.qty : '' }}<br />{{ it.dose }}</li> }</ol> }
        @case ('exames') { <p>Solicito:</p><ul style="padding-left:18px">@for (it of d.content.items; track $index) { <li>{{ it.name }}{{ it.notes ? ' — ' + it.notes : '' }}</li> }</ul>
          @if (d.content.clinicalIndication) { <p><b>Indicação clínica:</b> {{ d.content.clinicalIndication }}</p> } }
        @case ('atestado') { <p>Atesto, para os devidos fins, que o(a) paciente acima foi atendido(a) nesta data e necessita de <b>{{ d.content.days }} ({{ ext(d.content.days) }}) dia(s)</b> de afastamento de suas atividades{{ d.content.date ? ' a partir de ' + (d.content.date | dt) : '' }}.</p>
          @if (d.content.cid) { <p>CID: {{ d.content.cid }} (incluído com autorização do paciente).</p> } @if (d.content.text) { <p>{{ d.content.text }}</p> } }
        @case ('declaracao') { <p>Declaro, para os devidos fins, que o(a) paciente acima esteve presente neste estabelecimento em {{ (d.content.date || d.issued_at.slice(0, 10)) | dt }}{{ d.content.startTime ? ', das ' + d.content.startTime : '' }}{{ d.content.endTime ? ' às ' + d.content.endTime : '' }}, para atendimento.</p>
          @if (d.content.text) { <p>{{ d.content.text }}</p> } }
        @case ('encaminhamento') { <p>Encaminho o(a) paciente para <b>{{ d.content.specialtyTo || 'avaliação especializada' }}</b>.</p><p style="white-space:pre-wrap">{{ d.content.text }}</p> }
        @case ('consentimento') { <p><b>Procedimento:</b> {{ d.content.procedure }}</p><p style="white-space:pre-wrap">{{ d.content.text }}</p>
          <p style="margin-top:28px">Declaro que recebi as informações acima, tive a oportunidade de esclarecer minhas dúvidas e autorizo a realização do procedimento.</p>
          <p style="margin-top:36px">______________________________________<br />Assinatura do paciente ou responsável</p> }
        @default { <p style="white-space:pre-wrap">{{ d.content.text }}</p> }
      }
      <div style="margin-top:56px;text-align:center">______________________________________<br /><b>{{ d.professional }}</b><br />{{ d.council_id || '' }}{{ d.rqe ? ' · RQE ' + d.rqe : '' }}{{ d.specialty ? ' · ' + d.specialty : '' }}</div>
      <div style="margin-top:28px;font-size:9.5px;color:#444;border-top:1px solid #999;padding-top:6px">Documento nº {{ d.number }} emitido em {{ d.issued_at | dtt }} · código de verificação {{ d.verification }}. Válido com a assinatura do profissional.</div>
    </div>
  }`,
})
export class ClinicalDocsComponent implements OnChanges {
  private lk = inject(LookupsService); private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly customerId = input.required<string>(); readonly appointments = input<any[]>([]);
  readonly docs = signal<any[]>([]); readonly kind = signal<string | null>(null); readonly items = signal<any[]>([]); readonly printing = signal<any>(null);
  readonly kinds = DOC_KINDS; readonly specialties = SPECIALTIES;
  c: any = {}; apptId = ''; restricted = false;
  label(k: string) { return DOC_LABEL[k] ?? k; }
  async ngOnChanges() { this.load(); }
  async load() { try { this.docs.set(await this.api.get(`/customers/${this.customerId()}/clinical-documents`)); } catch (e) { this.toast.error(e); } }
  openNew(k: string) {
    const today = new Date().toISOString().slice(0, 10);
    this.c = { date: today, days: k === 'atestado' ? 1 : undefined }; this.apptId = this.appointments()[0]?.id ?? '';
    this.restricted = !!this.lk.data()?.professionals?.find((x) => x.user_id === this.auth.me()?.user.id)?.restrict_records;
    this.items.set([{ name: '', dose: '', qty: '', notes: '' }]); this.kind.set(k);
  }
  add() { this.items.update((l) => [...l, { name: '', dose: '', qty: '', notes: '' }]); }
  rm(i: number) { this.items.update((l) => l.filter((_, k) => k !== i)); }
  async emit() {
    const k = this.kind()!; const content: any = {};
    for (const [key, val] of Object.entries(this.c)) if (val !== '' && val !== null && val !== undefined) content[key] = val;
    if (k === 'receita' || k === 'exames') content.items = this.items().filter((i) => i.name?.trim()).map((i) => Object.fromEntries(Object.entries(i).filter(([, v]) => v)));
    if (content.days) content.days = Number(content.days);
    if (content.cid) content.cid = String(content.cid).trim().toUpperCase();
    try {
      const d: any = await this.api.post(`/customers/${this.customerId()}/clinical-documents`, { kind: k, content, appointmentId: this.apptId || undefined, visibility: this.restricted ? 'restrito' : 'equipe' });
      this.kind.set(null); this.toast.success('Documento emitido.'); await this.load(); this.print(d);
    } catch (e) { this.toast.error(e); }
  }
  async print(d: any) {
    try {
      const full = await this.api.get(`/clinical-documents/${d.id}`); this.printing.set(full);
      document.body.classList.add('printing-receipt');
      setTimeout(() => { window.print(); document.body.classList.remove('printing-receipt'); this.printing.set(null); }, 120);
    } catch (e) { this.toast.error(e); }
  }
  async cancel(d: any) {
    const reason = prompt('Motivo do cancelamento do documento nº ' + d.number + ':'); if (!reason) return;
    try { await this.api.post(`/clinical-documents/${d.id}/cancel`, { reason }); this.toast.success('Documento cancelado (mantido no histórico).'); this.load(); } catch (e) { this.toast.error(e); }
  }
  addr(a: any) { if (!a || typeof a !== 'object') return ''; return [a.street && (a.street + (a.number ? ', ' + a.number : '')), a.district, a.city && (a.city + (a.state ? '/' + a.state : ''))].filter(Boolean).join(' · '); }
  ext(n: number) { const w = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze']; return w[n] ?? String(n); }
}
