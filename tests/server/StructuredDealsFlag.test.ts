import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../../src/server/agents/AgentRunner";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import type {
  AgentDealsObservation,
  AgentDecisionRecord,
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  LegalActionBuilder,
  reservedQuotaTruncate,
} from "../../src/server/agents/LegalActionBuilder";
import {
  DEALS_FLAG,
  dealLeagueHarness,
  makeStubLogger,
  pickWithDeal,
  stubObservation,
  stubVisiblePlayer,
  type ScriptedPicker,
  type StubSeat,
} from "./DealTestHarness";

// Phase B flag gate (PROXYWAR_TUNE_STRUCTURED_DEALS, default OFF): with the
// flag off, observations, legal-action menus, decision records, and spectator
// telemetry are byte-identical to shipped behavior — proven by JSON.stringify
// equality (template: tests/server/EconomyObservationFlag.test.ts). The two
// wall-clock record fields (decidedAt / decisionLatencyMs) are normalized on
// BOTH arms before comparison; everything else is compared byte-for-byte.

const A: StubSeat = { agentID: "a1", playerID: "P_A", username: "Auri" };
const B: StubSeat = { agentID: "b1", playerID: "P_B", username: "Sefirot" };
const C: StubSeat = { agentID: "c1", playerID: "P_C", username: "Riven" };

afterEach(() => {
  delete process.env[DEALS_FLAG];
});

function menuObservation(): AgentObservation {
  return stubObservation({
    seat: A,
    others: [stubVisiblePlayer(B), stubVisiblePlayer(C)],
    turnNumber: 42,
  });
}

function dealsBlock(): AgentDealsObservation {
  return {
    decisionStep: 3,
    incomingProposals: [
      {
        dealID: "deal:P_B:P_A:non_aggression_pact:2",
        proposerPlayerID: B.playerID,
        proposerName: B.username,
        recipientPlayerID: A.playerID,
        recipientName: A.username,
        terms: { template: "non_aggression_pact", durationSteps: 12 },
        proposedAtStep: 2,
        answerableThroughStep: 6,
      },
    ],
    outgoingProposals: [
      {
        dealID: "deal:P_A:P_C:support_request:2",
        proposerPlayerID: A.playerID,
        proposerName: A.username,
        recipientPlayerID: C.playerID,
        recipientName: C.username,
        terms: {
          template: "support_request",
          durationSteps: 6,
          goldAmount: "150000",
          troopAmount: 20000,
        },
        proposedAtStep: 2,
        answerableThroughStep: 6,
      },
    ],
    activeDeals: [],
    proposalOptions: [
      {
        recipientPlayerID: C.playerID,
        recipientName: C.username,
        terms: {
          template: "joint_attack",
          durationSteps: 8,
          targetPlayerID: B.playerID,
          targetName: B.username,
        },
      },
    ],
    rivalReliability: [],
  };
}

