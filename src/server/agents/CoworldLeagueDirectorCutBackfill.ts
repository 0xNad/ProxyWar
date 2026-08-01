import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveMirroredDirectorCutPlan } from "./CoworldLeagueMirrorCore";

/**
 * IO orchestration for Product overhaul spec Stage 5's mirror-side gap
 * closure: generates `director-cut-plan.json` for mirrored (hosted-league)
 * run directories that don't have one yet.
 *
 * Split out of `coworld-league-mirror.ts` rather than inlined there: that
 * script unconditionally runs its CLI `main()` on import (network + `coworld`
 * CLI calls), so it can never be safely `import`ed by a test. Every other
 * substantial piece of mirror logic already lives in its own testable module
 * the script only orchestrates (`CoworldLeagueArtifactRetention.ts`,
 * `CoworldLeaguePremiereSuppression.ts`, `CoworldLeagueMirrorCore.ts`) — this
 * follows the same split, and returns structured results rather than logging
 * itself, matching `pruneCoworldLeagueMirrorArtifacts`'s own pattern in
 * `CoworldLeagueArtifactRetention.ts`.
 */

const maximumSpectatorTelemetryBytes = 32 * 1024 * 1024;
const maximumDecisionsJsonlBytes = 64 * 1024 * 1024;
const maximumMatchSummaryBytes = 8 * 1024 * 1024;

/**
 * Reads a run dir artifact bounded by `maxBytes` (checked via `stat` before
 * the read, so an oversize file is never pulled into memory). Missing file,
 * non-regular file, oversize, or any other read failure all resolve to
 * `null` — the same fail-open leaf shape as every other optional-artifact
 * reader in this mirror (compare `coworld-league-mirror.ts`'s own
 * `readPremiereArchiveIndex`, which collapses the identical set of failure
 * modes to one outcome for the same reason).
 */
async function readBoundedRunDirArtifact(
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
async function readDirectorCutFinalTurnCount(
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

async function writeDirectorCutPlanAtomic(
  planPath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${planPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, planPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export type DirectorCutGenerationOutcome =
  | { status: "already-exists" }
  | { status: "no-input" }
  | { status: "skipped-no-usable-telemetry" }
  | {
      status: "generated";
      source: "spectator-telemetry" | "decisions-log";
      segmentCount: number;
    }
  | { status: "failed"; error: string };

export interface DirectorCutGenerationResult {
  runKey: string;
  /**
   * Whether this call actually attempted a generation (found at least one
   * candidate input to parse) — the caller's per-cycle budget counter should
   * only decrement when this is `true`. `already-exists` and `no-input` are
   * both free: an idempotent skip and a "nothing to generate from yet" skip
   * never cost a budget slot.
   */
  attempted: boolean;
  outcome: DirectorCutGenerationOutcome;
}

/**
 * Generates `director-cut-plan.json` for one mirrored run dir if it doesn't
 * have one yet. Idempotent (an existing plan is left untouched) and never
 * throws — every failure mode resolves to a structured outcome the caller
 * logs and moves on from. Mirror resilience is sacred: this function alone
 * can never fail a sync cycle, and never blocks or delays the league
 * publish.
 */
export async function generateDirectorCutPlanForRunDir(
  runDir: string,
  runKey: string,
): Promise<DirectorCutGenerationResult> {
  const planPath = path.join(runDir, "director-cut-plan.json");
  try {
    await fs.stat(planPath);
    return {
      runKey,
      attempted: false,
      outcome: { status: "already-exists" },
    };
  } catch {
    // ENOENT (or any other stat failure) — fall through and generate.
  }
  const [spectatorTelemetryRaw, decisionsJsonlRaw] = await Promise.all([
    readBoundedRunDirArtifact(
      path.join(runDir, "spectator-telemetry.json"),
      maximumSpectatorTelemetryBytes,
    ),
    readBoundedRunDirArtifact(
      path.join(runDir, "decisions.jsonl"),
      maximumDecisionsJsonlBytes,
    ),
  ]);
  if (spectatorTelemetryRaw === null && decisionsJsonlRaw === null) {
    return { runKey, attempted: false, outcome: { status: "no-input" } };
  }
  try {
    const finalTurnCount = await readDirectorCutFinalTurnCount(runDir);
    const resolved = resolveMirroredDirectorCutPlan({
      runID: runKey,
      matchID: runKey,
      spectatorTelemetryRaw,
      decisionsJsonlRaw,
      finalTurnCount,
    });
    if (resolved === null) {
      return {
        runKey,
        attempted: true,
        outcome: { status: "skipped-no-usable-telemetry" },
      };
    }
    await writeDirectorCutPlanAtomic(
      planPath,
      `${JSON.stringify(resolved.plan, null, 2)}\n`,
    );
    return {
      runKey,
      attempted: true,
      outcome: {
        status: "generated",
        source: resolved.source,
        segmentCount: resolved.plan.segments.length,
      },
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
 * Gradually backfills `director-cut-plan.json` across already-retained run
 * dirs still missing one, spending up to `budget` generation attempts (the
 * leftover budget after this cycle's freshly-unpacked episodes — see
 * `coworld-league-mirror.ts`'s `syncOnce`). Deterministic ascending
 * directory-name order, so a repeat cycle makes forward progress through
 * history rather than re-rolling a random subset — history fills in without
 * a thundering herd. Fail-open: an unreadable `runsRootDir` listing yields an
 * empty result list, same as every other optional path in this mirror.
 */
export async function backfillDirectorCutPlans(
  runsRootDir: string,
  budget: number,
  alreadyAttempted: ReadonlySet<string> = new Set(),
): Promise<DirectorCutGenerationResult[]> {
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
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("league-"),
    )
    .map((entry) => entry.name)
    .sort();
  const results: DirectorCutGenerationResult[] = [];
  let remaining = budget;
  for (const name of candidateNames) {
    if (remaining <= 0) {
      break;
    }
    if (alreadyAttempted.has(name)) {
      continue;
    }
    const result = await generateDirectorCutPlanForRunDir(
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
