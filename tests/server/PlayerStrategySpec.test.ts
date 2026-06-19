import { describe, expect, it } from "vitest";
import type { StrategicPlan } from "../../src/server/agents/AgentPlannerExecutor";
import {
  doctrinePromptSuffix,
  isEmptyStrategySpec,
  loadPlayerStrategySpecFromEnv,
  mergePlayerConstraintsIntoPlan,
  parsePlayerStrategySpec,
  PlayerStrategySpecError,
} from "../../src/server/agents/PlayerStrategySpec";

function basePlan(overrides: Partial<StrategicPlan> = {}): StrategicPlan {
  return {
    planID: "p1",
    objective: "expand_territory",
    targetPlayerId: null,
    rationale: "grow",
    startedAtTick: 0,
    maxDecisionCycles: 3,
    successCriteria: [],
    failureCriteria: [],
    preferredActionKinds: ["build"],
    forbiddenActionKinds: [],
    plannerSource: "real-llm",
    ...overrides,
  };
}

describe("parsePlayerStrategySpec", () => {
  it("parses a full valid spec and ignores unknown fields", () => {
    const spec = parsePlayerStrategySpec({
      posture: "aggressive",
      objectiveBias: "military",
      preferredKinds: ["attack", "boat"],
      forbiddenKinds: ["alliance_request", "break_alliance"],
      tacticalSettings: { expansionRatio: 0.5, maxConcurrentWars: 3 },
      doctrine: "Pressure the strongest player relentlessly.",
      somethingUnknown: 42,
    });
    expect(spec).toMatchObject({
      posture: "aggressive",
      objectiveBias: "military",
      preferredKinds: ["attack", "boat"],
      forbiddenKinds: ["alliance_request", "break_alliance"],
      tacticalSettings: { expansionRatio: 0.5, maxConcurrentWars: 3 },
    });
    expect(spec.doctrine).toContain("Pressure the strongest");
  });

  it("rejects invalid posture, action kinds, and ratios", () => {
    expect(() => parsePlayerStrategySpec({ posture: "berserk" })).toThrow(
      PlayerStrategySpecError,
    );
    expect(() =>
      parsePlayerStrategySpec({ forbiddenKinds: ["nuke", "teleport"] }),
    ).toThrow(/invalid action kind/);
    expect(() =>
      parsePlayerStrategySpec({ tacticalSettings: { reserveRatio: 5 } }),
    ).toThrow(/reserveRatio/);
  });

  it("parses and validates allowKinds", () => {
    const spec = parsePlayerStrategySpec({
      allowKinds: ["alliance_request", "alliance_extend"],
    });
    expect(spec.allowKinds).toEqual(["alliance_request", "alliance_extend"]);
    expect(() =>
      parsePlayerStrategySpec({ allowKinds: ["alliance_request", "fly"] }),
    ).toThrow(/invalid action kind/);
  });

  it("sanitizes and caps the doctrine", () => {
    const spec = parsePlayerStrategySpec({ doctrine: "x".repeat(5000) });
    expect((spec.doctrine ?? "").length).toBeLessThanOrEqual(600);
  });
});

describe("loadPlayerStrategySpecFromEnv", () => {
  it("returns null when unset", () => {
    expect(loadPlayerStrategySpecFromEnv({})).toBeNull();
  });
  it("parses JSON from the env var", () => {
    const spec = loadPlayerStrategySpecFromEnv({
      AI_LEAGUE_PLAYER_STRATEGY_SPEC: '{"posture":"defensive"}',
    });
    expect(spec?.posture).toBe("defensive");
  });
  it("throws loud on invalid JSON", () => {
    expect(() =>
      loadPlayerStrategySpecFromEnv({ AI_LEAGUE_PLAYER_STRATEGY_SPEC: "{bad" }),
    ).toThrow(/not valid JSON/);
  });
});

