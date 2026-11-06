import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { ToastService } from './core/toast.service';
import { IconComponent } from './shared/icon.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <router-outlet />
    <div class="toast-host" aria-live="polite">
      @for (t of toast.items(); track t.id) {
        <div class="toast" [class]="'toast ' + t.kind" role="status">
          <ax-icon [name]="t.kind === 'success' ? 'check-circle-2' : t.kind === 'error' ? 'alert-triangle' : 'info'" [size]="15" [color]="t.kind === 'success' ? '#4CC38A' : t.kind === 'error' ? '#F28B82' : '#00A6D6'" />
          <span style="flex:1">{{ t.text }}</span>
          <button (click)="toast.dismiss(t.id)" style="background:none;border:none;color:#A8BCCF;cursor:pointer" aria-label="Fechar"><ax-icon name="x" [size]="13" /></button>
        </div>
      }
    </div>
  `,
})
export class App {
  readonly toast = inject(ToastService);
  constructor() {
    if (isPlatformBrowser(inject(PLATFORM_ID))) mobileTables(inject(DestroyRef));
  }
}

/**
 * Tabelas no celular: copia o título de cada coluna para as células (data-label) para que o CSS
 * mostre cada linha como um cartão (rótulo: valor) em telas estreitas. Tabelas com menos de 4 colunas
 * ou marcadas com .no-cards continuam como tabela com rolagem horizontal.
 */
function mobileTables(destroy: DestroyRef) {
  let pending = false;
  const run = () => {
    pending = false;
    document.querySelectorAll<HTMLTableElement>('table.data-table:not(.no-cards)').forEach((t) => {
      const heads = Array.from(t.querySelectorAll<HTMLTableCellElement>('thead tr:last-child th')).map((th) => (th.textContent || '').trim());
      t.classList.toggle('m-cards', heads.length >= 4);
      if (heads.length < 4) return;
      t.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr) => {
        let i = 0;
        for (const td of Array.from(tr.children) as HTMLTableCellElement[]) {
          const label = heads[i] ?? '';
          if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
          i += td.colSpan || 1;
        }
        tr.classList.toggle('m-full', tr.children.length === 1);
      });
    });
  };
  const obs = new MutationObserver(() => { if (!pending) { pending = true; requestAnimationFrame(run); } });
  obs.observe(document.body, { childList: true, subtree: true });
  destroy.onDestroy(() => obs.disconnect());
}
