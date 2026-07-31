import {
  loadLatestPremierePointer,
  latestPremierePointerPath,
  premiereSuppressionStorageStateDir,
  type LatestPremierePointer,
} from "./CoworldLeaguePremiereSuppression";
import {
  readFeaturedMatchStore,
  writeFeaturedMatchStore,
  type FeaturedMatch,
  type FeaturedMatchResult,
  type FeaturedMatchState,
  type FeaturedMatchStoreFile,
} from "./FeaturedMatch";
import { syncFeaturedMatchRetentionPin } from "./FeaturedMatchRetentionPin";
import { ReplayPremiereArchiveStore } from "../replay-premiere/ReplayPremiereArchiveIndex";
import { resolveReplayPremierePrivateStateRoot } from "../replay-premiere/ReplayPremiereSecrets";
import { derivePremiereId } from "../replay-premiere/ReplayPremiereLoopCore";
import type { PremiereResultSummaryV1 } from "../replay-premiere/ReplayPremiereResultSummary";

/**
 * Closes the gap the product-overhaul spec Stage 3 item 7 left open: a
 * `FeaturedMatch` record admitted through `cycle-premiere.sh`'s scheduled
 * path (`premiere-autocycle-due.ts`) sits in `state: "published"` forever
 * unless something notices its underlying premiere has actually revealed
 * (or later archived) and flips it. Chosen design: RECONCILE-ON-READ, not a
 * runtime hook — see the design note below for why.
 *
 * --- Design note: reconcile-on-read vs. a runtime hook ---
 *
 * The alternative (hooking `ReplayPremiereRevealCommit.ts`'s `commitReveal()`
 * or the terminal reclaimer's `recordReclaimed()` to also write this store)
 * was considered and rejected:
 *
 * 1. It would make the premiere runtime — which has NEVER known about
 *    `FeaturedMatch` and is deliberately independent of it (see
 *    `FeaturedMatch.ts`'s own module doc: "a featured-match record is
 *    editorial metadata, not premiere private state") — depend on a second
 *    store with its own schema/lock semantics, for a write that is
 *    genuinely non-critical to the runtime's own correctness. Every
 *    existing best-effort side write in that runtime (e.g.
 *    `recordLatestRevealedPremiere` in `replay-premiere-loop.ts`) already
 *    carries an explicit "must never fail the release itself" contract —
 *    adding a THIRD such side effect widens the reveal/reclaim critical
 *    path's blast radius for a benefit (editorial-page freshness) that
 *    doesn't need reveal-instant precision.
 * 2. It would need failure isolation duplicated at TWO call sites (reveal
 *    commit AND terminal reclamation, since outcome data — see below — is
 *    only available at the second site), doubling the surface for a subtle
 *    "logged and swallowed" bug to hide.
 * 3. Reconcile-on-read is naturally self-healing: a process restart, a
 *    crash between commit and the hook firing, or simply this code not
 *    existing yet when a premiere revealed, all self-correct on the next
 *    read — nothing to backfill, no missed-hook bookkeeping.
 *
 * --- Design note: why TWO source signals, and why the state machine has a
 * "revealed, result still pending" window ---
 *
 * `commitReveal()` marks a premiere revealed immediately, but the outcome
 * summary (winner/standings) is only durably written by
 * `ReplayPremiereTerminalReclaimer.recordReclaimed()` — named for
 * RECLAMATION, not reveal, and it only runs during the reclaimer's periodic
 * sweep (`ReplayPremiereTerminalReclamation.ts`'s own doc: reclaim-eligible
 * ~30 minutes after reveal). For that ~30-minute window, the ONLY prompt,
 * durably-readable-without-a-live-process reveal signal is the
 * "latest-premiere pointer" (`CoworldLeaguePremiereSuppression.ts`,
 * `storage/premiere-suppression/latest-premiere.json`) — which carries
 * `premiereId`/`revealedAt` but NO outcome, and (per its own writer's
 * comment, "ONLY-LATEST: this is the sole hold") is safe to trust as
 * complete for THIS system's actual operating model: the premiere loop
 * tracks exactly one in-flight hold at a time, so "the latest revealed
 * premiere" is never ambiguous with "the one THIS record cares about" the
 * way it would be if premieres could reveal concurrently.
 *
 * So this reconciler uses BOTH signals for their respective, honestly-timed
 * jobs:
 *   - `published` -> `revealed` (no `result` yet): via the latest-premiere
 *     pointer, the moment it names this record's derived premiere id.
 *   - `revealed` -> `archived`, AND `result` populated (whichever state the
 *     record is in): via the archive store, once reclamation has run.
 * A `FeaturedMatch` can therefore sit at `state: "revealed", result: null`
 * for a real but bounded window — genuinely "revealed, outcome pending",
 * never a fabricated result and never a stuck "published" that implies the
 * premiere hasn't happened yet. `ProxyWarPublicReadModel.ts`'s
 * `isFeaturedMatchRevealed`/`publicFeaturedMatchResult` already render this
 * combination correctly (revealed with a null result stays a null public
 * result) with ZERO changes needed there; `MatchDetailPage.ts`'s dispatch
 * needed one guard added (see that file) so "revealed, result pending"
 * shows an honest waiting state rather than falling into pre-match's
 * countdown UI.
 *
 * A premiere whose runtime terminal state is `failed`/`cancelled` (the
 * runtime itself gave up on it — never reached a genuine public reveal)
 * flips the `FeaturedMatch` record to `cancelled` too, for the same
 * "never stuck in a state the underlying premiere disproved" reasoning.
 *
 * Failure isolation: every external signal source (the pointer file, the
 * archive store) is opened/read independently and best-effort — a missing
 * or corrupt one is logged and skipped, never thrown, so a broken signal
 * source degrades this pass to a no-op rather than failing the READ
 * request that triggered it (mirrors the runtime's own
 * `loadLatestPremierePointer`'s "returns null on any structural failure"
 * contract). The `FeaturedMatch` store itself is the one thing this
 * function does NOT treat as best-effort: a corrupt `featured-matches.json`
 * still throws loudly, exactly as `readFeaturedMatchStore` already
 * documents — reconciliation is not a silent-repair tool for that file.
 */
