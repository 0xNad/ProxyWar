import {
  MAX_COMMANDER_OPTION_ID_LENGTH,
  MAX_COMMANDER_PLAN_ATTACKER_IDS,
  MAX_COMMANDER_PLAYER_ID_LENGTH,
  MAX_COMMANDER_REQUEST_ID_LENGTH,
} from "./CommanderStateBuilder";
import { sanitizeUntrustedDisplayString } from "./PromptSanitizer";
import {
  commanderReplanTriggers,
  MAX_COMMANDER_HORIZON_DECISIONS,
  MAX_COMMANDER_INTENT_LENGTH,
  MIN_COMMANDER_HORIZON_DECISIONS,
  type CommanderPlanProgressSnapshot,
  type CommanderPlanSnapshot,
  type CommanderReplanTrigger,
  type CommanderResponseParseResult,
  type ExposedStrategicOption,
  type StrategicOptionFamily,
  type StrategicOptionId,
} from "./StrategicCommanderTypes";
import { MAX_EXPOSED_STRATEGIC_OPTIONS } from "./StrategicOptionBuilder";

/** Stage 2 fingerprints are 16 hex characters; the bound stays generous. */
export const MAX_COMMANDER_FINGERPRINT_LENGTH = 64;

/**
 * Alive ids are a membership probe that is never persisted into plan state, so
 * this bound only rejects pathological input rather than shaping the snapshot.
 */
export const MAX_COMMANDER_ALIVE_PLAYERS = 256;

/**
 * Nothing here reads a clock. Plan age is measured purely in decision cycles so
 * the lifecycle stays reproducible under replay and step-locked evaluation.
 */
export const commanderPlanDispositions = [
  "continue",
  "replan",
  "terminate",
] as const;

export type CommanderPlanDisposition =
  (typeof commanderPlanDispositions)[number];

export const commanderPlanContinueReasons = ["within_horizon"] as const;

export type CommanderPlanContinueReason =
  (typeof commanderPlanContinueReasons)[number];

export const commanderPlanReplanReasons = [
  "no_active_plan",
  "horizon_expiry",
  "home_danger_high",
  "option_appeared",
] as const;

export type CommanderPlanReplanReason =
  (typeof commanderPlanReplanReasons)[number];

export const commanderPlanTerminateReasons = [
  "no_exposed_options",
  "game_mismatch",
  "agent_mismatch",
  "decision_sequence_regressed",
  "option_no_longer_offered",
  "target_eliminated",
] as const;

export type CommanderPlanTerminateReason =
  (typeof commanderPlanTerminateReasons)[number];

export type CommanderPlanEvaluationReason =
  | CommanderPlanContinueReason
  | CommanderPlanReplanReason
  | CommanderPlanTerminateReason;

export const commanderPlanSelectors = ["commander", "fallback"] as const;

export type CommanderPlanSelector = (typeof commanderPlanSelectors)[number];

/** Why a Commander result was not the authority for the installed plan. */
export const commanderPlanFallbackReasons = [
  "commander_result_absent",
  "commander_response_invalid",
  "commander_request_mismatch",
  "commander_result_stale",
  "commander_option_not_exposed",
] as const;

export type CommanderPlanFallbackReason =
  (typeof commanderPlanFallbackReasons)[number];

/** The specific binding that failed, checked before any plan replacement. */
export const commanderPlanRejectionCodes = [
  "response_invalid",
  "game_id_mismatch",
  "agent_id_mismatch",
  "decision_sequence_stale",
  "decision_sequence_mismatch",
  "turn_number_mismatch",
  "tick_mismatch",
  "exposed_option_ids_mismatch",
  "option_set_fingerprint_mismatch",
  "material_state_fingerprint_mismatch",
  "option_not_exposed",
] as const;

export type CommanderPlanRejectionCode =
  (typeof commanderPlanRejectionCodes)[number];

export interface CommanderPlanRejection {
  code: CommanderPlanRejectionCode;
  detail: string;
}

export const commanderResponseDispositions = [
  "absent",
  "applied",
  "rejected",
  "ignored_while_continuing",
] as const;

export type CommanderResponseDisposition =
  (typeof commanderResponseDispositions)[number];

/**
 * The exact identity a Commander call was bound to. Every field is compared
 * before a response may replace the active plan.
 */
