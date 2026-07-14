import type {
  AgentExecutionDecision,
  AgentExecutor,
  AgentSettings,
  RankedActionForPrompt,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  AgentStrategyProfile,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

export type KeystoneConversionState =
  | "OPENING"
  | "CONTACT"
  | "TARGET_LOCK"
  | "FINISH";

export type KeystoneActionRanker = (args: {
  input: AgentBrainInput;
  profile: AgentStrategyProfile;
  plan: StrategicPlan;
  settings: Partial<AgentSettings>;
}) => RankedActionForPrompt[];

export type KeystonePlanAdherenceEvaluator = (args: {
  input: AgentBrainInput;
  plan: StrategicPlan;
  action: LegalAction;
}) => boolean;

export interface KeystoneSingleActionExecutorOptions {
  profile: AgentStrategyProfile;
  settings: Partial<AgentSettings>;
  rankActions: KeystoneActionRanker;
  actionFollowsCanonicalPlan: KeystonePlanAdherenceEvaluator;
  targetMissLimit?: number;
}

export interface KeystoneSingleActionSnapshot {
  state: KeystoneConversionState;
  targetPlayerID: string | null;
  targetMisses: number;
  cityMilestoneUsed: boolean;
}

const TREATMENT = "coworld-single-action-v1";
const CONTACT_TURN = 1_400;
const EARLY_SOCIAL_CUTOFF = 2_000;
const EARLY_CITY_CUTOFF = 1_800;

type ConversionOverrideReason =
  | "invasion_interrupt"
  | "cap_conversion_override"
  | "dead_frontier_conversion_override";

const socialKinds = new Set<LegalActionKind>([
  "alliance_request",
  "alliance_reject",
  "alliance_extend",
  "break_alliance",
  "emoji",
  "quick_chat",
  "donate_gold",
  "donate_troops",
  "embargo",
  "embargo_stop",
  "embargo_all",
]);

const conversionKinds = new Set<LegalActionKind>(["attack", "boat", "nuke"]);

/**
 * Coworld executes one LegalAction.id per decision. This executor therefore
 * turns the frontier scorer into one deterministic conversion sequence instead
 * of asking the multi-action scheduler for a batch and silently dropping its
 * tail on the wire.
 */
export class KeystoneSingleActionExecutor implements AgentExecutor {
  private readonly profile: AgentStrategyProfile;
  private readonly settings: Partial<AgentSettings>;
  private readonly rankActions: KeystoneActionRanker;
  private readonly canonicalAdherence: KeystonePlanAdherenceEvaluator;
  private readonly targetMissLimit: number;
  private gameID: string | null = null;
  private lastTurn = -1;
  private state: KeystoneConversionState = "OPENING";
  private targetPlayerID: string | null = null;
  private targetMisses = 0;
  private cityMilestoneUsed = false;

  constructor(options: KeystoneSingleActionExecutorOptions) {
    this.profile = options.profile;
    this.settings = { ...options.settings };
    this.rankActions = options.rankActions;
    this.canonicalAdherence = options.actionFollowsCanonicalPlan;
    this.targetMissLimit = Math.max(1, options.targetMissLimit ?? 2);
  }

  snapshot(): KeystoneSingleActionSnapshot {
    return {
      state: this.state,
      targetPlayerID: this.targetPlayerID,
      targetMisses: this.targetMisses,
      cityMilestoneUsed: this.cityMilestoneUsed,
    };
  }

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    this.resetForNewGame(input);
    const offeredIDs = input.legalActions.map((action) => action.id);
    if (offeredIDs.some((id) => id.trim().length === 0)) {
      throw new Error(
        "Coworld single-action executor received an empty offered action id",
      );
    }
    const offeredIDCounts = offeredIDs.reduce((counts, id) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    // A LegalAction.id is the complete wire contract. If two offered actions
    // collide on the same id, selecting it cannot identify which intent the
    // validator will resolve. Drop only those ambiguous rows so an unrelated
    // social-action collision cannot force the whole competitive turn to hold.
    const unambiguousOffered = input.legalActions
      .filter((action) => offeredIDCounts.get(action.id) === 1)
      .map(cloneLegalAction);
    const offeredByID = new Map(
      unambiguousOffered.map((action) => [action.id, action]),
    );
    if (input.legalActions.length === 0) {
      throw new Error(
        "Coworld single-action executor cannot select from an empty offered action set",
      );
    }
    if (offeredByID.size === 0) {
      throw new Error(
        "Coworld single-action executor cannot select when every offered action id is ambiguous",
      );
    }

    // The repository ranker is injected code. Give it a separate deep copy so
    // sorting, appending, or rewriting its input cannot reintroduce a rejected
    // collision into the executor-owned selection snapshot.
    const rankerInput: AgentBrainInput = {
      ...input,
      legalActions: unambiguousOffered.map(cloneLegalAction),
    };

    const ranked = sanitizeRankedActions(
      this.rankActions({
        input: rankerInput,
        profile: this.profile,
        plan,
        settings: { ...this.settings },
      }),
      offeredByID,
    );
    const rankedActions = ranked
      .map((candidate) => offeredByID.get(candidate.id))
      .filter((action): action is LegalAction => action !== undefined);
    const allActions = appendUnrankedOffered(rankedActions, unambiguousOffered);
    const previousState = this.state;

    if (input.observation.phase === "spawn") {
      const spawn = allActions.find((action) => action.kind === "spawn");
      return this.decision(input, {
        action: spawn ?? safeFallback(allActions),
        plan,
        previousState,
        transition: "none",
        marker: "spawn",
        ranked,
      });
    }

    const aggressorIDs = incomingAggressorIDs(input);
    const survivalCandidates = conversionCandidates(allActions).filter(
      (action) => {
        const targetID = actionTargetID(action);
        return targetID !== null && aggressorIDs.includes(targetID);
      },
    );
    if (survivalCandidates.length > 0) {
      const capTroopSpend = nearTroopCap(input)
        ? survivalCandidates.filter((action) =>
            credibleInvasionTroopSpend(input, action),
          )
        : [];
      const action = capTroopSpend[0] ?? survivalCandidates[0]!;
      return this.decision(input, {
        action,
        plan,
        previousState,
        transition: "none",
        marker: "invasion_interrupt",
        ranked,
        targetOverride: actionTargetID(action),
        overrideReason: "invasion_interrupt",
      });
    }

    const permitted = allActions.filter(
      (action) => !plan.forbiddenActionKinds.includes(action.kind),
    );
    const deadFrontier =
      !input.observation.combat.canExpandIntoNeutral &&
      !allActions.some(isNeutralExpansion);
    const capPressure = nearTroopCap(input);
    const permittedHostile = conversionCandidates(permitted).filter((action) =>
      credibleConversionAction(input, plan, action),
    );
    const overrideTroopSpend =
      capPressure || deadFrontier
        ? conversionCandidates(allActions).filter(
            (action) =>
              (action.kind === "attack" || action.kind === "boat") &&
              plan.forbiddenActionKinds.includes(action.kind) &&
              verifiedConversionOverrideTarget(input, action) &&
              credibleConversionAction(input, plan, action),
          )
        : [];
    let conversionOverrideReason: ConversionOverrideReason | null = null;
    let hostile = permittedHostile;
    if (capPressure) {
      const permittedTroopSpend = permittedHostile.filter(
        (action) => action.kind === "attack" || action.kind === "boat",
      );
      if (permittedTroopSpend.length > 0) {
        hostile = permittedTroopSpend;
      } else if (overrideTroopSpend.length > 0) {
        hostile = overrideTroopSpend;
        conversionOverrideReason = "cap_conversion_override";
      }
    } else if (permittedHostile.length === 0 && overrideTroopSpend.length > 0) {
      hostile = overrideTroopSpend;
      conversionOverrideReason = "dead_frontier_conversion_override";
    }
    if (permitted.length === 0 && hostile.length === 0) {
      throw new Error(
        "Coworld single-action executor found no offered action allowed by the binding plan",
      );
    }
    const available = permitted;
    const neutral = available.filter(isNeutralExpansion);
    const neutral35 = neutral.find(isThirtyFivePercentExpansion);
    const earlySocialSuppressed =
      input.observation.turnNumber < EARLY_SOCIAL_CUTOFF &&
      available.some((action) => socialKinds.has(action.kind));

    const commitment = bindingCommitmentCandidate(input, plan, allActions);
    if (commitment !== null) {
      this.targetPlayerID = plan.commitment?.targetPlayerId ?? null;
      this.targetMisses = 0;
      this.state = targetReadyToFinish(input, this.targetPlayerID, commitment)
        ? "FINISH"
        : "TARGET_LOCK";
      return this.decision(input, {
        action: commitment,
        plan,
        previousState,
        transition: transitionText(previousState, this.state),
        marker: "binding_commitment",
        ranked,
      });
    }

    if (plan.commitment === undefined) {
      const alliance = bindingAllianceCandidate(plan, available);
      if (alliance !== null) {
        return this.decision(input, {
          action: alliance,
          plan,
          previousState,
          transition: "none",
          marker: "binding_alliance_directive",
          ranked,
          targetOverride: allianceRecipientID(alliance),
        });
      }
      const build = bindingBuildCandidate(plan, available);
      if (build !== null) {
        if (
          String(build.metadata?.unit ?? "").toLowerCase() === "city" &&
          input.observation.turnNumber <= EARLY_CITY_CUTOFF
        ) {
          this.cityMilestoneUsed = true;
        }
        return this.decision(input, {
          action: build,
          plan,
          previousState,
          transition: "none",
          marker: "binding_build_directive",
          ranked,
        });
      }
    }

    if (this.state === "OPENING") {
      const contactReady =
        hostile.length > 0 &&
        (input.observation.turnNumber >= CONTACT_TURN ||
          deadFrontier ||
          capPressure);
      if (contactReady || (deadFrontier && hasLivingRival(input))) {
        this.state = "CONTACT";
        const contactTarget = chooseTarget(input, plan, hostile, null);
        const contactAction =
          contactTarget === null
            ? null
            : bestTargetedAction(hostile, contactTarget, capPressure);
        if (contactAction !== null) {
          return this.decision(input, {
            action: contactAction,
            plan,
            previousState,
            transition: transitionText(previousState, this.state),
            marker: markerWithSocialSuppression(
              conversionOverrideReason ??
                (capPressure
                  ? "cap_spend"
                  : deadFrontier
                    ? "dead_frontier_contact"
                    : "first_contact_pressure"),
              earlySocialSuppressed,
            ),
            ranked,
            targetOverride: contactTarget,
            ...(conversionOverrideReason !== null
              ? { overrideReason: conversionOverrideReason }
              : {}),
          });
        }
      } else {
        const city = this.earlyCityMilestone(input, available, deadFrontier);
        if (city !== null) {
          this.cityMilestoneUsed = true;
          return this.decision(input, {
            action: city,
            plan,
            previousState,
            transition: "none",
            marker: "city_milestone",
            ranked,
          });
        }
        const expansion = neutral35 ?? neutral[0];
        if (expansion !== undefined) {
          return this.decision(input, {
            action: expansion,
            plan,
            previousState,
            transition: "none",
            marker: markerWithSocialSuppression(
              isThirtyFivePercentExpansion(expansion)
                ? "opening_expand_35"
                : "opening_expand_fallback",
              earlySocialSuppressed,
            ),
            ranked,
          });
        }
      }
    }

    const lockedCandidate = this.lockedConversionCandidate(input, hostile);
    if (lockedCandidate !== null) {
      const finishReady = targetReadyToFinish(
        input,
        this.targetPlayerID,
        lockedCandidate,
      );
      if (finishReady) {
        this.state = "FINISH";
      } else if (this.state === "CONTACT") {
        this.state = "TARGET_LOCK";
      }
      this.targetMisses = 0;
      return this.decision(input, {
        action: lockedCandidate,
        plan,
        previousState,
        transition: transitionText(previousState, this.state),
        marker:
          conversionOverrideReason ??
          (capPressure
            ? "cap_spend"
            : previousState === "TARGET_LOCK" || previousState === "FINISH"
              ? "target_lock_persistence"
              : "target_lock_acquired"),
        ranked,
        ...(conversionOverrideReason !== null
          ? { overrideReason: conversionOverrideReason }
          : {}),
      });
    }

    if (this.targetPlayerID !== null) {
      const lockedPlayer = visiblePlayer(input, this.targetPlayerID);
      const pressureRequiresSwitch =
        (conversionOverrideReason !== null || capPressure) &&
        hostile.length > 0 &&
        !hostile.some(
          (action) => actionTargetID(action) === this.targetPlayerID,
        );
      if (pressureRequiresSwitch || lockedPlayer?.isAlive === false) {
        this.releaseTarget();
        this.state = "CONTACT";
      } else {
        this.targetMisses += 1;
        if (this.targetMisses < this.targetMissLimit) {
          return this.decision(input, {
            action: nonConversionFallback(
              available,
              input,
              plan,
              this.cityMilestoneUsed,
            ),
            plan,
            previousState,
            transition: "none",
            marker: "target_lock_miss",
            ranked,
          });
        }
        this.releaseTarget();
        this.state = "CONTACT";
      }
    }

    const chosenTarget = chooseTarget(input, plan, hostile, null);
    if (chosenTarget !== null) {
      this.targetPlayerID = chosenTarget;
      this.targetMisses = 0;
      const action = bestTargetedAction(hostile, chosenTarget, capPressure);
      if (action !== null) {
        this.state = targetReadyToFinish(input, chosenTarget, action)
          ? "FINISH"
          : "TARGET_LOCK";
        return this.decision(input, {
          action,
          plan,
          previousState,
          transition: transitionText(previousState, this.state),
          marker:
            conversionOverrideReason ??
            (capPressure
              ? "cap_spend"
              : deadFrontier
                ? "dead_frontier_contact"
                : "target_lock_acquired"),
          ranked,
          ...(conversionOverrideReason !== null
            ? { overrideReason: conversionOverrideReason }
            : {}),
        });
      }
    }

    this.state = "CONTACT";
    const city = this.earlyCityMilestone(input, available, deadFrontier);
    if (city !== null) {
      this.cityMilestoneUsed = true;
      return this.decision(input, {
        action: city,
        plan,
        previousState,
        transition: transitionText(previousState, this.state),
        marker: "city_milestone",
        ranked,
      });
    }

    const fallback = nonConversionFallback(
      available,
      input,
      plan,
      this.cityMilestoneUsed,
    );
    return this.decision(input, {
      action: fallback,
      plan,
      previousState,
      transition: transitionText(previousState, this.state),
      marker: earlySocialSuppressed
        ? "early_social_suppression"
        : deadFrontier
          ? "dead_frontier_contact"
          : "economy_or_growth_fallback",
      ranked,
    });
  }

  private resetForNewGame(input: AgentBrainInput): void {
    const turn = input.observation.turnNumber;
    if (this.gameID !== input.observation.gameID || turn < this.lastTurn) {
      this.gameID = input.observation.gameID;
      this.state = "OPENING";
      this.targetPlayerID = null;
      this.targetMisses = 0;
      this.cityMilestoneUsed = false;
    }
    this.lastTurn = turn;
  }

  private earlyCityMilestone(
    input: AgentBrainInput,
    actions: readonly LegalAction[],
    deadFrontier: boolean,
  ): LegalAction | null {
    if (
      this.cityMilestoneUsed ||
      input.observation.turnNumber > EARLY_CITY_CUTOFF ||
      incomingAggressorIDs(input).length > 0
    ) {
      return null;
    }
    const city = actions.find(
      (action) =>
        action.kind === "build" &&
        String(action.metadata?.unit ?? "").toLowerCase() === "city",
    );
    if (city === undefined) {
      return null;
    }
    const own = input.observation.ownState;
    const frontierStalled =
      deadFrontier || !input.observation.combat.canExpandIntoNeutral;
    const capPressure = nearTroopCap(input);
    const established =
      (own?.tileShare ?? 0) >= 0.06 || (own?.tilesOwned ?? 0) >= 15;
    return (frontierStalled || capPressure) && established ? city : null;
  }

  private lockedConversionCandidate(
    input: AgentBrainInput,
    hostile: readonly LegalAction[],
  ): LegalAction | null {
    if (this.targetPlayerID === null) {
      return null;
    }
    const player = visiblePlayer(input, this.targetPlayerID);
    if (player?.isAlive === false) {
      return null;
    }
    return bestTargetedAction(
      hostile,
      this.targetPlayerID,
      nearTroopCap(input),
    );
  }

  private releaseTarget(): void {
    this.targetPlayerID = null;
    this.targetMisses = 0;
  }

  private decision(
    input: AgentBrainInput,
    args: {
      action: LegalAction;
      plan: StrategicPlan;
      previousState: KeystoneConversionState;
      transition: string;
      marker: string;
      ranked: readonly RankedActionForPrompt[];
      targetOverride?: string | null;
      overrideReason?: ConversionOverrideReason;
    },
  ): AgentExecutionDecision {
    const target = args.targetOverride ?? this.targetPlayerID;
    const topAlternatives = args.ranked
      .slice(0, 4)
      .map((candidate) => `${candidate.id}:${candidate.totalScore}`)
      .join("|");
    const stateMetadata = [
      `treatment=${TREATMENT}`,
      `state=${this.state}`,
      `target=${target ?? "none"}`,
      `transition=${args.transition}`,
      `marker=${args.marker}`,
    ].join(",");
    const planFollowed = actionFollowsPlan(
      input,
      args.action,
      args.plan,
      args.overrideReason ?? null,
      this.canonicalAdherence,
    );
    return {
      actionID: args.action.id,
      reason: `${TREATMENT} state=${this.state} target=${target ?? "none"} transition=${args.transition} marker=${args.marker}; selected ${args.action.id}`,
      planFollowed,
      executorSource: TREATMENT,
      actionSelectionSource: `${TREATMENT}:${this.state.toLowerCase()}`,
      selectedModules: stateMetadata,
      alternativesConsidered: topAlternatives,
    };
  }
}

function sanitizeRankedActions(
  ranked: readonly RankedActionForPrompt[],
  offeredByID: ReadonlyMap<string, LegalAction>,
): RankedActionForPrompt[] {
  const seen = new Set<string>();
  const sanitized: RankedActionForPrompt[] = [];
  for (const candidate of ranked) {
    const offered = offeredByID.get(candidate.id);
    if (
      offered === undefined ||
      offered.kind !== candidate.kind ||
      seen.has(candidate.id)
    ) {
      continue;
    }
    seen.add(candidate.id);
    sanitized.push(candidate);
  }
  return sanitized;
}

function bindingCommitmentCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  actions: readonly LegalAction[],
): LegalAction | null {
  const commitment = plan.commitment;
  if (commitment === undefined) {
    return null;
  }
  const targeted = actions.filter(
    (action) =>
      actionTargetID(action) === commitment.targetPlayerId &&
      verifiedConversionOverrideTarget(input, action),
  );
  const land = targeted
    .filter(
      (action) =>
        action.kind === "attack" &&
        !isNeutralExpansion(action) &&
        actionCommitmentRatio(action) >= commitment.minAttackRatio,
    )
    .sort(
      (left, right) =>
        actionCommitmentRatio(left) - actionCommitmentRatio(right),
    );
  return land[0] ?? targeted.find((action) => action.kind === "boat") ?? null;
}

