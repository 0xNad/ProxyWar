import { describe, expect, it, vi } from "vitest";
import { Logger } from "winston";
import {
  competitiveSeatSpecs,
  deterministicCoworldPersistentID,
  proxyWarUsernames,
} from "../../coworld-adapter/src/coworld-seat-specs";
import { PersistentIdSchema } from "../../src/core/Schemas";
import { createAgentParticipants } from "../../src/server/agents/AgentLeagueMatch";
import { buildAgentSpawnPriority } from "../../src/server/agents/AgentSpawnSelection";

function makeLogger(): Logger {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe("Coworld competitive seat specs", () => {
  it("assigns every seat the same neutral competitive profile", () => {
    let nextID = 0;
    const specs = competitiveSeatSpecs(
      [
        { name: "Auri" },
        { name: "daveey" },
        { name: "RelhAlpha" },
        { name: "James Boggs" },
      ],
      27,
      () => `seat-${nextID++}`,
    );

    expect(specs.map((spec) => spec.profile)).toEqual([
      "opportunistic",
      "opportunistic",
      "opportunistic",
      "opportunistic",
    ]);
    expect(specs.map((spec) => spec.persistentID)).toEqual([
      "seat-0",
      "seat-1",
      "seat-2",
      "seat-3",
    ]);
  });

  it("preserves username sanitization and uniqueness", () => {
    expect(
      proxyWarUsernames(
        [{ name: "Auri!!!" }, { name: "Auri???" }, { name: "x" }],
        12,
      ),
    ).toEqual(["Auri", "Auri 2", "Coworld Play"]);
  });

  it("walks past authored suffix collisions independently of input order", () => {
    const players = [
      { name: "Foo 3" },
      { name: "Foo" },
      { name: "Foo!" },
      { name: "Foo 4" },
      { name: "Foo?" },
    ];
    const forward = usernamesByAuthoredName(players, 12);
    const reverse = usernamesByAuthoredName([...players].reverse(), 12);

    expect(reverse).toEqual(forward);
    expect(forward).toEqual({
      "Foo 3": "Foo 3",
      Foo: "Foo",
      "Foo!": "Foo 5",
      "Foo 4": "Foo 4",
      "Foo?": "Foo 6",
    });
    expect(new Set(Object.values(forward)).size).toBe(players.length);
    expect(
      Object.values(forward).every((username) => username.length <= 12),
    ).toBe(true);
  });

  it("assigns exact authored-name clones deterministic occurrence usernames and identities", () => {
    const forward = duplicateParticipantMaterial([
      { name: "Foo 3" },
      { name: "Foo" },
      { name: "Foo" },
    ]);
    const reordered = duplicateParticipantMaterial([
      { name: "Foo" },
      { name: "Foo" },
      { name: "Foo 3" },
    ]);

    expect(reordered.entries).toEqual(forward.entries);
    expect(reordered.priorityOrder).toEqual(forward.priorityOrder);
    expect(forward.entries.map((entry) => entry.username)).toEqual([
      "Foo",
      "Foo 2",
      "Foo 3",
    ]);
    expect(
      new Set(forward.entries.map((entry) => entry.persistentID)).size,
    ).toBe(3);
  });

  it("keeps all 25 maximally truncated colliding names unique without exhausting suffixes", () => {
    const usernames = proxyWarUsernames(
      Array.from({ length: 25 }, () => ({ name: "Foo" })),
      3,
    );

    expect(usernames).toHaveLength(25);
    expect(new Set(usernames).size).toBe(25);
    expect(usernames.every((username) => username.length === 3)).toBe(true);
  });

  it("carries deterministic UUID identities through competitive specs and participants", () => {
    const players = [{ name: "Foo!" }, { name: "Foo?" }, { name: "Foo 3" }];
    const forward = participantMaterial(players);
    const reverse = participantMaterial([...players].reverse());

    expect(reverse.byAuthoredName).toEqual(forward.byAuthoredName);
    expect(reverse.priorityOrder).toEqual(forward.priorityOrder);
    expect(
      Object.values(forward.byAuthoredName).every(
        (entry) =>
          entry.persistentID === entry.runnerPersistentID &&
          PersistentIdSchema.safeParse(entry.persistentID).success,
      ),
    ).toBe(true);
    expect(deterministicCoworldPersistentID("Foo!")).not.toBe(
      deterministicCoworldPersistentID("Foo?"),
    );
    expect(deterministicCoworldPersistentID("Foo", 1)).not.toBe(
      deterministicCoworldPersistentID("Foo", 2),
    );
  });
});

function usernamesByAuthoredName(
  players: Array<{ name: string }>,
  maxLength: number,
): Record<string, string> {
  const usernames = proxyWarUsernames(players, maxLength);
  return Object.fromEntries(
    players.map((player, index) => [player.name, usernames[index]]),
  );
}

function participantMaterial(players: Array<{ name: string }>): {
  byAuthoredName: Record<
    string,
    { username: string; persistentID: string; runnerPersistentID: string }
  >;
  priorityOrder: string[];
} {
  const specs = competitiveSeatSpecs(players, 12);
  const participants = createAgentParticipants(specs, makeLogger());
  return {
    byAuthoredName: Object.fromEntries(
      players.map((player, index) => [
        player.name,
        {
          username: specs[index].username,
          persistentID: specs[index].persistentID,
          runnerPersistentID: participants[index].runner.persistentID,
        },
      ]),
    ),
    priorityOrder: buildAgentSpawnPriority(
      participants.map((participant) => ({
        participantID: participant.runner.persistentID,
        username: participant.spec.username,
      })),
      0,
    ),
  };
}

function duplicateParticipantMaterial(players: Array<{ name: string }>): {
  entries: Array<{ username: string; persistentID: string }>;
  priorityOrder: string[];
} {
  const specs = competitiveSeatSpecs(players, 12);
  const participants = createAgentParticipants(specs, makeLogger());
  const priorityOrder = buildAgentSpawnPriority(
    participants.map((participant) => ({
      participantID: participant.runner.persistentID,
      username: participant.spec.username,
    })),
    0,
  );
  return {
    entries: participants
      .map((participant) => ({
        username: participant.spec.username,
        persistentID: participant.runner.persistentID,
      }))
      .sort(
        (left, right) =>
          (left.username < right.username
            ? -1
            : left.username > right.username
              ? 1
              : 0) ||
          (left.persistentID < right.persistentID
            ? -1
            : left.persistentID > right.persistentID
              ? 1
              : 0),
      ),
    priorityOrder,
  };
}
