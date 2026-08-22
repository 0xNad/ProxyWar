import { isDeepStrictEqual } from "node:util";
import type { AgentDecisionRecord, LegalAction } from "./AgentTypes";
import {
  commanderPlanReplanReasons,
  commanderPlanTerminateReasons,
} from "./CommanderPlanLifecycle";
import {
  isEconomicBuildAction,
  isEconomicUpgradeAction,
  isLandExpansionAction,
  isNeutralBoatAction,
  isPressurePrimaryAction,
  isPressureSupportAction,
  isSurvivalPrimaryAction,
} from "./StrategicOptionCompatibility";
import {
  commanderFidelityClasses,
  type CommanderFidelityClass,
} from "./StrategicOptionExecutor";

export const COMMANDER_BLOCKED_CYCLE_THRESHOLD = 0.05;
export const COMMANDER_OPTION_NOT_EXECUTABLE_DOMINANCE_THRESHOLD = 0.5;

export interface CommanderPlanIdentity {
  optionID: string;
  family: "expand" | "develop_economy" | "pressure_rival" | "survive";
  targetPlayerID: string | null;
}

export interface CommanderFidelityRecord {
  agentID?: string;
  sequence?: number;
  legalActionIDs?: string[];
  chosenActionID?: string;
  chosenActionKind?: AgentDecisionRecord["chosenActionKind"];
  chosenActionMetadata?: AgentDecisionRecord["chosenActionMetadata"];
  intent?: AgentDecisionRecord["intent"];
  result?: {
    accepted?: boolean;
    submittedIntent?: AgentDecisionRecord["result"]["submittedIntent"];
  };
  decisionMetadata?: AgentDecisionRecord["decisionMetadata"];
}

export interface CommanderFidelitySummary {
  /** Recomputed classes. Persisted commanderFidelity stamps are assertions only. */
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
  primaryDecisionCycles: number;
  alignedPrimaryCycles: number;
  blockedDecisionCycles: number;
  blockedCycleRate: number | null;
  supportActions: number;
  offFamilyActionViolations: number;
  laterLayerActionViolations: number;
  zeroPrimaryDecisionCycles: number;
  planIdentityViolations: number;
  batchPositionViolations: number;
  fidelityStampViolations: number;
  supportPerPlanViolations: number;
  optionNotExecutableReplans: {
    count: number;
    opportunities: number;
    rate: number | null;
    dominates: boolean;
  };
  fidelityRate: number | null;
  interpretable: boolean;
}

