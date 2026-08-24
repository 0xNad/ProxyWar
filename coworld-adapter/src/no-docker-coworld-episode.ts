import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { CommanderXpFinalizationBarrier } from "./commander-xp-finalization.ts";
import {
  coworldAppShellRoute,
  injectCoworldSplash,
  type CoworldAppShellRoute,
} from "./coworld-appshell.ts";
import {
  composeCoworldDecision,
  decisionRequestEnvelope,
  normalizeDecisionResponse,
  type ComposedCoworldDecision,
} from "./coworld-decision-wire.ts";
import { episodeIndexFromConfig } from "./coworld-episode-index.ts";
import {
  coworldResults,
  resolveWinnerSlot,
  type CoworldResults,
  type WinnerRef,
} from "./coworld-results.ts";
import {
  coworldInlineRunArtifacts,
  coworldPublicReplayPayload,
} from "./coworld-run-artifact-bundle.ts";
import {
  commanderXpArmInvariantSeatPlayers,
  competitiveSeatSpecs,
} from "./coworld-seat-specs.ts";
import { coworldPublicRunArtifacts } from "./proxywar-public-run-artifacts.ts";
import {
  createSnapshotRetention,
  finalizeSnapshotRetention,
  offerSnapshot,
} from "./spectator-snapshot-retention.ts";

const localRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const proxyWarRepo = process.env.PROXYWAR_REPO ?? "/app/proxywar";
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require(
  `${proxyWarRepo}/node_modules/ws`,
) as {
  WebSocket: typeof import("ws").WebSocket;
  WebSocketServer: typeof import("ws").WebSocketServer;
};
const winston = require(`${proxyWarRepo}/node_modules/winston`);
const proxyWarStaticRoot = path.join(proxyWarRepo, "static");

// --- Coworld episode memory bound (World 12P mid-game OOM fix) -------------
// Root cause (local repro, hosted memory posture --max-old-space-size=640): on
// the World map (651,609 land tiles, 12 seats) the runner retained the full
// per-decision record set AND every spectator snapshot for the whole episode;
// that turn-linear heap growth on top of World's high fixed baseline pushed the
// hosted pod past its memory cap mid-game (turn ~5-8k). Two levers fix it
// WITHOUT changing the simulation, scores, winner, rendered replay, or decision
// telemetry:
//   1. Skip the ~8 KB/record `tacticalAffordances` field on the Coworld path
//      (retainTacticalAffordances: false below). That cuts each record ~60-77%
//      at EVERY depth, so the FULL decision log stays affordable and is NEVER
//      truncated — fallback/degradation counts and decisions.jsonl remain
//      complete (honest-degradation invariant preserved).
//   2. Reservoir-cap the spectator snapshots (this constant). Snapshots feed
//      only the downsampled spectator replay, never the result counts, so
//      bounding them is telemetry-safe. Even-stride decimation keeps them
//      evenly spaced. 48 engages before the observed crash window (~turn 4.8k
//      at 100 turns/step), so snapshot heap is flat through the mid-game depths
//      where the pod OOMs. The spectator replay then carries up to ~48
//      evenly-spaced snapshots (a watchability trade the operator can raise via
//      the env override); the rendered replay (message-derived game-record) is
//      unaffected. Env-overridable.
const COWORLD_MAX_RETAINED_SNAPSHOTS = Math.max(
  16,
  Number(process.env.PROXYWAR_MAX_RETAINED_SNAPSHOTS ?? "48"),
);
const proxyWarPublicRunArtifacts = new Set<string>(coworldPublicRunArtifacts);

let proxyWarAppShellPromise: Promise<string> | null = null;

type LegalActionView = {
  id: string;
  kind: string;
  label: string;
  risk?: { level?: string; score?: number };
  metadata?: Record<string, unknown>;
};

