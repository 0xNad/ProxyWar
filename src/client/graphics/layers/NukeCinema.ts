import { EventBus } from "../../../core/EventBus";
import { Nukes, UnitType } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView, UnitView } from "../../../core/game/GameView";
import {
  aiLeagueSpectatorDisplayName,
  isAiLeagueReplayRoute,
} from "../../AiLeagueReplayMode";
import { translateText } from "../../Utils";
import { GoToPositionEvent, TransformHandler } from "../TransformHandler";
import { followedCompetitorSmallId } from "./FollowedCompetitor";
import { Layer } from "./Layer";

/**
 * ============================================================================
 * NUKE CINEMA — the drama layer of a Proxy War broadcast.
 * ============================================================================
 *
 * WHAT THIS IS FOR
 * ----------------
 * A nuclear launch is the single most consequential thing that happens in a
 * Proxy War match, and until now it was also the least legible: `FxLayer`
 * draws a sprite explosion for two thirds of a second on a board that, at the
 * broadcast's whole-map fit, renders the blast about eight pixels across. A
 * viewer watching the frame — not hunting for it — misses it entirely.
 *
 * So this layer stages a launch the way a broadcast would: an ALERT while the
 * warhead is in the air, a RETICLE on the ground it is about to take, a camera
 * that goes and looks, a FLASH at the moment of impact, and an AFTERMATH beat
 * before it hands the frame back. Four beats, one event.
 *
 * HOW A NUKE IS DETECTED — POLLED STATE, NOT UPDATES
 * ---------------------------------------------------
 * `FxLayer` reads `updatesSinceLastTick()`, which returns ONLY the most recent
 * batch. That is fine for a fire-and-forget sprite but wrong here: this layer
 * has to know when a warhead is in flight (a span, not an instant), and a
 * single missed batch would strand the alert on screen forever. So it polls
 * `game.units(...Nukes)` — the live set — and diffs it against what it saw
 * last tick:
 *
 *   - an id that is present and was NOT tracked   -> LAUNCH
 *   - an id that was tracked and is now ABSENT    -> IMPACT
 *
 * The absent case must be read from our own record, never by looking the unit
 * back up: `GameView` deletes dead units on the tick after they die (see the
 * `toDelete` set in `GameView.updateUnits()`), so by the time we notice one is
 * gone, `game.unit(id)` is already `undefined`. Everything the impact beat
 * needs — target tile, owner, warhead class — is therefore captured at launch
 * and carried forward.
 *
 * WHY THE CAMERA IS SAFE TO MOVE
 * -------------------------------
 * The broadcast HUD docks into the letterbox bands the camera publishes
 * (`--pw-band-*`). Those are published on FIT and RESIZE only — explicitly
 * NEVER on zoom (see the comment at the bottom of `TransformHandler.centerAll`)
 * — so a punch-in pans and zooms the board WITHOUT reflowing a single panel.
 * The camera is restored to the exact cell and scale captured at launch, so a
 * viewer who was looking at the whole board gets the whole board back.
 *
 * The punch-in is suppressed below `MIN_PUNCH_IN_WIDTH`: at the 640x360 embed
 * floor the whole board is barely two inches wide, and trading it for a
 * close-up would cost more read than the drama buys.
 *
 * MIRV COALESCING AND THE ONE-CINEMA RULE
 * ----------------------------------------
 * A MIRV splits into many warheads that appear on the SAME tick, and this
 * fixture launches two Atom Bombs on turn 8100 alone. Staging each one would
 * mean a stack of alerts and a camera ping-ponging between targets. So at most
 * one cinema runs at a time: simultaneous warheads coalesce into a single
 * alert that counts them ("MIRV -- 8 WARHEADS"), and a launch arriving while a
 * cinema is already running is tracked for its impact flash but does not steal
 * the frame.
 *
 * TIME IS WALL-CLOCK, NOT TICKS
 * ------------------------------
 * The broadcast plays at 2x by default and the viewer can scrub to any speed.
 * Beat lengths are in milliseconds so the drama reads identically at any rate;
 * only the beat TRIGGERS come from game state.
 *
 * SCRUBBING
 * ---------
 * Seeking backwards is a discontinuity, not an event: the tracked unit set
 * becomes meaningless and any in-flight cinema is describing a future that no
 * longer exists. A backwards tick tears the whole layer down and gives the
 * camera back immediately.
 *
 * LIVE PLAY IS UNTOUCHED
 * ----------------------
 * `mountNukeCinema()` returns `[]` off the replay route, so nothing here is
 * constructed, mounted, or ticked during a live game.
 */

/** Warhead classes, in the order a broadcast would rank their severity. */
const WARHEAD_LABEL: Partial<Record<UnitType, string>> = {
  [UnitType.MIRV]: "MIRV",
  [UnitType.HydrogenBomb]: "HYDROGEN",
  [UnitType.AtomBomb]: "ATOM",
  [UnitType.MIRVWarhead]: "MIRV",
};

/**
 * Blast radii, matched to the values `FxLayer.onUnitEvent` passes to its own
 * explosion so the broadcast ring agrees with the sprite it frames.
 */
const WARHEAD_RADIUS: Partial<Record<UnitType, number>> = {
  [UnitType.AtomBomb]: 70,
  [UnitType.MIRVWarhead]: 70,
  [UnitType.HydrogenBomb]: 160,
  [UnitType.MIRV]: 160,
};

/** How long the impact flash and its shockwave ring last. */
const FLASH_MS = 620;
/** Aftermath hold: the crater stays framed before the camera is handed back. */
const AFTERMATH_MS = 1500;
/**
 * How long the mushroom cloud lives. Deliberately longer than the camera's
 * aftermath hold: with nobody followed the camera never moves at all, so the
 * cloud is the ONLY thing telling a viewer who glanced away that something
 * happened here — it has to still be standing when they look back.
 */
const CLOUD_LIFE_MS = 4200;
/** Fraction of the cloud's life spent climbing before it starts to disperse. */
const CLOUD_RISE_FRACTION = 0.42;
/**
 * How long the contaminated-ground cordon stays marked on the board.
 *
 * MEASURED, and the number is the whole reason this exists: the engine's own
 * fallout peaks at 1,563 tiles the instant a warhead lands and is back to ZERO
 * roughly two seconds later at 2x — and for most of those two seconds it is
 * underneath the detonation flash and the mushroom cloud. So the mechanic that
 * poisons the ground is, on screen, a flicker nobody can see; recolouring it
 * (which r40 also did — see PastelThemeDark.falloutColor) cannot fix something
 * that is not on screen long enough to read.
 *
 * This cordon is a BROADCAST mark, not a simulation of the mechanic. It was
 * first shipped at 12s, and the owner's verdict on the real board was that
 * overlapping cordons "persist too long and clutter the screen" — two strikes
 * near each other left a lattice of dashed rings over the coast. 5s keeps the
 * post-impact read (still 2.5x the engine's own fallout life) without the
 * clutter, and the mark itself was lightened at the same time: one ring, not
 * two, and eight ticks, not twelve.
 */
const ZONE_LIFE_MS = 5000;
/**
 * Hard ceiling on detonations drawn at once. Oldest evicted first.
 *
 * MEASURED, and the number this protects against is not hypothetical: a single
 * `MIRVExecution` can put 350 warheads on the board, every one of them landing
 * inside the same ZONE_LIFE_MS window, and `impacts` had no cap at all. Each
 * live impact rebuilds its cloud raster every 84ms (CLOUD_LIFE_MS /
 * CLOUD_STEPS), so an uncapped salvo measured ~4,167 canvas creations a second
 * and ~31.8 million Math.sin calls a second, sustained for five seconds — a
 * frame budget spent entirely on clouds nobody can tell apart.
 *
 * Nobody can tell them apart because 350 blast radii inside one MIRV footprint
 * overlap into a single opaque mass: past roughly two dozen the salvo reads as
 * "the map got hit", and the 25th column adds cost and no information. So the
 * cap is a drawing decision that happens to be the fix, not a budget hack.
 *
 * OLDEST FIRST, and the eviction has to be that way round. `impacts` is
 * naturally in ascending-atMs order (appended as warheads land; absorbTimeGap
 * shifts every entry by the same amount), so the front is both the oldest and
 * the most dispersed — the mark whose loss costs the least read. Evicting
 * rather than REFUSING is the other half: "the frame must never show a strike
 * it did not mark" (see `impacts`), so a new detonation always gets its cloud
 * and the faded one at the front gives up its place. A same-tick salvo shares
 * one atMs, and there the survivors are the last 24 in poll order — which is
 * `game.units()` order, which is Map insertion order, so a replay keeps the
 * same 24 on every playback.
 *
 * Below 25 concurrent detonations — every strike this broadcast has ever
 * shown outside a MIRV — nothing about the frame changes.
 */