describe("mergePlayerConstraintsIntoPlan", () => {
  it("returns the plan unchanged for an empty spec", () => {
    const plan = basePlan();
    expect(mergePlayerConstraintsIntoPlan(plan, null)).toBe(plan);
    expect(mergePlayerConstraintsIntoPlan(plan, {})).toBe(plan);
  });

  it("unions forbidden kinds and removes them from preferred", () => {
    const plan = basePlan({
      preferredActionKinds: ["attack", "boat"],
      forbiddenActionKinds: ["nuke"],
    });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      forbiddenKinds: ["attack"],
      preferredKinds: ["boat", "build"],
    });
    expect(merged.forbiddenActionKinds).toEqual(
      expect.arrayContaining(["nuke", "attack"]),
    );
    expect(merged.preferredActionKinds).not.toContain("attack");
    expect(merged.preferredActionKinds).toEqual(
      expect.arrayContaining(["boat", "build"]),
    );
  });

  it("lifts a forbidden kind via allowKinds (custom doctrine overrides a preset block)", () => {
    // The Conqueror preset forbids the alliance kinds; a custom doctrine that wants to
    // ally must be able to lift them. allowKinds removes them from forbiddenActionKinds.
    const plan = basePlan({ forbiddenActionKinds: [] });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      forbiddenKinds: ["alliance_request", "alliance_extend", "break_alliance"],
      allowKinds: ["alliance_request", "alliance_extend", "break_alliance"],
    });
    expect(merged.forbiddenActionKinds).not.toContain("alliance_request");
    expect(merged.forbiddenActionKinds).not.toContain("alliance_extend");
  });

  it("allowKinds also lifts a kind the plan/objective forbade", () => {
    const plan = basePlan({ forbiddenActionKinds: ["nuke", "embargo"] });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      allowKinds: ["nuke"],
    });
    expect(merged.forbiddenActionKinds).not.toContain("nuke");
    expect(merged.forbiddenActionKinds).toContain("embargo");
  });

  it("an explicit allow on attack prevents the pacifist commitment-drop", () => {
    const plan = basePlan({
      commitment: { targetPlayerId: "rivalX", minAttackRatio: 0.25 },
    });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      forbiddenKinds: ["attack"],
      allowKinds: ["attack"],
    });
    expect(merged.commitment).toBeDefined();
    expect(merged.forbiddenActionKinds).not.toContain("attack");
  });

  it("drops an LLM commitment when the player forbids attack (pacifist precedence)", () => {
    const plan = basePlan({
      commitment: { targetPlayerId: "rivalX", minAttackRatio: 0.25 },
    });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      forbiddenKinds: ["attack"],
    });
    expect(merged.commitment).toBeUndefined();
    expect(merged.forbiddenActionKinds).toContain("attack");
  });

  it("keeps attack/boat executable when a commitment exists and attack is not player-forbidden", () => {
    const plan = basePlan({
      forbiddenActionKinds: ["attack", "boat"],
      commitment: { targetPlayerId: "rivalX", minAttackRatio: 0.3 },
    });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      forbiddenKinds: ["nuke"],
    });
    expect(merged.forbiddenActionKinds).toContain("nuke");
    expect(merged.forbiddenActionKinds).not.toContain("attack");
    expect(merged.forbiddenActionKinds).not.toContain("boat");
    expect(merged.commitment).toBeDefined();
  });

  it("merges tactical settings over the plan's", () => {
    const plan = basePlan({
      tacticalSettings: { reserveRatio: 0.2, expansionRatio: 0.3 },
    });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      tacticalSettings: { expansionRatio: 0.6 },
    });
    expect(merged.tacticalSettings).toMatchObject({
      reserveRatio: 0.2,
      expansionRatio: 0.6,
    });
  });

  it("seeds a seek_alliance directive for a diplomacy objectiveBias", () => {
    const merged = mergePlayerConstraintsIntoPlan(basePlan(), {
      objectiveBias: "diplomacy",
    });
    expect(merged.allianceDirective).toEqual({ stance: "seek_alliance" });
  });

  it("seeds a seek_alliance directive for a diplomatic posture", () => {
    const merged = mergePlayerConstraintsIntoPlan(basePlan(), {
      posture: "diplomatic",
    });
    expect(merged.allianceDirective).toEqual({ stance: "seek_alliance" });
  });

  it("does not seed an alliance directive for a military/aggressive spec", () => {
    const merged = mergePlayerConstraintsIntoPlan(basePlan(), {
      objectiveBias: "military",
      posture: "aggressive",
    });
    expect(merged.allianceDirective).toBeUndefined();
  });

  it("does not override an alliance directive the Commander already set", () => {
    const plan = basePlan({
      allianceDirective: { stance: "hold_alliance", targetPlayerId: "ally1" },
    });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      objectiveBias: "diplomacy",
    });
    expect(merged.allianceDirective).toEqual({
      stance: "hold_alliance",
      targetPlayerId: "ally1",
    });
  });

  it("a diplomacy spec drops an existing commitment (single-directive invariant)", () => {
    const plan = basePlan({
      commitment: { targetPlayerId: "rivalX", minAttackRatio: 0.25 },
    });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      objectiveBias: "diplomacy",
    });
    expect(merged.allianceDirective).toEqual({ stance: "seek_alliance" });
    expect(merged.commitment).toBeUndefined();
  });

  it("a diplomacy spec drops a buildDirective (single-directive invariant: alliance > build)", () => {
    const plan = basePlan({ buildDirective: { unit: "City" } });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      objectiveBias: "diplomacy",
    });
    expect(merged.allianceDirective).toEqual({ stance: "seek_alliance" });
    expect(merged.buildDirective).toBeUndefined();
  });

  it("drops a buildDirective when the player forbids build", () => {
    const plan = basePlan({ buildDirective: { unit: "any" } });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      forbiddenKinds: ["build"],
    });
    expect(merged.buildDirective).toBeUndefined();
  });

  it("keeps a buildDirective when the spec does not conflict", () => {
    const plan = basePlan({ buildDirective: { unit: "Factory" } });
    const merged = mergePlayerConstraintsIntoPlan(plan, {
      preferredKinds: ["build"],
    });
    expect(merged.buildDirective).toEqual({ unit: "Factory" });
  });
});

