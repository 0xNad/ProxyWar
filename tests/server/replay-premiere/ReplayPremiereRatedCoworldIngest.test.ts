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
import { freezeReplayPremiereCheckpointProjection } from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
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
});

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
    },
    fetchCalls: () => fetchCalls,
    privateStateRoot,
    servedRoot,
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
