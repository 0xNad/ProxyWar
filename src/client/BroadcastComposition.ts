import { translateText } from "./Utils";

/**
 * Shared, pure, presentation-only structural components for the Stage 4
 * broadcast composition (product overhaul spec Stage 4 item 1: left
 * competitor rail, right War Room event feed, bottom timeline). "Restructure,
 * don't restart" — these are new REGIONS wired into the EXISTING
 * `AiLeagueReplayOverlay.ts` (Full Replay) and `ReplayPremiereOverlay.ts`
 * (Premiere), not a replacement for either.
 *
 * Deliberately STYLE-FREE: every element here gets a plain, semantic,
 * `broadcast-*`-prefixed class name and NOTHING else — no inline styles, no
 * design tokens baked in. Each overlay defines the actual CSS rules for
 * these class names inside its OWN existing `createStyle()` function, using
 * its OWN existing token prefix (`--pw-*` for AiLeagueReplayOverlay.ts,
 * `--rp-*` for ReplayPremiereOverlay.ts) — exactly like every other region
 * in both files already works. This file only ever builds DOM structure
 * from already-fully-derived, already-spoiler-safe input data; it never
 * fetches, filters, or judges what's safe to show — that is the caller's
 * job (see each derivation module's own doc for the premiere-vs-full-replay
 * spoiler-safety boundary).
 *
 * Data-in only: nothing here reads `AgentSpectatorTelemetry`/frame-state/
 * identity-registry types directly. Every field on every entry type below
 * is already resolved, already bounded (or not, for Full Replay), by the
 * caller before it reaches this module.
 */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className !== "") result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

/**
 * Shared collapse/expand toggle button for a side panel's heading row (spec
 * item 1: a side rail must never be permanently half the viewport with no
 * way to shrink it back — collapse/expand, not drag, is the promised
 * control). Purely a button + a `data-collapsed` attribute on the section
 * root; this file stays deliberately style-free, so hiding the body on
 * collapse is each caller overlay's own CSS rule keyed off that attribute,
 * exactly like every other `data-*`-driven rule already in this module.
 * `collapsed`/`onToggle` are CALLER-owned state (same pattern as
 * `ReplayPremiereOverlayCallbacks`'s `activeDrawerTab`/`analystOpen`) —
 * this component never persists anything itself.
 */
function renderCollapseToggle(
  className: string,
  collapsed: boolean,
  labels: { collapse: string; expand: string },
  onToggle: () => void,
): HTMLButtonElement {
  const toggle = element("button", className) as HTMLButtonElement;
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute(
    "aria-label",
    collapsed ? labels.expand : labels.collapse,
  );
  // Monochrome glyphs only (this file's own visual direction: no emojis) —
  // a caret rather than a symbol pair keeps one glyph doing double duty via
  // CSS `[aria-expanded]` rotation instead of swapping text content.
  toggle.textContent = "\u25BE";
  toggle.addEventListener("click", onToggle);
  return toggle;
}

// ---------------------------------------------------------------------------
// Left competitor rail
// ---------------------------------------------------------------------------

/**
 * One agent's rail row. Every field is independently optional/nullable —
 * render gracefully degrades per-field (never fabricates a value, never
 * hides the whole row because one field is unknown). `allies`/`wars` are
 * OTHER entries' `playerName`s (matched by the caller against this same
 * roster) — "where telemetry already supplies them" (spec wording): an
 * empty array means "none known", not "definitely none".
 */
export interface CompetitorRailEntry {
  playerName: string;
  displayName: string;
  agentSlug: string | null;
  emblemSvg: string | null;
  primaryColor: string | null;
  versionLabel: string | null;
  builderDisplayName: string | null;
  /** 0-100, or null when not derivable (e.g. no frame-state connected yet). */
  territoryPercent: number | null;
  /** 1-based, or null when not derivable. */
  inMatchRank: number | null;
  alive: boolean | null;
  allies: readonly string[];
  wars: readonly string[];
  /** Count of fallback/degraded decisions so far, or null when not tracked for this context. */
  degradedDecisionCount: number | null;
  /** True when this is the viewer's current camera-follow target (spec item 6: rail-driven follow discoverability). */
  followed: boolean;
}

