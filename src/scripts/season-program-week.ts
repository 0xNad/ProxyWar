import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProgramWeek } from "./season-program-week-lib";

/**
 * `season:program-week [--season=<id>] [--episode=<id>] [--at=<ISO>]
 * [--queue-root=<dir>] [--artifacts-root=<dir>] [--state-root=<dir>]
 * [--execute] [--json]`
 *
 * The one-command weekly programming workflow — see
 * `season-program-week-lib.ts`'s own module doc for the full pipeline
 * (rank both candidate lanes -> pick or accept an operator override ->
 * promote -> package -> gate -> season:add-event) and its DRY-RUN-by-
 * default contract. `--execute` is the only flag that commits anything;
 * every other invocation is a pure preview.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const parseFlag = (prefix: string): string | undefined => {
    const arg = argv.find((entry) => entry.startsWith(prefix));
    return arg === undefined ? undefined : arg.slice(prefix.length);
  };

  const queueRootOverride = parseFlag("--queue-root=");
  const artifactsRootOverride = parseFlag("--artifacts-root=");
  const stateRootOverride = parseFlag("--state-root=");

  const result = await runProgramWeek({
    seasonId: parseFlag("--season="),
    episodeOverride: parseFlag("--episode="),
    atOverride: parseFlag("--at="),
    execute: argv.includes("--execute"),
    queueReadyDir:
      queueRootOverride === undefined ? undefined : path.join(path.resolve(queueRootOverride), "ready"),
    artifactsRoot: artifactsRootOverride === undefined ? undefined : path.resolve(artifactsRootOverride),
    featuredMatchStateRoot: stateRootOverride === undefined ? undefined : path.resolve(stateRootOverride),
    eventPackageStateRoot: stateRootOverride === undefined ? undefined : path.resolve(stateRootOverride),
  });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const line of result.summary) console.log(line);
  }
  if (!result.ok) process.exitCode = 1;
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
