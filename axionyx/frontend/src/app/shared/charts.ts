import { AfterViewInit, ChangeDetectionStrategy, Component, Directive, ElementRef, OnDestroy, computed, input, signal, viewChild } from '@angular/core';

/** Gráficos SVG leves no mesmo estilo visual do AXIONYX (grade tracejada, eixos discretos, tooltip). */
const AXIS = '#647687';
const GRID = '#F0F4F8';
export type Fmt = (v: number) => string;
const defFmt: Fmt = (v) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(v);
const compact: Fmt = (v) => Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1).replace('.', ',')}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : `${Math.round(v)}`;

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : n <= 8 ? 8 : 10) * p;
}

@Directive()
abstract class Measured implements AfterViewInit, OnDestroy {
  readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  readonly width = signal(400);
  private ro?: ResizeObserver;
  ngAfterViewInit() {
    const el = this.host().nativeElement;
    this.width.set(el.clientWidth || 400);
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.width.set(el.clientWidth || 400)); this.ro.observe(el); }
  }
  ngOnDestroy() { this.ro?.disconnect(); }
}

export interface Series { name: string; color: string; values: number[]; dashed?: boolean; }

@Component({
  selector: 'ax-bar-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div #host style="position:relative;width:100%">
    <svg [attr.width]="width()" [attr.height]="height()" style="display:block">
      @for (t of ticks(); track $index) {
        <line [attr.x1]="padL" [attr.x2]="width() - 8" [attr.y1]="t.y" [attr.y2]="t.y" [attr.stroke]="grid" stroke-dasharray="3 3" />
        <text [attr.x]="padL - 6" [attr.y]="t.y + 4" text-anchor="end" font-size="11" [attr.fill]="axis">{{ t.label }}</text>
      }
      @for (b of bars(); track $index) {
        <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" [attr.fill]="b.color" rx="3" (mouseenter)="hover.set(b.i)" (mouseleave)="hover.set(-1)" style="cursor:default" />
      }
      @for (l of labels(); track $index) {
        <text [attr.x]="xCenter($index)" [attr.y]="height() - 6" text-anchor="middle" font-size="11" [attr.fill]="axis">{{ l }}</text>
      }
    </svg>
    @if (hover() >= 0) {
      <div [style.left.px]="tipX()" style="position:absolute;top:4px;transform:translateX(-50%);background:white;border:1px solid #DCE4EC;border-radius:6px;padding:6px 9px;font-size:11px;box-shadow:0 4px 12px rgba(0,0,0,.08);pointer-events:none;white-space:nowrap;z-index:2">
        <div style="font-weight:600;color:#172B3A;margin-bottom:2px">{{ labels()[hover()] }}</div>
        @for (s of series(); track s.name) { <div [style.color]="s.color">{{ s.name }}: {{ fmt()(s.values[hover()] || 0) }}</div> }
      </div>
    }
    @if (legend() && series().length > 1) {
      <div style="display:flex;gap:12px;justify-content:center;font-size:11px;color:#647687;margin-top:2px">
        @for (s of series(); track s.name) { <span style="display:flex;align-items:center;gap:4px"><span [style.background]="s.color" style="width:9px;height:9px;border-radius:2px;display:inline-block"></span>{{ s.name }}</span> }
      </div>
    }
  </div>`,
})
export class BarChartComponent extends Measured {
  readonly labels = input<string[]>([]);
  readonly series = input<Series[]>([]);
  readonly height = input(180);
  readonly legend = input(false);
  readonly fmt = input<Fmt>(defFmt);
  readonly maxBar = input(28);
  readonly hover = signal(-1);
  readonly padL = 42; readonly grid = GRID; readonly axis = AXIS;
  private max = computed(() => niceMax(Math.max(0, ...this.series().flatMap((s) => s.values))));
  readonly ticks = computed(() => { const h = this.height() - 24, m = this.max(); return [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: 8 + (h - 8) * (1 - f), label: compact(m * f) })); });
  xCenter(i: number) { const n = Math.max(1, this.labels().length); const w = (this.width() - this.padL - 8) / n; return this.padL + w * i + w / 2; }
  tipX() { return Math.min(Math.max(this.xCenter(this.hover()), 70), this.width() - 70); }
  readonly bars = computed(() => {
    const n = Math.max(1, this.labels().length), ss = this.series(), h = this.height() - 24, m = this.max();
    const slot = (this.width() - this.padL - 8) / n;
    const bw = Math.min(this.maxBar(), (slot * 0.7) / Math.max(1, ss.length));
    const out: { x: number; y: number; w: number; h: number; color: string; i: number }[] = [];
    for (let i = 0; i < n; i++) ss.forEach((s, k) => {
      const v = Math.max(0, s.values[i] || 0), bh = ((h - 8) * v) / m;
      out.push({ x: this.padL + slot * i + (slot - bw * ss.length - 2 * (ss.length - 1)) / 2 + k * (bw + 2), y: 8 + (h - 8) - bh, w: bw, h: Math.max(0, bh), color: s.color, i });
    });
    return out;
  });
}

@Component({
  selector: 'ax-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div #host style="position:relative;width:100%">
    <svg [attr.width]="width()" [attr.height]="height()" style="display:block" (mousemove)="move($event)" (mouseleave)="hover.set(-1)">
      <defs>
        @for (s of series(); track s.name) {
          <linearGradient [attr.id]="gid + $index" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" [attr.stop-color]="s.color" stop-opacity="0.15" /><stop offset="95%" [attr.stop-color]="s.color" stop-opacity="0" /></linearGradient>
        }
      </defs>
      @for (t of ticks(); track $index) {
        <line [attr.x1]="padL" [attr.x2]="width() - 8" [attr.y1]="t.y" [attr.y2]="t.y" [attr.stroke]="grid" stroke-dasharray="3 3" />
        <text [attr.x]="padL - 6" [attr.y]="t.y + 4" text-anchor="end" font-size="11" [attr.fill]="axis">{{ t.label }}</text>
      }
      @if (band(); as b) { <path [attr.d]="b" fill="#00A6D6" fill-opacity="0.12" /> }
      @for (p of paths(); track $index) {
        @if (area() && !p.dashed) { <path [attr.d]="p.area" [attr.fill]="'url(#' + gid + $index + ')'" /> }
        <path [attr.d]="p.line" fill="none" [attr.stroke]="p.color" stroke-width="2" [attr.stroke-dasharray]="p.dashed ? '5 4' : null" />
      }
      @for (l of labels(); track $index) {
        @if (showLabel($index)) { <text [attr.x]="x($index)" [attr.y]="height() - 6" text-anchor="middle" font-size="11" [attr.fill]="axis">{{ l }}</text> }
      }
      @if (hover() >= 0) { <line [attr.x1]="x(hover())" [attr.x2]="x(hover())" y1="8" [attr.y2]="height() - 24" stroke="#DCE4EC" /> }
    </svg>
    @if (hover() >= 0) {
      <div [style.left.px]="tipX()" style="position:absolute;top:4px;transform:translateX(-50%);background:white;border:1px solid #DCE4EC;border-radius:6px;padding:6px 9px;font-size:11px;box-shadow:0 4px 12px rgba(0,0,0,.08);pointer-events:none;white-space:nowrap;z-index:2">
        <div style="font-weight:600;color:#172B3A;margin-bottom:2px">{{ labels()[hover()] }}</div>
        @for (s of series(); track s.name) { @if (s.values[hover()] !== null && s.values[hover()] !== undefined) { <div [style.color]="s.color">{{ s.name }}: {{ fmt()(s.values[hover()]) }}</div> } }
      </div>
    }
    @if (legend() && series().length > 1) {
      <div style="display:flex;gap:12px;justify-content:center;font-size:11px;color:#647687">
        @for (s of series(); track s.name) { <span style="display:flex;align-items:center;gap:4px"><span [style.background]="s.color" style="width:10px;height:3px;display:inline-block"></span>{{ s.name }}</span> }
      </div>
    }
  </div>`,
})
export class LineChartComponent extends Measured {
  readonly labels = input<string[]>([]);
  readonly series = input<Series[]>([]);
  readonly height = input(180);
  readonly area = input(true);
  readonly legend = input(false);
  readonly fmt = input<Fmt>(defFmt);
  /** Faixa de confiança opcional: [low[], high[]] */
  readonly bandValues = input<[(number | null)[], (number | null)[]] | null>(null);
  readonly hover = signal(-1);
  readonly gid = 'g' + Math.random().toString(36).slice(2, 8);
  readonly padL = 42; readonly grid = GRID; readonly axis = AXIS;
  private max = computed(() => niceMax(Math.max(0, ...this.series().flatMap((s) => s.values.filter((v) => v !== null && v !== undefined) as number[]), ...(this.bandValues()?.[1].filter((v) => v !== null) as number[] ?? []))));
  readonly ticks = computed(() => { const h = this.height() - 24, m = this.max(); return [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: 8 + (h - 8) * (1 - f), label: compact(m * f) })); });
  x(i: number) { const n = Math.max(2, this.labels().length); return this.padL + ((this.width() - this.padL - 14) * i) / (n - 1); }
  y(v: number) { const h = this.height() - 24; return 8 + (h - 8) * (1 - v / this.max()); }
  showLabel(i: number) { const n = this.labels().length; const step = Math.ceil(n / Math.max(2, Math.floor(this.width() / 60))); return i % step === 0 || i === n - 1; }
  tipX() { return Math.min(Math.max(this.x(this.hover()), 70), this.width() - 70); }
  move(ev: MouseEvent) {
    const n = this.labels().length; if (!n) return;
    const rel = (ev.offsetX - this.padL) / (this.width() - this.padL - 14);
    this.hover.set(Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1)))));
  }
  readonly paths = computed(() => this.series().map((s) => {
    const pts = s.values.map((v, i) => (v === null || v === undefined ? null : [this.x(i), this.y(v)] as [number, number]));
    const valid = pts.filter(Boolean) as [number, number][];
    const line = valid.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const base = this.y(0);
    const area = valid.length ? `${line} L${valid[valid.length - 1][0].toFixed(1)},${base} L${valid[0][0].toFixed(1)},${base} Z` : '';
    return { line, area, color: s.color, dashed: !!s.dashed };
  }));
  readonly band = computed(() => {
    const b = this.bandValues(); if (!b) return null;
    const hi = b[1].map((v, i) => (v === null ? null : [this.x(i), this.y(v)])).filter(Boolean) as number[][];
    const lo = b[0].map((v, i) => (v === null ? null : [this.x(i), this.y(v)])).filter(Boolean) as number[][];
    if (!hi.length) return null;
    return 'M' + hi.map((p) => `${p[0]},${p[1]}`).join(' L') + ' L' + lo.reverse().map((p) => `${p[0]},${p[1]}`).join(' L') + ' Z';
  });
}

