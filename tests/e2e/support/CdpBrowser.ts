/**
 * A minimal raw-CDP browser driver for the Stage 8 E2E suite. No Playwright
 * or Puppeteer dependency exists in this repo's package-lock, and
 * `npm run inst` is `npm ci --ignore-scripts` (never `npm install`), so
 * adding one is out of reach for this task. `ws` (an existing dependency —
 * the starter agents already use it) plus spawning the operator's own
 * installed Chrome headless is the same underlying mechanism
 * `browser-harness`'s own doc describes ("Raw CDP for anything helpers
 * don't cover") — this is that, made into a tiny, reusable, dependency-free
 * library instead of an interactive tool.
 *
 * Deliberately narrow: navigate, evaluate, click (via evaluate — no real
 * mouse events, which this suite's cases don't need), viewport, and a
 * couple of wait helpers. Not a general-purpose automation library.
 *
 * Leak-proofing (2026-08 hardening — an audit found 28 accumulated headless
 * Chrome instances spanning 8+ hours, several sharing
 * `--remote-debugging-port=9452`):
 *  - The debugging port is a genuinely free OS-assigned ephemeral port
 *    (`reserveDebugPort`), not a random guess in a fixed 500-wide range —
 *    the random range is exactly how concurrent runs ended up sharing a
 *    port.
 *  - Every instance's `--user-data-dir` is a unique `mkdtemp` under the
 *    harness-specific `pw-e2e-chrome-` prefix. Every kill/sweep below
 *    matches ONLY that prefix — never a bare process-name or
 *    `--remote-debugging-port` match — because the operator's own real
 *    Chrome legitimately runs with CDP enabled too (see the
 *    `browser-harness` skill) and must never be touched.
 *  - `close()` kills the tracked Chrome PID plus any surviving helper
 *    processes (GPU/renderer/utility) still carrying this instance's exact
 *    `--user-data-dir`, and waits briefly for real exit before removing the
 *    profile directory.
 *  - A defensive startup sweep runs on every `launch()`: it inspects every
 *    process whose command line carries the `pw-e2e-chrome-` prefix, but
 *    only kills the ones whose OWNING Node PID (encoded into that
 *    instance's own `--user-data-dir` name) is no longer alive — a crashed
 *    test process, a hard `vitest` timeout, `Ctrl-C`, or CI cancellation
 *    that skipped a file's `afterAll`. A still-live owner — the current
 *    process's own earlier instance, OR a concurrently-running peer
 *    Vitest worker file — is never touched, even though its Chrome shares
 *    the same generic prefix (2026-08 hardening: the sweep used to be
 *    unconditional and could cross-kill a still-in-use sibling instance).
 *  - Process-exit handlers (`exit`/`SIGINT`/`SIGTERM`) reap every live
 *    instance synchronously even when the owning test file's `afterAll`
 *    never runs at all. `exit` handlers cannot await async work, so this is
 *    a direct `SIGKILL`, not the graceful WS-close path `close()` uses.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

// Env override first (CHROME_PATH/CHROME_BIN — both common conventions,
// e.g. Puppeteer/Playwright and various CI Chrome setup actions use one or
// the other), then per-platform install paths, Linux last since this repo
// only develops on macOS but CI runs on Linux (confirmed live: PR #16's
// GH Actions shard 1/4 failed with "Chrome DevTools page target never
// became reachable" because CHROME_CANDIDATES[0] was unconditionally the
// macOS app-bundle path — it was never filtered for existence, only for
// being a defined string, so the Linux runner always tried to spawn a
// binary that was never there). Every candidate is now filtered by
// `existsSync` — only a path actually present on this machine is ever
// tried, and no candidate implies a clear "not found" error instead of a
// silent bad spawn.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
]
  .filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  .filter((value) => existsSync(value));

// Harness-specific `--user-data-dir` prefix. This is the ONLY signal every
// kill/sweep function below trusts to prove a process is ours — see the
// leak-proofing doc above. `USER_DATA_DIR_MARKER` is the generic,
// owner-agnostic substring every kill/sweep function greps `ps` output
// for; the actual prefix THIS process hands to `mkdtemp()` embeds this
// process's own PID right after it (`OWNED_USER_DATA_DIR_PREFIX`) so a
// sweep can tell "an orphan from a dead process" apart from "a live
// sibling's still-in-use instance" — see `findOwnedChromeProcesses`'s and
// `sweepStaleInstances`'s docs below.
const USER_DATA_DIR_MARKER = path.join(os.tmpdir(), "pw-e2e-chrome-");
const OWNED_USER_DATA_DIR_PREFIX = `${USER_DATA_DIR_MARKER}${process.pid}-`;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

/** Reserves a genuinely free ephemeral TCP port from the OS instead of
 * guessing inside a fixed range (same pattern as
 * `tests/server/PlatformRootPage.test.ts`'s `reservePort`). `new
 * Promise(executor)`, not `Promise.withResolvers` — this project targets
 * ES2022 lib (no ES2024). */
