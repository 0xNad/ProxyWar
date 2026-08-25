#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const allowedCommands = new Set([
  "commander-public-base-materialize",
  "commander-xp-episode-bundle",
  "commander-xp-policy-provision",
  "commander-xp-run-episode",
  "commander-xp-certify",
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

function exactRunnerTempDirectoryInput(value) {
  if (typeof value !== "string" || resolve(value) !== value) return false;
  try {
    const real = realpathSync(value);
    if (
      !(
        real.startsWith(`${runnerTemp}/`) &&
        !lstatSync(value).isSymbolicLink() &&
        statSync(real).isDirectory()
      )
    )
      return false;
    const visit = (directory) =>
      readdirSync(directory, { withFileTypes: true }).every((entry) => {
        const target = join(directory, entry.name);
        const metadata = lstatSync(target);
        if (metadata.isSymbolicLink()) return false;
        const resolved = realpathSync(target);
        if (!resolved.startsWith(`${real}/`)) return false;
        return entry.isDirectory() ? visit(target) : entry.isFile();
      });
    return visit(real);
  } catch {
    return false;
  }
}

function exactRunnerTempOutput(value) {
  if (typeof value !== "string" || resolve(value) !== value) return false;
  try {
    try {
      lstatSync(value);
      return false;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    const declaredParent = dirname(value);
    const parent = realpathSync(declaredParent);
    const parentStat = lstatSync(declaredParent);
    if (
      parent !== declaredParent ||
      dirname(parent) !== runnerTemp ||
      parentStat.isSymbolicLink() ||
      !parentStat.isDirectory() ||
      (parentStat.mode & 0o077) !== 0
    ) {
      return false;
    }
    return true;
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
      args[2] === "--json") ||
    (args.length === 7 &&
      args[0] === "list" &&
      args[1] === "--mine" &&
      args[2] === "--limit" &&
      args[3] === "1000" &&
      args[4] === "--offset" &&
      /^(?:0|[1-9][0-9]*)$/.test(args[5] ?? "") &&
      args[6] === "--json")
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
    exactRunnerTempOutput(args[5])
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
    exactRunnerTempOutput(args[1])
  )
) {
  throw new Error("authenticated Coworld episode bundle mode is malformed");
}
if (command === "commander-xp-run-episode") {
  const [manifest, ...tail] = args;
  const images = tail.slice(0, 4);
  const output = tail[14];
  if (
    args.length !== 16 ||
    !exactRunnerTempInput(manifest) ||
    !manifest.endsWith(".json") ||
    images.length !== 4 ||
    new Set(images).size !== 1 ||
    images.some(
      (image) =>
        !/^ghcr\.io\/0xnad\/proxywar-commander-xp-policy@sha256:[0-9a-f]{64}$/.test(
          image,
        ),
    ) ||
    tail[4] !== "--run" ||
    tail[5] !== "node" ||
    tail[6] !== "--run" ||
    tail[7] !== "/app/proxywar/coworld-adapter/src/starter-player.mjs" ||
    tail[8] !== "--variant" ||
    tail[9] !== "tournament-4p-pangaea" ||
    tail[10] !== "--timeout-seconds" ||
    tail[11] !== "6000" ||
    tail[12] !== "--verify-replay" ||
    tail[13] !== "--output-dir" ||
    !exactRunnerTempOutput(output)
  ) {
    throw new Error("authenticated Coworld run-episode mode is malformed");
  }
}
if (
  command === "commander-xp-certify" &&
  !(
    args.length === 4 &&
    exactRunnerTempInput(args[0]) &&
    args[0].endsWith(".json") &&
    args[1] === "--timeout-seconds" &&
    args[2] === "600" &&
    args[3] === "--no-open-report"
  )
) {
  throw new Error("authenticated Coworld certify mode is malformed");
}
if (command === "commander-xp-policy-provision") {
  const [mode, ...options] = args;
  const parsed = new Map(
    options.map((entry) => {
      const match = entry.match(/^--([a-z][a-z-]*)=(.+)$/);
      if (!match) return ["", ""];
      return [match[1], match[2]];
    }),
  );
  const expectedKeys = new Set([
    "bedrock-model",
    "build-provenance-digest",
    "image",
    "name-prefix",
    "oci-digest",
    "source-provenance-digest",
    "source-sha",
    "source-tree-sha",
    ...(mode === "upload" ? ["allow-remote-adoption", "output"] : []),
    ...(mode === "upload" && parsed.has("recovery") ? ["recovery"] : []),
  ]);
  const output = parsed.get("output");
  if (
    !new Set(["check", "upload"]).has(mode) ||
    parsed.size !== options.length ||
    parsed.size !== expectedKeys.size ||
    [...parsed.keys()].some((key) => !expectedKeys.has(key)) ||
    !/^ghcr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(
      parsed.get("image") ?? "",
    ) ||
    !/^[a-z0-9][a-z0-9-]{7,119}$/.test(parsed.get("name-prefix") ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(
      parsed.get("bedrock-model") ?? "",
    ) ||
    !/^[0-9a-f]{40}$/.test(parsed.get("source-sha") ?? "") ||
    !/^[0-9a-f]{40}$/.test(parsed.get("source-tree-sha") ?? "") ||
    [
      parsed.get("oci-digest"),
      parsed.get("source-provenance-digest"),
      parsed.get("build-provenance-digest"),
    ].some((value) => !/^sha256:[0-9a-f]{64}$/.test(value ?? "")) ||
    (mode === "upload" &&
      !new Set(["true", "false"]).has(
        parsed.get("allow-remote-adoption") ?? "",
      )) ||
    (mode === "upload" && !exactRunnerTempOutput(output)) ||
    (parsed.has("recovery") &&
      !exactRunnerTempDirectoryInput(parsed.get("recovery")))
  ) {
    throw new Error(
      "authenticated Coworld Commander XP policy provision mode is malformed",
    );
  }
}
if (command === "commander-public-base-materialize") {
  const [mode, ...options] = args;
  const parsed = new Map(
    options.map((entry) => {
      const match = entry.match(/^--([a-z][a-z-]*)=(.+)$/);
      if (!match) return ["", ""];
      return [match[1], match[2]];
    }),
  );
  const expectedKeys = new Set([
    "build-provenance-digest",
    "image",
    "oci-digest",
    "policy-name",
    "source-provenance-digest",
    "source-sha",
    "source-tree-sha",
    ...(mode === "upload" ? ["output"] : []),
    ...(mode === "upload" && parsed.has("recovery") ? ["recovery"] : []),
  ]);
  if (
    !new Set(["check", "upload"]).has(mode) ||
    parsed.size !== options.length ||
    parsed.size !== expectedKeys.size ||
    [...parsed.keys()].some((key) => !expectedKeys.has(key)) ||
    !/^ghcr\.io\/0xnad\/proxywar-commander-public-base@sha256:[0-9a-f]{64}$/.test(
      parsed.get("image") ?? "",
    ) ||
    !/^proxywar-commander-public-base-[0-9a-f]{20}$/.test(
      parsed.get("policy-name") ?? "",
    ) ||
    !/^[0-9a-f]{40}$/.test(parsed.get("source-sha") ?? "") ||
    !/^[0-9a-f]{40}$/.test(parsed.get("source-tree-sha") ?? "") ||
    [
      parsed.get("oci-digest"),
      parsed.get("source-provenance-digest"),
      parsed.get("build-provenance-digest"),
    ].some((value) => !/^sha256:[0-9a-f]{64}$/.test(value ?? "")) ||
    (mode === "upload" && !exactRunnerTempOutput(parsed.get("output"))) ||
    (parsed.has("recovery") &&
      !exactRunnerTempDirectoryInput(parsed.get("recovery")))
  ) {
    throw new Error(
      "authenticated Coworld Commander public-base materialization mode is malformed",
    );
  }
}
if (
  command === "episodes" &&
  !(
    args.length === 2 &&
    /^ereq_[A-Za-z0-9-]+$/.test(args[0] ?? "") &&
    args[1] === "--json"
  )
) {
  throw new Error("authenticated Coworld episodes mode is malformed");
}
if (
  command === "replay-open" &&
  !(
    args.length === 3 &&
    /^ereq_[A-Za-z0-9-]+$/.test(args[0] ?? "") &&
    args[1] === "--hosted" &&
    args[2] === "--no-open-browser"
  )
) {
  throw new Error("authenticated Coworld replay-open mode is malformed");
}
if (
  command === "status" &&
  !(
    args.length === 2 &&
    /^cow_[A-Za-z0-9-]+$/.test(args[0] ?? "") &&
    args[1] === "--json"
  )
) {
  throw new Error("authenticated Coworld status mode is malformed");
}
if (
  command === "leagues" &&
  !(
    args.length === 2 &&
    /^league_[A-Za-z0-9-]+$/.test(args[0] ?? "") &&
    args[1] === "--json"
  )
) {
  throw new Error("authenticated Coworld leagues mode is malformed");
}
if (command === "list" && !(args.length === 1 && args[0] === "--json")) {
  throw new Error("authenticated Coworld list mode is malformed");
}
if (
  command === "next-version" &&
  !(args.length === 1 && /^[a-z0-9][a-z0-9-]{7,119}$/.test(args[0] ?? ""))
) {
  throw new Error("authenticated Coworld next-version mode is malformed");
}
if (
  command === "upload-coworld" &&
  !(
    args.length === 9 &&
    exactRunnerTempInput(args[0]) &&
    args[0].endsWith(".json") &&
    args[1] === "--wait-hosted-smoke" &&
    args[2] === "--wait-certification" &&
    args[3] === "--timeout-seconds" &&
    args[4] === "600" &&
    args[5] === "--hosted-smoke-timeout-seconds" &&
    args[6] === "1800" &&
    args[7] === "--certification-timeout-seconds" &&
    args[8] === "1800"
  )
) {
  throw new Error("authenticated Coworld upload mode is malformed");
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
const childEnv = {
  HOME: authHome,
  LANG: process.env.LANG ?? "C.UTF-8",
  LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
  PATH: process.env.PATH ?? "",
  PYTHONUNBUFFERED: "1",
  TEMP: runnerTemp,
  TMP: runnerTemp,
  TMPDIR: runnerTemp,
  TZ: "UTC",
};
if (!childEnv.PATH) {
  throw new Error("authenticated Coworld child PATH is unavailable");
}
if (command === "upload-coworld") {
  const realDocker = process.env.COWORLD_REAL_DOCKER;
  if (!realDocker || resolve(realDocker) !== realDocker) {
    throw new Error("upload-coworld requires an absolute COWORLD_REAL_DOCKER");
  }
  childEnv.COWORLD_REAL_DOCKER = realDocker;
  const certificationCache = process.env.XDG_CACHE_HOME;
  if (
    !certificationCache ||
    !exactRunnerTempDirectoryInput(certificationCache)
  ) {
    throw new Error(
      "upload-coworld requires an exact runner-temp XDG_CACHE_HOME",
    );
  }
  childEnv.XDG_CACHE_HOME = certificationCache;
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    if (!/^unix:\/\/[A-Za-z0-9._/-]+$/.test(dockerHost)) {
      throw new Error("upload-coworld requires a local Unix DOCKER_HOST");
    }
    childEnv.DOCKER_HOST = dockerHost;
  }
}

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
    command === "commander-public-base-materialize" ||
    command === "commander-xp-episode-bundle" ||
    command === "commander-xp-policy-provision"
      ? python
      : coworld;
  const executableArgs =
    command === "commander-public-base-materialize"
      ? [
          resolve(import.meta.dirname, "commander-public-base-materialize.py"),
          ...args,
        ]
      : command === "commander-xp-episode-bundle"
        ? [
            resolve(
              import.meta.dirname,
              "../../coworld-adapter/scripts/fetch-commander-xp-episode-bundle.py",
            ),
            ...args,
          ]
        : command === "commander-xp-policy-provision"
          ? [
              resolve(
                import.meta.dirname,
                "../../coworld-adapter/scripts/provision-commander-xp-policies.py",
              ),
              ...args,
            ]
          : command === "commander-xp-run-episode"
            ? ["run-episode", ...args]
            : command === "commander-xp-certify"
              ? ["certify", ...args]
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
