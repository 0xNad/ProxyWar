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
 *  - A defensive startup sweep runs on every `launch()`: it kills any
 *    process whose command line carries the `pw-e2e-chrome-` prefix and is
 *    still alive from a run that never tore down cleanly (a crashed test
 *    process, a hard `vitest` timeout, `Ctrl-C`, or CI cancellation all
 *    skip a file's `afterAll`).
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
// leak-proofing doc above.
const USER_DATA_DIR_PREFIX = path.join(os.tmpdir(), "pw-e2e-chrome-");

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

/** PID + exact `--user-data-dir` value for every live process PROVABLY
 * launched by this harness — matched on the `pw-e2e-chrome-` prefix, never
 * on process name or `--remote-debugging-port` alone. `-ww` disables BSD
 * `ps`'s default command-line truncation, so a long Chrome helper argv
 * still exposes the flag this needs. */
function findOwnedChromeProcesses(): Array<{
  pid: number;
  userDataDir: string;
}> {
  let output: string;
  try {
    output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  const marker = `--user-data-dir=${USER_DATA_DIR_PREFIX}`;
  const owned: Array<{ pid: number; userDataDir: string }> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (match === null) continue;
    const [, pidText, command] = match;
    const markerIndex = command.indexOf(marker);
    if (markerIndex === -1) continue;
    const valueStart = markerIndex + "--user-data-dir=".length;
    const rest = command.slice(valueStart);
    const spaceIndex = rest.indexOf(" ");
    const userDataDir = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
    owned.push({ pid: Number(pidText), userDataDir });
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

/** Defensive startup sweep: kills only Chrome processes PROVABLY ours (see
 * `findOwnedChromeProcesses`'s doc) that are still around from a run that
 * never tore down cleanly — the exact failure mode the 28-instance, 8+
 * hour leak audit found. Cheap and idempotent; harmless if nothing stale is
 * found. */
function sweepStaleInstances(): void {
  for (const { pid } of findOwnedChromeProcesses()) killPid(pid);
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

  static async launch(): Promise<CdpBrowser> {
    sweepStaleInstances();
    const browser = new CdpBrowser();
    await browser.start();
    liveInstances.add(browser);
    installExitHandlersOnce();
    return browser;
  }

  private async start(): Promise<void> {
    const chromePath = CHROME_CANDIDATES[0];
    if (chromePath === undefined) {
      throw new Error(
        "no Chrome binary found — set CHROME_PATH/CHROME_BIN or install Google Chrome/Chromium",
      );
    }
    this.userDataDir = await mkdtemp(USER_DATA_DIR_PREFIX);
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
      { stdio: "ignore" },
    );
    const chromeProcess = this.process;
    // Fail-fast diagnostic: `spawn()` never throws synchronously for a bad
    // binary — it emits an async `error` event instead (e.g.
    // `ENOENT`). Without racing that here, a bad spawn silently does
    // nothing and `discoverWebSocketUrl` below just times out after its
    // own generic 15s wait with an unhelpful "page target never became
    // reachable" message — confirmed live as the exact failure PR #16's
    // GH Actions shard 1/4 hit. The listener is scoped to this race and
    // removed once it settles either way, so it never leaks past startup.
    let onSpawnError: ((error: Error) => void) | null = null;
    const spawnFailure = new Promise<never>((_, reject) => {
      onSpawnError = (error: Error): void => {
        reject(
          new Error(
            `Chrome process failed to start (${chromePath}): ${error.message}`,
          ),
        );
      };
      chromeProcess.once("error", onSpawnError);
    });
    let wsUrl: string;
    try {
      wsUrl = await Promise.race([
        this.discoverWebSocketUrl(port),
        spawnFailure,
      ]);
    } finally {
      if (onSpawnError !== null) {
        chromeProcess.removeListener("error", onSpawnError);
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
  }

  private async discoverWebSocketUrl(port: number): Promise<string> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
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
    throw new Error("Chrome DevTools page target never became reachable");
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

  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    const exited =
      this.process === null
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
