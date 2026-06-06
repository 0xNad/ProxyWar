import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { writeAgentDemoIndex } from "../../src/server/agents/AgentDemoIndexWriter";
import { writeAgentLeagueRunArtifacts } from "../../src/server/agents/AgentDecisionLogWriter";
import { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";

describe("AgentDemoIndexWriter", () => {
  it("generates a static recent-run index with artifact links", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-demo-index-"));
    const runsRootDir = path.join(rootDir, "runs");
    const intent = {
      type: "embargo" as const,
      targetID: "TARGET01",
      action: "start" as const,
    };
    const record: AgentDecisionRecord = {
      sequence: 1,
      gameID: "INDEXGAME",
      agentID: "agent-1",
      clientID: "CLIENT01",
      username: "Diplomatic Agent",
      profile: "diplomatic",
      brainType: "mock-llm",
      turnNumber: 8,
      decidedAt: Date.UTC(2026, 0, 1),
      decisionLatencyMs: 25,
      observationSummary: "diplomatic Diplomatic Agent: embargo=1",
      legalActionIDs: ["embargo:TARGET01:start", "hold"],
      legalActionIDsByKind: {
        embargo: ["embargo:TARGET01:start"],
        hold: ["hold"],
      },
      attackActionIDs: [],
      chosenActionID: "embargo:TARGET01:start",
      chosenActionKind: "embargo",
      reason: "Apply pressure without opening combat.",
      chosenActionMetadata: {
        targetID: "TARGET01",
        targetName: "Target Agent",
      },
      intent,
      result: {
        accepted: true,
        reason: "accepted",
        submittedIntent: intent,
      },
      audit: {
        auditStatus: "confirmed",
        auditReason:
          "embargo accepted and after-state shows an outgoing embargo",
      },
    };

    try {
      await writeAgentLeagueRunArtifacts({
        rootDir: runsRootDir,
        runID: "index-run-1",
        matchID: "INDEXGAME",
        scenario: "actions",
        brainMode: "mock-llm",
        runnerMode: "step-locked",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 1),
        records: [record],
        roster: [
          {
            agentID: "agent-1",
            username: "Diplomatic Agent",
            profile: "diplomatic",
            clientID: "CLIENT01",
            brainType: "mock-llm",
          },
        ],
        spectatorReplay: {
          schemaVersion: 1,
          runID: "index-run-1",
          matchID: "INDEXGAME",
          scenario: "actions",
          brainMode: "mock-llm",
          runnerMode: "step-locked",
          readOnly: true,
          spectatorOccupiesPlayerSlot: false,
          replayKind: "artifact-snapshot-replay",
          map: {
            width: 20,
            height: 10,
            gameMap: "Asia",
            gameMapSize: "Compact",
          },
          roster: [
            {
              agentID: "agent-1",
              username: "Diplomatic Agent",
              profile: "diplomatic",
              clientID: "CLIENT01",
              brainType: "mock-llm",
            },
          ],
          snapshots: [
            {
              label: "Post-spawn cycle 1",
              turnNumber: 8,
              tick: 20,
              phase: "active",
              decisions: [],
              players: [],
            },
          ],
          notes: [],
        },
        finalState: {
          phase: "active",
          tick: 20,
          turnCount: 8,
          players: [
            {
              agentID: "agent-1",
              username: "Diplomatic Agent",
              profile: "diplomatic",
              playerID: "PLAYER1",
              isAlive: true,
              tilesOwned: 10,
              troops: 100,
              gold: "1000",
            },
          ],
        },
      });
      await fs.writeFile(
        path.join(runsRootDir, "index-run-1", "game-record.json"),
        JSON.stringify({ info: { gameID: "INDEXGAME" }, turns: [] }),
      );

      const { indexPath, runs } = await writeAgentDemoIndex({
        runsRootDir,
      });
      const html = await fs.readFile(indexPath, "utf8");

      expect(runs).toHaveLength(1);
      expect(runs[0]?.externalFeedbackPreview?.summary).toContain(
        "This run did not include external-http agents.",
      );
      expect(html).toContain("Proxy War Runs");
      expect(html).toContain("index-run-1");
      expect(html).toContain("mock-llm");
      expect(html).toContain("visual-report.html");
      expect(html).toContain("spectator.html");
      expect(html).toContain("Proxy War render");
      expect(html).toContain("1 snapshots");
      expect(html).toContain("Objective");
      expect(html).toContain("Story");
      expect(html).toContain("match-story.md");
      expect(html).toContain("match-package.html");
      expect(html).toContain("objective-scorecard.md");
      expect(html).toContain("decisions.jsonl");
      expect(html).toContain("Audit C / U / F");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("can render an empty index", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-demo-index-"));
    try {
      const { indexPath, runs } = await writeAgentDemoIndex({
        runsRootDir: rootDir,
      });
      expect(runs).toHaveLength(0);
      await expect(fs.readFile(indexPath, "utf8")).resolves.toContain(
        "No Proxy War runs",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("treats a compacted game-record stub as no rendered replay", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-demo-index-"));
    const runsRootDir = path.join(rootDir, "runs");
    const runDir = path.join(runsRootDir, "stub-run");
    await fs.mkdir(runDir, { recursive: true });
    try {
      await fs.writeFile(
        path.join(runDir, "match-summary.json"),
        JSON.stringify({
          runID: "stub-run",
          scenario: "actions",
          brainMode: "mock-llm",
          runnerMode: "step-locked",
          completedAt: "2026-01-02T00:00:00.000Z",
        }),
      );
      // The RangeError fallback in AgentSpectatorReplay writes this stub when the full
      // GameRecord is too large to serialize. The native renderer cannot replay it, so the
      // availability gate must report no rendered replay rather than a dead-end link.
      await fs.writeFile(
        path.join(runDir, "game-record.json"),
        JSON.stringify({
          compacted: true,
          reason: "Full native game-record.json was too large to serialize.",
          turnCount: 29701,
          gameID: "STUBGAME",
        }),
      );

      const { indexPath, runs } = await writeAgentDemoIndex({ runsRootDir });
      const html = await fs.readFile(indexPath, "utf8");

      expect(runs).toHaveLength(1);
      expect(runs[0]?.hasOpenFrontReplay).toBe(false);
      expect(html).not.toContain("/ai-league-replay/stub-run");
      expect(html).not.toContain("Proxy War render");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
