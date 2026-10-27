import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CHARTS } from '../../shared/charts';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, brl } from '../../core/format';
import { formatPlate } from './oficina-shared';

/** Painel da oficina: carga do pátio, faturamento (mão de obra × peças), produtividade por mecânico, aprovação de orçamentos e revisões a vencer. */
@Component({
  selector: 'ax-oficina-painel',
  imports: [IconComponent, ...CHARTS, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`.plate { font-family:'JetBrains Mono',monospace; font-weight:700; letter-spacing:.06em; background:#F1F4F7; border:1px solid #CBD6E1; border-radius:6px; padding:1px 7px; font-size:12px; white-space:nowrap; }`],
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="gauge" [size]="20" color="#0875D1" /> Painel da Oficina</h1>
        <p style="font-size:13px;color:#647687">Pátio, faturamento, produtividade e clientes com revisão chegando — com os dados reais das ordens de serviço</p></div>
      <div style="display:flex;gap:6px">@for (d of [30, 90, 180]; track d) { <span class="chip" [class.active]="days() === d" (click)="days.set(d); load()">{{ d }} dias</span> }</div>
    </div>
    @if (s(); as s) {
      <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px">
        <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl('/oficina')"><div class="kpi-l">Veículos no pátio</div><div class="kpi-v">{{ s.open.open }}</div><div class="muted" style="font-size:11.5px">{{ s.open.working }} em execução · {{ s.open.waiting_parts }} aguardando peça</div></div>
        <div class="kpi-card"><div class="kpi-l">Orçamentos em aberto</div><div class="kpi-v">{{ s.open.quotes }}</div><div class="muted" style="font-size:11.5px">{{ s.open.ready }} pronto(s) para entrega</div></div>
        <div class="kpi-card"><div class="kpi-l">Atrasadas</div><div class="kpi-v" [style.color]="s.open.late ? '#C93636' : null">{{ s.open.late }}</div><div class="muted" style="font-size:11.5px">prazo de entrega vencido</div></div>
        <div class="kpi-card"><div class="kpi-l">Aprovação de orçamentos</div><div class="kpi-v">{{ s.approvalPct !== null ? (s.approvalPct | pct:0) : '—' }}</div><div class="muted" style="font-size:11.5px">valor aprovado ÷ valor decidido</div></div>
      </div>
      <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px">
        <div class="kpi-card"><div class="kpi-l">Faturado ({{ s.days }} dias)</div><div class="kpi-v" style="color:#18864B">{{ s.period.revenue | brl }}</div><div class="muted" style="font-size:11.5px">{{ s.period.delivered }} OS entregue(s)</div></div>
        <div class="kpi-card"><div class="kpi-l">Ticket médio por OS</div><div class="kpi-v">{{ s.period.ticket | brl }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Mão de obra</div><div class="kpi-v">{{ s.period.labor | brl }}</div><div class="muted" style="font-size:11.5px">{{ s.period.laborPct | pct:0 }} do faturado · {{ s.period.hours | num:1 }} h vendidas</div></div>
        <div class="kpi-card"><div class="kpi-l">Permanência média</div><div class="kpi-v">{{ s.period.avg_days | num:1 }} dias</div><div class="muted" style="font-size:11.5px">da abertura à entrega</div></div>
      </div>
      <div class="grid-2-resp" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:14px">
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">Mão de obra × peças</div>
          @if (s.period.revenue) { <ax-donut [data]="[{ label: 'Serviços e mão de obra', value: s.period.labor, color: '#0875D1' }, { label: 'Peças e produtos', value: s.period.parts, color: '#00A6D6' }]" [fmt]="fmt" /> }
          @else { <div class="empty-state">Nenhuma OS entregue no período.</div> }</div>
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">Peças e produtos mais vendidos</div>
          @if (s.topParts.length) { <ax-rank [data]="rank(s.topParts)" [fmt]="fmt" /> } @else { <div class="empty-state">Sem peças no período.</div> }</div>
      </div>
      <div class="card" style="overflow:hidden;margin-bottom:14px">
        <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Produtividade por {{ auth.term('profissional').toLowerCase() }}</div>
        <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>{{ auth.term('profissional') }}</th><th class="num">OS</th><th class="num">Horas vendidas</th><th class="num">Faturado (serviços e peças)</th></tr></thead>
          <tbody>@for (m of s.mechanics; track m.id) { <tr><td>{{ m.name }}</td><td class="num">{{ m.orders }}</td><td class="num">{{ m.hours | num:1 }}</td><td class="num">{{ m.revenue | brl }}</td></tr> }
          @empty { <tr><td colspan="4"><div class="empty-state">Informe o {{ auth.term('profissional').toLowerCase() }} nas OS para medir a produtividade.</div></td></tr> }</tbody></table>
      </div>
      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6;display:flex;gap:8px;align-items:center"><ax-icon name="calendar-clock" [size]="15" color="#D99000" /> Revisões chegando (próximos 30 dias ou perto da quilometragem)</div>
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Cliente</th><th>Veículo</th><th>Revisão</th><th>Quando</th><th>Contato</th><th></th></tr></thead>
          <tbody>@for (r of reminders(); track r.id) {
            <tr><td>{{ r.customer_name || '—' }}</td><td><span class="plate">{{ fp(r.plate) }}</span> {{ r.model }}</td><td>{{ r.description }}</td>
              <td style="font-size:12px">{{ r.due_km ? 'aos ' + (r.due_km | num) + ' km' : '' }}{{ r.due_km && r.due_date ? ' ou ' : '' }}{{ r.due_date ? (r.due_date | dt) : '' }}</td>
              <td style="font-size:12px">{{ (r.whatsapp || r.phone) ? ((r.whatsapp || r.phone) | phone) : '—' }}{{ r.contacted_at ? ' · contatado em ' + (r.contacted_at | dt) : '' }}</td>
              <td style="white-space:nowrap">@if (auth.can('oficina.editar')) { <button class="btn-ghost" style="font-size:11px" (click)="mark(r, 'contatado')">Contatado</button><button class="btn-ghost" style="font-size:11px" (click)="mark(r, 'descartar')">Descartar</button> }</td></tr>
          } @empty { <tr><td colspan="6"><div class="empty-state">Nenhuma revisão chegando. Cadastre "revisão a cada km/dias" nos serviços (ex.: troca de óleo) para gerar os lembretes.</div></td></tr> }</tbody></table></div>
      </div>
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:120px"></div></div> }
  </div>`,
})
export class OficinaPainelPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly router = inject(Router);
  readonly s = signal<any>(null); readonly reminders = signal<any[]>([]); readonly days = signal(30);
  readonly fmt = (v: number) => brl(v); readonly fp = formatPlate;
  rank(rows: any[]) { return rows.map((r) => ({ label: r.label, value: r.value })); }
  ngOnInit() { this.load(); }
  async load() {
    try { const [s, r] = await Promise.all([this.api.get('/workshop/summary', { days: this.days() }), this.api.get<any[]>('/vehicle-reminders', { days: 30 })]); this.s.set(s); this.reminders.set(r); }
    catch (e) { this.toast.error(e); }
  }
  async mark(r: any, action: string) { try { await this.api.post(`/vehicle-reminders/${r.id}`, { action }); this.load(); } catch (e) { this.toast.error(e); } }
}
