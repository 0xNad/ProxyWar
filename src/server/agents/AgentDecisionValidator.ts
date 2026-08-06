import {
  evaluateSpawnTileLegality,
  parseSpawnTileFromActionID,
  SpawnLegalityContext,
} from "./AgentSpawnLegality";
import { AgentDecision, LegalAction } from "./AgentTypes";
import { buildSpawnLegalAction } from "./LegalActionBuilder";

export type AgentDecisionValidation =
  | { ok: true; action: LegalAction }
  | { ok: false; reason: string; fallback: LegalAction | null };

export interface AgentDecisionBatchValidation {
  ok: boolean;
  actions: LegalAction[];
  rejectedActionIDs: string[];
  fallback: LegalAction | null;
  reason: string;
}

export function validateAgentDecision(
  decision: AgentDecision,
  legalActions: LegalAction[],
): AgentDecisionValidation {
  const action = legalActions.find(
    (candidate) => candidate.id === decision.actionID,
  );
  if (action !== undefined) {
    return { ok: true, action };
  }

  const fallback =
    legalActions.find((candidate) => candidate.kind === "hold") ?? null;
  return {
    ok: false,
    reason: `decision selected unknown action id: ${decision.actionID}`,
    fallback,
  };
}

/**
 * Spawn-phase decision validation. Tries the existing exact-menu match FIRST
 * (`validateAgentDecision`, unchanged, identical semantics for every offered
 * candidate including "hold"). For a well-formed `spawn:<tile>` id that
 * missed the exact-menu match, falls through to a live legality check
 * against the same predicates core enforces
 * (`AgentSpawnLegality.evaluateSpawnTileLegality`), so an agent may request
 * any currently-legal tile even when it was never offered in the curated
 * menu.
 *
 * CRITICAL: because spawn-phase decisions are computed CONCURRENTLY against
 * a snapshot (see `AgentLeagueMatch.runSpawnPhase`'s build-then-Promise.all
 * pass) and only committed serially afterward, an offered candidate that was
 * legal when the menu was built can be STALE by the time this function runs
 * - an earlier-committed-this-tick participant may have just claimed that
 * same tile or moved within its exclusion radius. An exact-menu match is
 * therefore NEVER trusted at face value for a spawn action: its tile is
 * re-validated against `spawnContext` (built from the LATEST spawnStakes at
 * commit time) exactly like an off-menu request, before being accepted. A
 * tile that is no longer legal is rejected here even though it was legal -
 * or even the offered id itself - when the request was built. The ORIGINAL
 * matched `LegalAction` (with its real candidate scores/metadata) is
 * returned on success, not a re-synthesized one, so downstream telemetry
 * keeps real quality scores for menu picks.
 *
 * Every other decision (non-spawn kinds, malformed ids, spawn ids when no
 * spawn action is on offer) falls through to `validateAgentDecision`'s
 * unchanged behavior - non-spawn validation is never touched by this
 * function.
 */
export function validateSpawnDecision(
  decision: AgentDecision,
  legalActions: LegalAction[],
  spawnContext: SpawnLegalityContext,
): AgentDecisionValidation {
  const exact = validateAgentDecision(decision, legalActions);

  if (exact.ok && exact.action.kind === "spawn") {
    const tile = exact.action.metadata?.tile;
    if (typeof tile === "number") {
      const legality = evaluateSpawnTileLegality(tile, spawnContext);
      if (!legality.legal) {
        return {
          ok: false,
          reason: `offered spawn candidate is no longer legal: ${legality.reason}`,
          fallback:
            legalActions.find((candidate) => candidate.kind === "hold") ??
            null,
        };
      }
    }
    return exact;
  }
  if (exact.ok) {
    return exact;
  }

  if (!legalActions.some((action) => action.kind === "spawn")) {
    return exact;
  }
  const tile = parseSpawnTileFromActionID(decision.actionID);
  if (tile === null) {
    return exact;
  }
  const legality = evaluateSpawnTileLegality(tile, spawnContext);
  if (!legality.legal) {
    return {
      ok: false,
      reason: `off-menu spawn request rejected: ${legality.reason}`,
      fallback:
        legalActions.find((candidate) => candidate.kind === "hold") ?? null,
    };
  }
  return { ok: true, action: buildSpawnLegalAction(legality.candidate) };
}

export function validateAgentDecisionBatch(
  decision: AgentDecision,
  legalActions: LegalAction[],
): AgentDecisionBatchValidation {
  const requestedActionIDs = requestedBatchActionIDs(decision);
  const actions: LegalAction[] = [];
  const rejectedActionIDs: string[] = [];

  for (const actionID of requestedActionIDs) {
    const action = legalActions.find((candidate) => candidate.id === actionID);
    if (action !== undefined) {
      actions.push(action);
    } else {
      rejectedActionIDs.push(actionID);
    }
  }

  if (actions.length > 0) {
    return {
      ok: rejectedActionIDs.length === 0,
      actions,
      rejectedActionIDs,
      fallback: null,
      reason:
        rejectedActionIDs.length === 0
          ? "all requested action ids are legal"
          : `ignored unknown action ids: ${rejectedActionIDs.join(",")}`,
    };
  }

  const fallback =
    legalActions.find((candidate) => candidate.kind === "hold") ?? null;
  return {
    ok: false,
    actions: fallback ? [fallback] : [],
    rejectedActionIDs,
    fallback,
    reason:
      rejectedActionIDs.length > 0
        ? `decision selected no known action ids: ${rejectedActionIDs.join(",")}`
        : "decision selected no action ids",
  };
}

function requestedBatchActionIDs(decision: AgentDecision): string[] {
  const raw =
    decision.actionIDs !== undefined && decision.actionIDs.length > 0
      ? decision.actionIDs
      : [decision.actionID];
  const deduplicated: string[] = [];
  for (const id of raw) {
    if (id.trim().length > 0 && !deduplicated.includes(id)) {
      deduplicated.push(id);
    }
  }
  return deduplicated;
}
