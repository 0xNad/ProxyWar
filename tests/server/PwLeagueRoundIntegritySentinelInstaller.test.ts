import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

// @ts-expect-error The host installer is intentionally plain Node ESM.
import { buildPwLeagueRoundIntegrityArtifact } from "../../scripts/build-pw-league-round-integrity.mjs";
// @ts-expect-error The host installer is intentionally plain Node ESM.
import * as sentinelInstaller from "../../scripts/install-pw-league-round-integrity-sentinel.mjs";
// @ts-expect-error The installed dependency-free adapter is intentionally plain Node ESM.
import { collectConfirmedCoworldRoundIntegrity } from "../../scripts/pw-league-round-integrity-sentinel-adapter.mjs";
import {
  COWORLD_ROUND_INTEGRITY_CONFIRMATION_MS,
  coworldRoundIntegrityCriticalSignal,
  episodeRowsByRoundId,
  evaluateCoworldRoundIntegrity,
  parseCoworldLadderIntegritySettings,
  recentTerminalCompletedRounds,
} from "../../src/server/agents/CoworldLeagueRoundIntegrity";

const {
  dryRunPwLeagueSentinelRoundIntegrity,
  inspectPwLeagueSentinelRoundIntegrity,
  INSTALLED_ADAPTER_BASENAME,
  INSTALLED_DETECTOR_BASENAME,
  installPwLeagueSentinelRoundIntegrity,
  rollbackPwLeagueSentinelRoundIntegrity,
  transformPwLeagueSentinelSource,
  verifyPwLeagueSentinelRoundIntegrity,
} = sentinelInstaller;

const temporaryDirectories: string[] = [];
const repositoryHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: path.resolve("."),
  encoding: "utf8",
}).trim();
const cleanRepositoryIdentity = async () => ({
  head: repositoryHead,
  trackedStatus: "",
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const detector = {
  COWORLD_ROUND_INTEGRITY_CONFIRMATION_MS,
  episodeRowsByRoundId,
  evaluateCoworldRoundIntegrity,
  parseCoworldLadderIntegritySettings,
  recentTerminalCompletedRounds,
  coworldRoundIntegrityCriticalSignal,
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureRound() {
  return {
    id: "round_1897",
    round_number: 1897,
    status: "completed",
    completed_at: "2026-08-21T19:19:43.947983Z",
  };
}

function fixtureEpisodes(phantomCount = 14) {
  return Array.from({ length: 25 }, (_, index) =>
    index < 25 - phantomCount
      ? {
          id: `ereq_${index}`,
          round_id: "round_1897",
          status: "completed",
          episode_id: `episode_${index}`,
          running_at: "2026-08-21T19:15:31.000Z",
          error: null,
          policy_version_ids: [`policy_${index}`],
          scores: [{ policy_version_id: `policy_${index}`, score: 1 }],
        }
      : {
          id: `ereq_${index}`,
          round_id: "round_1897",
          status: "completed",
          episode_id: null,
          running_at: null,
          error: null,
          policy_version_ids: [`policy_${index}`],
          scores: [],
        },
  );
}

function fixtureCoworld(episodeReads: unknown[][]) {
  const calls: string[][] = [];
  let episodeRead = 0;
  return {
    calls,
    coworld: async (args: string[]) => {
      calls.push([...args]);
      if (args[0] === "rounds") return [fixtureRound()];
      if (args[0] === "leagues") {
        return {
          id: "league_test",
          settings: {
            round_interval_minutes: 25,
            ladder: {
              scheduler: { num_episodes: 25 },
              fulfillment: { allowed_failures: 0.05 },
            },
          },
        };
      }
      if (args[0] === "results") {
        return [
          {
            id: "division_test",
            name: "Competition",
            level: 2,
            member_count: 12,
          },
        ];
      }
      if (args[0] === "episodes") {
        const result =
          episodeReads[Math.min(episodeRead, episodeReads.length - 1)];
        episodeRead += 1;
        return result;
      }
      throw new Error(`unexpected Coworld call ${args.join(" ")}`);
    },
  };
}

test("emits round_incomplete_execution only after identical evidence persists for 60 seconds", async () => {
  const hosted = fixtureCoworld([fixtureEpisodes(), fixtureEpisodes()]);
  let clock = 0;
  const result = await collectConfirmedCoworldRoundIntegrity({
    coworld: hosted.coworld,
    leagueId: "league_test",
    initialRoundsRaw: [fixtureRound()],
    detector,
    sleep: async (milliseconds: number) => {
      clock += milliseconds;
    },
    now: () => clock,
  });

  expect(result).toMatchObject({
    status: "confirmed_breach",
    signal: {
      class: "round_incomplete_execution",
      key: "round_1897",
      severity: "critical",
    },
    evidence: {
      confirmationMs: 60_000,
      observedForMs: 60_000,
      second: {
        assessment: {
          scoreBearingCount: 11,
          effectiveFailureCount: 14,
          phantomFailureCount: 14,
        },
      },
    },
  });
  expect(
    hosted.calls.filter(([command]) => command === "episodes"),
  ).toHaveLength(2);
});

test("does not emit when evidence changes or elapsed confirmation is short", async () => {
  const changed = fixtureCoworld([fixtureEpisodes(), fixtureEpisodes(13)]);
  let changedClock = 0;
  const changedResult = await collectConfirmedCoworldRoundIntegrity({
    coworld: changed.coworld,
    leagueId: "league_test",
    initialRoundsRaw: [fixtureRound()],
    detector,
    sleep: async (milliseconds: number) => {
      changedClock += milliseconds;
    },
    now: () => changedClock,
  });
  expect(changedResult).toMatchObject({
    status: "confirmation_lost",
    signal: null,
  });

  const short = fixtureCoworld([fixtureEpisodes(), fixtureEpisodes()]);
  let shortClock = 0;
  const shortResult = await collectConfirmedCoworldRoundIntegrity({
    coworld: short.coworld,
    leagueId: "league_test",
    initialRoundsRaw: [fixtureRound()],
    detector,
    sleep: async () => {
      shortClock += 59_999;
    },
    now: () => shortClock,
  });
  expect(shortResult).toMatchObject({
    status: "confirmation_lost",
    signal: null,
    evidence: { observedForMs: 59_999 },
  });
});

function sentinelFixtureSource(): string {
  return [
    "#!/usr/bin/env node",
    'import { promisify } from "node:util";',
    'const LEAGUE_ID = "league_test";',
    "const coworld = async () => [];",
    "async function collect() {",
    "  const signals = [];",
    "  const evidence = {};",
    "  try {",
    "    const roundsRaw = [];",
    "    const rounds = [];",
    "    evidence.rounds = rounds;",
    "  } catch (error) {",
    "    signals.push({ class: 'probe_error', key: 'rounds', severity: 'warn', detail: String(error) });",
    "  }",
    "  return { signals, evidence };",
    "}",
    "void promisify;",
    "void collect;",
    "",
  ].join("\n");
}

async function temporarySentinel() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "proxywar-sentinel-installer-test-"),
  );
  temporaryDirectories.push(directory);
  const sentinelPath = path.join(directory, "pw-league-sentinel.mjs");
  const source = sentinelFixtureSource();
  await writeFile(sentinelPath, source, { mode: 0o755 });
  await chmod(sentinelPath, 0o755);
  return { directory, sentinelPath, source };
}

