/**
 * Component coverage for the front page (`/`): it reads only `world.json`,
 * says who is winning in one sentence (leader, tie, scattered, empty) with
 * the lead's weak spots, tags every held front on the map and letters the
 * never-fought ones, never drops the Crown, links every takeover to its
 * match page, works the rule through on a real front's battles, shows only
 * measured liveness, and hands builders a prompt for their coding agent.
 * Uses the real `translateText()` against a minimal `<lang-selector>` that
 * carries the real English strings, so the assertions read like the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/HomePage";
import type { HomePage } from "../../../src/client/publicapp/HomePage";
import type { WorldModel } from "../../../src/client/publicapp/WorldModelSchema";
import { installEnglish, removeEnglish } from "./EnglishLangSelector";
import { worldFixture } from "./WorldFixtures";

/** The fixture's moment: 22 minutes after its newest battle. */
const NOW = new Date("2026-09-29T22:10:00.000Z");

/** In-memory `localStorage`, independent of whether Node/jsdom provides one. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
  };
}

function serve(model: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(model)),
  );
}

function mount(): HomePage {
  const el = document.createElement("home-page") as HomePage;
  document.body.append(el);
  return el;
}

async function settle(el: HomePage): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await el.updateComplete;
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Matt Van also holds Europe: a single leader with two fronts. */
function leaderFixture(): WorldModel {
  const model = worldFixture();
  const europe = model.theatres.find((theatre) => theatre.id === "europe");
  if (europe) {
    europe.status = "held";
    europe.holder = "Matt Van";
    europe.heldSince = "2026-09-20T10:00:00.000Z";
    europe.lastBattleAt = "2026-09-29T10:00:00.000Z";
  }
  return model;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.stubGlobal("localStorage", memoryStorage());
  installEnglish();
  serve(leaderFixture());
});

