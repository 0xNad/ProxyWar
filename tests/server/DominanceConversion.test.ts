import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  FrontierPolicyExecutor,
  LlmAgentPlanner,
  PlannerExecutorAgentBrain,
} from "../../src/server/agents/AgentPlannerExecutor";
import {
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { LlmProvider } from "../../src/server/agents/LlmProvider";

/**
 * Dominance-conversion gate (PROXYWAR_TUNE_DOMINANCE_CONVERSION, keystone v6).
 * League evidence (R.189): a dominant agent kept receiving the growth hint —
 * which fires whenever ANY neutral land remains, with no share cap — and ordered
 * neutral expansion for hundreds of decisions instead of eliminating rivals.
 * These tests pin: flag OFF = shipped prompt/controls byte-identical; flag ON =
 * STRATEGIC_PICTURE always derived, DOMINANCE WINDOW block + strong-hint
 * pressure controls exactly when the dominance conditions hold.
 */

const FLAG = "PROXYWAR_TUNE_DOMINANCE_CONVERSION";

function visibleRival(over: Partial<AgentVisiblePlayer>): AgentVisiblePlayer {
  return {
    playerID: "RIVAL",
    clientID: "RIVAL",
    smallID: 9,
    name: "Rival",
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 100_000,
    maxTroops: 400_000,
    troopRatio: 0.25,
    gold: "1000",
    tilesOwned: 1000,
    tileShare: 0.1,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: true,
    canRequestAlliance: true,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 2.0,
    ...over,
  };
}

function dominantObservation(
  visiblePlayers: AgentVisiblePlayer[],
  ownTileShare = 0.3,
): AgentObservation {
  const base = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "DOM",
    turnNumber: 2000,
    phaseOverride: "active",
  });
  return {
    ...base,
    ownState: {
      playerID: "agent-1",
      clientID: null,
      smallID: 1,
      name: "Keystone",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 500_000,
      maxTroops: 800_000,
      troopRatio: 0.6,
      gold: "1000",
      tilesOwned: 3000,
      tileShare: ownTileShare,
      borderTiles: 120,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    },
    visiblePlayers,
  };
}

function legalActions(): LegalAction[] {
  return [
    {
      id: "expand:terra-nullius:10",
      kind: "attack",
      label: "Expand",
      intent: { type: "attack", targetID: null, troops: 100 },
      risk: { level: "low", score: 0.1 },
      metadata: { expansion: true },
    },
    {
      id: "attack:WEAK01:25",
      kind: "attack",
      label: "Attack Weakling with 25%",
      intent: { type: "attack", targetID: "WEAK01", troops: 100_000 },
      risk: { level: "medium", score: 0.3 },
      metadata: { targetID: "WEAK01", sharesBorder: true },
    },
    {
      id: "hold",
      kind: "hold",
      label: "Hold",
      intent: null,
      risk: { level: "none", score: 0 },
    },
  ];
}

async function capturePrompt(
  observation: AgentObservation,
): Promise<string> {
  const prompts: string[] = [];
  const provider: LlmProvider = {
    providerType: "codex-cli",
    async complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      return JSON.stringify({
        objective: "expand_territory",
        turnIntent: "growth",
        rationale: "test plan",
        maxDecisionCycles: 3,
        preferredActionKinds: ["attack", "hold"],
        enabledModules: ["expansion", "economy", "defense"],
        targetPlayerId: null,
        tacticalSettings: {
          reserveRatio: 0.35,
          triggerRatio: 0.55,
          expansionRatio: 0.15,
          maxConcurrentWars: 1,
          retreatThreshold: 0.35,
          maxActionsPerDecision: 4,
        },
      });
    },
  };
  const brain = new PlannerExecutorAgentBrain({
    profile: "aggressive",
    planner: new LlmAgentPlanner({
      provider,
      profile: "aggressive",
      plannerType: "codex-cli",
    }),
    executor: new FrontierPolicyExecutor("aggressive"),
    planEveryDecisionSteps: 3,
  });
  await brain.decide({ observation, legalActions: legalActions() });
  // A must_follow control (e.g. the base-floor gate) can reject the generic mock
  // plan and fire one repair call; the initial planner prompt is always first and
  // is the one these tests assert on.
  expect(prompts.length).toBeGreaterThanOrEqual(1);
  return prompts[0]!;
}

