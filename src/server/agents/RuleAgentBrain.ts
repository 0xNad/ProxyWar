import {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentStrategyProfile,
  LegalAction,
} from "./AgentTypes";
import { spawnScoreForProfile } from "./LegalActionBuilder";

export class RuleAgentBrain implements AgentBrain {
  readonly brainType = "rule";

  constructor(private readonly profile: AgentStrategyProfile) {}

  decide(input: AgentBrainInput): AgentDecision {
    const selected = this.selectAction(input);
    return {
      actionID: selected.id,
      reason: `${this.profile} rule brain selected ${selected.label}`,
    };
  }

  private selectAction(input: AgentBrainInput): LegalAction {
    const { legalActions } = input;
    const hold = legalActions.find((action) => action.kind === "hold");
    if (legalActions.length === 0) {
      throw new Error("RuleAgentBrain requires at least one legal action");
    }

    const spawn = this.bestSpawnAction(legalActions);
    if (input.observation.strategic.priority === "spawn" && spawn) {
      return spawn;
    }

    const objective = this.preferredObjectiveAction(input);
    if (objective) {
      return objective;
    }

    const strategic = this.preferredStrategicAction(input);
    if (strategic) {
      return strategic;
    }

    if (this.profile === "diplomatic") {
      const alliance = legalActions.find(
        (action) => action.kind === "alliance_request",
      );
      if (alliance) return alliance;
      const support = legalActions.find(
        (action) =>
          action.kind === "donate_troops" || action.kind === "donate_gold",
      );
      if (support) return support;
      const build = this.preferredBuild(legalActions);
      if (build) return build;
      const embargo = legalActions.find((action) => action.kind === "embargo");
      if (embargo) return embargo;
    }

    if (this.profile === "aggressive") {
      const attack = legalActions.find((action) => action.kind === "attack");
      if (attack) return attack;
      const build = this.preferredBuild(legalActions);
      if (build) return build;
      const embargo = legalActions.find((action) => action.kind === "embargo");
      if (embargo) return embargo;
    }

    if (this.profile === "opportunistic") {
      const lowRiskAttack = legalActions.find(
        (action) => action.kind === "attack" && action.risk.level === "low",
      );
      if (lowRiskAttack) return lowRiskAttack;
      const build = this.preferredBuild(legalActions);
      if (build) return build;
      const embargo = legalActions.find((action) => action.kind === "embargo");
      if (embargo) return embargo;
    }

    if (this.profile === "defensive") {
      const defensiveBuild =
        this.preferredDefensiveBuild(legalActions) ??
        this.preferredBuild(legalActions);
      if (defensiveBuild) return defensiveBuild;
      const alliance = legalActions.find(
        (action) => action.kind === "alliance_request",
      );
      if (alliance) return alliance;
    }

    if (spawn) return spawn;

    return hold ?? legalActions[0];
  }

