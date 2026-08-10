import type { Game } from "../../core/game/Game";
import {
  sanitizeStatedReason,
  STATED_REASON_MAX_LENGTH,
} from "./AgentDecisiveMoments";
import type {
  AgentActionAuditStatus,
  AgentDealObligationKind,
  AgentDealObligationStatus,
  AgentDealStatus,
  AgentDealTemplate,
  AgentDecisionRecord,
} from "./AgentTypes";

/**
 * Structured-deal compliance referee (PROXYWAR_TUNE_STRUCTURED_DEALS, default
 * OFF — economy+negotiation V1 Phase B).
 *
 * Deterministic per-match judge of validator-accepted hostile actions for negative
 * covenants and CONFIRMED game effects for positive promises. It reads exact
 * validated action/result records, audit data, and live game-state liveness
 * facts. Deals never alter any game permission — agents remain free to defect
 * — so the referee narrates follow-through; it never punishes. There is NO
 * hidden morality score and NO rating input; per-agent reliability is a public aggregate
 * (fulfilled / terminal non-moot) exposed for observation and narration only.
 *
 * Detection rules (verified mechanics, docs/OPENFRONT_ECONOMY_NEGOTIATION_
 * VERIFIED.md §2.4-2.5, §3-4):
 * - non_aggression / trade_security violation: a validator-accepted exact land attack,
 *   naval-invasion launch, or nuke/MIRV action against the partner during the
 *   active window. A transport launched before the promise is outside this
 *   action-window contract even if it arrives later.
 * - trade_security additionally: a MANUAL embargo chosen against the partner
 *   (a validator-accepted exact `embargo`/`embargo_all` ACTION record — embargo_all
 *   counts). The automatic temporary embargo a victim gains by BEING attacked
 *   is never the victim's violation: embargo violations are judged exclusively
 *   from accepted embargo ACTION records.
 * - Emoji, quick chat, and target markers are never violations.
 * - joint_attack fulfilled only by confirmed attack execution (or confirmed
 *   nuke) against the named third seat within the window.
 * - support_request fulfilled when cumulative confirmed donations of a pledged
 *   resource to the correct recipient reach the explicit amount in the window.
 * - moot: counterparty, obligor, or named target eliminated — fulfillment (or
 *   violation) became impossible through events outside the obligor's control.
 */

/**
 * Hard cap on a stored agent-authored stated reason (see
 * `sanitizeDealStatedReason`).
 */
export const MAX_DEAL_STATED_REASON_LENGTH = 160;

/**
 * Sanitizer for AGENT-AUTHORED deal stated reasons before they are stored on
 * the deal ledger or shipped in an artifact. Returns null for anything that
 * must not be shipped — `AgentDecision.reason` is `string | null` and null
 * means the provider produced no stated reason, so the field is OMITTED
 * rather than filled with substitute text.
 *
 * Three layers, in order:
 * 1. syntactic hygiene — printable ASCII only, collapsed whitespace;
 * 2. the SHARED content policy `AgentDecisiveMoments.sanitizeStatedReason`
 *    (starts with a letter, no HTTP/exception/provider-failure vocabulary),
 *    applied to the full cleaned text so denylisted vocabulary sitting past
 *    our own cap cannot slip through;
 * 3. the hard `MAX_DEAL_STATED_REASON_LENGTH` cap.
 *
 * Layer 2 is deliberately REUSED, not re-implemented: that denylist exists
 * because a real production incident shipped a raw LLM-provider error as an
 * agent's public "stated reason", and this field lands in
 * `spectator-telemetry.json` — the same class of public run artifact. Its
 * known cost is false positives (a genuine rationale containing "failed",
 * "rejected", or "invalid" is dropped); that is the right trade here for the
 * same reason it was there: the field degrades to honestly absent, and an
 * absent claim beside a betrayal verdict is strictly better than a provider
 * stack trace presented as an agent's motive.
 *
 * Deliberately NOT `PromptSanitizer.sanitizeUntrustedDisplayString`: that one
 * keeps non-ASCII text (names must stay readable for theory of mind) and
 * appends a non-ASCII ellipsis when truncating. This surface is narrated
 * artifact text with an ASCII-only contract, so layer 1 uses the same
 * `[^\x20-\x7e]` rule the starter's own `clean()` uses.
 */
export function sanitizeDealStatedReason(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return null;
  }
  if (
    sanitizeStatedReason(cleaned.slice(0, STATED_REASON_MAX_LENGTH)) === null
  ) {
    return null;
  }
  return cleaned.slice(0, MAX_DEAL_STATED_REASON_LENGTH);
}

