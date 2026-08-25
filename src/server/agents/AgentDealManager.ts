import type { Game } from "../../core/game/Game";
import {
  buildDealObligations,
  dealAcceptedPublicText,
  dealProposedPublicText,
  dealRejectedPublicText,
  dealReliabilityByObligor,
  dealSupersededPublicText,
  forceResolveDeals,
  judgeDealComplianceRecords,
  proposalLapsedEvent,
  resolveElapsedObligations,
  resolveMootObligations,
  sanitizeDealStatedReason,
  type AgentDealLedgerEvent,
  type AgentDealObligationState,
  type AgentDealState,
} from "./AgentDealCompliance";
import {
  agentDealTemplates,
  type AgentActiveDealView,
  type AgentDealObligationView,
  type AgentDealProposalOptionView,
  type AgentDealProposalView,
  type AgentDealRivalReliabilityView,
  type AgentDealsObservation,
  type AgentDealTemplate,
  type AgentDealTermsView,
  type AgentDecisionRecord,
  type AgentObservation,
  type AgentVisiblePlayer,
  type LegalAction,
  type LegalActionKind,
} from "./AgentTypes";

/**
 * Deterministic per-match structured-deal ledger
 * (PROXYWAR_TUNE_STRUCTURED_DEALS, default OFF — economy+negotiation V1
 * Phase B). Owned by the league match runner beside the existing
 * communication-signal machinery: deals are runner-scoped meta-state — the
 * core Intent union, Schemas.ts, and replay determinism are untouched, and
 * deal actions are `intent: null` meta-actions (the `hold` precedent).
 *
 * Timing (the runner's decision-step semantics): a proposal applied during
 * step N's submission pass becomes visible in observations at step N+1; an
 * acceptance applied at step N+1 makes the deal active — obligations judging
 * confirmed effects — from step N+2; same-step actions can never
 * retroactively fulfill or violate. Tick/turn timestamps are retained in the
 * ledger for audit.
 *
 * Privacy: a bilateral proposal/deal appears only in the two parties'
 * observations (`observationFor` filters by seat); the per-rival reliability
 * aggregate is public referee output and carries no bilateral terms. Agents'
 * OWN stated reasons are captured for the ledger and viewer artifacts and are
 * never surfaced to any agent (`AgentDealState.proposerStatedReason`).
 *
 * Slot: a deal action may be selected either as the decision's single game
 * action (the original shape) or through `AgentDecision.dealActionID`, the
 * optional second selection applied alongside the game action so negotiating
 * costs no move. Proposals are paced by DEAL_ACTION_COOLDOWN_STEPS;
 * responses never are.
 */

export const DEAL_ACTION_KINDS = [
  "deal_propose",
  "deal_accept",
  "deal_reject",
  "deal_withdraw",
] as const satisfies readonly LegalActionKind[];

const DEAL_ACTION_KIND_SET: ReadonlySet<string> = new Set(DEAL_ACTION_KINDS);

export function isDealActionKind(kind: string): boolean {
  return DEAL_ACTION_KIND_SET.has(kind);
}

/**
 * Minimum decision steps between two PROPOSALS by the same agent.
 *
 * Deals no longer compete with the game action for the decision's single
 * action slot (`AgentDecision.dealActionID`), so nothing else paces
 * negotiation: without this an agent could open a new offer every single
 * step, filling every rival's menu with noise and making a pact worth
 * nothing. The limit is enforced BOTH in `applyPropose` (a proposal inside
 * the window fails loudly) and in `proposalOptionsFor` (no propose option is
 * offered at all while the agent is on cooldown — a model should never be
 * shown a move it cannot make).
 *
 * It applies to `deal_propose` ONLY. Accept / reject / withdraw stay
 * available every step: a response can only exist while an offer addressed to
 * this agent is open, and every proposer is itself paced by this cooldown and
 * by DEAL_PROPOSAL_TTL_STEPS, so answers cannot be spammed either. A cooldown
 * on answers would instead let offers die unanswered purely because the
 * recipient recently spoke — the opposite of the drama this system exists to
 * produce. Withdrawing is de-escalation and is likewise never blocked.
 */
export const DEAL_ACTION_COOLDOWN_STEPS = 3;

/** Open proposals expire silently after this many unanswered steps. */
export const DEAL_PROPOSAL_TTL_STEPS = 4;
/**
 * DEFENSE IN DEPTH — UNREACHABLE under the current constants. A proposer may
 * open an offer only every DEAL_ACTION_COOLDOWN_STEPS (3) steps and an open
 * offer lapses DEAL_PROPOSAL_TTL_STEPS (4) steps after it was made, so
 * proposals at steps N and N+3 are the most that can be open at once (the
 * step-N one expires at N+5, before a third is even legal at N+6). Both
 * guards below therefore never fire today and have no direct test. They stay
 * because they are the STATE invariant, not a restatement of the pacing: any
 * future change to the cooldown, the TTL, or a bulk/backfilled proposal path
 * would make them load-bearing again, and the failure they produce is loud.
 */
export const MAX_OPEN_PROPOSALS_PER_ORDERED_PAIR = 2;
export const MAX_ACTIVE_DEALS_PER_AGENT = 6;
export const MIN_DEAL_DURATION_STEPS = 3;
export const MAX_DEAL_DURATION_STEPS = 20;

/**
 * V1 canonical durations per template (one enumerated offer per
 * recipient+template — zero free text, so terms carry no negotiable knobs).
 */
const DEFAULT_DURATION_STEPS: Record<AgentDealTemplate, number> = {
  non_aggression_pact: 12,
  trade_security_pact: 12,
  joint_attack: 8,
  support_request: 6,
};

/**
 * support_request EXPLICIT amounts (the core donate-gold null-amount bug
 * silently sends 0 — verified doc §4 — so amounts are always explicit).
 */
export const DEAL_SUPPORT_GOLD_AMOUNT = 50_000n;
export const DEAL_SUPPORT_TROOP_AMOUNT = 5_000;

const OBSERVATION_PROPOSAL_CAP = 6;
const OBSERVATION_ACTIVE_DEAL_CAP = 8;
const OBSERVATION_PROPOSAL_OPTION_CAP = 8;
const OBSERVATION_RELIABILITY_CAP = 8;

export interface AgentDealActionOutcome {
  result: { accepted: boolean; reason: string; submittedIntent: null };
  /** Flat metadata stamps for the decision record (permissive surface). */
  stamps: Record<string, string | number | boolean | null>;
}

