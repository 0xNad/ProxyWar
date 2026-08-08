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

function gameID(seed: number): string {
  let remaining = seed;
  const encoded = Array.from({ length: 5 }, () => "A");
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = String.fromCharCode(65 + (remaining % 26));
    remaining = Math.floor(remaining / 26);
  }
  return `PWS${encoded.join("")}`;
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

function decision(
  username: string,
  dealAction?: string,
  applicationAccepted = true,
) {
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
    ...(dealAction
      ? {
          dealAction,
          dealSlotEvidence: {
            requestedActionID: `deal_${dealAction}:one`,
            validation: { accepted: true },
            application: {
              attempted: true,
              accepted: applicationAccepted,
            },
          },
        }
      : {}),
  };
}

async function completeMatrix(options?: {
  developmentKeeperStatus?: "fulfilled" | "violated";
  developmentDefectorStatus?: "fulfilled" | "violated";
}) {
  const { summarizeSocialRun } = await evidenceModule();
  const runs = [];
  for (const seed of [173205, 223607, 424242]) {
    for (const map of ["Pangaea", "Europe"]) {
      for (const episodeIndex of [0, 1, 2, 3]) {
        const base = {
          seed,
          map,
          episodeIndex,
          decisions: [decision("Social keeper")],
          results: {
            ...result(),
            game_id: gameID(seed),
            seed,
            decision_count: 1,
            accepted_decision_count: 1,
          },
        };
        runs.push(summarizeSocialRun({ ...base, arm: "off", ledger: null }));
        runs.push(
          summarizeSocialRun({
            ...base,
            arm: "ignored",
            ledger: { finalizedAtStep: 29, events: [], deals: [] },
          }),
        );
        runs.push(
          summarizeSocialRun({
            ...base,
            arm: "active",
            ledger: {
              finalizedAtStep: 29,
              events: [],
              deals: [
                {
                  obligations: [
                    {
                      obligorName: "Social keeper",
                      status:
                        seed === 424242
                          ? (options?.developmentKeeperStatus ?? "fulfilled")
                          : "fulfilled",
                    },
                    {
                      obligorName: "Social defector",
                      status:
                        seed === 424242
                          ? (options?.developmentDefectorStatus ?? "violated")
                          : "violated",
                    },
                  ],
                },
              ],
            },
          }),
        );
      }
    }
  }
  return runs;
}

