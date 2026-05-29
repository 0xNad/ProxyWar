import {
  AgentObjectiveKind,
  AgentObjectiveProgress,
  AgentObjectiveState,
  AgentObservation,
  AgentStrategyProfile,
  LegalAction,
  LegalActionKind,
  RecentAgentDecision,
} from "./AgentTypes";

export interface BuildAgentObjectiveInput {
  agentID: string;
  profile: AgentStrategyProfile;
  observation: AgentObservation;
  legalActions: LegalAction[];
  turnNumber: number;
}

export class AgentObjectiveManager {
  private readonly objectives = new Map<string, AgentObjectiveState>();

  currentObjective(agentID: string): AgentObjectiveState | null {
    return this.objectives.get(agentID) ?? null;
  }

  objectiveFor(input: BuildAgentObjectiveInput): AgentObjectiveState {
    const current = this.objectives.get(input.agentID);
    const kind = shouldKeepObjective(current, input)
      ? current.kind
      : chooseObjectiveKind(input);
    const objective = buildObjective(input, current, kind);
    this.objectives.set(input.agentID, objective);
    return objective;
  }
}

export function actionAlignsWithObjective(
  objective: AgentObjectiveState | null | undefined,
  action: LegalAction | null | undefined,
): boolean {
  if (!objective || !action) {
    return false;
  }

  switch (objective.kind) {
    case "choose_spawn":
      return action.kind === "spawn";
    case "expand_territory":
      return (
        (action.kind === "attack" && action.metadata?.expansion === true) ||
        (action.kind === "boat" && action.metadata?.targetID === null)
      );
    case "secure_economy":
      return (
        ((action.kind === "build" || action.kind === "upgrade_structure") &&
          (action.metadata?.role === "economic" ||
            action.metadata?.unit === "City" ||
            action.metadata?.unit === "Factory" ||
            action.metadata?.unit === "Port")) ||
        (action.kind === "build" && action.metadata?.unit === "MissileSilo")
      );
    case "fortify_border":
      return (
        action.kind === "retreat" ||
        action.kind === "boat_retreat" ||
        action.kind === "warship" ||
        action.kind === "move_warship" ||
        ((action.kind === "build" || action.kind === "upgrade_structure") &&
          action.metadata?.role === "defensive") ||
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend"
      );
    case "pressure_rival":
      return (
        action.kind === "embargo" ||
        action.kind === "embargo_all" ||
        action.kind === "target_player" ||
        action.kind === "nuke" ||
        action.kind === "warship" ||
        action.kind === "move_warship" ||
        action.kind === "break_alliance" ||
        (action.kind === "attack" && action.metadata?.expansion !== true)
      );
    case "build_alliance":
      return (
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "donate_gold" ||
        action.kind === "donate_troops" ||
        action.kind === "embargo_stop" ||
        action.kind === "quick_chat" ||
        action.kind === "emoji"
      );
    case "survive":
      return (
        action.kind === "hold" ||
        action.kind === "retreat" ||
        action.kind === "boat_retreat" ||
        action.kind === "warship" ||
        action.kind === "move_warship" ||
        ((action.kind === "build" || action.kind === "upgrade_structure") &&
          action.metadata?.role === "defensive") ||
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "embargo_stop"
      );
  }
}

