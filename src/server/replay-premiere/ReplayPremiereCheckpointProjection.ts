import { promises as fs } from "node:fs";
import path from "node:path";
import { GameMapType } from "../../core/game/Game";
import type { GameMapLoader, MapData } from "../../core/game/GameMapLoader";
import {
  GameUpdateType,
  type ErrorUpdate,
  type GameUpdateViewData,
} from "../../core/game/GameUpdates";
import type { MapManifest } from "../../core/game/TerrainMapLoader";
import { createGameRunner } from "../../core/GameRunner";
import { TurnSchema, type GameStartInfo, type Turn } from "../../core/Schemas";
import type { PremiereChunkDraft } from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  VerifiedPremiereEligibilityGate,
  type PremierePublicationCheckpointDescriptor,
} from "./ReplayPremierePublication";

const PROJECTOR_YIELD_INTERVAL = 256;

export interface ReplayPremiereCheckpointOptionProjection {
  readonly id: string;
  readonly sequence: number;
  readonly optionSeatIds: readonly string[];
}

export interface ReplayPremiereCheckpointProjection {
  readonly schemaVersion: 1;
  readonly premiereId: string;
  readonly publicationCommitmentHash: string;
  readonly checkpoints: readonly [
    ReplayPremiereCheckpointOptionProjection,
    ReplayPremiereCheckpointOptionProjection,
  ];
}

export interface ReplayPremiereCheckpointProjector {
  project(options: {
    gate: VerifiedPremiereEligibilityGate;
    drafts: readonly PremiereChunkDraft[];
    signal: AbortSignal;
  }): Promise<ReplayPremiereCheckpointProjection>;
}

interface ProjectedPlayer {
  hasSpawned(): boolean;
  isAlive(): boolean;
}

/** Preserves provenance order and ignores every non-provenance player. */
export function projectEligibleReplayPremiereSeatIds(options: {
  provenanceSeatIds: readonly string[];
  playerByClientID: (seatId: string) => ProjectedPlayer | null;
}): readonly string[] {
  if (
    options.provenanceSeatIds.length < 2 ||
    new Set(options.provenanceSeatIds).size !== options.provenanceSeatIds.length
  ) {
    throw projectionFailure("checkpoint_projection_invalid_provenance_seats");
  }
  const eligible: string[] = [];
  for (const seatId of options.provenanceSeatIds) {
    const player = options.playerByClientID(seatId);
    if (player === null) {
      throw projectionFailure("checkpoint_projection_player_missing");
    }
    if (!player.hasSpawned()) {
      throw projectionFailure("checkpoint_projection_player_unspawned");
    }
    if (player.isAlive()) eligible.push(seatId);
  }
  if (eligible.length < 2 || new Set(eligible).size !== eligible.length) {
    throw projectionFailure("checkpoint_projection_fewer_than_two_options");
  }
  return Object.freeze(eligible);
}

export function freezeReplayPremiereCheckpointProjection(options: {
  premiereId: string;
  publicationCommitmentHash: string;
  checkpoints: readonly [
    ReplayPremiereCheckpointOptionProjection,
    ReplayPremiereCheckpointOptionProjection,
  ];
}): ReplayPremiereCheckpointProjection {
  const checkpoints = options.checkpoints.map((checkpoint) =>
    Object.freeze({
      id: checkpoint.id,
      sequence: checkpoint.sequence,
      optionSeatIds: Object.freeze([...checkpoint.optionSeatIds]),
    }),
  ) as unknown as ReplayPremiereCheckpointProjection["checkpoints"];
  return Object.freeze({
    schemaVersion: 1,
    premiereId: options.premiereId,
    publicationCommitmentHash: options.publicationCommitmentHash,
    checkpoints: Object.freeze(checkpoints),
  });
}

export function assertReplayPremiereCheckpointProjection(options: {
  projection: ReplayPremiereCheckpointProjection;
  gate: VerifiedPremiereEligibilityGate;
}): void {
  const definition = options.gate.publicDefinition();
  const provenanceSeatIds = definition.provenance.seats.map(
    (seat) => seat.seatId,
  );
  const projection = options.projection;
  assertExactKeys(projection as unknown as Record<string, unknown>, [
    "schemaVersion",
    "premiereId",
    "publicationCommitmentHash",
    "checkpoints",
  ]);
  if (
    projection.schemaVersion !== 1 ||
    projection.premiereId !== options.gate.premiereId ||
    projection.publicationCommitmentHash !==
      options.gate.publicationCommitmentHash ||
    !Array.isArray(projection.checkpoints) ||
    projection.checkpoints.length !== 2 ||
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.checkpoints)
  ) {
    throw projectionFailure("checkpoint_projection_gate_mismatch");
  }
  for (const [index, checkpoint] of projection.checkpoints.entries()) {
    assertExactKeys(checkpoint as unknown as Record<string, unknown>, [
      "id",
      "sequence",
      "optionSeatIds",
    ]);
    const expected = definition.checkpoints[index];
    if (!Array.isArray(checkpoint.optionSeatIds)) {
      throw projectionFailure("checkpoint_projection_invalid_options");
    }
    const expectedOptions = provenanceSeatIds.filter((seatId) =>
      checkpoint.optionSeatIds.includes(seatId),
    );
    if (
      expected === undefined ||
      checkpoint.id !== expected.id ||
      checkpoint.sequence !== expected.sequence ||
      checkpoint.optionSeatIds.length < 2 ||
      new Set(checkpoint.optionSeatIds).size !==
        checkpoint.optionSeatIds.length ||
      expectedOptions.length !== checkpoint.optionSeatIds.length ||
      expectedOptions.some(
        (seatId, optionIndex) =>
          checkpoint.optionSeatIds[optionIndex] !== seatId,
      ) ||
      !Object.isFrozen(checkpoint) ||
      !Object.isFrozen(checkpoint.optionSeatIds)
    ) {
      throw projectionFailure("checkpoint_projection_invalid_options");
    }
  }
}

