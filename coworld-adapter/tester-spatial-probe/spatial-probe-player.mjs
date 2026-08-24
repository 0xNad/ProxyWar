import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import {
  boundedSpatialMapInfo,
  boundedSpatialObservation,
  ownerCapabilityObservation,
} from "./owner-capabilities.mjs";

export const GATE1_CASE_COUNT = 200;
export const GATE1_STRUCTURED_CASE_COUNT = 160;
export const GATE1_MINIMAP_CASE_COUNT = 40;
export const PROBE_MODEL =
  process.env.BEDROCK_MODEL || "us.anthropic.claude-sonnet-4-6";
export const PROBE_MAX_TOKENS = 1024;
const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const SIDECAR = (process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME || "").trim();
const PROBE_TIMEOUT_MS = 11_000;
const PROBE_PREFIX = "PROXYWAR_SPATIAL_GATE ";
const TARGET_ACTION_KINDS = new Set([
  "attack",
  "boat",
  "alliance_request",
  "alliance",
  "donate_gold",
  "donate_troops",
  "embargo",
  "target_player",
]);
const TILE_ACTION_KINDS = new Set([
  "boat",
  "build",
  "warship",
  "move_warship",
  "upgrade_structure",
]);
const SOCIAL_KINDS = new Set([
  "message",
  "deal_propose",
  "deal_accept",
  "deal_reject",
  "deal_withdraw",
]);
const CARRIER_ORDER = [
  "attack",
  "build",
  "upgrade_structure",
  "boat",
  "move_warship",
  "alliance_request",
  "donate_gold",
  "donate_troops",
  "embargo",
  "target_player",
  "hold",
];
const DISTANCE_RANK = new Map([
  ["adjacent", 0],
  ["near", 1],
  ["far", 2],
]);
const TERRAIN_RANK = new Map([
  [".", 0],
  [":", 1],
  ["^", 2],
  ["~", 3],
]);

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function jsonHash(value) {
  return hash(JSON.stringify(value));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function replaceAt(value, index, replacement) {
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

function baseSyntheticContext(index, random) {
  const ids = [`R${index}A`, `R${index}B`, `R${index}C`];
  const bearings = shuffled(["north", "east", "southwest"], random);
  const distances = shuffled(["adjacent", "near", "far"], random);
  const borders = shuffled([18, 47, 83], random);
  const mountains = shuffled([2, 13, 31], random);
  const uncovered = shuffled([7, 29, 61], random);
  const navalReach = shuffled([3, 21, 54], random);
  const rivals = ids.map((playerID, rivalIndex) => ({
    playerID,
    name: `Rival ${rivalIndex + 1}`,
    bearing: bearings[rivalIndex],
    distanceClass: distances[rivalIndex],
    borderWithYou: {
      tiles: borders[rivalIndex],
      shareOfYourBorder: 15 + rivalIndex * 20,
      terrain: mountains[rivalIndex] > 20 ? "mixed" : "land",
      terrainBreakdown: {
        plains: 90 - mountains[rivalIndex],
        highland: 8,
        mountain: mountains[rivalIndex],
        shore: rivalIndex * 4,
      },
      defensePostsCovering: rivalIndex,
      defensePostFrontCoverage: {
        covered: borders[rivalIndex] - uncovered[rivalIndex],
        uncovered: uncovered[rivalIndex],
      },
      underAttackHere: false,
    },
    navalExposure: {
      transportReachableOwnShoreTiles: navalReach[rivalIndex],
      nearestEnemyPort: {
        bearing: bearings[rivalIndex],
        distanceClass: rivalIndex === 0 ? "near" : "far",
      },
    },
  }));
  return {
    ids,
    rivals,
    structured: {
      mapInfo: {
        width: 240,
        height: 120,
        coordinateFrame: {
          origin: "top_left",
          xAxis: "east",
          yAxis: "south",
        },
        tileRefEncoding: "row-major-y-width-plus-x",
      },
      spatial: {
        schemaVersion: 5,
        visibilityModel: "global-lockstep-public-map-v1",
        ownShape: {
          quadrant: "center",
          compactness: "compact",
          regionCount: 1,
          largestRegionShare: 100,
          regionAnalysis: "complete",
          centroidBasis: "largest_region_border",
          coastShare: 20,
          centroid: { xPct: 50, yPct: 50 },
          largestNeighborBorderShare: 42,
        },
        positionedAssets: {
          analysis: "complete",
          structures: [],
          structuresTotal: 0,
          structuresReturned: 0,
          structuresTruncated: false,
          warships: [],
          warshipsTotal: 0,
          warshipsReturned: 0,
          warshipsTruncated: false,
        },
      },
      rivals,
    },
  };
}

function syntheticMinimap(index, ids, random) {
  const width = 24;
  const height = 12;
  const glyphs = ["A", "B", "C"];
  const ownershipRows = Array.from({ length: height }, () => ".".repeat(width));
  const terrainRows = Array.from({ length: height }, () => ".".repeat(width));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const owner = glyphs[(x * 7 + y * 5 + index) % glyphs.length];
      ownershipRows[y] = replaceAt(ownershipRows[y], x, owner);
      const terrain = [".", ":", "^", "~"][(x * 3 + y * 11 + index) % 4];
      terrainRows[y] = replaceAt(terrainRows[y], x, terrain);
    }
  }
  const x = 1 + Math.floor(random() * (width - 2));
  const y = 1 + Math.floor(random() * (height - 2));
  return {
    x,
    y,
    ownershipRows,
    terrainRows,
    legend: glyphs.map((glyph, glyphIndex) => ({
      glyph,
      playerID: ids[glyphIndex],
      isYou: glyphIndex === 0,
    })),
    minimap: {
      schemaVersion: 2,
      width,
      height,
      ownershipRows,
      terrainRows,
      legend: glyphs.map((glyph, glyphIndex) => ({
        glyph,
        playerID: ids[glyphIndex],
        isYou: glyphIndex === 0,
      })),
      markers: [],
      markersTotal: 0,
      markersTruncated: false,
    },
  };
}