export interface CompetitorRailCallbacks {
  /**
   * Camera-follow discoverability (spec item 6): clicking a rail seat pans
   * to that Agent — the SAME opt-in-only pan `PointOfViewSelector`'s
   * crosshair button already triggers, never automatic. Omit to render a
   * non-interactive rail (e.g. a context with no game view attached).
   */
  onSelect?: (playerName: string) => void;
  /** Collapse/expand (spec item 1). Omit `onToggleCollapsed` to render a rail with no toggle at all (always expanded) — see `renderCollapseToggle`'s own doc for the caller-owned-state contract. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function renderCompetitorRail(
  entries: readonly CompetitorRailEntry[],
  callbacks: CompetitorRailCallbacks = {},
): HTMLElement {
  const aside = element("aside", "broadcast-rail");
  aside.setAttribute("aria-label", translateText("broadcast.rail_heading"));
  const collapsible = callbacks.onToggleCollapsed !== undefined;
  const collapsed = collapsible && callbacks.collapsed === true;
  if (collapsible) {
    aside.dataset.collapsed = String(collapsed);
  }
  const headingRow = element("div", "broadcast-rail-heading-row");
  headingRow.append(
    element(
      "h3",
      "broadcast-rail-heading",
      translateText("broadcast.rail_heading"),
    ),
  );
  if (collapsible) {
    headingRow.append(
      renderCollapseToggle(
        "broadcast-rail-collapse-toggle",
        collapsed,
        {
          collapse: translateText("broadcast.rail_collapse"),
          expand: translateText("broadcast.rail_expand"),
        },
        () => callbacks.onToggleCollapsed?.(),
      ),
    );
  }
  aside.append(headingRow);
  const list = element("ol", "broadcast-rail-list");
  list.setAttribute("role", "list");
  if (entries.length === 0) {
    list.append(
      element(
        "li",
        "broadcast-rail-empty",
        translateText("broadcast.rail_empty"),
      ),
    );
  }
  for (const entry of entries) {
    list.append(renderCompetitorRailEntry(entry, callbacks));
  }
  aside.append(list);
  return aside;
}

function renderCompetitorRailEntry(
  entry: CompetitorRailEntry,
  callbacks: CompetitorRailCallbacks,
): HTMLElement {
  const item = element("li", "broadcast-rail-entry");
  item.dataset.alive =
    entry.alive === null ? "unknown" : entry.alive ? "true" : "false";
  item.dataset.followed = String(entry.followed);
  if (entry.primaryColor !== null) {
    item.style.setProperty("--broadcast-agent-color", entry.primaryColor);
  }

  // The whole identity+stats surface is one button when selection is wired
  // (camera-follow discoverability) — a plain non-interactive wrapper
  // otherwise, matching every other optional-interactivity pattern already
  // in this file (e.g. War Room's expand button).
  const interactive = callbacks.onSelect !== undefined;
  const surface = interactive
    ? (element("button", "broadcast-rail-select") as HTMLButtonElement)
    : element("div", "broadcast-rail-select");
  if (interactive && surface instanceof HTMLButtonElement) {
    surface.type = "button";
    surface.setAttribute("aria-pressed", String(entry.followed));
    surface.setAttribute(
      "aria-label",
      translateText("broadcast.rail_follow_label", {
        name: entry.displayName,
      }),
    );
    surface.addEventListener("click", () => {
      callbacks.onSelect?.(entry.playerName);
    });
  }

  const identityRow = element("div", "broadcast-rail-identity");
  if (entry.emblemSvg !== null) {
    const emblem = element("span", "broadcast-rail-emblem");
    emblem.innerHTML = entry.emblemSvg;
    emblem.setAttribute("aria-hidden", "true");
    identityRow.append(emblem);
  } else {
    const placeholder = element("span", "broadcast-rail-emblem-placeholder", "?");
    placeholder.setAttribute("aria-hidden", "true");
    identityRow.append(placeholder);
  }
  const nameBlock = element("div", "broadcast-rail-name-block");
  nameBlock.append(
    element("span", "broadcast-rail-name", entry.displayName),
  );
  if (entry.versionLabel !== null) {
    nameBlock.append(
      element("span", "broadcast-rail-version", entry.versionLabel),
    );
  }
  if (entry.builderDisplayName !== null) {
    nameBlock.append(
      element(
        "span",
        "broadcast-rail-builder",
        translateText("broadcast.rail_builder", {
          name: entry.builderDisplayName,
        }),
      ),
    );
  }
  identityRow.append(nameBlock);
  surface.append(identityRow);

  const statsRow = element("div", "broadcast-rail-stats");
  if (entry.territoryPercent !== null) {
    statsRow.append(
      element(
        "span",
        "broadcast-rail-territory",
        translateText("broadcast.rail_territory", {
          percent: Math.round(entry.territoryPercent),
        }),
      ),
    );
  }
  if (entry.inMatchRank !== null) {
    statsRow.append(
      element(
        "span",
        "broadcast-rail-rank",
        translateText("broadcast.rail_rank", { rank: entry.inMatchRank }),
      ),
    );
  }
  if (entry.alive === false) {
    statsRow.append(
      element(
        "span",
        "broadcast-rail-eliminated",
        translateText("broadcast.rail_eliminated"),
      ),
    );
  }
  if (entry.degradedDecisionCount !== null && entry.degradedDecisionCount > 0) {
    statsRow.append(
      element(
        "span",
        "broadcast-rail-degraded",
        translateText("broadcast.rail_degraded", {
          count: entry.degradedDecisionCount,
        }),
      ),
    );
  }
  surface.append(statsRow);
  item.append(surface);

  if (entry.allies.length > 0 || entry.wars.length > 0) {
    const relations = element("div", "broadcast-rail-relations");
    if (entry.allies.length > 0) {
      relations.append(
        element(
          "span",
          "broadcast-rail-allies",
          translateText("broadcast.rail_allies", {
            names: entry.allies.join(", "),
          }),
        ),
      );
    }
    if (entry.wars.length > 0) {
      relations.append(
        element(
          "span",
          "broadcast-rail-wars",
          translateText("broadcast.rail_wars", {
            names: entry.wars.join(", "),
          }),
        ),
      );
    }
    item.append(relations);
  }

  return item;
}

// ---------------------------------------------------------------------------
// Right War Room — curated event feed
// ---------------------------------------------------------------------------

export type CuratedWarRoomEventKind =
  | "alliance"
  | "first_strike"
  | "betrayal"
  | "elimination"
  | "plan_change";

/**
 * Monochrome Unicode symbols only (visual direction: no emojis) — matches
 * `ReplayPremiereOverlay.ts`'s own existing `WAR_EVENT_GLYPHS` convention
 * (`⚔`/`†`/`☢`/`✕`) for the kinds that overlap; new kinds here pick from
 * the same dingbat/symbol block rather than emoji-presentation characters.
 */
const WAR_ROOM_GLYPHS: Record<CuratedWarRoomEventKind, string> = {
  alliance: "\u26AD", // ⚭ marriage/union symbol
  first_strike: "\u2192", // → arrow
  betrayal: "\u2020", // † dagger
  elimination: "\u2715", // ✕ multiplication x
  plan_change: "\u21BB", // ↻ clockwise open arrow
};

/**
 * One curated headline, already resolved to a public-safe presentation.
 * `publicReason` is explicitly labeled "the agent's stated reason" wherever
 * rendered (spec item 4: never presented as verified reasoning) — this
 * component enforces that by construction: it never renders `publicReason`
 * without the label wrapping it.
 */
export interface CuratedWarRoomEvent {
  id: string;
  kind: CuratedWarRoomEventKind;
  turn: number;
  sequence: number;
  headline: string;
  publicReason: string | null;
  participants: readonly string[];
  /** Extra detail shown only once the row is expanded. Null when there is nothing beyond the headline. */
  expandedDetail: string | null;
}

export interface WarRoomFeedCallbacks {
  onJumpToTurn?: (turn: number, sequence: number) => void;
  /** Collapse/expand (spec item 1). Omit `onToggleCollapsed` to render a feed with no toggle at all (always expanded) — see `renderCollapseToggle`'s own doc for the caller-owned-state contract. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function renderWarRoomFeed(
  events: readonly CuratedWarRoomEvent[],
  callbacks: WarRoomFeedCallbacks = {},
): HTMLElement {
  const section = element("section", "broadcast-war-room");
  const collapsible = callbacks.onToggleCollapsed !== undefined;
  const collapsed = collapsible && callbacks.collapsed === true;
  if (collapsible) {
    section.dataset.collapsed = String(collapsed);
  }
  const headingRow = element("div", "broadcast-war-room-heading-row");
  headingRow.append(
    element(
      "h3",
      "broadcast-war-room-heading",
      translateText("broadcast.war_room_heading"),
    ),
  );
  if (collapsible) {
    headingRow.append(
      renderCollapseToggle(
        "broadcast-war-room-collapse-toggle",
        collapsed,
        {
          collapse: translateText("broadcast.war_room_collapse"),
          expand: translateText("broadcast.war_room_expand"),
        },
        () => callbacks.onToggleCollapsed?.(),
      ),
    );
  }
  section.append(headingRow);
  const list = element("ol", "broadcast-war-room-list");
  list.setAttribute("role", "list");
  if (events.length === 0) {
    list.append(
      element(
        "li",
        "broadcast-war-room-empty",
        translateText("broadcast.war_room_empty"),
      ),
    );
  }
  for (const event of events) {
    list.append(renderWarRoomEvent(event, callbacks));
  }
  section.append(list);
  return section;
}

export function renderWarRoomEvent(
  event: CuratedWarRoomEvent,
  callbacks: WarRoomFeedCallbacks,
): HTMLElement {
  const item = element("li", "broadcast-war-room-item");
  item.dataset.kind = event.kind;
  const summary = element("button", "broadcast-war-room-summary");
  summary.type = "button";
  const expanded =
    event.expandedDetail !== null || event.publicReason !== null;
  summary.setAttribute("aria-expanded", "false");
  const glyph = element(
    "span",
    "broadcast-war-room-glyph",
    WAR_ROOM_GLYPHS[event.kind] ?? "\u2022",
  );
  glyph.setAttribute("aria-hidden", "true");
  summary.append(
    glyph,
    element(
      "span",
      "broadcast-war-room-kind",
      translateText(`broadcast.war_room_kind_${event.kind}`),
    ),
    element("span", "broadcast-war-room-headline", event.headline),
    element(
      "span",
      "broadcast-war-room-turn",
      translateText("broadcast.war_room_turn", { turn: event.turn }),
    ),
  );
  item.append(summary);

  if (expanded) {
    const detail = element("div", "broadcast-war-room-detail");
    detail.hidden = true;
    if (event.publicReason !== null) {
      detail.append(
        element(
          "p",
          "broadcast-war-room-reason",
          translateText("broadcast.war_room_stated_reason", {
            reason: event.publicReason,
          }),
        ),
      );
    }
    if (event.expandedDetail !== null) {
      detail.append(
        element("p", "broadcast-war-room-extra", event.expandedDetail),
      );
    }
    if (callbacks.onJumpToTurn !== undefined) {
      const jumpButton = element(
        "button",
        "broadcast-war-room-jump",
        translateText("broadcast.war_room_jump_to_turn", {
          turn: event.turn,
        }),
      ) as HTMLButtonElement;
      jumpButton.type = "button";
      jumpButton.addEventListener("click", (domEvent) => {
        domEvent.stopPropagation();
        callbacks.onJumpToTurn?.(event.turn, event.sequence);
      });
      detail.append(jumpButton);
    }
    summary.addEventListener("click", () => {
      const nowHidden = !detail.hidden;
      detail.hidden = nowHidden;
      summary.setAttribute("aria-expanded", nowHidden ? "false" : "true");
    });
    item.append(detail);
  }

  return item;
}

// ---------------------------------------------------------------------------
// Bottom timeline
// ---------------------------------------------------------------------------

export type TimelineMarkerKind =
  | "spawn"
  | "alliance"
  | "first_strike"
  | "lead_change"
  | "betrayal"
  | "nuke"
  | "elimination"
  | "finish"
  /**
   * Synthetic redaction kind (never produced by a derivation module):
   * `renderMatchTimeline` itself substitutes this for any marker whose
   * `turn` is beyond `options.currentTurn`, in place of the marker's real
   * `kind`/`label`. See `MatchTimelineOptions.currentTurn`'s own doc for
   * why — a real kind/label ahead of the playhead is itself a spoiler,
   * independent of whether the turn is seekable.
   */
  | "upcoming";

export interface TimelineMarker {
  kind: TimelineMarkerKind;
  turn: number;
  sequence: number;
  label: string;
}

export interface MatchTimelineOptions {
  /** Total turn span the timeline represents (the finish turn for a completed/Full-Replay match, or the currently-known turn ceiling for a live premiere). */
  totalTurns: number;
  /**
   * Highest turn a click/seek may target. `null` means unrestricted (Full
   * Replay). A live premiere passes the current released-chunks boundary —
   * "never navigable past the live edge during a Premiere" (spec item 2) —
   * and this component enforces it by construction: `onSeek` is simply
   * never invoked for a turn beyond this value, no matter what the caller
   * wires up.
   */
  maxSeekableTurn: number | null;
  /**
   * The viewer's own current playhead turn. A marker beyond this turn
   * renders as a content-free `"upcoming"` tick — real `kind`/`label` are
   * substituted out of the DOM entirely, not merely hidden by CSS — so a
   * spoiler (e.g. "BETRAYAL: X betrayed Y" surfaced via the marker's own
   * hover tooltip) can never leak ahead of playback, even when the marker
   * stays navigable (Full Replay's `maxSeekableTurn: null` is deliberately
   * unrestricted — seeking ahead is fine; the marker's CONTENT leaking
   * before the viewer gets there is not). The `"finish"` kind is exempt —
   * its label never carries match content, only "the match ends here". Pass
   * `null` where there is no meaningful playhead concept (an
   * already-revealed/archived rewatch — see each caller's own doc) to skip
   * redaction entirely.
   */
  currentTurn: number | null;
  onSeek?: (turn: number) => void;
}

export function renderMatchTimeline(
  markers: readonly TimelineMarker[],
  options: MatchTimelineOptions,
): HTMLElement {
  const section = element("section", "broadcast-timeline");
  section.setAttribute(
    "aria-label",
    translateText("broadcast.timeline_heading"),
  );
  const track = element("div", "broadcast-timeline-track");
  track.setAttribute("role", "list");
  const totalTurns = Math.max(1, options.totalTurns);
  for (const marker of markers) {
    const positionPercent = Math.min(
      100,
      Math.max(0, (marker.turn / totalTurns) * 100),
    );
    const seekable =
      options.maxSeekableTurn === null ||
      marker.turn <= options.maxSeekableTurn;
    const redact =
      marker.kind !== "finish" &&
      options.currentTurn !== null &&
      marker.turn > options.currentTurn;
    const kind: TimelineMarkerKind = redact ? "upcoming" : marker.kind;
    const label = redact
      ? translateText("broadcast.timeline_marker_upcoming")
      : marker.label;
    const markerElement = seekable
      ? (element("button", "broadcast-timeline-marker") as HTMLButtonElement)
      : element("span", "broadcast-timeline-marker");
    markerElement.dataset.kind = kind;
    markerElement.dataset.seekable = String(seekable);
    markerElement.style.setProperty(
      "--broadcast-timeline-position",
      `${positionPercent}%`,
    );
    markerElement.title = label;
    markerElement.setAttribute("aria-label", label);
    if (seekable && markerElement instanceof HTMLButtonElement) {
      markerElement.type = "button";
      markerElement.addEventListener("click", () => {
        options.onSeek?.(marker.turn);
      });
    }
    track.append(markerElement);
  }
  section.append(track);
  return section;
}

// ---------------------------------------------------------------------------
// Lower thirds — brief major-event overlays over the map (spec item 3)
// ---------------------------------------------------------------------------

export type LowerThirdEventKind = CuratedWarRoomEventKind | "finish";

const LOWER_THIRD_GLYPHS: Record<LowerThirdEventKind, string> = {
  ...WAR_ROOM_GLYPHS,
  finish: "\u25A0", // ■ filled square — distinct from every War Room kind glyph
};

/** A trigger for one lower-third pulse. `id` MUST be stable/unique per real event — it is the de-dupe key `LowerThirdController` uses to never re-announce the same event twice across repeated `sync()` calls (both overlays re-hydrate their whole model every frame). */
export interface LowerThirdEvent {
  id: string;
  kind: LowerThirdEventKind;
  headline: string;
}

export interface LowerThirdOptions {
  /** Milliseconds a lower third stays visible before auto-dismissing. Default 4200. */
  displayMs?: number;
  /** Overrides the `prefers-reduced-motion` media query — for tests only. */
  reducedMotion?: boolean;
}

/**
 * The one stateful component in this otherwise-pure-render file: "auto-
 * dismiss, one at a time" (spec item 3) is inherently a queue-plus-timer, and
 * that logic is identical for both callers (Full Replay, Premiere) — sharing
 * ONE implementation here beats duplicating a debounce/queue in two ~4000+
 * line overlay files. Still data-in only: the caller decides which curated
 * events are spoiler-safe/released-bounded to pass to `sync()`; this class
 * never fetches or filters anything itself.
 *
 * Never a permanent banner: at most one lower third is ever in the DOM, it
 * always auto-dismisses on its own timer, and there is no caller-facing way
 * to pin one open.
 */
export class LowerThirdController {
  private readonly container: HTMLElement;
  private readonly displayMs: number;
  private readonly reducedMotionOverride: boolean | undefined;
  private readonly seenIds = new Set<string>();
  private queue: LowerThirdEvent[] = [];
  private current: LowerThirdEvent | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(container: HTMLElement, options: LowerThirdOptions = {}) {
    this.container = container;
    this.container.classList.add("broadcast-lower-third-host");
    this.displayMs = options.displayMs ?? 4200;
    this.reducedMotionOverride = options.reducedMotion;
  }