export interface AgentDealObligationState {
  /** Deterministic: obligation:<dealID>:<obligorPlayerID>:<kind>. */
  obligationID: string;
  dealID: string;
  obligorPlayerID: string;
  obligorName: string;
  counterpartyPlayerID: string;
  counterpartyName: string;
  kind: AgentDealObligationKind;
  targetPlayerID?: string;
  targetName?: string;
  goldAmount?: bigint;
  troopAmount?: number;
  donatedGold: bigint;
  donatedTroops: number;
  status: AgentDealObligationStatus;
  resolvedAtStep: number | null;
  resolutionEvidence: string | null;
  forcedResolution: boolean;
  /**
   * False once any active-window decision lacks enough retained action
   * evidence to classify it under the negative-covenant contract. Every
   * retained `chosenActionID` has already passed `AgentDecisionValidator`; the field
   * name is retained for artifact compatibility; it now measures exact-action
   * coverage, not downstream game-effect confirmation.
   */
  auditCoverageComplete: boolean;
  /** Number of active decision steps with missing or ambiguous action evidence. */
  auditCoverageGapCount: number;
  /**
   * VIEWER-ONLY. The obligor's OWN stated reason on the decision whose
   * validator-accepted action or confirmed effect resolved this obligation
   * (the betrayal's or the kept promise's rationale, already sanitized). Absent when the resolution came
   * from the clock (elapsed/forced/moot) or the decision had no stated
   * reason. NEVER enters any agent's observation — see `AgentDealState`.
   */
  obligorStatedReason?: string;
}

export interface AgentDealState {
  /** Deterministic: deal:<proposerSeat>:<recipientSeat>:<template>:<decisionStep>. */
  dealID: string;
  template: AgentDealTemplate;
  proposerPlayerID: string;
  proposerName: string;
  recipientPlayerID: string;
  recipientName: string;
  status: AgentDealStatus;
  durationSteps: number;
  proposedAtStep: number;
  /** Tick/turn timestamps retained in the ledger for audit. */
  proposedAtTurn: number;
  answerableThroughStep: number;
  respondedAtStep: number | null;
  respondedAtTurn: number | null;
  activeFromStep: number | null;
  expiresAfterStep: number | null;
  targetPlayerID?: string;
  targetName?: string;
  goldAmount?: bigint;
  troopAmount?: number;
  /**
   * VIEWER-ONLY. The proposer's own one-line rationale for the offer, taken
   * from the proposing decision's `AgentDecision.reason` and sanitized
   * (`sanitizeDealStatedReason`). Absent when that decision had no stated
   * reason.
   *
   * PRIVACY (load-bearing): agent-authored text is never surfaced to another
   * agent. It rides the ledger, the decision-record stamps, and spectator
   * telemetry — all viewer/operator artifacts — and is deliberately absent
   * from every `AgentDeals*View` the observation carries: text written by one
   * policy and read by another policy's prompt is an instruction-injection
   * channel. Observations carry structured terms only.
   */
  proposerStatedReason?: string;
  /** VIEWER-ONLY acceptor rationale — same contract as `proposerStatedReason`. */
  acceptorStatedReason?: string;
  obligations: AgentDealObligationState[];
}

export type AgentDealEventKind =
  | "deal_proposed"
  | "deal_accepted"
  | "deal_rejected"
  | "deal_expired"
  | "deal_fulfilled"
  | "deal_violated";

/**
 * Compact, JSON-serializable deal-ledger event. Referee/lifecycle events are
 * stamped onto decision records as the `dealComplianceEvent` metadata key (a
 * JSON array string on the permissive decisions.jsonl surface) so spectator
 * telemetry can derive deal events from records alone.
 */
export interface AgentDealLedgerEvent {
  event: AgentDealEventKind;
  dealID: string;
  template: AgentDealTemplate;
  actorPlayerID: string;
  actorName: string;
  targetPlayerID: string | null;
  targetName: string | null;
  tone: "info" | "pact" | "trade" | "threat" | "betrayal" | "war";
  importance: number;
  publicText: string;
  /**
   * VIEWER-ONLY. The acting agent's OWN stated reason, sanitized and capped —
   * a CLAIM, kept in its own field so it is never confused with the
   * server-authored `publicText` FACT. Omitted when there is none. Never
   * surfaced to any agent (see `AgentDealState.proposerStatedReason`).
   */
  statedReason?: string;
  step: number;
  /** Origin decision for immediate fulfilled/violated verdicts. Absent on passive lifecycle events. */
  sourceSequence?: number;
  sourceTurnNumber?: number;
  sourceFallbackUsed?: boolean;
  sourceLlmPlannerDegraded?: boolean;
  sourceAuditStatus?: AgentActionAuditStatus | "missing";
  sourceAuditReason?: string;
}

export const DEAL_TEMPLATE_LABELS: Record<AgentDealTemplate, string> = {
  non_aggression_pact: "non-aggression pact",
  trade_security_pact: "trade-security pact",
  joint_attack: "attack pledge",
  support_request: "support pledge",
};

const NEGATIVE_OBLIGATION_KINDS: ReadonlySet<AgentDealObligationKind> = new Set(
  ["non_aggression", "trade_security"],
);

