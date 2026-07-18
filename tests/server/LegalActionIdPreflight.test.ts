import { describe, expect, it } from "vitest";
import { inspectDecisionLegalActionIDs } from "../../coworld-adapter/src/legal-action-id-preflight";

function row(input: {
  ids: Record<string, string[]>;
  canonicalIDs?: string[];
  selected: string;
  sequence?: number;
  turnNumber?: number;
}) {
  return {
    sequence: input.sequence ?? 1,
    turnNumber: input.turnNumber ?? 100,
    legalActionIDs:
      input.canonicalIDs ?? Object.values(input.ids).flatMap((ids) => ids),
    legalActionIDsByKind: input.ids,
    selectedLegalActionId: input.selected,
  };
}

describe("LegalAction.id replay preflight", () => {
  it("passes only when every selected id is uniquely offered", () => {
    const report = inspectDecisionLegalActionIDs([
      row({
        ids: {
          attack: ["attack:RIVAL:25", "attack:RIVAL:40"],
          hold: ["hold"],
        },
        selected: "attack:RIVAL:40",
      }),
    ]);

    expect(report).toEqual({
      schemaVersion: 1,
      gatePassed: true,
      decisionRows: 1,
      offeredActionIDs: 3,
      source: {
        replayPath: null,
        replaySha256: null,
      },
      issues: [],
    });
  });

  it("fails closed when there are no decision rows", () => {
    const report = inspectDecisionLegalActionIDs([]);

    expect(report.gatePassed).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ type: "missing_decision_rows" }),
    ]);
  });

  it("uses canonical legalActionIDs and rejects grouped-summary drift", () => {
    const report = inspectDecisionLegalActionIDs([
      row({
        ids: { hold: ["hold"] },
        canonicalIDs: [
          "quick_chat:ALLY:attack.focus",
          "quick_chat:ALLY:attack.focus",
          "hold",
        ],
        selected: "hold",
      }),
    ]);

    expect(report.gatePassed).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "duplicate_legal_action_id",
          actionID: "quick_chat:ALLY:attack.focus",
          occurrences: 2,
        }),
        expect.objectContaining({ type: "legal_action_id_group_drift" }),
      ]),
    );
  });

  it("fails on a duplicate offered id even when another id was selected", () => {
    const report = inspectDecisionLegalActionIDs([
      row({
        ids: {
          quick_chat: [
            "quick_chat:ALLY:attack.focus",
            "quick_chat:ALLY:attack.focus",
          ],
          hold: ["hold"],
        },
        selected: "hold",
        sequence: 8,
        turnNumber: 14000,
      }),
    ]);

    expect(report.gatePassed).toBe(false);
    expect(report.issues).toContainEqual({
      rowIndex: 0,
      sequence: 8,
      turnNumber: 14000,
      type: "duplicate_legal_action_id",
      actionID: "quick_chat:ALLY:attack.focus",
      occurrences: 2,
    });
  });

  it("fails when the selected id is missing or ambiguous", () => {
    const missing = inspectDecisionLegalActionIDs([
      row({ ids: { hold: ["hold"] }, selected: "attack:missing:25" }),
    ]);
    const ambiguous = inspectDecisionLegalActionIDs([
      row({
        ids: { quick_chat: ["quick_chat:A:x", "quick_chat:A:x"] },
        selected: "quick_chat:A:x",
      }),
    ]);

    expect(missing.issues).toContainEqual(
      expect.objectContaining({
        type: "selected_not_uniquely_offered",
        actionID: "attack:missing:25",
        occurrences: 0,
      }),
    );
    expect(ambiguous.issues).toContainEqual(
      expect.objectContaining({
        type: "selected_not_uniquely_offered",
        actionID: "quick_chat:A:x",
        occurrences: 2,
      }),
    );
  });
});
