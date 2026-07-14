import { createHash } from "node:crypto";

import type {
  AgentExecutionDecision,
  AgentExecutor,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  arbitrateKeystoneAction,
  buildKeystoneWorldModel,
  computeKeystoneBidBP,
  DEFAULT_KEYSTONE_PLAN_ALIGNMENT_BONUS_BP,
  DEFAULT_KEYSTONE_SWITCH_MARGIN_BP,
  keystoneExpertDomains,
  KeystoneOperationalCommitmentLedger,
  normalizeKeystoneCommanderContext,
  proposeKeystoneConquest,
  proposeKeystoneEconomy,
  proposeKeystoneExpansion,
  proposeKeystonePolitics,
  proposeKeystoneSpawn,
  proposeKeystoneSurvival,
  resolveKeystoneBindingDirective,
  type KeystoneActionSelection,
  type KeystoneArbitrationResult,
  type KeystoneAuctionTrace,
  type KeystoneBidComponents,
  type KeystoneBindingDirectiveStatus,
  type KeystoneDirectiveProposal,
  type KeystoneExpertDomain,
  type KeystoneExpertProposal,
  type KeystoneOperationalLedgerTransition,
  type KeystoneProposalRejection,
  type KeystoneWorldModel,
} from "./keystone-experts";

export const KEYSTONE_SHADOW_COUNCIL_LOG_PREFIX = "keystone-shadow-council ";
export const KEYSTONE_SHADOW_COUNCIL_LOG_MAX_BYTES = 4_096;
export const KEYSTONE_SHADOW_COUNCIL_METADATA_MAX_BYTES = 300;
export const KEYSTONE_SHADOW_COUNCIL_METADATA_KEY = "keystoneShadowCouncil";

const EXPERT_ERROR_BITS: Readonly<Record<KeystoneExpertDomain, number>> =
  Object.freeze({
    expansion: 1 << 0,
    economy: 1 << 1,
    conquest: 1 << 2,
    politics: 1 << 3,
  });

type KeystoneShadowSystemSource = "spawn" | "survival" | "binding_directive";
type KeystoneShadowProposalSource =
  | KeystoneExpertDomain
  | KeystoneShadowSystemSource;
type KeystoneShadowProposal =
  | KeystoneExpertProposal
  | KeystoneDirectiveProposal<KeystoneShadowSystemSource>;

const PROPOSAL_SOURCE_BITS: Readonly<
  Record<KeystoneShadowProposalSource, number>
> = Object.freeze({
  expansion: 1 << 0,
  economy: 1 << 1,
  conquest: 1 << 2,
  politics: 1 << 3,
  spawn: 1 << 4,
  survival: 1 << 5,
  binding_directive: 1 << 6,
});

const REJECTION_BITS: Readonly<
  Record<KeystoneProposalRejection["reason"], number>
> = Object.freeze({
  ambiguous_offered_action: 1 << 0,
  non_offered_action: 1 << 1,
  forbidden_action: 1 << 2,
  friendly_or_team_target: 1 << 3,
  spawn_phase_mismatch: 1 << 4,
  not_spawn_action: 1 << 5,
  source_tier_mismatch: 1 << 6,
  action_ownership_mismatch: 1 << 7,
  invalid_proposal: 1 << 8,
  non_positive_bid: 1 << 9,
  duplicate_action_proposal: 1 << 10,
});

type ShadowHealth = "healthy" | "partial" | "failed" | "unavailable";
type ShadowAgreement = "agree" | "disagree" | "abstain" | "unavailable";

export type KeystoneShadowExpert = (
  world: KeystoneWorldModel,
) => KeystoneExpertProposal | null;

export type KeystoneShadowExperts = Readonly<
  Record<KeystoneExpertDomain, KeystoneShadowExpert>
>;

export interface KeystoneShadowSystemProposers {
  readonly spawn: (
    world: KeystoneWorldModel,
  ) => KeystoneDirectiveProposal<"spawn"> | null;
  readonly survival: (
    world: KeystoneWorldModel,
  ) => KeystoneDirectiveProposal<"survival"> | null;
}

export type KeystonePlanAlignment = (args: {
  input: AgentBrainInput;
  plan: StrategicPlan;
  action: LegalAction;
}) => boolean;

