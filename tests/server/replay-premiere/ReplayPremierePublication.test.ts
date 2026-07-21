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
  replayPremiereDraftChunksMatch,
  replayPremiereRecordsMatchDrafts,
  VerifiedPremiereEligibilityGate,
  verifyPremierePublicationCommitment,
} from "../../../src/server/replay-premiere/ReplayPremierePublication";
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
    const records = Array.from({ length: 13_000 }, (_, sequence) => ({
      sequence,
      turn: sequence,
      nominalOffsetMs: sequence,
      payload: { turnNumber: sequence, intents: [] },
    }));
    const drafts = buildPremiereChunks({
      premiereId: PREMIERE_ID,
      records,
      playbackRate: 1,
      checkpointSequences: [4_333, 8_666],
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
});
