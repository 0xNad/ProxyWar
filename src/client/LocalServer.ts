import { z } from "zod";
import { EventBus } from "../core/EventBus";
import {
  AllPlayersStats,
  ClientID,
  ClientMessage,
  ClientSendWinnerMessage,
  GameStartInfoSchema,
  PartialGameRecordSchema,
  PlayerRecord,
  ServerMessage,
  ServerStartGameMessage,
  StampedIntent,
  Turn,
} from "../core/Schemas";
import {
  createPartialGameRecord,
  decompressGameRecord,
  replacer,
} from "../core/Util";
import { getPersistentID } from "./Auth";
import { LobbyConfig } from "./ClientGameRunner";
import {
  GameSpeedDownIntentEvent,
  GameSpeedUpIntentEvent,
  ReplayJumpToTurnEvent,
  ReplaySpeedChangeEvent,
} from "./InputHandler";
import {
  ReplayPremierePlaybackEvent,
  ReplayPremiereReleasedTurn,
} from "./ReplayPremierePlayback";
import {
  defaultReplaySpeedMultiplier,
  ReplaySpeedMultiplier,
} from "./utilities/ReplaySpeedMultiplier";

// Order: 0.5, 1, 2, max (same as ReplayPanel)
const SPEED_ORDER: ReplaySpeedMultiplier[] = [
  ReplaySpeedMultiplier.slow,
  ReplaySpeedMultiplier.normal,
  ReplaySpeedMultiplier.fast,
  ReplaySpeedMultiplier.fastest,
];

// build a small backlog so MAX can catch up.
const MAX_REPLAY_BACKLOG_TURNS = 60;
// A late-join catch-up must never enqueue an unbounded replay in one main-
// thread loop. The premiere-only worker accepts turns in bounded batches and
// drains them without rendering every intermediate frame, so keep enough work
// in flight to avoid starving that worker while acknowledgements refill the
// window one turn at a time.
export const MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS = 4_096;
const StrictGameStartInfoSchema = GameStartInfoSchema.strict();

export class LocalServer {
  // All turns from the game record on replay.
  private replayTurns: Turn[] = [];

  private turns: Turn[] = [];

  private intents: StampedIntent[] = [];
  private startedAt: number;

  private paused = false;
  private replaySpeedMultiplier: number = defaultReplaySpeedMultiplier;

  private progressiveReplayTurns: Readonly<ReplayPremiereReleasedTurn>[] = [];
  private progressiveReplayTurnsByTurnNumber = new Map<number, Turn>();
  private progressiveReplayFinalized = false;
  private progressiveReplayPendingCatchUp: number | null = null;
  private progressiveReplayUnsubscribe: (() => void) | null = null;
  private progressiveReplayPlaybackComplete = false;
  private running = false;

  private clientID: ClientID | undefined;
  private winner: ClientSendWinnerMessage | null = null;
  private allPlayersStats: AllPlayersStats = {};

  private turnsExecuted = 0;
  private turnStartTime = 0;

  private turnCheckInterval: NodeJS.Timeout;
  private clientConnect: () => void;
  private clientMessage: (message: ServerMessage) => void;

  constructor(
    private lobbyConfig: LobbyConfig,
    private isReplay: boolean,
    private eventBus: EventBus,
  ) {}

  public updateCallback(
    clientConnect: () => void,
    clientMessage: (message: ServerMessage) => void,
  ) {
    this.clientConnect = clientConnect;
    this.clientMessage = clientMessage;
  }

