import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CustomerPickerComponent, ListState, ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, STATUS_PIPES, dateTimeBr } from '../../core/format';

const KIND: Record<string, { icon: string; cat: string; env: string[]; doc: string }> = {
  fiscal: { icon: 'landmark', cat: 'Fiscal', env: ['FISCAL_PROVIDER', 'FISCAL_PROVIDER_URL', 'FISCAL_PROVIDER_TOKEN'], doc: 'Provedor homologado que assina com o certificado A1 da empresa e transmite NF-e/NFC-e à SEFAZ.' },
  whatsapp: { icon: 'message-circle', cat: 'Comunicação', env: [], doc: 'Número próprio desta empresa na WhatsApp Business Platform (Cloud API oficial da Meta), configurado pelo administrador. Fora da janela de 24 h usa modelos aprovados.' },
  ecommerce: { icon: 'shopping-cart', cat: 'E-commerce', env: ['ECOMMERCE_API_URL', 'ECOMMERCE_API_TOKEN', 'ECOMMERCE_WEBHOOK_SECRET'], doc: 'Adaptador REST genérico: envia catálogo/estoque e recebe pedidos por webhook assinado (HMAC).' },
  logistica: { icon: 'truck', cat: 'Logística', env: ['LOGISTICS_API_URL', 'LOGISTICS_API_TOKEN'], doc: 'Cotação de frete e etiquetas via API do agregador logístico contratado.' },
  assistente_ia: { icon: 'bot', cat: 'IA', env: [], doc: 'A AXIA atual responde por regras sobre os dados reais. Conexão com modelo de linguagem ainda não implementada.' },
  banco: { icon: 'building-2', cat: 'Banco', env: [], doc: 'Conciliação por importação de extrato OFX/CSV (Financeiro → Conciliação). Open Finance não implementado.' },
};
const ago = (d: string | null) => { if (!d) return '—'; const m = Math.round((Date.now() - new Date(d).getTime()) / 60000); return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : dateTimeBr(d); };

