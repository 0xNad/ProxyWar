// Proxy War Coworld KEYSTONE policy player.
//
// Runs the in-house Commander–Executor v2 agent (PlannerExecutorAgentBrain with
// binding directives) as a Coworld websocket policy. The decision path is the
// canonical one: the game offers AgentObservation + LegalAction[] over the
// /player websocket and this player only ever answers with one offered
// LegalAction.id — the game side re-validates through AgentDecisionValidator.
// No raw intents, no second validator, no new runner.
//
// In-clock guarantee: the executor answers every decision_request from the
// current Strategic Directive without awaiting any LLM call. Commander (LLM)
// refreshes run in the background between decisions (DeferredAgentPlanner), so
// Coworld's max_decision_ms reject-on-timeout is structurally satisfied.
//
// Coworld's wire carries ONE selectedLegalActionId per decision. The default
// remains the v16 frontier executor; a same-image treatment can opt into the
// sequential single-action conversion executor instead of dropping batch tails.
//
// Modes (PROXYWAR_KEYSTONE_MODE; DEFAULT = the LLM Commander — bedrock when
// USE_BEDROCK=true, otherwise claude-cli; "the agent" IS the LLM brain):
//   claude-cli local default — Claude CLI subscription via AI_LEAGUE_CLAUDE_*.
//              Fails loud if the CLI is missing/logged out (no silent rule bot).
//   bedrock    hosted default under --use-bedrock pods (USE_BEDROCK=true) —
//              Claude on Bedrock, inference on Softmax's service account
//              (payer confirmed 2026-06-10).
//   mock       MockLlmPlanner protocol-test plumbing only. Never a seat.
//
// There is deliberately NO deterministic/executor mode. Operator rule
// (2026-06-10, permanent): never run, default to, or suggest a deterministic
// executor as the agent or a seat. LLM failures must be loud (thrown or
// llmPlannerDegraded on the wire), never silently absorbed by a rule bot.
//
// Env (all optional unless noted):
//   COWORLD_PLAYER_WS_URL        required at runtime (set by the platform)
//   PROXYWAR_REPO                repo root inside the pod (default /app/proxywar)
//   PROXYWAR_KEYSTONE_MODE       see above (default: LLM Commander)
//   PROXYWAR_KEYSTONE_PROFILE    strategy profile (default "aggressive")
//   PROXYWAR_KEYSTONE_PLAN_EVERY Commander cadence in decision steps (default 3)
//   PROXYWAR_KEYSTONE_SINGLE_ACTION  1/true arms Coworld sequential conversion
//   PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW  1/true observes four-expert council
//   PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD  1/true arms request/all-break treatment
//   PROXYWAR_KEYSTONE_EXPERT_MASK  Council expert bitmask 0..15 (default 15)
//   PROXYWAR_LLM_MODEL_ID / AWS_REGION / PROXYWAR_LLM_TIMEOUT_MS  bedrock mode

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  AgentExecutor,
  AgentPlanDecision,
  AgentPlanner,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentObservation,
  AgentStrategyProfile,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import type { LlmProvider } from "../../src/server/agents/LlmProvider";
import {
  KEYSTONE_SHADOW_COUNCIL_METADATA_KEY,
  KEYSTONE_SHADOW_COUNCIL_METADATA_MAX_BYTES,
  KeystoneShadowCouncilExecutor,
  KeystoneShadowCouncilTelemetryAgentBrain,
} from "./keystone-shadow-council";
import { KeystoneSingleActionExecutor } from "./keystone-single-action-executor";

type PlannerExecutorModule =
  typeof import("../../src/server/agents/AgentPlannerExecutor");
type ClaudeCliModule =
  typeof import("../../src/server/agents/ClaudeCliLlmProvider");

export interface KeystoneModules {
  plannerExecutor: PlannerExecutorModule;
  claudeCli: ClaudeCliModule;
}

export type KeystoneMode = "mock" | "claude-cli" | "bedrock";

export interface KeystoneBrainOptions {
  mode: KeystoneMode;
  profile: AgentStrategyProfile;
  planEveryDecisionSteps?: number;
  providerTimeoutMs?: number;
  /** Override the LLM provider (tests / future transports). */
  provider?: LlmProvider;
  /**
   * Pure-blocking Commander: run the LLM planner synchronously on the wire
   * critical path (no DeferredAgentPlanner background refresh), so the bedrock
   * call's latency is visible and a bedrock failure is LOUD (thrown). Used to
   * definitively validate the LLM transport. Pair with planEveryDecisionSteps=1.
   */
  blocking?: boolean;
  /** Coworld-only, default-off sequential conversion treatment. */
  singleActionExecutor?: boolean;
  /** Coworld-only, default-off four-expert shadow telemetry. */
  expertCouncilShadow?: boolean;
  /** Coworld-only, default-off proactive-request and all-break treatment. */
  councilPoliticsGuard?: boolean;
  /** Council expansion/economy/conquest/politics bitmask; default 15. */
  expertMask?: number;
}

// Mirrors the league-smoke planner-claude-cli executor settings so local play
// and the Coworld seat run the same tuned executor.
export const KEYSTONE_EXECUTOR_SETTINGS = {
  territoryFirstNeutralLandEnabled: true,
  maxActionsPerDecision: 5,
  siloTileShareRatio: 0.14,
  samTileShareRatio: 0.14,
} as const;

/**
 * Keystone behavior-flag env plumbing (K1/K2 of plan keen-sparking-hollerith).
 * The executor reads these `PROXYWAR_TUNE_*` variables directly from process.env
 * at decision time (src/server/agents/AgentTunables.ts), and keystone-player runs
 * the executor in-process — so a hosted pod env carrying any of these reaches the
 * policy with no further wiring. DEFAULTS ALL OFF IN CODE: nothing here (or in the
 * repo defaults) sets a value, so the hosted policy ships inert and an arm is
 * enabled later via the pod env only after the local forge A/B verdict. The
 * explicit allowlist + boot-log summary exist so which arm a pod ran is auditable
 * from its logs instead of inferred.
 */
