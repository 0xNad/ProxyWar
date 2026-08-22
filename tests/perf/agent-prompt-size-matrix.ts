/**
 * Offline prompt-SIZE matrix for the agent decision surfaces (overnight
 * hardening loop 2026-08-16, charter item L).
 *
 * WHAT THIS IS: a measurement harness. It builds REAL observations and REAL
 * legal-action menus from a REAL stepped `Game`, renders the two prompt
 * surfaces a league seat actually pays for, and reports exact character counts
 * per prompt BLOCK across the feature matrix.
 *
 * WHAT THIS IS NOT: a prompt optimizer. The 2026-08-07 prompt-slim experiment
 * proved the enumerated menu is load-bearing and was reverted; a size number
 * here is an input to a sizing decision, never a licence to trim a prompt.
 *
 * Surfaces measured:
 *  1. `LlmPromptBuilder.build()` — the in-house action-selector prompt
 *     (src/server/agents/LlmPromptBuilder.ts).
 *  2. `buildState()` from the PUBLIC starter
 *     (coworld-adapter/tester-starter-llm/llm-player.mjs) — what every league
 *     builder's model actually receives. Extracted from source text the same
 *     way tests/coworld/StarterEconomyState.test.ts does, because the module
 *     opens a WebSocket at import time.
 *
 * Feature arms (server tunables are read fresh per call via
 * AgentTunables.tunedNumber, so each arm sets its env BEFORE building that
 * arm's observation + menu + prompt — never mid-build):
 *  - `base_no_warships`   0.1.47-era emulation: warship affordances stripped
 *                         (warships are UNCONDITIONAL in 0.1.48 — there is no
 *                         env flag — so the pre-warship arm is produced by
 *                         removing warship menu entries and
 *                         nonCombat.warshipMoveOptions; labelled emulation,
 *                         not a flag arm).
 *  - `warships`           0.1.48 shipped baseline.
 *  - `inhouse_social`     + the default-off in-house social prompt arm, with
 *                         both canonical deal and message slots populated
 *  - `spatial`            + PROXYWAR_TUNE_SPATIAL_OBSERVATION=1
 *  - `spatial_minimap`    + PROXYWAR_TUNE_SPATIAL_MINIMAP=1 (child flag)
 *  - `freetext_0/3/8`     + PROXYWAR_TUNE_FREETEXT_MESSAGES=1 with 0/3/8
 *                         inbound messages at FREETEXT_MESSAGE_MAX_CHARS
 *  - `all_on`             spatial + minimap + free-text + in-house social
 *                         prompt with a full inbox
 *
 * PROXYWAR_TUNE_STRUCTURED_DEALS=1 in every arm: that is the hosted 0.1.48
 * package env (`game.runnable.env`), so a deals-off arm would not be a
 * baseline of anything shipped.
 *
 * Usage:
 *   node --import tsx/esm src/scripts/agent-prompt-size-matrix.ts
 *   [--seats=4,8,16] [--map=world] [--out=<path>]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundedSpatialV1 } from "../../coworld-adapter/tester-starter-llm/owner-capabilities.mjs";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import type { Game, Player } from "../../src/core/game/Game";
import { PlayerInfo, PlayerType, UnitType } from "../../src/core/game/Game";
import type { TileRef } from "../../src/core/game/GameMap";
import {
  AgentDealManager,
  isDealActionKind,
} from "../../src/server/agents/AgentDealManager";
import { selectInboxWindow } from "../../src/server/agents/AgentLeagueMatch";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES,
  SPATIAL_PROMPT_INCREMENT_MAX_BYTES,
  SPATIAL_PROMPT_INCREMENT_MAX_ESTIMATED_TOKENS,
  SPATIAL_STAGE_ONE_SERIALIZED_MAX_BYTES,
} from "../../src/server/agents/AgentSpatialObservation";
import { selectSpawnSlots } from "../../src/server/agents/AgentSpawnAssignment";
import { MAX_AGENT_SPAWN_PARTICIPANTS } from "../../src/server/agents/AgentSpawnSelection";
import {
  FREETEXT_INBOX_MAX_MESSAGES,
  FREETEXT_MESSAGE_MAX_CHARS,
} from "../../src/server/agents/AgentTunables";
import type {
  AgentInboundMessage,
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  buildSpawnCandidates,
  buildSpawnLegalAction,
  LegalActionBuilder,
} from "../../src/server/agents/LegalActionBuilder";
import { LlmPromptBuilder } from "../../src/server/agents/LlmPromptBuilder";
import { setup } from "../util/Setup";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const TEST_UTIL_DIR = path.join(REPO_ROOT, "tests", "util");
const STARTER_FILE = path.join(
  REPO_ROOT,
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);

/** Stable game id: SpawnExecution seeds its PRNG from it, so a fixed value
 * keeps every board byte-reproducible across runs. */
