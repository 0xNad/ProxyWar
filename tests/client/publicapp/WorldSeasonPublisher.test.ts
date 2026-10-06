/**
 * `/world` mounted on what the real Season 2 publisher writes. Games in the
 * contract-B shape go through `publishFrontierWorld` and
 * `buildFrontierForm`, and the page reads the files that come out, so the
 * two sides cannot drift apart unnoticed: the booking that moves on as
 * soon as a slot passes, the form's two windows (results over 30 days,
 * speed and length over the 7 before), the full Season 1 note, the English
 * `sentence` the page does not show, and a watch link that may be a raw
 * replay file.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { buildFrontierForm } from "../../../src/server/agents/FrontierForm";
import {
  FRONTIER_SEASON_ONE_NOTE,
  FRONTIER_SEASON_TWO_TEAMS,
  publishFrontierWorld,
} from "../../../src/server/agents/FrontierFourWorld";
import { installEnglish, removeEnglish } from "./EnglishLangSelector";
import {
  card,
  memoryStorage,
  mount,
  serve,
  settle,
  text,
} from "./WorldPageHarness";

const MODELS: Record<string, string> = {
  Astra: "openai/gpt-6-astra",
  Fable: "anthropic/claude-fable-5.1",
  Opus: "anthropic/claude-opus-5.5",
  Gemini: "google/gemini-3.1-pro-preview",
  Grok: "x-ai/grok-4.7",
};
const LABELS = Object.keys(MODELS);
const MAPS = ["EastAsia", "Europe", "Oceania"];
const FRONT_NAMES: Record<string, string> = {
  EastAsia: "East Asia",
  Europe: "Europe",
  Oceania: "Oceania",
};
const TODAY_ID = "ereq_14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6";

/** One Season 1 game, trimmed from the real games file (Grok won it). */
const SEASON_ONE_GAME = {
  schemaVersion: 1,
  experienceRequestId: "xreq_a444ab57-1e5f-43f2-838d-adb3b5515ad1",
  episodeRequestId: "ereq_1b1c1dbe-087c-40c2-b55a-653570f84937",
  variantId: "teams-4x3-asia",
  map: "Asia",
  mapSize: "Normal",
  completedAt: "2026-10-04T15:23:54.346910Z",
  replayUrl:
    "https://softmax-public.s3.amazonaws.com/replays/26d4381e-4a4f-4079-8b79-c47e83d8df73.replay",
  cycle: 1,
  teams: [
    {
      label: "Astra",
      model: "openai/gpt-6-astra",
      team: "Green",
      slots: [3, 4, 7],
    },
    {
      label: "Fable",
      model: "anthropic/claude-fable-5.1",
      team: "Red",
      slots: [0, 10, 11],
    },
    {
      label: "Gemini",
      model: "google/gemini-3.1-pro-preview",
      team: "Blue",
      slots: [1, 6, 8],
    },
    { label: "Grok", model: "x-ai/grok-4.7", team: "Yellow", slots: [2, 5, 9] },
  ],
  winnerTeam: "Yellow",
  turnCount: 20900,
  decisionCount: 2248,
  degradedCount: 166,
};

/**
 * One Season 2 games-file line. Grok thinks 30 s a plan and fails 4 plans
 * a game until a week before Oct 6, then 10 s and none; everyone else
 * thinks 10 s and fails none.
 */