  /**
   * Enqueues every event in `events` not already seen (by `id`) since this
   * controller was created, then advances the queue if idle. Safe to call
   * every frame with the caller's full current curated-event list — already-
   * announced ids are silently skipped, so a re-hydrate never re-triggers a
   * pulse for something already shown.
   */
  sync(events: readonly LowerThirdEvent[]): void {
    if (this.disposed) return;
    for (const event of events) {
      if (this.seenIds.has(event.id)) continue;
      this.seenIds.add(event.id);
      this.queue.push(event);
    }
    this.advance();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.dismissTimer ?? undefined);
    this.dismissTimer = null;
    this.current = null;
    this.queue = [];
    this.container.replaceChildren();
  }

  private advance(): void {
    if (this.disposed || this.current !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.current = next;
    this.render(next);
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      this.current = null;
      this.container.replaceChildren();
      this.advance();
    }, this.displayMs);
  }

  private render(event: LowerThirdEvent): void {
    const card = element("div", "broadcast-lower-third");
    card.dataset.kind = event.kind;
    // `prefers-reduced-motion` (spec item 3): the CONTROLLER's timing never
    // changes (still auto-dismisses on the same schedule) — only the CSS
    // pulse/entry animation is gated, via this data attribute, so a
    // reduced-motion viewer gets a static appearance, never a jarring
    // instant-appear/instant-vanish with no transition at all.
    card.dataset.reducedMotion = String(this.isReducedMotion());
    const glyph = element(
      "span",
      "broadcast-lower-third-glyph",
      LOWER_THIRD_GLYPHS[event.kind] ?? "\u2022",
    );
    glyph.setAttribute("aria-hidden", "true");
    card.append(
      glyph,
      element("span", "broadcast-lower-third-headline", event.headline),
    );
    // A single pulse, announced once — not a live region that would re-speak
    // on every subsequent unrelated DOM patch.
    card.setAttribute("role", "status");
    this.container.replaceChildren(card);
  }

