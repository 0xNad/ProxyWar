import { UnitType } from "../../../core/game/Game";
import { GameView, PlayerView, UnitView } from "../../../core/game/GameView";
import { isAiLeagueReplayRoute } from "../../AiLeagueReplayMode";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";

/**
 * ============================================================================
 * TRADE / ATTACK LANES — telling COMMERCE apart from INVASION at board scale.
 * ============================================================================
 *
 * THE PROBLEM
 * -----------
 * At the broadcast's whole-map fit a `TradeShip` and a `TransportShip` are the
 * same object: a two-pixel sprite crossing very dark navy water. `UnitLayer`
 * paints a one-tile territory-coloured wake behind a transport
 * (`handleBoatEvent`) and nothing at all behind a trade ship
 * (`handleTradeShipEvent` is a bare `drawSprite`), and at fit-to-screen that
 * wake is a smudge you can only find if you already know it is there.
 *
 * This matters more than anything else on the board except a launch. The
 * current fixture carries 219 boat attacks against 12 nukes: naval invasion IS
 * the match, and it was the one story the display could not tell. A viewer
 * could see WHERE the shooting was but never WHO had put troops in the water
 * or which way they were pointed.
 *
 * THE SPLIT
 * ---------
 * Two ship types, two completely different visual languages, so the read is
 * pre-attentive and needs no legend:
 *
 *   INVASION (TransportShip) — the ATTACKER'S seat colour, so the map answers
 *   "who is doing this" by itself; a solid arrowhead at the ship's nose for
 *   direction; a bright weighted stretch of wake behind the nose so the head
 *   has mass; and a faint dashed lead running to the tile the boat is actually
 *   aimed at, which answers "to whom".
 *
 *   COMMERCE (TradeShip) — a warm-ink hairline (`--pw-ink-dim`, #a79e92 — the
 *   house's warm neutral, NOT a seat colour), dashed and crawling so it reads
 *   as a shipping lane, at roughly a third of the invasion's contrast. Present,
 *   never competing.
 *
 * SEVERITY MEANS RARITY, so the invasion lane is deliberately NOT as loud as it
 * could be: 219 of them over a match means it is the common case. It gets a
 * saturated head and a quiet tail rather than a saturated whole. Coral
 * (--pw-hazard) does not appear here at all — on this stage coral means nukes
 * and eliminations, and borrowing it for the routine event would flatten the
 * one hue that still means "this is different".
 *
 * WHERE THE INVASION'S DESTINATION COMES FROM — IT IS REAL DATA
 * -------------------------------------------------------------
 * `UnitUpdate.targetTile` is commented "Only for nukes"
 * (core/game/GameUpdates.ts:147) and that comment is STALE. Two facts settle
 * it:
 *
 *   - `TransportShipExecution` builds its boat with an explicit destination:
 *     `buildUnit(UnitType.TransportShip, this.src, { troops, targetTile:
 *     this.dst })` (core/execution/TransportShipExecution.ts:126-129), where
 *     `dst` is `targetTransportTile(...)` — the actual landing tile on the
 *     defender's shore, not an estimate.
 *   - `UnitImpl.toUpdate()` serialises `targetTile` for EVERY unit type
 *     (core/game/UnitImpl.ts:148), and `UnitView.targetTile()` hands it
 *     straight back (core/game/GameView.ts:168-170).
 *
 * It is also kept honest through a retreat: when a boat turns for home,
 * `TransportShipExecution` re-points it with `setTargetTile(this.dst)`
 * (core/execution/TransportShipExecution.ts:225-227), so the field never
 * describes a plan the boat has abandoned. That is why the lead is drawn from
 * `targetTile()` and nothing here guesses.
 *
 * The lead is still gated on `isValidRef` because a stale/absent field would
 * otherwise be read as tile 0 (map corner) and draw a lane to nowhere; and it
 * is suppressed entirely while `transportShipState().isRetreating`, because a
 * boat running home with its troops is not an invasion in progress and
 * arrowing it at its own coast would say the opposite of what is happening.
 *
 * The ORIGIN end of the lane is not read from anywhere — it is the first tile
 * we observe the unit on, recorded as it appears in the live set. For a
 * transport that IS the water entry: `TransportShipExecution` spawns the boat
 * at `attacker.canBuild(UnitType.TransportShip, dst)`, a water tile off the
 * attacker's own coast. The wake is therefore a record of where the ship has
 * been, never a prediction.
 *
 * WHY THE ARROWHEAD POINTS ALONG TRAVEL AND NOT AT THE TARGET
 * -----------------------------------------------------------
 * Boats path around land. A transport halfway through a strait is frequently
 * moving at ninety degrees to the bearing of its landing tile, and an arrow
 * aimed at the target there would be a claim about motion that the screen
 * visibly contradicts. So the head shows what the ship is DOING (a smoothed
 * travel heading) and the dashed lead shows what it is AIMED AT. Two marks,
 * two facts, neither one lying for the other.
 *
 * LIFECYCLE — POLLED STATE, NOT UPDATES
 * --------------------------------------
 * `game.units(...)` returns only ACTIVE units (core/game/GameView.ts:1236-1243)
 * and `GameView` deletes dead ones on the tick AFTER they die (its `toDelete`
 * set, core/game/GameView.ts:776). So this layer does what `NukeCinema` does:
 * it diffs the live set against its own `Map` every tick, keeps everything it
 * needs inside its own record, and NEVER looks a vanished unit back up. An id
 * that stops appearing is an arrival or a loss; either way the lane fades out
 * over FADE_MS rather than popping, which is what makes a landing read as an
 * event instead of a glitch. Liveness is tracked with a per-lane `seenTick`
 * stamp rather than a per-tick `Set`, purely to keep the tick allocation-free.
 *
 * A backwards tick (the viewer scrubbed) invalidates every wake we hold, so the
 * whole layer is torn down — a wake is a claim about history and after a seek
 * ours is about a history that no longer applies.
 *
 * PERFORMANCE
 * -----------
 * `renderLayer` runs every frame with potentially dozens of live ships, so all
 * state work happens in `tick()` and the frame does nothing but draw:
 *
 *   - Wakes are stored as FLAT number arrays of world coordinates (x,y,x,y…)
 *     and sampled only every `spacing` tiles, so a 200-tile crossing costs
 *     ~100 numbers, not 200 objects. When a lane exceeds MAX_SAMPLES the array
 *     is decimated IN PLACE (every other sample dropped, origin and head kept)
 *     and its spacing doubles, so a lane's cost is bounded no matter how long
 *     the voyage.
 *   - Seat colours are baked into finished `rgba(...)` strings once per player
 *     and cached; the per-frame fade rides on `globalAlpha` instead, so no
 *     frame ever builds a colour string.
 *   - The dash pattern is written into one reusable two-element array (canvas
 *     copies it on `setLineDash`), so no frame allocates one either.
 *
 * Draw calls are ~4 per invasion and 1 per trade ship, in three passes so that
 * no lane's head is ever buried under another lane's tail.
 *
 * Two later measurements added two more gates, both pure cost reductions that
 * change nothing about how a VISIBLE lane looks:
 *
 *   - A frame profile measured ~20,000 path commands per frame across the
 *     three passes, with every lane drawn whether or not it was on screen. The
 *     broadcast spends most of a match zoomed into one theatre while boats
 *     cross the whole map, so most of that was drawn outside the viewport. Each
 *     lane now carries a grown-as-you-go bounding box and every pass box-tests
 *     it against the visible rectangle first — four comparisons in place of up
 *     to 160 lineTo calls.
 *   - `renderer.tick()` is driven once per GAME TURN, not once per frame (see
 *     ClientGameRunner's executeNextTick loop), so a forward seek ran this
 *     layer's `game.units(...)` poll — which allocates two N-sized arrays,
 *     GameView.units() being an Array.from + a filter — at roughly 1,400 calls
 *     per second, for frames nobody watches. It is now gated on the same
 *     catch-up test NukeCinema and WarRoomToasts use.
 *
 * LIVE PLAY IS UNTOUCHED
 * ----------------------
 * `mountTradeAttackLanes()` returns `[]` off the replay route, so nothing here
 * is constructed, ticked or drawn during a live game.
 */

