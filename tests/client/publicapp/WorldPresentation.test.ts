import { describe, expect, it } from "vitest";
import {
  assignBannerColors,
  changedSinceVisit,
  feedState,
  frontDisplayState,
  frontPaints,
  hueOf,
  parseVisitSnapshot,
  relativeAge,
  visitSnapshot,
  WORLD_BANNER_PALETTE,
  worldVerdict,
} from "../../../src/client/publicapp/WorldPresentation";
import { worldFixture } from "./WorldFixtures";

const NOW = Date.parse("2026-09-29T22:10:00.000Z");

describe("assignBannerColors", () => {
  it("gives every agent on the map a distinct banner colour, even when their identity colours nearly match", () => {
    const model = worldFixture();
    const colors = assignBannerColors(model);
    // Matt Van (#bc2fc6) and Alpha (#c62fc4) are near-identical purples.
    expect(colors.get("Matt Van")).not.toBe(colors.get("Alpha"));
    const assigned = [...colors.values()];
    expect(new Set(assigned).size).toBe(assigned.length);
    for (const color of assigned) {
      expect(WORLD_BANNER_PALETTE).toContain(color);
    }
  });

  it("keeps each colour close to the agent's own hue and is deterministic", () => {
    const model = worldFixture();
    const first = assignBannerColors(model);
    expect(assignBannerColors(model)).toEqual(first);
    // relh's identity colour is orange (#c66b2f); its banner stays warm.
    const hue = hueOf(first.get("relh") ?? "") ?? -1;
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(60);
  });
});

describe("front states and verdict", () => {
  it("reads a front with no battle for two weeks as quiet", () => {
    const model = worldFixture();
    const asia = model.theatres.find((theatre) => theatre.id === "asia");
    expect(asia && frontDisplayState(asia, NOW)).toBe("contested");
    expect(
      asia && frontDisplayState(asia, Date.parse("2026-10-20T00:00:00.000Z")),
    ).toBe("quiet");
    const africa = model.theatres.find((theatre) => theatre.id === "africa");
    expect(africa && frontDisplayState(africa, NOW)).toBe("unclaimed");
  });

  it("names a single leader, a tie, or a scattered world — never counting the Crown as territory", () => {
    expect(worldVerdict(worldFixture())).toEqual({
      kind: "scattered",
      claimed: 2,
    });
    const model = worldFixture();
    const oceania = model.theatres.find((theatre) => theatre.id === "oceania");
    if (oceania) oceania.holder = "Matt Van";
    expect(worldVerdict(model)).toEqual({
      kind: "leader",
      name: "Matt Van",
      fronts: 2,
      claimed: 2,
    });
    const tied = worldFixture();
    for (const theatre of tied.theatres) {
      if (theatre.id === "europe" || theatre.id === "asia")
        theatre.holder = "Matt Van";
      if (theatre.id === "oceania" || theatre.id === "africa")
        theatre.holder = "Alpha";
    }
    expect(worldVerdict(tied)).toMatchObject({
      kind: "tied",
      names: ["Alpha", "Matt Van"],
      fronts: 2,
    });
    const empty = worldFixture();
    for (const theatre of empty.theatres) theatre.holder = null;
    expect(worldVerdict(empty)).toEqual({ kind: "empty" });
  });

  it("calls the feed paused when the newest battle is hours old", () => {
    const model = worldFixture();
    expect(feedState(model, NOW).kind).toBe("live");
    expect(feedState(model, Date.parse("2026-10-01T13:00:00.000Z")).kind).toBe(
      "paused",
    );
    expect(feedState(worldFixture({ lastBattleAt: null }), NOW).kind).toBe(
      "empty",
    );
  });

  it("formats compact ages", () => {
    expect(relativeAge("2026-09-29T22:09:30.000Z", NOW).unit).toBe("now");
    expect(relativeAge("2026-09-29T21:58:00.000Z", NOW)).toMatchObject({
      unit: "m",
      value: 12,
    });
    expect(relativeAge("2026-09-29T17:10:00.000Z", NOW)).toMatchObject({
      unit: "h",
      value: 5,
    });
    expect(relativeAge("2026-09-26T22:10:00.000Z", NOW)).toMatchObject({
      unit: "d",
      value: 3,
    });
    expect(relativeAge("2026-08-01T00:00:00.000Z", NOW).unit).toBe("date");
  });
});

describe("frontPaints", () => {
  it("fills held fronts, hatches sieges with the challenger, mutes quiet ones and skips the Crown", () => {
    const model = worldFixture();
    const colors = assignBannerColors(model);
    const rgb = (name: string) => {
      const hex = colors.get(name) ?? "";
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const paints = frontPaints(model, colors, NOW, { changed: ["oceania"] });
    expect(paints.asia).toEqual({
      fill: rgb("Matt Van"),
      stripe: rgb("relh"),
      quiet: false,
      changed: false,
    });
    expect(paints.oceania).toMatchObject({
      fill: rgb("Alpha"),
      stripe: null,
      changed: true,
    });
    expect(paints.africa).toMatchObject({ fill: null, stripe: null });
    expect(paints.crown).toBeUndefined();

    const later = frontPaints(
      model,
      colors,
      Date.parse("2026-10-20T00:00:00.000Z"),
    );
    expect(later.asia).toMatchObject({ quiet: true, stripe: null });

    const hidden = frontPaints(model, colors, NOW, { revealed: () => false });
    expect(hidden.asia).toMatchObject({ fill: null, stripe: null });
  });
});

describe("since your last visit", () => {
  it("lists fronts whose holder changed, ignoring first visits and newly unclaimed fronts", () => {
    const model = worldFixture();
    expect(changedSinceVisit(model, null)).toEqual([]);
    const previous = {
      at: "2026-09-27T00:00:00.000Z",
      holders: { asia: "Alpha", oceania: "Alpha", crown: "relh", africa: null },
    };
    expect(changedSinceVisit(model, previous)).toEqual(["asia"]);
    expect(
      parseVisitSnapshot(JSON.stringify(visitSnapshot(model)))?.holders.asia,
    ).toBe("Matt Van");
    expect(parseVisitSnapshot("not json")).toBeNull();
    expect(parseVisitSnapshot(null)).toBeNull();
  });
});