export interface CommanderRequestIdentity {
  gameID: string;
  agentID: string;
  decisionSequence: number;
  turnNumber: number;
  tick: number | null;
  exposedOptionIDs: StrategicOptionId[];
  exposedOptionSetFingerprint: string;
  materialStateFingerprint: string;
}

export interface CommanderPlanRequest {
  gameID: string;
  agentID: string;
  decisionSequence: number;
  turnNumber: number;
  tick: number | null;
  exposedOptions: readonly ExposedStrategicOption[];
  exposedOptionSetFingerprint: string;
  materialStateFingerprint: string;
}

/** Factual current material state. No scores, ranks, or LegalAction ids. */
export interface CommanderPlanMaterial {
  tilesOwned: number;
  troops: number;
  incomingAttackerIDs: readonly string[];
  alivePlayerIDs: readonly string[];
}

export interface CommanderPlanStartSnapshot {
  decisionSequence: number;
  turnNumber: number;
  tick: number | null;
  tilesOwned: number;
  troops: number;
  incomingAttackerIDs: string[];
}

/**
 * The durable plan. Its authority is `selectedStrategicOptionId`, which is
 * always one of the exact ids exposed by the request that produced it.
 *
 * The Commander's optional `confidence` is deliberately dropped: the plan state
 * carries facts and provenance only, never a score.
 */
export interface ActiveCommanderPlan {
  selectedStrategicOptionId: StrategicOptionId;
  family: StrategicOptionFamily;
  targetPlayerID: string | null;
  horizonDecisions: number;
  replanTriggers: CommanderReplanTrigger[];
  intent: string | null;
  selector: CommanderPlanSelector;
  fallbackReason: CommanderPlanFallbackReason | null;
  origin: CommanderRequestIdentity;
  start: CommanderPlanStartSnapshot;
}

export interface CommanderPlanEvaluation {
  disposition: CommanderPlanDisposition;
  reason: CommanderPlanEvaluationReason;
  ageDecisions: number;
  horizonDecisions: number | null;
  decisionsRemaining: number | null;
}

/** What the Commander was actually shown, paired with what it answered. */
export interface CommanderPlanResponseEnvelope {
  identity: CommanderRequestIdentity;
  parsed: CommanderResponseParseResult;
}

export interface CommanderPlanCycle {
  evaluation: CommanderPlanEvaluation;
  responseDisposition: CommanderResponseDisposition;
  rejection: CommanderPlanRejection | null;
  plan: ActiveCommanderPlan | null;
  selector: CommanderPlanSelector | null;
  fallbackReason: CommanderPlanFallbackReason | null;
  planPreserved: boolean;
  progress: CommanderPlanProgressSnapshot | null;
  snapshot: CommanderPlanSnapshot | null;
}

export interface AdvanceCommanderPlanInput {
  active: ActiveCommanderPlan | null;
  request: CommanderPlanRequest;
  material: CommanderPlanMaterial;
  response?: CommanderPlanResponseEnvelope | null;
}

export interface EvaluateCommanderPlanInput {
  plan: ActiveCommanderPlan | null;
  request: CommanderPlanRequest;
  material: CommanderPlanMaterial;
}

export class CommanderPlanLifecycle {
  advance(input: AdvanceCommanderPlanInput): CommanderPlanCycle {
    return advanceCommanderPlan(input);
  }

  evaluate(input: EvaluateCommanderPlanInput): CommanderPlanEvaluation {
    return evaluateCommanderPlan(input);
  }
}

/**
 * Normalizes and bounds the identity a Commander call is bound to. The exposed
 * ids are preserved in their exposed order; the option-set fingerprint is the
 * separate order-insensitive binding.
 */
