import { html, LitElement, nothing, svg, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { assetUrl } from "../../core/AssetUrls";
import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  requestUpdateWhenTranslationsReady,
} from "./AppShellChrome";
import {
  clearestSiege,
  contrastRatio,
  crownFront,
  frontsInState,
  holderGroups,
} from "./HomePresentation";
import { ensurePublicFonts } from "./PublicFonts";
import { CROWN_GLYPH } from "./WorldGlyphs";
import {
  WORLD_GRID_ANCHORS,
  WORLD_GRID_GRATICULE,
  WORLD_GRID_HEIGHT,
  WORLD_GRID_WIDTH,
} from "./WorldMapGrid";
import { paintWorldFrame, theatreAtPoint } from "./WorldMapRenderer";
import {
  fetchWorldModel,
  type WorldAgent,
  type WorldBattle,
  type WorldEvent,
  type WorldModel,
  type WorldTheatre,
  type WorldTheatreId,
} from "./WorldModelSchema";
import {
  assignBannerColors,
  battlefieldKey,
  changedSinceVisit,
  feedState,
  frontDisplayState,
  frontPaints,
  frontSwatch,
  parseVisitSnapshot,
  relativeAge,
  UNCLAIMED_HEX,
  visitSnapshot,
  WORLD_REGION_IDS,
  worldVerdict,
  type FrontDisplayState,
} from "./WorldPresentation";
import { battlefieldName } from "./WorldText";

/**
 * `/world` — the persistent world map over the league. Every league battle
 * is fought on a real map; each map is a front of this Earth, held by the
 * agent that won the most of its last N battles (server:
 * `CoworldLeagueWorld.ts`, which also publishes the `world.json` this page
 * reads). The page is a broadcast surface, not a dashboard: the first
 * screen answers "who rules the world right now", the map shows where, and
 * everything below explains how each front got there — every claim one
 * click from the battle that decided it.
 */

type LoadState = "loading" | "ready" | "error";

const REFRESH_MS = 2 * 60 * 1000;
const REVEAL_MS = 1400;
const FRAME_MS = 40;
const STRIPE_CYCLE_MS = 2600;
const VISIT_KEY = "proxywar.world.lastVisit";
const STYLE_ELEMENT_ID = "world-page-styles";
const DISPATCHES_COLLAPSED = 10;
/** The ocean behind the map; banners darker than 3:1 on it get an ink edge. */
const OCEAN = "#071225";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Invisible-separator markers for names spliced into translated sentences. */
const NAME_MARKER_PATTERN = /\u2063(\d+)\u2063/;
function nameMarker(index: number): string {
  return `\u2063${index}\u2063`;
}

const FRONT_NAME_KEYS: Record<WorldTheatreId, string> = {
  north_america: "world_page.front_north_america",
  south_america: "world_page.front_south_america",
  britannia: "world_page.front_britannia",
  europe: "world_page.front_europe",
  black_sea: "world_page.front_black_sea",
  middle_east: "world_page.front_middle_east",
  africa: "world_page.front_africa",
  asia: "world_page.front_asia",
  east_asia: "world_page.front_east_asia",
  oceania: "world_page.front_oceania",
  crown: "world_page.front_crown",
};

const STATUS_KEYS: Record<FrontDisplayState, string> = {
  held: "world_page.status_held",
  contested: "world_page.status_contested",
  quiet: "world_page.status_quiet",
  unclaimed: "world_page.status_unclaimed",
};

const ICONS = {
  swords:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l10 10M20 4L10 14"/><path d="M6.5 15.5l2 2M17.5 15.5l-2 2"/><path d="M4 20l3.5-3.5M20 20l-3.5-3.5"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4" stroke-linecap="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-6-5.4-6-11a6 6 0 1 1 12 0c0 5.6-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  globe:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/></svg>',
};

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: the visit diff simply never shows.
  }
}

/** Overpass ships with the game (`resources/fonts`); the highway-sign face suits map labels. */
function ensureWorldStyles(): void {
  if (typeof document === "undefined") return;
  ensurePublicFonts();
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = WORLD_PAGE_CSS;
  document.head.appendChild(style);
}

