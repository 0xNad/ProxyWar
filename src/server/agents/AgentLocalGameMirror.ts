import { Logger } from "winston";
import { Game } from "../../core/game/Game";
import { GameMapLoader } from "../../core/game/GameMapLoader";
import { TerrainMapData } from "../../core/game/TerrainMapLoader";
import { createGameRunner, GameRunner } from "../../core/GameRunner";
import { ServerMessage } from "../../core/Schemas";

export interface WaitForMirrorStateOptions {
  mirror: AgentLocalGameMirror;
  messages: () => ServerMessage[];
  until: (game: Game, mirror: AgentLocalGameMirror) => boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class AgentLocalGameMirror {
  private runner: GameRunner | null = null;
  private readonly seenTurns = new Set<number>();
  // Cursor into the append-only server-message history. Ingest processes only
  // messages past this index, keeping TOTAL ingest work O(messages) instead of
  // O(messages^2) under the per-tick catch-up poll — the long-game OOM driver
  // (AGENT-02) that made the 4-player FFA episode OOM as decision steps grew.
  private consumedCount = 0;

  /**
   * `preloadedTerrain` (optional) is handed straight to `createGameRunner`,
   * so the mirror's game runs on an already-loaded map dataset instead of
   * loading a second full copy. Ownership transfers with it: the game mutates
   * tile state in place, so the instance must be loaded for this match's
   * exact map + size and must never seed another game.
   */
  constructor(
    private readonly mapLoader: GameMapLoader,
    private readonly log?: Logger,
    private readonly preloadedTerrain?: TerrainMapData,
  ) {}

  async ingest(messages: ServerMessage[]): Promise<number> {
    await this.ensureRunner(messages);
    if (this.runner === null) {
      return 0;
    }

    // Only walk messages we have not consumed yet (append-only history, so the
    // cursor is stable across the growing snapshots passed each poll).
    const start = this.consumedCount < messages.length ? this.consumedCount : 0;
    for (let i = start; i < messages.length; i++) {
      const message = messages[i];
      if (message.type !== "turn") {
        continue;
      }
      if (this.seenTurns.has(message.turn.turnNumber)) {
        continue;
      }
      this.runner.addTurn(message.turn);
      this.seenTurns.add(message.turn.turnNumber);
    }
    this.consumedCount = messages.length;

    return this.executePendingTurns();
  }

  gameState(): Game | null {
    return this.runner?.game ?? null;
  }

  turnCount(): number {
    return this.seenTurns.size;
  }

  pendingTurns(): number {
    return this.runner?.pendingTurns() ?? 0;
  }

  private async ensureRunner(messages: ServerMessage[]): Promise<void> {
    if (this.runner !== null) {
      return;
    }

    const start = messages.find((message) => message.type === "start");
    if (start === undefined || start.type !== "start") {
      return;
    }

    this.runner = await createGameRunner(
      start.gameStartInfo,
      undefined,
      this.mapLoader,
      () => undefined,
      this.preloadedTerrain,
    );
    this.log?.info("agent local game mirror initialized", {
      gameID: start.gameStartInfo.gameID,
      players: start.gameStartInfo.players.length,
    });
  }

  private executePendingTurns(maxTicks = 100_000): number {
    if (this.runner === null) {
      return 0;
    }

    let ticks = 0;
    while (this.runner.pendingTurns() > 0 && ticks < maxTicks) {
      this.runner.executeNextTick(this.runner.pendingTurns());
      ticks++;
    }
    if (this.runner.pendingTurns() > 0) {
      throw new Error(
        `agent local game mirror could not catch up; ${this.runner.pendingTurns()} turns still pending after ${maxTicks} ticks`,
      );
    }
    return ticks;
  }
}

export async function waitForMirrorState(
  options: WaitForMirrorStateOptions,
): Promise<Game> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  // 5ms was an aggressive poll: each poll re-copies the entire server-message
  // history (serverMessages() => [...sentMessages]), so a tight poll over a long
  // game is the dominant transient-allocation / GC-thrash source behind the
  // long-game OOM. 50ms is far below the decision cadence (max_decision_ms ~15s)
  // and cuts that copy churn ~10x with no observable latency cost.
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    await options.mirror.ingest(options.messages());
    const game = options.mirror.gameState();
    if (game !== null && options.until(game, options.mirror)) {
      return game;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error("timed out waiting for agent local game mirror state");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