export interface KeystoneShadowCouncilExecutorOptions {
  readonly delegate: AgentExecutor;
  readonly actionFollowsCanonicalPlan: KeystonePlanAlignment;
  readonly experts?: KeystoneShadowExperts;
  /** Bitset over expansion/economy/conquest/politics; defaults to all four. */
  readonly enabledExpertMask?: number;
  /** Test seam only. Production always uses the reviewed system proposers. */
  readonly systemProposers?: KeystoneShadowSystemProposers;
  /** Test seam only. Production emits one bounded line to stdout. */
  readonly logLine?: (line: string) => void;
  /** Monotonic nanosecond clock; injectable for deterministic focused tests. */
  readonly nowNanos?: () => bigint;
  /** Soft utility bonus for a plan-aligned expert action. */
  readonly planAlignmentBonusBP?: number;
  /** Minimum challenger advantage required to leave a live objective. */
  readonly switchMarginBP?: number;
}

interface ShadowProposalRecord {
  /** Expert slot, or null for a protected system-tier proposal. */
  readonly domain: KeystoneExpertDomain | null;
  readonly source: KeystoneShadowProposalSource;
  readonly proposal: KeystoneShadowProposal;
  /** Raw common utility before plan alignment or hysteresis. */
  readonly bidBP: number | null;
  readonly planBonusBP: number;
  readonly auctionScoreBP: number | null;
}

interface ShadowCouncilDraft {
  readonly proposals: readonly ShadowProposalRecord[];
  readonly errorDomains: readonly KeystoneExpertDomain[];
  readonly systemErrorSources: readonly KeystoneShadowSystemSource[];
  readonly enabledExpertMask: number;
  readonly result: KeystoneArbitrationResult | null;
  readonly directiveStatus:
    | KeystoneBindingDirectiveStatus
    | "error"
    | "unavailable";
  readonly directiveKind: "attack_target" | "alliance" | "build" | null;
  readonly ledgerPreparation: KeystoneOperationalLedgerTransition | null;
  readonly ledgerRecord: KeystoneOperationalLedgerTransition | null;
  readonly infrastructureFailure: boolean;
  readonly elapsedUs: number;
}

interface ShadowSequence {
  readonly ordinal: number;
  readonly reset: boolean;
  readonly resetOrdinal: number;
}

interface ShadowBidTelemetry {
  readonly expectedValueBP: number | null;
  readonly urgencyBP: number | null;
  readonly confidenceBP: number | null;
  readonly riskBP: number | null;
  readonly opportunityCostBP: number | null;
}

interface ShadowProposalTelemetry {
  readonly domain: KeystoneExpertDomain | null;
  readonly source: KeystoneShadowProposalSource;
  readonly proposalID: string;
  readonly actionID: string;
  readonly bidBP: number | null;
  readonly planBonusBP: number;
  readonly auctionScoreBP: number | null;
  readonly bid: ShadowBidTelemetry;
}

interface ShadowSelectionTelemetry {
  readonly tier: KeystoneActionSelection["tier"];
  readonly source: KeystoneActionSelection["source"];
  readonly proposalID: string | null;
  readonly actionID: string;
  readonly bidBP: number | null;
}

interface ShadowAuctionTelemetry {
  readonly status: KeystoneAuctionTrace["status"];
  readonly incumbentKey: string | null;
  readonly incumbentSource: KeystoneExpertDomain | null;
  readonly baselineWinnerProposalID: string | null;
  readonly selectedProposalID: string | null;
  readonly challengerProposalID: string | null;
  readonly challengerAdvantageBP: number | null;
  readonly switchMarginBP: number;
  readonly planAlignmentBonusBP: number;
  readonly selectedRawBidBP: number | null;
  readonly selectedPlanBonusBP: number | null;
  readonly selectedAuctionScoreBP: number | null;
}

interface ShadowLedgerSnapshotTelemetry {
  readonly key: string | null;
  readonly source: KeystoneExpertDomain | null;
  readonly startedOrdinal: number | null;
  readonly expiresAfterOrdinal: number | null;
  readonly remainingDecisions: number;
}

interface ShadowLedgerTransitionTelemetry {
  readonly reason: KeystoneOperationalLedgerTransition["reason"];
  readonly before: ShadowLedgerSnapshotTelemetry;
  readonly after: ShadowLedgerSnapshotTelemetry;
}

