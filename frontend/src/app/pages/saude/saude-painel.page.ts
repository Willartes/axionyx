import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CHARTS } from '../../shared/charts';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, brl } from '../../core/format';

/** Painel da clínica: hoje (sala de espera e tempo de espera), produção do período, faltas, particular × convênio, faturamento e glosa por convênio, produção por profissional e especialidade. */
@Component({
  selector: 'ax-saude-painel',
  imports: [IconComponent, ...CHARTS, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div><h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="stethoscope" [size]="20" color="#0875D1" /> Painel da Clínica</h1>
        <p style="font-size:13px;color:#647687">Atendimentos, faltas, convênios e produção por profissional — calculados a partir da agenda e das guias reais</p></div>
      <div style="display:flex;gap:6px">@for (d of [30, 90, 180]; track d) { <span class="chip" [class.active]="days() === d" (click)="days.set(d); load()">{{ d }} dias</span> }</div>
    </div>
    @if (s(); as s) {
      <div style="font-size:12px;font-weight:700;letter-spacing:.05em;color:#647687;margin:0 0 8px">HOJE</div>
      <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px">
        <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl('/recepcao')"><div class="kpi-l">Agendados</div><div class="kpi-v">{{ s.today.scheduled }}</div><div class="muted" style="font-size:11.5px">{{ s.today.done }} concluído(s)</div></div>
        <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl('/recepcao')"><div class="kpi-l">Na sala de espera</div><div class="kpi-v" style="color:#0875D1">{{ s.today.waiting }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Em atendimento</div><div class="kpi-v">{{ s.today.in_service }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Espera média hoje</div><div class="kpi-v">{{ s.today.avg_wait | num:0 }} min</div><div class="muted" style="font-size:11.5px">da chegada à chamada</div></div>
      </div>
      <div style="font-size:12px;font-weight:700;letter-spacing:.05em;color:#647687;margin:0 0 8px">ÚLTIMOS {{ s.days }} DIAS</div>
      <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px">
        <div class="kpi-card"><div class="kpi-l">Atendimentos realizados</div><div class="kpi-v">{{ s.period.done }}</div><div class="muted" style="font-size:11.5px">{{ s.period.newPatients }} paciente(s) novo(s) · {{ s.period.tele }} teleconsulta(s)</div></div>
        <div class="kpi-card"><div class="kpi-l">Taxa de faltas</div><div class="kpi-v" [style.color]="s.period.noShowPct >= 15 ? '#C93636' : null">{{ s.period.noShowPct | pct:1 }}</div><div class="muted" style="font-size:11.5px">{{ s.period.no_show }} falta(s)</div></div>
        <div class="kpi-card"><div class="kpi-l">Receita particular</div><div class="kpi-v" style="color:#18864B">{{ s.period.privateRevenue | brl }}</div><div class="muted" style="font-size:11.5px">cobrado no caixa</div></div>
        <div class="kpi-card"><div class="kpi-l">Espera média</div><div class="kpi-v">{{ s.period.avg_wait | num:0 }} min</div></div>
      </div>
      <div class="kpi-grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px">
        <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl('/convenios')"><div class="kpi-l">Convênio a faturar</div><div class="kpi-v">{{ s.insurance.to_bill | brl }}</div></div>
        <div class="kpi-card" style="cursor:pointer" (click)="router.navigateByUrl('/convenios')"><div class="kpi-l">Aguardando pagamento</div><div class="kpi-v">{{ s.insurance.sent | brl }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Recebido de convênios</div><div class="kpi-v" style="color:#18864B">{{ s.insurance.received | brl }}</div></div>
        <div class="kpi-card"><div class="kpi-l">Índice de glosa</div><div class="kpi-v" [style.color]="s.insurance.glossPct >= 5 ? '#C93636' : null">{{ s.insurance.glossPct | pct:1 }}</div><div class="muted" style="font-size:11.5px">{{ s.insurance.glossed | brl }} glosado(s)</div></div>
      </div>
      <div class="grid-2-resp" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:14px">
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">Particular × convênio (atendimentos)</div>
          @if (s.period.done) { <ax-donut [data]="[{ label: 'Particular', value: s.period.private, color: '#0875D1' }, { label: 'Convênio', value: s.period.by_insurer, color: '#00A6D6' }, { label: 'Outros', value: s.period.done - s.period.private - s.period.by_insurer, color: '#B8C4D0' }]" [fmt]="int" /> }
          @else { <div class="empty-state">Nenhum atendimento concluído no período.</div> }</div>
        <div class="card" style="padding:14px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">Atendimentos por especialidade</div>
          @if (s.specialties.length) { <ax-rank [data]="s.specialties" [fmt]="int" /> } @else { <div class="empty-state">Sem dados no período.</div> }
          <div class="muted" style="font-size:11.5px;margin-top:8px">Primeira consulta: {{ s.period.first_visits }} · Retornos: {{ s.period.returns }}</div></div>
      </div>
      <div class="card" style="overflow:hidden;margin-bottom:14px">
        <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Produção por {{ auth.term('profissional').toLowerCase() }}</div>
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>{{ auth.term('profissional') }}</th><th>Especialidade</th><th class="num">Atendimentos</th><th class="num">Pacientes</th><th class="num">Faltas</th></tr></thead>
          <tbody>@for (p of s.professionals; track p.id) { <tr><td>{{ p.name }}</td><td>{{ p.specialty || '—' }}</td><td class="num">{{ p.done }}</td><td class="num">{{ p.patients }}</td><td class="num">{{ p.no_show }}</td></tr> }
          @empty { <tr><td colspan="5"><div class="empty-state">Cadastre os profissionais da clínica.</div></td></tr> }</tbody></table></div>
      </div>
      <div class="card" style="overflow:hidden">
        <div style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #EEF2F6">Convênios</div>
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Convênio</th><th class="num">A faturar</th><th class="num">Aguardando</th><th class="num">Recebido</th><th class="num">Glosado</th></tr></thead>
          <tbody>@for (i of s.insurers; track i.id) { <tr><td>{{ i.name }}</td><td class="num">{{ i.to_bill | brl }}</td><td class="num">{{ i.sent | brl }}</td><td class="num" style="color:#18864B">{{ i.received | brl }}</td><td class="num" style="color:#C93636">{{ i.glossed | brl }}</td></tr> }
          @empty { <tr><td colspan="5"><div class="empty-state">Sem movimento de convênio no período.</div></td></tr> }</tbody></table></div>
      </div>
    } @else { <div class="card" style="padding:24px"><div class="skeleton" style="height:120px"></div></div> }
  </div>`,
})
export class SaudePainelPage implements OnInit {
  private api = inject(Api); readonly auth = inject(AuthService); private toast = inject(ToastService); readonly router = inject(Router);
  readonly s = signal<any>(null); readonly days = signal(30);
  readonly money = (v: number) => brl(v); readonly int = (v: number) => String(Math.round(v));
  ngOnInit() { this.load(); }
  async load() { try { this.s.set(await this.api.get('/health/summary', { days: this.days() })); } catch (e) { this.toast.error(e); } }
}
