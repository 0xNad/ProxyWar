import {
  frontierAgentSkill,
  openFrontAgentPlaybook,
  profilePlaybook,
} from "./AgentPlaybook";
import { rankLegalActionsForPrompt } from "./AgentPlannerExecutor";
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
    // Unified candidate ranking: the SAME scorer the deterministic executor uses
    // (`scoreFrontierAction` policy + strategic skill), so the LLM picks among genuinely
    // strong candidates and improvements to the executor scorer transfer to the LLM agent.
    const rankedCandidates = rankLegalActionsForPrompt({
      input: {
        observation: input.observation,
        legalActions: input.legalActions,
      },
      profile: input.observation.profile,
      limit: 12,
    }).map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      totalScore: candidate.totalScore,
      policyScore: candidate.policyScore,
      skillScore: candidate.skillScore,
      module: candidate.module,
      topSkill: candidate.topSkill,
      penalties: candidate.penalties,
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
      "RANKED_CANDIDATES_JSON is the engine's own ranking of the legal actions (policy + strategic skill). Higher totalScore is stronger; module names the strategic intent; penalties explain why an action may be stale or unsafe. Treat it as a strong prior: usually pick from the top candidates, but you may override it when theory-of-mind reasoning, alliance/betrayal timing, or opponent modeling justify a different choice — explain why in reason.",
      "OPPONENT_MODEL_JSON is your persistent belief about each rival this game (ranked by territory). Use it for theory of mind: trust is 0..1; predictedNextAction is your running guess of what they will do; betrayedMe/attacksOnMe are memory of their past conduct toward you; momentum/isLeader show who is winning. Factor it into who to ally, pressure, or betray — and when.",
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
      ...(input.observation.opponentModel &&
      input.observation.opponentModel.length > 0
        ? [
            "OPPONENT_MODEL_JSON:",
            // Compact (top rivals, ToM-decision fields, single line) to protect the
            // action-selector's JSON-adherence — verbose prompt blocks regress parse rate.
            JSON.stringify(
              input.observation.opponentModel.slice(0, 6).map((o) => ({
                id: o.playerID,
                name: o.name,
                tileShare: o.tileShare,
                trust: o.trust,
                momentum: o.momentum,
                predicted: o.predictedNextAction,
                betrayedMe: o.betrayedMe,
                attacksOnMe: o.attacksOnMe,
                allied: o.isAllied,
                leader: o.isLeader,
                relation: o.relation,
              })),
            ),
            "END_OPPONENT_MODEL_JSON",
          ]
        : []),
      "LEGAL_ACTIONS_JSON:",
      JSON.stringify(legalActions, null, 2),
      "END_LEGAL_ACTIONS_JSON",
      "RANKED_CANDIDATES_JSON:",
      JSON.stringify(rankedCandidates, null, 2),
      "END_RANKED_CANDIDATES_JSON",
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
