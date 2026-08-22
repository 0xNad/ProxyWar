import { describe, expect, it } from "vitest";

import {
  buildCommanderXpPreRegistration,
  COMMANDER_XP_GAMEPLAY_MAX_DECISION_STEPS,
  COMMANDER_XP_SPAWN_EXIT_TICK,
  COMMANDER_XP_TERMINAL_TIEBREAK_TICK,
  COMMANDER_XP_TURNS_PER_DECISION_STEP,
  deriveCommanderXpSeeds,
  type CommanderXpPlanInput,
} from "../../src/server/agents/CommanderXpProtocol";

const input: CommanderXpPlanInput = {
  experimentID: "commander-xp-v2-test",
  createdAt: "2026-08-22T13:00:00.000Z",
  behaviorSourceSha: "a69175a30577b3e516f09a2cb0960d4d129b3f33",
  behaviorSourceTreeSha: "b1b88e4a447acb885ed554592d3865af0178314f",
  adapterSourceSha: "2".repeat(40),
  adapterSourceTreeSha: "3".repeat(40),
  sourceDiffManifestSha256: "9".repeat(64),
  sourceProvenanceSha256: "a".repeat(64),
  policyBuildProvenanceDigest: `sha256:${"b".repeat(64)}`,
  gameBuildProvenanceDigest: `sha256:${"c".repeat(64)}`,
  coworldID: "cow_exact",
  coworldVersion: "proxywar-eval:0.1.0",
  coworldManifestSha256: "5".repeat(64),
  coworldGameImageID: "img_eval_game_12345678",
  coworldGameImageDigest: `sha256:${"7".repeat(64)}`,
  canonicalLeagueBindingSnapshotSha256: "8".repeat(64),
  imageDigest: `sha256:${"4".repeat(64)}`,
  bedrockModel: "us.anthropic.claude-sonnet-4-6",
  xpOpenApiSha256:
    "dc32022f7e2850e65232c6f51c7490011483e8948269e975bc177d71f29a3e4f",
  armPolicyVersionIDs: { A: "pvid-a", B: "pvid-b", C: "pvid-c" },
  opponentPolicyVersionIDs: ["pvid-o1", "pvid-o2", "pvid-o3"],
};

describe("Commander XP preregistration v2", () => {
  it("freezes the golden canary seeds", () => {
    expect(
      deriveCommanderXpSeeds("strategic-commander-xp-canary-v1", 4),
    ).toEqual([6_130_757, 2_392_810, 9_309_547, 3_132_975]);
  });

  it("plans exactly four ABC triplets then 48 balanced BC pairs", () => {
    const plan = buildCommanderXpPreRegistration(input);
    expect(plan.providerPreflightRequests).toHaveLength(3);
    expect(
      plan.providerPreflightRequests.map((request) => request.arm),
    ).toEqual(["A", "B", "C"]);
    expect(
      plan.providerPreflightRequests.every(
        (request) =>
          request.subjectSeat === 0 &&
          request.episodeIndex === 0 &&
          request.requestBody.game_config_overrides.max_decision_steps === 1 &&
          request.requestBody.game_config_overrides.turns_per_decision_step ===
            1,
      ),
    ).toBe(true);
    expect(new Set(plan.schedule.preflightSeeds).size).toBe(3);
    expect(plan.schedule.preflightRequestCount).toBe(3);
    const canary = plan.requests.filter((entry) => entry.phase === "canary");
    const confirmatory = plan.requests.filter(
      (entry) => entry.phase === "confirmatory",
    );
    expect(canary).toHaveLength(12);
    expect(confirmatory).toHaveLength(96);
    expect(plan.schedule.confirmatoryPairCount).toBe(48);
    expect(
      canary
        .filter((entry) => entry.replicaIndex === 0)
        .map((entry) => entry.arm),
    ).toEqual(["A", "B", "C"]);
    expect(
      canary
        .filter((entry) => entry.replicaIndex === 1)
        .map((entry) => entry.arm),
    ).toEqual(["A", "C", "B"]);
    const pairOrders = Array.from({ length: 48 }, (_, replicaIndex) =>
      confirmatory
        .filter((entry) => entry.replicaIndex === replicaIndex)
        .map((entry) => entry.arm)
        .join(""),
    );
    expect(pairOrders.filter((order) => order === "BC")).toHaveLength(24);
    expect(pairOrders.filter((order) => order === "CB")).toHaveLength(24);
  });

  it("uses one single-episode request per arm with identical within-pair config", () => {
    const plan = buildCommanderXpPreRegistration(input);
    const pair = plan.requests.filter(
      (entry) => entry.phase === "confirmatory" && entry.replicaIndex === 17,
    );
    expect(pair).toHaveLength(2);
    expect(pair[0]?.seed).toBe(pair[1]?.seed);
    expect(pair[0]?.subjectSeat).toBe(1);
    expect(pair[0]?.episodeIndex).toBe(0);
    expect(pair.every((entry) => entry.requestBody.num_episodes === 1)).toBe(
      true,
    );
    expect(
      pair.every(
        (entry) =>
          entry.requestBody.game_config_overrides.max_decision_steps ===
            COMMANDER_XP_GAMEPLAY_MAX_DECISION_STEPS &&
          entry.requestBody.game_config_overrides.turns_per_decision_step ===
            COMMANDER_XP_TURNS_PER_DECISION_STEP,
      ),
    ).toBe(true);
    expect(
      COMMANDER_XP_GAMEPLAY_MAX_DECISION_STEPS *
        COMMANDER_XP_TURNS_PER_DECISION_STEP +
        COMMANDER_XP_SPAWN_EXIT_TICK,
    ).toBeGreaterThan(COMMANDER_XP_TERMINAL_TIEBREAK_TICK);
    expect(
      pair.every(
        (entry) =>
          entry.requestBody.game_config_overrides.max_decision_ms === 15_000 &&
          entry.requestBody.game_config_overrides.episode_timeout_seconds ===
            6_000,
      ),
    ).toBe(true);
    expect(pair.every((entry) => entry.requestBody.roster.length === 4)).toBe(
      true,
    );
    for (const request of pair) {
      expect(request.requestBody.roster[1]).toEqual({
        player: {
          policy_ref: input.armPolicyVersionIDs[request.arm],
        },
        slot: 1,
      });
    }
    expect(plan.fixedFlags).toEqual({
      STRUCTURED_DEALS: "1",
      FREETEXT_MESSAGES: "1",
      SPATIAL_OBSERVATION: "0",
      SPATIAL_MINIMAP: "0",
      KEYSTONE_PROFILE: "aggressive",
      LLM_TIMEOUT_MS: "12000",
    });
  });

  it("makes all arm argv byte-identical except the final selector", () => {
    const argv = buildCommanderXpPreRegistration(input).identities.runArgv;
    expect(argv.A.slice(0, -1)).toEqual(argv.B.slice(0, -1));
    expect(argv.B.slice(0, -1)).toEqual(argv.C.slice(0, -1));
    expect(argv).toMatchObject({
      A: expect.arrayContaining(["--arm=A"]),
      B: expect.arrayContaining(["--arm=B"]),
      C: expect.arrayContaining(["--arm=C"]),
    });
  });
});
