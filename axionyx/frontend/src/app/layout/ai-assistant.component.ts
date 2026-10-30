import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LogoComponent } from '../shared/logo.component';
import { IconComponent } from '../shared/icon.component';
import { Api } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';

type Engine = 'regras' | 'ia';
type Mode = 'geral' | 'juridico';
interface Source { type: 'tela' | 'documento'; label?: string; link?: string; id?: string; name?: string; page?: number | null; pages?: number[] }
interface Msg {
  role: 'user' | 'ai'; text: string; link?: string; engine?: Engine; actions?: { link: string; linkLabel?: string }[]
  sources?: Source[]; notice?: string; provider?: string; mode?: Mode; question?: string; forwarded?: number
}
const PREF = 'axionyx.axia';
const readPref = (): { engine?: Engine; mode?: Mode } => { try { return JSON.parse(localStorage.getItem(PREF) || '{}'); } catch { return {}; } };

/** AXIA — assistente do AXIONYX. Dois motores: regras (sempre disponível) e IA generativa (opcional, liberada por empresa). */
@Component({
  selector: 'ax-ai-assistant',
  imports: [LogoComponent, FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .seg { display:inline-flex; border:1px solid rgba(255,255,255,.18); border-radius:7px; overflow:hidden; }
    .seg button { border:0; background:transparent; color:#A8BCCF; font-size:11px; padding:4px 9px; cursor:pointer; font-weight:600; display:inline-flex; gap:4px; align-items:center; }
    .seg button.on { background:#0875D1; color:white; } .seg button:disabled { opacity:.45; cursor:not-allowed; }
    .chip { font-size:11px; padding:4px 9px; border-radius:999px; border:1px solid rgba(255,255,255,.18); background:transparent; color:#A8BCCF; cursor:pointer; display:inline-flex; gap:4px; align-items:center; font-weight:600; }
    .chip.on { background:#FFF4E0; color:#8A5B00; border-color:#F5E0B0; }
    .src { font-size:11px; padding:3px 8px; border-radius:6px; border:1px solid #DCE4EC; background:white; color:#3A4D5E; cursor:pointer; display:inline-flex; gap:4px; align-items:center; max-width:100%; }
    .src span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .act { font-size:11px; padding:4px 10px; border:1px solid #0875D1; border-radius:6px; background:white; color:#0875D1; cursor:pointer; font-weight:500; }
    .act.primary { background:#0875D1; color:white; font-weight:600; }
  `],
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:12px 16px 10px;border-bottom:1px solid #DCE4EC;background:#0B1F33">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:32px;height:32px;background:linear-gradient(135deg,#0875D1,#00A6D6);border-radius:8px;display:flex;align-items:center;justify-content:center"><ax-icon name="bot" [size]="17" color="white" /></div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:white">AXIA</div>
          <div style="font-size:11px;color:#00A6D6;display:flex;align-items:center;gap:4px"><span class="pulse-dot" style="width:6px;height:6px;background:#00A6D6;border-radius:50%"></span>{{ engine() === 'ia' ? 'IA generativa · ' + (status()?.providerLabel || '') : 'Motor de regras' }}</div>
        </div>
        <button (click)="close.emit()" class="btn-ghost" style="padding:4px;color:#647687" aria-label="Fechar"><ax-icon name="x" [size]="16" /></button>
      </div>
      @if (showToggle()) {
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <div class="seg" role="group" aria-label="Motor da AXIA">
            <button [class.on]="engine() === 'regras'" (click)="setEngine('regras')" title="Calcula dentro do AXIONYX. Nada sai do sistema."><ax-icon name="cpu" [size]="11" /> Regras</button>
            <button [class.on]="engine() === 'ia'" [disabled]="!status()?.available" (click)="setEngine('ia')" [title]="status()?.available ? 'Conversa, interpreta e lê documentos' : status()?.reasonText"><ax-icon name="sparkles" [size]="11" /> IA</button>
          </div>
          @if (engine() === 'ia') { <button class="chip" [class.on]="mode() === 'juridico'" (click)="setMode(mode() === 'juridico' ? 'geral' : 'juridico')" title="Pré-análise jurídica com base nos documentos da empresa"><ax-icon name="scale" [size]="11" /> Consulta jurídica</button> }
        </div>
        @if (!status()?.available && status()?.reasonText) { <div style="font-size:10.5px;color:#A8BCCF;margin-top:6px;line-height:1.4">{{ status()?.reasonText }}</div> }
      }
    </div>

    <div #scroll style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:16px;background:#F8FAFC">
      @for (m of messages(); track $index; let i = $index) {
        <div style="display:flex;gap:10px" [style.flex-direction]="m.role === 'user' ? 'row-reverse' : 'row'">
          @if (m.role === 'ai') { <ax-logo [size]="28" style="margin-top:2px" /> }
          <div style="max-width:85%;min-width:0">
            @if (m.notice) { <div style="font-size:11px;color:#8A5B00;background:#FFF8EB;border:1px solid #F5E0B0;border-radius:8px;padding:6px 9px;margin-bottom:6px;line-height:1.4">{{ m.notice }}</div> }
            <div [style.background]="m.role === 'user' ? '#0875D1' : 'white'" [style.color]="m.role === 'user' ? 'white' : '#172B3A'" [style.border]="m.role === 'ai' ? '1px solid ' + (m.mode === 'juridico' ? '#F5E0B0' : '#DCE4EC') : 'none'"
              [style.border-radius]="m.role === 'user' ? '12px 12px 4px 12px' : '4px 12px 12px 12px'" style="padding:10px 14px;font-size:13px;line-height:1.6;white-space:pre-line;overflow-wrap:anywhere">{{ m.text }}</div>
            @if (m.role === 'ai' && m.engine) {
              <div style="font-size:10px;color:#647687;margin-top:6px;padding-left:4px">{{ m.engine === 'ia' ? 'IA generativa (' + (m.provider || '') + ') sobre os dados do AXIONYX' : 'Fonte: dados do AXIONYX · motor de regras e estatística' }}{{ m.mode === 'juridico' ? ' · pré-análise jurídica' : '' }}</div>
            }
            @if (m.sources?.length) {
              <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
                @for (s of m.sources; track $index) { <button class="src" (click)="openSource(s)" [title]="srcLabel(s)"><ax-icon [name]="s.type === 'documento' ? 'file-text' : 'external-link'" [size]="11" /><span>{{ srcLabel(s) }}</span></button> }
              </div>
            }
            @if (m.link || m.actions?.length) {
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
                @if (m.link) { <button class="act primary" (click)="go(m.link)">{{ m.link.startsWith('diagnostico-lucro') ? 'Ver diagnóstico completo' : 'Abrir tela relacionada' }}</button> }
                @for (a of m.actions ?? []; track a.link) { <button class="act" (click)="go(a.link)">{{ a.linkLabel || 'Abrir' }}</button> }
              </div>
            }
            @if (m.role === 'ai' && m.mode === 'juridico' && m.engine === 'ia') {
              @if (m.forwarded) { <div style="font-size:11px;color:#145C36;margin-top:8px">Encaminhada ao jurídico (consulta nº {{ m.forwarded }}). <a class="link" (click)="go('consultas-juridicas')">Acompanhar</a></div> }
              @else if (forwarding() === i) {
                <div style="margin-top:8px;background:white;border:1px solid #DCE4EC;border-radius:8px;padding:8px">
                  <textarea class="input-field" rows="2" style="font-size:12px" [(ngModel)]="notes" placeholder="Observações para o jurídico (opcional)"></textarea>
                  <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px"><button class="act" (click)="forwarding.set(-1)">Cancelar</button><button class="act primary" [disabled]="busyFwd()" (click)="forward(i)">Enviar ao jurídico</button></div>
                </div>
              } @else { <div style="margin-top:8px"><button class="act" (click)="forwarding.set(i); notes = ''"><ax-icon name="scale" [size]="11" /> Encaminhar ao jurídico</button></div> }
            }
          </div>
        </div>
      }
      @if (loading()) {
        <div style="display:flex;gap:10px">
          <div style="width:28px;height:28px;background:linear-gradient(135deg,#0875D1,#00A6D6);border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><ax-icon name="refresh-cw" [size]="13" color="white" /></div>
          <div style="background:white;border:1px solid #DCE4EC;border-radius:4px 12px 12px 12px;padding:12px 16px;display:flex;gap:5px;align-items:center">
            @for (j of [0,1,2]; track j) { <span class="pulse-dot" style="width:7px;height:7px;background:#A0AFBF;border-radius:50%" [style.animation-delay]="j * 0.2 + 's'"></span> }
            @if (engine() === 'ia') { <span style="font-size:11px;color:#647687;margin-left:6px">consultando os dados…</span> }
          </div>
        </div>
      }
    </div>

    @if (messages().length === 1) {
      <div style="padding:8px 12px;border-top:1px solid #F0F4F8;background:white">
        <p style="font-size:11px;color:#647687;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">Sugestões</p>
        <div style="display:flex;flex-direction:column;gap:4px">
          @for (s of suggestions(); track s) {
            <button (click)="send(s)" style="text-align:left;background:#F4F7FA;border:1px solid #DCE4EC;border-radius:6px;padding:7px 10px;font-size:12px;color:#172B3A;cursor:pointer;display:flex;align-items:center;gap:8px"><ax-icon name="chevron-right" [size]="12" color="#0875D1" />{{ s }}</button>
          }
        </div>
      </div>
    }

    <div style="padding:10px 12px;border-top:1px solid #DCE4EC;background:white;display:flex;gap:8px">
      <input class="input-field" [(ngModel)]="input" (keydown.enter)="send(input)" [placeholder]="mode() === 'juridico' && engine() === 'ia' ? 'Descreva a dúvida jurídica…' : 'Pergunte à AXIA…'" style="flex:1;font-size:13px" />
      <button class="btn-primary" (click)="send(input)" style="padding:7px 12px" aria-label="Enviar"><ax-icon name="send" [size]="14" /></button>
    </div>
    <div style="padding:6px 12px;background:#F8FAFC;border-top:1px solid #F0F4F8">
      <p style="font-size:10px;color:#A0AFBF;text-align:center">{{ engine() === 'ia' ? (mode() === 'juridico' ? '⚖️ Pré-análise automática: não substitui o advogado. Decisões com risco: encaminhe ao jurídico.' : '⚠️ IA generativa: confira os números nas telas indicadas. Prontuário e salários nunca são enviados.') : '⚠️ A AXIA auxilia decisões — ações críticas requerem aprovação humana. Respostas calculadas com os dados do sistema.' }}</p>
    </div>
  </div>`,
})
export class AiAssistantComponent implements OnInit {
  private api = inject(Api); private router = inject(Router); private auth = inject(AuthService); private toast = inject(ToastService);
  readonly close = output<void>();
  readonly scroll = viewChild<ElementRef<HTMLElement>>('scroll');
  readonly loading = signal(false); readonly busyFwd = signal(false);
  readonly status = signal<any>(null);
  readonly engine = signal<Engine>('regras'); readonly mode = signal<Mode>('geral');
  readonly forwarding = signal(-1);
  input = ''; notes = '';
  readonly showToggle = computed(() => { const s = this.status(); return !!s && (s.available || ['nao_ativada', 'limite'].includes(s.reason)); });
  readonly suggestions = computed(() => {
    if (this.engine() === 'ia' && this.mode() === 'juridico') return ['O contrato de aluguel permite reajuste antes do aniversário?', 'Qual a multa prevista por atraso nos nossos contratos?', 'Posso trocar um produto em promoção pela nossa política?'];
    const base = [...(this.auth.can(['financeiro.ver', 'contabilidade.ver']) ? ['Por que meu lucro caiu?'] : this.auth.can(['vendas.ver', 'relatorios.ver']) ? ['Por que minhas vendas caíram?'] : [])];
    if (this.engine() === 'ia') return [...base, 'Resuma como está a empresa este mês', 'Quais contas vencem nos próximos 7 dias?', ...(this.status()?.documents ? ['O que diz o contrato com o fornecedor sobre reajuste?'] : [])];
    return [...base, 'Como foram as vendas de hoje?', 'Quais produtos estão abaixo do estoque mínimo?', 'Resumo de alertas', 'Quais são os produtos mais vendidos?', 'Títulos vencidos'];
  });
  readonly messages = signal<Msg[]>([{ role: 'ai', text: `Olá, ${(this.auth.me()?.user.name || '').split(' ')[0]}! Sou a AXIA. Consulto os dados reais do AXIONYX para responder sobre vendas, estoque, financeiro, condicionais e clientes, e faço um pré-diagnóstico quando o lucro ou as vendas caem. O que você gostaria de investigar?` }]);

  async ngOnInit() {
    try {
      const s = await this.api.get<any>('/ai/status'); this.status.set(s);
      const p = readPref();
      this.engine.set(s.available && p.engine !== 'regras' ? 'ia' : 'regras');
      this.mode.set(p.mode === 'juridico' ? 'juridico' : 'geral');
    } catch { /* sem IA: motor de regras */ }
  }
  private savePref() { try { localStorage.setItem(PREF, JSON.stringify({ engine: this.engine(), mode: this.mode() })); } catch { /* */ } }
  setEngine(e: Engine) { this.engine.set(e); this.savePref(); }
  setMode(m: Mode) { this.mode.set(m); this.savePref(); }

  async send(text: string) {
    if (!text?.trim() || this.loading()) return;
    const engine = this.engine(), mode = engine === 'ia' ? this.mode() : 'geral';
    const history = engine === 'ia' ? this.messages().slice(1).slice(-8).map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', text: m.text })) : undefined;
    this.messages.update((m) => [...m, { role: 'user', text }]);
    this.input = ''; this.loading.set(true); this.scrollDown();
    try {
      const r = await this.api.post<any>('/assistant/ask', { question: text, engine, mode, history });
      const actions = (r.actions ?? []).filter((a: any, i: number, arr: any[]) => a.link && arr.findIndex((b: any) => b.link === a.link) === i);
      this.messages.update((m) => [...m, { role: 'ai', text: clean(r.text), link: r.link, engine: r.engine, actions, sources: r.sources, notice: r.notice, provider: r.provider, mode: r.engine === 'ia' ? r.mode : 'geral', question: text }]);
      if (r.engine === 'regras' && engine === 'ia') this.api.get<any>('/ai/status').then((s) => this.status.set(s)).catch(() => {});
    } catch (e: any) {
      this.messages.update((m) => [...m, { role: 'ai', text: 'Não consegui consultar agora: ' + e.message }]);
    } finally { this.loading.set(false); this.scrollDown(); }
  }
  async forward(i: number) {
    const m = this.messages()[i]; if (!m) return;
    this.busyFwd.set(true);
    try {
      const r = await this.api.post<any>('/legal-consultations', { question: m.question || '', aiAnswer: m.text, aiProvider: m.provider, sources: (m.sources ?? []).map((s) => ({ type: s.type, id: s.id, name: s.name, page: s.page ?? null, label: s.label, link: s.link })), notes: this.notes.trim() || undefined });
      this.messages.update((list) => list.map((x, k) => (k === i ? { ...x, forwarded: r.number } : x)));
      this.forwarding.set(-1); this.toast.success(`Consulta nº ${r.number} encaminhada ao jurídico.`);
    } catch (e) { this.toast.error(e); } finally { this.busyFwd.set(false); }
  }
  srcLabel(s: Source) { return s.type === 'documento' ? `${s.name}${s.pages?.length ? ', p. ' + s.pages.join(', ') : s.page ? ', p. ' + s.page : ''}` : (s.label || s.link || ''); }
  openSource(s: Source) { this.router.navigateByUrl(s.type === 'documento' ? '/documentos' : '/' + s.link); }
  go(link: string) { this.router.navigateByUrl('/' + link); }
  private scrollDown() { setTimeout(() => { const el = this.scroll()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }); }
}

/** Remove marcações de markdown que o modelo às vezes devolve (o painel mostra texto simples). */
function clean(t: string) { return String(t || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '• '); }
