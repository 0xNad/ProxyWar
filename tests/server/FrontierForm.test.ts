import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  binomialAtMost,
  buildFrontierForm,
  FRONTIER_FORM_FILE,
  publishFrontierForm,
  type FrontierForm,
  type FrontierFormModel,
} from "../../src/server/agents/FrontierForm";
import {
  FRONTIER_SEASON_TWO_TEAMS,
  parseFrontierGameRecordV2,
  type FrontierGameRecordV2,
} from "../../src/server/agents/FrontierFourWorld";

/**
 * Nerf Watch: per model per day, a trailing record, and a verdict on the
 * latest day that only says what the numbers support. The battles are
 * contract-B records shaped like the Season 1 games (five single seats,
 * planner figures in the ranges the Season 1 seat logs showed).
 */

const LABELS = ["Astra", "Fable", "Opus", "Gemini", "Grok"];
const MODELS: Record<string, string> = {
  Astra: "openai/gpt-6-astra",
  Fable: "anthropic/claude-fable-5.1",
  Opus: "anthropic/claude-opus-5.5",
  Gemini: "google/gemini-3.1-pro-preview",
  Grok: "x-ai/grok-4.7",
  Kimi: "moonshotai/kimi-k3",
};

interface Telemetry {
  plans: number;
  planFailures: number;
  latencyMsMedian: number;
  outputTokensMedian: number;
}

const NORMAL: Telemetry = {
  plans: 16,
  planFailures: 0,
  latencyMsMedian: 10000,
  outputTokensMedian: 800,
};

let sequence = 0;

function battle(args: {
  at: string;
  winner: string | null;
  labels?: readonly string[];
  telemetry?: Readonly<Record<string, Partial<Telemetry> | null>>;
  playerVersion?: string;
  reasoning?: string;
  /** Slugs that differ from the usual ones, by label. */
  models?: Readonly<Record<string, string>>;
}): FrontierGameRecordV2 {
  sequence += 1;
  const labels = args.labels ?? LABELS;
  const order = [
    ...(args.winner === null ? [] : [args.winner]),
    ...labels.filter((label) => label !== args.winner),
  ];
  const telemetry: Record<string, unknown> = {};
  for (const label of labels) {
    const override = args.telemetry?.[label];
    if (override === null) continue;
    telemetry[label] = {
      ...NORMAL,
      ...override,
      timeouts: 0,
      latencyMsP90: null,
      inputTokensMedian: 6000,
      reasoningTokensMedian: null,
      usd: 0.3,
      capped: false,
    };
  }
  const record = parseFrontierGameRecordV2({
    schemaVersion: 2,
    season: 2,
    format: "ffa",
    experienceRequestId: `xreq_${sequence}`,
    episodeRequestId: `ereq_form_${sequence}`,
    variantId: "ffa5-asia",
    map: "Asia",
    mapSize: "Compact",
    frontLabel: "Asia",
    completedAt: args.at,
    replayUrl: null,
    viewerUrl: null,
    costUsd: 2.4,
    cycle: 1,
    gameIndex: sequence,
    episodeIndex: sequence,
    sides: labels.map((label, slot) => ({
      label,
      model: args.models?.[label] ?? MODELS[label],
      team: null,
      slots: [slot],
      pickOrder: slot + 1,
    })),
    winnerLabel: args.winner,
    winType: args.winner === null ? "none" : "points",
    standings: order.map((label, index) => ({
      label,
      landShare: index === 0 ? 0.4 : 0.15,
      tilesOwned: index === 0 ? 400000 : 150000,
      isAlive: true,
      eliminatedAtTurn: null,
      rank: index + 1,
    })),
    turnCount: 24000,
    decisionCount: 1200,
    degradedCount: 10,
    telemetry,
    voices: [],
    moments: [],
    harness: {
      playerVersion: args.playerVersion ?? "2.0.0",
      planEvery: 15,
      plansPerSeat: 17,
      reasoning: args.reasoning ?? "low",
      maxOutputTokens: 3000,
    },
  });
  if (record === null) throw new Error("fixture battle failed to parse");
  return record;
}

function dayBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * Two battles a day (13:00 and 19:00 UTC) for `days` days before `day`.
 * `winner(dayIndex, game)` names each winner; `telemetry(dayIndex, game)`
 * adjusts the planner figures per side.
 */
