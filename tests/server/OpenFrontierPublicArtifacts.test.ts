import { describe, expect, it } from "vitest";
import {
  isOpenFrontierPublicDoc,
  isOpenFrontierPublicExternalAgentExample,
  isOpenFrontierPublicRunArtifact,
  isOpenFrontierPublicTournamentArtifact,
  isSafeOpenFrontierArtifactSegment,
  openFrontierPublicDocs,
  openFrontierPublicExternalAgentExamples,
  openFrontierPublicRunArtifacts,
  openFrontierPublicTournamentArtifacts,
} from "../../src/server/agents/OpenFrontierPublicArtifacts";

describe("OpenFrontierPublicArtifacts", () => {
  it("allows the replay artifacts needed by the rendered OpenFront client", () => {
    expect(openFrontierPublicRunArtifacts).toContain("game-record.json");
    expect(openFrontierPublicRunArtifacts).toContain("decisions.jsonl");
    expect(openFrontierPublicRunArtifacts).toContain("match-summary.json");
    expect(openFrontierPublicRunArtifacts).toContain("match-package.html");
    expect(openFrontierPublicRunArtifacts).toContain("match-package.md");
    expect(openFrontierPublicRunArtifacts).toContain("match-package.json");
    expect(openFrontierPublicRunArtifacts).toContain("spectator-replay.json");
    expect(openFrontierPublicRunArtifacts).toContain(
      "spectator-telemetry.json",
    );
    expect(openFrontierPublicRunArtifacts).toContain("match-story.md");
    expect(openFrontierPublicRunArtifacts).toContain("external-agent-feedback.md");
    expect(isOpenFrontierPublicRunArtifact("game-record.json")).toBe(true);
  });

  it("keeps non-public debug artifacts out of the closed beta artifact route", () => {
    expect(isOpenFrontierPublicRunArtifact("external-agent-feedback.json")).toBe(
      false,
    );
    expect(isOpenFrontierPublicRunArtifact("run-1.records.json")).toBe(false);
    expect(isOpenFrontierPublicRunArtifact("../game-record.json")).toBe(false);
  });

  it("allows only public-safe tournament showcase artifacts", () => {
    expect(openFrontierPublicTournamentArtifacts).toContain("leaderboard.html");
    expect(openFrontierPublicTournamentArtifacts).toContain(
      "tournament-report.md",
    );
    expect(isOpenFrontierPublicTournamentArtifact("leaderboard.html")).toBe(
      true,
    );
    expect(isOpenFrontierPublicTournamentArtifact("tournament-summary.json")).toBe(
      false,
    );
    expect(isOpenFrontierPublicTournamentArtifact("../leaderboard.html")).toBe(
      false,
    );
  });

  it("allowlists only public onboarding docs and example-agent files", () => {
    expect(openFrontierPublicDocs).toContain("OPEN_FRONTIER_START_HERE.md");
    expect(openFrontierPublicDocs).toContain(
      "OPEN_FRONTIER_EXTERNAL_AGENT_API.md",
    );
    expect(openFrontierPublicDocs).toContain("OPEN_FRONTIER_OPERATOR_RUNBOOK.md");
    expect(isOpenFrontierPublicDoc("OPEN_FRONTIER_EXTERNAL_AGENT_API.md")).toBe(
      true,
    );
    expect(isOpenFrontierPublicDoc("AI_NATIONS_LEAGUE.md")).toBe(false);

    expect(openFrontierPublicExternalAgentExamples).toContain("simple-agent.mjs");
    expect(openFrontierPublicExternalAgentExamples).toContain(
      "starter-framework.mjs",
    );
    expect(openFrontierPublicExternalAgentExamples).toContain(
      "OPEN_FRONTIER_AGENT_CARD.md",
    );
    expect(openFrontierPublicExternalAgentExamples).toContain("AGENT_SKILL.md");
    expect(openFrontierPublicExternalAgentExamples).toContain("package.json");
    expect(openFrontierPublicExternalAgentExamples).toContain(".env.example");
    expect(openFrontierPublicExternalAgentExamples).toContain("LICENSE");
    expect(isOpenFrontierPublicExternalAgentExample("simple-agent.mjs")).toBe(
      true,
    );
    expect(isOpenFrontierPublicExternalAgentExample("../simple-agent.mjs")).toBe(
      false,
    );
  });

  it("rejects unsafe path segments for run ids and artifact names", () => {
    expect(isSafeOpenFrontierArtifactSegment("2026-05-12T01-27-run-10")).toBe(
      true,
    );
    expect(isSafeOpenFrontierArtifactSegment("../secret")).toBe(false);
    expect(isSafeOpenFrontierArtifactSegment(".")).toBe(false);
    expect(isSafeOpenFrontierArtifactSegment("..")).toBe(false);
    expect(isSafeOpenFrontierArtifactSegment("nested/file")).toBe(false);
    expect(isSafeOpenFrontierArtifactSegment("")).toBe(false);
    expect(isSafeOpenFrontierArtifactSegment("x".repeat(181))).toBe(false);
  });
});
