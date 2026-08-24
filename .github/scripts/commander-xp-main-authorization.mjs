import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA1_PATTERN = /^[0-9a-f]{40}$/;

function exactObject(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`Commander XP ${label} response is invalid`);
  }
  return value;
}

export async function assertCommanderXpMainAuthorization({
  repository,
  sourceSha,
  readJson,
}) {
  if (repository !== "0xNad/ProxyWar" || !SHA1_PATTERN.test(sourceSha)) {
    throw new Error("Commander XP main authorization input is invalid");
  }
  if (typeof readJson !== "function") {
    throw new Error("Commander XP main authorization reader is invalid");
  }

  const repo = exactObject(
    await readJson(`repos/${repository}`),
    ["visibility", "private"],
    "repository",
  );
  if (repo.visibility !== "public" || repo.private !== false) {
    throw new Error("Commander XP repository is not public");
  }

  const branch = exactObject(
    await readJson(`repos/${repository}/branches/main`),
    ["name", "protected"],
    "branch",
  );
  if (branch.name !== "main" || branch.protected !== true) {
    throw new Error("Commander XP main branch is not protected");
  }

  const ref = exactObject(
    await readJson(`repos/${repository}/git/ref/heads/main`),
    ["ref", "object"],
    "main ref",
  );
  const object = exactObject(ref.object, ["sha", "type"], "main ref object");
  if (
    ref.ref !== "refs/heads/main" ||
    object.type !== "commit" ||
    object.sha !== sourceSha
  ) {
    throw new Error("Commander XP protected main moved after authorization");
  }

  return Object.freeze({ repository, sourceSha });
}

function ghReadJson(endpoint) {
  const childEnv = Object.fromEntries(
    [
      "GH_TOKEN",
      "GH_HOST",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "RUNNER_TEMP",
      "TMPDIR",
    ]
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
  const stdout = execFileSync("gh", ["api", endpoint], {
    encoding: "utf8",
    env: childEnv,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(stdout);
}

async function main() {
  const [sourceSha] = process.argv.slice(2);
  if (process.argv.length !== 3) {
    throw new Error("usage: commander-xp-main-authorization.mjs <source-sha>");
  }
  await assertCommanderXpMainAuthorization({
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha,
    readJson: ghReadJson,
  });
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, authorized: true, sourceSha })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