export function isNegativeObligationKind(
  kind: AgentDealObligationKind,
): boolean {
  return NEGATIVE_OBLIGATION_KINDS.has(kind);
}

/** Constructs the per-obligor obligations a template creates on acceptance. */
export function buildDealObligations(
  deal: AgentDealState,
): AgentDealObligationState[] {
  const base = {
    dealID: deal.dealID,
    donatedGold: 0n,
    donatedTroops: 0,
    status: "pending" as const,
    resolvedAtStep: null,
    resolutionEvidence: null,
    forcedResolution: false,
    auditCoverageComplete: true,
    auditCoverageGapCount: 0,
  };
  switch (deal.template) {
    case "non_aggression_pact":
    case "trade_security_pact": {
      const kind: AgentDealObligationKind =
        deal.template === "non_aggression_pact"
          ? "non_aggression"
          : "trade_security";
      return [
        {
          ...base,
          obligationID: dealObligationID(
            deal.dealID,
            deal.proposerPlayerID,
            kind,
          ),
          obligorPlayerID: deal.proposerPlayerID,
          obligorName: deal.proposerName,
          counterpartyPlayerID: deal.recipientPlayerID,
          counterpartyName: deal.recipientName,
          kind,
        },
        {
          ...base,
          obligationID: dealObligationID(
            deal.dealID,
            deal.recipientPlayerID,
            kind,
          ),
          obligorPlayerID: deal.recipientPlayerID,
          obligorName: deal.recipientName,
          counterpartyPlayerID: deal.proposerPlayerID,
          counterpartyName: deal.proposerName,
          kind,
        },
      ];
    }
    case "joint_attack":
      // The PROPOSER is the obligor: the offer gate (borders the target or
      // has boat options against it) is checkable only for the proposer.
      return [
        {
          ...base,
          obligationID: dealObligationID(
            deal.dealID,
            deal.proposerPlayerID,
            "confirmed_attack_on_target",
          ),
          obligorPlayerID: deal.proposerPlayerID,
          obligorName: deal.proposerName,
          counterpartyPlayerID: deal.recipientPlayerID,
          counterpartyName: deal.recipientName,
          kind: "confirmed_attack_on_target",
          targetPlayerID: deal.targetPlayerID,
          targetName: deal.targetName,
        },
      ];
    case "support_request":
      // The accepting RECIPIENT is the obligor: the proposer requests
      // support; acceptance is the commitment to send it.
      return [
        {
          ...base,
          obligationID: dealObligationID(
            deal.dealID,
            deal.recipientPlayerID,
            "send_support",
          ),
          obligorPlayerID: deal.recipientPlayerID,
          obligorName: deal.recipientName,
          counterpartyPlayerID: deal.proposerPlayerID,
          counterpartyName: deal.proposerName,
          kind: "send_support",
          goldAmount: deal.goldAmount,
          troopAmount: deal.troopAmount,
        },
      ];
  }
}

/** Stable identity for one server-authored obligation within a deal. */
export function dealObligationID(
  dealID: string,
  obligorPlayerID: string,
  kind: AgentDealObligationKind,
): string {
  return `obligation:${dealID}:${obligorPlayerID}:${kind}`;
}

function stringMetadata(
  record: AgentDecisionRecord,
  key: string,
): string | null {
  const value = record.chosenActionMetadata?.[key];
  return typeof value === "string" ? value : null;
}

