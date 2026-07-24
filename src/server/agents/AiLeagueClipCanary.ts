import type { RequestHandler } from "express";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { GameRecordSchema } from "../../core/Schemas";
import { ReplayPremiereArchiveStore } from "../replay-premiere/ReplayPremiereArchiveIndex";
import {
  archivedPremiereClipFileName,
  archivedPremiereClipManifestFileName,
  archivedPremiereClipsDir,
  clipFileName,
} from "../replay-premiere/ReplayPremiereClips";
import {
  isPremiereId,
  isRenderablePremiereClipBucket,
  premiereClipRepresentativeAnchorTurn,
} from "../replay-premiere/ReplayPremiereContracts";
import {
  isSafeProxyWarArtifactSegment,
  matchProxyWarLeagueClipWritePath,
} from "./ProxyWarPublicArtifacts";

// Every production one-shot has an immutable versioned state lane. The failed
// v1 and disarmed v2 predecessors are retained byte-for-byte; v3 never resets,
// deletes, renames, or rewrites them.
export const AI_LEAGUE_CLIP_CANARY_FILE = "clip-canary-v3.json";
export const AI_LEAGUE_CLIP_CANARY_PREDECESSOR_FILE = "clip-canary-v2.json";
export const AI_LEAGUE_CLIP_CANARY_ROOT_PREDECESSOR_FILE =
  "clip-canary-v1.json";
// Reuse the v1 lock name so every checked-out CLI generation serializes its
// state-lane mutations in the same private root.
export const AI_LEAGUE_CLIP_CANARY_LOCK_FILE = "clip-canary-v1.lock";
export const AI_LEAGUE_CLIP_CANARY_MAX_BYTES = 4_096;
export const AI_LEAGUE_CLIP_CANARY_MAX_LIFETIME_MS = 30 * 60 * 1_000;
export const AI_LEAGUE_CLIP_CANARY_LOCK_MAX_BYTES = 128;

const MUTATION_LOCK_KEYS = ["pid", "schemaVersion"] as const;

export type AiLeagueClipCanaryProcessStatus = "absent" | "alive" | "unknown";

/**
 * Production uses a kill(2) existence probe. Hooks are exposed only so lock
 * replacement and retry races can be exercised deterministically in tests.
 */
export interface AiLeagueClipCanaryMutationLockHost {
  processStatus: (
    pid: number,
  ) =>
    | AiLeagueClipCanaryProcessStatus
    | Promise<AiLeagueClipCanaryProcessStatus>;
  beforeStaleLockUnlink?: (lockPath: string) => void | Promise<void>;
  afterStaleLockRemoval?: (lockPath: string) => void | Promise<void>;
  beforeMutationLockRelease?: (lockPath: string) => void | Promise<void>;
}

interface AiLeagueClipCanaryMutationLockRecord {
  schemaVersion: 1;
  pid: number;
}

const ROOT_PREDECESSOR_RECORD_KEYS = [
  "armedAt",
  "bucket",
  "claimedAt",
  "disarmedAt",
  "expiresAt",
  "lifecycle",
  "runKey",
  "schemaVersion",
  "sourceReplaySha256",
] as const;
const PREDECESSOR_RECORD_KEYS = [
  ...ROOT_PREDECESSOR_RECORD_KEYS,
  "premiereId",
  "priorStateSha256",
].sort();
const RECORD_KEYS = [
  ...PREDECESSOR_RECORD_KEYS,
  "rootPredecessorStateSha256",
].sort();

export type AiLeagueClipCanaryLifecycle = "armed" | "claimed" | "disarmed";

export interface AiLeagueClipCanaryTarget {
  runKey: string;
  premiereId: string;
  bucket: number;
  sourceReplaySha256: string;
}

/**
 * Strict v3 state. Nullable transition timestamps keep one exact-key schema
 * across the durable armed -> claimed -> disarmed lifecycle.
 */
export interface AiLeagueClipCanaryRecord extends AiLeagueClipCanaryTarget {
  schemaVersion: 3;
  priorStateSha256: string;
  rootPredecessorStateSha256: string;
  lifecycle: AiLeagueClipCanaryLifecycle;
  armedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  disarmedAt: string | null;
}

export type AiLeagueClipCanaryDiagnosticCode =
  | "clip_canary_armed"
  | "clip_canary_state_missing"
  | "clip_canary_state_stat_failed"
  | "clip_canary_state_symlink"
  | "clip_canary_state_not_regular"
  | "clip_canary_state_hardlinked"
  | "clip_canary_state_wrong_owner"
  | "clip_canary_state_wrong_mode"
  | "clip_canary_state_too_large"
  | "clip_canary_state_read_failed"
  | "clip_canary_state_changed_during_read"
  | "clip_canary_private_state_root_invalid"
  | "clip_canary_private_state_root_wrong_owner"
  | "clip_canary_private_state_root_wrong_mode"
  | "clip_canary_state_malformed"
  | "clip_canary_state_expired"
  | "clip_canary_state_claimed"
  | "clip_canary_state_disarmed";

