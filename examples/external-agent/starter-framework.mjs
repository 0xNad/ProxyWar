import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const riskPenalty = {
  none: 0,
  low: 4,
  medium: 18,
  high: 55,
};

const profileKindBias = {
  aggressive: {
    attack: 24,
    target_player: 12,
    embargo: 8,
    build: 2,
  },
  defensive: {
    build: 18,
    retreat: 14,
    alliance_request: 8,
    attack: -4,
  },
  diplomatic: {
    alliance_request: 26,
    alliance_extend: 20,
    donate_gold: 14,
    donate_troops: 12,
    quick_chat: 5,
    attack: -6,
  },
  opportunistic: {
    attack: 14,
    boat: 10,
    build: 8,
    embargo: 6,
  },
};

const usefulNonHoldKinds = new Set([
  "spawn",
  "attack",
  "boat",
  "build",
  "upgrade_structure",
  "warship",
  "move_warship",
  "alliance_request",
  "alliance_extend",
  "donate_troops",
  "donate_gold",
  "embargo",
  "target_player",
  "quick_chat",
  "emoji",
]);

export const agentSkillPrompt = loadAgentSkillPrompt();

export function createStarterAgent(options = {}) {
  const memory = options.memory ?? createFrontierMemory();
  const llmComplete = options.llmComplete ?? createLlmCompleteFromEnv(options);
  if (llmComplete === null) {
    throw new Error(
      "LLM provider required. Set OPEN_FRONTIER_AGENT_LLM_PROVIDER=codex-cli, claude-cowork, command, or openrouter; set OPEN_FRONTIER_AGENT_LLM_COMMAND for custom local tools; set OPENROUTER_API_KEY for OpenRouter; or pass llmComplete. The starter agent never makes policy-only gameplay decisions.",
    );
  }

  return {
    memory,
    async decide(payload) {
      return decisionForPayloadWithFramework(payload, {
        memory,
        llmComplete,
        modelName: options.modelName,
      });
    },
  };
}

export function createLlmCompleteFromEnv(options = {}) {
  const explicitProvider =
    options.provider ?? process.env.OPEN_FRONTIER_AGENT_LLM_PROVIDER;
  const provider = normalizeLlmProvider(explicitProvider);
  const hasCommand =
    typeof options.command === "string" ||
    typeof process.env.OPEN_FRONTIER_AGENT_LLM_COMMAND === "string";

  if (provider === "codex-cli") {
    return codexCliCompleteFromEnv(options);
  }
  if (provider === "claude-cli" || provider === "claude-cowork") {
    return claudeCommandCompleteFromEnv(provider, options);
  }
  if (provider === "command" || (provider === "" && hasCommand)) {
    return commandCompleteFromEnv(options);
  }
  if (
    provider === "openrouter" ||
    (provider === "" && process.env.OPENROUTER_API_KEY)
  ) {
    return openRouterCompleteFromEnv(options);
  }
  if (provider !== "") {
    throw new Error(
      `Unsupported OPEN_FRONTIER_AGENT_LLM_PROVIDER ${JSON.stringify(explicitProvider)}. Use codex-cli, claude-cowork, command, or openrouter.`,
    );
  }
  return null;
}

export function describeLlmProviderFromEnv(options = {}) {
  const explicitProvider =
    options.provider ?? process.env.OPEN_FRONTIER_AGENT_LLM_PROVIDER;
  const provider = normalizeLlmProvider(explicitProvider);
  const hasCommand =
    typeof options.command === "string" ||
    typeof process.env.OPEN_FRONTIER_AGENT_LLM_COMMAND === "string";
  if (provider === "codex-cli") {
    return {
      provider,
      mode: "local-cli",
      label: "Codex CLI",
      secretRequired: false,
      configured: true,
    };
  }
  if (provider === "claude-cli" || provider === "claude-cowork") {
    return {
      provider,
      mode: "local-cli",
      label:
        provider === "claude-cowork" ? "Claude/Cowork command" : "Claude CLI",
      secretRequired: false,
      configured: true,
    };
  }
  if (provider === "command" || (provider === "" && hasCommand)) {
    return {
      provider: provider || "command",
      mode: "local-command",
      label: "Custom local command",
      secretRequired: false,
      configured: hasCommand,
    };
  }
  if (
    provider === "openrouter" ||
    (provider === "" && process.env.OPENROUTER_API_KEY)
  ) {
    return {
      provider: "openrouter",
      mode: "api",
      label: "OpenRouter",
      secretRequired: true,
      configured: Boolean(process.env.OPENROUTER_API_KEY),
    };
  }
  return {
    provider: "unconfigured",
    mode: "none",
    label: "No LLM provider configured",
    secretRequired: false,
    configured: false,
  };
}

export function createAgentCardMarkdown(options = {}) {
  const publicBaseUrl = normalizePublicBaseUrl(
    options.publicBaseUrl ??
      process.env.OPEN_FRONTIER_AGENT_PUBLIC_URL ??
      "http://127.0.0.1:7777",
  );
  const endpointPath = normalizePath(
    options.endpointPath ??
      process.env.OPEN_FRONTIER_AGENT_ENDPOINT_PATH ??
      "/open-frontier/decide",
  );
  const agentName =
    cleanFrontmatterValue(
      options.agentName ??
        process.env.OPEN_FRONTIER_AGENT_NAME ??
        "Frontier SDK Agent",
    ) || "Frontier SDK Agent";
  const profile = normalizeProfile(
    options.profile ??
      process.env.OPEN_FRONTIER_AGENT_PROFILE ??
      "opportunistic",
  );
  const doctrine = cleanFrontmatterValue(
    options.doctrine ??
      process.env.OPEN_FRONTIER_AGENT_DOCTRINE ??
      profileDoctrine(profile),
  );
  const personality =
    cleanFrontmatterValue(
      options.personality ??
        process.env.OPEN_FRONTIER_AGENT_PERSONALITY ??
        defaultPersonality(profile),
    ) || defaultPersonality(profile);
  const timeoutMs = normalizeTimeoutMs(
    options.endpointTimeoutMs ??
      process.env.OPEN_FRONTIER_AGENT_ENDPOINT_TIMEOUT_MS ??
      30_000,
  );
  const endpointUrl = new URL(endpointPath, publicBaseUrl).toString();

  return `---
agentName: ${agentName}
profile: ${profile}
doctrine: ${doctrine}
endpointUrl: ${endpointUrl}
endpointTimeoutMs: ${timeoutMs}
personality: ${personality}
---

# ${agentName}

LLM-backed Open Frontier external agent.

This agent uses the Open Frontier starter SDK: memory, action grouping,
anti-repeat guardrails, build-placement heuristics, ranked LegalAction.id
briefing, and strict JSON validation. The model still chooses the final
LegalAction.id.
`;
}

export function createHealthResponse(options = {}) {
  const publicBaseUrl = normalizePublicBaseUrl(
    options.publicBaseUrl ??
      process.env.OPEN_FRONTIER_AGENT_PUBLIC_URL ??
      "http://127.0.0.1:7777",
  );
  const decisionPath = normalizePath(
    options.decisionPath ??
      process.env.OPEN_FRONTIER_AGENT_ENDPOINT_PATH ??
      "/open-frontier/decide",
  );
  const cardPath = normalizePath(
    options.cardPath ??
      process.env.OPEN_FRONTIER_AGENT_CARD_PATH ??
      "/agent-card.md",
  );
  const agentName =
    cleanFrontmatterValue(
      options.agentName ??
        process.env.OPEN_FRONTIER_AGENT_NAME ??
        "Frontier SDK Agent",
    ) || "Frontier SDK Agent";
  return {
    ok: true,
    protocolVersion: "open-frontier-agent-v1",
    agentName,
    decisionPath,
    cardPath,
    decisionEndpointUrl: new URL(decisionPath, publicBaseUrl).toString(),
    agentCardUrl: new URL(cardPath, publicBaseUrl).toString(),
    healthCheck: {
      method: "POST",
      path: decisionPath,
      legalActionIds: ["health-check:expand", "health-check:hold"],
    },
    llmProvider: describeLlmProviderFromEnv(options.llmProvider ?? {}),
    responseContract: {
      selectedLegalActionId: "must exactly match one offered legalActions[].id",
      reason: "short human-readable string",
      confidence: "optional number from 0 to 1",
    },
    forbidden: ["raw OpenFront intents", "invented ids", "actionId alias"],
  };
}