const MAX_IMPACTS = 24;
/** How long the alert plate lingers after the aftermath beat, fading out. */
const ALERT_OUTRO_MS = 700;
/**
 * Hard ceiling on a single cinema. A warhead whose impact update never lands
 * (a desync, a scrub landing mid-flight, a SAM interception recorded oddly)
 * must not pin the camera or the alert open forever.
 */
const MAX_FLIGHT_MS = 14000;
/** Quiet window after a cinema ends before another may take the frame. */
const COOLDOWN_MS = 900;
/**
 * Any gap between ticks longer than this is a pause or a backgrounded tab, not
 * elapsed drama — see `absorbTimeGap`. Comfortably longer than the slowest
 * real frame at the slowest replay speed.
 */
const PAUSE_GAP_MS = 700;
/**
 * Above this many game ticks per wall-clock second the replay is seeking, not
 * playing, and no cinema may start — see `measureTickRate`. Sits an order of
 * magnitude above the fastest real playback speed and two below a seek.
 */
const CATCHUP_TICKS_PER_SECOND = 150;
/**
 * Below this viewport width the punch-in is skipped and the cinema plays as
 * alert + on-map marks only. The board is too small to give up.
 */
const MIN_PUNCH_IN_WIDTH = 741;
/**
 * Punch-in scale as a multiple of the whole-board fit. Deliberately modest:
 * this reads as "lean in", not "dive at the ground", and it keeps the
 * surrounding front in frame so the blast has context.
 *
 * It is also capped by a defect: at the broadcast's whole-map fit the terrain
 * raster is already near its native resolution, so zooming much past this
 * trades board read for a soft, upscaled picture (the open zoom-LOD item). A
 * 2.1x punch-in was tried first and the blur was the loudest thing in frame.
 * When LOD is fixed this can go deeper.
 */
const PUNCH_IN_ZOOM = 1.55;
/**
 * Fraction of the warhead's flight that must be behind it before the camera
 * moves. A launch-to-impact hold ran ~10 wall-clock seconds on the real
 * fixture — far too long to take the board away from a viewer, and dead air
 * for most of it. Arming the alert at launch but only cutting to the target on
 * the final approach gives the beat a broadcast's rhythm: warning, then cut,
 * then hit.
 */
const PUNCH_IN_PROGRESS = 0.55;

type Beat = "flight" | "flash" | "aftermath" | "outro";

interface TrackedNuke {
  id: number;
  type: UnitType;
  /** Tile the warhead is aimed at, captured at launch — see class doc. */
  targetTile: TileRef | null;
  /** Where it came up out of the ground; the tail of the launch arc. */
  originX: number;
  originY: number;
  ownerName: string;
  targetName: string | null;
  /** Engine player indices, for deciding whether a follow is involved. */
  ownerSmallId: number | null;
  targetSmallId: number | null;
  /** Last position seen while in flight; where the flash is staged. */
  lastX: number;
  lastY: number;
  seenAtMs: number;
  /** Straight-line distance to the target at launch; the ETA denominator. */
  launchDistance: number;
  /** Distance still to run, refreshed every poll. */
  distance: number;
  /**
   * Closing speed in tiles per millisecond of WALL CLOCK, smoothed. Measured
   * rather than assumed: the viewer can scrub the replay to any rate, so the
   * only honest ETA is one derived from how fast the warhead is actually
   * crossing the screen right now.
   */
  speed: number;
  lastSampleMs: number;
}

interface Cinema {
  beat: Beat;
  beatStartedMs: number;
  startedMs: number;
  /** Every warhead this cinema speaks for (a MIRV salvo is one cinema). */
  nukes: TrackedNuke[];
  primary: TrackedNuke;
  /** Camera state captured the instant before the punch-in. */
  restore: { x: number; y: number; scale: number; intentEpoch: number } | null;
  /** Set once the camera has been sent to the target; the cut happens once. */
  punchedIn: boolean;
  /** At least one of this cinema's warheads was shot down short of its target. */
  intercepted?: boolean;
}

interface Impact {
  x: number;
  y: number;
  radius: number;
  atMs: number;
  /** Stable per-blast randomness, so a cloud's shape never boils. */
  seed: number;
  /** Cached cloud raster; see `cloudRaster`. */
  raster: CloudRaster | null;
  /**
   * The cordon's radial wash, built once per blast rather than once per frame.
   * Its geometry cannot move: the gradient is defined in world space, centred
   * on (impact.x - map width / 2, impact.y - map height / 2) at the blast
   * radius, and all three of those are constants for the life of the impact —
   * the camera rides on the context transform, not on the gradient. See
   * `drawContaminationZone` for where the per-frame breathing went.
   */
  wash: CanvasGradient | null;
}

// NOTE (open work): a canvas + ImageData + Float32Array is still allocated per
// impact per cloud step — measured at ~4,167 canvas creations/sec in the worst
// case, because a single MIRV can put 350 warheads in the air. The scratch-reuse
// refactor that removes it (hold ctx/img/density and a memoised noise field on
// this raster, sized once per blast for the widest step) is drafted but NOT
// landed; landing it half-done would have shipped a cloud that renders
// differently, and this cinema's determinism is load-bearing. The impact cap
// below bounds the worst case in the meantime.
interface CloudRaster {
  canvas: HTMLCanvasElement;
  /** Which animation step this was rasterised for. */
  step: number;
  /** Where the raster's top-left sits, in world units from the impact point. */
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export class NukeCinema implements Layer {
  private tracked = new Map<number, TrackedNuke>();
  private cinema: Cinema | null = null;
  /**
   * Set while a seek is running, cleared by the first poll after it lands.
   * That first poll ADOPTS what is in the air without narrating it — see
   * pollNukes' doc for why a warhead already halfway to its target must not
   * arrive as a launch alert.
   */
  private pollSuspended = false;
  /**
   * Detonations still worth drawing. Held on the LAYER, not the cinema: the
   * mushroom cloud outlives the beat that announced it, and a warhead can also
   * land with no cinema running at all (a salvo the current cinema does not
   * speak for). The frame must never show a strike it did not mark.
   */
  private impacts: Impact[] = [];
  /** Whether the CURRENT cinema has produced a real detonation yet. */
  private anyDetonated = false;
  private lastTick = -1;
  private lastTickMs = 0;
  private lastCinemaEndedMs = 0;
  private tickRate = 0;
  private rateSampledAtMs = 0;
  private root: HTMLElement | null = null;
  private plate: HTMLElement | null = null;
  private flash: HTMLElement | null = null;
  private flashTimer: number | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
  ) {}

  init() {
    mountNukeCinemaStyles();
    // A rewind can orphan the previous instance MID-CINEMA, with
    // body.pw-nuke-active still set — which leaves the war-room rail dimmed to
    // 0.14 for the rest of the session, because during the catch-up no new
    // cinema can start to clear it. The claim belongs to the instance that set
    // it; a fresh instance starts with the stage unclaimed. (NationDossier
    // clears its own pw-dossier-on in init() for the same reason.)
    document.body.classList.remove("pw-nuke-active");
    // IDEMPOTENT MOUNT. An in-place rewind tears the game down and builds a new
    // one without a page reload, so init() runs again against a document that
    // still holds the previous instance's node. Without this you get two of
    // these stacked on top of each other, the older one frozen forever because
    // its layer is no longer ticked. Adopting-by-removal rather than reusing the
    // node keeps this one line instead of a resurrection path.
    document.querySelector(".pw-nuke-cinema")?.remove();
    const root = document.createElement("div");
    root.className = "pw-nuke-cinema";
    const flash = document.createElement("div");
    flash.className = "pw-nuke-flash";
    const plate = document.createElement("div");
    plate.className = "pw-nuke-alert";
    root.appendChild(flash);
    root.appendChild(plate);
    document.body.appendChild(root);
    this.root = root;
    this.plate = plate;
    this.flash = flash;
  }

  /**
   * Ticks every frame on purpose. The layer's per-tick work is a diff over the
   * handful of live nuke units; throttling it would only blur the launch and
   * impact instants that the whole effect is timed from.
   */
  tick() {
    const tick = this.game.ticks();
    if (tick < this.lastTick) {
      // Scrubbed backwards — see the class doc.
      this.reset();
    }
    const advanced = this.lastTick < 0 ? 0 : Math.max(0, tick - this.lastTick);
    this.lastTick = tick;

    const now = performance.now();
    this.absorbTimeGap(now);
    this.measureTickRate(advanced, now);
    this.pollNukes(now);
    this.advance(now);
    // Drop detonations whose cloud has finished dispersing, so the list can
    // never grow across a long match.
    if (this.impacts.length > 0) {
      this.impacts = this.impacts.filter(
        (impact) => now - impact.atMs <= ZONE_LIFE_MS,
      );
    }
    this.renderAlert();
  }

