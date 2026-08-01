#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  publicRunKeyFromFullRenderHref,
  publicRunKeyFromWatchHref,
} from "../server/agents/CoworldLeagueArtifactRetention";
import type {
  CoworldLeagueEpisodeRow,
  CoworldLeagueMirrorData,
  CoworldLeagueStandingRow,
} from "../server/agents/CoworldLeagueSiteWriter";
import {
  FeaturedMatchSchema,
  newFeaturedMatchId,
  type FeaturedMatch,
  type FeaturedMatchEvidence,
  type FeaturedMatchParticipant,
  type FeaturedMatchResult,
} from "../server/agents/FeaturedMatch";
import { AGENT_MATCH_RECAP_SCHEMA_VERSION } from "../server/agents/AgentMatchRecap";
import { resolveAgentIdentityView } from "../server/identity/IdentityMatching";
import {
  loadIdentityRegistrySnapshot,
  type IdentityRegistrySnapshot,
} from "../server/identity/IdentityRegistry";
import { buildReasonToWatchClaims } from "../server/agents/season/CandidateReasonToWatch";
import type { EventPackageClaim } from "../server/agents/season/EventPackage";

/**
 * `feature:candidates` — Stage 3 item 2/3, ARCHIVE lane. Scans COMPLETED,
 * PUBLISHED league episodes (the live Coworld league mirror's `data.json`,
 * `completedAt !== null`) and ranks them as `FeaturedMatch` drafts
 * (`lane: "archive"`) for an operator to hand-pick for Featured Archive
 * placement. READ-ONLY: this CLI never writes the `FeaturedMatch` store —
 * see `premiere:schedule`/`publish` for that.
 *
 * ## Drama/story artifact availability (updated — "drama recaps" gap closure)
 *
 * Every candidate this CLI ranks comes from `CoworldLeagueEpisodeRow[]`,
 * populated by `coworld-league-mirror.ts` downloading HOSTED Coworld
 * replays and unpacking them via that script's `unpackEpisodeRunDir` into
 * `<artifactsRoot>/ai-league-runs/<runKey>/`. That mirror now ALSO runs
 * `CoworldLeagueMatchNarrativeBackfill.ts` (budgeted, gradual — same
 * fresh-episodes-first-then-backfill shape `director-cut-plan.json`
 * generation already used) to call `buildAgentDramaReport`/
 * `buildAgentMatchStory`/`buildAgentMatchRecap` for a mirrored run and
 * write `drama-report.json`/`match-story.json`/`match-recap.json` next to
 * it — previously this ONLY happened for LOCALLY-produced matches via
 * `ai-agent-league-smoke.ts`/`ai-agent-tournament.ts`/
 * `ai-agent-frontier-benchmark.ts`, which never published into the hosted
 * league this CLI's data source mirrors.
 *
 * Net result: `drama-report.json`/`match-story.json` now exist on disk for
 * any hosted episode the backfill has already reached — budgeted, so a
 * given candidate may still show `null` evidence for a cycle or two after
 * it first appears, exactly like `directorCut` does; that's expected, not
 * a defect. This CLI already derived each candidate's expected artifact
 * directory from its `watchHref`/`fullRenderHref` (the same
 * `league-coworld-<runID>` key `CoworldLeagueArtifactRetention.ts` already
 * parses) and checked file existence per candidate rather than assuming
 * absence — no code change was needed here for real evidence to start
 * ranking candidates once the mirror-side backfill began writing it.
 */

interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

interface CliOptions {
  artifactsRoot: string | undefined;
  json: boolean;
}

/**
 * Same "elevated" threshold `CoworldLeagueSiteWriter.ts`'s battle cards
 * already use for `degradedCount / decisionCount` (`DEGRADED_WARNING_PERCENT
 * = 15`) — reused here rather than reinvented so an operator sees the same
 * "this match had real trouble" line in both surfaces. Not imported (that
 * constant isn't exported, and this module has no other reason to couple to
 * the HTML writer) — kept as a literal with this comment as the citation.
 */
const SEVERE_DEGRADED_PERCENT = 15;

