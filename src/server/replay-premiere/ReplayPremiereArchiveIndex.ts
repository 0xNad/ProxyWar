import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { PremiereSourceKind } from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import { isSha256Hex } from "./ReplayPremiereIntegrity";
import { publicRunKeyForSourceRunId } from "./ReplayPremiereLoopCore";
import {
  parsePremiereResultSummary,
  type PremiereResultSummaryV1,
  type PremiereResultTerminalState,
} from "./ReplayPremiereResultSummary";

export const REPLAY_PREMIERE_ARCHIVE_DIRECTORY = "archive-v1";
const SUMMARY_DIRECTORY = "summaries";
const ARCHIVE_INDEX_FILE = "archive-index.jsonl";
const MAX_SUMMARY_BYTES = 512 * 1024;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const MAX_ARCHIVED_POINTERS_PER_RUN = 16;

/**
 * The durable pointer that keeps `/premiere/<id>` resolvable forever, even after
 * the premiere's bulk is deleted and the server restarts. It carries only the
 * post-outcome facts already exposed by the reveal; nothing pre-reveal.
 */
export interface PremiereArchivePointerV1 {
  schemaVersion: 1;
  premiereId: string;
  sourceRunId: string;
  sourceKind: PremiereSourceKind;
  terminalState: PremiereResultTerminalState;
  revealedAt: string | null;
  publicationCommitmentHash: string;
  /**
   * The content-addressed source hash. Retained so the shared `.replay` bundle
   * can be garbage-collected at startup (no live writer) rather than in the
   * concurrent live sweep, where a lock-free catalog read could race a
   * concurrent admission that reuses the same-sha source.
   */
  sourceReplaySha256: string;
  summaryHash: string;
  summaryRelPath: string;
  reclaimedAt: string;
}

function summaryRelativePath(premiereId: string): string {
  return `${SUMMARY_DIRECTORY}/${premiereId}.summary.json`;
}

function pointerForSummary(
  summary: PremiereResultSummaryV1,
  sourceReplaySha256: string,
): PremiereArchivePointerV1 {
  return {
    schemaVersion: 1,
    premiereId: summary.premiereId,
    sourceRunId: summary.sourceRunId,
    sourceKind: summary.sourceKind,
    terminalState: summary.terminalState,
    revealedAt: summary.revealedAt,
    publicationCommitmentHash: summary.publicationCommitmentHash,
    sourceReplaySha256,
    summaryHash: summary.summaryHash,
    summaryRelPath: summaryRelativePath(summary.premiereId),
    reclaimedAt: summary.reclaimedAt,
  };
}

/**
 * In-memory index of every reclaimed premiere. Loaded once at startup (the
 * on-disk `archive-index.jsonl` is deduped/compacted at that point) and updated
 * in place as premieres are reclaimed, so the archive router never re-reads the
 * whole index per request.
 */