function history(args: {
  day: string;
  days: number;
  winner: (dayIndex: number, game: number) => string | null;
  telemetry?: (
    dayIndex: number,
    game: number,
  ) => Record<string, Partial<Telemetry> | null>;
  playerVersion?: string;
  reasoning?: (dayIndex: number, game: number) => string;
}): FrontierGameRecordV2[] {
  const records: FrontierGameRecordV2[] = [];
  for (let dayIndex = args.days; dayIndex >= 1; dayIndex--) {
    const day = dayBefore(args.day, dayIndex);
    for (const [game, time] of ["13:00", "19:00"].entries()) {
      records.push(
        battle({
          at: `${day}T${time}:00.000Z`,
          winner: args.winner(dayIndex, game),
          telemetry: args.telemetry?.(dayIndex, game),
          playerVersion: args.playerVersion,
          reasoning: args.reasoning?.(dayIndex, game),
        }),
      );
    }
  }
  return records;
}

const DAY = "2026-10-20";
const NOW = `${DAY}T20:00:00.000Z`;

function today(
  winner: string | null,
  telemetry: Record<string, Partial<Telemetry> | null> = {},
  playerVersion?: string,
): FrontierGameRecordV2[] {
  return ["13:00", "19:00"].map((time, game) =>
    battle({
      at: `${DAY}T${time}:00.000Z`,
      winner: game === 0 ? winner : null,
      telemetry,
      playerVersion,
    }),
  );
}

function modelOf(form: FrontierForm, label: string): FrontierFormModel {
  const model = form.models.find((entry) => entry.label === label);
  if (model === undefined) throw new Error(`no ${label} in the form`);
  return model;
}

function build(records: readonly FrontierGameRecordV2[], now = NOW) {
  return buildFrontierForm(records, { now, teams: FRONTIER_SEASON_TWO_TEAMS });
}

/** Grok's daily median latency over the week before: 9,500..10,500 ms. */
const STEADY_WEEK = (dayIndex: number) => ({
  Grok: { latencyMsMedian: 9500 + (dayIndex % 3) * 500 },
});

describe("binomialAtMost", () => {
  it("is the chance of this many wins or fewer", () => {
    expect(binomialAtMost(0, 2, 0.5)).toBeCloseTo(0.25, 10);
    expect(binomialAtMost(1, 2, 0.5)).toBeCloseTo(0.75, 10);
    expect(binomialAtMost(0, 3, 0.2)).toBeCloseTo(0.512, 10);
    expect(binomialAtMost(1, 10, 0.4)).toBeCloseTo(0.0463574016, 8);
    expect(binomialAtMost(2, 2, 0.9)).toBe(1);
    expect(binomialAtMost(0, 0, 0.5)).toBe(1);
    expect(binomialAtMost(-1, 2, 0.5)).toBe(0);
    expect(binomialAtMost(0, 2, 0)).toBe(1);
    expect(binomialAtMost(1, 2, 1)).toBe(0);
  });
});

