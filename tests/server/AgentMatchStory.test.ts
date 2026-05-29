import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildAgentMatchStory,
  writeAgentMatchStoryArtifacts,
} from "../../src/server/agents/AgentMatchStory";
import { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";

describe("AgentMatchStory", () => {
  it("scores varied matches as more watchable", () => {
    const story = buildAgentMatchStory({
      runID: "story-run",
      matchID: "STORY",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record(1, "spawn:100", "spawn", 0),
        record(2, "expand:terra-nullius:10", "attack", 10, {
          expansion: true,
        }),
        record(3, "build:City:123", "build", 20, { unit: "City" }),
        record(4, "alliance:ALLY", "alliance_request", 30, {
          recipientName: "Ally Nation",
        }),
        record(5, "attack:RIVAL:10", "attack", 40, {
          targetName: "Rival Nation",
        }),
      ],
    });

    expect(story.entertainmentScore).toBeGreaterThan(60);
    expect(story.actionDiversityCount).toBeGreaterThanOrEqual(5);
    expect(story.spectatorHighlights).toEqual(
      expect.arrayContaining([
        expect.stringContaining("build action"),
        expect.stringContaining("hostile attack"),
      ]),
    );
    expect(story.boringnessWarnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Expansion-heavy")]),
    );
  });

  it("warns about repetitive expansion-only stories", () => {
    const story = buildAgentMatchStory({
      runID: "boring-run",
      matchID: "STORY",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record(1, "spawn:100", "spawn", 0),
        record(2, "expand:terra-nullius:10", "attack", 10, {
          expansion: true,
        }),
        record(3, "expand:terra-nullius:10", "attack", 20, {
          expansion: true,
        }),
        record(4, "expand:terra-nullius:10", "attack", 30, {
          expansion: true,
        }),
        record(5, "expand:terra-nullius:10", "attack", 40, {
          expansion: true,
        }),
      ],
    });

    expect(story.boringnessWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Expansion-heavy"),
        expect.stringContaining("Repeated exact actions"),
      ]),
    );
    expect(story.improvementSuggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("City or Factory"),
        expect.stringContaining("memory/repetition"),
      ]),
    );
  });

  it("does not treat different agents choosing the same neutral action id as stuck", () => {
    const story = buildAgentMatchStory({
      runID: "multi-agent-opening-run",
      matchID: "STORY",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record(1, "spawn:100", "spawn", 0),
        record(2, "expand:terra-nullius:10", "attack", 10, {
          expansion: true,
        }),
        {
          ...record(3, "expand:terra-nullius:10", "attack", 10, {
            expansion: true,
          }),
          agentID: "agent-2",
          username: "Other Nation",
        },
        record(4, "build:City:123", "build", 20, { unit: "City" }),
        record(5, "attack:RIVAL:10", "attack", 30, {
          targetName: "Rival Nation",
        }),
      ],
    });

    expect(story.repeatedExactActionCount).toBe(0);
    expect(story.boringnessWarnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Repeated exact actions")]),
    );
  });

  it("distinguishes transport-wait holds from unexplained stalling", () => {
    const story = buildAgentMatchStory({
      runID: "naval-wait-run",
      matchID: "STORY",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record(1, "spawn:100", "spawn", 0),
        record(2, "boat:777:8", "boat", 10, {
          targetID: "RIVAL",
          targetName: "Rival Nation",
          navalInvasion: true,
        }),
        {
          ...record(3, "hold", "hold", 20),
          observationSummary:
            "opportunistic Story Nation: phase=active, tick=20, own=1000 tiles, 200000 troops, visible=2, attackable=0, bordered=1, builds=0, upgrades=0, boats=2, support=0, embargo=1, strategy=naval/low",
          reason:
            "Frontier module scheduler queued 1 action(s), primary Hold this turn context=waiting for active transport to land before launching another action",
        },
        {
          ...record(4, "hold", "hold", 30),
          observationSummary:
            "opportunistic Story Nation: phase=active, tick=30, own=1000 tiles, 210000 troops, visible=2, attackable=0, bordered=1, builds=0, upgrades=0, boats=1, support=0, embargo=1, strategy=naval/low",
        },
      ],
    });

    expect(story.transportWaitHoldCount).toBe(2);
    expect(story.unexplainedHoldCount).toBe(0);
    expect(story.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "naval_wait",
          headline: expect.stringContaining("waits for transports"),
        }),
      ]),
    );
    expect(story.spectatorHighlights).toEqual(
      expect.arrayContaining([expect.stringContaining("transport-wait")]),
    );
  });

  it("classifies attack-safety and support-cooldown holds", () => {
    const attackSafetyHold: AgentDecisionRecord = {
      ...record(2, "hold", "hold", 20),
      legalActionIDs: ["attack:RIVAL:25", "hold"],
      legalActionIDsByKind: {
        attack: ["attack:RIVAL:25"],
        hold: ["hold"],
      },
      decisionMetadata: {
        blockedHostileAttackSummary:
          "attack:RIVAL:25:troop ratio is below attack trigger",
      },
    };
    const supportCooldownHold: AgentDecisionRecord = {
      ...record(3, "hold", "hold", 30),
      legalActionIDs: ["donate_gold:ALLY", "quick_chat:ALLY:help", "hold"],
      legalActionIDsByKind: {
        donate_gold: ["donate_gold:ALLY"],
        quick_chat: ["quick_chat:ALLY:help"],
        hold: ["hold"],
      },
    };
    const story = buildAgentMatchStory({
      runID: "classified-holds-run",
      matchID: "STORY",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record(1, "spawn:100", "spawn", 0),
        attackSafetyHold,
        supportCooldownHold,
      ],
    });

    expect(story.attackSafetyHoldCount).toBe(1);
    expect(story.supportCooldownHoldCount).toBe(1);
    expect(story.unexplainedHoldCount).toBe(0);
    expect(story.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "attack_safety_wait" }),
        expect.objectContaining({ kind: "support_cooldown" }),
      ]),
    );
    expect(story.spectatorHighlights).toEqual(
      expect.arrayContaining([
        expect.stringContaining("attack-safety"),
        expect.stringContaining("support-cooldown"),
      ]),
    );
  });

  it("measures visible profile differentiation in the match story", () => {
    const story = buildAgentMatchStory({
      runID: "profile-story-run",
      matchID: "STORY",
      scenario: "profiles",
      brainMode: "planner-executor",
      records: [
        profileRecord("aggressive", 1, "spawn:100", "spawn", 0),
        profileRecord("aggressive", 2, "attack:RIVAL:25", "attack", 10, {
          targetID: "RIVAL",
          targetName: "Rival Nation",
        }),
        profileRecord("aggressive", 3, "target:RIVAL", "target_player", 20, {
          targetID: "RIVAL",
          targetName: "Rival Nation",
        }),
        profileRecord("aggressive", 4, "nuke:RIVAL:400", "nuke", 30, {
          targetID: "RIVAL",
          targetName: "Rival Nation",
          targetStructureUnit: "Factory",
        }),
        profileRecord("defensive", 5, "spawn:200", "spawn", 0),
        profileRecord("defensive", 6, "build:DefensePost:210", "build", 10, {
          unit: "DefensePost",
        }),
        profileRecord("defensive", 7, "warship:211", "warship", 20, {
          unit: "Warship",
        }),
        profileRecord("defensive", 8, "retreat:RIVAL:10", "retreat", 30, {
          targetID: "RIVAL",
        }),
        profileRecord("diplomatic", 9, "spawn:300", "spawn", 0),
        profileRecord("diplomatic", 10, "alliance:ALLY", "alliance_request", 10, {
          recipientID: "ALLY",
          recipientName: "Ally Nation",
        }),
        profileRecord("diplomatic", 11, "quick_chat:ALLY:help", "quick_chat", 20, {
          recipientID: "ALLY",
          recipientName: "Ally Nation",
        }),
        profileRecord("diplomatic", 12, "donate_gold:ALLY", "donate_gold", 30, {
          recipientID: "ALLY",
          recipientName: "Ally Nation",
        }),
        profileRecord("opportunistic", 13, "spawn:400", "spawn", 0),
        profileRecord("opportunistic", 14, "expand:terra-nullius:401", "attack", 10, {
          expansion: true,
          targetID: null,
        }),
        profileRecord("opportunistic", 15, "build:City:402", "build", 20, {
          unit: "City",
        }),
        profileRecord("opportunistic", 16, "attack:RIVAL:20", "attack", 30, {
          targetID: "RIVAL",
          targetName: "Rival Nation",
        }),
      ],
    });

    expect(story.profileDifferentiation.profileCount).toBe(4);
    expect(story.profileDifferentiation.evaluatedProfileCount).toBe(4);
    expect(story.profileDifferentiation.distinctEnough).toBe(true);
    expect(story.profileDifferentiation.stallRisk).toBe("low");
    expect(story.profileDifferentiation.averagePairwiseDistance).toBeGreaterThan(
      0.14,
    );
    expect(story.profileDifferentiation.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: "aggressive",
          signatureLabel: "aggressive pressure",
        }),
        expect.objectContaining({
          profile: "defensive",
          signatureLabel: "defensive posture",
        }),
        expect.objectContaining({
          profile: "diplomatic",
          signatureLabel: "diplomatic support",
        }),
      ]),
    );
    expect(story.spectatorHighlights).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Profile differentiation gate"),
      ]),
    );
  });

  it("flags profile collapse and stall risk", () => {
    const story = buildAgentMatchStory({
      runID: "profile-collapse-run",
      matchID: "STORY",
      scenario: "profiles",
      brainMode: "planner-executor",
      records: [
        profileRecord("aggressive", 1, "spawn:100", "spawn", 0),
        profileRecord("aggressive", 2, "hold", "hold", 10),
        profileRecord("aggressive", 3, "hold", "hold", 20),
        profileRecord("aggressive", 4, "hold", "hold", 30),
        profileRecord("diplomatic", 5, "spawn:200", "spawn", 0),
        profileRecord("diplomatic", 6, "hold", "hold", 10),
        profileRecord("diplomatic", 7, "hold", "hold", 20),
        profileRecord("diplomatic", 8, "hold", "hold", 30),
      ],
    });

    expect(story.profileDifferentiation.evaluatedProfileCount).toBe(2);
    expect(story.profileDifferentiation.distinctEnough).toBe(false);
    expect(story.profileDifferentiation.stallRisk).toBe("high");
    expect(story.boringnessWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Profiles are not visibly distinct"),
        expect.stringContaining("Profile story gate found high stall risk"),
      ]),
    );
    expect(story.improvementSuggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("profile-specific scoring"),
        expect.stringContaining("profile differentiation gate"),
      ]),
    );
  });

  it("writes JSON and Markdown artifacts", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "match-story-"));
    try {
      const story = buildAgentMatchStory({
        runID: "story-run",
        matchID: "STORY",
        scenario: "actions",
        brainMode: "planner-executor",
        records: [record(1, "spawn:100", "spawn", 0)],
      });
      const paths = await writeAgentMatchStoryArtifacts({
        story,
        directory: rootDir,
      });
      await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain(
        '"entertainmentScore"',
      );
      await expect(fs.readFile(paths.markdownPath, "utf8")).resolves.toContain(
        "Match Story",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

function profileRecord(
  profile: AgentDecisionRecord["profile"],
  sequence: number,
  actionID: string,
  actionKind: AgentDecisionRecord["chosenActionKind"],
  turnNumber: number,
  metadata: Record<string, string | number | boolean | null> = {},
): AgentDecisionRecord {
  return record(sequence, actionID, actionKind, turnNumber, metadata, {
    agentID: `agent-${profile}`,
    username: `${profile} Nation`,
    profile,
  });
}

function record(
  sequence: number,
  actionID: string,
  actionKind: AgentDecisionRecord["chosenActionKind"],
  turnNumber: number,
  metadata: Record<string, string | number | boolean | null> = {},
  overrides: Partial<AgentDecisionRecord> = {},
): AgentDecisionRecord {
  const base: AgentDecisionRecord = {
    sequence,
    gameID: "STORY",
    agentID: "agent-1",
    clientID: "CLIENT01",
    username: "Story Nation",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 20,
    observationSummary: "story observation",
    legalActionIDs: [actionID, "hold"],
    legalActionIDsByKind: { [actionKind]: [actionID], hold: ["hold"] },
    attackActionIDs: actionKind === "attack" ? [actionID] : [],
    chosenActionID: actionID,
    chosenActionKind: actionKind,
    chosenActionMetadata: metadata,
    reason: `Selected ${actionKind}`,
    intent: actionKind === "hold" ? null : { type: "spawn", tile: 100 },
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: actionKind === "hold" ? null : { type: "spawn", tile: 100 },
    },
    audit: {
      auditStatus: actionKind === "hold" ? "not_applicable" : "confirmed",
      auditReason: "test audit",
    },
  };
  return { ...base, ...overrides };
}
