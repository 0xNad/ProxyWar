import { Colord, colord } from "colord";
import { PseudoRandom } from "../PseudoRandom";
import { TerrainType } from "../game/Game";
import { GameMap, TileRef } from "../game/GameMap";
import { isStaticReplayBroadcast } from "./Colors";
import { PastelTheme } from "./PastelTheme";

/** v5 lowland biome palette — see situationTerrainColor's comment. */
const SITU_FOREST: [number, number, number] = [36, 50, 33];
const SITU_STEPPE: [number, number, number] = [56, 58, 36];
const SITU_DRY: [number, number, number] = [78, 68, 42];

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function segRgb(
  m: number,
  m0: number,
  m1: number,
  c0: [number, number, number],
  c1: [number, number, number],
): [number, number, number] {
  const t = Math.min(1, Math.max(0, (m - m0) / (m1 - m0)));
  return mixRgb(c0, c1, t);
}

/** Deterministic integer hash -> [0,1). Same tile, same value, every run. */
function situationHash(xi: number, yi: number): number {
  let h = (xi * 374761393 + yi * 668265263) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (((h ^ (h >> 16)) >>> 0) % 1024) / 1023;
}

/** Smooth two-corner-interpolated value noise at wavelength s. */
function situationValueNoise(x: number, y: number, s: number): number {
  const xf = x / s;
  const yf = y / s;
  const x0 = Math.floor(xf);
  const y0 = Math.floor(yf);
  const tx = xf - x0;
  const ty = yf - y0;
  const sm = (t: number) => t * t * (3 - 2 * t);
  const a = situationHash(x0, y0);
  const b = situationHash(x0 + 1, y0);
  const c = situationHash(x0, y0 + 1);
  const d = situationHash(x0 + 1, y0 + 1);
  const top = a + (b - a) * sm(tx);
  const bot = c + (d - c) * sm(tx);
  return top + (bot - top) * sm(ty);
}

export class PastelThemeDark extends PastelTheme {
  private darkShore = colord("rgb(134,133,88)");

  private darkWater = colord("rgb(14,11,30)");
  private darkShorelineWater = colord("rgb(50,50,50)");

  // ---------------------------------------------------------------------
  // "SITUATION DISPLAY" TERRAIN — the broadcast board's form.
  //
  // The brief was OpenFront in FUNCTION, not form. This is the form: a dark
  // world in an operations centre, where unowned land recedes to warm
  // charcoal (elevation as faint luminance, nothing more) so the sixteen
  // seat colours are the only bright thing on Earth. The stock dark theme
  // keeps land at pastel-bright tan/olive (L 138-164 against a stage at 17),
  // which reads as a light-mode map inlaid in a dark room — the exact
  // failure the aesthetic gate named.
  //
  // Replay-gated like the seat palette: live play never sees this.
  // ---------------------------------------------------------------------
  private opsShore = colord("rgb(92, 82, 62)");
  private opsShorelineWater = colord("rgb(30, 28, 32)");

  // | Terrain Type      | Magnitude | Base Color Logic                                | Visual Description    |
  // | :---------------- | :-------- | :---------------------------------------------- | :-------------------- |
  // | **Shore (Land)**  | N/A       | Fixed: `rgb(134, 133, 88)`                    | Dark olive.           |
  // | **Plains**        | 0 - 9     | `rgb(140, 170, 88)` - `rgb(140, 152, 88)`   | Muted green.          |
  // | **Highland**      | 10 - 19   | `rgb(170, 153, 108)` - `rgb(188, 171, 126)` | Dark earth tone.      |
  // | **Mountain**      | 20 - 30   | `rgb(190, 190, 190)` - `rgb(195, 195, 195)` | Dark gray.            |
  // | **Water (Shore)** | 0         | Fixed: `rgb(50, 50, 50)`                      | Dark gray/black.      |
  // | **Water (Deep)**  | 1 - 10+   | `rgb(22, 19, 38)` - `rgb(14, 11, 30)`       | Very dark blue/black. |