export function commanderRequestIdentity(
  request: CommanderPlanRequest,
): CommanderRequestIdentity {
  if (!Array.isArray(request.exposedOptions)) {
    throw new Error("Commander request exposed options must be an array");
  }
  if (request.exposedOptions.length > MAX_EXPOSED_STRATEGIC_OPTIONS) {
    throw new Error("Commander request exceeds the exposure bound");
  }
  const exposedOptionIDs = request.exposedOptions.map(
    (option) =>
      boundedIdentifier(
        option.id,
        "request.exposedOptions[].id",
        MAX_COMMANDER_OPTION_ID_LENGTH,
      ) as StrategicOptionId,
  );
  if (new Set(exposedOptionIDs).size !== exposedOptionIDs.length) {
    throw new Error("Commander request exposes a duplicate option id");
  }
  return {
    gameID: boundedIdentifier(
      request.gameID,
      "request.gameID",
      MAX_COMMANDER_REQUEST_ID_LENGTH,
    ),
    agentID: boundedIdentifier(
      request.agentID,
      "request.agentID",
      MAX_COMMANDER_REQUEST_ID_LENGTH,
    ),
    decisionSequence: nonNegativeInteger(
      request.decisionSequence,
      "request.decisionSequence",
    ),
    turnNumber: nonNegativeInteger(request.turnNumber, "request.turnNumber"),
    tick:
      request.tick === null
        ? null
        : nonNegativeInteger(request.tick, "request.tick"),
    exposedOptionIDs,
    exposedOptionSetFingerprint: boundedIdentifier(
      request.exposedOptionSetFingerprint,
      "request.exposedOptionSetFingerprint",
      MAX_COMMANDER_FINGERPRINT_LENGTH,
    ),
    materialStateFingerprint: boundedIdentifier(
      request.materialStateFingerprint,
      "request.materialStateFingerprint",
      MAX_COMMANDER_FINGERPRINT_LENGTH,
    ),
  };
}

/**
 * Decides whether the active plan may continue. Checks run in a fixed order so
 * the reason is deterministic when several conditions hold at once.
 *
 * `option_no_longer_offered` and `target_eliminated` terminate unconditionally,
 * not only when the Commander declared the matching replan trigger: a plan whose
 * selected option is not exposed has no authority left to continue under.
 */
export function evaluateCommanderPlan(
  input: EvaluateCommanderPlanInput,
): CommanderPlanEvaluation {
  const identity = commanderRequestIdentity(input.request);
  const material = normalizeMaterial(input.material);
  const plan = input.plan;

  if (identity.exposedOptionIDs.length === 0) {
    return terminate("no_exposed_options", plan, identity);
  }
  if (plan === null) {
    return {
      disposition: "replan",
      reason: "no_active_plan",
      ageDecisions: 0,
      horizonDecisions: null,
      decisionsRemaining: null,
    };
  }
  if (plan.origin.gameID !== identity.gameID) {
    return terminate("game_mismatch", plan, identity);
  }
  if (plan.origin.agentID !== identity.agentID) {
    return terminate("agent_mismatch", plan, identity);
  }
  if (identity.decisionSequence < plan.start.decisionSequence) {
    return terminate("decision_sequence_regressed", plan, identity);
  }
  if (!identity.exposedOptionIDs.includes(plan.selectedStrategicOptionId)) {
    return terminate("option_no_longer_offered", plan, identity);
  }
  if (
    plan.targetPlayerID !== null &&
    !material.alivePlayerIDs.has(plan.targetPlayerID)
  ) {
    return terminate("target_eliminated", plan, identity);
  }

  const age = planAge(plan, identity);
  if (age >= plan.horizonDecisions) {
    return {
      disposition: "replan",
      reason: "horizon_expiry",
      ageDecisions: age,
      horizonDecisions: plan.horizonDecisions,
      decisionsRemaining: 0,
    };
  }
  if (
    plan.replanTriggers.includes("home_danger_high") &&
    newIncomingAttackerIDs(plan, material).length > 0
  ) {
    return replan("home_danger_high", plan, age);
  }
  if (
    plan.replanTriggers.includes("option_appeared") &&
    identity.exposedOptionIDs.some(
      (id) => !plan.origin.exposedOptionIDs.includes(id),
    )
  ) {
    return replan("option_appeared", plan, age);
  }
  return {
    disposition: "continue",
    reason: "within_horizon",
    ageDecisions: age,
    horizonDecisions: plan.horizonDecisions,
    decisionsRemaining: plan.horizonDecisions - age,
  };
}

/**
 * Runs one plan cycle. A Commander result may only replace the plan when the
 * active plan cannot continue and the result is bound to this exact request; a
 * continuing plan keeps its selected option unchanged.
 */
