import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeNextWeeklyCadence,
  runProgramWeek,
} from "../../src/scripts/season-program-week-lib";
import { readFeaturedMatchStore } from "../../src/server/agents/FeaturedMatch";
import {
  findEventPackage,
  readEventPackageStore,
} from "../../src/server/agents/season/EventPackage";
import {
  loadSeasonRegistry,
  saveSeasonRegistry,
} from "../../src/server/agents/season/SeasonRegistry";
import type {
  Season,
  SeasonEventSlot,
} from "../../src/server/agents/season/SeasonSchemas";

/**
 * `season:program-week` — full pipeline coverage. Identity-dependent
 * scenarios (both candidate lanes' promotion/participants/gate) run as
 * REAL SUBPROCESSES: `loadIdentityRegistrySnapshot()`'s default directory
 * (`IdentityRegistry.ts`'s `defaultIdentityRegistryDir`) is computed ONCE
 * at module import time from `process.env.PROXYWAR_IDENTITY_REGISTRY_DIR`
 * — setting that env var from an in-process `beforeEach` after this
 * suite's OWN imports have already pulled the identity module in (via
 * `season-program-week-lib.ts`'s own `feature-candidates.ts`/
 * `premiere-schedule-lib.ts` chain) has no effect. This is exactly why
 * `feature-promote.test.ts`/`premiere-schedule-cli.test.ts` test their
 * own identity-dependent paths as real subprocesses rather than direct
 * function calls — reused here for the same reason. Identity-independent
 * behavior (no active season, `--episode` not-found, cadence math) is
 * covered in-process against `runProgramWeek` directly for speed.
 */

const NOW = new Date("2026-08-01T00:00:00.000Z");

