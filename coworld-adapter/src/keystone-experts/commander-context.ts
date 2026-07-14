import type { StrategicPlan } from "../../../src/server/agents/AgentPlannerExecutor";

import type {
  KeystoneCommanderBinding,
  KeystoneCommanderContext,
  KeystoneStructureUnitType,
} from "./types";

const buildUnitByDirective: Readonly<
  Record<
    NonNullable<StrategicPlan["buildDirective"]>["unit"],
    KeystoneStructureUnitType | "any"
  >
> = Object.freeze({
  City: "city",
  Factory: "factory",
  Port: "port",
  MissileSilo: "missile_silo",
  SAMLauncher: "sam_launcher",
  any: "any",
});

/**
 * Converts the already-validated Commander plan into Council-owned integer types.
 * Precedence is repeated defensively so injected/custom planners cannot create two
 * simultaneous hard orders. Current world legality is still checked by the proposer
 * and arbiter on every decision.
 */
export function normalizeKeystoneCommanderContext(
  plan: StrategicPlan,
): KeystoneCommanderContext {
  const binding =
    plan.commitment !== undefined
      ? normalizedAttackBinding(plan)
      : plan.allianceDirective !== undefined
        ? normalizedAllianceBinding(plan)
        : normalizedBuildBinding(plan);
  return Object.freeze({
    planID: plan.planID,
    binding,
  });
}

function normalizedAttackBinding(
  plan: StrategicPlan,
): KeystoneCommanderBinding | null {
  const commitment = plan.commitment;
  if (
    commitment === undefined ||
    commitment.targetPlayerId.trim().length === 0 ||
    !Number.isFinite(commitment.minAttackRatio) ||
    commitment.minAttackRatio < 0 ||
    commitment.minAttackRatio > 1
  ) {
    return null;
  }
  return Object.freeze({
    kind: "attack_target",
    domain: "conquest",
    targetPlayerID: commitment.targetPlayerId,
    minCommitmentBP: Math.round(commitment.minAttackRatio * 10_000),
  });
}

function normalizedAllianceBinding(
  plan: StrategicPlan,
): KeystoneCommanderBinding | null {
  const directive = plan.allianceDirective;
  if (
    directive === undefined ||
    (directive.stance !== "seek_alliance" &&
      directive.stance !== "hold_alliance")
  ) {
    return null;
  }
  const target = directive.targetPlayerId?.trim();
  return Object.freeze({
    kind: "alliance",
    domain: "politics",
    stance: directive.stance,
    targetPlayerID: target === undefined || target.length === 0 ? null : target,
  });
}

function normalizedBuildBinding(
  plan: StrategicPlan,
): KeystoneCommanderBinding | null {
  const directive = plan.buildDirective;
  if (directive === undefined) {
    return null;
  }
  const unit = buildUnitByDirective[directive.unit];
  return unit === undefined
    ? null
    : Object.freeze({
        kind: "build",
        domain: "economy",
        unit,
      });
}