/**
 * Pure post-decision classifier. It never treats Commander-authored fidelity
 * stamps as evidence. Plan family/target come from the stable option identity,
 * while compatibility comes from the selected offered action, both canonical
 * intents, selected-action metadata, and exact batch position.
 */
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
  let primaryDecisionCycles = 0;
  let alignedPrimaryCycles = 0;
  let blockedDecisionCycles = 0;
  let supportActions = 0;
  let offFamilyActionViolations = 0;
  let laterLayerActionViolations = 0;
  let planIdentityViolations = 0;
  let fidelityStampViolations = 0;
  const alignedByPlan = new Map<string, number>();
  const supportByPlan = new Map<string, number>();
  const identityByPlan = new Map<string, CommanderPlanIdentity>();
  const invalidPlanIDs = new Set<string>();
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
      const leftSequence =
        typeof left.record.sequence === "number" &&
        Number.isSafeInteger(left.record.sequence)
          ? left.record.sequence
          : left.inputIndex;
      const rightSequence =
        typeof right.record.sequence === "number" &&
        Number.isSafeInteger(right.record.sequence)
          ? right.record.sequence
          : right.inputIndex;
      return leftSequence - rightSequence || left.inputIndex - right.inputIndex;
    });
  const batchAudit = auditBatchPositions(ordered.map(({ record }) => record));
  const batchPositionViolations = batchAudit.violations;
  let zeroPrimaryDecisionCycles = batchAudit.orphanLaterLayers;

  for (const { record } of ordered) {
    const planID = metadataString(record, "planID");
    const identity = commanderPlanIdentity(
      metadataString(record, "planObjective"),
    );
    if (planID === null || identity === null) {
      unattributedDecisions += 1;
      if (planID !== null) invalidPlanIDs.add(planID);
      continue;
    }
    const known = identityByPlan.get(planID);
    if (known === undefined) {
      identityByPlan.set(planID, identity);
      alignedByPlan.set(planID, 0);
      supportByPlan.set(planID, 0);
    } else if (!samePlanIdentity(known, identity)) {
      invalidPlanIDs.add(planID);
      planIdentityViolations += 1;
    }

    const agentID = record.agentID ?? "__single_agent__";
    const previousObservedPlanID = lastObservedPlanByAgent.get(agentID);
    if (
      previousObservedPlanID !== undefined &&
      previousObservedPlanID !== planID
    ) {
      planTransitions += 1;
      const claimedPreviousPlanID = metadataString(
        record,
        "commanderPreviousPlanID",
      );
      const reason = metadataString(record, "commanderReplanReason");
      if (
        claimedPreviousPlanID !== previousObservedPlanID ||
        reason === null ||
        !transitionReasons.has(reason)
      ) {
        silentlyAbandonedPlans += 1;
      }
    }
    lastObservedPlanByAgent.set(agentID, planID);
  }

  for (const { record } of ordered) {
    const planID = metadataString(record, "planID");
    const identity =
      planID === null || invalidPlanIDs.has(planID)
        ? null
        : (identityByPlan.get(planID) ?? null);
    const rawBatchIndex = metadataNumber(record, "batchIndex");
    const batch = batchAudit.invalidRecords.has(record)
      ? null
      : batchEvidence(record);
    const isPrimary = rawBatchIndex === 0;
    if (isPrimary) primaryDecisionCycles += 1;

    if (record.result?.accepted === false) {
      rejectedDecisions += 1;
      if (isPrimary) {
        offFamilyActionViolations += 1;
        zeroPrimaryDecisionCycles += 1;
      } else if (rawBatchIndex !== null && rawBatchIndex > 0) {
        offFamilyActionViolations += 1;
        laterLayerActionViolations += 1;
      }
      continue;
    }
    if (planID === null || identity === null) {
      unknownDecisions += 1;
      offFamilyActionViolations += 1;
      if (isPrimary) {
        zeroPrimaryDecisionCycles += 1;
        if (record.chosenActionKind === "hold") {
          blockedDecisionCycles += 1;
        }
      } else if (rawBatchIndex !== null && rawBatchIndex > 0) {
        laterLayerActionViolations += 1;
      }
      if (metadataString(record, "commanderFidelity") !== null) {
        fidelityStampViolations += 1;
      }
      continue;
    }
    actionsUnderCommanderPlans += 1;

    const recomputed =
      batch === null
        ? null
        : recomputeCommanderFidelity(record, identity, batch.index);
    if (recomputed === null) {
      unknownDecisions += 1;
      offFamilyActionViolations += 1;
      if (isPrimary) zeroPrimaryDecisionCycles += 1;
      if (rawBatchIndex !== null && rawBatchIndex > 0) {
        laterLayerActionViolations += 1;
      }
      if (metadataString(record, "commanderFidelity") !== null) {
        fidelityStampViolations += 1;
      }
      continue;
    }

    classifiedDecisions += 1;
    counts[recomputed] += 1;
    if (metadataString(record, "commanderFidelity") !== recomputed) {
      fidelityStampViolations += 1;
    }
    if (recomputed === "aligned_primary") {
      alignedPrimaryCycles += 1;
      alignedByPlan.set(planID, (alignedByPlan.get(planID) ?? 0) + 1);
    } else if (recomputed === "aligned_support") {
      supportActions += 1;
      supportByPlan.set(planID, (supportByPlan.get(planID) ?? 0) + 1);
      alignedByPlan.set(planID, (alignedByPlan.get(planID) ?? 0) + 1);
    } else if (recomputed === "hold_plan_blocked") {
      blockedDecisionCycles += 1;
    } else if (recomputed === "hard_emergency_override") {
      if (isPrimary) zeroPrimaryDecisionCycles += 1;
    }
  }

  const nonEmergencyPrimaryCycles =
    primaryDecisionCycles - counts.hard_emergency_override;
  const fidelityRate = ratio(alignedPrimaryCycles, nonEmergencyPrimaryCycles);
  const blockedCycleRate = ratio(blockedDecisionCycles, primaryDecisionCycles);
  // Replan provenance is stamped on every row in a Commander action batch.
  // Count only the primary row so a support action cannot duplicate either
  // the numerator or denominator of the preregistered cycle-level falsifier.
  const nonBootstrapReplans = ordered
    .filter(({ record }) => metadataNumber(record, "batchIndex") === 0)
    .map(({ record }) => metadataString(record, "commanderReplanReason"))
    .filter(
      (reason) =>
        reason !== null &&
        reason !== "no_active_plan" &&
        reason !== "within_horizon",
    );
  const optionNotExecutableCount = nonBootstrapReplans.filter(
    (reason) => reason === "option_not_executable",
  ).length;
  const optionNotExecutableRate = ratio(
    optionNotExecutableCount,
    nonBootstrapReplans.length,
  );
  const supportPerPlanViolations = [...supportByPlan.values()].filter(
    (count) => count > 1,
  ).length;
  const plansWithZeroAlignedActions = [...alignedByPlan.values()].filter(
    (count) => count === 0,
  ).length;
  const optionNotExecutableDominates =
    nonBootstrapReplans.length > 0 &&
    optionNotExecutableCount / nonBootstrapReplans.length >=
      COMMANDER_OPTION_NOT_EXECUTABLE_DOMINANCE_THRESHOLD;

  return {
    counts,
    actionsUnderCommanderPlans,
    classifiedDecisions,
    unknownDecisions,
    rejectedDecisions,
    unattributedDecisions,
    planCount: alignedByPlan.size,
    plansWithZeroAlignedActions,
    planTransitions,
    silentlyAbandonedPlans,
    primaryDecisionCycles,
    alignedPrimaryCycles,
    blockedDecisionCycles,
    blockedCycleRate,
    supportActions,
    offFamilyActionViolations,
    laterLayerActionViolations,
    zeroPrimaryDecisionCycles,
    planIdentityViolations,
    batchPositionViolations,
    fidelityStampViolations,
    supportPerPlanViolations,
    optionNotExecutableReplans: {
      count: optionNotExecutableCount,
      opportunities: nonBootstrapReplans.length,
      rate: optionNotExecutableRate,
      dominates: optionNotExecutableDominates,
    },
    fidelityRate,
    interpretable:
      unknownDecisions === 0 &&
      unattributedDecisions === 0 &&
      silentlyAbandonedPlans === 0 &&
      offFamilyActionViolations === 0 &&
      laterLayerActionViolations === 0 &&
      zeroPrimaryDecisionCycles === 0 &&
      planIdentityViolations === 0 &&
      batchPositionViolations === 0 &&
      fidelityStampViolations === 0 &&
      supportPerPlanViolations === 0 &&
      counts.hard_emergency_override === 0 &&
      fidelityRate !== null &&
      fidelityRate >= 0.95 &&
      (blockedCycleRate ?? 0) <= COMMANDER_BLOCKED_CYCLE_THRESHOLD &&
      !optionNotExecutableDominates,
  };
}