async function installTemporarySentinel(
  fixture: Awaited<ReturnType<typeof temporarySentinel>>,
) {
  return installPwLeagueSentinelRoundIntegrity(
    {
      sentinelPath: fixture.sentinelPath,
      expectedSentinelSha256: sha256(fixture.source),
      expectedRepositorySha: repositoryHead,
    },
    { readIdentity: cleanRepositoryIdentity },
  );
}

test("building and copying the detector is explicitly insufficient until the sentinel is wired", async () => {
  const fixture = await temporarySentinel();
  await buildPwLeagueRoundIntegrityArtifact({
    outputPath: path.join(fixture.directory, INSTALLED_DETECTOR_BASENAME),
  });
  await copyFile(
    path.resolve("scripts/pw-league-round-integrity-sentinel-adapter.mjs"),
    path.join(fixture.directory, INSTALLED_ADAPTER_BASENAME),
  );

  const copiedOnly = await inspectPwLeagueSentinelRoundIntegrity({
    sentinelPath: fixture.sentinelPath,
  });
  expect(copiedOnly).toMatchObject({
    active: false,
    detectorPresent: true,
    adapterPresent: true,
    importWired: false,
    callWired: false,
    issues: ["sentinel_not_wired"],
  });

  const transformed = transformPwLeagueSentinelSource(fixture.source);
  await writeFile(fixture.sentinelPath, transformed, { mode: 0o755 });
  const integrated = await inspectPwLeagueSentinelRoundIntegrity({
    sentinelPath: fixture.sentinelPath,
  });
  expect(integrated).toMatchObject({
    active: true,
    issues: [],
    importWired: true,
    callWired: true,
  });
});