/** One-line boot-log summary of which keystone behavior flags the pod env set —
 *  "tunables=defaults" when none are, i.e. the shipped all-off configuration.
 *  Scans the PROXYWAR_TUNE_ prefix rather than an allowlist: the executor reads
 *  ~30 tunables (booleans in AgentTunables.ts plus tunedNumber numerics), and a
 *  stale allowlist meant a pod could run non-default behavior while logging
 *  "tunables=defaults" — defeating the audit purpose of this line. */
export function keystoneTunableFlagSummary(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const set = Object.keys(env)
    .filter(
      (name) =>
        name.startsWith("PROXYWAR_TUNE_") && (env[name] ?? "").trim() !== "",
    )
    .sort()
    .map((name) => `${name}=${env[name]?.trim()}`);
  return set.length === 0 ? "tunables=defaults" : `tunables=[${set.join(",")}]`;
}

const RESPONSE_REASON_MAX_LENGTH = 500;
// The hosted game-side mirror retains the first 1,000 serialized characters.
// Keep the complete decision response below that boundary for schema-valid
// Coworld request/action IDs so health flags and Commander telemetry cannot be
// separated from the selected action by JSON escaping or a long reason.
const RESPONSE_SERIALIZED_MAX_LENGTH = 999;

export function keystoneModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeystoneMode {
  const raw = env.PROXYWAR_KEYSTONE_MODE?.trim().toLowerCase() ?? "";
  if (raw === "mock" || raw === "claude-cli" || raw === "bedrock") {
    return raw;
  }
  if (raw !== "") {
    throw new Error(
      `Unknown PROXYWAR_KEYSTONE_MODE "${raw}" (expected mock|claude-cli|bedrock; ` +
        `there is no deterministic mode by design — the agent is the LLM brain)`,
    );
  }
  // Default = the LLM Commander. "The agent" IS the LLM brain (operator
  // standing rule, permanent) — there is no deterministic mode to fall back
  // to. Hosted --use-bedrock pods set USE_BEDROCK=true (inference on
  // Softmax's service account, payer confirmed 2026-06-10); everywhere else
  // the Claude CLI subscription is the default and fails loud if unavailable.
  return env.USE_BEDROCK === "true" ? "bedrock" : "claude-cli";
}

export function keystoneSingleActionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.PROXYWAR_KEYSTONE_SINGLE_ACTION?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "0" || raw === "false") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  throw new Error(
    `Unknown PROXYWAR_KEYSTONE_SINGLE_ACTION "${raw}" (expected 0|1|false|true)`,
  );
}

export function keystoneExpertCouncilShadowFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw =
    env.PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "0" || raw === "false") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  throw new Error(
    `Unknown PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW "${raw}" (expected 0|1|false|true)`,
  );
}

export function keystoneCouncilPoliticsGuardFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw =
    env.PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "0" || raw === "false") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  throw new Error(
    `Unknown PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD "${raw}" (expected 0|1|false|true)`,
  );
}

export function keystoneExpertMaskFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PROXYWAR_KEYSTONE_EXPERT_MASK?.trim() ?? "";
  if (raw === "") {
    return 15;
  }
  if (!/^(?:[0-9]|1[0-5])$/.test(raw)) {
    throw new Error(
      `Invalid PROXYWAR_KEYSTONE_EXPERT_MASK "${raw}" (expected decimal integer 0..15)`,
    );
  }
  return Number(raw);
}

/**
 * Loads the repo agent modules from PROXYWAR_REPO at runtime. The adapter and
 * the repo live in different directories inside the pod (/app/integration vs
 * /app/proxywar), so these imports must stay dynamic; the type-only imports
 * above are erased by tsx and never resolve at runtime.
 */
export async function loadKeystoneModules(
  repoRoot: string,
): Promise<KeystoneModules> {
  const agentsDir = path.join(repoRoot, "src", "server", "agents");
  const plannerExecutor = (await import(
    pathToFileURL(path.join(agentsDir, "AgentPlannerExecutor.ts")).href
  )) as PlannerExecutorModule;
  const claudeCli = (await import(
    pathToFileURL(path.join(agentsDir, "ClaudeCliLlmProvider.ts")).href
  )) as ClaudeCliModule;
  return { plannerExecutor, claudeCli };
}

/**
 * Reconstructs the canonical AgentBrainInput from the wire payload the game
 * built with buildExternalAgentRequestPayload. The observation passes through
 * verbatim; legal actions arrive without their server-side intent (the runner
 * keeps intents — policies never see or emit raw intents), so intent is null
 * here and the brain selects purely by id/kind/risk/metadata.
 */
export function requestToBrainInput(
  request: unknown,
  pinnedProfile?: AgentStrategyProfile,
): AgentBrainInput {
  const record = request as {
    observation?: AgentObservation;
    legalActions?: Array<{
      id?: unknown;
      kind?: unknown;
      label?: unknown;
      risk?: LegalAction["risk"];
      metadata?: LegalAction["metadata"];
    }>;
  };
  if (record === null || typeof record !== "object" || !record.observation) {
    throw new Error("decision_request payload is missing observation");
  }
  const rawActions = Array.isArray(record.legalActions)
    ? record.legalActions
    : [];
  if (rawActions.length === 0) {
    throw new Error("decision_request payload contained no legalActions");
  }
  const legalActions: LegalAction[] = rawActions.map((action) => ({
    id: String(action.id ?? ""),
    kind: String(action.kind ?? "hold") as LegalAction["kind"],
    label: String(action.label ?? ""),
    intent: null,
    risk: action.risk ?? { level: "medium", score: 0.5 },
    metadata: action.metadata,
  }));
  // Profile pin (v9 finding, 2026-07-12 A/B game2): the GAME side assigns a
  // strategy profile per seat slot, so the same keystone build played
  // "aggressive" in one slot and "diplomatic" in another — the Commander prompt
  // and module weights key off observation.profile, silently rotating the
  // agent's whole personality with its seat index. Keystone's stance is policy
  // config, not game state: pin it to OUR configured profile so behavior is
  // slot-invariant. Game state is untouched.
  const observation =
    pinnedProfile !== undefined && record.observation.profile !== pinnedProfile
      ? { ...record.observation, profile: pinnedProfile }
      : record.observation;
  return { observation, legalActions };
}