interface AgentDealConflictCandidate {
  template: AgentDealTemplate;
  proposerPlayerID: string;
  recipientPlayerID: string;
  durationSteps: number;
  targetPlayerID?: string;
  goldAmount?: bigint | string;
  troopAmount?: number;
}

export interface AgentDealLedgerSnapshot {
  /** True only after match-end force resolution has completed. */
  finalized: boolean;
  finalizedAtStep: number | null;
  finalizedAtTurn: number | null;
  /** Maps every decision-step window to its authoritative game turn. */
  decisionSteps: Array<{
    step: number;
    turnNumber: number;
    recordsBeforeStep: number;
  }>;
  deals: Array<
    Omit<AgentDealState, "goldAmount" | "troopAmount" | "obligations"> & {
      goldAmount?: string;
      troopAmount?: number;
      obligations: Array<
        Omit<AgentDealObligationState, "goldAmount" | "donatedGold"> & {
          goldAmount?: string;
          donatedGold: string;
        }
      >;
    }
  >;
  events: AgentDealLedgerEvent[];
  /**
   * Bounded public proof of validator-accepted diplomacy-slot selections. It
   * carries server-authored offered IDs, the exact validated selection, a
   * manager-application boolean, and the bounded terminal cause/link for a
   * redundant accept. Rejected agent input, free-text reasons, prompts, and
   * the primary action stay out.
   */
  actionEvidence: AgentDealActionEvidence[];
}

export interface AgentDealActionEvidence {
  sequence: number;
  turnNumber: number;
  actorPlayerID: string | null;
  actorName: string;
  offeredActionIDs: string[];
  selectedActionID: string;
  selectedActionKind:
    | "deal_propose"
    | "deal_accept"
    | "deal_reject"
    | "deal_withdraw";
  managerApplied: boolean;
  /** Engine-authored terminal cause for a validated but redundant accept. */
  terminalCause?: "redundant_accept_superseded";
  /** Exact accepted deal that made the selected proposal redundant. */
  supersededByDealID?: string;
  sourceFallbackUsed: boolean;
  sourceLlmPlannerDegraded: boolean;
}

export class AgentDealManager {
  private readonly deals: AgentDealState[] = [];
  private readonly events: AgentDealLedgerEvent[] = [];
  private readonly agentIDByPlayerID = new Map<string, string>();
  private readonly playerIDByAgentID = new Map<string, string>();
  private readonly pendingStampsByAgentID = new Map<
    string,
    AgentDealLedgerEvent[]
  >();
  private actionEvidence: AgentDealActionEvidence[] = [];
  /** Decision step of each player's last ACCEPTED proposal (cooldown clock). */
  private readonly lastProposalStepByPlayerID = new Map<string, number>();
  private currentStep = -1;
  private currentTurnNumber = 0;
  private readonly stepStartSequence: number[] = [];
  private readonly stepTurnNumbers: number[] = [];
  private finalized = false;
  private finalizedAtTurn: number | null = null;

  currentDecisionStep(): number {
    return this.currentStep;
  }

  /**
   * Decision steps this player must still wait before it may propose again
   * (0 = may propose now). Proposal cooldown only — responses are never
   * gated. See `DEAL_ACTION_COOLDOWN_STEPS`.
   */
  proposalCooldownRemainingSteps(playerID: string): number {
    const last = this.lastProposalStepByPlayerID.get(playerID);
    if (last === undefined) {
      return 0;
    }
    return Math.max(0, DEAL_ACTION_COOLDOWN_STEPS - (this.currentStep - last));
  }

  /**
   * Called once at the top of every league decision turn, BEFORE observations
   * are built: advances the deal clock, expires lapsed proposals, judges the
   * just-completed step's audited records (confirmed effects only), resolves
   * moot and elapsed obligations, and queues the resulting ledger events as
   * pending record stamps.
   */
  beginDecisionStep(input: {
    turnNumber: number;
    gameState?: Game;
    records: readonly AgentDecisionRecord[];
  }): void {
    if (this.finalized) {
      throw new Error("deal ledger is finalized");
    }
    this.currentStep += 1;
    this.stepStartSequence.push(input.records.length);
    this.stepTurnNumbers.push(input.turnNumber);
    this.currentTurnNumber = input.turnNumber;

    const events: AgentDealLedgerEvent[] = [];
    for (const deal of this.deals) {
      if (
        deal.status === "open" &&
        this.currentStep > deal.answerableThroughStep
      ) {
        deal.status = "expired";
        events.push(proposalLapsedEvent(deal, this.currentStep));
      }
    }

    const recordsByPlayerID = new Map<string, AgentDecisionRecord[]>();
    if (this.currentStep > 0) {
      const previousStep = this.currentStep - 1;
      const start = this.stepStartSequence[previousStep];
      const end = this.stepStartSequence[this.currentStep];
      for (const record of input.records.slice(start, end)) {
        const playerID = this.playerIDByAgentID.get(record.agentID);
        if (playerID === undefined) {
          continue;
        }
        const list = recordsByPlayerID.get(playerID) ?? [];
        list.push(record);
        recordsByPlayerID.set(playerID, list);
      }
      events.push(
        ...judgeDealComplianceRecords({
          deals: this.deals,
          recordsByPlayerID,
          stepIndex: previousStep,
        }),
      );
    }
    // Moot resolutions are deliberately event-silent (ledger-only).
    resolveMootObligations({
      deals: this.deals,
      gameState: input.gameState,
      step: this.currentStep,
    });
    events.push(
      ...resolveElapsedObligations({
        deals: this.deals,
        step: this.currentStep,
      }),
    );
    this.queueEvents(
      events.map((event) =>
        event.sourceTurnNumber === undefined
          ? { ...event, sourceTurnNumber: input.turnNumber }
          : event,
      ),
      recordsByPlayerID,
    );
  }

