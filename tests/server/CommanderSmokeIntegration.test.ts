import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { writeAgentLeagueRunArtifacts } from "../../src/server/agents/AgentDecisionLogWriter";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import {
  COMMANDER_GAME_ID_DERIVATION_VERSION,
  commanderGameIDFromSeed,
} from "../../src/server/agents/CommanderExperimentIdentity";
import { MAX_COMMANDER_OPTION_ID_LENGTH } from "../../src/server/agents/CommanderStateBuilder";
import {
  LlmProvider,
  LlmProviderConfigError,
} from "../../src/server/agents/LlmProvider";
import type { CommanderState } from "../../src/server/agents/StrategicCommanderTypes";

// Stage 6 end to end: the real step-locked runAgentLeagueSmoke path, from the
// sealed spawn ballot through genuine active-play decision steps, with the
// opt-in --brain=strategic-commander mode using the binding-first executor for
// active play. The injected Commander provider is the bounded test seam — no network
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

class PrivateTransportCanaryProvider implements LlmProvider {
  readonly providerType = "custom" as const;

  constructor(private readonly canary: string) {}

  async complete(): Promise<string> {
    throw new Error(`transport body: ${this.canary}`);
  }
}

class PrivateUnknownKeyCanaryProvider implements LlmProvider {
  readonly providerType = "custom" as const;

  constructor(private readonly canary: string) {}

  async complete(prompt: string): Promise<string> {
    const state = commanderStateFromPrompt(prompt);
    return JSON.stringify({
      selectedStrategicOptionId: state.options[0]!.id,
      horizonDecisions: 3,
      intent: "bounded fallback test",
      replanTriggers: [],
      unknownTransportBody: this.canary,
    });
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
  it("persists an authoritative finished phase for a bounded require-winner step-locked run", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "commander-require-winner-"),
    );
    const captured: AgentLeagueSmokeArtifactWriterInput[] = [];
    const executionSeed = "commander-require-winner-seed";
    const executionGameID = commanderGameIDFromSeed(executionSeed);
    try {
      await runAgentLeagueSmoke({
        args: [
          "--brain=commander-v0-det",
          "--runner=step-locked",
          "--turns-per-decision-step=100",
          "--max-decision-ms=5000",
          "--agents=1",
          "--max-steps=30",
          "--require-winner",
          "--run-id=commander-require-winner-finished",
        ],
        deterministicSource: {
          seed: executionSeed,
          gameID: executionGameID,
          gameIDDerivation: COMMANDER_GAME_ID_DERIVATION_VERSION,
          createdAtMs: 1_700_000_000_000,
          playbackTurnIntervalMs: 1,
        },
        forceOfferedOrderSpawnBallotForExperiment: true,
        commanderExperimentProvenance: {
          provider: null,
          model: null,
          promptVersion: null,
        },
        allowEnvironmentStrategySpec: false,
        artifactWriter: async (input) => {
          captured.push(input);
          return {};
        },
      });
      expect(captured).toHaveLength(1);
      const smoke = captured[0]!;
      expect(smoke.winner).toBeDefined();
      expect(smoke.artifactInput.winner).toEqual(smoke.winner);
      expect(smoke.artifactInput.finalState?.phase).toBe("finished");
      expect(smoke.artifactInput.runnerConfig).toMatchObject({
        requireWinner: true,
        executionSeed,
        executionGameID,
        executionGameIDDerivation: COMMANDER_GAME_ID_DERIVATION_VERSION,
      });

      const paths = await writeAgentLeagueRunArtifacts({
        ...smoke.artifactInput,
        rootDir,
      });
      const summary = JSON.parse(
        await fs.readFile(paths.summaryPath, "utf8"),
      ) as Record<string, unknown>;
      expect(summary.winner).toEqual(smoke.winner);
      expect(summary.finalState).toMatchObject({ phase: "finished" });
      expect(summary.runnerConfig).toMatchObject({
        requireWinner: true,
        executionSeed,
        executionGameID,
        executionGameIDDerivation: COMMANDER_GAME_ID_DERIVATION_VERSION,
      });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }, 600_000);

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
    expect(smoke.artifactInput.brainMode).toBe("strategic-commander");

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
      expect(record.decisionMetadata?.commanderFidelity).toBeUndefined();
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
      expect(record.decisionMetadata?.commanderFidelity).toMatch(
        /^aligned_(primary|support)$/,
      );
      expect(record.chosenActionKind).not.toBe("spawn");
      expect(record.legalActionIDs).toContain(record.chosenActionID);
    }

    // runAgentLeagueSmoke has already passed auditDecisionEffects after the
    // next delivered core turn. Require at least one non-hold primary that the
    // validator, AgentRunner, and GameServer actually accepted with a submitted
    // canonical intent; offered-id evidence alone would be vacuous.
    const acceptedPrimaries = stamped.filter(
      (record) =>
        record.decisionMetadata?.commanderFidelity === "aligned_primary" &&
        record.chosenActionKind !== "hold" &&
        record.result.accepted &&
        record.result.submittedIntent !== null,
    );
    expect(acceptedPrimaries.length).toBeGreaterThan(0);
    for (const record of acceptedPrimaries) {
      expect(record.result.submittedIntent).toEqual(record.intent);
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

  it("never persists private transport bodies or unknown response keys through selector, brain, and writer", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "commander-private-canary-"),
    );
    const cases = [
      {
        runID: "commander-private-transport",
        canary: "PRIVATE_TRANSPORT_BODY_CANARY_7f31",
        provider: new PrivateTransportCanaryProvider(
          "PRIVATE_TRANSPORT_BODY_CANARY_7f31",
        ),
        failureKind: "transport",
        failureDetail: "Commander selector transport failed",
      },
      {
        runID: "commander-private-unknown-key",
        canary: "PRIVATE_UNKNOWN_KEY_CANARY_29ac",
        provider: new PrivateUnknownKeyCanaryProvider(
          "PRIVATE_UNKNOWN_KEY_CANARY_29ac",
        ),
        failureKind: "parse",
        failureDetail: "Commander selector response could not be parsed",
      },
    ] as const;
    try {
      for (const testCase of cases) {
        const captured: AgentLeagueSmokeArtifactWriterInput[] = [];
        await expect(
          runAgentLeagueSmoke({
            args: [
              "--brain=strategic-commander",
              ...STEP_LOCKED_ARGS,
              "--max-steps=1",
              `--run-id=${testCase.runID}`,
            ],
            artifactWriter: async (input) => {
              captured.push(input);
              return {};
            },
            commanderProviderForTesting: testCase.provider,
          }),
        ).rejects.toThrow(
          "strategic-commander smoke failed certification: no decision carries commanderSelectedStrategicOptionId",
        );
        expect(captured).toHaveLength(1);
        const paths = await writeAgentLeagueRunArtifacts({
          ...captured[0]!.artifactInput,
          rootDir,
        });
        const decisionsJsonl = await fs.readFile(paths.decisionsPath, "utf8");
        const entries = decisionsJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);

        expect(decisionsJsonl).not.toContain(testCase.canary);
        expect(
          JSON.stringify(captured[0]!.artifactInput.records),
        ).not.toContain(testCase.canary);
        expect(entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              commanderSelectionFailureKind: testCase.failureKind,
              plannerParseFailureReason: testCase.failureDetail,
            }),
          ]),
        );
      }
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
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
      "a Commander test provider can only be injected into Commander LLM runs",
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