  // ---------------------------------------------------------------------
  // CONTAMINATED GROUND — what a nuke leaves behind.
  //
  // The stock fallout colour is a set of near-identical bright greens
  // (rgb(120,255,71) and four neighbours) — arcade radioactive-ooze green,
  // the single most saturated thing that can appear on the board, and on a
  // stage where SIXTEEN SEAT COLOURS are supposed to be the only saturated
  // things it reads as a spill, not as a hazard. It also lands on the one
  // hue nothing else here uses, so it looks like it belongs to a different
  // game.
  //
  // This is the same ember family the nuke cinema's rings and cloud are
  // drawn in, which is the point: coral IS the severity hue on this stage
  // (eliminations and nukes, nothing else), so poisoned ground reading as
  // cooling ember says "a warhead did this" without a legend.
  //
  // The spread across five values is load-bearing, not decorative.
  // `falloutColor()` is called PER TILE and picks at random, so a wide
  // ember-to-ash spread makes a contaminated zone come out mottled and
  // irregular — scorched, seething ground rather than a flat sticker. The
  // caller paints at alpha 150 over the dark stage, so these are chosen
  // bright enough to survive that.
  // ---------------------------------------------------------------------
  private opsFalloutColors = [
    colord("rgb(255, 121, 74)"), // hazard coral — the hottest ground
    colord("rgb(255, 163, 82)"), // ember
    colord("rgb(226, 88, 58)"), // deep coral
    colord("rgb(255, 205, 128)"), // ash lit from beneath
    colord("rgb(150, 66, 50)"), // burnt out
  ];

  /**
   * Its own generator because the base class keeps `rand` private. Seeded, so
   * a given contaminated zone mottles the same way on every playback of the
   * same replay — a broadcast frame should not change between viewings.
   */
  private opsFalloutRand = new PseudoRandom(9174);

  falloutColor(): Colord {
    if (isStaticReplayBroadcast()) {
      return this.opsFalloutRand.randElement(this.opsFalloutColors);
    }
    return super.falloutColor();
  }

  terrainColor(gm: GameMap, tile: TileRef): Colord {
    if (isStaticReplayBroadcast()) {
      return this.situationTerrainColor(gm, tile);
    }
    const mag = gm.magnitude(tile);
    if (gm.isShore(tile)) {
      return this.darkShore;
    }
    switch (gm.terrainType(tile)) {
      case TerrainType.Ocean:
      case TerrainType.Lake: {
        const w = this.darkWater.rgba;
        if (gm.isShoreline(tile) && gm.isWater(tile)) {
          return this.darkShorelineWater;
        }
        if (gm.magnitude(tile) < 10) {
          return colord({
            r: Math.max(w.r + 9 - mag, 0),
            g: Math.max(w.g + 9 - mag, 0),
            b: Math.max(w.b + 9 - mag, 0),
          });
        }
        return this.darkWater;
      }
      case TerrainType.Plains:
        return colord({
          r: 140,
          g: 170 - 2 * mag,
          b: 88,
        });
      case TerrainType.Highland:
        return colord({
          r: 150 + 2 * mag,
          g: 133 + 2 * mag,
          b: 88 + 2 * mag,
        });
      case TerrainType.Mountain:
        return colord({
          r: 180 + mag / 2,
          g: 180 + mag / 2,
          b: 180 + mag / 2,
        });
    }
  }

