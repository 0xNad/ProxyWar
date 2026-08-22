import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(
  new URL("../workflows/commander-xp-control.yml", import.meta.url),
  "utf8",
);

test("control workflow consumes provision authority without source self-reference", () => {
  assert.match(workflow, /^name: Commander XP immutable control packet$/m);
  assert.match(workflow, /provision_artifact_id:/);
  assert.match(workflow, /commander-xp-provision-manifest-v2\.json/);
  assert.match(workflow, /commander-xp-plan-input-base-v2\.json/);
  assert.match(workflow, /find "\$PROVISION_ROOT" -type f/);
  assert.match(workflow, /find "\$PROVISION_ROOT" -type l/);
  assert.match(workflow, /mode == "plan-only-no-requests-created"/);
  assert.doesNotMatch(workflow, /xp-request create/);
  assert.doesNotMatch(workflow, /upload-coworld|upload-policy/);
});

test("control workflow binds exact protected source and attests immutable output", () => {
  assert.match(workflow, /GITHUB_TRIGGERING_ACTOR" = "0xNad/);
  assert.match(workflow, /GITHUB_REF" = "refs\/heads\/main/);
  assert.match(workflow, /commander-xp-control-manifest-v2\.json/);
  assert.match(workflow, /github-actions-attested-control-packet-v1/);
  assert.match(workflow, /retention-days:\s*90/);
  assert.match(workflow, /overwrite:\s*false/);
  assert.match(workflow, /--deny-self-hosted-runners/);
  for (const uses of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/);
  }
});
