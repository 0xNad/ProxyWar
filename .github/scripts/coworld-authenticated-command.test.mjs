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
    const output = path.join(root, "bundle.zip");
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

test("rejects unsupported and malformed command modes before authentication", () => {
  for (const args of [
    ["delete-everything"],
    ["xp-request", "get", "bad", "--json"],
    ["xp-request", "create", "relative.json", "--json"],
    ["xp-request", "create", "/etc/outside-runner.json", "--json"],
    ["episode-logs", "ereq_fixture", "--agent", "4", "--artifact"],
    ["commander-xp-episode-bundle", "ereq_fixture", "relative.zip"],
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
    `#!/bin/sh\nif [ "$1" = "-c" ]; then\n  case "$2" in *"importlib.metadata.version('coworld') == '0.1.42'"*) ;; *) exit 17 ;; esac\n  printf 'install|%s|%s\\n' "$HOME" "\${COWORLD_API_TOKEN:+token}" >> "$CAPTURE"\nelse\n  printf 'python|%s|%s|%s\\n' "$*" "$HOME" "\${COWORLD_API_TOKEN:+token}" >> "$CAPTURE"\nfi\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    coworld,
    `#!/bin/sh\nprintf 'coworld|%s|%s|%s\\n' "$*" "$HOME" "\${COWORLD_API_TOKEN:+token}" >> "$CAPTURE"\nprintf 'xp-output\\n'\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    CAPTURE: capture,
    COWORLD_API_TOKEN: "fixture-token",
    COWORLD_BIN: coworld,
    COWORLD_PYTHON: python,
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