  private situationTerrainColor(gm: GameMap, tile: TileRef): Colord {
    const mag = gm.magnitude(tile);
    if (gm.isShore(tile)) {
      return this.opsShore;
    }
    switch (gm.terrainType(tile)) {
      case TerrainType.Ocean:
      case TerrainType.Lake: {
        // Near-black sea with a whisper of depth: shallows barely lighter
        // than the abyss, shoreline water a hairline so coasts still cut.
        if (gm.isShoreline(tile) && gm.isWater(tile)) {
          return this.opsShorelineWater;
        }
        const w = this.darkWater.rgba;
        if (mag < 10) {
          return colord({
            r: Math.max(w.r + Math.floor((9 - mag) / 2), 0),
            g: Math.max(w.g + Math.floor((9 - mag) / 2), 0),
            b: Math.max(w.b + (9 - mag), 0),
          });
        }
        return this.darkWater;
      }
      // Land is a RECESSIVE dark warm ground with elevation as faint
      // luminance — roughly L 38-64 of 255, a fifth of the stock ramp. The
      // terrain must READ (coastlines, mountain spines) without ever
      // competing with a territory fill.
      // Dark but ALIVE (the first pass went monochrome and read as boring):
      // each terrain keeps a real HUE at low value — olive plains, umber
      // highlands, pale grey-blue mountain spines ridging toward ~L130 at the
      // peaks. Character without ever competing with a seat colour.
      // v5 — "B+", picked by the owner off a live 5-way comparison on the
      // real board (design/frames/terrain-picks/). His notes, in order:
      // v4's warm charcoal was "still brown terrain"; variant B (dark
      // cartographic) won but "still only has two colors. the earth map has
      // more than that. so B+".
      //
      // Why a plain elevation ramp CANNOT satisfy that on these maps,
      // measured on the Black Sea fixture: 47.7% of all land is magnitude 0
      // and ~25% is magnitude >= 30 — nearly three quarters of the pixels sit
      // in the ramp's two endpoint colours no matter what the middle does.
      // So v5 does two things a ramp alone cannot:
      //
      //  - REGIONAL VARIETY: the lowland mass is blended between forest
      //    green, olive steppe and dry tan by smooth two-octave value noise
      //    (~90-tile wavelength) — the way a real map varies by biome, not
      //    just by height. Deterministic in tile coordinates, so every
      //    playback of every match renders identically.
      //  - QUANTILE BANDS: the elevation stops sit where this terrain's
      //    magnitudes actually live, ending in a RESTRAINED stone (peak 126,
      //    not white) because a quarter of the land wears the top colour.
      //
      // Per-tile jitter (stronger on the flat lowlands) breaks the remaining
      // large fields into organic texture. Everything stays muted and dark:
      // the sixteen seat colours keep sole ownership of saturation.
      case TerrainType.Plains:
      case TerrainType.Highland:
      case TerrainType.Mountain: {
        const x = gm.x(tile);
        const y = gm.y(tile);
        const region =
          0.65 * situationValueNoise(x, y, 90) +
          0.35 * situationValueNoise(x + 500, y + 911, 37);
        const low =
          region < 0.5
            ? mixRgb(SITU_FOREST, SITU_STEPPE, region * 2)
            : mixRgb(SITU_STEPPE, SITU_DRY, (region - 0.5) * 2);
        let c: [number, number, number];
        if (mag <= 6) {
          c = segRgb(mag, 0, 6, low, mixRgb(low, [82, 74, 46], 0.6));
        } else if (mag <= 12) {
          c = segRgb(mag, 6, 12, mixRgb(low, [82, 74, 46], 0.6), [88, 74, 46]);
        } else if (mag <= 19) {
          c = segRgb(mag, 12, 19, [88, 74, 46], [104, 84, 56]);
        } else if (mag <= 26) {
          c = segRgb(mag, 19, 26, [104, 84, 56], [110, 104, 92]);
        } else {
          c = segRgb(mag, 26, 31, [110, 104, 92], [126, 124, 116]);
        }
        const jitter =
          (situationHash(x * 7 + 3, y * 11 + 5) - 0.5) * (mag <= 3 ? 8 : 4);
        return colord({
          r: Math.round(c[0] + jitter),
          g: Math.round(c[1] + jitter * 0.9),
          b: Math.round(c[2] + jitter * 0.6),
        });
      }
    }
  }
}
