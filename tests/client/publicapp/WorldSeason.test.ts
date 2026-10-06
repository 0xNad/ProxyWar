/**
 * Season 2's pure rules and wire validation: the new `world.json` fields
 * are optional and dropped one by one when malformed (never failing the
 * page), `frontier-form.json` is optional altogether, a model's words are
 * cleaned again before they are shown, and the schedule only promises the
 * battle the publisher booked.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fetchFrontierForm,
  FrontierFormSchema,
  WorldModelSchema,
  type FormModel,
  type WorldVoice,
} from "../../../src/client/publicapp/WorldModelSchema";
import {
  battleFront,
  displayNameOf,
  latestFormDay,
  orderedStandings,
  pickVoices,
  providerOf,
  publicText,
  scanWindowDays,
  scheduleStatus,
  trailingFailureRate,
  utcClock,
  watchHrefOf,
  wholePublicText,
} from "../../../src/client/publicapp/WorldSeason";
import { worldFixture } from "./WorldFixtures";
import { frontierFormFixture, seasonTwoWorld } from "./WorldSeasonFixtures";

const NOW = Date.parse("2026-10-06T16:00:00.000Z");

describe("world.json for Season 2", () => {
  it("reads the Season 2 fields", () => {
    const model = WorldModelSchema.parse(seasonTwoWorld());
    expect(model.mode).toBe("frontier");
    expect(model.season).toBe(2);
    expect(model.teams?.map((team) => team.displayName)).toEqual([
      "GPT-6 Astra",
      "Claude Fable 5.1",
      "Claude Opus 5.5",
      "Gemini 3.1 Pro",
      "Grok 4.7",
    ]);
    expect(model.schedule?.nextBattleAt).toBe("2026-10-06T19:00:00.000Z");
    expect(model.seasonOneRecap?.winsByLabel.Grok).toBe(25);
    expect(model.latestBattle?.standings).toHaveLength(5);
    expect(model.latestBattle?.voices).toHaveLength(6);
    expect(model.latestBattle?.watchHref).toMatch(/^https:\/\//);
  });

  it("still reads a Frontier Four world and a league world without them", () => {
    const legacy = WorldModelSchema.parse({
      ...worldFixture(),
      mode: "frontier-four",
      teams: [
        { label: "Astra", model: "openai/gpt-6-astra" },
        { label: "Grok", model: "x-ai/grok-4.7" },
      ],
    });
    expect(legacy.mode).toBe("frontier-four");
    expect(legacy.teams?.[0].displayName).toBeUndefined();
    expect(legacy.latestBattle).toBeUndefined();
    expect(legacy.schedule).toBeUndefined();
    const league = WorldModelSchema.parse(worldFixture());
    expect(league.mode).toBeUndefined();
    expect(league.seasonOneRecap).toBeUndefined();
  });

  it("drops a malformed Season 2 field instead of failing the page", () => {
    const model = WorldModelSchema.parse(
      seasonTwoWorld({
        mode: "something-new",
        schedule: { timesUtc: "13:00", nextBattleAt: 7 },
        seasonOneRecap: { battles: "many" },
        latestBattle: {
          ...(seasonTwoWorld().latestBattle as Record<string, unknown>),
          winType: "knockout",
          watchHref: "javascript:alert(1)",
          voices: [
            { label: "Grok", kind: "dispatch", text: "Kept." },
            { label: "Grok", kind: "shout", text: "Dropped: unknown kind." },
            { kind: "dispatch", text: "Dropped: no speaker." },
            "not a voice",
          ],
          standings: [{ label: "Grok", landShare: 7, rank: 1 }],
        },
      }),
    );
    expect(model.mode).toBeUndefined();
    expect(model.schedule).toEqual({ timesUtc: [], nextBattleAt: null });
    expect(model.seasonOneRecap).toBeUndefined();
    expect(model.latestBattle?.winType).toBeUndefined();
    expect(model.latestBattle?.watchHref).toBeNull();
    expect(model.latestBattle?.voices.map((voice) => voice.text)).toEqual([
      "Kept.",
    ]);
    // An impossible share is unknown, not a reason to drop the standing.
    expect(model.latestBattle?.standings).toEqual([
      { label: "Grok", landShare: null, rank: 1 },
    ]);
  });

  it("accepts a /match/ link for the latest battle and nothing off-site but https", () => {
    const parse = (watchHref: unknown) =>
      WorldModelSchema.parse(
        seasonTwoWorld({
          latestBattle: {
            ...(seasonTwoWorld().latestBattle as Record<string, unknown>),
            watchHref,
          },
        }),
      ).latestBattle?.watchHref;
    expect(parse("/match/ereq_ea2")).toBe("/match/ereq_ea2");
    expect(parse("http://example.com/replay")).toBeNull();
    // A raw replay file is megabytes of JSON, not a page to watch.
    expect(
      parse("https://softmax-public.s3.amazonaws.com/replays/ea2.replay"),
    ).toBeNull();
    expect(
      parse("https://softmax-public.s3.amazonaws.com/replays/ea2.REPLAY.gz"),
    ).toBeNull();
    expect(parse("//evil.example/x")).toBeNull();
    expect(parse(undefined)).toBeNull();
  });

  it("watches in the viewer, else on the battle's own page", () => {
    const model = WorldModelSchema.parse(seasonTwoWorld());
    const battle = model.latestBattle!;
    expect(watchHrefOf(model, battle)).toMatch(/^https:\/\/api\.observatory/);
    expect(watchHrefOf(model, { ...battle, watchHref: null })).toBe(
      "/match/ereq_ea2",
    );
    expect(
      watchHrefOf(model, {
        watchHref: null,
        episodeRequestId: "ereq_14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6",
      }),
    ).toBe("/match/ereq_14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6");
    expect(
      watchHrefOf(model, { watchHref: null, episodeRequestId: "../admin" }),
    ).toBeNull();
  });
});

describe("frontier-form.json", () => {
  it("reads the fixture and keeps a model whose day is malformed", () => {
    const form = FrontierFormSchema.parse(
      frontierFormFixture({
        models: [
          ...(frontierFormFixture().models as unknown[]),
          { label: "Broken", days: [{ day: "yesterday" }] },
        ],
      }),
    );
    expect(form.models).toHaveLength(6);
    expect(form.models[5].days).toEqual([]);
    expect(form.models[0].today?.verdictKind).toBe("normal");
  });

  it("is null when missing, unreachable or malformed, and never throws", async () => {
    const missing = vi.fn(async () => new Response("", { status: 404 }));
    expect(await fetchFrontierForm(missing as typeof fetch)).toBeNull();
    expect(missing).toHaveBeenCalledWith(
      "/ai-league-runs/league/frontier-form.json",
      expect.objectContaining({ cache: "no-store" }),
    );
    const offline = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await fetchFrontierForm(offline as typeof fetch)).toBeNull();
    const wrong = vi.fn(async () => Response.json({ schemaVersion: 2 }));
    expect(await fetchFrontierForm(wrong as typeof fetch)).toBeNull();
    const good = vi.fn(async () => Response.json(frontierFormFixture()));
    expect(
      (await fetchFrontierForm(good as typeof fetch))?.models,
    ).toHaveLength(5);
  });
});

describe("Season 2 names", () => {
  const model = WorldModelSchema.parse(seasonTwoWorld());
  it("names a model in full, with its maker, and falls back to the label", () => {
    expect(displayNameOf(model, "Opus")).toBe("Claude Opus 5.5");
    expect(providerOf(model, "Opus")).toBe("Anthropic");
    expect(displayNameOf(model, "Nobody")).toBe("Nobody");
    expect(providerOf(model, null)).toBeNull();
    const legacy = WorldModelSchema.parse(worldFixture());
    expect(displayNameOf(legacy, "Matt Van")).toBe("Matt Van");
    expect(providerOf(legacy, "Matt Van")).toBeNull();
  });

  it("finds the front a battle counted for", () => {
    expect(
      battleFront(model, { frontLabel: "east_asia", map: "Japan" }),
    ).toEqual({ id: "east_asia" });
    expect(battleFront(model, { frontLabel: null, map: "BlackSea" })).toEqual({
      id: "black_sea",
    });
    expect(
      battleFront(model, { frontLabel: "Far Isles", map: "Atlantis" }),
    ).toEqual({ name: "Far Isles" });
    expect(
      battleFront(model, { frontLabel: null, map: "Atlantis" }),
    ).toBeNull();
  });

  it("orders standings by rank, then by land", () => {
    expect(
      orderedStandings([
        { label: "C", landShare: 0.1, rank: null },
        { label: "B", landShare: 0.2, rank: 2 },
        { label: "A", landShare: 0.3, rank: 1 },
        { label: "D", landShare: 0.4, rank: null },
      ]).map((standing) => standing.label),
    ).toEqual(["A", "B", "D", "C"]);
  });
});

describe("publicText", () => {
  it("strips links, handles and control characters and keeps one line", () => {
    expect(
      publicText(
        "Join me at https://evil.example/x or www.evil.example,\n@grok_bot\u0007 and \u2063rule\u2063.",
        280,
      ),
    ).toBe("Join me at or and rule.");
    expect(publicText("mail me: someone@example.com", 280)).toBe(
      "mail me: someone@",
    );
    expect(publicText("   ", 140)).toBe("");
  });

  it("catches what the publisher catches: split, wide, bare and doubled links and handles", () => {
    // An invisible character must not split a link past the pattern.
    expect(publicText("see https\u200b://evil.com now", 140)).toBe("see now");
    expect(publicText("ｈｔｔｐｓ://evil.example/x", 140)).toBe("");
    expect(publicText("ftp://files.example/x and on", 140)).toBe("and on");
    expect(publicText("ask @@handle or x@handle", 140)).toBe("ask @ or x");
    expect(publicText("visit example.com/x today", 140)).toBe("visit today");
    expect(publicText("line one\u2028line two", 140)).toBe("line one line two");
    expect(publicText("Claude Opus 5.5 holds 38%.", 140)).toBe(
      "Claude Opus 5.5 holds 38%.",
    );
  });

  it("cuts a long line at a word, with an ellipsis", () => {
    const text = publicText("word ".repeat(60), 140);
    expect(text.length).toBeLessThanOrEqual(140);
    expect(text.endsWith("word…")).toBe(true);
  });

  it("shows a sentence whole or not at all", () => {
    expect(wholePublicText("One whole sentence.", 40)).toBe(
      "One whole sentence.",
    );
    expect(wholePublicText("word ".repeat(60), 140)).toBe("");
  });
});

describe("pickVoices", () => {
  const voices = (
    WorldModelSchema.parse(seasonTwoWorld()).latestBattle?.voices ?? []
  ).slice();
  it("quotes three models, public dispatches first and the winner's among them, in the order they spoke", () => {
    const picked = pickVoices(voices, "Grok");
    expect(picked.map((voice) => [voice.label, voice.kind])).toEqual([
      ["Opus", "dispatch"],
      ["Gemini", "dispatch"],
      ["Grok", "dispatch"],
    ]);
    // The link in Grok's line is gone before it is shown.
    expect(picked[2].text).toBe("Fields first, swords later. Now it is later.");
  });

  it("falls back to messages and a second line from the same model", () => {
    const two: WorldVoice[] = [
      { label: "Grok", kind: "message", to: "Opus", turn: 5, text: "Truce?" },
      { label: "Grok", kind: "dispatch", to: null, turn: 9, text: "Onward." },
      { label: "Opus", kind: "dispatch", to: null, turn: 7, text: "   " },
    ];
    expect(pickVoices(two, null).map((voice) => voice.text)).toEqual([
      "Truce?",
      "Onward.",
    ]);
    expect(pickVoices([], "Grok")).toEqual([]);
  });
});

describe("scheduleStatus", () => {
  const schedule = {
    timesUtc: ["13:00", "19:00"],
    nextBattleAt: "2026-10-06T19:00:00.000Z",
  };
  const lastBattle = "2026-10-06T13:41:00.000Z";
  const at = (iso: string) => Date.parse(iso);

  it("names the booked battle while it is ahead", () => {
    expect(scheduleStatus(schedule, NOW, lastBattle)).toEqual({
      kind: "next",
      at: "2026-10-06T19:00:00.000Z",
      minutes: 180,
    });
    expect(utcClock("2026-10-06T19:00:00.000Z")).toBe("19:00");
  });

  it("calls a slot due while its battle is fought, though the publisher has already booked the next", () => {
    // What the publisher writes when it runs just after the 19:00 slot.
    const moved = {
      timesUtc: ["13:00", "19:00"],
      nextBattleAt: "2026-10-07T13:00:00.000Z",
    };
    expect(
      scheduleStatus(moved, at("2026-10-06T19:20:00.000Z"), lastBattle),
    ).toEqual({ kind: "due", at: "2026-10-06T19:00:00.000Z" });
    // No battle yet this season: still due.
    expect(
      scheduleStatus(moved, at("2026-10-06T19:20:00.000Z"), null)?.kind,
    ).toBe("due");
    // Its result is in: the booking is the news again.
    expect(
      scheduleStatus(
        moved,
        at("2026-10-06T19:50:00.000Z"),
        "2026-10-06T19:44:00.000Z",
      ),
    ).toEqual({
      kind: "next",
      at: "2026-10-07T13:00:00.000Z",
      minutes: 1030,
    });
    // Long past the slot with no result: the booking, not "due" forever.
    expect(
      scheduleStatus(moved, at("2026-10-06T21:00:00.000Z"), lastBattle)?.kind,
    ).toBe("next");
    // A slot just after midnight UTC reads from yesterday's timetable.
    expect(
      scheduleStatus(
        { timesUtc: ["23:30"], nextBattleAt: "2026-10-07T23:30:00.000Z" },
        at("2026-10-07T00:15:00.000Z"),
        "2026-10-05T23:58:00.000Z",
      ),
    ).toEqual({ kind: "due", at: "2026-10-06T23:30:00.000Z" });
    // A booking that is itself just past (an older publish) is due too.
    expect(
      scheduleStatus(schedule, at("2026-10-06T19:30:00.000Z"), lastBattle),
    ).toEqual({ kind: "due", at: "2026-10-06T19:00:00.000Z" });
  });

  it("skips the slots a credits hold passes over", () => {
    // Held until Oct 8: the 19:00 slot is not being fought.
    const held = {
      timesUtc: ["13:00", "19:00"],
      nextBattleAt: "2026-10-08T13:00:00.000Z",
    };
    expect(
      scheduleStatus(held, at("2026-10-06T19:20:00.000Z"), lastBattle),
    ).toEqual({
      kind: "next",
      at: "2026-10-08T13:00:00.000Z",
      minutes: 2500,
    });
  });

  it("states the timetable, not a promise, once battles have stopped for a day", () => {
    expect(
      scheduleStatus(
        schedule,
        at("2026-10-06T16:00:00.000Z"),
        "2026-10-05T13:41:00.000Z",
      ),
    ).toEqual({ kind: "times", times: ["13:00", "19:00"] });
    // A hold says why there were none: its booking still stands.
    expect(
      scheduleStatus(
        { ...schedule, nextBattleAt: "2026-10-07T19:00:00.000Z" },
        at("2026-10-06T16:00:00.000Z"),
        "2026-10-05T13:41:00.000Z",
      )?.kind,
    ).toBe("next");
  });

  it("falls back to the timetable without a booking", () => {
    expect(
      scheduleStatus(schedule, at("2026-10-06T22:00:00.000Z"), lastBattle),
    ).toEqual({ kind: "times", times: ["13:00", "19:00"] });
    expect(
      scheduleStatus({ timesUtc: ["13:00"], nextBattleAt: null }, NOW),
    ).toEqual({ kind: "times", times: ["13:00"] });
    expect(
      scheduleStatus({ timesUtc: [], nextBattleAt: null }, NOW),
    ).toBeNull();
    expect(scheduleStatus(undefined, NOW)).toBeNull();
  });
});

describe("Nerf Watch arithmetic", () => {
  const form = FrontierFormSchema.parse(frontierFormFixture());
  const fable = form.models.find(
    (entry) => entry.label === "Fable",
  ) as FormModel;

  it("judges the newest day with battles against the days before it", () => {
    const day = latestFormDay(fable);
    expect(day?.day).toBe("2026-10-06");
    // Oct 1–5: 5 failed plans of 85.
    expect(trailingFailureRate(fable, day)).toBeCloseTo(5 / 85);
    expect(
      trailingFailureRate({ ...fable, days: [fable.days[5]] }, day),
    ).toBeNull();
    expect(latestFormDay({ ...fable, days: [] })).toBeNull();
  });

  it("compares speed, length and failures over the publisher's speed window, not the results window", () => {
    expect(fable.trailing?.days).toBe(30);
    expect(scanWindowDays(fable)).toBe(7);
    const day = latestFormDay(fable);
    // Only Oct 4–5 fall within 2 days before Oct 6: 2 failed plans of 34.
    const short = { ...fable, trailing: { ...fable.trailing!, speedDays: 2 } };
    expect(trailingFailureRate(short, day)).toBeCloseTo(2 / 34);
    // A file without speedDays falls back to its days.
    expect(
      scanWindowDays({
        ...fable,
        trailing: { ...fable.trailing!, speedDays: undefined },
      }),
    ).toBe(30);
  });
});
