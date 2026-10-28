import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { filter } from 'rxjs';
import { LogoComponent } from '../shared/logo.component';
import { IconComponent } from '../shared/icon.component';
import { AiAssistantComponent } from './ai-assistant.component';
import { AuthService } from '../core/auth.service';
import { Api } from '../core/api.service';
import { ToastService } from '../core/toast.service';
import { NAV, TITLES, ICON_OF, NavItem } from '../core/nav';
import { initials, doc, DatePipe } from '../core/format';

const LS_RECENT = 'axionyx.recent', LS_FAV = 'axionyx.favorites';
/** Telas que dependem de um módulo ativo da empresa. */
const MODULE_OF: Record<string, string> = { condicionais: 'condicional', consignacoes: 'consignacao', fidelidade: 'fidelidade', crm: 'crm', rh: 'rh', juridico: 'juridico', contabilidade: 'contabilidade', fiscal: 'fiscal', precificacao: 'precificacao', validade: 'validade', combos: 'combos',
  agenda: 'agenda', servicos: 'agenda', profissionais: 'agenda', 'planos-tratamento': 'odontograma', 'inteligencia-servicos': 'agenda', oficina: 'oficina', veiculos: 'oficina', 'oficina-painel': 'oficina', recepcao: 'saude', convenios: 'saude', 'saude-painel': 'saude' };
/** Níveis da trilha cujo destino não é a primeira tela da seção. */
const CRUMB_OVERRIDES: Record<string, string[]> = {
  Atendimento: ['recepcao', 'agenda'], Intelligence: ['intelligence'], 'Compras|Cotações': ['compras'], 'Compras|Entradas': ['recebimentos'],
};
const readLs = (k: string): string[] => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const writeLs = (k: string, v: string[]) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* indisponível */ } };