async function reserveDebugPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === "string") {
    listener.close();
    throw new Error("Failed to reserve a local debugging port");
  }
  await new Promise<void>((resolve, reject) =>
    listener.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
  return address.port;
}

/** Single `ps` snapshot of every process on the machine, reused by both
 * `findOwnedChromeProcesses` (to find `pw-e2e-chrome-` matches) and
 * `sweepStaleInstances` (to check an owner PID's liveness/command) so a
 * sweep costs exactly one `ps` call, not two. `-ww` disables BSD `ps`'s
 * default command-line truncation, so a long Chrome helper argv still
 * exposes the flag this needs. */
function listAllProcesses(): Array<{ pid: number; command: string }> {
  let output: string;
  try {
    output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  const processes: Array<{ pid: number; command: string }> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (match === null) continue;
    const [, pidText, command] = match;
    processes.push({ pid: Number(pidText), command });
  }
  return processes;
}

/** PID + exact `--user-data-dir` value for every live process PROVABLY
 * launched by this harness — matched on the `pw-e2e-chrome-` prefix, never
 * on process name or `--remote-debugging-port` alone — plus the owning
 * Node PID encoded right after that prefix (`OWNED_USER_DATA_DIR_PREFIX`),
 * so callers can tell a dead run's orphan apart from a live sibling's
 * still-in-use instance. `ownerPid` is `null` for a legacy/unowned
 * profile-dir name (pre-dating owner-PID encoding, or anything otherwise
 * not matching the `<pid>-` shape) — always safe to treat as sweepable,
 * matching this function's original always-attributable-to-nobody
 * behavior for those. Accepts an optional pre-fetched `ps` snapshot so
 * `sweepStaleInstances` can reuse the same one for its own owner-liveness
 * check. */
function findOwnedChromeProcesses(
  processes: Array<{ pid: number; command: string }> = listAllProcesses(),
): Array<{ pid: number; userDataDir: string; ownerPid: number | null }> {
  const marker = `--user-data-dir=${USER_DATA_DIR_MARKER}`;
  const owned: Array<{
    pid: number;
    userDataDir: string;
    ownerPid: number | null;
  }> = [];
  for (const { pid, command } of processes) {
    const markerIndex = command.indexOf(marker);
    if (markerIndex === -1) continue;
    const valueStart = markerIndex + "--user-data-dir=".length;
    const rest = command.slice(valueStart);
    // `ps` renders argv without preserving shell quoting. A temp root may
    // legitimately contain spaces (the managed ProxyWar workspace does), so
    // the first space is not the end of this value. Chrome's following argv
    // entries are flags; split only at the next ` --` boundary.
    const nextFlagIndex = rest.indexOf(" --");
    const userDataDir = (
      nextFlagIndex === -1 ? rest : rest.slice(0, nextFlagIndex)
    ).trimEnd();
    const ownerMatch = /^(\d+)-/.exec(
      userDataDir.slice(USER_DATA_DIR_MARKER.length),
    );
    owned.push({
      pid,
      userDataDir,
      ownerPid: ownerMatch === null ? null : Number(ownerMatch[1]),
    });
  }
  return owned;
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Is `ownerPid` still a live process that could legitimately still be
 * using its Chrome instance — this process's own earlier launch, or a
 * concurrently-running peer (another Vitest worker file, another owning
 * process entirely)? A bare "does the PID exist" check is not enough:
 * PIDs recycle, so a long-dead owner's PID could coincidentally now
 * belong to an unrelated process. `process.kill(pid, 0)` is the standard
 * Node liveness probe (no signal actually delivered); `ESRCH` means
 * definitively gone (safe to reap), `EPERM` means the PID exists but
 * isn't ours to signal (never assume that's safe to kill — treat as
 * alive). A live PID is further cross-checked against the SAME `ps`
 * snapshot `findOwnedChromeProcesses` already took (zero extra `ps`
 * calls) so a reused PID that no longer looks like a node process is
 * still correctly treated as dead. */