export function recentDecisionAlignsWithObjective(
  kind: AgentObjectiveKind,
  decision: RecentAgentDecision,
): boolean {
  switch (kind) {
    case "choose_spawn":
      return decision.actionKind === "spawn";
    case "expand_territory":
      return (
        (decision.actionKind === "attack" && decision.expansion === true) ||
        decision.actionKind === "boat"
      );
    case "secure_economy":
      return (
        decision.actionKind === "build" ||
        decision.actionKind === "upgrade_structure"
      );
    case "fortify_border":
      return (
        decision.actionKind === "retreat" ||
        decision.actionKind === "boat_retreat" ||
        decision.actionKind === "build" ||
        decision.actionKind === "warship" ||
        decision.actionKind === "move_warship" ||
        decision.actionKind === "upgrade_structure" ||
        decision.actionKind === "alliance_request" ||
        decision.actionKind === "alliance_extend"
      );
    case "pressure_rival":
      return (
        decision.actionKind === "embargo" ||
        decision.actionKind === "embargo_all" ||
        decision.actionKind === "target_player" ||
        decision.actionKind === "nuke" ||
        decision.actionKind === "warship" ||
        decision.actionKind === "move_warship" ||
        decision.actionKind === "break_alliance" ||
        (decision.actionKind === "attack" && decision.expansion !== true)
      );
    case "build_alliance":
      return (
        decision.actionKind === "alliance_request" ||
        decision.actionKind === "alliance_extend" ||
        decision.actionKind === "donate_gold" ||
        decision.actionKind === "donate_troops" ||
        decision.actionKind === "embargo_stop" ||
        decision.actionKind === "quick_chat" ||
        decision.actionKind === "emoji"
      );
    case "survive":
      return (
        decision.actionKind === "hold" ||
        decision.actionKind === "retreat" ||
        decision.actionKind === "boat_retreat" ||
        decision.actionKind === "build" ||
        decision.actionKind === "warship" ||
        decision.actionKind === "move_warship" ||
        decision.actionKind === "upgrade_structure" ||
        decision.actionKind === "alliance_request" ||
        decision.actionKind === "alliance_extend" ||
        decision.actionKind === "embargo_stop"
      );
  }
}

function buildObjective(
  input: BuildAgentObjectiveInput,
  current: AgentObjectiveState | undefined,
  kind: AgentObjectiveKind,
): AgentObjectiveState {
  const target = objectiveTarget(kind, input);
  const progress = objectiveProgress(kind, input.observation.recentDecisions);
  const preferredActionKinds = preferredKindsForObjective(kind);
  const alignedLegalActions = input.legalActions.filter((action) =>
    actionAlignsWithObjective(
      { kind, preferredActionKinds } as AgentObjectiveState,
      action,
    ),
  );
  const status =
    progress.consecutiveAlignedDecisionCount >= 3
      ? "completed"
      : alignedLegalActions.length === 0
        ? "blocked"
        : "active";
  const notes = objectiveNotes({
    kind,
    current,
    alignedLegalActions,
    input,
  });
  const label = labelForObjective(kind);

  return {
    objectiveID:
      current?.kind === kind ? current.objectiveID : `${input.agentID}:${kind}`,
    kind,
    label,
    status,
    createdTurn: current?.kind === kind ? current.createdTurn : input.turnNumber,
    updatedTurn: input.turnNumber,
    preferredActionKinds,
    ...(target?.playerID !== undefined
      ? { targetPlayerID: target.playerID }
      : {}),
    ...(target?.playerName !== undefined
      ? { targetPlayerName: target.playerName }
      : {}),
    progress,
    summary: objectiveSummary({
      label,
      status,
      progress,
      alignedLegalActionCount: alignedLegalActions.length,
      targetName: target?.playerName,
    }),
    notes,
  };
}

function shouldKeepObjective(
  current: AgentObjectiveState | undefined,
  input: BuildAgentObjectiveInput,
): current is AgentObjectiveState {
  if (current === undefined) {
    return false;
  }
  if (input.observation.phase === "spawn") {
    return current.kind === "choose_spawn";
  }
  if (current.kind === "choose_spawn") {
    return false;
  }
  if (current.status === "completed") {
    return false;
  }
  const communication = strongestCommunicationSignal(input);
  if (
    communication?.intent === "coordinate_attack" &&
    communication.targetID !== undefined &&
    communication.targetID !== null &&
    current.targetPlayerID !== communication.targetID &&
    hasPressureActionAgainst(input.legalActions, communication.targetID)
  ) {
    return false;
  }
  if (
    current.kind === "expand_territory" &&
    input.observation.memory.recentExpansionCount >= 2 &&
    input.legalActions.some(
      (action) =>
        action.kind === "build" ||
        action.kind === "embargo" ||
        action.kind === "alliance_request",
    )
  ) {
    return false;
  }

  return input.legalActions.some((action) =>
    actionAlignsWithObjective(current, action),
  );
}