function bindingAllianceCandidate(
  plan: StrategicPlan,
  actions: readonly LegalAction[],
): LegalAction | null {
  const directive = plan.allianceDirective;
  if (directive === undefined) {
    return null;
  }
  const qualifying = actions.filter(
    (action) =>
      (action.kind === "alliance_request" ||
        action.kind === "alliance_extend") &&
      (directive.targetPlayerId === undefined ||
        allianceRecipientID(action) === directive.targetPlayerId),
  );
  const preferredKind =
    directive.stance === "hold_alliance"
      ? "alliance_extend"
      : "alliance_request";
  return (
    qualifying.find((action) => action.kind === preferredKind) ??
    qualifying[0] ??
    null
  );
}

function bindingBuildCandidate(
  plan: StrategicPlan,
  actions: readonly LegalAction[],
): LegalAction | null {
  if (plan.buildDirective === undefined) {
    return null;
  }
  return (
    actions.find((action) => actionMatchesBuildDirective(action, plan)) ?? null
  );
}

function actionMatchesBuildDirective(
  action: LegalAction,
  plan: StrategicPlan,
): boolean {
  const directive = plan.buildDirective;
  if (directive === undefined || action.kind !== "build") {
    return false;
  }
  const unit = String(action.metadata?.unit ?? "");
  if (directive.unit === "MissileSilo") {
    return unit === "Missile Silo";
  }
  if (directive.unit === "SAMLauncher") {
    return unit === "SAM Launcher";
  }
  return (
    action.metadata?.role === "economic" &&
    (directive.unit === "any" || unit === directive.unit)
  );
}

