import { describe, expect, it } from "vitest";

import {
  assertCommanderXpEnvironment,
  commanderXpArmFromArgv,
  commanderXpProviderPreflightRequired,
} from "./commander-xp-player";

describe("Commander XP hosted player", () => {
  it("accepts exactly one final arm selector", () => {
    expect(commanderXpArmFromArgv(["--arm=A"])).toBe("A");
    expect(commanderXpArmFromArgv(["--arm=B"])).toBe("B");
    expect(commanderXpArmFromArgv(["--arm=C"])).toBe("C");
    expect(() => commanderXpArmFromArgv([])).toThrow(/exactly one/);
    expect(() => commanderXpArmFromArgv(["--arm=A", "extra"])).toThrow(
      /exactly one/,
    );
  });

  it("requires social ON and spatial OFF identically", () => {
    const exact = {
      PROXYWAR_TUNE_STRUCTURED_DEALS: "1",
      PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
      PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
      PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
      PROXYWAR_KEYSTONE_PROFILE: "aggressive",
      PROXYWAR_LLM_TIMEOUT_MS: "12000",
      BEDROCK_MODEL: "us.anthropic.claude-sonnet-4-6",
    };
    expect(assertCommanderXpEnvironment(exact)).toMatchObject({
      model: "us.anthropic.claude-sonnet-4-6",
      profile: "aggressive",
      timeoutMs: 12000,
    });
    expect(() =>
      assertCommanderXpEnvironment({
        ...exact,
        PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1",
      }),
    ).toThrow(/SPATIAL_OBSERVATION=0/);
    expect(() =>
      assertCommanderXpEnvironment({
        ...exact,
        PROXYWAR_KEYSTONE_PROFILE: "diplomatic",
      }),
    ).toThrow(/KEYSTONE_PROFILE=aggressive/);
    expect(() =>
      assertCommanderXpEnvironment({
        ...exact,
        PROXYWAR_LLM_TIMEOUT_MS: "13000",
      }),
    ).toThrow(/LLM_TIMEOUT_MS=12000/);
  });

  it("requires the exact-model provider preflight for all three arms", () => {
    expect(
      (["A", "B", "C"] as const).map((arm) =>
        commanderXpProviderPreflightRequired(arm),
      ),
    ).toEqual([true, true, true]);
  });
});