  /**
   * Keep wall-clock beats honest across a gap in ticking.
   *
   * `GameRenderer.tick()` is driven by game updates (`ClientGameRunner`), so
   * PAUSING THE REPLAY STOPS THIS LAYER. Every beat here is timed in wall
   * clock, which is right while playing and wrong the instant the viewer hits
   * pause: come back after twenty seconds and the flash would have "expired",
   * the flight would trip its safety timeout, and an in-air warhead would lose
   * its alert. Backgrounding the tab does the same thing via rAF throttling.
   *
   * So a gap longer than any real frame is treated as time that did not
   * happen, and every live timestamp is shifted forward past it. The beat
   * resumes exactly where the viewer left it.
   */
  private absorbTimeGap(now: number) {
    const previous = this.lastTickMs;
    this.lastTickMs = now;
    if (previous <= 0) return;
    const gap = now - previous;
    if (gap <= PAUSE_GAP_MS) return;

    const shift = gap - PAUSE_GAP_MS;
    const cinema = this.cinema;
    if (cinema !== null) {
      cinema.startedMs += shift;
      cinema.beatStartedMs += shift;
    }
    for (const impact of this.impacts) impact.atMs += shift;
    for (const nuke of this.tracked.values()) {
      nuke.seenAtMs += shift;
      nuke.lastSampleMs += shift;
    }
    this.lastCinemaEndedMs += shift;
  }

  /**
   * Track how fast game time is passing, in ticks per wall-clock second.
   *
   * A seek — the `?turn=` deep link, a rail click, the refresh-resume — is
   * served by replaying every intervening turn as fast as the machine can go.
   * Measured on the real fixture, a seek crosses ~1,400 turns per second
   * against ~20 for normal 2x playback. Without this, jumping into the middle
   * of a match machine-guns every nuke between here and there: alerts strobe,
   * the camera lurches at targets that were destroyed a thousand turns ago,
   * and the viewer arrives mid-flash. Two orders of magnitude of daylight
   * between the two rates makes the distinction safe to draw.
   */
  private measureTickRate(advanced: number, now: number) {
    const dt = now - this.rateSampledAtMs;
    this.rateSampledAtMs = now;
    if (dt <= 0 || dt > PAUSE_GAP_MS) return;
    const instant = (advanced * 1000) / dt;
    this.tickRate = this.tickRate * 0.75 + instant * 0.25;
  }

  private catchingUp(): boolean {
    return this.tickRate > CATCHUP_TICKS_PER_SECOND;
  }

  /**
   * Diff the live nuke set against what we saw last tick.
   *
   * SUSPENDED DURING A SEEK, and the gate matters because the read is not
   * cheap: `GameView.units()` has no index to answer from, so it does
   * `Array.from(this._units.values()).filter(...)` — two arrays the size of
   * every unit on the board, per call. This layer polls once per tick on
   * purpose (see `tick`), and a forward seek drives ticks at ~1,400 a second,
   * so the poll was allocating those two arrays 1,400 times a second for
   * frames nobody sees. Nothing it computed could reach the screen either: a
   * cinema cannot start (`onLaunch` returns on `catchingUp`), an impact cannot
   * be recorded (`onImpact` likewise), and a cinema already running is torn
   * down by `advance()` on the same tick.
   *
   * What the poll still owes is a truthful `tracked` set on the FAR side of the
   * seek, so the first real strike after it is read correctly. Resuming a plain
   * diff would pay that debt in exactly the wrong currency: every warhead that
   * died during the seek would surface as an impact and paint a cloud over
   * ground the viewer skipped past, and every warhead that launched during it
   * would surface as a launch and steal the frame for a flight that is nearly
   * over. So the first poll after a seek runs SILENT — it adopts what is in the
   * air and forgets what is not, without narrating either, which is precisely
   * the state the old ungated diff left behind (its launches and impacts were
   * swallowed by the same `catchingUp` guards).
   */
  private pollNukes(now: number) {
    if (this.catchingUp()) {
      this.pollSuspended = true;
      return;
    }
    const live = this.game.units(...Nukes.types);
    const silent = this.pollSuspended;
    this.pollSuspended = false;
    const seen = new Set<number>();
    const launched: TrackedNuke[] = [];

    for (const unit of live) {
      seen.add(unit.id());
      const existing = this.tracked.get(unit.id());
      if (existing === undefined) {
        const born = this.describe(unit, now);
        this.tracked.set(unit.id(), born);
        if (!silent) launched.push(born);
      } else {
        // Keep the flight position fresh; the flash is staged wherever the
        // warhead was last seen, which is the impact point.
        existing.lastX = this.game.x(unit.lastTile());
        existing.lastY = this.game.y(unit.lastTile());
        this.sampleFlight(existing, now);
      }
    }

    for (const [id, nuke] of [...this.tracked]) {
      if (seen.has(id)) continue;
      this.tracked.delete(id);
      if (!silent) this.onImpact(nuke, now);
    }

    if (launched.length > 0) this.onLaunch(launched, now);
    this.maybePunchIn(now);
  }

  /** Refresh distance-to-target and the smoothed closing speed. */
  private sampleFlight(nuke: TrackedNuke, now: number) {
    if (nuke.targetTile === null) return;
    const dt = now - nuke.lastSampleMs;
    if (dt <= 0) return;
    const distance = this.distanceToTarget(nuke, nuke.lastX, nuke.lastY);
    const closed = nuke.distance - distance;
    if (closed > 0) {
      const instant = closed / dt;
      // Light EMA: enough to stop the readout flickering, light enough that a
      // speed change (or a scrub to a different rate) is picked up in a beat.
      nuke.speed =
        nuke.speed === 0 ? instant : nuke.speed * 0.7 + instant * 0.3;
    }
    nuke.distance = distance;
    nuke.lastSampleMs = now;
  }

