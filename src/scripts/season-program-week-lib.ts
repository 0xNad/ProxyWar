import {
  readFeaturedMatchStore,
  resolveFeaturedMatchStateRoot,
  type FeaturedMatch,
} from "../server/agents/FeaturedMatch";
import {
  resolveEventPackageStateRoot,
  upsertEventPackage,
} from "../server/agents/season/EventPackage";
import { isPubliclyPromotable } from "../server/agents/season/EventPackageGate";
import {
  defaultSeasonRegistryPath,
  loadSeasonRegistry,
} from "../server/agents/season/SeasonRegistry";
import type { SeasonEventSlot } from "../server/agents/season/SeasonSchemas";
import {
  loadIdentityRegistrySnapshot,
  type IdentityRegistrySnapshot,
} from "../server/identity/IdentityRegistry";
import {
  rankFeatureCandidates,
  type RankedFeatureCandidate,
} from "./feature-candidates";
import {
  rankPremiereCandidates,
  resolveDefaultArtifactsRoot,
  resolveDefaultQueueReadyDir,
  type PremiereQueueCandidate,
} from "./premiere-candidates";
import { buildEventPackageDraft, readLiveMirrorData } from "./premiere-package";
import {
  ensurePremiereParticipants,
  resolveScheduleTarget,
  upsertRecord,
  validateSchedule,
} from "./premiere-schedule-lib";
import { runSeasonAddEvent } from "./season-lib";

/**
 * `season:program-week` — closes the operational-tax gap the Season Zero
 * activation exposed: programming one weekly Featured Event today takes
 * five to six separate manual CLI invocations (candidates -> promote ->
 * package -> validate -> add-event, per lane), and the cadence dies of
 * friction at that cost. This module is the ONE composed pipeline: rank
 * both candidate lanes, pick (or accept an operator's `--episode=`
 * override for) the top gate-eligible candidate, run that lane's real
 * promotion primitives (`premiere:schedule` + `premiere:publish` for the
 * premiere lane — `not_yet_published` in `EventPackageGate.ts` requires
 * `state: "published"`, so BOTH steps are required to ever pass the gate,
 * not just `premiere:schedule`; `feature:promote` for the archive lane),
 * generate a spoiler-neutral `EventPackage` (`buildEventPackageDraft`
 * called with `existing: null` and no prose overrides, EVERY run — see
 * that function's own "spoiler-neutral by construction" doc), validate
 * `EventPackageGate.isPubliclyPromotable`, and only then fold the event
 * into the active Season's programme at the next weekly cadence slot.
 *
 * DRY-RUN BY DEFAULT: every read (ranking, sealed-bundle participant
 * resolution, the live mirror, the identity registry, the current
 * `FeaturedMatch`/`EventPackage`/season-registry state) always happens —
 * a dry run's summary and gate result are computed from the SAME real
 * evidence an execute run would use, simulating the post-`premiere:publish`
 * end state for the premiere lane so the preview reflects what `--execute`
 * would actually produce. Only the four writes (`upsertRecord` x{1,2},
 * `upsertEventPackage`, `runSeasonAddEvent`) are gated behind `--execute`.
 *
 * NEVER folds a gate-failing event into the season programme, execute or
 * not — `missing[]` is always the same list `EventPackageGate.isPubliclyPromotable`
 * itself produces, never re-derived. In `--execute` mode the schedule/
 * promote write(s) and the package write still land even when the FINAL
 * gate check fails (mirroring the real manual workflow: an operator who
 * ran `premiere:schedule`/`publish`/`package` by hand and then found the
 * package incomplete would not expect those steps silently reverted) —
 * only `season:add-event` is withheld.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The season's own next weekly slot: one week after the latest
 * `scheduledAt` already on its programme, or (a season with no prior
 * flagship slot yet) one week from now rounded up to the top of the hour
 * so the very first slot reads cleanly. Pure and deterministic — an
 * `--at=` override always wins over this when the operator supplies one.
 */
