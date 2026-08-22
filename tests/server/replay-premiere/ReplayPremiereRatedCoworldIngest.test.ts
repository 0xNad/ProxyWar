import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runReplayPremiereAdmission } from "../../../src/scripts/replay-premiere-admit";
import {
  executeReplayPremiereCoworldIngestCli,
  runReplayPremiereCoworldIngest,
} from "../../../src/scripts/replay-premiere-ingest-coworld";
import { ReplayPremiereAnonymousWriteLimiter } from "../../../src/server/replay-premiere/ReplayPremiereAnonymousWriteLimiter";
import { ReplayPremiereArchiveStore } from "../../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import {
  freezeReplayPremiereCheckpointProjection,
  type ReplayPremiereCheckpointProjector,
} from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import {
  backfillReplayPremiereTerminalTombstones,
  backfillReplayPremiereTerminalTombstonesDetailed,
} from "../../../src/server/replay-premiere/ReplayPremiereCoordination";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import { ReplayPremiereHttpRegistry } from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  canonicalReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { ReplayPremiereRuntimeRegistry } from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { startReplayPremiereProduction } from "../../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  AMPLE_DISK,
  NOW,
  RATED_COWORLD_ID,
  RATED_DIVISION_ID,
  RATED_EPISODE_ID,
  RATED_EPISODE_REQUEST_ID,
  RATED_LEAGUE_ID,
  RATED_PREMIERE_ID,
  RATED_ROUND_ID,
  RATED_RUN_ID,
  ratedCoworldDivisionRows,
  ratedCoworldEpisodeRows,
  ratedCoworldRawReplayValue,
  ratedEligibilityFixture,
} from "./ReplayPremiereFixtures";

const EXPECTED_ORIGIN = "https://beta.proxywar.xyz";
const ABSENT_LEGACY_PREMIERE_ID = "prem_0000000000000001";
const ABSENT_LEGACY_EPISODE_REQUEST_ID =
  "ereq_00000000-0000-4000-8000-000000000099";

