import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LogoComponent } from '../../shared/logo.component';
import { IconComponent } from '../../shared/icon.component';
import { Api } from '../../core/api.service';

/**
 * Botão flutuante de WhatsApp do site: o visitante informa nome e WhatsApp, autoriza o contato (LGPD) e a conversa
 * abre no WhatsApp (link oficial wa.me) com a mensagem já escrita. O contato fica salvo em Contatos do site.
 * O número vem do servidor (SITE_WHATSAPP); sem número configurado, o botão não aparece.
 */
@Component({
  selector: 'ax-whatsapp-widget',
  imports: [FormsModule, LogoComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { position:fixed; right:20px; bottom:calc(20px + env(safe-area-inset-bottom, 0px)); z-index:70; font-family:Inter, system-ui, sans-serif; }
    .fab { width:60px; height:60px; border-radius:50%; border:none; cursor:pointer; background:#25D366; color:#fff; display:grid; place-items:center;
      box-shadow:0 10px 28px rgba(13,60,35,.35); transition:transform .15s, box-shadow .15s; position:relative; }
    .fab:hover { transform:translateY(-2px) scale(1.03); box-shadow:0 14px 34px rgba(13,60,35,.42); }
    .fab:focus-visible { outline:3px solid #9FE8BC; outline-offset:3px; }
    .fab .dot { position:absolute; top:3px; right:3px; width:13px; height:13px; border-radius:50%; background:#00A6D6; border:2px solid #fff; }
    .tip { position:absolute; right:72px; bottom:12px; background:#fff; color:#172B3A; font-size:13.5px; font-weight:600; padding:9px 13px; border-radius:12px; white-space:nowrap;
      box-shadow:0 8px 24px rgba(11,31,51,.18); pointer-events:none; opacity:0; transform:translateX(6px); transition:opacity .2s, transform .2s; }
    :host(:hover) .tip.show, .tip.show.peek { opacity:1; transform:none; }
    .card { position:absolute; right:0; bottom:76px; width:min(360px, calc(100vw - 32px)); background:#fff; border-radius:18px; overflow:hidden;
      box-shadow:0 24px 60px rgba(11,31,51,.28); transform-origin:bottom right; animation:pop .18s ease-out; }
    @keyframes pop { from { opacity:0; transform:translateY(8px) scale(.97); } to { opacity:1; transform:none; } }
    .head { background:linear-gradient(135deg, #0B1F33 0%, #0F3A5C 100%); color:#fff; padding:16px 16px 16px 18px; display:flex; align-items:center; gap:12px; }
    .avatar { width:46px; height:46px; border-radius:50%; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.16); display:grid; place-items:center; flex:none; }
    .who b { display:block; font-size:15.5px; }
    .who small { display:flex; align-items:center; gap:6px; color:#B8C7D6; font-size:12.5px; margin-top:2px; }
    .who small i { width:8px; height:8px; border-radius:50%; background:#25D366; display:inline-block; }
    .close { margin-left:auto; background:transparent; border:none; color:#B8C7D6; cursor:pointer; padding:6px; border-radius:8px; display:grid; place-items:center; }
    .close:hover { background:rgba(255,255,255,.08); color:#fff; }
    .body { padding:16px 18px 18px; background:#F4F8FB; display:flex; flex-direction:column; gap:10px; }
    .bubble { background:#fff; border-radius:4px 14px 14px 14px; padding:11px 13px; font-size:14px; line-height:1.45; color:#172B3A; box-shadow:0 1px 2px rgba(11,31,51,.08); max-width:92%; }
    label.f { font-size:12.5px; font-weight:600; color:#3B5266; margin-top:4px; }
    .in { width:100%; box-sizing:border-box; border:1px solid #D4DEE8; border-radius:11px; padding:12px 13px; font-size:15px; background:#fff; color:#172B3A; outline:none; transition:border-color .15s, box-shadow .15s; }
    .in:focus { border-color:#0875D1; box-shadow:0 0 0 3px rgba(8,117,209,.15); }
    .in.bad { border-color:#C93636; }
    .consent { display:flex; gap:9px; align-items:flex-start; font-size:12.5px; color:#3B5266; line-height:1.4; cursor:pointer; margin-top:2px; }
    .consent input { margin-top:2px; width:16px; height:16px; accent-color:#0875D1; flex:none; }
    .err { color:#C93636; font-size:12.5px; }
    .go { margin-top:4px; border:none; border-radius:12px; padding:14px; font-size:15px; font-weight:700; background:#25D366; color:#073B1D; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; transition:background .15s; }
    .go:hover { background:#20BD5B; }
    .note { font-size:11.5px; color:#647687; text-align:center; }
    .hp { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }
    @media (max-width:640px) { :host { right:14px; bottom:calc(14px + env(safe-area-inset-bottom, 0px)); } .fab { width:56px; height:56px; } .tip { display:none; } .card { bottom:70px; } }
    @media (prefers-reduced-motion: reduce) { .card { animation:none; } .fab, .tip { transition:none; } }
  `],
  template: `
  @if (number() && !hidden()) {
    @if (open()) {
      <div class="card" role="dialog" aria-modal="false" aria-labelledby="wa-title">
        <div class="head">
          <div class="avatar"><ax-logo [size]="30" /></div>
          <div class="who"><b id="wa-title">Equipe AXIONYX</b><small><i></i> Online · responde em minutos</small></div>
          <button class="close" type="button" aria-label="Fechar" (click)="open.set(false)"><ax-icon name="x" [size]="18" /></button>
        </div>
        <form class="body" (ngSubmit)="start()" novalidate>
          <div class="bubble">Olá! 👋 Quer ver como o AXIONYX pode ajudar a sua empresa a vender mais e entender a margem? Fale com a nossa equipe.</div>
          <label class="f" for="wa-name">Seu nome</label>
          <input #nameInput id="wa-name" class="in" [class.bad]="tried() && f.name.trim().length < 2" name="name" autocomplete="name" maxlength="80" placeholder="Como podemos te chamar?" [(ngModel)]="f.name" />
          <label class="f" for="wa-phone">Seu WhatsApp</label>
          <input id="wa-phone" class="in" [class.bad]="tried() && !phoneOk()" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="16" placeholder="(DDD) 9 0000-0000" [ngModel]="f.phone" (ngModelChange)="setPhone($event)" />
          <label class="consent"><input type="checkbox" name="consent" [(ngModel)]="f.consent" /> <span>Autorizo a equipe do AXIONYX a falar comigo pelo WhatsApp sobre o sistema.</span></label>
          <input class="hp" tabindex="-1" autocomplete="off" aria-hidden="true" name="website" [(ngModel)]="f.website" />
          @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
          <button class="go" type="submit"><ax-icon name="send" [size]="16" /> Iniciar conversa no WhatsApp</button>
          <div class="note">Abre o WhatsApp com a mensagem pronta.</div>
        </form>
      </div>
    }
    <span class="tip" [class.show]="!open()" [class.peek]="peek()">Fale com a gente no WhatsApp</span>
    <button class="fab" type="button" [attr.aria-label]="open() ? 'Fechar conversa' : 'Falar com a equipe AXIONYX no WhatsApp'" [attr.aria-expanded]="open()" (click)="toggle()">
      <ax-icon [name]="open() ? 'x' : 'message-circle'" [size]="28" [stroke]="2.2" />
      @if (!open() && !seen()) { <span class="dot" aria-hidden="true"></span> }
    </button>
  }`,
})
export class WhatsappWidgetComponent implements OnInit {
  private api = inject(Api);
  /** esconde o botão (ex.: menu do celular aberto) */
  readonly hidden = input(false);
  readonly number = signal<string | null>(null);
  readonly open = signal(false); readonly seen = signal(false); readonly peek = signal(false);
  readonly tried = signal(false); readonly error = signal('');
  private nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  f = { name: '', phone: '', consent: false, website: '' };

  ngOnInit() {
    this.api.get<any>('/public/site').then((r) => this.number.set(r?.whatsapp || null)).catch(() => {});
    try { this.seen.set(sessionStorage.getItem('ax-wa-seen') === '1'); } catch { /* */ }
    setTimeout(() => { if (!this.open() && !this.seen()) { this.peek.set(true); setTimeout(() => this.peek.set(false), 5000); } }, 6000);
  }
  @HostListener('document:keydown.escape') esc() { if (this.open()) this.open.set(false); }

  toggle() {
    this.open.update((o) => !o); this.peek.set(false);
    if (this.open()) {
      this.seen.set(true); try { sessionStorage.setItem('ax-wa-seen', '1'); } catch { /* */ }
      setTimeout(() => this.nameInput()?.nativeElement.focus(), 50);
    }
  }
  digits() { return this.f.phone.replace(/\D/g, ''); }
  phoneOk() { const d = this.digits(); return d.length === 11 ? d[2] === '9' : d.length === 10; }
  setPhone(v: string) {
    const d = String(v || '').replace(/\D/g, '').slice(0, 11);
    this.f.phone = d.length <= 2 ? d : d.length <= 6 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d.length <= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : `(${d.slice(0, 2)}) ${d.slice(2, 3)} ${d.slice(3, 7)}-${d.slice(7)}`;
  }
  start() {
    this.tried.set(true); this.error.set('');
    const name = this.f.name.trim();
    if (name.length < 2) return this.error.set('Informe seu nome.');
    if (!this.phoneOk()) return this.error.set('Informe seu WhatsApp com DDD.');
    if (!this.f.consent) return this.error.set('Marque a autorização para conversarmos pelo WhatsApp.');
    const text = `Olá! Sou ${name}. Quero saber mais sobre o AXIONYX.`
    // abre já no clique (bloqueadores de pop-up recusam janelas abertas depois de uma espera)
    const url = `https://wa.me/${this.number()}?text=${encodeURIComponent(text)}`;
    const w = window.open(url, '_blank', 'noopener');
    if (!w) location.href = url;
    // registra o contato (com a autorização) para a equipe acompanhar em Contatos do site
    this.api.post('/public/leads', { name, phone: this.digits(), consent: true, message: 'Contato pelo botão do WhatsApp do site', website: this.f.website || undefined }).catch(() => {});
    this.open.set(false);
    this.f = { name: '', phone: '', consent: false, website: '' }; this.tried.set(false);
  }
}
