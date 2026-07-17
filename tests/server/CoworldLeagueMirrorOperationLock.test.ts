import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  coworldLeagueMirrorOperationLockPath,
  withCoworldLeagueMirrorOperationLock,
} from "../../src/server/agents/CoworldLeagueMirrorOperationLock";

const deadProcessId = 2_147_483_647;

describe("CoworldLeagueMirrorOperationLock", () => {
  let temporaryRoot: string;
  let siteDir: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-lock-"));
    siteDir = path.join(temporaryRoot, "runs", "league");
    await fs.mkdir(siteDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  test("rejects overlap and releases after success or failure", async () => {
    await withCoworldLeagueMirrorOperationLock(siteDir, async () => {
      await expect(
        withCoworldLeagueMirrorOperationLock(siteDir, async () => undefined),
      ).rejects.toThrow("already running");
    });
    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => {
        throw new Error("expected failure");
      }),
    ).rejects.toThrow("expected failure");
    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => "released"),
    ).resolves.toBe("released");
  });

  test("allows exactly one simultaneous initial acquirer", async () => {
    const attempts = Array.from({ length: 8 }, (_, contenderId) =>
      withCoworldLeagueMirrorOperationLock(siteDir, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return contenderId;
      }),
    );

    const results = await Promise.allSettled(attempts);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(7);
    expect(
      rejected.every(
        (result) =>
          result.reason instanceof Error &&
          result.reason.message.includes("already running"),
      ),
    ).toBe(true);
  });

  test("reclaims a lock owned by a dead process", async () => {
    const lockPath = await writeOwner(siteDir, {
      pid: deadProcessId,
      token: "dead-owner",
    });

    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => "reclaimed"),
    ).resolves.toBe("reclaimed");
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed while the stale-reclaim guard state is ambiguous", async () => {
    const lockPath = await writeOwner(siteDir, {
      pid: deadProcessId,
      token: "dead-owner",
    });
    const reclaimGuardPath = `${lockPath}.reclaim-guard`;
    await fs.mkdir(reclaimGuardPath);

    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => "unsafe"),
    ).rejects.toThrow("already running");
    await expect(
      fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
    ).resolves.toContain("dead-owner");

    await fs.rmdir(reclaimGuardPath);
    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => "reclaimed"),
    ).resolves.toBe("reclaimed");
  });

  test("does not acquire through an orphaned reclaim guard", async () => {
    const lockPath = coworldLeagueMirrorOperationLockPath(siteDir);
    const reclaimGuardPath = `${lockPath}.reclaim-guard`;
    await fs.mkdir(reclaimGuardPath);

    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => "unsafe"),
    ).rejects.toThrow("already running");
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.rmdir(reclaimGuardPath);
    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => "acquired"),
    ).resolves.toBe("acquired");
  });

  test("does not release a lock whose ownership token changed", async () => {
    const lockPath = coworldLeagueMirrorOperationLockPath(siteDir);

    await withCoworldLeagueMirrorOperationLock(siteDir, async () => {
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          token: "replacement-owner",
          createdAt: new Date().toISOString(),
        })}\n`,
      );
    });

    await expect(
      fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
    ).resolves.toContain("replacement-owner");
  });

  test("serializes simultaneous stale reclaimers across real processes", async () => {
    const lockPath = await writeOwner(siteDir, {
      pid: deadProcessId,
      token: "dead-owner",
    });
    const readyPath = path.join(temporaryRoot, "ready.log");
    const startPath = path.join(temporaryRoot, "start");
    const resultPath = path.join(temporaryRoot, "result.log");
    const childScriptPath = path.join(temporaryRoot, "contender.mts");
    const contenderCount = 8;
    await fs.writeFile(
      childScriptPath,
      contenderScript(
        pathToFileURL(
          path.resolve("src/server/agents/CoworldLeagueMirrorOperationLock.ts"),
        ).href,
      ),
    );

    const children = Array.from({ length: contenderCount }, (_, index) =>
      spawnContender(childScriptPath, [
        siteDir,
        readyPath,
        startPath,
        resultPath,
        String(index),
      ]),
    );
    await waitForLineCount(readyPath, contenderCount, 10_000);
    await fs.writeFile(startPath, "start\n");
    const results = await Promise.all(children.map(waitForChild));

    expect(results).toEqual(
      Array.from({ length: contenderCount }, () => ({
        code: 0,
        stderr: "",
      })),
    );
    const lines = (await fs.readFile(resultPath, "utf8")).trim().split("\n");
    const acquiredLines = lines.filter((line) => line.endsWith(":acquired"));
    const completedLines = lines.filter((line) => line.endsWith(":completed"));
    expect(acquiredLines).toHaveLength(1);
    expect(completedLines).toEqual([
      acquiredLines[0]?.replace(":acquired", ":completed"),
    ]);
    expect(lines.filter((line) => line.includes(":rejected:"))).toHaveLength(
      contenderCount - 1,
    );
    expect(
      lines
        .filter((line) => line.includes(":rejected:"))
        .every((line) => line.includes("already running")),
    ).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${lockPath}.reclaim-guard`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 20_000);
});

async function writeOwner(
  siteDir: string,
  owner: { pid: number; token: string },
): Promise<string> {
  const lockPath = coworldLeagueMirrorOperationLockPath(siteDir);
  await fs.mkdir(lockPath);
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({
      ...owner,
      createdAt: "2026-07-17T00:00:00Z",
    })}\n`,
  );
  return lockPath;
}

function contenderScript(lockModuleUrl: string): string {
  return `
import { access, appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { withCoworldLeagueMirrorOperationLock } from ${JSON.stringify(lockModuleUrl)};

const [siteDir, readyPath, startPath, resultPath, contenderId] = process.argv.slice(2);
await appendFile(readyPath, contenderId + ":ready\\n");
while (true) {
  try {
    await access(startPath);
    break;
  } catch {
    await delay(2);
  }
}

try {
  await withCoworldLeagueMirrorOperationLock(siteDir, async () => {
    await appendFile(resultPath, contenderId + ":acquired\\n");
    await delay(250);
    await appendFile(resultPath, contenderId + ":completed\\n");
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await appendFile(resultPath, contenderId + ":rejected:" + message + "\\n");
}
`;
}

function spawnContender(scriptPath: string, args: string[]): ChildProcess {
  return spawn(
    process.execPath,
    [require.resolve("tsx/cli"), scriptPath, ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

async function waitForChild(
  child: ChildProcess,
): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stderr };
}

async function waitForLineCount(
  filePath: string,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lineCount = (await fs.readFile(filePath, "utf8"))
        .trim()
        .split("\n").length;
      if (lineCount >= expected) {
        return;
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} contenders`);
}

function errorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}
