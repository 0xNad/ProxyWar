import {
  buildCommanderState,
  canonicalCommanderJson,
  fingerprintCommanderMaterialState,
  fingerprintExposedOptionSet,
  MAX_COMMANDER_CANONICAL_STRING_LENGTH,
  MAX_COMMANDER_PLAYER_ID_LENGTH,
  MAX_COMMANDER_RECENT_EVENT_LENGTH,
  MAX_COMMANDER_RECENT_EVENTS,
  MAX_COMMANDER_RIVALS,
} from "../../src/server/agents/CommanderStateBuilder";
import type {
  CommanderRecentEvent,
  CommanderState,
} from "../../src/server/agents/StrategicCommanderTypes";
import {
  BASELINE_CANARY,
  EVIDENCE_LEAK_CANARY,
  LOW_LEVEL_LABEL_CANARY,
  makeCommanderStage2Fixture,
  MINIMAP_CANARY,
  RAW_ATTACK_ACTION_ID,
  RAW_BUILD_ACTION_ID,
  RAW_EXPANSION_ACTION_ID,
  RAW_MENU_CANARY,
  TACTICAL_CANARY,
} from "./StrategicCommanderStage2TestHarness";

describe("CommanderStateBuilder Stage 2", () => {
  it("reprojects real Stage 1 options without executable provenance or observation leaks", () => {
    const fixture = makeCommanderStage2Fixture();
    const serialized = JSON.stringify(fixture.builtState.state);

    expect(
      fixture.strategicOptions.candidates.some((candidate) =>
        candidate.binding.alignedPrimaryActionIDs.includes(
          RAW_ATTACK_ACTION_ID,
        ),
      ),
    ).toBe(true);
    expect(fixture.legalActions.map((action) => action.id)).toContain(
      RAW_EXPANSION_ACTION_ID,
    );
    expect(fixture.builtState.state.options.length).toBeGreaterThan(0);
    expect(
      JSON.stringify(fixture.exposedOptions.map((option) => option.evidence)),
    ).toContain(EVIDENCE_LEAK_CANARY);
    expect(Object.keys(fixture.builtState.state).sort()).toEqual([
      "options",
      "plan",
      "recentEvents",
      "rivals",
      "self",
    ]);
    expectExactKeys(fixture.builtState.state.self, [
      "name",
      "profile",
      "phase",
      "turnNumber",
      "tick",
      "decisionSequence",
      "territoryRank",
      "alivePlayerCount",
      "troops",
      "maxTroops",
      "troopRatio",
      "gold",
      "tilesOwned",
      "tileShare",
      "borderTiles",
      "incomingAttacks",
      "outgoingAttacks",
      "structures",
    ]);
    expectExactKeys(fixture.builtState.state.self.structures, [
      "cities",
      "factories",
      "ports",
      "defensePosts",
      "samLaunchers",
    ]);
    for (const rival of fixture.builtState.state.rivals) {
      expectExactKeys(rival, [
        "playerID",
        "name",
        "isAlive",
        "isDisconnected",
        "troops",
        "tilesOwned",
        "tileShare",
        "sharesBorder",
        "isAllied",
        "attackedMeRecently",
        "iAmAttackingThem",
      ]);
    }
    for (const option of fixture.builtState.state.options) {
      expectExactKeys(option, [
        "id",
        "family",
        "targetPlayerID",
        "targetName",
        "evidence",
      ]);
      switch (option.family) {
        case "expand":
          expectExactKeys(option.evidence, [
            "neutralLandReachable",
            "neutralBoatReachable",
            "ownTroops",
            "ownTiles",
          ]);
          break;
        case "develop_economy":
          expectExactKeys(option.evidence, [
            "economicBuildAvailable",
            "economicUpgradeAvailable",
            "gold",
            "ownTiles",
          ]);
          break;
        case "pressure_rival":
          expectExactKeys(option.evidence, [
            "sharesBorder",
            "targetTroops",
            "targetTiles",
            "ownTroops",
            "targetIsAllied",
            "targetAttackedMeRecently",
          ]);
          break;
        case "survive":
          expectExactKeys(option.evidence, [
            "incomingAttackCount",
            "strongerBorderRivalCount",
            "ownTroops",
            "borderTiles",
          ]);
          break;
      }
    }

    for (const forbidden of [
      RAW_EXPANSION_ACTION_ID,
      RAW_BUILD_ACTION_ID,
      RAW_ATTACK_ACTION_ID,
      LOW_LEVEL_LABEL_CANARY,
      RAW_MENU_CANARY,
      BASELINE_CANARY,
      EVIDENCE_LEAK_CANARY,
      TACTICAL_CANARY,
      MINIMAP_CANARY,
      "UNBOUNDED_MEMORY_CANARY",
      "AVOID_RAW_ACTION_CANARY",
      "UNBOUNDED_RECENT_DECISION_CANARY",
      "OBJECTIVE_RECOMMENDATION_CANARY",
    ]) {
      expect(serialized, `must exclude ${forbidden}`).not.toContain(forbidden);
    }

    const keys = recursiveKeys(fixture.builtState.state);
    for (const forbiddenKey of [
      "binding",
      "alignedPrimaryActionIDs",
      "alignedSupportActionIDs",
      "evidenceLeakCanary",
      "totalScore",
      "policyScore",
      "skillScore",
      "recommendation",
      "risk",
      "metadata",
      "intent",
      "strategic",
      "memory",
      "objective",
      "tacticalAffordances",
      "spatial",
      "minimap",
      "recentDecisions",
      "deals",
      "economy",
    ]) {
      expect(keys, `must exclude key ${forbiddenKey}`).not.toContain(
        forbiddenKey,
      );
    }
  });

  it("preserves the Stage 1 exposure order in Commander-visible options", () => {
    const fixture = makeCommanderStage2Fixture();

    expect(fixture.builtState.state.options.map((option) => option.id)).toEqual(
      fixture.strategicOptions.record.exposedOptionIds,
    );
  });

  it("keeps every exposed target identifiable while bounding and canonically ordering rivals", () => {
    const fixture = makeCommanderStage2Fixture();
    const { rivals, options } = fixture.builtState.state;
    const rivalIDs = rivals.map((rival) => rival.playerID);
    const targetIDs = options
      .map((option) => option.targetPlayerID)
      .filter((id): id is string => id !== null);

    expect(rivals).toHaveLength(MAX_COMMANDER_RIVALS);
    expect(rivalIDs).toEqual(["P1", "P4", "P5", "P6", "P7", "P8"]);
    for (const targetID of targetIDs) {
      expect(rivalIDs).toContain(targetID);
    }
    expect(rivalIDs).not.toContain("P9");
    expect(rivals.find((rival) => rival.playerID === "P7")?.name).toBe(
      `Rival ${"N".repeat(41)}…`,
    );
    expect(rivals.find((rival) => rival.playerID === "P7")?.name).not.toContain(
      "\u0000",
    );
    expect(rivals.find((rival) => rival.playerID === "P7")?.name).not.toContain(
      "\u202e",
    );
  });

  it("bounds structures, strategic event arrays, and display strings", () => {
    const fixture = makeCommanderStage2Fixture();
    const { self, recentEvents } = fixture.builtState.state;

    expect(self.structures).toEqual({
      cities: 2,
      factories: 3,
      ports: 1,
      defensePosts: 4,
      samLaunchers: 1,
    });
    expect(Object.keys(self.structures)).not.toContain("missileSilos");
    expect(recentEvents).toHaveLength(MAX_COMMANDER_RECENT_EVENTS);
    expect(
      recentEvents.every(
        (event) => event.length <= MAX_COMMANDER_RECENT_EVENT_LENGTH,
      ),
    ).toBe(true);
    expect(recentEvents.at(-1)).toBe("P9 was eliminated");
  });

  it("projects a bounded inert current-plan snapshot without lifecycle behavior", () => {
    const fixture = makeCommanderStage2Fixture();
    const rebuilt = buildCommanderState({
      observation: fixture.observation,
      exposedOptions: fixture.exposedOptions,
      decisionSequence: 8,
      plan: {
        selectedStrategicOptionId: "pressure_rival:P9",
        family: "pressure_rival",
        targetPlayerID: "P9",
        horizonDecisions: 6,
        replanTriggers: ["option_appeared", "horizon_expiry"],
        progress: {
          decisionsExecuted: 2,
          tilesDelta: 17,
          troopsDelta: -900,
          newIncomingAttackerIDs: [
            "P9",
            "P8",
            "P7",
            "P6",
            "P5",
            "P4",
            "P3",
            "P9",
          ],
        },
      },
    });

    expect(rebuilt.state.plan).toEqual({
      selectedStrategicOptionId: "pressure_rival:P9",
      family: "pressure_rival",
      targetPlayerID: "P9",
      horizonDecisions: 6,
      replanTriggers: ["horizon_expiry", "option_appeared"],
      progress: {
        decisionsExecuted: 2,
        tilesDelta: 17,
        troopsDelta: -900,
        newIncomingAttackerIDs: ["P3", "P4", "P5", "P6", "P7", "P8"],
      },
    });
    expectExactKeys(rebuilt.state.plan!, [
      "selectedStrategicOptionId",
      "family",
      "targetPlayerID",
      "horizonDecisions",
      "replanTriggers",
      "progress",
    ]);
    expectExactKeys(rebuilt.state.plan!.progress, [
      "decisionsExecuted",
      "tilesDelta",
      "troopsDelta",
      "newIncomingAttackerIDs",
    ]);
    expect(recursiveKeys(rebuilt.state.plan)).not.toContain("intent");
    expect(rebuilt.state.rivals.map((rival) => rival.playerID)).toContain("P9");
  });

  it("is deterministic under irrelevant player, action, and combat-array ordering", () => {
    const forward = makeCommanderStage2Fixture();
    const reversed = makeCommanderStage2Fixture({ reverseSources: true });

    expect(reversed.builtState.state).toEqual(forward.builtState.state);
    expect(reversed.builtState.fingerprints).toEqual(
      forward.builtState.fingerprints,
    );
    expect(canonicalCommanderJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalCommanderJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it("separates option membership and bounded material-state fingerprints", () => {
    const fixture = makeCommanderStage2Fixture();
    const { state, fingerprints } = fixture.builtState;
    const fewerOptions = state.options.slice(0, -1);

    expect(fingerprintExposedOptionSet(fewerOptions)).not.toBe(
      fingerprints.exposedOptionSet,
    );
    expect(fingerprintExposedOptionSet([...state.options].reverse())).toBe(
      fingerprints.exposedOptionSet,
    );
    expect(
      materialFingerprint({ ...state, options: fewerOptions }, fixture),
    ).not.toBe(fingerprints.materialState);

    const materialChange = structuredClone(state);
    materialChange.self.troops += 1;
    expect(materialFingerprint(materialChange, fixture)).not.toBe(
      fingerprints.materialState,
    );
    const evidenceChange = structuredClone(state);
    const expand = evidenceChange.options.find(
      (option) => option.family === "expand",
    )!;
    if (expand.family !== "expand" || !("ownTiles" in expand.evidence)) {
      throw new Error("Expected expand option fixture");
    }
    expand.evidence.ownTiles += 1;
    expect(fingerprintExposedOptionSet(evidenceChange.options)).toBe(
      fingerprints.exposedOptionSet,
    );
    expect(materialFingerprint(evidenceChange, fixture)).toBe(
      fingerprints.materialState,
    );

    const irrelevantOrdering = structuredClone(state);
    irrelevantOrdering.rivals.reverse();
    irrelevantOrdering.options.reverse();
    expect(materialFingerprint(irrelevantOrdering, fixture)).toBe(
      fingerprints.materialState,
    );
    const eventChange = structuredClone(state);
    eventChange.recentEvents[0] = "territory 1→2 since plan start";
    expect(materialFingerprint(eventChange, fixture)).toBe(
      fingerprints.materialState,
    );
    expect(fingerprints.exposedOptionSet).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprints.materialState).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashes only the documented request and material projection", () => {
    const fixture = makeCommanderStage2Fixture();
    const { state, fingerprints } = fixture.builtState;

    const irrelevantMutations: Array<(value: CommanderState) => void> = [
      (value) => {
        value.self.tick = (value.self.tick ?? 0) + 1;
      },
      (value) => {
        value.self.gold = `${value.self.gold}0`;
      },
      (value) => {
        value.self.profile = "defensive";
      },
      (value) => {
        value.recentEvents[0] = "territory 1→2 since plan start";
      },
      (value) => {
        const expand = value.options.find(
          (option) => option.family === "expand",
        );
        if (expand === undefined || !("ownTiles" in expand.evidence)) {
          throw new Error("Expected expand option fixture");
        }
        expand.evidence.ownTiles += 1;
      },
      (value) => {
        value.plan = {
          selectedStrategicOptionId: "survive",
          family: "survive",
          targetPlayerID: null,
          horizonDecisions: 3,
          replanTriggers: [],
          progress: {
            decisionsExecuted: 1,
            tilesDelta: -5,
            troopsDelta: 100,
            newIncomingAttackerIDs: [],
          },
        };
      },
    ];
    for (const mutate of irrelevantMutations) {
      const mutated = structuredClone(state);
      mutate(mutated);
      expect(materialFingerprint(mutated, fixture)).toBe(
        fingerprints.materialState,
      );
    }

    const materialMutations: Array<(value: CommanderState) => void> = [
      (value) => {
        value.self.turnNumber += 1;
      },
      (value) => {
        value.self.decisionSequence += 1;
      },
      (value) => {
        value.self.troops += 1;
      },
      (value) => {
        value.self.tilesOwned += 1;
      },
      (value) => {
        value.self.incomingAttacks += 1;
      },
      (value) => {
        value.rivals[0]!.playerID = "P1_CHANGED";
      },
      (value) => {
        value.rivals[0]!.isAlive = !value.rivals[0]!.isAlive;
      },
      (value) => {
        value.rivals[0]!.tilesOwned += 1;
      },
      (value) => {
        value.rivals[0]!.sharesBorder = !value.rivals[0]!.sharesBorder;
      },
    ];
    for (const mutate of materialMutations) {
      const mutated = structuredClone(state);
      mutate(mutated);
      expect(materialFingerprint(mutated, fixture)).not.toBe(
        fingerprints.materialState,
      );
    }

    expect(
      fingerprintCommanderMaterialState({
        gameID: `${fixture.observation.gameID}_CHANGED`,
        agentID: fixture.observation.agentID,
        state,
      }),
    ).not.toBe(fingerprints.materialState);
    expect(
      fingerprintCommanderMaterialState({
        gameID: fixture.observation.gameID,
        agentID: `${fixture.observation.agentID}_CHANGED`,
        state,
      }),
    ).not.toBe(fingerprints.materialState);
  });

  it("rejects missing exposed targets instead of silently dropping context", () => {
    const fixture = makeCommanderStage2Fixture();
    const targetOption = fixture.exposedOptions.find(
      (option) => option.targetPlayerID !== null,
    );
    expect(targetOption).toBeDefined();
    fixture.observation.visiblePlayers =
      fixture.observation.visiblePlayers.filter(
        (rival) => rival.playerID !== targetOption!.targetPlayerID,
      );

    expect(() =>
      buildCommanderState({
        observation: fixture.observation,
        exposedOptions: [targetOption!],
        decisionSequence: 8,
      }),
    ).toThrow(/target is not visible/);
  });

  it("rejects arbitrary event prose and unbounded identifiers", () => {
    const fixture = makeCommanderStage2Fixture();
    expect(() =>
      buildCommanderState({
        observation: fixture.observation,
        exposedOptions: fixture.exposedOptions,
        decisionSequence: 8,
        recentEvents: [
          RAW_ATTACK_ACTION_ID,
        ] as unknown as CommanderRecentEvent[],
      }),
    ).toThrow(/unsupported kind/);

    fixture.observation.visiblePlayers.find(
      (rival) => rival.playerID === "P9",
    )!.playerID = "X".repeat(MAX_COMMANDER_PLAYER_ID_LENGTH + 1);
    expect(() =>
      buildCommanderState({
        observation: fixture.observation,
        exposedOptions: fixture.exposedOptions,
        decisionSequence: 8,
      }),
    ).toThrow(/bounded stable identifier/);

    expect(() =>
      canonicalCommanderJson(
        "X".repeat(MAX_COMMANDER_CANONICAL_STRING_LENGTH + 1),
      ),
    ).toThrow(/unbounded string/);
  });
});

function materialFingerprint(
  state: CommanderState,
  fixture: ReturnType<typeof makeCommanderStage2Fixture>,
): string {
  return fingerprintCommanderMaterialState({
    gameID: fixture.observation.gameID,
    agentID: fixture.observation.agentID,
    state,
  });
}

function recursiveKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(recursiveKeys);
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [
    ...Object.keys(record),
    ...Object.values(record).flatMap(recursiveKeys),
  ];
}

function expectExactKeys(value: object, expectedKeys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...expectedKeys].sort());
}
