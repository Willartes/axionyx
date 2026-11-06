import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, ModuleTabsComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, STATUS_PIPES } from '../../core/format';

export const FISCAL_TABS = [{ path: '/fiscal', label: 'Dashboard' }, { path: '/nfe', label: 'Documentos (NF-e / NFC-e)' }, { path: '/monitor-fiscal', label: 'Monitor Fiscal' }];
const MODEL: Record<string, string> = { '55': 'NF-e', '65': 'NFC-e' };
const TPAG: Record<string, string> = { '01': 'Dinheiro', '03': 'Cartão de crédito', '04': 'Cartão de débito', '05': 'Crédito loja', '15': 'Boleto', '17': 'PIX', '90': 'Sem pagamento', '99': 'Outros' };

/** Faixa de aviso: documentos sem provedor/homologação nunca são apresentados como autorizados de verdade. */
@Component({
  selector: 'ax-fiscal-notice',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (st(); as s) {
    @if (!s.configured) { <div class="state-warning" style="margin:0 0 16px"><ax-icon name="alert-triangle" [size]="15" /><div><b>Modo sem provedor fiscal.</b> {{ s.notice }} Configure o provedor (variáveis FISCAL_PROVIDER, FISCAL_PROVIDER_URL e FISCAL_PROVIDER_TOKEN no servidor — ver docs/INTEGRACOES.md) e o certificado digital junto ao provedor.</div></div> }
    @else if (s.environment !== 'producao') { <div class="state-info" style="margin:0 0 16px"><ax-icon name="info" [size]="15" /><div>Provedor <b>{{ s.provider }}</b> em ambiente de <b>homologação</b>: documentos autorizados neste ambiente não têm valor fiscal.</div></div> }
  }`,
})
export class FiscalNoticeComponent { readonly st = input<any>(null); }

@Component({
  selector: 'ax-fiscal',
  imports: [IconComponent, ModuleTabsComponent, FiscalNoticeComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:24px"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Fiscal — Dashboard</h1>
      <p style="font-size:13px;color:#647687">{{ month }} · Regime: {{ regime() }} · Ambiente: {{ st()?.environment === 'producao' ? 'Produção' : 'Homologação' }} · Provedor: {{ st()?.configured ? st()?.provider : 'não configurado' }}</p></div>
    <ax-fiscal-notice [st]="st()" />
    <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:20px">
      @for (k of kpis(); track k.label) {
        <div class="kpi-card" style="cursor:pointer" (click)="router.navigate([k.screen], { queryParams: k.q })"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">{{ k.label }}</div>
          <div [style.color]="k.color" style="font-size:22px;font-weight:700">{{ k.value }}</div><div style="font-size:11px;color:#647687">{{ k.sub }}</div></div>
      }
    </div>
    <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:10px">
      @for (b of quick; track b.label) { <button class="btn-secondary" style="justify-content:center;padding:10px;font-size:13px" (click)="router.navigateByUrl(b.screen)">{{ b.label }}</button> }
    </div>
    <div class="card" style="padding:16px;margin-top:20px;font-size:12px;color:#647687;line-height:1.6">
      <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:6px">Como funciona a emissão</div>
      O AXIONYX monta o documento a partir da venda (itens, NCM, CFOP, CST/CSOSN, pagamentos), valida os dados obrigatórios e envia ao <b>provedor fiscal homologado</b> configurado, que assina com o certificado digital da empresa e transmite à SEFAZ. O status, a chave de acesso e o protocolo exibidos vêm exclusivamente da resposta do provedor. Sem provedor configurado, nada é transmitido e nenhum documento é exibido como autorizado.
    </div>
  </div>`,
})
export class FiscalPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); private auth = inject(AuthService);
  readonly tabs = FISCAL_TABS; readonly st = signal<any>(null); readonly pending = signal<any[]>([]);
  readonly month = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^\w/, (c) => c.toUpperCase());
  readonly regime = computed(() => ({ simples: 'Simples Nacional', presumido: 'Lucro Presumido', real: 'Lucro Real', mei: 'MEI' } as any)[this.auth.me()?.company?.tax_regime ?? ''] ?? '—');
  readonly quick = [{ label: 'Documentos', screen: '/nfe' }, { label: 'Monitor Fiscal', screen: '/monitor-fiscal' }, { label: 'Tributação dos produtos', screen: '/produtos' }, { label: 'Configurações fiscais', screen: '/configuracoes' }];
  async ngOnInit() { const [s, p] = await Promise.all([this.api.get('/fiscal/status'), this.api.get<any[]>('/fiscal/pending-sales').catch(() => [])]); this.pending.set(p); this.st.set(s); }
  readonly kpis = computed(() => {
    const c: any[] = this.st()?.counts ?? []; const sum = (f: (r: any) => boolean) => c.filter(f).reduce((s, r) => s + r.n, 0);
    return [
      { label: 'NFC-e no mês', value: sum((r) => r.model === '65'), sub: `${sum((r) => r.model === '65' && r.status === 'autorizado')} autorizada(s) pelo provedor`, color: '#0875D1', screen: '/nfe', q: { model: '65' } },
      { label: 'NF-e no mês', value: sum((r) => r.model === '55'), sub: `${sum((r) => r.model === '55' && r.status === 'autorizado')} autorizada(s) pelo provedor`, color: '#2878C7', screen: '/nfe', q: { model: '55' } },
      { label: 'Pendentes / com erro', value: sum((r) => !['autorizado', 'cancelado'].includes(r.status)), sub: 'rascunho, pendências, fila, rejeição', color: '#D99000', screen: '/monitor-fiscal', q: {} },
      { label: 'Vendas sem documento', value: this.pending().length, sub: 'últimos 30 dias nesta filial', color: '#C93636', screen: '/monitor-fiscal', q: {} },
    ];
  });
}

