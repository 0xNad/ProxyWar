import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  FeaturedMatchSchema,
  newFeaturedMatchId,
  type FeaturedMatch,
  type FeaturedMatchEvidence,
} from "../server/agents/FeaturedMatch";
import type { CoworldLeagueMirrorData } from "../server/agents/CoworldLeagueSiteWriter";

/**
 * `premiere:candidates` — read-only ranking CLI for Stage 3's SEALED
 * premiere lane (product overhaul spec Stage 3 item 2). Lists the sealed,
 * unpublished items sitting in the real-premiere queue's `ready/` directory
 * (`premiere-queue-lib.sh`) and ranks them for an operator to hand-pick from
 * ahead of a future scheduling step. This CLI NEVER writes to the
 * `FeaturedMatch` store (`premiere:schedule`/`publish`, built elsewhere,
 * own that) and NEVER mixes with the archive lane (`feature:candidates`).
 *
 * Evidence honesty (see `FeaturedMatchEvidenceSchema`'s own doc comment):
 * a sealed queue item's `bundle.source.json` embeds the OpenFront game
 * record plus seat identities, but `generate-premiere-queue.sh` deletes the
 * raw episode artifacts (`decisions.jsonl`, the drama/story reports
 * `AgentDecisionLogWriter.ts` writes, etc.) the moment a bundle is sealed —
 * confirmed by reading that script's own `rm -rf "$work_tmp" "$bundle_dir"`
 * cleanup after `pq_publish`. `meta.json` and `bundle.source.json` alike
 * carry no `decisionCount`/`degradedCount`/drama/story fields (verified by
 * reading `PremiereWageringSourceBundle.ts`'s bundle writer end to end —
 * the only per-episode AI-decision stats it ever reads,
 * `xp-request-roster.json`'s `decisionCount`/`degradedCount`, are consumed
 * for the wagering lane's own purposes and never copied into the bundle it
 * writes). So for THIS lane those signals are always `null`, always with an
 * explanatory `evidence.notes` entry — never a fabricated zero. Ranking
 * below is therefore turnCount/seatCount only; this CLI never opens
 * `bundle.source.json` at all (it can embed an arbitrarily large game
 * record and none of its fields are needed for ranking or the named-
 * rejection check).
 *
 * "Severely degraded" for this lane (spec: never rank a broken match above
 * a clean one) can't use `degradedCount` — it isn't available here — so it
 * is defined instead from the two signals that are: a match that ended in
 * implausibly few turns, or with fewer than two real seats, almost
 * certainly aborted or crashed rather than playing out organically. See
 * `SEVERELY_DEGRADED_MIN_TURN_COUNT`/`SEVERELY_DEGRADED_MIN_SEAT_COUNT`.
 */

const SEVERELY_DEGRADED_MIN_TURN_COUNT = 50;
const SEVERELY_DEGRADED_MIN_SEAT_COUNT = 2;

const MetaJsonSchema = z
  .object({
    schemaVersion: z.number(),
    kind: z.string(),
    runId: z.string(),
    sourceFile: z.string(),
    sha256: z.string(),
    turnCount: z.number().int().nonnegative(),
    seatCount: z.number().int().nonnegative(),
    map: z.string(),
    checkpointTurns: z.array(z.number()),
    turnIntervalMs: z.number(),
    coworldId: z.string(),
    variantId: z.string(),
    episodeId: z.string().nullable(),
    experienceRequestId: z.string().nullable(),
    generatedAt: z.string(),
  })
  .passthrough();
type MetaJson = z.infer<typeof MetaJsonSchema>;

export interface PremiereQueueCandidate {
  queueItemName: string;
  meta: MetaJson;
  featuredMatch: FeaturedMatch;
  severelyDegraded: boolean;
  degradedReasons: string[];
  /**
   * Season Zero activation prompt Phase 4 item 3 ("Candidate evidence
   * upgrade") — always `[]` for THIS lane: `buildReasonToWatchClaims`
   * (`CandidateReasonToWatch.ts`) needs resolved participant identity to
   * emit anything, and this lane's `featuredMatch.participants` is always
   * `[]` (see `buildFeaturedMatchDraft`'s own doc — this CLI deliberately
   * never opens `bundle.source.json`). Kept as a real field (not omitted)
   * so the sealed lane's output shape matches `feature:candidates`'
   * `reasonToWatchClaims`, an honest "no evidence available" rather than
   * a missing key a consumer has to special-case.
   */
  reasonToWatchClaims: [];
}