function isOwnerProcessAlive(
  ownerPid: number,
  commandByPid: Map<number, string>,
): boolean {
  if (ownerPid === process.pid) return true;
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException;
    return errnoError.code !== "ESRCH";
  }
  const command = commandByPid.get(ownerPid);
  return command === undefined || /\bnode\b/i.test(command);
}

/** Defensive startup sweep: kills only Chrome processes PROVABLY ours (see
 * `findOwnedChromeProcesses`'s doc) whose owning Node process is no longer
 * alive — the exact failure mode the 28-instance, 8+ hour leak audit
 * found (a crashed test process, a hard `vitest` timeout, `Ctrl-C`, or CI
 * cancellation that skipped a file's `afterAll`). A still-live owner is
 * never touched, even though its Chrome shares the same generic prefix —
 * this used to be unconditional and could cross-kill a concurrently
 * running sibling's still-in-use instance (2026-08 hardening). Cheap and
 * idempotent; harmless if nothing stale is found. */
function sweepStaleInstances(): void {
  const processes = listAllProcesses();
  const commandByPid = new Map(
    processes.map(({ pid, command }) => [pid, command]),
  );
  for (const { pid, ownerPid } of findOwnedChromeProcesses(processes)) {
    if (ownerPid !== null && isOwnerProcessAlive(ownerPid, commandByPid)) {
      continue;
    }
    killPid(pid);
  }
}

// Registered once per process: reaps every live instance even when the
// owning test file's `afterAll` never runs (a hard `vitest` timeout,
// `Ctrl-C`, or CI cancellation all skip it). See the leak-proofing doc at
// the top of this file.
const liveInstances = new Set<CdpBrowser>();
let exitHandlersInstalled = false;
function installExitHandlersOnce(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  const reapAll = (): void => {
    for (const instance of liveInstances) instance.killSync();
  };
  process.on("exit", reapAll);
  process.on("SIGINT", () => {
    reapAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    reapAll();
    process.exit(143);
  });
}

const STDERR_TAIL_MAX_BYTES = 4096;

/** Captures Chrome's stderr into a small, fixed-size tail — never the full
 * stream, since headless Chrome can stay alive for an entire e2e suite and
 * chatter continuously (GPU/ANGLE warnings etc. even on a healthy run) —
 * so a genuine startup failure's actual reason (sandbox error, crash,
 * missing shared-memory device, …) is visible in the thrown error instead
 * of vanishing into the previous blanket `stdio: "ignore"` (confirmed
 * live: GH Actions run 31131165725, PR26 shard 1/4 — Chrome (pid 2716)
 * was still an orphan process at job cleanup, meaning it spawned and kept
 * running; the actual reason its DevTools port never opened was
 * completely invisible with nothing ever captured from it). */
function captureStderrTail(child: ChildProcess): { describe: () => string } {
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX_BYTES);
  });
  return {
    describe: (): string =>
      tail.trim().length === 0
        ? ""
        : `\n--- chrome stderr (tail) ---\n${tail.trim()}`,
  };
}

// The prior fixed 15s deadline was never enough headroom on a real GH
// Actions runner: two independent failures (run 31131165725, PR26 shard
// 1/4; and push 10a29b0, PR25's own merge to main — branch-independent)
// both showed Chrome (pid 2716) still alive and un-crashed at job
// cleanup, spawned right alongside a coverage-instrumented sibling file
// under `--maxWorkers=2` on a 2-vCPU runner. The exact reason its
// DevTools port never opened in time was never directly proven — the
// prior blanket `stdio: "ignore"` meant Chrome's own stderr was never
// captured for either failure — but CPU contention with that coverage
// sibling is the evidence-correlated explanation, consistent with this
// file's own `FixtureServer.ts` live-premiere boot budget already
// documenting a ~3x local-vs-GH-Actions-CPU multiplier. 45s gives the
// same order-of-magnitude headroom; `captureStderrTail` above means a
// future recurrence will no longer be a blind guess.
// Overridable via `launch()`'s `discoveryTimeoutMs` option so tests can
// exercise the exact same timeout codepath without a real 45s wait.
const DEFAULT_DISCOVERY_TIMEOUT_MS = 45_000;

