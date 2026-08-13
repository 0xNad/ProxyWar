#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 5_000;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function runNpmCi(args) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, ["ci", ...args], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function runWithRetry({
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  runAttempt,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  warn = (message) => process.stderr.write(`::warning::${message}\n`),
}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error("delayMs must be a non-negative integer");
  }
  if (typeof runAttempt !== "function") {
    throw new Error("runAttempt must be a function");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const exitCode = await runAttempt(attempt);
    if (exitCode === 0) return 0;
    if (attempt === attempts) return exitCode;

    const waitMs = delayMs * 2 ** (attempt - 1);
    warn(
      `npm ci attempt ${attempt}/${attempts} failed with exit code ${exitCode}; retrying in ${waitMs}ms`,
    );
    await sleep(waitMs);
  }
  return 1;
}

async function main() {
  const attempts = positiveInteger(
    process.env.PROXYWAR_NPM_CI_ATTEMPTS,
    DEFAULT_ATTEMPTS,
  );
  const delayMs = positiveInteger(
    process.env.PROXYWAR_NPM_CI_RETRY_DELAY_MS,
    DEFAULT_DELAY_MS,
  );
  process.exitCode = await runWithRetry({
    attempts,
    delayMs,
    runAttempt: () => runNpmCi(process.argv.slice(2)),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
