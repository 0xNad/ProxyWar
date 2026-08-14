import { GameView } from "../../../core/game/GameView";
import {
  aiLeagueSpectatorDisplayName,
  isAiLeagueReplayRoute,
} from "../../AiLeagueReplayMode";
import { translateText } from "../../Utils";
import {
  clearBroadcastSpotlight,
  setBroadcastSpotlight,
} from "./BroadcastSpotlight";
import { Layer } from "./Layer";

/**
 * ============================================================================
 * WAR ROOM TOASTS — beats arrive, are read, and leave.
 * ============================================================================
 *
 * WHY THE PANEL HAD TO GO
 * -----------------------
 * The war room was a 300px card pinned down the right edge for the whole
 * match. Three things were wrong with it, all measured on the real board:
 *
 *  - It covered the right 23% of the BOARD. Strikes landing under it were
 *    invisible, which is why the nuke cinema had to dim it during a beat.
 *  - Its newest entry sat at y=16 directly UNDER the transport cluster, so the
 *    clock was permanently parked on top of the most recent beat.
 *  - A standing card of 50+ past events is a log, not a broadcast. Nothing in
 *    it changed often enough to earn a quarter of the frame.
 *
 * A beat is news. It should arrive, be readable for a few seconds, and then
 * get out of the way — newest at the bottom, stack growing upward, each one
 * ageing out on its own. The board gets its quarter of the frame back and the
 * feed becomes something a viewer actually notices, because motion in the
 * corner means something just happened.
 *
 * HOW BEATS ARE READ
 * ------------------
 * From the incumbent feed's own DOM, not from a second derivation. The panel
 * is hidden, not removed, precisely so it keeps producing rows: it remains the
 * single source of truth for what a beat IS, and this layer is a presentation
 * of it. Rows are keyed by kind + headline + turn, so a re-render of the panel
 * cannot replay a beat that has already been shown.
 */

/** How long a beat stays legible before it begins to fade. */
const TOAST_HOLD_MS = 5000;
/** Fade duration once the hold expires. */
const TOAST_FADE_MS = 260;
/** Most toasts on screen at once; older ones are retired early to make room. */
const MAX_TOASTS = 4;
/**
 * Poll interval for new beats. The feed is DOM, not an event stream, and a
 * beat is not so urgent that a third of a second matters.
 */
const POLL_MS = 320;
/**
 * Above this many game ticks per wall-clock second the replay is SEEKING, not
 * playing — the same threshold and the same reasoning as the nuke cinema's.
 * Beats crossed at seek speed were never watched, so announcing them is noise:
 * a jump across six thousand turns would otherwise fire a toast per beat for
 * the whole distance.
 */
const CATCHUP_TICKS_PER_SECOND = 150;

interface LiveToast {
  el: HTMLElement;
  bornMs: number;
}

export class WarRoomToasts implements Layer {
  private stack: HTMLElement | null = null;
  private seen = new Set<string>();
  private live: LiveToast[] = [];
  private lastPollMs = 0;
  private primed = false;
  private lastTick = -1;
  private lastTickWallMs = 0;
  private rateSampledAtMs = 0;
  private tickRate = 0;
  /**
   * Every pending fade timer armed by `dismiss()`. Held only so `dispose()`
   * can cancel them: each one closes over a toast element and fires up to
   * TOAST_FADE_MS after the match it belongs to has been left.
   */
  private readonly fadeTimers = new Set<number>();

  constructor(private game: GameView) {}

  init() {
    mountToastStyles();
    // BACKSTOP, NOT THE TEARDOWN. `dispose()` below is what takes this stack
    // off the document now, and it runs on every way out of a game. This line
    // stays because it covers the one case dispose() cannot: two
    // `openAiLeagueReplay` attempts racing over one document, where the loser's
    // renderer is never stopped and so never disposes (Main.ts documents that
    // race on its module-level `rewindInFlight` guard). Removing a node that is
    // already gone is free, so the belt and the braces both stay on.
    document.querySelector(".pw-toasts")?.remove();
    const stack = document.createElement("div");
    stack.className = "pw-toasts";
    document.body.appendChild(stack);
    this.stack = stack;
  }