  start() {
    console.log("local server starting");
    const progressiveReplay = this.lobbyConfig.progressiveReplay;
    if (progressiveReplay) {
      const safeStartInfo = StrictGameStartInfoSchema.safeParse(
        this.lobbyConfig.gameStartInfo,
      );
      if (!safeStartInfo.success) {
        throw new Error("invalid progressive replay gameStartInfo");
      }
      // Use the parsed clone so unknown/outcome-bearing fields supplied by an
      // untrusted public response never cross into the real game client.
      this.lobbyConfig.gameStartInfo = safeStartInfo.data;
      this.progressiveReplayUnsubscribe =
        progressiveReplay.controller.subscribe((event) =>
          this.onProgressiveReplayEvent(event),
        );
    }
    if (this.lobbyConfig.gameRecord) {
      this.replayTurns = decompressGameRecord(
        this.lobbyConfig.gameRecord,
      ).turns;
    }
    const clipPreviewTarget = this.lobbyConfig.replayClipPreviewTarget;
    if (clipPreviewTarget !== undefined) {
      if (
        !this.isReplay ||
        this.lobbyConfig.gameRecord === undefined ||
        progressiveReplay !== undefined ||
        !Number.isSafeInteger(clipPreviewTarget) ||
        clipPreviewTarget <= 0 ||
        clipPreviewTarget > this.replayTurns.length
      ) {
        throw new Error("invalid replay clip preview target");
      }
      // Preview is a fresh-document exact-anchor contract. Retain the target
      // prefix before the pacing interval exists and start paused, so neither
      // normal pacing nor MAX backlog can enqueue target + 1. The client
      // receives this prefix on its rejoin and may advance only after an
      // explicit unpause.
      this.turns = this.replayTurns
        .slice(0, clipPreviewTarget)
        .map((turn, turnNumber) => ({
          turnNumber,
          intents: turn.intents,
        }));
      this.paused = true;
    }
    this.turnCheckInterval = setInterval(() => {
      const turnIntervalMs = this.progressiveReplayDelayForNextTurn();
      // Starvation is a visible state, not a silent freeze: a null delay on
      // an unfinalized progressive replay means the dispatcher has exhausted
      // released content (frontier stall / network hiccup). Report it so the
      // premiere overlay can show "Buffering live…"; the next released batch
      // resumes dispatch automatically and clears the flag on this same tick.
      if (this.lobbyConfig.progressiveReplay) {
        this.lobbyConfig.progressiveReplay.controller.reportDispatchStarvation(
          turnIntervalMs === null && !this.progressiveReplayFinalized,
        );
      }
      const backlog = Math.max(0, this.turns.length - this.turnsExecuted);
      const allowReplayBacklog =
        this.replaySpeedMultiplier === ReplaySpeedMultiplier.fastest &&
        this.lobbyConfig.gameRecord !== undefined;
      const maxBacklog = allowReplayBacklog ? MAX_REPLAY_BACKLOG_TURNS : 0;

      const canQueueNextTurn =
        backlog === 0 || (maxBacklog > 0 && backlog < maxBacklog);
      if (
        canQueueNextTurn &&
        turnIntervalMs !== null &&
        Date.now() >= this.turnStartTime + turnIntervalMs
      ) {
        this.advanceTurnDeadline(turnIntervalMs);
        // End turn on the server means the client will start processing the turn.
        this.endTurn();
      }
    }, 5);

    this.eventBus.on(ReplaySpeedChangeEvent, (event) => {
      if (
        this.lobbyConfig.progressiveReplay &&
        !this.progressiveReplayFinalized
      ) {
        return;
      }
      this.replaySpeedMultiplier = event.replaySpeedMultiplier;
    });
    this.eventBus.on(ReplayJumpToTurnEvent, (event) => {
      this.jumpReplayForward(event.turnNumber);
    });

    if (!this.isReplay) {
      this.eventBus.on(GameSpeedUpIntentEvent, () => {
        const idx = SPEED_ORDER.indexOf(this.replaySpeedMultiplier);
        if (idx < 0 || idx >= SPEED_ORDER.length - 1) return;
        this.replaySpeedMultiplier = SPEED_ORDER[idx + 1];
        this.eventBus.emit(
          new ReplaySpeedChangeEvent(this.replaySpeedMultiplier),
        );
      });

      this.eventBus.on(GameSpeedDownIntentEvent, () => {
        const idx = SPEED_ORDER.indexOf(this.replaySpeedMultiplier);
        if (idx <= 0) return;
        this.replaySpeedMultiplier = SPEED_ORDER[idx - 1];
        this.eventBus.emit(
          new ReplaySpeedChangeEvent(this.replaySpeedMultiplier),
        );
      });
    }

    this.startedAt = Date.now();
    if (progressiveReplay) {
      this.turnStartTime = this.startedAt;
    }
    this.clientConnect();
    if (this.lobbyConfig.gameStartInfo === undefined) {
      throw new Error("missing gameStartInfo");
    }
    this.clientID = this.lobbyConfig.gameStartInfo.players[0]?.clientID;
    if (!this.clientID) {
      throw new Error("missing clientID");
    }
    this.clientMessage({
      type: "start",
      gameStartInfo: this.lobbyConfig.gameStartInfo,
      turns: this.turns,
      lobbyCreatedAt: this.lobbyConfig.gameStartInfo.lobbyCreatedAt,
      // Don't send myClientID for replays — viewer has no player identity.
      myClientID: this.isReplay ? undefined : this.clientID,
    } satisfies ServerStartGameMessage);
    this.running = true;
    this.runPendingProgressiveCatchUp();
  }

