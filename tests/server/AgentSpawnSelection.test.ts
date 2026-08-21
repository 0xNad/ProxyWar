import { describe, expect, it } from "vitest";
import {
  buildAgentSpawnPriority,
  MAX_AGENT_SPAWN_PARTICIPANTS,
  MAX_SPAWN_PREFERENCES,
  resolveAgentSpawnSelection,
  validateAgentSpawnBallot,
} from "../../src/server/agents/AgentSpawnSelection";
import { AgentDecision, LegalAction } from "../../src/server/agents/AgentTypes";

describe("sealed ranked spawn selection v2", () => {
  it.each([2, 4, 8, 12, 16, 17, 25])(
    "allocates exactly one unique offered spawn for %i participants",
    (participantCount) => {
      const offeredActions = spawnActions(participantCount);
      const usernames = Array.from(
        { length: participantCount },
        (_, index) =>
          `seat-${String(participantCount - index).padStart(2, "0")}`,
      );
      const priorityOrder = buildAgentSpawnPriority(
        priorityParticipants(usernames),
        3,
      );
      const preference = offeredActions
        .map((action) => action.id)
        .reverse()
        .slice(0, MAX_SPAWN_PREFERENCES);
      const assignments = resolveAgentSpawnSelection({
        offeredActions,
        priorityOrder,
        ballots: usernames.map((username) => ({
          username,
          decision: {
            actionID: preference[0],
            spawnPreferenceActionIDs: preference,
            reason: `${username} ranked the same menu`,
          },
          stageLatencyMs: 5,
        })),
      });

      expect(assignments).toHaveLength(participantCount);
      expect(new Set(assignments.map((entry) => entry.action.id)).size).toBe(
        participantCount,
      );
      expect(assignments.map((entry) => entry.username)).toEqual(priorityOrder);
      expect(
        assignments.every(
          (entry) =>
            entry.evidence.offeredActionIDs.length === participantCount &&
            entry.evidence.normalizedBallotActionIDs.length ===
              participantCount &&
            entry.evidence.submittedBallotActionIDs.length ===
              Math.min(participantCount, MAX_SPAWN_PREFERENCES) &&
            entry.evidence.ballotValid &&
            !entry.evidence.stageFallbackUsed,
        ),
      ).toBe(true);
    },
  );

  it("is invariant to ballot array/arrival order", () => {
    const offeredActions = spawnActions(4);
    const usernames = ["zulu", "alpha", "mike", "bravo"];
    const priorityOrder = buildAgentSpawnPriority(
      priorityParticipants(usernames),
      1,
    );
    const ballots = usernames.map((username, index) => {
      const ranked = rotate(
        offeredActions.map((action) => action.id),
        index,
      );
      return {
        username,
        decision: {
          actionID: ranked[0],
          spawnPreferenceActionIDs: ranked,
          reason: "ranked",
        },
        stageLatencyMs: index * 7,
      };
    });
    const forward = resolveAgentSpawnSelection({
      offeredActions,
      priorityOrder,
      ballots,
    });
    const reverse = resolveAgentSpawnSelection({
      offeredActions,
      priorityOrder,
      ballots: [...ballots].reverse(),
    });

    expect(assignmentMap(reverse)).toEqual(assignmentMap(forward));
    expect(reverse.map((entry) => entry.evidence.priorityOrder)).toEqual(
      forward.map((entry) => entry.evidence.priorityOrder),
    );
  });

  it("accepts scalar and partial ballots, then completes tails by offered order", () => {
    const offeredActions = spawnActions(4);
    const ids = offeredActions.map((action) => action.id);
    const assignments = resolveAgentSpawnSelection({
      offeredActions,
      priorityOrder: ["alpha", "bravo", "charlie", "delta"],
      ballots: [
        ballot("alpha", { actionID: ids[2], reason: "scalar" }),
        ballot("bravo", {
          actionID: ids[1],
          spawnPreferenceActionIDs: [ids[1], ids[3]],
          reason: "partial",
        }),
        ballot("charlie", { actionID: ids[0], reason: "scalar" }),
        ballot("delta", { actionID: ids[0], reason: "scalar" }),
      ],
    });

    expect(assignments[0].evidence).toMatchObject({
      ballotSource: "scalar-action-id",
      normalizedBallotActionIDs: [ids[2], ids[0], ids[1], ids[3]],
      assignedActionID: ids[2],
      assignedPreferenceRank: 1,
    });
    expect(assignments[1].evidence).toMatchObject({
      ballotSource: "explicit-ranked",
      normalizedBallotActionIDs: [ids[1], ids[3], ids[0], ids[2]],
      assignedActionID: ids[1],
    });
    expect(new Set(assignments.map((entry) => entry.action.id))).toEqual(
      new Set(ids),
    );
  });

  it.each([
    {
      label: "executable action batch",
      decision: (ids: string[]) =>
        ({
          actionID: ids[0],
          actionIDs: [ids[0]],
          reason: "hostile",
        }) as AgentDecision,
      reason: "executable-action-batch-on-spawn",
    },
    {
      label: "duplicate",
      decision: (ids: string[]) =>
        ({
          actionID: ids[0],
          spawnPreferenceActionIDs: [ids[0], ids[0]],
          reason: "hostile",
        }) as AgentDecision,
      reason: "duplicate-preference",
    },
    {
      label: "off-menu",
      decision: (ids: string[]) =>
        ({
          actionID: ids[0],
          spawnPreferenceActionIDs: [ids[0], "spawn:999999"],
          reason: "hostile",
        }) as AgentDecision,
      reason: "off-menu-preference",
    },
    {
      label: "non-string",
      decision: (ids: string[]) =>
        ({
          actionID: ids[0],
          spawnPreferenceActionIDs: [ids[0], 42],
          reason: "hostile",
        }) as unknown as AgentDecision,
      reason: "preference-not-string",
    },
    {
      label: "oversize",
      decision: (ids: string[]) =>
        ({
          actionID: ids[0],
          spawnPreferenceActionIDs: Array.from(
            { length: MAX_SPAWN_PREFERENCES + 1 },
            (_, index) => `spawn:${index + 1}`,
          ),
          reason: "hostile",
        }) as AgentDecision,
      reason: "too-many-preferences",
    },
    {
      label: "scalar/first mismatch",
      decision: (ids: string[]) =>
        ({
          actionID: ids[0],
          spawnPreferenceActionIDs: [ids[1], ids[0]],
          reason: "hostile",
        }) as AgentDecision,
      reason: "first-preference-mismatch",
    },
  ])(
    "invalidates the whole $label ballot and uses offered-order default",
    ({ decision, reason }) => {
      const offeredActions = spawnActions(2);
      const ids = offeredActions.map((action) => action.id);
      const assignments = resolveAgentSpawnSelection({
        offeredActions,
        priorityOrder: ["alpha", "bravo"],
        ballots: [
          ballot("alpha", decision(ids)),
          ballot("bravo", { actionID: ids[0], reason: "valid scalar" }),
        ],
      });

      expect(assignments[0].evidence).toMatchObject({
        ballotValid: false,
        ballotInvalidReason: reason,
        defaultReason: "invalid-ballot",
        normalizedBallotActionIDs: ids,
        stageFallbackUsed: true,
      });
    },
  );

  it("rejects a wrong-kind preference as a whole ballot", () => {
    const spawn = spawnActions(1)[0];
    const hold: LegalAction = {
      id: "hold",
      kind: "hold",
      label: "Hold",
      intent: null,
      risk: { level: "none" },
    };
    expect(
      validateAgentSpawnBallot(
        {
          actionID: spawn.id,
          spawnPreferenceActionIDs: [spawn.id, hold.id],
          reason: "mixed kinds",
        },
        [spawn, hold],
      ),
    ).toEqual({ valid: false, invalidReason: "wrong-kind-preference" });
  });

  it("ignores a syntactically valid provider fallback ballot", () => {
    const offeredActions = spawnActions(2);
    const ids = offeredActions.map((action) => action.id);
    const assignments = resolveAgentSpawnSelection({
      offeredActions,
      priorityOrder: ["alpha", "bravo"],
      ballots: [
        {
          username: "alpha",
          decision: {
            actionID: ids[1],
            spawnPreferenceActionIDs: [ids[1], ids[0]],
            reason: null,
          },
          stageLatencyMs: 25,
          forcedDefaultReason: "brain-fallback",
          stageDegradationReason: "provider unavailable",
        },
        ballot("bravo", { actionID: ids[1], reason: "valid scalar" }),
      ],
    });

    expect(assignments[0].evidence).toMatchObject({
      ballotValid: true,
      defaultReason: "brain-fallback",
      normalizedBallotActionIDs: ids,
      stageFallbackUsed: true,
      stageDegradationReason: "provider unavailable",
      assignedActionID: ids[0],
    });
  });

  it("requires stable unique identities and rotates priority by episode", () => {
    const participants = priorityParticipants(["charlie", "alpha", "bravo"]);
    expect(buildAgentSpawnPriority(participants, 0)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(buildAgentSpawnPriority(participants, 1)).toEqual([
      "bravo",
      "charlie",
      "alpha",
    ]);
    expect(() =>
      buildAgentSpawnPriority(
        [
          { participantID: "same", username: "first" },
          { participantID: "same", username: "second" },
        ],
        0,
      ),
    ).toThrow(/participant ids must be unique/);
  });

  it("never lets a display-name change alter immutable-identity priority", () => {
    const identities = ["player-c", "player-a", "player-b"];
    const original = buildAgentSpawnPriority(
      identities.map((participantID, index) => ({
        participantID,
        username: ["alpha", "bravo", "charlie"][index],
      })),
      1,
    );
    const renamed = buildAgentSpawnPriority(
      identities.map((participantID, index) => ({
        participantID,
        username: ["zzz", "aaa", "mmm"][index],
      })),
      1,
    );

    expect(original).toEqual(["player-b", "player-c", "player-a"]);
    expect(renamed).toEqual(original);
  });

  it("supports the canonical 25-seat ceiling independently of the 16-entry ballot cap", () => {
    const usernames = Array.from(
      { length: MAX_AGENT_SPAWN_PARTICIPANTS },
      (_, index) => `seat-${String(index + 1).padStart(2, "0")}`,
    );

    expect(
      buildAgentSpawnPriority(priorityParticipants(usernames.slice(0, 17)), 0),
    ).toHaveLength(17);
    expect(
      buildAgentSpawnPriority(priorityParticipants(usernames), 24),
    ).toHaveLength(25);
    expect(() =>
      buildAgentSpawnPriority(
        priorityParticipants([...usernames, "seat-26"]),
        0,
      ),
    ).toThrow(/expected 1-25 participants/);

    const offeredActions = spawnActions(MAX_AGENT_SPAWN_PARTICIPANTS);
    const authored = offeredActions
      .map((action) => action.id)
      .reverse()
      .slice(0, MAX_SPAWN_PREFERENCES);
    const assignments = resolveAgentSpawnSelection({
      offeredActions,
      priorityOrder: buildAgentSpawnPriority(
        priorityParticipants(usernames),
        0,
      ),
      ballots: usernames.map((username) =>
        ballot(username, {
          actionID: authored[0],
          spawnPreferenceActionIDs: authored,
          reason: "bounded authored ballot",
        }),
      ),
    });

    expect(assignments).toHaveLength(25);
    expect(new Set(assignments.map((entry) => entry.action.id)).size).toBe(25);
    expect(
      assignments.every(
        (entry) =>
          entry.evidence.submittedBallotCount === MAX_SPAWN_PREFERENCES &&
          entry.evidence.normalizedBallotActionIDs.length === 25 &&
          entry.evidence.ballotValid,
      ),
    ).toBe(true);
  });

  it("uses stable participant ids to allocate safely across duplicate display names", () => {
    const offeredActions = spawnActions(2);
    const ids = offeredActions.map((action) => action.id);
    const participants = [
      { participantID: "seat-z", username: "Foo" },
      { participantID: "seat-a", username: "Foo" },
    ];
    const priorityOrder = buildAgentSpawnPriority(participants, 0);
    const assignments = resolveAgentSpawnSelection({
      offeredActions,
      priorityOrder,
      ballots: [...participants].reverse().map((participant) => ({
        ...participant,
        decision: { actionID: ids[0], reason: "same display name" },
        stageLatencyMs: 1,
      })),
    });

    expect(priorityOrder).toEqual(["seat-a", "seat-z"]);
    expect(assignments.map((entry) => entry.participantID)).toEqual([
      "seat-a",
      "seat-z",
    ]);
    expect(assignments.map((entry) => entry.username)).toEqual(["Foo", "Foo"]);
    expect(new Set(assignments.map((entry) => entry.action.id)).size).toBe(2);
    expect(assignments[0].evidence).toMatchObject({
      participantID: "seat-a",
      priorityParticipantIDs: ["seat-a", "seat-z"],
      priorityOrder: ["Foo", "Foo"],
    });
  });
});

function spawnActions(count: number): LegalAction[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `spawn:${index + 1}`,
    kind: "spawn" as const,
    label: `Spawn ${index + 1}`,
    intent: { type: "spawn" as const, tile: index + 1 },
    risk: { level: "medium" as const },
  }));
}

function priorityParticipants(
  participantIDs: readonly string[],
): Array<{ participantID: string; username: string }> {
  return participantIDs.map((participantID) => ({
    participantID,
    username: `display-${participantID}`,
  }));
}

function ballot(username: string, decision: AgentDecision) {
  return { username, decision, stageLatencyMs: 1 };
}

function rotate<T>(values: T[], offset: number): T[] {
  const normalized = offset % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

function assignmentMap(
  assignments: ReturnType<typeof resolveAgentSpawnSelection>,
): Record<string, string> {
  return Object.fromEntries(
    assignments.map((entry) => [entry.username, entry.action.id]),
  );
}
