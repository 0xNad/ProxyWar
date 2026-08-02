import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backfillMatchNarrativeArtifacts,
  generateMatchNarrativeArtifactsForRunDir,
} from "../../src/server/agents/CoworldLeagueMatchNarrativeBackfill";
import { AGENT_MATCH_RECAP_SCHEMA_VERSION } from "../../src/server/agents/AgentMatchRecap";

/**
 * IO/budget/skip/idempotency/failure-isolation coverage for the mirror-side
 * drama-report/match-story/match-recap backfill — same structure and same
 * real fixtures `CoworldLeagueDirectorCutBackfill.test.ts` uses (both draw
 * on the SAME retained mirror run's `spectator-telemetry.json`/
 * `decisions.jsonl`, via the shared `resolveMirroredMatchEvidence`).
 */

const realTelemetryFixtureRaw = readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "coworld-mirror-director-cut-telemetry.sample.json",
  ),
  "utf8",
);
const realDecisionsFixtureRaw = readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "coworld-mirror-director-cut-decisions.sample.jsonl",
  ),
  "utf8",
);

let root: string;
let runsRootDir: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pw-match-narrative-backfill-")),
  );
  runsRootDir = path.join(root, "ai-league-runs");
  await fs.mkdir(runsRootDir, { recursive: true });
});