@Component({
  selector: 'ax-nfe-list',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, PagerComponent, StateComponent, FiscalNoticeComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:10px">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">NF-e / NFC-e — Documentos Fiscais</h1><p style="font-size:12px;color:#647687">{{ t()?.n ?? 0 }} documento(s) · {{ t()?.authorized ?? 0 }} autorizado(s) · {{ t()?.pending ?? 0 }} pendente(s)</p></div>
      <select class="input-field" style="width:130px;font-size:12px" [(ngModel)]="modelF" (ngModelChange)="apply()"><option value="">Todos modelos</option><option value="65">NFC-e (65)</option><option value="55">NF-e (55)</option></select>
      <input class="input-field" style="width:200px;font-size:12px" placeholder="Nº, chave, venda ou destinatário" [(ngModel)]="q" (keyup.enter)="apply()" />
      @if (auth.can('fiscal.emitir')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/monitor-fiscal')"><ax-icon name="plus" [size]="13" /> Emitir para venda</button> }
    </div>
    <ax-module-tabs [tabs]="tabs" />
    <div style="padding:0 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex">
      @for (s of statuses; track s.v) { <div class="tab-item" [class.active]="status() === s.v" (click)="status.set(s.v); apply()">{{ s.l }}</div> }
    </div>
    <div style="flex:1;overflow-y:auto">
      <div style="padding:12px 24px 0"><ax-fiscal-notice [st]="st()" /></div>
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr><th>Número</th><th>Série</th><th>Modelo</th><th>Destinatário</th><th>Venda</th><th>Criação</th><th class="num">Valor Total</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>@for (n of list.items(); track n.id) {
          <tr style="cursor:pointer" (click)="router.navigateByUrl('/nfe-detail/' + n.id)">
            <td class="mono" style="font-size:12px;color:#0875D1;font-weight:600">{{ n.number ?? '—' }}</td><td class="mono" style="font-size:12px;text-align:center">{{ n.series }}</td>
            <td><span class="badge" [class]="n.model === '55' ? 'badge badge-info' : 'badge badge-cyan'">{{ MODEL[n.model] }}</span> @if (n.is_test) { <span class="badge badge-muted" title="Sem valor fiscal">TESTE</span> }</td>
            <td style="font-size:13px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ n.recipient_name || 'Consumidor final' }}</td>
            <td class="mono" style="font-size:12px">{{ n.sale_number ? 'nº ' + n.sale_number : '—' }}</td><td class="mono" style="font-size:12px">{{ n.created_at | dt }}</td>
            <td class="num" style="font-weight:600">{{ n.total | brl }}</td>
            <td><span class="badge" [class]="'badge ' + (n.status | statusClass)">{{ n.status | statusLabel }}</span> @if (n.issues > 0) { <span class="badge badge-danger">{{ n.issues }}</span> }</td>
            <td (click)="$event.stopPropagation()"><button class="btn-ghost" style="padding:3px 6px;font-size:11px" (click)="router.navigateByUrl('/nfe-detail/' + n.id)"><ax-icon name="file-text" [size]="12" /></button></td>
          </tr>
        }</tbody>
      </table>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum documento fiscal no filtro." emptyIcon="file-text" />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>`,
})
export class NfeListPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService);
  readonly model = input<string>();
  readonly tabs = FISCAL_TABS; readonly MODEL = MODEL; readonly st = signal<any>(null);
  readonly list = new ListState<any>((q) => this.api.get('/fiscal/documents', q));
  readonly t = computed(() => this.list.extra()?.totals);
  readonly status = signal(''); modelF = ''; q = '';
  readonly statuses = [{ v: '', l: 'Todas' }, { v: 'autorizado', l: 'Autorizadas' }, { v: 'rascunho', l: 'Rascunhos' }, { v: 'pendente_configuracao', l: 'Aguardando provedor' }, { v: 'invalido', l: 'Com pendências' }, { v: 'rejeitado', l: 'Rejeitadas' }, { v: 'cancelado', l: 'Canceladas' }];
  ngOnInit() { this.modelF = this.model() ?? ''; this.apply(); this.api.get('/fiscal/status').then((s) => this.st.set(s)).catch(() => {}); }
  apply() { this.list.query = { status: this.status() || undefined, model: this.modelF || undefined, q: this.q || undefined }; this.list.load(1); }
}

