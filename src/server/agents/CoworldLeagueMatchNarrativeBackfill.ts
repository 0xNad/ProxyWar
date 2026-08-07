import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildAgentDecisiveMoments,
  DECISIVE_MOMENTS_SCHEMA_VERSION,
} from "./AgentDecisiveMoments";
import {
  buildAgentDramaReport,
  writeAgentDramaReportArtifacts,
} from "./AgentDramaReport";
import {
  AGENT_MATCH_RECAP_SCHEMA_VERSION,
  buildAgentMatchRecap,
  writeAgentMatchRecapArtifacts,
} from "./AgentMatchRecap";
import type { MatchStateSeries } from "./AgentMatchStateSeries";
import {
  buildAgentMatchStory,
  writeAgentMatchStoryArtifacts,
} from "./AgentMatchStory";
import type { SpectatorEvent } from "./AgentSpectatorTelemetry";
import {
  maximumDecisionsJsonlBytes,
  maximumMatchStateSeriesBytes,
  maximumSpectatorReplayBytes,
  maximumSpectatorTelemetryBytes,
  readBoundedRunDirArtifact,
  readMatchSummaryFinalTurnCount,
} from "./CoworldLeagueBackfillIo";
import {
  parseMirroredMatchStateSeries,
  parseMirroredSpectatorReplay,
  resolveMirroredMatchEvidence,
} from "./CoworldLeagueMirrorCore";

const maximumMatchRecapBytes = 4 * 1024 * 1024;
const maximumDecisiveMomentsBytes = 2 * 1024 * 1024;

/**
 * IO orchestration for the mirror-side "drama recaps" gap closure — the
 * SAME pattern `CoworldLeagueMatchStateSeriesBackfill.ts` established: per-run,
 * idempotent, fail-open generation with a structured non-throwing outcome,
 * plus a budgeted gradual backfill scan. Generates, for a mirrored
 * (hosted-league) run dir that doesn't have them yet:
 *
 *  - `drama-report.json`/`.md` (`AgentDramaReport.ts`) — political/betrayal
 *    ranking signal. NOT on `ProxyWarPublicArtifacts.ts`'s public allowlist.
 *  - `match-story.json`/`.md` (`AgentMatchStory.ts`) — entertainment-score
 *    ranking signal. Only `.md` is public (pre-existing allowlist entry,
 *    unchanged by this module), and even then only as a raw downloadable
 *    artifact, never as the page's rendered recap (see `AgentMatchRecap.ts`'s
 *    module doc for why).
 *  - `match-recap.json` (`AgentMatchRecap.ts`) — the event-derived recap the
 *    match page actually renders. Written ONLY when the curated pass found
 *    at least one story-worthy beat; a genuinely quiet match legitimately
 *    produces no recap file at all — that absence is a terminal, correct
 *    outcome, never retried as though generation failed (see `AgentMatchRecap`'s
 *    own "never padded" doc).
 *
 * Both `buildAgentDramaReport` and `buildAgentMatchStory` require raw
 * `AgentDecisionRecord[]` verbatim (neither accepts a pre-built
 * `SpectatorTelemetry`) — `resolveMirroredMatchEvidence`
 * always resolves those records from
 * `decisions.jsonl` independent of which telemetry tier won, so the common
 * case (mirrored runs ship `decisions.jsonl` — empirically confirmed
 * alongside `spectator-telemetry.json`/`game-record.json`/`match-summary.json`/
 * `spectator-replay.json`/`spectator.html` for every currently observed
 * production episode) generates all three artifacts together. The rarer
 * case — `spectator-telemetry.json` present and usable but `decisions.jsonl`
 * absent/oversize/unparseable — still has enough evidence for
 * `AgentMatchRecap` (telemetry-only) but genuinely not enough for the two
 * record-based generators; that outcome is `generated-recap-only`, an
 * honest degradation, never a fabricated drama/story report.
 */