/** World tiles between wake samples. Boats move 1 tile/tick
 * (`TransportShipExecution.ticksPerMove = 1`), so this is a 2:1 decimation of
 * the raw path — well under a screen pixel of error at every zoom the
 * broadcast uses. */
const SAMPLE_SPACING = 2;

/** Hard ceiling on samples per lane before in-place decimation kicks in. */
const MAX_SAMPLES = 160;

/**
 * A ship that has not changed tile in this many ticks is not "in transit" and
 * gets no lane. Generous relative to the 1 tile/tick boat speed: this is here
 * to catch a blocked or stalled unit, not to flicker off during a slow turn.
 */
const STALL_TICKS = 24;

/** Below this end-to-end length there is no lane worth drawing, only a blob. */
const MIN_LANE_LENGTH = 5;

/** How long a lane lingers after its ship leaves the live set. */
const FADE_MS = 520;

/** Share of the wake, from the head backwards, carrying the bright weight. */
const HEAD_FRACTION = 0.22;

/** Smoothing on the travel heading. The raw per-tick delta is 8-directional
 * and jitters hard; this is a ~7-tick time constant, which settles the
 * arrowhead without making it slow to turn. */
const DIR_EMA = 0.18;

/**
 * A retreating transport keeps its lane — it is still troops in the water and
 * still the attacker's — but at roughly half weight and with no lead, because
 * it is no longer an invasion arriving anywhere.
 */
