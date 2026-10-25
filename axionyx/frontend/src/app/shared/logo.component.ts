import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let seq = 0;

/**
 * Marca AXIONYX: rede de nós conectados em um hexágono — inteligência que conecta dados, pessoas e decisões.
 * Desenho próprio, vetorial (nítido em qualquer tamanho). Use <ax-logo [size]="30" /> e, para o nome ao lado, [wordmark]="true".
 */
@Component({
  selector: 'ax-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display:inline-flex;align-items:center;flex-shrink:0;line-height:0', role: 'img', '[attr.aria-label]': '"AXIONYX"' },
  template: `
  <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient [attr.id]="gid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0A3D8F"/><stop offset=".55" stop-color="#0875D1"/><stop offset="1" stop-color="#00B4D8"/></linearGradient></defs>
    <rect width="48" height="48" rx="12" [attr.fill]="'url(#' + gid + ')'"/>
    <path d="M24 9.5 36.5 16.7v14.6L24 38.5 11.5 31.3V16.7Z" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2.2" stroke-linejoin="round"/>
    <g stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M24 24V9.5M24 24l12.5 7.3M24 24l-12.5 7.3"/></g>
    <g fill="#fff"><circle cx="24" cy="24" r="4.4"/><circle cx="24" cy="9.5" r="2.8"/><circle cx="36.5" cy="31.3" r="2.8"/><circle cx="11.5" cy="31.3" r="2.8"/>
      <circle cx="36.5" cy="16.7" r="1.8" fill-opacity=".85"/><circle cx="11.5" cy="16.7" r="1.8" fill-opacity=".85"/><circle cx="24" cy="38.5" r="1.8" fill-opacity=".85"/></g>
  </svg>
  @if (wordmark()) { <span [style.margin-left.px]="size() * 0.33" [style.font-size.px]="size() * 0.56" [style.color]="color()" style="font-weight:800;letter-spacing:.06em;line-height:1">AXIONYX</span> }`,
})
export class LogoComponent {
  readonly size = input(30);
  readonly wordmark = input(false);
  readonly color = input('#172B3A');
  readonly gid = 'axg' + ++seq;
}
