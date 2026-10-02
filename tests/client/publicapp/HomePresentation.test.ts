import { describe, expect, it } from "vitest";
import {
  clearestSiege,
  contrastRatio,
  exampleFront,
  frontsInState,
  holderGroups,
  latestTakeover,
  leaderCaveats,
  preciseAge,
  warDay,
  watchEvent,
} from "../../../src/client/publicapp/HomePresentation";
import { assignBannerColors } from "../../../src/client/publicapp/WorldPresentation";
import { worldFixture } from "./WorldFixtures";

const NOW = Date.parse("2026-09-29T22:10:00.000Z");

describe("preciseAge", () => {
  it("stays precise while the news is fresh and coarsens with age", () => {
    expect(preciseAge("2026-09-29T22:09:40.000Z", NOW)).toEqual({ key: "now" });
    expect(preciseAge("2026-09-29T21:58:00.000Z", NOW)).toEqual({
      key: "minutes",
      minutes: 12,
    });
    expect(preciseAge("2026-09-29T20:41:00.000Z", NOW)).toEqual({
      key: "hours_minutes",
      hours: 1,
      minutes: 29,
    });
    expect(preciseAge("2026-09-29T20:10:00.000Z", NOW)).toEqual({
      key: "hours",
      hours: 2,
    });
    expect(preciseAge("2026-09-29T05:10:00.000Z", NOW)).toEqual({
      key: "hours",
      hours: 17,
    });
    expect(preciseAge("2026-09-26T22:10:00.000Z", NOW)).toEqual({
      key: "days",
      days: 3,
    });
    expect(preciseAge("2026-08-11T00:00:00.000Z", NOW)).toEqual({
      key: "date",
      iso: "2026-08-11T00:00:00.000Z",
    });
  });
});

describe("front page selections", () => {
  it("picks the newest change of hands to watch, or nothing when there is none", () => {
    expect(latestTakeover(worldFixture())?.episodeRequestId).toBe("ereq_cr0");
    const sieges = worldFixture();
    sieges.events = sieges.events.filter((event) => event.kind === "siege");
    expect(latestTakeover(sieges)).toBeNull();
  });

  it("ranks holders by fronts held, then by their most recent battle", () => {
    const groups = holderGroups(worldFixture());
    expect(groups.map((group) => group.holder)).toEqual(["Alpha", "Matt Van"]);
    expect(groups[1].fronts.map((front) => front.id)).toEqual(["asia"]);

    const model = worldFixture();
    const europe = model.theatres.find((theatre) => theatre.id === "europe");
    if (europe) {
      europe.status = "held";
      europe.holder = "Matt Van";
    }
    // A single leader comes first even when another holder fought later.
    expect(holderGroups(model)[0].holder).toBe("Matt Van");
  });

  it("sorts fronts into the map's display states", () => {
    const model = worldFixture();
    expect(frontsInState(model, "contested", NOW).map((f) => f.id)).toEqual([
      "asia",
    ]);
    expect(frontsInState(model, "unclaimed", NOW)).toHaveLength(8);
    expect(
      frontsInState(model, "quiet", Date.parse("2026-10-20T00:00:00.000Z")).map(
        (f) => f.id,
      ),
    ).toEqual(["asia", "oceania"]);
  });

  it("teaches the rule with a siege when there is one, else the freshest held front", () => {
    expect(exampleFront(worldFixture(), NOW)?.id).toBe("asia");
    const model = worldFixture();
    const asia = model.theatres.find((theatre) => theatre.id === "asia");
    if (asia) asia.status = "held";
    expect(exampleFront(model, NOW)?.id).toBe("oceania");
    const empty = worldFixture();
    for (const theatre of empty.theatres) theatre.window = [];
    expect(exampleFront(empty, NOW)).toBeNull();
  });

  it("finds the siege whose colours are easiest to tell apart", () => {
    const model = worldFixture();
    const colors = assignBannerColors(model);
    const colorOf = (name: string | null) =>
      name === null ? "#64748b" : (colors.get(name) ?? "#94a3b8");
    expect(clearestSiege(model, colorOf, NOW)?.id).toBe("asia");
    const calm = worldFixture();
    for (const theatre of calm.theatres) {
      if (theatre.status === "contested") theatre.status = "held";
    }
    expect(clearestSiege(calm, colorOf, NOW)).toBeNull();
  });

  it("counts the days of the war from the first battle", () => {
    expect(warDay(worldFixture(), NOW)).toBe(75);
    expect(warDay(worldFixture({ firstBattleAt: null }), NOW)).toBeNull();
  });
});

describe("the hero's news and caveats", () => {
  it("watches the newest change of hands from the last day, else the newest event", () => {
    const model = worldFixture();
    // The Crown changed hands on 28 Sep: more than a day before NOW.
    expect(watchEvent(model, NOW)?.episodeRequestId).toBe("ereq_asia5");
    expect(
      watchEvent(model, Date.parse("2026-09-28T20:00:00.000Z"))
        ?.episodeRequestId,
    ).toBe("ereq_cr0");
    expect(watchEvent(worldFixture({ events: [] }), NOW)).toBeNull();
  });

  it("names a leader's siege first, then a front nobody has fought on for weeks", () => {
    const model = worldFixture();
    const europe = model.theatres.find((theatre) => theatre.id === "europe");
    if (europe) {
      europe.status = "held";
      europe.holder = "Matt Van";
      europe.lastBattleAt = "2026-08-11T00:00:00.000Z";
    }
    expect(
      leaderCaveats(model, "Matt Van", NOW).map(
        (caveat) => `${caveat.kind}:${caveat.front.id}`,
      ),
    ).toEqual(["siege:asia", "quiet:europe"]);
    expect(leaderCaveats(model, "Alpha", NOW)).toEqual([]);
  });

  it("measures contrast the WCAG way", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    // richard's banner on the ocean: too dark for a mark on its own.
    expect(contrastRatio("#4d2fc6", "#071225")).toBeLessThan(3);
    expect(contrastRatio("#ffd23f", "#071225")).toBeGreaterThan(3);
    expect(contrastRatio("not-a-colour", "#071225")).toBeNull();
  });
});
