/**
 * "The war so far": the reigns each front's row is drawn from, and the ink
 * a holder's name is written in on their banner.
 */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contrastRatio } from "../../../src/client/publicapp/HomePresentation";
import {
  bannerInk,
  historyRows,
  renderFrontTimeline,
} from "../../../src/client/publicapp/WorldHistory";
import type { WorldView } from "../../../src/client/publicapp/WorldView";
import { installEnglish, removeEnglish } from "./EnglishLangSelector";

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

describe("renderFrontTimeline", () => {
  beforeEach(() => installEnglish());
  afterEach(() => removeEnglish());

  /** A front's bar as its sheet draws it, every holder on one banner colour. */
  function draw(color: string, holders: readonly string[]): HTMLElement {
    const view = {
      model: {
        timeline: holders.map((holder, index) =>
          day(`2026-09-${String(20 + index).padStart(2, "0")}`, {
            asia: holder,
          }),
        ),
      },
      label: (name: string) => name,
      bannerColor: () => color,
    } as unknown as WorldView;
    const host = document.createElement("div");
    render(renderFrontTimeline(view, "asia"), host);
    return host;
  }

  it("writes names on mid-tone banners on a plate, in light ink", () => {
    const run = draw("#2f78c6", ["Alpha", "Alpha"]).querySelector(".wp-tl-run");
    expect(run?.classList).toContain("wp-tl-plated");
    expect(run?.getAttribute("style")).toContain("--t:#edf1f7");
    const bright = draw("#ffd23f", ["Alpha", "Alpha"]).querySelector(
      ".wp-tl-run",
    );
    expect(bright?.classList).not.toContain("wp-tl-plated");
    expect(bright?.getAttribute("style")).toContain("--t:#0b1220");
  });

  it("names the longest reign in its caption, past or still going", () => {
    const caption = (holders: readonly string[]) =>
      (draw("#ffd23f", holders).querySelector("figcaption")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
    expect(caption(["Alpha", "Alpha", "Matt"])).toBe(
      "Who held it at the end of each day since Sep 20. 2 agents have held it, Alpha the longest: 2 days from Sep 20.",
    );
    // Of equally long reigns, the latest.
    expect(caption(["Alpha", "Matt", "Matt", "Alpha", "Alpha"])).toBe(
      "Who held it at the end of each day since Sep 20. 2 agents have held it, Alpha the longest: 2 days so far, since Sep 23.",
    );
  });
});