  private distanceToTarget(nuke: TrackedNuke, x: number, y: number): number {
    if (nuke.targetTile === null) return 0;
    const dx = this.game.x(nuke.targetTile) - x;
    const dy = this.game.y(nuke.targetTile) - y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** How much of the primary warhead's flight is behind it, 0..1. */
  private flightProgress(nuke: TrackedNuke): number {
    if (nuke.launchDistance <= 0) return 1;
    return Math.min(1, Math.max(0, 1 - nuke.distance / nuke.launchDistance));
  }

  /** Seconds to impact from measured speed, or null while it is unknowable. */
  private eta(nuke: TrackedNuke): number | null {
    if (nuke.speed <= 0) return null;
    return nuke.distance / nuke.speed / 1000;
  }

  /** Snapshot everything the impact beat will need, while the unit still exists. */
  private describe(unit: UnitView, now: number): TrackedNuke {
    const targetTile = unit.targetTile() ?? null;
    const target = targetTile === null ? null : this.game.owner(targetTile);
    return {
      id: unit.id(),
      type: unit.type(),
      targetTile,
      originX: this.game.x(unit.lastTile()),
      originY: this.game.y(unit.lastTile()),
      ownerName: displayNameOf(unit.owner().displayName()),
      targetName:
        target !== null && target.isPlayer()
          ? displayNameOf(target.displayName())
          : null,
      ownerSmallId: unit.owner().smallID(),
      targetSmallId:
        target !== null && target.isPlayer() ? target.smallID() : null,
      lastX: this.game.x(unit.lastTile()),
      lastY: this.game.y(unit.lastTile()),
      seenAtMs: now,
      launchDistance: launchDistance(this.game, unit, targetTile),
      distance: launchDistance(this.game, unit, targetTile),
      speed: 0,
      lastSampleMs: now,
    };
  }

  private onLaunch(launched: TrackedNuke[], now: number) {
    if (this.cinema !== null) return; // one cinema at a time
    if (now - this.lastCinemaEndedMs < COOLDOWN_MS) return;
    if (this.catchingUp()) return;

    // The salvo speaks with the biggest warhead's voice.
    const primary = launched.reduce((a, b) =>
      (WARHEAD_RADIUS[b.type] ?? 0) > (WARHEAD_RADIUS[a.type] ?? 0) ? b : a,
    );

    this.cinema = {
      beat: "flight",
      beatStartedMs: now,
      startedMs: now,
      nukes: launched,
      primary,
      restore: null,
      punchedIn: false,
    };
    this.anyDetonated = false;
    this.setStageClaimed(true);
  }

  /** Cut to the target only on the warhead's final approach — see the const. */
  private maybePunchIn(now: number) {
    const cinema = this.cinema;
    if (cinema === null || cinema.punchedIn || cinema.beat !== "flight") return;
    if (!this.tracked.has(cinema.primary.id)) return;
    if (this.flightProgress(cinema.primary) < PUNCH_IN_PROGRESS) return;
    this.punchIn(cinema.primary, now);
  }

  private onImpact(nuke: TrackedNuke, now: number) {
    const cinema = this.cinema;
    const radius = WARHEAD_RADIUS[nuke.type] ?? 70;

    // A UNIT VANISHING IS NOT A DETONATION. Three engine paths delete a nuke
    // mid-air, and the first version rendered every one of them as a strike:
    //
    //  - A MIRV parent flies to a SEPARATION point ~450 tiles north of its
    //    target and deletes itself there (MIRVExecution: separateDst, then
    //    nuke.delete(false)) — the warheads carry on. We drew a hydrogen-scale
    //    detonation over ground nothing hit, every MIRV launch.
    //  - A SAM interception deletes the warhead at the intercept point
    //    (SAMMissileExecution: target.delete(true)). We announced DETONATION
    //    for a bomb that was SHOT DOWN — the opposite of the truth.
    //  - Only a warhead that actually reached its target detonated.
    //
    // The discriminator is DISTANCE TO TARGET at last sighting, which we
    // already track for the ETA. Generous threshold: detonation logic runs on
    // proximity in-engine, so anything inside ~1.1 blast radii is a hit.
    const separated = nuke.type === UnitType.MIRV;
    const remaining =
      nuke.targetTile === null
        ? Infinity
        : this.distanceToTarget(nuke, nuke.lastX, nuke.lastY);
    const detonated = !separated && remaining <= radius * 1.1 + 6;

    // Catch-up: strikes crossed at seek speed are history, not news — a fresh
    // 12s cordon for a nuke that landed four thousand turns ago reads as a
    // strike the viewer just missed. (Launch/advance were already gated; this
    // path was not.)
    if (detonated && !this.catchingUp()) {
      this.impacts.push({
        x: nuke.lastX,
        y: nuke.lastY,
        radius,
        atMs: now,
        seed: nuke.lastX * 0.37 + nuke.lastY * 0.71 + nuke.id,
        raster: null,
        wash: null,
      });
      // A MIRV salvo is 350 of these on one tick — see MAX_IMPACTS for the
      // measurement and for why the oldest go rather than the newest.
      if (this.impacts.length > MAX_IMPACTS) {
        this.impacts.splice(0, this.impacts.length - MAX_IMPACTS);
      }
    }

    // A warhead the running cinema does not speak for still gets its cloud and
    // its rings above; it just does not drive the beat machine.
    if (cinema === null || !cinema.nukes.some((n) => n.id === nuke.id)) return;

    if (detonated) this.anyDetonated = true;
    const stillFlying = cinema.nukes.some((n) => this.tracked.has(n.id));

    if (separated) {
      // The parent splitting is not this cinema's ending — the warheads it
      // released will register as fresh launches and claim their own cinema
      // once this one stands down. End it now rather than flipping to a
      // detonation the sky has not produced.
      if (!stillFlying) this.endCinema(now);
      return;
    }

    if (!detonated) cinema.intercepted = true;
    if (stillFlying) return;

    if (cinema.intercepted && !this.anyDetonated) {
      // Every warhead this cinema spoke for was shot down: no flash, no
      // cloud — the drama is the SAVE, and the alert says so.
      this.setBeat("aftermath", now);
      return;
    }
    this.setBeat("flash", now);
    this.triggerFlash(nuke.type);
  }

  /** Drive the beat machine off wall-clock time. */
  private advance(now: number) {
    const cinema = this.cinema;
    if (cinema === null) return;

    // A seek started mid-cinema (the viewer scrubbed forward while a warhead
    // was up). The beat it was describing is no longer the frame; drop it and
    // give the camera back rather than narrate a strike that has already
    // scrolled into history.
    if (this.catchingUp()) {
      this.endCinema(now);
      return;
    }

    const elapsed = now - cinema.beatStartedMs;
    switch (cinema.beat) {
      case "flight":
        if (now - cinema.startedMs > MAX_FLIGHT_MS) this.endCinema(now);
        break;
      case "flash":
        if (elapsed > FLASH_MS) this.setBeat("aftermath", now);
        break;
      case "aftermath":
        if (elapsed > AFTERMATH_MS) {
          this.setBeat("outro", now);
          this.restoreCamera();
        }
        break;
      case "outro":
        if (elapsed > ALERT_OUTRO_MS) this.endCinema(now);
        break;
    }
  }

  /**
   * Claim the frame for the duration of a cinema.
   *
   * Measured on the real board: the war-room rail is a 300px panel sitting
   * OVER the right 23% of a 1280 frame, and the strike that prompted this fix
   * detonated at (1196, 61) — dead behind it. The camera cannot fix that. A
   * target near the map's edge cannot be centred at any zoom without showing
   * background, so the clamp parks it in the corner, which is exactly where
   * the rail is.
   *
   * The end card already established the precedent: when one thing IS the
   * story, the standing chrome gets out of its way (`body.pw-endcard-open`).
   * A warhead in the air has the same claim, for about six seconds. The rail
   * is dimmed rather than hidden — the beat log stays legible enough to keep
   * its place, and the board underneath becomes readable. Standings are left
   * alone: they stay true during a strike and a viewer still wants them.
   */
  private setStageClaimed(claimed: boolean) {
    document.body.classList.toggle("pw-nuke-active", claimed);
  }

  private setBeat(beat: Beat, now: number) {
    if (this.cinema === null) return;
    this.cinema.beat = beat;
    this.cinema.beatStartedMs = now;
  }

  private endCinema(now: number) {
    this.restoreCamera();
    this.cinema = null;
    this.lastCinemaEndedMs = now;
    this.setStageClaimed(false);
  }

  // ---------------------------------------------------------------- camera

  /**
   * Whether this strike is the followed competitor's business — they either
   * launched it or are about to be hit by it. A viewer following one nation
   * does not want the camera leaving to cover a duel between two others; that
   * is the same "don't disturb my view" complaint, one step removed.
   */
  private involvesFollowed(cinema: Cinema): boolean {
    const followed = followedCompetitorSmallId();
    if (followed === null) return false;
    return cinema.nukes.some(
      (n) => n.ownerSmallId === followed || n.targetSmallId === followed,
    );
  }

  private punchIn(primary: TrackedNuke, _now: number) {
    const cinema = this.cinema;
    if (cinema === null) return;
    cinema.punchedIn = true;
    if (primary.targetTile === null) return;
    if (window.innerWidth < MIN_PUNCH_IN_WIDTH) return;
    // THE CAMERA IS OPT-IN. With nobody followed the board stays exactly where
    // the viewer left it — the alert, the arc, the reticle and the cloud carry
    // the beat on their own. See FollowedCompetitor for the whole argument.
    if (!this.involvesFollowed(cinema)) return;

    const center = this.transformHandler.screenCenter();
    cinema.restore = {
      x: center.screenX,
      y: center.screenY,
      scale: this.transformHandler.scale,
      intentEpoch: this.transformHandler.userCameraIntentEpoch(),
    };

    const tx = this.game.x(primary.targetTile);
    const ty = this.game.y(primary.targetTile);
    this.eventBus.emit(
      new GoToPositionEvent(
        tx,
        ty,
        this.transformHandler.scale * PUNCH_IN_ZOOM,
      ),
    );
  }

  private restoreCamera() {
    const restore = this.cinema?.restore;
    if (restore === undefined || restore === null) return;
    if (this.cinema !== null) this.cinema.restore = null;
    // A drag, zoom, or competitor locate after the punch-in is the viewer's
    // new camera choice. Never let an old cinematic snapshot overwrite it.
    if (restore.intentEpoch !== this.transformHandler.userCameraIntentEpoch()) {
      return;
    }
    this.eventBus.emit(
      new GoToPositionEvent(restore.x, restore.y, restore.scale),
    );
  }

  // ------------------------------------------------------------------ DOM

  private triggerFlash(type: UnitType) {
    const flash = this.flash;
    if (flash === null) return;
    const big = (WARHEAD_RADIUS[type] ?? 70) >= 160;
    flash.classList.remove("is-firing", "is-big");
    // Force a reflow so the animation restarts on a back-to-back salvo.
    void flash.offsetWidth;
    flash.classList.add("is-firing");
    if (big) flash.classList.add("is-big");
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      flash.classList.remove("is-firing", "is-big");
      this.flashTimer = null;
    }, FLASH_MS);
  }

  private renderAlert() {
    const plate = this.plate;
    if (plate === null) return;
    const cinema = this.cinema;

    if (cinema === null) {
      if (plate.dataset.state !== "idle") {
        plate.dataset.state = "idle";
        // The key must go with the content: if a later cinema's first key
        // happens to equal this one's last, the early-return below would skip
        // the repopulate and the plate would stay empty and display:none for
        // the whole alert.
        plate.dataset.key = "";
        plate.replaceChildren();
      }
      return;
    }

    const impacted = cinema.beat !== "flight";
    const state = impacted ? "impact" : "flight";
    const count = cinema.nukes.length;
    const warheadDefault = WARHEAD_LABEL[cinema.primary.type] ?? "WARHEAD";
    const warhead = translateText(
      `ai_league_replay.warhead_${warheadDefault.toLowerCase()}`,
      undefined,
      warheadDefault,
    );
    // A shot-down warhead must never be announced as a detonation — the SAM
    // save is its own story and the broadcast tells it as one.
    const shotDown = cinema.intercepted === true && !this.anyDetonated;
    const headline = impacted
      ? shotDown
        ? count > 1
          ? translateText(
              "ai_league_replay.warheads_intercepted",
              { count },
              `${count.toLocaleString()} WARHEADS INTERCEPTED`,
            )
          : translateText(
              "ai_league_replay.intercepted",
              undefined,
              "INTERCEPTED",
            )
        : count > 1
          ? translateText(
              "ai_league_replay.detonations",
              { count },
              `${count.toLocaleString()} DETONATIONS`,
            )
          : translateText(
              "ai_league_replay.detonation",
              undefined,
              "DETONATION",
            )
      : count > 1
        ? translateText(
            "ai_league_replay.nuclear_launch_multiple",
            { count },
            `NUCLEAR LAUNCH — ${count.toLocaleString()} WARHEADS`,
          )
        : translateText(
            "ai_league_replay.nuclear_launch",
            undefined,
            "NUCLEAR LAUNCH",
          );
    const from =
      cinema.primary.ownerName ||
      translateText("ai_league_replay.unknown", undefined, "UNKNOWN");
    const onto = cinema.primary.targetName;
    const line =
      onto === null
        ? translateText(
            "ai_league_replay.nuke_target_unclaimed",
            { actor: from },
            `${from} → unclaimed ground`,
          )
        : translateText(
            "ai_league_replay.nuke_target",
            { actor: from, target: onto },
            `${from} → ${onto}`,
          );

    // Time to impact, not time since launch: a stopwatch counting up tells the
    // viewer nothing they want to know. Rounded to whole seconds because the
    // tenths were pure churn at this speed — and shown only once the measured
    // speed makes it real.
    const secondsOut = this.eta(cinema.primary);
    const readout = impacted
      ? shotDown
        ? translateText(
            "ai_league_replay.no_detonation",
            undefined,
            "NO DETONATION",
          )
        : translateText("ai_league_replay.impact", undefined, "IMPACT")
      : secondsOut === null
        ? translateText("ai_league_replay.in_flight", undefined, "IN FLIGHT")
        : translateText(
            "ai_league_replay.time_to_impact",
            { seconds: Math.max(0, Math.round(secondsOut)) },
            `T-${Math.max(0, Math.round(secondsOut))}s`,
          );
    const key = `${state}|${headline}|${line}|${warhead}|${readout}`;

    if (plate.dataset.key === key) return;
    plate.dataset.key = key;
    plate.dataset.state = state;

    const kind = document.createElement("span");
    kind.className = "pw-nuke-kind";
    kind.textContent = warhead;

    const head = document.createElement("span");
    head.className = "pw-nuke-head";
    head.textContent = headline;

    const timer = document.createElement("span");
    timer.className = "pw-nuke-timer";
    timer.textContent = readout;

    // The two names are the payload of the whole alert; they get their own
    // line so neither can ever be the thing that gets clipped.
    const who = document.createElement("span");
    who.className = "pw-nuke-who";
    who.textContent = line;

    plate.replaceChildren(kind, head, timer, who);
  }

  // --------------------------------------------------------------- canvas

  shouldTransform(): boolean {
    return true;
  }

  /**
   * World-space marks: the launch arc, the target reticle, and the shockwave.
   *
   * Under `handleTransform` the canvas origin sits at the map's centre, so a
   * tile at world (x, y) draws at (x - width/2, y - height/2) — the same
   * convention `SAMRadiusLayer` uses. Line widths are divided by the camera
   * scale so strokes stay a constant thickness on screen at any zoom.
   */
  renderLayer(context: CanvasRenderingContext2D) {
    const cinema = this.cinema;
    if (cinema === null && this.impacts.length === 0) return;

    // The layer's clock, not the wall clock. Rendering keeps running while the
    // replay is paused (rAF never stops), but ticking does not — so reading
    // performance.now() here would age the shockwave out from under a plate
    // that is still frozen on DETONATION. One clock for the whole layer means
    // a paused broadcast holds a coherent frame.
    const now = this.lastTickMs;
    const ox = -this.game.width() / 2;
    const oy = -this.game.height() / 2;
    const px = 1 / Math.max(this.transformHandler.scale, 0.0001);

    context.save();
    context.lineCap = "round";

    if (cinema !== null && cinema.beat === "flight") {
      for (const nuke of cinema.nukes) {
        if (!this.tracked.has(nuke.id)) continue;
        this.drawFlight(context, nuke, now, ox, oy, px);
      }
    }

    // Cordon first — it is the ground everything else sits on.
    for (const impact of this.impacts) {
      this.drawContaminationZone(context, impact, now, ox, oy, px);
    }
    for (const impact of this.impacts) {
      this.drawShockwave(context, impact, now, ox, oy, px);
    }
    // Clouds last, and over every ring: the column is the foreground object in
    // the shot and nothing should draw through it.
    for (const impact of this.impacts) {
      this.drawMushroomCloud(context, impact, now, ox, oy);
    }

    context.restore();
  }

  /**
   * The column. A mushroom cloud is a SIDE-ON object and this is a top-down
   * board, so this is drawn as a billboard: it rises up the screen from the
   * impact point regardless of camera, the way a game sprite would. Nobody
   * reads it as a claim about the map's geometry; they read it as "a nuke went
   * off there", which is the entire job.
   *
   * WHY IT IS RASTERISED INSTEAD OF DRAWN WITH GRADIENTS
   * ----------------------------------------------------
   * The first version used smooth canvas gradients and a clean elliptical cap,
   * and it read as a cartoon sticker pasted on the board — Maxwell's note, and
   * obvious once seen. The cause is texture, not shape: this map is PIXEL ART
   * rendered with `imageSmoothingEnabled = false`, so every other thing on
   * screen has a hard-edged, quantised, noisy grain, and a buttery vector
   * gradient is the one object in frame that does not belong to it.
   *
   * So the cloud is built the way the map is: a density field sampled onto a
   * coarse grid, quantised to a five-step palette, dithered at its edges with
   * an ordered matrix, and blitted up with smoothing off so it lands as hard
   * pixels. Its silhouette comes from ~20 overlapping billows rather than an
   * ellipse, because the geometric perfection was the other half of the
   * cartoon read.
   *
   * The palette is also corrected: r40 pushed the whole column to hot orange,
   * which both looks like a cartoon fireball and breaks the stage's rule that
   * the sixteen seat colours are the only saturated things on it. A real
   * column is overwhelmingly ash — the heat is a small thing at the bottom,
   * and it dies quickly.
   *
   * Cost is controlled by caching: the raster is rebuilt only when the
   * animation step changes (`CLOUD_STEPS` over its life, ~12/s), not per
   * frame, and each rebuild only visits the cells its own billows cover.
   */
  private drawMushroomCloud(
    context: CanvasRenderingContext2D,
    impact: Impact,
    now: number,
    ox: number,
    oy: number,
  ) {
    const age = (now - impact.atMs) / CLOUD_LIFE_MS;
    if (age < 0 || age > 1) return;

    const step = Math.min(
      CLOUD_STEPS - 1,
      Math.max(0, Math.floor(age * CLOUD_STEPS)),
    );
    if (impact.raster === null || impact.raster.step !== step) {
      const built = buildCloudRaster(impact, (step + 0.5) / CLOUD_STEPS);
      if (built !== null) built.step = step;
      impact.raster = built;
    }
    const raster = impact.raster;
    if (raster === null) return;

    context.drawImage(
      raster.canvas,
      impact.x + ox + raster.originX,
      impact.y + oy + raster.originY,
      raster.width,
      raster.height,
    );
  }

  private drawFlight(
    context: CanvasRenderingContext2D,
    nuke: TrackedNuke,
    now: number,
    ox: number,
    oy: number,
    px: number,
  ) {
    if (nuke.targetTile === null) return;
    const tx = this.game.x(nuke.targetTile) + ox;
    const ty = this.game.y(nuke.targetTile) + oy;
    const phase = (now / 1000) % 1;

    // The lane the warhead is travelling: origin to target, marching dashes.
    context.setLineDash([6 * px, 7 * px]);
    context.lineDashOffset = -phase * 13 * px;
    context.lineWidth = 1.2 * px;
    context.strokeStyle = "rgba(255, 107, 74, 0.5)";
    context.beginPath();
    context.moveTo(nuke.originX + ox, nuke.originY + oy);
    context.lineTo(tx, ty);
    context.stroke();
    context.setLineDash([]);

    // Reticle: a ring that closes as the warhead falls, plus fixed corner
    // ticks so the mark still reads when the ring is at its smallest.
    const radius = WARHEAD_RADIUS[nuke.type] ?? 70;
    const closing = radius * (1.55 - 0.55 * phase);
    context.lineWidth = 1.6 * px;
    context.strokeStyle = "rgba(255, 107, 74, 0.85)";
    context.beginPath();
    context.arc(tx, ty, closing, 0, Math.PI * 2);
    context.stroke();

    context.lineWidth = 1.4 * px;
    context.strokeStyle = "rgba(255, 107, 74, 0.95)";
    const tick = radius * 0.32;
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      context.beginPath();
      context.moveTo(tx + dx * radius * 0.55, ty + dy * radius * 0.55);
      context.lineTo(
        tx + dx * (radius * 0.55 + tick),
        ty + dy * (radius * 0.55 + tick),
      );
      context.stroke();
    }
  }

  private drawShockwave(
    context: CanvasRenderingContext2D,
    impact: Impact,
    now: number,
    ox: number,
    oy: number,
    px: number,
  ) {
    const age = (now - impact.atMs) / (FLASH_MS + AFTERMATH_MS);
    if (age < 0 || age > 1) return;
    const eased = 1 - Math.pow(1 - age, 2.2);
    const x = impact.x + ox;
    const y = impact.y + oy;

    // Leading ring — expands past the blast and thins out as it goes.
    context.lineWidth = Math.max(0.6, 3.2 * (1 - eased)) * px;
    context.strokeStyle = `rgba(255, 107, 74, ${(1 - eased) * 0.9})`;
    context.beginPath();
    context.arc(x, y, impact.radius * (0.35 + 1.5 * eased), 0, Math.PI * 2);
    context.stroke();
  }

  /**
   * CONTAMINATED GROUND — the cordon around a blast. See ZONE_LIFE_MS for why
   * this is drawn at all rather than left to the engine's fallout tiles.
   *
   * Everything here says "exclusion zone" rather than "explosion": a hot wash
   * that seethes slowly instead of a static tint, a boundary at the true blast
   * radius, a counter-rotating inner ring so the mark is visibly ALIVE, and
   * hazard ticks pointing inward at the ground being cordoned off.
   */
  private drawContaminationZone(
    context: CanvasRenderingContext2D,
    impact: Impact,
    now: number,
    ox: number,
    oy: number,
    px: number,
  ) {
    const life = (now - impact.atMs) / ZONE_LIFE_MS;
    if (life < 0 || life > 1) return;

    const x = impact.x + ox;
    const y = impact.y + oy;
    const r = impact.radius;

    // In over the first beat, hold, then out over the last third — the zone
    // should never blink out from under a viewer who is looking at it.
    const settle = Math.min(1, life / 0.06);
    const fade = life < 0.66 ? 1 : 1 - (life - 0.66) / 0.34;
    // A slow breath, so contaminated ground reads as ACTIVE, not as a decal.
    const seethe = 0.82 + 0.18 * Math.sin((now / 1000) * 1.9);
    const alpha = settle * fade;

    context.save();

    // Hot wash over the poisoned ground.
    const wash = context.createRadialGradient(x, y, 0, x, y, r);
    wash.addColorStop(0, `rgba(255, 138, 82, ${0.14 * alpha * seethe})`);
    wash.addColorStop(0.62, `rgba(255, 107, 74, ${0.08 * alpha * seethe})`);
    wash.addColorStop(1, "rgba(255, 107, 74, 0)");
    context.fillStyle = wash;
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fill();

    // The cordon itself, and an inner ring marching the other way.
    const spin = (now / 1000) % 60;
    context.lineCap = "butt";
    context.strokeStyle = `rgba(255, 128, 82, ${0.7 * alpha})`;
    context.lineWidth = 1.4 * px;
    context.setLineDash([7 * px, 5 * px]);
    context.lineDashOffset = -spin * 9 * px;
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.stroke();

    context.setLineDash([]);

    // Hazard ticks, pointing in at the ground nobody should stand on.
    context.strokeStyle = `rgba(255, 150, 96, ${0.5 * alpha})`;
    context.lineWidth = 1.3 * px;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + spin * 0.16;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      context.beginPath();
      context.moveTo(x + cos * r, y + sin * r);
      context.lineTo(x + cos * (r - r * 0.13), y + sin * (r - r * 0.13));
      context.stroke();
    }

    context.restore();
  }

  // --------------------------------------------------------------- teardown

  /** Removes every DOM, timer and body-level claim owned by this game. */
  dispose() {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.tracked.clear();
    this.impacts = [];
    this.cinema = null;
    this.setStageClaimed(false);
    this.root?.remove();
    this.root = null;
    this.plate = null;
    this.flash = null;
  }

  private reset() {
    this.tracked.clear();
    this.impacts = [];
    if (this.cinema !== null) this.restoreCamera();
    this.cinema = null;
    this.lastCinemaEndedMs = 0;
    this.setStageClaimed(false);
    if (this.plate !== null) {
      this.plate.dataset.state = "idle";
      this.plate.dataset.key = "";
      this.plate.replaceChildren();
    }
    if (this.flash !== null) this.flash.classList.remove("is-firing", "is-big");
  }
}