@customElement("world-page")
export class WorldPage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private model: WorldModel | null = null;
  @state() private hoverFront: WorldTheatreId | null = null;
  @state() private selected: WorldTheatreId | null = null;
  @state() private changed: WorldTheatreId[] = [];
  @state() private sinceVisitAt: string | null = null;
  @state() private dispatchesExpanded = false;
  @state() private historyIndex: number | null = null;
  @state() private now = Date.now();

  private colors = new Map<string, string>();
  private agents = new Map<string, WorldAgent>();
  private image: ImageData | null = null;
  private raf = 0;
  private lastPaint = 0;
  private revealStart = 0;
  /** Reveal progress of the last frame actually painted. */
  private paintedReveal = 0;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private glowKey = "";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private mapVisible = true;
  private observer: IntersectionObserver | null = null;
  private returnFocus: HTMLElement | null = null;

  createRenderRoot() {
    this.classList.add(...APP_SHELL_ROOT_CLASSES, "wp-root");
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    ensureWorldStyles();
    void this.load(true);
    requestUpdateWhenTranslationsReady(this);
    this.refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") void this.load(false);
    }, REFRESH_MS);
    window.addEventListener("hashchange", this.onHashChange);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.revealTimer !== null) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener("hashchange", this.onHashChange);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private async load(initial: boolean): Promise<void> {
    if (initial) this.loadState = "loading";
    try {
      const model = await fetchWorldModel();
      if (!initial && this.model?.generatedAt === model.generatedAt) return;
      this.now = Date.now();
      this.colors = assignBannerColors(model);
      this.agents = new Map(model.agents.map((agent) => [agent.name, agent]));
      if (initial) {
        const previous = parseVisitSnapshot(storageGet(VISIT_KEY));
        this.changed = changedSinceVisit(model, previous);
        this.sinceVisitAt = previous?.at ?? null;
        storageSet(VISIT_KEY, JSON.stringify(visitSnapshot(model)));
        // Nobody sees a reveal in a background tab; paint the finished map.
        const watching =
          !reducedMotion() && document.visibilityState === "visible";
        this.revealStart = watching ? performance.now() : 0;
        if (watching) {
          // Animation frames can be throttled or paused; never leave the
          // map half-revealed.
          this.revealTimer = setTimeout(() => {
            this.revealTimer = null;
            this.revealStart = 0;
            this.paint(performance.now());
          }, REVEAL_MS + 60);
        }
      }
      this.model = model;
      this.loadState = "ready";
      if (initial) this.onHashChange();
      this.glowKey = "";
      document.title = translateText("world_page.document_title");
    } catch {
      if (initial || this.model === null) this.loadState = "error";
    }
  }

  protected updated(): void {
    if (this.loadState !== "ready") return;
    const stage = this.querySelector<HTMLElement>(".wp-stage");
    if (
      stage !== null &&
      this.observer === null &&
      "IntersectionObserver" in window
    ) {
      this.observer = new IntersectionObserver((entries) => {
        this.mapVisible = entries.some((entry) => entry.isIntersecting);
        if (this.mapVisible) this.schedule();
      });
      this.observer.observe(stage);
    }
    this.paint(performance.now());
    this.schedule();
  }

  // ------------------------------------------------------------------ canvas

  private paint(time: number): void {
    const model = this.model;
    const canvas = this.querySelector<HTMLCanvasElement>("canvas.wp-map");
    if (model === null || canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    this.image ??= context.createImageData(WORLD_GRID_WIDTH, WORLD_GRID_HEIGHT);
    const reveal = this.revealProgress(time);
    this.paintedReveal = reveal;
    // Fronts come in west to east.
    const order = [...WORLD_REGION_IDS].sort(
      (a, b) => WORLD_GRID_ANCHORS[a].x - WORLD_GRID_ANCHORS[b].x,
    );
    const fronts = frontPaints(model, this.colors, this.now, {
      revealed: (id) => reveal >= (order.indexOf(id) + 1) / order.length,
      changed: reveal >= 1 ? this.changed : [],
    });
    const phase = reducedMotion()
      ? 0
      : (time % STRIPE_CYCLE_MS) / STRIPE_CYCLE_MS;
    paintWorldFrame(this.image.data, { fronts, focus: this.hoverFront, phase });
    context.putImageData(this.image, 0, 0);
    const glowKey = `${model.generatedAt}|${this.hoverFront}|${Math.min(1, Math.floor(reveal * 10) / 10)}`;
    if (glowKey !== this.glowKey) {
      this.glowKey = glowKey;
      const glow = this.querySelector<HTMLCanvasElement>("canvas.wp-glow");
      glow?.getContext("2d")?.putImageData(this.image, 0, 0);
    }
  }

  private revealProgress(time: number): number {
    if (this.revealStart === 0) return 1;
    return Math.min(1, (time - this.revealStart) / REVEAL_MS);
  }

  private needsAnimation(time: number): boolean {
    if (reducedMotion() || this.model === null) return false;
    if (this.revealProgress(time) < 1) return true;
    if (this.changed.length > 0) return true;
    return this.model.theatres.some(
      (theatre) =>
        theatre.id !== "crown" &&
        frontDisplayState(theatre, this.now) === "contested",
    );
  }

  private schedule(): void {
    if (this.raf !== 0) return;
    const now = performance.now();
    const animate =
      this.mapVisible &&
      document.visibilityState === "visible" &&
      this.needsAnimation(now);
    if (!animate) {
      // Whatever stopped the loop, the resting map is always fully drawn.
      if (this.paintedReveal < 1 && this.revealProgress(now) >= 1)
        this.paint(now);
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (time: number): void => {
    this.raf = 0;
    if (!this.isConnected) return;
    if (time - this.lastPaint >= FRAME_MS) {
      this.lastPaint = time;
      this.paint(time);
    }
    this.schedule();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") this.schedule();
  };

  private onStagePointer(event: PointerEvent): void {
    const stage = event.currentTarget as HTMLElement;
    const rect = stage.getBoundingClientRect();
    const next = theatreAtPoint(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
    if (next !== this.hoverFront) this.hoverFront = next;
    stage.style.cursor = next === null ? "default" : "pointer";
  }

  private onStageClick(event: MouseEvent): void {
    const stage = event.currentTarget as HTMLElement;
    const rect = stage.getBoundingClientRect();
    const id = theatreAtPoint(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
    if (id !== null) this.openFront(id);
  }

  // -------------------------------------------------------------- drawer

  private readonly onHashChange = (): void => {
    const match = /^#front-([a-z_]+)$/.exec(window.location.hash);
    const id = match?.[1] as WorldTheatreId | undefined;
    const known = this.model?.theatres.some((theatre) => theatre.id === id);
    this.selected = id !== undefined && known === true ? id : null;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.selected !== null) this.closeFront();
  };

  private openFront(id: WorldTheatreId): void {
    this.returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.selected = id;
    history.replaceState(null, "", `#front-${id}`);
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(".wp-drawer-close")?.focus(),
    );
  }

  private closeFront(): void {
    this.selected = null;
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  // -------------------------------------------------------------- helpers

  /** Always a `#rrggbb` colour: these values are written into style attributes. */
  private bannerColor(name: string | null): string {
    if (name === null) return "#64748b";
    const color = this.colors.get(name) ?? this.agents.get(name)?.color;
    return color !== undefined && HEX_COLOR.test(color) ? color : "#94a3b8";
  }

  /** Below 3:1 on the ocean, a banner swatch gets an ink edge. */
  private lowContrast(name: string | null): boolean {
    if (name === null) return false;
    const ratio = contrastRatio(this.bannerColor(name), OCEAN);
    return ratio !== null && ratio < 3;
  }

  /** A front's paint as the map shows it, for swatches. */
  private swatch(front: WorldTheatre | null): string {
    return frontSwatch(front, (name) => this.bannerColor(name), this.now);
  }

  private label(name: string | null): string {
    if (name === null) return translateText("world_page.no_winner");
    return this.agents.get(name)?.label ?? name;
  }

  private frontName(id: WorldTheatreId): string {
    return translateText(FRONT_NAME_KEYS[id]);
  }

  private battlefieldName(map: string): string {
    return battlefieldName(map);
  }

  private age(iso: string | null): string {
    if (iso === null) return "—";
    const age = relativeAge(iso, this.now);
    switch (age.unit) {
      case "now":
        return translateText("world_page.age_now");
      case "m":
        return translateText("world_page.age_minutes", { count: age.value });
      case "h":
        return translateText("world_page.age_hours", { count: age.value });
      case "d":
        return translateText("world_page.age_days", { count: age.value });
      default:
        return this.date(iso);
    }
  }

  private date(iso: string, withTime = false): string {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return "—";
    return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
      month: "short",
      day: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    }).format(new Date(time));
  }

  private emblem(name: string | null, size: number): TemplateResult {
    const agent = name === null ? undefined : this.agents.get(name);
    const color = this.bannerColor(name);
    if (agent?.emblemSvg) {
      return html`<span
        class="wp-emblem"
        style="--size:${size}px;--banner:${color}"
        aria-hidden="true"
        ><img
          src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(
            agent.emblemSvg,
          )}"
          alt=""
          decoding="async"
      /></span>`;
    }
    return html`<span
      class="wp-emblem wp-emblem-blank"
      style="--size:${size}px;--banner:${color}"
      aria-hidden="true"
      >${name === null ? "" : this.label(name).slice(0, 1).toUpperCase()}</span
    >`;
  }

  private agentLink(name: string | null, extraClass = ""): TemplateResult {
    const agent = name === null ? undefined : this.agents.get(name);
    // `title` reveals a name the layout truncated — several league identities
    // share a long prefix ("Captain Underpants Maximum Aura (…)").
    const label = this.label(name);
    if (agent?.slug) {
      return html`<a
        class="wp-agent-link ${extraClass}"
        href="/agent/${encodeURIComponent(agent.slug)}"
        title=${label}
        >${label}</a
      >`;
    }
    return html`<span class="${extraClass}" title=${label}>${label}</span>`;
  }

  private theatre(id: WorldTheatreId): WorldTheatre | undefined {
    return this.model?.theatres.find((theatre) => theatre.id === id);
  }

  private thumbnail(theatre: WorldTheatre): string | null {
    const key = theatre.maps[0]?.map ?? theatre.battlefields[0];
    if (key === undefined) return null;
    try {
      return assetUrl(`maps/${battlefieldKey(key)}/thumbnail.webp`);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- render

  render() {
    return html`
      ${appShellHeader("/world")}
      ${this.loadState === "loading" ? this.renderLoading() : nothing}
      ${this.loadState === "error" ? this.renderError() : nothing}
      ${this.loadState === "ready" && this.model !== null
        ? this.renderWorld(this.model)
        : nothing}
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<div class="wp-loading" role="status">
      <span class="wp-loading-globe">${unsafeSVG(ICONS.globe)}</span>
      ${translateText("world_page.loading")}
    </div>`;
  }

  private renderError() {
    return html`<main class="mx-auto w-full max-w-3xl px-4 py-16">
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
        role="alert"
      >
        ${translateText("world_page.error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load(true)}
        >
          ${translateText("world_page.retry")}
        </button>
      </div>
    </main>`;
  }

  private renderWorld(model: WorldModel) {
    return html`
      <main class="wp-main">
        ${this.renderHero(model)} ${this.renderFronts(model)}
        <div class="wp-wrap wp-columns">
          ${this.renderDispatches(model)} ${this.renderPowers(model)}
        </div>
        ${this.renderHistory(model)} ${this.renderRules(model)}
      </main>
      ${this.selected !== null ? this.renderDrawer(this.selected) : nothing}
    `;
  }

  // -------------------------------------------------------------- hero

  private renderHero(model: WorldModel) {
    const feed = feedState(model, this.now);
    const verdict = worldVerdict(model);
    const crown = this.theatre("crown");
    const regions = model.theatres.filter((theatre) => theatre.id !== "crown");
    const claimed = regions.filter((theatre) => theatre.holder !== null).length;
    const contested = regions.filter(
      (theatre) => frontDisplayState(theatre, this.now) === "contested",
    ).length;
    let headline: TemplateResult;
    switch (verdict.kind) {
      case "leader":
        headline = this.withNames(
          "world_page.verdict_leader",
          { name: nameMarker(0), count: verdict.fronts },
          [verdict.name],
        );
        break;
      case "tied":
        headline = this.withNames(
          "world_page.verdict_tied",
          {
            names: verdict.names
              .map((_, index) => nameMarker(index))
              .join(" & "),
          },
          verdict.names,
        );
        break;
      case "scattered":
        headline = html`${translateText("world_page.verdict_scattered")}`;
        break;
      default:
        headline = html`${translateText("world_page.verdict_empty")}`;
    }
    return html`
      <section class="wp-hero" aria-labelledby="wp-headline">
        <div class="wp-wrap wp-hero-head">
          <div class="wp-eyebrow">
            <span>${translateText("world_page.eyebrow")}</span>
            ${feed.kind === "empty"
              ? html`<span class="wp-feed"
                  >${translateText("world_page.feed_empty")}</span
                >`
              : html`<span class="wp-feed"
                  ><span
                    class="wp-pill ${feed.kind === "live"
                      ? "wp-pill-live"
                      : "wp-pill-paused"}"
                    >${translateText(
                      feed.kind === "live"
                        ? "home_page.live_pill"
                        : "home_page.paused_pill",
                    )}</span
                  >${translateText(
                    feed.kind === "live"
                      ? "world_page.feed_live"
                      : "world_page.feed_paused",
                    { age: this.age(feed.lastBattleAt) },
                  )}</span
                >`}
          </div>
          <h1 id="wp-headline" class="wp-headline">${headline}</h1>
          <ul class="wp-stats" role="list">
            <li>
              ${translateText("world_page.stat_fronts", {
                held: claimed,
                total: regions.length,
              })}
            </li>
            <li class=${contested > 0 ? "wp-stat-hot" : ""}>
              ${unsafeSVG(ICONS.swords)}
              ${translateText("world_page.stat_contested", {
                count: contested,
              })}
            </li>
            ${crown?.holder
              ? html`<li class="wp-stat-crown">
                  ${CROWN_GLYPH}
                  ${translateText("world_page.stat_crown", {
                    name: this.label(crown.holder),
                  })}
                </li>`
              : nothing}
            ${model.firstBattleAt !== null
              ? html`<li>
                  ${translateText("world_page.stat_battles", {
                    count: model.battleCount,
                    date: this.date(model.firstBattleAt),
                  })}
                </li>`
              : nothing}
          </ul>
          ${this.renderSinceVisit()}
        </div>
        ${this.renderMap(model)}
        <div class="wp-wrap wp-guide">
          ${this.renderLegend(model)} ${this.renderKey(model)}
        </div>
      </section>
    `;
  }

  /**
   * Renders a translated sentence with each agent name in its banner colour.
   * The names go through `translateText` as invisible markers and are
   * swapped for styled spans afterwards, so translations keep full control of
   * word order.
   */
  private withNames(
    key: string,
    params: Record<string, string | number>,
    names: readonly string[],
  ): TemplateResult {
    const parts = translateText(key, params).split(NAME_MARKER_PATTERN);
    return html`${parts.map((part, index) => {
      if (index % 2 === 0) return part;
      const name = names[Number(part)];
      return name === undefined
        ? nothing
        : html`<span
            class="wp-headline-name"
            style="--banner:${this.bannerColor(name)}"
            >${this.label(name)}</span
          >`;
    })}`;
  }

  private renderSinceVisit() {
    if (this.changed.length === 0 || this.sinceVisitAt === null) return nothing;
    return html`<div class="wp-since" role="status">
      <span class="wp-since-dot" aria-hidden="true"></span>
      <span
        >${translateText("world_page.since_visit", {
          count: this.changed.length,
          age: this.age(this.sinceVisitAt),
        })}</span
      >
      <span class="wp-since-list">
        ${this.changed.map(
          (id) =>
            html`<button
              type="button"
              class="wp-since-front"
              @click=${() => this.openFront(id)}
            >
              ${this.emblem(this.theatre(id)?.holder ?? null, 16)}
              ${this.frontName(id)}
            </button>`,
        )}
      </span>
      <button
        type="button"
        class="wp-since-dismiss"
        @click=${() => {
          this.changed = [];
        }}
      >
        ${translateText("world_page.dismiss")}
      </button>
    </div>`;
  }

  private renderMap(model: WorldModel) {
    const crown = model.theatres.find((theatre) => theatre.id === "crown");
    return html`
      <div class="wp-stage-wrap">
        <div
          class="wp-stage"
          @pointermove=${(event: PointerEvent) => this.onStagePointer(event)}
          @pointerleave=${() => {
            this.hoverFront = null;
          }}
          @click=${(event: MouseEvent) => this.onStageClick(event)}
        >
          <svg
            class="wp-graticule"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            ${WORLD_GRID_GRATICULE.meridians.map(
              (x) => svg`<line x1=${x} x2=${x} y1="0" y2="100"></line>`,
            )}
            ${WORLD_GRID_GRATICULE.parallels.map(
              (y) =>
                svg`<line class=${y === WORLD_GRID_GRATICULE.equator ? "wp-equator" : ""} x1="0" x2="100" y1=${y} y2=${y}></line>`,
            )}
          </svg>
          <canvas
            class="wp-glow"
            width=${WORLD_GRID_WIDTH}
            height=${WORLD_GRID_HEIGHT}
            aria-hidden="true"
          ></canvas>
          <canvas
            class="wp-map"
            width=${WORLD_GRID_WIDTH}
            height=${WORLD_GRID_HEIGHT}
            role="img"
            aria-label=${translateText("world_page.map_label")}
          ></canvas>
          <div class="wp-labels">
            ${WORLD_REGION_IDS.map((id) => {
              const theatre = model.theatres.find((entry) => entry.id === id);
              return theatre === undefined
                ? nothing
                : this.renderLabel(theatre);
            })}
            ${crown !== undefined ? this.renderCrownMedallion(crown) : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private renderLabel(theatre: WorldTheatre) {
    const anchor = WORLD_GRID_ANCHORS[theatre.id];
    const display = frontDisplayState(theatre, this.now);
    const name = this.frontName(theatre.id);
    const aria =
      theatre.holder === null
        ? translateText("world_page.label_aria_unclaimed", { front: name })
        : display === "contested"
          ? translateText("world_page.label_aria_contested", {
              front: name,
              holder: this.label(theatre.holder),
              challenger: this.label(theatre.challenger),
            })
          : translateText("world_page.label_aria_held", {
              front: name,
              holder: this.label(theatre.holder),
            });
    return html`<button
      type="button"
      class="wp-label"
      data-state=${display}
      ?data-focus=${this.hoverFront === theatre.id}
      ?data-changed=${this.changed.includes(theatre.id)}
      style="left:${anchor.x}%;top:${anchor.y}%;--banner:${this.bannerColor(
        theatre.holder,
      )};--rival:${this.bannerColor(theatre.challenger)}"
      aria-label=${aria}
      @pointerenter=${() => {
        this.hoverFront = theatre.id;
      }}
      @focus=${() => {
        this.hoverFront = theatre.id;
      }}
      @blur=${() => {
        this.hoverFront = null;
      }}
      @click=${(event: Event) => {
        event.stopPropagation();
        this.openFront(theatre.id);
      }}
    >
      ${theatre.holder !== null ? this.emblem(theatre.holder, 22) : nothing}
      <span class="wp-label-text">
        <span class="wp-label-front">${name}</span>
        <span class="wp-label-holder"
          >${theatre.holder === null
            ? translateText("world_page.label_unclaimed")
            : this.label(theatre.holder)}</span
        >
      </span>
      ${display === "contested"
        ? html`<span
            class="wp-label-siege"
            title=${this.label(theatre.challenger)}
            >${unsafeSVG(ICONS.swords)}</span
          >`
        : nothing}
    </button>`;
  }

  private renderCrownMedallion(crown: WorldTheatre) {
    const anchor = WORLD_GRID_ANCHORS.crown;
    const display = frontDisplayState(crown, this.now);
    return html`<button
      type="button"
      class="wp-crown"
      data-state=${display}
      style="left:${anchor.x}%;top:${anchor.y}%;--banner:${this.bannerColor(
        crown.holder,
      )}"
      aria-label=${crown.holder === null
        ? translateText("world_page.crown_aria_vacant")
        : translateText("world_page.crown_aria", {
            holder: this.label(crown.holder),
          })}
      @click=${(event: Event) => {
        event.stopPropagation();
        this.openFront("crown");
      }}
    >
      <span class="wp-crown-icon">${CROWN_GLYPH}</span>
      <span class="wp-crown-ring">${this.emblem(crown.holder, 44)}</span>
      <span class="wp-crown-title"
        >${translateText("world_page.crown_title")}</span
      >
      <span class="wp-crown-holder"
        >${crown.holder === null
          ? translateText("world_page.crown_vacant")
          : this.label(crown.holder)}</span
      >
      ${display === "contested"
        ? html`<span class="wp-crown-siege"
            >${unsafeSVG(ICONS.swords)} ${this.label(crown.challenger)}</span
          >`
        : html`<span class="wp-crown-sub"
            >${translateText("world_page.crown_sub")}</span
          >`}
    </button>`;
  }

  // ------------------------------------------------------ legend and key

  /**
   * Who holds what, under the map. Below 1180 px there is no room for
   * placards on the map, so this is how a phone or tablet reads it: every
   * holder named in full, every front's state in words, each front one tap
   * from its history. Same order as the front page's legend.
   */
  private renderLegend(model: WorldModel) {
    const crown = crownFront(model);
    const crownHolder = crown?.holder ?? null;
    const open = frontsInState(model, "unclaimed", this.now);
    return html`<ul
      class="wp-legend"
      aria-label=${translateText("world_page.legend_aria")}
    >
      ${holderGroups(model).map(
        (group) =>
          html`<li>
            <span class="wp-legend-who"
              >${this.emblem(group.holder, 22)}${this.agentLink(
                group.holder,
                "wp-legend-name",
              )}</span
            ><span class="wp-legend-fronts"
              >${group.fronts.map((front) => this.legendFront(front))}</span
            >
          </li>`,
      )}
      ${crown !== null
        ? html`<li>
            <span class="wp-legend-who"
              >${this.emblem(crownHolder, 22)}${crownHolder === null
                ? html`<span class="wp-legend-name wp-legend-muted"
                    >${translateText("world_page.crown_vacant")}</span
                  >`
                : this.agentLink(crownHolder, "wp-legend-name")}</span
            ><span class="wp-legend-fronts">${this.legendFront(crown)}</span>
          </li>`
        : nothing}
      ${open.length > 0
        ? html`<li>
            <span class="wp-legend-who"
              ><i
                class="wp-sw wp-sw-flag wp-sw-open"
                style="--paint:${UNCLAIMED_HEX}"
              ></i
              ><span class="wp-legend-name wp-legend-muted"
                >${translateText("world_page.legend_never_fought")}</span
              ></span
            ><span class="wp-legend-fronts"
              >${open.map((front) => this.legendFront(front, false))}</span
            >
          </li>`
        : nothing}
    </ul>`;
  }

  /** One front in the legend: its map swatch, its name, its state in words. */
  private legendFront(front: WorldTheatre, withSwatch = true) {
    const display = frontDisplayState(front, this.now);
    const state =
      display === "contested"
        ? translateText("world_page.legend_siege")
        : display === "quiet"
          ? translateText("world_page.legend_quiet")
          : null;
    // The Crown holds no land, so it has nothing on the map to highlight.
    const onMap = front.id !== "crown";
    let mark: TemplateResult | typeof nothing = nothing;
    if (!onMap) {
      mark = html`<span class="wp-legend-front-crown">${CROWN_GLYPH}</span>`;
    } else if (withSwatch) {
      mark = html`<i
        class="wp-sw ${this.lowContrast(front.holder) ? "wp-low" : ""}"
        style="--paint:${this.swatch(front)}"
      ></i>`;
    }
    return html`<button
      type="button"
      class="wp-legend-front"
      @click=${() => this.openFront(front.id)}
      @pointerenter=${() => {
        if (onMap) this.hoverFront = front.id;
      }}
      @pointerleave=${() => {
        this.hoverFront = null;
      }}
      @focus=${() => {
        if (onMap) this.hoverFront = front.id;
      }}
      @blur=${() => {
        this.hoverFront = null;
      }}
    >
      ${mark}<span class="wp-legend-front-name"
        >${this.frontName(front.id)}</span
      >${state === null
        ? nothing
        : // A no-break space: a flex item drops a plain leading space.
          html`<span class="wp-legend-state">&nbsp;(${state})</span>`}
    </button>`;
  }

  /** How to read the map, with swatches painted like the map itself. */
  private renderKey(model: WorldModel) {
    const siege = clearestSiege(
      model,
      (name) => this.bannerColor(name),
      this.now,
    );
    const quiet = frontsInState(model, "quiet", this.now)[0] ?? null;
    const open = frontsInState(model, "unclaimed", this.now).length > 0;
    if (siege === null && quiet === null && !open) return nothing;
    return html`<p
      class="wp-key"
      aria-label=${translateText("world_page.key_aria")}
    >
      ${siege !== null
        ? html`<span
            ><i class="wp-sw" style="--paint:${this.swatch(siege)}"></i
            >${translateText("world_page.key_siege")}</span
          >`
        : nothing}
      ${quiet !== null
        ? html`<span
            ><i class="wp-sw" style="--paint:${this.swatch(quiet)}"></i
            >${translateText("world_page.key_quiet")}</span
          >`
        : nothing}
      ${open
        ? html`<span
            ><i class="wp-sw wp-sw-open" style="--paint:${UNCLAIMED_HEX}"></i
            >${translateText("world_page.key_open")}</span
          >`
        : nothing}
    </p>`;
  }

  // -------------------------------------------------------------- fronts

  private renderFronts(model: WorldModel) {
    const rank: Record<FrontDisplayState, number> = {
      contested: 0,
      held: 1,
      quiet: 2,
      unclaimed: 3,
    };
    const crown = model.theatres.find((theatre) => theatre.id === "crown");
    const regions = model.theatres
      .filter((theatre) => theatre.id !== "crown")
      .sort((a, b) => {
        const byState =
          rank[frontDisplayState(a, this.now)] -
          rank[frontDisplayState(b, this.now)];
        if (byState !== 0) return byState;
        return (b.lastBattleAt ?? "").localeCompare(a.lastBattleAt ?? "");
      });
    return html`<section
      class="wp-wrap wp-section"
      aria-labelledby="wp-fronts-title"
    >
      <div class="wp-section-head">
        <h2 id="wp-fronts-title" class="wp-section-title">
          ${translateText("world_page.fronts_title")}
        </h2>
        <p class="wp-section-intro">
          ${translateText("world_page.fronts_intro", {
            window: model.windowSize,
          })}
        </p>
      </div>
      <ul class="wp-front-grid" role="list">
        ${crown !== undefined ? this.renderFrontCard(crown, model) : nothing}
        ${regions.map((theatre) => this.renderFrontCard(theatre, model))}
      </ul>
    </section>`;
  }

  private renderFrontCard(theatre: WorldTheatre, model: WorldModel) {
    const display = frontDisplayState(theatre, this.now);
    const name = this.frontName(theatre.id);
    const thumb = this.thumbnail(theatre);
    const isCrown = theatre.id === "crown";
    const emptySlots = Math.max(0, model.windowSize - theatre.window.length);
    return html`<li
      class="wp-front ${isCrown ? "wp-front-crown" : ""}"
      data-state=${display}
      style="--banner:${this.bannerColor(
        theatre.holder,
      )};--rival:${this.bannerColor(theatre.challenger)}"
    >
      <button
        type="button"
        class="wp-front-hit"
        aria-label=${translateText("world_page.front_open", { front: name })}
        @click=${() => this.openFront(theatre.id)}
      ></button>
      <div class="wp-front-art" aria-hidden="true">
        ${thumb !== null
          ? html`<img
              src=${thumb}
              alt=""
              loading="lazy"
              decoding="async"
              @error=${(event: Event) => {
                (event.target as HTMLElement).hidden = true;
              }}
            />`
          : nothing}
      </div>
      <div class="wp-front-body">
        <div class="wp-front-head">
          <h3 class="wp-front-name">
            ${isCrown
              ? html`<span class="wp-front-crownicon">${CROWN_GLYPH}</span>`
              : nothing}${name}
          </h3>
          <span class="wp-chip" data-state=${display}
            >${translateText(STATUS_KEYS[display])}</span
          >
        </div>
        ${theatre.holder === null
          ? html`<p class="wp-front-empty">
              ${translateText("world_page.front_unclaimed_body", {
                maps: theatre.battlefields
                  .slice(0, 2)
                  .map((map) => this.battlefieldName(map))
                  .join(" / "),
              })}
            </p>`
          : html`<div class="wp-front-holder">
                ${this.emblem(theatre.holder, 30)}
                <div class="wp-front-holdertext">
                  <div class="wp-front-holdername">
                    ${this.agentLink(theatre.holder)}
                  </div>
                  <div class="wp-front-since">
                    ${theatre.heldSince !== null
                      ? translateText("world_page.front_held_since", {
                          date: this.date(theatre.heldSince),
                        })
                      : nothing}
                  </div>
                </div>
              </div>
              <p class="wp-front-line">
                ${this.contestLine(theatre, display)}
              </p>`}
        ${theatre.battleCount > 0
          ? html`<ol
              class="wp-form"
              aria-label=${translateText("world_page.front_form", {
                count: model.windowSize,
              })}
            >
              ${Array.from(
                { length: emptySlots },
                () => html`<li class="wp-form-empty"></li>`,
              )}
              ${theatre.window.map((battle) => this.renderFormCell(battle))}
            </ol>`
          : nothing}
        <p class="wp-front-foot">
          ${theatre.battleCount > 0
            ? html`${translateText("world_page.front_battles", {
                count: theatre.battleCount,
              })}
              ·
              ${translateText("world_page.front_last_battle", {
                age: this.age(theatre.lastBattleAt),
              })}`
            : translateText("world_page.front_no_battles")}
        </p>
      </div>
    </li>`;
  }

  private contestLine(theatre: WorldTheatre, display: FrontDisplayState) {
    if (theatre.challenger === null) {
      return translateText("world_page.front_unchallenged", {
        wins: theatre.holderWins,
        window: this.model?.windowSize ?? 0,
      });
    }
    if (display === "contested") {
      return html`<span class="wp-siege-line"
        >${unsafeSVG(ICONS.swords)}${translateText("world_page.front_level", {
          challenger: this.label(theatre.challenger),
          wins: theatre.holderWins,
        })}</span
      >`;
    }
    return translateText("world_page.front_lead", {
      holderWins: theatre.holderWins,
      challengerWins: theatre.challengerWins,
      challenger: this.label(theatre.challenger),
    });
  }

  private renderFormCell(battle: WorldBattle) {
    const title = `${this.date(battle.at, true)} · ${this.battlefieldName(battle.map)} · ${this.label(battle.winner)}`;
    return html`<li>
      <a
        href=${battle.href}
        class="wp-form-cell ${battle.winner === null ? "wp-form-nowin" : ""}"
        style="--c:${this.bannerColor(battle.winner)}"
        title=${title}
        aria-label=${title}
      ></a>
    </li>`;
  }

  // -------------------------------------------------------------- dispatches

  private renderDispatches(model: WorldModel) {
    const events = this.dispatchesExpanded
      ? model.events
      : model.events.slice(0, DISPATCHES_COLLAPSED);
    return html`<section class="wp-panel" aria-labelledby="wp-dispatches-title">
      <h2 id="wp-dispatches-title" class="wp-section-title">
        ${translateText("world_page.dispatches_title")}
      </h2>
      ${model.events.length === 0
        ? html`<p class="wp-muted">
            ${translateText("world_page.dispatches_empty")}
          </p>`
        : html`<ol class="wp-dispatches" role="list">
            ${events.map((event) => this.renderDispatch(event, model))}
          </ol>`}
      ${model.events.length > DISPATCHES_COLLAPSED
        ? html`<button
            type="button"
            class="wp-more"
            @click=${() => {
              this.dispatchesExpanded = !this.dispatchesExpanded;
            }}
          >
            ${this.dispatchesExpanded
              ? translateText("world_page.dispatches_less")
              : translateText("world_page.dispatches_more", {
                  count: model.events.length,
                })}
          </button>`
        : nothing}
    </section>`;
  }

  private renderDispatch(event: WorldEvent, model: WorldModel) {
    const front = this.frontName(event.theatreId);
    const agent = this.label(event.agent);
    const rival = this.label(event.rival);
    const isCrown = event.theatreId === "crown";
    let icon: TemplateResult;
    let title: string;
    let detail: string;
    switch (event.kind) {
      case "conquest":
        title = isCrown
          ? translateText("world_page.event_conquest_crown", { agent, rival })
          : translateText("world_page.event_conquest", { agent, front, rival });
        detail = translateText("world_page.event_detail_conquest", {
          agentWins: event.agentWins,
          rivalWins: event.rivalWins,
          window: model.windowSize,
        });
        icon = isCrown ? CROWN_GLYPH : html`${unsafeSVG(ICONS.flag)}`;
        break;
      case "siege":
        title = translateText("world_page.event_siege", { agent, front });
        detail = translateText("world_page.event_detail_siege", {
          rival,
          wins: event.agentWins,
        });
        icon = html`${unsafeSVG(ICONS.swords)}`;
        break;
      case "held":
        title = translateText("world_page.event_held", { agent, front });
        detail = translateText("world_page.event_detail_held", {
          rival,
          agentWins: event.agentWins,
          rivalWins: event.rivalWins,
        });
        icon = html`${unsafeSVG(ICONS.shield)}`;
        break;
      default:
        title = translateText("world_page.event_claim", { agent, front });
        detail = translateText("world_page.event_detail_claim");
        icon = html`${unsafeSVG(ICONS.pin)}`;
    }
    return html`<li
      class="wp-dispatch"
      data-kind=${event.kind}
      style="--banner:${this.bannerColor(event.agent)}"
    >
      <span class="wp-dispatch-icon">${icon}</span>
      <div class="wp-dispatch-body">
        <p class="wp-dispatch-title">${title}</p>
        <p class="wp-dispatch-detail">${detail}</p>
        <p class="wp-dispatch-detail">${this.battlefieldName(event.map)}</p>
      </div>
      <div class="wp-dispatch-meta">
        <time datetime=${event.at} title=${this.date(event.at, true)}
          >${this.age(event.at)}</time
        >
        <a href=${event.href} class="wp-dispatch-link"
          >${translateText("world_page.event_battle_link")}</a
        >
      </div>
    </li>`;
  }

  // -------------------------------------------------------------- powers

  private renderPowers(model: WorldModel) {
    const crownHolder = this.theatre("crown")?.holder ?? null;
    const rows = model.agents
      .filter(
        (agent) =>
          agent.theatres.some((id) => id !== "crown") ||
          agent.name === crownHolder,
      )
      .concat(
        model.agents
          .filter(
            (agent) =>
              !agent.theatres.some((id) => id !== "crown") &&
              agent.name !== crownHolder,
          )
          .sort(
            (a, b) => b.conquests - a.conquests || b.battlesWon - a.battlesWon,
          )
          .slice(0, 4),
      );
    return html`<section class="wp-panel" aria-labelledby="wp-powers-title">
      <h2 id="wp-powers-title" class="wp-section-title">
        ${translateText("world_page.powers_title")}
      </h2>
      <table class="wp-powers">
        <thead>
          <tr>
            <th scope="col">${translateText("world_page.powers_agent")}</th>
            <th scope="col">${translateText("world_page.powers_fronts")}</th>
            <th scope="col" class="wp-num wp-powers-conquests">
              ${translateText("world_page.powers_conquests")}
            </th>
            <th scope="col" class="wp-num">
              ${translateText("world_page.powers_wins")}
            </th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((agent) => {
            const fronts = agent.theatres.filter((id) => id !== "crown");
            return html`<tr style="--banner:${this.bannerColor(agent.name)}">
              <th scope="row">
                <span class="wp-power-agent">
                  ${this.emblem(agent.name, 26)} ${this.agentLink(agent.name)}
                  ${agent.name === crownHolder
                    ? html`<span
                        class="wp-power-crown"
                        title=${translateText("world_page.powers_crown")}
                        >${CROWN_GLYPH}</span
                      >`
                    : nothing}
                </span>
              </th>
              <td>
                ${fronts.length === 0
                  ? html`<span class="wp-muted">—</span>`
                  : html`<span class="wp-front-chips"
                      >${fronts.map(
                        (id) =>
                          html`<button
                            type="button"
                            class="wp-front-chip"
                            @click=${() => this.openFront(id)}
                          >
                            ${this.frontName(id)}
                          </button>`,
                      )}</span
                    >`}
              </td>
              <td class="wp-num wp-powers-conquests">${agent.conquests}</td>
              <td class="wp-num">${agent.battlesWon}</td>
            </tr>`;
          })}
        </tbody>
      </table>
    </section>`;
  }

  // -------------------------------------------------------------- history

  private renderHistory(model: WorldModel) {
    const days = model.timeline;
    if (days.length < 2) return nothing;
    const regionIds = WORLD_REGION_IDS as readonly string[];
    const totals = new Map<string, number>();
    for (const day of days) {
      for (const [id, holder] of Object.entries(day.holders)) {
        if (holder === null || !regionIds.includes(id)) continue;
        totals.set(holder, (totals.get(holder) ?? 0) + 1);
      }
    }
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([name]) => name);
    const series = [...top, "__others"];
    const width = 1000;
    const height = 220;
    const n = days.length;
    const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * width);
    const y = (value: number) => height - (value / regionIds.length) * height;
    const stacks: number[][] = days.map((day) => {
      const counts = series.map(() => 0);
      for (const [id, holder] of Object.entries(day.holders)) {
        if (holder === null || !regionIds.includes(id)) continue;
        const index = top.indexOf(holder);
        counts[index === -1 ? series.length - 1 : index] += 1;
      }
      return counts;
    });
    const layers = series.map((name, s) => {
      const lower = stacks.map((counts) =>
        counts.slice(0, s).reduce((a, b) => a + b, 0),
      );
      const upper = stacks.map((counts, i) => lower[i] + counts[s]);
      let d = `M${x(0)},${y(upper[0])}`;
      for (let i = 1; i < n; i++)
        d += ` L${x(i).toFixed(1)},${y(upper[i]).toFixed(1)}`;
      for (let i = n - 1; i >= 0; i--)
        d += ` L${x(i).toFixed(1)},${y(lower[i]).toFixed(1)}`;
      return { name, d: `${d} Z` };
    });
    const crownColor = (holder: string | null | undefined) =>
      holder ? this.bannerColor(holder) : "rgba(148,163,184,0.18)";
    const hover = this.historyIndex;
    const hoverDay = hover === null ? null : days[hover];
    return html`<section
      class="wp-wrap wp-section"
      aria-labelledby="wp-history-title"
    >
      <div class="wp-section-head">
        <h2 id="wp-history-title" class="wp-section-title">
          ${translateText("world_page.history_title")}
        </h2>
        <p class="wp-section-intro">
          ${translateText("world_page.history_intro")}
        </p>
      </div>
      <div class="wp-history">
        <div class="wp-history-chart">
          <svg
            viewBox="0 0 ${width} ${height + 26}"
            preserveAspectRatio="none"
            role="img"
            aria-label=${translateText("world_page.history_aria")}
            @pointermove=${(event: PointerEvent) => {
              const rect = (
                event.currentTarget as SVGElement
              ).getBoundingClientRect();
              const index = Math.round(
                ((event.clientX - rect.left) / rect.width) * (n - 1),
              );
              this.historyIndex = Math.max(0, Math.min(n - 1, index));
            }}
            @pointerleave=${() => {
              this.historyIndex = null;
            }}
          >
            ${days.map(
              (day, i) =>
                svg`<rect x=${x(i) - width / n / 2} y="0" width=${width / n + 0.5} height="12" style="fill:${crownColor(day.holders.crown)}"></rect>`,
            )}
            <g transform="translate(0 26)">
              ${[0.25, 0.5, 0.75].map(
                (f) =>
                  svg`<line class="wp-history-grid" x1="0" x2=${width} y1=${height * f} y2=${height * f}></line>`,
              )}
              ${layers.map(
                (layer) =>
                  svg`<path d=${layer.d} style="fill:${layer.name === "__others" ? "rgba(148,163,184,0.28)" : this.bannerColor(layer.name)}" class="wp-history-layer"></path>`,
              )}
              ${hover !== null
                ? svg`<line class="wp-history-cursor" x1=${x(hover)} x2=${x(hover)} y1="0" y2=${height}></line>`
                : nothing}
            </g>
          </svg>
          <div class="wp-history-axis">
            <span>${this.date(days[0].day + "T12:00:00Z")}</span>
            <span>${this.date(days[n - 1].day + "T12:00:00Z")}</span>
          </div>
          ${hoverDay !== null && hover !== null
            ? html`<div
                class="wp-history-tip"
                style="left:${Math.min(
                  86,
                  Math.max(14, (hover / Math.max(1, n - 1)) * 100),
                )}%"
              >
                <b>${this.date(hoverDay.day + "T12:00:00Z")}</b>
                ${hoverDay.holders.crown
                  ? html`<span class="wp-tip-row"
                      >${CROWN_GLYPH}
                      ${this.label(hoverDay.holders.crown)}</span
                    >`
                  : nothing}
                ${this.tipRows(hoverDay.holders)}
              </div>`
            : nothing}
        </div>
        <ul class="wp-history-legend" role="list">
          <li>
            <i class="wp-legend-crown"></i>${translateText(
              "world_page.history_crown",
            )}
          </li>
          ${top.map(
            (name) =>
              html`<li>
                <i style="background:${this.bannerColor(name)}"></i
                >${this.label(name)}
              </li>`,
          )}
          ${totals.size > top.length
            ? html`<li>
                <i class="wp-legend-others"></i>${translateText(
                  "world_page.history_others",
                )}
              </li>`
            : nothing}
        </ul>
      </div>
    </section>`;
  }

  private tipRows(holders: Record<string, string | null>) {
    const counts = new Map<string, number>();
    for (const [id, holder] of Object.entries(holders)) {
      if (holder === null || id === "crown") continue;
      counts.set(holder, (counts.get(holder) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(
        ([name, count]) =>
          html`<span class="wp-tip-row"
            ><i style="background:${this.bannerColor(name)}"></i>${this.label(
              name,
            )} <b>${count}</b></span
          >`,
      );
  }

  // -------------------------------------------------------------- rules

  private renderRules(model: WorldModel) {
    return html`<section
      class="wp-wrap wp-section"
      aria-labelledby="wp-rules-title"
    >
      <div class="wp-section-head">
        <h2 id="wp-rules-title" class="wp-section-title">
          ${translateText("world_page.rules_title")}
        </h2>
      </div>
      <div class="wp-rules">
        <article class="wp-rule">
          <span class="wp-rule-icon">${unsafeSVG(ICONS.pin)}</span>
          <h3>${translateText("world_page.rule_place_title")}</h3>
          <p>${translateText("world_page.rule_place_body")}</p>
        </article>
        <article class="wp-rule">
          <span class="wp-rule-icon">${unsafeSVG(ICONS.flag)}</span>
          <h3>
            ${translateText("world_page.rule_window_title", {
              window: model.windowSize,
            })}
          </h3>
          <p>
            ${translateText("world_page.rule_window_body", {
              window: model.windowSize,
            })}
          </p>
        </article>
        <article class="wp-rule">
          <span class="wp-rule-icon wp-rule-icon-crown">${CROWN_GLYPH}</span>
          <h3>${translateText("world_page.rule_crown_title")}</h3>
          <p>${translateText("world_page.rule_crown_body")}</p>
        </article>
      </div>
      ${model.firstBattleAt !== null
        ? html`<p class="wp-data-note">
            ${translateText("world_page.data_note", {
              count: model.battleCount,
              date: this.date(model.firstBattleAt),
            })}
          </p>`
        : nothing}
    </section>`;
  }

  // -------------------------------------------------------------- drawer

  private renderDrawer(id: WorldTheatreId) {
    const theatre = this.theatre(id);
    const model = this.model;
    if (theatre === undefined || model === null) return nothing;
    const display = frontDisplayState(theatre, this.now);
    const name = this.frontName(id);
    const thumb = this.thumbnail(theatre);
    const maxTally = Math.max(1, ...theatre.tallies.map((tally) => tally.wins));
    const reign = theatre.reigns.find((entry) => entry.to === null);
    return html`<div
        class="wp-drawer-backdrop"
        @click=${() => this.closeFront()}
      ></div>
      <aside
        class="wp-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wp-drawer-title"
        data-state=${display}
        style="--banner:${this.bannerColor(
          theatre.holder,
        )};--rival:${this.bannerColor(theatre.challenger)}"
      >
        <div class="wp-drawer-art" aria-hidden="true">
          ${thumb !== null
            ? html`<img
                src=${thumb}
                alt=""
                @error=${(event: Event) => {
                  (event.target as HTMLElement).hidden = true;
                }}
              />`
            : nothing}
        </div>
        <header class="wp-drawer-head">
          <div>
            <span class="wp-chip" data-state=${display}
              >${translateText(STATUS_KEYS[display])}</span
            >
            <h2 id="wp-drawer-title" class="wp-drawer-title">${name}</h2>
          </div>
          <button
            type="button"
            class="wp-drawer-close"
            aria-label=${translateText("world_page.detail_close")}
            @click=${() => this.closeFront()}
          >
            ${unsafeSVG(ICONS.close)}
          </button>
        </header>
        <div class="wp-drawer-body">
          ${theatre.holder === null
            ? html`<p class="wp-front-empty">
                ${translateText("world_page.front_unclaimed_body", {
                  maps: theatre.battlefields
                    .slice(0, 2)
                    .map((map) => this.battlefieldName(map))
                    .join(" / "),
                })}
              </p>`
            : html`<div class="wp-drawer-holder">
                  ${this.emblem(theatre.holder, 56)}
                  <div>
                    <div class="wp-kicker">
                      ${translateText("world_page.detail_holder")}
                    </div>
                    <div class="wp-drawer-holdername">
                      ${this.agentLink(theatre.holder)}
                    </div>
                    <div class="wp-front-since">
                      ${theatre.heldSince !== null
                        ? translateText("world_page.front_held_since", {
                            date: this.date(theatre.heldSince),
                          })
                        : nothing}
                      ${reign !== undefined
                        ? html` ·
                          ${translateText("world_page.detail_reign", {
                            wins: reign.wins,
                            battles: reign.battles,
                          })}`
                        : nothing}
                    </div>
                  </div>
                </div>
                <p class="wp-front-line">
                  ${this.contestLine(theatre, display)}
                </p>`}
          ${theatre.tallies.length > 0
            ? html`<h3 class="wp-drawer-sub">
                  ${translateText("world_page.detail_tally", {
                    window: model.windowSize,
                  })}
                </h3>
                <ul class="wp-tally" role="list">
                  ${theatre.tallies.map(
                    (tally) =>
                      html`<li style="--banner:${this.bannerColor(tally.name)}">
                        <span class="wp-tally-name"
                          >${this.emblem(tally.name, 18)}
                          ${this.agentLink(tally.name)}</span
                        >
                        <span class="wp-tally-bar"
                          ><i
                            style="width:${(tally.wins / maxTally) * 100}%"
                          ></i
                        ></span>
                        <b>${tally.wins}</b>
                      </li>`,
                  )}
                </ul>`
            : nothing}
          ${theatre.window.length > 0
            ? html`<h3 class="wp-drawer-sub">
                  ${translateText("world_page.detail_battles", {
                    count: theatre.window.length,
                  })}
                </h3>
                <ol class="wp-battles" role="list">
                  ${[...theatre.window].reverse().map(
                    (battle) =>
                      html`<li
                        style="--banner:${this.bannerColor(battle.winner)}"
                      >
                        <a href=${battle.href} class="wp-battle">
                          <span class="wp-battle-when"
                            >${this.date(battle.at, true)}</span
                          >
                          <span class="wp-battle-map"
                            >${this.battlefieldName(battle.map)}</span
                          >
                          <span class="wp-battle-winner"
                            >${battle.winner !== null
                              ? this.emblem(battle.winner, 16)
                              : nothing}
                            ${this.label(battle.winner)}</span
                          >
                        </a>
                      </li>`,
                  )}
                </ol>`
            : nothing}
          ${theatre.reigns.length > 0
            ? html`<h3 class="wp-drawer-sub">
                  ${translateText("world_page.detail_reigns")}
                </h3>
                <ol class="wp-reigns" role="list">
                  ${theatre.reigns.map(
                    (entry) =>
                      html`<li
                        style="--banner:${this.bannerColor(entry.holder)}"
                      >
                        ${this.emblem(entry.holder, 20)}
                        <span class="wp-reign-name"
                          >${this.label(entry.holder)}</span
                        >
                        <span class="wp-reign-span"
                          >${this.date(entry.from)} –
                          ${entry.to === null
                            ? translateText("world_page.detail_reign_now")
                            : this.date(entry.to)}</span
                        >
                        <span class="wp-reign-record"
                          >${translateText("world_page.detail_reign", {
                            wins: entry.wins,
                            battles: entry.battles,
                          })}</span
                        >
                      </li>`,
                  )}
                </ol>`
            : nothing}
          ${theatre.maps.length > 0
            ? html`<p class="wp-drawer-maps">
                ${translateText("world_page.detail_battlefields", {
                  maps: theatre.maps
                    .map(
                      (entry) =>
                        `${this.battlefieldName(entry.map)} (${entry.battles})`,
                    )
                    .join(", "),
                })}
              </p>`
            : nothing}
        </div>
      </aside>`;
  }
}

const WORLD_PAGE_CSS = `
:where(.wp-root) .crown-glyph{display:block;width:100%;height:100%}
.wp-root{--wp-ocean:#071225;--wp-ink:#edf1f7;--wp-dim:#a4afbf;--wp-faint:#6f7d90;--wp-line:rgba(148,170,200,.14);--wp-glass:rgba(8,15,28,.78);--wp-display:"PW Overpass",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
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
.wp-label-siege{display:inline-flex;width:18px;height:18px;padding:3px;border-radius:50%;background:var(--rival);color:#0b1220}
.wp-label-siege svg{width:100%;height:100%}
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
.wp-crown-siege{display:inline-flex;align-items:center;gap:.25rem;font-size:11.5px;color:var(--wp-ink)}
.wp-crown-siege svg{width:12px;height:12px}
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
.wp-legend-front-name{text-decoration:underline;text-decoration-color:#46556c;text-underline-offset:3px}
.wp-legend-front:hover .wp-legend-front-name{text-decoration-color:var(--wp-ink)}
.wp-legend-front:focus-visible{outline:2px solid var(--wp-ink);outline-offset:2px}
.wp-legend-state{color:var(--wp-dim)}
.wp-legend-front-crown{display:inline-flex;width:14px;height:8px;margin-right:6px;color:var(--wp-ink)}
.wp-section{padding-top:clamp(36px,5vw,56px)}
.wp-section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1.5rem;margin-bottom:1rem}
.wp-section-title{margin:0;font:700 24px/1.2 var(--wp-display);color:var(--wp-ink)}
.wp-section-intro{margin:0;max-width:60ch;font-size:14px;color:var(--wp-dim)}
.wp-front-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px;margin:0;padding:0;list-style:none}
.wp-front{position:relative;display:flex;flex-direction:column;min-width:0;border-radius:14px;overflow:hidden;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));border:1px solid var(--wp-line);transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease}
.wp-front:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--banner) 55%,transparent);box-shadow:0 18px 40px -26px color-mix(in srgb,var(--banner) 70%,transparent)}
.wp-front-hit{position:absolute;inset:0;z-index:1;background:none;border:0;cursor:pointer;border-radius:14px}
.wp-front-hit:focus-visible{outline:2px solid var(--banner);outline-offset:-2px}
.wp-front a{position:relative;z-index:2}
.wp-front-art{position:relative;height:96px;background:linear-gradient(135deg,color-mix(in srgb,var(--banner) 30%,#0b1a33),#0a1628);overflow:hidden}
.wp-front-art img{width:100%;height:100%;object-fit:cover;opacity:.55;filter:saturate(.9) contrast(1.05);transform:scale(1.04);transition:transform .5s ease,opacity .3s}
.wp-front:hover .wp-front-art img{transform:scale(1.09);opacity:.68}
.wp-front-art::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 20%,rgba(10,22,40,.92)),linear-gradient(90deg,color-mix(in srgb,var(--banner) 34%,transparent),transparent 70%)}
.wp-front[data-state="contested"] .wp-front-art::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;z-index:1;background:repeating-linear-gradient(90deg,var(--banner) 0 14px,var(--rival) 14px 28px);background-size:28px 4px}
.wp-front[data-state="quiet"] .wp-front-art img,.wp-front[data-state="unclaimed"] .wp-front-art img{filter:grayscale(.85) brightness(.8)}
.wp-front[data-state="unclaimed"] .wp-front-art{background:linear-gradient(135deg,#1b2433,#0a1628)}
.wp-front-body{display:flex;flex-direction:column;gap:.55rem;padding:.2rem 1rem 1rem;margin-top:-34px;position:relative}
.wp-front-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.wp-front-name{margin:0;display:flex;align-items:center;gap:.4rem;font:700 18px/1.15 var(--wp-display);color:var(--wp-ink);text-shadow:0 1px 8px rgba(0,0,0,.6)}
.wp-front-crownicon{display:inline-flex;width:18px;height:10px;color:var(--wp-ink)}
.wp-chip{display:inline-flex;align-items:center;padding:.15rem .5rem;border-radius:2px;font:700 12px/1.3 var(--wp-display);border:1px solid var(--wp-line);color:var(--wp-dim);background:rgba(6,12,22,.7);white-space:nowrap}
.wp-chip[data-state="held"]{color:color-mix(in srgb,var(--banner) 80%,#fff);border-color:color-mix(in srgb,var(--banner) 50%,transparent)}
.wp-chip[data-state="contested"]{color:var(--wp-ink);border-color:var(--wp-dim)}
.wp-chip[data-state="quiet"]{color:#cbd5e1}
.wp-front-holder{display:flex;align-items:center;gap:.65rem;min-width:0}
.wp-front-holdertext{flex:1;min-width:0}
.wp-front-holdername{font:700 15px/1.2 var(--wp-display);color:var(--wp-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-agent-link{color:inherit;text-decoration:none;position:relative;z-index:2}
.wp-agent-link:hover{text-decoration:underline;text-decoration-color:var(--banner,currentColor);text-underline-offset:3px}
.wp-front-since{font-size:12px;color:var(--wp-faint)}
.wp-front-line{margin:0;font-size:13px;color:var(--wp-dim)}
.wp-siege-line{display:inline-flex;align-items:center;gap:.35rem;color:#fecaca}
.wp-siege-line svg{width:14px;height:14px;flex:none}
.wp-front-empty{margin:.2rem 0 0;font-size:13px;color:var(--wp-faint)}
.wp-form{display:grid;grid-template-columns:repeat(12,1fr);gap:3px;margin:.1rem 0 0;padding:0;list-style:none}
.wp-form li{min-width:0}
.wp-form-cell,.wp-form-empty{display:block;height:14px;border-radius:3px}
.wp-form-cell{background:var(--c);box-shadow:inset 0 -2px 0 rgba(0,0,0,.25);transition:transform .15s}
.wp-form-cell:hover{transform:scaleY(1.35)}
.wp-form-nowin{background:transparent;box-shadow:inset 0 0 0 1px rgba(148,163,184,.4)}
.wp-form-empty{background:rgba(148,163,184,.06)}
.wp-front-foot{margin:0;font-size:11.5px;color:var(--wp-faint);font-variant-numeric:tabular-nums}
.wp-front-crown{border-color:color-mix(in srgb,var(--banner) 45%,transparent)}
.wp-columns{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:18px;padding-top:clamp(36px,5vw,56px)}
@media (max-width:900px){.wp-columns{grid-template-columns:minmax(0,1fr)}}
.wp-panel{min-width:0;padding:1.1rem 1.1rem 1rem;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid var(--wp-line)}
.wp-panel .wp-section-title{margin-bottom:.8rem}
.wp-dispatches{margin:0;padding:0;list-style:none}
.wp-dispatch{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:.75rem;align-items:start;padding:.75rem 0;border-top:1px solid var(--wp-line)}
.wp-dispatch:first-child{border-top:0;padding-top:.2rem}
.wp-dispatch-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:color-mix(in srgb,var(--banner) 18%,transparent);color:var(--banner);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--banner) 40%,transparent)}
.wp-dispatch-icon svg{width:18px;height:18px}
.wp-dispatch[data-kind="siege"] .wp-dispatch-icon{color:#fca5a5;background:rgba(239,68,68,.12);box-shadow:inset 0 0 0 1px rgba(239,68,68,.35)}
.wp-dispatch-title{margin:0;font:700 14px/1.3 var(--wp-display);color:var(--wp-ink)}
.wp-dispatch-detail{margin:.15rem 0 0;font-size:12.5px;color:var(--wp-faint)}
.wp-dispatch-meta{display:flex;flex-direction:column;align-items:flex-end;gap:.3rem;font-size:12px;color:var(--wp-faint);white-space:nowrap;font-variant-numeric:tabular-nums}
.wp-dispatch-link{display:inline-flex;align-items:center;min-height:32px;color:var(--wp-ink);text-decoration:underline;text-decoration-color:#5b6b82;text-underline-offset:3px;font-weight:700}
.wp-dispatch-link:hover{text-decoration-color:var(--wp-ink)}
.wp-more{margin-top:.6rem;background:none;border:1px solid var(--wp-line);border-radius:8px;padding:.45rem .8rem;color:var(--wp-dim);font-size:12.5px;cursor:pointer}
.wp-more:hover{color:var(--wp-ink);border-color:rgba(148,170,200,.35)}
.wp-muted{color:var(--wp-faint);font-size:13px}
.wp-powers{width:100%;border-collapse:collapse;font-size:13px}
.wp-powers th,.wp-powers td{padding:.55rem .35rem;border-top:1px solid var(--wp-line);text-align:left;vertical-align:middle;font-weight:400}
.wp-powers thead th{border-top:0;font:400 13px/1.2 var(--wp-display);color:var(--wp-dim);padding-top:0}
.wp-powers tbody th{font-weight:700;color:var(--wp-ink);overflow-wrap:anywhere}
.wp-num{text-align:right!important;font-variant-numeric:tabular-nums;color:var(--wp-dim)}
.wp-power-agent{display:inline-flex;align-items:center;gap:.5rem;min-width:0}
.wp-power-crown{display:inline-flex;width:16px;height:9px;color:var(--wp-ink)}
.wp-front-chips{display:flex;flex-wrap:wrap;gap:.25rem}
.wp-front-chip{padding:.18rem .45rem;border-radius:6px;border:1px solid color-mix(in srgb,var(--banner) 45%,transparent);background:color-mix(in srgb,var(--banner) 12%,transparent);color:var(--wp-ink);font-size:11.5px;cursor:pointer;white-space:nowrap}
.wp-front-chip:hover{background:color-mix(in srgb,var(--banner) 24%,transparent)}
.wp-history{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:16px;padding:1rem;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid var(--wp-line)}
@media (max-width:820px){.wp-history{grid-template-columns:minmax(0,1fr)}}
.wp-history-chart{position:relative;min-width:0}
.wp-history-chart svg{display:block;width:100%;height:260px}
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
.wp-history-legend li{display:flex;align-items:center;gap:.5rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-history-legend i{width:12px;height:12px;border-radius:3px;flex:none}
.wp-legend-crown{background:none;box-shadow:inset 0 0 0 2px var(--wp-ink);border-radius:50%!important}
.wp-legend-others{background:rgba(148,163,184,.35)}
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
.wp-drawer-holdername{font:700 20px/1.2 var(--wp-display);color:var(--wp-ink)}
.wp-drawer-sub{margin:.8rem 0 .1rem;font:700 15px/1.3 var(--wp-display);color:var(--wp-ink)}
.wp-tally{display:flex;flex-direction:column;gap:.4rem;margin:0;padding:0;list-style:none}
.wp-tally li{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) 24px;align-items:center;gap:.6rem;font-size:13px;color:var(--wp-ink)}
.wp-tally-name{display:inline-flex;align-items:center;gap:.4rem;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wp-tally-bar{height:8px;border-radius:99px;background:rgba(148,163,184,.12);overflow:hidden}
.wp-tally-bar i{display:block;height:100%;border-radius:99px;background:var(--banner)}
.wp-tally b{text-align:right;font-variant-numeric:tabular-nums}
.wp-battles,.wp-reigns{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.wp-battle{display:grid;grid-template-columns:122px minmax(0,1fr) minmax(0,1.2fr);align-items:center;gap:.6rem;padding:.5rem .4rem;border-radius:8px;color:var(--wp-ink);text-decoration:none;font-size:12.5px;border-left:3px solid var(--banner)}
.wp-battle:hover{background:rgba(255,255,255,.04)}
.wp-battle-when{color:var(--wp-faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.wp-battle-map{color:var(--wp-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-battle-winner{display:inline-flex;align-items:center;gap:.35rem;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600}
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
@media (max-width:640px){.wp-battle{grid-template-columns:104px minmax(0,1fr)}.wp-battle-map{display:none}.wp-powers-conquests{display:none}}
@media (prefers-reduced-motion:reduce){.wp-root *{animation:none!important;transition:none!important}}
`;