  /**
   * The bilateral deals block for one agent's observation, or undefined when
   * the agent has no live post-spawn seat. Registers the agent's seat and
   * every visible player's display name as a side effect. Capped and
   * stable-sorted; only this agent's own proposals/deals are included.
   */
  observationFor(input: {
    agentID: string;
    observation: AgentObservation;
  }): AgentDealsObservation | undefined {
    const ownState = input.observation.ownState;
    if (
      ownState === null ||
      input.observation.phase !== "active" ||
      ownState.isAlive === false ||
      ownState.playerID.length === 0
    ) {
      return undefined;
    }
    this.registerSeat(input.agentID, ownState.playerID);

    const playerID = ownState.playerID;
    // Executable view only: keep a blocked crossed proposal truthfully open
    // in the ledger, but do not keep offering accept/reject after an equivalent
    // pact became active. The proposer-facing outgoing view below deliberately
    // remains unfiltered so its owner can explicitly withdraw the open offer.
    const incomingProposals = this.deals
      .filter(
        (deal) =>
          deal.status === "open" &&
          deal.recipientPlayerID === playerID &&
          deal.proposedAtStep < this.currentStep &&
          this.currentStep <= deal.answerableThroughStep &&
          this.activeDealConflictFor(deal) === null,
      )
      .sort((a, b) => a.dealID.localeCompare(b.dealID))
      .slice(0, OBSERVATION_PROPOSAL_CAP)
      .map((deal) => this.proposalView(deal));
    const outgoingProposals = this.deals
      .filter(
        (deal) => deal.status === "open" && deal.proposerPlayerID === playerID,
      )
      .sort((a, b) => a.dealID.localeCompare(b.dealID))
      .slice(0, OBSERVATION_PROPOSAL_CAP)
      .map((deal) => this.proposalView(deal));
    const activeDeals = this.deals
      .filter(
        (deal) =>
          deal.status === "accepted" &&
          (deal.proposerPlayerID === playerID ||
            deal.recipientPlayerID === playerID) &&
          deal.obligations.some(
            (obligation) => obligation.status === "pending",
          ),
      )
      .sort((a, b) => a.dealID.localeCompare(b.dealID))
      .slice(0, OBSERVATION_ACTIVE_DEAL_CAP)
      .map((deal) => this.activeDealView(deal));

    return {
      decisionStep: this.currentStep,
      incomingProposals,
      outgoingProposals,
      activeDeals,
      proposalOptions: this.proposalOptionsFor(playerID, input.observation),
      rivalReliability: this.rivalReliabilityFor(playerID),
    };
  }

  /**
   * Applies one selected deal meta-action during the runner's sequential
   * submission pass (participant order, same step). Deterministic conflict
   * resolution: earlier submissions in the pass win (a withdraw applied
   * before an accept makes the accept fail loudly, never silently).
   */
  applyDealAction(input: {
    agentID: string;
    playerID: string | null;
    playerName: string;
    action: LegalAction;
    turnNumber: number;
    /**
     * The acting decision's OWN stated reason (`AgentDecision.reason`), or
     * null when there is none. VIEWER-ONLY: sanitized and stored for the
     * ledger/telemetry story beat, never surfaced to any agent.
     */
    statedReason?: string | null;
  }): AgentDealActionOutcome {
    if (this.finalized) {
      throw new Error("deal ledger is finalized");
    }
    const kind = input.action.kind;
    const dealAction = kind.replace("deal_", "");
    if (input.playerID === null || input.playerID.length === 0) {
      return this.failure(dealAction, "deal actor has no player id");
    }
    // Belt-and-braces guard: the callers (runner action slot and the deal
    // slot's validator) already reject non-deal kinds. A deal action carries
    // `intent: null`, so nothing here can ever reach the game.
    if (!isDealActionKind(kind)) {
      return this.failure(dealAction, `not a deal action kind: ${kind}`);
    }
    this.registerSeat(input.agentID, input.playerID);
    switch (kind) {
      case "deal_propose":
        return this.applyPropose(input, input.playerID);
      case "deal_accept":
      case "deal_reject":
      case "deal_withdraw":
        return this.applyResponse(kind, input, input.playerID);
      default:
        return this.failure(dealAction, `not a deal action kind: ${kind}`);
    }
  }

  /**
   * Drains queued referee/lifecycle events for this agent's next decision
   * record as the `dealComplianceEvent` metadata value (a JSON array string on
   * the permissive decisions.jsonl surface). Returns null when nothing is
   * queued.
   */
  takePendingComplianceStamp(agentID: string): string | null {
    const pending = this.pendingStampsByAgentID.get(agentID);
    if (pending === undefined || pending.length === 0) {
      return null;
    }
    this.pendingStampsByAgentID.delete(agentID);
    return JSON.stringify(pending);
  }

  /**
   * Force-resolve at match end: judges the final step's audited records, then
   * drives every remaining open proposal and pending obligation to a terminal
   * state. Idempotent.
   */
  finalize(input: {
    gameState?: Game;
    records: readonly AgentDecisionRecord[];
    /** Authoritative match-end turn; falls back to the final step's start. */
    turnNumber?: number;
  }): void {
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    this.finalizedAtTurn =
      input.turnNumber ??
      (this.currentStep >= 0 ? this.currentTurnNumber : null);
    this.actionEvidence = input.records
      .filter(
        (record) =>
          record.dealSlotEvidence?.validation.accepted === true &&
          record.dealSlotEvidence.application.attempted === true,
      )
      .map((record) => {
        const evidence = record.dealSlotEvidence!;
        if (!evidence.validation.accepted || !evidence.application.attempted) {
          throw new Error("accepted deal action evidence invariant failed");
        }
        const supersededByDealID =
          typeof record.decisionMetadata?.dealSupersededByDealID === "string"
            ? record.decisionMetadata.dealSupersededByDealID
            : null;
        const terminallySuperseded =
          record.decisionMetadata?.dealTerminalCause ===
            "redundant_accept_superseded" && supersededByDealID !== null;
        return {
          sequence: record.sequence,
          turnNumber: record.turnNumber,
          actorPlayerID: this.playerIDByAgentID.get(record.agentID) ?? null,
          actorName: record.username,
          offeredActionIDs: DEAL_ACTION_KINDS.flatMap(
            (kind) => record.legalActionIDsByKind[kind] ?? [],
          ),
          selectedActionID: evidence.validation.actionID,
          selectedActionKind: evidence.validation.actionKind,
          managerApplied: evidence.application.accepted,
          ...(terminallySuperseded
            ? {
                terminalCause: "redundant_accept_superseded" as const,
                supersededByDealID: supersededByDealID!,
              }
            : {}),
          sourceFallbackUsed: record.decisionMetadata?.fallbackUsed === true,
          sourceLlmPlannerDegraded:
            record.decisionMetadata?.llmPlannerDegraded === true,
        };
      });
    const events: AgentDealLedgerEvent[] = [];
    if (this.currentStep >= 0) {
      const start = this.stepStartSequence[this.currentStep];
      const recordsByPlayerID = new Map<string, AgentDecisionRecord[]>();
      for (const record of input.records.slice(start)) {
        const playerID = this.playerIDByAgentID.get(record.agentID);
        if (playerID === undefined) {
          continue;
        }
        const list = recordsByPlayerID.get(playerID) ?? [];
        list.push(record);
        recordsByPlayerID.set(playerID, list);
      }
      events.push(
        ...judgeDealComplianceRecords({
          deals: this.deals,
          recordsByPlayerID,
          stepIndex: this.currentStep,
        }),
      );
    }
    // Moot resolutions are deliberately event-silent (ledger-only).
    resolveMootObligations({
      deals: this.deals,
      gameState: input.gameState,
      step: this.currentStep,
    });
    events.push(
      ...forceResolveDeals({ deals: this.deals, step: this.currentStep }),
    );
    const terminalEvents = events.map((event) =>
      event.sourceTurnNumber === undefined && this.finalizedAtTurn !== null
        ? { ...event, sourceTurnNumber: this.finalizedAtTurn }
        : event,
    );
    this.events.push(...terminalEvents);
    // No future decision exists after finalize, so persist both newly-created
    // final events and any still-queued earlier events onto the latest retained
    // carrier records. This keeps decisions.jsonl sufficient for replay/mirror
    // reconstruction while each verdict retains its own origin provenance.
    const unstamped = [
      ...[...this.pendingStampsByAgentID.values()].flat(),
      ...terminalEvents,
    ];
    this.pendingStampsByAgentID.clear();
    this.persistFinalEventStamps(unstamped, input.records);
  }

