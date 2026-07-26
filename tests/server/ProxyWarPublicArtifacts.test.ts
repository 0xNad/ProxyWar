import { describe, expect, it } from "vitest";
import {
  isProxyWarPublicDoc,
  isProxyWarPublicExternalAgentExample,
  isProxyWarPublicLeagueArtifact,
  isProxyWarPublicLeaguePath,
  isProxyWarPublicPremiereReadPath,
  isProxyWarPublicPremiereWritePath,
  isProxyWarPublicRendererAssetPath,
  isProxyWarPublicRunArtifact,
  isProxyWarPublicTournamentArtifact,
  isProxyWarReplayOrRunPath,
  isSafeProxyWarArtifactSegment,
  matchProxyWarPublicPremiereReadPath,
  matchProxyWarPublicPremiereWritePath,
  proxyWarLeagueContentSecurityPolicy,
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
    expect(proxyWarPublicRunArtifacts).toContain("replay-ui.json");
    expect(proxyWarPublicRunArtifacts).toContain("match-package.html");
    expect(proxyWarPublicRunArtifacts).toContain("match-package.md");
    expect(proxyWarPublicRunArtifacts).toContain("match-package.json");
    expect(proxyWarPublicRunArtifacts).toContain("spectator-replay.json");
    expect(proxyWarPublicRunArtifacts).toContain("spectator-telemetry.json");
    expect(proxyWarPublicRunArtifacts).toContain("match-story.md");
    expect(proxyWarPublicRunArtifacts).toContain("external-agent-feedback.md");
    expect(isProxyWarPublicRunArtifact("game-record.json")).toBe(true);
    expect(isProxyWarPublicRunArtifact("replay-ui.json")).toBe(true);
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
    expect(proxyWarPublicTournamentArtifacts).toContain("tournament-report.md");
    expect(isProxyWarPublicTournamentArtifact("leaderboard.html")).toBe(true);
    expect(isProxyWarPublicTournamentArtifact("tournament-summary.json")).toBe(
      false,
    );
    expect(isProxyWarPublicTournamentArtifact("../leaderboard.html")).toBe(
      false,
    );
  });

  it("allowlists only public onboarding docs and example-agent files", () => {
    expect(proxyWarPublicDocs).toContain("PROXYWAR_EXTERNAL_AGENT_API.md");
    expect(proxyWarPublicDocs).toContain("PROXYWAR_TESTER_HANDOFF.md");
    expect(proxyWarPublicDocs).toContain("PROXYWAR_ASSET_AND_LICENSE_AUDIT.md");
    expect(isProxyWarPublicDoc("PROXYWAR_EXTERNAL_AGENT_API.md")).toBe(true);
    expect(isProxyWarPublicDoc("PROXYWAR_OPERATOR_RUNBOOK.md")).toBe(false);
    expect(isProxyWarPublicDoc("REMOTE_FRIENDS_BETA.md")).toBe(false);
    expect(isProxyWarPublicDoc("AI_NATIONS_LEAGUE.md")).toBe(false);

    expect(proxyWarPublicExternalAgentExamples).toContain("simple-agent.mjs");
    expect(proxyWarPublicExternalAgentExamples).toContain("relay-worker.mjs");
    expect(proxyWarPublicExternalAgentExamples).toContain(
      "starter-framework.mjs",
    );
    expect(proxyWarPublicExternalAgentExamples).toContain(
      "PROXYWAR_AGENT_CARD.md",
    );
    expect(proxyWarPublicExternalAgentExamples).toContain("AGENT_SKILL.md");
    expect(proxyWarPublicExternalAgentExamples).toContain("package.json");
    expect(proxyWarPublicExternalAgentExamples).toContain("launch.sh");
    expect(proxyWarPublicExternalAgentExamples).toContain("bootstrap.sh");
    expect(proxyWarPublicExternalAgentExamples).toContain(".env.example");
    expect(proxyWarPublicExternalAgentExamples).toContain("LICENSE");
    expect(isProxyWarPublicExternalAgentExample("simple-agent.mjs")).toBe(true);
    expect(isProxyWarPublicExternalAgentExample("../simple-agent.mjs")).toBe(
      false,
    );
  });

  it("rejects unsafe path segments for run ids and artifact names", () => {
    expect(isSafeProxyWarArtifactSegment("2026-05-12T01-27-run-10")).toBe(true);
    expect(isSafeProxyWarArtifactSegment("../secret")).toBe(false);
    expect(isSafeProxyWarArtifactSegment(".")).toBe(false);
    expect(isSafeProxyWarArtifactSegment("..")).toBe(false);
    expect(isSafeProxyWarArtifactSegment("nested/file")).toBe(false);
    expect(isSafeProxyWarArtifactSegment("")).toBe(false);
    expect(isSafeProxyWarArtifactSegment("x".repeat(181))).toBe(false);
  });

  it("allows only the league site files as league artifacts", () => {
    expect(isProxyWarPublicLeagueArtifact("index.html")).toBe(true);
    expect(isProxyWarPublicLeagueArtifact("client.js")).toBe(true);
    expect(isProxyWarPublicLeagueArtifact("data.json")).toBe(true);
    expect(isProxyWarPublicLeagueArtifact("secrets.json")).toBe(false);
    expect(isProxyWarPublicLeagueArtifact("spectator.html")).toBe(false);
  });

  it("allows the external league client without permitting inline scripts", () => {
    const policy = proxyWarLeagueContentSecurityPolicy();
    const scriptDirective = policy
      .split("; ")
      .find((directive) => directive.startsWith("script-src"));
    expect(scriptDirective).toBe("script-src 'self'");
    expect(scriptDirective).not.toContain("unsafe-inline");
    expect(scriptDirective).not.toContain("unsafe-eval");
    expect(policy).toContain("connect-src 'self'");
  });

  it("lets only league mirror paths through the beta gate anonymously", () => {
    expect(isProxyWarPublicLeaguePath("/league")).toBe(true);
    expect(
      isProxyWarPublicLeaguePath("/ai-league-runs/league/index.html"),
    ).toBe(true);
    expect(isProxyWarPublicLeaguePath("/ai-league-runs/league/data.json")).toBe(
      true,
    );
    expect(isProxyWarPublicLeaguePath("/ai-league-runs/league/client.js")).toBe(
      true,
    );
    expect(
      isProxyWarPublicLeaguePath(
        "/ai-league-runs/league-coworld-2026-07-13T10-40-45-699Z-9ed769ef/spectator.html",
      ),
    ).toBe(true);
    expect(
      isProxyWarPublicLeaguePath(
        "/ai-league-runs/league-coworld-2026-07-13T10-40-45-699Z-9ed769ef/decisions.jsonl",
      ),
    ).toBe(true);
    expect(
      isProxyWarPublicLeaguePath(
        "/ai-league-runs/league-coworld-2026-07-13T10-40-45-699Z-9ed769ef/replay-ui.json",
      ),
    ).toBe(true);
    // Non-league run directories stay gated, whatever the artifact.
    expect(
      isProxyWarPublicLeaguePath(
        "/ai-league-runs/coworld-2026-07-13T10-40-45-699Z-9ed769ef/spectator.html",
      ),
    ).toBe(false);
    expect(
      isProxyWarPublicLeaguePath(
        "/ai-league-runs/2026-06-05-run/spectator.html",
      ),
    ).toBe(false);
    // League dirs expose only allowlisted artifact names.
    expect(
      isProxyWarPublicLeaguePath("/ai-league-runs/league/secrets.json"),
    ).toBe(false);
    expect(
      isProxyWarPublicLeaguePath("/ai-league-runs/league-x/agent-config.json"),
    ).toBe(false);
    // Traversal/odd shapes are rejected.
    expect(
      isProxyWarPublicLeaguePath("/ai-league-runs/league/../secret.html"),
    ).toBe(false);
    expect(isProxyWarPublicLeaguePath("/ai-league-runs/league/")).toBe(false);
    expect(isProxyWarPublicLeaguePath("/api/league")).toBe(false);
  });

  it("lets league full renders through the gate but not other replays", () => {
    expect(
      isProxyWarPublicLeaguePath(
        "/ai-league-replay/league-coworld-2026-07-13T10-40-45-699Z-9ed769ef",
      ),
    ).toBe(true);
    expect(
      isProxyWarPublicLeaguePath(
        "/ai-league-replay/coworld-2026-07-13T10-40-45-699Z-9ed769ef",
      ),
    ).toBe(false);
    expect(isProxyWarPublicLeaguePath("/ai-league-replay/league-x/extra")).toBe(
      false,
    );
    expect(isProxyWarPublicLeaguePath("/ai-league-replay/")).toBe(false);
  });

  it("recognizes replay-shaped paths that must fail closed", () => {
    expect(
      isProxyWarReplayOrRunPath("/ai-league-replay/controlled-source-1"),
    ).toBe(true);
    expect(
      isProxyWarReplayOrRunPath(
        "/ai-league-runs/controlled-source-1/game-record.json",
      ),
    ).toBe(true);
    expect(
      isProxyWarReplayOrRunPath("/proxywar-replay/controlled-source-1"),
    ).toBe(true);
    expect(isProxyWarReplayOrRunPath("/league")).toBe(false);
    expect(isProxyWarReplayOrRunPath("/ai-league-replay/")).toBe(false);
  });

  it("marks renderer asset prefixes as anonymously fetchable", () => {
    expect(isProxyWarPublicRendererAssetPath("/src/client/Main.ts")).toBe(true);
    expect(isProxyWarPublicRendererAssetPath("/assets/index.js")).toBe(true);
    expect(isProxyWarPublicRendererAssetPath("/_assets/index.js")).toBe(true);
    expect(isProxyWarPublicRendererAssetPath("/maps/pangaea/map.bin")).toBe(
      true,
    );
    expect(isProxyWarPublicRendererAssetPath("/favicon.ico")).toBe(true);
    expect(isProxyWarPublicRendererAssetPath("/@vite/client")).toBe(true);
    // Not a listed prefix, and prefix names must match whole segments.
    expect(isProxyWarPublicRendererAssetPath("/@fs/etc/passwd")).toBe(false);
    expect(isProxyWarPublicRendererAssetPath("/srcs/evil.js")).toBe(false);
    expect(isProxyWarPublicRendererAssetPath("/public")).toBe(false);
    expect(isProxyWarPublicRendererAssetPath("/tester-dashboard")).toBe(false);
  });

  it("allowlists only the narrow progressive Premiere read surface", () => {
    const id = "prem_0123456789abcdef";
    expect(matchProxyWarPublicPremiereReadPath(`/premiere/${id}`)).toEqual({
      kind: "page",
      premiereId: id,
    });
    expect(
      matchProxyWarPublicPremiereReadPath(`/api/premieres/${id}/bootstrap`),
    ).toEqual({ kind: "bootstrap", premiereId: id });
    expect(
      matchProxyWarPublicPremiereReadPath(`/api/premieres/${id}/manifest`),
    ).toEqual({ kind: "manifest", premiereId: id });
    expect(
      matchProxyWarPublicPremiereReadPath(`/api/premieres/${id}/chunks/12`),
    ).toEqual({ kind: "chunk", premiereId: id, chunkIndex: 12 });
    expect(
      isProxyWarPublicPremiereReadPath(`/api/premieres/${id}/reveal`),
    ).toBe(true);
    expect(
      isProxyWarPublicPremiereReadPath(`/premiere/${id}/card-v1.svg`),
    ).toBe(true);
    expect(
      matchProxyWarPublicPremiereReadPath(`/api/premieres/${id}/market`),
    ).toEqual({ kind: "market_state", premiereId: id });

    for (const forbidden of [
      `/api/premieres/${id}/source`,
      `/api/premieres/${id}/game-record.json`,
      `/api/premieres/${id}/chunks/01`,
      `/api/premieres/${id}/chunks/-1`,
      `/api/premieres/${id}/chunks/1000000000`,
      `/api/premieres/${id}/chunks/0.json`,
      `/premiere/${id}/result.json`,
      `/premiere/${id}%2fsource`,
      `/premiere/${id}/../source`,
      "/premiere/prem_0123456789ABCDEF",
    ]) {
      expect(isProxyWarPublicPremiereReadPath(forbidden)).toBe(false);
    }
  });

  it("allowlists only guest Premiere writes, never publisher transitions", () => {
    const id = "prem_0123456789abcdef";
    expect(
      matchProxyWarPublicPremiereWritePath(`/api/premieres/${id}/predictions`),
    ).toEqual({ kind: "prediction", premiereId: id });
    expect(
      matchProxyWarPublicPremiereWritePath(`/api/premieres/${id}/reactions`),
    ).toEqual({ kind: "reaction", premiereId: id });
    expect(
      matchProxyWarPublicPremiereWritePath(`/api/premieres/${id}/shares`),
    ).toEqual({ kind: "share", premiereId: id });
    expect(
      matchProxyWarPublicPremiereWritePath(`/api/premieres/${id}/sessions`),
    ).toEqual({ kind: "session", premiereId: id });
    expect(
      matchProxyWarPublicPremiereWritePath(`/api/premieres/${id}/market-orders`),
    ).toEqual({ kind: "market_order", premiereId: id });
    expect(
      matchProxyWarPublicPremiereWritePath(
        `/api/premieres/${id}/sessions/sess_0123456789abcdef/heartbeat`,
      ),
    ).toEqual({
      kind: "heartbeat",
      premiereId: id,
      sessionId: "sess_0123456789abcdef",
    });

    for (const forbidden of [
      `/api/premieres/${id}/publish`,
      `/api/premieres/${id}/start`,
      `/api/premieres/${id}/reveal`,
      `/api/premieres/${id}/archive`,
      `/api/premieres/${id}/predictions/extra`,
      `/api/premieres/${id}/market-orders/extra`,
      `/api/premieres/${id}/sessions/../../admin/heartbeat`,
      `/api/premieres/${id}/sessions/sess_0123456789ABCDEF/heartbeat`,
    ]) {
      expect(isProxyWarPublicPremiereWritePath(forbidden)).toBe(false);
    }
  });
});