  private isReducedMotion(): boolean {
    if (this.reducedMotionOverride !== undefined) {
      return this.reducedMotionOverride;
    }
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }
}

// ---------------------------------------------------------------------------
// Mobile bottom drawer — Agents / Events / Timeline / Analysis tabs
// (spec item 7). Pure structure: EVERY panel is always present in the DOM;
// CSS alone decides desktop (all panels visible, no tab bar) vs. narrow
// viewport (tab bar visible, only `data-tab-active="true"` shown) — see
// this module's own doc for why: no separate desktop/mobile render path to
// keep in sync, one tree, two stylesheets' worth of rules over it.
// ---------------------------------------------------------------------------

export type BroadcastDrawerTabId = "agents" | "events" | "timeline" | "analysis";

export interface BroadcastDrawerTab {
  id: BroadcastDrawerTabId;
  /** Pre-rendered panel content — typically the output of `renderCompetitorRail`/`renderWarRoomFeed`/`renderMatchTimeline`/`renderAnalystPanel`. */
  content: HTMLElement;
  /** Small numeric badge on the tab button (e.g. a War Room unseen-event count). Omit or 0/null for no badge. */
  badgeCount?: number | null;
}

export interface BroadcastDrawerOptions {
  activeTab: BroadcastDrawerTabId;
  onTabChange?: (tab: BroadcastDrawerTabId) => void;
}

