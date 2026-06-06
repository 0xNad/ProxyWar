import fs from "fs/promises";
import path from "path";
import { Game, UnitType } from "../../core/game/Game";
import {
  GameRecord,
  GameStartInfo,
  PlayerRecord,
  ServerMessage,
  Turn,
} from "../../core/Schemas";
import { createPartialGameRecord, replacer } from "../../core/Util";
import { AgentDecisionRecord, AgentStrategyProfile } from "./AgentTypes";
import type { AgentRunRosterEntry } from "./AgentDecisionLogWriter";

export interface AgentSpectatorDecision {
  sequence: number;
  agentID: string;
  username: string;
  profile: AgentStrategyProfile;
  brainType: string;
  turnNumber: number;
  selectedLegalActionId: string;
  selectedActionKind: string;
  reason: string;
  decisionLatencyMs: number;
  accepted: boolean;
  resultReason: string;
  fallbackUsed: boolean;
  auditStatus?: string;
  auditReason?: string;
  objectiveKind?: string;
  objectiveSummary?: string;
  planObjective?: string;
  planRationale?: string;
  planFollowed?: boolean;
  selectedSkill?: string;
  selectedSkillScore?: number;
  skillSummary?: string;
  intentSummary: string;
  socialText?: string;
  socialTargetName?: string;
  emojiContext?: string;
}

export interface AgentSpectatorPlayerState {
  agentID: string | null;
  clientID: string | null;
  playerID: string;
  username: string;
  profile: AgentStrategyProfile | null;
  brainType: string | null;
  color: string;
  isAlive: boolean;
  hasSpawned: boolean;
  tilesOwned: number;
  troops: number;
  gold: string;
  tiles: number[];
  units: Array<{
    type: UnitType;
    tile: number;
  }>;
}

export interface AgentSpectatorSnapshot {
  label: string;
  turnNumber: number;
  tick: number;
  phase: "spawn" | "active" | "finished";
  decisions: AgentSpectatorDecision[];
  players: AgentSpectatorPlayerState[];
}

export interface AgentSpectatorReplay {
  schemaVersion: 1;
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: string;
  runnerMode: string;
  readOnly: true;
  spectatorOccupiesPlayerSlot: false;
  replayKind: "artifact-snapshot-replay";
  map: {
    width: number;
    height: number;
    gameMap: string;
    gameMapSize: string;
  };
  roster: AgentRunRosterEntry[];
  snapshots: AgentSpectatorSnapshot[];
  notes: string[];
}

export interface WriteAgentSpectatorReplayInput {
  replay: AgentSpectatorReplay;
  directory: string;
  gameRecord?: GameRecord | null;
}

export interface AgentSpectatorReplayPaths {
  spectatorPath: string;
  replayDataPath: string;
  gameRecordPath: string | null;
}

const playerColors = [
  "#ef4444",
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#65a30d",
];

const spectatorUnitTypes = [
  UnitType.City,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.Port,
] as const;
const maxReplaySnapshotsForArtifact = 80;
const maxTilesPerReplayPlayer = 800;

export function buildAgentSpectatorSnapshot(input: {
  label: string;
  turnNumber: number;
  gameState: Game;
  records: AgentDecisionRecord[];
  roster: AgentRunRosterEntry[];
}): AgentSpectatorSnapshot {
  const rosterEntriesWithClient = input.roster.filter(
    (entry): entry is AgentRunRosterEntry & { clientID: string } =>
      entry.clientID !== null,
  );
  const rosterByClient = new Map(
    rosterEntriesWithClient.map((entry) => [entry.clientID, entry]),
  );
  const rosterByUsername = new Map(
    input.roster.map((entry) => [entry.username, entry]),
  );
  const colorByClient = new Map(
    rosterEntriesWithClient.map((entry, index) => [
      entry.clientID,
      playerColors[index % playerColors.length],
    ]),
  );

  return {
    label: input.label,
    turnNumber: input.turnNumber,
    tick: input.gameState.ticks(),
    phase: input.gameState.getWinner()
      ? "finished"
      : input.gameState.inSpawnPhase()
        ? "spawn"
        : "active",
    decisions: input.records.map(spectatorDecision),
    players: input.gameState.players().map((player, index) => {
      const playerClientID = player.clientID();
      const rosterEntry =
        (playerClientID === null ? undefined : rosterByClient.get(playerClientID)) ??
        rosterByUsername.get(player.name());
      return {
        agentID: rosterEntry?.agentID ?? null,
        clientID: playerClientID,
        playerID: player.id(),
        username: player.name(),
        profile: rosterEntry?.profile ?? null,
        brainType: rosterEntry?.brainType ?? null,
        color:
          (playerClientID === null ? undefined : colorByClient.get(playerClientID)) ??
          playerColors[index % playerColors.length],
        isAlive: player.isAlive(),
        hasSpawned: player.hasSpawned(),
        tilesOwned: player.numTilesOwned(),
        troops: player.troops(),
        gold: player.gold().toString(),
        tiles: Array.from(player.tiles()),
        units: spectatorUnitTypes.flatMap((type) =>
          player.units(type).map((unit) => ({
            type,
            tile: unit.tile(),
          })),
        ),
      };
    }),
  };
}

