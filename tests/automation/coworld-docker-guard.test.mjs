import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const guard = ".github/scripts/coworld-docker-guard.mjs";

test("production Docker guard permits inert image reads and rejects execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "coworld-docker-guard-"));
  const fakeDocker = join(directory, "docker-real");
  const calls = join(directory, "calls.jsonl");
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_DOCKER_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("[]");
`,
  );
  chmodSync(fakeDocker, 0o755);

  const invoke = (args) =>
    spawnSync(process.execPath, [guard, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        COWORLD_REAL_DOCKER: fakeDocker,
        FAKE_DOCKER_CALLS: calls,
      },
    });

  try {
    const allowed = [
      ["image", "inspect", "proxywar-game:release"],
      ["image", "inspect", "--format", "{{.Id}}", "proxywar-game:release"],
      ["image", "save", "proxywar-game:release"],
    ];
    for (const args of allowed) {
      const result = invoke(args);
      assert.equal(result.status, 0, result.stderr);
    }

    const rejected = [
      ["run", "proxywar-game:release"],
      ["container", "run", "proxywar-game:release"],
      ["compose", "up"],
      ["network", "create", "coworld"],
      ["rm", "-f", "coworld"],
      ["pull", "proxywar-game:release"],
      ["tag", "source", "target"],
      ["manifest", "inspect", "proxywar-game:release"],
      ["image", "inspect", "--format", "{{json .}}", "proxywar-game:release"],
      ["image", "save", "--output", "archive.tar", "proxywar-game:release"],
    ];
    for (const args of rejected) {
      const result = invoke(args);
      assert.equal(result.status, 126, `${args.join(" ")}\n${result.stderr}`);
    }

    const recorded = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(recorded, allowed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