describe("Replay Premiere rated Coworld ingestion", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(
      path.join(realTemporaryRoot, "premiere-rated-ingest-"),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("converts a fetched league replay into a rated bundle without outcome leakage", async () => {
    const inputs = await writeIngestInputs(root);
    const capture = cliCapture();
    const exitCode = await executeReplayPremiereCoworldIngestCli(
      inputs.args,
      { now: () => NOW },
      capture.io,
    );
    expect(exitCode).toBe(0);
    expect(capture.stderr()).toBe("");
    expect(capture.stdout()).not.toMatch(/winner|won|score|slot/i);
    const summary = JSON.parse(capture.stdout()) as Record<string, unknown>;
    expect(summary).toMatchObject({
      bundleKind: "proxywar_rated_coworld_source",
      sourceRunId: RATED_RUN_ID,
      episodeRequestId: RATED_EPISODE_REQUEST_ID,
      coworld: {
        episodeId: RATED_EPISODE_ID,
        leagueId: RATED_LEAGUE_ID,
        divisionId: RATED_DIVISION_ID,
        roundId: RATED_ROUND_ID,
      },
      coworldId: RATED_COWORLD_ID,
      gameId: "RATE0001",
      turnCount: 8,
      seatCount: 2,
      suggestedCheckpointSequences: [3, 5],
    });

    const bundle = JSON.parse(
      await fs.readFile(inputs.bundleFile, "utf8"),
    ) as Record<string, any>;
    expect(bundle.bundleKind).toBe("proxywar_rated_coworld_source");
    expect(bundle.gameRecord.info.winner).toEqual(["player", "RSEATA02"]);
    expect(bundle.seats).toEqual([
      {
        seatId: "RSEATA01",
        displayName: "AlphaCog",
        policyIdentity: {
          namespace: "softmax_policy_version",
          policyVersionId: "9f000000-0000-4000-8000-000000000001",
          policyName: "alpha-cog",
          serverAssignedVersion: "v3",
        },
      },
      {
        seatId: "RSEATA02",
        displayName: "BetaCog",
        policyIdentity: {
          namespace: "softmax_policy_version",
          policyVersionId: "9f000000-0000-4000-8000-000000000002",
          policyName: "beta-cog",
          serverAssignedVersion: "v7",
        },
      },
    ]);
    expect(bundle.provenance.generator).toBe(
      "replay-premiere-rated-coworld-ingest/v1",
    );
    expect(bundle.provenance.rawReplay.sha256).toBe(
      sha256Hex(await fs.readFile(inputs.rawFile)),
    );
    const result = JSON.parse(
      Buffer.from(String(bundle.authoritativeResult.bytes), "base64").toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      sourceKind: "coworld_result",
      sourceRunId: RATED_RUN_ID,
      sourceId: RATED_EPISODE_REQUEST_ID,
      gameId: "RATE0001",
      turnCount: 8,
      winner: ["player", "RSEATA02"],
    });
    const templates = await fs.readdir(inputs.admissionInputDir);
    expect(templates.sort()).toEqual([
      "definition.input.json",
      "eligibility.input.json",
    ]);
  });

  test("fails closed on participant, status, division, winner, PII, and stream drift", async () => {
    const cases: Array<{
      mutate: (material: IngestMaterial) => void;
      operatorCode: string;
    }> = [
      {
        mutate: (material) => {
          (material.rawReplay.results as any).players[0].name = "Imposter";
        },
        operatorCode: "coworld_ingest_participant_binding_mismatch",
      },
      {
        mutate: (material) => {
          material.episodeRows[0].status = "running";
        },
        operatorCode: "coworld_ingest_episode_not_completed",
      },
      {
        mutate: (material) => {
          (material.divisionRows[0].league as any).game.coworld_id =
            "cow_unrelated";
        },
        operatorCode: "coworld_ingest_division_binding_mismatch",
      },
      {
        mutate: (material) => {
          (material.rawReplay.results as any).winner_slot = 9;
        },
        operatorCode: "coworld_ingest_replay_winner_slot_invalid",
      },
      {
        mutate: (material) => {
          const record = JSON.parse(
            String(
              (material.rawReplay.inlineRunArtifacts as any)[
                "game-record.json"
              ],
            ),
          );
          record.info.players[0].persistentID =
            "3f1e9e6a-8f43-4a75-9d5e-0a49e0aa1c11";
          (material.rawReplay.inlineRunArtifacts as any)["game-record.json"] =
            JSON.stringify(record);
        },
        operatorCode: "coworld_ingest_replay_player_pii_present",
      },
      {
        mutate: (material) => {
          const record = JSON.parse(
            String(
              (material.rawReplay.inlineRunArtifacts as any)[
                "game-record.json"
              ],
            ),
          );
          record.turns[2].turnNumber = 99;
          (material.rawReplay.inlineRunArtifacts as any)["game-record.json"] =
            JSON.stringify(record);
        },
        operatorCode: "coworld_ingest_replay_turn_stream_invalid",
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const caseRoot = path.join(root, `case-${index}`);
      await fs.mkdir(caseRoot, { recursive: true });
      const material = defaultIngestMaterial();
      testCase.mutate(material);
      const inputs = await writeIngestInputs(caseRoot, material);
      await expectOperatorCode(
        runReplayPremiereCoworldIngest(inputs.args, { now: () => NOW }),
        testCase.operatorCode,
      );
    }
  });

  test("admits an ingested rated bundle end-to-end with Coworld identity in the catalog", async () => {
    const harness = await createRatedAdmissionHarness(root);
    const summary = await runReplayPremiereAdmission(
      harness.args,
      harness.dependencies,
    );
    expect(summary.premiereId).toBe(RATED_PREMIERE_ID);
    expect(summary.sourceRunId).toBe(RATED_RUN_ID);
    expect(harness.fetchCalls()).toBeGreaterThan(70);

    const record = JSON.parse(
      await fs.readFile(
        path.join(
          harness.privateStateRoot,
          "catalog-v1",
          "entries",
          `${RATED_PREMIERE_ID}.admission.json`,
        ),
        "utf8",
      ),
    ) as Record<string, any>;
    expect(record.eligibilityRecord.sourceKind).toBe("rated_coworld");
    expect(record.eligibilityRecord.coworld).toEqual({
      episodeId: RATED_EPISODE_ID,
      leagueId: RATED_LEAGUE_ID,
      divisionId: RATED_DIVISION_ID,
      roundId: RATED_ROUND_ID,
    });
    expect(record.eligibilityRecord.authoritativeResult.sourceKind).toBe(
      "coworld_result",
    );
    expect(record.eligibilityRecord.publicLabel).toBe(
      "spoiler_resistant_premiere",
    );
    expect(record.publicDefinition.provenance.sourceKind).toBe("rated_coworld");
    expect(record.publicDefinition.provenance.coworld.episodeId).toBe(
      RATED_EPISODE_ID,
    );
    const fingerprintSets =
      record.eligibilityRecord.proxyWarLeakAuditManifest.targets.map(
        (target: { expectation: { forbiddenText: string[] } }) =>
          target.expectation.forbiddenText,
      );
    for (const forbidden of fingerprintSets) {
      expect(forbidden).toContain(RATED_RUN_ID);
      expect(forbidden).toContain(RATED_EPISODE_ID);
      expect(forbidden).not.toContain("AlphaCog");
      expect(forbidden).not.toContain("BetaCog");
      expect(forbidden).not.toContain("RATE0001");
    }
  });

  test("league surfaces may show rated player names but never the episode identity", async () => {
    const namedRoot = path.join(root, "named");
    await fs.mkdir(namedRoot, { recursive: true });
    const named = await createRatedAdmissionHarness(namedRoot, {
      leaguePageBody: "league standings: AlphaCog vs BetaCog battle log",
    });
    const admitted = await runReplayPremiereAdmission(
      named.args,
      named.dependencies,
    );
    expect(admitted.premiereId).toBe(RATED_PREMIERE_ID);

    const leakedRoot = path.join(root, "leaked");
    await fs.mkdir(leakedRoot, { recursive: true });
    const leaked = await createRatedAdmissionHarness(leakedRoot, {
      leaguePageBody: `round results for ${RATED_RUN_ID}`,
    });
    await expectOperatorCode(
      runReplayPremiereAdmission(leaked.args, leaked.dependencies),
      "premiere_leak_collected_leak_audit_failed",
    );
  });

  test("rejects an operator claim that a rated outcome is externally private", async () => {
    const harness = await createRatedAdmissionHarness(root, {
      eligibilityOverrides: { externalOutcomeMayBePublic: false },
    });
    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, harness.dependencies),
      "admission_rated_outcome_must_be_public",
    );
    expect(harness.fetchCalls()).toBe(0);
  });

  test("admits a rated source whose outcome is genuinely NOT externally public, given confirmed embargo evidence", async () => {
    // Unlike a public league round (the only rated source this pipeline
    // supported until now), a privately-sourced rated episode (e.g. an
    // xp-request) has no public round listing its outcome — the strict
    // "premiere" label plus real embargo evidence is the honest claim, not
    // "spoiler_resistant_premiere" (which asserts the opposite: that the
    // outcome IS independently public elsewhere).
    const harness = await createRatedAdmissionHarness(root, {
      eligibilityOverrides: {
        externalOutcomeMayBePublic: false,
        publicLabel: "premiere",
        externalEmbargoEvidence: [
          {
            source: "private episode ingestion pipeline",
            scope: "source and outcome",
            observedAt: NOW.toISOString(),
            verifier: "operator",
            embargoConfirmed: true,
          },
        ],
      },
    });
    const admitted = await runReplayPremiereAdmission(
      harness.args,
      harness.dependencies,
    );
    expect(admitted.premiereId).toBe(RATED_PREMIERE_ID);
  });

  test("rejects the strict premiere label for a rated bundle", async () => {
    const harness = await createRatedAdmissionHarness(root, {
      eligibilityOverrides: { publicLabel: "premiere" },
    });
    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, harness.dependencies),
      "premiere_label_requires_external_embargo",
    );
  });

  test("rejects a bundle whose Coworld episode identity was tampered after ingest", async () => {
    const harness = await createRatedAdmissionHarness(root, {
      mutateBundle: (bundle) => {
        (bundle.coworld as Record<string, unknown>).episodeId =
          "tampered-episode-id";
      },
    });
    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, harness.dependencies),
      "rated_source_observatory_provenance_mismatch",
    );
  });

  test("registers a rated admission at the next server startup without hot activation", async () => {
    const harness = await createRatedAdmissionHarness(root);
    const limiter = new ReplayPremiereAnonymousWriteLimiter({
      now: () => NOW,
    });
    const httpRegistry = new ReplayPremiereHttpRegistry(limiter.admit);
    const runtimeRegistry = new ReplayPremiereRuntimeRegistry();
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    expect(httpRegistry.get(RATED_PREMIERE_ID)).toBeNull();
    const started = await startReplayPremiereProduction({
      statfs: AMPLE_DISK,
      privateStateRoot: harness.privateStateRoot,
      servedRoots: [harness.servedRoot],
      publicOrigin: EXPECTED_ORIGIN,
      security: new ReplayPremiereGuestSecurity({
        hmacKey: Buffer.alloc(32, 7),
        expectedOrigin: EXPECTED_ORIGIN,
        production: true,
        now: () => NOW,
      }),
      httpRegistry,
      runtimeRegistry,
      checkpointProjector: {
        async project() {
          throw new Error(
            "admission projection artifact must bypass startup projection",
          );
        },
      },
      clock: { now: () => new Date(NOW) },
    });
    try {
      expect(started.diagnostics).toEqual([]);
      expect(started.registeredPremiereIds).toEqual([RATED_PREMIERE_ID]);
      expect(httpRegistry.get(RATED_PREMIERE_ID)).not.toBeNull();
    } finally {
      await started.service.close();
    }
  });

  test("a terminal loop backfill neutralizes and reclaims a dormant rated admission", async () => {
    const harness = await createRatedAdmissionHarness(root);
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    const releasedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const tombstones = await backfillReplayPremiereTerminalTombstones({
      privateStateRoot: harness.privateStateRoot,
      records: terminalReleaseJournal("activated", releasedAt),
    });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      premiereId: RATED_PREMIERE_ID,
      episodeRequestId: RATED_EPISODE_REQUEST_ID,
      roundId: RATED_ROUND_ID,
      releasePhase: "activated",
      releaseOutcome: "activation_lost",
    });
    const retried = await backfillReplayPremiereTerminalTombstones({
      privateStateRoot: harness.privateStateRoot,
      records: terminalReleaseJournal(
        "activated",
        new Date(NOW.getTime() + 1_001).toISOString(),
      ),
    });
    expect(retried[0]?.releasedAt).toBe(releasedAt);
    await expectOperatorCode(
      backfillReplayPremiereTerminalTombstones({
        privateStateRoot: harness.privateStateRoot,
        records: terminalReleaseJournal(
          "activated",
          releasedAt,
          "activation_refused",
        ),
      }),
      "coordination_tombstone_is_immutable",
    );

    const limiter = new ReplayPremiereAnonymousWriteLimiter({
      now: () => new Date(NOW.getTime() + 2_000),
    });
    const httpRegistry = new ReplayPremiereHttpRegistry(limiter.admit);
    const runtimeRegistry = new ReplayPremiereRuntimeRegistry();
    const archiveStore = await ReplayPremiereArchiveStore.open({
      privateStateRoot: harness.privateStateRoot,
    });
    const started = await startReplayPremiereProduction({
      statfs: AMPLE_DISK,
      privateStateRoot: harness.privateStateRoot,
      servedRoots: [harness.servedRoot],
      publicOrigin: EXPECTED_ORIGIN,
      security: new ReplayPremiereGuestSecurity({
        hmacKey: Buffer.alloc(32, 7),
        expectedOrigin: EXPECTED_ORIGIN,
        production: true,
        now: () => new Date(NOW.getTime() + 2_000),
      }),
      httpRegistry,
      runtimeRegistry,
      archiveStore,
      reclamationGraceMs: 0,
      reclamationSweepMs: 0,
      checkpointProjector: ratedFixtureCheckpointProjector(),
      clock: { now: () => new Date(NOW.getTime() + 2_000) },
    });
    try {
      expect(started.registeredPremiereIds).toEqual([]);
      expect(httpRegistry.get(RATED_PREMIERE_ID)).toBeNull();
      expect(runtimeRegistry.get(RATED_PREMIERE_ID)).toBeNull();
      await viWaitForArchive(archiveStore, RATED_PREMIERE_ID);
      expect(archiveStore.lookup(RATED_PREMIERE_ID)).toMatchObject({
        premiereId: RATED_PREMIERE_ID,
        terminalState: "cancelled",
      });
      expect(
        (await archiveStore.loadSummary(RATED_PREMIERE_ID))?.terminalState,
      ).toBe("cancelled");
      await expect(
        fs.stat(ratedAdmissionPath(harness.privateStateRoot)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(ratedTombstonePath(harness.privateStateRoot)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await started.service.close();
    }
  });

  test("historical backfill skips an absent legacy admission and still retires a later present admission", async () => {
    const harness = await createRatedAdmissionHarness(root);
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    const releasedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const absentRelease = [
      {
        kind: "hold_update",
        ts: NOW.toISOString(),
        hold: {
          episodeRequestId: ABSENT_LEGACY_EPISODE_REQUEST_ID,
          premiereId: ABSENT_LEGACY_PREMIERE_ID,
          roundId: "round_absent_legacy",
          phase: "activated",
        },
      },
      {
        kind: "hold_released",
        ts: releasedAt,
        episodeRequestId: ABSENT_LEGACY_EPISODE_REQUEST_ID,
        premiereId: ABSENT_LEGACY_PREMIERE_ID,
        roundId: "round_absent_legacy",
        outcome: "activation_refused",
        terminal: true,
      },
    ] as const;

    const result = await backfillReplayPremiereTerminalTombstonesDetailed({
      privateStateRoot: harness.privateStateRoot,
      records: [
        ...absentRelease,
        ...terminalReleaseJournal("activated", releasedAt),
      ],
    });

    expect(result.catalogAbsentArchivedPremiereIds).toEqual([]);
    expect(result.catalogAbsentUnarchivedPremiereIds).toEqual([
      ABSENT_LEGACY_PREMIERE_ID,
    ]);
    expect(result.tombstones.map(({ premiereId }) => premiereId)).toEqual([
      RATED_PREMIERE_ID,
    ]);
    await expect(
      fs.stat(ratedTombstonePath(harness.privateStateRoot)),
    ).resolves.toBeDefined();
  });

  test("historical backfill validates the complete history before creating a tombstone", async () => {
    const harness = await createRatedAdmissionHarness(root);
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    const releasedAt = new Date(NOW.getTime() + 1_000).toISOString();

    await expectOperatorCode(
      backfillReplayPremiereTerminalTombstonesDetailed({
        privateStateRoot: harness.privateStateRoot,
        records: [
          ...terminalReleaseJournal("activated", releasedAt),
          {
            kind: "hold_released",
            ts: releasedAt,
            episodeRequestId: ABSENT_LEGACY_EPISODE_REQUEST_ID,
            premiereId: ABSENT_LEGACY_PREMIERE_ID,
            roundId: "round_absent_legacy",
            outcome: "activation_refused",
            terminal: true,
            ambiguous: true,
          },
        ],
      }),
      "coordination_object_keys_invalid",
    );
    await expect(
      fs.stat(ratedTombstonePath(harness.privateStateRoot)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a tombstone never cancels an already-playing rated premiere on restart", async () => {
    const harness = await createRatedAdmissionHarness(root);
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    const firstLimiter = new ReplayPremiereAnonymousWriteLimiter({
      now: () => NOW,
    });
    const firstHttp = new ReplayPremiereHttpRegistry(firstLimiter.admit);
    const firstRuntime = new ReplayPremiereRuntimeRegistry();
    const first = await startReplayPremiereProduction({
      statfs: AMPLE_DISK,
      privateStateRoot: harness.privateStateRoot,
      servedRoots: [harness.servedRoot],
      publicOrigin: EXPECTED_ORIGIN,
      security: new ReplayPremiereGuestSecurity({
        hmacKey: Buffer.alloc(32, 7),
        expectedOrigin: EXPECTED_ORIGIN,
        production: true,
        now: () => NOW,
      }),
      httpRegistry: firstHttp,
      runtimeRegistry: firstRuntime,
      checkpointProjector: ratedFixtureCheckpointProjector(),
      clock: { now: () => new Date(NOW) },
    });
    expect(firstRuntime.get(RATED_PREMIERE_ID)?.readLifecycleState()).toBe(
      "playing",
    );
    await first.service.close();

    await backfillReplayPremiereTerminalTombstones({
      privateStateRoot: harness.privateStateRoot,
      records: terminalReleaseJournal(
        "activated",
        new Date(NOW.getTime() + 1_000).toISOString(),
      ),
    });
    const secondLimiter = new ReplayPremiereAnonymousWriteLimiter({
      now: () => NOW,
    });
    const secondHttp = new ReplayPremiereHttpRegistry(secondLimiter.admit);
    const secondRuntime = new ReplayPremiereRuntimeRegistry();
    const archiveStore = await ReplayPremiereArchiveStore.open({
      privateStateRoot: harness.privateStateRoot,
    });
    const second = await startReplayPremiereProduction({
      statfs: AMPLE_DISK,
      privateStateRoot: harness.privateStateRoot,
      servedRoots: [harness.servedRoot],
      publicOrigin: EXPECTED_ORIGIN,
      security: new ReplayPremiereGuestSecurity({
        hmacKey: Buffer.alloc(32, 7),
        expectedOrigin: EXPECTED_ORIGIN,
        production: true,
        now: () => NOW,
      }),
      httpRegistry: secondHttp,
      runtimeRegistry: secondRuntime,
      archiveStore,
      reclamationGraceMs: 0,
      reclamationSweepMs: 0,
      checkpointProjector: ratedFixtureCheckpointProjector(),
      clock: { now: () => new Date(NOW) },
    });
    try {
      expect(second.registeredPremiereIds).toEqual([RATED_PREMIERE_ID]);
      expect(secondRuntime.get(RATED_PREMIERE_ID)?.readLifecycleState()).toBe(
        "playing",
      );
      expect(secondHttp.get(RATED_PREMIERE_ID)).not.toBeNull();
      expect(archiveStore.lookup(RATED_PREMIERE_ID)).toBeNull();
      await expect(
        fs.stat(ratedAdmissionPath(harness.privateStateRoot)),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(ratedTombstonePath(harness.privateStateRoot)),
      ).resolves.toBeDefined();
    } finally {
      await second.service.close();
    }
  });
});

function terminalReleaseJournal(
  phase: "admitted" | "activated" | "live",
  releasedAt: string,
  outcome: "activation_lost" | "activation_refused" = "activation_lost",
): readonly unknown[] {
  return [
    {
      kind: "hold_update",
      ts: NOW.toISOString(),
      hold: {
        episodeRequestId: RATED_EPISODE_REQUEST_ID,
        premiereId: RATED_PREMIERE_ID,
        roundId: RATED_ROUND_ID,
        phase,
      },
    },
    {
      kind: "hold_released",
      ts: releasedAt,
      episodeRequestId: RATED_EPISODE_REQUEST_ID,
      premiereId: RATED_PREMIERE_ID,
      roundId: RATED_ROUND_ID,
      outcome,
      terminal: true,
    },
  ];
}

function ratedAdmissionPath(privateStateRoot: string): string {
  return path.join(
    privateStateRoot,
    "catalog-v1",
    "entries",
    `${RATED_PREMIERE_ID}.admission.json`,
  );
}

function ratedTombstonePath(privateStateRoot: string): string {
  return path.join(
    privateStateRoot,
    "coordination-v1",
    "terminal-tombstones",
    `${RATED_PREMIERE_ID}.terminal.json`,
  );
}

async function viWaitForArchive(
  archiveStore: ReplayPremiereArchiveStore,
  premiereId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (archiveStore.lookup(premiereId) !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`archive pointer did not appear for ${premiereId}`);
}

interface IngestMaterial {
  rawReplay: Record<string, unknown>;
  episodeRows: Array<Record<string, unknown>>;
  divisionRows: Array<Record<string, unknown>>;
}

function defaultIngestMaterial(): IngestMaterial {
  return {
    rawReplay: ratedCoworldRawReplayValue(),
    episodeRows: ratedCoworldEpisodeRows(),
    divisionRows: ratedCoworldDivisionRows(),
  };
}

async function writeIngestInputs(
  testRoot: string,
  material: IngestMaterial = defaultIngestMaterial(),
): Promise<{
  args: string[];
  rawFile: string;
  bundleFile: string;
  admissionInputDir: string;
}> {
  const rawFile = path.join(testRoot, "raw-episode.replay");
  const episodeFile = path.join(testRoot, "episode-rows.json");
  const divisionFile = path.join(testRoot, "division-rows.json");
  const bundleFile = path.join(testRoot, "rated-fixture.source.json");
  const admissionInputDir = path.join(testRoot, "admission-inputs");
  await Promise.all([
    fs.writeFile(rawFile, JSON.stringify(material.rawReplay), { mode: 0o600 }),
    fs.writeFile(episodeFile, JSON.stringify(material.episodeRows), {
      mode: 0o600,
    }),
    fs.writeFile(divisionFile, JSON.stringify(material.divisionRows), {
      mode: 0o600,
    }),
  ]);
  return {
    args: [
      `--replay-file=${rawFile}`,
      `--episode-file=${episodeFile}`,
      `--episode-request-id=${RATED_EPISODE_REQUEST_ID}`,
      `--division-file=${divisionFile}`,
      `--division-id=${RATED_DIVISION_ID}`,
      `--out-file=${bundleFile}`,
      `--admission-input-dir=${admissionInputDir}`,
    ],
    rawFile,
    bundleFile,
    admissionInputDir,
  };
}

async function createRatedAdmissionHarness(
  testRoot: string,
  options: {
    eligibilityOverrides?: Record<string, unknown>;
    mutateBundle?: (bundle: Record<string, unknown>) => void;
    leaguePageBody?: string;
  } = {},
) {
  const inputs = await writeIngestInputs(testRoot);
  await runReplayPremiereCoworldIngest(inputs.args, { now: () => NOW });
  let sourceFile = inputs.bundleFile;
  let sourceBytes = await fs.readFile(inputs.bundleFile);
  if (options.mutateBundle !== undefined) {
    const bundle = JSON.parse(sourceBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    options.mutateBundle(bundle);
    sourceBytes = Buffer.from(
      canonicalReplayPremiereJson(bundle as unknown as ReplayPremiereJsonValue),
      "utf8",
    );
    sourceFile = path.join(testRoot, "rated-tampered.source.json");
    await fs.writeFile(sourceFile, sourceBytes, { mode: 0o600 });
  }
  const eligibility = ratedEligibilityFixture({ sourceBytes });
  if (options.leaguePageBody !== undefined) {
    for (const evidence of eligibility.proxyWarLeakChecks) {
      if (evidence.checkId === "league-page") {
        evidence.observedBodyText = options.leaguePageBody;
        evidence.observedContentHash = sha256Hex(options.leaguePageBody);
      }
    }
  }
  const privateStateRoot = path.join(testRoot, "private");
  const servedRoot = path.join(testRoot, "served");
  const eligibilityFile = path.join(testRoot, "eligibility-final.json");
  const definitionFile = path.join(testRoot, "definition-final.json");
  const nonceFile = path.join(testRoot, "commitment-nonce.bin");
  await fs.mkdir(servedRoot, { recursive: true });
  const eligibilityTemplate = JSON.parse(
    await fs.readFile(
      path.join(inputs.admissionInputDir, "eligibility.input.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const definitionTemplate = JSON.parse(
    await fs.readFile(
      path.join(inputs.admissionInputDir, "definition.input.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  await Promise.all([
    fs.writeFile(
      eligibilityFile,
      `${JSON.stringify({
        ...eligibilityTemplate,
        ...(options.eligibilityOverrides ?? {}),
      })}\n`,
      { mode: 0o600 },
    ),
    fs.writeFile(definitionFile, `${JSON.stringify(definitionTemplate)}\n`, {
      mode: 0o600,
    }),
    fs.writeFile(nonceFile, Buffer.alloc(32, 9), { mode: 0o600 }),
  ]);
  const expectedEvidence = new Map(
    eligibility.proxyWarLeakChecks.map((evidence) => [
      `${evidence.method} ${evidence.target}`,
      evidence,
    ]),
  );
  let fetchCalls = 0;
  const fixtureFetch = (async (input, init) => {
    fetchCalls += 1;
    const target = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const evidence = expectedEvidence.get(`${method} ${target}`);
    if (evidence === undefined || evidence.observedHttpStatus === null) {
      throw new Error("unexpected rated admission leak probe");
    }
    return new Response(evidence.observedBodyText ?? "", {
      status: evidence.observedHttpStatus,
      headers: {
        ...(evidence.observedHeaders.cacheControl === null
          ? {}
          : { "cache-control": evidence.observedHeaders.cacheControl }),
      },
    });
  }) as typeof globalThis.fetch;
  return {
    args: [
      `--premiere-id=${RATED_PREMIERE_ID}`,
      `--source-file=${sourceFile}`,
      `--expected-source-sha256=${sha256Hex(sourceBytes)}`,
      `--private-state-root=${privateStateRoot}`,
      `--served-root=${servedRoot}`,
      `--eligibility-file=${eligibilityFile}`,
      `--definition-file=${definitionFile}`,
      `--deployment-origin=${EXPECTED_ORIGIN}`,
      `--nonce-file=${nonceFile}`,
    ],
    dependencies: {
      fetch: fixtureFetch,
      now: () => new Date(NOW),
      environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
      checkpointProjector: ratedFixtureCheckpointProjector(),
    },
    fetchCalls: () => fetchCalls,
    privateStateRoot,
    servedRoot,
  };
}

/**
 * This eight-turn ingestion fixture exercises Coworld identity and admission,
 * not deterministic survival at production checkpoint depth. Give admission
 * an exact, gate-bound projection so the new pre-publication artifact contract
 * is covered without pretending the tiny fixture is a representative match.
 */
function ratedFixtureCheckpointProjector(): ReplayPremiereCheckpointProjector {
  return {
    async project({ gate }) {
      const definition = gate.publicDefinition();
      const optionSeatIds = definition.provenance.seats.map(
        (seat) => seat.seatId,
      );
      return freezeReplayPremiereCheckpointProjection({
        premiereId: gate.premiereId,
        publicationCommitmentHash: gate.publicationCommitmentHash,
        checkpoints: [
          { ...definition.checkpoints[0], optionSeatIds },
          { ...definition.checkpoints[1], optionSeatIds },
        ],
      });
    },
  };
}

function cliCapture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout(line: string) {
        stdout += line;
      },
      stderr(line: string) {
        stderr += line;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function expectOperatorCode(
  operation: Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await operation;
    throw new Error("expected rated Coworld premiere failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayPremiereError);
    expect((error as ReplayPremiereError).operatorCode).toBe(expected);
  }
}
