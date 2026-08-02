import type { ReplayPremiereJsonValue } from "./ReplayPremiereIntegrity";

export const REPLAY_PREMIERE_SCHEMA_VERSION = 1 as const;
export const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
export const PREMIERE_ID_PATTERN_SOURCE = "prem_[a-z0-9]{16,32}";

export type PremiereId = string;
export type PremierePlaybackRate = 1 | 2 | 4;
export type PremiereSourceKind = "controlled_exhibition" | "rated_coworld";
export type PremierePublicLabel = "premiere" | "spoiler_resistant_premiere";

export type PremiereState =
  | "draft"
  | "scheduled"
  | "playing"
  | "checkpoint"
  | "revealed"
  | "failed"
  | "cancelled"
  | "archived";

export type PremiereTerminalReasonCode =
  | "cancelled_by_operator"
  | "integrity_failure"
  | "outage_exceeded"
  | "runtime_failure"
  | "source_ineligible";

export type PremiereLeakSurface =
  | "league_page"
  | "league_data"
  | "battle_card"
  | "public_replay_allowlist"
  | "public_artifact_allowlist"
  | "game_record_route"
  | "match_summary_route"
  | "result_route"
  | "decision_tail_route"
  | "diagnostics_route"
  | "social_metadata"
  | "direct_source_watch_route"
  | "browser_or_cdn_cache"
  | "alternate_source_url";

export const REQUIRED_PREMIERE_LEAK_SURFACES: readonly PremiereLeakSurface[] = [
  "league_page",
  "league_data",
  "battle_card",
  "public_replay_allowlist",
  "public_artifact_allowlist",
  "game_record_route",
  "match_summary_route",
  "result_route",
  "decision_tail_route",
  "diagnostics_route",
  "social_metadata",
  "direct_source_watch_route",
  "browser_or_cdn_cache",
  "alternate_source_url",
] as const;

export type PolicyIdentity =
  | {
      namespace: "softmax_policy_version";
      policyVersionId: string;
      policyName: string;
      serverAssignedVersion: string;
    }
  | {
      namespace: "local_manifest";
      manifestName: string;
      declaredVersion: string;
      manifestSha256: string;
      contentSha256: string;
    };

export interface PremiereSeatIdentity {
  seatId: string;
  displayName: string;
  policyIdentity: PolicyIdentity;
}

export type PremiereLeakExpectation =
  | {
      kind: "status";
      allowedHttpStatuses: number[];
      forbiddenText: string[];
    }
  | {
      kind: "body_absent";
      requiredHttpStatus: number;
      forbiddenText: string[];
    }
  | {
      kind: "not_cached";
      allowedHttpStatuses: number[];
      forbiddenText: string[];
    }
  | {
      kind: "structured_absent";
      requiredHttpStatus: number;
      forbiddenText: string[];
    };

export interface PremiereLeakAuditTarget {
  checkId: string;
  surface: PremiereLeakSurface;
  target: string;
  method: "GET" | "HEAD";
  expectation: PremiereLeakExpectation;
}

export interface PremiereLeakAuditManifest {
  schemaVersion: 1;
  manifestId: string;
  sourceRunId: string;
  createdAt: string;
  targets: PremiereLeakAuditTarget[];
}

export interface PremiereLeakCheckEvidence {
  checkId: string;
  target: string;
  method: "GET" | "HEAD";
  observedHttpStatus: number | null;
  observedContentHash: string | null;
  observedBodyText: string | null;
  observedHeaders: {
    age: string | null;
    cacheControl: string | null;
    cdnCacheStatus: string | null;
  };
  checkedAt: string;
  checkerVersion: string;
}

export interface PremiereExternalEmbargoEvidence {
  source: string;
  scope: string;
  observedAt: string;
  verifier: string;
  embargoConfirmed: boolean;
}

export interface CoworldPremiereSourceIds {
  episodeId: string;
  leagueId: string;
  divisionId: string;
  roundId: string;
}

export interface PremiereAuthoritativeResultReference {
  sourceKind: "controlled_result" | "coworld_result";
  sourceId: string;
  resultHash: string;
}