function baseSeason(overrides: Partial<Season> = {}): Season {
  return {
    schemaVersion: 1,
    id: "season_zero",
    slug: "zero",
    title: "Season Zero",
    description: "",
    startDate: "2026-08-01",
    endDate: "2026-09-26",
    state: "active",
    eventSlots: [],
    archiveFeaturedMatchIds: [],
    standingsSnapshotRefs: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

async function writeSeasonRegistry(
  seasonRegistryPath: string,
  seasons: readonly Season[],
): Promise<void> {
  await saveSeasonRegistry(
    { schemaVersion: 1, seasons: [...seasons] },
    seasonRegistryPath,
  );
}

async function writeEmptyIdentity(artifactsRoot: string): Promise<void> {
  await writeFile(
    path.join(artifactsRoot, "builders.json"),
    JSON.stringify({ schemaVersion: 1, builders: [] }),
    "utf8",
  );
  await writeFile(
    path.join(artifactsRoot, "agents.json"),
    JSON.stringify({ schemaVersion: 1, agents: [] }),
    "utf8",
  );
  await writeFile(
    path.join(artifactsRoot, "versions.json"),
    JSON.stringify({ schemaVersion: 1, versions: [] }),
    "utf8",
  );
}

/**
 * Real registered identity for both lanes' fixtures — Auri/Sefirot
 * (premiere) and Solo/Rival/Third/Fourth (archive) — `firstObservedAt`
 * inside the version-debut claim's 14-day window, matching
 * `premiere-schedule-cli.test.ts`'s own `writeRealIdentity`. The archive
 * lane uses FOUR participants deliberately: `premiere-package.ts`'s
 * `defaultTitle` joins <=3 participant names literally ("A vs B"), which
 * unavoidably spells out the winner's own name for an archive-lane match
 * (result populated immediately at promotion) — `containsWinnerName`
 * then correctly flags `title_spoils_result`. The real Season Zero
 * activation hit and sidestepped this identical shape with its own
 * 12-way battle pick ("A 12-way battle — World"); four participants here
 * is the same sidestep at test scale, not a new gap this suite covers.
 */
async function writeRealIdentity(artifactsRoot: string): Promise<void> {
  await writeFile(
    path.join(artifactsRoot, "builders.json"),
    JSON.stringify({ schemaVersion: 1, builders: [] }),
    "utf8",
  );
  const agent = (
    id: string,
    name: string,
    shortCode: string,
    family: string,
  ) => ({
    id,
    slug: name.toLowerCase(),
    displayName: name,
    shortCode,
    builderId: null,
    tagline: null,
    description: null,
    emblem: {
      style: "geometric-svg-v1",
      seed: id,
      assetPath: `resources/identity/emblems/${id}.svg`,
    },
    primaryColor: "#112233",
    secondaryColor: "#445566",
    debutDate: null,
    policyMatchRule: { playerName: name, policyFamily: family },
    status: "unclaimed",
    publicStrategyDescription: null,
  });
  await writeFile(
    path.join(artifactsRoot, "agents.json"),
    JSON.stringify({
      schemaVersion: 1,
      agents: [
        agent("agt_auri", "Auri", "AURI", "auri-intent"),
        agent("agt_sefirot", "Sefirot", "SEFI", "sefirot-intent"),
        agent("agt_solo", "Solo", "SOLO", "solo-intent"),
        agent("agt_rival", "Rival", "RIVL", "rival-intent"),
        agent("agt_third", "Third", "THRD", "third-intent"),
        agent("agt_fourth", "Fourth", "FRTH", "fourth-intent"),
      ],
    }),
    "utf8",
  );
  const version = (
    id: string,
    agentId: string,
    label: string,
    policyLabel: string,
  ) => ({
    id,
    agentId,
    publicVersionLabel: label,
    softmaxPolicyLabel: policyLabel,
    immutableDigest: null,
    releaseDate: null,
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["rating"],
    observedAt: NOW.toISOString(),
    firstObservedAt: NOW.toISOString(),
  });
  await writeFile(
    path.join(artifactsRoot, "versions.json"),
    JSON.stringify({
      schemaVersion: 1,
      versions: [
        version("agtv_auri_v43", "agt_auri", "v43", "auri-intent:v43"),
        version("agtv_sefirot_v10", "agt_sefirot", "v10", "sefirot-intent:v10"),
        version("agtv_solo_v1", "agt_solo", "v1", "solo-intent:v1"),
        version("agtv_rival_v1", "agt_rival", "v1", "rival-intent:v1"),
        version("agtv_third_v1", "agt_third", "v1", "third-intent:v1"),
        version("agtv_fourth_v1", "agt_fourth", "v1", "fourth-intent:v1"),
      ],
    }),
    "utf8",
  );
}

async function writePremiereQueueItem(
  queueReadyDir: string,
  name: string,
  experienceRequestId: string,
): Promise<void> {
  const dir = path.join(queueReadyDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "real-league",
      runId: name,
      sourceFile: "bundle.source.json",
      sha256: "abc",
      turnCount: 9000,
      seatCount: 2,
      map: "world",
      checkpointTurns: [3150, 5850],
      turnIntervalMs: 120,
      coworldId: "cow_x",
      variantId: "v1",
      episodeId: null,
      experienceRequestId,
      generatedAt: NOW.toISOString(),
    }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "bundle.source.json"),
    JSON.stringify({
      schemaVersion: 1,
      bundleKind: "proxywar_rated_coworld_source",
      sourceRunId: name,
      seats: [
        {
          seatId: "c1",
          displayName: "Auri",
          policyIdentity: {
            namespace: "softmax_policy_version",
            policyVersionId: "pv_c1",
            policyName: "auri-intent:v43",
            serverAssignedVersion: "v1",
          },
        },
        {
          seatId: "c2",
          displayName: "Sefirot",
          policyIdentity: {
            namespace: "softmax_policy_version",
            policyVersionId: "pv_c2",
            policyName: "sefirot-intent:v10",
            serverAssignedVersion: "v1",
          },
        },
      ],
    }),
    "utf8",
  );
}