export function buildAgentSpectatorReplay(input: {
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: string;
  runnerMode: string;
  finalGameState: Game;
  roster: AgentRunRosterEntry[];
  snapshots: AgentSpectatorSnapshot[];
  notes?: string[];
}): AgentSpectatorReplay {
  return {
    schemaVersion: 1,
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    runnerMode: input.runnerMode,
    readOnly: true,
    spectatorOccupiesPlayerSlot: false,
    replayKind: "artifact-snapshot-replay",
    map: {
      width: input.finalGameState.width(),
      height: input.finalGameState.height(),
      gameMap: String(input.finalGameState.config().gameConfig().gameMap),
      gameMapSize: String(input.finalGameState.config().gameConfig().gameMapSize),
    },
    roster: input.roster,
    snapshots: input.snapshots,
    notes: [
      "This is a local artifact replay. It does not connect to GameServer and cannot submit intents.",
      "The native Proxy War replay client expects archived GameRecord API data; game-record.json is saved as a future integration hook.",
      ...(input.notes ?? []),
    ],
  };
}

export function buildGameRecordFromServerMessages(input: {
  messages: ServerMessage[];
  startedAt: number;
  completedAt: number;
}): GameRecord | null {
  const start = input.messages.find(
    (message): message is Extract<ServerMessage, { type: "start" }> =>
      message.type === "start",
  );
  if (!start) {
    return null;
  }

  const turns = input.messages
    .filter(
      (message): message is Extract<ServerMessage, { type: "turn" }> =>
        message.type === "turn",
    )
    .map((message) => message.turn)
    .filter(uniqueTurn())
    .sort((a, b) => a.turnNumber - b.turnNumber);

  return finalizeLocalGameRecord(
    start.gameStartInfo,
    turns,
    input.startedAt,
    input.completedAt,
  );
}

export async function writeAgentSpectatorReplayArtifacts(
  input: WriteAgentSpectatorReplayInput,
): Promise<AgentSpectatorReplayPaths> {
  const replay = compactSpectatorReplayForArtifact(input.replay);
  const replayDataPath = path.join(input.directory, "spectator-replay.json");
  const spectatorPath = path.join(input.directory, "spectator.html");
  const gameRecordPath =
    input.gameRecord === null || input.gameRecord === undefined
      ? null
      : path.join(input.directory, "game-record.json");

  await fs.writeFile(
    replayDataPath,
    `${JSON.stringify(replay, null, 2)}\n`,
  );
  if (gameRecordPath !== null) {
    try {
      await fs.writeFile(
        gameRecordPath,
        `${JSON.stringify(input.gameRecord, replacer, 2)}\n`,
      );
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }
      console.warn(
        `[AgentSpectatorReplay] Full game-record.json was too large to serialize for run "${input.replay.runID}" in ${input.directory}; wrote a compacted stub instead. The native Proxy War renderer cannot replay this run (treated as no rendered replay).`,
      );
      await fs.writeFile(
        gameRecordPath,
        `${JSON.stringify(compactGameRecordSummary(input.gameRecord), null, 2)}\n`,
      );
    }
  }
  await fs.writeFile(spectatorPath, spectatorHtml(replay));

  return {
    spectatorPath,
    replayDataPath,
    gameRecordPath,
  };
}

function compactSpectatorReplayForArtifact(
  replay: AgentSpectatorReplay,
): AgentSpectatorReplay {
  const snapshots = sampleSnapshots(
    replay.snapshots,
    maxReplaySnapshotsForArtifact,
  ).map(compactSnapshotTiles);
  const snapshotCompacted = snapshots.length < replay.snapshots.length;
  const tilesCompacted = snapshots.some((snapshot, index) =>
    snapshot.players.some(
      (player, playerIndex) =>
        player.tiles.length <
        (sampleSnapshots(
          replay.snapshots,
          maxReplaySnapshotsForArtifact,
        )[index]?.players[playerIndex]?.tiles.length ?? player.tiles.length),
    ),
  );
  if (!snapshotCompacted && !tilesCompacted) {
    return replay;
  }
  return {
    ...replay,
    snapshots,
    notes: [
      ...replay.notes,
      `Spectator artifact compacted for long-match stability: ${replay.snapshots.length} snapshot(s) sampled to ${snapshots.length}; player tile arrays capped at ${maxTilesPerReplayPlayer} tiles per snapshot. Match-report, decisions.jsonl, and benchmark artifacts retain the full decision timeline.`,
    ],
  };
}

function sampleSnapshots(
  snapshots: AgentSpectatorSnapshot[],
  maxSnapshots: number,
): AgentSpectatorSnapshot[] {
  if (snapshots.length <= maxSnapshots) {
    return snapshots;
  }
  if (maxSnapshots <= 1) {
    return [snapshots[snapshots.length - 1]];
  }
  const sampled: AgentSpectatorSnapshot[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < maxSnapshots; index += 1) {
    const sourceIndex = Math.round(
      (index * (snapshots.length - 1)) / (maxSnapshots - 1),
    );
    if (!seen.has(sourceIndex)) {
      sampled.push(snapshots[sourceIndex]);
      seen.add(sourceIndex);
    }
  }
  return sampled;
}