function chooseObjectiveKind(input: BuildAgentObjectiveInput): AgentObjectiveKind {
  const actions = actionSearch(input.legalActions);
  if (input.observation.phase === "spawn") {
    return "choose_spawn";
  }
  const communication = strongestCommunicationSignal(input);
  if (
    communication?.intent === "coordinate_attack" &&
    communication.targetID !== undefined &&
    communication.targetID !== null &&
    hasPressureActionAgainst(input.legalActions, communication.targetID)
  ) {
    return "pressure_rival";
  }
  if (
    (communication?.intent === "request_support" ||
      communication?.intent === "propose_alliance") &&
    communication.senderPlayerID !== undefined &&
    communication.senderPlayerID !== null &&
    hasAllianceOrSupportActionFor(input.legalActions, communication.senderPlayerID)
  ) {
    return "build_alliance";
  }

  if (
    input.observation.memory.recentExpansionCount >= 2 &&
    (actions.economicBuild || actions.defensiveBuild)
  ) {
    return actions.defensiveBuild && input.profile === "defensive"
      ? "fortify_border"
      : "secure_economy";
  }

  switch (input.profile) {
    case "defensive":
      if (actions.defensiveBuild || input.observation.combat.borderedPlayerIDs.length > 0) {
        return "fortify_border";
      }
      if (actions.economicBuild) {
        return "secure_economy";
      }
      if (actions.alliance) {
        return "build_alliance";
      }
      if (actions.expansionAttack) {
        return "expand_territory";
      }
      return "survive";
    case "diplomatic":
      if (actions.alliance || actions.support) {
        return "build_alliance";
      }
      if (actions.economicBuild) {
        return "secure_economy";
      }
      if (actions.defensiveBuild) {
        return "fortify_border";
      }
      if (actions.expansionAttack) {
        return "expand_territory";
      }
      return "survive";
    case "aggressive":
      if (actions.playerAttack) {
        return "pressure_rival";
      }
      if (actions.expansionAttack) {
        return "expand_territory";
      }
      if (actions.economicBuild || actions.defensiveBuild) {
        return "secure_economy";
      }
      if (actions.embargo) {
        return "pressure_rival";
      }
      return "survive";
    case "opportunistic":
      if (actions.lowRiskPlayerAttack) {
        return "pressure_rival";
      }
      if (actions.economicBuild || actions.defensiveBuild) {
        return "secure_economy";
      }
      if (actions.expansionAttack) {
        return "expand_territory";
      }
      if (actions.embargo) {
        return "pressure_rival";
      }
      if (actions.alliance) {
        return "build_alliance";
      }
      return "survive";
  }
}

function actionSearch(legalActions: LegalAction[]) {
  const playerAttacks = legalActions.filter(
    (action) => action.kind === "attack" && action.metadata?.expansion !== true,
  );
  const expansionAttacks = legalActions.filter(
    (action) =>
      (action.kind === "attack" && action.metadata?.expansion === true) ||
      (action.kind === "boat" && action.metadata?.targetID === null),
  );
  const builds = legalActions.filter(
    (action) => action.kind === "build" || action.kind === "upgrade_structure",
  );

  return {
    playerAttack: playerAttacks.length > 0,
    lowRiskPlayerAttack: playerAttacks.some(
      (action) => action.risk.level === "low",
    ),
    expansionAttack: expansionAttacks.length > 0,
    economicBuild: builds.some(
      (action) =>
        action.metadata?.role === "economic" ||
        action.metadata?.unit === "City" ||
        action.metadata?.unit === "Factory",
    ),
    defensiveBuild: builds.some(
      (action) => action.metadata?.role === "defensive",
    ),
    alliance: legalActions.some(
      (action) =>
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend",
    ),
    support: legalActions.some(
      (action) =>
        action.kind === "donate_gold" || action.kind === "donate_troops",
    ),
    embargo: legalActions.some(
      (action) =>
        action.kind === "embargo" ||
        action.kind === "embargo_all" ||
        action.kind === "target_player",
    ),
  };
}

