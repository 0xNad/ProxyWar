#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const viewerUrl = process.argv[2];
if (!viewerUrl) throw new Error("published replay viewer URL is required");
const parsed = new URL(viewerUrl);
if (parsed.protocol !== "https:" || !parsed.searchParams.get("replay")) {
  throw new Error("viewer URL must be HTTPS and contain a replay query");
}

const chrome = [
  process.env.CHROME_PATH,
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error("Chrome or Chromium was not found");

const profile = mkdtempSync(
  join(process.env.RUNNER_TEMP ?? tmpdir(), "proxywar-published-replay-"),
);
const child = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4000);
});

let socket;
try {
  const portFile = join(profile, "DevToolsActivePort");
  const portDeadline = Date.now() + 15_000;
  while (!existsSync(portFile) && Date.now() < portDeadline) await delay(100);
  if (!existsSync(portFile))
    throw new Error(`Chrome did not expose DevTools: ${stderr}`);
  const port = Number.parseInt(
    readFileSync(portFile, "utf8").split("\n")[0],
    10,
  );
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
    (response) => response.json(),
  );
  const target = targets.find((entry) => entry.type === "page");
  if (!target?.webSocketDebuggerUrl)
    throw new Error("Chrome page target was not found");

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    const result = new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
    socket.send(JSON.stringify({ id, method, params }));
    return result;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: viewerUrl });
  const deadline = Date.now() + 45_000;
  let evidence;
  while (Date.now() < deadline) {
    const evaluated = await send("Runtime.evaluate", {
      expression: `(() => {
        const canvas = document.querySelector("canvas");
        const progress = document.querySelector('[aria-label*="Replay position"]');
        const text = document.body?.textContent ?? "";
        return {
          ready: document.readyState === "complete",
          title: document.title,
          canvasCount: document.querySelectorAll("canvas").length,
          canvasWidth: canvas?.width ?? 0,
          canvasHeight: canvas?.height ?? 0,
          replayProgress: progress?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
          hasError: /failed to (load|fetch)|replay error/i.test(text),
        };
      })()`,
      returnByValue: true,
    });
    evidence = evaluated.result.value;
    if (
      evidence?.ready &&
      evidence.canvasCount > 0 &&
      evidence.canvasWidth > 0 &&
      evidence.canvasHeight > 0 &&
      /^\d+ \/ \d+$/.test(evidence.replayProgress) &&
      !evidence.hasError
    ) {
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
      process.exitCode = 0;
      break;
    }
    await delay(250);
  }
  if (process.exitCode === undefined) {
    throw new Error(
      `published replay did not initialize: ${JSON.stringify(evidence)}`,
    );
  }
} finally {
  socket?.close();
  child.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
