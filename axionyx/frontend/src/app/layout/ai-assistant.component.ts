import { ChangeDetectionStrategy, Component, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LogoComponent } from '../shared/logo.component';
import { IconComponent } from '../shared/icon.component';
import { Api } from '../core/api.service';
import { AuthService } from '../core/auth.service';

interface Msg { role: 'user' | 'ai'; text: string; link?: string; engine?: string; actions?: { link: string; linkLabel?: string }[] }

/** AXIA — assistente do AXIONYX. Responde com consultas reais aos dados (motor de regras). */
@Component({
  selector: 'ax-ai-assistant',
  imports: [LogoComponent, FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:12px 16px;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:10px;background:#0B1F33">
      <div style="width:32px;height:32px;background:linear-gradient(135deg,#0875D1,#00A6D6);border-radius:8px;display:flex;align-items:center;justify-content:center"><ax-icon name="bot" [size]="17" color="white" /></div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:700;color:white">AXIA</div>
        <div style="font-size:11px;color:#00A6D6;display:flex;align-items:center;gap:4px"><span class="pulse-dot" style="width:6px;height:6px;background:#00A6D6;border-radius:50%"></span>Assistente Inteligente</div>
      </div>
      <button (click)="close.emit()" class="btn-ghost" style="padding:4px;color:#647687" aria-label="Fechar"><ax-icon name="x" [size]="16" /></button>
    </div>

    <div #scroll style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:16px;background:#F8FAFC">
      @for (m of messages(); track $index) {
        <div style="display:flex;gap:10px" [style.flex-direction]="m.role === 'user' ? 'row-reverse' : 'row'">
          @if (m.role === 'ai') { <ax-logo [size]="28" style="margin-top:2px" /> }
          <div style="max-width:85%">
            <div [style.background]="m.role === 'user' ? '#0875D1' : 'white'" [style.color]="m.role === 'user' ? 'white' : '#172B3A'" [style.border]="m.role === 'ai' ? '1px solid #DCE4EC' : 'none'"
              [style.border-radius]="m.role === 'user' ? '12px 12px 4px 12px' : '4px 12px 12px 12px'" style="padding:10px 14px;font-size:13px;line-height:1.6;white-space:pre-line">{{ m.text }}</div>
            @if (m.role === 'ai' && m.engine) {
              <div style="display:flex;align-items:center;gap:8px;margin-top:6px;padding-left:4px"><span style="font-size:10px;color:#647687">Fonte: dados do AXIONYX · motor de regras e estatística</span></div>
            }
            @if (m.link) {
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
                <button (click)="go(m.link)" style="font-size:11px;padding:4px 10px;border:1px solid #0875D1;border-radius:6px;background:#0875D1;color:white;cursor:pointer;font-weight:600">{{ m.link.startsWith('diagnostico-lucro') ? 'Ver diagnóstico completo' : 'Abrir tela relacionada' }}</button>
                @for (a of m.actions ?? []; track a.link) { <button (click)="go(a.link)" style="font-size:11px;padding:4px 10px;border:1px solid #0875D1;border-radius:6px;background:white;color:#0875D1;cursor:pointer;font-weight:500">{{ a.linkLabel || 'Abrir' }}</button> }
              </div>
            }
          </div>
        </div>
      }
      @if (loading()) {
        <div style="display:flex;gap:10px">
          <div style="width:28px;height:28px;background:linear-gradient(135deg,#0875D1,#00A6D6);border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><ax-icon name="refresh-cw" [size]="13" color="white" /></div>
          <div style="background:white;border:1px solid #DCE4EC;border-radius:4px 12px 12px 12px;padding:12px 16px;display:flex;gap:5px;align-items:center">
            @for (j of [0,1,2]; track j) { <span class="pulse-dot" style="width:7px;height:7px;background:#A0AFBF;border-radius:50%" [style.animation-delay]="j * 0.2 + 's'"></span> }
          </div>
        </div>
      }
    </div>

    @if (messages().length === 1) {
      <div style="padding:8px 12px;border-top:1px solid #F0F4F8;background:white">
        <p style="font-size:11px;color:#647687;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">Sugestões</p>
        <div style="display:flex;flex-direction:column;gap:4px">
          @for (s of suggestions; track s) {
            <button (click)="send(s)" style="text-align:left;background:#F4F7FA;border:1px solid #DCE4EC;border-radius:6px;padding:7px 10px;font-size:12px;color:#172B3A;cursor:pointer;display:flex;align-items:center;gap:8px"><ax-icon name="chevron-right" [size]="12" color="#0875D1" />{{ s }}</button>
          }
        </div>
      </div>
    }

    <div style="padding:10px 12px;border-top:1px solid #DCE4EC;background:white;display:flex;gap:8px">
      <input class="input-field" [(ngModel)]="input" (keydown.enter)="send(input)" placeholder="Pergunte à AXIA..." style="flex:1;font-size:13px" />
      <button class="btn-primary" (click)="send(input)" style="padding:7px 12px" aria-label="Enviar"><ax-icon name="send" [size]="14" /></button>
    </div>
    <div style="padding:6px 12px;background:#F8FAFC;border-top:1px solid #F0F4F8">
      <p style="font-size:10px;color:#A0AFBF;text-align:center">⚠️ A AXIA auxilia decisões — ações críticas requerem aprovação humana. Respostas calculadas com os dados do sistema.</p>
    </div>
  </div>`,
})
export class AiAssistantComponent {
  private api = inject(Api);
  private router = inject(Router);
  private auth = inject(AuthService);
  readonly close = output<void>();
  readonly scroll = viewChild<ElementRef<HTMLElement>>('scroll');
  readonly loading = signal(false);
  input = '';
  readonly suggestions = [...(this.auth.can(['financeiro.ver', 'contabilidade.ver']) ? ['Por que meu lucro caiu?'] : this.auth.can(['vendas.ver', 'relatorios.ver']) ? ['Por que minhas vendas caíram?'] : []), 'Como foram as vendas de hoje?', 'Quais produtos estão abaixo do estoque mínimo?', 'Resumo de alertas', 'Quais são os produtos mais vendidos?', 'Títulos vencidos'];
  readonly messages = signal<Msg[]>([{ role: 'ai', text: `Olá, ${(this.auth.me()?.user.name || '').split(' ')[0]}! Sou a AXIA. Consulto os dados reais do AXIONYX para responder sobre vendas, estoque, financeiro, condicionais e clientes, e faço um pré-diagnóstico quando o lucro ou as vendas caem. O que você gostaria de investigar?` }]);

  async send(text: string) {
    if (!text?.trim() || this.loading()) return;
    this.messages.update((m) => [...m, { role: 'user', text }]);
    this.input = ''; this.loading.set(true); this.scrollDown();
    try {
      const r = await this.api.post<any>('/assistant/ask', { question: text });
      this.messages.update((m) => [...m, { role: 'ai', text: r.text, link: r.link, engine: r.engine, actions: (r.actions ?? []).filter((a: any, i: number, arr: any[]) => a.link && arr.findIndex((b: any) => b.link === a.link) === i) }]);
    } catch (e: any) {
      this.messages.update((m) => [...m, { role: 'ai', text: 'Não consegui consultar agora: ' + e.message }]);
    } finally { this.loading.set(false); this.scrollDown(); }
  }
  go(link: string) { this.router.navigateByUrl('/' + link); }
  private scrollDown() { setTimeout(() => { const el = this.scroll()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }); }
}
