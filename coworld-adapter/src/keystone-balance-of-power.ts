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
  arbitrateKeystoneAction,
  buildKeystoneWorldModel,
  normalizeKeystoneCommanderContext,
  proposeKeystoneConquest,
  proposeKeystoneEconomy,
  proposeKeystoneExpansion,
  proposeKeystonePolitics,
  proposeKeystoneSurvival,
  resolveKeystoneBindingDirective,
  type KeystoneBalanceOfPowerFacts,
  type KeystoneExpertProposal,
  type KeystoneWorldModel,
} from "./keystone-experts";

export const KEYSTONE_BALANCE_OF_POWER_MARKER = "keystone-balance-of-power:v1";

export interface KeystoneBalanceOfPowerExecutorOptions {
  readonly delegate: AgentExecutor;
  readonly actionFollowsCanonicalPlan: (args: {
    input: AgentBrainInput;
    plan: StrategicPlan;
    action: LegalAction;
  }) => boolean;
}

interface BalanceObservationIdentity {
  readonly gameID: string;
  readonly leaderPlayerID: string;
  readonly strongestOtherNonLeaderPlayerID: string;
  readonly decisionFingerprint: string;
  readonly turnNumber: number;
}

export type KeystoneBalanceOfPowerAdjudication =
  | "buffer_attack_preempted"
  | "infrastructure_error"
  | "leader_attack_redirected"
  | "no_safe_replacement";

/**
 * Default-off Council-native balance-of-power adjudicator. It observes two
 * distinct consecutive decisions with the same runaway leader and strongest
 * other nonleader before adjudicating. Before that point, whenever exact
 * evidence disappears, and for every non-trigger decision, the frozen v40
 * delegate remains object-for-object authoritative. The narrow trigger is an
 * exact v40 hostile action against that strongest other nonleader. Only then
 * may the Council substitute one exact offered id; any ambiguity or
 * infrastructure error fails closed to the already-computed v40 decision.
 */
export class KeystoneBalanceOfPowerExecutor implements AgentExecutor {
  private previous: BalanceObservationIdentity | null = null;
  private stableDecisionCount = 0;

  constructor(
    private readonly options: KeystoneBalanceOfPowerExecutorOptions,
  ) {}

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    let world: KeystoneWorldModel;
    try {
      world = this.world(input, plan);
    } catch {
      this.resetStability();
      return markedInfrastructureError(
        this.options.delegate.decide(input, plan),
        null,
        "world",
      );
    }

    const stableBalance = this.observeStableBalance(input, world);
    const authoritative = this.options.delegate.decide(input, plan);
    if (!stableBalance) {
      return authoritative;
    }

    try {
      const originalActions = world.actions.filter(
        (action) => action.id === authoritative.actionID,
      );
      const original = originalActions[0];
      const strongestOtherID =
        world.balanceOfPower?.strongestOtherNonLeaderPlayerID ?? null;
      if (
        originalActions.length !== 1 ||
        input.legalActions.filter(
          (action) => action.id === authoritative.actionID,
        ).length !== 1 ||
        original === undefined ||
        (original.kind !== "attack" &&
          original.kind !== "boat" &&
          original.kind !== "nuke") ||
        !original.isHostileTargetAction ||
        original.targetPlayerID === null ||
        original.targetPlayerID !== strongestOtherID ||
        world.incomingAggressorIDs.includes(strongestOtherID) ||
        original.targetsFriendlyOrTeam ||
        original.safetyBlocked
      ) {
        return authoritative;
      }

      const survival = proposeKeystoneSurvival(world, {
        allowRetreats: true,
        allowDefensiveBuilds: true,
        allowCounters: false,
      });
      const binding = resolveKeystoneBindingDirective(world);
      const expertAuction = [
        proposeKeystoneExpansion(world),
        proposeKeystoneEconomy(world),
        proposeKeystoneConquest(world),
        proposeKeystonePolitics(world),
      ].filter(
        (proposal): proposal is KeystoneExpertProposal => proposal !== null,
      );
      const result = arbitrateKeystoneAction(world, {
        spawn: [],
        survival: survival === null ? [] : [survival],
        bindingDirective: binding.proposal === null ? [] : [binding.proposal],
        expertAuction,
      });
      const selection = result.selection;
      if (
        selection === null ||
        selection.actionID === authoritative.actionID ||
        input.legalActions.filter((action) => action.id === selection.actionID)
          .length !== 1 ||
        world.actions.filter((action) => action.id === selection.actionID)
          .length !== 1
      ) {
        return markedNoSafeReplacement(authoritative, world);
      }
      const replacement = world.actions.find(
        (action) => action.id === selection.actionID,
      )!;
      const adjudication: KeystoneBalanceOfPowerAdjudication =
        (replacement.kind === "attack" ||
          replacement.kind === "boat" ||
          replacement.kind === "nuke") &&
        replacement.isHostileTargetAction &&
        replacement.targetPlayerID === world.balanceOfPower!.leaderPlayerID
          ? "leader_attack_redirected"
          : "buffer_attack_preempted";

      return Object.freeze({
        actionID: selection.actionID,
        actionIDs: [selection.actionID],
        reason: activeReason(
          world,
          adjudication,
          authoritative.actionID,
          selection.actionID,
          selection.source,
        ),
        planFollowed: selection.planAligned,
        executorSource: "keystone-balance-of-power",
        actionSelectionSource: `keystone-balance-of-power:${selection.source}`,
      });
    } catch {
      return markedInfrastructureError(authoritative, world, "council");
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
      balanceOfPowerEnabled: true,
    });
  }

  private observeStableBalance(
    input: AgentBrainInput,
    world: KeystoneWorldModel,
  ): boolean {
    const balance = world.balanceOfPower ?? null;
    if (balance === null || balance.strongestOtherNonLeaderPlayerID === null) {
      this.resetStability();
      return false;
    }

    const current = Object.freeze({
      gameID: world.gameID,
      leaderPlayerID: balance.leaderPlayerID,
      strongestOtherNonLeaderPlayerID: balance.strongestOtherNonLeaderPlayerID,
      decisionFingerprint: observationDecisionFingerprint(input),
      turnNumber: world.turnNumber,
    });
    const previous = this.previous;
    const samePowerOrdering =
      previous !== null &&
      previous.gameID === current.gameID &&
      previous.leaderPlayerID === current.leaderPlayerID &&
      previous.strongestOtherNonLeaderPlayerID ===
        current.strongestOtherNonLeaderPlayerID;
    const distinctForwardObservation =
      previous !== null &&
      previous.decisionFingerprint !== current.decisionFingerprint &&
      current.turnNumber >= previous.turnNumber;

    if (samePowerOrdering && distinctForwardObservation) {
      this.stableDecisionCount += 1;
    } else if (
      !samePowerOrdering ||
      current.turnNumber < (previous?.turnNumber ?? 0)
    ) {
      this.stableDecisionCount = 1;
    }
    // An exact platform retry of the same observation neither arms nor resets
    // authority; once stable it remains stable for that retry.
    this.previous = current;
    return this.stableDecisionCount >= 2;
  }

  private resetStability(): void {
    this.previous = null;
    this.stableDecisionCount = 0;
  }
}

