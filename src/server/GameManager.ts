import { Logger } from "winston";
import WebSocket from "ws";
import { ServerConfig } from "../core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../core/game/Game";
import { GameConfig, GameID, PublicGameType } from "../core/Schemas";
import { Client } from "./Client";
import { GamePhase, GameServer } from "./GameServer";

export class GameManager {
  private games: Map<GameID, GameServer> = new Map();

  constructor(
    private config: ServerConfig,
    private log: Logger,
  ) {
    setInterval(() => this.tick(), 1000);
  }

  public game(id: GameID): GameServer | null {
    return this.games.get(id) ?? null;
  }

  public publicLobbies(): GameServer[] {
    return Array.from(this.games.values()).filter(
      (g) => g.phase() === GamePhase.Lobby && g.isPublic(),
    );
  }

  joinClient(
    client: Client,
    gameID: GameID,
  ): "joined" | "kicked" | "rejected" | "not_found" {
    const game = this.games.get(gameID);
    if (!game) return "not_found";
    return game.joinClient(client);
  }

  rejoinClient(
    ws: WebSocket,
    persistentID: string,
    gameID: GameID,
    lastTurn: number = 0,
    identityUpdate?: { username: string; clanTag: string | null },
  ): boolean {
    const game = this.games.get(gameID);
    if (!game) return false;
    return game.rejoinClient(ws, persistentID, lastTurn, identityUpdate);
  }

  createGame(
    id: GameID,
    gameConfig: GameConfig | undefined,
    creatorPersistentID?: string,
    startsAt?: number,
    publicGameType?: PublicGameType,
  ): GameServer | null {
    if (gameConfig?.donateToNonFriendly === true) {
      throw new Error(
        "non-friendly donations are reserved for internal Coworld games",
      );
    }
    if (this.games.has(id)) {
      this.log.warn("cannot create game, id already exists", { gameID: id });
      return null;
    }

    const game = new GameServer(
      id,
      this.log,
      Date.now(),
      this.config,
      {
        donateGold: false,
        donateTroops: false,
        gameMap: GameMapType.World,
        gameType: GameType.Private,
        gameMapSize: GameMapSize.Normal,
        difficulty: Difficulty.Easy,
        nations: "default",
        infiniteGold: false,
        infiniteTroops: false,
        maxTimerValue: undefined,
        instantBuild: false,
        randomSpawn: false,
        gameMode: GameMode.FFA,
        bots: 400,
        disabledUnits: [],
        ...gameConfig,
      },
      creatorPersistentID,
      startsAt,
      publicGameType,
    );
    this.games.set(id, game);
    return game;
  }

  activeGames(): number {
    return this.games.size;
  }

  activeClients(): number {
    let totalClients = 0;
    this.games.forEach((game: GameServer) => {
      totalClients += game.activeClients.length;
    });
    return totalClients;
  }

  desyncCount(): number {
    return [...this.games.values()].reduce(
      (acc, game) => acc + game.numDesyncedClients(),
      0,
    );
  }

  tick() {
    const active = new Map<GameID, GameServer>();
    for (const [id, game] of this.games) {
      const phase = game.phase();
      if (phase === GamePhase.Active) {
        if (!game.hasStarted()) {
          // Prestart tells clients to start loading the game.
          game.prestart();
          // Start game on delay to allow time for clients to connect.
          setTimeout(() => {
            try {
              game.start();
            } catch (error) {
              this.log.error(`error starting game ${id}: ${error}`);
              // A game that cannot start MUST NOT linger. `prestart()` above already
              // set the prestart flag, and `hasStarted()` is
              // `_hasStarted || _hasPrestarted`, so the guard at the top of this loop
              // will never retry it: without this, clients that were told to start
              // loading wait forever and the entry leaks in `this.games`. End it so
              // sockets close with a definitive reason and the next tick drops it.
              // Nothing to archive - it never produced a turn.
              void game
                .end({ archive: false })
                .catch((endError: unknown) =>
                  this.log.error(
                    `error ending unstartable game ${id}: ${endError}`,
                  ),
                );
              this.games.delete(id);
            }
          }, 2000);
        }
      }

      if (phase === GamePhase.Finished) {
        try {
          game.end();
        } catch (error) {
          this.log.error(`error ending game ${id}: ${error}`);
        }
      } else {
        active.set(id, game);
      }
    }
    this.games = active;
  }
}