export function decisionToResponse(
  requestID: string,
  decision: AgentDecision,
): Record<string, unknown> {
  const rawConfidence = decision.metadata?.confidence;
  const confidence =
    typeof rawConfidence === "number" &&
    rawConfidence >= 0 &&
    rawConfidence <= 1
      ? rawConfidence
      : 0.7;
  // Degradation flags travel on the wire so the game-side artifacts can
  // record them — a dead/degraded LLM brain must never look healthy in
  // replays (the hosted proxywar-bedrock seat failed silently for 60+ rounds
  // because the transport had no loudness channel).
  const llmPlannerDegraded = decision.metadata?.llmPlannerDegraded === true;
  const plannerFallbackUsed = decision.metadata?.plannerFallbackUsed === true;
  // Truthful artifacts: the Coworld wire carries ONE selectedLegalActionId,
  // so when the executor scheduled a cascade batch, only the primary executes.
  // Without this note, decisions.jsonl reads "queued N action(s)" for actions
  // that never ran.
  const droppedBatchActions = Array.isArray(decision.actionIDs)
    ? Math.max(0, decision.actionIDs.length - 1)
    : 0;
  const wireNote =
    droppedBatchActions > 0
      ? ` [wire carries primary only; ${droppedBatchActions} batched follow-up(s) not executed]`
      : "";
  const commanderTelemetry = commanderTelemetryForWire(decision.metadata);
  const shadowCouncilTelemetry = shadowCouncilTelemetryForWire(
    decision.metadata,
  );
  const responsePrefix = {
    type: "decision_response",
    requestID,
    selectedLegalActionId: decision.actionID,
    ...commanderTelemetry,
    ...shadowCouncilTelemetry,
    confidence,
    ...(llmPlannerDegraded ? { llmPlannerDegraded: true } : {}),
    ...(plannerFallbackUsed ? { fallbackUsed: true } : {}),
  };
  const wireReason = boundedWireReason(
    responsePrefix,
    decision.reason,
    wireNote,
  );
  return {
    // Keep every protocol/health/telemetry field before `reason`. The hosted
    // game-side mirror retains only the first 1,000 serialized characters, and
    // the reason is the only field that may be shortened to fit that contract.
    ...responsePrefix,
    reason: wireReason,
  };
}

const SHADOW_COUNCIL_COMPACT_KEYS = new Set([
  "v",
  "o",
  "g",
  "x",
  "h",
  "p",
  "e",
  "j",
  "w",
  "r",
  "d",
  "m",
  "a",
  "s",
  "k",
  "u",
]);

function shadowCouncilTelemetryForWire(
  metadata: AgentDecision["metadata"],
): Record<string, unknown> {
  const raw = metadata?.[KEYSTONE_SHADOW_COUNCIL_METADATA_KEY];
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > KEYSTONE_SHADOW_COUNCIL_METADATA_MAX_BYTES
  ) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some(
        (key) => !SHADOW_COUNCIL_COMPACT_KEYS.has(key),
      ) ||
      parsed.v !== 1 ||
      !nonNegativeInteger(parsed.o) ||
      !nonNegativeInteger(parsed.g) ||
      (parsed.x !== 0 && parsed.x !== 1) ||
      !integerInRange(parsed.p, 0, 127) ||
      !integerInRange(parsed.e, 0, 127) ||
      !integerInRange(parsed.j, 0, 2_047) ||
      !integerInRange(parsed.k, 0, 15) ||
      !nonNegativeInteger(parsed.u) ||
      !(parsed.m === null || integerInRange(parsed.m, -20_000, 20_000)) ||
      !["h", "p", "f", "u"].includes(String(parsed.h)) ||
      !["a", "d", "b", "u"].includes(String(parsed.a)) ||
      !integerInRange(parsed.s, 0, 8) ||
      !safeCompactFingerprint(parsed.w) ||
      !safeCompactFingerprint(parsed.r) ||
      !safeCompactFingerprint(parsed.d)
    ) {
      return {};
    }
    return { shadowCouncil: raw };
  } catch {
    return {};
  }
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function safeCompactFingerprint(value: unknown): boolean {
  return (
    typeof value === "string" && (value === "-" || /^[0-9a-f]{16}$/.test(value))
  );
}