/**
 * ---------------------------------------------------------------------------
 * CLOUD RASTERISER
 * ---------------------------------------------------------------------------
 * See `NukeCinema.drawMushroomCloud` for why the cloud is pixels rather than
 * gradients. This builds one animation step of one cloud into a small offscreen
 * canvas, one raster pixel per CLOUD_CELL world units, which the caller then
 * blits up at the map's own scale with smoothing off.
 */

/** World units per raster pixel. Tuned to sit close to the terrain's grain. */
const CLOUD_CELL = 2.4;
/** Animation steps across a cloud's life — about 12 a second. */
const CLOUD_STEPS = 50;
/** Hard cap on raster dimensions, so a huge warhead cannot blow up the cost. */
const CLOUD_MAX_PX = 190;

/**
 * Ordered dither. Real smoke has no outline; quantising a soft density field
 * without this gives every billow a hard circular rim, which is precisely the
 * "sticker" look. Breaking the threshold up per pixel turns those rims into
 * stipple, which is also how the terrain's own edges behave.
 */
const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (v) => (v + 0.5) / 16,
);

/**
 * Ash, warm and dark, from shadowed underside to lit crown. Deliberately
 * desaturated: on this stage the sixteen seat colours are the only saturated
 * things, and a column of smoke is not a competitor.
 */