  /** Full serializable ledger (operator/test surface — sees everything). */
  ledgerSnapshot(): AgentDealLedgerSnapshot {
    return {
      finalized: this.finalized,
      finalizedAtStep: this.finalized ? this.currentStep : null,
      finalizedAtTurn: this.finalized ? this.finalizedAtTurn : null,
      decisionSteps: this.stepStartSequence.map((recordsBeforeStep, step) => ({
        step,
        turnNumber: this.stepTurnNumbers[step] ?? 0,
        recordsBeforeStep,
      })),
      deals: this.deals
        .map((deal) => ({
          ...deal,
          goldAmount:
            deal.goldAmount === undefined ? undefined : `${deal.goldAmount}`,
          troopAmount: deal.troopAmount,
          obligations: deal.obligations
            .map((obligation) => ({
              ...obligation,
              goldAmount:
                obligation.goldAmount === undefined
                  ? undefined
                  : `${obligation.goldAmount}`,
              donatedGold: `${obligation.donatedGold}`,
            }))
            .sort((a, b) =>
              stableStringCompare(a.obligationID, b.obligationID),
            ),
        }))
        .sort((a, b) => stableStringCompare(a.dealID, b.dealID)),
      // Application/referee append order is causal order. It is already
      // deterministic (participant-ordered submission pass + deterministic
      // compliance walk); lexical re-sorting can invert same-step causes.
      events: this.events.map((event) => ({ ...event })),
      actionEvidence: this.actionEvidence.map((evidence) => ({
        ...evidence,
        offeredActionIDs: [...evidence.offeredActionIDs],
      })),
    };
  }

  private registerSeat(agentID: string, playerID: string): void {
    this.agentIDByPlayerID.set(playerID, agentID);
    this.playerIDByAgentID.set(agentID, playerID);
  }

  private failure(
    dealAction: string,
    reason: string,
    dealID?: string,
  ): AgentDealActionOutcome {
    return {
      result: { accepted: false, reason, submittedIntent: null },
      stamps: {
        dealAction,
        dealApplyAccepted: false,
        ...(dealID !== undefined ? { dealID } : {}),
      },
    };
  }

