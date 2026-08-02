import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backfillMatchStateSeries,
  generateMatchStateSeriesForRunDir,
} from "../../src/server/agents/CoworldLeagueMatchStateSeriesBackfill";
import { MATCH_STATE_SERIES_SCHEMA_VERSION } from "../../src/server/agents/AgentMatchStateSeries";

/**
 * IO/budget/skip/idempotency/failure-isolation coverage for the mirror-side
 * `match-state-series.json` gap closure — same shape as
 * `CoworldLeagueDirectorCutBackfill.test.ts`. Fixtures are a REAL retained
 * hosted-league run's `spectator-replay.json`/`spectator-telemetry.json`
 * (`league-coworld-2026-08-01T13-58-25-067Z-962f5eac`, 12 agents, 37
 * snapshots, real alliance/elimination events), trimmed of fields this
 * module never reads (per-player `tiles`/`units` arrays, per-snapshot
 * `decisions`, and telemetry `relationships`/`communicationThreads`/
 * `timelineBuckets`) to keep the checked-in fixture small — every field the
 * series generator DOES read (`turnNumber`, `players[].tilesOwned/troops/
 * isAlive`, `events[].kind/turnNumber/actorAgentID/targetAgentID/tone`)
 * is untouched, real captured data.
 */

const realReplayFixtureRaw = readFileSync(
  path.join(__dirname, "fixtures", "coworld-mirror-match-state-series-replay.sample.json"),
  "utf8",
);
const realTelemetryFixtureRaw = readFileSync(
  path.join(__dirname, "fixtures", "coworld-mirror-match-state-series-telemetry.sample.json"),
  "utf8",
);

let root: string;
let runsRootDir: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pw-series-backfill-")),
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
  options: { replay?: boolean; telemetry?: boolean } = {},
): Promise<string> {
  const { replay = true, telemetry = true } = options;
  const runDir = path.join(runsRootDir, runKey);
  await fs.mkdir(runDir, { recursive: true });
  if (replay) {
    await fs.writeFile(
      path.join(runDir, "spectator-replay.json"),
      realReplayFixtureRaw,
    );
  }
  if (telemetry) {
    await fs.writeFile(
      path.join(runDir, "spectator-telemetry.json"),
      realTelemetryFixtureRaw,
    );
  }
  return runDir;
}