function boundedWireReason(
  responsePrefix: Record<string, unknown>,
  reason: string,
  truthNote: string,
): string {
  const prefixLimit = Math.max(
    0,
    RESPONSE_REASON_MAX_LENGTH - truthNote.length,
  );
  const candidatePrefix = reason.slice(0, prefixLimit);
  const serializedLength = (value: string) =>
    JSON.stringify({ ...responsePrefix, reason: value }).length;

  if (
    serializedLength(candidatePrefix + truthNote) <=
    RESPONSE_SERIALIZED_MAX_LENGTH
  ) {
    return candidatePrefix + truthNote;
  }

  // JSON escaping is data-dependent, so raw string length is not a safe
  // budget. Binary-search the longest source prefix whose serialized response
  // fits, keeping the truthful dropped-batch suffix intact.
  if (serializedLength(truthNote) <= RESPONSE_SERIALIZED_MAX_LENGTH) {
    let low = 0;
    let high = candidatePrefix.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        serializedLength(candidatePrefix.slice(0, middle) + truthNote) <=
        RESPONSE_SERIALIZED_MAX_LENGTH
      ) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return candidatePrefix.slice(0, low) + truthNote;
  }

  // Valid Coworld request/action IDs leave ample room for the short truth
  // note. This defensive branch handles malformed oversized identifiers
  // without throwing; protocol-critical fields still precede the reason.
  let low = 0;
  let high = truthNote.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      serializedLength(truthNote.slice(0, middle)) <=
      RESPONSE_SERIALIZED_MAX_LENGTH
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return truthNote.slice(0, low);
}

const COMMANDER_TELEMETRY_WIRE_KEYS = [
  ["commanderTelemetryVersion", "v"],
  ["commanderRefreshAttempts", "attempts"],
  ["commanderRefreshCompletions", "completions"],
  ["commanderHealthyCompletions", "healthy"],
  ["commanderFallbackCompletions", "fallback"],
  ["commanderInvalidOutputCompletions", "invalidOutput"],
  ["commanderNoOutputFailureCompletions", "noOutputFailure"],
  ["commanderRejectedCompletions", "rejected"],
  ["commanderCoalescedRefreshes", "coalesced"],
  ["commanderPlansDelivered", "delivered"],
  ["commanderRefreshInFlight", "inFlight"],
  ["commanderLastOutcome", "lastOutcome"],
  ["commanderActivePlanGeneratedAtTurn", "planTurn"],
  ["commanderActivePlanAgeTurns", "planAge"],
  ["commanderDeliveredPlanCriticalEpochChanged", "criticalEpochChanged"],
] as const;

function commanderTelemetryForWire(
  metadata: AgentDecision["metadata"],
): Record<string, unknown> {
  if (metadata?.commanderTelemetryVersion !== 1) {
    return {};
  }
  const telemetry: Record<string, string | number | boolean | null> = {};
  for (const [metadataKey, wireKey] of COMMANDER_TELEMETRY_WIRE_KEYS) {
    const value = metadata[metadataKey];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      telemetry[wireKey] = value;
    }
  }
  return { commanderTelemetry: telemetry };
}

/**
 * Last-resort transport fallback. When the brain (or payload reconstruction)
 * throws, the match must not stall — but the resulting decision is DEGRADED and
 * MUST be loud. This routes through decisionToResponse with a synthesized
 * degraded AgentDecision so the wire carries fallbackUsed + llmPlannerDegraded
 * (matching llm-player.mjs). A dead/degraded brain must never look healthy in
 * replays — the v1 bedrock seat played 60+ hosted rounds on a silent fallback
 * because this branch had no loudness channel. Prefers an offered hold action
 * (lowest-risk no-op) over blindly taking legalActions[0].
 */
export function transportFallbackResponse(
  requestID: string,
  request: unknown,
  errorMessage: string,
): Record<string, unknown> {
  const actions =
    (request as { legalActions?: Array<{ id?: unknown; kind?: unknown }> })
      ?.legalActions ?? [];
  const holdAction = actions.find((action) => action.kind === "hold");
  const fallbackActionID = String((holdAction ?? actions[0])?.id ?? "");
  return decisionToResponse(requestID, {
    actionID: fallbackActionID,
    reason: `keystone transport fallback: ${errorMessage}`,
    metadata: {
      confidence: 0.3,
      fallbackUsed: true,
      plannerFallbackUsed: true,
      llmPlannerDegraded: true,
    },
  });
}

/**
 * In-clock Commander adapter. plan() never awaits the wrapped LLM planner:
 * it returns the freshest completed background refresh if one landed,
 * otherwise carries the current directive (or a rule bootstrap plan before the
 * first refresh lands) and kicks the real refresh off in the background.
 * LLM failures surface loudly via llmPlannerDegraded on the next plan() —
 * never a silent degrade.
 */
export class DeferredAgentPlanner implements AgentPlanner {
  readonly plannerType: StrategicPlan["plannerSource"];
  private inFlight = false;
  private completed: DeferredPlanEnvelope | null = null;
  private lastKnownPlan: StrategicPlan | null = null;
  // Set when a background Commander refresh failed but there was no plan to attach
  // the degraded flags to (no standing directive AND the bootstrap also failed).
  // The next plan() surfaces it so the degradation is never silent.
  private pendingDegradation: string | null = null;
  private refreshAttempts = 0;
  private refreshCompletions = 0;
  private healthyCompletions = 0;
  private fallbackCompletions = 0;
  private invalidOutputCompletions = 0;
  private noOutputFailureCompletions = 0;
  private rejectedCompletions = 0;
  private coalescedRefreshes = 0;
  private plansDelivered = 0;
  private lastOutcome: CommanderRefreshOutcome = "none";
  private activePlanGeneratedAtTurn: number | null = null;
  private activePlanObservationEpoch: string | null = null;
  private deliveredPlanCriticalEpochChanged = false;

  constructor(
    private readonly inner: AgentPlanner,
    private readonly bootstrap: AgentPlanner,
  ) {
    this.plannerType = inner.plannerType;
  }