@Component({
  selector: 'ax-integracoes',
  imports: [IconComponent, StateComponent, PagerComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:24px"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Integration Hub</h1>
      <p style="font-size:13px;color:#647687">{{ activeCount() }} integração(ões) ativa(s) · fila: {{ d()?.queue?.pending ?? 0 }} pendente(s), {{ d()?.queue?.errors ?? 0 }} com erro, {{ d()?.queue?.waiting ?? 0 }} aguardando configuração · {{ d()?.queue?.sent_24h ?? 0 }} enviados em 24h</p></div>
    <div class="state-info" style="margin:0 0 16px"><ax-icon name="shield-check" [size]="15" /><div>O WhatsApp é configurado por empresa nesta tela (botão Configurar): o token é cifrado no banco e nunca volta ao navegador. As demais integrações leem as credenciais de variáveis de ambiente do servidor. Sem credenciais, os eventos ficam na fila como "aguardando configuração" e nada é enviado.</div></div>
    <ax-state [loading]="!d()" />
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:14px">
      @for (i of d()?.items ?? []; track i.id) {
        <div class="card" style="padding:18px">
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
            <div style="width:40px;height:40px;border-radius:10px;background:#E3EFF9;display:flex;align-items:center;justify-content:center"><ax-icon [name]="K[i.kind]?.icon || 'plug'" [size]="20" color="#0875D1" /></div>
            <div style="flex:1"><div style="font-size:13px;font-weight:700;color:#172B3A">{{ i.name }}</div><span class="badge badge-muted">{{ K[i.kind]?.cat || i.kind }}</span></div>
            <span class="badge" [class]="'badge ' + (i.status | statusClass)">{{ i.status | statusLabel }}</span>
          </div>
          <p style="font-size:11px;color:#647687;margin-bottom:10px;min-height:30px">{{ K[i.kind]?.doc }}</p>
          <div style="display:flex;flex-direction:column;gap:6px">
            @for (r of [['Credenciais', i.credentials_present ? (i.credentials_source === 'empresa' ? 'Da empresa' : i.credentials_source === 'servidor' ? 'Do servidor' : 'Presentes') : 'Ausentes'], ['Última sincronização', ago(i.last_sync_at)], ['Chamadas (24h)', i.calls_24h], ['Erros (24h)', i.errors_24h], ['Na fila', i.queued]]; track r[0]) {
              <div style="display:flex;justify-content:space-between"><span style="font-size:12px;color:#647687">{{ r[0] }}</span><span style="font-size:12px;font-weight:600" [style.color]="(r[0] === 'Erros (24h)' && +r[1] > 0) || r[1] === 'Ausentes' ? '#C93636' : '#172B3A'">{{ r[1] }}</span></div>
            }
          </div>
          @if (K[i.kind]?.env?.length && !i.credentials_present) { <div class="mono" style="font-size:10px;color:#647687;margin-top:8px;background:#F4F7FA;padding:6px;border-radius:4px">{{ K[i.kind].env.join(' · ') }}</div> }
          @if (i.last_error) { <div style="font-size:11px;color:#C93636;margin-top:6px">Último erro: {{ i.last_error }}</div> }
          @if (auth.can('integracoes.editar') || i.kind === 'whatsapp') {
            <div style="display:flex;gap:6px;margin-top:12px">
              @if (i.kind === 'whatsapp') { <button class="btn-primary" style="font-size:11px;flex:1;justify-content:center" (click)="router.navigateByUrl('/whatsapp')"><ax-icon name="settings" [size]="11" /> Configurar</button> }
              @if (i.kind === 'ecommerce') { <button class="btn-secondary" style="font-size:11px;flex:1;justify-content:center" [disabled]="i.status !== 'ativo'" (click)="sync(i)"><ax-icon name="refresh-cw" [size]="11" /> Sincronizar catálogo</button> }
              @if (i.status === 'ativo') { <button class="btn-ghost" style="font-size:11px;flex:1;justify-content:center" (click)="setStatus(i, 'desativado')">Desativar</button> }
              @else if (i.kind !== 'whatsapp' || i.credentials_present) { <button class="btn-secondary" style="font-size:11px;flex:1;justify-content:center" [disabled]="!i.credentials_present" [title]="i.credentials_present ? '' : 'Configure as variáveis de ambiente no servidor'" (click)="setStatus(i, 'ativo')">Ativar</button> }
            </div>
          }
        </div>
      }
    </div>
    <div class="card" style="overflow:hidden;margin-top:20px">
      <div style="padding:12px 16px;display:flex;align-items:center;gap:8px"><div style="flex:1;font-size:13px;font-weight:600">Fila de eventos (outbox)</div>
        @for (s of ['', 'erro', 'aguardando_configuracao', 'pendente', 'enviado']; track s) { <span class="chip" [class.active]="ob() === s" (click)="ob.set(s); loadOutbox()">{{ s ? (s | statusLabel) : 'Todos' }}</span> }</div>
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>#</th><th>Integração</th><th>Tópico</th><th>Status</th><th class="num">Tentativas</th><th>Próxima tentativa</th><th>Erro</th><th></th></tr></thead>
        <tbody>@for (o of outbox.items(); track o.id) { <tr><td class="mono" style="font-size:11px">{{ o.id }}</td><td style="font-size:12px">{{ o.integration || '—' }}</td><td class="mono" style="font-size:11px">{{ o.topic }}</td>
          <td><span class="badge" [class]="'badge ' + (o.status | statusClass)">{{ o.status | statusLabel }}</span></td><td class="num">{{ o.attempts }}</td><td class="mono" style="font-size:11px">{{ o.next_attempt_at | dtt }}</td>
          <td style="font-size:11px;color:#C93636;max-width:260px">{{ o.last_error }}</td>
          <td>@if (['erro','aguardando_configuracao'].includes(o.status) && auth.can('integracoes.editar')) { <button class="btn-ghost" style="font-size:11px" (click)="retry(o)">Reprocessar</button> }</td></tr> }</tbody></table>
      <ax-state [loading]="outbox.loading()" [empty]="!outbox.loading() && !outbox.items().length" emptyText="Fila vazia." />
      <ax-pager [page]="outbox.page()" [pages]="outbox.pages()" [total]="outbox.total()" (go)="outbox.load($event)" />
    </div>
  </div>`,
})
export class IntegracoesPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly router = inject(Router);
  readonly K = KIND; readonly ago = ago;
  readonly d = signal<any>(null); readonly ob = signal('');
  readonly outbox = new ListState<any>((q) => this.api.get('/integrations/outbox', q));
  readonly activeCount = computed(() => (this.d()?.items ?? []).filter((i: any) => i.status === 'ativo').length);
  ngOnInit() { this.load(); this.loadOutbox(); }
  async load() { try { this.d.set(await this.api.get('/integrations')); } catch (e) { this.toast.error(e); } }
  loadOutbox() { this.outbox.query = { status: this.ob() || undefined }; this.outbox.load(1); }
  async setStatus(i: any, status: string) { try { await this.api.put('/integrations/' + i.id, { status }); this.toast.success('Integração atualizada.'); this.load(); } catch (e) { this.toast.error(e); } }
  async sync(i: any) { try { const r: any = await this.api.post(`/integrations/${i.id}/sync-products`); this.toast.success(`${r.queued} produto(s) enfileirado(s).`); this.loadOutbox(); } catch (e) { this.toast.error(e); } }
  async retry(o: any) { try { const r: any = await this.api.post(`/integrations/outbox/${o.id}/retry`); this.toast.info(`Situação: ${r.status}.`); this.loadOutbox(); this.load(); } catch (e) { this.toast.error(e); } }
}

const PURPOSE: Record<string, string> = { atendimento: 'Atendimento', pos_venda: 'Pós-venda', aniversario: 'Aniversário', cobranca: 'Cobrança', condicional: 'Condicional', campanha: 'Campanha' };
@Component({
  selector: 'ax-mensagens',
  imports: [FormsModule, IconComponent, StateComponent, PagerComponent, ModalComponent, CustomerPickerComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Mensagens (WhatsApp)</h1><p>Envio pela API oficial, respeitando consentimento LGPD. Mensagens sem consentimento ou sem integração configurada ficam registradas e não são enviadas.</p></div>
      @if (auth.can('mensagens.enviar')) { <button class="btn-primary" style="font-size:12px" (click)="openNew()"><ax-icon name="send" [size]="13" /> Nova mensagem</button> }</div>
    <div style="padding:12px 24px;display:flex;gap:8px;flex-wrap:wrap">
      @for (s of statuses; track s) { <span class="chip" [class.active]="status() === s" (click)="status.set(s); apply()">{{ s ? (s | statusLabel) : 'Todas' }}</span> }
      <select class="input-field" style="width:160px;margin-left:auto" [(ngModel)]="purpose" (ngModelChange)="apply()"><option value="">Todas as finalidades</option>@for (p of purposes; track p[0]) { <option [value]="p[0]">{{ p[1] }}</option> }</select>
    </div>
    <div style="flex:1;overflow-y:auto;padding:0 24px 20px">
      <div class="card" style="overflow:hidden">
        <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th></th><th>Data</th><th>Cliente</th><th>Número</th><th>Finalidade</th><th>Mensagem</th><th>Status</th></tr></thead>
          <tbody>@for (m of list.items(); track m.id) { <tr [style.background]="m.direction === 'entrada' ? '#F2FAF5' : null"><td [title]="m.direction === 'entrada' ? 'Recebida do cliente' : 'Enviada pela loja'"><ax-icon [name]="m.direction === 'entrada' ? 'arrow-down-left' : 'arrow-up-right'" [size]="13" [color]="m.direction === 'entrada' ? '#18864B' : '#0875D1'" /></td><td class="mono" style="font-size:11px">{{ m.created_at | dtt }}</td><td style="font-size:12px;font-weight:500">{{ m.customer || '—' }}</td><td style="font-size:12px">{{ m.to_address | phone }}</td>
            <td><span class="badge badge-muted">{{ P[m.purpose] || m.purpose }}</span></td><td style="font-size:12px;max-width:380px">{{ m.body || ('Modelo: ' + m.template) }}@if (m.template) { <div style="font-size:10px;color:#647687">modelo {{ m.template }}</div> }</td>
            <td><span class="badge" [class]="'badge ' + (m.status | statusClass)">{{ m.status | statusLabel }}</span>@if (m.read_at) { <div style="font-size:10px;color:#647687">lida {{ m.read_at | dtt }}</div> }@if (m.error) { <div style="font-size:10px;color:#647687">{{ m.error }}</div> }</td></tr> }</tbody></table>
        <ax-state [loading]="list.loading()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhuma mensagem." emptyIcon="message-circle" />
      </div>
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="newOpen" title="Nova mensagem" icon="send" [width]="520">
    <div style="display:flex;flex-direction:column;gap:10px">
      <div><label class="field-label">Cliente *</label><ax-customer-picker [(value)]="cust" /></div>
      <div><label class="field-label">Finalidade</label><select class="input-field" [(ngModel)]="m.purpose">@for (p of purposes; track p[0]) { @if (p[0] !== 'cobranca' || auth.can('financeiro.ver')) { <option [value]="p[0]">{{ p[1] }}</option> } }</select></div>
      @if (tplFor(m.purpose); as t) { <div class="state-info" style="margin:0;font-size:12px"><ax-icon name="message-square" [size]="13" /><span>Fora da janela de 24 h será enviado o modelo aprovado <b class="mono">{{ t.name }}</b>, preenchido com os dados do cliente. O texto abaixo é usado só se o cliente tiver escrito para a loja nas últimas 24 h.</span></div> }
      <div><label class="field-label">Mensagem @if (!tplFor(m.purpose)) { * } <span class="muted">({{ '{' }}nome{{ '}' }} = primeiro nome, {{ '{' }}loja{{ '}' }}, {{ '{' }}valor{{ '}' }}, {{ '{' }}vencimento{{ '}' }})</span></label><textarea class="input-field" rows="4" maxlength="1000" [(ngModel)]="m.body"></textarea></div>
      <p style="font-size:11px;color:#647687">"Atendimento" é para respostas a contatos iniciados pela cliente; as demais finalidades exigem consentimento de WhatsApp registrado no cadastro.</p>
    </div>
    <div footer><button class="btn-secondary" (click)="newOpen.set(false)">Cancelar</button><button class="btn-primary" [disabled]="!cust() || ((m.body || '').trim().length < 2 && !tplFor(m.purpose))" (click)="send()">Enviar</button></div>
  </ax-modal>`,
})
export class MensagensPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly P = PURPOSE; readonly purposes = Object.entries(PURPOSE);
  readonly statuses = ['', 'recebido', 'enviado', 'entregue', 'lido', 'fila', 'pendente_configuracao', 'bloqueado_sem_consentimento', 'erro'];
  readonly list = new ListState<any>((q) => this.api.get('/messages', q));
  readonly status = signal(''); purpose = ''; readonly newOpen = signal(false); readonly cust = signal<any>(null); m: any = {};
  readonly templates = signal<any[]>([]);
  ngOnInit() { this.list.load(); this.api.get<any[]>('/whatsapp/templates').then((t) => this.templates.set(t), () => {}); }
  tplFor(p: string) { return this.templates().find((t) => t.purpose === p && t.status === 'APPROVED') ?? null; }
  apply() { this.list.query = { status: this.status() || undefined, purpose: this.purpose || undefined }; this.list.load(1); }
  openNew() { this.cust.set(null); this.m = { purpose: 'atendimento', body: '' }; this.newOpen.set(true); }
  async send() {
    try { const r: any = await this.api.post('/messages', { customerId: this.cust().id, purpose: this.m.purpose, body: (this.m.body || '').trim() || undefined });
      r.status === 'fila' ? this.toast.success('Mensagem enfileirada para envio.') : this.toast.warning(r.error || `Situação: ${r.status}`); this.newOpen.set(false); this.list.reload(); }
    catch (e) { this.toast.error(e); }
  }
}