function game(index: number, at: string, winner: string | null) {
  const map = MAPS[index % MAPS.length];
  const oldGrok = at < "2026-09-29";
  const order = [
    ...(winner === null ? [] : [winner]),
    ...LABELS.filter((label) => label !== winner),
  ];
  return {
    schemaVersion: 2,
    season: 2,
    format: "ffa",
    experienceRequestId: `xreq_s2_${index}`,
    episodeRequestId: at.startsWith("2026-10-06")
      ? TODAY_ID
      : `ereq_s2_${index}`,
    variantId: `ffa5-${map.toLowerCase()}`,
    map,
    mapSize: "Compact",
    frontLabel: FRONT_NAMES[map],
    completedAt: at,
    replayUrl: `https://softmax-public.s3.amazonaws.com/replays/s2-${index}.replay`,
    viewerUrl: null,
    costUsd: 2.4,
    cycle: 1,
    gameIndex: index,
    episodeIndex: index,
    sides: LABELS.map((label, slot) => ({
      label,
      model: MODELS[label],
      team: null,
      slots: [slot],
      pickOrder: ((slot + index) % LABELS.length) + 1,
    })),
    winnerLabel: winner,
    winType: winner === null ? "none" : "points",
    standings: order.map((label, rank) => ({
      label,
      landShare: rank === 0 ? 0.38 : 0.12,
      tilesOwned: rank === 0 ? 61000 : 19000,
      isAlive: true,
      eliminatedAtTurn: null,
      rank: rank + 1,
    })),
    turnCount: 24000,
    decisionCount: 1200,
    degradedCount: 10,
    telemetry: Object.fromEntries(
      LABELS.map((label) => [
        label,
        {
          plans: 17,
          planFailures: label === "Grok" && oldGrok ? 4 : 0,
          timeouts: 0,
          latencyMsMedian: label === "Grok" && oldGrok ? 30000 : 10000,
          latencyMsP90: null,
          outputTokensMedian: 800,
          inputTokensMedian: 6000,
          reasoningTokensMedian: null,
          usd: 0.4,
          capped: false,
        },
      ]),
    ),
    voices: at.startsWith("2026-10-06")
      ? [
          {
            label: "Opus",
            kind: "dispatch",
            to: null,
            turn: 1200,
            text: "Holding the coast and building ports first.",
          },
          {
            label: "Grok",
            kind: "message",
            to: "Opus",
            turn: 2400,
            text: "Our border is quiet. Keep it that way?",
          },
        ]
      : [],
    moments: [],
    harness: {
      playerVersion: "2.0.0",
      planEvery: 15,
      plansPerSeat: 17,
      reasoning: "low",
      maxOutputTokens: 3000,
    },
  };
}

/**
 * Two battles a day from Sep 22 to Oct 5, finishing 41 minutes after the
 * 13:00 and 19:00 slots; Grok wins 20 of the 28. With `today`, Opus also
 * wins Oct 6's 13:00 battle.
 */
function games(today: boolean) {
  const lines = [];
  let index = 0;
  for (let day = 22; day <= 35; day++) {
    const date = new Date(Date.UTC(2026, 8, day)).toISOString().slice(0, 10);
    for (const time of ["13:41", "19:41"]) {
      const winner = index < 20 ? "Grok" : LABELS[index % 4];
      lines.push(game(index, `${date}T${time}:00.000Z`, winner));
      index += 1;
    }
  }
  if (today) lines.push(game(index, "2026-10-06T13:41:00.000Z", "Opus"));
  return lines;
}

let dir = "";

