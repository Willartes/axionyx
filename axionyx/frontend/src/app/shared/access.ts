import { ChangeDetectionStrategy, Component, Injectable, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from './icon.component';
import { ModalComponent } from './ui';
import { Api } from '../core/api.service';
import { ToastService } from '../core/toast.service';

/** Disponibilidade do envio de convites por e-mail (carregada uma vez por sessão). */
@Injectable({ providedIn: 'root' })
export class EmailStatusService {
  private api = inject(Api);
  readonly status = signal<{ available: boolean; provider: string | null; hours: number } | null>(null);
  private loading: Promise<void> | null = null;
  ensure() { return (this.loading ??= this.api.get<any>('/email/status').then((s) => this.status.set(s)).catch(() => this.status.set({ available: false, provider: null, hours: 48 }))); }
  available() { return !!this.status()?.available; }
}

export type AccessDelivery = 'email' | 'senha' | 'manual';

/** Escolha de como o novo usuário recebe o acesso (link por e-mail, senha temporária ou senha definida agora). */
@Component({
  selector: 'ax-access-choice',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <label class="field-label">Como a pessoa vai receber o acesso</label>
  <div style="display:flex;flex-direction:column;gap:6px">
    <label class="opt" [class.dis]="!es.available()"><input type="radio" name="axdel" value="email" [disabled]="!es.available()" [ngModel]="delivery()" (ngModelChange)="delivery.set($event)" />
      <span><b>Link de ativação por e-mail</b>&nbsp;<span class="muted">(recomendado)</span><br><span class="muted" style="font-size:11.5px">@if (es.available()) { A pessoa cria a própria senha pelo link (válido por {{ es.status()?.hours }} h). Nenhuma senha é exibida ou enviada. } @else { Envio de e-mail não configurado na plataforma. }</span></span></label>
    <label class="opt"><input type="radio" name="axdel" value="senha" [ngModel]="delivery()" (ngModelChange)="delivery.set($event)" />
      <span><b>Gerar senha temporária</b><br><span class="muted" style="font-size:11.5px">Mostrada uma única vez para você repassar; a troca é obrigatória no primeiro acesso.</span></span></label>
    <label class="opt"><input type="radio" name="axdel" value="manual" [ngModel]="delivery()" (ngModelChange)="delivery.set($event)" />
      <span><b>Definir a senha agora</b></span></label>
    @if (delivery() === 'manual') { <input type="password" class="input-field" style="margin-left:24px;max-width:320px" [ngModel]="password()" (ngModelChange)="password.set($event)" autocomplete="new-password" placeholder="mínimo 10 caracteres, letras e números" /> }
  </div>`,
  styles: [`.opt { display:flex; gap:8px; align-items:flex-start; font-size:13px; cursor:pointer; padding:7px 9px; border:1px solid #E3EAF1; border-radius:8px; } .opt input { margin-top:3px } .opt.dis { opacity:.55; cursor:not-allowed }`],
})
export class AccessChoiceComponent {
  readonly es = inject(EmailStatusService);
  readonly delivery = model<AccessDelivery>('senha'); readonly password = model('');
  constructor() {
    this.es.ensure().then(() => { if (this.es.available() && this.delivery() === 'senha') this.delivery.set('email'); });
  }
}
/** Corpo da requisição de criação conforme a escolha. */
export function deliveryBody(d: AccessDelivery, password: string) {
  return d === 'manual' ? { password } : { delivery: d };
}

/**
 * Diálogo de acesso: mostra o resultado de um convite/senha temporária ou, com "endpoint", oferece reenviar o link por e-mail
 * ou gerar senha temporária para um usuário existente.
 */
@Component({
  selector: 'ax-access-dialog',
  imports: [IconComponent, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-modal [open]="open()" (closed)="close()" [title]="r() ? 'Acesso de ' + (user()?.name || '') : 'Acesso de ' + (user()?.name || '')" icon="key" [width]="460">
    @if (!r()) {
      <p style="font-size:13px;margin-bottom:12px">Como deseja liberar o acesso de <b>{{ user()?.name }}</b> <span class="mono" style="font-size:12px">({{ user()?.email }})</span>?</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn-primary" style="justify-content:center" [disabled]="!es.available() || busy()" (click)="run('email')"><ax-icon name="mail" [size]="14" /> {{ user()?.pending_activation ? 'Reenviar link de ativação' : 'Enviar link de redefinição por e-mail' }}</button>
        @if (!es.available()) { <div class="muted" style="font-size:11.5px;text-align:center">Envio de e-mail não configurado na plataforma.</div> }
        @else if (!user()?.pending_activation) { <div class="muted" style="font-size:11.5px">A senha atual continua valendo até a pessoa usar o link; ao usar, as sessões abertas são encerradas.</div> }
        <button class="btn-secondary" style="justify-content:center" [disabled]="busy()" (click)="run('senha')"><ax-icon name="key" [size]="14" /> Gerar senha temporária agora</button>
        <div class="muted" style="font-size:11.5px">Senha temporária: substitui a atual na hora e encerra as sessões abertas.</div>
      </div>
    } @else {
      @if (r().invite?.sent) {
        <div class="state-success" style="display:flex;gap:8px;align-items:flex-start;background:#E8F6EE;border:1px solid #BFE5CF;border-radius:8px;padding:10px 12px;font-size:13px;color:#145C36">
          <ax-icon name="mail-check" [size]="16" /><span>Link enviado para <b>{{ r().invite.to }}</b>. Ele vale por {{ es.status()?.hours ?? 48 }} horas e só pode ser usado uma vez. Peça para verificar também a caixa de spam.</span></div>
      } @else if (r().invite && !r().invite.sent) {
        <div class="state-warning" style="font-size:13px;margin-bottom:10px"><ax-icon name="alert-triangle" [size]="14" /><span>Não foi possível enviar o e-mail: {{ r().invite.error }}</span></div>
      }
      @if (r().temporaryPassword) {
        <p style="font-size:13px;margin:10px 0">{{ r().invite && !r().invite.sent ? 'Use esta senha temporária como alternativa' : 'Senha temporária' }} — repasse por canal seguro. Ela não será exibida novamente e a troca é obrigatória no primeiro acesso.</p>
        <div class="mono" style="font-size:20px;font-weight:700;text-align:center;background:#F4F7FA;padding:12px;border-radius:6px;user-select:all">{{ r().temporaryPassword }}</div>
        <div style="text-align:center;margin-top:6px"><button class="btn-ghost" style="font-size:12px" (click)="copy(r().temporaryPassword)"><ax-icon name="copy" [size]="12" /> Copiar</button></div>
      }
      @if (r().linkedExisting) { <p style="font-size:13px">Esta pessoa já tinha conta no AXIONYX: ela foi vinculada a esta empresa e entra com a senha que já usa.</p> }
    }
    <div footer><button class="btn-secondary" (click)="close()">{{ r() ? 'Fechar' : 'Cancelar' }}</button></div>
  </ax-modal>`,
})
export class AccessDialogComponent {
  private api = inject(Api); private toast = inject(ToastService); readonly es = inject(EmailStatusService);
  readonly open = model(false);
  readonly user = input<any>(null);
  /** endpoint de redefinição (ex.: /admin/users/:id/reset-password); sem ele, só exibe o resultado */
  readonly endpoint = input<string | null>(null);
  readonly result = input<any>(null);
  readonly done = output<void>();
  readonly r = signal<any>(null); readonly busy = signal(false);
  constructor() {
    this.es.ensure();
    effect(() => { if (this.open()) this.r.set(this.result()); });
  }
  async run(delivery: 'email' | 'senha') {
    if (!this.endpoint()) return;
    this.busy.set(true);
    try { this.r.set(await this.api.post(this.endpoint()!, { delivery })); this.done.emit(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  copy(t: string) { navigator.clipboard?.writeText(t).then(() => this.toast.success('Copiado.')); }
  close() { this.open.set(false); this.r.set(null); }
}