function objectiveProgress(
  kind: AgentObjectiveKind,
  recentDecisions: RecentAgentDecision[],
): AgentObjectiveProgress {
  const accepted = recentDecisions.filter((decision) => decision.accepted);
  const aligned = accepted.filter((decision) =>
    recentDecisionAlignsWithObjective(kind, decision),
  );
  let consecutiveAlignedDecisionCount = 0;
  for (let index = accepted.length - 1; index >= 0; index -= 1) {
    if (!recentDecisionAlignsWithObjective(kind, accepted[index])) {
      break;
    }
    consecutiveAlignedDecisionCount += 1;
  }

  return {
    recentDecisionCount: accepted.length,
    alignedRecentDecisionCount: aligned.length,
    consecutiveAlignedDecisionCount,
  };
}

function objectiveTarget(
  kind: AgentObjectiveKind,
  input: BuildAgentObjectiveInput,
): { playerID: string | null; playerName?: string } | null {
  if (kind === "pressure_rival") {
    const communication = strongestCommunicationSignal(input);
    if (
      communication?.intent === "coordinate_attack" &&
      communication.targetID !== undefined &&
      communication.targetID !== null &&
      hasPressureActionAgainst(input.legalActions, communication.targetID)
    ) {
      return {
        playerID: communication.targetID,
        ...(communication.targetName !== null &&
        communication.targetName !== undefined
          ? { playerName: communication.targetName }
          : {}),
      };
    }
    const action =
      input.legalActions.find(
        (candidate) =>
          candidate.kind === "attack" && candidate.metadata?.expansion !== true,
      ) ??
      input.legalActions.find(
        (candidate) =>
          candidate.kind === "embargo" ||
          candidate.kind === "target_player" ||
          candidate.kind === "nuke",
      );
    return targetFromAction(action);
  }

  if (kind === "build_alliance") {
    const action = input.legalActions.find(
      (candidate) =>
        candidate.kind === "alliance_request" ||
        candidate.kind === "alliance_extend" ||
        candidate.kind === "donate_gold" ||
        candidate.kind === "donate_troops" ||
        candidate.kind === "quick_chat",
    );
    return targetFromAction(action);
  }

  return null;
}

function strongestCommunicationSignal(input: BuildAgentObjectiveInput) {
  const ownPlayerID = input.observation.ownState?.playerID ?? null;
  return [...(input.observation.recentCommunications ?? [])]
    .reverse()
    .find((signal) => {
      if (
        signal.intent !== "coordinate_attack" &&
        signal.intent !== "request_support" &&
        signal.intent !== "propose_alliance"
      ) {
        return false;
      }
      return signal.targetID !== ownPlayerID;
    });
}

function hasPressureActionAgainst(
  legalActions: LegalAction[],
  playerID: string,
): boolean {
  return legalActions.some(
    (action) =>
      (action.kind === "attack" ||
        action.kind === "target_player" ||
        action.kind === "embargo") &&
      (action.metadata?.targetID === playerID ||
        action.metadata?.recipientID === playerID),
  );
}

function hasAllianceOrSupportActionFor(
  legalActions: LegalAction[],
  playerID: string,
): boolean {
  return legalActions.some(
    (action) =>
      (action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "donate_gold" ||
        action.kind === "donate_troops" ||
        action.kind === "quick_chat" ||
        action.kind === "emoji") &&
      (action.metadata?.targetID === playerID ||
        action.metadata?.recipientID === playerID),
  );
}

