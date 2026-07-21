import { assetUrl } from "../core/AssetUrls";
import { FetchGameMapLoader } from "../core/game/FetchGameMapLoader";
import { ErrorUpdate, GameUpdateViewData } from "../core/game/GameUpdates";
import { createGameRunner, GameRunner } from "../core/GameRunner";
import { coalesceReplayPremiereGameUpdates } from "./ReplayPremiereUpdateBatch";
import {
  REPLAY_PREMIERE_MAX_TICKS_PER_CATCH_UP_UPDATE,
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
let catchUpDelivery = false;
let catchUpSlices: GameUpdateViewData[] = [];
let catchUpCompletedTurns = 0;
let catchUpTickExecutionDurations: number[] = [];

// Timer callbacks are clamped in background tabs. A MessageChannel task still
// yields after every bounded simulation slice without turning a reconnect into
// one approximately-one-second delay per 128 historical turns.
const drainChannel = new MessageChannel();
drainChannel.port1.onmessage = () => {
  void drain().catch(() => {
    clearCatchUpAccumulator();
    postMessage({
      type: "game_error",
      error: { errMsg: "Replay worker failed", stack: "unavailable" },
    });
  });
};

function postMessage(message: unknown, transfers: Transferable[] = []): void {
  ctx.postMessage(message, transfers);
}

function scheduleDrain(): void {
  drainRequested = true;
  if (drainScheduled || draining) return;
  drainScheduled = true;
  drainChannel.port2.postMessage(null);
}

function postCoalescedUpdate(
  update: GameUpdateViewData,
  completedTurns: number,
  tickExecutionDurations: number[],
): void {
  const transfers: Transferable[] = [update.packedTileUpdates.buffer];
  if (update.packedMotionPlans) {
    transfers.push(update.packedMotionPlans.buffer);
  }
  postMessage(
    {
      type: "game_update_batch",
      gameUpdates: [update],
      completedTurns,
      tickExecutionDurations,
    },
    transfers,
  );
}

function clearCatchUpAccumulator(): void {
  catchUpSlices = [];
  catchUpCompletedTurns = 0;
  catchUpTickExecutionDurations = [];
  catchUpDelivery = false;
}

function flushCatchUpAccumulator(): void {
  if (catchUpSlices.length === 0 || catchUpCompletedTurns === 0) return;
  const coalesced = coalesceReplayPremiereGameUpdates(catchUpSlices);
  if (catchUpTickExecutionDurations.length > 0) {
    coalesced.update.tickExecutionDuration =
      catchUpTickExecutionDurations.reduce(
        (sum, duration) => sum + duration,
        0,
      ) / catchUpTickExecutionDurations.length;
  }
  const completedTurns = catchUpCompletedTurns;
  const tickExecutionDurations = catchUpTickExecutionDurations;
  catchUpSlices = [];
  catchUpCompletedTurns = 0;
  catchUpTickExecutionDurations = [];
  postCoalescedUpdate(coalesced.update, completedTurns, tickExecutionDurations);
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
      if (catchUpDelivery) {
        catchUpSlices.push(coalesced.update);
        catchUpCompletedTurns += coalesced.completedTurns;
        catchUpTickExecutionDurations.push(...coalesced.tickExecutionDurations);
        if (
          catchUpCompletedTurns >=
            REPLAY_PREMIERE_MAX_TICKS_PER_CATCH_UP_UPDATE ||
          runner.pendingTurns() === 0
        ) {
          flushCatchUpAccumulator();
        }
      } else {
        postCoalescedUpdate(
          coalesced.update,
          coalesced.completedTurns,
          coalesced.tickExecutionDurations,
        );
      }
    }
    if (error !== null) {
      clearCatchUpAccumulator();
      postMessage({ type: "game_error", error });
    }
    shouldContinue = error === null && runner.pendingTurns() > 0;
    if (!shouldContinue && catchUpCompletedTurns === 0) {
      catchUpDelivery = false;
    }
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
            catchUpDelivery ||= message.delivery === "catch_up";
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
