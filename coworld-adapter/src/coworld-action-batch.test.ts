import { describe, expect, it } from "vitest";

import {
  COWORLD_MAX_ACTIONS_PER_DECISION,
  parseCoworldActionBatch,
  withCoworldActionBatchContract,
} from "./coworld-action-batch";

describe("parseCoworldActionBatch", () => {
  it("keeps legacy scalar responses byte-compatible", () => {
    expect(parseCoworldActionBatch("attack:rival", undefined)).toEqual({
      actionIDs: ["attack:rival"],
      wireIssue: null,
    });
    const longLegacyID = "x".repeat(500);
    expect(parseCoworldActionBatch(longLegacyID, undefined).actionIDs).toEqual([
      longLegacyID,
    ]);
  });

  it("accepts an ordered batch whose first id is the scalar primary", () => {
    expect(
      parseCoworldActionBatch("attack:rival", [
        "attack:rival",
        "build:City:100",
        "upgrade:City:100",
      ]),
    ).toEqual({
      actionIDs: ["attack:rival", "build:City:100", "upgrade:City:100"],
      wireIssue: null,
    });
  });

  it("deduplicates and caps a hostile or buggy oversized batch", () => {
    const requested = [
      "attack:rival",
      "build:City:100",
      "build:City:100",
      "upgrade:City:100",
      "build:Factory:101",
      "build:Defense Post:102",
      "build:SAM Launcher:103",
    ];

    const parsed = parseCoworldActionBatch("attack:rival", requested);

    expect(parsed.actionIDs).toEqual([
      "attack:rival",
      "build:City:100",
      "upgrade:City:100",
      "build:Factory:101",
      "build:Defense Post:102",
    ]);
    expect(parsed.actionIDs).toHaveLength(COWORLD_MAX_ACTIONS_PER_DECISION);
    expect(parsed.wireIssue).toMatch(/capped/);
  });

  it("falls back to the scalar primary when the batch is malformed or disagrees", () => {
    expect(
      parseCoworldActionBatch("attack:rival", [
        "build:City:100",
        "attack:rival",
      ]),
    ).toEqual({
      actionIDs: ["attack:rival"],
      wireIssue: "selectedLegalActionIds[0] must equal selectedLegalActionId",
    });
    expect(
      parseCoworldActionBatch("attack:rival", ["attack:rival", 42]),
    ).toEqual({
      actionIDs: ["attack:rival"],
      wireIssue: "selectedLegalActionIds must contain only non-empty strings",
    });
  });
});

describe("withCoworldActionBatchContract", () => {
  it("advertises the optional bounded batch alongside the scalar primary", () => {
    expect(
      withCoworldActionBatchContract({
        protocolVersion: "proxywar-agent-v1",
        responseContract: {
          selectedLegalActionId: "must match one offered id",
          reason: "short string",
        },
      }),
    ).toMatchObject({
      protocolVersion: "proxywar-agent-v1",
      responseContract: {
        selectedLegalActionId: "must match one offered id",
        selectedLegalActionIds:
          "optional ordered array of 1-5 offered legalActions[].id values; first must equal selectedLegalActionId",
        reason: "short string",
      },
    });
  });
});
