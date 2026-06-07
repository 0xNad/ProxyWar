import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const localRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const proxyWarRepo = process.env.PROXYWAR_REPO ?? "/app/proxywar";
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require(
  `${proxyWarRepo}/node_modules/ws`,
);
const winston = require(`${proxyWarRepo}/node_modules/winston`);

type LegalActionView = {
  id: string;
  kind: string;
  label: string;
  risk?: { level?: string; score?: number };
  metadata?: Record<string, unknown>;
};

type PendingDecision = {
  resolve: (decision: {
    actionID: string;
    reason: string;
    metadata: Record<string, unknown>;
  }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  legalActions: LegalActionView[];
};

type CoworldConfig = {
  tokens: string[];
  players: Array<{ name: string }>;
  max_decision_steps: number;
  turns_per_decision_step: number;
  max_decision_ms: number;
  map: string;
  map_size: string;
  difficulty: string;
  replay_tail_turns?: number;
  player_connect_timeout_seconds?: number;
};

type CoworldResults = {
  scores: number[];
  winner_slot: number | null;
  turn_count: number | null;
  tick: number | null;
  decision_count: number;
  accepted_decision_count: number;
  fallback_count: number;
  players: Array<{
    slot: number;
    name: string;
    score: number;
    tiles_owned: number | null;
    is_alive: boolean | null;
  }>;
};

class CoworldProtocolServer {
  private readonly server = http.createServer((request, response) =>
    this.handleHttp(request, response),
  );
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly players = new Map<number, InstanceType<typeof WebSocket>>();
  private readonly pending = new Map<string, PendingDecision>();
  private readonly globalSockets = new Set<InstanceType<typeof WebSocket>>();
  private readonly replaySockets = new Set<InstanceType<typeof WebSocket>>();
  private readonly snapshots: unknown[] = [];
  private spectatorMap: Record<string, unknown> | null = null;
  private spectatorReplay: Record<string, unknown> | null = null;
  private replayPayload: unknown = null;
  private portValue: number | null = null;

  constructor(private readonly config: CoworldConfig) {
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/player") {
        this.handlePlayerUpgrade(request, socket, head, url);
        return;
      }
      if (url.pathname === "/global") {
        this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
          this.globalSockets.add(websocket);
          websocket.on("close", () => this.globalSockets.delete(websocket));
          websocket.send(
            JSON.stringify(
              this.statusSnapshot("global-connected", this.latestSnapshot()),
            ),
          );
        });
        return;
      }
      if (url.pathname === "/replay") {
        this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
          this.replaySockets.add(websocket);
          websocket.on("close", () => this.replaySockets.delete(websocket));
          websocket.send(
            JSON.stringify({
              type: "replay",
              replay: this.replayPayload,
            }),
          );
        });
        return;
      }
      socket.destroy();
    });
  }

  async listen(host = "127.0.0.1", port = 0): Promise<number> {
    await new Promise<void>((resolve) => {
      this.server.listen(port, host, resolve);
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Coworld protocol server did not bind to a TCP port");
    }
    this.portValue = address.port;
    return address.port;
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Coworld protocol server closed"));
    }
    this.pending.clear();
    for (const websocket of this.players.values()) {
      websocket.close();
    }
    for (const websocket of this.globalSockets) {
      websocket.close();
    }
    for (const websocket of this.replaySockets) {
      websocket.close();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  port(): number {
    if (this.portValue === null) {
      throw new Error("Coworld protocol server is not listening");
    }
    return this.portValue;
  }

  playerUrl(slot: number, host = "127.0.0.1"): string {
    const token = this.config.tokens[slot];
    return `ws://${host}:${this.port()}/player?slot=${slot}&token=${encodeURIComponent(
      token,
    )}`;
  }

  async waitForPlayers(): Promise<void> {
    const deadline =
      Date.now() +
      Math.max(1, this.config.player_connect_timeout_seconds ?? 30) * 1000;
    while (Date.now() < deadline) {
      if (this.players.size >= this.config.tokens.length) {
        return;
      }
      await sleep(50);
    }
    throw new Error(
      `Timed out waiting for ${this.config.tokens.length} Coworld players; connected=${this.players.size}`,
    );
  }

  brainForSlot(slot: number, buildRequestPayload: (input: unknown) => unknown) {
    const server = this;
    return {
      brainType: "external-http",
      async decide(input: unknown) {
        return server.decide(slot, buildRequestPayload(input));
      },
    };
  }

  recordSnapshot(
    snapshot: unknown,
    map: Record<string, unknown> | null = null,
  ): void {
    if (map !== null) {
      this.spectatorMap = map;
    }
    this.snapshots.push(snapshot);
    this.broadcastGlobal(this.statusSnapshot("snapshot", snapshot));
  }

  setReplayPayload(payload: unknown): void {
    this.replayPayload = publicReplayPayload(payload);
    const spectatorReplay = spectatorReplayFromPayload(this.replayPayload);
    if (spectatorReplay !== null) {
      this.spectatorReplay = spectatorReplay;
      this.spectatorMap = spectatorMapFromReplay(spectatorReplay);
      if (this.snapshots.length === 0) {
        this.snapshots.push(...spectatorSnapshotsFromReplay(spectatorReplay));
      }
    }
    this.broadcastReplay();
    this.broadcastGlobal(
      this.statusSnapshot("replay-ready", this.latestSnapshot()),
    );
  }

  sendFinal(): void {
    for (const [slot, websocket] of this.players.entries()) {
      websocket.send(JSON.stringify({ type: "final", slot }));
    }
  }

  private async decide(
    slot: number,
    request: unknown,
  ): Promise<{
    actionID: string;
    reason: string;
    metadata: Record<string, unknown>;
  }> {
    const websocket = this.players.get(slot);
    if (websocket === undefined || websocket.readyState !== WebSocket.OPEN) {
      throw new Error(`Coworld player slot ${slot} is not connected`);
    }
    const requestRecord = request as { legalActions?: LegalActionView[] };
    const legalActions = Array.isArray(requestRecord.legalActions)
      ? requestRecord.legalActions
      : [];
    const requestID = `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const timeoutMs = Math.max(250, this.config.max_decision_ms);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestID);
        reject(
          new Error(
            `Coworld player slot ${slot} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(requestID, {
        resolve,
        reject,
        timeout,
        legalActions,
      });
      websocket.send(
        JSON.stringify({
          type: "decision_request",
          requestID,
          slot,
          request,
        }),
      );
    });
  }

  private handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/client/player") {
      writeHtml(response, coworldPlayerClientHtml());
      return;
    }
    if (url.pathname === "/client/global") {
      writeHtml(response, coworldGlobalClientHtml());
      return;
    }
    if (url.pathname === "/client/replay") {
      writeHtml(response, coworldReplayClientHtml());
      return;
    }
    writeJson(response, 404, { error: "not found" });
  }

  private handlePlayerUpgrade(
    request: http.IncomingMessage,
    socket: Parameters<
      InstanceType<typeof WebSocketServer>["handleUpgrade"]
    >[1],
    head: Buffer,
    url: URL,
  ): void {
    const slot = Number(url.searchParams.get("slot"));
    const token = url.searchParams.get("token") ?? "";
    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= this.config.tokens.length ||
      this.config.tokens[slot] !== token
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
      this.players.set(slot, websocket);
      websocket.on("message", (data) => this.handlePlayerMessage(slot, data));
      websocket.on("close", () => {
        if (this.players.get(slot) === websocket) {
          this.players.delete(slot);
        }
      });
      websocket.send(
        JSON.stringify({
          type: "hello",
          slot,
          protocol: "proxywar-coworld-poc-v1",
        }),
      );
      this.broadcastGlobal(this.statusSnapshot(`player-${slot}-connected`));
    });
  }

  private handlePlayerMessage(slot: number, data: Buffer): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(data));
    } catch (error) {
      throw new Error(`Coworld player slot ${slot} sent invalid JSON`);
    }
    if (message.type !== "decision_response") {
      return;
    }
    const requestID = String(message.requestID ?? "");
    const pending = this.pending.get(requestID);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(requestID);
    const selectedLegalActionId = String(message.selectedLegalActionId ?? "");
    pending.resolve({
      actionID: selectedLegalActionId,
      reason:
        typeof message.reason === "string"
          ? message.reason.slice(0, 500)
          : "Coworld player returned no reason.",
      metadata: {
        brain: "coworld-websocket",
        externalActionCall: true,
        parseSuccess: true,
        fallbackUsed: false,
        coworldSlot: slot,
        coworldRequestID: requestID,
        rawProviderOutputPresent: true,
        externalRawOutput: JSON.stringify(message).slice(0, 1000),
        offeredLegalActionCount: pending.legalActions.length,
        confidence:
          typeof message.confidence === "number"
            ? message.confidence
            : undefined,
      },
    });
  }

  private statusSnapshot(
    event: string,
    latestSnapshot: unknown = null,
  ): Record<string, unknown> {
    return {
      type: "state",
      event,
      connectedPlayers: this.players.size,
      requiredPlayers: this.config.tokens.length,
      snapshotCount: this.snapshots.length,
      replayReady: this.replayPayload !== null,
      config: publicCoworldConfig(this.config),
      map: this.spectatorMap,
      snapshot: latestSnapshot,
      spectatorReplay: this.spectatorReplay,
    };
  }

  private broadcastGlobal(snapshot: Record<string, unknown>): void {
    for (const websocket of this.globalSockets) {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify(snapshot));
      }
    }
  }

  private broadcastReplay(): void {
    for (const websocket of this.replaySockets) {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.send(
          JSON.stringify({
            type: "replay",
            replay: this.replayPayload,
          }),
        );
      }
    }
  }

  private latestSnapshot(): unknown {
    return this.snapshots[this.snapshots.length - 1] ?? null;
  }
}

