import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadCoworldEvaluationEpisodes,
  parseCoworldDatasetExporterOptions,
  parseCoworldEvaluationDocument,
  writeCoworldEvaluationDatasetFile,
} from "../../src/scripts/coworld-dataset-export";
import {
  buildCoworldEvaluationDataset,
  type CoworldEvaluationEpisode,
} from "../../src/server/agents/CoworldEvaluationDataset";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "coworld-evaluation-dataset-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function compactShadowCouncil(
  overrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    v: 1,
    o: 7,
    g: 2,
    x: 0,
    h: "h",
    p: 127,
    e: 64,
    j: 8,
    w: "0123456789abcdef",
    r: "fedcba9876543210",
    d: "0123456789abcdef",
    m: -499,
    a: "a",
    s: 1,
    k: 15,
    u: 850,
    ...overrides,
  });
}

function shadowDecisionDocument(
  shadowCouncil: unknown,
): Record<string, unknown> {
  return {
    runID: "shadow-council-run",
    config: { map: "Europe", players: [{ name: "Auri" }] },
    results: { scores: [1], winner_slot: 0 },
    decisions: [
      {
        username: "Auri",
        turnNumber: 400,
        selectedLegalActionId: "attack:rival:40",
        selectedActionKind: "attack",
        reason: "authoritative v16 decision",
        fallbackUsed: false,
        rawLlmOutput: JSON.stringify({
          type: "decision_response",
          requestID: "request-1",
          selectedLegalActionId: "attack:rival:40",
          reason: "authoritative v16 decision",
          shadowCouncil,
        }),
      },
    ],
  };
}

type CouncilCompletionStatus =
  | "complete"
  | "missing"
  | "invalid"
  | "non-production";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