export interface KeystoneShadowCouncilTelemetry {
  readonly schema: "keystone-shadow-council";
  readonly version: 1;
  readonly turn: number;
  readonly ordinal: number;
  readonly reset: boolean;
  readonly resetOrdinal: number;
  readonly proposals: readonly ShadowProposalTelemetry[];
  readonly errorDomains: readonly KeystoneExpertDomain[];
  readonly systemErrorSources: readonly KeystoneShadowSystemSource[];
  readonly rejections: readonly {
    readonly proposalID: string;
    readonly actionID: string;
    readonly reason: KeystoneProposalRejection["reason"];
  }[];
  readonly winner: ShadowSelectionTelemetry | null;
  readonly runnerUp: ShadowSelectionTelemetry | null;
  readonly bidMarginBP: number | null;
  readonly directive: {
    readonly status: ShadowCouncilDraft["directiveStatus"];
    readonly kind: ShadowCouncilDraft["directiveKind"];
  };
  readonly auction: ShadowAuctionTelemetry | null;
  readonly operational: {
    readonly preparation: ShadowLedgerTransitionTelemetry | null;
    readonly record: ShadowLedgerTransitionTelemetry | null;
  };
  readonly authoritativeActionID: string;
  readonly agreement: ShadowAgreement;
  readonly health: ShadowHealth;
  readonly exposure: {
    readonly proposalMask: number;
    readonly errorMask: number;
    readonly rejectionMask: number;
    readonly proposalCount: number;
    readonly rejectionCount: number;
    readonly enabledExpertMask: number;
    readonly systemErrorMask: number;
  };
  readonly elapsedUs: number;
}

const defaultExperts: KeystoneShadowExperts = Object.freeze({
  expansion: proposeKeystoneExpansion,
  economy: proposeKeystoneEconomy,
  conquest: proposeKeystoneConquest,
  politics: proposeKeystonePolitics,
});

const defaultSystemProposers: KeystoneShadowSystemProposers = Object.freeze({
  spawn: proposeKeystoneSpawn,
  survival: proposeKeystoneSurvival,
});

/**
 * Observes the four-expert council without changing authoritative execution.
 * The delegate's exact AgentExecutionDecision object is always returned.
 */
export class KeystoneShadowCouncilExecutor implements AgentExecutor {
  private readonly experts: KeystoneShadowExperts;
  private readonly enabledExpertMask: number;
  private readonly systemProposers: KeystoneShadowSystemProposers;
  private readonly logLine: (line: string) => void;
  private readonly nowNanos: () => bigint;
  private readonly planAlignmentBonusBP: number;
  private readonly switchMarginBP: number;
  private readonly operationalLedger =
    new KeystoneOperationalCommitmentLedger();
  private gameID: string | null = null;
  private lastTurn: number | null = null;
  private ordinal = 0;
  private resetOrdinal = 0;
  private latest: KeystoneShadowCouncilTelemetry | null = null;

  constructor(private readonly options: KeystoneShadowCouncilExecutorOptions) {
    this.experts = options.experts ?? defaultExperts;
    this.enabledExpertMask = validExpertMask(options.enabledExpertMask ?? 15);
    this.systemProposers = options.systemProposers ?? defaultSystemProposers;
    this.logLine = options.logLine ?? ((line) => console.log(line));
    this.nowNanos = options.nowNanos ?? (() => process.hrtime.bigint());
    this.planAlignmentBonusBP = validBasisPointOption(
      "plan alignment bonus",
      options.planAlignmentBonusBP ?? DEFAULT_KEYSTONE_PLAN_ALIGNMENT_BONUS_BP,
    );
    this.switchMarginBP = validBasisPointOption(
      "switch margin",
      options.switchMarginBP ?? DEFAULT_KEYSTONE_SWITCH_MARGIN_BP,
    );
  }

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    let sequence: ShadowSequence = Object.freeze({
      ordinal: this.ordinal + 1,
      reset: false,
      resetOrdinal: this.resetOrdinal,
    });
    let draft: ShadowCouncilDraft = unavailableDraft(this.enabledExpertMask);
    try {
      sequence = this.advanceSequence(
        input.observation.gameID,
        input.observation.turnNumber,
      );
      draft = this.observeCouncil(input, plan, sequence);
    } catch {
      // The authoritative executor must still run even if shadow state or its
      // injectable diagnostic clock is malformed.
    }