class StaticMapLoader {
  private readonly maps = new Map<string, unknown>();
  private readonly rootDir = path.join(proxyWarRepo, "resources", "maps");

  getMapData(map: string) {
    const cached = this.maps.get(map);
    if (cached !== undefined) {
      return cached;
    }
    const mapDir = path.join(this.rootDir, this.mapDirectoryName(map));
    const mapData = {
      mapBin: () => fs.readFile(path.join(mapDir, "map.bin")),
      map4xBin: () => fs.readFile(path.join(mapDir, "map4x.bin")),
      map16xBin: () => fs.readFile(path.join(mapDir, "map16x.bin")),
      manifest: async () =>
        JSON.parse(
          await fs.readFile(path.join(mapDir, "manifest.json"), "utf8"),
        ),
      webpPath: path.join(mapDir, "thumbnail.webp"),
    };
    this.maps.set(map, mapData);
    return mapData;
  }

  private mapDirectoryName(map: string): string {
    return String(map).toLowerCase().replace(/\s+/g, "");
  }
}

async function main(): Promise<void> {
  if (process.env.COWORLD_PREWARM === "1") {
    await runCoworldPrewarm();
    return;
  }
  if (process.env.COGAME_LOAD_REPLAY_URI) {
    await runCoworldReplayContainer();
    return;
  }
  if (
    process.env.COGAME_CONFIG_URI &&
    process.env.COGAME_RESULTS_URI &&
    process.env.COGAME_SAVE_REPLAY_URI
  ) {
    await runCoworldGameContainer();
    return;
  }
  await runStandaloneNoDockerProof();
}

async function runCoworldPrewarm(): Promise<void> {
  const modules = await loadProxyWarModules();
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "coworld-prewarm",
        loadedModules: Object.keys(modules).length,
      },
      null,
      2,
    ),
  );
}

