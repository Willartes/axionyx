import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

/** Backup e restauração (equipe da plataforma): sistema inteiro ou por empresa, manual e agendado, cifrado, R2/S3 ou banco. */
@Component({
  selector: 'ax-plataforma-backup',
  imports: [FormsModule, IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .lbl { font-size:11px; font-weight:600; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; display:block; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; }
    .grid3 { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px; }
    .stat { display:flex; gap:10px; align-items:flex-start; }
    .stat b { display:block; font-size:14px; color:#172B3A; }
    .stat small { font-size:12px; color:#647687; }
    .job { border:1px solid #CFE2F3; background:#F3F8FD; border-radius:10px; padding:10px 14px; font-size:13px; display:flex; gap:10px; align-items:center; }
    .bar { height:6px; background:#E3EAF1; border-radius:4px; overflow:hidden; flex:1; min-width:120px; } .bar i { display:block; height:100%; background:#0875D1; }
    .modal-bg { position:fixed; inset:0; background:rgba(16,32,48,.45); display:flex; align-items:center; justify-content:center; z-index:60; padding:16px; }
    .modal { background:white; border-radius:12px; padding:20px; width:100%; max-width:520px; display:flex; flex-direction:column; gap:12px; }
    .opt { border:1px solid #E3EAF1; border-radius:10px; padding:12px; cursor:pointer; display:flex; gap:10px; }
    .opt.on { border-color:#0875D1; box-shadow:0 0 0 3px #E3EFF9; }
    .warn { background:#FFF7E6; border:1px solid #F5D9A0; color:#7A5200; border-radius:8px; padding:10px; font-size:12px; }
    .tbl-wrap { overflow-x:auto; }
    .btn-danger:disabled { opacity:.5; cursor:not-allowed; }
    @media (max-width: 1000px) { .grid3 { grid-template-columns:1fr; } }
  `],
  template: `
  <div style="padding:24px;max-width:1200px;display:flex;flex-direction:column;gap:16px">
    <div>
      <h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="archive" [size]="20" color="#0875D1" /> Backup e restauração</h1>
      <p style="font-size:13px;color:#647687;margin-top:4px">Cópias cifradas do sistema inteiro ou de uma empresa isolada. Restaure uma empresa como cópia (para conferir) ou substituindo os dados atuais.</p>
    </div>

    @if (s(); as s) {
      <div class="grid3">
        <div class="card stat" style="padding:14px">
          <ax-icon [name]="s.storage === 'r2' ? 'cloud' : 'database'" [size]="20" [color]="s.storage === 'r2' ? '#18864B' : '#D99000'" />
          <div><b>{{ s.storage === 'r2' ? 'Armazenamento externo (R2/S3)' : 'Guardado no próprio banco' }}</b>
            <small>{{ s.s3 ? s.s3.bucket + ' · ' + s.s3.endpoint : 'Configure BACKUP_S3_* (Cloudflare R2) para guardar fora do servidor.' }}</small>
            <div style="margin-top:6px"><button class="btn-ghost" style="font-size:12px;padding:4px 8px" [disabled]="busy()" (click)="testStorage()"><ax-icon name="refresh-cw" [size]="12" /> Testar</button></div></div>
        </div>
        <div class="card stat" style="padding:14px">
          <ax-icon name="lock" [size]="20" [color]="s.key.source === 'BACKUP_ENCRYPTION_KEY' ? '#18864B' : '#D99000'" />
          <div><b>Criptografia AES-256-GCM</b>
            <small>Chave: {{ keyLabel(s.key.source) }}@if (s.key.fingerprint) { · impressão {{ s.key.fingerprint }} }</small></div>
        </div>
        <div class="card stat" style="padding:14px">
          <ax-icon name="calendar-clock" [size]="20" color="#0875D1" />
          <div><b>{{ activeSchedules() }} agendamento(s) ativo(s)</b>
            <small>{{ lastOk() ? 'Último backup concluído: ' : 'Nenhum backup concluído ainda.' }}@if (lastOk(); as l) { {{ l.finished_at | dtt }} }</small></div>
        </div>
      </div>

      @if (job(); as j) {
        <div class="job">
          <ax-icon [name]="j.status === 'erro' ? 'alert-triangle' : j.status === 'ok' ? 'check-circle-2' : 'hourglass'" [size]="16" [color]="j.status === 'erro' ? '#C93636' : j.status === 'ok' ? '#18864B' : '#0875D1'" />
          <span style="flex:1">{{ jobLabel(j) }}</span>
          @if (j.status === 'executando' && j.progress?.total) { <div class="bar"><i [style.width.%]="100 * j.progress.done / j.progress.total"></i></div> }
          @if (j.status !== 'executando') { <button class="btn-ghost" style="font-size:12px" (click)="job.set(null)"><ax-icon name="x" [size]="12" /></button> }
        </div>
      }

      <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <div style="font-weight:600;color:#172B3A">Fazer backup agora</div>
        <div class="row">
          <div><span class="lbl">Escopo</span>
            <select class="input-field" style="width:200px" [(ngModel)]="form.scope"><option value="empresa">Uma empresa</option><option value="sistema">Sistema inteiro</option></select></div>
          @if (form.scope === 'empresa') {
            <div style="flex:1;min-width:220px"><span class="lbl">Empresa</span>
              <select class="input-field" style="width:100%" [(ngModel)]="form.companyId"><option value="">Escolha…</option>@for (c of s.companies; track c.id) { <option [value]="c.id">{{ c.trade_name || c.name }}{{ c.is_demo ? ' (demonstração)' : '' }}</option> }</select></div>
          }
          <label style="display:flex;gap:6px;align-items:center;font-size:13px;padding-bottom:8px"><input type="checkbox" [(ngModel)]="form.includeDocuments" /> Incluir documentos enviados</label>
          <button class="btn-primary" [disabled]="busy() || running() || (form.scope === 'empresa' && !form.companyId)" (click)="backupNow()"><ax-icon name="archive" [size]="14" /> Gerar backup</button>
          <label class="btn-secondary" style="cursor:pointer" [class.disabled]="busy()"><ax-icon name="upload" [size]="14" /> Enviar .axbak<input type="file" accept=".axbak" hidden (change)="upload($event)" /></label>
        </div>
      </div>

      <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;justify-content:space-between;align-items:center"><div style="font-weight:600;color:#172B3A">Agendamentos</div>
          <button class="btn-secondary" style="font-size:12px" (click)="newSchedule()"><ax-icon name="plus" [size]="12" /> Novo agendamento</button></div>
        @if (edit(); as e) {
          <div class="row" style="background:#F7FAFD;border-radius:10px;padding:12px">
            @if (!e.id) {
              <div><span class="lbl">Escopo</span><select class="input-field" [(ngModel)]="e.scope"><option value="sistema">Sistema inteiro</option><option value="empresa">Uma empresa</option></select></div>
              @if (e.scope === 'empresa') { <div style="min-width:200px"><span class="lbl">Empresa</span><select class="input-field" style="width:100%" [(ngModel)]="e.companyId"><option value="">Escolha…</option>@for (c of s.companies; track c.id) { <option [value]="c.id">{{ c.trade_name || c.name }}</option> }</select></div> }
            }
            <div><span class="lbl">Frequência</span><select class="input-field" [(ngModel)]="e.frequency"><option value="diario">Diário</option><option value="semanal">Semanal</option><option value="mensal">Mensal</option></select></div>
            @if (e.frequency === 'semanal') { <div><span class="lbl">Dia</span><select class="input-field" [(ngModel)]="e.weekday">@for (d of weekdays; track $index) { <option [ngValue]="$index">{{ d }}</option> }</select></div> }
            @if (e.frequency === 'mensal') { <div><span class="lbl">Dia do mês</span><input class="input-field" type="number" min="1" max="28" style="width:80px" [(ngModel)]="e.monthday" /></div> }
            <div><span class="lbl">Hora (Brasília)</span><select class="input-field" [(ngModel)]="e.hour">@for (h of hours; track h) { <option [ngValue]="h">{{ h }}h</option> }</select></div>
            <div><span class="lbl">Manter últimos</span><input class="input-field" type="number" min="1" max="365" style="width:80px" [(ngModel)]="e.keep" /></div>
            <label style="display:flex;gap:6px;align-items:center;font-size:13px;padding-bottom:8px"><input type="checkbox" [(ngModel)]="e.includeDocuments" /> Documentos</label>
            <label style="display:flex;gap:6px;align-items:center;font-size:13px;padding-bottom:8px"><input type="checkbox" [(ngModel)]="e.active" /> Ativo</label>
            <button class="btn-primary" [disabled]="busy()" (click)="saveSchedule()"><ax-icon name="save" [size]="14" /> Salvar</button>
            <button class="btn-ghost" (click)="edit.set(null)">Cancelar</button>
          </div>
        }
        <div class="tbl-wrap"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Escopo</th><th>Frequência</th><th>Retenção</th><th>Próximo</th><th>Último</th><th></th></tr></thead>
          <tbody>
            @for (x of s.schedules; track x.id) {
              <tr [style.opacity]="x.active ? 1 : .55">
                <td>{{ x.scope === 'sistema' ? 'Sistema inteiro' : x.company_name }}</td>
                <td>{{ freqLabel(x) }}</td>
                <td>{{ x.keep }} cópias</td>
                <td class="mono" style="font-size:12px">{{ x.active ? (x.next_run_at | dtt) : 'pausado' }}</td>
                <td style="font-size:12px">@if (x.last_run_at) { <span class="badge" [class.badge-success]="x.last_status === 'ok'" [class.badge-danger]="x.last_status === 'erro'" [title]="x.last_error || ''">{{ x.last_status === 'ok' ? 'ok' : 'falhou' }}</span> {{ x.last_run_at | dtt }} } @else { — }</td>
                <td style="white-space:nowrap;text-align:right"><button class="btn-ghost" style="font-size:12px" (click)="editSchedule(x)"><ax-icon name="pencil" [size]="12" /></button><button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="removeSchedule(x)"><ax-icon name="trash-2" [size]="12" /></button></td>
              </tr>
            } @empty { <tr><td colspan="6" class="muted" style="text-align:center;padding:16px">Nenhum agendamento. Recomendado: sistema inteiro, diário de madrugada, mantendo 14 cópias.</td></tr> }
          </tbody></table></div>
      </div>

      <div class="card" style="overflow:hidden">
        <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="font-weight:600;color:#172B3A">Backups</div>
          <select class="input-field" style="width:240px" [(ngModel)]="filter"><option value="">Todos</option><option value="sistema">Sistema inteiro</option>@for (c of s.companies; track c.id) { <option [value]="c.id">{{ c.trade_name || c.name }}</option> }</select>
        </div>
        <div class="tbl-wrap"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Data/Hora</th><th>Escopo</th><th>Origem</th><th>Onde</th><th class="num">Tamanho</th><th class="num">Registros</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            @for (f of files(); track f.id) {
              <tr>
                <td class="mono" style="font-size:12px">{{ f.created_at | dtt }}</td>
                <td>{{ f.scope === 'sistema' ? 'Sistema inteiro' : f.company_name }}</td>
                <td style="font-size:12px">{{ kindLabel(f.kind) }}@if (f.created_by_name) { <span class="muted"> · {{ f.created_by_name }}</span> }</td>
                <td style="font-size:12px">{{ f.storage === 'r2' ? 'R2/S3' : 'Banco' }}@if (f.status === 'ok' && f.error) { <span class="badge badge-warning" [title]="f.error" style="margin-left:4px">R2 falhou</span> }</td>
                <td class="num">{{ size(f.size) }}</td>
                <td class="num">{{ f.rows | num }}</td>
                <td><span class="badge" [class.badge-success]="f.status === 'ok'" [class.badge-info]="f.status === 'gerando'" [class.badge-danger]="f.status === 'erro'" [title]="f.error || ''">{{ f.status === 'ok' ? 'ok' : f.status === 'gerando' ? 'gerando' : 'erro' }}</span></td>
                <td style="white-space:nowrap;text-align:right">
                  @if (f.status === 'ok') {
                    <button class="btn-ghost" style="font-size:12px" title="Baixar" (click)="download(f)"><ax-icon name="download" [size]="12" /></button>
                    @if (f.scope === 'empresa') { <button class="btn-ghost" style="font-size:12px" title="Restaurar" (click)="openRestore(f)"><ax-icon name="rotate-ccw" [size]="12" /> Restaurar</button> }
                  }
                  @if (f.status !== 'gerando') { <button class="btn-ghost" style="font-size:12px;color:#C93636" title="Excluir" (click)="remove(f)"><ax-icon name="trash-2" [size]="12" /></button> }
                </td>
              </tr>
            } @empty { <tr><td colspan="8" class="muted" style="text-align:center;padding:16px">Nenhum backup ainda.</td></tr> }
          </tbody></table></div>
        <div class="muted" style="font-size:12px;padding:10px 16px">O backup do sistema inteiro é restaurado num banco novo pelo comando <span class="mono">npm run restore-system</span> (veja docs/BACKUP.md).</div>
      </div>
    }

    @if (restoring(); as r) {
      <div class="modal-bg" (click)="restoring.set(null)">
        <div class="modal" (click)="$event.stopPropagation()">
          <div style="font-weight:700;font-size:16px;color:#172B3A">Restaurar backup</div>
          <div style="font-size:13px;color:#647687">{{ r.company_name }} · {{ r.created_at | dtt }}</div>
          <div class="opt" [class.on]="mode === 'copia'" (click)="mode = 'copia'"><ax-icon name="copy" [size]="18" color="#0875D1" />
            <div><b style="font-size:13px">Restaurar como cópia</b><div style="font-size:12px;color:#647687">Cria uma nova empresa "(restaurada em …)" com os dados do backup. A empresa atual não é alterada.</div></div></div>
          <div class="opt" [class.on]="mode === 'substituir'" [style.opacity]="s()?.canReplace && r.company_id ? 1 : .5" (click)="s()?.canReplace && r.company_id && (mode = 'substituir')"><ax-icon name="rotate-ccw" [size]="18" color="#C93636" />
            <div><b style="font-size:13px">Substituir os dados atuais</b><div style="font-size:12px;color:#647687">Volta a empresa para o estado do backup. Antes, um backup de segurança da situação atual é gerado automaticamente.@if (!s()?.canReplace) { Exclusivo do proprietário da plataforma. }</div></div></div>
          @if (mode === 'substituir') {
            <div class="warn">Tudo o que foi lançado nesta empresa depois de {{ r.created_at | dtt }} será desfeito. Digite <b>SUBSTITUIR</b> para confirmar.</div>
            <input class="input-field" [(ngModel)]="confirmText" placeholder="SUBSTITUIR" />
          }
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn-ghost" (click)="restoring.set(null)">Cancelar</button>
            <button [class]="mode === 'substituir' ? 'btn-danger' : 'btn-primary'" [disabled]="busy() || (mode === 'substituir' && confirmText.trim().toUpperCase() !== 'SUBSTITUIR')" (click)="restore()">Restaurar</button>
          </div>
        </div>
      </div>
    }
  </div>`,
})
export class PlataformaBackupPage implements OnInit, OnDestroy {
  private api = inject(Api); private toast = inject(ToastService);
  readonly s = signal<any>(null); readonly busy = signal(false); readonly job = signal<any>(null);
  readonly edit = signal<any>(null); readonly restoring = signal<any>(null);
  form = { scope: 'empresa', companyId: '', includeDocuments: true };
  filter = ''; mode: 'copia' | 'substituir' = 'copia'; confirmText = '';
  readonly weekdays = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  readonly hours = Array.from({ length: 24 }, (_, i) => i);
  private timer: any = null;
  readonly running = computed(() => this.job()?.status === 'executando');
  readonly activeSchedules = computed(() => (this.s()?.schedules ?? []).filter((x: any) => x.active).length);
  readonly lastOk = computed(() => (this.s()?.files ?? []).find((f: any) => f.status === 'ok' && f.kind !== 'enviado'));
  files() { const f = this.filter, all = this.s()?.files ?? []; return !f ? all : f === 'sistema' ? all.filter((x: any) => x.scope === 'sistema') : all.filter((x: any) => x.company_id === f); }

  ngOnInit() { this.load(); }
  ngOnDestroy() { clearTimeout(this.timer); }
  async load() { try { this.s.set(await this.api.get('/platform/backup')); } catch (e) { this.toast.error(e); } }

  keyLabel(src: string) { if (!src) return 'não configurada'; return src === 'BACKUP_ENCRYPTION_KEY' ? 'própria (BACKUP_ENCRYPTION_KEY)' : 'derivada da chave mestra — defina BACKUP_ENCRYPTION_KEY e guarde-a fora do servidor'; }
  kindLabel(k: string) { return ({ manual: 'Manual', agendado: 'Agendado', seguranca: 'Segurança (antes de restaurar)', enviado: 'Enviado' } as any)[k] ?? k; }
  freqLabel(x: any) { const h = `${x.hour}h`; return x.frequency === 'diario' ? `Diário às ${h}` : x.frequency === 'semanal' ? `${this.weekdays[x.weekday ?? 0]} às ${h}` : `Dia ${x.monthday ?? 1} às ${h}`; }
  size(b: number) { if (!b) return '—'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return `${b.toFixed(i ? 1 : 0)} ${u[i]}`; }
  jobLabel(j: any) {
    const what = j.kind === 'backup' ? 'Backup' : 'Restauração';
    if (j.status === 'erro') return `${what} falhou: ${j.error}`;
    if (j.status === 'ok') return j.kind === 'backup' ? 'Backup concluído.' : `Restauração concluída${j.result?.mode === 'copia' ? ' — a cópia aparece na lista de empresas' : ''}.`;
    const p = j.progress || {};
    return `${what} em andamento… ${p.step ?? (p.table ? 'tabela ' + p.table : '')}${p.total ? ` (${p.done}/${p.total})` : ''}`;
  }

  private poll(id: string) {
    clearTimeout(this.timer);
    const tick = async () => {
      try {
        const j = await this.api.get(`/platform/jobs/${id}`); this.job.set(j);
        if (j.status === 'executando') this.timer = setTimeout(tick, 1200);
        else { this.load(); if (j.status === 'ok') this.toast.success(this.jobLabel(j)); else this.toast.error(j.error); }
      } catch (e) { this.toast.error(e); }
    };
    tick();
  }
  async run(fn: () => Promise<any>) { this.busy.set(true); try { return await fn(); } catch (e) { this.toast.error(e); return null; } finally { this.busy.set(false); } }

  async testStorage() { const r = await this.run(() => this.api.post('/platform/backup/test-storage')); if (r) r.ok ? this.toast.success(r.kind === 'r2' ? 'R2/S3 respondeu: gravou, leu e apagou um arquivo de teste.' : 'Sem R2/S3 configurado: os backups ficam no próprio banco.') : this.toast.error('Falha no R2/S3: ' + (r.error || 'sem resposta')); }
  async backupNow() {
    const r = await this.run(() => this.api.post('/platform/backups', { scope: this.form.scope, companyId: this.form.scope === 'empresa' ? this.form.companyId : undefined, includeDocuments: this.form.includeDocuments }));
    if (r?.jobId) { this.toast.success('Backup iniciado.'); this.poll(r.jobId); setTimeout(() => this.load(), 800); }
  }
  async upload(ev: Event) {
    const input = ev.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
    if (!file) return;
    const r = await this.run(() => this.api.raw('/platform/backups/upload', file, 'application/octet-stream'));
    if (r) { this.toast.success(`Arquivo recebido: ${r.header.scope === 'sistema' ? 'sistema inteiro' : r.header.company?.name}.`); this.load(); }
  }
  download(f: any) { this.run(() => this.api.download(`/platform/backups/${f.id}/download`, undefined, 'backup.axbak')); }
  async remove(f: any) {
    if (!confirm(`Excluir o backup de ${f.scope === 'sistema' ? 'sistema inteiro' : f.company_name} (${new Date(f.created_at).toLocaleString('pt-BR')})? Não há como recuperar.`)) return;
    if (await this.run(() => this.api.delete(`/platform/backups/${f.id}`))) { this.toast.success('Backup excluído.'); this.load(); }
  }
  openRestore(f: any) { this.mode = 'copia'; this.confirmText = ''; this.restoring.set(f); }
  async restore() {
    const f = this.restoring();
    const r = await this.run(() => this.api.post(`/platform/backups/${f.id}/restore`, { mode: this.mode, confirm: this.mode === 'substituir' ? this.confirmText : undefined }));
    if (r?.jobId) { this.restoring.set(null); this.toast.success('Restauração iniciada.'); this.poll(r.jobId); }
  }

  newSchedule() { this.edit.set({ scope: 'sistema', companyId: '', frequency: 'diario', hour: 3, weekday: 0, monthday: 1, keep: 14, includeDocuments: true, active: true }); }
  editSchedule(x: any) { this.edit.set({ id: x.id, scope: x.scope, companyId: x.company_id, frequency: x.frequency, hour: x.hour, weekday: x.weekday ?? 0, monthday: x.monthday ?? 1, keep: x.keep, includeDocuments: x.include_documents, active: x.active }); }
  async saveSchedule() {
    const e = this.edit();
    const body: any = { frequency: e.frequency, hour: Number(e.hour), keep: Number(e.keep), includeDocuments: !!e.includeDocuments, active: !!e.active,
      weekday: e.frequency === 'semanal' ? Number(e.weekday) : undefined, monthday: e.frequency === 'mensal' ? Number(e.monthday) : undefined };
    if (!e.id) { body.scope = e.scope; if (e.scope === 'empresa') { if (!e.companyId) { this.toast.error('Escolha a empresa.'); return; } body.companyId = e.companyId; } }
    const r = await this.run(() => e.id ? this.api.put(`/platform/backup/schedules/${e.id}`, body) : this.api.post('/platform/backup/schedules', body));
    if (r) { this.toast.success('Agendamento salvo.'); this.edit.set(null); this.load(); }
  }
  async removeSchedule(x: any) {
    if (!confirm('Excluir este agendamento? Os backups já gerados continuam na lista.')) return;
    if (await this.run(() => this.api.delete(`/platform/backup/schedules/${x.id}`))) this.load();
  }
}