export interface RankedFeatureCandidate {
  rank: number;
  match: FeaturedMatch;
  compositeScore: number | null;
  severelyDegraded: boolean;
  artifactDirectory: string | null;
  dramaArtifactFound: boolean;
  matchStoryArtifactFound: boolean;
  /**
   * 2026-08-01 "best battles" ranking fix: which source `match.evidence.
   * dramaScore`/`dramaGrade` actually came from — `"curated"` when
   * `match-recap.json`'s deduped `curatedDramaScore` was available (the
   * preferred, non-inflatable score — see `AgentMatchRecap.ts`'s doc),
   * `"legacy"` when this run only has the raw, un-deduped
   * `drama-report.json` composite (an honest fallback, visible here and
   * in `evidence.notes` rather than silently blended with curated runs),
   * `null` when neither exists for this run.
   */
  dramaScoreSource: "curated" | "legacy" | null;
  /**
   * Season Zero activation prompt Phase 4 item 3 ("Candidate evidence
   * upgrade"): structured, evidence-backed reason-to-watch claims — see
   * `CandidateReasonToWatch.ts`'s own doc for exactly what data each
   * claim source is grounded in. `[]` (never fabricated filler) when no
   * signal clears its sample-size floor for this candidate.
   */
  reasonToWatchClaims: EventPackageClaim[];
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { artifactsRoot: undefined, json: false };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    // Table is the default output; accepted explicitly for symmetry with
    // `--json` and with `premiere:candidates`' identical output contract.
    if (arg === "--table") {
      continue;
    }
    if (arg.startsWith("--artifacts-root=")) {
      options.artifactsRoot = arg.slice("--artifacts-root=".length);
      continue;
    }
    throw new Error(`feature_candidates_cli_unknown_argument: ${arg}`);
  }
  return options;
}

/** Same override-with-safe-default shape `ai-agent-demo-server.ts`/`replay-premiere-loop.ts` already use for `PROXYWAR_ARTIFACTS_ROOT`. */
function resolveArtifactsRoot(
  explicit: string | undefined,
  environment: Record<string, string | undefined> = process.env,
): string {
  if (explicit !== undefined && explicit !== "") {
    return path.resolve(explicit);
  }
  const configured = environment.PROXYWAR_ARTIFACTS_ROOT?.trim();
  if (configured !== undefined && configured !== "") {
    return path.resolve(configured);
  }
  return path.join(process.cwd(), "artifacts");
}

/** Mirrors `coworld-league-mirror.ts`'s own `readPreviousMirrorData`: fail open to `null` on any missing/corrupt file rather than crash an operator CLI that may run before the mirror has ever synced. */
async function readLiveMirrorData(
  siteDir: string,
): Promise<CoworldLeagueMirrorData | null> {
  try {
    const raw = await fs.readFile(path.join(siteDir, "data.json"), "utf8");
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("episodes" in value) ||
      !Array.isArray(value.episodes)
    ) {
      return null;
    }
    // Shallow shape check only (episode array presence) — full schema
    // validation of the mirror's own data.json is out of scope for a
    // read-only ranking CLI; `coworld-league-mirror.ts` is the writer and
    // sole source of truth for this file's exact shape.
    const mirrorData = value as CoworldLeagueMirrorData;
    return mirrorData;
  } catch {
    return null;
  }
}

interface DramaEvidence {
  dramaScore: number;
  dramaGrade: string;
}

interface StoryEvidence {
  entertainmentScore: number;
  grade: string;
}

/** Reads and validates just the two fields this CLI ranks on — never trusts the full `AgentDramaReport` shape blindly; a mirror-side format drift degrades to "absent" (honest `null` evidence) rather than a bad cast. */
async function readDramaEvidence(
  filePath: string,
): Promise<DramaEvidence | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("dramaScore" in parsed) ||
    !("dramaGrade" in parsed) ||
    typeof parsed.dramaScore !== "number" ||
    typeof parsed.dramaGrade !== "string"
  ) {
    return null;
  }
  return { dramaScore: parsed.dramaScore, dramaGrade: parsed.dramaGrade };
}

/** See {@link readDramaEvidence} — same narrow-field-validation rationale, applied to `match-story.json`. */
async function readStoryEvidence(
  filePath: string,
): Promise<StoryEvidence | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entertainmentScore" in parsed) ||
    !("grade" in parsed) ||
    typeof parsed.entertainmentScore !== "number" ||
    typeof parsed.grade !== "string"
  ) {
    return null;
  }
  return {
    entertainmentScore: parsed.entertainmentScore,
    grade: parsed.grade,
  };
}

