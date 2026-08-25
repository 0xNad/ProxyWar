import {
  economyDeterrencePlaybook,
  frontierAgentSkill,
  openFrontAgentPlaybook,
  profilePlaybook,
} from "../../src/server/agents/AgentPlaybook";
import {
  buildCommanderPrompt,
  CommanderPromptBuilder,
} from "../../src/server/agents/CommanderPromptBuilder";
import { canonicalCommanderJson } from "../../src/server/agents/CommanderStateBuilder";
import { UNTRUSTED_DISPLAY_RULE } from "../../src/server/agents/PromptSanitizer";
import {
  BASELINE_CANARY,
  EVIDENCE_LEAK_CANARY,
  LOW_LEVEL_LABEL_CANARY,
  makeCommanderStage2Fixture,
  MINIMAP_CANARY,
  RAW_ATTACK_ACTION_ID,
  RAW_BUILD_ACTION_ID,
  RAW_EXPANSION_ACTION_ID,
  RAW_MENU_CANARY,
  TACTICAL_CANARY,
} from "./StrategicCommanderStage2TestHarness";

describe("CommanderPromptBuilder Stage 2", () => {
  it("serializes only the bounded Commander state in a small dedicated prompt", () => {
    const fixture = makeCommanderStage2Fixture();
    const prompt = new CommanderPromptBuilder().build(fixture.builtState.state);
    const stateJson = canonicalCommanderJson(fixture.builtState.state);

    expect(prompt).toContain("Your job is strategy, not low-level execution.");
    expect(prompt).toContain(
      "Choose exactly one currently offered StrategicOption by its id.",
    );
    expect(prompt).toContain("Do not invent options.");
    expect(prompt).toContain("Return one JSON object only");
    expect(prompt).toContain("defaults to 3");
    expect(prompt).toContain("clamped from 2 through 6");
    expect(prompt).toContain("normalized");
    expect(prompt).toContain("capped at 160 characters");
    expect(prompt).toContain("replanTriggers is optional");
    expect(prompt).toContain("without duplicates");
    expect(prompt).toContain("finite range from 0 through 1 are ignored");
    expect(prompt).toContain(UNTRUSTED_DISPLAY_RULE);
    expect(prompt).toContain(
      `COMMANDER_STATE_JSON:\n${stateJson}\nEND_COMMANDER_STATE_JSON`,
    );
    expect(prompt.length - stateJson.length).toBeLessThan(4_000);
    expect(prompt.length).toBeLessThan(12_000);
  });

  it("excludes low-level menus, rankings, baselines, tactics, minimaps, and playbooks", () => {
    const fixture = makeCommanderStage2Fixture();
    const prompt = buildCommanderPrompt(fixture.builtState.state);
    const forbidden = [
      RAW_EXPANSION_ACTION_ID,
      RAW_BUILD_ACTION_ID,
      RAW_ATTACK_ACTION_ID,
      LOW_LEVEL_LABEL_CANARY,
      RAW_MENU_CANARY,
      BASELINE_CANARY,
      EVIDENCE_LEAK_CANARY,
      TACTICAL_CANARY,
      MINIMAP_CANARY,
      "RANKED_CANDIDATES_JSON",
      "totalScore",
      "policyScore",
      "skillScore",
      "recommendedActionKinds",
      '"priority":',
      '"territoryRank":',
      '"tick":',
      '"decisionSequence":',
      '"troopRatio":',
      '"structures":',
      '"isDisconnected":',
      "preferredModules",
      "tacticalAffordances",
      "OPENFRONT_PLAYBOOK",
      "FRONTIER_AGENT_SKILL",
      longExcerpt(openFrontAgentPlaybook),
      longExcerpt(economyDeterrencePlaybook),
      longExcerpt(profilePlaybook(fixture.observation.profile)),
      longExcerpt(frontierAgentSkill),
    ];

    for (const value of forbidden) {
      expect(prompt, `must exclude ${value}`).not.toContain(value);
    }
    expect(prompt).toContain("LegalAction IDs");
    expect(prompt).not.toContain("raw-expand-tile");
    expect(prompt).not.toContain("buildTile");

    const lowerPrompt = prompt.toLowerCase();
    for (const banned of [
      "rank",
      "score",
      "priority",
      "recommended",
      "best",
      "risk",
    ]) {
      expect(lowerPrompt, `must exclude ${banned} recursively`).not.toContain(
        banned,
      );
    }
    expect(prompt).not.toMatch(
      /(?:attack|expand|build|boat|alliance|embargo|donate_|upgrade|target|spawn|hold):/i,
    );
  });

  it("supplies structured orientation as context-only without minimap or raw coordinates", () => {
    const fixture = makeCommanderStage2Fixture({ validSpatial: true });
    const prompt = buildCommanderPrompt(fixture.builtState.state);

    expect(prompt).toContain(
      "orientation, when present, is bounded global public-map context",
    );
    expect(prompt).toContain("comparing offered StrategicOptions only");
    expect(prompt).toContain("cannot create or authorize an action");
    expect(prompt).toContain(
      '"visibilityModel":"global-lockstep-public-map-v1"',
    );
    expect(prompt).toContain('"quadrant":"northwest"');
    expect(prompt).toContain('"bearing":"north"');
    expect(prompt).toContain('"distanceClass":"adjacent"');
    expect(prompt).not.toContain(MINIMAP_CANARY);
    expect(prompt).not.toContain('"minimap"');
    expect(prompt).not.toContain('"positionedAssets"');
    expect(prompt).not.toContain('"tileRefEncoding"');
  });

  it("is byte-deterministic across irrelevant source ordering", () => {
    const forward = makeCommanderStage2Fixture({ validSpatial: true });
    const reversed = makeCommanderStage2Fixture({
      reverseSources: true,
      validSpatial: true,
    });

    expect(buildCommanderPrompt(reversed.builtState.state)).toBe(
      buildCommanderPrompt(forward.builtState.state),
    );
  });
});

function longExcerpt(value: string): string {
  const excerpt = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 48);
  if (excerpt === undefined) {
    throw new Error("Expected a nontrivial playbook excerpt");
  }
  return excerpt.slice(0, 96);
}