@Component({
  selector: 'ax-shell',
  imports: [LogoComponent, RouterOutlet, FormsModule, IconComponent, AiAssistantComponent, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="app-shell" style="display:flex;height:100vh;background:#F4F7FA;overflow:hidden">
    @if (mobileNavOpen()) { <div class="sidebar-scrim" (click)="mobileNavOpen.set(false)" aria-hidden="true"></div> }

    <!-- Sidebar -->
    <aside class="app-sidebar" [class.mobile-open]="mobileNavOpen()" [style.width.px]="collapsed() ? 52 : 220"
      style="background:#102A43;display:flex;flex-direction:column;transition:width 0.2s ease;overflow:hidden;flex-shrink:0;z-index:10">
      <div style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px;flex-shrink:0;cursor:pointer" (click)="go('dashboard')">
        <ax-logo [size]="30" />
        @if (!collapsed()) { <span style="font-size:16px;font-weight:800;color:white;letter-spacing:-0.3px;white-space:nowrap">AXIONYX</span> }
      </div>

      <div style="flex:1;overflow-y:auto;overflow-x:hidden;padding:8px 0">
        <div style="padding:0 6px;margin-bottom:4px">
          <div class="sidebar-item" [class.active]="current() === 'dashboard'" (click)="go('dashboard')" [attr.title]="collapsed() ? 'Página Inicial' : null">
            <ax-icon name="layout-dashboard" [size]="15" class="sidebar-icon" />@if (!collapsed()) { <span>Página Inicial</span> }
          </div>
          @if (!collapsed()) {
            <div class="sidebar-item" (click)="favOpen.set(!favOpen())"><ax-icon name="star" [size]="15" /><span style="flex:1">Favoritos</span><ax-icon [name]="favOpen() ? 'chevron-down' : 'chevron-right'" [size]="12" /></div>
            @if (favOpen()) {
              @for (f of favorites(); track f) { <div class="sidebar-item" style="padding-left:34px;font-size:12px" (click)="go(f)">{{ titleOf(f) }}</div> }
              @empty { <div style="padding:4px 12px 4px 34px;font-size:11px;color:#4A657A">Use ☆ no topo da página para favoritar.</div> }
            }
            <div class="sidebar-item" (click)="recentOpen.set(!recentOpen())"><ax-icon name="clock" [size]="15" /><span style="flex:1">Recentes</span><ax-icon [name]="recentOpen() ? 'chevron-down' : 'chevron-right'" [size]="12" /></div>
            @if (recentOpen()) {
              @for (r of recent(); track r) { <div class="sidebar-item" style="padding-left:34px;font-size:12px" (click)="go(r)">{{ titleOf(r) }}</div> }
              @empty { <div style="padding:4px 12px 4px 34px;font-size:11px;color:#4A657A">Nenhuma tela visitada ainda.</div> }
            }
          }
        </div>

        @for (section of sections(); track section.title) {
          @if (!collapsed()) { <div class="sidebar-section">{{ section.title }}</div> } @else { <div style="height:8px"></div> }
          <div style="padding:0 6px">
            @for (item of section.items; track item.id) {
              <div class="sidebar-item" [class.active]="isActive(item)" (click)="go(item.id)" [attr.title]="collapsed() ? item.label : null" style="position:relative">
                <span class="sidebar-icon" style="flex-shrink:0;display:inline-flex"><ax-icon [name]="item.icon" [size]="15" /></span>
                @if (!collapsed()) {
                  <span style="flex:1">{{ item.label }}</span>
                  @if (badge(item); as b) { <span style="background:rgba(8,117,209,0.6);color:white;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:700">{{ b }}</span> }
                  @if (alert(item)) { <span style="width:6px;height:6px;background:#C93636;border-radius:50%;flex-shrink:0"></span> }
                } @else if (badge(item); as b) {
                  <span style="position:absolute;top:2px;right:2px;background:#C93636;color:white;border-radius:10px;padding:0 4px;font-size:9px;font-weight:700">{{ b }}</span>
                }
              </div>
            }
          </div>
        }
      </div>

      <div style="border-top:1px solid rgba(255,255,255,0.06);padding:8px 6px">
        @if (!collapsed()) {
          <div class="sidebar-item" style="background:rgba(0,166,214,0.1);border:1px solid rgba(0,166,214,0.2);margin-bottom:4px" (click)="aiOpen.set(!aiOpen())">
            <ax-icon name="bot" [size]="15" color="#00A6D6" /><span style="color:#00A6D6;font-weight:500">AXIA — Assistente IA</span>
          </div>
        }
        <div class="sidebar-item" (click)="go('configuracoes')"><ax-icon name="settings" [size]="15" />@if (!collapsed()) { <span>Configurações</span> }</div>
        <div class="sidebar-item" (click)="auth.logout()"><ax-icon name="log-out" [size]="15" />@if (!collapsed()) { <span>Sair</span> }</div>
      </div>
    </aside>

    <!-- Main -->
    <div class="app-main" style="flex:1;display:flex;flex-direction:column;overflow:hidden">
      <header class="app-topbar" style="height:48px;background:white;border-bottom:1px solid #DCE4EC;display:flex;align-items:center;padding-left:12px;padding-right:16px;gap:12px;flex-shrink:0;z-index:5">
        <button (click)="toggleMenu()" class="btn-ghost" style="padding:5px 6px" [attr.aria-label]="mobileNavOpen() ? 'Fechar menu' : 'Alternar menu'">
          <ax-icon [name]="collapsed() ? 'panel-left-open' : 'panel-left-close'" [size]="16" />
        </button>

        <nav class="app-breadcrumbs" aria-label="Você está em" style="display:flex;align-items:center;gap:4px;font-size:13px;flex:1">
          @if (current() !== 'dashboard' && canOpen('dashboard')) {
            <a class="crumb crumb-home" href="/dashboard" (click)="crumbGo($event, 'dashboard')" title="Página inicial" aria-label="Página inicial"><ax-icon name="house" [size]="14" /></a>
          }
          @for (c of crumbLinks(); track $index; let last = $last; let i = $index) {
            <span class="crumb-wrap" [class.crumb-parent]="i === crumbLinks().length - 2" [class.crumb-last]="last">
              @if (i > 0 || (current() !== 'dashboard' && canOpen('dashboard'))) { <ax-icon class="crumb-sep" name="chevron-right" [size]="12" color="#A0AFBF" /> }
              @if (!last && c.id) { <a class="crumb crumb-link" [href]="'/' + c.id" (click)="crumbGo($event, c.id)" [title]="'Ir para ' + c.label"><ax-icon class="crumb-back" name="chevron-left" [size]="14" />{{ c.label }}</a> }
              @else { <span class="crumb" [style.color]="last ? '#172B3A' : '#647687'" [style.font-weight]="last ? 500 : 400" [attr.aria-current]="last ? 'page' : null">{{ c.label }}</span> }
            </span>
          }
          <button class="btn-ghost no-print" style="padding:2px 4px;margin-left:2px" (click)="toggleFav()" [attr.title]="isFav() ? 'Remover dos favoritos' : 'Adicionar aos favoritos'">
            <ax-icon name="star" [size]="13" [color]="isFav() ? '#D99000' : '#A0AFBF'" />
          </button>
        </nav>

        <button (click)="openSearch()" class="btn-ghost global-search-icon" aria-label="Pesquisar" title="Pesquisar"><ax-icon name="search" [size]="19" /></button>

        <button (click)="openSearch()" class="btn-ghost global-search" style="display:flex;align-items:center;gap:8px;background:#F4F7FA;border:1px solid #DCE4EC;border-radius:6px;padding:5px 12px;color:#647687;font-size:13px;width:200px;justify-content:flex-start">
          <ax-icon name="search" [size]="13" /><span>Pesquisa global...</span>
          <span style="margin-left:auto;font-size:11px;color:#A0AFBF;background:#EEF2F6;border-radius:4px;padding:1px 5px">⌘K</span>
        </button>

        <div class="company-context" style="position:relative">
          <div (click)="ctxOpen.set(!ctxOpen())" style="display:flex;align-items:center;gap:6px;padding:4px 10px;background:#F4F7FA;border:1px solid #DCE4EC;border-radius:6px;cursor:pointer;font-size:12px">
            <ax-icon name="building-2" [size]="13" color="#647687" />
            <span style="color:#172B3A;font-weight:500">{{ me()?.company?.trade_name || me()?.company?.name }}</span>
            <span style="color:#A0AFBF">·</span>
            <span style="color:#647687">{{ me()?.branch?.name }}</span>
            <ax-icon name="chevron-down" [size]="12" color="#A0AFBF" />
          </div>
          @if (ctxOpen()) {
            <div style="position:absolute;top:36px;right:0;background:white;border:1px solid #DCE4EC;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.1);width:280px;z-index:100;overflow:hidden">
              <div style="padding:10px 14px;border-bottom:1px solid #F0F4F8;font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:.04em">Filial</div>
              @for (b of me()?.branches ?? []; track b.id) {
                <div class="btn-ghost" style="width:100%;justify-content:space-between;border-radius:0;padding:8px 14px" (click)="switchBranch(b.id)">
                  <span style="color:#172B3A">{{ b.code }} · {{ b.name }}</span>@if (b.id === me()?.branch?.id) { <ax-icon name="check" [size]="13" color="#0875D1" /> }
                </div>
              }
              @if ((me()?.companies?.length ?? 0) > 1) {
                <div style="padding:10px 14px;border-top:1px solid #F0F4F8;border-bottom:1px solid #F0F4F8;font-size:11px;font-weight:600;color:#647687;text-transform:uppercase;letter-spacing:.04em">Empresa</div>
                @for (c of me()?.companies ?? []; track c.id) {
                  <div class="btn-ghost" style="width:100%;justify-content:space-between;border-radius:0;padding:8px 14px" (click)="switchCompany(c.id)">
                    <span style="color:#172B3A">{{ c.trade_name || c.name }}</span>@if (c.id === me()?.company?.id) { <ax-icon name="check" [size]="13" color="#0875D1" /> }
                  </div>
                }
              }
            </div>
          }
        </div>

        <div class="period-context" style="font-size:12px;color:#647687;padding:4px 8px;background:#F4F7FA;border:1px solid #DCE4EC;border-radius:6px;white-space:nowrap">{{ period }}</div>

        <button class="btn-ghost" style="padding:5px 8px;position:relative" (click)="aiOpen.set(!aiOpen())" aria-label="Assistente AXIA"><ax-icon name="bot" [size]="16" [color]="aiOpen() ? '#00A6D6' : '#647687'" /></button>

        <div style="position:relative">
          <button class="btn-ghost" style="padding:5px 8px;position:relative" (click)="notifOpen.set(!notifOpen())" aria-label="Notificações">
            <ax-icon name="bell" [size]="16" />
            @if (notifications().length) { <span style="position:absolute;top:3px;right:4px;width:7px;height:7px;background:#C93636;border-radius:50%;border:1.5px solid white"></span> }
          </button>
          @if (notifOpen()) {
            <div style="position:absolute;top:40px;right:-60px;background:white;border:1px solid #DCE4EC;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.1);width:330px;z-index:100;overflow:hidden">
              <div style="padding:10px 14px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:600;color:#172B3A">Notificações</div>
              @for (n of notifications(); track $index) {
                <div style="padding:10px 14px;border-bottom:1px solid #F7FAFD;display:flex;gap:10px;align-items:flex-start;cursor:pointer" class="btn-ghost" (click)="notifOpen.set(false); router.navigateByUrl(n.link)">
                  <ax-icon [name]="n.icon" [size]="14" [color]="n.tone === 'danger' ? '#C93636' : n.tone === 'warning' ? '#D99000' : '#2878C7'" />
                  <span style="font-size:12px;color:#172B3A;text-align:left;font-weight:400">{{ n.text }}</span>
                </div>
              } @empty { <div class="empty-state" style="padding:24px">Nenhuma pendência no momento.</div> }
            </div>
          }
        </div>

        <div style="display:flex;align-items:center;gap:8px;cursor:pointer;position:relative" (click)="userOpen.set(!userOpen())">
          <div style="width:30px;height:30px;background:linear-gradient(135deg,#0875D1,#1464A5);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:white">{{ userInitials() }}</div>
          @if (userOpen()) {
            <div style="position:absolute;top:40px;right:0;background:white;border:1px solid #DCE4EC;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.1);width:220px;z-index:100;overflow:hidden">
              <div style="padding:12px 16px;border-bottom:1px solid #F0F4F8">
                <div style="font-weight:600;color:#172B3A;font-size:13px">{{ me()?.user?.name }}</div>
                <div style="font-size:12px;color:#647687">{{ me()?.platform ? (me()?.platform?.owner ? 'Proprietário da plataforma' : (me()?.platform?.title || 'Equipe AXIONYX')) : me()?.user?.role }}</div>
              </div>
              <div style="padding:4px 0">
                <div style="padding:8px 16px;font-size:13px;color:#172B3A;cursor:pointer;width:100%" class="btn-ghost" (click)="go('configuracoes', { tab: 'seguranca' })">Minha senha e segurança</div>
                <div style="padding:8px 16px;font-size:13px;color:#172B3A;cursor:pointer;width:100%" class="btn-ghost" (click)="go('configuracoes')">Preferências</div>
                <div style="padding:8px 16px;font-size:13px;color:#172B3A;cursor:pointer;width:100%" class="btn-ghost" (click)="aiOpen.set(true)">Ajuda (AXIA)</div>
                <div style="height:1px;background:#F0F4F8;margin:4px 0"></div>
                <div (click)="auth.logout()" style="padding:8px 16px;font-size:13px;color:#C93636;cursor:pointer;display:flex;align-items:center;gap:8px"><ax-icon name="log-out" [size]="13" /> Sair do sistema</div>
              </div>
            </div>
          }
        </div>
      </header>

      @if (me()?.billing; as b) {
        @if (b.status === 'inadimplente') {
          <div class="bill-banner warn no-print"><ax-icon name="alert-triangle" [size]="14" /><span>Mensalidade vencida em {{ b.paidUntil | dt }}. Regularize até {{ b.suspendOn | dt }} para evitar que o sistema fique somente para consulta.</span><a (click)="go('minha-assinatura')">Pagar agora</a></div>
        } @else if (b.status === 'suspenso') {
          <div class="bill-banner danger no-print"><ax-icon name="lock" [size]="14" /><span>Assinatura suspensa por falta de pagamento: modo somente consulta. Seus dados estão preservados.</span><a (click)="go('minha-assinatura')">Regularizar</a></div>
        } @else if (b.status === 'cancelado') {
          <div class="bill-banner muted no-print"><ax-icon name="archive" [size]="14" /><span>Assinatura cancelada: os dados continuam disponíveis para consulta e exportação.</span><a (click)="go('minha-assinatura')">Ver detalhes</a></div>
        }
      }
      @if (me()?.company?.is_demo) {
        <div class="demo-banner no-print"><ax-icon name="flask-conical" [size]="13" /> Empresa de demonstração — todos os dados desta empresa são fictícios e servem apenas para teste.</div>
      }

      <div class="app-content" style="flex:1;overflow:hidden;display:flex">
        <div class="app-screen" style="flex:1;overflow-y:auto;overflow-x:hidden">@if (!me()?.user?.must_change_password) { <router-outlet /> }</div>
        @if (aiOpen()) {
          <div class="ai-panel no-print" style="width:360px;border-left:1px solid #DCE4EC;background:white;flex-shrink:0;overflow:hidden"><ax-ai-assistant (close)="aiOpen.set(false)" /></div>
        }
      </div>
    </div>
  </div>

  @if (me()?.user?.must_change_password) {
    <div class="modal-backdrop" style="z-index:300">
      <div class="modal fade-in" style="max-width:440px" role="dialog" aria-modal="true">
        <div class="modal-header"><ax-icon name="lock" [size]="16" color="#0875D1" /><h3>Defina sua senha</h3></div>
        <div class="modal-body">
          <p style="font-size:13px;color:#4A5B6B;margin-bottom:12px">Você entrou com uma <b>senha temporária</b>. Crie uma senha pessoal para continuar — só você deve conhecê-la.</p>
          <label class="field-label">Senha temporária</label><input class="input-field" type="password" autocomplete="current-password" [(ngModel)]="npw.current" />
          <label class="field-label" style="margin-top:10px">Nova senha</label><input class="input-field" type="password" autocomplete="new-password" [(ngModel)]="npw.next" />
          <div class="muted" style="font-size:11px;margin-top:2px">Mínimo 10 caracteres, com letras maiúsculas, minúsculas e números.</div>
          <label class="field-label" style="margin-top:10px">Confirme a nova senha</label><input class="input-field" type="password" autocomplete="new-password" [(ngModel)]="npw.confirm" (keyup.enter)="setPassword()" />
          @if (npw.confirm && npw.next !== npw.confirm) { <div style="font-size:11.5px;color:#C93636;margin-top:4px">As senhas não conferem.</div> }
        </div>
        <div class="modal-footer"><button class="btn-secondary" (click)="auth.logout()">Sair</button><button class="btn-primary" [disabled]="!npw.current || !npw.next || npw.next !== npw.confirm || npwBusy()" (click)="setPassword()">Salvar e continuar</button></div>
      </div>
    </div>
  }
  @if (searchOpen()) {
    <div class="modal-backdrop search-backdrop" (mousedown)="searchOpen.set(false)">
      <div class="modal fade-in search-modal" role="dialog" aria-label="Pesquisa" style="max-width:600px" (mousedown)="$event.stopPropagation()">
        <div class="search-bar" style="padding:12px 14px;border-bottom:1px solid #F0F4F8;display:flex;align-items:center;gap:10px">
          <ax-icon name="search" [size]="16" color="#647687" />
          <input id="global-search-input" type="search" enterkeyhint="search" autocomplete="off" class="input-field search-input" style="border:none;box-shadow:none;padding:4px;font-size:14px" placeholder="Buscar telas, clientes, produtos ou nº da venda..." [ngModel]="sq()" (ngModelChange)="searchType($event)" (keydown.escape)="searchOpen.set(false)" (keydown.enter)="searchEnter()" />
          @if (sq()) { <button class="btn-ghost" style="padding:4px" (click)="searchType(''); focusSearch()" aria-label="Limpar"><ax-icon name="x" [size]="15" /></button> }
          <span class="kbd search-esc">ESC</span>
          <button class="btn-ghost search-cancel" (click)="searchOpen.set(false)">Cancelar</button>
        </div>
        <div class="search-results" style="max-height:60vh;overflow-y:auto;padding:6px 0">
          @if (sq().length < 2) {
            @if (quickLinks().length) {
              <div style="padding:6px 14px;font-size:10px;font-weight:600;color:#647687;text-transform:uppercase">Acesso rápido</div>
              @for (s of quickLinks(); track s.id) { <div class="autocomplete-item" (click)="searchOpen.set(false); go(s.id)"><ax-icon [name]="s.icon" [size]="13" [color]="s.fav ? '#D99000' : '#0875D1'" /> &nbsp;{{ s.title }}</div> }
            }
            <div style="padding:10px 14px;font-size:12px;color:#8696A7">Digite ao menos 2 letras: telas do sistema, clientes (nome, CPF/CNPJ, telefone), produtos (nome, código, EAN) ou número da venda.</div>
          }
          @if (screenHits().length) {
            <div style="padding:6px 14px;font-size:10px;font-weight:600;color:#647687;text-transform:uppercase">Telas</div>
            @for (s of screenHits(); track s.id) { <div class="autocomplete-item" (click)="searchOpen.set(false); go(s.id)"><ax-icon [name]="s.icon" [size]="13" color="#0875D1" /> &nbsp;{{ s.title }}</div> }
          }
          @if (hits(); as h) {
            @if (h.customers.length) { <div style="padding:6px 14px;font-size:10px;font-weight:600;color:#647687;text-transform:uppercase">Clientes</div>
              @for (c of h.customers; track c.id) { <div class="autocomplete-item" (click)="openRoute('/cliente-detail/' + c.id)">{{ c.name }} <span class="muted" style="font-size:11px">{{ docf(c.cpf_cnpj) }}</span></div> } }
            @if (h.products.length) { <div style="padding:6px 14px;font-size:10px;font-weight:600;color:#647687;text-transform:uppercase">Produtos</div>
              @for (p of h.products; track p.id) { <div class="autocomplete-item" (click)="openRoute('/produto-detail/' + p.id)"><span class="mono" style="font-size:11px;color:#0875D1">{{ p.code }}</span> {{ p.name }}</div> } }
            @if (h.sales.length) { <div style="padding:6px 14px;font-size:10px;font-weight:600;color:#647687;text-transform:uppercase">Vendas</div>
              @for (s of h.sales; track s.id) { <div class="autocomplete-item" (click)="openRoute('/pedido-detail/' + s.id)">Venda nº {{ s.number }}</div> } }
          }
          @if (sq().length >= 2 && !screenHits().length && !hits()?.customers?.length && !hits()?.products?.length && !hits()?.sales?.length) { <div class="empty-state" style="padding:20px">Nada encontrado.</div> }
        </div>
      </div>
    </div>
  }`,
})
export class ShellComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly router = inject(Router);
  private api = inject(Api);
  private toast = inject(ToastService);
  readonly me = this.auth.me;
  readonly collapsed = signal(false);
  readonly mobileNavOpen = signal(false);
  npw = { current: '', next: '', confirm: '' }; readonly npwBusy = signal(false);
  async setPassword() {
    this.npwBusy.set(true);
    try { await this.api.post('/auth/password', { current: this.npw.current, next: this.npw.next }); this.npw = { current: '', next: '', confirm: '' }; await this.auth.loadMe(); this.toast.success('Senha definida.'); this.loadBadges(); }
    catch (e) { this.toast.error(e); } finally { this.npwBusy.set(false); }
  }
  readonly aiOpen = signal(false);
  readonly notifOpen = signal(false);
  readonly userOpen = signal(false);
  readonly ctxOpen = signal(false);
  readonly searchOpen = signal(false);
  readonly favOpen = signal(false);
  readonly recentOpen = signal(false);
  readonly current = signal('dashboard');
  readonly badges = signal<any>({});
  readonly notifications = computed(() => (this.badges()?.notifications ?? []) as any[]);
  readonly recent = signal<string[]>(readLs(LS_RECENT));
  readonly favorites = signal<string[]>(readLs(LS_FAV));
  readonly sq = signal('');
  readonly hits = signal<any>(null);
  readonly period = new Date().toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', '').replace(/^\w/, (c) => c.toUpperCase());
  private timer: any; private st: any;

  readonly sections = computed(() => {
    const me = this.me(); if (!me) return [];
    const mods = new Set(me.company.modules || []);

    const sa = !!me.user?.is_superadmin, bill = me.billing;
    if (bill?.blocked && !sa) return [{ title: 'ASSINATURA', items: NAV.flatMap((s) => s.items).filter((i) => i.id === 'minha-assinatura') }];
    return NAV.map((s) => ({ ...s, items: s.items.filter((i) => (!i.sa || this.auth.pcan(i.sa)) && (!i.billing || !!bill) && (!i.perm || this.auth.can(i.perm)) && (!MODULE_OF[i.id] || mods.has(MODULE_OF[i.id]))) })).filter((s) => s.items.length);
  });
  readonly crumbs = computed(() => TITLES[this.current()] ?? ['AXIONYX']);
  /** Trilha com links: cada nível leva à tela correspondente (só se o usuário puder abri-la). */
  readonly crumbLinks = computed(() => {
    const t = this.crumbs(); this.me();
    return t.map((label, i) => ({ label, id: i < t.length - 1 ? this.crumbTarget(t.slice(0, i + 1)) : null }));
  });
  /** Favoritos e recentes quando a pesquisa ainda está vazia. */
  readonly quickLinks = computed(() => {
    const fav = this.favorites().filter((id) => this.canOpen(id)).map((id) => ({ id, fav: true }));
    const rec = this.recent().filter((id) => id !== this.current() && !this.favorites().includes(id) && this.canOpen(id)).map((id) => ({ id, fav: false }));
    return [...fav, ...rec].slice(0, 8).map((x) => ({ ...x, title: (TITLES[x.id] ?? [x.id]).join(' › '), icon: x.fav ? 'star' : ICON_OF[x.id] || 'clock' }));
  });
  readonly userInitials = computed(() => initials(this.me()?.user?.name || ''));
  readonly isFav = computed(() => this.favorites().includes(this.current()));
  readonly screenHits = computed(() => {
    const q = this.sq().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); if (q.length < 2) return [];
    const allowed = new Set(this.sections().flatMap((s) => s.items.map((i) => i.id)).concat(['dashboard', 'clientes', 'produtos', 'pdv', 'estoque-posicao', 'contas-receber', 'contas-pagar', 'trocas', 'caixa', 'comissoes', 'transferencias', 'inventario', 'etiquetas', 'recebimentos', 'nfe', 'dre']));
    return Object.entries(TITLES).filter(([id, t]) => allowed.has(id) && !id.endsWith('-detail') && t.join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q))
      .slice(0, 8).map(([id, t]) => ({ id, title: t.join(' › '), icon: ICON_OF[id] || 'chevron-right' }));
  });

  ngOnInit() {
    this.setCurrent(this.router.url);
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e: any) => { this.setCurrent(e.urlAfterRedirects); this.closePopups(); });
    this.loadBadges();
    this.timer = setInterval(() => this.loadBadges(), 60_000);
  }
  ngOnDestroy() { clearInterval(this.timer); }
  private setCurrent(url: string) {
    const id = url.split('?')[0].split('/')[1] || 'dashboard';
    this.current.set(id);
    if (TITLES[id] && !id.endsWith('-detail') && id !== 'sem-permissao') {
      const r = [id, ...this.recent().filter((x) => x !== id)].slice(0, 6); this.recent.set(r); writeLs(LS_RECENT, r);
    }
  }
  async loadBadges() { if (this.me()?.user?.must_change_password || (this.me()?.billing?.blocked && !this.me()?.user?.is_superadmin)) return; try { this.badges.set(await this.api.get('/nav/badges')); } catch { /* silencioso */ } }
  badge(i: NavItem) { const v = i.badgeKey ? this.badges()?.[i.badgeKey] : 0; return v > 0 ? v : null; }
  alert(i: NavItem) { return !!(i.alertKey && this.badges()?.[i.alertKey] > 0); }
  isActive(i: NavItem) {
    const c = this.current();
    const groups: Record<string, string[]> = {
      pedidos: ['pedidos', 'pedido-detail', 'orcamentos', 'trocas', 'caixa', 'comissoes'], cadastros: ['cadastros', 'clientes', 'cliente-detail', 'produtos', 'produto-detail', 'fornecedores', 'auxiliares'],
      compras: ['compras', 'mapa-cotacao', 'pedidos-compra', 'recebimentos', 'entrada-detail'], estoque: ['estoque', 'estoque-posicao', 'movimentacoes', 'transferencias', 'inventario', 'curva-abc', 'etiquetas'],
      financeiro: ['financeiro', 'contas-receber', 'contas-pagar', 'conciliacao', 'fluxo-caixa'], crediario: ['crediario', 'carne'], precificacao: ['precificacao', 'precificar-produto', 'custos-fixos', 'custos-variaveis', 'analise-precos', 'historico-precos'], contabilidade: ['contabilidade', 'lancamentos', 'dre', 'plano-contas'],
      fiscal: ['fiscal', 'nfe', 'nfe-detail', 'monitor-fiscal'], rh: ['rh', 'colaboradores', 'colaborador-detail'], juridico: ['juridico', 'processos', 'processo-detail'],
      condicionais: ['condicionais', 'condicional-detail'], consignacoes: ['consignacoes', 'consignacao-detail'], auditoria: ['auditoria'], integracoes: ['integracoes', 'whatsapp'],
    };
    return c === i.id || !!groups[i.id]?.includes(c);
  }
  /** Tela de destino de um nível da trilha: a tela com exatamente esse título ou a primeira tela daquela seção que o usuário pode abrir. */
  private crumbTarget(prefix: string[]): string | null {
    const key = prefix.join('|'), n = prefix.length;
    const cands = [...(CRUMB_OVERRIDES[key] ?? []), ...Object.keys(TITLES).filter((id) => TITLES[id].join('|') === key),
      ...Object.keys(TITLES).filter((id) => !id.endsWith('-detail') && TITLES[id].length === n + 1 && TITLES[id].slice(0, n).join('|') === key)];
    return cands.find((id) => id !== this.current() && this.canOpen(id)) ?? null;
  }
  /** O usuário pode abrir a tela? (mesmas regras do menu e das rotas: permissão, permissão de plataforma e módulo ativo) */
  canOpen(id: string): boolean {
    const me = this.me(); if (!me) return false;
    if (me.billing?.blocked && !me.user?.is_superadmin) return id === 'minha-assinatura';
    const mod = MODULE_OF[id]; if (mod && !(me.company.modules || []).includes(mod)) return false;
    const shell = this.router.config.find((r) => r.component === ShellComponent);
    const route = shell?.children?.find((r) => r.path === id);
    if (!route) return false;
    const d: any = route.data ?? {};
    if (d.platform && !this.auth.pcan(d.platform)) return false;
    if (d.perm && !this.auth.can(d.perm)) return false;
    return true;
  }
  crumbGo(ev: MouseEvent, id: string) {
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1) return; // nova aba
    ev.preventDefault(); this.go(id);
  }
  focusSearch() { setTimeout(() => document.getElementById('global-search-input')?.focus(), 10); }
  titleOf(id: string) { return (TITLES[id] ?? [id]).slice(-1)[0]; }
  go(id: string, query?: any) { this.router.navigate(['/' + id], { queryParams: query }); this.mobileNavOpen.set(false); }
  openRoute(url: string) { this.searchOpen.set(false); this.router.navigateByUrl(url); }
  toggleMenu() { if (window.matchMedia('(max-width: 760px)').matches) this.mobileNavOpen.set(!this.mobileNavOpen()); else this.collapsed.set(!this.collapsed()); }
  toggleFav() { const id = this.current(); const f = this.isFav() ? this.favorites().filter((x) => x !== id) : [...this.favorites(), id]; this.favorites.set(f); writeLs(LS_FAV, f); }
  closePopups() { this.notifOpen.set(false); this.userOpen.set(false); this.ctxOpen.set(false); }
  docf(v: string) { return v ? doc(v) : ''; }
  async switchBranch(branchId: string) {
    this.ctxOpen.set(false);
    try { await this.auth.enterContext(this.me()!.company.id, branchId); this.toast.success('Filial alterada.'); this.loadBadges(); this.router.navigateByUrl('/dashboard'); }
    catch (e) { this.toast.error(e); }
  }
  async switchCompany(companyId: string) {
    this.ctxOpen.set(false);
    try {
      const branches = await this.auth.branchesOf(companyId);
      if (!branches.length) { this.toast.error('Sem filiais disponíveis nesta empresa.'); return; }
      await this.auth.enterContext(companyId, branches[0].id); this.toast.success('Empresa alterada.'); this.loadBadges(); this.router.navigateByUrl('/dashboard');
    } catch (e) { this.toast.error(e); }
  }
  openSearch() { this.searchOpen.set(true); this.sq.set(''); this.hits.set(null); setTimeout(() => document.getElementById('global-search-input')?.focus(), 30); }
  searchType(v: string) {
    this.sq.set(v); clearTimeout(this.st);
    if (v.trim().length < 2) { this.hits.set(null); return; }
    this.st = setTimeout(async () => { try { this.hits.set(await this.api.get('/search', { q: v })); } catch { this.hits.set(null); } }, 250);
  }
  searchEnter() { const s = this.screenHits()[0]; if (s) { this.searchOpen.set(false); this.go(s.id); } }
  @HostListener('document:keydown', ['$event']) onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.openSearch(); }
  }
  @HostListener('document:click', ['$event']) onDocClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (!t.closest('.app-topbar')) this.closePopups();
  }
}