describe("social matrix evidence", () => {
  it("keeps opportunity denominators separate from selections and abstention", async () => {
    const { summarizeSocialRun, aggregateSocialMatrix } =
      await evidenceModule();
    const summary = summarizeSocialRun({
      arm: "active",
      seed: 424242,
      map: "Pangaea",
      episodeIndex: 0,
      decisions: [
        decision("Social keeper", "accept"),
        decision("Social defector", "accept", false),
        decision("Social deal blind"),
      ],
      results: result(),
      ledger: {
        finalized: true,
        events: [],
        deals: [
          {
            status: "accepted",
            proposerName: "Social defector",
            recipientName: "Social keeper",
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
    expect(summary.byProfile.keeper.dealSlotEvidence).toMatchObject({
      requested: 1,
      validationAccepted: 1,
      applicationAttempted: 1,
      applicationAccepted: 1,
      applicationRejected: 0,
    });
    expect(summary.byProfile.defector.dealSlotEvidence).toMatchObject({
      requested: 1,
      validationAccepted: 1,
      applicationAttempted: 1,
      applicationAccepted: 0,
      applicationRejected: 1,
    });
    expect(summary.byProfile.keeper.acceptedDealsWith.defector).toBe(1);
    expect(summary.byProfile.defector.acceptedDealsWith.keeper).toBe(1);
    expect(summary.byProfile["deal-blind"].decisions).toBe(1);
    expect(summary.byProfile.keeper.commitmentReliability).toBe(1);
    expect(summary.byProfile.defector.commitmentReliability).toBe(0);
    expect(summary.byProfile["deal-blind"].commitmentReliability).toBeNull();
    const aggregate = aggregateSocialMatrix([summary]);
    expect(aggregate.byProfile.keeper.dealSlotEvidence).toMatchObject({
      requested: 1,
      applicationAccepted: 1,
    });
    expect(aggregate.byProfile.defector.acceptedDealsWith.keeper).toBe(1);
  });

  it("requires every matched OFF and ignored cell to have identical normalized play", async () => {
    const { summarizeSocialRun, aggregateSocialMatrix } =
      await evidenceModule();
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
    const { summarizeSocialRun, aggregateSocialMatrix } =
      await evidenceModule();
    const active = summarizeSocialRun({
      arm: "active",
      seed: 161803,
      map: "Pangaea",
      episodeIndex: 0,
      decisions: [decision("Social keeper", "accept")],
      results: { ...result(), seed: 161803, game_id: "PWSAJFJF" },
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
      completeMatrix: false,
      exactAxes: false,
      abstentionNotRewarded: true,
    });
    expect(aggregate.byProfile.skeptic.commitmentReliability).toBeNull();
  });

  it("requires exactly one run for every cell in the full Cartesian matrix", async () => {
    const { aggregateSocialMatrix } = await evidenceModule();
    const runs = await completeMatrix();
    expect(aggregateSocialMatrix(runs).commitmentConstruct.passed).toBe(true);

    const malformed = [...runs];
    malformed[malformed.length - 1] = structuredClone(malformed[0]);
    const aggregate = aggregateSocialMatrix(malformed);
    expect(aggregate).toMatchObject({
      runCount: 72,
      commitmentConstruct: { completeMatrix: false, passed: false },
    });
    expect(
      aggregate.nonInterference.cells.some(
        (cell: { offCount: number; ignoredCount: number }) =>
          cell.offCount > 1 || cell.ignoredCount > 1,
      ),
    ).toBe(true);
  });

  it("requires the exact seed-derived game identity in every run", async () => {
    const { aggregateSocialMatrix } = await evidenceModule();
    const runs = await completeMatrix();
    for (const run of runs) run.gameID = "";
    expect(aggregateSocialMatrix(runs).commitmentConstruct).toMatchObject({
      provenanceComplete: false,
      passed: false,
    });
  });

  it("enforces reliability thresholds overall as well as on held-out seeds", async () => {
    const { aggregateSocialMatrix } = await evidenceModule();
    const runs = await completeMatrix({
      developmentKeeperStatus: "violated",
      developmentDefectorStatus: "fulfilled",
    });
    const construct = aggregateSocialMatrix(runs).commitmentConstruct;
    expect(construct.policies.keeper).toMatchObject({
      heldOut: { commitmentReliability: 1 },
      overall: { commitmentReliability: 2 / 3 },
      reliabilityPass: true,
      overallReliabilityPass: false,
    });
    expect(construct.passed).toBe(false);
  });

  it("requires finalized ledgers for both enabled arms", async () => {
    const { aggregateSocialMatrix } = await evidenceModule();
    for (const arm of ["active", "ignored"]) {
      const runs = await completeMatrix();
      const run = runs.find((candidate) => candidate.arm === arm)!;
      run.ledgerFinalized = false;
      const construct = aggregateSocialMatrix(runs).commitmentConstruct;
      expect(construct.enabledLedgersFinalized).toBe(false);
      expect(construct.passed).toBe(false);
    }
  });

  it("rejects any pending obligation in an enabled-arm ledger", async () => {
    const { aggregateSocialMatrix } = await evidenceModule();
    const runs = await completeMatrix();
    const active = runs.find((run) => run.arm === "active")!;
    active.byProfile.keeper.obligations.pending = 1;
    const construct = aggregateSocialMatrix(runs).commitmentConstruct;
    expect(construct.noPendingObligations).toBe(false);
    expect(construct.passed).toBe(false);
  });
});
