import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
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
const proxyWarStaticRoot = path.join(proxyWarRepo, "static");
const proxyWarPublicRunArtifacts = new Set([
  "game-record.json",
  "decisions.jsonl",
  "match-summary.json",
  "match-package.json",
  "match-package.html",
  "match-package.md",
  "spectator-replay.json",
  "spectator-telemetry.json",
  "visual-report.html",
  "spectator.html",
  "objective-scorecard.md",
  "match-story.md",
  "behavior-quality-report.json",
  "behavior-quality-report.md",
  "external-agent-feedback.md",
]);

let proxyWarAppShellPromise: Promise<string> | null = null;

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

const proxyWarUsernameInvalidCharacters = /[^a-zA-Z0-9_ üÜ.]+/gu;

function proxyWarUsernames(
  players: Array<{ name: string }>,
  maxLength: number,
): string[] {
  const seen = new Set<string>();
  return players.map((player, index) => {
    const fallback = `Coworld Player ${index + 1}`;
    const normalized = player.name
      .replace(proxyWarUsernameInvalidCharacters, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const base = (normalized.length >= 3 ? normalized : fallback)
      .slice(0, maxLength)
      .trim();
    let username = base.length >= 3 ? base : fallback.slice(0, maxLength);
    if (seen.has(username)) {
      const suffix = ` ${index + 1}`;
      username = `${username.slice(0, maxLength - suffix.length).trim()}${suffix}`;
    }
    seen.add(username);
    return username;
  });
}

class CoworldProtocolServer {
  private readonly server = http.createServer((request, response) => {
    void this.handleHttp(request, response);
  });
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

  private async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/coworld/replay-info") {
      writeJson(response, 200, this.replayInfo());
      return;
    }
    if (await this.writeRunArtifact(url, response)) {
      return;
    }
    if (
      url.pathname === "/client/global" ||
      url.pathname === "/client/replay" ||
      url.pathname === "/client/player"
    ) {
      await writeProxyWarAppShell(response);
      return;
    }
    if (await writeProxyWarStaticAsset(url, response)) {
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
          protocol: "proxywar-coworld-v1",
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

  private replayInfo(): Record<string, unknown> {
    const runID = this.replayRunID();
    const artifactDirectory =
      runID === null ? null : this.proxyWarArtifactDirectory(runID);
    return {
      ready: runID !== null && artifactDirectory !== null,
      runID,
      artifactBasePath:
        runID === null ? null : `/ai-league-runs/${encodeURIComponent(runID)}`,
      snapshotCount: this.snapshots.length,
      replayReady: this.replayPayload !== null,
    };
  }

  private replayRunID(): string | null {
    if (this.replayPayload === null || typeof this.replayPayload !== "object") {
      return null;
    }
    const runID = (this.replayPayload as Record<string, unknown>).runID;
    return typeof runID === "string" && isSafeProxyWarArtifactSegment(runID)
      ? runID
      : null;
  }

  private proxyWarArtifactDirectory(runID: string): string | null {
    if (this.replayPayload === null || typeof this.replayPayload !== "object") {
      return null;
    }
    const artifacts = (this.replayPayload as Record<string, unknown>)
      .proxyWarArtifacts;
    if (artifacts === null || typeof artifacts !== "object") {
      return null;
    }
    const directory = (artifacts as Record<string, unknown>).directory;
    if (typeof directory !== "string" || path.basename(directory) !== runID) {
      return null;
    }
    return directory;
  }

  private async writeRunArtifact(
    url: URL,
    response: http.ServerResponse,
  ): Promise<boolean> {
    const match = url.pathname.match(/^\/ai-league-runs\/([^/]+)\/([^/]+)$/);
    if (match === null) {
      return false;
    }
    const runID = decodeURIComponent(match[1]);
    const artifact = decodeURIComponent(match[2]);
    const directory = this.proxyWarArtifactDirectory(runID);
    if (
      directory === null ||
      !isSafeProxyWarArtifactSegment(runID) ||
      !proxyWarPublicRunArtifacts.has(artifact)
    ) {
      writeText(response, 404, "artifact not available");
      return true;
    }
    const filePath = path.resolve(directory, artifact);
    if (!isInsideRoot(filePath, directory) || !fsSync.existsSync(filePath)) {
      writeText(response, 404, "artifact not found");
      return true;
    }
    await writeFile(response, filePath);
    return true;
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
      path.join(workspace, "coworld-report.md"),
      coworldReport({
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
    await sleep(Number(process.env.COWORLD_POSTGAME_SERVER_MS ?? 1500));
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
  const usernames = proxyWarUsernames(
    config.players,
    modules.proxyWarGameUsernameMaxLength ?? 27,
  );
  const specs = config.players.map((_player, index) => ({
    username: usernames[index],
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
    const runID = `coworld-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const runNote = process.env.COGAME_RESULTS_URI
      ? "Coworld container harness."
      : "Local no-Docker Coworld-shaped harness.";
    const certificationNote = process.env.COGAME_RESULTS_URI
      ? "This episode ran through Coworld's game/player container env contract."
      : "Official Coworld certification is not part of this no-Docker command.";
    const spectatorReplay = modules.buildAgentSpectatorReplay({
      runID,
      matchID: game.id,
      scenario: "coworld",
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
      scenario: "coworld",
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
  const globalClientUrl = `http://127.0.0.1:${port}/client/global`;
  await assertCoworldAppShellAssets(
    await requireHttpOk(globalClientUrl),
    "/client/global",
    globalClientUrl,
  );
  const playerClientUrl = `http://127.0.0.1:${port}/client/player?slot=0&token=${encodeURIComponent(
    config.tokens[0],
  )}`;
  await assertCoworldAppShellAssets(
    await requireHttpOk(playerClientUrl),
    "/client/player",
    playerClientUrl,
  );
  await requireBadPlayerRejected(
    `ws://127.0.0.1:${port}/player?slot=0&token=bad`,
  );
  await requireWebSocketMessage(`ws://127.0.0.1:${port}/global`);
}

async function runReplayChecks(port: number): Promise<void> {
  const replayClientUrl = `http://127.0.0.1:${port}/client/replay`;
  await assertCoworldAppShellAssets(
    await requireHttpOk(replayClientUrl),
    "/client/replay",
    replayClientUrl,
  );
  const message = await requireWebSocketMessage(
    `ws://127.0.0.1:${port}/replay`,
  );
  const parsed = JSON.parse(message);
  if (parsed.type !== "replay" || parsed.replay === null) {
    throw new Error("/replay did not return a replay payload");
  }
}

async function assertCoworldAppShellAssets(
  html: string,
  route: string,
  pageUrl: string,
): Promise<void> {
  if (!html.includes("../assets/") || !html.includes("../assets/_assets/")) {
    throw new Error(`${route} app shell did not use Coworld-relative assets`);
  }
  if (
    html.includes('src="/assets/') ||
    html.includes('href="/assets/') ||
    html.includes('src="/_assets/') ||
    html.includes('href="/_assets/')
  ) {
    throw new Error(`${route} app shell still contains root-absolute assets`);
  }
  const assetRefs = [
    ...html.matchAll(/(?:src|href)="([^"]*(?:assets|_assets)[^"]*)"/g),
  ].map((match) => match[1]);
  for (const assetRef of new Set(assetRefs)) {
    await requireHttpOk(new URL(assetRef, pageUrl).toString());
  }
}

async function requireHttpOk(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return await response.text();
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
    websocket.on("message", (message) => {
      clearTimeout(timeout);
      websocket.close();
      resolve(message.toString());
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
  const config = record.config as Record<string, unknown>;
  const { tokens, ...publicConfig } = config;
  const players = Array.isArray(config.players) ? config.players : [];
  return {
    ...record,
    config: {
      ...publicConfig,
      player_count:
        typeof config.player_count === "number"
          ? config.player_count
          : Array.isArray(tokens)
            ? tokens.length
            : players.length,
    },
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

async function writeProxyWarAppShell(
  response: http.ServerResponse,
): Promise<void> {
  const html = await proxyWarAppShellHtml();
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

async function proxyWarAppShellHtml(): Promise<string> {
  if (proxyWarAppShellPromise === null) {
    proxyWarAppShellPromise = (async () => {
      const { renderHtmlContent } = await importProxyWar(
        "src/server/RenderHtml.ts",
      );
      const staticHtmlPath = path.join(proxyWarStaticRoot, "index.html");
      const htmlPath = fsSync.existsSync(staticHtmlPath)
        ? staticHtmlPath
        : path.join(proxyWarRepo, "index.html");
      return await renderHtmlContent(htmlPath, {
        htmlAssetBase: "../assets",
        viteAssetBase: "..",
      });
    })();
  }
  return await proxyWarAppShellPromise;
}

async function writeProxyWarStaticAsset(
  url: URL,
  response: http.ServerResponse,
): Promise<boolean> {
  const requestPath = decodeURIComponent(url.pathname);
  if (!isProxyWarStaticAssetPath(requestPath)) {
    return false;
  }
  const staticRequestPath = requestPath.startsWith("/assets/_assets/")
    ? requestPath.slice("/assets".length)
    : requestPath;
  const filePath = path.resolve(proxyWarStaticRoot, staticRequestPath.slice(1));
  if (
    !isInsideRoot(filePath, proxyWarStaticRoot) ||
    !fsSync.existsSync(filePath) ||
    !fsSync.statSync(filePath).isFile()
  ) {
    return false;
  }
  await writeFile(response, filePath);
  return true;
}

function isProxyWarStaticAssetPath(requestPath: string): boolean {
  return (
    requestPath.startsWith("/assets/") ||
    requestPath.startsWith("/_assets/") ||
    requestPath.startsWith("/images/") ||
    requestPath.startsWith("/sounds/") ||
    requestPath.startsWith("/maps/") ||
    requestPath.startsWith("/lang/") ||
    requestPath.startsWith("/flags/") ||
    requestPath.startsWith("/icons/") ||
    requestPath.startsWith("/sprites/") ||
    requestPath.startsWith("/fonts/") ||
    requestPath === "/manifest.json" ||
    requestPath === "/favicon.ico" ||
    requestPath === "/asset-manifest.json"
  );
}

async function writeFile(
  response: http.ServerResponse,
  filePath: string,
): Promise<void> {
  const body = await fs.readFile(filePath);
  response.writeHead(200, {
    "content-type": mimeType(filePath),
    "cache-control": "public, max-age=31536000, immutable",
  });
  response.end(body);
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".webmanifest":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeText(
  response: http.ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function isSafeProxyWarArtifactSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    value !== "." &&
    value !== ".." &&
    value === path.basename(value) &&
    /^[a-zA-Z0-9._:-]+$/.test(value)
  );
}

function isInsideRoot(filePath: string, rootDir: string): boolean {
  const relative = path.relative(path.resolve(rootDir), filePath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
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

function coworldReport(input: {
  workspace: string;
  results: CoworldResults;
  proxyWarArtifactDir: string;
}): string {
  return [
    "# Proxy War Coworld Report",
    "",
    "Status: no-Docker Coworld-shaped episode path passed.",
    "",
    "This run proves the adapter can drive Proxy War through a Coworld-shaped websocket player protocol and produce Coworld-style results/replay files.",
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