export function publicBaseUrlFromRequest(request) {
  const host = String(
    request.headers["x-forwarded-host"] ?? request.headers.host ?? "",
  )
    .split(",")[0]
    .trim();
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim();
  const protocol =
    forwardedProto ||
    (host.startsWith("127.0.0.1") || host.startsWith("localhost")
      ? "http"
      : "https");
  return host === "" ? "http://127.0.0.1:7777" : `${protocol}://${host}`;
}

export function createFrontierMemory() {
  const matches = new Map();
  return {
    snapshot(payload) {
      return memoryForPayload(matches, payload);
    },
    record(payload, action, source) {
      const memory = memoryForPayload(matches, payload);
      memory.recentActions.push({
        id: action.id,
        kind: action.kind,
        expansion: isExpansion(action),
        at: Date.now(),
        source,
      });
      memory.recentActions = memory.recentActions.slice(-12);
      memory.actionCounts[action.kind] =
        (memory.actionCounts[action.kind] ?? 0) + 1;
      if (isExpansion(action)) memory.expansionCount += 1;
      if (action.kind === "build") memory.buildCount += 1;
    },
  };
}

export async function decisionForPayloadWithFramework(payload, options = {}) {
  const validation = validateDecisionPayload(payload);
  if (!validation.ok) {
    throw new Error(
      `Invalid Open Frontier decision request: ${validation.errors.join("; ")}`,
    );
  }
  const legalActions = validation.legalActions;
  if (legalActions.length === 0) return null;

  const memory = options.memory ?? createFrontierMemory();
  const ranked = rankLegalActions(payload, memory);
  const llmComplete = options.llmComplete ?? createLlmCompleteFromEnv(options);
  if (llmComplete === null) {
    throw new Error(
      "LLM provider required. Pass llmComplete or use createStarterAgent() with OPEN_FRONTIER_AGENT_LLM_PROVIDER/OPEN_FRONTIER_AGENT_LLM_COMMAND or OPENROUTER_API_KEY.",
    );
  }
  if (ranked.length === 0) {
    throw new Error(
      "No unblocked LegalAction.id choices are available for the LLM.",
    );
  }

  const memoryState = buildMemoryState(payload, memory);
  const first = await askLlmForDecision({
    payload,
    ranked,
    llmComplete,
    memoryState,
    modelName: options.modelName,
  });
  const result = first.ok
    ? { ...first, source: "llm" }
    : {
        ...(await askLlmForDecision({
          payload,
          ranked,
          llmComplete,
          memoryState,
          modelName: options.modelName,
          repairReason: first.error,
        })),
        source: "llm-repair",
      };
  if (!result.ok) {
    throw new Error(
      `LLM failed to select a valid, non-stale LegalAction.id: ${result.error}`,
    );
  }

  const selected = result.action;
  memory.record(payload, selected, result.source);
  return {
    selectedLegalActionId: selected.id,
    reason: result.reason.slice(0, 240),
    confidence: result.confidence,
  };
}

export function decisionForPayload(payload) {
  throw new Error(
    "decisionForPayload is no longer policy-only. Use await createStarterAgent({ llmComplete }).decide(payload).",
  );
}

export function chooseFrontierAction(payload, memory = null) {
  throw new Error(
    "chooseFrontierAction is disabled: starter agents must use an LLM to select a LegalAction.id. Use rankLegalActions only to brief and guard the LLM.",
  );
}

