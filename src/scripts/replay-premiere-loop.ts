import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  addRetentionPinOwner,
  minimumAvailableDiskBytes,
  removeRetentionPinOwner,
} from "../server/agents/CoworldLeagueArtifactRetention";
import {
  LATEST_PREMIERE_POINTER_SCHEMA_VERSION,
  latestPremierePointerPath,
  premiereSuppressionContractPath,
  premiereSuppressionStorageStateDir,
  writeLatestPremierePointer,
  writePremiereSuppressionContract,
} from "../server/agents/CoworldLeaguePremiereSuppression";
import {
  buildProxyWarDemoServerUrls,
  loadProxyWarDemoServerNetworkConfig,
} from "../server/agents/ProxyWarDemoServerConfig";
import { readReplayPremiereArchivePointer } from "../server/replay-premiere/ReplayPremiereArchiveIndex";
import { readReplayPremiereAdmissionRecord } from "../server/replay-premiere/ReplayPremiereCatalog";
import { PREMIERE_REAL_TURN_INTERVAL_MS } from "../server/replay-premiere/ReplayPremiereContracts";
import {
  backfillReplayPremiereTerminalTombstones,
  persistReplayPremiereTerminalTombstone,
  readActiveReplayPremiereStartupSelection,
  replayPremiereStartupSelectionFingerprint,
  type ReplayPremiereStartupSelectionReceiptV1,
} from "../server/replay-premiere/ReplayPremiereCoordination";
import { formatReplayPremiereErrorCauseChain } from "../server/replay-premiere/ReplayPremiereErrorTelemetry";
import { ReplayPremiereError } from "../server/replay-premiere/ReplayPremiereErrors";
import {
  PREMIERE_LOOP_ACTIVATION_BACKOFF_MS,
  PREMIERE_LOOP_ADMISSION_PROJECTION_TIMEOUT_MS,
  PREMIERE_LOOP_DIVISION_ID,
  PREMIERE_LOOP_HOLD_WINDOW_MS,
  PREMIERE_LOOP_LEAGUE_ID,
  PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS,
  PREMIERE_LOOP_MAX_RAW_REPLAY_CACHE,
  PREMIERE_LOOP_MAX_REPLAY_DOWNLOADS,
  buildLoopEligibilityInput,
  buildLoopPremiereDefinition,
  buildLoopSuppressionContract,
  decideActivationVerification,
  decideLoopClaim,
  derivePremiereId,
  foldLoopJournal,
  holdExpiresAtForScheduled,
  isActivationBackoffActive,
  isCompletedTooOldToSeal,
  isHoldExpired,
  isManagedPublicRunKey,
  isTurnCountWithinStartupBudget,
  loopSideEffectPlan,
  mapLabelFromVariantName,
  orderEpisodesForClaim,
  parseLoopReplayRows,
  parseLoopRounds,
  playbackRateForTurnCount,
  publicRunKeyForSourceRunId,
  scheduledAtForClaim,
  type LoopHoldState,
  type LoopJournalRecord,
  type LoopReleaseOutcome,
  type LoopReplayRow,
  type LoopRound,
  type LoopRoundRef,
  type LoopSkipReason,
} from "../server/replay-premiere/ReplayPremiereLoopCore";
import { resolveReplayPremierePrivateStateRoot } from "../server/replay-premiere/ReplayPremiereSecrets";
import { runReplayPremiereAdmission } from "./replay-premiere-admit";
import { runReplayPremiereCoworldIngest } from "./replay-premiere-ingest-coworld";

/**
 * Bounded Replay Premiere watcher loop (Phase 2). One iteration per invocation, run
 * by a launchd StartInterval=60 job. Detects a newly completed rated Coworld
 * league round, holds its freshest episode from the public league page, ingests
 * and admits it in-process into a sealed premiere, activates it with a
 * controlled server restart, tracks it to reveal, then releases the hold so the
 * episode publishes ordinarily.
 *
 * ADMISSION PROJECTION AND ACTIVATION ARE BOUNDED. New admissions compute and
 * durably publish their checkpoint projection before catalog visibility under
 * a fixed 90-second deadline; timeout releases the hold as `admit_failed`.
 * Startup then authenticates and loads that artifact inside the unchanged
 * eight-second replacement bound. The tracker still verifies the loopback
 * manifest as defense in depth for legacy/missing artifacts and other startup
 * failures: after a bounded window it fires exactly one re-activation, then
 * releases as terminal `activation_lost` rather than zombie-tracking to
 * `holdExpiresAt`.
 *
 * Each live tick heartbeats a STANDING suppression contract — zero holds when
 * nothing is claimed — whose blanket quarantine lets the loop win the publish
 * race against the 300s mirror. A post-reveal cooldown now keeps the prior
 * premiere resident through its reclamation grace; rounds completed during
 * that window are explicitly skipped and publish normally at quarantine
 * expiry instead of triggering another host restart.
 *
 * Read-only toward Softmax (coworld `rounds`/`replays`/`divisions` reads plus
 * public S3 replay downloads); the only local mutations are the suppression
 * contract, the retention pin, the private premiere catalog (via the reviewed
 * admit command), and the reviewed launchd restart helper. It never uploads,
 * submits, or publishes to hosted Coworld.
 *
 * `--shadow` runs INGEST only for safe live observation: no contract, no pin,
 * no admit, no restart, no mutation of the real loop journal.
 */

const execFileAsync = promisify(execFile);
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const MAX_REPLAY_BYTES = 256 * MIB;
const COWORLD_READ_VERBS = new Set(["rounds", "replays", "divisions"]);

interface LoopConfig {
  leagueId: string;
  divisionId: string;
  contractPath: string;
  latestPremierePointerPath: string;
  privateStateRoot: string;
  servedRoots: string[];
  deploymentOrigin: string | null;
  loopbackBaseUrl: string;
  restartReadyUrl: string;
  pinManifestPath: string;
  loopStateDir: string;
  journalPath: string;
  decisionsPath: string;
  shadowDecisionsPath: string;
  lockDir: string;
  ingestScratchDir: string;
  nonceDir: string;
  minimumFreeBytes: number;
  turnIntervalMs: number;
  coworldTimeoutMs: number;
  restartHelperPath: string;
  nodeBin: string;
}

function resolveLoopConfig(env: NodeJS.ProcessEnv): LoopConfig {
  const cwd = process.cwd();
  const storageStateDir = premiereSuppressionStorageStateDir();
  const loopStateDir = path.join(storageStateDir, "premiere-loop");
  const network = loadProxyWarDemoServerNetworkConfig(env);
  const urls = buildProxyWarDemoServerUrls(network);
  const deploymentOrigin =
    urls.publicUrl === null ? null : new URL(urls.publicUrl).origin;
  const loopbackBaseUrl = normalizeLoopbackUrl(
    env.PROXYWAR_PREMIERE_LOOP_LOOPBACK_URL ?? urls.localUrl,
  );
  const artifactsRoot =
    env.PROXYWAR_ARTIFACTS_ROOT !== undefined &&
    env.PROXYWAR_ARTIFACTS_ROOT !== ""
      ? path.resolve(env.PROXYWAR_ARTIFACTS_ROOT)
      : path.join(cwd, "artifacts");
  return {
    leagueId: env.PROXYWAR_LEAGUE_ID ?? PREMIERE_LOOP_LEAGUE_ID,
    divisionId: env.PROXYWAR_LEAGUE_DIVISION_ID ?? PREMIERE_LOOP_DIVISION_ID,
    contractPath: premiereSuppressionContractPath(storageStateDir),
    latestPremierePointerPath: latestPremierePointerPath(storageStateDir),
    privateStateRoot: resolveReplayPremierePrivateStateRoot(env),
    // Mirror the demo server's served roots exactly so admission's private
    // layout validation and the catalog the server reads at startup agree.
    servedRoots: [
      cwd,
      path.join(cwd, "static"),
      artifactsRoot,
      path.join(cwd, "docs"),
      path.join(cwd, "examples", "external-agent"),
    ],
    deploymentOrigin,
    loopbackBaseUrl,
    restartReadyUrl: `${loopbackBaseUrl}/league`,
    // Resolved identically to the mirror so the loop and mirror agree by
    // default. In production this must point outside the byte-frozen release
    // checkout (see the deploy notes) so pin writes never dirty the tree.
    pinManifestPath:
      env.PROXYWAR_LEAGUE_RETENTION_PINS ??
      path.join(cwd, "deploy", "coworld-league-retention-pins.json"),
    loopStateDir,
    journalPath: path.join(loopStateDir, "journal.jsonl"),
    decisionsPath: path.join(loopStateDir, "decisions.jsonl"),
    shadowDecisionsPath: path.join(loopStateDir, "shadow-decisions.jsonl"),
    lockDir: path.join(loopStateDir, "loop.lock"),
    ingestScratchDir: path.join(loopStateDir, "ingest-scratch"),
    nonceDir: path.join(loopStateDir, "admit-nonce"),
    minimumFreeBytes: Number(env.PROXYWAR_LEAGUE_MIN_FREE_GIB ?? "10") * GIB,
    // Real match cadence by default (100 ms/turn — DefaultConfig
    // turnIntervalMs), so a premiere at rate 1 plays at regular OpenFront
    // speed. The env var remains only as an explicit operator override.
    turnIntervalMs: Number(
      env.PROXYWAR_PREMIERE_LOOP_TURN_INTERVAL_MS ??
        String(PREMIERE_REAL_TURN_INTERVAL_MS),
    ),
    coworldTimeoutMs: Number(
      env.PROXYWAR_PREMIERE_LOOP_COWORLD_TIMEOUT_MS ?? "120000",
    ),
    restartHelperPath: path.join(
      cwd,
      "deploy",
      "mac",
      "proxywar-beta-launchd-restart.mjs",
    ),
    nodeBin: process.execPath,
  };
}

function normalizeLoopbackUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(`premiere loop loopback URL must be loopback HTTP: ${raw}`);
  }
  return url.origin;
}

