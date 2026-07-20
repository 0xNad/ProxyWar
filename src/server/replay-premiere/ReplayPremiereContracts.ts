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
