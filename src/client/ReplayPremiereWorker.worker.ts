import { assetUrl } from "../core/AssetUrls";
import { FetchGameMapLoader } from "../core/game/FetchGameMapLoader";
import { ErrorUpdate, GameUpdateViewData } from "../core/game/GameUpdates";
import { createGameRunner, GameRunner } from "../core/GameRunner";
import { coalesceReplayPremiereGameUpdates } from "./ReplayPremiereUpdateBatch";
import {
  REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE,
  ReplayPremiereWorkerCommand,
} from "./ReplayPremiereWorkerProtocol";

const ctx: Worker = self as any;
globalThis.__ASSET_MANIFEST__ = __ASSET_MANIFEST__;
const mapLoader = new FetchGameMapLoader((path) => assetUrl(`maps/${path}`));

let gameRunner: Promise<GameRunner> | null = null;
let tickUpdateSink:
  | ((update: GameUpdateViewData | ErrorUpdate) => void)
  | null = null;
let drainScheduled = false;
let draining = false;
let drainRequested = false;

function postMessage(message: unknown, transfers: Transferable[] = []): void {
  ctx.postMessage(message, transfers);
}

function scheduleDrain(): void {
  drainRequested = true;
  if (drainScheduled || draining) return;
  drainScheduled = true;
  setTimeout(() => {
    void drain().catch(() => {
      postMessage({
        type: "game_error",
        error: { errMsg: "Replay worker failed", stack: "unavailable" },
      });
    });
  }, 0);
}

async function drain(): Promise<void> {
  drainScheduled = false;
  if (draining || gameRunner === null) return;
  draining = true;
  drainRequested = false;
  let shouldContinue: boolean;
  try {
    const runner = await gameRunner;
    const updates: GameUpdateViewData[] = [];
    let error: ErrorUpdate | null = null;
    tickUpdateSink = (update) => {
      if ("updates" in update) updates.push(update);
      else error = update;
    };
    let ticksRun = 0;
    while (
      ticksRun < REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE &&
      runner.pendingTurns() > 0 &&
      error === null
    ) {
      if (!runner.executeNextTick(runner.pendingTurns())) break;
      ticksRun += 1;
    }
    tickUpdateSink = null;
    if (updates.length > 0) {
      const coalesced = coalesceReplayPremiereGameUpdates(updates);
      const transfers: Transferable[] = [];
      transfers.push(coalesced.update.packedTileUpdates.buffer);
      if (coalesced.update.packedMotionPlans) {
        transfers.push(coalesced.update.packedMotionPlans.buffer);
      }
      postMessage(
        {
          type: "game_update_batch",
          gameUpdates: [coalesced.update],
          completedTurns: coalesced.completedTurns,
          tickExecutionDurations: coalesced.tickExecutionDurations,
        },
        transfers,
      );
    }
    if (error !== null) postMessage({ type: "game_error", error });
    shouldContinue = error === null && runner.pendingTurns() > 0;
  } finally {
    tickUpdateSink = null;
    draining = false;
  }
  if (shouldContinue || drainRequested) scheduleDrain();
}

function gameUpdate(update: GameUpdateViewData | ErrorUpdate): void {
  tickUpdateSink?.(update);
}

ctx.addEventListener(
  "message",
  (event: MessageEvent<ReplayPremiereWorkerCommand>) => {
    const message = event.data;
    if (message.type === "init") {
      if (gameRunner !== null) {
        postMessage({ type: "initialization_error", id: message.id });
        return;
      }
      globalThis.__CDN_BASE__ = message.cdnBase;
      const pending = createGameRunner(
        message.gameStartInfo,
        message.clientID,
        mapLoader,
        gameUpdate,
      );
      gameRunner = pending;
      void pending.then(
        () => postMessage({ type: "initialized", id: message.id }),
        () => {
          gameRunner = null;
          postMessage({ type: "initialization_error", id: message.id });
        },
      );
      return;
    }
    if (gameRunner === null) {
      postMessage({
        type: "game_error",
        error: {
          errMsg: "Replay worker not initialized",
          stack: "unavailable",
        },
      });
      return;
    }
    void gameRunner.then((runner) => {
      try {
        switch (message.type) {
          case "turn_batch":
            for (const turn of message.turns) runner.addTurn(turn);
            scheduleDrain();
            return;
          case "player_actions":
            postMessage({
              type: "player_actions_result",
              id: message.id,
              result: runner.playerActions(
                message.playerID,
                message.x,
                message.y,
                message.units,
              ),
            });
            return;
          case "player_buildables":
            postMessage({
              type: "player_buildables_result",
              id: message.id,
              result: runner.playerBuildables(
                message.playerID,
                message.x,
                message.y,
                message.units,
              ),
            });
            return;
          case "player_profile":
            postMessage({
              type: "player_profile_result",
              id: message.id,
              result: runner.playerProfile(message.playerID),
            });
            return;
          case "player_border_tiles":
            postMessage({
              type: "player_border_tiles_result",
              id: message.id,
              result: runner.playerBorderTiles(message.playerID),
            });
            return;
          case "attack_clustered_positions":
            postMessage({
              type: "attack_clustered_positions_result",
              id: message.id,
              attacks: runner.attackClusteredPositions(
                message.playerID,
                message.attackID,
              ),
            });
            return;
          case "transport_ship_spawn":
            postMessage({
              type: "transport_ship_spawn_result",
              id: message.id,
              result: runner.bestTransportShipSpawn(
                message.playerID,
                message.targetTile,
              ),
            });
            return;
        }
      } catch {
        if (message.type === "attack_clustered_positions") {
          postMessage({
            type: "attack_clustered_positions_result",
            id: message.id,
            attacks: [],
          });
          return;
        }
        if (message.type === "transport_ship_spawn") {
          postMessage({
            type: "transport_ship_spawn_result",
            id: message.id,
            result: false,
          });
          return;
        }
        postMessage({
          type: "game_error",
          error: { errMsg: "Replay worker failed", stack: "unavailable" },
        });
      }
    });
  },
);