  async plan(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
  ): Promise<AgentPlanDecision> {
    if (this.completed !== null) {
      const landed = this.completed;
      this.completed = null;
      this.lastKnownPlan = landed.decision.plan;
      this.plansDelivered += 1;
      this.activePlanGeneratedAtTurn = landed.generatedAtTurn;
      this.activePlanObservationEpoch = landed.observationEpoch;
      this.deliveredPlanCriticalEpochChanged =
        landed.observationEpoch !== null &&
        landed.observationEpoch !== commanderObservationEpoch(input);
      // Arm the NEXT refresh against the current observation before returning.
      // Without this, refreshes only ever started on calls that arrived
      // empty-handed, which silently halved the Commander cadence to
      // 2x planEvery and executed every landed plan one interval stale.
      this.startBackgroundRefresh(input, landed.decision.plan);
      return landed.decision;
    }
    // Surface (once) any degradation from a prior refresh failure that had no
    // plan to carry it.
    const degraded = this.pendingDegradation;
    this.pendingDegradation = null;
    const carriedPlan = previousPlan ?? this.lastKnownPlan;
    this.startBackgroundRefresh(input, carriedPlan);
    if (carriedPlan !== null) {
      return {
        plan: carriedPlan,
        reason:
          degraded !== null
            ? `Commander refresh failed (${degraded}); executing the standing directive degraded.`
            : "Commander refresh in flight; executing the standing directive in-clock.",
        latencyMs: 0,
        fallbackUsed: degraded !== null,
        ...(degraded !== null ? { llmPlannerDegraded: true } : {}),
      };
    }
    const bootstrapDecision = await this.bootstrap.plan(input, previousPlan);
    this.lastKnownPlan = bootstrapDecision.plan;
    return {
      ...bootstrapDecision,
      reason:
        degraded !== null
          ? `Bootstrap plan after a Commander refresh failed (${degraded}); running degraded.`
          : `Bootstrap plan while the first Commander refresh is in flight: ${bootstrapDecision.reason}`,
      fallbackUsed: degraded !== null ? true : bootstrapDecision.fallbackUsed,
      ...(degraded !== null ? { llmPlannerDegraded: true } : {}),
    };
  }

  telemetrySnapshot(input: AgentBrainInput): CommanderTelemetrySnapshot {
    const currentTurn = input.observation.turnNumber;
    return {
      commanderTelemetryVersion: 1,
      commanderRefreshAttempts: this.refreshAttempts,
      commanderRefreshCompletions: this.refreshCompletions,
      commanderHealthyCompletions: this.healthyCompletions,
      commanderFallbackCompletions: this.fallbackCompletions,
      commanderInvalidOutputCompletions: this.invalidOutputCompletions,
      commanderNoOutputFailureCompletions: this.noOutputFailureCompletions,
      commanderRejectedCompletions: this.rejectedCompletions,
      commanderCoalescedRefreshes: this.coalescedRefreshes,
      commanderPlansDelivered: this.plansDelivered,
      commanderRefreshInFlight: this.inFlight,
      commanderLastOutcome: this.lastOutcome,
      commanderActivePlanGeneratedAtTurn: this.activePlanGeneratedAtTurn,
      commanderActivePlanAgeTurns:
        this.activePlanGeneratedAtTurn === null
          ? null
          : Math.max(0, currentTurn - this.activePlanGeneratedAtTurn),
      commanderDeliveredPlanCriticalEpochChanged:
        this.activePlanObservationEpoch === null
          ? false
          : this.deliveredPlanCriticalEpochChanged,
    };
  }