async function runStandaloneNoDockerProof(): Promise<void> {
  const config = await loadConfig();
  const workspace = await createWorkspace("no-docker-runs");
  const server = new CoworldProtocolServer(config);
  const port = await server.listen();
  const playerProcesses = startPlayers(config, server);
  try {
    await runRouteChecks(port, config);
    await server.waitForPlayers();
    const result = await runProxyWarEpisode(config, workspace, server);
    server.setReplayPayload(result.replayPayload);
    await fs.writeFile(
      path.join(workspace, "results.json"),
      `${JSON.stringify(result.results, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(workspace, "replay"),
      `${JSON.stringify(result.replayPayload, null, 2)}\n`,
    );
    await runReplayChecks(port);
    server.sendFinal();
    await waitForPlayersToExit(playerProcesses);
    await fs.writeFile(
      path.join(workspace, "poc-report.md"),
      pocReport({
        workspace,
        results: result.results,
        proxyWarArtifactDir: result.proxyWarArtifactDir,
      }),
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          proof: "no-docker-coworld-shaped-proxywar-episode",
          workspace,
          resultsPath: path.join(workspace, "results.json"),
          replayPath: path.join(workspace, "replay"),
          proxyWarArtifactDir: result.proxyWarArtifactDir,
          officialCoworldCertification: "not-run-by-no-docker-command",
        },
        null,
        2,
      ),
    );
  } finally {
    for (const child of playerProcesses) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
    }
    await server.close();
  }
}

async function runCoworldGameContainer(): Promise<void> {
  const config = await loadConfig();
  const workspace = await createCoworldWorkspace();
  const server = new CoworldProtocolServer(config);
  const host = process.env.COGAME_HOST ?? "0.0.0.0";
  const port = Number(process.env.COGAME_PORT ?? "8080");
  await server.listen(host, port);
  try {
    await server.waitForPlayers();
    const result = await runProxyWarEpisode(config, workspace, server);
    server.setReplayPayload(result.replayPayload);
    await writeUri(
      requiredEnv("COGAME_RESULTS_URI"),
      `${JSON.stringify(result.results, null, 2)}\n`,
      "application/json",
    );
    await writeUri(
      requiredEnv("COGAME_SAVE_REPLAY_URI"),
      `${JSON.stringify(result.replayPayload, null, 2)}\n`,
      "application/json",
    );
    server.sendFinal();
    await sleep(200);
    console.log(
      JSON.stringify(
        {
          ok: true,
          proof: "coworld-container-proxywar-episode",
          workspace,
          proxyWarArtifactDir: result.proxyWarArtifactDir,
        },
        null,
        2,
      ),
    );
  } finally {
    await server.close();
  }
}

async function runCoworldReplayContainer(): Promise<void> {
  const replayPayload = await readReplayPayload(
    requiredEnv("COGAME_LOAD_REPLAY_URI"),
  );
  const config =
    replayConfig(replayPayload) ??
    ({
      tokens: [],
      players: [],
      max_decision_steps: 1,
      turns_per_decision_step: 1,
      max_decision_ms: 1000,
      map: "Pangaea",
      map_size: "Compact",
      difficulty: "Easy",
      player_connect_timeout_seconds: 1,
    } satisfies CoworldConfig);
  const server = new CoworldProtocolServer(config);
  server.setReplayPayload(replayPayload);
  const host = process.env.COGAME_HOST ?? "0.0.0.0";
  const port = Number(process.env.COGAME_PORT ?? "8080");
  await server.listen(host, port);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "coworld-replay-container",
        replayReady: true,
      },
      null,
      2,
    ),
  );
  await waitForever();
}

async function runProxyWarEpisode(
  config: CoworldConfig,
  workspace: string,
  protocolServer: CoworldProtocolServer,
): Promise<{
  results: CoworldResults;
  replayPayload: Record<string, unknown>;
  proxyWarArtifactDir: string;
}> {
  const modules = await loadProxyWarModules();
  const log = winston.createLogger({
    level: "warn",
    format: winston.format.simple(),
    transports: [new winston.transports.Console()],
  });
  const selectedGameConfig = {
    gameMap: enumValue(modules.GameMapType, config.map),
    gameMapSize: enumValue(modules.GameMapSize, config.map_size),
    gameMode: modules.GameMode.FFA,
    gameType: modules.GameType.Private,
    difficulty: enumValue(modules.Difficulty, config.difficulty),
    nations: "disabled",
    donateGold: true,
    donateTroops: true,
    bots: 0,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    disabledUnits: [],
    startingGold: 200000,
    maxPlayers: config.tokens.length,
  };
  const game = new modules.GameServer(
    "COWRLD01",
    log,
    Date.now(),
    {
      turnIntervalMs: () => 60 * 60 * 1000,
      env: () => modules.GameEnv.Dev,
    },
    selectedGameConfig,
  );
  const startedAt = Date.now();
  const mapLoader = new StaticMapLoader();
  const terrain = await modules.loadTerrainMap(
    selectedGameConfig.gameMap,
    selectedGameConfig.gameMapSize,
    mapLoader,
  );
  const spawnCandidates = modules.buildSpawnCandidates(terrain.gameMap, {
    maxCandidates: 1000,
    stride: 2,
  });
  const profiles = ["aggressive", "defensive", "diplomatic", "opportunistic"];
  const specs = config.players.map((player, index) => ({
    username: player.name.slice(0, modules.proxyWarGameUsernameMaxLength ?? 27),
    profile: profiles[index % profiles.length],
    persistentID: randomUUID(),
  }));
  const participants = modules.createAgentParticipants(specs, log, {
    brainFactory: (spec: unknown, index: number) =>
      protocolServer.brainForSlot(
        index,
        modules.buildExternalAgentRequestPayload,
      ),
  });
  const roster = agentRunRoster(participants);
  const spectatorSnapshots: unknown[] = [];
  const mirror = new modules.AgentLocalGameMirror(mapLoader, log);
  const mirrorMessages = () => participants[0]?.runner.serverMessages() ?? [];
  const league = new modules.AgentLeagueMatchRunner({
    game,
    participants,
    spawnCandidates,
    log,
  });

  try {
    league.attachAgents();
    league.startGame();
    const stepResult = await modules.runAgentStepLockedLeague({
      league,
      game,
      mirror,
      messages: mirrorMessages,
      config: {
        maxSteps: config.max_decision_steps,
        turnsPerDecisionStep: config.turns_per_decision_step,
        maxDecisionMs: config.max_decision_ms,
        requireWinner: false,
        waitForMirrorCatchup: true,
      },
      onSnapshot: (snapshot: {
        label: string;
        turnNumber: number;
        gameState: any;
        records: unknown[];
      }) => {
        const spectatorSnapshot = modules.buildAgentSpectatorSnapshot({
          ...snapshot,
          roster,
        });
        spectatorSnapshots.push(spectatorSnapshot);
        protocolServer.recordSnapshot(spectatorSnapshot, {
          width: snapshot.gameState.width(),
          height: snapshot.gameState.height(),
          gameMap: String(snapshot.gameState.config().gameConfig().gameMap),
          gameMapSize: String(
            snapshot.gameState.config().gameConfig().gameMapSize,
          ),
        });
      },
      log,
    });
    const completedAt = Date.now();
    const finalState = finalKnownState({
      participants,
      gameState: stepResult.finalGameState,
      turnCount: mirror.turnCount(),
    });
    const gameRecord = modules.buildGameRecordFromServerMessages({
      messages: mirrorMessages(),
      startedAt,
      completedAt,
    });
    const runID = `coworld-poc-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const runNote = process.env.COGAME_RESULTS_URI
      ? "Coworld container POC harness."
      : "Local no-Docker Coworld-shaped POC harness.";
    const certificationNote = process.env.COGAME_RESULTS_URI
      ? "This episode ran through Coworld's game/player container env contract."
      : "Official Coworld certification is not part of this no-Docker command.";
    const spectatorReplay = modules.buildAgentSpectatorReplay({
      runID,
      matchID: game.id,
      scenario: "coworld-poc",
      brainMode: "external-http",
      runnerMode: "step-locked",
      finalGameState: stepResult.finalGameState,
      roster,
      snapshots: spectatorSnapshots,
      notes: [runNote, certificationNote],
    });
    const artifacts = await modules.writeAgentLeagueRunArtifacts({
      runID,
      matchID: game.id,
      scenario: "coworld-poc",
      brainMode: "external-http",
      runnerMode: "step-locked",
      runnerConfig: {
        turnsPerDecisionStep: stepResult.turnsPerDecisionStep,
        maxDecisionMs: stepResult.maxDecisionMs,
        maxSteps: config.max_decision_steps,
        stepsCompleted: stepResult.stepsCompleted,
        mirrorCatchupSucceeded: stepResult.mirrorCatchupSucceeded,
        onlyHoldReason: stepResult.onlyHoldReason,
        agents: specs.length,
        bots: 0,
        nations: "disabled",
        map: selectedGameConfig.gameMap,
        mapSize: selectedGameConfig.gameMapSize,
        difficulty: selectedGameConfig.difficulty,
        variedSpawns: false,
      },
      startedAt,
      completedAt,
      records: league.decisionRecords(),
      roster,
      finalState,
      spectatorReplay,
      gameRecord,
      rootDir: path.join(workspace, "proxywar-runs"),
      notes: [runNote, certificationNote],
    });
    const compactSpectatorReplay =
      artifacts.spectatorReplayPath === null
        ? spectatorReplay
        : JSON.parse(await fs.readFile(artifacts.spectatorReplayPath, "utf8"));
    const results = coworldResults({
      config,
      finalState,
      records: league.decisionRecords(),
    });
    return {
      results,
      replayPayload: {
        schemaVersion: 1,
        replayKind: "proxywar-coworld-local-poc",
        runID,
        matchID: game.id,
        config: publicCoworldConfig(config),
        results,
        finalState,
        proxyWarArtifacts: artifacts,
        spectatorReplay: compactSpectatorReplay,
        spectatorSnapshotCount: spectatorSnapshots.length,
      },
      proxyWarArtifactDir: artifacts.directory,
    };
  } finally {
    await game.end({ archive: false });
  }
}

async function loadProxyWarModules(): Promise<Record<string, any>> {
  const [
    configMod,
    gameMod,
    terrainMod,
    gameServerMod,
    leagueMod,
    mirrorMod,
    stepLockedMod,
    spectatorMod,
    logWriterMod,
    externalMod,
    manifestMod,
  ] = await Promise.all([
    importProxyWar("src/core/configuration/Config.ts"),
    importProxyWar("src/core/game/Game.ts"),
    importProxyWar("src/core/game/TerrainMapLoader.ts"),
    importProxyWar("src/server/GameServer.ts"),
    importProxyWar("src/server/agents/AgentLeagueMatch.ts"),
    importProxyWar("src/server/agents/AgentLocalGameMirror.ts"),
    importProxyWar("src/server/agents/AgentStepLockedLeague.ts"),
    importProxyWar("src/server/agents/AgentSpectatorReplay.ts"),
    importProxyWar("src/server/agents/AgentDecisionLogWriter.ts"),
    importProxyWar("src/server/agents/ExternalHttpAgentBrain.ts"),
    importProxyWar("src/server/agents/AgentManifest.ts"),
  ]);
  return {
    ...configMod,
    ...gameMod,
    ...terrainMod,
    ...gameServerMod,
    ...leagueMod,
    ...mirrorMod,
    ...stepLockedMod,
    ...spectatorMod,
    ...logWriterMod,
    ...externalMod,
    ...manifestMod,
  };
}

function importProxyWar(relativePath: string): Promise<Record<string, any>> {
  return import(pathToFileURL(path.join(proxyWarRepo, relativePath)).href);
}

function startPlayers(
  config: CoworldConfig,
  protocolServer: CoworldProtocolServer,
): ChildProcess[] {
  return config.tokens.map((_token, slot) =>
    spawn(
      process.execPath,
      [path.join(localRoot, "src", "starter-player.mjs")],
      {
        cwd: localRoot,
        env: {
          ...process.env,
          PROXYWAR_REPO: proxyWarRepo,
          COWORLD_PLAYER_WS_URL: protocolServer.playerUrl(slot),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).on("error", (error) => {
      throw error;
    }),
  );
}

async function waitForPlayersToExit(children: ChildProcess[]): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          let stderr = "";
          child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.stdout?.on("data", (chunk) => {
            process.stdout.write(`[player ${child.pid}] ${chunk}`);
          });
          child.on("close", (code) => {
            if (code === 0 || code === null) {
              resolve();
            } else {
              reject(
                new Error(`player ${child.pid} exited ${code}: ${stderr}`),
              );
            }
          });
        }),
    ),
  );
}

