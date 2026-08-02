import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFeaturedMatchStore,
  resolveFeaturedMatchStateRoot,
  type FeaturedMatch,
} from "../server/agents/FeaturedMatch";
import {
  findEventPackage,
  readEventPackageStore,
  resolveEventPackageStateRoot,
  upsertEventPackage,
  type EventPackage,
} from "../server/agents/season/EventPackage";
import {
  containsWinnerName,
  isFeaturedEventRevealed,
  isPubliclyPromotable,
} from "../server/agents/season/EventPackageGate";
import { findUnreferencedProseClaims } from "../server/agents/season/EventPackageProseClaims";
import { buildReasonToWatchClaims } from "../server/agents/season/CandidateReasonToWatch";
import { derivePremiereId } from "../server/replay-premiere/ReplayPremiereLoopCore";
import {
  loadIdentityRegistrySnapshot,
  type IdentityRegistrySnapshot,
} from "../server/identity/IdentityRegistry";
import type { CoworldLeagueMirrorData } from "../server/agents/CoworldLeagueSiteWriter";
import { resolveDefaultArtifactsRoot, resolveDefaultQueueReadyDir, resolveSealedBundleTurnStats } from "./premiere-candidates";
import { estimatePreRevealDirectorCutSeconds } from "../server/agents/DirectorCutPlan";
import { parseValueArg } from "./season-lib";

/**
 * `premiere:package --featured=<feat_id> [--title=] [--subtitle=]
 * [--editorial-notes=] [--embargo=embargoed|revealed] [--validate] [--json]`
 * — Season Zero activation prompt Phase 4 item 4 ("Event package"):
 * "interactive-free generation of the full EventPackage draft" from real
 * evidence, with operator-editable prose layered on top.
 *
 * Every run REGENERATES the structured/evidence fields (claims,
 * map/format, canonical URLs, Director Cut estimate, embargo default)
 * fresh from the current `FeaturedMatch`/mirror/identity state — these
 * are never operator-authored, so there is nothing to preserve. Operator
 * prose (`title`/`subtitle`/`editorialNotes`) is PRESERVED across runs
 * unless the matching `--flag=` is passed this time, so re-running this
 * command to refresh evidence never silently discards an operator's
 * hand-written subtitle.
 *
 * `--validate` skips regeneration entirely and just re-runs
 * `isPubliclyPromotable`/`findUnreferencedProseClaims` against whatever
 * package already exists — the read-only half of `premiere:validate`'s
 * own split, applied to the package layer instead of the schedule layer.
 */

function canonicalMatchUrl(match: FeaturedMatch): string {
  return `/match/${match.matchId}`;
}

function canonicalPremiereUrl(match: FeaturedMatch): string | null {
  if (match.lane !== "premiere" || match.episodeRequestId === null) return null;
  return `/premiere/${derivePremiereId(match.episodeRequestId)}`;
}

/** Mirrors `feature-candidates.ts`'s own tolerant-read contract: a missing/malformed live mirror is a normal "no evidence yet" state, never a crash. Exported so `season-program-week-lib.ts` reuses this SAME read rather than a third near-duplicate (see that module's own doc). */
export async function readLiveMirrorData(artifactsRoot: string): Promise<CoworldLeagueMirrorData | null> {
  const dataPath = path.join(artifactsRoot, "ai-league-runs", "league", "data.json");
  try {
    const raw = await fs.readFile(dataPath, "utf8");
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("episodes" in value) || !Array.isArray(value.episodes)) {
      return null;
    }
    return value as CoworldLeagueMirrorData;
  } catch {
    return null;
  }
}

/**
 * Post-reveal: reads the mirror's matching episode row, exactly as
 * before. Pre-reveal fallback (Runbook "Known gaps" fix): when that
 * lookup can't resolve yet — the normal state for a freshly scheduled
 * sealed premiere, since its `episodeRequestId` structurally cannot
 * appear in the mirror until AFTER reveal publishes it there (see
 * `premiere:schedule`'s own `already_published_on_league` refusal) — a
 * premiere-lane match falls back to `estimatePreRevealDirectorCutSeconds`
 * fed the sealed bundle's own admission-safe `turnCount`/`checkpointTurns`
 * (`sealedBundleTurnStats`, resolved by the caller via
 * `resolveSealedBundleTurnStats` — a plain data param here, not an I/O
 * call, so this function stays synchronous and unit-testable without
 * mocking the filesystem). `null` sealed stats (no queue item, unreadable
 * meta.json, etc.) simply mean no fallback is possible — same honest
 * "unavailable, not fabricated" contract as the mirror path.
 */