export function computeNextWeeklyCadence(
  existingSlots: readonly SeasonEventSlot[],
  now: Date,
): string {
  const latestScheduledMs = existingSlots
    .map((slot) => slot.scheduledAt)
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value))
    .reduce((max, value) => Math.max(max, value), -Infinity);
  if (latestScheduledMs === -Infinity) {
    const oneWeekOut = now.getTime() + WEEK_MS;
    return new Date(Math.ceil(oneWeekOut / HOUR_MS) * HOUR_MS).toISOString();
  }
  return new Date(latestScheduledMs + WEEK_MS).toISOString();
}

export interface ProgramWeekOptions {
  /** Defaults to whichever season is currently `active` in the registry. */
  seasonId?: string;
  /** Operator override for candidate selection — an archive-lane `episodeRequestId`, or a premiere-lane queue item name / `episodeId` / `experienceRequestId` (same id space `premiere:schedule`'s own `resolveScheduleTarget` accepts). */
  episodeOverride?: string;
  /** Operator override for the season slot's own scheduled time; must parse as ISO-8601. Defaults to `computeNextWeeklyCadence`. */
  atOverride?: string;
  /** `false` (default) previews everything and writes nothing. `true` commits every step up to (and including) `season:add-event`, PROVIDED the gate passes. */
  execute?: boolean;
  artifactsRoot?: string;
  queueReadyDir?: string;
  featuredMatchStateRoot?: string;
  eventPackageStateRoot?: string;
  seasonRegistryPath?: string;
  now?: () => Date;
}

export interface ProgramWeekOutcome {
  ok: boolean;
  executed: boolean;
  /** Single-string reason for an early-pipeline hard stop (no active season, candidate not found, participants unresolved, schedule collision, season mutation refused). `null` once selection succeeded. */
  reason: string | null;
  /** Populated ONLY for a gate failure (`EventPackageGate.isPubliclyPromotable`) — the exact `missing[]` list, never re-derived or summarized. Empty otherwise. */
  missing: string[];
  lane: "premiere" | "archive" | null;
  matchId: string | null;
  episodeRef: string | null;
  seasonId: string | null;
  scheduledAt: string | null;
  /** Full human review summary — one line per entry, printed as-is by the CLI. */
  summary: string[];
  /** Exact copy-pasteable undo invocations, populated only once the event was (or, in a dry run, would be) added to the season programme. */
  undoCommands: string[];
}

function resolveRoots(options: ProgramWeekOptions) {
  return {
    artifactsRoot: options.artifactsRoot ?? resolveDefaultArtifactsRoot(),
    queueReadyDir: options.queueReadyDir ?? resolveDefaultQueueReadyDir(),
    featuredMatchStateRoot:
      options.featuredMatchStateRoot ?? resolveFeaturedMatchStateRoot(),
    eventPackageStateRoot:
      options.eventPackageStateRoot ?? resolveEventPackageStateRoot(),
    seasonRegistryPath:
      options.seasonRegistryPath ?? defaultSeasonRegistryPath(),
  };
}

interface Selection {
  lane: "premiere" | "archive";
  episodeRef: string;
  severelyDegraded: boolean;
  reasonToWatchLines: string[];
}

/**
 * Cross-lane pick when the operator did not pass `--episode=`: prefer a
 * clean (not severely degraded) premiere candidate, then a clean archive
 * candidate, then fall back to a degraded one from either lane rather
 * than programming nothing — premiere before archive because the
 * premiere lane is the product's flagship experience (spec: sealed,
 * embargoed, revealed on schedule); archive is the honest fallback for a
 * week the premiere queue is running dry. Both ranking CLIs already sort
 * their own `severelyDegraded` candidates last (`compareCandidates`/the
 * premiere sort in their own modules), so `[0]` is always each lane's own
 * best pick.
 */
