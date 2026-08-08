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
import {
  PREMIERE_REAL_TURN_INTERVAL_MS,
  REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS,
  type PremiereEligibility,
  type PremiereLeakCheckEvidence,
  type PremiereSeatIdentity,
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

export const LONG_REPLAY_TURN_COUNT = 15_000;
export const LONG_REPLAY_TURN_INTERVAL_MS = 1;
export const LONG_REPLAY_CHECKPOINT_SEQUENCES = [5_000, 10_000] as const;
export const LONG_REPLAY_IMPORT_LIMITS = {
  maxBootstrapBytes: 100_000,
  maxTurnBytes: 100_000,
  maxTurnRecords: LONG_REPLAY_TURN_COUNT,
  maxTotalTurnBytes: 1_000_000,
} as const;
export const LONG_REPLAY_CHUNK_LIMITS = {
  maxChunkBytes: 100_000,
  maxTotalBytes: 2_000_000,
  // 5,001 / 5,000 / 4,999 record checkpoint segments each produce 40
  // chunks, matching the production 120-chunk recovery envelope.
  maxRecordsPerChunk: 126,
  maxPresentationSpanMs: 200,
} as const;

/**
 * A 50-minute premiere at REAL production cadence
 * (`PREMIERE_REAL_TURN_INTERVAL_MS`, playbackRate 1) — proves a long-running
 * premiere admits and plays using the coarse, unmodified
 * `REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS` chunk-release ceiling (~50
 * chunks, well under the 128-chunk cap).
 */
export const REALTIME_LONG_TURN_COUNT = 30_000;
export const REALTIME_LONG_TURN_INTERVAL_MS = PREMIERE_REAL_TURN_INTERVAL_MS;
export const REALTIME_LONG_CHECKPOINT_SEQUENCES = [10_000, 20_000] as const;
export const REALTIME_LONG_IMPORT_LIMITS = {
  maxBootstrapBytes: 100_000,
  maxTurnBytes: 100_000,
  maxTurnRecords: REALTIME_LONG_TURN_COUNT,
  maxTotalTurnBytes: 2_000_000,
} as const;
export const REALTIME_LONG_CHUNK_LIMITS = {
  maxChunkBytes: 100_000,
  maxTotalBytes: 4_000_000,
  maxRecordsPerChunk: 1_000,
  maxPresentationSpanMs: REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS,
} as const;

interface MutableControlledSourceFixture {
  createdAt: string;
  gameRecord: {
    info: {
      start: number;
      end: number;
      duration: number;
      num_turns: number;
    };
    turns: Array<{ turnNumber: number; intents: [] }>;
  };
  replay: { turnCount: number; turnIntervalMs: number };
  authoritativeResult: {
    bytes: string;
    sha256: string;
  };
  provenance: {
    game: {
      startedAt: string;
      completedAt: string;
      turnCount: number;
    };
  };
}

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

function longControlledSourceMaterial(): {
  sourceBytes: Buffer;
  resultBytes: Buffer;
  sparseTurns: Array<{ turn: { turnNumber: number; intents: [] } }>;
} {
  const completedAt = NOW.toISOString();
  const startedAt = new Date(
    NOW.getTime() - LONG_REPLAY_TURN_COUNT * LONG_REPLAY_TURN_INTERVAL_MS,
  ).toISOString();
  const resultBytes = Buffer.from(
    canonicalReplayPremiereJson(
      authoritativeResultValue({
        completedAt,
        turnCount: LONG_REPLAY_TURN_COUNT,
      }),
    ),
    "utf8",
  );
  const source = JSON.parse(
    controlledSourceBytes().toString("utf8"),
  ) as MutableControlledSourceFixture;
  const turns = [
    { turnNumber: 0, intents: [] as [] },
    { turnNumber: 2, intents: [] as [] },
    { turnNumber: LONG_REPLAY_TURN_COUNT - 1, intents: [] as [] },
  ];

  source.createdAt = completedAt;
  source.gameRecord.info.start = Date.parse(startedAt);
  source.gameRecord.info.end = NOW.getTime();
  source.gameRecord.info.duration =
    LONG_REPLAY_TURN_COUNT * LONG_REPLAY_TURN_INTERVAL_MS;
  source.gameRecord.info.num_turns = LONG_REPLAY_TURN_COUNT;
  source.gameRecord.turns = turns;
  source.replay = {
    turnCount: LONG_REPLAY_TURN_COUNT,
    turnIntervalMs: LONG_REPLAY_TURN_INTERVAL_MS,
  };
  source.authoritativeResult.bytes = resultBytes.toString("base64");
  source.authoritativeResult.sha256 = sha256Hex(resultBytes);
  source.provenance.game.startedAt = startedAt;
  source.provenance.game.completedAt = completedAt;
  source.provenance.game.turnCount = LONG_REPLAY_TURN_COUNT;

  return {
    sourceBytes: Buffer.from(
      canonicalReplayPremiereJson(source as unknown as ReplayPremiereJsonValue),
      "utf8",
    ),
    resultBytes,
    sparseTurns: turns.map((turn) => ({ turn })),
  };
}

function realtimeLongControlledSourceMaterial(): {
  sourceBytes: Buffer;
  resultBytes: Buffer;
  sparseTurns: Array<{ turn: { turnNumber: number; intents: [] } }>;
} {
  const completedAt = NOW.toISOString();
  const startedAt = new Date(
    NOW.getTime() - REALTIME_LONG_TURN_COUNT * REALTIME_LONG_TURN_INTERVAL_MS,
  ).toISOString();
  const resultBytes = Buffer.from(
    canonicalReplayPremiereJson(
      authoritativeResultValue({
        completedAt,
        turnCount: REALTIME_LONG_TURN_COUNT,
      }),
    ),
    "utf8",
  );
  const source = JSON.parse(
    controlledSourceBytes().toString("utf8"),
  ) as MutableControlledSourceFixture;
  const turns = [
    { turnNumber: 0, intents: [] as [] },
    { turnNumber: 2, intents: [] as [] },
    { turnNumber: REALTIME_LONG_TURN_COUNT - 1, intents: [] as [] },
  ];

  source.createdAt = completedAt;
  source.gameRecord.info.start = Date.parse(startedAt);
  source.gameRecord.info.end = NOW.getTime();
  source.gameRecord.info.duration =
    REALTIME_LONG_TURN_COUNT * REALTIME_LONG_TURN_INTERVAL_MS;
  source.gameRecord.info.num_turns = REALTIME_LONG_TURN_COUNT;
  source.gameRecord.turns = turns;
  source.replay = {
    turnCount: REALTIME_LONG_TURN_COUNT,
    turnIntervalMs: REALTIME_LONG_TURN_INTERVAL_MS,
  };
  source.authoritativeResult.bytes = resultBytes.toString("base64");
  source.authoritativeResult.sha256 = sha256Hex(resultBytes);
  source.provenance.game.startedAt = startedAt;
  source.provenance.game.completedAt = completedAt;
  source.provenance.game.turnCount = REALTIME_LONG_TURN_COUNT;

  return {
    sourceBytes: Buffer.from(
      canonicalReplayPremiereJson(source as unknown as ReplayPremiereJsonValue),
      "utf8",
    ),
    resultBytes,
    sparseTurns: turns.map((turn) => ({ turn })),
  };
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
  options: {
    origin?: string;
    leakEvidenceBodyBytes?: number;
    leakEvidenceBodyBytesByCheckId?: Readonly<Record<string, number>>;
  } = {},
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
  const evidenceBodySizes = {
    ...(options.leakEvidenceBodyBytes === undefined
      ? {}
      : { "league-page": options.leakEvidenceBodyBytes }),
    ...(options.leakEvidenceBodyBytesByCheckId ?? {}),
  };
  for (const [checkId, expectedBytes] of Object.entries(evidenceBodySizes)) {
    const evidence = eligibility.proxyWarLeakChecks.find(
      (candidate) => candidate.checkId === checkId,
    );
    if (evidence === undefined || evidence.observedBodyText === null) {
      throw new Error(`missing ${checkId} leak evidence fixture`);
    }
    const target = eligibility.proxyWarLeakAuditManifest.targets.find(
      (candidate) => candidate.checkId === checkId,
    );
    if (target === undefined) {
      throw new Error(`missing ${checkId} leak target fixture`);
    }
    const currentBytes = Buffer.byteLength(evidence.observedBodyText, "utf8");
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < currentBytes) {
      throw new Error("invalid leak evidence body fixture size");
    }
    if (target.expectation.kind === "structured_absent") {
      const emptyStructuredBody = JSON.stringify({ padding: "" });
      if (expectedBytes < Buffer.byteLength(emptyStructuredBody, "utf8")) {
        throw new Error("structured leak evidence fixture is too small");
      }
      evidence.observedBodyText = JSON.stringify({
        padding: "x".repeat(
          expectedBytes - Buffer.byteLength(emptyStructuredBody, "utf8"),
        ),
      });
    } else {
      evidence.observedBodyText += "x".repeat(expectedBytes - currentBytes);
    }
    evidence.observedContentHash = sha256Hex(evidence.observedBodyText);
  }
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

export async function verifiedLongPublicationFixture(
  root: string,
  options: { origin?: string } = {},
): Promise<{
  gate: VerifiedPremiereEligibilityGate;
  drafts: ReturnType<typeof buildPremiereChunks>;
  verificationOptions: Parameters<
    typeof VerifiedPremiereEligibilityGate.verify
  >[0];
  chunkBuildLimits: typeof LONG_REPLAY_CHUNK_LIMITS;
}> {
  const privateRoot = path.join(root, "private");
  const servedRoot = path.join(root, "served");
  const sourcePath = path.join(root, "controlled-long.source.json");
  const material = longControlledSourceMaterial();
  await fs.mkdir(servedRoot, { recursive: true });
  await fs.writeFile(sourcePath, material.sourceBytes, { mode: 0o600 });
  let eligibility = eligibilityFixture({
    sourceBytes: material.sourceBytes,
    resultBytes: material.resultBytes,
    origin: options.origin,
  });
  const eligibilityAssessmentOptions = eligibilityOptions(Buffer.alloc(32, 9));
  const collectedLeakAudit = await collectFixtureLeakAudit(
    eligibility,
    eligibilityAssessmentOptions,
    options.origin,
  );
  eligibility = collectedLeakAudit.eligibility;
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
      turnCount: LONG_REPLAY_TURN_COUNT,
      turnIntervalMs: LONG_REPLAY_TURN_INTERVAL_MS,
      turns: material.sparseTurns,
    },
    LONG_REPLAY_IMPORT_LIMITS,
  );
  const drafts = buildPremiereChunks({
    premiereId: PREMIERE_ID,
    records: imported.records,
    playbackRate: 1,
    checkpointSequences: LONG_REPLAY_CHECKPOINT_SEQUENCES,
    ...LONG_REPLAY_CHUNK_LIMITS,
  });
  const eligibilityRecordHash = assessPremiereEligibility(
    eligibility,
    eligibilityAssessmentOptions,
  ).eligibilityRecordHash;
  const publicDefinition: PremierePublicDefinition = {
    ...publicDefinitionFixture(eligibilityRecordHash, eligibility),
    playbackRate: 1,
    checkpoints: [
      {
        id: "cp_00000001",
        sequence: LONG_REPLAY_CHECKPOINT_SEQUENCES[0],
      },
      {
        id: "cp_00000002",
        sequence: LONG_REPLAY_CHECKPOINT_SEQUENCES[1],
      },
    ],
  };
  const verificationOptions = {
    premiereId: PREMIERE_ID,
    eligibilityRecord: eligibility,
    eligibilityOptions: eligibilityAssessmentOptions,
    leakAuditReceipt: collectedLeakAudit.receipt,
    verifiedSource,
    authoritativeResultBytes: material.resultBytes,
    replayImportLimits: LONG_REPLAY_IMPORT_LIMITS,
    publicDefinition,
    draftChunks: drafts,
    maxPresentationSpanMs: LONG_REPLAY_CHUNK_LIMITS.maxPresentationSpanMs,
  } satisfies Parameters<typeof VerifiedPremiereEligibilityGate.verify>[0];
  const gate = VerifiedPremiereEligibilityGate.verify(verificationOptions);
  return {
    gate,
    drafts,
    verificationOptions,
    chunkBuildLimits: LONG_REPLAY_CHUNK_LIMITS,
  };
}