const RETREAT_WEIGHT = 0.5;

/**
 * Warm ink for commerce: `--pw-ink-dim` (#a79e92). Deliberately NOT a seat
 * colour and deliberately not amber — trade must not read as either a player's
 * action or as chrome. Over the ops-theme ocean (rgb(14,11,30)) these alphas
 * land around luminance 45-60, which is legible against the water and below
 * every seat colour on the board.
 */
const TRADE_INK = "rgba(167, 158, 146, ";

/**
 * Near-black separator drawn under the invasion head and around the arrowhead.
 * The last stretch of an invasion lane is exactly where it crosses the
 * shoreline onto the DEFENDER'S seat-coloured land, and one seat colour laid
 * directly on another is unreadable. This is the only thing that keeps the
 * arrival end legible, and it costs one stroke.
 */
const SEPARATOR = "rgba(6, 5, 10, 0.62)";

/**
 * Above this many game ticks per wall-clock second the replay is SEEKING, not
 * playing — the same threshold and the same reasoning as NukeCinema's and the
 * war-room toasts'. Measured on the real fixture a seek crosses ~1,400 turns
 * per second against ~20 for normal 2x playback, and this layer is ticked once
 * per turn, so the two orders of magnitude between them make the distinction
 * safe to draw here too.
 */
const CATCHUP_TICKS_PER_SECOND = 150;

/**
 * Slack added to the visible rectangle before a lane is culled, in WORLD TILES,
 * to absorb `screenBoundingRect()` flooring both of its corners. Two tiles is
 * one tile of rounding per axis and one of pure margin.
 */
const CULL_MARGIN_TILES = 2;

/**
 * Slack added on top of that in SCREEN PIXELS, for the marks that stick out
 * past the sample geometry a lane's box is built from: the arrowhead reaches
 * 7.5px ahead of the head, the separator stroke under it is 3.6px wide (1.8 of
 * that outside the path), and the landing ring is a 2.6px radius. Twelve
 * covers the worst combination with room to spare, at every zoom, because it
 * is converted through the same 1/scale the marks themselves use.
 */
const CULL_MARGIN_PX = 12;

interface SeatInk {
  /** The long, quiet body of the wake. */
  tail: string;
  /** The weighted stretch behind the nose. */
  head: string;
  /** The solid arrowhead at the nose. */
  arrow: string;
  /** The dashed run out to the landing tile. */
  lead: string;
}

