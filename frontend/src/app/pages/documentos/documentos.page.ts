import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { IconComponent } from '../../shared/icon.component';
import { ListState, PagerComponent, StateComponent } from '../../shared/ui';
import { fmtSize } from '../../shared/docs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

const DEFAULT_FOLDERS = ['Contratos', 'Fiscal', 'Jurídico', 'RH', 'Fornecedores', 'Geral'];
const ENTITY: Record<string, string> = { colaborador: 'Colaborador', processo: 'Processo', cliente: 'Cliente', produto: 'Produto' };

@Component({
  selector: 'ax-documentos',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;height:100%">
    <div style="width:200px;border-right:1px solid #DCE4EC;background:white;padding:12px 0;flex-shrink:0;overflow-y:auto">
      <div style="padding:0 12px;margin-bottom:8px"><input class="input-field" style="font-size:12px" placeholder="Nova pasta..." [(ngModel)]="newFolder" (keyup.enter)="addFolder()" /></div>
      <div class="tree-item" [class.sel]="folder() === ''" (click)="pick('')"><ax-icon name="folder-open" [size]="14" color="#0875D1" /> Todos <span class="muted" style="margin-left:auto;font-size:11px">{{ totalAll() }}</span></div>
      @for (f of folders(); track f.folder) {
        <div class="tree-item" [class.sel]="folder() === f.folder" (click)="pick(f.folder)"><ax-icon name="folder" [size]="14" color="#D99000" /> {{ f.folder }} <span class="muted" style="margin-left:auto;font-size:11px">{{ f.n || '' }}</span></div>
      }
    </div>
    <div style="flex:1;display:flex;flex-direction:column;border-right:1px solid #DCE4EC;overflow:hidden">
      <div style="padding:12px 16px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:10px">
        <div style="position:relative;flex:1"><ax-icon name="search" [size]="13" color="#A0AFBF" style="position:absolute;left:8px;top:50%;transform:translateY(-50%)" />
          <input class="input-field" style="padding-left:28px;font-size:12px" placeholder="Pesquisar documentos pelo nome..." [(ngModel)]="q" (keyup.enter)="apply()" /></div>
        @if (auth.can('documentos.editar')) { <label class="btn-primary" style="font-size:12px;cursor:pointer"><ax-icon name="upload" [size]="13" /> Upload<input type="file" multiple style="display:none" (change)="upload($event)" /></label> }
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
          <thead style="position:sticky;top:0"><tr><th>Documento</th><th>Tipo</th><th>Tamanho</th><th>Data</th><th>Pasta / vínculo</th><th>Ações</th></tr></thead>
          <tbody>@for (d of list.items(); track d.id) {
            <tr style="cursor:pointer" [style.background]="sel()?.id === d.id ? '#F0F7FF' : null" (click)="select(d)">
              <td><div style="display:flex;align-items:center;gap:8px"><ax-icon name="file-text" [size]="14" color="#0875D1" /><span style="font-size:13px">{{ d.name }}</span></div></td>
              <td><span class="badge badge-muted">{{ ext(d) }}</span></td><td class="mono" style="font-size:12px">{{ size(d.size) }}</td><td class="mono" style="font-size:12px">{{ d.created_at | dt }}</td>
              <td><span class="badge badge-cyan">{{ d.folder }}</span> @if (d.entity) { <span class="badge badge-muted">{{ E[d.entity] || d.entity }}</span> }</td>
              <td (click)="$event.stopPropagation()"><div style="display:flex;gap:4px"><button class="btn-ghost" style="padding:3px 5px" (click)="select(d)" aria-label="Ver"><ax-icon name="eye" [size]="13" /></button>
                <button class="btn-ghost" style="padding:3px 5px" (click)="dl(d)" aria-label="Baixar"><ax-icon name="download" [size]="13" /></button>
                @if (auth.can('documentos.editar')) { <button class="btn-ghost" style="padding:3px 5px;color:#C93636" (click)="remove(d)" aria-label="Excluir"><ax-icon name="trash-2" [size]="13" /></button> }</div></td>
            </tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum documento nesta pasta." emptyIcon="folder" />
      </div>
      <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
    </div>
    <div style="width:300px;background:white;padding:16px;overflow-y:auto;flex-shrink:0">
      @if (sel(); as d) {
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px"><ax-icon name="file-text" [size]="20" color="#0875D1" /><div><div style="font-size:13px;font-weight:700;color:#172B3A;word-break:break-all">{{ d.name }}</div><div style="font-size:11px;color:#647687">{{ ext(d) }} · {{ size(d.size) }}</div></div></div>
        <div style="height:220px;background:#F4F7FA;border:1px dashed #DCE4EC;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-bottom:16px;overflow:hidden">
          @if (img()) { <img [src]="img()" style="max-width:100%;max-height:100%" alt="pré-visualização" /> }
          @else if (pdf()) { <iframe [src]="pdf()" style="width:100%;height:100%;border:0" title="pré-visualização"></iframe> }
          @else if (text()) { <pre style="font-size:10px;padding:8px;margin:0;width:100%;height:100%;overflow:auto;white-space:pre-wrap">{{ text() }}</pre> }
          @else { <div style="text-align:center;color:#A0AFBF"><ax-icon name="file-text" [size]="36" color="#A0AFBF" /><div style="font-size:12px">Pré-visualização indisponível para este tipo</div></div> }
        </div>
        @for (r of [['Pasta', d.folder], ['Tipo', d.mime], ['Tamanho', size(d.size)], ['Enviado por', d.uploaded_by_name || '—'], ['Vínculo', d.entity ? (E[d.entity] || d.entity) : '—']]; track r[0]) {
          <div style="margin-bottom:8px"><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">{{ r[0] }}</div><div style="font-size:13px;color:#172B3A">{{ r[1] }}</div></div>
        }
        <div style="margin-bottom:8px"><div style="font-size:10px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Enviado em</div><div style="font-size:13px">{{ d.created_at | dtt }}</div></div>
        <button class="btn-primary" style="width:100%;justify-content:center;margin-top:14px;font-size:12px" (click)="dl(d)"><ax-icon name="download" [size]="13" /> Baixar</button>
      } @else { <div class="empty-state" style="margin-top:40px">Selecione um documento para ver os detalhes.</div> }
    </div>
  </div>`,
  styles: [`.tree-item { padding:7px 12px; display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600; color:#172B3A; } .tree-item:hover { background:#F4F7FA; } .tree-item.sel { background:#E3EFF9; color:#0875D1; }`],
})
export class DocumentosPage implements OnInit, OnDestroy {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); private san = inject(DomSanitizer);
  readonly E = ENTITY; size = fmtSize;
  readonly list = new ListState<any>((q) => this.api.get('/documents', q));
  readonly folder = signal(''); readonly extraFolders = signal<string[]>([]); q = ''; newFolder = '';
  readonly sel = signal<any>(null); readonly img = signal<string | null>(null); readonly pdf = signal<SafeResourceUrl | null>(null); readonly text = signal<string | null>(null);
  private url: string | null = null;
  readonly folders = computed(() => { const got: any[] = this.list.extra()?.folders ?? []; const names = new Set(got.map((f) => f.folder));
    return [...got, ...[...DEFAULT_FOLDERS, ...this.extraFolders()].filter((f) => !names.has(f)).map((f) => ({ folder: f, n: 0 }))].sort((a, b) => a.folder.localeCompare(b.folder)); });
  readonly totalAll = computed(() => (this.list.extra()?.folders ?? []).reduce((s: number, f: any) => s + f.n, 0));
  ngOnInit() { this.list.load(); }
  ngOnDestroy() { if (this.url) URL.revokeObjectURL(this.url); }
  ext(d: any) { return (d.name.split('.').pop() || d.mime).toUpperCase().slice(0, 5); }
  pick(f: string) { this.folder.set(f); this.apply(); }
  addFolder() { const f = this.newFolder.trim().slice(0, 80); if (f) { this.extraFolders.update((l) => [...l, f]); this.folder.set(f); this.newFolder = ''; this.apply(); } }
  apply() { this.list.query = { folder: this.folder() || undefined, q: this.q || undefined }; this.list.load(1); }
  async select(d: any) {
    this.sel.set(d); this.img.set(null); this.pdf.set(null); this.text.set(null); if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    if (d.size > 8_000_000) return;
    try {
      const b = await this.api.blob(`/documents/${d.id}/download`);
      if (d.mime.startsWith('image/')) { this.url = URL.createObjectURL(b); this.img.set(this.url); }
      else if (d.mime === 'application/pdf') { this.url = URL.createObjectURL(new Blob([b], { type: 'application/pdf' })); this.pdf.set(this.san.bypassSecurityTrustResourceUrl(this.url)); }
      else if (/^text\/|xml/.test(d.mime)) this.text.set((await b.text()).slice(0, 4000));
    } catch { /* sem pré-visualização */ }
  }
  dl(d: any) { this.api.download(`/documents/${d.id}/download`, undefined, d.name); }
  async upload(ev: Event) {
    const files = Array.from((ev.target as HTMLInputElement).files || []); (ev.target as HTMLInputElement).value = '';
    let ok = 0;
    for (const f of files) {
      if (f.size > 15_000_000) { this.toast.error(`${f.name}: maior que 15 MB.`); continue; }
      try { await this.api.raw('/documents', f, f.type || 'application/octet-stream', { 'X-File-Name': encodeURIComponent(f.name), 'X-Folder': encodeURIComponent(this.folder() || 'Geral') }); ok++; } catch (e: any) { this.toast.error(`${f.name}: ${e.message}`); }
    }
    if (ok) { this.toast.success(`${ok} arquivo(s) enviado(s).`); this.list.reload(); }
  }
  async remove(d: any) { if (!confirm(`Excluir "${d.name}"?`)) return; try { await this.api.delete('/documents/' + d.id); if (this.sel()?.id === d.id) this.sel.set(null); this.list.reload(); } catch (e) { this.toast.error(e); } }
}
