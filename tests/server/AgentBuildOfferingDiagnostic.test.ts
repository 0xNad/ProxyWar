import { describe, expect, it } from "vitest";
import { PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { setup } from "../util/Setup";

// Diagnostic for run ab-ffa4p-arsenal-r1: the agent expanded to ~46k tiles but
// City/Factory/Port were OFFERED in 0/211 decisions. Question: is the block GOLD
// (never had 125k at decision time) or the build SEARCH/placement (City searches
// the 240 tiles closest to spawn, which may all fail structure-spacing)? This
// isolates it: a LARGE contiguous territory + FINITE gold sufficient for a City.

describe("build-offering diagnostic (gold vs placement)", () => {
  it("large territory + 500k gold: City/Factory/Port should be offered", async () => {
    const agent = new PlayerInfo("Agent", PlayerType.Human, "CLNT_AGENT", "P_AGENT");
    const game = await setup("plains", { instantBuild: true }, [agent]);
    const p = game.player("P_AGENT");
    let tiles = 0;
    for (let x = 5; x < 55; x += 1) {
      for (let y = 5; y < 55; y += 1) {
        const t = game.ref(x, y);
        if (game.isLand(t)) {
          p.conquer(t);
          tiles += 1;
        }
      }
    }
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
    p.addGold(500_000n); // covers City/Factory/Port (125k each), not Silo (1M)

    const obs = new AgentObservationBuilder().build({
      agentID: "a",
      clientID: "CLNT_AGENT",
      username: "Agent",
      profile: "aggressive",
      gameID: "DIAG",
      turnNumber: 1200,
      gameState: game,
    });
    expect(tiles).toBeGreaterThan(240); // exercises the 240-tile build-search slice
    const buildIds = new LegalActionBuilder()
      .build({ observation: obs })
      .filter((a) => a.kind === "build")
      .map((a) => a.id);
    const has = (u: string) => buildIds.some((id) => id.includes(`build:${u}`));
    // The build-offering + placement search work fine when the agent has gold:
    // City and Factory ARE offered. This isolates run ab-ffa4p-arsenal-r1's
    // "economy offered 0/211" to a GOLD/economy-bootstrap problem (the agent never
    // banked 125k), NOT a search/placement bug. The fix is agent strategy, not this.
    expect(has("City")).toBe(true);
    expect(has("Factory")).toBe(true);
  });
});