export interface ReconcileFeaturedMatchStoreOptions {
  /** `resolveFeaturedMatchStateRoot()`'s own override knob — passed straight through by callers that already resolved it. */
  storageStateDir?: string;
  replayPremierePrivateStateRoot?: string;
  /** Forwarded to `syncFeaturedMatchRetentionPin` — see that module's own doc for the "extend" half of the Stage 3 item 7 retention-pin requirement this pass also performs. */
  artifactsRoot?: string;
  pinManifestPath?: string;
}

export async function reconcileFeaturedMatchStore(
  stateRoot: string,
  options: ReconcileFeaturedMatchStoreOptions = {},
): Promise<FeaturedMatchStoreFile> {
  const store = await readFeaturedMatchStore(stateRoot);
  const reconcilable = store.matches.filter(
    (match) =>
      match.lane === "premiere" &&
      match.episodeRequestId !== null &&
      (match.state === "published" || match.state === "revealed"),
  );
  // Opportunistic retention-pin "extend" pass — independent of the state
  // flip below (a pin claim doesn't need the record's state to change to
  // be worth attempting again; the mirror may simply have caught up since
  // the last attempt). Best-effort and deterministic (awaited, not
  // fire-and-forget — this function's callers, including tests, must be
  // able to trust the pin write already landed once this call resolves):
  // `syncFeaturedMatchRetentionPin` itself never throws.
  await Promise.all(
    reconcilable.map((match) =>
      syncFeaturedMatchRetentionPin(match, {
        artifactsRoot: options.artifactsRoot,
        pinManifestPath: options.pinManifestPath,
      }),
    ),
  );

  const latestPointer = await bestEffortLatestPointer(
    options.storageStateDir,
  );
  const archiveStore = await bestEffortArchiveStore(
    options.replayPremierePrivateStateRoot,
  );

  let changed = false;
  const updated = await Promise.all(
    store.matches.map(async (match) => {
      if (!reconcilable.includes(match)) return match;
      const premiereId = derivePremiereId(match.episodeRequestId as string);
      const next = await reconcileOne(
        match,
        premiereId,
        latestPointer,
        archiveStore,
      );
      if (next !== match) changed = true;
      return next;
    }),
  );

  if (!changed) return store;
  const next: FeaturedMatchStoreFile = { ...store, matches: updated };
  await writeFeaturedMatchStore(stateRoot, next);
  return next;
}

