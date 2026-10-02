import { ensurePublicFonts } from "./PublicFonts";
import { UNCLAIMED_HEX } from "./WorldPresentation";

const STYLE_ELEMENT_ID = "world-page-styles";

/** Overpass ships with the game (`resources/fonts`); the highway-sign face suits map labels. */
export function ensureWorldStyles(): void {
  if (typeof document === "undefined") return;
  ensurePublicFonts();
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = WORLD_PAGE_CSS;
  document.head.appendChild(style);
}

const WORLD_PAGE_CSS = `
:where(.wp-root) .crown-glyph{display:block;width:100%;height:100%}
.wp-root{--wp-ocean:#071225;--wp-ink:#edf1f7;--wp-dim:#a4afbf;--wp-faint:#8593a6;--wp-line:rgba(148,170,200,.14);--wp-glass:rgba(8,15,28,.78);--wp-display:"PW Overpass",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wp-main{display:block;padding-bottom:3rem}
.wp-wrap{width:100%;max-width:1240px;margin:0 auto;padding-inline:clamp(16px,3vw,28px)}
.wp-loading{display:flex;align-items:center;justify-content:center;gap:.75rem;min-height:60vh;color:var(--wp-dim);font:400 16px/1.4 var(--wp-display)}
.wp-loading-globe{width:28px;height:28px;color:var(--color-info,#56c7f5);animation:wp-spin 3s linear infinite}
@keyframes wp-spin{to{transform:rotate(360deg)}}
.wp-hero{position:relative;padding:clamp(20px,3vw,36px) 0 28px;background:radial-gradient(120% 90% at 50% -10%,#14305a 0%,#0b1a33 38%,#071225 70%,#050c19 100%);border-bottom:1px solid var(--wp-line);overflow:hidden}
.wp-hero::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(60% 50% at 50% 55%,transparent 60%,rgba(3,7,15,.55) 100%)}
.wp-hero-head{position:relative;z-index:2}
.wp-eyebrow{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.5rem;font:400 17px/1.4 var(--wp-display);color:var(--wp-ink)}
.wp-feed{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.25rem .6rem;font-size:14px;color:var(--wp-dim);font-variant-numeric:tabular-nums}
.wp-pill{display:inline-flex;align-items:center;padding:1px 8px;border:1px solid;border-radius:2px;font-size:13px;font-weight:700;line-height:1.5}
.wp-pill-live{color:var(--wp-ink);border-color:var(--wp-dim)}
.wp-pill-paused{color:var(--wp-dim);border-color:#46556c}
.wp-headline{margin:.55rem 0 0;font:700 clamp(30px,5.2vw,62px)/1.02 var(--wp-display);letter-spacing:-.01em;color:var(--wp-ink);text-wrap:balance;max-width:20ch}
.wp-headline-name{text-decoration:underline;text-decoration-color:var(--banner);text-decoration-thickness:.075em;text-underline-offset:.13em;text-decoration-skip-ink:none}
.wp-stats{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0 0;padding:0;list-style:none}
.wp-stats li{display:inline-flex;align-items:center;gap:.4rem;padding:.4rem .7rem;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid var(--wp-line);font-size:13px;color:var(--wp-dim);font-variant-numeric:tabular-nums}
.wp-stats li svg{width:15px;height:15px}
.wp-stat-hot{color:var(--wp-ink)!important}
.wp-stat-crown{color:var(--wp-ink)!important}
.wp-since{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem;margin-top:1rem;padding:.5rem .8rem;border-left:2px solid var(--wp-ink);font-size:14px;color:var(--wp-ink)}
.wp-since-dot{display:none}
.wp-since-list{display:flex;flex-wrap:wrap;gap:.35rem}
.wp-since-front{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .5rem;border-radius:999px;border:1px solid var(--wp-line);background:rgba(0,0,0,.25);color:var(--wp-ink);font-size:12.5px;cursor:pointer}
.wp-since-front:hover{border-color:var(--wp-ink)}
.wp-since-dismiss{margin-left:auto;background:none;border:0;color:var(--wp-dim);font-size:12.5px;text-decoration:underline;cursor:pointer}
.wp-stage-wrap{position:relative;z-index:1;margin-top:clamp(14px,2vw,22px)}
.wp-stage{position:relative;width:100%;max-width:1440px;margin:0 auto;aspect-ratio:500/218;user-select:none;-webkit-user-select:none;touch-action:manipulation}
.wp-graticule{position:absolute;inset:0;width:100%;height:100%}
.wp-graticule line{stroke:rgba(140,175,230,.09);stroke-width:.12;vector-effect:non-scaling-stroke}
.wp-graticule .wp-equator{stroke:rgba(140,175,230,.18);stroke-dasharray:4 6}
.wp-stage canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges}
.wp-glow{filter:blur(12px) saturate(1.5) brightness(1.15);opacity:.5;transform:scale(1.012)}
.wp-map{filter:drop-shadow(0 1px 0 rgba(0,0,0,.55)) drop-shadow(0 0 6px rgba(0,0,0,.35))}
.wp-labels{position:absolute;inset:0;pointer-events:none}
.wp-label{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;display:flex;align-items:center;gap:.45rem;padding:.28rem .7rem .28rem .3rem;border-radius:22px;background:var(--wp-glass);border:1px solid color-mix(in srgb,var(--banner) 55%,transparent);box-shadow:0 8px 22px -10px rgba(0,0,0,.9);color:var(--wp-ink);font-family:var(--wp-display);white-space:nowrap;cursor:pointer;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);transition:transform .18s ease,box-shadow .18s ease}
.wp-label:hover,.wp-label[data-focus]{transform:translate(-50%,-50%) scale(1.06);z-index:3;box-shadow:0 10px 26px -10px rgba(0,0,0,.9),0 0 0 1px var(--banner),0 0 22px -4px color-mix(in srgb,var(--banner) 60%,transparent)}
.wp-label:focus-visible{outline:2px solid #fff;outline-offset:2px}
.wp-label[data-state="unclaimed"]{border-style:dashed;border-color:rgba(148,163,184,.4);padding-left:.7rem;opacity:.72}
.wp-label[data-state="quiet"]{opacity:.78;border-style:dashed}
.wp-label[data-changed]{box-shadow:0 0 0 2px var(--wp-ink)}
.wp-label-text{display:flex;flex-direction:column;line-height:1.05}
.wp-label-front{font-size:11px;font-weight:400;color:var(--wp-dim)}
.wp-label-holder{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;max-width:17ch;overflow:hidden;white-space:normal;overflow-wrap:anywhere;font-size:12.5px;font-weight:700;line-height:1.1}
.wp-emblem{display:inline-flex;align-items:center;justify-content:center;width:var(--size);height:var(--size);flex:none;border-radius:50%;overflow:hidden;background:rgba(0,0,0,.35);box-shadow:0 0 0 2px var(--banner)}
.wp-emblem svg,.wp-emblem img{width:100%;height:100%;display:block;image-rendering:pixelated}
.wp-emblem-blank{background:var(--banner);color:#0b1220;font:700 calc(var(--size)*.5)/1 var(--wp-display)}
.wp-crown{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:.1rem;width:132px;padding:.55rem .5rem .6rem;border-radius:4px;background:rgb(4 10 23/.92);border:1px solid var(--wp-line);color:var(--wp-ink);font-family:var(--wp-display);cursor:pointer;text-align:center;transition:transform .18s ease}
.wp-crown:hover{transform:translate(-50%,-50%) scale(1.04)}
.wp-crown-icon{width:22px;height:13px;margin-bottom:.2rem;color:var(--wp-ink)}
.wp-crown-ring{display:flex;padding:3px;border-radius:50%;background:var(--banner);margin:.15rem 0 .2rem}
.wp-crown-ring .wp-emblem{box-shadow:none}
.wp-crown-title{font-size:12px;font-weight:400;color:var(--wp-dim)}
.wp-crown-holder{font-size:13.5px;font-weight:700;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-crown-sub{font-size:11.5px;color:var(--wp-dim)}
.wp-crown-siege{font-size:11.5px;line-height:1.3;color:var(--wp-ink)}
.wp-guide{position:relative;z-index:2;margin-top:10px}
.wp-sw{display:inline-block;flex:none;width:12px;height:12px;margin-right:6px;background:var(--paint)}
.wp-sw-open{box-shadow:inset 0 0 0 1px #46556c}
.wp-low{box-shadow:inset 0 0 0 1px var(--wp-ink)}
.wp-key{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0;font-size:13px;line-height:1.5;color:var(--wp-dim)}
.wp-key span{display:inline-flex;align-items:center}
.wp-legend{display:none;margin:0 0 10px;padding:0;list-style:none}
.wp-legend li{display:flex;flex-wrap:wrap;align-items:center;gap:0 12px;min-height:44px;border-bottom:1px solid var(--wp-line);break-inside:avoid}
.wp-legend-who{display:flex;align-items:center;gap:10px;flex:1 1 auto;min-width:0}
.wp-legend-name{position:relative;display:inline-flex;align-items:center;min-height:32px;font:700 14px/1.25 var(--wp-display);color:var(--wp-ink);overflow-wrap:anywhere}
.wp-legend-muted{font-weight:400;color:var(--wp-dim)}
.wp-sw-flag{width:22px;height:22px;margin-right:0}
.wp-legend-fronts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:0 16px;margin-left:auto}
.wp-legend-front{position:relative;display:inline-flex;align-items:center;min-height:32px;padding:0;border:0;background:none;color:var(--wp-ink);font:400 13px/1.2 var(--wp-display);white-space:nowrap;cursor:pointer}
/* 44px tap targets without 44px lines: a wrapped row stays compact. */
a.wp-legend-name::after,.wp-legend-front::after{content:"";position:absolute;inset:-6px -4px}
.wp-legend-front-name{color:var(--wp-ink);text-decoration:underline;text-decoration-color:#46556c;text-underline-offset:3px}
.wp-legend-front:hover .wp-legend-front-name{text-decoration-color:var(--wp-ink)}
.wp-legend-front:focus-visible{outline:2px solid var(--wp-ink);outline-offset:2px}
.wp-legend-front-text{color:var(--wp-dim)}
.wp-legend-front-crown{display:inline-flex;width:14px;height:8px;margin-right:6px;color:var(--wp-ink)}
.wp-section{padding-top:clamp(36px,5vw,56px)}
.wp-section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1.5rem;margin-bottom:1rem}
.wp-section-title{margin:0;font:700 24px/1.2 var(--wp-display);color:var(--wp-ink)}
.wp-section-intro{margin:0;max-width:62ch;font-size:14px;line-height:1.5;color:var(--wp-dim)}
.wp-fronts-head{display:none}
.wp-fronts{margin:0;padding:0;list-style:none;border-top:1px solid var(--wp-line)}
.wp-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"front last" "holder holder" "form form";gap:10px 16px;padding:14px 0 16px;border-bottom:1px solid var(--wp-line)}
.wp-row:hover{background:rgba(255,255,255,.025)}
.wp-row-hit{position:absolute;inset:0;z-index:1;width:100%;height:100%;padding:0;border:0;background:none;cursor:pointer}
.wp-row-hit:focus-visible{outline:2px solid var(--wp-ink);outline-offset:-2px}
.wp-row-front{grid-area:front;display:flex;flex-wrap:wrap;align-items:center;column-gap:10px;min-width:0}
.wp-row-front .wp-sw{margin-right:0}
.wp-row-crown{display:inline-flex;flex:none;width:12px;height:7px;color:var(--wp-ink)}
.wp-row-name{margin:0;font:700 17px/1.25 var(--wp-display);color:var(--wp-ink)}
.wp-row-state{flex-basis:100%;padding-left:22px;font-size:13px;color:var(--wp-dim)}
.wp-row[data-state="contested"] .wp-row-state{color:var(--wp-ink);font-weight:700}
.wp-row-holder{grid-area:holder;display:flex;align-items:flex-start;gap:10px;min-width:0}
.wp-row-holdertext{display:flex;flex-direction:column;gap:2px;min-width:0}
.wp-row-holdername{font-size:15px;line-height:1.3;color:var(--wp-ink);overflow-wrap:anywhere}
.wp-row-since{font-size:13px;color:var(--wp-dim);white-space:nowrap}
.wp-row-race{font-size:14px;line-height:1.4;color:var(--wp-dim)}
.wp-row-empty{font-size:14px;color:var(--wp-dim)}
.wp-row-form{grid-area:form;min-width:0}
.wp-row-last{grid-area:last;display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:13px;color:var(--wp-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.wp-row-age{display:none}
.wp-row-count{font-size:12px}
.wp-strip{display:grid;grid-template-columns:repeat(var(--cells),minmax(0,1fr));gap:3px;max-width:420px}
.wp-strip i{display:block;height:14px;border-radius:2px;background:var(--cell,${UNCLAIMED_HEX})}
.wp-strip .wp-strip-none{background:linear-gradient(to top right,transparent calc(50% - .5px),#46556c calc(50% - .5px),#46556c calc(50% + .5px),transparent calc(50% + .5px));box-shadow:inset 0 0 0 1px #46556c}
.wp-strip .wp-strip-empty{background:none;box-shadow:inset 0 0 0 1px rgba(148,163,184,.14)}
@media (min-width:900px){
  .wp-fronts-head,.wp-row{grid-template-columns:minmax(9rem,12rem) minmax(0,1fr) minmax(10rem,15rem) 7.5rem;column-gap:28px}
  .wp-fronts-head{display:grid;padding:0 0 8px;font-size:13px;color:var(--wp-dim)}
  .wp-fronts-head span:last-child{text-align:right}
  .wp-row{grid-template-areas:"front holder form last";align-items:center;padding:12px 0}
  .wp-row-age{display:inline}
  .wp-row-age-phone{display:none}
}
.wp-chip{display:inline-flex;align-items:center;padding:.15rem .5rem;border-radius:2px;font:700 12px/1.3 var(--wp-display);border:1px solid var(--wp-line);color:var(--wp-dim);background:rgba(6,12,22,.7);white-space:nowrap}
.wp-chip[data-state="held"]{color:color-mix(in srgb,var(--banner) 80%,#fff);border-color:color-mix(in srgb,var(--banner) 50%,transparent)}
.wp-chip[data-state="contested"]{color:var(--wp-ink);border-color:var(--wp-dim)}
.wp-chip[data-state="quiet"]{color:#cbd5e1}
.wp-agent-link{color:inherit;text-decoration:none;position:relative;z-index:2}
.wp-agent-link:hover{text-decoration:underline;text-decoration-color:var(--banner,currentColor);text-underline-offset:3px}
.wp-front-line{margin:0;font-size:14px;color:var(--wp-dim)}
.wp-front-empty{margin:.2rem 0 0;font-size:14px;line-height:1.5;color:var(--wp-dim)}
.wp-columns{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:18px;padding-top:clamp(36px,5vw,56px)}
@media (max-width:900px){.wp-columns{grid-template-columns:minmax(0,1fr)}}
.wp-panel{min-width:0;padding:1.1rem 1.1rem 1rem;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid var(--wp-line)}
.wp-panel .wp-section-title{margin-bottom:.4rem}
.wp-panel-intro{margin:0 0 .8rem;font-size:13px;color:var(--wp-dim)}
.wp-dispatches{margin:0;padding:0;list-style:none;border-top:1px solid var(--wp-line)}
.wp-dispatch{display:grid;grid-template-columns:6.5em minmax(0,1fr) auto;gap:2px 16px;align-items:baseline;min-height:44px;padding:11px 0 12px;border-bottom:1px solid var(--wp-line);color:var(--wp-ink);text-decoration:none}
.wp-dispatch time{font-size:13px;color:var(--wp-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.wp-dispatch-text{font-size:15px;line-height:1.45}
.wp-dispatch-chip{display:inline-block;width:10px;height:10px;margin-right:8px;background:var(--chip)}
.wp-dispatch-watch{font-size:13px;font-weight:700;color:var(--wp-dim)}
.wp-dispatch:hover .wp-dispatch-watch{color:var(--wp-ink);text-decoration:underline;text-underline-offset:3px}
.wp-dispatch:focus-visible{outline:2px solid var(--wp-ink);outline-offset:2px}
.wp-more{min-height:44px;margin-top:.8rem;padding:0 16px;background:none;border:1px solid #46556c;border-radius:2px;color:var(--wp-ink);font:700 14px/1 var(--wp-display);cursor:pointer}
.wp-more:hover{border-color:var(--wp-ink)}
.wp-muted{color:var(--wp-faint);font-size:13px}
.wp-powers{width:100%;border-collapse:collapse;font-size:13px}
.wp-powers th,.wp-powers td{padding:.55rem .35rem;border-top:1px solid var(--wp-line);text-align:left;vertical-align:middle;font-weight:400}
.wp-powers thead th{border-top:0;font:400 13px/1.2 var(--wp-display);color:var(--wp-dim);padding-top:0}
.wp-powers tbody th{font-weight:700;color:var(--wp-ink);overflow-wrap:anywhere}
.wp-num{text-align:right!important;font-variant-numeric:tabular-nums;color:var(--wp-dim)}
.wp-power-agent{display:inline-flex;align-items:center;gap:.5rem;min-width:0}
.wp-power-crown{display:inline-flex;width:16px;height:9px;color:var(--wp-ink)}
.wp-front-chips{display:flex;flex-wrap:wrap;gap:.25rem}
.wp-front-chip{position:relative;padding:.18rem .45rem;border-radius:6px;border:1px solid color-mix(in srgb,var(--banner) 45%,transparent);background:color-mix(in srgb,var(--banner) 12%,transparent);color:var(--wp-ink);font-size:11.5px;cursor:pointer;white-space:nowrap}
.wp-front-chip:hover{background:color-mix(in srgb,var(--banner) 24%,transparent)}
.wp-front-chip::after{content:"";position:absolute;inset:-9px -2px}
.wp-history{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:16px;padding:1rem;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid var(--wp-line)}
@media (max-width:820px){.wp-history{grid-template-columns:minmax(0,1fr)}}
.wp-history-chart{position:relative;min-width:0}
.wp-history-chart svg{display:block;width:100%;height:260px}
.wp-history-chart svg:focus-visible{outline:2px solid var(--wp-ink);outline-offset:4px}
.wp-history-layer{stroke:rgba(5,12,25,.6);stroke-width:1;vector-effect:non-scaling-stroke}
.wp-history-grid{stroke:rgba(148,170,200,.12);stroke-dasharray:3 5;vector-effect:non-scaling-stroke}
.wp-history-cursor{stroke:#fff;stroke-width:1.5;vector-effect:non-scaling-stroke}
.wp-history-axis{display:flex;justify-content:space-between;margin-top:.35rem;font-size:11.5px;color:var(--wp-faint)}
.wp-history-tip{position:absolute;top:18px;transform:translateX(-50%);display:flex;flex-direction:column;gap:.2rem;min-width:150px;padding:.55rem .65rem;border-radius:10px;background:rgba(5,10,20,.92);border:1px solid var(--wp-line);font-size:12px;color:var(--wp-ink);pointer-events:none;box-shadow:0 12px 30px -12px rgba(0,0,0,.9)}
.wp-tip-row{display:flex;align-items:center;gap:.4rem;color:var(--wp-dim)}
.wp-tip-row svg{width:13px;height:13px;color:var(--wp-ink)}
.wp-tip-row i{width:9px;height:9px;border-radius:2px;flex:none}
.wp-tip-row b{margin-left:auto;color:var(--wp-ink)}
.wp-history-legend{display:flex;flex-direction:column;gap:.45rem;margin:0;padding:0;list-style:none;font-size:12.5px;color:var(--wp-dim)}
.wp-history-legend li{display:flex;align-items:flex-start;gap:.5rem;min-width:0;overflow-wrap:anywhere}
.wp-history-legend i{width:12px;height:12px;margin-top:3px;border-radius:3px;flex:none}
.wp-history-crown{background:none;box-shadow:inset 0 0 0 2px var(--wp-ink);border-radius:50%!important}
.wp-history-others{background:rgba(148,163,184,.35)}
@media (max-width:820px){.wp-history-legend{flex-direction:row;flex-wrap:wrap}}
.wp-rules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
@media (max-width:820px){.wp-rules{grid-template-columns:minmax(0,1fr)}}
.wp-rule{padding:1.1rem;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid var(--wp-line)}
.wp-rule h3{margin:.6rem 0 .35rem;font:700 15px/1.25 var(--wp-display);color:var(--wp-ink)}
.wp-rule p{margin:0;font-size:13.5px;line-height:1.55;color:var(--wp-dim)}
.wp-rule-icon{display:inline-flex;width:34px;height:34px;padding:7px;border-radius:4px;color:var(--wp-ink);box-shadow:inset 0 0 0 1px var(--wp-line)}
.wp-rule-icon-crown{color:var(--wp-ink)}
.wp-data-note{margin:1rem 0 0;font-size:12.5px;color:var(--wp-faint)}
.wp-drawer-backdrop{position:fixed;inset:0;z-index:60;background:rgba(2,6,14,.55);backdrop-filter:blur(2px);animation:wp-fade .2s ease both}
.wp-drawer{position:fixed;z-index:61;top:0;right:0;bottom:0;width:min(460px,100vw);display:flex;flex-direction:column;background:#0b1526;border-left:1px solid var(--wp-line);box-shadow:-30px 0 60px -30px rgba(0,0,0,.9);overflow-y:auto;animation:wp-slide .28s cubic-bezier(.2,.8,.2,1) both}
@media (max-width:640px){.wp-drawer{top:auto;left:0;width:100vw;max-height:88vh;border-left:0;border-top:1px solid var(--wp-line);border-radius:18px 18px 0 0;animation-name:wp-sheet}}
@keyframes wp-fade{from{opacity:0}}
@keyframes wp-slide{from{transform:translateX(40px);opacity:0}}
@keyframes wp-sheet{from{transform:translateY(40px);opacity:0}}
.wp-drawer-art{position:relative;height:150px;flex:none;background:linear-gradient(135deg,color-mix(in srgb,var(--banner) 35%,#0b1a33),#0b1526);overflow:hidden}
.wp-drawer-art img{width:100%;height:100%;object-fit:cover;opacity:.6}
.wp-drawer-art::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 30%,#0b1526),linear-gradient(90deg,color-mix(in srgb,var(--banner) 40%,transparent),transparent 75%)}
.wp-drawer-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;padding:0 1.2rem;margin-top:-56px;position:relative;z-index:1}
.wp-drawer-title{margin:.45rem 0 0;font:700 30px/1.1 var(--wp-display);color:var(--wp-ink);text-shadow:0 2px 14px rgba(0,0,0,.7)}
.wp-drawer-close{display:inline-flex;width:38px;height:38px;padding:9px;border-radius:50%;border:1px solid var(--wp-line);background:rgba(5,10,20,.7);color:var(--wp-ink);cursor:pointer;align-self:flex-start;margin-top:.2rem}
.wp-drawer-close:hover{border-color:rgba(148,170,200,.45)}
.wp-drawer-close:focus-visible{outline:2px solid #fff;outline-offset:2px}
.wp-drawer-body{display:flex;flex-direction:column;gap:.75rem;padding:1rem 1.2rem 2rem}
.wp-drawer-holder{display:flex;align-items:center;gap:.9rem}
.wp-kicker{font:400 13px/1.3 var(--wp-display);color:var(--wp-dim)}
.wp-drawer-since{font-size:13px;color:var(--wp-dim)}
.wp-drawer-holdername{font:700 20px/1.2 var(--wp-display);color:var(--wp-ink)}
.wp-drawer-sub{margin:.8rem 0 .1rem;font:700 15px/1.3 var(--wp-display);color:var(--wp-ink)}
.wp-tally{display:flex;flex-direction:column;gap:.4rem;margin:0;padding:0;list-style:none}
.wp-tally li{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) 24px;align-items:center;gap:.6rem;font-size:13px;color:var(--wp-ink)}
.wp-tally-name{display:inline-flex;align-items:center;gap:.4rem;min-width:0;overflow-wrap:anywhere}
.wp-tally-bar{height:8px;border-radius:99px;background:rgba(148,163,184,.12);overflow:hidden}
.wp-tally-bar i{display:block;height:100%;border-radius:99px;background:var(--banner)}
.wp-tally b{text-align:right;font-variant-numeric:tabular-nums}
.wp-battles,.wp-reigns{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.wp-battle{display:grid;grid-template-columns:122px minmax(0,1fr) minmax(0,1.2fr);align-items:center;gap:.6rem;min-height:44px;padding:.5rem .4rem;border-radius:8px;color:var(--wp-ink);text-decoration:none;font-size:12.5px;border-left:3px solid var(--banner)}
.wp-battle:hover{background:rgba(255,255,255,.04)}
.wp-battle-when{color:var(--wp-faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.wp-battle-map{color:var(--wp-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-battle-winner{display:inline-flex;align-items:center;gap:.35rem;min-width:0;overflow-wrap:anywhere;font-weight:600}
.wp-reigns li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;grid-template-areas:"e n s" "e r r";align-items:center;column-gap:.6rem;padding:.45rem 0;border-top:1px solid var(--wp-line);font-size:12.5px}
.wp-reigns li:first-child{border-top:0}
.wp-reigns .wp-emblem{grid-area:e}
.wp-reign-name{grid-area:n;font-weight:700;color:var(--wp-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-reign-span{grid-area:s;color:var(--wp-faint);font-variant-numeric:tabular-nums}
.wp-reign-record{grid-area:r;color:var(--wp-faint)}
.wp-drawer-maps{margin:.6rem 0 0;font-size:12.5px;color:var(--wp-faint)}
@media (max-width:1179px){
  .wp-label{display:none}
  .wp-crown{width:44px;height:44px;padding:0;gap:0;justify-content:center;border:0;background:none}
  .wp-crown:hover{transform:translate(-50%,-50%)}
  .wp-crown-title,.wp-crown-holder,.wp-crown-sub,.wp-crown-siege{display:none}
  .wp-crown-icon{position:absolute;left:50%;top:-3px;width:12px;height:8px;margin:0;transform:translateX(-50%)}
  .wp-crown-ring{margin:0;padding:2px}
  .wp-crown .wp-emblem{width:24px;height:24px}
  .wp-legend{display:block;columns:2;column-gap:40px}
}
@media (max-width:759px){
  .wp-legend{columns:1}
  .wp-crown .wp-emblem{width:20px;height:20px}
}
@media (max-width:640px){
  .wp-battle{grid-template-columns:104px minmax(0,1fr)}
  .wp-battle-map,.wp-powers-conquests{display:none}
  .wp-panel{padding:0;border:0;border-radius:0;background:none}
  .wp-columns{row-gap:48px}
  .wp-dispatch{grid-template-columns:minmax(0,1fr) auto;gap:2px 16px}
  .wp-dispatch time{grid-column:1}
  .wp-dispatch-text{grid-column:1}
  .wp-dispatch-watch{grid-column:2;grid-row:1/3;align-self:center}
}
@media (prefers-reduced-motion:reduce){.wp-root *{animation:none!important;transition:none!important}}
`;