afterEach(() => {
  document.body.innerHTML = "";
  removeEnglish();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("home-page", () => {
  it("reads world.json and says what this is and who is winning, with the lead's weak spot", async () => {
    const el = mount();
    await settle(el);

    expect(fetch).toHaveBeenCalledWith(
      "/ai-league-runs/league/world.json",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(text(el.querySelector(".hp-context"))).toBe(
      "AI agents, each built by a person, fight over this map.",
    );
    expect(text(el.querySelector("h1"))).toBe("Matt Van is winning.");
    expect(
      el.querySelector<HTMLAnchorElement>("h1 .hp-lead")?.getAttribute("href"),
    ).toBe("/agent/matt-van");
    expect(text(el.querySelector(".hp-support"))).toBe(
      "It holds 2 of the 10 fronts: Europe and Asia. In Asia, relh has drawn level at 2 wins each.",
    );
    expect(el.querySelector("canvas.hp-map-canvas")).not.toBeNull();
    // The account link comes from world.json, not the 10 MB read model.
    expect(
      el.querySelector<HTMLAnchorElement>(
        'header a[href="https://proxywar.xyz/account"]',
      ),
    ).not.toBeNull();
    expect(el.querySelector('a.hp-skip[href="#hp-map"]')).not.toBeNull();
    expect(document.title).toBe("Proxy War: AI agents at war for the world");
  });

  it("shows only measured liveness: a live pill, the newest battle's age and the day of the war", async () => {
    const el = mount();
    await settle(el);
    const clock = el.querySelector(".hp-clock-desktop");
    expect(clock?.querySelector(".hp-pill-live")).not.toBeNull();
    expect(text(clock)).toContain("Last battle 22 min ago");
    expect(text(clock)).toContain("41 battles in the last 24 h");
    expect(text(clock)).toContain("Day 75 of the war");
    // The configured round schedule is never offered as proof of activity.
    expect(text(el)).not.toMatch(/every 40 min|around the clock/);
  });

  it("calls a feed with no battle for hours paused, without promising more", async () => {
    serve(worldFixture({ lastBattleAt: "2026-09-29T12:00:00.000Z" }));
    const el = mount();
    await settle(el);
    const clock = el.querySelector(".hp-clock-desktop");
    expect(clock?.querySelector(".hp-pill-paused")).not.toBeNull();
    expect(clock?.querySelector(".hp-pill-live")).toBeNull();
    expect(text(clock)).toContain(
      "Last battle 10 h ago. The map moves again when battles do.",
    );
    expect(text(clock)).not.toContain("Day ");
  });

  it("tags every held front, letters the never-fought ones and seals the Crown", async () => {
    const el = mount();
    await settle(el);

    const marks = [...el.querySelectorAll<HTMLAnchorElement>(".hp-mark")];
    expect(marks.map((mark) => mark.getAttribute("href")).sort()).toEqual([
      "/world#front-asia",
      "/world#front-europe",
      "/world#front-oceania",
    ]);
    const asia = marks.find(
      (mark) => mark.getAttribute("href") === "/world#front-asia",
    );
    expect(asia?.dataset.state).toBe("contested");
    expect(text(asia)).toContain("relh drew level, 2–2");
    expect(asia?.getAttribute("aria-label")).toBe(
      "Asia: held by Matt Van, under siege by relh at 2 wins each. Open it on the world map.",
    );
    // Emblems are images, never injected markup.
    expect(
      asia
        ?.querySelector<HTMLImageElement>(".hp-flag img")
        ?.getAttribute("src"),
    ).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(el.querySelector(".hp-flag svg")).toBeNull();
    expect(el.querySelectorAll(".hp-open")).toHaveLength(7);
    expect(text(el.querySelector(".hp-seal"))).toContain("relh");
    expect(text(el.querySelector(".hp-seal"))).toContain(
      "Decided on whole-world maps",
    );
  });

  it("names each front's state in words in the legend, not by hatching alone", async () => {
    const el = mount();
    await settle(el);
    const rows = [...el.querySelectorAll(".hp-legend-list li")].map(text);
    expect(rows[0]).toContain("Matt Van");
    expect(rows[0]).toContain("Asia (under siege)");
    expect(rows.some((row) => row.includes("The Crown"))).toBe(true);
    expect(rows[rows.length - 1]).toContain("Never fought");
  });

  it("opens the newest news from the watch button and links every dispatch", async () => {
    const el = mount();
    await settle(el);

    // The last change of hands is more than a day old, so the newest event wins.
    const watch = el.querySelector<HTMLAnchorElement>(
      ".hp-actions .hp-btn-secondary",
    );
    expect(watch?.getAttribute("href")).toBe("/match/ereq_asia5");
    expect(text(watch)).toBe("Watch the siege of Asia");

    const events = [...el.querySelectorAll<HTMLAnchorElement>(".hp-latest a")];
    expect(events.map((event) => event.getAttribute("href"))).toEqual([
      "/match/ereq_asia5",
      "/match/ereq_cr0",
    ]);
    expect(text(events[0].querySelector(".hp-event"))).toBe(
      "relh put Asia under siege: 2 wins each with Matt Van.",
    );
    expect(text(events[1].querySelector(".hp-event"))).toBe(
      "relh took the Crown from Andre von Houck on Pangaea, 4 wins to 3.",
    );
  });

  it("works the rule through on a real front's battles, each linked to its match", async () => {
    const el = mount();
    await settle(el);

    const example = el.querySelector(".hp-example");
    expect(text(example?.querySelector(".hp-example-title"))).toBe(
      "Asia: last 5 battles",
    );
    const cells = [...(example?.querySelectorAll(".hp-window li") ?? [])];
    expect(cells.map((cell) => cell.className)).toEqual([
      "hp-holder",
      "hp-challenger",
      "hp-none",
      "hp-holder",
      "hp-challenger",
    ]);
    expect(cells[0].querySelector("a")?.getAttribute("href")).toBe(
      "/match/ereq_asia1",
    );
    expect(cells[2].querySelector("a")?.getAttribute("aria-label")).toBe(
      "Battle 3 of 5: no winner. Watch it.",
    );
    expect(text(example?.querySelector(".hp-example-verdict"))).toBe(
      "Tied at 2, so Matt Van keeps Asia and the front is under siege.",
    );
  });

  it("hands builders one prompt for their coding agent, and copies it", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const el = mount();
    await settle(el);

    const prompt = text(el.querySelector(".hp-prompt code"));
    expect(prompt).toContain(
      "Set me up to build a ProxyWar agent using the official starter: https://github.com/0xNad/proxywar-coworld-starter",
    );
    expect(prompt).toContain("wait for my explicit approval");
    // No promise that a newcomer can take a front nobody fights on.
    expect(text(el.querySelector(".hp-enter"))).not.toContain(
      "never been fought",
    );
    el.querySelector<HTMLButtonElement>(".hp-copy")?.click();
    await settle(el);
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("ProxyWar agent"),
    );
    expect(text(el.querySelector(".hp-prompt-bar [role=status]"))).toBe(
      "Copied. Paste it into your coding agent.",
    );
  });

  it("says when the clipboard is blocked instead of pretending it copied", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: vi.fn(async () => Promise.reject(new Error("denied"))),
      },
    });
    const el = mount();
    await settle(el);
    el.querySelector<HTMLButtonElement>(".hp-copy")?.click();
    await settle(el);
    expect(text(el.querySelector(".hp-prompt-bar [role=status]"))).toBe(
      "Your browser blocked copying. Select the prompt and copy it.",
    );
  });

  it("tells a returning visitor how many fronts changed hands", async () => {
    localStorage.setItem(
      "proxywar.home.lastVisit",
      JSON.stringify({
        at: "2026-09-29T20:10:00.000Z",
        holders: { asia: "Alpha", oceania: "Alpha", crown: "relh" },
      }),
    );
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".hp-since"))).toBe(
      "One front changed hands since you were here 2 h ago.",
    );
    // The visit is stored under the front page's own key, never /world's.
    expect(localStorage.getItem("proxywar.world.lastVisit")).toBeNull();
  });

  it("names a tie, a scattered world and an empty one honestly, and never drops the Crown", async () => {
    const tied = leaderFixture();
    const africa = tied.theatres.find((theatre) => theatre.id === "africa");
    if (africa) {
      africa.status = "held";
      africa.holder = "Alpha";
      africa.heldSince = "2026-09-29T10:00:00.000Z";
    }
    serve(tied);
    let el = mount();
    await settle(el);
    expect(text(el.querySelector("h1"))).toBe(
      "Alpha and Matt Van share the lead.",
    );
    document.body.innerHTML = "";

    serve(worldFixture());
    el = mount();
    await settle(el);
    expect(text(el.querySelector("h1"))).toBe("No agent is ahead.");
    expect(text(el.querySelector(".hp-support"))).toBe(
      "2 agents hold one front each. The first to hold two takes the lead.",
    );
    document.body.innerHTML = "";

    const empty = worldFixture({ events: [], lastBattleAt: null });
    for (const theatre of empty.theatres) {
      theatre.holder = null;
      theatre.status = "unclaimed";
      theatre.window = [];
    }
    serve(empty);
    el = mount();
    await settle(el);
    expect(text(el.querySelector("h1"))).toBe(
      "The war has not reached the map yet.",
    );
    expect(el.querySelectorAll(".hp-mark")).toHaveLength(0);
    expect(text(el.querySelector(".hp-latest .hp-empty"))).toBe(
      "No takeovers yet. When a front changes hands, it appears here.",
    );
    expect(el.querySelector(".hp-example")).toBeNull();
    expect(text(el.querySelector(".hp-seal"))).toContain("Vacant");
    // With no battles at all there is nothing to watch yet.
    expect(el.querySelector(".hp-actions .hp-btn-secondary")).toBeNull();
    expect(text(el.querySelector(".hp-clock-desktop"))).toBe("No battles yet");
  });

  it("falls back to watching any battle when nothing has happened on the fronts", async () => {
    serve(worldFixture({ events: [] }));
    const el = mount();
    await settle(el);
    const watch = el.querySelector<HTMLAnchorElement>(
      ".hp-actions .hp-btn-secondary",
    );
    expect(watch?.getAttribute("href")).toBe("/watch");
    expect(text(watch)).toBe("Watch a battle");
  });

  it("shows a retryable error with ways onward when world.json cannot be loaded or fails validation", async () => {
    serve({ schemaVersion: 2 });
    const el = mount();
    await settle(el);
    expect(text(el.querySelector('[role="alert"]'))).toContain(
      "The league state did not load.",
    );
    expect(el.querySelector(".hp-map")).toBeNull();
    const onward = [
      ...el.querySelectorAll<HTMLAnchorElement>(".hp-error-actions a"),
    ].map((a) => a.getAttribute("href"));
    expect(onward).toEqual(["/league", "/watch"]);
    // The account link never depends on league data.
    expect(
      el.querySelector('header a[href="https://proxywar.xyz/account"]'),
    ).not.toBeNull();
  });

  it("names the counting window when the data itself is old, and says zero after a quiet day", async () => {
    serve(
      worldFixture({
        generatedAt: "2026-09-29T12:00:00.000Z",
        lastBattleAt: "2026-09-29T11:00:00.000Z",
      }),
    );
    let el = mount();
    await settle(el);
    expect(text(el.querySelector(".hp-clock-desktop"))).toMatch(
      /41 battles in the 24 h to /,
    );
    document.body.innerHTML = "";

    serve(worldFixture({ lastBattleAt: "2026-09-28T21:00:00.000Z" }));
    el = mount();
    await settle(el);
    expect(text(el.querySelector(".hp-clock-desktop"))).toContain(
      "No battles in the last 24 h",
    );
  });

  it("calls a single claimed front a lead, and words an unopposed hold and other maps truthfully", async () => {
    const model = worldFixture({
      events: [
        {
          kind: "held",
          theatreId: "oceania",
          at: "2026-09-29T21:47:01.932Z",
          episodeRequestId: "ereq_oc9",
          map: "Australia",
          agent: "Alpha",
          rival: null,
          agentWins: 3,
          rivalWins: 0,
          href: "/match/ereq_oc9",
        },
        {
          kind: "conquest",
          theatreId: "crown",
          at: "2026-09-29T21:00:00.000Z",
          episodeRequestId: "ereq_cr9",
          map: "GiantWorldMap",
          agent: "relh",
          rival: "Andre von Houck",
          agentWins: 4,
          rivalWins: 3,
          href: "/match/ereq_cr9",
        },
      ],
    });
    const asia = model.theatres.find((theatre) => theatre.id === "asia");
    if (asia) {
      asia.holder = null;
      asia.status = "unclaimed";
    }
    serve(model);
    const el = mount();
    await settle(el);
    expect(text(el.querySelector("h1"))).toBe("Alpha is winning.");
    expect(text(el.querySelector(".hp-support"))).toBe(
      "It holds 1 of the 10 fronts: Oceania.",
    );
    const events = [...el.querySelectorAll(".hp-latest .hp-event")].map(text);
    expect(events).toEqual([
      "Alpha held Oceania on Australia with 3 wins and no challenger left.",
      "relh took the Crown from Andre von Houck on Giant World Map, 4 wins to 3.",
    ]);
  });
});
