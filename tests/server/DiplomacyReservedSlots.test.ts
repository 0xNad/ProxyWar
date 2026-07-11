import { describe, expect, it } from "vitest";

import {
  LegalActionBuilder,
  reservedQuotaTruncate,
} from "../../src/server/agents/LegalActionBuilder";
import type { LegalAction } from "../../src/server/agents/AgentTypes";

function action(id: string, kind: LegalAction["kind"]): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: null,
    risk: { level: "low", score: 0.1 },
  } as unknown as LegalAction;
}

describe("diplomacy reserved slots (PROXYWAR_TUNE_DIPLOMACY_SLOTS)", () => {
  it("reservedQuotaTruncate keeps diplomacy under the cap and preserves order", () => {
    const actions: LegalAction[] = [];
    for (let i = 0; i < 100; i++) {
      actions.push(action(`attack:${i}`, "attack"));
    }
    for (let i = 0; i < 5; i++) {
      actions.push(action(`alliance:${i}`, "alliance_request"));
    }
    const result = reservedQuotaTruncate(actions, 96, 8);
    expect(result).toHaveLength(96);
    const kept = result.filter((a) => a.kind === "alliance_request");
    // all 5 diplomacy actions survive (5 < reserve 8)
    expect(kept.map((a) => a.id)).toEqual([
      "alliance:0",
      "alliance:1",
      "alliance:2",
      "alliance:3",
      "alliance:4",
    ]);
    // the other 91 slots are the first attacks, order preserved
    const attacks = result.filter((a) => a.kind === "attack");
    expect(attacks).toHaveLength(91);
    expect(attacks[0].id).toBe("attack:0");
    expect(attacks[90].id).toBe("attack:90");
  });

  it("reserve is a ceiling, not a floor: excess diplomacy is truncated too", () => {
    const actions: LegalAction[] = [];
    for (let i = 0; i < 90; i++) {
      actions.push(action(`attack:${i}`, "attack"));
    }
    for (let i = 0; i < 20; i++) {
      actions.push(action(`alliance:${i}`, "alliance_request"));
    }
    const result = reservedQuotaTruncate(actions, 96, 8);
    expect(result).toHaveLength(96);
    expect(result.filter((a) => a.kind === "alliance_request")).toHaveLength(8);
    expect(result.filter((a) => a.kind === "attack")).toHaveLength(88);
  });

  it("unused others-budget tops diplomacy up past the reserve (no wasted slots)", () => {
    const actions: LegalAction[] = [];
    for (let i = 0; i < 85; i++) {
      actions.push(action(`attack:${i}`, "attack"));
    }
    for (let i = 0; i < 20; i++) {
      actions.push(action(`alliance:${i}`, "alliance_request"));
    }
    const result = reservedQuotaTruncate(actions, 96, 8);
    expect(result).toHaveLength(96); // full menu, no wasted slots
    expect(result.filter((a) => a.kind === "attack")).toHaveLength(85);
    expect(result.filter((a) => a.kind === "alliance_request")).toHaveLength(11);
  });

  it("unused reserve returns to the other kinds", () => {
    const actions: LegalAction[] = [];
    for (let i = 0; i < 120; i++) {
      actions.push(action(`attack:${i}`, "attack"));
    }
    const result = reservedQuotaTruncate(actions, 96, 8);
    expect(result).toHaveLength(96);
    expect(result.every((a) => a.kind === "attack")).toBe(true);
  });

  it("flag OFF: crowded menus starve alliance_request exactly as before (regression pin of the defect)", () => {
    delete process.env.PROXYWAR_TUNE_DIPLOMACY_SLOTS;
    const menu = buildCrowdedMenu();
    expect(menu.filter((a) => a.kind === "alliance_request")).toHaveLength(0);
    expect(menu.length).toBeLessThanOrEqual(97); // 96 + hold
  });

  it("flag ON: alliance_request survives the crowded menu, cap respected", () => {
    process.env.PROXYWAR_TUNE_DIPLOMACY_SLOTS = "1";
    try {
      const menu = buildCrowdedMenu();
      const alliances = menu.filter((a) => a.kind === "alliance_request");
      expect(alliances.length).toBeGreaterThanOrEqual(1);
      expect(menu.length).toBeLessThanOrEqual(97); // 96 + hold
    } finally {
      delete process.env.PROXYWAR_TUNE_DIPLOMACY_SLOTS;
    }
  });
});

function buildCrowdedMenu(): LegalAction[] {
  // Synthetic active-phase observation: enough attack variants to blow the
  // 96 cap before the diplomacy section, plus rivals offering alliances.
  const visiblePlayers = [] as Array<Record<string, unknown>>;
  for (let i = 0; i < 40; i++) {
    visiblePlayers.push({
      playerID: `P${i}`,
      name: `Rival ${i}`,
      tilesOwned: 500,
      troops: 10000,
      isAlive: true,
      isAllied: false,
      isFriendly: false,
      canAttack: true,
      canRequestAlliance: i >= 37, // the LAST few rivals offer alliances
    });
  }
  const observation = {
    agentID: "agent-1",
    clientID: "client-1",
    username: "Agent",
    profile: "aggressive",
    gameID: "game-1",
    phase: "active",
    turnNumber: 100,
    tick: 1000,
    ownState: {
      isAlive: true,
      tilesOwned: 400,
      troops: 50000,
      gold: "1000",
      spawnTile: 1,
    },
    visiblePlayers,
    combat: { outgoingAttacks: [], incomingAttacks: [], attackOptions: [] },
    nonCombat: {
      buildOptions: [],
      upgradeOptions: [],
      boatOptions: [],
      allianceOptions: [],
      supportOptions: [],
      embargoOptions: [],
      quickChatOptions: [],
      emojiOptions: [],
    },
    strategic: null,
    memory: null,
    objective: null,
    recentDecisions: [],
    recentCommunications: [],
    notes: [],
  };
  return new LegalActionBuilder().build({
    observation: observation as never,
  });
}
