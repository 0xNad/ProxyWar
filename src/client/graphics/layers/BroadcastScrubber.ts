import { GameView, PlayerView } from "../../../core/game/GameView";
import {
  aiLeagueSpectatorDisplayName,
  isAiLeagueReplayRoute,
} from "../../AiLeagueReplayMode";
import {
  LEAD_CHANGE_HEADLINE_KEY,
  leadChangeHeadlineDefault,
} from "../../LeadChangeTracker";
import {
  broadcastLullSpans,
  broadcastLullSpanVersion,
} from "../../LullDirector";
import { nearestFrameAtOrBefore } from "../../ReplayFrameCache";
import {
  spectatorReplaySnapshots,
  spectatorReplayVersion,
} from "../../SpectatorReplayStore";
import { translateText } from "../../Utils";
import { followedCompetitorSmallId } from "./FollowedCompetitor";
import { Layer } from "./Layer";

/**
 * ============================================================================
 * BROADCAST SCRUBBER — the transport a viewer can actually drive.
 * ============================================================================
 *
 * WHAT WAS WRONG
 * --------------
 * Measured on the r45 board: the incumbent timeline rendered 195 markers, all
 * of them `data-seekable="true"` — and SIX were visible. The r31 pass that
 * quietened the timeline into "information" hid every routine kind, and hiding
 * a marker also removes the only thing you could click. There was no track,
 * no playhead, no progress fill and no drag. In practice the match had six
 * reachable points across 14,200 turns.
 *
 * This is a real transport: a track across the board's width, a filled
 * progress bar, a playhead, hit-anywhere seeking, drag, and the events that
 * matter drawn as symbols you can aim at — a mushroom cloud where a warhead
 * lands, a skull where a competitor dies, and a crown where the lead changed
 * hands. The crown is the newest and, for a standings broadcast, the most
 * load-bearing: a match's story is who is winning changing, and until it was
 * added the decisive beats were the only major ones with nothing on the
 * transport to aim at.
 *
 * FORWARD IS CHEAP, BACKWARD IS A RESIMULATION
 * ---------------------------------------------
 * This is the constraint everything here is shaped around.
 * `LocalServer.jumpReplayForward()` seeks by REPLAYING turns —
 * `Math.max(this.turns.length, ...)` — so it can only ever go forward, and
 * there is no rewind in the engine at all. Going back means running the match
 * again from turn 0, which the bundle already knows how to do from the `?turn=`
 * deep link (`Main.ts`, jump-after-first-frame).
 *
 * So a backward seek pays for a real resimulation, and the one thing that must
 * never happen is a viewer left staring at an unexplained frozen board. Hence
 * `data-state="rewinding"`: the scrubber says what it is doing and where it is
 * going, for as long as it takes.
 *
 * It used to pay for a page load on top of that: `location.replace(?turn=N)`,
 * measured at 15-25 seconds, of which only ~4s (0.6ms/turn) was simulation and
 * the rest was refetching a 6MB record, re-parsing it twice, re-validating
 * ~14,000 turns and re-initialising the page — all to rebuild state that had
 * never left memory. `rewindTo` now offers the seek to the page first
 * (`ai-league-replay-rewind-turn`, cancelable) and only reloads when nobody
 * claims it. Main.ts owns the rebuild; see `rewindReplayInPlace` there for
 * what can and cannot be carried across.
 *
 * WHERE THE MARKERS COME FROM
 * ----------------------------
 * The incumbent timeline is the derivation the rest of the product already
 * agrees with, so its markers are harvested from the DOM rather than
 * re-derived here: each carries `data-kind` and a
 * `--broadcast-timeline-position` percentage, which is exactly turn-fraction.
 * Re-deriving would mean a second source of truth for "what happened when",
 * and the two would drift.
 *
 * SPOILERS ARE A VIEWER CHOICE NOW (PaintBot's pattern, our art direction)
 * ------------------------------------------------------------------------
 * The owner's call, copying PaintBot's proven replay chrome in FUNCTION:
 * default to showing everything — a broadcast replay is a story you are
 * allowed to know the shape of — with a HIDE SPOILERS affordance for viewers
 * who want to watch it cold. PaintBot's implementation (chrome_common.js,
 * `uiToggle('spoilers', true)` + `applySpoilers`) is the reference:
 * default ON, `?spoilers=0|1` URL override, keyboard "o", a labelled toggle
 * in the transport chrome, and — the important part — spoilers OFF means the
 * future is CLIPPED, not dimmed: a clipPath rect trimmed to the playhead
 * fraction reveals the momentum graph 1:1 as playback advances, and the same
 * gate anonymises future event symbols.
 *
 * Here that translates to: with spoilers ON the territory-race graph draws
 * full-width immediately and future nuke/skull/crown marks show their real
 * symbols; with spoilers OFF the graph is clipped at the playhead and any
 * symbol-worthy mark beyond it renders as the same anonymous tick the
 * upstream redaction produces — so you can still seek to it without being
 * told a nuke is coming, or which nation is about to take the lead.
 *
 * NOTE ON THE UPSTREAM REDACTION: `renderMatchTimeline` independently rewrites
 * the kind of any marker beyond the playhead to the synthetic `upcoming`
 * before we ever harvest it. Until that call is taught to consult
 * `broadcastSpoilersEnabled()` (Main.ts wiring, owned elsewhere), spoilers ON
 * can only reveal real future kinds once the overlay stops redacting them —
 * this component is ready either way, and with spoilers OFF it re-applies the
 * equivalent redaction locally so the overlay change cannot leak.
 *
 * THE TERRITORY RACE GRAPH (PaintBot's momentum graph, translated)
 * ----------------------------------------------------------------
 * PaintBot layers an SVG step-line chart INSIDE the same container as its
 * seek track (viewBox "0 0 1000 100", preserveAspectRatio "none") so a
 * point's x IS its position on the transport — 1:1 with the playhead, no
 * separate row, and the whole-match series is drawn IMMEDIATELY in full ("a
 * broadcast win-probability graph, not a line that grows as it plays"). In
 * its multi-player mode it draws one colored step-line per player on a shared
 * 0..peak scale, floor-anchored. All of that carries over; the pixels are
 * ours (seat colors, house type, hairline weights).
 *
 * GEOMETRY (owner report, r46): PaintBot's scrub container is one band with
 * the RAIL AT THE TOP and the momentum SVG in the LOWER portion
 * (league_replayer.html:211-228) — and critically its page RESERVES that
 * strip, so the chart never fights the game for contrast. Our board is
 * full-bleed, and the first pass drew the lines transparent over the busy
 * map ("overlayed on a bunch of stuff so you cant see it" — the owner's
 * screenshot). So the band replicates PaintBot's EFFECT: the transport row
 * (rail, fill, playhead, marks) sits at the TOP of the band, and the graph
 * lives in a strip BELOW it that brings its own ground — opaque warm glass
 * with a top hairline — so the step-lines always read against a controlled
 * dark surface. The whole band, strip included, is still one seek surface,
 * and the playhead pierces both the transport row and the strip.
 *
 * The data is the envelope's `spectatorReplay.snapshots`, retained by
 * SpectatorReplayStore (it used to be parsed and dropped). Gotchas that shape
 * the code, verified against the real fixture: the cadence is IRREGULAR so
 * points are plotted by turnNumber, never index; eliminated players simply
 * VANISH from later snapshots (never an isAlive:false), so identity is
 * tracked by username across snapshots and "missing" means tilesOwned = 0
 * from then on — the line steps to the floor and stays, which is exactly the
 * story; and the snapshot color field is the stock engine palette, so display
 * colors are resolved at runtime against PlayerView.territoryColor(), the
 * same accessor the board and the lanes paint with.
 */

/**
 * Symbols the scrubber draws. Everything else is an anonymous tick.
 *
 * `lead_change` was the hole here. A match's story IS the lead changing
 * hands — on the reference fixture the whole thing turns inside one window
 * where a nation collapses from 135,243 tiles to 10,020 — and the overlay has
 * been publishing `lead_change` timeline markers all along (see
 * `matchTimelineEventMarkers`). This union just never had the kind, so
 * `markKind()` folded every crown into the generic `"event"` bucket, and
 * `harvestMarks()` drops `"event"` outright: the decisive beats of the match
 * were the only major beats with nothing on the transport at all.
 */
type MarkKind =
  | "nuke"
  | "elimination"
  | "lead_change"
  | "finish"
  | "event"
  | "upcoming";

interface ScrubMark {
  kind: MarkKind;
  /** Position along the match, 0..1. */
  at: number;
  label: string;
}

const HARVEST_INTERVAL_MS = 1500;

/**
 * How close to the playhead a seek stops being able to move it — in BOTH
 * directions, and it is the ENGINE's number, not a taste call.
 * `LocalServer.jumpReplayForward()` clamps its target to
 * `Math.max(this.turns.length, ...)`, and at speed the dispatch queue runs up
 * to `MAX_REPLAY_BACKLOG_TURNS = 60` ahead of the rendered tick, so a forward
 * ask inside this window is a guaranteed silent no-op. Backward inside it is
 * technically possible but absurd: a full resimulation to reach somewhere
 * playback arrives on its own within ~6 seconds.
 *
 * Exported because `Main.ts` owns the single seek policy (`onReplayJump`) and
 * this transport has to describe the SAME window to the viewer. Two copies of
 * this number would drift, and the drift shows up as a status line promising a
 * seek that cannot happen.
 */
export const REPLAY_SEEK_DEAD_ZONE_TURNS = 64;

/**
 * How long a one-shot status line holds the status row against `paint()`,
 * which rewrites it every tick. Long enough to read six words at a glance,
 * short enough that it is gone before the viewer wonders if it is stuck.
 */
const STATUS_FLASH_MS = 1600;

/**
 * How far BEFORE an event a symbol click lands. Clicking a skull used to
 * deep-link to the elimination turn itself, and the forward catch-up
 * overshoots by ~150 turns on top of that — the viewer arrived AFTER the kill
 * with nothing to see (audit finding). ~300 turns is ~30 seconds of game time
 * at 1x (the clock contract is ten engine ticks a second, see formatClock):
 * enough for the kill to develop in front of the viewer, small enough that
 * the detour never feels like a rewind.
 */
const MARK_SEEK_LEAD_TURNS = 300;

/**
 * PaintBot's exact viewBox for its momentum chart: "0 0 1000 100" with
 * preserveAspectRatio "none", stretched over the track's real box so chart x
 * and transport x are the same axis. Floor at VB_H-2, headroom of 2 — the
 * biggest holding touches the band edge without clipping its stroke.
 */
const GRAPH_VB_W = 1000;
const GRAPH_VB_H = 100;
const GRAPH_FLOOR_Y = GRAPH_VB_H - 2;
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * ---------------------------------------------------------------------------
 * SPOILERS: module-level state, PaintBot precedence.
 * ---------------------------------------------------------------------------
 * Module-level (not instance) because an in-place rewind rebuilds the
 * scrubber and the viewer's choice must survive that. Read order:
 * explicit URL param beats the session-persisted choice beats the default of
 * ON — PaintBot's `uiToggle('spoilers', true)` reads only the URL; the
 * session persistence is ours, keyed in ReplayPositionPersistence's flat
 * "proxywar:" namespace (that file's doc explains why one flat namespace is
 * safe, and why sessionStorage: a genuinely NEW visit should get the default,
 * not a stale preference from another session). Deliberately NOT keyed per
 * run: spoiler appetite belongs to the viewer, not to one match.
 */
