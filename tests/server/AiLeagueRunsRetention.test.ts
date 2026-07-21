import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  classifyAiLeagueRuns,
  directorySizeBytes,
  isProtectedLeagueBundleName,
  isRunCited,
  isSafeAiLeagueRunName,
  parseAiLeagueRunSemanticTimestampMs,
  requireSafeAiLeagueRunsRetentionLayout,
  runAiLeagueRunsRetention,
  runCitationTokens,
  selectWithinCaps,
  type RawRunDirEntry,
  type SizedRunEntry,
} from "../../src/server/agents/AiLeagueRunsRetention";

const NOW_MS = Date.parse("2026-07-21T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function entry(
  name: string,
  overrides: Partial<RawRunDirEntry> = {},
): RawRunDirEntry {
  return {
    name,
    isDirectory: true,
    isSymbolicLink: false,
    modifiedAtMs: NOW_MS,
    ...overrides,
  };
}

function sized(name: string, sizeBytes: number): SizedRunEntry {
  return {
    name,
    sizeBytes,
    effectiveTimestampMs: NOW_MS,
    timestampSource: "semantic",
    ageMs: 0,
  };
}

describe("parseAiLeagueRunSemanticTimestampMs", () => {
  test("parses a full ISO run id", () => {
    expect(
      parseAiLeagueRunSemanticTimestampMs(
        "2026-05-08T16-35-58-815Z-league-rule-c89ec19e",
      ),
    ).toBe(Date.parse("2026-05-08T16:35:58.815Z"));
  });

  test("parses a coworld-prefixed ISO run id", () => {
    expect(
      parseAiLeagueRunSemanticTimestampMs(
        "coworld-2026-07-18T12-56-15-060Z-8109e993",
      ),
    ).toBe(Date.parse("2026-07-18T12:56:15.060Z"));
  });

  test("parses a date-only run id at UTC midnight", () => {
    expect(
      parseAiLeagueRunSemanticTimestampMs(
        "2026-05-16-baseline-champion-agent-run-1",
      ),
    ).toBe(Date.parse("2026-05-16T00:00:00.000Z"));
  });

  test("returns null for names without a timestamp", () => {
    expect(parseAiLeagueRunSemanticTimestampMs("wr")).toBeNull();
    expect(
      parseAiLeagueRunSemanticTimestampMs("frontier-mock-policy"),
    ).toBeNull();
  });

  test("returns null for an impossible calendar date", () => {
    expect(
      parseAiLeagueRunSemanticTimestampMs("2026-13-40-broken-run"),
    ).toBeNull();
  });
});

describe("name guards", () => {
  test("isProtectedLeagueBundleName matches the league* glob only", () => {
    expect(isProtectedLeagueBundleName("league")).toBe(true);
    expect(
      isProtectedLeagueBundleName("league-coworld-2026-07-21T06-02-22-088Z-d0"),
    ).toBe(true);
    // "league" appears mid-name as a scenario label, not the mirror bundle.
    expect(
      isProtectedLeagueBundleName(
        "2026-05-08T16-36-05-553Z-league-mock-llm-1c",
      ),
    ).toBe(false);
  });

  test("isSafeAiLeagueRunName refuses traversal and dotfiles", () => {
    expect(
      isSafeAiLeagueRunName("2026-05-08T16-35-58-815Z-league-rule-c8"),
    ).toBe(true);
    expect(isSafeAiLeagueRunName("..")).toBe(false);
    expect(isSafeAiLeagueRunName("../escape")).toBe(false);
    expect(isSafeAiLeagueRunName("a/b")).toBe(false);
    expect(isSafeAiLeagueRunName(".hidden")).toBe(false);
    expect(isSafeAiLeagueRunName("")).toBe(false);
  });
});

