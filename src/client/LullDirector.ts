import { GameType } from "../core/game/Game";
import { GameRecord } from "../core/Schemas";
import { EventBus } from "../core/EventBus";
import { ReplaySpeedChangeEvent } from "./InputHandler";
import { parseReplayRenderSpeed } from "./ReplayRenderFastForward";
import { ReplaySpeedMultiplier } from "./utilities/ReplaySpeedMultiplier";

/**
 * ============================================================================
 * LULL DIRECTOR — auto-pacing for the broadcast replay.
 * ============================================================================
 *
 * The owner: "it looks like there is a long period at the start with nothing
 * happening and things just loading in. we should skip that in the replay. we
 * should also incorporate the speed up mechanic we use in paintbot to speed
 * through periods with nothing really happening."
 *
 * PAINTBOT PROVENANCE (the named reference, copied in FUNCTION)
 * -------------------------------------------------------------
 * PaintBot's skip-lulls mechanic, as found in its source:
 *  - DETECTION is a whole-match precompute: a background walk over the replay
 *    derives beat ticks (kills / flag steals / returns / captures / phase
 *    changes) with the SAME tracker its broadcast kill-feed uses, then
 *    `buildLullSpans` (src/ctf/replays.nim:425-447) inverts the beat list
 *    into the quiet spans BETWEEN beats, keeping LullLeadTicks = 2s of
 *    context on both sides of every beat (replays.nim:111-112) and dropping
 *    spans shorter than MinLullTicks = 6s — "skipping a short breather is
 *    more jarring than watching it" (replays.nim:64-69, 113-114).
 *  - THE SPEED-UP is a MULTIPLIER, not a cut: inside a lull the per-frame
 *    step budget becomes `speed * LullSpeedBoost` (8x, replays.nim:115)
 *    capped at MaxLullTicksPerFrame = 64 (replays.nim:117), re-read every
 *    tick so "the moment stepping crosses back into action it drops to the
 *    plain speed" and never overshoots a beat's lead-in
 *    (replays.nim:608-614, 737-739).
 *  - THE TRANSPORT SHOWS the spans up front as dimmed `.lull-span` segments
 *    over the track ("the grayed stretches are what the skip skips",
 *    chrome_common.js:307-331) and an amber "SKIPPING LULL" chip while the
 *    boost is live (chrome_common.js:254-256; league_replayer.html:298).
 *  - USER CONTROL: PaintBot's mode is a dedicated TOGGLE ('f' / its own
 *    transport button, replays.nim:688-689) that defaults ON
 *    (replays.nim:200); manual speed changes there are ORTHOGONAL — the
 *    boost multiplies whatever speed the viewer picked. THIS product already
 *    has a stronger house rule (P0 incident 2026-08-03, LocalServer.ts's
 *    `userOverrodeReplaySpeed`): automatic pacing is a default, never a
 *    lock, enforced via the ReplaySpeedChangeEvent source field
 *    ("user" | "auto", InputHandler.ts:166-180). This director rides that
 *    exact mechanism: every emission here is source "auto", so a viewer's
 *    manual pick beats it at the LocalServer level BY CONSTRUCTION, and the
 *    director additionally stands down for the rest of the session the
 *    moment it observes any "user"-sourced speed event.
 *
 * OUR DETECTION SIGNAL (translated to this engine's data)
 * -------------------------------------------------------
 * PaintBot derives beats server-side on a sim walk; we have something
 * cheaper and already in memory on the static path: the FULL decompressed
 * game record (LocalServer.replayTurns === lobbyConfig.gameRecord.turns, the
 * same array Main retains for in-place rewind). Intent density per
 * 100-turn bucket is the activity signal:
 *  - counted kinds: "attack", "boat", "build_unit", "upgrade_structure" —
 *    the war-making intents. Nukes ARE build_unit intents in this engine
 *    (an Atom Bomb / Hydrogen Bomb / MIRV launch is a build,
 *    core/Schemas.ts:397), so "attacks / boats / builds / nukes" is exactly
 *    this set. Spawns, alliance chatter, emoji and quick-chat are excluded:
 *    none of them is watchable board action.
 *  - THRESHOLD: a bucket is quiet when its count is below 25% of the MEDIAN
 *    non-zero bucket. Derived from the record's own distribution rather
 *    than any absolute number because match tempo varies wildly by player
 *    count and map (a 16-seat brawl logs an order of magnitude more intents
 *    than a duel); the median (not the mean) so one nuke-spam bucket cannot
 *    drag the bar up; 25% of "typical for THIS match" is unambiguously
 *    "nothing really happening". Floored at 1 so an utterly silent record
 *    still classifies (only empty buckets are lulls there).
 *  - Adjacent quiet buckets merge into spans; spans shorter than
 *    MIN_LULL_SPAN_TURNS = 400 are dropped (PaintBot's MinLullTicks rule:
 *    ~40s of game clock at 1x, ~20s at the broadcast's 2x default — the
 *    shortest stretch where flipping the speed is worth the mode change).
 *  - BEAT PROTECTION: the curated timeline markers (the same
 *    `.broadcast-timeline-marker` DOM the scrubber harvests — data-kind +
 *    `--broadcast-timeline-position`) are watch-worthy by definition
 *    (nukes, eliminations, lead changes), so every harvested beat turn
 *    carves BEAT_GUARD_TURNS of context out of any span on both sides —
 *    PaintBot's LullLeadTicks translated (replays.nim:442-443), sized like
 *    the scrubber's MARK_SEEK_LEAD_TURNS (300 turns ≈ 30s of game time:
 *    enough for the beat to develop on screen). Markers hydrate AFTER the
 *    details artifact lands, so the map is computed intent-only on the
 *    first frame (that version alone decides the intro skip — no beat can
 *    occur inside a zero-intent stretch, since every board event is caused
 *    by an earlier intent) and refined ONCE when the markers appear.
 *
 * THE INTRO SKIP
 * --------------
 * The spawn phase (config-derived, 300 turns on the fixture) plus however
 * long the record takes to reach its first war-making intent is pure
 * loading-screen theater — the owner wants it SKIPPED, not sped. On a fresh
 * watch (first frame at turn <= 5, no ?turn= deep link, no resume, no clip
 * preview — Main gates this at the install site where all four are in
 * scope) the director jumps to just before first contact via the existing
 * 'ai-league-replay-jump-turn' CustomEvent — the SAME document event the
 * scrubber and analyst drawer dispatch, so it flows through Main's
 * onReplayJump -> ReplayJumpToTurnEvent -> LocalServer.jumpReplayForward
 * and behaves exactly like a user seek. A toast says what happened. A
 * viewer who deep-links is left alone.
 *
 * THE MID-MATCH AUTO-SPEED
 * ------------------------
 * Entering a lull span raises the speed to ReplaySpeedMultiplier.fastest —
 * the only tier above the static broadcast's `fast` (2x) default
 * (LocalServer.applyArchivedReplayDefaultSpeed, LocalServer.ts:447-473),
 * and the engine's own "skim the idle" gear: with a gameRecord it runs the
 * dispatch loop flat-out with a bounded 60-turn backlog
 * (MAX_REPLAY_BACKLOG_TURNS, LocalServer.ts:48), so the worst overshoot
 * past a span's end is well inside the 300-turn beat guard — the same
 * safety PaintBot gets from re-reading its step budget every tick. Because
 * `fastest` is uncapped rather than a fixed multiple, the indicator says
 * "x MAX", not a number that would sometimes be a lie. Leaving the span
 * restores whatever the viewer had. The director never auto-paces while
 * the scrubber is scrubbing or rewinding (its data-state says so) or while
 * the end card owns the frame (body.pw-endcard-open), and it stands down
 * for the whole session on any manual speed change (module-level flag, so
 * an in-place rewind — which reinstalls this director without a page load —
 * cannot resurrect it; same lifetime contract as the scrubber's module
 * spoilers state).
 */

