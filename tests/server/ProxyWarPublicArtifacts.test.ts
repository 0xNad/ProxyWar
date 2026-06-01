import { describe, expect, it } from "vitest";
import {
  isProxyWarPublicDoc,
  isProxyWarPublicExternalAgentExample,
  isProxyWarPublicRunArtifact,
  isProxyWarPublicTournamentArtifact,
  isSafeProxyWarArtifactSegment,
  proxyWarPublicDocs,
  proxyWarPublicExternalAgentExamples,
  proxyWarPublicRunArtifacts,
  proxyWarPublicTournamentArtifacts,
} from "../../src/server/agents/ProxyWarPublicArtifacts";

describe("ProxyWarPublicArtifacts", () => {
  it("allows the replay artifacts needed by the rendered OpenFront client", () => {
    expect(proxyWarPublicRunArtifacts).toContain("game-record.json");
    expect(proxyWarPublicRunArtifacts).toContain("decisions.jsonl");
    expect(proxyWarPublicRunArtifacts).toContain("match-summary.json");
    expect(proxyWarPublicRunArtifacts).toContain("match-package.html");
    expect(proxyWarPublicRunArtifacts).toContain("match-package.md");
    expect(proxyWarPublicRunArtifacts).toContain("match-package.json");
    expect(proxyWarPublicRunArtifacts).toContain("spectator-replay.json");
    expect(proxyWarPublicRunArtifacts).toContain(
      "spectator-telemetry.json",
    );
    expect(proxyWarPublicRunArtifacts).toContain("match-story.md");
    expect(proxyWarPublicRunArtifacts).toContain("external-agent-feedback.md");
    expect(isProxyWarPublicRunArtifact("game-record.json")).toBe(true);
  });

  it("keeps non-public debug artifacts out of the closed beta artifact route", () => {
    expect(isProxyWarPublicRunArtifact("external-agent-feedback.json")).toBe(
      false,
    );
    expect(isProxyWarPublicRunArtifact("run-1.records.json")).toBe(false);
    expect(isProxyWarPublicRunArtifact("../game-record.json")).toBe(false);
  });

  it("allows only public-safe tournament showcase artifacts", () => {
    expect(proxyWarPublicTournamentArtifacts).toContain("leaderboard.html");
    expect(proxyWarPublicTournamentArtifacts).toContain(
      "tournament-report.md",
    );
    expect(isProxyWarPublicTournamentArtifact("leaderboard.html")).toBe(
      true,
    );
    expect(isProxyWarPublicTournamentArtifact("tournament-summary.json")).toBe(
      false,
    );
    expect(isProxyWarPublicTournamentArtifact("../leaderboard.html")).toBe(
      false,
    );
  });

  it("allowlists only public onboarding docs and example-agent files", () => {
    expect(proxyWarPublicDocs).toContain(
      "PROXYWAR_EXTERNAL_AGENT_API.md",
    );
    expect(proxyWarPublicDocs).toContain("PROXYWAR_TESTER_HANDOFF.md");
    expect(proxyWarPublicDocs).toContain(
      "PROXYWAR_ASSET_AND_LICENSE_AUDIT.md",
    );
    expect(isProxyWarPublicDoc("PROXYWAR_EXTERNAL_AGENT_API.md")).toBe(
      true,
    );
    expect(isProxyWarPublicDoc("PROXYWAR_OPERATOR_RUNBOOK.md")).toBe(
      false,
    );
    expect(isProxyWarPublicDoc("REMOTE_FRIENDS_BETA.md")).toBe(false);
    expect(isProxyWarPublicDoc("AI_NATIONS_LEAGUE.md")).toBe(false);

    expect(proxyWarPublicExternalAgentExamples).toContain("simple-agent.mjs");
    expect(proxyWarPublicExternalAgentExamples).toContain(
      "starter-framework.mjs",
    );
    expect(proxyWarPublicExternalAgentExamples).toContain(
      "PROXYWAR_AGENT_CARD.md",
    );
    expect(proxyWarPublicExternalAgentExamples).toContain("AGENT_SKILL.md");
    expect(proxyWarPublicExternalAgentExamples).toContain("package.json");
    expect(proxyWarPublicExternalAgentExamples).toContain("launch.sh");
    expect(proxyWarPublicExternalAgentExamples).toContain(".env.example");
    expect(proxyWarPublicExternalAgentExamples).toContain("LICENSE");
    expect(isProxyWarPublicExternalAgentExample("simple-agent.mjs")).toBe(
      true,
    );
    expect(isProxyWarPublicExternalAgentExample("../simple-agent.mjs")).toBe(
      false,
    );
  });

  it("rejects unsafe path segments for run ids and artifact names", () => {
    expect(isSafeProxyWarArtifactSegment("2026-05-12T01-27-run-10")).toBe(
      true,
    );
    expect(isSafeProxyWarArtifactSegment("../secret")).toBe(false);
    expect(isSafeProxyWarArtifactSegment(".")).toBe(false);
    expect(isSafeProxyWarArtifactSegment("..")).toBe(false);
    expect(isSafeProxyWarArtifactSegment("nested/file")).toBe(false);
    expect(isSafeProxyWarArtifactSegment("")).toBe(false);
    expect(isSafeProxyWarArtifactSegment("x".repeat(181))).toBe(false);
  });
});
