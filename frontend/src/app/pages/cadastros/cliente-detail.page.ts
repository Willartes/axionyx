import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { StateComponent, ModalComponent } from '../../shared/ui';
import { Api, ApiError } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT, STATUS_PIPES } from '../../core/format';

const TABS = ['Dados Gerais', 'Endereço', 'Preferências e LGPD', 'Financeiro', 'Compras', 'Condicionais', 'Fidelidade', 'Mensagens'];

@Component({
  selector: 'ax-cliente-detail',
  imports: [FormsModule, IconComponent, StateComponent, ModalComponent, ...FMT, ...STATUS_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:16px 24px;background:white;border-bottom:1px solid #DCE4EC">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="width:48px;height:48px;background:linear-gradient(135deg,#0875D1,#1464A5);border-radius:12px;display:flex;align-items:center;justify-content:center"><ax-icon name="users" [size]="24" color="white" /></div>
        <div style="flex:1;min-width:240px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <h1 style="font-size:18px;font-weight:700;color:#172B3A">{{ isNew() ? 'Novo cliente' : c()?.name }}</h1>
            @if (!isNew() && c()) {
              <span class="badge" [class]="c().active ? 'badge badge-success' : 'badge badge-muted'">{{ c().active ? 'Ativo' : 'Inativo' }}</span>
              <span class="badge badge-info">{{ c().type }}</span>
              @if (c().is_partner) { <span class="badge badge-cyan">Revendedora / consignatária</span> }
              @if (c().overdue_balance > 0) { <span class="badge badge-danger">Em atraso</span> }
            }
          </div>
          @if (!isNew() && c()) { <p style="font-size:12px;color:#647687">CLI-{{ c().code }} · {{ c().cpf_cnpj ? (c().cpf_cnpj | doc) : 'sem documento' }} · {{ c().address?.cidade || 'cidade não informada' }}{{ c().address?.uf ? ' - ' + c().address.uf : '' }} · cliente desde {{ c().created_at | dt }}</p> }
          @else { <p style="font-size:12px;color:#647687">Preencha os dados e salve. CPF/CNPJ é validado pelo dígito verificador.</p> }
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          @if (auth.can('clientes.editar')) { <button class="btn-primary" style="font-size:12px" [disabled]="saving()" (click)="save()"><ax-icon name="save" [size]="13" /> Salvar</button> }
          @if (!isNew()) {
            @if (auth.has('prontuario') && auth.can('prontuario.ver')) { <button class="btn-secondary" style="font-size:12px" (click)="router.navigateByUrl('/ficha/' + id())"><ax-icon name="clipboard-list" [size]="13" /> {{ auth.term('prontuario') }}</button> }
            @if (auth.has('agenda') && auth.can('agenda.editar')) { <button class="btn-secondary" style="font-size:12px" (click)="router.navigate(['/agenda'], { queryParams: { cliente: id() } })"><ax-icon name="calendar-plus" [size]="13" /> Agendar</button> }
            @if (auth.can('vendas.criar')) { <button class="btn-secondary" style="font-size:12px" (click)="router.navigate(['/pdv'], { queryParams: { cliente: id() } })"><ax-icon name="shopping-cart" [size]="13" /> Nova venda</button> }
            @if (auth.can('condicional.editar') && auth.has('condicional')) { <button class="btn-secondary" style="font-size:12px" (click)="router.navigate(['/condicional-detail'], { queryParams: { cliente: id() } })"><ax-icon name="shopping-bag" [size]="13" /> Condicional</button> }
            @if (auth.can('mensagens.enviar')) { <button class="btn-ghost" style="font-size:12px" (click)="msgOpen.set(true)"><ax-icon name="message-circle" [size]="13" /> WhatsApp</button> }
            @if (auth.can('clientes.dados_pessoais')) {
              <button class="btn-ghost" style="font-size:12px" (click)="exportData()" title="Portabilidade (LGPD)"><ax-icon name="download" [size]="13" /> Exportar dados</button>
              <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="anonOpen.set(true)" title="Eliminação (LGPD)"><ax-icon name="user-x" [size]="13" /> Anonimizar</button>
            }
          }
        </div>
      </div>
      <div style="display:flex;gap:0;margin-top:16px;border-bottom:1px solid #DCE4EC;margin-bottom:-1px;overflow-x:auto">
        @for (t of tabs; track t; let i = $index) { @if (!isNew() || i < 3) { <div class="tab-item" [class.active]="tab() === i" (click)="setTab(i)">{{ t }}</div> } }
      </div>
    </div>

    <div style="flex:1;overflow-y:auto;padding:24px">
      <ax-state [loading]="loading()" [error]="error()" (retry)="load()" />
      @if (err()) { <div class="state-error" style="margin-top:0">{{ err() }}</div> }
      @if (ready()) {
        @if (tab() === 0) {
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
            <div class="card" style="padding:20px">
              <div class="section-title">Identificação</div>
              <div class="form-grid">
                <div class="span-2"><label class="field-label">Nome / Razão social *</label><input class="input-field" [class.invalid]="fe()['name']" [(ngModel)]="f.name" />@if (fe()['name']) { <div class="field-error">{{ fe()['name'] }}</div> }</div>
                <div><label class="field-label">CPF / CNPJ</label><input class="input-field mono" [class.invalid]="fe()['cpf_cnpj']" [(ngModel)]="f.cpf_cnpj" placeholder="Somente números" />@if (fe()['cpf_cnpj']) { <div class="field-error">{{ fe()['cpf_cnpj'] }}</div> }</div>
                <div><label class="field-label">Inscrição estadual</label><input class="input-field" [(ngModel)]="f.ie" /></div>
                <div><label class="field-label">Nome fantasia / apelido</label><input class="input-field" [(ngModel)]="f.trade_name" /></div>
                <div><label class="field-label">Data de nascimento</label><input type="date" class="input-field" [(ngModel)]="f.birth_date" /></div>
                <div><label class="field-label">Gênero</label><select class="input-field" [(ngModel)]="f.gender"><option [ngValue]="null">Não informado</option><option>Feminino</option><option>Masculino</option><option>Outro</option></select></div>
                <div><label class="field-label">Tags</label><input class="input-field" [(ngModel)]="tagsText" placeholder="vip, atacado..." /></div>
              </div>
            </div>
            <div class="card" style="padding:20px">
              <div class="section-title">Contato e Relacionamento</div>
              <div class="form-grid">
                <div><label class="field-label">WhatsApp</label><input class="input-field mono" [(ngModel)]="f.whatsapp" placeholder="(11) 99999-9999" /></div>
                <div><label class="field-label">Telefone</label><input class="input-field mono" [(ngModel)]="f.phone" /></div>
                <div class="span-2"><label class="field-label">E-mail</label><input class="input-field" [class.invalid]="fe()['email']" [(ngModel)]="f.email" />@if (fe()['email']) { <div class="field-error">{{ fe()['email'] }}</div> }</div>
                <div><label class="field-label">Limite de crediário</label><input type="number" min="0" step="50" class="input-field mono" [(ngModel)]="f.credit_limit" [disabled]="!auth.can(['financeiro.editar','financeiro.renegociar'])" />
                  @if (!auth.can(['financeiro.editar','financeiro.renegociar'])) { <div style="font-size:11px;color:#647687;margin-top:3px">Definido pelo financeiro.</div> }</div>
                <div style="display:flex;flex-direction:column;gap:8px;justify-content:center">
                  <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.is_partner" /> Revendedora / consignatária</label>
                  <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" [(ngModel)]="f.active" /> Cadastro ativo</label>
                </div>
                <div class="span-2"><label class="field-label">Observações</label><textarea class="input-field" rows="3" [(ngModel)]="f.notes"></textarea></div>
              </div>
            </div>
            @if (!isNew() && c()) {
              <div class="card" style="padding:20px;grid-column:1 / -1">
                <div style="font-size:13px;font-weight:600;color:#172B3A;margin-bottom:16px">Resumo do Relacionamento</div>
                <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:16px">
                  @for (k of [['Total comprado', (c().stats.total | brl)], ['Compras', (c().stats.purchases | num) + ' · ' + (c().stats.items | num) + ' peças'], ['Ticket médio', (c().stats.avg_ticket | brl)], ['Crediário em aberto', (c().open_balance | brl)], ['Cashback disponível', (c().cashback | brl)]]; track k[0]) {
                    <div class="kpi-card"><div style="font-size:11px;color:#647687;margin-bottom:4px">{{ k[0] }}</div><div style="font-size:18px;font-weight:700;color:#172B3A">{{ k[1] }}</div></div>
                  }
                </div>
                <div style="display:flex;gap:24px;margin-top:14px;font-size:12px;color:#647687;flex-wrap:wrap">
                  <span>Última compra: <b style="color:#172B3A">{{ c().stats.last_purchase | dt }}</b></span>
                  <span>Tamanhos mais comprados: @for (s of c().top_sizes; track s.code) { <span class="badge badge-muted" style="margin-left:3px">{{ s.code }} ({{ s.qty }})</span> } @empty { — }</span>
                  <span>Marcas preferidas (compras): @for (b of c().top_brands; track b.name) { <span class="badge badge-info" style="margin-left:3px">{{ b.name }}</span> } @empty { — }</span>
                </div>
              </div>
            }
          </div>
        }
        @if (tab() === 1) {
          <div class="card" style="padding:20px;max-width:760px">
            <div class="section-title">Endereço (usado em NF-e e Bag Delivery)</div>
            <div class="form-grid-4">
              <div><label class="field-label">CEP</label><input class="input-field mono" [(ngModel)]="f.address.cep" /></div>
              <div class="span-2"><label class="field-label">Logradouro</label><input class="input-field" [(ngModel)]="f.address.logradouro" /></div>
              <div><label class="field-label">Número</label><input class="input-field" [(ngModel)]="f.address.numero" /></div>
              <div><label class="field-label">Complemento</label><input class="input-field" [(ngModel)]="f.address.complemento" /></div>
              <div><label class="field-label">Bairro</label><input class="input-field" [(ngModel)]="f.address.bairro" /></div>
              <div><label class="field-label">Cidade</label><input class="input-field" [(ngModel)]="f.address.cidade" /></div>
              <div><label class="field-label">UF</label><input class="input-field" maxlength="2" [(ngModel)]="f.address.uf" style="text-transform:uppercase" /></div>
              <div><label class="field-label">Cód. IBGE município</label><input class="input-field mono" maxlength="7" [(ngModel)]="f.address.codigoMunicipio" /></div>
            </div>
          </div>
        }
        @if (tab() === 2) {
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
            <div class="card" style="padding:20px">
              <div class="section-title">Preferências de moda</div>
              @if (!consent.preferencias) { <div class="state-warning" style="margin-bottom:12px"><ax-icon name="shield" [size]="14" />Registre o consentimento "Preferências" ao lado antes de armazenar estas informações (LGPD).</div> }
              <div class="form-grid-3">
                <div><label class="field-label">Tam. superior</label><input class="input-field" [(ngModel)]="f.preferences.tamanhos.superior" [disabled]="!consent.preferencias" /></div>
                <div><label class="field-label">Tam. inferior</label><input class="input-field" [(ngModel)]="f.preferences.tamanhos.inferior" [disabled]="!consent.preferencias" /></div>
                <div><label class="field-label">Calçado</label><input class="input-field" [(ngModel)]="f.preferences.tamanhos.calcado" [disabled]="!consent.preferencias" /></div>
                <div class="span-all"><label class="field-label">Marcas preferidas (separadas por vírgula)</label><input class="input-field" [(ngModel)]="prefBrands" [disabled]="!consent.preferencias" /></div>
                <div class="span-all"><label class="field-label">Estilos</label><input class="input-field" [(ngModel)]="prefStyles" placeholder="Casual, Clássico, Praia..." [disabled]="!consent.preferencias" /></div>
                <div class="span-all"><label class="field-label">Cores</label><input class="input-field" [(ngModel)]="prefColors" [disabled]="!consent.preferencias" /></div>
                <div class="span-all"><label class="field-label">Observações de estilo</label><textarea class="input-field" rows="2" [(ngModel)]="f.preferences.observacoes" [disabled]="!consent.preferencias"></textarea></div>
              </div>
            </div>
            <div class="card" style="padding:20px">
              <div class="section-title">Consentimentos (LGPD)</div>
              <p style="font-size:12px;color:#647687;margin-bottom:12px">Cada alteração é registrada com data, usuário e IP. O histórico não pode ser apagado.</p>
              @for (ch of channels; track ch.id) {
                <label style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #F0F4F8;cursor:pointer">
                  <input type="checkbox" [(ngModel)]="consent[ch.id]" style="margin-top:2px" />
                  <div style="flex:1"><div style="font-size:13px;font-weight:500;color:#172B3A">{{ ch.label }}</div><div style="font-size:11px;color:#647687">{{ ch.desc }}</div>
                    @if (consentAt(ch.id); as at) { <div style="font-size:10px;color:#A0AFBF;margin-top:2px">Último registro: {{ at.granted ? 'concedido' : 'revogado' }} em {{ at.created_at | dtt }} ({{ at.source }})</div> }</div>
                </label>
              }
            </div>
          </div>
        }
        @if (tab() === 3 && c()) {
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
            @for (k of [['Limite de crediário', (c().credit_limit | brl)], ['Em aberto', (c().open_balance | brl)], ['Vencido', (c().overdue_balance | brl)], ['Disponível', ((c().credit_limit - c().open_balance > 0 ? c().credit_limit - c().open_balance : 0) | brl)]]; track k[0]) {
              <div class="kpi-card"><div style="font-size:11px;color:#647687">{{ k[0] }}</div><div style="font-size:18px;font-weight:700;color:#172B3A">{{ k[1] }}</div></div>
            }
          </div>
          <div class="card" style="overflow:hidden">
            <table class="data-table" style="width:100%;border-collapse:collapse">
              <thead><tr><th>Documento</th><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th class="num">Pago</th><th class="num">Saldo</th><th>Situação</th></tr></thead>
              <tbody>@for (r of hist()?.receivables ?? []; track r.id) {
                <tr class="clickable" (click)="router.navigate(['/contas-receber'], { queryParams: { cliente: id() } })">
                  <td class="mono" style="font-size:12px">{{ r.document }}</td><td>{{ r.installment_no }}/{{ r.installments_total }}</td><td class="mono" style="font-size:12px">{{ r.due_date | dt }}</td>
                  <td class="num">{{ r.amount | brl }}</td><td class="num">{{ r.paid_amount | brl }}</td><td class="num" style="font-weight:600">{{ r.balance | brl }}</td>
                  <td><span class="badge" [class]="'badge ' + (overdue(r) ? 'badge-danger' : (r.status | statusClass))">{{ overdue(r) ? 'Vencido' : (r.status | statusLabel) }}</span></td>
                </tr>
              } @empty { <tr><td colspan="7" class="empty-state">Nenhum título de crediário.</td></tr> }</tbody>
            </table>
          </div>
        }
        @if (tab() === 4) {
          <div class="card" style="overflow:hidden">
            <table class="data-table" style="width:100%;border-collapse:collapse">
              <thead><tr><th>Venda</th><th>Data</th><th>Canal</th><th>Vendedor</th><th class="num">Peças</th><th class="num">Valor</th><th>Status</th></tr></thead>
              <tbody>@for (s of hist()?.sales ?? []; track s.id) {
                <tr class="clickable" (click)="router.navigateByUrl('/pedido-detail/' + s.id)">
                  <td class="mono" style="font-size:12px;color:#0875D1;font-weight:500">V{{ s.number }}</td><td class="mono" style="font-size:12px">{{ s.created_at | dtt }}</td><td>{{ s.channel }}</td><td>{{ s.seller }}</td>
                  <td class="num">{{ s.items_count }}</td><td class="num" style="font-weight:600">{{ s.total | brl }}</td><td><span class="badge" [class]="'badge ' + (s.status | statusClass)">{{ s.status | statusLabel }}</span></td>
                </tr>
              } @empty { <tr><td colspan="7" class="empty-state">Nenhuma compra registrada.</td></tr> }</tbody>
            </table>
          </div>
        }
        @if (tab() === 5) {
          <div class="card" style="overflow:hidden">
            <table class="data-table" style="width:100%;border-collapse:collapse">
              <thead><tr><th>Número</th><th>Tipo</th><th>Criado em</th><th>Prazo</th><th>Situação</th></tr></thead>
              <tbody>@for (k of hist()?.conditionals ?? []; track k.id) {
                <tr class="clickable" (click)="router.navigateByUrl('/condicional-detail/' + k.id)"><td class="mono" style="color:#0875D1">#{{ k.number }}</td><td>{{ k.kind === 'bag_delivery' ? 'Bag Delivery' : 'Condicional' }}</td><td>{{ k.created_at | dt }}</td><td>{{ k.due_date | dt }}</td>
                  <td><span class="badge" [class]="'badge ' + (k.status | statusClass)">{{ k.status | statusLabel }}</span></td></tr>
              } @empty { <tr><td colspan="5" class="empty-state">Nenhum condicional.</td></tr> }</tbody>
            </table>
          </div>
        }
        @if (tab() === 6 && c()) {
          <div style="display:grid;grid-template-columns:1fr 2fr;gap:16px">
            <div style="display:flex;flex-direction:column;gap:12px">
              <div class="kpi-card"><div style="font-size:11px;color:#647687">Saldo de cashback</div><div style="font-size:22px;font-weight:700;color:#18864B">{{ c().cashback | brl }}</div></div>
              <div class="card" style="padding:14px"><div style="font-size:12px;font-weight:600;margin-bottom:8px">Vales-troca ativos</div>
                @for (v of c().store_credits; track v.id) { <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0"><span class="mono">{{ v.code }}</span><span>{{ v.balance | brl }} · até {{ v.expires_at | dt }}</span></div> }
                @empty { <div class="muted" style="font-size:12px">Nenhum.</div> }</div>
            </div>
            <div class="card" style="overflow:hidden">
              <table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data</th><th>Movimento</th><th>Observação</th><th>Expira</th><th class="num">Valor</th></tr></thead>
                <tbody>@for (l of hist()?.loyalty ?? []; track l.id) { <tr><td class="mono" style="font-size:12px">{{ l.created_at | dt }}</td><td>{{ l.kind }}</td><td style="font-size:12px;color:#647687">{{ l.notes }}</td><td class="mono" style="font-size:12px">{{ l.expires_at | dt }}</td>
                  <td class="num" [style.color]="l.amount >= 0 ? '#18864B' : '#C93636'">{{ l.amount | brl }}</td></tr> } @empty { <tr><td colspan="5" class="empty-state">Sem movimentos.</td></tr> }</tbody></table>
            </div>
          </div>
        }
        @if (tab() === 7) {
          <div class="card" style="overflow:hidden"><table class="data-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Data</th><th>Finalidade</th><th>Mensagem</th><th>Situação</th></tr></thead>
            <tbody>@for (m of hist()?.messages ?? []; track m.id) { <tr><td class="mono" style="font-size:12px">{{ m.created_at | dtt }}</td><td>{{ m.purpose }}</td><td style="font-size:12px;max-width:360px">{{ m.body }}</td><td><span class="badge" [class]="'badge ' + (m.status | statusClass)">{{ m.status | statusLabel }}</span></td></tr> }
              @empty { <tr><td colspan="4" class="empty-state">Nenhuma mensagem.</td></tr> }</tbody></table></div>
        }
      }
    </div>
  </div>

  <ax-modal [(open)]="anonOpen" title="Anonimizar dados pessoais (LGPD)" icon="user-x">
    <p style="font-size:13px;color:#172B3A;line-height:1.6">Os dados identificáveis (nome, documento, contato, endereço, preferências) serão removidos de forma irreversível. Vendas, documentos fiscais e lançamentos financeiros são preservados sem identificação, conforme obrigações legais. Clientes com títulos em aberto não podem ser anonimizados.</p>
    <div footer><button class="btn-secondary" (click)="anonOpen.set(false)">Cancelar</button><button class="btn-danger" (click)="anonymize()">Anonimizar definitivamente</button></div>
  </ax-modal>
  <ax-modal [(open)]="msgOpen" title="Mensagem por WhatsApp" icon="message-circle">
    <label class="field-label">Finalidade</label>
    <select class="input-field" [(ngModel)]="msg.purpose" style="margin-bottom:10px"><option value="atendimento">Atendimento</option><option value="pos_venda">Pós-venda</option><option value="aniversario">Aniversário</option><option value="cobranca">Cobrança</option><option value="condicional">Condicional</option></select>
    <label class="field-label">Mensagem</label><textarea class="input-field" rows="4" [(ngModel)]="msg.body"></textarea>
    <p style="font-size:11px;color:#647687;margin-top:6px">Exceto atendimento, o envio exige consentimento registrado. Sem credenciais da API oficial, a mensagem fica pendente de configuração.</p>
    <div footer><button class="btn-secondary" (click)="msgOpen.set(false)">Cancelar</button><button class="btn-primary" (click)="sendMsg()">Enviar</button></div>
  </ax-modal>`,
})
export class ClienteDetailPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly id = input<string>();
  readonly tabs = TABS;
  readonly tab = signal(0); readonly c = signal<any>(null); readonly hist = signal<any>(null);
  readonly loading = signal(false); readonly error = signal<string | null>(null); readonly ready = signal(false);
  readonly saving = signal(false); readonly err = signal(''); readonly fe = signal<Record<string, string>>({});
  readonly anonOpen = signal(false); readonly msgOpen = signal(false);
  readonly channels = [
    { id: 'whatsapp', label: 'WhatsApp', desc: 'Pós-venda, aniversário, cobrança e campanhas por WhatsApp.' },
    { id: 'email', label: 'E-mail', desc: 'Comunicações e ofertas por e-mail.' },
    { id: 'sms', label: 'SMS', desc: 'Avisos por SMS.' },
    { id: 'marketing', label: 'Marketing personalizado', desc: 'Uso do histórico de compras para recomendações.' },
    { id: 'preferencias', label: 'Preferências de moda', desc: 'Armazenar tamanhos, marcas, estilos e cores preferidos.' },
  ];
  f: any = this.blank(); consent: Record<string, boolean> = {}; tagsText = ''; prefBrands = ''; prefStyles = ''; prefColors = '';
  msg = { purpose: 'atendimento', body: 'Olá, {nome}! ' };
  isNew() { return !this.id(); }
  blank() { return { type: 'PF', active: true, address: {}, preferences: { tamanhos: {}, marcas: [], estilos: [], cores: [] }, credit_limit: 0 }; }
  ngOnInit() { if (this.isNew()) this.ready.set(true); else this.load(); }
  setTab(i: number) { this.tab.set(i); if (i >= 3 && !this.hist()) this.loadHist(); }
  overdue(r: any) { return ['aberto', 'parcial'].includes(r.status) && r.due_date < new Date().toISOString().slice(0, 10); }
  consentAt(ch: string) { return (this.c()?.consents ?? []).find((x: any) => x.channel === ch); }
  async load() {
    this.loading.set(true); this.error.set(null); this.ready.set(false);
    try {
      const c = await this.api.get<any>('/customers/' + this.id());
      this.c.set(c);
      this.f = { ...this.blank(), ...c, address: { ...(c.address || {}) }, preferences: { tamanhos: {}, marcas: [], estilos: [], cores: [], ...(c.preferences || {}) } };
      this.f.preferences.tamanhos = { ...(this.f.preferences.tamanhos || {}) };
      this.tagsText = (c.tags || []).join(', ');
      this.prefBrands = (this.f.preferences.marcas || []).join(', '); this.prefStyles = (this.f.preferences.estilos || []).join(', '); this.prefColors = (this.f.preferences.cores || []).join(', ');
      this.consent = Object.fromEntries((c.consents || []).map((x: any) => [x.channel, x.granted]));
      this.ready.set(true);
      if (this.tab() >= 3) this.loadHist();
    } catch (e: any) { this.error.set(e.message); } finally { this.loading.set(false); }
  }
  async loadHist() { try { this.hist.set(await this.api.get('/customers/' + this.id() + '/history')); } catch (e) { this.toast.error(e); } }
  private split(s: string) { return s.split(',').map((x) => x.trim()).filter(Boolean); }
  async save() {
    this.saving.set(true); this.err.set(''); this.fe.set({});
    const f = this.f;
    const body: any = {
      name: f.name, trade_name: f.trade_name || undefined, cpf_cnpj: f.cpf_cnpj || undefined, ie: f.ie || undefined, email: f.email || undefined, phone: f.phone || undefined, whatsapp: f.whatsapp || undefined,
      birth_date: f.birth_date || undefined, gender: f.gender || undefined, address: f.address, notes: f.notes || undefined, is_partner: !!f.is_partner, active: !!f.active,
      tags: this.split(this.tagsText), consents: this.consent,
    };
    if (this.consent['preferencias']) body.preferences = { ...f.preferences, marcas: this.split(this.prefBrands), estilos: this.split(this.prefStyles), cores: this.split(this.prefColors) };
    if (this.auth.can(['financeiro.editar', 'financeiro.renegociar'])) body.credit_limit = Number(f.credit_limit || 0);
    try {
      if (this.isNew()) { const r = await this.api.post<any>('/customers', body); this.toast.success('Cliente cadastrado.'); this.router.navigateByUrl('/cliente-detail/' + r.id); }
      else { await this.api.put('/customers/' + this.id(), body); this.toast.success('Cadastro atualizado.'); this.load(); }
    } catch (e: any) { this.err.set(e.message); if (e instanceof ApiError) this.fe.set(e.fieldErrors); if (this.tab() !== 0) this.tab.set(0); } finally { this.saving.set(false); }
  }
  async exportData() { try { await this.api.download(`/customers/${this.id()}/export`); this.toast.success('Arquivo gerado (registrado na auditoria).'); } catch (e) { this.toast.error(e); } }
  async anonymize() {
    try { await this.api.post(`/customers/${this.id()}/anonymize`); this.toast.success('Dados anonimizados.'); this.anonOpen.set(false); this.router.navigateByUrl('/clientes'); }
    catch (e) { this.toast.error(e); }
  }
  async sendMsg() {
    try { const m: any = await this.api.post('/messages', { customerId: this.id(), purpose: this.msg.purpose, body: this.msg.body }); this.toast.show('Mensagem registrada: ' + (m.status || 'duplicada').replace(/_/g, ' '), m.status === 'fila' ? 'success' : 'info'); this.msgOpen.set(false); }
    catch (e) { this.toast.error(e); }
  }
}