function actionCommitmentRatio(action: LegalAction): number {
  const fraction = numericMetadata(action, "troopPercentage") ?? 0;
  if (fraction > 0 && fraction <= 1) {
    return fraction;
  }
  const percent = numericMetadata(action, "troopPercent") ?? 0;
  return percent > 0 ? percent / 100 : 0;
}

function actionFollowsPlan(
  input: AgentBrainInput,
  action: LegalAction,
  plan: StrategicPlan,
  overrideReason: ConversionOverrideReason | null,
  canonicalAdherence: KeystonePlanAdherenceEvaluator,
): boolean {
  if (overrideReason !== null || !canonicalAdherence({ input, plan, action })) {
    return false;
  }
  const targetID = actionTargetID(action);
  if (plan.commitment !== undefined) {
    return (
      targetID === plan.commitment.targetPlayerId &&
      ((action.kind === "attack" &&
        actionCommitmentRatio(action) >= plan.commitment.minAttackRatio) ||
        action.kind === "boat")
    );
  }
  if (plan.allianceDirective !== undefined) {
    return bindingAllianceCandidate(plan, [action]) !== null;
  }
  if (plan.buildDirective !== undefined) {
    return actionMatchesBuildDirective(action, plan);
  }
  const bindingTarget = plan.targetPlayerId;
  if (
    conversionKinds.has(action.kind) &&
    bindingTarget !== null &&
    targetID !== bindingTarget
  ) {
    return false;
  }
  return true;
}

