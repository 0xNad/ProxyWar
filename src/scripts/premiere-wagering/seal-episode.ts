#!/usr/bin/env -S npx tsx
/**
 * CLI: seals one local Coworld episode bundle into a checkpointed premiere
 * wagering candidate.
 *
 *   npm run premiere-wagering:seal -- \
 *     --bundle-dir=artifacts/ai-league-runs/<runID> \
 *     --source=xp-request
 *
 * Flags:
 *   --bundle-dir=<path>          required. Directory containing decisions.jsonl,
 *                                 game-record.json, match-summary.json,
 *                                 spectator-replay.json.
 *   --source=xp-request|public-league  optional provenance declaration. Bundles
 *                                 whose directory name matches the mirror's
 *                                 managed `league-coworld-*` pattern are always
 *                                 classified public-league regardless of this
 *                                 flag (that classification cannot be overridden
 *                                 by declaration — the pattern is the ground
 *                                 truth the mirror/demo-server themselves use).
 *   --force-unsafe-seal           override the provenance refusal. The manifest
 *                                 still records the true (unsafe) provenance —
 *                                 this never launders a public-league source
 *                                 into looking sealed. For test/dev only.
 *   --skip-already-premiered-check  don't consult the local replay-premiere
 *                                 archive (useful off the machine that runs the
 *                                 premiere loop).
 *   --private-state-root=<path>  override where the archive is read from
 *                                 (defaults to PROXYWAR_REPLAY_PREMIERE_STATE_ROOT
 *                                 / the standard ProxyWar storage path).
 *
 * Exit code 0 + a JSON summary on stdout when sealed. Exit code 1 + a loud
 * stderr explanation when refused (already premiered, or provenance is not
 * genuinely private) — this command is deliberately fail-closed: a false
 * "sealed" would defeat the entire wagering product.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  sealPremiereWageringEpisode,
  PremiereWageringSealingError,
} from "./PremiereWageringSealing";
import { PremiereWageringBundleError } from "./PremiereWageringBundle";
import { PremiereWageringCheckpointError } from "./PremiereWageringCheckpoints";
import type { PremiereWageringSource } from "./PremiereWageringProvenance";

export interface SealEpisodeCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

function parseSource(value: string | undefined): PremiereWageringSource | undefined {
  if (value === undefined) return undefined;
  if (value === "xp-request") return "xp_request";
  if (value === "public-league") return "public_league_mirror";
  throw new Error(`--source must be xp-request or public-league, got ${value}`);
}

function parseArgs(args: string[]): {
  bundleDir: string;
  declaredSource?: PremiereWageringSource;
  forceUnsafeSeal: boolean;
  skipAlreadyPremieredCheck: boolean;
  privateStateRoot?: string;
} {
  let bundleDir: string | undefined;
  let source: string | undefined;
  let forceUnsafeSeal = false;
  let skipAlreadyPremieredCheck = false;
  let privateStateRoot: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("--bundle-dir=")) {
      bundleDir = arg.slice("--bundle-dir=".length);
    } else if (arg.startsWith("--source=")) {
      source = arg.slice("--source=".length);
    } else if (arg === "--force-unsafe-seal") {
      forceUnsafeSeal = true;
    } else if (arg === "--skip-already-premiered-check") {
      skipAlreadyPremieredCheck = true;
    } else if (arg.startsWith("--private-state-root=")) {
      privateStateRoot = arg.slice("--private-state-root=".length);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (bundleDir === undefined || bundleDir.length === 0) {
    throw new Error("--bundle-dir=<path> is required");
  }
  return {
    bundleDir,
    declaredSource: parseSource(source),
    forceUnsafeSeal,
    skipAlreadyPremieredCheck,
    privateStateRoot,
  };
}

export async function runSealEpisodeCli(
  args: string[],
  io: SealEpisodeCliIo,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const result = await sealPremiereWageringEpisode({
      bundleDir: parsed.bundleDir,
      declaredSource: parsed.declaredSource,
      forceUnsafeSeal: parsed.forceUnsafeSeal,
      skipAlreadyPremieredCheck: parsed.skipAlreadyPremieredCheck,
      privateStateRoot: parsed.privateStateRoot,
    });
    io.stdout(`${JSON.stringify(result.manifest, null, 2)}\n`);
    io.stdout(`sealed -> ${result.manifestPath}\n`);
    return 0;
  } catch (error) {
    if (
      error instanceof PremiereWageringSealingError ||
      error instanceof PremiereWageringBundleError ||
      error instanceof PremiereWageringCheckpointError
    ) {
      io.stderr(`PREMIERE_WAGERING_SEAL_REFUSED [${error.name}] ${error.message}\n`);
      return 1;
    }
    io.stderr(
      `PREMIERE_WAGERING_SEAL_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
) {
  const exitCode = await runSealEpisodeCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}