    // Authority is deliberately isolated after the shadow work: no council
    // result, abstention, rejection, or expert failure can alter this call.
    const authoritative = this.options.delegate.decide(input, plan);
    try {
      const telemetry = telemetryFor(
        input.observation.turnNumber,
        sequence,
        draft,
        authoritative.actionID,
      );
      this.latest = telemetry;
      this.emitTelemetry(telemetry);
    } catch {
      // Post-decision telemetry serialization is equally non-authoritative.
    }
    return authoritative;
  }

  latestTelemetry(): KeystoneShadowCouncilTelemetry | null {
    return this.latest;
  }

  private advanceSequence(gameID: string, turn: number): ShadowSequence {
    const reset =
      this.gameID === null ||
      gameID !== this.gameID ||
      (this.lastTurn !== null && turn < this.lastTurn);
    if (reset) {
      this.ordinal = 0;
      this.resetOrdinal += 1;
    }
    this.gameID = gameID;
    this.lastTurn = turn;
    this.ordinal += 1;
    return Object.freeze({
      ordinal: this.ordinal,
      reset,
      resetOrdinal: this.resetOrdinal,
    });
  }

  private observeCouncil(
    input: AgentBrainInput,
    plan: StrategicPlan,
    sequence: ShadowSequence,
  ): ShadowCouncilDraft {
    const startedAt = this.nowNanos();
    try {
      let infrastructureFailure = false;
      const planAlignedActionIDs: string[] = [];
      for (const action of input.legalActions) {
        try {
          if (
            this.options.actionFollowsCanonicalPlan({ input, plan, action })
          ) {
            planAlignedActionIDs.push(action.id);
          }
        } catch {
          // Alignment is diagnostic-only. Mark health without carrying error
          // text, then continue so all experts still receive one shared world.
          infrastructureFailure = true;
        }
      }

      const commander = normalizeKeystoneCommanderContext(plan);
      const world = buildKeystoneWorldModel(input, {
        forbiddenActionKinds: plan.forbiddenActionKinds,
        planAlignedActionIDs,
        commander,
      });
      const proposals: ShadowProposalRecord[] = [];
      const systemErrorSources: KeystoneShadowSystemSource[] = [];
      let spawnProposal: KeystoneDirectiveProposal<"spawn"> | null = null;
      let survivalProposal: KeystoneDirectiveProposal<"survival"> | null = null;
      let bindingProposal: KeystoneDirectiveProposal<"binding_directive"> | null =
        null;
      let directiveStatus: ShadowCouncilDraft["directiveStatus"] =
        commander.binding === null ? "absent" : "unavailable";
      try {
        spawnProposal = this.systemProposers.spawn(world);
      } catch {
        systemErrorSources.push("spawn");
      }
      try {
        survivalProposal = this.systemProposers.survival(world);
      } catch {
        systemErrorSources.push("survival");
      }
      try {
        const binding = resolveKeystoneBindingDirective(world);
        directiveStatus = binding.status;
        bindingProposal = binding.proposal;
      } catch {
        directiveStatus = "error";
        systemErrorSources.push("binding_directive");
      }
      if (spawnProposal !== null) {
        proposals.push(
          proposalRecord(
            world,
            null,
            spawnProposal.source,
            spawnProposal,
            this.planAlignmentBonusBP,
          ),
        );
      }
      if (survivalProposal !== null) {
        proposals.push(
          proposalRecord(
            world,
            null,
            survivalProposal.source,
            survivalProposal,
            this.planAlignmentBonusBP,
          ),
        );
      }
      if (bindingProposal !== null) {
        proposals.push(
          proposalRecord(
            world,
            null,
            bindingProposal.source,
            bindingProposal,
            this.planAlignmentBonusBP,
          ),
        );
      }
      const errorDomains: KeystoneExpertDomain[] = [];
      const expertProposals: KeystoneExpertProposal[] = [];
      for (const domain of keystoneExpertDomains) {
        if ((this.enabledExpertMask & EXPERT_ERROR_BITS[domain]) === 0) {
          continue;
        }
        try {
          const proposal = this.experts[domain](world);
          if (proposal !== null) {
            expertProposals.push(proposal);
            proposals.push(
              proposalRecord(
                world,
                domain,
                proposal.source,
                proposal,
                this.planAlignmentBonusBP,
              ),
            );
          }
        } catch {
          // Domain is the complete failure record. Never retain exception text.
          errorDomains.push(domain);
        }
      }

      const ledgerPreparation = this.operationalLedger.prepare({
        world,
        ordinal: sequence.ordinal,
        reset: sequence.reset,
        proposals: expertProposals,
        planAlignmentBonusBP: this.planAlignmentBonusBP,
        switchMarginBP: this.switchMarginBP,
      });
      const result = arbitrateKeystoneAction(
        world,
        {
          spawn: spawnProposal === null ? [] : [spawnProposal],
          survival: survivalProposal === null ? [] : [survivalProposal],
          bindingDirective: bindingProposal === null ? [] : [bindingProposal],
          expertAuction: expertProposals,
        },
        ledgerPreparation.auctionContext,
      );
      const ledgerRecord = this.operationalLedger.record({
        world,
        ordinal: sequence.ordinal,
        result,
        proposals: expertProposals,
      });
      return Object.freeze({
        proposals: Object.freeze(proposals),
        errorDomains: Object.freeze(errorDomains),
        systemErrorSources: Object.freeze(systemErrorSources),
        enabledExpertMask: this.enabledExpertMask,
        result,
        directiveStatus,
        directiveKind: commander.binding?.kind ?? null,
        ledgerPreparation: ledgerPreparation.transition,
        ledgerRecord,
        infrastructureFailure,
        elapsedUs: elapsedMicroseconds(startedAt, this.nowNanos()),
      });
    } catch {
      return Object.freeze({
        proposals: Object.freeze([]),
        errorDomains: Object.freeze([]),
        systemErrorSources: Object.freeze([]),
        enabledExpertMask: this.enabledExpertMask,
        result: null,
        directiveStatus: "error",
        directiveKind: null,
        ledgerPreparation: null,
        ledgerRecord: null,
        infrastructureFailure: true,
        elapsedUs: elapsedMicroseconds(startedAt, this.nowNanos()),
      });
    }
  }

  private emitTelemetry(telemetry: KeystoneShadowCouncilTelemetry): void {
    try {
      const line = boundedKeystoneShadowCouncilTelemetryLine(telemetry);
      this.logLine(line);
    } catch {
      // Observability cannot become action-selection behavior.
    }
  }
}