/** Bucket width for the intent-density scan; one pass over ~13k turns. */
const LULL_BUCKET_TURNS = 100;

/**
 * A bucket is quiet below this fraction of the median non-zero bucket —
 * see the class doc for why the threshold is derived from the record's own
 * distribution and why median beats mean here.
 */
const LULL_THRESHOLD_FRACTION = 0.25;

/**
 * Shortest quiet stretch worth auto-speeding: PaintBot's MinLullTicks rule
 * (replays.nim:113-114, "skipping a short breather is more jarring than
 * watching it") sized for our clock — 400 turns = 40s of game time at 1x,
 * ~20s at the broadcast's 2x default.
 */
const MIN_LULL_SPAN_TURNS = 400;

/**
 * Context carved out of lull spans around every harvested beat turn, both
 * sides — PaintBot's LullLeadTicks (replays.nim:111-112, 442-443)
 * translated, sized to match the scrubber's MARK_SEEK_LEAD_TURNS
 * (BroadcastScrubber.ts): ~30s of game time for the beat to develop in
 * front of the viewer. Also the safety margin that makes the `fastest`
 * boost's <=60-turn dispatch overshoot harmless.
 */
const BEAT_GUARD_TURNS = 300;

/**
 * The intro skip lands this many turns before the record's first
 * war-making intent — a short establishing beat (5s of game clock) so
 * first contact happens ON SCREEN rather than mid-swing.
 */
