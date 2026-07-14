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
  keystoneExpertDomains,
  proposeKeystoneConquest,
  proposeKeystoneEconomy,
  proposeKeystoneExpansion,
  proposeKeystonePolitics,
  type KeystoneActionSelection,
  type KeystoneArbitrationResult,
  type KeystoneExpertDomain,
  type KeystoneExpertProposal,
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

export type KeystonePlanAlignment = (args: {
  input: AgentBrainInput;
  plan: StrategicPlan;
  action: LegalAction;
}) => boolean;

export interface KeystoneShadowCouncilExecutorOptions {
  readonly delegate: AgentExecutor;
  readonly actionFollowsCanonicalPlan: KeystonePlanAlignment;
  readonly experts?: KeystoneShadowExperts;
  /** Test seam only. Production emits one bounded line to stdout. */
  readonly logLine?: (line: string) => void;
  /** Monotonic nanosecond clock; injectable for deterministic focused tests. */
  readonly nowNanos?: () => bigint;
}

interface ShadowProposalRecord {
  readonly domain: KeystoneExpertDomain;
  readonly proposal: KeystoneExpertProposal;
  readonly bidBP: number | null;
}

interface ShadowCouncilDraft {
  readonly proposals: readonly ShadowProposalRecord[];
  readonly errorDomains: readonly KeystoneExpertDomain[];
  readonly result: KeystoneArbitrationResult | null;
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
  readonly domain: KeystoneExpertDomain;
  readonly proposalID: string;
  readonly actionID: string;
  readonly bidBP: number | null;
  readonly bid: ShadowBidTelemetry;
}

interface ShadowSelectionTelemetry {
  readonly tier: KeystoneActionSelection["tier"];
  readonly source: KeystoneActionSelection["source"];
  readonly proposalID: string | null;
  readonly actionID: string;
  readonly bidBP: number | null;
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
  readonly rejections: readonly {
    readonly proposalID: string;
    readonly actionID: string;
    readonly reason: KeystoneProposalRejection["reason"];
  }[];
  readonly winner: ShadowSelectionTelemetry | null;
  readonly runnerUp: ShadowSelectionTelemetry | null;
  readonly bidMarginBP: number | null;
  readonly authoritativeActionID: string;
  readonly agreement: ShadowAgreement;
  readonly health: ShadowHealth;
  readonly exposure: {
    readonly proposalMask: number;
    readonly errorMask: number;
    readonly rejectionMask: number;
    readonly proposalCount: number;
    readonly rejectionCount: number;
  };
  readonly elapsedUs: number;
}

const defaultExperts: KeystoneShadowExperts = Object.freeze({
  expansion: proposeKeystoneExpansion,
  economy: proposeKeystoneEconomy,
  conquest: proposeKeystoneConquest,
  politics: proposeKeystonePolitics,
});

/**
 * Observes the four-expert council without changing authoritative execution.
 * The delegate's exact AgentExecutionDecision object is always returned.
 */
export class KeystoneShadowCouncilExecutor implements AgentExecutor {
  private readonly experts: KeystoneShadowExperts;
  private readonly logLine: (line: string) => void;
  private readonly nowNanos: () => bigint;
  private gameID: string | null = null;
  private lastTurn: number | null = null;
  private ordinal = 0;
  private resetOrdinal = 0;
  private latest: KeystoneShadowCouncilTelemetry | null = null;

  constructor(private readonly options: KeystoneShadowCouncilExecutorOptions) {
    this.experts = options.experts ?? defaultExperts;
    this.logLine = options.logLine ?? ((line) => console.log(line));
    this.nowNanos = options.nowNanos ?? (() => process.hrtime.bigint());
  }

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    let sequence: ShadowSequence = Object.freeze({
      ordinal: this.ordinal + 1,
      reset: false,
      resetOrdinal: this.resetOrdinal,
    });
    let draft: ShadowCouncilDraft = unavailableDraft();
    try {
      sequence = this.advanceSequence(
        input.observation.gameID,
        input.observation.turnNumber,
      );
      draft = this.observeCouncil(input, plan);
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

      const world = buildKeystoneWorldModel(input, {
        forbiddenActionKinds: plan.forbiddenActionKinds,
        planAlignedActionIDs,
      });
      const proposals: ShadowProposalRecord[] = [];
      const errorDomains: KeystoneExpertDomain[] = [];
      for (const domain of keystoneExpertDomains) {
        try {
          const proposal = this.experts[domain](world);
          if (proposal !== null) {
            proposals.push(
              Object.freeze({
                domain,
                proposal,
                bidBP: proposalBidBP(world, proposal),
              }),
            );
          }
        } catch {
          // Domain is the complete failure record. Never retain exception text.
          errorDomains.push(domain);
        }
      }

      const result = arbitrateKeystoneAction(world, {
        spawn: [],
        survival: [],
        bindingDirective: [],
        expertAuction: proposals.map(({ proposal }) => proposal),
      });
      return Object.freeze({
        proposals: Object.freeze(proposals),
        errorDomains: Object.freeze(errorDomains),
        result,
        infrastructureFailure,
        elapsedUs: elapsedMicroseconds(startedAt, this.nowNanos()),
      });
    } catch {
      return Object.freeze({
        proposals: Object.freeze([]),
        errorDomains: Object.freeze([]),
        result: null,
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

function unavailableDraft(): ShadowCouncilDraft {
  return Object.freeze({
    proposals: Object.freeze([]),
    errorDomains: Object.freeze([]),
    result: null,
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
    (mask, record) => mask | EXPERT_ERROR_BITS[record.domain],
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
    : errorMask === 0
      ? "healthy"
      : errorMask === 15
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
      draft.proposals.map(({ domain, proposal, bidBP }) =>
        Object.freeze({
          domain,
          proposalID: safeTelemetryID(proposal.proposalID),
          actionID: safeTelemetryID(proposal.actionID),
          bidBP: telemetryNumber(bidBP),
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
    authoritativeActionID: safeTelemetryID(authoritativeActionID),
    agreement,
    health,
    exposure: Object.freeze({
      proposalMask,
      errorMask,
      rejectionMask,
      proposalCount: draft.proposals.length,
      rejectionCount: rejections.length,
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

function proposalBidBP(
  world: KeystoneWorldModel,
  proposal: KeystoneExpertProposal,
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
    rejections: [],
    winner: telemetry.winner,
    runnerUp: telemetry.runnerUp,
    bidMarginBP: telemetry.bidMarginBP,
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
    h: telemetry.health,
    p: telemetry.exposure.proposalMask,
    e: telemetry.exposure.errorMask,
    j: telemetry.exposure.rejectionMask,
    w: fingerprint(telemetry.winner?.actionID ?? ""),
    r: fingerprint(telemetry.runnerUp?.actionID ?? ""),
    d: fingerprint(telemetry.authoritativeActionID),
    m: telemetry.bidMarginBP,
    a: telemetry.agreement,
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
    h: "unavailable",
    p: telemetry.exposure.proposalMask,
    e: telemetry.exposure.errorMask,
    j: telemetry.exposure.rejectionMask,
    w: "-",
    r: "-",
    d: "-",
    m: null,
    a: "unavailable",
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
