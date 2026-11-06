import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ListState, ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

const KIND: Record<string, [string, string]> = { credito: ['Crédito', 'badge-success'], resgate: ['Resgate', 'badge-info'], expiracao: ['Expiração', 'badge-muted'], ajuste: ['Ajuste', 'badge-warning'], estorno_credito: ['Estorno de crédito', 'badge-danger'], estorno_resgate: ['Estorno de resgate', 'badge-warning'] };

@Component({
  selector: 'ax-fidelidade',
  imports: [FormsModule, IconComponent, PagerComponent, StateComponent, ModalComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="page-header"><div style="flex:1"><h1>Fidelidade e Cashback</h1><p>Cashback gerado nas vendas concluídas, com validade e limite de resgate; saldos são passivo da loja</p></div>
      @if (auth.can('fidelidade.editar')) { <button class="btn-secondary" style="font-size:12px" (click)="expire()"><ax-icon name="hourglass" [size]="13" /> Processar expirações</button> }
      @if (auth.can('config.editar')) { <button class="btn-primary" style="font-size:12px" (click)="openRules()"><ax-icon name="settings" [size]="13" /> Regras do programa</button> }
    </div>
    <div style="flex:1;overflow-y:auto;padding:20px">
      <ax-state [loading]="!o()" />
      @if (o(); as o) {
        @if (!o.settings.ativo) { <div class="state-warning" style="margin:0 0 14px"><ax-icon name="alert-triangle" [size]="14" />Programa de cashback desativado: novas vendas não geram crédito.</div> }
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px">
          @for (k of [['Saldo a resgatar (passivo)', o.totals.liability, '#0875D1'], ['Gerado no mês', o.totals.earned_month, '#18864B'], ['Resgatado no mês', o.totals.redeemed_month, '#2878C7'], ['Expirado no mês', o.totals.expired_month, '#647687'], ['Expira em 15 dias', o.totals.expiring_15d, '#D99000']]; track k[0]) {
            <div class="kpi-card"><div style="font-size:11px;font-weight:600;color:#647687;text-transform:uppercase">{{ k[0] }}</div><div [style.color]="k[2]" style="font-size:20px;font-weight:700">{{ k[1] | brl }}</div></div>
          }
        </div>
        <div class="card" style="padding:12px 16px;margin-bottom:16px;font-size:12px;color:#647687;display:flex;gap:18px;flex-wrap:wrap">
          <span><b style="color:#172B3A">{{ o.settings.cashbackPct }}%</b> de cashback</span><span>compra mínima <b style="color:#172B3A">{{ o.settings.compraMinima | brl }}</b></span>
          <span>validade <b style="color:#172B3A">{{ o.settings.validadeDias }} dias</b></span><span>resgate até <b style="color:#172B3A">{{ o.settings.resgateMaxPct }}%</b> da compra</span>
          <span>{{ o.settings.acumularNoCrediario ? 'acumula' : 'não acumula' }} em vendas no crediário</span><span>{{ o.totals.customers_with_balance }} cliente(s) com saldo</span>
        </div>
      }
      <div class="card" style="overflow:hidden">
        <div style="padding:10px 14px;border-bottom:1px solid #F0F4F8"><input class="input-field" style="width:280px" placeholder="Buscar cliente por nome ou CPF" [(ngModel)]="q" (keyup.enter)="search()" /></div>
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Cód.</th><th>Cliente</th><th class="num">Total gerado</th><th class="num">Total resgatado</th><th>Próx. expiração</th><th class="num">Saldo disponível</th><th></th></tr></thead>
          <tbody>@for (c of list.items(); track c.id) {
            <tr class="clickable" (click)="open(c)"><td class="mono" style="font-size:12px">{{ c.code }}</td><td style="font-weight:500">{{ c.name }}</td><td class="num">{{ c.total_earned | brl }}</td><td class="num">{{ c.total_redeemed | brl }}</td>
              <td class="mono" style="font-size:12px">{{ c.next_expiry | dt }}</td><td class="num" style="font-weight:700;color:#0875D1">{{ c.balance | brl }}</td><td><ax-icon name="chevron-right" [size]="13" color="#A0AFBF" /></td></tr>
          }</tbody>
        </table>
        <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum cliente com movimentação de cashback." emptyIcon="gift" />
      </div>
    </div>
    <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
  </div>
  <ax-modal [(open)]="detailOpen" [title]="'Extrato de cashback — ' + (d()?.customer?.name ?? '')" icon="gift" [width]="680">
    @if (d(); as d) {
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><div>Saldo disponível: <b style="font-size:18px;color:#0875D1">{{ d.balance | brl }}</b></div>
        <button class="btn-ghost" style="font-size:12px" (click)="router.navigateByUrl('/cliente-detail/' + d.customer.id)">Abrir cliente</button></div>
      <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Validade</th><th class="num">Valor</th><th class="num">Restante</th></tr></thead>
        <tbody>@for (l of d.ledger; track l.id) { <tr><td class="mono" style="font-size:11px">{{ l.created_at | dtt }}</td><td><span class="badge" [class]="'badge ' + (KIND[l.kind]?.[1] ?? 'badge-muted')">{{ KIND[l.kind]?.[0] ?? l.kind }}</span></td>
          <td style="font-size:12px">{{ l.notes || l.description || '—' }} @if (l.user_name) { <span class="muted">· {{ l.user_name }}</span> }</td><td class="mono" style="font-size:11px">{{ l.expires_at | dt }}</td>
          <td class="num" [style.color]="l.amount >= 0 ? '#18864B' : '#C93636'">{{ l.amount | brl }}</td><td class="num">{{ l.remaining > 0 ? (l.remaining | brl) : '—' }}</td></tr> }</tbody></table>
      @if (auth.can('fidelidade.editar')) {
        <div class="section-title" style="margin:14px 0 8px">Ajuste manual (auditado)</div>
        <div style="display:flex;gap:8px"><input type="number" step="0.01" class="input-field mono" style="width:130px" placeholder="+/− valor" [(ngModel)]="adj.amount" /><input class="input-field" style="flex:1" placeholder="Motivo (mín. 5 caracteres)" [(ngModel)]="adj.notes" />
          <button class="btn-primary" [disabled]="!adj.amount || (adj.notes || '').trim().length < 5" (click)="adjust()">Lançar</button></div>
      }
    }
  </ax-modal>
  <ax-modal [(open)]="rulesOpen" title="Regras do programa de cashback" icon="settings" [width]="520">
    <div class="form-grid-2">
      <label class="span-all" style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="r.ativo" /> Programa ativo</label>
      <div><label class="field-label">Cashback (% da venda)</label><input type="number" min="0" max="50" step="0.5" class="input-field mono" [(ngModel)]="r.cashbackPct" /></div>
      <div><label class="field-label">Compra mínima (R$)</label><input type="number" min="0" step="1" class="input-field mono" [(ngModel)]="r.compraMinima" /></div>
      <div><label class="field-label">Validade (dias)</label><input type="number" min="1" max="730" class="input-field mono" [(ngModel)]="r.validadeDias" /></div>
      <div><label class="field-label">Resgate máximo (% da compra)</label><input type="number" min="1" max="100" class="input-field mono" [(ngModel)]="r.resgateMaxPct" /></div>
      <div><label class="field-label">Saldo mínimo p/ resgate (R$)</label><input type="number" min="0" step="0.5" class="input-field mono" [(ngModel)]="r.saldoMinimoResgate" /></div>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="r.acumularNoCrediario" /> Acumular em vendas no crediário</label>
    </div>
    <p style="font-size:11px;color:#647687;margin-top:8px">As regras valem para vendas futuras. Créditos já gerados mantêm a validade original.</p>
    <div footer><button class="btn-secondary" (click)="rulesOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveRules()">Salvar regras</button></div>
  </ax-modal>`,
})
export class FidelidadePage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly KIND = KIND;
  readonly o = signal<any>(null); readonly d = signal<any>(null); readonly detailOpen = signal(false); readonly rulesOpen = signal(false);
  readonly list = new ListState<any>((q) => this.api.get('/loyalty/customers', q));
  q = ''; adj: any = {}; r: any = {};
  ngOnInit() { this.loadO(); this.list.load(); }
  async loadO() { try { this.o.set(await this.api.get('/loyalty/overview')); } catch (e) { this.toast.error(e); } }
  search() { this.list.query = { q: this.q || undefined }; this.list.load(1); }
  async open(c: any) { this.adj = { amount: null, notes: '' }; try { this.d.set(await this.api.get('/loyalty/customers/' + c.id)); this.detailOpen.set(true); } catch (e) { this.toast.error(e); } }
  async adjust() { try { await this.api.post(`/loyalty/customers/${this.d().customer.id}/adjust`, { amount: +this.adj.amount, notes: this.adj.notes.trim() }); this.toast.success('Ajuste lançado.'); this.open(this.d().customer); this.list.reload(); this.loadO(); } catch (e) { this.toast.error(e); } }
  async expire() { try { const r: any = await this.api.post('/loyalty/expire'); this.toast.success(`${r.expired} crédito(s) vencido(s) expirado(s).`); this.loadO(); this.list.reload(); } catch (e) { this.toast.error(e); } }
  openRules() { this.r = { ...this.o()?.settings }; this.rulesOpen.set(true); }
  async saveRules() {
    const r = this.r; try { await this.api.put('/settings', { fidelidade: { ativo: !!r.ativo, cashbackPct: +r.cashbackPct, compraMinima: +r.compraMinima, validadeDias: +r.validadeDias, resgateMaxPct: +r.resgateMaxPct, saldoMinimoResgate: +r.saldoMinimoResgate, acumularNoCrediario: !!r.acumularNoCrediario } });
      this.toast.success('Regras salvas.'); this.rulesOpen.set(false); this.loadO(); } catch (e) { this.toast.error(e); }
  }
}