const GAME_ID = "PROMPT_SIZE_MATRIX";

/** chars-per-token divisors. The prompt is compact JSON + English prose, which
 * tokenizes worse than prose. Reported as a RANGE because no Claude tokenizer
 * is available offline; hosted runs carry the ground truth (the public starter
 * already records real Bedrock usage — llm-player.mjs normalizeBedrockUsage). */
const CHARS_PER_TOKEN_LOW = 3.5;
const CHARS_PER_TOKEN_HIGH = 4.0;

export type PhaseName = "spawn" | "mid" | "late";

export interface ArmSpec {
  name: string;
  env: Record<string, string>;
  /** strip warship affordances to emulate the pre-0.1.48 menu */
  stripWarships?: boolean;
  /** inbound message count to attach (free-text arms only) */
  inboxMessages?: number;
}

export const ARMS: ArmSpec[] = [
  { name: "base_no_warships", env: {}, stripWarships: true },
  { name: "warships", env: {} },
  // The in-house social prompt arm gates a prompt block AND the `deals`
  // observation block, so without an arm here every OTHER arm measures both as
  // zero bytes — verbatim the failure this file's own header records happening
  // twice before. Free text is on because the arm teaches a message slot, and a
  // slot the menu never offers would understate the block's real cost.
  {
    name: "inhouse_social",
    env: {
      PROXYWAR_TUNE_INHOUSE_SOCIAL_PROMPT: "1",
      PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
    },
    inboxMessages: 3,
  },
  { name: "spatial", env: { PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1" } },
  {
    name: "spatial_minimap",
    env: {
      PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1",
      PROXYWAR_TUNE_SPATIAL_MINIMAP: "1",
    },
  },
  {
    name: "freetext_0",
    env: { PROXYWAR_TUNE_FREETEXT_MESSAGES: "1" },
    inboxMessages: 0,
  },
  {
    name: "freetext_3",
    env: { PROXYWAR_TUNE_FREETEXT_MESSAGES: "1" },
    inboxMessages: 3,
  },
  {
    name: "freetext_8",
    env: { PROXYWAR_TUNE_FREETEXT_MESSAGES: "1" },
    inboxMessages: FREETEXT_INBOX_MAX_MESSAGES,
  },
  {
    name: "all_on",
    env: {
      PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1",
      PROXYWAR_TUNE_SPATIAL_MINIMAP: "1",
      PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
      PROXYWAR_TUNE_INHOUSE_SOCIAL_PROMPT: "1",
    },
    inboxMessages: FREETEXT_INBOX_MAX_MESSAGES,
  },
];

const TUNABLE_ENV_KEYS = [
  "PROXYWAR_TUNE_SPATIAL_OBSERVATION",
  "PROXYWAR_TUNE_SPATIAL_MINIMAP",
  "PROXYWAR_TUNE_FREETEXT_MESSAGES",
  "PROXYWAR_TUNE_STRUCTURED_DEALS",
  "PROXYWAR_TUNE_INHOUSE_SOCIAL_PROMPT",
] as const;

function applyArmEnv(arm: ArmSpec): void {
  for (const key of TUNABLE_ENV_KEYS) delete process.env[key];
  // The hosted 0.1.48 package arms deals in every episode; keep every arm on
  // that floor so "baseline" means "what the league runs".
  process.env.PROXYWAR_TUNE_STRUCTURED_DEALS = "1";
  for (const [key, value] of Object.entries(arm.env)) {
    process.env[key] = value;
  }
}

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`--${flag}=`));
  return hit?.slice(flag.length + 3);
}