async function writeArchiveMirror(
  artifactsRoot: string,
  episodeRequestId: string,
): Promise<void> {
  const siteDir = path.join(artifactsRoot, "ai-league-runs", "league");
  await mkdir(siteDir, { recursive: true });
  await writeFile(
    path.join(siteDir, "data.json"),
    JSON.stringify({
      generatedAt: NOW.toISOString(),
      lastGoodSyncAt: NOW.toISOString(),
      stale: false,
      league: {
        id: "league_test",
        name: "Test League",
        description: null,
        divisionName: "Open",
        roundIntervalMinutes: null,
        episodesPerRound: null,
        currentRoundNumber: null,
        currentRoundStatus: null,
        scoreLabel: "Score",
      },
      standings: [
        {
          rank: 1,
          playerName: "Solo",
          ratingPolicyLabel: "solo-intent:v1",
          activeChampionPolicyLabel: null,
          policyLabel: "solo-intent:v1",
          score: 100,
          roundsPlayed: 5,
          isHouse: false,
        },
        {
          rank: 2,
          playerName: "Rival",
          ratingPolicyLabel: "rival-intent:v1",
          activeChampionPolicyLabel: null,
          policyLabel: "rival-intent:v1",
          score: 80,
          roundsPlayed: 5,
          isHouse: false,
        },
        {
          rank: 3,
          playerName: "Third",
          ratingPolicyLabel: "third-intent:v1",
          activeChampionPolicyLabel: null,
          policyLabel: "third-intent:v1",
          score: 60,
          roundsPlayed: 5,
          isHouse: false,
        },
        {
          rank: 4,
          playerName: "Fourth",
          ratingPolicyLabel: "fourth-intent:v1",
          activeChampionPolicyLabel: null,
          policyLabel: "fourth-intent:v1",
          score: 40,
          roundsPlayed: 5,
          isHouse: false,
        },
      ],
      rounds: [],
      episodes: [
        {
          episodeRequestId,
          shortId: "SMK",
          roundNumber: 1,
          completedAt: "2026-07-20T00:00:00.000Z",
          map: "Pangaea",
          mapSize: "Normal",
          turnCount: 1000,
          decisionCount: 500,
          degradedCount: 0,
          winnerName: "Solo",
          players: [
            {
              slot: 0,
              name: "Solo",
              tilesOwned: 100,
              isAlive: true,
              isWinner: true,
              color: "#112233",
            },
            {
              slot: 1,
              name: "Rival",
              tilesOwned: 40,
              isAlive: false,
              isWinner: false,
              color: "#445566",
            },
            {
              slot: 2,
              name: "Third",
              tilesOwned: 30,
              isAlive: false,
              isWinner: false,
              color: "#556677",
            },
            {
              slot: 3,
              name: "Fourth",
              tilesOwned: 20,
              isAlive: false,
              isWinner: false,
              color: "#667788",
            },
          ],
          watchHref: "https://example.test/replay",
          fullRenderHref: null,
        },
      ],
      links: {
        enterTheLeagueUrl: "https://example.test",
        platformLabel: "Coworld",
      },
    }),
    "utf8",
  );
}

