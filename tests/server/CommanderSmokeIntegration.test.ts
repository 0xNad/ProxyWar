import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/configuration/ConfigLoader", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/core/configuration/ConfigLoader")
    >();
  return {
    ...actual,
    getServerConfigFromServer: () => ({
      otelEnabled: () => false,
      otelAuthHeader: () => "",
      otelEndpoint: () => "",
      env: () => 0,
    }),
    getServerConfig: () => ({
      otelEnabled: () => false,
    }),
  };
});

import {
  AgentLeagueSmokeArtifactWriterInput,
  runAgentLeagueSmoke,
} from "../../src/scripts/ai-agent-league-smoke";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import { MAX_COMMANDER_OPTION_ID_LENGTH } from "../../src/server/agents/CommanderStateBuilder";
import {
  LlmProvider,
  LlmProviderConfigError,
} from "../../src/server/agents/LlmProvider";
import type { CommanderState } from "../../src/server/agents/StrategicCommanderTypes";

// Stage 6 end to end: the real step-locked runAgentLeagueSmoke path, from the
// sealed spawn ballot through genuine active-play decision steps, with the
// opt-in --brain=strategic-commander mode wrapping the RuleAgentBrain tactical
// policy. The injected Commander provider is the bounded test seam — no network
// credentials or live model are consulted anywhere in this suite.

const STEP_LOCKED_ARGS = [
  "--runner=step-locked",
  "--turns-per-decision-step=25",
  "--max-decision-ms=5000",
];

/**
 * Scripted Commander: parses the real prompt's COMMANDER_STATE_JSON block and
 * selects the first currently exposed StrategicOption, recording every prompt
 * state and every selection it made.
 */
class FirstOptionCommanderProvider implements LlmProvider {
  readonly promptStates: CommanderState[] = [];
  readonly selectedOptionIds: string[] = [];

  async complete(prompt: string): Promise<string> {
    const state = commanderStateFromPrompt(prompt);
    this.promptStates.push(state);
    const first = state.options[0]?.id;
    if (typeof first !== "string") {
      throw new Error("the Commander was consulted without exposed options");
    }
    this.selectedOptionIds.push(first);
    return JSON.stringify({
      selectedStrategicOptionId: first,
      horizonDecisions: 4,
      intent: "stage 6 smoke integration plan",
      replanTriggers: [],
    });
  }
}

/**
 * Simulated live-provider outage: every Commander consultation rejects, so the
 * plan lifecycle's commander_result_absent fallback carries the whole match.
 */
class AlwaysRejectingCommanderProvider implements LlmProvider {
  callCount = 0;

  async complete(): Promise<string> {
    this.callCount += 1;
    throw new Error("simulated Commander provider outage");
  }
}

function commanderStateFromPrompt(prompt: string): CommanderState {
  const startMarker = "COMMANDER_STATE_JSON:\n";
  const endMarker = "\nEND_COMMANDER_STATE_JSON";
  const start = prompt.indexOf(startMarker);
  const end = prompt.lastIndexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error("Commander prompt is missing its state JSON block");
  }
  return JSON.parse(
    prompt.slice(start + startMarker.length, end),
  ) as CommanderState;
}