export type MatchNarrativeGenerationOutcome =
  | { status: "already-exists" }
  | { status: "no-input" }
  | { status: "skipped-no-usable-evidence" }
  | {
      status: "generated";
      source: "spectator-telemetry" | "decisions-log";
      dramaScore: number;
      entertainmentGrade: string;
      recapBeatCount: number;
      /** `AgentMatchRecap.ts`'s `curatedDramaScore` — the PUBLIC ranking input (see that module's doc). `null` only when the curated pass found zero beats (a genuinely quiet match, `match-recap.json` legitimately not written) — never a fabricated 0 conflated with "unavailable" versus "quiet". */
      curatedDramaScore: number | null;
      /** Season Zero Phase 2: `decisive-moments.json`'s moment count. `null` when no series was available yet OR the curated pass found fewer than `MIN_DECISIVE_MOMENTS` genuine candidates — see `AgentDecisiveMoments.ts`'s "never padded" doc; never conflated with "unavailable". */
      decisiveMomentCount: number | null;
    }
  | {
      status: "generated-recap-only";
      source: "spectator-telemetry" | "decisions-log";
      recapBeatCount: number;
      /** See the `"generated"` variant's doc — same field, populated independent of `drama-report.json`/`match-story.json` since this variant never generates those. */
      curatedDramaScore: number | null;
      /** See the `"generated"` variant's doc. */
      decisiveMomentCount: number | null;
    }
  | {
      /** `drama-report.json`/`match-story.json` already existed and stayed untouched; ONLY `match-recap.json` was recomputed because its `schemaVersion` was stale (see `AgentMatchRecap.ts`'s 2026-08-01 fix) or it was missing entirely. */
      status: "recap-upgraded";
      source: "spectator-telemetry" | "decisions-log";
      recapBeatCount: number;
      /** See the `"generated"` variant's doc. */
      curatedDramaScore: number | null;
      /** See the `"generated"` variant's doc. */
      decisiveMomentCount: number | null;
    }
  | { status: "failed"; error: string };

export interface MatchNarrativeGenerationResult {
  runKey: string;
  /** Whether this call actually attempted generation — the caller's per-cycle budget counter should only decrement when this is `true`. `already-exists` and `no-input` are both free. */
  attempted: boolean;
  outcome: MatchNarrativeGenerationOutcome;
}

/** Season Zero Phase 2: reads `match-state-series.json` when the (separately, strictly-earlier-in-cycle — see `CoworldLeagueMatchStateSeriesBackfill.ts`'s own doc) series backfill has already generated one for this run. `null` when absent/oversize/stale-schema/malformed — `buildAgentMatchRecap` degrades to no `lead_change`/`reversal` beats exactly as before this fix, never a throw. */
async function readMatchStateSeries(runDir: string) {
  const raw = await readBoundedRunDirArtifact(
    path.join(runDir, "match-state-series.json"),
    maximumMatchStateSeriesBytes,
  );
  return raw === null ? null : parseMirroredMatchStateSeries(raw);
}

/** `spectator-replay.json`'s full snapshots (with per-snapshot `decisions[]`, for `AgentDecisiveMoments.ts`'s `statedReason` lookups) — `null` on absence/oversize/malformed, which degrades every moment's `statedReason` to `null`, never a throw. */
async function readReplaySnapshotsForDecisiveMoments(runDir: string) {
  const raw = await readBoundedRunDirArtifact(
    path.join(runDir, "spectator-replay.json"),
    maximumSpectatorReplayBytes,
  );
  if (raw === null) return null;
  const replay = parseMirroredSpectatorReplay(raw);
  return replay === null ? null : replay.snapshots;
}