const SPOILERS_STORAGE_KEY = "proxywar:replay-spoilers";

let spoilersOn = true;
let spoilersStateRead = false;
let spoilersKeyBound = false;
let activeSpoilersChanged: (() => void) | null = null;

/**
 * Instance counter, used only to keep this layer's SVG clipPath id unique.
 * `id` is DOCUMENT-global: during an in-place rewind the outgoing scrubber and
 * the incoming one can both be in the document for a moment, and two nodes
 * sharing `pw-scrub-spoiler-clip` means every `url(#...)` reference resolves
 * to whichever the browser saw first — i.e. the live graph clipped by a dead
 * instance's rect, frozen at the pre-rewind playhead.
 */
let scrubberInstanceSeq = 0;

/**
 * Exported for the overlay integration: `renderMatchTimeline`'s own
 * beyond-the-playhead redaction should be skipped exactly when this returns
 * true (Main.ts / AiLeagueReplayOverlay wiring, owned outside this file).
 */
export function broadcastSpoilersEnabled(): boolean {
  ensureSpoilersState();
  return spoilersOn;
}

function ensureSpoilersState(): void {
  if (spoilersStateRead) return;
  spoilersStateRead = true;
  spoilersOn = readInitialSpoilers();
}

function readInitialSpoilers(): boolean {
  // PaintBot's uiToggle accepts 1/0, true/false, on/off; same grammar here so
  // whatever launches a replay can preconfigure the chrome either way.
  try {
    const raw = new URLSearchParams(window.location.search)
      .get("spoilers")
      ?.toLowerCase();
    if (raw === "1" || raw === "true" || raw === "on") return true;
    if (raw === "0" || raw === "false" || raw === "off") return false;
  } catch {
    /* no URL access — fall through to the persisted choice */
  }
  try {
    const saved = sessionStorage.getItem(SPOILERS_STORAGE_KEY);
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    /* storage unavailable (private browsing, quota) — default wins */
  }
  return true;
}