/** Derives the mirror's own `<artifactsRoot>/ai-league-runs/<runKey>/` directory from the episode row's own hrefs — the exact keys `CoworldLeagueArtifactRetention.ts` already parses and validates. `null` when neither href is a well-formed managed run link (e.g. replay never downloaded). */
function findArtifactDirectory(
  row: CoworldLeagueEpisodeRow,
  runsRootDir: string,
): string | null {
  const runKey =
    publicRunKeyFromFullRenderHref(row.fullRenderHref) ??
    publicRunKeyFromWatchHref(row.watchHref);
  return runKey === null ? null : path.join(runsRootDir, runKey);
}

/**
 * Reads and validates `match-recap.json`'s `curatedDramaScore` — the
 * PUBLIC "best battles" ranking score (deduped alliance/betrayal/
 * elimination/final-clash beats, see `AgentMatchRecap.ts`'s own doc for
 * the formula) — preferred over `drama-report.json`'s legacy raw
 * composite when available. Same narrow-field-validation rationale as
 * {@link readDramaEvidence}: a mirror-side format drift, or a pre-fix
 * artifact stamped with an older `schemaVersion` (awaiting
 * `upgradeStaleRecap`), degrades to "absent" — an honest fallback to the
 * legacy score, never a stale-formula score silently ranking matches.
 */
async function readCuratedDramaScore(filePath: string): Promise<number | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== AGENT_MATCH_RECAP_SCHEMA_VERSION ||
    !("curatedDramaScore" in parsed) ||
    typeof parsed.curatedDramaScore !== "number"
  ) {
    return null;
  }
  return parsed.curatedDramaScore;
}

/**
 * Mirrors `AgentDramaReport.ts`'s private `dramaGradeFor` thresholds
 * exactly (flat < 15, mild < 40, lively < 70, else dramatic) so a curated
 * score gets a grade label in the same vocabulary a legacy score would.
 * Duplicated rather than imported: that module is deliberately left
 * untouched by this fix (see its own class doc) and doesn't export the
 * helper. Presentation labeling only — never fed back into either
 * score's own math.
 */
function curatedDramaGradeFor(score: number): string {
  if (score < 15) return "flat";
  if (score < 40) return "mild";
  if (score < 70) return "lively";
  return "dramatic";
}

function buildEvidence(
  row: CoworldLeagueEpisodeRow,
  drama: DramaEvidence | null,
  story: StoryEvidence | null,
  curated: number | null,
  directory: string | null,
): FeaturedMatchEvidence {
  const notes: string[] = [];

  let dramaScore: number | null = null;
  let dramaGrade: string | null = null;
  if (curated !== null) {
    dramaScore = curated;
    dramaGrade = curatedDramaGradeFor(curated);
    notes.push(
      `drama score ${curated} (${dramaGrade}) read from match-recap.json's CURATED public "best battles" ranking score (deduped alliance/betrayal/elimination/final-clash beats — see AgentMatchRecap.ts) in the episode's mirrored run directory; preferred over drama-report.json's legacy composite`,
    );
  } else if (drama !== null) {
    dramaScore = drama.dramaScore;
    dramaGrade = drama.dramaGrade;
    notes.push(
      `drama score ${drama.dramaScore} (${drama.dramaGrade}) read from drama-report.json's LEGACY raw composite in the episode's mirrored run directory — match-recap.json's curated score is unavailable for this run (not yet generated/upgraded, or the curated pass found nothing story-worthy); this raw composite is un-deduped and can overstate churn-heavy matches (see AgentDramaReport.ts's own doc), so treat it as a lower-confidence fallback signal`,
    );
  } else if (directory === null) {
    notes.push(
      "no local run directory could be derived from this episode's watch/full-render links — drama score unavailable",
    );
  } else {
    notes.push(
      `drama-report.json not found (and match-recap.json's curated score is also unavailable) under ${directory} — hosted Coworld league episodes are downloaded via the league mirror, which never runs the drama scorer/curator until the narrative backfill reaches this run; this is expected, not a defect`,
    );
  }

  let entertainmentScore: number | null = null;
  let storyGrade: string | null = null;
  if (story !== null) {
    entertainmentScore = story.entertainmentScore;
    storyGrade = story.grade;
    notes.push(
      `entertainment score ${story.entertainmentScore} (${story.grade}) read from match-story.json in the episode's mirrored run directory`,
    );
  } else if (directory === null) {
    notes.push(
      "no local run directory could be derived from this episode's watch/full-render links — story score unavailable",
    );
  } else {
    notes.push(
      `match-story.json not found under ${directory} — hosted Coworld league episodes never get a locally-generated match story; this is expected, not a defect`,
    );
  }

  const decisionCount = row.decisionCount;
  const degradedCount = row.degradedCount;
  const degradedShare =
    decisionCount !== null && decisionCount > 0 && degradedCount !== null
      ? (degradedCount / decisionCount) * 100
      : null;
  if (degradedShare !== null && degradedShare >= SEVERE_DEGRADED_PERCENT) {
    notes.push(
      `${degradedCount} of ${decisionCount} decisions (${Math.round(degradedShare)}%) were degraded — at/above the ${SEVERE_DEGRADED_PERCENT}% threshold this codebase already flags as elevated (CoworldLeagueSiteWriter's DEGRADED_WARNING_PERCENT); ranked below every clean candidate regardless of drama/story score`,
    );
  }

  const replayComplete =
    row.turnCount !== null &&
    row.decisionCount !== null &&
    (row.watchHref !== null || row.fullRenderHref !== null);
  if (!replayComplete) {
    notes.push(
      "replay data incomplete: missing turn/decision counts or no downloaded replay bundle — ranked below complete replays",
    );
  }

  return {
    dramaScore,
    dramaGrade,
    entertainmentScore,
    storyGrade,
    turnCount: row.turnCount,
    decisionCount: row.decisionCount,
    degradedCount: row.degradedCount,
    seatCount: row.players.length > 0 ? row.players.length : null,
    replayComplete,
    notes,
  };
}