async function bestEffortLatestPointer(
  storageStateDir: string | undefined,
): Promise<LatestPremierePointer | null> {
  try {
    return await loadLatestPremierePointer(
      latestPremierePointerPath(
        storageStateDir ?? premiereSuppressionStorageStateDir(),
      ),
    );
  } catch {
    return null;
  }
}

async function bestEffortArchiveStore(
  privateStateRoot: string | undefined,
): Promise<ReplayPremiereArchiveStore | null> {
  try {
    return await ReplayPremiereArchiveStore.open({
      privateStateRoot:
        privateStateRoot ?? resolveReplayPremierePrivateStateRoot(),
      compactOnOpen: false,
    });
  } catch {
    return null;
  }
}

/** Best-effort: a missing/unreadable summary must not block the state flip itself — `result` just stays whatever it already was, corrected on a later reconcile pass once the summary is reachable. */
async function bestEffortLoadSummary(
  archiveStore: ReplayPremiereArchiveStore,
  premiereId: string,
): Promise<PremiereResultSummaryV1 | null> {
  try {
    return await archiveStore.loadSummary(premiereId);
  } catch {
    return null;
  }
}

async function reconcileOne(
  match: FeaturedMatch,
  premiereId: string,
  latestPointer: LatestPremierePointer | null,
  archiveStore: ReplayPremiereArchiveStore | null,
): Promise<FeaturedMatch> {
  const archivePointer = archiveStore?.lookup(premiereId) ?? null;
  if (archivePointer !== null) {
    if (
      archivePointer.terminalState === "failed" ||
      archivePointer.terminalState === "cancelled"
    ) {
      return match.state === "cancelled"
        ? match
        : { ...match, state: "cancelled" };
    }
    // Exhaustiveness: PremiereResultTerminalState is
    // "revealed" | "archived" | "failed" | "cancelled"; the two above are
    // handled, so only "revealed"/"archived" remain here.
    const nextState: FeaturedMatchState = archivePointer.terminalState;
    const needsResult = match.result === null;
    if (match.state === nextState && !needsResult) return match;
    const summary =
      needsResult && archiveStore !== null
        ? await bestEffortLoadSummary(archiveStore, premiereId)
        : null;
    const result =
      summary !== null ? mapSummaryToResult(summary, match) : match.result;
    return { ...match, state: nextState, result };
  }
  if (
    match.state === "published" &&
    latestPointer !== null &&
    latestPointer.premiereId === premiereId
  ) {
    return { ...match, state: "revealed" };
  }
  return match;
}

/**
 * Maps the archive's aggregate-only outcome to `FeaturedMatchResult`.
 * `winnerAgentId` is resolved by matching the winning seat's `displayName`
 * against `match.participants[].playerName` — the same "league playerName
 * is the stable join key" convention `LeagueLookupSeat` already documents
 * elsewhere. `placements` is deliberately left `[]`: the archive summary's
 * `standings` carries only a per-seat `won` boolean, never a full ordered
 * rank, and fabricating one (e.g. collapsing every non-winner into
 * "placement 2") would assert a tie the data never actually establishes.
 * A multi-seat team win (`winner.category === "team"`, `seatIds.length > 1`)
 * resolves via the FIRST seat only — an acknowledged, documented gap: every
 * source this pipeline actually produces today (controlled exhibitions,
 * rated Coworld FFA matches) is single-winner, so this never fires in
 * practice, and a wrong "first seat" pick is far less harmful than the
 * reconcile pass throwing over a format the product has never emitted.
 */
function mapSummaryToResult(
  summary: PremiereResultSummaryV1,
  match: FeaturedMatch,
): FeaturedMatchResult {
  const winner = summary.outcome?.winner ?? null;
  if (winner === null || winner.seatIds.length === 0) {
    return { winnerAgentId: null, placements: [] };
  }
  const winningStanding = summary.outcome?.standings.find(
    (standing) => standing.seatId === winner.seatIds[0],
  );
  const winnerAgentId =
    winningStanding === undefined
      ? null
      : (match.participants.find(
          (participant) =>
            participant.playerName === winningStanding.displayName,
        )?.agentId ?? null);
  return { winnerAgentId, placements: [] };
}