function setSpoilersOn(on: boolean): void {
  ensureSpoilersState();
  if (spoilersOn === on) return;
  spoilersOn = on;
  try {
    sessionStorage.setItem(SPOILERS_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* not persistable this session; the toggle still works */
  }
  // Broadcast the flip so the overlay's own timeline redaction can follow
  // suit once it is wired to listen (same DOM CustomEvent bus every other
  // replay subsystem here uses — never a bespoke callback registry).
  document.dispatchEvent(
    new CustomEvent("ai-league-replay-spoilers-changed", { detail: { on } }),
  );
  activeSpoilersChanged?.();
}

/** True when a keystroke belongs to a text control, not to the transport. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export class BroadcastScrubber implements Layer {
  private root: HTMLElement | null = null;
  private track: HTMLElement | null = null;
  private fill: HTMLElement | null = null;
  private head: HTMLElement | null = null;
  private marksLayer: HTMLElement | null = null;
  private lullLayer: HTMLElement | null = null;
  /** Lull-map version last rendered as track shading; -1 = never rendered. */
  private lullVersionRendered = -1;
  private readout: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private marks: ScrubMark[] = [];
  private marksKey = "";
  private lastHarvestMs = 0;
  private totalTurns = 0;
  private currentTurn = 0;
  private dragging = false;
  /**
   * Spawn-phase length in turns, resolved once from the live Config. The match
   * clock has to start where the SIDEBAR's clock starts or the two disagree on
   * screen — see `formatClock`. -1 = not read yet.
   */
  private spawnPhaseTurns = -1;
  /**
   * The track's box, measured on pointerdown and invalidated on resize rather
   * than read inside `pointermove`. See `bindSeek` for the measurement that
   * forced this.
   */
  private trackRect: DOMRect | null = null;
  /** Last values actually written by `paint()`; see its dirty-check note. */
  private lastPaintPct = "";
  private lastReadoutText = "";
  private lastStatusText = "";
  private lastAriaValue = "";
  /** `performance.now()` before which `paint()` must leave the status row alone. */
  private statusHoldUntilMs = 0;
  private spoilersBtn: HTMLButtonElement | null = null;
  private graphSvg: SVGSVGElement | null = null;
  private graphClipRect: SVGRectElement | null = null;
  /** Seat-colored step-lines, one per snapshot identity; built once per load. */
  private graphPaths: Array<{ path: SVGPathElement; smallId: number | null }> =
    [];
  /** Store version the polylines were built against; -1 = never built. */
  private graphBuiltVersion = -1;
  private emphasizedFollowId: number | null = null;
  private lastClipWidth = "";
  /** How many marks the playhead had passed at the last marks render. */
  private lastRevealCount = -1;
  /**
   * Mark-label -> resolved seat color, for the two kinds that wear one: the
   * elimination skull (the DYING seat) and the lead-change crown (the seat
   * that TOOK the lead). The harvest re-renders the marks every time the key
   * changes, so without this every render would re-parse the label and
   * re-walk the PlayerViews per symbol. Only HITS are cached: PlayerViews
   * hydrate after the first harvests can land, and a cached miss would freeze
   * an early "couldn't resolve" into a permanently fallback-coloured symbol
   * for a seat that resolves fine two seconds later.
   */
  private seatColorByLabel = new Map<string, string>();
  /**
   * DRAG PREVIEW SURFACE — what makes dragging FEEL like scrubbing.
   * Diagnosed live: release-seeking WORKED (the event fired, the engine
   * fast-forwarded or resimulated), but nothing moved WHILE dragging, and
   * against PaintBot's instant scrub that read as broken. The engine cannot
   * jump arbitrarily (forward replays turns, backward rebuilds from zero —
   * fixed physics), so the fix is perceptual: while a drag is live, a
   * fixed-position surface over the board shows the nearest cached frame at
   * or before the drag turn (ReplayFrameCache, captured as playback passes
   * turns), swapped only when the nearest frame changes. Built lazily on
   * first drag, torn down on init like the scrubber root (a rewind re-inits
   * against a document still holding the old one).
   */
  private previewRoot: HTMLElement | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewTag: HTMLElement | null = null;
  /** Turn of the bitmap currently painted on the preview canvas; -1 = none painted yet. */
  private previewPaintedTurn = -1;
  /**
   * TEARDOWN SCOPE. Same `AbortController` idiom `InputHandler.ts` uses, for
   * the same reason: every registration in `bindSeek` is an inline arrow, so
   * handler identity is not recoverable after the fact and signal-based
   * removal is the only option that does not mean rewriting every call site.
   */
  private readonly teardown = new AbortController();
  private disposed = false;
  private readonly spoilersChanged = () => this.onSpoilersChanged();
  /** Document-unique SVG clipPath id; see `scrubberInstanceSeq`. */
  private readonly clipId = `pw-scrub-spoiler-clip-${++scrubberInstanceSeq}`;

  constructor(private game: GameView) {}

  /**
   * 33ms, not every frame. Everything this layer does per tick is a handful of
   * now-dirty-checked style writes and an integer compare, driving a playhead
   * that moves a fraction of a pixel between 60Hz frames — half the DOM
   * traffic for no perceptible difference. 30Hz is still comfortably above the
   * rate at which the playhead reads as continuous motion.
   */
  getTickIntervalMs() {
    return 33;
  }

  init() {
    // dispose() may have run first (it is allowed to run before init(), and
    // its AbortController would silently swallow every listener registered
    // after it) — a disposed layer must stay disposed rather than mount a
    // scrubber nothing can drive.
    if (this.disposed) return;
    this.totalTurns = Number(document.body.dataset.pwReplayTotalTurns ?? 0);
    ensureSpoilersState();
    mountScrubberStyles();

    // IDEMPOTENT MOUNT. A rewind rebuilds the game in place, so init() runs
    // again against a document that still holds the previous scrubber —
    // which would sit there frozen on "REWINDING TO ..." forever, behind
    // the live one, because its layer is no longer ticked.
    document.querySelector(".pw-scrubber")?.remove();
    // Same reasoning for the drag-preview surface: a stale one from the
    // pre-rewind instance would sit inert over the rebuilt board.
    document.querySelector(".pw-scrub-preview")?.remove();
    const root = document.createElement("div");
    root.className = "pw-scrubber";
    root.dataset.state = "idle";

    const readout = document.createElement("div");
    readout.className = "pw-scrub-readout";

    const track = document.createElement("div");
    track.className = "pw-scrub-track";
    track.setAttribute("role", "slider");
    track.setAttribute(
      "aria-label",
      translateText(
        "ai_league_replay.match_timeline",
        undefined,
        "Match timeline",
      ),
    );
    track.tabIndex = 0;

    const rail = document.createElement("div");
    rail.className = "pw-scrub-rail";
    const fill = document.createElement("div");
    fill.className = "pw-scrub-fill";
    // LULL SHADING container, PaintBot's affordance and PaintBot's draw
    // order: its #lulls div rides ABOVE track+fill "so the quiet stretches
    // read" and UNDER the win segment, markers and head
    // (replay_broadcast.html:1371-1373; DOM order league_replayer.html:
    // 304-313). Here that means appended after `fill`, before `marksLayer`
    // and `head`, so the dimmed spans mute the rail and the amber progress
    // fill but never a symbol or the playhead. The spans come from
    // LullDirector's record scan (see renderLullShading).
    const lullLayer = document.createElement("div");
    lullLayer.className = "pw-scrub-lulls";
    const marksLayer = document.createElement("div");
    marksLayer.className = "pw-scrub-marks";
    const head = document.createElement("div");
    head.className = "pw-scrub-head";

    // The territory-race STRIP: still inside the track (PaintBot's layering —
    // chart and seek bar share one container so chart x IS transport x), but
    // as the LOWER portion of the band on its own opaque backdrop; see the
    // GEOMETRY note in the class doc for the owner report that moved it. The
    // strip is pointer-events:none so a click on the graph area is a seek,
    // exactly like a click on the rail — the whole band is one click-catcher
    // (only the SPOILERS button inside re-enables its own pointer events).
    const strip = document.createElement("div");
    strip.className = "pw-scrub-strip";
    const graph = document.createElementNS(SVG_NS, "svg");
    graph.setAttribute("class", "pw-scrub-graph");
    graph.setAttribute("viewBox", `0 0 ${GRAPH_VB_W} ${GRAPH_VB_H}`);
    graph.setAttribute("preserveAspectRatio", "none");
    graph.setAttribute("aria-hidden", "true");
    const graphLabel = document.createElement("div");
    graphLabel.className = "pw-scrub-graph-label";
    graphLabel.textContent = translateText(
      "ai_league_replay.territory_race",
      undefined,
      "TERRITORY RACE",
    );

    // SPOILERS toggle, INSIDE the strip at its right end — the same
    // affordance PaintBot puts on its transport chrome ("spoilers", lit when
    // on), translated to our tokens: ink-dim label when off, amber with an
    // amber underline when on. Keyboard "o" and ?spoilers=0|1 mirror it, and
    // they are the whole interface at the tiers where the strip is absent
    // (<=740px hides the button, <=560px and data-graph="0" hide the strip).
    const spoilersBtn = document.createElement("button");
    spoilersBtn.className = "pw-scrub-spoilers";
    spoilersBtn.type = "button";
    spoilersBtn.textContent = translateText(
      "ai_league_replay.spoilers",
      undefined,
      "SPOILERS",
    );
    spoilersBtn.title = translateText(
      "ai_league_replay.spoilers_hint",
      undefined,
      "Show future events ahead of the playhead (o)",
    );
    spoilersBtn.setAttribute("aria-pressed", spoilersOn ? "true" : "false");
    // POINTERDOWN, not just click: the track's drag starts on the pointer
    // stream (see the trap note in bindSeek), so a click-only
    // stopPropagation would still let a press here start a seek drag. The
    // mark buttons carry the same guard; the track's own pointerdown also
    // refuses interactive targets — two layers, one trap.
    spoilersBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    spoilersBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setSpoilersOn(!spoilersOn);
    });
    strip.append(graph, graphLabel, spoilersBtn);

    // Head appended last so the playhead stacks over the strip and visually
    // pierces both the transport row and the graph — one instrument, not a
    // chart row with its own cursor (PaintBot's knob crosses its chart too).
    track.append(strip, rail, fill, lullLayer, marksLayer, head);

    const status = document.createElement("div");
    status.className = "pw-scrub-status";

    root.append(readout, track, status);
    document.body.appendChild(root);

    this.root = root;
    this.track = track;
    this.fill = fill;
    this.head = head;
    this.marksLayer = marksLayer;
    this.lullLayer = lullLayer;
    // A rewind re-init starts with an empty container, whatever version the
    // module-level map is on — force one render against the fresh DOM.
    this.lullVersionRendered = -1;
    this.readout = readout;
    this.status = status;
    this.spoilersBtn = spoilersBtn;
    this.graphSvg = graph;

    this.bindSeek(track);
    this.bindMarkDelegation(marksLayer);

    // The "o" shortcut binds ONCE at the window (module flag), not per
    // instance: an in-place rewind re-inits the layer without a page reload,
    // and a second window listener would toggle twice per keypress — a no-op
    // that looks like a dead key. The handler routes through module state and
    // whichever instance is current.
    activeSpoilersChanged = this.spoilersChanged;
    if (!spoilersKeyBound) {
      spoilersKeyBound = true;
      window.addEventListener("keydown", (e) => {
        if (e.key !== "o" || e.metaKey || e.ctrlKey || e.altKey) return;
        if (isTextEntryTarget(e.target)) return;
        if (activeSpoilersChanged === null) return;
        setSpoilersOn(!spoilersOn);
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown.abort();
    this.root?.remove();
    this.previewRoot?.remove();
    if (activeSpoilersChanged === this.spoilersChanged) {
      activeSpoilersChanged = null;
    }
  }

  /**
   * Everything that must react when the spoilers gate flips: the button's
   * pressed state, the graph clip (forced re-apply via the cached-width
   * reset), and the marks layer (future symbols anonymise / reveal).
   */
  onSpoilersChanged() {
    this.spoilersBtn?.setAttribute(
      "aria-pressed",
      spoilersOn ? "true" : "false",
    );
    this.lastClipWidth = "";
    this.updateSpoilerClip();
    this.lastRevealCount = -1;
    this.renderMarks();
  }

  private bindSeek(track: HTMLElement) {
    /**
     * TRACK GEOMETRY, MEASURED ONCE PER DRAG. `getBoundingClientRect()` used
     * to run inside `pointermove`, in the same call stack that then WROTE
     * styles in `paint()` — a read-after-write against a dirtied layout tree,
     * i.e. 60-120 forced synchronous layouts a second for the entire duration
     * of a scrub (performance audit). The track's box cannot change while a
     * pointer is down without a resize, so it is measured on pointerdown and
     * invalidated by the resize listener below; the `??=` covers the paths
     * that can reach here without a pointerdown (a keyboard seek).
     */
    const fractionFor = (clientX: number): number => {
      const b = (this.trackRect ??= track.getBoundingClientRect());
      if (b.width <= 0) return 0;
      return Math.min(1, Math.max(0, (clientX - b.x) / b.width));
    };
    window.addEventListener(
      "resize",
      () => {
        this.trackRect = null;
      },
      { signal: this.teardown.signal },
    );

    const preview = (clientX: number) => {
      const f = fractionFor(clientX);
      this.paint(f, true);
      this.showDragPreview(f);
    };

    track.addEventListener("pointerdown", (e) => {
      // CLICK-VS-POINTER STREAM TRAP (owner P1: "clicking spoilers does
      // nothing. the click is taken by the scrubber and it fast forwards to
      // that point"). The seek is NOT a click handler: it is this
      // POINTERDOWN (drag start) plus the window POINTERUP (finish() ->
      // seekToFraction) — a different event stream that a control's
      // click-only stopPropagation can never intercept. Pressing a button
      // inside the band would therefore start a drag at the button's own x
      // (SPOILERS sits at the far right of the strip) and the release would
      // seek there — a surprise fast-forward to near the end, with the
      // toggle itself never registering reliably. So the track refuses to
      // START a drag on any interactive control; the controls' own
      // pointerdown stopPropagation (SPOILERS and every mark button) stays
      // as the second layer of the same defense.
      if (
        (e.target as Element | null)?.closest?.(
          ".pw-scrub-spoilers, .pw-scrub-mark, button",
        )
      ) {
        return;
      }
      this.dragging = true;
      // The one layout read of the whole drag (see fractionFor above).
      this.trackRect = track.getBoundingClientRect();
      // Capture keeps a drag alive when the pointer leaves the 26px track,
      // but it is an optimisation, not a requirement — and it throws for a
      // pointer id the browser does not consider active. A failed capture must
      // never cost the viewer the seek itself.
      try {
        track.setPointerCapture(e.pointerId);
      } catch {
        /* drag still works, it just ends if the pointer leaves the track */
      }
      preview(e.clientX);
    });
    track.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      preview(e.clientX);
    });
    const finish = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      // The preview drops INSTANTLY on release — the existing seek paths
      // (forward jump / rewind event) run unchanged right after, and holding
      // a downscaled still over a board that is about to move would read as
      // the seek having landed blurry.
      this.hideDragPreview();
      this.seekToFraction(fractionFor(e.clientX));
    };
    // On the WINDOW, not the track: if setPointerCapture failed (caught
    // above), a release outside the 26px track never fires on the track and
    // the drag wedges — the playhead freezes at the preview position until the
    // next pointerdown. A window listener always sees the release; the
    // `dragging` flag makes it a no-op when no drag is live, and under a
    // successful capture the retargeted event still bubbles to window, so
    // finish() runs exactly once either way.
    //
    // ALL THREE WINDOW LISTENERS ARE ABORT-SCOPED (`dispose`'s doc has the
    // leak they used to be): init() runs again on every in-place rewind, and
    // each of these closures pins the dead scrubber, its graph SVG and the
    // previous GameView for the rest of the session.
    window.addEventListener("pointerup", finish, {
      signal: this.teardown.signal,
    });
    window.addEventListener(
      "pointercancel",
      () => {
        this.dragging = false;
        this.hideDragPreview();
      },
      { signal: this.teardown.signal },
    );
    // Escape ABANDONS the drag: preview down, no seek — the viewer flipped
    // through the match and decided to stay put. Window-level like the
    // pointer listeners above (a captured pointer keeps key focus wherever it
    // was), and a no-op when no drag is live, so the stale instances a rewind
    // leaves behind cannot act (same `dragging`-guard pattern as pointerup).
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !this.dragging) return;
        this.dragging = false;
        this.hideDragPreview();
      },
      { signal: this.teardown.signal },
    );

    // Keyboard: the transport has to be reachable without a mouse.
    track.addEventListener("keydown", (e) => {
      if (this.totalTurns <= 0) return;
      const stepTurns = e.shiftKey ? 1000 : 200;
      if (e.key === "ArrowRight") {
        this.seekToTurn(this.currentTurn + stepTurns);
      } else if (e.key === "ArrowLeft") {
        this.seekToTurn(this.currentTurn - stepTurns);
      } else if (e.key === "Home") {
        this.seekToTurn(0);
      } else if (e.key === "End") {
        this.seekToTurn(this.totalTurns);
      } else {
        return;
      }
      e.preventDefault();
    });
  }

  private seekToFraction(fraction: number) {
    if (this.totalTurns <= 0) return;
    this.seekToTurn(Math.round(fraction * this.totalTurns));
  }

  /**
   * ONE DISPATCH, NO POLICY. Every seek from this transport goes out as the
   * same `ai-league-replay-jump-turn` event the analyst drawer, the timeline
   * markers, the jump controls and the archive view already send, and
   * `Main.onReplayJump` decides what it costs.
   *
   * This method used to branch forward-vs-backward itself — and it was the
   * ONLY dispatcher that did, which is exactly why a backward seek from any of
   * those other four surfaces was a silent no-op (that handler's doc has the
   * full account). Two implementations of one policy is one too many; the
   * second one is gone, along with its `location.replace(?turn=N)` fallback,
   * which now lives with the policy in `Client.seekReplayBackward`.
   *
   * The transport no longer paints its own "REWINDING TO ..." state either:
   * the rebuild is synchronous from inside this dispatch, so `RewindCurtain`
   * is already over the screen before this call returns, and the rebuild then
   * destroys this instance outright. It was a message nobody could ever see.
   */
  private seekToTurn(rawTurn: number) {
    if (this.totalTurns <= 0) return;
    const turn = Math.min(this.totalTurns, Math.max(0, Math.round(rawTurn)));
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-jump-turn", {
        detail: { turnNumber: turn },
      }),
    );
  }

  /**
   * A mark click lands BEFORE its event, never on it (see
   * `MARK_SEEK_LEAD_TURNS`) — but the lead has to be clamped out of the
   * engine's dead zone or the click does nothing at all. Measured: the lead is
   * 300 turns, the dead zone is ±64, so EVERY nuke and skull between the
   * playhead and +364 turns computed a target the engine cannot reach and was
   * inert — precisely the marks a viewer aims at, since they are the ones
   * just ahead.
   */
  private seekToMark(markTurn: number) {
    if (!Number.isFinite(markTurn) || this.totalTurns <= 0) return;
    const earliestReachable =
      this.currentTurn + REPLAY_SEEK_DEAD_ZONE_TURNS + 1;
    if (markTurn <= earliestReachable) {
      // Nowhere to go: playback reaches this mark inside ~6 seconds and any
      // seek that could move would land PAST it. Say that, rather than
      // absorbing the click into silence.
      this.flashStatus(
        translateText(
          "ai_league_replay.already_arriving",
          undefined,
          "ALREADY ARRIVING — KEEP WATCHING",
        ),
      );
      return;
    }
    this.seekToTurn(
      Math.max(earliestReachable, markTurn - MARK_SEEK_LEAD_TURNS),
    );
  }

  /**
   * Hold one line in the status row for a beat. `paint()` rewrites that row
   * every tick, so a bare assignment is erased on the next frame — which is
   * how "that seek cannot move" came to be communicated by nothing at all.
   */
  private flashStatus(text: string) {
    if (this.status === null) return;
    this.status.textContent = text;
    this.lastStatusText = text;
    this.statusHoldUntilMs = performance.now() + STATUS_FLASH_MS;
  }

  /**
   * What the status row promises while a drag is live — and it has to be TRUE.
   * The old two-way message had no third case, so a release anywhere inside
   * the engine's own reach said RELEASE TO SEEK and then did nothing: the
   * playhead snapped back with no explanation, which reads as broken.
   */
  private scrubHintFor(fraction: number): string {
    const target = fraction * this.totalTurns;
    if (target > this.currentTurn + REPLAY_SEEK_DEAD_ZONE_TURNS) {
      return translateText(
        "ai_league_replay.release_to_seek",
        undefined,
        "RELEASE TO SEEK",
      );
    }
    if (target < this.currentTurn - REPLAY_SEEK_DEAD_ZONE_TURNS) {
      return translateText(
        "ai_league_replay.release_to_rewind",
        undefined,
        "RELEASE TO REWIND — COSTS A RESIMULATION",
      );
    }
    return translateText(
      "ai_league_replay.already_here",
      undefined,
      "ALREADY HERE",
    );
  }

  /** Ticks every frame; the work is a handful of style writes. */
  tick() {
    if (this.root === null) return;
    if (this.totalTurns <= 0) {
      this.totalTurns = Number(document.body.dataset.pwReplayTotalTurns ?? 0);
    }
    this.currentTurn = this.game.ticks();

    // Build the race polylines ONCE per data load (43 samples x 16 players is
    // nothing), never per frame. Retried from here only because the store is
    // populated at parse time while PlayerViews hydrate later — the method
    // marks the version consumed the moment it can actually build (or knows
    // there is nothing to build), so this check settles to a no-op integer
    // compare within the first seconds of playback.
    if (this.graphBuiltVersion !== spectatorReplayVersion()) {
      this.tryBuildGraph();
    }

    // Follow emphasis is a per-change attribute write, not a rebuild: the
    // graph answers "how did MY nation's race go", so the followed seat's
    // line reads at full weight while the field sits back.
    const followed = followedCompetitorSmallId();
    if (followed !== this.emphasizedFollowId) {
      this.applyFollowEmphasis(followed);
    }

    const now = performance.now();
    if (now - this.lastHarvestMs > HARVEST_INTERVAL_MS) {
      this.lastHarvestMs = now;
      this.harvestMarks();
      // Lull shading re-renders only when the director's map version moves —
      // twice per load at most (intent-only pass, then the beat-refined
      // pass), so this is an integer compare on the harvest cadence.
      if (this.lullVersionRendered !== broadcastLullSpanVersion()) {
        this.renderLullShading();
      }
      // Spoilers OFF re-renders marks as the playhead passes them, on this
      // same 1.5s cadence — reveal granularity, not per-frame DOM churn. The
      // count of passed marks only ever moves when a reveal is actually due.
      if (!spoilersOn) {
        const revealed = this.countPassedMarks();
        if (revealed !== this.lastRevealCount) this.renderMarks();
      }
    }

    if (!this.dragging) {
      this.paint(
        this.totalTurns > 0 ? this.currentTurn / this.totalTurns : 0,
        false,
      );
    }
  }

  /**
   * DIRTY-CHECKED, ALL OF IT. Measured by the performance audit: these were
   * five unconditional DOM writes per tick and ~99% of them were no-ops. The
   * `aria-valuenow` one is the worst of them — it mutated the accessibility
   * tree 20 times a second on a slider nobody had touched, which is a cost
   * paid by a screen reader, not just by layout. Only the fill/playhead
   * percentage genuinely changes most ticks; the clock text changes ten times
   * less often than that, and the state attribute and status line almost
   * never.
   */
  private paint(fraction: number, scrubbing: boolean) {
    const pct = `${(fraction * 100).toFixed(3)}%`;
    if (pct !== this.lastPaintPct) {
      this.lastPaintPct = pct;
      if (this.fill !== null) this.fill.style.width = pct;
      if (this.head !== null) this.head.style.left = pct;
    }
    if (this.readout !== null) {
      const clock = this.matchClock(Math.round(fraction * this.totalTurns));
      if (clock !== this.lastReadoutText) {
        this.lastReadoutText = clock;
        this.readout.textContent = clock;
      }
    }
    if (this.root !== null) {
      const state = scrubbing ? "scrubbing" : "idle";
      if (this.root.dataset.state !== state) this.root.dataset.state = state;
    }
    if (this.status !== null && !this.statusHeld()) {
      const text = scrubbing ? this.scrubHintFor(fraction) : "";
      if (text !== this.lastStatusText) {
        this.lastStatusText = text;
        this.status.textContent = text;
      }
    }
    if (this.track !== null) {
      const value = String(Math.round(fraction * 100));
      if (value !== this.lastAriaValue) {
        this.lastAriaValue = value;
        this.track.setAttribute("aria-valuenow", value);
      }
    }
    this.updateSpoilerClip();
  }

  /** True while a `flashStatus` line still owns the status row. */
  private statusHeld(): boolean {
    if (this.statusHoldUntilMs === 0) return false;
    if (performance.now() < this.statusHoldUntilMs) return true;
    this.statusHoldUntilMs = 0;
    return false;
  }

  /**
   * The match clock, agreeing with the HUD's. See `formatClock` for why the
   * spawn phase has to come off first; the config lookup is resolved once and
   * cached because this runs on the paint path.
   */
  private matchClock(turn: number): string {
    if (this.spawnPhaseTurns < 0) {
      this.spawnPhaseTurns = this.game.config().numSpawnPhaseTurns();
    }
    return formatClock(turn, this.totalTurns, this.spawnPhaseTurns);
  }

  /**
   * PaintBot's spoiler gate for the chart, verbatim in function: a clipPath
   * rect over the graph layer, full-width when spoilers are on, trimmed to
   * the PLAYED fraction when off — clipping, not dimming, so the curve is
   * revealed 1:1 as playback advances. Driven from the paint path (PaintBot
   * drives its rect from every transport render) but keyed on the actual
   * played turn, not the drag-preview fraction: dragging forward with
   * spoilers off must not flash the future before the seek commits.
   */
  private updateSpoilerClip() {
    const rect = this.graphClipRect;
    if (rect === null) return;
    const played =
      this.totalTurns > 0
        ? Math.min(1, Math.max(0, this.currentTurn / this.totalTurns))
        : 0;
    const width = spoilersOn
      ? String(GRAPH_VB_W)
      : (played * GRAPH_VB_W).toFixed(1);
    if (width === this.lastClipWidth) return;
    this.lastClipWidth = width;
    rect.setAttribute("width", width);
  }

  /**
   * LULL SHADING, PaintBot's affordance translated: its renderLullSpans
   * (chrome_common.js:317-331) drops one dimmed div per quiet span over the
   * track so "the grayed stretches are what the skip skips" is visible
   * before the auto-pacing ever engages (chrome_common.js:307-310). Same
   * function here — the spans come from LullDirector's one-time record scan
   * (a getter import, never a second derivation) — but the pixels are ours:
   * PaintBot dims with its near-black paper-shadow; our token vocabulary
   * says quiet chrome is ink-faint at low alpha, never a new hue (the CSS
   * below). Skipped without consuming the version while totalTurns is still
   * unpublished, so the first harvest after Main's dataset write lands it.
   */
  private renderLullShading(): void {
    const layer = this.lullLayer;
    if (layer === null) return;
    if (this.totalTurns <= 0) return;
    this.lullVersionRendered = broadcastLullSpanVersion();
    const frag = document.createDocumentFragment();
    for (const span of broadcastLullSpans()) {
      const el = document.createElement("div");
      el.className = "pw-scrub-lull";
      const a = Math.min(1, Math.max(0, span.startTurn / this.totalTurns));
      const b = Math.min(1, Math.max(0, (span.endTurn + 1) / this.totalTurns));
      el.style.left = `${(a * 100).toFixed(3)}%`;
      el.style.width = `${((b - a) * 100).toFixed(3)}%`;
      frag.appendChild(el);
    }
    layer.replaceChildren(frag);
  }

  /** Marks at or behind the playhead — the reveal counter for spoilers OFF. */
  private countPassedMarks(): number {
    const playedAt =
      this.totalTurns > 0 ? this.currentTurn / this.totalTurns : 0;
    let n = 0;
    for (const mark of this.marks) {
      if (mark.at <= playedAt) n += 1;
    }
    return n;
  }

  /** See the class doc: the incumbent timeline is the single source of truth. */
  private harvestMarks() {
    const nodes = document.querySelectorAll<HTMLElement>(
      ".broadcast-timeline-marker",
    );
    if (nodes.length === 0) return;
    const next: ScrubMark[] = [];
    for (const node of nodes) {
      const raw = node.style.getPropertyValue("--broadcast-timeline-position");
      const at = Number.parseFloat(raw) / 100;
      if (!Number.isFinite(at)) continue;
      next.push({
        kind: markKind(node.dataset.kind ?? ""),
        at: Math.min(1, Math.max(0, at)),
        label: node.getAttribute("title") ?? "",
      });
    }
    // Only the symbol-worthy kinds get drawn individually; the rest would be a
    // confetti field of ticks (the exact note the aesthetic gate made about the
    // old dot strip), so routine beats are dropped entirely and the upcoming
    // ones collapse to a sparse ladder.
    const drawn = next.filter(
      (m) => m.kind !== "event" && (m.kind !== "upcoming" || hash(m.at) < 0.34),
    );
    const key = drawn.map((m) => `${m.kind}@${m.at.toFixed(4)}`).join("|");
    if (key === this.marksKey) return;
    this.marksKey = key;
    this.marks = drawn;
    this.renderMarks();
  }

  /**
   * ONE LISTENER PAIR FOR ALL THE MARKS, bound once to the container.
   *
   * Every mark used to carry its own `pointerdown` and `click` closure, and
   * `renderMarks` rebuilt every mark whenever the harvest key moved — the
   * performance audit measured ~13,000 button creations and ~26,000 listener
   * closures over a single watch, because the overlay rewrites `upcoming`
   * kinds to real ones as the playhead advances so the key moves on most of
   * the 1.5s harvest passes. Delegation makes a mark node a pure `data-turn`
   * carrier: cheap to create, cheaper to reuse, and it holds no reference to
   * this instance at all.
   *
   * The `pointerdown` half is the mark's share of the click-vs-pointer-stream
   * trap documented in `bindSeek` — this container is a child of the track, so
   * stopping propagation here is what keeps a press on a skull from starting a
   * seek drag at the skull's own x.
   */
  private bindMarkDelegation(layer: HTMLElement) {
    layer.addEventListener("pointerdown", (e) => {
      if ((e.target as Element | null)?.closest?.(".pw-scrub-mark")) {
        e.stopPropagation();
      }
    });
    layer.addEventListener("click", (e) => {
      const mark = (e.target as Element | null)?.closest?.(".pw-scrub-mark");
      if (!(mark instanceof HTMLElement)) return;
      e.stopPropagation();
      this.seekToMark(Number(mark.dataset.turn));
    });
  }

  /**
   * NODE REUSE, not `replaceChildren` — see `bindMarkDelegation` for the churn
   * this replaces. The mark COUNT barely moves between renders (the same
   * events at the same positions; usually only a kind or a redaction flips),
   * so the existing buttons are rewritten in place, dirty-checked field by
   * field, and only the difference is appended or trimmed. `innerHTML` — the
   * expensive write, an HTML parse per glyph — now runs only when a mark's
   * symbol actually changes.
   */
  private renderMarks() {
    const layer = this.marksLayer;
    if (layer === null) return;
    const playedAt =
      this.totalTurns > 0 ? this.currentTurn / this.totalTurns : 0;
    this.lastRevealCount = this.countPassedMarks();
    for (let i = 0; i < this.marks.length; i++) {
      const mark = this.marks[i];
      // Spoilers OFF re-applies the upstream redaction locally: a real kind
      // ahead of the playhead renders as the same anonymous tick the
      // overlay's own `upcoming` rewrite produces, with no title either — a
      // tooltip that says "eliminated" is as much a spoiler as a skull. Once
      // the overlay is wired to skip its rewrite when spoilers are on, this
      // filter is the only thing standing between the viewer and the future,
      // which is exactly the contract.
      //
      // `lead_change` belongs in this set for exactly the skull's reason, and
      // arguably harder: a crown sitting three-quarters of the way along the
      // track tells a cold viewer both THAT the leader they are watching gets
      // overtaken and roughly when, and its tooltip names the nation and the
      // shares outright. The whole point of a lead change is not knowing.
      const redacted =
        !spoilersOn &&
        mark.at > playedAt &&
        (mark.kind === "nuke" ||
          mark.kind === "elimination" ||
          mark.kind === "lead_change" ||
          mark.kind === "finish");
      const shownKind: MarkKind = redacted ? "upcoming" : mark.kind;

      let el = layer.children[i] as HTMLElement | undefined;
      if (el === undefined) {
        const created = document.createElement("button");
        created.className = "pw-scrub-mark";
        created.type = "button";
        layer.appendChild(created);
        el = created;
      }

      if (el.dataset.kind !== shownKind) {
        el.dataset.kind = shownKind;
        el.innerHTML =
          shownKind === "nuke"
            ? NUKE_GLYPH
            : shownKind === "elimination"
              ? SKULL_GLYPH
              : shownKind === "lead_change"
                ? CROWN_GLYPH
                : "";
      }
      const left = `${(mark.at * 100).toFixed(3)}%`;
      if (el.style.left !== left) el.style.left = left;
      const title = redacted ? "" : mark.label;
      if (el.title !== title) el.title = title;
      const aria = redacted
        ? translateText(
            "ai_league_replay.upcoming_event",
            undefined,
            "Upcoming event",
          )
        : mark.label;
      if (el.getAttribute("aria-label") !== aria) {
        el.setAttribute("aria-label", aria);
      }
      // The seek target the delegated click reads back. Stored as the MARK's
      // own turn, not the lead-adjusted one, because the clamp that keeps it
      // reachable depends on where the playhead is at CLICK time, not at
      // render time (see seekToMark).
      const turn = String(Math.round(mark.at * this.totalTurns));
      if (el.dataset.turn !== turn) el.dataset.turn = turn;

      // OWNER OVERRIDE (r46): each skull is painted in the DYING SEAT'S
      // territory color — "they should be of the color that dies". This
      // deliberately supersedes the coral severity rule FOR ELIMINATIONS
      // ONLY; nukes stay coral, and coral remains the fallback for any
      // skull whose name does not resolve (a mark must never go invisible).
      // Do not "fix" these back to coral.
      //
      // The crown follows the SAME rule pointed the other way: a lead change
      // is one seat's gain, so it wears the colour of the nation that TOOK
      // the lead (not the one that lost it — a viewer reading the track sees
      // the colour that is winning from here on). Its fallback is amber, not
      // coral: a lead change is a standings beat and coral is reserved for
      // warheads and eliminations.
      const seat =
        shownKind === "elimination"
          ? this.seatColorForEliminationLabel(mark.label)
          : shownKind === "lead_change"
            ? this.seatColorForLeadChangeLabel(mark.label)
            : null;
      if (seat !== null) {
        if (el.dataset.seat !== "1") el.dataset.seat = "1";
        if (el.style.getPropertyValue("--pw-seat-color") !== seat) {
          el.style.setProperty("--pw-seat-color", seat);
        }
      } else if (el.dataset.seat !== undefined) {
        // A reused node may have been a seat-colored skull a render ago.
        delete el.dataset.seat;
        el.style.removeProperty("--pw-seat-color");
      }
    }
    while (layer.children.length > this.marks.length) {
      layer.lastElementChild?.remove();
    }
  }

  /**
   * Build the territory-race polylines. Runs at most a handful of times (see
   * tick): it needs three things that arrive on different schedules — the
   * store (parse time), totalTurns (Main's dataset write), and PlayerViews
   * (game hydration) — and quietly waits for the latecomers by NOT consuming
   * the store version until it can actually draw. "No usable data" IS
   * consumed: an envelope without snapshots means no graph, permanently and
   * silently, and the track stays the 26px transport it was before.
   */
  private tryBuildGraph() {
    const svg = this.graphSvg;
    const root = this.root;
    if (svg === null || root === null) return;
    const version = spectatorReplayVersion();
    const snaps = spectatorReplaySnapshots();
    if (snaps === null) {
      this.graphBuiltVersion = version;
      this.graphPaths = [];
      this.graphClipRect = null;
      svg.replaceChildren();
      root.dataset.graph = "0";
      return;
    }
    if (this.totalTurns <= 0) return;
    const views = this.game.playerViews();
    if (views.length === 0) return;

    // ---- identities, plotted by turnNumber (NEVER by index: the cadence is
    // irregular — 400, 2000, 3600 ... then every ~100 turns late on).
    // Eliminated players vanish from later snapshots, so each identity's
    // value at a snapshot is "tilesOwned if present, else 0" — the vanish IS
    // the elimination, and the line steps to the floor and stays there.
    const identities: string[] = [];
    const seen = new Set<string>();
    const fallbackColor = new Map<string, string>();
    let peak = 1;
    for (const snap of snaps) {
      for (const p of snap.players) {
        if (!seen.has(p.username)) {
          seen.add(p.username);
          identities.push(p.username);
          if (p.color !== null) fallbackColor.set(p.username, p.color);
        }
        if (p.tilesOwned > peak) peak = p.tilesOwned;
      }
    }

    const xOf = (turn: number): number =>
      Math.min(1, Math.max(0, turn / this.totalTurns)) * GRAPH_VB_W;
    const yOf = (tiles: number): number =>
      GRAPH_FLOOR_Y - (tiles / peak) * (GRAPH_VB_H - 4);

    svg.replaceChildren();
    this.graphPaths = [];

    // Spoiler clip, PaintBot's mechanism: the whole line layer draws through
    // one clipPath rect; updateSpoilerClip resizes it every paint. The floor
    // baseline sits OUTSIDE the clip — it carries no information about the
    // future, and keeping it full-width keeps the band reading as one
    // instrument while the curves are still being revealed.
    const defs = document.createElementNS(SVG_NS, "defs");
    const clip = document.createElementNS(SVG_NS, "clipPath");
    clip.setAttribute("id", "pw-scrub-spoiler-clip");
    const clipRect = document.createElementNS(SVG_NS, "rect");
    clipRect.setAttribute("x", "0");
    clipRect.setAttribute("y", "0");
    clipRect.setAttribute("width", String(GRAPH_VB_W));
    clipRect.setAttribute("height", String(GRAPH_VB_H));
    clip.appendChild(clipRect);
    defs.appendChild(clip);
    svg.appendChild(defs);

    const floor = document.createElementNS(SVG_NS, "line");
    floor.setAttribute("x1", "0");
    floor.setAttribute("y1", String(GRAPH_FLOOR_Y));
    floor.setAttribute("x2", String(GRAPH_VB_W));
    floor.setAttribute("y2", String(GRAPH_FLOOR_Y));
    floor.setAttribute("stroke", "rgba(242, 236, 226, 0.14)");
    floor.setAttribute("stroke-width", "0.8");
    floor.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(floor);

    const lineLayer = document.createElementNS(SVG_NS, "g");
    lineLayer.setAttribute("clip-path", "url(#pw-scrub-spoiler-clip)");
    svg.appendChild(lineLayer);

    // ---- runtime seat colors. The snapshot color field is the STOCK engine
    // palette, not this broadcast's seats — so resolve against the live
    // PlayerViews via resolveSeatView (the ONE matcher, shared with the
    // seat-colored elimination skulls), and only then fall back to the stock
    // color rather than drawing nothing.
    let matchedCount = 0;

    for (const username of identities) {
      const view = this.resolveSeatView(username);
      if (view !== undefined) matchedCount += 1;

      let stroke: string;
      if (view !== undefined) {
        // The same accessor the board, the lanes and the scorebug paint with
        // (PlayerView.territoryColor(), NOT theme().territoryColor() which
        // ignores cosmetics) — the line must be the colour of that seat's
        // land or the graph answers "who" with the wrong nation. Seat colors
        // are exempt from the amber-only chrome rule, same as the lanes.
        const c = view.territoryColor().rgba;
        stroke = `rgb(${c.r}, ${c.g}, ${c.b})`;
      } else {
        stroke = fallbackColor.get(username) ?? "rgba(242, 236, 226, 0.5)";
      }

      // Step-after path: hold each sampled value until the next sample turn
      // (H then V, PaintBot's stepPath), anchored at the floor on the left —
      // nobody holds land before spawning — and held to the right edge so
      // the winner's line runs the full transport.
      let d = `M 0 ${GRAPH_FLOOR_Y}`;
      for (const snap of snaps) {
        const player = snap.players.find((p) => p.username === username);
        const tiles = player !== undefined ? player.tilesOwned : 0;
        d += ` H ${xOf(snap.turnNumber).toFixed(1)} V ${yOf(tiles).toFixed(1)}`;
      }
      d += ` H ${GRAPH_VB_W}`;

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      // non-scaling-stroke because preserveAspectRatio:none would otherwise
      // smear the stroke by the x/y scale ratio (PaintBot sets it for the
      // same reason). NO fills: sixteen overlapping fills is mud — PaintBot
      // itself only fills in its 2-team lead-diff mode.
      path.setAttribute("vector-effect", "non-scaling-stroke");
      lineLayer.appendChild(path);
      this.graphPaths.push({
        path,
        smallId: view !== undefined ? view.smallID() : null,
      });
    }

    // Inspectable without a console: how many snapshot identities resolved to
    // a live PlayerView (16/16 against the shipped fixture).
    svg.setAttribute("data-matched", `${matchedCount}/${identities.length}`);

    this.graphClipRect = clipRect;
    this.graphBuiltVersion = version;
    root.dataset.graph = "1";
    // Force both per-change caches through once against the fresh DOM.
    this.emphasizedFollowId = null;
    this.applyFollowEmphasis(followedCompetitorSmallId());
    this.lastClipWidth = "";
    this.updateSpoilerClip();
  }

  /**
   * The followed nation's line carries the emphasis (+0.6px, full opacity);
   * the rest of the field sits back at the base weight. Attribute writes on
   * ~16 paths, run only when the followed seat actually changes.
   */
  private applyFollowEmphasis(followed: number | null) {
    this.emphasizedFollowId = followed;
    for (const entry of this.graphPaths) {
      const isFollowed = followed !== null && entry.smallId === followed;
      entry.path.setAttribute("stroke-width", isFollowed ? "1.8" : "1.2");
      entry.path.setAttribute("stroke-opacity", isFollowed ? "1" : "0.75");
    }
  }

  /**
   * Resolve a competitor name to its live PlayerView — the ONE matcher,
   * shared by the momentum lines and the seat-colored marks (skulls and
   * crowns) so the graph and the marks can never disagree about who a name
   * is: raw name() first
   * (snapshot usernames ARE engine names, and the rebrand/anonymous modes
   * rename the views deterministically per real name — a harvested display
   * name therefore matches name() directly in those modes too), then through
   * aiLeagueSpectatorDisplayName for the renamed cases.
   */
  private resolveSeatView(name: string): PlayerView | undefined {
    const views = this.game.playerViews();
    const direct = views.find((v) => v.name() === name);
    if (direct !== undefined) return direct;
    const displayName = aiLeagueSpectatorDisplayName(name);
    return views.find(
      (v) => v.name() === displayName || v.displayName() === displayName,
    );
  }

  /**
   * The dying seat's color for an elimination mark, from its harvested label
   * ("«name» is eliminated" — the marker's title attr). The name is
   * recovered by rendering the same lang template around a sentinel and
   * stripping whatever the locale puts on either side (the exact technique
   * WarRoomToasts.statedReasonOf uses, for the same reason: a suffix-only
   * strip breaks in any translation that moves {actor} off the front), then
   * resolved through resolveSeatView and painted with
   * PlayerView.territoryColor() — the accessor the graph lines, the board
   * and the lanes already use. `null` (unparseable label, unresolvable name,
   * views not hydrated yet) means the caller keeps the coral fallback.
   */
  private seatColorForEliminationLabel(label: string): string | null {
    return this.seatColorForLabel(label, eliminationActorOf);
  }

  /**
   * The TAKING seat's color for a lead-change mark, from its harvested label
   * ("«taker» takes the lead from «loser» — «share» to «share»" — the
   * marker's title attr, built by the overlay from the one template stated in
   * LeadChangeTracker.ts). Same recovery technique and the same late-hydration
   * caching rule as the skull above; `null` means the caller keeps the amber
   * fallback rather than an unresolved crown.
   */
  private seatColorForLeadChangeLabel(label: string): string | null {
    return this.seatColorForLabel(label, leadChangeTakerOf);
  }

  /**
   * The shared body of both label->seat lookups: parse a name out of the
   * label with the caller's own template reader, resolve it to a live
   * PlayerView, and take its territory color. Only HITS are cached — see
   * `seatColorByLabel`'s own doc for why a cached miss would be a permanent
   * wrong colour on a seat that resolves fine two seconds later. Labels are
   * whole sentences and the two kinds' sentences can never collide, so one
   * map serves both.
   */
  private seatColorForLabel(
    label: string,
    actorOf: (label: string) => string,
  ): string | null {
    if (label === "") return null;
    const cached = this.seatColorByLabel.get(label);
    if (cached !== undefined) return cached;
    const name = actorOf(label);
    if (name === "") return null;
    const view = this.resolveSeatView(name);
    if (view === undefined) return null; // not cached — views hydrate late
    const c = view.territoryColor().rgba;
    const color = `rgb(${c.r}, ${c.g}, ${c.b})`;
    this.seatColorByLabel.set(label, color);
    return color;
  }

  /**
   * Raise/update the board-covering drag preview for the current drag
   * fraction. Coverage states, honestly handled:
   * - FULL/PARTIAL, frame exists at or before the drag turn: the frame is
   *   painted stretched to the board box (a 1/3-res still — soft is fine, it
   *   is a preview), tagged "PREVIEW — mm:ss" with the FRAME's own clock,
   *   which can trail the drag clock by up to one capture cadence. The
   *   bitmap is swapped only when the nearest frame actually changes (turn
   *   compare) — pointermove fires far faster than frames change.
   * - NO frame at or before the drag turn (dragging left of everything ever
   *   captured, or an empty cache on a fresh open): the tag alone
   *   ("NO FRAME YET — RELEASE TO SEEK") over a dim wash. Never a later
   *   frame lying about an earlier moment, never a stale image.
   * Never while REWINDING: pointerdown refuses drags in that state, and this
   * method guards independently in case a rewind lands mid-drag.
   */
  private showDragPreview(fraction: number) {
    // The rewind flag used to live on this instance. It cannot any more: the
    // in-flight guard moved to Main, because a rewind REBUILDS this layer and
    // instance state is exactly what the rebuild destroys. The curtain's own
    // node is the honest signal — it exists for the whole resimulation and is
    // removed when the board is real again.
    if (this.totalTurns <= 0) return;
    if (document.querySelector(".pw-rewind-curtain") !== null) return;
    let root = this.previewRoot;
    if (root === null || !root.isConnected) {
      root = this.buildPreviewSurface();
    }
    if (root.dataset.open !== "1") {
      // Positioned once per drag against the board canvas's OWN box — the
      // simplest honest geometry: the preview claims exactly the pixels the
      // board owns, whatever the HUD is doing around it. "body > canvas" is
      // the board specifically (the one canvas mounted directly on body; the
      // rewind curtain's lives nested in its overlay div).
      const board = document.querySelector("body > canvas");
      const rect =
        board instanceof HTMLCanvasElement
          ? board.getBoundingClientRect()
          : null;
      if (rect !== null && rect.width > 0 && rect.height > 0) {
        root.style.left = `${rect.left}px`;
        root.style.top = `${rect.top}px`;
        root.style.width = `${rect.width}px`;
        root.style.height = `${rect.height}px`;
      } else {
        // No measurable board (should not happen mid-replay) — cover the
        // viewport, which is what the board canvas spans anyway.
        root.style.left = "0px";
        root.style.top = "0px";
        root.style.width = "100vw";
        root.style.height = "100vh";
      }
      root.dataset.open = "1";
    }
    const dragTurn = Math.round(fraction * this.totalTurns);
    const frame = nearestFrameAtOrBefore(dragTurn);
    if (frame === null) {
      root.dataset.empty = "1";
      // Reset the swap key: the tag now reads "no frame", so returning to
      // the SAME nearest frame later must run the paint branch again or the
      // tag would keep saying "no frame" over a perfectly good picture.
      this.previewPaintedTurn = -1;
      if (this.previewTag !== null) {
        this.previewTag.textContent = translateText(
          "ai_league_replay.no_preview_frame",
          undefined,
          "NO FRAME YET — RELEASE TO SEEK",
        );
      }
      return;
    }
    root.dataset.empty = "0";
    if (frame.turn !== this.previewPaintedTurn) {
      this.previewPaintedTurn = frame.turn;
      const canvas = this.previewCanvas;
      if (canvas !== null) {
        if (canvas.width !== frame.bitmap.width) {
          canvas.width = frame.bitmap.width;
        }
        if (canvas.height !== frame.bitmap.height) {
          canvas.height = frame.bitmap.height;
        }
        canvas.getContext("2d")?.drawImage(frame.bitmap, 0, 0);
      }
      if (this.previewTag !== null) {
        const time = formatClock(frame.turn, this.totalTurns);
        this.previewTag.textContent = translateText(
          "ai_league_replay.preview_time",
          { time },
          `PREVIEW — ${time}`,
        );
      }
    }
  }

  /** Instant, idempotent drop — release, cancel and Escape all route here. */
  private hideDragPreview() {
    if (this.previewRoot !== null) this.previewRoot.dataset.open = "0";
  }

  /** Lazy one-time DOM for the preview; display is driven by data-open. */
  private buildPreviewSurface(): HTMLElement {
    const root = document.createElement("div");
    root.className = "pw-scrub-preview";
    root.dataset.open = "0";
    root.dataset.empty = "1";
    // Purely a visual echo of the drag the pointer is already narrating (the
    // readout carries the same clock accessibly); announcing every swap
    // would be noise.
    root.setAttribute("aria-hidden", "true");
    const canvas = document.createElement("canvas");
    canvas.className = "pw-scrub-preview-canvas";
    const tag = document.createElement("div");
    tag.className = "pw-scrub-preview-tag";
    root.append(canvas, tag);
    document.body.appendChild(root);
    this.previewRoot = root;
    this.previewCanvas = canvas;
    this.previewTag = tag;
    // A rebuilt surface starts with blank pixels regardless of what the old
    // instance had painted.
    this.previewPaintedTurn = -1;
    return root;
  }
}