function unavailableDraft(enabledExpertMask: number): ShadowCouncilDraft {
  return Object.freeze({
    proposals: Object.freeze([]),
    errorDomains: Object.freeze([]),
    systemErrorSources: Object.freeze([]),
    enabledExpertMask,
    result: null,
    directiveStatus: "unavailable",
    directiveKind: null,
    ledgerPreparation: null,
    ledgerRecord: null,
    infrastructureFailure: true,
    elapsedUs: 0,
  });
}

/** Adds only a bounded shadow summary to the completed authoritative decision. */
export class KeystoneShadowCouncilTelemetryAgentBrain implements AgentBrain {
  readonly brainType: AgentBrain["brainType"];

  constructor(
    private readonly delegate: AgentBrain,
    private readonly shadow: KeystoneShadowCouncilExecutor,
  ) {
    this.brainType = delegate.brainType;
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    const decision = await this.delegate.decide(input);
    const telemetry = this.shadow.latestTelemetry();
    if (telemetry === null) {
      return decision;
    }
    try {
      return {
        ...decision,
        metadata: {
          ...(decision.metadata ?? {}),
          [KEYSTONE_SHADOW_COUNCIL_METADATA_KEY]: compactMetadata(telemetry),
        },
      };
    } catch {
      // Even compact telemetry construction must never replace a selected id
      // with the player's transport fallback.
      return decision;
    }
  }
}

