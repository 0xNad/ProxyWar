import { html, LitElement, nothing, svg, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { DEFAULT_PLATFORM_ORIGIN } from "../../core/PlatformOrigin";
import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  requestUpdateWhenTranslationsReady,
  TELEGRAM_COMMUNITY_URL,
} from "./AppShellChrome";
import {
  clearestSiege,
  contrastRatio,
  crownFront,
  exampleFront,
  frontPageVerdict,
  frontsInState,
  holderGroups,
  leaderCaveats,
  regionFronts,
  warDay,
  watchEvent,
  type RegionFront,
} from "./HomePresentation";
import { ensurePublicFonts } from "./PublicFonts";
import { CROWN_GLYPH } from "./WorldGlyphs";
import {
  WORLD_GRID_ANCHORS,
  WORLD_GRID_HEIGHT,
  WORLD_GRID_WIDTH,
} from "./WorldMapGrid";
import { pixelMapWidth, separateLabels } from "./WorldMapLayout";
import { mix, paintWorldFrame, SEA, worldGrid } from "./WorldMapRenderer";
import {
  fetchWorldModel,
  type WorldAgent,
  type WorldEvent,
  type WorldModel,
  type WorldTheatre,
  type WorldTheatreId,
} from "./WorldModelSchema";
import {
  assignBannerColors,
  bannerColorOf,
  changedSinceVisit,
  feedState,
  frontDisplayState,
  frontPaints,
  frontSwatch,
  hexToRgb,
  parseVisitSnapshot,
  rgbHex,
  UNCLAIMED_HEX,
  visitSnapshot,
} from "./WorldPresentation";
import {
  eventSentence,
  formatAge,
  formatDate,
  formatList,
  frontInText,
  pageLocale,
} from "./WorldText";

/**
 * The front page: the war table. The first screen answers the one question
 * a stranger brings — which AI agent is winning? — in a single sentence,
 * over the live world itself: the game's own pixel Earth, full bleed, each
 * front tagged with the agent that holds it, every state also said in
 * words. Below it, kept short: the latest takeovers, the rule worked through
 * on a real front's real battles, and the way in for builders (one prompt
 * for a coding agent). `/world` has the depth; this page is the door.
 *
 * Reads only `world.json` (~120 KB), never the 10 MB read model — the
 * account and starter links travel in `world.json`'s `links`. Liveness is
 * only ever measured (the newest battle's age, battles in the last 24 h),
 * never the configured round schedule.
 *
 * Designed by prototyping three directions against real league data and an
 * independent critique: this is the "command table" direction with the
 * critique's corrections and the atlas direction's worked example.
 */

type LoadState = "loading" | "ready" | "error";
type CopyState = "idle" | "copied" | "failed";

const REFRESH_MS = 2 * 60 * 1000;
const CLOCK_MS = 30 * 1000;
const REVEAL_MS = 1150;
const STYLE_ELEMENT_ID = "home-page-styles";
/** Its own key, so the front page never consumes `/world`'s visit banner. */
const VISIT_KEY = "proxywar.home.lastVisit";
const OCEAN = "#071225";
const STARTER_REPOSITORY_URL =
  "https://github.com/0xNad/proxywar-coworld-starter";
const VACANT_RING = "#46556c";

/**
 * Placards sit on the shared label anchors; only fronts whose anchor is in
 * a crowded or tiny spot are nudged (offsets in % of the map box). East
 * Asia's placard moves out to sea and keeps a leader line to its anchor.
 */
const PLACARD_PLACEMENT: Partial<
  Record<
    WorldTheatreId,
    {
      readonly align?: "left" | "right";
      readonly dx?: number;
      readonly dy?: number;
      readonly leader?: boolean;
    }
  >
> = {
  britannia: { align: "left", dx: 2.2 },
  europe: { dx: -1.4 },
  black_sea: { align: "right", dx: 0.8 },
  middle_east: { dy: 1.5 },
  east_asia: { align: "right", dx: 2.5, dy: 7.5, leader: true },
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Invisible-separator markers for templates spliced into translated sentences. */
const MARK_PATTERN = /⁣(\d+)⁣/;
function mark(index: number): string {
  return `⁣${index}⁣`;
}

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
    // Private mode / blocked storage: the "since you were here" line never shows.
  }
}

function ensureHomeStyles(): void {
  if (typeof document === "undefined") return;
  ensurePublicFonts();
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = HOME_PAGE_CSS;
  document.head.appendChild(style);
}

