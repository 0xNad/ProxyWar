import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_BASE = "190ea95eda41fbf5d1521d433b3365d87b9cfe57";
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const EXISTING_FILES = [
  "Dockerfile",
  "MESSAGES.md",
  "ONBOARDING.md",
  "README.md",
  "llm-player.mjs",
  "package.json",
  "starter-player.mjs",
];
const NEW_FILES = [
  "owner-capabilities.d.mts",
  "owner-capabilities.mjs",
  "owner-capability-contract.test.mjs",
  "owner-evidence-check.mjs",
  "owner-evidence-check.test.mjs",
  "owner-player-frame.test.mjs",
];
const FILES = [...EXISTING_FILES, ...NEW_FILES].sort();
const packetRoot = path.dirname(fileURLToPath(import.meta.url));
const patchPath = path.join(packetRoot, "proxywar-owner-upgrade.patch");
const ledgerPath = path.join(packetRoot, "SHA256SUMS");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function mustNotExist(file) {
  try {
    await access(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`public base unexpectedly contains ${path.basename(file)}`);
}

async function main() {
  if (process.argv.length !== 5) {
    throw new Error(
      "usage: node build-owner-upgrade.mjs /absolute/path/to/clean-public-starter /absolute/path/to/platform-source <candidate-source-sha>",
    );
  }
  const publicStarter = path.resolve(process.argv[2]);
  const sourceRoot = path.resolve(process.argv[3]);
  const sourceSHA = process.argv[4];
  const sourceStarter = path.join(
    sourceRoot,
    "coworld-adapter/tester-starter-llm",
  );
  if (!SOURCE_SHA.test(sourceSHA)) {
    throw new Error("candidate source SHA must be exactly 40 lowercase hex");
  }
  if (run("git", ["rev-parse", "HEAD"], publicStarter) !== PUBLIC_BASE) {
    throw new Error(`public starter HEAD must be exact base ${PUBLIC_BASE}`);
  }
  if (run("git", ["status", "--porcelain"], publicStarter) !== "") {
    throw new Error("public starter checkout must be clean");
  }
  if (run("git", ["rev-parse", "HEAD"], sourceRoot) !== sourceSHA) {
    throw new Error("platform source HEAD does not match candidate source SHA");
  }
  if (
    run(
      "git",
      ["status", "--porcelain", "--", "coworld-adapter/tester-starter-llm"],
      sourceRoot,
    ) !== ""
  ) {
    throw new Error("platform starter source must be clean and committed");
  }
  for (const file of FILES) await stat(path.join(sourceStarter, file));
  for (const file of NEW_FILES) {
    await mustNotExist(path.join(publicStarter, file));
  }

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "proxywar-owner-upgrade-build-"),
  );
  const candidate = path.join(temporaryRoot, "public-starter");
  try {
    run(
      "git",
      ["clone", "--quiet", "--no-hardlinks", publicStarter, candidate],
      temporaryRoot,
    );
    run("git", ["checkout", "--quiet", "--detach", PUBLIC_BASE], candidate);
    for (const file of FILES) {
      await copyFile(
        path.join(sourceStarter, file),
        path.join(candidate, file),
      );
    }
    run("git", ["add", "-N", "--", ...NEW_FILES], candidate);
    run(
      "git",
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        `--output=${patchPath}`,
        "--",
        ...FILES,
      ],
      candidate,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const lines = [
    `meta ${PUBLIC_BASE} public-base`,
    `meta ${sourceSHA} candidate-source`,
    `packet ${await sha256(patchPath)} proxywar-owner-upgrade.patch`,
  ];
  for (const file of EXISTING_FILES) {
    lines.push(`base ${await sha256(path.join(publicStarter, file))} ${file}`);
  }
  for (const file of FILES) {
    lines.push(
      `expected ${await sha256(path.join(sourceStarter, file))} ${file}`,
    );
  }
  await writeFile(ledgerPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ verdict: "BUILT", publicBase: PUBLIC_BASE, candidateSource: sourceSHA, patchSHA256: await sha256(patchPath), files: FILES.length })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