  onMessage(clientMsg: ClientMessage) {
    if (clientMsg.type === "rejoin") {
      if (!this.clientID) {
        throw new Error("missing clientID");
      }
      this.clientMessage({
        type: "start",
        gameStartInfo: this.lobbyConfig.gameStartInfo!,
        turns: this.turns,
        lobbyCreatedAt: this.lobbyConfig.gameStartInfo!.lobbyCreatedAt,
        myClientID: this.isReplay ? undefined : this.clientID,
      } satisfies ServerStartGameMessage);
    }
    if (clientMsg.type === "intent") {
      // A premiere is controlled only by the authoritative release stream.
      // Local pause/action intents must never add a synthetic turn at a
      // checkpoint boundary.
      if (this.lobbyConfig.progressiveReplay) {
        return;
      }
      // Server stamps clientID - client doesn't send it
      const stampedIntent = {
        ...clientMsg.intent,
        clientID: this.clientID!,
      };
      if (stampedIntent.type === "toggle_pause") {
        if (stampedIntent.paused) {
          // Pausing: add intent and end turn before pause takes effect
          this.intents.push(stampedIntent);
          this.endTurn();
          this.paused = true;
        } else {
          // Unpausing: clear pause flag before adding intent so next turn can execute
          this.paused = false;
          this.intents.push(stampedIntent);
          this.endTurn();
        }
        return;
      }
      // Don't process non-pause intents during replays or while paused
      if (this.isReplay || this.paused) {
        return;
      }

      this.intents.push(stampedIntent);
    }
    if (clientMsg.type === "hash") {
      if (!this.isReplay) {
        if (clientMsg.turnNumber % 100 === 0) {
          // In singleplayer, only store hash every 100 turns to reduce size of game record.
          const turn = this.turns[clientMsg.turnNumber];
          if (turn) {
            turn.hash = clientMsg.hash;
          }
        }
        return;
      }
      // If we are replaying a game then verify hash.
      const archivedHash = this.lobbyConfig.progressiveReplay
        ? this.progressiveReplayTurnsByTurnNumber.get(clientMsg.turnNumber)
            ?.hash
        : this.replayTurns[clientMsg.turnNumber]?.hash;
      if (archivedHash === undefined || archivedHash === null) {
        console.warn(
          `no archived hash found for turn ${clientMsg.turnNumber}, client hash: ${clientMsg.hash}`,
        );
        return;
      }
      if (archivedHash !== clientMsg.hash) {
        console.error(
          `desync detected on turn ${clientMsg.turnNumber}, client hash: ${clientMsg.hash}, server hash: ${archivedHash}`,
        );
        this.clientMessage({
          type: "desync",
          turn: clientMsg.turnNumber,
          correctHash: archivedHash,
          clientsWithCorrectHash: 0,
          totalActiveClients: 1,
          yourHash: clientMsg.hash,
        });
      } else {
        console.log(
          `hash verified on turn ${clientMsg.turnNumber}, client hash: ${clientMsg.hash}, server hash: ${archivedHash}`,
        );
      }
    }
    if (clientMsg.type === "winner") {
      this.winner = clientMsg;
      this.allPlayersStats = clientMsg.allPlayersStats;
    }
  }

  // This is so the client can tell us when it finished processing the turn.
  public turnComplete() {
    this.turnsComplete(1);
  }

  public turnsComplete(completedTurns: number) {
    const outstandingTurns = this.turns.length - this.turnsExecuted;
    if (
      !Number.isSafeInteger(completedTurns) ||
      completedTurns < 1 ||
      completedTurns > MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS ||
      completedTurns > outstandingTurns
    ) {
      throw new Error("invalid completed replay turn count");
    }
    this.turnsExecuted += completedTurns;
    this.runPendingProgressiveCatchUp();
    this.finishProgressiveReplayIfReady();
  }