/** Never ranks first even with a high raw drama/story score — the pairing with `buildEvidence`'s identical ratio check keeps this single source of truth. */
function isSeverelyDegradedOrIncomplete(
  evidence: FeaturedMatchEvidence,
): boolean {
  const degradedShare =
    evidence.decisionCount !== null &&
    evidence.decisionCount > 0 &&
    evidence.degradedCount !== null
      ? (evidence.degradedCount / evidence.decisionCount) * 100
      : null;
  return (
    (degradedShare !== null && degradedShare >= SEVERE_DEGRADED_PERCENT) ||
    !evidence.replayComplete
  );
}

function computeCompositeScore(evidence: FeaturedMatchEvidence): number | null {
  const scores = [evidence.dramaScore, evidence.entertainmentScore].filter(
    (value): value is number => value !== null,
  );
  if (scores.length === 0) {
    return null;
  }
  return scores.reduce((total, value) => total + value, 0) / scores.length;
}

/**
 * `CoworldLeagueEpisodeRow.players` carries no policy label at all (same
 * Coworld hosted-replay shape limitation `CoworldLeagueSiteWriter.ts`'s own
 * `battleCard` documents for the identical reason) — historical, per-match
 * policy provenance genuinely does not exist for a hosted episode. But this
 * function does not need the HISTORICAL label: a Featured Event's
 * participant card is about "who this agent IS today" (spec decision #5:
 * "current strategy description... version history"), and `standings`
 * (already threaded into `buildCandidate` for `reasonToWatchClaims`'
 * current-rank cross-reference — same precedent) carries each player's
 * CURRENT `ratingPolicyLabel`/`activeChampionPolicyLabel` by name. Without
 * this cross-reference every participant's `agentVersionId` resolved to
 * `null` unconditionally, which fails `EventPackageGate.isPubliclyPromotable`
 * for every candidate this CLI ever ranks — never a hand-wavable gap.
 * Falls back to `null` (never fabricated) for a participant who no longer
 * appears in current standings.
 */
function buildParticipants(
  row: CoworldLeagueEpisodeRow,
  identity: IdentityRegistrySnapshot,
  standings: readonly CoworldLeagueStandingRow[],
): FeaturedMatchParticipant[] {
  const standingByName = new Map(
    standings.map((standing) => [standing.playerName, standing]),
  );
  return row.players.map((player) => {
    const standing = standingByName.get(player.name);
    const view = resolveAgentIdentityView(
      {
        playerName: player.name,
        ratingPolicyLabel:
          standing?.ratingPolicyLabel ?? standing?.policyLabel ?? null,
        activeChampionPolicyLabel: standing?.activeChampionPolicyLabel ?? null,
      },
      identity.agents,
      identity.builders,
      identity.versions,
    );
    return {
      playerName: player.name,
      agentId: view.agent?.id ?? null,
      agentVersionId: view.version?.registered?.id ?? null,
      builderId: view.builder?.id ?? null,
    };
  });
}