function observationDecisionFingerprint(input: AgentBrainInput): string {
  const latestSequence = input.observation.recentDecisions.reduce(
    (maximum, decision) => Math.max(maximum, decision.sequence),
    -1,
  );
  return `${input.observation.turnNumber}:${input.observation.tick ?? "-"}:${latestSequence}`;
}

function activeReason(
  world: KeystoneWorldModel,
  adjudication: KeystoneBalanceOfPowerAdjudication,
  originalActionID: string,
  replacementActionID: string,
  source: string,
): string {
  const balance = world.balanceOfPower ?? null;
  if (balance === null) {
    throw new Error("Balance telemetry requires an active balance snapshot");
  }
  return (
    `[${KEYSTONE_BALANCE_OF_POWER_MARKER} ${adjudication} ` +
    `leader=${balance.leaderPlayerID} ` +
    `other=${balance.strongestOtherNonLeaderPlayerID ?? "-"} ` +
    `shares=${compactShares(balance)} ` +
    `original=${originalActionID} replacement=${replacementActionID} ` +
    `offered_original=1 offered_replacement=1 ` +
    `source=${source} ` +
    `]`
  );
}

function markedNoSafeReplacement(
  authoritative: AgentExecutionDecision,
  world: KeystoneWorldModel,
): AgentExecutionDecision {
  const balance = world.balanceOfPower ?? null;
  if (balance === null) {
    return authoritative;
  }
  const marker =
    `[${KEYSTONE_BALANCE_OF_POWER_MARKER} no_safe_replacement ` +
    `leader=${balance.leaderPlayerID} ` +
    `other=${balance.strongestOtherNonLeaderPlayerID ?? "-"} ` +
    `shares=${compactShares(balance)} ` +
    `original=${authoritative.actionID} offered_original=1]`;
  return Object.freeze({
    ...authoritative,
    reason: `${marker} ${authoritative.reason}`.slice(0, 500),
    executorSource: "keystone-balance-of-power",
    actionSelectionSource: "keystone-balance-of-power:no_safe_replacement",
  });
}

function markedInfrastructureError(
  authoritative: AgentExecutionDecision,
  world: KeystoneWorldModel | null,
  stage: "world" | "council",
): AgentExecutionDecision {
  const balance = world?.balanceOfPower ?? null;
  const evidence =
    balance === null
      ? ""
      : ` leader=${balance.leaderPlayerID} other=${balance.strongestOtherNonLeaderPlayerID ?? "-"} shares=${compactShares(balance)}`;
  const marker =
    `[${KEYSTONE_BALANCE_OF_POWER_MARKER} infrastructure_error ` +
    `stage=${stage}${evidence} original=${authoritative.actionID}]`;
  return Object.freeze({
    ...authoritative,
    reason: `${marker} ${authoritative.reason}`.slice(0, 500),
    executorSource: "keystone-balance-of-power",
    actionSelectionSource: "keystone-balance-of-power:infrastructure_error",
  });
}

function compactShares(balance: KeystoneBalanceOfPowerFacts): string {
  return [
    balance.leaderTileShareBP,
    balance.runnerUpTileShareBP,
    balance.ownTileShareBP,
    balance.strongestOtherNonLeaderTileShareBP ?? "-",
  ].join("/");
}