export async function verifiedRealtimeLongPublicationFixture(
  root: string,
  options: { origin?: string } = {},
): Promise<{
  gate: VerifiedPremiereEligibilityGate;
  drafts: ReturnType<typeof buildPremiereChunks>;
  verificationOptions: Parameters<
    typeof VerifiedPremiereEligibilityGate.verify
  >[0];
  chunkBuildLimits: typeof REALTIME_LONG_CHUNK_LIMITS;
}> {
  const privateRoot = path.join(root, "private");
  const servedRoot = path.join(root, "served");
  const sourcePath = path.join(root, "controlled-realtime-long.source.json");
  const material = realtimeLongControlledSourceMaterial();
  await fs.mkdir(servedRoot, { recursive: true });
  await fs.writeFile(sourcePath, material.sourceBytes, { mode: 0o600 });
  let eligibility = eligibilityFixture({
    sourceBytes: material.sourceBytes,
    resultBytes: material.resultBytes,
    origin: options.origin,
  });
  const eligibilityAssessmentOptions = eligibilityOptions(Buffer.alloc(32, 9));
  const collectedLeakAudit = await collectFixtureLeakAudit(
    eligibility,
    eligibilityAssessmentOptions,
    options.origin,
  );
  eligibility = collectedLeakAudit.eligibility;
  const staged = await stagePremiereSource({
    sourceFilePath: sourcePath,
    privateStateRoot: privateRoot,
    servedRoots: [servedRoot],
    maxSourceBytes: 4_000_000,
    expectedSourceReplaySha256: eligibility.sourceReplaySha256,
  });
  const verifiedSource = await readVerifiedStagedPremiereSource({
    stagedSource: staged,
    privateStateRoot: privateRoot,
    servedRoots: [servedRoot],
    maxSourceBytes: 4_000_000,
  });
  const imported = importPremiereReplay(
    {
      gameStartInfo: gameStartInfo(),
      turnCount: REALTIME_LONG_TURN_COUNT,
      turnIntervalMs: REALTIME_LONG_TURN_INTERVAL_MS,
      turns: material.sparseTurns,
    },
    REALTIME_LONG_IMPORT_LIMITS,
  );
  const drafts = buildPremiereChunks({
    premiereId: PREMIERE_ID,
    records: imported.records,
    playbackRate: 1,
    checkpointSequences: REALTIME_LONG_CHECKPOINT_SEQUENCES,
    ...REALTIME_LONG_CHUNK_LIMITS,
  });
  const eligibilityRecordHash = assessPremiereEligibility(
    eligibility,
    eligibilityAssessmentOptions,
  ).eligibilityRecordHash;
  const publicDefinition: PremierePublicDefinition = {
    ...publicDefinitionFixture(eligibilityRecordHash, eligibility),
    playbackRate: 1,
    checkpoints: [
      {
        id: "cp_00000001",
        sequence: REALTIME_LONG_CHECKPOINT_SEQUENCES[0],
      },
      {
        id: "cp_00000002",
        sequence: REALTIME_LONG_CHECKPOINT_SEQUENCES[1],
      },
    ],
  };
  const verificationOptions = {
    premiereId: PREMIERE_ID,
    eligibilityRecord: eligibility,
    eligibilityOptions: eligibilityAssessmentOptions,
    leakAuditReceipt: collectedLeakAudit.receipt,
    verifiedSource,
    authoritativeResultBytes: material.resultBytes,
    replayImportLimits: REALTIME_LONG_IMPORT_LIMITS,
    publicDefinition,
    draftChunks: drafts,
    maxPresentationSpanMs: REALTIME_LONG_CHUNK_LIMITS.maxPresentationSpanMs,
  } satisfies Parameters<typeof VerifiedPremiereEligibilityGate.verify>[0];
  const gate = VerifiedPremiereEligibilityGate.verify(verificationOptions);
  return {
    gate,
    drafts,
    verificationOptions,
    chunkBuildLimits: REALTIME_LONG_CHUNK_LIMITS,
  };
}