  /**
   * TEARDOWN — see `Layer.dispose()`. Three things here outlive their GameView
   * if nobody takes them back: the `.pw-toasts` node on document.body, up to
   * MAX_TOASTS pending fade timers, and a match's worth of beat keys in
   * `seen`. Leaving a replay for a live single-player game used to strand all
   * three, because the only teardown was "remove my node at the top of my next
   * init()" — which only fires if another replay starts.
   *
   * Removing the stack takes every live toast with it (they are its children),
   * but the timers are cancelled anyway rather than left to call `remove()` on
   * detached nodes: a closure holding the previous match's DOM for another
   * 900ms is exactly the kind of thing that survives a "leave" in an SPA.
   *
   * The <style> in document.head deliberately STAYS. It is inert with no
   * `.pw-toast` nodes left to match, and `stylesMounted` is module-level:
   * pulling the sheet without clearing that flag would leave the next replay's
   * toasts unstyled, and clearing it would re-insert an identical sheet on
   * every rewind for nothing.
   *
   * Idempotent: safe before init() (stack is null, sets are empty) and safe
   * twice (`remove()` on a detached node is a no-op).
   */
  dispose() {
    this.stack?.remove();
    this.stack = null;
    for (const timer of this.fadeTimers) window.clearTimeout(timer);
    this.fadeTimers.clear();
    this.live = [];
    this.seen.clear();
    this.primed = false;
    this.lastTick = -1;
    this.lastTickWallMs = 0;
    this.rateSampledAtMs = 0;
    this.tickRate = 0;
  }

  tick() {
    // No stack means not mounted yet, or already disposed. A torn-down layer
    // must not keep querying the document for a feed that belongs to a game
    // that no longer exists.
    if (this.stack === null) return;
    const now = performance.now();
    // Pause-gap absorption, same contract as NukeCinema's: ticking stops while
    // the replay is paused but wall clock does not, so without this a viewer
    // who pauses with toasts up and returns after the hold has elapsed watches
    // them all vanish at once instead of serving out their remaining hold.
    if (this.lastTickWallMs > 0) {
      const gap = now - this.lastTickWallMs;
      if (gap > 700) {
        const shift = gap - 700;
        for (const toast of this.live) toast.bornMs += shift;
      }
    }
    this.lastTickWallMs = now;
    this.measureTickRate(now);
    if (now - this.lastPollMs >= POLL_MS) {
      this.lastPollMs = now;
      this.poll(now);
    }
    this.retire(now);
  }

  /**
   * Display name -> seat, rebuilt when the roster changes size. Names are
   * stable for a match, so this is a cache, not a per-toast scan of sixteen
   * player views.
   */
  private seatIndex: Array<{ name: string; smallId: number; color: string }> =
    [];
  private seatIndexSize = -1;

  private refreshSeatIndex() {
    const views = this.game.playerViews();
    if (views.length === this.seatIndexSize) return;
    this.seatIndexSize = views.length;
    this.seatIndex = views
      .map((view) => ({
        name: aiLeagueSpectatorDisplayName(view.displayName()),
        smallId: view.smallID(),
        color: view.territoryColor().toHex(),
      }))
      .filter((entry) => entry.name.length > 0)
      // LONGEST FIRST. Agent names overlap ("relh" is inside "relhbot"), and a
      // shortest-first scan would paint the prefix and orphan the rest of the
      // name in plain ink.
      .sort((a, b) => b.name.length - a.name.length);
  }

