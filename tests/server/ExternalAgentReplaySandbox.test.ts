import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  normalizeExternalAgentReplaySandboxInput,
  replayExternalAgentDecision,
} from "../../src/server/agents/ExternalAgentReplaySandbox";

describe("ExternalAgentReplaySandbox", () => {
  it("replays a saved decision menu and validates a new LegalAction.id", async () => {
    const rootDir = await writeRunWithDecisions([
      decisionLine({
        sequence: 11,
        selectedLegalActionId: "alliance:old",
        selectedActionKind: "alliance_request",
      }),
    ]);
    const captured: { body?: Record<string, unknown> } = {};

    try {
      const input = normalizeExternalAgentReplaySandboxInput({
        endpointUrl: "https://1.1.1.1/proxywar/decide",
        token: "sandbox-token",
        timeoutMs: "1000",
        runID: "sandbox-run",
        sequence: "11",
        runsRootDir: rootDir,
        fetchFn: async (_url, init) => {
          captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
          expect((init.headers as Record<string, string>).authorization).toBe(
            "Bearer sandbox-token",
          );
          expect(
            (init.headers as Record<string, string>)[
              "x-proxywar-replay-sandbox"
            ],
          ).toBe("true");
          return new Response(
            JSON.stringify({
              selectedLegalActionId: "build:City:123",
              reason: "The replay menu offered a safe economy build.",
              confidence: 0.81,
            }),
            { status: 200 },
          );
        },
      });

      const result = await replayExternalAgentDecision(input);

      expect(result).toMatchObject({
        ok: true,
        runID: "sandbox-run",
        sequence: 11,
        originalSelectedLegalActionId: "alliance:old",
        selectedLegalActionId: "build:City:123",
        selectedActionKind: "build",
        changedSelection: true,
        confidence: 0.81,
      });
      expect(result.offeredLegalActionIDs).toEqual(
        expect.arrayContaining(["build:City:123", "hold"]),
      );
      expect(captured.body?.protocolVersion).toBe("proxywar-agent-v1");
      expect(captured.body?.replaySandbox).toMatchObject({
        runID: "sandbox-run",
        sequence: 11,
      });
      expect(
        (captured.body?.legalActions as Array<Record<string, unknown>>).map(
          (action) => action.id,
        ),
      ).toContain("build:City:123");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown ids without pretending the sandbox passed", async () => {
    const rootDir = await writeRunWithDecisions([decisionLine({ sequence: 5 })]);
    try {
      const input = normalizeExternalAgentReplaySandboxInput({
        endpointUrl: "https://1.1.1.1/proxywar/decide",
        runID: "sandbox-run",
        sequence: 5,
        runsRootDir: rootDir,
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              selectedLegalActionId: "invented-action",
              reason: "This id was not offered.",
            }),
            { status: 200 },
          ),
      });

      const result = await replayExternalAgentDecision(input);

      expect(result.ok).toBe(false);
      expect(result.failureReason).toContain("unknown selectedLegalActionId");
      expect(result.coaching).toContain("Fix this sandbox response");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates run id, sequence, and token references", () => {
    expect(() =>
      normalizeExternalAgentReplaySandboxInput({
        endpointUrl: "https://1.1.1.1/proxywar/decide",
        runID: "../bad",
        sequence: 1,
      }),
    ).toThrow(/Run id is invalid/);
    expect(() =>
      normalizeExternalAgentReplaySandboxInput({
        endpointUrl: "https://1.1.1.1/proxywar/decide",
        runID: "sandbox-run",
        sequence: "nope",
      }),
    ).toThrow(/Decision sequence/);
    expect(() =>
      normalizeExternalAgentReplaySandboxInput({
        endpointUrl: "https://1.1.1.1/proxywar/decide",
        runID: "sandbox-run",
        sequence: 1,
        token: "env:PROXYWAR_AGENT_TOKEN",
      }),
    ).toThrow(/operator-only/);
  });
});

async function writeRunWithDecisions(lines: string[]): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "replay-sandbox-"));
  const runDir = path.join(rootDir, "sandbox-run");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "decisions.jsonl"), `${lines.join("\n")}\n`);
  return rootDir;
}

function decisionLine(input: {
  sequence: number;
  selectedLegalActionId?: string;
  selectedActionKind?: string;
}): string {
  return JSON.stringify({
    runID: "sandbox-run",
    matchID: "AGENT002",
    sequence: input.sequence,
    turnNumber: 351,
    agentID: "external-agent-1",
    username: "Replay Nation",
    profile: "diplomatic",
    observationSummary:
      "diplomatic Replay Nation: active, repeat=alliance_requestx1, builds=2",
    strategicSummary: "priority=ally, economy=0.85",
    memorySummary: "recent=spawn,alliance_request; repeat=alliance_requestx1",
    objectiveSummary: "Build alliance network; legal alternatives available",
    legalActionIDsByKind: {
      attack: ["expand:terra-nullius:10"],
      build: ["build:City:123"],
      alliance_request: ["alliance:old"],
      hold: ["hold"],
    },
    selectedLegalActionId: input.selectedLegalActionId ?? "hold",
    selectedActionKind: input.selectedActionKind ?? "hold",
  });
}