function numberMetadata(
  record: AgentDecisionRecord,
  key: string,
): number | null {
  const value = record.chosenActionMetadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A validator-accepted hostile action by this record's player against
 * `targetPlayerID`: an exact non-expansion attack, naval-invasion launch, or
 * nuke action naming the target. `chosenActionID` and its action metadata are
 * written only after `AgentDecisionValidator` accepts the menu selection; the
 * later `result.accepted` says whether GameServer accepted the submitted
 * intent and does not erase the choice. Downstream effect snapshots are
 * deliberately excluded: a transport launched before the covenant may arrive
 * inside its window, and that is not a new promise-breaking choice.
 */
function validatedHostileActionAgainst(
  record: AgentDecisionRecord,
  targetPlayerID: string,
): string | null {
  if (
    record.chosenActionKind === "attack" &&
    record.chosenActionMetadata?.expansion !== true &&
    stringMetadata(record, "targetID") === targetPlayerID
  ) {
    return "validator-accepted land attack";
  }
  if (
    record.chosenActionKind === "nuke" &&
    stringMetadata(record, "targetID") === targetPlayerID
  ) {
    return "validator-accepted nuclear strike";
  }
  if (
    record.chosenActionKind === "boat" &&
    record.chosenActionMetadata?.navalInvasion === true &&
    record.chosenActionMetadata?.expansion === false &&
    stringMetadata(record, "targetID") === targetPlayerID
  ) {
    return "validator-accepted naval invasion launch";
  }
  return null;
}

/**
 * The referee's pressure floor for joint_attack FULFILLMENT: a confirmed
 * attack must commit at least this fraction of the obligor's troops
 * (LegalActionBuilder attack actions carry `troopPercentage`, e.g. 0.1 / 0.25
 * / 0.4) to count as the pledged "confirmed military pressure" — a token
 * below-floor poke earns no credit. A confirmed nuke always qualifies
 * (decisive pressure with no troop commitment to measure). Snapshot-only
 * attack deltas (including transport arrivals) are not action choices and
 * therefore neither fulfill a pledge nor violate a negative covenant.
 */
export const MIN_JOINT_ATTACK_TROOP_PERCENT = 0.2;

/**
 * Confirmed attack pressure by this record's player against `targetPlayerID`
 * that clears the referee's joint-attack floor: a confirmed non-expansion
 * attack record naming the target with troop commitment >=
 * MIN_JOINT_ATTACK_TROOP_PERCENT, or a confirmed nuke record naming the
 * target. Returns a short description or null.
 */
function confirmedJointAttackPressureOn(
  record: AgentDecisionRecord,
  targetPlayerID: string,
): string | null {
  if (!record.result.accepted || record.audit?.auditStatus !== "confirmed") {
    return null;
  }
  if (
    record.chosenActionKind === "nuke" &&
    stringMetadata(record, "targetID") === targetPlayerID
  ) {
    return "nuclear strike";
  }
  if (
    record.chosenActionKind !== "attack" ||
    record.chosenActionMetadata?.expansion === true ||
    stringMetadata(record, "targetID") !== targetPlayerID
  ) {
    return null;
  }
  const fraction =
    numberMetadata(record, "troopPercentage") ??
    (numberMetadata(record, "troopPercent") ?? 0) / 100;
  if (fraction < MIN_JOINT_ATTACK_TROOP_PERCENT) {
    return null;
  }
  return `land attack (${Math.round(fraction * 100)}% troops)`;
}

/**
 * A MANUAL embargo selected against `targetPlayerID` by this record: judged
 * exclusively from validator-accepted exact `embargo`/`embargo_all` ACTION records,
 * never from embargo-set snapshot diffs — the automatic temporary embargo a
 * victim gains by being attacked appears only in snapshots and must never be
 * attributed to the victim as a violation.
 */
function validatedManualEmbargoAgainst(
  record: AgentDecisionRecord,
  targetPlayerID: string,
): string | null {
  if (
    record.chosenActionKind === "embargo" &&
    stringMetadata(record, "action") === "start" &&
    stringMetadata(record, "targetID") === targetPlayerID
  ) {
    return "manual embargo";
  }
  if (
    record.chosenActionKind === "embargo_all" &&
    stringMetadata(record, "action") === "start"
  ) {
    return "embargo_all";
  }
  return null;
}

function confirmedDonationTo(
  record: AgentDecisionRecord,
  recipientPlayerID: string,
): { gold: bigint; troops: number } | null {
  if (!record.result.accepted || record.audit?.auditStatus !== "confirmed") {
    return null;
  }
  if (
    record.chosenActionKind !== "donate_gold" &&
    record.chosenActionKind !== "donate_troops"
  ) {
    return null;
  }
  if (stringMetadata(record, "recipientID") !== recipientPlayerID) {
    return null;
  }
  const gold =
    record.chosenActionKind === "donate_gold"
      ? BigInt(Math.max(0, Math.floor(numberMetadata(record, "gold") ?? 0)))
      : 0n;
  const troops =
    record.chosenActionKind === "donate_troops"
      ? Math.max(0, Math.floor(numberMetadata(record, "troops") ?? 0))
      : 0;
  return { gold, troops };
}

/**
 * Whether one retained decision fully covers a negative covenant for this
 * counterparty. This contract judges the agent's validator-accepted exact action choice,
 * not its asynchronous downstream effect. A later GameServer rejection does
 * not erase that choice. Unrelated actions are covered without an effect audit.
 * A violation-capable action with ambiguous target/action metadata is a gap
 * rather than inferred compliance.
 */
function hasNegativeCovenantCoverage(
  record: AgentDecisionRecord,
  obligation: AgentDealObligationState,
): boolean {
  const counterpartyID = obligation.counterpartyPlayerID;
  if (validatedHostileActionAgainst(record, counterpartyID) !== null) {
    return true;
  }
  const targetID = stringMetadata(record, "targetID");
  if (record.chosenActionKind === "attack") {
    if (record.chosenActionMetadata?.expansion === true) {
      return true;
    }
    return targetID !== null && targetID.length > 0;
  }
  if (record.chosenActionKind === "nuke") {
    return targetID !== null && targetID.length > 0;
  }
  if (record.chosenActionKind === "boat") {
    const expansion = record.chosenActionMetadata?.expansion;
    const navalInvasion = record.chosenActionMetadata?.navalInvasion;
    if (
      expansion === true &&
      navalInvasion === false &&
      (targetID === null || targetID.length === 0)
    ) {
      return true;
    }
    return (
      expansion === false &&
      navalInvasion === true &&
      targetID !== null &&
      targetID.length > 0
    );
  }
  if (obligation.kind === "trade_security") {
    if (validatedManualEmbargoAgainst(record, counterpartyID) !== null) {
      return true;
    }
    const action = stringMetadata(record, "action");
    if (record.chosenActionKind === "embargo") {
      if (action === "stop") {
        return true;
      }
      return action === "start" && targetID !== null && targetID.length > 0;
    }
    if (record.chosenActionKind === "embargo_all") {
      return action === "start" || action === "stop";
    }
  }
  return true;
}

function resolveObligation(
  obligation: AgentDealObligationState,
  status: AgentDealObligationStatus,
  step: number,
  evidence: string,
  forced = false,
): void {
  obligation.status = status;
  obligation.resolvedAtStep = step;
  obligation.resolutionEvidence = evidence;
  obligation.forcedResolution = forced;
}

function verdictEvent(
  deal: AgentDealState,
  obligation: AgentDealObligationState,
  event: AgentDealEventKind,
  tone: AgentDealLedgerEvent["tone"],
  importance: number,
  publicText: string,
  step: number,
  sourceRecord: AgentDecisionRecord | null = null,
  /** VIEWER-ONLY agent claim; omitted entirely when there is none. */
  statedReason: string | null = null,
): AgentDealLedgerEvent {
  return {
    event,
    dealID: deal.dealID,
    template: deal.template,
    actorPlayerID: obligation.obligorPlayerID,
    actorName: obligation.obligorName,
    targetPlayerID: obligation.counterpartyPlayerID,
    targetName: obligation.counterpartyName,
    tone,
    importance,
    publicText,
    ...(statedReason !== null ? { statedReason } : {}),
    step,
    ...(sourceRecord !== null
      ? {
          sourceSequence: sourceRecord.sequence,
          sourceTurnNumber: sourceRecord.turnNumber,
          sourceFallbackUsed:
            sourceRecord.decisionMetadata?.fallbackUsed === true,
          sourceLlmPlannerDegraded:
            sourceRecord.decisionMetadata?.llmPlannerDegraded === true,
          sourceAuditStatus: sourceRecord.audit?.auditStatus ?? "missing",
          ...(sourceRecord.audit?.auditReason !== undefined
            ? { sourceAuditReason: sourceRecord.audit.auditReason }
            : {}),
        }
      : {}),
  };
}

/**
 * Judges the (audited) records of one completed decision step against every
 * pending obligation whose active window covers that step. Same-step actions
 * can never retroactively fulfill or violate: a deal accepted at step N is
 * judged from step N+1 onward (`activeFromStep`), so records of the accept
 * step itself are outside every window they could create.
 */
export function judgeDealComplianceRecords(input: {
  deals: AgentDealState[];
  recordsByPlayerID: ReadonlyMap<string, readonly AgentDecisionRecord[]>;
  stepIndex: number;
}): AgentDealLedgerEvent[] {
  const events: AgentDealLedgerEvent[] = [];
  for (const deal of input.deals) {
    if (deal.status !== "accepted") {
      continue;
    }
    if (
      deal.activeFromStep === null ||
      deal.expiresAfterStep === null ||
      input.stepIndex < deal.activeFromStep ||
      input.stepIndex > deal.expiresAfterStep
    ) {
      continue;
    }
    for (const obligation of deal.obligations) {
      if (obligation.status !== "pending") {
        continue;
      }
      const records =
        input.recordsByPlayerID.get(obligation.obligorPlayerID) ?? [];
      if (isNegativeObligationKind(obligation.kind)) {
        const coverageComplete =
          records.length > 0 &&
          records.every((record) =>
            hasNegativeCovenantCoverage(record, obligation),
          );
        if (!coverageComplete) {
          obligation.auditCoverageComplete = false;
          obligation.auditCoverageGapCount += 1;
        }
      }
      for (const record of records) {
        if (obligation.status !== "pending") {
          break;
        }
        judgeRecordForObligation(
          deal,
          obligation,
          record,
          input.stepIndex,
          events,
        );
      }
    }
  }
  return events;
}

function judgeRecordForObligation(
  deal: AgentDealState,
  obligation: AgentDealObligationState,
  record: AgentDecisionRecord,
  step: number,
  events: AgentDealLedgerEvent[],
): void {
  const label = DEAL_TEMPLATE_LABELS[deal.template];
  // VIEWER-ONLY: the obligor's own words on the decision whose validator-accepted action
  // or confirmed effect resolves this obligation — the betrayal's (or the kept
  // promise's) stated rationale, beside the referee's server-authored verdict
  // but never merged into it. No extra model call: every decision already
  // carries a reason. Null (provider failure / no stated reason) omits it.
  const statedReason = sanitizeDealStatedReason(record.reason);
  const attachStatedReason = () => {
    if (statedReason !== null) {
      obligation.obligorStatedReason = statedReason;
    }
  };
  switch (obligation.kind) {
    case "non_aggression":
    case "trade_security": {
      const hostile = validatedHostileActionAgainst(
        record,
        obligation.counterpartyPlayerID,
      );
      if (hostile !== null) {
        const evidence = `${hostile} on ${obligation.counterpartyName} at step ${step}`;
        resolveObligation(obligation, "violated", step, evidence);
        attachStatedReason();
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_violated",
            "betrayal",
            96,
            `VERDICT: ${obligation.obligorName} violated the pact — ${evidence}.`,
            step,
            record,
            statedReason,
          ),
        );
        return;
      }
      if (obligation.kind === "trade_security") {
        const embargo = validatedManualEmbargoAgainst(
          record,
          obligation.counterpartyPlayerID,
        );
        if (embargo !== null) {
          const evidence = `${embargo} against ${obligation.counterpartyName} at step ${step}`;
          resolveObligation(obligation, "violated", step, evidence);
          attachStatedReason();
          events.push(
            verdictEvent(
              deal,
              obligation,
              "deal_violated",
              "betrayal",
              96,
              `VERDICT: ${obligation.obligorName} violated the ${label} — ${evidence}.`,
              step,
              record,
              statedReason,
            ),
          );
        }
      }
      return;
    }
    case "confirmed_attack_on_target": {
      if (obligation.targetPlayerID === undefined) {
        return;
      }
      const hostile = confirmedJointAttackPressureOn(
        record,
        obligation.targetPlayerID,
      );
      if (hostile !== null) {
        const evidence = `${hostile} on ${obligation.targetName ?? obligation.targetPlayerID} at step ${step}`;
        resolveObligation(obligation, "fulfilled", step, evidence);
        attachStatedReason();
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_fulfilled",
            "pact",
            70,
            `VERDICT: ${obligation.obligorName} fulfilled the ${label} — ${evidence}.`,
            step,
            record,
            statedReason,
          ),
        );
      }
      return;
    }
    case "send_support": {
      const donation = confirmedDonationTo(
        record,
        obligation.counterpartyPlayerID,
      );
      if (donation === null) {
        return;
      }
      obligation.donatedGold += donation.gold;
      obligation.donatedTroops += donation.troops;
      const goldMet =
        obligation.goldAmount !== undefined &&
        obligation.goldAmount > 0n &&
        obligation.donatedGold >= obligation.goldAmount;
      const troopsMet =
        obligation.troopAmount !== undefined &&
        obligation.troopAmount > 0 &&
        obligation.donatedTroops >= obligation.troopAmount;
      if (goldMet || troopsMet) {
        const evidence = `cumulative confirmed donations to ${obligation.counterpartyName} reached ${obligation.donatedGold} gold / ${obligation.donatedTroops} troops at step ${step}`;
        resolveObligation(obligation, "fulfilled", step, evidence);
        attachStatedReason();
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_fulfilled",
            "pact",
            70,
            `VERDICT: ${obligation.obligorName} fulfilled the ${label} — ${evidence}.`,
            step,
            record,
            statedReason,
          ),
        );
      }
      return;
    }
  }
}