export function advanceCommanderPlan(
  input: AdvanceCommanderPlanInput,
): CommanderPlanCycle {
  const identity = commanderRequestIdentity(input.request);
  const material = normalizeMaterial(input.material);
  const evaluation = evaluateCommanderPlan({
    plan: input.active,
    request: input.request,
    material: input.material,
  });
  const response = input.response ?? null;
  const validation = validateCommanderResponse(identity, response);

  if (evaluation.reason === "no_exposed_options") {
    return {
      evaluation,
      responseDisposition: response === null ? "absent" : "rejected",
      rejection:
        response === null
          ? null
          : ((validation.ok ? null : validation.rejection) ?? {
              code: "option_not_exposed",
              detail: "the request exposed no strategic options",
            }),
      plan: null,
      selector: null,
      fallbackReason: null,
      planPreserved: false,
      progress: null,
      snapshot: null,
    };
  }

  if (evaluation.disposition === "continue") {
    const active = input.active;
    if (active === null) {
      throw new Error("Continuing evaluation requires an active plan");
    }
    const progress = planProgress(active, identity, material);
    return {
      evaluation,
      responseDisposition:
        response === null
          ? "absent"
          : validation.ok
            ? "ignored_while_continuing"
            : "rejected",
      rejection: validation.ok ? null : validation.rejection,
      plan: active,
      selector: active.selector,
      fallbackReason: active.fallbackReason,
      planPreserved: true,
      progress,
      snapshot: commanderPlanSnapshot(active, progress),
    };
  }

  const installed = validation.ok
    ? installCommanderPlan({
        request: input.request,
        identity,
        material,
        selectedStrategicOptionId: validation.selectedStrategicOptionId,
        horizonDecisions: validation.horizonDecisions,
        replanTriggers: validation.replanTriggers,
        intent: validation.intent,
        selector: "commander",
        fallbackReason: null,
      })
    : installFallbackPlan({
        request: input.request,
        identity,
        material,
        fallbackReason: validation.fallbackReason,
      });

  const progress = planProgress(installed, identity, material);
  return {
    evaluation,
    responseDisposition:
      response === null ? "absent" : validation.ok ? "applied" : "rejected",
    rejection: validation.ok ? null : validation.rejection,
    plan: installed,
    selector: installed.selector,
    fallbackReason: installed.fallbackReason,
    planPreserved: false,
    progress,
    snapshot: commanderPlanSnapshot(installed, progress),
  };
}

/** Bounded factual progress derived from current material state only. */
export function commanderPlanProgress(
  plan: ActiveCommanderPlan,
  request: CommanderPlanRequest,
  material: CommanderPlanMaterial,
): CommanderPlanProgressSnapshot {
  return planProgress(
    plan,
    commanderRequestIdentity(request),
    normalizeMaterial(material),
  );
}

function planProgress(
  plan: ActiveCommanderPlan,
  identity: CommanderRequestIdentity,
  material: NormalizedCommanderPlanMaterial,
): CommanderPlanProgressSnapshot {
  return {
    decisionsExecuted: planAge(plan, identity),
    tilesDelta: material.tilesOwned - plan.start.tilesOwned,
    troopsDelta: material.troops - plan.start.troops,
    newIncomingAttackerIDs: newIncomingAttackerIDs(plan, material),
  };
}

/** The Stage 2 snapshot shape, ready to feed back into `buildCommanderState`. */
export function commanderPlanSnapshot(
  plan: ActiveCommanderPlan,
  progress: CommanderPlanProgressSnapshot,
): CommanderPlanSnapshot {
  return {
    selectedStrategicOptionId: plan.selectedStrategicOptionId,
    family: plan.family,
    targetPlayerID: plan.targetPlayerID,
    horizonDecisions: plan.horizonDecisions,
    replanTriggers: [...plan.replanTriggers],
    progress: {
      decisionsExecuted: progress.decisionsExecuted,
      tilesDelta: progress.tilesDelta,
      troopsDelta: progress.troopsDelta,
      newIncomingAttackerIDs: [...progress.newIncomingAttackerIDs],
    },
  };
}

type CommanderResponseValidation =
  | {
      ok: true;
      selectedStrategicOptionId: StrategicOptionId;
      horizonDecisions: number;
      replanTriggers: CommanderReplanTrigger[];
      intent: string;
    }
  | {
      ok: false;
      rejection: CommanderPlanRejection | null;
      fallbackReason: CommanderPlanFallbackReason;
    };