const INTRO_LEAD_TURNS = 50;

/** How long the intro-skip toast stays before fading. */
const INTRO_TOAST_MS = 4000;

/** Marker-harvest retry cadence; mirrors the scrubber's HARVEST_INTERVAL_MS. */
const BEAT_HARVEST_INTERVAL_MS = 1500;

export interface LullSpan {
  /** Inclusive turn range of one quiet stretch. */
  readonly startTurn: number;
  readonly endTurn: number;
}

// ---------------------------------------------------------------------------
// Module state shared with the scrubber (and across in-place rewinds).
// ---------------------------------------------------------------------------
// The scrubber pulls the computed spans through the getters below on its own
// harvest cadence; a version counter lets it re-render shading only when the
// map actually changes (twice per load at most: intent-only, then
// beat-refined). Module-level, like the scrubber's spoilers state, because an
// in-place rewind rebuilds both layers without a page load and the map is a
// property of the MATCH, not of one attempt.
let currentSpans: readonly LullSpan[] = [];
let currentSpanVersion = 0;

/**
 * SESSION KILL SWITCH — the user-override contract. Once a viewer manually
 * picks a speed (any "user"-sourced ReplaySpeedChangeEvent, including the
 * persisted-pick restore Main replays on the first frame), auto-pacing is
 * over for the rest of the session. Module-level on purpose: an in-place
 * rewind constructs a fresh LocalServer AND reinstalls this director, and
 * neither may quietly resurrect automation the viewer dismissed — the same
 * never-reset-mid-session lifetime LocalServer.ts documents for its own
 * `userOverrodeReplaySpeed` latch (which would silently ignore our "auto"
 * emissions anyway once set; this flag keeps the director honest enough not
 * to show a FAST-FORWARD indicator the engine is disregarding).
 */
let sessionAutoPacingCancelled = false;

/** The transport shading reads these; see BroadcastScrubber's lull layer. */
export function broadcastLullSpans(): readonly LullSpan[] {
  return currentSpans;
}
export function broadcastLullSpanVersion(): number {
  return currentSpanVersion;
}

/**
 * Spawn-phase length from the record's own config — mirrors
 * Config.numSpawnPhaseTurns (core/configuration/DefaultConfig.ts:609-617)
 * because the director runs on the replay-open path, before any live Config
 * object exists, and the record carries the same fields that method reads.
 */
