import type {
  AgentExecutionDecision,
  AgentExecutor,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  buildKeystoneWorldModel,
  normalizeKeystoneCommanderContext,
  proposeKeystoneSurvival,
  type KeystoneWorldModel,
} from "./keystone-experts";

export const KEYSTONE_SURVIVAL_SHIELD_MARKER = "keystone-survival-shield:v2";
export const KEYSTONE_DEFENSE_AUTHORITY_MARKER =
  "keystone-defense-authority:v2";

export type KeystoneSurvivalShieldAdjudication =
  | "survival_preempted"
  | "survival_confirmed"
  | "infrastructure_error";

type KeystoneDefenseAuthorityAdjudication =
  | "no_edge_conquest_preempted"
  | "cross_target_collapse_preempted";

export interface KeystoneSurvivalShieldExecutorOptions {
  readonly delegate: AgentExecutor;
  readonly actionFollowsCanonicalPlan: (args: {
    input: AgentBrainInput;
    plan: StrategicPlan;
    action: LegalAction;
  }) => boolean;
  /** Same-image v39 treatment; default off. */
  readonly defenseAuthorityEnabled?: boolean;
}

const SEVERE_THREAT_RATIO = 0.35;
const SEVERE_TILE_LOSS_RATIO = 0.25;
const CROSS_TARGET_THREAT_RATIO = 0.1;
const CROSS_TARGET_TILE_LOSS_RATIO = 0.08;
const NO_EDGE_RELATIVE_TROOP_RATIO_BP = 12_500;
const DEFENSIVE_BUILD_COOLDOWN_DECISIONS = 3;
const defensiveUnits = new Set(["defense post"]);

/**
 * Default-off shield around v16. Ordinary decisions remain byte-for-byte
 * delegated. Only severe observed pressure or accepted recent territory loss
 * may preempt stale growth/economy with an exact retreat, nearby Defense Post,
 * or bounded counter. Moderate pressure delegates after the v1 Defense-Post
 * treatment regressed its causal smoke. The base shield never displaces a
 * hostile campaign; the optional defense-authority treatment may stop only a
 * canonical no-edge or verified cross-target collapse. Both paths choose exact
 * offered actions, never invent an intent, and fail closed to v16.
 */
export class KeystoneSurvivalShieldExecutor implements AgentExecutor {
  constructor(
    private readonly options: KeystoneSurvivalShieldExecutorOptions,
  ) {}

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    const authoritative = this.options.delegate.decide(input, plan);
    try {
      const world = this.world(input, plan);
      const defenseAuthorityAdjudication =
        this.options.defenseAuthorityEnabled === true
          ? adjudicateUnsafeConquest(input, world, authoritative.actionID)
          : null;
      if (defenseAuthorityAdjudication !== null) {
        return defenseAuthorityDecision(
          world,
          authoritative.actionID,
          defenseAuthorityAdjudication,
        );
      }
      const pressure = survivalPressure(input);
      if (!pressure.severe) {
        return authoritative;
      }
      const survival = proposeKeystoneSurvival(world, {
        allowRetreats: true,
        allowDefensiveBuilds: !recentDefensiveBuild(input),
        allowCounters: true,
        defensePostOnly: true,
        requireNearbyIncomingAttackForDefensiveBuild: true,
      });
      if (survival === null) {
        return authoritative;
      }
      if (survival.actionID === authoritative.actionID) {
        return markedUnchanged(authoritative, "survival_confirmed");
      }
      const authoritativeAction = world.actions.find(
        (action) => action.id === authoritative.actionID,
      );
      if (
        authoritativeAction === undefined ||
        !isPreemptable(authoritativeAction)
      ) {
        return authoritative;
      }
      return replacementDecision(world, survival.actionID, survival.source);
    } catch {
      if (this.options.defenseAuthorityEnabled === true) {
        return markedDefenseAuthorityError(authoritative);
      }
      return markedUnchanged(authoritative, "infrastructure_error");
    }
  }

  private world(
    input: AgentBrainInput,
    plan: StrategicPlan,
  ): KeystoneWorldModel {
    const planAlignedActionIDs: string[] = [];
    for (const action of input.legalActions) {
      if (this.options.actionFollowsCanonicalPlan({ input, plan, action })) {
        planAlignedActionIDs.push(action.id);
      }
    }
    return buildKeystoneWorldModel(input, {
      forbiddenActionKinds: plan.forbiddenActionKinds,
      planAlignedActionIDs,
      commander: normalizeKeystoneCommanderContext(plan),
    });
  }
}