/**
 * Recover the competitor name from an elimination marker label. The label is
 * `translateText("ai_league_replay.event_eliminated", { actor })` verbatim
 * (BroadcastComposition sets it as the marker's title), so rendering the
 * same template around a NUL sentinel yields the locale's exact prefix and
 * suffix to strip. A label that does not carry both is not an elimination
 * sentence this locale produced — return "" and let the skull stay coral.
 */
function eliminationActorOf(label: string): string {
  const template = translateText("ai_league_replay.event_eliminated", {
    actor: "\u0000",
  });
  const marker = template.indexOf("\u0000");
  if (marker < 0) return "";
  const prefix = template.slice(0, marker);
  const suffix = template.slice(marker + 1);
  if (!label.startsWith(prefix) || !label.endsWith(suffix)) return "";
  if (label.length <= prefix.length + suffix.length) return "";
  return label.slice(prefix.length, label.length - suffix.length).trim();
}

/**
 * A mushroom cloud, drawn rather than typed. Emoji-as-icons are off the house
 * style list, and at 13px an emoji would also render in whatever colour and
 * shape the platform felt like — these have to read as ours, in our coral, at
 * one size, on every machine.
 */
const NUKE_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M3.1 5.2c0-1.5 2.2-2.6 4.9-2.6s4.9 1.1 4.9 2.6c0 1-1 1.6-2.1 1.9 .9 .3 1.5 .7 1.5 1.1 0 .6-1.3 1-2.9 1H6.6c-1.6 0-2.9-.4-2.9-1 0-.4 .6-.8 1.5-1.1C4.1 6.8 3.1 6.2 3.1 5.2Z"/>
  <path d="M6.5 9.6h3l.5 4.2H6Z"/>
