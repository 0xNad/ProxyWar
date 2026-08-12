import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("authenticated Coworld commands stream output larger than spawnSync's default buffer", () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "coworld-wrapper-test-"));
  const fakeCoworld = join(runnerTemp, "fake-coworld");
  const payloadBytes = 2 * 1024 * 1024;

  writeFileSync(
    fakeCoworld,
    `#!/usr/bin/env node
if (process.env.COWORLD_API_TOKEN) process.exit(2);
if (process.argv.slice(2).join(" ") !== "list --json") process.exit(3);
process.stdout.write(JSON.stringify([{ name: "proxywar", payload: "x".repeat(${payloadBytes}) }]));
`,
  );
  chmodSync(fakeCoworld, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [".github/scripts/coworld-authenticated-command.mjs", "list", "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          COWORLD_API_TOKEN: "test-token",
          COWORLD_PYTHON: "/usr/bin/true",
          COWORLD_BIN: fakeCoworld,
          RUNNER_TEMP: runnerTemp,
        },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].payload.length, payloadBytes);
    assert.deepEqual(readdirSync(runnerTemp), ["fake-coworld"]);
  } finally {
    rmSync(runnerTemp, { force: true, recursive: true });
  }
});