@customElement("home-page")
export class HomePage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private model: WorldModel | null = null;
  @state() private now = Date.now();
  @state() private copyState: CopyState = "idle";
  @state() private changed: WorldTheatreId[] = [];
  @state() private sinceVisitAt: string | null = null;

  private colors = new Map<string, string>();
  private agents = new Map<string, WorldAgent>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private revealPending = false;
  private revealFrame = 0;
  private revealGuard: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  createRenderRoot() {
    this.classList.add(...APP_SHELL_ROOT_CLASSES, "hp-root");
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    ensureHomeStyles();
    void this.load(true);
    requestUpdateWhenTranslationsReady(this);
    this.refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") void this.load(false);
    }, REFRESH_MS);
    this.clockTimer = setInterval(() => {
      this.now = Date.now();
    }, CLOCK_MS);
    window.addEventListener("resize", this.onResize);
    // Placard sizes change when the web font arrives.
    void document.fonts?.ready.then(() => this.layoutMap());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.refreshTimer = null;
    this.clockTimer = null;
    this.stopReveal();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.onResize);
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
      }
      this.revealPending = initial;
      this.model = model;
      this.loadState = "ready";
    } catch {
      if (initial || this.model === null) this.loadState = "error";
    }
  }

  protected updated(): void {
    if (this.loadState !== "ready" || this.model === null) return;
    // Every render, so a translation that arrives late still reaches the tab.
    document.title = translateText("home_page.document_title");
    const wrap = this.querySelector<HTMLElement>(".hp-map-wrap");
    if (
      wrap !== null &&
      this.resizeObserver === null &&
      typeof ResizeObserver !== "undefined"
    ) {
      this.resizeObserver = new ResizeObserver(() => this.layoutMap());
      this.resizeObserver.observe(wrap);
    }
    this.layoutMap();
    if (this.revealPending) {
      this.revealPending = false;
      this.reveal(this.model);
    } else if (this.revealFrame === 0 && this.revealGuard === null) {
      this.put(this.frame(this.model));
    }
  }

  private readonly onResize = () => this.layoutMap();

  // -------------------------------------------------------------- the map

  private frame(model: WorldModel): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(
      WORLD_GRID_WIDTH * WORLD_GRID_HEIGHT * 4,
    );
    paintWorldFrame(pixels, {
      fronts: frontPaints(model, this.colors, this.now),
      focus: null,
      phase: 0,
    });
    return pixels;
  }

  private put(pixels: Uint8ClampedArray): void {
    const canvas = this.querySelector<HTMLCanvasElement>(
      "canvas.hp-map-canvas",
    );
    const context = canvas?.getContext("2d");
    if (context === null || context === undefined) return;
    const image = context.createImageData(WORLD_GRID_WIDTH, WORLD_GRID_HEIGHT);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
  }

  /**
   * The one orchestrated moment: each holder's colour spreads across its own
   * front from its placard, over slate land, in about a second. Skipped for
   * reduced motion and for a tab nobody is looking at; a timer always
   * finishes the map, so the resting state is always the true map.
   */
  private reveal(model: WorldModel): void {
    this.stopReveal();
    const full = this.frame(model);
    if (reducedMotion() || document.visibilityState !== "visible") {
      this.put(full);
      return;
    }
    const plain = new Uint8ClampedArray(full.length);
    paintWorldFrame(plain, { fronts: {}, focus: null, phase: 0 });
    const { width, height, tiles, grain, regionIds } = worldGrid();
    const anchors = regionIds.map((id) => [
      (WORLD_GRID_ANCHORS[id].x / 100) * width,
      (WORLD_GRID_ANCHORS[id].y / 100) * height,
    ]);
    const changed: number[] = [];
    const keys: number[] = [];
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === SEA) continue;
      const o = i * 4;
      if (
        full[o] === plain[o] &&
        full[o + 1] === plain[o + 1] &&
        full[o + 2] === plain[o + 2]
      ) {
        continue;
      }
      const [ax, ay] = anchors[tiles[i]];
      const x = i % width;
      const y = (i - x) / width;
      changed.push(i);
      keys.push(Math.hypot(x - ax, y - ay) + (grain[i] + 1) * 3);
    }
    if (changed.length === 0) {
      this.put(full);
      return;
    }
    const order = Array.from(changed.keys()).sort((a, b) => keys[a] - keys[b]);
    const furthest = keys[order[order.length - 1]];
    const pixels = plain;
    let cursor = 0;
    let start = 0;
    const fill = (limit: number) => {
      while (cursor < order.length && keys[order[cursor]] <= limit) {
        const o = changed[order[cursor++]] * 4;
        pixels[o] = full[o];
        pixels[o + 1] = full[o + 1];
        pixels[o + 2] = full[o + 2];
        pixels[o + 3] = full[o + 3];
      }
      this.put(pixels);
    };
    const finish = () => {
      this.stopReveal();
      fill(Number.POSITIVE_INFINITY);
    };
    this.revealGuard = setTimeout(finish, REVEAL_MS + 600);
    const step = (time: number) => {
      if (start === 0) start = time;
      const progress = Math.min(1, (time - start) / REVEAL_MS);
      fill((1 - (1 - progress) ** 2) * furthest);
      if (progress < 1) this.revealFrame = requestAnimationFrame(step);
      else finish();
    };
    this.put(pixels);
    this.revealFrame = requestAnimationFrame(step);
  }

  private stopReveal(): void {
    if (this.revealFrame !== 0) cancelAnimationFrame(this.revealFrame);
    this.revealFrame = 0;
    if (this.revealGuard !== null) clearTimeout(this.revealGuard);
    this.revealGuard = null;
  }

  /**
   * Whole tile multiples when the width is close to one (1440 px snaps to
   * 1500, cropping a little Pacific) so every tile is the same size and the
   * siege hatching never shimmers; then labels are pushed apart where they
   * overlap and kept on screen.
   */
  private layoutMap(): void {
    const wrap = this.querySelector<HTMLElement>(".hp-map-wrap");
    const map = this.querySelector<HTMLElement>(".hp-map");
    if (wrap === null || map === null) return;
    const available = wrap.clientWidth;
    if (available === 0) return;
    const width = pixelMapWidth(available, WORLD_GRID_WIDTH);
    map.style.width = `${width}px`;
    map.style.marginLeft = `${Math.round((available - width) / 2)}px`;
    separateLabels(
      [...this.querySelectorAll<HTMLElement>(".hp-mark, .hp-open, .hp-seal")],
      wrap.getBoundingClientRect(),
    );
  }

  // ------------------------------------------------------------- helpers

  /** Always a `#rrggbb` colour: these values are written into style attributes. */
  private colorOf(name: string | null): string {
    const color =
      this.model === null ? null : bannerColorOf(name, this.colors, this.model);
    return color !== null && HEX_COLOR.test(color) ? color : "#94a3b8";
  }

  /** An https URL or a same-origin path; anything else is replaced. */
  private safeUrl(url: string | undefined, fallback: string): string {
    if (url === undefined) return fallback;
    if (url.startsWith("/") && !url.startsWith("//")) return url;
    try {
      return new URL(url).protocol === "https:" ? url : fallback;
    } catch {
      return fallback;
    }
  }

  private accountUrl(): string {
    const fallback = `${DEFAULT_PLATFORM_ORIGIN}/account`;
    return this.safeUrl(this.model?.links?.accountUrl, fallback);
  }

  private starterUrl(): string {
    return this.safeUrl(
      this.model?.links?.enterTheLeagueUrl,
      STARTER_REPOSITORY_URL,
    );
  }

  /** Below 3:1 on the ocean, a banner's marks get an ink outline. */
  private lowContrast(name: string | null): boolean {
    if (name === null) return false;
    const ratio = contrastRatio(this.colorOf(name), OCEAN);
    return ratio !== null && ratio < 3;
  }

  /** The leader's underline: their banner, lifted when too dark to see. */
  private underlineColor(name: string): string {
    const rgb = hexToRgb(this.colorOf(name));
    if (rgb === null) return "#a4afbf";
    return this.lowContrast(name)
      ? rgbHex(mix(rgb, [255, 255, 255], 0.45))
      : rgbHex(rgb);
  }

  /** CSS paint for a swatch, computed with the renderer's own maths. */
  private swatch(front: WorldTheatre | null): string {
    return frontSwatch(front, (name) => this.colorOf(name), this.now);
  }

  private label(name: string): string {
    return this.agents.get(name)?.label ?? name;
  }

  private frontName(id: WorldTheatreId): string {
    return translateText(`world_page.front_${id}`);
  }

  private locale(): string | undefined {
    return pageLocale();
  }

  private list(items: readonly string[]): string {
    return formatList(items);
  }

  /** A list whose items are templates (bold front names, linked agents). */
  private listOf(items: readonly TemplateResult[]): TemplateResult {
    const joined = this.list(items.map((_, index) => mark(index))).split(
      MARK_PATTERN,
    );
    return html`${joined.map((piece, index) =>
      index % 2 === 0 ? piece : (items[Number(piece)] ?? nothing),
    )}`;
  }

  private date(iso: string): string {
    return formatDate(iso);
  }

  private age(iso: string): string {
    return formatAge(iso, this.now);
  }

  /** A translated sentence with templates (names, links) spliced in. */
  private spliced(
    key: string,
    params: Record<string, string | number>,
    parts: readonly TemplateResult[],
  ): TemplateResult {
    const pieces = translateText(key, params).split(MARK_PATTERN);
    return html`${pieces.map((piece, index) =>
      index % 2 === 0 ? piece : (parts[Number(piece)] ?? nothing),
    )}`;
  }

  private leadName(name: string): TemplateResult {
    const agent = this.agents.get(name);
    const label = this.label(name);
    const style = `--lead:${this.underlineColor(name)}`;
    return agent?.slug
      ? html`<a
          class="hp-lead"
          href="/agent/${encodeURIComponent(agent.slug)}"
          style=${style}
          >${label}</a
        >`
      : html`<span class="hp-lead" style=${style}>${label}</span>`;
  }

  /**
   * An agent's emblem as an image, never injected markup: an SVG loaded
   * through `<img>` cannot run script, whatever it contains.
   */
  private emblem(name: string | null): TemplateResult | typeof nothing {
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

  // ------------------------------------------------------------- render

  render() {
    return html`
      <a class="hp-skip" href="#hp-map"
        >${translateText("home_page.skip_link")}</a
      >
      ${appShellHeader("/", undefined, this.accountUrl())}
      ${this.loadState === "loading" ? this.renderLoading() : nothing}
      ${this.loadState === "error" ? this.renderError() : nothing}
      ${this.loadState === "ready" && this.model !== null
        ? this.renderPage(this.model)
        : nothing}
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<div class="hp-loading" role="status">
      ${translateText("home_page.loading")}
    </div>`;
  }

  private renderError() {
    return html`<main class="hp-error">
      <p role="alert">${translateText("home_page.error")}</p>
      <p class="hp-error-actions">
        <button type="button" @click=${() => this.load(true)}>
          ${translateText("home_page.retry")}
        </button>
        <a href="/league">${translateText("home_page.error_league")}</a>
        <a href="/watch">${translateText("home_page.error_watch")}</a>
      </p>
    </main>`;
  }

  private renderPage(model: WorldModel) {
    return html`<main class="hp-main">
      <section class="hp-table" aria-labelledby="hp-verdict">
        ${this.renderHud(model)}
        <div class="hp-map-wrap" id="hp-map" tabindex="-1">
          <div class="hp-map">
            <canvas
              class="hp-map-canvas"
              width=${WORLD_GRID_WIDTH}
              height=${WORLD_GRID_HEIGHT}
              aria-hidden="true"
            ></canvas>
            <a
              class="hp-map-link"
              href="/world"
              tabindex="-1"
              aria-hidden="true"
            ></a>
            ${this.renderPlacards(model)}
          </div>
        </div>
        <div class="hp-key-desktop">${this.renderKey(model)}</div>
        <div class="hp-phone-actions">${this.renderActions(model)}</div>
        ${this.renderLegend(model)}
      </section>
      <div class="hp-below">
        ${this.renderLatest(model)} ${this.renderRules(model)}
        ${this.renderEnter(model)}
        <p class="hp-as-of">
          ${translateText("home_page.data_as_of", {
            time: this.dataTime(model.generatedAt),
          })}
        </p>
      </div>
    </main>`;
  }

  private dataTime(iso: string): string {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return "—";
    return new Intl.DateTimeFormat(this.locale(), {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    }).format(new Date(time));
  }

  // ---------------------------------------------------------- the verdict

  private renderHud(model: WorldModel) {
    const verdict = frontPageVerdict(model);
    const names =
      verdict.kind === "leader"
        ? [verdict.name]
        : verdict.kind === "tied" && verdict.names.length === 2
          ? verdict.names
          : [];
    const longest = Math.max(
      0,
      ...names.map((name) => this.label(name).length),
    );
    return html`<div class="hp-hud">
      <p class="hp-context">${translateText("home_page.context")}</p>
      <h1
        class="hp-verdict"
        id="hp-verdict"
        data-length=${longest > 40
          ? "xl"
          : longest > 28
            ? "l"
            : longest > 16
              ? "m"
              : "s"}
      >
        ${this.verdict(model)}
      </h1>
      <p class="hp-support">${this.support(model)}</p>
      <p class="hp-clock hp-clock-phone">${this.clock(model, true)}</p>
      <div class="hp-row">
        <div class="hp-actions">${this.renderActions(model)}</div>
        <p class="hp-clock hp-clock-desktop">${this.clock(model, false)}</p>
      </div>
    </div>`;
  }

  private verdict(model: WorldModel): TemplateResult | string {
    const verdict = frontPageVerdict(model);
    switch (verdict.kind) {
      case "leader":
        return this.spliced("home_page.verdict_leader", { name: mark(0) }, [
          this.leadName(verdict.name),
        ]);
      case "tied":
        return verdict.names.length === 2
          ? this.spliced(
              "home_page.verdict_tied_two",
              { first: mark(0), second: mark(1) },
              verdict.names.map((name) => this.leadName(name)),
            )
          : translateText("home_page.verdict_tied_many", {
              count: verdict.names.length,
            });
      case "scattered":
        return translateText("home_page.verdict_scattered");
      case "empty":
        return translateText("home_page.verdict_empty");
    }
  }

  private support(model: WorldModel): TemplateResult | string {
    const verdict = frontPageVerdict(model);
    const total = regionFronts(model).length;
    const holding = (count: number) =>
      html`<b
        >${translateText("home_page.support_holding", { count, total })}</b
      >`;
    switch (verdict.kind) {
      case "leader": {
        const held = regionFronts(model).filter(
          (front) => front.holder === verdict.name,
        );
        const caveats = leaderCaveats(model, verdict.name, this.now).map(
          (caveat, index) =>
            html` <span class=${index > 0 ? "hp-caveat-more" : ""}
              >${caveat.kind === "siege"
                ? translateText("home_page.caveat_siege", {
                    front: frontInText(caveat.front.id),
                    challenger: this.label(caveat.front.challenger ?? ""),
                    wins: caveat.front.holderWins,
                  })
                : translateText("home_page.caveat_quiet", {
                    front: frontInText(caveat.front.id),
                    date: this.date(caveat.front.lastBattleAt ?? ""),
                  })}</span
            >`,
        );
        return html`${this.spliced(
          "home_page.support_leader",
          { holding: mark(0), fronts: mark(1) },
          [
            holding(verdict.fronts),
            this.listOf(
              held.map((front) => html`<b>${this.frontName(front.id)}</b>`),
            ),
          ],
        )}${caveats}`;
      }
      case "tied":
        return verdict.names.length === 2
          ? this.spliced("home_page.support_tied", { holding: mark(0) }, [
              holding(verdict.fronts),
            ])
          : this.spliced(
              "home_page.support_tied_many",
              {
                names: this.list(verdict.names.map((name) => this.label(name))),
                holding: mark(0),
              },
              [holding(verdict.fronts)],
            );
      case "scattered":
        return translateText("home_page.support_scattered", {
          count: verdict.claimed,
        });
      case "empty":
        return translateText("home_page.support_empty");
    }
  }

  /** Measured liveness only: the newest battle's age, battles in the last day. */
  private clock(model: WorldModel, compact: boolean) {
    const feed = feedState(model, this.now);
    if (feed.kind === "empty") {
      return html`<span>${translateText("home_page.clock_no_battles")}</span>`;
    }
    const day = this.lastDayCount(model, feed.lastBattleAt);
    // Spaces between the parts: the flex gap separates them on screen, the
    // spaces in the text (copied or read aloud).
    if (feed.kind === "paused") {
      return html`<span class="hp-pill hp-pill-paused"
          >${translateText("home_page.paused_pill")}</span
        >
        <span
          >${translateText("home_page.clock_paused", {
            age: this.age(feed.lastBattleAt),
          })}</span
        >
        <span>${day}</span>`;
    }
    const warDayNumber = warDay(model, this.now);
    return html`<span class="hp-pill hp-pill-live"
        >${translateText("home_page.live_pill")}</span
      >
      <span
        >${translateText("home_page.clock_last_battle", {
          age: this.age(feed.lastBattleAt),
        })}</span
      >
      <span>${day}</span>
      ${warDayNumber === null || compact
        ? nothing
        : html`<span
            >${translateText("home_page.clock_day", {
              day: warDayNumber,
            })}</span
          >`}`;
  }

  /**
   * Battles in the last day, honest about when it was counted: the server
   * counts back from `generatedAt`, so once the data itself is old the
   * window is named, and a last battle over a day ago means zero.
   */
  private lastDayCount(model: WorldModel, lastBattleAt: string): string {
    const dayMs = 24 * 60 * 60 * 1000;
    if (this.now - Date.parse(lastBattleAt) >= dayMs) {
      return translateText("home_page.clock_no_battles_24h");
    }
    const generated = Date.parse(model.generatedAt);
    if (Number.isFinite(generated) && this.now - generated > 60 * 60 * 1000) {
      return translateText("home_page.clock_battles_24h_to", {
        count: model.battlesLast24h,
        time: new Intl.DateTimeFormat(this.locale(), {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(generated)),
      });
    }
    return translateText("home_page.clock_battles_24h", {
      count: model.battlesLast24h,
    });
  }

  private renderActions(model: WorldModel) {
    const explore = html`<a class="hp-btn hp-btn-primary" href="/world"
      >${translateText("home_page.explore")}</a
    >`;
    if (feedState(model, this.now).kind === "empty") return explore;
    const event = watchEvent(model, this.now);
    return html`${explore}<a
        class="hp-btn hp-btn-secondary"
        href=${event?.href ?? "/watch"}
        >${event === null
          ? translateText("home_page.watch_any")
          : this.watchLabel(event)}</a
      >`;
  }

  private watchLabel(event: WorldEvent): string {
    const params = {
      agent: this.label(event.agent),
      front: frontInText(event.theatreId),
    };
    switch (event.kind) {
      case "conquest":
        return translateText("home_page.watch_take", params);
      case "claim":
        return translateText("home_page.watch_claim", params);
      case "held":
        return translateText("home_page.watch_hold", params);
      case "siege":
        return translateText("home_page.watch_siege", params);
    }
  }

  // ------------------------------------------------------------- placards

  private renderPlacards(model: WorldModel) {
    const leaders: TemplateResult[] = [];
    const placards = regionFronts(model).map((front) => {
      const anchor = WORLD_GRID_ANCHORS[front.id];
      const place = PLACARD_PLACEMENT[front.id] ?? {};
      const x = anchor.x + (place.dx ?? 0);
      const y = anchor.y + (place.dy ?? 0);
      const href = `/world#front-${front.id}`;
      const display = frontDisplayState(front, this.now);
      if (display === "unclaimed" || front.holder === null) {
        return html`<li class="hp-placard-full">
          <a
            class="hp-open"
            href=${href}
            style="left:${x}%;top:${y}%"
            aria-label=${translateText("home_page.open_aria", {
              front: this.frontName(front.id),
            })}
            ><b>${this.frontName(front.id)}</b
            ><span>${translateText("home_page.never_fought")}</span></a
          >
        </li>`;
      }
      if (place.leader === true) {
        leaders.push(
          svg`<line x1=${anchor.x} y1=${anchor.y} x2=${x} y2=${y}></line>`,
        );
      }
      const holder = front.holder;
      const siege =
        display === "contested" && front.challenger !== null
          ? html`<span
              class="hp-mark-siege"
              style="--rival:${this.colorOf(front.challenger)}"
              ><i
                class=${this.lowContrast(front.challenger) ? "hp-low" : ""}
              ></i
              >${translateText("home_page.mark_level", {
                challenger: this.label(front.challenger),
                wins: front.challengerWins,
              })}</span
            >`
          : nothing;
      return html`<li class="hp-placard-full">
        <a
          class="hp-mark"
          data-state=${display}
          data-align=${place.align ?? "center"}
          href=${href}
          style="left:${x}%;top:${y}%;--frame:${this.swatch(front)}"
          aria-label=${this.placardLabel(front, holder)}
          ><span class="hp-flag ${this.lowContrast(holder) ? "hp-low" : ""}"
            >${this.emblem(holder)}</span
          ><span class="hp-mark-text"
            ><span class="hp-mark-name">${this.label(holder)}</span
            ><span class="hp-mark-detail">${this.placardDetail(front)}</span
            >${siege}</span
          ></a
        >
      </li>`;
    });
    return html`<svg
        class="hp-leaders hp-placard-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        ${leaders}
      </svg>
      <ul class="hp-marks" aria-label=${translateText("home_page.map_aria")}>
        ${placards}${this.renderSeal(model)}
      </ul>`;
  }

  private placardDetail(front: RegionFront): string {
    const name = this.frontName(front.id);
    const display = frontDisplayState(front, this.now);
    if (display === "quiet" && front.lastBattleAt !== null) {
      return translateText("home_page.mark_quiet", {
        front: name,
        date: this.date(front.lastBattleAt),
      });
    }
    if (display === "contested") {
      return translateText("home_page.mark_siege", { front: name });
    }
    if (front.heldSince === null) return name;
    const since = Date.parse(front.heldSince);
    return Number.isFinite(since) && this.now - since < 24 * 60 * 60 * 1000
      ? translateText("home_page.mark_taken", {
          front: name,
          age: this.age(front.heldSince),
        })
      : translateText("home_page.mark_held_since", {
          front: name,
          date: this.date(front.heldSince),
        });
  }

  private placardLabel(front: RegionFront, holder: string): string {
    const display = frontDisplayState(front, this.now);
    const params = {
      front: this.frontName(front.id),
      holder: this.label(holder),
    };
    if (display === "contested" && front.challenger !== null) {
      return translateText("home_page.mark_aria_siege", {
        ...params,
        challenger: this.label(front.challenger),
        wins: front.holderWins,
      });
    }
    if (display === "quiet" && front.lastBattleAt !== null) {
      return translateText("home_page.mark_aria_quiet", {
        ...params,
        date: this.date(front.lastBattleAt),
      });
    }
    return translateText("home_page.mark_aria_held", params);
  }

  /** The Crown holds no land, so it sits in open water as a seal — never omitted. */
  private renderSeal(model: WorldModel) {
    const crown = crownFront(model);
    const anchor = WORLD_GRID_ANCHORS.crown;
    const holder = crown?.holder ?? null;
    return html`<li class="hp-seal-item">
      <a
        class="hp-seal"
        href="/world#front-crown"
        style="left:${anchor.x}%;top:${anchor.y}%;--ring:${holder === null
          ? VACANT_RING
          : this.colorOf(holder)}"
        aria-label=${holder === null
          ? translateText("home_page.crown_aria_vacant")
          : translateText("home_page.crown_aria", {
              holder: this.label(holder),
            })}
        ><span class="hp-seal-disc ${this.lowContrast(holder) ? "hp-low" : ""}"
          ><span class="hp-seal-crown">${CROWN_GLYPH}</span>${this.emblem(
            holder,
          )}</span
        ><span class="hp-seal-text"
          ><span class="hp-seal-title"
            >${translateText("home_page.crown_title")}</span
          ><span class="hp-seal-name"
            >${holder === null
              ? translateText("home_page.crown_vacant")
              : this.label(holder)}</span
          ><span class="hp-seal-detail"
            >${translateText("home_page.crown_note")}</span
          >${holder !== null && crown?.heldSince
            ? html`<span class="hp-seal-detail"
                >${translateText("home_page.crown_taken", {
                  age: this.age(crown.heldSince),
                })}</span
              >`
            : nothing}</span
        ></a
      >
    </li>`;
  }

  /** How to read the map, with swatches painted like the map itself. */
  private renderKey(model: WorldModel) {
    const siege = clearestSiege(model, (name) => this.colorOf(name), this.now);
    const quiet = frontsInState(model, "quiet", this.now)[0] ?? null;
    const open = frontsInState(model, "unclaimed", this.now).length > 0;
    if (siege === null && quiet === null && !open) return nothing;
    return html`<ul
      class="hp-key"
      aria-label=${translateText("home_page.key_aria")}
    >
      ${siege !== null
        ? html`<li>
            <i class="hp-sw" style="--frame:${this.swatch(siege)}"></i
            >${translateText("home_page.key_siege")}
          </li>`
        : nothing}
      ${quiet !== null
        ? html`<li>
            <i class="hp-sw" style="--frame:${this.swatch(quiet)}"></i
            >${translateText("home_page.key_quiet")}
          </li>`
        : nothing}
      ${open
        ? html`<li>
            <i class="hp-sw hp-sw-open" style="--frame:${UNCLAIMED_HEX}"></i
            >${translateText("home_page.key_open")}
          </li>`
        : nothing}
    </ul>`;
  }

  // --------------------------------------------- legend (phone and tablet)

  private renderLegend(model: WorldModel) {
    const chip = (front: RegionFront) => {
      const display = frontDisplayState(front, this.now);
      const state =
        display === "quiet"
          ? translateText("home_page.legend_quiet")
          : display === "contested"
            ? translateText("home_page.legend_siege")
            : null;
      return html`<span class="hp-legend-front"
        ><i
          class="hp-sw ${this.lowContrast(front.holder) ? "hp-low" : ""}"
          style="--frame:${this.swatch(front)}"
        ></i
        >${this.frontName(front.id)}${state === null
          ? nothing
          : html` <span class="hp-legend-state">(${state})</span>`}</span
      >`;
    };
    const crown = crownFront(model);
    const crownHolder = crown?.holder ?? null;
    const open = frontsInState(model, "unclaimed", this.now);
    return html`<div class="hp-legend">
      <ul
        class="hp-legend-list"
        aria-label=${translateText("home_page.legend_aria")}
      >
        ${holderGroups(model).map(
          (group) =>
            html`<li>
              <span
                class="hp-legend-flag ${this.lowContrast(group.holder)
                  ? "hp-low"
                  : ""}"
                style="--frame:${group.fronts.length > 1
                  ? this.colorOf(group.holder)
                  : this.swatch(group.fronts[0])}"
                >${this.emblem(group.holder)}</span
              ><span class="hp-legend-name">${this.label(group.holder)}</span
              ><span class="hp-legend-fronts">${group.fronts.map(chip)}</span>
            </li>`,
        )}
        <li>
          <span
            class="hp-legend-seal"
            style="--ring:${crownHolder === null
              ? VACANT_RING
              : this.colorOf(crownHolder)}"
            >${this.emblem(crownHolder)}</span
          ><span
            class="hp-legend-name ${crownHolder === null ? "hp-muted" : ""}"
            >${crownHolder === null
              ? translateText("home_page.crown_vacant")
              : this.label(crownHolder)}</span
          ><span class="hp-legend-fronts"
            ><span class="hp-legend-front"
              >${translateText("home_page.crown_title")}</span
            ></span
          >
        </li>
        ${open.length > 0
          ? html`<li>
              <span
                class="hp-legend-flag hp-sw-open"
                style="--frame:${UNCLAIMED_HEX}"
              ></span
              ><span class="hp-legend-name hp-muted"
                >${translateText("home_page.never_fought")}</span
              ><span class="hp-legend-fronts hp-muted"
                >${this.list(
                  open.map((front) => this.frontName(front.id)),
                )}</span
              >
            </li>`
          : nothing}
      </ul>
      ${this.renderKey(model)}
    </div>`;
  }

  // ------------------------------------------------------- latest takeovers

  private renderLatest(model: WorldModel) {
    const events = model.events.slice(0, 8);
    return html`<section class="hp-latest" aria-labelledby="hp-latest-title">
      <h2 id="hp-latest-title">${translateText("home_page.latest_title")}</h2>
      <p class="hp-definition">
        ${translateText("home_page.latest_definition", {
          window: model.windowSize,
        })}
      </p>
      ${this.changed.length > 0 && this.sinceVisitAt !== null
        ? html`<p class="hp-since" role="status">
            ${translateText("home_page.since_visit", {
              count: this.changed.length,
              age: this.age(this.sinceVisitAt),
            })}
          </p>`
        : nothing}
      ${events.length === 0
        ? html`<p class="hp-empty">
            ${translateText("home_page.latest_empty")}
          </p>`
        : html`<ol>
            ${events.map((event) => this.renderEvent(event))}
          </ol>`}
    </section>`;
  }

  private renderEvent(event: WorldEvent) {
    const { key, params } = eventSentence(event, (name) => this.label(name));
    const sentence = translateText(key, {
      ...params,
      agent: this.label(event.agent),
    });
    return html`<li>
      <a
        href=${event.href}
        aria-label=${translateText("home_page.watch_event_aria", {
          event: sentence,
        })}
      >
        <time datetime=${event.at}>${this.age(event.at)}</time>
        <span class="hp-event" style="--chip:${this.colorOf(event.agent)}"
          ><i
            class=${this.lowContrast(event.agent) ? "hp-low" : ""}
            aria-hidden="true"
          ></i
          >${this.spliced(key, { ...params, agent: mark(0) }, [
            html`<b>${this.label(event.agent)}</b>`,
          ])}</span
        >
        <span class="hp-event-watch" aria-hidden="true"
          >${translateText("home_page.watch")}</span
        >
      </a>
    </li>`;
  }

  // -------------------------------------------------------- the rules

  private renderRules(model: WorldModel) {
    const fronts = regionFronts(model);
    const held =
      fronts.find((front) => frontDisplayState(front, this.now) === "held") ??
      null;
    const siege = clearestSiege(model, (name) => this.colorOf(name), this.now);
    const quiet = frontsInState(model, "quiet", this.now)[0] ?? null;
    const crownHolder = crownFront(model)?.holder ?? null;
    const keys: Array<{
      readonly title: string;
      readonly body: string;
      readonly frame: string;
      readonly round?: boolean;
    }> = [
      {
        title: translateText("home_page.rule_held_title"),
        body: translateText("home_page.rule_held"),
        frame: held === null ? UNCLAIMED_HEX : this.swatch(held),
      },
      {
        title: translateText("home_page.rule_siege_title"),
        body: translateText("home_page.rule_siege"),
        frame: siege === null ? UNCLAIMED_HEX : this.swatch(siege),
      },
      {
        title: translateText("home_page.rule_quiet_title"),
        body: translateText("home_page.rule_quiet"),
        frame: quiet === null ? UNCLAIMED_HEX : this.swatch(quiet),
      },
      {
        title: translateText("home_page.rule_open_title"),
        body: translateText("home_page.rule_open"),
        frame: UNCLAIMED_HEX,
      },
      {
        title: translateText("home_page.rule_crown_title"),
        body: translateText("home_page.rule_crown"),
        frame: crownHolder === null ? VACANT_RING : this.colorOf(crownHolder),
        round: true,
      },
    ];
    return html`<section class="hp-rules" aria-labelledby="hp-rules-title">
      <h2 id="hp-rules-title">${translateText("home_page.rules_title")}</h2>
      <p>${translateText("home_page.rules_split", { total: fronts.length })}</p>
      <p>
        <b
          >${translateText("home_page.rules_rule", {
            window: model.windowSize,
          })}</b
        >
        ${translateText("home_page.rules_rule_more")}
      </p>
      <p>${translateText("home_page.rules_crown")}</p>
      ${this.renderExample(model)}
      <dl>
        ${keys.map(
          (row) =>
            html`<div>
              <span
                class="hp-rule-swatch ${row.round === true ? "hp-round" : ""}"
                style="--frame:${row.frame}"
                aria-hidden="true"
              ></span>
              <dt>${row.title}</dt>
              <dd>${row.body}</dd>
            </div>`,
        )}
      </dl>
      <p class="hp-rules-stats">
        ${this.spliced(
          "home_page.rules_stats",
          {
            count: model.battleCount,
            date:
              model.firstBattleAt === null
                ? "—"
                : this.date(model.firstBattleAt),
            league: mark(0),
          },
          [
            html`<a href="/league"
              >${translateText("home_page.rules_league")}</a
            >`,
          ],
        )}
      </p>
    </section>`;
  }

  /** The rule worked through on a real front's real last battles. */
  private renderExample(model: WorldModel) {
    const front = exampleFront(model, this.now);
    if (front === null || front.holder === null) return nothing;
    const holder = front.holder;
    const challenger = front.challenger;
    const battles = front.window;
    const other = Math.max(
      0,
      battles.length -
        front.holderWins -
        (challenger === null ? 0 : front.challengerWins),
    );
    const tied =
      frontDisplayState(front, this.now) === "contested" && challenger !== null;
    return html`<figure class="hp-example">
      <figcaption class="hp-example-title">
        ${translateText("home_page.example_title", {
          front: this.frontName(front.id),
          count: battles.length,
        })}
      </figcaption>
      <ol
        class="hp-window"
        aria-label=${translateText("home_page.example_aria", {
          front: this.frontName(front.id),
          count: battles.length,
        })}
        style="--cells:${Math.max(battles.length, 1)}"
      >
        ${battles.map((battle, index) => {
          const tone =
            battle.winner === null
              ? "hp-none"
              : battle.winner === holder
                ? "hp-holder"
                : battle.winner === challenger
                  ? "hp-challenger"
                  : "hp-other";
          const coloured = tone === "hp-holder" || tone === "hp-challenger";
          return html`<li class=${tone}>
            <a
              href=${battle.href}
              style=${coloured ? `--cell:${this.colorOf(battle.winner)}` : ""}
              aria-label=${battle.winner === null
                ? translateText("home_page.example_cell_no_winner", {
                    index: index + 1,
                    count: battles.length,
                  })
                : translateText("home_page.example_cell", {
                    index: index + 1,
                    count: battles.length,
                    winner: this.label(battle.winner),
                  })}
            ></a>
          </li>`;
        })}
      </ol>
      <p class="hp-window-ends" aria-hidden="true">
        <span>${translateText("home_page.example_oldest")}</span
        ><span>${translateText("home_page.example_newest")}</span>
      </p>
      <ul class="hp-window-key">
        <li>
          <i style="--cell:${this.colorOf(holder)}"></i>${translateText(
            "home_page.example_wins",
            {
              name: this.label(holder),
              count: front.holderWins,
            },
          )}
        </li>
        ${challenger === null
          ? nothing
          : html`<li>
              <i style="--cell:${this.colorOf(challenger)}"></i>${translateText(
                "home_page.example_wins",
                {
                  name: this.label(challenger),
                  count: front.challengerWins,
                },
              )}
            </li>`}
        <li>
          <i class="hp-other"></i>${translateText("home_page.example_other", {
            count: other,
          })}
        </li>
      </ul>
      <p class="hp-example-verdict">
        ${tied
          ? translateText("home_page.example_tied", {
              wins: front.holderWins,
              holder: this.label(holder),
              front: frontInText(front.id),
            })
          : translateText("home_page.example_lead", {
              holder: this.label(holder),
              front: frontInText(front.id),
            })}
      </p>
    </figure>`;
  }

  // ------------------------------------------------- enter your own agent

  private installPrompt(model: WorldModel): string {
    return translateText("home_page.install_prompt", {
      starterUrl: this.starterUrl(),
    });
  }

  private renderEnter(model: WorldModel) {
    const starter = this.starterUrl();
    return html`<section class="hp-enter" aria-labelledby="hp-enter-title">
      <div class="hp-enter-text">
        <h2 id="hp-enter-title">${translateText("home_page.enter_title")}</h2>
        <p>${translateText("home_page.enter_lede")}</p>
      </div>
      <figure class="hp-prompt">
        <pre
          aria-label=${translateText("home_page.prompt_label")}
        ><code>${this.installPrompt(model)}</code></pre>
        <figcaption class="hp-prompt-bar">
          <button type="button" class="hp-copy" @click=${this.copyPrompt}>
            ${translateText("home_page.copy")}
          </button>
          <span role="status" aria-live="polite"
            >${this.copyState === "copied"
              ? translateText("home_page.copied")
              : this.copyState === "failed"
                ? translateText("home_page.copy_failed")
                : ""}</span
          >
        </figcaption>
      </figure>
      <p class="hp-enter-links">
        <a href=${starter} rel="noopener noreferrer"
          >${translateText("home_page.starter_link")}</a
        ><a
          href=${TELEGRAM_COMMUNITY_URL}
          rel="noopener noreferrer"
          target="_blank"
          >${translateText("home_page.telegram_link")}</a
        >
      </p>
    </section>`;
  }

  private readonly copyPrompt = async () => {
    if (this.model === null) return;
    const text = this.installPrompt(this.model);
    try {
      await navigator.clipboard.writeText(text);
      this.copyState = "copied";
    } catch {
      // Clipboard blocked: select the prompt so a manual copy is one keystroke.
      const code = this.querySelector(".hp-prompt code");
      const selection = window.getSelection();
      if (code !== null && selection !== null) {
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      this.copyState = "failed";
    }
  };
}