describe("citation tokens", () => {
  test("include the full name and a trailing hex hash", () => {
    expect(
      runCitationTokens("2026-06-05T21-02-53-432Z-actions-planner-82816b8b"),
    ).toEqual([
      "2026-06-05T21-02-53-432Z-actions-planner-82816b8b",
      "82816b8b",
    ]);
  });

  test("include only the full name when there is no hex suffix", () => {
    expect(runCitationTokens("2026-05-16-champion-agent-final-run-1")).toEqual([
      "2026-05-16-champion-agent-final-run-1",
    ]);
  });

  test("isRunCited matches either a full-name or a bare-hash reference", () => {
    const corpus = "see run 82816b8b for the long-form proof";
    expect(
      isRunCited("2026-06-05T21-02-53-432Z-actions-planner-82816b8b", corpus),
    ).toBe(true);
    expect(
      isRunCited("2026-06-05T21-02-53-432Z-actions-planner-deadbeef", corpus),
    ).toBe(false);
  });
});

describe("classifyAiLeagueRuns", () => {
  const baseOptions = {
    nowMs: NOW_MS,
    citationCorpus: "",
    pinnedRunNames: new Set<string>(),
    retainNewest: 2,
    ttlDays: 30,
  };

  test("skips league mirror bundles and unsafe entries", () => {
    const result = classifyAiLeagueRuns({
      ...baseOptions,
      entries: [
        entry("league"),
        entry("league-coworld-2026-07-21T06-02-22-088Z-d0"),
        entry("2026-01-01T00-00-00-000Z-actions-mock-llm-aaaaaaaa", {
          isDirectory: false,
        }),
        entry("2026-01-01T00-00-00-000Z-actions-mock-llm-bbbbbbbb", {
          isSymbolicLink: true,
        }),
        entry("../escape"),
      ],
    });
    expect(result.skippedLeagueBundles).toEqual([
      "league",
      "league-coworld-2026-07-21T06-02-22-088Z-d0",
    ]);
    expect(result.skippedUnsafeNames).toContain("../escape");
    expect(result.skippedUnsafeNames).toHaveLength(3);
    expect(result.candidates).toBe(0);
    expect(result.eligible).toHaveLength(0);
  });

  test("protects the newest N regardless of age", () => {
    const result = classifyAiLeagueRuns({
      ...baseOptions,
      retainNewest: 2,
      entries: [
        entry("2026-01-01T00-00-00-000Z-actions-a"),
        entry("2026-02-01T00-00-00-000Z-actions-b"),
        entry("2026-03-01T00-00-00-000Z-actions-c"),
      ],
    });
    // b and c are the two newest -> protected; a is the only eligible one.
    expect(result.protectedByNewest).toBe(2);
    expect(result.eligible.map((run) => run.name)).toEqual([
      "2026-01-01T00-00-00-000Z-actions-a",
    ]);
  });

  test("protects runs newer than the TTL even when beyond newest-N", () => {
    const result = classifyAiLeagueRuns({
      ...baseOptions,
      retainNewest: 1,
      ttlDays: 30,
      entries: [
        entry("2026-07-20-fresh-run"), // 1 day old -> newest protected
        entry("2026-07-19-fresh-run"), // 2 days old -> TTL protected
        entry("2026-01-01-old-run"), // ~200 days old -> eligible
      ],
    });
    expect(result.protectedByTtl).toBe(1); // one fresh run beyond newest-1
    expect(result.protectedByNewest).toBe(1);
    expect(result.eligible.map((run) => run.name)).toEqual([
      "2026-01-01-old-run",
    ]);
  });

  test("protects cited and pinned runs", () => {
    const result = classifyAiLeagueRuns({
      ...baseOptions,
      retainNewest: 1,
      citationCorpus: "evidence run 2026-01-02-cited-run and hash cccccccc",
      pinnedRunNames: new Set(["2026-01-03-pinned-run"]),
      entries: [
        entry("2026-07-20-newest-run"),
        entry("2026-01-01T00-00-00-000Z-actions-cccccccc"), // cited via hash
        entry("2026-01-02-cited-run"), // cited via full name
        entry("2026-01-03-pinned-run"), // pinned
        entry("2026-01-04-plain-old-run"), // eligible
      ],
    });
    expect(result.protectedByPin).toEqual(["2026-01-03-pinned-run"]);
    expect(result.protectedByCitation.sort()).toEqual([
      "2026-01-01T00-00-00-000Z-actions-cccccccc",
      "2026-01-02-cited-run",
    ]);
    expect(result.eligible.map((run) => run.name)).toEqual([
      "2026-01-04-plain-old-run",
    ]);
  });

  test("falls back to mtime for names without a timestamp and sorts eligible oldest-first", () => {
    const result = classifyAiLeagueRuns({
      ...baseOptions,
      retainNewest: 1,
      entries: [
        entry("wr-newest", { modifiedAtMs: NOW_MS - 2 * DAY_MS }),
        entry("2026-01-10-mid", {}),
        entry("2026-01-01-oldest", {}),
      ],
    });
    // wr-newest (2 days old) is the newest -> protected by newest-1.
    // The two old timestamped runs are eligible, oldest first.
    expect(result.eligible.map((run) => run.name)).toEqual([
      "2026-01-01-oldest",
      "2026-01-10-mid",
    ]);
  });
});

