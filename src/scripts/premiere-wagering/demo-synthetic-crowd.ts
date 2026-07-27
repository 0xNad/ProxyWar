#!/usr/bin/env -S npx tsx
/**
 * CLI: runs the synthetic-bettor crowd against a small, self-contained,
 * in-memory premiere so a human can watch the LMSR odds actually move in
 * real time. This is demo/tester scaffolding — see the header of
 * `SyntheticCrowdSimulator.ts` for why it exists and why it must stay off
 * in anything resembling production. Nothing in the running product calls
 * this script; it is a standalone proof a tester runs by hand.
 *
 *   npm run premiere-wagering:demo-crowd
 *   npm run premiere-wagering:demo-crowd -- --seed=42 --count=12 --duration=20
 *
 * Flags (all optional):
 *   --seed=<n>              reproducibility seed (default 1)
 *   --count=<n>             synthetic bettor count (default 10)
 *   --aggressiveness=<0..1> stake sizing / slippage tolerance (default 0.5)
 *   --curve=steady|early-heavy|late-heavy|u-shaped  activity curve (default u-shaped)
 *   --duration=<seconds>    real wall-clock demo length (default 15)
 *   --frames=<n>            number of released frames over the duration (default 30)
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ReplayPremiereInteractions } from "../../server/replay-premiere/ReplayPremiereInteractions";
import { DEFAULT_SYNTHETIC_CROWD_CONFIG } from "../../server/replay-premiere/wagering/simulation/SyntheticCrowdConfig";
import { SyntheticCrowdSimulator } from "../../server/replay-premiere/wagering/simulation/SyntheticCrowdSimulator";
import type {
  SyntheticCrowdActivityCurve,
  SyntheticCrowdSignalSnapshot,
} from "../../server/replay-premiere/wagering/simulation/SyntheticCrowdTypes";

export interface DemoSyntheticCrowdCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const DEMO_SEAT_IDS = ["seat-alpha", "seat-beta", "seat-gamma", "seat-delta"] as const;
const ACTIVITY_CURVES: readonly SyntheticCrowdActivityCurve[] = [
  "steady",
  "early-heavy",
  "late-heavy",
  "u-shaped",
];

function parseArgs(args: string[]): {
  seed: number;
  count: number;
  aggressiveness: number;
  curve: SyntheticCrowdActivityCurve;
  durationSeconds: number;
  frames: number;
} {
  const flags = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (match) flags.set(match[1], match[2]);
  }
  const curveFlag = flags.get("curve");
  const curve = ACTIVITY_CURVES.includes(curveFlag as SyntheticCrowdActivityCurve)
    ? (curveFlag as SyntheticCrowdActivityCurve)
    : "u-shaped";
  return {
    seed: Number(flags.get("seed") ?? 1),
    count: Number(flags.get("count") ?? 10),
    aggressiveness: Number(flags.get("aggressiveness") ?? 0.5),
    curve,
    durationSeconds: Number(flags.get("duration") ?? 15),
    frames: Number(flags.get("frames") ?? 30),
  };
}

/**
 * Fixture-only signal generator for the demo: a smooth, seeded drift in
 * which seat is "favored" over match progress, standing in for whatever a
 * real integration would derive from released territory share / league
 * standing. This is the ONLY place in this file that invents a signal —
 * SyntheticCrowdSimulator itself never does, and never sees anything about
 * match progress beyond the single frozen snapshot handed to it per frame.
 */
function demoSignalSnapshot(matchProgress: number): SyntheticCrowdSignalSnapshot {
  const weights: Record<string, number> = {};
  DEMO_SEAT_IDS.forEach((seatId, index) => {
    const phase = index * ((2 * Math.PI) / DEMO_SEAT_IDS.length);
    // Each seat's fortune rises and falls on its own offset sine wave —
    // guarantees a lead change mid-match without any hidden randomness.
    weights[seatId] = 10 + 8 * (1 + Math.sin(matchProgress * Math.PI * 1.5 + phase));
  });
  return { optionSeatIds: [...DEMO_SEAT_IDS], favorabilityWeights: weights };
}

function formatPrices(prices: readonly number[]): string {
  return DEMO_SEAT_IDS.map((seatId, i) => `${seatId}=${prices[i].toFixed(1)}`).join("  ");
}

export async function runDemoSyntheticCrowdCli(
  args: string[],
  io: DemoSyntheticCrowdCliIo,
): Promise<number> {
  const options = parseArgs(args);
  const premiereId = "prem_demo00000000000000";
  let premiereState: "playing" | "revealed" = "playing";
  const interactions = new ReplayPremiereInteractions({
    premiereId,
    checkpointDescriptors: [
      { id: "cp_first0001", sequence: 35 },
      { id: "cp_second001", sequence: 65 },
    ],
    seats: DEMO_SEAT_IDS.map((seatId, index) => ({
      seatId,
      policyIdentity: {
        namespace: "local_manifest" as const,
        manifestName: `demo-nation-${index}`,
        declaredVersion: "1",
        manifestSha256: String(index + 1).repeat(64).slice(0, 64),
        contentSha256: String(index + 5).repeat(64).slice(0, 64),
      },
    })),
    getPremiereState: () => premiereState,
    getReleasedContext: (sequence) => ({
      releasedThroughSequence: 1_000_000,
      turn: sequence,
      eventContext: null,
    }),
    getLiveVisibleSequence: () => 1_000_000,
    persistence: { async persist() {} },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    wageringEnabled: true,
    admitAnonymousWrite: () => undefined,
  });

  const simulator = new SyntheticCrowdSimulator({
    config: {
      ...DEFAULT_SYNTHETIC_CROWD_CONFIG,
      enabled: true,
      seed: options.seed,
      count: options.count,
      aggressiveness: options.aggressiveness,
      activityCurve: options.curve,
    },
    target: interactions,
  });

  io.stdout(
    `Synthetic crowd demo — seed=${options.seed} count=${options.count} ` +
      `aggressiveness=${options.aggressiveness} curve=${options.curve} ` +
      `duration=${options.durationSeconds}s frames=${options.frames}\n`,
  );
  const stepMs = Math.max(1, (options.durationSeconds * 1000) / options.frames);
  for (let i = 0; i <= options.frames; i++) {
    const matchProgress = i / options.frames;
    await simulator.onReleasedFrame({
      snapshot: demoSignalSnapshot(matchProgress),
      matchProgress,
      observedSequence: 35 + i,
    });
    const state = interactions.readMarketState(null);
    if (state !== null) {
      io.stdout(
        `t=${(matchProgress * options.durationSeconds).toFixed(1)}s  ${formatPrices(state.prices)}\n`,
      );
    }
    if (i < options.frames) await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  premiereState = "revealed";

  const finalState = interactions.readState();
  const totalStake = finalState.trades.reduce(
    (sum, trade) => sum + (trade.side === "buy" ? trade.chips : 0),
    0,
  );
  io.stdout(
    `\nDone. ${finalState.trades.length} synthetic trades, ${totalStake} credits of buy-side ` +
      `volume, ${new Set(finalState.trades.map((t) => t.participantId)).size} distinct sim_ ` +
      `bettors traded. Re-run with the same --seed for the identical sequence.\n`,
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const exitCode = await runDemoSyntheticCrowdCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}