function appendUnrankedOffered(
  ranked: readonly LegalAction[],
  offered: readonly LegalAction[],
): LegalAction[] {
  const seen = new Set(ranked.map((action) => action.id));
  return [
    ...ranked,
    ...offered.filter((action) => {
      if (seen.has(action.id)) {
        return false;
      }
      seen.add(action.id);
      return true;
    }),
  ];
}

function cloneLegalAction(action: LegalAction): LegalAction {
  return structuredClone(action);
}

function conversionCandidates(actions: readonly LegalAction[]): LegalAction[] {
  return actions.filter(
    (action) =>
      conversionKinds.has(action.kind) && actionTargetID(action) !== null,
  );
}

function actionTargetID(action: LegalAction): string | null {
  const targetID = action.metadata?.targetID;
  return typeof targetID === "string" && targetID.length > 0 ? targetID : null;
}

function allianceRecipientID(action: LegalAction): string | null {
  const recipientID = action.metadata?.recipientID;
  if (typeof recipientID === "string" && recipientID.length > 0) {
    return recipientID;
  }
  return actionTargetID(action);
}

function isNeutralExpansion(action: LegalAction): boolean {
  const targetName = String(action.metadata?.targetName ?? "")
    .trim()
    .toLowerCase();
  return (
    (action.kind === "attack" || action.kind === "boat") &&
    (action.metadata?.expansion === true ||
      action.metadata?.isNeutral === true ||
      action.metadata?.targetType === "neutral" ||
      targetName === "terra nullius")
  );
}