export function rankLegalActions(payload, memory = null) {
  const legalActions = legalActionsFromPayload(payload);
  if (legalActions.length === 0) return [];
  const observation = payload?.observation ?? {};
  const profile =
    typeof observation.profile === "string"
      ? observation.profile
      : "opportunistic";
  const phase = typeof observation.phase === "string" ? observation.phase : "";
  const memoryState = buildMemoryState(payload, memory);
  const spawnActions = legalActions.filter((action) => action.kind === "spawn");
  const candidateActions =
    spawnActions.length > 0 && phase !== "active" ? spawnActions : legalActions;

  return candidateActions
    .map((action, index) => {
      const blockReason = guardrailBlockReason(
        action,
        legalActions,
        memoryState,
      );
      const score = blockReason
        ? -10_000
        : actionScore(action, observation, profile, legalActions, memoryState);
      return {
        action,
        index,
        score,
        blocked: blockReason !== null,
        reason: blockReason ?? reasonFor(action, observation, score),
      };
    })
    .filter((candidate) => !candidate.blocked)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export function validateDecisionPayload(payload) {
  const errors = [];
  const legalActions = legalActionsFromPayload(payload);
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    errors.push("payload must be an object");
  }
  if (!Array.isArray(payload?.legalActions)) {
    errors.push("legalActions must be an array");
  }
  for (const [index, action] of legalActions.entries()) {
    if (typeof action?.id !== "string" || action.id.trim() === "") {
      errors.push(`legalActions[${index}].id must be a non-empty string`);
    }
    if (typeof action?.kind !== "string" || action.kind.trim() === "") {
      errors.push(`legalActions[${index}].kind must be a non-empty string`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    observation: payload?.observation ?? {},
    agent: payload?.agent ?? {},
    match: payload?.match ?? {},
    legalActions,
  };
}

export function groupLegalActionsByKind(legalActions) {
  const grouped = {};
  for (const action of Array.isArray(legalActions) ? legalActions : []) {
    const kind = typeof action?.kind === "string" ? action.kind : "unknown";
    grouped[kind] ??= [];
    grouped[kind].push(action);
  }
  return grouped;
}

export function selectSafeFallbackAction(legalActions) {
  if (!Array.isArray(legalActions) || legalActions.length === 0) return null;
  const hold = legalActions.find((action) => action.kind === "hold");
  if (hold !== undefined) return hold;
  const spawn = legalActions.find((action) => action.kind === "spawn");
  if (spawn !== undefined) return spawn;
  return (
    [...legalActions].sort((a, b) => {
      const riskA = riskPenalty[a?.risk?.level ?? "medium"] ?? 18;
      const riskB = riskPenalty[b?.risk?.level ?? "medium"] ?? 18;
      return riskA - riskB;
    })[0] ?? null
  );
}

export function buildDecisionBriefing(payload, memory = null) {
  const validation = validateDecisionPayload(payload);
  const ranked = validation.ok ? rankLegalActions(payload, memory) : [];
  const grouped = groupLegalActionsByKind(validation.legalActions);
  const memoryState = buildMemoryState(payload, memory);
  const antiStallGuidance = buildAntiStallGuidance(payload, memory);
  const profileRepairGuidance = buildProfileRepairGuidance(payload, memory);
  return {
    ok: validation.ok,
    errors: validation.errors,
    observationSummary: payload?.observation?.summary ?? null,
    phase: payload?.observation?.phase ?? null,
    tick: payload?.observation?.tick ?? null,
    agent: payload?.agent ?? {},
    actionCount: validation.legalActions.length,
    actionIDsByKind: Object.fromEntries(
      Object.entries(grouped).map(([kind, actions]) => [
        kind,
        actions.map((action) => action.id),
      ]),
    ),
    topActions: ranked.slice(0, 8).map(({ action, score, reason }) => ({
      id: action.id,
      kind: action.kind,
      score: Math.round(score),
      reason,
    })),
    tacticalHints: compactTacticalHints(
      payload?.observation?.tacticalAffordances,
    ),
    safeFallbackActionID:
      selectSafeFallbackAction(validation.legalActions)?.id ?? null,
    antiStallGuidance,
    profileRepairGuidance,
    guardrails: {
      repeatedKind: memoryState.repeatedKind,
      repeatedKindCount: memoryState.repeatedKindCount,
      repeatedExpansionPressure: memoryState.repeatedExpansionPressure,
    },
  };
}

export function buildProfileRepairGuidance(payload, memory = null) {
  const validation = validateDecisionPayload(payload);
  if (!validation.ok) {
    return {
      active: false,
      profile: "opportunistic",
      suggestedActionIDs: [],
      candidates: [],
      message: "Profile repair guidance unavailable because the payload is invalid.",
    };
  }
  const observation = payload?.observation ?? {};
  const profile =
    typeof observation.profile === "string"
      ? observation.profile
      : "opportunistic";
  const memoryState = buildMemoryState(payload, memory);
  const candidates = validation.legalActions
    .map((action) => ({
      id: action.id,
      kind: action.kind,
      score: profileRepairScore(
        action,
        observation,
        profile,
        validation.legalActions,
        memoryState,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
    )
    .slice(0, 6);
  const active = candidates.length > 0;
  return {
    active,
    profile,
    suggestedActionIDs: candidates.map((candidate) => candidate.id),
    candidates,
    message: active
      ? "Profile repair is active: prefer one of these offered ids over another hold or neutral-expansion loop if it is strategically legal."
      : "No profile repair alternative is currently visible.",
  };
}

export function buildAntiStallGuidance(payload, memory = null) {
  const validation = validateDecisionPayload(payload);
  if (!validation.ok) {
    return {
      active: false,
      message: "No anti-stall guidance: request failed validation.",
      preferredDifferentKindIDs: [],
    };
  }
  const memoryState = buildMemoryState(payload, memory);
  const usefulAlternatives = validation.legalActions.filter((action) => {
    if (action.kind === "hold" || action.kind === "spawn") return false;
    if (!usefulNonHoldKinds.has(action.kind)) return false;
    if (
      action.kind === "build" &&
      String(action.metadata?.unit ?? "").includes("Defense")
    ) {
      return buildScore(action, payload?.observation ?? {}, memoryState) > 0;
    }
    if (
      memoryState.repeatedKind !== null &&
      action.kind === memoryState.repeatedKind
    ) {
      return false;
    }
    return true;
  });
  const observedMemory = payload?.observation?.memory ?? {};
  const repeatedKind =
    memoryState.repeatedKind ??
    (typeof observedMemory.repeatedActionKind === "string"
      ? observedMemory.repeatedActionKind
      : null);
  const repeatedCount = Math.max(
    memoryState.repeatedKindCount,
    Number(observedMemory.repeatedActionCount ?? 0),
  );
  const active =
    memoryState.repeatedExpansionPressure === true ||
    (repeatedKind !== null && repeatedCount >= 2);
  return {
    active,
    repeatedKind,
    repeatedCount,
    preferredDifferentKindIDs: usefulAlternatives
      .slice(0, 6)
      .map((action) => action.id),
    message: active
      ? `Avoid repeating ${repeatedKind ?? "the same expansion"} when one of the listed useful alternatives is legal.`
      : usefulAlternatives.length > 0
        ? "Useful non-hold alternatives are legal; do not choose hold unless every useful option is strategically bad."
        : "No useful anti-stall alternative is currently visible.",
  };
}

export function buildLlmPrompt(payload, ranked, options = {}) {
  const briefing = buildDecisionBriefing(payload, options.memory ?? null);
  const selectableRankedActions = ranked.slice(0, 24);
  const selectableActionIDs = selectableRankedActions.map(
    ({ action }) => action.id,
  );
  const selectableActionIDsByKind = Object.fromEntries(
    Object.entries(
      groupLegalActionsByKind(
        selectableRankedActions.map(({ action }) => action),
      ),
    ).map(([kind, actions]) => [kind, actions.map((action) => action.id)]),
  );
  const topActions = selectableRankedActions.map(
    ({ action, score, reason }) => ({
      id: action.id,
      kind: action.kind,
      label: action.label,
      score: Math.round(score),
      reason,
      risk: action.risk,
      metadata: compactMetadata(action.metadata),
    }),
  );
  const observation = compactObservation(payload?.observation ?? {});
  const repair = options.repairReason
    ? `\nPrevious response was invalid: ${options.repairReason}\n`
    : "";
  const briefingForPrompt = { ...briefing };
  delete briefingForPrompt.actionIDsByKind;
  delete briefingForPrompt.safeFallbackActionID;
  delete briefingForPrompt.topActions;
  return `${agentSkillPrompt}

Runtime contract:
- Choose exactly one id from the selectable legal actions below.
- Return JSON only with selectedLegalActionId, reason, confidence.
- Do not write code. Do not call tools. Do not invent ids.
- Do not choose ids from observation, memory, history, or previous turns.
- The only valid ids for this decision are in selectableActionIDs and selectable legal actions.
${repair}
Agent:
${JSON.stringify(payload?.agent ?? {}, null, 2)}

Observation:
${JSON.stringify(observation, null, 2)}

Decision briefing:
${JSON.stringify(
  {
    ...briefingForPrompt,
    selectableActionIDs,
    selectableActionIDsByKind,
  },
  null,
  2,
)}

Selectable legal actions:
${JSON.stringify(topActions, null, 2)}
`;
}

async function askLlmForDecision(input) {
  const prompt = buildLlmPrompt(input.payload, input.ranked, {
    repairReason: input.repairReason,
  });
  let raw;
  try {
    raw = await input.llmComplete(prompt);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  const parsed = parseDecisionJson(
    raw,
    input.ranked.map((candidate) => candidate.action),
  );
  if (!parsed.ok) return parsed;
  const blockReason = guardrailBlockReason(
    parsed.action,
    legalActionsFromPayload(input.payload),
    input.memoryState ?? buildMemoryState(input.payload, null),
  );
  if (blockReason !== null) {
    return { ok: false, error: blockReason };
  }
  return parsed;
}

function parseDecisionJson(raw, legalActions) {
  const jsonText = stripSingleJsonFence(String(raw).trim());
  if (jsonText.length === 0) {
    return { ok: false, error: "empty LLM response" };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${errorMessage(error)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "LLM response must be a JSON object" };
  }
  const allowedKeys = new Set([
    "selectedLegalActionId",
    "reason",
    "confidence",
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      if (key === "actionId") {
        return {
          ok: false,
          error:
            "unknown JSON field: actionId. Use selectedLegalActionId instead.",
        };
      }
      return { ok: false, error: `unknown JSON field: ${key}` };
    }
  }
  const id = parsed.selectedLegalActionId;
  const action = legalActions.find((candidate) => candidate.id === id);
  if (typeof id !== "string" || action === undefined) {
    const offered = legalActions
      .map((candidate) => candidate.id)
      .filter((value) => typeof value === "string")
      .slice(0, 8)
      .join(", ");
    return {
      ok: false,
      error: `unknown selectedLegalActionId ${JSON.stringify(id)}${offered ? `; choose one of: ${offered}` : ""}`,
    };
  }
  if (typeof parsed.reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  const reason = parsed.reason.trim();
  if (reason === "") {
    return { ok: false, error: "reason cannot be empty" };
  }
  if (reason.length > 500) {
    return { ok: false, error: "reason exceeds 500 characters" };
  }
  if (parsed.confidence !== undefined) {
    if (
      typeof parsed.confidence !== "number" ||
      !Number.isFinite(parsed.confidence)
    ) {
      return { ok: false, error: "confidence must be a finite number" };
    }
  }
  const confidence =
    parsed.confidence === undefined
      ? 0.6
      : Math.max(0, Math.min(1, parsed.confidence));
  return { ok: true, action, reason, confidence };
}

export function validateDecisionOutput(raw, legalActions) {
  return parseDecisionJson(
    raw,
    Array.isArray(legalActions) ? legalActions : [],
  );
}

function stripSingleJsonFence(value) {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}

function actionScore(action, observation, profile, legalActions, memoryState) {
  let score = 0;

  switch (action.kind) {
    case "spawn":
      score += spawnScore(action, profile);
      break;
    case "attack":
      score += attackScore(action, observation, memoryState);
      break;
    case "boat":
      score += boatScore(action, legalActions, observation, memoryState);
      break;
    case "build":
    case "upgrade_structure":
    case "warship":
      score += buildScore(action, observation, memoryState);
      break;
    case "alliance_request":
    case "alliance_extend":
      score += 56;
      if (profile === "diplomatic") score += 20;
      if (threatLevel(observation) > 0.45) score += 10;
      break;
    case "donate_gold":
    case "donate_troops":
      score += profile === "diplomatic" ? 46 : 26;
      break;
    case "embargo":
    case "embargo_all":
      score += 28;
      if (profile === "aggressive" || profile === "opportunistic") score += 8;
      if (memoryState?.repeatedExpansionPressure) score += 10;
      break;
    case "target_player":
      score += profile === "aggressive" ? 38 : 24;
      if (memoryState?.repeatedExpansionPressure) score += 12;
      break;
    case "retreat":
    case "boat_retreat":
    case "cancel_attack":
    case "cancel_boat":
      score += threatLevel(observation) > 0.35 ? 48 : 20;
      break;
    case "quick_chat":
    case "emoji":
      score += profile === "diplomatic" ? 18 : 5;
      break;
    case "hold":
      score += hasUsefulNonHold(legalActions, observation) ? -30 : 18;
      break;
    default:
      score += 10;
  }

  score += profileKindBias[profile]?.[action.kind] ?? 0;
  score += strategicBias(action, observation, memoryState);
  score += profileRepairScore(
    action,
    observation,
    profile,
    legalActions,
    memoryState,
  );
  score -= riskPenalty[action.risk?.level ?? "medium"] ?? 18;
  score -= repetitionPenalty(action, observation, memoryState);
  return score;
}

function spawnScore(action, profile) {
  const metadata = metadataOf(action);
  const scoreByProfile = {
    aggressive: numberMetadata(metadata, "pressureScore"),
    defensive: numberMetadata(metadata, "safetyScore"),
    diplomatic: numberMetadata(metadata, "diplomacyScore"),
    opportunistic: numberMetadata(metadata, "opportunityScore"),
  };
  return 100 + (scoreByProfile[profile] ?? scoreByProfile.opportunistic) * 20;
}

function attackScore(action, observation, memoryState) {
  const metadata = metadataOf(action);
  if (isExpansion(action)) {
    const tilesOwned = Number(observation?.ownState?.tilesOwned ?? 0);
    const earlyExpansionBonus =
      tilesOwned < 800 ? 22 : tilesOwned < 3_000 ? 12 : 0;
    const repeatPenalty = memoryState?.repeatedExpansionPressure ? 90 : 0;
    return (
      76 + earlyExpansionBonus + boundedTroopBonus(metadata) - repeatPenalty
    );
  }
  const ratio = numberMetadata(metadata, "relativeTroopRatio");
  const targetTroops = numberMetadata(metadata, "targetTroops");
  const ownTroops = numberMetadata(metadata, "ownTroops");
  const troopEdge =
    ratio > 0 ? Math.min(30, ratio * 10) : ownTroops > targetTroops ? 18 : -10;
  const targetTileShare = numberMetadata(metadata, "targetTileShare");
  const finishingPressure =
    (ratio >= 2 && targetTroops > 0) || targetTileShare > 0.45 ? 18 : 0;
  return (
    58 +
    troopEdge +
    hostileAttackCommitmentBonus(metadata, ratio) +
    finishingPressure
  );
}

function hostileAttackCommitmentBonus(metadata, ratio) {
  const troopPercent =
    numberMetadata(metadata, "troopPercent") ||
    numberMetadata(metadata, "troopPercentage") * 100;
  if (ratio >= 3) {
    if (troopPercent >= 35 && troopPercent <= 45) return 30;
    if (troopPercent >= 20 && troopPercent <= 30) return 26;
    if (troopPercent <= 12) return 4;
    return -10;
  }
  if (ratio >= 2) {
    if (troopPercent >= 20 && troopPercent <= 30) return 28;
    if (troopPercent >= 35 && troopPercent <= 45) return 18;
    if (troopPercent <= 12) return 6;
    return -12;
  }
  if (ratio >= 1.4) {
    if (troopPercent >= 20 && troopPercent <= 30) return 18;
    if (troopPercent <= 12) return 10;
    return -8;
  }
  if (troopPercent <= 12) return 12;
  if (troopPercent >= 20 && troopPercent <= 30) return -4;
  return -22;
}

function boatScore(action, legalActions, observation, memoryState) {
  const metadata = metadataOf(action);
  const hostileAttackAvailable = legalActions.some(
    (candidate) => candidate.kind === "attack" && !isExpansion(candidate),
  );
  const activeBoatCount = Number(observation?.ownState?.activeBoats ?? 0);
  let score = metadata.targetID === null ? 58 : 36;
  score += boundedTroopBonus(metadata);
  if (memoryState?.repeatedExpansionPressure && !hostileAttackAvailable) {
    score += 18;
  }
  if (hostileAttackAvailable) {
    score -= 42;
  }
  if (activeBoatCount >= 3) {
    score -= Math.min(36, activeBoatCount * 6);
  }
  return score;
}

function buildScore(action, observation, memoryState) {
  const metadata = metadataOf(action);
  const unit = String(metadata.unit ?? "");
  const role = String(metadata.role ?? "");
  const economicValue = numberMetadata(metadata, "economicValue");
  const defensiveValue = numberMetadata(metadata, "defensiveValue");
  const frontierValue = numberMetadata(metadata, "frontierValue");
  const nearbyEnemyCount = numberMetadata(metadata, "nearbyEnemyCount");
  const hostileBorderDistance = numberMetadata(
    metadata,
    "hostileBorderDistance",
  );
  const threatened = threatLevel(observation) > 0.35;

  if (unit.includes("Defense")) {
    const frontierUseful =
      metadata.nearbyIncomingAttack === true ||
      nearbyEnemyCount > 0 ||
      frontierValue > 0.35 ||
      defensiveValue > 0.35 ||
      (hostileBorderDistance > 0 && hostileBorderDistance <= 35);
    return frontierUseful
      ? 72 + defensiveValue * 30 + frontierValue * 18 + (threatened ? 12 : 0)
      : -35;
  }

  if (
    unit.includes("City") ||
    unit.includes("Factory") ||
    role === "economic"
  ) {
    const rotationBonus = memoryState?.repeatedExpansionPressure ? 68 : 0;
    return 62 + economicValue * 25 + rotationBonus - (threatened ? 6 : 0);
  }

  return role === "defensive" ? 48 : 44;
}

function strategicBias(action, observation, memoryState) {
  const recommended = Array.isArray(
    observation?.strategic?.recommendedActionKinds,
  )
    ? observation.strategic.recommendedActionKinds
    : [];
  const objective = observation?.objective?.kind;
  const recentExpansionCount = Number(
    observation?.memory?.recentExpansionCount ?? 0,
  );
  const recentBuildCount = Number(observation?.memory?.recentBuildCount ?? 0);
  let score = recommended.includes(action.kind) ? 14 : 0;
  if (objective === "choose_spawn" && action.kind === "spawn") score += 30;
  if (objective === "expand_territory" && isExpansion(action)) score += 18;
  if (objective === "secure_economy" && action.kind === "build") score += 18;
  if (objective === "build_alliance" && action.kind === "alliance_request")
    score += 18;
  if (
    objective === "pressure_rival" &&
    action.kind === "attack" &&
    !isExpansion(action)
  )
    score += 18;
  if (objective === "fortify_border" && action.kind === "build") score += 14;
  if (
    action.kind === "attack" &&
    !isExpansion(action) &&
    observation?.tacticalAffordances?.frontierConversionTiming?.recommended ===
      true
  ) {
    score += 34;
  }
  const finishPressure =
    observation?.tacticalAffordances?.frontierFinishPressure;
  if (finishPressure?.recommended === true) {
    const finishTargetID = finishPressure.bestTargetID ?? null;
    const finishAttack =
      action.kind === "attack" &&
      !isExpansion(action) &&
      (action.id === finishPressure.bestAttackID ||
        (finishTargetID !== null && actionTargetID(action) === finishTargetID));
    if (finishAttack) {
      score += action.id === finishPressure.bestAttackID ? 58 : 42;
    } else if (isExpansion(action) || action.kind === "hold") {
      score -= 18;
    }
  }
  const economyCadence = observation?.tacticalAffordances?.economyCadence;
  if (
    economyCadence?.recommended === true &&
    action.kind === "build" &&
    (action.id === economyCadence.bestBuildID ||
      action.metadata?.role === "economic" ||
      ["City", "Factory", "Port"].includes(String(action.metadata?.unit ?? "")))
  ) {
    score += action.id === economyCadence.bestBuildID ? 54 : 34;
  }
  if (economyCadence?.recommended === true && isExpansion(action)) {
    score -= 24;
  }
  const navalControl = observation?.tacticalAffordances?.navalControl;
  if (navalControl?.recommended === true) {
    const navalKind =
      action.kind === "boat" ||
      action.kind === "warship" ||
      action.kind === "move_warship" ||
      action.kind === "boat_retreat";
    if (action.id === navalControl.bestNavalActionID) {
      score += 96;
    } else if (navalKind) {
      score += 20;
    } else if (action.kind === "hold") {
      score -= 18;
    }
  }
  const strikeTargeting =
    observation?.tacticalAffordances?.lateGameStrikeTargeting;
  if (strikeTargeting?.recommended === true) {
    const targetStrike =
      action.kind === "nuke" &&
      (action.id === strikeTargeting.bestStrikeActionID ||
        (strikeTargeting.bestStrikeTargetID !== null &&
          strikeTargeting.bestStrikeTargetID !== undefined &&
          actionTargetID(action) === strikeTargeting.bestStrikeTargetID));
    if (targetStrike) {
      score += action.id === strikeTargeting.bestStrikeActionID ? 96 : 48;
    } else if (action.kind === "hold") {
      score -= 20;
    }
  }
  const personality =
    observation?.tacticalAffordances?.personalityDiplomacyPressure;
  if (personality?.recommended === true) {
    const socialAction =
      isPersonalityDiplomacyActionKind(action.kind) &&
      (action.id === personality.bestSocialActionID ||
        (personality.bestSocialTargetID !== null &&
          personality.bestSocialTargetID !== undefined &&
          actionTargetID(action) === personality.bestSocialTargetID));
    if (socialAction) {
      score += action.id === personality.bestSocialActionID ? 78 : 32;
    } else if (action.kind === "hold") {
      score -= 16;
    }
  }
  if (
    action.kind === "build" &&
    recentExpansionCount > 0 &&
    recentBuildCount === 0
  ) {
    score += 58;
  }
  if (isExpansion(action) && recentExpansionCount > 0) {
    score -= Math.min(54, recentExpansionCount * 30);
  }
  if (memoryState?.repeatedExpansionPressure && action.kind !== "attack") {
    score += 20;
  }
  return score;
}

function profileRepairScore(
  action,
  observation,
  profile,
  legalActions,
  memoryState,
) {
  const repeatedExpansion =
    memoryState?.repeatedExpansionPressure === true ||
    Number(observation?.memory?.recentExpansionCount ?? 0) >= 2;
  const holdLoop =
    Number(observation?.memory?.recentHoldCount ?? 0) >= 2 ||
    Number(observation?.memory?.turnsSinceLastProductiveAction ?? 0) >= 2;
  const ownTileShare = Number(
    observation?.ownState?.tileShare ?? observation?.endgame?.ownTileShare ?? 0,
  );
  const earlyOpening =
    Number(observation?.turnNumber ?? 0) < 900 && ownTileShare < 0.04;
  if (!holdLoop && (!repeatedExpansion || earlyOpening)) return 0;

  const hasProfileAlternative = legalActions.some(
    (candidate) =>
      candidate.kind !== "hold" &&
      !isExpansion(candidate) &&
      candidate.risk?.level !== "high" &&
      isProfileExpressionAction(profile, candidate),
  );
  if (action.kind === "hold" && hasProfileAlternative) return -46;
  if (isExpansion(action) && repeatedExpansion && hasProfileAlternative) {
    return -24;
  }

  if (profile === "aggressive") {
    if (isWeakHostileAttack(action)) return 58;
    if (isPressureSignal(action)) return 34;
    if (action.kind === "nuke") return 30;
  }
  if (profile === "defensive") {
    if (isDefenseBuild(action)) return 56;
    if (isEconomyBuild(action)) return 42;
    if (isNavalAction(action)) return 34;
    if (action.kind === "alliance_request") return 24;
  }
  if (profile === "diplomatic") {
    if (isFriendlyDiplomacy(action)) return 58;
    if (isCommunication(action)) return 38;
    if (isPressureSignal(action)) return 24;
  }
  if (profile === "opportunistic") {
    if (isWeakHostileAttack(action)) return 48;
    if (isEconomyBuild(action)) return repeatedExpansion ? 42 : 32;
    if (isNavalAction(action)) return 38;
    if (isPressureSignal(action)) return 28;
    if (action.kind === "nuke") return 34;
  }
  return 0;
}

function isProfileExpressionAction(profile, action) {
  if (profile === "aggressive") {
    return (
      isWeakHostileAttack(action) ||
      isPressureSignal(action) ||
      action.kind === "nuke"
    );
  }
  if (profile === "defensive") {
    return (
      isDefenseBuild(action) ||
      isEconomyBuild(action) ||
      isNavalAction(action) ||
      action.kind === "alliance_request"
    );
  }
  if (profile === "diplomatic") {
    return (
      isFriendlyDiplomacy(action) ||
      isCommunication(action) ||
      isPressureSignal(action)
    );
  }
  return (
    isWeakHostileAttack(action) ||
    isEconomyBuild(action) ||
    isNavalAction(action) ||
    isPressureSignal(action) ||
    action.kind === "nuke"
  );
}

function isWeakHostileAttack(action) {
  if (action.kind !== "attack" || isExpansion(action)) return false;
  const ratio = numberMetadata(metadataOf(action), "relativeTroopRatio");
  return ratio === 0 || ratio >= 1.08;
}

function isDefenseBuild(action) {
  if (action.kind !== "build" && action.kind !== "upgrade_structure")
    return false;
  return /defense|defence|sam|silo|missile|shield|fort/i.test(
    JSON.stringify(metadataOf(action)),
  );
}

function isEconomyBuild(action) {
  if (action.kind !== "build" && action.kind !== "upgrade_structure")
    return false;
  return /economic|city|factory|port|trade|income|market/i.test(
    JSON.stringify(metadataOf(action)),
  );
}

function isNavalAction(action) {
  return (
    action.kind === "boat" ||
    action.kind === "boat_retreat" ||
    action.kind === "warship" ||
    action.kind === "move_warship" ||
    action.metadata?.navalInvasion === true
  );
}

function isPressureSignal(action) {
  return [
    "target_player",
    "embargo",
    "embargo_all",
    "break_alliance",
    "alliance_reject",
  ].includes(action.kind);
}

function isFriendlyDiplomacy(action) {
  return [
    "alliance_request",
    "alliance_extend",
    "donate_gold",
    "donate_troops",
    "embargo_stop",
  ].includes(action.kind);
}

function isCommunication(action) {
  return action.kind === "quick_chat" || action.kind === "emoji";
}

function repetitionPenalty(action, observation, memoryState) {
  const memory = observation?.memory ?? {};
  let penalty = 0;
  if (
    Array.isArray(memory.avoidActionIDs) &&
    memory.avoidActionIDs.includes(action.id)
  ) {
    penalty += 45;
  }
  if (memory.repeatedActionKind === action.kind) {
    penalty += Math.min(36, Number(memory.repeatedActionCount ?? 1) * 12);
  }
  if (memoryState?.repeatedKind === action.kind) {
    penalty += Math.min(60, memoryState.repeatedKindCount * 18);
  }
  if (
    Array.isArray(memory.recentActions) &&
    memory.recentActions
      .slice(-2)
      .every((decision) => decision?.actionKind === action.kind)
  ) {
    penalty += 14;
  }
  return penalty;
}

function guardrailBlockReason(action, legalActions, memoryState) {
  if (!memoryState.repeatedExpansionPressure || !isExpansion(action))
    return null;
  const alternative = bestRotationAlternative(legalActions);
  if (alternative === null) return null;
  return `repeated neutral expansion blocked; rotate to ${alternative.kind} (${alternative.id})`;
}

function bestRotationAlternative(legalActions) {
  const preferredKinds = [
    "build",
    "boat",
    "attack",
    "target_player",
    "embargo",
    "alliance_request",
    "quick_chat",
    "emoji",
  ];
  for (const kind of preferredKinds) {
    const action = legalActions.find((candidate) => {
      if (candidate.kind !== kind) return false;
      if (kind === "attack") return !isExpansion(candidate);
      if (
        kind === "build" &&
        String(candidate.metadata?.unit ?? "").includes("Defense")
      ) {
        return buildScore(candidate, {}, null) > 0;
      }
      return true;
    });
    if (action !== undefined) return action;
  }
  return null;
}

function buildMemoryState(payload, memoryStore) {
  const local = memoryStore?.snapshot(payload);
  const observationMemory = payload?.observation?.memory ?? {};
  const localRecent = local?.recentActions ?? [];
  const recentKinds = localRecent.map((action) => action.kind);
  const repeatedKind = repeatedTail(recentKinds);
  const repeatedKindCount = repeatedKind
    ? countTail(recentKinds, repeatedKind)
    : Number(observationMemory.repeatedActionCount ?? 0);
  const localExpansionTail = countTail(
    localRecent.map((action) => (action.expansion ? "expansion" : action.kind)),
    "expansion",
  );
  const observedRepeatedAttack =
    observationMemory.repeatedActionKind === "attack" &&
    Number(observationMemory.repeatedActionCount ?? 0) >= 3;
  const observedRecentExpansion = Number(
    observationMemory.recentExpansionCount ?? 0,
  );
  const repeatedExpansionPressure =
    localExpansionTail >= 3 ||
    observedRepeatedAttack ||
    observedRecentExpansion >= 3;
  return {
    repeatedKind,
    repeatedKindCount,
    localExpansionTail,
    repeatedExpansionPressure,
  };
}

function repeatedTail(values) {
  const last = values.at(-1);
  if (last === undefined) return null;
  return countTail(values, last) >= 2 ? last : null;
}

function countTail(values, target) {
  let count = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== target) break;
    count += 1;
  }
  return count;
}

function hasUsefulNonHold(actions, observation) {
  return actions.some((action) => {
    if (action.kind === "hold") return false;
    if (!usefulNonHoldKinds.has(action.kind)) return false;
    if (
      action.kind === "build" &&
      String(action.metadata?.unit ?? "").includes("Defense")
    ) {
      return buildScore(action, observation, null) > 0;
    }
    return true;
  });
}

function reasonFor(action, observation, score) {
  const profile = observation?.profile ?? "agent";
  const metadata = metadataOf(action);
  if (action.kind === "spawn") {
    return `${profile} chose a spawn with strong opening score and room to grow.`;
  }
  if (isExpansion(action)) {
    return `${profile} expanded into neutral land with bounded troops while growth is available.`;
  }
  if (action.kind === "attack") {
    return `${profile} pressured ${metadata.targetName ?? "a rival"} because the legal action looked favorable.`;
  }
  if (action.kind === "boat") {
    return `${profile} launched a transport to keep expansion moving without repeating land pressure.`;
  }
  if (action.kind === "build") {
    return `${profile} built ${metadata.unit ?? "a structure"}: ${metadata.buildPlacementReason ?? "best available legal build"}.`;
  }
  if (action.kind === "alliance_request" || action.kind === "alliance_extend") {
    return `${profile} chose diplomacy with ${metadata.targetName ?? metadata.recipientName ?? "another nation"} to reduce strategic risk.`;
  }
  if (action.kind === "embargo" || action.kind === "embargo_all") {
    return `${profile} applied economic pressure because repeated expansion was lower value.`;
  }
  if (action.kind === "hold") {
    return `${profile} held because no useful non-hold action beat the safety threshold.`;
  }
  return `${profile} ranked ${action.kind} with score ${Math.round(score)} from the offered legal actions.`;
}

function boundedTroopBonus(metadata) {
  const troopPercent = numberMetadata(metadata, "troopPercent");
  if (troopPercent === 0) return 8;
  if (troopPercent <= 10) return 16;
  if (troopPercent <= 25) return 12;
  if (troopPercent <= 40) return 2;
  return -14;
}

function threatLevel(observation) {
  const strategicThreat = Number(observation?.strategic?.scores?.threat ?? 0);
  const incoming = Number(observation?.ownState?.incomingAttacks ?? 0);
  return Math.max(strategicThreat, incoming > 0 ? 0.7 : 0);
}

function isExpansion(action) {
  return (
    action.kind === "attack" &&
    (action.metadata?.expansion === true ||
      action.metadata?.targetID === null ||
      String(action.id ?? "").startsWith("expand:terra-nullius"))
  );
}

function actionTargetID(action) {
  if (typeof action?.metadata?.targetID === "string") {
    return action.metadata.targetID;
  }
  if (typeof action?.metadata?.recipientID === "string") {
    return action.metadata.recipientID;
  }
  const match = String(action?.id ?? "").match(/^attack:([^:]+):/u);
  return match?.[1] ?? null;
}

function isPersonalityDiplomacyActionKind(kind) {
  return (
    kind === "target_player" ||
    kind === "embargo" ||
    kind === "embargo_all" ||
    kind === "alliance_reject" ||
    kind === "break_alliance" ||
    kind === "alliance_request" ||
    kind === "alliance_extend" ||
    kind === "donate_gold" ||
    kind === "donate_troops" ||
    kind === "embargo_stop" ||
    kind === "quick_chat" ||
    kind === "emoji"
  );
}

function metadataOf(action) {
  return action?.metadata && typeof action.metadata === "object"
    ? action.metadata
    : {};
}

function numberMetadata(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function legalActionsFromPayload(payload) {
  return Array.isArray(payload?.legalActions) ? payload.legalActions : [];
}

function memoryForPayload(matches, payload) {
  const key = [
    payload?.match?.gameID ?? "match",
    payload?.agent?.agentID ?? payload?.agent?.username ?? "agent",
  ].join(":");
  const existing = matches.get(key);
  if (existing !== undefined) return existing;
  const created = {
    recentActions: [],
    actionCounts: {},
    expansionCount: 0,
    buildCount: 0,
  };
  matches.set(key, created);
  return created;
}

function compactObservation(observation) {
  return {
    phase: observation.phase,
    tick: observation.tick,
    profile: observation.profile,
    summary: observation.summary,
    ownState: observation.ownState,
    strategic: observation.strategic,
    memory: observation.memory,
    tacticalAffordances: compactTacticalHints(observation.tacticalAffordances),
    objective: observation.objective,
    relevantPlayers: Array.isArray(observation.relevantPlayers)
      ? observation.relevantPlayers.slice(0, 8)
      : undefined,
    notes: observation.notes,
  };
}

function compactTacticalHints(tacticalAffordances) {
  if (tacticalAffordances === null || typeof tacticalAffordances !== "object") {
    return undefined;
  }
  const hints = {};
  const economy = tacticalAffordances.economyCadence;
  if (economy !== null && typeof economy === "object") {
    hints.economyCadence = {
      tacticID: economy.tacticID,
      recommended: economy.recommended === true,
      bestBuildID: economy.bestBuildID ?? null,
      bestBuildUnit: economy.bestBuildUnit ?? null,
      economyBuildActionCount: Number(economy.economyBuildActionCount ?? 0),
      safeEconomyBuildActionCount: Number(
        economy.safeEconomyBuildActionCount ?? 0,
      ),
      recentExpansionCount: Number(economy.recentExpansionCount ?? 0),
      recentBuildCount: Number(economy.recentBuildCount ?? 0),
      homeDanger: economy.homeDanger ?? "unknown",
    };
  }
  const conversion = tacticalAffordances.frontierConversionTiming;
  if (conversion !== null && typeof conversion === "object") {
    hints.frontierConversionTiming = {
      tacticID: conversion.tacticID,
      recommended: conversion.recommended === true,
      bestExecutorReadyTargetName:
        conversion.bestExecutorReadyTargetName ?? null,
      executorReadyHostileAttackActionCount: Number(
        conversion.executorReadyHostileAttackActionCount ?? 0,
      ),
    };
  }
  const finish = tacticalAffordances.frontierFinishPressure;
  if (finish !== null && typeof finish === "object") {
    hints.frontierFinishPressure = {
      tacticID: finish.tacticID,
      recommended: finish.recommended === true,
      bestTargetID: finish.bestTargetID ?? null,
      bestTargetName: finish.bestTargetName ?? null,
      bestAttackID: finish.bestAttackID ?? null,
      decisiveAttackActionCount: Number(finish.decisiveAttackActionCount ?? 0),
      recentLowCommitmentAttackCount: Number(
        finish.recentLowCommitmentAttackCount ?? 0,
      ),
      homeDanger: finish.homeDanger ?? "unknown",
    };
  }
  const banking = tacticalAffordances.transportTroopBanking;
  if (banking !== null && typeof banking === "object") {
    hints.transportTroopBanking = {
      tacticID: banking.tacticID,
      recommended: banking.recommended === true,
      largestAvailableBoatLaunchTroops: Number(
        banking.largestAvailableBoatLaunchTroops ?? 0,
      ),
      homeDanger: banking.homeDanger ?? "unknown",
    };
  }
  const naval = tacticalAffordances.navalControl;
  if (naval !== null && typeof naval === "object") {
    hints.navalControl = {
      tacticID: naval.tacticID,
      recommended: naval.recommended === true,
      bestNavalActionID: naval.bestNavalActionID ?? null,
      bestNavalActionKind: naval.bestNavalActionKind ?? null,
      activeTransportCount: Number(naval.activeTransportCount ?? 0),
      boatLaunchActionCount: Number(naval.boatLaunchActionCount ?? 0),
      warshipBuildActionCount: Number(naval.warshipBuildActionCount ?? 0),
      warshipMoveActionCount: Number(naval.warshipMoveActionCount ?? 0),
      homeDanger: naval.homeDanger ?? "unknown",
    };
  }
  const strike = tacticalAffordances.lateGameStrikeTargeting;
  if (strike !== null && typeof strike === "object") {
    hints.lateGameStrikeTargeting = {
      tacticID: strike.tacticID,
      recommended: strike.recommended === true,
      bestStrikeActionID: strike.bestStrikeActionID ?? null,
      bestStrikeWeapon: strike.bestStrikeWeapon ?? null,
      bestStrikeTargetID: strike.bestStrikeTargetID ?? null,
      bestStrikeTargetName: strike.bestStrikeTargetName ?? null,
      bestStrikeTargetStructureUnit:
        strike.bestStrikeTargetStructureUnit ?? null,
      bestStrikeScore: Number(strike.bestStrikeScore ?? 0),
      legalStrikeActionCount: Number(strike.legalStrikeActionCount ?? 0),
      highValueStrikeActionCount: Number(
        strike.highValueStrikeActionCount ?? 0,
      ),
      homeDanger: strike.homeDanger ?? "unknown",
    };
  }
  const personality = tacticalAffordances.personalityDiplomacyPressure;
  if (personality !== null && typeof personality === "object") {
    hints.personalityDiplomacyPressure = {
      tacticID: personality.tacticID,
      recommended: personality.recommended === true,
      profile: personality.profile ?? null,
      bestSocialActionID: personality.bestSocialActionID ?? null,
      bestSocialActionKind: personality.bestSocialActionKind ?? null,
      bestSocialTargetName: personality.bestSocialTargetName ?? null,
      bestSocialScore: Number(personality.bestSocialScore ?? 0),
      personalityMode: personality.personalityMode ?? null,
      socialActionCount: Number(personality.socialActionCount ?? 0),
      pressureActionCount: Number(personality.pressureActionCount ?? 0),
      communicationActionCount: Number(
        personality.communicationActionCount ?? 0,
      ),
      recentSocialActionCount: Number(personality.recentSocialActionCount ?? 0),
      homeDanger: personality.homeDanger ?? "unknown",
    };
  }
  return Object.keys(hints).length === 0 ? undefined : hints;
}

function compactMetadata(metadata) {
  if (metadata === null || typeof metadata !== "object") return metadata;
  const keys = [
    "targetName",
    "targetID",
    "troopPercent",
    "troopPercentage",
    "expansion",
    "unit",
    "role",
    "economicValue",
    "defensiveValue",
    "frontierValue",
    "nearbyEnemyCount",
    "hostileBorderDistance",
    "relativeTroopRatio",
    "riskEstimate",
    "buildPlacementReason",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => metadata[key] !== undefined)
      .map((key) => [key, metadata[key]]),
  );
}

function normalizePublicBaseUrl(value) {
  try {
    const url = new URL(String(value));
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "http://127.0.0.1:7777/";
  }
}

function normalizePath(value) {
  const pathValue = String(value ?? "").trim();
  if (pathValue === "") return "/open-frontier/decide";
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function normalizeProfile(value) {
  const profile = String(value ?? "").trim();
  return ["aggressive", "defensive", "diplomatic", "opportunistic"].includes(
    profile,
  )
    ? profile
    : "opportunistic";
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 250 && parsed <= 180_000
    ? parsed
    : 30_000;
}

function cleanFrontmatterValue(value) {
  return String(value ?? "")
    .replace(/[\r\n:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function profileDoctrine(profile) {
  const doctrineByProfile = {
    aggressive: "pressure",
    defensive: "fortress",
    diplomatic: "diplomatic",
    opportunistic: "balanced",
  };
  return doctrineByProfile[profile] ?? "balanced";
}

function defaultPersonality(profile) {
  const personalityByProfile = {
    aggressive:
      "Expands early, pressures weak borders, and rotates into economy when expansion repeats.",
    defensive:
      "Builds economy safely, fortifies real borders, and avoids wasteful attacks.",
    diplomatic:
      "Builds useful alliances, supports buffers, and avoids protecting runaway leaders.",
    opportunistic:
      "Expands when safe, attacks weak targets, and avoids repeated low-value actions.",
  };
  return personalityByProfile[profile] ?? personalityByProfile.opportunistic;
}

function loadAgentSkillPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, "AGENT_SKILL.md"), "utf8");
  } catch {
    return "Choose exactly one offered LegalAction.id. Never emit raw intents.";
  }
}

export function openRouterCompleteFromEnv(options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required when OPEN_FRONTIER_AGENT_LLM_PROVIDER=openrouter.",
    );
  }
  const model =
    options.model ??
    process.env.OPENROUTER_MODEL ??
    process.env.OPEN_FRONTIER_AGENT_LLM_MODEL ??
    "google/gemini-2.5-flash-lite";
  return async (prompt) => {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "http-referer": "http://127.0.0.1:8787",
          "x-title": "Open Frontier Starter Agent",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                'Return strict JSON only: {"selectedLegalActionId":"exact offered id","reason":"short reason","confidence":0.7}',
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 220,
          response_format: { type: "json_object" },
        }),
      },
    );
    const json = await response.json();
    if (!response.ok) {
      throw new Error(
        `OpenRouter ${response.status}: ${JSON.stringify(json).slice(0, 300)}`,
      );
    }
    return String(json.choices?.[0]?.message?.content ?? "");
  };
}