function recomputeCommanderFidelity(
  record: CommanderFidelityRecord,
  identity: CommanderPlanIdentity,
  batchIndex: number,
): CommanderFidelityClass | null {
  if (
    record.chosenActionID === undefined ||
    record.chosenActionKind === undefined ||
    !record.legalActionIDs?.includes(record.chosenActionID) ||
    record.result?.accepted !== true
  ) {
    return null;
  }
  const generated = record.intent;
  const submitted = record.result.submittedIntent;
  if (!isDeepStrictEqual(generated, submitted)) return null;
  if (
    metadataString(record, "commanderEmergencyCondition") !== null ||
    metadataString(record, "commanderFidelity") === "hard_emergency_override"
  ) {
    return "hard_emergency_override";
  }
  if (batchIndex === 0) {
    if (primaryCompatible(record, identity, generated)) {
      return "aligned_primary";
    }
    if (
      identity.family !== "survive" &&
      record.chosenActionKind === "hold" &&
      generated === null
    ) {
      return "hold_plan_blocked";
    }
    return null;
  }
  if (
    metadataNumber(record, "commanderPlanAgeDecisions") === 0 &&
    supportCompatible(record, identity, generated)
  ) {
    return "aligned_support";
  }
  return null;
}

function primaryCompatible(
  record: CommanderFidelityRecord,
  identity: CommanderPlanIdentity,
  intent: AgentDecisionRecord["intent"] | undefined,
): boolean {
  if (intent === undefined) return false;
  const action = recordedAction(record, intent);
  switch (identity.family) {
    case "expand":
      return isLandExpansionAction(action) || isNeutralBoatAction(action);
    case "develop_economy":
      return isEconomicBuildAction(action) || isEconomicUpgradeAction(action);
    case "pressure_rival":
      return (
        identity.targetPlayerID !== null &&
        isPressurePrimaryAction(action, identity.targetPlayerID)
      );
    case "survive":
      return isSurvivalPrimaryAction(action);
  }
}

