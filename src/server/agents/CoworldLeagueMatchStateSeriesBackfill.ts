import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MATCH_STATE_SERIES_SCHEMA_VERSION } from "./AgentMatchStateSeries";
import {
  maximumDecisionsJsonlBytes,
  maximumMatchStateSeriesBytes,
  maximumSpectatorReplayBytes,
  maximumSpectatorTelemetryBytes,
  readBoundedRunDirArtifact,
  readMatchSummaryFinalTurnCount,
} from "./CoworldLeagueBackfillIo";
import { resolveMirroredMatchStateSeries } from "./CoworldLeagueMirrorCore";

/**
 * Season Zero Phase 2: IO orchestration for the mirror-side "sampled
 * match-state series" gap closure — the SAME pattern
 * `CoworldLeagueDirectorCutBackfill.ts`/`CoworldLeagueMatchNarrativeBackfill.ts`
 * established: per-run, idempotent, fail-open generation with a structured
 * non-throwing outcome, plus a budgeted gradual backfill scan.
 *
 * Generates `match-state-series.json` for a mirrored (hosted-league) run dir
 * that doesn't have one yet, from ALREADY-WRITTEN, ALREADY-PUBLIC artifacts
 * (`spectator-replay.json` + whichever telemetry tier resolves) — see
 * `AgentMatchStateSeries.ts`'s "source decision" doc for why this is a
 * zero-simulation re-projection, never a new expensive computation.
 *
 * ORDERING DEPENDENCY (documented, not enforced by a lock — see
 * `AgentMatchStateSeries.ts`'s module doc for the accepted race): this
 * backfill MUST run strictly before `backfillDirectorCutPlans`/
 * `backfillMatchNarrativeArtifacts` in the SAME mirror cycle
 * (`coworld-league-mirror.ts`'s `syncOnce`), for both the freshly-unpacked
 * per-episode path and the historical backlog scan, so a run's `director-
 * cut-plan.json`/`match-recap.json` generation has the best chance of
 * seeing a real series on its FIRST pass rather than waiting for a later
 * mirror cycle to retroactively upgrade them. Because series generation is
 * strictly cheaper than either downstream consumer (no telemetry curation,
 * no importance scoring — a pure re-projection), its default budget is
 * intentionally larger, so it stays ahead of the historical backlog those
 * two chase.
 */

const matchStateSeriesFileName = "match-state-series.json";

async function writeMatchStateSeriesAtomic(
  filePath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export type MatchStateSeriesGenerationOutcome =
  | { status: "already-exists" }
  | { status: "no-input" }
  | { status: "skipped-no-usable-replay" }
  | { status: "generated"; sampleCount: number }
  | { status: "failed"; error: string };

export interface MatchStateSeriesGenerationResult {
  runKey: string;
  /** Whether this call actually attempted a generation — `already-exists`/`no-input` are both free, matching the established convention in the sibling backfills. */
  attempted: boolean;
  outcome: MatchStateSeriesGenerationOutcome;
}

/**
 * Generates `match-state-series.json` for one mirrored run dir if it
 * doesn't have one yet. Idempotent (checked via the artifact's own
 * `schemaVersion` — a stale pre-fix artifact would be a contradiction in
 * terms today since this is version 1's own introduction, but the check is
 * shaped identically to `AgentMatchRecap.ts`'s so a future schema bump only
 * has to change the compared constant here) and never throws.
 */
export async function generateMatchStateSeriesForRunDir(
  runDir: string,
  runKey: string,
): Promise<MatchStateSeriesGenerationResult> {
  const seriesPath = path.join(runDir, matchStateSeriesFileName);
  const existingRaw = await readBoundedRunDirArtifact(
    seriesPath,
    maximumMatchStateSeriesBytes,
  );
  if (existingRaw !== null) {
    try {
      const existing = JSON.parse(existingRaw) as { schemaVersion?: unknown };
      if (existing.schemaVersion === MATCH_STATE_SERIES_SCHEMA_VERSION) {
        return { runKey, attempted: false, outcome: { status: "already-exists" } };
      }
    } catch {
      // Falls through to regeneration — a torn/malformed existing file is
      // treated exactly like "missing".
    }
  }

  const [spectatorReplayRaw, spectatorTelemetryRaw, decisionsJsonlRaw] = await Promise.all([
    readBoundedRunDirArtifact(
      path.join(runDir, "spectator-replay.json"),
      maximumSpectatorReplayBytes,
    ),
    readBoundedRunDirArtifact(
      path.join(runDir, "spectator-telemetry.json"),
      maximumSpectatorTelemetryBytes,
    ),
    readBoundedRunDirArtifact(
      path.join(runDir, "decisions.jsonl"),
      maximumDecisionsJsonlBytes,
    ),
  ]);
  if (spectatorReplayRaw === null) {
    return { runKey, attempted: false, outcome: { status: "no-input" } };
  }

  try {
    const finalTurnCount = await readMatchSummaryFinalTurnCount(runDir);
    const series = resolveMirroredMatchStateSeries({
      runID: runKey,
      matchID: runKey,
      spectatorReplayRaw,
      spectatorTelemetryRaw,
      decisionsJsonlRaw,
      finalTurnCount,
    });
    if (series === null) {
      return {
        runKey,
        attempted: true,
        outcome: { status: "skipped-no-usable-replay" },
      };
    }
    await writeMatchStateSeriesAtomic(
      seriesPath,
      `${JSON.stringify(series, null, 2)}\n`,
    );
    return {
      runKey,
      attempted: true,
      outcome: { status: "generated", sampleCount: series.samples.length },
    };
  } catch (error) {
    return {
      runKey,
      attempted: true,
      outcome: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Gradually backfills `match-state-series.json` across already-retained run
 * dirs still missing one, spending up to `budget` generation attempts — same
 * deterministic ascending directory-name order, fail-open listing, and
 * budget-decrements-only-on-attempt semantics as
 * `backfillDirectorCutPlans`/`backfillMatchNarrativeArtifacts`.
 */
export async function backfillMatchStateSeries(
  runsRootDir: string,
  budget: number,
  alreadyAttempted: ReadonlySet<string> = new Set(),
): Promise<MatchStateSeriesGenerationResult[]> {
  if (budget <= 0) {
    return [];
  }
  let entries;
  try {
    entries = await fs.readdir(runsRootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidateNames = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("league-"))
    .map((entry) => entry.name)
    .sort();
  const results: MatchStateSeriesGenerationResult[] = [];
  let remaining = budget;
  for (const name of candidateNames) {
    if (remaining <= 0) {
      break;
    }
    if (alreadyAttempted.has(name)) {
      continue;
    }
    const result = await generateMatchStateSeriesForRunDir(
      path.join(runsRootDir, name),
      name,
    );
    results.push(result);
    if (result.attempted) {
      remaining -= 1;
    }
  }
  return results;
}
