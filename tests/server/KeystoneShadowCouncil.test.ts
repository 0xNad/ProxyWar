import { describe, expect, it, vi } from "vitest";

import {
  arbitrateKeystoneAction,
  buildKeystoneWorldModel,
  type KeystoneCouncilTiers,
  type KeystoneExpertDomain,
  type KeystoneExpertProposal,
} from "../../coworld-adapter/src/keystone-experts";
import {
  boundedKeystoneShadowCouncilTelemetryLine,
  KEYSTONE_SHADOW_COUNCIL_LOG_MAX_BYTES,
  KEYSTONE_SHADOW_COUNCIL_LOG_PREFIX,
  KEYSTONE_SHADOW_COUNCIL_METADATA_KEY,
  KEYSTONE_SHADOW_COUNCIL_METADATA_MAX_BYTES,
  KeystoneShadowCouncilExecutor,
  KeystoneShadowCouncilTelemetryAgentBrain,
  type KeystoneShadowCouncilTelemetry,
  type KeystoneShadowExperts,
} from "../../coworld-adapter/src/keystone-shadow-council";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type {
  AgentExecutionDecision,
  AgentExecutor,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  AgentGamePhase,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

const plan: StrategicPlan = {
  planID: "shadow-plan",
  objective: "expand_territory",
  targetPlayerId: null,
  rationale: "focused shadow test",
  startedAtTick: 0,
  maxDecisionCycles: 6,
  successCriteria: [],
  failureCriteria: [],
  preferredActionKinds: ["attack", "hold"],
  forbiddenActionKinds: [],
  plannerSource: "rule",
};

const bid = Object.freeze({
  expectedValueBP: 8_000,
  urgencyBP: 6_000,
  confidenceBP: 8_000,
  riskBP: 1_000,
  opportunityCostBP: 1_000,
});

function action(
  id: string,
  kind: LegalActionKind,
  metadata: LegalAction["metadata"] = {},
  intent: LegalAction["intent"] = null,
): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent,
    risk: { level: "low", score: 0.1 },
    metadata,
  };
}

function domainActions(): LegalAction[] {
  return [
    action("expand:neutral:35", "attack", {
      targetID: null,
      expansion: true,
      troopPercent: 35,
    }),
    action("build:city", "build", { unit: "City", role: "economic" }),
    action("attack:rival", "attack", {
      targetID: "RIVAL",
      troopPercent: 40,
    }),
    action("quick-chat:hello", "quick_chat"),
    action("hold:wait", "hold"),
  ];
}

function input(
  actions: LegalAction[] = domainActions(),
  options: {
    gameID?: string;
    turn?: number;
    phase?: AgentGamePhase;
    players?: readonly AgentVisiblePlayer[];
  } = {},
): AgentBrainInput {
  const observation = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: options.gameID ?? "SHADOW-A",
    turnNumber: options.turn ?? 2_000,
    phaseOverride: options.phase ?? "active",
  });
  return {
    observation: {
      ...observation,
      visiblePlayers: [...(options.players ?? observation.visiblePlayers)],
      combat: {
        ...observation.combat,
        canExpandIntoNeutral: actions.some(
          (candidate) => candidate.metadata?.expansion === true,
        ),
      },
    },
    legalActions: actions,
  };
}

function visiblePlayer(playerID: string): AgentVisiblePlayer {
  return {
    playerID,
    clientID: null,
    smallID: playerID.charCodeAt(0),
    name: playerID,
    type: PlayerType.Human,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 40_000,
    maxTroops: 80_000,
    troopRatio: 0.5,
    gold: "100000",
    tilesOwned: 50,
    tileShare: 0.2,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Hostile,
    canAttack: true,
    canRequestAlliance: true,
    canDonateGold: true,
    canDonateTroops: true,
    canEmbargo: true,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 1.25,
  };
}

function ownedInput(
  actions: LegalAction[] = domainActions(),
  options: {
    gameID?: string;
    turn?: number;
    phase?: AgentGamePhase;
    players?: readonly AgentVisiblePlayer[];
  } = {},
): AgentBrainInput {
  const current = input(actions, options);
  return {
    observation: {
      ...current.observation,
      ownState: {
        playerID: "ME",
        clientID: null,
        smallID: 1,
        name: "Keystone",
        type: PlayerType.Nation,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 75_000,
        maxTroops: 100_000,
        troopRatio: 0.75,
        gold: "250000",
        tilesOwned: 80,
        tileShare: 0.3,
        borderTiles: 12,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
        team: null,
      },
    },
    legalActions: current.legalActions,
  };
}

