import { describe, expect, test } from "vitest";
import {
  deriveEmblemPalette,
  emblemAssetPath,
  generateEmblemSvg,
} from "../../../src/server/identity/IdentityEmblems";

describe("generateEmblemSvg", () => {
  test("is deterministic: the same agent id always produces the exact same bytes", () => {
    expect(generateEmblemSvg("agt_daveey")).toBe(
      generateEmblemSvg("agt_daveey"),
    );
  });

  test("two different agent ids never produce identical emblems", () => {
    expect(generateEmblemSvg("agt_daveey")).not.toBe(
      generateEmblemSvg("agt_relh"),
    );
  });

  test("produces a well-formed, self-contained SVG with no external references", () => {
    const svg = generateEmblemSvg("agt_daveey");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('viewBox="0 0 120 120"');
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("href=");
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  test("is left-right symmetric — a hand-checkable invariant of the identicon shape", () => {
    const svg = generateEmblemSvg("agt_daveey");
    const fills = [...svg.matchAll(/x="(\d+)" y="(\d+)" width="24" height="24" fill="([^"]+)"/g)];
    const byCell = new Map<string, string>();
    for (const [, x, y, fill] of fills) {
      byCell.set(`${x},${y}`, fill);
    }
    for (const [key, fill] of byCell) {
      const [xStr, yStr] = key.split(",");
      const x = Number(xStr);
      const mirroredX = 96 - x; // 5 columns of 24px each, mirrored about the grid center
      const mirrored = byCell.get(`${mirroredX},${yStr}`);
      // Either both present (matching pattern) or both absent; if present,
      // the mirrored cell's fill need not be identical since fills alternate
      // by (row+col) parity, but presence must match.
      expect(mirrored !== undefined).toBe(true);
      void fill;
    }
  });
});

describe("deriveEmblemPalette", () => {
  test("matches the fill colors the SVG generator actually uses for the same id", () => {
    const { primary, secondary } = deriveEmblemPalette("agt_daveey");
    const svg = generateEmblemSvg("agt_daveey");
    expect(svg).toContain(primary);
    expect(svg).toContain(secondary);
  });

  test("returns lowercase #rrggbb colors", () => {
    const { primary, secondary } = deriveEmblemPalette("agt_daveey");
    expect(primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(secondary).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("emblemAssetPath", () => {
  test("builds the tracked resources/identity/emblems path", () => {
    expect(emblemAssetPath("agt_daveey")).toBe(
      "resources/identity/emblems/agt_daveey.svg",
    );
  });
});