export function buildGate1Cases() {
  const cases = [];
  for (let index = 0; index < GATE1_CASE_COUNT; index += 1) {
    const random = mulberry32(0x51a71000 + index);
    const base = baseSyntheticContext(index, random);
    const minimap = syntheticMinimap(index, base.ids, random);
    // Interleave the minimap-only cases so no single hosted episode carries the
    // entire minimap treatment. Four out of every five cases remain structured.
    const shared = index % 5 !== 4;
    let question;
    let truth;
    let questionClass;
    if (shared) {
      const structuredIndex = index - Math.floor(index / 5);
      const type = structuredIndex % 6;
      if (type === 0) {
        questionClass = "bearing";
        question = "Which rival has bearing east?";
        truth = base.rivals.find((rival) => rival.bearing === "east").playerID;
      } else if (type === 1) {
        questionClass = "nearest";
        question = "Which rival is adjacent rather than near or far?";
        truth = base.rivals.find(
          (rival) => rival.distanceClass === "adjacent",
        ).playerID;
      } else if (type === 2) {
        questionClass = "largest_border";
        question = "Which rival shares the largest direct border tile count?";
        truth = [...base.rivals].sort(
          (a, b) => b.borderWithYou.tiles - a.borderWithYou.tiles,
        )[0].playerID;
      } else if (type === 3) {
        questionClass = "mountain_border";
        question = "Which rival border has the most mountain tiles?";
        truth = [...base.rivals].sort(
          (a, b) =>
            b.borderWithYou.terrainBreakdown.mountain -
            a.borderWithYou.terrainBreakdown.mountain,
        )[0].playerID;
      } else if (type === 4) {
        questionClass = "uncovered_front";
        question = "Which rival border has the most uncovered frontier tiles?";
        truth = [...base.rivals].sort(
          (a, b) =>
            b.borderWithYou.defensePostFrontCoverage.uncovered -
            a.borderWithYou.defensePostFrontCoverage.uncovered,
        )[0].playerID;
      } else {
        questionClass = "naval_reach";
        question =
          "Which rival has the greatest transport-reachable own-shore count?";
        truth = [...base.rivals].sort(
          (a, b) =>
            b.navalExposure.transportReachableOwnShoreTiles -
            a.navalExposure.transportReachableOwnShoreTiles,
        )[0].playerID;
      }
    } else {
      const type = Math.floor(index / 5) % 4;
      if (type === 0 || type === 2) {
        questionClass = type === 0 ? "minimap_owner_cell" : "minimap_owner_row";
        if (type === 0) {
          question = `Which player owns minimap cell x=${minimap.x}, y=${minimap.y}?`;
          const glyph = minimap.ownershipRows[minimap.y][minimap.x];
          truth = minimap.legend.find(
            (entry) => entry.glyph === glyph,
          ).playerID;
        } else {
          question = `Which player owns minimap cell x=${minimap.x + 1}, y=${minimap.y}?`;
          const glyph = minimap.ownershipRows[minimap.y][minimap.x + 1];
          truth = minimap.legend.find(
            (entry) => entry.glyph === glyph,
          ).playerID;
        }
      } else {
        questionClass =
          type === 1 ? "minimap_terrain_cell" : "minimap_terrain_neighbor";
        const x = type === 1 ? minimap.x : minimap.x - 1;
        question = `What terrain is in minimap cell x=${x}, y=${minimap.y}?`;
        truth = {
          ".": "plains",
          ":": "highland",
          "^": "mountain",
          "~": "water",
        }[minimap.terrainRows[minimap.y][x]];
      }
    }
    const optionPool = truth.startsWith?.("R")
      ? [...base.ids, "unknown"]
      : ["plains", "highland", "mountain", "water", "unknown"];
    const options = shuffled(optionPool, random);
    const identity = {
      index,
      questionClass,
      question,
      options,
      truth,
      structured: base.structured,
      minimap: minimap.minimap,
      visibilityRequirement: shared ? "structured" : "minimap",
    };
    cases.push({
      ...identity,
      scenarioID: `s1_${hash(JSON.stringify(identity)).slice(0, 20)}`,
    });
  }
  return cases;
}

