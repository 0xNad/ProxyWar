import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ownerGraceMs = 30_000;
const reclaimGuardSuffix = ".reclaim-guard";

interface MirrorOperationLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

export function coworldLeagueMirrorOperationLockPath(siteDir: string): string {
  return `${path.resolve(siteDir)}.mirror-operation-lock`;
}

function mirrorOperationReclaimGuardPath(lockPath: string): string {
  return `${lockPath}${reclaimGuardSuffix}`;
}

function parseOwner(value: string): MirrorOperationLockOwner | null {
  try {
    const candidate = JSON.parse(value) as Partial<MirrorOperationLockOwner>;
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
  let owner: MirrorOperationLockOwner | null = null;
  try {
    owner = parseOwner(await fs.readFile(ownerPath, "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  if (owner !== null && processIsAlive(owner.pid)) {
    return false;
  }
  if (owner === null) {
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs < ownerGraceMs) {
        return false;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return true;
      }
      throw error;
    }
  }
  const abandonedPath = `${lockPath}.abandoned.${randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.rm(abandonedPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function acquireMirrorOperationLock(
  siteDir: string,
): Promise<() => Promise<void>> {
  const lockPath = coworldLeagueMirrorOperationLockPath(siteDir);
  const reclaimGuardPath = mirrorOperationReclaimGuardPath(lockPath);
  const ownerPath = path.join(lockPath, "owner.json");
  const owner: MirrorOperationLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  try {
    await fs.mkdir(reclaimGuardPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      // Never inspect or mutate the operation lock around an existing guard.
      // Its owner may be reclaiming a stale lock, and an orphaned/non-directory
      // guard is deliberately treated as ambiguous rather than removed.
      throw mirrorOperationAlreadyRunningError(lockPath, error);
    }
    throw error;
  }

  try {
    try {
      await fs.mkdir(lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      // The owner is read only after the atomic sibling guard is held. This
      // prevents two reclaimers from caching the same dead owner and lets only
      // the guard holder rename the stale lock.
      if (!(await reclaimAbandonedLockWhileGuarded(lockPath))) {
        throw mirrorOperationAlreadyRunningError(lockPath, error);
      }
      try {
        await fs.mkdir(lockPath);
      } catch (acquireError) {
        if (errorCode(acquireError) === "EEXIST") {
          throw mirrorOperationAlreadyRunningError(lockPath, acquireError);
        }
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
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
      }
    };
  } finally {
    // The guard is intentionally an empty directory. rmdir is atomic and will
    // fail closed if its state becomes ambiguous instead of recursively
    // deleting a guard another process could own.
    await fs.rmdir(reclaimGuardPath);
  }
}

export async function withCoworldLeagueMirrorOperationLock<T>(
  siteDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireMirrorOperationLock(siteDir);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function mirrorOperationAlreadyRunningError(
  lockPath: string,
  cause?: unknown,
): Error {
  return new Error(
    `Coworld league mirror operation already running: ${lockPath}`,
    cause === undefined ? undefined : { cause },
  );
}

function errorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}