  private applyPropose(
    input: {
      agentID: string;
      playerName: string;
      action: LegalAction;
      turnNumber: number;
      statedReason?: string | null;
    },
    proposerPlayerID: string,
  ): AgentDealActionOutcome {
    const cooldown = this.proposalCooldownRemainingSteps(proposerPlayerID);
    if (cooldown > 0) {
      return this.failure(
        "propose",
        `proposal cooldown active (${cooldown} more decision step${
          cooldown === 1 ? "" : "s"
        }; one proposal per ${DEAL_ACTION_COOLDOWN_STEPS} steps)`,
      );
    }
    const metadata = input.action.metadata ?? {};
    const recipientPlayerID =
      typeof metadata.recipientID === "string" ? metadata.recipientID : null;
    const template =
      typeof metadata.template === "string" &&
      (agentDealTemplates as readonly string[]).includes(metadata.template)
        ? (metadata.template as AgentDealTemplate)
        : null;
    if (recipientPlayerID === null || template === null) {
      return this.failure(
        "propose",
        "deal_propose action carries no recipient/template metadata",
      );
    }
    if (recipientPlayerID === proposerPlayerID) {
      return this.failure("propose", "cannot propose a deal to yourself");
    }
    const openFromMe = this.deals.filter(
      (deal) =>
        deal.status === "open" &&
        deal.proposerPlayerID === proposerPlayerID &&
        deal.recipientPlayerID === recipientPlayerID,
    );
    // Unreachable under the current cooldown/TTL pair — see the constant's
    // own doc. Kept as the state invariant, not as live pacing.
    if (openFromMe.length >= MAX_OPEN_PROPOSALS_PER_ORDERED_PAIR) {
      return this.failure(
        "propose",
        `open-proposal cap reached for this pair (${MAX_OPEN_PROPOSALS_PER_ORDERED_PAIR})`,
      );
    }
    if (openFromMe.some((deal) => deal.template === template)) {
      return this.failure(
        "propose",
        `an open ${template} proposal to this recipient already exists`,
      );
    }
    if (
      this.activeDealCount(proposerPlayerID) >= MAX_ACTIVE_DEALS_PER_AGENT ||
      this.activeDealCount(recipientPlayerID) >= MAX_ACTIVE_DEALS_PER_AGENT
    ) {
      return this.failure(
        "propose",
        `active-deal cap reached (${MAX_ACTIVE_DEALS_PER_AGENT} per agent)`,
      );
    }

    const durationSteps = clampDuration(
      typeof metadata.durationSteps === "number"
        ? metadata.durationSteps
        : DEFAULT_DURATION_STEPS[template],
    );
    const recipientName =
      typeof metadata.recipientName === "string"
        ? metadata.recipientName
        : recipientPlayerID;
    const deal: AgentDealState = {
      dealID: `deal:${proposerPlayerID}:${recipientPlayerID}:${template}:${this.currentStep}`,
      template,
      proposerPlayerID,
      proposerName: input.playerName,
      recipientPlayerID,
      recipientName,
      status: "open",
      durationSteps,
      proposedAtStep: this.currentStep,
      proposedAtTurn: input.turnNumber,
      answerableThroughStep: this.currentStep + DEAL_PROPOSAL_TTL_STEPS,
      respondedAtStep: null,
      respondedAtTurn: null,
      activeFromStep: null,
      expiresAfterStep: null,
      obligations: [],
    };
    if (template === "joint_attack") {
      const targetID =
        typeof metadata.targetID === "string" ? metadata.targetID : null;
      if (targetID === null) {
        return this.failure(
          "propose",
          "joint_attack proposal carries no named target",
        );
      }
      deal.targetPlayerID = targetID;
      deal.targetName =
        typeof metadata.targetName === "string"
          ? metadata.targetName
          : targetID;
    }
    if (template === "support_request") {
      deal.goldAmount = DEAL_SUPPORT_GOLD_AMOUNT;
      deal.troopAmount = DEAL_SUPPORT_TROOP_AMOUNT;
    }
    if (this.activeDealConflictFor(deal) !== null) {
      return this.failure(
        "propose",
        `an equivalent active ${template} between this pair already exists`,
      );
    }
    // VIEWER-ONLY: the proposer's own one-line rationale for this offer. No
    // extra model call — the decision already produced it. Sanitized here,
    // omitted entirely when the brain stated none (never substituted).
    const statedReason = sanitizeDealStatedReason(input.statedReason);
    if (statedReason !== null) {
      deal.proposerStatedReason = statedReason;
    }
    this.deals.push(deal);
    this.lastProposalStepByPlayerID.set(proposerPlayerID, this.currentStep);
    const publicText = dealProposedPublicText(deal);
    this.events.push({
      event: "deal_proposed",
      dealID: deal.dealID,
      template,
      actorPlayerID: proposerPlayerID,
      actorName: deal.proposerName,
      targetPlayerID: recipientPlayerID,
      targetName: deal.recipientName,
      tone: "info",
      importance: 55,
      publicText,
      ...(statedReason !== null ? { statedReason } : {}),
      step: this.currentStep,
    });
    return {
      result: {
        accepted: true,
        reason: `deal proposed: ${deal.dealID}`,
        submittedIntent: null,
      },
      stamps: {
        dealAction: "propose",
        dealID: deal.dealID,
        dealTemplate: template,
        dealCounterpartyID: recipientPlayerID,
        dealCounterpartyName: deal.recipientName,
        dealDurationSteps: durationSteps,
        ...(deal.targetPlayerID !== undefined
          ? {
              dealTargetID: deal.targetPlayerID,
              dealTargetName: deal.targetName ?? deal.targetPlayerID,
            }
          : {}),
        ...(deal.goldAmount !== undefined
          ? {
              dealGoldAmount: `${deal.goldAmount}`,
              dealTroopAmount: deal.troopAmount ?? 0,
            }
          : {}),
        dealApplyAccepted: true,
        dealPublicText: publicText,
        ...(statedReason !== null ? { dealStatedReason: statedReason } : {}),
      },
    };
  }