/**
 * Rejects stale or mismatched results before anything can replace the active
 * plan. Membership is validated against the exact ids this request exposed.
 */
function validateCommanderResponse(
  identity: CommanderRequestIdentity,
  response: CommanderPlanResponseEnvelope | null,
): CommanderResponseValidation {
  if (response === null || response === undefined) {
    return {
      ok: false,
      rejection: null,
      fallbackReason: "commander_result_absent",
    };
  }
  const seen = response.identity;
  if (!isComparableIdentity(seen)) {
    return mismatch(
      "exposed_option_ids_mismatch",
      "commander_request_mismatch",
      "the response carries no comparable request identity",
    );
  }
  if (seen.gameID !== identity.gameID) {
    return mismatch(
      "game_id_mismatch",
      "commander_request_mismatch",
      "the response was produced for another game",
    );
  }
  if (seen.agentID !== identity.agentID) {
    return mismatch(
      "agent_id_mismatch",
      "commander_request_mismatch",
      "the response was produced for another agent",
    );
  }
  if (seen.decisionSequence < identity.decisionSequence) {
    return mismatch(
      "decision_sequence_stale",
      "commander_result_stale",
      "the response answers an earlier decision",
    );
  }
  if (seen.decisionSequence !== identity.decisionSequence) {
    return mismatch(
      "decision_sequence_mismatch",
      "commander_request_mismatch",
      "the response answers a different decision",
    );
  }
  if (seen.turnNumber !== identity.turnNumber) {
    return mismatch(
      "turn_number_mismatch",
      "commander_request_mismatch",
      "the response answers a different turn",
    );
  }
  if (seen.tick !== identity.tick) {
    return mismatch(
      "tick_mismatch",
      "commander_request_mismatch",
      "the response answers a different tick",
    );
  }
  if (!sameOrderedIDs(seen.exposedOptionIDs, identity.exposedOptionIDs)) {
    return mismatch(
      "exposed_option_ids_mismatch",
      "commander_request_mismatch",
      "the response saw a different exposed option set",
    );
  }
  if (
    seen.exposedOptionSetFingerprint !== identity.exposedOptionSetFingerprint
  ) {
    return mismatch(
      "option_set_fingerprint_mismatch",
      "commander_request_mismatch",
      "the option-set fingerprint changed",
    );
  }
  if (seen.materialStateFingerprint !== identity.materialStateFingerprint) {
    return mismatch(
      "material_state_fingerprint_mismatch",
      "commander_request_mismatch",
      "the material-state fingerprint changed",
    );
  }

  const parsed = response.parsed;
  if (parsed === null || typeof parsed !== "object" || parsed.ok !== true) {
    return mismatch(
      "response_invalid",
      "commander_response_invalid",
      "the Commander response failed the response contract",
    );
  }
  if (!identity.exposedOptionIDs.includes(parsed.selectedStrategicOptionId)) {
    return mismatch(
      "option_not_exposed",
      "commander_option_not_exposed",
      "the selected option was not exposed by this request",
    );
  }
  return {
    ok: true,
    selectedStrategicOptionId: parsed.selectedStrategicOptionId,
    horizonDecisions: boundedHorizon(parsed.horizonDecisions),
    replanTriggers: normalizeTriggers(parsed.replanTriggers),
    intent: sanitizeUntrustedDisplayString(
      parsed.intent,
      MAX_COMMANDER_INTENT_LENGTH,
    ),
  };
}

/**
 * The envelope identity crosses a provider boundary, so its field types are
 * checked before any ordering comparison rather than trusted.
 */
function isComparableIdentity(
  value: unknown,
): value is CommanderRequestIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const seen = value as Partial<CommanderRequestIdentity>;
  return (
    typeof seen.gameID === "string" &&
    typeof seen.agentID === "string" &&
    Number.isSafeInteger(seen.decisionSequence) &&
    Number.isSafeInteger(seen.turnNumber) &&
    (seen.tick === null || Number.isSafeInteger(seen.tick)) &&
    Array.isArray(seen.exposedOptionIDs) &&
    seen.exposedOptionIDs.every((id) => typeof id === "string") &&
    typeof seen.exposedOptionSetFingerprint === "string" &&
    typeof seen.materialStateFingerprint === "string"
  );
}