function isThirtyFivePercentExpansion(action: LegalAction): boolean {
  const percent = action.metadata?.troopPercent;
  const fraction = action.metadata?.troopPercentage;
  return percent === 35 || fraction === 0.35;
}

function incomingAggressorIDs(input: AgentBrainInput): string[] {
  return Array.from(
    new Set([
      ...input.observation.combat.incomingAttackPlayerIDs,
      ...input.observation.visiblePlayers
        .filter((player) => player.incomingAttack)
        .map((player) => player.playerID),
    ]),
  );
}

function credibleConversionAction(
  input: AgentBrainInput,
  plan: StrategicPlan,
  action: LegalAction,
): boolean {
  const targetID = actionTargetID(action);
  if (targetID === null) {
    return false;
  }
  const player = visiblePlayer(input, targetID);
  if (
    player !== null &&
    (!player.isAlive ||
      player.isAllied ||
      player.isFriendly ||
      player.isTeammate)
  ) {
    return false;
  }
  const incoming = incomingAggressorIDs(input).includes(targetID);
  const betrayed =
    input.observation.opponentModel?.some(
      (entry) => entry.playerID === targetID && entry.betrayedMe,
    ) === true;
  if (
    plan.allianceDirective?.targetPlayerId === targetID &&
    !incoming &&
    !betrayed
  ) {
    return false;
  }
  if (incoming) {
    return true;
  }
  const ratio =
    numericMetadata(action, "relativeTroopRatio") ??
    player?.relativeTroopRatio ??
    null;
  if (action.risk.level === "high" && (ratio === null || ratio < 1.2)) {
    return false;
  }
  return ratio === null || ratio >= 0.72 || action.risk.level === "low";
}