function compactSnapshotTiles(
  snapshot: AgentSpectatorSnapshot,
): AgentSpectatorSnapshot {
  return {
    ...snapshot,
    players: snapshot.players.map((player) => ({
      ...player,
      tiles: sampleNumbers(player.tiles, maxTilesPerReplayPlayer),
    })),
  };
}

function sampleNumbers(values: number[], maxValues: number): number[] {
  if (values.length <= maxValues) {
    return values;
  }
  if (maxValues <= 1) {
    return values.slice(0, 1);
  }
  const sampled: number[] = [];
  for (let index = 0; index < maxValues; index += 1) {
    sampled.push(values[Math.floor((index * values.length) / maxValues)]);
  }
  return sampled;
}

function compactGameRecordSummary(gameRecord: GameRecord | null | undefined): {
  compacted: true;
  reason: string;
  turnCount: number;
  gameID: string | null;
} {
  return {
    compacted: true,
    reason:
      "Full native game-record.json was too large to serialize in this local artifact run. Use decisions.jsonl, match-report.md, visual-report.html, and spectator-replay.json for inspection.",
    turnCount: Array.isArray(gameRecord?.turns) ? gameRecord.turns.length : 0,
    gameID:
      typeof gameRecord?.info?.gameID === "string"
        ? gameRecord.info.gameID
        : null,
  };
}

/**
 * A rendered (native Proxy War) replay is only "available" when game-record.json holds a
 * real GameRecord — not the `{ compacted: true, ... }` stub that
 * writeAgentSpectatorReplayArtifacts falls back to when JSON.stringify of the full record
 * throws RangeError (see compactGameRecordSummary). The native client renderer
 * (src/client/Main.ts) runs GameRecordSchema.safeParse on this file, so a stub passes a
 * fileExists()-only "replay available" gate yet dead-ends the renderer with an
 * "invalid replay record" alert. "Replay available" gates must use this, not fileExists.
 */
export async function gameRecordFileIsRenderable(
  filePath: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const record = parsed as { compacted?: unknown; turns?: unknown };
  // The compacted stub is { compacted: true, ... } and has no turns timeline; a real
  // GameRecord always carries a top-level turns array (GameRecordSchema in Schemas.ts).
  return record.compacted !== true && Array.isArray(record.turns);
}

function spectatorDecision(record: AgentDecisionRecord): AgentSpectatorDecision {
  const metadata = record.decisionMetadata ?? {};
  return {
    sequence: record.sequence,
    agentID: record.agentID,
    username: record.username,
    profile: record.profile,
    brainType: record.brainType,
    turnNumber: record.turnNumber,
    selectedLegalActionId: record.chosenActionID,
    selectedActionKind: record.chosenActionKind,
    reason: record.reason,
    decisionLatencyMs: record.decisionLatencyMs,
    accepted: record.result.accepted,
    resultReason: record.result.reason,
    fallbackUsed: metadata.fallbackUsed === true,
    auditStatus: record.audit?.auditStatus,
    auditReason: record.audit?.auditReason,
    objectiveKind: record.objectiveKind,
    objectiveSummary: record.objectiveSummary,
    planObjective:
      typeof metadata.planObjective === "string"
        ? metadata.planObjective
        : undefined,
    planRationale:
      typeof metadata.planRationale === "string"
        ? metadata.planRationale
        : undefined,
    planFollowed:
      typeof metadata.planFollowed === "boolean"
        ? metadata.planFollowed
        : undefined,
    selectedSkill:
      typeof metadata.selectedSkill === "string"
        ? metadata.selectedSkill
        : undefined,
    selectedSkillScore:
      typeof metadata.selectedSkillScore === "number"
        ? metadata.selectedSkillScore
        : undefined,
    skillSummary:
      typeof metadata.skillSummary === "string" ? metadata.skillSummary : undefined,
    intentSummary: record.intent === null ? "none" : JSON.stringify(record.intent),
    ...spectatorSocialFields(record),
  };
}

function spectatorSocialFields(
  record: AgentDecisionRecord,
): Pick<
  AgentSpectatorDecision,
  "socialText" | "socialTargetName" | "emojiContext"
> {
  const metadata = record.chosenActionMetadata ?? {};
  const socialTargetName =
    typeof metadata.recipientName === "string"
      ? metadata.recipientName
      : typeof metadata.targetName === "string"
        ? metadata.targetName
        : undefined;
  if (record.chosenActionKind === "quick_chat") {
    const socialText =
      typeof metadata.message === "string"
        ? metadata.message
        : typeof metadata.quickChatKey === "string"
          ? metadata.quickChatKey
          : "Quick chat";
    return { socialText, socialTargetName };
  }
  if (record.chosenActionKind === "emoji") {
    const socialText =
      typeof metadata.emojiText === "string"
        ? metadata.emojiText
        : typeof metadata.emoji === "number"
          ? `emoji ${metadata.emoji}`
          : "Emoji";
    return {
      socialText,
      socialTargetName,
      emojiContext:
        typeof metadata.emojiContext === "string"
          ? metadata.emojiContext
          : undefined,
    };
  }
  return {};
}

