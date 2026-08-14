import { PlayerView } from "../../../core/game/GameView";
import { GameView } from "../../../core/game/GameView";
import { isAiLeagueReplayRoute } from "../../AiLeagueReplayMode";
import { Layer } from "./Layer";

/**
 * ============================================================================
 * SPOTLIGHT — point at the nation a beat is talking about.
 * ============================================================================
 *
 * A war-room toast names two nations and describes something they did to each
 * other, and until now a viewer had no way to connect either name to a shape
 * on the map. Sixteen agents on one board is exactly the situation where
 * "softmaxwell struck SIAN VOIDCROWN" is unreadable without knowing which of
 * the sixteen colours each of those is.
 *
 * Hovering a name in a toast lights that nation's BORDER — its own seat colour,
 * pulsing, over the top of everything. Hovering the toast body lights every
 * nation the beat names, so the two sides of a strike read as a pair.
 *
 * WHY BORDERS AND NOT A TERRITORY WASH
 * ------------------------------------
 * A filled wash means visiting every owned tile: the leader holds most of a
 * 1000x1000 board, so that is a million lookups on a hover, which is a visible
 * hitch on a gesture that is supposed to feel free. The border is the same
 * shape's outline at a fraction of the cost — it comes from the engine's own
 * `borderTiles()` (worker-computed, the same call TerritoryLayer already makes
 * to draw borders), so it is thousands of tiles, and it reads BETTER: an
 * outline says "this shape" without hiding the terrain and units inside it.
 *
 * WHY NOT POINT AT THE ACTION ITSELF
 * ----------------------------------
 * Because the data cannot support it, and this broadcast does not assert what
 * it cannot support. The replay brief is explicit: the artifact plane is
 * coordinate-poor — an `attack` intent carries `targetID` and `troops` and NO
 * TILE AT ALL. So there is no "where" to point at for a strike, a pact or an
 * embargo; the honest highlight is WHO, which is what this draws. The one beat
 * that does carry a position is a nuclear impact, and that already has an
 * entire cinema pointing at it.
 *
 * Replay-gated: mountBroadcastSpotlight returns [] off a replay route, so the
 * live game never builds this layer.
 */

/** Seat ids currently lit. Module-level: the toasts are DOM, this is canvas. */
let spotlitSmallIds: number[] = [];
/** Bumped on every change so the layer can diff without deep-comparing. */
let spotlightVersion = 0;

export function setBroadcastSpotlight(smallIds: number[]): void {
  const next = [...new Set(smallIds)].sort((a, b) => a - b);
  if (
    next.length === spotlitSmallIds.length &&
    next.every((id, i) => id === spotlitSmallIds[i])
  ) {
    return;
  }
  spotlitSmallIds = next;
  spotlightVersion += 1;
}

export function clearBroadcastSpotlight(): void {
  setBroadcastSpotlight([]);
}

/** Full pulse period. Slow enough to read as breathing, not as a strobe. */
const PULSE_MS = 1400;

interface SpotlitShape {
  smallId: number;
  color: string;
  /** Border tiles as world-space coordinates, resolved once per hover. */
  points: Float32Array;
}

class BroadcastSpotlight implements Layer {
  private shapes: SpotlitShape[] = [];
  private builtVersion = -1;
  private buildToken = 0;
  private disposed = false;

  constructor(private game: GameView) {}

  shouldTransform(): boolean {
    return true;
  }

  tick() {
    this.syncToRequest();
  }

  /**
   * Called from BOTH tick() and renderLayer(), and that is the point.
   *
   * `tick()` only runs on a game update, so on a PAUSED replay it never runs
   * at all — and pausing to look around is precisely when a viewer hovers a
   * name. Driven from tick() alone, the spotlight did nothing while paused,
   * and a spotlight already lit could not be turned off either. `renderLayer`
   * runs every animation frame regardless of the game clock, so checking here
   * as well makes the hover feel identical paused or playing. The version
   * compare is an integer test; running it twice a frame costs nothing.
   */
  private syncToRequest() {
    if (this.builtVersion === spotlightVersion) return;
    this.builtVersion = spotlightVersion;
    void this.rebuild(spotlitSmallIds);
  }

  /**
   * Border tiles come from the worker, so this is async and can land after the
   * viewer has already moved on. The token makes a stale resolution a no-op
   * rather than a shape that will not turn off.
   */
  private async rebuild(smallIds: number[]) {
    const token = ++this.buildToken;
    if (smallIds.length === 0) {
      this.shapes = [];
      return;
    }
    const players: PlayerView[] = [];
    for (const view of this.game.playerViews()) {
      if (smallIds.includes(view.smallID())) players.push(view);
    }
    const built: SpotlitShape[] = [];
    for (const player of players) {
      try {
        const border = await player.borderTiles();
        if (this.disposed || token !== this.buildToken) return;
        const tiles = [...border.borderTiles];
        const points = new Float32Array(tiles.length * 2);
        const halfW = this.game.width() / 2;
        const halfH = this.game.height() / 2;
        for (let i = 0; i < tiles.length; i++) {
          points[i * 2] = this.game.x(tiles[i]) - halfW;
          points[i * 2 + 1] = this.game.y(tiles[i]) - halfH;
        }
        built.push({
          smallId: player.smallID(),
          color: player.territoryColor().toHex(),
          points,
        });
      } catch {
        // A player view can go away mid-resolve (rewind, elimination). A
        // spotlight that cannot be built is simply not drawn.
      }
    }
    if (this.disposed || token !== this.buildToken) return;
    this.shapes = built;
  }

  renderLayer(context: CanvasRenderingContext2D) {
    this.syncToRequest();
    if (this.shapes.length === 0) return;
    // Sine pulse in wall-clock time, deliberately NOT tied to game ticks: this
    // is a cursor affordance, so it must keep breathing while the replay is
    // paused and must not speed up during a seek.
    const phase = (performance.now() % PULSE_MS) / PULSE_MS;
    const pulse = 0.55 + 0.45 * Math.sin(phase * Math.PI * 2);
    context.save();
    for (const shape of this.shapes) {
      // Two passes: a soft wide halo so the outline survives over bright
      // territory fills, then the hard 1px line on top. Drawn as rects rather
      // than a path because the border is a tile SET, not an ordered ring —
      // stroking it as a path would join tiles that are not neighbours.
      context.globalAlpha = 0.28 * pulse;
      context.fillStyle = shape.color;
      for (let i = 0; i < shape.points.length; i += 2) {
        context.fillRect(shape.points[i] - 1, shape.points[i + 1] - 1, 3, 3);
      }
      context.globalAlpha = 0.85 * pulse + 0.15;
      context.fillStyle = "#f2ece2";
      for (let i = 0; i < shape.points.length; i += 2) {
        context.fillRect(shape.points[i], shape.points[i + 1], 1, 1);
      }
    }
    context.restore();
  }

  dispose() {
    this.disposed = true;
    this.shapes = [];
    spotlitSmallIds = [];
    spotlightVersion += 1;
  }
}

export function mountBroadcastSpotlight(game: GameView): Layer[] {
  if (!isAiLeagueReplayRoute()) return [];
  return [new BroadcastSpotlight(game)];
}