describe("Frontier form (Nerf Watch)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true });
  });

  it("lists every roster model before any battle, with nothing to compare", () => {
    const form = build([]);
    expect(form).toMatchObject({
      schemaVersion: 1,
      generatedAt: NOW,
      harness: null,
    });
    expect(form.models.map((model) => model.label)).toEqual(LABELS);
    expect(modelOf(form, "Opus")).toEqual({
      label: "Opus",
      displayName: "Claude Opus 5.5",
      provider: "Anthropic",
      days: [],
      trailing: {
        days: 30,
        battles: 0,
        wins: 0,
        winRate: null,
        latencyMsMedian: null,
        outputTokensMedian: null,
        speedDays: 7,
      },
      today: {
        day: null,
        verdictKind: "too_few",
        chanceOfResult: null,
        sentence: "No battles yet.",
      },
    });
  });

  it("sums a single day and says it is too early to compare", () => {
    const form = build(today("Grok"));
    const grok = modelOf(form, "Grok");
    expect(grok.days).toEqual([
      {
        day: DAY,
        battles: 2,
        wins: 1,
        meanLandShare: 0.275,
        ranks: [1, 5],
        plans: 32,
        planFailures: 0,
        latencyMsMedian: 10000,
        outputTokensMedian: 800,
      },
    ]);
    expect(grok.today).toEqual({
      day: DAY,
      verdictKind: "too_few",
      chanceOfResult: null,
      sentence:
        "Won 1 of 2 battles today. Too few earlier battles to compare yet.",
    });
    expect(form.harness).toEqual({
      playerVersion: "2.0.0",
      planEvery: 15,
      plansPerSeat: 17,
      reasoning: "low",
      maxOutputTokens: 3000,
    });
  });

  it("keeps missing telemetry missing instead of counting it as zero", () => {
    const records = [
      ...history({ day: DAY, days: 7, winner: () => "Opus" }),
      ...today("Opus", { Opus: null }),
    ];
    const opus = modelOf(build(records), "Opus");
    expect(opus.days.at(-1)).toMatchObject({
      battles: 2,
      wins: 1,
      plans: null,
      planFailures: null,
      latencyMsMedian: null,
      outputTokensMedian: null,
    });
    // Results can still be judged; speed cannot.
    expect(opus.today.verdictKind).toBe("normal");
    expect(opus.today.chanceOfResult).not.toBeNull();
  });

  it("gives a bad day a chance from the trailing win rate, never a label", () => {
    // Fourteen days, Astra winning half its battles.
    const records = [
      ...history({
        day: DAY,
        days: 14,
        winner: (_dayIndex, game) => (game === 0 ? "Astra" : "Grok"),
      }),
      ...today("Grok"),
    ];
    const astra = modelOf(build(records), "Astra");
    expect(astra.trailing).toMatchObject({
      days: 30,
      battles: 28,
      wins: 14,
      winRate: 0.5,
    });
    expect(astra.today).toEqual({
      day: DAY,
      verdictKind: "normal",
      chanceOfResult: 0.25,
      sentence:
        "Won 0 of 2 battles today. At its usual 50% win rate, a day this bad or worse happens 25% of the time.",
    });
    const grok = modelOf(build(records), "Grok");
    expect(grok.today.sentence).toBe(
      "Won 1 of 2 battles today, at or above its usual 50% win rate.",
    );
    expect(grok.today.chanceOfResult).toBe(0.75);
  });

  it("only counts the 30 days before the day under review", () => {
    const old = history({
      day: dayBefore(DAY, 31),
      days: 10,
      winner: () => "Gemini",
    });
    const recent = history({ day: DAY, days: 2, winner: () => "Gemini" });
    const gemini = modelOf(
      build([...old, ...recent, ...today("Gemini")]),
      "Gemini",
    );
    expect(gemini.trailing.battles).toBe(4);
    expect(gemini.today.verdictKind).toBe("too_few");
    expect(gemini.days).toHaveLength(13);
  });

  it("names a speed shift only outside the earlier range, past 15%, on 8 or more plans", () => {
    const base = history({
      day: DAY,
      days: 14,
      winner: (_dayIndex, game) => (game === 0 ? "Grok" : "Fable"),
      telemetry: STEADY_WEEK,
    });
    const verdict = (telemetry: Partial<Telemetry>) =>
      modelOf(build([...base, ...today("Grok", { Grok: telemetry })]), "Grok")
        .today;

    const slower = verdict({ latencyMsMedian: 14000 });
    expect(slower.verdictKind).toBe("slower");
    expect(slower.sentence).toBe(
      "Won 1 of 2 battles today, at or above its usual 50% win rate. Speed: its answers took 40% longer than the week before.",
    );
    expect(slower.chanceOfResult).toBe(0.75);

    const faster = verdict({ latencyMsMedian: 7000 });
    expect(faster.verdictKind).toBe("faster");
    expect(faster.sentence).toContain(
      "Speed: its answers took 30% less time than the week before.",
    );

    // Inside the earlier days' range.
    expect(verdict({ latencyMsMedian: 10400 }).verdictKind).toBe("normal");
    // Past the slowest earlier day, but within 15% of the usual.
    expect(verdict({ latencyMsMedian: 11000 }).verdictKind).toBe("normal");
    // Far slower, but on too few plans to say.
    expect(verdict({ latencyMsMedian: 30000, plans: 3 }).verdictKind).toBe(
      "normal",
    );
  });

  it("names answer length and plan failures the same careful way", () => {
    const base = history({
      day: DAY,
      days: 14,
      winner: (_dayIndex, game) => (game === 0 ? "Fable" : "Grok"),
      // 760 or 840 tokens a day; over the week before, the median is 840.
      telemetry: (dayIndex) => ({
        Fable: { outputTokensMedian: 760 + (dayIndex % 2) * 80 },
      }),
    });
    const verdict = (telemetry: Partial<Telemetry>) =>
      modelOf(
        build([...base, ...today("Fable", { Fable: telemetry })]),
        "Fable",
      ).today;

    const wordier = verdict({ outputTokensMedian: 1200 });
    expect(wordier.verdictKind).toBe("wordier");
    expect(wordier.sentence).toContain(
      "Length: its answers were 43% longer than the week before.",
    );
    const terser = verdict({ outputTokensMedian: 500 });
    expect(terser.verdictKind).toBe("terser");
    expect(terser.sentence).toContain(
      "Length: its answers were 40% shorter than the week before.",
    );
    const flakier = verdict({ plans: 9, planFailures: 3 });
    expect(flakier.verdictKind).toBe("flakier");
    expect(flakier.sentence).toContain(
      "Reliability: 6 of its 18 plans failed, against 0% the week before.",
    );
    // One failure in eighteen is within 15 points of a clean week.
    expect(verdict({ plans: 9, planFailures: 1 }).verdictKind).toBe("normal");
  });

  it("does not compare speed across a change in how the seats are run", () => {
    const records = [
      ...history({
        day: DAY,
        days: 14,
        winner: (_dayIndex, game) => (game === 0 ? "Grok" : "Opus"),
        telemetry: STEADY_WEEK,
        playerVersion: "1.9.0",
      }),
      ...today("Grok", { Grok: { latencyMsMedian: 25000 } }, "2.0.0"),
    ];
    const grok = modelOf(build(records), "Grok");
    expect(grok.trailing.battles).toBe(28);
    expect(grok.trailing.latencyMsMedian).toBeNull();
    expect(grok.today.verdictKind).toBe("normal");
    expect(grok.today.sentence).not.toMatch(/Speed/);
  });

  it("only judges a speed shift on the day's games run the same way", () => {
    const base = history({
      day: DAY,
      days: 14,
      winner: (_dayIndex, game) => (game === 0 ? "Grok" : "Opus"),
      telemetry: STEADY_WEEK,
    });
    // The morning game ran a new setup that triples answer length; the
    // evening game went back to the usual one.
    const mixed = [
      battle({
        at: `${DAY}T13:00:00.000Z`,
        winner: "Grok",
        telemetry: { Grok: { outputTokensMedian: 2400 } },
        playerVersion: "3.0.0",
      }),
      battle({ at: `${DAY}T19:00:00.000Z`, winner: null }),
    ];
    const grok = modelOf(build([...base, ...mixed]), "Grok");
    expect(grok.today.verdictKind).toBe("normal");
    expect(grok.today.sentence).not.toMatch(/Length/);
    // The day's results still count both games.
    expect(grok.today.sentence).toMatch(/^Won 1 of 2 battles today/);
    expect(grok.days.at(-1)).toMatchObject({ battles: 2, wins: 1 });
  });

  it("does not split the record when a seat's reasoning setting reads differently", () => {
    // The scheduler records `reasoning` from whichever seat logged first; a
    // seat whose route refused reasoning logs "dropped".
    const base = history({
      day: DAY,
      days: 14,
      winner: (_dayIndex, game) => (game === 0 ? "Grok" : "Fable"),
      telemetry: STEADY_WEEK,
      reasoning: (dayIndex, game) =>
        (dayIndex + game) % 2 === 0 ? "low" : "dropped",
    });
    const slow = ["13:00", "19:00"].map((time, game) =>
      battle({
        at: `${DAY}T${time}:00.000Z`,
        winner: game === 0 ? "Grok" : null,
        telemetry: { Grok: { latencyMsMedian: 14000 } },
        reasoning: "dropped",
      }),
    );
    const grok = modelOf(build([...base, ...slow]), "Grok");
    expect(grok.trailing.latencyMsMedian).toBe(10000);
    expect(grok.today.verdictKind).toBe("slower");
  });

  it("starts a fresh record when a label moves to a new model", () => {
    const base = history({
      day: DAY,
      days: 10,
      winner: (_dayIndex, game) => (game === 0 ? "Grok" : "Astra"),
      telemetry: STEADY_WEEK,
    });
    // Same label, new slug: much faster and terser, and winless today.
    const swapped = ["13:00", "19:00"].map((time) =>
      battle({
        at: `${DAY}T${time}:00.000Z`,
        winner: "Astra",
        telemetry: { Grok: { latencyMsMedian: 4000, outputTokensMedian: 300 } },
        models: { Grok: "x-ai/grok-5-fast" },
      }),
    );
    const grok = modelOf(build([...base, ...swapped]), "Grok");
    expect(grok.trailing).toMatchObject({
      battles: 0,
      wins: 0,
      winRate: null,
      latencyMsMedian: null,
    });
    expect(grok.today).toEqual({
      day: DAY,
      verdictKind: "too_few",
      chanceOfResult: null,
      sentence:
        "Won 0 of 2 battles today. Its model changed recently, so there are too few battles on the new one to compare yet.",
    });
    // The history still shows every day the label fought.
    expect(grok.days).toHaveLength(11);
  });

  it("counts a game that appears twice in the games file once", () => {
    const records = [
      ...history({ day: DAY, days: 7, winner: () => "Opus" }),
      ...today("Opus"),
    ];
    const latest = records.at(-1)!;
    const opus = modelOf(build([...records, latest, latest]), "Opus");
    expect(opus.days.at(-1)).toMatchObject({ battles: 2, wins: 1 });
  });

  it("reviews a model's latest day even when it has not fought today", () => {
    const records = [
      ...history({ day: DAY, days: 3, winner: () => "Astra" }),
      battle({
        at: `${DAY}T13:00:00.000Z`,
        winner: "Grok",
        labels: ["Astra", "Fable", "Gemini", "Grok"],
      }),
    ];
    const form = build(records);
    expect(modelOf(form, "Opus").today.day).toBe(dayBefore(DAY, 1));
    expect(modelOf(form, "Opus").today.sentence).toBe(
      "Won 0 of 2 battles yesterday. Too few earlier battles to compare yet.",
    );
    const older = build(records, "2026-10-25T09:00:00.000Z");
    expect(modelOf(older, "Opus").today.sentence).toMatch(
      /^Won 0 of 2 battles on Oct 19\./,
    );
  });

  it("adds sides the roster does not name and keeps at most 90 days", () => {
    const records = [
      battle({
        at: `${DAY}T13:00:00.000Z`,
        winner: "Kimi",
        labels: ["Grok", "Kimi"],
      }),
      ...Array.from({ length: 100 }, (_, index) =>
        battle({
          at: `${dayBefore(DAY, index + 1)}T13:00:00.000Z`,
          winner: "Grok",
          labels: ["Grok", "Astra"],
        }),
      ),
    ];
    const form = build(records);
    expect(form.models.map((model) => model.label)).toEqual([
      ...LABELS,
      "Kimi",
    ]);
    expect(modelOf(form, "Kimi")).toMatchObject({
      displayName: "Kimi",
      days: [{ day: DAY, battles: 1, wins: 1 }],
    });
    const grok = modelOf(form, "Grok");
    expect(grok.days).toHaveLength(90);
    expect(grok.days.at(-1)?.day).toBe(DAY);
  });

  it("never calls a model nerfed or weaker, and keeps sentences short", () => {
    const sentences: string[] = [];
    const base = history({
      day: DAY,
      days: 14,
      winner: (dayIndex, game) => LABELS[(dayIndex + game) % LABELS.length],
      telemetry: STEADY_WEEK,
    });
    for (const telemetry of [
      {},
      { latencyMsMedian: 40000 },
      { latencyMsMedian: 1000 },
      { outputTokensMedian: 4000 },
      { outputTokensMedian: 10 },
      { planFailures: 16 },
    ]) {
      for (const winner of [...LABELS, null]) {
        const form = build([...base, ...today(winner, { Grok: telemetry })]);
        sentences.push(...form.models.map((model) => model.today.sentence));
      }
    }
    sentences.push(
      ...build([]).models.map((model) => model.today.sentence),
      ...build(today("Grok")).models.map((model) => model.today.sentence),
    );
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/nerf|weak/i);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence.length).toBeLessThanOrEqual(240);
    }
  });

  it("writes frontier-form.json beside world.json", async () => {
    const siteDir = await mkdtemp(path.join(tmpdir(), "frontier-form-"));
    dirs.push(siteDir);
    const records = today("Grok");
    const { formPath, form } = await publishFrontierForm({
      siteDir,
      records,
      teams: FRONTIER_SEASON_TWO_TEAMS,
      now: NOW,
    });
    expect(formPath).toBe(path.join(siteDir, FRONTIER_FORM_FILE));
    expect(JSON.parse(await readFile(formPath, "utf8"))).toEqual(
      JSON.parse(JSON.stringify(form)),
    );
  });
});