function numSpawnPhaseTurnsOf(record: GameRecord): number {
  if (record.info.config.gameType === GameType.Singleplayer) return 100;
  if (record.info.config.randomSpawn) return 150;
  return 300;
}

/** One frame of the existing per-turn replay stream (ClientGameRunner.ts:827). */
interface ReplayFrameDetail {
  tick?: number;
}

interface LullDirectorOptions {
  gameRecord: GameRecord;
  eventBus: EventBus;
  /**
   * Computed by Main at the install site, where the ?turn= deep link, the
   * clip-preview target and the resume-position schedule are all already in
   * scope: true only for a genuinely fresh watch. The director never
   * second-guesses it.
   */
  allowIntroSkip: boolean;
}

/**
 * Arm the director for one replay attempt. Returns the dispose function the
 * caller pushes onto its attempt cleanups — an in-place rewind retires this
 * instance with the rest of the attempt's listeners and installs a fresh one.
 */
export function installLullDirector(options: LullDirectorOptions): () => void {
  // Headless clip capture forces its playback rate on the URL
  // (parseReplayRenderSpeed, same guard LocalServer's own default-speed
  // logic applies at LocalServer.ts:451) — a render worker's pacing is a
  // contract, never a viewership experience to direct.
  if (
    typeof window !== "undefined" &&
    parseReplayRenderSpeed(window.location.search) !== null
  ) {
    return () => {};
  }
  const director = new LullDirector(options);
  return () => director.dispose();
}

class LullDirector {
  private readonly record: GameRecord;
  private readonly eventBus: EventBus;
  private readonly allowIntroSkip: boolean;
  private readonly totalTurns: number;

  private disposed = false;
  private mapComputed = false;
  private beatsHarvested = false;
  private lastBeatHarvestMs = 0;
  private introDecided = false;

  /** True while our boost is applied; savedSpeed is what restores. */
  private boosting = false;
  private savedSpeed: ReplaySpeedMultiplier =
    ReplaySpeedMultiplier.normal;
  /**
   * The viewer's current speed as observed on the bus, seeded with the SAME
   * derivation LocalServer.applyArchivedReplayDefaultSpeed (LocalServer.ts:
   * 447-473) and ReplayPanel.resolveInitialReplaySpeedMultiplier use,
   * because the default is applied inside LocalServer without an event ever
   * crossing the bus (the emit/subscribe race both of those files document).
   */
  private viewerSpeed: ReplaySpeedMultiplier;
  /** Reentrancy guard: our own emissions must not update viewerSpeed. */
  private emittingOwnSpeedChange = false;

  private indicator: HTMLButtonElement | null = null;
  private scrubberEl: HTMLElement | null = null;

  private readonly onFrame = (event: Event) => {
    this.handleFrame(event as CustomEvent<ReplayFrameDetail>);
  };
  private readonly onSpeedChange = (event: ReplaySpeedChangeEvent) => {
    if (this.emittingOwnSpeedChange) return;
    this.viewerSpeed = event.replaySpeedMultiplier;
    if (event.source === "user") {
      // THE OVERRIDE, PaintBot-adjacent but stricter (see class doc): a
      // manual pick cancels auto-pacing for the rest of the SESSION. If a
      // boost is live, it is simply abandoned — never "restored over",
      // because the user's new speed IS the current truth and LocalServer's
      // own latch would discard our "auto" restore anyway.
      sessionAutoPacingCancelled = true;
      if (this.boosting) {
        this.boosting = false;
        this.hideIndicator();
      }
    }
  };