describe("doctrinePromptSuffix", () => {
  it("is empty for an empty spec", () => {
    expect(doctrinePromptSuffix(null)).toBe("");
    expect(doctrinePromptSuffix({})).toBe("");
  });
  it("summarizes set fields and frames them defensively", () => {
    const suffix = doctrinePromptSuffix({
      posture: "diplomatic",
      preferredKinds: ["alliance_request"],
      forbiddenKinds: ["nuke"],
      doctrine: "Ally early, never nuke.",
    });
    expect(suffix).toContain("PLAYER STRATEGY");
    expect(suffix).toContain("do NOT override the rules");
    expect(suffix).toContain("Posture: diplomatic");
    expect(suffix).toContain("alliance_request");
    expect(suffix).toContain("Ally early");
  });

  it("does not report an allowed kind as hard-blocked, and lists it as allowed", () => {
    const suffix = doctrinePromptSuffix({
      forbiddenKinds: ["alliance_request", "nuke"],
      allowKinds: ["alliance_request"],
      doctrine: "Ally everyone.",
    });
    // alliance_request was lifted -> it must NOT appear on the hard-blocked line...
    expect(suffix).toMatch(/hard-blocked\): nuke/);
    expect(suffix).not.toMatch(/hard-blocked\)[^\n]*alliance_request/);
    // ...and it should be surfaced as explicitly allowed.
    expect(suffix).toContain("explicitly allowed for you: alliance_request");
  });
});

describe("isEmptyStrategySpec", () => {
  it("treats null and {} as empty", () => {
    expect(isEmptyStrategySpec(null)).toBe(true);
    expect(isEmptyStrategySpec({})).toBe(true);
    expect(isEmptyStrategySpec({ posture: "aggressive" })).toBe(false);
    expect(isEmptyStrategySpec({ allowKinds: ["alliance_request"] })).toBe(
      false,
    );
  });
});