  /**
   * Writes `headline` into `into`, painting every nation name in that nation's
   * seat colour and making it its own hover target. Returns the seats found so
   * the caller can wire the whole-toast hover.
   *
   * textContent, never innerHTML: these strings are agent-authored and arrive
   * from the feed's DOM, so they are never treated as markup.
   */
  private paintNames(
    into: HTMLElement,
    headline: string,
  ): Array<{ smallId: number }> {
    this.refreshSeatIndex();
    const found: Array<{ smallId: number }> = [];
    let rest = headline;
    let guard = 0;
    while (rest.length > 0 && guard++ < 64) {
      let hitAt = -1;
      let hit: (typeof this.seatIndex)[number] | null = null;
      for (const entry of this.seatIndex) {
        const at = rest.indexOf(entry.name);
        if (at >= 0 && (hitAt < 0 || at < hitAt)) {
          hitAt = at;
          hit = entry;
        }
      }
      if (hit === null || hitAt < 0) break;
      if (hitAt > 0) {
        into.appendChild(document.createTextNode(rest.slice(0, hitAt)));
      }
      const span = document.createElement("span");
      span.className = "pw-toast-name";
      span.textContent = hit.name;
      span.style.color = hit.color;
      const smallId = hit.smallId;
      span.addEventListener("pointerenter", (event) => {
        // Stop the toast-level handler from immediately widening it back out
        // to every nation in the beat.
        event.stopPropagation();
        setBroadcastSpotlight([smallId]);
      });
      into.appendChild(span);
      found.push({ smallId });
      rest = rest.slice(hitAt + hit.name.length);
    }
    if (rest.length > 0) into.appendChild(document.createTextNode(rest));
    return found;
  }

  /** Ticks per wall-clock second; see CATCHUP_TICKS_PER_SECOND. */
  private measureTickRate(now: number) {
    const tick = this.game.ticks();
    const advanced = this.lastTick < 0 ? 0 : Math.max(0, tick - this.lastTick);
    this.lastTick = tick;
    const dt = now - this.rateSampledAtMs;
    this.rateSampledAtMs = now;
    if (dt <= 0 || dt > 700) return;
    this.tickRate = this.tickRate * 0.75 + ((advanced * 1000) / dt) * 0.25;
  }

  private catchingUp(): boolean {
    return this.tickRate > CATCHUP_TICKS_PER_SECOND;
  }

  private poll(now: number) {
    const rows = document.querySelectorAll<HTMLElement>(
      ".broadcast-war-room-item",
    );
    if (rows.length === 0) {
      // No rows can mean two different things. If the war-room CONTAINER is
      // mounted, the feed is live and simply has no beats yet — prime now, so
      // the match's first beat toasts instead of being swallowed by a priming
      // pass that only ran once rows existed. If the container itself is not
      // there yet, keep waiting: priming against a feed that has not rendered
      // would announce its entire backlog as news when it does.
      if (!this.primed && document.querySelector(".broadcast-war-room")) {
        this.primed = true;
      }
      return;
    }

    // FIRST PASS PRIMES ONLY — and so does every pass taken while seeking.
    // On load, and throughout a catch-up, rows arrive faster than anyone could
    // read them and describe beats the viewer never watched. Swallowing them
    // into `seen` keeps the feed silent through the jump and correct after it:
    // the first beat that plays at real speed is the first one announced.
    if (!this.primed || this.catchingUp()) {
      this.primed = true;
      for (const row of rows) this.seen.add(rowKey(row));
      return;
    }

    // The war-room list is OLDEST-first (patchDomWindowForward appends new
    // rows at the tail), so DOM order is already the display order: iterate as
    // is and the newest beat ends up appended last — nearest the viewer at the
    // bottom of the stack. The first version believed the opposite and
    // reversed the batch, which put the newest beat farthest away AND made the
    // over-cap eviction (shift(), i.e. live[0]) throw away the NEWEST beat
    // whenever two landed in one poll.
    for (const row of rows) {
      const key = rowKey(row);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      // Tier 3 is the routine background the curation itself collapses into
      // "+N more skirmishes" summary rows — and those rows are REWRITTEN as a
      // run grows (new count, new turn), which re-keys them and would toast
      // every increment of a run the grouping exists to silence. Routine is
      // not news; it stays in the (parked) panel and off the toast stack.
      if (row.dataset.tier === "3") continue;
      this.show(row, now);
    }
  }