</svg>`;

/**
 * A skull, for a competitor who is out. Same reasoning as the cloud: at this
 * size a literal skull-and-crossbones turns to mud, so the crossbones are
 * dropped and the skull is drawn bold enough to read at 13 pixels.
 */
const SKULL_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M8 1.6c3.1 0 5.4 2.1 5.4 5 0 1.8-.9 3-1.9 3.7v1.7c0 .8-.7 1.4-1.5 1.4H6c-.8 0-1.5-.6-1.5-1.4v-1.7C3.5 9.6 2.6 8.4 2.6 6.6c0-2.9 2.3-5 5.4-5Zm-2.2 4a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm4.4 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8ZM8 9.3l-.8 1.5h1.6Z"/>
</svg>`;

/**
 * A crown, for the moment the lead changed hands — the third and last drawn
 * symbol on the transport. Same reasoning as the cloud and the skull: ♔ typed
 * as a character would render in whatever weight and shape the platform felt
 * like and would not hold at 13px against a busy map, so the same three-point
 * crown the scorebug's chip wears is drawn instead. Two paths, matching the
 * cloud: the band reads as a separate mass at this size, where a single
 * outline turns to a blob.
 */
const CROWN_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M2.2 4.9 5.4 8.5 8 3.1 10.6 8.5 13.8 4.9 12.9 11.3H3.1Z"/>
  <path d="M3.1 12.2h9.8v1.9H3.1Z"/>