export function renderBroadcastDrawer(
  tabs: readonly BroadcastDrawerTab[],
  options: BroadcastDrawerOptions,
): HTMLElement {
  const drawer = element("div", "broadcast-drawer");
  drawer.setAttribute("aria-label", translateText("broadcast.drawer_heading"));
  const tabList = element("div", "broadcast-drawer-tabs");
  tabList.setAttribute("role", "tablist");
  const panelHost = element("div", "broadcast-drawer-panels");
  for (const tab of tabs) {
    const isActive = tab.id === options.activeTab;
    const tabButtonId = `broadcast-drawer-tab-${tab.id}`;
    const panelId = `broadcast-drawer-panel-${tab.id}`;
    const tabButton = element(
      "button",
      "broadcast-drawer-tab",
      translateText(`broadcast.drawer_tab_${tab.id}`),
    ) as HTMLButtonElement;
    tabButton.type = "button";
    tabButton.id = tabButtonId;
    tabButton.setAttribute("role", "tab");
    tabButton.setAttribute("aria-selected", String(isActive));
    tabButton.setAttribute("aria-controls", panelId);
    tabButton.tabIndex = isActive ? 0 : -1;
    tabButton.dataset.tabId = tab.id;
    if (tab.badgeCount !== undefined && tab.badgeCount !== null && tab.badgeCount > 0) {
      tabButton.append(
        element("span", "broadcast-drawer-tab-badge", String(tab.badgeCount)),
      );
    }
    tabButton.addEventListener("click", () => {
      options.onTabChange?.(tab.id);
    });
    tabList.append(tabButton);

    tab.content.classList.add("broadcast-drawer-panel");
    tab.content.id = panelId;
    tab.content.dataset.tabId = tab.id;
    tab.content.dataset.tabActive = String(isActive);
    tab.content.setAttribute("role", "tabpanel");
    tab.content.setAttribute("aria-labelledby", tabButtonId);
    panelHost.append(tab.content);
  }
  drawer.append(tabList, panelHost);
  return drawer;
}