  private applyResponse(
    kind: "deal_accept" | "deal_reject" | "deal_withdraw",
    input: {
      agentID: string;
      playerName: string;
      action: LegalAction;
      turnNumber: number;
      statedReason?: string | null;
    },
    actorPlayerID: string,
  ): AgentDealActionOutcome {
    const dealAction = kind.replace("deal_", "");
    const metadata = input.action.metadata ?? {};
    const dealID =
      typeof metadata.dealID === "string"
        ? metadata.dealID
        : input.action.id.startsWith(`${kind}:`)
          ? input.action.id.slice(kind.length + 1)
          : null;
    if (dealID === null) {
      return this.failure(dealAction, `${kind} action names no dealID`);
    }
    const deal = this.deals.find((candidate) => candidate.dealID === dealID);
    if (deal === undefined) {
      return this.failure(dealAction, `unknown deal: ${dealID}`, dealID);
    }
    if (deal.status !== "open") {
      return this.failure(
        dealAction,
        `deal is not open (status: ${deal.status})`,
        dealID,
      );
    }
    if (kind === "deal_withdraw") {
      if (deal.proposerPlayerID !== actorPlayerID) {
        return this.failure(
          dealAction,
          "only the proposer may withdraw a proposal",
          dealID,
        );
      }
      deal.status = "withdrawn";
      deal.respondedAtStep = this.currentStep;
      deal.respondedAtTurn = input.turnNumber;
      return {
        result: {
          accepted: true,
          reason: `deal withdrawn: ${dealID}`,
          submittedIntent: null,
        },
        stamps: {
          dealAction: "withdraw",
          dealID,
          dealTemplate: deal.template,
          dealCounterpartyID: deal.recipientPlayerID,
          dealCounterpartyName: deal.recipientName,
          dealApplyAccepted: true,
        },
      };
    }
    if (deal.recipientPlayerID !== actorPlayerID) {
      return this.failure(
        dealAction,
        "only the recipient may answer a proposal",
        dealID,
      );
    }
    if (deal.proposedAtStep >= this.currentStep) {
      return this.failure(
        dealAction,
        "a proposal becomes answerable one decision step after it is made",
        dealID,
      );
    }
    deal.respondedAtStep = this.currentStep;
    deal.respondedAtTurn = input.turnNumber;
    if (kind === "deal_reject") {
      deal.status = "rejected";
      const publicText = dealRejectedPublicText(deal);
      this.events.push({
        event: "deal_rejected",
        dealID,
        template: deal.template,
        actorPlayerID,
        actorName: deal.recipientName,
        targetPlayerID: deal.proposerPlayerID,
        targetName: deal.proposerName,
        tone: "info",
        importance: 45,
        publicText,
        step: this.currentStep,
      });
      return {
        result: {
          accepted: true,
          reason: `deal rejected: ${dealID}`,
          submittedIntent: null,
        },
        stamps: {
          dealAction: "reject",
          dealID,
          dealTemplate: deal.template,
          dealCounterpartyID: deal.proposerPlayerID,
          dealCounterpartyName: deal.proposerName,
          dealApplyAccepted: true,
          dealPublicText: publicText,
        },
      };
    }
    const supersedingDeal = this.activeDealConflictFor(deal);
    if (supersedingDeal !== null) {
      deal.status = "superseded";
      deal.supersededByDealID = supersedingDeal.dealID;
      const publicText = dealSupersededPublicText(deal);
      const event: AgentDealLedgerEvent = {
        event: "deal_superseded",
        dealID,
        template: deal.template,
        actorPlayerID,
        actorName: deal.recipientName,
        targetPlayerID: deal.proposerPlayerID,
        targetName: deal.proposerName,
        tone: "info",
        importance: 42,
        publicText,
        supersededByDealID: supersedingDeal.dealID,
        step: this.currentStep,
      };
      this.events.push(event);
      // Use the same bounded queued channel as every other state-derived
      // lifecycle fact. AgentLeagueMatch drains it onto this decision after
      // applying the deal slot, so an already-pending compliance event and
      // this terminal response are serialized together instead of competing
      // for (and overwriting) the one dealComplianceEvent metadata key.
      const pending = this.pendingStampsByAgentID.get(input.agentID) ?? [];
      pending.push(event);
      this.pendingStampsByAgentID.set(input.agentID, pending);
      const reason =
        `redundant accept superseded by equivalent accepted deal: ` +
        supersedingDeal.dealID;
      return {
        result: { accepted: false, reason, submittedIntent: null },
        stamps: {
          dealAction: "accept",
          dealID,
          dealTemplate: deal.template,
          dealCounterpartyID: deal.proposerPlayerID,
          dealCounterpartyName: deal.proposerName,
          dealApplyAccepted: false,
          dealTerminalCause: "redundant_accept_superseded",
          dealSupersededByDealID: supersedingDeal.dealID,
        },
      };
    }
    if (
      deal.template === "support_request" &&
      metadata.supportFeasible !== true
    ) {
      deal.respondedAtStep = null;
      deal.respondedAtTurn = null;
      return this.failure(
        "accept",
        "support acceptance lacked an exact currently feasible transfer",
        dealID,
      );
    }
    if (
      this.activeDealCount(deal.proposerPlayerID) >=
        MAX_ACTIVE_DEALS_PER_AGENT ||
      this.activeDealCount(deal.recipientPlayerID) >= MAX_ACTIVE_DEALS_PER_AGENT
    ) {
      deal.respondedAtStep = null;
      deal.respondedAtTurn = null;
      return this.failure(
        "accept",
        `active-deal cap reached (${MAX_ACTIVE_DEALS_PER_AGENT} per agent)`,
        dealID,
      );
    }
    deal.status = "accepted";
    // Accepted at step N => active (obligations judging) from step N+1; the
    // whole proposal->acceptance arc is therefore proposed N-1 -> visible/
    // accepted N -> active N+1, the spec's N/N+1/N+2 boundary.
    deal.activeFromStep = this.currentStep + 1;
    deal.expiresAfterStep = this.currentStep + deal.durationSteps;
    deal.obligations = buildDealObligations(deal);
    // VIEWER-ONLY acceptor rationale — same contract as the proposer's.
    const statedReason = sanitizeDealStatedReason(input.statedReason);
    if (statedReason !== null) {
      deal.acceptorStatedReason = statedReason;
    }
    const publicText = dealAcceptedPublicText(deal);
    this.events.push({
      event: "deal_accepted",
      dealID,
      template: deal.template,
      actorPlayerID,
      actorName: deal.recipientName,
      targetPlayerID: deal.proposerPlayerID,
      targetName: deal.proposerName,
      tone: "pact",
      importance: 78,
      publicText,
      ...(statedReason !== null ? { statedReason } : {}),
      step: this.currentStep,
    });
    return {
      result: {
        accepted: true,
        reason: `deal accepted: ${dealID}`,
        submittedIntent: null,
      },
      stamps: {
        dealAction: "accept",
        dealID,
        dealTemplate: deal.template,
        dealCounterpartyID: deal.proposerPlayerID,
        dealCounterpartyName: deal.proposerName,
        dealDurationSteps: deal.durationSteps,
        dealApplyAccepted: true,
        dealPublicText: publicText,
        ...(statedReason !== null ? { dealStatedReason: statedReason } : {}),
      },
    };
  }

  private queueEvents(
    events: AgentDealLedgerEvent[],
    recordsByPlayerID: ReadonlyMap<string, readonly AgentDecisionRecord[]>,
  ): void {
    if (events.length === 0) {
      return;
    }
    this.events.push(...events);
    for (const event of events) {
      const carrier = this.stampCarrierFor(event, recordsByPlayerID);
      if (carrier === null) {
        continue;
      }
      const pending = this.pendingStampsByAgentID.get(carrier) ?? [];
      pending.push(event);
      this.pendingStampsByAgentID.set(carrier, pending);
    }
  }

  private persistFinalEventStamps(
    events: readonly AgentDealLedgerEvent[],
    records: readonly AgentDecisionRecord[],
  ): void {
    if (events.length === 0 || records.length === 0) {
      return;
    }
    const recordsByPlayerID = new Map<string, AgentDecisionRecord[]>();
    for (const record of records) {
      const playerID = this.playerIDByAgentID.get(record.agentID);
      if (playerID === undefined) continue;
      const list = recordsByPlayerID.get(playerID) ?? [];
      list.push(record);
      recordsByPlayerID.set(playerID, list);
    }
    const byCarrier = new Map<string, AgentDealLedgerEvent[]>();
    for (const event of events) {
      const carrier = this.stampCarrierFor(event, recordsByPlayerID);
      if (carrier === null) continue;
      const pending = byCarrier.get(carrier) ?? [];
      pending.push(event);
      byCarrier.set(carrier, pending);
    }
    for (const [agentID, pending] of byCarrier) {
      const record = [...records]
        .reverse()
        .find((candidate) => candidate.agentID === agentID);
      if (record === undefined) continue;
      const current = record.decisionMetadata?.dealComplianceEvent;
      let existing: unknown[] = [];
      if (typeof current === "string") {
        try {
          const parsed: unknown = JSON.parse(current);
          if (Array.isArray(parsed)) existing = parsed;
        } catch {
          existing = [];
        }
      }
      record.decisionMetadata = {
        ...(record.decisionMetadata ?? {}),
        dealComplianceEvent: JSON.stringify([...existing, ...pending]),
      };
    }
  }

