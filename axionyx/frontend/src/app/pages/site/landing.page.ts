import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, effect, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { DOCUMENT } from '@angular/common';
import { LogoComponent } from '../../shared/logo.component';
import { IconComponent } from '../../shared/icon.component';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

/**
 * Site institucional (www.axionyxerp.com.br). Página pública: apresenta o AXIONYX, destaca as ferramentas
 * de inteligência para vender mais e capta contatos para demonstração (sem teste grátis).
 * As imagens são telas reais do sistema com dados fictícios da empresa de demonstração.
 */
@Component({
  selector: 'ax-landing',
  imports: [LogoComponent, FormsModule, RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display:block; background:#fff; color:#172B3A; font-family:Inter, system-ui, sans-serif; overflow-x:hidden; }
    a { color:inherit; text-decoration:none; }
    .wrap { max-width:1180px; margin:0 auto; padding:0 24px; }
    /* header */
    .top { position:sticky; top:0; z-index:80; background:rgba(11,31,51,.92); backdrop-filter:saturate(1.4) blur(10px); border-bottom:1px solid rgba(255,255,255,.06); }
    .top .wrap { display:flex; align-items:center; gap:28px; height:68px; }
    .brand { display:flex; align-items:center; gap:10px; color:#fff; font-weight:800; font-size:19px; letter-spacing:.02em; }
    .nav { display:flex; gap:22px; flex:1; }
    .nav a { color:#B8C7D6; font-size:14px; font-weight:500; transition:color .15s; }
    .nav a:hover { color:#fff; }
    .top-cta { display:flex; align-items:center; gap:10px; margin-left:auto; }
    .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; border-radius:10px; font-weight:600; font-size:15px; padding:13px 22px; cursor:pointer; border:1px solid transparent; transition:transform .12s, box-shadow .15s, background .15s; white-space:nowrap; }
    .btn:hover { transform:translateY(-1px); }
    .btn-blue { background:#0875D1; color:#fff; box-shadow:0 8px 24px rgba(8,117,209,.35); }
    .btn-blue:hover { background:#0A6BBF; }
    .btn-ghost-light { color:#fff; border-color:rgba(255,255,255,.22); background:rgba(255,255,255,.04); }
    .btn-ghost-light:hover { background:rgba(255,255,255,.1); }
    .btn-sm { padding:9px 15px; font-size:13.5px; border-radius:9px; }
    .app-link { color:#fff; font-weight:700; font-size:14px; padding:9px 14px; border-radius:9px; border:1px solid rgba(0,166,214,.55); background:rgba(0,166,214,.12); display:inline-flex; align-items:center; gap:7px; }
    .app-link:hover { background:rgba(0,166,214,.24); }
    .burger { display:none; width:42px; height:42px; align-items:center; justify-content:center; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14); border-radius:11px; color:#fff; cursor:pointer; transition:background .15s; }
    .burger:hover, .burger.on { background:rgba(0,166,214,.18); border-color:rgba(0,166,214,.5); }
    /* menu lateral (mobile/tablet) */
    .drawer { display:none; }
    /* hero */
    .hero { background:#0B1F33; color:#fff; position:relative; overflow:hidden; padding:84px 0 0; }
    .hero:before { content:''; position:absolute; inset:0; background:radial-gradient(900px 500px at 15% 10%, rgba(8,117,209,.28), transparent 60%), radial-gradient(700px 420px at 90% 0%, rgba(0,166,214,.18), transparent 60%); }
    .hero .wrap { position:relative; }
    .eyebrow { display:inline-flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:#7FD3EE; background:rgba(0,166,214,.12); border:1px solid rgba(0,166,214,.3); padding:6px 12px; border-radius:999px; }
    .hero h1 { font-size:48px; line-height:1.06; font-weight:800; letter-spacing:-.025em; margin:20px 0 18px; max-width:880px; }
    .hero h1 em { font-style:normal; background:linear-gradient(90deg,#3FA9F5,#00D1E0); -webkit-background-clip:text; background-clip:text; color:transparent; }
    .hero p.lead { font-size:19px; line-height:1.6; color:#B8C7D6; max-width:720px; }
    .hero-ctas { display:flex; gap:12px; margin:30px 0 22px; flex-wrap:wrap; }
    .checks { display:flex; gap:22px; flex-wrap:wrap; color:#D5E1EC; font-size:14px; }
    .checks span { display:inline-flex; align-items:center; gap:7px; }
    .hero-shot { position:relative; margin:56px auto 0; max-width:1080px; }
    .browser { border-radius:14px 14px 0 0; overflow:hidden; background:#fff; box-shadow:0 -10px 60px rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.12); border-bottom:0; }
    .browser-bar { height:34px; background:#EEF2F6; display:flex; align-items:center; gap:7px; padding:0 14px; }
    .browser-bar i { width:10px; height:10px; border-radius:50%; background:#DCE4EC; display:block; }
    .browser-bar span { margin-left:12px; font-size:11.5px; color:#647687; background:#fff; border-radius:6px; padding:3px 12px; }
    .browser img { display:block; width:100%; height:auto; }
    .float-card { position:absolute; background:#fff; color:#172B3A; border-radius:12px; padding:12px 14px; box-shadow:0 18px 40px rgba(11,31,51,.28); font-size:12.5px; display:flex; gap:10px; align-items:center; animation:floaty 6s ease-in-out infinite; }
    .float-card b { display:block; font-size:14px; }
    .float-card .ic { width:34px; height:34px; border-radius:9px; display:flex; align-items:center; justify-content:center; }
    .fc1 { left:-34px; top:22%; } .fc2 { right:-30px; top:12%; animation-delay:1.5s; } .fc3 { right:-18px; bottom:16%; animation-delay:3s; }
    @keyframes floaty { 0%,100% { transform:translateY(0) } 50% { transform:translateY(-8px) } }
    /* sections */
    section { padding:96px 0; }
    .kicker { font-size:13px; font-weight:700; color:#0875D1; text-transform:uppercase; letter-spacing:.08em; }
    h2 { font-size:38px; line-height:1.15; letter-spacing:-.02em; font-weight:800; margin:10px 0 14px; color:#0B1F33; }
    .sub { font-size:17.5px; line-height:1.65; color:#4A5D70; max-width:760px; }
    .center { text-align:center; } .center .sub { margin:0 auto; }
    .grid { display:grid; gap:18px; }
    .g4 { grid-template-columns:repeat(4, minmax(0,1fr)); } .g3 { grid-template-columns:repeat(3, minmax(0,1fr)); } .g2 { grid-template-columns:repeat(2, minmax(0,1fr)); }
    .card { background:#fff; border:1px solid #E3EAF1; border-radius:16px; padding:24px; transition:box-shadow .2s, transform .2s, border-color .2s; }
    .card:hover { box-shadow:0 18px 40px rgba(11,31,51,.08); transform:translateY(-2px); border-color:#CFE0F0; }
    .card h3 { font-size:17px; font-weight:700; margin:14px 0 8px; color:#0B1F33; }
    .card p { font-size:14.5px; line-height:1.6; color:#4A5D70; margin:0; }
    .ico { width:44px; height:44px; border-radius:12px; display:flex; align-items:center; justify-content:center; background:#E8F2FB; color:#0875D1; }
    .pain { background:#F6F9FC; }
    .pain .card { background:#fff; }
    .pain .tag { font-size:12px; font-weight:700; color:#C93636; text-transform:uppercase; letter-spacing:.05em; }
    .pain .fix { margin-top:12px; font-size:13.5px; color:#18864B; font-weight:600; display:flex; gap:6px; align-items:flex-start; }
    /* intelligence */
    .intel { background:linear-gradient(180deg,#0B1F33 0%, #0E2A45 100%); color:#fff; }
    .intel h2, .intel .card h3 { color:#fff; }
    .intel .sub, .intel .card p { color:#B8C7D6; }
    .intel .kicker { color:#7FD3EE; }
    .intel .card { background:rgba(255,255,255,.04); border-color:rgba(255,255,255,.09); }
    .intel .card:hover { background:rgba(255,255,255,.07); border-color:rgba(0,166,214,.4); box-shadow:none; }
    .intel .ico { background:rgba(0,166,214,.14); color:#4FC3E8; }
    .showcase { margin-top:56px; display:grid; grid-template-columns:340px minmax(0,1fr); gap:28px; align-items:start; }
    .tabs { display:flex; flex-direction:column; gap:8px; }
    .tab { text-align:left; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); color:#D5E1EC; border-radius:12px; padding:14px 16px; cursor:pointer; transition:all .15s; font:inherit; }
    .tab b { display:flex; align-items:center; gap:8px; font-size:15px; color:#fff; }
    .tab span { display:block; font-size:13px; color:#9FB3C8; margin-top:4px; line-height:1.5; }
    .tab.on { background:rgba(8,117,209,.22); border-color:#3FA9F5; }
    .shot-frame { border-radius:14px; overflow:hidden; border:1px solid rgba(255,255,255,.14); box-shadow:0 30px 70px rgba(0,0,0,.4); background:#fff; }
    .shot-frame img { width:100%; height:auto; display:block; }
    .shot-bullets { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
    .shot-bullets span { font-size:13px; color:#D5E1EC; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.1); padding:6px 11px; border-radius:999px; display:inline-flex; gap:6px; align-items:center; }
    .caption { font-size:12px; color:#7E93A8; margin-top:10px; }
    /* feature rows */
    .row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.15fr); gap:56px; align-items:center; margin-top:72px; }
    .row.rev > :first-child { order:2; }
    .row h3 { font-size:28px; font-weight:800; letter-spacing:-.015em; margin:8px 0 12px; color:#0B1F33; line-height:1.2; }
    .row p { font-size:16px; line-height:1.7; color:#4A5D70; }
    .row ul { list-style:none; padding:0; margin:18px 0 0; display:grid; gap:10px; }
    .row li { display:flex; gap:10px; font-size:15px; color:#233A50; line-height:1.5; }
    .row li ax-icon { margin-top:2px; }
    .row img { width:100%; height:auto; display:block; border-radius:14px; border:1px solid #E3EAF1; box-shadow:0 24px 60px rgba(11,31,51,.12); }
    /* segments */
    .seg { background:#F6F9FC; }
    .seg .card { display:flex; flex-direction:column; }
    .seg .card ul { margin:14px 0 0; padding:0; list-style:none; display:grid; gap:7px; }
    .seg .card li { font-size:13.5px; color:#33495E; display:flex; gap:7px; }
    .seg .badge { font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; background:#E3F6EC; color:#18864B; align-self:flex-start; }
    .seg .badge.soon { background:#FFF4E0; color:#B26A00; }
    /* trust */
    .trust .card { text-align:left; }
    /* steps */
    .steps { counter-reset:s; }
    .step { position:relative; padding-left:64px; }
    .step:before { counter-increment:s; content:counter(s); position:absolute; left:0; top:0; width:44px; height:44px; border-radius:12px; background:#0B1F33; color:#fff; font-weight:800; display:flex; align-items:center; justify-content:center; font-size:18px; }
    .step h3 { margin-top:0; }
    /* faq */
    .faq { max-width:860px; margin:40px auto 0; }
    .q { border-bottom:1px solid #E3EAF1; }
    .q button { width:100%; text-align:left; background:none; border:0; padding:20px 4px; font:inherit; font-size:16.5px; font-weight:600; color:#0B1F33; display:flex; justify-content:space-between; align-items:center; gap:16px; cursor:pointer; }
    .q .a { font-size:15px; line-height:1.7; color:#4A5D70; padding:0 4px 20px; }
    .q ax-icon { transition:transform .2s; }
    .q.open ax-icon { transform:rotate(180deg); }
    /* contact */
    .contact { background:#0B1F33; color:#fff; position:relative; overflow:hidden; }
    .contact:before { content:''; position:absolute; inset:0; background:radial-gradient(700px 400px at 85% 20%, rgba(8,117,209,.3), transparent 60%); }
    .contact .wrap { position:relative; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:56px; align-items:start; }
    .contact h2 { color:#fff; } .contact .sub { color:#B8C7D6; }
    .contact .bul { margin-top:24px; display:grid; gap:12px; }
    .contact .bul div { display:flex; gap:10px; color:#D5E1EC; font-size:15px; }
    .form { background:#fff; color:#172B3A; border-radius:18px; padding:28px; box-shadow:0 30px 70px rgba(0,0,0,.35); }
    .form h3 { margin:0 0 4px; font-size:20px; color:#0B1F33; }
    .form .f2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .form label { display:block; font-size:12px; font-weight:600; color:#4A5D70; margin:12px 0 5px; }
    .form input, .form select, .form textarea { width:100%; box-sizing:border-box; border:1px solid #D5DEE7; border-radius:10px; padding:11px 12px; font:inherit; font-size:14.5px; color:#172B3A; background:#fff; }
    .form input:focus, .form select:focus, .form textarea:focus { outline:2px solid rgba(8,117,209,.25); border-color:#0875D1; }
    .form .hp { position:absolute; left:-9999px; }
    .ok { background:#E3F6EC; color:#18864B; border-radius:12px; padding:18px; font-size:15px; line-height:1.6; display:flex; gap:10px; }
    .err { color:#C93636; font-size:13px; margin-top:10px; }
    footer { background:#081726; color:#8EA3B8; padding:44px 0 28px; font-size:13.5px; }
    footer .wrap { display:flex; justify-content:space-between; gap:24px; flex-wrap:wrap; }
    footer a:hover { color:#fff; }
    .reveal { opacity:0; transform:translateY(18px); transition:opacity .6s ease, transform .6s ease; }
    .reveal.in { opacity:1; transform:none; }
    @media (max-width: 1080px) {
      .nav { display:none; } .burger { display:inline-flex; }
      .top-cta .app-link, .top-cta .btn { display:none; }
      .drawer { display:flex; flex-direction:column; position:fixed; top:68px; left:0; right:0; bottom:0; z-index:75; overflow-y:auto; overscroll-behavior:contain;
        background:radial-gradient(520px 320px at 85% 0%, rgba(0,166,214,.22), transparent 65%), linear-gradient(180deg, #0B1F33 0%, #0B2D4C 55%, #0A3A5F 100%);
        padding:18px 20px calc(20px + env(safe-area-inset-bottom)); opacity:0; visibility:hidden; transform:translateY(-10px); transition:opacity .22s ease, transform .22s ease, visibility 0s .22s; }
      .drawer.open { opacity:1; visibility:visible; transform:none; transition:opacity .22s ease, transform .22s ease; }
      .drawer-nav { display:flex; flex-direction:column; gap:4px; max-width:520px; width:100%; margin:0 auto; }
      .drawer-nav a { display:flex; align-items:center; gap:14px; color:#DCE7F1; font-size:16px; font-weight:600; padding:13px 14px; border-radius:12px; transition:background .15s; }
      .drawer-nav a:hover, .drawer-nav a:active { background:rgba(255,255,255,.06); }
      .drawer-nav a .ic { width:36px; height:36px; border-radius:10px; display:grid; place-items:center; background:rgba(0,166,214,.12); color:#7FD3EE; flex:none; }
      .drawer-nav a .chev { margin-left:auto; color:#5D7A93; }
      .drawer-nav a.demo { margin-top:12px; justify-content:center; border:1px solid rgba(0,166,214,.55); background:rgba(0,166,214,.1); color:#fff; box-shadow:0 0 0 4px rgba(0,166,214,.06); }
      .drawer-brand { margin-top:auto; padding:34px 0 22px; display:flex; flex-direction:column; align-items:center; gap:10px; text-align:center; }
      .drawer-brand .name { display:flex; align-items:center; gap:12px; color:#fff; font-size:28px; font-weight:800; letter-spacing:.06em; }
      .drawer-brand small { color:#8EA9C1; font-size:13px; }
      .drawer-foot { border-top:1px solid rgba(255,255,255,.1); padding-top:16px; max-width:520px; width:100%; margin:0 auto; }
      .drawer-foot .btn { width:100%; padding:14px 20px; font-size:16px; }
      .g4 { grid-template-columns:repeat(2, minmax(0,1fr)); } .g3 { grid-template-columns:repeat(2, minmax(0,1fr)); }
      .showcase { grid-template-columns:1fr; } .tabs { flex-direction:row; overflow-x:auto; } .tab { min-width:220px; }
      .float-card { display:none; }
    }
    .swipe-hint, .m-cta, .m-only { display:none; }
    @media (min-width: 761px) and (max-width: 1080px) {
      .grid.swipe { display:flex !important; overflow-x:auto; scroll-snap-type:x mandatory; gap:16px; margin-left:-24px !important; margin-right:-24px !important; padding:2px 24px 14px; scrollbar-width:none; }
      .grid.swipe::-webkit-scrollbar { display:none; }
      .grid.swipe > * { flex:0 0 44%; scroll-snap-align:start; }
      .grid.swipe .reveal { opacity:1; transform:none; }
      .grid.swipe + .swipe-hint, .rows + .swipe-hint { display:none; }
      section { padding:72px 0; }
    }
    @media (max-width: 760px) {
      .wrap { padding:0 16px; }
      .top .wrap { height:58px; gap:12px; } .brand { font-size:17px; } .brand ax-logo { transform:scale(.9); }
      .drawer { top:58px; }
      .burger { width:40px; height:40px; }
      .app-link { padding:7px 11px; font-size:13px; }
      .top-cta .btn { display:none; }
      /* hero enxuto */
      .hero { padding-top:34px; }
      .eyebrow { font-size:11.5px; padding:5px 10px; }
      .hero h1 { font-size:30px; line-height:1.12; margin:14px 0 12px; }
      .hero p.lead { font-size:15.5px; line-height:1.55; }
      .d-only { display:none; }
      .hero-ctas { flex-direction:column; gap:10px; margin:22px 0 16px; }
      .hero-ctas .btn { width:100%; padding:14px 18px; }
      .checks { display:grid; grid-template-columns:1fr 1fr; gap:8px 10px; font-size:12.5px; }
      .checks span { align-items:flex-start; line-height:1.35; }
      .hero-shot { margin-top:28px; }
      .browser-bar { height:24px; } .browser-bar span { display:none; }
      .g4, .g3, .g2 { grid-template-columns:1fr; }
      .row { grid-template-columns:1fr; gap:20px; margin-top:40px; } .row.rev > :first-child { order:0; }
      /* seções compactas */
      section { padding:48px 0; }
      h2 { font-size:25px; margin:8px 0 10px; }
      .sub { font-size:15px; line-height:1.6; }
      .kicker { font-size:11.5px; }
      .card { padding:18px; border-radius:14px; }
      .card h3 { font-size:16px; margin:10px 0 6px; }
      .card p { font-size:14px; }
      /* carrosséis com deslize lateral no lugar de listas longas */
      .swipe { display:flex !important; overflow-x:auto; scroll-snap-type:x mandatory; gap:12px; margin:22px -16px 0 !important; padding:2px 16px 14px; scrollbar-width:none; -webkit-overflow-scrolling:touch; }
      .swipe::-webkit-scrollbar { display:none; }
      .swipe > * { flex:0 0 82%; scroll-snap-align:center; }
      .swipe .reveal { opacity:1; transform:none; }
      .swipe .card:hover { transform:none; }
      .swipe-hint { display:flex; align-items:center; justify-content:center; gap:6px; font-size:12px; color:#7E93A8; margin-top:4px; }
      .intel .swipe-hint { color:#7FD3EE; }
      /* demonstração das telas: abas viram chips roláveis */
      .showcase { margin-top:30px; gap:14px; }
      .tabs { flex-direction:row; overflow-x:auto; gap:8px; scrollbar-width:none; margin:0 -16px; padding:0 16px 4px; }
      .tabs::-webkit-scrollbar { display:none; }
      .tab { min-width:0; flex:0 0 auto; padding:9px 13px; border-radius:999px; }
      .tab b { font-size:13px; white-space:nowrap; } .tab span { display:none; }
      .shot-bullets span { font-size:12px; padding:5px 9px; }
      /* recursos: cada bloco vira um cartão com a tela em cima */
      .rows.swipe > .row { display:flex; flex-direction:column; gap:12px; margin-top:0; background:#fff; border:1px solid #E3EAF1; border-radius:14px; padding:14px; flex-basis:86%; }
      .rows.swipe > .row > img { order:-1; border-radius:10px; box-shadow:none; }
      .rows.swipe .row h3 { font-size:18px; margin:4px 0 6px; }
      .rows.swipe .row p { font-size:14px; line-height:1.55; display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; }
      .rows.swipe .row ul { display:none; }
      .modules-grid > .card { flex-basis:62%; }
      .modules-grid .card p { font-size:13px; }
      /* confiança: grade compacta 2×3 */
      .trust .grid { grid-template-columns:1fr 1fr !important; gap:10px; margin-top:24px !important; }
      .trust .card { padding:14px; }
      .trust .card h3 { font-size:14px; margin:8px 0 4px; }
      .trust .card p { font-size:12.5px; line-height:1.45; }
      .trust .ico { width:34px; height:34px; border-radius:10px; }
      /* como funciona */
      .steps { gap:18px !important; margin-top:26px !important; }
      .step { padding-left:52px; } .step:before { width:38px; height:38px; font-size:16px; border-radius:10px; }
      .step h3 { font-size:16px; }
      /* dúvidas e contato */
      .faq { margin-top:20px; }
      .q button { font-size:15px; padding:15px 2px; }
      .q .a { font-size:14px; }
      .contact .wrap { grid-template-columns:1fr; gap:24px; } .form .f2 { grid-template-columns:1fr; }
      .contact .bul { display:none; }
      .form { padding:20px; border-radius:16px; }
      footer { padding:32px 0 96px; }
      /* barra fixa de ação no celular */
      .m-cta { display:flex; position:fixed; left:0; right:0; bottom:0; z-index:60; gap:10px; padding:10px 14px calc(10px + env(safe-area-inset-bottom)); background:rgba(11,31,51,.96); backdrop-filter:blur(10px); border-top:1px solid rgba(255,255,255,.08);
        transform:translateY(110%); transition:transform .25s ease; }
      .m-cta.on { transform:none; }
      .m-cta .btn { flex:1; padding:12px 14px; font-size:14px; }
      .m-cta .app-link { justify-content:center; }
      .m-only { display:block; }
    }
  `],
  template: `
  <header class="top">
    <div class="wrap">
      <a class="brand" href="#inicio" (click)="go($event, 'inicio')"><ax-logo [size]="34" />AXIONYX</a>
      <nav class="nav">
        @for (n of navItems; track n.id) { <a [href]="'#' + n.id" (click)="go($event, n.id)">{{ n.label }}</a> }
      </nav>
      <div class="top-cta">
        <a class="btn btn-blue btn-sm" href="#contato" (click)="go($event, 'contato')">Agendar demonstração</a>
        <a class="app-link" routerLink="/app" title="Acessar o sistema AXIONYX"><ax-icon name="log-in" [size]="15" /> Entrar</a>
        <button class="burger" [class.on]="menu()" (click)="menu.set(!menu())" [attr.aria-expanded]="menu()" aria-controls="menu-mobile" [attr.aria-label]="menu() ? 'Fechar menu' : 'Abrir menu'"><ax-icon [name]="menu() ? 'x' : 'menu'" [size]="22" /></button>
      </div>
    </div>
  </header>
  <div class="drawer" id="menu-mobile" [class.open]="menu()" [attr.aria-hidden]="!menu()" [attr.inert]="menu() ? null : ''">
    <nav class="drawer-nav" aria-label="Menu principal">
      @for (n of navItems; track n.id) {
        <a [href]="'#' + n.id" (click)="go($event, n.id)"><span class="ic"><ax-icon [name]="n.icon" [size]="18" /></span>{{ n.label }}<ax-icon class="chev" name="chevron-right" [size]="18" /></a>
      }
      <a class="demo" href="#contato" (click)="go($event, 'contato')"><ax-icon name="calendar-days" [size]="18" /> Agendar demonstração</a>
    </nav>
    <div class="drawer-brand">
      <div class="name"><ax-logo [size]="48" />AXIONYX</div>
      <small>ERP com inteligência para varejo e serviços</small>
    </div>
    <div class="drawer-foot">
      <a class="btn btn-blue" routerLink="/app" (click)="menu.set(false)"><ax-icon name="log-in" [size]="18" /> Entrar</a>
    </div>
  </div>

  <div class="hero" id="inicio">
    <div class="wrap">
      <span class="eyebrow"><ax-icon name="axionyx" [size]="14" /> ERP com inteligência comercial para varejo e serviços</span>
      <h1>Pare de decidir no achismo. <em>Venda mais</em> com um ERP que mostra o que comprar, quanto cobrar e quem chamar.</h1>
      <p class="lead">O AXIONYX une PDV, estoque, financeiro e fiscal a uma central de inteligência<span class="d-only"> que prevê a demanda, sugere a reposição, calcula o preço certo e aponta oportunidades de venda</span> — tudo com os dados reais da sua loja.</p>
      <div class="hero-ctas">
        <a class="btn btn-blue" href="#contato" (click)="go($event, 'contato')">Agendar demonstração <ax-icon name="arrow-right" [size]="17" /></a>
        <a class="btn btn-ghost-light" href="#inteligencia" (click)="go($event, 'inteligencia')"><ax-icon name="brain" [size]="17" /> Ver a inteligência em ação</a>
      </div>
      <div class="checks">
        @for (c of heroChecks; track c) { <span><ax-icon name="check-circle-2" [size]="16" color="#4FC3E8" /> {{ c }}</span> }
      </div>
      <div class="hero-shot">
        <div class="browser"><div class="browser-bar"><i></i><i></i><i></i><span>www.axionyxerp.com.br</span></div>
          <img src="site/dashboard.webp" width="1220" height="826" alt="Painel executivo do AXIONYX com faturamento, margem, contas e fluxo de caixa" fetchpriority="high" /></div>
        <div class="float-card fc1"><span class="ic" style="background:#E3F6EC"><ax-icon name="trending-up" [size]="18" color="#18864B" /></span><div><b>Previsão de demanda</b>5 métodos comparados por backtest</div></div>
        <div class="float-card fc2"><span class="ic" style="background:#E8F2FB"><ax-icon name="calculator" [size]="18" color="#0875D1" /></span><div><b>Preço sugerido</b>margem e ponto de equilíbrio</div></div>
        <div class="float-card fc3"><span class="ic" style="background:#FFF4E0"><ax-icon name="package" [size]="18" color="#B26A00" /></span><div><b>Reposição inteligente</b>pedido de compra em 1 clique</div></div>
      </div>
    </div>
  </div>

  <section class="pain" id="desafios">
    <div class="wrap">
      <div class="center reveal"><div class="kicker">Onde o varejo perde dinheiro</div><h2>Os vazamentos que o AXIONYX ajuda a fechar</h2>
        <p class="sub">A maior parte do lucro de uma loja escapa em decisões do dia a dia. O sistema transforma cada uma delas em um número claro e em uma ação.</p></div>
      <div class="grid g4 swipe" style="margin-top:44px">
        @for (p of pains; track p.title) {
          <div class="card reveal"><span class="ico" style="background:#FDECEC;color:#C93636"><ax-icon [name]="p.icon" [size]="21" /></span><h3>{{ p.title }}</h3><p>{{ p.text }}</p>
            <div class="fix"><ax-icon name="check" [size]="15" /> {{ p.fix }}</div></div>
        }
      </div>
      <div class="swipe-hint">Deslize para ver mais <ax-icon name="arrow-right" [size]="13" /></div>
    </div>
  </section>

  <section class="intel" id="inteligencia">
    <div class="wrap">
      <div class="reveal"><div class="kicker">AXIONYX Intelligence</div><h2>Inteligência que vira venda, não relatório parado</h2>
        <p class="sub">Modelos estatísticos e regras de negócio rodando sobre as suas vendas, o seu estoque e o seu financeiro. Cada sugestão mostra de onde veio — você decide com segurança.</p></div>
      <div class="grid g4 swipe" style="margin-top:44px">
        @for (f of intel; track f.title) { <div class="card reveal"><span class="ico"><ax-icon [name]="f.icon" [size]="21" /></span><h3>{{ f.title }}</h3><p>{{ f.text }}</p></div> }
      </div>
      <div class="swipe-hint">Deslize para ver as ferramentas <ax-icon name="arrow-right" [size]="13" /></div>
      <div class="showcase reveal">
        <div class="tabs" role="tablist">
          @for (t of shows; track t.id; let i = $index) {
            <button class="tab" role="tab" [class.on]="show() === i" [attr.aria-selected]="show() === i" (click)="show.set(i)"><b><ax-icon [name]="t.icon" [size]="16" /> {{ t.title }}</b><span>{{ t.text }}</span></button>
          }
        </div>
        <div>
          <div class="shot-frame"><img [src]="shows[show()].img" width="1220" height="826" [alt]="shows[show()].title + ' no AXIONYX'" loading="lazy" /></div>
          <div class="shot-bullets">@for (b of shows[show()].bullets; track b) { <span><ax-icon name="check" [size]="13" color="#4FC3E8" /> {{ b }}</span> }</div>
          <div class="caption">Telas reais do AXIONYX com dados fictícios da empresa de demonstração.</div>
        </div>
      </div>
    </div>
  </section>

  <section id="recursos">
    <div class="wrap">
      <div class="center reveal"><div class="kicker">Gestão completa</div><h2>Do caixa ao financeiro, tudo conversa com tudo</h2>
        <p class="sub">Uma venda no PDV baixa o estoque, gera o recebível, calcula a comissão, acumula cashback e alimenta os indicadores — sem planilha e sem retrabalho.</p></div>
      <div class="rows swipe">
      @for (r of rows; track r.title; let odd = $odd) {
        <div class="row reveal" [class.rev]="odd">
          <div><div class="kicker">{{ r.kicker }}</div><h3>{{ r.title }}</h3><p>{{ r.text }}</p>
            <ul>@for (b of r.bullets; track b) { <li><ax-icon name="check-circle-2" [size]="17" color="#0875D1" /> {{ b }}</li> }</ul></div>
          <img [src]="r.img" width="1220" height="826" [alt]="r.title" loading="lazy" />
        </div>
      }
      </div>
      <div class="swipe-hint">Deslize para ver mais <ax-icon name="arrow-right" [size]="13" /></div>
      <div class="grid g4 swipe modules-grid" style="margin-top:72px">
        @for (m of modules; track m.title) { <div class="card reveal"><span class="ico"><ax-icon [name]="m.icon" [size]="20" /></span><h3>{{ m.title }}</h3><p>{{ m.text }}</p></div> }
      </div>
    </div>
  </section>

  <section class="seg" id="segmentos">
    <div class="wrap">
      <div class="center reveal"><div class="kicker">Feito para o seu ramo</div><h2>Escolha o segmento e o sistema se ajusta</h2>
        <p class="sub">Ao cadastrar a empresa, você escolhe o segmento: o AXIONYX ativa as ferramentas daquele ramo, o vocabulário certo e as categorias iniciais — e esconde o que não faz sentido para a sua operação.</p></div>
      <div class="grid g3 swipe" style="margin-top:44px">
        @for (s of segments; track s.title) {
          <div class="card reveal"><span class="badge" [class.soon]="s.soon">{{ s.soon ? 'Em breve' : 'Disponível' }}</span><span class="ico" style="margin-top:14px"><ax-icon [name]="s.icon" [size]="21" /></span><h3>{{ s.title }}</h3><p>{{ s.text }}</p>
            <ul>@for (b of s.bullets; track b) { <li><ax-icon name="check" [size]="14" color="#18864B" /> {{ b }}</li> }</ul></div>
        }
      </div>
      <div class="swipe-hint">Deslize para ver todos os segmentos <ax-icon name="arrow-right" [size]="13" /></div>
    </div>
  </section>

  <section class="trust" id="seguranca">
    <div class="wrap">
      <div class="center reveal"><div class="kicker">Confiança</div><h2>Seguro, na nuvem e pronto para crescer com você</h2></div>
      <div class="grid g3" style="margin-top:44px">
        @for (t of trust; track t.title) { <div class="card reveal"><span class="ico" style="background:#E3F6EC;color:#18864B"><ax-icon [name]="t.icon" [size]="20" /></span><h3>{{ t.title }}</h3><p>{{ t.text }}</p></div> }
      </div>
    </div>
  </section>

  <section style="background:#F6F9FC" id="como-funciona">
    <div class="wrap">
      <div class="center reveal"><div class="kicker">Como funciona</div><h2>Da demonstração à operação, com acompanhamento</h2>
        <p class="sub">Não há teste grátis: preferimos mostrar o sistema funcionando para a realidade da sua loja e implantar junto com você.</p></div>
      <div class="grid g3 steps" style="margin-top:48px">
        @for (s of steps; track s.title) { <div class="step reveal"><h3>{{ s.title }}</h3><p style="font-size:15px;line-height:1.65;color:#4A5D70;margin:0">{{ s.text }}</p></div> }
      </div>
    </div>
  </section>

  <section id="duvidas">
    <div class="wrap">
      <div class="center reveal"><div class="kicker">Perguntas frequentes</div><h2>Tire suas dúvidas</h2></div>
      <div class="faq">
        @for (f of faqs; track f.q; let i = $index) {
          <div class="q" [class.open]="faq() === i"><button (click)="faq.set(faq() === i ? -1 : i)" [attr.aria-expanded]="faq() === i">{{ f.q }} <ax-icon name="chevron-down" [size]="18" /></button>
            @if (faq() === i) { <div class="a">{{ f.a }}</div> }</div>
        }
      </div>
    </div>
  </section>

  <section class="contact" id="contato">
    <div class="wrap">
      <div class="reveal">
        <div class="kicker" style="color:#7FD3EE">Demonstração guiada</div><h2>Veja o AXIONYX funcionando para a sua loja</h2>
        <p class="sub">Conte um pouco sobre a sua operação. Um especialista entra em contato para agendar uma demonstração com o segmento e as ferramentas que fazem sentido para você.</p>
        <div class="bul">
          @for (b of contactBullets; track b) { <div><ax-icon name="check-circle-2" [size]="18" color="#4FC3E8" /> {{ b }}</div> }
        </div>
      </div>
      <form class="form reveal" (ngSubmit)="send()" #f="ngForm">
        @if (sent()) {
          <div class="ok"><ax-icon name="check-circle-2" [size]="22" /><div><b>Recebemos seu contato!</b><br />Em breve um especialista do AXIONYX fala com você para agendar a demonstração.</div></div>
        } @else {
          <h3>Solicitar demonstração</h3><div style="font-size:13px;color:#647687">Resposta em horário comercial.</div>
          <label for="l-name">Nome *</label><input id="l-name" name="name" [(ngModel)]="lead.name" required maxlength="120" autocomplete="name" />
          <div class="f2">
            <div><label for="l-email">E-mail</label><input id="l-email" name="email" type="email" [(ngModel)]="lead.email" maxlength="200" autocomplete="email" /></div>
            <div><label for="l-phone">WhatsApp / telefone</label><input id="l-phone" name="phone" [(ngModel)]="lead.phone" maxlength="20" autocomplete="tel" placeholder="(11) 99999-9999" /></div>
          </div>
          <div class="f2">
            <div><label for="l-company">Empresa</label><input id="l-company" name="company" [(ngModel)]="lead.companyName" maxlength="150" autocomplete="organization" /></div>
            <div><label for="l-seg">Segmento</label><select id="l-seg" name="segment" [(ngModel)]="lead.segment">
              <option value="">Selecione</option>@for (s of segOptions; track s) { <option [value]="s">{{ s }}</option> }</select></div>
          </div>
          <label for="l-stores">Quantas lojas?</label>
          <select id="l-stores" name="stores" [(ngModel)]="lead.stores"><option value="">Selecione</option><option>1 loja</option><option>2 a 5 lojas</option><option>6 a 20 lojas</option><option>Mais de 20</option></select>
          <label for="l-msg">O que você quer resolver?</label><textarea id="l-msg" name="message" rows="3" [(ngModel)]="lead.message" maxlength="2000" placeholder="Ex.: controlar estoque por grade, precificar melhor, vender por peso..."></textarea>
          <input class="hp" name="website" [(ngModel)]="lead.website" tabindex="-1" autocomplete="off" aria-hidden="true" />
          <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:12.5px;color:#4A5D70;margin-top:14px"><input type="checkbox" name="consent" [(ngModel)]="lead.consent" style="width:auto;margin-top:2px" /> Autorizo o contato da equipe AXIONYX pelos canais informados para tratar desta solicitação (LGPD).</label>
          @if (error()) { <div class="err">{{ error() }}</div> }
          <button class="btn btn-blue" type="submit" style="width:100%;margin-top:16px" [disabled]="busy()">{{ busy() ? 'Enviando...' : 'Quero uma demonstração' }} <ax-icon name="arrow-right" [size]="16" /></button>
        }
      </form>
    </div>
  </section>

  <div class="m-cta" [class.on]="bar()">
    <a class="btn btn-blue" href="#contato" (click)="go($event, 'contato')">Agendar demonstração</a>
    <a class="app-link" routerLink="/app"><ax-icon name="log-in" [size]="15" /> Entrar</a>
  </div>

  <footer>
    <div class="wrap">
      <div><a class="brand" href="#inicio" (click)="go($event, 'inicio')" style="font-size:16px"><ax-logo [size]="28" />AXIONYX</a>
        <div style="margin-top:10px;max-width:420px;line-height:1.6">ERP com inteligência comercial para o varejo: PDV, estoque, financeiro, fiscal e decisões guiadas por dados.</div></div>
      <div style="display:flex;gap:40px;flex-wrap:wrap">
        <div style="display:grid;gap:8px"><b style="color:#fff">Produto</b>@for (n of navItems; track n.id) { <a [href]="'#' + n.id" (click)="go($event, n.id)">{{ n.label }}</a> }</div>
        <div style="display:grid;gap:8px;align-content:start"><b style="color:#fff">Acesso</b><a routerLink="/app">Entrar no Axionyx</a><a href="#contato" (click)="go($event, 'contato')">Agendar demonstração</a></div>
      </div>
    </div>
    <div class="wrap" style="margin-top:28px;border-top:1px solid rgba(255,255,255,.07);padding-top:18px;font-size:12.5px">© {{ year }} AXIONYX · www.axionyxerp.com.br</div>
  </footer>`,
})
export class LandingPage implements OnInit, AfterViewInit, OnDestroy {
  private api = inject(Api); private el = inject(ElementRef<HTMLElement>); private doc = inject(DOCUMENT); readonly auth = inject(AuthService); private router = inject(Router);
  readonly menu = signal(false); readonly show = signal(0); readonly faq = signal(0); readonly bar = signal(false);
  /** Barra de ação fixa no celular: aparece depois do topo e some perto do formulário de contato. */
  @HostListener('window:scroll') onScroll() {
    const y = window.scrollY, contact = this.doc.getElementById('contato')?.offsetTop ?? Infinity;
    this.bar.set(y > 520 && y + window.innerHeight < contact + 120);
  }
  readonly busy = signal(false); readonly sent = signal(false); readonly error = signal('');
  readonly year = new Date().getFullYear();
  lead: any = { name: '', email: '', phone: '', companyName: '', segment: '', stores: '', message: '', consent: false, website: '' };
  private io?: IntersectionObserver;

  readonly navItems = [{ id: 'inteligencia', label: 'Inteligência', icon: 'brain' }, { id: 'recursos', label: 'Recursos', icon: 'layout-grid' }, { id: 'segmentos', label: 'Segmentos', icon: 'store' }, { id: 'como-funciona', label: 'Como funciona', icon: 'list-checks' }, { id: 'duvidas', label: 'Dúvidas', icon: 'help-circle' }];
  private readonly lockScroll = effect(() => { const open = this.menu(); this.doc.body.style.overflow = open ? 'hidden' : ''; });
  @HostListener('document:keydown.escape') onEsc() { this.menu.set(false); }
  @HostListener('window:resize') onResize() { if (window.innerWidth > 1080) this.menu.set(false); }
  readonly heroChecks = ['Na nuvem, sem instalação', 'Várias lojas e empresas', 'Fiscal via provedor homologado', 'WhatsApp pela API oficial'];
  readonly pains = [
    { icon: 'boxes', title: 'Estoque parado', text: 'Dinheiro preso em produto que não gira enquanto falta o que vende.', fix: 'Curva ABC, giro, cobertura e alerta de estoque parado' },
    { icon: 'percent', title: 'Preço no chute', text: 'Markup copiado do vizinho ignora impostos, taxas e custos fixos.', fix: 'Preço pelo markup divisor com margem real' },
    { icon: 'trending-down', title: 'Ruptura e venda perdida', text: 'O cliente chega e o tamanho, o sabor ou a garrafa acabou.', fix: 'Previsão de demanda e reposição sugerida' },
    { icon: 'user-x', title: 'Cliente que não volta', text: 'Sem saber quem sumiu, a loja depende só de quem passa na porta.', fix: 'Segmentos, cashback e WhatsApp com consentimento' },
  ];
  readonly intel = [
    { icon: 'trending-up', title: 'Previsão de demanda', text: 'Cinco métodos estatísticos comparados por backtest; o sistema recomenda o mais preciso e mostra o intervalo de confiança.' },
    { icon: 'flask-conical', title: 'Reposição inteligente', text: 'Sugestão por ritmo de venda, prazo do fornecedor e cobertura desejada — e o pedido de compra sai em um clique.' },
    { icon: 'git-branch', title: 'Mix de compra otimizado', text: 'Pesquisa operacional: com o orçamento que você tem, quais itens comprar para maximizar a margem esperada.' },
    { icon: 'layers', title: 'Simulador de cenários', text: 'Teste volume, preço, custo e inadimplência e veja o impacto no lucro antes de decidir.' },
    { icon: 'calculator', title: 'Precificação inteligente', text: 'Custos fixos e variáveis, margem de contribuição, markup, ponto de equilíbrio e margem de segurança por produto.' },
    { icon: 'calendar-days', title: 'Agenda que enche sozinha', text: 'Para clínicas e salões: horários ociosos, clientes que passaram do retorno habitual, faltas e pacotes parados — com convite pelo WhatsApp em um clique.' },
    { icon: 'axionyx', title: 'Central de insights', text: 'Estoque parado, curva ABC, inadimplência e aniversariantes do mês, sempre com a evidência por trás.' },
    { icon: 'message-circle', title: 'Relacionamento que vende', text: 'Segmentos automáticos, cashback e mensagens pelo WhatsApp oficial para quem autorizou.' },
  ];
  readonly shows = [
    { id: 'previsao', icon: 'trending-up', title: 'Previsão de demanda', text: 'Quanto você vai vender nas próximas semanas.', img: 'site/previsao.webp', bullets: ['Regressão, suavização, médias e mais', 'Erro medido (MAPE, RMSE, viés)', 'Intervalo de confiança'] },
    { id: 'reposicao', icon: 'flask-conical', title: 'Estoque inteligente', text: 'O que repor, quanto e com que urgência.', img: 'site/reposicao.webp', bullets: ['Cobertura em dias por SKU', 'Prazo do fornecedor considerado', 'Gera o pedido de compra'] },
    { id: 'preco', icon: 'calculator', title: 'Precificar produto', text: 'O preço que cobre custos e entrega a margem desejada.', img: 'site/precificar.webp', bullets: ['Markup divisor', 'Preço mínimo e piso', 'Compara cenários e aplica o preço'] },
    { id: 'simulacoes', icon: 'layers', title: 'Simulações', text: 'E se as vendas caírem 10%? E se o custo subir?', img: 'site/simulacoes.webp', bullets: ['Cenários otimista e pessimista', 'Base real dos últimos 90 dias', 'Impacto no lucro operacional'] },
    { id: 'agenda', icon: 'calendar-days', title: 'Inteligência de serviços', text: 'Para clínicas e salões: a agenda que mais fatura.', img: 'site/servicos.webp', bullets: ['Ocupação por profissional e horário', 'Clientes na hora de voltar', 'Pacotes parados e planos sem aprovação'] },
    { id: 'insights', icon: 'brain', title: 'Central de inteligência', text: 'Descobertas priorizadas sobre os seus dados.', img: 'site/inteligencia.webp', bullets: ['Prioridade por impacto', 'Fonte de cada descoberta', 'Ações em um clique'] },
  ];
  readonly rows = [
    { kicker: 'Frente de caixa', title: 'PDV rápido, que não deixa a fila crescer', img: 'site/pdv.webp', text: 'Bipe o código, busque pelo nome ou leia a etiqueta da balança. Pagamentos combinados, troco, crediário, cashback e vale-troca no mesmo fechamento.',
      bullets: ['Leitor de código de barras e atalhos de teclado', 'Desconto com limite por perfil e autorização do supervisor', 'Venda por peso, por caixa e combos, conforme o segmento', 'NFC-e integrada ao provedor fiscal contratado'] },
    { kicker: 'Precificação', title: 'Lucro calculado antes da venda, não depois', img: 'site/precificacao.webp', text: 'Cadastre custos fixos e variáveis uma vez e o AXIONYX mostra a margem de contribuição, o ponto de equilíbrio e a margem de segurança da loja — e o preço certo de cada produto.',
      bullets: ['Painel com faturamento × ponto de equilíbrio', 'Análise de todos os produtos: abaixo da meta, prejuízo, sem custo', 'Histórico de preços e metas de venda por produto'] },
    { kicker: 'Financeiro e crediário', title: 'O caixa da loja sob controle, dia após dia', img: 'site/financeiro.webp', text: 'Contas a pagar e a receber, conciliação bancária por OFX, fluxo de caixa realizado e previsto e um crediário completo, com juros, multa, renegociação e carnê.',
      bullets: ['Inadimplência por faixa de atraso', 'Baixas parciais, estornos e renegociação com trilha', 'Cobrança pelo WhatsApp oficial'] },
  ];
  readonly modules = [
    { icon: 'scan-barcode', title: 'Estoque e etiquetas', text: 'Saldo por loja, transferências, inventário e etiquetas com código de barras.' },
    { icon: 'truck', title: 'Compras e XML', text: 'Importe a NF-e do fornecedor, confira e dê entrada sem digitar.' },
    { icon: 'receipt-text', title: 'Fiscal', text: 'NF-e e NFC-e emitidas por provedor homologado, com validação antes do envio.' },
    { icon: 'gift', title: 'Fidelidade e cashback', text: 'Crédito por compra com validade e resgate direto no PDV.' },
    { icon: 'book-open', title: 'Contabilidade gerencial', text: 'DRE mensal comparativa e lançamentos derivados das operações.' },
    { icon: 'users', title: 'Equipe e comissões', text: 'Metas, comissões por regra e desempenho por vendedor.' },
    { icon: 'file-bar-chart-2', title: 'Relatórios', text: 'Vendas, estoque, giro, pagamentos e clientes com filtros e exportação.' },
    { icon: 'plug', title: 'Integrações', text: 'Loja virtual, logística e WhatsApp com fila e reprocessamento.' },
  ];
  readonly segments = [
    { icon: 'shirt', title: 'Moda e vestuário', soon: false, text: 'Roupas, calçados e acessórios.', bullets: ['Grade cor × tamanho com EAN', 'Condicional e bag delivery', 'Consignação e coleções'] },
    { icon: 'apple', title: 'Hortifrúti e quitanda', soon: false, text: 'Frutas, verduras e mercearia.', bullets: ['Venda por peso e leitura de balança', 'Etiqueta de balança com preço', 'Validade, lotes e controle de perdas'] },
    { icon: 'wine', title: 'Adega e bebidas', soon: false, text: 'Vinhos, destilados e cervejas.', bullets: ['Garrafa ou caixa com código próprio', 'Safra, lote e validade', 'Maioridade no PDV e combos'] },
    { icon: 'shopping-basket', title: 'Mercadinho e conveniência', soon: false, text: 'Minimercados e lojas de conveniência.', bullets: ['Preço por quantidade (atacarejo)', 'Fardos e caixas, peso e validade', 'Maioridade, combos e fiado no crediário'] },
    { icon: 'sparkles', title: 'Cosméticos e perfumaria', soon: false, text: 'Perfumarias, maquiagem e skincare.', bullets: ['Tonalidade e volume com EAN', 'Lote, validade, testers e amostras', 'Kits presenteáveis e revendedoras'] },
    { icon: 'smile', title: 'Odontologia', soon: false, text: 'Consultórios e clínicas odontológicas.', bullets: ['Agenda por dentista e prontuário', 'Odontograma e plano de tratamento', 'Aprovação e parcelamento no crediário'] },
    { icon: 'sparkles', title: 'Clínica de estética', soon: false, text: 'Estética facial, corporal e bem-estar.', bullets: ['Pacotes de sessões com saldo', 'Ficha de avaliação com anamnese', 'Agenda por profissional e sala'] },
    { icon: 'scissors', title: 'Salão de beleza e estética', soon: false, text: 'Salões, barbearias e esmalterias.', bullets: ['Comissão por serviço e por produto', 'Ficha técnica e pacotes', 'Gerente que também atende'] },
    { icon: 'store', title: 'Outros segmentos', soon: true, text: 'Pet shop, farmácia, papelaria e mais.', bullets: ['Núcleo completo já disponível', 'Ferramentas ativadas por módulo', 'Novos pacotes de segmento'] },
  ];
  readonly trust = [
    { icon: 'shield-check', title: 'Acesso protegido', text: 'Login com bloqueio por tentativas, verificação em duas etapas e perfis de permissão por função.' },
    { icon: 'scroll-text', title: 'Tudo auditado', text: 'Trilha de auditoria de alterações de preço, descontos, cancelamentos e configurações.' },
    { icon: 'building-2', title: 'Várias lojas e empresas', text: 'Cada empresa com dados isolados, filiais com estoque e caixa próprios e visão consolidada.' },
    { icon: 'cloud', title: 'Na nuvem', text: 'Acesse do computador da loja, do notebook ou do celular, sem instalar nada.' },
    { icon: 'lock', title: 'LGPD na prática', text: 'Consentimento por canal, exportação e anonimização dos dados pessoais do cliente.' },
    { icon: 'database', title: 'Seus dados são seus', text: 'Exportação completa a qualquer momento e backups do banco de dados.' },
  ];
  readonly steps = [
    { title: 'Demonstração guiada', text: 'Mostramos o AXIONYX no segmento da sua loja, com as ferramentas de inteligência e o fluxo do caixa ao financeiro.' },
    { title: 'Implantação', text: 'Configuramos a empresa, as lojas e os usuários, importamos cadastros e treinamos a equipe.' },
    { title: 'Operação e evolução', text: 'Acompanhamos os primeiros fechamentos e ajudamos a usar os indicadores para vender mais.' },
  ];
  readonly faqs = [
    { q: 'Existe teste grátis?', a: 'Não. Em vez de um teste solto, fazemos uma demonstração guiada com o segmento e as ferramentas que fazem sentido para a sua loja, e a implantação é feita junto com você.' },
    { q: 'O AXIONYX emite nota fiscal?', a: 'Sim, NF-e e NFC-e por meio de um provedor fiscal homologado contratado pela empresa, com o certificado digital dela. O sistema valida os dados antes do envio e só mostra a nota como autorizada quando a SEFAZ autoriza.' },
    { q: 'Funciona para mais de uma loja?', a: 'Sim. Você cadastra várias empresas e filiais; cada loja tem estoque e caixa próprios, e os relatórios podem ser consolidados.' },
    { q: 'Preciso instalar alguma coisa?', a: 'Não. O AXIONYX roda na nuvem e funciona no navegador. Leitor de código de barras USB funciona sem configuração; balanças compatíveis podem ser lidas pelo navegador Chrome ou Edge.' },
    { q: 'Atende o meu segmento?', a: 'Hoje há pacotes para moda, hortifrúti/quitanda, adega/bebidas, mercadinho/conveniência e cosméticos/perfumaria, além do varejo geral. Ao escolher o segmento, o sistema ativa as ferramentas daquele ramo e oculta o que não se aplica.' },
    { q: 'Como funciona o WhatsApp?', a: 'Pela WhatsApp Business Platform, a API oficial da Meta, com o número da própria empresa. Lembretes, cobranças e campanhas só vão para clientes que autorizaram, como exige a LGPD.' },
    { q: 'A inteligência usa os meus dados reais?', a: 'Sim. Previsões, sugestões de reposição, preços e insights são calculados com as vendas, o estoque e o financeiro da sua empresa, e cada sugestão mostra a sua origem.' },
    { q: 'Meus dados ficam seguros?', a: 'Os dados de cada empresa são isolados, o acesso é controlado por perfil e as ações sensíveis ficam registradas em auditoria. Você pode exportar seus dados quando quiser.' },
  ];
  readonly contactBullets = ['Demonstração no seu segmento', 'Ferramentas de inteligência na prática', 'Proposta de implantação para a sua operação'];
  readonly segOptions = ['Moda e vestuário', 'Hortifrúti e quitanda', 'Adega e bebidas', 'Mercadinho e conveniência', 'Cosméticos e perfumaria', 'Odontologia', 'Clínica de estética', 'Salão de beleza', 'Outro varejo ou serviço'];

  ngOnInit() {
    this.doc.title = 'AXIONYX — ERP com inteligência para o varejo vender mais';
  }
  ngAfterViewInit() {
    const els = this.el.nativeElement.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach((e: Element) => e.classList.add('in')); return; }
    this.io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); this.io?.unobserve(en.target); } }), { rootMargin: '0px 0px -60px 0px' });
    els.forEach((e: Element) => this.io!.observe(e));
  }
  ngOnDestroy() { this.io?.disconnect(); this.doc.body.style.overflow = ''; this.doc.title = 'AXIONYX'; }
  go(ev: Event, id: string) {
    ev.preventDefault(); this.menu.set(false);
    this.doc.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', id === 'inicio' ? '/' : '/#' + id);
  }
  async send() {
    this.error.set('');
    const l = this.lead;
    if ((l.name || '').trim().length < 2) return this.error.set('Informe seu nome.');
    if (!l.email && !l.phone) return this.error.set('Informe um e-mail ou um telefone para contato.');
    if (!l.consent) return this.error.set('Marque a autorização de contato para enviarmos a proposta.');
    this.busy.set(true);
    try {
      await this.api.post('/public/leads', { name: l.name.trim(), email: l.email?.trim() || undefined, phone: l.phone?.trim() || undefined, companyName: l.companyName?.trim() || undefined,
        segment: l.segment || undefined, stores: l.stores || undefined, message: l.message?.trim() || undefined, consent: true, website: l.website || undefined });
      this.sent.set(true);
    } catch (e: any) { this.error.set(e?.details?.[0]?.message || e?.message || 'Não foi possível enviar agora. Tente novamente.'); }
    finally { this.busy.set(false); }
  }
}
