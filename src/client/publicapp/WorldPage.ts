import {
  html,
  LitElement,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  requestUpdateWhenTranslationsReady,
} from "./AppShellChrome";
import { contrastRatio, type RegionFront } from "./HomePresentation";
import { renderDispatches } from "./WorldDispatches";
import { renderDrawer } from "./WorldDrawer";
import { renderFronts, unclaimedLine } from "./WorldFronts";
import { renderHistory, type HistoryFocus } from "./WorldHistory";
import { renderKey, renderLegend } from "./WorldLegend";
import {
  WORLD_GRID_ANCHORS,
  WORLD_GRID_HEIGHT,
  WORLD_GRID_WIDTH,
} from "./WorldMapGrid";
import { pixelMapWidth, separateLabels } from "./WorldMapLayout";
import { paintWorldFrame, theatreAtPoint } from "./WorldMapRenderer";
import {
  fetchWorldModel,
  type WorldAgent,
  type WorldModel,
  type WorldTheatre,
  type WorldTheatreId,
} from "./WorldModelSchema";
import { ensureWorldStyles } from "./WorldPageStyles";
import { renderPlacards, type PlacardView } from "./WorldPlacards";
import { renderPowers } from "./WorldPowers";
import {
  assignBannerColors,
  changedSinceVisit,
  feedState,
  frontDisplayState,
  frontPaints,
  frontSwatch,
  parseVisitSnapshot,
  visitSnapshot,
  WORLD_REGION_IDS,
} from "./WorldPresentation";
import { renderRules } from "./WorldRules";
import {
  battlefieldName,
  contextLine,
  formatAge,
  formatDate,
  formatList,
  modeKey,
} from "./WorldText";
import {
  leadUnderline,
  renderSupport,
  renderVerdict,
  verdictLength,
  type VerdictView,
} from "./WorldVerdict";
import { ICONS, type WorldView } from "./WorldView";

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
/** Ages, live/paused and quiet fronts move with the clock, not only with data. */
const CLOCK_MS = 30 * 1000;
const REVEAL_MS = 1400;
const FRAME_MS = 40;
const VISIT_KEY = "proxywar.world.lastVisit";
/** The map stops growing here; past it the page has margins. */
const STAGE_MAX_WIDTH = 1440;
/** The ocean behind the map; banners darker than 3:1 on it get an ink edge. */
const OCEAN = "#071225";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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

