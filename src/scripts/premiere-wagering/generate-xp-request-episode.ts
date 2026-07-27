#!/usr/bin/env -S npx tsx
/**
 * CLI: pre-simulates a premiere-wagering episode by seating EVERY active
 * league policy (no sampling) into a private xp-request, then downloads and
 * unpacks the completed episode into a local bundle ready for
 * `seal-episode.ts --source=xp-request`.
 *
 *   npm run premiere-wagering:generate -- \
 *     --coworld-id=cow_6e53f523-d206-4f2e-a5b3-65419e9b45c8 \
 *     --variant-id=twelve-player-ffa-world \
 *     --max-decision-steps=300
 *
 * OPERATOR-GATED: this creates and runs a real hosted match (real platform
 * cost). Never call this from an automatic loop — same posture as
 * `outputs/seat-tester.sh`. See `PremiereWageringXpRequest.ts` for why the
 * mutating call goes through the coworld Python client rather than the
 * (deliberately read-only) `coworld` CLI wrapper used elsewhere in this repo.
 *
 *   --coworld-id=<id>            required. The Coworld package to run.
 *   --variant-id=<id>            required. The variant (seat count/map).
 *   --max-decision-steps=<n>     required. Same units as `seat-tester.sh`.
 *   --max-seats=<n>              optional. Every currently shipped Proxy War
 *                                 Coworld package/variant declares one FIXED
 *                                 seat count (the certifier requires
 *                                 `players.minItems == maxItems`); today's
 *                                 only rung big enough for this league is the
 *                                 12-seat `proxywar-ffa-12p` ladder package,
 *                                 which is smaller than the active roster as
 *                                 soon as it exceeds 12 policies. When the
 *                                 roster is larger than `--max-seats`, this
 *                                 keeps the first N seats after the roster's
 *                                 existing stable `policyVersionId` sort and
 *                                 logs exactly who got trimmed — deterministic
 *                                 but NOT a rotation policy; a caller that
 *                                 wants every active policy to get airtime
 *                                 over successive cycles must rotate which
 *                                 policies this flag keeps itself (e.g. by
 *                                 filtering the roster before generation).
 *   --league=<leagueId>          optional, defaults to PROXYWAR_LEAGUE_ID /
 *                                 the standard Proxy War league.
 *   --server=<url>               optional, defaults to https://softmax.com/api.
 *   --runs-root=<path>           optional, defaults to a private directory
 *                                 OUTSIDE any served root
 *                                 (`~/Library/Application Support/ProxyWar/
 *                                 storage/premiere-wagering-runs`, override
 *                                 with `PROXYWAR_PREMIERE_WAGERING_RUNS_ROOT`).
 *                                 Deliberately NOT `artifacts/ai-league-runs`
 *                                 (the public-league mirror's own runs root):
 *                                 `servePublicRunArtifact` in
 *                                 `ai-agent-demo-server.ts` allowlists
 *                                 artifact FILENAMES only (game-record.json,
 *                                 decisions.jsonl, spectator-replay.json, …)
 *                                 with no runID/league-prefix check of its
 *                                 own — safe only because production always
 *                                 sets `PROXYWAR_LEAGUE_WRAPPER_ONLY=true`,
 *                                 whose separate gate DOES require a
 *                                 `league`-prefixed run key
 *                                 (`isProxyWarPublicLeaguePath`). A private
 *                                 xp-request bundle should not depend on that
 *                                 second, unrelated flag to stay sealed.
 *   --poll-interval-ms=<n>       optional, defaults to 20000 (matches
 *                                 seat-tester.sh).
 *
 * Writes `xp-request-roster.json` into the bundle dir alongside the episode
 * artifacts: the EXACT seat roster (policyVersionId/policyLabel/playerName),
 * in the EXACT slot order submitted to Coworld, plus the ids and outcome
 * facts (`winnerSlot`, `map`, `turnCount`, ...) needed to later build an
 * admissible premiere source bundle (`build-source-bundle.ts`) without
 * re-fetching a roster that may have drifted since generation.
 */
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchActiveLeagueRoster } from "./PremiereWageringRoster";
import {
  buildExperienceRequestBody,
  downloadRawReplay,
  runExperienceRequestViaCoworldPython,
  writeXpRequestBundle,
  PremiereWageringXpRequestError,
  type ExperienceRequestRunner,
} from "./PremiereWageringXpRequest";

const DEFAULT_LEAGUE_ID =
  process.env.PROXYWAR_LEAGUE_ID ?? "league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42";
const DEFAULT_SERVER = "https://softmax.com/api";
const DEFAULT_RUNS_ROOT =
  process.env.PROXYWAR_PREMIERE_WAGERING_RUNS_ROOT ??
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "ProxyWar",
    "storage",
    "premiere-wagering-runs",
  );
const DEFAULT_POLL_INTERVAL_MS = 20_000;

export interface GenerateXpRequestEpisodeCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

interface ParsedGenerateArgs {
  coworldId: string;
  variantId: string;
  maxDecisionSteps: number;
  maxSeats: number | null;
  leagueId: string;
  server: string;
  runsRootDir: string;
  pollIntervalMs: number;
}