const DIAGNOSTIC_MESSAGES: Record<AiLeagueClipCanaryDiagnosticCode, string> = {
  clip_canary_armed:
    "Clip canary is armed for one exact retained replay target.",
  clip_canary_state_missing: "Clip canary state is absent; canary is disabled.",
  clip_canary_state_stat_failed:
    "Clip canary state metadata could not be verified; canary is disabled.",
  clip_canary_state_symlink:
    "Clip canary state is a symbolic link; canary is disabled.",
  clip_canary_state_not_regular:
    "Clip canary state is not a regular file; canary is disabled.",
  clip_canary_state_hardlinked:
    "Clip canary state has multiple hard links; canary is disabled.",
  clip_canary_state_wrong_owner:
    "Clip canary state is not owned by the current uid; canary is disabled.",
  clip_canary_state_wrong_mode:
    "Clip canary state mode is not 0600; canary is disabled.",
  clip_canary_state_too_large:
    "Clip canary state exceeds its byte limit; canary is disabled.",
  clip_canary_state_read_failed:
    "Clip canary state could not be read safely; canary is disabled.",
  clip_canary_state_changed_during_read:
    "Clip canary state changed during verification; canary is disabled.",
  clip_canary_private_state_root_invalid:
    "Clip canary private state root is not a stable regular directory; canary is disabled.",
  clip_canary_private_state_root_wrong_owner:
    "Clip canary private state root is not owned by the current uid; canary is disabled.",
  clip_canary_private_state_root_wrong_mode:
    "Clip canary private state root mode is not 0700; canary is disabled.",
  clip_canary_state_malformed:
    "Clip canary state does not match strict schema v3; canary is disabled.",
  clip_canary_state_expired:
    "Clip canary arm expired before claim; canary is disabled.",
  clip_canary_state_claimed:
    "Clip canary was already claimed; restart enqueue is disabled.",
  clip_canary_state_disarmed:
    "Clip canary is durably disarmed; canary is disabled.",
};

export interface AiLeagueClipCanaryReadResult {
  /** Armed and unexpired: startup may consume the one-shot authorization. */
  claimable: boolean;
  /** Claimed and unexpired: exact-target status and MP4 reads may be exposed. */
  readEnabled: boolean;
  /** Backward-compatible alias for claimable. */
  enabled: boolean;
  diagnostic: {
    code: AiLeagueClipCanaryDiagnosticCode;
    message: string;
  };
  record: AiLeagueClipCanaryRecord | null;
}

export interface AiLeagueClipCanaryReadOptions {
  privateStateRoot: string;
  now?: () => number;
  /** Explicit only for deterministic metadata tests; production omits it. */
  expectedUid?: number | null;
  /** File-owner override for metadata tests; production omits it. */
  expectedFileUid?: number | null;
}

export async function readAiLeagueClipCanary(
  options: AiLeagueClipCanaryReadOptions,
): Promise<AiLeagueClipCanaryReadResult> {
  const statePath = clipCanaryStatePath(options.privateStateRoot);
  const expectedUid =
    options.expectedUid === undefined ? currentUid() : options.expectedUid;
  const expectedFileUid =
    options.expectedFileUid === undefined
      ? expectedUid
      : options.expectedFileUid;
  const rootBefore = await validatePrivateStateRoot(
    options.privateStateRoot,
    expectedUid,
  );
  if (typeof rootBefore === "string") return diagnosticResult(rootBefore);
  let before: Stats;
  try {
    before = await fs.lstat(statePath);
  } catch (error) {
    return diagnosticResult(
      isNodeError(error, "ENOENT")
        ? "clip_canary_state_missing"
        : "clip_canary_state_stat_failed",
    );
  }
  const metadataFailure = validateStateMetadata(before, expectedFileUid);
  if (metadataFailure !== null) return diagnosticResult(metadataFailure);

  let handle;
  try {
    handle = await fs.open(
      statePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return diagnosticResult("clip_canary_state_read_failed");
  }
  let bytes: Buffer;
  let opened: Stats;
  try {
    opened = await handle.stat();
    const openedFailure = validateStateMetadata(opened, expectedFileUid);
    if (openedFailure !== null) return diagnosticResult(openedFailure);
    if (!sameIdentity(before, opened)) {
      return diagnosticResult("clip_canary_state_changed_during_read");
    }
    bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (!sameIdentity(opened, openedAfter)) {
      return diagnosticResult("clip_canary_state_changed_during_read");
    }
  } catch {
    return diagnosticResult("clip_canary_state_read_failed");
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.byteLength > AI_LEAGUE_CLIP_CANARY_MAX_BYTES) {
    return diagnosticResult("clip_canary_state_too_large");
  }
  let after: Stats;
  try {
    after = await fs.lstat(statePath);
  } catch {
    return diagnosticResult("clip_canary_state_changed_during_read");
  }
  if (!sameIdentity(before, after) || after.size !== bytes.byteLength) {
    return diagnosticResult("clip_canary_state_changed_during_read");
  }
  const rootAfter = await validatePrivateStateRoot(
    options.privateStateRoot,
    expectedUid,
  );
  if (typeof rootAfter === "string" || !sameIdentity(rootBefore, rootAfter)) {
    return diagnosticResult("clip_canary_private_state_root_invalid");
  }

  const record = parseAiLeagueClipCanaryRecord(bytes.toString("utf8"));
  if (record === null) return diagnosticResult("clip_canary_state_malformed");
  if (record.lifecycle === "disarmed") {
    return diagnosticResult("clip_canary_state_disarmed", record);
  }
  const now = (options.now ?? Date.now)();
  if (Date.parse(record.expiresAt) <= now) {
    return diagnosticResult("clip_canary_state_expired", record);
  }
  if (record.lifecycle === "claimed") {
    return diagnosticResult("clip_canary_state_claimed", record, false, true);
  }
  return diagnosticResult("clip_canary_armed", record, true, false);
}

export function parseAiLeagueClipCanaryRecord(
  text: string,
): AiLeagueClipCanaryRecord | null {
  if (Buffer.byteLength(text, "utf8") > AI_LEAGUE_CLIP_CANARY_MAX_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== RECORD_KEYS.length ||
    keys.some((key, index) => key !== RECORD_KEYS[index])
  ) {
    return null;
  }
  if (
    parsed.schemaVersion !== 3 ||
    (parsed.lifecycle !== "armed" &&
      parsed.lifecycle !== "claimed" &&
      parsed.lifecycle !== "disarmed") ||
    typeof parsed.runKey !== "string" ||
    !isSafeProxyWarArtifactSegment(parsed.runKey) ||
    !parsed.runKey.startsWith("league-") ||
    !isPremiereId(parsed.premiereId) ||
    typeof parsed.bucket !== "number" ||
    !isRenderablePremiereClipBucket(parsed.bucket) ||
    parsed.bucket > 99_999 ||
    typeof parsed.sourceReplaySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.sourceReplaySha256) ||
    typeof parsed.priorStateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.priorStateSha256) ||
    typeof parsed.rootPredecessorStateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.rootPredecessorStateSha256) ||
    typeof parsed.armedAt !== "string" ||
    !isCanonicalTimestamp(parsed.armedAt) ||
    typeof parsed.expiresAt !== "string" ||
    !isCanonicalTimestamp(parsed.expiresAt) ||
    !nullableCanonicalTimestamp(parsed.claimedAt) ||
    !nullableCanonicalTimestamp(parsed.disarmedAt)
  ) {
    return null;
  }
  const armedMs = Date.parse(parsed.armedAt);
  const expiresMs = Date.parse(parsed.expiresAt);
  const claimedMs =
    parsed.claimedAt === null ? null : Date.parse(parsed.claimedAt);
  const disarmedMs =
    parsed.disarmedAt === null ? null : Date.parse(parsed.disarmedAt);
  if (
    expiresMs <= armedMs ||
    expiresMs - armedMs > AI_LEAGUE_CLIP_CANARY_MAX_LIFETIME_MS
  ) {
    return null;
  }
  if (
    (parsed.lifecycle === "armed" &&
      (claimedMs !== null || disarmedMs !== null)) ||
    (parsed.lifecycle === "claimed" &&
      (claimedMs === null ||
        claimedMs < armedMs ||
        claimedMs >= expiresMs ||
        disarmedMs !== null)) ||
    (parsed.lifecycle === "disarmed" &&
      (disarmedMs === null ||
        disarmedMs < armedMs ||
        (claimedMs !== null &&
          (claimedMs < armedMs ||
            claimedMs >= expiresMs ||
            claimedMs > disarmedMs))))
  ) {
    return null;
  }
  return parsed as unknown as AiLeagueClipCanaryRecord;
}

