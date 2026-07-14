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

export const KEYSTONE_SURVIVAL_SHIELD_MARKER =
  "keystone-survival-shield:v1";

export type KeystoneSurvivalShieldAdjudication =
  | "survival_preempted"
  | "survival_confirmed"
  | "infrastructure_error";

export interface KeystoneSurvivalShieldExecutorOptions {
  readonly delegate: AgentExecutor;
  readonly actionFollowsCanonicalPlan: (args: {
    input: AgentBrainInput;
    plan: StrategicPlan;
    action: LegalAction;
  }) => boolean;
}

const SEVERE_THREAT_RATIO = 0.35;
const SEVERE_TILE_LOSS_RATIO = 0.25;
const DEFENSIVE_BUILD_COOLDOWN_DECISIONS = 3;
const defensiveUnits = new Set(["defense post"]);

/**
 * Default-off shield around v16. Ordinary decisions remain byte-for-byte
 * delegated. Under verified incoming pressure, the existing reviewed survival
 * proposer may preempt stale growth/economy with one exact nearby Defense Post;
 * retreats and bounded counters are admitted only during severe collapse. It
 * never invents an intent, never displaces a hostile campaign, and fails closed
 * to v16.
 */
export class KeystoneSurvivalShieldExecutor implements AgentExecutor {
  constructor(private readonly options: KeystoneSurvivalShieldExecutorOptions) {}

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    const authoritative = this.options.delegate.decide(input, plan);
    try {
      const world = this.world(input, plan);
      const pressure = survivalPressure(input);
      if (!pressure.verified) {
        return authoritative;
      }
      const survival = proposeKeystoneSurvival(world, {
        allowRetreats: pressure.severe,
        allowDefensiveBuilds: !recentDefensiveBuild(input),
        allowCounters: pressure.severe,
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
          decision.unit.trim().toLowerCase().replace(/[\s_-]+/g, " "),
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
