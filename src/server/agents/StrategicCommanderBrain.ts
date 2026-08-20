import type {
  AgentBrain,
  AgentBrainInput,
  AgentBrainType,
  AgentDecision,
  AgentObservation,
  LegalAction,
} from "./AgentTypes";
import type { ActiveCommanderPlan } from "./CommanderPlanLifecycle";
import { MAX_COMMANDER_OPTION_ID_LENGTH } from "./CommanderStateBuilder";
import { sanitizeUntrustedDisplayString } from "./PromptSanitizer";
import type { StrategicCommanderCaller } from "./StrategicCommanderCaller";
import type { StrategicOptionId } from "./StrategicCommanderTypes";
import { buildStrategicOptions } from "./StrategicOptionBuilder";

/**
 * A tactical id is decision-scoped and normally short; this bound only keeps a
 * misbehaving tactical brain from inflating the stamped fallback evidence.
 */
export const MAX_COMMANDER_STAMPED_ACTION_ID_LENGTH = 120;

/**
 * Stage 5 opt-in adapter. Wraps an injected tactical AgentBrain with the
 * StrategicCommanderV0 cycle (Stage 1 `buildStrategicOptions` + the Stage 4
 * `StrategicCommanderCaller`) and owns the only durable Commander state: the
 * active plan and a monotonic decision sequence, both scoped to one
 * gameID/agentID identity and reset when either changes.
 *
 * The Commander runs only during active, alive play. When its resolution is
 * executable, the tactical brain chooses among the currently offered aligned
 * PRIMARY actions and the adapter returns a single primary action id — no
 * support actions, batches, deal slots, or message slots at this stage. In
 * every other situation the tactical brain decides on the original menu,
 * unchanged. This stage proves opt-in plumbing only; it claims no behavioral
 * improvement over the wrapped brain.
 */
export class StrategicCommanderBrain implements AgentBrain {
  private identity: { gameID: string; agentID: string } | null = null;
  private activePlan: ActiveCommanderPlan | null = null;
  private nextDecisionSequence = 0;

  constructor(
    private readonly caller: StrategicCommanderCaller,
    private readonly tactical: AgentBrain,
  ) {}

  /** The tactical brain remains the acting policy; report its type. */
  get brainType(): AgentBrainType | undefined {
    return this.tactical.brainType;
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    this.resetOnIdentityChange(input.observation);
    if (
      input.observation.phase !== "active" ||
      input.observation.ownState?.isAlive !== true
    ) {
      return this.tactical.decide(input);
    }

    const options = buildStrategicOptions(input);
    const decisionSequence = this.nextDecisionSequence;
    this.nextDecisionSequence += 1;
    const outcome = await this.caller.runCycle({
      observation: input.observation,
      options,
      decisionSequence,
      activePlan: this.activePlan,
    });
    this.activePlan = outcome.cycle.plan;

    if (outcome.resolution.status !== "executable") {
      return this.tactical.decide(input);
    }
    const alignedIDs = new Set(outcome.resolution.alignedPrimaryActionIDs);
    const alignedActions = input.legalActions.filter((action) =>
      alignedIDs.has(action.id),
    );
    if (alignedActions.length === 0) {
      // Binding ids are verbatim copies of the current menu, so this cannot
      // happen from this adapter's own inputs; delegate rather than invent.
      return this.tactical.decide(input);
    }
    const tacticalDecision = await this.tactical.decide({
      observation: input.observation,
      legalActions: alignedActions,
    });
    return primaryOnlyDecision(
      tacticalDecision,
      alignedActions,
      outcome.resolution.selectedStrategicOptionId,
    );
  }

  private resetOnIdentityChange(observation: AgentObservation): void {
    if (
      this.identity !== null &&
      this.identity.gameID === observation.gameID &&
      this.identity.agentID === observation.agentID
    ) {
      return;
    }
    this.identity = {
      gameID: observation.gameID,
      agentID: observation.agentID,
    };
    this.activePlan = null;
    this.nextDecisionSequence = 0;
  }
}

/**
 * Binds the tactical decision to the current aligned primary binding. The
 * tactical action id is preserved only when it is one of the currently offered
 * aligned primary ids; a stale or off-binding id is replaced by the
 * lexicographically first offered aligned id, with the substitution stamped as
 * bounded scalar metadata. Only `actionID` ever carries an executable id — the
 * batch, deal, and message channels of the tactical decision are dropped.
 */
function primaryOnlyDecision(
  tacticalDecision: AgentDecision,
  alignedActions: readonly LegalAction[],
  selectedStrategicOptionId: StrategicOptionId,
): AgentDecision {
  const offeredAlignedIDs = alignedActions.map((action) => action.id);
  const tacticalActionID = tacticalDecision.actionID;
  if (
    typeof tacticalActionID === "string" &&
    offeredAlignedIDs.includes(tacticalActionID)
  ) {
    return {
      actionID: tacticalActionID,
      reason: tacticalDecision.reason ?? null,
      metadata: {
        ...tacticalDecision.metadata,
        commanderSelectedStrategicOptionId: sanitizeUntrustedDisplayString(
          selectedStrategicOptionId,
          MAX_COMMANDER_OPTION_ID_LENGTH,
        ),
        commanderExecutionFallback: false,
      },
    };
  }
  const fallbackActionID = [...offeredAlignedIDs].sort(stableStringCompare)[0]!;
  return {
    actionID: fallbackActionID,
    // The tactical brain's stated reason described a different action; per the
    // AgentDecision contract a fallback substitution reports no reason.
    reason: null,
    metadata: {
      commanderSelectedStrategicOptionId: sanitizeUntrustedDisplayString(
        selectedStrategicOptionId,
        MAX_COMMANDER_OPTION_ID_LENGTH,
      ),
      commanderExecutionFallback: true,
      commanderRejectedTacticalActionID:
        typeof tacticalActionID === "string"
          ? sanitizeUntrustedDisplayString(
              tacticalActionID,
              MAX_COMMANDER_STAMPED_ACTION_ID_LENGTH,
            )
          : null,
    },
  };
}

function stableStringCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
