import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = fs.readFileSync(
  new URL("../workflows/commander-xp-evidence.yml", import.meta.url),
  "utf8",
);

test("protected Commander evidence workflow fences before dispatch and uploads evidence before authority", () => {
  assert.match(workflow, /^name: Commander XP protected experiment evidence$/m);
  assert.match(workflow, /GITHUB_TRIGGERING_ACTOR" = "0xNad/);
  assert.match(workflow, /GITHUB_REF" = "refs\/heads\/main/);
  assert.match(workflow, /coworld==0\.1\.42/);
  assert.match(workflow, /commander-xp-dispatch-fence-/);
  assert.match(workflow, /overwrite: false/g);
  const fence = workflow.indexOf("Upload immutable pre-dispatch fence");
  const dispatch = workflow.indexOf(
    "Build exact dispatch authorization and submit once",
  );
  const collect = workflow.indexOf("Collect only privacy-safe projections");
  const evidence = workflow.indexOf(
    "Upload immutable sanitized evidence first",
  );
  const authorityBuild = workflow.indexOf(
    "Build the post-upload non-circular authority request",
  );
  const authority = workflow.indexOf(
    "Upload immutable authority request second",
  );
  const external = workflow.indexOf(
    "Dispatch and await the exact external-seal verifier",
  );
  assert.ok(fence > 0 && fence < dispatch);
  assert.ok(dispatch < collect);
  assert.ok(collect < evidence);
  assert.ok(evidence < authorityBuild && authorityBuild < authority);
  assert.ok(authority < external);
});

test("workflow resolves attested prior phases before the irreversible fence", () => {
  assert.match(workflow, /preregistration_binding_artifact_id:/);
  assert.match(workflow, /provider_preflight_binding_artifact_id:/);
  assert.match(workflow, /canary_binding_artifact_id:/);
  assert.match(workflow, /verify-phase-binding/);
  assert.match(workflow, /verify-prior-authority/);
  assert.match(workflow, /gh attestation verify "\$BINDING"/);
  assert.doesNotMatch(
    workflow,
    /\$CONTROL_ROOT\/commander-xp-(?:prereg|provider-preflight|canary)-ledger-v2\.json/,
  );
  const retained = workflow.indexOf(
    "Resolve and verify retained phase authorities before mutation",
  );
  const activation = workflow.indexOf(
    "Build confirmatory activation from the verified canary authority",
  );
  const fence = workflow.indexOf("Upload immutable pre-dispatch fence");
  assert.ok(retained > 0 && retained < activation && activation < fence);
});

test("workflow waits for the external seal and returns its immutable terminal selector", () => {
  assert.match(workflow, /gh run watch "\$EXTERNAL_RUN_ID"/);
  assert.match(workflow, /commander-xp-phase-binding-\$PHASE-/);
  assert.match(workflow, /commander-xp-terminal-authority-\$PHASE-/);
  assert.match(workflow, /finalArtifactID/);
});

test("workflow pins every reusable action and never uploads raw Coworld evidence", () => {
  for (const uses of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(workflow, /episode-results-raw\.json/);
  assert.doesNotMatch(workflow, /game-logs-raw\.txt/);
  assert.doesNotMatch(workflow, /replay\.json/);
  assert.match(workflow, /commander-xp-external-seal-request-v1\.json/);
  assert.match(workflow, /commander-xp-envelope\/evidence\//);
  assert.match(workflow, /commander-xp-envelope\/authority\//);
});

test("reviewed source allowlist equals the complete behavior-base range", () => {
  const expected = JSON.parse(
    fs.readFileSync(
      new URL("./commander-xp-source-allowlist-v2.json", import.meta.url),
      "utf8",
    ),
  );
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const trackedDiff = execFileSync(
    "git",
    [
      "-C",
      repository,
      "diff",
      "--name-only",
      "a69175a30577b3e516f09a2cb0960d4d129b3f33",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const untracked = execFileSync(
    "git",
    ["-C", repository, "ls-files", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    [...new Set([...trackedDiff, ...untracked])].sort(),
    expected,
  );
});