// ---------------------------------------------------------------------------
// Board construction: a real Game, stepped, with deterministic territory.
// ---------------------------------------------------------------------------

/** Seat roster. IDs are stable so the observer seat and every rival can be
 * addressed by id — `game.players()` only reports seats the engine considers
 * in play, which is empty before any territory exists. */
function seatPlayers(seats: number): PlayerInfo[] {
  return Array.from(
    { length: seats },
    (_, index) =>
      new PlayerInfo(
        `Seat ${index + 1}`,
        PlayerType.Human,
        `CLNT_${index + 1}`,
        `P_${index + 1}`,
      ),
  );
}

/**
 * Deterministic land seeds: walk the map on a coarse lattice and keep the
 * first `count` land tiles that are far enough apart to give every seat its
 * own region. Pure geometry — no randomness, so every run is reproducible.
 */
function landSeeds(game: Game, count: number): TileRef[] {
  const width = game.width();
  const height = game.height();
  const minSeparation = Math.max(8, Math.floor(Math.min(width, height) / 6));
  const seeds: { tile: TileRef; x: number; y: number }[] = [];
  const step = Math.max(2, Math.floor(Math.min(width, height) / 40));
  for (let y = step; y < height - step && seeds.length < count; y += step) {
    for (let x = step; x < width - step && seeds.length < count; x += step) {
      const tile = game.ref(x, y);
      if (!game.isLand(tile)) continue;
      const tooClose = seeds.some(
        (seed) => Math.hypot(seed.x - x, seed.y - y) < minSeparation,
      );
      if (tooClose) continue;
      seeds.push({ tile, x, y });
    }
  }
  if (seeds.length < count) {
    throw new Error(
      `landSeeds: found only ${seeds.length} separated land seeds for ${count} seats ` +
        `on a ${width}x${height} map — lower minSeparation or pick a bigger map ` +
        "rather than letting seats share a region.",
    );
  }
  return seeds.map((seed) => seed.tile);
}

/**
 * Grows each seat's territory by breadth-first conquest from its seed, one
 * ring per seat per round so neighbours meet in the middle and real borders
 * (and therefore real diplomatic/attack menus) form.
 */
function growTerritories(
  game: Game,
  players: readonly Player[],
  seeds: readonly TileRef[],
  tilesPerSeat: number,
): void {
  const frontiers = seeds.map((seed) => [seed]);
  const claimed = new Set<TileRef>();
  const owned = seeds.map(() => 0);

  for (let index = 0; index < players.length; index++) {
    const seed = seeds[index];
    if (claimed.has(seed)) continue;
    players[index].conquer(seed);
    claimed.add(seed);
    owned[index] = 1;
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let index = 0; index < players.length; index++) {
      if (owned[index] >= tilesPerSeat) continue;
      const frontier = frontiers[index];
      const nextFrontier: TileRef[] = [];
      for (const tile of frontier) {
        if (owned[index] >= tilesPerSeat) break;
        for (const neighbor of game.neighbors(tile)) {
          if (owned[index] >= tilesPerSeat) break;
          if (claimed.has(neighbor) || !game.isLand(neighbor)) continue;
          players[index].conquer(neighbor);
          claimed.add(neighbor);
          owned[index] += 1;
          nextFrontier.push(neighbor);
          progressed = true;
        }
      }
      frontiers[index] = nextFrontier.length > 0 ? nextFrontier : frontier;
    }
  }
}

/** Structures a late-game seat plausibly owns, so build/upgrade/nuke menu
 * families and warship move options are all populated. `instantBuild` keeps
 * this deterministic. */
