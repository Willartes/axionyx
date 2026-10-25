import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, STATUS_PIPES } from '../../core/format';

const PURPOSE_LABEL: Record<string, string> = { cobranca: 'Cobrança (crediário/parcelas)', condicional: 'Lembrete de condicional', aniversario: 'Aniversário', pos_venda: 'Pós-venda', campanha: 'Campanha', atendimento: 'Atendimento' };

/** Configuração do WhatsApp da empresa selecionada: número, credenciais da Meta, webhook e modelos por finalidade. */
@Component({
  selector: 'ax-whatsapp-config',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px;max-width:1100px">
    <button class="btn-ghost" style="font-size:12px;margin-bottom:8px" (click)="router.navigateByUrl('/integracoes')"><ax-icon name="arrow-left" [size]="13" /> Integrações</button>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">WhatsApp da empresa</h1>
        <p style="font-size:13px;color:#647687">Número oficial desta empresa na WhatsApp Business Platform (Cloud API da Meta). Cada empresa cadastrada usa o próprio número.</p></div>
      @if (c(); as c) { <span class="badge" style="font-size:12px;padding:4px 10px" [class]="'badge ' + (c.status | statusClass)">{{ c.status | statusLabel }}</span> }
    </div>
    <ax-state [loading]="!c()" />
    @if (c(); as c) {
      @if (c.serverFallback) { <div class="state-info" style="margin:0 0 12px"><ax-icon name="info" [size]="14" /><span>Esta empresa está usando o número global definido nas variáveis do servidor. Cadastre abaixo o número próprio da empresa para substituí-lo.</span></div> }
      @if (c.lastError) { <div class="state-error" style="margin:0 0 12px"><ax-icon name="alert-triangle" [size]="14" /><span>{{ c.lastError }}</span></div> }

      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:16px">
        <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">Número</div><div style="font-size:18px;font-weight:700">{{ c.displayPhone ? (c.displayPhone | phone) : '—' }}</div><div style="font-size:11px;color:#647687">{{ c.verifiedName || 'nome não verificado' }}</div></div>
        <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">Enviadas (30 dias)</div><div style="font-size:18px;font-weight:700">{{ c.stats.sent_30d }}</div><div style="font-size:11px;color:#647687">{{ c.stats.received_30d }} recebida(s)</div></div>
        <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">Erros (7 dias)</div><div style="font-size:18px;font-weight:700" [style.color]="c.stats.errors_7d ? '#C93636' : null">{{ c.stats.errors_7d }}</div><div style="font-size:11px;color:#647687">{{ c.stats.waiting }} aguardando configuração</div></div>
        <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;margin-bottom:6px">Webhook</div><div style="font-size:18px;font-weight:700" [style.color]="c.webhookVerifiedAt ? '#18864B' : '#D99000'">{{ c.webhookVerifiedAt ? 'Conectado' : 'Pendente' }}</div><div style="font-size:11px;color:#647687">confirmações e respostas</div></div>
      </div>

      <!-- 1. Número e credenciais -->
      <div class="card" style="padding:16px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><div style="font-size:14px;font-weight:700">1. Número e credenciais da Meta</div>
          <button class="btn-ghost" style="font-size:12px" (click)="help.set(true)"><ax-icon name="help-circle" [size]="13" /> Onde encontro esses dados?</button></div>
        <div class="form-grid-2">
          <div><label class="field-label">Número de WhatsApp da empresa *</label><input class="input-field mono" [(ngModel)]="f.displayPhone" placeholder="(11) 99999-9999" [disabled]="!canEdit" /></div>
          <div><label class="field-label">Phone Number ID (identificação do número) *</label><input class="input-field mono" [(ngModel)]="f.phoneNumberId" placeholder="Ex.: 109876543210987" [disabled]="!canEdit" /></div>
          <div><label class="field-label">ID da conta do WhatsApp Business (WABA ID) <span class="muted">— para buscar os modelos</span></label><input class="input-field mono" [(ngModel)]="f.wabaId" placeholder="Ex.: 123456789012345" [disabled]="!canEdit" /></div>
          <div><label class="field-label">Versão da API <span class="muted">(opcional)</span></label><input class="input-field mono" [(ngModel)]="f.apiVersion" placeholder="v21.0" [disabled]="!canEdit" /></div>
          <div class="span-all"><label class="field-label">Token de acesso permanente {{ c.hasToken ? '(salvo: ' + c.tokenHint + ' — deixe em branco para manter)' : '*' }}</label>
            <input class="input-field mono" type="password" autocomplete="new-password" [(ngModel)]="f.accessToken" [placeholder]="c.hasToken ? 'Token já cadastrado' : 'EAAG...'" [disabled]="!canEdit" /></div>
          <div class="span-all"><label class="field-label">App Secret (chave secreta do app) {{ c.hasAppSecret ? '(salvo — deixe em branco para manter)' : '— necessário para receber confirmações e respostas' }}</label>
            <input class="input-field mono" type="password" autocomplete="new-password" [(ngModel)]="f.appSecret" [placeholder]="c.hasAppSecret ? 'Já cadastrado' : 'Configurações do app › Básico › Chave secreta'" [disabled]="!canEdit" /></div>
        </div>
        <p style="font-size:11px;color:#647687;margin-top:8px">O token e o App Secret são cifrados no banco (AES-256) e nunca voltam para o navegador. Ao salvar credenciais novas, o sistema testa na Meta e, se estiver tudo certo, já ativa o WhatsApp desta empresa.</p>
        @if (canEdit) {
          <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px">
            @if (c.hasToken) { <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="removeCreds()">Remover credenciais</button> }
            @if (c.status === 'ativo') { <button class="btn-secondary" style="font-size:12px" (click)="deactivate()">Desativar envio</button> }
            @if (c.hasToken) { <button class="btn-secondary" style="font-size:12px" [disabled]="busy()" (click)="test()"><ax-icon name="plug" [size]="13" /> Testar e ativar</button> }
            <button class="btn-primary" style="font-size:12px" [disabled]="busy() || !f.displayPhone || !f.phoneNumberId || (!c.hasToken && !f.accessToken)" (click)="save()"><ax-icon name="save" [size]="13" /> Salvar e ativar</button>
          </div>
        }
        @if (c.testedAt) { <div class="state-info" style="margin:10px 0 0;font-size:12px"><ax-icon name="check-circle-2" [size]="14" /><span>Validado na Meta em {{ c.testedAt | dtt }}: {{ c.verifiedName }}@if (c.qualityRating) { · qualidade {{ c.qualityRating }} }.</span></div> }
      </div>

      <!-- 2. Webhook -->
      <div class="card" style="padding:16px;margin-bottom:16px">
        <div style="font-size:14px;font-weight:700;margin-bottom:4px">2. Webhook (confirmações de entrega/leitura e respostas dos clientes)</div>
        <p style="font-size:12px;color:#647687;margin-bottom:10px">No painel da Meta: seu app › <b>WhatsApp › Configuração</b> › Webhook › <b>Editar</b>. Cole a URL e o token abaixo, clique em "Verificar e salvar" e depois assine o campo <b>messages</b>. Com o webhook, o sistema sabe se o cliente escreveu nas últimas 24 h e mostra "entregue" e "lido" no histórico.</p>
        <div class="form-grid-2">
          <div class="span-all"><label class="field-label">URL de retorno (Callback URL)</label><div style="display:flex;gap:6px"><input class="input-field mono" style="font-size:12px" [value]="c.webhookUrl" readonly /><button class="btn-secondary" style="font-size:12px" (click)="copy(c.webhookUrl)"><ax-icon name="copy" [size]="13" /></button></div></div>
          <div class="span-all"><label class="field-label">Token de verificação (Verify token)</label><div style="display:flex;gap:6px"><input class="input-field mono" style="font-size:12px" [value]="c.verifyToken || 'Salve as credenciais para gerar'" readonly /><button class="btn-secondary" style="font-size:12px" [disabled]="!c.verifyToken" (click)="copy(c.verifyToken)"><ax-icon name="copy" [size]="13" /></button></div></div>
        </div>
        @if (!c.hasAppSecret) { <div class="state-warning" style="margin:10px 0 0;font-size:12px"><ax-icon name="alert-triangle" [size]="13" /><span>Cadastre o App Secret no passo 1: sem ele o sistema recusa os avisos da Meta (não dá para confirmar que vieram dela).</span></div> }
        @if (c.webhookUrl.startsWith('http://')) { <div class="state-warning" style="margin:10px 0 0;font-size:12px"><ax-icon name="alert-triangle" [size]="13" /><span>A Meta só aceita endereço público com https — use o endereço publicado (ex.: Railway), não o localhost.</span></div> }
      </div>

      <!-- 3. Modelos -->
      <div class="card" style="overflow:hidden;margin-bottom:16px">
        <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div><div style="font-size:14px;font-weight:700">3. Modelos de mensagem por finalidade</div>
            <div style="font-size:12px;color:#647687">Fora da janela de 24 h a Meta só entrega <b>modelos aprovados</b>. Crie-os no WhatsApp Manager, sincronize aqui e escolha qual usar em cada finalidade e o que vai em cada variável.</div></div>
          @if (canEdit) { <div style="display:flex;gap:8px"><button class="btn-secondary" style="font-size:12px" (click)="newTpl()"><ax-icon name="plus" [size]="13" /> Cadastrar manualmente</button>
            <button class="btn-primary" style="font-size:12px" [disabled]="busy() || !c.wabaId || !c.hasToken" [title]="c.wabaId ? '' : 'Informe o WABA ID no passo 1'" (click)="sync()"><ax-icon name="refresh-cw" [size]="13" /> Sincronizar com a Meta</button></div> }
        </div>
        <ax-state [loading]="tplLoading()" [empty]="!tplLoading() && !templates().length" emptyText="Nenhum modelo. Sincronize com a Meta ou cadastre o nome de um modelo aprovado." emptyIcon="message-square" />
        @if (templates().length) {
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>Modelo</th><th>Situação na Meta</th><th style="min-width:200px">Usar para</th><th style="min-width:260px">Variáveis</th><th></th></tr></thead>
            <tbody>@for (t of templates(); track t.id) {
              <tr><td><div style="font-weight:600" class="mono">{{ t.name }} <span class="muted" style="font-weight:400">{{ t.language }}</span></div>
                  @if (t.body) { <div style="font-size:11px;color:#647687;max-width:340px;white-space:pre-wrap">{{ t.body }}</div> }</td>
                <td><span class="badge" [class.badge-success]="t.status === 'APPROVED'" [class.badge-warning]="t.status === 'PENDING'" [class.badge-danger]="t.status === 'REJECTED' || t.status === 'PAUSED' || t.status === 'DISABLED'">{{ statusTpl(t.status) }}</span>
                  <div style="font-size:10px;color:#647687">{{ t.category || '' }} {{ t.source === 'meta' ? '· sincronizado' : '· manual' }}</div></td>
                <td><select class="input-field" style="font-size:12px;padding:4px 6px" [ngModel]="t.purpose || ''" (ngModelChange)="setPurpose(t, $event)" [disabled]="!canEdit || t.status !== 'APPROVED'">
                  <option value="">— não usar automaticamente —</option>@for (p of purposes; track p[0]) { <option [value]="p[0]">{{ p[1] }}</option> }</select></td>
                <td>@if (placeholders(t.body); as n) {
                    @for (k of range(n); track k) { <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><span class="mono" style="font-size:11px;width:38px">{{ ph(k + 1) }}</span>
                      <select class="input-field" style="font-size:12px;padding:3px 6px" [ngModel]="t.variables[k] || ''" (ngModelChange)="setVar(t, k, $event, n)" [disabled]="!canEdit">
                        <option value="">escolha…</option>@for (fd of fieldList(); track fd[0]) { <option [value]="fd[0]">{{ fd[1] }}</option> }</select></div> }
                  } @else { <span style="font-size:11px;color:#647687">Sem variáveis</span> }</td>
                <td>@if (canEdit) { <button class="btn-ghost" title="Enviar teste" (click)="openTest(t)"><ax-icon name="send" [size]="13" /></button>
                  <button class="btn-ghost" title="Remover" style="color:#C93636" (click)="removeTpl(t)"><ax-icon name="trash-2" [size]="13" /></button> }</td></tr>
            }</tbody></table></div>
        }
      </div>

      <!-- 4. Teste -->
      @if (canEdit && c.hasToken) {
        <div class="card" style="padding:16px">
          <div style="font-size:14px;font-weight:700;margin-bottom:6px">4. Enviar mensagem de teste</div>
          <p style="font-size:12px;color:#647687;margin-bottom:10px">Sem escolher modelo, é enviado o modelo padrão <span class="mono">hello_world</span> que a Meta cria em toda conta (em inglês). Use o seu próprio celular.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div style="flex:1;min-width:200px"><label class="field-label">Número de destino</label><input class="input-field mono" [(ngModel)]="testTo" placeholder="(11) 98888-7777" /></div>
            <button class="btn-primary" style="font-size:12px" [disabled]="busy() || digits(testTo) < 10" (click)="sendTest(null)"><ax-icon name="send" [size]="13" /> Enviar teste</button>
          </div>
        </div>
      }
    }
  </div>

  <ax-modal [open]="help()" (closed)="help.set(false)" title="Onde encontrar os dados no painel da Meta" icon="help-circle" [width]="640">
    <ol style="font-size:13px;line-height:1.7;padding-left:18px;color:#172B3A">
      <li>Acesse <b>developers.facebook.com</b> › Meus apps › seu app (tipo Empresa) › <b>WhatsApp › Configuração da API</b>.</li>
      <li>Em "Enviar e receber mensagens", escolha o número da empresa: ali aparecem o <b>Phone Number ID</b> (identificação do número de telefone) e o <b>WhatsApp Business Account ID</b> (WABA ID).</li>
      <li><b>Token permanente:</b> business.facebook.com › Configurações do negócio › Usuários › <b>Usuários do sistema</b> › crie um usuário Admin › Atribuir ativos (o app e a conta do WhatsApp) › <b>Gerar token</b> com validade "Nunca" e as permissões <span class="mono">whatsapp_business_messaging</span> e <span class="mono">whatsapp_business_management</span>. O token temporário da tela de teste expira em 24 h — não use.</li>
      <li><b>App Secret:</b> no app, Configurações do app › Básico › <b>Chave secreta do app</b> › Mostrar.</li>
      <li><b>Modelos:</b> business.facebook.com › WhatsApp Manager › <b>Modelos de mensagem</b>. Ex.: categoria "Utilidade", nome <span class="mono">lembrete_parcela</span>, texto "Olá {{ L }}1{{ R }}, sua parcela de {{ L }}2{{ R }} vence em {{ L }}3{{ R }}." — depois de aprovado, sincronize aqui e associe {{ L }}1{{ R }}=Primeiro nome, {{ L }}2{{ R }}=Valor, {{ L }}3{{ R }}=Vencimento.</li>
      <li>O número usado na API não pode estar ativo no aplicativo WhatsApp do celular. A Meta cobra pelas conversas iniciadas pela empresa (cadastre a forma de pagamento no WhatsApp Manager).</li>
    </ol>
    <div footer><button class="btn-primary" (click)="help.set(false)">Entendi</button></div>
  </ax-modal>

  <ax-modal [open]="!!tf" (closed)="tf = null" title="Cadastrar modelo aprovado" icon="message-square" [width]="560">
    @if (tf) {
      <div class="form-grid-2">
        <div><label class="field-label">Nome exato do modelo na Meta *</label><input class="input-field mono" [(ngModel)]="tf.name" placeholder="lembrete_parcela" /></div>
        <div><label class="field-label">Idioma</label><input class="input-field mono" [(ngModel)]="tf.language" placeholder="pt_BR" /></div>
        <div class="span-all"><label class="field-label">Texto do corpo (copie do WhatsApp Manager, com {{ L }}1{{ R }}, {{ L }}2{{ R }}…)</label><textarea class="input-field" rows="4" [(ngModel)]="tf.body"></textarea></div>
        <div class="span-all"><label class="field-label">Usar para</label><select class="input-field" [(ngModel)]="tf.purpose"><option value="">— não usar automaticamente —</option>@for (p of purposes; track p[0]) { <option [value]="p[0]">{{ p[1] }}</option> }</select></div>
      </div>
      <p style="font-size:11px;color:#647687;margin-top:8px">Cadastre só modelos já aprovados pela Meta — o nome e o idioma precisam ser idênticos. Depois de salvar, escolha o dado de cada variável na tabela.</p>
    }
    <div footer><button class="btn-secondary" (click)="tf = null">Cancelar</button><button class="btn-primary" [disabled]="busy() || !tf?.name" (click)="saveTpl()">Salvar</button></div>
  </ax-modal>

  <ax-modal [open]="!!testTpl()" (closed)="testTpl.set(null)" title="Testar modelo" icon="send" [width]="440">
    <label class="field-label">Número de destino</label><input class="input-field mono" [(ngModel)]="testTo" placeholder="(11) 98888-7777" />
    <p style="font-size:11px;color:#647687;margin-top:8px">As variáveis vão preenchidas com o nome do campo (ex.: [nome]) só para conferir o modelo.</p>
    <div footer><button class="btn-secondary" (click)="testTpl.set(null)">Cancelar</button><button class="btn-primary" [disabled]="busy() || digits(testTo) < 10" (click)="sendTest(testTpl())">Enviar</button></div>
  </ax-modal>`,
})
export class WhatsappConfigPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); private toast = inject(ToastService); private auth = inject(AuthService);
  readonly canEdit = this.auth.can('integracoes.editar');
  readonly c = signal<any>(null); readonly templates = signal<any[]>([]); readonly tplLoading = signal(true); readonly busy = signal(false);
  readonly help = signal(false); readonly testTpl = signal<any>(null); readonly fieldList = signal<[string, string][]>([]);
  readonly purposes = Object.entries(PURPOSE_LABEL);
  readonly L = '{{'; readonly R = '}}';
  f: any = {}; tf: any = null; testTo = '';
  ph(n: number) { return this.L + n + this.R; }
  digits(s: string) { return (s || '').replace(/\D/g, '').length; }
  async ngOnInit() { await Promise.all([this.load(), this.loadTemplates()]); }
  async load() {
    try {
      const c: any = await this.api.get('/whatsapp/config');
      this.f = { displayPhone: c.displayPhone, phoneNumberId: c.phoneNumberId, wabaId: c.wabaId, apiVersion: c.apiVersion, accessToken: '', appSecret: '' };
      this.fieldList.set(Object.entries(c.fields)); this.c.set(c);
    } catch (e) { this.toast.error(e); }
  }
  async loadTemplates() { this.tplLoading.set(true); try { this.templates.set(await this.api.get<any[]>('/whatsapp/templates')); } catch (e) { this.toast.error(e); } finally { this.tplLoading.set(false); } }
  async save() {
    this.busy.set(true);
    try {
      const body: any = { displayPhone: this.f.displayPhone, phoneNumberId: String(this.f.phoneNumberId || '').trim(), wabaId: String(this.f.wabaId || '').trim() || undefined, apiVersion: this.f.apiVersion || undefined };
      if (this.f.accessToken) body.accessToken = this.f.accessToken.trim();
      if (this.f.appSecret) body.appSecret = this.f.appSecret.trim();
      const r: any = await this.api.put('/whatsapp/config', body);
      this.toast.success('WhatsApp da empresa salvo.');
      if (r.status !== 'ativo') await this.test(); else await this.load();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async test() {
    this.busy.set(true);
    try { const r: any = await this.api.post('/whatsapp/test'); this.toast.success(`Número validado na Meta (${r.verifiedName || r.displayPhone}). WhatsApp ativo${r.released ? ` — ${r.released} mensagem(ns) liberada(s)` : ''}.`); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); await this.load(); }
  }
  async deactivate() { try { await this.api.post('/whatsapp/deactivate'); this.toast.info('Envio por WhatsApp desativado para esta empresa.'); await this.load(); } catch (e) { this.toast.error(e); } }
  async removeCreds() {
    if (!confirm('Remover o número e as credenciais do WhatsApp desta empresa? As mensagens ficarão pendentes de configuração.')) return;
    try { await this.api.delete('/whatsapp/config'); this.toast.success('Credenciais removidas.'); await this.load(); } catch (e) { this.toast.error(e); }
  }
  copy(t: string) { navigator.clipboard?.writeText(t).then(() => this.toast.success('Copiado.'), () => this.toast.info(t)); }
  async sync() {
    this.busy.set(true);
    try { const r: any = await this.api.post('/whatsapp/templates/sync'); this.templates.set(r.items); this.toast.success(`${r.synced} modelo(s) sincronizado(s).`); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  placeholders(body: string | null) { const n = [...(body || '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => +m[1]); return n.length ? Math.max(...n) : 0; }
  range(n: number) { return Array.from({ length: n }, (_, i) => i); }
  statusTpl(s: string) { return ({ APPROVED: 'Aprovado', PENDING: 'Em análise', REJECTED: 'Rejeitado', PAUSED: 'Pausado', DISABLED: 'Desativado' } as any)[s] || s; }
  async setPurpose(t: any, p: string) {
    try { await this.api.put(`/whatsapp/templates/${t.id}`, { purpose: p || null }); this.toast.success(p ? `Modelo usado em: ${PURPOSE_LABEL[p]}.` : 'Modelo não será usado automaticamente.'); await this.loadTemplates(); }
    catch (e) { this.toast.error(e); await this.loadTemplates(); }
  }
  async setVar(t: any, k: number, field: string, n: number) {
    const vars = Array.from({ length: n }, (_, i) => t.variables[i] || '');
    vars[k] = field; t.variables = vars;
    if (vars.some((x) => !x)) return; // salva quando todas estiverem escolhidas
    try { await this.api.put(`/whatsapp/templates/${t.id}`, { variables: vars }); this.toast.success('Variáveis do modelo salvas.'); await this.loadTemplates(); } catch (e) { this.toast.error(e); }
  }
  newTpl() { this.tf = { name: '', language: 'pt_BR', body: '', purpose: '' }; }
  async saveTpl() {
    this.busy.set(true);
    try { await this.api.post('/whatsapp/templates', { name: this.tf.name.trim(), language: this.tf.language || 'pt_BR', body: this.tf.body || undefined, purpose: this.tf.purpose || null });
      this.tf = null; this.toast.success('Modelo cadastrado. Escolha agora o dado de cada variável.'); await this.loadTemplates(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async removeTpl(t: any) { if (!confirm(`Remover o modelo ${t.name} do sistema? (Ele continua existindo na Meta.)`)) return; try { await this.api.delete(`/whatsapp/templates/${t.id}`); await this.loadTemplates(); } catch (e) { this.toast.error(e); } }
  openTest(t: any) { this.testTpl.set(t); }
  async sendTest(t: any) {
    this.busy.set(true);
    try { const r: any = await this.api.post('/whatsapp/send-test', { to: this.testTo, templateId: t?.id }); this.toast.success('Mensagem de teste enviada pela Meta.' + (r.note ? ' ' + r.note : '')); this.testTpl.set(null); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}
