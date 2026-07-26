#!/usr/bin/env -S npx tsx
/**
 * CLI: prints the current active league roster as JSON — every active
 * champion policy in the league's competition division, no sampling.
 *
 *   npm run premiere-wagering:roster
 *   npm run premiere-wagering:roster -- --league=<leagueId>
 *
 * Read-only (see `PremiereWageringRoster.ts`). Requires a logged-in `coworld`
 * CLI (`uvx coworld status`), same as `league:mirror`.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchActiveLeagueRoster } from "./PremiereWageringRoster";

const DEFAULT_LEAGUE_ID =
  process.env.PROXYWAR_LEAGUE_ID ?? "league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42";

export interface PullActiveRosterCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

function parseLeagueId(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--league=")) {
      return arg.slice("--league=".length);
    }
  }
  return DEFAULT_LEAGUE_ID;
}

export async function runPullActiveRosterCli(
  args: string[],
  io: PullActiveRosterCliIo,
): Promise<number> {
  try {
    const roster = await fetchActiveLeagueRoster({
      leagueId: parseLeagueId(args),
    });
    io.stdout(`${JSON.stringify(roster, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `PREMIERE_WAGERING_ROSTER_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
) {
  const exitCode = await runPullActiveRosterCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}