export class ReplayPremiereArchiveStore {
  readonly archiveRoot: string;
  private readonly indexPath: string;
  private readonly summaryDirectory: string;
  private readonly pointers: Map<string, PremiereArchivePointerV1>;
  private readonly ratedCoworldPointersByRunKey = new Map<
    string,
    Map<string, PremiereArchivePointerV1>
  >();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    archiveRoot: string;
    pointers: Map<string, PremiereArchivePointerV1>;
  }) {
    this.archiveRoot = options.archiveRoot;
    this.indexPath = path.join(options.archiveRoot, ARCHIVE_INDEX_FILE);
    this.summaryDirectory = path.join(options.archiveRoot, SUMMARY_DIRECTORY);
    this.pointers = options.pointers;
    for (const pointer of this.pointers.values()) {
      this.indexRatedCoworldPointer(pointer);
    }
  }

  /**
   * Opens the archive store under `privateStateRoot`, reading and compacting the
   * pointer index (dedupe by premiere id, drop torn/invalid lines). Compaction
   * runs only when it would change the file, and archives nothing destructively:
   * a bad line is simply not carried forward.
   */
  static async open(options: {
    privateStateRoot: string;
    compactOnOpen?: boolean;
  }): Promise<ReplayPremiereArchiveStore> {
    const archiveRoot = path.join(
      path.resolve(options.privateStateRoot),
      REPLAY_PREMIERE_ARCHIVE_DIRECTORY,
    );
    await fs.mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(archiveRoot, SUMMARY_DIRECTORY), {
      recursive: true,
      mode: 0o700,
    });
    const indexPath = path.join(archiveRoot, ARCHIVE_INDEX_FILE);
    const { pointers, sawInvalidOrDuplicate } =
      await readArchiveIndex(indexPath);
    const store = new ReplayPremiereArchiveStore({ archiveRoot, pointers });
    if ((options.compactOnOpen ?? true) && sawInvalidOrDuplicate) {
      await store.compactIndex();
    }
    return store;
  }

  lookup(premiereId: string): PremiereArchivePointerV1 | null {
    return this.pointers.get(premiereId) ?? null;
  }

  reclaimedPremiereIds(): readonly string[] {
    return [...this.pointers.keys()];
  }

  /**
   * Reveal-public rated Coworld pointers bound to one ordinary league run.
   * The cap makes post-render/startup repair fail closed if corrupt or
   * pathological archive history maps an unbounded number of premieres to the
   * same run.
   */
  revealPublicRatedCoworldPointersForRunKey(
    runKey: string,
  ): readonly PremiereArchivePointerV1[] {
    const indexed = this.ratedCoworldPointersByRunKey.get(runKey);
    if (indexed === undefined || indexed.size > MAX_ARCHIVED_POINTERS_PER_RUN) {
      return [];
    }
    const matches = [...indexed.values()].filter(
      (pointer) =>
        pointer.revealedAt !== null &&
        (pointer.terminalState === "revealed" ||
          pointer.terminalState === "archived"),
    );
    return matches.sort((left, right) =>
      left.premiereId.localeCompare(right.premiereId),
    );
  }

  /**
   * Every reclaimed premiere's content-addressed source hash, for startup-time
   * shared-source garbage collection.
   */
  reclaimedSources(): ReadonlyArray<{
    premiereId: string;
    sourceReplaySha256: string;
  }> {
    return [...this.pointers.values()].map((pointer) => ({
      premiereId: pointer.premiereId,
      sourceReplaySha256: pointer.sourceReplaySha256,
    }));
  }

  /**
   * Durably records a reclaimed premiere: writes the summary artifact
   * (write-then-atomic-rename) BEFORE appending the pointer, then registers the
   * pointer in memory.
   *
   * Crash-window idempotency: a crash after the summary artifact is durable but
   * before the pointer append leaves an orphan summary with no pointer. On the
   * retry the store finds no pointer and the caller rebuilds a fresh summary,
   * which can differ in non-deterministic fields (the wall-clock `reclaimedAt`,
   * or markers that arrived after the first build). Rather than reject that as an
   * immutable-artifact conflict (which would strand the premiere), the durable
   * first-written artifact is ADOPTED verbatim and the pointer is derived from
   * it — so the retry always converges on the first write.
   */
  async recordReclaimed(
    summary: PremiereResultSummaryV1,
    sourceReplaySha256: string,
  ): Promise<PremiereArchivePointerV1> {
    if (!isSha256Hex(sourceReplaySha256)) {
      throw archiveIntegrity("archive_pointer_invalid_source_hash");
    }
    return this.runExclusive(async () => {
      const adopted = await this.readSummaryArtifact(summary.premiereId);
      const effective = adopted ?? summary;
      const pointer = pointerForSummary(effective, sourceReplaySha256);
      if (adopted === null) await this.writeSummaryArtifact(summary);
      await this.appendPointer(pointer);
      this.registerPointer(pointer);
      return pointer;
    });
  }

  private registerPointer(pointer: PremiereArchivePointerV1): void {
    const previous = this.pointers.get(pointer.premiereId);
    if (previous?.sourceKind === "rated_coworld") {
      const previousKey = publicRunKeyForSourceRunId(previous.sourceRunId);
      const bucket = this.ratedCoworldPointersByRunKey.get(previousKey);
      bucket?.delete(previous.premiereId);
      if (bucket?.size === 0)
        this.ratedCoworldPointersByRunKey.delete(previousKey);
    }
    this.pointers.set(pointer.premiereId, pointer);
    this.indexRatedCoworldPointer(pointer);
  }

  private indexRatedCoworldPointer(pointer: PremiereArchivePointerV1): void {
    if (pointer.sourceKind !== "rated_coworld") return;
    const runKey = publicRunKeyForSourceRunId(pointer.sourceRunId);
    const bucket = this.ratedCoworldPointersByRunKey.get(runKey) ?? new Map();
    bucket.set(pointer.premiereId, pointer);
    this.ratedCoworldPointersByRunKey.set(runKey, bucket);
  }

  private async readSummaryArtifact(
    premiereId: string,
  ): Promise<PremiereResultSummaryV1 | null> {
    if (!PREMIERE_ID_PATTERN.test(premiereId)) {
      throw archiveIntegrity("archive_summary_invalid_premiere_id");
    }
    const summaryPath = path.join(
      this.summaryDirectory,
      `${premiereId}.summary.json`,
    );
    let bytes: Buffer;
    try {
      bytes = await readBoundedRegularFile(summaryPath, MAX_SUMMARY_BYTES);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    const summary = parsePremiereResultSummary(bytes);
    if (summary.premiereId !== premiereId) {
      throw archiveIntegrity("archive_summary_premiere_mismatch");
    }
    return summary;
  }

  async loadSummary(
    premiereId: string,
  ): Promise<PremiereResultSummaryV1 | null> {
    const pointer = this.pointers.get(premiereId);
    if (pointer === undefined) return null;
    const summaryPath = this.resolveSummaryPath(pointer);
    let bytes: Buffer;
    try {
      bytes = await readBoundedRegularFile(summaryPath, MAX_SUMMARY_BYTES);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    const summary = parsePremiereResultSummary(bytes);
    if (
      summary.premiereId !== pointer.premiereId ||
      summary.summaryHash !== pointer.summaryHash
    ) {
      throw archiveIntegrity("archive_summary_pointer_mismatch");
    }
    return summary;
  }

  private resolveSummaryPath(pointer: PremiereArchivePointerV1): string {
    if (pointer.summaryRelPath !== summaryRelativePath(pointer.premiereId)) {
      throw archiveIntegrity("archive_summary_path_not_content_addressed");
    }
    const resolved = path.join(
      this.archiveRoot,
      ...pointer.summaryRelPath.split("/"),
    );
    const expected = path.join(
      this.summaryDirectory,
      `${pointer.premiereId}.summary.json`,
    );
    if (resolved !== expected) {
      throw archiveIntegrity("archive_summary_path_escape");
    }
    return resolved;
  }

  private async writeSummaryArtifact(
    summary: PremiereResultSummaryV1,
  ): Promise<void> {
    const destination = path.join(
      this.summaryDirectory,
      `${summary.premiereId}.summary.json`,
    );
    const bytes = Buffer.from(`${JSON.stringify(summary)}\n`, "utf8");
    if (bytes.byteLength > MAX_SUMMARY_BYTES) {
      throw archiveCapacity("archive_summary_byte_ceiling_exceeded");
    }
    // Idempotent: an identical prior artifact is accepted as-is.
    try {
      const existing = await readBoundedRegularFile(
        destination,
        MAX_SUMMARY_BYTES,
      );
      if (existing.equals(bytes)) return;
      throw archiveIntegrity("archive_summary_is_immutable");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(
      this.summaryDirectory,
      `.${summary.premiereId}.${randomUUID()}.tmp`,
    );
    const handle = await fs.open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, destination);
      await fs.chmod(destination, 0o400);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    await syncDirectory(this.summaryDirectory);
  }

  private async appendPointer(
    pointer: PremiereArchivePointerV1,
  ): Promise<void> {
    const line = Buffer.from(`${JSON.stringify(pointer)}\n`, "utf8");
    const handle = await fs.open(
      this.indexPath,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < line.byteLength) {
        const { bytesWritten } = await handle.write(
          line,
          offset,
          line.byteLength - offset,
          null,
        );
        if (bytesWritten <= 0) {
          throw archiveIntegrity("archive_index_short_write");
        }
        offset += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(this.archiveRoot);
  }

  private async compactIndex(): Promise<void> {
    return this.runExclusive(async () => {
      const lines = [...this.pointers.values()]
        .sort((left, right) =>
          left.reclaimedAt === right.reclaimedAt
            ? left.premiereId.localeCompare(right.premiereId)
            : left.reclaimedAt.localeCompare(right.reclaimedAt),
        )
        .map((pointer) => JSON.stringify(pointer))
        .join("\n");
      const body = lines.length === 0 ? "" : `${lines}\n`;
      const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await fs.open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(temporary, this.indexPath);
      } catch (error) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      }
      await syncDirectory(this.archiveRoot);
    });
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function readArchiveIndex(indexPath: string): Promise<{
  pointers: Map<string, PremiereArchivePointerV1>;
  sawInvalidOrDuplicate: boolean;
}> {
  let raw: string;
  try {
    const bytes = await readBoundedRegularFile(indexPath, MAX_INDEX_BYTES);
    raw = bytes.toString("utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { pointers: new Map(), sawInvalidOrDuplicate: false };
    }
    throw error;
  }
  const pointers = new Map<string, PremiereArchivePointerV1>();
  let sawInvalidOrDuplicate = false;
  const lines = raw.length === 0 ? [] : raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      // The final element after a trailing newline, or a torn empty line.
      if (index !== lines.length - 1) sawInvalidOrDuplicate = true;
      continue;
    }
    const pointer = parseArchivePointer(line);
    if (pointer === null) {
      sawInvalidOrDuplicate = true;
      continue;
    }
    if (pointers.has(pointer.premiereId)) sawInvalidOrDuplicate = true;
    pointers.set(pointer.premiereId, pointer);
  }
  return { pointers, sawInvalidOrDuplicate };
}