interface Lane {
  /** TransportShip => true. Decides the entire visual language. */
  invasion: boolean;
  /** Seat colour key. -1 when the owner is not a player (should not happen for
   * boats, but `UnitView.owner()` non-null-asserts a lookup that can miss). */
  seat: number;
  /** Flat world coordinates, x,y,x,y… `[0],[1]` is the observed origin. */
  pts: number[];
  /** Current sample spacing in tiles; doubles on each decimation. */
  spacing: number;
  /** Exact current position, kept per tick so the head never lags the sprite. */
  headX: number;
  headY: number;
  /** Smoothed unit travel heading; (0,0) until the ship has moved once. */
  dirX: number;
  dirY: number;
  /** Landing tile in world coordinates, or -1 when there is none to show. */
  targetX: number;
  targetY: number;
  retreating: boolean;
  lastMoveTick: number;
  /** Liveness stamp for the per-tick diff. */
  seenTick: number;
  /** Layer-clock ms at which the unit left the live set; 0 while alive. */
  deadAtMs: number;
  /**
   * Cull box in world coordinates, over every point this lane can draw
   * through: its samples, its head and its landing tile. GROW-ONLY — see
   * `grow()` for why a box that is too big is the only acceptable error.
   */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

class TradeAttackLanes implements Layer {
  private lanes = new Map<number, Lane>();
  private ink = new Map<number, SeatInk>();
  private lastTick = -1;

  // Ticks per wall-clock second, smoothed. See CATCHUP_TICKS_PER_SECOND.
  private rateSampledAtMs = 0;
  private tickRate = 0;

  /**
   * The layer's own clock, sampled in `tick()`. Rendering keeps running while
   * the replay is paused (rAF never stops) but ticking does not, so reading
   * `performance.now()` inside `renderLayer` would age a landing's fade out
   * from under a frozen frame. One clock for the whole layer means a paused
   * broadcast holds a coherent picture. Same reason `NukeCinema` renders off
   * `lastTickMs` rather than the wall clock.
   */
  private nowMs = 0;

  /** Reused by every `setLineDash` call; canvas copies it, so mutation is
   * safe and no frame allocates a pattern array. */
  private readonly dash = [0, 0];
  private readonly noDash: number[] = [];

  constructor(
    private game: GameView,
    private transformHandler: TransformHandler,
  ) {}

  tick() {
    const tick = this.game.ticks();
    const now = performance.now();
    const advanced = this.lastTick < 0 ? 0 : Math.max(0, tick - this.lastTick);
    if (tick < this.lastTick) {
      // Seeking backwards: every wake we hold describes a path this playhead
      // has not taken. Throw the lot away rather than let stale history draw.
      this.lanes.clear();
      this.ink.clear();
    }
    this.lastTick = tick;
    this.nowMs = now;
    this.measureTickRate(advanced, now);

    if (this.catchingUp()) {
      // SEEKING FORWARD, NOT PLAYING. This layer is ticked once per game turn,
      // so a seek ran the poll below ~1,400 times a second — two N-sized array
      // allocations each — to build wakes for frames nobody sees. Skipping it
      // is most of the cost of a seek in this layer.
      //
      // The lanes go with it rather than being frozen. A frozen lane would be
      // handed a head that has jumped hundreds of tiles the moment playback
      // resumes, and `advance()` would push ONE sample across that gap: a
      // straight wake through open land claiming a voyage that never happened.
      // Dropping them instead means the ships re-open lanes from wherever they
      // are on arrival — the same honest, shorter mark the class doc already
      // describes for a layer mounted mid-voyage, and the same thing a
      // backward seek has always done. Nothing is watching during the jump,
      // and a lane is back within ~13 turns of arrival (MIN_LANE_LENGTH at one
      // tile per tick).
      if (this.lanes.size > 0) this.lanes.clear();
      return;
    }

    const live = this.game.units(UnitType.TradeShip, UnitType.TransportShip);
    for (const unit of live) {
      const lane = this.lanes.get(unit.id());
      if (lane === undefined) {
        this.lanes.set(unit.id(), this.open(unit, tick));
      } else {
        this.advance(lane, unit, tick);
      }
    }

    // Anything not stamped this tick has left the live set: it arrived, was
    // sunk, or was cancelled. We cannot tell which from here and deliberately
    // do not try — `game.unit(id)` is already undefined by now — so all three
    // read as the lane fading off the water.
    for (const [id, lane] of this.lanes) {
      if (lane.seenTick === tick) continue;
      if (lane.deadAtMs === 0) {
        lane.deadAtMs = this.nowMs;
      } else if (this.nowMs - lane.deadAtMs > FADE_MS) {
        this.lanes.delete(id);
      }
    }
  }

