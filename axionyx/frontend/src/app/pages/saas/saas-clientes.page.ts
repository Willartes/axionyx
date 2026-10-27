import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { ModalComponent, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AuthService } from '../../core/auth.service';
import { FMT, brl } from '../../core/format';
import { CHARGE_STATUS, CONTRACT_STATUS, METHOD_LABEL, MODE_LABEL, MODE_SHORT, REVIEW_KIND, RISK, SEGMENT_LABEL, SEVERITY, copyText } from './saas-shared';

const digits = (s: string) => (s || '').replace(/\D/g, '');
const SEGMENTS = Object.entries(SEGMENT_LABEL);
type Reason = { title: string; label: string; confirm: string; danger?: boolean; run: (reason: string) => Promise<any> };

/** Carteira de clientes do AXIONYX: propostas (auditoria antes do pagamento), contratos, cobranças e linha do tempo. */
@Component({
  selector: 'ax-saas-clientes',
  imports: [FormsModule, IconComponent, ModalComponent, StateComponent, PagerComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
    .sec { font-size:11px; font-weight:700; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin:16px 0 8px; }
    .kv { display:flex; justify-content:space-between; gap:12px; font-size:12.5px; padding:5px 0; border-bottom:1px dashed #EEF2F6; }
    .kv span:first-child { color:#647687; } .kv span:last-child { text-align:right; font-weight:500; min-width:0; overflow-wrap:anywhere; }
    .flags { display:flex; flex-wrap:wrap; gap:6px; }
    .flag { font-size:11.5px; padding:3px 9px; border-radius:999px; background:#F1F4F7; color:#4A5B6B; }
    .flag.w1 { background:#FFF7E6; color:#8A5B00; } .flag.w2, .flag.w3 { background:#FDECEC; color:#A12A2A; }
    .acts { display:flex; gap:6px; flex-wrap:wrap; padding:12px; background:#F7F9FB; border-radius:10px; margin:12px 0 4px; }
    .tl { border-left:2px solid #DCE4EC; margin-left:6px; padding-left:14px; }
    .tl div { position:relative; font-size:12.5px; padding:4px 0 8px; }
    .tl div:before { content:''; position:absolute; left:-20px; top:9px; width:10px; height:10px; border-radius:50%; background:#0875D1; border:2px solid #fff; }
    .secret { font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:700; background:#F1F4F7; padding:10px 12px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; gap:8px; word-break:break-all; }
    .cols3 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
    @media (max-width:900px) { .cols3 { grid-template-columns:minmax(0,1fr); gap:0; } }
  `],
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A">Clientes e Contratos</h1>
        <p style="font-size:13px;color:#647687">Proposta → auditoria → aprovação (cria a empresa) → pagamento libera o acesso → renovação automática</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        @if (pc('carteira.propostas')) {
          <button class="btn-secondary" (click)="openLink()"><ax-icon name="building-2" [size]="13" /> Vincular cliente existente</button>
          <button class="btn-primary" (click)="openNew()"><ax-icon name="plus" [size]="13" /> Nova proposta</button>
        }
      </div>
    </div>
    <div class="bar">
      @for (s of statusFilters; track s[0]) { <span class="chip" [class.active]="status() === s[0]" (click)="status.set(s[0]); page.set(1); load()">{{ s[1] }}</span> }
      <div style="flex:1"></div>
      <input class="input-field" style="max-width:280px" placeholder="Buscar nome, CNPJ, responsável…" [(ngModel)]="q" (keyup.enter)="page.set(1); load()" />
    </div>
    <div class="card" style="overflow:hidden">
      <ax-state [loading]="loading()" [empty]="!loading() && !items().length" emptyText="Nenhum contrato. Crie uma proposta ou vincule um cliente existente." emptyIcon="building-2" />
      @if (items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Cliente</th><th>Plano</th><th class="num">Mensal</th><th>Cobrança</th><th>Situação</th><th>Pago até</th><th class="num">Usuários</th><th>Último acesso</th><th class="num">Recebido</th><th></th></tr></thead>
          <tbody>@for (k of items(); track k.id) {
            <tr style="cursor:pointer" (click)="openDetail(k.id)">
              <td><div style="font-weight:600">{{ k.trade_name || k.company_name }}</div><div class="muted" style="font-size:11.5px">#{{ k.number }} · {{ seg(k.segment) }}{{ k.cnpj ? ' · ' + (k.cnpj | doc) : '' }}</div></td>
              <td style="font-size:12.5px">{{ k.plan_name || 'Personalizado' }}</td><td class="num">{{ k.price | brl }}</td><td style="font-size:12px">{{ modeShort(k.billing_mode) }}</td>
              <td><span class="badge" [class]="'badge ' + st(k.status).cls">{{ st(k.status).label }}</span>
                @if (k.open_reviews) { <span class="badge badge-danger" style="margin-left:4px" title="Exceções abertas">{{ k.open_reviews }}</span> }
                @if (k.status === 'em_analise') { <span class="badge" style="margin-left:4px" [style.background]="risk(k.risk_level).bg" [style.color]="risk(k.risk_level).color">{{ risk(k.risk_level).label }}</span> }</td>
              <td class="mono" style="font-size:12px" [style.color]="k.paid_until && k.paid_until < today ? '#C93636' : null">{{ k.paid_until ? (k.paid_until | dt) : '—' }}</td>
              <td class="num">{{ k.company_id ? k.users : '—' }}</td><td style="font-size:12px">{{ k.last_access ? (k.last_access | dtt) : '—' }}</td><td class="num">{{ k.ltv | brl }}</td>
              <td><button class="btn-ghost" style="font-size:12px" (click)="$event.stopPropagation(); openDetail(k.id)">Abrir</button></td></tr>
          }</tbody></table></div>
      }
    </div>
    @if (pages() > 1) { <ax-pager [page]="page()" [pages]="pages()" [total]="total()" (go)="page.set($event); load()" /> }
  </div>

  <!-- ───── Nova proposta ───── -->
  <ax-modal [(open)]="newOpen" title="Nova proposta de assinatura" icon="clipboard-list" [width]="780">
    <p style="font-size:12.5px;color:#647687;margin:-4px 0 12px">A proposta entra <b>em análise</b> com avaliação automática de risco. A empresa e o acesso só são criados na aprovação, e o acesso só é liberado após o pagamento.</p>
    @if (f.leadId) { <div style="font-size:12px;background:#F0F7FD;color:#0B4F8A;padding:8px 10px;border-radius:8px;margin-bottom:10px"><ax-icon name="inbox" [size]="12" /> Dados preenchidos a partir do contato do site.</div> }
    <div class="sec" style="margin-top:0">Empresa</div>
    <div class="form-grid-3">
      <div class="span-2"><label class="field-label">Razão social *</label><input class="input-field" [(ngModel)]="f.companyName" /></div>
      <div><label class="field-label">Nome fantasia</label><input class="input-field" [(ngModel)]="f.tradeName" /></div>
      <div><label class="field-label">CNPJ</label><input class="input-field mono" [(ngModel)]="f.cnpj" placeholder="00.000.000/0000-00" /></div>
      <div><label class="field-label">Segmento *</label><select class="input-field" [(ngModel)]="f.segment">@for (s of segments; track s[0]) { <option [value]="s[0]">{{ s[1] }}</option> }</select></div>
      <div><label class="field-label">Regime tributário</label><select class="input-field" [(ngModel)]="f.taxRegime"><option value="simples">Simples Nacional</option><option value="mei">MEI</option><option value="presumido">Lucro Presumido</option><option value="real">Lucro Real</option></select></div>
      <div><label class="field-label">Cidade</label><input class="input-field" [(ngModel)]="f.cidade" /></div>
      <div><label class="field-label">UF</label><input class="input-field" maxlength="2" [(ngModel)]="f.uf" /></div>
    </div>
    <div class="sec">Responsável (será o administrador da empresa)</div>
    <div class="form-grid-2">
      <div><label class="field-label">Nome *</label><input class="input-field" [(ngModel)]="f.contactName" /></div>
      <div><label class="field-label">E-mail (login) *</label><input class="input-field" type="email" [(ngModel)]="f.contactEmail" /></div>
      <div><label class="field-label">Telefone / WhatsApp</label><input class="input-field" [(ngModel)]="f.contactPhone" /></div>
      <div><label class="field-label">CPF do responsável</label><input class="input-field mono" [(ngModel)]="f.contactDoc" /></div>
    </div>
    <div class="sec">Condições comerciais</div>
    <div class="form-grid-3">
      <div><label class="field-label">Plano</label><select class="input-field" [(ngModel)]="f.planId" (ngModelChange)="planChanged()"><option value="">Personalizado</option>@for (p of plans(); track p.id) { @if (p.active) { <option [value]="p.id">{{ p.name }} — {{ fmt(p.price_monthly) }}</option> } }</select></div>
      <div><label class="field-label">Valor mensal (R$) *</label><input class="input-field" type="number" min="0" step="0.01" [(ngModel)]="f.price" /></div>
      <div><label class="field-label">Tolerância após vencer (dias)</label><input class="input-field" type="number" min="0" max="60" [(ngModel)]="f.graceDays" /></div>
      <div class="span-3"><label class="field-label">Forma de cobrança</label>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px" class="grid-2-resp">
          @for (m of modes; track m[0]) {
            <button type="button" class="card" style="padding:10px;text-align:left;cursor:pointer;font:inherit" [style.border]="f.billingMode === m[0] ? '2px solid #0875D1' : null" (click)="f.billingMode = m[0]"><b style="font-size:12.5px">{{ m[1] }}</b><div class="muted" style="font-size:11.5px">{{ m[2] }}</div></button>
          }
        </div></div>
      <div class="span-3"><label class="field-label">Observações internas</label><textarea class="input-field" rows="2" [(ngModel)]="f.notes"></textarea></div>
    </div>
    <div footer><button class="btn-secondary" (click)="newOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveNew()" [disabled]="busy()">Enviar para auditoria</button></div>
  </ax-modal>

  <!-- ───── Vincular cliente existente ───── -->
  <ax-modal [(open)]="linkOpen" title="Vincular cliente que já usa o sistema" icon="building-2" [width]="640">
    <p style="font-size:12.5px;color:#647687;margin:-4px 0 12px">Para empresas criadas antes da cobrança automática. O contrato entra <b>ativo</b> (sem bloqueio) e a próxima mensalidade é gerada 7 dias antes da data informada.</p>
    <div class="form-grid-2">
      <div class="span-2"><label class="field-label">Empresa *</label><select class="input-field" [(ngModel)]="l.companyId" (ngModelChange)="linkCompany()"><option value="">Selecione…</option>
        @for (c of legacy(); track c.id) { <option [value]="c.id">{{ c.trade_name || c.name }}{{ c.is_demo ? ' (demonstração)' : '' }} — {{ c.users }} usuário(s)</option> }</select></div>
      <div><label class="field-label">Responsável *</label><input class="input-field" [(ngModel)]="l.contactName" /></div>
      <div><label class="field-label">E-mail *</label><input class="input-field" type="email" [(ngModel)]="l.contactEmail" /></div>
      <div><label class="field-label">Plano</label><select class="input-field" [(ngModel)]="l.planId" (ngModelChange)="linkPlan()"><option value="">Personalizado</option>@for (p of plans(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></div>
      <div><label class="field-label">Valor mensal (R$) *</label><input class="input-field" type="number" min="0" step="0.01" [(ngModel)]="l.price" /></div>
      <div><label class="field-label">Pago até (próximo vencimento) *</label><input class="input-field" type="date" [(ngModel)]="l.paidUntil" /></div>
      <div><label class="field-label">Forma de cobrança</label><select class="input-field" [(ngModel)]="l.billingMode">@for (m of modes; track m[0]) { <option [value]="m[0]">{{ m[1] }}</option> }</select></div>
    </div>
    <div footer><button class="btn-secondary" (click)="linkOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveLink()" [disabled]="busy()">Vincular</button></div>
  </ax-modal>

  <!-- ───── Detalhe do contrato ───── -->
  <ax-modal [(open)]="detOpen" [title]="det() ? '#' + det().number + ' · ' + (det().trade_name || det().company_name) : 'Contrato'" icon="building-2" [width]="1000">
    @if (det(); as k) {
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="badge" [class]="'badge ' + st(k.status).cls" style="font-size:12px">{{ st(k.status).label }}</span>
        <span class="badge" [style.background]="risk(k.risk_level).bg" [style.color]="risk(k.risk_level).color">{{ risk(k.risk_level).label }}</span>
        <span class="muted" style="font-size:12px">Criado em {{ k.created_at | dtt }}{{ k.reviewed_at ? ' · auditado em ' + (k.reviewed_at | dtt) : '' }}</span>
      </div>
      <div class="acts">
        @switch (k.status) {
          @case ('em_analise') {
            @if (pc('carteira.aprovar')) {
              <button class="btn-primary" (click)="approveOpen()"><ax-icon name="check-circle-2" [size]="13" /> Aprovar</button>
              <button class="btn-secondary" style="color:#C93636" (click)="ask('reject')"><ax-icon name="x-circle" [size]="13" /> Recusar</button>
            }
            @if (pc('carteira.propostas')) { <button class="btn-secondary" (click)="reRisk()"><ax-icon name="refresh-cw" [size]="13" /> Reavaliar risco</button> }
          }
          @case ('aguardando_pagamento') { @if (pc('carteira.financeiro')) { <button class="btn-secondary" style="color:#C93636" (click)="ask('cancel')">Cancelar contrato</button> } }
          @case ('suspenso') { @if (pc('carteira.financeiro')) { <button class="btn-primary" (click)="ask('reactivate')">Reativar acesso</button><button class="btn-secondary" style="color:#C93636" (click)="ask('cancel')">Cancelar contrato</button> } }
          @case ('cancelado') { @if (pc('carteira.financeiro')) { <button class="btn-secondary" (click)="ask('reactivate')">Reativar</button> } }
          @case ('recusado') { <span class="muted" style="font-size:12.5px">Proposta recusada: {{ k.review_note }}</span> }
          @default {
            @if (pc('carteira.financeiro')) {
              <button class="btn-secondary" (click)="chargeOpen()"><ax-icon name="plus" [size]="13" /> Nova cobrança</button>
              <button class="btn-secondary" (click)="ask('suspend')"><ax-icon name="lock" [size]="13" /> Suspender</button>
              @if (k.status === 'inadimplente') { <button class="btn-secondary" (click)="ask('reactivate')">Dar cortesia (reativar)</button> }
              <button class="btn-secondary" style="color:#C93636" (click)="ask('cancel')">Cancelar contrato</button>
            }
          }
        }
        @if (!['recusado'].includes(k.status) && pc('carteira.propostas')) { <button class="btn-ghost" (click)="editOpen()"><ax-icon name="pencil" [size]="13" /> Editar condições</button> }
        @if (!pc('carteira.propostas') && !pc('carteira.financeiro') && !pc('carteira.aprovar')) { <span class="muted" style="font-size:12.5px"><ax-icon name="eye" [size]="12" /> Seu perfil é somente leitura na carteira.</span> }
      </div>
      @if (k.status === 'em_analise' || k.risk_flags?.length) {
        <div class="sec">Análise de risco automática</div>
        <div class="flags">@for (fl of k.risk_flags; track fl.code) { <span class="flag" [class]="'flag w' + fl.weight">{{ fl.label }}</span> } @empty { <span class="flag">Nenhum alerta</span> }</div>
        @if (k.status === 'em_analise') { <div class="muted" style="font-size:11.5px;margin-top:6px">Confira também: contrato/aceite assinado, documento do responsável e se a demonstração foi feita. A aprovação cria a empresa e o administrador; o acesso só abre com o pagamento.</div> }
      }
      <div class="cols3">
        <div><div class="sec">Cliente</div>
          <div class="kv"><span>Razão social</span><span>{{ k.company_name }}</span></div>
          <div class="kv"><span>CNPJ</span><span class="mono">{{ k.cnpj ? (k.cnpj | doc) : '—' }}</span></div>
          <div class="kv"><span>Segmento</span><span>{{ seg(k.segment) }}</span></div>
          <div class="kv"><span>Responsável</span><span>{{ k.contact_name }}</span></div>
          <div class="kv"><span>E-mail</span><span>{{ k.contact_email }}</span></div>
          <div class="kv"><span>Telefone</span><span>{{ k.contact_phone ? (k.contact_phone | phone) : '—' }}</span></div>
        </div>
        <div><div class="sec">Condições</div>
          <div class="kv"><span>Plano</span><span>{{ k.plan_name || 'Personalizado' }}</span></div>
          <div class="kv"><span>Mensalidade</span><span>{{ k.price | brl }}</span></div>
          <div class="kv"><span>Cobrança</span><span>{{ modeLabel(k.billing_mode) }}</span></div>
          <div class="kv"><span>Tolerância</span><span>{{ k.grace_days }} dia(s)</span></div>
          <div class="kv"><span>Pago até</span><span [style.color]="k.paid_until && k.paid_until < today ? '#C93636' : null">{{ k.paid_until ? (k.paid_until | dt) : '—' }}</span></div>
          @if (k.mp_preapproval_id) { <div class="kv"><span>Assinatura MP</span><span>{{ k.mp_preapproval_status || '—' }}</span></div> }
        </div>
        <div><div class="sec">Uso do sistema</div>
          @if (k.company; as c) {
            <div class="kv"><span>Usuários</span><span>{{ c.users }}</span></div>
            <div class="kv"><span>Filiais</span><span>{{ c.branches }}</span></div>
            <div class="kv"><span>Último acesso</span><span>{{ c.last_access ? (c.last_access | dtt) : 'nunca' }}</span></div>
            <div class="kv"><span>Vendas (30 dias)</span><span>{{ c.sales_30d }}</span></div>
            <div class="kv"><span>Cliente desde</span><span>{{ k.started_at ? (k.started_at | dt) : '—' }}</span></div>
          } @else { <div class="muted" style="font-size:12.5px">A empresa é criada na aprovação.</div> }
        </div>
      </div>
      @if (k.notes) { <div class="sec">Observações</div><div style="font-size:12.5px;white-space:pre-wrap">{{ k.notes }}</div> }

      <div class="sec">Cobranças</div>
      @if (k.charges.length) {
        <div style="overflow-x:auto"><table class="data-table no-cards" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Referência</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th><th>Pagamento</th><th></th></tr></thead>
          <tbody>@for (c of k.charges; track c.id) {
            <tr><td style="font-size:12px">{{ c.kind === 'avulsa' ? 'Avulsa' + (c.manual_note ? ' — ' + c.manual_note : '') : (c.period_start | dt) + ' → ' + (c.period_end | dt) }}</td>
              <td class="mono" style="font-size:12px">{{ c.due_date | dt }}</td><td class="num">{{ c.amount | brl }}</td>
              <td><span class="badge" [class]="'badge ' + cs(c.status).cls">{{ cs(c.status).label }}</span>@if (c.attempts) { <div class="muted" style="font-size:10.5px">{{ c.attempts }} tentativa(s) recusada(s)</div> }</td>
              <td style="font-size:11.5px">@if (c.paid_at) { {{ c.paid_at | dtt }} · {{ method(c.method) }}{{ c.payer_name ? ' · ' + c.payer_name : '' }}@if (c.manual_note && c.kind !== 'avulsa') { <div class="muted">{{ c.manual_note }}</div> } } @else { {{ c.last_status_detail || '—' }} }</td>
              <td style="white-space:nowrap">
                @if (c.status === 'pendente' && pc('carteira.financeiro')) {
                  @if (c.checkout_url) { <button class="btn-ghost" style="font-size:11px" (click)="copy(c.checkout_url)" title="Copiar link de pagamento"><ax-icon name="copy" [size]="12" /> Link</button> }
                  @else if (k.billing_mode === 'link_mensal') { <button class="btn-ghost" style="font-size:11px" (click)="genLink(c)">Gerar link</button> }
                  <button class="btn-ghost" style="font-size:11px" (click)="manualOpen(c)">Baixa manual</button>
                  <button class="btn-ghost" style="font-size:11px;color:#C93636" (click)="ask('cancelCharge', c)">Cancelar</button>
                }
                @if (c.status === 'paga' && pc('carteira.financeiro')) { <button class="btn-ghost" style="font-size:11px;color:#C93636" (click)="ask('refund', c)">Estornar</button> }
              </td></tr>
          }</tbody></table></div>
      } @else { <div class="muted" style="font-size:12.5px">Nenhuma cobrança ainda.</div> }

      <div class="cols3" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">
        <div><div class="sec">Exceções e auditoria</div>
          @for (r of k.reviews; track r.id) {
            <div style="font-size:12.5px;padding:8px 10px;border-radius:8px;margin-bottom:6px" [style.background]="r.status === 'aberta' ? sev(r.severity).bg : '#F7F9FB'">
              <div style="display:flex;gap:6px;align-items:center"><ax-icon [name]="kindOf(r.kind).icon" [size]="13" [color]="sev(r.severity).color" /><b style="flex:1">{{ r.title }}</b><span class="muted" style="font-size:11px">{{ r.created_at | dt }}</span></div>
              @if (r.status === 'resolvida') { <div class="muted" style="font-size:11.5px;margin-top:3px">✓ {{ r.resolution }}{{ r.resolved_by_name ? ' — ' + r.resolved_by_name : '' }}</div> }
              @else if (r.kind !== 'novo_contrato') { <button class="btn-ghost" style="font-size:11px;padding:2px 0" (click)="router.navigate(['/saas-auditoria'])">Resolver na fila →</button> }
            </div>
          } @empty { <div class="muted" style="font-size:12.5px">Sem exceções.</div> }
        </div>
        <div><div class="sec">Linha do tempo</div>
          <div class="tl">@for (e of k.events; track e.id) { <div><b>{{ e.from_status === e.to_status ? 'Alteração' : st(e.to_status).label }}</b> · {{ e.created_at | dtt }}<br><span class="muted">{{ e.reason }}{{ e.user_name ? ' — ' + e.user_name : '' }}</span></div> }</div>
        </div>
      </div>
    }
  </ax-modal>

  <!-- ───── Aprovação ───── -->
  <ax-modal [(open)]="apOpen" title="Aprovar proposta" icon="check-circle-2" [width]="560">
    <p style="font-size:13px;margin-bottom:10px">Ao aprovar, o sistema <b>cria a empresa</b> ({{ seg(det()?.segment) }}), o <b>administrador</b> ({{ det()?.contact_email }}) e a <b>primeira cobrança</b> de {{ fmt(det()?.price) }} com link de pagamento. O acesso fica bloqueado até o pagamento ser confirmado.</p>
    <div class="form-grid-2">
      <div class="span-2"><label class="field-label">Nome da primeira filial</label><input class="input-field" [(ngModel)]="ap.branchName" /></div>
      <div class="span-2"><label class="field-label">Parecer da auditoria</label><textarea class="input-field" rows="3" [(ngModel)]="ap.note" placeholder="Ex.: CNPJ ativo, contrato assinado, demonstração feita em 20/10"></textarea></div>
    </div>
    <div footer><button class="btn-secondary" (click)="apOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="approve()" [disabled]="busy()">Aprovar e gerar cobrança</button></div>
  </ax-modal>
  <ax-modal [(open)]="resOpen" title="Proposta aprovada" icon="check-circle-2" [width]="600" [dismissable]="false">
    @if (res(); as r) {
      <p style="font-size:13px;margin-bottom:10px">Empresa criada. Envie ao cliente os dados abaixo — <b>a senha temporária aparece só agora</b>.</p>
      <label class="field-label">Login</label><div class="secret" style="font-size:13px;margin-bottom:8px"><span>{{ r.adminEmail }}</span></div>
      @if (r.tempPassword) { <label class="field-label">Senha temporária</label><div class="secret" style="margin-bottom:8px"><span>{{ r.tempPassword }}</span><button class="btn-ghost" style="font-size:11px" (click)="copy(r.tempPassword)">Copiar</button></div> }
      @else { <div style="font-size:12.5px;margin-bottom:8px" class="muted">O e-mail já tinha usuário no AXIONYX: ele entra com a senha atual.</div> }
      <label class="field-label">Link de pagamento</label>
      @if (r.checkoutUrl) { <div class="secret" style="font-size:12px;margin-bottom:8px"><span>{{ r.checkoutUrl }}</span><button class="btn-ghost" style="font-size:11px" (click)="copy(r.checkoutUrl)">Copiar</button></div> }
      @else { <div style="font-size:12.5px;color:#8A5B00;background:#FFF7E6;padding:8px 10px;border-radius:8px;margin-bottom:8px">{{ r.gatewayError ? 'Mercado Pago: ' + r.gatewayError : 'Mercado Pago não configurado — o cliente também vê a cobrança em "Minha assinatura". Você pode dar baixa manual se ele pagar por fora.' }}</div> }
      <button class="btn-secondary" style="width:100%;justify-content:center" (click)="copy(welcome(r))"><ax-icon name="copy" [size]="13" /> Copiar mensagem pronta para o cliente</button>
    }
    <div footer><button class="btn-primary" (click)="resOpen.set(false)">Concluir</button></div>
  </ax-modal>

  <!-- ───── Motivo (recusar, suspender, cancelar, estornar…) ───── -->
  <ax-modal [(open)]="reasonOpen" [title]="reason()?.title || ''" icon="alert-triangle" [width]="520">
    <label class="field-label">{{ reason()?.label }} *</label>
    <textarea class="input-field" rows="3" [(ngModel)]="reasonText"></textarea>
    <div class="muted" style="font-size:11.5px;margin-top:6px">Fica registrado na auditoria com seu nome. Nenhum dado do cliente é apagado.</div>
    <div footer><button class="btn-secondary" (click)="reasonOpen.set(false)">Voltar</button><button class="btn-primary" [style.background]="reason()?.danger ? '#C93636' : null" [style.border-color]="reason()?.danger ? '#C93636' : null" (click)="runReason()" [disabled]="busy() || reasonText.trim().length < 3">{{ reason()?.confirm }}</button></div>
  </ax-modal>

  <!-- ───── Baixa manual ───── -->
  <ax-modal [(open)]="mOpen" title="Baixa manual de pagamento" icon="banknote" [width]="520">
    <p style="font-size:12.5px;color:#647687;margin:-4px 0 10px">Use quando o cliente pagou fora do Mercado Pago (ex.: Pix direto na sua conta). Libera o acesso como um pagamento confirmado.</p>
    <div class="form-grid-2">
      <div><label class="field-label">Valor recebido *</label><input class="input-field" type="number" step="0.01" [(ngModel)]="m.amount" /></div>
      <div><label class="field-label">Meio *</label><select class="input-field" [(ngModel)]="m.method"><option value="pix">Pix</option><option value="transferencia">Transferência</option><option value="boleto">Boleto</option><option value="cartao">Cartão</option><option value="dinheiro">Dinheiro</option><option value="outro">Outro</option></select></div>
      <div><label class="field-label">Data do pagamento</label><input class="input-field" type="date" [(ngModel)]="m.paidAt" /></div>
      <div class="span-2"><label class="field-label">Comprovante / observação *</label><input class="input-field" [(ngModel)]="m.note" placeholder="Ex.: Pix E2E 1234… recebido no Itaú" /></div>
    </div>
    <div footer><button class="btn-secondary" (click)="mOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveManual()" [disabled]="busy()">Confirmar baixa</button></div>
  </ax-modal>

  <!-- ───── Nova cobrança ───── -->
  <ax-modal [(open)]="cOpen" title="Nova cobrança" icon="receipt" [width]="520">
    <div class="form-grid-2">
      <div><label class="field-label">Tipo</label><select class="input-field" [(ngModel)]="c.kind"><option value="avulsa">Avulsa (serviço extra)</option><option value="mensalidade">Mensalidade do próximo período</option></select></div>
      <div><label class="field-label">Valor (R$)</label><input class="input-field" type="number" step="0.01" [(ngModel)]="c.amount" [placeholder]="c.kind === 'mensalidade' ? 'valor do contrato' : ''" /></div>
      <div><label class="field-label">Vencimento</label><input class="input-field" type="date" [(ngModel)]="c.dueDate" /></div>
      @if (c.kind === 'avulsa') { <div><label class="field-label">Descrição</label><input class="input-field" [(ngModel)]="c.description" placeholder="Ex.: treinamento" /></div> }
    </div>
    <div footer><button class="btn-secondary" (click)="cOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveCharge()" [disabled]="busy()">Gerar cobrança</button></div>
  </ax-modal>

  <!-- ───── Editar condições ───── -->
  <ax-modal [(open)]="eOpen" title="Editar condições do contrato" icon="pencil" [width]="620">
    <div class="form-grid-2">
      <div><label class="field-label">Plano</label><select class="input-field" [(ngModel)]="e.planId"><option value="">Personalizado</option>@for (p of plans(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></div>
      <div><label class="field-label">Valor mensal (R$)</label><input class="input-field" type="number" step="0.01" [(ngModel)]="e.price" /></div>
      <div><label class="field-label">Forma de cobrança</label><select class="input-field" [(ngModel)]="e.billingMode">@for (mm of modes; track mm[0]) { <option [value]="mm[0]">{{ mm[1] }}</option> }</select></div>
      <div><label class="field-label">Tolerância (dias)</label><input class="input-field" type="number" min="0" max="60" [(ngModel)]="e.graceDays" /></div>
      <div><label class="field-label">Responsável</label><input class="input-field" [(ngModel)]="e.contactName" /></div>
      <div><label class="field-label">E-mail do responsável</label><input class="input-field" [(ngModel)]="e.contactEmail" /></div>
      <div><label class="field-label">Telefone</label><input class="input-field" [(ngModel)]="e.contactPhone" /></div>
      @if (det()?.status === 'ativo' || det()?.status === 'inadimplente' || det()?.status === 'suspenso') { <div><label class="field-label">Pago até (ajuste)</label><input class="input-field" type="date" [(ngModel)]="e.paidUntil" /></div> }
      <div class="span-2"><label class="field-label">Observações internas</label><textarea class="input-field" rows="2" [(ngModel)]="e.notes"></textarea></div>
    </div>
    <div class="muted" style="font-size:11.5px;margin-top:6px">Mudança de valor vale para as próximas cobranças (e atualiza a assinatura no cartão no Mercado Pago).</div>
    <div footer><button class="btn-secondary" (click)="eOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="saveEdit()" [disabled]="busy()">Salvar</button></div>
  </ax-modal>`,
})
export class SaasClientesPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); readonly router = inject(Router); private route = inject(ActivatedRoute); private authSvc = inject(AuthService);
  readonly pc = (p: string) => this.authSvc.pcan(p);
  readonly items = signal<any[]>([]); readonly loading = signal(true); readonly page = signal(1); readonly pages = signal(1); readonly total = signal(0);
  readonly status = signal(''); q = '';
  readonly plans = signal<any[]>([]); readonly legacy = signal<any[]>([]); readonly busy = signal(false);
  readonly today = new Date().toISOString().slice(0, 10);
  readonly segments = SEGMENTS;
  readonly statusFilters = [['', 'Todos'], ['em_analise', 'Em análise'], ['aguardando_pagamento', 'Aguardando pagamento'], ['ativo', 'Ativos'], ['inadimplente', 'Inadimplentes'], ['suspenso', 'Suspensos'], ['cancelado', 'Cancelados'], ['recusado', 'Recusados']];
  readonly modes: [string, string, string][] = [['link_mensal', 'Link mensal', 'Pix ou cartão: link gerado todo mês'], ['assinatura_cartao', 'Cartão recorrente', 'Débito automático mensal no cartão'], ['manual', 'Manual', 'Fora do gateway, com baixa manual']];
  readonly newOpen = signal(false); readonly linkOpen = signal(false); readonly detOpen = signal(false); readonly apOpen = signal(false); readonly resOpen = signal(false);
  readonly reasonOpen = signal(false); readonly mOpen = signal(false); readonly cOpen = signal(false); readonly eOpen = signal(false);
  readonly det = signal<any>(null); readonly res = signal<any>(null); readonly reason = signal<Reason | null>(null);
  f: any = {}; l: any = {}; ap: any = {}; m: any = {}; c: any = {}; e: any = {}; reasonText = ''; private curCharge: any = null;

  readonly st = (s: string) => CONTRACT_STATUS[s] ?? { label: s, cls: 'badge-muted', color: '#647687' };
  readonly cs = (s: string) => CHARGE_STATUS[s] ?? { label: s, cls: 'badge-muted' };
  readonly risk = (r: string) => RISK[r] ?? RISK['baixo'];
  readonly sev = (s: string) => SEVERITY[s] ?? SEVERITY['baixa'];
  readonly kindOf = (k: string) => REVIEW_KIND[k] ?? { label: k, icon: 'info' };
  readonly seg = (s: string) => SEGMENT_LABEL[s] ?? s ?? '—';
  readonly modeShort = (m: string) => MODE_SHORT[m] ?? m;
  readonly modeLabel = (m: string) => MODE_LABEL[m] ?? m;
  readonly method = (m: string) => METHOD_LABEL[m] ?? m ?? '—';
  readonly fmt = (v: any) => brl(v);

  ngOnInit() {
    this.load();
    this.api.get<any[]>('/saas/plans').then((p) => this.plans.set(p), () => {});
    const qp = this.route.snapshot.queryParamMap;
    if (qp.get('id')) this.openDetail(qp.get('id')!);
    if (qp.get('novo')) this.openNew();
    if (qp.get('vincular')) this.openLink();
    if (qp.get('lead')) this.fromLead(qp.get('lead')!);
  }
  async load() {
    this.loading.set(true);
    try { const r = await this.api.get<any>('/saas/contracts', { status: this.status(), q: this.q, page: this.page() }); this.items.set(r.items); this.pages.set(r.pages); this.total.set(r.total); }
    catch (e) { this.toast.error(e); } finally { this.loading.set(false); }
  }
  async copy(t: string) { if (await copyText(t)) this.toast.success('Copiado para a área de transferência.'); else this.toast.info(t); }

  // ── proposta
  openNew() { this.f = { companyName: '', segment: 'geral', taxRegime: 'simples', contactName: '', contactEmail: '', planId: '', price: null, graceDays: 5, billingMode: 'link_mensal' }; this.newOpen.set(true); }
  async fromLead(id: string) {
    try {
      const r = await this.api.get<any>('/admin/leads', { size: 200 });
      const lead = r.items.find((x: any) => x.id === id); if (!lead) return;
      this.openNew();
      const segMap: Record<string, string> = { 'Moda e vestuário': 'moda', Hortifrúti: 'hortifruti', Adega: 'adega', Mercado: 'mercado', Cosméticos: 'cosmeticos', Odontologia: 'odontologia', Estética: 'estetica', 'Salão de beleza': 'salao' };
      Object.assign(this.f, { leadId: lead.id, companyName: lead.company_name || '', tradeName: lead.company_name || '', contactName: lead.name, contactEmail: lead.email || '', contactPhone: lead.phone || '',
        segment: segMap[lead.segment] || (SEGMENT_LABEL[lead.segment] ? lead.segment : 'geral'), notes: lead.message ? 'Mensagem do site: ' + lead.message : '' });
    } catch { /* sem contato */ }
  }
  planChanged() { const p = this.plans().find((x) => x.id === this.f.planId); if (p) this.f.price = Number(p.price_monthly); }
  async saveNew() {
    const f = this.f;
    const body: any = { companyName: f.companyName, tradeName: f.tradeName || undefined, cnpj: digits(f.cnpj) || undefined, segment: f.segment, taxRegime: f.taxRegime, contactName: f.contactName, contactEmail: f.contactEmail,
      contactPhone: digits(f.contactPhone) || undefined, contactDoc: digits(f.contactDoc) || undefined, planId: f.planId || undefined, price: f.price !== null && f.price !== '' ? Number(f.price) : undefined,
      billingMode: f.billingMode, graceDays: Number(f.graceDays ?? 5), notes: f.notes || undefined, leadId: f.leadId || undefined,
      address: f.cidade || f.uf ? { cidade: f.cidade || undefined, uf: (f.uf || '').toUpperCase() || undefined } : undefined };
    this.busy.set(true);
    try { const k = await this.api.post<any>('/saas/contracts', body); this.toast.success(`Proposta enviada para auditoria (${RISK[k.risk_level]?.label.toLowerCase()}).`); this.newOpen.set(false); this.load(); this.openDetail(k.id); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  // ── cliente existente
  async openLink() {
    this.l = { companyId: '', contactName: '', contactEmail: '', planId: '', price: null, paidUntil: '', billingMode: 'link_mensal' }; this.linkOpen.set(true);
    try { this.legacy.set(await this.api.get('/saas/companies-without-contract')); } catch (e) { this.toast.error(e); }
  }
  linkCompany() { const c = this.legacy().find((x) => x.id === this.l.companyId); if (c) { this.l.contactEmail ||= c.email || ''; this.l.companyName = c.name; } }
  linkPlan() { const p = this.plans().find((x) => x.id === this.l.planId); if (p) this.l.price = Number(p.price_monthly); }
  async saveLink() {
    const l = this.l; const co = this.legacy().find((x) => x.id === l.companyId);
    if (!co) { this.toast.error('Selecione a empresa.'); return; }
    this.busy.set(true);
    try {
      const k = await this.api.post<any>('/saas/contracts', { existingCompanyId: co.id, companyName: co.name, contactName: l.contactName, contactEmail: l.contactEmail, planId: l.planId || undefined,
        price: l.price !== null && l.price !== '' ? Number(l.price) : undefined, paidUntil: l.paidUntil || undefined, billingMode: l.billingMode });
      this.toast.success('Cliente vinculado à carteira.'); this.linkOpen.set(false); this.load(); this.openDetail(k.id);
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  // ── detalhe e ações
  async openDetail(id: string) { try { this.det.set(await this.api.get('/saas/contracts/' + id)); this.detOpen.set(true); } catch (e) { this.toast.error(e); } }
  private async reload() { const id = this.det()?.id; if (id) this.det.set(await this.api.get('/saas/contracts/' + id)); this.load(); }
  approveOpen() { this.ap = { branchName: 'Matriz', note: '' }; this.apOpen.set(true); }
  async approve() {
    this.busy.set(true);
    try {
      const r = await this.api.post<any>(`/saas/contracts/${this.det().id}/approve`, { branchName: this.ap.branchName || 'Matriz', note: this.ap.note || undefined });
      this.apOpen.set(false); this.res.set(r); this.resOpen.set(true); await this.reload();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  welcome(r: any) {
    const k = this.det();
    return `Olá, ${k?.contact_name?.split(' ')[0] || ''}! Sua assinatura do AXIONYX foi aprovada.\n\n` +
      (r.checkoutUrl ? `1) Pague a primeira mensalidade (${brl(k?.price)}) com Pix ou cartão: ${r.checkoutUrl}\n` : `1) Pagamento da primeira mensalidade: ${brl(k?.price)} (enviaremos as instruções).\n`) +
      `2) O acesso é liberado automaticamente após a confirmação do pagamento.\n3) Entre em ${location.origin}/login com o e-mail ${r.adminEmail}` + (r.tempPassword ? ` e a senha temporária ${r.tempPassword} (troque no primeiro acesso).` : ' e sua senha atual.') +
      `\n\nQualquer dúvida, estamos à disposição.`;
  }
  async reRisk() { try { const r = await this.api.post<any>(`/saas/contracts/${this.det().id}/risk`, {}); this.toast.info(`Risco: ${RISK[r.level].label.toLowerCase()}.`); await this.reload(); } catch (e) { this.toast.error(e); } }
  ask(kind: 'reject' | 'suspend' | 'reactivate' | 'cancel' | 'refund' | 'cancelCharge', charge?: any) {
    const id = this.det().id; this.curCharge = charge ?? null; this.reasonText = '';
    const map: Record<string, Reason> = {
      reject: { title: 'Recusar proposta', label: 'Motivo da recusa', confirm: 'Recusar', danger: true, run: (r) => this.api.post(`/saas/contracts/${id}/reject`, { reason: r }) },
      suspend: { title: 'Suspender acesso', label: 'Motivo (o cliente fica somente com consulta)', confirm: 'Suspender', danger: true, run: (r) => this.api.post(`/saas/contracts/${id}/suspend`, { reason: r }) },
      reactivate: { title: 'Reativar acesso', label: 'Motivo (ex.: acordo, cortesia, pagamento por fora)', confirm: 'Reativar', run: (r) => this.api.post(`/saas/contracts/${id}/reactivate`, { reason: r }) },
      cancel: { title: 'Cancelar contrato', label: 'Motivo do cancelamento (dados ficam disponíveis para consulta)', confirm: 'Cancelar contrato', danger: true, run: (r) => this.api.post(`/saas/contracts/${id}/cancel`, { reason: r }) },
      refund: { title: `Estornar ${brl(charge?.paid_amount ?? charge?.amount)}`, label: 'Motivo do estorno', confirm: 'Estornar', danger: true, run: (r) => this.api.post(`/saas/charges/${charge.id}/refund`, { reason: r }) },
      cancelCharge: { title: 'Cancelar cobrança', label: 'Motivo', confirm: 'Cancelar cobrança', danger: true, run: (r) => this.api.post(`/saas/charges/${charge.id}/cancel`, { reason: r }) },
    };
    this.reason.set(map[kind]); this.reasonOpen.set(true);
  }
  async runReason() {
    this.busy.set(true);
    try { const out: any = await this.reason()!.run(this.reasonText.trim()); this.reasonOpen.set(false); this.toast.success('Feito.'); if (out?.gatewayError) this.toast.warning('Mercado Pago: ' + out.gatewayError); if (out?.manual) this.toast.info('Pagamento manual: devolva o valor ao cliente por fora.'); await this.reload(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  async genLink(c: any) { try { const r = await this.api.post<any>(`/saas/charges/${c.id}/checkout`, {}); await this.copy(r.checkoutUrl); await this.reload(); } catch (e) { this.toast.error(e); } }
  manualOpen(c: any) { this.curCharge = c; this.m = { amount: Number(c.amount), method: 'pix', paidAt: this.today, note: '' }; this.mOpen.set(true); }
  async saveManual() {
    this.busy.set(true);
    try { await this.api.post(`/saas/charges/${this.curCharge.id}/manual-payment`, { amount: Number(this.m.amount), method: this.m.method, paidAt: this.m.paidAt || undefined, note: this.m.note }); this.toast.success('Pagamento registrado.'); this.mOpen.set(false); await this.reload(); }
    catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  chargeOpen() { this.c = { kind: 'avulsa', amount: null, dueDate: this.today, description: '' }; this.cOpen.set(true); }
  async saveCharge() {
    this.busy.set(true);
    try {
      const r = await this.api.post<any>(`/saas/contracts/${this.det().id}/charges`, { kind: this.c.kind, amount: this.c.amount ? Number(this.c.amount) : undefined, dueDate: this.c.dueDate || undefined, description: this.c.description || undefined });
      this.toast.success(r.checkout_url ? 'Cobrança gerada com link de pagamento.' : 'Cobrança gerada.'); if (r.gatewayError) this.toast.warning('Mercado Pago: ' + r.gatewayError);
      this.cOpen.set(false); await this.reload();
    } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  editOpen() { const k = this.det(); this.e = { planId: k.plan_id || '', price: Number(k.price), billingMode: k.billing_mode, graceDays: k.grace_days, contactName: k.contact_name, contactEmail: k.contact_email, contactPhone: k.contact_phone || '', notes: k.notes || '', paidUntil: k.paid_until || '' }; this.eOpen.set(true); }
  async saveEdit() {
    const e = this.e, k = this.det();
    const body: any = { price: Number(e.price), billingMode: e.billingMode, graceDays: Number(e.graceDays), contactName: e.contactName, contactEmail: e.contactEmail, contactPhone: digits(e.contactPhone) || undefined, notes: e.notes || undefined };
    if (e.planId) body.planId = e.planId;
    if (e.paidUntil && e.paidUntil !== k.paid_until) body.paidUntil = e.paidUntil;
    this.busy.set(true);
    try { await this.api.put('/saas/contracts/' + k.id, body); this.toast.success('Contrato atualizado.'); this.eOpen.set(false); await this.reload(); }
    catch (err) { this.toast.error(err); } finally { this.busy.set(false); }
  }
}
