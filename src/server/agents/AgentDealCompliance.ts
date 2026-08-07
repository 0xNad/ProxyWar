import type { Game } from "../../core/game/Game";
import type {
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
 * Deterministic per-match judge of CONFIRMED game effects only: it reads
 * decision records' result/audit data and live game-state liveness facts,
 * never merely which action a policy selected. Deals never alter any game
 * permission — agents remain free to defect — so the referee narrates
 * follow-through; it never punishes. There is NO hidden morality score and NO
 * rating input; per-agent reliability is a public aggregate
 * (fulfilled / terminal non-moot) exposed for observation and narration only.
 *
 * Detection rules (verified mechanics, docs/OPENFRONT_ECONOMY_NEGOTIATION_
 * VERIFIED.md §2.4-2.5, §3-4):
 * - non_aggression / trade_security violation: a confirmed land attack
 *   launched against the partner (attack record audited `confirmed`, or a NEW
 *   outgoing attack appearing between a record's before/after audit
 *   snapshots — which also catches transport invasion ARRIVAL, since arrival
 *   creates the attack), or a confirmed nuke/MIRV against the partner.
 * - trade_security additionally: a MANUAL embargo created against the partner
 *   (an `embargo`/`embargo_all` ACTION record audited confirmed — embargo_all
 *   counts). The automatic temporary embargo a victim gains by BEING attacked
 *   is never the victim's violation: it appears only in audit snapshots, and
 *   embargo violations are judged exclusively from embargo ACTION records.
 * - Emoji, quick chat, and target markers are never violations.
 * - joint_attack fulfilled only by confirmed attack execution (or confirmed
 *   nuke) against the named third seat within the window.
 * - support_request fulfilled when cumulative confirmed donations of a pledged
 *   resource to the correct recipient reach the explicit amount in the window.
 * - moot: counterparty, obligor, or named target eliminated — fulfillment (or
 *   violation) became impossible through events outside the obligor's control.
 */

export interface AgentDealObligationState {
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
  step: number;
}

export const DEAL_TEMPLATE_LABELS: Record<AgentDealTemplate, string> = {
  non_aggression_pact: "non-aggression pact",
  trade_security_pact: "trade-security pact",
  joint_attack: "joint-attack pledge",
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
          obligorPlayerID: deal.proposerPlayerID,
          obligorName: deal.proposerName,
          counterpartyPlayerID: deal.recipientPlayerID,
          counterpartyName: deal.recipientName,
          kind,
        },
        {
          ...base,
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
 * A confirmed hostile action by this record's player against `targetPlayerID`:
 * a confirmed non-expansion attack record naming the target, a confirmed nuke
 * record naming the target, or a NEW outgoing attack appearing between the
 * before/after audit snapshots (transport invasion arrival shows up here —
 * arrival creates the attack). Returns a short description or null.
 */
function confirmedHostileActionAgainst(
  record: AgentDecisionRecord,
  targetPlayerID: string,
): string | null {
  if (!record.result.accepted) {
    return null;
  }
  const audit = record.audit;
  if (
    record.chosenActionKind === "attack" &&
    record.chosenActionMetadata?.expansion !== true &&
    stringMetadata(record, "targetID") === targetPlayerID &&
    audit?.auditStatus === "confirmed"
  ) {
    return "land attack";
  }
  if (
    record.chosenActionKind === "nuke" &&
    stringMetadata(record, "targetID") === targetPlayerID &&
    audit?.auditStatus === "confirmed"
  ) {
    return "nuclear strike";
  }
  const beforeIDs = audit?.before?.outgoingAttackTargetIDs;
  const afterIDs = audit?.after?.outgoingAttackTargetIDs;
  if (
    beforeIDs !== undefined &&
    afterIDs !== undefined &&
    !beforeIDs.includes(targetPlayerID) &&
    afterIDs.includes(targetPlayerID)
  ) {
    return "confirmed attack";
  }
  return null;
}

/**
 * A MANUAL embargo created against `targetPlayerID` by this record: judged
 * exclusively from confirmed `embargo`/`embargo_all` ACTION records, never
 * from embargo-set snapshot diffs — the automatic temporary embargo a victim
 * gains by being attacked appears only in snapshots and must never be
 * attributed to the victim as a violation.
 */
function confirmedManualEmbargoAgainst(
  record: AgentDecisionRecord,
  targetPlayerID: string,
): string | null {
  if (!record.result.accepted || record.audit?.auditStatus !== "confirmed") {
    return null;
  }
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
    step,
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
  switch (obligation.kind) {
    case "non_aggression":
    case "trade_security": {
      const hostile = confirmedHostileActionAgainst(
        record,
        obligation.counterpartyPlayerID,
      );
      if (hostile !== null) {
        const evidence = `${hostile} on ${obligation.counterpartyName} at step ${step}`;
        resolveObligation(obligation, "violated", step, evidence);
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_violated",
            "betrayal",
            96,
            `VERDICT: ${obligation.obligorName} violated the pact — ${evidence}.`,
            step,
          ),
        );
        return;
      }
      if (obligation.kind === "trade_security") {
        const embargo = confirmedManualEmbargoAgainst(
          record,
          obligation.counterpartyPlayerID,
        );
        if (embargo !== null) {
          const evidence = `${embargo} against ${obligation.counterpartyName} at step ${step}`;
          resolveObligation(obligation, "violated", step, evidence);
          events.push(
            verdictEvent(
              deal,
              obligation,
              "deal_violated",
              "betrayal",
              96,
              `VERDICT: ${obligation.obligorName} violated the ${label} — ${evidence}.`,
              step,
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
      const hostile = confirmedHostileActionAgainst(
        record,
        obligation.targetPlayerID,
      );
      if (hostile !== null) {
        const evidence = `${hostile} on ${obligation.targetName ?? obligation.targetPlayerID} at step ${step}`;
        resolveObligation(obligation, "fulfilled", step, evidence);
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_fulfilled",
            "pact",
            70,
            `VERDICT: ${obligation.obligorName} fulfilled the ${label} — ${evidence}.`,
            step,
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
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_fulfilled",
            "pact",
            70,
            `VERDICT: ${obligation.obligorName} fulfilled the ${label} — ${evidence}.`,
            step,
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
}): AgentDealLedgerEvent[] {
  if (input.gameState === undefined) {
    return [];
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
  return [];
}

/**
 * Window completion at the start of a step past `expiresAfterStep`: negative
 * covenants that survived the whole window resolve fulfilled; positive
 * commitments left unfulfilled resolve expired_unfulfilled (spectator kind
 * deal_expired — an unkept promise is narrated, never punished).
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
        const evidence =
          obligation.kind === "trade_security"
            ? `${deal.durationSteps} decisions without a confirmed hostile action or new voluntary embargo`
            : `${deal.durationSteps} decisions without a confirmed hostile action`;
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
 * state. Negative covenants still pending resolve fulfilled (no confirmed
 * violation occurred while active); positive commitments whose window was cut
 * short by match end resolve moot (impossible through an event outside the
 * obligor's control) so reliability never counts a promise the match gave no
 * time to keep.
 */
export function forceResolveDeals(input: {
  deals: AgentDealState[];
  step: number;
}): AgentDealLedgerEvent[] {
  const events: AgentDealLedgerEvent[] = [];
  for (const deal of input.deals) {
    if (deal.status === "open") {
      deal.status = "expired";
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
        resolveObligation(
          obligation,
          "fulfilled",
          input.step,
          "match ended with no confirmed violation during the active window",
          true,
        );
        events.push(
          verdictEvent(
            deal,
            obligation,
            "deal_fulfilled",
            "pact",
            50,
            `${obligation.obligorName} held the ${label} with ${obligation.counterpartyName} to match end with no confirmed violation.`,
            input.step,
          ),
        );
      } else if (
        deal.expiresAfterStep !== null &&
        input.step > deal.expiresAfterStep
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

/** Public referee aggregate: fulfilled / terminal non-moot, per obligor. */
export function dealReliabilityByObligor(
  deals: readonly AgentDealState[],
): Map<string, { fulfilled: number; terminalNonMoot: number; moot: number }> {
  const result = new Map<
    string,
    { fulfilled: number; terminalNonMoot: number; moot: number }
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
      };
      if (obligation.status === "moot") {
        entry.moot += 1;
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
