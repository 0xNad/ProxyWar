import { createHash } from "node:crypto";

/**
 * Deterministic geometric SVG emblems, seeded by an Agent's own stable `id`
 * — spec Stage 1 item 5: "For unknown metadata: deterministic geometric SVG
 * emblem derived from stable Agent ID." Same id always produces the exact
 * same SVG bytes (verified by the schema test), so regenerating never
 * produces spurious diffs for agents whose id hasn't changed, and two
 * different agents never collide on the same emblem — colors are paired
 * with `displayName` + `shortCode` everywhere they render (spec item 8:
 * "Colors are never the sole identity signal"), never used to distinguish
 * agents on their own.
 */

const VIEWBOX_SIZE = 120;
const GRID = 5;
const CELL = VIEWBOX_SIZE / GRID;

/** Splitmix32 — small, dependency-free, deterministic across Node versions (unlike `Math.random`, which this repo's `src/core` rules already forbid for exactly this reason). */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 0x100000000;
  };
}

function seedFromAgentId(agentId: string): number {
  const digest = createHash("sha256").update(agentId).digest();
  return digest.readUInt32BE(0);
}

/** Same palette a generated SVG uses for `agentId` — call this to keep `AgentProfile.primaryColor`/`secondaryColor` in lockstep with the emblem's own fill colors (both start from the identical fresh seed, so the first two random draws — hue, then secondary hue — always match). */
export function deriveEmblemPalette(agentId: string): {
  primary: string;
  secondary: string;
} {
  return paletteFromSeed(splitmix32(seedFromAgentId(agentId)));
}

/** Hue-rotated pair, generated (not curated) so every agent's palette is deterministic from the same seed as its shape — never hand-picked, never color-only identity (see module doc). */
function paletteFromSeed(random: () => number): {
  primary: string;
  secondary: string;
} {
  const hue = Math.floor(random() * 360);
  const secondaryHue = (hue + 40 + Math.floor(random() * 60)) % 360;
  return {
    primary: hslToHex(hue, 0.62, 0.48),
    secondary: hslToHex(secondaryHue, 0.55, 0.4),
  };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r0, g0, b0] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const toHex = (channel: number) =>
    Math.round((channel + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r0)}${toHex(g0)}${toHex(b0)}`;
}

/**
 * A left-right symmetric 5x5 grid of filled squares — the classic
 * identicon shape (deterministic, always renders as a recognizable blob,
 * never accidentally blank or a single dot). Only the left 3 columns are
 * randomized; columns 4-5 mirror columns 2-1.
 */
function symmetricGridCells(random: () => number): boolean[][] {
  const halfWidth = Math.ceil(GRID / 2);
  const cells: boolean[][] = [];
  for (let row = 0; row < GRID; row++) {
    const rowCells: boolean[] = [];
    for (let col = 0; col < halfWidth; col++) {
      rowCells.push(random() > 0.45);
    }
    for (let col = halfWidth; col < GRID; col++) {
      rowCells.push(rowCells[GRID - 1 - col]);
    }
    cells.push(rowCells);
  }
  return cells;
}

/** Renders the emblem for `agentId`. Pure and deterministic — same id, same bytes, forever. */
export function generateEmblemSvg(agentId: string): string {
  const random = splitmix32(seedFromAgentId(agentId));
  const { primary, secondary } = paletteFromSeed(random);
  const cells = symmetricGridCells(random);
  const shapeMode = random() > 0.5 ? "square" : "diamond";

  const rects: string[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (!cells[row][col]) continue;
      const x = col * CELL;
      const y = row * CELL;
      const fill = (row + col) % 2 === 0 ? primary : secondary;
      rects.push(
        shapeMode === "square"
          ? `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" fill="${fill}"/>`
          : `<polygon points="${x + CELL / 2},${y} ${x + CELL},${y + CELL / 2} ${x + CELL / 2},${y + CELL} ${x},${y + CELL / 2}" fill="${fill}"/>`,
      );
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}" role="img" aria-hidden="true">`,
    `<rect width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" fill="#0f172a"/>`,
    ...rects,
    `</svg>`,
  ].join("");
}

/** Path this Agent's emblem lives at, relative to the repo root — matches `EmblemRef.assetPath` in `IdentitySchemas.ts`. */
export function emblemAssetPath(agentId: string): string {
  return `resources/identity/emblems/${agentId}.svg`;
}