function playerEliminated(
  gameState: Game | undefined,
  playerID: string,
): boolean {
  if (gameState === undefined) {
    return false;
  }
  try {
    const player = gameState.player(playerID);
    return player.hasSpawned() && !player.isAlive();
  } catch {
    // Unknown player id: conservatively treated as not eliminated.
    return false;
  }
}

/**
 * moot: counterparty, obligor, or named target eliminated — fulfillment (or
 * violation) impossible through events outside the obligor's control. No
 * spectator event kind exists for moot; it is ledger-only by design.
 */
export function resolveMootObligations(input: {
  deals: AgentDealState[];
  gameState: Game | undefined;
  step: number;
}): void {
  if (input.gameState === undefined) {
    return;
  }
  for (const deal of input.deals) {
    if (deal.status !== "accepted") {
      continue;
    }
    for (const obligation of deal.obligations) {
      if (obligation.status !== "pending") {
        continue;
      }
      if (playerEliminated(input.gameState, obligation.counterpartyPlayerID)) {
        resolveObligation(
          obligation,
          "moot",
          input.step,
          `counterparty ${obligation.counterpartyName} was eliminated`,
        );
        continue;
      }
      if (
        obligation.targetPlayerID !== undefined &&
        playerEliminated(input.gameState, obligation.targetPlayerID)
      ) {
        resolveObligation(
          obligation,
          "moot",
          input.step,
          `named target ${obligation.targetName ?? obligation.targetPlayerID} was eliminated`,
        );
        continue;
      }
      if (playerEliminated(input.gameState, obligation.obligorPlayerID)) {
        resolveObligation(
          obligation,
          "moot",
          input.step,
          `obligor ${obligation.obligorName} was eliminated`,
        );
      }
    }
  }
}

