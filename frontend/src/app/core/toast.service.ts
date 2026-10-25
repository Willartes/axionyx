import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string; }

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly items = signal<Toast[]>([]);
  private seq = 0;
  show(text: string, kind: Toast['kind'] = 'info', ms = 4500) {
    const id = ++this.seq;
    this.items.update((l) => [...l, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
  success(t: string) { this.show(t, 'success'); }
  info(t: string) { this.show(t, 'info'); }
  warning(t: string) { this.show('⚠ ' + t, 'info', 6000); }
  error(t: string | unknown) { this.show(typeof t === 'string' ? t : (t as any)?.message || 'Erro inesperado.', 'error', 7000); }
  dismiss(id: number) { this.items.update((l) => l.filter((t) => t.id !== id)); }
}
