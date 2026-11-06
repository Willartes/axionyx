import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

const KIND_LABEL: Record<string, string> = { clientes: 'Clientes', fornecedores: 'Fornecedores', produtos: 'Produtos', estoque: 'Saldo de estoque', receber: 'Contas a receber', pagar: 'Contas a pagar', xml: 'XML de NF-e' };
const KIND_HINT: Record<string, string> = {
  clientes: 'Planilha de clientes exportada do ERP anterior. Clientes com CPF/CNPJ já cadastrado são mantidos como estão.',
  fornecedores: 'Planilha de fornecedores. CNPJ já cadastrado é mantido.',
  produtos: 'Uma linha por produto, ou por variação (mesmo código com cor/tamanho diferentes). Marcas, grupos, cores e tamanhos são criados automaticamente.',
  estoque: 'Saldo atual por produto (código de barras, SKU ou código). Importe os produtos antes. O sistema lança o ajuste até chegar no saldo informado.',
  receber: 'Títulos em aberto (crediário, boletos, duplicatas). Cliente pelo CPF/CNPJ ou nome; quem não existir é cadastrado.',
  pagar: 'Contas em aberto. Categoria pelo nome (se não achar, vai para Serviços).',
  xml: 'Um .zip com os XMLs de NF-e/NFC-e emitidas e recebidas (o contador costuma ter). Monta catálogo, clientes, fornecedores e o histórico de vendas. Notas canceladas e repetidas são ignoradas; não mexe em estoque nem financeiro.',
};
const ORDER = ['fornecedores', 'clientes', 'produtos', 'estoque', 'receber', 'pagar', 'xml'];