async function readVerifiedPredecessor(options: {
  privateStateRoot: string;
  fileName: string;
  expectedSha256: string;
  expectedUid?: number | null;
  diagnosticPrefix: "clip_canary_predecessor" | "clip_canary_root_predecessor";
}): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedSha256)) {
    throw new Error(`${options.diagnosticPrefix}_sha256_invalid`);
  }
  const expectedUid =
    options.expectedUid === undefined ? currentUid() : options.expectedUid;
  const rootBefore = await validatePrivateStateRoot(
    options.privateStateRoot,
    expectedUid,
  );
  if (typeof rootBefore === "string") {
    throw new Error(`${options.diagnosticPrefix}_refused:${rootBefore}`);
  }
  const predecessorPath = path.join(
    path.resolve(options.privateStateRoot),
    options.fileName,
  );
  let before: Stats;
  try {
    before = await fs.lstat(predecessorPath);
  } catch (error) {
    throw new Error(
      `${options.diagnosticPrefix}_refused:${
        isNodeError(error, "ENOENT")
          ? "clip_canary_state_missing"
          : "clip_canary_state_stat_failed"
      }`,
      { cause: error },
    );
  }
  const metadataFailure = validateStateMetadata(before, expectedUid);
  if (metadataFailure !== null) {
    throw new Error(`${options.diagnosticPrefix}_refused:${metadataFailure}`);
  }

  let handle;
  try {
    handle = await fs.open(
      predecessorPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error(
      `${options.diagnosticPrefix}_refused:clip_canary_state_read_failed`,
    );
  }
  let bytes: Buffer;
  let opened: Stats;
  try {
    opened = await handle.stat();
    const openedFailure = validateStateMetadata(opened, expectedUid);
    if (openedFailure !== null || !sameIdentity(before, opened)) {
      throw new Error(
        `${options.diagnosticPrefix}_refused:${
          openedFailure ?? "clip_canary_state_changed_during_read"
        }`,
      );
    }
    bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (!sameIdentity(opened, openedAfter)) {
      throw new Error(
        `${options.diagnosticPrefix}_refused:clip_canary_state_changed_during_read`,
      );
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.byteLength > AI_LEAGUE_CLIP_CANARY_MAX_BYTES) {
    throw new Error(
      `${options.diagnosticPrefix}_refused:clip_canary_state_too_large`,
    );
  }
  let after: Stats;
  try {
    after = await fs.lstat(predecessorPath);
  } catch {
    throw new Error(
      `${options.diagnosticPrefix}_refused:clip_canary_state_changed_during_read`,
    );
  }
  const rootAfter = await validatePrivateStateRoot(
    options.privateStateRoot,
    expectedUid,
  );
  if (
    !sameIdentity(before, after) ||
    after.size !== bytes.byteLength ||
    typeof rootAfter === "string" ||
    !sameIdentity(rootBefore, rootAfter)
  ) {
    throw new Error(
      `${options.diagnosticPrefix}_refused:clip_canary_state_changed_during_read`,
    );
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== options.expectedSha256) {
    throw new Error(`${options.diagnosticPrefix}_sha256_mismatch`);
  }
  return bytes;
}

async function verifyDisarmedPredecessors(options: {
  privateStateRoot: string;
  priorStateSha256: string;
  rootPredecessorStateSha256: string;
  expectedUid?: number | null;
}): Promise<void> {
  const rootPredecessorBytes = await readVerifiedPredecessor({
    privateStateRoot: options.privateStateRoot,
    fileName: AI_LEAGUE_CLIP_CANARY_ROOT_PREDECESSOR_FILE,
    expectedSha256: options.rootPredecessorStateSha256,
    expectedUid: options.expectedUid,
    diagnosticPrefix: "clip_canary_root_predecessor",
  });
  if (!isDisarmedRootPredecessorRecord(rootPredecessorBytes.toString("utf8"))) {
    throw new Error("clip_canary_root_predecessor_not_valid_disarmed_v1");
  }

  const predecessorBytes = await readVerifiedPredecessor({
    privateStateRoot: options.privateStateRoot,
    fileName: AI_LEAGUE_CLIP_CANARY_PREDECESSOR_FILE,
    expectedSha256: options.priorStateSha256,
    expectedUid: options.expectedUid,
    diagnosticPrefix: "clip_canary_predecessor",
  });
  if (
    !isDisarmedPredecessorRecord(
      predecessorBytes.toString("utf8"),
      options.rootPredecessorStateSha256,
    )
  ) {
    throw new Error("clip_canary_predecessor_not_valid_disarmed_v2");
  }
}

function isDisarmedRootPredecessorRecord(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== ROOT_PREDECESSOR_RECORD_KEYS.length ||
    keys.some((key, index) => key !== ROOT_PREDECESSOR_RECORD_KEYS[index]) ||
    parsed.schemaVersion !== 1 ||
    parsed.lifecycle !== "disarmed"
  ) {
    return false;
  }
  const candidate = {
    ...parsed,
    schemaVersion: 3,
    premiereId: "prem_0000000000000000",
    priorStateSha256: "0".repeat(64),
    rootPredecessorStateSha256: "0".repeat(64),
  };
  return parseAiLeagueClipCanaryRecord(JSON.stringify(candidate)) !== null;
}