function buildLateGameUnits(game: Game, player: Player): void {
  const owned = [...player.tiles()];
  const place = (unit: UnitType, at: TileRef | undefined) => {
    if (at === undefined) return;
    try {
      const built = player.buildUnit(unit, at, {});
      built.setUnderConstruction(false);
    } catch {
      // A unit that cannot legally sit on this tile is not a measurement
      // failure: the menu is measured from whatever legally exists.
    }
  };
  const coastal = owned.find((tile) =>
    game.neighbors(tile).some((neighbor) => !game.isLand(neighbor)),
  );
  place(UnitType.Port, coastal);
  place(UnitType.City, owned[Math.floor(owned.length * 0.25)]);
  place(UnitType.Factory, owned[Math.floor(owned.length * 0.4)]);
  place(UnitType.DefensePost, owned[Math.floor(owned.length * 0.55)]);
  place(UnitType.MissileSilo, owned[Math.floor(owned.length * 0.7)]);
  place(UnitType.SAMLauncher, owned[Math.floor(owned.length * 0.85)]);

  // Warships are the one unit with required params: production only ever
  // builds them through WarshipExecution, which passes `patrolTile`, and
  // `UnitImpl.warshipState()` throws for a Warship built without it. Build on
  // water, patrolling that same water, exactly as the execution does.
  const patrolTile =
    coastal === undefined
      ? undefined
      : game.neighbors(coastal).find((neighbor) => !game.isLand(neighbor));
  if (patrolTile !== undefined) {
    try {
      const warship = player.buildUnit(UnitType.Warship, patrolTile, {
        patrolTile,
      });
      warship.setUnderConstruction(false);
    } catch {
      // Same rule as above: an illegal placement is simply not measured.
    }
  }
}

export interface Board {
  game: Game;
  observer: PlayerInfo;
  seats: number;
  phase: PhaseName;
}

export async function buildBoard(
  mapName: string,
  seats: number,
  phase: PhaseName,
): Promise<Board> {
  const players = seatPlayers(seats);
  const game = await setup(
    mapName,
    { nations: "disabled", instantBuild: true, infiniteGold: true },
    players,
    TEST_UTIL_DIR,
  );

  if (phase === "spawn") {
    // Spawn phase: no territory yet. The ballot menu is the whole decision.
    return { game, observer: players[0], seats, phase };
  }

  // Seats must SPAWN, not merely own tiles: `hasSpawned` gates whole menu
  // families (messageActions filters on it), so hand-conquering tiles without
  // a SpawnExecution silently produces a menu that is missing the comms lane
  // — i.e. a measurement that under-reports free-text cost as zero.
  const seeds = landSeeds(game, seats);
  for (let index = 0; index < players.length; index++) {
    game.addExecution(
      new SpawnExecution(GAME_ID, players[index], seeds[index]),
    );
  }
  while (game.inSpawnPhase()) game.executeNextTick();

  const seated = players.map((info) => game.player(info.id));
  // mid: seats hold a modest region; late: crowded, bordering, built-up.
  const tilesPerSeat = phase === "mid" ? 400 : 2_400;
  growTerritories(game, seated, seeds, tilesPerSeat);
  // A few real ticks so troop/gold/border state is engine-derived, not hand-set.
  for (let tick = 0; tick < 10; tick++) game.executeNextTick();
  if (phase === "late") {
    for (const player of seated) buildLateGameUnits(game, player);
    for (let tick = 0; tick < 10; tick++) game.executeNextTick();
  }
  return { game, observer: players[0], seats, phase };
}

// ---------------------------------------------------------------------------
// Arm rendering
// ---------------------------------------------------------------------------

function syntheticInbox(
  observation: AgentObservation,
  count: number,
): AgentInboundMessage[] {
  if (count <= 0) return [];
  const rivals = observation.visiblePlayers.filter(
    (rival) => rival.isAlive !== false,
  );
  if (rivals.length === 0) return [];
  // Worst realistic case: full-length messages. The server caps text at
  // FREETEXT_MESSAGE_MAX_CHARS, so this is the maximum an inbox can cost.
  const text = "A".repeat(FREETEXT_MESSAGE_MAX_CHARS);
  const messages: AgentInboundMessage[] = [];
  for (let index = 0; index < count; index++) {
    const rival = rivals[index % rivals.length];
    messages.push({
      senderID: String(rival.playerID),
      senderName: rival.name,
      text,
      turnNumber: observation.turnNumber - (count - index),
    });
  }
  // Same windowing production uses, including the per-rival cap.
  return selectInboxWindow(messages);
}

