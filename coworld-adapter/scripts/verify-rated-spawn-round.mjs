#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_EPISODES = 25;
const EXPECTED_ALGORITHM = "sealed-ranked-serial-dictatorship-v2";
const UUID_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");

export function verifyRatedSpawnRound(episodeRows, resultByEpisodeID) {
  if (
    episodeRows === null ||
    typeof episodeRows !== "object" ||
    !Array.isArray(episodeRows.entries) ||
    episodeRows.next_cursor !== null
  ) {
    throw new Error(
      "rated spawn round requires one pagination-complete Coworld episode page",
    );
  }
  const episodes = episodeRows.entries;
  if (episodes === null || episodes.length !== EXPECTED_EPISODES) {
    throw new Error(
      `rated spawn round requires exactly ${EXPECTED_EPISODES} episodes`,
    );
  }

  const indices = [];
  const appliedOrders = new Set();
  const offsets = new Set();
  const episodeIDs = new Set();
  const roundIDs = new Set();
  for (const episode of episodes) {
    if (
      episode?.status !== "completed" ||
      typeof episode.id !== "string" ||
      episode.id.length === 0
    ) {
      throw new Error("every rated spawn round episode must be completed");
    }
    if (episodeIDs.has(episode.id)) {
      throw new Error(`rated spawn round repeats episode id ${episode.id}`);
    }
    episodeIDs.add(episode.id);
    if (typeof episode.round_id !== "string" || episode.round_id.length === 0) {
      throw new Error(`${episode.id}: missing round id`);
    }
    roundIDs.add(episode.round_id);
    const result = resultByEpisodeID[episode.id];
    const proof = result?.spawn_priority;
    if (
      proof?.rated_play !== true ||
      proof.algorithm_version !== EXPECTED_ALGORITHM
    ) {
      throw new Error(`${episode.id}: missing rated v2 spawn-priority proof`);
    }
    const arrays = [
      proof.player_ids,
      proof.participant_ids_by_slot,
      proof.base_priority_participant_ids,
      proof.priority_participant_ids,
    ];
    if (
      arrays.some((value) => !Array.isArray(value) || value.length < 2) ||
      new Set(proof.player_ids).size !== proof.player_ids.length ||
      arrays.slice(1).some((value) => new Set(value).size !== value.length) ||
      arrays.some((value) => value.length !== proof.player_ids.length)
    ) {
      throw new Error(`${episode.id}: malformed or non-unique identity proof`);
    }
    const participantIDs = proof.player_ids.map(coworldPersistentID);
    if (!sameStrings(participantIDs, proof.participant_ids_by_slot)) {
      throw new Error(
        `${episode.id}: player ids do not map to participant ids`,
      );
    }
    const publicPolicyParticipants = Array.isArray(episode.participants)
      ? episode.participants.filter(
          (participant) => participant?.kind === "policy",
        )
      : [];
    const positions = publicPolicyParticipants.map(
      (participant) => participant.position,
    );
    const expectedPositions = Array.from(
      { length: proof.player_ids.length },
      (_, position) => position,
    );
    if (
      publicPolicyParticipants.length !== proof.player_ids.length ||
      positions.some((position) => !Number.isSafeInteger(position)) ||
      !sameNumbers(
        [...positions].sort((left, right) => left - right),
        expectedPositions,
      )
    ) {
      throw new Error(
        `${episode.id}: policy positions must be the exact 0-based seat permutation`,
      );
    }
    const publicPlayerIDs = [...publicPolicyParticipants]
      .sort((left, right) => left.position - right.position)
      .map((participant) => participant.player_id);
    if (!sameStrings(publicPlayerIDs, proof.player_ids)) {
      throw new Error(
        `${episode.id}: public participant ids disagree with result proof`,
      );
    }
    const base = [...participantIDs].sort(compareCodeUnits);
    if (!sameStrings(base, proof.base_priority_participant_ids)) {
      throw new Error(`${episode.id}: base identity priority is not canonical`);
    }
    const index = proof.episode_index;
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error(`${episode.id}: invalid episode index`);
    }
    const offset = index % base.length;
    const priority = [...base.slice(offset), ...base.slice(0, offset)];
    if (!sameStrings(priority, proof.priority_participant_ids)) {
      throw new Error(`${episode.id}: priority is not the indexed rotation`);
    }
    indices.push(index);
    offsets.add(offset);
    appliedOrders.add(priority.join("|"));
  }

  if (roundIDs.size !== 1) {
    throw new Error("rated spawn evidence must come from one complete round");
  }

  const sortedIndices = [...indices].sort((left, right) => left - right);
  const expectedIndices = Array.from(
    { length: EXPECTED_EPISODES },
    (_, position) => sortedIndices[0] + position,
  );
  if (!sameNumbers(sortedIndices, expectedIndices)) {
    throw new Error(
      "rated spawn round indices are not 25 distinct consecutive values",
    );
  }
  if (offsets.size < 2 || appliedOrders.size < 2) {
    throw new Error(
      "rated spawn round did not apply genuinely rotating priority",
    );
  }

  return {
    ok: true,
    roundID: [...roundIDs][0],
    episodeCount: episodes.length,
    firstEpisodeIndex: sortedIndices[0],
    lastEpisodeIndex: sortedIndices.at(-1),
    distinctOffsets: offsets.size,
    distinctAppliedOrders: appliedOrders.size,
    algorithmVersion: EXPECTED_ALGORITHM,
  };
}

function coworldPersistentID(playerID) {
  const digest = createHash("sha1")
    .update(UUID_NAMESPACE)
    .update("proxywar-coworld-player-id-v2:", "utf8")
    .update(playerID, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameNumbers(left, right) {
  return sameStrings(left, right);
}

async function main() {
  const [episodesPath, resultsDirectory] = process.argv.slice(2);
  if (!episodesPath || !resultsDirectory) {
    throw new Error(
      "usage: verify-rated-spawn-round.mjs <episodes.json> <results-directory>",
    );
  }
  const episodeRows = JSON.parse(fs.readFileSync(episodesPath, "utf8"));
  const episodes = episodeRows.entries;
  const resultByEpisodeID = Object.fromEntries(
    episodes.map((episode) => [
      episode.id,
      JSON.parse(
        fs.readFileSync(
          path.join(resultsDirectory, `${episode.id}.json`),
          "utf8",
        ),
      ),
    ]),
  );
  process.stdout.write(
    `${JSON.stringify(verifyRatedSpawnRound(episodeRows, resultByEpisodeID), null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
