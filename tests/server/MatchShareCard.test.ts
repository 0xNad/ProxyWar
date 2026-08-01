import { describe, expect, it } from "vitest";
import { renderMatchShareCardSvg } from "../../src/server/agents/MatchShareCard";

describe("renderMatchShareCardSvg", () => {
  it("pre-match (result: null) never contains a winner name or placement text", () => {
    const svg = renderMatchShareCardSvg({
      matchId: "feat_abc",
      title: "Alpha vs Bravo",
      mapLabel: "Pangaea",
      participants: ["Alpha", "Bravo"],
      result: null,
    });
    expect(svg).toContain("Alpha");
    expect(svg).toContain("Bravo");
    expect(svg).not.toContain("wins");
    expect(svg).not.toMatch(/#\d+ /);
    expect(svg).toContain("data-match-id=\"feat_abc\"");
  });

  it("post-match (real result) shows the winner and placements", () => {
    const svg = renderMatchShareCardSvg({
      matchId: "feat_abc",
      title: "Alpha vs Bravo",
      mapLabel: "Pangaea",
      participants: ["Alpha", "Bravo"],
      result: {
        winnerName: "Alpha",
        placements: [
          { name: "Alpha", placement: 1 },
          { name: "Bravo", placement: 2 },
        ],
      },
    });
    expect(svg).toContain("Alpha wins");
    expect(svg).toContain("#1 Alpha");
    expect(svg).toContain("#2 Bravo");
  });

  it("post-match with no known winner (draw/undetermined) never fabricates one", () => {
    const svg = renderMatchShareCardSvg({
      matchId: "feat_x",
      title: "Alpha vs Bravo",
      mapLabel: "Pangaea",
      participants: ["Alpha", "Bravo"],
      result: { winnerName: null, placements: [] },
    });
    expect(svg).toContain("Match complete");
    expect(svg).not.toContain("wins");
  });

  it("escapes XML-unsafe characters in every text field", () => {
    const svg = renderMatchShareCardSvg({
      matchId: "feat_esc",
      title: 'A & B <script>',
      mapLabel: "Map",
      participants: ['<Alpha>&"Bravo"'],
      result: null,
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&lt;");
  });

  it("is well-formed, single-root SVG with the standard og:image dimensions", () => {
    const svg = renderMatchShareCardSvg({
      matchId: "feat_dim",
      title: "T",
      mapLabel: "M",
      participants: ["A"],
      result: null,
    });
    expect(svg).toContain('width="1200" height="630"');
    expect(svg.trim().startsWith("<?xml")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
  });
});