export function armFromObservation(observation) {
  const spatial = boundedSpatialObservation(observation);
  if (spatial === null) return "off";
  return spatial.minimap ? "full" : "structured";
}

export function gate1PromptCase(scenario, arm) {
  const canSeeStructured = arm === "structured" || arm === "full";
  const canSeeMinimap = arm === "full";
  const expected =
    scenario.visibilityRequirement === "structured"
      ? canSeeStructured
        ? scenario.truth
        : "unknown"
      : canSeeMinimap
        ? scenario.truth
        : "unknown";
  return {
    scenarioID: scenario.scenarioID,
    questionClass: scenario.questionClass,
    question: scenario.question,
    options: scenario.options,
    spatialContext: canSeeStructured
      ? {
          ...scenario.structured,
          ...(canSeeMinimap
            ? {
                spatial: {
                  ...scenario.structured.spatial,
                  minimap: scenario.minimap,
                },
              }
            : {}),
        }
      : null,
    expected,
  };
}

function actionTargetID(action) {
  const target =
    action?.metadata?.targetID ??
    action?.metadata?.recipientID ??
    action?.metadata?.playerID;
  return typeof target === "string" && target.length > 0 ? target : null;
}

function actionTile(action) {
  const tile =
    action?.metadata?.targetTile ??
    action?.metadata?.buildTile ??
    action?.metadata?.tile;
  return Number.isSafeInteger(tile) && tile >= 0 ? tile : null;
}

function targetSignature(action) {
  return [
    action.kind,
    action.metadata?.troopPercent ?? "",
    action.metadata?.action ?? "",
    action.metadata?.unit ?? "",
  ].join(":");
}

function tileSignature(action) {
  return [
    action.kind,
    action.metadata?.troopPercent ?? "",
    action.metadata?.unit ?? "",
    action.metadata?.role ?? "",
  ].join(":");
}