function parseArchivePointer(line: string): PremiereArchivePointerV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const pointer = value as unknown as PremiereArchivePointerV1;
  const keysValid =
    Object.keys(value).sort().join(",") ===
    [
      "premiereId",
      "publicationCommitmentHash",
      "reclaimedAt",
      "revealedAt",
      "schemaVersion",
      "sourceKind",
      "sourceReplaySha256",
      "sourceRunId",
      "summaryHash",
      "summaryRelPath",
      "terminalState",
    ].join(",");
  if (
    !keysValid ||
    pointer.schemaVersion !== 1 ||
    !PREMIERE_ID_PATTERN.test(pointer.premiereId) ||
    typeof pointer.sourceRunId !== "string" ||
    pointer.sourceRunId.length === 0 ||
    (pointer.sourceKind !== "controlled_exhibition" &&
      pointer.sourceKind !== "rated_coworld") ||
    !isTerminalState(pointer.terminalState) ||
    (pointer.revealedAt !== null &&
      canonicalTimestampOrNull(pointer.revealedAt) === null) ||
    !isSha256Hex(pointer.publicationCommitmentHash) ||
    !isSha256Hex(pointer.sourceReplaySha256) ||
    !isSha256Hex(pointer.summaryHash) ||
    pointer.summaryRelPath !== summaryRelativePath(pointer.premiereId) ||
    canonicalTimestampOrNull(pointer.reclaimedAt) === null
  ) {
    return null;
  }
  return pointer;
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw archiveIntegrity("archive_file_not_regular");
    if (stat.size > maxBytes) {
      throw archiveCapacity("archive_file_byte_ceiling_exceeded");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isTerminalState(value: unknown): value is PremiereResultTerminalState {
  return (
    value === "revealed" ||
    value === "archived" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function canonicalTimestampOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function archiveIntegrity(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere archive index failed integrity validation: ${operatorCode}`,
  );
}

function archiveCapacity(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    `Replay premiere archive index exceeded a bounded limit: ${operatorCode}`,
  );
}
