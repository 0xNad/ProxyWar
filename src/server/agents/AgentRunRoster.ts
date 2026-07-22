import type { AgentRunRosterEntry } from "./AgentDecisionLogWriter";
import type { AgentBrainType, AgentStrategyProfile } from "./AgentTypes";

interface AttachedAgentRosterParticipant {
  runner: {
    agentID: string;
    clientID(): string | null;
  };
  spec: {
    username: string;
    profile: AgentStrategyProfile;
  };
  brain: {
    brainType?: AgentBrainType;
  };
}

export function buildAttachedAgentRunRoster(
  participants: readonly AttachedAgentRosterParticipant[],
): AgentRunRosterEntry[] {
  return participants.map((participant) => {
    const clientID = participant.runner.clientID();
    if (clientID === null) {
      throw new Error("agent run roster requires an attached participant");
    }
    return {
      agentID: participant.runner.agentID,
      username: participant.spec.username,
      profile: participant.spec.profile,
      clientID,
      brainType: participant.brain.brainType ?? "rule",
    };
  });
}