async function runRouteChecks(
  port: number,
  config: CoworldConfig,
): Promise<void> {
  await requireHttpOk(`http://127.0.0.1:${port}/healthz`);
  await requireHttpOk(`http://127.0.0.1:${port}/client/global`);
  await requireHttpOk(
    `http://127.0.0.1:${port}/client/player?slot=0&token=${encodeURIComponent(
      config.tokens[0],
    )}`,
  );
  await requireBadPlayerRejected(
    `ws://127.0.0.1:${port}/player?slot=0&token=bad`,
  );
  await requireWebSocketMessage(`ws://127.0.0.1:${port}/global`);
}

async function runReplayChecks(port: number): Promise<void> {
  await requireHttpOk(`http://127.0.0.1:${port}/client/replay`);
  const message = await requireWebSocketMessage(
    `ws://127.0.0.1:${port}/replay`,
  );
  const parsed = JSON.parse(message);
  if (parsed.type !== "replay" || parsed.replay === null) {
    throw new Error("/replay did not return a replay payload");
  }
}

async function requireHttpOk(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
}

async function requireBadPlayerRejected(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const websocket = new WebSocket(url);
    let opened = false;
    const timeout = setTimeout(() => {
      websocket.close();
      reject(new Error(`Bad player token was not rejected: ${url}`));
    }, 2000);
    websocket.on("open", () => {
      opened = true;
    });
    websocket.on("close", () => {
      clearTimeout(timeout);
      if (opened) {
        reject(new Error(`Bad player token opened before close: ${url}`));
      } else {
        resolve();
      }
    });
    websocket.on("error", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function requireWebSocketMessage(url: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const websocket = new WebSocket(url);
    const timeout = setTimeout(() => {
      websocket.close();
      reject(new Error(`Timed out waiting for websocket message: ${url}`));
    }, 5000);
    websocket.on("message", (data) => {
      clearTimeout(timeout);
      const text = String(data);
      websocket.close();
      resolve(text);
    });
    websocket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function loadConfig(): Promise<CoworldConfig> {
  if (process.env.COGAME_CONFIG_URI) {
    const raw = await readUri(process.env.COGAME_CONFIG_URI);
    return JSON.parse(raw);
  }
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(localRoot, "coworld", "coworld_manifest.json"),
      "utf8",
    ),
  );
  return {
    ...manifest.certification.game_config,
    tokens: ["local-token-slot-0", "local-token-slot-1"],
  };
}

async function readUri(uri: string): Promise<string> {
  return (await readUriBuffer(uri)).toString("utf8");
}

async function readUriBuffer(uri: string): Promise<Buffer> {
  if (uri.startsWith("file://")) {
    return await fs.readFile(new URL(uri));
  }
  if (/^https?:\/\//.test(uri)) {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`${uri} returned HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return await fs.readFile(uri);
}

async function writeUri(
  uri: string,
  body: string | Buffer,
  contentType: string,
): Promise<void> {
  if (uri.startsWith("file://")) {
    const filePath = new URL(uri);
    await fs.mkdir(path.dirname(filePath.pathname), { recursive: true });
    await fs.writeFile(filePath, body);
    return;
  }
  if (/^https?:\/\//.test(uri)) {
    const response = await fetch(uri, {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
    });
    if (!response.ok) {
      throw new Error(`${uri} returned HTTP ${response.status}`);
    }
    return;
  }
  await fs.mkdir(path.dirname(uri), { recursive: true });
  await fs.writeFile(uri, body);
}

async function readReplayPayload(uri: string): Promise<unknown> {
  const raw = await readUriBuffer(uri);
  const inflated = uri.endsWith(".z") ? zlib.inflateSync(raw) : raw;
  return JSON.parse(inflated.toString("utf8"));
}

function publicCoworldConfig(config: CoworldConfig): Record<string, unknown> {
  return {
    players: config.players,
    max_decision_steps: config.max_decision_steps,
    turns_per_decision_step: config.turns_per_decision_step,
    max_decision_ms: config.max_decision_ms,
    map: config.map,
    map_size: config.map_size,
    difficulty: config.difficulty,
    replay_tail_turns: config.replay_tail_turns,
    player_connect_timeout_seconds: config.player_connect_timeout_seconds,
    player_count: config.tokens.length,
  };
}

function publicReplayPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (record.config === null || typeof record.config !== "object") {
    return payload;
  }
  return {
    ...record,
    config: publicConfigRecord(record.config as Record<string, unknown>),
  };
}

function publicConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { tokens, ...publicConfig } = config;
  const players = Array.isArray(config.players) ? config.players : [];
  return {
    ...publicConfig,
    player_count:
      typeof config.player_count === "number"
        ? config.player_count
        : Array.isArray(tokens)
          ? tokens.length
          : players.length,
  };
}

