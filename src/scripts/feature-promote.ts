import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  readFeaturedMatchStore,
  resolveFeaturedMatchStateRoot,
  type FeaturedMatch,
} from "../server/agents/FeaturedMatch";
import { upsertRecord } from "./premiere-schedule-lib";
import { rankFeatureCandidates } from "./feature-candidates";

/**
 * `feature:promote --episode=<episodeRequestId> [--artifacts-root=<dir>]
 * [--state-root=<dir>] [--json]` — the sanctioned wrapper the ARCHIVE lane
 * has never had. `feature:candidates` stays read-only by design (its own
 * module doc: "READ-ONLY: this CLI never writes the FeaturedMatch
 * store"), so promoting a ranked candidate into the store had no CLI at
 * all — Season Zero's own activation turn had to hand-roll a
 * `mutateFeaturedMatchStore` call directly to get its first Featured
 * Event in (see commit `2eaded111`'s own message: "Promoted into the
 * FeaturedMatch store via mutateFeaturedMatchStore (the sanctioned
 * lock-protected primitive — feature:candidates itself stays read-only by
 * design)"). This CLI is that sanctioned wrapper: it re-ranks (fresh
 * evidence/participants every run, matching `premiere:package`'s own
 * "regenerate structured fields fresh" precedent), picks the one
 * candidate matching `--episode=`, and upserts its `.match` draft via the
 * SAME lock-protected `upsertRecord` primitive `premiere:schedule`/
 * `publish`/`cancel` already use (`premiere-schedule-lib.ts`'s module
 * doc) — this CLI and those four safely serialize against each other and
 * the demo server, even though they never touch the SAME record (archive
 * vs premiere lane, per `FeaturedMatch.ts`'s own "never mixed" doc).
 *
 * Idempotent by `episodeRequestId`, NOT by the candidate draft's own
 * `matchId`: `feature-candidates.ts`'s `buildCandidate` calls
 * `newFeaturedMatchId()` fresh on every ranking pass (harmless there —
 * nothing persists it), so re-running THIS CLI against an
 * already-promoted episode reuses the EXISTING record's `matchId`/
 * `createdAt` rather than minting a second, orphaned duplicate that would
 * leave any `EventPackage`/Season reference pointing at the stale one.
 *
 * NOT paired with a `premiere:promote` — the premiere lane has no
 * equivalent gap to fill. A premiere-lane `FeaturedMatch` record's very
 * EXISTENCE in the store already means "committed to run at a specific
 * time" (`FeaturedMatch.ts`'s own lane doc: candidates are computed
 * on-the-fly from the live queue and never persisted until scheduled) —
 * there is no "promoted but not yet scheduled" state that lane could
 * occupy, so `premiere:schedule --episode=<id> --at=<ISO>` IS already
 * that lane's promote step (see its own module doc). A separate
 * `premiere:promote` would only re-wrap `premiere:schedule` under a new
 * name — duplicating, not filling, an existing sanctioned entry point.
 *
 * Testable-function shape (`runFeaturePromoteCli(argv, io)`) matches its
 * most direct sibling `feature-candidates.ts`'s own convention (in-process
 * unit coverage, no subprocess needed) rather than the premiere-schedule
 * family's inline-`main()`-plus-subprocess-test convention — this CLI
 * shares `rankFeatureCandidates` directly with that sibling and has
 * nothing to do with the premiere queue.
 */

interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

function parseValueArg(argv: readonly string[], prefix: string): string | undefined {
  const arg = argv.find((entry) => entry.startsWith(prefix));
  return arg === undefined ? undefined : arg.slice(prefix.length);
}

export async function runFeaturePromoteCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  const episodeRequestId = parseValueArg(argv, "--episode=");
  if (episodeRequestId === undefined) {
    io.stderr(
      "usage: feature:promote --episode=<episodeRequestId> [--artifacts-root=<dir>] [--state-root=<dir>] [--json]",
    );
    return 1;
  }
  const artifactsRootArg = parseValueArg(argv, "--artifacts-root=");
  const stateRootArg = parseValueArg(argv, "--state-root=");
  const json = argv.includes("--json");

  const ranked = await rankFeatureCandidates(
    { artifactsRoot: artifactsRootArg === undefined ? undefined : path.resolve(artifactsRootArg) },
    io,
  );
  const candidate = ranked.candidates.find(
    (entry) => entry.match.episodeRequestId === episodeRequestId,
  );
  if (candidate === undefined) {
    io.stderr(
      `could not promote "${episodeRequestId}": not found among ${ranked.candidates.length} ranked archive-lane candidate(s) — it may not be a completed, published league episode yet, or feature:candidates never saw it (check --artifacts-root)`,
    );
    return 1;
  }

  const stateRoot =
    stateRootArg === undefined ? resolveFeaturedMatchStateRoot() : path.resolve(stateRootArg);
  const store = await readFeaturedMatchStore(stateRoot);
  const existing = store.matches.find(
    (entry) => entry.lane === "archive" && entry.episodeRequestId === episodeRequestId,
  );
  const record: FeaturedMatch =
    existing === undefined
      ? candidate.match
      : { ...candidate.match, matchId: existing.matchId, createdAt: existing.createdAt };

  await upsertRecord(stateRoot, record);

  if (json) {
    io.stdout(JSON.stringify({ promoted: record, wasAlreadyPromoted: existing !== undefined }, null, 2));
  } else {
    io.stdout(
      `${existing === undefined ? "promoted" : "re-promoted"} ${record.matchId} (${episodeRequestId}) — ${record.participants.length} participant(s) resolved`,
    );
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = await runFeaturePromoteCli(process.argv.slice(2));
}
