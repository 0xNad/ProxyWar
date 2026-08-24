import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lock = fs.readFileSync(
  new URL("commander-xp-coworld-requirements.lock.txt", import.meta.url),
  "utf8",
);
const inventory = fs.readFileSync(
  new URL("commander-xp-coworld-inventory.lock.txt", import.meta.url),
  "utf8",
);
const workflows = [
  "../workflows/commander-xp-provision.yml",
  "../workflows/commander-xp-evidence.yml",
  "../workflows/commander-xp-external-seal.yml",
].map((relative) =>
  fs.readFileSync(new URL(relative, import.meta.url), "utf8"),
);
const externalSealWorkflow = workflows[2];

test("Coworld 0.1.42 uses one hash-locked transitive graph and exact inventory", () => {
  const pins = [...lock.matchAll(/^([a-z0-9][a-z0-9._-]*==[^ \n]+) \\/gm)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(inventory.trim().split("\n"), pins);
  assert.equal(pins.length, 50);
  assert.ok(pins.includes("coworld==0.1.42"));
  for (const block of lock.trim().split(/\n(?=[a-z0-9][a-z0-9._-]*==)/)) {
    assert.match(block, /--hash=sha256:[0-9a-f]{64}/);
  }
  for (const workflow of workflows) {
    assert.match(workflow, /version: "0\.8\.12"/);
    assert.match(workflow, /--require-hashes/);
    assert.match(workflow, /commander-xp-coworld-requirements\.lock\.txt/);
    assert.match(workflow, /commander-xp-coworld-inventory\.lock\.txt/);
    assert.match(workflow, /COWORLD_RUNTIME_INVENTORY_SHA256/);
    assert.doesNotMatch(workflow, /pip install[^\n]+coworld==0\.1\.42/);
  }
  assert.match(
    externalSealWorkflow,
    /test "\$COWORLD_RUNTIME_INVENTORY_SHA256" = "\$\(jq -r \.inventorySha256 "\$RUNNER_TEMP\/verified-bundle\/evidence\/coworld-runtime-inventory-v1\.json"\)"/,
  );
});