  // endTurn in this context means the server has collected all the intents
  // and will send the turn to the client.
  private endTurn(force = false) {
    if (this.paused && !force) {
      return;
    }
    if (this.lobbyConfig.progressiveReplay) {
      this.endProgressiveReplayTurn();
      return;
    }
    if (this.replayTurns.length > 0) {
      if (this.turns.length >= this.replayTurns.length) {
        this.endGame();
        return;
      }
      this.intents = this.replayTurns[this.turns.length].intents;
    }
    const pastTurn: Turn = {
      turnNumber: this.turns.length,
      intents: this.intents,
    };
    this.turns.push(pastTurn);
    this.intents = [];
    this.clientMessage({
      type: "turn",
      turn: pastTurn,
    });
  }

  private onProgressiveReplayEvent(event: ReplayPremierePlaybackEvent) {
    if (event.type === "batch") {
      const expectedSequence =
        this.progressiveReplayTurns.at(-1)?.sequence === undefined
          ? 0
          : this.progressiveReplayTurns.at(-1)!.sequence + 1;
      const expectedTurnNumber = this.progressiveReplayTurns.length;
      for (const [offset, record] of event.batch.records.entries()) {
        if (
          record.sequence !== expectedSequence + offset ||
          record.turn.turnNumber !== expectedTurnNumber + offset
        ) {
          throw new Error("invalid progressive replay batch order");
        }
        this.progressiveReplayTurnsByTurnNumber.set(
          record.turn.turnNumber,
          record.turn,
        );
        this.progressiveReplayTurns.push(record);
      }
      return;
    }
    if (event.type === "catch-up") {
      this.progressiveReplayPendingCatchUp = Math.max(
        this.progressiveReplayPendingCatchUp ?? event.targetSequence,
        event.targetSequence,
      );
      this.runPendingProgressiveCatchUp();
      return;
    }
    if (event.type === "finalized") {
      this.progressiveReplayFinalized = true;
      this.finishProgressiveReplayIfReady();
    }
  }

  private endProgressiveReplayTurn() {
    const record = this.progressiveReplayTurns[this.turns.length];
    if (!record) {
      // An unreleased boundary is a wait state, not replay completion.
      this.finishProgressiveReplayIfReady();
      return;
    }
    this.turns.push(record.turn);
    this.clientMessage({
      type: "turn",
      turn: record.turn,
    });
    this.lobbyConfig.progressiveReplay!.controller.acknowledgeDispatchedRecord(
      record,
    );
  }

  private progressiveReplayDelayForNextTurn(): number | null {
    if (!this.lobbyConfig.progressiveReplay) {
      return (
        this.lobbyConfig.serverConfig.turnIntervalMs() *
        this.replaySpeedMultiplier
      );
    }
    const next = this.progressiveReplayTurns[this.turns.length];
    if (next === undefined) return null;
    const previousOffset =
      this.turns.length === 0
        ? 0
        : this.progressiveReplayTurns[this.turns.length - 1]
            .presentationOffsetMs;
    return Math.max(0, next.presentationOffsetMs - previousOffset);
  }

  private advanceTurnDeadline(turnIntervalMs: number) {
    const now = Date.now();
    if (!this.lobbyConfig.progressiveReplay) {
      // Preserve the existing wall-clock pacing for games and plain replays.
      this.turnStartTime = now;
      return;
    }

    const scheduledDeadline = this.turnStartTime + turnIntervalMs;
    // Premiere intervals come from the verified release stream. Keep their
    // cumulative schedule through normal timer overshoot instead of adding
    // that overshoot to every turn. If the main thread missed a full verified
    // interval, rebase at now so a long stall cannot create a burst of overdue
    // turns that starves rendering.
    this.turnStartTime =
      now - scheduledDeadline < turnIntervalMs ? scheduledDeadline : now;
  }

  private runPendingProgressiveCatchUp() {
    if (
      !this.running ||
      this.progressiveReplayPendingCatchUp === null ||
      !this.lobbyConfig.progressiveReplay
    ) {
      return;
    }
    const targetSequence = this.progressiveReplayPendingCatchUp;
    let availableWindow = Math.max(
      0,
      MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS -
        (this.turns.length - this.turnsExecuted),
    );
    while (availableWindow > 0) {
      const nextRecord = this.progressiveReplayTurns[this.turns.length];
      if (!nextRecord || nextRecord.sequence > targetSequence) {
        break;
      }
      this.endProgressiveReplayTurn();
      availableWindow -= 1;
    }
    const lastDispatchedSequence =
      this.progressiveReplayTurns[this.turns.length - 1]?.sequence ?? -1;
    if (lastDispatchedSequence >= targetSequence) {
      this.progressiveReplayPendingCatchUp = null;
    }
    this.turnStartTime = Date.now();
    this.finishProgressiveReplayIfReady();
  }

