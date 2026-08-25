import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(
  new URL("commander-public-base-recovery.mjs", import.meta.url),
);
const source = "1".repeat(40);
const tree = "2".repeat(40);
const fenceRef = `refs/tags/commander-public-base-v1/${"4".repeat(64)}`;

function write(root, relative, body = {}) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(body)}\n`);
}

function build(root, stage) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [helper, "build", root, stage, source, tree, fenceRef],
      { encoding: "utf8" },
    ),
  );
}

function validate(root) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [helper, "validate", root, source, tree, fenceRef],
      { encoding: "utf8" },
    ),
  );
}

test("public-base recovery advances through one image and one exact policy", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-public-base-recovery-"),
  );
  try {
    write(root, "source-provenance.json");
    write(root, "intent.json");
    const intent = build(root, "intent");
    assert.equal(validate(root).stage, "intent");

    write(root, "ghcr.json");
    write(root, "attestations/policy.jsonl");
    const ghcr = build(root, "ghcr");
    assert.deepEqual(ghcr.priorStateSha256s, [intent.stateSha256]);

    write(root, "coworld-intent.json");
    assert.equal(build(root, "coworld-intent").stage, "coworld-intent");
    write(root, "materialization/image.json");
    assert.equal(build(root, "coworld-image").stage, "coworld-image");
    write(root, "materialization/policy.json");
    assert.equal(build(root, "coworld-policy").stage, "coworld-policy");
    write(root, "materialization/summary.json");
    assert.equal(build(root, "complete").stage, "complete");
    assert.equal(validate(root).stage, "complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public-base recovery rejects extra policies, tamper, and links", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-public-base-recovery-"),
  );
  try {
    write(root, "source-provenance.json");
    write(root, "intent.json");
    build(root, "intent");
    fs.appendFileSync(path.join(root, "intent.json"), "tamper");
    assert.throws(() => validate(root));

    fs.rmSync(root, { recursive: true, force: true });
    write(root, "source-provenance.json");
    write(root, "intent.json");
    write(root, "ghcr.json");
    write(root, "attestations/policy.jsonl");
    write(root, "coworld-intent.json");
    write(root, "materialization/image.json");
    write(root, "materialization/second-policy.json");
    assert.throws(() => build(root, "coworld-image"));

    fs.rmSync(root, { recursive: true, force: true });
    write(root, "source-provenance.json");
    write(root, "intent.json");
    fs.symlinkSync(path.join(root, "intent.json"), path.join(root, "bad"));
    assert.throws(() => build(root, "intent"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public-base recovery binds exact source and workflow", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-public-base-recovery-"),
  );
  try {
    write(root, "source-provenance.json");
    write(root, "intent.json");
    build(root, "intent");
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [helper, "validate", root, "9".repeat(40), tree, fenceRef],
        { encoding: "utf8" },
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