/** Archive-lane result MAY be populated immediately (the match was already public) — placements use the same finish-order comparator `CoworldLeagueSiteWriter.ts`'s own battle cards sort by. */
function buildResult(
  row: CoworldLeagueEpisodeRow,
  identity: IdentityRegistrySnapshot,
): FeaturedMatchResult | null {
  if (row.players.length === 0) {
    return null;
  }
  const ordered = [...row.players].sort(
    (left, right) =>
      Number(right.isWinner) - Number(left.isWinner) ||
      right.tilesOwned - left.tilesOwned ||
      left.slot - right.slot,
  );
  const agentIdForPlayerName = (playerName: string): string | null =>
    resolveAgentIdentityView(
      { playerName, ratingPolicyLabel: null, activeChampionPolicyLabel: null },
      identity.agents,
      identity.builders,
      identity.versions,
    ).agent?.id ?? null;
  const winner = ordered.find((player) => player.isWinner) ?? null;
  return {
    winnerAgentId: winner === null ? null : agentIdForPlayerName(winner.name),
    placements: ordered.map((player, index) => ({
      agentId: agentIdForPlayerName(player.name),
      placement: index + 1,
    })),
  };
}

function buildTitle(row: CoworldLeagueEpisodeRow): string {
  const roundLabel =
    row.roundNumber !== null
      ? `Round ${row.roundNumber}`
      : "an unnumbered round";
  return row.winnerName !== null
    ? `${row.winnerName} wins — ${roundLabel} on ${row.map}`
    : `${roundLabel} on ${row.map}`;
}

function buildDescription(row: CoworldLeagueEpisodeRow): string {
  const facts: string[] = [
    `${row.players.length} participant${row.players.length === 1 ? "" : "s"}`,
  ];
  if (row.turnCount !== null) facts.push(`${row.turnCount} turns`);
  if (row.decisionCount !== null) facts.push(`${row.decisionCount} decisions`);
  if (row.winnerName !== null) facts.push(`winner: ${row.winnerName}`);
  const roundLabel =
    row.roundNumber !== null
      ? `round ${row.roundNumber}`
      : "an unnumbered round";
  const mapLabel =
    row.mapSize.length > 0 ? `${row.map} (${row.mapSize})` : row.map;
  return `Published Coworld league episode, ${roundLabel} on ${mapLabel}. ${facts.join(", ")}.`;
}

async function buildCandidate(
  row: CoworldLeagueEpisodeRow,
  runsRootDir: string,
  identity: IdentityRegistrySnapshot,
  standings: readonly CoworldLeagueStandingRow[],
  retainedEpisodes: readonly CoworldLeagueEpisodeRow[],
  now: Date,
): Promise<Omit<RankedFeatureCandidate, "rank">> {
  const directory = findArtifactDirectory(row, runsRootDir);
  const [drama, story, curated] = await Promise.all([
    directory === null
      ? Promise.resolve(null)
      : readDramaEvidence(path.join(directory, "drama-report.json")),
    directory === null
      ? Promise.resolve(null)
      : readStoryEvidence(path.join(directory, "match-story.json")),
    directory === null
      ? Promise.resolve(null)
      : readCuratedDramaScore(path.join(directory, "match-recap.json")),
  ]);
  const evidence = buildEvidence(row, drama, story, curated, directory);
  const nowIso = now.toISOString();
  const match = FeaturedMatchSchema.parse({
    schemaVersion: 1,
    matchId: newFeaturedMatchId(),
    lane: "archive",
    episodeRequestId: row.episodeRequestId,
    queueItemName: null,
    title: buildTitle(row),
    description: buildDescription(row),
    participants: buildParticipants(row, identity, standings),
    map: row.map,
    format: `${row.players.length}-player free-for-all`,
    provenance: {
      source: "league-archive",
      sourceRef: row.episodeRequestId,
      capturedAt: nowIso,
    },
    state: "published",
    category: null,
    scheduledAt: null,
    revealAt: null,
    evidence,
    postMatchSummary: null,
    result: buildResult(row, identity),
    createdAt: nowIso,
    updatedAt: nowIso,
  } satisfies FeaturedMatch);
  return {
    match,
    compositeScore: computeCompositeScore(evidence),
    severelyDegraded: isSeverelyDegradedOrIncomplete(evidence),
    artifactDirectory: directory,
    dramaArtifactFound: drama !== null,
    matchStoryArtifactFound: story !== null,
    dramaScoreSource: curated !== null ? "curated" : drama !== null ? "legacy" : null,
    reasonToWatchClaims: buildReasonToWatchClaims(
      match.participants,
      row.map,
      identity,
      standings,
      retainedEpisodes,
      now,
    ),
  };
}

