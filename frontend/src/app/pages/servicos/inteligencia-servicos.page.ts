import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/**
 * Inteligência de Serviços: ocupação da agenda por profissional e por horário, faltas, receita por hora,
 * clientes na hora de voltar, pacotes parados e planos de tratamento aguardando aprovação — com ações diretas.
 */
@Component({
  selector: 'ax-inteligencia-servicos',
  imports: [IconComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .heat { display:grid; grid-template-columns:var(--cols); gap:3px; font-size:10.5px; }
    .heat .c { height:24px; border-radius:4px; display:flex; align-items:center; justify-content:center; color:#172B3A; }
    .heat .h { color:#647687; display:flex; align-items:center; justify-content:center; }
    .ins { display:flex; gap:10px; padding:10px 12px; border-radius:8px; font-size:12.5px; line-height:1.5; margin-bottom:8px; }
  `],
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px;display:flex;gap:8px;align-items:center"><ax-icon name="axionyx" [size]="20" color="#0875D1" /> Inteligência de Serviços</h1>
        <p style="font-size:13px;color:#647687">Onde está o faturamento escondido da sua agenda: horários ociosos, clientes que já deveriam ter voltado, faltas, pacotes parados e planos sem aprovação</p></div>
      <div style="display:flex;gap:6px">@for (d of [30, 60, 90, 180]; track d) { <span class="chip" [class.active]="days() === d" (click)="setDays(d)">{{ d }} dias</span> }</div>
    </div>
    @if (data(); as d) {
      @if (d.insights.length) {
        <div class="card" style="padding:14px;margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><ax-icon name="axionyx" [size]="15" color="#00A6D6" /><span style="font-size:14px;font-weight:700">Principais descobertas</span></div>
          @for (i of d.insights; track $index) {
            <div class="ins" [style.background]="i.tone === 'warning' ? '#FFF7E6' : i.tone === 'success' ? '#E8F5EE' : '#F0F7FD'">
              <ax-icon [name]="i.tone === 'warning' ? 'alert-triangle' : i.tone === 'success' ? 'trending-up' : 'info'" [size]="15" [color]="i.tone === 'warning' ? '#D99000' : i.tone === 'success' ? '#18864B' : '#0875D1'" /><span>{{ i.text }}</span></div>
          }
        </div>
      }

      <div class="card" style="overflow:hidden;margin-bottom:14px">
        <div style="padding:10px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">{{ auth.term('profissionais') }}</div>
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>{{ auth.term('profissional') }}</th><th class="num">Ocupação ({{ d.days }} d)</th><th class="num">Ocupação próximos 7 d</th><th class="num">Horas livres (7 d)</th><th class="num">Faltas</th><th class="num">Faturamento</th><th class="num">Faturamento/hora</th></tr></thead>
          <tbody>@for (p of d.professionals; track p.id) {
            <tr><td><span [style.background]="p.color" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>{{ p.name }}</td>
              <td class="num"><div style="display:flex;gap:6px;align-items:center;justify-content:flex-end"><div style="width:70px;height:6px;background:#EEF2F6;border-radius:3px;overflow:hidden"><div [style.width.%]="p.occupancyPast ?? 0" [style.background]="occColor(p.occupancyPast)" style="height:100%"></div></div>{{ p.occupancyPast !== null ? (p.occupancyPast | pct:0) : '—' }}</div></td>
              <td class="num">{{ p.occupancyNext7 !== null ? (p.occupancyNext7 | pct:0) : '—' }}</td><td class="num">{{ p.freeHoursNext7 !== null ? (p.freeHoursNext7 | num:1) + ' h' : '—' }}</td>
              <td class="num" [style.color]="(p.noShowRate ?? 0) >= 10 ? '#C93636' : null">{{ p.noShows }}{{ p.noShowRate !== null ? ' (' + (p.noShowRate | pct:0) + ')' : '' }}</td>
              <td class="num">{{ p.revenue | brl }}</td><td class="num" style="font-weight:600">{{ p.revenuePerHour !== null ? (p.revenuePerHour | brl) : '—' }}</td></tr>
          } @empty { <tr><td colspan="7"><div class="empty-state">Cadastre profissionais com expediente para medir a ocupação.</div></td></tr> }</tbody></table></div>
      </div>

      <div style="display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:14px;margin-bottom:14px" class="grid-2-resp">
        <div class="card" style="padding:14px;overflow-x:auto">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">Ocupação por dia e horário</div>
          <div style="font-size:11.5px;color:#647687;margin-bottom:10px">Minutos agendados ÷ minutos de expediente nos últimos {{ d.days }} dias. Vermelho claro = ocioso.</div>
          @if (!d.enoughHistory) { <div style="font-size:11.5px;color:#D99000;margin-bottom:8px">Histórico ainda pequeno ({{ d.pastAppointments }} atendimento(s) no período): o mapa fica confiável a partir de uns 20 atendimentos.</div> }
          @if (hours().length) {
            <div class="heat" [style.--cols]="'34px repeat(' + hours().length + ', minmax(30px, 1fr))'" style="min-width:420px">
              <span></span>@for (h of hours(); track h) { <span class="h">{{ h }}h</span> }
              @for (dw of dows(); track dw) {
                <span class="h">{{ dowLabel(dw) }}</span>
                @for (h of hours(); track h) { @if (cell(dw, h); as c) { <span class="c" [style.background]="heatColor(c.occupancy)" [title]="dowLabel(dw) + ' ' + h + 'h: ' + c.occupancy + '% (' + c.booked + ' de ' + c.available + ' min)'">{{ c.occupancy | num:0 }}</span> } @else { <span class="c" style="background:#F7F9FB"></span> } }
              }
            </div>
          } @else { <div class="empty-state">Sem expediente/agenda suficientes no período.</div> }
        </div>
        <div class="card" style="padding:14px">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">{{ auth.term('servicos') }} que mais faturam</div>
          @for (s of d.topServices; track s.id) {
            <div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #F0F4F8;font-size:12.5px">
              <span>{{ s.name }}<div style="font-size:11px;color:#647687">{{ s.times }}× · ticket {{ s.avg_ticket | brl }}{{ s.revenue_per_hour ? ' · ' + (s.revenue_per_hour | brl) + '/h' : '' }}</div></span><b class="mono">{{ s.revenue | brl }}</b></div>
          } @empty { <div class="empty-state">Sem vendas de serviços no período.</div> }
        </div>
      </div>

      <div class="card" style="overflow:hidden;margin-bottom:14px">
        <div style="padding:10px 16px;border-bottom:1px solid #EEF2F6;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div><span style="font-size:13px;font-weight:600">Hora de voltar</span> <span style="font-size:12px;color:#647687">— passaram do intervalo de retorno do serviço e não têm horário marcado</span></div>
          @if (auth.can('mensagens.enviar') && consented().length) { <button class="btn-primary" style="font-size:12px" (click)="inviteAll()"><ax-icon name="send" [size]="13" /> Convidar {{ consented().length }} por WhatsApp</button> }
        </div>
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>{{ auth.term('cliente') }}</th><th>Último serviço</th><th>Último atendimento</th><th class="num">Intervalo</th><th class="num">Atraso</th><th></th></tr></thead>
          <tbody>@for (r of d.returnsDue; track r.customer_id + r.service) {
            <tr><td style="font-weight:500">{{ r.customer }}<div style="font-size:11px;color:#647687">{{ r.phone ? (r.phone | phone) : 'sem telefone' }}</div></td><td>{{ r.service }}</td><td>{{ r.last_date | dt }}</td>
              <td class="num">{{ r.interval_days }} d</td><td class="num" [style.color]="r.overdue_days > 15 ? '#C93636' : '#D99000'">{{ r.overdue_days > 0 ? r.overdue_days + ' d' : 'vence em ' + (-r.overdue_days) + ' d' }}</td>
              <td style="white-space:nowrap">@if (auth.can('agenda.editar')) { <a style="font-size:11.5px;color:#0875D1;cursor:pointer;margin-right:10px" (click)="book(r)">Agendar</a> }
                @if (auth.can('mensagens.enviar')) { @if (r.whatsapp_consent) { <a style="font-size:11.5px;color:#18864B;cursor:pointer" (click)="invite(r)">WhatsApp</a> } @else { <span style="font-size:11px;color:#8696A7">sem consentimento</span> } }</td></tr>
          } @empty { <tr><td colspan="6"><div class="empty-state">Ninguém atrasado. O intervalo vem do cadastro do serviço (“retorno sugerido”) ou do histórico real dos clientes.</div></td></tr> }</tbody></table></div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px" class="grid-2-resp">
        @if (auth.has('pacotes')) {
          <div class="card" style="overflow:hidden">
            <div style="padding:10px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Pacotes parados ou perto do vencimento</div>
            @for (k of d.packages; track k.id) {
              <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 16px;border-bottom:1px solid #F0F4F8;font-size:12.5px">
                <span><b>{{ k.customer }}</b><div style="font-size:11px;color:#647687">{{ k.service }} · {{ k.sessions_total - k.sessions_used }} sessão(ões) · {{ k.expires_at ? 'vence ' + (k.expires_at | dt) : 'sem validade' }}</div></span>
                <span style="text-align:right"><b class="mono">{{ k.value_open | brl }}</b>@if (auth.can('agenda.editar')) { <div><a style="font-size:11px;color:#0875D1;cursor:pointer" (click)="bookCustomer(k.customer_id)">Agendar</a></div> }</span></div>
            } @empty { <div class="empty-state">Nenhum pacote parado.</div> }
          </div>
        }
        @if (auth.has('odontograma')) {
          <div class="card" style="overflow:hidden">
            <div style="padding:10px 16px;border-bottom:1px solid #EEF2F6"><span style="font-size:13px;font-weight:600">Planos de tratamento</span>
              <div style="font-size:11.5px;color:#647687">{{ d.plans.presented }} aguardando ({{ d.plans.presented_value | brl }}) · aprovado não cobrado {{ d.plans.approved_unbilled | brl }}{{ d.plans.decided_period ? ' · aprovação ' + (d.plans.approved_period / d.plans.decided_period * 100 | num:0) + '% no período' : '' }}</div></div>
            @for (p of d.pendingPlans; track p.id) {
              <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 16px;border-bottom:1px solid #F0F4F8;font-size:12.5px;cursor:pointer" (click)="router.navigate(['/ficha', p.customer_id], { queryParams: { aba: 'planos' } })">
                <span><b>{{ p.customer }}</b><div style="font-size:11px;color:#647687">Plano nº {{ p.number }} · aguardando há {{ p.days_waiting ?? 0 }} dia(s)</div></span><b class="mono">{{ p.total | brl }}</b></div>
            } @empty { <div class="empty-state">Nenhum plano aguardando aprovação.</div> }
          </div>
        }
      </div>
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:260px"></div></div> }
  </div>`,
})
export class InteligenciaServicosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly days = signal(60); readonly data = signal<any>(null);
  ngOnInit() { this.load(); }
  setDays(d: number) { this.days.set(d); this.load(); }
  async load() { try { this.data.set(await this.api.get('/service-intelligence', { days: this.days() })); } catch (e) { this.toast.error(e); } }
  readonly hours = computed<number[]>(() => [...new Set<number>((this.data()?.heatmap ?? []).map((h: any) => Number(h.hour)))].sort((a, b) => a - b));
  readonly dows = computed(() => [1, 2, 3, 4, 5, 6, 0].filter((d) => (this.data()?.heatmap ?? []).some((h: any) => h.dow === d)));
  readonly consented = computed(() => (this.data()?.returnsDue ?? []).filter((r: any) => r.whatsapp_consent));
  dowLabel(d: number) { return DOW[d]; }
  cell(d: number, h: number) { return (this.data()?.heatmap ?? []).find((x: any) => x.dow === d && x.hour === h) ?? null; }
  heatColor(o: number | null) { if (o === null) return '#F7F9FB'; if (o < 25) return '#FBE3E3'; if (o < 50) return '#FFF1D6'; if (o < 75) return '#DCEEFB'; return '#B9E3C9'; }
  occColor(o: number | null) { return o === null ? '#DCE4EC' : o < 40 ? '#D99000' : o < 75 ? '#0875D1' : '#18864B'; }
  book(r: any) { this.bookCustomer(r.customer_id); }
  bookCustomer(id: string) { this.router.navigate(['/agenda'], { queryParams: { cliente: id } }); }
  async invite(r: any) {
    try {
      const m: any = await this.api.post('/messages', { customerId: r.customer_id, purpose: 'retorno', body: 'Olá, {nome}! Já está na hora do seu próximo {servico} aqui na {loja}. Quer que a gente reserve um horário para você? É só responder esta mensagem.' });
      this.toast.show(m?.status === 'fila' ? 'Convite na fila de envio.' : `Mensagem: ${m?.status}${m?.error ? ' — ' + m.error : ''}`, m?.status === 'fila' ? 'success' : 'info');
    } catch (e) { this.toast.error(e); }
  }
  async inviteAll() {
    if (!confirm(`Enviar convite de retorno por WhatsApp para ${this.consented().length} cliente(s) que autorizaram mensagens?`)) return;
    try {
      const r: any = await this.api.post('/messages/bulk', { customerIds: this.consented().map((x: any) => x.customer_id), purpose: 'retorno', refId: 'retorno-' + new Date().toISOString().slice(0, 7),
        body: 'Olá, {nome}! Já está na hora do seu próximo {servico} aqui na {loja}. Quer que a gente reserve um horário para você? É só responder esta mensagem.' });
      this.toast.success('Convites: ' + Object.entries(r || {}).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', '));
    } catch (e) { this.toast.error(e); }
  }
}
