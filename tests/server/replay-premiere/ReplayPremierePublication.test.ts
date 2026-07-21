import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { verifyPremiereAuthoritativeResultBytes } from "../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import { buildPremiereChunks } from "../../../src/server/replay-premiere/ReplayPremiereChunks";
import { assessPremiereEligibility } from "../../../src/server/replay-premiere/ReplayPremiereEligibility";
import { importPremiereReplay } from "../../../src/server/replay-premiere/ReplayPremiereImport";
import {
  canonicalReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  readVerifiedStagedPremiereSource,
  stagePremiereSource,
} from "../../../src/server/replay-premiere/ReplayPremierePrivateStaging";
import {
  cloneAndFreezePremiereDraftChunks,
  importControlledPremiereSourceForPublication,
  replayPremiereDraftChunksMatch,
  replayPremiereRecordsMatchDrafts,
  VerifiedPremiereEligibilityGate,
  verifyPremierePublicationCommitment,
} from "../../../src/server/replay-premiere/ReplayPremierePublication";
import { REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES } from "../../../src/server/replay-premiere/ReplayPremiereRevealEnvelopeCapacity";
import {
  authoritativeResultBytes,
  authoritativeResultValue,
  collectFixtureLeakAudit,
  controlledSourceBytes,
  eligibilityFixture,
  eligibilityOptions,
  gameStartInfo,
  IMPORT_LIMITS,
  PREMIERE_ID,
  publicDefinitionFixture,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

describe("ReplayPremiere publication commitment", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-publication-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("exposes the admitted reveal event byte requirement", async () => {
    const { gate } = await verifiedPublicationFixture(root);
    expect(gate.requiredRevealEventBytes).toBeGreaterThan(0);
    expect(gate.requiredRevealEventBytes).toBeLessThanOrEqual(
      REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES,
    );
  });

  test("accepts non-varied sources and rejects both spawn flags independently", () => {
    const sourceBytes = controlledSourceBytes();
    expect(() =>
      importControlledPremiereSourceForPublication({
        sourceBytes,
        eligibilityRecord: eligibilityFixture({ sourceBytes }),
        authoritativeResultBytes: authoritativeResultBytes(),
        replayImportLimits: IMPORT_LIMITS,
      }),
    ).not.toThrow();

    const mutations: Array<(source: Record<string, any>) => void> = [
      (source) => {
        const execution = source.provenance.executionConfig;
        execution.game.varySpawns = true;
        source.provenance.executionConfigSha256 = sha256Hex(
          canonicalReplayPremiereJson(execution),
        );
      },
      (source) => {
        source.gameRecord.info.config.randomSpawn = true;
      },
      (source) => {
        const execution = source.provenance.executionConfig;
        execution.game.varySpawns = true;
        source.gameRecord.info.config.randomSpawn = true;
        source.provenance.executionConfigSha256 = sha256Hex(
          canonicalReplayPremiereJson(execution),
        );
      },
    ];
    for (const mutate of mutations) {
      const source = JSON.parse(sourceBytes.toString("utf8")) as Record<
        string,
        any
      >;
      mutate(source);
      const mutatedBytes = Buffer.from(
        canonicalReplayPremiereJson(source as ReplayPremiereJsonValue),
        "utf8",
      );
      expect(() =>
        importControlledPremiereSourceForPublication({
          sourceBytes: mutatedBytes,
          eligibilityRecord: eligibilityFixture({ sourceBytes: mutatedBytes }),
          authoritativeResultBytes: authoritativeResultBytes(),
          replayImportLimits: IMPORT_LIMITS,
        }),
      ).toThrow(/controlled_source_execution_game_mismatch/);
    }
  });

  test("rejects a separately valid A/B tail after the publication is frozen", async () => {
    const { verificationOptions } = await verifiedPublicationFixture(root);
    const imported = importPremiereReplay(
      {
        gameStartInfo: gameStartInfo(),
        turnCount: 6,
        turnIntervalMs: 100,
        turns: [
          { turn: { turnNumber: 0, intents: [] } },
          { turn: { turnNumber: 2, intents: [] } },
          { turn: { turnNumber: 5, intents: [], hash: 99 } },
        ],
      },
      IMPORT_LIMITS,
    );
    const alternateTail = buildPremiereChunks({
      premiereId: PREMIERE_ID,
      records: imported.records,
      playbackRate: 2,
      checkpointSequences: [2, 4],
      maxChunkBytes: 100_000,
      maxTotalBytes: 1_000_000,
      maxRecordsPerChunk: 20,
      maxPresentationSpanMs: 1_000,
    });
    expect(() =>
      VerifiedPremiereEligibilityGate.verify({
        ...verificationOptions,
        draftChunks: alternateTail,
      }),
    ).toThrow(/source_replay_draft_binding_mismatch/);
  });

  test("binds long replay drafts record by record within the JSON node ceiling", () => {
    const records = Array.from({ length: 12_000 }, (_, sequence) => ({
      sequence,
      turn: sequence,
      nominalOffsetMs: sequence,
      payload: { turnNumber: sequence, intents: [] },
    }));
    const drafts = buildPremiereChunks({
      premiereId: PREMIERE_ID,
      records,
      playbackRate: 1,
      checkpointSequences: [3_999, 7_999],
      maxChunkBytes: 1_000_000,
      maxTotalBytes: 20_000_000,
      maxRecordsPerChunk: 100,
      maxPresentationSpanMs: 100,
    });

    const frozen = cloneAndFreezePremiereDraftChunks(drafts);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[0])).toBe(true);
    expect(replayPremiereDraftChunksMatch(drafts, frozen)).toBe(true);
    expect(replayPremiereRecordsMatchDrafts(records, 1, frozen)).toBe(true);
    const altered = structuredClone(drafts);
    altered.at(-1)!.payload.records.at(-1)!.turn += 1;
    expect(replayPremiereDraftChunksMatch(drafts, altered)).toBe(false);
    expect(replayPremiereRecordsMatchDrafts(records, 1, altered)).toBe(false);
  });

  test("verifies a 57,000-turn sparse-source publication gate comfortably inside the startup fence", async () => {
    const turnCount = 57_000;
    const checkpointSequences = [19_950, 37_050] as const;
    const completedAt = new Date("2026-07-20T18:00:00.000Z");
    const startedAt = new Date(completedAt.getTime() - turnCount);
    const resultBytes = Buffer.from(
      canonicalReplayPremiereJson(
        authoritativeResultValue({
          completedAt: completedAt.toISOString(),
          turnCount,
        }),
      ),
      "utf8",
    );
    const source = JSON.parse(
      controlledSourceBytes().toString("utf8"),
    ) as Record<string, any>;
    const sparseTurns = [
      { turnNumber: 0, intents: [] },
      { turnNumber: 2, intents: [] },
      { turnNumber: turnCount - 1, intents: [] },
    ];
    source.createdAt = completedAt.toISOString();
    source.gameRecord.info.start = startedAt.getTime();
    source.gameRecord.info.end = completedAt.getTime();
    source.gameRecord.info.duration = turnCount;
    source.gameRecord.info.num_turns = turnCount;
    source.gameRecord.turns = sparseTurns;
    source.replay = { turnCount, turnIntervalMs: 1 };
    source.authoritativeResult.bytes = resultBytes.toString("base64");
    source.authoritativeResult.sha256 = sha256Hex(resultBytes);
    source.provenance.game.startedAt = startedAt.toISOString();
    source.provenance.game.completedAt = completedAt.toISOString();
    source.provenance.game.turnCount = turnCount;
    const sourceBytes = Buffer.from(
      canonicalReplayPremiereJson(source as ReplayPremiereJsonValue),
      "utf8",
    );
    let eligibility = eligibilityFixture({ sourceBytes, resultBytes });
    const assessmentOptions = eligibilityOptions(Buffer.alloc(32, 9));
    const collectedLeakAudit = await collectFixtureLeakAudit(
      eligibility,
      assessmentOptions,
    );
    eligibility = collectedLeakAudit.eligibility;
    const privateRoot = path.join(root, "private-source-class");
    const servedRoot = path.join(root, "served-source-class");
    const sourcePath = path.join(root, "controlled-source-class.source.json");
    await fs.mkdir(servedRoot, { recursive: true });
    await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
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
    const replayImportLimits = {
      maxBootstrapBytes: 100_000,
      maxTurnBytes: 100_000,
      maxTurnRecords: turnCount,
      maxTotalTurnBytes: 4_000_000,
    };
    const imported = importPremiereReplay(
      {
        gameStartInfo: gameStartInfo(),
        turnCount,
        turnIntervalMs: 1,
        turns: sparseTurns.map((turn) => ({ turn })),
      },
      replayImportLimits,
    );
    const drafts = buildPremiereChunks({
      premiereId: PREMIERE_ID,
      records: imported.records,
      playbackRate: 1,
      checkpointSequences,
      maxChunkBytes: 1_048_576,
      maxTotalBytes: 128 * 1_048_576,
      maxRecordsPerChunk: 1_000,
      maxPresentationSpanMs: 1_000,
    });
    const eligibilityRecordHash = assessPremiereEligibility(
      eligibility,
      assessmentOptions,
    ).eligibilityRecordHash;
    const publicDefinition: ReturnType<typeof publicDefinitionFixture> = {
      ...publicDefinitionFixture(eligibilityRecordHash, eligibility),
      playbackRate: 1,
      checkpoints: [
        { id: "cp_00000001", sequence: checkpointSequences[0] },
        { id: "cp_00000002", sequence: checkpointSequences[1] },
      ],
    };

    const startedVerificationAt = performance.now();
    const gate = VerifiedPremiereEligibilityGate.verify({
      premiereId: PREMIERE_ID,
      eligibilityRecord: eligibility,
      eligibilityOptions: assessmentOptions,
      leakAuditReceipt: collectedLeakAudit.receipt,
      verifiedSource,
      authoritativeResultBytes: resultBytes,
      replayImportLimits,
      publicDefinition,
      draftChunks: drafts,
      maxPresentationSpanMs: 1_000,
    });
    const verificationElapsedMs = performance.now() - startedVerificationAt;

    expect(gate.finalSequence).toBe(turnCount - 1);
    expect(gate.chunkCount).toBe(58);
    expect(gate.requiredRevealEventBytes).toBeGreaterThan(0);
    expect(verificationElapsedMs).toBeLessThan(5_000);
  }, 10_000);

  test("rejects a verified but different staged source and commitment preimage mutation", async () => {
    const { gate, verificationOptions } =
      await verifiedPublicationFixture(root);
    const sourcePath = path.join(root, "source-b.json");
    await fs.writeFile(
      sourcePath,
      Buffer.concat([controlledSourceBytes(), Buffer.from(" ")]),
      { mode: 0o600 },
    );
    const staged = await stagePremiereSource({
      sourceFilePath: sourcePath,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      maxSourceBytes: 2_000_000,
    });
    const verifiedSource = await readVerifiedStagedPremiereSource({
      stagedSource: staged,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      maxSourceBytes: 2_000_000,
    });
    expect(() =>
      VerifiedPremiereEligibilityGate.verify({
        ...verificationOptions,
        verifiedSource,
      }),
    ).toThrow(/staged_source_hash_mismatch/);

    const mutated = {
      ...gate.publicationCommitment(),
      finalSequence: gate.finalSequence + 1,
    };
    expect(() => verifyPremierePublicationCommitment(mutated)).toThrow(
      /invalid_publication_commitment/,
    );
  });

  test("strictly binds result sourceId and winner-or-void semantics", () => {
    const originalEligibility = eligibilityFixture();
    expect(() =>
      verifyPremiereAuthoritativeResultBytes({
        eligibilityRecord: originalEligibility,
        resultBytes: authoritativeResultBytes(),
      }),
    ).not.toThrow();

    const relabeledBytes = Buffer.from(
      canonicalReplayPremiereJson(
        authoritativeResultValue({ sourceId: "controlled-run-001:other" }),
      ),
      "utf8",
    );
    const relabeledEligibility = eligibilityFixture({
      resultBytes: relabeledBytes,
    });
    expect(() =>
      verifyPremiereAuthoritativeResultBytes({
        eligibilityRecord: relabeledEligibility,
        resultBytes: relabeledBytes,
      }),
    ).toThrow(/contract_mismatch/);

    const invalidVoidBytes = Buffer.from(
      canonicalReplayPremiereJson(authoritativeResultValue({ winner: null })),
      "utf8",
    );
    const invalidVoidEligibility = eligibilityFixture({
      resultBytes: invalidVoidBytes,
    });
    expect(sha256Hex(invalidVoidBytes)).toBe(
      invalidVoidEligibility.authoritativeResult.resultHash,
    );
    expect(() =>
      verifyPremiereAuthoritativeResultBytes({
        eligibilityRecord: invalidVoidEligibility,
        resultBytes: invalidVoidBytes,
      }),
    ).toThrow(/winner_flag_mismatch/);
  });

  test("binds canonical winner and completion time to the private GameRecord", async () => {
    const baseline = await verifiedPublicationFixture(root);
    const cases: Array<{
      name: string;
      result: ReplayPremiereJsonValue;
      mutateBundle: (bundle: Record<string, any>) => void;
      operatorCode: string | null;
    }> = [
      {
        name: "canonical-void",
        result: authoritativeResultValue({
          winner: null,
          seats: [
            { seatId: "SEAT0001", displayName: "Alpha", won: false },
            { seatId: "SEAT0002", displayName: "Beta", won: false },
          ],
        }),
        mutateBundle: (bundle) => {
          delete bundle.gameRecord.info.winner;
        },
        operatorCode: null,
      },
      {
        name: "opposite-winner",
        result: authoritativeResultValue({
          winner: ["player", "SEAT0002"],
          seats: [
            { seatId: "SEAT0001", displayName: "Alpha", won: false },
            { seatId: "SEAT0002", displayName: "Beta", won: true },
          ],
        }),
        mutateBundle: () => undefined,
        operatorCode: "result_game_record_winner_mismatch",
      },
      {
        name: "completion-time",
        result: authoritativeResultValue({
          completedAt: "2026-07-20T18:00:00.601Z",
        }),
        mutateBundle: () => undefined,
        operatorCode: "result_game_record_completed_at_mismatch",
      },
      {
        name: "winner-tuple-kind",
        result: authoritativeResultValue({
          winner: ["team", "red", "SEAT0001"],
        }),
        mutateBundle: () => undefined,
        operatorCode: "result_game_record_winner_mismatch",
      },
    ];

    for (const testCase of cases) {
      const resultBytes = Buffer.from(
        canonicalReplayPremiereJson(testCase.result),
        "utf8",
      );
      const bundle = JSON.parse(
        controlledSourceBytes().toString("utf8"),
      ) as Record<string, any>;
      testCase.mutateBundle(bundle);
      bundle.authoritativeResult.bytes = resultBytes.toString("base64");
      bundle.authoritativeResult.sha256 = sha256Hex(resultBytes);
      const sourceBytes = Buffer.from(
        canonicalReplayPremiereJson(bundle),
        "utf8",
      );
      let eligibility = eligibilityFixture({ sourceBytes, resultBytes });
      const assessmentOptions = eligibilityOptions(Buffer.alloc(32, 9));
      const collectedLeakAudit = await collectFixtureLeakAudit(
        eligibility,
        assessmentOptions,
      );
      eligibility = collectedLeakAudit.eligibility;
      const eligibilityRecordHash = assessPremiereEligibility(
        eligibility,
        assessmentOptions,
      ).eligibilityRecordHash;
      const sourcePath = path.join(root, `${testCase.name}.source.json`);
      await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
      const staged = await stagePremiereSource({
        sourceFilePath: sourcePath,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        maxSourceBytes: 2_000_000,
        expectedSourceReplaySha256: eligibility.sourceReplaySha256,
      });
      const verifiedSource = await readVerifiedStagedPremiereSource({
        stagedSource: staged,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        maxSourceBytes: 2_000_000,
      });

      const verify = () =>
        VerifiedPremiereEligibilityGate.verify({
          ...baseline.verificationOptions,
          eligibilityRecord: eligibility,
          eligibilityOptions: assessmentOptions,
          leakAuditReceipt: collectedLeakAudit.receipt,
          verifiedSource,
          authoritativeResultBytes: resultBytes,
          publicDefinition: publicDefinitionFixture(
            eligibilityRecordHash,
            eligibility,
          ),
        });
      if (testCase.operatorCode === null) {
        expect(verify).not.toThrow();
      } else {
        let rejected: unknown;
        try {
          verify();
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toMatchObject({
          operatorCode: testCase.operatorCode,
        });
      }
    }
  });

  test("rejects a coherent forged execution envelope and seat identity mismatch", async () => {
    const { verificationOptions } = await verifiedPublicationFixture(root);
    const mutations: Array<(bundle: Record<string, any>) => void> = [
      (bundle) => {
        const execution = bundle.provenance.executionConfig;
        bundle.provenance.brainMode = "forged-brain";
        execution.brainMode = "forged-brain";
        execution.runner.turnsPerDecisionSchedule = [25];
        execution.runner.maxSteps = 501;
        execution.runner.autopilotEndgameSteps = 100;
        execution.game.bots = 1;
        execution.game.nations = 1;
        execution.disabledActionKinds = ["quick_chat", "attack"];
        bundle.gameRecord.info.config.bots = 1;
        bundle.gameRecord.info.config.nations = 1;
        bundle.provenance.executionConfigSha256 = sha256Hex(
          canonicalReplayPremiereJson(execution),
        );
      },
      (bundle) => {
        delete bundle.provenance.executionConfig;
      },
      (bundle) => {
        bundle.gameRecord.info.players[0].username = "Counterfeit";
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const bundle = JSON.parse(
        controlledSourceBytes().toString("utf8"),
      ) as Record<string, any>;
      mutate(bundle);
      const sourceBytes = Buffer.from(
        canonicalReplayPremiereJson(bundle),
        "utf8",
      );
      let eligibility = eligibilityFixture({ sourceBytes });
      const assessmentOptions = eligibilityOptions(Buffer.alloc(32, 9));
      const collectedLeakAudit = await collectFixtureLeakAudit(
        eligibility,
        assessmentOptions,
      );
      eligibility = collectedLeakAudit.eligibility;
      const eligibilityRecordHash = assessPremiereEligibility(
        eligibility,
        assessmentOptions,
      ).eligibilityRecordHash;
      const sourcePath = path.join(root, `mutated-${index}.json`);
      await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
      const staged = await stagePremiereSource({
        sourceFilePath: sourcePath,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        maxSourceBytes: 2_000_000,
      });
      const verifiedSource = await readVerifiedStagedPremiereSource({
        stagedSource: staged,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        maxSourceBytes: 2_000_000,
      });
      expect(() =>
        VerifiedPremiereEligibilityGate.verify({
          ...verificationOptions,
          eligibilityRecord: eligibility,
          eligibilityOptions: assessmentOptions,
          leakAuditReceipt: collectedLeakAudit.receipt,
          verifiedSource,
          publicDefinition: publicDefinitionFixture(
            eligibilityRecordHash,
            eligibility,
          ),
        }),
      ).toThrow(
        /outside_allowlist|provenance|seat_player_binding|unknown_or_missing/,
      );
    }
  });

  test("rejects an independently admissible eligibility record and terminal chunk whose reveal envelope exceeds canonical JSON capacity", async () => {
    const externalEvidenceCount = 7_500;
    const terminalIntentCount = 19_000;
    const terminalIntents = Array.from({ length: terminalIntentCount }, () => ({
      type: "start_game" as const,
      clientID: "SEAT0001",
    }));
    const source = JSON.parse(
      controlledSourceBytes().toString("utf8"),
    ) as Record<string, any>;
    source.gameRecord.turns[2].intents = terminalIntents;
    const sourceBytes = Buffer.from(
      canonicalReplayPremiereJson(source as ReplayPremiereJsonValue),
      "utf8",
    );
    let eligibility = eligibilityFixture({ sourceBytes });
    const assessmentOptions = eligibilityOptions(Buffer.alloc(32, 9));
    eligibility.externalEmbargoEvidence = Array.from(
      { length: externalEvidenceCount },
      () => ({
        source: "controlled runner",
        scope: "source and outcome",
        observedAt: assessmentOptions.now.toISOString(),
        verifier: "operator",
        embargoConfirmed: true,
      }),
    );
    const collectedLeakAudit = await collectFixtureLeakAudit(
      eligibility,
      assessmentOptions,
    );
    eligibility = collectedLeakAudit.eligibility;
    const eligibilityAssessment = assessPremiereEligibility(
      eligibility,
      assessmentOptions,
    );
    expect(eligibilityAssessment.eligible).toBe(true);
    const eligibilityRecordHash = eligibilityAssessment.eligibilityRecordHash;
    const privateRoot = path.join(root, "private-capacity");
    const servedRoot = path.join(root, "served-capacity");
    const sourcePath = path.join(root, "controlled-capacity.source.json");
    await fs.mkdir(servedRoot, { recursive: true });
    await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
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
    const replayImportLimits = {
      ...IMPORT_LIMITS,
      maxTurnBytes: 2_000_000,
      maxTotalTurnBytes: 4_000_000,
    };
    const imported = importPremiereReplay(
      {
        gameStartInfo: gameStartInfo(),
        turnCount: 6,
        turnIntervalMs: 100,
        turns: [
          { turn: { turnNumber: 0, intents: [] } },
          { turn: { turnNumber: 2, intents: [] } },
          { turn: { turnNumber: 5, intents: terminalIntents } },
        ],
      },
      replayImportLimits,
    );
    const drafts = buildPremiereChunks({
      premiereId: PREMIERE_ID,
      records: imported.records,
      playbackRate: 2,
      checkpointSequences: [2, 4],
      maxChunkBytes: 2_000_000,
      maxTotalBytes: 4_000_000,
      maxRecordsPerChunk: 20,
      maxPresentationSpanMs: 1_000,
    });
    const terminalDraft = drafts.at(-1)!;
    expect(terminalDraft.descriptor.terminal).toBe(true);

    const eligibilityJson = canonicalReplayPremiereJson(
      eligibility as unknown as ReplayPremiereJsonValue,
    );
    const terminalDraftJson = canonicalReplayPremiereJson(
      terminalDraft as unknown as ReplayPremiereJsonValue,
    );
    expect(Buffer.byteLength(eligibilityJson, "utf8")).toBeGreaterThan(750_000);
    expect(Buffer.byteLength(terminalDraftJson, "utf8")).toBeGreaterThan(
      750_000,
    );
    expect(Buffer.byteLength(eligibilityJson, "utf8")).toBeLessThan(
      REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES,
    );
    expect(Buffer.byteLength(terminalDraftJson, "utf8")).toBeLessThan(
      REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES,
    );

    let rejected: unknown;
    try {
      VerifiedPremiereEligibilityGate.verify({
        premiereId: PREMIERE_ID,
        eligibilityRecord: eligibility,
        eligibilityOptions: assessmentOptions,
        leakAuditReceipt: collectedLeakAudit.receipt,
        verifiedSource,
        authoritativeResultBytes: authoritativeResultBytes(),
        replayImportLimits,
        publicDefinition: publicDefinitionFixture(
          eligibilityRecordHash,
          eligibility,
        ),
        draftChunks: drafts,
        maxPresentationSpanMs: 1_000,
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({
      operatorCode: "reveal_envelope_json_complexity_exceeded",
      publicCode: "PREMIERE_CAPACITY_EXCEEDED",
      httpStatus: 413,
    });
  });

  test("rejects a low-node reveal whose stored event exceeds the V1 byte ceiling", async () => {
    const largeDisplayText = "界".repeat(256);
    const largeAttackId = "界".repeat(64);
    const terminalIntents = Array.from({ length: 4_500 }, () => ({
      type: "cancel_attack" as const,
      attackID: largeAttackId,
      clientID: "SEAT0001",
    }));
    const source = JSON.parse(
      controlledSourceBytes().toString("utf8"),
    ) as Record<string, any>;
    source.gameRecord.turns[2].intents = terminalIntents;
    const sourceBytes = Buffer.from(
      canonicalReplayPremiereJson(source as ReplayPremiereJsonValue),
      "utf8",
    );
    let eligibility = eligibilityFixture({ sourceBytes });
    const assessmentOptions = eligibilityOptions(Buffer.alloc(32, 9));
    eligibility.externalEmbargoEvidence = Array.from({ length: 400 }, () => ({
      source: largeDisplayText,
      scope: largeDisplayText,
      observedAt: assessmentOptions.now.toISOString(),
      verifier: largeDisplayText,
      embargoConfirmed: true,
    }));
    const collectedLeakAudit = await collectFixtureLeakAudit(
      eligibility,
      assessmentOptions,
    );
    eligibility = collectedLeakAudit.eligibility;
    const eligibilityAssessment = assessPremiereEligibility(
      eligibility,
      assessmentOptions,
    );
    expect(eligibilityAssessment.eligible).toBe(true);
    const privateRoot = path.join(root, "private-byte-capacity");
    const servedRoot = path.join(root, "served-byte-capacity");
    const sourcePath = path.join(root, "controlled-byte-capacity.source.json");
    await fs.mkdir(servedRoot, { recursive: true });
    await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
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
    const replayImportLimits = {
      ...IMPORT_LIMITS,
      maxTurnBytes: 4_000_000,
      maxTotalTurnBytes: 6_000_000,
    };
    const imported = importPremiereReplay(
      {
        gameStartInfo: gameStartInfo(),
        turnCount: 6,
        turnIntervalMs: 100,
        turns: [
          { turn: { turnNumber: 0, intents: [] } },
          { turn: { turnNumber: 2, intents: [] } },
          { turn: { turnNumber: 5, intents: terminalIntents } },
        ],
      },
      replayImportLimits,
    );
    const drafts = buildPremiereChunks({
      premiereId: PREMIERE_ID,
      records: imported.records,
      playbackRate: 2,
      checkpointSequences: [2, 4],
      maxChunkBytes: 4_000_000,
      maxTotalBytes: 6_000_000,
      maxRecordsPerChunk: 20,
      maxPresentationSpanMs: 1_000,
    });
    const terminalDraft = drafts.at(-1)!;
    expect(terminalDraft.descriptor.terminal).toBe(true);

    const eligibilityJson = canonicalReplayPremiereJson(
      eligibility as unknown as ReplayPremiereJsonValue,
    );
    const terminalDraftJson = canonicalReplayPremiereJson(
      terminalDraft as unknown as ReplayPremiereJsonValue,
    );
    expect(Buffer.byteLength(eligibilityJson, "utf8")).toBeGreaterThan(750_000);
    expect(Buffer.byteLength(terminalDraftJson, "utf8")).toBeGreaterThan(
      750_000,
    );
    expect(Buffer.byteLength(eligibilityJson, "utf8")).toBeLessThan(
      REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES,
    );
    expect(Buffer.byteLength(terminalDraftJson, "utf8")).toBeLessThan(
      REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES,
    );

    let rejected: unknown;
    try {
      VerifiedPremiereEligibilityGate.verify({
        premiereId: PREMIERE_ID,
        eligibilityRecord: eligibility,
        eligibilityOptions: assessmentOptions,
        leakAuditReceipt: collectedLeakAudit.receipt,
        verifiedSource,
        authoritativeResultBytes: authoritativeResultBytes(),
        replayImportLimits,
        publicDefinition: publicDefinitionFixture(
          eligibilityAssessment.eligibilityRecordHash,
          eligibility,
        ),
        draftChunks: drafts,
        maxPresentationSpanMs: 1_000,
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({
      operatorCode: "reveal_event_byte_ceiling_exceeded",
      publicCode: "PREMIERE_CAPACITY_EXCEEDED",
      httpStatus: 413,
    });
  });
});