describe("generateMatchStateSeriesForRunDir", () => {
  test("generates a real series from a real retained run's spectator-replay.json + telemetry", async () => {
    const runDir = await writeRealRunDir("league-coworld-fresh-1");
    const result = await generateMatchStateSeriesForRunDir(runDir, "league-coworld-fresh-1");
    expect(result.attempted).toBe(true);
    expect(result.outcome.status).toBe("generated");
    if (result.outcome.status === "generated") {
      expect(result.outcome.sampleCount).toBe(37);
    }
    const raw = await fs.readFile(path.join(runDir, "match-state-series.json"), "utf8");
    const series = JSON.parse(raw) as {
      schemaVersion: number;
      runID: string;
      source: string;
      samples: unknown[];
    };
    expect(series.schemaVersion).toBe(MATCH_STATE_SERIES_SCHEMA_VERSION);
    expect(series.source).toBe("spectator-replay-snapshots");
    expect(series.runID).toBe("league-coworld-fresh-1");
    expect(series.samples).toHaveLength(37);
  });

  test("still generates (degraded, empty activeAlliancePairs) when telemetry is absent — replay alone is sufficient", async () => {
    const runDir = await writeRealRunDir("league-coworld-no-telemetry-1", {
      telemetry: false,
    });
    const result = await generateMatchStateSeriesForRunDir(
      runDir,
      "league-coworld-no-telemetry-1",
    );
    expect(result.outcome.status).toBe("generated");
    const raw = await fs.readFile(
      path.join(runDir, "match-state-series.json"),
      "utf8",
    );
    const series = JSON.parse(raw) as {
      samples: { activeAlliancePairs: unknown[] }[];
      notes: string[];
    };
    expect(series.samples.every((s) => s.activeAlliancePairs.length === 0)).toBe(true);
    expect(series.notes.some((n) => n.includes("unavailable"))).toBe(true);
  });

  test("idempotent: an existing series is left untouched and doesn't cost a budget slot", async () => {
    const runDir = await writeRealRunDir("league-coworld-idempotent-1");
    const first = await generateMatchStateSeriesForRunDir(
      runDir,
      "league-coworld-idempotent-1",
    );
    expect(first.outcome.status).toBe("generated");
    const seriesPath = path.join(runDir, "match-state-series.json");
    const writtenAt = (await fs.stat(seriesPath)).mtimeMs;

    const second = await generateMatchStateSeriesForRunDir(
      runDir,
      "league-coworld-idempotent-1",
    );
    expect(second.attempted).toBe(false);
    expect(second.outcome).toEqual({ status: "already-exists" });
    expect((await fs.stat(seriesPath)).mtimeMs).toBe(writtenAt);
  });

  test("no-input: a run dir with no spectator-replay.json costs nothing and writes nothing", async () => {
    const runDir = await writeRealRunDir("league-coworld-empty-1", {
      replay: false,
      telemetry: false,
    });
    const result = await generateMatchStateSeriesForRunDir(runDir, "league-coworld-empty-1");
    expect(result.attempted).toBe(false);
    expect(result.outcome).toEqual({ status: "no-input" });
    await expect(
      fs.stat(path.join(runDir, "match-state-series.json")),
    ).rejects.toThrow();
  });

  test("skipped-no-usable-replay: malformed replay resolves to a skip, never throws", async () => {
    const runDir = path.join(runsRootDir, "league-coworld-malformed-1");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "spectator-replay.json"),
      "not valid json at all",
    );
    const result = await generateMatchStateSeriesForRunDir(
      runDir,
      "league-coworld-malformed-1",
    );
    expect(result.attempted).toBe(true);
    expect(result.outcome).toEqual({ status: "skipped-no-usable-replay" });
  });

  test("failure-isolation: a write failure resolves to a structured failure, never throws, never blocks the caller", async () => {
    const runDir = await writeRealRunDir("league-coworld-readonly-1");
    await fs.chmod(runDir, 0o500); // read+execute only — write/rename must fail
    try {
      const result = await generateMatchStateSeriesForRunDir(
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
});

describe("backfillMatchStateSeries", () => {
  test("budget: processes at most `budget` run dirs, oldest-name-first, and stops", async () => {
    await writeRealRunDir("league-coworld-a1");
    await writeRealRunDir("league-coworld-a2");
    await writeRealRunDir("league-coworld-a3");
    const results = await backfillMatchStateSeries(runsRootDir, 2);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.runKey)).toEqual([
      "league-coworld-a1",
      "league-coworld-a2",
    ]);
    expect(
      await fs
        .stat(path.join(runsRootDir, "league-coworld-a1", "match-state-series.json"))
        .then(() => true, () => false),
    ).toBe(true);
    expect(
      await fs
        .stat(path.join(runsRootDir, "league-coworld-a3", "match-state-series.json"))
        .then(() => true, () => false),
    ).toBe(false);
  });

  test("skip: a run dir that already has a series doesn't consume the budget", async () => {
    const alreadyDone = await writeRealRunDir("league-coworld-b1");
    await generateMatchStateSeriesForRunDir(alreadyDone, "league-coworld-b1");
    await writeRealRunDir("league-coworld-b2");
    const results = await backfillMatchStateSeries(runsRootDir, 1);
    expect(
      results.find((result) => result.runKey === "league-coworld-b2")?.outcome.status,
    ).toBe("generated");
  });

  test("alreadyAttempted set: dirs the caller already processed this cycle are skipped entirely", async () => {
    await writeRealRunDir("league-coworld-c1");
    await writeRealRunDir("league-coworld-c2");
    const results = await backfillMatchStateSeries(
      runsRootDir,
      5,
      new Set(["league-coworld-c1"]),
    );
    expect(results.map((result) => result.runKey)).toEqual(["league-coworld-c2"]);
  });

  test("budget 0 does no work at all", async () => {
    await writeRealRunDir("league-coworld-d1");
    const results = await backfillMatchStateSeries(runsRootDir, 0);
    expect(results).toEqual([]);
    expect(
      await fs
        .stat(path.join(runsRootDir, "league-coworld-d1", "match-state-series.json"))
        .then(() => true, () => false),
    ).toBe(false);
  });

  test("fail-open: an unreadable runsRootDir yields an empty result list, never throws", async () => {
    const missingRoot = path.join(root, "does-not-exist");
    await expect(backfillMatchStateSeries(missingRoot, 5)).resolves.toEqual([]);
  });

  test("non-league-prefixed directories are never scanned", async () => {
    await fs.mkdir(path.join(runsRootDir, "league"), { recursive: true });
    await fs.mkdir(path.join(runsRootDir, "some-other-dir"), { recursive: true });
    await writeRealRunDir("league-coworld-e1");
    const results = await backfillMatchStateSeries(runsRootDir, 10);
    expect(results.map((result) => result.runKey)).toEqual(["league-coworld-e1"]);
  });
});
