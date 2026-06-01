import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { GameMapSize, GameMapType } from "../../src/core/game/Game";
import type { Game } from "../../src/core/game/Game";
import {
  buildAgentSpectatorReplay,
  writeAgentSpectatorReplayArtifacts,
} from "../../src/server/agents/AgentSpectatorReplay";

describe("AgentSpectatorReplay", () => {
  it("writes a read-only static spectator replay artifact", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-spectator-"));
    const replay = buildAgentSpectatorReplay({
      runID: "spectator-run",
      matchID: "SPECTATE1",
      scenario: "actions",
      brainMode: "mock-llm",
      runnerMode: "step-locked",
      finalGameState: fakeGame(),
      roster: [
        {
          agentID: "agent-1",
          username: "Spectator Agent",
          profile: "defensive",
          clientID: "CLIENT01",
          brainType: "mock-llm",
        },
      ],
      snapshots: [
        {
          label: "After spawn",
          turnNumber: 4,
          tick: 40,
          phase: "active",
          decisions: [
            {
              sequence: 1,
              agentID: "agent-1",
              username: "Spectator Agent",
              profile: "defensive",
              brainType: "mock-llm",
              turnNumber: 4,
              selectedLegalActionId: "build:Defense Post:10",
              selectedActionKind: "build",
              reason: "Build a defensive point near owned territory.",
              decisionLatencyMs: 33,
              accepted: true,
              resultReason: "accepted",
              fallbackUsed: false,
              auditStatus: "confirmed",
              auditReason: "build was visible in the after snapshot",
              objectiveKind: "fortify_border",
              objectiveSummary: "Fortify border (active)",
              planObjective: "fortify_border",
              planRationale: "Build local defense.",
              planFollowed: true,
              selectedSkill: "defense_building",
              selectedSkillScore: 94,
              skillSummary: "build:Defense Post:10:94/defense_building",
              intentSummary: '{"type":"build_unit"}',
            },
            {
              sequence: 2,
              agentID: "agent-1",
              username: "Spectator Agent",
              profile: "defensive",
              brainType: "mock-llm",
              turnNumber: 4,
              selectedLegalActionId: "quick_chat:RIVAL001:attack.focus",
              selectedActionKind: "quick_chat",
              reason: "Signal a public focus target.",
              decisionLatencyMs: 12,
              accepted: true,
              resultReason: "accepted",
              fallbackUsed: false,
              auditStatus: "not_applicable",
              auditReason: "quick chat has no durable strategic state",
              intentSummary: '{"type":"quick_chat"}',
              socialText: "Focus fire on Rival!",
              socialTargetName: "Rival",
            },
          ],
          players: [
            {
              agentID: "agent-1",
              clientID: "CLIENT01",
              playerID: "PLAYER01",
              username: "Spectator Agent",
              profile: "defensive",
              brainType: "mock-llm",
              color: "#2563eb",
              isAlive: true,
              hasSpawned: true,
              tilesOwned: 3,
              troops: 500,
              gold: "1000",
              tiles: [10, 11, 12],
              units: [],
            },
          ],
        },
      ],
    });

    try {
      const paths = await writeAgentSpectatorReplayArtifacts({
        directory: rootDir,
        replay,
      });

      const data = JSON.parse(
        await fs.readFile(paths.replayDataPath, "utf8"),
      ) as typeof replay;
      expect(data).toMatchObject({
        readOnly: true,
        spectatorOccupiesPlayerSlot: false,
        replayKind: "artifact-snapshot-replay",
      });

      const html = await fs.readFile(paths.spectatorPath, "utf8");
      const embeddedReplayJson = html.match(
        /<script id="spectator-data" type="application\/json">([^<]*)<\/script>/,
      )?.[1];
      expect(embeddedReplayJson).toBeTruthy();
      expect(JSON.parse(embeddedReplayJson ?? "{}")).toMatchObject({
        runID: "spectator-run",
        snapshots: [{ label: "After spawn" }],
      });
      expect(embeddedReplayJson).not.toContain("&quot;");
      expect(html).toContain("ProxyWar Spectator");
      expect(html).toContain("spectator occupies no player slot");
      expect(html).toContain("Decision Timeline");
      expect(html).toContain("Current Frame Decisions");
      expect(html).toContain("Selected Decision");
      expect(html).toContain("Follow all agents");
      expect(html).toContain("Action filters");
      expect(html).toContain("Replay speed");
      expect(html).toContain('id="speed"');
      expect(html).toContain("speedOptions");
      expect(html).toContain("selectCurrentFrameDecisionIfNeeded");
      expect(html).toContain("No decisions on this frame");
      expect(html).toContain('get("frame")');
      expect(html).toContain('frameParam === "last"');
      expect(html).toContain("build:Defense Post:10");
      expect(html).toContain("chat-bubble");
      expect(html).toContain("Focus fire on Rival!");
      expect(html).toContain("renderSocialBubbles");
      expect(html).toContain("defense_building");
      expect(html).toContain("Skill alternatives");
      expect(html).toContain("opens no socket");
      expect(html).toContain("real ProxyWar renderer");
      expect(html).not.toContain("new WebSocket");
      expect(html).not.toContain("fetch(");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

function fakeGame(): Game {
  return {
    width: () => 20,
    height: () => 10,
    config: () => ({
      gameConfig: () => ({
        gameMap: GameMapType.Asia,
        gameMapSize: GameMapSize.Compact,
      }),
    }),
  } as unknown as Game;
}