function stripWarshipAffordances(observation: AgentObservation): void {
  if (observation.nonCombat?.warshipMoveOptions !== undefined) {
    observation.nonCombat.warshipMoveOptions = [];
  }
  const buildOptions = observation.nonCombat?.buildOptions;
  if (Array.isArray(buildOptions)) {
    observation.nonCombat.buildOptions = buildOptions.filter(
      (option: { unit?: string }) => option?.unit !== UnitType.Warship,
    );
  }
}

/** Chars inside a `MARKER:` … `END_MARKER` block, markers included. */
function blockChars(prompt: string, marker: string): number {
  const open = prompt.indexOf(`${marker}:`);
  if (open < 0) return 0;
  const close = prompt.indexOf(`END_${marker}`, open);
  if (close < 0) return 0;
  return close + `END_${marker}`.length - open;
}

export interface StarterBuildState {
  (obs: unknown, actions: unknown[]): Record<string, unknown>;
}

export async function loadStarterBuildState(): Promise<StarterBuildState> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  const extract = (name: string): string => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) {
      throw new Error(
        `agent-prompt-size-matrix: ${name}() not found in ${STARTER_FILE}`,
      );
    }
    const end = source.indexOf("\n}", start);
    if (end < 0) {
      throw new Error(`agent-prompt-size-matrix: ${name}() has no terminator`);
    }
    return source.slice(start, end + 2);
  };
  // Same extraction contract as tests/coworld/StarterEconomyState.test.ts: the
  // starter opens a WebSocket at import time, so the pure functions are
  // evaluated standalone with the empty-history avoidActionIDs() stub.
  // `clean`/`cleanID`/`cleanMessage` are buildState's own sanitizers — the
  // inbox path needs all three, so extraction must not stop at the two the
  // legacy (message-free) shape happened to touch.
  const factory = new Function(
    "boundedSpatialV1",
    `function avoidActionIDs() { return []; }
${extract("clean")}
${extract("cleanID")}
${extract("cleanMessage")}
${extract("normalizeDealPolicies")}
${extract("buildState")}
return buildState;`,
  );
  return factory(boundedSpatialV1) as StarterBuildState;
}

export interface ArmMeasurement {
  arm: string;
  seats: number;
  phase: PhaseName;
  actionCount: number;
  actionKinds: Record<string, number>;
  primaryActionCount: number;
  dealSlotActionCount: number;
  messageSlotActionCount: number;
  inboundMessages: number;
  promptChars: number;
  promptBytes: number;
  observationBytes: number;
  observationBlockChars: number;
  legalActionsBlockChars: number;
  rankedCandidatesBlockChars: number;
  opponentModelBlockChars: number;
  staticFrameChars: number;
  minimapChars: number;
  minimapBytes: number;
  spatialChars: number;
  spatialBytes: number;
  inboxChars: number;
  dealObservationChars: number;
  socialSlotInstructionChars: number;
  starterStateChars: number;
  starterStateBytes: number;
  estTokensHigh: number;
  estTokensLow: number;
}

function countKinds(actions: readonly LegalAction[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) {
    counts[action.kind] = (counts[action.kind] ?? 0) + 1;
  }
  return counts;
}