function bestGroup(actions, valueFor, signatureFor, allowedKinds) {
  const groups = new Map();
  for (const action of actions) {
    if (!allowedKinds.has(action?.kind)) continue;
    const value = valueFor(action);
    if (value === null) continue;
    const signature = signatureFor(action);
    const values = groups.get(signature) ?? new Map();
    const previous = values.get(value);
    if (!previous || String(action.id).localeCompare(String(previous.id)) < 0) {
      values.set(value, action);
    }
    groups.set(signature, values);
  }
  return (
    [...groups.entries()]
      .filter(([, values]) => values.size >= 2)
      .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0] ??
    null
  );
}

function targetTask(actions, index) {
  const group = bestGroup(
    actions,
    actionTargetID,
    targetSignature,
    TARGET_ACTION_KINDS,
  );
  if (!group) return null;
  const metrics = [
    ["largest_border", "the largest direct shared-border tile count"],
    ["least_mountain", "the lowest mountain-tile share on your direct border"],
    ["most_uncovered", "the most uncovered direct-frontier tiles"],
    ["nearest", "the nearest distance class"],
    ["naval_reach", "the greatest transport-reachable own-shore count"],
  ];
  const [metric, words] = metrics[index % metrics.length];
  const candidates = [...group[1].entries()]
    .map(([targetID, action]) => ({
      id: action.id,
      kind: action.kind,
      targetID,
      targetName: action.metadata?.targetName ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    taskClass: "structured_target",
    metric,
    visibilityRequirement: "structured",
    question: `Select the exact offered action whose target has ${words}.`,
    candidates,
  };
}

function tileTask(actions) {
  const group = bestGroup(
    actions,
    actionTile,
    tileSignature,
    TILE_ACTION_KINDS,
  );
  if (!group) return null;
  const candidates = [...group[1].entries()]
    .map(([targetTile, action]) => ({
      id: action.id,
      kind: action.kind,
      targetTile,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    taskClass: "minimap_tile",
    metric: "safest_terrain",
    visibilityRequirement: "minimap",
    question:
      "Select the exact offered action whose target tile maps to the safest minimap terrain, ordered plains, highland, mountain, water.",
    candidates,
  };
}

export function buildGate2Task(actions, index) {
  const target = targetTask(actions, index);
  const tile = tileTask(actions);
  if (target && tile) return index % 2 === 0 ? target : tile;
  return target ?? tile;
}

function uniqueBest(candidates, scoreFor, direction) {
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreFor(candidate) }))
    .filter(({ score }) => Number.isFinite(score));
  if (scored.length < 2) return null;
  scored.sort((a, b) =>
    direction === "max" ? b.score - a.score : a.score - b.score,
  );
  if (scored[0].score === scored[1].score) return null;
  return scored[0].candidate.id;
}

function targetExpected(task, observation) {
  const spatial = boundedSpatialObservation(observation);
  if (spatial === null) return null;
  const rivals = new Map(
    spatial.rivals.map((rival) => [rival.playerID, rival]),
  );
  const rivalFor = (candidate) => rivals.get(candidate.targetID);
  if (task.metric === "largest_border") {
    return uniqueBest(
      task.candidates,
      (candidate) => rivalFor(candidate)?.borderWithYou?.tiles,
      "max",
    );
  }
  if (task.metric === "least_mountain") {
    return uniqueBest(
      task.candidates,
      (candidate) => {
        const border = rivalFor(candidate)?.borderWithYou;
        return border && border.tiles > 0
          ? border.terrainBreakdown.mountain / border.tiles
          : Number.NaN;
      },
      "min",
    );
  }
  if (task.metric === "most_uncovered") {
    return uniqueBest(
      task.candidates,
      (candidate) =>
        rivalFor(candidate)?.borderWithYou?.defensePostFrontCoverage?.uncovered,
      "max",
    );
  }
  if (task.metric === "nearest") {
    return uniqueBest(
      task.candidates,
      (candidate) => DISTANCE_RANK.get(rivalFor(candidate)?.distanceClass),
      "min",
    );
  }
  if (task.metric === "naval_reach") {
    return uniqueBest(
      task.candidates,
      (candidate) =>
        rivalFor(candidate)?.navalExposure?.transportReachableOwnShoreTiles,
      "max",
    );
  }
  return null;
}

function minimapExpected(task, observation) {
  const spatial = boundedSpatialObservation(observation);
  const mapInfo = boundedSpatialMapInfo(observation?.mapInfo);
  const minimap = spatial?.minimap;
  if (minimap?.schemaVersion !== 2 || mapInfo === null) return null;
  return uniqueBest(
    task.candidates,
    (candidate) => {
      const x = candidate.targetTile % mapInfo.width;
      const y = Math.floor(candidate.targetTile / mapInfo.width);
      const cellX = Math.min(
        minimap.width - 1,
        Math.floor((x * minimap.width) / mapInfo.width),
      );
      const cellY = Math.min(
        minimap.height - 1,
        Math.floor((y * minimap.height) / mapInfo.height),
      );
      return TERRAIN_RANK.get(minimap.terrainRows[cellY]?.[cellX]);
    },
    "min",
  );
}

export function expectedGate2Action(task, observation) {
  if (!task) return null;
  return task.taskClass === "structured_target"
    ? targetExpected(task, observation)
    : minimapExpected(task, observation);
}

function compactLiveContext(observation) {
  const spatial = boundedSpatialObservation(observation);
  const mapInfo = boundedSpatialMapInfo(observation?.mapInfo);
  return {
    ...(mapInfo ? { mapInfo } : {}),
    ownState: {
      playerID: observation?.ownState?.playerID ?? null,
      tileShare: observation?.ownState?.tileShare ?? null,
      troops: observation?.ownState?.troops ?? null,
    },
    rivals: (observation?.visiblePlayers ?? []).map((rival) => ({
      playerID: rival.playerID,
      name: rival.name,
      sharesBorder: rival.sharesBorder,
      relativeTroopRatio: rival.relativeTroopRatio,
      ...(rival.bearing ? { bearing: rival.bearing } : {}),
      ...(rival.distanceClass ? { distanceClass: rival.distanceClass } : {}),
      ...(rival.borderWithYou ? { borderWithYou: rival.borderWithYou } : {}),
      ...(rival.navalExposure ? { navalExposure: rival.navalExposure } : {}),
    })),
    ...(spatial
      ? {
          spatial: {
            schemaVersion: spatial.schemaVersion,
            visibilityModel: spatial.visibilityModel,
            ownShape: spatial.ownShape,
            positionedAssets: spatial.positionedAssets,
            ...(spatial.minimap ? { minimap: spatial.minimap } : {}),
          },
        }
      : {}),
  };
}

function probePrompt(gate1, gate2, observation) {
  const task = {
    gate1: gate1
      ? {
          scenarioID: gate1.scenarioID,
          question: gate1.question,
          options: gate1.options,
          spatialContext: gate1.spatialContext,
        }
      : null,
    gate2: gate2
      ? {
          question: gate2.question,
          options: [
            ...gate2.candidates.map((candidate) => candidate.id),
            "unknown",
          ],
          candidates: gate2.candidates,
          liveContext: compactLiveContext(observation),
        }
      : null,
  };
  return [
    "You are taking a spatial-reading evaluation. Use only the supplied context.",
    "If the requested spatial fact is absent, answer exactly unknown; do not guess.",
    "For gate2, an action is only a label for the exact stated objective, not general strategy.",
    'Return only JSON: {"gate1":"<one listed option> or null","gate2":"<one listed option, unknown, or null>"}.',
    JSON.stringify(task),
  ].join("\n");
}

function extractResponse(text) {
  const start = String(text).indexOf("{");
  const end = String(text).lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(String(text).slice(start, end + 1));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !(typeof parsed.gate1 === "string" || parsed.gate1 === null) ||
      !(typeof parsed.gate2 === "string" || parsed.gate2 === null)
    ) {
      return null;
    }
    return { gate1: parsed.gate1, gate2: parsed.gate2 };
  } catch {
    return null;
  }
}

