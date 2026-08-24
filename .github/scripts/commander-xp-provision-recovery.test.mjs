import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(
  new URL("commander-xp-provision-recovery.mjs", import.meta.url),
);
const source = "1".repeat(40);
const tree = "2".repeat(40);
const version = "0.2.0";
const namePrefix = "proxywar-commander-xp-fixture";
const fenceRef = `refs/tags/commander-xp-provision-v2/${"3".repeat(64)}`;

function write(root, relative, body = {}) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(body)}\n`);
}

function build(root, stage) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        helper,
        "build",
        root,
        stage,
        source,
        tree,
        version,
        namePrefix,
        fenceRef,
      ],
      { encoding: "utf8" },
    ),
  );
}

function validate(root) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [helper, "validate", root, source, tree, version, namePrefix, fenceRef],
      { encoding: "utf8" },
    ),
  );
}

test("provision recovery advances only through exact cumulative crash boundaries", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-xp-provision-"),
  );
  try {
    write(root, "fence-intent.json");
    const fence = build(root, "fence-intent");
    assert.equal(fence.stage, "fence-intent");
    assert.deepEqual(fence.priorStateSha256s, []);
    assert.equal(validate(root).stage, "fence-intent");

    write(root, "ghcr.json");
    write(root, "attestations/policy.jsonl");
    write(root, "attestations/game.jsonl");
    const ghcr = build(root, "ghcr");
    assert.equal(ghcr.stage, "ghcr");
    assert.deepEqual(ghcr.priorStateSha256s, [fence.stateSha256]);

    write(root, "policy-receipts/image.json");
    write(root, "policy-receipts/A.json");
    assert.equal(build(root, "policies-partial").stage, "policies-partial");

    for (const role of ["B", "C", "opponent-1", "opponent-2", "opponent-3"]) {
      write(root, `policy-receipts/${role}.json`);
    }
    write(root, "policy-receipts/policy-identities-v2.json");
    assert.equal(build(root, "policies").stage, "policies");

    write(root, "eval/eval-coworld-manifest-v2.json");
    write(root, "eval/eval-coworld-terminal-proof-v2.json");
    assert.equal(build(root, "terminal-proof").stage, "terminal-proof");

    write(root, "eval/eval-coworld-inspect.json");
    const partialEval = build(root, "eval-partial");
    assert.equal(partialEval.stage, "eval-partial");
    const terminal = build(root, "eval-upload");
    assert.equal(terminal.stage, "eval-upload");
    assert.equal(terminal.priorStateSha256s.at(-1), partialEval.stateSha256);
    assert.deepEqual(
      validate(root).priorStateSha256s,
      terminal.priorStateSha256s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provision recovery rejects tamper, missing stages, links, and identity drift", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-xp-provision-"),
  );
  try {
    write(root, "fence-intent.json");
    build(root, "fence-intent");
    fs.appendFileSync(path.join(root, "fence-intent.json"), "tamper");
    assert.throws(() => validate(root));
    fs.rmSync(root, { recursive: true, force: true });

    const missing = fs.mkdtempSync(
      path.join(os.tmpdir(), "commander-xp-provision-missing-"),
    );
    assert.throws(() => build(missing, "ghcr"));
    fs.rmSync(missing, { recursive: true, force: true });

    const linked = fs.mkdtempSync(
      path.join(os.tmpdir(), "commander-xp-provision-link-"),
    );
    write(linked, "fence-intent.json");
    fs.symlinkSync(
      path.join(linked, "fence-intent.json"),
      path.join(linked, "bad"),
    );
    assert.throws(() => build(linked, "fence-intent"));
    fs.rmSync(linked, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every one of the six policy crash prefixes is a recoverable exact boundary", () => {
  const roles = ["A", "B", "C", "opponent-1", "opponent-2", "opponent-3"];
  for (let completed = 0; completed <= roles.length; completed += 1) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `commander-xp-policy-prefix-${completed}-`),
    );
    try {
      write(root, "fence-intent.json");
      write(root, "ghcr.json");
      write(root, "attestations/policy.jsonl");
      write(root, "attestations/game.jsonl");
      write(root, "policy-receipts/image.json");
      for (const role of roles.slice(0, completed)) {
        write(root, `policy-receipts/${role}.json`);
      }
      assert.equal(build(root, "policies-partial").stage, "policies-partial");
      assert.equal(validate(root).stage, "policies-partial");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("partial policy recovery rejects a non-prefix subset", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-xp-policy-non-prefix-"),
  );
  try {
    write(root, "fence-intent.json");
    write(root, "ghcr.json");
    write(root, "attestations/policy.jsonl");
    write(root, "attestations/game.jsonl");
    write(root, "policy-receipts/image.json");
    write(root, "policy-receipts/B.json");
    assert.throws(() => build(root, "policies-partial"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
