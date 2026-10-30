import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { FMT, num } from '../../core/format';

/** IA generativa da plataforma: chaves (cifradas) de Anthropic, OpenAI e Gemini, provedor oferecido, modelos e liberação por empresa. */
@Component({
  selector: 'ax-plataforma-ia',
  imports: [FormsModule, IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .prov { border:1px solid #E3EAF1; border-radius:12px; padding:16px; background:white; display:flex; flex-direction:column; gap:10px; }
    .prov.on { border-color:#0875D1; box-shadow:0 0 0 3px #E3EFF9; }
    .lbl { font-size:11px; font-weight:600; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; display:block; }
    .pill { font-size:11px; padding:2px 8px; border-radius:999px; font-weight:600; }
    .ok { background:#E8F6EE; color:#145C36; } .no { background:#F1F4F7; color:#647687; } .bad { background:#FDECEC; color:#8A1F1F; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .grid3 { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px; }
    @media (max-width: 1000px) { .grid3 { grid-template-columns:1fr; } }
  `],
  template: `
  <div style="padding:24px;max-width:1200px;display:flex;flex-direction:column;gap:16px">
    <div>
      <h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="bot" [size]="20" color="#0875D1" /> Inteligência Artificial (provedores)</h1>
      <p style="font-size:13px;color:#647687;margin-top:4px">Cadastre as chaves, escolha qual provedor as empresas vão usar e libere a IA por empresa. O motor de regras continua disponível para todos.</p>
    </div>
    @if (s(); as s) {
      <div class="grid3">
        @for (p of s.providers; track p.id) {
          <div class="prov" [class.on]="s.provider === p.id">
            <div class="row" style="justify-content:space-between">
              <div><div style="font-size:15px;font-weight:700;color:#172B3A">{{ p.label }}</div><div class="muted" style="font-size:12px">{{ p.vendor }}</div></div>
              @if (s.provider === p.id) { <span class="pill ok">Oferecido às empresas</span> }
            </div>
            <div>
              <span class="lbl">Chave da API</span>
              @if (s.keys[p.id]; as k) {
                @if (k.env) { <div class="row"><span class="pill ok">Variável {{ p.env }}</span><span class="muted" style="font-size:11px">tem prioridade sobre a chave do painel</span></div> }
                @else if (k.unreadable) { <div class="row"><span class="pill bad">Não pode ser lida</span><span class="muted" style="font-size:11px">a chave mestra mudou; digite a chave de novo</span></div> }
                @else if (k.saved) { <div class="row"><span class="pill ok">Cadastrada ••••{{ k.last4 }}</span><span class="muted" style="font-size:11px">{{ k.updatedBy }} · {{ k.updatedAt | dt }}</span></div> }
                @else { <span class="pill no">Sem chave</span> }
              }
              <div class="row" style="margin-top:8px">
                <input class="input-field" style="flex:1;min-width:160px;font-size:12px" type="password" autocomplete="off" [placeholder]="s.keys[p.id]?.saved ? 'Nova chave (substitui a atual)' : 'Cole a chave aqui'" [(ngModel)]="keyInput[p.id]" />
                <button class="btn-primary" style="font-size:12px" [disabled]="!keyInput[p.id] || busy()" (click)="saveKey(p.id)"><ax-icon name="lock" [size]="12" /> Salvar</button>
                @if (s.keys[p.id]?.saved) { <button class="btn-ghost" style="font-size:12px;color:#C93636" [disabled]="busy()" (click)="removeKey(p.id)">Remover</button> }
              </div>
              <a class="link" style="font-size:11px" [href]="p.console" target="_blank" rel="noopener">Gerar chave em {{ p.console.replace('https://', '') }}</a>
            </div>
            <div>
              <span class="lbl">Modelo</span>
              <div class="row">
                <input class="input-field" style="flex:1;min-width:140px;font-size:12px" [attr.list]="'models-' + p.id" [(ngModel)]="model[p.id]" [placeholder]="p.defaultModel" />
                <datalist [id]="'models-' + p.id">@for (m of models()[p.id] ?? []; track m) { <option [value]="m"></option> }</datalist>
                <button class="btn-ghost" style="font-size:12px" [disabled]="!s.keys[p.id]?.configured || busy()" (click)="loadModels(p.id)">Carregar modelos</button>
              </div>
              @if (modelsError()[p.id]) { <div style="font-size:11px;color:#C93636;margin-top:4px">{{ modelsError()[p.id] }}</div> }
            </div>
            <div class="row" style="margin-top:auto">
              <button class="btn-secondary" style="font-size:12px" [disabled]="!s.keys[p.id]?.configured || busy()" (click)="test(p.id)"><ax-icon name="send" [size]="12" /> Testar conexão</button>
              @if (s.provider !== p.id) { <button class="btn-primary" style="font-size:12px" [disabled]="!s.keys[p.id]?.configured || busy()" (click)="choose(p.id)">Oferecer às empresas</button> }
            </div>
            @if (tests()[p.id]; as t) {
              <div style="font-size:12px;padding:8px 10px;border-radius:8px" [style.background]="t.ok ? '#E8F6EE' : '#FDECEC'" [style.color]="t.ok ? '#145C36' : '#8A1F1F'">
                {{ t.ok ? 'Funcionando com ' + t.model + ' (' + t.ms + ' ms).' : t.error }}
                @if (!t.ok && t.error?.includes('Modelo não encontrado')) { <div style="margin-top:6px;font-weight:600">Clique em "Carregar modelos", escolha um modelo da lista, teste de novo e depois clique em "Salvar configurações".</div> }</div>
            }
          </div>
        }
      </div>

      <div class="card" style="padding:16px;display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:16px;align-items:end">
        <div><span class="lbl">Provedor oferecido</span>
          <select class="input-field" [ngModel]="s.provider ?? ''" (ngModelChange)="choose($event || null)"><option value="">Nenhum (somente motor de regras)</option>@for (p of s.providers; track p.id) { <option [value]="p.id" [disabled]="!s.keys[p.id]?.configured">{{ p.label }} ({{ p.vendor }})</option> }</select></div>
        <div><span class="lbl">Quais empresas podem usar</span>
          <select class="input-field" [(ngModel)]="availability"><option value="liberadas">Só as que eu liberar abaixo</option><option value="todas">Todas as empresas</option></select></div>
        <div><span class="lbl">Limite mensal padrão (perguntas por empresa)</span><input class="input-field" type="number" min="0" [(ngModel)]="limit" /></div>
        <div><button class="btn-primary" [disabled]="busy()" (click)="saveSettings()"><ax-icon name="check" [size]="13" /> Salvar configurações</button></div>
      </div>

      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
          <span style="font-size:13px;font-weight:700;color:#172B3A">Empresas</span>
          <input class="input-field" style="width:220px;font-size:12px" placeholder="Filtrar empresa" [(ngModel)]="filter" /></div>
        <div style="overflow-x:auto">
          <table class="data-table" style="width:100%;border-collapse:collapse;min-width:720px">
            <thead><tr><th>Empresa</th><th style="text-align:center">Liberada</th><th style="text-align:center">Ativada pela empresa</th><th style="text-align:right">Uso no mês</th><th style="text-align:right">Limite próprio</th></tr></thead>
            <tbody>@for (c of companies(); track c.id) {
              <tr>
                <td><div style="font-weight:600">{{ c.trade_name || c.name }}</div><div class="muted" style="font-size:11px">{{ c.segment }}{{ c.is_demo ? ' · demonstração' : '' }}</div></td>
                <td style="text-align:center">@if (s.availability === 'todas') { <span class="pill ok">Todas</span> } @else { <input type="checkbox" [checked]="c.allowed" (change)="allow(c, $any($event.target).checked)" [attr.aria-label]="'Liberar ' + c.name" /> }</td>
                <td style="text-align:center">@if (c.enabled) { <span class="pill ok">Sim</span> } @else { <span class="pill no">Não</span> }</td>
                <td class="mono" style="text-align:right;font-size:12px">{{ c.used }} / {{ c.monthly_limit ?? s.defaultMonthlyLimit }}<div class="muted" style="font-size:10px">{{ tokens(c.tokens) }} tokens</div></td>
                <td style="text-align:right"><input class="input-field" type="number" min="0" style="width:96px;font-size:12px;text-align:right" [placeholder]="'' + s.defaultMonthlyLimit" [ngModel]="c.monthly_limit" (change)="setLimit(c, $any($event.target).value)" /></td>
              </tr>
            }</tbody>
          </table>
        </div>
      </div>

      <div class="card" style="padding:16px;font-size:12.5px;color:#334B5F;line-height:1.6">
        <div style="font-weight:700;font-size:13px;color:#172B3A;margin-bottom:6px;display:flex;gap:6px;align-items:center"><ax-icon name="shield-check" [size]="14" color="#18864B" /> Segurança e privacidade</div>
        • As chaves digitadas aqui ficam cifradas no banco (AES-256-GCM, chave mestra em <span class="mono">{{ s.encryption }}</span>) e nunca voltam para o navegador. Se a variável de ambiente do provedor existir, ela tem prioridade.<br />
        • @if (s.encryption !== 'ENCRYPTION_KEY') { Recomendado: crie a variável <span class="mono">ENCRYPTION_KEY</span> no Railway. Hoje a chave mestra vem do <span class="mono">JWT_SECRET</span>; se ele for trocado, será preciso digitar as chaves de novo. } @else { Chave mestra própria configurada. }<br />
        • A IA só consulta o que o usuário já pode ver; prontuário, dados clínicos e salários nunca são enviados. Cada pergunta fica registrada (sem a resposta) para auditoria e para o limite mensal.<br />
        • Defina também um limite de gasto no painel do provedor. Os dados enviados seguem os termos de uso por API de cada provedor; atualize os termos de uso e a política de privacidade do AXIONYX.
      </div>
    }
  </div>`,
})
export class PlataformaIaPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService);
  readonly s = signal<any>(null); readonly busy = signal(false);
  readonly models = signal<Record<string, string[]>>({}); readonly modelsError = signal<Record<string, string>>({}); readonly tests = signal<Record<string, any>>({});
  keyInput: Record<string, string> = {}; model: Record<string, string> = {}; availability = 'liberadas'; limit = 300; filter = '';
  readonly companies = computed(() => { const f = this.filter.toLowerCase(); return (this.s()?.companies ?? []).filter((c: any) => !f || (c.trade_name || c.name).toLowerCase().includes(f)); });
  async ngOnInit() { await this.load(); }
  async load() {
    const s = await this.api.get<any>('/platform/ai'); this.s.set(s);
    this.availability = s.availability; this.limit = s.defaultMonthlyLimit;
    for (const p of s.providers) this.model[p.id] = p.model;
  }
  private async run(fn: () => Promise<any>, ok?: string) { this.busy.set(true); try { await fn(); if (ok) this.toast.success(ok); await this.load(); } catch (e) { this.toast.error(e); } finally { this.busy.set(false); } }
  saveKey(p: string) { const key = (this.keyInput[p] || '').trim(); this.run(async () => { await this.api.put(`/platform/ai/keys/${p}`, { key }); this.keyInput[p] = ''; }, 'Chave salva (cifrada).'); }
  removeKey(p: string) { if (!confirm('Remover a chave deste provedor?')) return; this.run(() => this.api.put(`/platform/ai/keys/${p}`, { key: '' }), 'Chave removida.'); }
  choose(p: string | null) { this.run(() => this.api.put('/platform/ai', { provider: p ?? '', models: this.model }), p ? 'Provedor oferecido às empresas.' : 'IA generativa desligada para as empresas.'); }
  saveSettings() { this.run(() => this.api.put('/platform/ai', { models: this.model, availability: this.availability, defaultMonthlyLimit: Number(this.limit) || 0 }), 'Configurações salvas.'); }
  async loadModels(p: string) {
    this.busy.set(true);
    try { const r = await this.api.get<any>(`/platform/ai/models/${p}`); this.models.update((m) => ({ ...m, [p]: r.models })); this.modelsError.update((m) => ({ ...m, [p]: r.error ? r.error : r.models.length ? '' : 'Nenhum modelo retornado.' })); if (r.models.length) this.toast.success(`${r.models.length} modelos disponíveis. Escolha no campo Modelo.`); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async test(p: string) {
    this.busy.set(true);
    try { const r = await this.api.post<any>('/platform/ai/test', { provider: p, model: this.model[p] }); this.tests.update((t) => ({ ...t, [p]: r })); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  allow(c: any, allowed: boolean) { this.run(() => this.api.put(`/platform/ai/companies/${c.id}`, { allowed }), allowed ? 'IA liberada para a empresa.' : 'IA bloqueada para a empresa.'); }
  setLimit(c: any, v: string) { const n = v === '' ? null : Math.max(0, Number(v) || 0); this.run(() => this.api.put(`/platform/ai/companies/${c.id}`, { monthlyLimit: n }), 'Limite atualizado.'); }
  tokens(n: any) { return num(Number(n) || 0, 0); }
}