function pressuredInput(actions: LegalAction[]): AgentBrainInput {
  const current = input(actions);
  return {
    observation: {
      ...current.observation,
      ownState: {
        playerID: "ME",
        clientID: null,
        smallID: 1,
        name: "Keystone",
        type: PlayerType.Nation,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 75_000,
        maxTroops: 100_000,
        troopRatio: 0.75,
        gold: "250000",
        tilesOwned: 80,
        tileShare: 0.3,
        borderTiles: 12,
        outgoingAttacks: 0,
        incomingAttacks: 1,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
        team: null,
      },
      combat: {
        ...current.observation.combat,
        ownTroops: 75_000,
        maxTroops: 100_000,
        troopRatio: 0.75,
        incomingAttackPlayerIDs: ["AGGRESSOR"],
      },
    },
    legalActions: actions,
  };
}

function proposal(
  source: KeystoneExpertDomain,
  actionID: string,
  overrides: Partial<KeystoneExpertProposal> = {},
): KeystoneExpertProposal {
  return Object.freeze({
    proposalID: `${source}:${actionID}`,
    actionID,
    source,
    rationale: "focused shadow proposal",
    ...bid,
    ...overrides,
  });
}

function experts(
  overrides: Partial<KeystoneShadowExperts> = {},
): KeystoneShadowExperts {
  return {
    expansion: () => null,
    economy: () => null,
    conquest: () => null,
    politics: () => null,
    ...overrides,
  };
}

function delegate(
  decision: AgentExecutionDecision,
): AgentExecutor & { decide: ReturnType<typeof vi.fn> } {
  return { decide: vi.fn(() => decision) };
}

function tiers(
  expertAuction: readonly KeystoneExpertProposal[],
): KeystoneCouncilTiers {
  return {
    spawn: [],
    survival: [],
    bindingDirective: [],
    expertAuction,
  };
}