function telemetryFor(
  turn: number,
  sequence: ShadowSequence,
  draft: ShadowCouncilDraft,
  authoritativeActionID: string,
): KeystoneShadowCouncilTelemetry {
  const errorMask = draft.errorDomains.reduce(
    (mask, domain) => mask | EXPERT_ERROR_BITS[domain],
    0,
  );
  const proposalMask = draft.proposals.reduce(
    (mask, record) => mask | PROPOSAL_SOURCE_BITS[record.source],
    0,
  );
  const systemErrorMask = draft.systemErrorSources.reduce(
    (mask, source) =>
      mask | (source === "spawn" ? 1 : source === "survival" ? 2 : 4),
    0,
  );
  const rejections = draft.result?.rejections ?? [];
  const rejectionMask = rejections.reduce(
    (mask, rejection) => mask | REJECTION_BITS[rejection.reason],
    0,
  );
  const winner = draft.result?.selection ?? null;
  const agreement: ShadowAgreement =
    draft.result === null
      ? "unavailable"
      : winner === null
        ? "abstain"
        : winner.actionID === authoritativeActionID
          ? "agree"
          : "disagree";
  const health: ShadowHealth = draft.infrastructureFailure
    ? "unavailable"
    : errorMask === 0 && systemErrorMask === 0
      ? "healthy"
      : draft.enabledExpertMask !== 0 && errorMask === draft.enabledExpertMask
        ? "failed"
        : "partial";

  return Object.freeze({
    schema: "keystone-shadow-council",
    version: 1,
    turn: finiteInteger(turn),
    ordinal: sequence.ordinal,
    reset: sequence.reset,
    resetOrdinal: sequence.resetOrdinal,
    proposals: Object.freeze(
      draft.proposals.map(
        ({ domain, source, proposal, bidBP, planBonusBP, auctionScoreBP }) =>
          Object.freeze({
            domain,
            source,
            proposalID: safeTelemetryID(proposal.proposalID),
            actionID: safeTelemetryID(proposal.actionID),
            bidBP: telemetryNumber(bidBP),
            planBonusBP,
            auctionScoreBP: telemetryNumber(auctionScoreBP),
            bid: Object.freeze({
              expectedValueBP: telemetryNumber(proposal.expectedValueBP),
              urgencyBP: telemetryNumber(proposal.urgencyBP),
              confidenceBP: telemetryNumber(proposal.confidenceBP),
              riskBP: telemetryNumber(proposal.riskBP),
              opportunityCostBP: telemetryNumber(proposal.opportunityCostBP),
            }),
          }),
      ),
    ),
    errorDomains: Object.freeze([...draft.errorDomains]),
    systemErrorSources: Object.freeze([...draft.systemErrorSources]),
    rejections: Object.freeze(
      rejections.map((rejection) =>
        Object.freeze({
          proposalID: safeTelemetryID(rejection.proposalID),
          actionID: safeTelemetryID(rejection.actionID),
          reason: rejection.reason,
        }),
      ),
    ),
    winner: selectionTelemetry(winner),
    runnerUp: selectionTelemetry(draft.result?.runnerUp ?? null),
    bidMarginBP: telemetryNumber(draft.result?.bidMarginBP ?? null),
    directive: Object.freeze({
      status: draft.directiveStatus,
      kind: draft.directiveKind,
    }),
    auction: auctionTelemetry(draft.result?.auction ?? null),
    operational: Object.freeze({
      preparation: ledgerTransitionTelemetry(draft.ledgerPreparation),
      record: ledgerTransitionTelemetry(draft.ledgerRecord),
    }),
    authoritativeActionID: safeTelemetryID(authoritativeActionID),
    agreement,
    health,
    exposure: Object.freeze({
      proposalMask,
      errorMask,
      rejectionMask,
      proposalCount: draft.proposals.length,
      rejectionCount: rejections.length,
      enabledExpertMask: draft.enabledExpertMask,
      systemErrorMask,
    }),
    elapsedUs: draft.elapsedUs,
  });
}

function selectionTelemetry(
  selection: KeystoneActionSelection | null,
): ShadowSelectionTelemetry | null {
  if (selection === null) {
    return null;
  }
  return Object.freeze({
    tier: selection.tier,
    source: selection.source,
    proposalID:
      selection.proposalID === null
        ? null
        : safeTelemetryID(selection.proposalID),
    actionID: safeTelemetryID(selection.actionID),
    bidBP: telemetryNumber(selection.bidBP),
  });
}