function pickTopCandidate(
  premiere: readonly PremiereQueueCandidate[],
  archive: readonly RankedFeatureCandidate[],
): Selection | null {
  const premiereTop = premiere[0] ?? null;
  const archiveTop = archive[0] ?? null;
  // `PremiereQueueCandidate.reasonToWatchClaims` is typed as the fixed
  // empty tuple `[]` (premiere-candidates.ts never resolves participant
  // identity during ranking, so it can never populate a real claim —
  // see that module's own doc) — always `[]` in practice, so there is
  // nothing to map.
  const asPremiereSelection = (
    candidate: PremiereQueueCandidate,
  ): Selection => ({
    lane: "premiere",
    episodeRef: candidate.queueItemName,
    severelyDegraded: candidate.severelyDegraded,
    reasonToWatchLines: [],
  });
  const asArchiveSelection = (
    candidate: RankedFeatureCandidate,
  ): Selection => ({
    lane: "archive",
    episodeRef: candidate.match.episodeRequestId ?? candidate.match.matchId,
    severelyDegraded: candidate.severelyDegraded,
    reasonToWatchLines: candidate.reasonToWatchClaims.map(
      (claim) => claim.text,
    ),
  });
  if (premiereTop !== null && !premiereTop.severelyDegraded)
    return asPremiereSelection(premiereTop);
  if (archiveTop !== null && !archiveTop.severelyDegraded)
    return asArchiveSelection(archiveTop);
  if (premiereTop !== null) return asPremiereSelection(premiereTop);
  if (archiveTop !== null) return asArchiveSelection(archiveTop);
  return null;
}

function findOverride(
  episodeOverride: string,
  premiere: readonly PremiereQueueCandidate[],
  archive: readonly RankedFeatureCandidate[],
): Selection | { ambiguous: true } | null {
  const premiereMatch = premiere.find(
    (candidate) =>
      candidate.queueItemName === episodeOverride ||
      candidate.meta.episodeId === episodeOverride ||
      candidate.meta.experienceRequestId === episodeOverride ||
      candidate.featuredMatch.episodeRequestId === episodeOverride,
  );
  const archiveMatch = archive.find(
    (candidate) =>
      candidate.match.episodeRequestId === episodeOverride ||
      candidate.match.matchId === episodeOverride,
  );
  if (premiereMatch !== undefined && archiveMatch !== undefined)
    return { ambiguous: true };
  if (premiereMatch !== undefined) {
    return {
      lane: "premiere",
      episodeRef: premiereMatch.queueItemName,
      severelyDegraded: premiereMatch.severelyDegraded,
      // See `asPremiereSelection`'s own comment — always `[]` for this lane.
      reasonToWatchLines: [],
    };
  }
  if (archiveMatch !== undefined) {
    return {
      lane: "archive",
      episodeRef:
        archiveMatch.match.episodeRequestId ?? archiveMatch.match.matchId,
      severelyDegraded: archiveMatch.severelyDegraded,
      reasonToWatchLines: archiveMatch.reasonToWatchClaims.map(
        (claim) => claim.text,
      ),
    };
  }
  return null;
}

function hardFail(
  reason: string,
  executed: boolean,
  summary: string[],
): ProgramWeekOutcome {
  return {
    ok: false,
    executed,
    reason,
    missing: [],
    lane: null,
    matchId: null,
    episodeRef: null,
    seasonId: null,
    scheduledAt: null,
    summary: [...summary, `HARD STOP: ${reason}`],
    undoCommands: [],
  };
}