function adjudicateUnsafeConquest(
  input: AgentBrainInput,
  world: KeystoneWorldModel,
  authoritativeActionID: string,
): KeystoneDefenseAuthorityAdjudication | null {
  if (input.observation.strategic.priority !== "build_defense") {
    return null;
  }
  const action = world.actions.find(
    (candidate) => candidate.id === authoritativeActionID,
  );
  if (
    action === undefined ||
    action.kind !== "attack" ||
    !action.isHostileTargetAction ||
    action.actionOwner !== "conquest" ||
    action.targetPlayerID === null ||
    action.targetsFriendlyOrTeam ||
    action.forbidden ||
    action.safetyBlocked
  ) {
    return null;
  }
  const target = world.players.find(
    (candidate) => candidate.playerID === action.targetPlayerID,
  );
  if (target === undefined || !target.isAlive || target.friendlyOrTeam) {
    return null;
  }

  const conversion =
    input.observation.tacticalAffordances?.frontierConversionTiming;
  const finish = input.observation.tacticalAffordances?.frontierFinishPressure;
  const relativeTroopRatioBP = target?.relativeTroopRatioBP;
  if (
    !target.incomingAttack &&
    conversion?.executorReady === false &&
    finish?.recommended === false &&
    relativeTroopRatioBP !== null &&
    relativeTroopRatioBP !== undefined &&
    relativeTroopRatioBP > 0 &&
    relativeTroopRatioBP < NO_EDGE_RELATIVE_TROOP_RATIO_BP
  ) {
    return "no_edge_conquest_preempted";
  }

  const exactCanonicalFinish =
    finish?.recommended === true &&
    finish.bestTargetID === action.targetPlayerID &&
    finish.bestAttackID === action.id;
  const crossTargetCollapse =
    input.observation.strategic.urgency === "high" &&
    world.incomingAggressorIDs.length > 0 &&
    !world.incomingAggressorIDs.includes(action.targetPlayerID) &&
    activeIncomingThreat(input).ratio >= CROSS_TARGET_THREAT_RATIO &&
    recentTileLossRatio(input) >= CROSS_TARGET_TILE_LOSS_RATIO;
  return crossTargetCollapse && !exactCanonicalFinish
    ? "cross_target_collapse_preempted"
    : null;
}

function defenseAuthorityDecision(
  world: KeystoneWorldModel,
  authoritativeActionID: string,
  adjudication: KeystoneDefenseAuthorityAdjudication,
): AgentExecutionDecision {
  const authoritativeAction = world.actions.find(
    (action) => action.id === authoritativeActionID,
  );
  if (
    authoritativeAction === undefined ||
    authoritativeAction.targetPlayerID === null
  ) {
    throw new Error("Defense authority conquest target is missing");
  }
  const campaignRetreats = world.actions.filter(
    (action) =>
      action.kind === "retreat" &&
      action.targetPlayerID === authoritativeAction.targetPlayerID &&
      action.actionOwner === "survival" &&
      !action.forbidden &&
      !action.safetyBlocked,
  );
  if (campaignRetreats.length === 1) {
    return defenseAuthorityReplacement(
      world,
      campaignRetreats[0]!.id,
      "retreated the preempted campaign before defending the home front",
      "survival",
      adjudication,
    );
  }
  const survival = proposeKeystoneSurvival(world, {
    // Only an exact retreat from the preempted campaign may outrank a counter.
    // A generic retreat could cancel a different defensive operation.
    allowRetreats: false,
    // The failed v1 experiment showed that moderate-pressure Defense Posts are
    // not a safe default. This arm can redirect to a retreat/counter, otherwise
    // it conserves the reserve with hold.
    allowDefensiveBuilds: false,
    allowCounters: true,
    defensePostOnly: true,
    requireNearbyIncomingAttackForDefensiveBuild: true,
  });
  if (survival !== null) {
    return defenseAuthorityReplacement(
      world,
      survival.actionID,
      `redirected to ${survival.source}`,
      "survival",
      adjudication,
    );
  }
  const holds = world.actions.filter((action) => action.isHold);
  if (holds.length !== 1) {
    throw new Error("Defense authority hold is not uniquely offered");
  }
  return defenseAuthorityReplacement(
    world,
    holds[0]!.id,
    adjudication === "cross_target_collapse_preempted"
      ? "conserved the home front instead of continuing a different war"
      : "conserved reserves instead of opening a no-edge side war",
    "reserve",
    adjudication,
  );
}

function defenseAuthorityReplacement(
  world: KeystoneWorldModel,
  actionID: string,
  detail: string,
  source: "survival" | "reserve",
  adjudication: KeystoneDefenseAuthorityAdjudication,
): AgentExecutionDecision {
  const actions = world.actions.filter((action) => action.id === actionID);
  if (actions.length !== 1) {
    throw new Error("Defense authority replacement is not uniquely offered");
  }
  return Object.freeze({
    actionID,
    actionIDs: [actionID],
    reason: `[${KEYSTONE_DEFENSE_AUTHORITY_MARKER} ${adjudication}] ${detail}`,
    planFollowed: actions[0]!.planAligned,
    executorSource: "keystone-survival-shield",
    actionSelectionSource: `keystone-defense-authority:${source}`,
  });
}