function auctionTelemetry(
  trace: KeystoneAuctionTrace | null,
): ShadowAuctionTelemetry | null {
  if (trace === null) {
    return null;
  }
  return Object.freeze({
    status: trace.status,
    incumbentKey:
      trace.incumbentKey === null
        ? null
        : `hash:${fingerprint(trace.incumbentKey)}`,
    incumbentSource: trace.incumbentSource,
    baselineWinnerProposalID:
      trace.baselineWinnerProposalID === null
        ? null
        : safeTelemetryID(trace.baselineWinnerProposalID),
    selectedProposalID:
      trace.selectedProposalID === null
        ? null
        : safeTelemetryID(trace.selectedProposalID),
    challengerProposalID:
      trace.challengerProposalID === null
        ? null
        : safeTelemetryID(trace.challengerProposalID),
    challengerAdvantageBP: telemetryNumber(trace.challengerAdvantageBP),
    switchMarginBP: trace.switchMarginBP,
    planAlignmentBonusBP: trace.planAlignmentBonusBP,
    selectedRawBidBP: telemetryNumber(trace.selectedRawBidBP),
    selectedPlanBonusBP: telemetryNumber(trace.selectedPlanBonusBP),
    selectedAuctionScoreBP: telemetryNumber(trace.selectedAuctionScoreBP),
  });
}

function ledgerTransitionTelemetry(
  transition: KeystoneOperationalLedgerTransition | null,
): ShadowLedgerTransitionTelemetry | null {
  if (transition === null) {
    return null;
  }
  return Object.freeze({
    reason: transition.reason,
    before: ledgerSnapshotTelemetry(transition.before),
    after: ledgerSnapshotTelemetry(transition.after),
  });
}

function ledgerSnapshotTelemetry(snapshot: {
  readonly commitment: {
    readonly key: string;
    readonly source: KeystoneExpertDomain;
    readonly startedOrdinal: number;
    readonly expiresAfterOrdinal: number;
  } | null;
  readonly remainingDecisions: number;
}): ShadowLedgerSnapshotTelemetry {
  const commitment = snapshot.commitment;
  return Object.freeze({
    key: commitment === null ? null : `hash:${fingerprint(commitment.key)}`,
    source: commitment?.source ?? null,
    startedOrdinal: commitment?.startedOrdinal ?? null,
    expiresAfterOrdinal: commitment?.expiresAfterOrdinal ?? null,
    remainingDecisions: snapshot.remainingDecisions,
  });
}

function proposalBidBP(
  world: KeystoneWorldModel,
  proposal: KeystoneBidComponents & { readonly actionID: string },
): number | null {
  try {
    const actionRiskFloorBP =
      world.actions.find((action) => action.id === proposal.actionID)
        ?.actionRiskBP ?? 0;
    return computeKeystoneBidBP(proposal, actionRiskFloorBP);
  } catch {
    return null;
  }
}

function proposalRecord(
  world: KeystoneWorldModel,
  domain: KeystoneExpertDomain | null,
  source: KeystoneShadowProposalSource,
  proposal: KeystoneShadowProposal,
  planAlignmentBonusBP: number,
): ShadowProposalRecord {
  const bidBP = proposalBidBP(world, proposal);
  const action = world.actions.find(
    (candidate) => candidate.id === proposal.actionID,
  );
  const planBonusBP =
    domain !== null && action?.planAligned === true ? planAlignmentBonusBP : 0;
  return Object.freeze({
    domain,
    source,
    proposal,
    bidBP,
    planBonusBP,
    auctionScoreBP: bidBP === null ? null : bidBP + planBonusBP,
  });
}

export function boundedKeystoneShadowCouncilTelemetryLine(
  telemetry: KeystoneShadowCouncilTelemetry,
): string {
  const line = `${KEYSTONE_SHADOW_COUNCIL_LOG_PREFIX}${JSON.stringify(telemetry)}`;
  if (
    Buffer.byteLength(line, "utf8") <= KEYSTONE_SHADOW_COUNCIL_LOG_MAX_BYTES
  ) {
    return line;
  }
  // Defensive only: identifiers are already bounded. This path preserves a
  // complete health/exposure record if the schema grows without a budget audit.
  const compact = {
    schema: telemetry.schema,
    version: telemetry.version,
    turn: telemetry.turn,
    ordinal: telemetry.ordinal,
    reset: telemetry.reset,
    resetOrdinal: telemetry.resetOrdinal,
    proposals: [],
    errorDomains: telemetry.errorDomains,
    systemErrorSources: telemetry.systemErrorSources,
    rejections: [],
    winner: telemetry.winner,
    runnerUp: telemetry.runnerUp,
    bidMarginBP: telemetry.bidMarginBP,
    directive: telemetry.directive,
    auction: telemetry.auction,
    operational: telemetry.operational,
    authoritativeActionID: telemetry.authoritativeActionID,
    agreement: telemetry.agreement,
    health: "unavailable",
    exposure: telemetry.exposure,
    elapsedUs: telemetry.elapsedUs,
  } as const;
  return `${KEYSTONE_SHADOW_COUNCIL_LOG_PREFIX}${JSON.stringify(compact)}`;
}

