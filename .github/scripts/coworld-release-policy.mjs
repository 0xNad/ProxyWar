import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { assertReleaseRecordSafe, policy } from "./trusted-pr-policy.mjs";

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PROVENANCE_PAGE_ID = "proxywar-release-provenance";
const MAP_CONTRACT_FIELDS = {
  map: "map",
  mapSize: "map_size",
  maxDecisionSteps: "max_decision_steps",
  turnsPerDecisionStep: "turns_per_decision_step",
  episodeTimeoutSeconds: "episode_timeout_seconds",
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unexpected fields`,
  );
}

export function provenanceText(sourceSha, metadata = {}) {
  if (!SHA.test(sourceSha))
    throw new Error("source SHA must be 40 lowercase hex characters");
  const entries = [`source_sha=${sourceSha}`];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined || value === "") continue;
    if (!/^[a-z][a-z0-9_]*$/.test(key))
      throw new Error(`invalid provenance key: ${key}`);
    if (!/^[A-Za-z0-9_.:/-]+$/.test(String(value)))
      throw new Error(`invalid provenance value for ${key}`);
    entries.push(`${key}=${value}`);
  }
  return entries.join("\n");
}

export function stampManifest(manifest, sourceSha, metadata = {}) {
  const clone = structuredClone(manifest);
  const pages = clone.game?.docs?.pages;
  if (!Array.isArray(pages))
    throw new Error("manifest game.docs.pages must be an array");
  const page = pages.find((entry) => entry.id === PROVENANCE_PAGE_ID);
  if (!page || page.content?.type !== "text") {
    throw new Error(`manifest is missing ${PROVENANCE_PAGE_ID} text page`);
  }
  page.content.value = provenanceText(sourceSha, metadata);
  return clone;
}

export function extractSourceSha(manifest) {
  const page = manifest?.game?.docs?.pages?.find(
    (entry) =>
      entry.id === PROVENANCE_PAGE_ID && entry.content?.type === "text",
  );
  const match = page?.content?.value?.match(
    /(?:^|\n)source_sha=([0-9a-f]{40})(?:\n|$)/,
  );
  return match?.[1] ?? null;
}

export function assertTemplateRebuildsReplayViewer(template) {
  const bundle = template?.game?.replay_viewer?.bundle;
  if (bundle !== "build/static-replay-viewer") {
    throw new Error(
      `template replay bundle must be build/static-replay-viewer, got ${bundle}`,
    );
  }
  if (String(bundle).startsWith("sha256:"))
    throw new Error("template contains a stale hosted replay bundle");
  return true;
}

export function assertMapRotationContract(manifest, contract) {
  exactKeys(
    contract,
    [
      "schemaVersion",
      "comparisonPoolSeatCounts",
      "competitionRungs",
      "postReleaseMonitoring",
    ],
    "map rotation contract",
  );
  invariant(
    contract.schemaVersion === 1,
    "map rotation contract must use schemaVersion 1",
  );
  invariant(
    Array.isArray(contract.competitionRungs) &&
      contract.competitionRungs.length > 0,
    "map rotation contract must declare competitionRungs",
  );
  const manifestVariants = manifest?.variants;
  invariant(
    Array.isArray(manifestVariants),
    "manifest variants must be an array",
  );
  const variantsById = new Map();
  for (const variant of manifestVariants) {
    invariant(
      typeof variant?.id === "string" && !variantsById.has(variant.id),
      "manifest variant ids must be unique strings",
    );
    variantsById.set(variant.id, variant);
  }
  const manifestMaps = new Set(
    manifest?.game?.config_schema?.properties?.map?.enum ?? [],
  );

  let previousSeats = 0;
  const poolsBySeats = new Map();
  const scheduledVariantIds = new Set();
  for (const rung of contract.competitionRungs) {
    exactKeys(rung, ["seats", "variants"], "map rotation rung");
    invariant(
      Number.isSafeInteger(rung.seats) && rung.seats > previousSeats,
      "map rotation seat counts must be strictly increasing",
    );
    invariant(
      Array.isArray(rung.variants) && rung.variants.length > 0,
      `map rotation rung ${rung.seats} must contain variants`,
    );
    previousSeats = rung.seats;
    const maps = [];
    for (const expected of rung.variants) {
      exactKeys(
        expected,
        ["id", ...Object.keys(MAP_CONTRACT_FIELDS)],
        `map rotation rung ${rung.seats} variant`,
      );
      invariant(
        typeof expected.id === "string" &&
          expected.id.startsWith(`tournament-${rung.seats}p-`) &&
          !scheduledVariantIds.has(expected.id),
        `invalid or duplicate scheduled variant ${expected.id}`,
      );
      invariant(
        typeof expected.map === "string" && manifestMaps.has(expected.map),
        `${expected.id} map is not supported by the manifest schema`,
      );
      scheduledVariantIds.add(expected.id);
      maps.push(expected.map);
      const actual = variantsById.get(expected.id);
      invariant(
        actual !== undefined,
        `${expected.id} is missing from manifest`,
      );
      const gameConfig = actual.game_config;
      invariant(
        gameConfig?.num_agents === rung.seats &&
          Array.isArray(gameConfig.players) &&
          gameConfig.players.length === rung.seats,
        `${expected.id} does not declare exactly ${rung.seats} seats`,
      );
      for (const [contractField, configField] of Object.entries(
        MAP_CONTRACT_FIELDS,
      )) {
        invariant(
          gameConfig[configField] === expected[contractField],
          `${expected.id} ${configField} does not match map rotation contract`,
        );
      }
    }
    invariant(
      new Set(maps).size === maps.length,
      `map rotation rung ${rung.seats} contains duplicate maps`,
    );
    poolsBySeats.set(rung.seats, maps);
  }

  invariant(
    Array.isArray(contract.comparisonPoolSeatCounts) &&
      contract.comparisonPoolSeatCounts.length >= 2,
    "comparisonPoolSeatCounts must identify at least two rungs",
  );
  const comparisonPools = contract.comparisonPoolSeatCounts.map((seats) => {
    invariant(
      Number.isSafeInteger(seats) && poolsBySeats.has(seats),
      `comparison pool references unknown ${seats}-seat rung`,
    );
    return poolsBySeats.get(seats);
  });
  for (const pool of comparisonPools.slice(1)) {
    invariant(
      JSON.stringify(pool) === JSON.stringify(comparisonPools[0]),
      "comparison rungs must use the same ordered map pool",
    );
  }

  exactKeys(
    contract.postReleaseMonitoring,
    [
      "minimumTerminalRoundsPerMap",
      "minimumCompletionRate",
      "minimumScoreBearingCoverage",
      "minimumSpawnValidityCoverage",
      "minimumTelemetryCoverage",
      "minimumReplayIntegrityCoverage",
      "minimumArtifactIntegrityCoverage",
      "warnAtEpisodeTimeoutFraction",
    ],
    "post-release map monitoring contract",
  );
  invariant(
    Number.isSafeInteger(
      contract.postReleaseMonitoring.minimumTerminalRoundsPerMap,
    ) && contract.postReleaseMonitoring.minimumTerminalRoundsPerMap > 0,
    "minimumTerminalRoundsPerMap must be a positive integer",
  );
  for (const field of [
    "minimumCompletionRate",
    "minimumScoreBearingCoverage",
    "minimumSpawnValidityCoverage",
    "minimumTelemetryCoverage",
    "minimumReplayIntegrityCoverage",
    "minimumArtifactIntegrityCoverage",
    "warnAtEpisodeTimeoutFraction",
  ]) {
    const value = contract.postReleaseMonitoring[field];
    invariant(
      typeof value === "number" && value > 0 && value <= 1,
      `${field} must be in (0, 1]`,
    );
  }

  return {
    scheduledVariantIds: [...scheduledVariantIds],
    scheduledMaps: [...new Set([...poolsBySeats.values()].flat())],
    comparisonMaps: [...comparisonPools[0]],
  };
}

export function assertMapResourceFixtures(mapSummary, repositoryRoot = ".") {
  invariant(
    Array.isArray(mapSummary?.scheduledMaps) &&
      mapSummary.scheduledMaps.length > 0,
    "map summary must contain scheduledMaps",
  );
  for (const map of mapSummary.scheduledMaps) {
    invariant(
      typeof map === "string" && /^[A-Za-z0-9]+$/.test(map),
      `unsafe scheduled map label: ${map}`,
    );
    const directory = resolve(
      repositoryRoot,
      "resources",
      "maps",
      map.toLowerCase(),
    );
    const manifestPath = resolve(directory, "manifest.json");
    invariant(
      manifestPath.startsWith(
        `${resolve(repositoryRoot, "resources", "maps")}/`,
      ),
      `unsafe scheduled map fixture path: ${map}`,
    );
    invariant(
      existsSync(manifestPath),
      `${map} map fixture manifest is missing`,
    );
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8"));
    const fixtureIdentity =
      typeof fixture?.name === "string"
        ? fixture.name.replaceAll(" ", "").toLowerCase()
        : "";
    invariant(
      fixtureIdentity === map.toLowerCase(),
      `${map} fixture identity does not match`,
    );
    for (const scale of ["map", "map4x", "map16x"]) {
      invariant(
        Number.isSafeInteger(fixture?.[scale]?.width) &&
          fixture[scale].width > 0 &&
          Number.isSafeInteger(fixture?.[scale]?.height) &&
          fixture[scale].height > 0 &&
          Number.isSafeInteger(fixture?.[scale]?.num_land_tiles) &&
          fixture[scale].num_land_tiles > 0,
        `${map} ${scale} fixture metadata is invalid`,
      );
    }
    for (const filename of [
      "map.bin",
      "map4x.bin",
      "map16x.bin",
      "thumbnail.webp",
    ]) {
      const fixturePath = resolve(directory, filename);
      invariant(
        existsSync(fixturePath) &&
          statSync(fixturePath).isFile() &&
          statSync(fixturePath).size > 0,
        `${map} fixture ${filename} is missing or empty`,
      );
    }
  }
  return true;
}

export function findSourceRelease(coworlds, sourceSha) {
  const matches = (coworlds ?? []).filter(
    (entry) =>
      entry.name === policy.coworld.name &&
      extractSourceSha(entry.manifest) === sourceSha,
  );
  return (
    matches.sort((left, right) =>
      right.version.localeCompare(left.version, undefined, { numeric: true }),
    )[0] ?? null
  );
}

export function versionAllocationDecision(beforeBuild, beforeUpload) {
  if (!VERSION.test(beforeBuild) || !VERSION.test(beforeUpload)) {
    throw new Error("Coworld versions must be semantic x.y.z values");
  }
  return {
    version: beforeUpload,
    collision: beforeBuild !== beforeUpload,
    rebuildManifestAndRecertify: beforeBuild !== beforeUpload,
  };
}

export function certificationGate({
  candidateId,
  certified,
  uploadWasCanonical,
  previousCanonicalId,
  rollbackSupported,
}) {
  if (certified)
    return { action: "verify-canonical-and-league", healthy: false };
  if (!uploadWasCanonical)
    return {
      action: "leave-previous-canonical",
      healthy: false,
      previousCanonicalId,
    };
  if (rollbackSupported)
    return {
      action: "rollback",
      healthy: false,
      targetId: previousCanonicalId,
    };
  return {
    action: "manual-recovery-required",
    healthy: false,
    candidateId,
    previousCanonicalId,
    reason:
      "Coworld upload auto-promoted before certification and exposes no rollback endpoint",
  };
}

export function postPromotionDecision({
  leagueBound,
  replayVerified,
  rollbackSupported,
  previousCanonicalId,
}) {
  if (leagueBound && replayVerified)
    return { action: "complete", healthy: true };
  if (rollbackSupported)
    return {
      action: "rollback",
      healthy: false,
      targetId: previousCanonicalId,
    };
  return {
    action: "manual-recovery-required",
    healthy: false,
    previousCanonicalId,
    reason: !leagueBound ? "league-binding-failed" : "published-replay-failed",
  };
}

export function createReleaseRecord(input) {
  const record = {
    schemaVersion: 1,
    ...input,
  };
  return assertReleaseRecordSafe(record);
}

export function contentHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
