import {
  advanceCommanderPlan as advanceCommanderPlanWithoutFallback,
  CommanderPlanLifecycle,
  commanderPlanProgress,
  commanderRequestIdentity,
  type ActiveCommanderPlan,
  type AdvanceCommanderPlanInput,
  type CommanderFallbackSelection,
  type CommanderPlanMaterial,
  type CommanderPlanRejectionCode,
  type CommanderPlanRequest,
  type CommanderPlanResponseEnvelope,
  type CommanderRequestIdentity,
} from "../../src/server/agents/CommanderPlanLifecycle";
import { parseCommanderResponse } from "../../src/server/agents/CommanderResponseParser";
import {
  buildCommanderState,
  fingerprintCommanderMaterialState,
  fingerprintExposedOptionSet,
  MAX_COMMANDER_PLAN_ATTACKER_IDS,
} from "../../src/server/agents/CommanderStateBuilder";
import type {
  ExposedStrategicOption,
  StrategicOptionId,
} from "../../src/server/agents/StrategicCommanderTypes";
import { MAX_EXPOSED_STRATEGIC_OPTIONS } from "../../src/server/agents/StrategicOptionBuilder";
import { selectDeterministicStrategicOption } from "../../src/server/agents/StrategicOptionSelectors";
import {
  EVIDENCE_LEAK_CANARY,
  makeCommanderStage2Fixture,
  RAW_ATTACK_ACTION_ID,
  RAW_BUILD_ACTION_ID,
  RAW_EXPANSION_ACTION_ID,
} from "./StrategicCommanderStage2TestHarness";

const GAME_ID = "COMMANDER_STAGE_2_TEST";
const AGENT_ID = "COMMANDER_AGENT";
const BASE_DECISION = 7;
const BASE_TURN = 41;
const BASE_TICK = 12_345;
const BASE_TILES = 300;
const BASE_TROOPS = 20_000;

/** The exact ids Stage 1 exposes for the shared fixture, in exposed order. */
const EXPOSED_IDS: StrategicOptionId[] = [
  "expand",
  "develop_economy",
  "pressure_rival:P7",
  "survive",
  "pressure_rival:P8",
];

/** The fixed Arm B selector's choice for the shared locked fixture. */
const FALLBACK_ID: StrategicOptionId = "pressure_rival:P7";

function fixtureOptions(): ExposedStrategicOption[] {
  return makeCommanderStage2Fixture().builtState.state.options;
}