describe("selectWithinCaps", () => {
  test("stops at the directory-count cap", () => {
    const result = selectWithinCaps({
      eligible: [sized("a", 1), sized("b", 1), sized("c", 1)],
      maxDirs: 2,
      maxBytes: 1024 ** 4,
    });
    expect(result.selected.map((run) => run.name)).toEqual(["a", "b"]);
    expect(result.deferred).toBe(1);
    expect(result.selectedBytes).toBe(2);
  });

  test("stops before breaching the byte cap", () => {
    const result = selectWithinCaps({
      eligible: [sized("a", 400), sized("b", 400), sized("c", 400)],
      maxDirs: 100,
      maxBytes: 900,
    });
    // a + b = 800 <= 900; adding c would breach -> stop.
    expect(result.selected.map((run) => run.name)).toEqual(["a", "b"]);
    expect(result.selectedBytes).toBe(800);
    expect(result.deferred).toBe(1);
  });

  test("selects everything when within both caps", () => {
    const result = selectWithinCaps({
      eligible: [sized("a", 10), sized("b", 10)],
      maxDirs: 100,
      maxBytes: 1000,
    });
    expect(result.selected).toHaveLength(2);
    expect(result.deferred).toBe(0);
  });
});

describe("runAiLeagueRunsRetention", () => {
  let temporaryRoot: string;
  let runsRootDir: string;
  let docsDir: string;
  let stateDir: string;

  const now = new Date("2026-07-21T00:00:00.000Z");

  async function makeRun(name: string, bytes: number): Promise<void> {
    const dir = path.join(runsRootDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "decisions.jsonl"), "x".repeat(bytes));
  }

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-runs-retention-"),
    );
    runsRootDir = path.join(temporaryRoot, "artifacts", "ai-league-runs");
    docsDir = path.join(temporaryRoot, "docs");
    stateDir = path.join(temporaryRoot, "state");
    await fs.mkdir(runsRootDir, { recursive: true });
    await fs.mkdir(docsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  function baseOptions() {
    return {
      runsRootDir,
      citationRoots: [docsDir],
      citationExtensions: [".md"],
      pinnedRunNames: new Set<string>(),
      stateDir,
      retainNewest: 1,
      ttlDays: 30,
      maxDirs: 200,
      maxBytes: 5 * 1024 ** 3,
      archiveToDir: null,
      now,
    };
  }

  test("dry-run reports a plan without deleting anything", async () => {
    await makeRun("2026-07-20-fresh", 100); // TTL protected
    await makeRun("2026-01-01-old-a", 100); // eligible
    await makeRun("2026-01-02-old-b", 100); // eligible
    await makeRun("league", 100); // protected bundle

    const report = await runAiLeagueRunsRetention({
      ...baseOptions(),
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.protectedCounts.leagueBundles).toBe(1);
    expect(report.plan.selectedCount).toBe(2);
    expect(report.removed).toEqual([]);
    expect(report.auditManifestPath).toBeNull();
    // Nothing removed on disk.
    await expect(
      fs.stat(path.join(runsRootDir, "2026-01-01-old-a")),
    ).resolves.toBeTruthy();
  });

  test("apply removes eligible runs, keeps protected runs, writes an audit manifest", async () => {
    await makeRun("2026-07-20-fresh", 100); // TTL protected (newest)
    await makeRun("2026-01-01-old-a", 100); // eligible
    await makeRun("2026-01-02-old-b", 100); // eligible
    await makeRun("league", 100); // protected bundle
    await fs.writeFile(
      path.join(docsDir, "evidence.md"),
      "keep run 2026-01-01-old-a as cited proof\n",
    );

    const report = await runAiLeagueRunsRetention({
      ...baseOptions(),
      dryRun: false,
    });

    expect(report.removed).toEqual(["2026-01-02-old-b"]);
    expect(report.protectedCounts.citation).toBe(1);
    // Cited + fresh + league survive; only the plain old run is gone.
    await expect(
      fs.stat(path.join(runsRootDir, "2026-01-02-old-b")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(runsRootDir, "2026-01-01-old-a")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(runsRootDir, "league")),
    ).resolves.toBeTruthy();

    expect(report.auditManifestPath).not.toBeNull();
    const manifest = JSON.parse(
      await fs.readFile(report.auditManifestPath as string, "utf8"),
    );
    expect(manifest.tool).toBe("ai-league-runs-retention");
    expect(manifest.removed.map((run: { name: string }) => run.name)).toEqual([
      "2026-01-02-old-b",
    ]);
    expect(manifest.completed).toBe(true);
  });

  test("archive mode moves eligible runs instead of deleting them", async () => {
    await makeRun("2026-07-20-fresh", 100);
    await makeRun("2026-01-01-old-a", 100);
    const archiveDir = path.join(temporaryRoot, "archive");

    const report = await runAiLeagueRunsRetention({
      ...baseOptions(),
      archiveToDir: archiveDir,
      dryRun: false,
    });

    expect(report.mode).toBe("archive");
    expect(report.removed).toEqual(["2026-01-01-old-a"]);
    await expect(
      fs.stat(path.join(runsRootDir, "2026-01-01-old-a")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(archiveDir, "2026-01-01-old-a", "decisions.jsonl")),
    ).resolves.toBeTruthy();
  });

  test("respects the byte cap across a single invocation", async () => {
    await makeRun("2026-07-20-fresh", 100);
    await makeRun("2026-01-01-old-a", 300);
    await makeRun("2026-01-02-old-b", 300);

    const report = await runAiLeagueRunsRetention({
      ...baseOptions(),
      maxBytes: 500,
      dryRun: false,
    });

    // old-a (300) fits; old-b would push past 500 -> deferred.
    expect(report.removed).toEqual(["2026-01-01-old-a"]);
    expect(report.plan.deferred).toBe(1);
  });

  test("refuses a runsRoot that is not the ai-league-runs directory", async () => {
    expect(() =>
      requireSafeAiLeagueRunsRetentionLayout(path.join(temporaryRoot, "docs")),
    ).toThrow(/ai-league-runs/);
    await expect(
      runAiLeagueRunsRetention({
        ...baseOptions(),
        runsRootDir: docsDir,
        dryRun: true,
      }),
    ).rejects.toThrow(/ai-league-runs/);
  });

  test("directorySizeBytes ignores symlinks and sums regular files", async () => {
    await makeRun("2026-01-01-sizing", 250);
    const size = await directorySizeBytes(
      path.join(runsRootDir, "2026-01-01-sizing"),
    );
    expect(size).toBe(250);
  });
});