  private show(row: HTMLElement, now: number) {
    const stack = this.stack;
    if (stack === null) return;

    const kind = text(row, ".broadcast-war-room-kind");
    const headline = text(row, ".broadcast-war-room-headline");
    const turn = text(row, ".broadcast-war-room-turn");
    if (headline === "") return;

    const severity = severityOf(row.dataset.kind ?? "");
    const el = document.createElement("article");
    el.className = "pw-toast";
    el.dataset.severity = severity;

    const meta = document.createElement("div");
    meta.className = "pw-toast-meta";
    const kindEl = document.createElement("span");
    kindEl.className = "pw-toast-kind";
    kindEl.textContent = kind.toUpperCase();
    const turnEl = document.createElement("span");
    turnEl.className = "pw-toast-turn";
    turnEl.textContent = turn.toUpperCase();
    meta.append(kindEl, turnEl);

    const head = document.createElement("p");
    head.className = "pw-toast-headline";
    // NAMES IN THEIR OWN SEAT COLOUR, and hoverable. Sixteen agents on one
    // board is exactly the case where "softmaxwell struck SIAN VOIDCROWN" is
    // unreadable as prose: the viewer has to hold sixteen name-to-colour
    // bindings in their head to know who the beat is about. Painting the name
    // in the nation's own colour makes the sentence point at the map, and
    // hovering it lights that nation's border (see BroadcastSpotlight).
    const named = this.paintNames(head, headline);

    el.append(meta, head);

    // Hovering the toast BODY lights every nation the beat names — the two
    // sides of a strike read as a pair. Hovering one NAME narrows it to that
    // nation (handled per-span in paintNames).
    if (named.length > 0) {
      el.addEventListener("pointerenter", () =>
        setBroadcastSpotlight(named.map((n) => n.smallId)),
      );
      el.addEventListener("pointerleave", () => clearBroadcastSpotlight());
    }

    // THE AGENT'S STATED WHY, on the beats that earn a second line. Grave and
    // sharp beats are the ones a viewer looks up for, and the reason is what
    // makes an AI tournament worth looking up for — quiet beats stay one-line
    // so the stack's rhythm survives. Quoted and dim because it is the agent's
    // own claim, never verified reasoning (the incumbent feed's rule). A row
    // with no harvestable reason renders exactly as it always has.
    if (severity !== "quiet") {
      const reason = statedReasonOf(row);
      if (reason !== "") {
        const reasonEl = document.createElement("p");
        reasonEl.className = "pw-toast-reason";
        reasonEl.textContent = `“${reason}”`;
        el.append(reasonEl);
      }
    }
    stack.appendChild(el);
    this.live.push({ el, bornMs: now });

    // Over the cap, the oldest goes now rather than waiting out its hold.
    while (this.live.length > MAX_TOASTS) {
      const oldest = this.live.shift();
      if (oldest !== undefined) this.dismiss(oldest.el);
    }
  }

  private retire(now: number) {
    if (this.live.length === 0) return;
    const keep: LiveToast[] = [];
    for (const toast of this.live) {
      if (now - toast.bornMs >= TOAST_HOLD_MS) {
        this.dismiss(toast.el);
      } else {
        keep.push(toast);
      }
    }
    this.live = keep;
  }

  private dismiss(el: HTMLElement) {
    if (el.dataset.leaving === "1") return;
    el.dataset.leaving = "1";
    // Tracked, not fire-and-forget: see `fadeTimers` and `dispose()`.
    const timer = window.setTimeout(() => {
      this.fadeTimers.delete(timer);
      el.remove();
    }, TOAST_FADE_MS);
    this.fadeTimers.add(timer);
  }
}

function text(row: HTMLElement, selector: string): string {
  return row.querySelector(selector)?.textContent?.trim() ?? "";
}

/**
 * Harvest the agent's stated reason from the incumbent row's own (hidden)
 * detail block — the same read-the-feed's-DOM contract as every other field
 * here, so this layer never grows a second derivation of what a beat said.
 * The node's text is the whole translated "Agent-stated claim: {reason}"
 * sentence, so the raw reason is recovered by rendering the same template
 * around a sentinel and stripping whatever the locale puts on either side —
 * a prefix-only strip would break in any translation that moves {reason}
 * off the end. Any mismatch degrades to the labelled sentence, never to a
 * missing beat.
 */
function statedReasonOf(row: HTMLElement): string {
  const labelled = text(row, ".broadcast-war-room-reason");
  if (labelled === "") return "";
  const template = translateText("broadcast.war_room_stated_reason", {
    reason: "\u0000",
  });
  const marker = template.indexOf("\u0000");
  if (marker < 0) return labelled;
  const prefix = template.slice(0, marker).trimStart();
  const suffix = template.slice(marker + 1).trimEnd();
  let reason = labelled;
  if (prefix !== "" && reason.startsWith(prefix)) {
    reason = reason.slice(prefix.length);
  }
  if (suffix !== "" && reason.endsWith(suffix)) {
    reason = reason.slice(0, reason.length - suffix.length);
  }
  return reason.trim();
}