/**
 * Window completion at the start of a step past `expiresAfterStep`: negative
 * covenants that survived a fully covered exact-action window resolve
 * fulfilled; an evidence gap resolves unverified rather than turning missing
 * evidence into praise; positive commitments left unfulfilled resolve
 * expired_unfulfilled (spectator kind deal_expired — an unkept promise is
 * narrated, never punished).
 */
export function resolveElapsedObligations(input: {
  deals: AgentDealState[];
  step: number;
}): AgentDealLedgerEvent[] {
  const events: AgentDealLedgerEvent[] = [];
  for (const deal of input.deals) {
    if (
      deal.status !== "accepted" ||
      deal.expiresAfterStep === null ||
      input.step <= deal.expiresAfterStep
    ) {
      continue;
    }
    const label = DEAL_TEMPLATE_LABELS[deal.template];
    for (const obligation of deal.obligations) {
      if (obligation.status !== "pending") {
        continue;
      }
      if (isNegativeObligationKind(obligation.kind)) {
        if (!obligation.auditCoverageComplete) {
          resolveObligation(
            obligation,
            "unverified",
            input.step,
            `${obligation.auditCoverageGapCount} active decision step(s) lacked complete action evidence`,
          );
          continue;
        }
        const evidence =
          obligation.kind === "trade_security"
            ? `${deal.durationSteps} decisions without a validator-accepted hostile action or new voluntary embargo`
            : `${deal.durationSteps} decisions without a validator-accepted hostile action`;
        resolveObligation(obligation, "fulfilled", input.step, evidence);
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_fulfilled",
            "pact",
            62,
            `${obligation.obligorName} honored the ${label} with ${obligation.counterpartyName}: ${evidence}.`,
            input.step,
          ),
        );
      } else {
        const pledge =
          obligation.kind === "confirmed_attack_on_target"
            ? `pledge to attack ${obligation.targetName ?? obligation.targetPlayerID}`
            : `pledge to support ${obligation.counterpartyName}`;
        resolveObligation(
          obligation,
          "expired_unfulfilled",
          input.step,
          "commitment window elapsed with no qualifying confirmed effect",
        );
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_expired",
            "info",
            58,
            `${obligation.obligorName}'s ${pledge} expired unfulfilled.`,
            input.step,
          ),
        );
      }
    }
  }
  return events;
}

