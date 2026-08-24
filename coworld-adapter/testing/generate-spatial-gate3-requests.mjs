#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ARM_COWORLDS = Object.freeze({
  off: "cow_0de5b358-36a2-44b0-94cb-2b9742fe0c08",
  structured: "cow_8703e8e6-7ad3-45fe-8d56-2bb78abefd0d",
});

export const SUBJECT_POLICY = "c3f81219-74c0-4527-a65c-bd479ed1e5ce";
export const OPPONENT_POLICY = "582ad94a-9521-4863-8792-813c4553f45f";

export const PHASES = Object.freeze({
  canary: Object.freeze({
    roundsPerMap: 4,
    seedOffset: 0,
    episodeIndexBase: 400,
    requestPrefix: "spatial-gate3-b8",
  }),
  confirmatory: Object.freeze({
    roundsPerMap: 8,
    seedOffset: 10000,
    episodeIndexBase: 500,
    requestPrefix: "spatial-gate3-confirm-b8",
  }),
});

export const MAP_CLASSES = Object.freeze([
  {
    slug: "pangaea",
    variantID: "tournament-4p-pangaea",
    map: "Pangaea",
    mapSize: "Compact",
    players: 4,
    maxDecisionSteps: 300,
    episodeTimeoutSeconds: 2400,
    seedBase: 930100,
  },
  {
    slug: "europe",
    variantID: "tournament-4p-europe",
    map: "Europe",
    mapSize: "Compact",
    players: 4,
    maxDecisionSteps: 300,
    episodeTimeoutSeconds: 2400,
    seedBase: 930200,
  },
  {
    slug: "asia",
    variantID: "tournament-4p-asia",
    map: "Asia",
    mapSize: "Compact",
    players: 4,
    maxDecisionSteps: 300,
    episodeTimeoutSeconds: 2400,
    seedBase: 930300,
  },
  {
    slug: "world",
    variantID: "tournament-8p-world",
    map: "World",
    mapSize: "Normal",
    players: 8,
    maxDecisionSteps: 400,
    episodeTimeoutSeconds: 3000,
    seedBase: 930400,
  },
  {
    slug: "oceania",
    variantID: "tournament-12p-oceania",
    map: "Oceania",
    mapSize: "Normal",
    players: 12,
    maxDecisionSteps: 500,
    episodeTimeoutSeconds: 3600,
    seedBase: 930500,
  },
  {
    slug: "blacksea",
    variantID: "tournament-12p-blacksea",
    map: "BlackSea",
    mapSize: "Normal",
    players: 12,
    maxDecisionSteps: 500,
    episodeTimeoutSeconds: 3600,
    seedBase: 930600,
  },
]);

function armOrder(setIndex) {
  return setIndex % 2 === 0 ? ["off", "structured"] : ["structured", "off"];
}

export function normalizedRequest(request) {
  return {
    ...request,
    idempotency_key: "<arm>",
    target: { ...request.target, coworld_id: "<arm>" },
    notes: "<arm>",
  };
}

export function buildGate3Requests(phase = "canary") {
  const phaseConfig = PHASES[phase];
  if (!phaseConfig) throw new Error(`unknown Gate 3 phase: ${phase}`);
  const entries = [];
  let setIndex = 0;
  for (const mapClass of MAP_CLASSES) {
    for (let mapRound = 0; mapRound < phaseConfig.roundsPerMap; mapRound += 1) {
      const subjectSlot = mapRound % 4;
      const setID = `${mapClass.slug}-r${String(mapRound).padStart(2, "0")}`;
      const roster = Array.from({ length: mapClass.players }, (_, slot) => ({
        player: {
          policy_ref: slot === subjectSlot ? SUBJECT_POLICY : OPPONENT_POLICY,
        },
        slot,
      }));
      for (const arm of armOrder(setIndex)) {
        const request = {
          idempotency_key: `${phaseConfig.requestPrefix}/${setID}/${arm}`,
          target: {
            coworld_id: ARM_COWORLDS[arm],
            variant_id: mapClass.variantID,
          },
          roster,
          num_episodes: 1,
          game_config_overrides: {
            max_decision_steps: mapClass.maxDecisionSteps,
            turns_per_decision_step: 100,
            max_decision_ms: 15000,
            map: mapClass.map,
            map_size: mapClass.mapSize,
            difficulty: "Easy",
            seed: mapClass.seedBase + phaseConfig.seedOffset + mapRound,
            episodeIndex: phaseConfig.episodeIndexBase + setIndex,
            replay_tail_turns: 500,
            player_connect_timeout_seconds: 120,
            num_agents: mapClass.players,
            episode_timeout_seconds: mapClass.episodeTimeoutSeconds,
          },
          execution_backend: "k8s",
          notes: `${phaseConfig.requestPrefix}/${setID}/${arm}`,
        };
        entries.push({
          setIndex,
          setID,
          mapRound,
          subjectSlot,
          arm,
          filename: `${setID}-${arm}.json`,
          request,
        });
      }
      setIndex += 1;
    }
  }
  return entries;
}