export interface PremiereEligibility {
  schemaVersion: 1;
  eligibilityCheckVersion: string;
  createdAt: string;
  sourceKind: PremiereSourceKind;
  sourceRunId: string;
  coworld: CoworldPremiereSourceIds | null;
  sourceReplaySha256: string;
  sourceBundleOutsideServedRoots: boolean;
  proxyWarLeakAuditManifest: PremiereLeakAuditManifest;
  proxyWarLeakChecks: PremiereLeakCheckEvidence[];
  externalEmbargoEvidence: PremiereExternalEmbargoEvidence[];
  externalOutcomeMayBePublic: boolean;
  seats: PremiereSeatIdentity[];
  authoritativeResult: PremiereAuthoritativeResultReference;
  publicLabel: PremierePublicLabel;
}

export interface HashedPremiereEligibility {
  record: PremiereEligibility;
  eligibilityRecordHash: string;
}

/**
 * Real OpenFront match cadence: one game turn every 100 ms — the value
 * `turnIntervalMs()` returns in `src/core/configuration/DefaultConfig.ts`.
 * Premiere import paces `nominalOffsetMs` from the record's GAME TURN at this
 * interval, so playback at rate 1 is exactly regular match speed. A unit test
 * pins this constant against the live server config so the two cannot drift.
 *
 * History: until 2026-07-22 the ingest default was 1 ms/turn, which produced
 * near-zero presentation deltas — the client simulation free-ran and premieres
 * played absurdly fast (a 22,600-turn episode "premiered" in ~6.5 minutes).
 */
export const PREMIERE_REAL_TURN_INTERVAL_MS = 100;

/**
 * Ceiling for a single chunk's presentation-time span (validated at admission,
 * in the publication commitment, and by the client wire schema).
 *
 * History: this was 1,000 ms while nominal offsets were ~1 ms/turn. At the
 * real 100 ms turn cadence the worst admitted show is 36,000 turns @1x = 60
 * minutes of presentation (60,000 @2x = 50 min), and the journal-budget proof
 * caps a premiere at REPLAY_PREMIERE_MAX_CHUNK_COUNT (128) chunks — so chunks
 * must be allowed to span up to a minute. Anti-spoiler release semantics are
 * unchanged: a chunk still releases only once the authoritative clock reaches
 * its LAST record, so a larger span never releases a record early — it only
 * means the viewer's map trails the release clock by up to one span.
 */
export const REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS = 60_000;

/**
 * Release pause AND interaction window at each prediction checkpoint (the two
 * are deliberately the same value: no post-checkpoint content may be released
 * while predictions are open, or a client could read ahead and vote
 * informed). Derivation: the viewer's map trails the release clock by up to
 * one chunk presentation span (45 s build spans at real-speed pacing), so the
 * pause covers that trail PLUS a genuine 15 s window measured from when a
 * steady-state viewer actually reaches the checkpoint moment: 45 + 15 = 60 s.
 *
 * History: 15 s while nominal offsets were ~1 ms/turn and the trail was
 * sub-second. Durable snapshots recorded under that era validate against
 * REPLAY_PREMIERE_LEGACY_CHECKPOINT_PAUSE_MS so archived journals stay
 * readable.
 */
export const REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS = 60_000;
export const REPLAY_PREMIERE_LEGACY_CHECKPOINT_PAUSE_MS = 15_000;

export interface PremiereSourceRecord {
  sequence: number;
  turn: number;
  nominalOffsetMs: number;
  payload: ReplayPremiereJsonValue;
}

export interface PremiereReleasedRecord {
  sequence: number;
  turn: number;
  presentationOffsetMs: number;
  payload: ReplayPremiereJsonValue;
}

export interface PremiereChunkPayload {
  schemaVersion: 1;
  records: PremiereReleasedRecord[];
}

export interface PremiereChunkDescriptor {
  premiereId: PremiereId;
  index: number;
  startSequence: number;
  endSequence: number;
  startTurn: number;
  endTurn: number;
  presentationOffsetMs: number;
  previousChunkHash: string | null;
  payloadHash: string;
  chunkHash: string;
  byteLength: number;
  terminal: boolean;
  releasedAt: string | null;
}