/**
 * `decisive-moments.json` needs (re)generating when a real
 * `match-state-series.json` ALREADY exists (series absence is "not
 * ready", not "missing work due", so this never reports `true` — and
 * never costs a repeat budget slot every cycle — while the series
 * backfill hasn't caught up to this run yet) AND EITHER the moments
 * artifact is missing entirely OR its `schemaVersion` is stale (the P0
 * `statedReason` sanitization fix — see `AgentDecisiveMoments.ts`'s own
 * schema-bump doc — needs every already-published artifact re-derived
 * through the sanitizer, exactly like `recapNeedsRegeneration` already
 * does for `match-recap.json`). Once a series lands (or a schema bump
 * ships), this fires exactly once per run (the next call writes the
 * current-schema moments artifact, after which this returns `false`
 * again).
 */
async function decisiveMomentsNeedGeneration(runDir: string): Promise<boolean> {
  const seriesRaw = await readBoundedRunDirArtifact(
    path.join(runDir, "match-state-series.json"),
    maximumMatchStateSeriesBytes,
  );
  if (seriesRaw === null) {
    return false;
  }
  const momentsRaw = await readBoundedRunDirArtifact(
    path.join(runDir, "decisive-moments.json"),
    maximumDecisiveMomentsBytes,
  );
  if (momentsRaw === null) {
    return true;
  }
  try {
    const value = JSON.parse(momentsRaw) as { schemaVersion?: unknown };
    return value.schemaVersion !== DECISIVE_MOMENTS_SCHEMA_VERSION;
  } catch {
    return true;
  }
}

/**
 * Writes (or, if the curated pass now yields too few candidates, removes a
 * stale) `decisive-moments.json`, reusing the SAME `series`/telemetry
 * events this call's recap generation already resolved — one evidence
 * resolution, two derived artifacts. `null` series (no
 * `match-state-series.json` yet) skips entirely, never fabricated. Returns
 * the written moment count, or `null` when nothing was written.
 */