  private preferredStrategicAction(
    input: AgentBrainInput,
  ): LegalAction | null {
    const { legalActions } = input;
    switch (input.observation.strategic.priority) {
      case "expand":
        if (this.shouldDiversifyExpansion(input)) {
          const build = this.preferredBuild(legalActions);
          if (build) return build;
          const embargo = legalActions.find(
            (action) => action.kind === "embargo",
          );
          if (embargo) return embargo;
        }
        return (
          legalActions.find(
            (action) =>
              action.kind === "attack" && action.metadata?.expansion === true,
          ) ??
          legalActions.find(
            (action) => action.kind === "boat" && action.metadata?.targetID === null,
          ) ??
          null
        );
      case "attack":
        return (
          legalActions.find(
            (action) =>
              action.kind === "attack" && action.metadata?.expansion !== true,
          ) ??
          legalActions.find((action) => action.kind === "attack") ??
          null
        );
      case "build_economy":
        return (
          legalActions.find(
            (action) =>
              action.kind === "build" && action.metadata?.role === "economic",
          ) ??
          legalActions.find((action) => action.kind === "upgrade_structure") ??
          this.preferredBuild(legalActions) ??
          null
        );
      case "build_defense":
        return (
          this.preferredDefensiveBuild(legalActions) ??
          legalActions.find((action) => action.kind === "warship") ??
          legalActions.find((action) => action.kind === "move_warship") ??
          this.preferredBuild(legalActions) ??
          null
        );
      case "ally":
        if (this.profile !== "diplomatic") {
          return null;
        }
        return (
          legalActions.find((action) => action.kind === "alliance_request") ??
          null
        );
      case "support":
        if (this.profile !== "diplomatic") {
          return null;
        }
        return (
          legalActions.find(
            (action) =>
              action.kind === "donate_troops" || action.kind === "donate_gold",
          ) ?? null
        );
      case "pressure":
        return (
          legalActions.find(
            (action) =>
              action.kind === "embargo" ||
              action.kind === "embargo_all" ||
              action.kind === "target_player",
          ) ?? null
        );
      case "naval":
        return (
          legalActions.find((action) => action.kind === "boat") ??
          legalActions.find((action) => action.kind === "warship") ??
          legalActions.find((action) => action.kind === "move_warship") ??
          null
        );
      case "nuclear":
        return legalActions.find((action) => action.kind === "nuke") ?? null;
      case "hold":
      case "spawn":
        return null;
    }
  }

  private preferredObjectiveAction(
    input: AgentBrainInput,
  ): LegalAction | null {
    const { legalActions } = input;
    const objective = input.observation.objective;
    if (objective === null || objective.status !== "active") {
      return null;
    }

    switch (objective.kind) {
      case "choose_spawn":
        return this.bestSpawnAction(legalActions);
      case "expand_territory":
        if (this.shouldDiversifyExpansion(input)) {
          const build = this.preferredBuild(legalActions);
          if (build) return build;
        }
        return (
          legalActions.find(
            (action) =>
              action.kind === "attack" && action.metadata?.expansion === true,
          ) ??
          legalActions.find(
            (action) => action.kind === "boat" && action.metadata?.targetID === null,
          ) ??
          null
        );
      case "secure_economy":
        return (
          legalActions.find(
            (action) =>
              action.kind === "build" && action.metadata?.role === "economic",
          ) ??
          legalActions.find((action) => action.kind === "upgrade_structure") ??
          legalActions.find(
            (action) =>
              action.kind === "build" &&
              (action.metadata?.unit === "City" ||
                action.metadata?.unit === "Factory"),
          ) ??
          null
        );
      case "fortify_border":
        return (
          legalActions.find((action) => action.kind === "retreat") ??
          legalActions.find((action) => action.kind === "boat_retreat") ??
          this.preferredDefensiveBuild(legalActions) ??
          legalActions.find((action) => action.kind === "warship") ??
          legalActions.find((action) => action.kind === "move_warship") ??
          legalActions.find((action) => action.kind === "alliance_request") ??
          legalActions.find((action) => action.kind === "alliance_extend") ??
          null
        );
      case "pressure_rival":
        return (
          legalActions.find(
            (action) =>
              action.kind === "attack" && action.metadata?.expansion !== true,
          ) ??
          legalActions.find((action) => action.kind === "nuke") ??
          legalActions.find((action) => action.kind === "embargo_all") ??
          legalActions.find((action) => action.kind === "embargo") ??
          legalActions.find((action) => action.kind === "target_player") ??
          null
        );
      case "build_alliance":
        return (
          legalActions.find((action) => action.kind === "alliance_request") ??
          legalActions.find((action) => action.kind === "alliance_extend") ??
          legalActions.find(
            (action) =>
              action.kind === "donate_troops" || action.kind === "donate_gold",
          ) ??
          legalActions.find((action) => action.kind === "embargo_stop") ??
          legalActions.find((action) => action.kind === "quick_chat") ??
          null
        );
      case "survive":
        return (
          legalActions.find((action) => action.kind === "retreat") ??
          legalActions.find((action) => action.kind === "boat_retreat") ??
          this.preferredDefensiveBuild(legalActions) ??
          legalActions.find((action) => action.kind === "warship") ??
          legalActions.find((action) => action.kind === "move_warship") ??
          legalActions.find((action) => action.kind === "alliance_request") ??
          legalActions.find((action) => action.kind === "alliance_extend") ??
          legalActions.find((action) => action.kind === "embargo_stop") ??
          null
        );
    }
  }

