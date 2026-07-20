import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../../src/core/game/Game";
import { buildPremiereChunks } from "../../../src/server/replay-premiere/ReplayPremiereChunks";
import type {
  PremiereEligibility,
  PremiereLeakCheckEvidence,
  PremiereSeatIdentity,
} from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  assessPremiereEligibility,
  buildRequiredProxyWarLeakAuditManifest,
  type PremiereEligibilityAssessmentOptions,
} from "../../../src/server/replay-premiere/ReplayPremiereEligibility";
import { importPremiereReplay } from "../../../src/server/replay-premiere/ReplayPremiereImport";
import {
  canonicalReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { collectReplayPremiereLeakAudit } from "../../../src/server/replay-premiere/ReplayPremiereLeakAuditCollector";
import {
  readVerifiedStagedPremiereSource,
  stagePremiereSource,
} from "../../../src/server/replay-premiere/ReplayPremierePrivateStaging";
import {
  VerifiedPremiereEligibilityGate,
  type PremierePublicDefinition,
} from "../../../src/server/replay-premiere/ReplayPremierePublication";

export const PREMIERE_ID = "prem_0123456789abcdef";
export const NOW = new Date("2026-07-20T18:00:00.000Z");

export const IMPORT_LIMITS = {
  maxBootstrapBytes: 100_000,
  maxTurnBytes: 100_000,
  maxTurnRecords: 100,
  maxTotalTurnBytes: 1_000_000,
};

export function gameStartInfo(): Record<string, unknown> {
  return {
    gameID: "PREM0001",
    lobbyCreatedAt: 10,
    config: {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Medium,
      nations: "disabled",
      donateGold: false,
      donateTroops: false,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    },
    players: [
      { clientID: "SEAT0001", username: "Alpha", clanTag: null },
      { clientID: "SEAT0002", username: "Beta", clanTag: null },
    ],
  };
}

export function seatFixtures(): PremiereSeatIdentity[] {
  return [
    {
      seatId: "SEAT0001",
      displayName: "Alpha",
      policyIdentity: {
        namespace: "local_manifest",
        manifestName: "alpha-policy",
        declaredVersion: "1.0.0",
        manifestSha256: sha256Hex("alpha manifest"),
        contentSha256: sha256Hex("alpha content"),
      },
    },
    {
      seatId: "SEAT0002",
      displayName: "Beta",
      policyIdentity: {
        namespace: "local_manifest",
        manifestName: "beta-policy",
        declaredVersion: "1.0.0",
        manifestSha256: sha256Hex("beta manifest"),
        contentSha256: sha256Hex("beta content"),
      },
    },
  ];
}

export function authoritativeResultValue(
  overrides: Partial<Record<string, ReplayPremiereJsonValue>> = {},
): ReplayPremiereJsonValue {
  return {
    schemaVersion: 1,
    sourceKind: "controlled_result",
    sourceRunId: "controlled-run-001",
    sourceId: "controlled-run-001:result",
    gameId: "PREM0001",
    completedAt: "2026-07-20T18:00:00.600Z",
    turnCount: 6,
    winner: ["player", "SEAT0001"],
    seats: [
      { seatId: "SEAT0001", displayName: "Alpha", won: true },
      { seatId: "SEAT0002", displayName: "Beta", won: false },
    ],
    ...overrides,
  };
}

export function authoritativeResultBytes(): Buffer {
  return Buffer.from(
    canonicalReplayPremiereJson(authoritativeResultValue()),
    "utf8",
  );
}

export function controlledSourceBytes(): Buffer {
  const resultBytes = authoritativeResultBytes();
  const start = gameStartInfo();
  const executionConfig: ReplayPremiereJsonValue = {
    schemaVersion: 1,
    scenario: "league",
    brainMode: "rule",
    runnerMode: "step-locked",
    planEveryDecisionSteps: 3,
    runner: {
      turnsPerDecisionStep: 300,
      turnsPerDecisionSchedule: null,
      maxDecisionMs: 120_000,
      maxSteps: 120,
      maxSpawnAdvanceTurns: 2_000,
      requireWinner: true,
      waitForMirrorCatchup: true,
      autopilotEndgameSteps: 0,
      replayTailTurns: 0,
    },
    game: {
      bots: 0,
      nations: "disabled",
      map: String(GameMapType.Asia),
      mapSize: String(GameMapSize.Normal),
      difficulty: String(Difficulty.Medium),
      varySpawns: false,
    },
    disabledActionKinds: [],
  };
  const players = (start.players as Array<Record<string, unknown>>).map(
    (player) => ({ ...player, persistentID: null }),
  );
  const bundle: ReplayPremiereJsonValue = {
    schemaVersion: 1,
    bundleKind: "proxywar_controlled_exhibition_source",
    sourceRunId: "controlled-run-001",
    createdAt: "2026-07-20T18:00:00.600Z",
    gameRecord: {
      version: "v0.0.2",
      gitCommit: "a".repeat(40),
      subdomain: "local",
      domain: "controlled",
      info: {
        ...start,
        players,
        start: Date.parse("2026-07-20T18:00:00.000Z"),
        end: Date.parse("2026-07-20T18:00:00.600Z"),
        duration: 600,
        num_turns: 6,
        winner: ["player", "SEAT0001"],
        lobbyFillTime: 0,
      },
      turns: [
        { turnNumber: 0, intents: [] },
        { turnNumber: 2, intents: [] },
        { turnNumber: 5, intents: [] },
      ],
    },
    replay: { turnCount: 6, turnIntervalMs: 100 },
    authoritativeResult: {
      sourceId: "controlled-run-001:result",
      encoding: "base64",
      bytes: resultBytes.toString("base64"),
      sha256: sha256Hex(resultBytes),
    },
    seats: seatFixtures() as unknown as ReplayPremiereJsonValue,
    provenance: {
      generator: "replay-premiere-controlled-exhibition/v1",
      brainMode: "rule",
      runnerMode: "step-locked",
      executionConfig,
      executionConfigSha256: sha256Hex(
        canonicalReplayPremiereJson(executionConfig),
      ),
      game: {
        gameId: "PREM0001",
        startedAt: "2026-07-20T18:00:00.000Z",
        completedAt: "2026-07-20T18:00:00.600Z",
        turnCount: 6,
        map: String(GameMapType.Asia),
        mapSize: String(GameMapSize.Normal),
        mode: String(GameMode.FFA),
        gameType: String(GameType.Singleplayer),
      },
      build: {
        repositoryHead: "a".repeat(40),
        repositoryTree: "b".repeat(40),
        trackedWorktreeClean: true,
        trackedWorktreeStateSha256: "c".repeat(64),
        packageName: "proxywar",
        packageVersion: null,
        packageJsonSha256: "d".repeat(64),
        smokeRunnerSha256: "e".repeat(64),
        generatorSha256: "f".repeat(64),
        nodeVersion: "v24.0.0",
        platform: "darwin",
        architecture: "arm64",
      },
    },
  };
  return Buffer.from(canonicalReplayPremiereJson(bundle), "utf8");
}

export function eligibilityFixture(
  material: {
    sourceBytes?: Uint8Array;
    resultBytes?: Uint8Array;
    origin?: string;
  } = {},
): PremiereEligibility {
  const sourceRunId = "controlled-run-001";
  const resultHash = sha256Hex(
    material.resultBytes ?? authoritativeResultBytes(),
  );
  const sourceReplaySha256 = sha256Hex(
    material.sourceBytes ?? controlledSourceBytes(),
  );
  const seats = seatFixtures();
  const manifest = buildRequiredProxyWarLeakAuditManifest({
    origin: material.origin ?? "https://beta.proxywar.xyz",
    sourceRunId,
    createdAt: NOW.toISOString(),
    fingerprintBinding: {
      sourceReplaySha256,
      authoritativeResultSha256: resultHash,
      authoritativeResultSourceId: "controlled-run-001:result",
      gameIds: ["PREM0001"],
      seatIds: seats.map((seat) => seat.seatId),
      seatDisplayNames: seats.map((seat) => seat.displayName),
    },
  });
  const proxyWarLeakChecks: PremiereLeakCheckEvidence[] = manifest.targets.map(
    (target) => {
      let observedHttpStatus: number;
      let observedBodyText: string;
      if (target.expectation.kind === "body_absent") {
        observedHttpStatus = target.expectation.requiredHttpStatus;
        observedBodyText = "current public page without the private source";
      } else if (target.expectation.kind === "structured_absent") {
        observedHttpStatus = target.expectation.requiredHttpStatus;
        observedBodyText = '{"matches":[]}';
      } else {
        observedHttpStatus = target.expectation.allowedHttpStatuses[0];
        observedBodyText = "not found";
      }
      return {
        checkId: target.checkId,
        target: target.target,
        method: target.method,
        observedHttpStatus,
        observedContentHash: sha256Hex(observedBodyText),
        observedBodyText,
        observedHeaders: {
          age: null,
          cacheControl: "no-store",
          cdnCacheStatus: null,
        },
        checkedAt: NOW.toISOString(),
        checkerVersion: "phase0-audit/v1",
      };
    },
  );
  return {
    schemaVersion: 1,
    eligibilityCheckVersion: "phase0/v1",
    createdAt: NOW.toISOString(),
    sourceKind: "controlled_exhibition",
    sourceRunId,
    coworld: null,
    sourceReplaySha256,
    sourceBundleOutsideServedRoots: true,
    proxyWarLeakAuditManifest: manifest,
    proxyWarLeakChecks,
    externalEmbargoEvidence: [
      {
        source: "controlled runner",
        scope: "source and outcome",
        observedAt: NOW.toISOString(),
        verifier: "operator",
        embargoConfirmed: true,
      },
    ],
    externalOutcomeMayBePublic: false,
    seats,
    authoritativeResult: {
      sourceKind: "controlled_result",
      sourceId: "controlled-run-001:result",
      resultHash,
    },
    publicLabel: "premiere",
  };
}

export function eligibilityOptions(
  privateCommitmentNonce = Buffer.alloc(32, 7),
): PremiereEligibilityAssessmentOptions {
  return {
    now: NOW,
    maxLeakCheckAgeMs: 60_000,
    maxExternalEvidenceAgeMs: 60_000,
    maxObservedBodyBytes: 1_000_000,
    privateCommitmentNonce,
  };
}

export function publicDefinitionFixture(
  eligibilityRecordHash: string,
  eligibility = eligibilityFixture(),
): PremierePublicDefinition {
  return {
    title: "Alpha vs Beta",
    spoilerNeutralDescription: "A controlled ProxyWar exhibition.",
    map: { id: String(GameMapType.Asia), label: "Asia" },
    matchFormat: { id: "ffa-2", label: "Two-seat FFA", seatCount: 2 },
    scheduledAt: NOW.toISOString(),
    playbackRate: 2,
    checkpoints: [
      { id: "cp_00000001", sequence: 2 },
      { id: "cp_00000002", sequence: 4 },
    ],
    provenance: {
      sourceKind: eligibility.sourceKind,
      sourceRunId: eligibility.sourceRunId,
      coworld: eligibility.coworld,
      sourceReplaySha256: eligibility.sourceReplaySha256,
      seats: eligibility.seats,
      publicLabel: eligibility.publicLabel,
      eligibilityRecordHash,
    },
  };
}

export async function verifiedPublicationFixture(
  root: string,
  options: { origin?: string } = {},
): Promise<{
  gate: VerifiedPremiereEligibilityGate;
  drafts: ReturnType<typeof buildPremiereChunks>;
  verificationOptions: Parameters<
    typeof VerifiedPremiereEligibilityGate.verify
  >[0];
}> {
  const privateRoot = path.join(root, "private");
  const servedRoot = path.join(root, "served");
  const sourcePath = path.join(root, "controlled.source.json");
  await fs.mkdir(servedRoot, { recursive: true });
  await fs.writeFile(sourcePath, controlledSourceBytes(), { mode: 0o600 });
  let eligibility = eligibilityFixture({ origin: options.origin });
  const eligibilityAssessmentOptions = eligibilityOptions(Buffer.alloc(32, 9));
  const collectedLeakAudit = await collectFixtureLeakAudit(
    eligibility,
    eligibilityAssessmentOptions,
    options.origin,
  );
  eligibility = collectedLeakAudit.eligibility;
  const leakAuditReceipt = collectedLeakAudit.receipt;
  const staged = await stagePremiereSource({
    sourceFilePath: sourcePath,
    privateStateRoot: privateRoot,
    servedRoots: [servedRoot],
    maxSourceBytes: 2_000_000,
    expectedSourceReplaySha256: eligibility.sourceReplaySha256,
  });
  const verifiedSource = await readVerifiedStagedPremiereSource({
    stagedSource: staged,
    privateStateRoot: privateRoot,
    servedRoots: [servedRoot],
    maxSourceBytes: 2_000_000,
  });
  const imported = importPremiereReplay(
    {
      gameStartInfo: gameStartInfo(),
      turnCount: 6,
      turnIntervalMs: 100,
      turns: [
        { turn: { turnNumber: 0, intents: [] } },
        { turn: { turnNumber: 2, intents: [] } },
        { turn: { turnNumber: 5, intents: [] } },
      ],
    },
    IMPORT_LIMITS,
  );
  const drafts = buildPremiereChunks({
    premiereId: PREMIERE_ID,
    records: imported.records,
    playbackRate: 2,
    checkpointSequences: [2, 4],
    maxChunkBytes: 100_000,
    maxTotalBytes: 1_000_000,
    maxRecordsPerChunk: 20,
    maxPresentationSpanMs: 1_000,
  });
  const eligibilityRecordHash =
    // Same full assessment is rerun inside gate minting.
    assessPremiereEligibility(
      eligibility,
      eligibilityAssessmentOptions,
    ).eligibilityRecordHash;
  const verificationOptions = {
    premiereId: PREMIERE_ID,
    eligibilityRecord: eligibility,
    eligibilityOptions: eligibilityAssessmentOptions,
    leakAuditReceipt,
    verifiedSource,
    authoritativeResultBytes: authoritativeResultBytes(),
    replayImportLimits: IMPORT_LIMITS,
    publicDefinition: publicDefinitionFixture(
      eligibilityRecordHash,
      eligibility,
    ),
    draftChunks: drafts,
    maxPresentationSpanMs: 1_000,
  } satisfies Parameters<typeof VerifiedPremiereEligibilityGate.verify>[0];
  const gate = VerifiedPremiereEligibilityGate.verify(verificationOptions);
  return { gate, drafts, verificationOptions };
}

export async function collectFixtureLeakAudit(
  eligibility: PremiereEligibility,
  assessmentOptions: PremiereEligibilityAssessmentOptions,
  expectedOrigin = "https://beta.proxywar.xyz",
) {
  const receipt = await collectReplayPremiereLeakAudit({
    manifest: eligibility.proxyWarLeakAuditManifest,
    expectedOrigin,
    assessmentOptions,
    limits: {
      maxTargets: 256,
      maxTargetUrlBytes: 4_096,
      maxBodyBytesPerTarget: 1_000_000,
      maxTotalBodyBytes: 8_000_000,
      maxHeaderBytesPerTarget: 16_384,
      maxHeaderCountPerTarget: 64,
      requestTimeoutMs: 1_000,
      totalTimeoutMs: 10_000,
    },
    fetch: fixtureLeakAuditFetch(eligibility),
    now: () => NOW,
  });
  return {
    eligibility: {
      ...eligibility,
      proxyWarLeakChecks: receipt.evidence(),
    },
    receipt,
  };
}

function fixtureLeakAuditFetch(
  eligibility: PremiereEligibility,
): typeof globalThis.fetch {
  const byTarget = new Map(
    eligibility.proxyWarLeakChecks.map((evidence) => [
      `${evidence.method} ${evidence.target}`,
      evidence,
    ]),
  );
  return (async (input, init) => {
    const target = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const evidence = byTarget.get(`${method} ${target}`);
    if (evidence === undefined || evidence.observedHttpStatus === null) {
      throw new Error("unexpected fixture leak-audit target");
    }
    return new Response(evidence.observedBodyText ?? "", {
      status: evidence.observedHttpStatus,
      headers: {
        ...(evidence.observedHeaders.age === null
          ? {}
          : { age: evidence.observedHeaders.age }),
        ...(evidence.observedHeaders.cacheControl === null
          ? {}
          : { "cache-control": evidence.observedHeaders.cacheControl }),
        ...(evidence.observedHeaders.cdnCacheStatus === null
          ? {}
          : {
              "cf-cache-status": evidence.observedHeaders.cdnCacheStatus,
            }),
      },
    });
  }) as typeof globalThis.fetch;
}