/** What the publisher writes at `now`: world.json and the form beside it. */
async function publish(now: string, today: boolean) {
  const siteDir = await mkdtemp(path.join(dir, "site-"));
  const gamesPath = path.join(siteDir, "frontier-ffa-games.jsonl");
  const seasonOnePath = path.join(siteDir, "frontier-four-games.jsonl");
  await writeFile(
    gamesPath,
    games(today)
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  await writeFile(seasonOnePath, `${JSON.stringify(SEASON_ONE_GAME)}\n`);
  const publication = await publishFrontierWorld({
    siteDir,
    gamesPath,
    seasonOneGamesPath: seasonOnePath,
    now,
    timesUtc: ["13:00", "19:00"],
  });
  const form = buildFrontierForm(publication.records, {
    now,
    teams: publication.teams,
  });
  return {
    world: JSON.parse(await readFile(publication.worldPath, "utf8")) as Record<
      string,
      unknown
    >,
    // Through JSON, as the page fetches it.
    form: JSON.parse(JSON.stringify(form)) as Record<string, unknown>,
  };
}

const ZONE = process.env.TZ;
beforeAll(async () => {
  process.env.TZ = "UTC";
  dir = await mkdtemp(path.join(tmpdir(), "frontier-world-page-"));
});
afterAll(async () => {
  if (ZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  installEnglish();
  window.history.replaceState(null, "", "/world");
});

afterEach(() => {
  document.body.innerHTML = "";
  removeEnglish();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("world-page on the real Season 2 publisher's files", () => {
  it("says the 13:00 battle is due while it is fought, though the publisher already books 19:00", async () => {
    // The publisher re-runs when the UTC hour turns, right after the slot.
    const { world, form } = await publish("2026-10-06T13:00:30.000Z", false);
    expect(world.schedule).toEqual({
      timesUtc: ["13:00", "19:00"],
      nextBattleAt: "2026-10-06T19:00:00.000Z",
    });
    serve(world, form);
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-06T13:20:00.000Z"),
    });
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-pill-next"))).toBe(
      "Battle due 13:00 UTC · result soon",
    );
  });

  it("names the next battle once the result is in, and tells the latest battle", async () => {
    const { world, form } = await publish("2026-10-06T13:42:00.000Z", true);
    serve(world, form);
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-06T14:00:00.000Z"),
    });
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-pill-next"))).toBe(
      "Next battle 19:00 UTC · in 5 h",
    );
    const latest = el.querySelector(".wp-latest");
    expect(text(latest?.querySelector(".wp-latest-result"))).toBe(
      "Claude Opus 5.5 won on points: the most land, 38%, when time ran out. Watch the replay",
    );
    // The publisher offers the raw replay file; the page links the battle.
    expect(
      latest?.querySelector(".wp-latest-watch")?.getAttribute("href"),
    ).toBe(`/match/${TODAY_ID}`);
    expect(
      [...(latest?.querySelectorAll(".wp-voice") ?? [])].map((voice) =>
        text(voice),
      ),
    ).toEqual([
      "“Holding the coast and building ports first.” Claude Opus 5.5, to everyone watching",
      "“Our border is quiet. Keep it that way?” Grok 4.7, to Claude Opus 5.5",
    ]);
  });

  it("shows the Season 1 note whole", async () => {
    const { world, form } = await publish("2026-10-06T13:42:00.000Z", true);
    expect(FRONTIER_SEASON_ONE_NOTE.length).toBeGreaterThan(240);
    serve(world, form);
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-06T14:00:00.000Z"),
    });
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-recap"))).toBe(
      `Season 1: Grok 4.7 won 1 of 1 team battle. ${FRONTIER_SEASON_ONE_NOTE}`,
    );
  });

  it("reads the Nerf Watch: the result against 30 days, the brain scan against the week before", async () => {
    const { world, form } = await publish("2026-10-06T13:42:00.000Z", true);
    const grokForm = (form.models as Array<Record<string, unknown>>).find(
      (entry) => entry.label === "Grok",
    );
    expect(grokForm?.trailing).toMatchObject({ days: 30, speedDays: 7 });
    serve(world, form);
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-06T14:00:00.000Z"),
    });
    const el = mount();
    await settle(el);
    expect(
      [...el.querySelectorAll(".wp-form-name")].map((name) => text(name)),
    ).toEqual(FRONTIER_SEASON_TWO_TEAMS.map((team) => team.displayName));
    const grok = card(el, "Grok 4.7");
    expect(text(grok?.querySelector(".wp-form-day"))).toBe(
      "Today: no wins in 1 battle, 12% of the land on average.",
    );
    // 20 wins in the 28 battles before today: a loss happens 29% of days.
    expect(text(grok?.querySelector(".wp-form-chance"))).toBe(
      "At its usual win rate (71%), a day this bad or worse happens on 29% of days.",
    );
    expect(text(grok?.querySelector(".wp-form-tag"))).toBe("Thinking as usual");
    // Think time and failures of the 7 days before (10 s, none failed), not
    // the 30 (which would read 20 s and 12%).
    expect(
      [...(grok?.querySelectorAll(".wp-form-scan tr") ?? [])].map((tr) =>
        [...tr.children].map((cell) => text(cell)),
      ),
    ).toEqual([
      ["", "Today", "Last 7 days"],
      ["Time to think", "10 s", "10 s"],
      ["Answer length in tokens, thinking included", "800", "800"],
      ["Failed plans", "0 of 17", "0%"],
    ]);
    // The publisher's English summary is not shown; the page says it.
    const section = el.querySelector('[aria-labelledby="wp-form-title"]');
    expect(text(section)).not.toMatch(/Won \d of|the week before/);
    expect(text(section)).not.toMatch(/nerfed|weaker/i);
  });
});