const CLOUD_ASH: [number, number, number][] = [
  [44, 33, 27],
  [71, 52, 40],
  [103, 76, 57],
  [136, 103, 76],
  [168, 132, 99],
];

/** The same ramp with the fireball's light in it, mixed in only near the base. */
const CLOUD_EMBER: [number, number, number][] = [
  [104, 46, 34],
  [158, 68, 42],
  [206, 100, 54],
  [238, 146, 80],
  [255, 198, 138],
];

interface Puff {
  x: number;
  y: number;
  r: number;
}

/** Deterministic per-blast noise: same blast, same shape, every playback. */
function cloudNoise(seed: number, i: number): number {
  const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function buildCloudPuffs(radius: number, seed: number, age: number): Puff[] {
  const rise = Math.min(1, Math.pow(age / CLOUD_RISE_FRACTION, 0.62));
  // After the rise the column keeps growing and softening as it disperses.
  const spread =
    age <= CLOUD_RISE_FRACTION
      ? 0
      : (age - CLOUD_RISE_FRACTION) / (1 - CLOUD_RISE_FRACTION);
  const puffs: Puff[] = [];

  // A mushroom is a NARROW stem under a WIDE, FLAT cap. The first pixel pass
  // had them nearly the same width and read as an ordinary smoke plume, so the
  // proportions are now deliberately exaggerated.
  const stemH = radius * 2.05 * rise;
  const stemR = radius * 0.16 * (0.7 + 0.3 * rise) * (1 + 0.5 * spread);
  // A slight lean, because a perfectly vertical column reads as geometry.
  const lean = radius * 0.1 * (cloudNoise(seed, 0) - 0.5);

  // STEM — billows up the column, fattening as they disperse.
  // Eleven, not seven: at seven the billows stopped overlapping and the column
  // rendered as a broken trail of blobs with sky between them.
  for (let i = 0; i <= 11; i++) {
    const t = i / 11;
    const wobble = (cloudNoise(seed, i + 1) - 0.5) * stemR * 1.3;
    puffs.push({
      x: lean * t + wobble,
      y: -stemH * t,
      r: stemR * (1.35 - 0.42 * t) * (0.85 + 0.3 * cloudNoise(seed, i + 20)),
    });
  }

  // CAP — a ring of billows plus a core, so the dome has a lumpy silhouette.
  const capR = radius * 0.95 * rise * (1 + 0.42 * spread);
  const capY = -stemH - capR * 0.2;
  if (capR > 1) {
    puffs.push({ x: lean, y: capY, r: capR * 0.42 });
    // Crown: overlapping billows on a shallow ring. They must OVERLAP — spread
    // them out and the gaps between them dither away, leaving a scattered
    // cluster instead of a cap.
    const ring = 13;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      const jitter = 0.84 + 0.32 * cloudNoise(seed, i + 40);
      puffs.push({
        x: lean + Math.cos(a) * capR * 0.8 * jitter,
        y: capY + Math.sin(a) * capR * 0.13 * jitter,
        r: capR * 0.38 * (0.78 + 0.4 * cloudNoise(seed, i + 60)),
      });
    }
    // The overhanging lip under the cap — the single feature that separates a
    // mushroom cloud from any other column of smoke.
    for (let i = 0; i < 6; i++) {
      const t = (i / 5) * 2 - 1;
      puffs.push({
        x: lean + t * capR * 0.78,
        y: capY + capR * 0.34 * (0.8 + 0.4 * cloudNoise(seed, i + 120)),
        r: capR * 0.19 * (0.7 + 0.5 * cloudNoise(seed, i + 130)),
      });
    }
  }

  // SKIRT — debris pushed out along the ground, low and wide.
  const skirt = radius * (0.4 + 0.55 * rise);
  for (let i = 0; i < 5; i++) {
    const t = (i / 4) * 2 - 1;
    puffs.push({
      x: t * skirt * (0.75 + 0.35 * cloudNoise(seed, i + 80)),
      y: -radius * 0.06 * cloudNoise(seed, i + 90),
      r: radius * 0.17 * (0.7 + 0.6 * cloudNoise(seed, i + 100)),
    });
  }

  return puffs;
}