// ---------------------------------------------------------------------------
// Logging + journal
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[premiere-loop ${new Date().toISOString()}] ${message}`);
}

async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export type LoopJournalDurabilityPhase =
  | "after_write"
  | "after_file_sync"
  | "after_file_close"
  | "after_directory_sync";

/** Test-only crash seam around the durable journal publication boundary. */
export type LoopJournalDurabilityFaultInjector = (
  phase: LoopJournalDurabilityPhase,
  record: LoopJournalRecord,
) => void | Promise<void>;

async function appendDurableJournalRecord(
  filePath: string,
  record: LoopJournalRecord,
  faultInjector?: LoopJournalDurabilityFaultInjector,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const handle = await fs.open(
    filePath,
    constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600,
  );
  let publicationError: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await faultInjector?.("after_write", record);
    await handle.sync();
    await faultInjector?.("after_file_sync", record);
  } catch (error) {
    publicationError = error;
  }
  try {
    await handle.close();
    await faultInjector?.("after_file_close", record);
  } catch (error) {
    publicationError =
      publicationError === undefined
        ? error
        : new AggregateError(
            [publicationError, error],
            "journal append and close both failed",
          );
  }
  if (publicationError !== undefined) throw publicationError;
  await syncLoopDirectory(directory);
  await faultInjector?.("after_directory_sync", record);
}

async function readJournal(journalPath: string): Promise<LoopJournalRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(journalPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const records: LoopJournalRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as LoopJournalRecord);
    } catch {
      // A torn final line (crash mid-append) is ignored; the loop is resilient
      // to a dropped trailing record.
    }
  }
  return records;
}

// The active journal is kept bounded so a long-lived loop never reads an
// unbounded file each tick. Rotation archives the dropped prefix rather than
// deleting it, and always preserves the active hold's latest update so folding
// the compacted journal is decision-equivalent for every round still in the
// ~40-round watch window.
const MAX_JOURNAL_RECORDS = 5_000;
const KEEP_JOURNAL_RECORDS = 2_000;
const TOMBSTONED_TERMINAL_RELEASE_OUTCOMES = new Set<LoopReleaseOutcome>([
  "expired",
  "leak_audit_refused",
  "activation_refused",
  "activation_lost",
  "ingest_failed",
  "admit_failed",
  "projection_over_budget",
]);

export type LoopJournalCompactionPhase =
  | "after_archive_sync"
  | "after_temporary_write"
  | "after_temporary_sync"
  | "after_temporary_close"
  | "after_rename"
  | "before_directory_sync"
  | "after_directory_sync"
  | "before_temporary_cleanup"
  | "after_temporary_cleanup";

/** Test-only crash seam around private journal rotation. */
export type LoopJournalCompactionFaultInjector = (
  phase: LoopJournalCompactionPhase,
) => void | Promise<void>;

export async function compactJournalIfNeeded(
  config: LoopConfig,
  records: LoopJournalRecord[],
  faultInjector?: LoopJournalCompactionFaultInjector,
): Promise<LoopJournalRecord[]> {
  if (records.length <= MAX_JOURNAL_RECORDS) {
    return records;
  }
  const folded = foldLoopJournal(records);
  const keepStart = records.length - KEEP_JOURNAL_RECORDS;
  const dropped = records.slice(0, keepStart);
  // Strict tombstone backfill needs the exact hold phase preceding a terminal
  // release. Never split that association across the archive/active boundary:
  // the archive may grow without bound and is deliberately not scanned by
  // each minute loop iteration.
  const kept = [
    ...terminalReleaseHoldUpdatesCrossingBoundary(records, keepStart),
    ...records.slice(keepStart),
  ];
  if (
    folded.activeHold !== null &&
    !kept.some(
      (record) =>
        record.kind === "hold_update" &&
        record.hold.episodeRequestId === folded.activeHold?.episodeRequestId,
    )
  ) {
    kept.unshift({
      kind: "hold_update",
      ts: new Date().toISOString(),
      hold: folded.activeHold,
    });
  }
  // Archive first (never delete), but never depend on the archive to recover
  // the active hold. The compacted active journal carries that hold forward.
  // A failed/uncertain archive append aborts before active-journal replacement.
  const archivePath = path.join(config.loopStateDir, "journal.archive.jsonl");
  await appendDurablePrivateBytes(
    archivePath,
    `${dropped.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  await faultInjector?.("after_archive_sync");

  const journalDirectory = path.dirname(config.journalPath);
  await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${config.journalPath}.${process.pid}.${randomUUID()}.tmp`;
  const compactedBytes = `${kept
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;
  let temporaryCreated = false;
  let renamed = false;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    await handle.chmod(0o600);
    await handle.writeFile(compactedBytes, "utf8");
    await faultInjector?.("after_temporary_write");
    await handle.sync();
    await faultInjector?.("after_temporary_sync");
    await handle.close();
    handle = null;
    await faultInjector?.("after_temporary_close");
    await fs.rename(temporaryPath, config.journalPath);
    renamed = true;
    await faultInjector?.("after_rename");
    await faultInjector?.("before_directory_sync");
    await syncLoopDirectory(journalDirectory);
    await faultInjector?.("after_directory_sync");
  } catch (error) {
    let failure = error;
    if (handle !== null) {
      try {
        await handle.close();
      } catch (closeError) {
        failure = combinedJournalError(
          failure,
          closeError,
          "journal compaction and temporary close both failed",
        );
      }
    }
    if (temporaryCreated && !renamed) {
      try {
        await faultInjector?.("before_temporary_cleanup");
        await fs.unlink(temporaryPath);
        await syncLoopDirectory(journalDirectory);
        await faultInjector?.("after_temporary_cleanup");
      } catch (cleanupError) {
        if (!isErrno(cleanupError, "ENOENT")) {
          failure = combinedJournalError(
            failure,
            cleanupError,
            "journal compaction and temporary cleanup both failed",
          );
        }
      }
    }
    throw failure;
  }
  log(`rotated journal: archived ${dropped.length}, kept ${kept.length}`);
  return kept;
}

function terminalReleaseHoldUpdatesCrossingBoundary(
  records: readonly LoopJournalRecord[],
  keepStart: number,
): LoopJournalRecord[] {
  const active = new Map<
    string,
    {
      index: number;
      record: Extract<LoopJournalRecord, { kind: "hold_update" }>;
    }
  >();
  const preserved = new Map<
    number,
    Extract<LoopJournalRecord, { kind: "hold_update" }>
  >();
  for (const [index, record] of records.entries()) {
    if (record.kind === "hold_update") {
      active.set(record.hold.episodeRequestId, { index, record });
      continue;
    }
    if (record.kind !== "hold_released") continue;
    const hold = active.get(record.episodeRequestId);
    if (
      index >= keepStart &&
      record.terminal &&
      TOMBSTONED_TERMINAL_RELEASE_OUTCOMES.has(record.outcome) &&
      hold !== undefined &&
      hold.index < keepStart
    ) {
      preserved.set(hold.index, hold.record);
    }
    active.delete(record.episodeRequestId);
  }
  return [...preserved.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, record]) => record);
}

async function appendDurablePrivateBytes(
  filePath: string,
  contents: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await fs.open(
    filePath,
    constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600,
  );
  let failure: unknown;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    failure =
      failure === undefined
        ? closeError
        : combinedJournalError(
            failure,
            closeError,
            "private append and close both failed",
          );
  }
  if (failure !== undefined) throw failure;
  await syncLoopDirectory(directory);
}

function combinedJournalError(
  primary: unknown,
  secondary: unknown,
  message: string,
): AggregateError {
  return new AggregateError([primary, secondary], message, { cause: primary });
}

interface JournalWriter {
  appendHoldUpdate(hold: LoopHoldState): Promise<void>;
  appendHoldReleased(
    hold: LoopHoldState,
    outcome: LoopReleaseOutcome,
    terminal: boolean,
    releasedAt?: string,
  ): Promise<void>;
  appendRoundSkipped(ref: LoopRoundRef, reason: LoopSkipReason): Promise<void>;
  appendDecision(decision: Record<string, unknown>): Promise<void>;
}

export function createJournalWriter(
  config: LoopConfig,
  faultInjector?: LoopJournalDurabilityFaultInjector,
): JournalWriter {
  const now = () => new Date().toISOString();
  return {
    async appendHoldUpdate(hold) {
      const record = {
        kind: "hold_update",
        ts: now(),
        hold,
      } satisfies LoopJournalRecord;
      await appendDurableJournalRecord(
        config.journalPath,
        record,
        faultInjector,
      );
    },
    async appendHoldReleased(hold, outcome, terminal, releasedAt) {
      const record = {
        kind: "hold_released",
        ts: releasedAt ?? now(),
        episodeRequestId: hold.episodeRequestId,
        premiereId: hold.premiereId,
        roundId: hold.roundId,
        outcome,
        terminal,
      } satisfies LoopJournalRecord;
      await appendDurableJournalRecord(
        config.journalPath,
        record,
        faultInjector,
      );
    },
    async appendRoundSkipped(ref, reason) {
      const record = {
        kind: "round_skipped",
        ts: now(),
        roundId: ref.id,
        roundNumber: ref.roundNumber,
        reason,
      } satisfies LoopJournalRecord;
      await appendDurableJournalRecord(
        config.journalPath,
        record,
        faultInjector,
      );
    },
    async appendDecision(decision) {
      await appendJsonl(config.decisionsPath, { ts: now(), ...decision });
    },
  };
}

// ---------------------------------------------------------------------------
// Single-instance lock (atomic mkdir; stale reclaim by owner pid liveness)
// ---------------------------------------------------------------------------

async function withSingleInstanceLock<T>(
  lockDir: string,
  operation: () => Promise<T>,
): Promise<T | null> {
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  const ownerPath = path.join(lockDir, "owner.json");
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }
    if (!(await reclaimStaleLock(lockDir, ownerPath))) {
      log("another premiere-loop iteration is running; skipping this tick");
      return null;
    }
    try {
      await fs.mkdir(lockDir);
    } catch (retryError) {
      if (isErrno(retryError, "EEXIST")) {
        log("another premiere-loop iteration is running; skipping this tick");
        return null;
      }
      throw retryError;
    }
  }
  await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, "utf8");
  try {
    return await operation();
  } finally {
    // Best-effort release: only remove the lock if we still own it. A failure
    // here (e.g. the owner file vanished) is non-fatal — the next iteration's
    // stale-reclaim handles an abandoned lock — and must never mask the
    // operation's own result, so it is logged rather than thrown.
    try {
      const current = JSON.parse(await fs.readFile(ownerPath, "utf8")) as {
        token?: string;
      };
      if (current.token === owner.token) {
        await fs.rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        log(`lock release warning: ${errorMessage(error)}`);
      }
    }
  }
}

async function reclaimStaleLock(
  lockDir: string,
  ownerPath: string,
): Promise<boolean> {
  let ownerPid: number | null = null;
  try {
    const parsed = JSON.parse(await fs.readFile(ownerPath, "utf8")) as {
      pid?: number;
    };
    ownerPid = typeof parsed.pid === "number" ? parsed.pid : null;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      return false;
    }
  }
  if (ownerPid !== null && processIsAlive(ownerPid)) {
    return false;
  }
  try {
    const stat = await fs.stat(lockDir);
    if (ownerPid === null && Date.now() - stat.mtimeMs < 90_000) {
      return false;
    }
  } catch (error) {
    return isErrno(error, "ENOENT");
  }
  const abandoned = `${lockDir}.abandoned.${randomUUID()}`;
  try {
    await fs.rename(lockDir, abandoned);
    await fs.rm(abandoned, { recursive: true, force: true });
    return true;
  } catch {
    // Another iteration reclaimed first; treat this tick as already-running.
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

// ---------------------------------------------------------------------------
// Coworld read-only CLI + replay download
// ---------------------------------------------------------------------------

async function coworldRead(
  args: string[],
  config: LoopConfig,
): Promise<unknown> {
  const verb = args[0];
  if (!COWORLD_READ_VERBS.has(verb)) {
    throw new Error(`refusing non-read coworld verb: ${verb}`);
  }
  const { stdout } = await execFileAsync(
    "uvx",
    ["coworld", ...args, "--json"],
    { timeout: config.coworldTimeoutMs, maxBuffer: 128 * MIB },
  );
  return JSON.parse(stdout) as unknown;
}

interface DivisionReplays {
  rows: LoopReplayRow[];
  rawById: Map<string, Record<string, unknown>>;
}

async function fetchDivisionReplays(
  config: LoopConfig,
): Promise<DivisionReplays> {
  // Over-fetch (limit 60) with bounded retry against the known replay-feed
  // pagination flake; a transient short page must not drop the target round.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = await coworldRead(
        ["replays", "-d", config.divisionId, "--limit", "60"],
        config,
      );
      const rows = parseLoopReplayRows(raw);
      const rawById = new Map<string, Record<string, unknown>>();
      for (const entry of asArray(raw)) {
        if (isRecord(entry) && typeof entry.id === "string") {
          rawById.set(entry.id, entry);
        }
      }
      return { rows, rawById };
    } catch (error) {
      lastError = error;
      log(`replay feed attempt ${attempt + 1} failed: ${errorMessage(error)}`);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("replay feed unavailable");
}

