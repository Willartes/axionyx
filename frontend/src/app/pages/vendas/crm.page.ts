import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { CustomerPickerComponent, ModalComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, brl } from '../../core/format';

const COLS: [string, string, number][] = [['Prospecção', '#647687', 20], ['Qualificação', '#2878C7', 40], ['Proposta', '#D99000', 60], ['Negociação', '#D99000', 75], ['Fechamento', '#18864B', 90], ['Perdido', '#C93636', 0]];

@Component({
  selector: 'ax-crm',
  imports: [FormsModule, IconComponent, ModalComponent, StateComponent, CustomerPickerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:16px 24px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;gap:12px">
      <div style="flex:1"><h1 style="font-size:16px;font-weight:700;color:#172B3A">CRM — Pipeline de Oportunidades</h1>
        <p style="font-size:12px;color:#647687">{{ open().length }} oportunidade(s) abertas · {{ total() | brl }} em pipeline · previsão ponderada {{ weighted() | brl }}</p></div>
      <select class="input-field" style="width:170px;font-size:12px" [ngModel]="ownerSig()" (ngModelChange)="ownerSig.set($event)"><option value="">Todos os responsáveis</option>@for (s of lk.data()?.sellers ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select>
      @if (auth.can('crm.editar')) { <button class="btn-primary" style="font-size:12px" (click)="edit(null, 'Prospecção')"><ax-icon name="plus" [size]="13" /> Nova oportunidade</button> }
    </div>
    <ax-state [loading]="loading()" />
    <div style="flex:1;overflow-x:auto;overflow-y:hidden;padding:20px">
      <div style="display:flex;gap:12px;height:100%;min-width:max-content">
        @for (col of cols; track col[0]) {
          <div style="width:230px;display:flex;flex-direction:column;gap:10px" (dragover)="$event.preventDefault()" (drop)="drop(col[0])">
            <div style="background:white;border:1px solid #DCE4EC;border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px">
              <div [style.background]="col[1]" style="width:8px;height:8px;border-radius:50%;flex-shrink:0"></div><span style="font-size:12px;font-weight:600;color:#172B3A;flex:1">{{ col[0] }}</span>
              <span style="font-size:11px;color:#647687">{{ byCol(col[0]).length }} · {{ sumCol(col[0]) }}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:60px">
              @for (item of byCol(col[0]); track item.id) {
                <div class="card" style="padding:12px;cursor:pointer" [attr.draggable]="auth.can('crm.editar')" (dragstart)="dragging = item" (click)="edit(item)" (mouseenter)="$any($event.currentTarget).style.boxShadow='0 3px 10px rgba(0,0,0,0.08)'" (mouseleave)="$any($event.currentTarget).style.boxShadow='none'">
                  <div style="font-size:12px;font-weight:600;color:#172B3A;margin-bottom:2px">{{ item.title }}</div>
                  <div style="font-size:11px;color:#647687;margin-bottom:8px">{{ item.customer || item.contact || '—' }}</div>
                  <div style="font-size:14px;font-weight:700;color:#0875D1;margin-bottom:8px">{{ item.value | brl }}</div>
                  <div style="display:flex;align-items:center;justify-content:space-between">
                    <div style="display:flex;align-items:center;gap:4px"><div style="height:3px;width:60px;background:#EEF2F6;border-radius:2px"><div [style.width.%]="item.probability" [style.background]="col[1]" style="height:100%;border-radius:2px"></div></div><span style="font-size:10px;color:#647687">{{ item.probability }}%</span></div>
                    <div style="width:20px;height:20px;border-radius:50%;background:#E3EFF9;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#0875D1" [title]="item.owner || ''">{{ ini(item.owner) }}</div>
                  </div>
                </div>
              }
              @if (auth.can('crm.editar')) { <button style="background:transparent;border:1.5px dashed #DCE4EC;border-radius:8px;padding:8px 12px;font-size:12px;color:#A0AFBF;cursor:pointer;text-align:center" (click)="edit(null, col[0])">+ Adicionar</button> }
            </div>
          </div>
        }
      </div>
    </div>
  </div>
  <ax-modal [(open)]="formOpen" [title]="f.id ? 'Oportunidade' : 'Nova oportunidade'" icon="user-check" [width]="560">
    <div class="form-grid-2">
      <div class="span-all"><label class="field-label">Título *</label><input class="input-field" [(ngModel)]="f.title" placeholder="Ex.: Uniformes equipe loja parceira" /></div>
      <div class="span-all"><label class="field-label">Cliente</label><ax-customer-picker [(value)]="cust" /></div>
      <div><label class="field-label">Contato</label><input class="input-field" [(ngModel)]="f.contact" /></div>
      <div><label class="field-label">Valor estimado</label><input type="number" min="0" step="0.01" class="input-field mono" [(ngModel)]="f.value" /></div>
      <div><label class="field-label">Etapa</label><select class="input-field" [(ngModel)]="f.stage" (ngModelChange)="stageProb()">@for (c of cols; track c[0]) { <option [value]="c[0]">{{ c[0] }}</option> }</select></div>
      <div><label class="field-label">Probabilidade (%)</label><input type="number" min="0" max="100" class="input-field mono" [(ngModel)]="f.probability" /></div>
      <div class="span-all"><label class="field-label">Responsável</label><select class="input-field" [(ngModel)]="f.owner_id"><option [ngValue]="null">—</option>@for (s of lk.data()?.sellers ?? []; track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }</select></div>
      <div class="span-all"><label class="field-label">Anotações</label><textarea class="input-field" rows="3" [(ngModel)]="f.notes"></textarea></div>
    </div>
    <div footer>@if (f.id && auth.can('crm.editar')) { <button class="btn-ghost" style="color:#C93636;margin-right:auto" (click)="remove()">Excluir</button> }
      <button class="btn-secondary" (click)="formOpen.set(false)">Cancelar</button>@if (auth.can('crm.editar')) { <button class="btn-primary" [disabled]="(f.title || '').trim().length < 2" (click)="save()">Salvar</button> }</div>
  </ax-modal>`,
})
export class CrmPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly cols = COLS; readonly items = signal<any[]>([]); readonly loading = signal(true); readonly formOpen = signal(false); readonly cust = signal<any>(null);
  f: any = {}; dragging: any = null; readonly ownerSig = signal('');
  readonly filtered = computed(() => { const o = this.ownerSig(); return this.items().filter((i) => !o || i.owner_id === o); });
  readonly open = computed(() => this.filtered().filter((i) => !['Fechamento', 'Perdido'].includes(i.stage)));
  readonly total = computed(() => this.open().reduce((s, i) => s + Number(i.value || 0), 0));
  readonly weighted = computed(() => this.open().reduce((s, i) => s + Number(i.value || 0) * (i.probability || 0) / 100, 0));
  ngOnInit() { this.lk.ensure(); this.load(); }
  async load() { this.loading.set(true); try { const r: any = await this.api.get('/opportunities', { size: 500 }); this.items.set(r.items); } finally { this.loading.set(false); } }
  byCol(c: string) { return this.filtered().filter((i) => (i.stage || 'Prospecção') === c); }
  sumCol(c: string) { const v = this.byCol(c).reduce((s, i) => s + Number(i.value || 0), 0); return v >= 1000 ? `R$ ${(v / 1000).toFixed(0)}k` : brl(v); }
  ini(n: string | null) { return (n || '?').split(' ').filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase(); }
  edit(item: any, stage = 'Prospecção') {
    this.f = item ? { ...item } : { title: '', contact: '', value: null, stage, probability: COLS.find((c) => c[0] === stage)?.[2] ?? 20, owner_id: this.auth.me()?.user?.id ?? null, notes: '' };
    this.cust.set(item?.customer_id ? { id: item.customer_id, name: item.customer } : null); this.formOpen.set(true);
  }
  stageProb() { this.f.probability = COLS.find((c) => c[0] === this.f.stage)?.[2] ?? this.f.probability; }
  async save() {
    const f = this.f; const body = { title: f.title.trim(), customer_id: this.cust()?.id || undefined, contact: f.contact || undefined, value: f.value !== null && f.value !== '' ? +f.value : undefined, probability: Math.max(0, Math.min(100, Math.round(+f.probability || 0))), stage: f.stage, owner_id: f.owner_id || undefined, notes: f.notes || undefined };
    try { if (f.id) await this.api.put('/opportunities/' + f.id, body); else await this.api.post('/opportunities', body); this.formOpen.set(false); this.toast.success('Oportunidade salva.'); this.load(); } catch (e) { this.toast.error(e); }
  }
  async drop(stage: string) {
    const it = this.dragging; this.dragging = null; if (!it || it.stage === stage) return;
    const probability = COLS.find((c) => c[0] === stage)![2];
    this.items.update((l) => l.map((x) => (x.id === it.id ? { ...x, stage, probability } : x)));
    try { await this.api.put('/opportunities/' + it.id, { stage, probability }); } catch (e) { this.toast.error(e); this.load(); }
  }
  async remove() { if (!confirm('Excluir esta oportunidade?')) return; try { await this.api.delete('/opportunities/' + this.f.id); this.formOpen.set(false); this.load(); } catch (e) { this.toast.error(e); } }
}
