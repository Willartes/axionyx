import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { ICONS } from './icons';

/**
 * Ícones Lucide (ISC License — https://lucide.dev) incorporados como SVG,
 * mantendo a mesma iconografia do layout original do AXIONYX.
 */
@Component({
  selector: 'ax-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display:inline-flex;flex-shrink:0;line-height:0', '[innerHTML]': 'svg()', '[attr.aria-hidden]': 'true' },
  template: '',
})
export class IconComponent {
  private sanitizer = inject(DomSanitizer);
  readonly name = input.required<string>();
  readonly size = input<number>(16);
  readonly color = input<string>('currentColor');
  readonly stroke = input<number>(2);
  readonly svg = computed(() => {
    const body = ICONS[this.name()] ?? ICONS['circle'] ?? '';
    const s = this.size();
    return this.sanitizer.bypassSecurityTrustHtml(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${this.color()}" stroke-width="${this.stroke()}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`);
  });
}
