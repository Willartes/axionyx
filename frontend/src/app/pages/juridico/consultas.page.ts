import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

/** Consultas encaminhadas ao jurídico a partir da AXIA (pergunta + pré-análise da IA + documentos usados). */
@Component({
  selector: 'ax-consultas-juridicas',
  imports: [FormsModule, IconComponent, ModalComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .box { font-size:13px; line-height:1.6; white-space:pre-line; background:#F8FAFC; border:1px solid #E3EAF1; border-radius:8px; padding:12px 14px; color:#172B3A; }
    .lbl { font-size:11px; font-weight:600; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin:12px 0 6px; display:block; }
    .seg { display:inline-flex; border:1px solid #DCE4EC; border-radius:8px; overflow:hidden; background:white; }
    .seg button { border:0; background:transparent; padding:7px 12px; font-size:12px; cursor:pointer; color:#3A4D5E; } .seg button.on { background:#0875D1; color:white; }
  `],
  template: `
  <div style="padding:24px;max-width:1100px;display:flex;flex-direction:column;gap:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="scale" [size]="20" color="#0875D1" /> Consultas ao jurídico</h1>
        <p style="font-size:13px;color:#647687;margin-top:4px">{{ d()?.seesAll ? 'Dúvidas encaminhadas pela equipe, com a pré-análise da IA e os documentos consultados.' : 'As dúvidas que você encaminhou ao jurídico e as respostas.' }} Para abrir uma nova, use a AXIA no modo "Consulta jurídica".</p></div>
      <div class="seg">@for (f of filters; track f[0]) { <button [class.on]="status() === f[0]" (click)="setStatus(f[0])">{{ f[1] }}@if (f[0] === 'aberta' && d()?.stats?.open) { ({{ d().stats.open }}) }</button> }</div>
    </div>
    <ax-state [loading]="!d()" [empty]="!!d() && !d().items.length" emptyText="Nenhuma consulta por aqui." emptyIcon="scale" />
    @if (d()?.items.length) {
      <div class="card" style="overflow:hidden"><div style="overflow-x:auto">
        <table class="data-table" style="width:100%;border-collapse:collapse;min-width:640px">
          <thead><tr><th>Nº</th><th>Pergunta</th><th>Quem perguntou</th><th>Data</th><th>Situação</th></tr></thead>
          <tbody>@for (c of d().items; track c.id) {
            <tr style="cursor:pointer" (click)="open(c.id)"><td class="mono">{{ c.number }}</td><td style="max-width:440px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ c.question }}</div></td>
              <td>{{ c.asked_by_name }}</td><td class="mono" style="font-size:12px">{{ c.created_at | dt }}</td>
              <td><span class="badge" [class]="c.status === 'respondida' ? 'badge badge-success' : c.status === 'aberta' ? 'badge badge-warning' : 'badge badge-muted'">{{ label(c.status) }}</span></td></tr>
          }</tbody>
        </table></div></div>
    }
  </div>
  <ax-modal [(open)]="modal" [title]="sel() ? 'Consulta nº ' + sel().number : ''" icon="scale" [width]="760">
    @if (sel(); as c) {
      <div style="font-size:12px;color:#647687">{{ c.asked_by_name }} · {{ c.created_at | dtt }} · <span class="badge" [class]="c.status === 'respondida' ? 'badge badge-success' : 'badge badge-warning'">{{ label(c.status) }}</span></div>
      <span class="lbl">Pergunta</span><div class="box">{{ c.question }}</div>
      @if (c.notes) { <span class="lbl">Observações de quem perguntou</span><div class="box">{{ c.notes }}</div> }
      @if (c.ai_answer) { <span class="lbl">Pré-análise da IA{{ c.ai_provider ? ' (' + c.ai_provider + ')' : '' }}</span><div class="box" style="background:#F4F9FF;border-color:#C8DFEF">{{ c.ai_answer }}</div> }
      @if (c.sources?.length) { <span class="lbl">Fontes consultadas</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">@for (s of c.sources; track $index) { <button class="btn-ghost" style="font-size:12px;border:1px solid #DCE4EC" (click)="goSource(s)"><ax-icon [name]="s.type === 'documento' ? 'file-text' : 'external-link'" [size]="12" /> {{ s.type === 'documento' ? s.name + (s.page ? ', p. ' + s.page : '') : s.label }}</button> }</div> }
      <span class="lbl">Resposta do jurídico</span>
      @if (d()?.canRespond) {
        <textarea class="input-field" rows="6" [(ngModel)]="response" placeholder="Escreva a orientação do jurídico..."></textarea>
      } @else if (c.response) { <div class="box" style="background:#EEF8F2;border-color:#BFE3CC">{{ c.response }}</div><div class="muted" style="font-size:11px;margin-top:4px">{{ c.responded_by_name }} · {{ c.responded_at | dtt }}</div> }
      @else { <div class="muted" style="font-size:13px">Aguardando resposta do jurídico.</div> }
    }
    <div footer style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      @if (d()?.canRespond && sel()) {
        @if (sel().status !== 'arquivada') { <button class="btn-ghost" (click)="update({ status: 'arquivada' })">Arquivar</button> }
        <button class="btn-primary" [disabled]="!response.trim() || busy()" (click)="update({ response })"><ax-icon name="send" [size]="13" /> Responder</button>
      } @else { <button class="btn-secondary" (click)="modal = false">Fechar</button> }
    </div>
  </ax-modal>`,
})
export class ConsultasJuridicasPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); private router = inject(Router);
  readonly filters = [['aberta', 'Abertas'], ['respondida', 'Respondidas'], ['', 'Todas']] as const;
  readonly d = signal<any>(null); readonly sel = signal<any>(null); readonly status = signal<string>('aberta'); readonly busy = signal(false);
  modal = false; response = '';
  async ngOnInit() { await this.load(); if (this.d()?.items.length === 0 && this.status() === 'aberta') { this.status.set(''); await this.load(); } }
  async load() { this.d.set(await this.api.get('/legal-consultations', { status: this.status() || undefined })); }
  setStatus(s: string) { this.status.set(s); this.d.set(null); this.load(); }
  label(s: string) { return s === 'aberta' ? 'Aberta' : s === 'respondida' ? 'Respondida' : 'Arquivada'; }
  async open(id: string) { const c = await this.api.get<any>(`/legal-consultations/${id}`); this.sel.set(c); this.response = c.response ?? ''; this.modal = true; }
  async update(body: any) { this.busy.set(true); try { await this.api.put(`/legal-consultations/${this.sel().id}`, body); this.toast.success(body.response ? 'Resposta enviada.' : 'Consulta arquivada.'); this.modal = false; await this.load(); } catch (e) { this.toast.error(e); } finally { this.busy.set(false); } }
  goSource(s: any) { this.modal = false; this.router.navigateByUrl(s.type === 'documento' ? '/documentos' : '/' + s.link); }
}