@Component({
  selector: 'ax-monitoramento',
  imports: [IconComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:24px;display:flex;align-items:flex-start"><div style="flex:1"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Monitor do Sistema</h1>
      <p style="font-size:13px;color:#647687">Medições reais do servidor · atualizado {{ at() }} · Node {{ d()?.api?.node }}</p></div><button class="btn-secondary" style="font-size:12px" (click)="load()"><ax-icon name="refresh-cw" [size]="13" /> Atualizar</button></div>
    <ax-state [loading]="!d()" />
    @if (d(); as d) {
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:14px;margin-bottom:20px">
        @for (m of metrics(); track m.label) {
          <div class="kpi-card"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><ax-icon [name]="m.icon" [size]="16" [color]="m.ok ? '#18864B' : '#D99000'" /><span style="font-size:12px;font-weight:600;color:#172B3A">{{ m.label }}</span>
            <span class="badge" [class]="m.ok ? 'badge badge-success' : 'badge badge-warning'" style="margin-left:auto">{{ m.ok ? 'OK' : 'Atenção' }}</span></div>
            <div style="font-size:24px;font-weight:700;color:#172B3A;margin-bottom:4px">{{ m.value }}</div><div style="font-size:11px;color:#647687;margin-bottom:6px">{{ m.sub }}</div>
            <div style="height:4px;background:#F0F4F8;border-radius:2px"><div [style.width.%]="m.pct" [style.background]="m.ok ? '#18864B' : '#D99000'" style="height:100%;border-radius:2px"></div></div></div>
        }
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card" style="padding:16px"><div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:12px">Log de Eventos do sistema</div>
          @for (e of d.recentErrors; track $index) { <div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid #F0F4F8;align-items:flex-start"><span class="mono" style="font-size:11px;color:#647687;flex-shrink:0">{{ e.created_at | dtt }}</span>
            <span class="badge" [class]="e.level === 'error' ? 'badge badge-danger' : e.level === 'warn' ? 'badge badge-warning' : 'badge badge-info'" style="flex-shrink:0">{{ e.level.toUpperCase() }}</span><span style="font-size:12px;color:#172B3A">{{ e.source }}: {{ e.message }}</span></div> }
          @empty { <div class="empty-state">Nenhum evento registrado.</div> }</div>
        <div class="card" style="padding:16px"><div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:12px">Requisições e banco</div>
          <div style="font-size:12px;display:flex;flex-direction:column;gap:6px">
            <div>Requisições desde o início: <b>{{ d.api.requests | num }}</b> · erros 5xx: <b>{{ d.api.errors5xx }}</b> · tempo médio: <b>{{ d.api.avgMs }} ms</b></div>
            <div>Por status: @for (s of byStatus(); track s[0]) { <span class="badge badge-muted" style="margin-right:4px">{{ s[0] }}: {{ s[1] }}</span> }</div>
            <div>Pool PostgreSQL: {{ d.database.pool.total }} conexões ({{ d.database.pool.idle }} ociosas, {{ d.database.pool.waiting }} aguardando)</div>
            <div class="muted" style="font-size:11px">{{ d.database.version }}</div>
          </div>
          <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:10px"><thead><tr><th>Tabela</th><th class="num">Registros (est.)</th></tr></thead><tbody>@for (t of d.database.tables; track t.table) { <tr><td class="mono" style="font-size:11px">{{ t.table }}</td><td class="num">{{ t.rows | num }}</td></tr> }</tbody></table>
        </div>
      </div>
    }
  </div>`,
})
export class MonitoramentoPage implements OnInit {
  private api = inject(Api);
  readonly d = signal<any>(null); readonly at = signal('');
  ngOnInit() { this.load(); }
  async load() { this.d.set(await this.api.get('/monitor')); this.at.set(new Date().toLocaleTimeString('pt-BR')); }
  readonly byStatus = computed(() => Object.entries(this.d()?.api?.byStatus ?? {}));
  readonly metrics = computed(() => { const d = this.d(); if (!d) return []; const memPct = Math.round((1 - d.host.freeMemMb / d.host.totalMemMb) * 100); const up = d.api.uptimeSec;
    return [
      { label: 'Banco de dados', icon: 'database', value: d.database.latencyMs + ' ms', sub: `latência de consulta · ${d.database.sizeMb} MB`, ok: d.database.latencyMs < 100, pct: Math.min(100, d.database.latencyMs) },
      { label: 'API REST', icon: 'server', value: d.api.avgMs + ' ms', sub: `média por requisição · no ar há ${up > 86400 ? Math.floor(up / 86400) + 'd ' : ''}${Math.floor((up % 86400) / 3600)}h${Math.floor((up % 3600) / 60)}m`, ok: d.api.avgMs < 500, pct: Math.min(100, d.api.avgMs / 5) },
      { label: 'Fila de integrações', icon: 'clock', value: d.outbox.pending + ' itens', sub: `${d.outbox.errors} com erro`, ok: d.outbox.errors === 0, pct: Math.min(100, d.outbox.pending) },
      { label: 'Memória do processo', icon: 'cpu', value: d.api.memoryMb + ' MB', sub: `heap ${d.api.heapMb} MB`, ok: d.api.memoryMb < 1024, pct: Math.min(100, d.api.memoryMb / 10.24) },
      { label: 'Memória do host', icon: 'server', value: memPct + '%', sub: `${d.host.cpus} CPU(s) · carga ${d.host.load[0].toFixed(2)}`, ok: memPct < 85, pct: memPct },
      { label: 'Sessões ativas', icon: 'users', value: String(d.activeSessions), sub: 'usuários com atividade nos últimos 15 min', ok: true, pct: Math.min(100, d.activeSessions * 5) },
    ]; });
}

@Component({
  selector: 'ax-backup',
  imports: [IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:24px"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Central de Backup</h1><p style="font-size:13px;color:#647687">Exportação dos dados da empresa e orientações de backup do banco</p></div>
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;margin-bottom:20px">
      <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase">Última exportação</div><div style="font-size:18px;font-weight:700;color:#18864B">{{ hist()[0] ? (hist()[0].created_at | dtt) : 'nunca' }}</div><div style="font-size:11px;color:#647687">{{ hist()[0]?.user_name || '' }}</div></div>
      <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase">Exportações registradas</div><div style="font-size:18px;font-weight:700">{{ hist().length }}</div><div style="font-size:11px;color:#647687">auditadas como operação crítica</div></div>
      <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase">Backup do banco</div><div style="font-size:18px;font-weight:700;color:#0875D1">pg_dump</div><div style="font-size:11px;color:#647687">agendado pela infraestrutura (docs/OPERACAO.md)</div></div>
    </div>
    <div class="card" style="padding:18px;margin-bottom:16px;display:flex;gap:16px;align-items:center">
      <div style="flex:1"><div style="font-size:13px;font-weight:700;margin-bottom:4px">Exportar dados da empresa (JSON)</div><div style="font-size:12px;color:#647687">Cadastros, vendas, estoque, financeiro, condicionais e documentos fiscais (sem XML) desta empresa. Útil para portabilidade e conferência; para recuperação completa use o backup do PostgreSQL.</div></div>
      <button class="btn-primary" style="font-size:12px" [disabled]="busy()" (click)="exportNow()"><ax-icon name="download" [size]="13" /> {{ busy() ? 'Gerando...' : 'Exportar agora' }}</button>
    </div>
    <div class="card" style="padding:18px;margin-bottom:16px;font-size:12px;line-height:1.7">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px">Backup e restauração do PostgreSQL (servidor)</div>
      <div class="mono" style="background:#0B1F33;color:#E3EFF9;padding:10px 12px;border-radius:6px;font-size:11px;white-space:pre">pg_dump --format=custom --file=axionyx-$(date +%F).dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" axionyx-AAAA-MM-DD.dump</div>
      <div class="muted" style="margin-top:6px">Recomendado: dump diário com retenção de 30 dias em armazenamento externo e teste de restauração mensal em ambiente separado.</div>
    </div>
    <div class="card" style="overflow:hidden">
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data/Hora</th><th>Tipo</th><th>Usuário</th><th>Tabelas</th></tr></thead>
        <tbody>@for (h of hist(); track h.id) { <tr><td class="mono" style="font-size:12px">{{ h.created_at | dtt }}</td><td><span class="badge badge-muted">Exportação JSON</span></td><td style="font-size:12px">{{ h.user_name }}</td><td>{{ h.data?.tables }}</td></tr> }
        @empty { <tr><td colspan="4" class="muted" style="text-align:center;padding:16px">Nenhuma exportação realizada.</td></tr> }</tbody></table>
    </div>
  </div>`,
})
export class BackupPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService);
  readonly hist = signal<any[]>([]); readonly busy = signal(false);
  ngOnInit() { this.load(); }
  async load() { try { this.hist.set(await this.api.get<any[]>('/admin/backups')); } catch { /* */ } }
  async exportNow() { this.busy.set(true); try { await this.api.download('/admin/export', undefined, 'axionyx-backup.json'); this.toast.success('Exportação gerada.'); this.load(); } catch (e) { this.toast.error(e); } finally { this.busy.set(false); } }
}