afterEach(async () => {
  await fs.chmod(root, 0o700).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

async function writeRealRunDir(
  runKey: string,
  options: { telemetry?: boolean; decisions?: boolean } = {},
): Promise<string> {
  const { telemetry = true, decisions = false } = options;
  const runDir = path.join(runsRootDir, runKey);
  await fs.mkdir(runDir, { recursive: true });
  if (telemetry) {
    await fs.writeFile(
      path.join(runDir, "spectator-telemetry.json"),
      realTelemetryFixtureRaw,
    );
  }
  if (decisions) {
    await fs.writeFile(
      path.join(runDir, "decisions.jsonl"),
      realDecisionsFixtureRaw,
    );
  }
  return runDir;
}

describe("generateMatchNarrativeArtifactsForRunDir", () => {
  test("generates drama-report/match-story from a real retained run's spectator-telemetry.json (+ decisions.jsonl for records)", async () => {
    const runDir = await writeRealRunDir("league-coworld-fresh-1", {
      telemetry: true,
      decisions: true,
    });
    const result = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-fresh-1",
    );
    expect(result.attempted).toBe(true);
    expect(result.outcome).toMatchObject({
      status: "generated",
      source: "spectator-telemetry",
    });
    const dramaReport = JSON.parse(
      await fs.readFile(path.join(runDir, "drama-report.json"), "utf8"),
    ) as { schemaVersion: number; reportKind: string; runID: string; dramaScore: number };
    expect(dramaReport.schemaVersion).toBe(1);
    expect(dramaReport.reportKind).toBe("drama-and-tom-scorer");
    expect(dramaReport.runID).toBe("league-coworld-fresh-1");
    expect(typeof dramaReport.dramaScore).toBe("number");
    const matchStory = JSON.parse(
      await fs.readFile(path.join(runDir, "match-story.json"), "utf8"),
    ) as { schemaVersion: number; runID: string; entertainmentScore: number };
    expect(matchStory.schemaVersion).toBe(1);
    expect(matchStory.runID).toBe("league-coworld-fresh-1");
    expect(typeof matchStory.entertainmentScore).toBe("number");
    await expect(
      fs.stat(path.join(runDir, "match-story.md")),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(runDir, "drama-report.md")),
    ).resolves.toBeDefined();
  });

  test("falls back to decisions.jsonl derivation for telemetry when spectator-telemetry.json is absent", async () => {
    const runDir = await writeRealRunDir("league-coworld-fallback-1", {
      telemetry: false,
      decisions: true,
    });
    const result = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-fallback-1",
    );
    expect(result.outcome).toMatchObject({
      status: "generated",
      source: "decisions-log",
    });
  });

  test("writes match-recap.json when the curated pass finds story-worthy events", async () => {
    const runDir = await writeRealRunDir("league-coworld-recap-1", {
      telemetry: true,
      decisions: true,
    });
    await generateMatchNarrativeArtifactsForRunDir(runDir, "league-coworld-recap-1");
    const recap = JSON.parse(
      await fs.readFile(path.join(runDir, "match-recap.json"), "utf8"),
    ) as { schemaVersion: number; beats: unknown[] };
    expect(recap.schemaVersion).toBe(AGENT_MATCH_RECAP_SCHEMA_VERSION);
    expect(recap.beats.length).toBeGreaterThan(0);
  });

  test("idempotent: existing drama-report.json is left untouched and doesn't cost a budget slot", async () => {
    const runDir = await writeRealRunDir("league-coworld-idempotent-1", {
      decisions: true,
    });
    const first = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-idempotent-1",
    );
    expect(first.outcome.status).toBe("generated");
    const dramaReportPath = path.join(runDir, "drama-report.json");
    const writtenAt = (await fs.stat(dramaReportPath)).mtimeMs;

    const second = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-idempotent-1",
    );
    expect(second.attempted).toBe(false);
    expect(second.outcome).toEqual({ status: "already-exists" });
    expect((await fs.stat(dramaReportPath)).mtimeMs).toBe(writtenAt);
  });

  test("no-input: a run dir with neither telemetry nor decisions costs nothing and writes nothing", async () => {
    const runDir = await writeRealRunDir("league-coworld-empty-1", {
      telemetry: false,
      decisions: false,
    });
    const result = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-empty-1",
    );
    expect(result.attempted).toBe(false);
    expect(result.outcome).toEqual({ status: "no-input" });
    await expect(
      fs.stat(path.join(runDir, "drama-report.json")),
    ).rejects.toThrow();
  });

  test("skipped-no-usable-evidence: malformed telemetry and no decisions resolves to a skip, never throws", async () => {
    const runDir = path.join(runsRootDir, "league-coworld-malformed-1");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "spectator-telemetry.json"),
      "not valid json at all",
    );
    const result = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-malformed-1",
    );
    expect(result.attempted).toBe(true);
    expect(result.outcome).toEqual({ status: "skipped-no-usable-evidence" });
  });

  test("generated-recap-only: usable telemetry but no decisions.jsonl records — drama/story skipped honestly, recap alone", async () => {
    const runDir = await writeRealRunDir("league-coworld-recap-only-1", {
      telemetry: true,
      decisions: false,
    });
    const result = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-recap-only-1",
    );
    expect(result.attempted).toBe(true);
    expect(result.outcome).toMatchObject({
      status: "generated-recap-only",
      source: "spectator-telemetry",
    });
    await expect(
      fs.stat(path.join(runDir, "drama-report.json")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(runDir, "match-story.json")),
    ).rejects.toThrow();
  });

  test("failure-isolation: a write failure resolves to a structured failure, never throws, never blocks the caller", async () => {
    const runDir = await writeRealRunDir("league-coworld-readonly-1", {
      decisions: true,
    });
    await fs.chmod(runDir, 0o500); // read+execute only — write must fail
    try {
      const result = await generateMatchNarrativeArtifactsForRunDir(
        runDir,
        "league-coworld-readonly-1",
      );
      expect(result.attempted).toBe(true);
      expect(result.outcome.status).toBe("failed");
      if (result.outcome.status === "failed") {
        expect(result.outcome.error.length).toBeGreaterThan(0);
      }
    } finally {
      await fs.chmod(runDir, 0o700);
    }
  });

  test("uses match-summary.json's authoritative turn count when present", async () => {
    const runDir = await writeRealRunDir("league-coworld-turncount-1", {
      decisions: true,
    });
    await fs.writeFile(
      path.join(runDir, "match-summary.json"),
      JSON.stringify({ finalState: { turnCount: 6300 } }),
    );
    const result = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-turncount-1",
    );
    expect(result.outcome.status).toBe("generated");
  });

  test("recap-upgraded: a stale (pre-fix) match-recap.json is re-curated without re-running drama/story generation", async () => {
    const runDir = await writeRealRunDir("league-coworld-recap-upgrade-1", {
      decisions: true,
    });
    const first = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-recap-upgrade-1",
    );
    expect(first.outcome.status).toBe("generated");
    const dramaReportPath = path.join(runDir, "drama-report.json");
    const dramaReportWrittenAt = (await fs.stat(dramaReportPath)).mtimeMs;

    // Simulate a pre-fix artifact on disk (schemaVersion 1, no cap/aggregation).
    const recapPath = path.join(runDir, "match-recap.json");
    await fs.writeFile(
      recapPath,
      JSON.stringify({
        schemaVersion: 1,
        runID: "league-coworld-recap-upgrade-1",
        generatedAt: "2026-01-01T00:00:00.000Z",
        summary: "stale pre-fix summary",
        beats: [{ turnNumber: 1, kind: "alliance", message: "stale beat" }],
      }),
    );

    const second = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-recap-upgrade-1",
    );
    expect(second.attempted).toBe(true);
    expect(second.outcome).toMatchObject({ status: "recap-upgraded" });
    // drama-report.json is untouched — only the recap was recomputed.
    expect((await fs.stat(dramaReportPath)).mtimeMs).toBe(dramaReportWrittenAt);
    const upgraded = JSON.parse(await fs.readFile(recapPath, "utf8")) as {
      schemaVersion: number;
      summary: string;
      curatedDramaScore: number;
    };
    expect(upgraded.schemaVersion).toBe(AGENT_MATCH_RECAP_SCHEMA_VERSION);
    expect(upgraded.summary).not.toBe("stale pre-fix summary");
    // The whole point of the 2 -> 3 bump: a pre-fix artifact (which never
    // had this field at all) now carries the curated public ranking score.
    expect(typeof upgraded.curatedDramaScore).toBe("number");
    expect(second.outcome).toMatchObject({ status: "recap-upgraded" });
    if (second.outcome.status === "recap-upgraded") {
      expect(second.outcome.curatedDramaScore).toBe(upgraded.curatedDramaScore);
    }

    // A THIRD call, with the recap now current, is a free already-exists —
    // proving the upgrade converges (never re-upgrades every cycle).
    const third = await generateMatchNarrativeArtifactsForRunDir(
      runDir,
      "league-coworld-recap-upgrade-1",
    );
    expect(third.attempted).toBe(false);
    expect(third.outcome).toEqual({ status: "already-exists" });
  });
});

