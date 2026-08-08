import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CoworldLeagueMirrorData } from "../server/agents/CoworldLeagueSiteWriter";
import {
  FeaturedMatchSchema,
  newFeaturedMatchId,
  type FeaturedMatch,
  type FeaturedMatchEvidence,
  type FeaturedMatchParticipant,
} from "../server/agents/FeaturedMatch";
import { resolveAgentIdentityView } from "../server/identity/IdentityMatching";
import type { IdentityRegistrySnapshot } from "../server/identity/IdentityRegistry";

/**
 * `premiere:candidates` — read-only ranking CLI for sealed premiere bundles.
 * Lists unpublished items in the configured queue's `ready/` directory and
 * ranks them for an operator to hand-pick
 * ahead of a future scheduling step. This CLI NEVER writes to the
 * `FeaturedMatch` store (`premiere:schedule`/`publish`, built elsewhere,
 * own that) and NEVER mixes with the archive lane (`feature:candidates`).
 *
 * Evidence honesty (see `FeaturedMatchEvidenceSchema`'s own doc comment):
 * a sealed queue item's `bundle.source.json` embeds the OpenFront game
 * record plus seat identities, while `meta.json` and `bundle.source.json`
 * carry no decision/degradation/drama fields. For this lane those signals
 * are always `null`, always with an
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

/** Queue root for locally sealed premiere bundles. */
export function resolveDefaultQueueReadyDir(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment.PROXYWAR_PREMIERE_QUEUE_DIR?.trim();
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

/**
 * SPOILER-SAFE, single-candidate seat identity read — the fix for a real
 * bug found activating Season Zero: `buildFeaturedMatchDraft` above
 * always leaves `participants: []` (this module's ranking pass
 * deliberately never opens `bundle.source.json` — module doc), and
 * neither `premiere:package` nor `premiere:publish` ever populated it
 * either, so a premiere-lane record could NEVER satisfy
 * `EventPackageGate.isPubliclyPromotable`'s `participants.length === 0`
 * check — every sealed premiere was structurally unpromotable. This is
 * called ONLY by `premiere-schedule-lib.ts`'s `ensurePremiereParticipants`,
 * for the ONE specific candidate an operator has just committed to
 * scheduling — never from the bulk `rankPremiereCandidates` scan above,
 * so that function's own "never opens bundle.source.json" invariant and
 * its O(ready-dir-size) cost stay exactly as documented.
 *
 * WHY THIS IS SAFE PRE-REVEAL: a sealed bundle's seat roster is NOT
 * embargoed — only the RESULT is (spec §2's "no anonymous public
 * Premiere" is about missing editorial metadata, never about hiding who
 * is playing). `ReplayPremierePublicPage.ts` already renders this EXACT
 * roster shape (`seatId`/`displayName`/`policyIdentity`) into the public
 * bet-surface page's HTML social metadata AND JS bootstrap
 * (`seatMetadata`/`policyIdentities`) during LIVE TRADING, well before
 * reveal — see that module's `renderReplayPremierePageHtml`/`policyIdentityStrings`. The
 * ONLY embargoed fields on `bundle.source.json` are `gameRecord` (full
 * turn-by-turn game state, including who won) and `authoritativeResult`
 * (the sealed, hashed outcome `ReplayPremiereAuthoritativeResult.ts`
 * verifies at reveal time) — `SealedBundleSeatsOnlySchema` below declares
 * ONLY the top-level `seats` field, so `.parse()`'s default (non-
 * passthrough) behavior STRIPS `gameRecord`/`authoritativeResult`/
 * `provenance`/everything else out of the returned value; the raw parsed
 * object holding those result-bearing fields is discarded (never
 * assigned to a named variable, logged, or returned) the moment this
 * function returns. `JSON.parse` necessarily deserializes the whole file
 * into memory first (there is no streaming JSON reader in this
 * codebase) — that is an unavoidable consequence of the file being one
 * JSON document, not a leak: nothing outside this function ever sees
 * those bytes.
 */
const SealedBundlePolicyIdentitySchema = z.union([
  z.object({
    namespace: z.literal("softmax_policy_version"),
    policyVersionId: z.string(),
    policyName: z.string(),
    serverAssignedVersion: z.string(),
  }),
  z.object({
    namespace: z.literal("local_manifest"),
    manifestName: z.string(),
    declaredVersion: z.string(),
    manifestSha256: z.string(),
    contentSha256: z.string(),
  }),
]);

const SealedBundleSeatsOnlySchema = z.object({
  seats: z.array(
    z.object({
      seatId: z.string(),
      displayName: z.string(),
      policyIdentity: SealedBundlePolicyIdentitySchema,
    }),
  ),
});
type SealedBundleSeat = z.infer<
  typeof SealedBundleSeatsOnlySchema
>["seats"][number];

/** Bounded because `bundle.source.json` embeds a full game record. */
const MAX_SEALED_BUNDLE_BYTES = 512 * 1024 * 1024;

/**
 * `displayName` is the real Coworld player name for this seat (verbatim
 * `game-record.json` `player.username`), the same namespace `findAgentForPlayerName`
 * matches on everywhere else. The bundle's `policyIdentity.policyName`
 * (when `namespace === "softmax_policy_version"`) is the EXACT policy
 * label live for this specific captured match — passed as
 * `ratingPolicyLabel` rather than cross-referencing CURRENT live
 * standings (unlike `feature-candidates.ts`'s `buildParticipants`, which
 * has no historical label available at all and must fall back to
 * "current"): footage of an already-played sealed match should credit
 * the version that ACTUALLY played in it, not whatever the agent has
 * moved on to by air time. `local_manifest` seats (a locally-produced
 * exhibition identity scheme) have no comparable
 * label in this shape — `agentVersionId` stays `null` rather than
 * guessed from a different field.
 */
function resolveSealedBundleParticipant(
  seat: SealedBundleSeat,
  identity: IdentityRegistrySnapshot,
): FeaturedMatchParticipant {
  const ratingPolicyLabel =
    seat.policyIdentity.namespace === "softmax_policy_version"
      ? seat.policyIdentity.policyName
      : null;
  const view = resolveAgentIdentityView(
    {
      playerName: seat.displayName,
      ratingPolicyLabel,
      activeChampionPolicyLabel: null,
    },
    identity.agents,
    identity.builders,
    identity.versions,
  );
  return {
    playerName: seat.displayName,
    agentId: view.agent?.id ?? null,
    agentVersionId: view.version?.registered?.id ?? null,
    builderId: view.builder?.id ?? null,
  };
}

export type ResolveSealedBundleParticipantsResult =
  | { ok: true; participants: FeaturedMatchParticipant[] }
  | { ok: false; reason: string };

export async function resolveSealedBundleParticipants(
  queueReadyDir: string,
  queueItemName: string,
  identity: IdentityRegistrySnapshot,
): Promise<ResolveSealedBundleParticipantsResult> {
  const bundlePath = path.join(
    queueReadyDir,
    queueItemName,
    "bundle.source.json",
  );
  let stat;
  try {
    stat = await fs.stat(bundlePath);
  } catch {
    return { ok: false, reason: `sealed bundle not found at ${bundlePath}` };
  }
  if (!stat.isFile() || stat.size > MAX_SEALED_BUNDLE_BYTES) {
    return {
      ok: false,
      reason: `${bundlePath} is not a regular file within the ${MAX_SEALED_BUNDLE_BYTES}-byte bound`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(bundlePath, "utf8"));
  } catch {
    return { ok: false, reason: `${bundlePath} is not valid JSON` };
  }
  const parsed = SealedBundleSeatsOnlySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `${bundlePath} does not carry a valid top-level "seats" array (${parsed.error.issues[0]?.message ?? "schema mismatch"})`,
    };
  }
  if (parsed.data.seats.length === 0) {
    return { ok: false, reason: `${bundlePath} carries zero seats` };
  }
  return {
    ok: true,
    participants: parsed.data.seats.map((seat) =>
      resolveSealedBundleParticipant(seat, identity),
    ),
  };
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
    const metaPath = path.join(
      options.queueReadyDir,
      queueItemName,
      "meta.json",
    );
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
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
