import {
  commanderPlanReplanReasons,
  commanderPlanTerminateReasons,
} from "./CommanderPlanLifecycle";
import {
  commanderFidelityClasses,
  type CommanderFidelityClass,
} from "./StrategicOptionExecutor";

export interface CommanderFidelityRecord {
  agentID?: string;
  sequence?: number;
  decisionMetadata?: Record<string, string | number | boolean | null>;
  result?: { accepted: boolean };
}

export interface CommanderFidelitySummary {
  counts: Record<CommanderFidelityClass, number>;
  actionsUnderCommanderPlans: number;
  classifiedDecisions: number;
  unknownDecisions: number;
  rejectedDecisions: number;
  unattributedDecisions: number;
  planCount: number;
  plansWithZeroAlignedActions: number;
  planTransitions: number;
  silentlyAbandonedPlans: number;
  fidelityRate: number | null;
  interpretable: boolean;
}

export function summarizeCommanderFidelity(
  records: readonly CommanderFidelityRecord[],
): CommanderFidelitySummary {
  const counts = Object.fromEntries(
    commanderFidelityClasses.map((value) => [value, 0]),
  ) as Record<CommanderFidelityClass, number>;
  let unknownDecisions = 0;
  let rejectedDecisions = 0;
  let unattributedDecisions = 0;
  let planTransitions = 0;
  let silentlyAbandonedPlans = 0;
  let actionsUnderCommanderPlans = 0;
  let classifiedDecisions = 0;
  const alignedByPlan = new Map<string, number>();
  const lastObservedPlanByAgent = new Map<string, string>();
  const transitionReasons = new Set<string>([
    ...commanderPlanReplanReasons,
    ...commanderPlanTerminateReasons,
  ]);
  const ordered = records
    .map((record, inputIndex) => ({ record, inputIndex }))
    .sort((left, right) => {
      const leftAgent = left.record.agentID ?? "__single_agent__";
      const rightAgent = right.record.agentID ?? "__single_agent__";
      if (leftAgent !== rightAgent) return leftAgent < rightAgent ? -1 : 1;
      const leftSequence = Number.isSafeInteger(left.record.sequence)
        ? left.record.sequence!
        : left.inputIndex;
      const rightSequence = Number.isSafeInteger(right.record.sequence)
        ? right.record.sequence!
        : right.inputIndex;
      return leftSequence - rightSequence || left.inputIndex - right.inputIndex;
    });
  for (const { record } of ordered) {
    const metadata = record.decisionMetadata ?? {};
    const planID = metadata.planID;
    const attributed = typeof planID === "string" && planID.length > 0;
    if (!attributed) {
      unattributedDecisions += 1;
    } else if (!alignedByPlan.has(planID)) {
      alignedByPlan.set(planID, 0);
    }

    if (attributed) {
      const agentID = record.agentID ?? "__single_agent__";
      const previousObservedPlanID = lastObservedPlanByAgent.get(agentID);
      if (
        previousObservedPlanID !== undefined &&
        previousObservedPlanID !== planID
      ) {
        planTransitions += 1;
        const claimedPreviousPlanID = metadata.commanderPreviousPlanID;
        const reason = metadata.commanderReplanReason;
        if (
          claimedPreviousPlanID !== previousObservedPlanID ||
          typeof reason !== "string" ||
          !transitionReasons.has(reason)
        ) {
          silentlyAbandonedPlans += 1;
        }
      }
      lastObservedPlanByAgent.set(agentID, planID);
    }

    if (record.result?.accepted === false) {
      rejectedDecisions += 1;
      continue;
    }
    if (!attributed) continue;
    actionsUnderCommanderPlans += 1;
    const raw = metadata.commanderFidelity;
    if (
      typeof raw !== "string" ||
      !commanderFidelityClasses.includes(raw as CommanderFidelityClass)
    ) {
      unknownDecisions += 1;
      continue;
    }
    classifiedDecisions += 1;
    counts[raw as CommanderFidelityClass] += 1;
    if (raw === "aligned_primary" || raw === "aligned_support") {
      alignedByPlan.set(planID, (alignedByPlan.get(planID) ?? 0) + 1);
    }
  }
  const numerator = counts.aligned_primary + counts.aligned_support;
  const denominator = numerator + counts.hold_plan_blocked;
  const fidelityRate = denominator === 0 ? null : numerator / denominator;
  return {
    counts,
    actionsUnderCommanderPlans,
    classifiedDecisions,
    unknownDecisions,
    rejectedDecisions,
    unattributedDecisions,
    planCount: alignedByPlan.size,
    plansWithZeroAlignedActions: [...alignedByPlan.values()].filter(
      (count) => count === 0,
    ).length,
    planTransitions,
    silentlyAbandonedPlans,
    fidelityRate,
    interpretable:
      unknownDecisions === 0 &&
      unattributedDecisions === 0 &&
      silentlyAbandonedPlans === 0 &&
      fidelityRate !== null &&
      fidelityRate >= 0.95,
  };
}