describe("Keystone shadow expert council", () => {
  it("routes the real spawn proposer through the spawn tier without changing authority", () => {
    const actions = [
      {
        ...action("spawn:risky", "spawn"),
        risk: { level: "high" as const, score: 0.8 },
      },
      {
        ...action("spawn:safe", "spawn"),
        risk: { level: "low" as const, score: 0.2 },
      },
      action("hold:wait", "hold"),
    ];
    const authoritative = Object.freeze({
      actionID: "spawn:risky",
      actionIDs: ["spawn:risky"],
      reason: "v16 spawn authority",
      planFollowed: true,
      executorSource: "frontier-policy",
    });
    const authority = delegate(authoritative);
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: authority,
      actionFollowsCanonicalPlan: () => false,
      experts: experts(),
      logLine: () => undefined,
    });

    expect(
      shadow.decide(input(actions, { phase: "spawn", turn: 0 }), plan),
    ).toBe(authoritative);
    expect(authority.decide).toHaveBeenCalledOnce();
    expect(shadow.latestTelemetry()).toMatchObject({
      winner: {
        tier: "spawn",
        source: "spawn",
        actionID: "spawn:safe",
      },
      agreement: "disagree",
      proposals: [
        {
          domain: null,
          source: "spawn",
          actionID: "spawn:safe",
        },
      ],
      exposure: {
        proposalMask: 16,
        proposalCount: 1,
        enabledExpertMask: 15,
      },
    });
  });

  it("routes the real survival proposer ahead of experts without changing authority", () => {
    const actions = [
      action("retreat:land", "retreat"),
      action("expand:neutral:35", "attack", {
        targetID: null,
        expansion: true,
        troopPercent: 35,
      }),
      action("hold:wait", "hold"),
    ];
    const authoritative = Object.freeze({
      actionID: "expand:neutral:35",
      actionIDs: ["expand:neutral:35", "hold:wait"],
      reason: "v16 pressure authority",
      planFollowed: true,
      executorSource: "frontier-policy",
    });
    const authority = delegate(authoritative);
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: authority,
      actionFollowsCanonicalPlan: () => false,
      logLine: () => undefined,
    });

    expect(shadow.decide(pressuredInput(actions), plan)).toBe(authoritative);
    expect(authority.decide).toHaveBeenCalledOnce();
    expect(shadow.latestTelemetry()).toMatchObject({
      winner: {
        tier: "survival",
        source: "survival",
        actionID: "retreat:land",
      },
      agreement: "disagree",
    });
    expect(shadow.latestTelemetry()?.proposals).toContainEqual(
      expect.objectContaining({
        domain: null,
        source: "survival",
        actionID: "retreat:land",
      }),
    );
    expect(shadow.latestTelemetry()!.exposure.proposalMask & 32).toBe(32);
  });

  it.each([
    {
      name: "attack",
      currentPlan: {
        ...plan,
        commitment: { targetPlayerId: "RIVAL", minAttackRatio: 0.25 },
      } satisfies StrategicPlan,
      exactAction: action("attack:RIVAL:30", "attack", {
        targetID: "RIVAL",
        troopPercent: 30,
      }),
      exactActionID: "attack:RIVAL:30",
      players: [visiblePlayer("RIVAL")],
    },
    {
      name: "alliance",
      currentPlan: {
        ...plan,
        allianceDirective: {
          stance: "seek_alliance" as const,
          targetPlayerId: "ALLY",
        },
      } satisfies StrategicPlan,
      exactAction: action("alliance_request:ALLY", "alliance_request", {
        targetID: "ALLY",
      }),
      exactActionID: "alliance_request:ALLY",
      players: [visiblePlayer("ALLY")],
    },
    {
      name: "build",
      currentPlan: {
        ...plan,
        buildDirective: { unit: "City" as const },
      } satisfies StrategicPlan,
      exactAction: action("build:city", "build", {
        unit: "City",
        role: "economic",
      }),
      exactActionID: "build:city",
      players: [] as AgentVisiblePlayer[],
    },
  ])(
    "binds only an offered $name id, then records unavailable and falls through when it disappears",
    ({ currentPlan, exactAction, exactActionID, players }) => {
      const fallbackActions = [
        action("expand:neutral:35", "attack", {
          targetID: null,
          expansion: true,
          troopPercent: 35,
        }),
        action("hold:wait", "hold"),
      ];
      const authoritative = Object.freeze({
        actionID: "hold:wait",
        actionIDs: ["hold:wait"],
        reason: "v16 remains authoritative",
        planFollowed: false,
        executorSource: "frontier-policy",
      });
      const shadow = new KeystoneShadowCouncilExecutor({
        delegate: delegate(authoritative),
        actionFollowsCanonicalPlan: () => false,
        experts: experts({
          expansion: () =>
            proposal("expansion", "expand:neutral:35", {
              commitmentKey: "expansion:neutral-land",
              horizonDecisions: 2,
            }),
        }),
        logLine: () => undefined,
      });

      expect(
        shadow.decide(
          ownedInput([...fallbackActions, exactAction], {
            turn: 2_000,
            players,
          }),
          currentPlan,
        ),
      ).toBe(authoritative);
      expect(shadow.latestTelemetry()).toMatchObject({
        directive: { status: "proposed" },
        winner: {
          tier: "binding_directive",
          source: "binding_directive",
          actionID: exactActionID,
        },
        operational: {
          record: {
            reason: "higher_tier_selected",
            after: { key: null, remainingDecisions: 0 },
          },
        },
      });
      expect(shadow.latestTelemetry()!.exposure.proposalMask & 64).toBe(64);

      const absentInput = ownedInput(fallbackActions, {
        turn: 2_001,
        players,
      });
      expect(shadow.decide(absentInput, currentPlan)).toBe(authoritative);
      const absent = shadow.latestTelemetry()!;
      expect(absent).toMatchObject({
        directive: { status: "unavailable" },
        winner: {
          tier: "expert_auction",
          source: "expansion",
          actionID: "expand:neutral:35",
        },
        operational: {
          preparation: {
            reason: "commander_binding",
            after: { key: null, remainingDecisions: 0 },
          },
          record: {
            reason: "commander_binding",
            after: { key: null, remainingDecisions: 0 },
          },
        },
      });
      const offeredIDs = new Set(absentInput.legalActions.map(({ id }) => id));
      expect(
        absent.proposals.every(({ actionID }) => offeredIDs.has(actionID)),
      ).toBe(true);
      expect(
        absent.proposals.some(({ actionID }) => actionID === exactActionID),
      ).toBe(false);
      expect(absent.exposure.proposalMask & 64).toBe(0);
    },
  );

  it("keeps no-proposal hold fallback diagnostic-only", () => {
    const actions = [
      action("quick-chat:authoritative", "quick_chat"),
      action("hold:diagnostic", "hold"),
    ];
    const authoritative = Object.freeze({
      actionID: "quick-chat:authoritative",
      actionIDs: ["quick-chat:authoritative"],
      reason: "v16 communication authority",
      planFollowed: false,
      executorSource: "frontier-policy",
    });
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate(authoritative),
      actionFollowsCanonicalPlan: () => false,
      experts: experts(),
      logLine: () => undefined,
    });

    expect(shadow.decide(input(actions), plan)).toBe(authoritative);
    expect(shadow.latestTelemetry()).toMatchObject({
      proposals: [],
      winner: {
        tier: "hold",
        source: "fallback",
        actionID: "hold:diagnostic",
      },
      agreement: "disagree",
      exposure: { proposalMask: 0, proposalCount: 0 },
    });
  });

  it("builds one frozen world and calls every expert once in fixed order", () => {
    const calls: KeystoneExpertDomain[] = [];
    const worlds: unknown[] = [];
    const makeExpert =
      (domain: KeystoneExpertDomain, actionID: string) =>
      (world: Parameters<KeystoneShadowExperts["expansion"]>[0]) => {
        calls.push(domain);
        worlds.push(world);
        expect(Object.isFrozen(world)).toBe(true);
        expect(Object.isFrozen(world.actions)).toBe(true);
        return proposal(domain, actionID);
      };
    const authoritative = Object.freeze({
      actionID: "hold:wait",
      actionIDs: ["hold:wait", "build:city"],
      reason: "authoritative identity",
      planFollowed: false,
      executorSource: "frontier-policy",
      actionSelectionSource: "frontier-policy:growth",
    });
    const authority = delegate(authoritative);
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: authority,
      actionFollowsCanonicalPlan: () => false,
      experts: {
        expansion: makeExpert("expansion", "expand:neutral:35"),
        economy: makeExpert("economy", "build:city"),
        conquest: makeExpert("conquest", "attack:rival"),
        politics: makeExpert("politics", "quick-chat:hello"),
      },
      logLine: () => undefined,
    });

    const selected = shadow.decide(input(), {
      ...plan,
      buildDirective: { unit: "Port" },
    });

    expect(selected).toBe(authoritative);
    expect(authority.decide).toHaveBeenCalledOnce();
    expect(calls).toEqual(["expansion", "economy", "conquest", "politics"]);
    expect(worlds).toHaveLength(4);
    expect(worlds.every((world) => world === worlds[0])).toBe(true);
    const sharedWorld = worlds[0] as Parameters<
      KeystoneShadowExperts["expansion"]
    >[0];
    expect(sharedWorld.commander).toEqual({
      planID: "shadow-plan",
      binding: { kind: "build", domain: "economy", unit: "port" },
    });
    expect(Object.isFrozen(sharedWorld.commander)).toBe(true);
    expect(Object.isFrozen(sharedWorld.commander.binding)).toBe(true);
    expect(shadow.latestTelemetry()).toMatchObject({
      health: "healthy",
      exposure: { proposalMask: 15, errorMask: 0, proposalCount: 4 },
    });
    expect(
      shadow.latestTelemetry()?.proposals.map((candidate) => ({
        proposalID: candidate.proposalID,
        actionID: candidate.actionID,
      })),
    ).toEqual([
      {
        proposalID: "expansion:expand:neutral:35",
        actionID: "expand:neutral:35",
      },
      { proposalID: "economy:build:city", actionID: "build:city" },
      { proposalID: "conquest:attack:rival", actionID: "attack:rival" },
      {
        proposalID: "politics:quick-chat:hello",
        actionID: "quick-chat:hello",
      },
    ]);
    expect(
      shadow
        .latestTelemetry()
        ?.proposals.every((candidate) => candidate.bidBP === 7_125),
    ).toBe(true);
  });

  it.each([
    {
      name: "agreement",
      authoritativeActionID: "expand:neutral:35",
      expertSet: experts({
        expansion: () => proposal("expansion", "expand:neutral:35"),
      }),
      actions: domainActions(),
      expectedAgreement: "agree",
    },
    {
      name: "disagreement",
      authoritativeActionID: "hold:wait",
      expertSet: experts({
        expansion: () => proposal("expansion", "expand:neutral:35"),
      }),
      actions: domainActions(),
      expectedAgreement: "disagree",
    },
    {
      name: "abstention",
      authoritativeActionID: "expand:neutral:35",
      expertSet: experts(),
      actions: [
        action("expand:neutral:35", "attack", {
          targetID: null,
          expansion: true,
        }),
      ],
      expectedAgreement: "abstain",
    },
    {
      name: "rejection",
      authoritativeActionID: "hold:wait",
      expertSet: experts({
        expansion: () => proposal("expansion", "build:city"),
      }),
      actions: domainActions(),
      expectedAgreement: "agree",
    },
  ])(
    "keeps delegate action, batch, reason, and source unchanged under $name",
    ({ authoritativeActionID, expertSet, actions, expectedAgreement }) => {
      const authoritative = Object.freeze({
        actionID: authoritativeActionID,
        actionIDs: [authoritativeActionID, "hold:wait"],
        reason: "delegate reason must survive byte-for-byte",
        planFollowed: true,
        executorSource: "coworld-single-action-v1",
        actionSelectionSource: "coworld-single-action-v1:contact",
      });
      const authority = delegate(authoritative);
      const shadow = new KeystoneShadowCouncilExecutor({
        delegate: authority,
        actionFollowsCanonicalPlan: () => false,
        experts: expertSet,
        logLine: () => undefined,
      });

      expect(shadow.decide(input(actions), plan)).toBe(authoritative);
      expect(shadow.latestTelemetry()?.agreement).toBe(expectedAgreement);
      expect(shadow.latestTelemetry()?.health).toBe("healthy");
      if (authoritativeActionID === "hold:wait") {
        expect(shadow.latestTelemetry()?.authoritativeActionID).toBe(
          "hold:wait",
        );
      }
    },
  );

  it("isolates an expert exception by domain and never logs its text", () => {
    const logs: string[] = [];
    const calls: string[] = [];
    const authoritative = Object.freeze({
      actionID: "hold:wait",
      reason: "still authoritative",
      planFollowed: false,
      executorSource: "frontier-policy",
    });
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate(authoritative),
      actionFollowsCanonicalPlan: () => false,
      experts: {
        expansion: () => {
          calls.push("expansion");
          return null;
        },
        economy: () => {
          calls.push("economy");
          throw new Error("token=SUPER_SECRET https://private.invalid");
        },
        conquest: () => {
          calls.push("conquest");
          return proposal("conquest", "attack:rival");
        },
        politics: () => {
          calls.push("politics");
          return null;
        },
      },
      logLine: (line) => logs.push(line),
    });

    expect(shadow.decide(input(), plan)).toBe(authoritative);
    expect(calls).toEqual(["expansion", "economy", "conquest", "politics"]);
    expect(shadow.latestTelemetry()).toMatchObject({
      health: "partial",
      errorDomains: ["economy"],
      exposure: { errorMask: 2, proposalMask: 4 },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/SUPER_SECRET|private\.invalid|token=/);
  });

  it("isolates a system proposer failure without suppressing experts or authority", () => {
    const logs: string[] = [];
    const authoritative = Object.freeze({
      actionID: "hold:wait",
      actionIDs: ["hold:wait"],
      reason: "exact authority under system failure",
      planFollowed: false,
      executorSource: "frontier-policy",
    });
    const authority = delegate(authoritative);
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: authority,
      actionFollowsCanonicalPlan: () => false,
      experts: experts({
        economy: () => proposal("economy", "build:city"),
      }),
      systemProposers: {
        spawn: () => null,
        survival: () => {
          throw new Error("token=SYSTEM_SECRET https://system.invalid");
        },
      },
      logLine: (line) => logs.push(line),
    });

    expect(shadow.decide(input(), plan)).toBe(authoritative);
    expect(authority.decide).toHaveBeenCalledOnce();
    expect(shadow.latestTelemetry()).toMatchObject({
      health: "partial",
      systemErrorSources: ["survival"],
      winner: { source: "economy", actionID: "build:city" },
      exposure: {
        proposalMask: 2,
        errorMask: 0,
        systemErrorMask: 2,
      },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/SYSTEM_SECRET|system\.invalid|token=/);
  });

  it("invokes only enabled expert-mask domains and does not count disabled failures", () => {
    const expansion = vi.fn(() => proposal("expansion", "expand:neutral:35"));
    const economy = vi.fn(() => {
      throw new Error("disabled economy must not run");
    });
    const conquest = vi.fn(() => {
      throw new Error("enabled conquest failure");
    });
    const politics = vi.fn(() => {
      throw new Error("disabled politics must not run");
    });
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate({
        actionID: "hold:wait",
        reason: "authority",
        planFollowed: false,
      }),
      actionFollowsCanonicalPlan: () => false,
      enabledExpertMask: 5,
      experts: { expansion, economy, conquest, politics },
      logLine: () => undefined,
    });

    shadow.decide(input(), plan);

    expect(expansion).toHaveBeenCalledOnce();
    expect(conquest).toHaveBeenCalledOnce();
    expect(economy).not.toHaveBeenCalled();
    expect(politics).not.toHaveBeenCalled();
    expect(shadow.latestTelemetry()).toMatchObject({
      health: "partial",
      errorDomains: ["conquest"],
      exposure: {
        enabledExpertMask: 5,
        proposalMask: 1,
        errorMask: 4,
      },
    });
  });

  it.each([-1, 16, 1.5, Number.NaN])(
    "rejects invalid shadow expert mask %s at construction",
    (enabledExpertMask) => {
      expect(
        () =>
          new KeystoneShadowCouncilExecutor({
            delegate: delegate({
              actionID: "hold:wait",
              reason: "unused",
              planFollowed: false,
            }),
            actionFollowsCanonicalPlan: () => false,
            enabledExpertMask,
          }),
      ).toThrow(/integer from 0 to 15/);
    },
  );

  it("cannot turn alignment or logger failures into fallback behavior", () => {
    const authoritative = Object.freeze({
      actionID: "hold:wait",
      actionIDs: ["hold:wait"],
      reason: "exact authority",
      planFollowed: false,
      executorSource: "frontier-policy",
    });
    const authority = delegate(authoritative);
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: authority,
      actionFollowsCanonicalPlan: () => {
        throw new Error("alignment diagnostic failed");
      },
      experts: experts(),
      logLine: () => {
        throw new Error("stdout unavailable");
      },
    });

    expect(shadow.decide(input(), plan)).toBe(authoritative);
    expect(authority.decide).toHaveBeenCalledOnce();
    expect(shadow.latestTelemetry()).toMatchObject({
      health: "unavailable",
      agreement: "agree",
    });
  });

  it("resets ordinal state deterministically on game changes and turn regression", () => {
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate({
        actionID: "hold:wait",
        reason: "hold",
        planFollowed: true,
      }),
      actionFollowsCanonicalPlan: () => false,
      experts: experts(),
      logLine: () => undefined,
    });
    const snapshots: Array<
      Pick<KeystoneShadowCouncilTelemetry, "ordinal" | "reset" | "resetOrdinal">
    > = [];
    for (const current of [
      input(domainActions(), { gameID: "A", turn: 100 }),
      input(domainActions(), { gameID: "A", turn: 200 }),
      input(domainActions(), { gameID: "A", turn: 50 }),
      input(domainActions(), { gameID: "B", turn: 50 }),
    ]) {
      shadow.decide(current, plan);
      const latest = shadow.latestTelemetry()!;
      snapshots.push({
        ordinal: latest.ordinal,
        reset: latest.reset,
        resetOrdinal: latest.resetOrdinal,
      });
    }

    expect(snapshots).toEqual([
      { ordinal: 1, reset: true, resetOrdinal: 1 },
      { ordinal: 2, reset: false, resetOrdinal: 1 },
      { ordinal: 1, reset: true, resetOrdinal: 2 },
      { ordinal: 1, reset: true, resetOrdinal: 3 },
    ]);
  });

  it("reports runner-up and raw margin after soft plan bonus and action dedupe", () => {
    const actions = domainActions();
    const unaligned = proposal("expansion", "expand:neutral:35", {
      expectedValueBP: 9_000,
    });
    const aligned = proposal("economy", "build:city", {
      expectedValueBP: 7_000,
    });
    const duplicate = proposal("economy", "build:city", {
      proposalID: "economy:duplicate",
      expectedValueBP: 6_000,
    });
    const filteredWorld = buildKeystoneWorldModel(input(actions), {
      planAlignedActionIDs: ["build:city"],
    });
    const filtered = arbitrateKeystoneAction(
      filteredWorld,
      tiers([unaligned, aligned, duplicate]),
    );
    expect(filtered.selection?.actionID).toBe("expand:neutral:35");
    expect(filtered.runnerUp?.actionID).toBe("build:city");
    expect(filtered.bidMarginBP).toBe(1_000);
    expect(filtered.auction).toMatchObject({
      status: "inactive",
      planAlignmentBonusBP: 500,
      selectedRawBidBP: 7_625,
      selectedPlanBonusBP: 0,
      selectedAuctionScoreBP: 7_625,
    });
    expect(filtered.rejections).toContainEqual(
      expect.objectContaining({ reason: "duplicate_action_proposal" }),
    );

    const tieWorld = buildKeystoneWorldModel(input(actions));
    const tie = arbitrateKeystoneAction(
      tieWorld,
      tiers([
        proposal("expansion", "expand:neutral:35"),
        proposal("economy", "build:city"),
      ]),
    );
    expect(tie.selection?.actionID).toBe("build:city");
    expect(tie.runnerUp?.actionID).toBe("expand:neutral:35");
    expect(tie.bidMarginBP).toBe(0);

    const one = arbitrateKeystoneAction(
      tieWorld,
      tiers([proposal("economy", "build:city")]),
    );
    expect(one.runnerUp).toBeNull();
    expect(one.bidMarginBP).toBeNull();

    const held = arbitrateKeystoneAction(tieWorld, tiers([]));
    expect(held.disposition).toBe("hold");
    expect(held.runnerUp).toBeNull();
    expect(held.bidMarginBP).toBeNull();

    const abstained = arbitrateKeystoneAction(
      buildKeystoneWorldModel(
        input([action("attack:rival", "attack", { targetID: "RIVAL" })]),
      ),
      tiers([]),
    );
    expect(abstained.disposition).toBe("abstain");
    expect(abstained.runnerUp).toBeNull();
    expect(abstained.bidMarginBP).toBeNull();
  });

  it("separates raw bid, plan bonus, and auction score in shadow telemetry", () => {
    const authoritative = Object.freeze({
      actionID: "hold:wait",
      reason: "v16 authority",
      planFollowed: false,
    });
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate(authoritative),
      actionFollowsCanonicalPlan: ({ action: candidate }) =>
        candidate.id === "build:city",
      experts: experts({
        expansion: () =>
          proposal("expansion", "expand:neutral:35", {
            expectedValueBP: 8_200,
          }),
        economy: () => proposal("economy", "build:city"),
      }),
      logLine: () => undefined,
    });

    expect(shadow.decide(input(), plan)).toBe(authoritative);
    expect(shadow.latestTelemetry()).toMatchObject({
      winner: { actionID: "build:city" },
      auction: {
        status: "inactive",
        planAlignmentBonusBP: 500,
        selectedRawBidBP: 7_125,
        selectedPlanBonusBP: 500,
        selectedAuctionScoreBP: 7_625,
      },
    });
    expect(shadow.latestTelemetry()?.proposals).toContainEqual(
      expect.objectContaining({
        actionID: "build:city",
        bidBP: 7_125,
        planBonusBP: 500,
        auctionScoreBP: 7_625,
      }),
    );
  });

  it("reports bounded objective retention without extending its expiry", () => {
    const authoritative = Object.freeze({
      actionID: "hold:wait",
      reason: "v16 authority",
      planFollowed: false,
    });
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate(authoritative),
      actionFollowsCanonicalPlan: () => false,
      experts: experts({
        expansion: () =>
          proposal("expansion", "expand:neutral:35", {
            commitmentKey: "expansion:neutral-land",
            horizonDecisions: 2,
          }),
        economy: (world) =>
          proposal("economy", "build:city", {
            expectedValueBP: world.turnNumber === 2_000 ? 7_000 : 8_998,
            commitmentKey: "economy:city-foundation",
            horizonDecisions: 2,
          }),
      }),
      logLine: () => undefined,
    });

    expect(
      shadow.decide(ownedInput(domainActions(), { turn: 2_000 }), plan),
    ).toBe(authoritative);
    expect(shadow.latestTelemetry()).toMatchObject({
      winner: { actionID: "expand:neutral:35" },
      operational: {
        record: {
          reason: "armed",
          after: {
            source: "expansion",
            startedOrdinal: 1,
            expiresAfterOrdinal: 2,
            remainingDecisions: 2,
          },
        },
      },
    });

    expect(
      shadow.decide(ownedInput(domainActions(), { turn: 2_001 }), plan),
    ).toBe(authoritative);
    expect(shadow.latestTelemetry()).toMatchObject({
      winner: { actionID: "expand:neutral:35" },
      runnerUp: { actionID: "build:city" },
      bidMarginBP: -499,
      auction: {
        status: "retained",
        incumbentSource: "expansion",
        challengerAdvantageBP: 499,
        switchMarginBP: 500,
        selectedRawBidBP: 7_125,
        selectedPlanBonusBP: 0,
        selectedAuctionScoreBP: 7_125,
      },
      operational: {
        preparation: {
          reason: "none",
          after: { source: "expansion", remainingDecisions: 1 },
        },
        record: {
          reason: "retained",
          after: {
            source: "expansion",
            expiresAfterOrdinal: 2,
            remainingDecisions: 1,
          },
        },
      },
    });
    expect(shadow.latestTelemetry()?.auction?.incumbentKey).toMatch(
      /^hash:[0-9a-f]{16}$/,
    );
  });

  it("rejects out-of-range soft bonus and switch-margin configuration", () => {
    const options = {
      delegate: delegate({
        actionID: "hold:wait",
        reason: "v16 authority",
        planFollowed: false,
      }),
      actionFollowsCanonicalPlan: () => false,
      logLine: () => undefined,
    };
    expect(
      () =>
        new KeystoneShadowCouncilExecutor({
          ...options,
          planAlignmentBonusBP: -1,
        }),
    ).toThrow(/plan alignment bonus/);
    expect(
      () =>
        new KeystoneShadowCouncilExecutor({
          ...options,
          switchMarginBP: 500.5,
        }),
    ).toThrow(/switch margin/);
  });

  it("emits one bounded redacted line with exact safe IDs and no raw intents", () => {
    const logs: string[] = [];
    const unsafeID =
      "https://private.invalid/action?token=SUPER_SECRET_PASSWORD";
    const rawIntent = {
      type: "attack",
      targetID: "RAW_INTENT_MUST_NOT_APPEAR",
    } as unknown as LegalAction["intent"];
    const current = input(
      [action(unsafeID, "spawn", {}, rawIntent), action("hold:wait", "hold")],
      { phase: "spawn", turn: 0 },
    );
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate({
        actionID: unsafeID,
        reason: "authoritative",
        planFollowed: true,
      }),
      actionFollowsCanonicalPlan: () => false,
      experts: experts(),
      logLine: (line) => logs.push(line),
    });

    shadow.decide(current, plan);

    expect(logs).toHaveLength(1);
    const line = logs[0]!;
    expect(line.startsWith(KEYSTONE_SHADOW_COUNCIL_LOG_PREFIX)).toBe(true);
    expect(line).not.toContain("\n");
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(
      KEYSTONE_SHADOW_COUNCIL_LOG_MAX_BYTES,
    );
    expect(line).not.toMatch(
      /SUPER_SECRET|PASSWORD|private\.invalid|RAW_INTENT|https:\/\/|focused shadow test/,
    );
    const decoded = JSON.parse(
      line.slice(KEYSTONE_SHADOW_COUNCIL_LOG_PREFIX.length),
    ) as KeystoneShadowCouncilTelemetry;
    expect(decoded.proposals[0]).toMatchObject({
      domain: null,
      source: "spawn",
      bidBP: 9_125,
      bid: {
        expectedValueBP: 9_000,
        urgencyBP: 10_000,
        confidenceBP: 9_500,
        riskBP: 1_000,
        opportunityCostBP: 0,
      },
    });
    expect(decoded.proposals[0]?.actionID).toMatch(/^hash:[0-9a-f]{16}$/);

    const oversized = {
      ...decoded,
      proposals: Array.from({ length: 500 }, () => decoded.proposals[0]!),
      rejections: Array.from({ length: 500 }, () => ({
        proposalID: "p",
        actionID: "a",
        reason: "invalid_proposal" as const,
      })),
    } satisfies KeystoneShadowCouncilTelemetry;
    const fallback = boundedKeystoneShadowCouncilTelemetryLine(oversized);
    expect(Buffer.byteLength(fallback, "utf8")).toBeLessThanOrEqual(
      KEYSTONE_SHADOW_COUNCIL_LOG_MAX_BYTES,
    );
    expect(
      JSON.parse(fallback.slice(KEYSTONE_SHADOW_COUNCIL_LOG_PREFIX.length)),
    ).toMatchObject({ health: "unavailable", proposals: [], rejections: [] });
  });

  it("adds <=300 byte compact metadata without fallback or degradation flags", async () => {
    const current = input();
    const execution: AgentExecutionDecision = {
      actionID: "hold:wait",
      actionIDs: ["hold:wait", "build:city"],
      reason: "authoritative reason",
      planFollowed: true,
      executorSource: "frontier-policy",
    };
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate(execution),
      actionFollowsCanonicalPlan: () => false,
      experts: experts({
        expansion: () => proposal("expansion", "expand:neutral:35"),
      }),
      logLine: () => undefined,
    });
    const wrapped = new KeystoneShadowCouncilTelemetryAgentBrain(
      {
        brainType: "planner-executor",
        decide: (brainInput) => {
          const decided = shadow.decide(brainInput, plan);
          return {
            actionID: decided.actionID,
            actionIDs: decided.actionIDs,
            reason: decided.reason,
            metadata: {
              executorSource: decided.executorSource ?? "unknown",
              confidence: 0.7,
            },
          };
        },
      },
      shadow,
    );

    const decision = await wrapped.decide(current);
    const compact = decision.metadata?.[KEYSTONE_SHADOW_COUNCIL_METADATA_KEY];
    expect(decision).toMatchObject({
      actionID: execution.actionID,
      actionIDs: execution.actionIDs,
      reason: execution.reason,
      metadata: {
        executorSource: execution.executorSource,
        confidence: 0.7,
      },
    });
    expect(typeof compact).toBe("string");
    expect(Buffer.byteLength(String(compact), "utf8")).toBeLessThanOrEqual(
      KEYSTONE_SHADOW_COUNCIL_METADATA_MAX_BYTES,
    );
    expect(JSON.parse(String(compact))).toMatchObject({
      p: 1,
      e: 0,
      h: "h",
      a: "d",
      s: 1,
      k: 15,
    });
    expect(decision.metadata).not.toHaveProperty("fallbackUsed");
    expect(decision.metadata).not.toHaveProperty("plannerFallbackUsed");
    expect(decision.metadata).not.toHaveProperty("llmPlannerDegraded");
  });

  it("keeps p99 shadow overhead <=5ms and every sample <25ms at 512 actions", () => {
    const manyActions = Array.from({ length: 511 }, (_, index) =>
      action(`quick-chat:${index.toString().padStart(3, "0")}`, "quick_chat"),
    );
    manyActions.push(action("hold:wait", "hold"));
    const current = input(manyActions);
    const shadow = new KeystoneShadowCouncilExecutor({
      delegate: delegate({
        actionID: "hold:wait",
        reason: "hold",
        planFollowed: true,
      }),
      actionFollowsCanonicalPlan: () => false,
      experts: experts(),
      logLine: () => undefined,
    });

    for (let index = 0; index < 25; index += 1) {
      shadow.decide(current, plan);
    }
    const samplesUs: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const startedAt = process.hrtime.bigint();
      shadow.decide(current, plan);
      samplesUs.push(Number((process.hrtime.bigint() - startedAt) / 1_000n));
    }
    samplesUs.sort((a, b) => a - b);
    const p99 = samplesUs[Math.ceil(samplesUs.length * 0.99) - 1]!;
    const max = samplesUs.at(-1)!;

    expect(p99).toBeLessThanOrEqual(5_000);
    expect(max).toBeLessThan(25_000);
  });
});
