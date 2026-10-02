/**
 * "The war so far": the reigns each front's row is drawn from, and the ink
 * a holder's name is written in on their banner.
 */
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../../../src/client/publicapp/HomePresentation";
import {
  bannerInk,
  historyRows,
} from "../../../src/client/publicapp/WorldHistory";

const day = (date: string, holders: Record<string, string | null>) => ({
  day: date,
  holders,
});

describe("historyRows", () => {
  it("groups each front's days into reigns, the Crown first", () => {
    const rows = historyRows([
      day("2026-09-27", { asia: "Alpha", crown: "Andre" }),
      day("2026-09-28", { asia: "Matt", crown: "relh" }),
      day("2026-09-29", { asia: "Matt", crown: "relh" }),
    ]);
    expect(rows[0].id).toBe("crown");
    expect(rows).toHaveLength(11);
    expect(rows.find((row) => row.id === "asia")?.reigns).toEqual([
      { holder: "Alpha", from: 0, to: 0 },
      { holder: "Matt", from: 1, to: 2 },
    ]);
    // A front missing from every day is one unbroken stretch with no holder.
    expect(rows.find((row) => row.id === "africa")?.reigns).toEqual([
      { holder: null, from: 0, to: 2 },
    ]);
  });
});

describe("bannerInk", () => {
  it("writes on a banner in whichever ink reads at 4.5:1", () => {
    // Bright banners take dark ink, dark banners light ink.
    expect(bannerInk("#ffd23f")).toEqual({ ink: "#0b1220", plated: false });
    expect(bannerInk("#2b1d6b")).toEqual({ ink: "#edf1f7", plated: false });
  });

  it("puts the name on a plate where neither ink reads well enough", () => {
    // Mid blue: 3.9:1 with dark ink, 4.0:1 with light.
    expect(contrastRatio("#2f78c6", "#0b1220")).toBeLessThan(4.5);
    expect(contrastRatio("#2f78c6", "#edf1f7")).toBeLessThan(4.5);
    expect(bannerInk("#2f78c6")).toEqual({ ink: "#edf1f7", plated: true });
  });
});