function spectatorReplayFromPayload(
  payload: unknown,
): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const replay = (payload as Record<string, unknown>).spectatorReplay;
  if (replay === null || typeof replay !== "object" || Array.isArray(replay)) {
    return null;
  }
  return replay as Record<string, unknown>;
}

function spectatorMapFromReplay(
  replay: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (
    replay === null ||
    replay.map === null ||
    typeof replay.map !== "object"
  ) {
    return null;
  }
  return replay.map as Record<string, unknown>;
}

function spectatorSnapshotsFromReplay(
  replay: Record<string, unknown>,
): unknown[] {
  return Array.isArray(replay.snapshots) ? replay.snapshots : [];
}

function replayConfig(payload: unknown): CoworldConfig | null {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "config" in payload &&
    (payload as { config?: unknown }).config !== null &&
    typeof (payload as { config?: unknown }).config === "object"
  ) {
    const config = (payload as { config: Record<string, unknown> }).config;
    const players = Array.isArray(config.players)
      ? (config.players as Array<{ name: string }>)
      : [];
    const playerCount =
      typeof config.player_count === "number"
        ? config.player_count
        : players.length;
    return {
      tokens: Array.from({ length: playerCount }, () => ""),
      players,
      max_decision_steps: Number(config.max_decision_steps ?? 1),
      turns_per_decision_step: Number(config.turns_per_decision_step ?? 1),
      max_decision_ms: Number(config.max_decision_ms ?? 1000),
      map: String(config.map ?? "Pangaea"),
      map_size: String(config.map_size ?? "Compact"),
      difficulty: String(config.difficulty ?? "Easy"),
      replay_tail_turns:
        typeof config.replay_tail_turns === "number"
          ? config.replay_tail_turns
          : undefined,
      player_connect_timeout_seconds:
        typeof config.player_connect_timeout_seconds === "number"
          ? config.player_connect_timeout_seconds
          : 1,
    };
  }
  return null;
}

async function createWorkspace(kind: string): Promise<string> {
  const root = path.join(localRoot, "artifacts", kind);
  await fs.mkdir(root, { recursive: true });
  const workspace = path.join(
    root,
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(workspace, "logs"), { recursive: true });
  return workspace;
}

async function createCoworldWorkspace(): Promise<string> {
  const resultsPath = filePathFromUri(process.env.COGAME_RESULTS_URI ?? "");
  if (resultsPath !== null) {
    const workspace = path.dirname(resultsPath);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(workspace, "proxywar-runs"), { recursive: true });
    return workspace;
  }
  return await createWorkspace("coworld-container-runs");
}

function filePathFromUri(uri: string): string | null {
  if (uri.startsWith("file://")) {
    return new URL(uri).pathname;
  }
  if (uri !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    return uri;
  }
  return null;
}

function coworldResults(input: {
  config: CoworldConfig;
  finalState: ReturnType<typeof finalKnownState>;
  records: any[];
}): CoworldResults {
  const totalTiles = input.finalState.players.reduce(
    (sum, player) => sum + Math.max(0, player.tilesOwned ?? 0),
    0,
  );
  const winnerIndex = input.finalState.players.findIndex((player) =>
    input.finalState.phase.includes(player.username),
  );
  const winner_slot = winnerIndex >= 0 ? winnerIndex : null;
  const scores = input.finalState.players.map((player, index) => {
    if (winner_slot !== null) {
      return index === winner_slot ? 1 : 0;
    }
    if (totalTiles <= 0 || player.tilesOwned === null) {
      return 0;
    }
    return player.tilesOwned / totalTiles;
  });
  return {
    scores,
    winner_slot,
    turn_count: input.finalState.turnCount,
    tick: input.finalState.tick,
    decision_count: input.records.length,
    accepted_decision_count: input.records.filter(
      (record) => record.result.accepted,
    ).length,
    fallback_count: input.records.filter(
      (record) => record.decisionMetadata?.fallbackUsed === true,
    ).length,
    players: input.finalState.players.map((player, slot) => ({
      slot,
      name: input.config.players[slot]?.name ?? player.username,
      score: scores[slot] ?? 0,
      tiles_owned: player.tilesOwned,
      is_alive: player.isAlive,
    })),
  };
}

