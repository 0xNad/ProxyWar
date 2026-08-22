import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(
  new URL("./coworld-authenticated-command.mjs", import.meta.url),
);

test("runs allowlisted XP reads inside a removed credential home", () => {
  withFakeRuntime(({ env, capture }) => {
    const result = spawnSync(
      process.execPath,
      [wrapper, "xp-request", "get", "xreq_fixture", "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "xp-output\n");
    const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.match(lines[0], /^install\|.+\|token$/);
    assert.match(
      lines[1],
      /^coworld\|xp-request get xreq_fixture --json\|.+\|$/,
    );
    const credentialHome = lines[0].split("|")[1];
    assert.equal(fs.existsSync(credentialHome), false);
  });
});

test("runs an exact absolute-file XP create without exposing the token", () => {
  withFakeRuntime(({ env, capture, root }) => {
    const body = path.join(root, "request.json");
    fs.writeFileSync(body, "{}\n");
    const result = spawnSync(
      process.execPath,
      [wrapper, "xp-request", "create", body, "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.match(
      lines[1],
      new RegExp(
        `^coworld\\|xp-request create ${escapeRegex(body)} --json\\|.+\\|$`,
      ),
    );
  });
});

test("runs the exact paged mine-only XP recovery inventory", () => {
  withFakeRuntime(({ env, capture }) => {
    const result = spawnSync(
      process.execPath,
      [
        wrapper,
        "xp-request",
        "list",
        "--mine",
        "--limit",
        "1000",
        "--offset",
        "1000",
        "--json",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.match(
      lines[1],
      /^coworld\|xp-request list --mine --limit 1000 --offset 1000 --json\|.+\|$/,
    );
  });
});

test("runs the exact read-only Coworld status preflight", () => {
  withFakeRuntime(({ env, capture }) => {
    const result = spawnSync(
      process.execPath,
      [wrapper, "status", "cow_f58621db-4a09-47de-bb13-24d61050a837", "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.match(
      lines[1],
      /^coworld\|status cow_f58621db-4a09-47de-bb13-24d61050a837 --json\|.+\|$/,
    );
  });
});

test("rejects symlinked and missing XP create bodies before authentication", () => {
  withFakeRuntime(({ env, capture, root }) => {
    const body = path.join(root, "request.json");
    const link = path.join(root, "request-link.json");
    fs.writeFileSync(body, "{}\n");
    fs.symlinkSync(body, link);
    for (const candidate of [link, path.join(root, "missing.json")]) {
      const result = spawnSync(
        process.execPath,
        [wrapper, "xp-request", "create", candidate, "--json"],
        { encoding: "utf8", env },
      );
      assert.notEqual(result.status, 0);
    }
    assert.equal(fs.existsSync(capture), false);
  });
});

test("maps the episode bundle mode to the pinned Python helper without a token", () => {
  withFakeRuntime(({ env, capture, root }) => {
    const output = path.join(privateOutputParent(root), "bundle.zip");
    const result = spawnSync(
      process.execPath,
      [wrapper, "commander-xp-episode-bundle", "ereq_fixture", output],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.match(
      lines[1],
      /python\|.*fetch-commander-xp-episode-bundle\.py ereq_fixture .*bundle\.zip\|.+\|$/,
    );
  });
});

test("maps exact Commander XP policy provision without exposing the token", () => {
  withFakeRuntime(({ env, capture, root }) => {
    const output = path.join(privateOutputParent(root), "policy-receipts");
    const args = [
      "commander-xp-policy-provision",
      "upload",
      `--image=ghcr.io/0xnad/proxywar-commander-xp-policy@sha256:${"1".repeat(64)}`,
      "--name-prefix=proxywar-commander-xp-fixture",
      "--bedrock-model=us.anthropic.claude-sonnet-4-6",
      `--source-sha=${"2".repeat(40)}`,
      `--source-tree-sha=${"3".repeat(40)}`,
      `--source-provenance-digest=sha256:${"4".repeat(64)}`,
      `--build-provenance-digest=sha256:${"5".repeat(64)}`,
      `--oci-digest=sha256:${"6".repeat(64)}`,
      `--output=${output}`,
    ];
    const result = spawnSync(process.execPath, [wrapper, ...args], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.match(
      lines[1],
      /python\|.*provision-commander-xp-policies\.py upload --image=ghcr\.io\/0xnad\/proxywar-commander-xp-policy@sha256:/,
    );
    assert.match(lines[1], /\|.+\|$/);
  });
});

test("runs only the exact terminal-proof and certification argv in the minimal child environment", () => {
  withFakeRuntime(({ env, capture, root }) => {
    const manifest = path.join(root, "eval-manifest.json");
    const output = path.join(privateOutputParent(root), "terminal-proof");
    const image = `ghcr.io/0xnad/proxywar-commander-xp-game@sha256:${"7".repeat(64)}`;
    fs.writeFileSync(manifest, "{}\n");
    const episode = spawnSync(
      process.execPath,
      [
        wrapper,
        "commander-xp-run-episode",
        manifest,
        image,
        image,
        image,
        image,
        "--run",
        "node",
        "--run",
        "/app/integration/src/starter-player.mjs",
        "--variant",
        "tournament-4p-pangaea",
        "--timeout-seconds",
        "6000",
        "--verify-replay",
        "--output-dir",
        output,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(episode.status, 0, episode.stderr);
    const certify = spawnSync(
      process.execPath,
      [
        wrapper,
        "commander-xp-certify",
        manifest,
        "--timeout-seconds",
        "600",
        "--no-open-report",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(certify.status, 0, certify.stderr);
    const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.match(lines[1], /^coworld\|run-episode /);
    assert.match(lines[3], /^coworld\|certify /);
    assert.match(lines[1], /\|.+\|$/);
    assert.match(lines[3], /\|.+\|$/);
  });
});

test("rejects existing, outside, symlinked, and parent-symlink output boundaries", () => {
  withFakeRuntime(({ env, capture, root }) => {
    const parent = privateOutputParent(root);
    const existing = path.join(parent, "existing.zip");
    fs.writeFileSync(existing, "occupied");
    const targetParent = path.join(fs.realpathSync(root), "target-output");
    fs.mkdirSync(targetParent, { mode: 0o700 });
    const linkedParent = path.join(fs.realpathSync(root), "linked-output");
    fs.symlinkSync(targetParent, linkedParent);
    for (const output of [
      existing,
      "/tmp/commander-xp-outside.zip",
      path.join(linkedParent, "bundle.zip"),
      path.join(parent, "missing", "bundle.zip"),
    ]) {
      const result = spawnSync(
        process.execPath,
        [wrapper, "commander-xp-episode-bundle", "ereq_fixture", output],
        { encoding: "utf8", env },
      );
      assert.notEqual(result.status, 0, output);
    }
    assert.equal(fs.existsSync(capture), false);
  });
});

test("rejects unsupported and malformed command modes before authentication", () => {
  for (const args of [
    ["delete-everything"],
    ["xp-request", "get", "bad", "--json"],
    ["xp-request", "create", "relative.json", "--json"],
    ["xp-request", "create", "/etc/outside-runner.json", "--json"],
    ["xp-request", "list", "--limit", "1000", "--offset", "0", "--json"],
    [
      "xp-request",
      "list",
      "--mine",
      "--limit",
      "999",
      "--offset",
      "0",
      "--json",
    ],
    ["episode-logs", "ereq_fixture", "--agent", "4", "--artifact"],
    ["commander-xp-episode-bundle", "ereq_fixture", "relative.zip"],
    ["commander-xp-policy-provision", "upload"],
    [
      "commander-xp-policy-provision",
      "check",
      `--image=ghcr.io/0xnad/policy@sha256:${"1".repeat(64)}`,
      "--name-prefix=proxywar-commander-xp-fixture",
      "--bedrock-model=bad model",
      `--source-sha=${"2".repeat(40)}`,
      `--source-tree-sha=${"3".repeat(40)}`,
      `--source-provenance-digest=sha256:${"4".repeat(64)}`,
      `--build-provenance-digest=sha256:${"5".repeat(64)}`,
      `--oci-digest=sha256:${"6".repeat(64)}`,
    ],
    ["status", "bad", "--json"],
    ["status", "cow_eval_fixture"],
    ["leagues", "bad", "--json"],
    ["list", "--json", "extra"],
    ["next-version", "bad name"],
    ["commander-xp-run-episode", "/etc/outside.json"],
    ["commander-xp-certify", "/etc/outside.json"],
    ["upload-coworld", "/etc/outside.json"],
  ]) {
    const result = spawnSync(process.execPath, [wrapper, ...args], {
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.notEqual(result.status, 0, args.join(" "));
  }
});

function withFakeRuntime(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coworld-auth-wrapper-"));
  const capture = path.join(root, "capture.txt");
  const python = path.join(root, "python");
  const coworld = path.join(root, "coworld");
  fs.writeFileSync(
    python,
    `#!/bin/sh\ntest -z "$GITHUB_TOKEN$GH_TOKEN$ACTIONS_ID_TOKEN_REQUEST_TOKEN$ACTIONS_RUNTIME_TOKEN$AWS_SECRET_ACCESS_KEY" || exit 19\nif [ "$1" = "-c" ]; then\n  case "$2" in *"importlib.metadata.version('coworld') == '0.1.42'"*) ;; *) exit 17 ;; esac\n  printf 'install|%s|%s\\n' "$HOME" "\${COWORLD_API_TOKEN:+token}" >> ${JSON.stringify(capture)}\nelse\n  printf 'python|%s|%s|%s\\n' "$*" "$HOME" "\${COWORLD_API_TOKEN:+token}" >> ${JSON.stringify(capture)}\nfi\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    coworld,
    `#!/bin/sh\ntest -z "$COWORLD_API_TOKEN$GITHUB_TOKEN$GH_TOKEN$ACTIONS_ID_TOKEN_REQUEST_TOKEN$ACTIONS_RUNTIME_TOKEN$AWS_SECRET_ACCESS_KEY" || exit 19\nprintf 'coworld|%s|%s|%s\\n' "$*" "$HOME" "\${COWORLD_API_TOKEN:+token}" >> ${JSON.stringify(capture)}\nprintf 'xp-output\\n'\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-id-token",
    ACTIONS_RUNTIME_TOKEN: "fixture-runtime-token",
    AWS_SECRET_ACCESS_KEY: "fixture-cloud-secret",
    COWORLD_API_TOKEN: "fixture-token",
    COWORLD_BIN: coworld,
    COWORLD_PYTHON: python,
    GH_TOKEN: "fixture-gh-token",
    GITHUB_TOKEN: "fixture-github-token",
    RUNNER_TEMP: root,
  };
  try {
    callback({ env, capture, root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function privateOutputParent(root) {
  const parent = path.join(fs.realpathSync(root), "private-output");
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
  return parent;
}
