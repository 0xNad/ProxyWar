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

  it("STRUCTURED_DEALS=1 alone (DIPLOMACY_SLOTS unset): crowded menu still retains deal_accept/deal_reject (regression pin of the auto-coupling fix)", () => {
    delete process.env.PROXYWAR_TUNE_DIPLOMACY_SLOTS;
    process.env.PROXYWAR_TUNE_STRUCTURED_DEALS = "1";
    try {
      const menu = buildCrowdedMenu(true);
      const dealActions = menu.filter((a) => a.kind.startsWith("deal_"));
      expect(dealActions.map((a) => a.kind).sort()).toEqual([
        "deal_accept",
        "deal_reject",
      ]);
      expect(menu.length).toBeLessThanOrEqual(97); // 96 + hold
    } finally {
      delete process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;
    }
  });

  it("both flags OFF: a live incoming deal proposal never appears on a crowded menu (flag-off invariance)", () => {
    delete process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;
    delete process.env.PROXYWAR_TUNE_DIPLOMACY_SLOTS;
    const menu = buildCrowdedMenu(true);
    expect(menu.filter((a) => a.kind.startsWith("deal_"))).toHaveLength(0);
    expect(menu.length).toBeLessThanOrEqual(97);
  });

  describe("reservedQuotaTruncate: deal_accept/deal_reject pair atomicity under pressure", () => {
    function dealPair(dealID: string): LegalAction[] {
      return [
        action(`deal_accept:${dealID}`, "deal_accept"),
        action(`deal_reject:${dealID}`, "deal_reject"),
      ];
    }
    // 5 alliance_request + 3 incoming deal pairs = 11 diplomacy entries,
    // over the default reserve of 8 — plus 200 non-diplomacy filler, in the
    // SAME relative order LegalActionBuilder assembles them (attacks, then
    // alliances, then deal pairs).
    const alliances = Array.from({ length: 5 }, (_, i) =>
      action(`alliance:${i}`, "alliance_request"),
    );
    const pair1 = dealPair("deal:P1:P_A:non_aggression_pact:1");
    const pair2 = dealPair("deal:P2:P_A:non_aggression_pact:1");
    const pair3 = dealPair("deal:P3:P_A:non_aggression_pact:1");
    const others = Array.from({ length: 200 }, (_, i) =>
      action(`attack:${i}`, "attack"),
    );
    const menu = [...others, ...alliances, ...pair1, ...pair2, ...pair3];

    it("a cutoff mid-pair (reserve=8) drops the whole pair, fills the cap from freed others, never splits accept from reject", () => {
      const result = reservedQuotaTruncate(menu, 96, 8);
      expect(result).toHaveLength(96);
      const ids = result.map((a) => a.id);
      // Only pair1 survives — the fix reduces the reserve's raw cutoff (8,
      // landing on accept2) to 7 rather than keep an unanswerable accept2.
      expect(ids.filter((id) => id.startsWith("deal_"))).toEqual([
        "deal_accept:deal:P1:P_A:non_aggression_pact:1",
        "deal_reject:deal:P1:P_A:non_aggression_pact:1",
      ]);
      expect(ids.filter((id) => id.startsWith("alliance:"))).toHaveLength(5);
      // Every kept accept has its matching reject and vice versa.
      for (const id of ids) {
        if (id.startsWith("deal_accept:")) {
          expect(ids).toContain(id.replace("deal_accept:", "deal_reject:"));
        }
        if (id.startsWith("deal_reject:")) {
          expect(ids).toContain(id.replace("deal_reject:", "deal_accept:"));
        }
      }
      // Order preserved: 89 freed-up attacks, then all 5 alliances, then pair1.
      expect(ids.slice(0, 89)).toEqual(others.slice(0, 89).map((a) => a.id));
      expect(ids.slice(89, 94)).toEqual(alliances.map((a) => a.id));
      expect(ids.slice(94)).toEqual(pair1.map((a) => a.id));
    });

    it("a cutoff landing after a complete pair (reserve=9) needs no adjustment", () => {
      const result = reservedQuotaTruncate(menu, 96, 9);
      expect(result).toHaveLength(96);
      const ids = result.map((a) => a.id);
      expect(ids.filter((id) => id.startsWith("deal_"))).toEqual([
        ...pair1.map((a) => a.id),
        ...pair2.map((a) => a.id),
      ]);
      expect(ids.filter((id) => id.startsWith("alliance:"))).toHaveLength(5);
    });

    it("flags OFF: this same deals block never reaches the menu, byte-identical to no deals at all", () => {
      delete process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;
      delete process.env.PROXYWAR_TUNE_DIPLOMACY_SLOTS;
      const withoutDeals = JSON.stringify(buildCrowdedMenu(false));
      const withDeals = JSON.stringify(buildCrowdedMenu(true));
      expect(withDeals).toBe(withoutDeals);
    });
  });
});

function buildCrowdedMenu(withDeals = false): LegalAction[] {
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
    // A real, answerable incoming deal proposal — only read by
    // LegalActionBuilder when PROXYWAR_TUNE_STRUCTURED_DEALS is on
    // (dealMetaActions() gates on `observation.deals !== undefined` AND
    // the flag), so `withDeals=false` callers stay byte-identical.
    ...(withDeals
      ? {
          deals: {
            incomingProposals: [
              {
                dealID: "deal:P0:agent-1:non_aggression_pact:90",
                proposerPlayerID: "P0",
                proposerName: "Rival 0",
                recipientPlayerID: "agent-1",
                recipientName: "Agent",
                terms: {
                  template: "non_aggression_pact",
                  durationSteps: 12,
                },
                proposedAtStep: 90,
                answerableThroughStep: 110,
              },
            ],
            outgoingProposals: [],
            proposalOptions: [],
            active: [],
            obligations: [],
          },
        }
      : {}),
  };
  return new LegalActionBuilder().build({
    observation: observation as never,
  });
}