function finalKnownState(input: {
  participants: Array<{
    runner: { agentID: string; clientID: () => string | null };
    spec: { username: string; profile: string };
  }>;
  gameState: any;
  turnCount: number;
}) {
  const winner = input.gameState.getWinner();
  const phase =
    winner === null
      ? input.gameState.inSpawnPhase()
        ? "spawn"
        : "active"
      : `winner:${typeof winner === "string" ? winner : winner.name()}`;
  return {
    phase,
    tick: input.gameState.ticks(),
    turnCount: input.turnCount,
    players: input.participants.map((participant) => {
      const clientID = participant.runner.clientID();
      const player =
        clientID === null ? null : input.gameState.playerByClientID(clientID);
      return {
        agentID: participant.runner.agentID,
        username: participant.spec.username,
        profile: participant.spec.profile,
        playerID: player?.id() ?? null,
        isAlive: player?.isAlive() ?? null,
        tilesOwned: player?.numTilesOwned() ?? null,
        troops: player?.troops() ?? null,
        gold: player?.gold()?.toString() ?? null,
      };
    }),
  };
}

function agentRunRoster(
  participants: Array<{
    runner: { agentID: string; clientID: () => string | null };
    spec: { username: string; profile: string };
    brain: { brainType: string };
  }>,
) {
  return participants.map((participant) => ({
    agentID: participant.runner.agentID,
    username: participant.spec.username,
    profile: participant.spec.profile,
    clientID: participant.runner.clientID(),
    brainType: participant.brain.brainType,
  }));
}

function enumValue(
  values: Record<string, unknown>,
  requested: string,
): unknown {
  const byKey = values[requested];
  if (byKey !== undefined) {
    return byKey;
  }
  const match = Object.values(values).find(
    (value) => String(value) === requested,
  );
  if (match === undefined) {
    throw new Error(`${requested} is not a valid enum value`);
  }
  return match;
}

function coworldGlobalClientHtml(): string {
  return coworldSpectatorClientHtml({
    title: "Proxy War Coworld Global",
    endpoint: "/global",
    modeLabel: "Live global viewer",
    waitingText:
      "Waiting for Proxy War spectator snapshots. Connect all players to start the match.",
  });
}

function coworldReplayClientHtml(): string {
  return coworldSpectatorClientHtml({
    title: "Proxy War Coworld Replay",
    endpoint: "/replay",
    modeLabel: "Replay viewer",
    waitingText: "Waiting for Coworld replay data.",
  });
}

