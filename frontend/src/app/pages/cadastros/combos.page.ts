import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, PagerComponent, StateComponent, VariantPickerComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, todayIso } from '../../core/format';

/** Combos e kits: preço fechado; no PDV cada item do combo baixa o próprio estoque com o preço rateado. */
@Component({
  selector: 'ax-combos',
  imports: [FormsModule, IconComponent, ModalComponent, PagerComponent, StateComponent, VariantPickerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Combos e Kits</h1>
        <p style="font-size:13px;color:#647687">Monte kits com preço promocional (ex.: vinho + taça, cesta de frutas, kit churrasco). No PDV o combo é lido pelo código e cada item baixa o próprio estoque.</p></div>
      @if (auth.can('combos.editar')) { <button class="btn-primary" style="font-size:12px" (click)="edit(null)"><ax-icon name="plus" [size]="13" /> Novo combo</button> }
    </div>
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;display:flex;gap:8px;border-bottom:1px solid #EEF2F6"><input class="input-field" style="max-width:280px" placeholder="Buscar combo…" [(ngModel)]="q" (keyup.enter)="search()" /><button class="btn-secondary" (click)="search()"><ax-icon name="search" [size]="13" /> Buscar</button></div>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum combo cadastrado." (retry)="list.reload()" />
      @if (list.items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Combo</th><th>Itens</th><th class="num">Preço normal</th><th class="num">Preço do combo</th><th class="num">Desconto</th><th>Validade</th><th class="num">Vendas</th><th>Situação</th><th></th></tr></thead>
          <tbody>@for (c of list.items(); track c.id) {
            <tr [style.opacity]="c.active ? 1 : 0.55"><td><div style="font-weight:600">{{ c.name }}</div><div class="mono" style="font-size:11px;color:#647687">{{ c.code }}{{ c.barcode ? ' · ' + c.barcode : '' }}</div></td>
              <td style="font-size:12px">@for (i of c.items ?? []; track i.variantId) { <div>{{ i.qty | num:(i.qty % 1 ? 3 : 0) }}× {{ i.name }}</div> }</td>
              <td class="num" style="color:#647687;text-decoration:line-through">{{ c.regular_price | brl }}</td><td class="num" style="font-weight:700">{{ c.price | brl }}</td>
              <td class="num" [style.color]="c.regular_price > c.price ? '#18864B' : '#C93636'">{{ c.regular_price > 0 ? ((1 - c.price / c.regular_price) * 100 | pct) : '—' }}</td>
              <td style="font-size:12px">{{ c.valid_until ? (c.valid_until | dt) : 'sem prazo' }}</td><td class="num">{{ c.sold }}</td>
              <td><span class="badge" [class.badge-success]="c.active" [class.badge-muted]="!c.active">{{ c.active ? 'Ativo' : 'Inativo' }}</span></td>
              <td style="white-space:nowrap">@if (auth.can('combos.editar')) { <button class="btn-ghost" title="Editar" (click)="edit(c)"><ax-icon name="pencil" [size]="13" /></button>
                @if (c.active) { <button class="btn-ghost" title="Inativar" style="color:#C93636" (click)="remove(c)"><ax-icon name="pause" [size]="13" /></button> } }</td></tr>
          }</tbody></table></div>
        <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
      }
    </div>
  </div>

  <ax-modal [open]="!!f" (closed)="f = null" [title]="f?.id ? 'Editar combo' : 'Novo combo'" icon="package-plus" [width]="680">
    @if (f) {
      <div class="form-grid-3">
        <div><label class="field-label">Código *</label><input class="input-field mono" maxlength="30" [(ngModel)]="f.code" placeholder="KIT-01" /></div>
        <div class="span-2"><label class="field-label">Nome *</label><input class="input-field" maxlength="120" [(ngModel)]="f.name" placeholder="Ex.: Vinho tinto + taça" /></div>
        <div><label class="field-label">Código de barras (opcional)</label><input class="input-field mono" maxlength="14" [(ngModel)]="f.barcode" /></div>
        <div><label class="field-label">Preço do combo *</label><input type="number" min="0.01" step="0.01" class="input-field mono" [(ngModel)]="f.price" /></div>
        <div><label class="field-label">Válido até</label><input type="date" class="input-field" [min]="today" [(ngModel)]="f.validUntil" /></div>
      </div>
      <div class="section-title" style="margin:14px 0 8px">Itens do combo</div>
      <ax-variant-picker placeholder="Adicione produtos pelo nome, SKU ou código de barras" (selected)="addItem($event)" />
      <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:8px">
        <thead><tr><th>Produto</th><th class="num">Preço unit.</th><th class="num" style="width:110px">Qtd.</th><th class="num">Subtotal</th><th></th></tr></thead>
        <tbody>@for (i of f.items; track i.variantId; let k = $index) {
          <tr><td><div style="font-weight:500">{{ i.name }}</div><div class="mono" style="font-size:11px;color:#647687">{{ i.sku }}</div></td><td class="num">{{ i.price | brl }}</td>
            <td class="num"><input type="number" min="0.001" step="1" class="input-field mono" style="width:90px;text-align:right;padding:4px 6px" [(ngModel)]="i.qty" /></td>
            <td class="num">{{ i.price * i.qty | brl }}</td><td><button class="btn-ghost" (click)="f.items.splice(k, 1)"><ax-icon name="x" [size]="13" /></button></td></tr>
        } @empty { <tr><td colspan="5" class="empty-state">Adicione pelo menos um produto.</td></tr> }</tbody>
      </table>
      <div style="display:flex;justify-content:flex-end;gap:18px;margin-top:10px;font-size:13px">
        <span>Preço normal: <b>{{ regular() | brl }}</b></span>
        <span>Combo: <b>{{ +f.price || 0 | brl }}</b></span>
        <span [style.color]="regular() > (+f.price || 0) ? '#18864B' : '#C93636'">Desconto: <b>{{ regular() > 0 ? ((1 - (+f.price || 0) / regular()) * 100 | pct) : '—' }}</b></span>
      </div>
      @if ((+f.price || 0) > regular() && regular() > 0) { <div class="state-warning" style="margin:10px 0 0;font-size:12px"><ax-icon name="alert-triangle" [size]="13" /><span>O preço do combo está acima da soma dos preços normais.</span></div> }
    }
    <div footer><button class="btn-secondary" (click)="f = null">Cancelar</button><button class="btn-primary" [disabled]="busy() || !f?.code || !f?.name || !(f?.price > 0) || !f?.items?.length" (click)="save()">Salvar combo</button></div>
  </ax-modal>`,
})
export class CombosPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly list = new ListState((q) => this.api.get('/combos', { ...q, size: 50 }));
  readonly busy = signal(false); readonly today = todayIso();
  readonly tick = signal(0);
  q = ''; f: any = null;
  regular() { return (this.f?.items ?? []).reduce((s: number, i: any) => s + Number(i.price) * (Number(i.qty) || 0), 0); }
  ngOnInit() { this.list.load(1); }
  search() { this.list.query = { q: this.q || undefined }; this.list.load(1); }
  edit(c: any) {
    this.f = c ? { id: c.id, code: c.code, name: c.name, barcode: c.barcode || '', price: c.price, validUntil: c.valid_until || '', active: c.active, items: (c.items ?? []).map((i: any) => ({ ...i })) }
      : { code: '', name: '', barcode: '', price: null, validUntil: '', items: [] };
    this.tick.update((x) => x + 1);
  }
  addItem(v: any) {
    if (v.kind) { this.toast.info('Selecione um produto (não uma embalagem ou outro combo).'); return; }
    const ex = this.f.items.find((i: any) => i.variantId === v.id);
    if (ex) ex.qty = Number(ex.qty) + 1; else this.f.items.push({ variantId: v.id, sku: v.sku, name: v.name, price: Number(v.price), qty: 1 });
    this.tick.update((x) => x + 1);
  }
  async save() {
    this.busy.set(true);
    const body = { code: this.f.code.trim(), name: this.f.name.trim(), barcode: this.f.barcode || undefined, price: +this.f.price, validUntil: this.f.validUntil || undefined, active: this.f.active ?? true,
      items: this.f.items.map((i: any) => ({ variantId: i.variantId, qty: +i.qty })) };
    try { if (this.f.id) await this.api.put('/combos/' + this.f.id, body); else await this.api.post('/combos', body); this.toast.success('Combo salvo.'); this.f = null; this.list.reload(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async remove(c: any) { if (!confirm(`Inativar o combo "${c.name}"?`)) return; try { await this.api.delete('/combos/' + c.id); this.list.reload(); } catch (e) { this.toast.error(e); } }
}