@Component({
  selector: 'ax-nfe-detail',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, FiscalNoticeComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
  @if (d(); as d) {
  <div style="padding:24px">
    <ax-fiscal-notice [st]="st()" />
    <div class="card" style="padding:20px;margin-bottom:16px;position:relative;overflow:hidden">
      <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap">
        <div style="flex:1;min-width:280px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><h1 style="font-size:18px;font-weight:700;color:#172B3A">{{ MODEL[d.model] }} n.º {{ d.number ?? '(a numerar)' }} / Série {{ d.series }}</h1>
            <span class="badge" [class]="'badge ' + (d.status | statusClass)">{{ d.status | statusLabel }}</span> @if (d.is_test) { <span class="test-stamp">Sem valor fiscal</span> }</div>
          <p class="mono" style="font-size:12px;color:#647687">Chave: {{ d.access_key || 'gerada pelo provedor na autorização' }} @if (d.protocol) { · Protocolo {{ d.protocol }} }</p>
          <p style="font-size:12px;color:#647687">Ambiente: {{ d.environment === 'producao' ? 'Produção' : 'Homologação' }} @if (d.sale_number) { · <a class="link" (click)="router.navigateByUrl('/pedido-detail/' + d.sale_id)">venda nº {{ d.sale_number }}</a> } · tentativas: {{ d.attempts }}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          @if (auth.can('fiscal.emitir') && canSend()) {
            <button class="btn-secondary" style="font-size:11px" (click)="act('validate')"><ax-icon name="list-checks" [size]="12" /> Revalidar</button>
            <button class="btn-primary" style="font-size:11px" [disabled]="busy() || d.validation.length > 0" (click)="act('transmit')"><ax-icon name="send" [size]="12" /> Transmitir</button>
          }
          @if (d.danfe_url) { <a class="btn-secondary" style="font-size:11px;text-decoration:none" [href]="d.danfe_url" target="_blank" rel="noopener">Ver DANFE</a> }
          @if (d.has_xml) { <button class="btn-secondary" style="font-size:11px" (click)="api.download('/fiscal/documents/' + d.id + '/xml', undefined, (d.access_key || d.id) + '.xml')"><ax-icon name="download" [size]="12" /> Baixar XML</button> }
          @if (d.status === 'autorizado' && auth.can('fiscal.emitir')) { <button class="btn-ghost" style="font-size:11px;color:#C93636" (click)="cancelOpen.set(true)">Cancelar {{ MODEL[d.model] }}</button> }
        </div>
      </div>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #F0F4F8">
        <div style="font-size:12px;font-weight:600;color:#172B3A;margin-bottom:12px">Timeline de Processamento</div>
        <div style="display:flex;align-items:center;gap:0">
          @for (s of steps(); track s.label; let i = $index, last = $last) {
            <div style="display:flex;align-items:center;flex:1">
              <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
                <ax-icon [name]="s.state === 'fail' ? 'x-circle' : 'check-circle-2'" [size]="18" [color]="s.state === 'done' ? '#18864B' : s.state === 'fail' ? '#C93636' : '#DCE4EC'" />
                <div [style.color]="s.state === 'done' ? '#18864B' : s.state === 'fail' ? '#C93636' : '#A0AFBF'" style="font-size:10px;white-space:nowrap;text-align:center">{{ s.label }}</div>
                <div style="font-size:9px;color:#A0AFBF">{{ s.date ? (s.date | dtt) : '' }}</div>
              </div>
              @if (!last) { <div [style.background]="s.state === 'done' ? '#18864B' : '#DCE4EC'" style="flex:1;height:2px;margin:0 4px 22px"></div> }
            </div>
          }
        </div>
      </div>
    </div>
    @if (d.validation.length) {
      <div class="state-error" style="margin:0 0 16px;align-items:flex-start"><ax-icon name="alert-triangle" [size]="15" /><div><b>Pendências que impedem a transmissão:</b>
        @for (v of d.validation; track $index) { <div>• {{ v.message }} <span class="mono" style="font-size:10px;color:#647687">({{ v.field }})</span></div> }</div></div>
    }
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div class="card" style="padding:18px"><div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:12px">Emitente</div>
        @for (r of emit(); track r[0]) { <div style="margin-bottom:8px"><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">{{ r[0] }}</div><div style="font-size:13px;color:#172B3A">{{ r[1] }}</div></div> }</div>
      <div class="card" style="padding:18px"><div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:12px">Destinatário</div>
        @for (r of dest(); track r[0]) { <div style="margin-bottom:8px"><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">{{ r[0] }}</div><div style="font-size:13px;color:#172B3A">{{ r[1] }}</div></div> }</div>
    </div>
    <div class="card" style="overflow:hidden;margin-bottom:16px">
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>#</th><th>Código</th><th>Descrição</th><th>NCM</th><th>CFOP</th><th>CST/CSOSN</th><th class="num">Qtd.</th><th class="num">Unit.</th><th class="num">Desc.</th><th class="num">Total</th></tr></thead>
        <tbody>@for (i of d.payload?.itens ?? []; track i.numero) { <tr><td>{{ i.numero }}</td><td class="mono" style="font-size:11px">{{ i.codigo }}</td><td style="font-size:12px">{{ i.descricao }}</td><td class="mono" style="font-size:11px">{{ i.ncm || '—' }}</td><td class="mono" style="font-size:11px">{{ i.cfop }}</td><td class="mono" style="font-size:11px">{{ i.cstCsosn }}</td>
          <td class="num">{{ i.quantidade }}</td><td class="num">{{ i.valorUnitario | brl }}</td><td class="num">{{ i.desconto | brl }}</td><td class="num" style="font-weight:600">{{ i.valorTotal | brl }}</td></tr> }</tbody></table>
      <div style="padding:12px 16px;display:flex;justify-content:space-between;border-top:1px solid #F0F4F8;font-size:13px">
        <div>@for (p of d.payload?.pagamentos ?? []; track $index) { <span class="badge badge-muted" style="margin-right:6px">{{ TPAG[p.tPag] || p.tPag }} · {{ p.valor | brl }}</span> }</div>
        <div>Produtos {{ d.totals.produtos | brl }} · Desconto {{ d.totals.desconto | brl }} · <b>Total {{ d.totals.total | brl }}</b></div>
      </div>
    </div>
    <div class="card" style="padding:16px"><div style="font-size:12px;font-weight:700;color:#172B3A;margin-bottom:8px">Eventos</div>
      @for (e of d.events; track e.id) { <div style="font-size:12px;padding:6px 0;border-bottom:1px solid #F0F4F8"><span class="mono" style="color:#647687">{{ e.created_at | dtt }}</span> · <b>{{ e.type }}</b> · <span class="badge" [class]="'badge ' + (e.status | statusClass)">{{ e.status | statusLabel }}</span> · {{ e.message }} <span class="muted">{{ e.user_name }}</span></div> }
    </div>
  </div>
  <ax-modal [(open)]="cancelOpen" title="Cancelar documento fiscal" icon="x-circle" [width]="460">
    <p style="font-size:12px;color:#647687;margin-bottom:8px">O pedido de cancelamento é enviado ao provedor/SEFAZ dentro do prazo legal. O status só muda após a resposta.</p>
    <label class="field-label">Justificativa (mín. 15 caracteres) *</label><textarea class="input-field" rows="3" [(ngModel)]="reason"></textarea>
    <div footer><button class="btn-secondary" (click)="cancelOpen.set(false)">Voltar</button><button class="btn-danger" [disabled]="reason.trim().length < 15" (click)="cancel()">Solicitar cancelamento</button></div>
  </ax-modal>
  }`,
})
export class NfeDetailPage implements OnInit {
  readonly api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly id = input.required<string>();
  readonly MODEL = MODEL; readonly TPAG = TPAG;
  readonly d = signal<any>(null); readonly st = signal<any>(null); readonly loading = signal(false); readonly error = signal<string | null>(null); readonly busy = signal(false); readonly cancelOpen = signal(false); reason = '';
  readonly canSend = computed(() => ['rascunho', 'invalido', 'pendente_configuracao', 'erro', 'rejeitado', 'contingencia'].includes(this.d()?.status));
  ngOnInit() { this.load(); this.api.get('/fiscal/status').then((s) => this.st.set(s)).catch(() => {}); }
  async load() { this.loading.set(true); this.error.set(null); try { this.d.set(await this.api.get('/fiscal/documents/' + this.id())); } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); } }
  readonly emit = computed(() => { const e = this.d()?.payload?.emitente ?? {}; const a = e.endereco ?? {}; return [['Razão Social', e.razaoSocial || '—'], ['CNPJ', e.cnpj ? e.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : '—'], ['IE', e.ie || '—'], ['Endereço', [a.logradouro, a.numero, a.bairro, a.cidade && a.cidade + '/' + a.uf].filter(Boolean).join(', ') || '—']]; });
  readonly dest = computed(() => { const r = this.d()?.recipient ?? {}; const a = r.endereco ?? {}; return [['Nome', r.nome || 'Consumidor final'], ['CPF/CNPJ', r.documento || 'não identificado'], ['IE', r.ie || '—'], ['Endereço', [a.logradouro, a.numero, a.cidade && a.cidade + '/' + a.uf].filter(Boolean).join(', ') || '—']]; });
  readonly steps = computed(() => {
    const d = this.d(); if (!d) return [];
    const ev = (t: string) => d.events.find((e: any) => e.type === t);
    const tx = [...d.events].reverse().find((e: any) => e.type === 'transmissao');
    const failed = ['rejeitado', 'denegado', 'erro'].includes(d.status);
    return [
      { label: 'Documento criado', state: 'done', date: d.created_at },
      { label: 'Validação de dados', state: d.validation.length ? 'fail' : 'done', date: ev('criacao')?.created_at },
      { label: 'Envio ao provedor', state: tx && d.status !== 'pendente_configuracao' ? 'done' : d.status === 'pendente_configuracao' ? 'fail' : 'todo', date: tx?.created_at },
      { label: 'Assinatura / SEFAZ', state: d.status === 'autorizado' || d.status === 'cancelado' ? 'done' : failed ? 'fail' : 'todo', date: d.authorized_at },
      { label: d.status === 'cancelado' ? 'Cancelado' : 'Autorizado', state: d.status === 'autorizado' || d.status === 'cancelado' ? 'done' : 'todo', date: d.cancelled_at || d.authorized_at },
    ];
  });
  async act(kind: 'validate' | 'transmit') {
    this.busy.set(true);
    try { const r: any = await this.api.post(`/fiscal/documents/${this.id()}/${kind}`, {}, kind === 'transmit' ? { idempotent: true } : undefined);
      if (kind === 'transmit') r.status === 'autorizado' ? this.toast.success('Documento autorizado pelo provedor.') : this.toast.warning(r.status === 'pendente_configuracao' ? 'Provedor fiscal não configurado: nada foi enviado à SEFAZ.' : `Situação: ${r.status}.`);
      else this.toast.success(r.validation?.length ? `${r.validation.length} pendência(s).` : 'Dados válidos.');
      this.load(); } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async cancel() { try { const r: any = await this.api.post(`/fiscal/documents/${this.id()}/cancel`, { reason: this.reason.trim() }); this.cancelOpen.set(false); r.status === 'cancelado' ? this.toast.success('Cancelamento homologado.') : this.toast.warning(r.cancel_error || 'Cancelamento não confirmado pelo provedor.'); this.load(); } catch (e) { this.toast.error(e); } }
}

@Component({
  selector: 'ax-monitor-fiscal',
  imports: [FormsModule, IconComponent, ModuleTabsComponent, StateComponent, FiscalNoticeComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <ax-module-tabs [tabs]="tabs" />
  <div style="padding:24px">
    <div style="margin-bottom:20px"><h1 style="font-size:16px;font-weight:700;color:#172B3A">Monitor Fiscal</h1><p style="font-size:12px;color:#647687">Fila de documentos com pendência e vendas ainda sem documento fiscal</p></div>
    <ax-fiscal-notice [st]="st()" />
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="card" style="overflow:hidden"><div style="padding:12px 16px;font-size:13px;font-weight:600">Documentos que exigem ação ({{ queue().length }})</div>
        <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Doc.</th><th>Venda</th><th>Criação</th><th class="num">Total</th><th>Status</th></tr></thead>
          <tbody>@for (n of queue(); track n.id) { <tr class="clickable" (click)="router.navigateByUrl('/nfe-detail/' + n.id)"><td>{{ MODEL[n.model] }} @if (n.is_test) { <span class="badge badge-muted">TESTE</span> }</td><td class="mono" style="font-size:12px">{{ n.sale_number ?? '—' }}</td>
            <td class="mono" style="font-size:12px">{{ n.created_at | dt }}</td><td class="num">{{ n.total | brl }}</td><td><span class="badge" [class]="'badge ' + (n.status | statusClass)">{{ n.status | statusLabel }}</span></td></tr> }</tbody></table>
        <ax-state [loading]="loadingQ()" [empty]="!loadingQ() && !queue().length" emptyText="Nenhum documento pendente." emptyIcon="badge-check" />
      </div>
      <div class="card" style="overflow:hidden"><div style="padding:12px 16px;display:flex;align-items:center;gap:8px"><div style="flex:1;font-size:13px;font-weight:600">Vendas sem documento fiscal ({{ pending().length }})</div>
          <select class="input-field" style="width:120px;font-size:12px" [(ngModel)]="model"><option value="65">NFC-e</option><option value="55">NF-e</option></select></div>
        <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Venda</th><th>Data</th><th>Cliente</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>@for (s of pending(); track s.id) { <tr><td class="mono" style="font-size:12px">nº {{ s.number }}</td><td class="mono" style="font-size:12px">{{ s.created_at | dt }}</td><td style="font-size:12px">{{ s.customer || 'Consumidor' }}</td><td class="num">{{ s.total | brl }}</td>
            <td>@if (auth.can('fiscal.emitir')) { <button class="btn-ghost" style="font-size:11px;padding:3px 6px" (click)="create(s)">Gerar documento</button> }</td></tr> }</tbody></table>
        <ax-state [empty]="!pending().length" emptyText="Todas as vendas recentes têm documento." emptyIcon="badge-check" />
      </div>
    </div>
    <div class="card" style="padding:16px;margin-top:16px;font-size:12px;color:#647687"><b style="color:#172B3A">Obrigações acessórias</b> (SPED Fiscal, EFD-Contribuições, DeSTDA/DAS etc.) são apuradas e transmitidas pelo escritório contábil. Exporte os dados do período em Relatórios → Fiscal e os XMLs autorizados a partir de cada documento.</div>
  </div>`,
})
export class MonitorFiscalPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly tabs = FISCAL_TABS; readonly MODEL = MODEL;
  readonly st = signal<any>(null); readonly queue = signal<any[]>([]); readonly pending = signal<any[]>([]); readonly loadingQ = signal(true); model = '65';
  ngOnInit() { this.load(); this.api.get('/fiscal/status').then((s) => this.st.set(s)).catch(() => {}); }
  async load() {
    this.loadingQ.set(true);
    const sts = ['rascunho', 'invalido', 'pendente_configuracao', 'erro', 'rejeitado', 'contingencia', 'fila', 'processando'];
    const [q, p] = await Promise.all([Promise.all(sts.map((s) => this.api.get<any>('/fiscal/documents', { status: s, size: 50 }))), this.api.get<any[]>('/fiscal/pending-sales')]);
    this.queue.set(q.flatMap((r) => r.items).sort((a, b) => b.created_at.localeCompare(a.created_at))); this.pending.set(p); this.loadingQ.set(false);
  }
  async create(s: any) { try { const d: any = await this.api.post('/fiscal/documents/from-sale', { saleId: s.id, model: this.model }); this.toast.success(d.validation?.length ? `Documento criado com ${d.validation.length} pendência(s).` : 'Documento criado e validado.'); this.router.navigateByUrl('/nfe-detail/' + d.id); } catch (e) { this.toast.error(e); } }
}
