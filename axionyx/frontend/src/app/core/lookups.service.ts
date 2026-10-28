import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api.service';

export interface Lookups {
  brands: { id: string; name: string }[]; collections: { id: string; name: string; season: string; year: number }[];
  categories: { id: string; name: string }[]; sizes: { id: string; grid: string; code: string; sort: number }[];
  colors: { id: string; name: string; hex: string; code: string }[]; suppliers: { id: string; name: string; cnpj: string }[];
  paymentMethods: { id: string; name: string; kind: string; max_installments: number; fee_pct: number; settlement_days: number }[];
  sellers: { id: string; name: string; commission_pct: number | null }[]; branches: { id: string; code: string; name: string }[];
  accounts: { id: string; name: string; type: string; branch_id: string | null }[]; finCategories: { id: string; code: string; name: string; type: string; dre_group: string }[];
  professionals: { id: string; name: string; color: string; user_id: string | null; specialty: string | null; council_id?: string | null; restrict_records?: boolean }[];
}

/** Cache dos cadastros auxiliares usados em formulários (recarregado a cada 5 minutos ou sob demanda). */
@Injectable({ providedIn: 'root' })
export class LookupsService {
  private api = inject(Api);
  readonly data = signal<Lookups | null>(null);
  private at = 0; private pending: Promise<Lookups> | null = null;
  async ensure(force = false): Promise<Lookups> {
    if (!force && this.data() && Date.now() - this.at < 5 * 60_000) return this.data()!;
    if (!this.pending) this.pending = this.api.get<Lookups>('/lookups').then((d) => { this.data.set(d); this.at = Date.now(); return d; }).finally(() => (this.pending = null));
    return this.pending;
  }
  invalidate() { this.at = 0; }
}