describe("structured deals flag — legal-action menu", () => {
  it("flag OFF: menus are byte-identical with or without a deals block", () => {
    delete process.env[DEALS_FLAG];
    const builder = new LegalActionBuilder();
    const baseline = JSON.stringify(
      builder.build({ observation: menuObservation() }),
    );
    const withDeals = JSON.stringify(
      builder.build({
        observation: { ...menuObservation(), deals: dealsBlock() },
      }),
    );
    expect(withDeals).toBe(baseline);
    expect(baseline).not.toContain("deal_");
  });

  it("flag ON without a deals block leaves the menu byte-identical", () => {
    const builder = new LegalActionBuilder();
    delete process.env[DEALS_FLAG];
    const baseline = JSON.stringify(
      builder.build({ observation: menuObservation() }),
    );
    process.env[DEALS_FLAG] = "1";
    expect(
      JSON.stringify(builder.build({ observation: menuObservation() })),
    ).toBe(baseline);
  });

  it("flag ON with deals adds ONLY deal actions: stripping them restores the bytes", () => {
    const builder = new LegalActionBuilder();
    delete process.env[DEALS_FLAG];
    const baseline = JSON.stringify(
      builder.build({ observation: menuObservation() }),
    );
    process.env[DEALS_FLAG] = "1";
    const withDeals = builder.build({
      observation: { ...menuObservation(), deals: dealsBlock() },
    });
    const dealActions = withDeals.filter((action) =>
      action.kind.startsWith("deal_"),
    );
    expect(dealActions.map((action) => action.id)).toEqual([
      "deal_accept:deal:P_B:P_A:non_aggression_pact:2",
      "deal_reject:deal:P_B:P_A:non_aggression_pact:2",
      "deal_withdraw:deal:P_A:P_C:support_request:2",
      "deal_propose:P_C:joint_attack",
    ]);
    expect(dealActions.every((action) => action.intent === null)).toBe(true);
    const stripped = withDeals.filter(
      (action) => !action.kind.startsWith("deal_"),
    );
    expect(JSON.stringify(stripped)).toBe(baseline);
  });

  it("reserved diplomacy slots protect deal actions under menu pressure", () => {
    const attack = (index: number): LegalAction => ({
      id: `attack:${index}`,
      kind: "attack",
      label: `attack ${index}`,
      intent: null,
      risk: { level: "low", score: 0.1 },
    });
    const deal = (id: string, kind: LegalAction["kind"]): LegalAction => ({
      id,
      kind,
      label: id,
      intent: null,
      risk: { level: "none", score: 0 },
    });
    const actions = [
      ...Array.from({ length: 100 }, (_, index) => attack(index)),
      deal("deal_accept:deal:P_B:P_A:non_aggression_pact:2", "deal_accept"),
      deal("deal_reject:deal:P_B:P_A:non_aggression_pact:2", "deal_reject"),
      deal("deal_propose:P_C:joint_attack", "deal_propose"),
    ];
    const truncated = reservedQuotaTruncate(actions, 96, 8);
    expect(truncated).toHaveLength(96);
    expect(
      truncated.filter((action) => action.kind.startsWith("deal_")),
    ).toHaveLength(3);
  });
});

describe("structured deals flag — AgentRunner meta-action reasons", () => {
  it("keeps hold's reason byte-identical and derives accurate reasons for deal kinds", () => {
    const runner = new AgentRunner({
      username: "Reason Agent",
      log: makeStubLogger(),
    });
    const hold = runner.submitLegalAction({
      id: "hold",
      kind: "hold",
      label: "Hold",
      intent: null,
      risk: { level: "none", score: 0 },
    });
    expect(hold).toEqual({
      accepted: true,
      reason: "hold action selected; no game intent submitted",
      intent: null,
    });
    const propose = runner.submitLegalAction({
      id: "deal_propose:P_B:non_aggression_pact",
      kind: "deal_propose",
      label: "Propose",
      intent: null,
      risk: { level: "low", score: 0.15 },
    });
    expect(propose).toEqual({
      accepted: true,
      reason: "deal_propose action selected; no game intent submitted",
      intent: null,
    });
  });
});

function normalizeRecords(
  records: AgentDecisionRecord[],
): AgentDecisionRecord[] {
  return records.map((record) => {
    expect(typeof record.decidedAt).toBe("number");
    expect(typeof record.decisionLatencyMs).toBe("number");
    return { ...record, decidedAt: 0, decisionLatencyMs: 0 };
  });
}

function stripDealMenuEntries(
  records: AgentDecisionRecord[],
): AgentDecisionRecord[] {
  return records.map((record) => ({
    ...record,
    legalActionIDs: record.legalActionIDs.filter(
      (id) => !id.startsWith("deal_"),
    ),
    legalActionIDsByKind: Object.fromEntries(
      Object.entries(record.legalActionIDsByKind).filter(
        ([kind]) => !kind.startsWith("deal_"),
      ),
    ),
  }));
}

async function runHoldLeague(scripts?: ScriptedPicker[][]): Promise<{
  records: AgentDecisionRecord[];
  observations: string[][];
}> {
  const harness = dealLeagueHarness({
    seats: [A, B, C],
    scripts: scripts ?? [[], [], []],
  });
  for (let step = 0; step < 3; step += 1) {
    await harness.league.runDecisionTurn({ turnNumber: step * 25 });
  }
  return {
    records: harness.records(),
    observations: harness.handles.map((handle) =>
      handle.inputs.map((input) => JSON.stringify(input.observation)),
    ),
  };
}