  private startBackgroundRefresh(
    input: AgentBrainInput,
    carriedPlan: StrategicPlan | null,
  ): void {
    if (this.inFlight) {
      this.coalescedRefreshes += 1;
      return;
    }
    const generatedAtTurn = input.observation.turnNumber;
    const observationEpoch = commanderObservationEpoch(input);
    this.refreshAttempts += 1;
    this.inFlight = true;
    void this.inner
      .plan(input, carriedPlan)
      .then((decision) => {
        this.recordResolvedCompletion(decision);
        this.completed = { decision, generatedAtTurn, observationEpoch };
      })
      .catch(async (error: unknown) => {
        this.refreshCompletions += 1;
        this.rejectedCompletions += 1;
        this.lastOutcome = "rejected";
        const message = error instanceof Error ? error.message : String(error);
        console.error(`keystone Commander refresh failed: ${message}`);
        const fallback =
          carriedPlan !== null
            ? null
            : await this.bootstrap.plan(input, null).catch(() => null);
        const plan = carriedPlan ?? fallback?.plan ?? null;
        if (plan !== null) {
          const carriedPlanRetained = carriedPlan !== null;
          this.completed = {
            decision: {
              // Mark the plan itself as degraded-origin: the executor then flags
              // EVERY decision run under it (not just this refresh) until a
              // healthy Commander refresh replaces it.
              plan: { ...plan, degradedOrigin: true },
              reason: `Commander refresh failed (${message}); continuing on the standing directive.`,
              latencyMs: 0,
              fallbackUsed: true,
              llmPlannerDegraded: true,
            },
            // A failed refresh does not author a new standing directive. When
            // the old plan is retained, preserve its original observation
            // provenance so plan age keeps increasing honestly.
            generatedAtTurn: carriedPlanRetained
              ? this.activePlanGeneratedAtTurn
              : generatedAtTurn,
            observationEpoch: carriedPlanRetained
              ? this.activePlanObservationEpoch
              : observationEpoch,
          };
        } else {
          // No standing directive and the bootstrap also failed: we cannot
          // fabricate a plan, but the degradation must not be silent — flag it so
          // the next plan() (which re-attempts the bootstrap) surfaces it.
          this.pendingDegradation = message;
        }
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  private recordResolvedCompletion(decision: AgentPlanDecision): void {
    this.refreshCompletions += 1;
    if (decision.fallbackUsed || decision.llmPlannerDegraded === true) {
      this.fallbackCompletions += 1;
      // LlmAgentPlanner uses parseOk=false for both malformed model output and
      // provider/runtime failures. Raw output is the only honest discriminator
      // available at this seam: non-empty output means invalid output; absence
      // remains deliberately broad (provider, timeout, auth, runtime, or empty).
      if (decision.parseOk === false) {
        if ((decision.rawPlannerOutput?.trim().length ?? 0) > 0) {
          this.invalidOutputCompletions += 1;
          this.lastOutcome = "invalid_output";
        } else {
          this.noOutputFailureCompletions += 1;
          this.lastOutcome = "failure_no_output";
        }
      } else {
        this.lastOutcome = "fallback";
      }
      return;
    }
    this.healthyCompletions += 1;
    this.lastOutcome = "healthy";
  }
}

type CommanderRefreshOutcome =
  | "none"
  | "healthy"
  | "fallback"
  | "invalid_output"
  | "failure_no_output"
  | "rejected";

interface DeferredPlanEnvelope {
  decision: AgentPlanDecision;
  generatedAtTurn: number | null;
  observationEpoch: string | null;
}

export interface CommanderTelemetrySnapshot {
  commanderTelemetryVersion: 1;
  commanderRefreshAttempts: number;
  commanderRefreshCompletions: number;
  commanderHealthyCompletions: number;
  commanderFallbackCompletions: number;
  commanderInvalidOutputCompletions: number;
  commanderNoOutputFailureCompletions: number;
  commanderRejectedCompletions: number;
  commanderCoalescedRefreshes: number;
  commanderPlansDelivered: number;
  commanderRefreshInFlight: boolean;
  commanderLastOutcome: CommanderRefreshOutcome;
  commanderActivePlanGeneratedAtTurn: number | null;
  commanderActivePlanAgeTurns: number | null;
  commanderDeliveredPlanCriticalEpochChanged: boolean;
}

function commanderObservationEpoch(input: AgentBrainInput): string {
  const alivePlayerIDs = input.observation.visiblePlayers
    .filter((player) => player.isAlive)
    .map((player) => player.playerID)
    .sort()
    .join(",");
  const incomingPlayerIDs = [
    ...input.observation.combat.incomingAttackPlayerIDs,
  ]
    .sort()
    .join(",");
  return [
    input.observation.phase,
    input.observation.ownState?.isAlive === false ? "eliminated" : "alive",
    `rivals=${alivePlayerIDs}`,
    `incoming=${incomingPlayerIDs}`,
  ].join("|");
}

export class CommanderTelemetryAgentBrain implements AgentBrain {
  readonly brainType: AgentBrain["brainType"];

  constructor(
    private readonly delegate: AgentBrain,
    private readonly deferredPlanner: DeferredAgentPlanner,
  ) {
    this.brainType = delegate.brainType;
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    const decision = await this.delegate.decide(input);
    return {
      ...decision,
      metadata: {
        ...(decision.metadata ?? {}),
        ...this.deferredPlanner.telemetrySnapshot(input),
      },
    };
  }
}

/**
 * Bedrock model-id candidates, tried in order until one answers. The original
 * single pin (anthropic.claude-3-5-sonnet-20240620-v1:0) reached end-of-life
 * on Bedrock and the hosted seat silently failed every call for 60+ rounds —
 * autodetect makes a retired/disabled id self-healing instead of fatal.
 * PROXYWAR_LLM_MODEL_ID (when set) is always tried first.
 *
 * PROXYWAR_LLM_MODEL_STRICT=1 (with a pinned id) disables the fall-through:
 * the pinned model is the ONLY candidate, so an unavailable id degrades the
 * seat loudly (llmPlannerDegraded on the wire) instead of silently playing a
 * different model. Required for model-labeled seats — a seat advertised as
 * model X must never quietly answer as model Y.
 */
export function bedrockModelCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.PROXYWAR_LLM_MODEL_ID && env.PROXYWAR_LLM_MODEL_STRICT === "1") {
    return [env.PROXYWAR_LLM_MODEL_ID];
  }
  return [
    ...(env.PROXYWAR_LLM_MODEL_ID ? [env.PROXYWAR_LLM_MODEL_ID] : []),
    // Confirmed enabled on the Softmax Bedrock account 2026-06-23 (us-east-1, us-west-2,
    // us-east-2). Haiku MUST be the full date-suffixed inference-profile id — the bare
    // "us.anthropic.claude-haiku-4-5" is not a valid inference-profile id and fails
    // validation; sonnet-4-5 is the bare model id (us-west-2), not a us.-prefixed profile.
    "us.anthropic.claude-sonnet-4-6",
    "global.anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-sonnet-4-5-20250929-v1:0",
  ];
}

/**
 * True when the error means "this model id is unusable on this account" —
 * retired, unknown, disabled, or needs an inference profile. Anything else
 * (auth, throttle, timeout) is NOT a reason to switch models.
 */
export function isModelUnavailableError(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("end of its life") ||
    text.includes("model identifier is invalid") ||
    text.includes("provided model identifier") ||
    text.includes("on-demand throughput") ||
    text.includes("not found") ||
    text.includes("not_found") ||
    text.includes("access to the model") ||
    text.includes("not authorized to invoke this model") ||
    text.includes("model is not supported") ||
    text.includes("use case details")
  );
}

type BedrockClientLike = {
  messages: {
    create: (
      body: Record<string, unknown>,
      options: { timeout: number },
    ) => Promise<{ content?: Array<{ text?: unknown }> }>;
  };
};

