import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const MODULE_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "testing",
  "social-matrix-lib.mjs",
);

async function evidenceModule() {
  return (await import(pathToFileURL(MODULE_FILE).href)) as {
    summarizeSocialRun: (input: Record<string, unknown>) => any;
    aggregateSocialMatrix: (runs: any[]) => any;
    evaluateCommitmentConstruct: (runs: any[], aggregate?: any) => any;
  };
}

function result() {
  return {
    game_id: "PWSAYDPA",
    seed: 424242,
    scores: [0.4, 0.3, 0.2, 0.1],
    winner_slot: null,
    turn_count: 750,
    tick: 750,
    decision_count: 2,
    accepted_decision_count: 2,
    fallback_count: 0,
    degraded_count: 0,
    players: [
      { slot: 0, name: "Social keeper", score: 0.4 },
      { slot: 1, name: "Social defector", score: 0.3 },
    ],
  };
}

function decision(username: string, dealAction?: string) {
  return {
    username,
    turnNumber: 100,
    selectedLegalActionId: "hold",
    selectedActionKind: "hold",
    result: { accepted: true, reason: "accepted", submittedIntent: null },
    fallbackUsed: false,
    llmPlannerDegraded: false,
    legalActionIDsByKind: {
      hold: ["hold"],
      deal_propose: ["deal_propose:other:non_aggression_pact"],
      deal_accept: ["deal_accept:one"],
      deal_reject: ["deal_reject:one"],
    },
    ...(dealAction ? { dealAction } : {}),
  };
}

describe("social matrix evidence", () => {
  it("keeps opportunity denominators separate from selections and abstention", async () => {
    const { summarizeSocialRun } = await evidenceModule();
    const summary = summarizeSocialRun({
      arm: "active",
      seed: 424242,
      map: "Pangaea",
      episodeIndex: 0,
      decisions: [
        decision("Social keeper", "accept"),
        decision("Social deal-blind"),
      ],
      results: result(),
      ledger: {
        finalized: true,
        events: [],
        deals: [
          {
            obligations: [
              { obligorName: "Social keeper", status: "fulfilled" },
              { obligorName: "Social defector", status: "violated" },
              { obligorName: "Social deal-blind", status: "moot" },
            ],
          },
        ],
      },
    });

    expect(summary.byProfile.keeper.dealOpportunities.deal_accept).toEqual({
      decisionWindows: 1,
      offeredActions: 1,
    });
    expect(summary.byProfile.keeper.dealSelections.deal_accept).toBe(1);
    expect(summary.byProfile.keeper.commitmentReliability).toBe(1);
    expect(summary.byProfile.defector.commitmentReliability).toBe(0);
    expect(summary.byProfile["deal-blind"].commitmentReliability).toBeNull();
  });

  it("requires every matched OFF and ignored cell to have identical normalized play", async () => {
    const { summarizeSocialRun, aggregateSocialMatrix } = await evidenceModule();
    const base = {
      seed: 424242,
      map: "Pangaea",
      episodeIndex: 0,
      decisions: [decision("Social keeper")],
      results: result(),
      ledger: null,
    };
    const off = summarizeSocialRun({ ...base, arm: "off" });
    const ignored = summarizeSocialRun({ ...base, arm: "ignored" });
    const passed = aggregateSocialMatrix([off, ignored]);
    expect(passed.nonInterference).toMatchObject({
      completeCells: 1,
      identicalCells: 1,
      passed: true,
    });

    const changed = summarizeSocialRun({
      ...base,
      arm: "ignored",
      decisions: [
        { ...decision("Social keeper"), selectedLegalActionId: "different" },
      ],
    });
    expect(aggregateSocialMatrix([off, changed]).nonInterference.passed).toBe(
      false,
    );
  });

  it("does not validate a partial matrix or reward an abstaining policy", async () => {
    const { summarizeSocialRun, aggregateSocialMatrix } = await evidenceModule();
    const active = summarizeSocialRun({
      arm: "active",
      seed: 161803,
      map: "Pangaea",
      episodeIndex: 0,
      decisions: [decision("Social keeper", "accept")],
      results: { ...result(), seed: 161803, game_id: "PWSJFJF" },
      ledger: {
        finalizedAtStep: 29,
        events: [],
        deals: [
          {
            obligations: [
              { obligorName: "Social keeper", status: "fulfilled" },
              { obligorName: "Social defector", status: "violated" },
            ],
          },
        ],
      },
    });
    const aggregate = aggregateSocialMatrix([active]);
    expect(aggregate.commitmentConstruct).toMatchObject({
      passed: false,
      completeMatrix: true,
      abstentionNotRewarded: true,
    });
    expect(aggregate.byProfile.skeptic.commitmentReliability).toBeNull();
  });
});
