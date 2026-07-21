import { getCdnBase } from "../core/AssetUrls";
import {
  BuildableUnit,
  Cell,
  PlayerActions,
  PlayerBorderTiles,
  PlayerBuildableUnitType,
  PlayerID,
  PlayerProfile,
} from "../core/game/Game";
import { TileRef } from "../core/game/GameMap";
import { ErrorUpdate, GameUpdateViewData } from "../core/game/GameUpdates";
import { ClientID, GameStartInfo, Turn } from "../core/Schemas";
import { generateID } from "../core/Util";
import { WorkerMessage } from "../core/worker/WorkerMessages";
import ReplayPremiereWorker from "./ReplayPremiereWorker.worker.ts?worker&inline";
import {
  REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE,
  ReplayPremiereWorkerInboundMessage,
} from "./ReplayPremiereWorkerProtocol";

export const REPLAY_PREMIERE_TURN_BATCH_SIZE = 4_096;

interface ReplayPremiereWorkerLike {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ReplayPremiereWorkerInboundMessage>) => void,
  ): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface ReplayPremiereWorkerClientDependencies {
  workerFactory?: () => ReplayPremiereWorkerLike;
  enqueueMicrotask?: (callback: () => void) => void;
}

/**
 * Premiere-only simulation transport.
 *
 * It uses the canonical core GameRunner in a dedicated worker, but batches
 * verified turn ingress and worker updates so a reconnect does not pay one
 * browser task and one render per historical turn. It cannot fetch replay
 * material and receives turns only through LocalServer's verified controller.
 */
export class ReplayPremiereWorkerClient {
  private readonly worker: ReplayPremiereWorkerLike;
  private readonly enqueueMicrotask: (callback: () => void) => void;
  private readonly pendingTurns: Turn[] = [];
  private readonly initializationHandlers = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly messageHandlers = new Map<
    string,
    { handle: (message: WorkerMessage) => void; reject: (error: Error) => void }
  >();

  private gameUpdateCallback?: (
    update: GameUpdateViewData | ErrorUpdate,
  ) => void;
  private flushScheduled = false;
  private currentCompletedTurns = 1;
  private currentTickExecutionDurations: readonly number[] | undefined;
  private initialized = false;
  private disposed = false;

  constructor(
    private readonly gameStartInfo: GameStartInfo,
    private readonly clientID: ClientID | undefined,
    dependencies: ReplayPremiereWorkerClientDependencies = {},
  ) {
    this.worker =
      dependencies.workerFactory?.() ??
      (new ReplayPremiereWorker() as ReplayPremiereWorkerLike);
    this.enqueueMicrotask =
      dependencies.enqueueMicrotask ??
      globalThis.queueMicrotask.bind(globalThis);
    this.worker.addEventListener("message", (event) =>
      this.handleWorkerMessage(event),
    );
  }

