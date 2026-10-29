import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LogoComponent } from '../../shared/logo.component';
import { IconComponent } from '../../shared/icon.component';
import { AuthService } from '../../core/auth.service';
import { Api } from '../../core/api.service';
import { DocPipe } from '../../core/format';

// ─── Splash ─────────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-splash',
  imports: [LogoComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0B1F33;color:white">
    <div style="margin-bottom:40px;text-align:center">
      <div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:8px">
        <ax-logo [size]="36" />
        <span style="font-size:28px;font-weight:800;letter-spacing:-0.5px">AXIONYX</span>
      </div>
      <p style="color:#647687;font-size:13px">Inteligência para decisões empresariais.</p>
    </div>
    <div style="width:320px">
      <div style="background:#172B3A;border-radius:4px;height:4px;margin-bottom:16px;overflow:hidden">
        <div [style.width.%]="pct()" style="height:100%;background:linear-gradient(90deg,#0875D1,#00A6D6);transition:width 0.4s ease;border-radius:4px"></div>
      </div>
      <p style="font-size:12px;text-align:center;min-height:20px" [style.color]="failed() ? '#E57373' : '#647687'">{{ message() }}</p>
      @if (failed()) { <div style="text-align:center;margin-top:8px"><button class="btn-secondary" style="font-size:12px" (click)="run()">Tentar novamente</button></div> }
    </div>
    <p style="position:absolute;bottom:24px;font-size:11px;color:#2A4A62">v1.0.0 · AXIONYX ERP</p>
  </div>`,
})
export class SplashPage implements OnInit {
  private api = inject(Api); private router = inject(Router); private auth = inject(AuthService);
  readonly pct = signal(10); readonly message = signal('Verificando conexão com o servidor...'); readonly failed = signal(false);
  ngOnInit() { this.run(); }
  async run() {
    this.failed.set(false); this.pct.set(15); this.message.set('Verificando conexão com o servidor...');
    try {
      const h = await this.api.get<any>('/health');
      this.pct.set(60); this.message.set(h?.ok ? 'Servidor conectado.' : 'Servidor respondeu.');
      await new Promise((r) => setTimeout(r, 450));
      this.pct.set(100); this.message.set('Pronto.');
      await new Promise((r) => setTimeout(r, 250));
      this.router.navigateByUrl(this.auth.stage() === 'full' ? '/dashboard' : '/login');
    } catch (e: any) { this.failed.set(true); this.pct.set(100); this.message.set('Não foi possível conectar à API: ' + e.message); }
  }
}

// ─── Login ──────────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-login',
  imports: [LogoComponent, FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="login-layout" style="display:flex;height:100vh;font-family:Inter,sans-serif">
    <div class="login-brand-panel" style="flex:1;background:#0B1F33;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:64px;position:relative;overflow:hidden">
      <div style="position:absolute;inset:0;background-image:radial-gradient(circle at 30% 50%, rgba(8,117,209,0.15) 0%, transparent 60%), radial-gradient(circle at 80% 20%, rgba(0,166,214,0.1) 0%, transparent 40%)"></div>
      <div style="position:relative;text-align:center;max-width:360px">
        <div style="display:flex;align-items:center;gap:12px;justify-content:center;margin-bottom:32px">
          <ax-logo [size]="48" />
          <span style="font-size:36px;font-weight:800;color:white;letter-spacing:-1px">AXIONYX</span>
        </div>
        <p style="color:#A8BCCF;font-size:18px;line-height:1.5;margin-bottom:48px">Inteligência para decisões empresariais.</p>
        <div style="display:flex;flex-direction:column;gap:16px">
          @for (f of features; track f) {
            <div style="display:flex;align-items:center;gap:10px;text-align:left"><ax-icon name="check-circle-2" [size]="16" color="#00A6D6" /><span style="color:#7A9BB5;font-size:14px">{{ f }}</span></div>
          }
        </div>
      </div>
    </div>

    <form class="login-form-panel" (ngSubmit)="submit()" style="width:460px;background:white;display:flex;flex-direction:column;justify-content:center;padding:48px 48px">
      <h2 style="font-size:22px;font-weight:700;color:#172B3A;margin-bottom:6px">Acesso ao sistema</h2>
      <p style="color:#647687;font-size:14px;margin-bottom:32px">Informe suas credenciais para continuar.</p>
      @if (expired) { <div class="state-warning" style="margin-bottom:16px"><ax-icon name="clock" [size]="14" />Sua sessão expirou. Entre novamente.</div> }
      @if (error()) { <div class="state-error" style="margin:0 0 16px" role="alert"><ax-icon name="alert-triangle" [size]="14" /><span>{{ error() }}</span></div> }
      <div style="display:flex;flex-direction:column;gap:16px">
        <div>
          <label for="email" style="font-size:12px;font-weight:600;color:#647687;display:block;margin-bottom:6px">E-MAIL OU USUÁRIO</label>
          <div style="position:relative">
            <ax-icon name="mail" [size]="15" color="#A0AFBF" style="position:absolute;left:12px;top:50%;transform:translateY(-50%)" />
            <input id="email" name="email" class="input-field" style="padding-left:36px" [(ngModel)]="email" placeholder="seu@email.com.br" autocomplete="username" required />
          </div>
        </div>
        <div>
          <label for="pass" style="font-size:12px;font-weight:600;color:#647687;display:block;margin-bottom:6px">SENHA</label>
          <div style="position:relative">
            <ax-icon name="lock" [size]="15" color="#A0AFBF" style="position:absolute;left:12px;top:50%;transform:translateY(-50%)" />
            <input id="pass" name="pass" class="input-field" style="padding-left:36px;padding-right:36px" [type]="showPass() ? 'text' : 'password'" [(ngModel)]="password" placeholder="Senha" autocomplete="current-password" required />
            <button type="button" (click)="showPass.set(!showPass())" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#A0AFBF;display:flex" [attr.aria-label]="showPass() ? 'Ocultar senha' : 'Mostrar senha'"><ax-icon [name]="showPass() ? 'eye-off' : 'eye'" [size]="15" /></button>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" name="remember" [(ngModel)]="remember" style="accent-color:#0875D1" /><span style="font-size:13px;color:#647687">Lembrar-me</span></label>
          <a (click)="forgot.set(true)" style="font-size:13px;color:#0875D1;text-decoration:none;cursor:pointer">Esqueci minha senha</a>
        </div>
        @if (forgot()) {
          <div style="background:#F0F7FD;border:1px solid #CFE3F5;border-radius:8px;padding:12px">
            @if (!resetSent()) {
              <div style="font-size:13px;color:#172B3A;margin-bottom:8px">Informe o seu e-mail: se ele estiver cadastrado, enviaremos um link para você criar uma nova senha.</div>
              <div style="display:flex;gap:6px"><input class="input-field" name="resetEmail" type="email" [(ngModel)]="resetEmail" placeholder="seu@email.com.br" autocomplete="username" />
                <button type="button" class="btn-secondary" [disabled]="resetBusy() || !resetEmail" (click)="sendReset()">Enviar link</button></div>
            } @else { <div style="font-size:13px;color:#145C36">{{ resetSent() }}</div> }
          </div>
        }
        <button type="submit" class="btn-primary" [disabled]="busy()" style="width:100%;justify-content:center;padding:10px 0;margin-top:8px">
          @if (busy()) { <span class="spinner" style="border-color:rgba(255,255,255,.4);border-top-color:white"></span> } Entrar no AXIONYX
        </button>
        <div style="display:flex;align-items:center;gap:12px"><div style="flex:1;height:1px;background:#DCE4EC"></div><span style="font-size:12px;color:#A0AFBF">ou</span><div style="flex:1;height:1px;background:#DCE4EC"></div></div>
        <button type="button" class="btn-secondary" style="width:100%;justify-content:center;padding:10px 0" (click)="sso.set(true)"><ax-icon name="shield" [size]="15" />Autenticação corporativa (SSO)</button>
        @if (sso()) { <div class="state-info"><ax-icon name="info" [size]="14" />SSO (SAML/OIDC) pendente de configuração com o provedor de identidade da empresa.</div> }
      </div>
      <p style="margin-top:40px;font-size:12px;color:#A0AFBF;text-align:center">Ao acessar, você concorda com os Termos de Uso e a Política de Privacidade da sua empresa.</p>
    </form>
  </div>`,
})
export class LoginPage {
  readonly auth = inject(AuthService); private router = inject(Router);
  readonly features = ['Gestão financeira em tempo real', 'Varejo e serviços: PDV, agenda, estoque e crediário', 'Conformidade fiscal com provedor homologado', 'Analytics e Business Intelligence'];
  readonly showPass = signal(false); readonly busy = signal(false); readonly error = signal(''); readonly forgot = signal(false); readonly sso = signal(false);
  readonly expired = !!inject(ActivatedRoute).snapshot.queryParamMap.get('expirada');
  email = this.auth.rememberedEmail(); password = ''; remember = true;
  resetEmail = ''; readonly resetBusy = signal(false); readonly resetSent = signal('');
  async sendReset() {
    this.resetBusy.set(true);
    try {
      const r = await this.auth.requestPasswordReset(this.resetEmail.trim());
      this.resetSent.set(r.emailEnabled ? 'Se o e-mail estiver cadastrado, você receberá o link em instantes (veja também a caixa de spam). O link vale por 48 horas.'
        : 'O envio de e-mails ainda não está ativo. Peça ao administrador da sua empresa para redefinir sua senha.');
    } catch (e: any) { this.error.set(e.message); } finally { this.resetBusy.set(false); }
  }
  async submit() {
    if (!this.email || !this.password) { this.error.set('Informe e-mail e senha.'); return; }
    this.busy.set(true); this.error.set('');
    try {
      const r = await this.auth.login(this.email.trim(), this.password, this.remember);
      this.router.navigateByUrl(r.mfaRequired ? '/mfa' : '/empresa');
    } catch (e: any) { this.error.set(e.message); }
    finally { this.busy.set(false); }
  }
}

