import { Logger } from "winston";
import { Game } from "../../core/game/Game";
import { ServerMessage } from "../../core/Schemas";
import { GameServer } from "../GameServer";
import { AgentDecisionRecord } from "./AgentTypes";
import { auditDecisionEffects } from "./AgentActionAuditor";
import {
  AgentLocalGameMirror,
  waitForMirrorState,
} from "./AgentLocalGameMirror";
import { AgentLeagueMatchRunner } from "./AgentLeagueMatch";

export interface AgentStepLockedLeagueConfig {
  turnsPerDecisionStep: number;
  turnsPerDecisionSchedule?: number[];
  maxSteps: number;
  maxSpawnAdvanceTurns: number;
  maxDecisionMs: number;
  requireWinner: boolean;
  waitForMirrorCatchup: boolean;
  /**
   * Labeled autopilot endgame (operator-approved failsafe, OFF by default):
   * when > 0 and the step cap is reached without a winner, `onAutopilotEngage`
   * fires once and the match continues for up to this many extra decision
   * steps so the replay can complete instead of throwing away the whole run.
   * `requireWinner` still fails loud if even autopilot produces no winner.
   * Only takes effect when the caller provides `onAutopilotEngage` — a silent
   * deterministic continuation with no brain switch is forbidden.
   */
  autopilotExtraSteps: number;
}

export interface RunAgentStepLockedLeagueOptions {
  league: AgentLeagueMatchRunner;
  game: GameServer;
  mirror: AgentLocalGameMirror;
  messages: () => ServerMessage[];
  config?: Partial<AgentStepLockedLeagueConfig>;
  onSnapshot?: (snapshot: {
    label: string;
    turnNumber: number;
    gameState: Game;
    records: AgentDecisionRecord[];
  }) => void;
  /**
   * Swap participants onto labeled deterministic autopilot brains. Required for
   * `autopilotExtraSteps` to take effect; the league itself only extends the
   * step budget and records the switch point.
   */
  onAutopilotEngage?: (input: { step: number }) => void;
  log?: Logger;
}

export interface AgentStepLockedLeagueResult {
  openingRecords: AgentDecisionRecord[];
  postSpawnRecords: AgentDecisionRecord[];
  finalGameState: Game;
  stepsCompleted: number;
  turnsPerDecisionStep: number;
  turnsPerDecisionSchedule: number[] | null;
  maxDecisionMs: number;
  mirrorCatchupSucceeded: boolean;
  postSpawnNonHoldActionCount: number;
  onlyHoldReason: string | null;
  /** Decision step index at which the labeled autopilot endgame engaged, or null. */
  autopilotEngagedAtStep: number | null;
}

const defaultConfig: AgentStepLockedLeagueConfig = {
  turnsPerDecisionStep: 25,
  maxSteps: 1,
  maxSpawnAdvanceTurns: 2_000,
  maxDecisionMs: 120_000,
  requireWinner: false,
  waitForMirrorCatchup: true,
  autopilotExtraSteps: 0,
};