</svg>`;

/**
 * Sentinels for reading a lang template's slots back out of a string it
 * produced. Control characters, one per slot: they cannot occur in a nation
 * name, a formatted percentage or any locale's connective text, so a slot
 * boundary is never ambiguous with real content.
 */
const SLOT_ACTOR = "\u0000";
const SLOT_TARGET = "\u0001";
const SLOT_TO_SHARE = "\u0002";
const SLOT_FROM_SHARE = "\u0003";

/**
 * Recover a lang template's placeholder values from a string that template
 * rendered — the generalisation of the sentinel trick `eliminationActorOf`
 * (and `WarRoomToasts.statedReasonOf`) already use, extended to a template
 * with more than one slot: render the SAME template around distinct
 * sentinels, then walk the literal text the locale wrote between them and
 * take whatever sits in the gaps.
 *
 * Slots are walked in the order THIS LOCALE put them in, not the order the
 * caller listed them — a translation is free to say "Y loses the lead to X"
 * — and the returned array is indexed by the caller's order regardless. A
 * slot the translation drops entirely comes back as "".
 *
 * `null` means the label is not something this template produced (a stale
 * label from a previous language, the raw dotted key when no `<lang-selector>`
 * has mounted and no defaultText was passed, the `debug` pseudo-language),
 * and every caller degrades to a fallback colour rather than to a wrong name.
 */
function templateSlots(
  template: string,
  rendered: string,
  sentinels: readonly string[],
): string[] | null {
  const placed = sentinels
    .map((sentinel, slot) => ({
      sentinel,
      slot,
      at: template.indexOf(sentinel),
    }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (placed.length === 0) return null;
  const values = sentinels.map(() => "");
  let templateAt = 0;
  let renderedAt = 0;
  for (let index = 0; index < placed.length; index += 1) {
    const before = template.slice(templateAt, placed[index].at);
    if (!rendered.startsWith(before, renderedAt)) return null;
    renderedAt += before.length;
    templateAt = placed[index].at + placed[index].sentinel.length;
    const nextAt =
      index + 1 < placed.length ? placed[index + 1].at : template.length;
    const after = template.slice(templateAt, nextAt);
    if (after === "") {
      // Nothing separates this slot from what follows. At the end of the
      // template that is fine — the slot is the rest of the string. Between
      // two slots it is unsplittable, and guessing would invent a name.
      if (index + 1 < placed.length) return null;
      values[placed[index].slot] = rendered.slice(renderedAt).trim();
      return values;
    }
    const end = rendered.indexOf(after, renderedAt);
    if (end < 0) return null;
    values[placed[index].slot] = rendered.slice(renderedAt, end).trim();
    renderedAt = end;
  }
  return values;
}

/**
 * The nation that TOOK the lead, recovered from a lead-change marker label.
 * The label is `LEAD_CHANGE_HEADLINE_KEY` rendered by the overlay
 * (AiLeagueReplayOverlay's `aiLeagueLeadChangeHeadline`), and the template it
 * used is stated once in LeadChangeTracker.ts precisely so this side can
 * render the identical thing around sentinels and read `{actor}` back out.
 * `""` (unparseable label, a translation this build does not know) means the
 * caller keeps the amber fallback — a crown must never go invisible.
 */
function leadChangeTakerOf(label: string): string {
  if (label === "") return "";
  const template = translateText(
    LEAD_CHANGE_HEADLINE_KEY,
    {
      actor: SLOT_ACTOR,
      target: SLOT_TARGET,
      toShare: SLOT_TO_SHARE,
      fromShare: SLOT_FROM_SHARE,
    },
    leadChangeHeadlineDefault(
      SLOT_ACTOR,
      SLOT_TARGET,
      SLOT_TO_SHARE,
      SLOT_FROM_SHARE,
    ),
  );
  const slots = templateSlots(template, label, [
    SLOT_ACTOR,
    SLOT_TARGET,
    SLOT_TO_SHARE,
    SLOT_FROM_SHARE,
  ]);
  return slots === null ? "" : slots[0];
}

function markKind(raw: string): MarkKind {
  if (raw === "nuke") return "nuke";
  if (raw === "elimination") return "elimination";
  if (raw === "lead_change") return "lead_change";
  if (raw === "finish") return "finish";
  if (raw === "upcoming") return "upcoming";
  return "event";
}

/** Stable thinning of the upcoming ladder, so it does not jitter per harvest. */
function hash(v: number): number {
  const x = Math.sin(v * 9973.13) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Match clock, matching the sidebar's contract: ten engine ticks a second.
 */
function formatClock(
  turn: number,
  totalTurns: number,
  spawnPhaseTurns = 0,
): string {
  if (totalTurns <= 0) return "--:--";
  // The SPAWN PHASE IS NOT MATCH TIME. GameRightSidebar's clock subtracts it
  // (see its tick()), this one did not, so the two clocks on screen disagreed
  // by the whole spawn phase — about thirty seconds — while a comment here
  // claimed they matched. Two clocks in one frame that disagree is worse than
  // one clock that is slightly wrong.
  const seconds = Math.max(0, Math.round((turn - spawnPhaseTurns) / 10));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

let stylesMounted = false;

function mountScrubberStyles() {
  if (stylesMounted) return;
  stylesMounted = true;
  const style = document.createElement("style");
  style.id = "pw-scrubber-styles";
  style.textContent = `
    .pw-scrubber {
      position: fixed;
      /* FULL FRAME WIDTH, not the map band. The transport was docked to
       * --pw-band-left/right so it lined up with the board's letterbox, but
       * on a wide map that band is most of the screen and the timeline came
       * out short of both edges with the race strip clipped inside it. The
       * transport is CHROME, not board furniture: it owns the bottom edge of
       * the FRAME, so both the seek track and the territory-race graph get
       * every pixel of width the viewer has. */
      left: 16px;
      right: 16px;
      bottom: 14px;
      z-index: 50006;
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-areas: "readout track" "readout status";
      align-items: center;
      column-gap: 12px;
      font-family: var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      /* The track itself takes pointer events; the container must not eat
       * clicks meant for the board. */
      pointer-events: none;
    }

    .pw-scrub-readout {
      grid-area: readout;
      /* Baseline-locked to the TRANSPORT ROW, which now sits at the TOP of
       * the band (the race strip grows the band downward-in-DOM, so grid
       * centering would drift the clock toward the strip): top-aligned, then
       * padded to the 26px row's vertical center ((26 - 13px font) / 2). */
      align-self: start;
      padding-top: 6.5px;
      font: 600 13px/1 var(--pw-num, ui-monospace, monospace);
      color: var(--pw-ink, #f2ece2);
      font-variant-numeric: tabular-nums;
      text-shadow: 0 1px 3px rgba(10, 7, 5, 0.9);
    }

    /* The track band, PaintBot's geometry (league_replayer.html:211-228):
     * one band with the TRANSPORT ROW AT THE TOP (26px) and the race strip
     * in the LOWER portion (34px) once the territory series exists
     * (data-graph="1" on the root). Everything in the transport row is
     * TOP-anchored so the row sits identically at either height — the strip
     * is added below it, never squeezed into it. The WHOLE band, strip
     * included, is the seek hit area (fractionFor reads this rect). */
    .pw-scrub-track {
      grid-area: track;
      position: relative;
      height: 26px;
      pointer-events: auto;
      cursor: pointer;
      touch-action: none;
    }
    .pw-scrubber[data-graph="1"] .pw-scrub-track { height: 60px; }
    .pw-scrub-track:focus-visible { outline: 1px solid var(--pw-accent, #ffc24a); outline-offset: 3px; }

    /* The race strip: the band's lower portion, on its OWN GROUND. The board
     * is full-bleed, and the owner's screenshot showed the step-lines drawn
     * transparent over the busy map — illegible. PaintBot never hits this
     * because its page reserves the momentum strip; ours brings the reserved
     * ground with it: opaque warm glass + a top hairline (the toasts' exact
     * surface recipe). pointer-events:none — a click here is a seek; only
     * the SPOILERS button inside opts back in. */
    .pw-scrub-strip {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 34px;
      box-sizing: border-box;
      display: none;
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      border-top: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      pointer-events: none;
    }
    .pw-scrubber[data-graph="1"] .pw-scrub-strip { display: block; }

    /* The graph SVG fills the strip, stretched (preserveAspectRatio:none) so
     * chart x IS transport x — 1:1 with the playhead above it. */
    .pw-scrub-graph {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    /* The strip's own name moves to the tail to make room for the control at
     * the head. It is a quiet eyebrow with no interaction, so it can sit over
     * the busy end where SPOILERS could not. */
    .pw-scrub-graph-label {
      position: absolute;
      right: 8px; top: 3px;
      font: 600 8px/1 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      letter-spacing: 0.16em;
      color: var(--pw-ink-faint, #6f675d);
      pointer-events: none;
    }

    /* A hairline, not a trough. The board is the picture; the transport is a
     * thin instrument laid over its bottom edge. TOP-anchored (12px into the
     * 26px row = the row's center, same optical position the bottom-anchored
     * version had) so growing the band downward with the strip never moves
     * the rail. */
    .pw-scrub-rail {
      position: absolute;
      left: 0; right: 0; top: 12px;
      height: 2px;
      background: rgba(242, 236, 226, 0.16);
    }
    .pw-scrub-fill {
      position: absolute;
      left: 0; top: 12px;
      height: 2px;
      background: var(--pw-accent, #ffc24a);
      opacity: 0.85;
    }
    .pw-scrub-head {
      position: absolute;
      top: 6.5px;
      width: 2px;
      height: 13px;
      margin-left: -1px;
      background: var(--pw-ink, #f2ece2);
      box-shadow: 0 0 0 1px rgba(10, 7, 5, 0.7);
    }
    .pw-scrubber[data-state="scrubbing"] .pw-scrub-head { height: 19px; }
    /* With the strip up, the playhead runs from the rail DOWN THROUGH the
     * race strip to the band's bottom edge and visually pierces the curves —
     * one instrument, not a chart with its own cursor (PaintBot's knob
     * crosses its chart the same way). (Placed after the scrubbing rule so
     * the span wins at equal specificity in that state too.) */
    .pw-scrubber[data-graph="1"] .pw-scrub-head,
    .pw-scrubber[data-graph="1"][data-state="scrubbing"] .pw-scrub-head {
      top: 6.5px;
      bottom: 0;
      height: auto;
    }
    .pw-scrub-track:hover .pw-scrub-rail { background: rgba(242, 236, 226, 0.26); }

    /* THE MARKS LAYER MUST NOT BE A SHEET. It is inset:0 over the WHOLE band,
     * and it painted after the race strip, so with pointer-events inherited as
     * auto it swallowed every click aimed at anything inside the strip —
     * measured: elementFromPoint at the SPOILERS button's own centre returned
     * .pw-scrub-marks, not the button. That is the "spoilers does nothing"
     * report, and it survived an earlier fix that addressed the wrong
     * mechanism (stopping click propagation, when seeking runs on the pointer
     * stream). The layer is now transparent to input and each MARK opts back
     * in, which is what was always meant: a 13px symbol is a target, a
     * 1837x60 rectangle is not. */
    .pw-scrub-marks { position: absolute; inset: 0; pointer-events: none; }

    /* LULL SHADING: PaintBot's .lull-span (league_replayer.html:198-199 —
     * a dark dim laid over its track band, pointer-events none) translated
     * to our tokens. Our rail is a 2px hairline, so a pure dim would be
     * invisible at this scale; the same affordance becomes a low ink-faint
     * band straddling the rail and hanging just below it — quiet chrome in
     * the existing ink, NEVER a new hue, muted enough that the amber fill
     * still reads through it. pointer-events none: a lull stretch is still
     * ordinary seekable track. */
    .pw-scrub-lulls { position: absolute; inset: 0; pointer-events: none; }
    .pw-scrub-lull {
      position: absolute;
      top: 11px;
      height: 5px;
      background: var(--pw-ink-faint, #6f675d);
      opacity: 0.28;
      pointer-events: none;
    }

    .pw-scrub-mark {
      position: absolute;
      top: 13px;
      transform: translate(-50%, -50%);
      padding: 0;
      border: 0;
      background: none;
      line-height: 0;
      cursor: pointer;
      pointer-events: auto;
      color: var(--pw-ink-faint, #6f675d);
    }
    .pw-scrub-mark svg { width: 13px; height: 13px; fill: currentColor; display: block;
      filter: drop-shadow(0 1px 2px rgba(10, 7, 5, 0.85)); }
    .pw-scrub-mark:hover { color: var(--pw-ink, #f2ece2); }

    /* Severity means rarity: only the two genuinely violent kinds get the
     * hazard hue. Coral is now the FALLBACK for eliminations — see the
     * seat-color override below — and it never applies to the crown, which
     * has its own amber/seat rule further down. */
    .pw-scrub-mark[data-kind="nuke"],
    .pw-scrub-mark[data-kind="elimination"] { color: var(--pw-hazard, #ff6b4a); }
    .pw-scrub-mark[data-kind="nuke"]:hover,
    .pw-scrub-mark[data-kind="elimination"]:hover { color: #ff9678; }

    /* OWNER OVERRIDE (r46): each skull is painted in the DYING SEAT'S
     * territory color ("all of the skulls ... should be of the color that
     * dies"). This supersedes the coral reservation FOR ELIMINATIONS ONLY:
     * nukes stay coral, and an unresolvable name keeps the coral rules above
     * (no data-seat attribute — never invisible). Seat colors are exempt
     * from the amber-only chrome rule, same as the graph lines and lanes.
     * Do not "fix" these back to coral. Placed AFTER the coral hover rule:
     * equal specificity, so order decides, and the seat color must hold on
     * hover too (hover feedback comes from the brightness bump instead). */
    .pw-scrub-mark[data-kind="elimination"][data-seat="1"],
    .pw-scrub-mark[data-kind="elimination"][data-seat="1"]:hover {
      color: var(--pw-seat-color, var(--pw-hazard, #ff6b4a));
    }
    /* A LEAD CHANGE IS A STANDINGS BEAT, NOT A VIOLENT ONE — amber, the one
     * chrome accent on this stage, never coral. Coral is reserved for
     * warheads and eliminations, which is the same rule the War Room row
     * (AiLeagueReplayOverlay's lead_change glyph) and the toast stripe
     * (WarRoomToasts.severityOf: "amber, never coral") already state. Amber
     * is only the FALLBACK here — the seat override below is what normally
     * paints a crown — but a crown whose nation cannot be resolved has to
     * stay visible and has to stay on-lock. */
    .pw-scrub-mark[data-kind="lead_change"] { color: var(--pw-accent, #ffc24a); }
    .pw-scrub-mark[data-kind="lead_change"]:hover { color: #ffd68a; }

    /* Same owner rule as the skull, pointed the other way: the crown wears
     * the territory color of the nation that TOOK the lead, so a glance at
     * the track reads as "this colour is winning from here". Placed after the
     * amber hover rule for the same reason the skull's is placed after the
     * coral one — equal specificity, order decides, and the seat color must
     * hold on hover (the brightness bump carries the feedback instead). */
    .pw-scrub-mark[data-kind="lead_change"][data-seat="1"],
    .pw-scrub-mark[data-kind="lead_change"][data-seat="1"]:hover {
      color: var(--pw-seat-color, var(--pw-accent, #ffc24a));
    }

    /* Light seat colors on a light map edge: a tight dark halo (a 0-offset
     * drop-shadow stacked under the ambient one reads as a thin outline at
     * 13px) keeps every seat legible on the track. */
    .pw-scrub-mark[data-kind="elimination"][data-seat="1"] svg,
    .pw-scrub-mark[data-kind="lead_change"][data-seat="1"] svg {
      filter: drop-shadow(0 0 1px rgba(10, 7, 5, 0.95))
        drop-shadow(0 1px 2px rgba(10, 7, 5, 0.85));
    }
    .pw-scrub-mark[data-kind="elimination"][data-seat="1"]:hover svg,
    .pw-scrub-mark[data-kind="lead_change"][data-seat="1"]:hover svg {
      filter: brightness(1.3) drop-shadow(0 0 1px rgba(10, 7, 5, 0.95))
        drop-shadow(0 1px 2px rgba(10, 7, 5, 0.85));
    }

    /* Anonymous ticks — a marker beyond the playhead must not say what it is. */
    .pw-scrub-mark[data-kind="upcoming"],
    .pw-scrub-mark[data-kind="finish"] {
      width: 1px; height: 7px;
      background: rgba(242, 236, 226, 0.28);
    }
    .pw-scrub-mark[data-kind="finish"] {
      width: 2px; height: 11px;
      background: var(--pw-accent, #ffc24a);
    }

    .pw-scrub-status {
      grid-area: status;
      min-height: 12px;
      font: 600 9px/1.2 var(--pw-display, system-ui, sans-serif);
      letter-spacing: 0.14em;
      color: var(--pw-ink-faint, #6f675d);
      text-shadow: 0 1px 3px rgba(10, 7, 5, 0.9);
    }
    .pw-scrubber[data-state="rewinding"] .pw-scrub-status { color: var(--pw-accent, #ffc24a); }
    .pw-scrubber[data-state="rewinding"] .pw-scrub-track { pointer-events: none; opacity: 0.5; }

    /* SPOILERS toggle: PaintBot's transport affordance in our grammar —
     * small-caps display label, ink-dim at rest, amber with a 2px amber
     * underline when on. Amber because this is chrome state, not an event:
     * coral stays reserved for nukes. Lives INSIDE the race strip (right
     * end, vertically centered), so it sits on the strip's own opaque ground
     * and disappears with it — keyboard "o" and ?spoilers= remain the
     * interface when the strip is absent, exactly as at <=740px before. */
    /* AT THE HEAD OF THE BAR, NOT THE TAIL.
     *
     * It used to sit at the right end of the race strip, which is exactly
     * where a match's interesting minutes live: eliminations, nuclear beats
     * and the finish all cluster in the final stretch of the track, and the
     * one control a viewer reaches for was parked on top of them. The left
     * end is the opening — the quietest ground on the whole transport, and
     * the part the auto-pacer skips — so a control there covers nothing worth
     * seeing. */
    .pw-scrub-spoilers {
      position: absolute;
      left: 8px;
      top: 50%;
      transform: translateY(-50%);
      pointer-events: auto;
      /* Belt to the marks layer's braces: even if something later paints over
       * the strip again, the one control living inside it stays on top. */
      z-index: 2;
      margin: 0;
      padding: 3px 1px;
      border: 0;
      background: none;
      cursor: pointer;
      font: 600 9px/1 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      letter-spacing: 0.15em;
      color: var(--pw-ink-dim, #a79e92);
      border-bottom: 2px solid transparent;
    }
    .pw-scrub-spoilers:hover { color: var(--pw-ink, #f2ece2); }
    .pw-scrub-spoilers:focus-visible { outline: 1px solid var(--pw-accent, #ffc24a); outline-offset: 2px; }
    .pw-scrub-spoilers[aria-pressed="true"] {
      color: var(--pw-accent, #ffc24a);
      border-bottom-color: var(--pw-accent, #ffc24a);
    }

    /* ---- DRAG PREVIEW: the frame-flip surface over the board while a drag
     * is live. Fixed-position, geometry copied from the board canvas box at
     * drag start (showDragPreview); pointer-events none so it can never eat
     * the drag it exists to serve. Stacked OVER the board and under both the
     * transport (50006) and the rewind curtain (50045) -- the instrument
     * doing the driving stays on top of the picture it drives. The amber top
     * border is the one accent: "this strip of time is held", same amber the
     * fill/playhead vocabulary already owns. */
    .pw-scrub-preview {
      position: fixed;
      z-index: 50004;
      display: none;
      pointer-events: none;
      box-sizing: border-box;
      border-top: 2px solid var(--pw-accent, #ffc24a);
      /* Also the NO-FRAME wash: with the canvas hidden (data-empty below)
       * this dim ground is what "no frame yet" sits on -- a held, dimmed
       * board, never a stale image pretending to be the past. */
      background: rgba(20, 17, 15, 0.55);
    }
    .pw-scrub-preview[data-open="1"] { display: block; }

    /* The cached frame, stretched to the board box. It is a ~1/3-res webp
     * still -- soft on purpose; it only has to read as "the match at that
     * moment", the release does the real seeking. */
    .pw-scrub-preview-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .pw-scrub-preview[data-empty="1"] .pw-scrub-preview-canvas { display: none; }

    /* Corner tag: house glass chip, amber mono clock -- "PREVIEW -- mm:ss",
     * or the no-frame line. Top-left, clear of the transport at the bottom
     * and the right-side HUD rails. */
    .pw-scrub-preview-tag {
      position: absolute;
      left: 10px;
      top: 10px;
      padding: 5px 9px;
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      font: 600 10px/1 var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      letter-spacing: 0.08em;
      font-variant-numeric: tabular-nums;
      color: var(--pw-accent, #ffc24a);
    }

    /* The result owns the frame. */
    body.pw-endcard-open .pw-scrubber { display: none; }

    /* Embed floor: keep the strip (backdrop and all) but shrink it to a 20px
     * band, and drop the SPOILERS button and label — keyboard "o" and
     * ?spoilers= still work; the chrome just stops spending width on them.
     * Band = 26px transport row + 20px strip = 46px. */
    @media (max-width: 740px) {
      .pw-scrubber { bottom: 8px; column-gap: 8px; }
      .pw-scrub-readout { font-size: 11px; padding-top: 7.5px; }
      .pw-scrub-status { display: none; }
      .pw-scrub-mark svg { width: 11px; height: 11px; }
      .pw-scrubber[data-graph="1"] .pw-scrub-track { height: 46px; }
      .pw-scrub-strip { height: 20px; }
      .pw-scrub-graph-label { display: none; }
      .pw-scrub-spoilers { display: none; }
    }

    /* At board-is-the-product widths the strip goes entirely; the transport
     * row returns to its 26px self (same-specificity overrides win by media
     * query order, no !important). */
    @media (max-width: 560px) {
      .pw-scrubber[data-graph="1"] .pw-scrub-track { height: 26px; }
      .pw-scrubber[data-graph="1"] .pw-scrub-strip { display: none; }
      .pw-scrubber[data-graph="1"] .pw-scrub-head,
      .pw-scrubber[data-graph="1"][data-state="scrubbing"] .pw-scrub-head {
        bottom: auto;
        height: 13px;
      }
      .pw-scrubber[data-graph="1"][data-state="scrubbing"] .pw-scrub-head { height: 19px; }
    }
  `;
  document.head.appendChild(style);
}

export function mountBroadcastScrubber(game: GameView): Layer[] {
  if (!isAiLeagueReplayRoute()) return [];
  return [new BroadcastScrubber(game)];
}