test("dry-run self-tests staged bytes without changing the target", async () => {
  const fixture = await temporarySentinel();
  const before = await readFile(fixture.sentinelPath);
  const report = await dryRunPwLeagueSentinelRoundIntegrity({
    sentinelPath: fixture.sentinelPath,
  });
  expect(report).toMatchObject({
    ok: true,
    mode: "dry-run",
    targetMutated: false,
    selfTest: {
      status: "confirmed_breach",
      signal: { class: "round_incomplete_execution" },
      observedForMs: 60_000,
    },
  });
  expect(await readFile(fixture.sentinelPath)).toEqual(before);
});

test("installs with a hash-pinned activation barrier and restores exact prior bytes", async () => {
  const fixture = await temporarySentinel();
  const beforeHash = sha256(fixture.source);
  const installed = await installTemporarySentinel(fixture);
  expect(installed).toMatchObject({
    ok: true,
    mode: "install",
    restartPerformed: false,
    inspection: { active: true, issues: [] },
  });
  expect(await readFile(fixture.sentinelPath, "utf8")).toContain(
    "collectConfirmedCoworldRoundIntegrity({",
  );
  await expect(
    verifyPwLeagueSentinelRoundIntegrity(
      {
        sentinelPath: fixture.sentinelPath,
        receiptPath: installed.receiptPath,
      },
      { readIdentity: cleanRepositoryIdentity },
    ),
  ).resolves.toMatchObject({
    ok: true,
    mode: "verify",
    inspection: { active: true },
    selfTest: { status: "confirmed_breach" },
  });

  const rolledBack = await rollbackPwLeagueSentinelRoundIntegrity({
    receiptPath: installed.receiptPath,
  });
  expect(rolledBack).toMatchObject({
    ok: true,
    mode: "rollback",
    restartPerformed: false,
    restoredHashes: { sentinel: beforeHash, detector: null, adapter: null },
  });
  expect(await readFile(fixture.sentinelPath, "utf8")).toBe(fixture.source);
});