describe("structured deals flag — league records, observations, telemetry", () => {
  it("flag OFF: repeated runs are byte-identical and contain none of the new surface", async () => {
    delete process.env[DEALS_FLAG];
    const first = await runHoldLeague();
    const second = await runHoldLeague();
    expect(JSON.stringify(normalizeRecords(first.records))).toBe(
      JSON.stringify(normalizeRecords(second.records)),
    );
    expect(JSON.stringify(first.observations)).toBe(
      JSON.stringify(second.observations),
    );
    for (const perSeat of first.observations) {
      for (const observationJson of perSeat) {
        expect(observationJson).not.toContain('"deals"');
      }
    }
    expect(JSON.stringify(first.records)).not.toContain("deal_");
  });

  it("flag ON (no deal selected) adds ONLY menu entries and the observation block: stripping restores the OFF bytes", async () => {
    delete process.env[DEALS_FLAG];
    const off = await runHoldLeague();
    process.env[DEALS_FLAG] = "1";
    const on = await runHoldLeague();

    // Records: identical once the deal menu entries are stripped.
    expect(
      JSON.stringify(normalizeRecords(stripDealMenuEntries(on.records))),
    ).toBe(JSON.stringify(normalizeRecords(off.records)));
    // No deal was selected, so no stamps appear anywhere.
    for (const record of on.records) {
      expect(record.decisionMetadata?.dealAction).toBeUndefined();
      expect(record.decisionMetadata?.dealComplianceEvent).toBeUndefined();
    }

    // Observations: removing exactly the injected `deals` key restores the
    // OFF bytes (key order preserved).
    expect(on.observations.length).toBe(off.observations.length);
    for (let seat = 0; seat < on.observations.length; seat += 1) {
      for (let step = 0; step < on.observations[seat].length; step += 1) {
        const parsed = JSON.parse(on.observations[seat][step]) as {
          deals?: unknown;
        };
        expect(parsed.deals).toBeDefined();
        delete parsed.deals;
        expect(JSON.stringify(parsed)).toBe(off.observations[seat][step]);
      }
    }
  });

  it("flag OFF: a decision that fills the deal slot changes nothing at all", async () => {
    // Every seat asks for a deal in the diplomacy slot every step. With the
    // flag off there is no deal manager, no deal menu entry, and no stamp:
    // records and observations stay byte-identical to the plain hold run.
    delete process.env[DEALS_FLAG];
    const dealSlotScript: ScriptedPicker[] = Array.from({ length: 3 }, () =>
      pickWithDeal(null, "deal_propose:P_B:non_aggression_pact"),
    );
    const baseline = await runHoldLeague();
    const withDealSlot = await runHoldLeague([
      dealSlotScript,
      dealSlotScript,
      dealSlotScript,
    ]);
    expect(JSON.stringify(normalizeRecords(withDealSlot.records))).toBe(
      JSON.stringify(normalizeRecords(baseline.records)),
    );
    expect(JSON.stringify(withDealSlot.observations)).toBe(
      JSON.stringify(baseline.observations),
    );
    expect(JSON.stringify(withDealSlot.records)).not.toContain("deal");
  });

  it("flag OFF: telemetry bytes ignore the flag and any stale deal stamps", async () => {
    delete process.env[DEALS_FLAG];
    const { records } = await runHoldLeague();
    const roster = [A, B, C].map((seat) => ({
      agentID: seat.agentID,
      username: seat.username,
      profile: "diplomatic" as const,
      clientID: `CLNT_${seat.playerID}`,
      brainType: "rule" as const,
    }));
    const build = () =>
      JSON.stringify({
        ...buildAgentSpectatorTelemetry({
          runID: "DEALS_FLAG_TELEMETRY",
          records,
          roster,
        }),
        generatedAt: "normalized",
      });
    delete process.env[DEALS_FLAG];
    const offBytes = build();
    process.env[DEALS_FLAG] = "1";
    expect(build()).toBe(offBytes);

    // Records that DO carry stamps produce zero deal events with the flag off.
    const stamped = records.map((record) => ({
      ...record,
      decisionMetadata: {
        ...record.decisionMetadata,
        dealAction: "propose",
        dealID: "deal:P_A:P_B:non_aggression_pact:0",
        dealApplyAccepted: true,
        dealPublicText: "stale stamp",
        dealCounterpartyID: "P_B",
      },
    }));
    delete process.env[DEALS_FLAG];
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "DEALS_FLAG_TELEMETRY",
      records: stamped,
      roster,
    });
    expect(
      telemetry.events.some((event) => event.kind.startsWith("deal_")),
    ).toBe(false);
  });
});