function carrierAction(actions) {
  const ordinary = actions.filter(
    (action) => action && !SOCIAL_KINDS.has(action.kind),
  );
  for (const kind of CARRIER_ORDER) {
    const candidate = ordinary
      .filter((action) => action.kind === kind)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    if (candidate) return candidate;
  }
  return ordinary.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
}

function spawnRanking(actions) {
  return actions
    .filter((action) => action?.kind === "spawn")
    .sort(
      (a, b) =>
        Number(b.metadata?.recommended) - Number(a.metadata?.recommended) ||
        Number(b.metadata?.score ?? 0) - Number(a.metadata?.score ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, 16);
}

function client() {
  return new AnthropicBedrock(
    SIDECAR ? { awsRegion: REGION, baseURL: SIDECAR } : { awsRegion: REGION },
  );
}

async function callModel(bedrock, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await bedrock.messages.create(
      {
        model: PROBE_MODEL,
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: controller.signal },
    );
    const responseText = (response?.content ?? [])
      .filter(
        (block) => block?.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
    return {
      ok: true,
      parsed: extractResponse(responseText),
      responseModel: response?.model ?? null,
      stopReason: response?.stop_reason ?? null,
      responseTextChars: responseText.length,
      responseTextSHA256: hash(responseText),
      inputTokens: response?.usage?.input_tokens ?? null,
      outputTokens: response?.usage?.output_tokens ?? null,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      parsed: null,
      responseModel: null,
      stopReason: null,
      responseTextChars: 0,
      responseTextSHA256: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - started,
      error: error?.name === "AbortError" ? "timeout" : "provider_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function modeFromArgv(argv) {
  const raw = argv.find((arg) => arg.startsWith("--mode="))?.slice(7) ?? "both";
  if (!["gate1", "gate2", "both"].includes(raw)) {
    throw new Error(`unsupported probe mode: ${raw}`);
  }
  return raw;
}

function offsetFromArgv(argv) {
  const raw = argv.find((arg) => arg.startsWith("--offset="))?.slice(9) ?? "0";
  const offset = Number(raw);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= GATE1_CASE_COUNT
  ) {
    throw new Error(`unsupported probe offset: ${raw}`);
  }
  return offset;
}

function logEvent(event) {
  console.log(`${PROBE_PREFIX}${JSON.stringify(event)}`);
}

export function startSpatialProbe({
  argv = process.argv.slice(2),
  BedrockClient = client,
  WebSocketCtor = WebSocket,
} = {}) {
  const url = process.env.COWORLD_PLAYER_WS_URL;
  if (!url) throw new Error("COWORLD_PLAYER_WS_URL is required");
  const mode = modeFromArgv(argv);
  const gate1Offset = offsetFromArgv(argv);
  const cases = buildGate1Cases();
  const bedrock = BedrockClient();
  const socket = new WebSocketCtor(url);
  let activeIndex = 0;
  let modelCalls = 0;
  let providerFailures = 0;
  let parseFailures = 0;
  let gate1Correct = 0;
  let gate2Scored = 0;
  let gate2Correct = 0;
  let queue = Promise.resolve();

  const handle = async (message) => {
    if (message.type === "final") {
      logEvent({
        schemaVersion: 1,
        event: "summary",
        mode,
        gate1Offset,
        model: PROBE_MODEL,
        maxTokens: PROBE_MAX_TOKENS,
        activeDecisions: activeIndex,
        modelCalls,
        providerFailures,
        parseFailures,
        gate1Correct,
        gate2Scored,
        gate2Correct,
      });
      socket.close();
      return;
    }
    if (message.type !== "decision_request") return;
    const actions = Array.isArray(message.request?.legalActions)
      ? message.request.legalActions
      : [];
    const spawn = spawnRanking(actions);
    if (spawn.length > 0 && spawn.length === actions.length) {
      socket.send(
        JSON.stringify({
          type: "decision_response",
          requestID: message.requestID,
          selectedLegalActionId: spawn[0].id,
          spawnPreferenceLegalActionIds: spawn.map((action) => action.id),
          runtimeMode: "local-policy-baseline",
          reason: "spatial probe deterministic carrier spawn",
          confidence: 1,
        }),
      );
      return;
    }
    const carrier = carrierAction(actions);
    if (!carrier) throw new Error("no ordinary offered carrier action");
    const observation = ownerCapabilityObservation(
      message.request?.observation,
    );
    const arm = armFromObservation(observation);
    const scenario = cases[(gate1Offset + activeIndex) % cases.length];
    const gate1 = mode === "gate2" ? null : gate1PromptCase(scenario, arm);
    const gate2 =
      mode === "gate1" ? null : buildGate2Task(actions, activeIndex);
    const shouldCall = gate1 !== null || gate2 !== null;
    let result = {
      ok: true,
      parsed: { gate1: null, gate2: null },
      responseModel: null,
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
    const prompt = probePrompt(gate1, gate2, observation);
    if (shouldCall) {
      modelCalls += 1;
      result = await callModel(bedrock, prompt);
      if (!result.ok) providerFailures += 1;
      else if (!result.parsed) parseFailures += 1;
    }
    const gate1Answer = result.parsed?.gate1 ?? null;
    const gate1IsCorrect = gate1 !== null && gate1Answer === gate1.expected;
    if (gate1IsCorrect) gate1Correct += 1;
    const gate2Expected = expectedGate2Action(gate2, observation);
    const expectedForArm = gate2Expected ?? "unknown";
    const gate2Answer = result.parsed?.gate2 ?? null;
    const gate2IsScored = gate2 !== null;
    const gate2IsCorrect = gate2IsScored && gate2Answer === expectedForArm;
    if (gate2IsScored) gate2Scored += 1;
    if (gate2IsCorrect) gate2Correct += 1;
    const offeredIDs = actions.map((action) => action.id);
    logEvent({
      schemaVersion: 1,
      event: "probe",
      mode,
      model: PROBE_MODEL,
      responseModel: result.responseModel,
      stopReason: result.stopReason,
      maxTokens: PROBE_MAX_TOKENS,
      responseTextChars: result.responseTextChars,
      responseTextSHA256: result.responseTextSHA256,
      arm,
      gameID: observation?.gameID ?? null,
      turnNumber: observation?.turnNumber ?? null,
      activeIndex,
      requestID: message.requestID,
      carrierActionID: carrier.id,
      carrierActionOffered: offeredIDs.includes(carrier.id),
      offeredMenuSHA256: jsonHash(offeredIDs),
      promptSHA256: hash(prompt),
      providerOK: result.ok,
      parseOK: result.parsed !== null,
      ...(result.error ? { error: result.error } : {}),
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      gate1: gate1
        ? {
            scenarioID: scenario.scenarioID,
            scenarioIndex: scenario.index,
            questionClass: scenario.questionClass,
            visibilityRequirement: scenario.visibilityRequirement,
            expected: gate1.expected,
            truth: scenario.truth,
            answer: gate1Answer,
            correct: gate1IsCorrect,
          }
        : null,
      gate2: gate2
        ? {
            taskClass: gate2.taskClass,
            metric: gate2.metric,
            visibilityRequirement: gate2.visibilityRequirement,
            candidateActionIDs: gate2.candidates.map(
              (candidate) => candidate.id,
            ),
            candidatesOffered: gate2.candidates.every((candidate) =>
              offeredIDs.includes(candidate.id),
            ),
            expected: expectedForArm,
            answer: gate2Answer,
            correct: gate2IsCorrect,
          }
        : null,
    });
    socket.send(
      JSON.stringify({
        type: "decision_response",
        requestID: message.requestID,
        selectedLegalActionId: carrier.id,
        runtimeMode: "local-policy-baseline",
        reason:
          "spatial probe deterministic carrier; model answer not executed",
        confidence: 1,
        fallbackUsed: false,
        llmPlannerDegraded: false,
      }),
    );
    activeIndex += 1;
  };

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    queue = queue
      .then(() => handle(message))
      .catch((error) => {
        console.error(`spatial probe failed: ${error?.message || error}`);
        process.exitCode = 1;
        socket.close();
      });
  });
  socket.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  return socket;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) startSpatialProbe();
