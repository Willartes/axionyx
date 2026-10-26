import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { LogoComponent } from '../../shared/logo.component';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';
import { CHARGE_STATUS, CONTRACT_STATUS, METHOD_LABEL, MODE_LABEL } from './saas-shared';

/** Portal do cliente: situação da assinatura, pagamento pendente (link do Mercado Pago) e histórico. */
@Component({
  selector: 'ax-minha-assinatura',
  imports: [IconComponent, LogoComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .hero { border-radius:14px; padding:22px; color:#fff; background:linear-gradient(135deg,#0B1F33 0%,#0B3A5E 60%,#0875D1 140%); display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
    .hero h2 { font-size:19px; font-weight:700; margin:0 0 4px; }
    .hero p { margin:0; color:#C9D8E6; font-size:13.5px; line-height:1.5; }
    .pay { margin-top:14px; display:flex; gap:10px; flex-wrap:wrap; }
    .pay a, .pay button { display:inline-flex; align-items:center; gap:8px; }
    .big { font-size:28px; font-weight:800; letter-spacing:-.01em; }
  `],
  template: `
  <div style="padding:24px;max-width:980px">
    <h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Minha assinatura</h1>
    <p style="font-size:13px;color:#647687;margin-bottom:16px">Plano, pagamentos e situação de acesso da {{ auth.me()?.company?.trade_name || auth.me()?.company?.name }}</p>
    @if (data(); as d) {
      @if (!d.hasContract) {
        <div class="card empty-state" style="padding:28px">Esta empresa não possui assinatura vinculada.</div>
      } @else {
        <div class="hero">
          <ax-logo [size]="46" />
          <div style="flex:1;min-width:240px">
            @switch (d.status) {
              @case ('aguardando_pagamento') { <h2>Falta só o pagamento para liberar o AXIONYX</h2><p>Sua proposta foi aprovada. Assim que o pagamento for confirmado, o acesso é liberado automaticamente{{ d.billingMode === 'manual' ? '' : ' — em poucos minutos no Pix' }}.</p> }
              @case ('inadimplente') { <h2>Mensalidade vencida</h2><p>O sistema continua liberado até {{ d.suspendOn | dt }}. Depois dessa data fica somente para consulta até a regularização.</p> }
              @case ('suspenso') { <h2>Acesso somente para consulta</h2><p>A assinatura foi suspensa por falta de pagamento. Seus dados estão preservados; ao pagar, o acesso completo volta automaticamente.</p> }
              @case ('cancelado') { <h2>Assinatura cancelada</h2><p>Os dados continuam disponíveis para consulta e exportação. Fale com a equipe AXIONYX para reativar.</p> }
              @default { <h2>Assinatura ativa</h2><p>Tudo certo. Vigência paga até {{ d.paidUntil | dt }}.</p> }
            }
            @if (d.pending; as p) {
              <div class="pay">
                @if (p.checkout_url) {
                  <a class="btn-primary" style="background:#00A6D6;border-color:#00A6D6" [href]="p.checkout_url" target="_blank" rel="noopener"><ax-icon name="credit-card" [size]="15" /> Pagar {{ p.amount | brl }} {{ d.billingMode === 'assinatura_cartao' ? 'no cartão' : 'com Pix ou cartão' }}</a>
                } @else if (d.gatewayConfigured && d.billingMode === 'link_mensal') {
                  <button class="btn-primary" (click)="link(p.id)" [disabled]="busy()"><ax-icon name="credit-card" [size]="15" /> Gerar link de pagamento</button>
                } @else {
                  <span style="font-size:13px;color:#C9D8E6"><ax-icon name="info" [size]="13" /> A equipe AXIONYX enviará as instruções de pagamento de {{ p.amount | brl }}.</span>
                }
                <button class="btn-secondary" style="background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.25)" (click)="refresh()" [disabled]="busy()"><ax-icon name="refresh-cw" [size]="14" /> Já paguei — atualizar</button>
              </div>
            }
          </div>
        </div>

        <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0">
          <div class="kpi-card"><div class="kpi-l">Situação</div><div style="margin-top:4px"><span class="badge" [class]="'badge ' + st(d.status).cls">{{ st(d.status).label }}</span></div></div>
          <div class="kpi-card"><div class="kpi-l">Plano</div><div class="kpi-v" style="font-size:17px">{{ d.plan || 'Personalizado' }}</div></div>
          <div class="kpi-card"><div class="kpi-l">Mensalidade</div><div class="kpi-v">{{ d.price | brl }}</div></div>
          <div class="kpi-card"><div class="kpi-l">Pago até</div><div class="kpi-v" style="font-size:18px">{{ d.paidUntil ? (d.paidUntil | dt) : '—' }}</div></div>
        </div>
        <div class="card" style="padding:12px 16px;margin-bottom:14px;font-size:12.5px;color:#4A5B6B;display:flex;gap:8px;align-items:flex-start">
          <ax-icon name="shield-check" [size]="15" color="#18864B" />
          <span>Forma de cobrança: <b>{{ mode(d.billingMode) }}</b>. {{ d.billingMode === 'manual' ? 'O pagamento é combinado diretamente com a equipe AXIONYX.' : 'Os pagamentos são processados pelo Mercado Pago — o AXIONYX não recebe nem guarda dados do seu cartão.' }} Tolerância após o vencimento: {{ d.graceDays }} dia(s).</span>
        </div>
        <div class="card" style="overflow:hidden">
          <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Histórico de cobranças</div>
          <table class="data-table" style="width:100%;border-collapse:collapse">
            <thead><tr><th>Referência</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th><th>Pagamento</th><th></th></tr></thead>
            <tbody>@for (c of d.charges; track c.id) {
              <tr><td>{{ c.kind === 'avulsa' ? 'Cobrança avulsa' : (c.period_start | dt) + ' a ' + (c.period_end | dt) }}</td><td class="mono">{{ c.due_date | dt }}</td><td class="num">{{ c.amount | brl }}</td>
                <td><span class="badge" [class]="'badge ' + cs(c.status).cls">{{ cs(c.status).label }}</span></td>
                <td style="font-size:12px">{{ c.paid_at ? (c.paid_at | dt) + ' · ' + method(c.method) : '—' }}</td>
                <td>@if (c.checkout_url) { <a class="btn-ghost" style="font-size:12px" [href]="c.checkout_url" target="_blank" rel="noopener">Pagar</a> }</td></tr>
            } @empty { <tr><td colspan="6"><div class="empty-state">Nenhuma cobrança ainda.</div></td></tr> }</tbody>
          </table>
        </div>
      }
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:90px"></div></div> }
  </div>`,
})
export class MinhaAssinaturaPage implements OnInit, OnDestroy {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); private router = inject(Router);
  readonly data = signal<any>(null); readonly busy = signal(false);
  private timer: any;
  readonly st = (s: string) => CONTRACT_STATUS[s] ?? { label: s, cls: 'badge-muted' };
  readonly cs = (s: string) => CHARGE_STATUS[s] ?? { label: s, cls: 'badge-muted' };
  readonly mode = (m: string) => MODE_LABEL[m] ?? m;
  readonly method = (m: string) => METHOD_LABEL[m] ?? m ?? '—';
  readonly waiting = computed(() => this.data()?.status === 'aguardando_pagamento');
  ngOnInit() {
    this.load();
    // aguardando o primeiro pagamento: verifica sozinho a cada 15 s enquanto a aba está aberta
    this.timer = setInterval(() => { if (document.visibilityState === 'visible' && this.waiting()) this.refresh(true); }, 15000);
  }
  ngOnDestroy() { clearInterval(this.timer); }
  async load() { try { this.data.set(await this.api.get('/billing/me')); } catch (e) { this.toast.error(e); } }
  async refresh(silent = false) {
    this.busy.set(true);
    try {
      const before = this.data()?.status;
      await this.load(); await this.auth.loadMe();
      const now = this.data()?.status;
      if (before !== now && now === 'ativo') { this.toast.success('Pagamento confirmado! Acesso liberado.'); this.router.navigateByUrl('/dashboard'); }
      else if (!silent) this.toast.info(now === 'ativo' ? 'Assinatura em dia.' : 'Ainda não recebemos a confirmação. No Pix costuma levar poucos minutos.');
    } finally { this.busy.set(false); }
  }
  async link(id: string) {
    this.busy.set(true);
    try { const r = await this.api.post<any>(`/billing/me/charges/${id}/checkout`, {}); window.open(r.checkoutUrl, '_blank', 'noopener'); await this.load(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
}