export function measureArm(
  board: Board,
  arm: ArmSpec,
  starterBuildState: StarterBuildState,
): ArmMeasurement {
  // A measurement must be order-independent and must not alter the worker that
  // called it. Snapshot every tunable this harness touches, apply the arm, and
  // restore the exact prior state even if board/menu/prompt construction throws.
  const priorEnv = new Map(
    TUNABLE_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );
  try {
    applyArmEnv(arm);
    return measureArmWithAppliedEnvironment(board, arm, starterBuildState);
  } finally {
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function measureArmWithAppliedEnvironment(
  board: Board,
  arm: ArmSpec,
  starterBuildState: StarterBuildState,
): ArmMeasurement {
  const observationBuilder = new AgentObservationBuilder();
  const observation = observationBuilder.build({
    agentID: `agent-${board.observer.id}`,
    clientID: board.observer.clientID,
    username: board.observer.name,
    profile: "aggressive",
    gameID: "PROMPT_SIZE_MATRIX",
    turnNumber: board.game.ticks(),
    gameState: board.game,
    ...(board.phase === "spawn" ? { phaseOverride: "spawn" as const } : {}),
  });

  // `AgentObservationBuilder` intentionally does not own the match-scoped deal
  // ledger. Production injects `AgentDealManager.observationFor()` immediately
  // afterwards, so the matrix must do the same; a handwritten empty block can
  // miss canonical proposal options and silently measure zero deal actions.
  const dealManager = new AgentDealManager();
  dealManager.beginDecisionStep({
    turnNumber: observation.turnNumber,
    records: [],
  });
  const deals = dealManager.observationFor({
    agentID: observation.agentID,
    observation,
  });
  if (deals !== undefined) observation.deals = deals;

  if (arm.stripWarships === true) stripWarshipAffordances(observation);

  const inbox = syntheticInbox(observation, arm.inboxMessages ?? 0);
  if (inbox.length > 0) {
    observation.nonCombat.inboundMessages = inbox;
  }

  let actions: LegalAction[];
  if (board.phase === "spawn") {
    // The sealed ballot menu: exactly one quality-floored, maximin-spaced
    // candidate per seat, rendered through the canonical constructor.
    const candidates = buildSpawnCandidates(board.game, {
      maxCandidates: 1_000,
      stride: 2,
    });
    actions = selectSpawnSlots(candidates, board.seats).map(
      buildSpawnLegalAction,
    );
  } else {
    actions = new LegalActionBuilder().build({ observation });
    if (arm.stripWarships === true) {
      actions = actions.filter((action) => action.kind !== "move_warship");
    }
  }

  const prompt = new LlmPromptBuilder().build({
    observation,
    legalActions: actions,
  });
  const observationBlockChars = blockChars(prompt, "OBSERVATION_JSON");
  const legalActionsBlockChars = blockChars(prompt, "LEGAL_ACTIONS_JSON");
  const rankedCandidatesBlockChars = blockChars(
    prompt,
    "RANKED_CANDIDATES_JSON",
  );
  const opponentModelBlockChars = blockChars(prompt, "OPPONENT_MODEL_JSON");

  const spatial = observation.spatial;
  const minimapChars =
    spatial?.minimap === undefined ? 0 : JSON.stringify(spatial.minimap).length;
  const spatialChars =
    spatial === undefined ? 0 : JSON.stringify(spatial).length;
  const minimapBytes =
    spatial?.minimap === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(spatial.minimap), "utf8");
  const spatialBytes =
    spatial === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(spatial), "utf8");
  const inboxChars = inbox.length === 0 ? 0 : JSON.stringify(inbox).length;
  const dealObservationChars =
    observation.deals === undefined
      ? 0
      : JSON.stringify(observation.deals).length;
  const socialSlotInstructionChars = prompt
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("PRIMARY ACTION SLOT:") ||
        line.startsWith("SEPARATE DEAL SLOT:") ||
        line.startsWith("SEPARATE MESSAGE SLOT:"),
    )
    .reduce((total, line) => total + line.length + 1, 0);
  const dealSlotActionCount = actions.filter((action) =>
    isDealActionKind(action.kind),
  ).length;
  const messageSlotActionCount = actions.filter(
    (action) => action.kind === "message",
  ).length;
  const primaryActionCount =
    actions.length - dealSlotActionCount - messageSlotActionCount;

  const starterState = starterBuildState(observation, actions);
  const starterStateJson = JSON.stringify(starterState);
  const starterStateChars = starterStateJson.length;

  return {
    arm: arm.name,
    seats: board.seats,
    phase: board.phase,
    actionCount: actions.length,
    actionKinds: countKinds(actions),
    primaryActionCount,
    dealSlotActionCount,
    messageSlotActionCount,
    inboundMessages: inbox.length,
    promptChars: prompt.length,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    observationBytes: Buffer.byteLength(JSON.stringify(observation), "utf8"),
    observationBlockChars,
    legalActionsBlockChars,
    rankedCandidatesBlockChars,
    opponentModelBlockChars,
    staticFrameChars:
      prompt.length -
      observationBlockChars -
      legalActionsBlockChars -
      rankedCandidatesBlockChars -
      opponentModelBlockChars,
    minimapChars,
    minimapBytes,
    spatialChars,
    spatialBytes,
    inboxChars,
    dealObservationChars,
    socialSlotInstructionChars,
    starterStateChars,
    starterStateBytes: Buffer.byteLength(starterStateJson, "utf8"),
    estTokensLow: Math.round(prompt.length / CHARS_PER_TOKEN_HIGH),
    estTokensHigh: Math.round(prompt.length / CHARS_PER_TOKEN_LOW),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mapName = argValue("map") ?? "world";
  const seatCounts = parseSeatCounts(argValue("seats"));
  const phases: PhaseName[] = ["spawn", "mid", "late"];
  const starterBuildState = await loadStarterBuildState();

  const measurements: ArmMeasurement[] = [];
  for (const seats of seatCounts) {
    for (const phase of phases) {
      const startedAt = Date.now();
      const board = await buildBoard(mapName, seats, phase);
      for (const arm of ARMS) {
        measurements.push(measureArm(board, arm, starterBuildState));
      }
      console.error(
        `[matrix] seats=${seats} phase=${phase} built+measured in ${Date.now() - startedAt}ms`,
      );
    }
  }
  let commit = "unavailable";
  let treeState: "clean" | "dirty" | "unavailable" = "unavailable";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    treeState =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim() === ""
        ? "clean"
        : "dirty";
  } catch {
    // Source archives may be measured for diagnostics but are not attributable.
  }
  const source = {
    commit,
    treeState,
    attributionMet: /^[0-9a-f]{40}$/.test(commit) && treeState === "clean",
  };
  const spatialRows = measurements.flatMap((measurement) => {
    if (measurement.arm !== "warships") return [];
    const sameBoard = (candidate: ArmMeasurement) =>
      candidate.seats === measurement.seats &&
      candidate.phase === measurement.phase;
    const spatial = measurements.find(
      (candidate) => sameBoard(candidate) && candidate.arm === "spatial",
    );
    const minimap = measurements.find(
      (candidate) =>
        sameBoard(candidate) && candidate.arm === "spatial_minimap",
    );
    if (spatial === undefined || minimap === undefined) {
      throw new Error(
        `missing spatial matrix arm for ${measurement.seats}/${measurement.phase}`,
      );
    }
    return [
      {
        seats: measurement.seats,
        phase: measurement.phase,
        stageOneIncrementalSerializedBytes:
          spatial.observationBytes - measurement.observationBytes,
        minimapIncrementalSerializedBytes:
          minimap.observationBytes - spatial.observationBytes,
        spatialBlockBytes: spatial.spatialBytes,
        minimapBlockBytes: minimap.minimapBytes,
        promptIncrementBytes: minimap.promptBytes - measurement.promptBytes,
        estimatedTokenIncrement:
          minimap.estTokensHigh - measurement.estTokensHigh,
      },
    ];
  });
  const spatialGate = {
    rows: spatialRows,
    maxima: {
      stageOneIncrementalSerializedBytes: Math.max(
        ...spatialRows.map((row) => row.stageOneIncrementalSerializedBytes),
      ),
      minimapIncrementalSerializedBytes: Math.max(
        ...spatialRows.map((row) => row.minimapIncrementalSerializedBytes),
      ),
      spatialBlockBytes: Math.max(
        ...spatialRows.map((row) => row.spatialBlockBytes),
      ),
      minimapBlockBytes: Math.max(
        ...spatialRows.map((row) => row.minimapBlockBytes),
      ),
      promptIncrementBytes: Math.max(
        ...spatialRows.map((row) => row.promptIncrementBytes),
      ),
      estimatedTokenIncrement: Math.max(
        ...spatialRows.map((row) => row.estimatedTokenIncrement),
      ),
    },
    checks: {
      stageOne: spatialRows.every(
        (row) =>
          row.stageOneIncrementalSerializedBytes <=
          SPATIAL_STAGE_ONE_SERIALIZED_MAX_BYTES,
      ),
      minimap: spatialRows.every(
        (row) =>
          row.minimapIncrementalSerializedBytes <=
          SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES,
      ),
      prompt: spatialRows.every(
        (row) => row.promptIncrementBytes <= SPATIAL_PROMPT_INCREMENT_MAX_BYTES,
      ),
      estimatedTokens: spatialRows.every(
        (row) =>
          row.estimatedTokenIncrement <=
          SPATIAL_PROMPT_INCREMENT_MAX_ESTIMATED_TOKENS,
      ),
    },
  };
  const targetMet =
    source.attributionMet && Object.values(spatialGate.checks).every(Boolean);
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source,
    map: mapName,
    charsPerToken: { low: CHARS_PER_TOKEN_LOW, high: CHARS_PER_TOKEN_HIGH },
    caps: {
      freetextInboxMaxMessages: FREETEXT_INBOX_MAX_MESSAGES,
      freetextMessageMaxChars: FREETEXT_MESSAGE_MAX_CHARS,
      spatialStageOneMaxBytes: SPATIAL_STAGE_ONE_SERIALIZED_MAX_BYTES,
      spatialMinimapMaxBytes: SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES,
      spatialPromptIncrementMaxBytes: SPATIAL_PROMPT_INCREMENT_MAX_BYTES,
      spatialPromptIncrementMaxEstimatedTokens:
        SPATIAL_PROMPT_INCREMENT_MAX_ESTIMATED_TOKENS,
    },
    note:
      "Character counts are exact. Token counts are an estimated RANGE: no " +
      "Claude tokenizer is available offline. Ground-truth tokens come from " +
      "hosted episodes, where the public starter already records Bedrock usage.",
    measurements,
    spatialGate,
    targetMet,
  };

  const outPath = path.resolve(
    REPO_ROOT,
    argValue("out") ?? "artifacts/ai-league-benchmarks/prompt-size-matrix.json",
  );
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

  const header = [
    "seats",
    "phase",
    "arm",
    "actions",
    "primaryActions",
    "dealSlotActions",
    "messageSlotActions",
    "promptChars",
    "estTokens(3.5-4.0)",
    "observation",
    "menu",
    "ranked",
    "opponent",
    "static",
    "spatial",
    "minimap",
    "inbox",
    "deals",
    "socialInstructions",
    "starterState",
  ].join("\t");
  console.log(header);
  for (const row of measurements) {
    console.log(
      [
        row.seats,
        row.phase,
        row.arm,
        row.actionCount,
        row.primaryActionCount,
        row.dealSlotActionCount,
        row.messageSlotActionCount,
        row.promptChars,
        `${row.estTokensLow}-${row.estTokensHigh}`,
        row.observationBlockChars,
        row.legalActionsBlockChars,
        row.rankedCandidatesBlockChars,
        row.opponentModelBlockChars,
        row.staticFrameChars,
        row.spatialChars,
        row.minimapChars,
        row.inboxChars,
        row.dealObservationChars,
        row.socialSlotInstructionChars,
        row.starterStateChars,
      ].join("\t"),
    );
  }
  console.error(`[matrix] wrote ${outPath}`);
  if (!targetMet) process.exitCode = 1;
}

export function parseSeatCounts(value: string | undefined): number[] {
  const tokens = (value ?? "4,8,16").split(",").map((token) => token.trim());
  if (tokens.some((token) => !/^[1-9][0-9]*$/.test(token))) {
    throw new Error("--seats must contain comma-separated positive integers");
  }
  const counts = [...new Set(tokens.map((token) => Number(token)))];
  if (
    counts.length === 0 ||
    counts.some(
      (count) =>
        !Number.isSafeInteger(count) || count > MAX_AGENT_SPAWN_PARTICIPANTS,
    )
  ) {
    throw new Error(
      `--seats must contain at least one supported count from 1 to ${MAX_AGENT_SPAWN_PARTICIPANTS}`,
    );
  }
  return counts;
}

// Importable as a module (tests pin that the arms genuinely differ); runs the
// full matrix only when invoked as the entrypoint.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