function coworldSpectatorClientHtml(input: {
  title: string;
  endpoint: "/global" | "/replay";
  modeLabel: string;
  waitingText: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>${coworldClientCss()}</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.modeLabel)}</p>
    </div>
    <strong id="connection">connecting</strong>
  </header>
  <main class="spectator">
    <section class="surface">
      <canvas id="map" width="1100" height="720" aria-label="Proxy War map"></canvas>
      <div class="controls">
        <button id="prev" type="button">Prev</button>
        <button id="play" type="button">Play</button>
        <button id="next" type="button">Next</button>
        <input id="scrub" type="range" min="0" max="0" value="0" aria-label="Replay frame">
        <strong id="frame-label">No frame</strong>
      </div>
      <div class="metrics">
        <div>Turn<strong id="turn">-</strong></div>
        <div>Tick<strong id="tick">-</strong></div>
        <div>Snapshots<strong id="snapshot-count">0</strong></div>
        <div>Players<strong id="player-count">0</strong></div>
      </div>
    </section>
    <aside class="side">
      <section>
        <h2>Match</h2>
        <dl id="match-state"></dl>
      </section>
      <section>
        <h2>Agents</h2>
        <div id="roster" class="roster"></div>
      </section>
      <section>
        <h2>Frame Decisions</h2>
        <div id="decisions" class="timeline"></div>
      </section>
      <section>
        <h2>Replay Data</h2>
        <pre id="raw">${escapeHtml(input.waitingText)}</pre>
      </section>
    </aside>
  </main>
  <script>
    const endpoint = ${JSON.stringify(input.endpoint)};
    const waitingText = ${JSON.stringify(input.waitingText)};
    const state = {
      snapshots: [],
      map: null,
      frame: 0,
      replay: null,
      lastMessage: null,
      playing: false,
      timer: null
    };
    const canvas = document.getElementById("map");
    const ctx = canvas.getContext("2d");
    const scrub = document.getElementById("scrub");
    const playButton = document.getElementById("play");

    connect();
    render();

    document.getElementById("prev").addEventListener("click", () => setFrame(state.frame - 1));
    document.getElementById("next").addEventListener("click", () => setFrame(state.frame + 1));
    scrub.addEventListener("input", () => setFrame(Number(scrub.value)));
    playButton.addEventListener("click", () => {
      if (state.playing) stopPlayback();
      else startPlayback();
    });

    function connect() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(protocol + "//" + location.host + endpoint);
      socket.addEventListener("open", () => setConnection("connected"));
      socket.addEventListener("close", () => setConnection("closed"));
      socket.addEventListener("error", () => setConnection("socket error"));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        state.lastMessage = message;
        if (message.type === "state") {
          if (message.map) state.map = message.map;
          if (message.spectatorReplay) loadReplay(message.spectatorReplay);
          if (message.snapshot) appendSnapshot(message.snapshot);
        }
        if (message.type === "replay") {
          const replay = message.replay && message.replay.spectatorReplay;
          if (replay) loadReplay(replay);
        }
        render();
      });
    }

    function setConnection(label) {
      document.getElementById("connection").textContent = label;
    }

    function loadReplay(replay) {
      state.replay = replay;
      state.map = replay.map || state.map;
      state.snapshots = Array.isArray(replay.snapshots) ? replay.snapshots : [];
      state.frame = state.snapshots.length > 0 ? state.snapshots.length - 1 : 0;
      syncScrubber();
    }

    function appendSnapshot(snapshot) {
      const previous = state.snapshots[state.snapshots.length - 1];
      if (
        previous &&
        previous.turnNumber === snapshot.turnNumber &&
        previous.tick === snapshot.tick &&
        previous.label === snapshot.label
      ) {
        state.snapshots[state.snapshots.length - 1] = snapshot;
      } else {
        state.snapshots.push(snapshot);
      }
      state.frame = state.snapshots.length - 1;
      syncScrubber();
    }

    function startPlayback() {
      if (state.snapshots.length <= 1) return;
      state.playing = true;
      playButton.textContent = "Pause";
      state.timer = setInterval(() => {
        if (state.frame >= state.snapshots.length - 1) {
          stopPlayback();
          return;
        }
        setFrame(state.frame + 1);
      }, 900);
    }

    function stopPlayback() {
      state.playing = false;
      playButton.textContent = "Play";
      clearInterval(state.timer);
      state.timer = null;
    }

    function setFrame(frame) {
      state.frame = Math.max(0, Math.min(Math.floor(frame), Math.max(0, state.snapshots.length - 1)));
      syncScrubber();
      render();
    }

    function syncScrubber() {
      scrub.max = String(Math.max(0, state.snapshots.length - 1));
      scrub.value = String(state.frame);
    }

    function render() {
      const snapshot = state.snapshots[state.frame] || null;
      document.getElementById("snapshot-count").textContent = String(state.snapshots.length);
      document.getElementById("player-count").textContent = String(snapshot && Array.isArray(snapshot.players) ? snapshot.players.length : 0);
      document.getElementById("turn").textContent = snapshot ? String(snapshot.turnNumber) : "-";
      document.getElementById("tick").textContent = snapshot ? String(snapshot.tick) : "-";
      document.getElementById("frame-label").textContent = snapshot ? snapshot.label : "No frame";
      renderMatchState(snapshot);
      renderMap(snapshot);
      renderRoster(snapshot);
      renderDecisions(snapshot);
      renderRaw(snapshot);
    }

    function renderMatchState(snapshot) {
      const message = state.lastMessage || {};
      const replay = state.replay || {};
      const config = message.config || {};
      const map = state.map || replay.map || {};
      document.getElementById("match-state").innerHTML = [
        row("Event", message.event || "n/a"),
        row("Map", (map.gameMap || config.map || "unknown") + " / " + (map.gameMapSize || config.map_size || "unknown")),
        row("Connected", (message.connectedPlayers ?? 0) + " / " + (message.requiredPlayers ?? config.player_count ?? 0)),
        row("Replay", message.replayReady ? "ready" : state.replay ? "loaded" : "not ready"),
        row("Phase", snapshot ? snapshot.phase : "n/a")
      ].join("");
    }

    function renderMap(snapshot) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#d8e5ef";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!snapshot) {
        ctx.fillStyle = "#17202a";
        ctx.font = "24px system-ui, sans-serif";
        ctx.fillText(waitingText, 32, 64);
        return;
      }
      const map = mapDimensions(snapshot);
      const pad = 16;
      const scale = Math.min((canvas.width - pad * 2) / map.width, (canvas.height - pad * 2) / map.height);
      const offsetX = (canvas.width - map.width * scale) / 2;
      const offsetY = (canvas.height - map.height * scale) / 2;
      ctx.fillStyle = "#eef5eb";
      ctx.fillRect(offsetX, offsetY, map.width * scale, map.height * scale);
      for (const player of snapshot.players || []) {
        ctx.fillStyle = safeColor(player.color);
        for (const tile of player.tiles || []) {
          const x = tile % map.width;
          const y = Math.floor(tile / map.width);
          ctx.fillRect(offsetX + x * scale, offsetY + y * scale, Math.max(1.2, scale), Math.max(1.2, scale));
        }
        for (const unit of player.units || []) {
          const x = unit.tile % map.width;
          const y = Math.floor(unit.tile / map.width);
          ctx.beginPath();
          ctx.arc(offsetX + x * scale, offsetY + y * scale, Math.max(3, scale * 2), 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.strokeStyle = "#111827";
          ctx.stroke();
        }
      }
    }

    function renderRoster(snapshot) {
      const players = snapshot && Array.isArray(snapshot.players) ? snapshot.players : [];
      document.getElementById("roster").innerHTML = players.length === 0
        ? '<p class="muted">No player state yet.</p>'
        : players.map((player) =>
            '<article class="agent"><strong><span class="swatch" style="background:' + safeColor(player.color) + '"></span>' +
            h(player.username) + '</strong><span>' + h(player.profile || "agent") + ' · ' +
            h(player.brainType || "unknown") + '</span><code>' +
            h(player.tilesOwned) + ' tiles · ' + h(player.troops) + ' troops · gold ' + h(player.gold) +
            '</code></article>'
          ).join("");
    }

    function renderDecisions(snapshot) {
      const decisions = snapshot && Array.isArray(snapshot.decisions) ? snapshot.decisions : [];
      document.getElementById("decisions").innerHTML = decisions.length === 0
        ? '<p class="muted">No decisions on this frame.</p>'
        : decisions.map((decision) =>
            '<article class="decision"><strong>' + h(decision.username) + '</strong>' +
            '<span class="badge">' + h(decision.selectedActionKind) + '</span>' +
            '<code>' + h(decision.selectedLegalActionId) + '</code>' +
            '<p>' + h(decision.reason || "") + '</p>' +
            '<small>' + h(decision.accepted ? "accepted" : "rejected") + ' · ' + h(decision.resultReason || "") + '</small></article>'
          ).join("");
    }

    function renderRaw(snapshot) {
      document.getElementById("raw").textContent = snapshot
        ? JSON.stringify(snapshot, null, 2)
        : JSON.stringify(state.lastMessage || { status: waitingText }, null, 2);
    }

    function mapDimensions(snapshot) {
      const map = state.map || (state.replay && state.replay.map) || {};
      const inferredWidth = inferWidth(snapshot);
      return {
        width: Number(map.width || inferredWidth),
        height: Number(map.height || inferredWidth)
      };
    }

    function inferWidth(snapshot) {
      const tiles = (snapshot.players || []).flatMap((player) => player.tiles || []);
      const maxTile = tiles.length === 0 ? 0 : Math.max(...tiles);
      return Math.max(64, Math.ceil(Math.sqrt(maxTile + 1)));
    }

    function row(label, value) {
      return '<dt>' + h(label) + '</dt><dd>' + h(value) + '</dd>';
    }

    function safeColor(value) {
      return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#64748b";
    }

    function h(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }
  </script>