  /** Ticks per wall-clock second; see CATCHUP_TICKS_PER_SECOND. */
  private measureTickRate(advanced: number, now: number) {
    const dt = now - this.rateSampledAtMs;
    this.rateSampledAtMs = now;
    if (dt <= 0 || dt > 700) return;
    this.tickRate = this.tickRate * 0.75 + ((advanced * 1000) / dt) * 0.25;
  }

  private catchingUp(): boolean {
    return this.tickRate > CATCHUP_TICKS_PER_SECOND;
  }

  /**
   * TEARDOWN — see `Layer.dispose()`. This layer is the odd one out among the
   * broadcast surfaces: it owns no DOM node, no window/document listener, no
   * EventBus subscription and no timer, because it draws onto the shared game
   * canvas that GameRenderer takes down itself. What it does own is MEMORY —
   * a wake is up to MAX_SAMPLES pairs of numbers and a busy match carries
   * dozens of live lanes — so the maps are dropped rather than left pinned by
   * a layer array nothing ticks any more. Resetting the clock and the rate
   * sampler is what makes a dispose()-then-init() sequence behave exactly like
   * a fresh mount. Idempotent: clearing an empty map twice is free.
   */
  dispose() {
    this.lanes.clear();
    this.ink.clear();
    this.lastTick = -1;
    this.nowMs = 0;
    this.rateSampledAtMs = 0;
    this.tickRate = 0;
  }

  private open(unit: UnitView, tick: number): Lane {
    const x = this.game.x(unit.tile());
    const y = this.game.y(unit.tile());
    const lane: Lane = {
      invasion: unit.type() === UnitType.TransportShip,
      seat: this.seatOf(unit),
      // The first tile we see the unit on. For a transport this is the water
      // tile off the attacker's own coast that `canBuild` picked, i.e. the
      // water entry. A layer mounted mid-voyage (or the first tick after a
      // forward scrub) will start a wake from open water instead — which is
      // honest, just shorter, and self-corrects as the ship travels.
      pts: [x, y],
      spacing: SAMPLE_SPACING,
      headX: x,
      headY: y,
      dirX: 0,
      dirY: 0,
      targetX: -1,
      targetY: -1,
      retreating: false,
      lastMoveTick: tick,
      seenTick: tick,
      deadAtMs: 0,
      minX: x,
      minY: y,
      maxX: x,
      maxY: y,
    };
    this.readTarget(lane, unit);
    return lane;
  }

  /**
   * Grow a lane's cull box. GROW-ONLY, deliberately: `decimate()` throws
   * samples away and a retreat re-points the lead, either of which could
   * SHRINK the true extent — but recomputing a tight box would cost a pass
   * over the samples, and a box that is too big only ever costs one lane's
   * worth of draw calls that were going to be paid anyway. A box that is too
   * small drops a mark that should have been half on screen, which is a visual
   * regression. Only one of those two errors is acceptable.
   */
  private grow(lane: Lane, x: number, y: number) {
    if (x < lane.minX) lane.minX = x;
    if (x > lane.maxX) lane.maxX = x;
    if (y < lane.minY) lane.minY = y;
    if (y > lane.maxY) lane.maxY = y;
  }

  private advance(lane: Lane, unit: UnitView, tick: number) {
    lane.seenTick = tick;
    const x = this.game.x(unit.tile());
    const y = this.game.y(unit.tile());
    const dx = x - lane.headX;
    const dy = y - lane.headY;

    if (dx !== 0 || dy !== 0) {
      lane.lastMoveTick = tick;
      const len = Math.sqrt(dx * dx + dy * dy);
      const nx = dx / len;
      const ny = dy / len;
      if (lane.dirX === 0 && lane.dirY === 0) {
        lane.dirX = nx;
        lane.dirY = ny;
      } else {
        lane.dirX += (nx - lane.dirX) * DIR_EMA;
        lane.dirY += (ny - lane.dirY) * DIR_EMA;
        const m = Math.sqrt(lane.dirX * lane.dirX + lane.dirY * lane.dirY);
        if (m > 1e-4) {
          lane.dirX /= m;
          lane.dirY /= m;
        }
      }
      lane.headX = x;
      lane.headY = y;
      this.grow(lane, x, y);

      const n = lane.pts.length;
      const sdx = x - lane.pts[n - 2];
      const sdy = y - lane.pts[n - 1];
      if (sdx * sdx + sdy * sdy >= lane.spacing * lane.spacing) {
        lane.pts.push(x, y);
        if (lane.pts.length > MAX_SAMPLES * 2) this.decimate(lane);
      }
    }

    this.readTarget(lane, unit);
  }

