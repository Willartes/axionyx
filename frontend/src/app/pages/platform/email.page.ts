import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

/** E-mail transacional da plataforma (convites e redefinição de senha): situação, teste e passo a passo. */
@Component({
  selector: 'ax-plataforma-email',
  imports: [FormsModule, IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .chk { display:flex; gap:10px; align-items:flex-start; padding:9px 0; border-bottom:1px solid #EEF2F6; font-size:13px; } .chk:last-child { border-bottom:0; }
    .code { font-family:'JetBrains Mono',monospace; font-size:12px; background:#F1F4F7; padding:8px 10px; border-radius:8px; word-break:break-all; white-space:pre-wrap; }
    ol { padding-left:18px; margin:6px 0 0; font-size:13px; line-height:1.7; color:#334B5F; }
    .opt { border:1px solid #E3EAF1; border-radius:10px; padding:14px; }
    .opt.on { border-color:#0875D1; box-shadow:0 0 0 2px #E3EFF9; }
  `],
  template: `
  <div style="padding:24px;max-width:1100px">
    <h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="mail" [size]="20" color="#0875D1" /> E-mail de convites</h1>
    <p style="font-size:13px;color:#647687;margin-bottom:14px">Links de ativação de novos usuários e de redefinição de senha. Credenciais somente nas variáveis de ambiente do servidor (Railway) — nunca no código nem no banco.</p>
    @if (s(); as s) {
      <div class="grid-2-resp" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:14px">
        <div class="card" style="padding:16px">
          <div style="font-size:14px;font-weight:700;margin-bottom:6px">Situação</div>
          @for (c of checks(); track c[0]) {
            <div class="chk"><ax-icon [name]="c[1] ? 'check-circle-2' : 'x-circle'" [size]="16" [color]="c[1] ? '#18864B' : '#C93636'" /><div style="flex:1"><b>{{ c[0] }}</b><div class="muted" style="font-size:12px">{{ c[2] }}</div></div></div>
          }
        </div>
        <div class="card" style="padding:16px">
          <div style="font-size:14px;font-weight:700;margin-bottom:8px">Enviar e-mail de teste</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><input class="input-field" style="flex:1;min-width:200px" type="email" [(ngModel)]="to" placeholder="seu@email.com" />
            <button class="btn-primary" [disabled]="!s.configured || busy() || !to" (click)="test()"><ax-icon name="send" [size]="13" /> Enviar teste</button></div>
          @if (result(); as r) {
            @if (r.sent) { <div style="font-size:12.5px;color:#145C36;background:#E8F6EE;padding:8px 10px;border-radius:8px;margin-top:10px">Enviado por {{ r.provider }}. Confira a caixa de entrada (e o spam).</div> }
            @else { <div style="font-size:12.5px;color:#8A1F1F;background:#FDECEC;padding:8px 10px;border-radius:8px;margin-top:10px">Falhou: {{ r.error }}</div> }
          }
          <div class="muted" style="font-size:12px;margin-top:10px">Os links valem por {{ s.hours }} horas (variável ACTIVATION_HOURS, de 1 a 168) e só podem ser usados uma vez. Se o envio falhar ao cadastrar alguém, o sistema oferece uma senha temporária como alternativa.</div>
        </div>
      </div>

      <div class="grid-2-resp" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:14px">
        <div class="opt" [class.on]="s.provider === 'resend' || s.provider === 'brevo'">
          <div style="font-size:14px;font-weight:700">Opção A — Serviço transacional (funciona no Railway Hobby)</div>
          <div class="muted" style="font-size:12px">Resend ou Brevo, ambos com plano gratuito. Envio por HTTPS.</div>
          <ol>
            <li>Crie a conta (resend.com ou brevo.com) e adicione o domínio <b>axionyxerp.com.br</b>.</li>
            <li>Copie os registros DNS que o serviço mostrar (SPF/DKIM e, se pedir, DMARC/MX de retorno) para o <b>Cloudflare › DNS</b>, em modo DNS only, e aguarde a verificação.</li>
            <li>Gere a chave de API e salve no Railway: <span class="mono">RESEND_API_KEY</span>&nbsp;<i>ou</i>&nbsp;<span class="mono">BREVO_API_KEY</span>.</li>
            <li>Defina <span class="mono">EMAIL_FROM</span> com um endereço do domínio verificado (ex.: nao-responda&#64;axionyxerp.com.br) e, se quiser, <span class="mono">EMAIL_FROM_NAME</span>.</li>
          </ol>
        </div>
        <div class="opt" [class.on]="s.provider === 'smtp'">
          <div style="font-size:14px;font-weight:700">Opção B — SMTP do seu e-mail (exige Railway Pro)</div>
          <div class="muted" style="font-size:12px">O Railway bloqueia SMTP de saída nos planos Free, Trial e Hobby.</div>
          <ol>
            <li>No provedor do e-mail, gere uma <b>senha de aplicativo</b> (Gmail/Google Workspace, Outlook, Zoho etc.).</li>
            <li>Salve no Railway: <span class="mono">SMTP_HOST</span>, <span class="mono">SMTP_PORT</span> (587 STARTTLS ou 465 TLS), <span class="mono">SMTP_USER</span>, <span class="mono">SMTP_PASS</span>.</li>
            <li><span class="mono">EMAIL_FROM</span> deve ser o mesmo endereço (ou um alias autorizado) da conta SMTP.</li>
          </ol>
        </div>
      </div>
      <div class="card" style="padding:14px 16px;margin-bottom:14px;font-size:12.5px;color:#4A5B6B">
        Com as duas opções configuradas, use <span class="mono">EMAIL_PROVIDER</span> = <span class="mono">resend</span>, <span class="mono">brevo</span> ou <span class="mono">smtp</span> para escolher. Sem ela, a ordem é Resend → Brevo → SMTP. <span class="mono">APP_PUBLIC_URL</span> (ex.: https://www.axionyxerp.com.br) é obrigatório: é com ele que o link é montado. Depois de alterar variáveis, faça o redeploy.
      </div>

      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6;display:flex"><span style="flex:1">Últimos envios</span><button class="btn-ghost" style="font-size:12px" (click)="load()"><ax-icon name="refresh-cw" [size]="12" /> Atualizar</button></div>
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr><th>Quando</th><th>Para</th><th>Tipo</th><th>Provedor</th><th>Situação</th><th>Por</th></tr></thead>
          <tbody>@for (e of s.recent; track $index) {
            <tr><td class="mono" style="font-size:11.5px">{{ e.created_at | dtt }}</td><td>{{ e.to_email }}</td><td>{{ kind(e.kind) }}</td><td>{{ e.provider || '—' }}</td>
              <td>@if (e.status === 'enviado') { <span class="badge badge-success">enviado</span> } @else { <span class="badge badge-danger" [title]="e.error">erro</span><div style="font-size:11px;color:#C93636;max-width:280px">{{ e.error }}</div> }</td><td>{{ e.by_name || 'sistema' }}</td></tr>
          } @empty { <tr><td colspan="6"><div class="empty-state">Nenhum e-mail enviado ainda.</div></td></tr> }</tbody></table></div>
      </div>
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:120px"></div></div> }
  </div>`,
})
export class PlataformaEmailPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); private auth = inject(AuthService);
  readonly s = signal<any>(null); readonly busy = signal(false); readonly result = signal<any>(null);
  to = this.auth.me()?.user?.email ?? '';
  readonly checks = computed<[string, boolean, string][]>(() => {
    const s = this.s(); if (!s) return [];
    const prov: Record<string, string> = { resend: 'Resend (HTTPS)', brevo: 'Brevo (HTTPS)', smtp: 'SMTP' };
    return [
      ['Provedor', !!s.provider && s.configured, s.provider ? `${prov[s.provider] ?? s.provider}${s.missing?.length ? ' — faltam: ' + s.missing.join(', ') : ''}` : 'Nenhum configurado (Resend, Brevo ou SMTP)'],
      ['EMAIL_FROM', !!s.from, s.from || 'Remetente, ex.: nao-responda@axionyxerp.com.br'],
      ['APP_PUBLIC_URL', !!s.publicUrl, s.publicUrl || 'Endereço público para montar o link de ativação'],
      ['Convites por e-mail', !!s.available, s.available ? 'Ativos: novos usuários recebem o link de ativação' : 'Inativos: o cadastro usa senha temporária'],
    ];
  });
  kind(k: string) { return ({ ativacao: 'Ativação', redefinicao: 'Redefinição', teste: 'Teste' } as any)[k] ?? k; }
  ngOnInit() { this.load(); }
  async load() { try { this.s.set(await this.api.get('/platform/email')); } catch (e) { this.toast.error(e); } }
  async test() {
    this.busy.set(true); this.result.set(null);
    try { this.result.set(await this.api.post('/platform/email/test', { to: this.to })); this.load(); } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}