export function commandCompleteFromEnv(options = {}) {
  if (typeof options.command === "string" && Array.isArray(options.args)) {
    return commandComplete({
      command: options.command,
      args: options.args,
      timeoutMs: options.timeoutMs,
      cwd: options.cwd,
    });
  }
  const commandSpec =
    options.command ?? process.env.OPEN_FRONTIER_AGENT_LLM_COMMAND ?? "";
  if (commandSpec.trim() === "") {
    throw new Error(
      "OPEN_FRONTIER_AGENT_LLM_COMMAND is required when OPEN_FRONTIER_AGENT_LLM_PROVIDER=command. The command must print the final strict JSON decision to stdout.",
    );
  }
  const parsedCommand = splitCommandLine(commandSpec);
  if (parsedCommand.length === 0) {
    throw new Error(
      "OPEN_FRONTIER_AGENT_LLM_COMMAND did not contain a command.",
    );
  }
  const envArgs = parseCommandArgs(
    options.args ?? process.env.OPEN_FRONTIER_AGENT_LLM_ARGS ?? [],
  );
  const [command, ...inlineArgs] = parsedCommand;
  return commandComplete({
    command,
    args: [...inlineArgs, ...envArgs],
    timeoutMs: options.timeoutMs,
    cwd: options.cwd,
  });
}