describe("dominance conversion (PROXYWAR_TUNE_DOMINANCE_CONVERSION)", () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[FLAG];
  });

  afterEach(() => {
    if (savedFlag === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = savedFlag;
    }
  });

  const strongRival = () =>
    visibleRival({
      playerID: "STRONG1",
      clientID: "STRONG1",
      name: "Strongest",
      tileShare: 0.1,
      troops: 200_000,
      relativeTroopRatio: 2.5,
    });
  const weakRival = () =>
    visibleRival({
      playerID: "WEAK01",
      clientID: "WEAK01",
      name: "Weakling",
      tileShare: 0.05,
      troops: 50_000,
      relativeTroopRatio: 10.0,
    });

  it("flag OFF (default): no picture, no window, growth hint unchanged", async () => {
    delete process.env[FLAG];
    const prompt = await capturePrompt(
      dominantObservation([strongRival(), weakRival()]),
    );
    expect(prompt).not.toContain("STRATEGIC_PICTURE");
    expect(prompt).not.toContain("DOMINANCE WINDOW");
    // Flag-OFF byte-identity: not even a null-valued brief key may appear.
    expect(prompt).not.toContain("dominanceWindow");
    expect(prompt).toContain("STRONG HINT: objective=expand_territory");
    // Shipped conservative lines keep their exact pre-flag wording.
    expect(prompt).toContain(
      "unless a pressure affordance is explicitly ready.",
    );
  });

  it("flag ON + dominant: picture, window block, pressure hint on the weakest attackable bordered rival", async () => {
    process.env[FLAG] = "1";
    const prompt = await capturePrompt(
      dominantObservation([strongRival(), weakRival()]),
    );
    expect(prompt).toContain("STRATEGIC_PICTURE: We hold 30% of the map");
    // Bordered rivals listed largest-first in the picture.
    expect(prompt.indexOf("Strongest holds 10%")).toBeGreaterThan(-1);
    expect(prompt.indexOf("Strongest holds 10%")).toBeLessThan(
      prompt.indexOf("Weakling holds 5%"),
    );
    expect(prompt).toContain("DOMINANCE WINDOW OPEN: we hold 30% of the map");
    // Target = weakest attackable bordered rival, not the strongest.
    expect(prompt).toContain("targetPlayerId WEAK01");
    expect(prompt).toContain("STRONG HINT: objective=pressure_rival");
    expect(prompt).toContain("targetPlayerId=WEAK01");
    expect(prompt).toContain("dominance window open");
    // Conservative lines carry the window carve-out.
    expect(prompt).toContain("or the DOMINANCE WINDOW above is open");
    // Binding-commitment ask rides the default-ON directive flag.
    expect(prompt).toContain("add a binding commitment on that target");
  });

  it("flag ON but NOT dominant (own share below ratio x strongest): picture only, growth hint kept", async () => {
    process.env[FLAG] = "1";
    const prompt = await capturePrompt(
      dominantObservation(
        [
          visibleRival({
            playerID: "BIG01",
            clientID: "BIG01",
            name: "Big",
            tileShare: 0.28,
          }),
          weakRival(),
        ],
        0.3, // 0.3 < 1.3 * 0.28
      ),
    );
    expect(prompt).toContain("STRATEGIC_PICTURE");
    expect(prompt).not.toContain("DOMINANCE WINDOW");
    expect(prompt).toContain("STRONG HINT: objective=expand_territory");
  });

  it("flag ON below the share floor: window stays closed", async () => {
    process.env[FLAG] = "1";
    const prompt = await capturePrompt(
      dominantObservation(
        [visibleRival({ playerID: "TINY1", name: "Tiny", tileShare: 0.02 })],
        0.08, // dominant ratio-wise, but below the 0.12 share floor
      ),
    );
    expect(prompt).not.toContain("DOMINANCE WINDOW");
  });

  it("flag ON: allied neighbors are excluded from dominance comparison and targeting", async () => {
    process.env[FLAG] = "1";
    const prompt = await capturePrompt(
      dominantObservation([
        // Big ALLY does not close the window and is never the target.
        visibleRival({
          playerID: "ALLY01",
          clientID: "ALLY01",
          name: "BigAlly",
          tileShare: 0.4,
          isAllied: true,
          isFriendly: true,
          relation: Relation.Friendly,
          canAttack: false,
        }),
        weakRival(),
      ]),
    );
    expect(prompt).toContain("DOMINANCE WINDOW OPEN");
    expect(prompt).toContain("targetPlayerId WEAK01");
    expect(prompt).not.toContain("targetPlayerId ALLY01");
  });

  it("flag ON: no attackable bordered rival keeps the window closed", async () => {
    process.env[FLAG] = "1";
    const prompt = await capturePrompt(
      dominantObservation([
        visibleRival({
          playerID: "FAR01",
          name: "Far",
          tileShare: 0.05,
          sharesBorder: false,
          canAttack: false,
        }),
      ]),
    );
    expect(prompt).not.toContain("DOMINANCE WINDOW");
  });
});
