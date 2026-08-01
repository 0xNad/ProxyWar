import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backfillDirectorCutPlans,
  generateDirectorCutPlanForRunDir,
} from "../../src/server/agents/CoworldLeagueDirectorCutBackfill";

/**
 * IO/budget/skip/idempotency/failure-isolation coverage for the mirror-side
 * Director Cut generation hook (product overhaul spec Stage 5 gap closure).
 * Exercises `generateDirectorCutPlanForRunDir`/`backfillDirectorCutPlans`
 * against copies of the SAME real retained mirrored run fixture
 * `CoworldLeagueMirrorCore.test.ts` uses (see that file's fixture doc for
 * provenance), laid out exactly like `unpackEpisodeRunDir` would leave it on
 * disk — this is the closest a hermetic test gets to "run the real mirror
 * flow against real retained data" without live Coworld network/CLI access.
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
    await fs.mkdtemp(path.join(os.tmpdir(), "pw-director-cut-backfill-")),
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

describe("generateDirectorCutPlanForRunDir", () => {
  test("generates a real plan from a real retained run's spectator-telemetry.json", async () => {
    const runDir = await writeRealRunDir("league-coworld-fresh-1");
    const result = await generateDirectorCutPlanForRunDir(
      runDir,
      "league-coworld-fresh-1",
    );
    expect(result.attempted).toBe(true);
    expect(result.outcome).toMatchObject({
      status: "generated",
      source: "spectator-telemetry",
    });
    const planRaw = await fs.readFile(
      path.join(runDir, "director-cut-plan.json"),
      "utf8",
    );
    const plan = JSON.parse(planRaw) as {
      schemaVersion: number;
      reportKind: string;
      runID: string;
      segments: unknown[];
    };
    expect(plan.schemaVersion).toBe(1);
    expect(plan.reportKind).toBe("director-cut-plan");
    expect(plan.runID).toBe("league-coworld-fresh-1");
    expect(plan.segments.length).toBeGreaterThan(0);
  });

  test("falls back to decisions.jsonl derivation when telemetry is absent", async () => {
    const runDir = await writeRealRunDir("league-coworld-fallback-1", {
      telemetry: false,
      decisions: true,
    });
    const result = await generateDirectorCutPlanForRunDir(
      runDir,
      "league-coworld-fallback-1",
    );
    expect(result.outcome).toMatchObject({
      status: "generated",
      source: "decisions-log",
    });
  });

  test("idempotent: a plan that already exists is left untouched and doesn't cost a budget slot", async () => {
    const runDir = await writeRealRunDir("league-coworld-idempotent-1");
    const first = await generateDirectorCutPlanForRunDir(
      runDir,
      "league-coworld-idempotent-1",
    );
    expect(first.outcome.status).toBe("generated");
    const planPath = path.join(runDir, "director-cut-plan.json");
    const writtenAt = (await fs.stat(planPath)).mtimeMs;

    const second = await generateDirectorCutPlanForRunDir(
      runDir,
      "league-coworld-idempotent-1",
    );
    expect(second.attempted).toBe(false);
    expect(second.outcome).toEqual({ status: "already-exists" });
    expect((await fs.stat(planPath)).mtimeMs).toBe(writtenAt);
  });

  test("no-input: a run dir with neither telemetry nor decisions costs nothing and writes nothing", async () => {
    const runDir = await writeRealRunDir("league-coworld-empty-1", {
      telemetry: false,
      decisions: false,
    });
    const result = await generateDirectorCutPlanForRunDir(
      runDir,
      "league-coworld-empty-1",
    );
    expect(result.attempted).toBe(false);
    expect(result.outcome).toEqual({ status: "no-input" });
    await expect(
      fs.stat(path.join(runDir, "director-cut-plan.json")),
    ).rejects.toThrow();
  });

  test("skipped-no-usable-telemetry: malformed telemetry and no decisions resolves to a skip, never throws", async () => {
    const runDir = path.join(runsRootDir, "league-coworld-malformed-1");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "spectator-telemetry.json"),
      "not valid json at all",
    );
    const result = await generateDirectorCutPlanForRunDir(
      runDir,
      "league-coworld-malformed-1",
    );
    expect(result.attempted).toBe(true);
    expect(result.outcome).toEqual({ status: "skipped-no-usable-telemetry" });
  });

  test("failure-isolation: a write failure resolves to a structured failure, never throws, never blocks the caller", async () => {
    const runDir = await writeRealRunDir("league-coworld-readonly-1");
    await fs.chmod(runDir, 0o500); // read+execute only — write/rename must fail
    try {
      const result = await generateDirectorCutPlanForRunDir(
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
    const runDir = await writeRealRunDir("league-coworld-turncount-1");
    await fs.writeFile(
      path.join(runDir, "match-summary.json"),
      JSON.stringify({ finalState: { turnCount: 6300 } }),
    );
    const result = await generateDirectorCutPlanForRunDir(
      runDir,
      "league-coworld-turncount-1",
    );
    expect(result.outcome.status).toBe("generated");
    const plan = JSON.parse(
      await fs.readFile(path.join(runDir, "director-cut-plan.json"), "utf8"),
    ) as { totalTurns: number; degraded: boolean };
    expect(plan.totalTurns).toBe(6300);
    expect(plan.degraded).toBe(false);
  });
});

describe("backfillDirectorCutPlans", () => {
  test("budget: processes at most `budget` run dirs, oldest-name-first, and stops", async () => {
    await writeRealRunDir("league-coworld-a1");
    await writeRealRunDir("league-coworld-a2");
    await writeRealRunDir("league-coworld-a3");
    const results = await backfillDirectorCutPlans(runsRootDir, 2);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.runKey)).toEqual([
      "league-coworld-a1",
      "league-coworld-a2",
    ]);
    expect(
      await fs
        .stat(path.join(runsRootDir, "league-coworld-a1", "director-cut-plan.json"))
        .then(() => true, () => false),
    ).toBe(true);
    expect(
      await fs
        .stat(path.join(runsRootDir, "league-coworld-a3", "director-cut-plan.json"))
        .then(() => true, () => false),
    ).toBe(false);
  });

  test("skip: a run dir that already has a plan doesn't consume the budget", async () => {
    const alreadyDone = await writeRealRunDir("league-coworld-b1");
    await generateDirectorCutPlanForRunDir(alreadyDone, "league-coworld-b1");
    await writeRealRunDir("league-coworld-b2");
    const results = await backfillDirectorCutPlans(runsRootDir, 1);
    // b1 is scanned (already-exists, free) and b2 gets the single budget slot.
    expect(
      results.find((result) => result.runKey === "league-coworld-b2")
        ?.outcome.status,
    ).toBe("generated");
  });

  test("alreadyAttempted set: dirs the caller already processed this cycle are skipped entirely", async () => {
    await writeRealRunDir("league-coworld-c1");
    await writeRealRunDir("league-coworld-c2");
    const results = await backfillDirectorCutPlans(
      runsRootDir,
      5,
      new Set(["league-coworld-c1"]),
    );
    expect(results.map((result) => result.runKey)).toEqual([
      "league-coworld-c2",
    ]);
  });

  test("budget 0 does no work at all", async () => {
    await writeRealRunDir("league-coworld-d1");
    const results = await backfillDirectorCutPlans(runsRootDir, 0);
    expect(results).toEqual([]);
    expect(
      await fs
        .stat(path.join(runsRootDir, "league-coworld-d1", "director-cut-plan.json"))
        .then(() => true, () => false),
    ).toBe(false);
  });

  test("fail-open: an unreadable runsRootDir yields an empty result list, never throws", async () => {
    const missingRoot = path.join(root, "does-not-exist");
    await expect(
      backfillDirectorCutPlans(missingRoot, 5),
    ).resolves.toEqual([]);
  });

  test("non-league-prefixed directories are never scanned", async () => {
    await fs.mkdir(path.join(runsRootDir, "league"), { recursive: true });
    await fs.mkdir(path.join(runsRootDir, "some-other-dir"), {
      recursive: true,
    });
    await writeRealRunDir("league-coworld-e1");
    const results = await backfillDirectorCutPlans(runsRootDir, 10);
    expect(results.map((result) => result.runKey)).toEqual([
      "league-coworld-e1",
    ]);
  });
});
