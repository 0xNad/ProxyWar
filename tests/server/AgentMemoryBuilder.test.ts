import { describe, expect, it } from "vitest";
import { AgentMemoryBuilder } from "../../src/server/agents/AgentMemoryBuilder";
import {
  type LegalActionKind,
  type RecentAgentDecision,
} from "../../src/server/agents/AgentTypes";

let seq = 0;
function decision(
  actionID: string,
  actionKind: LegalActionKind,
  accepted = true,
): RecentAgentDecision {
  seq += 1;
  return { sequence: seq, actionID, actionKind, reason: "test", accepted };
}

describe("AgentMemoryBuilder avoidActionIDs (exact-repeat brake)", () => {
  const builder = new AgentMemoryBuilder();

  it("brakes an exact action repeated NON-consecutively (interleaved with a different non-hold kind)", () => {
    // This is the boxed-in social-spam pattern the old consecutive-streak
    // check missed: emoji:A is interleaved with quick_chat:B, so the streak
    // breaks and emoji:A never used to land in avoidActionIDs.
    const memory = builder.build({
      recentDecisions: [
        decision("emoji:A", "emoji"),
        decision("quick_chat:B", "quick_chat"),
        decision("emoji:A", "emoji"),
      ],
    });
    expect(memory.avoidActionIDs).toContain("emoji:A");
    expect(memory.avoidActionIDs).not.toContain("quick_chat:B");
  });

  it("brakes an exact action repeated across an interleaved hold", () => {
    const memory = builder.build({
      recentDecisions: [
        decision("emoji:A", "emoji"),
        decision("hold", "hold"),
        decision("emoji:A", "emoji"),
      ],
    });
    expect(memory.avoidActionIDs).toContain("emoji:A");
  });

  it("does NOT brake repeated holds (holding while genuinely stuck is allowed)", () => {
    const memory = builder.build({
      recentDecisions: [
        decision("hold", "hold"),
        decision("hold", "hold"),
        decision("hold", "hold"),
      ],
    });
    expect(memory.avoidActionIDs).toEqual([]);
  });

  it("does NOT brake distinct actions used once each", () => {
    const memory = builder.build({
      recentDecisions: [
        decision("emoji:A", "emoji"),
        decision("emoji:B", "emoji"),
        decision("quick_chat:C", "quick_chat"),
      ],
    });
    expect(memory.avoidActionIDs).toEqual([]);
  });

  it("ignores rejected decisions when counting repeats", () => {
    const memory = builder.build({
      recentDecisions: [
        decision("emoji:A", "emoji", true),
        decision("emoji:A", "emoji", false),
      ],
    });
    expect(memory.avoidActionIDs).not.toContain("emoji:A");
  });

  it("still brakes a consecutive same-kind streak (existing behavior preserved)", () => {
    const memory = builder.build({
      recentDecisions: [
        decision("attack:A", "attack"),
        decision("attack:B", "attack"),
      ],
    });
    expect(memory.avoidActionIDs).toContain("attack:A");
    expect(memory.avoidActionIDs).toContain("attack:B");
  });
});
