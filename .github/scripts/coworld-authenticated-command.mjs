#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const allowedCommands = new Set([
  "episodes",
  "leagues",
  "list",
  "next-version",
  "replay-open",
  "status",
  "upload-coworld",
]);

const [command, ...args] = process.argv.slice(2);
const token = process.env.COWORLD_API_TOKEN;
const python = process.env.COWORLD_PYTHON;
const coworld = process.env.COWORLD_BIN;
const runnerTemp = resolve(process.env.RUNNER_TEMP ?? tmpdir());

if (!allowedCommands.has(command)) {
  throw new Error(
    `authenticated Coworld command is not allowlisted: ${command}`,
  );
}
if (!token || !python || !coworld) {
  throw new Error(
    "COWORLD_API_TOKEN, COWORLD_PYTHON, and COWORLD_BIN are required",
  );
}

const authHome = mkdtempSync(join(runnerTemp, "coworld-auth-"));
if (!resolve(authHome).startsWith(`${runnerTemp}/`)) {
  throw new Error(`unexpected credential directory: ${authHome}`);
}
const childEnv = { ...process.env, HOME: authHome };
delete childEnv.COWORLD_API_TOKEN;

try {
  const install = spawnSync(
    python,
    [
      "-c",
      "import os; from softmax.auth import save_user_token; save_user_token(server='https://softmax.com/api', token=os.environ['COWORLD_API_TOKEN'])",
    ],
    {
      env: { ...childEnv, COWORLD_API_TOKEN: token },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (install.status !== 0) {
    throw new Error("failed to install ephemeral Coworld credential");
  }

  const result = spawnSync(coworld, [command, ...args], {
    env: childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(authHome, { recursive: true, force: true });
}
