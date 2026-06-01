import {
  frontierAgentSkill,
  openFrontAgentPlaybook,
  profilePlaybook,
} from "./AgentPlaybook";
import { StrategicSkillEvaluator } from "./AgentStrategicSkills";
import { AgentObservation, LegalAction } from "./AgentTypes";

export interface BuildLlmPromptInput {
  observation: AgentObservation;
  legalActions: LegalAction[];
  personality?: string;
}

export class LlmPromptBuilder {
  build(input: BuildLlmPromptInput): string {
    const observation = this.observationView(input.observation);
    const legalActions = input.legalActions.map((action) => ({
      id: action.id,
      kind: action.kind,
      label: action.label,
      risk: action.risk,
      metadata: action.metadata ?? {},
    }));
    const skillEvaluation = new StrategicSkillEvaluator().evaluate({
      observation: input.observation,
      legalActions: input.legalActions,
    });
    const strategicSkills = skillEvaluation.actions
      .slice(0, 10)
      .map((action) => ({
        id: action.actionID,
        kind: action.actionKind,
        totalScore: action.totalScore,
        topSkill: action.topSkill,
        topSkillScore: action.topSkillScore,
        penalties: action.penalties,
        planAligned: action.planAligned,
        objectiveAligned: action.objectiveAligned,
      }));

    return [
      "You are an AI Nations League agent brain.",
      "Choose exactly one action by selecting a listed LegalAction.id.",
      "You must not invent actions, describe new actions, or output raw game intents.",
      "Do not write code, TypeScript, shell commands, tool calls, or analysis outside the JSON object.",
      "You are deciding a game move, not programming the game.",
      "Prefer useful non-hold actions when their risk and metadata look reasonable.",
      "Use hold only when it is the only legal action or every non-hold action is clearly harmful.",
      "If memory shows repeated neutral expansion, prefer a high-scoring economy, diplomacy, or real pressure action over another neutral expansion unless expansion is clearly the only useful option.",
      "Use STRATEGIC_SKILL_SCORES_JSON as compact guidance; higher totalScore is usually better, and penalties explain why an action may be stale or unsafe.",
      "OPENFRONT_PLAYBOOK:",
      openFrontAgentPlaybook,
      profilePlaybook(input.observation.profile),
      "END_OPENFRONT_PLAYBOOK",
      "FRONTIER_AGENT_SKILL:",
      frontierAgentSkill,
      "END_FRONTIER_AGENT_SKILL",
      profileGuidance(input.observation.profile),
      "Return JSON only, with no prose outside the JSON object.",
      'Required shape: {"selectedLegalActionId":"<one listed id>","reason":"short reason","confidence":0.0}',
      "confidence is optional and must be a number from 0 to 1 if present.",
      input.personality ? `Agent personality: ${input.personality}` : null,
      `Agent profile: ${input.observation.profile}`,
      "OBSERVATION_JSON:",
      JSON.stringify(observation, null, 2),
      "END_OBSERVATION_JSON",
      "LEGAL_ACTIONS_JSON:",
      JSON.stringify(legalActions, null, 2),
      "END_LEGAL_ACTIONS_JSON",
      "STRATEGIC_SKILL_SCORES_JSON:",
      JSON.stringify(strategicSkills, null, 2),
      "END_STRATEGIC_SKILL_SCORES_JSON",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private observationView(observation: AgentObservation) {
    return {
      agentID: observation.agentID,
      username: observation.username,
      profile: observation.profile,
      gameID: observation.gameID,
      phase: observation.phase,
      turnNumber: observation.turnNumber,
      tick: observation.tick,
      ownState: observation.ownState,
      visiblePlayers: observation.visiblePlayers.map((player) => ({
        playerID: player.playerID,
        name: player.name,
        isAlive: player.isAlive,
        isDisconnected: player.isDisconnected,
        troops: player.troops,
        maxTroops: player.maxTroops,
        troopRatio: player.troopRatio,
        tilesOwned: player.tilesOwned,
        tileShare: player.tileShare,
        sharesBorder: player.sharesBorder,
        isAllied: player.isAllied,
        isFriendly: player.isFriendly,
        relation: player.relation,
        canAttack: player.canAttack,
        attackLegalReason: player.attackLegalReason,
        attackBlocker: player.attackBlocker,
        canRequestAlliance: player.canRequestAlliance,
        canDonateGold: player.canDonateGold,
        canDonateTroops: player.canDonateTroops,
        canEmbargo: player.canEmbargo,
        canStopEmbargo: player.canStopEmbargo,
        canTarget: player.canTarget,
        canBreakAlliance: player.canBreakAlliance,
        canExtendAlliance: player.canExtendAlliance,
        canRejectAlliance: player.canRejectAlliance,
        hasEmbargoAgainst: player.hasEmbargoAgainst,
        hasOutgoingAllianceRequest: player.hasOutgoingAllianceRequest,
        hasIncomingAllianceRequest: player.hasIncomingAllianceRequest,
        allianceExpiresAt: player.allianceExpiresAt,
        allianceInExtensionWindow: player.allianceInExtensionWindow,
        relativeTroopRatio: player.relativeTroopRatio,
      })),
      combat: observation.combat,
      nonCombat: observation.nonCombat,
      strategic: observation.strategic,
      memory: observation.memory,
      tacticalAffordances: observation.tacticalAffordances,
      objective: observation.objective,
      endgame: observation.endgame,
      recentDecisions: observation.recentDecisions,
      notes: observation.notes,
    };
  }
}

function profileGuidance(profile: AgentObservation["profile"]): string {
  switch (profile) {
    case "aggressive":
      return "Profile guidance: aggressive agents prefer attack when legal, then embargo pressure, then build pressure, then alliance, then hold.";
    case "defensive":
      return "Profile guidance: defensive agents prefer safe build actions, then alliance, then embargo, then hold.";
    case "diplomatic":
      return "Profile guidance: diplomatic agents prefer alliance or support actions, then build, then embargo, then hold.";
    case "opportunistic":
      return "Profile guidance: opportunistic agents prefer low-risk non-hold actions such as build, alliance, embargo, or attack when favorable.";
  }
}