/**
 * The object handed to AgentLeagueMatch by `brainForSlot` — i.e. the seat's
 * AgentDecision. Deliberately an alias, NOT a second hand-listed field set:
 * re-listing the selection fields here is a third place a new slot has to be
 * remembered, and the comms slot was already lost once to exactly that class
 * of omission. The wire module owns the shape; `tests/coworld/
 * DecisionSlotParity.test.ts` pins it against AgentTypes.AgentDecision.
 */
type CoworldDecision = ComposedCoworldDecision;

type PendingDecision = {
  resolve: (decision: CoworldDecision) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
  legalActions: LegalActionView[];
};

export type CoworldConfig = {
  commander_xp_phase?: "provider-preflight" | "canary" | "confirmatory";
  commander_xp_run_key?: string;
  tokens: string[];
  players: Array<{ name: string }>;
  max_decision_steps: number;
  turns_per_decision_step: number;
  max_decision_ms: number;
  map: string;
  map_size: string;
  difficulty: string;
  seed?: number;
  replay_tail_turns?: number;
  num_agents?: number;
  episode_timeout_seconds?: number;
  player_connect_timeout_seconds?: number;
  /**
   * Zero-based episode ordinal within the commissioner's same-variant
   * recurrence blocks (AgentLeagueMatchOptions.episodeIndex). The sealed
   * spawn allocator uses it to rotate report-independent priority/default
   * order; ballots and response arrival never influence that order. Defaults
   * to 0 for a standalone/first occurrence when omitted.
   */
  episodeIndex?: number;
};