function markedDefenseAuthorityError(
  authoritative: AgentExecutionDecision,
): AgentExecutionDecision {
  return Object.freeze({
    ...authoritative,
    reason: `[${KEYSTONE_DEFENSE_AUTHORITY_MARKER} infrastructure_error] ${authoritative.reason}`,
    executorSource: "keystone-survival-shield",
    actionSelectionSource: "keystone-defense-authority:infrastructure_error",
  });
}

function survivalPressure(input: AgentBrainInput): {
  readonly verified: boolean;
  readonly severe: boolean;
} {
  const threat = activeIncomingThreat(input);
  const tileLossRatio = recentTileLossRatio(input);
  const severe =
    threat.ratio >= SEVERE_THREAT_RATIO ||
    tileLossRatio >= SEVERE_TILE_LOSS_RATIO;
  return Object.freeze({
    verified: threat.ratio >= 0.1 || threat.attackerCount >= 2,
    severe,
  });
}

function activeIncomingThreat(input: AgentBrainInput): {
  readonly ratio: number;
  readonly attackerCount: number;
} {
  const observation = input.observation;
  const ownTeam = observation.ownState?.team ?? null;
  const playerByID = new Map(
    observation.visiblePlayers.map((player) => [player.playerID, player]),
  );
  const active = (observation.combat.incomingAttacks ?? []).filter((attack) => {
    if (
      attack.retreating ||
      attack.targetID === null ||
      !Number.isFinite(attack.troops) ||
      attack.troops <= 0
    ) {
      return false;
    }
    const player = playerByID.get(attack.targetID);
    return (
      player !== undefined &&
      player.isAlive &&
      !player.isAllied &&
      !player.isFriendly &&
      player.isTeammate !== true &&
      !(
        ownTeam !== null &&
        player.team !== null &&
        player.team !== undefined &&
        player.team === ownTeam
      )
    );
  });
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  const incomingTroops = active.reduce(
    (sum, attack) => sum + Math.max(0, attack.troops),
    0,
  );
  return Object.freeze({
    ratio:
      ownTroops > 0
        ? incomingTroops / ownTroops
        : incomingTroops > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    attackerCount: new Set(active.map((attack) => attack.targetID)).size,
  });
}

function recentTileLossRatio(input: AgentBrainInput): number {
  const current = input.observation.ownState?.tilesOwned;
  if (current === undefined || current < 0) {
    return 0;
  }
  let priorHigh = current;
  for (const decision of input.observation.recentDecisions) {
    if (
      decision.accepted &&
      typeof decision.ownTiles === "number" &&
      Number.isFinite(decision.ownTiles)
    ) {
      priorHigh = Math.max(priorHigh, decision.ownTiles);
    }
  }
  return priorHigh > 0 ? Math.max(0, (priorHigh - current) / priorHigh) : 0;
}

function recentDefensiveBuild(input: AgentBrainInput): boolean {
  return input.observation.recentDecisions
    .slice(-DEFENSIVE_BUILD_COOLDOWN_DECISIONS)
    .some(
      (decision) =>
        decision.accepted &&
        decision.actionKind === "build" &&
        typeof decision.unit === "string" &&
        defensiveUnits.has(
          decision.unit
            .trim()
            .toLowerCase()
            .replace(/[\s_-]+/g, " "),
        ),
    );
}

function isPreemptable(action: KeystoneWorldModel["actions"][number]): boolean {
  return (
    action.isHold ||
    action.isNeutralExpansion ||
    action.actionOwner === "economy" ||
    action.actionOwner === "politics"
  );
}

function replacementDecision(
  world: KeystoneWorldModel,
  actionID: string,
  source: string,
): AgentExecutionDecision {
  const actions = world.actions.filter((action) => action.id === actionID);
  if (actions.length !== 1) {
    throw new Error("Survival shield replacement is not uniquely offered");
  }
  return Object.freeze({
    actionID,
    actionIDs: [actionID],
    reason: `[${KEYSTONE_SURVIVAL_SHIELD_MARKER} survival_preempted] selected ${source}`,
    planFollowed: actions[0]!.planAligned,
    executorSource: "keystone-survival-shield",
    actionSelectionSource: "keystone-survival-shield:survival",
  });
}

function markedUnchanged(
  authoritative: AgentExecutionDecision,
  adjudication: Exclude<
    KeystoneSurvivalShieldAdjudication,
    "survival_preempted"
  >,
): AgentExecutionDecision {
  return Object.freeze({
    ...authoritative,
    reason: `[${KEYSTONE_SURVIVAL_SHIELD_MARKER} ${adjudication}] ${authoritative.reason}`,
    executorSource: "keystone-survival-shield",
    actionSelectionSource: `keystone-survival-shield:${adjudication}`,
  });
}