describe("runProgramWeek — identity-independent behavior (in-process)", () => {
  let seasonDir: string;
  let stateDir: string;
  let artifactsRoot: string;
  let queueRoot: string;

  beforeEach(async () => {
    seasonDir = await mkdtemp(path.join(os.tmpdir(), "pw-programweek-season-"));
    stateDir = await mkdtemp(path.join(os.tmpdir(), "pw-programweek-state-"));
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-programweek-artifacts-"),
    );
    queueRoot = await mkdtemp(path.join(os.tmpdir(), "pw-programweek-queue-"));
    await writeEmptyIdentity(artifactsRoot);
  });

  afterEach(async () => {
    await Promise.all(
      [seasonDir, stateDir, artifactsRoot, queueRoot].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("hard-fails cleanly when no season is active", async () => {
    await writeSeasonRegistry(path.join(seasonDir, "seasons.json"), [
      baseSeason({ state: "draft" }),
    ]);
    const outcome = await runProgramWeek({
      seasonRegistryPath: path.join(seasonDir, "seasons.json"),
      featuredMatchStateRoot: stateDir,
      eventPackageStateRoot: stateDir,
      artifactsRoot,
      queueReadyDir: path.join(queueRoot, "ready"),
      now: () => NOW,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("no_active_season");
    expect(outcome.executed).toBe(false);
  });

  it("hard-fails clearly for an --episode override that matches neither lane", async () => {
    await writeSeasonRegistry(path.join(seasonDir, "seasons.json"), [
      baseSeason(),
    ]);
    const outcome = await runProgramWeek({
      seasonRegistryPath: path.join(seasonDir, "seasons.json"),
      featuredMatchStateRoot: stateDir,
      eventPackageStateRoot: stateDir,
      artifactsRoot,
      queueReadyDir: path.join(queueRoot, "ready"),
      now: () => NOW,
      episodeOverride: "ereq_does_not_exist",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("episode_not_found");
  });

  it("hard-fails cleanly when both lanes are empty and no override is given", async () => {
    await writeSeasonRegistry(path.join(seasonDir, "seasons.json"), [
      baseSeason(),
    ]);
    const outcome = await runProgramWeek({
      seasonRegistryPath: path.join(seasonDir, "seasons.json"),
      featuredMatchStateRoot: stateDir,
      eventPackageStateRoot: stateDir,
      artifactsRoot,
      queueReadyDir: path.join(queueRoot, "ready"),
      now: () => NOW,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(
      "no_gate_eligible_candidate: both lanes are empty",
    );
  });
});

describe("computeNextWeeklyCadence", () => {
  it("defaults to one week from now, rounded up to the top of the hour, when the season has no prior slot", () => {
    const result = computeNextWeeklyCadence(
      [],
      new Date("2026-08-01T00:00:00.000Z"),
    );
    expect(result).toBe("2026-08-08T00:00:00.000Z");
  });

  it("rounds up a non-hour-aligned 'now' to the next full hour", () => {
    const result = computeNextWeeklyCadence(
      [],
      new Date("2026-08-01T00:17:00.000Z"),
    );
    expect(result).toBe("2026-08-08T01:00:00.000Z");
  });

  it("adds one week to the latest existing slot's own scheduledAt", () => {
    const slots: SeasonEventSlot[] = [
      {
        featuredMatchId: "feat_a",
        scheduledAt: "2026-08-01T18:00:00.000Z",
        addedAt: NOW.toISOString(),
      },
      {
        featuredMatchId: "feat_b",
        scheduledAt: "2026-08-08T18:00:00.000Z",
        addedAt: NOW.toISOString(),
      },
    ];
    const result = computeNextWeeklyCadence(slots, NOW);
    expect(result).toBe("2026-08-15T18:00:00.000Z");
  });

  it("ignores unscheduled (null) slots when finding the latest anchor", () => {
    const slots: SeasonEventSlot[] = [
      {
        featuredMatchId: "feat_a",
        scheduledAt: null,
        addedAt: NOW.toISOString(),
      },
      {
        featuredMatchId: "feat_b",
        scheduledAt: "2026-08-08T18:00:00.000Z",
        addedAt: NOW.toISOString(),
      },
    ];
    expect(computeNextWeeklyCadence(slots, NOW)).toBe(
      "2026-08-15T18:00:00.000Z",
    );
  });
});

/**
 * Real subprocess (`tsx`) end-to-end coverage — the only reliable way to
 * exercise identity-dependent candidate selection/promotion/gate
 * behavior, see this file's own module doc.
 */
describe("season:program-week CLI — real subprocess end to end", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const scriptPath = path.join(
    repoRoot,
    "src",
    "scripts",
    "season-program-week.ts",
  );

  let seasonDir: string;
  let stateDir: string;
  let artifactsRoot: string;
  let queueRoot: string;

  function runCli(args: string[]): {
    code: number;
    stdout: string;
    stderr: string;
  } {
    try {
      const stdout = execFileSync("npx", ["tsx", scriptPath, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PROXYWAR_SEASON_REGISTRY_DIR: seasonDir,
          PROXYWAR_FEATURED_MATCH_STATE_ROOT: stateDir,
          PROXYWAR_EVENT_PACKAGE_STATE_ROOT: stateDir,
          PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
          PROXYWAR_IDENTITY_REGISTRY_DIR: artifactsRoot,
          PW_BET_QUEUE_DIR: queueRoot,
        },
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const err = error as { status: number; stdout: Buffer; stderr: Buffer };
      return {
        code: err.status,
        stdout: err.stdout?.toString("utf8") ?? "",
        stderr: err.stderr?.toString("utf8") ?? "",
      };
    }
  }

  beforeEach(async () => {
    seasonDir = await mkdtemp(
      path.join(os.tmpdir(), "pw-programweek-cli-season-"),
    );
    stateDir = await mkdtemp(
      path.join(os.tmpdir(), "pw-programweek-cli-state-"),
    );
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-programweek-cli-artifacts-"),
    );
    queueRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-programweek-cli-queue-"),
    );
    await writeEmptyIdentity(artifactsRoot);
  });

  afterEach(async () => {
    await Promise.all(
      [seasonDir, stateDir, artifactsRoot, queueRoot].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("defaults to dry run and reports no_active_season on a cold start", () => {
    const result = runCli([]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("no_active_season");
  });

  describe("archive lane", () => {
    beforeEach(async () => {
      await writeRealIdentity(artifactsRoot);
      await writeArchiveMirror(artifactsRoot, "ereq_archive1");
      await writeSeasonRegistry(path.join(seasonDir, "seasons.json"), [
        baseSeason(),
      ]);
    });

    it("dry run: picks the archive candidate, computes a passing gate, and writes NOTHING to any store", async () => {
      const result = runCli(["--at=2026-08-08T18:00:00.000Z", "--json"]);
      expect(result.code).toBe(0);
      const outcome = JSON.parse(result.stdout);
      expect(outcome.ok).toBe(true);
      expect(outcome.executed).toBe(false);
      expect(outcome.lane).toBe("archive");
      expect(outcome.missing).toEqual([]);
      expect(outcome.scheduledAt).toBe("2026-08-08T18:00:00.000Z");

      const matches = await readFeaturedMatchStore(stateDir);
      expect(matches.matches).toEqual([]);
      const packages = await readEventPackageStore(stateDir);
      expect(packages.packages).toEqual([]);
      const registry = await loadSeasonRegistry(
        path.join(seasonDir, "seasons.json"),
      );
      expect(registry.seasons[0]!.eventSlots).toEqual([]);
    });

    it("--execute commits promotion, package, and the season slot", async () => {
      const result = runCli([
        "--at=2026-08-08T18:00:00.000Z",
        "--execute",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const outcome = JSON.parse(result.stdout);
      expect(outcome.ok).toBe(true);
      expect(outcome.executed).toBe(true);
      expect(outcome.matchId).toBeTruthy();

      const matches = await readFeaturedMatchStore(stateDir);
      expect(matches.matches).toHaveLength(1);
      expect(matches.matches[0]!.lane).toBe("archive");
      expect(matches.matches[0]!.state).toBe("published");

      const packages = await readEventPackageStore(stateDir);
      const savedPackage = findEventPackage(packages, outcome.matchId);
      expect(savedPackage).not.toBeNull();

      const registry = await loadSeasonRegistry(
        path.join(seasonDir, "seasons.json"),
      );
      const slots: SeasonEventSlot[] = registry.seasons[0]!.eventSlots;
      expect(slots).toHaveLength(1);
      expect(slots[0]!.featuredMatchId).toBe(outcome.matchId);
      expect(slots[0]!.scheduledAt).toBe("2026-08-08T18:00:00.000Z");

      expect(outcome.undoCommands).toEqual([
        `npm run season:remove-event -- --season=season_zero --featured=${outcome.matchId}`,
      ]);
    }, 30000);

    it("is idempotent-safe: running --execute twice re-promotes the SAME matchId, not a duplicate", async () => {
      const first = JSON.parse(
        runCli(["--at=2026-08-08T18:00:00.000Z", "--execute", "--json"]).stdout,
      );
      expect(first.ok).toBe(true);
      const second = JSON.parse(
        runCli(["--at=2026-08-15T18:00:00.000Z", "--execute", "--json"]).stdout,
      );
      expect(second.ok).toBe(true);
      expect(second.matchId).toBe(first.matchId);

      const matches = await readFeaturedMatchStore(stateDir);
      expect(matches.matches).toHaveLength(1);
    }, 30000);
  });

  describe("premiere lane", () => {
    beforeEach(async () => {
      await writeRealIdentity(artifactsRoot);
      await writePremiereQueueItem(
        path.join(queueRoot, "ready"),
        "20260801T000000Z-run1",
        "ereq_premiere1",
      );
      await writeSeasonRegistry(path.join(seasonDir, "seasons.json"), [
        baseSeason(),
      ]);
    });

    it("dry run: schedules+publishes+packages in-memory only, gate passes, nothing written", async () => {
      const result = runCli(["--at=2026-08-08T18:00:00.000Z", "--json"]);
      expect(result.code).toBe(0);
      const outcome = JSON.parse(result.stdout);
      expect(outcome.ok).toBe(true);
      expect(outcome.executed).toBe(false);
      expect(outcome.lane).toBe("premiere");
      expect(outcome.missing).toEqual([]);

      const matches = await readFeaturedMatchStore(stateDir);
      expect(matches.matches).toEqual([]);
      const registry = await loadSeasonRegistry(
        path.join(seasonDir, "seasons.json"),
      );
      expect(registry.seasons[0]!.eventSlots).toEqual([]);
    });

    it("--execute commits schedule -> publish -> package -> season:add-event for the premiere lane", async () => {
      const result = runCli([
        "--at=2026-08-08T18:00:00.000Z",
        "--execute",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const outcome = JSON.parse(result.stdout);
      expect(outcome.ok).toBe(true);
      expect(outcome.executed).toBe(true);

      const matches = await readFeaturedMatchStore(stateDir);
      expect(matches.matches).toHaveLength(1);
      expect(matches.matches[0]!.state).toBe("published");
      expect(matches.matches[0]!.participants).toEqual([
        {
          playerName: "Auri",
          agentId: "agt_auri",
          agentVersionId: "agtv_auri_v43",
          builderId: null,
        },
        {
          playerName: "Sefirot",
          agentId: "agt_sefirot",
          agentVersionId: "agtv_sefirot_v10",
          builderId: null,
        },
      ]);

      const packages = await readEventPackageStore(stateDir);
      const savedPackage = findEventPackage(packages, outcome.matchId);
      expect(savedPackage).not.toBeNull();

      const registry = await loadSeasonRegistry(
        path.join(seasonDir, "seasons.json"),
      );
      expect(registry.seasons[0]!.eventSlots).toHaveLength(1);

      expect(outcome.undoCommands).toEqual([
        `npm run season:remove-event -- --season=season_zero --featured=${outcome.matchId}`,
        `npm run premiere:cancel -- --episode=${outcome.matchId}`,
      ]);
    }, 30000);

    it("--episode overrides auto-selection to a specific candidate", async () => {
      await writePremiereQueueItem(
        path.join(queueRoot, "ready"),
        "20260801T000000Z-run2",
        "ereq_premiere2",
      );
      const result = runCli([
        "--episode=20260801T000000Z-run2",
        "--at=2026-08-08T18:00:00.000Z",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const outcome = JSON.parse(result.stdout);
      expect(outcome.ok).toBe(true);
      expect(outcome.episodeRef).toBe("20260801T000000Z-run2");
    });
  });

  describe("gate-failure hard stop", () => {
    it("never writes a season slot when the gate fails, and reports the exact missing[] list", async () => {
      // No identity registered -> participants can never resolve -> the
      // gate must fail on participant_identity_unresolved.
      await writePremiereQueueItem(
        path.join(queueRoot, "ready"),
        "20260801T000000Z-run1",
        "ereq_premiere1",
      );
      await writeSeasonRegistry(path.join(seasonDir, "seasons.json"), [
        baseSeason(),
      ]);

      const dryRun = JSON.parse(
        runCli(["--at=2026-08-08T18:00:00.000Z", "--json"]).stdout,
      );
      expect(dryRun.ok).toBe(false);
      expect(dryRun.reason).toBe("gate_failed");
      expect(dryRun.missing.length).toBeGreaterThan(0);
      expect(
        dryRun.missing.some((m: string) =>
          m.startsWith("participant_identity_unresolved"),
        ),
      ).toBe(true);

      // Dry run must still write nothing.
      const matchesAfterDryRun = await readFeaturedMatchStore(stateDir);
      expect(matchesAfterDryRun.matches).toEqual([]);

      const executed = JSON.parse(
        runCli(["--at=2026-08-08T18:00:00.000Z", "--execute", "--json"]).stdout,
      );
      expect(executed.ok).toBe(false);
      expect(executed.reason).toBe("gate_failed");
      expect(executed.missing.length).toBeGreaterThan(0);

      // --execute still commits the schedule/publish/package steps
      // (matching the real manual workflow's own partial-completion
      // semantics — see season-program-week-lib.ts's own module doc) ...
      const matchesAfterExecute = await readFeaturedMatchStore(stateDir);
      expect(matchesAfterExecute.matches).toHaveLength(1);
      const packagesAfterExecute = await readEventPackageStore(stateDir);
      expect(packagesAfterExecute.packages).toHaveLength(1);

      // ... but NEVER folds the event into the season programme.
      const registry = await loadSeasonRegistry(
        path.join(seasonDir, "seasons.json"),
      );
      expect(registry.seasons[0]!.eventSlots).toEqual([]);
      expect(executed.undoCommands).toEqual([]);
    }, 30000);
  });
});