class CoworldProtocolServer {
  private readonly server = http.createServer((request, response) => {
    void this.handleHttp(request, response);
  });
  // maxPayload caps a single inbound frame; a legitimate decision_response is far
  // under 256 KiB. Without it, ws defaults to 100 MiB, so one oversized frame from
  // any of the 4 seats could OOM the memory-tight episode.
  private readonly wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
  });
  private readonly players = new Map<number, InstanceType<typeof WebSocket>>();
  private readonly pending = new Map<string, PendingDecision>();
  private readonly globalSockets = new Set<InstanceType<typeof WebSocket>>();
  private readonly replaySockets = new Set<InstanceType<typeof WebSocket>>();
  // Live-episode snapshots are latest-only: the /global broadcast and status
  // only ever read the newest frame + the count, and the results/replay artifacts
  // are built from the RUNNER's own spectatorSnapshots array (not this one). Keeping
  // one reference + a counter here (instead of every frame) avoids a second
  // unbounded O(steps) retention alongside the runner's, contributing to the
  // long-episode pod OOM. The replay-container path (setReplayPayload) still holds
  // the loaded replay's already-compacted (<=80) snapshots for /global serving.
  private latestLiveSnapshot: unknown = null;
  private liveSnapshotCount = 0;
  private replaySnapshots: unknown[] = [];
  private spectatorMap: Record<string, unknown> | null = null;
  private spectatorReplay: Record<string, unknown> | null = null;
  private replayPayload: unknown = null;
  private portValue: number | null = null;
  // Comms capability advertised in every decision envelope. Null until the
  // episode resolves it from the engine's own tunables, and it STAYS null when
  // free text is off, so the flag-off envelope is byte-identical to shipped
  // behavior. Set before the first decision (see runProxyWarEpisode).
  private maxMessageChars: number | null = null;
  private finalizationBarrier: CommanderXpFinalizationBarrier | null = null;

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
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout);
      }
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

  /**
   * Publishes the comms capability for this episode. The value comes from the
   * engine's AgentTunables (dynamically imported by the episode), never from a
   * second env read here — `freeTextMessagesEnabled()` stays the single
   * authority on whether the feature is on.
   */
  setCommsCapability(maxMessageChars: number | null): void {
    this.maxMessageChars = maxMessageChars;
  }

  brainForSlot(slot: number, buildRequestPayload: (input: unknown) => unknown) {
    return {
      brainType: "external-http",
      decide: (input: unknown) => this.decide(slot, buildRequestPayload(input)),
    };
  }

  recordSnapshot(
    snapshot: unknown,
    map: Record<string, unknown> | null = null,
  ): void {
    if (map !== null) {
      this.spectatorMap = map;
    }
    this.latestLiveSnapshot = snapshot;
    this.liveSnapshotCount += 1;
    this.broadcastGlobal(this.statusSnapshot("snapshot", snapshot));
  }

  setReplayPayload(payload: unknown): void {
    this.replayPayload = coworldPublicReplayPayload(payload);
    const spectatorReplay = spectatorReplayFromPayload(this.replayPayload);
    if (spectatorReplay !== null) {
      this.spectatorReplay = spectatorReplay;
      this.spectatorMap = spectatorMapFromReplay(spectatorReplay);
      if (this.replaySnapshots.length === 0 && this.liveSnapshotCount === 0) {
        this.replaySnapshots = spectatorSnapshotsFromReplay(spectatorReplay);
      }
    }
    this.broadcastReplay();
    this.broadcastGlobal(
      this.statusSnapshot("replay-ready", this.latestSnapshot()),
    );
  }

  async sendFinal(): Promise<void> {
    const requiresFinalizationAck =
      this.config.commander_xp_phase !== undefined;
    if (requiresFinalizationAck) {
      if (this.players.size !== this.config.tokens.length) {
        throw new Error(
          "Commander XP finalization requires every player connection",
        );
      }
      this.finalizationBarrier = new CommanderXpFinalizationBarrier([
        ...this.players.keys(),
      ]);
    }
    for (const [slot, websocket] of this.players.entries()) {
      websocket.send(
        JSON.stringify({ type: "final", slot, requiresFinalizationAck }),
      );
    }
    if (this.finalizationBarrier !== null) {
      await this.finalizationBarrier.wait();
      for (const [slot, websocket] of this.players.entries()) {
        websocket.send(JSON.stringify({ type: "finalization_complete", slot }));
      }
    }
  }

  private decide(slot: number, request: unknown): Promise<CoworldDecision> {
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
    const decisionPromise = new Promise<CoworldDecision>((resolve, reject) => {
      this.pending.set(requestID, {
        resolve,
        reject,
        timeout: null,
        legalActions,
      });
      websocket.send(
        // Envelope carries independent capability advertisements for action
        // batching, spawn ranking, and the comms slot
        // (protocol.maxActionsPerDecision / protocol.maxSpawnPreferences /
        // protocol.maxMessageChars) as siblings of requestID/slot; the
        // inner request payload is untouched. Players ignore unknown envelope
        // keys, so older policies remain scalar-only compatible.
        JSON.stringify(
          decisionRequestEnvelope({
            requestID,
            slot,
            request,
            ...(this.config.commander_xp_run_key !== undefined
              ? { commanderXpRunKey: this.config.commander_xp_run_key }
              : {}),
            ...(this.maxMessageChars !== null
              ? { maxMessageChars: this.maxMessageChars }
              : {}),
          }),
        ),
      );
    });
    // The frame above is sent during the league's synchronous observation
    // batch. The microtask fires only after that batch, so the transport
    // window excludes later seats' observation work — and always arms, even
    // if the batch throws before the league ever awaits this promise.
    queueMicrotask(() => {
      const pending = this.pending.get(requestID);
      if (pending === undefined || pending.timeout !== null) {
        return;
      }
      pending.timeout = setTimeout(() => {
        this.pending.delete(requestID);
        pending.reject(
          new Error(
            `Coworld player slot ${slot} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });
    return decisionPromise;
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
    const appShellRoute = coworldAppShellRoute(url.pathname);
    if (appShellRoute !== null) {
      await writeProxyWarAppShell(response, appShellRoute);
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
        this.finalizationBarrier?.disconnected(slot);
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

  private handlePlayerMessage(slot: number, data: import("ws").RawData): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(data));
    } catch (error) {
      // A single malformed frame from ONE seat must NEVER crash the container:
      // this runs inside a `ws` 'message' listener with no surrounding try, so a
      // throw becomes an uncaught exception that kills the whole 4-player episode.
      // Ignore the frame (like an unknown message type below); the seat simply
      // misses this decision window and times out loudly if it keeps sending junk.
      console.warn(
        `[coworld] player slot ${slot} sent invalid JSON; ignoring frame: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (message.type === "finalization_ack") {
      this.finalizationBarrier?.acknowledge(slot, message);
      return;
    }
    if (message.type !== "decision_response") {
      return;
    }
    const requestID = String(message.requestID ?? "");
    const pending = this.pending.get(requestID);
    if (pending === undefined) {
      return;
    }
    if (pending.timeout !== null) {
      clearTimeout(pending.timeout);
    }
    this.pending.delete(requestID);
    // Decision fields (scalar primary, optional selectedLegalActionIds batch,
    // independent spawnPreferenceLegalActionIds ballot, optional deal slot,
    // optional comms pair, reason) are shape/length-bounded by
    // the shared wire module — see coworld-decision-wire.ts for the
    // normalization contract and why menu membership is deliberately NOT
    // checked here. The metadata envelope is composed there too, from the
    // episode-local state passed in below (slot, requestID, offered menu size).
    const normalized = normalizeDecisionResponse(message, {
      allSpawnMenu:
        pending.legalActions.length > 0 &&
        pending.legalActions.every((action) => action.kind === "spawn"),
    });
    pending.resolve(
      composeCoworldDecision({
        normalized,
        message,
        slot,
        requestID,
        offeredLegalActionCount: pending.legalActions.length,
      }),
    );
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
      snapshotCount: this.snapshotCount(),
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
    return (
      this.latestLiveSnapshot ??
      this.replaySnapshots[this.replaySnapshots.length - 1] ??
      null
    );
  }

  private snapshotCount(): number {
    return this.liveSnapshotCount > 0
      ? this.liveSnapshotCount
      : this.replaySnapshots.length;
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
      snapshotCount: this.snapshotCount(),
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
    if (isInsideRoot(filePath, directory) && fsSync.existsSync(filePath)) {
      await writeFile(response, filePath);
      return true;
    }
    const inlineArtifacts = (this.replayPayload as Record<string, unknown>)
      .inlineRunArtifacts;
    if (inlineArtifacts !== null && typeof inlineArtifacts === "object") {
      const body = (inlineArtifacts as Record<string, unknown>)[artifact];
      if (typeof body === "string") {
        response.writeHead(200, {
          "content-type": mimeType(artifact),
          "cache-control": "no-store",
        });
        response.end(body);
        return true;
      }
    }
    writeText(response, 404, "artifact not found");
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
    if (process.env.PROXYWAR_SKIP_ROUTE_CHECKS !== "1") {
      await runRouteChecks(port, config);
    }
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
    if (process.env.PROXYWAR_SKIP_ROUTE_CHECKS !== "1") {
      await runReplayChecks(port);
    }
    await server.sendFinal();
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
    await server.sendFinal();
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
  const commanderXpEval = modules.commanderXpEvalEvidenceEnabled();
  const commanderXpPhase = config.commander_xp_phase;
  if (
    commanderXpEval &&
    (!["provider-preflight", "canary", "confirmatory"].includes(
      String(commanderXpPhase),
    ) ||
      typeof config.commander_xp_run_key !== "string" ||
      !/^commander-xp-v2\/[A-Za-z0-9._-]+\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C)$/.test(
        config.commander_xp_run_key,
      ) ||
      !config.commander_xp_run_key.includes(`/${commanderXpPhase}/`))
  ) {
    throw new Error(
      "Commander XP eval config requires exact phase/run identity",
    );
  }
  const commanderXpGameplay =
    commanderXpEval && commanderXpPhase !== "provider-preflight";
  if (
    commanderXpGameplay &&
    (config.max_decision_steps !== 360 ||
      config.turns_per_decision_step !== 100 ||
      config.max_decision_ms !== 15_000)
  ) {
    throw new Error("Commander XP gameplay cadence mismatch");
  }
  // Publish the comms capability before any decision frame goes out. Resolved
  // from the engine's own tunables so the advertisement can never disagree
  // with the cap the validator actually enforces; null while the flag is off.
  protocolServer.setCommsCapability(
    modules.freeTextMessagesEnabled?.() === true
      ? (modules.FREETEXT_MESSAGE_MAX_CHARS ?? null)
      : null,
  );
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
    // A bounded territorial tiebreak prevents genuine late-game deadlocks
    // without forcing agents to abandon diplomacy or manufacture an attack.
    // 60 simulated minutes is 36,000 turns, below the 50,000-turn budget used
    // by current 12-seat league variants, so those matches always adjudicate.
    maxTimerValue: 60,
    startingGold: 200000,
    maxPlayers: config.tokens.length,
  };
  // NOTE: the 3rd GameServer arg is `createdAt` (a wall-clock game-start
  // timestamp), NOT the RNG seed. GameRunner seeds the simulation from
  // simpleHash(gameID), so the adapter encodes an explicit Coworld seed into
  // the authoritative game identity. Seedless certification runs retain the
  // historical COWRLD01 identity and report seed:null honestly.
  const episodeIdentity = modules.coworldEpisodeIdentity(config.seed);
  const game = new modules.GameServer(
    episodeIdentity.gameId,
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
  // cache:false — this process runs exactly one game, so the module-level map
  // cache would only retain a dead master copy. The single parsed dataset
  // below serves BOTH the spawn-candidate scan and (via the mirror's
  // preloadedTerrain) the game itself; on World that removes two of the three
  // full map copies the episode used to hold.
  const terrain = await modules.loadTerrainMap(
    selectedGameConfig.gameMap,
    selectedGameConfig.gameMapSize,
    mapLoader,
    { cache: false },
  );
  const spawnCandidates = modules.buildSpawnCandidates(terrain.gameMap, {
    maxCandidates: 1000,
    stride: 2,
  });
  // Uniform seat profile (proxywar 0.1.6, fairness fix 2026-07-12): the old
  // per-index rotation ["aggressive","defensive","diplomatic","opportunistic"]
  // silently gave every policy a different personality depending on its seat
  // slot — the profile shapes the game-side observation stream (strategic
  // priorities, objectives, posture hints), so the same policy played
  // measurably differently in slot 0 vs slot 2 in every league round and every
  // A/B (verified across 3 keystone builds). All competitive seats now get the
  // same neutral profile; skill differences come from the POLICIES, not from
  // which chair they drew.
  const identityPlayers = config.commander_xp_phase
    ? commanderXpArmInvariantSeatPlayers(config.players)
    : config.players;
  const specs = competitiveSeatSpecs(
    identityPlayers,
    modules.proxyWarGameUsernameMaxLength ?? 27,
  );
  const participants = modules.createAgentParticipants(specs, log, {
    brainFactory: (spec: unknown, index: number) =>
      protocolServer.brainForSlot(
        index,
        modules.buildExternalAgentRequestPayload,
      ),
    // Only participants[0] feeds the mirror/spawn driver; the other seats'
    // copies of the full turn stream were seats x turns of dead retention.
    retainTurnMessagesPrimaryOnly: true,
  });
  const roster = agentRunRoster(participants);
  // The retained array IS the artifact's snapshot list: every downstream reader
  // (replay payload, counts) keeps working, and retention owns the spacing.
  const snapshotRetention = createSnapshotRetention<unknown>(
    COWORLD_MAX_RETAINED_SNAPSHOTS,
  );
  const spectatorSnapshots = snapshotRetention.retained;
  let memTelemetrySnapshots = 0;
  // stderr, NOT the winston logger: the episode logger is level "warn", and pod
  // log retrieval is the whole point — this is the hosted OOM/crash forensics line.
  // PROXYWAR_MEM_TELEMETRY_FORCE_GC=1 (+ --expose-gc): collect a full GC
  // before each sample so the series is the true live set, not the allocator
  // sawtooth. A least-squares slope over raw samples flips sign with GC phase
  // between otherwise-identical runs (measured: same code, fits of 2.1 vs
  // 13.4 MB/1k) — the memory gate needs the clean series to assert growth.
  // Never enable on hosted episodes: full GCs stall the world.
  const memTelemetryForceGc =
    process.env.PROXYWAR_MEM_TELEMETRY_FORCE_GC === "1" &&
    typeof globalThis.gc === "function";
  const logMemTelemetry = (label: string, turnNumber: number) => {
    const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
    if (memTelemetryForceGc) {
      globalThis.gc?.();
    }
    const usage = process.memoryUsage();
    // Split the heap pools so a hosted OOM/crash tail says WHICH pool grew:
    // old-space (heapUsed/heapTotal, bounded by --max-old-space-size) vs
    // off-heap (external/arrayBuffers, NOT bounded by that flag). The whole
    // point of this line is post-mortem forensics on truncated hosted logs.
    console.error(
      `[MEM] ${label} turn=${turnNumber} rssMB=${mb(usage.rss)} heapUsedMB=${mb(usage.heapUsed)} heapTotalMB=${mb(usage.heapTotal)} externalMB=${mb(usage.external)} arrayBuffersMB=${mb(usage.arrayBuffers)}`,
    );
  };
  // Hand the episode's map dataset to the mirror's game (ownership transfer:
  // the game mutates tile state in place; the spawn scan above already ran on
  // the pristine pre-game state, exactly like its former private copy).
  const mirror = new modules.AgentLocalGameMirror(mapLoader, log, terrain);
  // Time-based curve too (snapshots can be sparse); unref'd so it never holds
  // the process open, cleared on completion.
  const memTelemetryTimer = setInterval(
    () => logMemTelemetry("interval", mirror.turnCount()),
    60_000,
  );
  memTelemetryTimer.unref();
  const mirrorMessages = () => participants[0]?.runner.serverMessages() ?? [];
  const league = new modules.AgentLeagueMatchRunner({
    game,
    participants,
    spawnCandidates,
    log,
    episodeIndex: episodeIndexFromConfig(config),
    // World 12P OOM fix: skip the ~8 KB/record tacticalAffordances summary (not
    // part of the hosted result contract) so the FULL decision log stays small
    // and complete. Simulation, decisions, and decision telemetry are
    // unaffected.
    retainTacticalAffordances: false,
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
        requireWinner: commanderXpGameplay,
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
        // Retention keeps an EVEN temporal spread, not just a bounded array:
        // halving alone left the head coarse and the tail fine, which cost live
        // episodes most of their early game (see spectator-snapshot-retention.ts).
        offerSnapshot(snapshotRetention, spectatorSnapshot);
        protocolServer.recordSnapshot(spectatorSnapshot, {
          width: snapshot.gameState.width(),
          height: snapshot.gameState.height(),
          gameMap: String(snapshot.gameState.config().gameConfig().gameMap),
          gameMapSize: String(
            snapshot.gameState.config().gameConfig().gameMapSize,
          ),
        });
        memTelemetrySnapshots += 1;
        // Hosted default stays every-10 (lean log tail); local repro can set
        // PROXYWAR_MEM_TELEMETRY_EVERY=1 for per-decision-step heap resolution.
        const memEvery = Number(
          process.env.PROXYWAR_MEM_TELEMETRY_EVERY ?? "10",
        );
        if (memEvery <= 1 || memTelemetrySnapshots % memEvery === 1) {
          logMemTelemetry("snapshot", snapshot.turnNumber);
        }
      },
      log,
    });
    const completedAt = Date.now();
    clearInterval(memTelemetryTimer);
    logMemTelemetry("episode-complete", mirror.turnCount());
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
    const spawnSelectionNote =
      "spawnSelectionMode=sealed-ranked-v1; one concurrent hidden ballot, no reaction phase.";
    // The episode rarely ends on a stride boundary, and the replay builder reads
    // `finalGameState` for map metadata only — so the terminal frame has to be
    // reserved here or the artifact ends before the result.
    finalizeSnapshotRetention(snapshotRetention);
    const spectatorReplay = modules.buildAgentSpectatorReplay({
      runID,
      matchID: game.id,
      scenario: "coworld",
      brainMode: "external-http",
      runnerMode: "step-locked",
      finalGameState: stepResult.finalGameState,
      roster,
      snapshots: spectatorSnapshots,
      notes: [runNote, certificationNote, spawnSelectionNote],
    });
    // runAgentStepLockedLeague finalizes deals before returning. Preserve an
    // enabled-but-empty ledger as evidence that no proposal occurred; omit the
    // field and artifact entirely when structured deals were disabled.
    const dealLedger = league.dealLedgerEnabled()
      ? league.dealLedger()
      : undefined;
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
        spawnSelectionMode: "sealed-ranked-v1",
      },
      startedAt,
      completedAt,
      records: league.decisionRecords(),
      ...(dealLedger !== undefined ? { dealLedger } : {}),
      roster,
      finalState,
      spectatorReplay,
      gameRecord,
      rootDir: path.join(workspace, "proxywar-runs"),
      notes: [runNote, certificationNote, spawnSelectionNote],
    });
    const compactSpectatorReplay =
      artifacts.spectatorReplayPath === null
        ? spectatorReplay
        : JSON.parse(await fs.readFile(artifacts.spectatorReplayPath, "utf8"));
    if (commanderXpEval) {
      const { commanderXpGameEvidenceLine, projectCommanderXpGameEvidence } =
        await importProxyWar("src/server/agents/CommanderXpGameEvidence.ts");
      for (const record of league.decisionRecords()) {
        const evidence = projectCommanderXpGameEvidence(
          record,
          config.commander_xp_run_key,
        );
        if (evidence !== null) {
          console.log(commanderXpGameEvidenceLine(evidence));
        }
      }
    }
    const results = coworldResults({
      gameId: game.id,
      seed: episodeIdentity.seed,
      players: config.players,
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
        inlineRunArtifacts: await coworldInlineRunArtifacts({
          gameRecord,
          artifacts,
        }),
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
    tunablesMod,
    commanderEvidenceMod,
    commanderIdentityMod,
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
    importProxyWar("src/server/agents/AgentTunables.ts"),
    importProxyWar("src/server/agents/CommanderXpGameEvidence.ts"),
    importProxyWar("src/server/agents/CommanderXpCoworldIdentity.ts"),
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
    ...tunablesMod,
    ...commanderEvidenceMod,
    ...commanderIdentityMod,
  };
}

function importProxyWar(relativePath: string): Promise<Record<string, any>> {
  return import(pathToFileURL(path.join(proxyWarRepo, relativePath)).href);
}

function startPlayers(
  config: CoworldConfig,
  protocolServer: CoworldProtocolServer,
): ChildProcess[] {
  // Opt-in override so a local proof can drive the REAL league starter
  // (tester-starter-llm) against this exact hosted code path instead of the
  // bundled deterministic seat. Unset — which is always the case in the
  // image — resolves to the bundled player, so hosted behavior is unchanged.
  const playerScript =
    process.env.PROXYWAR_PLAYER_SCRIPT ??
    path.join(localRoot, "src", "starter-player.mjs");
  return config.tokens.map((_token, slot) =>
    spawn(process.execPath, [playerScript], {
      cwd: localRoot,
      env: {
        ...process.env,
        PROXYWAR_REPO: proxyWarRepo,
        COWORLD_PLAYER_WS_URL: protocolServer.playerUrl(slot),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).on("error", (error) => {
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
      // string | Buffer is a valid request body at runtime; the DOM BodyInit
      // type (loaded alongside Node's fetch in this monorepo) doesn't model
      // Buffer, so assert the runtime-correct type.
      body: body as BodyInit,
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
    commander_xp_phase: config.commander_xp_phase,
    commander_xp_run_key: config.commander_xp_run_key,
    players: config.players,
    max_decision_steps: config.max_decision_steps,
    turns_per_decision_step: config.turns_per_decision_step,
    max_decision_ms: config.max_decision_ms,
    map: config.map,
    map_size: config.map_size,
    difficulty: config.difficulty,
    seed: config.seed,
    replay_tail_turns: config.replay_tail_turns,
    episodeIndex: config.episodeIndex,
    num_agents: config.num_agents,
    episode_timeout_seconds: config.episode_timeout_seconds,
    player_connect_timeout_seconds: config.player_connect_timeout_seconds,
    player_count: config.tokens.length,
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
      commander_xp_phase:
        config.commander_xp_phase === "provider-preflight" ||
        config.commander_xp_phase === "canary" ||
        config.commander_xp_phase === "confirmatory"
          ? config.commander_xp_phase
          : undefined,
      commander_xp_run_key:
        typeof config.commander_xp_run_key === "string"
          ? config.commander_xp_run_key
          : undefined,
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
      episodeIndex:
        typeof config.episodeIndex === "number"
          ? config.episodeIndex
          : undefined,
      num_agents:
        typeof config.num_agents === "number" ? config.num_agents : undefined,
      episode_timeout_seconds:
        typeof config.episode_timeout_seconds === "number"
          ? config.episode_timeout_seconds
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
  // Resolve each participant's live Player once, by clientID identity.
  const resolved = input.participants.map((participant) => {
    const clientID = participant.runner.clientID();
    const player =
      clientID === null ? null : input.gameState.playerByClientID(clientID);
    return { participant, player };
  });
  // Winner -> slot by IDENTITY (see resolveWinnerSlot — never a name substring).
  const winnerRef: WinnerRef =
    winner === null
      ? { type: "none" }
      : typeof winner === "string"
        ? { type: "team", team: winner }
        : { type: "player", id: winner.id() };
  const winnerSlot = resolveWinnerSlot(
    resolved.map(({ player }) => ({
      id: player?.id() ?? null,
      team: player?.team() ?? null,
      tilesOwned: player?.numTilesOwned() ?? 0,
    })),
    winnerRef,
  );
  return {
    phase,
    winnerSlot,
    tick: input.gameState.ticks(),
    turnCount: input.turnCount,
    players: resolved.map(({ participant, player }) => ({
      agentID: participant.runner.agentID,
      username: participant.spec.username,
      profile: participant.spec.profile,
      playerID: player?.id() ?? null,
      isAlive: player?.isAlive() ?? null,
      tilesOwned: player?.numTilesOwned() ?? null,
      troops: player?.troops() ?? null,
      gold: player?.gold()?.toString() ?? null,
    })),
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
  route: CoworldAppShellRoute,
): Promise<void> {
  // Cover the shell with a Proxy War splash from the first paint — the
  // landing page in index.html must never flash on Observatory surfaces.
  const html = injectCoworldSplash(await proxyWarAppShellHtml(), route);
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
    case ".jsonl":
      return "text/plain; charset=utf-8";
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
    `- Degraded (llmPlannerDegraded): ${input.results.degraded_count}`,
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

// Defense-in-depth: a throw inside a ws/event listener or any async callback would
// otherwise crash the container with a bare stack (or hang). Log it loudly and exit
// non-zero so the platform sees a clearly-failed episode, never a silent crash.
process.on("uncaughtException", (error) => {
  console.error("[coworld] FATAL uncaughtException:", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[coworld] FATAL unhandledRejection:", reason);
  process.exit(1);
});

await main();
