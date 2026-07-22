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
export const PREMIERE_CLIP_MIN_ANCHOR_TURN = 50;

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

export interface PremiereClipStatusResponse {
  schemaVersion: 1;
  premiereId: PremiereId;
  bucket: number;
  clipVersion: PremiereClipVersion;
  state: PremiereClipState;
  ready: PremiereClipReady | null;
}

/** The exact JSON the clip service writes for the tsx worker subprocess. */
export interface PremiereClipJobSpec {
  premiereId: string;
  bundlePath: string;
  expectedBundleSha256: string;
  anchorTurn: number;
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