async function writeDecisiveMomentsArtifact(input: {
  runDir: string;
  runKey: string;
  series: MatchStateSeries | null;
  telemetryEvents: readonly SpectatorEvent[];
  totalTurns: number;
}): Promise<number | null> {
  const momentsPath = path.join(input.runDir, "decisive-moments.json");
  if (input.series === null) {
    return null;
  }
  const replaySnapshots = await readReplaySnapshotsForDecisiveMoments(
    input.runDir,
  );
  const artifact = buildAgentDecisiveMoments({
    runID: input.runKey,
    series: input.series,
    telemetryEvents: input.telemetryEvents,
    totalTurns: input.totalTurns,
    replaySnapshots,
  });
  if (artifact === null) {
    await fs.rm(momentsPath, { force: true });
    return null;
  }
  await fs.writeFile(momentsPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact.moments.length;
}

async function readEvidenceInputs(
  runDir: string,
): Promise<{
  spectatorTelemetryRaw: string | null;
  decisionsJsonlRaw: string | null;
}> {
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
  return { spectatorTelemetryRaw, decisionsJsonlRaw };
}

/**
 * Whether `match-recap.json` needs (re)computing independent of whether
 * `drama-report.json`/`match-story.json` already exist: missing entirely
 * (never generated, OR a genuinely quiet match that legitimately produced
 * none under the CURRENT algorithm — recomputing is harmless/idempotent
 * either way, see `buildAgentMatchRecap`'s "never padded" doc) or present
 * but stamped with an older `schemaVersion` than `AGENT_MATCH_RECAP_SCHEMA_VERSION`
 * (a pre-fix artifact — see that constant's own doc for the 2026-08-01
 * alliance-aggregation/cap fix this exists to force a re-curation for).
 */
async function recapNeedsRegeneration(runDir: string): Promise<boolean> {
  const raw = await readBoundedRunDirArtifact(
    path.join(runDir, "match-recap.json"),
    maximumMatchRecapBytes,
  );
  if (raw === null) {
    return true;
  }
  try {
    const value = JSON.parse(raw) as { schemaVersion?: unknown };
    return value.schemaVersion !== AGENT_MATCH_RECAP_SCHEMA_VERSION;
  } catch {
    return true;
  }
}

/**
 * Recomputes ONLY `match-recap.json` for a run dir whose `drama-report.json`/
 * `match-story.json` already exist and stay untouched — see
 * `recapNeedsRegeneration`'s doc. `null` when the raw telemetry/decisions
 * inputs this run was originally generated from are no longer readable
 * (e.g. pruned by retention since the original generation) — the caller
 * treats that the same as `skipped-no-usable-evidence`, never a throw.
 */
async function upgradeStaleRecap(
  runDir: string,
  runKey: string,
): Promise<MatchNarrativeGenerationOutcome | null> {
  const { spectatorTelemetryRaw, decisionsJsonlRaw } =
    await readEvidenceInputs(runDir);
  if (spectatorTelemetryRaw === null && decisionsJsonlRaw === null) {
    return null;
  }
  const finalTurnCount = await readMatchSummaryFinalTurnCount(runDir);
  const evidence = resolveMirroredMatchEvidence({
    runID: runKey,
    spectatorTelemetryRaw,
    decisionsJsonlRaw,
    finalTurnCount,
  });
  if (evidence === null) {
    return null;
  }
  const recapPath = path.join(runDir, "match-recap.json");
  const series = await readMatchStateSeries(runDir);
  const recap = buildAgentMatchRecap({
    runID: runKey,
    telemetry: evidence.telemetry,
    finalTurnCount,
    series,
  });
  if (recap !== null) {
    await writeAgentMatchRecapArtifacts({ recap, directory: runDir });
  } else {
    // The re-curated pass now finds zero public-worthy beats (e.g. every
    // prior beat was churn the aggregation collapsed away) — remove the
    // stale file rather than leave known-spammy content being served.
    await fs.rm(recapPath, { force: true });
  }
  const decisiveMomentCount = await writeDecisiveMomentsArtifact({
    runDir,
    runKey,
    series,
    telemetryEvents: evidence.telemetry.events,
    totalTurns: series?.totalTurns ?? 0,
  });
  return {
    status: "recap-upgraded",
    source: evidence.source,
    recapBeatCount: recap?.beats.length ?? 0,
    curatedDramaScore: recap?.curatedDramaScore ?? null,
    decisiveMomentCount,
  };
}

/**
 * Generates `drama-report.json`/`.md`, `match-story.json`/`.md`, and
 * `match-recap.json` for one mirrored run dir if it doesn't have them yet.
 * Idempotent (checked via `drama-report.json`'s existence — `buildAgentDramaReport`
 * never returns a null report, so its presence reliably marks "already
 * generated", including for a genuinely quiet match with a zero drama
 * score) and never throws — every failure mode resolves to a structured
 * outcome the caller logs and moves on from. Mirror resilience is sacred:
 * this function alone can never fail a sync cycle, and never blocks or
 * delays the league publish.
 *
 * Idempotency is layered: when `drama-report.json` already exists, this
 * does NOT necessarily skip entirely — it separately checks whether
 * `match-recap.json` is stale or missing (`recapNeedsRegeneration`) and,
 * if so, upgrades ONLY the recap (`upgradeStaleRecap`) without re-running
 * the drama/story generators (their output isn't changing).
 */
export async function generateMatchNarrativeArtifactsForRunDir(
  runDir: string,
  runKey: string,
): Promise<MatchNarrativeGenerationResult> {
  const dramaReportPath = path.join(runDir, "drama-report.json");
  let dramaReportExists = false;
  try {
    await fs.stat(dramaReportPath);
    dramaReportExists = true;
  } catch {
    // ENOENT (or any other stat failure) — fall through to full generation.
  }

  if (dramaReportExists) {
    const needsRegeneration = await recapNeedsRegeneration(runDir);
    const decisiveMomentsMissing = await decisiveMomentsNeedGeneration(runDir);
    if (!needsRegeneration && !decisiveMomentsMissing) {
      return {
        runKey,
        attempted: false,
        outcome: { status: "already-exists" },
      };
    }
    try {
      const outcome = await upgradeStaleRecap(runDir, runKey);
      if (outcome === null) {
        return {
          runKey,
          attempted: true,
          outcome: { status: "skipped-no-usable-evidence" },
        };
      }
      return { runKey, attempted: true, outcome };
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

  const { spectatorTelemetryRaw, decisionsJsonlRaw } =
    await readEvidenceInputs(runDir);
  if (spectatorTelemetryRaw === null && decisionsJsonlRaw === null) {
    return { runKey, attempted: false, outcome: { status: "no-input" } };
  }
  try {
    const finalTurnCount = await readMatchSummaryFinalTurnCount(runDir);
    const evidence = resolveMirroredMatchEvidence({
      runID: runKey,
      spectatorTelemetryRaw,
      decisionsJsonlRaw,
      finalTurnCount,
    });
    if (evidence === null) {
      return {
        runKey,
        attempted: true,
        outcome: { status: "skipped-no-usable-evidence" },
      };
    }

    const series = await readMatchStateSeries(runDir);
    const recap = buildAgentMatchRecap({
      runID: runKey,
      telemetry: evidence.telemetry,
      finalTurnCount,
      series,
    });
    if (recap !== null) {
      await writeAgentMatchRecapArtifacts({ recap, directory: runDir });
    }
    const decisiveMomentCount = await writeDecisiveMomentsArtifact({
      runDir,
      runKey,
      series,
      telemetryEvents: evidence.telemetry.events,
      totalTurns: series?.totalTurns ?? 0,
    });

    if (evidence.records.length === 0) {
      // decisions.jsonl was absent/unusable even though telemetry resolved
      // — buildAgentDramaReport/buildAgentMatchStory require raw records
      // verbatim and cannot run; ship the recap alone rather than fabricate
      // scores from thin air.
      return {
        runKey,
        attempted: true,
        outcome: {
          status: "generated-recap-only",
          source: evidence.source,
          recapBeatCount: recap?.beats.length ?? 0,
          curatedDramaScore: recap?.curatedDramaScore ?? null,
          decisiveMomentCount,
        },
      };
    }

    const scenario = "coworld-league";
    const brainMode = "external-http" as const;
    const dramaReport = buildAgentDramaReport({
      runID: runKey,
      matchID: runKey,
      scenario,
      brainMode,
      records: evidence.records,
      roster: evidence.roster,
      finalState: evidence.finalState,
    });
    const matchStory = buildAgentMatchStory({
      runID: runKey,
      matchID: runKey,
      scenario,
      brainMode,
      records: evidence.records,
    });
    await Promise.all([
      writeAgentDramaReportArtifacts({
        report: dramaReport,
        directory: runDir,
      }),
      writeAgentMatchStoryArtifacts({ story: matchStory, directory: runDir }),
    ]);

    return {
      runKey,
      attempted: true,
      outcome: {
        status: "generated",
        source: evidence.source,
        dramaScore: dramaReport.dramaScore,
        entertainmentGrade: matchStory.grade,
        recapBeatCount: recap?.beats.length ?? 0,
        curatedDramaScore: recap?.curatedDramaScore ?? null,
        decisiveMomentCount,
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
 * Gradually backfills drama/story/recap artifacts across already-retained
 * run dirs still missing them, spending up to `budget` generation attempts
 * — same deterministic ascending-name, budget-bounded, fail-open scan
 * `backfillMatchStateSeries` uses.
 */
export async function backfillMatchNarrativeArtifacts(
  runsRootDir: string,
  budget: number,
  alreadyAttempted: ReadonlySet<string> = new Set(),
): Promise<MatchNarrativeGenerationResult[]> {
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
  const results: MatchNarrativeGenerationResult[] = [];
  let remaining = budget;
  for (const name of candidateNames) {
    if (remaining <= 0) {
      break;
    }
    if (alreadyAttempted.has(name)) {
      continue;
    }
    const result = await generateMatchNarrativeArtifactsForRunDir(
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
