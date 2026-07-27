#!/usr/bin/env -S npx tsx
/**
 * CLI: converts one SEALED xp-request bundle into the exact
 * `proxywar_rated_coworld_source` bundle `replay-premiere-admit.ts` accepts —
 * the last step of `pull-active-roster.ts` -> `generate-xp-request-episode.ts`
 * -> `seal-episode.ts` -> (this) -> `replay-premiere-admit.ts`.
 *
 *   npm run premiere-wagering:build-source -- \
 *     --bundle-dir=artifacts/ai-league-runs/xpreq-<runID>
 *
 * Flags:
 *   --bundle-dir=<path>        required. Directory already containing
 *                               game-record.json, xp-request-roster.json
 *                               (written by `generate`), and
 *                               premiere-wagering.sealed.json with
 *                               `sealed: true` (written by `seal`).
 *   --turn-interval-ms=<n>     optional, defaults to 100
 *                               (`PREMIERE_REAL_TURN_INTERVAL_MS` — real
 *                               OpenFront turn cadence at playback rate 1).
 *                               A real league-sized episode can run tens of
 *                               thousands of turns; pick a smaller interval
 *                               (matches `replay-premiere-controlled-
 *                               exhibition.ts`'s `--playback-turn-interval-ms`
 *                               convention) to keep total premiere duration
 *                               inside the 128-chunk/60s-per-chunk ceiling
 *                               and brisk enough to watch/trade live.
 *   --out-file=<path>          optional, defaults to
 *                               <bundle-dir>/<runId>.source.json.
 *
 * Exit code 0 + a JSON summary (including the two suggested checkpoint turns
 * already computed by `seal-episode.ts`) on stdout when written; exit code 1
 * + a loud stderr explanation otherwise.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildRatedPremiereSourceBundle,
  PremiereWageringSourceBundleError,
} from "./PremiereWageringSourceBundle";

const DEFAULT_TURN_INTERVAL_MS = 100;

export interface BuildSourceBundleCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

interface ParsedBuildSourceArgs {
  bundleDir: string;
  turnIntervalMs: number;
  outFile: string | undefined;
}

function parseArgs(args: string[]): ParsedBuildSourceArgs {
  let bundleDir: string | undefined;
  let turnIntervalMs = DEFAULT_TURN_INTERVAL_MS;
  let outFile: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("--bundle-dir=")) {
      bundleDir = arg.slice("--bundle-dir=".length);
    } else if (arg.startsWith("--turn-interval-ms=")) {
      turnIntervalMs = Number(arg.slice("--turn-interval-ms=".length));
    } else if (arg.startsWith("--out-file=")) {
      outFile = arg.slice("--out-file=".length);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (bundleDir === undefined) {
    throw new Error("--bundle-dir=<path> is required");
  }
  if (!Number.isFinite(turnIntervalMs) || turnIntervalMs <= 0 || turnIntervalMs > 60_000) {
    throw new Error("--turn-interval-ms=<n>, when given, must be in (0, 60000]");
  }
  return { bundleDir, turnIntervalMs, outFile };
}

export async function runBuildSourceBundleCli(
  args: string[],
  io: BuildSourceBundleCliIo,
): Promise<number> {
  let parsed: ParsedBuildSourceArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const result = await buildRatedPremiereSourceBundle({
      bundleDir: parsed.bundleDir,
      turnIntervalMs: parsed.turnIntervalMs,
      outFile: parsed.outFile,
    });
    io.stdout(`${JSON.stringify(result)}\n`);
    io.stdout(
      `next: GAME_ENV=dev PROXYWAR_PUBLIC_URL=<origin> npx tsx src/scripts/replay-premiere-admit.ts --source-file=${result.outFile} --expected-source-sha256=${result.bundleSha256} --checkpoints at sequences ${result.checkpointTurns.join(",")} (see RUNBOOK.md §6)\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof PremiereWageringSourceBundleError) {
      io.stderr(`PREMIERE_WAGERING_BUILD_SOURCE_FAILED [${error.code}] ${error.message}\n`);
      return 1;
    }
    io.stderr(
      `PREMIERE_WAGERING_BUILD_SOURCE_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
) {
  const exitCode = await runBuildSourceBundleCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}