  initialize(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Replay worker is unavailable"));
    }
    return new Promise((resolve, reject) => {
      const messageId = generateID();
      const timeout = globalThis.setTimeout(() => {
        if (this.initializationHandlers.delete(messageId)) {
          const error = new Error("Worker initialization timeout");
          reject(error);
          this.disposeWorker(error);
        }
      }, 60_000);
      this.initializationHandlers.set(messageId, {
        resolve: () => {
          globalThis.clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          globalThis.clearTimeout(timeout);
          reject(error);
        },
      });
      this.worker.postMessage({
        type: "init",
        id: messageId,
        gameStartInfo: this.gameStartInfo,
        clientID: this.clientID,
        cdnBase: getCdnBase(),
      });
    });
  }

  start(gameUpdate: (update: GameUpdateViewData | ErrorUpdate) => void): void {
    if (!this.initialized || this.disposed) {
      throw new Error("Failed to initialize replay worker");
    }
    this.gameUpdateCallback = gameUpdate;
  }

  sendTurn(turn: Turn): void {
    if (!this.initialized || this.disposed) {
      throw new Error("Replay worker not initialized");
    }
    this.pendingTurns.push(turn);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.enqueueMicrotask(() => this.flushPendingTurns());
  }

  playerProfile(playerID: number): Promise<PlayerProfile> {
    return this.request(
      { type: "player_profile", playerID },
      "player_profile_result",
      (message) =>
        message.type === "player_profile_result" ? message.result : undefined,
    );
  }

  playerBorderTiles(playerID: PlayerID): Promise<PlayerBorderTiles> {
    return this.request(
      { type: "player_border_tiles", playerID },
      "player_border_tiles_result",
      (message) =>
        message.type === "player_border_tiles_result"
          ? message.result
          : undefined,
    );
  }

  playerInteraction(
    playerID: PlayerID,
    x?: number,
    y?: number,
    units?: readonly PlayerBuildableUnitType[] | null,
  ): Promise<PlayerActions> {
    return this.request(
      { type: "player_actions", playerID, x, y, units },
      "player_actions_result",
      (message) =>
        message.type === "player_actions_result" ? message.result : undefined,
    );
  }

  playerBuildables(
    playerID: PlayerID,
    x?: number,
    y?: number,
    units?: readonly PlayerBuildableUnitType[],
  ): Promise<BuildableUnit[]> {
    return this.request(
      { type: "player_buildables", playerID, x, y, units },
      "player_buildables_result",
      (message) =>
        message.type === "player_buildables_result"
          ? message.result
          : undefined,
    );
  }

  attackClusteredPositions(
    playerID: number,
    attackID?: string,
  ): Promise<{ id: string; positions: Cell[] }[]> {
    return this.request(
      { type: "attack_clustered_positions", playerID, attackID },
      "attack_clustered_positions_result",
      (message) =>
        message.type === "attack_clustered_positions_result"
          ? message.attacks.map((attack) => ({
              id: attack.id,
              positions: attack.positions.map(
                (position) => new Cell(position.x, position.y),
              ),
            }))
          : undefined,
      5_000,
    );
  }

  transportShipSpawn(
    playerID: PlayerID,
    targetTile: TileRef,
  ): Promise<TileRef | false> {
    return this.request(
      { type: "transport_ship_spawn", playerID, targetTile },
      "transport_ship_spawn_result",
      (message) =>
        message.type === "transport_ship_spawn_result"
          ? message.result
          : undefined,
    );
  }

  /** Logical turns represented by the update currently entering GameView. */
  completedTurnsForCurrentUpdate(): number {
    return this.currentCompletedTurns;
  }

  /** Exact per-turn execution samples represented by the current update. */
  tickExecutionDurationsForCurrentUpdate(): readonly number[] | undefined {
    return this.currentTickExecutionDurations;
  }

  cleanup(): void {
    this.disposeWorker(new Error("Replay worker is unavailable"));
  }

  private handleWorkerMessage(
    event: MessageEvent<ReplayPremiereWorkerInboundMessage>,
  ): void {
    if (this.disposed) return;
    const message = event.data;
    if (message.type === "initialized" && message.id !== undefined) {
      const handler = this.initializationHandlers.get(message.id);
      if (!handler) return;
      this.initializationHandlers.delete(message.id);
      this.initialized = true;
      handler.resolve();
      return;
    }
    if (message.type === "initialization_error") {
      const handler = this.initializationHandlers.get(message.id);
      if (!handler) return;
      this.initializationHandlers.delete(message.id);
      const error = new Error("Worker initialization failed");
      handler.reject(error);
      this.disposeWorker(error);
      return;
    }
    if (message.type === "game_error") {
      this.gameUpdateCallback?.(message.error);
      return;
    }
    if (message.type === "game_update") {
      this.gameUpdateCallback?.(message.gameUpdate);
      return;
    }
    if (message.type !== "game_update_batch") {
      if (message.id === undefined) return;
      const handler = this.messageHandlers.get(message.id);
      if (!handler) return;
      this.messageHandlers.delete(message.id);
      handler.handle(message);
      return;
    }
    const callback = this.gameUpdateCallback;
    if (!callback) return;
    if (
      message.gameUpdates.length !== 1 ||
      !Number.isSafeInteger(message.completedTurns) ||
      message.completedTurns < 1 ||
      message.completedTurns > REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE ||
      message.tickExecutionDurations.length !== message.completedTurns ||
      message.tickExecutionDurations.some(
        (duration) => !Number.isFinite(duration) || duration < 0,
      )
    ) {
      callback({ errMsg: "Replay worker failed", stack: "unavailable" });
      return;
    }
    this.currentCompletedTurns = message.completedTurns;
    this.currentTickExecutionDurations = message.tickExecutionDurations;
    try {
      callback(message.gameUpdates[0]);
    } finally {
      this.currentCompletedTurns = 1;
      this.currentTickExecutionDurations = undefined;
    }
  }

  private flushPendingTurns(): void {
    this.flushScheduled = false;
    if (this.disposed || this.pendingTurns.length === 0) return;
    while (this.pendingTurns.length > 0) {
      this.worker.postMessage({
        type: "turn_batch",
        turns: this.pendingTurns.splice(0, REPLAY_PREMIERE_TURN_BATCH_SIZE),
      });
    }
  }

  private request<T>(
    request: Record<string, unknown>,
    expectedType: WorkerMessage["type"],
    extract: (message: WorkerMessage) => T | undefined,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.initialized || this.disposed) {
      return Promise.reject(new Error("Replay worker not initialized"));
    }
    return new Promise((resolve, reject) => {
      const messageId = generateID();
      const timeout =
        timeoutMs === undefined
          ? undefined
          : globalThis.setTimeout(() => {
              if (this.messageHandlers.delete(messageId)) {
                reject(new Error(`${request.type} request timed out`));
              }
            }, timeoutMs);
      const rejectRequest = (error: Error) => {
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
        reject(error);
      };
      this.messageHandlers.set(messageId, {
        reject: rejectRequest,
        handle: (message) => {
          if (timeout !== undefined) globalThis.clearTimeout(timeout);
          if (message.type !== expectedType) {
            reject(
              new Error(
                `Unexpected replay worker response: expected ${expectedType}, received ${message.type}`,
              ),
            );
            return;
          }
          const result = extract(message);
          if (result === undefined) {
            reject(new Error(`Replay worker response missing result`));
            return;
          }
          resolve(result);
        },
      });
      this.worker.postMessage({ ...request, id: messageId });
    });
  }

  private disposeWorker(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.initialized = false;
    this.pendingTurns.length = 0;
    for (const handler of this.initializationHandlers.values()) {
      handler.reject(error);
    }
    this.initializationHandlers.clear();
    for (const handler of this.messageHandlers.values()) {
      handler.reject(error);
    }
    this.messageHandlers.clear();
    this.gameUpdateCallback = undefined;
    this.worker.terminate();
  }
}