  constructor(options: LullDirectorOptions) {
    this.record = options.gameRecord;
    this.eventBus = options.eventBus;
    this.allowIntroSkip = options.allowIntroSkip;
    this.totalTurns = options.gameRecord.info.num_turns;
    const staticBroadcast =
      (window as typeof window & { __PROXYWAR_STATIC_REPLAY__?: boolean })
        .__PROXYWAR_STATIC_REPLAY__ === true;
    this.viewerSpeed = staticBroadcast
      ? ReplaySpeedMultiplier.fast
      : ReplaySpeedMultiplier.fastest;
    mountLullStyles();
    document.addEventListener("ai-league-replay-frame", this.onFrame);
    this.eventBus.on(ReplaySpeedChangeEvent, this.onSpeedChange);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("ai-league-replay-frame", this.onFrame);
    this.eventBus.off(ReplaySpeedChangeEvent, this.onSpeedChange);
    // No restore emission here: dispose runs when the attempt is being torn
    // down (rewind / navigation), where a fresh LocalServer derives its own
    // default and Main replays any retained user pick (the H6 contract in
    // LocalServer.ts). Only the chrome must not outlive us.
    this.boosting = false;
    this.hideIndicator();
    document.querySelector(".pw-lull-toast")?.remove();
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private handleFrame(event: CustomEvent<ReplayFrameDetail>): void {
    if (this.disposed) return;
    const tick = event.detail?.tick;
    if (typeof tick !== "number" || !Number.isFinite(tick)) return;

    if (!this.mapComputed) {
      this.mapComputed = true;
      this.computeIntentSpans();
    }
    if (!this.introDecided) {
      this.introDecided = true;
      this.maybeSkipIntro(tick);
    }
    if (!this.beatsHarvested) {
      this.maybeHarvestBeats();
    }
    this.directSpeed(tick);
  }

  // -------------------------------------------------------------------------
  // The lull map
  // -------------------------------------------------------------------------

  /**
   * One pass over the record's turns, bucketed by turnNumber — correct on
   * the sparse pre-decompression array AND the dense in-place result
   * `decompressGameRecord` leaves behind (core/Util.ts:290-312), since
   * intent-less filler turns contribute nothing either way.
   */
  private computeIntentSpans(): void {
    if (this.totalTurns <= 0) return;
    const bucketCount = Math.ceil(this.totalTurns / LULL_BUCKET_TURNS);
    const buckets = new Array<number>(bucketCount).fill(0);
    for (const turn of this.record.turns) {
      if (turn.turnNumber >= this.totalTurns) continue;
      const bucket = Math.floor(turn.turnNumber / LULL_BUCKET_TURNS);
      for (const intent of turn.intents) {
        const kind = intent.type;
        if (
          kind === "attack" ||
          kind === "boat" ||
          kind === "build_unit" ||
          kind === "upgrade_structure"
        ) {
          buckets[bucket] += 1;
        }
      }
    }

    const nonZero = buckets.filter((v) => v > 0).sort((a, b) => a - b);
    if (nonZero.length === 0) {
      // A record with zero war-making intents end to end has nothing to
      // pace around — no spans, no skip, no boost.
      this.publishSpans([]);
      return;
    }
    const median = nonZero[Math.floor(nonZero.length / 2)];
    const threshold = Math.max(1, LULL_THRESHOLD_FRACTION * median);

    const spans: LullSpan[] = [];
    for (let b = 0; b < bucketCount; b++) {
      if (buckets[b] >= threshold) continue;
      const start = b;
      while (b + 1 < bucketCount && buckets[b + 1] < threshold) b++;
      spans.push({
        startTurn: start * LULL_BUCKET_TURNS,
        endTurn: Math.min(this.totalTurns, (b + 1) * LULL_BUCKET_TURNS) - 1,
      });
    }
    this.publishSpans(
      spans.filter(
        (s) => s.endTurn - s.startTurn + 1 >= MIN_LULL_SPAN_TURNS,
      ),
    );
  }

  /**
   * Refinement pass, run ONCE when the curated timeline markers exist: every
   * beat turn carves its guard window out of the spans (PaintBot keeps beat
   * context out of its lulls the same way, replays.nim:442-443), and spans
   * that fall under the minimum afterwards are dropped. Retried on the
   * harvest cadence until markers appear — they hydrate with the details
   * artifact, seconds after first frame — and never re-run after.
   */
  private maybeHarvestBeats(): void {
    const now = performance.now();
    if (now - this.lastBeatHarvestMs < BEAT_HARVEST_INTERVAL_MS) return;
    this.lastBeatHarvestMs = now;
    const nodes = document.querySelectorAll<HTMLElement>(
      ".broadcast-timeline-marker",
    );
    if (nodes.length === 0) return;
    const beatTurns: number[] = [];
    for (const node of nodes) {
      const raw = node.style.getPropertyValue("--broadcast-timeline-position");
      const at = Number.parseFloat(raw) / 100;
      if (!Number.isFinite(at)) continue;
      beatTurns.push(
        Math.round(Math.min(1, Math.max(0, at)) * this.totalTurns),
      );
    }
    if (beatTurns.length === 0) return;
    // Latched only once a harvest actually YIELDED beats. It used to latch as
    // soon as any marker nodes existed, so a harvest that found nodes but
    // could not parse a single position — markers mid-render, before their
    // custom property is set — permanently marked the beats as harvested and
    // no later attempt ever ran. The guards carved around real beats would
    // then be missing for the whole session, and a lull boost could run
    // straight over a nuke.
    this.beatsHarvested = true;
    beatTurns.sort((a, b) => a - b);

    let spans = [...currentSpans];
    for (const beat of beatTurns) {
      const guardStart = beat - BEAT_GUARD_TURNS;
      const guardEnd = beat + BEAT_GUARD_TURNS;
      const next: LullSpan[] = [];
      for (const span of spans) {
        if (span.endTurn < guardStart || span.startTurn > guardEnd) {
          next.push(span);
          continue;
        }
        if (span.startTurn < guardStart) {
          next.push({ startTurn: span.startTurn, endTurn: guardStart - 1 });
        }
        if (span.endTurn > guardEnd) {
          next.push({ startTurn: guardEnd + 1, endTurn: span.endTurn });
        }
      }
      spans = next;
    }
    this.publishSpans(
      spans.filter(
        (s) => s.endTurn - s.startTurn + 1 >= MIN_LULL_SPAN_TURNS,
      ),
    );
  }

  private publishSpans(spans: readonly LullSpan[]): void {
    currentSpans = spans;
    currentSpanVersion += 1;
  }

  private spanAt(turn: number): LullSpan | null {
    for (const span of currentSpans) {
      if (turn < span.startTurn) return null; // spans are ordered
      if (turn <= span.endTurn) return span;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // The intro skip
  // -------------------------------------------------------------------------

  private maybeSkipIntro(tick: number): void {
    if (!this.allowIntroSkip) return;
    // "Playback begins": only a genuinely fresh watch sits at the top of the
    // record on its first frame. Anything already deeper (Main's own
    // first-frame jump for ?turn=/resume fired before us, or a mid-record
    // premiere) is left alone.
    if (tick > 5) return;
    const leading = this.spanAt(Math.max(0, tick));
    if (leading === null || leading.startTurn > 5) return;
    // Just before the first non-lull activity: the span already ends at the
    // last quiet bucket, so first contact is at its end + 1; back off the
    // establishing lead, and never land inside the spawn phase — nothing but
    // spawn dots happens before it ends (the owner's "things just loading
    // in"), so it is the floor, not the ceiling.
    const target = Math.max(
      numSpawnPhaseTurnsOf(this.record),
      leading.endTurn + 1 - INTRO_LEAD_TURNS,
    );
    if (target <= tick) return;
    // The SAME seek event every other transport control dispatches
    // (BroadcastScrubber.ts, AnalystDrawer.ts) — Main routes it into
    // ReplayJumpToTurnEvent, LocalServer replays forward to the target, and
    // the scrubber's playhead follows game.ticks() like any user seek.
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-jump-turn", {
        detail: { turnNumber: target },
      }),
    );
    this.showIntroToast(target - tick);
  }