function compactMetadata(telemetry: KeystoneShadowCouncilTelemetry): string {
  const compact = JSON.stringify({
    v: telemetry.version,
    o: telemetry.ordinal,
    g: telemetry.resetOrdinal,
    x: telemetry.reset ? 1 : 0,
    h: compactHealth(telemetry.health),
    p: telemetry.exposure.proposalMask,
    e: telemetry.exposure.errorMask | (telemetry.exposure.systemErrorMask << 4),
    j: telemetry.exposure.rejectionMask,
    w: fingerprint(telemetry.winner?.actionID ?? ""),
    r: fingerprint(telemetry.runnerUp?.actionID ?? ""),
    d: fingerprint(telemetry.authoritativeActionID),
    m: telemetry.bidMarginBP,
    a: compactAgreement(telemetry.agreement),
    s: compactSource(telemetry.winner?.source),
    k: telemetry.exposure.enabledExpertMask,
    u: telemetry.elapsedUs,
  });
  if (
    Buffer.byteLength(compact, "utf8") <=
    KEYSTONE_SHADOW_COUNCIL_METADATA_MAX_BYTES
  ) {
    return compact;
  }
  // Fixed-size fallback; currently unreachable under the schema above.
  return JSON.stringify({
    v: 1,
    o: telemetry.ordinal,
    g: telemetry.resetOrdinal,
    x: telemetry.reset ? 1 : 0,
    h: "u",
    p: telemetry.exposure.proposalMask,
    e: telemetry.exposure.errorMask | (telemetry.exposure.systemErrorMask << 4),
    j: telemetry.exposure.rejectionMask,
    w: "-",
    r: "-",
    d: "-",
    m: null,
    a: "u",
    s: 0,
    k: telemetry.exposure.enabledExpertMask,
    u: telemetry.elapsedUs,
  });
}

function safeTelemetryID(value: unknown): string {
  if (typeof value !== "string") {
    return `hash:${fingerprint(String(value))}`;
  }
  const sensitive =
    value.includes("://") ||
    /(?:token|secret|password|bearer|api[_-]?key)/i.test(value);
  if (
    !sensitive &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_.:/-]+$/.test(value)
  ) {
    return value;
  }
  return `hash:${fingerprint(value)}`;
}

function compactSource(
  source: KeystoneActionSelection["source"] | undefined,
): number {
  switch (source) {
    case "expansion":
      return 1;
    case "economy":
      return 2;
    case "conquest":
      return 3;
    case "politics":
      return 4;
    case "spawn":
      return 5;
    case "survival":
      return 6;
    case "binding_directive":
      return 7;
    case "fallback":
      return 8;
    case undefined:
      return 0;
  }
}

function compactHealth(health: ShadowHealth): "h" | "p" | "f" | "u" {
  switch (health) {
    case "healthy":
      return "h";
    case "partial":
      return "p";
    case "failed":
      return "f";
    case "unavailable":
      return "u";
  }
}

function compactAgreement(agreement: ShadowAgreement): "a" | "d" | "b" | "u" {
  switch (agreement) {
    case "agree":
      return "a";
    case "disagree":
      return "d";
    case "abstain":
      return "b";
    case "unavailable":
      return "u";
  }
}

function fingerprint(value: string): string {
  if (value.length === 0) {
    return "-";
  }
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function telemetryNumber(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function finiteInteger(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function elapsedMicroseconds(startedAt: bigint, endedAt: bigint): number {
  if (endedAt <= startedAt) {
    return 0;
  }
  const elapsed = (endedAt - startedAt) / 1_000n;
  return elapsed > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(elapsed);
}

function validExpertMask(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new RangeError(
      "Keystone shadow expert mask must be an integer from 0 to 15",
    );
  }
  return value;
}

function validBasisPointOption(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`${label} must be an integer from 0 to 10000`);
  }
  return value;
}