function isDisarmedPredecessorRecord(
  text: string,
  rootPredecessorStateSha256: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== PREDECESSOR_RECORD_KEYS.length ||
    keys.some((key, index) => key !== PREDECESSOR_RECORD_KEYS[index]) ||
    parsed.schemaVersion !== 2 ||
    parsed.lifecycle !== "disarmed" ||
    parsed.claimedAt !== null ||
    parsed.priorStateSha256 !== rootPredecessorStateSha256
  ) {
    return false;
  }
  const candidate = {
    ...parsed,
    schemaVersion: 3,
    rootPredecessorStateSha256,
  };
  return parseAiLeagueClipCanaryRecord(JSON.stringify(candidate)) !== null;
}

export async function armAiLeagueClipCanary(options: {
  privateStateRoot: string;
  runsRoot: string;
  archiveStore?: Pick<
    ReplayPremiereArchiveStore,
    "archiveRoot" | "revealPublicRatedCoworldPointersForRunKey"
  >;
  target: AiLeagueClipCanaryTarget;
  priorStateSha256: string;
  rootPredecessorStateSha256: string;
  expiresAt: string;
  now?: () => number;
  expectedUid?: number | null;
  mutationLockHost?: AiLeagueClipCanaryMutationLockHost;
}): Promise<AiLeagueClipCanaryRecord> {
  return withMutationLock(
    options.privateStateRoot,
    options.expectedUid,
    options.mutationLockHost,
    async () => {
      const nowMs = (options.now ?? Date.now)();
      const record: AiLeagueClipCanaryRecord = {
        schemaVersion: 3,
        lifecycle: "armed",
        ...options.target,
        priorStateSha256: options.priorStateSha256,
        rootPredecessorStateSha256: options.rootPredecessorStateSha256,
        armedAt: new Date(nowMs).toISOString(),
        expiresAt: options.expiresAt,
        claimedAt: null,
        disarmedAt: null,
      };
      if (parseAiLeagueClipCanaryRecord(JSON.stringify(record)) === null) {
        throw new Error("clip_canary_arm_invalid");
      }
      const existing = await readAiLeagueClipCanary({
        privateStateRoot: options.privateStateRoot,
        now: options.now,
        expectedUid: options.expectedUid,
      });
      if (existing.diagnostic.code !== "clip_canary_state_missing") {
        throw new Error(`clip_canary_arm_refused:${existing.diagnostic.code}`);
      }
      await verifyDisarmedPredecessors({
        privateStateRoot: options.privateStateRoot,
        priorStateSha256: options.priorStateSha256,
        rootPredecessorStateSha256: options.rootPredecessorStateSha256,
        expectedUid: options.expectedUid,
      });
      // This is deliberately inside the shared mutation lock and before the
      // one-shot state write. A stale archive pointer, changed replay source,
      // or pre-existing output must not consume the only v3 transaction.
      await validateFreshAiLeagueClipCanaryTarget({
        privateStateRoot: options.privateStateRoot,
        runsRoot: options.runsRoot,
        target: options.target,
        archiveStore: options.archiveStore,
      });
      await atomicWriteState(
        options.privateStateRoot,
        record,
        options.expectedUid,
      );
      return record;
    },
  );
}

