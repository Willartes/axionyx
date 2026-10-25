import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ListState, PagerComponent, StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FMT } from '../../core/format';
import { PLAN_STATUS } from './ficha.page';

/** Planos de tratamento de todos os pacientes: acompanhamento de aprovação (conversão) e do que falta cobrar/realizar. */
@Component({
  selector: 'ax-planos',
  imports: [FormsModule, PagerComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="padding:24px">
    <div style="margin-bottom:14px"><h1 style="font-size:20px;font-weight:700;color:#172B3A;margin-bottom:2px">Planos de Tratamento</h1>
      <p style="font-size:13px;color:#647687">Orçamentos clínicos: aguardando aprovação, em andamento e concluídos. Para criar um plano, abra o {{ auth.term('prontuario').toLowerCase() }} do {{ auth.term('cliente').toLowerCase() }}.</p></div>
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #EEF2F6">
        @for (s of statuses; track s[0]) { <span class="chip" [class.active]="status === s[0]" (click)="status = s[0]; list.load(1)">{{ s[1] }}</span> }
        <span style="flex:1"></span>
        <input class="input-field" style="max-width:240px" [placeholder]="auth.term('cliente') + ' ou nº do plano'" [(ngModel)]="q" (keyup.enter)="list.load(1)" />
      </div>
      <ax-state [loading]="list.loading()" [error]="list.error()" [empty]="!list.loading() && !list.items().length" emptyText="Nenhum plano nesta situação." (retry)="list.reload()" />
      @if (list.items().length) {
        <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse">
          <thead><tr><th>Nº</th><th>{{ auth.term('cliente') }}</th><th>{{ auth.term('profissional') }}</th><th>Criado</th><th>Situação</th><th class="num">Pendentes</th><th class="num">Cobrado</th><th class="num">Total</th></tr></thead>
          <tbody>@for (p of list.items(); track p.id) {
            <tr style="cursor:pointer" (click)="router.navigate(['/ficha', p.customer_id], { queryParams: { aba: 'planos' } })">
              <td class="mono">{{ p.number }}</td><td style="font-weight:500">{{ p.customer }}</td><td>{{ p.professional || '—' }}</td><td>{{ p.created_at | dt }}</td>
              <td><span class="badge" [class]="badge(p.status)">{{ label(p.status) }}</span></td><td class="num">{{ p.pending_items }}</td><td class="num">{{ p.billed | brl }}</td><td class="num" style="font-weight:600">{{ p.total | brl }}</td></tr>
          }</tbody></table></div>
        <ax-pager [page]="list.page()" [pages]="list.pages()" [total]="list.total()" (go)="list.load($event)" />
      }
    </div>
  </div>`,
})
export class PlanosPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService);
  readonly statuses: [string, string][] = [['', 'Todos'], ['apresentado', 'Aguardando aprovação'], ['aprovado', 'Aprovados'], ['em_andamento', 'Em andamento'], ['concluido', 'Concluídos'], ['recusado', 'Recusados'], ['rascunho', 'Rascunhos']];
  status = ''; q = '';
  readonly list = new ListState<any>((q) => this.api.get('/treatment-plans', { ...q, status: this.status || undefined, q: this.q || undefined }));
  ngOnInit() { this.list.load(); }
  badge(s: string) { return 'badge ' + (PLAN_STATUS[s]?.[1] ?? 'badge-muted'); }
  label(s: string) { return PLAN_STATUS[s]?.[0] ?? s; }
}