describe("backfillMatchNarrativeArtifacts", () => {
  test("budget: processes at most `budget` run dirs, oldest-name-first, and stops", async () => {
    await writeRealRunDir("league-coworld-a1", { decisions: true });
    await writeRealRunDir("league-coworld-a2", { decisions: true });
    await writeRealRunDir("league-coworld-a3", { decisions: true });
    const results = await backfillMatchNarrativeArtifacts(runsRootDir, 2);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.runKey)).toEqual([
      "league-coworld-a1",
      "league-coworld-a2",
    ]);
    expect(
      await fs
        .stat(path.join(runsRootDir, "league-coworld-a1", "drama-report.json"))
        .then(() => true, () => false),
    ).toBe(true);
    expect(
      await fs
        .stat(path.join(runsRootDir, "league-coworld-a3", "drama-report.json"))
        .then(() => true, () => false),
    ).toBe(false);
  });

  test("skip: a run dir that already has artifacts doesn't consume the budget", async () => {
    const alreadyDone = await writeRealRunDir("league-coworld-b1", { decisions: true });
    await generateMatchNarrativeArtifactsForRunDir(alreadyDone, "league-coworld-b1");
    await writeRealRunDir("league-coworld-b2", { decisions: true });
    const results = await backfillMatchNarrativeArtifacts(runsRootDir, 1);
    expect(
      results.find((result) => result.runKey === "league-coworld-b2")
        ?.outcome.status,
    ).toBe("generated");
  });

  test("alreadyAttempted set: dirs the caller already processed this cycle are skipped entirely", async () => {
    await writeRealRunDir("league-coworld-c1", { decisions: true });
    await writeRealRunDir("league-coworld-c2", { decisions: true });
    const results = await backfillMatchNarrativeArtifacts(
      runsRootDir,
      5,
      new Set(["league-coworld-c1"]),
    );
    expect(results.map((result) => result.runKey)).toEqual([
      "league-coworld-c2",
    ]);
  });

  test("budget 0 does no work at all", async () => {
    await writeRealRunDir("league-coworld-d1", { decisions: true });
    const results = await backfillMatchNarrativeArtifacts(runsRootDir, 0);
    expect(results).toEqual([]);
  });

  test("fail-open: an unreadable runsRootDir yields an empty result list, never throws", async () => {
    const missingRoot = path.join(root, "does-not-exist");
    await expect(
      backfillMatchNarrativeArtifacts(missingRoot, 5),
    ).resolves.toEqual([]);
  });
});