  private finishProgressiveReplayIfReady() {
    if (
      !this.lobbyConfig.progressiveReplay ||
      !this.progressiveReplayFinalized ||
      this.progressiveReplayPlaybackComplete ||
      this.turns.length !== this.progressiveReplayTurns.length ||
      this.turnsExecuted < this.turns.length
    ) {
      return;
    }
    this.progressiveReplayPlaybackComplete = true;
    clearInterval(this.turnCheckInterval);
    this.lobbyConfig.progressiveReplay.controller.markPlaybackComplete();
    this.progressiveReplayUnsubscribe?.();
    this.progressiveReplayUnsubscribe = null;
  }

  private jumpReplayForward(turnNumber: number) {
    if (this.lobbyConfig.progressiveReplay) {
      // Before reveal, only the authoritative release stream may advance the
      // client. Once the complete chain is verified, match the ordinary replay
      // behavior and allow forward-only seeking through already accepted turns.
      if (
        !this.progressiveReplayFinalized ||
        this.progressiveReplayTurns.length === 0
      ) {
        return;
      }
      const targetTurn = Math.max(
        this.turns.length,
        Math.min(this.progressiveReplayTurns.length, Math.floor(turnNumber)),
      );
      while (this.turns.length < targetTurn) {
        this.endProgressiveReplayTurn();
      }
      this.turnStartTime = Date.now();
      return;
    }
    if (!this.lobbyConfig.gameRecord || this.replayTurns.length === 0) {
      return;
    }
    const targetTurn = Math.max(
      this.turns.length,
      Math.min(this.replayTurns.length, Math.floor(turnNumber)),
    );
    while (this.turns.length < targetTurn) {
      this.endTurn(true);
    }
    this.turnStartTime = Date.now();
  }

  public endGame() {
    console.log("local server ending game");
    this.running = false;
    clearInterval(this.turnCheckInterval);
    this.progressiveReplayUnsubscribe?.();
    this.progressiveReplayUnsubscribe = null;
    if (this.isReplay) {
      return;
    }
    const players: PlayerRecord[] = [
      {
        persistentID: getPersistentID(),
        username: this.lobbyConfig.playerName,
        clanTag: this.lobbyConfig.playerClanTag ?? null,
        clientID: this.clientID!,
        stats: this.allPlayersStats[this.clientID!],
        cosmetics: this.lobbyConfig.gameStartInfo?.players[0].cosmetics,
      },
    ];
    if (this.lobbyConfig.gameStartInfo === undefined) {
      throw new Error("missing gameStartInfo");
    }
    const record = createPartialGameRecord(
      this.lobbyConfig.gameStartInfo.gameID,
      this.lobbyConfig.gameStartInfo.config,
      players,
      this.turns,
      this.startedAt,
      Date.now(),
      this.winner?.winner,
    );

    const result = PartialGameRecordSchema.safeParse(record);
    if (!result.success) {
      const error = z.prettifyError(result.error);
      console.error("Error parsing game record", error);
      return;
    }
    const workerPath = this.lobbyConfig.serverConfig.workerPath(
      this.lobbyConfig.gameStartInfo.gameID,
    );

    const jsonString = JSON.stringify(result.data, replacer);

    compress(jsonString)
      .then((compressedData) => {
        return fetch(`/${workerPath}/api/archive_singleplayer_game`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
          },
          body: compressedData,
          keepalive: true, // Ensures request completes even if page unloads
        });
      })
      .catch((error) => {
        console.error("Failed to archive singleplayer game:", error);
      });
  }
}

async function compress(data: string): Promise<ArrayBuffer> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  // Write the data to the compression stream
  writer.write(new TextEncoder().encode(data));
  writer.close();

  // Read the compressed data
  const chunks: Uint8Array[] = [];
  let done = false;
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    if (value) {
      chunks.push(value);
    }
  }

  // Combine all chunks into a single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const compressedData = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    compressedData.set(chunk, offset);
    offset += chunk.length;
  }

  return compressedData.buffer;
}