/**
 * Force-resolve at match end: every accepted obligation reaches a terminal
 * state. Any promise whose window was cut short by match end resolves moot so
 * reliability never counts a duration the match did not allow the obligor to
 * complete. A negative covenant whose full window elapsed resolves fulfilled
 * only with complete exact-action coverage; otherwise it resolves unverified. A
 * positive window that ends ON the final step has fully run (finalize judges
 * that step's records first) and resolves expired_unfulfilled. Open proposals
 * expire with the same lapse narration mid-match expiry emits.
 */
export function forceResolveDeals(input: {
  deals: AgentDealState[];
  step: number;
}): AgentDealLedgerEvent[] {
  const events: AgentDealLedgerEvent[] = [];
  for (const deal of input.deals) {
    if (deal.status === "open") {
      // Same lapse narration mid-match TTL expiry emits — match end must not
      // silently swallow an unanswered offer's story beat.
      deal.status = "expired";
      events.push(proposalLapsedEvent(deal, input.step));
      continue;
    }
    if (deal.status !== "accepted") {
      continue;
    }
    const label = DEAL_TEMPLATE_LABELS[deal.template];
    for (const obligation of deal.obligations) {
      if (obligation.status !== "pending") {
        continue;
      }
      if (deal.activeFromStep !== null && deal.activeFromStep > input.step) {
        resolveObligation(
          obligation,
          "moot",
          input.step,
          "match ended before the pact window opened",
          true,
        );
        continue;
      }
      if (isNegativeObligationKind(obligation.kind)) {
        if (
          deal.expiresAfterStep === null ||
          input.step < deal.expiresAfterStep
        ) {
          resolveObligation(
            obligation,
            "moot",
            input.step,
            "match ended before the covenant window elapsed",
            true,
          );
          continue;
        }
        if (!obligation.auditCoverageComplete) {
          resolveObligation(
            obligation,
            "unverified",
            input.step,
            `match ended after ${obligation.auditCoverageGapCount} active decision step(s) lacked complete action evidence`,
            true,
          );
          continue;
        }
        resolveObligation(
          obligation,
          "fulfilled",
          input.step,
          "match ended with no validator-accepted hostile action during the active window",
          true,
        );
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_fulfilled",
            "pact",
            50,
            `${obligation.obligorName} held the ${label} with ${obligation.counterpartyName} to match end with no validator-accepted hostile action.`,
            input.step,
          ),
        );
      } else if (
        deal.expiresAfterStep !== null &&
        // >= : finalize judges the final step's records FIRST, so a window
        // ending exactly on the final step has fully run — an unfulfilled
        // commitment there is a genuinely blown deadline (expired_unfulfilled
        // in the reliability denominator), never moot.
        input.step >= deal.expiresAfterStep
      ) {
        resolveObligation(
          obligation,
          "expired_unfulfilled",
          input.step,
          "commitment window elapsed with no qualifying confirmed effect",
          true,
        );
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_expired",
            "info",
            58,
            `${obligation.obligorName}'s ${label} expired unfulfilled.`,
            input.step,
          ),
        );
      } else {
        resolveObligation(
          obligation,
          "moot",
          input.step,
          "match ended before the commitment window elapsed",
          true,
        );
      }
    }
  }
  return events;
}