export function validateGate3Requests(entries, phase = "canary") {
  const phaseConfig = PHASES[phase];
  if (!phaseConfig) throw new Error(`unknown Gate 3 phase: ${phase}`);
  const expectedSets = MAP_CLASSES.length * phaseConfig.roundsPerMap;
  const expectedRequests = expectedSets * 2;
  if (entries.length !== expectedRequests) {
    throw new Error(
      `expected ${expectedRequests} requests, got ${entries.length}`,
    );
  }
  const bySet = new Map();
  for (const entry of entries) {
    const rows = bySet.get(entry.setID) ?? [];
    rows.push(entry);
    bySet.set(entry.setID, rows);
  }
  if (bySet.size !== expectedSets) {
    throw new Error(`expected ${expectedSets} matched sets, got ${bySet.size}`);
  }
  let offFirst = 0;
  let structuredFirst = 0;
  for (const [setID, rows] of bySet) {
    if (rows.length !== 2 || new Set(rows.map((row) => row.arm)).size !== 2) {
      throw new Error(`${setID} is not one OFF/STRUCTURED pair`);
    }
    const [first, second] = rows;
    if (first.arm === "off") offFirst += 1;
    else structuredFirst += 1;
    if (
      JSON.stringify(normalizedRequest(first.request)) !==
      JSON.stringify(normalizedRequest(second.request))
    ) {
      throw new Error(`${setID} differs outside the treatment Coworld`);
    }
  }
  if (offFirst !== expectedSets / 2 || structuredFirst !== expectedSets / 2) {
    throw new Error(
      `arm order is not balanced: OFF first ${offFirst}, STRUCTURED first ${structuredFirst}`,
    );
  }
  return {
    requestCount: entries.length,
    setCount: bySet.size,
    offFirst,
    structuredFirst,
  };
}

async function main(argv) {
  const outputDirectory = argv.find((argument) => !argument.startsWith("--"));
  const phase =
    argv.find((argument) => argument.startsWith("--phase="))?.slice(8) ??
    "canary";
  const unknownOptions = argv.filter(
    (argument) => argument.startsWith("--") && !argument.startsWith("--phase="),
  );
  if (
    !outputDirectory ||
    argv.filter((argument) => !argument.startsWith("--")).length !== 1 ||
    unknownOptions.length > 0
  ) {
    throw new Error(
      "usage: node generate-spatial-gate3-requests.mjs OUTPUT_DIRECTORY [--phase=canary|confirmatory]",
    );
  }
  const entries = buildGate3Requests(phase);
  const validation = validateGate3Requests(entries, phase);
  const resolved = path.resolve(outputDirectory);
  const requestDirectory = path.join(resolved, "requests");
  await fs.mkdir(requestDirectory, { recursive: true });
  for (const entry of entries) {
    await fs.writeFile(
      path.join(requestDirectory, entry.filename),
      `${JSON.stringify(entry.request, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  await fs.writeFile(
    path.join(resolved, "gate3-index.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        phase,
        sourceCommit: "b8c5c70676e1aee0fe0c31a3546e78679d7cc861",
        generatedBy:
          "coworld-adapter/testing/generate-spatial-gate3-requests.mjs",
        validation,
        entries: entries.map(({ request, ...entry }) => ({
          ...entry,
          idempotencyKey: request.idempotency_key,
          coworldID: request.target.coworld_id,
          variantID: request.target.variant_id,
          seed: request.game_config_overrides.seed,
          episodeIndex: request.game_config_overrides.episodeIndex,
        })),
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  process.stdout.write(
    `${JSON.stringify({ outputDirectory: resolved, ...validation })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
