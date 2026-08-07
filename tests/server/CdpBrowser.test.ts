/**
 * Regression coverage for `CdpBrowser.start()`'s startup-diagnostics
 * hardening (GH Actions run 31131165725, PR26 shard 1/4, AND push
 * 10a29b0 — PR25's own merge to main, so this was never PR-specific): a
 * Chrome that spawns fine but then either exits early or never opens its
 * DevTools port used to burn the full 15s `discoverWebSocketUrl` wait and
 * throw the same generic "page target never became reachable" message
 * either way, with nothing captured from the process itself (`stdio:
 * "ignore"`) — and a failed `start()` never killed the still-running
 * Chrome or removed its temp profile directory, leaving exactly what that
 * run's own "Terminate orphan process" cleanup had to reap (pid 2716
 * `chrome` plus two `chrome_crashpad_handler` children).
 *
 * Every case here drives the REAL `CdpBrowser.launch()` against a small
 * real (non-Chrome) executable standing in for Chrome — no source
 * inspection, no mocking of `CdpBrowser` internals. `CHROME_CANDIDATES` is
 * a module-level constant read from `process.env.CHROME_PATH` once at
 * import time, so each case resets Vitest's module registry and
 * dynamically re-imports the module after pointing `CHROME_PATH` at its
 * own fixture binary (mirrors `tests/client/Platform.test.ts`'s
 * `vi.resetModules()` + dynamic-import pattern for env-dependent
 * modules). `launch()`'s `discoveryTimeoutMs` option exercises the exact
 * same 45s-by-default deadline codepath in milliseconds instead of real
 * seconds. Process-kill verification mirrors
 * `tests/server/replay-premiere/ReplayPremiereClips.test.ts`'s
 * `pidAlive`/`waitForPidsDead` helpers.
 */
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