  private preferredBuild(legalActions: LegalAction[]): LegalAction | null {
    const builds = legalActions.filter((action) => action.kind === "build");
    if (builds.length === 0) {
      return null;
    }
    if (this.profile === "defensive") {
      return (
        this.preferredDefensiveBuild(legalActions) ??
        builds.find((action) => action.metadata?.unit === "City") ??
        builds.find((action) => action.metadata?.unit === "Factory") ??
        builds[0]
      );
    }
    return (
      builds.find((action) => action.metadata?.unit === "City") ??
      builds.find((action) => action.metadata?.unit === "Factory") ??
      builds[0]
    );
  }

  private preferredDefensiveBuild(
    legalActions: LegalAction[],
  ): LegalAction | null {
    const defensiveBuilds = legalActions.filter(
      (action) => action.kind === "build" && action.metadata?.role === "defensive",
    );
    if (defensiveBuilds.length === 0) {
      return null;
    }
    const best = defensiveBuilds
      .map((action) => ({
        action,
        score: defenseBuildScore(action),
      }))
      .sort(
        (a, b) =>
          b.score - a.score || a.action.id.localeCompare(b.action.id),
      )[0];
    return best.score >= 10 ? best.action : null;
  }

  private shouldDiversifyExpansion(input: AgentBrainInput): boolean {
    return (
      input.observation.memory.recentExpansionCount >= 2 &&
      input.legalActions.some(
        (action) => action.kind === "build" || action.kind === "embargo",
      )
    );
  }

  private bestSpawnAction(legalActions: LegalAction[]): LegalAction | null {
    const spawns = legalActions.filter((action) => action.kind === "spawn");
    if (spawns.length === 0) {
      return null;
    }
    return spawns
      .map((action) => ({
        action,
        score: spawnScoreForProfile(this.profile, action),
      }))
      .sort((a, b) => b.score - a.score)[0].action;
  }
}

function defenseBuildScore(action: LegalAction): number {
  if (!isDefensePost(action)) {
    return 60;
  }
  const defensiveValue = metadataNumber(action, "defensiveValue");
  const frontierValue = metadataNumber(action, "frontierValue");
  const nearbyEnemyCount = metadataNumber(action, "nearbyEnemyCount");
  const hostileBorderDistance = metadataNumber(action, "hostileBorderDistance");
  const incoming = action.metadata?.nearbyIncomingAttack === true;
  if (!hasPlacementMetadata(action)) {
    return 55;
  }
  if (
    !incoming &&
    nearbyEnemyCount === 0 &&
    defensiveValue < 0.28 &&
    (hostileBorderDistance === 0 || hostileBorderDistance > 60)
  ) {
    return 2;
  }
  return 30 + defensiveValue * 50 + frontierValue * 20 + nearbyEnemyCount * 4;
}

function isDefensePost(action: LegalAction): boolean {
  return action.metadata?.unit === "Defense Post" || action.metadata?.unit === "DefensePost";
}

function hasPlacementMetadata(action: LegalAction): boolean {
  return (
    action.metadata?.defensiveValue !== undefined ||
    action.metadata?.frontierValue !== undefined ||
    action.metadata?.hostileBorderDistance !== undefined
  );
}

function metadataNumber(action: LegalAction, key: string): number {
  const value = action.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