function parseArgs(args: string[]): ParsedGenerateArgs {
  let coworldId: string | undefined;
  let variantId: string | undefined;
  let maxDecisionSteps: number | undefined;
  let maxSeats: number | undefined;
  let leagueId = DEFAULT_LEAGUE_ID;
  let server = DEFAULT_SERVER;
  let runsRootDir = DEFAULT_RUNS_ROOT;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  for (const arg of args) {
    if (arg.startsWith("--coworld-id=")) {
      coworldId = arg.slice("--coworld-id=".length);
    } else if (arg.startsWith("--variant-id=")) {
      variantId = arg.slice("--variant-id=".length);
    } else if (arg.startsWith("--max-decision-steps=")) {
      maxDecisionSteps = Number(arg.slice("--max-decision-steps=".length));
    } else if (arg.startsWith("--max-seats=")) {
      maxSeats = Number(arg.slice("--max-seats=".length));
    } else if (arg.startsWith("--league=")) {
      leagueId = arg.slice("--league=".length);
    } else if (arg.startsWith("--server=")) {
      server = arg.slice("--server=".length);
    } else if (arg.startsWith("--runs-root=")) {
      runsRootDir = arg.slice("--runs-root=".length);
    } else if (arg.startsWith("--poll-interval-ms=")) {
      pollIntervalMs = Number(arg.slice("--poll-interval-ms=".length));
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (coworldId === undefined || variantId === undefined) {
    throw new Error("--coworld-id=<id> and --variant-id=<id> are required");
  }
  if (
    maxDecisionSteps === undefined ||
    !Number.isFinite(maxDecisionSteps) ||
    maxDecisionSteps <= 0
  ) {
    throw new Error("--max-decision-steps=<n> is required and must be positive");
  }
  if (
    maxSeats !== undefined &&
    (!Number.isInteger(maxSeats) || maxSeats <= 0)
  ) {
    throw new Error("--max-seats=<n>, when given, must be a positive integer");
  }
  return {
    coworldId,
    variantId,
    maxDecisionSteps,
    maxSeats: maxSeats ?? null,
    leagueId,
    server,
    runsRootDir,
    pollIntervalMs,
  };
}

export async function runGenerateXpRequestEpisodeCli(
  args: string[],
  io: GenerateXpRequestEpisodeCliIo,
  dependencies: { runExperienceRequest?: ExperienceRequestRunner } = {},
): Promise<number> {
  let parsed: ParsedGenerateArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    io.stdout(`pulling active roster for league ${parsed.leagueId}...\n`);
    const fullRoster = await fetchActiveLeagueRoster({ leagueId: parsed.leagueId });
    io.stdout(
      `active roster: ${fullRoster.seats.length} active polic${fullRoster.seats.length === 1 ? "y" : "ies"} from ${fullRoster.divisionName}\n`,
    );
    const seats =
      parsed.maxSeats !== null && fullRoster.seats.length > parsed.maxSeats
        ? fullRoster.seats.slice(0, parsed.maxSeats)
        : fullRoster.seats;
    if (seats.length !== fullRoster.seats.length) {
      const excluded = fullRoster.seats.slice(parsed.maxSeats ?? seats.length);
      io.stdout(
        `--max-seats=${parsed.maxSeats} trims to ${seats.length} seats; excluded this cycle: ${excluded
          .map((seat) => `${seat.playerName ?? seat.playerId} (${seat.policyLabel})`)
          .join(", ")}\n`,
      );
    }
    io.stdout(`seating ${seats.length} polic${seats.length === 1 ? "y" : "ies"}\n`);
    const body = buildExperienceRequestBody({
      coworldId: parsed.coworldId,
      variantId: parsed.variantId,
      seats,
      maxDecisionSteps: parsed.maxDecisionSteps,
    });
    const runExperienceRequest =
      dependencies.runExperienceRequest ?? runExperienceRequestViaCoworldPython;
    const completed = await runExperienceRequest(body, {
      server: parsed.server,
      pollIntervalMs: parsed.pollIntervalMs,
    });
    io.stdout(
      `episode completed: ${completed.episodeId} (episodeRequestId=${completed.episodeRequestId})\n`,
    );
    io.stdout(`downloading replay from ${completed.replayUrl}...\n`);
    const rawReplayPayload = await downloadRawReplay(completed.replayUrl);
    const { bundleDir, parsed: replay } = await writeXpRequestBundle({
      rawReplayPayload,
      runsRootDir: parsed.runsRootDir,
    });
    const rosterFile = {
      schemaVersion: 1 as const,
      leagueId: fullRoster.leagueId,
      divisionId: fullRoster.divisionId,
      experienceRequestId: completed.experienceRequestId,
      episodeRequestId: completed.episodeRequestId,
      episodeId: completed.episodeId,
      winnerSlot: replay.winnerSlot,
      map: replay.map,
      mapSize: replay.mapSize,
      turnCount: replay.turnCount,
      decisionCount: replay.decisionCount,
      degradedCount: replay.degradedCount,
      // Seats in the EXACT slot order submitted above (`buildExperienceRequestBody`
      // maps `seats[i]` to Coworld roster slot `i`) — the frozen source of truth
      // `build-source-bundle.ts` zips against `game-record.json`'s `info.players[i]`
      // by index, rather than re-fetching a roster that may have drifted since.
      seats,
    };
    await fs.writeFile(
      path.join(bundleDir, "xp-request-roster.json"),
      `${JSON.stringify(rosterFile, null, 2)}\n`,
      "utf8",
    );
    io.stdout(
      `bundle written -> ${bundleDir} (${replay.turnCount ?? "unknown"} turns, roster sidecar: xp-request-roster.json)\n`,
    );
    io.stdout(
      `next: npm run premiere-wagering:seal -- --bundle-dir=${bundleDir} --source=xp-request\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof PremiereWageringXpRequestError) {
      io.stderr(`PREMIERE_WAGERING_GENERATE_FAILED [${error.name}] ${error.message}\n`);
      return 1;
    }
    io.stderr(
      `PREMIERE_WAGERING_GENERATE_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
) {
  const exitCode = await runGenerateXpRequestEpisodeCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}