test("aborts on sentinel or repository drift immediately before activation", async () => {
  const sentinelDrift = await temporarySentinel();
  const externalBytes = "external sentinel update\n";
  await expect(
    installPwLeagueSentinelRoundIntegrity(
      {
        sentinelPath: sentinelDrift.sentinelPath,
        expectedSentinelSha256: sha256(sentinelDrift.source),
        expectedRepositorySha: repositoryHead,
      },
      {
        readIdentity: cleanRepositoryIdentity,
        beforeSentinelActivate: async () => {
          await writeFile(sentinelDrift.sentinelPath, externalBytes);
        },
      },
    ),
  ).rejects.toThrow("pre-sentinel-activation sentinel hash drift");
  expect(await readFile(sentinelDrift.sentinelPath, "utf8")).toBe(
    externalBytes,
  );
  await expect(
    readFile(path.join(sentinelDrift.directory, INSTALLED_DETECTOR_BASENAME)),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const repositoryDrift = await temporarySentinel();
  let identityRead = 0;
  await expect(
    installPwLeagueSentinelRoundIntegrity(
      {
        sentinelPath: repositoryDrift.sentinelPath,
        expectedSentinelSha256: sha256(repositoryDrift.source),
        expectedRepositorySha: repositoryHead,
      },
      {
        readIdentity: async () => {
          identityRead += 1;
          return {
            head: identityRead >= 3 ? "f".repeat(40) : repositoryHead,
            trackedStatus: "",
          };
        },
      },
    ),
  ).rejects.toThrow("pre-activation repository SHA drift");
  expect(await readFile(repositoryDrift.sentinelPath, "utf8")).toBe(
    repositoryDrift.source,
  );
});

test("surfaces and records automatic rollback failure after partial activation", async () => {
  const fixture = await temporarySentinel();
  let thrown: unknown;
  try {
    await installPwLeagueSentinelRoundIntegrity(
      {
        sentinelPath: fixture.sentinelPath,
        expectedSentinelSha256: sha256(fixture.source),
        expectedRepositorySha: repositoryHead,
      },
      {
        readIdentity: cleanRepositoryIdentity,
        beforeSentinelActivate: async () => {
          throw new Error("injected activation failure");
        },
        beforeAutomaticRestoreKey: async ({ key }: { key: string }) => {
          if (key === "detector") {
            throw new Error("injected automatic detector restore failure");
          }
        },
      },
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ name: "AggregateError" });
  expect(String((thrown as Error).message)).toContain(
    "injected automatic detector restore failure",
  );
  const backupRoot = path.join(fixture.directory, "pw-league-sentinel-backups");
  const backupEntries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(backupRoot),
  );
  expect(backupEntries).toHaveLength(1);
  const pendingReceiptPath = path.join(
    backupRoot,
    backupEntries[0],
    "receipt.pending.json",
  );
  const failedReceipt = JSON.parse(await readFile(pendingReceiptPath, "utf8"));
  expect(failedReceipt).toMatchObject({
    status: "rollback_failed",
    installError: "injected activation failure",
    rollbackError: "injected automatic detector restore failure",
  });
  await expect(
    readFile(path.join(fixture.directory, INSTALLED_ADAPTER_BASENAME)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(
      path.join(fixture.directory, INSTALLED_DETECTOR_BASENAME),
      "utf8",
    ),
  ).toContain("evaluateCoworldRoundIntegrity");
});

test("rejects malicious receipt target and backup path escapes", async () => {
  const fixture = await temporarySentinel();
  const installed = await installTemporarySentinel(fixture);
  const receiptBytes = await readFile(installed.receiptPath);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const targetEscapePath = path.join(fixture.directory, "escaped-target.mjs");
  const targetEscapeReceipt = structuredClone(receipt);
  targetEscapeReceipt.files.detector.targetPath = targetEscapePath;
  await writeFile(
    installed.receiptPath,
    `${JSON.stringify(targetEscapeReceipt)}\n`,
    { mode: 0o600 },
  );
  await expect(
    rollbackPwLeagueSentinelRoundIntegrity({
      receiptPath: installed.receiptPath,
    }),
  ).rejects.toThrow("targetPath is not the exact target");
  await expect(readFile(targetEscapePath)).rejects.toMatchObject({
    code: "ENOENT",
  });

  const backupEscapeReceipt = structuredClone(receipt);
  backupEscapeReceipt.files.sentinel.backupPath = path.join(
    fixture.directory,
    "outside.previous",
  );
  await writeFile(
    installed.receiptPath,
    `${JSON.stringify(backupEscapeReceipt)}\n`,
    { mode: 0o600 },
  );
  await expect(
    rollbackPwLeagueSentinelRoundIntegrity({
      receiptPath: installed.receiptPath,
    }),
  ).rejects.toThrow("backupPath is not the exact backup");

  await writeFile(installed.receiptPath, receiptBytes, { mode: 0o600 });
  await rollbackPwLeagueSentinelRoundIntegrity({
    receiptPath: installed.receiptPath,
  });
});

test("records rollback_failed, surfaces the composite error, and resumes safely", async () => {
  const fixture = await temporarySentinel();
  const installed = await installTemporarySentinel(fixture);
  await expect(
    rollbackPwLeagueSentinelRoundIntegrity(
      { receiptPath: installed.receiptPath },
      {
        beforeRestoreKey: async ({ key }: { key: string }) => {
          if (key === "adapter")
            throw new Error("injected adapter restore failure");
        },
      },
    ),
  ).rejects.toMatchObject({ name: "AggregateError" });
  const failedReceipt = JSON.parse(
    await readFile(installed.receiptPath, "utf8"),
  );
  expect(failedReceipt).toMatchObject({
    status: "rollback_failed",
    rollbackError: "injected adapter restore failure",
  });
  expect(await readFile(fixture.sentinelPath, "utf8")).toBe(fixture.source);
  expect(
    await readFile(
      path.join(fixture.directory, INSTALLED_ADAPTER_BASENAME),
      "utf8",
    ),
  ).toContain("collectConfirmedCoworldRoundIntegrity");

  await expect(
    rollbackPwLeagueSentinelRoundIntegrity({
      receiptPath: installed.receiptPath,
    }),
  ).resolves.toMatchObject({
    ok: true,
    restored: expect.arrayContaining([
      { key: "sentinel", status: "already_restored" },
    ]),
  });
});

test("receipt-bound verify rejects installed hash drift", async () => {
  const fixture = await temporarySentinel();
  const installed = await installTemporarySentinel(fixture);
  const detectorPath = path.join(
    fixture.directory,
    INSTALLED_DETECTOR_BASENAME,
  );
  const detectorBytes = await readFile(detectorPath);
  await writeFile(detectorPath, "drifted detector\n");
  await expect(
    verifyPwLeagueSentinelRoundIntegrity(
      {
        sentinelPath: fixture.sentinelPath,
        receiptPath: installed.receiptPath,
      },
      { readIdentity: cleanRepositoryIdentity },
    ),
  ).rejects.toThrow("verify detector hash does not match receipt");
  await writeFile(detectorPath, detectorBytes);
  await rollbackPwLeagueSentinelRoundIntegrity({
    receiptPath: installed.receiptPath,
  });
});
