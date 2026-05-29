import { Logger } from "winston";
import { Game } from "../../core/game/Game";
import { GameMapLoader } from "../../core/game/GameMapLoader";
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

  constructor(
    private readonly mapLoader: GameMapLoader,
    private readonly log?: Logger,
  ) {}

  async ingest(messages: ServerMessage[]): Promise<number> {
    await this.ensureRunner(messages);
    if (this.runner === null) {
      return 0;
    }

    for (const message of messages) {
      if (message.type !== "turn") {
        continue;
      }
      if (this.seenTurns.has(message.turn.turnNumber)) {
        continue;
      }
      this.runner.addTurn(message.turn);
      this.seenTurns.add(message.turn.turnNumber);
    }

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
  const pollIntervalMs = options.pollIntervalMs ?? 5;
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