function createBedrockProvider(
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider {
  const candidates = bedrockModelCandidates(env);
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2";
  const timeoutMs = Number(env.PROXYWAR_LLM_TIMEOUT_MS ?? 12000);
  let client: BedrockClientLike | null = null;
  let lockedIndex: number | null = null;
  return {
    providerType: "custom",
    async complete(prompt: string): Promise<string> {
      if (client === null) {
        // Resolved at pod runtime only (adapter dependency); kept opaque so
        // vite/vitest never try to bundle it.
        const bedrockSpecifier = "@anthropic-ai/bedrock-sdk";
        const mod = (await import(/* @vite-ignore */ bedrockSpecifier)) as {
          default?: new (options: { awsRegion: string }) => BedrockClientLike;
          AnthropicBedrock?: new (options: {
            awsRegion: string;
          }) => BedrockClientLike;
        };
        const AnthropicBedrock = mod.default ?? mod.AnthropicBedrock;
        if (AnthropicBedrock === undefined) {
          throw new Error("@anthropic-ai/bedrock-sdk did not export a client");
        }
        client = new AnthropicBedrock({ awsRegion: region });
      }
      const startIndex = lockedIndex ?? 0;
      let lastError: unknown = null;
      for (let i = startIndex; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        try {
          const response = await client.messages.create(
            {
              model: candidate,
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
            },
            { timeout: timeoutMs },
          );
          if (lockedIndex !== i) {
            lockedIndex = i;
            console.log(`keystone bedrock model locked: ${candidate}`);
          }
          return (response?.content ?? [])
            .map((block) => (typeof block?.text === "string" ? block.text : ""))
            .join("")
            .trim();
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : error;
          if (isModelUnavailableError(message)) {
            console.error(
              `keystone bedrock model unavailable, trying next: ${candidate} -> ${String(message).slice(0, 160)}`,
            );
            continue;
          }
          throw error;
        }
      }
      throw new Error(
        `No Bedrock model candidate is usable on this account (tried ${candidates.join(", ")}): ${String(
          lastError instanceof Error ? lastError.message : lastError,
        ).slice(0, 200)}`,
      );
    },
  };
}

export function createKeystoneBrain(
  modules: KeystoneModules,
  options: KeystoneBrainOptions,
): AgentBrain {
  if (
    options.singleActionExecutor === true &&
    options.councilPoliticsGuard === true
  ) {
    throw new Error(
      "Keystone Council politics guard cannot be combined with the single-action executor treatment",
    );
  }
  const {
    PlannerExecutorAgentBrain,
    RuleAgentPlanner,
    MockLlmPlanner,
    LlmAgentPlanner,
    FrontierPolicyExecutor,
    actionFollowsCanonicalPlan,
    rankLegalActionsForExecution,
  } = modules.plannerExecutor;
  const planEveryDecisionSteps = options.planEveryDecisionSteps ?? 3;
  const authoritativeExecutor = options.singleActionExecutor
    ? new KeystoneSingleActionExecutor({
        profile: options.profile,
        settings: { ...KEYSTONE_EXECUTOR_SETTINGS },
        rankActions: rankLegalActionsForExecution,
        actionFollowsCanonicalPlan,
      })
    : new FrontierPolicyExecutor(options.profile, {
        settings: { ...KEYSTONE_EXECUTOR_SETTINGS },
      });
  let shadowCouncilExecutor: KeystoneShadowCouncilExecutor | null = null;
  let executor: AgentExecutor = authoritativeExecutor;
  if (
    options.expertCouncilShadow === true ||
    options.councilPoliticsGuard === true
  ) {
    shadowCouncilExecutor = new KeystoneShadowCouncilExecutor({
      delegate: authoritativeExecutor,
      actionFollowsCanonicalPlan,
      enabledExpertMask: options.expertMask ?? 15,
      observeAllDecisions: options.expertCouncilShadow === true,
      politicsGuardEnabled: options.councilPoliticsGuard === true,
    });
    executor = shadowCouncilExecutor;
  }

  let planner: AgentPlanner;
  let deferredPlanner: DeferredAgentPlanner | null = null;
  if (options.mode === "mock") {
    planner = new MockLlmPlanner(options.profile);
  } else {
    const provider =
      options.provider ??
      (options.mode === "claude-cli"
        ? modules.claudeCli.createClaudeCliLlmProviderFromEnv()
        : createBedrockProvider());
    const llmPlanner = new LlmAgentPlanner({
      provider,
      profile: options.profile,
      providerTimeoutMs: options.providerTimeoutMs,
      plannerType: "real-llm",
    });
    // Pure-blocking Commander: await the LLM planner directly so the bedrock call
    // sits on the wire critical path (visible latency, loud failures). Otherwise
    // the in-clock DeferredAgentPlanner refreshes it in the background.
    if (options.blocking) {
      planner = llmPlanner;
    } else {
      deferredPlanner = new DeferredAgentPlanner(
        llmPlanner,
        new RuleAgentPlanner(options.profile),
      );
      planner = deferredPlanner;
    }
  }

  const plannerExecutorBrain = new PlannerExecutorAgentBrain({
    profile: options.profile,
    planner,
    executor,
    planEveryDecisionSteps,
    ...(shadowCouncilExecutor === null
      ? {}
      : {
          // PlannerExecutor normally derives this with instanceof. Preserve
          // the wrapped authoritative executor's exact identity in shadow mode.
          executorSource: options.singleActionExecutor
            ? "coworld-single-action-v1"
            : "frontier-policy-executor",
        }),
  });
  const brain: AgentBrain =
    deferredPlanner === null
      ? plannerExecutorBrain
      : new CommanderTelemetryAgentBrain(plannerExecutorBrain, deferredPlanner);
  return shadowCouncilExecutor === null
    ? brain
    : new KeystoneShadowCouncilTelemetryAgentBrain(
        brain,
        shadowCouncilExecutor,
      );
}

function redactPlayerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "***");
    }
    return parsed.toString();
  } catch {
    return "<unparseable player url>";
  }
}

