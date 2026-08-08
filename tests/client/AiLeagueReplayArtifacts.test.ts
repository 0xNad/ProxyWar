import { describe, expect, it, vi } from "vitest";
import {
  loadAiLeagueReplayDetails,
  type AiLeagueReplayDetails,
} from "../../src/client/AiLeagueReplayArtifacts";
import { buildCoworldReplayUiArtifact } from "../../src/server/agents/CoworldLeagueMirrorCore";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AiLeagueReplayArtifacts", () => {
  it("loads bounded replay UI details without downloading the raw decision log", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/replay-ui.json")) {
        return jsonResponse({
          version: 1,
          decisionCount: 3_256,
          rejectedCount: 4,
          fallbackCount: 191,
          actionCounts: { attack: 900, boat: 700 },
          recentDecisions: [
            {
              sequence: 3_256,
              turnNumber: 50_400,
              username: "Auri",
              profile: "balanced",
              brainType: "external-http",
              selectedActionKind: "attack",
              selectedLegalActionId: "attack:rival:20",
              reason: "Pressure the leader.",
              decisionLatencyMs: 12,
              fallbackUsed: false,
              result: { accepted: true, reason: "accepted" },
            },
          ],
          artifacts: {
            visualReport: false,
            spectatorTelemetry: true,
            decisions: true,
            summary: true,
          },
        });
      }
      if (url.endsWith("/match-summary.json")) {
        return jsonResponse({ roster: [{ username: "Auri" }] });
      }
      if (url.endsWith("/spectator-telemetry.json")) {
        return jsonResponse({ version: 1, events: [] });
      }
      if (url.endsWith("/match-state-series.json")) {
        return jsonResponse({
          schemaVersion: 1,
          totalTurns: 50_400,
          samples: [],
        });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const details = await loadAiLeagueReplayDetails("/runs/league-run", {
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(
      fetchImpl.mock.calls.map(([input]) => String(input)).join("\n"),
    ).not.toContain("decisions.jsonl");
    expect(details.recentDecisions).toHaveLength(1);
    expect(details.summary).toMatchObject({
      decisionCount: 3_256,
      rejectedCount: 4,
      fallbackCount: 191,
      actionCounts: { attack: 900, boat: 700 },
    });
    expect(details.artifactAvailability).toEqual({
      visualReport: false,
      spectatorTelemetry: true,
      decisions: true,
      summary: true,
    });
    expect(details.matchStateSeries).toMatchObject({
      schemaVersion: 1,
      totalTurns: 50_400,
    });
  });

  it("falls back to HEAD checks for legacy bundles and keeps optional failures non-fatal", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/replay-ui.json"))
        return new Response(null, { status: 404 });
      if (url.endsWith("/match-summary.json")) {
        return jsonResponse({ decisionCount: 20 });
      }
      if (url.endsWith("/spectator-telemetry.json")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/visual-report.html")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/decisions.jsonl")) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const details = await loadAiLeagueReplayDetails("/runs/legacy", {
      fetchImpl,
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        { url: "/runs/legacy/visual-report.html", method: "HEAD" },
        { url: "/runs/legacy/decisions.jsonl", method: "HEAD" },
      ]),
    );
    expect(details.recentDecisions).toEqual([]);
    expect(details.summary).toEqual({ decisionCount: 20 });
    expect(details.spectatorTelemetry).toBeNull();
    expect(details.artifactAvailability).toEqual({
      visualReport: false,
      spectatorTelemetry: false,
      decisions: true,
      summary: true,
    });
  });

  it("rejects malformed replay UI rows instead of exposing them to the overlay", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/replay-ui.json")) {
        return jsonResponse({
          version: 1,
          decisionCount: 1,
          rejectedCount: 0,
          fallbackCount: 0,
          actionCounts: { attack: 1, invalid: "many" },
          recentDecisions: [{ username: "missing required fields" }],
          artifacts: {
            visualReport: false,
            spectatorTelemetry: false,
            decisions: true,
            summary: false,
          },
        });
      }
      return new Response(null, { status: 404 });
    });

    const details = await loadAiLeagueReplayDetails("/runs/malformed", {
      fetchImpl,
    });

    expect(details.recentDecisions).toEqual([]);
    expect(details.summary).toMatchObject({ actionCounts: { attack: 1 } });
  });

  it("does not overwrite truthful match-summary counts when replay UI aggregate evidence is unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/replay-ui.json")) {
        return jsonResponse({
          version: 1,
          aggregateSource: "unavailable",
          decisionCount: 0,
          rejectedCount: 0,
          fallbackCount: 0,
          actionCounts: {},
          recentDecisions: [],
          artifacts: {
            visualReport: false,
            spectatorTelemetry: false,
            decisions: false,
            summary: false,
          },
        });
      }
      if (url.endsWith("/match-summary.json")) {
        return jsonResponse({
          decisionCount: 6,
          rejectedCount: 1,
          fallbackCount: 2,
          actionCounts: { spawn: 2, attack: 4 },
        });
      }
      return new Response(null, { status: 404 });
    });

    const details = await loadAiLeagueReplayDetails("/runs/privacy-safe", {
      fetchImpl,
    });

    expect(details.summary).toMatchObject({
      decisionCount: 6,
      rejectedCount: 1,
      fallbackCount: 2,
      actionCounts: { spawn: 2, attack: 4 },
    });
    expect(details.recentDecisions).toEqual([]);
  });

  it("preserves exact sanitized Coworld aggregate truth through mirror projection and client parsing", async () => {
    const summary = {
      decisionCount: 6,
      rejectedCount: 0,
      fallbackCount: 0,
      actionCounts: { spawn: 2, attack: 4 },
    };
    const publicInlineArtifacts = {
      "game-record.json": '{"messages":[]}',
      "deal-ledger.json": '{"schemaVersion":1,"deals":[],"events":[]}',
      "match-summary.json": JSON.stringify(summary),
      "spectator-telemetry.json": '{"version":1,"agents":[],"events":[]}',
    };
    const replayUi = buildCoworldReplayUiArtifact(publicInlineArtifacts);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/replay-ui.json")) return jsonResponse(replayUi);
      if (url.endsWith("/match-summary.json")) return jsonResponse(summary);
      if (url.endsWith("/spectator-telemetry.json")) {
        return jsonResponse({ version: 1, agents: [], events: [] });
      }
      return new Response(null, { status: 404 });
    });

    const details = await loadAiLeagueReplayDetails("/runs/sanitized", {
      fetchImpl,
    });

    expect(replayUi).toMatchObject({
      aggregateSource: "match-summary",
      ...summary,
      recentDecisions: [],
    });
    expect(details.summary).toMatchObject(summary);
    expect(details.recentDecisions).toEqual([]);
    expect(
      JSON.stringify({ publicInlineArtifacts, replayUi, details }),
    ).not.toMatch(/decisions\.jsonl|rawLlmPrompt|rawLlmOutput|provider-output/);
  });

  it("publishes bounded core details before slow optional telemetry settles", async () => {
    let resolveTelemetry!: (response: Response) => void;
    const telemetryResponse = new Promise<Response>((resolve) => {
      resolveTelemetry = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.endsWith("/replay-ui.json")) {
        return Promise.resolve(
          jsonResponse({
            version: 1,
            decisionCount: 44,
            rejectedCount: 2,
            fallbackCount: 3,
            actionCounts: { attack: 30 },
            recentDecisions: [],
            artifacts: {
              visualReport: false,
              spectatorTelemetry: true,
              decisions: true,
              summary: true,
            },
          }),
        );
      }
      if (url.endsWith("/match-summary.json")) {
        return Promise.resolve(jsonResponse({ roster: [] }));
      }
      if (url.endsWith("/spectator-telemetry.json")) {
        return telemetryResponse;
      }
      return Promise.reject(new Error(`unexpected request ${url}`));
    });
    let resolvePartial!: (details: AiLeagueReplayDetails) => void;
    const partialPromise = new Promise<AiLeagueReplayDetails>((resolve) => {
      resolvePartial = resolve;
    });

    const detailsPromise = loadAiLeagueReplayDetails("/runs/slow-telemetry", {
      fetchImpl,
      onPartial: resolvePartial,
    });
    const partial = await partialPromise;

    expect(partial.summary).toMatchObject({ decisionCount: 44 });
    expect(partial.artifactAvailability.spectatorTelemetry).toBe(false);
    resolveTelemetry(jsonResponse({ version: 1, events: ["ready"] }));
    const details = await detailsPromise;
    expect(details.spectatorTelemetry).toEqual({
      version: 1,
      events: ["ready"],
    });
    expect(details.artifactAvailability.spectatorTelemetry).toBe(true);
  });
});