export function commandComplete(options = {}) {
  const command = options.command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error(
      "A non-empty command is required for command-backed LLM completion.",
    );
  }
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  const timeoutMs = normalizeProviderTimeoutMs(
    options.timeoutMs ??
      process.env.OPEN_FRONTIER_AGENT_LLM_TIMEOUT_MS ??
      120_000,
  );
  const cwd =
    options.cwd ?? process.env.OPEN_FRONTIER_AGENT_LLM_CWD ?? process.cwd();
  return async (prompt) => {
    const prepared = prepareCommandInvocation(args, prompt);
    try {
      return await runCompletionCommand({
        command,
        args: prepared.args,
        prompt: prepared.stdinPrompt,
        timeoutMs,
        cwd,
        outputFilePath: prepared.outputFilePath,
      });
    } finally {
      cleanupTempFile(prepared.promptFilePath);
      cleanupTempFile(prepared.outputFilePath);
    }
  };
}

function codexCliCompleteFromEnv(options = {}) {
  if (options.command ?? process.env.OPEN_FRONTIER_AGENT_LLM_COMMAND) {
    return commandCompleteFromEnv(options);
  }
  const command =
    options.codexCommand ??
    process.env.CODEX_COMMAND ??
    process.env.AI_LEAGUE_CODEX_COMMAND ??
    "codex";
  const model =
    options.model ??
    process.env.OPEN_FRONTIER_AGENT_LLM_MODEL ??
    process.env.AI_LEAGUE_CODEX_MODEL;
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    "{{outputFile}}",
  ];
  if (model) args.push("-m", model);
  args.push("-");
  return commandComplete({
    command,
    args,
    timeoutMs:
      options.timeoutMs ??
      process.env.OPEN_FRONTIER_AGENT_LLM_TIMEOUT_MS ??
      process.env.AI_LEAGUE_CODEX_TIMEOUT_MS ??
      180_000,
    cwd: options.cwd,
  });
}

