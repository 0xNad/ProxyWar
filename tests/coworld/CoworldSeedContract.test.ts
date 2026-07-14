import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assembleCoworldReplay,
  assembleCoworldResults,
  assembleCoworldRunnerConfig,
  publicCoworldConfig,
  replayCoworldConfig,
  type CoworldEpisodeConfig,
} from "../../coworld-adapter/src/coworld-episode-output";
import {
  coworldEpisodeSeedContract,
  coworldGameID,
  DEFAULT_COWORLD_GAME_ID,
  MAX_COWORLD_SEED,
  parseCoworldSeed,
  parseCoworldSeedConfig,
} from "../../coworld-adapter/src/coworld-seed";
import { simpleHash } from "../../src/core/Util";
import {
  writeAgentLeagueRunArtifacts,
  type WriteAgentLeagueRunArtifactsInput,
} from "../../src/server/agents/AgentDecisionLogWriter";

const BASE_26 = 26;
const HASH_BASE = 31;

function oldBase36GameID(seed: number): string {
  return `CW${seed.toString(36).toUpperCase().padStart(6, "0")}`;
}

function signedSimpleHash(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }
  return hash;
}

describe("Coworld deterministic seed contract", () => {
  it("preserves the exact legacy game id when seed is omitted", () => {
    expect(coworldGameID(undefined)).toBe("COWRLD01");
    expect(coworldGameID(undefined)).toBe(DEFAULT_COWORLD_GAME_ID);
    expect(coworldEpisodeSeedContract({})).toEqual({
      seed: null,
      gameID: "COWRLD01",
      results: { seed: null, game_id: "COWRLD01" },
      replay: { seed: null, gameID: "COWRLD01" },
      runner: { seed: null, gameID: "COWRLD01" },
    });
  });

  it("maps the same seed to the same valid game id", () => {
    const first = coworldGameID(123456);
    const second = coworldGameID(123456);

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(simpleHash(first)).toBe(simpleHash(second));
  });

  it("eliminates known base-36 collisions in OpenFront's actual simpleHash", () => {
    expect(simpleHash(oldBase36GameID(24))).toBe(
      simpleHash(oldBase36GameID(36)),
    );
    expect(oldBase36GameID(24)).toBe("CW00000O");
    expect(oldBase36GameID(36)).toBe("CW000010");

    expect(simpleHash(coworldGameID(24))).not.toBe(
      simpleHash(coworldGameID(36)),
    );
    expect(simpleHash(coworldGameID(162024))).not.toBe(
      simpleHash(coworldGameID(162036)),
    );
  });

  it("supports both inclusive seed bounds without losing base-26 digits", () => {
    expect(parseCoworldSeed(0)).toBe(0);
    expect(parseCoworldSeed(MAX_COWORLD_SEED)).toBe(MAX_COWORLD_SEED);
    expect(coworldGameID(0)).toBe("CWAAAAAA");
    expect(coworldGameID(MAX_COWORLD_SEED)).toBe("CWZZZZZZ");
    expect(simpleHash(coworldGameID(0))).toBe(1664458284);
    expect(simpleHash(coworldGameID(MAX_COWORLD_SEED))).toBe(924871884);
  });

  it("proves base-31 positional dominance for every suffix length", () => {
    // If two A..Z suffixes first differ at one position, a one-letter increase
    // at that position outweighs the maximum decrease across every later
    // position. Therefore the pre-overflow polynomial is strictly ordered.
    for (let trailingDigits = 0; trailingDigits < 6; trailingDigits += 1) {
      const leadingWeight = HASH_BASE ** trailingDigits;
      const maximumTrailingOffset =
        25 *
        Array.from(
          { length: trailingDigits },
          (_, position) => HASH_BASE ** position,
        ).reduce((sum, weight) => sum + weight, 0);
      expect(leadingWeight).toBeGreaterThan(maximumTrailingOffset);
    }

    // The whole ordered range stays negative without wrapping or crossing zero,
    // so Math.abs reverses the ordering but cannot merge two hashes.
    const firstRawHash = signedSimpleHash(coworldGameID(0));
    const lastRawHash = signedSimpleHash(coworldGameID(MAX_COWORLD_SEED));
    const completeSuffixSpan =
      25 *
      Array.from({ length: 6 }, (_, position) => HASH_BASE ** position).reduce(
        (sum, weight) => sum + weight,
        0,
      );
    expect(firstRawHash).toBe(-1664458284);
    expect(lastRawHash).toBe(-924871884);
    expect(firstRawHash).toBeLessThan(lastRawHash);
    expect(lastRawHash - firstRawHash).toBe(completeSuffixSpan);
    expect(simpleHash(coworldGameID(0))).toBe(Math.abs(firstRawHash));
    expect(simpleHash(coworldGameID(MAX_COWORLD_SEED))).toBe(
      Math.abs(lastRawHash),
    );
  });

  it("exhaustively checks every three-letter prefix interval with real simpleHash", () => {
    // 17,576 prefix intervals cover the complete 26^6 seed range. The
    // positional-dominance proof above makes each interval strictly ordered;
    // checking every adjacent interval boundary proves they are disjoint.
    const bucketSize = BASE_26 ** 3;
    const bucketCount = BASE_26 ** 3;
    let previousLastHash: number | null = null;
    for (let prefix = 0; prefix < bucketCount; prefix += 1) {
      const firstSeed = prefix * bucketSize;
      const lastSeed = firstSeed + bucketSize - 1;
      const firstHash = simpleHash(coworldGameID(firstSeed));
      const lastHash = simpleHash(coworldGameID(lastSeed));

      expect(firstHash).toBeGreaterThan(lastHash);
      if (previousLastHash !== null) {
        expect(previousLastHash).toBeGreaterThan(firstHash);
      }
      previousLastHash = lastHash;
    }
  });

  it.each([
    -1,
    MAX_COWORLD_SEED + 1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
    null,
  ])("rejects an invalid seed (%s)", (seed) => {
    expect(() => parseCoworldSeed(seed)).toThrow(
      `Coworld seed must be an integer from 0 through ${MAX_COWORLD_SEED}`,
    );
  });

  it("validates config input and preserves non-seed fields", () => {
    const config = parseCoworldSeedConfig({
      seed: 42,
      map: "Europe",
      turns_per_decision_step: 100,
    });

    expect(config).toEqual({
      seed: 42,
      map: "Europe",
      turns_per_decision_step: 100,
    });
    expect(() => parseCoworldSeedConfig({ seed: "42" })).toThrow();
    expect(() => parseCoworldSeedConfig(null as never)).toThrow(
      "Coworld config must be an object",
    );
    expect(() => parseCoworldSeedConfig(42 as never)).toThrow(
      "Coworld config must be an object",
    );
  });

  it("propagates parsed episode metadata consistently to every output surface", () => {
    const config = parseCoworldSeedConfig({ seed: 987654, map: "Asia" });
    const episode = coworldEpisodeSeedContract(config);

    expect(episode.gameID).toBe(coworldGameID(config.seed));
    expect(episode.results).toEqual({
      seed: 987654,
      game_id: episode.gameID,
    });
    expect(episode.replay).toEqual({ seed: 987654, gameID: episode.gameID });
    expect(episode.runner).toEqual({ seed: 987654, gameID: episode.gameID });
  });
});