export async function runProgramWeek(
  options: ProgramWeekOptions = {},
): Promise<ProgramWeekOutcome> {
  const execute = options.execute ?? false;
  const now = (options.now ?? (() => new Date()))();
  const roots = resolveRoots(options);
  const summary: string[] = [
    `mode: ${execute ? "EXECUTE" : "DRY RUN (pass --execute to commit)"}`,
  ];

  const registry = await loadSeasonRegistry(roots.seasonRegistryPath);
  const season =
    options.seasonId === undefined
      ? registry.seasons.find((entry) => entry.state === "active")
      : registry.seasons.find((entry) => entry.id === options.seasonId);
  if (season === undefined) {
    return hardFail(
      options.seasonId === undefined
        ? "no_active_season"
        : `season_not_found: ${options.seasonId}`,
      execute,
      summary,
    );
  }
  if (season.state !== "active") {
    return hardFail(
      `season_not_active: ${season.id} is "${season.state}"`,
      execute,
      summary,
    );
  }
  summary.push(`season: ${season.id} — "${season.title}" [${season.state}]`);

  const identity = await loadIdentityRegistrySnapshot().catch(
    (): IdentityRegistrySnapshot => ({
      builders: [],
      agents: [],
      versions: [],
    }),
  );

  const [premiereRanked, featureRanked] = await Promise.all([
    rankPremiereCandidates({
      queueReadyDir: roots.queueReadyDir,
      artifactsRoot: roots.artifactsRoot,
    }),
    rankFeatureCandidates({ artifactsRoot: roots.artifactsRoot }),
  ]);
  summary.push(
    `candidate lanes scanned: ${premiereRanked.candidates.length} premiere (${premiereRanked.rejected.length} rejected), ${featureRanked.candidates.length} archive`,
  );

  const selection =
    options.episodeOverride === undefined
      ? pickTopCandidate(premiereRanked.candidates, featureRanked.candidates)
      : findOverride(
          options.episodeOverride,
          premiereRanked.candidates,
          featureRanked.candidates,
        );
  if (selection === null) {
    return hardFail(
      options.episodeOverride === undefined
        ? "no_gate_eligible_candidate: both lanes are empty"
        : `episode_not_found: "${options.episodeOverride}" matched neither lane's ranked candidates`,
      execute,
      summary,
    );
  }
  if ("ambiguous" in selection) {
    return hardFail(
      `episode_ambiguous: "${options.episodeOverride}" matched a candidate in BOTH lanes — pass the lane-specific id (queue item name for premiere, episodeRequestId for archive)`,
      execute,
      summary,
    );
  }
  summary.push(
    `selected: ${selection.lane} lane, ${selection.episodeRef}${selection.severelyDegraded ? " (severely degraded — no clean candidate was available)" : ""}`,
  );
  for (const line of selection.reasonToWatchLines)
    summary.push(`  reason to watch: ${line}`);

  const scheduledAt =
    options.atOverride ?? computeNextWeeklyCadence(season.eventSlots, now);
  if (Number.isNaN(Date.parse(scheduledAt))) {
    return hardFail(
      `invalid_at: "${scheduledAt}" does not parse as an ISO-8601 date`,
      execute,
      summary,
    );
  }
  summary.push(`season slot time: ${scheduledAt}`);

  let matchForPackage: FeaturedMatch;
  if (selection.lane === "premiere") {
    const scheduleRoots = {
      queueReadyDir: roots.queueReadyDir,
      artifactsRoot: roots.artifactsRoot,
      stateRoot: roots.featuredMatchStateRoot,
      now: () => now,
    };
    const target = await resolveScheduleTarget(
      selection.episodeRef,
      scheduleRoots,
    );
    if (!target.found)
      return hardFail(`cannot_schedule: ${target.reason}`, execute, summary);
    if (target.record.state === "cancelled") {
      return hardFail(
        `cannot_schedule: ${target.record.matchId} was previously cancelled`,
        execute,
        summary,
      );
    }
    const participants = await ensurePremiereParticipants(
      target.record,
      identity,
      scheduleRoots,
    );
    if (!participants.ok)
      return hardFail(
        `cannot_schedule: ${participants.reason}`,
        execute,
        summary,
      );

    const scheduled: FeaturedMatch = {
      ...target.record,
      participants: participants.participants,
      scheduledAt,
      state: "scheduled",
      updatedAt: now.toISOString(),
    };
    const currentStore = await readFeaturedMatchStore(
      roots.featuredMatchStateRoot,
    );
    const proposedMatches = [
      ...currentStore.matches.filter(
        (entry) => entry.matchId !== scheduled.matchId,
      ),
      scheduled,
    ];
    const issues = await validateSchedule(proposedMatches, scheduleRoots);
    const ownIssues = issues.filter(
      (issue) => issue.matchId === scheduled.matchId,
    );
    if (ownIssues.length > 0) {
      return hardFail(
        `schedule_invalid: ${ownIssues.map((issue) => issue.reason).join("; ")}`,
        execute,
        summary,
      );
    }
    summary.push(`premiere:schedule -> ${scheduled.matchId} at ${scheduledAt}`);

    const published: FeaturedMatch = {
      ...scheduled,
      state: "published",
      updatedAt: now.toISOString(),
    };
    summary.push(`premiere:publish -> ${published.matchId} (state: published)`);
    if (execute) {
      await upsertRecord(roots.featuredMatchStateRoot, scheduled);
      await upsertRecord(roots.featuredMatchStateRoot, published);
    }
    matchForPackage = published;
  } else {
    const candidate = featureRanked.candidates.find(
      (entry) =>
        (entry.match.episodeRequestId ?? entry.match.matchId) ===
        selection.episodeRef,
    );
    if (candidate === undefined) {
      return hardFail(
        `cannot_promote: ${selection.episodeRef} vanished from the archive ranking between selection and promotion`,
        execute,
        summary,
      );
    }
    const currentStore = await readFeaturedMatchStore(
      roots.featuredMatchStateRoot,
    );
    const existing = currentStore.matches.find(
      (entry) =>
        entry.lane === "archive" &&
        entry.episodeRequestId === candidate.match.episodeRequestId,
    );
    const record: FeaturedMatch =
      existing === undefined
        ? candidate.match
        : {
            ...candidate.match,
            matchId: existing.matchId,
            createdAt: existing.createdAt,
          };
    summary.push(
      `feature:promote -> ${record.matchId} (${existing === undefined ? "new" : "re-promoted"})`,
    );
    if (execute) {
      await upsertRecord(roots.featuredMatchStateRoot, record);
    }
    matchForPackage = record;
  }

  const mirror = await readLiveMirrorData(roots.artifactsRoot);
  // `existing: null` + no prose overrides, unconditionally — "spoiler-
  // neutral defaults" means every program-week package is generated
  // fresh from `defaultTitle`/`defaultSubtitle` (spoiler-neutral by
  // construction), never carrying forward a prior run's operator prose.
  const draft = buildEventPackageDraft(
    matchForPackage,
    null,
    identity,
    mirror,
    now.toISOString(),
  );
  summary.push(`premiere:package -> "${draft.title}" / "${draft.subtitle}"`);
  if (execute) {
    await upsertEventPackage(roots.eventPackageStateRoot, draft);
  }

  const gate = isPubliclyPromotable(matchForPackage, draft);
  if (!gate.ok) {
    summary.push("gate: isPubliclyPromotable = false");
    for (const reason of gate.missing) summary.push(`  missing: ${reason}`);
    return {
      ok: false,
      executed: execute,
      reason: "gate_failed",
      missing: gate.missing,
      lane: selection.lane,
      matchId: matchForPackage.matchId,
      episodeRef: selection.episodeRef,
      seasonId: season.id,
      scheduledAt,
      summary: [
        ...summary,
        "HARD STOP: gate_failed — season:add-event withheld",
      ],
      undoCommands: [],
    };
  }
  summary.push("gate: isPubliclyPromotable = true");

  if (execute) {
    const added = await runSeasonAddEvent(
      {
        seasonId: season.id,
        featuredMatchId: matchForPackage.matchId,
        scheduledAt,
      },
      roots.seasonRegistryPath,
      () => now,
    );
    if (!added.ok)
      return hardFail(
        `season_add_event_failed: ${added.message}`,
        execute,
        summary,
      );
    summary.push(`season:add-event -> ${added.message}`);
  } else {
    summary.push(
      `season:add-event -> would add ${matchForPackage.matchId} @ ${scheduledAt} (dry run)`,
    );
  }

  const undoCommands = [
    `npm run season:remove-event -- --season=${season.id} --featured=${matchForPackage.matchId}`,
    ...(selection.lane === "premiere"
      ? [`npm run premiere:cancel -- --episode=${matchForPackage.matchId}`]
      : []),
  ];
  summary.push("undo:");
  for (const command of undoCommands) summary.push(`  ${command}`);

  return {
    ok: true,
    executed: execute,
    reason: null,
    missing: [],
    lane: selection.lane,
    matchId: matchForPackage.matchId,
    episodeRef: selection.episodeRef,
    seasonId: season.id,
    scheduledAt,
    summary,
    undoCommands,
  };
}