  /**
   * Deterministic stamp carrier: the event's actor when its seat is known and
   * still producing records (or no counterparty seat is known), else the
   * counterparty's seat — so a verdict about an eliminated obligor still
   * reaches decisions.jsonl through the surviving party's next record.
   */
  private stampCarrierFor(
    event: AgentDealLedgerEvent,
    recordsByPlayerID: ReadonlyMap<string, readonly AgentDecisionRecord[]>,
  ): string | null {
    const actorAgent = this.agentIDByPlayerID.get(event.actorPlayerID);
    const targetAgent =
      event.targetPlayerID === null
        ? undefined
        : this.agentIDByPlayerID.get(event.targetPlayerID);
    const actorActive = recordsByPlayerID.has(event.actorPlayerID);
    const targetActive =
      event.targetPlayerID !== null &&
      recordsByPlayerID.has(event.targetPlayerID);
    if (
      actorAgent !== undefined &&
      (actorActive || targetAgent === undefined)
    ) {
      return actorAgent;
    }
    if (targetAgent !== undefined && targetActive) {
      return targetAgent;
    }
    return actorAgent ?? targetAgent ?? null;
  }

  private activeDealCount(playerID: string): number {
    return this.deals.filter(
      (deal) =>
        deal.status === "accepted" &&
        (deal.proposerPlayerID === playerID ||
          deal.recipientPlayerID === playerID) &&
        deal.obligations.some((obligation) => obligation.status === "pending"),
    ).length;
  }

  /**
   * Whether accepting this still-open proposal would duplicate an active deal.
   * Symmetric pacts conflict in either direction. One-sided commitments only
   * conflict in the same direction with the same material terms: reversing a
   * support request or joint attack changes the obligor, and changing a joint
   * target changes the promise. This single predicate controls accept-time
   * validation, applyPropose, proposalOptionsFor, and the recipient's
   * executable incoming-proposal view so no gate can drift from another.
   */
  private activeDealConflictFor(
    candidate: AgentDealConflictCandidate,
  ): AgentDealState | null {
    const conflict = this.deals.find((active) => {
      if (
        active.status !== "accepted" ||
        active.template !== candidate.template ||
        active.durationSteps !== candidate.durationSteps ||
        !active.obligations.some(
          (obligation) => obligation.status === "pending",
        )
      ) {
        return false;
      }
      const sameDirection =
        active.proposerPlayerID === candidate.proposerPlayerID &&
        active.recipientPlayerID === candidate.recipientPlayerID;
      const reverseDirection =
        active.proposerPlayerID === candidate.recipientPlayerID &&
        active.recipientPlayerID === candidate.proposerPlayerID;
      if (
        candidate.template === "non_aggression_pact" ||
        candidate.template === "trade_security_pact"
      ) {
        return sameDirection || reverseDirection;
      }
      if (!sameDirection) {
        return false;
      }
      if (candidate.template === "joint_attack") {
        return active.targetPlayerID === candidate.targetPlayerID;
      }
      return (
        `${active.goldAmount}` === `${candidate.goldAmount}` &&
        active.troopAmount === candidate.troopAmount
      );
    });
    return conflict ?? null;
  }

  /**
   * PRIVACY: structured terms ONLY. The stated reasons stored on the deal
   * (proposer/acceptor/obligor) are VIEWER-ONLY and must never be added to
   * this view or any other observation view — agent-authored text entering
   * another agent's prompt is an instruction-injection channel, and the deal
   * templates are deliberately zero-free-text for exactly that reason.
   */
  private proposalView(deal: AgentDealState): AgentDealProposalView {
    return {
      dealID: deal.dealID,
      proposerPlayerID: deal.proposerPlayerID,
      proposerName: deal.proposerName,
      recipientPlayerID: deal.recipientPlayerID,
      recipientName: deal.recipientName,
      terms: this.termsView(deal),
      proposedAtStep: deal.proposedAtStep,
      answerableThroughStep: deal.answerableThroughStep,
    };
  }

  private termsView(deal: AgentDealState): AgentDealTermsView {
    return {
      template: deal.template,
      durationSteps: deal.durationSteps,
      ...(deal.targetPlayerID !== undefined
        ? {
            targetPlayerID: deal.targetPlayerID,
            targetName: deal.targetName ?? deal.targetPlayerID,
          }
        : {}),
      ...(deal.goldAmount !== undefined
        ? {
            goldAmount: `${deal.goldAmount}`,
            troopAmount: deal.troopAmount ?? 0,
          }
        : {}),
    };
  }

  /** PRIVACY: structured terms only — see `proposalView`. */
  private activeDealView(deal: AgentDealState): AgentActiveDealView {
    return {
      dealID: deal.dealID,
      template: deal.template,
      proposerPlayerID: deal.proposerPlayerID,
      proposerName: deal.proposerName,
      recipientPlayerID: deal.recipientPlayerID,
      recipientName: deal.recipientName,
      activeFromStep: deal.activeFromStep ?? 0,
      expiresAfterStep: deal.expiresAfterStep ?? 0,
      stepsRemaining: Math.max(
        0,
        (deal.expiresAfterStep ?? 0) - this.currentStep + 1,
      ),
      obligations: deal.obligations.map(
        (obligation): AgentDealObligationView => ({
          obligorPlayerID: obligation.obligorPlayerID,
          obligorName: obligation.obligorName,
          kind: obligation.kind,
          status: obligation.status,
          ...(obligation.targetPlayerID !== undefined
            ? {
                targetPlayerID: obligation.targetPlayerID,
                targetName: obligation.targetName ?? obligation.targetPlayerID,
              }
            : {}),
          ...(obligation.goldAmount !== undefined
            ? {
                goldAmount: `${obligation.goldAmount}`,
                troopAmount: obligation.troopAmount ?? 0,
                donatedGold: `${obligation.donatedGold}`,
                donatedTroops: obligation.donatedTroops,
              }
            : {}),
        }),
      ),
    };
  }