function supportCompatible(
  record: CommanderFidelityRecord,
  identity: CommanderPlanIdentity,
  intent: AgentDecisionRecord["intent"] | undefined,
): boolean {
  if (intent === undefined) return false;
  return (
    identity.family === "pressure_rival" &&
    identity.targetPlayerID !== null &&
    isPressureSupportAction(
      recordedAction(record, intent),
      identity.targetPlayerID,
    )
  );
}

function recordedAction(
  record: CommanderFidelityRecord,
  intent: AgentDecisionRecord["intent"],
): LegalAction {
  return {
    id: record.chosenActionID!,
    kind: record.chosenActionKind!,
    label: "persisted Commander action",
    intent,
    risk: { level: "none" },
    metadata: record.chosenActionMetadata,
  };
}

export function commanderPlanIdentity(
  optionID: string | null,
): CommanderPlanIdentity | null {
  if (optionID === "expand") {
    return { optionID, family: "expand", targetPlayerID: null };
  }
  if (optionID === "develop_economy") {
    return { optionID, family: "develop_economy", targetPlayerID: null };
  }
  if (optionID === "survive") {
    return { optionID, family: "survive", targetPlayerID: null };
  }
  const match = /^pressure_rival:([^,:\s]+)$/.exec(optionID ?? "");
  return match === null
    ? null
    : {
        optionID: optionID!,
        family: "pressure_rival",
        targetPlayerID: match[1]!,
      };
}

function samePlanIdentity(
  left: CommanderPlanIdentity,
  right: CommanderPlanIdentity,
): boolean {
  return (
    left.optionID === right.optionID &&
    left.family === right.family &&
    left.targetPlayerID === right.targetPlayerID
  );
}

function batchEvidence(
  record: CommanderFidelityRecord,
): { index: number; size: number; actionIDs: string[] } | null {
  const index = metadataNumber(record, "batchIndex");
  const size = metadataNumber(record, "batchSize");
  const actionIDs = csv(metadataString(record, "batchActionIDs"));
  if (
    index === null ||
    size === null ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(size) ||
    index < 0 ||
    size < 1 ||
    index >= size ||
    actionIDs.length !== size ||
    actionIDs[index] !== record.chosenActionID
  ) {
    return null;
  }
  return { index, size, actionIDs };
}

function auditBatchPositions(records: readonly CommanderFidelityRecord[]): {
  invalidRecords: ReadonlySet<CommanderFidelityRecord>;
  violations: number;
  orphanLaterLayers: number;
} {
  const invalidRecords = new Set<CommanderFidelityRecord>();
  const openByAgent = new Map<
    string,
    {
      planID: string | null;
      actionIDs: string[];
      size: number;
      nextIndex: number;
    }
  >();
  let violations = 0;
  let orphanLaterLayers = 0;
  for (const record of records) {
    const agentID = record.agentID ?? "__single_agent__";
    const evidence = batchEvidence(record);
    if (evidence === null) {
      invalidRecords.add(record);
      violations += 1;
      continue;
    }
    if (evidence.index === 0) {
      if (openByAgent.has(agentID)) violations += 1;
      if (evidence.size === 1) {
        openByAgent.delete(agentID);
      } else {
        openByAgent.set(agentID, {
          planID: metadataString(record, "planID"),
          actionIDs: evidence.actionIDs,
          size: evidence.size,
          nextIndex: 1,
        });
      }
      continue;
    }
    const open = openByAgent.get(agentID);
    if (
      open === undefined ||
      evidence.index !== open.nextIndex ||
      evidence.size !== open.size ||
      metadataString(record, "planID") !== open.planID ||
      !sameStrings(evidence.actionIDs, open.actionIDs)
    ) {
      invalidRecords.add(record);
      violations += 1;
      orphanLaterLayers += 1;
      continue;
    }
    open.nextIndex += 1;
    if (open.nextIndex === open.size) openByAgent.delete(agentID);
  }
  violations += openByAgent.size;
  return { invalidRecords, violations, orphanLaterLayers };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function metadataString(
  record: CommanderFidelityRecord,
  key: string,
): string | null {
  const value = record.decisionMetadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataNumber(
  record: CommanderFidelityRecord,
  key: string,
): number | null {
  const value = record.decisionMetadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function csv(value: string | null): string[] {
  return value === null
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