// ---------------------------------------------------------------------------
// Analyst mode (spec item 5) — the SAME already-public bounded data the
// curated views above draw from, unfiltered/uncurated. A VIEW change, never
// a data-exposure change: every field here already reaches the client
// today (in `replay-ui.json`'s bounded decision rows, or the live
// `SpectatorEvent` stream), just not rendered. The raw, private
// `decisions.jsonl` / full `AgentDecisionRecord` (LLM generation trace,
// strategic-priority internals, every considered option) is NEVER a valid
// input here — the caller is the only place that boundary is enforced, by
// construction, since it never has that private data to pass in the first
// place (see `CoworldReplayUiDecision`'s own server-side schema).
// ---------------------------------------------------------------------------

/** One already-public bounded decision row (`CoworldReplayUiDecision`), showing every field the curated view leaves out. */
export interface AnalystDecisionRow {
  sequence: number;
  turnNumber: number;
  playerName: string;
  brainType: string | null;
  selectedActionKind: string;
  selectedLegalActionId: string;
  reason: string | null;
  planObjective: string | null;
  decisionLatencyMs: number | null;
  fallbackUsed: boolean;
  accepted: boolean;
  auditStatus: string | null;
}

/** One already-public `SpectatorEvent`, unfiltered by importance/kind and undeduped — every field the curated War Room feed leaves out. */
export interface AnalystEventRow {
  sequence: number;
  turnNumber: number;
  kind: string;
  tone: string;
  actorName: string;
  targetName: string | null;
  secondaryName: string | null;
  message: string;
}

export interface AnalystActionKindCount {
  kind: string;
  count: number;
}

/**
 * `premiere_sealed`: a live/sealed Premiere never exposes decision-log
 * telemetry at all (see `ReplayPremiereRuntime.ts`'s own doc on
 * `plan_change` curation) — there is no bounded decision-row source to
 * degrade to, only the full event log stays available. `no_data`: the
 * decision-log source exists in principle (Full Replay) but this specific
 * match/context has none (e.g. a still-cold-starting fixture).
 */
