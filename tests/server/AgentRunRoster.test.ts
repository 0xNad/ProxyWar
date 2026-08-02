import { buildAttachedAgentRunRoster } from "../../src/server/agents/AgentRunRoster";

describe("attached agent run roster", () => {
  it("binds the client IDs assigned by successful game attachment", () => {
    const roster = buildAttachedAgentRunRoster([
      participant("vanguard", "Premiere Vanguard", "aggressive", "SEAT0001"),
      participant("diplomat", "Premiere Diplomat", "diplomatic", "SEAT0002"),
    ]);

    expect(roster.map((entry) => entry.clientID)).toEqual([
      "SEAT0001",
      "SEAT0002",
    ]);
    expect(roster.map((entry) => entry.username)).toEqual([
      "Premiere Vanguard",
      "Premiere Diplomat",
    ]);
  });

  it("fails closed when roster capture happens before attachment", () => {
    expect(() =>
      buildAttachedAgentRunRoster([
        participant("vanguard", "Premiere Vanguard", "aggressive", null),
      ]),
    ).toThrow("agent run roster requires an attached participant");
  });
});

function participant(
  agentID: string,
  username: string,
  profile: "aggressive" | "diplomatic",
  clientID: string | null,
) {
  return {
    runner: {
      agentID,
      clientID: () => clientID,
    },
    spec: {
      username,
      profile,
    },
    brain: {
      brainType: "rule" as const,
    },
  };
}
