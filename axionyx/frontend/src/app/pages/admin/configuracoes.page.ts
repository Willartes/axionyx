import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

type Field = { section: string; key: string; label: string; desc?: string; type: 'number' | 'bool' | 'select'; min?: number; max?: number; step?: number; suffix?: string; options?: [string, string][]; module?: string };
const TABS: { id: string; label: string; icon: string; title: string; desc: string; fields?: Field[] }[] = [
  { id: 'geral', label: 'Vendas e PDV', icon: 'sliders-horizontal', title: 'Vendas, PDV e Trocas', desc: 'Regras aplicadas pelo servidor em todas as vendas', fields: [
    { section: 'vendas', key: 'exigirCaixaAberto', label: 'Exigir caixa aberto para vender', desc: 'Vendas no PDV só com sessão de caixa aberta (dinheiro sempre exige)', type: 'bool' },
    { section: 'vendas', key: 'permitirEstoqueNegativo', label: 'Permitir vender sem saldo em estoque', desc: 'Não recomendado: gera estoque negativo', type: 'bool' },
    { section: 'vendas', key: 'validadeOrcamentoDias', label: 'Validade dos orçamentos', type: 'number', min: 1, max: 90, suffix: 'dias' },
    { section: 'trocas', key: 'prazoDias', label: 'Prazo para trocas e devoluções', type: 'number', min: 0, max: 365, suffix: 'dias' },
    { section: 'trocas', key: 'validadeValeTrocaDias', label: 'Validade do vale-troca', type: 'number', min: 1, max: 1825, suffix: 'dias' },
    { section: 'condicional', key: 'prazoPadraoDias', label: 'Prazo padrão do condicional', type: 'number', min: 1, max: 60, suffix: 'dias', module: 'condicional' },
    { section: 'condicional', key: 'maxPecas', label: 'Máximo de peças por condicional/bag', type: 'number', min: 1, max: 200, suffix: 'peças', module: 'condicional' },
  ] },
  { id: 'crediario', label: 'Crediário e comissões', icon: 'notebook-pen', title: 'Crediário e Comissões', desc: 'Encargos por atraso e política de crédito próprio', fields: [
    { section: 'crediario', key: 'jurosMensalPct', label: 'Juros de mora', desc: 'Pro rata die após o vencimento (limite legal usual: 1% a.m. em relações de consumo — confirme com sua assessoria)', type: 'number', min: 0, max: 10, step: 0.1, suffix: '% a.m.' },
    { section: 'crediario', key: 'multaPct', label: 'Multa por atraso', desc: 'CDC limita a multa moratória a 2%', type: 'number', min: 0, max: 2, step: 0.1, suffix: '%' },
    { section: 'crediario', key: 'carenciaDias', label: 'Carência antes de cobrar encargos', type: 'number', min: 0, max: 30, suffix: 'dias' },
    { section: 'crediario', key: 'maxParcelas', label: 'Número máximo de parcelas', type: 'number', min: 1, max: 24, suffix: 'x' },
    { section: 'crediario', key: 'parcelaMinima', label: 'Valor mínimo da parcela', type: 'number', min: 0, max: 10000, step: 1, suffix: 'R$' },
    { section: 'crediario', key: 'exigirLimite', label: 'Exigir limite de crédito cadastrado', desc: 'Bloqueia crediário para clientes sem limite ou com saldo excedido', type: 'bool' },
    { section: 'comissoes', key: 'percentualPadrao', label: 'Comissão padrão do vendedor', desc: 'Usada quando não há regra específica nem percentual no usuário', type: 'number', min: 0, max: 50, step: 0.5, suffix: '%' },
  ] },
  { id: 'fiscal', label: 'Fiscal', icon: 'receipt-text', title: 'Configurações Fiscais', desc: 'Parâmetros de emissão. Credenciais do provedor ficam no servidor (variáveis de ambiente).', fields: [
    { section: 'fiscal', key: 'ambiente', label: 'Ambiente SEFAZ', desc: 'Produção exige permissão de emissão fiscal e provedor configurado', type: 'select', options: [['homologacao', 'Homologação (testes, sem valor fiscal)'], ['producao', 'Produção']] },
    { section: 'fiscal', key: 'emitirNfceAutomatico', label: 'Gerar NFC-e automaticamente ao concluir a venda', type: 'bool' },
    { section: 'fiscal', key: 'serieNfce', label: 'Série da NFC-e', type: 'number', min: 1, max: 999 },
    { section: 'fiscal', key: 'serieNfe', label: 'Série da NF-e', type: 'number', min: 1, max: 999 },
    { section: 'fiscal', key: 'aliquotaEstimadaPct', label: 'Carga tributária estimada sobre vendas (DRE)', desc: 'Apenas para a DRE gerencial; não altera documentos fiscais', type: 'number', min: 0, max: 40, step: 0.1, suffix: '%' },
  ] },
  { id: 'clientes', label: 'Clientes e CRM', icon: 'users', title: 'Clientes e Relacionamento', desc: 'Critérios dos segmentos automáticos de clientes', fields: [
    { section: 'segmentos', key: 'inativoDias', label: 'Cliente inativo após', type: 'number', min: 15, max: 720, suffix: 'dias sem comprar' },
    { section: 'segmentos', key: 'posVendaDias', label: 'Janela de pós-venda', type: 'number', min: 1, max: 60, suffix: 'dias após a compra' },
  ] },
  { id: 'varejo', label: 'Balança, validade e idade', icon: 'scale', title: 'Balança, Validade e Maioridade', desc: 'Recursos do segmento: etiqueta de balança, alertas de vencimento e venda de produtos restritos', fields: [
    { section: 'balanca', key: 'prefixo', label: 'Prefixo da etiqueta de balança', desc: 'Primeiro(s) dígito(s) do código impresso pela balança (geralmente 2)', type: 'select', options: [['2', '2'], ['20', '20'], ['21', '21'], ['22', '22'], ['23', '23'], ['24', '24'], ['25', '25'], ['26', '26'], ['27', '27'], ['28', '28'], ['29', '29']], module: 'peso' },
    { section: 'balanca', key: 'digitosCodigo', label: 'Dígitos do código do produto (PLU)', type: 'select', options: [['4', '4 dígitos'], ['5', '5 dígitos'], ['6', '6 dígitos']], module: 'peso' },
    { section: 'balanca', key: 'digitosValor', label: 'Dígitos do valor', type: 'select', options: [['5', '5 dígitos'], ['6', '6 dígitos']], module: 'peso' },
    { section: 'balanca', key: 'tipoValor', label: 'A etiqueta traz', desc: 'Confira na programação da balança (ex.: Toledo MGV: "preço total" ou "peso")', type: 'select', options: [['preco', 'Preço total (centavos)'], ['peso', 'Peso (gramas)']], module: 'peso' },
    { section: 'balanca', key: 'baudRate', label: 'Velocidade da balança no PDV', desc: 'Leitura direta no Chrome/Edge (porta serial/USB)', type: 'select', options: [['2400', '2400'], ['4800', '4800'], ['9600', '9600']], module: 'peso' },
    { section: 'validade', key: 'alertaDias', label: 'Avisar lotes que vencem em até', type: 'number', min: 0, max: 365, suffix: 'dias', module: 'validade' },
    { section: 'maioridade', key: 'exigirConfirmacao', label: 'Exigir confirmação de maioridade no PDV', desc: 'Para produtos marcados como restritos (bebidas alcoólicas, tabaco...)', type: 'bool', module: 'maioridade' },
    { section: 'maioridade', key: 'idadeMinima', label: 'Idade mínima', type: 'number', min: 18, max: 25, suffix: 'anos', module: 'maioridade' },
  ] },
  { id: 'agenda', label: 'Agenda', icon: 'calendar-days', title: 'Agenda e Atendimentos', desc: 'Regras da agenda de serviços (odontologia, estética, salão)', fields: [
    { section: 'agenda', key: 'intervaloMin', label: 'Duração padrão de um atendimento', desc: 'Usada quando o serviço não tem duração cadastrada', type: 'number', min: 5, max: 240, step: 5, suffix: 'min', module: 'agenda' },
    { section: 'agenda', key: 'permitirForaDoExpediente', label: 'Permitir agendar fora do expediente', desc: 'Desligado: só gerentes (agenda de todos) podem forçar um encaixe fora do horário', type: 'bool', module: 'agenda' },
    { section: 'agenda', key: 'antecedenciaLembreteHoras', label: 'Antecedência sugerida do lembrete', type: 'number', min: 1, max: 72, suffix: 'horas', module: 'agenda' },
    { section: 'agenda', key: 'toleranciaFaltaMin', label: 'Tolerância antes de marcar falta', type: 'number', min: 0, max: 120, suffix: 'min', module: 'agenda' },
    { section: 'agenda', key: 'fusoHorario', label: 'Fuso horário da agenda', type: 'select', module: 'agenda', options: [['America/Sao_Paulo', 'Brasília (SP, RJ, MG, Sul, GO, DF, BA, NE)'], ['America/Manaus', 'Amazonas (AM)'], ['America/Cuiaba', 'Mato Grosso (MT)'],
      ['America/Campo_Grande', 'Mato Grosso do Sul (MS)'], ['America/Porto_Velho', 'Rondônia (RO)'], ['America/Boa_Vista', 'Roraima (RR)'], ['America/Rio_Branco', 'Acre (AC)'], ['America/Belem', 'Pará/Amapá (PA, AP)'], ['America/Noronha', 'Fernando de Noronha']] },
  ] },
  { id: 'oficina', label: 'Oficina', icon: 'wrench', title: 'Oficina', desc: 'Valor da hora de mão de obra, garantia e aprovação do orçamento', fields: [
    { section: 'oficina', key: 'valorHora', label: 'Valor da hora de mão de obra', desc: 'Sugerido em cada nova OS (pode ser ajustado por OS por quem tem permissão de aprovar)', type: 'number', min: 0, max: 5000, step: 5, suffix: 'R$/h', module: 'oficina' },
    { section: 'oficina', key: 'garantiaDias', label: 'Garantia padrão dos serviços', desc: 'Contada a partir da entrega do veículo (o CDC prevê no mínimo 90 dias para serviços duráveis)', type: 'number', min: 0, max: 3650, suffix: 'dias', module: 'oficina' },
    { section: 'oficina', key: 'exigirAprovacao', label: 'Itens adicionais exigem nova aprovação', desc: 'Ligado: peça ou serviço incluído durante a execução fica aguardando aprovação do cliente. Desligado: entra aprovado (o orçamento inicial sempre precisa de aprovação)', type: 'bool', module: 'oficina' },
  ] },
  { id: 'whatsapp', label: 'WhatsApp', icon: 'message-circle', title: 'WhatsApp da Empresa', desc: 'Número oficial da empresa para lembretes, cobranças e atendimento' },
  { id: 'empresa', label: 'Empresa', icon: 'building-2', title: 'Dados da Empresa', desc: 'Informações legais e fiscais da empresa ativa' },
  { id: 'seguranca', label: 'Segurança', icon: 'lock', title: 'Segurança', desc: 'Senha, autenticação em dois fatores e sessões ativas' },
];