  private showIntroToast(skippedTurns: number): void {
    document.querySelector(".pw-lull-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "pw-lull-toast";
    const kind = document.createElement("div");
    kind.className = "pw-lull-toast-kind";
    kind.textContent = "AUTO-PACING";
    const body = document.createElement("div");
    body.className = "pw-lull-toast-body";
    body.textContent = `SKIPPED ${skippedTurns.toLocaleString()} QUIET TURNS — MATCH BEGINS`;
    toast.append(kind, body);
    document.body.appendChild(toast);
    // Two-step fade on wall clock: a notice about a jump we already made has
    // no pause-gap to absorb (unlike WarRoomToasts' game-time contract).
    window.setTimeout(() => {
      toast.dataset.fade = "1";
    }, INTRO_TOAST_MS);
    window.setTimeout(() => toast.remove(), INTRO_TOAST_MS + 600);
  }

  // -------------------------------------------------------------------------
  // The mid-match auto-speed
  // -------------------------------------------------------------------------

  private directSpeed(tick: number): void {
    if (sessionAutoPacingCancelled) return;
    const eligible = this.eligibleNow();
    const inLull = this.spanAt(tick) !== null;
    if (!this.boosting) {
      if (
        eligible &&
        inLull &&
        // Boosting fastest to fastest is a no-op that would only show a
        // lying indicator — the analyst-surface default is already there.
        this.viewerSpeed !== ReplaySpeedMultiplier.fastest
      ) {
        this.boosting = true;
        this.savedSpeed = this.viewerSpeed;
        this.emitAuto(ReplaySpeedMultiplier.fastest);
        this.showIndicator();
      }
      return;
    }
    if (!inLull || !eligible) {
      // Restore what the viewer had, on the "auto" channel — never "user",
      // which would set LocalServer's override latch and pollute the
      // persisted viewer pick with a decision the viewer never made.
      this.boosting = false;
      this.emitAuto(this.savedSpeed);
      this.hideIndicator();
    }
  }

  /**
   * Auto-pacing yields the moment any other narrative surface owns the
   * frame: an in-flight scrub or rewind (the scrubber's own data-state,
   * BroadcastScrubber.ts paint/rewindTo) or the end card
   * (body.pw-endcard-open — the same class that stands the whole HUD down,
   * ReplayEndCard.ts).
   */
  private eligibleNow(): boolean {
    if (document.body.classList.contains("pw-endcard-open")) return false;
    if (this.scrubberEl === null || !this.scrubberEl.isConnected) {
      this.scrubberEl = document.querySelector<HTMLElement>(".pw-scrubber");
    }
    const state = this.scrubberEl?.dataset.state;
    return state === undefined || state === "idle";
  }

  private emitAuto(speed: ReplaySpeedMultiplier): void {
    this.emittingOwnSpeedChange = true;
    try {
      this.eventBus.emit(new ReplaySpeedChangeEvent(speed, "auto"));
    } finally {
      this.emittingOwnSpeedChange = false;
    }
  }

  private showIndicator(): void {
    if (this.indicator !== null && this.indicator.isConnected) return;
    document.querySelector(".pw-lull-ffwd")?.remove();
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pw-lull-ffwd";
    const line = document.createElement("span");
    line.className = "pw-lull-ffwd-line";
    // PaintBot's chip is "SKIPPING LULL" with no number (its boost is a
    // fixed 8x); ours rides the uncapped `fastest` tier, so the multiplier
    // reads MAX rather than a figure that would sometimes be false.
    line.textContent = "FAST-FORWARD ×MAX — QUIET PERIOD";
    const hint = document.createElement("span");
    hint.className = "pw-lull-ffwd-hint";
    hint.textContent = "CLICK TO RESUME NORMAL SPEED";
    chip.append(line, hint);
    chip.addEventListener("click", () => {
      // The escape hatch IS a cancellation of automation, not a speed pick:
      // restore over the "auto" channel and stand down for the session, so
      // the viewer's persisted speed record stays untouched.
      sessionAutoPacingCancelled = true;
      if (this.boosting) {
        this.boosting = false;
        this.emitAuto(this.savedSpeed);
      }
      this.hideIndicator();
    });
    document.body.appendChild(chip);
    this.indicator = chip;
  }

  private hideIndicator(): void {
    this.indicator?.remove();
    this.indicator = null;
    document.querySelector(".pw-lull-ffwd")?.remove();
  }
}

// ---------------------------------------------------------------------------
// Styles — house grammar: --pw-* tokens with fallbacks, amber accent only
// (coral stays reserved for violence), glass chip surfaces matching
// WarRoomToasts / the scrubber's preview tag. No backticks inside this
// template literal — they would terminate it.
// ---------------------------------------------------------------------------

let lullStylesMounted = false;

function mountLullStyles(): void {
  if (lullStylesMounted) return;
  lullStylesMounted = true;
  if (document.getElementById("pw-lull-styles") !== null) return;
  const style = document.createElement("style");
  style.id = "pw-lull-styles";
  style.textContent = `
    /* Intro-skip notice: top-center glass chip, amber-led, auto-fades. */
    .pw-lull-toast {
      position: fixed;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 50040;
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 8px 14px;
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border-left: 3px solid var(--pw-accent, #ffc24a);
      opacity: 1;
      transition: opacity 0.5s ease;
      pointer-events: none;
    }
    .pw-lull-toast[data-fade="1"] { opacity: 0; }
    .pw-lull-toast-kind {
      font: 700 8.5px/1.2 var(--pw-display, system-ui, sans-serif);
      letter-spacing: 0.18em;
      color: var(--pw-accent, #ffc24a);
    }
    .pw-lull-toast-body {
      font: 600 11px/1.2 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      letter-spacing: 0.1em;
      color: var(--pw-ink, #f2ece2);
      font-variant-numeric: tabular-nums;
    }

    /* Fast-forward indicator: a small persistent chip centered ABOVE the
     * transport band (the scrubber owns bottom 14-90px; 96px clears its
     * tallest, graph-bearing form). It is a BUTTON — the whole chip is the
     * escape hatch — z-indexed with the transport family (scrubber 50006). */
    .pw-lull-ffwd {
      position: fixed;
      bottom: 96px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 50007;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      margin: 0;
      padding: 7px 12px;
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border-left: 3px solid var(--pw-accent, #ffc24a);
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      cursor: pointer;
      pointer-events: auto;
    }
    .pw-lull-ffwd-line {
      font: 700 10px/1.2 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      letter-spacing: 0.14em;
      color: var(--pw-accent, #ffc24a);
    }
    .pw-lull-ffwd-hint {
      font: 600 8px/1.2 var(--pw-display, system-ui, sans-serif);
      letter-spacing: 0.14em;
      color: var(--pw-ink-dim, #a79e92);
    }
    .pw-lull-ffwd:hover .pw-lull-ffwd-hint { color: var(--pw-ink, #f2ece2); }
    .pw-lull-ffwd:focus-visible {
      outline: 1px solid var(--pw-accent, #ffc24a);
      outline-offset: 2px;
    }

    /* The end card owns the frame — same stand-down the scrubber takes. */
    body.pw-endcard-open .pw-lull-ffwd,
    body.pw-endcard-open .pw-lull-toast { display: none; }

    @media (max-width: 740px) {
      .pw-lull-ffwd { bottom: 78px; }
      .pw-lull-ffwd-hint { display: none; }
    }
  `;
  document.head.appendChild(style);
}