// ─── MFA ────────────────────────────────────────────────────────────────────
@Component({
  selector: 'ax-mfa',
  imports: [FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;height:100vh;background:#F4F7FA;align-items:center;justify-content:center">
    <form class="auth-card mfa-card" (ngSubmit)="verify()" style="background:white;border:1px solid #DCE4EC;border-radius:12px;padding:48px;width:420px;text-align:center">
      <div style="width:56px;height:56px;background:#E3EFF9;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px"><ax-icon name="shield" [size]="28" color="#0875D1" /></div>
      <h2 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:8px">Verificação em dois fatores</h2>
      <p style="color:#647687;font-size:14px;margin-bottom:32px">Digite o código de 6 dígitos do seu aplicativo autenticador (<strong>{{ masked() }}</strong>).</p>
      @if (error()) { <div class="state-error" style="margin:-16px 0 16px;text-align:left"><ax-icon name="alert-triangle" [size]="14" />{{ error() }}</div> }
      <div class="mfa-inputs" style="display:flex;gap:10px;justify-content:center;margin-bottom:32px">
        @for (d of code(); track $index) {
          <input [id]="'mfa-' + $index" maxlength="1" inputmode="numeric" [value]="d" (input)="change($index, $event)" (keydown)="key($index, $event)" (paste)="paste($event)"
            style="width:48px;height:56px;text-align:center;font-size:22px;font-weight:700;border:1.5px solid #DCE4EC;border-radius:8px;outline:none;color:#172B3A;font-family:'JetBrains Mono',monospace" [attr.aria-label]="'Dígito ' + ($index + 1)" />
        }
      </div>
      <button type="submit" class="btn-primary" [disabled]="busy() || joined().length !== 6" style="width:100%;justify-content:center;padding:10px 0">@if (busy()) { <span class="spinner"></span> } Verificar e continuar</button>
      <p style="margin-top:16px;font-size:13px;color:#647687">Sem acesso ao autenticador? <a style="color:#0875D1;cursor:pointer" (click)="help.set(true)">Ajuda</a></p>
      @if (help()) { <div class="state-info" style="text-align:left;margin-top:8px"><ax-icon name="info" [size]="14" />Peça ao administrador para redefinir seu MFA em Administração › Usuários.</div> }
      <p style="margin-top:8px"><a style="font-size:12px;color:#647687;cursor:pointer" (click)="back()">Voltar ao login</a></p>
    </form>
  </div>`,
})
export class MfaPage {
  private auth = inject(AuthService); private router = inject(Router);
  readonly code = signal(['', '', '', '', '', '']); readonly busy = signal(false); readonly error = signal(''); readonly help = signal(false);
  readonly masked = this.auth.maskedEmail;
  joined() { return this.code().join(''); }
  change(i: number, e: Event) {
    const v = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(-1);
    const next = [...this.code()]; next[i] = v; this.code.set(next);
    (e.target as HTMLInputElement).value = v;
    if (v && i < 5) (document.getElementById(`mfa-${i + 1}`) as HTMLInputElement)?.focus();
    if (this.joined().length === 6) this.verify();
  }
  key(i: number, e: KeyboardEvent) { if (e.key === 'Backspace' && !this.code()[i] && i > 0) (document.getElementById(`mfa-${i - 1}`) as HTMLInputElement)?.focus(); }
  paste(e: ClipboardEvent) {
    const t = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (t.length === 6) { e.preventDefault(); this.code.set(t.split('')); this.verify(); }
  }
  async verify() {
    if (this.busy() || this.joined().length !== 6) return;
    this.busy.set(true); this.error.set('');
    try { await this.auth.verifyMfa(this.joined()); this.router.navigateByUrl('/empresa'); }
    catch (e: any) { this.error.set(e.message); this.code.set(['', '', '', '', '', '']); setTimeout(() => document.getElementById('mfa-0')?.focus()); }
    finally { this.busy.set(false); }
  }
  back() { this.auth.clear(); this.router.navigateByUrl('/login'); }
}

// ─── Seleção de empresa ─────────────────────────────────────────────────────
@Component({
  selector: 'ax-company-select',
  imports: [LogoComponent, IconComponent, DocPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;min-height:100vh;background:#F4F7FA;align-items:center;justify-content:center">
    <div class="auth-card company-card" style="width:560px;padding:24px 0">
      <div style="text-align:center;margin-bottom:40px">
        <div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:8px">
          <ax-logo [size]="36" />
          <span style="font-size:24px;font-weight:800;color:#0B1F33">AXIONYX</span>
        </div>
        <h2 style="font-size:18px;font-weight:600;color:#172B3A;margin-bottom:4px">Selecione a empresa</h2>
        <p style="color:#647687;font-size:14px">Você possui acesso a {{ companies().length }} empresa(s).</p>
      </div>
      @if (error()) { <div class="state-error">{{ error() }}</div> }
      @if (auth.invitations().length) {
        <div style="background:#FFF7E6;border:1px solid #F5D9A0;border-radius:10px;padding:12px 14px;margin-bottom:14px">
          <div style="font-size:13px;font-weight:600;color:#7A4E00;margin-bottom:6px;display:flex;gap:6px;align-items:center"><ax-icon name="mail" [size]="14" /> Convites para acessar outras empresas</div>
          @for (i of auth.invitations(); track i.company_id) {
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid #F5E3BC;font-size:13px">
              <span style="flex:1;min-width:180px"><b>{{ i.company }}</b> · perfil {{ i.role }}{{ i.invited_by ? ' · convidado por ' + i.invited_by : '' }}</span>
              <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="answer(i, false)">Recusar</button>
              <button class="btn-primary" style="font-size:12px" (click)="answer(i, true)">Aceitar</button>
            </div>
          }
          <div style="font-size:11.5px;color:#8A6A2E;margin-top:4px">Só aceite convites de empresas que você reconhece. Recusar não altera nada na sua conta.</div>
        </div>
      }
      <div style="display:flex;flex-direction:column;gap:12px">
        @for (c of companies(); track c.id) {
          <div (click)="selected.set(c.id)" (dblclick)="selected.set(c.id); next()" [style.border]="'2px solid ' + (selected() === c.id ? '#0875D1' : '#DCE4EC')" [style.box-shadow]="selected() === c.id ? '0 0 0 3px rgba(8,117,209,0.12)' : 'none'"
            style="background:white;border-radius:10px;padding:16px 20px;cursor:pointer;display:flex;align-items:center;gap:16px;transition:border-color 0.15s, box-shadow 0.15s">
            <div [style.background]="c.color" style="width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><ax-icon name="building-2" [size]="22" color="white" /></div>
            <div style="flex:1">
              <div style="font-size:14px;font-weight:600;color:#172B3A">{{ c.name }}</div>
              <div style="font-size:13px;color:#647687">{{ c.trade_name || '—' }} @if (c.cnpj) { · CNPJ {{ c.cnpj | doc }} }</div>
              <span class="badge badge-info" style="margin-top:4px">{{ c.role || 'Superadministrador' }}</span>
              @if (c.is_demo) { <span class="test-stamp" style="margin-left:6px">Demonstração</span> }
            </div>
            @if (selected() === c.id) { <ax-icon name="check-circle-2" [size]="20" color="#0875D1" /> }
          </div>
        } @empty { @if (!auth.invitations().length) { <div class="empty-state">Seu usuário não está vinculado a nenhuma empresa. Contate o administrador.</div> } }
      </div>
      <button class="btn-primary" (click)="next()" [disabled]="!selected()" [style.opacity]="selected() ? 1 : 0.5" style="width:100%;justify-content:center;padding:10px 0;margin-top:24px">Continuar <ax-icon name="chevron-right" [size]="16" /></button>
      <p style="text-align:center;margin-top:12px"><a style="font-size:12px;color:#647687;cursor:pointer" (click)="auth.logout()">Sair</a></p>
    </div>
  </div>`,
})
export class CompanySelectPage implements OnInit {
  readonly auth = inject(AuthService); private router = inject(Router);
  readonly companies = this.auth.companies; readonly selected = signal<string | null>(null); readonly error = signal('');
  async ngOnInit() {
    try { const c = await this.auth.loadCompanies(); if (c.length === 1) this.selected.set(c[0].id); } catch (e: any) { this.error.set(e.message); }
  }
  async answer(i: any, accept: boolean) {
    if (!accept && !confirm(`Recusar o convite de ${i.company}?`)) return;
    try { await this.auth.answerInvitation(i.company_id, accept); if (accept) this.selected.set(i.company_id); } catch (e: any) { this.error.set(e.message); }
  }
  next() {
    const c = this.companies().find((x) => x.id === this.selected()); if (!c) return;
    this.auth.selectedCompany.set(c); this.router.navigateByUrl('/filial');
  }
}

// ─── Seleção de filial ──────────────────────────────────────────────────────
@Component({
  selector: 'ax-branch-select',
  imports: [IconComponent, DocPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;min-height:100vh;background:#F4F7FA;align-items:center;justify-content:center">
    <div class="auth-card branch-card" style="width:480px;padding:24px 0">
      <div style="text-align:center;margin-bottom:32px">
        <h2 style="font-size:18px;font-weight:600;color:#172B3A;margin-bottom:4px">Selecione a filial</h2>
        <p style="color:#647687;font-size:14px">{{ company()?.name }}</p>
      </div>
      @if (error()) { <div class="state-error">{{ error() }}</div> }
      <div style="display:flex;flex-direction:column;gap:10px">
        @for (b of branches(); track b.id) {
          <label (dblclick)="selected.set(b.id); enter()" [style.border]="'2px solid ' + (selected() === b.id ? '#0875D1' : '#DCE4EC')" style="background:white;border-radius:8px;padding:14px 18px;cursor:pointer;display:flex;align-items:center;gap:14px">
            <input type="radio" name="branch" [checked]="selected() === b.id" (change)="selected.set(b.id)" style="accent-color:#0875D1" />
            <div>
              <div style="font-size:14px;font-weight:600;color:#172B3A">{{ b.code }} · {{ b.name }}</div>
              <div style="font-size:12px;color:#647687">{{ b.cnpj ? (b.cnpj | doc) : 'CNPJ não informado' }} @if (b.address?.logradouro) { · {{ b.address.logradouro }}, {{ b.address.numero }} - {{ b.address.bairro }} }</div>
            </div>
          </label>
        }
      </div>
      <button class="btn-primary" (click)="enter()" [disabled]="!selected() || busy()" style="width:100%;justify-content:center;padding:10px 0;margin-top:20px">@if (busy()) { <span class="spinner"></span> } Acessar sistema <ax-icon name="chevron-right" [size]="16" /></button>
      <p style="text-align:center;margin-top:12px"><a style="font-size:12px;color:#647687;cursor:pointer" (click)="router.navigateByUrl('/empresa')">Trocar empresa</a></p>
    </div>
  </div>`,
})
export class BranchSelectPage implements OnInit {
  private auth = inject(AuthService); readonly router = inject(Router);
  readonly company = this.auth.selectedCompany; readonly branches = signal<any[]>([]); readonly selected = signal<string | null>(null); readonly busy = signal(false); readonly error = signal('');
  async ngOnInit() {
    const c = this.company(); if (!c) { this.router.navigateByUrl('/empresa'); return; }
    try { const b = await this.auth.branchesOf(c.id); this.branches.set(b); if (b.length) this.selected.set(b[0].id); if (!b.length) this.error.set('Sem filiais liberadas para seu usuário nesta empresa.'); }
    catch (e: any) { this.error.set(e.message); }
  }
  async enter() {
    if (!this.selected()) return;
    this.busy.set(true); this.error.set('');
    try { await this.auth.enterContext(this.company()!.id, this.selected()!); this.router.navigateByUrl('/dashboard'); }
    catch (e: any) { this.error.set(e.message); } finally { this.busy.set(false); }
  }
}
