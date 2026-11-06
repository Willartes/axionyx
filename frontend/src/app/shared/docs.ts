import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { IconComponent } from './icon.component';
import { Api } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { DateTimePipe } from '../core/format';

export const fmtSize = (n: number) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

/** Upload e listagem de documentos vinculados a um registro (colaborador, processo, cliente...). */
@Component({
  selector: 'ax-entity-docs',
  imports: [IconComponent, DateTimePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="card" style="overflow:hidden">
    <div style="padding:12px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #F0F4F8"><div style="flex:1;font-size:12px;font-weight:700;color:#172B3A">Documentos ({{ items().length }})</div>
      @if (auth.can('documentos.editar')) { <label class="btn-secondary" style="font-size:12px;cursor:pointer"><ax-icon name="upload" [size]="12" /> Anexar<input type="file" style="display:none" (change)="upload($event)" /></label> }</div>
    @for (d of items(); track d.id) {
      <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid #F0F4F8;font-size:12px">
        <ax-icon name="file-text" [size]="15" color="#0875D1" /><div style="flex:1"><div style="font-weight:500">{{ d.name }}</div><div class="muted" style="font-size:11px">{{ size(d.size) }} · {{ d.created_at | dtt }} · {{ d.uploaded_by_name }}</div></div>
        <button class="btn-ghost" style="padding:3px 6px" (click)="api.download('/documents/' + d.id + '/download', undefined, d.name)" aria-label="Baixar"><ax-icon name="download" [size]="13" /></button>
        @if (auth.can('documentos.editar')) { <button class="btn-ghost" style="padding:3px 6px;color:#C93636" (click)="remove(d)" aria-label="Excluir"><ax-icon name="trash-2" [size]="13" /></button> }
      </div>
    } @empty { <div class="empty-state" style="padding:20px">Nenhum documento anexado.</div> }
  </div>`,
})
export class EntityDocsComponent implements OnInit {
  readonly api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly entity = input.required<string>(); readonly entityId = input.required<string>(); readonly folder = input('Geral');
  readonly items = signal<any[]>([]);
  size = fmtSize;
  ngOnInit() { this.load(); }
  async load() { try { const r: any = await this.api.get('/documents', { entity: this.entity(), entityId: this.entityId(), size: 100 }); this.items.set(r.items); } catch { this.items.set([]); } }
  async upload(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0]; (ev.target as HTMLInputElement).value = ''; if (!f) return;
    if (f.size > 15_000_000) { this.toast.error('Arquivo maior que 15 MB.'); return; }
    try { await this.api.raw('/documents', f, f.type || 'application/octet-stream', { 'X-File-Name': encodeURIComponent(f.name), 'X-Folder': encodeURIComponent(this.folder()), 'X-Entity': this.entity(), 'X-Entity-Id': this.entityId() }); this.toast.success('Documento anexado.'); this.load(); }
    catch (e) { this.toast.error(e); }
  }
  async remove(d: any) { if (!confirm(`Excluir "${d.name}"?`)) return; try { await this.api.delete('/documents/' + d.id); this.load(); } catch (e) { this.toast.error(e); } }
}