function targetFromAction(
  action: LegalAction | undefined,
): { playerID: string | null; playerName?: string } | null {
  if (action === undefined) {
    return null;
  }
  const metadata = action.metadata ?? {};
  const playerID = metadata.targetID ?? metadata.recipientID;
  const playerName = metadata.targetName ?? metadata.recipientName;
  if (typeof playerID !== "string" && playerID !== null) {
    return null;
  }
  return {
    playerID,
    ...(typeof playerName === "string" ? { playerName } : {}),
  };
}

function preferredKindsForObjective(
  kind: AgentObjectiveKind,
): LegalActionKind[] {
  switch (kind) {
    case "choose_spawn":
      return ["spawn", "hold"];
    case "expand_territory":
      return ["attack", "boat", "build", "upgrade_structure", "hold"];
    case "secure_economy":
      return ["build", "upgrade_structure", "attack", "boat", "hold"];
    case "fortify_border":
      return [
        "retreat",
        "boat_retreat",
        "build",
        "warship",
        "move_warship",
        "upgrade_structure",
        "alliance_request",
        "alliance_extend",
        "attack",
        "hold",
      ];
    case "pressure_rival":
      return [
        "attack",
        "embargo",
        "embargo_all",
        "target_player",
        "nuke",
        "warship",
        "move_warship",
        "break_alliance",
        "build",
        "hold",
      ];
    case "build_alliance":
      return [
        "alliance_request",
        "alliance_extend",
        "donate_troops",
        "donate_gold",
        "embargo_stop",
        "quick_chat",
        "emoji",
        "build",
        "hold",
      ];
    case "survive":
      return [
        "retreat",
        "boat_retreat",
        "build",
        "warship",
        "move_warship",
        "upgrade_structure",
        "alliance_request",
        "alliance_extend",
        "embargo_stop",
        "hold",
      ];
  }
}

function labelForObjective(kind: AgentObjectiveKind): string {
  switch (kind) {
    case "choose_spawn":
      return "Choose a strong opening position";
    case "expand_territory":
      return "Expand territory";
    case "secure_economy":
      return "Secure economy";
    case "fortify_border":
      return "Fortify border";
    case "pressure_rival":
      return "Pressure nearest rival";
    case "build_alliance":
      return "Build alliance network";
    case "survive":
      return "Survive safely";
  }
}

function objectiveNotes(input: {
  kind: AgentObjectiveKind;
  current: AgentObjectiveState | undefined;
  alignedLegalActions: LegalAction[];
  input: BuildAgentObjectiveInput;
}): string[] {
  const notes = [
    "objective chosen outside core from profile, memory, observation, and legal actions",
  ];
  if (input.current !== undefined && input.current.kind !== input.kind) {
    notes.push(`objective changed from ${input.current.kind}`);
  }
  if (input.alignedLegalActions.length === 0) {
    notes.push("no currently offered LegalAction directly advances this objective");
  } else {
    notes.push(
      `aligned legal actions: ${input.alignedLegalActions
        .map((action) => action.id)
        .slice(0, 4)
        .join(", ")}`,
    );
  }
  if (input.input.observation.memory.recentExpansionCount >= 2) {
    notes.push("recent expansion streak detected; economy or defense may be preferred");
  }
  return notes;
}

function objectiveSummary(input: {
  label: string;
  status: AgentObjectiveState["status"];
  progress: AgentObjectiveProgress;
  alignedLegalActionCount: number;
  targetName?: string;
}): string {
  const parts = [
    `${input.label} (${input.status})`,
    `recentAligned=${input.progress.alignedRecentDecisionCount}/${input.progress.recentDecisionCount}`,
    `consecutive=${input.progress.consecutiveAlignedDecisionCount}`,
    `legalAligned=${input.alignedLegalActionCount}`,
  ];
  if (input.targetName !== undefined) {
    parts.push(`target=${input.targetName}`);
  }
  return parts.join("; ");
}