function directorCutEstimateSeconds(
  match: FeaturedMatch,
  mirror: CoworldLeagueMirrorData | null,
  sealedBundleTurnStats: { turnCount: number; checkpointTurns: readonly number[] } | null,
): number | null {
  if (match.episodeRequestId !== null && mirror !== null) {
    const episode = mirror.episodes.find((row) => row.episodeRequestId === match.episodeRequestId);
    const fromMirror = episode?.directorCut?.durationEstimateSeconds ?? null;
    if (fromMirror !== null) return fromMirror;
  }
  if (match.lane === "premiere" && sealedBundleTurnStats !== null) {
    return estimatePreRevealDirectorCutSeconds({
      totalTurns: sealedBundleTurnStats.turnCount,
      checkpointTurns: sealedBundleTurnStats.checkpointTurns,
    });
  }
  return null;
}

/**
 * SPOILER-NEUTRAL by construction (2026-08-01 P0 production review):
 * generated fresh from participants/map every run, deliberately
 * INDEPENDENT of `match.title` — defense in depth, so a future
 * `FeaturedMatch` writer's own title mistake (like `feature-candidates.ts`'s
 * pre-fix `buildTitle`, which baked the winner straight in) can never
 * propagate into the one field `ProxyWarPublicReadModel.ts` projects
 * publicly (`publicFeaturedMatch`'s `title: match.title`). NEVER reads
 * `match.result`. Falls back to `defaultSubtitle`'s own map/format shape
 * when there are no participants to name yet (the gate already requires
 * participants for promotion, but this must still degrade honestly for
 * a draft built before that's resolved).
 */
function defaultTitle(match: FeaturedMatch): string {
  const names = match.participants.map((participant) => participant.playerName);
  if (names.length === 0) {
    return `${match.map} — ${match.format}`;
  }
  const lineup = names.length <= 3 ? names.join(" vs ") : `${names.length}-way battle`;
  return `${lineup} — ${match.map}`;
}

function defaultSubtitle(match: FeaturedMatch): string {
  return `${match.map} — ${match.format}`;
}

export interface BuildEventPackageDraftOptions {
  titleOverride?: string;
  subtitleOverride?: string;
  editorialNotesOverride?: string;
  embargoOverride?: "embargoed" | "revealed";
  /** Pre-reveal Director Cut estimate fallback input — see `directorCutEstimateSeconds`'s own doc for why this is a plain data param rather than an I/O call inside this function. `undefined`/omitted (every caller before this fix) behaves identically to `null`: no pre-reveal fallback attempted. */
  sealedBundleTurnStats?: { turnCount: number; checkpointTurns: readonly number[] } | null;
}