export interface PremiereQueueRejection {
  queueItemName: string;
  episodeId: string | null;
  experienceRequestId: string | null;
  reason: string;
}

export interface RankPremiereCandidatesResult {
  candidates: PremiereQueueCandidate[];
  rejected: PremiereQueueRejection[];
}

/** Same default as `premiere-queue-lib.sh`'s `PW_QUEUE_ROOT` — `${PW_BET_QUEUE_DIR:-$HOME/.proxywar-deploy/premiere-queue}`. */
export function resolveDefaultQueueReadyDir(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment.PW_BET_QUEUE_DIR?.trim();
  const queueRoot =
    configured === undefined || configured === ""
      ? path.join(homeDirectory, ".proxywar-deploy", "premiere-queue")
      : configured;
  return path.join(queueRoot, "ready");
}

/** Same default as `ai-agent-demo-server.ts`/`replay-premiere-loop.ts`'s `PROXYWAR_ARTIFACTS_ROOT` resolution. */
export function resolveDefaultArtifactsRoot(
  environment: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = environment.PROXYWAR_ARTIFACTS_ROOT?.trim();
  return configured === undefined || configured === ""
    ? path.join(cwd, "artifacts")
    : path.resolve(configured);
}

/** The live league mirror's `data.json`, same path `writeCoworldLeagueSite` publishes to (`artifactsRoot/ai-league-runs/league/data.json`) — read tolerantly, same shape check `coworld-league-mirror.ts`'s own `readPreviousMirrorData` uses: a missing or malformed file just means "no published episodes to cross-reference against" rather than a crash (this CLI must run with no server ever having started). */
export async function readPublishedEpisodeRequestIds(
  artifactsRoot: string,
): Promise<ReadonlySet<string>> {
  const dataPath = path.join(
    artifactsRoot,
    "ai-league-runs",
    "league",
    "data.json",
  );
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(dataPath, "utf8"));
  } catch {
    return new Set();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("episodes" in value) ||
    !Array.isArray(value.episodes)
  ) {
    return new Set();
  }
  // No zod schema exists for this large mirror-data interface (matching
  // `coworld-league-mirror.ts`'s own `readPreviousMirrorData`, which casts
  // the same way after the same array-shape check); the array check above
  // is what actually gates the cross-reference below.
  const data = value as CoworldLeagueMirrorData;
  return new Set(
    data.episodes
      .map((episode) => episode.episodeRequestId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

async function listQueueItemNames(queueReadyDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(queueReadyDir, { withFileTypes: true });
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function severeDegradationReasons(meta: MetaJson): string[] {
  const reasons: string[] = [];
  if (meta.turnCount < SEVERELY_DEGRADED_MIN_TURN_COUNT) {
    reasons.push(
      `turnCount (${meta.turnCount}) is below the severely-degraded floor of ${SEVERELY_DEGRADED_MIN_TURN_COUNT} turns — likely an aborted or early-crashed match, not organic play`,
    );
  }
  if (meta.seatCount < SEVERELY_DEGRADED_MIN_SEAT_COUNT) {
    reasons.push(
      `seatCount (${meta.seatCount}) is below the minimum of ${SEVERELY_DEGRADED_MIN_SEAT_COUNT} — not a real multi-participant contest`,
    );
  }
  return reasons;
}

function buildEvidence(
  meta: MetaJson,
  degradedReasons: string[],
): FeaturedMatchEvidence {
  const notes = [
    "dramaScore/dramaGrade/entertainmentScore/storyGrade are unavailable for the premiere-queue lane: generate-premiere-queue.sh deletes decisions.jsonl and the drama/story reports the moment a bundle seals, and bundle.source.json never carried them in the first place.",
    "decisionCount/degradedCount are unavailable for the same reason — ranking below uses turnCount/seatCount only, the two fields meta.json actually carries.",
    ...degradedReasons.map((reason) => `severely degraded: ${reason}`),
  ];
  return {
    dramaScore: null,
    dramaGrade: null,
    entertainmentScore: null,
    storyGrade: null,
    turnCount: meta.turnCount,
    decisionCount: null,
    degradedCount: null,
    seatCount: meta.seatCount,
    // A queue item only ever exists in `ready/` once its bundle is fully
    // sealed and published (`pq_publish` is the last step) — an incomplete
    // attempt never reaches `ready/` at all (see `attempt_generate`'s own
    // cleanup-on-failure paths in generate-premiere-queue.sh).
    replayComplete: true,
    notes,
  };
}

function buildFeaturedMatchDraft(
  queueItemName: string,
  meta: MetaJson,
  now: string,
): FeaturedMatch {
  // Precedence: the league mirror's own `CoworldLeagueEpisodeRow.episodeRequestId`
  // is populated from Coworld's `ereq_...`-shaped id (verified in
  // `CoworldLeagueMirrorCore.ts` — `shortEpisodeId` strips an `ereq_` prefix),
  // which is the same id space as meta.json's `experienceRequestId` — so that
  // field is preferred; `episodeId` (Coworld's distinct internal episode id)
  // is only the fallback for an older/partial record.
  const episodeRequestId = meta.experienceRequestId ?? meta.episodeId ?? null;
  const degradedReasons = severeDegradationReasons(meta);
  const draft: FeaturedMatch = {
    schemaVersion: 1,
    matchId: newFeaturedMatchId(),
    lane: "premiere",
    episodeRequestId,
    queueItemName,
    title: `${meta.map} — ${meta.seatCount}p sealed premiere candidate (${meta.kind})`,
    description: `Sealed premiere-queue item ${queueItemName}: ${meta.turnCount} turns, ${meta.seatCount} seats on ${meta.map}, sealed ${meta.generatedAt}.`,
    // Per-seat participant identity lives in bundle.source.json's embedded
    // game record, which this CLI deliberately never opens (see module doc)
    // — never fabricated, left empty rather than guessed.
    participants: [],
    map: meta.map,
    format: meta.kind,
    provenance: {
      source: "premiere-queue",
      sourceRef: queueItemName,
      capturedAt: now,
    },
    state: "candidate",
    category: null,
    scheduledAt: null,
    revealAt: null,
    evidence: buildEvidence(meta, degradedReasons),
    postMatchSummary: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  return FeaturedMatchSchema.parse(draft);
}

/** Ranks the surviving (non-rejected) candidates: severely-degraded matches always sort after every healthy one (spec: never rank a broken match above a clean one), then by turnCount desc (the best available "contested match" proxy with drama scoring unavailable), then seatCount desc, then queueItemName asc for full determinism. */
function rankCandidates(
  candidates: PremiereQueueCandidate[],
): PremiereQueueCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.severelyDegraded !== b.severelyDegraded) {
      return a.severelyDegraded ? 1 : -1;
    }
    if (a.meta.turnCount !== b.meta.turnCount) {
      return b.meta.turnCount - a.meta.turnCount;
    }
    if (a.meta.seatCount !== b.meta.seatCount) {
      return b.meta.seatCount - a.meta.seatCount;
    }
    return a.queueItemName.localeCompare(b.queueItemName);
  });
}

