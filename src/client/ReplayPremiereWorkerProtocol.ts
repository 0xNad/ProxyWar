import type { GameUpdateViewData } from "../core/game/GameUpdates";
import type { ClientID, GameStartInfo, Turn } from "../core/Schemas";
import type {
  MainThreadMessage,
  WorkerMessage,
} from "../core/worker/WorkerMessages";

export const REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE = 128;
export const REPLAY_PREMIERE_MAX_TICKS_PER_CATCH_UP_UPDATE = 4_096;

export type ReplayPremiereWorkerCommand =
  | {
      type: "init";
      id: string;
      gameStartInfo: GameStartInfo;
      clientID: ClientID | undefined;
      cdnBase: string;
    }
  | {
      type: "turn_batch";
      turns: Turn[];
      delivery: "live" | "catch_up";
    }
  | Exclude<MainThreadMessage, { type: "init" } | { type: "turn" }>;

export type ReplayPremiereWorkerInboundMessage =
  | Exclude<WorkerMessage, { type: "game_update_batch" }>
  | {
      type: "game_update_batch";
      gameUpdates: [GameUpdateViewData];
      completedTurns: number;
      tickExecutionDurations: number[];
    }
  | {
      type: "initialization_error";
      id: string;
    };