@customElement("world-page")
export class WorldPage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private model: WorldModel | null = null;
  @state() private hoverFront: WorldTheatreId | null = null;
  @state() private selected: WorldTheatreId | null = null;
  @state() private changed: WorldTheatreId[] = [];
  @state() private sinceVisitAt: string | null = null;
  @state() private dispatchesExpanded = false;
  @state() private historyFocus: HistoryFocus | null = null;
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
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private mapVisible = true;
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private returnFocus: HTMLElement | null = null;
  /** Whether the open sheet slides in: only when someone can watch it. */
  private drawerAnimates = false;

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
    this.clockTimer = setInterval(() => {
      if (document.visibilityState === "visible") this.now = Date.now();
    }, CLOCK_MS);
    window.addEventListener("hashchange", this.onHashChange);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.revealTimer !== null) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("hashchange", this.onHashChange);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private async load(initial: boolean): Promise<void> {
    if (initial) this.loadState = "loading";
    try {
      const model = await fetchWorldModel();
      this.now = Date.now();
      if (!initial && this.model?.generatedAt === model.generatedAt) return;
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
      document.title = translateText("world_page.document_title");
    } catch {
      if (initial || this.model === null) this.loadState = "error";
    }
  }

  protected updated(changed: PropertyValues): void {
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
    const wrap = this.querySelector<HTMLElement>(".wp-stage-wrap");
    if (
      wrap !== null &&
      this.resizeObserver === null &&
      "ResizeObserver" in window
    ) {
      this.resizeObserver = new ResizeObserver(() => this.layoutMap());
      this.resizeObserver.observe(wrap);
      void document.fonts?.ready.then(() => this.layoutMap());
    }
    // Hovering only highlights; anything else may change the text (data,
    // the clock, translations arriving late), so measure and title again.
    const hoverOnly =
      changed.size > 0 &&
      [...changed.keys()].every(
        (key) => key === "hoverFront" || key === "historyFocus",
      );
    if (!hoverOnly) {
      this.layoutMap();
      document.title = translateText("world_page.document_title");
    }
    // The map repaints only when what it shows changes.
    if (
      changed.has("model") ||
      changed.has("loadState") ||
      changed.has("hoverFront") ||
      changed.has("changed") ||
      changed.has("now")
    ) {
      this.paint(performance.now());
    }
    this.schedule();
  }

  /**
   * Whole tile multiples when the width is close to one, so every tile is
   * the same size and the siege hatching never shimmers; then labels are
   * pushed apart where they overlap and kept on screen. The hero clips the
   * few pixels of ocean a snapped map overhangs.
   */
  private layoutMap(): void {
    const wrap = this.querySelector<HTMLElement>(".wp-stage-wrap");
    const stage = this.querySelector<HTMLElement>(".wp-stage");
    if (wrap === null || stage === null) return;
    const space = wrap.clientWidth;
    if (space === 0) return;
    const width = pixelMapWidth(
      Math.min(space, STAGE_MAX_WIDTH),
      WORLD_GRID_WIDTH,
    );
    stage.style.maxWidth = "none";
    stage.style.width = `${width}px`;
    stage.style.marginLeft = `${Math.round((space - width) / 2)}px`;
    separateLabels(
      [...this.querySelectorAll<HTMLElement>(".hp-mark, .hp-open, .hp-seal")],
      wrap.getBoundingClientRect(),
    );
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
    // A still frame, as on the front page: the reveal is the page's one
    // motion, and a map that keeps moving claims a liveness nobody measured.
    paintWorldFrame(this.image.data, {
      fronts,
      focus: this.hoverFront,
      phase: 0,
    });
    context.putImageData(this.image, 0, 0);
  }

  private revealProgress(time: number): number {
    if (this.revealStart === 0) return 1;
    return Math.min(1, (time - this.revealStart) / REVEAL_MS);
  }

  /** Only the reveal animates; afterwards the map repaints on change alone. */
  private needsAnimation(time: number): boolean {
    if (reducedMotion() || this.model === null) return false;
    return this.revealProgress(time) < 1;
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
    // Over a placard, the placard's own front stays lit, not the land below.
    if ((event.target as Element).closest(".hp-marks") !== null) return;
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
    const next = id !== undefined && known === true ? id : null;
    if (next === this.selected) return;
    this.selected = next;
    this.drawerAnimates = this.canAnimate();
    // A link straight to a front opens its sheet with focus inside, as a
    // click does.
    if (next !== null) {
      void this.updateComplete.then(() =>
        this.querySelector<HTMLElement>(".wp-drawer-close")?.focus(),
      );
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.selected !== null) this.closeFront();
  };

  /**
   * Motion only where it can play: a hidden tab runs no animation clock, so
   * a sheet that slid in there would sit on its first, invisible frame.
   */
  private canAnimate(): boolean {
    return document.visibilityState === "visible" && !reducedMotion();
  }

  private openFront(id: WorldTheatreId): void {
    this.returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.selected = id;
    this.drawerAnimates = this.canAnimate();
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
    return iso === null ? "—" : formatAge(iso, this.now);
  }

  private date(iso: string, withTime = false): string {
    return formatDate(iso, withTime);
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
    const view = this.view(model);
    return html`
      <main class="wp-main">
        ${this.renderHero(model)} ${renderFronts(view)}
        <div class="wp-wrap wp-columns">
          ${renderDispatches(view, this.dispatchesExpanded, () => {
            this.dispatchesExpanded = !this.dispatchesExpanded;
          })}
          ${renderPowers(view)}
        </div>
        ${renderHistory(view, this.historyFocus, (focus) => {
          // A pointer moving within one reign's day changes nothing.
          const current = this.historyFocus;
          if (focus?.day === current?.day && focus?.front === current?.front) {
            return;
          }
          this.historyFocus = focus;
        })}
        ${renderRules(view)}
      </main>
      ${this.selected !== null
        ? renderDrawer(view, this.selected, this.drawerAnimates)
        : nothing}
    `;
  }

  /** The page's helpers, for the sections rendered by their own modules. */
  private view(model: WorldModel): WorldView {
    return {
      model,
      now: this.now,
      label: (name) => this.label(name),
      bannerColor: (name) => this.bannerColor(name),
      lowContrast: (name) => this.lowContrast(name),
      swatch: (front) => this.swatch(front),
      emblem: (name, size) => this.emblem(name, size),
      agentLink: (name, extraClass) => this.agentLink(name, extraClass),
      frontName: (id) => this.frontName(id),
      age: (iso) => this.age(iso),
      date: (iso, withTime) => this.date(iso, withTime),
      list: (items) => this.list(items),
      openFront: (id) => this.openFront(id),
      focusFront: (id) => {
        this.hoverFront = id;
      },
      closeFront: () => this.closeFront(),
    };
  }

  // -------------------------------------------------------------- hero

  private renderHero(model: WorldModel) {
    const feed = feedState(model, this.now);
    const verdictView = this.verdictView();
    const crown = this.theatre("crown");
    const regions = model.theatres.filter((theatre) => theatre.id !== "crown");
    const claimed = regions.filter((theatre) => theatre.holder !== null).length;
    const contested = regions.filter(
      (theatre) => frontDisplayState(theatre, this.now) === "contested",
    ).length;
    return html`
      <section class="wp-hero" aria-labelledby="wp-headline">
        <div class="wp-wrap wp-hero-head">
          <div class="wp-eyebrow">
            <span>${contextLine(model)}</span>
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
                  >
                  <span
                    >${translateText(
                      feed.kind === "live"
                        ? "world_page.feed_live"
                        : "world_page.feed_paused",
                      { age: this.age(feed.lastBattleAt) },
                    )}</span
                  ></span
                >`}
          </div>
          <h1
            id="wp-headline"
            class="wp-headline"
            data-length=${verdictLength(verdictView, model)}
          >
            ${renderVerdict(verdictView, model)}
          </h1>
          <p class="wp-support">${renderSupport(verdictView, model)}</p>
          <ul class="wp-stats" role="list">
            <li>
              ${translateText("world_page.stat_fronts", {
                held: claimed,
                total: regions.length,
              })}
            </li>
            <li class=${contested > 0 ? "wp-stat-hot" : ""}>
              ${translateText("world_page.stat_contested", {
                count: contested,
              })}
            </li>
            ${crown?.holder
              ? html`<li class="wp-stat-crown">
                  ${translateText(
                    frontDisplayState(crown, this.now) === "contested"
                      ? "world_page.stat_crown_siege"
                      : "world_page.stat_crown",
                    { name: this.label(crown.holder) },
                  )}
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
          ${renderLegend(this.view(model))} ${renderKey(this.view(model))}
        </div>
      </section>
    `;
  }

  /** The verdict's names, dates and clock, as this page draws them. */
  private verdictView(): VerdictView {
    return {
      now: this.now,
      label: (name) => this.label(name),
      frontName: (id) => this.frontName(id),
      date: (iso) => this.date(iso),
      leadName: (name) => this.leadName(name),
    };
  }

  /**
   * A leader's name in the headline, underlined in its banner colour and
   * linked to its agent's page, as on the front page.
   */
  private leadName(name: string): TemplateResult {
    const agent = this.agents.get(name);
    const label = this.label(name);
    const style = `--banner:${leadUnderline(this.bannerColor(name), this.lowContrast(name))}`;
    return agent?.slug
      ? html`<a
          class="wp-headline-name"
          href="/agent/${encodeURIComponent(agent.slug)}"
          style=${style}
          >${label}</a
        >`
      : html`<span class="wp-headline-name" style=${style}>${label}</span>`;
  }

  private list(items: readonly string[]): string {
    return formatList(items);
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
              aria-haspopup="dialog"
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
          <canvas
            class="wp-map"
            width=${WORLD_GRID_WIDTH}
            height=${WORLD_GRID_HEIGHT}
            role="img"
            aria-label=${translateText(modeKey(model, "world_page.map_label"))}
          ></canvas>
          ${renderPlacards(this.placardView(), model)}
        </div>
      </div>
    `;
  }

  /**
   * What the shared placards need from `/world`: each opens its front's
   * sheet, highlights its front on the map while pointed at, and is marked
   * when it changed hands since the last visit.
   */
  private placardView(): PlacardView {
    return {
      now: this.now,
      label: (name) => this.label(name),
      colorOf: (name) => this.bannerColor(name),
      swatch: (front) => this.swatch(front),
      lowContrast: (name) => this.lowContrast(name),
      emblem: (name) => this.flag(name),
      frontName: (id) => this.frontName(id),
      age: (iso) => this.age(iso),
      date: (iso) => this.date(iso),
      target: (id) => ({ open: () => this.openFront(id) }),
      placardAria: (front, holder) => this.placardAria(front, holder),
      openAria: (front) =>
        translateText("world_page.label_aria_unclaimed", {
          front: this.frontName(front.id),
        }),
      openLine: (front) => unclaimedLine(front),
      sealAria: (crown) => {
        const holder = crown?.holder ?? null;
        if (holder === null) {
          return translateText("world_page.crown_aria_vacant");
        }
        return crown !== null &&
          crown.challenger !== null &&
          frontDisplayState(crown, this.now) === "contested"
          ? translateText("world_page.crown_aria_siege", {
              holder: this.label(holder),
              challenger: this.label(crown.challenger),
            })
          : translateText("world_page.crown_aria", {
              holder: this.label(holder),
            });
      },
      // The Crown holds no land: there is nothing on the map to light up.
      focusFront: (id) => {
        this.hoverFront = id === "crown" ? null : id;
      },
      changed: this.changed,
    };
  }

  private placardAria(front: RegionFront, holder: string): string {
    const name = this.frontName(front.id);
    const display = frontDisplayState(front, this.now);
    if (display === "contested" && front.challenger !== null) {
      return translateText("world_page.label_aria_contested", {
        front: name,
        holder: this.label(holder),
        challenger: this.label(front.challenger),
      });
    }
    if (display === "quiet" && front.lastBattleAt !== null) {
      return translateText("world_page.label_aria_quiet", {
        front: name,
        holder: this.label(holder),
        date: this.date(front.lastBattleAt),
      });
    }
    return translateText("world_page.label_aria_held", {
      front: name,
      holder: this.label(holder),
    });
  }

  /** An agent's pixel emblem as an image, as the placards frame it. */
  private flag(name: string | null): TemplateResult | typeof nothing {
    const agent = name === null ? undefined : this.agents.get(name);
    if (!agent?.emblemSvg) return nothing;
    return html`<img
      src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        agent.emblemSvg,
      )}"
      alt=""
      width="26"
      height="26"
      decoding="async"
    />`;
  }

  // ------------------------------------------------------ legend and key

  // -------------------------------------------------------------- fronts

  // -------------------------------------------------------------- dispatches

  // -------------------------------------------------------------- powers

  // -------------------------------------------------------------- history

  // -------------------------------------------------------------- rules

  // -------------------------------------------------------------- drawer
}