export async function rankPremiereCandidates(options: {
  queueReadyDir: string;
  artifactsRoot: string;
  now?: () => Date;
}): Promise<RankPremiereCandidatesResult> {
  const now = (options.now?.() ?? new Date()).toISOString();
  const publishedEpisodeRequestIds = await readPublishedEpisodeRequestIds(
    options.artifactsRoot,
  );
  const itemNames = await listQueueItemNames(options.queueReadyDir);

  const candidates: PremiereQueueCandidate[] = [];
  const rejected: PremiereQueueRejection[] = [];

  for (const queueItemName of itemNames) {
    const metaPath = path.join(options.queueReadyDir, queueItemName, "meta.json");
    let metaRaw: unknown;
    try {
      metaRaw = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch (error) {
      rejected.push({
        queueItemName,
        episodeId: null,
        experienceRequestId: null,
        reason: `meta_json_unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const parsed = MetaJsonSchema.safeParse(metaRaw);
    if (!parsed.success) {
      rejected.push({
        queueItemName,
        episodeId: null,
        experienceRequestId: null,
        reason: `meta_json_invalid: ${parsed.error.message}`,
      });
      continue;
    }
    const meta = parsed.data;

    // Named-rejection: a fast, local, deterministic check against the
    // CURRENT published league mirror — NOT `ReplayPremiereEligibility.ts`'s
    // `assessPremiereEligibility` (that remains the real admission-time gate
    // and needs a live origin to probe URLs; this CLI runs with no server).
    const candidateIds = [meta.episodeId, meta.experienceRequestId].filter(
      (id): id is string => id !== null,
    );
    const matchedPublishedId = candidateIds.find((id) =>
      publishedEpisodeRequestIds.has(id),
    );
    if (matchedPublishedId !== undefined) {
      rejected.push({
        queueItemName,
        episodeId: meta.episodeId,
        experienceRequestId: meta.experienceRequestId,
        reason: `already_published_on_league: episode ${matchedPublishedId} appears in the live league mirror`,
      });
      continue;
    }

    const degradedReasons = severeDegradationReasons(meta);
    candidates.push({
      queueItemName,
      meta,
      featuredMatch: buildFeaturedMatchDraft(queueItemName, meta, now),
      severelyDegraded: degradedReasons.length > 0,
      degradedReasons,
      reasonToWatchClaims: [],
    });
  }

  return { candidates: rankCandidates(candidates), rejected };
}

function renderTable(result: RankPremiereCandidatesResult): string {
  const lines: string[] = [];
  const header = [
    "rank",
    "queueItem",
    "map",
    "turns",
    "seats",
    "degraded",
    "episodeRequestId",
  ];
  const rows = result.candidates.map((candidate, index) => [
    String(index + 1),
    candidate.queueItemName,
    candidate.meta.map,
    String(candidate.meta.turnCount),
    String(candidate.meta.seatCount),
    candidate.severelyDegraded ? "YES" : "",
    candidate.featuredMatch.episodeRequestId ?? "(none)",
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const formatRow = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
  lines.push(formatRow(header));
  lines.push(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) lines.push(formatRow(row));
  if (rows.length === 0) lines.push("(no ranked candidates)");

  lines.push("");
  lines.push(`Rejected (${result.rejected.length}):`);
  if (result.rejected.length === 0) {
    lines.push("  (none)");
  } else {
    for (const rejection of result.rejected) {
      lines.push(`  ${rejection.queueItemName}: ${rejection.reason}`);
    }
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]): {
  queueReadyDir: string;
  artifactsRoot: string;
  json: boolean;
} {
  const valueFor = (prefix: string): string | undefined => {
    const arg = argv.find((entry) => entry.startsWith(prefix));
    return arg === undefined ? undefined : arg.slice(prefix.length);
  };
  const queueRootOverride = valueFor("--queue-root=");
  const artifactsRootOverride = valueFor("--artifacts-root=");
  return {
    queueReadyDir:
      queueRootOverride === undefined
        ? resolveDefaultQueueReadyDir()
        : path.join(path.resolve(queueRootOverride), "ready"),
    artifactsRoot:
      artifactsRootOverride === undefined
        ? resolveDefaultArtifactsRoot()
        : path.resolve(artifactsRootOverride),
    json: argv.includes("--json"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await rankPremiereCandidates({
    queueReadyDir: options.queueReadyDir,
    artifactsRoot: options.artifactsRoot,
  });
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          queueReadyDir: options.queueReadyDir,
          artifactsRoot: options.artifactsRoot,
          candidates: result.candidates.map((candidate, index) => ({
            rank: index + 1,
            severelyDegraded: candidate.severelyDegraded,
            featuredMatch: candidate.featuredMatch,
            reasonToWatchClaims: candidate.reasonToWatchClaims,
          })),
          rejected: result.rejected,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(renderTable(result));
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