function compareCandidates(
  a: Omit<RankedFeatureCandidate, "rank">,
  b: Omit<RankedFeatureCandidate, "rank">,
): number {
  if (a.severelyDegraded !== b.severelyDegraded) {
    return a.severelyDegraded ? 1 : -1;
  }
  if (a.compositeScore !== b.compositeScore) {
    if (a.compositeScore === null) return 1;
    if (b.compositeScore === null) return -1;
    return b.compositeScore - a.compositeScore;
  }
  const decisionsA = a.match.evidence.decisionCount ?? -1;
  const decisionsB = b.match.evidence.decisionCount ?? -1;
  if (decisionsA !== decisionsB) return decisionsB - decisionsA;
  const turnsA = a.match.evidence.turnCount ?? -1;
  const turnsB = b.match.evidence.turnCount ?? -1;
  if (turnsA !== turnsB) return turnsB - turnsA;
  return (a.match.episodeRequestId ?? "").localeCompare(
    b.match.episodeRequestId ?? "",
  );
}

function formatTable(ranked: readonly RankedFeatureCandidate[]): string {
  if (ranked.length === 0) {
    return "feature:candidates — no completed, published league episodes found.";
  }
  const headers = [
    "rank",
    "episodeRequestId",
    "map",
    "turns",
    "decisions",
    "degraded%",
    "drama",
    "story",
    "flags",
    "claims",
    "title",
  ];
  const rows = ranked.map((candidate) => {
    const evidence = candidate.match.evidence;
    const degradedShare =
      evidence.decisionCount !== null &&
      evidence.decisionCount > 0 &&
      evidence.degradedCount !== null
        ? `${Math.round((evidence.degradedCount / evidence.decisionCount) * 100)}%`
        : "—";
    const flags = [
      candidate.severelyDegraded ? "DEGRADED" : "",
      candidate.dramaArtifactFound ? "" : "no-drama",
      candidate.matchStoryArtifactFound ? "" : "no-story",
      candidate.dramaScoreSource === "legacy" ? "legacy-drama" : "",
    ]
      .filter((flag) => flag !== "")
      .join(",");
    return [
      String(candidate.rank),
      candidate.match.episodeRequestId ?? "—",
      candidate.match.map,
      evidence.turnCount === null ? "—" : String(evidence.turnCount),
      evidence.decisionCount === null ? "—" : String(evidence.decisionCount),
      degradedShare,
      evidence.dramaScore === null ? "—" : String(evidence.dramaScore),
      evidence.entertainmentScore === null
        ? "—"
        : String(evidence.entertainmentScore),
      flags === "" ? "—" : flags,
      String(candidate.reasonToWatchClaims.length),
      candidate.match.title,
    ];
  });
  const widths = headers.map((header, columnIndex) =>
    Math.max(header.length, ...rows.map((row) => row[columnIndex]!.length)),
  );
  const formatRow = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ");
  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
  ].join("\n");
}

export async function runFeatureCandidatesCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  try {
    const options = parseArgs(argv);
    const artifactsRoot = resolveArtifactsRoot(options.artifactsRoot);
    const siteDir = path.join(artifactsRoot, "ai-league-runs", "league");
    const runsRootDir = path.join(artifactsRoot, "ai-league-runs");
    const mirrorData = await readLiveMirrorData(siteDir);
    const identity = await loadIdentityRegistrySnapshot().catch(
      (error: unknown) => {
        io.stderr(
          `feature:candidates — identity registry failed to load, participants will show as unmapped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return {
          builders: [],
          agents: [],
          versions: [],
        } satisfies IdentityRegistrySnapshot;
      },
    );
    const episodes = (mirrorData?.episodes ?? []).filter(
      (episode) => episode.completedAt !== null,
    );
    const now = new Date();
    const built = await Promise.all(
      episodes.map((row) => buildCandidate(row, runsRootDir, identity, mirrorData?.standings ?? [], episodes, now)),
    );
    const ranked: RankedFeatureCandidate[] = [...built]
      .sort(compareCandidates)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

    if (options.json) {
      io.stdout(
        JSON.stringify(
          {
            generatedAt: now.toISOString(),
            artifactsRoot,
            totalEpisodes: episodes.length,
            candidates: ranked,
          },
          null,
          2,
        ),
      );
    } else {
      io.stdout(formatTable(ranked));
    }
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = await runFeatureCandidatesCli(process.argv.slice(2));
}