function claudeCommandCompleteFromEnv(provider, options = {}) {
  if (options.command ?? process.env.OPEN_FRONTIER_AGENT_LLM_COMMAND) {
    return commandCompleteFromEnv(options);
  }
  const command =
    options.claudeCommand ??
    process.env.CLAUDE_COMMAND ??
    (provider === "claude-cowork" ? "claude" : "claude");
  return commandComplete({
    command,
    args: ["-p", "{{prompt}}"],
    timeoutMs: options.timeoutMs,
    cwd: options.cwd,
  });
}

function normalizeLlmProvider(value) {
  const provider = String(value ?? "")
    .trim()
    .toLowerCase();
  if (provider === "") return "";
  if (["codex", "codex-cli", "codex_cli"].includes(provider))
    return "codex-cli";
  if (["claude", "claude-cli", "claude_cli"].includes(provider)) {
    return "claude-cli";
  }
  if (
    [
      "claude-cowork",
      "claude_cowork",
      "cowork",
      "cowork-cli",
      "cowork_cli",
    ].includes(provider)
  ) {
    return "claude-cowork";
  }
  if (["command", "cli", "local-command", "local_cli"].includes(provider)) {
    return "command";
  }
  if (["openrouter", "open-router"].includes(provider)) return "openrouter";
  return provider;
}

function parseCommandArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value ?? "").trim();
  if (text === "") return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => typeof item === "string")
    ) {
      throw new Error(
        "OPEN_FRONTIER_AGENT_LLM_ARGS must be a JSON string array.",
      );
    }
    return parsed;
  }
  return splitCommandLine(text);
}

function splitCommandLine(input) {
  const result = [];
  let current = "";
  let quote = null;
  const text = String(input);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      if (
        next !== undefined &&
        (next === "\\" || next === '"' || next === "'" || /\s/.test(next))
      ) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    throw new Error(
      "Unclosed quote in OPEN_FRONTIER_AGENT_LLM_COMMAND or ARGS.",
    );
  }
  if (current !== "") result.push(current);
  return result;
}

function prepareCommandInvocation(args, prompt) {
  let usesPromptPlaceholder = false;
  let promptFilePath = null;
  let outputFilePath = null;
  const materialized = args.map((arg) => {
    let value = arg;
    if (value.includes("{{prompt}}")) {
      usesPromptPlaceholder = true;
      value = value.replaceAll("{{prompt}}", prompt);
    }
    if (value.includes("{{promptFile}}")) {
      usesPromptPlaceholder = true;
      promptFilePath ??= writeTempTextFile("open-frontier-prompt", prompt);
      value = value.replaceAll("{{promptFile}}", promptFilePath);
    }
    if (value.includes("{{outputFile}}")) {
      outputFilePath ??= tempFilePath("open-frontier-llm-output");
      value = value.replaceAll("{{outputFile}}", outputFilePath);
    }
    return value;
  });
  return {
    args: materialized,
    stdinPrompt: usesPromptPlaceholder ? "" : prompt,
    promptFilePath,
    outputFilePath,
  };
}

function tempFilePath(prefix) {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
}

function writeTempTextFile(prefix, text) {
  const filePath = tempFilePath(prefix);
  fs.writeFileSync(filePath, text, "utf8");
  return filePath;
}

function cleanupTempFile(filePath) {
  if (filePath === null || filePath === undefined) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best effort only; temp files should not block an agent decision.
  }
}

function runCompletionCommand({
  command,
  args,
  prompt,
  timeoutMs,
  cwd,
  outputFilePath,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref?.();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Could not start LLM command ${command}: ${errorMessage(error)}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `LLM command exited with ${signal ?? code}: ${stderr.trim().slice(0, 600) || stdout.trim().slice(0, 600) || "no output"}`,
          ),
        );
        return;
      }
      let finalOutput = "";
      if (outputFilePath !== null && outputFilePath !== undefined) {
        try {
          finalOutput = fs.readFileSync(outputFilePath, "utf8");
        } catch {
          finalOutput = "";
        }
      }
      resolve((finalOutput.trim() || stdout.trim()).trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

function normalizeProviderTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 120_000;
  return Math.max(1_000, Math.min(600_000, Math.round(parsed)));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