export async function validateFreshAiLeagueClipCanaryTarget(options: {
  privateStateRoot: string;
  runsRoot: string;
  target: AiLeagueClipCanaryTarget;
  archiveStore?: Pick<
    ReplayPremiereArchiveStore,
    "archiveRoot" | "revealPublicRatedCoworldPointersForRunKey"
  >;
}): Promise<void> {
  if (!path.isAbsolute(options.runsRoot)) {
    throw new Error("clip_canary_runs_root_not_absolute");
  }
  const runDirectory = path.resolve(options.runsRoot, options.target.runKey);
  if (runDirectory !== path.join(options.runsRoot, options.target.runKey)) {
    throw new Error("clip_canary_source_path_escape");
  }
  const recordPath = path.join(runDirectory, "game-record.json");
  let before: Stats;
  try {
    before = await fs.lstat(recordPath);
  } catch (error) {
    throw new Error("clip_canary_source_unverifiable", { cause: error });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("clip_canary_source_unverifiable");
  }
  let handle;
  try {
    handle = await fs.open(
      recordPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw new Error("clip_canary_source_unverifiable", { cause: error });
  }
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || !opened.isFile()) {
      throw new Error("clip_canary_source_changed_during_read");
    }
    bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (!sameIdentity(opened, openedAfter)) {
      throw new Error("clip_canary_source_changed_during_read");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  let after: Stats;
  try {
    after = await fs.lstat(recordPath);
  } catch (error) {
    throw new Error("clip_canary_source_changed_during_read", { cause: error });
  }
  if (!sameIdentity(before, after) || after.size !== bytes.byteLength) {
    throw new Error("clip_canary_source_changed_during_read");
  }
  const parsed = GameRecordSchema.safeParse(
    (() => {
      try {
        return JSON.parse(bytes.toString("utf8"));
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success) throw new Error("clip_canary_source_invalid");
  const renderableThroughTurn = parsed.data.info.num_turns;
  if (
    !Number.isSafeInteger(renderableThroughTurn) ||
    renderableThroughTurn <= 0 ||
    premiereClipRepresentativeAnchorTurn(options.target.bucket) >
      renderableThroughTurn
  ) {
    throw new Error("clip_canary_source_range_invalid");
  }
  const actualSourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSourceSha256 !== options.target.sourceReplaySha256) {
    throw new Error("clip_canary_source_sha256_mismatch");
  }

  const archiveStore =
    options.archiveStore ??
    (await ReplayPremiereArchiveStore.open({
      privateStateRoot: options.privateStateRoot,
      compactOnOpen: false,
    }));
  const pointers = archiveStore.revealPublicRatedCoworldPointersForRunKey(
    options.target.runKey,
  );
  if (
    pointers.length !== 1 ||
    pointers[0]?.premiereId !== options.target.premiereId
  ) {
    throw new Error("clip_canary_archive_pointer_mismatch");
  }

  const cacheClip = path.join(
    options.privateStateRoot,
    "league-clips-v1",
    options.target.runKey,
    clipFileName(options.target.bucket),
  );
  const archiveClipsRoot = archivedPremiereClipsDir(archiveStore.archiveRoot);
  for (const artifactPath of [
    cacheClip,
    cacheClip.replace(/\.mp4$/, ".render-manifest.json"),
    path.join(
      archiveClipsRoot,
      archivedPremiereClipFileName(options.target.premiereId),
    ),
    path.join(
      archiveClipsRoot,
      archivedPremiereClipManifestFileName(options.target.premiereId),
    ),
  ]) {
    try {
      await fs.lstat(artifactPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw new Error("clip_canary_fresh_target_unverifiable", {
        cause: error,
      });
    }
    throw new Error("clip_canary_fresh_target_already_exists");
  }
}

export async function claimAiLeagueClipCanary(options: {
  privateStateRoot: string;
  expectedTarget: AiLeagueClipCanaryTarget;
  now?: () => number;
  expectedUid?: number | null;
  mutationLockHost?: AiLeagueClipCanaryMutationLockHost;
}): Promise<AiLeagueClipCanaryRecord> {
  return withMutationLock(
    options.privateStateRoot,
    options.expectedUid,
    options.mutationLockHost,
    async () => {
      const loaded = await readAiLeagueClipCanary(options);
      if (!loaded.enabled || loaded.record === null) {
        throw new Error(`clip_canary_claim_refused:${loaded.diagnostic.code}`);
      }
      if (!sameTarget(loaded.record, options.expectedTarget)) {
        throw new Error("clip_canary_claim_target_mismatch");
      }
      const claimedAt = new Date((options.now ?? Date.now)()).toISOString();
      const claimed: AiLeagueClipCanaryRecord = {
        ...loaded.record,
        lifecycle: "claimed",
        claimedAt,
      };
      if (parseAiLeagueClipCanaryRecord(JSON.stringify(claimed)) === null) {
        throw new Error("clip_canary_claim_invalid");
      }
      await atomicWriteState(
        options.privateStateRoot,
        claimed,
        options.expectedUid,
      );
      return claimed;
    },
  );
}

export async function disarmAiLeagueClipCanary(options: {
  privateStateRoot: string;
  now?: () => number;
  expectedUid?: number | null;
  mutationLockHost?: AiLeagueClipCanaryMutationLockHost;
}): Promise<AiLeagueClipCanaryReadResult> {
  return withMutationLock(
    options.privateStateRoot,
    options.expectedUid,
    options.mutationLockHost,
    async () => {
      const loaded = await readAiLeagueClipCanary(options);
      if (loaded.record?.lifecycle === "disarmed") return loaded;
      if (loaded.record === null) return loaded;
      if (
        loaded.diagnostic.code !== "clip_canary_armed" &&
        loaded.diagnostic.code !== "clip_canary_state_expired" &&
        loaded.diagnostic.code !== "clip_canary_state_claimed"
      ) {
        return loaded;
      }
      const disarmed: AiLeagueClipCanaryRecord = {
        ...loaded.record,
        lifecycle: "disarmed",
        disarmedAt: new Date((options.now ?? Date.now)()).toISOString(),
      };
      if (parseAiLeagueClipCanaryRecord(JSON.stringify(disarmed)) === null) {
        throw new Error("clip_canary_disarm_invalid");
      }
      await atomicWriteState(
        options.privateStateRoot,
        disarmed,
        options.expectedUid,
      );
      return diagnosticResult("clip_canary_state_disarmed", disarmed);
    },
  );
}

export function clipCanaryStatePath(privateStateRoot: string): string {
  return path.join(path.resolve(privateStateRoot), AI_LEAGUE_CLIP_CANARY_FILE);
}

export function sameAiLeagueClipCanaryTarget(
  left: AiLeagueClipCanaryTarget,
  right: AiLeagueClipCanaryTarget,
): boolean {
  return sameTarget(left, right);
}

/**
 * The canary has no public write path. This middleware is intentionally safe
 * to mount before body parsers so malformed or oversized JSON cannot turn the
 * exact Clip request into a parser response or mutate parser/rate-limit state.
 */
export function createAiLeagueClipCanaryWriteRefusal(options: {
  isCanaryActive: () => boolean;
}): RequestHandler {
  return (request, response, next) => {
    if (
      options.isCanaryActive() &&
      request.method === "POST" &&
      matchProxyWarLeagueClipWritePath(request.path) !== null
    ) {
      response.setHeader("Cache-Control", "no-store, max-age=0");
      response.status(404).json({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } });
      return;
    }
    next();
  };
}

async function atomicWriteState(
  privateStateRoot: string,
  record: AiLeagueClipCanaryRecord,
  configuredUid: number | null | undefined,
): Promise<void> {
  const root = path.resolve(privateStateRoot);
  const expectedUid =
    configuredUid === undefined ? currentUid() : configuredUid;
  if (expectedUid === null) throw new Error("clip_canary_owner_unverifiable");
  const rootValidation = await validatePrivateStateRoot(root, expectedUid);
  if (typeof rootValidation === "string") {
    throw new Error(rootValidation);
  }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > AI_LEAGUE_CLIP_CANARY_MAX_BYTES) {
    throw new Error("clip_canary_state_too_large");
  }
  const destination = clipCanaryStatePath(root);
  const temporary = path.join(
    root,
    `.${AI_LEAGUE_CLIP_CANARY_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let renamed = false;
  try {
    handle = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const temporaryStat = await fs.lstat(temporary);
    const metadataFailure = validateStateMetadata(temporaryStat, expectedUid);
    if (metadataFailure !== null || temporaryStat.size !== bytes.byteLength) {
      throw new Error(
        `clip_canary_temporary_invalid:${metadataFailure ?? "size"}`,
      );
    }
    await fs.rename(temporary, destination);
    renamed = true;
    await syncDirectory(root);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!renamed) {
      await fs.unlink(temporary).catch(() => undefined);
      await syncDirectory(root).catch(() => undefined);
      throw error;
    }
    throw new Error("clip_canary_state_commit_uncertain", { cause: error });
  }
}

async function withMutationLock<T>(
  privateStateRoot: string,
  configuredUid: number | null | undefined,
  configuredHost: AiLeagueClipCanaryMutationLockHost | undefined,
  mutate: () => Promise<T>,
): Promise<T> {
  const root = path.resolve(privateStateRoot);
  const expectedUid =
    configuredUid === undefined ? currentUid() : configuredUid;
  if (expectedUid === null) throw new Error("clip_canary_owner_unverifiable");
  const rootValidation = await validatePrivateStateRoot(root, expectedUid);
  if (typeof rootValidation === "string") {
    throw new Error(rootValidation);
  }
  const lockPath = path.join(root, AI_LEAGUE_CLIP_CANARY_LOCK_FILE);
  const host = configuredHost ?? DEFAULT_MUTATION_LOCK_HOST;
  let lockHandle: Awaited<ReturnType<typeof fs.open>>;
  try {
    lockHandle = await createMutationLock(lockPath, root);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    await recoverVerifiedStaleMutationLock({
      lockPath,
      root,
      rootIdentity: rootValidation,
      expectedUid,
      host,
    });
    try {
      lockHandle = await createMutationLock(lockPath, root);
    } catch (retryError) {
      if (isNodeError(retryError, "EEXIST")) {
        throw new Error("clip_canary_mutation_lock_retry_blocked", {
          cause: retryError,
        });
      }
      throw retryError;
    }
  }
  let result: T;
  try {
    result = await mutate();
  } catch (error) {
    try {
      await releaseMutationLock(
        lockHandle,
        lockPath,
        root,
        host.beforeMutationLockRelease,
      );
    } catch (cleanupError) {
      throw new Error("clip_canary_mutation_lock_cleanup_uncertain", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  await releaseMutationLock(
    lockHandle,
    lockPath,
    root,
    host.beforeMutationLockRelease,
  );
  return result;
}

const DEFAULT_MUTATION_LOCK_HOST: AiLeagueClipCanaryMutationLockHost = {
  processStatus: (pid) => {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      return isNodeError(error, "ESRCH") ? "absent" : "unknown";
    }
  },
};

async function createMutationLock(
  lockPath: string,
  root: string,
): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const lockHandle = await fs.open(
    lockPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const record: AiLeagueClipCanaryMutationLockRecord = {
      schemaVersion: 1,
      pid: process.pid,
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength > AI_LEAGUE_CLIP_CANARY_LOCK_MAX_BYTES) {
      throw new Error("clip_canary_mutation_lock_record_too_large");
    }
    await lockHandle.writeFile(bytes);
    await lockHandle.sync();
    await syncDirectory(root);
    return lockHandle;
  } catch (error) {
    try {
      await releaseMutationLock(lockHandle, lockPath, root);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "clip_canary_mutation_lock_cleanup_uncertain",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

async function recoverVerifiedStaleMutationLock(options: {
  lockPath: string;
  root: string;
  rootIdentity: Stats;
  expectedUid: number;
  host: AiLeagueClipCanaryMutationLockHost;
}): Promise<void> {
  const verified = await readVerifiedMutationLock(options);
  await options.host.beforeStaleLockUnlink?.(options.lockPath);
  await assertMutationLockPathStable(options, verified.identity);

  let processStatus: AiLeagueClipCanaryProcessStatus;
  try {
    processStatus = await options.host.processStatus(verified.record.pid);
  } catch (error) {
    throw new Error("clip_canary_mutation_lock_owner_pid_unverifiable", {
      cause: error,
    });
  }
  if (processStatus === "alive") {
    throw new Error("clip_canary_mutation_lock_owner_pid_live");
  }
  if (processStatus !== "absent") {
    throw new Error("clip_canary_mutation_lock_owner_pid_unverifiable");
  }

  // This second check follows the asynchronous process probe. Its final lstat
  // is the last awaited operation before unlink, minimizing the only remaining
  // same-uid pathname-swap window available through Node's API.
  await assertMutationLockPathStable(options, verified.identity);
  try {
    await fs.unlink(options.lockPath);
    await syncDirectory(options.root);
  } catch (error) {
    throw new Error("clip_canary_mutation_lock_recovery_uncertain", {
      cause: error,
    });
  }
  await options.host.afterStaleLockRemoval?.(options.lockPath);
}

async function assertMutationLockPathStable(
  options: {
    lockPath: string;
    root: string;
    rootIdentity: Stats;
    expectedUid: number;
  },
  expectedIdentity: Stats,
): Promise<void> {
  const currentRoot = await validatePrivateStateRoot(
    options.root,
    options.expectedUid,
  );
  if (
    typeof currentRoot === "string" ||
    !sameIdentity(options.rootIdentity, currentRoot)
  ) {
    throw new Error("clip_canary_mutation_lock_changed_during_recovery");
  }

  let current: Stats;
  try {
    current = await fs.lstat(options.lockPath);
  } catch (error) {
    throw new Error("clip_canary_mutation_lock_changed_during_recovery", {
      cause: error,
    });
  }
  const currentFailure = mutationLockMetadataFailure(
    current,
    options.expectedUid,
  );
  if (currentFailure !== null || !sameIdentity(expectedIdentity, current)) {
    throw new Error(
      currentFailure ?? "clip_canary_mutation_lock_changed_during_recovery",
    );
  }
}

async function readVerifiedMutationLock(options: {
  lockPath: string;
  root: string;
  rootIdentity: Stats;
  expectedUid: number;
}): Promise<{
  identity: Stats;
  record: AiLeagueClipCanaryMutationLockRecord;
}> {
  let before: Stats;
  try {
    before = await fs.lstat(options.lockPath);
  } catch (error) {
    throw new Error("clip_canary_mutation_lock_changed_during_recovery", {
      cause: error,
    });
  }
  const beforeFailure = mutationLockMetadataFailure(
    before,
    options.expectedUid,
  );
  if (beforeFailure !== null) throw new Error(beforeFailure);

  let lockHandle: Awaited<ReturnType<typeof fs.open>>;
  try {
    lockHandle = await fs.open(
      options.lockPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw new Error("clip_canary_mutation_lock_read_failed", { cause: error });
  }

  let opened: Stats;
  let bytes: Buffer | null = null;
  let readFailure: Error | null = null;
  try {
    opened = await lockHandle.stat();
    const openedFailure = mutationLockMetadataFailure(
      opened,
      options.expectedUid,
    );
    if (openedFailure !== null) throw new Error(openedFailure);
    if (!sameIdentity(before, opened)) {
      throw new Error("clip_canary_mutation_lock_changed_during_recovery");
    }
    bytes = await readBoundedMutationLock(lockHandle);
    const openedAfter = await lockHandle.stat();
    if (!sameIdentity(opened, openedAfter)) {
      throw new Error("clip_canary_mutation_lock_changed_during_recovery");
    }
  } catch (error) {
    readFailure =
      error instanceof Error &&
      error.message.startsWith("clip_canary_mutation_lock_")
        ? error
        : new Error("clip_canary_mutation_lock_read_failed", { cause: error });
  }
  try {
    await lockHandle.close();
  } catch (error) {
    readFailure ??= new Error("clip_canary_mutation_lock_read_failed", {
      cause: error,
    });
  }
  if (readFailure !== null) throw readFailure;
  if (bytes === null) throw new Error("clip_canary_mutation_lock_read_failed");

  if (bytes.byteLength > AI_LEAGUE_CLIP_CANARY_LOCK_MAX_BYTES) {
    throw new Error("clip_canary_mutation_lock_too_large");
  }
  let after: Stats;
  try {
    after = await fs.lstat(options.lockPath);
  } catch (error) {
    throw new Error("clip_canary_mutation_lock_changed_during_recovery", {
      cause: error,
    });
  }
  const afterFailure = mutationLockMetadataFailure(after, options.expectedUid);
  if (afterFailure !== null) throw new Error(afterFailure);
  if (!sameIdentity(before, after) || after.size !== bytes.byteLength) {
    throw new Error("clip_canary_mutation_lock_changed_during_recovery");
  }
  const rootAfter = await validatePrivateStateRoot(
    options.root,
    options.expectedUid,
  );
  if (
    typeof rootAfter === "string" ||
    !sameIdentity(options.rootIdentity, rootAfter)
  ) {
    throw new Error("clip_canary_mutation_lock_changed_during_recovery");
  }
  const record = parseMutationLockRecord(bytes);
  if (record === null) {
    throw new Error("clip_canary_mutation_lock_malformed");
  }
  return { identity: after, record };
}

async function readBoundedMutationLock(
  lockHandle: Awaited<ReturnType<typeof fs.open>>,
): Promise<Buffer> {
  const buffer = Buffer.alloc(AI_LEAGUE_CLIP_CANARY_LOCK_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await lockHandle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function parseMutationLockRecord(
  bytes: Buffer,
): AiLeagueClipCanaryMutationLockRecord | null {
  if (bytes.byteLength > AI_LEAGUE_CLIP_CANARY_LOCK_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== MUTATION_LOCK_KEYS.length ||
    keys.some((key, index) => key !== MUTATION_LOCK_KEYS[index]) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    parsed.pid > 2_147_483_647
  ) {
    return null;
  }
  return parsed as unknown as AiLeagueClipCanaryMutationLockRecord;
}

function mutationLockMetadataFailure(
  stat: Stats,
  expectedUid: number,
): string | null {
  if (stat.isSymbolicLink()) return "clip_canary_mutation_lock_symlink";
  if (!stat.isFile()) return "clip_canary_mutation_lock_not_regular";
  if (stat.nlink !== 1) return "clip_canary_mutation_lock_hardlinked";
  if (stat.uid !== expectedUid) return "clip_canary_mutation_lock_wrong_owner";
  if ((stat.mode & 0o777) !== 0o600) {
    return "clip_canary_mutation_lock_wrong_mode";
  }
  if (stat.size > AI_LEAGUE_CLIP_CANARY_LOCK_MAX_BYTES) {
    return "clip_canary_mutation_lock_too_large";
  }
  return null;
}

async function releaseMutationLock(
  lockHandle: Awaited<ReturnType<typeof fs.open>>,
  lockPath: string,
  root: string,
  beforeIdentityCheck?: (lockPath: string) => void | Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    const ownedIdentity = await lockHandle.stat();
    const ownedFailure = mutationLockMetadataFailure(
      ownedIdentity,
      ownedIdentity.uid,
    );
    if (ownedFailure !== null) {
      throw new Error(
        `clip_canary_mutation_lock_release_identity_invalid:${ownedFailure}`,
      );
    }

    await beforeIdentityCheck?.(lockPath);
    let currentIdentity: Stats;
    try {
      currentIdentity = await fs.lstat(lockPath);
    } catch (error) {
      throw new Error("clip_canary_mutation_lock_replaced_before_release", {
        cause: error,
      });
    }
    const currentFailure = mutationLockMetadataFailure(
      currentIdentity,
      ownedIdentity.uid,
    );
    if (
      currentFailure !== null ||
      !sameIdentity(ownedIdentity, currentIdentity)
    ) {
      throw new Error("clip_canary_mutation_lock_replaced_before_release");
    }

    // Keep the owned descriptor open across the final pathname check and
    // unlink. Node has no unlink-by-descriptor/CAS primitive, so the fstat
    // afterward detects (but cannot reverse) a swap in the syscall window.
    await fs.unlink(lockPath);
    const ownedAfterUnlink = await lockHandle.stat();
    if (
      ownedAfterUnlink.dev !== ownedIdentity.dev ||
      ownedAfterUnlink.ino !== ownedIdentity.ino ||
      ownedAfterUnlink.nlink !== 0
    ) {
      throw new Error("clip_canary_mutation_lock_unlink_identity_uncertain");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await lockHandle.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await syncDirectory(root);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new Error("clip_canary_mutation_lock_release_uncertain", {
      cause: new AggregateError(errors),
    });
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(
    directoryPath,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateStateMetadata(
  stat: Stats,
  expectedUid: number | null,
): AiLeagueClipCanaryDiagnosticCode | null {
  if (stat.isSymbolicLink()) return "clip_canary_state_symlink";
  if (!stat.isFile()) return "clip_canary_state_not_regular";
  if (stat.nlink !== 1) return "clip_canary_state_hardlinked";
  if (expectedUid === null || stat.uid !== expectedUid) {
    return "clip_canary_state_wrong_owner";
  }
  if ((stat.mode & 0o777) !== 0o600) {
    return "clip_canary_state_wrong_mode";
  }
  if (stat.size > AI_LEAGUE_CLIP_CANARY_MAX_BYTES) {
    return "clip_canary_state_too_large";
  }
  return null;
}

function diagnosticResult(
  code: AiLeagueClipCanaryDiagnosticCode,
  record: AiLeagueClipCanaryRecord | null = null,
  claimable = false,
  readEnabled = false,
): AiLeagueClipCanaryReadResult {
  return {
    claimable,
    readEnabled,
    enabled: claimable,
    diagnostic: { code, message: DIAGNOSTIC_MESSAGES[code] },
    record,
  };
}

async function validatePrivateStateRoot(
  privateStateRoot: string,
  expectedUid: number | null,
): Promise<Stats | AiLeagueClipCanaryDiagnosticCode> {
  const root = path.resolve(privateStateRoot);
  let cursor = root;
  let verifiedRoot: Stats | null = null;
  while (true) {
    let stat: Stats;
    try {
      stat = await fs.lstat(cursor);
    } catch {
      return "clip_canary_private_state_root_invalid";
    }
    if (stat.isSymbolicLink()) return "clip_canary_private_state_root_invalid";
    if (cursor === root) {
      if (!stat.isDirectory()) return "clip_canary_private_state_root_invalid";
      if (expectedUid === null || stat.uid !== expectedUid) {
        return "clip_canary_private_state_root_wrong_owner";
      }
      if ((stat.mode & 0o777) !== 0o700) {
        return "clip_canary_private_state_root_wrong_mode";
      }
      verifiedRoot = stat;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return verifiedRoot ?? "clip_canary_private_state_root_invalid";
    }
    cursor = parent;
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameTarget(
  left: AiLeagueClipCanaryTarget,
  right: AiLeagueClipCanaryTarget,
): boolean {
  return (
    left.runKey === right.runKey &&
    left.premiereId === right.premiereId &&
    left.bucket === right.bucket &&
    left.sourceReplaySha256 === right.sourceReplaySha256
  );
}

function currentUid(): number | null {
  return process.getuid?.() ?? null;
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nullableCanonicalTimestamp(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && isCanonicalTimestamp(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
