import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const workflowDirectory = path.resolve(scriptsDirectory, "../workflows");

function collectRunBlocks(value, location, output) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectRunBlocks(entry, `${location}[${index}]`, output),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (key === "run") {
      assert.equal(
        typeof entry,
        "string",
        `${childLocation} must be a shell string`,
      );
      output.push({ location: childLocation, script: entry });
    } else {
      collectRunBlocks(entry, childLocation, output);
    }
  }
}

test("every Commander workflow run block parses as Bash after expression substitution", () => {
  const workflowNames = fs
    .readdirSync(workflowDirectory)
    .filter((name) => /^commander-xp-.*\.yml$/.test(name))
    .sort();
  assert.ok(workflowNames.length >= 4);

  for (const workflowName of workflowNames) {
    const source = fs.readFileSync(
      path.join(workflowDirectory, workflowName),
      "utf8",
    );
    const document = yaml.load(source, { json: true });
    const blocks = [];
    collectRunBlocks(document, workflowName, blocks);
    assert.ok(blocks.length > 0, `${workflowName} has no run blocks`);
    for (const { location, script } of blocks) {
      const syntaxOnly = script.replace(
        /\$\{\{[\s\S]*?\}\}/g,
        "GITHUB_EXPRESSION",
      );
      try {
        execFileSync("/bin/bash", ["-n"], {
          input: syntaxOnly,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        const stderr =
          error !== null &&
          typeof error === "object" &&
          "stderr" in error &&
          Buffer.isBuffer(error.stderr)
            ? error.stderr.toString("utf8")
            : String(error);
        assert.fail(`${location} is not valid Bash:\n${stderr}`);
      }
    }
  }
});