export class DeterministicReplayPremiereCheckpointProjector implements ReplayPremiereCheckpointProjector {
  private readonly resourcesMapsRoot: string;

  constructor(resourcesMapsRoot: string) {
    this.resourcesMapsRoot = path.resolve(resourcesMapsRoot);
  }

  async project(options: {
    gate: VerifiedPremiereEligibilityGate;
    drafts: readonly PremiereChunkDraft[];
    signal: AbortSignal;
  }): Promise<ReplayPremiereCheckpointProjection> {
    if (!VerifiedPremiereEligibilityGate.isAuthentic(options.gate)) {
      throw projectionFailure("checkpoint_projection_invalid_gate");
    }
    const definition = options.gate.publicDefinition();
    try {
      const turns = await strictGateBoundTurns(
        options.gate,
        options.drafts,
        definition.checkpoints[1].sequence,
        options.signal,
      );
      const checkpoints =
        await projectReplayPremiereCheckpointOptionsWithGameRunner({
          gameStartInfo: options.gate.publicBootstrap(),
          turns,
          checkpoints: definition.checkpoints,
          provenanceSeatIds: definition.provenance.seats.map(
            (seat) => seat.seatId,
          ),
          mapLoader: new ReplayPremiereFilesystemMapLoader(
            this.resourcesMapsRoot,
          ),
          signal: options.signal,
        });
      const projection = freezeReplayPremiereCheckpointProjection({
        premiereId: options.gate.premiereId,
        publicationCommitmentHash: options.gate.publicationCommitmentHash,
        checkpoints,
      });
      assertReplayPremiereCheckpointProjection({
        projection,
        gate: options.gate,
      });
      return projection;
    } catch (error) {
      if (error instanceof ReplayPremiereError) throw error;
      throw projectionFailure("checkpoint_projection_execution_failed", error);
    }
  }
}

export class ReplayPremiereFilesystemMapLoader implements GameMapLoader {
  private readonly maps = new Map<GameMapType, MapData>();
  private readonly root: string;

  constructor(resourcesMapsRoot: string) {
    this.root = path.resolve(resourcesMapsRoot);
  }

  getMapData(map: GameMapType): MapData {
    const cached = this.maps.get(map);
    if (cached !== undefined) return cached;
    const enumKey = Object.keys(GameMapType).find(
      (key) => GameMapType[key as keyof typeof GameMapType] === map,
    );
    if (enumKey === undefined) {
      throw projectionFailure("checkpoint_projection_unknown_map");
    }
    const mapDirectory = path.resolve(this.root, enumKey.toLowerCase());
    if (
      mapDirectory === this.root ||
      !mapDirectory.startsWith(`${this.root}${path.sep}`)
    ) {
      throw projectionFailure("checkpoint_projection_map_path_escape");
    }
    const binary = async (name: string) =>
      new Uint8Array(await fs.readFile(path.join(mapDirectory, name)));
    const manifest = async () => {
      const raw = await fs.readFile(
        path.join(mapDirectory, "manifest.json"),
        "utf8",
      );
      return JSON.parse(raw) as MapManifest;
    };
    const data: MapData = {
      mapBin: () => binary("map.bin"),
      map4xBin: () => binary("map4x.bin"),
      map16xBin: () => binary("map16x.bin"),
      manifest,
      webpPath: path.join(mapDirectory, "thumbnail.webp"),
    };
    this.maps.set(map, data);
    return data;
  }
}

