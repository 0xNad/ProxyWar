/**
 * Pure matching between builder-submitted `PendingVersionRelease` notices
 * (`PlatformVersionReleaseStore.ts`) and what the league mirror has
 * actually recorded in the tracked `AgentVersion` registry
 * (`sync-version-registry.ts`'s exclusive write path) — Season Zero
 * Phase 6's builder-improvement loop.
 *
 * No I/O here, by design: `identity-releases.ts`'s `reconcile` subcommand
 * is the ONLY caller, and it owns loading the version registry and the
 * release store and writing the result back. That split keeps this
 * matching rule exhaustively unit-testable without a filesystem, exactly
 * the same reasoning `NonceObservationReconcile.ts`'s pure
 * `findNonceObservationMatches` documents.
 *
 * Matching rule, per `pending` release still in `status: "pending"`:
 * among `observedVersions` for the SAME `agentId` with a non-null
 * `firstObservedAt` at or after the release's `createdAt` — i.e. a
 * version the mirror first saw AFTER the builder filed this release
 * notice, never one that already existed when they filed it — and whose
 * `id` is not already claimed as some OTHER release's `observedVersionId`
 * (never double-link two release notices to the same observed version),
 * pick the EARLIEST qualifying `firstObservedAt`. That is "the next
 * version this agent shipped after the builder said they were shipping
 * one", the closest a purely mirror-observed signal can get to matching a
 * builder's self-reported intent without ever trusting the builder's
 * self-reported version identity itself.
 */
import type { AgentVersion } from "./IdentitySchemas";
import type { PendingVersionRelease } from "../platform/PlatformVersionReleaseStore";

/**
 * Version-to-version stat comparisons (Phase 6's dashboard/report) must
 * never claim a new version "improved" on the strength of one match —
 * same threshold-gating discipline as `AgentStatsPipeline.ts`'s
 * `RELIABILITY_MIN_DECISIONS`: a small, round number well above the
 * single-match noise floor, scaled to MATCH count rather than that
 * constant's per-decision count because this gate protects a per-version
 * win-rate/points comparison, not a per-decision fallback ratio.
 */
export const MIN_MATCHES_FOR_VERSION_COMPARISON = 10;

export function isVersionComparisonReady(matchCount: number): boolean {
  return matchCount >= MIN_MATCHES_FOR_VERSION_COMPARISON;
}

export interface VersionReleaseReconcileResult {
  readonly updated: readonly PendingVersionRelease[];
  readonly changed: boolean;
}

export function reconcilePendingReleases(
  pending: readonly PendingVersionRelease[],
  observedVersions: readonly AgentVersion[],
): VersionReleaseReconcileResult {
  const claimedVersionIds = new Set(
    pending
      .filter((release) => release.observedVersionId !== null)
      .map((release) => release.observedVersionId),
  );
  let changed = false;
  const updated = pending.map((release) => {
    if (release.status !== "pending") return release;
    const createdAtMs = new Date(release.createdAt).getTime();
    let match: AgentVersion | null = null;
    let matchMs = Number.POSITIVE_INFINITY;
    for (const version of observedVersions) {
      if (version.agentId !== release.agentId) continue;
      if (version.firstObservedAt === null) continue;
      if (claimedVersionIds.has(version.id)) continue;
      const observedMs = new Date(version.firstObservedAt).getTime();
      if (observedMs < createdAtMs) continue;
      if (observedMs < matchMs) {
        match = version;
        matchMs = observedMs;
      }
    }
    if (match === null) return release;
    changed = true;
    claimedVersionIds.add(match.id);
    return {
      ...release,
      status: "observed" as const,
      observedVersionId: match.id,
      observedAt: match.firstObservedAt,
    };
  });
  return { updated, changed };
}