export type AnalystModeUnavailableReason = "premiere_sealed" | "no_data";

export interface AnalystPanelData {
  /** Null renders the unavailable-reason message instead of an empty table. */
  decisions: readonly AnalystDecisionRow[] | null;
  decisionsUnavailableReason: AnalystModeUnavailableReason | null;
  events: readonly AnalystEventRow[];
  actionKindCounts: readonly AnalystActionKindCount[];
}

export function renderAnalystPanel(data: AnalystPanelData): HTMLElement {
  const section = element("section", "broadcast-analyst");
  section.setAttribute(
    "aria-label",
    translateText("broadcast.analyst_heading"),
  );
  if (data.actionKindCounts.length > 0) {
    section.append(renderAnalystActionChart(data.actionKindCounts));
  }
  section.append(renderAnalystDecisions(data));
  section.append(renderAnalystEventLog(data.events));
  return section;
}

/** A cheap, real bar chart — plain divs with a CSS custom property driving width, no charting library (D3 is the repo's only precedent and costs ~500+ LOC per new visualization; this needs none of that for a simple count distribution). */
function renderAnalystActionChart(
  counts: readonly AnalystActionKindCount[],
): HTMLElement {
  const wrap = element("div", "broadcast-analyst-chart");
  wrap.append(
    element(
      "h4",
      "broadcast-analyst-chart-heading",
      translateText("broadcast.analyst_chart_heading"),
    ),
  );
  const max = Math.max(1, ...counts.map((entry) => entry.count));
  const list = element("ol", "broadcast-analyst-chart-list");
  for (const entry of counts) {
    const row = element("li", "broadcast-analyst-chart-row");
    row.append(
      element("span", "broadcast-analyst-chart-label", entry.kind),
    );
    const track = element("span", "broadcast-analyst-chart-track");
    const bar = element("span", "broadcast-analyst-chart-bar");
    bar.style.setProperty(
      "--broadcast-chart-fraction",
      String(entry.count / max),
    );
    track.append(bar);
    row.append(
      track,
      element("span", "broadcast-analyst-chart-count", String(entry.count)),
    );
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

function renderAnalystDecisions(data: AnalystPanelData): HTMLElement {
  const wrap = element("div", "broadcast-analyst-decisions");
  wrap.append(
    element(
      "h4",
      "broadcast-analyst-decisions-heading",
      translateText("broadcast.analyst_decisions_heading"),
    ),
  );
  if (data.decisionsUnavailableReason !== null) {
    wrap.append(
      element(
        "p",
        "broadcast-analyst-unavailable",
        translateText(
          `broadcast.analyst_unavailable_${data.decisionsUnavailableReason}`,
        ),
      ),
    );
    return wrap;
  }
  const decisions = data.decisions ?? [];
  if (decisions.length === 0) {
    wrap.append(
      element(
        "p",
        "broadcast-analyst-empty",
        translateText("broadcast.analyst_decisions_empty"),
      ),
    );
    return wrap;
  }
  const table = element("table", "broadcast-analyst-decisions-table");
  const head = element("thead");
  const headRow = element("tr");
  for (const key of [
    "turn",
    "player",
    "brain",
    "action",
    "latency",
    "audit",
    "reason",
  ]) {
    headRow.append(
      element("th", "", translateText(`broadcast.analyst_decisions_col_${key}`)),
    );
  }
  head.append(headRow);
  table.append(head);
  const body = element("tbody");
  for (const row of decisions) {
    const tr = element("tr", "broadcast-analyst-decisions-row");
    tr.dataset.fallbackUsed = String(row.fallbackUsed);
    tr.dataset.accepted = String(row.accepted);
    tr.append(
      element(
        "td",
        "",
        translateText("broadcast.war_room_turn", { turn: row.turnNumber }),
      ),
      element("td", "", row.playerName),
      element("td", "", row.brainType ?? "\u2014"),
      element("td", "", row.selectedActionKind),
      element(
        "td",
        "",
        row.decisionLatencyMs === null
          ? "\u2014"
          : translateText("broadcast.analyst_latency_ms", {
              ms: row.decisionLatencyMs,
            }),
      ),
      element("td", "", row.auditStatus ?? "\u2014"),
      element("td", "", row.reason ?? "\u2014"),
    );
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function renderAnalystEventLog(events: readonly AnalystEventRow[]): HTMLElement {
  const wrap = element("div", "broadcast-analyst-events");
  wrap.append(
    element(
      "h4",
      "broadcast-analyst-events-heading",
      translateText("broadcast.analyst_events_heading"),
    ),
  );
  if (events.length === 0) {
    wrap.append(
      element(
        "p",
        "broadcast-analyst-empty",
        translateText("broadcast.analyst_events_empty"),
      ),
    );
    return wrap;
  }
  const list = element("ol", "broadcast-analyst-events-list");
  list.setAttribute("role", "list");
  for (const event of events) {
    const item = element("li", "broadcast-analyst-events-row");
    item.dataset.kind = event.kind;
    item.dataset.tone = event.tone;
    const parts = [
      translateText("broadcast.war_room_turn", { turn: event.turnNumber }),
      event.kind,
      event.actorName,
      event.targetName ?? "",
      event.secondaryName ?? "",
      event.message,
    ].filter((part) => part !== "");
    item.textContent = parts.join(" \u2022 ");
    list.append(item);
  }
  wrap.append(list);
  return wrap;
}

// ---------------------------------------------------------------------------
// Match-state strip (Season Zero activation prompt Phase 5, "Broadcast")
// ---------------------------------------------------------------------------

/**
 * A compact, always-visible summary strip derived from the sampled
 * `match-state-series.json` artifact (`AgentMatchStateSeries.ts` —
 * `MatchStateSeriesSample`): current leader, territory-share change,
 * alive count, active alliances/wars, and the current Director Cut
 * segment or live event phase. Deliberately NO win probability (spec:
 * "Do not add live win probability") — every field here is a plain,
 * already-true fact about the CURRENT sample, never a forward-looking
 * inference.
 *
 * Same "data-in only" contract as every other component in this file:
 * this never reads `MatchStateSeries`/frame-state directly and never
 * judges what's safe to show. The caller (whichever overlay mounts this
 * — `ReplayPremiereOverlay.ts`/`AiLeagueReplayOverlay.ts`) is the one
 * responsible for resolving `input` from ONLY the currently-released
 * sample — the same playhead/released-sequence boundary
 * `ReplayPremierePlaybackController.state().releasedThroughSequence`
 * already gates every other region in this module (see
 * `renderMatchTimeline`'s own windowing note) — this component has no
 * way to enforce that itself, since it never sees the full series or the
 * playback controller, only whatever ONE sample's worth of facts the
 * caller hands it.
 */
export interface MatchStateStripInput {
  /** `null` before any sample carries a resolvable leader (e.g. the very first released sample, or every seat tied at zero territory). */
  leader: { displayName: string; territoryPercent: number } | null;
  /** Percentage-point change in the leader's own territory share since the previous released sample — `null` on the first released sample (no prior point to diff against). Signed: positive = gained ground. */
  territoryShareDeltaPercent: number | null;
  aliveCount: number;
  totalCount: number;
  activeAllianceCount: number;
  activeWarCount: number;
  /** Current Director Cut segment label (e.g. "Opening", "First strike", "Final conflict") or live event phase — `null` before the caller can resolve one (e.g. pre-connection). */
  currentPhaseLabel: string | null;
}

function formatSignedPercent(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "±0";
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function stripItem(className: string, label: string, value: string): HTMLElement {
  const item = element("div", `broadcast-state-strip-item ${className}`);
  item.append(
    element("span", "broadcast-state-strip-label", label),
    element("span", "broadcast-state-strip-value", value),
  );
  return item;
}

export function renderMatchStateStrip(input: MatchStateStripInput): HTMLElement {
  const strip = element("div", "broadcast-state-strip");
  strip.setAttribute("role", "status");
  strip.setAttribute("aria-label", translateText("broadcast.state_strip_heading"));

  strip.append(
    stripItem(
      "broadcast-state-strip-leader",
      translateText("broadcast.state_strip_leader_label"),
      input.leader === null
        ? translateText("broadcast.state_strip_leader_unknown")
        : translateText("broadcast.state_strip_leader_value", {
            name: input.leader.displayName,
            percent: Math.round(input.leader.territoryPercent),
          }),
    ),
  );
  if (input.territoryShareDeltaPercent !== null) {
    const delta = stripItem(
      "broadcast-state-strip-delta",
      translateText("broadcast.state_strip_delta_label"),
      formatSignedPercent(input.territoryShareDeltaPercent),
    );
    delta.dataset.direction =
      input.territoryShareDeltaPercent > 0
        ? "up"
        : input.territoryShareDeltaPercent < 0
          ? "down"
          : "flat";
    strip.append(delta);
  }
  strip.append(
    stripItem(
      "broadcast-state-strip-alive",
      translateText("broadcast.state_strip_alive_label"),
      translateText("broadcast.state_strip_alive_value", {
        alive: input.aliveCount,
        total: input.totalCount,
      }),
    ),
  );
  strip.append(
    stripItem(
      "broadcast-state-strip-relations",
      translateText("broadcast.state_strip_relations_label"),
      translateText("broadcast.state_strip_relations_value", {
        alliances: input.activeAllianceCount,
        wars: input.activeWarCount,
      }),
    ),
  );
  if (input.currentPhaseLabel !== null) {
    strip.append(
      stripItem(
        "broadcast-state-strip-phase",
        translateText("broadcast.state_strip_phase_label"),
        input.currentPhaseLabel,
      ),
    );
  }
  return strip;
}