@Component({
  selector: 'ax-donut',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 100 100" style="flex-shrink:0">
      @for (a of arcs(); track $index) { <path [attr.d]="a.d" [attr.fill]="a.color"><title>{{ a.label }}: {{ fmt()(a.value) }}</title></path> }
      <circle cx="50" cy="50" r="28" fill="white" />
    </svg>
    <div style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:120px">
      @for (a of arcs(); track $index) {
        <div style="display:flex;align-items:center;gap:8px;font-size:12px">
          <span [style.background]="a.color" style="width:9px;height:9px;border-radius:50%;flex-shrink:0"></span>
          <span style="flex:1;color:#172B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ a.label }}</span>
          <span style="color:#647687;font-family:'JetBrains Mono',monospace;font-size:11px">{{ a.pct }}%</span>
        </div>
      }
    </div>
  </div>`,
})
export class DonutComponent {
  readonly data = input<{ label: string; value: number; color?: string }[]>([]);
  readonly size = input(120);
  readonly fmt = input<Fmt>(defFmt);
  static readonly PALETTE = ['#0875D1', '#00A6D6', '#18864B', '#D99000', '#C93636', '#2878C7', '#647687', '#8E6BBF'];
  readonly arcs = computed(() => {
    const d = this.data().filter((x) => x.value > 0); const total = d.reduce((s, x) => s + x.value, 0) || 1;
    let a0 = -Math.PI / 2;
    return d.map((x, i) => {
      const frac = x.value / total, a1 = a0 + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const p = (a: number, r: number) => [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
      const [x0, y0] = p(a0, 46), [x1, y1] = p(a1 - (frac === 1 ? 0.0001 : 0), 46);
      const dpath = `M50,50 L${x0},${y0} A46,46 0 ${large} 1 ${x1},${y1} Z`;
      a0 = a1;
      return { d: dpath, color: x.color || DonutComponent.PALETTE[i % DonutComponent.PALETTE.length], label: x.label, value: x.value, pct: (frac * 100).toFixed(1).replace('.', ',') };
    });
  });
}

/** Barra horizontal simples (ranking) no padrão do "Top 5 Produtos" original. */
@Component({
  selector: 'ax-rank',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div style="display:flex;flex-direction:column;gap:10px">
    @for (r of rows(); track $index) {
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;gap:8px">
          <span style="font-size:12px;color:#172B3A;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ r.label }}</span>
          <span style="font-size:12px;font-weight:600;color:#172B3A;font-family:'JetBrains Mono',monospace">{{ fmt()(r.value) }}</span>
        </div>
        <div style="height:4px;background:#F0F4F8;border-radius:2px"><div [style.width.%]="r.pct" [style.background]="$index === 0 ? '#0875D1' : '#00A6D6'" [style.opacity]="1 - $index * 0.12" style="height:100%;border-radius:2px"></div></div>
      </div>
    } @empty { <div class="empty-state" style="padding:20px">Sem dados no período.</div> }
  </div>`,
})
export class RankComponent {
  readonly data = input<{ label: string; value: number }[]>([]);
  readonly fmt = input<Fmt>(defFmt);
  readonly rows = computed(() => { const d = this.data(); const m = Math.max(1, ...d.map((x) => x.value)); return d.map((x) => ({ ...x, pct: (x.value / m) * 100 })); });
}

export const CHARTS = [BarChartComponent, LineChartComponent, DonutComponent, RankComponent];