function buildCloudRaster(impact: Impact, age: number): CloudRaster | null {
  const puffs = buildCloudPuffs(impact.radius, impact.seed, age);
  if (puffs.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of puffs) {
    if (p.r <= 0) continue;
    minX = Math.min(minX, p.x - p.r);
    maxX = Math.max(maxX, p.x + p.r);
    minY = Math.min(minY, p.y - p.r);
    maxY = Math.max(maxY, p.y + p.r);
  }
  if (!Number.isFinite(minX)) return null;

  const cols = Math.min(
    CLOUD_MAX_PX,
    Math.ceil((maxX - minX) / CLOUD_CELL) + 2,
  );
  const rows = Math.min(
    CLOUD_MAX_PX,
    Math.ceil((maxY - minY) / CLOUD_CELL) + 2,
  );
  if (cols <= 0 || rows <= 0) return null;

  // Density field. Only the cells a billow actually covers are visited, so the
  // cost tracks the cloud's area rather than the bounding box.
  const density = new Float32Array(cols * rows);
  for (const p of puffs) {
    if (p.r <= 0) continue;
    const c0 = Math.max(0, Math.floor((p.x - p.r - minX) / CLOUD_CELL));
    const c1 = Math.min(cols - 1, Math.ceil((p.x + p.r - minX) / CLOUD_CELL));
    const r0 = Math.max(0, Math.floor((p.y - p.r - minY) / CLOUD_CELL));
    const r1 = Math.min(rows - 1, Math.ceil((p.y + p.r - minY) / CLOUD_CELL));
    const inv = 1 / p.r;
    for (let ry = r0; ry <= r1; ry++) {
      const wy = minY + ry * CLOUD_CELL - p.y;
      for (let cx = c0; cx <= c1; cx++) {
        const wx = minX + cx * CLOUD_CELL - p.x;
        const d = Math.sqrt(wx * wx + wy * wy) * inv;
        if (d >= 1) continue;
        const falloff = 1 - d;
        density[ry * cols + cx] += falloff * falloff;
      }
    }
  }

  const fade =
    age < CLOUD_RISE_FRACTION
      ? Math.min(1, age / 0.06)
      : 1 - (age - CLOUD_RISE_FRACTION) / (1 - CLOUD_RISE_FRACTION);
  // Heat lives at the bottom of the column and dies fast — the flash is the
  // flash, and the rest of a real column is smoke.
  const heat = Math.max(0, 1 - age / 0.46);

  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const img = ctx.createImageData(cols, rows);
  const data = img.data;

  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = ry * cols + cx;
      const d = density[idx];
      if (d <= 0) continue;

      const dither = BAYER_4[(ry & 3) * 4 + (cx & 3)];
      // Below the dithered threshold the pixel is simply not smoke.
      if (d < 0.13 + (dither - 0.5) * 0.18) continue;

      // Lit from beneath by the fireball: brightness falls off with height
      // above the ground and with distance from the column's core.
      const worldY = minY + ry * CLOUD_CELL;
      const worldX = minX + cx * CLOUD_CELL;
      const height = Math.min(1, -worldY / Math.max(1, impact.radius * 2.1));
      const light =
        (1 - height * 0.88) *
        (1 -
          Math.min(1, Math.abs(worldX) / Math.max(1, impact.radius * 1.5)) *
            0.3);

      // Light carries the shading and density only shapes the edges. The first
      // pass summed a constant, the light AND the density, which saturated:
      // almost every pixel landed in the top band and the whole column came out
      // a flat pale grey with no form in it at all.
      // Per-pixel grain. Without it the cap is a flat field of one tone; the
      // terrain it sits on is noisy, so the smoke has to be too.
      const grain = cloudNoise(impact.seed, cx * 131 + ry * 17) * 0.18 - 0.09;
      const shade = light * 0.72 + Math.min(1, d) * 0.24 + grain;
      let band = Math.floor(shade * CLOUD_ASH.length);
      band = Math.max(0, Math.min(CLOUD_ASH.length - 1, band));

      // Ember only near the ground, only early.
      const emberMix = Math.max(0, heat * (1 - height * 1.6));
      const ash = CLOUD_ASH[band];
      const ember = CLOUD_EMBER[band];
      const o = idx * 4;
      data[o] = ash[0] + (ember[0] - ash[0]) * emberMix;
      data[o + 1] = ash[1] + (ember[1] - ash[1]) * emberMix;
      data[o + 2] = ash[2] + (ember[2] - ash[2]) * emberMix;
      data[o + 3] = Math.min(1, d * 1.9) * fade * 232;
    }
  }

  ctx.putImageData(img, 0, 0);
  return {
    canvas,
    step: -1,
    originX: minX,
    originY: minY,
    width: cols * CLOUD_CELL,
    height: rows * CLOUD_CELL,
  };
}

function launchDistance(
  game: GameView,
  unit: UnitView,
  targetTile: TileRef | null,
): number {
  if (targetTile === null) return 0;
  const dx = game.x(targetTile) - game.x(unit.lastTile());
  const dy = game.y(targetTile) - game.y(unit.lastTile());
  return Math.sqrt(dx * dx + dy * dy);
}

function displayNameOf(raw: string): string {
  if (raw === "") return "";
  return aiLeagueSpectatorDisplayName(raw).toUpperCase();
}

let stylesMounted = false;