function makeMaterial(
  overrides: Partial<CommanderPlanMaterial> = {},
): CommanderPlanMaterial {
  return {
    tilesOwned: BASE_TILES,
    troops: BASE_TROOPS,
    incomingAttackerIDs: ["P6", "P5"],
    alivePlayerIDs: ["P1", "P4", "P5", "P6", "P7", "P8"],
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<CommanderPlanRequest> = {},
): CommanderPlanRequest {
  const fixture = makeCommanderStage2Fixture();
  const exposedOptions =
    overrides.exposedOptions ?? fixture.builtState.state.options;
  return {
    gameID: GAME_ID,
    agentID: AGENT_ID,
    decisionSequence: BASE_DECISION,
    turnNumber: BASE_TURN,
    tick: BASE_TICK,
    exposedOptions,
    exposedOptionSetFingerprint: fingerprintExposedOptionSet(exposedOptions),
    materialStateFingerprint: fixture.builtState.fingerprints.materialState,
    ...overrides,
  };
}

function deterministicFallbackSelection(
  request: CommanderPlanRequest,
): CommanderFallbackSelection | null {
  if (request.exposedOptions.length === 0) return null;
  const state = {
    ...makeCommanderStage2Fixture().builtState.state,
    options: [...request.exposedOptions],
  };
  return selectDeterministicStrategicOption(state, request.exposedOptions);
}

/**
 * Stage 3 tests exercise lifecycle behavior with the same deterministic
 * selection that the Stage 4 caller must supply at every fallback boundary.
 */
function advanceCommanderPlan(input: AdvanceCommanderPlanInput) {
  return advanceCommanderPlanWithoutFallback({
    ...input,
    fallbackSelection:
      input.fallbackSelection === undefined
        ? deterministicFallbackSelection(input.request)
        : input.fallbackSelection,
  });
}

/** Builds a response through the real Stage 2 parser, bound to `identity`. */
function makeResponse(
  identity: CommanderRequestIdentity,
  body: {
    selectedStrategicOptionId?: string;
    horizonDecisions?: number;
    intent?: string;
    replanTriggers?: string[];
    confidence?: number;
  } = {},
  lockedOptionIDs: readonly StrategicOptionId[] = identity.exposedOptionIDs,
): CommanderPlanResponseEnvelope {
  const raw = JSON.stringify({
    selectedStrategicOptionId: body.selectedStrategicOptionId ?? "expand",
    horizonDecisions: body.horizonDecisions ?? 4,
    intent: body.intent ?? "hold the north and grow",
    replanTriggers: body.replanTriggers ?? [],
    ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
  });
  return { identity, parsed: parseCommanderResponse(raw, lockedOptionIDs) };
}

/** Installs a real Commander-authored plan at the base decision. */
function installedPlan(
  body: Parameters<typeof makeResponse>[1] = {},
  request: CommanderPlanRequest = makeRequest(),
): ActiveCommanderPlan {
  const identity = commanderRequestIdentity(request);
  const cycle = advanceCommanderPlan({
    active: null,
    request,
    material: makeMaterial(),
    response: makeResponse(identity, body),
  });
  expect(cycle.selector).toBe("commander");
  if (cycle.plan === null) {
    throw new Error("expected an installed plan");
  }
  return cycle.plan;
}

describe("CommanderPlanLifecycle Stage 3 — request identity", () => {
  it("binds the exact exposed ids, order, fingerprints, and decision coordinates", () => {
    const identity = commanderRequestIdentity(makeRequest());

    expect(identity.gameID).toBe(GAME_ID);
    expect(identity.agentID).toBe(AGENT_ID);
    expect(identity.decisionSequence).toBe(BASE_DECISION);
    expect(identity.turnNumber).toBe(BASE_TURN);
    expect(identity.tick).toBe(BASE_TICK);
    expect(identity.exposedOptionIDs).toEqual(EXPOSED_IDS);
    expect(identity.exposedOptionSetFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(identity.materialStateFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects a duplicated or over-sized exposed option set", () => {
    const options = fixtureOptions();
    expect(() =>
      commanderRequestIdentity(
        makeRequest({ exposedOptions: [options[0], options[0]] }),
      ),
    ).toThrow(/duplicate option id/);

    const oversized = Array.from(
      { length: MAX_EXPOSED_STRATEGIC_OPTIONS + 1 },
      (_unused, index) => ({ ...options[0], id: `expand${index}` }),
    ) as unknown as ExposedStrategicOption[];
    expect(() =>
      commanderRequestIdentity(makeRequest({ exposedOptions: oversized })),
    ).toThrow(/exposure bound/);
  });
});

describe("CommanderPlanLifecycle Stage 3 — installation and provenance", () => {
  it("installs a Commander-authored plan with commander provenance and a factual start", () => {
    const plan = installedPlan({
      selectedStrategicOptionId: "pressure_rival:P7",
      horizonDecisions: 5,
      replanTriggers: ["target_eliminated", "home_danger_high"],
    });

    expect(plan.selectedStrategicOptionId).toBe("pressure_rival:P7");
    expect(plan.family).toBe("pressure_rival");
    expect(plan.targetPlayerID).toBe("P7");
    expect(plan.horizonDecisions).toBe(5);
    expect(plan.replanTriggers).toEqual([
      "home_danger_high",
      "target_eliminated",
    ]);
    expect(plan.selector).toBe("commander");
    expect(plan.fallbackReason).toBeNull();
    expect(plan.origin.exposedOptionIDs).toEqual(EXPOSED_IDS);
    expect(plan.start).toEqual({
      decisionSequence: BASE_DECISION,
      turnNumber: BASE_TURN,
      tick: BASE_TICK,
      tilesOwned: BASE_TILES,
      troops: BASE_TROOPS,
      incomingAttackerIDs: ["P5", "P6"],
    });
  });

  it("keeps plan state factual: no scores, confidence, evidence, or LegalAction ids", () => {
    const cycle = advanceCommanderPlan({
      active: null,
      request: makeRequest(),
      material: makeMaterial(),
      response: makeResponse(commanderRequestIdentity(makeRequest()), {
        confidence: 0.9,
      }),
    });
    const serialized = JSON.stringify(cycle);

    expect(serialized).not.toContain("confidence");
    expect(serialized).not.toContain(RAW_ATTACK_ACTION_ID);
    expect(serialized).not.toContain(RAW_BUILD_ACTION_ID);
    expect(serialized).not.toContain(RAW_EXPANSION_ACTION_ID);
    expect(serialized).not.toContain(EVIDENCE_LEAK_CANARY);
    expect(serialized).not.toContain("totalScore");
    expect(Object.keys(cycle.plan ?? {}).sort()).toEqual([
      "fallbackDegradationCause",
      "fallbackReason",
      "family",
      "horizonDecisions",
      "intent",
      "origin",
      "planID",
      "replanTriggers",
      "selectedStrategicOptionId",
      "selector",
      "start",
      "targetPlayerID",
    ]);
    expect(Object.keys(cycle.snapshot ?? {}).sort()).toEqual([
      "family",
      "horizonDecisions",
      "progress",
      "replanTriggers",
      "selectedStrategicOptionId",
      "targetPlayerID",
    ]);
  });

  it("feeds its snapshot back through the Stage 2 state builder unchanged", () => {
    const fixture = makeCommanderStage2Fixture();
    const plan = installedPlan({
      selectedStrategicOptionId: "pressure_rival:P7",
    });
    const later = makeRequest({ decisionSequence: BASE_DECISION + 1 });
    const cycle = advanceCommanderPlan({
      active: plan,
      request: later,
      material: makeMaterial({
        tilesOwned: 320,
        incomingAttackerIDs: ["P6", "P5", "P1"],
      }),
      response: null,
    });

    const rebuilt = buildCommanderState({
      observation: fixture.observation,
      exposedOptions: fixture.builtState.state.options,
      decisionSequence: BASE_DECISION + 1,
      plan: cycle.snapshot,
    });

    expect(rebuilt.state.plan?.selectedStrategicOptionId).toBe(
      "pressure_rival:P7",
    );
    expect(rebuilt.state.plan?.progress).toEqual({
      decisionsExecuted: 1,
      tilesDelta: 20,
      troopsDelta: 0,
      newIncomingAttackerIDs: ["P1"],
    });
  });
});

describe("CommanderPlanLifecycle Stage 3 — persistence, age, and horizon", () => {
  it("persists one durable plan across decisions and never substitutes its option", () => {
    const plan = installedPlan({
      selectedStrategicOptionId: "expand",
      horizonDecisions: 4,
    });

    for (let step = 1; step <= 3; step += 1) {
      const cycle = advanceCommanderPlan({
        active: plan,
        request: makeRequest({ decisionSequence: BASE_DECISION + step }),
        material: makeMaterial(),
        response: null,
      });
      expect(cycle.evaluation.disposition).toBe("continue");
      expect(cycle.evaluation.reason).toBe("within_horizon");
      expect(cycle.evaluation.ageDecisions).toBe(step);
      expect(cycle.evaluation.decisionsRemaining).toBe(4 - step);
      expect(cycle.plan).toBe(plan);
      expect(cycle.plan?.selectedStrategicOptionId).toBe("expand");
      expect(cycle.planPreserved).toBe(true);
      expect(cycle.progress?.decisionsExecuted).toBe(step);
    }
  });

  it("continues on the last in-horizon decision and replans exactly at the boundary", () => {
    const plan = installedPlan({ horizonDecisions: 3 });

    const lastInside = advanceCommanderPlan({
      active: plan,
      request: makeRequest({ decisionSequence: BASE_DECISION + 2 }),
      material: makeMaterial(),
      response: null,
    });
    expect(lastInside.evaluation.disposition).toBe("continue");
    expect(lastInside.evaluation.decisionsRemaining).toBe(1);

    for (const step of [3, 4]) {
      const expired = advanceCommanderPlan({
        active: plan,
        request: makeRequest({ decisionSequence: BASE_DECISION + step }),
        material: makeMaterial(),
        response: null,
      });
      expect(expired.evaluation.disposition).toBe("replan");
      expect(expired.evaluation.reason).toBe("horizon_expiry");
      expect(expired.evaluation.ageDecisions).toBe(step);
      expect(expired.evaluation.decisionsRemaining).toBe(0);
      expect(expired.selector).toBe("fallback");
      expect(expired.fallbackReason).toBe("commander_result_absent");
    }
  });

  it("ignores a valid Commander result while a plan is still continuing", () => {
    const plan = installedPlan({
      selectedStrategicOptionId: "expand",
      horizonDecisions: 5,
    });
    const later = makeRequest({ decisionSequence: BASE_DECISION + 1 });
    const cycle = advanceCommanderPlan({
      active: plan,
      request: later,
      material: makeMaterial(),
      response: makeResponse(commanderRequestIdentity(later), {
        selectedStrategicOptionId: "survive",
      }),
    });

    expect(cycle.evaluation.disposition).toBe("continue");
    expect(cycle.responseDisposition).toBe("ignored_while_continuing");
    expect(cycle.plan).toBe(plan);
    expect(cycle.plan?.selectedStrategicOptionId).toBe("expand");
    expect(cycle.rejection).toBeNull();
  });
});

describe("CommanderPlanLifecycle Stage 3 — explicit replan and terminate reasons", () => {
  it("replans when there is no active plan", () => {
    const cycle = advanceCommanderPlan({
      active: null,
      request: makeRequest(),
      material: makeMaterial(),
      response: null,
    });
    expect(cycle.evaluation).toEqual({
      disposition: "replan",
      reason: "no_active_plan",
      ageDecisions: 0,
      horizonDecisions: null,
      decisionsRemaining: null,
    });
  });

  it("terminates on game, agent, and regressed-decision mismatches", () => {
    const plan = installedPlan();
    const cases: Array<[Partial<CommanderPlanRequest>, string]> = [
      [{ gameID: "OTHER_GAME" }, "game_mismatch"],
      [{ agentID: "OTHER_AGENT" }, "agent_mismatch"],
      [{ decisionSequence: BASE_DECISION - 1 }, "decision_sequence_regressed"],
    ];
    for (const [override, reason] of cases) {
      const cycle = advanceCommanderPlan({
        active: plan,
        request: makeRequest(override),
        material: makeMaterial(),
        response: null,
      });
      expect(cycle.evaluation.disposition).toBe("terminate");
      expect(cycle.evaluation.reason).toBe(reason);
      expect(cycle.selector).toBe("fallback");
    }
  });

  it("explicitly replans when the selected option is no longer executable", () => {
    const plan = installedPlan({ selectedStrategicOptionId: "survive" });
    const withoutSurvive = fixtureOptions().filter(
      (option) => option.id !== "survive",
    );
    const cycle = advanceCommanderPlan({
      active: plan,
      request: makeRequest({ exposedOptions: withoutSurvive }),
      material: makeMaterial(),
      response: null,
    });

    expect(cycle.evaluation.disposition).toBe("replan");
    expect(cycle.evaluation.reason).toBe("option_not_executable");
    expect(cycle.plan?.selectedStrategicOptionId).not.toBe("survive");
  });

  it("terminates when the plan target is eliminated", () => {
    const plan = installedPlan({
      selectedStrategicOptionId: "pressure_rival:P7",
    });
    const cycle = advanceCommanderPlan({
      active: plan,
      request: makeRequest({ decisionSequence: BASE_DECISION + 1 }),
      material: makeMaterial({
        alivePlayerIDs: ["P1", "P4", "P5", "P6", "P8"],
      }),
      response: null,
    });

    expect(cycle.evaluation.disposition).toBe("terminate");
    expect(cycle.evaluation.reason).toBe("target_eliminated");
  });

  it("preserves plan provenance when an active menu transiently exposes no options", () => {
    const plan = installedPlan();
    const cycle = advanceCommanderPlan({
      active: plan,
      request: makeRequest({
        exposedOptions: [],
        exposedOptionSetFingerprint: fingerprintExposedOptionSet([]),
      }),
      material: makeMaterial(),
      response: null,
    });

    expect(cycle.evaluation.reason).toBe("no_exposed_options");
    expect(cycle.plan).toBe(plan);
    expect(cycle.snapshot?.selectedStrategicOptionId).toBe(
      plan.selectedStrategicOptionId,
    );
    expect(cycle.progress).not.toBeNull();
    expect(cycle.selector).toBe(plan.selector);
    expect(cycle.planPreserved).toBe(true);
  });

  it("fires declared danger and new-option triggers, and only when declared", () => {
    const declared = installedPlan({
      horizonDecisions: 6,
      replanTriggers: ["home_danger_high", "option_appeared"],
    });
    const undeclared = installedPlan({ horizonDecisions: 6 });
    const material = makeMaterial({
      incomingAttackerIDs: ["P6", "P5", "P4"],
    });

    const danger = advanceCommanderPlan({
      active: declared,
      request: makeRequest({ decisionSequence: BASE_DECISION + 1 }),
      material,
      response: null,
    });
    expect(danger.evaluation.disposition).toBe("replan");
    expect(danger.evaluation.reason).toBe("home_danger_high");

    const quiet = advanceCommanderPlan({
      active: undeclared,
      request: makeRequest({ decisionSequence: BASE_DECISION + 1 }),
      material,
      response: null,
    });
    expect(quiet.evaluation.disposition).toBe("continue");

    const appeared = advanceCommanderPlan({
      active: declared,
      request: makeRequest({
        decisionSequence: BASE_DECISION + 1,
        exposedOptions: [
          ...fixtureOptions(),
          {
            ...fixtureOptions()[0],
            id: "pressure_rival:P1",
            family: "pressure_rival",
            targetPlayerID: "P1",
          } as ExposedStrategicOption,
        ],
      }),
      material: makeMaterial(),
      response: null,
    });
    expect(appeared.evaluation.disposition).toBe("replan");
    expect(appeared.evaluation.reason).toBe("option_appeared");
  });
});

describe("CommanderPlanLifecycle Stage 3 — request-binding rejection", () => {
  const dimensions: Array<
    [
      string,
      Partial<CommanderRequestIdentity>,
      CommanderPlanRejectionCode,
      string,
    ]
  > = [
    [
      "game id",
      { gameID: "OTHER_GAME" },
      "game_id_mismatch",
      "commander_request_mismatch",
    ],
    [
      "agent id",
      { agentID: "OTHER_AGENT" },
      "agent_id_mismatch",
      "commander_request_mismatch",
    ],
    [
      "stale decision",
      { decisionSequence: BASE_DECISION - 1 },
      "decision_sequence_stale",
      "commander_result_stale",
    ],
    [
      "future decision",
      { decisionSequence: BASE_DECISION + 1 },
      "decision_sequence_mismatch",
      "commander_request_mismatch",
    ],
    [
      "turn",
      { turnNumber: BASE_TURN + 1 },
      "turn_number_mismatch",
      "commander_request_mismatch",
    ],
    [
      "tick",
      { tick: BASE_TICK + 1 },
      "tick_mismatch",
      "commander_request_mismatch",
    ],
    [
      "exposed ids",
      { exposedOptionIDs: [...EXPOSED_IDS].reverse() },
      "exposed_option_ids_mismatch",
      "commander_request_mismatch",
    ],
    [
      "option-set fingerprint",
      { exposedOptionSetFingerprint: "0000000000000000" },
      "option_set_fingerprint_mismatch",
      "commander_request_mismatch",
    ],
    [
      "material fingerprint",
      { materialStateFingerprint: "0000000000000000" },
      "material_state_fingerprint_mismatch",
      "commander_request_mismatch",
    ],
  ];

  it.each(dimensions)(
    "rejects a result bound to a different %s and falls back within the request",
    (_label, override, code, fallbackReason) => {
      const request = makeRequest();
      const identity = commanderRequestIdentity(request);
      const cycle = advanceCommanderPlan({
        active: null,
        request,
        material: makeMaterial(),
        response: makeResponse(
          { ...identity, ...override },
          { selectedStrategicOptionId: "survive" },
        ),
      });

      expect(cycle.responseDisposition).toBe("rejected");
      expect(cycle.rejection?.code).toBe(code);
      expect(cycle.selector).toBe("fallback");
      expect(cycle.fallbackReason).toBe(fallbackReason);
      expect(cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
      expect(cycle.plan?.selectedStrategicOptionId).not.toBe("survive");
    },
  );

  it("stores stale-response degradation on the fallback plan for its full lifetime", () => {
    const request = makeRequest();
    const identity = commanderRequestIdentity(request);
    const installed = advanceCommanderPlan({
      active: null,
      request,
      material: makeMaterial(),
      response: makeResponse(
        { ...identity, decisionSequence: BASE_DECISION - 1 },
        { selectedStrategicOptionId: "survive" },
      ),
    });
    expect(installed.plan).toMatchObject({
      selector: "fallback",
      fallbackDegradationCause: "plan-stale",
    });

    const continued = advanceCommanderPlan({
      active: installed.plan,
      request: makeRequest({ decisionSequence: BASE_DECISION + 1 }),
      material: makeMaterial(),
      response: null,
    });
    expect(continued.evaluation.disposition).toBe("continue");
    expect(continued.plan).toMatchObject({
      planID: installed.plan?.planID,
      fallbackDegradationCause: "plan-stale",
    });
  });

  it("rejects an unparsable Commander response", () => {
    const request = makeRequest();
    const identity = commanderRequestIdentity(request);
    const cycle = advanceCommanderPlan({
      active: null,
      request,
      material: makeMaterial(),
      response: {
        identity,
        parsed: parseCommanderResponse("not json", EXPOSED_IDS),
      },
    });

    expect(cycle.rejection?.code).toBe("response_invalid");
    expect(cycle.fallbackReason).toBe("commander_response_invalid");
    expect(cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
    expect(cycle.plan?.fallbackDegradationCause).toBe("plan-parse");
  });

  it("rejects a selection outside this request's exact exposed ids", () => {
    const request = makeRequest({
      exposedOptions: fixtureOptions().filter(
        (option) => option.id !== "pressure_rival:P8",
      ),
    });
    const identity = commanderRequestIdentity(request);
    // The parser accepted it against a wider locked list; the lifecycle must not.
    const response = makeResponse(
      identity,
      { selectedStrategicOptionId: "pressure_rival:P8" },
      EXPOSED_IDS,
    );
    expect(response.parsed.ok).toBe(true);

    const cycle = advanceCommanderPlan({
      active: null,
      request,
      material: makeMaterial(),
      response,
    });

    expect(cycle.rejection?.code).toBe("option_not_exposed");
    expect(cycle.fallbackReason).toBe("commander_option_not_exposed");
    expect(cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
  });

  it("rejects an envelope whose identity fields are the wrong shape", () => {
    const request = makeRequest();
    const identity = commanderRequestIdentity(request);
    const malformed = [
      { ...identity, decisionSequence: String(BASE_DECISION) },
      { ...identity, exposedOptionIDs: "expand" },
      { ...identity, tick: "12345" },
      null,
    ];

    for (const seen of malformed) {
      const cycle = advanceCommanderPlan({
        active: null,
        request,
        material: makeMaterial(),
        response: {
          identity: seen as unknown as CommanderRequestIdentity,
          parsed: parseCommanderResponse(
            JSON.stringify({
              selectedStrategicOptionId: "survive",
              horizonDecisions: 3,
              intent: "push",
              replanTriggers: [],
            }),
            EXPOSED_IDS,
          ),
        },
      });
      expect(cycle.rejection?.code).toBe("identity_malformed");
      expect(cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
    }
  });

  it("reports the real binding failure even when nothing is exposed", () => {
    const request = makeRequest({
      exposedOptions: [],
      exposedOptionSetFingerprint: fingerprintExposedOptionSet([]),
    });
    const cycle = advanceCommanderPlan({
      active: null,
      request,
      material: makeMaterial(),
      response: makeResponse(
        { ...commanderRequestIdentity(request), gameID: "OTHER_GAME" },
        {},
        EXPOSED_IDS,
      ),
    });

    expect(cycle.plan).toBeNull();
    expect(cycle.responseDisposition).toBe("rejected");
    expect(cycle.rejection?.code).toBe("game_id_mismatch");
  });

  it("keeps complete membership truth beyond the former 256-player cap", () => {
    const cycle = advanceCommanderPlan({
      active: null,
      request: makeRequest(),
      material: makeMaterial({
        alivePlayerIDs: new Set(
          Array.from({ length: 300 }, (_unused, index) => `Z${index}`),
        ),
      }),
      response: null,
    });
    expect(cycle.plan).not.toBeNull();
  });

  it("rejects malformed parsed payloads without throwing", () => {
    const request = makeRequest();
    const identity = commanderRequestIdentity(request);
    const malformed = [
      {
        ok: true,
        selectedStrategicOptionId: 7,
        horizonDecisions: 3,
        intent: "x",
        replanTriggers: [],
      },
      {
        ok: true,
        selectedStrategicOptionId: "expand",
        horizonDecisions: "3",
        intent: "x",
        replanTriggers: [],
      },
      {
        ok: true,
        selectedStrategicOptionId: "expand",
        horizonDecisions: 3,
        intent: 7,
        replanTriggers: [],
      },
      {
        ok: true,
        selectedStrategicOptionId: "expand",
        horizonDecisions: 3,
        intent: "x",
        replanTriggers: "horizon_expiry",
      },
    ];
    for (const parsed of malformed) {
      const cycle = advanceCommanderPlan({
        active: null,
        request,
        material: makeMaterial(),
        response: {
          identity,
          parsed: parsed as unknown as CommanderPlanResponseEnvelope["parsed"],
        },
      });
      expect(cycle.rejection?.code).toBe("response_invalid");
      expect(cycle.selector).toBe("fallback");
    }
  });

  it("always replans after a blocked hold", () => {
    const plan = installedPlan({ horizonDecisions: 6 });
    const evaluation = new CommanderPlanLifecycle().evaluate({
      plan,
      request: makeRequest({ decisionSequence: BASE_DECISION + 1 }),
      material: makeMaterial(),
      forcedReplanReason: "hold_streak_blocked",
    });
    expect(evaluation).toMatchObject({
      disposition: "replan",
      reason: "hold_streak_blocked",
      ageDecisions: 1,
    });
  });

  it("leaves a continuing plan completely unchanged when a response is rejected", () => {
    const plan = installedPlan({
      selectedStrategicOptionId: "expand",
      horizonDecisions: 6,
    });
    const before = JSON.stringify(plan);
    const later = makeRequest({ decisionSequence: BASE_DECISION + 1 });
    const cycle = advanceCommanderPlan({
      active: plan,
      request: later,
      material: makeMaterial(),
      response: makeResponse(
        { ...commanderRequestIdentity(later), gameID: "OTHER_GAME" },
        { selectedStrategicOptionId: "survive" },
      ),
    });

    expect(cycle.evaluation.disposition).toBe("continue");
    expect(cycle.responseDisposition).toBe("rejected");
    expect(cycle.rejection?.code).toBe("game_id_mismatch");
    expect(cycle.plan).toBe(plan);
    expect(cycle.planPreserved).toBe(true);
    expect(cycle.selector).toBe("commander");
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe("CommanderPlanLifecycle Stage 3 — request option-set fingerprint validation", () => {
  const MISMATCH = /option-set fingerprint does not match its exposed options/;

  it("rejects a request whose claimed fingerprint does not match its exposed options", () => {
    const forged = makeRequest({
      exposedOptionSetFingerprint: "0000000000000000",
    });
    expect(() => commanderRequestIdentity(forged)).toThrow(MISMATCH);
    expect(() =>
      advanceCommanderPlan({
        active: null,
        request: forged,
        material: makeMaterial(),
        response: null,
      }),
    ).toThrow(MISMATCH);
  });

  it("rejects a genuine fingerprint of a different option set", () => {
    const fewer = fixtureOptions().slice(0, 2);
    const request = makeRequest({
      exposedOptions: fewer,
      exposedOptionSetFingerprint:
        fingerprintExposedOptionSet(fixtureOptions()),
    });
    expect(() =>
      advanceCommanderPlan({
        active: null,
        request,
        material: makeMaterial(),
        response: null,
      }),
    ).toThrow(MISMATCH);
  });

  it("cannot install a Commander result through a mismatched request fingerprint", () => {
    const identity = commanderRequestIdentity(makeRequest());
    const forged = makeRequest({
      exposedOptionSetFingerprint: "0000000000000000",
    });
    expect(() =>
      advanceCommanderPlan({
        active: null,
        request: forged,
        material: makeMaterial(),
        response: makeResponse(
          { ...identity, exposedOptionSetFingerprint: "0000000000000000" },
          { selectedStrategicOptionId: "survive" },
        ),
      }),
    ).toThrow(MISMATCH);
  });

  it("cannot replace or mutate the active plan through a mismatched request fingerprint", () => {
    const plan = installedPlan({
      selectedStrategicOptionId: "expand",
      horizonDecisions: 3,
    });
    const before = JSON.stringify(plan);
    // Past the horizon a matching request would replan; the forged one may not.
    const forged = makeRequest({
      decisionSequence: BASE_DECISION + 3,
      exposedOptionSetFingerprint: "0000000000000000",
    });
    const lifecycle = new CommanderPlanLifecycle();

    expect(() =>
      lifecycle.advance({
        active: plan,
        request: forged,
        material: makeMaterial(),
        response: null,
      }),
    ).toThrow(MISMATCH);
    expect(() =>
      lifecycle.evaluate({ plan, request: forged, material: makeMaterial() }),
    ).toThrow(MISMATCH);
    expect(JSON.stringify(plan)).toBe(before);
    expect(plan.selectedStrategicOptionId).toBe("expand");
  });

  it("preserves current behavior when the fingerprint matches, in any exposure order", () => {
    const reordered = [...fixtureOptions()].reverse();
    const request = makeRequest({ exposedOptions: reordered });
    const cycle = advanceCommanderPlan({
      active: null,
      request,
      material: makeMaterial(),
      response: makeResponse(commanderRequestIdentity(request), {
        selectedStrategicOptionId: "survive",
      }),
    });

    expect(cycle.rejection).toBeNull();
    expect(cycle.selector).toBe("commander");
    expect(cycle.plan?.selectedStrategicOptionId).toBe("survive");
  });
});

describe("CommanderPlanLifecycle Stage 3 — fingerprint stability and sensitivity", () => {
  it("accepts a result whose fingerprints were rebuilt from identical inputs", () => {
    const request = makeRequest();
    const rebuilt = commanderRequestIdentity(makeRequest());
    expect(rebuilt.exposedOptionSetFingerprint).toBe(
      request.exposedOptionSetFingerprint,
    );
    expect(rebuilt.materialStateFingerprint).toBe(
      request.materialStateFingerprint,
    );

    const cycle = advanceCommanderPlan({
      active: null,
      request,
      material: makeMaterial(),
      response: makeResponse(rebuilt, { selectedStrategicOptionId: "survive" }),
    });
    expect(cycle.rejection).toBeNull();
    expect(cycle.selector).toBe("commander");
    expect(cycle.plan?.selectedStrategicOptionId).toBe("survive");
  });

  it("keeps the option-set fingerprint order-insensitive while the id binding is exact", () => {
    const options = fixtureOptions();
    const reordered = [...options].reverse();
    expect(fingerprintExposedOptionSet(reordered)).toBe(
      fingerprintExposedOptionSet(options),
    );

    const request = makeRequest({ exposedOptions: options });
    const identity = commanderRequestIdentity(request);
    const shuffled = commanderRequestIdentity(
      makeRequest({ exposedOptions: reordered }),
    );
    expect(shuffled.exposedOptionSetFingerprint).toBe(
      identity.exposedOptionSetFingerprint,
    );
    expect(shuffled.exposedOptionIDs).not.toEqual(identity.exposedOptionIDs);

    const cycle = advanceCommanderPlan({
      active: null,
      request,
      material: makeMaterial(),
      response: makeResponse(shuffled),
    });
    expect(cycle.rejection?.code).toBe("exposed_option_ids_mismatch");
  });

  it("changes both fingerprints when the option set or material state changes", () => {
    const base = makeCommanderStage2Fixture();
    const moved = makeCommanderStage2Fixture({ decisionSequence: 9 });
    expect(moved.builtState.fingerprints.materialState).not.toBe(
      base.builtState.fingerprints.materialState,
    );

    const fewer = base.builtState.state.options.slice(0, 2);
    expect(fingerprintExposedOptionSet(fewer)).not.toBe(
      base.builtState.fingerprints.exposedOptionSet,
    );

    const changedMaterial = fingerprintCommanderMaterialState({
      gameID: GAME_ID,
      agentID: AGENT_ID,
      state: {
        ...base.builtState.state,
        self: { ...base.builtState.state.self, tilesOwned: BASE_TILES + 1 },
      },
    });
    expect(changedMaterial).not.toBe(
      base.builtState.fingerprints.materialState,
    );
  });
});

describe("CommanderPlanLifecycle Stage 3 — deterministic exposed-only fallback", () => {
  it("uses Arm B's fixed rule rather than lexicographic option-id order", () => {
    const options = fixtureOptions();
    const orders = [
      options,
      [...options].reverse(),
      [options[3], options[0], options[4], options[1], options[2]],
    ];
    for (const exposedOptions of orders) {
      const cycle = advanceCommanderPlan({
        active: null,
        request: makeRequest({ exposedOptions }),
        material: makeMaterial(),
        response: null,
      });
      expect(cycle.selector).toBe("fallback");
      expect(cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
      expect(cycle.plan?.family).toBe("pressure_rival");
      expect(cycle.plan?.targetPlayerID).toBe("P7");
      expect(cycle.plan?.horizonDecisions).toBe(3);
      expect(cycle.plan?.intent).toBe(
        "deterministic control selected pressure_rival",
      );
    }
  });

  it("never selects an omitted, hidden, or newly generated option", () => {
    const exposedOptions = fixtureOptions().filter(
      (option) => option.id !== "develop_economy",
    );
    const omittedFromStage1 =
      makeCommanderStage2Fixture().strategicOptions.record;
    const cycle = advanceCommanderPlan({
      active: null,
      request: makeRequest({ exposedOptions }),
      material: makeMaterial(),
      response: null,
    });

    const selected = cycle.plan?.selectedStrategicOptionId;
    expect(selected).toBe("pressure_rival:P7");
    expect(exposedOptions.map((option) => option.id)).toContain(selected);
    expect(
      omittedFromStage1.omitted.map((omission) => omission.id),
    ).not.toContain(selected);
    expect(cycle.plan?.origin.exposedOptionIDs).toEqual(
      exposedOptions.map((option) => option.id),
    );
  });

  it("attributes every fallback path with a specific reason", () => {
    const request = makeRequest();
    const identity = commanderRequestIdentity(request);
    const cases: Array<[CommanderPlanResponseEnvelope | null, string, string]> =
      [
        [null, "absent", "commander_result_absent"],
        [
          { identity, parsed: parseCommanderResponse("{", EXPOSED_IDS) },
          "rejected",
          "commander_response_invalid",
        ],
        [
          makeResponse({ ...identity, gameID: "OTHER" }),
          "rejected",
          "commander_request_mismatch",
        ],
        [
          makeResponse({ ...identity, decisionSequence: BASE_DECISION - 2 }),
          "rejected",
          "commander_result_stale",
        ],
      ];

    for (const [response, disposition, fallbackReason] of cases) {
      const cycle = advanceCommanderPlan({
        active: null,
        request,
        material: makeMaterial(),
        response,
      });
      expect(cycle.responseDisposition).toBe(disposition);
      expect(cycle.selector).toBe("fallback");
      expect(cycle.fallbackReason).toBe(fallbackReason);
      expect(cycle.plan?.selector).toBe("fallback");
      expect(cycle.plan?.fallbackReason).toBe(fallbackReason);
      expect(cycle.plan?.intent).toBe(
        "deterministic control selected pressure_rival",
      );
      expect(cycle.plan?.replanTriggers).toEqual([]);
    }
  });

  it("fails closed when fallback has no exact deterministic selection", () => {
    const request = makeRequest();
    expect(() =>
      advanceCommanderPlanWithoutFallback({
        active: null,
        request,
        material: makeMaterial(),
        response: null,
      }),
    ).toThrow(/requires the deterministic selector result/);

    expect(() =>
      advanceCommanderPlanWithoutFallback({
        active: null,
        request,
        material: makeMaterial(),
        response: null,
        fallbackSelection: {
          selectedStrategicOptionId: "pressure_rival:P999",
          horizonDecisions: 3,
          intent: "must not install",
          replanTriggers: [],
        },
      }),
    ).toThrow(/outside the locked request/);
  });
});

describe("CommanderPlanLifecycle Stage 3 — bounded start and progress", () => {
  it("bounds, sorts, and dedupes attacker ids in the start snapshot", () => {
    const noisy = Array.from(
      { length: MAX_COMMANDER_PLAN_ATTACKER_IDS + 4 },
      (_unused, index) => `P${index}`,
    );
    const plan = installedPlan({}, makeRequest());
    const cycle = advanceCommanderPlan({
      active: null,
      request: makeRequest(),
      material: makeMaterial({
        incomingAttackerIDs: [...noisy, ...noisy].reverse(),
      }),
      response: null,
    });

    expect(cycle.plan?.start.incomingAttackerIDs.length).toBe(
      MAX_COMMANDER_PLAN_ATTACKER_IDS,
    );
    expect(cycle.plan?.start.incomingAttackerIDs).toEqual(
      [...(cycle.plan?.start.incomingAttackerIDs ?? [])].sort(),
    );
    expect(plan.start.incomingAttackerIDs).toEqual(["P5", "P6"]);
  });

  it("derives factual progress, including losses, from current material state", () => {
    const plan = installedPlan({ horizonDecisions: 6 });
    const progress = commanderPlanProgress(
      plan,
      makeRequest({ decisionSequence: BASE_DECISION + 2 }),
      makeMaterial({
        tilesOwned: BASE_TILES - 45,
        troops: BASE_TROOPS - 2_500,
        incomingAttackerIDs: ["P6", "P5", "P4", "P1"],
      }),
    );

    expect(progress).toEqual({
      decisionsExecuted: 2,
      tilesDelta: -45,
      troopsDelta: -2_500,
      newIncomingAttackerIDs: ["P1", "P4"],
    });
  });

  it("bounds the new-attacker list in progress", () => {
    const plan = installedPlan();
    const many = Array.from(
      { length: MAX_COMMANDER_PLAN_ATTACKER_IDS + 3 },
      (_unused, index) => `Q${index}`,
    );
    const progress = commanderPlanProgress(
      plan,
      makeRequest({ decisionSequence: BASE_DECISION + 1 }),
      makeMaterial({ incomingAttackerIDs: many }),
    );

    expect(progress.newIncomingAttackerIDs.length).toBe(
      MAX_COMMANDER_PLAN_ATTACKER_IDS,
    );
    expect(progress.decisionsExecuted).toBe(1);
  });

  it("exposes the same behavior through the class facade", () => {
    const lifecycle = new CommanderPlanLifecycle();
    const request = makeRequest();
    const evaluation = lifecycle.evaluate({
      plan: null,
      request,
      material: makeMaterial(),
    });
    const cycle = lifecycle.advance({
      active: null,
      request,
      material: makeMaterial(),
      response: null,
      fallbackSelection: deterministicFallbackSelection(request),
    });

    expect(evaluation.reason).toBe("no_active_plan");
    expect(cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
  });
});