export function buildEventPackageDraft(
  match: FeaturedMatch,
  existing: EventPackage | null,
  identity: IdentityRegistrySnapshot,
  mirror: CoworldLeagueMirrorData | null,
  now: string,
  options: BuildEventPackageDraftOptions = {},
): EventPackage {
  const claims = buildReasonToWatchClaims(
    match.participants,
    match.map,
    identity,
    mirror?.standings ?? [],
    mirror?.episodes ?? [],
    new Date(now),
  );
  const draft: EventPackage = {
    schemaVersion: 1,
    featuredMatchId: match.matchId,
    title: options.titleOverride ?? existing?.title ?? defaultTitle(match),
    subtitle: options.subtitleOverride ?? existing?.subtitle ?? defaultSubtitle(match),
    reasonToWatch: { claims },
    mapLabel: match.map,
    format: match.format,
    scheduledAt: match.scheduledAt,
    directorCutEstimateSeconds: directorCutEstimateSeconds(match, mirror, options.sealedBundleTurnStats ?? null),
    canonicalMatchUrl: canonicalMatchUrl(match),
    canonicalPremiereUrl: canonicalPremiereUrl(match),
    embargoState:
      options.embargoOverride ?? existing?.embargoState ?? (isFeaturedEventRevealed(match) ? "revealed" : "embargoed"),
    editorialNotes: options.editorialNotesOverride ?? existing?.editorialNotes ?? "",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return draft;
}

function printCompleteness(match: FeaturedMatch, pkg: EventPackage, identity: IdentityRegistrySnapshot): void {
  const gate = isPubliclyPromotable(match, pkg);
  console.log(`isPubliclyPromotable: ${gate.ok}`);
  if (!gate.ok) {
    console.log("missing:");
    for (const reason of gate.missing) console.log(`  - ${reason}`);
  }
  const prose = [pkg.title, pkg.subtitle, pkg.editorialNotes].join("\n");
  const warnings = findUnreferencedProseClaims(
    prose,
    pkg.reasonToWatch.claims,
    identity.agents.map((agent) => agent.displayName),
  );
  // 2026-08-01 P0: same non-blocking warning UX as the unreferenced-
  // claims check above, but for a DIFFERENT signal `findUnreferencedProseClaims`
  // can't catch — a winner's name can legitimately appear in OTHER
  // evidence-backed claims (e.g. a standings-rank claim) while STILL
  // spoiling the result the moment it shows up in the title/subtitle
  // specifically. See `EventPackageGate.containsWinnerName`'s own doc —
  // this warns the operator immediately on any run (not just
  // `--validate`); `isPubliclyPromotable` (checked above) is the actual
  // BLOCKING half of this same check.
  if (containsWinnerName(pkg.title, match)) {
    warnings.push(`title names the winner ("${pkg.title}") — spoils the result pre-reveal-click`);
  }
  if (containsWinnerName(pkg.subtitle, match)) {
    warnings.push(`subtitle names the winner ("${pkg.subtitle}") — spoils the result pre-reveal-click`);
  }
  if (warnings.length > 0) {
    console.log("prose warnings (not blocking):");
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const featuredMatchId = parseValueArg(argv, "--featured=");
  if (featuredMatchId === undefined) {
    console.error("usage: premiere:package --featured=<feat_id> [--title=] [--subtitle=] [--editorial-notes=] [--embargo=embargoed|revealed] [--queue-root=] [--validate] [--json]");
    process.exitCode = 1;
    return;
  }

  const featuredMatchStateRoot = resolveFeaturedMatchStateRoot();
  const featuredMatchStore = await readFeaturedMatchStore(featuredMatchStateRoot);
  const match = featuredMatchStore.matches.find((entry) => entry.matchId === featuredMatchId);
  if (match === undefined) {
    console.error(`featured match not found in store: ${featuredMatchId}`);
    process.exitCode = 1;
    return;
  }

  const eventPackageStateRoot = resolveEventPackageStateRoot();
  const eventPackageStore = await readEventPackageStore(eventPackageStateRoot);
  const existing = findEventPackage(eventPackageStore, featuredMatchId);

  const identity = await loadIdentityRegistrySnapshot().catch(
    (): IdentityRegistrySnapshot => ({ builders: [], agents: [], versions: [] }),
  );

  if (argv.includes("--validate")) {
    if (existing === null) {
      console.error(`no event package exists yet for ${featuredMatchId} — run premiere:package without --validate first`);
      process.exitCode = 1;
      return;
    }
    printCompleteness(match, existing, identity);
    if (!isPubliclyPromotable(match, existing).ok) process.exitCode = 1;
    return;
  }

  const artifactsRoot = resolveDefaultArtifactsRoot();
  const mirror = await readLiveMirrorData(artifactsRoot);

  const queueRootOverride = parseValueArg(argv, "--queue-root=");
  const queueReadyDir =
    queueRootOverride === undefined
      ? resolveDefaultQueueReadyDir()
      : path.join(path.resolve(queueRootOverride), "ready");
  const sealedBundleTurnStats =
    match.lane === "premiere" && match.queueItemName !== null
      ? await resolveSealedBundleTurnStats(queueReadyDir, match.queueItemName).then((result) =>
          result.ok ? { turnCount: result.turnCount, checkpointTurns: result.checkpointTurns } : null,
        )
      : null;

  const draft = buildEventPackageDraft(match, existing, identity, mirror, new Date().toISOString(), {
    titleOverride: parseValueArg(argv, "--title="),
    subtitleOverride: parseValueArg(argv, "--subtitle="),
    editorialNotesOverride: parseValueArg(argv, "--editorial-notes="),
    embargoOverride: parseValueArg(argv, "--embargo=") as "embargoed" | "revealed" | undefined,
    sealedBundleTurnStats,
  });
  await upsertEventPackage(eventPackageStateRoot, draft);

  if (argv.includes("--json")) {
    console.log(JSON.stringify(draft, null, 2));
  } else {
    console.log(`event package saved for ${featuredMatchId}`);
  }
  printCompleteness(match, draft, identity);
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
