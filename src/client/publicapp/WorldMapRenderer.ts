import {
  WORLD_GRID_HEIGHT,
  WORLD_GRID_RLE,
  WORLD_GRID_THEATRES,
  WORLD_GRID_WIDTH,
} from "./WorldMapGrid";
import type { WorldTheatreId } from "./WorldModelSchema";

/**
 * Paints the `/world` Earth at tile resolution (one pixel per World-map
 * 1/16 tile); the page upscales it with `image-rendering: pixelated`, so the
 * map keeps the game's own pixel geography. Sea stays transparent — the
 * ocean is CSS behind the canvas.
 */

export const SEA = 255;

interface DecodedGrid {
  readonly width: number;
  readonly height: number;
  /** Region theatre index per tile (into `regionIds`), or `SEA`. */
  readonly tiles: Uint8Array;
  /** Bit 1: touches another region. Bit 2: touches the sea. */
  readonly edges: Uint8Array;
  /** Deterministic per-tile texture in [-1, 1]. */
  readonly grain: Float32Array;
  readonly regionIds: readonly WorldTheatreId[];
}

let decoded: DecodedGrid | null = null;

export function worldGrid(): DecodedGrid {
  if (decoded !== null) return decoded;
  const letters = Object.keys(WORLD_GRID_THEATRES) as Array<
    keyof typeof WORLD_GRID_THEATRES
  >;
  const regionIds = letters.map((letter) => WORLD_GRID_THEATRES[letter]);
  const width = WORLD_GRID_WIDTH;
  const height = WORLD_GRID_HEIGHT;
  const tiles = new Uint8Array(width * height).fill(SEA);
  const rows = WORLD_GRID_RLE.split("|");
  rows.forEach((row, y) => {
    let x = 0;
    let digits = "";
    for (const char of row) {
      if (char >= "0" && char <= "9") {
        digits += char;
        continue;
      }
      const run = digits === "" ? 1 : parseInt(digits, 10);
      digits = "";
      const index = letters.indexOf(char as keyof typeof WORLD_GRID_THEATRES);
      const value = index === -1 ? SEA : index;
      tiles.fill(value, y * width + x, y * width + x + run);
      x += run;
    }
  });
  const edges = new Uint8Array(width * height);
  const grain = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const value = tiles[i];
      // Integer hash → stable texture, identical on every load.
      let h = Math.imul(x + 1, 0x27d4eb2d) ^ Math.imul(y + 1, 0x165667b1);
      h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
      grain[i] = ((h >>> 8) & 0xffff) / 0x7fff - 1;
      if (value === SEA) continue;
      let mask = 0;
      const neighbours = [
        x > 0 ? tiles[i - 1] : SEA,
        x < width - 1 ? tiles[i + 1] : SEA,
        y > 0 ? tiles[i - width] : SEA,
        y < height - 1 ? tiles[i + width] : SEA,
      ];
      for (const neighbour of neighbours) {
        if (neighbour === SEA) mask |= 2;
        else if (neighbour !== value) mask |= 1;
      }
      edges[i] = mask;
    }
  }
  decoded = { width, height, tiles, edges, grain, regionIds };
  return decoded;
}

export type Rgb = readonly [number, number, number];

export interface FrontPaint {
  /** `null` paints the theatre as unclaimed land. */
  readonly fill: Rgb | null;
  /** Challenger colour for a contested front's siege stripes. */
  readonly stripe: Rgb | null;
  readonly quiet: boolean;
  /** Pulsing outline: changed hands since the visitor's last visit. */
  readonly changed: boolean;
}

export interface WorldFrame {
  readonly fronts: Partial<Record<WorldTheatreId, FrontPaint>>;
  /** Hovered/selected theatre; every other theatre is dimmed while set. */
  readonly focus: WorldTheatreId | null;
  /** Animation phase in [0, 1) — siege stripes drift, change outlines pulse. */
  readonly phase: number;
}

const UNCLAIMED: Rgb = [40, 50, 64];
const QUIET_MIX: Rgb = [52, 62, 78];
const OUTLINE: Rgb = [255, 244, 214];

function mix(a: Rgb, b: Rgb, t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Writes one frame into `target` (`width × height` RGBA). */
export function paintWorldFrame(
  target: Uint8ClampedArray,
  frame: WorldFrame,
): void {
  const grid = worldGrid();
  const { width, height, tiles, edges, grain, regionIds } = grid;
  const stripeShift = Math.floor(frame.phase * 9);
  const pulse = 0.5 + 0.5 * Math.sin(frame.phase * Math.PI * 2);
  const paints = regionIds.map((id) => frame.fronts[id] ?? null);
  const focusIndex = frame.focus === null ? -1 : regionIds.indexOf(frame.focus);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      const index = tiles[i];
      if (index === SEA) {
        target[o + 3] = 0;
        continue;
      }
      const paint = paints[index];
      const edge = edges[i];
      let color: [number, number, number];
      if (paint === null || paint.fill === null) {
        color = [...UNCLAIMED] as [number, number, number];
        const g = grain[i] * 7;
        color[0] += g;
        color[1] += g;
        color[2] += g * 1.2;
      } else {
        let base: Rgb = paint.fill;
        // Thin challenger-coloured hatching: a siege should read at a glance
        // without drowning the holder's colour.
        if (paint.stripe !== null && (x + y + stripeShift) % 9 < 2) {
          base = mix(paint.fill, paint.stripe, 0.85);
        }
        color = paint.quiet
          ? mix(base, QUIET_MIX, 0.62)
          : ([...base] as [number, number, number]);
        const shade = 1 + grain[i] * (paint.quiet ? 0.035 : 0.06);
        color[0] *= shade;
        color[1] *= shade;
        color[2] *= shade;
      }
      if (edge & 1) {
        color[0] *= 0.62;
        color[1] *= 0.62;
        color[2] *= 0.68;
      } else if (edge & 2) {
        color = mix(color, [255, 255, 255], 0.16);
      }
      if (paint?.changed === true && edge !== 0) {
        color = mix(color, OUTLINE, 0.35 + 0.55 * pulse);
      }
      if (focusIndex !== -1) {
        if (index === focusIndex) {
          color = mix(color, [255, 255, 255], 0.1);
        } else {
          color[0] *= 0.55;
          color[1] *= 0.55;
          color[2] *= 0.6;
        }
      }
      target[o] = color[0];
      target[o + 1] = color[1];
      target[o + 2] = color[2];
      target[o + 3] = 255;
    }
  }
}

/**
 * Theatre under a point given as fractions of the map's width/height.
 * Snaps to the nearest land within a few tiles, so a thumb on the sea next
 * to Britannia or the Japanese islands still lands on the front.
 */
export function theatreAtPoint(fx: number, fy: number): WorldTheatreId | null {
  const { width, height, tiles, regionIds } = worldGrid();
  const cx = Math.floor(fx * width);
  const cy = Math.floor(fy * height);
  let best: number = SEA;
  let bestDistance = Number.POSITIVE_INFINITY;
  const radius = 5;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const value = tiles[y * width + x];
      if (value === SEA) continue;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = value;
      }
    }
  }
  return best === SEA ? null : regionIds[best];
}
