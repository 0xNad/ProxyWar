import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { loadAgentManifestsFromDirectory } from "../../src/server/agents/AgentManifest";

describe("AgentManifest", () => {
  it("keeps manifest-only runs at 3 to 8 agents but allows one saved tester manifest when house agents are explicit", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-manifest-"));
    try {
      await fs.writeFile(
        path.join(rootDir, "tester-agent.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            agentName: "Tester Agent",
            profile: "opportunistic",
            brainType: "rule",
          },
          null,
          2,
        ),
      );

      await expect(loadAgentManifestsFromDirectory(rootDir)).rejects.toThrow(
        "AI league manifest directories must contain 3 to 8 agents",
      );
      await expect(
        loadAgentManifestsFromDirectory(rootDir, {
          minAgents: 1,
          maxAgents: 7,
        }),
      ).resolves.toHaveLength(1);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