describe.each([
  { label: "seeded", configuredSeed: 162024, expectedSeed: 162024 },
  {
    label: "omitted",
    configuredSeed: undefined,
    expectedSeed: null,
  },
])(
  "no-Docker assembled output contract ($label)",
  ({ configuredSeed, expectedSeed }) => {
    it("propagates through results, replay, public/reload config, and persisted runner metadata", async () => {
      const config: CoworldEpisodeConfig = {
        tokens: ["private-token-0", "private-token-1"],
        players: [{ name: "Alpha" }, { name: "Beta" }],
        max_decision_steps: 300,
        turns_per_decision_step: 100,
        max_decision_ms: 15_000,
        map: "Pangaea",
        map_size: "Compact",
        difficulty: "Easy",
        ...(configuredSeed === undefined ? {} : { seed: configuredSeed }),
      };
      const seedContract = coworldEpisodeSeedContract(config);
      const expectedGameID = coworldGameID(config.seed);
      const results = assembleCoworldResults(
        {
          scores: [0.75, 0.25],
          winner_slot: null,
          turn_count: 300,
          tick: 30_000,
          decision_count: 600,
          accepted_decision_count: 600,
          fallback_count: 0,
          degraded_count: 0,
          players: [],
        },
        seedContract,
      );
      const persistedPublicConfig = JSON.parse(
        JSON.stringify(publicCoworldConfig(config)),
      );
      const replay = assembleCoworldReplay(
        {
          schemaVersion: 1,
          replayKind: "proxywar-coworld-local-poc",
          matchID: expectedGameID,
          config: persistedPublicConfig,
          results,
        },
        seedContract,
      );
      const reloadedConfig = replayCoworldConfig(
        JSON.parse(JSON.stringify(replay)),
      );
      const runnerConfig: NonNullable<
        WriteAgentLeagueRunArtifactsInput["runnerConfig"]
      > = assembleCoworldRunnerConfig(
        {
          turnsPerDecisionStep: 100,
          maxDecisionMs: 15_000,
          maxSteps: 300,
          stepsCompleted: 300,
        },
        seedContract,
      );

      expect(results).toMatchObject({
        seed: expectedSeed,
        game_id: expectedGameID,
      });
      expect(replay).toMatchObject({
        seed: expectedSeed,
        gameID: expectedGameID,
        matchID: expectedGameID,
        results: {
          seed: expectedSeed,
          game_id: expectedGameID,
        },
      });
      if (configuredSeed === undefined) {
        expect(persistedPublicConfig).not.toHaveProperty("seed");
      } else {
        expect(persistedPublicConfig.seed).toBe(configuredSeed);
      }
      expect(reloadedConfig?.seed).toBe(configuredSeed);
      expect(coworldGameID(reloadedConfig?.seed)).toBe(expectedGameID);
      expect(runnerConfig).toMatchObject({
        seed: expectedSeed,
        gameID: expectedGameID,
      });
      expect(runnerConfig.seed).toBe(expectedSeed);
      expect(runnerConfig.gameID).toBe(expectedGameID);

      const rootDir = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), "coworld-seed-contract-"),
      );
      try {
        const artifacts = await writeAgentLeagueRunArtifacts({
          rootDir,
          runID: `seed-contract-${configuredSeed ?? "omitted"}`,
          matchID: expectedGameID,
          scenario: "coworld",
          brainMode: "external-http",
          runnerMode: "step-locked",
          runnerConfig,
          startedAt: Date.UTC(2026, 6, 14),
          completedAt: Date.UTC(2026, 6, 14, 0, 0, 1),
          records: [],
          roster: [],
        });
        const persistedSummary = JSON.parse(
          await fsPromises.readFile(artifacts.summaryPath, "utf8"),
        );
        expect(persistedSummary.runnerConfig).toMatchObject({
          seed: expectedSeed,
          gameID: expectedGameID,
          turnsPerDecisionStep: 100,
          maxSteps: 300,
        });
      } finally {
        await fsPromises.rm(rootDir, { recursive: true, force: true });
      }
    });
  },
);

describe("Coworld manifest seed schema", () => {
  const manifests = [
    "coworld_manifest.json",
    "coworld_manifest_template.json",
    "coworld_manifest_ffa4p.json",
    "coworld_manifest_ffa8p.json",
    "coworld_manifest_ffa10p.json",
    "coworld_manifest_ffa12p.json",
    "coworld_manifest_ffa12p_ab_off.json",
    "coworld_manifest_ffa12p_ab_on.json",
  ];

  it.each(manifests)("declares the same seed/result contract in %s", (name) => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "coworld-adapter", "coworld", name),
        "utf8",
      ),
    );
    const configSeed = manifest.game.config_schema.properties.seed;
    const results = manifest.game.results_schema;

    expect(configSeed).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: MAX_COWORLD_SEED,
    });
    expect(results.required).toEqual(
      expect.arrayContaining(["seed", "game_id"]),
    );
    expect(results.properties.seed).toMatchObject({
      type: ["integer", "null"],
      minimum: 0,
      maximum: MAX_COWORLD_SEED,
    });
    expect(results.properties.game_id).toEqual({
      type: "string",
      pattern: "^[A-Za-z0-9]{8}$",
    });
  });
});