  /**
   * Halve a wake in place. The origin pair and the newest pair are both
   * preserved — the origin is the whole point of the mark and the newest pair
   * is what the head segment hangs off — and the write cursor never overtakes
   * the read cursor, so no scratch array is needed.
   */
  private decimate(lane: Lane) {
    const pts = lane.pts;
    const last = pts.length - 2;
    let w = 2;
    for (let r = 2; r < last; r += 4) {
      pts[w++] = pts[r];
      pts[w++] = pts[r + 1];
    }
    pts[w++] = pts[last];
    pts[w++] = pts[last + 1];
    pts.length = w;
    lane.spacing *= 2;
  }

  /**
   * Refresh the landing tile. Trade ships never get a lead (see the class
   * doc — commerce stays quiet), so this only does work for transports.
   */
  private readTarget(lane: Lane, unit: UnitView) {
    if (!lane.invasion) return;
    lane.retreating = unit.transportShipState().isRetreating;
    const target = unit.targetTile();
    if (target === undefined || !this.game.isValidRef(target)) {
      lane.targetX = -1;
      lane.targetY = -1;
      return;
    }
    lane.targetX = this.game.x(target);
    lane.targetY = this.game.y(target);
    // The lead runs from the head all the way out to the landing tile, so the
    // cull box has to contain the destination even while the ship is still on
    // the far side of the map from it.
    this.grow(lane, lane.targetX, lane.targetY);
  }

  private seatOf(unit: UnitView): number {
    const owner = unit.owner() as PlayerView | undefined;
    if (owner === undefined || !owner.isPlayer()) return -1;
    const seat = owner.smallID();
    if (!this.ink.has(seat)) {
      // Sourced from PlayerView.territoryColor() — the same accessor
      // TerritoryLayer paints the board with and Leaderboard draws its
      // standings swatch from — and NOT theme().territoryColor(), which
      // returns the default and ignores cosmetics/pattern overrides. The lane
      // has to be the same colour as the attacker's land or it answers "who"
      // with the wrong name.
      const c = owner.territoryColor().rgba;
      const rgb = `${c.r}, ${c.g}, ${c.b}, `;
      this.ink.set(seat, {
        tail: `rgba(${rgb}0.30)`,
        head: `rgba(${rgb}0.74)`,
        arrow: `rgba(${rgb}0.92)`,
        lead: `rgba(${rgb}0.19)`,
      });
    }
    return seat;
  }

  shouldTransform(): boolean {
    return true;
  }