async function artifactSha256(artifactPath: string): Promise<string> {
  const hash = createHash("sha256");
  const stat = await fs.lstat(artifactPath);
  if (stat.isFile()) {
    hash.update(await fs.readFile(artifactPath));
  } else {
    const files: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      for (const entry of entries) {
        const current = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await collect(current);
        } else {
          files.push(current);
        }
      }
    };
    await collect(artifactPath);
    for (const filePath of files) {
      hash.update(
        path.relative(artifactPath, filePath).split(path.sep).join("/"),
      );
      hash.update("\0");
      hash.update(await fs.readFile(filePath));
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

async function writeCouncilPlanFixture(
  input: {
    blocks?: Array<{
      base: CouncilCompletionStatus;
      shadow: CouncilCompletionStatus;
    }>;
    replayDirectory?: boolean;
  } = {},
): Promise<{
  planPath: string;
  matrixID: string;
  blocks: Array<{ blockID: string; pairID: string }>;
  jobs: Array<{ jobID: string; armID: string; completionPath: string }>;
}> {
  const root = await temporaryDirectory();
  const planPath = path.join(root, "plan.json");
  const candidateImage = {
    reference: "candidate:test",
    imageID: `sha256:${"a".repeat(64)}`,
  };
  const gameImage = {
    reference: "game:test",
    imageID: `sha256:${"b".repeat(64)}`,
  };
  const opponentImages = [
    {
      reference: "opponent:test",
      imageID: `sha256:${"c".repeat(64)}`,
    },
  ];
  const arms = [
    {
      armID: "v16",
      kind: "v16",
      base: "v16",
      shadow: false,
      expertMask: 0,
      env: {
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
      },
    },
    {
      armID: "v16-shadow-m15",
      kind: "v16-shadow",
      base: "v16",
      shadow: true,
      expertMask: 15,
      env: {
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "1",
        PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
      },
    },
  ];
  const statuses = input.blocks ?? [{ base: "complete", shadow: "complete" }];
  const materializedManifest = {
    game: { runnable: { image: gameImage.reference } },
  };
  const manifestSha256 = canonicalSha256(materializedManifest);
  const matrixIdentity = {
    contract: "proxywar-coworld-paired-matrix-v3",
    manifestSha256,
    gameImage,
    candidate: {
      reference: candidateImage.reference,
      run: [],
      env: {},
      name: "Auri",
      image: candidateImage,
    },
    opponents: [
      {
        reference: opponentImages[0].reference,
        run: [],
        env: {},
        name: "Opponent",
        image: opponentImages[0],
      },
    ],
    variantIDs: statuses.map((_status, index) => `variant-${index}`),
    candidateSeats: [0],
    seeds: [100],
    arms,
  };
  const matrixID = `matrix-${canonicalSha256(matrixIdentity).slice(7, 39)}`;
  const materializedManifestPath = path.join(root, "payload", "manifest.json");
  await fs.mkdir(path.dirname(materializedManifestPath), { recursive: true });
  await fs.writeFile(
    materializedManifestPath,
    JSON.stringify(materializedManifest),
  );
  const blocks: Array<Record<string, unknown>> = [];
  const jobs: Array<Record<string, unknown>> = [];
  const returnedJobs: Array<{
    jobID: string;
    armID: string;
    completionPath: string;
  }> = [];
  for (const [blockIndex, status] of statuses.entries()) {
    const blockRoster = [
      {
        seat: 0,
        role: "candidate",
        name: "Auri",
        image: candidateImage,
        run: [],
        env: {},
      },
      {
        seat: 1,
        role: "opponent",
        name: "Opponent",
        image: opponentImages[0],
        run: [],
        env: {},
      },
    ];
    const rosterOrderID = `roster-${canonicalSha256(blockRoster).slice(7, 39)}`;
    const variantID = `variant-${blockIndex}`;
    const seed = 100;
    const identityParts = [matrixID, variantID, 0, seed, rosterOrderID];
    const blockID = `block-${canonicalSha256(identityParts).slice(7, 39)}`;
    const pairID = `pair-${canonicalSha256(identityParts).slice(7, 39)}`;
    const armOrder = blockIndex % 2 === 0 ? arms : [arms[1], arms[0]];
    blocks.push({
      blockID,
      pairID,
      blockIndex,
      variantID,
      map: "Europe",
      candidateSeat: 0,
      seed,
      rosterOrderID,
      armOrder: armOrder.map((arm) => arm.armID),
      roster: blockRoster,
    });
    for (const [blockOrder, arm] of armOrder.entries()) {
      const jobID = `${blockID}-${arm.armID}`;
      const jobRoot = path.join(root, "payload", "jobs", jobID);
      await fs.mkdir(jobRoot, { recursive: true });
      const outputDir = path.join(jobRoot, "episode");
      const completionPath = path.join(jobRoot, "completion.json");
      const roster = blockRoster.map((seat) => ({
        ...seat,
        env: seat.role === "candidate" ? { ...seat.env, ...arm.env } : seat.env,
      }));
      const job = {
        jobID,
        matrixID,
        blockID,
        pairID,
        blockOrder,
        pairOrder: blockOrder,
        arm,
        expertMask: arm.expertMask,
        variantID,
        map: "Europe",
        candidateSeat: 0,
        seed,
        rosterOrderID,
        roster,
        requestPath: path.join(jobRoot, "episode_request.json"),
        outputDir,
        completionPath,
        candidateImage,
        gameImage,
        opponentImages,
      };
      jobs.push(job);
      returnedJobs.push({ jobID, armID: arm.armID, completionPath });
      const completionStatus = arm.shadow ? status.shadow : status.base;
      if (completionStatus === "missing") {
        continue;
      }
      await fs.mkdir(outputDir, { recursive: true });
      const scores = arm.shadow ? [0.7, 0.3] : [0, 0];
      const winnerSlot = arm.shadow ? 0 : null;
      const players = [{ name: "Auri" }, { name: "Opponent" }];
      const resultsPath = path.join(outputDir, "results.json");
      const replayPath = path.join(outputDir, "replay");
      await fs.writeFile(
        resultsPath,
        JSON.stringify({ scores, winner_slot: winnerSlot, players }),
      );
      const replay = JSON.stringify({
        runID: `coworld-${blockIndex}-${arm.armID}`,
        config: { map: "Europe", players },
        results: { scores, winner_slot: winnerSlot, players },
      });
      if (input.replayDirectory === true) {
        await fs.mkdir(replayPath);
        await fs.writeFile(path.join(replayPath, "episode.replay"), replay);
        await fs.writeFile(path.join(replayPath, "Z.bin"), "upper");
        await fs.writeFile(path.join(replayPath, "a.bin"), "lower");
      } else {
        await fs.writeFile(replayPath, replay);
      }
      await fs.writeFile(
        completionPath,
        JSON.stringify({
          schemaVersion: 1,
          status: "complete",
          matrixID,
          blockID,
          pairID,
          jobID,
          rosterOrderID,
          arm,
          expertMask: arm.expertMask,
          variantID,
          seed,
          map: "Europe",
          candidateSeat: 0,
          roster,
          candidateImage,
          gameImage,
          opponentImages,
          resultsPath,
          replayPath,
          resultsSha256:
            completionStatus === "invalid"
              ? `sha256:${"0".repeat(64)}`
              : await artifactSha256(resultsPath),
          replaySha256: await artifactSha256(replayPath),
          validation:
            completionStatus === "non-production"
              ? {
                  coworldVersion: "0.1.30",
                  episodeRunner: "injected",
                  resultsValidator: "injected",
                  replayValidator: "injected-unverified",
                }
              : {
                  coworldVersion: "0.1.30",
                  episodeRunner: "pinned-coworld-cli",
                  resultsValidator: "pinned-coworld-results-schema",
                  replayValidator: "pinned-coworld-verify-replay",
                },
        }),
      );
    }
  }
  await fs.writeFile(
    planPath,
    JSON.stringify({
      schemaVersion: 3,
      coworldVersion: "0.1.30",
      generatedAt: "2026-07-14T12:00:00.000Z",
      matrixID,
      matrixIdentity,
      manifestSha256,
      manifestPath: path.join(root, "source-manifest.json"),
      planPath,
      materializedManifestPath,
      candidateImage,
      gameImage,
      opponentImages,
      arms,
      blocks,
      jobs,
    }),
  );
  return {
    planPath,
    matrixID,
    blocks: blocks.map((block) => ({
      blockID: String(block.blockID),
      pairID: String(block.pairID),
    })),
    jobs: returnedJobs,
  };
}

function normalizedEpisode(): CoworldEvaluationEpisode {
  return {
    episodeId: "ereq_repeated",
    sourcePaths: ["/artifacts/ereq_repeated.replay"],
    runID: "run_repeated",
    platformCompletedAt: "2026-07-14T12:00:30Z",
    runtimeCompletedAt: "2026-07-14T12:00:00Z",
    map: "Europe",
    mapSize: "Compact",
    scores: [0.4, 0.2, 0.4],
    outrightWinnerSlot: null,
    roster: [
      {
        seat: 0,
        policyVersionId: "candidate:v1",
        playerName: "Candidate A",
        label: "Candidate",
        agentID: "agent-0",
      },
      {
        seat: 1,
        policyVersionId: "opponent:v2",
        playerName: "Opponent",
        label: "Opponent",
        agentID: "agent-1",
      },
      {
        seat: 2,
        policyVersionId: "candidate:v1",
        playerName: "Candidate B",
        label: "Candidate",
        agentID: "agent-2",
      },
    ],
    decisions: [
      {
        seat: 0,
        playerName: "Candidate A",
        agentID: "agent-0",
        turnNumber: 0,
        selectedLegalActionId: "spawn:10",
        actionKind: "spawn",
        attackTargetType: null,
        reason: "deterministic built-in-style spawn exploration",
        selectedActionMetadata: { tile: 10, opportunityScore: 1.1 },
        fallback: false,
        degraded: false,
        parseFailure: false,
        wireDroppedFollowupCount: 0,
        multiAction: false,
        commanderTelemetry: {},
        explicitTreatmentMarkers: [],
        searchableText: "spawn exploration",
      },
      {
        seat: 0,
        playerName: "Candidate A",
        agentID: "agent-0",
        turnNumber: 100,
        selectedLegalActionId: "spawn:20",
        actionKind: "spawn",
        attackTargetType: null,
        reason: "deterministic built-in-style spawn exploration",
        selectedActionMetadata: { tile: 20, opportunityScore: 1.2 },
        fallback: false,
        degraded: false,
        parseFailure: false,
        wireDroppedFollowupCount: 0,
        multiAction: false,
        commanderTelemetry: {},
        explicitTreatmentMarkers: [],
        searchableText: "spawn exploration",
      },
      {
        seat: 0,
        playerName: "Candidate A",
        agentID: "agent-0",
        turnNumber: 200,
        selectedLegalActionId: "spawn:30",
        actionKind: "spawn",
        attackTargetType: null,
        reason: "deterministic built-in-style spawn exploration",
        selectedActionMetadata: { tile: 30, opportunityScore: 1.3 },
        fallback: false,
        degraded: false,
        parseFailure: false,
        wireDroppedFollowupCount: 0,
        multiAction: false,
        commanderTelemetry: {},
        explicitTreatmentMarkers: [],
        searchableText: "spawn exploration",
      },
      {
        seat: 0,
        playerName: "Candidate A",
        agentID: "agent-0",
        turnNumber: 400,
        selectedLegalActionId: "attack:rival:40",
        actionKind: "attack",
        attackTargetType: "hostile",
        reason: "treatment path",
        selectedActionMetadata: {},
        fallback: true,
        degraded: true,
        parseFailure: false,
        wireDroppedFollowupCount: 3,
        multiAction: true,
        commanderTelemetry: {
          commanderAttempted: true,
          commanderHealthy: false,
          commanderPlanAge: 4,
        },
        explicitTreatmentMarkers: ["high_pressure"],
        searchableText: "opening-land-race treatment path",
      },
      {
        seat: 2,
        playerName: "Candidate B",
        agentID: "agent-2",
        turnNumber: 400,
        selectedLegalActionId: "hold",
        actionKind: "hold",
        attackTargetType: null,
        reason: "parse fallback",
        selectedActionMetadata: {},
        fallback: true,
        degraded: false,
        parseFailure: true,
        wireDroppedFollowupCount: 0,
        multiAction: false,
        commanderTelemetry: {},
        explicitTreatmentMarkers: [],
        searchableText: "parse fallback",
      },
    ],
    snapshots: [
      {
        label: "active start",
        turnNumber: 400,
        tick: 400,
        phase: "active",
        players: [
          {
            seat: 0,
            playerName: "Candidate A",
            agentID: "agent-0",
            tilesOwned: 100,
            troops: 25_000,
            gold: "1000",
            isAlive: true,
            hasSpawned: true,
          },
        ],
      },
      {
        label: "active end",
        turnNumber: 1_000,
        tick: 1_000,
        phase: "active",
        players: [
          {
            seat: 0,
            playerName: "Candidate A",
            agentID: "agent-0",
            tilesOwned: 500,
            troops: 75_000,
            gold: "5000",
            isAlive: true,
            hasSpawned: true,
          },
        ],
      },
    ],
    episodeReportedTelemetry: {
      result: {
        decisionCount: 5,
        fallbackCount: 2,
        degradedCount: 1,
        parseFailureCount: 1,
      },
      summary: {
        decisionCount: 5,
        fallbackCount: 2,
        degradedCount: 1,
        parseFailureCount: 1,
      },
    },
  };
}

describe("Coworld evaluation dataset", () => {
  test("emits one row per repeated matching policy seat with auditable telemetry", () => {
    const dataset = buildCoworldEvaluationDataset({
      episodes: [normalizedEpisode()],
      selector: {
        seat: null,
        policyVersionId: "candidate:v1",
        playerName: null,
      },
      treatmentMarkers: [{ id: "land_race", needle: "opening-land-race" }],
      spawnPhaseTurns: 300,
      spawnSettleThreshold: 0.8,
    });

    expect(dataset.rows.map((row) => row.seat)).toEqual([0, 2]);
    expect(dataset.aggregate).toMatchObject({
      episodes: 1,
      rows: 2,
      commissionerTopScoreWins: 2,
      commissionerTopScoreWinRate: 1,
      scoreShareMean: 0.4,
      rowsWithDecisionTelemetry: 2,
      decisionCount: 5,
      fallbackCount: 2,
      degradedCount: 1,
      parseFailureCount: 1,
      wireDroppedFollowupCount: 3,
      multiActionDecisionCount: 1,
      treatmentExposedRows: 1,
    });
    expect(dataset.rows[0].telemetry.actionMix).toEqual({
      attack: 1,
      spawn: 3,
    });
    expect(dataset.rows[0].telemetry.attackTargetMix).toEqual({ hostile: 1 });
    expect(dataset.rows[0].telemetry.commanderTelemetry).toMatchObject({
      available: true,
      decisionsWithTelemetry: 1,
      fields: {
        commanderAttempted: { trueCount: 1 },
        commanderHealthy: { falseCount: 1 },
        commanderPlanAge: { numericMean: 4, numericSamples: 1 },
      },
    });
    expect(dataset.rows[1].telemetry.commanderTelemetry).toEqual({
      available: false,
      decisionsWithTelemetry: 0,
      fields: {},
    });
    expect(dataset.rows[0].telemetry.treatmentMarkerCounts).toEqual({
      high_pressure: 1,
      land_race: 1,
    });
    expect(dataset.rows[0].spawnDiagnostics).toMatchObject({
      selectionTurns: [0, 100, 200],
      distinctSelectedTiles: 3,
      lastSpawnProgress: 2 / 3,
      settleThresholdReached: false,
      lastSpawnHasExplicitSettleMarker: false,
    });
    expect(dataset.rows[0].phaseSnapshots).toHaveLength(2);
    expect(dataset.rows[0].opponents).toHaveLength(2);
  });

  test("expands bounded shadow-council diagnostics without treating them as authority", () => {
    const fragment = parseCoworldEvaluationDocument({
      value: shadowDecisionDocument(compactShadowCouncil()),
      sourcePath: "/artifacts/shadow-council.replay",
      fallbackId: "shadow-council",
    })[0];

    expect(fragment.decisions[0]).toMatchObject({
      decisionResponseAvailable: true,
      shadowCouncil: {
        version: 1,
        ordinal: 7,
        resetOrdinal: 2,
        reset: false,
        health: "healthy",
        proposalMask: 127,
        errorMask: 64,
        rejectionMask: 8,
        diagnosticWinnerFingerprint: "0123456789abcdef",
        runnerUpFingerprint: "fedcba9876543210",
        authoritativeFingerprint: "0123456789abcdef",
        bidMarginBP: -499,
        agreement: "agree",
        diagnosticWinnerSource: "expansion",
        diagnosticWinnerTier: "expert_auction",
        enabledExpertMask: 15,
        elapsedUs: 850,
      },
    });

    const episode: CoworldEvaluationEpisode = {
      episodeId: fragment.episodeId,
      sourcePaths: fragment.sourcePaths,
      runID: fragment.runID ?? null,
      platformCompletedAt: fragment.platformCompletedAt ?? null,
      runtimeCompletedAt: fragment.runtimeCompletedAt ?? null,
      map: fragment.map ?? "Unknown map",
      mapSize: fragment.mapSize ?? null,
      scores: fragment.scores ?? [],
      outrightWinnerSlot: fragment.outrightWinnerSlot ?? null,
      roster: fragment.roster,
      decisions: fragment.decisions,
      snapshots: fragment.snapshots,
      episodeReportedTelemetry: {
        result: {
          decisionCount: null,
          fallbackCount: null,
          degradedCount: null,
          parseFailureCount: null,
        },
        summary: {
          decisionCount: null,
          fallbackCount: null,
          degradedCount: null,
          parseFailureCount: null,
        },
      },
    };
    const dataset = buildCoworldEvaluationDataset({
      episodes: [episode],
      selector: { seat: 0, policyVersionId: null, playerName: null },
    });

    expect(dataset.schemaVersion).toBe(4);
    expect(dataset.rows[0].telemetry.shadowCouncil).toEqual({
      available: true,
      decisionResponseSampleCount: 1,
      validTelemetryDecisionCount: 1,
      diagnosticWinnerDecisionCount: 1,
      counterfactualAgreementDecisionCount: 1,
      proposalMaskUnion: 127,
      errorMaskUnion: 64,
      rejectionMaskUnion: 8,
      enabledExpertMaskUnion: 15,
      sourceCounts: { expansion: 1 },
      tierCounts: { expert_auction: 1 },
      healthCounts: { healthy: 1 },
      agreementCounts: { agree: 1 },
    });
    expect(dataset.rows[0].telemetry.shadowCouncil).not.toHaveProperty(
      "actualExposure",
    );
  });

  test.each([
    ["non-string", { v: 1 }],
    ["over byte budget", "x".repeat(301)],
    ["malformed JSON", "{"],
    ["extra key", compactShadowCouncil({ q: 0 })],
    [
      "missing key",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(JSON.parse(compactShadowCouncil())).filter(
            ([key]) => key !== "u",
          ),
        ),
      ),
    ],
    ["wrong version", compactShadowCouncil({ v: 2 })],
    ["unsafe ordinal", compactShadowCouncil({ o: 9_007_199_254_740_992 })],
    ["invalid reset", compactShadowCouncil({ x: 2 })],
    ["invalid health", compactShadowCouncil({ h: "healthy" })],
    ["proposal mask overflow", compactShadowCouncil({ p: 128 })],
    ["proposal mask fraction", compactShadowCouncil({ p: 64.5 })],
    ["error mask overflow", compactShadowCouncil({ e: 128 })],
    ["error mask fraction", compactShadowCouncil({ e: 64.5 })],
    ["rejection mask overflow", compactShadowCouncil({ j: 2_048 })],
    ["invalid fingerprint", compactShadowCouncil({ w: "ABCDEF" })],
    ["margin below floor", compactShadowCouncil({ m: -20_001 })],
    ["margin above ceiling", compactShadowCouncil({ m: 20_001 })],
    ["margin fraction", compactShadowCouncil({ m: -499.5 })],
    ["invalid agreement", compactShadowCouncil({ a: "agree" })],
    ["invalid source", compactShadowCouncil({ s: 9 })],
    ["enabled mask overflow", compactShadowCouncil({ k: 16 })],
    ["negative elapsed time", compactShadowCouncil({ u: -1 })],
  ])("rejects %s in compact shadow-council telemetry", (_label, compact) => {
    expect(() =>
      parseCoworldEvaluationDocument({
        value: shadowDecisionDocument(compact),
        sourcePath: "/artifacts/invalid-shadow-council.replay",
        fallbackId: "invalid-shadow-council",
      }),
    ).toThrow(/shadowCouncil/);
  });

  test.each([null, -20_000, 20_000])(
    "accepts bounded compact shadow margin %s",
    (margin) => {
      const fragment = parseCoworldEvaluationDocument({
        value: shadowDecisionDocument(compactShadowCouncil({ m: margin })),
        sourcePath: "/artifacts/bounded-shadow-council.replay",
        fallbackId: "bounded-shadow-council",
      })[0];
      expect(fragment.decisions[0]?.shadowCouncil?.bidMarginBP).toBe(margin);
    },
  );

  test("joins a schemaVersion 3 council plan without claiming shadow authority", async () => {
    const fixture = await writeCouncilPlanFixture();
    const loaded = await loadCoworldEvaluationEpisodes([], [fixture.planPath]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
      councilEvaluationPlan: loaded.councilEvaluationPlan,
    });

    expect(dataset.rows).toHaveLength(2);
    expect(dataset.rows.map((row) => row.councilEvaluation)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matrixID: fixture.matrixID,
          blockID: fixture.blocks[0].blockID,
          pairID: fixture.blocks[0].pairID,
          arm: expect.objectContaining({ armID: "v16", shadow: false }),
          intentionToTreat: false,
          actualTreatmentExposure: false,
          expertMask: 0,
          seed: 100,
          map: "Europe",
          candidateSeat: 0,
          candidateImageID: `sha256:${"a".repeat(64)}`,
          gameImageID: `sha256:${"b".repeat(64)}`,
          opponentImageIDs: [`sha256:${"c".repeat(64)}`],
        }),
        expect.objectContaining({
          arm: expect.objectContaining({
            armID: "v16-shadow-m15",
            shadow: true,
          }),
          intentionToTreat: true,
          actualTreatmentExposure: false,
          expertMask: 15,
        }),
      ]),
    );
    expect(dataset.councilEvaluation).toMatchObject({
      available: true,
      planPaths: [fixture.planPath],
      matrixIDs: [fixture.matrixID],
      plannedBlockCount: 1,
      plannedJobCount: 2,
      joinedJobCount: 2,
      completeBlockIDs: [fixture.blocks[0].blockID],
      missingJobIDs: [],
      invalidJobIDs: [],
      unjoinedJobIDs: [],
      missingBlockIDs: [],
      invalidBlockIDs: [],
      incompleteBlockIDs: [],
      intentionToTreatJobIDs: [`${fixture.blocks[0].blockID}-v16-shadow-m15`],
      actualTreatmentExposureJobIDs: [],
    });
    const baseTie = dataset.councilEvaluation.tieAudits.find(
      (audit) => audit.armID === "v16",
    );
    expect(baseTie).toMatchObject({
      topScoreSlots: [0, 1],
      topScoreMultiplicity: 2,
      tiedTopScore: true,
      soleTopScoreWin: false,
      positiveTopScore: false,
      allZeroTie: true,
      commissionerTopScoreWin: true,
      outrightWin: false,
      outcome: "shared-top-score",
    });
    expect(dataset.councilEvaluation.pairedShadowOverheadDeltas).toEqual([
      expect.objectContaining({
        comparisonKind: "descriptive-shadow-overhead",
        blockID: fixture.blocks[0].blockID,
        baseArmID: "v16",
        treatmentArmID: "v16-shadow-m15",
        expertMask: 15,
        baseTiedTopScore: true,
        treatmentTiedTopScore: false,
        scoreShareDelta: 0.7,
        commissionerTopScoreWinDelta: 0,
        outrightWinDelta: 1,
      }),
    ]);
  });

  test("accepts producer-compatible replay directory hashes", async () => {
    const fixture = await writeCouncilPlanFixture({ replayDirectory: true });
    const loaded = await loadCoworldEvaluationEpisodes([], [fixture.planPath]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
      councilEvaluationPlan: loaded.councilEvaluationPlan,
    });

    expect(dataset.rows).toHaveLength(2);
    expect(dataset.councilEvaluation).toMatchObject({
      joinedJobCount: 2,
      completeBlockIDs: [fixture.blocks[0].blockID],
      invalidJobIDs: [],
    });
  });

  test("audits missing, invalid, and incomplete council blocks separately", async () => {
    const fixture = await writeCouncilPlanFixture({
      blocks: [
        { base: "missing", shadow: "missing" },
        { base: "complete", shadow: "invalid" },
      ],
    });
    const loaded = await loadCoworldEvaluationEpisodes([], [fixture.planPath]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
      councilEvaluationPlan: loaded.councilEvaluationPlan,
    });

    expect(dataset.councilEvaluation).toMatchObject({
      plannedBlockCount: 2,
      plannedJobCount: 4,
      joinedJobCount: 1,
      completeBlockIDs: [],
      missingBlockIDs: [fixture.blocks[0].blockID],
      invalidBlockIDs: [fixture.blocks[1].blockID],
      incompleteBlockIDs: [
        fixture.blocks[0].blockID,
        fixture.blocks[1].blockID,
      ].sort(),
      missingJobIDs: expect.arrayContaining([
        `${fixture.blocks[0].blockID}-v16`,
        `${fixture.blocks[0].blockID}-v16-shadow-m15`,
      ]),
      invalidJobIDs: [`${fixture.blocks[1].blockID}-v16-shadow-m15`],
      pairedShadowOverheadDeltas: [],
    });
  });

  test("rejects a council plan whose jobs are reordered", async () => {
    const fixture = await writeCouncilPlanFixture();
    const plan = JSON.parse(await fs.readFile(fixture.planPath, "utf8")) as {
      jobs: unknown[];
    };
    plan.jobs.reverse();
    await fs.writeFile(fixture.planPath, JSON.stringify(plan));

    await expect(
      loadCoworldEvaluationEpisodes([], [fixture.planPath]),
    ).rejects.toThrow("exact block/arm order");
  });

  test("recomputes matrix identity instead of trusting a claimed matrixID", async () => {
    const fixture = await writeCouncilPlanFixture();
    const plan = JSON.parse(await fs.readFile(fixture.planPath, "utf8")) as {
      matrixIdentity: { seeds: number[] };
    };
    plan.matrixIdentity.seeds = [101];
    await fs.writeFile(fixture.planPath, JSON.stringify(plan));

    await expect(
      loadCoworldEvaluationEpisodes([], [fixture.planPath]),
    ).rejects.toThrow("matrixID or matrix identity is inconsistent");
  });

  test("bounds matrix axes before materializing their Cartesian product", async () => {
    const fixture = await writeCouncilPlanFixture();
    const plan = JSON.parse(await fs.readFile(fixture.planPath, "utf8")) as {
      matrixID: string;
      matrixIdentity: {
        variantIDs: string[];
        candidateSeats: number[];
        seeds: number[];
      };
    };
    plan.matrixIdentity.variantIDs = Array.from(
      { length: 500 },
      (_value, index) => `variant-${index}`,
    );
    plan.matrixIdentity.candidateSeats = [0, 1];
    plan.matrixIdentity.seeds = Array.from(
      { length: 500 },
      (_value, index) => index,
    );
    plan.matrixID = `matrix-${canonicalSha256(plan.matrixIdentity).slice(7, 39)}`;
    await fs.writeFile(fixture.planPath, JSON.stringify(plan));

    await expect(
      loadCoworldEvaluationEpisodes([], [fixture.planPath]),
    ).rejects.toThrow("matrix axes do not match the bounded block count");
  });

  test("rejects a materialized manifest that no longer matches its plan hash", async () => {
    const fixture = await writeCouncilPlanFixture();
    const plan = JSON.parse(await fs.readFile(fixture.planPath, "utf8")) as {
      materializedManifestPath: string;
    };
    await fs.writeFile(
      plan.materializedManifestPath,
      JSON.stringify({ game: { runnable: { image: "game:tampered" } } }),
    );

    await expect(
      loadCoworldEvaluationEpisodes([], [fixture.planPath]),
    ).rejects.toThrow("materialized manifest hash is invalid");
  });

  test("audits injected completion validation as non-production evidence", async () => {
    const fixture = await writeCouncilPlanFixture({
      blocks: [{ base: "complete", shadow: "non-production" }],
    });
    const loaded = await loadCoworldEvaluationEpisodes([], [fixture.planPath]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
      councilEvaluationPlan: loaded.councilEvaluationPlan,
    });
    const shadowJobID = `${fixture.blocks[0].blockID}-v16-shadow-m15`;

    expect(dataset.rows).toHaveLength(1);
    expect(dataset.councilEvaluation).toMatchObject({
      joinedJobCount: 1,
      completeBlockIDs: [],
      invalidJobIDs: [shadowJobID],
      invalidBlockIDs: [fixture.blocks[0].blockID],
      incompleteBlockIDs: [fixture.blocks[0].blockID],
      pairedShadowOverheadDeltas: [],
      invalidJobs: [
        {
          jobID: shadowJobID,
          blockID: fixture.blocks[0].blockID,
          reason: expect.stringContaining("non-production evidence"),
        },
      ],
    });
  });

  test("rejects a hash-matching artifact symlink", async () => {
    const fixture = await writeCouncilPlanFixture();
    const baseJob = fixture.jobs.find((job) => job.armID === "v16")!;
    const completion = JSON.parse(
      await fs.readFile(baseJob.completionPath, "utf8"),
    ) as { resultsPath: string };
    const original = await fs.readFile(completion.resultsPath);
    const outside = path.join(await temporaryDirectory(), "results.json");
    await fs.writeFile(outside, original);
    await fs.rm(completion.resultsPath);
    await fs.symlink(outside, completion.resultsPath);

    const loaded = await loadCoworldEvaluationEpisodes([], [fixture.planPath]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
      councilEvaluationPlan: loaded.councilEvaluationPlan,
    });

    expect(dataset.councilEvaluation.invalidJobs).toEqual([
      expect.objectContaining({
        jobID: baseJob.jobID,
        reason: expect.stringContaining("not a regular file"),
      }),
    ]);
  });

  test("rejects a symlinked job root outside the materialized plan tree", async () => {
    const fixture = await writeCouncilPlanFixture();
    const jobRoot = path.dirname(fixture.jobs[0].completionPath);
    const relocatedRoot = path.join(
      await temporaryDirectory(),
      path.basename(jobRoot),
    );
    await fs.rename(jobRoot, relocatedRoot);
    await fs.symlink(relocatedRoot, jobRoot, "dir");

    await expect(
      loadCoworldEvaluationEpisodes([], [fixture.planPath]),
    ).rejects.toThrow("root must be a real directory");
  });

  test("aligns score pairs when the same policy ID occupies repeated seats", () => {
    const fragments = parseCoworldEvaluationDocument({
      sourcePath: "/artifacts/episodes.json",
      fallbackId: "saved",
      value: {
        entries: [
          {
            id: "ereq_pairs",
            policy_version_ids: ["repeat:v1", "other:v1", "repeat:v1"],
            game_config: { map: "Asia" },
            scores: [
              { policy_version_id: "repeat:v1", score: 0.55 },
              { policy_version_id: "other:v1", score: 0.1 },
              { policy_version_id: "repeat:v1", score: 0.35 },
            ],
          },
        ],
      },
    });

    expect(fragments).toHaveLength(1);
    expect(fragments[0].scores).toEqual([0.55, 0.1, 0.35]);
    expect(fragments[0].roster.map((entry) => entry.policyVersionId)).toEqual([
      "repeat:v1",
      "other:v1",
      "repeat:v1",
    ]);
  });

  test("merges hosted metadata with replay telemetry from a mixed directory", async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(
      path.join(directory, "episodes.json"),
      JSON.stringify({
        episodes: [
          {
            id: "ereq_merge",
            completed_at: "2026-07-14T12:34:24.817967Z",
            game_config: { map: "Pangaea", map_size: "Compact" },
            policy_version_ids: ["opponent:v1", "candidate:v16"],
            participants: [
              {
                position: 0,
                player_name: "Opponent",
                policy_version_id: "opponent:v1",
                label: "Opponent v1",
              },
              {
                position: 1,
                player_name: "Auri",
                policy_version_id: "candidate:v16",
                label: "Keystone v16",
              },
            ],
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(directory, "ereq_merge.replay"),
      JSON.stringify({
        runID: "run_merge",
        config: {
          map: "Pangaea",
          map_size: "Compact",
          players: [{ name: "Opponent" }, { name: "Auri" }],
        },
        results: {
          scores: [0.7, 0.3],
          winner_slot: null,
          decision_count: 347,
          fallback_count: 94,
          degraded_count: 94,
          players: [
            { slot: 0, name: "Opponent" },
            { slot: 1, name: "Auri" },
          ],
        },
        inlineRunArtifacts: {
          "match-summary.json": JSON.stringify({
            completedAt: "2026-07-14T12:33:57.516Z",
            parseFailureCount: 0,
          }),
          "decisions.jsonl": [
            JSON.stringify({
              username: "Auri",
              agentID: "agent-1",
              turnNumber: 200,
              selectedLegalActionId: "spawn:42",
              selectedActionKind: "spawn",
              selectedActionMetadata: { tile: 42 },
              reason: "deterministic built-in-style spawn exploration",
              fallbackUsed: false,
            }),
            JSON.stringify({
              username: "Auri",
              agentID: "agent-1",
              turnNumber: 400,
              selectedLegalActionId: "attack:rival:40",
              selectedActionKind: "attack",
              selectedActionMetadata: { targetID: "rival" },
              batchActionIDs: ["attack:rival:40"],
              reason:
                "scheduler queued 4 action(s) [wire carries primary only; 3 batched follow-up(s) not executed]",
              fallbackUsed: true,
              parseSuccess: true,
              commanderAttempted: false,
              rawLlmOutput: JSON.stringify({
                llmPlannerDegraded: true,
                commanderAttempted: true,
                commanderTelemetry: {
                  v: 1,
                  attempts: 2,
                  completions: 1,
                  healthy: false,
                  fallback: true,
                  parseFailure: 0,
                  rejected: 0,
                  coalesced: 2,
                  delivered: 1,
                  inFlight: false,
                  lastOutcome: "timeout",
                  planTurn: 400,
                  planAge: 3,
                  stale: true,
                },
              }),
            }),
          ].join("\n"),
        },
        spectatorReplay: {
          roster: [
            { agentID: "agent-0", username: "Opponent" },
            { agentID: "agent-1", username: "Auri" },
          ],
          snapshots: [
            {
              label: "After spawn",
              turnNumber: 400,
              tick: 400,
              phase: "active",
              players: [
                { agentID: "agent-0", username: "Opponent", tilesOwned: 200 },
                { agentID: "agent-1", username: "Auri", tilesOwned: 100 },
              ],
            },
          ],
        },
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([directory]);
    expect(loaded.episodes).toHaveLength(1);
    expect(loaded.episodes[0]).toMatchObject({
      episodeId: "ereq_merge",
      map: "Pangaea",
      scores: [0.7, 0.3],
      outrightWinnerSlot: null,
      platformCompletedAt: "2026-07-14T12:34:24.817967Z",
      runtimeCompletedAt: "2026-07-14T12:33:57.516Z",
    });
    expect(loaded.episodes[0].sourcePaths).toHaveLength(2);
    expect(loaded.episodes[0].roster[1]).toMatchObject({
      policyVersionId: "candidate:v16",
      playerName: "Auri",
      label: "Keystone v16",
      agentID: "agent-1",
    });
    expect(loaded.episodes[0].decisions[1]).toMatchObject({
      seat: 1,
      degraded: true,
      fallback: true,
      wireDroppedFollowupCount: 3,
      multiAction: true,
      attackTargetType: "hostile",
      commanderTelemetry: {
        attempts: 2,
        coalesced: 2,
        completions: 1,
        commanderAttempted: false,
        delivered: 1,
        fallback: true,
        healthy: false,
        inFlight: false,
        lastOutcome: "timeout",
        parseFailure: 0,
        planAge: 3,
        planTurn: 400,
        rejected: 0,
        stale: true,
        v: 1,
      },
    });
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 1, policyVersionId: null, playerName: null },
    });
    expect(dataset.rows[0]).toMatchObject({
      platformCompletedAt: "2026-07-14T12:34:24.817967Z",
      runtimeCompletedAt: "2026-07-14T12:33:57.516Z",
    });
  });

  test("prefers a complete local replay over its sibling results file", async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(
      path.join(directory, "plan.json"),
      JSON.stringify({ unrelated: "legacy artifact plan" }),
    );
    await fs.writeFile(
      path.join(directory, "results.json"),
      JSON.stringify({ scores: [1, 0], winner_slot: 0 }),
    );
    await fs.writeFile(
      path.join(directory, "replay"),
      JSON.stringify({
        runID: "local-run",
        config: { map: "Europe", players: [{ name: "A" }, { name: "B" }] },
        results: { scores: [1, 0], winner_slot: 0 },
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([directory]);
    expect(loaded.episodes).toHaveLength(1);
    expect(loaded.episodes[0].sourcePaths).toEqual([
      path.join(directory, "replay"),
    ]);
    expect(loaded.councilEvaluationPlan).toBeUndefined();
  });

  test("keeps sibling control and treatment episode bundles distinct", async () => {
    const directory = await temporaryDirectory();
    const writeEpisodeBundle = async (input: {
      arm: "control" | "treatment";
      runID: string;
      scores: [number, number];
    }): Promise<string> => {
      const episodeRoot = path.join(directory, input.arm, "episode");
      const runRoot = path.join(episodeRoot, "proxywar-runs", input.runID);
      await fs.mkdir(runRoot, { recursive: true });
      const players = [{ name: "Auri" }, { name: "Opponent" }];
      await fs.writeFile(
        path.join(episodeRoot, "results.json"),
        JSON.stringify({
          scores: input.scores,
          winner_slot: null,
          players,
        }),
      );
      await fs.writeFile(
        path.join(episodeRoot, "replay"),
        JSON.stringify({
          runID: input.runID,
          config: { map: "Asia", players },
          results: {
            scores: input.scores,
            winner_slot: null,
            players,
          },
        }),
      );
      await fs.writeFile(
        path.join(runRoot, "match-summary.json"),
        JSON.stringify({
          scenario: "coworld",
          runID: input.runID,
          completedAt: `2026-07-14T12:00:0${input.arm === "control" ? "1" : "2"}Z`,
          runnerConfig: { map: "Asia" },
          roster: [{ username: "Auri" }, { username: "Opponent" }],
        }),
      );
      await fs.writeFile(
        path.join(runRoot, "spectator-replay.json"),
        JSON.stringify({
          roster: [{ username: "Auri" }, { username: "Opponent" }],
          snapshots: [],
        }),
      );
      return episodeRoot;
    };
    const controlRoot = await writeEpisodeBundle({
      arm: "control",
      runID: "coworld-control-run",
      scores: [0.7, 0.3],
    });
    const treatmentRoot = await writeEpisodeBundle({
      arm: "treatment",
      runID: "coworld-treatment-run",
      scores: [0.8, 0.2],
    });

    const loaded = await loadCoworldEvaluationEpisodes([
      controlRoot,
      treatmentRoot,
    ]);
    expect(loaded.episodes.map((episode) => episode.episodeId)).toEqual([
      "coworld-control-run",
      "coworld-treatment-run",
    ]);
    expect(loaded.episodes.map((episode) => episode.runID)).toEqual([
      "coworld-control-run",
      "coworld-treatment-run",
    ]);
    expect(
      loaded.episodes.map((episode) => episode.sourcePaths.length),
    ).toEqual([3, 3]);

    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: null, policyVersionId: null, playerName: "Auri" },
    });
    expect(dataset.rows.map((row) => row.rowId)).toEqual([
      "coworld-control-run:seat:0",
      "coworld-treatment-run:seat:0",
    ]);
    expect(new Set(dataset.rows.map((row) => row.rowId)).size).toBe(2);
    expect(dataset.aggregate).toMatchObject({ episodes: 2, rows: 2 });
  });

  test("uses a stable source-root identity when a bundle has no run ID", async () => {
    const directory = await temporaryDirectory();
    const roots = await Promise.all(
      ["control", "treatment"].map(async (arm) => {
        const episodeRoot = path.join(directory, arm, "episode");
        await fs.mkdir(episodeRoot, { recursive: true });
        await fs.writeFile(
          path.join(episodeRoot, "results.json"),
          JSON.stringify({
            scores: [1, 0],
            winner_slot: 0,
            players: [{ name: "Auri" }, { name: "Opponent" }],
          }),
        );
        await fs.writeFile(
          path.join(episodeRoot, "match-summary.json"),
          JSON.stringify({
            scenario: "coworld",
            completedAt: "2026-07-14T12:00:00Z",
            runnerConfig: { map: "Asia" },
            roster: [{ username: "Auri" }, { username: "Opponent" }],
          }),
        );
        return episodeRoot;
      }),
    );

    const first = await loadCoworldEvaluationEpisodes(roots);
    const second = await loadCoworldEvaluationEpisodes([...roots].reverse());
    const firstIds = first.episodes.map((episode) => episode.episodeId);
    expect(firstIds).toHaveLength(2);
    expect(new Set(firstIds).size).toBe(2);
    expect(firstIds).toEqual(
      second.episodes.map((episode) => episode.episodeId),
    );
    expect(firstIds).toEqual([
      expect.stringMatching(/^source_episode_[a-f0-9]{64}$/),
      expect.stringMatching(/^source_episode_[a-f0-9]{64}$/),
    ]);
    expect(first.episodes.map((episode) => episode.sourcePaths.length)).toEqual(
      [2, 2],
    );
  });

  test.each(["replay", "results.json", "match-summary.json"] as const)(
    "canonicalizes a direct %s file symlink before deriving fallback identity",
    async (artifactName) => {
      const directory = await temporaryDirectory();
      const episodeRoot = path.join(directory, "canonical", "episode");
      const aliasRoot = path.join(directory, "alias");
      await fs.mkdir(episodeRoot, { recursive: true });
      await fs.mkdir(aliasRoot, { recursive: true });
      const players = [{ name: "Auri" }, { name: "Opponent" }];
      const results = {
        scores: [1, 0],
        winner_slot: 0,
        players,
      };
      const canonicalArtifact = path.join(episodeRoot, artifactName);
      if (artifactName === "replay") {
        await fs.writeFile(
          canonicalArtifact,
          JSON.stringify({ config: { map: "Asia", players }, results }),
        );
      } else if (artifactName === "results.json") {
        await fs.writeFile(canonicalArtifact, JSON.stringify(results));
      } else {
        await fs.writeFile(
          path.join(episodeRoot, "results.json"),
          JSON.stringify(results),
        );
        await fs.writeFile(
          canonicalArtifact,
          JSON.stringify({
            scenario: "coworld",
            completedAt: "2026-07-14T12:00:00Z",
            runnerConfig: { map: "Asia" },
            roster: [{ username: "Auri" }, { username: "Opponent" }],
          }),
        );
      }
      const aliasArtifact = path.join(aliasRoot, artifactName);
      await fs.symlink(canonicalArtifact, aliasArtifact);
      const supportingInputs =
        artifactName === "match-summary.json"
          ? [path.join(episodeRoot, "results.json")]
          : [];

      const canonical = await loadCoworldEvaluationEpisodes([
        ...supportingInputs,
        canonicalArtifact,
      ]);
      const aliased = await loadCoworldEvaluationEpisodes([
        ...supportingInputs,
        aliasArtifact,
      ]);
      const combined = await loadCoworldEvaluationEpisodes([
        ...supportingInputs,
        canonicalArtifact,
        aliasArtifact,
      ]);

      expect(aliased.episodes.map((episode) => episode.episodeId)).toEqual(
        canonical.episodes.map((episode) => episode.episodeId),
      );
      expect(combined.episodes).toHaveLength(1);
      expect(combined.episodes[0].episodeId).toBe(
        canonical.episodes[0].episodeId,
      );
      expect(combined.episodes[0].sourcePaths).toHaveLength(
        artifactName === "match-summary.json" ? 3 : 2,
      );
    },
  );

  test("keeps directory-symlink fallback identity canonical", async () => {
    const directory = await temporaryDirectory();
    const episodeRoot = path.join(directory, "canonical", "episode");
    const aliasRoot = path.join(directory, "episode-alias");
    await fs.mkdir(episodeRoot, { recursive: true });
    await fs.writeFile(
      path.join(episodeRoot, "results.json"),
      JSON.stringify({
        scores: [1, 0],
        winner_slot: 0,
        players: [{ name: "Auri" }, { name: "Opponent" }],
      }),
    );
    await fs.symlink(episodeRoot, aliasRoot, "dir");

    const canonical = await loadCoworldEvaluationEpisodes([episodeRoot]);
    const aliased = await loadCoworldEvaluationEpisodes([aliasRoot]);
    expect(aliased.episodes.map((episode) => episode.episodeId)).toEqual(
      canonical.episodes.map((episode) => episode.episodeId),
    );
  });

  test("joins extracted mirror sidecars to metadata and results by runID", async () => {
    const directory = await temporaryDirectory();
    const bundle = path.join(
      directory,
      "league-coworld-2026-07-14T11-04-24-383Z-bdf495d0",
    );
    await fs.mkdir(bundle);
    await fs.writeFile(
      path.join(directory, "episodes.json"),
      JSON.stringify({
        episodes: [
          {
            id: "ereq_sidecar",
            game_config: { map: "Asia", map_size: "Compact" },
            policy_version_ids: ["opponent:v1", "candidate:v16"],
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(directory, "ereq_sidecar.replay"),
      JSON.stringify({
        runID: "coworld-sidecar-run",
        config: {
          map: "Asia",
          map_size: "Compact",
          players: [{ name: "Opponent" }, { name: "Auri" }],
        },
        results: {
          scores: [0.25, 0.75],
          winner_slot: null,
          decision_count: 347,
          fallback_count: 94,
          degraded_count: 94,
          players: [
            { slot: 0, name: "Opponent" },
            { slot: 1, name: "Auri" },
          ],
        },
      }),
    );
    await fs.writeFile(
      path.join(bundle, "match-summary.json"),
      JSON.stringify({
        runID: "coworld-sidecar-run",
        completedAt: "2026-07-14T11:04:24.380Z",
        decisionCount: 347,
        fallbackCount: 93,
        parseFailureCount: 0,
        runnerConfig: { map: "Asia", mapSize: "Compact" },
        roster: [
          { agentID: "agent-0", username: "Opponent" },
          { agentID: "agent-1", username: "Auri" },
        ],
      }),
    );
    await fs.writeFile(
      path.join(bundle, "decisions.jsonl"),
      [
        JSON.stringify({
          agentID: "agent-0",
          username: "Opponent",
          turnNumber: 400,
          selectedActionKind: "attack",
          selectedLegalActionId: "attack:candidate:40",
          fallbackUsed: false,
        }),
        JSON.stringify({
          agentID: "agent-1",
          username: "Auri",
          turnNumber: 400,
          selectedActionKind: "alliance_request",
          selectedLegalActionId: "ally:opponent",
          fallbackUsed: true,
          reason:
            "scheduler queued 3 action(s) [wire carries primary only; 2 batched follow-up(s) not executed]",
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(bundle, "spectator-replay.json"),
      JSON.stringify({
        roster: [
          { agentID: "agent-0", username: "Opponent" },
          { agentID: "agent-1", username: "Auri" },
        ],
        snapshots: [
          {
            label: "After spawn",
            turnNumber: 400,
            tick: 400,
            phase: "active",
            players: [
              { agentID: "agent-0", username: "Opponent", tilesOwned: 50 },
              { agentID: "agent-1", username: "Auri", tilesOwned: 150 },
            ],
          },
        ],
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([directory]);
    expect(loaded.episodes).toHaveLength(1);
    expect(loaded.episodes[0]).toMatchObject({
      episodeId: "ereq_sidecar",
      runID: "coworld-sidecar-run",
      scores: [0.25, 0.75],
    });
    expect(loaded.episodes[0].sourcePaths).toHaveLength(5);
    expect(loaded.episodes[0].roster[1]).toMatchObject({
      seat: 1,
      policyVersionId: "candidate:v16",
      playerName: "Auri",
      agentID: "agent-1",
    });
    expect(loaded.episodes[0].decisions).toHaveLength(2);
    expect(loaded.episodes[0].episodeReportedTelemetry).toEqual({
      result: {
        decisionCount: 347,
        fallbackCount: 94,
        degradedCount: 94,
        parseFailureCount: null,
      },
      summary: {
        decisionCount: 347,
        fallbackCount: 93,
        degradedCount: null,
        parseFailureCount: 0,
      },
    });
    expect(loaded.episodes[0].decisions[1]).toMatchObject({
      seat: 1,
      actionKind: "alliance_request",
      fallback: true,
      wireDroppedFollowupCount: 2,
      multiAction: true,
    });
    expect(loaded.episodes[0].snapshots[0].players[1].seat).toBe(1);
  });

  test("parses explicit selectors, treatment markers, and spawn diagnostics config", () => {
    expect(
      parseCoworldDatasetExporterOptions([
        "artifacts",
        "--seat",
        "0",
        "--council-plan",
        "matrix/plan.json",
        "--treatment-marker",
        "land_race=opening-land-race",
        "--spawn-phase-turns",
        "300",
        "--spawn-settle-threshold",
        "0.8",
      ]),
    ).toMatchObject({
      inputPaths: ["artifacts"],
      councilPlanPaths: ["matrix/plan.json"],
      selector: { seat: 0, policyVersionId: null, playerName: null },
      treatmentMarkers: [{ id: "land_race", needle: "opening-land-race" }],
      spawnPhaseTurns: 300,
      spawnSettleThreshold: 0.8,
    });
    expect(() =>
      parseCoworldDatasetExporterOptions([
        "artifacts",
        "--seat",
        "1",
        "--player-name",
        "Auri",
      ]),
    ).toThrow("mutually exclusive");
  });

  test("uses positioned live participants for roster identity and policy seat selection", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "league-episodes.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [
          {
            id: "ereq_participants",
            map: "Europe",
            scores: [0.25, 0.75],
            participants: [
              {
                position: 2,
                player_name: "Candidate Owner",
                policy_version_id: "candidate:v16",
                label: "Keystone v16",
              },
              {
                position: 1,
                player_name: "Opponent Owner",
                policy_version_id: "opponent:v2",
                label: "Opponent v2",
              },
            ],
          },
        ],
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(loaded.episodes[0].roster).toEqual([
      {
        seat: 0,
        policyVersionId: "opponent:v2",
        playerName: "Opponent Owner",
        label: "Opponent v2",
        agentID: null,
      },
      {
        seat: 1,
        policyVersionId: "candidate:v16",
        playerName: "Candidate Owner",
        label: "Keystone v16",
        agentID: null,
      },
    ]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: {
        seat: null,
        policyVersionId: "candidate:v16",
        playerName: null,
      },
    });
    expect(dataset.rows).toHaveLength(1);
    expect(dataset.rows[0]).toMatchObject({ seat: 1, scoreShare: 0.75 });
  });

  test("keeps absent decision telemetry unknown with per-signal denominators", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [
          {
            id: "ereq_unknown_telemetry",
            map: "Asia",
            scores: [1, 0],
            participants: [
              {
                position: 0,
                player_name: "Candidate",
                policy_version_id: "candidate:v1",
                label: "Candidate",
              },
              {
                position: 1,
                player_name: "Opponent",
                policy_version_id: "opponent:v1",
                label: "Opponent",
              },
            ],
            decisions: [
              {
                seat: 0,
                turnNumber: 100,
                selectedLegalActionId: "hold",
                selectedActionKind: "hold",
              },
              {
                seat: 0,
                turnNumber: 200,
                selectedLegalActionId: "build:city:1",
                selectedActionKind: "build",
                fallbackUsed: false,
              },
            ],
          },
        ],
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
    });
    expect(loaded.episodes[0].decisions[0]).toMatchObject({
      fallback: null,
      degraded: null,
      parseFailure: null,
      wireDroppedFollowupCount: null,
      multiAction: null,
    });
    expect(dataset.rows[0].telemetry).toMatchObject({
      decisionCount: 2,
      fallbackSampleCount: 1,
      fallbackCount: 0,
      fallbackRate: 0,
      fallbackOrDegradedSampleCount: 0,
      fallbackOrDegradedCount: null,
      degradedSampleCount: 0,
      degradedCount: null,
      parseFailureSampleCount: 0,
      parseFailureCount: null,
      wireDroppedFollowupSampleCount: 0,
      wireDroppedFollowupCount: null,
      multiActionSampleCount: 0,
      multiActionDecisionCount: null,
    });
    expect(dataset.aggregate).toMatchObject({
      fallbackSampleCount: 1,
      fallbackCount: 0,
      degradedSampleCount: 0,
      degradedCount: null,
      parseFailureSampleCount: 0,
      parseFailureCount: null,
    });
  });

  test("requires explicit neutral evidence when a named attack target has a null ID", () => {
    const fragments = parseCoworldEvaluationDocument({
      sourcePath: "/artifacts/target-types.json",
      fallbackId: "target-types",
      value: {
        id: "ereq_target_types",
        scores: [1, 0],
        decisions: [
          {
            seat: 0,
            turnNumber: 100,
            selectedActionKind: "attack",
            selectedActionMetadata: {
              targetID: null,
              targetName: "Named Rival",
            },
          },
          {
            seat: 0,
            turnNumber: 200,
            selectedActionKind: "attack",
            selectedActionMetadata: { targetID: null, expansion: true },
          },
        ],
      },
    });

    expect(
      fragments[0].decisions.map((decision) => decision.attackTargetType),
    ).toEqual(["hostile", "neutral"]);
  });

  test("merges complementary decisions and snapshot players by stable identity", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "league-episodes.json");
    const participants = [
      {
        position: 0,
        player_name: "Candidate",
        policy_version_id: "candidate:v1",
        label: "Candidate",
      },
      {
        position: 1,
        player_name: "Opponent",
        policy_version_id: "opponent:v1",
        label: "Opponent",
      },
    ];
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [
          {
            id: "ereq_complementary",
            runID: "run_complementary",
            map: "Pangaea",
            scores: [0.6, 0.4],
            participants,
            decisions: [
              {
                seat: 0,
                turnNumber: 100,
                selectedLegalActionId: "hold",
                selectedActionKind: "hold",
              },
            ],
            spectatorReplay: {
              snapshots: [
                {
                  label: "active",
                  turnNumber: 100,
                  tick: 100,
                  phase: "active",
                  players: [{ seat: 0, username: "Candidate", tilesOwned: 10 }],
                },
              ],
            },
          },
          {
            id: "ereq_complementary",
            runID: "run_complementary",
            map: "Pangaea",
            scores: [0.6, 0.4],
            participants,
            decisions: [
              {
                seat: 0,
                turnNumber: 100,
                fallbackUsed: false,
              },
              {
                seat: 0,
                turnNumber: 200,
                selectedLegalActionId: "build:city:1",
                selectedActionKind: "build",
              },
            ],
            spectatorReplay: {
              snapshots: [
                {
                  label: "active",
                  turnNumber: 100,
                  players: [{ seat: 1, username: "Opponent", tilesOwned: 20 }],
                },
                {
                  label: "late",
                  turnNumber: 200,
                  tick: 200,
                  phase: "active",
                  players: [{ seat: 0, username: "Candidate", tilesOwned: 30 }],
                },
              ],
            },
          },
        ],
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(loaded.episodes).toHaveLength(1);
    expect(
      loaded.episodes[0].decisions.map((decision) => decision.turnNumber),
    ).toEqual([100, 200]);
    expect(loaded.episodes[0].decisions[0]).toMatchObject({
      selectedLegalActionId: "hold",
      actionKind: "hold",
      fallback: false,
    });
    expect(loaded.episodes[0].snapshots).toHaveLength(2);
    expect(loaded.episodes[0].snapshots[0]).toMatchObject({
      tick: 100,
      phase: "active",
    });
    expect(loaded.episodes[0].snapshots[0].players).toHaveLength(2);
  });

  test.each([
    [
      "runID",
      { runID: "run-a", map: "Europe" },
      { runID: "run-b", map: "Europe" },
      "Conflicting runID",
    ],
    [
      "map",
      { runID: "run-a", map: "Europe" },
      { runID: "run-a", map: "Asia" },
      "Conflicting map",
    ],
    [
      "roster",
      { runID: "run-a", map: "Europe", policyVersionId: "candidate:v1" },
      { runID: "run-a", map: "Europe", policyVersionId: "candidate:v2" },
      "Conflicting roster seat 0 policyVersionId",
    ],
  ])(
    "fails closed on conflicting %s evidence",
    async (_name, left, right, message) => {
      const directory = await temporaryDirectory();
      const sourcePath = path.join(directory, "episodes.json");
      const episode = (value: typeof left) => ({
        id: "ereq_conflict",
        runID: value.runID,
        map: value.map,
        scores: [1, 0],
        participants: [
          {
            position: 0,
            player_name: "Candidate",
            policy_version_id:
              "policyVersionId" in value
                ? value.policyVersionId
                : "candidate:v1",
            label: "Candidate",
          },
          {
            position: 1,
            player_name: "Opponent",
            policy_version_id: "opponent:v1",
            label: "Opponent",
          },
        ],
      });
      await fs.writeFile(
        sourcePath,
        JSON.stringify({ episodes: [episode(left), episode(right)] }),
      );

      await expect(loadCoworldEvaluationEpisodes([sourcePath])).rejects.toThrow(
        message,
      );
    },
  );

  test("fails closed on malformed and schema-invalid explicit inputs", async () => {
    const directory = await temporaryDirectory();
    const malformedPath = path.join(directory, "malformed.json");
    const schemaPath = path.join(directory, "schema.json");
    await fs.writeFile(malformedPath, "{not-json");
    await fs.writeFile(
      schemaPath,
      JSON.stringify({ id: "ereq_schema", scores: ["invalid", 0] }),
    );

    await expect(
      loadCoworldEvaluationEpisodes([malformedPath]),
    ).rejects.toThrow("contains invalid JSON");
    await expect(loadCoworldEvaluationEpisodes([schemaPath])).rejects.toThrow(
      "invalid score entry",
    );
  });

  test("rejects conflicting decisions at the same stable identity", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    const episode = (selectedLegalActionId: string) => ({
      id: "ereq_decision_conflict",
      runID: "run_decision_conflict",
      map: "Europe",
      scores: [1, 0],
      decisions: [
        {
          seat: 0,
          turnNumber: 100,
          selectedLegalActionId,
          selectedActionKind: "attack",
        },
      ],
    });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [episode("attack:a:40"), episode("attack:b:40")],
      }),
    );

    await expect(loadCoworldEvaluationEpisodes([sourcePath])).rejects.toThrow(
      "Conflicting decision turn 100 selectedLegalActionId",
    );
  });

  test("discovers league-episodes.json while warning only for an unrelated discovered file", async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(
      path.join(directory, "league-episodes.json"),
      JSON.stringify({
        episodes: [{ id: "ereq_discovered", map: "Asia", scores: [1, 0] }],
      }),
    );
    await fs.writeFile(
      path.join(directory, "metadata.json"),
      JSON.stringify({ generatedBy: "unrelated-tool" }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([directory]);
    expect(loaded.episodes.map((episode) => episode.episodeId)).toEqual([
      "ereq_discovered",
    ]);
    expect(loaded.warnings).toEqual([
      expect.stringContaining("ignored unrelated discovered file"),
    ]);
  });

  test("counts explicitly non-completed rows while requiring scored completed rows", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "league-episodes.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [
          {
            id: "ereq_completed",
            status: "completed",
            map: "Asia",
            scores: [1, 0],
          },
          { id: "ereq_failed", status: "failed", scores: [] },
          { id: "ereq_running", status: "running", scores: [] },
          { id: "ereq_submitted", status: "submitted", scores: [] },
        ],
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(loaded.episodes.map((episode) => episode.episodeId)).toEqual([
      "ereq_completed",
    ]);
    expect(loaded.stats).toEqual({
      skippedNonCompletedEntries: 3,
      skippedByStatus: { failed: 1, running: 1, submitted: 1 },
    });
    expect(loaded.warnings).toContain(
      "Skipped 3 explicitly non-completed episode entries (failed=1, running=1, submitted=1)",
    );
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
      warnings: loaded.warnings,
      skippedNonCompletedEntries: loaded.stats.skippedNonCompletedEntries,
      skippedByStatus: loaded.stats.skippedByStatus,
    });
    expect(dataset.ingestion).toEqual(loaded.stats);
  });

  test.each([
    [
      "completed row without scores",
      { id: "ereq_no_scores", status: "completed", scores: [] },
      "invalid scores",
    ],
    [
      "completed row with absent scores",
      { id: "ereq_absent_scores", status: "completed" },
      "completed episode has no scores",
    ],
    [
      "unknown status",
      { id: "ereq_unknown_status", status: "mystery", scores: [] },
      "unknown episode status mystery",
    ],
    [
      "status-less empty scores",
      { id: "ereq_statusless", scores: [] },
      "invalid scores",
    ],
  ])("fails closed for %s", async (_name, episode, message) => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    await fs.writeFile(sourcePath, JSON.stringify({ episodes: [episode] }));

    await expect(loadCoworldEvaluationEpisodes([sourcePath])).rejects.toThrow(
      message,
    );
  });

  test("keeps repeated player names isolated by seat and agent identity", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        id: "ereq_repeated_names",
        scores: [0.4, 0.2, 0.4],
        participants: [
          {
            position: 0,
            player_name: "Auri",
            policy_version_id: "candidate:v1",
            label: "Candidate left",
          },
          {
            position: 1,
            player_name: "Opponent",
            policy_version_id: "opponent:v1",
            label: "Opponent",
          },
          {
            position: 2,
            player_name: "Auri",
            policy_version_id: "candidate:v1",
            label: "Candidate right",
          },
        ],
        decisions: [
          {
            username: "Auri",
            agentID: "agent-0",
            turnNumber: 100,
            selectedLegalActionId: "attack:rival:40",
            selectedActionKind: "attack",
          },
          {
            username: "Auri",
            agentID: "agent-2",
            turnNumber: 100,
            selectedLegalActionId: "hold",
            selectedActionKind: "hold",
          },
          {
            username: "Auri",
            agentID: "agent-not-in-roster",
            turnNumber: 100,
            selectedLegalActionId: "build:city:1",
            selectedActionKind: "build",
          },
        ],
        spectatorReplay: {
          roster: [
            { agentID: "agent-0", username: "Auri" },
            { agentID: "agent-1", username: "Opponent" },
            { agentID: "agent-2", username: "Auri" },
          ],
          snapshots: [
            {
              label: "active",
              turnNumber: 100,
              tick: 100,
              phase: "active",
              players: [
                { agentID: "agent-0", username: "Auri", tilesOwned: 10 },
                { agentID: "agent-1", username: "Opponent", tilesOwned: 20 },
                { agentID: "agent-2", username: "Auri", tilesOwned: 30 },
              ],
            },
          ],
        },
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(
      loaded.episodes[0].decisions.map((decision) => decision.seat),
    ).toEqual([0, 2, null]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: {
        seat: null,
        policyVersionId: "candidate:v1",
        playerName: null,
      },
    });
    expect(dataset.rows.map((row) => row.seat)).toEqual([0, 2]);
    expect(dataset.rows[0].telemetry.actionMix).toEqual({ attack: 1 });
    expect(dataset.rows[1].telemetry.actionMix).toEqual({ hold: 1 });
    expect(dataset.rows[0].phaseSnapshots[0].tilesOwned).toBe(10);
    expect(dataset.rows[1].phaseSnapshots[0].tilesOwned).toBe(30);
  });

  test("keeps ambiguous seatless repeated-name evidence separate across fragments", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    const participants = [
      {
        position: 0,
        player_name: "Auri",
        policy_version_id: "candidate:v1",
        label: "Candidate left",
      },
      {
        position: 1,
        player_name: "Opponent",
        policy_version_id: "opponent:v1",
        label: "Opponent",
      },
      {
        position: 2,
        player_name: "Auri",
        policy_version_id: "candidate:v1",
        label: "Candidate right",
      },
    ];
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [
          {
            id: "ereq_repeated_name_fragments",
            runID: "run_repeated_name_fragments",
            scores: [0.4, 0.2, 0.4],
            participants,
            decisions: [
              {
                seat: 0,
                username: "Auri",
                turnNumber: 100,
                selectedLegalActionId: "hold",
                selectedActionKind: "hold",
              },
              {
                seat: 1,
                username: "Opponent",
                turnNumber: 200,
                selectedLegalActionId: "hold",
                selectedActionKind: "hold",
              },
            ],
            spectatorReplay: {
              snapshots: [
                {
                  label: "active",
                  turnNumber: 100,
                  tick: 100,
                  phase: "active",
                  players: [
                    { seat: 0, username: "Auri", tilesOwned: 10 },
                    { seat: 1, username: "Opponent", tilesOwned: 20 },
                  ],
                },
              ],
            },
          },
          {
            id: "ereq_repeated_name_fragments",
            runID: "run_repeated_name_fragments",
            scores: [0.4, 0.2, 0.4],
            participants,
            decisions: [
              {
                username: "Auri",
                turnNumber: 100,
                fallbackUsed: true,
              },
              {
                username: "Opponent",
                turnNumber: 200,
                fallbackUsed: false,
              },
            ],
            spectatorReplay: {
              snapshots: [
                {
                  label: "active",
                  turnNumber: 100,
                  tick: 100,
                  phase: "active",
                  players: [
                    { username: "Auri", troops: 999 },
                    { username: "Opponent", troops: 200 },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(loaded.episodes).toHaveLength(1);
    expect(loaded.episodes[0].decisions).toHaveLength(3);
    expect(
      loaded.episodes[0].decisions.map((decision) => ({
        seat: decision.seat,
        fallback: decision.fallback,
      })),
    ).toEqual([
      { seat: 0, fallback: null },
      { seat: null, fallback: true },
      { seat: 1, fallback: false },
    ]);
    expect(loaded.episodes[0].snapshots).toHaveLength(1);
    expect(loaded.episodes[0].snapshots[0].players).toHaveLength(3);
    expect(
      loaded.episodes[0].snapshots[0].players.find(
        (player) => player.seat === 0,
      ),
    ).toMatchObject({ tilesOwned: 10, troops: null });
    expect(
      loaded.episodes[0].snapshots[0].players.find(
        (player) => player.seat === null,
      ),
    ).toMatchObject({ tilesOwned: null, troops: 999 });
    expect(
      loaded.episodes[0].snapshots[0].players.find(
        (player) => player.seat === 1,
      ),
    ).toMatchObject({ tilesOwned: 20, troops: 200 });

    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
    });
    expect(dataset.rows[0].telemetry.actionMix).toEqual({ hold: 1 });
    expect(dataset.rows[0].telemetry.fallbackSampleCount).toBe(0);
    expect(dataset.rows[0].phaseSnapshots[0]).toMatchObject({
      tilesOwned: 10,
      troops: null,
    });
  });

  test("demotes identity-inferred seats when later roster evidence makes the name ambiguous", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    const base = {
      id: "ereq_late_repeated_name",
      runID: "run_late_repeated_name",
      scores: [0.5, 0.3, 0.2],
    };
    const initialEvidence = {
      ...base,
      participants: [
        {
          position: 0,
          player_name: "Auri",
          policy_version_id: "candidate:v1",
        },
        { position: 1 },
        { position: 2 },
      ],
      decisions: [
        {
          username: "Auri",
          turnNumber: 100,
          selectedActionKind: "hold",
          fallbackUsed: true,
        },
      ],
      spectatorReplay: {
        snapshots: [
          {
            label: "active",
            turnNumber: 100,
            tick: 100,
            phase: "active",
            players: [{ username: "Auri", tilesOwned: 999 }],
          },
        ],
      },
    };
    const enrichment = {
      ...base,
      participants: [
        {
          position: 0,
          player_name: "Auri",
          policy_version_id: "candidate:v1",
        },
        {
          position: 1,
          player_name: "Opponent",
          policy_version_id: "opponent:v1",
        },
        {
          position: 2,
          player_name: "Auri",
          policy_version_id: "candidate:v1",
        },
      ],
    };
    const initialFragment = parseCoworldEvaluationDocument({
      value: initialEvidence,
      sourcePath: "/artifacts/late-repeated-name-initial.replay",
      fallbackId: "late-repeated-name-initial",
    })[0];
    expect(initialFragment.decisions[0].seat).toBe(0);
    expect(initialFragment.snapshots[0].players[0].seat).toBe(0);

    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [initialEvidence, enrichment],
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(loaded.episodes[0].decisions[0]).toMatchObject({
      seat: null,
      playerName: "Auri",
      fallback: true,
    });
    expect(loaded.episodes[0].snapshots[0].players[0]).toMatchObject({
      seat: null,
      playerName: "Auri",
      tilesOwned: 999,
    });

    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: {
        seat: null,
        policyVersionId: "candidate:v1",
        playerName: null,
      },
    });
    expect(dataset.rows.map((row) => row.telemetry.decisionCount)).toEqual([
      null,
      null,
    ]);
    expect(dataset.rows.map((row) => row.phaseSnapshots)).toEqual([[], []]);
  });

  test("retains explicit seats when later roster evidence repeats the player name", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    const base = {
      id: "ereq_late_repeated_name_explicit",
      runID: "run_late_repeated_name_explicit",
      scores: [0.5, 0.3, 0.2],
    };
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [
          {
            ...base,
            participants: [
              { position: 0, player_name: "Auri" },
              { position: 1 },
              { position: 2 },
            ],
            decisions: [
              {
                seat: 0,
                username: "Auri",
                turnNumber: 100,
                selectedActionKind: "hold",
              },
            ],
            spectatorReplay: {
              snapshots: [
                {
                  label: "active",
                  turnNumber: 100,
                  tick: 100,
                  phase: "active",
                  players: [{ seat: 0, username: "Auri", tilesOwned: 999 }],
                },
              ],
            },
          },
          {
            ...base,
            participants: [
              { position: 0, player_name: "Auri" },
              { position: 1, player_name: "Opponent" },
              { position: 2, player_name: "Auri" },
            ],
          },
        ],
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(loaded.episodes[0].decisions[0].seat).toBe(0);
    expect(loaded.episodes[0].snapshots[0].players[0].seat).toBe(0);
  });

  test("keeps repeated-agent-ID evidence unattributed", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        id: "ereq_repeated_agent_id",
        scores: [0.5, 0.5],
        participants: [
          {
            position: 0,
            player_name: "Auri left",
            policy_version_id: "candidate:v1",
          },
          {
            position: 1,
            player_name: "Auri right",
            policy_version_id: "candidate:v1",
          },
        ],
        decisions: [
          {
            agentID: "shared-agent",
            turnNumber: 100,
            selectedActionKind: "hold",
            fallbackUsed: true,
          },
        ],
        spectatorReplay: {
          roster: [
            { agentID: "shared-agent", username: "Auri left" },
            { agentID: "shared-agent", username: "Auri right" },
          ],
          snapshots: [
            {
              label: "active",
              turnNumber: 100,
              tick: 100,
              phase: "active",
              players: [{ agentID: "shared-agent", tilesOwned: 999 }],
            },
          ],
        },
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(loaded.episodes[0].decisions[0].seat).toBeNull();
    expect(loaded.episodes[0].snapshots[0].players[0].seat).toBeNull();
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: {
        seat: null,
        policyVersionId: "candidate:v1",
        playerName: null,
      },
    });
    expect(dataset.rows.map((row) => row.telemetry.decisionCount)).toEqual([
      null,
      null,
    ]);
    expect(dataset.rows.map((row) => row.phaseSnapshots)).toEqual([[], []]);
  });

  test("does not infer a seat from a partial anonymous snapshot order", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        id: "ereq_partial_anonymous_snapshot",
        scores: [0.75, 0.25],
        participants: [
          { position: 0, player_name: "Auri" },
          { position: 1, player_name: "Opponent" },
        ],
        spectatorReplay: {
          snapshots: [
            {
              label: "active",
              turnNumber: 100,
              phase: "active",
              players: [{ tilesOwned: 999 }],
            },
          ],
        },
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(loaded.episodes[0].snapshots[0].players[0]).toMatchObject({
      seat: null,
      tilesOwned: 999,
    });
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
    });
    expect(dataset.rows[0].phaseSnapshots).toEqual([]);
  });

  test("keeps an anonymous row unattributed in a roster-sized mixed snapshot", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        id: "ereq_mixed_snapshot_identity",
        scores: [0.75, 0.25],
        participants: [
          { position: 0, player_name: "Auri" },
          { position: 1, player_name: "Opponent" },
        ],
        spectatorReplay: {
          snapshots: [
            {
              label: "active",
              turnNumber: 100,
              phase: "active",
              players: [
                { tilesOwned: 999 },
                { seat: 0, username: "Auri", tilesOwned: 20 },
              ],
            },
          ],
        },
      }),
    );

    const loaded = await loadCoworldEvaluationEpisodes([sourcePath]);
    expect(
      loaded.episodes[0].snapshots[0].players.map((player) => player.seat),
    ).toEqual([null, 0]);
    const dataset = buildCoworldEvaluationDataset({
      episodes: loaded.episodes,
      selector: { seat: 0, policyVersionId: null, playerName: null },
    });
    expect(dataset.rows[0].phaseSnapshots[0].tilesOwned).toBe(20);
  });

  test("uses snapshot order only for a complete anonymous roster", () => {
    const fragments = parseCoworldEvaluationDocument({
      sourcePath: "/artifacts/complete-anonymous-snapshot.replay",
      fallbackId: "complete-anonymous-snapshot",
      value: {
        id: "ereq_complete_anonymous_snapshot",
        scores: [0.75, 0.25],
        spectatorReplay: {
          snapshots: [
            {
              turnNumber: 100,
              players: [{ tilesOwned: 100 }, { tilesOwned: 50 }],
            },
          ],
        },
      },
    });

    expect(
      fragments[0].snapshots[0].players.map((player) => player.seat),
    ).toEqual([0, 1]);
  });

  test.each([
    [
      "decision name",
      {
        decisions: [
          {
            seat: 0,
            username: "Opponent",
            turnNumber: 100,
            selectedActionKind: "hold",
          },
        ],
      },
    ],
    [
      "decision agent ID",
      {
        decisions: [
          {
            seat: 0,
            username: "Auri",
            agentID: "agent-1",
            turnNumber: 100,
            selectedActionKind: "hold",
          },
        ],
      },
    ],
    [
      "snapshot name",
      {
        spectatorReplay: {
          roster: [
            { agentID: "agent-0", username: "Auri" },
            { agentID: "agent-1", username: "Opponent" },
          ],
          snapshots: [
            {
              turnNumber: 100,
              players: [{ seat: 0, username: "Opponent", tilesOwned: 999 }],
            },
          ],
        },
      },
    ],
  ])("rejects a same-record %s contradiction", (_name, evidence) => {
    const spectatorReplay = {
      roster: [
        { agentID: "agent-0", username: "Auri" },
        { agentID: "agent-1", username: "Opponent" },
      ],
      ...("spectatorReplay" in evidence ? evidence.spectatorReplay : {}),
    };
    expect(() =>
      parseCoworldEvaluationDocument({
        sourcePath: "/artifacts/contradictory-identity.replay",
        fallbackId: "contradictory-identity",
        value: {
          id: "ereq_contradictory_identity",
          scores: [1, 0],
          participants: [
            { position: 0, player_name: "Auri" },
            { position: 1, player_name: "Opponent" },
          ],
          ...evidence,
          spectatorReplay,
        },
      }),
    ).toThrow("Conflicting");
  });

  test.each([
    [
      "name",
      {
        decisions: [
          {
            seat: 0,
            username: "Opponent",
            turnNumber: 100,
            selectedActionKind: "hold",
          },
        ],
      },
      {
        participants: [
          { position: 0, player_name: "Auri" },
          { position: 1, player_name: "Opponent" },
        ],
      },
      "Conflicting decision identity",
    ],
    [
      "agent ID",
      {
        decisions: [
          {
            seat: 0,
            agentID: "agent-1",
            turnNumber: 100,
            selectedActionKind: "hold",
          },
        ],
      },
      {
        spectatorReplay: {
          roster: [
            { agentID: "agent-0", username: "Auri" },
            { agentID: "agent-1", username: "Opponent" },
          ],
        },
      },
      "Conflicting decision identity",
    ],
    [
      "snapshot name",
      {
        spectatorReplay: {
          snapshots: [
            {
              turnNumber: 100,
              players: [{ seat: 0, username: "Opponent", tilesOwned: 999 }],
            },
          ],
        },
      },
      {
        participants: [
          { position: 0, player_name: "Auri" },
          { position: 1, player_name: "Opponent" },
        ],
      },
      "Conflicting snapshot player identity",
    ],
  ])(
    "revalidates a cross-fragment %s contradiction after roster enrichment",
    async (_name, evidence, enrichment, expectedError) => {
      const directory = await temporaryDirectory();
      const sourcePath = path.join(directory, "episodes.json");
      const base = {
        id: "ereq_enriched_identity_conflict",
        runID: "run_enriched_identity_conflict",
        scores: [1, 0],
      };
      await fs.writeFile(
        sourcePath,
        JSON.stringify({
          episodes: [
            { ...base, ...evidence },
            { ...base, ...enrichment },
          ],
        }),
      );

      await expect(loadCoworldEvaluationEpisodes([sourcePath])).rejects.toThrow(
        expectedError,
      );
    },
  );

  test("rejects snapshot identities that converge on one seat after roster enrichment", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    const base = {
      id: "ereq_enriched_snapshot_conflict",
      runID: "run_enriched_snapshot_conflict",
      scores: [1, 0],
    };
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        episodes: [
          {
            ...base,
            spectatorReplay: {
              snapshots: [
                {
                  label: "active",
                  turnNumber: 100,
                  players: [
                    { username: "Auri", tilesOwned: 100 },
                    { agentID: "agent-0", troops: 200 },
                  ],
                },
              ],
            },
          },
          {
            ...base,
            spectatorReplay: {
              roster: [
                { agentID: "agent-0", username: "Auri" },
                { agentID: "agent-1", username: "Opponent" },
              ],
            },
          },
        ],
      }),
    );

    await expect(loadCoworldEvaluationEpisodes([sourcePath])).rejects.toThrow(
      "Ambiguous snapshot player seat",
    );
  });

  test.each([
    [
      "mixed slotted and ordered result players",
      [{ name: "Opponent" }, { slot: 0, name: "Auri" }],
      "mix slotted and ordered",
    ],
    [
      "duplicate result slots",
      [
        { slot: 0, name: "Auri" },
        { slot: 0, name: "Opponent" },
      ],
      "slots must be unique",
    ],
  ])("rejects %s", (_name, players, message) => {
    expect(() =>
      parseCoworldEvaluationDocument({
        sourcePath: "/artifacts/invalid-result-order.replay",
        fallbackId: "invalid-result-order",
        value: {
          id: "ereq_invalid_result_order",
          results: { scores: [0.75, 0.25], players },
        },
      }),
    ).toThrow(message);
  });

  test("aligns a complete explicitly slotted result roster", () => {
    const fragments = parseCoworldEvaluationDocument({
      sourcePath: "/artifacts/slotted-result-order.replay",
      fallbackId: "slotted-result-order",
      value: {
        id: "ereq_slotted_result_order",
        results: {
          scores: [0.75, 0.25],
          players: [
            { slot: 1, name: "Opponent" },
            { slot: 0, name: "Auri" },
          ],
        },
      },
    });
    expect(fragments[0].roster.map((seat) => seat.playerName)).toEqual([
      "Auri",
      "Opponent",
    ]);
  });

  test("rejects an outright winner slot outside the score order", () => {
    expect(() =>
      parseCoworldEvaluationDocument({
        sourcePath: "/artifacts/out-of-range-winner.replay",
        fallbackId: "out-of-range-winner",
        value: {
          id: "ereq_out_of_range_winner",
          scores: [1, 0],
          winner_slot: 9,
        },
      }),
    ).toThrow("invalid winner_slot");
  });

  test("merges direct and inline decisions within one fragment and rejects conflicts", () => {
    const base = {
      id: "ereq_inline_merge",
      scores: [1, 0],
      decisions: [
        {
          seat: 0,
          turnNumber: 100,
          selectedLegalActionId: "hold",
          selectedActionKind: "hold",
        },
      ],
    };
    const fragments = parseCoworldEvaluationDocument({
      sourcePath: "/artifacts/inline-merge.replay",
      fallbackId: "inline-merge",
      value: {
        ...base,
        inlineRunArtifacts: {
          "decisions.jsonl": [
            JSON.stringify({ seat: 0, turnNumber: 100, fallbackUsed: false }),
            JSON.stringify({
              seat: 0,
              turnNumber: 200,
              selectedLegalActionId: "build:city:1",
              selectedActionKind: "build",
            }),
          ].join("\n"),
        },
      },
    });
    expect(fragments[0].decisions).toHaveLength(2);
    expect(fragments[0].decisions[0]).toMatchObject({
      turnNumber: 100,
      selectedLegalActionId: "hold",
      fallback: false,
    });

    expect(() =>
      parseCoworldEvaluationDocument({
        sourcePath: "/artifacts/inline-conflict.replay",
        fallbackId: "inline-conflict",
        value: {
          ...base,
          inlineRunArtifacts: {
            "decisions.jsonl": JSON.stringify({
              seat: 0,
              turnNumber: 100,
              selectedLegalActionId: "attack:rival:40",
              selectedActionKind: "attack",
            }),
          },
        },
      }),
    ).toThrow("Conflicting decision turn 100");
  });

  test.each([
    [
      "runID",
      {
        id: "ereq_source_conflict",
        runID: "run-a",
        scores: [1, 0],
        inlineRunArtifacts: {
          "match-summary.json": JSON.stringify({ runID: "run-b" }),
        },
      },
    ],
    [
      "map",
      {
        id: "ereq_source_conflict",
        map: "Europe",
        game_config: { map: "Asia" },
        scores: [1, 0],
      },
    ],
    [
      "mapSize",
      {
        id: "ereq_source_conflict",
        map_size: "Compact",
        game_config: { map_size: "Large" },
        scores: [1, 0],
      },
    ],
  ])("rejects conflicting within-fragment %s sources", (field, value) => {
    expect(() =>
      parseCoworldEvaluationDocument({
        sourcePath: "/artifacts/source-conflict.json",
        fallbackId: "source-conflict",
        value,
      }),
    ).toThrow(`conflicting ${field}`);
  });

  test("requires explicit score/order cardinality and infers roster IDs only without order", () => {
    expect(() =>
      parseCoworldEvaluationDocument({
        sourcePath: "/artifacts/order-mismatch.json",
        fallbackId: "order-mismatch",
        value: {
          id: "ereq_order_mismatch",
          policy_version_ids: ["candidate:v1", "opponent:v1"],
          scores: [
            { policy_version_id: "candidate:v1", score: 0.5 },
            { policy_version_id: "opponent:v1", score: 0.3 },
            { policy_version_id: "third:v1", score: 0.2 },
          ],
        },
      }),
    ).toThrow("score/order cardinality mismatch");
    expect(() =>
      parseCoworldEvaluationDocument({
        sourcePath: "/artifacts/incomplete-order.json",
        fallbackId: "incomplete-order",
        value: {
          id: "ereq_incomplete_order",
          participants: [{ position: 0 }, { position: 1 }],
          scores: [
            { policy_version_id: "candidate:v1", score: 0.75 },
            { policy_version_id: "opponent:v1", score: 0.25 },
          ],
        },
      }),
    ).toThrow("incomplete explicit policy order for pair scores");

    const fragments = parseCoworldEvaluationDocument({
      sourcePath: "/artifacts/pair-order.json",
      fallbackId: "pair-order",
      value: {
        id: "ereq_pair_order",
        scores: [
          { policy_version_id: "candidate:v1", score: 0.75 },
          { policy_version_id: "opponent:v1", score: 0.25 },
        ],
      },
    });
    expect(fragments[0].scores).toEqual([0.75, 0.25]);
    expect(fragments[0].roster.map((seat) => seat.policyVersionId)).toEqual([
      "candidate:v1",
      "opponent:v1",
    ]);
  });

  test.each([
    [
      "participant policy_version_id",
      {
        id: "ereq_bad_participant_policy",
        scores: [1],
        participants: [{ position: 0, policy_version_id: 7 }],
      },
    ],
    [
      "participant player_name",
      {
        id: "ereq_bad_participant_name",
        scores: [1],
        participants: [{ position: 0, player_name: "" }],
      },
    ],
    [
      "participant label",
      {
        id: "ereq_bad_participant_label",
        scores: [1],
        participants: [{ position: 0, label: null }],
      },
    ],
    [
      "policy_versions entry",
      {
        id: "ereq_bad_policy_versions",
        scores: [1],
        policy_versions: [{}],
      },
    ],
    [
      "roster entry",
      {
        id: "ereq_bad_roster",
        scores: [1],
        roster: ["not-an-object"],
      },
    ],
    [
      "roster policy field",
      {
        id: "ereq_bad_roster_policy",
        scores: [1],
        roster: [{ policy_version_id: 7 }],
      },
    ],
  ])("rejects malformed explicit %s", (_name, value) => {
    expect(() =>
      parseCoworldEvaluationDocument({
        sourcePath: "/artifacts/malformed-identity.json",
        fallbackId: "malformed-identity",
        value,
      }),
    ).toThrow();
  });

  test("allows absent optional participant identity fields to remain unknown", () => {
    const fragments = parseCoworldEvaluationDocument({
      sourcePath: "/artifacts/optional-participant-fields.json",
      fallbackId: "optional-participant-fields",
      value: {
        id: "ereq_optional_participant_fields",
        scores: [1, 0],
        participants: [{ position: 0 }, { position: 1 }],
      },
    });
    expect(fragments[0].roster).toEqual([
      {
        seat: 0,
        policyVersionId: null,
        playerName: null,
        label: null,
        agentID: null,
      },
      {
        seat: 1,
        policyVersionId: null,
        playerName: null,
        label: null,
        agentID: null,
      },
    ]);
  });

  test("refuses source collisions and existing outputs, then publishes atomically", async () => {
    const directory = await temporaryDirectory();
    const sourcePath = path.join(directory, "episodes.json");
    const existingPath = path.join(directory, "existing.json");
    const outputPath = path.join(directory, "dataset.json");
    await fs.writeFile(sourcePath, "source");
    await fs.writeFile(existingPath, "existing");

    await expect(
      writeCoworldEvaluationDatasetFile({
        outputPath: sourcePath,
        output: "replacement",
        sourcePaths: [sourcePath],
      }),
    ).rejects.toThrow("Refusing to replace source artifact");
    await expect(
      writeCoworldEvaluationDatasetFile({
        outputPath: existingPath,
        output: "replacement",
        sourcePaths: [sourcePath],
      }),
    ).rejects.toThrow("Refusing to overwrite existing output");

    await writeCoworldEvaluationDatasetFile({
      outputPath,
      output: "published\n",
      sourcePaths: [sourcePath],
    });
    expect(await fs.readFile(outputPath, "utf8")).toBe("published\n");
    expect(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