function credibleInvasionTroopSpend(
  input: AgentBrainInput,
  action: LegalAction,
): boolean {
  if (action.kind !== "attack" && action.kind !== "boat") {
    return false;
  }
  const targetID = actionTargetID(action);
  if (targetID === null) {
    return false;
  }
  const player = visiblePlayer(input, targetID);
  if (player?.isAlive === false) {
    return false;
  }
  const ratio =
    numericMetadata(action, "relativeTroopRatio") ??
    player?.relativeTroopRatio ??
    null;
  return action.risk.level !== "high" || (ratio !== null && ratio >= 1.2);
}

function verifiedConversionOverrideTarget(
  input: AgentBrainInput,
  action: LegalAction,
): boolean {
  const targetID = actionTargetID(action);
  if (targetID === null) {
    return false;
  }
  const player = visiblePlayer(input, targetID);
  return (
    player !== null &&
    player.isAlive &&
    !player.isAllied &&
    !player.isFriendly &&
    !player.isTeammate
  );
}

function chooseTarget(
  input: AgentBrainInput,
  plan: StrategicPlan,
  hostile: readonly LegalAction[],
  standingLock: string | null,
): string | null {
  const offeredTargets = new Set(
    hostile
      .map(actionTargetID)
      .filter((target): target is string => target !== null),
  );
  const preferred = [
    plan.commitment?.targetPlayerId ?? null,
    standingLock,
    plan.targetPlayerId,
    ...incomingAggressorIDs(input),
    input.observation.combat.weakestAttackableTargetID,
  ];
  for (const target of preferred) {
    if (target !== null && offeredTargets.has(target)) {
      return target;
    }
  }
  const favorable = input.observation.visiblePlayers
    .filter(
      (player) =>
        offeredTargets.has(player.playerID) &&
        player.isAlive &&
        !player.isAllied &&
        !player.isFriendly &&
        !player.isTeammate,
    )
    .sort(
      (a, b) =>
        (b.relativeTroopRatio ?? 0) - (a.relativeTroopRatio ?? 0) ||
        (a.tileShare ?? 1) - (b.tileShare ?? 1) ||
        a.playerID.localeCompare(b.playerID),
    );
  return favorable[0]?.playerID ?? hostile.map(actionTargetID)[0] ?? null;
}