export async function projectReplayPremiereCheckpointOptionsWithGameRunner(options: {
  gameStartInfo: GameStartInfo;
  turns: readonly Turn[];
  checkpoints: readonly [
    PremierePublicationCheckpointDescriptor,
    PremierePublicationCheckpointDescriptor,
  ];
  provenanceSeatIds: readonly string[];
  mapLoader: GameMapLoader;
  signal: AbortSignal;
}): Promise<ReplayPremiereCheckpointProjection["checkpoints"]> {
  assertActive(options.signal);
  const hashes = new Map<number, number>();
  let runnerError: ErrorUpdate | null = null;
  const runner = await createGameRunner(
    options.gameStartInfo,
    undefined,
    options.mapLoader,
    (update: GameUpdateViewData | ErrorUpdate) => {
      if ("errMsg" in update) {
        runnerError = update;
        return;
      }
      for (const hash of update.updates[GameUpdateType.Hash]) {
        if (hashes.has(hash.tick)) {
          runnerError = { errMsg: "duplicate deterministic hash update" };
          return;
        }
        hashes.set(hash.tick, hash.hash);
      }
    },
  );
  const projected: ReplayPremiereCheckpointOptionProjection[] = [];
  for (const turn of options.turns) {
    assertActive(options.signal);
    const replayTurn = turn.intents.some(
      (intent) => intent.type === "toggle_pause",
    )
      ? {
          ...turn,
          intents: turn.intents.filter(
            (intent) => intent.type !== "toggle_pause",
          ),
        }
      : turn;
    runner.addTurn(replayTurn);
    if (!runner.executeNextTick() || runnerError !== null) {
      throw projectionFailure("checkpoint_projection_turn_execution_failed");
    }
    if (turn.hash !== undefined && turn.hash !== null) {
      const projectedHash = hashes.get(turn.turnNumber);
      if (projectedHash === undefined) {
        throw projectionFailure("checkpoint_projection_archived_hash_missing");
      }
      if (projectedHash !== turn.hash) {
        throw projectionFailure("checkpoint_projection_archived_hash_mismatch");
      }
    }
    const checkpoint = options.checkpoints[projected.length];
    if (checkpoint !== undefined && checkpoint.sequence === turn.turnNumber) {
      projected.push({
        id: checkpoint.id,
        sequence: checkpoint.sequence,
        optionSeatIds: projectEligibleReplayPremiereSeatIds({
          provenanceSeatIds: options.provenanceSeatIds,
          playerByClientID: (seatId) => runner.game.playerByClientID(seatId),
        }),
      });
    }
    if (projected.length === 2) break;
    if (
      turn.turnNumber > 0 &&
      turn.turnNumber % PROJECTOR_YIELD_INTERVAL === 0
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (projected.length !== 2) {
    throw projectionFailure("checkpoint_projection_checkpoint_not_reached");
  }
  return Object.freeze(
    projected,
  ) as unknown as ReplayPremiereCheckpointProjection["checkpoints"];
}

export async function strictGateBoundTurns(
  gate: VerifiedPremiereEligibilityGate,
  drafts: readonly PremiereChunkDraft[],
  throughSequence: number,
  signal: AbortSignal,
): Promise<readonly Turn[]> {
  assertActive(signal);
  if (!Array.isArray(drafts) || drafts.length !== gate.chunkCount) {
    throw projectionFailure("checkpoint_projection_draft_count_mismatch");
  }
  const turns: Turn[] = [];
  let expectedSequence = 0;
  for (const [index, draft] of drafts.entries()) {
    assertActive(signal);
    const expectedDescriptor = gate.expectedDraftDescriptor(index);
    if (
      expectedDescriptor === null ||
      hashReplayPremiereJson(
        draft.descriptor as unknown as ReplayPremiereJsonValue,
      ) !==
        hashReplayPremiereJson(
          expectedDescriptor as unknown as ReplayPremiereJsonValue,
        ) ||
      hashReplayPremiereJson(
        draft.payload as unknown as ReplayPremiereJsonValue,
      ) !== draft.descriptor.payloadHash
    ) {
      throw projectionFailure("checkpoint_projection_draft_binding_mismatch");
    }
    for (const record of draft.payload.records) {
      if (record.sequence > throughSequence) break;
      const parsed = TurnSchema.strict().safeParse(record.payload);
      if (
        !parsed.success ||
        record.sequence !== expectedSequence ||
        record.turn !== expectedSequence ||
        parsed.data.turnNumber !== expectedSequence
      ) {
        throw projectionFailure("checkpoint_projection_invalid_turn_sequence");
      }
      turns.push(parsed.data);
      expectedSequence += 1;
      if (expectedSequence % PROJECTOR_YIELD_INTERVAL === 0) {
        await yieldToStartupFence(signal);
      }
    }
    // Chunk boundaries are trust-boundary work units even when a configured
    // chunk contains fewer than PROJECTOR_YIELD_INTERVAL records.
    await yieldToStartupFence(signal);
    if (expectedSequence > throughSequence) break;
  }
  if (expectedSequence !== throughSequence + 1) {
    throw projectionFailure("checkpoint_projection_incomplete_turn_prefix");
  }
  return Object.freeze(turns);
}

async function yieldToStartupFence(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertActive(signal);
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw projectionFailure("checkpoint_projection_aborted");
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw projectionFailure("checkpoint_projection_unexpected_fields");
  }
}

function projectionFailure(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    500,
    "Replay Premiere checkpoint eligibility projection failed",
    cause === undefined ? undefined : { cause },
  );
}
