import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Gera barras EAN-13 (ou Code 128-B para códigos não numéricos) como SVG — sem dependências externas. */
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13Bits(code: string): string | null {
  if (!/^\d{13}$/.test(code)) return null;
  const d = code.split('').map(Number);
  const check = (10 - (d.slice(0, 12).reduce((s, n, i) => s + n * (i % 2 ? 3 : 1), 0) % 10)) % 10;
  if (check !== d[12]) return null;
  let bits = '101';
  const par = PARITY[d[0]];
  for (let i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? L : G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]];
  return bits + '101';
}

const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
export function code128Bits(text: string): string {
  const codes = [104]; // Start B
  for (const ch of text) { const c = ch.charCodeAt(0) - 32; codes.push(c >= 0 && c < 95 ? c : 0); }
  const sum = codes.reduce((s, c, i) => s + c * (i === 0 ? 1 : i), 0);
  codes.push(sum % 103, 106);
  let bits = '';
  for (const c of codes) { const pat = C128[c]; pat.split('').forEach((w, i) => (bits += (i % 2 ? '0' : '1').repeat(+w))); }
  return bits;
}

@Component({
  selector: 'ax-barcode',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <svg [attr.width]="w()" [attr.height]="height() + (showText() ? 12 : 0)" [attr.viewBox]="'0 0 ' + bits().length + ' ' + (height() + (showText() ? 12 : 0))" preserveAspectRatio="none" style="display:block">
    @for (r of rects(); track $index) { <rect [attr.x]="r[0]" y="0" [attr.width]="r[1]" [attr.height]="height()" fill="#000" /> }
    @if (showText()) { <text [attr.x]="bits().length / 2" [attr.y]="height() + 10" text-anchor="middle" font-size="9" font-family="monospace" lengthAdjust="spacingAndGlyphs" [attr.textLength]="bits().length * 0.9">{{ value() }}</text> }
  </svg>`,
})
export class BarcodeComponent {
  readonly value = input.required<string>();
  readonly height = input(40);
  readonly width = input<number | null>(null);
  readonly showText = input(true);
  readonly bits = computed(() => ean13Bits(this.value()) ?? code128Bits(this.value()));
  readonly w = computed(() => this.width() ?? this.bits().length * 1.4);
  readonly rects = computed(() => {
    const b = this.bits(); const out: [number, number][] = [];
    let i = 0;
    while (i < b.length) { if (b[i] === '1') { let j = i; while (j < b.length && b[j] === '1') j++; out.push([i, j - i]); i = j; } else i++; }
    return out;
  });
}