let scratchDir: string;

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidDead(pid: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (!(await pidAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label}: pid ${pid} still alive`);
}

/** A tiny real executable standing in for Chrome, driven entirely by env
 * vars so one fixture script covers every scenario below:
 *  - `CDP_TEST_MARKER_FILE` (always set): reports its own pid and the
 *    `--user-data-dir` value it was launched with, so a FAILED
 *    `CdpBrowser.launch()` — which never returns an instance handle — can
 *    still be checked for a leaked process/profile dir from the outside.
 *  - `CDP_TEST_STDERR`: written to stderr immediately on start.
 *  - `CDP_TEST_EXIT_CODE`: if set, exits with that code almost
 *    immediately; if unset, hangs (never opens a DevTools port) until
 *    killed — the exact "spawned fine, silently never reachable" shape
 *    the real CI failure showed.
 * `.cjs` so it runs as CommonJS regardless of this repo's own ESM
 * `package.json#type`. */
const FIXTURE_CHROME_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const marker = process.env.CDP_TEST_MARKER_FILE;
if (marker) {
  const flag = process.argv.find((a) => a.startsWith("--user-data-dir="));
  fs.writeFileSync(
    marker,
    JSON.stringify({
      pid: process.pid,
      userDataDir: flag ? flag.slice("--user-data-dir=".length) : null,
    }),
  );
}
if (process.env.CDP_TEST_STDERR) process.stderr.write(process.env.CDP_TEST_STDERR);
if (process.env.CDP_TEST_EXIT_CODE !== undefined) {
  process.exit(Number(process.env.CDP_TEST_EXIT_CODE));
}
setInterval(() => {}, 1000);
`;

async function importFreshCdpBrowser(): Promise<
  typeof import("../e2e/support/CdpBrowser")
> {
  vi.resetModules();
  return import("../e2e/support/CdpBrowser");
}

async function setUpFixtureChrome(): Promise<{
  markerFile: string;
  fixtureChromePath: string;
}> {
  scratchDir = await mkdtemp(path.join(os.tmpdir(), "pw-e2e-chrome-diag-test-"));
  const fixtureChromePath = path.join(scratchDir, "chrome-fixture.cjs");
  await writeFile(fixtureChromePath, FIXTURE_CHROME_SOURCE);
  execFileSync("chmod", ["755", fixtureChromePath]);
  const markerFile = path.join(scratchDir, "marker.json");
  process.env.CHROME_PATH = fixtureChromePath;
  process.env.CDP_TEST_MARKER_FILE = markerFile;
  return { markerFile, fixtureChromePath };
}

afterEach(async () => {
  delete process.env.CHROME_PATH;
  delete process.env.CHROME_BIN;
  delete process.env.CDP_TEST_MARKER_FILE;
  delete process.env.CDP_TEST_STDERR;
  delete process.env.CDP_TEST_EXIT_CODE;
  if (scratchDir !== undefined) {
    await rm(scratchDir, { recursive: true, force: true });
  }
});

describe("CdpBrowser.start() startup diagnostics (real spawn, fixture binary)", () => {
  test("an early process exit surfaces its exit code immediately, not the generic timeout message", async () => {
    await setUpFixtureChrome();
    process.env.CDP_TEST_EXIT_CODE = "7";
    const { CdpBrowser } = await importFreshCdpBrowser();
    const startedAt = Date.now();
    // discoveryTimeoutMs is generous (10s) here specifically so a bug that
    // regresses back to "only ever wait for the fixed deadline" would
    // still show up as a slow rejection rather than being masked by an
    // artificially tiny timeout.
    await expect(
      CdpBrowser.launch({ discoveryTimeoutMs: 10_000 }),
    ).rejects.toThrow(
      /Chrome process exited before its DevTools port became reachable.*code=7/s,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 15_000);

  test("bounded stderr from a spawned-but-silent process is captured in the timeout error", async () => {
    await setUpFixtureChrome();
    process.env.CDP_TEST_STDERR = "fixture: intentional sandbox failure marker\n";
    const { CdpBrowser } = await importFreshCdpBrowser();
    const startedAt = Date.now();
    // discoveryTimeoutMs is deliberately tiny here — this test exercises
    // the exact same deadline codepath `DEFAULT_DISCOVERY_TIMEOUT_MS`
    // (45s) uses in production, just fast enough to run in CI.
    await expect(
      CdpBrowser.launch({ discoveryTimeoutMs: 300 }),
    ).rejects.toThrow(
      /Chrome DevTools page target never became reachable[\s\S]*fixture: intentional sandbox failure marker/,
    );
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 10_000);

  test("a failed start (discovery timeout) leaves neither the process nor its profile directory behind", async () => {
    const { markerFile } = await setUpFixtureChrome();
    const { CdpBrowser } = await importFreshCdpBrowser();
    await expect(
      CdpBrowser.launch({ discoveryTimeoutMs: 300 }),
    ).rejects.toThrow(/Chrome DevTools page target never became reachable/);
    const marker = JSON.parse(await readFile(markerFile, "utf8")) as {
      pid: number;
      userDataDir: string | null;
    };
    expect(marker.userDataDir).not.toBeNull();
    await waitForPidDead(marker.pid, "failed start's leaked chrome fixture");
    await expect(readFile(marker.userDataDir!, "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  }, 10_000);

  test("an existing-but-non-executable CHROME_PATH still rejects fast via the existing spawn-error race (EACCES, not a timeout)", async () => {
    // A CHROME_PATH pointing at nothing on disk is silently dropped by
    // `CHROME_CANDIDATES`'s own `existsSync` filter (untouched, pre-existing
    // behavior — out of this change's scope) and falls through to a real
    // discovered Chrome if one happens to be installed on the machine
    // running the test, so it can't exercise the spawn-error race. A file
    // that EXISTS but isn't executable survives that filter and still
    // reaches `spawn()`, which is exactly what needs to fail here.
    scratchDir = await mkdtemp(path.join(os.tmpdir(), "pw-e2e-chrome-diag-test-"));
    const notExecutable = path.join(scratchDir, "not-a-real-chrome-binary");
    await writeFile(notExecutable, "not a real binary\n");
    execFileSync("chmod", ["644", notExecutable]);
    process.env.CHROME_PATH = notExecutable;
    const { CdpBrowser } = await importFreshCdpBrowser();
    const startedAt = Date.now();
    await expect(
      CdpBrowser.launch({ discoveryTimeoutMs: 10_000 }),
    ).rejects.toThrow(/Chrome process failed to start.*EACCES/s);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 15_000);

});

describe("sweepStaleInstances owner-PID scoping (real spawn, real ps)", () => {
  let foreignOwner: ChildProcess | null = null;
  let foreignChrome: ChildProcess | null = null;

  afterEach(() => {
    if (foreignChrome?.pid !== undefined) {
      try {
        process.kill(foreignChrome.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (foreignOwner?.pid !== undefined) {
      try {
        process.kill(foreignOwner.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    foreignChrome = null;
    foreignOwner = null;
  });

  test("a live foreign owner's Chrome survives launch()'s sweep; the SAME orphan is reaped once that owner is dead", async () => {
    const { fixtureChromePath } = await setUpFixtureChrome();
    // "Foreign owner": a real, independently-alive process standing in for
    // another CdpBrowser-owning process (this test's own process, or a
    // concurrently-running Vitest worker file in production) — the sweep
    // must key off ITS liveness, not the current process's.
    foreignOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      foreignOwner?.once("spawn", () => resolve());
      foreignOwner?.once("error", reject);
    });
    const foreignOwnerPid = foreignOwner.pid!;
    // Reuses the exact fixture "chrome" binary already used above, but
    // spawned directly (not through CdpBrowser) with a `--user-data-dir`
    // manually tagged with the foreign owner's PID — exactly the shape
    // `OWNED_USER_DATA_DIR_PREFIX` produces for a real launch.
    const foreignUserDataDir = path.join(
      os.tmpdir(),
      `pw-e2e-chrome-${foreignOwnerPid}-fake`,
    );
    foreignChrome = spawn(fixtureChromePath, [
      `--user-data-dir=${foreignUserDataDir}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      foreignChrome?.once("spawn", () => resolve());
      foreignChrome?.once("error", reject);
    });
    const foreignChromePid = foreignChrome.pid!;

    // Any `CdpBrowser.launch()` call runs `sweepStaleInstances()`
    // synchronously as its very first statement, before any `await` —
    // this call's own outcome is irrelevant, only the sweep side effect
    // matters, so a short timeout plus a same-process CHROME_PATH
    // (already set by `setUpFixtureChrome`) keeps it from hanging.
    process.env.CDP_TEST_EXIT_CODE = "1";
    const { CdpBrowser } = await importFreshCdpBrowser();
    await CdpBrowser.launch({ discoveryTimeoutMs: 300 }).catch(() => {
      // expected — this launch's own Chrome is unrelated to the assertion
    });

    expect(await pidAlive(foreignChromePid)).toBe(true);

    // Now kill the foreign owner and let it actually exit, then sweep
    // again — the exact same orphaned profile/process must now be reaped.
    process.kill(foreignOwnerPid, "SIGKILL");
    await waitForPidDead(foreignOwnerPid, "foreign owner");
    delete process.env.CDP_TEST_EXIT_CODE;
    process.env.CDP_TEST_STDERR = "unused\n";
    await CdpBrowser.launch({ discoveryTimeoutMs: 300 }).catch(() => {
      // expected — same reasoning as above
    });
    await waitForPidDead(
      foreignChromePid,
      "dead-owner orphan reaped by the next sweep",
    );
  }, 15_000);
});
