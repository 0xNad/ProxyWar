import { describe, expect, it } from "vitest";
import {
  buildExternalAgentDryRunSmokeArgs,
  buildExternalAgentDryRunManifests,
  parseExternalAgentDryRunSmokeOutput,
} from "../../src/server/agents/ExternalAgentDryRun";

describe("ExternalAgentDryRun", () => {
  it("builds a four-agent external-http roster for onboarding verification", () => {
    const manifests = buildExternalAgentDryRunManifests({
      endpointUrl: "https://agent.example.com/proxywar/decide",
      timeoutMs: 5_000,
    });

    expect(manifests).toHaveLength(4);
    expect(new Set(manifests.map((manifest) => manifest.profile)).size).toBe(4);
    for (const manifest of manifests) {
      expect(manifest.brainType).toBe("external-http");
      expect(manifest.plannerExecutorMode).toBe(false);
      expect(manifest.provider).toMatchObject({
        provider: "external-http",
        endpointUrl: "https://agent.example.com/proxywar/decide",
        timeoutMs: 5_000,
      });
    }
  });

  it("extracts useful artifact links from league smoke output", () => {
    const parsed = parseExternalAgentDryRunSmokeOutput(`
      artifacts: {
        runID: '2026-run-external',
        visualReportPath: '/tmp/run/visual-report.html'
      },
      openFrontReplayUrl: 'http://localhost:9000/ai-league-replay/2026-run-external'
    `);

    expect(parsed).toEqual({
      runID: "2026-run-external",
      visualReportPath: "/tmp/run/visual-report.html",
      openFrontReplayUrl:
        "http://localhost:9000/ai-league-replay/2026-run-external",
    });
  });

  it("uses a generated compact map for deterministic no-secret dry runs", () => {
    expect(
      buildExternalAgentDryRunSmokeArgs({
        manifestDir: "/tmp/manifests",
        maxSteps: 1,
        turnsPerDecisionStep: 25,
        replayTailTurns: 50,
      }),
    ).toEqual(
      expect.arrayContaining([
        "--scenario=actions",
        "--map=Pangaea",
        "--map-size=Compact",
        "--vary-spawns",
        "--agent-manifest-dir=/tmp/manifests",
      ]),
    );
  });
});