export async function runAgentStepLockedLeague(
  options: RunAgentStepLockedLeagueOptions,
): Promise<AgentStepLockedLeagueResult> {
  const config = { ...defaultConfig, ...options.config };
  const openingRecords = await options.league.runSpawnPhase({
    mirror: options.mirror,
    messages: options.messages,
    turnsPerSpawnTick: turnsForDecisionStep(config, 0),
  });

  let currentGame = await advanceUntil({
    game: options.game,
    mirror: options.mirror,
    messages: options.messages,
    turnsPerStep: turnsForDecisionStep(config, 0),
    maxAdvanceTurns: config.maxSpawnAdvanceTurns,
    until: (state) => !state.inSpawnPhase(),
  });
  auditDecisionEffects({
    records: openingRecords,
    beforeGame: null,
    afterGame: currentGame,
  });
  options.onSnapshot?.({
    label: "After spawn",
    turnNumber: options.mirror.turnCount(),
    gameState: currentGame,
    records: openingRecords,
  });

  const postSpawnRecords: AgentDecisionRecord[] = [];
  let stepsCompleted = 0;
  // Autopilot only arms when the caller wires a brain switch: extending the
  // step budget without swapping to labeled autopilot brains would be the
  // forbidden silent deterministic continuation.
  const autopilotExtraSteps =
    options.onAutopilotEngage !== undefined ? config.autopilotExtraSteps : 0;
  let autopilotEngagedAtStep: number | null = null;
  for (let step = 0; step < config.maxSteps + autopilotExtraSteps; step++) {
    if (currentGame.getWinner() !== null) {
      break;
    }
    if (step >= config.maxSteps && autopilotEngagedAtStep === null) {
      autopilotEngagedAtStep = step;
      options.log?.warn(
        "autopilot endgame engaged: step cap reached without a winner; switching to labeled deterministic autopilot brains",
        {
          step,
          maxSteps: config.maxSteps,
          autopilotExtraSteps,
        },
      );
      options.onAutopilotEngage?.({ step });
    }
    const beforeStepGame = currentGame;
    const records = await options.league.runDecisionTurn({
      turnNumber: options.mirror.turnCount(),
      gameState: currentGame,
      maxDecisionMs: config.maxDecisionMs,
    });
    postSpawnRecords.push(...records);

    const turnsThisStep = turnsForDecisionStep(config, step);
    options.game.advanceTurnsForTesting(turnsThisStep);
    if (config.waitForMirrorCatchup) {
      currentGame = await waitForMirrorState({
        mirror: options.mirror,
        messages: options.messages,
        until: (_state, mirror) => mirror.pendingTurns() === 0,
        timeoutMs: Math.max(1_000, turnsThisStep * 25),
      });
    } else {
      await options.mirror.ingest(options.messages());
      currentGame = requireMirrorGame(options.mirror);
    }
    auditDecisionEffects({
      records,
      beforeGame: beforeStepGame,
      afterGame: currentGame,
    });
    options.onSnapshot?.({
      label: `Post-spawn cycle ${step + 1}${
        autopilotEngagedAtStep !== null ? " (autopilot endgame)" : ""
      }`,
      turnNumber: options.mirror.turnCount(),
      gameState: currentGame,
      records,
    });
    stepsCompleted = step + 1;

    options.log?.info("step-locked decision step complete", {
      step: step + 1,
      turnsThisStep,
      turns: options.mirror.turnCount(),
      tick: currentGame.ticks(),
      records: records.length,
      auditConfirmed: records.filter(
        (record) => record.audit?.auditStatus === "confirmed",
      ).length,
      auditUnknown: records.filter(
        (record) => record.audit?.auditStatus === "unknown",
      ).length,
      auditFailed: records.filter(
        (record) => record.audit?.auditStatus === "failed",
      ).length,
    });
  }

  // Structured-deal ledger force-resolution (PROXYWAR_TUNE_STRUCTURED_DEALS;
  // no-op when the flag is off): every accepted obligation reaches a terminal
  // state at match end, judged against the final audited records. Optional
  // call: test harnesses stub partial league mocks without this method.
  options.league.finalizeDeals?.({ gameState: currentGame });

  if (config.requireWinner && currentGame.getWinner() === null) {
    throw new Error(
      `step-locked full match reached ${config.maxSteps + autopilotExtraSteps} decision steps without a winner` +
        (autopilotEngagedAtStep !== null
          ? ` (autopilot endgame engaged at step ${autopilotEngagedAtStep} and also failed to finish)`
          : ""),
    );
  }

  return {
    openingRecords,
    postSpawnRecords,
    finalGameState: currentGame,
    stepsCompleted,
    turnsPerDecisionStep: config.turnsPerDecisionStep,
    turnsPerDecisionSchedule: config.turnsPerDecisionSchedule ?? null,
    maxDecisionMs: config.maxDecisionMs,
    mirrorCatchupSucceeded: true,
    postSpawnNonHoldActionCount: postSpawnRecords.filter(
      (record) =>
        record.chosenActionKind !== "hold" &&
        record.chosenActionKind !== "spawn",
    ).length,
    onlyHoldReason: onlyHoldReason(postSpawnRecords),
    autopilotEngagedAtStep,
  };
}

function turnsForDecisionStep(
  config: AgentStepLockedLeagueConfig,
  stepIndex: number,
): number {
  return (
    config.turnsPerDecisionSchedule?.[stepIndex] ?? config.turnsPerDecisionStep
  );
}

function onlyHoldReason(records: AgentDecisionRecord[]): string | null {
  if (records.length === 0) {
    return "no post-spawn decisions were recorded";
  }
  const nonHold = records.some(
    (record) =>
      record.chosenActionKind !== "hold" && record.chosenActionKind !== "spawn",
  );
  if (nonHold) {
    return null;
  }
  const onlyHoldOffered = records.every((record) => {
    const kinds = Object.keys(record.legalActionIDsByKind);
    return kinds.length === 1 && kinds[0] === "hold";
  });
  return onlyHoldOffered
    ? "only hold was offered for every post-spawn decision"
    : "non-hold actions were offered but no agent selected one";
}

async function advanceUntil(input: {
  game: GameServer;
  mirror: AgentLocalGameMirror;
  messages: () => ServerMessage[];
  turnsPerStep: number;
  maxAdvanceTurns: number;
  until: (game: Game) => boolean;
}): Promise<Game> {
  let advancedTurns = 0;
  while (advancedTurns <= input.maxAdvanceTurns) {
    await input.mirror.ingest(input.messages());
    const state = input.mirror.gameState();
    if (state !== null && input.until(state)) {
      return state;
    }

    input.game.advanceTurnsForTesting(input.turnsPerStep);
    advancedTurns += input.turnsPerStep;
  }

  throw new Error(
    `step-locked league could not reach requested state after ${input.maxAdvanceTurns} turns`,
  );
}

function requireMirrorGame(mirror: AgentLocalGameMirror): Game {
  const game = mirror.gameState();
  if (game === null) {
    throw new Error("step-locked mirror has no game state");
  }
  return game;
}
