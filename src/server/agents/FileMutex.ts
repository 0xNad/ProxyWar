import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * A WAIT-based (retry-until-acquired, not fail-fast) exclusive file lock —
 * the cross-process concurrency primitive `reconcileFeaturedMatchStore`
 * (`FeaturedMatchReconcile.ts`) and the retention-pin manifest writers
 * (`CoworldLeagueArtifactRetention.ts`'s `addRetentionPinOwners`) both need.
 *
 * Two independent, concurrent HTTP requests (both new narrow FeaturedMatch
 * API routes call `reconcileFeaturedMatchStore`) — or a request racing an
 * operator CLI (`premiere:publish`/`premiere:cancel`, separate OS
 * processes) — can otherwise interleave a whole-store read-modify-write:
 * each reads the SAME pre-mutation state, computes its own update, and the
 * LATER write silently discards whatever the EARLIER write changed for any
 * record the later pass didn't itself recompute. Same failure mode for the
 * pin manifest.
 *
 * Same proven technique `CoworldLeagueMirrorOperationLock.ts` already uses
 * in this codebase (atomic `mkdir` as the acquire primitive, a sibling
 * "reclaim guard" directory so two reclaimers can never race each other,
 * stale-owner detection via PID liveness) — but that module is
 * deliberately FAIL-FAST ("only one mirror sync at a time; reject a second
 * attempt outright"), the wrong shape for many spectator HTTP requests that
 * must each eventually succeed, not 500 because another request's
 * reconcile is mid-flight. This is a NEW, separate, WAIT/retry-until-
 * acquired implementation of the same technique, rather than a behavior
 * change to that existing, working, fail-fast lock and its current caller.
 */

const OWNER_GRACE_MS = 30_000;
const RECLAIM_GUARD_SUFFIX = ".reclaim-guard";
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 25;

interface MutexOwner {
  pid: number;
  token: string;
  createdAt: string;
}

function lockPathFor(resourcePath: string): string {
  return `${path.resolve(resourcePath)}.mutex-lock`;
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

function parseOwner(value: string): MutexOwner | null {
  try {
    const candidate = JSON.parse(value) as Partial<MutexOwner>;
    return Number.isInteger(candidate.pid) &&
      Number(candidate.pid) > 0 &&
      typeof candidate.token === "string" &&
      candidate.token.length > 0 &&
      typeof candidate.createdAt === "string"
      ? {
          pid: Number(candidate.pid),
          token: candidate.token,
          createdAt: candidate.createdAt,
        }
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function reclaimAbandonedLockWhileGuarded(
  lockPath: string,
): Promise<boolean> {
  const ownerPath = path.join(lockPath, "owner.json");
  let owner: MutexOwner | null = null;
  try {
    owner = parseOwner(await fs.readFile(ownerPath, "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (owner !== null && processIsAlive(owner.pid)) return false;
  if (owner === null) {
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs < OWNER_GRACE_MS) return false;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
  }
  const abandonedPath = `${lockPath}.abandoned.${randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.rm(abandonedPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** One acquire attempt — mirrors `CoworldLeagueMirrorOperationLock.ts`'s own `acquireMirrorOperationLock`, but returns `null` (never throws "already running") when it loses the race, so the caller can retry. */
async function tryAcquireOnce(
  resourcePath: string,
): Promise<(() => Promise<void>) | null> {
  const lockPath = lockPathFor(resourcePath);
  const reclaimGuardPath = `${lockPath}${RECLAIM_GUARD_SUFFIX}`;
  const ownerPath = path.join(lockPath, "owner.json");
  const owner: MutexOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  try {
    await fs.mkdir(reclaimGuardPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return null;
    throw error;
  }

  try {
    try {
      await fs.mkdir(lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (!(await reclaimAbandonedLockWhileGuarded(lockPath))) return null;
      try {
        await fs.mkdir(lockPath);
      } catch (acquireError) {
        if (errorCode(acquireError) === "EEXIST") return null;
        throw acquireError;
      }
    }
    try {
      await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, "utf8");
    } catch (error) {
      await fs.rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    return async () => {
      try {
        const currentOwner = parseOwner(await fs.readFile(ownerPath, "utf8"));
        if (currentOwner?.token === owner.token) {
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    };
  } finally {
    await fs.rmdir(reclaimGuardPath);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `operation` while holding an exclusive lock on `resourcePath`
 * (a plain identifier, typically a file/store path — the actual lock is a
 * sibling `<resourcePath>.mutex-lock` directory, never the resource file
 * itself). Retries acquisition with a short delay until `timeoutMs`
 * elapses, at which point it throws — this is meant for fast, bounded
 * read-modify-write critical sections (a JSON store read+write, not a
 * long-running job), so a caller hitting the timeout indicates a genuine
 * problem (a wedged holder), not normal contention.
 */
export async function withFileMutex<T>(
  resourcePath: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const release = await acquireWithRetry(resourcePath, options.timeoutMs);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireWithRetry(
  resourcePath: string,
  timeoutMsOption: number | undefined,
): Promise<() => Promise<void>> {
  const timeoutMs = timeoutMsOption ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = await tryAcquireOnce(resourcePath);
    if (release !== null) return release;
    if (Date.now() >= deadline) {
      throw new Error(
        `withFileMutex: timed out acquiring lock for ${resourcePath} after ${timeoutMs}ms`,
      );
    }
    await delay(RETRY_DELAY_MS);
  }
}