@Component({
  selector: 'ax-configuracoes',
  imports: [FormsModule, IconComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="cfg-layout" style="display:flex;height:100%">
    <div class="cfg-menu" style="width:210px;border-right:1px solid #DCE4EC;background:white;padding:12px 0;flex-shrink:0">
      <div class="cfg-menu-title" style="padding:4px 12px 12px;font-size:11px;font-weight:700;color:#A0AFBF;text-transform:uppercase;letter-spacing:0.05em">Configurações</div>
      @for (t of visibleTabs(); track t.id) {
        <button (click)="tab.set(t.id)" [style.background]="tab() === t.id ? '#E3EFF9' : 'transparent'" [style.color]="tab() === t.id ? '#0875D1' : '#647687'" [style.font-weight]="tab() === t.id ? 600 : 400" [style.border-left]="'3px solid ' + (tab() === t.id ? '#0875D1' : 'transparent')"
          style="width:100%;display:flex;align-items:center;gap:10px;padding:9px 16px;border:none;font-size:13px;cursor:pointer;text-align:left"><ax-icon [name]="t.icon" [size]="14" /> {{ t.label }}</button>
      }
    </div>
    <div class="cfg-body" style="flex:1;overflow-y:auto;background:#F4F7FA">
      <div class="cfg-inner" style="max-width:680px;margin:0 auto;padding:28px">
        @let t = cur();
        <div class="card" style="padding:24px">
          <div style="font-size:16px;font-weight:700;color:#172B3A">{{ t.title }}</div><div style="font-size:12px;color:#647687;margin-bottom:18px">{{ t.desc }}</div>
          @if (t.fields) {
            <ax-state [loading]="!s()" />
            @if (s()) {
              @for (f of t.fields; track f.section + f.key) { @if (!f.module || auth.has(f.module)) {
                <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #F0F4F8">
                  <div style="flex:1"><div style="font-size:13px;font-weight:600;color:#172B3A">{{ f.label }}</div>@if (f.desc) { <div style="font-size:12px;color:#647687;margin-top:2px">{{ f.desc }}</div> }</div>
                  @if (f.type === 'bool') {
                    <div role="switch" [attr.aria-checked]="!!s()[f.section][f.key]" tabindex="0" (click)="set(f, !s()[f.section][f.key])" (keydown.space)="set(f, !s()[f.section][f.key])" [style.background]="s()[f.section][f.key] ? '#0875D1' : '#DCE4EC'" style="width:38px;height:22px;border-radius:11px;cursor:pointer;position:relative;flex-shrink:0">
                      <div [style.left.px]="s()[f.section][f.key] ? 18 : 2" style="width:18px;height:18px;border-radius:50%;background:white;position:absolute;top:2px;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></div></div>
                  } @else if (f.type === 'select') {
                    <select class="input-field" style="width:260px" [ngModel]="s()[f.section][f.key] + ''" (ngModelChange)="set(f, $event)" [disabled]="!canEdit">@for (o of f.options; track o[0]) { <option [value]="o[0]">{{ o[1] }}</option> }</select>
                  } @else {
                    <div style="display:flex;align-items:center;gap:6px"><input type="number" class="input-field mono" style="width:100px;text-align:right" [min]="f.min ?? 0" [max]="f.max ?? 100000" [step]="f.step ?? 1" [ngModel]="s()[f.section][f.key]" (ngModelChange)="set(f, $event)" [disabled]="!canEdit" />
                      @if (f.suffix) { <span style="font-size:12px;color:#647687;min-width:60px">{{ f.suffix }}</span> }</div>
                  }
                </div>
              } }
              @if (canEdit) { <div style="display:flex;justify-content:flex-end;margin-top:18px"><button class="btn-primary" [disabled]="!dirty() || busy()" (click)="save()"><ax-icon name="save" [size]="14" /> Salvar alterações</button></div> }
              @else { <p class="muted" style="font-size:12px;margin-top:12px">Somente leitura: alterar configurações exige a permissão correspondente.</p> }
            }
          } @else if (t.id === 'whatsapp') {
            @if (wa(); as w) {
              @for (r of [['Número', w.displayPhone || 'Não configurado'], ['Nome verificado na Meta', w.verifiedName || '—'], ['Situação', w.status === 'ativo' ? 'Ativo — enviando' : w.status === 'erro' ? 'Erro nas credenciais' : w.status === 'desativado' ? 'Desativado' : 'Aguardando configuração'], ['Webhook (confirmações e respostas)', w.webhookVerifiedAt ? 'Conectado' : 'Pendente']]; track r[0]) {
                <div style="margin-bottom:12px"><div class="field-label">{{ r[0] }}</div><div style="font-size:13px">{{ r[1] }}</div></div> }
            } @else { <p style="font-size:12px;color:#647687">Cada empresa usa o próprio número na WhatsApp Business Platform (API oficial da Meta).</p> }
            @if (auth.can('integracoes.ver')) { <button class="btn-primary" (click)="router.navigateByUrl('/whatsapp')"><ax-icon name="settings" [size]="13" /> Configurar número e modelos</button> }
            @else { <p class="muted" style="font-size:12px">Peça ao administrador para configurar o WhatsApp da empresa.</p> }
          } @else if (t.id === 'empresa') {
            @if (me()?.company; as c) {
              @for (r of [['Razão social', c.name], ['Nome fantasia', c.trade_name || '—'], ['CNPJ', (c.cnpj | doc)], ['Regime tributário', regime(c.tax_regime)]]; track r[0]) {
                <div style="margin-bottom:12px"><div class="field-label">{{ r[0] }}</div><div style="font-size:13px">{{ r[1] }}</div></div> }
              @if (auth.can('admin.empresas')) { <button class="btn-secondary" (click)="router.navigateByUrl('/admin-empresas')"><ax-icon name="pencil" [size]="13" /> Editar em Administração › Empresas</button> }
            }
          } @else {
            <div class="section-title">Alterar senha</div>
            <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:8px">
              <div><label class="field-label">Senha atual</label><input type="password" class="input-field" autocomplete="current-password" [(ngModel)]="pw.current" /></div>
              <div><label class="field-label">Nova senha</label><input type="password" class="input-field" autocomplete="new-password" [(ngModel)]="pw.next" /><div class="muted" style="font-size:11px;margin-top:2px">Mínimo 10 caracteres, com letras maiúsculas, minúsculas e números.</div></div>
              <div><label class="field-label">Confirmar nova senha</label><input type="password" class="input-field" autocomplete="new-password" [(ngModel)]="pw.confirm" /></div>
            </div>
            <div style="display:flex;justify-content:flex-end"><button class="btn-primary" [disabled]="!pw.current || !pw.next || pw.next !== pw.confirm" (click)="changePw()">Alterar senha</button></div>
            @if (pw.next && pw.confirm && pw.next !== pw.confirm) { <div class="field-error">As senhas não conferem.</div> }

            <div class="section-title" style="margin-top:24px">Autenticação de dois fatores (TOTP)</div>
            @if (me()?.user?.mfa_enabled) {
              <div style="padding:16px;background:#F0FBF4;border:1px solid #B8E5C9;border-radius:8px;display:flex;align-items:center;gap:12px">
                <ax-icon name="lock" [size]="18" color="#18864B" /><div style="flex:1"><div style="font-size:13px;font-weight:700;color:#172B3A">Autenticação de dois fatores ativa</div><div style="font-size:12px;color:#647687">TOTP via aplicativo autenticador</div></div>
                <input type="password" class="input-field" style="width:160px" placeholder="Senha para desativar" [(ngModel)]="mfaPw" />
                <button class="btn-ghost" style="font-size:12px;color:#C93636" [disabled]="!mfaPw" (click)="disableMfa()">Desativar</button>
              </div>
            } @else if (setup(); as st) {
              <div style="padding:16px;border:1px solid #DCE4EC;border-radius:8px">
                <ol style="font-size:13px;padding-left:18px;line-height:1.7;margin:0 0 10px">
                  <li>Abra seu aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy…).</li>
                  <li>Adicione uma conta pela opção "inserir chave" com a chave abaixo (tipo: baseada em tempo, 6 dígitos, 30 segundos).</li>
                  <li>Digite o código de 6 dígitos gerado para confirmar.</li>
                </ol>
                <div class="mono" style="font-size:16px;font-weight:700;letter-spacing:2px;background:#F4F7FA;padding:10px;border-radius:6px;text-align:center;user-select:all">{{ group(st.secret) }}</div>
                <div style="display:flex;gap:8px;margin-top:10px"><input class="input-field mono" style="width:140px;text-align:center;font-size:16px" maxlength="6" inputmode="numeric" placeholder="000000" [(ngModel)]="mfaCode" />
                  <button class="btn-primary" [disabled]="!validCode()" (click)="enableMfa()">Ativar MFA</button><button class="btn-ghost" (click)="setup.set(null)">Cancelar</button></div>
              </div>
            } @else {
              <div style="padding:16px;background:#FFF8EB;border:1px solid #F5E0B0;border-radius:8px;display:flex;align-items:center;gap:12px">
                <ax-icon name="shield-alert" [size]="18" color="#D99000" /><div style="flex:1"><div style="font-size:13px;font-weight:700">Proteja sua conta</div><div style="font-size:12px;color:#647687">Recomendado para administradores e financeiro.</div></div>
                <button class="btn-primary" style="font-size:12px" (click)="startMfa()">Configurar</button>
              </div>
            }

            <div class="section-title" style="margin-top:24px">Sessões ativas</div>
            @for (x of sessions(); track x.id) {
              <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #F0F4F8">
                <ax-icon name="globe" [size]="16" color="#647687" />
                <div style="flex:1"><div style="font-size:13px;font-weight:500;color:#172B3A">{{ device(x.user_agent) }}</div><div style="font-size:12px;color:#647687">IP {{ x.ip || '—' }} · última atividade {{ x.last_seen_at | dtt }} · expira {{ x.expires_at | dtt }}</div></div>
                @if (x.current) { <span class="badge badge-success">Esta sessão</span> } @else { <button class="btn-ghost" style="font-size:12px;color:#C93636" (click)="endSession(x)">Encerrar</button> }
              </div>
            }
          }
        </div>
      </div>
    </div>
  </div>`,
})
export class ConfiguracoesPage implements OnInit {
  private api = inject(Api); readonly router = inject(Router); readonly auth = inject(AuthService); private toast = inject(ToastService);
  readonly wa = signal<any>(null);
  private _wa = this.auth.can('integracoes.ver') ? this.api.get('/whatsapp/config').then((w) => this.wa.set(w), () => {}) : null;
  readonly tabParam = input<string>(undefined, { alias: 'tab' });
  readonly tab = signal('geral'); readonly s = signal<any>(null); readonly dirty = signal(false); readonly busy = signal(false);
  readonly sessions = signal<any[]>([]); readonly setup = signal<any>(null);
  readonly me = this.auth.me; readonly canEdit = this.auth.can('config.editar');
  pw: any = { current: '', next: '', confirm: '' }; mfaCode = ''; mfaPw = ''; private changes: any = {};
  readonly visibleTabs = () => TABS.filter((t) => !t.fields || t.fields.some((f) => !f.module || this.auth.has(f.module)));
  cur() { return TABS.find((t) => t.id === this.tab()) ?? TABS[0]; }
  ngOnInit() { if (this.tabParam() && TABS.some((t) => t.id === this.tabParam())) this.tab.set(this.tabParam()!); this.load(); this.loadSessions(); }
  async load() { try { this.s.set(await this.api.get('/settings')); this.changes = {}; this.dirty.set(false); } catch (e) { this.toast.error(e); } }
  async loadSessions() { try { this.sessions.set(await this.api.get<any[]>('/auth/sessions')); } catch { /* */ } }
  set(f: Field, v: any) {
    if (!this.canEdit) return;
    const val = f.type === 'number' ? Number(v) : f.type === 'bool' ? !!v : v;
    this.s.update((s) => ({ ...s, [f.section]: { ...s[f.section], [f.key]: val } }));
    this.changes[f.section] = { ...(this.changes[f.section] || {}), [f.key]: val }; this.dirty.set(true);
  }
  async save() {
    for (const t of TABS) for (const f of t.fields ?? []) { const v = this.changes[f.section]?.[f.key]; if (f.type === 'number' && v !== undefined && (v < (f.min ?? 0) || v > (f.max ?? 100000))) { this.toast.error(`${f.label}: valor fora do intervalo permitido (${f.min ?? 0} a ${f.max}).`); return; } }
    this.busy.set(true);
    try { this.s.set(await this.api.put('/settings', this.changes)); this.changes = {}; this.dirty.set(false); this.toast.success('Configurações salvas.'); this.auth.loadMe(); } catch (e) { this.toast.error(e); } finally { this.busy.set(false); }
  }
  regime(r: string) { return ({ simples: 'Simples Nacional', presumido: 'Lucro Presumido', real: 'Lucro Real', mei: 'MEI' } as any)[r] ?? r; }
  async changePw() { try { await this.api.post('/auth/password', { current: this.pw.current, next: this.pw.next }); this.pw = { current: '', next: '', confirm: '' }; this.toast.success('Senha alterada. As outras sessões foram encerradas.'); this.loadSessions(); } catch (e) { this.toast.error(e); } }
  async startMfa() { try { this.setup.set(await this.api.post('/auth/mfa/setup')); this.mfaCode = ''; } catch (e) { this.toast.error(e); } }
  async enableMfa() { try { await this.api.post('/auth/mfa/enable', { code: this.mfaCode }); this.setup.set(null); this.toast.success('Autenticação em dois fatores ativada.'); await this.auth.loadMe(); } catch (e) { this.toast.error(e); } }
  async disableMfa() { try { await this.api.post('/auth/mfa/disable', { password: this.mfaPw }); this.mfaPw = ''; this.toast.success('MFA desativado.'); await this.auth.loadMe(); } catch (e) { this.toast.error(e); } }
  async endSession(x: any) { try { await this.api.delete('/auth/sessions/' + x.id); this.loadSessions(); } catch (e) { this.toast.error(e); } }
  group(s: string) { return s.replace(/(.{4})/g, '$1 ').trim(); }
  validCode() { return /^\d{6}$/.test(this.mfaCode); }
  device(ua: string | null) {
    if (!ua) return 'Dispositivo desconhecido';
    const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
    const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return `${b}${o ? ' — ' + o : ''}`;
  }
}