function mismatch(
  code: CommanderPlanRejectionCode,
  fallbackReason: CommanderPlanFallbackReason,
  detail: string,
): CommanderResponseValidation {
  return { ok: false, rejection: { code, detail }, fallbackReason };
}

interface InstallCommanderPlanInput {
  request: CommanderPlanRequest;
  identity: CommanderRequestIdentity;
  material: NormalizedCommanderPlanMaterial;
  selectedStrategicOptionId: StrategicOptionId;
  horizonDecisions: number;
  replanTriggers: CommanderReplanTrigger[];
  intent: string | null;
  selector: CommanderPlanSelector;
  fallbackReason: CommanderPlanFallbackReason | null;
}

function installCommanderPlan(
  input: InstallCommanderPlanInput,
): ActiveCommanderPlan {
  const option = input.request.exposedOptions.find(
    (candidate) => candidate.id === input.selectedStrategicOptionId,
  );
  if (option === undefined) {
    throw new Error("Selected strategic option is not exposed by the request");
  }
  const targetPlayerID =
    option.targetPlayerID === null
      ? null
      : boundedIdentifier(
          option.targetPlayerID,
          "exposedOption.targetPlayerID",
          MAX_COMMANDER_PLAYER_ID_LENGTH,
        );
  assertStrategicIdentity(option.id, option.family, targetPlayerID);
  return {
    selectedStrategicOptionId: option.id,
    family: option.family,
    targetPlayerID,
    horizonDecisions: input.horizonDecisions,
    replanTriggers: input.replanTriggers,
    intent: input.intent,
    selector: input.selector,
    fallbackReason: input.fallbackReason,
    origin: input.identity,
    start: {
      decisionSequence: input.identity.decisionSequence,
      turnNumber: input.identity.turnNumber,
      tick: input.identity.tick,
      tilesOwned: input.material.tilesOwned,
      troops: input.material.troops,
      incomingAttackerIDs: [...input.material.incomingAttackerIDs].slice(
        0,
        MAX_COMMANDER_PLAN_ATTACKER_IDS,
      ),
    },
  };
}

/**
 * The fallback selects the lexicographically first id exposed by this exact
 * request. It never inspects evidence, so it introduces no hidden ranking, and
 * it is stable when the exposed options arrive in a different order.
 */
function installFallbackPlan(input: {
  request: CommanderPlanRequest;
  identity: CommanderRequestIdentity;
  material: NormalizedCommanderPlanMaterial;
  fallbackReason: CommanderPlanFallbackReason;
}): ActiveCommanderPlan {
  const selectedStrategicOptionId = [...input.identity.exposedOptionIDs].sort(
    stableStringCompare,
  )[0];
  if (selectedStrategicOptionId === undefined) {
    throw new Error("Fallback selection requires at least one exposed option");
  }
  return installCommanderPlan({
    request: input.request,
    identity: input.identity,
    material: input.material,
    selectedStrategicOptionId,
    horizonDecisions: MIN_COMMANDER_HORIZON_DECISIONS,
    replanTriggers: [],
    intent: null,
    selector: "fallback",
    fallbackReason: input.fallbackReason,
  });
}

export interface NormalizedCommanderPlanMaterial {
  tilesOwned: number;
  troops: number;
  incomingAttackerIDs: string[];
  alivePlayerIDs: ReadonlySet<string>;
}

function normalizeMaterial(
  material: CommanderPlanMaterial,
): NormalizedCommanderPlanMaterial {
  if (
    material === null ||
    typeof material !== "object" ||
    !Array.isArray(material.incomingAttackerIDs) ||
    !Array.isArray(material.alivePlayerIDs)
  ) {
    throw new Error("Commander plan material is malformed");
  }
  return {
    tilesOwned: nonNegativeInteger(material.tilesOwned, "material.tilesOwned"),
    troops: nonNegativeFinite(material.troops, "material.troops"),
    incomingAttackerIDs: boundedPlayerIDs(
      material.incomingAttackerIDs,
      "material.incomingAttackerIDs",
    ),
    alivePlayerIDs: new Set(
      boundedPlayerIDs(material.alivePlayerIDs, "material.alivePlayerIDs", {
        limit: MAX_COMMANDER_ALIVE_PLAYERS,
        overflow: "throw",
      }),
    ),
  };
}