/** Public referee aggregate: fulfilled / verified terminal non-moot, per obligor. */
export function dealReliabilityByObligor(deals: readonly AgentDealState[]): Map<
  string,
  {
    fulfilled: number;
    terminalNonMoot: number;
    moot: number;
    unverified: number;
  }
> {
  const result = new Map<
    string,
    {
      fulfilled: number;
      terminalNonMoot: number;
      moot: number;
      unverified: number;
    }
  >();
  for (const deal of deals) {
    for (const obligation of deal.obligations) {
      if (obligation.status === "pending") {
        continue;
      }
      const entry = result.get(obligation.obligorPlayerID) ?? {
        fulfilled: 0,
        terminalNonMoot: 0,
        moot: 0,
        unverified: 0,
      };
      if (obligation.status === "moot") {
        entry.moot += 1;
      } else if (obligation.status === "unverified") {
        entry.unverified += 1;
      } else {
        entry.terminalNonMoot += 1;
        if (obligation.status === "fulfilled") {
          entry.fulfilled += 1;
        }
      }
      result.set(obligation.obligorPlayerID, entry);
    }
  }
  return result;
}

/** Server-authored one-sentence publicText for a new proposal. */
export function dealProposedPublicText(deal: AgentDealState): string {
  switch (deal.template) {
    case "non_aggression_pact":
      return `${deal.proposerName} proposed a non-aggression pact to ${deal.recipientName} (${deal.durationSteps} decisions).`;
    case "trade_security_pact":
      return `${deal.proposerName} proposed a trade-security pact to ${deal.recipientName} (${deal.durationSteps} decisions): non-aggression plus no new voluntary embargo.`;
    case "joint_attack":
      return `${deal.proposerName} pledged to ${deal.recipientName} to attack ${deal.targetName ?? deal.targetPlayerID} within ${deal.durationSteps} decisions.`;
    case "support_request":
      return `${deal.proposerName} asked ${deal.recipientName} for support: at least ${deal.goldAmount ?? 0n} gold or ${deal.troopAmount ?? 0} troops within ${deal.durationSteps} decisions.`;
  }
}

/** Server-authored one-sentence publicText for an acceptance. */
export function dealAcceptedPublicText(deal: AgentDealState): string {
  switch (deal.template) {
    case "non_aggression_pact":
      return `${deal.recipientName} accepted ${deal.proposerName}'s non-aggression pact (${deal.durationSteps} decisions).`;
    case "trade_security_pact":
      return `${deal.recipientName} accepted ${deal.proposerName}'s trade-security pact (${deal.durationSteps} decisions).`;
    case "joint_attack":
      return `${deal.recipientName} accepted ${deal.proposerName}'s pledge to attack ${deal.targetName ?? deal.targetPlayerID} (${deal.durationSteps} decisions).`;
    case "support_request":
      return `${deal.recipientName} agreed to send ${deal.proposerName} at least ${deal.goldAmount ?? 0n} gold or ${deal.troopAmount ?? 0} troops within ${deal.durationSteps} decisions.`;
  }
}

/** Server-authored one-sentence publicText for a rejection. */
export function dealRejectedPublicText(deal: AgentDealState): string {
  return `${deal.recipientName} rejected ${deal.proposerName}'s ${DEAL_TEMPLATE_LABELS[deal.template]}.`;
}

/** deal_expired event for an open proposal that lapsed unanswered. */
export function proposalLapsedEvent(
  deal: AgentDealState,
  step: number,
): AgentDealLedgerEvent {
  return {
    event: "deal_expired",
    dealID: deal.dealID,
    template: deal.template,
    actorPlayerID: deal.recipientPlayerID,
    actorName: deal.recipientName,
    targetPlayerID: deal.proposerPlayerID,
    targetName: deal.proposerName,
    tone: "info",
    importance: 38,
    publicText: `${deal.recipientName} let ${deal.proposerName}'s ${DEAL_TEMPLATE_LABELS[deal.template]} offer expire unanswered.`,
    step,
  };
}