export interface PremiereChunkDraft {
  descriptor: Omit<
    PremiereChunkDescriptor,
    "previousChunkHash" | "chunkHash" | "releasedAt"
  > & {
    previousPrepublicationHash: string | null;
    prepublicationHash: string;
    releasedAt: null;
  };
  payload: PremiereChunkPayload;
}

export interface ReleasedPremiereChunk {
  descriptor: PremiereChunkDescriptor & { releasedAt: string };
  payload: PremiereChunkPayload;
}

export interface StagedPremiereSource {
  schemaVersion: 1;
  sourceReplaySha256: string;
  byteLength: number;
  privatePath: string;
  reused: boolean;
}

export function isPremiereId(value: unknown): value is PremiereId {
  return typeof value === "string" && PREMIERE_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Premiere social clips (rendered mp4 cache; never event-store evidence)
// ---------------------------------------------------------------------------

/**
 * The clip render format version. It is baked into the on-disk filename
 * (`clip-v1-<bucket>.mp4`) and the public file route, so a render-format change
 * (new overlay, new dimensions) bumps this and invalidates old caches by key.
 */
export const PREMIERE_CLIP_VERSION = 1 as const;
export type PremiereClipVersion = typeof PREMIERE_CLIP_VERSION;

/**
 * Anchor bucket granularity. Every anchor turn is floored into a 10-turn
 * bucket; all anchors in one bucket share a single cached clip, since the clip
 * body spans a ~200-turn window and a ±5-turn anchor shift is imperceptible.
 * This bounds the render fan-out and makes the cache key coarse and stable.
 */
export const PREMIERE_CLIP_ANCHOR_BUCKET_TURNS = 10;

/**
 * The clip worker parks the camera at `anchor - 50` and captures to
 * `anchor + 150`, and fails closed for `anchor <= 50`. A bucket's representative
 * anchor is its center (`bucket*10 + 5`), so bucket 5 (turns 50-59, center 55)
 * is the earliest renderable bucket. Requests for earlier turns are rejected.
 */
/**
 * Clip capture window, in game turns.
 *
 * Window size and capture rate together decide how much of a match a clip
 * shows. These began at 50/150 (200 turns) at the normal 10 turns/sec — 20s of
 * video covering 200 turns of a match that can run 50,000, which reads as a
 * near-still image. 100/300 at the "fast" rate doubled that and measured 401
 * ticks over a 21s capture (~19 turns/sec, i.e. still delay-bound).
 *
 * Now paired with `renderReplaySpeed=fastest`, which removes the inter-turn
 * delay so the rate is bound by the dispatch loop rather than a timer, and with
 * an encoder that pins the body to CLIP_TARGET_BODY_SECONDS. Window size is
 * therefore the only knob that decides coverage, and overshooting is the safe
 * direction: a long capture is compressed to the target, while a short one can
 * only produce a shorter clip.
 *
 * Sized from measurement, not estimate. At `fastest` the dispatch loop's 5ms
 * period caps the rate at 200 turns/sec, and a real render measured 200.2
 * turns/sec — i.e. the ceiling, so the rate is stable rather than load-dependent.
 * 4000 turns therefore captures in ~20s, which is the body target.
 */
export const PREMIERE_CLIP_CAPTURE_LEAD_TURNS = 1000;
export const PREMIERE_CLIP_CAPTURE_TAIL_TURNS = 3000;

/**
 * Earliest anchor that can be clipped.
 *
 * Deliberately NOT the capture lead. resolveClipCaptureWindow already clamps the
 * park tick at 1 and back-shifts the window, so an early anchor simply gets less
 * lead-in — it does not need a full lead's worth of match to exist. Tying this to
 * the lead would silently make every early-game moment unclippable each time the
 * window grows (at a 1000-turn lead that would be the whole first 1.6% of a
 * 50k-turn match).
 */
export const PREMIERE_CLIP_MIN_ANCHOR_TURN = 100;

/** Upper bound on the bucket index encoded in routes/filenames (9 digits). */
export const PREMIERE_CLIP_MAX_BUCKET = 999_999_999;

export type PremiereClipState = "ready" | "pending" | "absent";

export interface PremiereClipSocialText {
  /**
   * The post body. Carries BOTH exact license lines and NO url (the CC BY-SA
   * attribution + no-endorsement must ride on the post itself; links live in
   * the first reply for reach).
   */
  caption: string;
  /** The first reply: the watch url and nothing license-bearing. */
  firstReply: string;
}

export interface PremiereClipReady {
  clipUrl: string;
  byteLength: number;
  sha256: string;
  anchorTurn: number;
  social: PremiereClipSocialText;
}

export type PremiereClipPendingPhase = "queued" | "rendering";

/**
 * Truthful progress for an admitted render. `jobsAhead` is the exact number
 * of running/queued jobs ahead of this source-bound cache key at response
 * time; it is not an estimated completion percentage.
 */
export interface PremiereClipPending {
  phase: PremiereClipPendingPhase;
  jobsAhead: number;
}

export interface PremiereClipStatusResponse {
  schemaVersion: 1;
  premiereId: PremiereId;
  bucket: number;
  clipVersion: PremiereClipVersion;
  state: PremiereClipState;
  ready: PremiereClipReady | null;
  /**
   * Opt-in progress extension. Omitted from legacy schema-v1 responses so an
   * older strict client does not reject an otherwise compatible status body.
   * When requested, it is non-null only while `state === "pending"`.
   */
  pending?: PremiereClipPending | null;
}

/**
 * Current replay-scoped clip eligibility. `renderableThroughTurn` is the
 * highest turn whose source bytes are both retained and public to this
 * viewer. It is deliberately NOT a lifecycle flag: an in-progress Premiere
 * can expose a bounded prefix, while any retained completed replay exposes
 * its complete supported range.
 */
export interface ReplayClipEligibility {
  generationEnabled: boolean;
  renderableThroughTurn: number | null;
  sourceComplete: boolean;
}

/** The exact JSON the clip service writes for the tsx worker subprocess. */
export interface PremiereClipJobSpec {
  premiereId: string;
  bundlePath: string;
  expectedBundleSha256: string;
  anchorTurn: number;
  /** Highest source/released turn this job is permitted to render. */
  renderableThroughTurn: number;
  /** True only when the retained source is a complete terminal replay. */
  sourceComplete: boolean;
  clipVersion: number;
  outDir: string;
  staticDir: string;
  captureMode?: "screencast" | "tick-step";
  frameShape?: "square" | "landscape";
  cameraFit?: "fill" | "whole-map";
}

/**
 * The subset of the worker's `render-manifest.json` the clip service depends on
 * when rebuilding its cache index from disk. Extra fields are tolerated.
 */
export interface PremiereClipRenderManifest {
  premiereId: string;
  sourceReplaySha256: string;
  anchorTurn: number;
  clipVersion: number;
  frameShape: string;
  frameWidth: number;
  frameHeight: number;
  outSha256: string;
  outBytes: number;
  generatedAt: string;
}

export function premiereClipBucketForTurn(turn: number): number {
  if (!Number.isSafeInteger(turn) || turn < 0) {
    throw new Error(`invalid clip anchor turn: ${turn}`);
  }
  return Math.floor(turn / PREMIERE_CLIP_ANCHOR_BUCKET_TURNS);
}

export function premiereClipRepresentativeAnchorTurn(bucket: number): number {
  if (!isPremiereClipBucket(bucket)) {
    throw new Error(`invalid clip bucket: ${bucket}`);
  }
  return (
    bucket * PREMIERE_CLIP_ANCHOR_BUCKET_TURNS +
    Math.floor(PREMIERE_CLIP_ANCHOR_BUCKET_TURNS / 2)
  );
}

export function isPremiereClipBucket(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= PREMIERE_CLIP_MAX_BUCKET
  );
}

/** True when the bucket's representative anchor is late enough to render. */
export function isRenderablePremiereClipBucket(bucket: number): boolean {
  return (
    isPremiereClipBucket(bucket) &&
    premiereClipRepresentativeAnchorTurn(bucket) > PREMIERE_CLIP_MIN_ANCHOR_TURN
  );
}
