/**
 * `/world` in Season 2 of the Frontier: above the fold a newcomer reads
 * what this is, who leads, when the next battle is (not "Paused" between
 * the two daily battles) and how the latest one ended in the models' own
 * words; below the fronts, the Nerf Watch reads `frontier-form.json` and
 * disappears when that file is missing or malformed. A Frontier Four world
 * renders as it did. Mounted into jsdom with the real English strings and
 * a pinned clock, as the other public page tests are.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { installEnglish, removeEnglish } from "./EnglishLangSelector";
import { worldFixture } from "./WorldFixtures";
import {
  card,
  memoryStorage,
  mount,
  serve,
  settle,
  text,
} from "./WorldPageHarness";
import {
  frontierFormFixture,
  SEASON_TWO_NOW,
  SEASON_TWO_VIEWER_URL,
  seasonTwoWorld,
} from "./WorldSeasonFixtures";

const ZONE = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (ZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: SEASON_TWO_NOW });
  vi.stubGlobal("localStorage", memoryStorage());
  installEnglish();
  window.history.replaceState(null, "", "/world");
  serve(seasonTwoWorld(), frontierFormFixture());
});

afterEach(() => {
  document.body.innerHTML = "";
  removeEnglish();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("world-page, Season 2", () => {
  it("says what this is, who leads and when the next battle is, never Paused", async () => {
    const el = mount();
    await settle(el);
    const eyebrow = el.querySelector(".wp-eyebrow");
    expect(text(eyebrow?.firstElementChild)).toBe(
      "Five frontier AI models fight over this map. One nation each, same rules, same number of moves to think.",
    );
    expect(text(el.querySelector(".wp-pill-next"))).toBe(
      "Next battle 19:00 UTC · in 3 h",
    );
    expect(text(el.querySelector(".wp-feed"))).toBe(
      "Next battle 19:00 UTC · in 3 h Last battle 2 h 19 min ago",
    );
    expect(text(el.querySelector("h1"))).toBe("Grok 4.7 is winning.");
    expect(text(el.querySelector(".wp-support"))).toBe(
      "It holds 2 of the 10 fronts: Europe and East Asia.",
    );
    expect(text(el)).not.toMatch(/Paused|Four frontier|three nations/);
  });

  it("tells the latest battle: where, who won and how, the final order and three of the models' own lines", async () => {
    const el = mount();
    await settle(el);
    const latest = el.querySelector(".wp-latest");
    expect(text(latest?.querySelector("h2"))).toBe(
      "Latest battle East Asia 2 h 19 min ago",
    );
    expect(text(latest?.querySelector(".wp-latest-result"))).toBe(
      "Grok 4.7 won on points: the most land, 38%, when time ran out. Watch the replay",
    );
    expect(
      latest?.querySelector<HTMLAnchorElement>(".wp-latest-watch")?.href,
    ).toBe(SEASON_TWO_VIEWER_URL);
    expect(
      [...(latest?.querySelectorAll(".wp-standing") ?? [])].map((entry) =>
        text(entry),
      ),
    ).toEqual([
      "Grok 4.7 38%",
      "Claude Opus 5.5 24%",
      "Gemini 3.1 Pro 19%",
      "Claude Fable 5.1 12%",
      "GPT-6 Astra knocked out",
    ]);
    const voices = [...(latest?.querySelectorAll(".wp-voice") ?? [])];
    expect(voices.map((voice) => text(voice))).toEqual([
      "“Holding the coast and building ports first. Whoever comes for Kyushu pays for every tile.” Claude Opus 5.5, to everyone watching",
      "“Quiet expansion in the south. No one has noticed yet.” Gemini 3.1 Pro, to everyone watching",
      "“Fields first, swords later. Now it is later.” Grok 4.7, to everyone watching",
    ]);
    // The link in Grok's line never reaches the page.
    expect(el.innerHTML).not.toContain("www.example.com");
  });

  it("never links the raw replay file: the battle's own page instead", async () => {
    const world = seasonTwoWorld();
    serve({
      ...world,
      latestBattle: {
        ...(world.latestBattle as Record<string, unknown>),
        watchHref:
          "https://softmax-public.s3.amazonaws.com/replays/f3f30384-987d-4461-af05-9f28c01b154d.replay",
      },
    });
    const el = mount();
    await settle(el);
    expect(el.querySelector(".wp-latest-watch")?.getAttribute("href")).toBe(
      "/match/ereq_ea2",
    );
  });

  it("recaps Season 1 in one plain line and invites builders in the hero", async () => {
    const el = mount();
    await settle(el);
    const recap = el.querySelector(".wp-recap");
    expect(text(recap)).toBe(
      "Season 1: Grok 4.7 won 25 of 37 team battles, Gemini 3.1 Pro won 7, Claude Fable 5.1 won 3, and GPT-6 Astra won 2. Season 1 was not a fair test. Grok always picked its starting spot last because seats went in name order, and the two most expensive models often ran out of budget to think partway through a game. Season 2 rotates who picks first and lets every model think the same number of times.",
    );
    expect(recap?.querySelector("a")).toBeNull();
    const cta = el.querySelector(".wp-hero .wp-cta");
    expect(text(cta)).toBe(
      "Think your agent could hold a front? These five run the same code with only the model swapped. Start yours from the open starter and test it on Softmax Observatory.",
    );
    expect(
      [...(cta?.querySelectorAll("a") ?? [])].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual([
      "https://github.com/0xNad/proxywar-coworld-starter",
      "https://softmax.com/observatory",
    ]);
  });

  it("words the fronts, rules, dispatches and powers for one model per nation and the latest battle deciding", async () => {
    const el = mount();
    await settle(el);
    const page = text(el);
    expect(page).toContain(
      "Each front belongs to the model that won its latest battle. A battle with no winner keeps the holder.",
    );
    expect(page).toContain("The latest battle decides each front");
    expect(page).not.toMatch(
      /last 1 battles|1 of the last 1|1 wins? to 0|under siege|agent with/,
    );
    const row = (name: string) =>
      [...el.querySelectorAll(".wp-row")].find(
        (entry) => text(entry.querySelector(".wp-row-name")) === name,
      );
    expect(text(row("East Asia")?.querySelector(".wp-row-race"))).toBe(
      "Won the latest battle here",
    );
    expect(text(row("Black Sea")?.querySelector(".wp-row-race"))).toBe(
      "Kept it: the latest battle had no winner",
    );
    expect(text(el.querySelector(".wp-dispatch-text"))).toBe(
      "Grok 4.7 took East Asia from Claude Opus 5.5.",
    );
    expect(text(el.querySelector(".wp-powers thead th"))).toBe("Model");
    const opus = [...el.querySelectorAll(".wp-powers tbody tr")].find((tr) =>
      text(tr).includes("Claude Opus 5.5"),
    );
    expect(text(opus?.querySelector(".wp-power-provider"))).toBe("Anthropic");
    expect(el.querySelector("canvas.wp-map")?.getAttribute("aria-label")).toBe(
      "World map coloured by the model holding each front",
    );
  });

  it("fetches frontier-form.json beside world.json and shows a Nerf Watch card per model", async () => {
    const el = mount();
    await settle(el);
    expect(fetch).toHaveBeenCalledWith(
      "/ai-league-runs/league/frontier-form.json",
      expect.objectContaining({ cache: "no-store" }),
    );
    const section = el.querySelector('[aria-labelledby="wp-form-title"]');
    expect(text(section?.querySelector("h2"))).toBe("Nerf Watch");
    expect(text(section?.querySelector(".wp-form-method"))).toBe(
      "Same prompt, same tools, same number of plans for every model. One battle is one sample; one bad day is usually luck.",
    );
    // The world's roster order, each named in full with its maker.
    expect(
      [...el.querySelectorAll(".wp-form-head")].map((head) =>
        text(head).replace(
          / (Thinking as usual|Slower than usual|Too few.*)$/,
          "",
        ),
      ),
    ).toEqual([
      "GPT-6 Astra OpenAI",
      "Claude Fable 5.1 Anthropic",
      "Claude Opus 5.5 Anthropic",
      "Gemini 3.1 Pro Google",
      "Grok 4.7 xAI",
    ]);
    // Every sentence is the page's own, from the numbers; the publisher's
    // English summary is not shown.
    const astra = card(el, "GPT-6 Astra");
    expect(text(astra?.querySelector(".wp-form-day"))).toBe(
      "Today: no wins in 1 battle, 0% of the land on average.",
    );
    expect(text(astra?.querySelector(".wp-form-chance"))).toBe(
      "At its usual win rate (8%), a day this bad or worse happens on 92% of days.",
    );
    const fable = card(el, "Claude Fable 5.1");
    expect(text(fable?.querySelector(".wp-form-chance"))).toBe(
      "At its usual win rate (25%), a day this bad or worse happens on 75% of days.",
    );
    const grok = card(el, "Grok 4.7");
    expect(text(grok?.querySelector(".wp-form-chance"))).toBe(
      "That is at or above its usual win rate (58%).",
    );
    // The tag speaks for think time, length and failures only.
    expect(text(grok?.querySelector(".wp-form-tag"))).toBe("Thinking as usual");
    expect(text(section)).not.toMatch(/Won \d of|Speed:|the week before/);
    const opus = card(el, "Claude Opus 5.5");
    expect(text(opus?.querySelector(".wp-form-tag"))).toBe(
      "Too few battles to judge",
    );
    expect(text(opus?.querySelector(".wp-form-chance"))).toBe(
      "Too few battles so far (4 of the 10 needed) to tell luck from a change.",
    );
    // A speed shift is called a speed shift.
    expect(
      text(card(el, "Gemini 3.1 Pro")?.querySelector(".wp-form-tag")),
    ).toBe("Slower than usual");
    expect(text(section)).not.toMatch(/nerfed|weaker/i);
  });

  it("reads each model's brain scan against the week before, not the 30-day results window", async () => {
    const el = mount();
    await settle(el);
    const scan = card(el, "Claude Fable 5.1")?.querySelector(".wp-form-scan");
    expect(text(scan?.querySelector("caption"))).toBe("Brain scan");
    expect(
      [...(scan?.querySelectorAll("tr") ?? [])].map((tr) =>
        [...tr.children].map((cell) => text(cell)),
      ),
    ).toEqual([
      ["", "Today", "Last 7 days"],
      ["Time to think", "13 s", "13 s"],
      ["Answer length in tokens, thinking included", "810", "802"],
      ["Failed plans", "2 of 17", "6%"],
    ]);
    const astra = card(el, "GPT-6 Astra")?.querySelector(".wp-form-scan");
    expect(text(astra?.querySelectorAll("tbody tr")[0])).toBe(
      "Time to think 3.3 s 3.3 s",
    );
    // The way in, again, under the cards.
    expect(
      el.querySelector('[aria-labelledby="wp-form-title"] .wp-cta a')
        ?.textContent,
    ).toBe("the open starter");
  });

  it("leaves the Nerf Watch out when frontier-form.json is missing, and keeps the rest", async () => {
    serve(seasonTwoWorld(), null);
    const el = mount();
    await settle(el);
    expect(el.querySelector('[aria-labelledby="wp-form-title"]')).toBeNull();
    expect(el.querySelector(".wp-form-card")).toBeNull();
    expect(el.querySelector(".wp-latest")).not.toBeNull();
    expect(el.querySelector(".wp-hero .wp-cta")).not.toBeNull();
    expect(el.querySelectorAll(".wp-row")).toHaveLength(11);
  });

  it("leaves the Nerf Watch out when frontier-form.json is malformed", async () => {
    serve(seasonTwoWorld(), { schemaVersion: 1, models: "soon" });
    const el = mount();
    await settle(el);
    expect(el.querySelector('[aria-labelledby="wp-form-title"]')).toBeNull();
    expect(el.querySelector("h1")).not.toBeNull();
  });

  it("states the timetable when no battle is booked, and renders without any Season 2 extras", async () => {
    serve(
      seasonTwoWorld({
        schedule: { timesUtc: ["13:00", "19:00"], nextBattleAt: null },
      }),
    );
    let el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-pill-next"))).toBe(
      "Battles daily at 13:00 and 19:00 UTC",
    );
    el.remove();

    const bare = seasonTwoWorld();
    delete bare.schedule;
    delete bare.seasonOneRecap;
    delete bare.latestBattle;
    delete bare.season;
    serve(bare);
    el = mount();
    await settle(el);
    expect(text(el.querySelector("h1"))).toBe("Grok 4.7 is winning.");
    expect(el.querySelector(".wp-latest")).toBeNull();
    expect(el.querySelector(".wp-recap")).toBeNull();
    // No timetable to read: measured liveness, as before.
    expect(text(el.querySelector(".wp-feed"))).toBe(
      "Live Last battle 2 h 19 min ago",
    );
  });

  it("names the battle due while it is fought, though the booking has moved on", async () => {
    // The publisher ran at 19:00:30 and already books tomorrow's 13:00.
    serve(
      seasonTwoWorld({
        schedule: {
          timesUtc: ["13:00", "19:00"],
          nextBattleAt: "2026-10-07T13:00:00.000Z",
        },
      }),
    );
    vi.setSystemTime(new Date("2026-10-06T19:20:00.000Z"));
    let el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-pill-next"))).toBe(
      "Battle due 19:00 UTC · result soon",
    );
    el.remove();

    // Its result is in: the next slot is a promise again.
    serve(
      seasonTwoWorld({
        lastBattleAt: "2026-10-06T19:41:00.000Z",
        schedule: {
          timesUtc: ["13:00", "19:00"],
          nextBattleAt: "2026-10-07T13:00:00.000Z",
        },
      }),
    );
    vi.setSystemTime(new Date("2026-10-06T19:50:00.000Z"));
    el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-pill-next"))).toBe(
      "Next battle 13:00 UTC · in 17 h",
    );
  });
});

describe("world-page, Frontier Four (Season 1)", () => {
  it("renders as before: no Nerf Watch, no form fetch, measured liveness", async () => {
    serve(
      worldFixture({
        mode: "frontier-four",
        teams: [
          { label: "Astra", model: "openai/gpt-6-astra" },
          { label: "Fable", model: "anthropic/claude-fable-5.1" },
          { label: "Gemini", model: "google/gemini-3.1-pro-preview" },
          { label: "Grok", model: "x-ai/grok-4.7" },
        ],
      }),
      frontierFormFixture(),
    );
    vi.setSystemTime(new Date("2026-09-29T22:10:00.000Z"));
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-eyebrow"))).toBe(
      "Four frontier models fight over this map: Astra, Fable, Gemini, and Grok. Each fields three nations, and the team holds the ground. Live Last battle 22 min ago",
    );
    expect(fetch).not.toHaveBeenCalledWith(
      "/ai-league-runs/league/frontier-form.json",
      expect.anything(),
    );
    expect(el.querySelector('[aria-labelledby="wp-form-title"]')).toBeNull();
    expect(el.querySelector(".wp-latest")).toBeNull();
    expect(el.querySelector(".wp-cta")).toBeNull();
    expect(text(el.querySelector(".wp-powers thead th"))).toBe("Team");
    expect(text(el)).toContain("Most wins of the last 12 holds the front");
  });
});
