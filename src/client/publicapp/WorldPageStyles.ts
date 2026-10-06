import { ensurePublicFonts } from "./PublicFonts";
import { ensurePlacardStyles } from "./WorldPlacards";
import { UNCLAIMED_HEX } from "./WorldPresentation";
import { CAVEAT_MORE_CLASS } from "./WorldVerdict";

const STYLE_ELEMENT_ID = "world-page-styles";

/** Overpass ships with the game (`resources/fonts`); the highway-sign face suits map labels. */
export function ensureWorldStyles(): void {
  if (typeof document === "undefined") return;
  ensurePublicFonts();
  ensurePlacardStyles();
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = WORLD_PAGE_CSS;
  document.head.appendChild(style);
}

const WORLD_PAGE_CSS = `
:where(.wp-root) .crown-glyph{display:block;width:100%;height:100%}
.wp-root{--wp-ocean:#071225;--wp-ink:#edf1f7;--wp-dim:#a4afbf;--wp-faint:#8593a6;--wp-line:rgba(148,170,200,.14);--wp-glass:rgba(8,15,28,.78);--wp-display:"PW Overpass",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--wp-ocean)}
.wp-main{display:block;padding-bottom:3rem}
.wp-wrap{width:100%;max-width:1240px;margin:0 auto;padding-inline:clamp(16px,3vw,28px)}
.wp-loading{display:flex;align-items:center;justify-content:center;gap:.75rem;min-height:60vh;color:var(--wp-dim);font:400 16px/1.4 var(--wp-display)}
.wp-loading-globe{width:28px;height:28px;color:var(--color-info,#56c7f5);animation:wp-spin 3s linear infinite}
@keyframes wp-spin{to{transform:rotate(360deg)}}
.wp-hero{position:relative;padding:clamp(20px,3vw,36px) 0 28px;border-bottom:1px solid var(--wp-line);overflow:hidden}
.wp-hero-head{position:relative;z-index:2}
.wp-eyebrow{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.5rem;font:400 17px/1.4 var(--wp-display);color:var(--wp-ink)}
.wp-feed{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.25rem .6rem;font-size:14px;color:var(--wp-dim);font-variant-numeric:tabular-nums}
.wp-pill{display:inline-flex;align-items:center;padding:1px 8px;border:1px solid;border-radius:2px;font-size:13px;font-weight:700;line-height:1.5}
.wp-pill-live{color:var(--wp-ink);border-color:var(--wp-dim)}
.wp-pill-paused{color:var(--wp-dim);border-color:#46556c}
.wp-headline{margin:.55rem 0 0;font:700 clamp(30px,5.2vw,62px)/1.02 var(--wp-display);letter-spacing:-.01em;color:var(--wp-ink);text-wrap:balance;overflow-wrap:anywhere;max-width:20ch}
.wp-headline-name{text-decoration:underline;text-decoration-color:var(--banner);text-decoration-thickness:.075em;text-underline-offset:.13em;text-decoration-skip-ink:none}
a.wp-headline-name{color:inherit}
a.wp-headline-name:hover{text-decoration-thickness:.12em}
a.wp-headline-name:focus-visible{outline:2px solid var(--wp-ink);outline-offset:4px;border-radius:2px}
.wp-headline[data-length="l"]{font-size:clamp(28px,4.4vw,52px)}
.wp-headline[data-length="xl"]{font-size:clamp(26px,3.6vw,42px);max-width:26ch}
.wp-support{margin:.7rem 0 0;max-width:68ch;font:400 18px/1.45 var(--wp-display);color:var(--wp-dim);overflow-wrap:anywhere}
.wp-support b{color:var(--wp-ink);font-weight:700}
.wp-stats{display:flex;flex-wrap:wrap;gap:4px 24px;margin:12px 0 0;padding:0;list-style:none}
.wp-stats li{font-size:14px;color:var(--wp-dim);font-variant-numeric:tabular-nums}
.wp-stat-hot{color:var(--wp-ink)!important}
.wp-stat-crown{color:var(--wp-ink)!important}
.wp-since{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem;margin-top:1rem;padding:.5rem .8rem;border-left:2px solid var(--wp-ink);font-size:14px;color:var(--wp-ink)}
.wp-since-dot{display:none}
.wp-since-list{display:flex;flex-wrap:wrap;gap:12px .5rem}
.wp-since-front{position:relative;display:inline-flex;align-items:center;gap:.35rem;min-height:32px;padding:0 .6rem;border-radius:2px;border:1px solid var(--wp-line);background:rgba(0,0,0,.25);color:var(--wp-ink);font-size:12.5px;cursor:pointer}
.wp-since-front:hover{border-color:var(--wp-ink)}
.wp-since-front::after{content:"";position:absolute;inset:-6px -2px}
.wp-since-dismiss{min-height:44px;margin-left:auto;padding:0 .5rem;background:none;border:0;color:var(--wp-dim);font-size:12.5px;text-decoration:underline;cursor:pointer}
.wp-stage-wrap{position:relative;z-index:1;margin-top:clamp(14px,2vw,22px)}
.wp-stage{position:relative;width:100%;max-width:1440px;margin:0 auto;aspect-ratio:500/218;user-select:none;-webkit-user-select:none;touch-action:manipulation}
.wp-stage canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges}
.wp-emblem{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:var(--size);height:var(--size);flex:none;padding:max(2px,calc(var(--size) * .1));background:var(--banner)}
.wp-emblem svg,.wp-emblem img{width:100%;height:100%;display:block;image-rendering:pixelated}
.wp-emblem-blank{color:#0b1220;font:700 calc(var(--size) * .5)/1 var(--wp-display)}
.wp-guide{position:relative;z-index:2;margin-top:10px}
.wp-sw{display:inline-block;flex:none;width:12px;height:12px;margin-right:6px;background:var(--paint)}
.wp-sw-open{box-shadow:inset 0 0 0 1px #46556c}
.wp-low{box-shadow:inset 0 0 0 1px var(--wp-ink)}
.wp-key{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0;padding:0;list-style:none;font-size:13px;line-height:1.5;color:var(--wp-dim)}
.wp-key li{display:inline-flex;align-items:center}
.wp-legend{display:none;margin:0 0 10px;padding:0;list-style:none}
.wp-legend li{display:flex;flex-wrap:wrap;align-items:center;gap:12px 12px;min-height:44px;border-bottom:1px solid var(--wp-line);break-inside:avoid}
.wp-legend-who{display:flex;align-items:center;gap:10px;flex:1 1 auto;min-width:0}
.wp-legend-name{position:relative;display:inline-flex;align-items:center;min-height:32px;font:700 14px/1.25 var(--wp-display);color:var(--wp-ink);overflow-wrap:anywhere}
.wp-legend-muted{font-weight:400;color:var(--wp-dim)}
.wp-sw-flag{width:22px;height:22px;margin-right:0}
.wp-legend-fronts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px 16px;margin-left:auto}
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
.wp-columns{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:48px 56px;padding-top:clamp(36px,5vw,56px)}
@media (max-width:900px){.wp-columns{grid-template-columns:minmax(0,1fr)}}
.wp-panel{min-width:0}
.wp-panel .wp-section-title{margin-bottom:.4rem}
.wp-panel-intro{margin:0 0 .8rem;font-size:13px;color:var(--wp-dim)}
.wp-dispatch-day{margin:20px 0 6px;font:700 14px/1.3 var(--wp-display);color:var(--wp-dim)}
.wp-dispatch-day:first-of-type{margin-top:4px}
.wp-power-fronts{display:flex;flex-wrap:wrap;gap:12px 16px}
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
.wp-tl{--label:9.5rem;--gap:14px;--row:22px;display:grid;grid-template-columns:var(--label) minmax(0,1fr);column-gap:var(--gap);padding:0}
.wp-tl-fronts{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.wp-tl-front{display:flex;align-items:center;gap:6px;width:100%;height:var(--row);padding:0;border:0;background:none;color:var(--wp-ink);font:700 13px/1 var(--wp-display);text-align:left;white-space:nowrap;cursor:pointer}
.wp-tl-front:hover{text-decoration:underline;text-underline-offset:3px}
.wp-tl-crown{display:inline-flex;flex:none;width:12px;height:7px;color:var(--wp-ink)}
.wp-tl-grid{position:relative;display:flex;flex-direction:column;gap:6px;min-width:0;outline:none;touch-action:pan-y}
.wp-tl-grid:focus-visible{outline:2px solid var(--wp-ink);outline-offset:6px}
.wp-tl-bar{position:relative;display:flex;height:var(--row)}
.wp-tl-run{display:flex;align-items:center;flex-basis:0;min-width:0;background:var(--c);color:var(--t);font:700 11.5px/1 var(--wp-display);overflow:hidden;container-type:inline-size}
.wp-tl-run+.wp-tl-run{box-shadow:inset 1px 0 0 rgba(7,18,37,.6)}
.wp-tl-open{background:${UNCLAIMED_HEX};color:var(--wp-dim);font-weight:400}
.wp-tl-pointed{outline:2px solid var(--wp-ink);outline-offset:-2px}
.wp-tl-name{padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wp-tl-plated .wp-tl-name{margin-left:3px;padding:2px 4px;border-radius:2px;background:rgb(4 10 23/.86);color:var(--wp-ink)}
@container (max-width:72px){.wp-tl-name{display:none}}
.wp-tl-cursor{position:absolute;top:-4px;bottom:-4px;left:calc(var(--at) * 100%);width:2px;margin-left:-1px;background:var(--wp-ink);pointer-events:none}
.wp-tl-tip{position:absolute;z-index:2;bottom:calc(100% + 8px);left:calc(var(--at) * 100%);transform:translateX(calc(var(--at) * -100%));width:max-content;max-width:min(320px,100%);padding:.45rem .65rem;border-radius:2px;background:rgb(4 10 23/.95);border:1px solid var(--wp-line);color:var(--wp-ink);font-size:12.5px;line-height:1.35;pointer-events:none}
.wp-tl-axis{grid-column:2;position:relative;height:20px;margin-top:6px;font-size:11.5px;color:var(--wp-faint)}
.wp-tl-axis span{position:absolute;left:calc(var(--at) * 100%);top:0;padding-left:3px;border-left:1px solid rgba(148,170,200,.3);white-space:nowrap}
.wp-tl-solo{--row:20px;margin:.35rem 0 .9rem}
.wp-tl-solo .wp-tl-axis{margin-top:4px}
.wp-tl-caption{margin:.5rem 0 0;font-size:12.5px;line-height:1.45;color:var(--wp-faint)}
.wp-drawer-body .wp-strip{margin:.2rem 0 .3rem}
.wp-tl-readout{grid-column:2;margin:.5rem 0 0;font-size:13px;line-height:1.45;color:var(--wp-dim)}
@media (max-width:640px){.wp-tl{--label:6.6rem;--gap:8px;--row:18px}.wp-tl-front{font-size:12px}}
.wp-rules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 40px}
@media (max-width:820px){.wp-rules{grid-template-columns:minmax(0,1fr)}}
.wp-rule{padding-top:14px;border-top:1px solid var(--wp-line)}
.wp-rule h3{margin:.5rem 0 .35rem;font:700 15px/1.25 var(--wp-display);color:var(--wp-ink)}
.wp-rule p{margin:0;font-size:13.5px;line-height:1.55;color:var(--wp-dim)}
.wp-rule-icon{display:inline-flex;width:20px;height:20px;color:var(--wp-ink)}
.wp-rule-icon-crown{color:var(--wp-ink)}
.wp-data-note{margin:1rem 0 0;font-size:12.5px;color:var(--wp-faint)}
.wp-pill-next{color:var(--wp-ink);border-color:var(--wp-dim);font-variant-numeric:tabular-nums}
.wp-latest{max-width:820px;margin:1rem 0 0;padding:12px 14px 14px;border:1px solid var(--wp-line);border-radius:2px;background:rgba(8,15,28,.55)}
.wp-latest-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:.15rem .7rem;margin:0;font:700 13px/1.35 var(--wp-display);color:var(--wp-ink)}
.wp-latest-where{font-weight:400;color:var(--wp-dim)}
.wp-latest-when{font-weight:400;color:var(--wp-faint);font-variant-numeric:tabular-nums}
.wp-latest-result{margin:.35rem 0 0;font:400 16px/1.45 var(--wp-display);color:var(--wp-ink);overflow-wrap:anywhere}
.wp-latest-result b{font-weight:700}
.wp-latest-watch{display:inline-block;margin-left:.3rem;padding:4px 0;font-size:14px;font-weight:700;color:var(--wp-ink);text-decoration:underline;text-decoration-color:#46556c;text-underline-offset:3px;white-space:nowrap}
.wp-latest-watch:hover{text-decoration-color:var(--wp-ink)}
.wp-latest-watch:focus-visible,.wp-cta a:focus-visible{outline:2px solid var(--wp-ink);outline-offset:2px;border-radius:2px}
.wp-standings{display:flex;flex-wrap:wrap;gap:4px 16px;margin:.45rem 0 0;padding:0;list-style:none;font-size:13px;color:var(--wp-dim);counter-reset:wp-rank}
.wp-standing{display:inline-flex;align-items:center;gap:6px;min-width:0;counter-increment:wp-rank}
.wp-standing::before{content:counter(wp-rank) ".";color:var(--wp-faint);font-variant-numeric:tabular-nums}
.wp-standing-chip{display:inline-block;flex:none;width:10px;height:10px;background:var(--banner)}
.wp-standing-name{color:var(--wp-ink);overflow-wrap:anywhere}
.wp-standing-share{font-variant-numeric:tabular-nums;white-space:nowrap}
.wp-standing-out .wp-standing-name{color:var(--wp-dim)}
.wp-voices{display:grid;grid-template-columns:minmax(0,1fr);gap:10px 20px;margin:.85rem 0 0}
.wp-voices-title{grid-column:1/-1;margin:0;font-size:12.5px;color:var(--wp-faint)}
.wp-voice{min-width:0;margin:0;padding:1px 0 1px 12px;border-left:3px solid var(--banner)}
.wp-voice blockquote{margin:0;font:400 15px/1.45 var(--wp-display);color:var(--wp-ink);overflow-wrap:anywhere}
.wp-voice figcaption{margin-top:3px;font-size:12.5px;color:var(--wp-dim);overflow-wrap:anywhere}
@media (min-width:900px){.wp-voices{grid-template-columns:repeat(3,minmax(0,1fr))}}
.wp-recap{max-width:86ch;margin:.75rem 0 0;font-size:13px;line-height:1.5;color:var(--wp-faint);overflow-wrap:anywhere}
.wp-cta{max-width:86ch;margin:14px 0 0;font-size:14px;line-height:1.55;color:var(--wp-dim);overflow-wrap:anywhere}
.wp-cta a{color:var(--wp-ink);font-weight:700;text-decoration:underline;text-decoration-color:#46556c;text-underline-offset:3px}
.wp-cta a:hover{text-decoration-color:var(--wp-ink)}
.wp-form-method{max-width:76ch;margin:-.25rem 0 1rem;font-size:14px;line-height:1.5;color:var(--wp-ink)}
.wp-form-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr));gap:16px;margin:0;padding:0;list-style:none}
.wp-form-card{min-width:0;padding:14px 14px 10px;border:1px solid var(--wp-line);border-top:3px solid var(--banner);border-radius:2px;background:rgba(8,15,28,.55)}
.wp-form-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.wp-form-name{margin:0;font:700 17px/1.25 var(--wp-display);color:var(--wp-ink);overflow-wrap:anywhere}
.wp-form-provider{font-size:13px;color:var(--wp-dim)}
.wp-form-tag{margin-left:auto;padding:1px 7px;border:1px solid #46556c;border-radius:2px;font:700 12px/1.5 var(--wp-display);color:var(--wp-dim)}
.wp-form-tag:not([data-kind="normal"]):not([data-kind="too_few"]){color:var(--wp-ink);border-color:var(--wp-dim)}
.wp-form-day{margin:.6rem 0 0;font-size:14.5px;line-height:1.45;color:var(--wp-ink)}
.wp-form-chance{margin:.25rem 0 0;font-size:13.5px;line-height:1.5;color:var(--wp-dim)}
.wp-form-scan{width:100%;margin-top:.75rem;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.wp-form-scan caption{caption-side:top;padding-bottom:4px;text-align:left;font:700 12.5px/1.3 var(--wp-display);color:var(--wp-dim)}
.wp-form-scan th,.wp-form-scan td{padding:5px 0 5px 8px;border-top:1px solid var(--wp-line);text-align:right;font-weight:400;color:var(--wp-ink);white-space:nowrap}
.wp-form-scan thead th,.wp-form-scan thead td{border-top:0;padding-top:0;font-size:12px;color:var(--wp-faint)}
.wp-form-scan tbody th{padding-left:0;text-align:left;color:var(--wp-dim);white-space:normal}
.wp-form-scan td:last-child{color:var(--wp-dim)}
.wp-power-name{display:inline-flex;flex-direction:column;min-width:0}
.wp-power-provider{font-size:12px;font-weight:400;color:var(--wp-dim)}
.wp-drawer-backdrop{position:fixed;inset:0;z-index:60;background:rgba(2,6,14,.55);backdrop-filter:blur(2px)}
.wp-drawer-backdrop.wp-drawer-enter{animation:wp-fade .2s ease}
.wp-drawer{position:fixed;z-index:61;top:0;right:0;bottom:0;width:min(460px,100vw);display:flex;flex-direction:column;background:#0b1526;border-left:1px solid var(--wp-line);box-shadow:-30px 0 60px -30px rgba(0,0,0,.9);overflow-y:auto}
.wp-drawer.wp-drawer-enter{animation:wp-slide .28s cubic-bezier(.2,.8,.2,1)}
@media (max-width:640px){.wp-drawer{top:auto;left:0;width:100vw;max-height:88vh;border-left:0;border-top:1px solid var(--wp-line);border-radius:2px 2px 0 0}.wp-drawer.wp-drawer-enter{animation-name:wp-sheet}}
@keyframes wp-fade{from{opacity:0}}
@keyframes wp-slide{from{transform:translateX(40px);opacity:0}}
@keyframes wp-sheet{from{transform:translateY(40px);opacity:0}}
.wp-drawer-art{position:relative;height:150px;flex:none;background:linear-gradient(135deg,color-mix(in srgb,var(--banner) 35%,#0b1a33),#0b1526);overflow:hidden}
.wp-drawer-art img{width:100%;height:100%;object-fit:cover;opacity:.6}
.wp-drawer-art::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 30%,#0b1526),linear-gradient(90deg,color-mix(in srgb,var(--banner) 40%,transparent),transparent 75%)}
.wp-drawer-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;padding:0 1.2rem;margin-top:-56px;position:relative;z-index:1}
.wp-drawer-title{margin:.45rem 0 0;font:700 30px/1.1 var(--wp-display);color:var(--wp-ink);text-shadow:0 2px 14px rgba(0,0,0,.7)}
.wp-drawer-close{display:inline-flex;width:44px;height:44px;padding:12px;border-radius:2px;border:1px solid var(--wp-line);background:rgba(5,10,20,.7);color:var(--wp-ink);cursor:pointer;align-self:flex-start;margin-top:.2rem}
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
.wp-tally-bar{height:8px;border-radius:2px;background:rgba(148,163,184,.12);overflow:hidden}
.wp-tally-bar i{display:block;height:100%;border-radius:2px;background:var(--banner)}
.wp-tally b{text-align:right;font-variant-numeric:tabular-nums}
.wp-battles,.wp-reigns{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.wp-battle{display:grid;grid-template-columns:122px minmax(0,1fr);align-items:center;gap:.6rem;min-height:44px;padding:.5rem .4rem;border-radius:2px;color:var(--wp-ink);text-decoration:none;font-size:12.5px;border-left:3px solid var(--banner)}
.wp-battles-maps .wp-battle{grid-template-columns:122px minmax(0,1fr) minmax(0,1.2fr)}
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
  .wp-legend{display:block;columns:2;column-gap:40px}
}
@media (max-width:759px){
  .wp-legend{columns:1}
  .wp-support{font-size:16px}
  .wp-support .${CAVEAT_MORE_CLASS}{display:none}
}
@media (max-width:640px){
  .wp-battle,.wp-battles-maps .wp-battle{grid-template-columns:104px minmax(0,1fr)}
  .wp-battle-map,.wp-powers-conquests{display:none}
  .wp-columns{row-gap:48px}
  .wp-dispatch{grid-template-columns:minmax(0,1fr) auto;gap:2px 16px}
  .wp-dispatch time{grid-column:1}
  .wp-dispatch-text{grid-column:1}
  .wp-dispatch-watch{grid-column:2;grid-row:1/3;align-self:center}
}
@media (max-width:359px){
  /* The narrowest phones: a holding may wrap rather than widen the page. */
  .wp-powers .wp-legend-front{white-space:normal}
}
@media (prefers-reduced-motion:reduce){.wp-root *{animation:none!important;transition:none!important}}
`;