function bestTargetedAction(
  actions: readonly LegalAction[],
  targetID: string,
  preferTroopSpend = false,
): LegalAction | null {
  if (preferTroopSpend) {
    const troopSpend = actions.find(
      (action) =>
        actionTargetID(action) === targetID &&
        (action.kind === "attack" || action.kind === "boat"),
    );
    if (troopSpend !== undefined) {
      return troopSpend;
    }
  }
  return actions.find((action) => actionTargetID(action) === targetID) ?? null;
}

function targetReadyToFinish(
  input: AgentBrainInput,
  targetID: string | null,
  action: LegalAction,
): boolean {
  if (targetID === null) {
    return false;
  }
  const player = visiblePlayer(input, targetID);
  const relativeTroopRatio =
    numericMetadata(action, "relativeTroopRatio") ??
    player?.relativeTroopRatio ??
    0;
  const targetShare =
    numericMetadata(action, "targetTileShare") ?? player?.tileShare ?? 1;
  return (
    relativeTroopRatio >= 1.5 ||
    targetShare <= 0.12 ||
    (input.observation.alivePlayerCount ?? Number.POSITIVE_INFINITY) <= 2
  );
}

function nearTroopCap(input: AgentBrainInput): boolean {
  const own = input.observation.ownState;
  if (own === null) {
    return false;
  }
  const ratio =
    own.troopRatio ??
    (own.maxTroops !== undefined && own.maxTroops > 0
      ? own.troops / own.maxTroops
      : 0);
  return ratio >= 0.85;
}

