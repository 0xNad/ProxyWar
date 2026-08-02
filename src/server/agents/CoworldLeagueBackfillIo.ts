import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Shared IO primitives for every mirror-side, post-hoc backfill agent
 * (`CoworldLeagueDirectorCutBackfill.ts`, `CoworldLeagueMatchNarrativeBackfill.ts`,
 * `CoworldLeagueMatchStateSeriesBackfill.ts`): bounded artifact reads and
 * the authoritative-turn-count lookup every agent needs identically.
 * Factored out rather than duplicated a second time — see each backfill's
 * own module doc for why generation IO lives outside
 * `coworld-league-mirror.ts` itself (that script can never be safely
 * `import`ed by a test).
 */

export const maximumSpectatorTelemetryBytes = 32 * 1024 * 1024;
export const maximumDecisionsJsonlBytes = 64 * 1024 * 1024;
export const maximumMatchSummaryBytes = 8 * 1024 * 1024;
/** `spectator-replay.json` is capped to 80 snapshots at write time (`AgentSpectatorReplay.ts`'s `maxReplaySnapshotsForArtifact`) — smaller in the common case than telemetry, but a 12-agent match with the per-player 800-tile cap on every snapshot can still run several MB, so this stays generous rather than tight. */
export const maximumSpectatorReplayBytes = 16 * 1024 * 1024;
/** `match-state-series.json` is a re-projection of the (already bounded) spectator replay, strictly smaller than its source. */
export const maximumMatchStateSeriesBytes = 8 * 1024 * 1024;

/**
 * Reads a run dir artifact bounded by `maxBytes` (checked via `stat` before
 * the read, so an oversize file is never pulled into memory). Missing file,
 * non-regular file, oversize, or any other read failure all resolve to
 * `null` — the same fail-open leaf shape as every other optional-artifact
 * reader in this mirror (compare `coworld-league-mirror.ts`'s own
 * `readPremiereArchiveIndex`, which collapses the identical set of failure
 * modes to one outcome for the same reason).
 */
export async function readBoundedRunDirArtifact(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maxBytes) {
      return null;
    }
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * The authoritative turn count from a run dir's `match-summary.json` (the
 * ORIGINAL `finalState` the origin's own `writeAgentLeagueRunArtifacts`
 * recorded — see `matchSummary()`'s own `finalState: input.finalState ??
 * null` field), when present and well-formed. `null` on any absence/failure
 * — the caller then falls back to the telemetry's own max event turn
 * (honestly `degraded: true`), never a hard failure.
 */
export async function readMatchSummaryFinalTurnCount(
  runDir: string,
): Promise<number | null> {
  const raw = await readBoundedRunDirArtifact(
    path.join(runDir, "match-summary.json"),
    maximumMatchSummaryBytes,
  );
  if (raw === null) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as {
      finalState?: { turnCount?: unknown } | null;
    };
    const turnCount = value.finalState?.turnCount;
    return typeof turnCount === "number" &&
      Number.isFinite(turnCount) &&
      turnCount > 0
      ? turnCount
      : null;
  } catch {
    return null;
  }
}