export const RATED_PREMIERE_ID = "prem_rated0123456789ab";
export const RATED_RUN_ID = "coworld-2026-07-20T17-00-00-000Z-feedface";
export const RATED_EPISODE_REQUEST_ID = "ereq_fixture-0001";
export const RATED_EPISODE_ID = "e51fa9fixture0001";
export const RATED_ROUND_ID = "round_fixture-0001";
export const RATED_LEAGUE_ID = "league_fixture-0001";
export const RATED_DIVISION_ID = "div_fixture-0001";
export const RATED_COWORLD_ID = "cow_fixture-0001";

export function ratedCoworldGameRecordValue(): Record<string, unknown> {
  const start = gameStartInfo();
  return {
    version: "v0.0.2",
    gitCommit: "DEV",
    subdomain: "local",
    domain: "ai-league-demo",
    info: {
      ...start,
      gameID: "RATE0001",
      players: [
        {
          clientID: "RSEATA01",
          username: "AlphaCog",
          clanTag: null,
          persistentID: null,
        },
        {
          clientID: "RSEATA02",
          username: "BetaCog",
          clanTag: null,
          persistentID: null,
        },
      ],
      start: Date.parse("2026-07-20T17:00:00.000Z"),
      end: Date.parse("2026-07-20T17:00:00.800Z"),
      duration: 800,
      num_turns: 8,
      lobbyFillTime: 0,
    },
    turns: [
      { turnNumber: 0, intents: [] },
      { turnNumber: 2, intents: [] },
      { turnNumber: 5, intents: [] },
    ],
  };
}

