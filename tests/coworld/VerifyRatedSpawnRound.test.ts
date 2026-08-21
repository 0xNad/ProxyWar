import { describe, expect, it } from "vitest";

import { deterministicCoworldPlayerPersistentID } from "../../coworld-adapter/src/coworld-seat-specs";
import { verifyRatedSpawnRound } from "../../coworld-adapter/scripts/verify-rated-spawn-round.mjs";

describe("verify-rated-spawn-round", () => {
  it("accepts a complete 25-episode round with exact identity rotations", () => {
    const playerIDs = Array.from({ length: 16 }, (_, index) => `ply-${index}`);
    const participantIDs = playerIDs.map(
      deterministicCoworldPlayerPersistentID,
    );
    const base = [...participantIDs].sort();
    const episodes = Array.from({ length: 25 }, (_, index) => ({
      id: `ereq-${index}`,
      round_id: "round-verified",
      status: "completed",
      participants: playerIDs.map((player_id, position) => ({
        kind: "policy",
        position,
        player_id,
      })),
    }));
    const results = Object.fromEntries(
      episodes.map((episode, index) => {
        return [
          episode.id,
          {
            spawn_priority: {
              rated_play: true,
              algorithm_version: "sealed-ranked-serial-dictatorship-v2",
              episode_index: 100 + index,
              player_ids: playerIDs,
              participant_ids_by_slot: participantIDs,
              base_priority_participant_ids: base,
              priority_participant_ids: [
                ...base.slice((100 + index) % base.length),
                ...base.slice(0, (100 + index) % base.length),
              ],
            },
          },
        ];
      }),
    );

    expect(verifyRatedSpawnRound(completePage(episodes), results)).toMatchObject({
      ok: true,
      roundID: "round-verified",
      episodeCount: 25,
      firstEpisodeIndex: 100,
      lastEpisodeIndex: 124,
      distinctOffsets: 16,
      distinctAppliedOrders: 16,
    });
  });

  it("rejects a frozen priority even when 25 episode rows are present", () => {
    const playerIDs = ["ply-a", "ply-b"];
    const participantIDs = playerIDs.map(
      deterministicCoworldPlayerPersistentID,
    );
    const base = [...participantIDs].sort();
    const episodes = Array.from({ length: 25 }, (_, index) => ({
      id: `ereq-${index}`,
      round_id: "round-frozen",
      status: "completed",
      participants: playerIDs.map((player_id, position) => ({
        kind: "policy",
        position,
        player_id,
      })),
    }));
    const results = Object.fromEntries(
      episodes.map((episode) => [
        episode.id,
        {
          spawn_priority: {
            rated_play: true,
            algorithm_version: "sealed-ranked-serial-dictatorship-v2",
            episode_index: 0,
            player_ids: playerIDs,
            participant_ids_by_slot: participantIDs,
            base_priority_participant_ids: base,
            priority_participant_ids: base,
          },
        },
      ]),
    );

    expect(() => verifyRatedSpawnRound(completePage(episodes), results)).toThrow(
      /not 25 distinct consecutive values/,
    );
  });

  it("rejects episode rows mixed across rounds", () => {
    const { episodes, results } = validRoundFixture();
    episodes[24] = { ...episodes[24], round_id: "round-other" };

    expect(() => verifyRatedSpawnRound(completePage(episodes), results)).toThrow(
      /one complete round/,
    );
  });

  it("rejects duplicate or noncanonical policy positions", () => {
    const { episodes, results } = validRoundFixture();
    episodes[0] = {
      ...episodes[0],
      participants: episodes[0].participants.map((participant, index) => ({
        ...participant,
        position: index === 1 ? 0 : participant.position,
      })),
    };

    expect(() => verifyRatedSpawnRound(completePage(episodes), results)).toThrow(
      /exact 0-based seat permutation/,
    );
  });

  it("rejects duplicate episode ids", () => {
    const { episodes, results } = validRoundFixture();
    episodes[24] = { ...episodes[24], id: episodes[0].id };

    expect(() => verifyRatedSpawnRound(completePage(episodes), results)).toThrow(
      /repeats episode id/,
    );
  });

  it("rejects an incomplete paginated episode page", () => {
    const { episodes, results } = validRoundFixture();

    expect(() =>
      verifyRatedSpawnRound(
        { entries: episodes, next_cursor: "more-episodes" },
        results,
      ),
    ).toThrow(/pagination-complete/);
    expect(() => verifyRatedSpawnRound(episodes, results)).toThrow(
      /pagination-complete/,
    );
  });
});

function validRoundFixture() {
  const playerIDs = ["ply-a", "ply-b", "ply-c"];
  const participantIDs = playerIDs.map(deterministicCoworldPlayerPersistentID);
  const base = [...participantIDs].sort();
  const episodes = Array.from({ length: 25 }, (_, index) => ({
    id: `ereq-valid-${index}`,
    round_id: "round-valid",
    status: "completed",
    participants: playerIDs.map((player_id, position) => ({
      kind: "policy",
      position,
      player_id,
    })),
  }));
  const results = Object.fromEntries(
    episodes.map((episode, index) => {
      const episodeIndex = 200 + index;
      const offset = episodeIndex % base.length;
      return [
        episode.id,
        {
          spawn_priority: {
            rated_play: true,
            algorithm_version: "sealed-ranked-serial-dictatorship-v2",
            episode_index: episodeIndex,
            player_ids: playerIDs,
            participant_ids_by_slot: participantIDs,
            base_priority_participant_ids: base,
            priority_participant_ids: [
              ...base.slice(offset),
              ...base.slice(0, offset),
            ],
          },
        },
      ];
    }),
  );
  return { episodes, results };
}

function completePage<T>(entries: T[]) {
  return { entries, next_cursor: null };
}
