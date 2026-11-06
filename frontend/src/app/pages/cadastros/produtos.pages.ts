import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, PagerComponent, StateComponent } from '../../shared/ui';
import { Api, ApiError } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LookupsService } from '../../core/lookups.service';
import { FMT, MOVEMENT_LABEL } from '../../core/format';

// ─── Lista de produtos ──────────────────────────────────────────────────────
@Component({
  selector: 'ax-produtos',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:16px 24px;border-bottom:1px solid #DCE4EC;background:white;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1">
        <h1 style="font-size:16px;font-weight:700;color:#172B3A">Produtos</h1>
        <p style="font-size:12px;color:#647687">{{ list.items().length }} exibidos de {{ list.total() | num }} produto(s)</p>
      </div>
      <div style="position:relative">
        <ax-icon name="search" [size]="14" color="#A0AFBF" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)" />
        <input class="input-field" style="padding-left:32px;font-size:13px;width:260px" placeholder="Nome, referência, SKU ou código de barras" [(ngModel)]="q" (ngModelChange)="search()" />
      </div>
      <button class="btn-ghost" style="font-size:12px" [style.color]="filtersOpen() ? '#0875D1' : null" (click)="filtersOpen.set(!filtersOpen())"><ax-icon name="filter" [size]="13" /> Filtros</button>
      @if (auth.can('produtos.editar')) { <button class="btn-primary" style="font-size:12px" (click)="router.navigateByUrl('/produto-detail')"><ax-icon name="plus" [size]="13" /> Novo produto</button> }
    </div>
    @if (filtersOpen()) {
      <div style="padding:10px 24px;background:white;border-bottom:1px solid #F0F4F8;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <select class="input-field" style="width:170px" [(ngModel)]="flt.brand" (ngModelChange)="apply()"><option value="">Todas as marcas</option>@for (b of lk.data()?.brands ?? []; track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select>
        @if (auth.has('colecoes')) { <select class="input-field" style="width:170px" [(ngModel)]="flt.collection" (ngModelChange)="apply()"><option value="">Todas as coleções</option>@for (b of lk.data()?.collections ?? []; track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select> }
        <select class="input-field" style="width:170px" [(ngModel)]="flt.category" (ngModelChange)="apply()"><option value="">Todas as categorias</option>@for (b of lk.data()?.categories ?? []; track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select>
        <select class="input-field" style="width:140px" [(ngModel)]="flt.active" (ngModelChange)="apply()"><option value="">Ativos e inativos</option><option value="true">Ativos</option><option value="false">Inativos</option></select>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" [(ngModel)]="flt.low" (ngModelChange)="apply()" /> Somente no estoque mínimo</label>
      </div>
    }
    <div style="flex:1;overflow-y:auto">
      <table class="data-table" style="width:100%;border-collapse:collapse;background:white">
        <thead style="position:sticky;top:0"><tr>
          <th>Referência</th><th>Cód. de Barras</th><th>Descrição</th><th>Marca</th>@if (auth.has('colecoes')) { <th>{{ auth.term('colecao') }}</th> }<th>Categoria</th><th class="num">{{ auth.has('grade') ? 'Grade' : 'SKUs' }}</th><th class="num">Estoque</th><th class="num">Preço Venda</th>
          @if (auth.can('produtos.custo')) { <th class="num">Custo</th><th class="num">Markup</th> }<th>Status</th><th>Ações</th>
        </tr></thead>
        <tbody>
          @for (p of list.items(); track p.id) {
            <tr class="clickable" (click)="router.navigateByUrl('/produto-detail/' + p.id)">
              <td class="mono" style="font-size:12px;color:#0875D1;font-weight:500">{{ p.code }}</td>
              <td class="mono" style="font-size:11px;color:#647687">{{ p.barcode || '—' }}</td>
              <td style="font-weight:500;max-width:240px">{{ p.name }}</td>
              <td><span class="badge badge-muted">{{ p.brand || '—' }}</span></td>
              @if (auth.has('colecoes')) { <td style="font-size:12px">{{ p.collection || '—' }}</td> }
              <td style="font-size:12px">{{ p.category || '—' }}</td>
              <td class="num" style="font-size:12px">{{ p.variants }} SKU</td>
              <td class="num" style="font-size:12px;font-weight:600" [style.color]="p.stock <= p.min_stock ? '#C93636' : '#172B3A'">{{ p.stock | num }}</td>
              <td class="num" style="font-size:12px">{{ p.sale_price | brl }}</td>
              @if (auth.can('produtos.custo')) { <td class="num" style="font-size:12px;color:#647687">{{ p.cost_price | brl }}</td><td class="num" style="font-size:12px">{{ p.cost_price > 0 ? ((p.sale_price / p.cost_price) | num:2) : '—' }}</td> }
              <td><span class="badge" [class]="!p.active ? 'badge badge-muted' : p.stock <= p.min_stock ? 'badge badge-warning' : 'badge badge-success'">{{ !p.active ? 'Inativo' : p.stock <= p.min_stock ? 'Abaixo do mínimo' : 'Ativo' }}</span></td>
              <td (click)="$event.stopPropagation()"><div style="display:flex;gap:4px">
                <button class="btn-ghost" style="padding:3px 5px" (click)="router.navigateByUrl('/produto-detail/' + p.id)" title="Abrir"><ax-icon name="eye" [size]="13" /></button>
                <button class="btn-ghost" style="padding:3px 5px" (click)="router.navigate(['/etiquetas'], { queryParams: { produto: p.id } })" title="Etiquetas"><ax-icon name="tag" [size]="13" /></button>
              </div></td>
            </tr>
          }
        </tbody>
      </table>
      <ax-state [loading]="list.loading() && !list.items().length" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum produto encontrado." (retry)="list.reload()" />
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>`,
})
export class ProdutosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); readonly lk = inject(LookupsService);
  readonly list = new ListState<any>((q) => this.api.get('/products', q));
  readonly filtersOpen = signal(false);
  q = ''; flt: any = { brand: '', collection: '', category: '', active: 'true', low: false }; private t: any;
  ngOnInit() { this.lk.ensure(); this.apply(); }
  search() { clearTimeout(this.t); this.t = setTimeout(() => this.apply(), 300); }
  apply() { this.list.query = { q: this.q, ...this.flt, low: this.flt.low ? 'true' : undefined }; this.list.load(1); }
}

// ─── Ficha do produto (com grade tamanho × cor) ─────────────────────────────
const TABS = ['Dados Gerais', 'Grade e SKUs', 'Estoque', 'Tributação', 'Movimentações'];

@Component({
  selector: 'ax-produto-detail',
  imports: [FormsModule, IconComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:16px 24px;background:white;border-bottom:1px solid #DCE4EC">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap">
        <div style="width:52px;height:52px;background:#FFF4E0;border-radius:12px;display:flex;align-items:center;justify-content:center"><ax-icon [name]="auth.me()?.segment?.icon || 'shirt'" [size]="26" color="#D99000" /></div>
        <div style="flex:1;min-width:220px">
          <div style="display:flex;align-items:center;gap:10px">
            <h1 style="font-size:17px;font-weight:700;color:#172B3A">{{ isNew() ? 'Novo produto' : p()?.name }}</h1>
            @if (p()) { <span class="badge" [class]="p().active ? 'badge badge-success' : 'badge badge-muted'">{{ p().active ? 'Ativo' : 'Inativo' }}</span> }
          </div>
          @if (p()) { <p style="font-size:12px;color:#647687">{{ p().code }} · {{ p().variants.length }} SKU(s) · {{ p().brand || 'sem marca' }} · {{ p().category || 'sem categoria' }}@if (auth.has('colecoes')) { · {{ p().collection || 'sem ' + auth.term('colecao').toLowerCase() }} }@if (p().sale_by_weight) { · vendido por kg }</p> }
          @else { <p style="font-size:12px;color:#647687">{{ auth.has('grade') ? 'Defina os dados e escolha ' + auth.term('tamanhos').toLowerCase() + ' e ' + auth.term('cores').toLowerCase() + ': os SKUs e códigos de barras são gerados automaticamente.' : 'Defina os dados do produto: o SKU e o código de barras são gerados automaticamente quando não informados.' }}</p> }
        </div>
        @if (auth.can('produtos.editar')) { <button class="btn-primary" style="font-size:12px" [disabled]="saving()" (click)="save()"><ax-icon name="save" [size]="13" /> Salvar</button> }
        @if (p()) { <button class="btn-ghost" style="font-size:12px" (click)="router.navigate(['/etiquetas'], { queryParams: { produto: p().id } })"><ax-icon name="tag" [size]="13" /> Etiquetas</button> }
        @if (p() && auth.can('precificacao.ver')) { <button class="btn-ghost" style="font-size:12px" (click)="router.navigate(['/precificar-produto'], { queryParams: { productId: p().id } })"><ax-icon name="calculator" [size]="13" /> Precificar</button> }
      </div>
      <div style="display:flex;gap:0;border-bottom:1px solid #DCE4EC;margin-bottom:-1px;overflow-x:auto">
        @for (t of tabs; track t; let i = $index) { @if ((!isNew() || i < 2 || i === 3) && (i !== 1 || auth.has('grade') || !isNew())) { <div class="tab-item" [class.active]="tab() === i" (click)="setTab(i)">{{ i === 1 ? (auth.has('grade') ? auth.term('grade') + ' e SKUs' : (auth.has('embalagens') ? 'Códigos e Embalagens' : 'Códigos (SKU)')) : t }}</div> } }
      </div>
    </div>

    <div style="flex:1;overflow-y:auto;padding:24px">
      <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
      @if (err()) { <div class="state-error" style="margin-top:0">{{ err() }}</div> }
      @if (ready()) {
        @if (tab() === 0) {
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="card" style="padding:20px">
              <div class="section-title">Identificação</div>
              <div class="form-grid">
                <div><label class="field-label">Referência (código) *</label><input class="input-field mono" [class.invalid]="fe()['code']" [(ngModel)]="f.code" />@if (fe()['code']) { <div class="field-error">{{ fe()['code'] }}</div> }</div>
                <div><label class="field-label">Ref. do fornecedor</label><input class="input-field mono" [(ngModel)]="f.supplier_ref" /></div>
                <div class="span-2"><label class="field-label">Descrição *</label><input class="input-field" [class.invalid]="fe()['name']" [(ngModel)]="f.name" />@if (fe()['name']) { <div class="field-error">{{ fe()['name'] }}</div> }</div>
                <div><label class="field-label">Marca</label><select class="input-field" [(ngModel)]="f.brand_id"><option [ngValue]="null">—</option>@for (x of lk.data()?.brands ?? []; track x.id) { <option [ngValue]="x.id">{{ x.name }}</option> }</select></div>
                @if (auth.has('colecoes')) { <div><label class="field-label">{{ auth.term('colecao') }}</label><select class="input-field" [(ngModel)]="f.collection_id"><option [ngValue]="null">—</option>@for (x of lk.data()?.collections ?? []; track x.id) { <option [ngValue]="x.id">{{ x.name }}</option> }</select></div> }
                <div><label class="field-label">Categoria</label><select class="input-field" [(ngModel)]="f.category_id"><option [ngValue]="null">—</option>@for (x of lk.data()?.categories ?? []; track x.id) { <option [ngValue]="x.id">{{ x.name }}</option> }</select></div>
                <div><label class="field-label">Fornecedor</label><select class="input-field" [(ngModel)]="f.supplier_id"><option [ngValue]="null">—</option>@for (x of lk.data()?.suppliers ?? []; track x.id) { <option [ngValue]="x.id">{{ x.name }}</option> }</select></div>
                @if (auth.has('grade')) { <div><label class="field-label">Gênero</label><select class="input-field" [(ngModel)]="f.gender"><option [ngValue]="null">—</option><option>Feminino</option><option>Masculino</option><option>Unissex</option><option>Infantil</option></select></div> }
                <div><label class="field-label">Unidade</label><select class="input-field" [(ngModel)]="f.unit" (ngModelChange)="onUnit()">@for (u of units(); track u) { <option [value]="u">{{ u }}</option> }</select></div>
                <div class="span-2"><label class="field-label">Descrição detalhada (e-commerce)</label><textarea class="input-field" rows="3" [(ngModel)]="f.description"></textarea></div>
              </div>
            </div>
            <div class="card" style="padding:20px">
              <div class="section-title">Preço e Estoque</div>
              <div class="form-grid">
                @if (auth.can('produtos.custo')) { <div><label class="field-label">Preço de custo</label><input type="number" step="0.01" min="0" class="input-field mono" [(ngModel)]="f.cost_price" /></div> }
                <div><label class="field-label">Preço de venda *</label><input type="number" step="0.01" min="0" class="input-field mono" [class.invalid]="fe()['sale_price']" [(ngModel)]="f.sale_price" /></div>
                @if (auth.can('produtos.custo')) {
                  <div><label class="field-label">Markup</label><div class="field-value" style="padding-top:8px">{{ f.cost_price > 0 ? ((f.sale_price / f.cost_price) | num:2) + 'x' : '—' }}</div></div>
                  <div><label class="field-label">Margem bruta</label><div class="field-value" style="padding-top:8px">{{ f.sale_price > 0 ? (((f.sale_price - f.cost_price) / f.sale_price * 100) | num:1) + '%' : '—' }}</div></div>
                }
                <div><label class="field-label">Estoque mínimo (por SKU)</label><input type="number" min="0" class="input-field mono" [(ngModel)]="f.min_stock" /></div>
                <div style="display:flex;flex-direction:column;justify-content:center;gap:8px">
                  <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.track_stock" /> Controla estoque</label>
                  <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.active" /> Ativo</label>
                </div>
              </div>
              @if (auth.has('precos_quantidade') && !isNew()) {
                <div class="section-title" style="margin-top:18px">Preço por quantidade (atacarejo)</div>
                <div style="font-size:11px;color:#647687;margin:-4px 0 8px">O PDV aplica o menor preço da faixa atingida (ex.: a partir de 6 unidades). Preço normal: {{ f.sale_price | brl }}.</div>
                @for (t of tiers; track $index; let k = $index) {
                  <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
                    <span style="font-size:12px;color:#647687">A partir de</span><input type="number" min="2" [step]="f.sale_by_weight ? 0.5 : 1" class="input-field mono" style="width:90px" [(ngModel)]="t.minQty" />
                    <span style="font-size:12px;color:#647687">{{ (f.unit || 'un').toLowerCase() }} · R$</span><input type="number" min="0.01" step="0.01" class="input-field mono" style="width:110px" [(ngModel)]="t.unitPrice" />
                    <span style="font-size:11px;color:#18864B">{{ discPct(t.unitPrice) }}</span>
                    <button class="btn-ghost" (click)="tiers.splice(k, 1)"><ax-icon name="x" [size]="13" /></button>
                  </div>
                }
                @if (auth.can('produtos.editar')) { <div style="display:flex;gap:8px"><button class="btn-ghost" style="font-size:12px" [disabled]="tiers.length >= 10" (click)="tiers.push({ minQty: null, unitPrice: null })"><ax-icon name="plus" [size]="12" /> Faixa</button>
                  <button class="btn-secondary" style="font-size:12px" (click)="saveTiers()">Salvar faixas</button></div> }
              }
              @if (isCosm()) {
                <div class="section-title" style="margin-top:18px">Cosmético / perfume</div>
                <div class="form-grid">
                  <div><label class="field-label">Família olfativa / tipo</label><input class="input-field" [(ngModel)]="attr.familia" placeholder="ex.: Floral, Amadeirado, Base líquida" /></div>
                  <div><label class="field-label">Concentração</label><select class="input-field" [(ngModel)]="attr.concentracao"><option [ngValue]="undefined">—</option>@for (c of concentracoes; track c) { <option [value]="c">{{ c }}</option> }</select></div>
                  <div><label class="field-label">Linha</label><input class="input-field" [(ngModel)]="attr.linha" /></div>
                  <div><label class="field-label">Registro/notificação ANVISA</label><input class="input-field mono" [(ngModel)]="attr.anvisa" /></div>
                  <div class="span-2"><label class="field-label">Indicação / tipo de pele ou cabelo</label><input class="input-field" [(ngModel)]="attr.indicacao" placeholder="ex.: pele oleosa, cabelos cacheados" /></div>
                </div>
              }
              @if (auth.has('peso') || auth.has('validade') || auth.has('maioridade') || isAdega()) {
                <div class="section-title" style="margin-top:18px">{{ isAdega() ? 'Bebida, validade e venda' : 'Venda e validade' }}</div>
                <div class="form-grid">
                  @if (auth.has('peso')) {
                    <div class="span-2"><label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.sale_by_weight" (ngModelChange)="onWeight()" /> Vendido por peso (preço por kg; o PDV pede o peso ou lê a balança)</label></div>
                    <div><label class="field-label">Código de balança (PLU)</label><input class="input-field mono" maxlength="6" [(ngModel)]="f.plu_code" placeholder="ex.: 101" />@if (fe()['plu_code']) { <div class="field-error">{{ fe()['plu_code'] }}</div> }</div>
                    <div style="font-size:11px;color:#647687;align-self:end;padding-bottom:6px">O mesmo código cadastrado na balança: a etiqueta impressa nela é lida direto no PDV.</div>
                  }
                  @if (auth.has('validade')) {
                    <div><label class="field-label">Validade padrão (dias)</label><input type="number" min="0" max="3650" class="input-field mono" [(ngModel)]="f.shelf_life_days" placeholder="—" /></div>
                    <div style="display:flex;align-items:flex-end;padding-bottom:6px"><label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.track_lots" /> Controla lotes e validade</label></div>
                  }
                  @if (auth.has('maioridade')) { <div class="span-2"><label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.age_restricted" /> Venda proibida para menores de 18 anos (o PDV exige confirmação de idade)</label></div> }
                  @if (isAdega()) {
                    <div><label class="field-label">Volume (ml)</label><input type="number" min="0" class="input-field mono" [(ngModel)]="attr.volume_ml" /></div>
                    <div><label class="field-label">Teor alcoólico (%)</label><input type="number" min="0" max="100" step="0.1" class="input-field mono" [(ngModel)]="attr.teor" /></div>
                    <div><label class="field-label">Uva / estilo</label><input class="input-field" [(ngModel)]="attr.uva" placeholder="ex.: Malbec, IPA" /></div>
                    <div><label class="field-label">País / região</label><input class="input-field" [(ngModel)]="attr.origem" placeholder="ex.: Mendoza, Argentina" /></div>
                    <div><label class="field-label">Safra</label><input type="number" min="1900" max="2100" class="input-field mono" [(ngModel)]="attr.safra" placeholder="ex.: 2021" /></div>
                  }
                </div>
              }
              @if (p()) {
                <div style="margin-top:16px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
                  <div class="kpi-card" style="padding:12px"><div style="font-size:11px;color:#647687">Estoque total</div><div style="font-size:18px;font-weight:700">{{ totalStock() | num }}</div></div>
                  <div class="kpi-card" style="padding:12px"><div style="font-size:11px;color:#647687">Vendido 90 dias</div><div style="font-size:18px;font-weight:700">{{ p().sales.qty_90d | num }}</div></div>
                  <div class="kpi-card" style="padding:12px"><div style="font-size:11px;color:#647687">Receita 90 dias</div><div style="font-size:18px;font-weight:700">{{ p().sales.revenue_90d | brl }}</div></div>
                </div>
              }
            </div>
          </div>
        }

        @if (tab() === 1) {
          @if (auth.has('grade') && (isNew() || addingGrid())) {
            <div class="card" style="padding:20px;margin-bottom:16px">
              <div class="section-title">{{ isNew() ? auth.term('grade') + ' (' + auth.term('cores').toLowerCase() + ' × ' + auth.term('tamanhos').toLowerCase() + ')' : 'Adicionar variações' }}</div>
              <div class="form-grid">
                <div><label class="field-label">Grade de {{ auth.term('tamanhos').toLowerCase() }}</label>
                  <select class="input-field" [ngModel]="grid()" (ngModelChange)="grid.set($event); sizeSel.set([])">@for (g of grids(); track g) { <option [value]="g">{{ g }}</option> }</select></div>
                <div></div>
                <div class="span-2"><label class="field-label">{{ auth.term('tamanhos') }}</label>
                  <div style="display:flex;gap:6px;flex-wrap:wrap">@for (s of sizesOfGrid(); track s.id) { <span class="chip" [class.active]="sizeSel().includes(s.id)" (click)="toggleSize(s.id)">{{ s.code }}</span> }
                    <span class="chip" (click)="sizeSel.set(sizesOfGrid().map(s => s.id))">todos</span></div></div>
                <div class="span-2"><label class="field-label">{{ auth.term('cores') }}</label>
                  <div style="display:flex;gap:6px;flex-wrap:wrap">@for (c of lk.data()?.colors ?? []; track c.id) {
                    <span class="chip" [class.active]="colorSel().includes(c.id)" (click)="toggleColor(c.id)"><span [style.background]="c.hex || '#ccc'" style="width:10px;height:10px;border-radius:50%;border:1px solid #DCE4EC;display:inline-block"></span>{{ c.name }}</span> }</div></div>
              </div>
              <div style="margin-top:14px;font-size:12px;color:#647687">Serão criadas <b style="color:#172B3A">{{ previewCount() }}</b> variação(ões). SKU no formato REFERÊNCIA-COR-TAMANHO e código de barras EAN-13 interno (prefixo 2) quando não informado.</div>
              @if (!isNew()) { <div style="display:flex;gap:8px;margin-top:12px"><button class="btn-primary" style="font-size:12px" [disabled]="!previewCount()" (click)="addVariants()">Criar variações</button><button class="btn-ghost" style="font-size:12px" (click)="addingGrid.set(false)">Cancelar</button></div> }
            </div>
          }
          @if (p()) {
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <div style="font-size:13px;font-weight:600">SKUs do produto</div>
              @if (auth.has('grade') && auth.can('produtos.editar') && !addingGrid()) { <button class="btn-secondary" style="font-size:12px" (click)="addingGrid.set(true)"><ax-icon name="plus" [size]="13" /> Adicionar cores/tamanhos</button> }
            </div>
            <div class="card" style="overflow:hidden">
              <table class="data-table" style="width:100%;border-collapse:collapse">
                <thead><tr>@if (auth.has('grade')) { <th>{{ auth.term('cor') }}</th><th>{{ auth.term('tamanho') }}</th> }<th>SKU</th><th>Código de barras</th><th class="num">Preço próprio</th>@if (auth.can('produtos.custo')) { <th class="num">Custo próprio</th> }<th class="num">Mín.</th><th class="num">Estoque</th><th>Ativo</th><th></th></tr></thead>
                <tbody>
                  @for (v of variants(); track v.id) {
                    <tr>
                      @if (auth.has('grade')) { <td><span style="display:inline-flex;align-items:center;gap:6px"><span [style.background]="v.color_hex || '#ccc'" style="width:10px;height:10px;border-radius:50%;border:1px solid #DCE4EC"></span>{{ v.color || '—' }}</span></td>
                      <td><span class="badge badge-muted">{{ v.size || '—' }}</span></td> }
                      <td><input class="input-field mono" style="font-size:12px;padding:4px 8px" [(ngModel)]="v.sku" /></td>
                      <td><input class="input-field mono" style="font-size:12px;padding:4px 8px;width:150px" [(ngModel)]="v.barcode" /></td>
                      <td class="num"><input type="number" step="0.01" class="input-field mono" style="font-size:12px;padding:4px 8px;width:100px;text-align:right" [(ngModel)]="v.sale_price" placeholder="padrão" /></td>
                      @if (auth.can('produtos.custo')) { <td class="num"><input type="number" step="0.01" class="input-field mono" style="font-size:12px;padding:4px 8px;width:100px;text-align:right" [(ngModel)]="v.cost_price" placeholder="padrão" /></td> }
                      <td class="num"><input type="number" class="input-field mono" style="font-size:12px;padding:4px 8px;width:64px;text-align:right" [(ngModel)]="v.min_stock" placeholder="—" /></td>
                      <td class="num" style="font-weight:600">{{ v.stock_total }}</td>
                      <td><input type="checkbox" [(ngModel)]="v.active" /></td>
                      <td>@if (auth.can('produtos.editar')) { <button class="btn-ghost" style="padding:3px 6px;font-size:11px" (click)="saveVariant(v)">Salvar</button> }</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (auth.has('embalagens')) {
              <div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 10px"><div style="font-size:13px;font-weight:600">Embalagens (caixa, fardo...)</div></div>
              <div class="card" style="overflow:hidden">
                <table class="data-table" style="width:100%;border-collapse:collapse">
                  <thead><tr><th>Embalagem</th><th>Unidade base</th><th class="num">Unidades</th><th>Código de barras</th><th class="num">Preço da embalagem</th><th class="num">Preço unit. equivalente</th><th>Ativa</th><th></th></tr></thead>
                  <tbody>
                    @for (k of packs(); track k.id) {
                      <tr><td style="font-weight:500">{{ k.name }}</td><td class="mono" style="font-size:12px">{{ k.sku }}</td><td class="num">{{ k.units }}</td><td class="mono" style="font-size:12px">{{ k.barcode || '—' }}</td>
                        <td class="num">{{ k.sale_price ? (k.sale_price | brl) : 'unidades × preço' }}</td><td class="num">{{ k.sale_price ? (k.sale_price / k.units | brl) : '—' }}</td>
                        <td>{{ k.active ? 'Sim' : 'Não' }}</td><td>@if (auth.can(['combos.editar', 'produtos.editar'])) { <button class="btn-ghost" style="font-size:11px;color:#C93636" (click)="removePack(k)">Remover</button> }</td></tr>
                    } @empty { <tr><td colspan="8" class="empty-state">Nenhuma embalagem. Cadastre a caixa com o código de barras impresso nela para vender a caixa fechada no PDV.</td></tr> }
                  </tbody>
                </table>
                @if (auth.can(['combos.editar', 'produtos.editar'])) {
                  <div style="padding:12px 16px;border-top:1px solid #EEF2F6;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
                    <div><label class="field-label">Nome</label><input class="input-field" style="width:170px" [(ngModel)]="pk.name" placeholder="Caixa com 12" /></div>
                    <div><label class="field-label">Unidade base</label><select class="input-field" style="width:170px" [(ngModel)]="pk.variantId">@for (v of variants(); track v.id) { <option [value]="v.id">{{ v.sku }}</option> }</select></div>
                    <div><label class="field-label">Unidades</label><input type="number" min="2" class="input-field mono" style="width:90px" [(ngModel)]="pk.units" /></div>
                    <div><label class="field-label">Código de barras (EAN)</label><input class="input-field mono" style="width:160px" maxlength="14" [(ngModel)]="pk.barcode" /></div>
                    <div><label class="field-label">Preço da embalagem</label><input type="number" step="0.01" min="0" class="input-field mono" style="width:120px" [(ngModel)]="pk.salePrice" placeholder="opcional" /></div>
                    <button class="btn-primary" style="font-size:12px" [disabled]="!pk.name || !(pk.units >= 2) || !pk.variantId" (click)="addPack()"><ax-icon name="plus" [size]="12" /> Adicionar</button>
                  </div>
                }
              </div>
            }
          }
        }

        @if (tab() === 2 && p()) {
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
            <label class="field-label" style="margin:0">Filial</label>
            <select class="input-field" style="width:220px" [ngModel]="stockBranch()" (ngModelChange)="stockBranch.set($event); loadGrid()"><option value="all">Todas as filiais</option>@for (b of lk.data()?.branches ?? []; track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select>
          </div>
          @if (gridData(); as g) {
            <div class="card" style="overflow:auto;padding:4px">
              <table class="data-table grid-matrix" style="width:100%;border-collapse:collapse">
                <thead><tr><th style="text-align:left">Cor \\ Tamanho</th>@for (s of g.sizes; track s) { <th>{{ s }}</th> }<th>Total</th></tr></thead>
                <tbody>@for (c of g.colors; track c) {
                  <tr><td style="text-align:left;font-weight:500">{{ c }}</td>
                    @for (s of g.sizes; track s) { <td class="mono" [style.color]="cell(g, c, s) === null ? '#DCE4EC' : cell(g, c, s)! <= 0 ? '#C93636' : '#172B3A'" [style.font-weight]="600">{{ cell(g, c, s) ?? '·' }}</td> }
                    <td class="mono" style="font-weight:700">{{ rowTotal(g, c) }}</td></tr>
                }</tbody>
              </table>
            </div>
            <p style="font-size:11px;color:#647687;margin-top:8px">Saldos em tempo real. Vermelho = sem estoque. Para movimentar, use Estoque › Movimentações, Transferências ou Inventário.</p>
          }
        }

        @if (tab() === 3) {
          <div class="card" style="padding:20px;max-width:760px">
            <div class="section-title">Dados fiscais (validados antes da emissão de NF-e/NFC-e)</div>
            <div class="form-grid">
              <div><label class="field-label">NCM (8 dígitos)</label><input class="input-field mono" maxlength="8" [class.invalid]="fe()['ncm']" [(ngModel)]="f.ncm" />@if (fe()['ncm']) { <div class="field-error">{{ fe()['ncm'] }}</div> }</div>
              <div><label class="field-label">CEST (7 dígitos, se aplicável)</label><input class="input-field mono" maxlength="7" [(ngModel)]="f.cest" /></div>
              <div><label class="field-label">Origem da mercadoria</label><select class="input-field" [(ngModel)]="f.origin">@for (o of origins; track o[0]) { <option [ngValue]="o[0]">{{ o[0] }} — {{ o[1] }}</option> }</select></div>
              <div><label class="field-label">CFOP de venda</label><input class="input-field mono" maxlength="4" [(ngModel)]="f.cfop" /></div>
              <div><label class="field-label">CST / CSOSN (ICMS)</label><input class="input-field mono" maxlength="3" [(ngModel)]="f.cst_csosn" /></div>
              <div><label class="field-label">Peso (kg)</label><input type="number" step="0.001" class="input-field mono" [(ngModel)]="f.weight_kg" /></div>
            </div>
            <div class="state-info" style="margin-top:14px"><ax-icon name="info" [size]="14" />Confirme a classificação fiscal com seu contador. O AXIONYX valida formato e coerência com o regime tributário, mas não substitui a orientação contábil.</div>
          </div>
        }

        @if (tab() === 4 && p()) {
          <div class="card" style="overflow:hidden">
            <table class="data-table" style="width:100%;border-collapse:collapse">
              <thead><tr><th>Data</th><th>Filial</th><th>SKU</th><th>Tipo</th><th class="num">Qtd.</th><th class="num">Saldo após</th><th>Observação</th><th>Usuário</th></tr></thead>
              <tbody>@for (m of movements(); track m.id) {
                <tr><td class="mono" style="font-size:12px">{{ m.created_at | dtt }}</td><td style="font-size:12px">{{ m.branch }}</td><td class="mono" style="font-size:12px">{{ m.sku }}</td><td>{{ mlabel(m.type) }}</td>
                  <td class="num" [style.color]="m.qty > 0 ? '#18864B' : '#C93636'">{{ m.qty > 0 ? '+' : '' }}{{ m.qty }}</td><td class="num">{{ m.balance_after }}</td><td style="font-size:12px;color:#647687">{{ m.notes }}</td><td style="font-size:12px">{{ m.user_name }}</td></tr>
              } @empty { <tr><td colspan="8" class="empty-state">Sem movimentações.</td></tr> }</tbody>
            </table>
          </div>
        }
      }
    </div>
  </div>`,
})
export class ProdutoDetailPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly lk = inject(LookupsService);
  readonly id = input<string>();
  readonly tabs = TABS;
  readonly origins: [number, string][] = [[0, 'Nacional'], [1, 'Estrangeira — importação direta'], [2, 'Estrangeira — mercado interno'], [3, 'Nacional, conteúdo importado > 40%'], [4, 'Nacional, processos produtivos básicos'], [5, 'Nacional, conteúdo importado ≤ 40%'], [6, 'Estrangeira direta, sem similar (CAMEX)'], [7, 'Estrangeira mercado interno, sem similar'], [8, 'Nacional, conteúdo importado > 70%']];
  readonly tab = signal(0); readonly p = signal<any>(null); readonly variants = signal<any[]>([]); readonly movements = signal<any[]>([]);
  readonly loading = signal(false); readonly error = signal<string | null>(null); readonly ready = signal(false);
  readonly saving = signal(false); readonly err = signal(''); readonly fe = signal<Record<string, string>>({});
  readonly grid = signal('Adulto'); readonly sizeSel = signal<string[]>([]); readonly colorSel = signal<string[]>([]); readonly addingGrid = signal(false);
  readonly stockBranch = signal('all'); readonly gridData = signal<any>(null);
  readonly grids = computed(() => [...new Set((this.lk.data()?.sizes ?? []).map((s: any) => s.grid))] as string[]);
  readonly sizesOfGrid = computed(() => (this.lk.data()?.sizes ?? []).filter((s: any) => s.grid === this.grid()));
  readonly previewCount = computed(() => Math.max(1, this.sizeSel().length) * Math.max(1, this.colorSel().length) * (this.sizeSel().length || this.colorSel().length ? 1 : 0));
  readonly totalStock = computed(() => this.variants().reduce((s, v) => s + (v.stock_total || 0), 0));
  f: any = { unit: 'UN', origin: 0, cfop: '5102', cst_csosn: '102', min_stock: 1, track_stock: true, active: true, cost_price: 0, sale_price: 0, brand_id: null, collection_id: null, category_id: null, supplier_id: null, gender: null };
  attr: any = {}; pk: any = { name: '', units: 12, variantId: '', barcode: '', salePrice: null };
  readonly packs = signal<any[]>([]);
  readonly units = computed(() => { const u = this.auth.me()?.segment?.units ?? ['UN']; return this.f?.unit && !u.includes(this.f.unit) ? [...u, this.f.unit] : u; });
  isAdega() { return this.auth.me()?.segment?.id === 'adega'; }
  discPct(u: number | null) { return this.f.sale_price > 0 && (u || 0) > 0 ? '-' + (Math.round((1 - (u as number) / this.f.sale_price) * 1000) / 10).toLocaleString('pt-BR') + '%' : ''; }
  isCosm() { return this.auth.me()?.segment?.id === 'cosmeticos'; }
  readonly concentracoes = ['Parfum / Extrait', 'Eau de Parfum (EDP)', 'Eau de Toilette (EDT)', 'Eau de Cologne (EDC)', 'Body splash', 'Óleo perfumado'];
  tiers: { minQty: number | null; unitPrice: number | null }[] = [];
  async loadTiers() { if (!this.id() || !this.auth.has('precos_quantidade')) return; try { this.tiers = (await this.api.get<any[]>(`/products/${this.id()}/price-tiers`)).map((t) => ({ minQty: Number(t.min_qty), unitPrice: Number(t.unit_price) })); this.p.update((x) => ({ ...x })); } catch { /* */ } }
  async saveTiers() {
    const tiers = this.tiers.filter((t) => t.minQty && t.unitPrice).map((t) => ({ minQty: Number(t.minQty), unitPrice: Number(t.unitPrice) }));
    try { const r = await this.api.put<any[]>(`/products/${this.id()}/price-tiers`, { tiers }); this.tiers = r.map((t) => ({ minQty: Number(t.min_qty), unitPrice: Number(t.unit_price) })); this.toast.success('Preços por quantidade salvos.'); this.p.update((x) => ({ ...x })); }
    catch (e) { this.toast.error(e); }
  }
  isNew() { return !this.id(); }
  async ngOnInit() {
    await this.lk.ensure();
    if (this.isNew()) {
      const seg = this.auth.me()?.segment;
      this.f.unit = seg?.defaultUnit || 'UN'; this.f.sale_by_weight = this.auth.has('peso') && this.f.unit === 'KG'; this.f.age_restricted = this.auth.has('maioridade') && seg?.id === 'adega'; this.f.track_lots = this.auth.has('validade');
      if (this.f.sale_by_weight) this.f.min_stock = 0;
      this.ready.set(true); this.tab.set(0);
    } else this.load();
  }
  onUnit() { if (this.auth.has('peso')) this.f.sale_by_weight = this.f.unit === 'KG'; }
  onWeight() { if (this.f.sale_by_weight) this.f.unit = 'KG'; else if (this.f.unit === 'KG') this.f.unit = 'UN'; }
  setTab(i: number) { this.tab.set(i); if (i === 1 && this.auth.has('embalagens')) this.loadPacks(); if (i === 2) this.loadGrid(); if (i === 4) this.loadMov(); }
  async loadPacks() { if (!this.id()) return; try { this.packs.set(await this.api.get<any[]>(`/products/${this.id()}/packagings`)); if (!this.pk.variantId) this.pk.variantId = this.variants()[0]?.id ?? ''; } catch (e) { this.toast.error(e); } }
  async addPack() {
    try { await this.api.post(`/products/${this.id()}/packagings`, { variantId: this.pk.variantId, name: this.pk.name, units: +this.pk.units, barcode: this.pk.barcode || undefined, salePrice: this.pk.salePrice ? +this.pk.salePrice : undefined });
      this.toast.success('Embalagem cadastrada.'); this.pk = { name: '', units: 12, variantId: this.pk.variantId, barcode: '', salePrice: null }; this.loadPacks(); }
    catch (e) { this.toast.error(e); }
  }
  async removePack(k: any) { if (!confirm(`Remover a embalagem "${k.name}"?`)) return; try { const r: any = await this.api.delete('/packagings/' + k.id); this.toast.success(r.inactivated ? 'Embalagem já usada em vendas: foi inativada.' : 'Embalagem removida.'); this.loadPacks(); } catch (e) { this.toast.error(e); } }
  mlabel(t: string) { return MOVEMENT_LABEL[t] || t; }
  toggleSize(id: string) { this.sizeSel.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])); }
  toggleColor(id: string) { this.colorSel.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])); }
  cell(g: any, c: string, s: string): number | null { const x = g.cells.find((k: any) => (k.color ?? '—') === c && (k.size ?? '—') === s); return x ? x.qty : null; }
  rowTotal(g: any, c: string) { return g.cells.filter((k: any) => (k.color ?? '—') === c).reduce((a: number, k: any) => a + k.qty, 0); }
  async load() {
    this.loading.set(true); this.error.set(null);
    try {
      const p = await this.api.get<any>('/products/' + this.id());
      this.p.set(p); this.variants.set(p.variants.map((v: any) => ({ ...v })));
      this.f = { ...p }; this.attr = { ...(p.attributes || {}) };
      this.ready.set(true); this.loadTiers();
    } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); }
  }
  async loadGrid() { try { this.gridData.set(await this.api.get('/stock/grid/' + this.id(), { branch: this.stockBranch() })); } catch (e) { this.toast.error(e); } }
  async loadMov() { try { this.movements.set((await this.api.get<any>('/stock/movements', { product: this.id(), branch: 'all', size: 100 })).items); } catch (e) { this.toast.error(e); } }
  private body() {
    const keys = ['code', 'name', 'short_name', 'description', 'brand_id', 'collection_id', 'category_id', 'supplier_id', 'supplier_ref', 'gender', 'unit', 'ncm', 'cest', 'origin', 'cfop', 'cst_csosn', 'sale_price', 'min_stock', 'track_stock', 'weight_kg', 'active',
      'sale_by_weight', 'plu_code', 'shelf_life_days', 'age_restricted', 'track_lots'];
    if (this.auth.can('produtos.custo')) keys.push('cost_price');
    const b: any = {};
    for (const k of keys) { const v = this.f[k]; if (v !== undefined && v !== '' && v !== null) b[k] = ['sale_price', 'cost_price', 'min_stock', 'origin', 'weight_kg'].includes(k) ? Number(v) : v; else if (!this.isNew() && k in this.f) b[k] = null; }
    for (const k of ['code', 'name']) if (b[k] === null) delete b[k];
    if (b.shelf_life_days !== undefined && b.shelf_life_days !== null) b.shelf_life_days = Number(b.shelf_life_days);
    if (b.plu_code !== undefined && b.plu_code !== null) b.plu_code = String(b.plu_code).trim() || null;
    for (const k of ['sale_by_weight', 'age_restricted', 'track_lots']) if (b[k] === null) b[k] = false;
    const attrs: any = {}; for (const [k, v] of Object.entries(this.attr || {})) if (v !== null && v !== undefined && v !== '') attrs[k] = typeof v === 'string' ? v.trim() : v;
    if (this.isAdega() || this.isCosm() || Object.keys(attrs).length) b.attributes = attrs;
    return b;
  }
  async save() {
    this.saving.set(true); this.err.set(''); this.fe.set({});
    try {
      if (this.isNew()) {
        if (this.auth.has('grade') && !this.sizeSel().length && !this.colorSel().length && !confirm('Nenhum tamanho/cor selecionado. Criar produto com SKU único?')) { this.saving.set(false); this.tab.set(1); return; }
        const r = await this.api.post<any>('/products', { ...this.body(), grid: { sizeIds: this.sizeSel(), colorIds: this.colorSel() } });
        this.toast.success(`Produto criado com ${r.variants.length} SKU(s).`); this.router.navigateByUrl('/produto-detail/' + r.id);
      } else { await this.api.put('/products/' + this.id(), this.body()); this.toast.success('Produto atualizado.'); this.load(); }
    } catch (e: any) { this.err.set(e.message); if (e instanceof ApiError) this.fe.set(e.fieldErrors); } finally { this.saving.set(false); }
  }
  async addVariants() {
    try { const r = await this.api.post<any[]>(`/products/${this.id()}/variants`, { grid: { sizeIds: this.sizeSel(), colorIds: this.colorSel() } }); this.toast.success(`${r.length} variação(ões) criada(s).`); this.addingGrid.set(false); this.sizeSel.set([]); this.colorSel.set([]); this.load(); }
    catch (e) { this.toast.error(e); }
  }
  async saveVariant(v: any) {
    const b: any = { sku: v.sku, active: v.active, sale_price: v.sale_price === '' || v.sale_price === null ? null : Number(v.sale_price), min_stock: v.min_stock === '' || v.min_stock === null ? null : Number(v.min_stock) };
    if (v.barcode) b.barcode = v.barcode;
    if (this.auth.can('produtos.custo')) b.cost_price = v.cost_price === '' || v.cost_price === null ? null : Number(v.cost_price);
    try { await this.api.put('/variants/' + v.id, b); this.toast.success(`SKU ${v.sku} salvo.`); } catch (e) { this.toast.error(e); }
  }
}