function newIncomingAttackerIDs(
  plan: ActiveCommanderPlan,
  material: NormalizedCommanderPlanMaterial,
): string[] {
  const atStart = new Set(plan.start.incomingAttackerIDs);
  return material.incomingAttackerIDs
    .filter((playerID) => !atStart.has(playerID))
    .slice(0, MAX_COMMANDER_PLAN_ATTACKER_IDS);
}

function planAge(
  plan: ActiveCommanderPlan,
  identity: CommanderRequestIdentity,
): number {
  return Math.max(0, identity.decisionSequence - plan.start.decisionSequence);
}

function terminate(
  reason: CommanderPlanTerminateReason,
  plan: ActiveCommanderPlan | null,
  identity: CommanderRequestIdentity,
): CommanderPlanEvaluation {
  return {
    disposition: "terminate",
    reason,
    ageDecisions: plan === null ? 0 : planAge(plan, identity),
    horizonDecisions: plan?.horizonDecisions ?? null,
    decisionsRemaining: null,
  };
}

function replan(
  reason: CommanderPlanReplanReason,
  plan: ActiveCommanderPlan,
  age: number,
): CommanderPlanEvaluation {
  return {
    disposition: "replan",
    reason,
    ageDecisions: age,
    horizonDecisions: plan.horizonDecisions,
    decisionsRemaining: Math.max(0, plan.horizonDecisions - age),
  };
}

function sameOrderedIDs(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (!Array.isArray(left) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function normalizeTriggers(
  triggers: readonly CommanderReplanTrigger[],
): CommanderReplanTrigger[] {
  if (!Array.isArray(triggers)) {
    throw new Error("Commander replan triggers must be an array");
  }
  const unique = [...new Set(triggers)];
  if (
    unique.length > commanderReplanTriggers.length ||
    unique.some((trigger) => !commanderReplanTriggers.includes(trigger))
  ) {
    throw new Error("Commander replan triggers are invalid");
  }
  return unique.sort(stableStringCompare);
}

function boundedHorizon(horizonDecisions: number): number {
  if (!Number.isInteger(horizonDecisions)) {
    throw new Error("Commander horizon must be an integer");
  }
  return Math.min(
    MAX_COMMANDER_HORIZON_DECISIONS,
    Math.max(MIN_COMMANDER_HORIZON_DECISIONS, horizonDecisions),
  );
}

function boundedPlayerIDs(
  values: readonly string[],
  field: string,
  options: { limit: number; overflow: "truncate" | "throw" } = {
    limit: MAX_COMMANDER_PLAN_ATTACKER_IDS,
    overflow: "truncate",
  },
): string[] {
  const unique = [
    ...new Set(
      values.map((value) =>
        boundedIdentifier(value, field, MAX_COMMANDER_PLAYER_ID_LENGTH),
      ),
    ),
  ].sort(stableStringCompare);
  if (unique.length > options.limit && options.overflow === "throw") {
    throw new Error(`${field} exceeds its bound`);
  }
  return unique.slice(0, options.limit);
}

function assertStrategicIdentity(
  id: StrategicOptionId,
  family: StrategicOptionFamily,
  targetPlayerID: string | null,
): void {
  let expectedID: string | null;
  switch (family) {
    case "expand":
    case "develop_economy":
    case "survive":
      expectedID = family;
      break;
    case "pressure_rival":
      expectedID =
        targetPlayerID === null ? null : `pressure_rival:${targetPlayerID}`;
      break;
    default:
      throw new Error("Exposed option has an unsupported strategic family");
  }
  if (expectedID === null || id !== expectedID) {
    throw new Error("Exposed option strategic identity is inconsistent");
  }
  if (family !== "pressure_rival" && targetPlayerID !== null) {
    throw new Error("Exposed option unexpectedly targets a rival");
  }
}

function boundedIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    sanitizeUntrustedDisplayString(value, maxLength) !== value
  ) {
    throw new Error(`${field} must be a bounded stable identifier`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeFinite(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

function stableStringCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
