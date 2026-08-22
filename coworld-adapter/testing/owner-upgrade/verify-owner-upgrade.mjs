import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_BASE = "190ea95eda41fbf5d1521d433b3365d87b9cfe57";
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

async function main() {
  const starter = path.resolve(process.argv[2] ?? "");
  if (process.argv.length !== 3) {
    throw new Error(
      "usage: node verify-owner-upgrade.mjs /absolute/path/to/fresh-public-starter",
    );
  }
  if (run("git", ["rev-parse", "HEAD"], starter) !== PUBLIC_BASE) {
    throw new Error(`starter HEAD must be exact public base ${PUBLIC_BASE}`);
  }
  if (run("git", ["status", "--porcelain"], starter) !== "") {
    throw new Error("starter checkout must be clean before patch application");
  }

  const lines = (await readFile(ledgerPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [layer, digest, file] = line.split(" ");
      return { layer, digest, file };
    });
  const publicBase = lines.find(
    (entry) => entry.layer === "meta" && entry.file === "public-base",
  );
  const candidateSource = lines.find(
    (entry) => entry.layer === "meta" && entry.file === "candidate-source",
  );
  if (publicBase?.digest !== PUBLIC_BASE) {
    throw new Error("sealed ledger public base mismatch");
  }
  if (!/^[0-9a-f]{40}$/u.test(candidateSource?.digest ?? "")) {
    throw new Error("sealed ledger candidate source is missing or malformed");
  }
  const packet = lines.find((entry) => entry.layer === "packet");
  if (!packet || (await sha256(patchPath)) !== packet.digest) {
    throw new Error("owner patch SHA-256 does not match sealed ledger");
  }
  for (const entry of lines.filter((candidate) => candidate.layer === "base")) {
    if ((await sha256(path.join(starter, entry.file))) !== entry.digest) {
      throw new Error(`public base hash mismatch for ${entry.file}`);
    }
  }
  for (const file of NEW_FILES) {
    try {
      await stat(path.join(starter, file));
      throw new Error(`public base unexpectedly already contains ${file}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  run("git", ["apply", "--check", patchPath], starter);
  run("git", ["apply", patchPath], starter);
  const changedFiles = run("git", ["status", "--porcelain", "-uall"], starter)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
  if (JSON.stringify(changedFiles) !== JSON.stringify(FILES)) {
    throw new Error(
      `after-apply file set mismatch: ${JSON.stringify(changedFiles)}`,
    );
  }
  for (const entry of lines.filter(
    (candidate) => candidate.layer === "expected",
  )) {
    if ((await sha256(path.join(starter, entry.file))) !== entry.digest) {
      throw new Error(`after-apply hash mismatch for ${entry.file}`);
    }
  }
  run("npm", ["install", "--ignore-scripts", "--package-lock=false"], starter);
  run("npm", ["test"], starter);
  run("node", ["--check", "llm-player.mjs"], starter);
  run("node", ["--check", "starter-player.mjs"], starter);
  run("node", ["--check", "owner-capabilities.mjs"], starter);
  run("node", ["--check", "owner-evidence-check.mjs"], starter);
  process.stdout.write(
    `${JSON.stringify({ verdict: "PASS", publicBase: PUBLIC_BASE, candidateSource: candidateSource.digest, patchSHA256: packet.digest, verifiedFiles: lines.filter((entry) => entry.layer === "expected").length })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