async function runSmoke(
  args: string[],
  commanderProvider?: LlmProvider,
): Promise<AgentLeagueSmokeArtifactWriterInput> {
  const captured: AgentLeagueSmokeArtifactWriterInput[] = [];
  await runAgentLeagueSmoke({
    args,
    artifactWriter: async (input) => {
      captured.push(input);
      return {};
    },
    ...(commanderProvider === undefined
      ? {}
      : { commanderProviderForTesting: commanderProvider }),
  });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

function commanderStampedRecords(
  records: AgentDecisionRecord[],
): AgentDecisionRecord[] {
  return records.filter(
    (record) =>
      record.decisionMetadata?.commanderSelectedStrategicOptionId !== undefined,
  );
}

describe("StrategicCommander Stage 6 — step-locked smoke integration", () => {
  it("consults the Commander only in active play and stamps bounded metadata on primary decisions", async () => {
    const provider = new FirstOptionCommanderProvider();
    const smoke = await runSmoke(
      [
        "--brain=strategic-commander",
        ...STEP_LOCKED_ARGS,
        "--max-steps=2",
        "--run-id=commander-stage6-smoke-test",
      ],
      provider,
    );

    expect(smoke.executionConfig.brainMode).toBe("strategic-commander");
    // The adapter reports its wrapped RuleAgentBrain tactical policy.
    expect(smoke.artifactInput.brainMode).toBe("rule");

    // Active play consulted the Commander through the real cycle.
    expect(provider.promptStates.length).toBeGreaterThan(0);
    // Every consultation happened during active play: no spawn-phase or other
    // non-active observation ever reached the provider.
    for (const state of provider.promptStates) {
      expect(state.self.phase).toBe("active");
      expect(state.options.length).toBeGreaterThan(0);
    }

    const records = smoke.artifactInput.records;
    const spawnRecords = records.filter(
      (record) => record.chosenActionKind === "spawn",
    );
    expect(spawnRecords.length).toBeGreaterThan(0);
    for (const record of spawnRecords) {
      expect(
        record.decisionMetadata?.commanderSelectedStrategicOptionId,
      ).toBeUndefined();
      expect(
        record.decisionMetadata?.commanderExecutionFallback,
      ).toBeUndefined();
    }

    // Executable plans stamped bounded scalar metadata onto real primary
    // decisions, and every stamped decision is an offered LegalAction.id.
    const stamped = commanderStampedRecords(records);
    expect(stamped.length).toBeGreaterThan(0);
    for (const record of stamped) {
      const selected =
        record.decisionMetadata?.commanderSelectedStrategicOptionId;
      expect(typeof selected).toBe("string");
      expect((selected as string).length).toBeGreaterThan(0);
      expect((selected as string).length).toBeLessThanOrEqual(
        MAX_COMMANDER_OPTION_ID_LENGTH,
      );
      expect(provider.selectedOptionIds).toContain(selected);
      expect(typeof record.decisionMetadata?.commanderExecutionFallback).toBe(
        "boolean",
      );
      expect(record.chosenActionKind).not.toBe("spawn");
      expect(record.legalActionIDs).toContain(record.chosenActionID);
    }
  }, 600_000);

  it("fails post-run certification when the Commander provider always rejects, while the tactical fallback still plays the match", async () => {
    const provider = new AlwaysRejectingCommanderProvider();
    const captured: AgentLeagueSmokeArtifactWriterInput[] = [];
    await expect(
      runAgentLeagueSmoke({
        args: [
          "--brain=strategic-commander",
          ...STEP_LOCKED_ARGS,
          "--max-steps=2",
          "--run-id=commander-stage7-outage-test",
        ],
        artifactWriter: async (input) => {
          captured.push(input);
          return {};
        },
        commanderProviderForTesting: provider,
      }),
    ).rejects.toThrow(
      "strategic-commander smoke failed certification: no decision carries commanderSelectedStrategicOptionId",
    );

    // The Commander was genuinely consulted and every call failed, yet the
    // match itself completed on the lifecycle's fallback plans: artifacts
    // recorded real decisions stamped as fallback selections, and none carries
    // the Commander success evidence.
    expect(provider.callCount).toBeGreaterThan(0);
    expect(captured).toHaveLength(1);
    const records = captured[0]!.artifactInput.records;
    expect(records.length).toBeGreaterThan(0);
    expect(commanderStampedRecords(records)).toEqual([]);
    const fallbackStamped = records.filter(
      (record) =>
        record.decisionMetadata?.commanderFallbackSelectedStrategicOptionId !==
        undefined,
    );
    expect(fallbackStamped.length).toBeGreaterThan(0);
  }, 600_000);

  it("leaves the default --brain=rule run untouched when the mode is absent", async () => {
    const smoke = await runSmoke([
      ...STEP_LOCKED_ARGS,
      "--max-steps=1",
      "--run-id=commander-stage6-rule-baseline-test",
    ]);

    expect(smoke.executionConfig.brainMode).toBe("rule");
    expect(smoke.artifactInput.brainMode).toBe("rule");
    for (const record of smoke.artifactInput.records) {
      const metadataKeys = Object.keys(record.decisionMetadata ?? {});
      expect(metadataKeys.filter((key) => key.startsWith("commander"))).toEqual(
        [],
      );
    }
  }, 600_000);

  it("rejects the provider seam outside --brain=strategic-commander", async () => {
    await expect(
      runSmoke(
        [...STEP_LOCKED_ARGS, "--max-steps=1"],
        new FirstOptionCommanderProvider(),
      ),
    ).rejects.toThrow(
      "a Commander test provider can only be injected into --brain=strategic-commander runs",
    );
  });

  it("fails clearly when the real mode has no OpenRouter configuration", async () => {
    const savedLeagueKey = process.env.AI_LEAGUE_OPENROUTER_API_KEY;
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.AI_LEAGUE_OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(
        runSmoke([
          "--brain=strategic-commander",
          ...STEP_LOCKED_ARGS,
          "--max-steps=1",
        ]),
      ).rejects.toThrow(LlmProviderConfigError);
    } finally {
      if (savedLeagueKey !== undefined) {
        process.env.AI_LEAGUE_OPENROUTER_API_KEY = savedLeagueKey;
      }
      if (savedKey !== undefined) {
        process.env.OPENROUTER_API_KEY = savedKey;
      }
    }
  });
});