  /**
   * World-space marks. Under `handleTransform` the canvas origin sits at the
   * map's centre, so a tile at world (x, y) draws at (x - width/2,
   * y - height/2) — the convention `SAMRadiusLayer` uses. Every line width and
   * dash length is multiplied by 1/scale so strokes hold a constant thickness
   * on screen at any zoom.
   *
   * Three passes, in the order a broadcast would rank them: all commerce, then
   * every invasion tail and lead, then every invasion head and arrowhead. Any
   * single-pass ordering lets one lane's quiet tail land on top of another
   * lane's nose, which is the one mark that must never be occluded.
   */
  renderLayer(context: CanvasRenderingContext2D) {
    if (this.lanes.size === 0) return;

    const ox = -this.game.width() / 2;
    const oy = -this.game.height() / 2;
    const px = 1 / Math.max(this.transformHandler.scale, 0.0001);
    // Dash crawl runs off the layer clock, so it stops dead when the replay is
    // paused instead of animating over a frozen board.
    const crawl = this.nowMs * 0.004;

    // VIEWPORT CULL, computed once for all three passes. A frame profile
    // measured ~20,000 path commands per frame here with no culling at all,
    // and the broadcast spends most of a match zoomed into one theatre while
    // boats cross the whole map — so most of those commands were describing
    // geometry outside the canvas. `screenBoundingRect()` is the same accessor
    // TerritoryLayer, RailroadLayer and FxLayer cull against, and it returns
    // WORLD tile coordinates, i.e. exactly the space lane samples are kept in.
    // It allocates two Cells; that is the one allocation this file's per-frame
    // path permits itself, and it buys back thousands of lineTo calls.
    const [viewMin, viewMax] = this.transformHandler.screenBoundingRect();
    const margin = CULL_MARGIN_TILES + CULL_MARGIN_PX * px;
    const cullLeft = viewMin.x - margin;
    const cullTop = viewMin.y - margin;
    const cullRight = viewMax.x + margin;
    const cullBottom = viewMax.y + margin;

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    // ---- Commerce -------------------------------------------------------
    context.strokeStyle = `${TRADE_INK}0.30)`;
    context.lineWidth = 1.0 * px;
    this.dash[0] = 2.5 * px;
    this.dash[1] = 4.0 * px;
    context.setLineDash(this.dash);
    context.lineDashOffset = -(crawl % 6.5) * px;
    for (const lane of this.lanes.values()) {
      if (lane.invasion) continue;
      if (this.offscreen(lane, cullLeft, cullTop, cullRight, cullBottom)) {
        continue;
      }
      const weight = this.weight(lane);
      if (weight === 0) continue;
      context.globalAlpha = weight;
      this.strokeWake(context, lane, 0, ox, oy);
    }
    context.globalAlpha = 1;

    // ---- Invasion: tails and leads --------------------------------------
    for (const lane of this.lanes.values()) {
      if (!lane.invasion) continue;
      if (this.offscreen(lane, cullLeft, cullTop, cullRight, cullBottom)) {
        continue;
      }
      const weight = this.weight(lane);
      if (weight === 0) continue;
      const ink = this.ink.get(lane.seat);
      if (ink === undefined) continue;
      context.globalAlpha = weight;

      context.setLineDash(this.noDash);
      context.lineDashOffset = 0;
      context.strokeStyle = ink.tail;
      context.lineWidth = 1.3 * px;
      this.strokeWake(context, lane, 0, ox, oy);

      // The lead only exists when the engine actually told us where the boat
      // is going and the boat has not turned for home. Never inferred.
      if (!lane.retreating && lane.targetX >= 0) {
        this.dash[0] = 3.5 * px;
        this.dash[1] = 5.0 * px;
        context.setLineDash(this.dash);
        context.lineDashOffset = -(crawl % 8.5) * px;
        context.strokeStyle = ink.lead;
        context.lineWidth = 0.9 * px;
        context.beginPath();
        context.moveTo(lane.headX + ox, lane.headY + oy);
        context.lineTo(lane.targetX + ox, lane.targetY + oy);
        context.stroke();
        // A small open ring on the landing tile. Closed shapes read as a
        // destination where a bare line end reads as the line running out of
        // room; at 2.6px it is a tick mark, not a target reticle — reticles on
        // this stage belong to the nuke cinema.
        context.beginPath();
        context.setLineDash(this.noDash);
        context.lineDashOffset = 0;
        context.arc(
          lane.targetX + ox,
          lane.targetY + oy,
          2.6 * px,
          0,
          Math.PI * 2,
        );
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    context.setLineDash(this.noDash);
    context.lineDashOffset = 0;

    // ---- Invasion: heads and arrowheads ---------------------------------
    for (const lane of this.lanes.values()) {
      if (!lane.invasion) continue;
      if (this.offscreen(lane, cullLeft, cullTop, cullRight, cullBottom)) {
        continue;
      }
      const weight = this.weight(lane);
      if (weight === 0) continue;
      const ink = this.ink.get(lane.seat);
      if (ink === undefined) continue;
      context.globalAlpha = weight;

      // Weighted stretch behind the nose, on its own dark separator so it
      // survives crossing the defender's seat-coloured coast.
      const pairs = lane.pts.length >> 1;
      const keep = Math.max(2, Math.round(pairs * HEAD_FRACTION));
      const from = Math.max(0, pairs - keep) * 2;
      context.strokeStyle = SEPARATOR;
      context.lineWidth = 3.6 * px;
      this.strokeWake(context, lane, from, ox, oy);
      context.strokeStyle = ink.head;
      context.lineWidth = 2.2 * px;
      this.strokeWake(context, lane, from, ox, oy);

      if (lane.dirX !== 0 || lane.dirY !== 0) {
        this.strokeArrow(context, lane, ink, ox, oy, px);
      }
    }

    context.restore();
  }

  /**
   * True when nothing this lane can draw lands inside the visible rectangle.
   * Four comparisons, taken BEFORE `weight()` because it is the cheaper of the
   * two rejections and either one alone is enough to skip the lane.
   */
  private offscreen(
    lane: Lane,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): boolean {
    return (
      lane.maxX < left ||
      lane.minX > right ||
      lane.maxY < top ||
      lane.minY > bottom
    );
  }

  /**
   * Draw weight for a lane, 0 meaning "not in transit, do not draw at all".
   * Folded into one number so the fade, the retreat de-emphasis and the
   * in-transit gate all ride on `globalAlpha` and no colour string is ever
   * rebuilt during a frame.
   */
  private weight(lane: Lane): number {
    if (lane.pts.length < 4) return 0;
    const dx = lane.headX - lane.pts[0];
    const dy = lane.headY - lane.pts[1];
    if (dx * dx + dy * dy < MIN_LANE_LENGTH * MIN_LANE_LENGTH) return 0;

    let weight = lane.retreating ? RETREAT_WEIGHT : 1;
    if (lane.deadAtMs > 0) {
      const t = (this.nowMs - lane.deadAtMs) / FADE_MS;
      if (t >= 1) return 0;
      weight *= 1 - t;
    } else if (this.lastTick - lane.lastMoveTick > STALL_TICKS) {
      return 0;
    }
    return weight;
  }

  /**
   * Stroke the wake from sample `from` to the head. The final leg always runs
   * to the exact current position rather than the last SAMPLE, so the lane
   * stays welded to the sprite between samples at any spacing.
   */
  private strokeWake(
    context: CanvasRenderingContext2D,
    lane: Lane,
    from: number,
    ox: number,
    oy: number,
  ) {
    const pts = lane.pts;
    context.beginPath();
    context.moveTo(pts[from] + ox, pts[from + 1] + oy);
    for (let i = from + 2; i < pts.length; i += 2) {
      context.lineTo(pts[i] + ox, pts[i + 1] + oy);
    }
    context.lineTo(lane.headX + ox, lane.headY + oy);
    context.stroke();
  }

  /**
   * The nose. Built with raw path calls rather than a `Path2D` so the frame
   * allocates nothing, and outlined in the separator after filling so it holds
   * its shape against both the seat-coloured coast it is arriving on and its
   * own wake.
   */
  private strokeArrow(
    context: CanvasRenderingContext2D,
    lane: Lane,
    ink: SeatInk,
    ox: number,
    oy: number,
    px: number,
  ) {
    const x = lane.headX + ox;
    const y = lane.headY + oy;
    const dx = lane.dirX;
    const dy = lane.dirY;
    const reach = 7.5 * px;
    const half = 4.2 * px;
    // Tip sits ahead of the ship and the base behind it, so the arrow reads as
    // the boat's nose rather than as a marker parked on top of the sprite.
    const tipX = x + dx * reach * 0.85;
    const tipY = y + dy * reach * 0.85;
    const baseX = x - dx * reach * 0.5;
    const baseY = y - dy * reach * 0.5;
    const nx = -dy;
    const ny = dx;

    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(baseX + nx * half, baseY + ny * half);
    context.lineTo(baseX - nx * half, baseY - ny * half);
    context.closePath();
    context.fillStyle = ink.arrow;
    context.fill();
    context.strokeStyle = SEPARATOR;
    context.lineWidth = 1.1 * px;
    context.stroke();
  }
}

/**
 * Replay-only, by construction. Off the AI League replay route this returns an
 * empty array, so live play never constructs, ticks or draws any of this and
 * stays byte-for-byte what it was.
 */
export function mountTradeAttackLanes(
  game: GameView,
  transformHandler: TransformHandler,
): Layer[] {
  if (!isAiLeagueReplayRoute()) return [];
  return [new TradeAttackLanes(game, transformHandler)];
}