interface RawReplayFacts {
  runId: string;
  turnCount: number;
  seatCount: number;
  gameMap: string;
  gameMapSize: string;
  difficulty: string;
  coworldName: string;
}

async function downloadRawReplay(
  replayUrl: string,
  destinationPath: string,
  config: LoopConfig,
): Promise<void> {
  if (!replayUrl.startsWith("https://")) {
    throw new Error(`refusing non-https replay url: ${replayUrl}`);
  }
  const response = await fetch(replayUrl);
  if (!response.ok) {
    throw new Error(`replay download failed (${response.status})`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_REPLAY_BYTES) {
    throw new Error("replay download exceeds byte limit");
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, body);
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseRawReplayFacts(
  bytes: Buffer,
  coworldName: string,
): RawReplayFacts | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.runID !== "string") {
    return null;
  }
  const inline = value.inlineRunArtifacts;
  if (!isRecord(inline) || typeof inline["game-record.json"] !== "string") {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(inline["game-record.json"]);
  } catch {
    return null;
  }
  if (!isRecord(record) || !isRecord(record.info)) {
    return null;
  }
  const info = record.info;
  const config = isRecord(info.config) ? info.config : null;
  const players = Array.isArray(info.players) ? info.players : null;
  if (
    config === null ||
    players === null ||
    typeof info.num_turns !== "number" ||
    !Number.isFinite(info.num_turns)
  ) {
    return null;
  }
  return {
    runId: value.runID,
    turnCount: info.num_turns,
    seatCount: players.length,
    gameMap: String(config.gameMap),
    gameMapSize: String(config.gameMapSize),
    difficulty: String(config.difficulty),
    coworldName,
  };
}

// ---------------------------------------------------------------------------
// Retention pin manifest — this hold's own OWNER TAG within the shared,
// possibly multi-owner pin manifest (see CoworldLeagueArtifactRetention.ts's
// `addRetentionPinOwner`/`removeRetentionPinOwner` doc for why a bespoke
// read-modify-write here is exactly the bug that mechanism exists to
// prevent — a Featured Match's own retention claim on the SAME artifact
// must survive independently of this hold's own release, and vice versa).
// ---------------------------------------------------------------------------

const PREMIERE_PIN_REASON_PREFIX = "premiere-hold";

/** Exported (with tests/scripts/replay-premiere-loop-pins.test.ts) so the cross-writer ownership matrix against `FeaturedMatchRetentionPin.ts` exercises this REAL production code path, not a stand-in. */
export function premiereHoldOwnerTag(premiereId: string): string {
  return `${PREMIERE_PIN_REASON_PREFIX}:${premiereId}`;
}

/** Narrowed to exactly the fields this function reads — the internal call site still passes a full `LoopHoldState`/`LoopConfig` (structurally compatible), while a test can build a minimal fixture instead of the full, large hold/config shape. */
export async function pinHoldArtifacts(
  hold: Pick<LoopHoldState, "publicRunKey" | "episodeRequestId" | "premiereId">,
  config: Pick<LoopConfig, "pinManifestPath">,
): Promise<void> {
  if (!isManagedPublicRunKey(hold.publicRunKey)) {
    log(`skipping pin for unmanaged run key ${hold.publicRunKey}`);
    return;
  }
  const changed = await addRetentionPinOwner(config.pinManifestPath, {
    episodeRequestId: hold.episodeRequestId,
    publicRunKey: hold.publicRunKey,
    ownerTag: premiereHoldOwnerTag(hold.premiereId),
  });
  if (changed) {
    log(`pinned ${hold.publicRunKey} for premiere ${hold.premiereId}`);
  }
}

export async function unpinHoldArtifacts(
  hold: Pick<LoopHoldState, "publicRunKey" | "episodeRequestId" | "premiereId">,
  config: Pick<LoopConfig, "pinManifestPath">,
): Promise<void> {
  const changed = await removeRetentionPinOwner(config.pinManifestPath, {
    episodeRequestId: hold.episodeRequestId,
    ownerTag: premiereHoldOwnerTag(hold.premiereId),
  });
  if (changed) {
    log(`unpinned ${hold.publicRunKey}`);
  }
}

// ---------------------------------------------------------------------------
// Suppression contract read/write
// ---------------------------------------------------------------------------

async function writeContractForHold(
  hold: LoopHoldState,
  config: LoopConfig,
  now: Date,
): Promise<void> {
  await writePremiereSuppressionContract(
    config.contractPath,
    buildLoopSuppressionContract([hold], now),
  );
}

/**
 * The zero-hold STANDING contract. Its blanket `quarantineMs` defers every
 * freshly-completed episode until the loop has had its chance to decide, so
 * the loop wins the publish race before it claims or skips a round.
 *
 * The former `deleteContract` release path is gone; releasing a hold falls
 * back to this standing contract. The post-reveal cooldown marks intervening
 * rounds skipped, so they publish at quarantine expiry instead of becoming
 * back-to-back premieres. Fail-open is unchanged — a dead loop stops
 * refreshing `generatedAt` and the mirror ignores the contract after 15
 * minutes.
 */
async function writeStandingContract(
  config: LoopConfig,
  now: Date,
): Promise<void> {
  await writePremiereSuppressionContract(
    config.contractPath,
    buildLoopSuppressionContract([], now),
  );
}

// ---------------------------------------------------------------------------
// Loopback premiere state
// ---------------------------------------------------------------------------

async function readPremiereState(
  config: LoopConfig,
  premiereId: string,
): Promise<string | null> {
  const url = `${config.loopbackBaseUrl}/api/premieres/${encodeURIComponent(premiereId)}/manifest`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch {
    return null;
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  try {
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.state === "string" ? body.state : null;
  } catch {
    return null;
  }
}

const COORDINATION_NONTERMINAL_STATES = new Set([
  "draft",
  "scheduled",
  "playing",
  "checkpoint",
]);
const COORDINATION_TERMINAL_STATES = new Set([
  "revealed",
  "archived",
  "failed",
  "cancelled",
]);

export interface ForeignRegisteredPremiereGate {
  busyPremiereIds: readonly string[];
  receiptFingerprint: string;
}

export interface ForeignRegisteredPremiereGateDependencies {
  readSelection?: (
    privateStateRoot: string,
  ) => Promise<ReplayPremiereStartupSelectionReceiptV1>;
  readState?: (
    config: LoopConfig,
    premiereId: string,
  ) => Promise<string | null>;
  readArchivePointer?: typeof readReplayPremiereArchivePointer;
  readAdmission?: typeof readReplayPremiereAdmissionRecord;
}

async function foreignRegisteredPremiereGate(
  config: LoopConfig,
  dependencies: ForeignRegisteredPremiereGateDependencies = {},
): Promise<ForeignRegisteredPremiereGate> {
  const readSelection =
    dependencies.readSelection ?? readActiveReplayPremiereStartupSelection;
  const receipt = await readSelection(config.privateStateRoot);
  const receiptFingerprint = replayPremiereStartupSelectionFingerprint(receipt);
  const busy: string[] = [];
  const registeredIds = new Set(receipt.registeredPremiereIds);
  for (const entry of receipt.selected) {
    const premiereId = entry.premiereId;
    if (!registeredIds.has(premiereId)) {
      if (COORDINATION_TERMINAL_STATES.has(entry.projectionState)) continue;
      throw new Error(
        `coordination selected nonterminal premiere is unregistered: ${premiereId}`,
      );
    }
    const state = await (dependencies.readState ?? readPremiereStateStrict)(
      config,
      premiereId,
    );
    if (state === null) {
      const pointer = await (
        dependencies.readArchivePointer ?? readReplayPremiereArchivePointer
      )({
        privateStateRoot: config.privateStateRoot,
        premiereId,
      });
      if (pointer === null || pointer.premiereId !== premiereId) {
        throw new Error(
          `coordination manifest absent without archive proof for ${premiereId}`,
        );
      }
      const admission = await (
        dependencies.readAdmission ?? readReplayPremiereAdmissionRecord
      )({
        privateStateRoot: config.privateStateRoot,
        premiereId,
      });
      if (
        admission !== null &&
        (admission.recordHash !== entry.admissionRecordHash ||
          admission.eligibilityRecord.sourceKind !== pointer.sourceKind ||
          admission.eligibilityRecord.sourceRunId !== pointer.sourceRunId ||
          admission.stagedSource.sourceReplaySha256 !==
            pointer.sourceReplaySha256)
      ) {
        throw new Error(
          `coordination archive proof does not bind selected admission for ${premiereId}`,
        );
      }
      continue;
    }
    if (COORDINATION_TERMINAL_STATES.has(state)) continue;
    if (!COORDINATION_NONTERMINAL_STATES.has(state)) {
      throw new Error(`coordination manifest state invalid for ${premiereId}`);
    }
    busy.push(premiereId);
  }
  const afterProbe = await readSelection(config.privateStateRoot);
  if (
    replayPremiereStartupSelectionFingerprint(afterProbe) !== receiptFingerprint
  ) {
    throw new Error("coordination selection changed during manifest probes");
  }
  return { busyPremiereIds: busy, receiptFingerprint };
}

async function assertForeignPremiereGateUnchanged(
  config: LoopConfig,
  gate: ForeignRegisteredPremiereGate,
  readSelection: (
    privateStateRoot: string,
  ) => Promise<ReplayPremiereStartupSelectionReceiptV1> = readActiveReplayPremiereStartupSelection,
): Promise<void> {
  const current = await readSelection(config.privateStateRoot);
  if (
    replayPremiereStartupSelectionFingerprint(current) !==
    gate.receiptFingerprint
  ) {
    throw new Error("coordination selection changed before claim commit");
  }
}

/**
 * Strict loopback-only state probe for the claim exclusion gate. Unlike the
 * tracker probe above, transport/HTTP/schema failures are not collapsed into
 * 404: uncertainty must block a new claim, never authorize one.
 */
async function readPremiereStateStrict(
  config: LoopConfig,
  premiereId: string,
): Promise<string | null> {
  const url = `${config.loopbackBaseUrl}/api/premieres/${encodeURIComponent(premiereId)}/manifest`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `coordination manifest probe failed (${response.status}) for ${premiereId}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > MIB) {
    throw new Error(`coordination manifest size invalid for ${premiereId}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`coordination manifest JSON invalid for ${premiereId}`);
  }
  if (!isRecord(body) || typeof body.state !== "string") {
    throw new Error(`coordination manifest schema invalid for ${premiereId}`);
  }
  return body.state;
}

/**
 * Read-only probe of the deployment origin: has the mirror already published
 * this episode's public run-key bundle? A single HEAD to a run-key artifact
 * transfers no body (so this never re-triggers the over-ceiling large-artifact
 * fetch that this fix exists to avoid) and returns 200 only when the file is
 * already on the public origin. Fail-open: a null origin, an unmanaged run key,
 * a network error/timeout, a redirect, or any non-200 leaves the episode
 * claimable, so a transient blip never blocks a fresh premiere.
 */
