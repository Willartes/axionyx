import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
}