export function ratedCoworldRawReplayValue(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    replayKind: "proxywar-coworld-local-poc",
    runID: RATED_RUN_ID,
    matchID: "RATE0001",
    config: { player_count: 2 },
    results: {
      turn_count: 8,
      winner_slot: 1,
      // Raw account names: slot 0 exercises the OpenFront username
      // sanitization gap ("Alpha-Cog" is recorded in-game as "AlphaCog").
      players: [
        { slot: 0, name: "Alpha-Cog", score: 0 },
        { slot: 1, name: "BetaCog", score: 1 },
      ],
    },
    finalState: { winnerSlot: 1 },
    inlineRunArtifacts: {
      "game-record.json": JSON.stringify(ratedCoworldGameRecordValue()),
    },
  };
}

export function ratedCoworldEpisodeRows(): Array<Record<string, unknown>> {
  return [
    {
      id: RATED_EPISODE_REQUEST_ID,
      status: "completed",
      episode_id: RATED_EPISODE_ID,
      round_id: RATED_ROUND_ID,
      coworld_id: RATED_COWORLD_ID,
      coworld_name: "proxywar",
      coworld_version: "0.1.10",
      variant_name: "Tournament 2P - Asia",
      replay_url:
        "https://softmax-public.s3.amazonaws.com/replays/fixture-0001.replay",
      requester_user_id: "commissioner",
      created_at: "2026-07-20T16:30:00.000Z",
      completed_at: "2026-07-20T17:00:01.000Z",
      game_config: {
        map: String(GameMapType.Asia),
        map_size: String(GameMapSize.Normal),
        difficulty: String(Difficulty.Medium),
        num_agents: 2,
      },
      participants: [
        {
          position: 0,
          policy_version_id: "9f000000-0000-4000-8000-000000000001",
          policy_id: "82000000-0000-4000-8000-000000000001",
          policy_name: "alpha-cog",
          version: 3,
          player_id: "ply_alpha-0001",
          player_name: "Alpha-Cog",
          is_filler: false,
          label: "alpha-cog:v3",
        },
        {
          position: 1,
          policy_version_id: "9f000000-0000-4000-8000-000000000002",
          policy_id: "82000000-0000-4000-8000-000000000002",
          policy_name: "beta-cog",
          version: 7,
          player_id: "ply_beta-0001",
          player_name: "BetaCog",
          is_filler: false,
          label: "beta-cog:v7",
        },
      ],
    },
  ];
}

