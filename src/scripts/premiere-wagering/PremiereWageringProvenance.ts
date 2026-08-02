/**
 * Provenance safety classification for a local premiere-wagering bundle.
 *
 * THE FINDING THIS FILE ENFORCES (see the sealing CLI's `--help` and
 * `docs/project-state/softmax-platform-feedback.md:298-310` for the sourcing):
 *
 * A bundle synced through `coworld-league-mirror.ts` from a PUBLIC Coworld
 * league round is NOT sealable, no matter what suppression contract or hold
 * we layer on top of our own systems, for two independent reasons:
 *
 *  1. Observatory itself already lists the league among its public leagues
 *     and serves `results`/`rounds`/`replays` (including "public S3 replay
 *     downloads" — `coworld-league-mirror.ts:61`) for anyone who queries it
 *     directly. The round's winner is public the instant the round
 *     completes, independent of anything this repo does.
 *  2. Even on our own demo server, `isProxyWarPublicLeaguePath` (used to gate
 *     `/ai-league-runs/league-*` and `/ai-league-replay/league-*`) is a PURE
 *     PATH-PATTERN match — it does not consult `data.json`, the premiere
 *     suppression contract, or any hold state. Any bundle already unpacked to
 *     `artifacts/ai-league-runs/league-coworld-*` is served by
 *     `express.static` on that literal path the moment it exists on disk,
 *     regardless of whether the suppression contract currently holds it.
 *
 * The genuinely private source is an xp-request (`coworld xp-request
 * create`) episode: `docs/project-state/softmax-platform-feedback.md` item 26
 * reproduces cross-account that a non-requester gets 404 (not 403) reading an
 * xp-request episode or its id directly — invisible even to a PARTICIPATING
 * account, let alone the public. Only the requester (our own operator
 * account) can see it before we choose to reveal it.
 *
 * `MANAGED_RUN_KEY_PATTERN` (`league-coworld-*`) is the exact, canonical
 * marker of "this bundle was unpacked by the public-league mirror" — reused
 * from `ReplayPremiereLoopCore.ts` via `isManagedPublicRunKey` rather than
 * re-derived, so this check never drifts from what the mirror/demo-server
 * static route actually treat as public.
 */
import { isManagedPublicRunKey } from "../../server/replay-premiere/ReplayPremiereLoopCore";

export type PremiereWageringSource =
  | "xp_request"
  | "public_league_mirror"
  | "unknown";

export interface PremiereWageringProvenanceVerdict {
  readonly source: PremiereWageringSource;
  readonly sealable: boolean;
  readonly reason: string;
}

/**
 * Classifies a bundle's provenance from its directory name plus an optional
 * operator assertion, and decides whether it may be marked sealed.
 *
 * `declaredSource` lets the xp-request generation pipeline stamp its own
 * output as `"xp_request"` (it knows how the bundle was produced — no
 * directory-name guessing needed). Without a declaration, a bundle whose
 * directory name matches the mirror's managed public pattern is classified
 * `"public_league_mirror"` and refused; anything else defaults to
 * `"unknown"` and is ALSO refused — "I can't prove this is private" must
 * never silently pass as sealed.
 */
export function classifyPremiereWageringProvenance(input: {
  readonly bundleDirName: string;
  readonly declaredSource?: PremiereWageringSource;
}): PremiereWageringProvenanceVerdict {
  if (isManagedPublicRunKey(input.bundleDirName)) {
    return {
      source: "public_league_mirror",
      sealable: false,
      reason:
        "bundle directory name matches the public-league mirror's managed run key pattern (league-coworld-*); " +
        "Observatory already publishes this round's outcome independently of anything this repo does, and the " +
        "mirror's own static-file route serves it by path regardless of any suppression hold — see this file's header comment",
    };
  }
  if (input.declaredSource === "xp_request") {
    return {
      source: "xp_request",
      sealable: true,
      reason:
        "declared xp-request source: per softmax-platform-feedback.md item 26, a non-requester gets 404 " +
        "(not 403) reading an xp-request episode directly, so only the requesting account can see it before reveal",
    };
  }
  if (input.declaredSource === "public_league_mirror") {
    return {
      source: "public_league_mirror",
      sealable: false,
      reason: "operator declared this bundle as public-league-mirror sourced",
    };
  }
  return {
    source: "unknown",
    sealable: false,
    reason:
      "bundle directory name does not match the mirror's managed public pattern, but no --source was declared; " +
      "refusing to seal an episode whose privacy cannot be established rather than guessing",
  };
}
