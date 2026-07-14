import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadCoworldEvaluationEpisodes,
  parseCoworldDatasetExporterOptions,
  parseCoworldEvaluationDocument,
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

function normalizedEpisode(): CoworldEvaluationEpisode {
  return {
    episodeId: "ereq_repeated",
    sourcePaths: ["/artifacts/ereq_repeated.replay"],
    runID: "run_repeated",
    completedAt: "2026-07-14T12:00:00Z",
    map: "Europe",
    mapSize: "Compact",
    scores: [0.4, 0.2, 0.4],
    outrightWinnerSlot: null,
    roster: [
      {
        seat: 0,
        policyVersionId: "candidate:v1",
        playerName: "Candidate A",
        agentID: "agent-0",
      },
      {
        seat: 1,
        policyVersionId: "opponent:v2",
        playerName: "Opponent",
        agentID: "agent-1",
      },
      {
        seat: 2,
        policyVersionId: "candidate:v1",
        playerName: "Candidate B",
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
      decisionCount: 5,
      fallbackCount: 2,
      degradedCount: 1,
      parseFailureCount: 1,
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
            completed_at: "2026-07-14T10:00:00Z",
            game_config: { map: "Pangaea", map_size: "Compact" },
            policy_version_ids: ["opponent:v1", "candidate:v16"],
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
          decision_count: 2,
          fallback_count: 1,
          degraded_count: 1,
          players: [
            { slot: 0, name: "Opponent" },
            { slot: 1, name: "Auri" },
          ],
        },
        inlineRunArtifacts: {
          "match-summary.json": JSON.stringify({ parseFailureCount: 0 }),
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
    });
    expect(loaded.episodes[0].sourcePaths).toHaveLength(2);
    expect(loaded.episodes[0].roster[1]).toMatchObject({
      policyVersionId: "candidate:v16",
      playerName: "Auri",
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
  });

  test("prefers a complete local replay over its sibling results file", async () => {
    const directory = await temporaryDirectory();
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
          decision_count: 2,
          fallback_count: 1,
          degraded_count: 1,
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
        decisionCount: 2,
        fallbackCount: 1,
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
        "--treatment-marker",
        "land_race=opening-land-race",
        "--spawn-phase-turns",
        "300",
        "--spawn-settle-threshold",
        "0.8",
      ]),
    ).toMatchObject({
      inputPaths: ["artifacts"],
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
});
