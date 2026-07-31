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
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  process.env.CHROME_PATH,
].filter((value): value is string => typeof value === "string");

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
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
    const browser = new CdpBrowser();
    await browser.start();
    return browser;
  }

  private async start(): Promise<void> {
    const chromePath = CHROME_CANDIDATES[0];
    if (chromePath === undefined) {
      throw new Error(
        "no Chrome binary found — set CHROME_PATH or install Google Chrome",
      );
    }
    this.userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "pw-e2e-chrome-"),
    );
    const port = 9200 + Math.floor(Math.random() * 500);
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
    const wsUrl = await this.discoverWebSocketUrl(port);
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

  async waitFor(
    predicateExpression: string,
    timeoutMs = 8000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.evaluate<boolean>(predicateExpression);
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`waitFor timed out: ${predicateExpression}`);
  }

  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    if (this.process?.pid !== undefined) {
      try {
        this.process.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    if (this.userDataDir !== null) {
      await rm(this.userDataDir, { recursive: true, force: true }).catch(
        () => {
          // best-effort cleanup
        },
      );
    }
  }
}