async function isEpisodeAlreadyPublic(
  publicRunKey: string,
  config: LoopConfig,
): Promise<boolean> {
  if (
    config.deploymentOrigin === null ||
    !isManagedPublicRunKey(publicRunKey)
  ) {
    return false;
  }
  const probeUrl = `${config.deploymentOrigin}/ai-league-runs/${encodeURIComponent(
    publicRunKey,
  )}/spectator.html`;
  try {
    const response = await fetch(probeUrl, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-process ingest + admit
// ---------------------------------------------------------------------------

export interface IngestMaterials {
  rawRow: Record<string, unknown>;
  rawReplayPath: string;
  facts: RawReplayFacts;
  divisionFile: string;
}

export interface RetainedAdmissionTransaction {
  premiereId: string;
  episodeRequestId: string;
  bundleSha256: string;
  createdAt: string;
  rawReplayPath: string;
  divisionFile: string;
  episodeFile: string;
  sourceFile: string;
  eligibilityFile: string;
  definitionFile: string;
  nonceFile: string;
  markerPath: string;
}

export interface AdmittedResult {
  kind: "admitted";
  bundleSha256: string;
  /** Cleanup is deferred until the admitted phase is durably journaled. */
  retainedTransaction?: RetainedAdmissionTransaction;
}

export interface ReleaseResult {
  kind: "release";
  outcome: LoopReleaseOutcome;
  terminal: boolean;
}

export interface AdmissionHoldResult {
  kind: "hold";
  reason: "admission_state_uncertain";
}

async function ingestAndAdmit(
  hold: LoopHoldState,
  materials: IngestMaterials,
  config: LoopConfig,
): Promise<AdmittedResult | ReleaseResult | AdmissionHoldResult> {
  if (config.deploymentOrigin === null) {
    log("no PROXYWAR_PUBLIC_URL deployment origin configured; releasing hold");
    return { kind: "release", outcome: "admit_failed", terminal: false };
  }
  // Build the episode file with a game_config synthesized from the raw replay:
  // Coworld `replays` rows no longer carry game_config (verified 2026-07-22),
  // but the ingest cross-checks it against the replay. Every field comes from
  // the same authenticated replay the ingest re-verifies.
  const episodeRow = {
    ...materials.rawRow,
    game_config: {
      map: materials.facts.gameMap,
      map_size: materials.facts.gameMapSize,
      difficulty: materials.facts.difficulty,
      num_agents: materials.facts.seatCount,
    },
  };
  const episodeFile = path.join(
    config.ingestScratchDir,
    `${hold.premiereId}-${randomUUID()}.episode.json`,
  );
  const outFile = path.join(
    config.ingestScratchDir,
    `${hold.premiereId}-${randomUUID()}.source.json`,
  );
  await fs.mkdir(config.ingestScratchDir, { recursive: true });
  await fs.writeFile(episodeFile, `${JSON.stringify([episodeRow])}\n`, "utf8");

  let bundleSha256: string;
  try {
    const summary = await runReplayPremiereCoworldIngest([
      `--replay-file=${materials.rawReplayPath}`,
      `--episode-file=${episodeFile}`,
      `--episode-request-id=${hold.episodeRequestId}`,
      `--division-file=${materials.divisionFile}`,
      `--division-id=${config.divisionId}`,
      `--out-file=${outFile}`,
      `--turn-interval-ms=${config.turnIntervalMs}`,
    ]);
    bundleSha256 = summary.bundleSha256;
  } catch (error) {
    await Promise.all(
      [
        episodeFile,
        outFile,
        materials.rawReplayPath,
        materials.divisionFile,
      ].map((filePath) =>
        fs.rm(filePath, { force: true }).catch(() => undefined),
      ),
    );
    log(`ingest failed for ${hold.premiereId}: ${operatorCodeOf(error)}`);
    return { kind: "release", outcome: "ingest_failed", terminal: false };
  }

  const definition = buildLoopPremiereDefinition({
    episodeRequestId: hold.episodeRequestId,
    coworldName: materials.facts.coworldName,
    mapLabel: hold.mapLabel,
    variantName: hold.variantName,
    seatCount: hold.seatCount,
    turnCount: hold.turnCount,
    scheduledAt: hold.scheduledAt,
  });
  const eligibilityFile = path.join(
    config.ingestScratchDir,
    `${hold.premiereId}-${randomUUID()}.eligibility.json`,
  );
  const definitionFile = path.join(
    config.ingestScratchDir,
    `${hold.premiereId}-${randomUUID()}.definition.json`,
  );
  await fs.writeFile(
    eligibilityFile,
    `${JSON.stringify(buildLoopEligibilityInput())}\n`,
    "utf8",
  );
  await fs.writeFile(definitionFile, `${JSON.stringify(definition)}\n`, "utf8");
  const nonceFile = await createNonceFile(config);
  const retainedTransaction = buildRetainedAdmissionTransaction({
    hold,
    bundleSha256,
    config,
    materials,
    episodeFile,
    sourceFile: outFile,
    eligibilityFile,
    definitionFile,
    nonceFile,
  });

  let admissionResult:
    | AdmittedResult
    | ReleaseResult
    | AdmissionHoldResult
    | null = null;
  let markerPersisted = false;
  try {
    await persistRetainedAdmissionTransaction(retainedTransaction, config);
    markerPersisted = true;
    admissionResult = await runLoopReplayPremiereAdmission({
      args: retainedAdmissionArgs(retainedTransaction, config),
      premiereId: hold.premiereId,
      bundleSha256,
      environment: process.env,
    });
    return admissionResult.kind === "admitted"
      ? { ...admissionResult, retainedTransaction }
      : admissionResult;
  } finally {
    if (
      markerPersisted &&
      (admissionResult?.kind === "hold" || admissionResult?.kind === "admitted")
    ) {
      log(
        `retaining admission transaction for ${hold.premiereId} until reconciliation is journaled`,
      );
    } else {
      await cleanupRetainedAdmissionTransaction(retainedTransaction);
    }
  }
}

const RETAINED_ADMISSION_SCHEMA_VERSION = 1;
const MAX_RETAINED_ADMISSION_MARKER_BYTES = 16 * 1024;

interface RetainedAdmissionMarkerV1 {
  schemaVersion: 1;
  premiereId: string;
  episodeRequestId: string;
  bundleSha256: string;
  createdAt: string;
  files: {
    rawReplay: string;
    division: string;
    episode: string;
    source: string;
    eligibility: string;
    definition: string;
    nonce: string;
  };
}

function retainedAdmissionMarkerPath(
  config: LoopConfig,
  premiereId: string,
): string {
  return path.join(
    config.ingestScratchDir,
    `${premiereId}.retained-admission.json`,
  );
}

function buildRetainedAdmissionTransaction(options: {
  hold: LoopHoldState;
  bundleSha256: string;
  config: LoopConfig;
  materials: IngestMaterials;
  episodeFile: string;
  sourceFile: string;
  eligibilityFile: string;
  definitionFile: string;
  nonceFile: string;
}): RetainedAdmissionTransaction {
  return {
    premiereId: options.hold.premiereId,
    episodeRequestId: options.hold.episodeRequestId,
    bundleSha256: options.bundleSha256,
    createdAt: new Date().toISOString(),
    rawReplayPath: managedScratchPath(
      options.config.ingestScratchDir,
      options.materials.rawReplayPath,
    ),
    divisionFile: managedScratchPath(
      options.config.ingestScratchDir,
      options.materials.divisionFile,
    ),
    episodeFile: managedScratchPath(
      options.config.ingestScratchDir,
      options.episodeFile,
    ),
    sourceFile: managedScratchPath(
      options.config.ingestScratchDir,
      options.sourceFile,
    ),
    eligibilityFile: managedScratchPath(
      options.config.ingestScratchDir,
      options.eligibilityFile,
    ),
    definitionFile: managedScratchPath(
      options.config.ingestScratchDir,
      options.definitionFile,
    ),
    nonceFile: managedScratchPath(options.config.nonceDir, options.nonceFile),
    markerPath: retainedAdmissionMarkerPath(
      options.config,
      options.hold.premiereId,
    ),
  };
}

export async function persistRetainedAdmissionTransaction(
  transaction: RetainedAdmissionTransaction,
  config: LoopConfig,
): Promise<void> {
  const marker = retainedAdmissionMarker(transaction, config);
  const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, "utf8");
  if (bytes.byteLength > MAX_RETAINED_ADMISSION_MARKER_BYTES) {
    throw new Error("retained admission marker exceeds byte limit");
  }
  await fs.mkdir(config.ingestScratchDir, { recursive: true });
  const temporary = `${transaction.markerPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, transaction.markerPath);
    await syncLoopDirectory(config.ingestScratchDir);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadRetainedAdmissionTransaction(
  hold: LoopHoldState,
  config: LoopConfig,
): Promise<RetainedAdmissionTransaction | null> {
  const markerPath = retainedAdmissionMarkerPath(config, hold.premiereId);
  let stat;
  try {
    stat = await fs.lstat(markerPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size <= 0 ||
    stat.size > MAX_RETAINED_ADMISSION_MARKER_BYTES
  ) {
    throw new Error("retained admission marker file is unsafe");
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error("retained admission marker is invalid JSON");
  }
  const marker = parseRetainedAdmissionMarker(value, hold);
  return {
    premiereId: marker.premiereId,
    episodeRequestId: marker.episodeRequestId,
    bundleSha256: marker.bundleSha256,
    createdAt: marker.createdAt,
    rawReplayPath: path.join(config.ingestScratchDir, marker.files.rawReplay),
    divisionFile: path.join(config.ingestScratchDir, marker.files.division),
    episodeFile: path.join(config.ingestScratchDir, marker.files.episode),
    sourceFile: path.join(config.ingestScratchDir, marker.files.source),
    eligibilityFile: path.join(
      config.ingestScratchDir,
      marker.files.eligibility,
    ),
    definitionFile: path.join(config.ingestScratchDir, marker.files.definition),
    nonceFile: path.join(config.nonceDir, marker.files.nonce),
    markerPath,
  };
}

async function retainedAdmissionMarkerMayExist(
  hold: LoopHoldState,
  config: LoopConfig,
): Promise<boolean> {
  try {
    await fs.lstat(retainedAdmissionMarkerPath(config, hold.premiereId));
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    // Stat uncertainty is itself hold-preserving. The stricter parser in
    // progressHold reports/blocks the target after the suppression heartbeat.
    return true;
  }
}

async function cleanupRetainedAdmissionTransaction(
  transaction: RetainedAdmissionTransaction,
): Promise<void> {
  const files = new Set([
    transaction.rawReplayPath,
    transaction.divisionFile,
    transaction.episodeFile,
    transaction.sourceFile,
    transaction.eligibilityFile,
    transaction.definitionFile,
    transaction.nonceFile,
    transaction.markerPath,
  ]);
  for (const filePath of files) {
    await fs.rm(filePath, { force: true });
  }
  await Promise.all([
    syncLoopDirectory(path.dirname(transaction.markerPath)),
    syncLoopDirectory(path.dirname(transaction.nonceFile)),
  ]);
}

function retainedAdmissionArgs(
  transaction: RetainedAdmissionTransaction,
  config: LoopConfig,
): string[] {
  if (config.deploymentOrigin === null) {
    throw new Error("retained admission requires deployment origin");
  }
  return [
    `--premiere-id=${transaction.premiereId}`,
    `--source-file=${transaction.sourceFile}`,
    `--expected-source-sha256=${transaction.bundleSha256}`,
    `--private-state-root=${config.privateStateRoot}`,
    ...config.servedRoots.map((root) => `--served-root=${root}`),
    `--eligibility-file=${transaction.eligibilityFile}`,
    `--definition-file=${transaction.definitionFile}`,
    `--deployment-origin=${config.deploymentOrigin}`,
    `--nonce-file=${transaction.nonceFile}`,
  ];
}

function retainedAdmissionMarker(
  transaction: RetainedAdmissionTransaction,
  config: LoopConfig,
): RetainedAdmissionMarkerV1 {
  return {
    schemaVersion: RETAINED_ADMISSION_SCHEMA_VERSION,
    premiereId: transaction.premiereId,
    episodeRequestId: transaction.episodeRequestId,
    bundleSha256: transaction.bundleSha256,
    createdAt: transaction.createdAt,
    files: {
      rawReplay: managedScratchBasename(
        config.ingestScratchDir,
        transaction.rawReplayPath,
      ),
      division: managedScratchBasename(
        config.ingestScratchDir,
        transaction.divisionFile,
      ),
      episode: managedScratchBasename(
        config.ingestScratchDir,
        transaction.episodeFile,
      ),
      source: managedScratchBasename(
        config.ingestScratchDir,
        transaction.sourceFile,
      ),
      eligibility: managedScratchBasename(
        config.ingestScratchDir,
        transaction.eligibilityFile,
      ),
      definition: managedScratchBasename(
        config.ingestScratchDir,
        transaction.definitionFile,
      ),
      nonce: managedScratchBasename(config.nonceDir, transaction.nonceFile),
    },
  };
}

function parseRetainedAdmissionMarker(
  value: unknown,
  hold: LoopHoldState,
): RetainedAdmissionMarkerV1 {
  if (!isRecord(value)) throw new Error("retained admission marker invalid");
  assertExactObjectKeys(value, [
    "schemaVersion",
    "premiereId",
    "episodeRequestId",
    "bundleSha256",
    "createdAt",
    "files",
  ]);
  if (!isRecord(value.files)) {
    throw new Error("retained admission marker files invalid");
  }
  assertExactObjectKeys(value.files, [
    "rawReplay",
    "division",
    "episode",
    "source",
    "eligibility",
    "definition",
    "nonce",
  ]);
  if (
    value.schemaVersion !== RETAINED_ADMISSION_SCHEMA_VERSION ||
    value.premiereId !== hold.premiereId ||
    value.episodeRequestId !== hold.episodeRequestId ||
    typeof value.bundleSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.bundleSha256) ||
    typeof value.createdAt !== "string" ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error("retained admission marker identity invalid");
  }
  for (const fileName of Object.values(value.files)) {
    if (typeof fileName !== "string" || !isSafeScratchBasename(fileName)) {
      throw new Error("retained admission marker path invalid");
    }
  }
  return value as unknown as RetainedAdmissionMarkerV1;
}

function managedScratchPath(root: string, filePath: string): string {
  managedScratchBasename(root, filePath);
  return path.resolve(filePath);
}

function managedScratchBasename(root: string, filePath: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!isSafeScratchBasename(relative)) {
    throw new Error("retained admission file is outside its managed root");
  }
  return relative;
}

function isSafeScratchBasename(value: string): boolean {
  return (
    value === path.basename(value) &&
    /^[A-Za-z0-9._-]{1,255}$/.test(value) &&
    !value.startsWith(".")
  );
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    throw new Error("retained admission marker keys invalid");
  }
}

async function syncLoopDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type ReplayPremiereAdmissionRunner = typeof runReplayPremiereAdmission;

/**
 * Run the catalog admission with a real wall-clock projection fence. The
 * timeout begins before admission validation/audit, so a slow prelude cannot
 * consume the whole safety window and then start an unfenced projection.
 */
export async function runLoopReplayPremiereAdmission(options: {
  args: string[];
  premiereId: string;
  bundleSha256: string;
  environment: NodeJS.ProcessEnv;
  projectionTimeoutMs?: number;
  runAdmission?: ReplayPremiereAdmissionRunner;
}): Promise<AdmittedResult | ReleaseResult | AdmissionHoldResult> {
  const projectionTimeoutMs =
    options.projectionTimeoutMs ??
    PREMIERE_LOOP_ADMISSION_PROJECTION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(projectionTimeoutMs) ||
    projectionTimeoutMs < 1 ||
    projectionTimeoutMs > PREMIERE_LOOP_ADMISSION_PROJECTION_TIMEOUT_MS
  ) {
    throw new Error("invalid premiere admission projection timeout");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), projectionTimeoutMs);
  timeout.unref?.();
  try {
    await (options.runAdmission ?? runReplayPremiereAdmission)(options.args, {
      environment: options.environment,
      checkpointProjectionSignal: controller.signal,
    });
    log(`admitted premiere ${options.premiereId}`);
    return { kind: "admitted", bundleSha256: options.bundleSha256 };
  } catch (error) {
    if (isAdmissionHoldRequired(error)) {
      log(
        `admission state requires hold for ${options.premiereId}: ${operatorCodeOf(error)}`,
      );
      return { kind: "hold", reason: "admission_state_uncertain" };
    }
    if (isIneligible(error)) {
      // Fail-closed for sealing, fail-open for availability: the leak audit or
      // eligibility gate refused, so let the episode publish ordinarily.
      log(
        `admission ineligible for ${options.premiereId}: ${operatorCodeOf(error)}`,
      );
      return { kind: "release", outcome: "leak_audit_refused", terminal: true };
    }
    log(
      `admission failed for ${options.premiereId}: ${admissionFailureOperatorCodeOf(error)} cause=${formatReplayPremiereErrorCauseChain(error)}`,
    );
    return { kind: "release", outcome: "admit_failed", terminal: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function reconcileRetainedAdmissionTransaction(
  hold: LoopHoldState,
  transaction: RetainedAdmissionTransaction,
  config: LoopConfig,
): Promise<AdmittedResult | AdmissionHoldResult> {
  if (config.deploymentOrigin === null) {
    return { kind: "hold", reason: "admission_state_uncertain" };
  }
  const result = await runLoopReplayPremiereAdmission({
    args: retainedAdmissionArgs(transaction, config),
    premiereId: hold.premiereId,
    bundleSha256: transaction.bundleSha256,
    environment: process.env,
  });
  if (result.kind === "admitted") {
    return { ...result, retainedTransaction: transaction };
  }
  log(
    `retained admission ${hold.premiereId} remains unresolved (${result.kind === "hold" ? result.reason : result.outcome})`,
  );
  return { kind: "hold", reason: "admission_state_uncertain" };
}

async function cleanupUncommittedMaterials(
  materials: IngestMaterials,
): Promise<void> {
  await Promise.all(
    [materials.rawReplayPath, materials.divisionFile].map((filePath) =>
      fs.rm(filePath, { force: true }).catch(() => undefined),
    ),
  );
}

async function createNonceFile(config: LoopConfig): Promise<string> {
  await fs.mkdir(config.nonceDir, { recursive: true, mode: 0o700 });
  const noncePath = path.join(config.nonceDir, `${randomUUID()}.bin`);
  const handle = await fs.open(
    noncePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(randomBytes(32));
  } finally {
    await handle.close();
  }
  return noncePath;
}

// ---------------------------------------------------------------------------
// Controlled activation (reviewed restart helper)
// ---------------------------------------------------------------------------

export type ActivateResult =
  | { kind: "activated"; hold: LoopHoldState }
  | { kind: "retry"; hold: LoopHoldState }
  | { kind: "released" };

async function activateHold(
  hold: LoopHoldState,
  config: LoopConfig,
  journal: JournalWriter,
  now: Date,
  restart: () => Promise<boolean> = () => fireRestartHelper(config),
  persistRetirement: typeof persistReplayPremiereTerminalTombstone = persistReplayPremiereTerminalTombstone,
): Promise<ActivateResult> {
  const liveState = await readPremiereState(config, hold.premiereId);
  if (liveState !== null) {
    // Already registered (a prior restart, or an external one, took effect). Do
    // not interrupt a live premiere; move straight to tracking.
    const activated = {
      ...hold,
      phase: "activated" as const,
      activatedAt: now.toISOString(),
    };
    await journal.appendHoldUpdate(activated);
    return { kind: "activated", hold: activated };
  }
  // Helper-refusal backoff (2026-07-22 round-649 outage): while a refusal
  // window is armed, do NOT re-fire the restart — a crash-looping beta must
  // not be re-killed every 60s tick. The contract stays fresh; the attempt
  // ceiling below still bounds the total.
  if (isActivationBackoffActive(hold, now)) {
    log(
      `activation for ${hold.premiereId} backing off until ${hold.activationBackoffUntil ?? "?"}`,
    );
    await writeContractForHold(hold, config, now);
    return { kind: "retry", hold };
  }
  // Fire the reviewed helper. It runs its own readiness preflight and we never
  // pass --allow-unready-current. On non-launchd hosts it exits non-zero, which
  // is treated as a retriable activation failure (fail-open on availability).
  const restarted = await restart();
  if (restarted) {
    log(`activated premiere ${hold.premiereId} via controlled restart`);
    // `activatedAt` starts the bounded registration verification window; the
    // tracker below only trusts an activation it can observe.
    const activated = {
      ...hold,
      phase: "activated" as const,
      activatedAt: now.toISOString(),
    };
    await journal.appendHoldUpdate(activated);
    return { kind: "activated", hold: activated };
  }
  const attempts = hold.activationAttempts + 1;
  if (attempts >= PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS) {
    log(
      `activation refused ${PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS}x for ${hold.premiereId}; releasing`,
    );
    await releaseHold(
      { ...hold, activationAttempts: attempts },
      "activation_refused",
      true,
      config,
      journal,
      now,
      persistRetirement,
    );
    return { kind: "released" };
  }
  const retried = {
    ...hold,
    activationAttempts: attempts,
    activationBackoffUntil: new Date(
      now.getTime() + PREMIERE_LOOP_ACTIVATION_BACKOFF_MS,
    ).toISOString(),
  };
  await journal.appendHoldUpdate(retried);
  // Keep the contract fresh across ticks while activation backs off.
  await writeContractForHold(retried, config, now);
  log(
    `activation refused for ${hold.premiereId} (attempt ${attempts}); backing off until ${retried.activationBackoffUntil}`,
  );
  return { kind: "retry", hold: retried };
}

async function fireRestartHelper(config: LoopConfig): Promise<boolean> {
  try {
    await execFileAsync(
      config.nodeBin,
      [config.restartHelperPath, `--ready-url=${config.restartReadyUrl}`],
      { timeout: 90_000, maxBuffer: 4 * MIB },
    );
    return true;
  } catch (error) {
    log(`restart helper refused: ${errorMessage(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Track + release
// ---------------------------------------------------------------------------

async function trackHold(
  hold: LoopHoldState,
  config: LoopConfig,
  journal: JournalWriter,
  now: Date,
  restart: () => Promise<boolean> = () => fireRestartHelper(config),
  persistRetirement: typeof persistReplayPremiereTerminalTombstone = persistReplayPremiereTerminalTombstone,
): Promise<void> {
  const state = await readPremiereState(config, hold.premiereId);
  if (state === "revealed" || state === "archived") {
    await releaseHold(
      hold,
      "revealed",
      true,
      config,
      journal,
      now,
      persistRetirement,
    );
    return;
  }
  if (state === "failed" || state === "cancelled") {
    await releaseHold(
      hold,
      "failed_or_cancelled",
      true,
      config,
      journal,
      now,
      persistRetirement,
    );
    return;
  }
  if (
    (state === "scheduled" || state === "playing" || state === "checkpoint") &&
    !hold.premierePageLive
  ) {
    const live = { ...hold, premierePageLive: true, phase: "live" as const };
    await journal.appendHoldUpdate(live);
    await writeContractForHold(live, config, now);
    log(`premiere ${hold.premiereId} is live (${state}); league card flipped`);
    return;
  }

  // Post-activation registration verification (2026-07-22 round-644 activation
  // zombie): new admissions carry the bounded precomputed projection artifact,
  // but a successful controlled restart still does not prove the route was
  // registered. A legacy/corrupt artifact or another startup refusal can leave
  // the page 404. The hold gets a bounded window, then exactly one
  // re-activation, then an immediate terminal `activation_lost` release. Every
  // transition is journaled; the hard holdExpiresAt valve is never extended.
  const verification = decideActivationVerification(hold, state, now);
  if (verification.kind === "start_window") {
    const stamped = { ...hold, activatedAt: now.toISOString() };
    await journal.appendHoldUpdate(stamped);
    await writeContractForHold(stamped, config, now);
    log(
      `premiere ${hold.premiereId} not registered after activation; verification window started`,
    );
    return;
  }
  if (verification.kind === "wait") {
    await writeContractForHold(hold, config, now);
    log(`premiere ${hold.premiereId} awaiting registration (verify window)`);
    return;
  }
  if (verification.kind === "reactivate") {
    const attempted = {
      ...hold,
      reactivationAttempts: hold.reactivationAttempts + 1,
    };
    if (await restart()) {
      const reactivated = { ...attempted, activatedAt: now.toISOString() };
      await journal.appendHoldUpdate(reactivated);
      await writeContractForHold(reactivated, config, now);
      log(
        `re-activated premiere ${hold.premiereId} via controlled restart (registration verify failed)`,
      );
      return;
    }
    // The single retry could not even restart the server; release immediately
    // rather than holding the card for a premiere that cannot register.
    log(`re-activation refused for ${hold.premiereId}; releasing`);
    await releaseHold(
      attempted,
      "activation_lost",
      true,
      config,
      journal,
      now,
      persistRetirement,
    );
    return;
  }
  if (verification.kind === "activation_lost") {
    log(
      `premiere ${hold.premiereId} never registered after re-activation; releasing`,
    );
    await releaseHold(
      hold,
      "activation_lost",
      true,
      config,
      journal,
      now,
      persistRetirement,
    );
    return;
  }

  // Still scheduled/playing and already live, or registered and waiting: keep
  // the contract fresh (requirement #1) and wait for the next tick.
  await writeContractForHold(hold, config, now);
}

async function releaseHold(
  hold: LoopHoldState,
  outcome: LoopReleaseOutcome,
  terminal: boolean,
  config: LoopConfig,
  journal: JournalWriter,
  now: Date,
  persistRetirement: typeof persistReplayPremiereTerminalTombstone = persistReplayPremiereTerminalTombstone,
): Promise<void> {
  // Once an admission exists, a terminal loop release must retire that exact
  // immutable admission before suppression or retention is relaxed. Without
  // this private tombstone, a later server startup can select its surviving
  // draft/scheduled projection and resurrect a release the loop already made
  // terminal. Tombstone failure deliberately aborts here, preserving the
  // active contract, pin, and journal hold for a bounded retry.
  const retired = await persistRetirement({
    privateStateRoot: config.privateStateRoot,
    episodeRequestId: hold.episodeRequestId,
    premiereId: hold.premiereId,
    roundId: hold.roundId,
    phase: hold.phase,
    outcome,
    terminal,
    releasedAt: now.toISOString(),
  });
  const releasedAt = retired?.releasedAt ?? now.toISOString();
  // Latest-premiere pointer: ONLY a `revealed` release rewrites it, so the
  // league mirror's between-premieres card always names the most recent
  // premiere whose outcome is already public. Every other outcome (expired,
  // failed_or_cancelled, activation_*, ingest/admit failures, …) leaves the
  // previous pointer untouched. releaseHold is reachable only from the live
  // iteration (shadow asserts a plan with writeLatestPremierePointer=false and
  // never holds), so shadow mode can never write it.
  if (outcome === "revealed") {
    await recordLatestRevealedPremiere(hold, config, now);
  }
  // ONLY-LATEST: this is the sole hold, so removing it leaves the zero-hold
  // STANDING contract (2026-07-22 operator reversal of requirement #4 — the
  // release path used to DELETE the contract here). The released episode
  // publishes once its own blanket quarantine window (completedAt +
  // quarantineMs) expires — immediately on the next mirror cycle if it is
  // already older than that — while every other fresh episode stays deferred
  // so the loop keeps winning the publish race for the next round.
  await writeStandingContract(config, now);
  await unpinHoldArtifacts(hold, config);
  await journal.appendHoldReleased(hold, outcome, terminal, releasedAt);
  log(
    `released ${hold.premiereId} (${outcome}); episode publishes at quarantine expiry`,
  );
}

/**
 * Persist the reveal-public pointer (atomic temp+rename, same pattern as the
 * suppression contract) that the league mirror renders as the compact "Latest
 * premiere" card between live premieres. All fields are already public
 * post-reveal: roundNumber/mapLabel were on the live league card, revealedAt
 * is when the public reveal happened. Best-effort by design — losing the
 * pointer only costs the league page its latest-premiere card, so a write
 * failure must never fail the release itself (the release un-suppresses the
 * feed and must always complete).
 */
async function recordLatestRevealedPremiere(
  hold: LoopHoldState,
  config: LoopConfig,
  now: Date,
): Promise<void> {
  try {
    await writeLatestPremierePointer(config.latestPremierePointerPath, {
      schemaVersion: LATEST_PREMIERE_POINTER_SCHEMA_VERSION,
      premiereId: hold.premiereId,
      roundNumber: hold.roundNumber,
      mapLabel: hold.mapLabel,
      revealedAt: now.toISOString(),
    });
    log(`latest-premiere pointer -> ${hold.premiereId}`);
  } catch (error) {
    log(
      `latest-premiere pointer write failed (non-fatal): ${errorMessage(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Hold progression (claim -> admit -> activate -> track)
// ---------------------------------------------------------------------------

export interface ProgressHoldDependencies {
  ingestAndAdmit?: typeof ingestAndAdmit;
  loadRetainedAdmission?: typeof loadRetainedAdmissionTransaction;
  reconcileRetainedAdmission?: typeof reconcileRetainedAdmissionTransaction;
  hasStorageFloor?: typeof hasStorageFloor;
  activateHold?: typeof activateHold;
  trackHold?: typeof trackHold;
  persistRetirement?: typeof persistReplayPremiereTerminalTombstone;
  /** Refreshes timestamps after the potentially long admission projection. */
  now?: () => Date;
}

export async function progressHold(
  hold: LoopHoldState,
  initialMaterials: IngestMaterials | null,
  config: LoopConfig,
  journal: JournalWriter,
  now: Date,
  dependencies: ProgressHoldDependencies = {},
): Promise<void> {
  // Refresh generatedAt every cycle (requirement #1), regardless of phase.
  await writeContractForHold(hold, config, now);
  const loadRetained =
    dependencies.loadRetainedAdmission ?? loadRetainedAdmissionTransaction;
  const persistRetirement =
    dependencies.persistRetirement ?? persistReplayPremiereTerminalTombstone;
  const claimedTransaction =
    hold.phase === "claimed" ? await loadRetained(hold, config) : null;
  if (isHoldExpired(hold, now)) {
    if (claimedTransaction !== null) {
      await preserveUncertainAdmissionHold(hold, config, journal, now);
      return;
    }
    await releaseHold(
      hold,
      "expired",
      true,
      config,
      journal,
      now,
      persistRetirement,
    );
    return;
  }

  let current = hold;
  let operationNow = now;
  if (current.phase !== "claimed") {
    const completedTransaction = await loadRetained(current, config);
    if (completedTransaction !== null) {
      await cleanupRetainedAdmissionTransaction(completedTransaction);
    }
  }
  if (current.phase === "claimed") {
    const retainedTransaction = claimedTransaction;
    const storageAvailable = await (
      dependencies.hasStorageFloor ?? hasStorageFloor
    )(config);
    if (!storageAvailable) {
      if (retainedTransaction === null && initialMaterials !== null) {
        await cleanupUncommittedMaterials(initialMaterials);
      }
      log(
        `below storage floor while ${current.premiereId} is claimed; preserving hold without new scratch`,
      );
      if (retainedTransaction !== null) {
        await preserveUncertainAdmissionHold(
          current,
          config,
          journal,
          operationNow,
        );
      }
      return;
    }
    let result: AdmittedResult | ReleaseResult | AdmissionHoldResult;
    if (retainedTransaction !== null) {
      result = await (
        dependencies.reconcileRetainedAdmission ??
        reconcileRetainedAdmissionTransaction
      )(current, retainedTransaction, config);
    } else {
      const materials =
        initialMaterials ?? (await loadResumeMaterials(current, config));
      if (materials === null) {
        // Cannot reconstruct ingest inputs (episode aged out of the feed);
        // count a retriable attempt and let it publish only when no uncertain
        // retained admission transaction exists.
        await releaseHold(
          current,
          "ingest_failed",
          false,
          config,
          journal,
          dependencies.now?.() ?? new Date(),
          persistRetirement,
        );
        return;
      }
      result = await (dependencies.ingestAndAdmit ?? ingestAndAdmit)(
        current,
        materials,
        config,
      );
    }
    // Admission may consume most of its 90-second projection budget. Never
    // stamp the release heartbeat or activation window with the tick's stale
    // pre-admission clock.
    operationNow = dependencies.now?.() ?? new Date();
    if (result.kind === "release") {
      await releaseHold(
        current,
        result.outcome,
        result.terminal,
        config,
        journal,
        operationNow,
        persistRetirement,
      );
      return;
    }
    if (result.kind === "hold") {
      // The admission may already be sealed. Preserve suppression, pins, and
      // scratch evidence until the catalog state is reconciled; never publish
      // the Coworld episode through the ordinary fail-open release path.
      await preserveUncertainAdmissionHold(
        current,
        config,
        journal,
        operationNow,
      );
      return;
    }
    current = { ...current, phase: "admitted" };
    await journal.appendHoldUpdate(current);
    if (result.retainedTransaction !== undefined) {
      await cleanupRetainedAdmissionTransaction(result.retainedTransaction);
    }
  }

  if (current.phase === "admitted") {
    const activation = await (dependencies.activateHold ?? activateHold)(
      current,
      config,
      journal,
      operationNow,
      undefined,
      persistRetirement,
    );
    if (activation.kind === "released") {
      return;
    }
    if (activation.kind === "retry") {
      return;
    }
    current = activation.hold;
  }

  // activated | live
  await (dependencies.trackHold ?? trackHold)(
    current,
    config,
    journal,
    operationNow,
    undefined,
    persistRetirement,
  );
}

async function preserveUncertainAdmissionHold(
  hold: LoopHoldState,
  config: LoopConfig,
  journal: JournalWriter,
  now: Date,
): Promise<LoopHoldState> {
  const preserved = {
    ...hold,
    holdExpiresAt: new Date(
      Math.max(
        Date.parse(hold.holdExpiresAt),
        now.getTime() + PREMIERE_LOOP_HOLD_WINDOW_MS,
      ),
    ).toISOString(),
  };
  await journal.appendHoldUpdate(preserved);
  await writeContractForHold(preserved, config, now);
  return preserved;
}

async function loadResumeMaterials(
  hold: LoopHoldState,
  config: LoopConfig,
): Promise<IngestMaterials | null> {
  const replays = await fetchDivisionReplays(config);
  const rawRow = replays.rawById.get(hold.episodeRequestId);
  if (rawRow === undefined) {
    return null;
  }
  const rawReplayPath = path.join(
    config.ingestScratchDir,
    `${hold.episodeRequestId}-${randomUUID()}.replay`,
  );
  await downloadRawReplay(hold.replayUrl, rawReplayPath, config);
  const facts = parseRawReplayFacts(
    await fs.readFile(rawReplayPath),
    typeof rawRow.coworld_name === "string" ? rawRow.coworld_name : "proxywar",
  );
  if (facts === null) {
    await fs.rm(rawReplayPath, { force: true }).catch(() => undefined);
    return null;
  }
  const divisionFile = await stageDivisionFile(config);
  return { rawRow, rawReplayPath, facts, divisionFile };
}

async function stageDivisionFile(config: LoopConfig): Promise<string> {
  const raw = await coworldRead(["divisions", "-l", config.leagueId], config);
  const divisionFile = path.join(
    config.ingestScratchDir,
    `divisions-${randomUUID()}.json`,
  );
  await fs.mkdir(config.ingestScratchDir, { recursive: true });
  await fs.writeFile(divisionFile, `${JSON.stringify(raw)}\n`, "utf8");
  return divisionFile;
}

// ---------------------------------------------------------------------------
// Claim (select the freshest budgeted episode of a fresh round)
// ---------------------------------------------------------------------------

async function claimRound(
  round: LoopRound,
  config: LoopConfig,
  journal: JournalWriter,
  now: Date,
): Promise<void> {
  const replays = await fetchDivisionReplays(config);
  const candidates = orderEpisodesForClaim(round, replays.rows);
  if (candidates.length === 0) {
    await journal.appendRoundSkipped(
      { id: round.id, roundNumber: round.roundNumber },
      "no_eligible_episode",
    );
    return;
  }

  let selected: {
    row: LoopReplayRow;
    rawRow: Record<string, unknown>;
    rawReplayPath: string;
    facts: RawReplayFacts;
  } | null = null;
  const attempted: string[] = [];
  for (const candidate of candidates.slice(
    0,
    PREMIERE_LOOP_MAX_REPLAY_DOWNLOADS,
  )) {
    if (!(await hasStorageFloor(config))) {
      log("storage floor reached mid-selection; stopping downloads");
      break;
    }
    const rawRow = replays.rawById.get(candidate.episodeRequestId);
    if (rawRow === undefined || candidate.replayUrl === null) {
      continue;
    }
    const rawReplayPath = path.join(
      config.ingestScratchDir,
      `${candidate.episodeRequestId}-${randomUUID()}.replay`,
    );
    try {
      await downloadRawReplay(candidate.replayUrl, rawReplayPath, config);
    } catch (error) {
      log(
        `download failed for ${candidate.episodeRequestId}: ${errorMessage(error)}`,
      );
      await fs.rm(rawReplayPath, { force: true }).catch(() => undefined);
      continue;
    }
    attempted.push(candidate.episodeRequestId);
    const facts = parseRawReplayFacts(
      await fs.readFile(rawReplayPath),
      typeof rawRow.coworld_name === "string"
        ? rawRow.coworld_name
        : "proxywar",
    );
    if (facts === null || !isTurnCountWithinStartupBudget(facts.turnCount)) {
      log(
        `episode ${candidate.episodeRequestId} over admission projection turn budget (${facts?.turnCount ?? "unparsable"}); trying next`,
      );
      await fs.rm(rawReplayPath, { force: true }).catch(() => undefined);
      continue;
    }
    selected = { row: candidate, rawRow, rawReplayPath, facts };
    break;
  }

  if (selected === null) {
    await journal.appendRoundSkipped(
      { id: round.id, roundNumber: round.roundNumber },
      "projection_over_budget",
    );
    return;
  }

  // Pre-admission already-public check. The mirror can publish a completed
  // round between premieres (it only quarantines while a suppression contract
  // is active), so a within-window round may still be on the public origin. A
  // published outcome can no longer be sealed, and admitting it would drive the
  // leak collector to fetch (and abort) the multi-MB public replay. Probe the
  // origin BEFORE pin/contract/admit; skip terminally if it is already public.
  const publicRunKey = publicRunKeyForSourceRunId(selected.facts.runId);
  if (await isEpisodeAlreadyPublic(publicRunKey, config)) {
    log(
      `round ${round.roundNumber ?? "?"} episode ${selected.row.episodeRequestId} already public (${publicRunKey}); skipping pre-admission`,
    );
    await fs.rm(selected.rawReplayPath, { force: true }).catch(() => undefined);
    await journal.appendRoundSkipped(
      { id: round.id, roundNumber: round.roundNumber },
      "already_public",
    );
    return;
  }

  await pruneRawReplayCache(config, selected.rawReplayPath);
  const scheduledAt = scheduledAtForClaim(now);
  const hold: LoopHoldState = {
    episodeRequestId: selected.row.episodeRequestId,
    premiereId: derivePremiereId(selected.row.episodeRequestId),
    roundId: round.id,
    roundNumber: round.roundNumber,
    scheduledAt,
    holdExpiresAt: holdExpiresAtForScheduled(scheduledAt),
    premierePageLive: false,
    mapLabel: mapLabelFromVariantName(selected.row.variantName),
    publicRunKey,
    replayUrl: selected.row.replayUrl ?? "",
    variantName: selected.row.variantName,
    seatCount: selected.facts.seatCount,
    turnCount: selected.facts.turnCount,
    playbackRate: playbackRateForTurnCount(selected.facts.turnCount),
    phase: "claimed",
    activationAttempts: 0,
    activationBackoffUntil: null,
    activatedAt: null,
    reactivationAttempts: 0,
    createdAt: now.toISOString(),
  };

  // CLAIM: protect the episode from the league page and pin its bundle BEFORE
  // ingest/admit, so the admission leak audit sees a clean /league.
  await pinHoldArtifacts(hold, config);
  await writeContractForHold(hold, config, now);
  await journal.appendHoldUpdate(hold);
  log(
    `claimed round ${round.roundNumber ?? "?"} episode ${hold.episodeRequestId} -> ${hold.premiereId} (${hold.turnCount} turns, ${hold.playbackRate}x)`,
  );

  const divisionFile = await stageDivisionFile(config);
  await progressHold(
    hold,
    {
      rawRow: selected.rawRow,
      rawReplayPath: selected.rawReplayPath,
      facts: selected.facts,
      divisionFile,
    },
    config,
    journal,
    now,
  );
}

async function pruneRawReplayCache(
  config: LoopConfig,
  keepPath: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(config.ingestScratchDir);
  } catch {
    return;
  }
  const replays = entries
    .filter((entry) => entry.endsWith(".replay"))
    .map((entry) => path.join(config.ingestScratchDir, entry));
  if (replays.length <= PREMIERE_LOOP_MAX_RAW_REPLAY_CACHE) {
    return;
  }
  const stats = await Promise.all(
    replays.map(async (file) => ({
      file,
      mtime: (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0,
    })),
  );
  stats.sort((left, right) => right.mtime - left.mtime);
  for (const entry of stats.slice(PREMIERE_LOOP_MAX_RAW_REPLAY_CACHE)) {
    if (entry.file !== keepPath) {
      await fs.rm(entry.file, { force: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Shadow observation (INGEST only; provably side-effect free on production)
// ---------------------------------------------------------------------------

async function runShadowIteration(config: LoopConfig): Promise<void> {
  // Defense in depth: assert the shadow gate forbids every mutation before
  // observing. Shadow only ever calls read + ingest below.
  const plan = loopSideEffectPlan(true);
  if (
    plan.writeSuppressionContract ||
    plan.writeLatestPremierePointer ||
    plan.pinArtifacts ||
    plan.admit ||
    plan.restart
  ) {
    throw new Error("shadow mode must not enable any mutating side effect");
  }
  const journal = await readJournal(config.journalPath);
  const folded = foldLoopJournal(journal);
  const now = new Date();
  const roundsRaw = await coworldRead(
    ["rounds", "-l", config.leagueId, "--limit", "40"],
    config,
  );
  const decision = decideLoopClaim({
    rounds: parseLoopRounds(roundsRaw),
    folded,
    now,
  });
  if (decision.kind !== "claim") {
    await appendJsonl(config.shadowDecisionsPath, {
      ts: new Date().toISOString(),
      mode: "shadow",
      decision: decision.kind,
    });
    log(`shadow: decision=${decision.kind} (no mutation)`);
    return;
  }
  const replays = await fetchDivisionReplays(config);
  const candidates = orderEpisodesForClaim(decision.round, replays.rows);
  const shadowScratch = path.join(config.loopStateDir, "shadow-scratch");
  await fs.mkdir(shadowScratch, { recursive: true });
  let observed: Record<string, unknown> | null = null;
  for (const candidate of candidates.slice(
    0,
    PREMIERE_LOOP_MAX_REPLAY_DOWNLOADS,
  )) {
    const rawRow = replays.rawById.get(candidate.episodeRequestId);
    if (rawRow === undefined || candidate.replayUrl === null) {
      continue;
    }
    const replayPath = path.join(shadowScratch, `${randomUUID()}.replay`);
    try {
      await downloadRawReplay(candidate.replayUrl, replayPath, config);
      const facts = parseRawReplayFacts(
        await fs.readFile(replayPath),
        typeof rawRow.coworld_name === "string"
          ? rawRow.coworld_name
          : "proxywar",
      );
      if (facts === null || !isTurnCountWithinStartupBudget(facts.turnCount)) {
        await fs.rm(replayPath, { force: true }).catch(() => undefined);
        continue;
      }
      // INGEST only — write to shadow scratch, never admit, contract, pin, or
      // restart (plan enforces this). Prove the pipeline would succeed.
      const episodeFile = path.join(
        shadowScratch,
        `${randomUUID()}.episode.json`,
      );
      const outFile = path.join(shadowScratch, `${randomUUID()}.source.json`);
      const divisionRaw = await coworldRead(
        ["divisions", "-l", config.leagueId],
        config,
      );
      const divisionFile = path.join(
        shadowScratch,
        `${randomUUID()}.divisions.json`,
      );
      await fs.writeFile(
        divisionFile,
        `${JSON.stringify(divisionRaw)}\n`,
        "utf8",
      );
      await fs.writeFile(
        episodeFile,
        `${JSON.stringify([
          {
            ...rawRow,
            game_config: {
              map: facts.gameMap,
              map_size: facts.gameMapSize,
              difficulty: facts.difficulty,
              num_agents: facts.seatCount,
            },
          },
        ])}\n`,
        "utf8",
      );
      const summary = await runReplayPremiereCoworldIngest([
        `--replay-file=${replayPath}`,
        `--episode-file=${episodeFile}`,
        `--episode-request-id=${candidate.episodeRequestId}`,
        `--division-file=${divisionFile}`,
        `--division-id=${config.divisionId}`,
        `--out-file=${outFile}`,
        `--turn-interval-ms=${config.turnIntervalMs}`,
      ]);
      observed = {
        episodeRequestId: candidate.episodeRequestId,
        premiereId: derivePremiereId(candidate.episodeRequestId),
        turnCount: summary.turnCount,
        seatCount: summary.seatCount,
        playbackRate: playbackRateForTurnCount(summary.turnCount),
        bundleSha256: summary.bundleSha256,
      };
      break;
    } catch (error) {
      log(
        `shadow ingest failed for ${candidate.episodeRequestId}: ${operatorCodeOf(error)}`,
      );
    } finally {
      await fs.rm(replayPath, { force: true }).catch(() => undefined);
    }
  }
  // Shadow scratch is entirely disposable and lives outside all served roots.
  await fs
    .rm(shadowScratch, { recursive: true, force: true })
    .catch(() => undefined);
  await appendJsonl(config.shadowDecisionsPath, {
    ts: new Date().toISOString(),
    mode: "shadow",
    decision: "claim",
    round: decision.round.roundNumber,
    observed,
  });
  log(
    observed === null
      ? "shadow: claim candidate had no budgeted, ingestible episode"
      : `shadow: would premiere ${String(observed.premiereId)} (${String(observed.turnCount)} turns) — no mutation`,
  );
}

// ---------------------------------------------------------------------------
// Iteration entry
// ---------------------------------------------------------------------------

async function runLiveIteration(config: LoopConfig): Promise<void> {
  const journal = createJournalWriter(config);
  const loadedRecords = await readJournal(config.journalPath);
  // Migration runs before compaction so a pre-tombstone terminal release can
  // never fall into the archived prefix without first retiring its immutable
  // admission. Exact release identities/outcomes are revalidated by the
  // coordination boundary; ambiguous history aborts before any claim.
  await backfillReplayPremiereTerminalTombstones({
    privateStateRoot: config.privateStateRoot,
    records: loadedRecords,
  });
  const records = await compactJournalIfNeeded(config, loadedRecords);
  const folded = foldLoopJournal(records);
  const now = new Date();
  const retainedClaimMayExist =
    folded.activeHold?.phase === "claimed" &&
    (await retainedAdmissionMarkerMayExist(folded.activeHold, config));

  // Standing-quarantine heartbeat: refresh the contract every live tick — with the
  // active hold when one exists, otherwise as the zero-hold standing contract
  // whose blanket quarantine defers every freshly-completed episode until the
  // loop has had its chance to claim it. Written BEFORE the coworld reads that
  // can flake, so a transient Softmax outage never lets suppression go stale
  // (and spoil a live premiere) within the 15-minute stale bound. The 60s tick
  // against the 15-minute staleness bound leaves a wide refresh margin, and
  // fail-open is preserved: if this process stops, the contract goes stale and
  // everything publishes. Best-effort: a refresh failure must not abort the
  // tick.
  try {
    if (
      folded.activeHold !== null &&
      (!isHoldExpired(folded.activeHold, now) || retainedClaimMayExist)
    ) {
      await writeContractForHold(folded.activeHold, config, now);
    } else {
      await writeStandingContract(config, now);
    }
  } catch (error) {
    log(`contract heartbeat warning: ${errorMessage(error)}`);
  }

  const roundsRaw = await coworldRead(
    ["rounds", "-l", config.leagueId, "--limit", "40"],
    config,
  );
  const decision = decideLoopClaim({
    rounds: parseLoopRounds(roundsRaw),
    folded,
    now,
  });

  if (decision.kind === "idle") {
    await journal.appendDecision({ decision: "idle" });
    log("idle: no completed unpremiered round");
    return;
  }

  if (decision.kind === "post_reveal_cooldown") {
    for (const ref of decision.skippedRoundIds) {
      await journal.appendRoundSkipped(ref, "skipped_post_reveal_cooldown");
    }
    await journal.appendDecision({
      decision: "post_reveal_cooldown",
      nextClaimAt: decision.nextClaimAt,
      skipped: decision.skippedRoundIds.map((ref) => ref.roundNumber),
    });
    log(
      `post-reveal cooldown until ${decision.nextClaimAt}; ${decision.skippedRoundIds.length} completed round(s) publish normally`,
    );
    return;
  }

  if (decision.kind === "track") {
    for (const ref of decision.busySkipRoundIds) {
      await journal.appendRoundSkipped(ref, "skipped_busy");
    }
    await journal.appendDecision({
      decision: "track",
      premiereId: decision.hold.premiereId,
      phase: decision.hold.phase,
      skippedBusy: decision.busySkipRoundIds.map((ref) => ref.roundNumber),
    });
    log(
      `tracking premiere ${decision.hold.premiereId} (phase ${decision.hold.phase})`,
    );
    await progressHold(decision.hold, null, config, journal, now);
    return;
  }

  // claim
  let foreignGate: ForeignRegisteredPremiereGate;
  try {
    foreignGate = await foreignRegisteredPremiereGate(config);
  } catch (error) {
    await journal.appendDecision({
      decision: "claim_blocked_coordination_unavailable",
      operatorCode: operatorCodeOf(error),
    });
    log(
      `claim blocked: active server premiere selection is unavailable (${operatorCodeOf(error)})`,
    );
    return;
  }
  if (foreignGate.busyPremiereIds.length > 0) {
    const busyRounds = [
      { id: decision.round.id, roundNumber: decision.round.roundNumber },
      ...decision.supersededRoundIds,
    ];
    for (const ref of busyRounds) {
      await journal.appendRoundSkipped(ref, "skipped_busy");
    }
    await journal.appendDecision({
      decision: "claim_skipped_foreign_premiere_busy",
      premiereIds: foreignGate.busyPremiereIds,
      skippedBusy: busyRounds.map((ref) => ref.roundNumber),
    });
    log(
      `foreign premiere busy (${foreignGate.busyPremiereIds.join(", ")}); ${busyRounds.length} completed round(s) publish normally`,
    );
    return;
  }
  try {
    // Final identity barrier immediately before the first terminal journal or
    // claim-side mutation. A restart/selection replacement during the probes
    // invalidates the evidence even when both receipts individually validate.
    await assertForeignPremiereGateUnchanged(config, foreignGate);
  } catch (error) {
    await journal.appendDecision({
      decision: "claim_blocked_coordination_changed",
      operatorCode: operatorCodeOf(error),
    });
    log(
      `claim blocked: server premiere selection changed before commit (${operatorCodeOf(error)})`,
    );
    return;
  }
  // Cold-start / gap-recovery guard. The newest completed unpremiered round can
  // itself be older than the seal window (e.g. the loop was down or in shadow
  // across a round). Such a round has already been published by the mirror and
  // can no longer be sealed, so skip it pre-claim — no download, no admission,
  // no over-ceiling leak fetch. Fresh rounds (completed within the window) fall
  // through unchanged; the precise per-episode check is the origin probe in
  // claimRound. Fail-open: a null/unparseable completedAt stays claimable.
  if (isCompletedTooOldToSeal(decision.round.completedAt, now)) {
    await journal.appendRoundSkipped(
      { id: decision.round.id, roundNumber: decision.round.roundNumber },
      "too_old_to_seal",
    );
    await journal.appendDecision({
      decision: "claim_skipped_too_old_to_seal",
      round: decision.round.roundNumber,
    });
    log(
      `round ${decision.round.roundNumber ?? "?"} completed too long ago to seal; skipping`,
    );
    return;
  }
  if (!(await hasStorageFloor(config))) {
    await journal.appendDecision({ decision: "claim_skipped_storage_floor" });
    log("below storage floor; skipping claim this tick");
    return;
  }
  try {
    await assertForeignPremiereGateUnchanged(config, foreignGate);
  } catch (error) {
    await journal.appendDecision({
      decision: "claim_blocked_coordination_changed",
      operatorCode: operatorCodeOf(error),
    });
    log(
      `claim blocked: server premiere selection changed before claim (${operatorCodeOf(error)})`,
    );
    return;
  }
  for (const ref of decision.supersededRoundIds) {
    await journal.appendRoundSkipped(ref, "skipped_superseded");
  }
  await journal.appendDecision({
    decision: "claim",
    round: decision.round.roundNumber,
    superseded: decision.supersededRoundIds.map((ref) => ref.roundNumber),
  });
  await claimRound(decision.round, config, journal, now);
}

async function runTerminalTombstoneBackfill(config: LoopConfig): Promise<void> {
  const created = await backfillReplayPremiereTerminalTombstones({
    privateStateRoot: config.privateStateRoot,
    records: await readJournal(config.journalPath),
  });
  log(
    `terminal tombstone backfill complete (${created.length} matched release record(s))`,
  );
}

async function hasStorageFloor(config: LoopConfig): Promise<boolean> {
  try {
    const free = await minimumAvailableDiskBytes([
      config.loopStateDir,
      config.privateStateRoot,
    ]);
    return free >= config.minimumFreeBytes;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.entries)) {
    return value.entries;
  }
  return [];
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operatorCodeOf(error: unknown): string {
  return error instanceof ReplayPremiereError
    ? error.operatorCode
    : errorMessage(error);
}

function admissionFailureOperatorCodeOf(error: unknown): string {
  return error instanceof ReplayPremiereError
    ? error.operatorCode
    : "admission_unexpected_error";
}

function isAdmissionHoldRequired(error: unknown): boolean {
  if (!(error instanceof ReplayPremiereError)) return false;
  return new Set([
    "catalog_admission_commit_state_uncertain",
    "catalog_admission_cleanup_failed",
    "catalog_projection_rollback_failed",
    "admission_catalog_not_clean",
    "admission_premiere_already_exists",
    "admission_commitment_already_exists",
    "admission_existing_identity_mismatch",
    "admission_existing_identity_unverified",
    "admission_existing_projection_unavailable",
  ]).has(error.operatorCode);
}

function isIneligible(error: unknown): boolean {
  return (
    error instanceof ReplayPremiereError &&
    error.publicCode === "PREMIERE_SOURCE_INELIGIBLE"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shadow = args.includes("--shadow");
  const backfillOnly = args.includes("--backfill-terminal-tombstones");
  const unknown = args.filter(
    (arg) => arg !== "--shadow" && arg !== "--backfill-terminal-tombstones",
  );
  if (unknown.length > 0) {
    throw new Error(`unknown premiere-loop argument(s): ${unknown.join(", ")}`);
  }
  if (shadow && backfillOnly) {
    throw new Error(
      "--shadow and --backfill-terminal-tombstones are mutually exclusive",
    );
  }
  const config = resolveLoopConfig(process.env);
  await fs.mkdir(config.loopStateDir, { recursive: true });

  if (shadow) {
    // Shadow never takes the mutating lock path; it only observes.
    await runShadowIteration(config);
    return;
  }

  if (backfillOnly) {
    const outcome = await withSingleInstanceLock(config.lockDir, async () => {
      await runTerminalTombstoneBackfill(config);
      return true;
    });
    if (outcome === null) {
      throw new Error("premiere loop is active; tombstone backfill refused");
    }
    return;
  }

  const outcome = await withSingleInstanceLock(config.lockDir, async () => {
    await runLiveIteration(config);
    return true;
  });
  if (outcome === null) {
    // Another iteration holds the lock; a skipped tick is expected under a
    // long (restart-bearing) predecessor and is not a failure.
    return;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`[premiere-loop] iteration failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

export {
  activateHold,
  assertForeignPremiereGateUnchanged,
  foreignRegisteredPremiereGate,
  isEpisodeAlreadyPublic,
  main,
  resolveLoopConfig,
  runTerminalTombstoneBackfill,
  trackHold,
};
export type { JournalWriter, LoopConfig };