export class CdpBrowser {
  private process: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private userDataDir: string | null = null;
  private readonly eventWaiters = new Map<
    string,
    Array<(params: unknown) => void>
  >();

  /** `discoveryTimeoutMs` overrides the default DevTools-reachability
   * deadline (see `DEFAULT_DISCOVERY_TIMEOUT_MS`'s doc) — production
   * callers never pass it; tests use it to exercise the exact same
   * timeout/cleanup codepath in milliseconds instead of 45 real seconds. */
  static async launch(options?: {
    discoveryTimeoutMs?: number;
  }): Promise<CdpBrowser> {
    sweepStaleInstances();
    const browser = new CdpBrowser();
    await browser.start(
      options?.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    liveInstances.add(browser);
    installExitHandlersOnce();
    return browser;
  }

  private async start(discoveryTimeoutMs: number): Promise<void> {
    const chromePath = CHROME_CANDIDATES[0];
    if (chromePath === undefined) {
      throw new Error(
        "no Chrome binary found — set CHROME_PATH/CHROME_BIN or install Google Chrome/Chromium",
      );
    }
    try {
      // Everything from here on is covered by the `catch` below: a
      // failure can happen at ANY of these steps (disk-full/permission
      // `mkdtemp`, port exhaustion in `reserveDebugPort`, a bad spawn, a
      // slow/crashed Chrome, or the final CDP handshake) and each leaves
      // a different subset of `userDataDir`/`process`/`ws` set — `close()`
      // already no-ops whichever of those was never reached, so it is the
      // one idempotent teardown path for every case here, not just a
      // successful session's.
      this.userDataDir = await mkdtemp(OWNED_USER_DATA_DIR_PREFIX);
      const port = await reserveDebugPort();
      this.process = spawn(
        chromePath,
        [
          `--remote-debugging-port=${port}`,
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${this.userDataDir}`,
          "about:blank",
        ],
        // stdout stays ignored (Chrome puts nothing actionable there);
        // stderr is now piped into a bounded tail buffer instead of the
        // prior blanket `stdio: "ignore"` — see `captureStderrTail`'s doc
        // for the live GH Actions evidence this closes the gap on.
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const chromeProcess = this.process;
      const stderrTail = captureStderrTail(chromeProcess);
      // Fail-fast diagnostics: `spawn()` never throws synchronously for a
      // bad binary — it emits an async `error` event instead (e.g.
      // `ENOENT`) — and a Chrome that spawns fine but then crashes before
      // opening its DevTools port only ever emits `exit`, never `error`.
      // Without racing BOTH here, either failure mode burns the full
      // `discoverWebSocketUrl` wait below for the same generic, unhelpful
      // message — confirmed live: PR #16's GH Actions shard 1/4 hit the
      // spawn-error case; PR26's shard 1/4 (and push 10a29b0, PR25's own
      // merge to main) hit the still-alive-but-silent case the stderr tail
      // above now also captures. Every listener here is scoped to this
      // race and removed once it settles either way, so nothing leaks
      // past startup.
      let onSpawnError: ((error: Error) => void) | null = null;
      let onExit:
        | ((code: number | null, signal: NodeJS.Signals | null) => void)
        | null = null;
      // Plain mutable flag, not an `AbortController`/listener — polled
      // once per 200ms loop tick in `discoverWebSocketUrl` below, so the
      // moment `chromeFailure` wins this race, that loop's NEXT tick sees
      // it and returns immediately instead of continuing to poll
      // `/json/list` in the background for up to `discoveryTimeoutMs`
      // (45s by default) after `start()` has already thrown.
      const discoveryCancelled = { value: false };
      // `new Promise(executor)`, not `Promise.withResolvers` — this
      // project targets ES2022 lib (no ES2024), same constraint as
      // `reserveDebugPort`'s doc above.
      const chromeFailure = new Promise<never>((_, reject) => {
        onSpawnError = (error: Error): void => {
          discoveryCancelled.value = true;
          reject(
            new Error(
              `Chrome process failed to start (${chromePath}): ${error.message}`,
            ),
          );
        };
        onExit = (code, signal): void => {
          discoveryCancelled.value = true;
          reject(
            new Error(
              `Chrome process exited before its DevTools port became ` +
                `reachable (${chromePath}, code=${code ?? "null"}, ` +
                `signal=${signal ?? "null"})${stderrTail.describe()}`,
            ),
          );
        };
        chromeProcess.once("error", onSpawnError);
        chromeProcess.once("exit", onExit);
      });
      let wsUrl: string;
      try {
        wsUrl = await Promise.race([
          this.discoverWebSocketUrl(
            port,
            discoveryTimeoutMs,
            chromeProcess,
            chromePath,
            discoveryCancelled,
            stderrTail,
          ),
          chromeFailure,
        ]);
      } finally {
        if (onSpawnError !== null) {
          chromeProcess.removeListener("error", onSpawnError);
        }
        if (onExit !== null) {
          chromeProcess.removeListener("exit", onExit);
        }
      }
      this.ws = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        this.ws?.once("open", () => resolve());
        this.ws?.once("error", reject);
      });
      this.ws.on("message", (data) => this.handleMessage(data.toString()));
      await this.send("Page.enable");
      await this.send("Runtime.enable");
      await this.send("Network.enable");
      // Chrome's HTTP disk cache is not reliably isolated per `--user-data-dir`
      // in headless mode — confirmed live: a fresh profile still served a
      // stale `read-model.json` from an earlier debug run on the same port.
      // Puppeteer/Playwright both disable this by default for exactly this
      // reason.
      await this.send("Network.setCacheDisabled", { cacheDisabled: true });
    } catch (error) {
      // A `start()` that throws here never reaches `liveInstances.add()` in
      // `launch()`, so no exit handler or future `sweepStaleInstances()`
      // call is tracking this instance yet — without this, a failed start
      // leaks exactly like GH Actions run 31131165725 showed: the runner's
      // own generic orphan-process reaper had to terminate the leftover
      // `chrome` process (pid 2716) plus two `chrome_crashpad_handler`
      // children this class never touched.
      await this.close();
      throw error;
    }
  }

  private async discoverWebSocketUrl(
    port: number,
    discoveryTimeoutMs: number,
    chromeProcess: ChildProcess,
    chromePath: string,
    cancelled: { value: boolean },
    stderrTail?: { describe: () => string },
  ): Promise<string> {
    const deadline = Date.now() + discoveryTimeoutMs;
    while (Date.now() < deadline && !cancelled.value) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (response.ok) {
          const targets = (await response.json()) as Array<{
            type: string;
            webSocketDebuggerUrl: string;
          }>;
          const page = targets.find((target) => target.type === "page");
          if (page !== undefined) return page.webSocketDebuggerUrl;
        }
      } catch {
        // not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (cancelled.value) {
      // The race's other branch (spawn error / early exit) already won
      // and reported the real, more specific error — this settlement is
      // discarded by `Promise.race`, so stay cheap and skip the full
      // stderr-tail formatting work below.
      throw new Error(
        "Chrome DevTools discovery cancelled — a startup failure already reported the real error",
      );
    }
    // `code`/`signal` are both null while the process is still alive —
    // exactly the state GH Actions run 31131165725 and push 10a29b0 both
    // showed (Chrome pid 2716 still an orphan process at job cleanup).
    const processState =
      chromeProcess.exitCode !== null || chromeProcess.signalCode !== null
        ? `exited (code=${chromeProcess.exitCode ?? "null"}, signal=${chromeProcess.signalCode ?? "null"})`
        : "still running";
    throw new Error(
      `Chrome DevTools page target never became reachable ` +
        `(path=${chromePath}, timeoutMs=${discoveryTimeoutMs}, ` +
        `process=${processState})${stderrTail?.describe() ?? ""}`,
    );
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as CdpMessage;
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new Error(message.error.message));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (message.method !== undefined) {
      const waiters = this.eventWaiters.get(message.method);
      if (waiters !== undefined) {
        for (const waiter of waiters) waiter(message.params);
      }
    }
  }

  send(method: string, params: unknown = {}): Promise<unknown> {
    if (this.ws === null) throw new Error("browser not started");
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  private waitForEvent(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.eventWaiters.get(method) ?? [];
        this.eventWaiters.set(
          method,
          list.filter((entry) => entry !== handler),
        );
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const handler = (params: unknown): void => {
        clearTimeout(timer);
        resolve(params);
      };
      const list = this.eventWaiters.get(method) ?? [];
      list.push(handler);
      this.eventWaiters.set(method, list);
    });
  }

  on(method: string, handler: (params: unknown) => void): void {
    const list = this.eventWaiters.get(method) ?? [];
    list.push(handler);
    this.eventWaiters.set(method, list);
  }

  off(method: string, handler: (params: unknown) => void): void {
    const list = this.eventWaiters.get(method) ?? [];
    this.eventWaiters.set(
      method,
      list.filter((entry) => entry !== handler),
    );
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
  }

  async goto(url: string): Promise<void> {
    const loadPromise = this.waitForEvent("Page.loadEventFired", 20_000);
    await this.send("Page.navigate", { url });
    await loadPromise;
    // Client-side JS (custom element mount + async read-model fetch) keeps
    // the network busy briefly after the load event fires; wait for it to
    // go quiet (mirrors the working manual verification's
    // `waitUntil: "networkidle0"`) instead of a fixed, fragile delay.
    await this.waitForNetworkIdle(5000);
  }

  private async waitForNetworkIdle(timeoutMs: number): Promise<void> {
    let inFlight = 0;
    let idleSince = Date.now();
    const onRequest = (): void => {
      inFlight++;
      idleSince = Date.now();
    };
    const onFinished = (): void => {
      inFlight = Math.max(0, inFlight - 1);
      idleSince = Date.now();
    };
    this.on("Network.requestWillBeSent", onRequest);
    this.on("Network.loadingFinished", onFinished);
    this.on("Network.loadingFailed", onFinished);
    try {
      await this.send("Network.enable");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (inFlight === 0 && Date.now() - idleSince >= 300) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      this.off("Network.requestWillBeSent", onRequest);
      this.off("Network.loadingFinished", onFinished);
      this.off("Network.loadingFailed", onFinished);
    }
  }

  /** Evaluates an expression string in the page and returns its JSON-serializable value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails !== undefined) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  /** Fetches the HTTP status of the current document via a same-origin XHR-free check: re-fetches the URL. Prefer `httpStatus(url)` for a pure status check without navigating. */
  async httpStatus(url: string): Promise<number> {
    return this.evaluate<number>(
      `fetch(${JSON.stringify(url)}, { redirect: "manual" }).then(r => r.status)`,
    );
  }

  async textContent(): Promise<string> {
    return this.evaluate<string>(
      `document.body.textContent.replace(/\\s+/g, " ").trim()`,
    );
  }

  async click(selector: string): Promise<void> {
    const clicked = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()
    `);
    if (!clicked) {
      throw new Error(`no element matched selector ${selector}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  async waitFor(predicateExpression: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.evaluate<boolean>(predicateExpression);
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`waitFor timed out: ${predicateExpression}`);
  }

  /** Synchronous best-effort kill for the `process.on("exit", ...)` path,
   * where async work cannot run. Kills the tracked top-level Chrome PID
   * plus any surviving helper process (GPU/renderer/utility) still
   * carrying this instance's exact `--user-data-dir` — Chrome is not
   * always reliable about reaping its own helpers when the top-level
   * process is force-killed rather than shut down gracefully. */
  killSync(): void {
    if (this.process?.pid !== undefined) killPid(this.process.pid);
    if (this.userDataDir !== null) {
      for (const { pid, userDataDir } of findOwnedChromeProcesses()) {
        if (userDataDir === this.userDataDir) killPid(pid);
      }
    }
  }

  /** Graceful teardown. Also `start()`'s ONE cleanup path on a failed
   * launch (see `start()`'s `catch` block) — every step here already
   * no-ops correctly for whichever of `ws`/`process`/`userDataDir` a
   * given failure never got around to setting, so a failed start needs
   * no separate bespoke cleanup routine. */
  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    // Skip the wait entirely when the process has already exited (e.g. a
    // `start()` failure whose own race already observed the `exit` event)
    // — a `once("exit", ...)` registered after the fact would otherwise
    // never fire, stalling this method for the full 2s fallback below on
    // every one of those closes for no reason.
    const alreadyExited =
      this.process !== null &&
      (this.process.exitCode !== null || this.process.signalCode !== null);
    const exited =
      this.process === null || alreadyExited
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
            this.process?.once("exit", () => resolve()),
          );
    this.killSync();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.userDataDir !== null) {
      await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {
        // best-effort cleanup
      });
    }
    liveInstances.delete(this);
  }
}