function finalizeLocalGameRecord(
  startInfo: GameStartInfo,
  turns: Turn[],
  startedAt: number,
  completedAt: number,
): GameRecord {
  const players: PlayerRecord[] = startInfo.players.map((player) => ({
    ...player,
    persistentID: null,
    stats: undefined,
  }));
  return {
    ...createPartialGameRecord(
      startInfo.gameID,
      startInfo.config,
      players,
      turns,
      startedAt,
      completedAt,
      undefined,
      startInfo.lobbyCreatedAt,
      startInfo.visibleAt,
    ),
    gitCommit: "DEV",
    subdomain: "local",
    domain: "ai-league-demo",
  };
}

function uniqueTurn(): (turn: Turn) => boolean {
  const seen = new Set<number>();
  return (turn) => {
    if (seen.has(turn.turnNumber)) {
      return false;
    }
    seen.add(turn.turnNumber);
    return true;
  };
}

function spectatorHtml(replay: AgentSpectatorReplay): string {
  const encoded = jsonForInlineScript(replay);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Spectator ${escapeHtml(replay.runID)}</title>
  <style>
    :root { color-scheme: light; --ink:#17202a; --muted:#627084; --line:#d9e2ec; --paper:#f7f9fc; --accent:#215a9c; --good:#19764b; --warn:#a55b00; --bad:#a32135; }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:var(--paper); }
    header { background:#fff; border-bottom:1px solid var(--line); padding:22px 28px; }
    h1 { margin:0; font-size:26px; }
    h2 { margin:0 0 10px; font-size:16px; }
    main { display:grid; grid-template-columns:minmax(520px, 1fr) 420px; gap:18px; padding:18px 28px 28px; max-width:1500px; margin:0 auto; }
    canvas { width:100%; height:auto; background:#d9e7f3; border:1px solid var(--line); border-radius:8px; display:block; }
    .panel, .map-panel { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; }
    .map-panel { display:grid; gap:12px; }
    .controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    button, select { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; padding:8px 10px; font-weight:700; cursor:pointer; }
    button:hover, select:hover { border-color:var(--accent); color:var(--accent); }
    input[type=range] { flex:1; min-width:180px; }
    .speed-control { display:inline-flex; align-items:center; gap:8px; min-width:220px; }
    .speed-control input { min-width:120px; }
    .filters { display:flex; gap:8px; flex-wrap:wrap; }
    .filters label { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--line); border-radius:999px; padding:4px 8px; font-size:12px; font-weight:700; }
    .metric-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:10px; }
    .metric { border:1px solid var(--line); border-radius:8px; padding:10px; }
    .metric strong { display:block; font-size:20px; margin-top:3px; }
    .side { display:grid; gap:14px; align-content:start; }
    .roster { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .agent { border:1px solid var(--line); border-radius:8px; padding:9px; display:grid; gap:4px; }
    .swatch { display:inline-block; width:10px; height:10px; border-radius:999px; margin-right:6px; vertical-align:middle; }
    .timeline { display:grid; gap:10px; max-height:56vh; overflow:auto; padding-right:4px; }
    .decision { border:1px solid var(--line); border-radius:8px; padding:10px; display:grid; gap:6px; }
    .decision { cursor:pointer; text-align:left; background:#fff; }
    .decision.active { outline:2px solid var(--accent); }
    .badges { display:flex; gap:6px; flex-wrap:wrap; }
    .badge { display:inline-flex; padding:2px 8px; border-radius:999px; background:#e7eef7; color:var(--accent); font-size:12px; font-weight:700; }
    .kind-build { background:#e7f5ee; color:var(--good); }
    .kind-embargo, .kind-attack { background:#fee7df; color:#923018; }
    .kind-quick_chat, .kind-emoji { background:#eef6ff; color:#1d5e8f; }
    .kind-spawn { background:#f5ecff; color:#6d3c99; }
    .kind-hold { background:#eef2f7; color:#475569; }
    .status-ok, .audit-confirmed { background:#e5f8ef; color:var(--good); }
    .status-bad, .audit-failed { background:#fde8ed; color:var(--bad); }
    .status-warn, .audit-unknown { background:#fff2dc; color:var(--warn); }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap:anywhere; }
    .muted { color:var(--muted); }
    .paths { display:flex; gap:10px; flex-wrap:wrap; }
    .chat-bubble { display:inline-block; margin:6px 0 2px; padding:7px 9px; border:1px solid #c8dcf2; border-radius:12px 12px 12px 3px; background:#eef6ff; color:#17324d; font-weight:700; }
    .notice { margin-top:12px; padding:12px 14px; border:1px solid #dbe4ef; border-radius:8px; background:#f8fbff; color:#334155; }
    .notice ul { margin:8px 0 0; padding-left:18px; }
    .current-frame { margin-top:14px; }
    .current-frame .timeline { max-height:220px; }
    a { color:var(--accent); font-weight:700; text-decoration:none; }
    a:hover { text-decoration:underline; }
    @media (max-width: 980px) { main { grid-template-columns:1fr; } .side { order:2; } }
  </style>
</head>
<body>
  <script id="spectator-data" type="application/json">${encoded}</script>
  <header>
    <h1>Proxy War Spectator</h1>
    <div class="muted">${escapeHtml(replay.runID)} · read-only artifact replay · spectator occupies no player slot</div>
  </header>
  <main>
    <section class="map-panel">
      <canvas id="map" width="1100" height="720" aria-label="Proxy War replay map"></canvas>
      <div class="controls">
        <button id="prev" type="button">Prev</button>
        <button id="play" type="button">Play</button>
        <button id="next" type="button">Next</button>
        <input id="scrub" type="range" min="0" max="0" value="0">
        <strong id="frame-label"></strong>
        <label class="speed-control">Speed
          <input id="speed" type="range" min="0" max="4" value="1" step="1" aria-label="Replay speed">
          <strong id="speed-label">1x</strong>
        </label>
        <select id="follow-agent" aria-label="Follow agent"></select>
      </div>
      <div id="kind-filters" class="filters" aria-label="Action filters"></div>
      <div class="metric-grid">
        <div class="metric">Brain<strong id="brain"></strong></div>
        <div class="metric">Runner<strong id="runner"></strong></div>
        <div class="metric">Turn<strong id="turn"></strong></div>
        <div class="metric">Tick<strong id="tick"></strong></div>
      </div>
      <div id="replay-notes" class="notice"></div>
      <section class="panel current-frame">
        <h2>Current Frame Decisions</h2>
        <div id="current-decisions" class="timeline"></div>
      </section>
    </section>
    <aside class="side">
      <section class="panel">
        <h2>Agents</h2>
        <div id="roster" class="roster"></div>
      </section>
      <section class="panel">
        <h2>Decision Timeline</h2>
        <div id="decisions" class="timeline"></div>
      </section>
      <section class="panel">
        <h2>Selected Decision</h2>
        <div id="selected-decision" class="decision"></div>
      </section>
      <section class="panel">
        <h2>Artifacts</h2>
        <div class="paths">
          <a href="./visual-report.html">visual report</a>
          <a href="./match-report.md">match report</a>
          <a href="./decisions.jsonl">decisions.jsonl</a>
          <a href="./match-summary.json">summary</a>
          <a href="./spectator-replay.json">spectator data</a>
          <a href="./game-record.json">game record hook</a>
          <a href="/ai-league-replay/${encodeURIComponent(replay.runID)}">real Proxy War renderer</a>
        </div>
        <p class="muted">This viewer is static and read-only: it opens no socket, creates no player, and has no intent submission path. The real Proxy War renderer link is proxied by the local demo/beta server.</p>
      </section>
    </aside>
  </main>
  <script>
    const replay = JSON.parse(document.getElementById("spectator-data").textContent);
    const canvas = document.getElementById("map");
    const ctx = canvas.getContext("2d");
    const scrub = document.getElementById("scrub");
    const speedSlider = document.getElementById("speed");
    const speedLabel = document.getElementById("speed-label");
    const playButton = document.getElementById("play");
    const followAgentSelect = document.getElementById("follow-agent");
    const speedOptions = [
      { label: "0.5x", delayMs: 2200 },
      { label: "1x", delayMs: 1400 },
      { label: "2x", delayMs: 800 },
      { label: "4x", delayMs: 420 },
      { label: "Max", delayMs: 160 },
    ];
    const allDecisions = replay.snapshots.flatMap((item, index) => item.decisions.map((decision) => ({ ...decision, frameIndex: index, frameLabel: item.label })));
    const actionKinds = Array.from(new Set(allDecisions.map((decision) => decision.selectedActionKind))).sort();
    const enabledKinds = new Set(actionKinds);
    let frame = initialFrameFromUrl();
    let timer = null;
    let followedAgentID = "";
    let selectedDecisionSequence =
      allDecisions.find((decision) => decision.frameIndex === frame)?.sequence ||
      allDecisions[0]?.sequence ||
      null;
    scrub.max = String(Math.max(0, replay.snapshots.length - 1));
    scrub.value = String(frame);
    document.getElementById("brain").textContent = replay.brainMode;
    document.getElementById("runner").textContent = replay.runnerMode;
    document.getElementById("replay-notes").innerHTML =
      '<strong>Replay mode</strong>' +
      '<ul>' +
      (Array.isArray(replay.notes) && replay.notes.length > 0
        ? replay.notes.map((note) => '<li>' + escapeHtml(note) + '</li>').join("")
        : '<li>This run did not include additional replay notes.</li>') +
      '</ul>';
    followAgentSelect.innerHTML = '<option value="">Follow all agents</option>' + replay.roster.map((agent) => '<option value="' + escapeHtml(agent.agentID) + '">' + escapeHtml(agent.username) + '</option>').join("");
    followAgentSelect.addEventListener("change", () => {
      followedAgentID = followAgentSelect.value;
      selectCurrentFrameDecisionIfNeeded();
      render();
    });
    document.getElementById("kind-filters").innerHTML = actionKinds.map((kind) =>
      '<label><input type="checkbox" checked value="' + escapeHtml(kind) + '"> ' + escapeHtml(kind) + '</label>'
    ).join("");
    document.querySelectorAll("#kind-filters input").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) enabledKinds.add(input.value);
        else enabledKinds.delete(input.value);
        selectCurrentFrameDecisionIfNeeded();
        render();
      });
    });
    document.getElementById("prev").addEventListener("click", () => setFrame(frame - 1));
    document.getElementById("next").addEventListener("click", () => setFrame(frame + 1));
    scrub.addEventListener("input", () => setFrame(Number(scrub.value)));
    speedSlider.addEventListener("input", () => {
      speedLabel.textContent = currentSpeed().label;
      if (timer) {
        stopPlayback();
        startPlayback();
      }
    });
    playButton.addEventListener("click", () => {
      if (timer) {
        stopPlayback();
        return;
      }
      startPlayback();
    });

    function currentSpeed() {
      const index = Math.max(0, Math.min(speedOptions.length - 1, Number(speedSlider.value)));
      return speedOptions[index];
    }

    function startPlayback() {
      playButton.textContent = "Pause";
      timer = setInterval(() => {
        if (frame >= replay.snapshots.length - 1) {
          stopPlayback();
          return;
        }
        setFrame(frame + 1);
      }, currentSpeed().delayMs);
    }

    function stopPlayback() {
      clearInterval(timer);
      timer = null;
      playButton.textContent = "Play";
    }

    function initialFrameFromUrl() {
      const frameParam = new URLSearchParams(window.location.search).get("frame");
      const lastFrame = Math.max(0, replay.snapshots.length - 1);
      if (frameParam === "last") return lastFrame;
      if (frameParam === null || frameParam === "") return 0;
      const requestedFrame = Number(frameParam);
      if (!Number.isFinite(requestedFrame)) return 0;
      return Math.max(0, Math.min(lastFrame, Math.floor(requestedFrame)));
    }

    function setFrame(nextFrame) {
      if (replay.snapshots.length === 0) {
        frame = 0;
        scrub.value = "0";
        render();
        return;
      }
      frame = Math.max(0, Math.min(replay.snapshots.length - 1, nextFrame));
      scrub.value = String(frame);
      selectCurrentFrameDecisionIfNeeded();
      render();
    }

    function selectCurrentFrameDecisionIfNeeded() {
      const stillVisible = allDecisions.some((decision) =>
        decision.sequence === selectedDecisionSequence &&
        decision.frameIndex === frame &&
        decisionPassesFilters(decision)
      );
      if (stillVisible) return;
      const candidate = allDecisions.find((decision) =>
        decision.frameIndex === frame &&
        decisionPassesFilters(decision)
      );
      if (candidate) selectedDecisionSequence = candidate.sequence;
    }

    function render() {
      if (replay.snapshots.length === 0) {
        document.getElementById("frame-label").textContent = "No snapshots";
        document.getElementById("turn").textContent = "n/a";
        document.getElementById("tick").textContent = "n/a";
        document.getElementById("roster").innerHTML = replay.roster.map((agent) =>
          '<article class="agent"><strong>' + escapeHtml(agent.username) +
          '</strong><span class="muted">' + escapeHtml(agent.profile || "agent") +
          ' · ' + escapeHtml(agent.brainType || replay.brainMode) +
          '</span><code>no snapshot state</code></article>'
        ).join("");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#d9e7f3";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#17202a";
        ctx.font = "22px system-ui, sans-serif";
        ctx.fillText("No replay snapshots were captured for this run.", 32, 64);
        document.getElementById("decisions").innerHTML =
          '<article class="decision"><strong>No snapshot timeline</strong><p class="muted">The run still has artifact links, but no map frames were captured.</p></article>';
        return;
      }
      const snapshot = replay.snapshots[frame];
      document.getElementById("frame-label").textContent = snapshot.label;
      document.getElementById("turn").textContent = snapshot.turnNumber;
      document.getElementById("tick").textContent = snapshot.tick;
      renderRoster(snapshot);
      renderMap(snapshot);
      renderCurrentFrameDecisions(snapshot);
      renderDecisions(snapshot);
    }

    function renderRoster(snapshot) {
      document.getElementById("roster").innerHTML = snapshot.players.map((player) =>
        '<article class="agent"><strong><span class="swatch" style="background:' + player.color + '"></span>' +
        escapeHtml(player.username) + '</strong><span class="muted">' +
        escapeHtml(player.profile || "agent") + ' · ' + escapeHtml(player.brainType || replay.brainMode) +
        '</span><code>' + player.tilesOwned + ' tiles · ' + player.troops + ' troops</code></article>'
      ).join("");
    }

    function renderMap(snapshot) {
      const pad = 16;
      const scale = Math.min((canvas.width - pad * 2) / replay.map.width, (canvas.height - pad * 2) / replay.map.height);
      const offsetX = (canvas.width - replay.map.width * scale) / 2;
      const offsetY = (canvas.height - replay.map.height * scale) / 2;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#d9e7f3";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#eef5eb";
      ctx.fillRect(offsetX, offsetY, replay.map.width * scale, replay.map.height * scale);
      for (const player of snapshot.players) {
        const followed = followedAgentID === "" || player.agentID === followedAgentID;
        ctx.globalAlpha = followed ? 1 : 0.22;
        ctx.fillStyle = player.color;
        for (const tile of player.tiles) {
          const x = tile % replay.map.width;
          const y = Math.floor(tile / replay.map.width);
          ctx.fillRect(offsetX + x * scale, offsetY + y * scale, Math.max(1.2, scale), Math.max(1.2, scale));
        }
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 1;
        for (const unit of player.units) {
          const x = unit.tile % replay.map.width;
          const y = Math.floor(unit.tile / replay.map.width);
          ctx.beginPath();
          ctx.arc(offsetX + x * scale, offsetY + y * scale, Math.max(3, scale * 2), 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.stroke();
        }
        if (player.agentID === followedAgentID && player.tiles.length > 0) {
          const tile = player.tiles[Math.floor(player.tiles.length / 2)];
          const x = tile % replay.map.width;
          const y = Math.floor(tile / replay.map.width);
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#111827";
          ctx.font = "18px system-ui, sans-serif";
          ctx.fillText("Following " + player.username, offsetX + x * scale + 10, offsetY + y * scale + 10);
        }
      }
      ctx.globalAlpha = 1;
      renderSocialBubbles(snapshot, offsetX, offsetY, scale);
    }

    function renderSocialBubbles(snapshot, offsetX, offsetY, scale) {
      const socialDecisions = snapshot.decisions.filter((decision) =>
        decision.socialText &&
        (decision.selectedActionKind === "quick_chat" || decision.selectedActionKind === "emoji") &&
        decisionPassesFilters(decision)
      );
      ctx.font = "700 14px system-ui, sans-serif";
      for (const decision of socialDecisions) {
        const player = snapshot.players.find((candidate) =>
          candidate.agentID === decision.agentID || candidate.username === decision.username
        );
        if (!player || player.tiles.length === 0) continue;
        const center = playerCenter(player);
        const x = offsetX + center.x * scale;
        const y = offsetY + center.y * scale;
        const text = decision.selectedActionKind === "emoji"
          ? String(decision.socialText)
          : String(decision.socialText);
        const maxText = text.length > 42 ? text.slice(0, 39) + "..." : text;
        const width = Math.min(270, Math.max(44, ctx.measureText(maxText).width + 22));
        const height = 30;
        const bubbleX = Math.max(10, Math.min(canvas.width - width - 10, x - width / 2));
        const bubbleY = Math.max(10, y - 42);
        ctx.globalAlpha = 0.94;
        ctx.fillStyle = "#eef6ff";
        ctx.fillRect(bubbleX, bubbleY, width, height);
        ctx.strokeStyle = "#1d5e8f";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bubbleX, bubbleY, width, height);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#17324d";
        ctx.fillText(maxText, bubbleX + 11, bubbleY + 20);
      }
    }

    function playerCenter(player) {
      let sx = 0;
      let sy = 0;
      const tiles = player.tiles.slice(0, 120);
      for (const tile of tiles) {
        sx += tile % replay.map.width;
        sy += Math.floor(tile / replay.map.width);
      }
      return { x: sx / tiles.length, y: sy / tiles.length };
    }

    function renderDecisions(snapshot) {
      const visible = allDecisions.filter(decisionPassesFilters);
      document.getElementById("decisions").innerHTML = visible.map((decision) => {
        const active = decision.sequence === selectedDecisionSequence ? " active" : "";
        const acceptedClass = decision.accepted ? "status-ok" : "status-bad";
        const auditClass = decision.auditStatus ? "audit-" + decision.auditStatus : "status-warn";
        return '<article class="decision' + active + '" data-sequence="' + decision.sequence + '"><div class="badges">' +
          '<span class="badge kind-' + escapeHtml(decision.selectedActionKind) + '">' + escapeHtml(decision.selectedActionKind) + '</span>' +
          '<span class="badge ' + acceptedClass + '">' + (decision.accepted ? "accepted" : "rejected") + '</span>' +
          (decision.fallbackUsed ? '<span class="badge status-warn">fallback</span>' : '') +
          '<span class="badge ' + auditClass + '">' + escapeHtml(decision.auditStatus || "audit n/a") + '</span>' +
          '</div><strong>' + escapeHtml(decision.username) + '</strong>' +
          '<code>' + escapeHtml(decision.selectedLegalActionId) + '</code>' +
          socialBubbleHtml(decision) +
          '<p>' + escapeHtml(decision.reason) + '</p>' +
          '<span class="muted">' + escapeHtml(decision.frameLabel) + ' · ' + decision.decisionLatencyMs + 'ms · ' + escapeHtml(decision.intentSummary) + '</span></article>';
      }).join("");
      document.querySelectorAll("#decisions .decision").forEach((node) => {
        node.addEventListener("click", () => {
          const sequence = Number(node.getAttribute("data-sequence"));
          const decision = allDecisions.find((item) => item.sequence === sequence);
          if (decision) {
            selectedDecisionSequence = decision.sequence;
            setFrame(decision.frameIndex);
          }
        });
      });
      renderSelectedDecision();
    }

    function renderCurrentFrameDecisions(snapshot) {
      const visible = allDecisions.filter((decision) =>
        decision.frameIndex === frame &&
        decisionPassesFilters(decision)
      );
      const target = document.getElementById("current-decisions");
      if (visible.length === 0) {
        target.innerHTML =
          '<article class="decision"><strong>No decisions on this frame</strong><p class="muted">Keep playing or scrub to the next decision frame.</p></article>';
        return;
      }
      target.innerHTML = visible.map((decision) => {
        const active = decision.sequence === selectedDecisionSequence ? " active" : "";
        return '<article class="decision' + active + '" data-sequence="' + decision.sequence + '"><div class="badges">' +
          '<span class="badge kind-' + escapeHtml(decision.selectedActionKind) + '">' + escapeHtml(decision.selectedActionKind) + '</span>' +
          '<span class="badge ' + (decision.accepted ? "status-ok" : "status-bad") + '">' + (decision.accepted ? "accepted" : "rejected") + '</span>' +
          (decision.fallbackUsed ? '<span class="badge status-warn">fallback</span>' : '') +
          '</div><strong>' + escapeHtml(decision.username) + '</strong>' +
          '<code>' + escapeHtml(decision.selectedLegalActionId) + '</code>' +
          socialBubbleHtml(decision) +
          '<p>' + escapeHtml(decision.reason) + '</p>' +
          '<span class="muted">' + decision.decisionLatencyMs + 'ms · turn ' + decision.turnNumber + '</span></article>';
      }).join("");
      document.querySelectorAll("#current-decisions .decision").forEach((node) => {
        node.addEventListener("click", () => {
          const sequence = Number(node.getAttribute("data-sequence"));
          const decision = allDecisions.find((item) => item.sequence === sequence);
          if (decision) {
            selectedDecisionSequence = decision.sequence;
            render();
          }
        });
      });
    }

    function decisionPassesFilters(decision) {
      return enabledKinds.has(decision.selectedActionKind) &&
        (followedAgentID === "" || decision.agentID === followedAgentID);
    }

    function renderSelectedDecision() {
      const decision = allDecisions.find((item) => item.sequence === selectedDecisionSequence);
      if (!decision) {
        document.getElementById("selected-decision").innerHTML = '<p class="muted">Select a timeline entry to inspect the agent reason, plan, skill score, and generated intent.</p>';
        return;
      }
      document.getElementById("selected-decision").innerHTML =
        '<div class="badges"><span class="badge kind-' + escapeHtml(decision.selectedActionKind) + '">' + escapeHtml(decision.selectedActionKind) + '</span>' +
        '<span class="badge ' + (decision.accepted ? "status-ok" : "status-bad") + '">' + (decision.accepted ? "accepted" : "rejected") + '</span>' +
        (decision.fallbackUsed ? '<span class="badge status-warn">fallback</span>' : '') + '</div>' +
        '<strong>' + escapeHtml(decision.username) + '</strong>' +
        '<code>' + escapeHtml(decision.selectedLegalActionId) + '</code>' +
        socialBubbleHtml(decision) +
        '<p>' + escapeHtml(decision.reason) + '</p>' +
        '<p><b>Objective:</b> ' + escapeHtml(decision.objectiveSummary || decision.objectiveKind || "none") + '</p>' +
        '<p><b>Plan:</b> ' + escapeHtml(decision.planObjective || "none") + (decision.planFollowed === undefined ? '' : ' · followed=' + String(decision.planFollowed)) + '</p>' +
        '<p><b>Skill:</b> ' + escapeHtml(decision.selectedSkill || "none") + (decision.selectedSkillScore === undefined ? '' : ' · score=' + decision.selectedSkillScore) + '</p>' +
        '<p><b>Intent:</b> <code>' + escapeHtml(decision.intentSummary) + '</code></p>' +
        '<p><b>Audit:</b> ' + escapeHtml(decision.auditStatus || "n/a") + ' · ' + escapeHtml(decision.auditReason || "no audit reason") + '</p>' +
        '<details><summary>Skill alternatives</summary><code>' + escapeHtml(decision.skillSummary || "none") + '</code></details>';
    }

    function socialBubbleHtml(decision) {
      if (!decision.socialText) return "";
      const target = decision.socialTargetName ? ' <span class="muted">to ' + escapeHtml(decision.socialTargetName) + '</span>' : "";
      return '<div class="chat-bubble">' + escapeHtml(decision.socialText) + target + '</div>';
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    render();
  </script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