const HOME_PAGE_CSS = `
.hp-root{--hp-sea:${OCEAN};--hp-plate:rgb(4 10 23/.92);--hp-ink:#edf1f7;--hp-ink-2:#a4afbf;--hp-rule:#1c2a40;--hp-slate:${UNCLAIMED_HEX};--hp-sans:"PW Overpass",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--hp-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--hp-gutter:clamp(16px,3.4vw,48px);background:var(--hp-sea);color:var(--hp-ink)}
.hp-skip{position:absolute;left:12px;top:-60px;z-index:60;padding:10px 14px;background:var(--hp-ink);color:var(--hp-sea);font:700 15px/1 var(--hp-sans);border-radius:2px}
.hp-skip:focus{top:12px}
.hp-main{font:400 16px/1.5 var(--hp-sans)}
.hp-main a{color:inherit}
.hp-main :focus-visible{outline:2px solid var(--hp-ink);outline-offset:2px;box-shadow:0 0 0 5px var(--hp-sea)}
.hp-loading{min-height:70vh;display:grid;place-items:center;color:var(--hp-ink-2);font:400 16px/1.5 var(--hp-sans)}
.hp-error{max-width:46rem;margin:0 auto;padding:4rem var(--hp-gutter);font:400 16px/1.5 var(--hp-sans);color:var(--hp-ink-2)}
.hp-error-actions{display:flex;flex-wrap:wrap;gap:8px 24px}
.hp-error button,.hp-error a{display:inline-flex;align-items:center;min-height:44px;padding:0;border:0;background:none;color:var(--hp-ink);font:inherit;font-weight:700;text-decoration:underline;cursor:pointer}

.hp-hud{padding:20px var(--hp-gutter) 16px}
.hp-context{margin:0;max-width:62ch;font-size:18px;line-height:1.4}
.hp-verdict{margin:4px 0 0;font-size:52px;line-height:1.04;letter-spacing:-.015em;font-weight:700;text-wrap:balance;overflow-wrap:anywhere}
.hp-verdict[data-length="l"]{font-size:44px}
.hp-verdict[data-length="xl"]{font-size:36px}
.hp-verdict[data-length="s"] .hp-lead,.hp-verdict[data-length="m"] .hp-lead{white-space:nowrap}
.hp-lead{text-decoration:underline;text-decoration-color:var(--lead,var(--hp-ink-2));text-decoration-thickness:.075em;text-underline-offset:.13em;text-decoration-skip-ink:none}
.hp-support{margin:8px 0 0;max-width:75ch;font-size:18px;line-height:1.45;color:var(--hp-ink-2)}
.hp-support b{color:var(--hp-ink);font-weight:700}
.hp-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px 28px;margin-top:16px}
.hp-actions{display:flex;flex-wrap:wrap;gap:12px}
.hp-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;font-weight:700;font-size:16px;line-height:1.2;text-decoration:none;border-radius:2px;text-align:center}
.hp-btn-primary{background:var(--hp-ink);color:var(--hp-sea)!important}
.hp-btn-primary:hover{background:#fff}
.hp-btn-secondary{border:1px solid #5b6b82;color:var(--hp-ink)}
.hp-btn-secondary:hover{border-color:var(--hp-ink)}
.hp-clock{display:flex;flex-wrap:wrap;align-items:center;gap:4px 28px;margin:0;color:var(--hp-ink-2);font-size:14px;font-variant-numeric:tabular-nums}
.hp-clock-desktop{margin-left:auto}
.hp-clock-phone{display:none}
.hp-pill{display:inline-flex;align-items:center;padding:1px 8px;border:1px solid;border-radius:2px;font-size:13px;font-weight:700;line-height:1.5}
.hp-pill-live{color:var(--hp-ink);border-color:var(--hp-ink-2)}
.hp-pill-paused{color:var(--hp-ink-2);border-color:#46556c}

.hp-map-wrap{position:relative;overflow:hidden;outline:none}
.hp-map{position:relative;width:100%;aspect-ratio:${WORLD_GRID_WIDTH}/${WORLD_GRID_HEIGHT}}
.hp-map-canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}
.hp-map-link{position:absolute;inset:0;cursor:zoom-in}
.hp-marks{position:absolute;inset:0;margin:0;padding:0;list-style:none;pointer-events:none}
.hp-marks a{pointer-events:auto}
.hp-leaders{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.hp-leaders line{stroke:var(--hp-ink);stroke-width:1;vector-effect:non-scaling-stroke;opacity:.7}
.hp-mark{position:absolute;display:flex;align-items:flex-start;gap:8px;width:max-content;max-width:256px;padding:4px 10px 5px 4px;background:var(--hp-plate);color:var(--hp-ink);text-decoration:none;transform:translate(-50%,-50%)}
.hp-mark[data-align="left"]{transform:translate(calc(-100% - 4px),-50%)}
.hp-mark[data-align="right"]{transform:translate(4px,-50%)}
.hp-flag{flex:none;display:block;width:32px;height:32px;padding:3px;background:var(--frame)}
.hp-flag img{display:block;width:26px;height:26px;image-rendering:pixelated}
.hp-low{box-shadow:inset 0 0 0 1px var(--hp-ink)}
.hp-mark-text{display:flex;flex-direction:column;min-width:0;padding-top:1px}
.hp-mark-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:1.15;font-weight:700;text-wrap:balance;overflow-wrap:anywhere}
.hp-mark-detail{font-size:12px;line-height:1.3;color:var(--hp-ink-2)}
.hp-mark-siege{display:flex;align-items:center;gap:5px;font-size:12px;line-height:1.3}
.hp-mark-siege i{flex:none;width:10px;height:10px;background:var(--rival)}
.hp-mark[data-state="quiet"] .hp-mark-name{color:#cdd4de}
.hp-mark:hover .hp-mark-name,.hp-open:hover b,.hp-seal:hover .hp-seal-name{text-decoration:underline;text-underline-offset:2px}
.hp-open{position:absolute;transform:translate(-50%,-50%);text-align:center;text-decoration:none;line-height:1.25;white-space:nowrap}
.hp-open b{display:block;font-size:13px;font-weight:700}
.hp-open span{font-size:12px;color:var(--hp-ink-2)}
.hp-seal{position:absolute;display:flex;align-items:center;gap:12px;text-decoration:none;transform:translate(-32px,-50%)}
.hp-seal-disc{position:relative;flex:none;display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:var(--hp-plate);box-shadow:inset 0 0 0 3px var(--ring)}
.hp-seal-disc.hp-low{box-shadow:inset 0 0 0 3px var(--ring),inset 0 0 0 4px var(--hp-ink)}
.hp-seal-disc img{width:30px;height:30px;image-rendering:pixelated}
.hp-seal-crown{position:absolute;left:50%;top:-8px;width:28px;height:14px;padding:0 4px 2px;background:var(--hp-sea);transform:translateX(-50%)}
.hp-seal-crown svg{display:block;width:100%;height:100%;fill:var(--hp-ink)}
.hp-seal-text{display:flex;flex-direction:column;max-width:15em;line-height:1.25}
.hp-seal-title,.hp-seal-detail{font-size:12px;color:var(--hp-ink-2)}
.hp-seal-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:15px;font-weight:700;overflow-wrap:anywhere}

.hp-key{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0;padding:0;list-style:none;font-size:14px;color:var(--hp-ink-2)}
.hp-key-desktop{padding:10px var(--hp-gutter) 0}
.hp-sw{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-1px;background:var(--frame)}
.hp-sw-open{box-shadow:inset 0 0 0 1px #46556c}
.hp-legend{display:none}
.hp-legend-list{list-style:none;margin:0 0 8px;padding:0}
.hp-legend-list li{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;min-height:32px;padding:4px 0;border-bottom:1px solid var(--hp-rule)}
.hp-legend-flag{flex:none;width:22px;height:22px;padding:2px;background:var(--frame)}
.hp-legend-flag img{display:block;width:18px;height:18px;image-rendering:pixelated}
.hp-legend-seal{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;box-shadow:inset 0 0 0 2px var(--ring)}
.hp-legend-seal img{width:12px;height:12px;image-rendering:pixelated}
.hp-legend-name{flex:1 1 auto;min-width:0;font-size:14px;font-weight:700;line-height:1.25;overflow-wrap:anywhere}
.hp-legend-fronts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:2px 12px;margin-left:auto;font-size:13px}
.hp-legend-front{white-space:nowrap}
.hp-legend-state{color:var(--hp-ink-2)}
.hp-muted{font-weight:400;color:var(--hp-ink-2)}
.hp-phone-actions{display:none}

.hp-below{max-width:1240px;margin:0 auto;padding:72px var(--hp-gutter) 40px;display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:64px 72px}
.hp-below h2{margin:0 0 8px;font-size:24px;line-height:1.2;font-weight:700}
.hp-definition{margin:0 0 16px;font-size:14px;color:var(--hp-ink-2)}
.hp-since{margin:0 0 16px;padding:8px 12px;border-left:2px solid var(--hp-ink);font-size:15px}
.hp-latest ol{list-style:none;margin:0;padding:0;border-top:1px solid var(--hp-rule)}
.hp-latest a{display:grid;grid-template-columns:9em minmax(0,1fr) auto;gap:2px 20px;align-items:baseline;min-height:44px;padding:11px 0 12px;border-bottom:1px solid var(--hp-rule);text-decoration:none}
.hp-latest time{font-size:14px;color:var(--hp-ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.hp-event{font-size:16px;line-height:1.45}
.hp-event i{display:inline-block;width:10px;height:10px;margin-right:8px;background:var(--chip)}
.hp-event-watch{font-size:14px;font-weight:700;color:var(--hp-ink-2)}
.hp-latest a:hover .hp-event-watch{color:var(--hp-ink);text-decoration:underline;text-underline-offset:3px}
.hp-empty{margin:0;color:var(--hp-ink-2)}
.hp-rules p{margin:0 0 12px;line-height:1.55}
.hp-rules dl{margin:20px 0 0;border-top:1px solid var(--hp-rule)}
.hp-rules dl>div{display:grid;grid-template-columns:30px minmax(0,1fr);gap:1px 14px;padding:10px 0 11px;border-bottom:1px solid var(--hp-rule)}
.hp-rules dt{grid-column:2;font-size:15px;font-weight:700;line-height:1.35}
.hp-rules dd{grid-column:2;margin:0;font-size:15px;line-height:1.45;color:var(--hp-ink-2)}
.hp-rule-swatch{grid-column:1;grid-row:1/3;width:30px;height:20px;margin-top:1px;background:var(--frame)}
.hp-rule-swatch.hp-round{width:22px;height:22px;margin-left:4px;border-radius:50%;background:none;box-shadow:inset 0 0 0 3px var(--frame)}
.hp-rules-stats{margin-top:16px!important;font-size:15px;color:var(--hp-ink-2)}
.hp-rules-stats a{color:var(--hp-ink)}
.hp-example{margin:20px 0 0;padding:16px 0 0;border-top:1px solid var(--hp-rule)}
.hp-example-title{font-size:15px;font-weight:700}
.hp-window{display:grid;grid-template-columns:repeat(var(--cells),minmax(0,1fr));gap:4px;max-width:400px;margin:10px 0 0;padding:0;list-style:none}
.hp-window a{display:block;aspect-ratio:1;border-radius:2px;background:var(--cell,var(--hp-slate))}
.hp-window .hp-none a{background:linear-gradient(to top right,transparent calc(50% - .5px),#46556c calc(50% - .5px),#46556c calc(50% + .5px),transparent calc(50% + .5px));box-shadow:inset 0 0 0 1px #46556c}
.hp-window a:hover{outline:2px solid var(--hp-ink);outline-offset:1px}
.hp-window-ends{display:flex;justify-content:space-between;max-width:400px;margin:4px 0 0!important;font-size:12px;color:var(--hp-ink-2)}
.hp-window-key{margin:8px 0 0;padding:0;list-style:none;font-size:14px;line-height:1.7}
.hp-window-key li{display:flex;align-items:center;gap:8px}
.hp-window-key i{flex:none;width:10px;height:10px;border-radius:1px;background:var(--cell)}
.hp-window-key i.hp-other{background:var(--hp-slate)}
.hp-example-verdict{margin:8px 0 0!important;font-size:15px;color:var(--hp-ink-2);max-width:46ch}
.hp-enter{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);grid-template-areas:"text prompt" "links prompt";grid-template-rows:auto 1fr;gap:0 72px;padding-top:56px;border-top:1px solid var(--hp-rule)}
.hp-enter-text{grid-area:text}
.hp-enter-text p{margin:0 0 14px;line-height:1.55;max-width:46ch}
.hp-prompt{grid-area:prompt;align-self:start;margin:0;background:var(--hp-plate);border:1px solid var(--hp-rule)}
.hp-prompt pre{margin:0;padding:18px 20px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 var(--hp-mono);color:var(--hp-ink)}
.hp-prompt-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:12px 20px;border-top:1px solid var(--hp-rule);font-size:14px;color:var(--hp-ink-2)}
.hp-copy{min-height:44px;padding:0 16px;border:1px solid var(--hp-ink);border-radius:2px;background:transparent;color:var(--hp-ink);font:700 15px/1 var(--hp-sans);cursor:pointer}
.hp-copy:hover{background:var(--hp-ink);color:var(--hp-sea)}
.hp-enter-links{grid-area:links;align-self:start;display:flex;flex-wrap:wrap;gap:0 24px;margin:6px 0 0;font-size:15px;font-weight:700}
.hp-enter-links a{display:inline-flex;align-items:center;min-height:44px;text-underline-offset:3px;text-decoration-color:#5b6b82}
.hp-enter-links a:hover{text-decoration-color:var(--hp-ink)}
.hp-as-of{grid-column:1/-1;margin:0;font-size:13px;color:var(--hp-ink-2)}

@media (max-width:1179px){
  .hp-placard-full,.hp-key-desktop{display:none}
  .hp-seal{gap:0;transform:translate(-50%,-50%)}
  .hp-seal-text{display:none}
  .hp-seal-disc{width:30px;height:30px;box-shadow:inset 0 0 0 2px var(--ring)}
  .hp-seal-disc img{width:14px;height:14px}
  .hp-seal-crown{width:16px;height:9px;top:-5px;padding:0 3px 1px}
  .hp-legend{display:block;padding:12px var(--hp-gutter) 0}
  .hp-legend-list{columns:2;column-gap:40px}
  .hp-legend-list li{break-inside:avoid}
  .hp-below{grid-template-columns:minmax(0,1fr);gap:56px}
  .hp-enter{grid-template-columns:minmax(0,1fr);grid-template-areas:"text" "prompt" "links";grid-template-rows:auto;gap:0}
  .hp-enter-links{margin-top:16px}
}
@media (max-width:759px){
  .hp-hud{padding:16px var(--hp-gutter) 14px}
  .hp-context{font-size:15px}
  .hp-verdict{font-size:34px;margin-top:6px}
  .hp-verdict[data-length="l"],.hp-verdict[data-length="xl"]{font-size:30px}
  .hp-verdict[data-length="m"] .hp-lead{white-space:normal}
  .hp-support{font-size:16px}
  .hp-caveat-more{display:none}
  .hp-hud .hp-row{display:none}
  .hp-clock-phone{display:flex;gap:4px 12px;margin-top:10px}
  .hp-seal-disc{width:24px;height:24px}
  .hp-seal-disc img{width:12px;height:12px}
  .hp-seal-crown{width:14px;height:8px;top:-5px}
  .hp-phone-actions{display:flex;flex-direction:column;gap:10px;padding:14px var(--hp-gutter) 0}
  .hp-phone-actions .hp-btn{min-height:48px;width:100%}
  .hp-legend{padding-top:16px}
  .hp-legend-list{columns:1}
  .hp-below{padding:56px var(--hp-gutter) 32px;gap:48px}
  .hp-below h2{font-size:22px}
  .hp-latest li:nth-child(n+6){display:none}
  .hp-latest a{grid-template-columns:minmax(0,1fr) auto;gap:2px 16px}
  .hp-latest time{grid-column:1;font-size:13px}
  .hp-event{grid-column:1;font-size:15px}
  .hp-event-watch{grid-column:2;grid-row:1/3;align-self:center}
  .hp-enter{padding-top:48px}
  .hp-prompt pre{padding:16px}
  .hp-prompt-bar{padding:12px 16px}
}
@media (prefers-reduced-motion:reduce){.hp-root *{transition:none!important;animation:none!important}}
`;

declare global {
  interface HTMLElementTagNameMap {
    "home-page": HomePage;
  }
}
