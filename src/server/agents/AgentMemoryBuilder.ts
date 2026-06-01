import {
  AgentMemory,
  LegalActionKind,
  RecentAgentDecision,
} from "./AgentTypes";

export interface BuildAgentMemoryInput {
  recentDecisions?: RecentAgentDecision[];
  maxRecentActions?: number;
}

export class AgentMemoryBuilder {
  build(input: BuildAgentMemoryInput = {}): AgentMemory {
    const allRecentActions = input.recentDecisions ?? [];
    const recentActions = allRecentActions.slice(-(input.maxRecentActions ?? 8));
    const accepted = recentActions.filter((decision) => decision.accepted);
    const acceptedForMemory = allRecentActions.filter((decision) => decision.accepted);
    const recentActionCountsByKind =
      accepted.reduce<Partial<Record<LegalActionKind, number>>>(
        (counts, decision) => {
          counts[decision.actionKind] =
            (counts[decision.actionKind] ?? 0) + 1;
          return counts;
        },
        {},
      );
    const recentNonHold = accepted.filter(
      (decision) =>
        decision.actionKind !== "hold" && decision.actionKind !== "spawn",
    );
    const recentHoldCount = trailingHoldCount(acceptedForMemory);
    const turnsSinceLastProductiveAction = countSinceLastProductiveAction(
      acceptedForMemory,
    );
    const repeated = repeatedAction(recentNonHold);
    const recentExpansionCount = recentNonHold.filter(
      (decision) => decision.actionKind === "attack" && decision.expansion,
    ).length;
    const recentBuildCount = recentNonHold.filter(
      (decision) => decision.actionKind === "build",
    ).length;
    const notes = memoryNotes({
      recentExpansionCount,
      repeatedActionKind: repeated.kind,
      repeatedActionCount: repeated.count,
      recentBuildCount,
      recentHoldCount,
    });

    return {
      recentActions,
      recentActionCountsByKind,
      recentNonHoldCount: recentNonHold.length,
      recentExpansionCount,
      recentBuildCount,
      recentHoldCount,
      turnsSinceLastProductiveAction,
      repeatedActionKind: repeated.kind,
      repeatedActionCount: repeated.count,
      avoidActionIDs: repeated.count >= 2 ? repeated.actionIDs : [],
      summary: memorySummary({
        recentActions,
        repeatedActionKind: repeated.kind,
        repeatedActionCount: repeated.count,
        recentExpansionCount,
        recentBuildCount,
        recentHoldCount,
      }),
      notes,
    };
  }
}

function repeatedAction(decisions: RecentAgentDecision[]): {
  kind: LegalActionKind | null;
  count: number;
  actionIDs: string[];
} {
  const last = decisions[decisions.length - 1];
  if (last === undefined) {
    return { kind: null, count: 0, actionIDs: [] };
  }

  const actionIDs: string[] = [];
  let count = 0;
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index];
    if (decision?.actionKind !== last.actionKind) {
      break;
    }
    count += 1;
    actionIDs.push(decision.actionID);
  }

  return {
    kind: last.actionKind,
    count,
    actionIDs,
  };
}

function trailingHoldCount(decisions: RecentAgentDecision[]): number {
  let count = 0;
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    if (decisions[index]?.actionKind !== "hold") {
      break;
    }
    count += 1;
  }
  return count;
}

function countSinceLastProductiveAction(decisions: RecentAgentDecision[]): number {
  let count = 0;
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const kind = decisions[index]?.actionKind;
    if (kind !== "hold" && kind !== "spawn") {
      break;
    }
    count += 1;
  }
  return count;
}

function memoryNotes(input: {
  recentExpansionCount: number;
  repeatedActionKind: LegalActionKind | null;
  repeatedActionCount: number;
  recentBuildCount: number;
  recentHoldCount: number;
}): string[] {
  const notes: string[] = [];
  if (input.recentExpansionCount >= 2) {
    notes.push(
      "recent expansion repeated; consider build, defense, or pressure if legal",
    );
  }
  if (input.repeatedActionKind !== null && input.repeatedActionCount >= 2) {
    notes.push(
      `last ${input.repeatedActionCount} non-hold decisions were ${input.repeatedActionKind}`,
    );
  }
  if (input.recentBuildCount > 0) {
    notes.push("recent build action exists; avoid duplicating structures blindly");
  }
  if (input.recentHoldCount >= 2) {
    notes.push("recent hold streak; refresh plan if useful actions are legal");
  }
  return notes;
}

function memorySummary(input: {
  recentActions: RecentAgentDecision[];
  repeatedActionKind: LegalActionKind | null;
  repeatedActionCount: number;
  recentExpansionCount: number;
  recentBuildCount: number;
  recentHoldCount: number;
}): string {
  if (input.recentActions.length === 0) {
    return "no recent agent decisions";
  }
  return [
    `recent=${input.recentActions
      .map((decision) => decision.actionKind)
      .join(",")}`,
    `expansions=${input.recentExpansionCount}`,
    `builds=${input.recentBuildCount}`,
    `holds=${input.recentHoldCount}`,
    input.repeatedActionKind === null
      ? "repeat=none"
      : `repeat=${input.repeatedActionKind}x${input.repeatedActionCount}`,
  ].join("; ");
}
