import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildAgentDramaReport,
  writeAgentDramaReportArtifacts,
} from "./AgentDramaReport";
import {
  buildAgentMatchStory,
  writeAgentMatchStoryArtifacts,
} from "./AgentMatchStory";
import { buildAgentMatchRecap, writeAgentMatchRecapArtifacts } from "./AgentMatchRecap";
import {
  maximumDecisionsJsonlBytes,
  maximumSpectatorTelemetryBytes,
  readBoundedRunDirArtifact,
  readMatchSummaryFinalTurnCount,
} from "./CoworldLeagueBackfillIo";
import { resolveMirroredMatchEvidence } from "./CoworldLeagueMirrorCore";

/**
 * IO orchestration for the mirror-side "drama recaps" gap closure — the
 * SAME pattern `CoworldLeagueDirectorCutBackfill.ts` established: per-run,
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
 * `SpectatorTelemetry`, unlike `buildDirectorCutPlan`) — `resolveMirroredMatchEvidence`
 * (shared with the Director Cut backfill) always resolves those records from
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
    }
  | {
      status: "generated-recap-only";
      source: "spectator-telemetry" | "decisions-log";
      recapBeatCount: number;
    }
  | { status: "failed"; error: string };

export interface MatchNarrativeGenerationResult {
  runKey: string;
  /** Whether this call actually attempted generation — the caller's per-cycle budget counter should only decrement when this is `true`. `already-exists` and `no-input` are both free. */
  attempted: boolean;
  outcome: MatchNarrativeGenerationOutcome;
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
 */
export async function generateMatchNarrativeArtifactsForRunDir(
  runDir: string,
  runKey: string,
): Promise<MatchNarrativeGenerationResult> {
  const dramaReportPath = path.join(runDir, "drama-report.json");
  try {
    await fs.stat(dramaReportPath);
    return { runKey, attempted: false, outcome: { status: "already-exists" } };
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

    const recap = buildAgentMatchRecap({
      runID: runKey,
      telemetry: evidence.telemetry,
      finalTurnCount,
    });
    if (recap !== null) {
      await writeAgentMatchRecapArtifacts({ recap, directory: runDir });
    }

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
      writeAgentDramaReportArtifacts({ report: dramaReport, directory: runDir }),
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
 * `backfillDirectorCutPlans` uses.
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