</body>
</html>`;
}

function coworldPlayerClientHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Coworld Player</title>
  <style>${coworldClientCss()}</style>
</head>
<body>
  <header>
    <div>
      <h1>Proxy War Coworld Player</h1>
      <p>Browser player slot client</p>
    </div>
    <strong id="connection">connecting</strong>
  </header>
  <main class="player">
    <section>
      <h2>Current Request</h2>
      <dl id="request-summary"></dl>
      <div id="actions" class="actions"></div>
    </section>
    <section>
      <h2>Observation</h2>
      <pre id="observation">Waiting for a decision request.</pre>
    </section>
    <section>
      <h2>Log</h2>
      <pre id="log"></pre>
    </section>
  </main>
  <script>
    const state = { request: null, socket: null };
    connect();

    function connect() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(protocol + "//" + location.host + "/player" + location.search);
      state.socket = socket;
      socket.addEventListener("open", () => setConnection("connected"));
      socket.addEventListener("close", () => setConnection("closed"));
      socket.addEventListener("error", () => setConnection("socket error"));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        appendLog(message);
        if (message.type === "hello") setConnection("slot " + message.slot);
        if (message.type === "decision_request") renderRequest(message);
        if (message.type === "final") setConnection("match finished");
      });
    }

    function renderRequest(message) {
      state.request = message;
      const request = message.request || {};
      const actions = Array.isArray(request.legalActions) ? request.legalActions : [];
      document.getElementById("request-summary").innerHTML = [
        row("Request", message.requestID),
        row("Slot", message.slot),
        row("Protocol", request.protocolVersion || "unknown"),
        row("Legal actions", actions.length)
      ].join("");
      document.getElementById("observation").textContent = JSON.stringify(request.observation || request, null, 2);
      document.getElementById("actions").innerHTML = actions.map((action, index) =>
        '<button type="button" data-action-index="' + index + '">' +
        '<strong>' + h(action.label || action.id) + '</strong>' +
        '<code>' + h(action.id) + '</code>' +
        '<span>' + h(action.kind || "action") + '</span></button>'
      ).join("");
      document.querySelectorAll("[data-action-index]").forEach((button) => {
        button.addEventListener("click", () => chooseAction(actions[Number(button.dataset.actionIndex)]));
      });
    }

    function chooseAction(action) {
      const message = state.request;
      if (!message || !action) return;
      state.socket.send(JSON.stringify({
        type: "decision_response",
        requestID: message.requestID,
        selectedLegalActionId: action.id,
        reason: "selected in Coworld browser player",
        confidence: 0.8
      }));
      appendLog({ type: "decision_response", requestID: message.requestID, selectedLegalActionId: action.id });
      state.request = null;
      document.getElementById("actions").innerHTML = '<p class="muted">Decision sent. Waiting for the next request.</p>';
    }

    function setConnection(label) {
      document.getElementById("connection").textContent = label;
    }

    function appendLog(message) {
      const log = document.getElementById("log");
      log.textContent = JSON.stringify(message, null, 2) + "\\n\\n" + log.textContent;
    }

    function row(label, value) {
      return '<dt>' + h(label) + '</dt><dd>' + h(value) + '</dd>';
    }

    function h(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }
  </script>
</body>
</html>`;
}

function coworldClientCss(): string {
  return `
    :root { color-scheme: light; --ink:#17202a; --muted:#627084; --line:#d9e2ec; --paper:#f7f9fc; --accent:#215a9c; }
    * { box-sizing:border-box; }
    body { margin:0; font:14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:var(--paper); }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:26px; }
    h2 { margin:0 0 10px; font-size:16px; }
    p { margin:0; }
    header p, .muted { color:var(--muted); }
    header strong { border:1px solid var(--line); border-radius:999px; padding:6px 10px; background:#f8fbff; color:var(--accent); }
    main.spectator { display:grid; grid-template-columns:minmax(520px, 1fr) 420px; gap:18px; max-width:1500px; margin:0 auto; padding:18px 28px 28px; }
    main.player { display:grid; grid-template-columns:minmax(340px, 440px) minmax(420px, 1fr); gap:18px; max-width:1400px; margin:0 auto; padding:18px 28px 28px; }
    main.player section:last-child { grid-column:1 / -1; }
    section, .surface { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; }
    .surface { display:grid; gap:12px; }
    canvas { width:100%; height:auto; display:block; border:1px solid var(--line); border-radius:8px; background:#d8e5ef; }
    .side, .roster, .timeline, .actions { display:grid; gap:12px; }
    .controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .controls input { flex:1; min-width:180px; }
    button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; padding:8px 10px; font-weight:700; cursor:pointer; }
    button:hover { border-color:var(--accent); color:var(--accent); }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:10px; }
    .metrics div { border:1px solid var(--line); border-radius:8px; padding:10px; }
    .metrics strong { display:block; font-size:20px; margin-top:3px; }
    dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 12px; margin:0; }
    dt { color:var(--muted); font-weight:700; }
    dd { margin:0; min-width:0; overflow-wrap:anywhere; }
    .agent, .decision { border:1px solid var(--line); border-radius:8px; padding:10px; display:grid; gap:4px; background:#fff; }
    .decision p { color:#334155; }
    .badge { display:inline-flex; width:max-content; padding:2px 8px; border-radius:999px; background:#e7eef7; color:var(--accent); font-size:12px; font-weight:700; }
    .swatch { display:inline-block; width:10px; height:10px; border-radius:999px; margin-right:6px; vertical-align:middle; }
    code, pre { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap:anywhere; }
    pre { max-height:50vh; overflow:auto; margin:0; white-space:pre-wrap; background:#f8fbff; border:1px solid var(--line); border-radius:8px; padding:12px; }
    .actions button { text-align:left; display:grid; gap:4px; }
    @media (max-width: 980px) { main.spectator, main.player { grid-template-columns:1fr; padding:14px; } header { padding:16px; align-items:flex-start; flex-direction:column; } }
  `;
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function pocReport(input: {
  workspace: string;
  results: CoworldResults;
  proxyWarArtifactDir: string;
}): string {
  return [
    "# Proxy War Coworld Local POC Report",
    "",
    "Status: no-Docker Coworld-shaped episode path passed.",
    "",
    "This run proves the local adapter can drive Proxy War through a Coworld-shaped websocket player protocol and produce Coworld-style results/replay files.",
    "",
    "It does not prove official Coworld compatibility because Docker is unavailable in this environment, so `coworld certify` could not run.",
    "",
    `- Workspace: ${input.workspace}`,
    `- Proxy War artifact directory: ${input.proxyWarArtifactDir}`,
    `- Scores: ${input.results.scores.join(", ")}`,
    `- Decisions: ${input.results.decision_count}`,
    `- Accepted decisions: ${input.results.accepted_decision_count}`,
    `- Fallbacks: ${input.results.fallback_count}`,
    "",
    "Remaining verification gate:",
    "",
    "- Install or enable Docker/Colima/Podman, build `proxywar-coworld-local:latest`, then run official `coworld certify` and `coworld run-episode --verify-replay`.",
    "",
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForever(): Promise<never> {
  return new Promise(() => undefined);
}

await main();