function nonConversionFallback(
  actions: readonly LegalAction[],
  input: AgentBrainInput,
  plan: StrategicPlan,
  cityMilestoneUsed: boolean,
): LegalAction {
  const early = input.observation.turnNumber < EARLY_SOCIAL_CUTOFF;
  const cityBlocked = (action: LegalAction) =>
    action.kind === "build" &&
    String(action.metadata?.unit ?? "").toLowerCase() === "city" &&
    (incomingAggressorIDs(input).length > 0 ||
      (cityMilestoneUsed && input.observation.turnNumber <= EARLY_CITY_CUTOFF));
  const eligible = actions.filter(
    (action) =>
      !conversionKinds.has(action.kind) &&
      action.kind !== "hold" &&
      !cityBlocked(action) &&
      !(early && socialKinds.has(action.kind)),
  );
  const directedBuild = eligible.find((action) => {
    if (plan.buildDirective === undefined || action.kind !== "build") {
      return false;
    }
    const unit = String(action.metadata?.unit ?? "");
    return (
      plan.buildDirective.unit === "any" || unit === plan.buildDirective.unit
    );
  });
  if (directedBuild !== undefined) {
    return directedBuild;
  }
  if (!early && plan.allianceDirective !== undefined) {
    const alliance = eligible.find(
      (action) =>
        (action.kind === "alliance_request" ||
          action.kind === "alliance_extend") &&
        (plan.allianceDirective?.targetPlayerId === undefined ||
          allianceRecipientID(action) ===
            plan.allianceDirective.targetPlayerId),
    );
    if (alliance !== undefined) {
      return alliance;
    }
  }
  const economy = eligible.find(
    (action) => action.kind === "build" || action.kind === "upgrade_structure",
  );
  if (economy !== undefined) {
    return economy;
  }
  const neutral =
    actions.find(
      (action) =>
        isNeutralExpansion(action) && isThirtyFivePercentExpansion(action),
    ) ?? actions.find(isNeutralExpansion);
  if (neutral !== undefined) {
    return neutral;
  }
  return eligible[0] ?? safeFallback(actions);
}

function safeFallback(actions: readonly LegalAction[]): LegalAction {
  const selected =
    actions.find((action) => action.kind === "hold") ?? actions[0];
  if (selected === undefined) {
    throw new Error(
      "Coworld single-action executor cannot select from an empty offered action set",
    );
  }
  return selected;
}

function hasLivingRival(input: AgentBrainInput): boolean {
  return input.observation.visiblePlayers.some(
    (player) =>
      player.isAlive &&
      !player.isAllied &&
      !player.isFriendly &&
      !player.isTeammate,
  );
}

function visiblePlayer(
  input: AgentBrainInput,
  targetID: string,
): AgentVisiblePlayer | null {
  return (
    input.observation.visiblePlayers.find(
      (player) => player.playerID === targetID,
    ) ?? null
  );
}

function numericMetadata(action: LegalAction, key: string): number | null {
  const value = action.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function transitionText(
  previous: KeystoneConversionState,
  next: KeystoneConversionState,
): string {
  return previous === next ? "none" : `${previous}>${next}`;
}

function markerWithSocialSuppression(
  marker: string,
  earlySocialSuppressed: boolean,
): string {
  return earlySocialSuppressed ? `${marker}+early_social_suppression` : marker;
}
