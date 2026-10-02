import {
  html,
  LitElement,
  nothing,
  svg,
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
import {
  clearestSiege,
  contrastRatio,
  crownFront,
  frontsInState,
  holderGroups,
  type RegionFront,
} from "./HomePresentation";
import { renderDrawer } from "./WorldDrawer";
import { renderFronts, stateWord, unclaimedLine } from "./WorldFronts";
import { CROWN_GLYPH } from "./WorldGlyphs";
import { renderHistory, type HistoryFocus } from "./WorldHistory";
import {
  WORLD_GRID_ANCHORS,
  WORLD_GRID_GRATICULE,
  WORLD_GRID_HEIGHT,
  WORLD_GRID_WIDTH,
} from "./WorldMapGrid";
import { pixelMapWidth, separateLabels } from "./WorldMapLayout";
import { paintWorldFrame, theatreAtPoint } from "./WorldMapRenderer";
import {
  fetchWorldModel,
  type WorldAgent,
  type WorldEvent,
  type WorldModel,
  type WorldTheatre,
  type WorldTheatreId,
} from "./WorldModelSchema";
import { ensureWorldStyles } from "./WorldPageStyles";
import { renderPlacards, type PlacardView } from "./WorldPlacards";
import {
  assignBannerColors,
  changedSinceVisit,
  feedState,
  frontDisplayState,
  frontPaints,
  frontSwatch,
  parseVisitSnapshot,
  UNCLAIMED_HEX,
  visitSnapshot,
  WORLD_REGION_IDS,
  worldVerdict,
} from "./WorldPresentation";
import {
  battlefieldName,
  eventSentence,
  formatAge,
  formatDate,
  formatList,
} from "./WorldText";
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
const DISPATCHES_COLLAPSED = 10;
/** The map stops growing here; past it the page has margins. */
const STAGE_MAX_WIDTH = 1440;
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
  private glowKey = "";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private mapVisible = true;
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
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
      this.glowKey = "";
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
          ${this.renderDispatches(model)} ${this.renderPowers(model)}
        </div>
        ${renderHistory(view, this.historyFocus, (focus) => {
          this.historyFocus = focus;
        })}
        ${this.renderRules(model)}
      </main>
      ${this.selected !== null ? renderDrawer(view, this.selected) : nothing}
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
      closeFront: () => this.closeFront(),
    };
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
            names: this.list(
              verdict.names.map((_, index) => nameMarker(index)),
            ),
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
    return this.spliced(
      key,
      params,
      names.map(
        (name) =>
          html`<span
            class="wp-headline-name"
            style="--banner:${this.bannerColor(name)}"
            >${this.label(name)}</span
          >`,
      ),
    );
  }

  /** A translated sentence with templates spliced in at `nameMarker`s. */
  private spliced(
    key: string,
    params: Record<string, string | number>,
    parts: readonly TemplateResult[],
  ): TemplateResult {
    const pieces = translateText(key, params).split(NAME_MARKER_PATTERN);
    return html`${pieces.map((piece, index) =>
      index % 2 === 0 ? piece : (parts[Number(piece)] ?? nothing),
    )}`;
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
      sealAria: (holder) =>
        holder === null
          ? translateText("world_page.crown_aria_vacant")
          : translateText("world_page.crown_aria", {
              holder: this.label(holder),
            }),
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
                >${translateText("world_page.legend_unclaimed")}</span
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
    const state = stateWord(frontDisplayState(front, this.now));
    const name = html`<span class="wp-legend-front-name"
      >${this.frontName(front.id)}</span
    >`;
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
      aria-haspopup="dialog"
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
      ${mark}<span class="wp-legend-front-text"
        >${state === null
          ? name
          : this.spliced(
              "world_page.front_with_state",
              { front: nameMarker(0), state },
              [name],
            )}</span
      >
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
    return html`<ul
      class="wp-key"
      aria-label=${translateText("world_page.key_aria")}
    >
      ${siege !== null
        ? html`<li>
            <i class="wp-sw" style="--paint:${this.swatch(siege)}"></i
            >${translateText("world_page.key_siege")}
          </li>`
        : nothing}
      ${quiet !== null
        ? html`<li>
            <i class="wp-sw" style="--paint:${this.swatch(quiet)}"></i
            >${translateText("world_page.key_quiet")}
          </li>`
        : nothing}
      ${open
        ? html`<li>
            <i class="wp-sw wp-sw-open" style="--paint:${UNCLAIMED_HEX}"></i
            >${translateText("world_page.key_open")}
          </li>`
        : nothing}
    </ul>`;
  }

  // -------------------------------------------------------------- fronts

  // -------------------------------------------------------------- dispatches

  private renderDispatches(model: WorldModel) {
    const events = this.dispatchesExpanded
      ? model.events
      : model.events.slice(0, DISPATCHES_COLLAPSED);
    return html`<section class="wp-panel" aria-labelledby="wp-dispatches-title">
      <h2 id="wp-dispatches-title" class="wp-section-title">
        ${translateText("world_page.dispatches_title")}
      </h2>
      <p class="wp-panel-intro">
        ${translateText("world_page.dispatches_definition", {
          window: model.windowSize,
        })}
      </p>
      ${model.events.length === 0
        ? html`<p class="wp-muted">
            ${translateText("world_page.dispatches_empty")}
          </p>`
        : html`<ol class="wp-dispatches" role="list">
            ${events.map((event) => this.renderDispatch(event))}
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

  /** One event in the front page's words; the whole row watches the battle. */
  private renderDispatch(event: WorldEvent) {
    const { key, params } = eventSentence(event, (name) => this.label(name));
    const sentence = translateText(key, {
      ...params,
      agent: this.label(event.agent),
    });
    return html`<li>
      <a
        class="wp-dispatch"
        href=${event.href}
        aria-label=${translateText("world_page.watch_event_aria", {
          event: sentence,
        })}
      >
        <time datetime=${event.at} title=${this.date(event.at, true)}
          >${this.age(event.at)}</time
        >
        <span class="wp-dispatch-text"
          ><i
            class="wp-dispatch-chip ${this.lowContrast(event.agent)
              ? "wp-low"
              : ""}"
            style="--chip:${this.bannerColor(event.agent)}"
            aria-hidden="true"
          ></i
          >${this.spliced(key, { ...params, agent: nameMarker(0) }, [
            html`<b>${this.label(event.agent)}</b>`,
          ])}</span
        >
        <span class="wp-dispatch-watch" aria-hidden="true"
          >${translateText("world_page.event_battle_link")}</span
        >
      </a>
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
                            aria-haspopup="dialog"
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
}
