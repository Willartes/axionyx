import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from './api.service';

export type Stage = 'mfa' | 'context' | 'full';
export interface Me {
  user: { id: string; name: string; email: string; mfa_enabled: boolean; is_superadmin: boolean; role: string; isSeller: boolean; maxDiscountPct: number; allBranches: boolean; last_login_at?: string };
  company: { id: string; name: string; trade_name: string | null; cnpj: string | null; color: string; is_demo: boolean; modules: string[]; tax_regime: string; segment?: string };
  segment?: { id: string; name: string; short: string; icon: string; terms: Record<string, string>; units: string[]; defaultUnit: string };
  branch: { id: string; code: string; name: string; cnpj: string | null };
  branches: { id: string; code: string; name: string }[];
  companies: { id: string; name: string; trade_name: string | null; cnpj: string | null; color: string; role: string; is_demo: boolean }[];
  permissions: string[];
  settings: any;
}

const KEY = 'axionyx.session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(Api);
  private router = inject(Router);
  private session = signal<{ token: string; stage: Stage; remember: boolean } | null>(this.restore());
  readonly me = signal<Me | null>(null);
  readonly pendingUser = signal<{ name: string; email: string } | null>(null);
  readonly maskedEmail = signal<string>('');
  readonly companies = signal<Me['companies']>([]);
  readonly selectedCompany = signal<Me['companies'][number] | null>(null);
  readonly token = computed(() => this.session()?.token ?? null);
  readonly stage = computed(() => this.session()?.stage ?? null);
  readonly permissions = computed(() => new Set(this.me()?.permissions ?? []));
  readonly modules = computed(() => new Set(this.me()?.company?.modules ?? []));
  /** Módulo ativo na empresa (inclui os recursos do segmento: grade, peso, validade, embalagens, combos, maioridade...). */
  has(mod: string): boolean { return this.modules().has(mod); }
  /** Vocabulário do segmento (ex.: "Coleção", "Lote/safra"). */
  term(key: string, fallback?: string): string { return this.me()?.segment?.terms?.[key] ?? fallback ?? key; }

  private restore() {
    try {
      const raw = sessionStorage.getItem(KEY) || localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  private persist(token: string, stage: Stage, remember: boolean) {
    const v = { token, stage, remember };
    this.session.set(v);
    try {
      sessionStorage.removeItem(KEY); localStorage.removeItem(KEY);
      (remember && stage === 'full' ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(v));
    } catch { /* armazenamento indisponível: sessão só em memória */ }
  }
  clear() {
    this.session.set(null); this.me.set(null);
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch { /* */ }
  }

  can(perm: string | string[]): boolean {
    const p = this.permissions();
    if (p.has('*')) return true;
    return (Array.isArray(perm) ? perm : [perm]).some((x) => p.has(x));
  }

  async login(email: string, password: string, remember: boolean): Promise<{ mfaRequired: boolean }> {
    const r = await this.api.post<any>('/auth/login', { email, password });
    this.persist(r.token, r.mfaRequired ? 'mfa' : 'context', remember);
    if (r.mfaRequired) { this.maskedEmail.set(r.maskedEmail || ''); return { mfaRequired: true }; }
    this.pendingUser.set(r.user); this.companies.set(r.companies);
    return { mfaRequired: false };
  }
  async verifyMfa(code: string) {
    const r = await this.api.post<any>('/auth/mfa', { code });
    this.persist(r.token, 'context', this.session()?.remember ?? false);
    this.pendingUser.set(r.user); this.companies.set(r.companies);
  }
  async loadCompanies() { const c = await this.api.get<Me['companies']>('/auth/companies'); this.companies.set(c); return c; }
  branchesOf(companyId: string) { return this.api.get<{ id: string; code: string; name: string; cnpj: string | null; address: any }[]>(`/auth/companies/${companyId}/branches`); }
  async enterContext(companyId: string, branchId: string) {
    const path = this.stage() === 'full' ? '/auth/switch' : '/auth/context';
    const r = await this.api.post<any>(path, { companyId, branchId });
    this.persist(r.token, 'full', this.session()?.remember ?? false);
    await this.loadMe();
  }
  async loadMe() { const me = await this.api.get<Me>('/auth/me'); this.me.set(me); return me; }
  async logout() {
    try { if (this.stage() === 'full') await this.api.post('/auth/logout'); } catch { /* sessão já expirada */ }
    this.clear();
    this.router.navigateByUrl('/login');
  }
}
