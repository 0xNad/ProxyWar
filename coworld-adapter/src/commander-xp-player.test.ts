import { describe, expect, it } from "vitest";

import { commanderCoworldSha256Canonical as sha256Canonical } from "../../src/server/agents/CommanderCoworldRuntime";
import {
  CommanderXpFinalizationBarrier,
  finalizeCommanderXpPlayer,
} from "./commander-xp-finalization";
import {
  assertCommanderXpEnvironment,
  commanderXpArmFromArgv,
  commanderXpBedrockRequest,
  commanderXpProviderPreflightRequired,
  commanderXpSelectorRelevantObservation,
  withoutCommanderXpSocialSlots,
} from "./commander-xp-player";

describe("Commander XP hosted player", () => {
  it("acknowledges only after a delayed artifact upload longer than the old 1.5s close window", async () => {
    const barrier = new CommanderXpFinalizationBarrier([0], 5_000);
    const startedAt = Date.now();
    let uploaded = false;
    await finalizeCommanderXpPlayer({
      drain: async () => undefined,
      upload: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_600));
        uploaded = true;
      },
      acknowledge: (acknowledgement) => {
        expect(uploaded).toBe(true);
        barrier.acknowledge(0, acknowledgement);
      },
    });
    await barrier.wait();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
  }, 7_000);

  it("fails closed when a player disconnects before finalization", async () => {
    const barrier = new CommanderXpFinalizationBarrier([0], 5_000);
    barrier.disconnected(0);
    await expect(barrier.wait()).rejects.toThrow(/before finalization/);
  });
  it("includes normalized self identity in the pre-selector observation hash", () => {
    type Observation = Parameters<
      typeof commanderXpSelectorRelevantObservation
    >[0];
    const base = {
      clientID: "transport-b",
      username: "Commander XP Seat 1",
    } as Observation;
    const sameIdentityDifferentTransport = {
      ...base,
      clientID: "transport-c",
    };
    const confoundedIdentity = {
      ...base,
      username: "commander-xp-C:v18",
    };
    expect(sha256Canonical(commanderXpSelectorRelevantObservation(base))).toBe(
      sha256Canonical(
        commanderXpSelectorRelevantObservation(sameIdentityDifferentTransport),
      ),
    );
    expect(
      sha256Canonical(commanderXpSelectorRelevantObservation(base)),
    ).not.toBe(
      sha256Canonical(
        commanderXpSelectorRelevantObservation(confoundedIdentity),
      ),
    );
  });
  it("accepts exactly one final arm selector", () => {
    expect(commanderXpArmFromArgv(["--arm=A"])).toBe("A");
    expect(commanderXpArmFromArgv(["--arm=B"])).toBe("B");
    expect(commanderXpArmFromArgv(["--arm=C"])).toBe("C");
    expect(() => commanderXpArmFromArgv([])).toThrow(/exactly one/);
    expect(() => commanderXpArmFromArgv(["--arm=A", "extra"])).toThrow(
      /exactly one/,
    );
  });

  it("requires Stage-5 social OFF and spatial OFF identically", () => {
    const exact = {
      PROXYWAR_TUNE_STRUCTURED_DEALS: "0",
      PROXYWAR_TUNE_FREETEXT_MESSAGES: "0",
      PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
      PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
      PROXYWAR_KEYSTONE_PROFILE: "aggressive",
      PROXYWAR_LLM_TIMEOUT_MS: "13500",
      BEDROCK_MODEL: "us.anthropic.claude-sonnet-4-6",
      AWS_REGION: "us-west-2",
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://127.0.0.1:9100",
    };
    expect(assertCommanderXpEnvironment(exact)).toMatchObject({
      model: "us.anthropic.claude-sonnet-4-6",
      profile: "aggressive",
      timeoutMs: 13500,
    });
    expect(() =>
      assertCommanderXpEnvironment({
        ...exact,
        PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
      }),
    ).toThrow(/FREETEXT_MESSAGES=0/);
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
        PROXYWAR_LLM_TIMEOUT_MS: "12000",
      }),
    ).toThrow(/LLM_TIMEOUT_MS=13500/);
    expect(() =>
      assertCommanderXpEnvironment({
        ...exact,
        BEDROCK_MODEL: "anthropic.claude-sonnet-4-6",
      }),
    ).toThrow(/exact Bedrock model ID/);
    expect(
      assertCommanderXpEnvironment({
        ...exact,
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-east-1",
      }),
    ).toMatchObject({ model: "us.anthropic.claude-sonnet-4-6" });
    expect(() =>
      assertCommanderXpEnvironment({
        ...exact,
        AWS_DEFAULT_REGION: "us-east-1",
      }),
    ).toThrow(/consistent Coworld Bedrock region/);
    for (const endpoint of [
      "https://bedrock-runtime.us-west-2.amazonaws.com",
      "http://attacker.invalid:9100",
      "http://127.0.0.1:9100/path",
      "http://127.0.0.1:9100?token=private",
    ]) {
      expect(() =>
        assertCommanderXpEnvironment({
          ...exact,
          AWS_ENDPOINT_URL_BEDROCK_RUNTIME: endpoint,
        }),
      ).toThrow(/sidecar-endpoint-invalid/);
    }
    expect(() => assertCommanderXpEnvironment(exact, "0.29.1")).toThrow(
      /exact Bedrock SDK version/,
    );
  });

  it("pins the complete Bedrock request surface instead of SDK defaults", () => {
    expect(
      commanderXpBedrockRequest(
        "us.anthropic.claude-sonnet-4-6",
        "exact prompt",
      ),
    ).toEqual({
      model: "us.anthropic.claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "exact prompt" }],
    });
  });

  it("cannot add unrelated message or deal slots after the plan-bound decision", () => {
    expect(
      withoutCommanderXpSocialSlots({
        actionID: "hold",
        actionIDs: ["hold"],
        reason: null,
        dealActionID: "deal:unrelated",
        messageActionID: "message:unrelated",
        messageText: "unrelated body",
      }),
    ).toEqual({ actionID: "hold", actionIDs: ["hold"], reason: null });
  });

  it("requires the exact-model provider preflight for all three arms", () => {
    expect(
      (["A", "B", "C"] as const).map((arm) =>
        commanderXpProviderPreflightRequired(arm),
      ),
    ).toEqual([true, true, true]);
  });
});