export function ratedCoworldDivisionRows(): Array<Record<string, unknown>> {
  return [
    {
      id: RATED_DIVISION_ID,
      name: "Competition",
      league: {
        id: RATED_LEAGUE_ID,
        name: "Proxywar",
        game: { coworld_id: RATED_COWORLD_ID, coworld_name: "proxywar" },
      },
    },
    {
      id: "div_other-0001",
      name: "Other",
      league: {
        id: "league_other-0001",
        name: "Other",
        game: { coworld_id: "cow_other-0001", coworld_name: "other" },
      },
    },
  ];
}

export function ratedEligibilityFixture(material: {
  sourceBytes: Buffer;
  origin?: string;
}): PremiereEligibility {
  const bundle = JSON.parse(material.sourceBytes.toString("utf8")) as {
    sourceRunId: string;
    gameRecord: { info: { gameID: string } };
    authoritativeResult: { sourceId: string; sha256: string };
    seats: PremiereSeatIdentity[];
    coworld: {
      episodeId: string;
      leagueId: string;
      divisionId: string;
      roundId: string;
    };
  };
  const manifest = buildRequiredProxyWarLeakAuditManifest({
    origin: material.origin ?? "https://beta.proxywar.xyz",
    sourceRunId: bundle.sourceRunId,
    createdAt: NOW.toISOString(),
    sourceKind: "rated_coworld",
    fingerprintBinding: {
      sourceReplaySha256: sha256Hex(material.sourceBytes),
      authoritativeResultSha256: bundle.authoritativeResult.sha256,
      authoritativeResultSourceId: bundle.authoritativeResult.sourceId,
      gameIds: [bundle.gameRecord.info.gameID],
      seatIds: bundle.seats.map((seat) => seat.seatId),
      seatDisplayNames: bundle.seats.map((seat) => seat.displayName),
      coworldEpisodeId: bundle.coworld.episodeId,
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
    sourceKind: "rated_coworld",
    sourceRunId: bundle.sourceRunId,
    coworld: { ...bundle.coworld },
    sourceReplaySha256: sha256Hex(material.sourceBytes),
    sourceBundleOutsideServedRoots: true,
    proxyWarLeakAuditManifest: manifest,
    proxyWarLeakChecks,
    externalEmbargoEvidence: [],
    externalOutcomeMayBePublic: true,
    seats: bundle.seats,
    authoritativeResult: {
      sourceKind: "coworld_result",
      sourceId: bundle.authoritativeResult.sourceId,
      resultHash: bundle.authoritativeResult.sha256,
    },
    publicLabel: "spoiler_resistant_premiere",
  };
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
