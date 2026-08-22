#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const allowedCommands = new Set([
  "commander-xp-episode-bundle",
  "episode-logs",
  "episodes",
  "leagues",
  "list",
  "next-version",
  "replay-open",
  "status",
  "upload-coworld",
  "xp-request",
]);

const [command, ...args] = process.argv.slice(2);
const token = process.env.COWORLD_API_TOKEN;
const python = process.env.COWORLD_PYTHON;
const coworld = process.env.COWORLD_BIN;
const runnerTemp = realpathSync(resolve(process.env.RUNNER_TEMP ?? tmpdir()));

function exactRunnerTempInput(value) {
  if (typeof value !== "string" || resolve(value) !== value) return false;
  try {
    const real = realpathSync(value);
    return (
      real.startsWith(`${runnerTemp}/`) &&
      !lstatSync(value).isSymbolicLink() &&
      statSync(real).isFile()
    );
  } catch {
    return false;
  }
}

if (!allowedCommands.has(command)) {
  throw new Error(
    `authenticated Coworld command is not allowlisted: ${command}`,
  );
}
if (
  command === "xp-request" &&
  !(
    (args.length === 3 &&
      args[0] === "get" &&
      /^xreq_[A-Za-z0-9-]+$/.test(args[1] ?? "") &&
      args[2] === "--json") ||
    (args.length === 3 &&
      args[0] === "create" &&
      exactRunnerTempInput(args[1]) &&
      args[1].endsWith(".json") &&
      args[2] === "--json")
  )
) {
  throw new Error("authenticated Coworld xp-request mode is malformed");
}
if (
  command === "episode-logs" &&
  !(
    args.length === 6 &&
    /^ereq_[A-Za-z0-9-]+$/.test(args[0] ?? "") &&
    args[1] === "--agent" &&
    /^[0-3]$/.test(args[2] ?? "") &&
    args[3] === "--artifact" &&
    args[4] === "--output" &&
    typeof args[5] === "string" &&
    resolve(args[5]) === args[5]
  )
) {
  throw new Error("authenticated Coworld episode-logs mode is malformed");
}
if (
  command === "commander-xp-episode-bundle" &&
  !(
    args.length === 2 &&
    /^ereq_[A-Za-z0-9-]+$/.test(args[0] ?? "") &&
    typeof args[1] === "string" &&
    resolve(args[1]) === args[1]
  )
) {
  throw new Error("authenticated Coworld episode bundle mode is malformed");
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
      "import importlib.metadata, os; assert importlib.metadata.version('coworld') == '0.1.42'; from softmax.auth import save_user_token; save_user_token(server='https://softmax.com/api', token=os.environ['COWORLD_API_TOKEN'])",
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

  const executable =
    command === "commander-xp-episode-bundle" ? python : coworld;
  const executableArgs =
    command === "commander-xp-episode-bundle"
      ? [
          resolve(
            import.meta.dirname,
            "../../coworld-adapter/scripts/fetch-commander-xp-episode-bundle.py",
          ),
          ...args,
        ]
      : [command, ...args];
  const result = spawnSync(executable, executableArgs, {
    env: childEnv,
    // Hosted `coworld list --json` grows with immutable release history and is
    // already larger than Node's 1 MiB spawnSync buffer. Stream the trusted
    // CLI output directly to this wrapper's descriptors so shell redirects and
    // `tee` keep working without an artificial in-memory ceiling.
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(authHome, { recursive: true, force: true });
}