  /**
   * Enumerated (recipient, template) offers this agent currently has capacity
   * for. Template preconditions: joint_attack only when the PROPOSER (the
   * obligor) has a plausible attack path against a deterministic strongest
   * target (borders it or has boat options against it); support_request stays
   * restricted to an isFriendly recipient even when the game separately
   * permits direct non-friendly donations, always with explicit amounts.
   * Stable order: recipients by playerID, templates in declaration order;
   * capped.
   *
   * Nothing is offered at all while the agent is inside the proposal cooldown
   * (DEAL_ACTION_COOLDOWN_STEPS): a model must never be shown a move it
   * cannot make, and suppressing the option here also keeps the crowded
   * post-spawn menu free of dead entries.
   */
  private proposalOptionsFor(
    playerID: string,
    observation: AgentObservation,
  ): AgentDealProposalOptionView[] {
    if (this.proposalCooldownRemainingSteps(playerID) > 0) {
      return [];
    }
    if (this.activeDealCount(playerID) >= MAX_ACTIVE_DEALS_PER_AGENT) {
      return [];
    }
    const options: AgentDealProposalOptionView[] = [];
    const others = [...observation.visiblePlayers]
      .filter(
        (other) =>
          other.isAlive && other.hasSpawned && other.playerID !== playerID,
      )
      .sort((a, b) => a.playerID.localeCompare(b.playerID));
    for (const other of others) {
      if (options.length >= OBSERVATION_PROPOSAL_OPTION_CAP) {
        break;
      }
      const openFromMe = this.deals.filter(
        (deal) =>
          deal.status === "open" &&
          deal.proposerPlayerID === playerID &&
          deal.recipientPlayerID === other.playerID,
      );
      // Same defense-in-depth invariant as `applyPropose`'s copy: unreachable
      // while the proposal cooldown outpaces the proposal TTL.
      if (openFromMe.length >= MAX_OPEN_PROPOSALS_PER_ORDERED_PAIR) {
        continue;
      }
      if (this.activeDealCount(other.playerID) >= MAX_ACTIVE_DEALS_PER_AGENT) {
        continue;
      }
      for (const template of agentDealTemplates) {
        if (options.length >= OBSERVATION_PROPOSAL_OPTION_CAP) {
          break;
        }
        if (openFromMe.some((deal) => deal.template === template)) {
          continue;
        }
        const terms = this.termsForTemplate(template, other, observation);
        if (terms === null) {
          continue;
        }
        if (
          this.activeDealConflictFor({
            template,
            proposerPlayerID: playerID,
            recipientPlayerID: other.playerID,
            durationSteps: terms.durationSteps,
            targetPlayerID: terms.targetPlayerID,
            goldAmount: terms.goldAmount,
            troopAmount: terms.troopAmount,
          }) !== null
        ) {
          continue;
        }
        options.push({
          recipientPlayerID: other.playerID,
          recipientName: other.name,
          terms,
        });
      }
    }
    return options;
  }

  private termsForTemplate(
    template: AgentDealTemplate,
    recipient: AgentVisiblePlayer,
    observation: AgentObservation,
  ): AgentDealTermsView | null {
    switch (template) {
      case "non_aggression_pact":
      case "trade_security_pact":
        return {
          template,
          durationSteps: DEFAULT_DURATION_STEPS[template],
        };
      case "joint_attack": {
        const target = chooseJointAttackTarget(observation, recipient.playerID);
        if (target === null) {
          return null;
        }
        return {
          template,
          durationSteps: DEFAULT_DURATION_STEPS[template],
          targetPlayerID: target.playerID,
          targetName: target.name,
        };
      }
      case "support_request":
        if (!recipient.isFriendly) {
          return null;
        }
        return {
          template,
          durationSteps: DEFAULT_DURATION_STEPS[template],
          goldAmount: `${DEAL_SUPPORT_GOLD_AMOUNT}`,
          troopAmount: DEAL_SUPPORT_TROOP_AMOUNT,
        };
    }
  }

  private rivalReliabilityFor(
    playerID: string,
  ): AgentDealRivalReliabilityView[] {
    const reliability = dealReliabilityByObligor(this.deals);
    const rows: AgentDealRivalReliabilityView[] = [];
    for (const [obligorPlayerID, entry] of reliability) {
      if (obligorPlayerID === playerID) {
        continue;
      }
      rows.push({
        playerID: obligorPlayerID,
        name: this.nameForPlayer(obligorPlayerID),
        fulfilled: entry.fulfilled,
        terminalNonMoot: entry.terminalNonMoot,
        reliability:
          entry.terminalNonMoot === 0
            ? null
            : Math.round((entry.fulfilled / entry.terminalNonMoot) * 100) / 100,
      });
    }
    return rows
      .sort((a, b) => a.playerID.localeCompare(b.playerID))
      .slice(0, OBSERVATION_RELIABILITY_CAP);
  }

  private nameForPlayer(playerID: string): string {
    for (const deal of this.deals) {
      if (deal.proposerPlayerID === playerID) {
        return deal.proposerName;
      }
      if (deal.recipientPlayerID === playerID) {
        return deal.recipientName;
      }
    }
    return playerID;
  }
}

function clampDuration(durationSteps: number): number {
  return Math.max(
    MIN_DEAL_DURATION_STEPS,
    Math.min(MAX_DEAL_DURATION_STEPS, Math.round(durationSteps)),
  );
}

/**
 * Deterministic joint-attack target for a proposal offer: the strongest
 * (most tiles, tie playerID ascending) attackable player the PROPOSER either
 * borders or has boat options against, excluding the proposal's recipient.
 */
function chooseJointAttackTarget(
  observation: AgentObservation,
  recipientPlayerID: string,
): AgentVisiblePlayer | null {
  const boatTargets = new Set(
    (observation.nonCombat.boatOptions ?? [])
      .map((option) => option.targetID)
      .filter((targetID): targetID is string => typeof targetID === "string"),
  );
  const candidates = observation.visiblePlayers
    .filter(
      (candidate) =>
        candidate.isAlive &&
        candidate.hasSpawned &&
        candidate.playerID !== recipientPlayerID &&
        candidate.canAttack &&
        (candidate.sharesBorder || boatTargets.has(candidate.playerID)),
    )
    .sort(
      (a, b) =>
        b.tilesOwned - a.tilesOwned || a.playerID.localeCompare(b.playerID),
    );
  return candidates[0] ?? null;
}

function stableStringCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