async function main(): Promise<void> {
  const url = process.env.COWORLD_PLAYER_WS_URL;
  if (!url) {
    throw new Error("COWORLD_PLAYER_WS_URL is required");
  }
  const repoRoot = process.env.PROXYWAR_REPO ?? "/app/proxywar";
  const mode = keystoneModeFromEnv();
  const singleActionExecutor = keystoneSingleActionFromEnv();
  const expertCouncilShadow = keystoneExpertCouncilShadowFromEnv();
  const councilPoliticsGuard = keystoneCouncilPoliticsGuardFromEnv();
  const expertMask = keystoneExpertMaskFromEnv();
  const profile = (process.env.PROXYWAR_KEYSTONE_PROFILE?.trim() ||
    "aggressive") as AgentStrategyProfile;
  const blocking =
    process.env.PROXYWAR_KEYSTONE_BLOCKING === "1" ||
    process.env.PROXYWAR_KEYSTONE_BLOCKING?.trim().toLowerCase() === "true";
  const planEveryRaw = Number(process.env.PROXYWAR_KEYSTONE_PLAN_EVERY ?? "3");
  // Blocking pure-Commander runs the LLM EVERY decision (planEvery=1) so every
  // wire decision is bedrock-driven and the transport is fully exercised.
  const planEveryDecisionSteps = blocking
    ? 1
    : Number.isFinite(planEveryRaw) && planEveryRaw >= 1
      ? Math.floor(planEveryRaw)
      : 3;

  const modules = await loadKeystoneModules(repoRoot);
  const brain = createKeystoneBrain(modules, {
    mode,
    profile,
    planEveryDecisionSteps,
    blocking,
    singleActionExecutor,
    expertCouncilShadow,
    councilPoliticsGuard,
    expertMask,
  });

  // Optional one-shot Bedrock diagnostic (gated; OFF in production). The pod
  // stderr 403s for us via the Coworld CLI, so this surfaces cred presence + the
  // real Bedrock error into every wire `reason` (which lands in the readable
  // decisions.jsonl). Splits "runner injected no creds" from "creds present but
  // failing" from "our request is malformed".
  let bedrockDiag = "";
  if (process.env.PROXYWAR_KEYSTONE_BEDROCK_DIAG === "1") {
    const resolvedRegion =
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
    const keyState = process.env.AWS_ACCESS_KEY_ID ? "set" : "MISSING";
    const tokenState = process.env.AWS_SESSION_TOKEN ? "set" : "absent";
    let probe: string;
    try {
      const out = await createBedrockProvider().complete(
        "Reply with the single word OK.",
      );
      probe = `OK:${out.slice(0, 24)}`;
    } catch (error) {
      probe = (error instanceof Error ? error.message : String(error)).slice(
        0,
        260,
      );
    }
    bedrockDiag = `BEDROCKDIAG[USE_BEDROCK=${process.env.USE_BEDROCK ?? "unset"} key=${keyState} token=${tokenState} AWS_REGION=${process.env.AWS_REGION ?? "unset"} resolved=${resolvedRegion} probe=${probe}]`;
    console.log(bedrockDiag);
  }

  const require = createRequire(import.meta.url);
  const { WebSocket } = require(`${repoRoot}/node_modules/ws`);
  const socket = new WebSocket(url);

  socket.on("open", () => {
    console.log(
      `keystone connected ${redactPlayerUrl(url)} (mode=${mode}, profile=${profile}, planEvery=${planEveryDecisionSteps}, blocking=${blocking}, executor=${singleActionExecutor ? "coworld-single-action" : "frontier"}, shadowCouncil=${expertCouncilShadow}, politicsGuard=${councilPoliticsGuard}, councilExpertMask=${expertMask}, ${keystoneTunableFlagSummary()})`,
    );
  });

  // Serialize decision handling: a platform retry that overlaps an in-flight
  // request must not interleave brain.decide() on shared mutable state
  // (decisionsSincePlan, opponent-ledger rising-edge counters).
  let decisionChain: Promise<void> = Promise.resolve();
  let sawFinal = false;
  socket.on("message", (data: unknown) => {
    let message: {
      type?: unknown;
      requestID?: unknown;
      request?: unknown;
    };
    try {
      message = JSON.parse(String(data));
    } catch (error) {
      // A malformed frame silently dropped looks like a seat timeout
      // platform-side — log it so the failure is attributable from pod logs.
      console.error(
        `keystone: dropping unparseable frame (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    if (message.type === "final") {
      sawFinal = true;
      console.log("episode final; exiting");
      socket.close();
      return;
    }
    if (message.type !== "decision_request") {
      return;
    }
    decisionChain = decisionChain.then(async () => {
      const requestID = String(message.requestID ?? "");
      const startedAt = Date.now();
      let response: Record<string, unknown>;
      try {
        const input = requestToBrainInput(message.request, profile);
        const decision = await brain.decide(input);
        response = decisionToResponse(requestID, decision);
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : String(error);
        console.error(`keystone decide failed: ${messageText}`);
        // Last-resort: degraded but LOUD — fallbackUsed + llmPlannerDegraded
        // travel on the wire so the game-side artifacts never report a dead
        // brain as healthy. See transportFallbackResponse.
        response = transportFallbackResponse(
          requestID,
          message.request,
          messageText,
        );
      }
      if (bedrockDiag) {
        response.reason = `${bedrockDiag} || ${String(response.reason ?? "")}`;
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 5000) {
        console.warn(
          `keystone decision took ${elapsedMs}ms — investigate before the clock bites`,
        );
      }
      socket.send(JSON.stringify(response));
    });
  });

  socket.on("close", () => {
    // A transport death mid-episode must not masquerade as a clean exit —
    // the platform (and our artifacts) should see the seat die loudly.
    if (!sawFinal) {
      console.error("keystone: websocket closed before the final message");
      process.exit(1);
    }
    process.exit(0);
  });

  socket.on("error", (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

const isMain = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