function rowKey(row: HTMLElement): string {
  const eventId = row.dataset.warRoomEventId?.trim();
  if (eventId !== undefined && eventId !== "") return eventId;
  return [
    row.dataset.kind ?? "",
    text(row, ".broadcast-war-room-kind"),
    text(row, ".broadcast-war-room-turn"),
    text(row, ".broadcast-war-room-headline"),
  ].join("|");
}

/**
 * Coral is reserved for the two violent kinds; everything else is quiet. This
 * is the same severity rule the map and the scrubber follow, so a viewer only
 * ever has to learn it once.
 */
function severityOf(kind: string): string {
  if (kind === "nuke" || kind === "elimination") return "grave";
  if (
    kind === "first_strike" ||
    kind === "betrayal" ||
    kind === "deal_violated" ||
    kind === "lead_change"
  ) {
    return "sharp";
  }
  return "quiet";
}

let stylesMounted = false;

function mountToastStyles() {
  if (stylesMounted) return;
  stylesMounted = true;
  const style = document.createElement("style");
  style.id = "pw-toasts-styles";
  style.textContent = `
    .pw-toasts {
      position: fixed;
      /* HUG THE FRAME'S RIGHT EDGE. These were docked to --pw-band-right so
       * they lined up with the board's letterbox; on a wide map that put the
       * stack floating in from the edge with dead air outside it. A toast is
       * chrome — it belongs to the frame, like the transport below it. */
      right: 14px;
      /* Clear of the scrubber BAND, which owns the bottom edge, AND of the
       * board-identity plate that now sits directly above it. Measured
       * against the scrubber's own geometry (BroadcastScrubber styles): root
       * bottom 14px + 12px status row + 60px band (26px transport row + 34px
       * race strip) = 86px band top, + 8px of air = 94px for the plate, whose
       * 23px + 8px of air puts the lowest toast at 125px. */
      bottom: 125px;
      z-index: 50005;
      width: min(310px, 32vw);
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: var(--pw-s-md, 8px);
      pointer-events: none;
    }

    .pw-toast {
      /* The STACK stays click-through so the board keeps its corner; each card
       * opts back in, because hovering a card is now a control: it lights the
       * nations the beat names on the map. */
      pointer-events: auto;
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border-left-width: 2px;
      border-left-color: var(--pw-ink-faint, #6f675d);
      padding: var(--pw-s-md, 8px) var(--pw-s-lg, 12px);
      box-shadow: 0 12px 30px rgba(10, 7, 5, 0.5);
      animation: pw-toast-in 260ms cubic-bezier(0.2, 0.9, 0.3, 1) 1;
    }
    .pw-toast[data-leaving="1"] {
      animation: pw-toast-out ${TOAST_FADE_MS}ms ease-in forwards;
    }

    /* The one accent stripe on this stage. It is here because a toast has no
     * other way to carry severity at a glance and it is gone in seconds — not
     * a decorative rule on a standing card. */
    .pw-toast[data-severity="grave"] { border-left-color: var(--pw-hazard, #ff6b4a); }
    .pw-toast[data-severity="sharp"] { border-left-color: var(--pw-accent, #ffc24a); }

    @keyframes pw-toast-in {
      from { opacity: 0; transform: translate3d(14px, 0, 0); }
      to { opacity: 1; transform: none; }
    }
    @keyframes pw-toast-out {
      from { opacity: 1; }
      to { opacity: 0; transform: translate3d(0, -4px, 0); }
    }

    .pw-toast-meta {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--pw-s-md, 8px);
      margin-bottom: var(--pw-s-xs, 4px);
    }
    /* The kind chip is an EYEBROW — the shared recipe, not a local one. It was
     * 8.5px/0.16em here, 9px/0.14em on the scorebug and 9px/0.18em on the
     * drawer tab, three spellings of one idea. Severity still overrides the
     * colour below, because that is the part that carries meaning. */
    .pw-toast-kind {
      font: var(--pw-eyebrow, 700 9px / 1.2 var(--pw-display, system-ui, sans-serif));
      letter-spacing: var(--pw-eyebrow-track, 0.16em);
      color: var(--pw-eyebrow-ink, #6f675d);
    }
    .pw-toast[data-severity="grave"] .pw-toast-kind { color: var(--pw-hazard, #ff6b4a); }
    .pw-toast[data-severity="sharp"] .pw-toast-kind { color: var(--pw-accent, #ffc24a); }
    .pw-toast-turn {
      font: 500 var(--pw-type-micro, 9px) / 1.2 var(--pw-num, ui-monospace, monospace);
      color: var(--pw-ink-faint, #6f675d);
      font-variant-numeric: tabular-nums;
    }
    /* The one line on this card that is a SENTENCE, so it is the only thing
     * here on the body rung (was 12.5px). Everything else on a toast labels or
     * qualifies it, and sits a rung down. */
    .pw-toast-headline {
      margin: 0;
      font-size: var(--pw-type-body, 13px);
      line-height: 1.35;
      color: var(--pw-ink, #f2ece2);
    }
    /* A named nation reads in its OWN seat colour, at the headline's weight so
     * the sentence still scans as a sentence. The underline only appears on
     * hover to say the name is a control: colour cannot carry that message
     * here, because colour is already carrying identity. */
    .pw-toast-name {
      font-weight: 700;
      cursor: default;
      border-bottom: 1px solid transparent;
    }
    .pw-toast-name:hover {
      border-bottom-color: currentColor;
    }
    /* The stated reason: dim ink under the headline, clamped so a paragraph-
     * length claim (the artifact allows 1000 chars) can never turn a toast
     * into a card. Quoted because it is the agent's claim, not narration. */
    .pw-toast-reason {
      margin: var(--pw-s-xs, 4px) 0 0;
      font-size: var(--pw-type-label, 11px);
      line-height: 1.35;
      color: var(--pw-ink-dim, #a79e92);
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }

    body.pw-endcard-open .pw-toasts { display: none; }

    @media (max-width: 740px) {
      /* Same clearance math at the embed tier: scrubber root bottom 8px +
       * 46px band (26px transport + 20px strip; status line hidden) = 54px
       * band top, + 8px of air = 62px. Also covers <=560px, where the strip
       * drops and the band shrinks to 26px — the extra gap is air, never
       * overlap.
       *
       * The width and the bottom are MEASURED and stay literal. The headline
       * is not: dropping it one rung to the label size is the scale doing its
       * job at the floor, and it happens to be the value that was already
       * here. */
      .pw-toasts {
        width: min(240px, 46vw);
        bottom: 62px;
        gap: var(--pw-s-sm, 6px);
      }
      .pw-toast-headline { font-size: var(--pw-type-label, 11px); }
      /* ONE BEAT AT A TIME AT THE EMBED FLOOR.
       *
       * Measured in a real 640x360 cross-origin iframe: a single toast is
       * 240px wide and ~100px tall — 37% of the frame's width and 28% of its
       * height — and a stack of them buries the board and the identity plate
       * underneath. At this size the board IS the product; the feed is a
       * caption on it, not a column beside it.
       *
       * Only the newest survives, and the reason line goes: at 11px in a 240px
       * column a quoted rationale runs to four or five lines, which is a
       * paragraph laid over a 360px-tall map. The headline still says what
       * happened, and the full record is on the timeline and in the drawer. */
      .pw-toasts > .pw-toast:not(:last-child) { display: none; }
      .pw-toast-reason { display: none; }
      .pw-toast { padding: 5px 8px 6px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .pw-toast { animation: none; }
    }
  `;
  document.head.appendChild(style);
}

export function mountWarRoomToasts(game: GameView): Layer[] {
  if (!isAiLeagueReplayRoute()) return [];
  // The toasts are the native skin's presentation of the war-room feed. Under
  // the escape hatch (?native-spectator-ui=0) the incumbent panel is VISIBLE,
  // and running both means every beat is announced twice — plus the panel's
  // interactive "show earlier" backfill would fire toast bursts for ancient
  // beats whose keys were never primed.
  if (!document.body.classList.contains("ai-league-native-spectator-ui")) {
    return [];
  }
  return [new WarRoomToasts(game)];
}