function mountNukeCinemaStyles() {
  if (stylesMounted) return;
  stylesMounted = true;
  const style = document.createElement("style");
  style.id = "pw-nuke-cinema-styles";
  style.textContent = `
    .pw-nuke-cinema {
      position: fixed;
      inset: 0;
      /* Under the end card (50040) — a result outranks a beat — and over the
       * board and its chrome, because a launch is the frame while it lasts. */
      z-index: 50030;
      pointer-events: none;
      font-family: var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      contain: layout style;
    }

    /* IMPACT FLASH. A broadcast flash, not a strobe: one short warm bloom that
     * clears fast. Kept well under full white so the board never disappears. */
    .pw-nuke-flash {
      position: absolute;
      inset: 0;
      opacity: 0;
      background: radial-gradient(
        68% 62% at 50% 50%,
        rgba(255, 236, 214, 0.92) 0%,
        rgba(255, 150, 96, 0.55) 38%,
        rgba(255, 107, 74, 0) 78%
      );
    }
    .pw-nuke-flash.is-firing { animation: pw-nuke-flash-fire 620ms ease-out 1; }
    .pw-nuke-flash.is-big { animation-duration: 820ms; }
    @keyframes pw-nuke-flash-fire {
      0%   { opacity: 0; }
      6%   { opacity: 0.62; }
      100% { opacity: 0; }
    }

    /* THE ALERT. Coral is the only colour that appears here, and coral appears
     * nowhere else on the stage except eliminations — severity means rarity. */
    /* Two lines, not one. Measured on the real board: a single line carrying
     * class + headline + both competitor names + a clock ran ~620px wide, hit
     * the war-room rail, and ellipsised the TARGET — the one word the alert
     * exists to deliver. Stacking the names under the headline keeps the plate
     * ~370px, which clears the leaderboard and the rail at every tier. */
    .pw-nuke-alert {
      position: absolute;
      left: 50%;
      top: calc(var(--pw-band-top, 0px) + 14px);
      /* Centred with the independent translate property, NOT a transform.
       * The first version wrote  transform: translateX(-50%) scale(var(--pw-hud-scale))
       * and the plate rendered 148px right of centre: --pw-hud-scale is
       * clamp(0.42, calc(100vw / 1280), 1), whose middle term is a LENGTH, so
       * the scale() was invalid at computed-value time and took the WHOLE
       * transform down with it — centring included. Keeping the centring in its
       * own property means it cannot be collateral damage again. */
      translate: -50% 0;
      display: none;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      column-gap: 10px;
      row-gap: 2px;
      padding: 7px 12px 8px 8px;
      max-width: min(62vw, 400px);
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      border: 1px solid rgba(255, 107, 74, 0.42);
      box-shadow:
        0 0 0 1px rgba(20, 17, 15, 0.6),
        0 14px 40px rgba(10, 7, 5, 0.5);
    }
    .pw-nuke-alert[data-state="flight"],
    .pw-nuke-alert[data-state="impact"] {
      display: grid;
      animation: pw-nuke-alert-in 260ms ease-out 1;
    }
    /* The alert itself pulses while a warhead is in the air, and stops dead on
     * impact — the pulse IS the countdown, so it must not outlive the flight. */
    .pw-nuke-alert[data-state="flight"] { animation: pw-nuke-alert-in 260ms ease-out 1, pw-nuke-pulse 1.15s ease-in-out infinite 260ms; }
    .pw-nuke-alert[data-state="impact"] { border-color: rgba(255, 107, 74, 0.85); }

    /* THE EMBED FLOOR HAS NO ROOM AT THE TOP. Measured at 640x360: the top
     * band is fully spoken for — scorebug occupying x 8..198 on the left and
     * the transport cluster on the right — leaving a 192px gap that a 292px
     * plate cannot fit, and the first version overlapped the scorebug by
     * 24x56px. Below 741px the alert drops under the scorebug's tallest tier
     * instead, where it collides with nothing and still floats over the board.
     * Same breakpoint as MIN_PUNCH_IN_WIDTH: below it, the drama is carried by
     * the alert and the on-map marks alone. */
    @media (max-width: 740px) {
      .pw-nuke-alert { top: calc(var(--pw-band-top, 0px) + 128px); }
    }

    @keyframes pw-nuke-alert-in {
      from { opacity: 0; translate: -50% -8px; }
      to   { opacity: 1; translate: -50% 0; }
    }
    @keyframes pw-nuke-pulse {
      0%, 100% { border-color: rgba(255, 107, 74, 0.38); }
      50%      { border-color: rgba(255, 107, 74, 0.92); }
    }

    .pw-nuke-kind {
      grid-row: 1 / 3;
      align-self: stretch;
      display: flex;
      align-items: center;
      font: 600 10px/1 var(--pw-num, ui-monospace, monospace);
      letter-spacing: 0.13em;
      color: #14110f;
      background: var(--pw-hazard, #ff6b4a);
      padding: 0 6px;
    }
    .pw-nuke-head {
      grid-column: 2;
      font-size: 12.5px;
      font-weight: 650;
      letter-spacing: 0.07em;
      color: var(--pw-hazard, #ff6b4a);
      white-space: nowrap;
    }
    .pw-nuke-timer {
      grid-column: 3;
      font: 500 11px/1 var(--pw-num, ui-monospace, monospace);
      color: var(--pw-ink-dim, #a79e92);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .pw-nuke-who {
      grid-column: 2 / 4;
      font-size: 12px;
      letter-spacing: 0.02em;
      color: var(--pw-ink, #f2ece2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* COLOUR OWNERSHIP. The broadcast stylesheet paints anything matching
     * body.ai-league-native-spectator-ui [class*="nuke"] with
     * color: var(--pw-hazard) !important — the rule that makes nuke and
     * elimination beats the only coral text in the war room. Every class in
     * this layer contains "nuke", so that rule swallowed the whole plate:
     * knockout label, competitor names and clock all rendered coral-on-coral
     * or coral-on-glass, and the chip read as an empty orange square.
     *
     * Coral stays where it means something — the severity chip's fill and the
     * headline — and everything else is taken back explicitly. These need
     * !important to answer an !important, and three classes of specificity to
     * outrank a body-class-plus-attribute selector. */
    .pw-nuke-cinema .pw-nuke-alert .pw-nuke-kind { color: #14110f !important; }
    .pw-nuke-cinema .pw-nuke-alert .pw-nuke-who { color: var(--pw-ink, #f2ece2) !important; }
    .pw-nuke-cinema .pw-nuke-alert .pw-nuke-timer { color: var(--pw-ink-dim, #a79e92) !important; }

    /* STAGE CLAIM. See setStageClaimed(): the war-room rail overlays the right
     * 23% of the board, and strikes land behind it. While a warhead is up, the
     * rail steps back so the board underneath can be seen. Dimmed, not hidden:
     * the beat log keeps its place, and nothing reflows. The eased return is
     * slower than the exit so the frame settles rather than snapping back. */
    .broadcast-drawer-panel {
      transition: opacity 420ms ease-out;
    }
    body.pw-nuke-active .broadcast-drawer-panel {
      opacity: 0.14;
      transition: opacity 240ms ease-out;
    }

    /* The transport cluster (clock, speed, pause, settings) is the OTHER thing
     * sitting over the board's top-right corner — and a corner is exactly
     * where the camera parks a strike aimed near the map's edge, because the
     * pan clamp will not show background to centre it. This one only recedes;
     * it does not disappear. The match clock is broadcast-critical and the
     * controls have to stay findable and clickable, which they do — opacity
     * changes nothing about hit-testing. */
    #pw-game-control-cluster {
      transition: opacity 420ms ease-out;
    }
    body.pw-nuke-active #pw-game-control-cluster {
      opacity: 0.34;
      transition: opacity 240ms ease-out;
    }

    /* The result outranks the beat: no alert may sit over the end card. */
    body.pw-endcard-open .pw-nuke-cinema { display: none; }

    @media (prefers-reduced-motion: reduce) {
      .pw-nuke-flash.is-firing { animation-duration: 240ms; }
      .pw-nuke-alert[data-state="flight"] { animation: pw-nuke-alert-in 260ms ease-out 1; }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Mounts the cinema on broadcast surfaces only. Returns `[]` for live play, so
 * the layer is never constructed there and its cost is exactly zero.
 */
export function mountNukeCinema(
  game: GameView,
  eventBus: EventBus,
  transformHandler: TransformHandler,
): Layer[] {
  if (!isAiLeagueReplayRoute()) return [];
  return [new NukeCinema(game, eventBus, transformHandler)];
}