/** Central de Migração (equipe da plataforma): traz os dados do ERP anterior com prévia, relatório de erros e desfazer. */
@Component({
  selector: 'ax-plataforma-migracao',
  imports: [FormsModule, IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .lbl { font-size:11px; font-weight:600; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; display:block; }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
    .kinds { display:grid; grid-template-columns:repeat(7, minmax(0,1fr)); gap:8px; }
    .kind { border:1px solid #E3EAF1; border-radius:10px; padding:10px; cursor:pointer; background:white; text-align:left; font-size:13px; display:flex; flex-direction:column; gap:4px; }
    .kind.on { border-color:#0875D1; box-shadow:0 0 0 3px #E3EFF9; }
    .kind small { color:#647687; font-size:11px; }
    .steps { display:flex; gap:6px; font-size:12px; color:#647687; flex-wrap:wrap; }
    .steps span { padding:3px 10px; border-radius:999px; background:#EEF2F6; } .steps span.on { background:#0875D1; color:white; }
    .map { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px 14px; }
    .sum { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:10px; }
    .sum div { border-radius:10px; padding:10px 12px; background:#F7FAFD; } .sum b { display:block; font-size:20px; color:#172B3A; } .sum small { font-size:12px; color:#647687; }
    .drop { border:2px dashed #C9D6E2; border-radius:12px; padding:22px; text-align:center; cursor:pointer; color:#647687; font-size:13px; display:block; }
    .drop:hover { border-color:#0875D1; background:#F7FAFD; }
    .tbl-wrap { overflow-x:auto; max-height:420px; overflow-y:auto; }
    .err { color:#C93636; } .wrn { color:#9A6700; }
    @media (max-width: 1100px) { .kinds { grid-template-columns:repeat(2, minmax(0,1fr)); } .map, .sum { grid-template-columns:1fr 1fr; } }
  `],
  template: `
  <div style="padding:24px;max-width:1200px;display:flex;flex-direction:column;gap:16px">
    <div>
      <h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="file-input" [size]="20" color="#0875D1" /> Central de Migração</h1>
      <p style="font-size:13px;color:#647687;margin-top:4px">Traga os dados do ERP anterior do cliente: envie a planilha, confira as colunas e a prévia. Nada é gravado até você confirmar, e cada importação pode ser desfeita em até {{ meta()?.undoDays ?? 7 }} dias.</p>
    </div>

    @if (meta(); as m) {
      <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:14px">
        <div class="steps"><span [class.on]="!batch()">1. Arquivo</span><span [class.on]="batch()?.status === 'previa' && batch()?.kind !== 'xml'">2. Colunas e prévia</span><span [class.on]="batch()?.status === 'importando' || batch()?.status === 'importado'">3. Importação</span></div>
        <div class="row">
          <div style="flex:1;min-width:240px"><span class="lbl">Empresa</span>
            <select class="input-field" style="width:100%" [(ngModel)]="companyId" (ngModelChange)="onCompany()" [disabled]="!!batch()"><option value="">Escolha a empresa…</option>@for (c of m.companies; track c.id) { <option [value]="c.id">{{ c.trade_name || c.name }}{{ c.is_demo ? ' (demonstração)' : '' }}</option> }</select></div>
          @if (branches().length > 1) {
            <div style="min-width:200px"><span class="lbl">Filial (títulos e estoque sem filial)</span>
              <select class="input-field" style="width:100%" [(ngModel)]="branchId" [disabled]="!!batch()">@for (b of branches(); track b.id) { <option [value]="b.id">{{ b.code }} · {{ b.name }}</option> }</select></div>
          }
        </div>
        <div class="kinds">
          @for (k of order; track k) {
            <button class="kind" [class.on]="kind === k" [disabled]="!!batch()" (click)="kind = k"><b>{{ label(k) }}</b><small>{{ k === 'xml' ? '.zip de XMLs' : 'CSV ou Excel' }}</small></button>
          }
        </div>
        <div style="font-size:12px;color:#647687;display:flex;gap:6px"><ax-icon name="info" [size]="14" /> {{ hint(kind) }}</div>

        @if (!batch()) {
          <div class="row">
            @if (kind !== 'xml' && profilesFor().length) {
              <div style="min-width:220px"><span class="lbl">Perfil de colunas salvo</span>
                <select class="input-field" style="width:100%" [(ngModel)]="profileId"><option value="">Detectar automaticamente</option>@for (p of profilesFor(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></div>
            }
          </div>
          <label class="drop" [style.opacity]="companyId && !busy() ? 1 : .5">
            <ax-icon name="upload" [size]="22" /><div style="margin-top:6px">{{ busy() ? 'Lendo o arquivo…' : companyId ? 'Clique para escolher o arquivo (' + (kind === 'xml' ? '.zip' : '.csv ou .xlsx') + ')' : 'Escolha a empresa primeiro' }}</div>
            <input type="file" hidden [accept]="kind === 'xml' ? '.zip' : '.csv,.txt,.xlsx'" [disabled]="!companyId || busy()" (change)="upload($event)" />
          </label>
        }
      </div>

      @if (batch(); as b) {
        <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:14px">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
            <div><b style="color:#172B3A">{{ label(b.kind) }}</b> · <span class="muted" style="font-size:13px">{{ b.source_name }} · {{ b.rowsCount | num }} {{ b.kind === 'xml' ? 'notas' : 'linhas' }}</span></div>
            <div class="row">
              @if (b.status === 'previa') { <button class="btn-ghost" (click)="discard()"><ax-icon name="x" [size]="14" /> Descartar</button> }
              <button class="btn-ghost" (click)="reset()"><ax-icon name="arrow-left" [size]="14" /> Novo arquivo</button>
            </div>
          </div>
          @if (b.error) { <div class="err" style="font-size:13px">A última tentativa falhou e nada foi gravado: {{ b.error }}</div> }

          @if (b.kind !== 'xml' && b.status === 'previa') {
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
              <div style="font-weight:600;font-size:14px;color:#172B3A">Colunas da planilha</div>
              <div class="row">
                @if (m.ai) { <button class="btn-secondary" style="font-size:12px" [disabled]="busy()" (click)="aiMap()" title="Só os nomes das colunas e o formato dos valores (sem os dados) são enviados à IA"><ax-icon name="sparkles" [size]="12" /> Sugerir com IA</button> }
                <input class="input-field" style="width:180px;font-size:12px" placeholder="Nome do perfil (ex.: ERP X)" [(ngModel)]="profileName" />
                <button class="btn-ghost" style="font-size:12px" [disabled]="!profileName.trim() || busy()" (click)="saveProfile()"><ax-icon name="save" [size]="12" /> Salvar perfil</button>
              </div>
            </div>
            <div class="map">
              @for (f of fields(); track f.key) {
                <div><span class="lbl">{{ f.label }}@if (f.required) { <span class="err"> *</span> }</span>
                  <select class="input-field" style="width:100%" [ngModel]="mapping[f.key] ?? ''" (ngModelChange)="setMap(f.key, $event)" [class.invalid]="f.required && !mapping[f.key]">
                    <option value="">— não importar —</option>@for (h of b.headers; track h) { <option [value]="h">{{ h }}</option> }</select></div>
              }
            </div>
            <div><button class="btn-secondary" [disabled]="busy() || !dirty()" (click)="applyMap()"><ax-icon name="refresh-cw" [size]="14" /> Atualizar prévia</button></div>
          }

          @if (preview(); as p) {
            <div class="sum">
              @if (b.kind === 'xml') {
                <div><b>{{ p.summary.vendas | num }}</b><small>vendas para o histórico</small></div>
                <div><b>{{ p.summary.compras | num }}</b><small>compras (fornecedores e custos)</small></div>
                <div><b>{{ (p.summary.canceladas + p.summary.duplicadas + p.summary.repetidas) | num }}</b><small>ignoradas (canceladas/já importadas)</small></div>
                <div><b>{{ p.summary.produtos_novos | num }}</b><small>produtos novos</small></div>
                <div><b>{{ (p.summary.clientes_novos + p.summary.fornecedores_novos) | num }}</b><small>clientes e fornecedores novos</small></div>
              } @else {
                <div><b>{{ p.summary.total | num }}</b><small>linhas</small></div>
                <div><b style="color:#18864B">{{ p.summary.novos | num }}</b><small>serão importadas{{ p.summary.extra?.produtos ? ' (' + p.summary.extra.produtos + ' produtos)' : '' }}</small></div>
                <div><b>{{ p.summary.existentes | num }}</b><small>já existem (mantidas)</small></div>
                <div><b [class.err]="p.summary.erros">{{ p.summary.erros | num }}</b><small>com erro (não entram)</small></div>
                <div><b [class.wrn]="p.summary.avisos">{{ p.summary.avisos | num }}</b><small>com aviso</small></div>
              }
            </div>
            @if (b.kind === 'xml' && p.summary.vendas) { <div class="muted" style="font-size:12px">Total das vendas: {{ p.summary.valor_vendas_centavos / 100 | brl }}. O histórico entra com a data original de cada nota, sem lançar estoque, caixa ou contas a receber.</div> }
            @if (p.issues.length) {
              <div style="display:flex;justify-content:space-between;align-items:center"><div style="font-weight:600;font-size:14px;color:#172B3A">{{ b.kind === 'xml' ? 'Arquivos com problema' : 'Erros e avisos' }}</div>
                <button class="btn-ghost" style="font-size:12px" (click)="errorsCsv()"><ax-icon name="download" [size]="12" /> Baixar relatório (CSV)</button></div>
              <div class="tbl-wrap"><table class="data-table" style="width:100%;border-collapse:collapse">
                @if (b.kind === 'xml') {
                  <thead><tr><th>Arquivo</th><th>Problema</th></tr></thead>
                  <tbody>@for (i of p.issues; track $index) { <tr><td class="mono" style="font-size:12px">{{ i.file }}</td><td class="err" style="font-size:12px">{{ i.error }}</td></tr> }</tbody>
                } @else {
                  <thead><tr><th>Linha</th><th>Registro</th><th>Problema</th></tr></thead>
                  <tbody>@for (i of p.issues; track i.line) { <tr><td class="mono">{{ i.line }}</td><td style="font-size:12px">{{ i.data.nome || i.data.codigo || i.data.produto || i.data.documento || i.data.cliente || '—' }}</td>
                    <td style="font-size:12px">@for (e of i.errors; track $index) { <div class="err">{{ e }}</div> }@for (w of i.warnings; track $index) { <div class="wrn">{{ w }}</div> }</td></tr> }</tbody>
                }
              </table></div>
            }
            @if (p.sample?.length) {
              <details><summary style="cursor:pointer;font-size:13px;color:#0875D1">Ver amostra do que será importado</summary>
                <div class="tbl-wrap" style="margin-top:8px"><table class="data-table" style="width:100%;border-collapse:collapse">
                  <thead><tr><th>Linha</th>@for (f of sampleCols(); track f.key) { <th>{{ f.label }}</th> }<th></th></tr></thead>
                  <tbody>@for (i of p.sample; track i.line) { <tr><td class="mono">{{ i.line }}</td>@for (f of sampleCols(); track f.key) { <td style="font-size:12px">{{ i.data[f.key] ?? '' }}</td> }<td><span class="badge" [class.badge-success]="i.action === 'novo'" [class.badge-muted]="i.action !== 'novo'">{{ i.action === 'novo' ? 'nova' : 'já existe' }}</span></td></tr> }</tbody>
                </table></div></details>
            }
          }

          @if (b.status === 'previa') {
            <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap;border-top:1px solid #EEF2F6;padding-top:12px">
              @if (b.kind !== 'xml' && preview()?.summary.erros) { <label style="font-size:13px;display:flex;gap:6px;align-items:center"><input type="checkbox" [(ngModel)]="ignoreErrors" /> Importar só as linhas válidas</label> }
              <button class="btn-primary" [disabled]="busy() || running() || dirty() || !canCommit()" (click)="commit()"><ax-icon name="check" [size]="14" /> Importar</button>
            </div>
          }
          @if (job(); as j) {
            <div style="font-size:13px;display:flex;gap:8px;align-items:center" [class.err]="j.status === 'erro'">
              <ax-icon [name]="j.status === 'executando' ? 'hourglass' : j.status === 'ok' ? 'check-circle-2' : 'alert-triangle'" [size]="16" />
              {{ j.status === 'executando' ? 'Gravando… ' + (j.progress?.total ? j.progress.done + '/' + j.progress.total : '') : j.status === 'ok' ? 'Concluído: ' + resultText(j.result) : 'Falhou e nada foi gravado: ' + j.error }}
            </div>
          }
        </div>
      }

      <div class="card" style="overflow:hidden">
        <div style="padding:14px 16px;font-weight:600;color:#172B3A">Histórico de importações{{ companyId ? ' desta empresa' : '' }}</div>
        <div class="tbl-wrap"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Data</th><th>Empresa</th><th>Tipo</th><th>Arquivo</th><th>Resultado</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            @for (h of history(); track h.id) {
              <tr>
                <td class="mono" style="font-size:12px">{{ (h.imported_at || h.created_at) | dtt }}</td>
                <td style="font-size:12px">{{ h.company_name }}</td>
                <td>{{ label(h.kind) }}</td>
                <td style="font-size:12px">{{ h.source_name }}<span class="muted"> · {{ h.created_by_name }}</span></td>
                <td style="font-size:12px">{{ h.summary?.importado ? resultText(h.summary.importado) : h.rows_count + ' linhas' }}</td>
                <td><span class="badge" [class.badge-success]="h.status === 'importado'" [class.badge-info]="h.status === 'previa' || h.status === 'importando'" [class.badge-muted]="h.status === 'desfeito'" [class.badge-danger]="h.status === 'erro'">{{ statusLabel(h.status) }}</span></td>
                <td style="white-space:nowrap;text-align:right">
                  @if (h.status === 'previa') { <button class="btn-ghost" style="font-size:12px" (click)="open(h)">Continuar</button> }
                  @if (h.canUndo) { <button class="btn-ghost" style="font-size:12px;color:#C93636" [disabled]="busy()" (click)="undo(h)"><ax-icon name="undo-2" [size]="12" /> Desfazer</button> }
                </td>
              </tr>
            } @empty { <tr><td colspan="7" class="muted" style="text-align:center;padding:16px">Nenhuma importação ainda.</td></tr> }
          </tbody></table></div>
        <div class="muted" style="font-size:12px;padding:10px 16px">Desfazer remove o que a importação criou e ainda não foi usado. Produtos já vendidos ou movimentados e títulos já pagos são mantidos para não quebrar o histórico. Ordem recomendada: fornecedores → clientes → produtos → estoque → contas.</div>
      </div>
    }
  </div>`,
})
export class PlataformaMigracaoPage implements OnInit, OnDestroy {
  private api = inject(Api); private toast = inject(ToastService);
  readonly meta = signal<any>(null); readonly history = signal<any[]>([]); readonly batch = signal<any>(null); readonly preview = signal<any>(null);
  readonly busy = signal(false); readonly job = signal<any>(null); readonly dirty = signal(false);
  readonly order = ORDER;
  companyId = ''; branchId = ''; kind = 'clientes'; profileId = ''; profileName = ''; ignoreErrors = false;
  mapping: Record<string, string | null> = {};
  private timer: any = null;
  readonly running = computed(() => this.job()?.status === 'executando');
  branches() { return (this.meta()?.companies ?? []).find((c: any) => c.id === this.companyId)?.branches ?? []; }
  profilesFor() { return (this.meta()?.profiles ?? []).filter((p: any) => p.kind === this.kind); }
  fields(): any[] { return this.meta()?.fields?.[this.batch()?.kind] ?? []; }
  sampleCols() { const s = this.preview()?.sample ?? []; return this.fields().filter((f) => s.some((i: any) => i.data[f.key] !== undefined && i.data[f.key] !== '')).slice(0, 8); }
  canCommit() { const p = this.preview(); if (!p) return false; if (this.batch()?.kind === 'xml') return p.summary.vendas + p.summary.compras > 0; return p.summary.novos > 0 && (!p.summary.erros || this.ignoreErrors); }
  label(k: string) { return KIND_LABEL[k] ?? k; }
  hint(k: string) { return KIND_HINT[k] ?? ''; }
  statusLabel(s: string) { return ({ previa: 'em conferência', importando: 'importando', importado: 'importado', desfeito: 'desfeito', erro: 'erro' } as any)[s] ?? s; }
  resultText(r: any) {
    if (!r) return '';
    const names: Record<string, string> = { clientes: 'clientes', fornecedores: 'fornecedores', produtos: 'produtos', variacoes: 'variações', ajustes: 'saldos ajustados', sem_alteracao: 'sem alteração', titulos: 'títulos', clientes_criados: 'clientes criados', fornecedores_criados: 'fornecedores criados', vendas: 'vendas no histórico', custos_atualizados: 'custos atualizados' };
    return Object.entries(r).filter(([k, v]) => names[k] && v).map(([k, v]) => `${v} ${names[k]}`).join(', ') + (r.valor_centavos ? ` · ${(r.valor_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` : '') || 'nada novo';
  }

  ngOnInit() { this.load(); }
  ngOnDestroy() { clearTimeout(this.timer); }
  async load() { try { this.meta.set(await this.api.get('/platform/migration/meta')); this.loadHistory(); } catch (e) { this.toast.error(e); } }
  async loadHistory() { try { this.history.set(await this.api.get('/platform/migration/batches', this.companyId ? { company: this.companyId } : undefined)); } catch { /* */ } }
  onCompany() { this.branchId = this.branches()[0]?.id ?? ''; this.loadHistory(); }
  private async run(fn: () => Promise<any>) { this.busy.set(true); try { return await fn(); } catch (e) { this.toast.error(e); return null; } finally { this.busy.set(false); } }
  private show(r: any) { this.batch.set(r.batch); this.preview.set(r.preview); this.mapping = { ...(r.batch.mapping ?? {}) }; this.dirty.set(false); this.ignoreErrors = false; }

  async upload(ev: Event) {
    const input = ev.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
    if (!file) return;
    const q = new URLSearchParams({ company: this.companyId, kind: this.kind, name: file.name, ...(this.branchId ? { branch: this.branchId } : {}), ...(this.profileId ? { profile: this.profileId } : {}) });
    const r = await this.run(() => this.api.raw('/platform/migration/upload?' + q.toString(), file, 'application/octet-stream'));
    if (r) { this.job.set(null); this.show(r); this.loadHistory(); }
  }
  async open(h: any) {
    const r = await this.run(() => this.api.get(`/platform/migration/batches/${h.id}`));
    if (r) { this.companyId = r.batch.company_id; this.branchId = r.batch.branch_id; this.kind = r.batch.kind; this.job.set(null); this.show(r); }
  }
  setMap(key: string, col: string) { this.mapping = { ...this.mapping, [key]: col || null }; this.dirty.set(true); }
  async applyMap() { const r = await this.run(() => this.api.put(`/platform/migration/batches/${this.batch().id}/mapping`, { mapping: this.mapping })); if (r) this.show(r); }
  async aiMap() {
    const r = await this.run(() => this.api.post(`/platform/migration/batches/${this.batch().id}/ai-mapping`));
    if (r) { const n = Object.values(r.mapping).filter(Boolean).length; this.mapping = { ...this.mapping, ...Object.fromEntries(Object.entries(r.mapping).filter(([, v]) => v)) as any }; this.dirty.set(true); this.toast.success(`IA sugeriu ${n} coluna(s). Confira e clique em "Atualizar prévia".`); }
  }
  async saveProfile() {
    const r = await this.run(() => this.api.post('/platform/migration/profiles', { name: this.profileName.trim(), kind: this.batch().kind, mapping: this.mapping }));
    if (r) { this.toast.success('Perfil salvo: será oferecido nos próximos arquivos deste tipo.'); this.profileName = ''; this.meta.update((m) => ({ ...m, profiles: [...m.profiles.filter((p: any) => p.id !== r.id), r] })); }
  }
  errorsCsv() { this.run(() => this.api.download(`/platform/migration/batches/${this.batch().id}/errors.csv`, undefined, 'erros-migracao.csv')); }
  async discard() { if (await this.run(() => this.api.delete(`/platform/migration/batches/${this.batch().id}`))) { this.reset(); this.loadHistory(); } }
  reset() { clearTimeout(this.timer); this.batch.set(null); this.preview.set(null); this.job.set(null); this.mapping = {}; this.dirty.set(false); }

  async commit() {
    const b = this.batch(), p = this.preview();
    const what = b.kind === 'xml' ? `${p.summary.vendas} venda(s) para o histórico e ${p.summary.compras} compra(s)` : `${p.summary.novos} registro(s)`;
    if (!confirm(`Importar ${what} em ${this.companyName()}? Poderá desfazer em até ${this.meta()?.undoDays ?? 7} dias.`)) return;
    const r = await this.run(() => this.api.post(`/platform/migration/batches/${b.id}/commit`, { ignoreErrors: this.ignoreErrors }));
    if (r?.jobId) { this.batch.set({ ...b, status: 'importando' }); this.poll(r.jobId, b.id); }
  }
  async undo(h: any) {
    if (!confirm(`Desfazer a importação de ${this.label(h.kind).toLowerCase()} (${h.source_name}) em ${h.company_name}? O que já foi usado (vendas, pagamentos) é mantido.`)) return;
    const r = await this.run(() => this.api.post(`/platform/migration/batches/${h.id}/undo`));
    if (r?.jobId) this.poll(r.jobId, null);
  }
  private companyName() { const c = (this.meta()?.companies ?? []).find((x: any) => x.id === this.companyId); return c?.trade_name || c?.name || 'a empresa'; }
  private poll(id: string, batchId: string | null) {
    clearTimeout(this.timer);
    const tick = async () => {
      try {
        const j = await this.api.get(`/platform/jobs/${id}`); this.job.set(j);
        if (j.status === 'executando') { this.timer = setTimeout(tick, 1000); return; }
        this.loadHistory();
        if (j.status === 'ok') this.toast.success(j.kind === 'migracao_desfazer' ? `Desfeito: ${j.result.removed} removido(s), ${j.result.kept} mantido(s) por já terem uso.` : 'Importação concluída.');
        else this.toast.error(j.error);
        if (batchId) { const r = await this.api.get(`/platform/migration/batches/${batchId}`); this.batch.set(r.batch); if (r.preview) this.preview.set(r.preview); }
      } catch (e) { this.toast.error(e); }
    };
    tick();
  }
}
