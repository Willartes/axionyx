import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { LogoComponent } from '../../shared/logo.component';
import { Api } from '../../core/api.service';

/** Ativação de acesso / redefinição de senha pelo link de uso único enviado por e-mail. */
@Component({
  selector: 'ax-ativar',
  imports: [FormsModule, IconComponent, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="min-height:100vh;background:#F4F7FA;display:flex;align-items:center;justify-content:center;padding:24px 16px">
    <div class="auth-card" style="background:white;border:1px solid #DCE4EC;border-radius:12px;padding:36px 32px;width:100%;max-width:440px">
      <div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:22px"><ax-logo [size]="34" /><span style="font-size:24px;font-weight:800;color:#172B3A;letter-spacing:-.5px">AXIONYX</span></div>
      @if (state() === 'loading') { <div class="skeleton" style="height:140px"></div> }
      @if (state() === 'invalid') {
        <div style="text-align:center">
          <div style="width:52px;height:52px;background:#FDECEC;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px"><ax-icon name="link-2-off" [size]="26" color="#C93636" /></div>
          <h2 style="font-size:19px;font-weight:700;color:#172B3A;margin-bottom:8px">Link inválido ou expirado</h2>
          <p style="color:#647687;font-size:14px;line-height:1.5">{{ error() || 'Este link já foi usado ou expirou.' }} Peça ao administrador da sua empresa um novo convite.</p>
          <button class="btn-secondary" style="margin-top:20px" (click)="router.navigateByUrl('/login')">Ir para o login</button>
        </div>
      }
      @if (state() === 'form' && info(); as i) {
        <h2 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:6px">{{ i.kind === 'ativacao' ? 'Ative seu acesso' : 'Defina uma nova senha' }}</h2>
        <p style="color:#647687;font-size:14px;margin-bottom:20px;line-height:1.5">Olá, <b>{{ i.name }}</b>! {{ i.kind === 'ativacao' ? 'Crie a senha da sua conta' : 'Crie sua nova senha' }} <span class="mono" style="font-size:12.5px">({{ i.email }})</span>{{ i.company ? ' — ' + i.company : '' }}.</p>
        @if (error()) { <div class="state-error" style="margin:0 0 14px" role="alert"><ax-icon name="alert-triangle" [size]="14" /><span>{{ error() }}</span></div> }
        <form (ngSubmit)="submit()" style="display:flex;flex-direction:column;gap:14px">
          <div><label for="p1" class="field-label">Nova senha</label>
            <div style="position:relative"><input id="p1" name="p1" class="input-field" style="padding-right:36px" [type]="show() ? 'text' : 'password'" [(ngModel)]="p1" autocomplete="new-password" (ngModelChange)="rev.set(rev() + 1)" />
              <button type="button" (click)="show.set(!show())" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#A0AFBF;display:flex" [attr.aria-label]="show() ? 'Ocultar senha' : 'Mostrar senha'"><ax-icon [name]="show() ? 'eye-off' : 'eye'" [size]="15" /></button></div></div>
          <div><label for="p2" class="field-label">Repita a senha</label><input id="p2" name="p2" class="input-field" [type]="show() ? 'text' : 'password'" [(ngModel)]="p2" autocomplete="new-password" (ngModelChange)="rev.set(rev() + 1)" /></div>
          <ul style="list-style:none;padding:0;margin:0;font-size:12.5px;display:flex;flex-direction:column;gap:4px">
            @for (r of rules(); track r[0]) { <li [style.color]="r[1] ? '#18864B' : '#647687'" style="display:flex;gap:6px;align-items:center"><ax-icon [name]="r[1] ? 'check-circle-2' : 'circle'" [size]="13" /> {{ r[0] }}</li> }
          </ul>
          <button type="submit" class="btn-primary" [disabled]="busy() || !valid()" style="width:100%;justify-content:center;padding:10px 0">@if (busy()) { <span class="spinner" style="border-color:rgba(255,255,255,.4);border-top-color:white"></span> } {{ i.kind === 'ativacao' ? 'Ativar acesso' : 'Salvar nova senha' }}</button>
        </form>
        <p style="font-size:11.5px;color:#8696A7;margin-top:16px;line-height:1.5">Link pessoal e de uso único, válido até {{ until(i.expiresAt) }}. Ao salvar, sessões abertas da sua conta são encerradas.</p>
      }
      @if (state() === 'done') {
        <div style="text-align:center">
          <div style="width:52px;height:52px;background:#E8F6EE;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px"><ax-icon name="check-circle-2" [size]="26" color="#18864B" /></div>
          <h2 style="font-size:19px;font-weight:700;color:#172B3A;margin-bottom:8px">Senha definida</h2>
          <p style="color:#647687;font-size:14px">Agora é só entrar com o seu e-mail e a nova senha.</p>
          <button class="btn-primary" style="margin-top:20px" (click)="router.navigateByUrl('/login')">Entrar no AXIONYX</button>
        </div>
      }
    </div>
  </div>`,
})
export class AtivarPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); private route = inject(ActivatedRoute);
  readonly state = signal<'loading' | 'invalid' | 'form' | 'done'>('loading'); readonly info = signal<any>(null); readonly error = signal('');
  readonly busy = signal(false); readonly show = signal(false); readonly rev = signal(0);
  p1 = ''; p2 = ''; private token = '';
  readonly rules = computed((): [string, boolean][] => { this.rev(); return [
    ['Pelo menos 10 caracteres', this.p1.length >= 10], ['Letras e números', /[a-z]/i.test(this.p1) && /\d/.test(this.p1)], ['As duas senhas iguais', !!this.p1 && this.p1 === this.p2]]; });
  readonly valid = computed(() => this.rules().every((r) => r[1]));
  until(d: string) { return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  async ngOnInit() {
    this.token = this.route.snapshot.queryParamMap.get('token') || '';
    // tira o token da barra de endereço/histórico assim que lido
    try { history.replaceState(null, '', '/ativar'); } catch { /* */ }
    if (!this.token) { this.state.set('invalid'); return; }
    try { this.info.set(await this.api.get('/public/activation', { token: this.token })); this.state.set('form'); }
    catch (e: any) { this.error.set(e?.status === 410 ? '' : e?.message || ''); this.state.set('invalid'); }
  }
  async submit() {
    if (!this.valid()) return;
    this.busy.set(true); this.error.set('');
    try { await this.api.post('/public/activation', { token: this.token, password: this.p1 }); this.state.set('done'); }
    catch (e: any) { if (e?.status === 410) { this.state.set('invalid'); } else this.error.set(e?.message || 'Não foi possível salvar.'); }
    finally { this.busy.set(false); }
  }
}
