import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { assertCommanderXpMainAuthorization } from "./commander-xp-main-authorization.mjs";

const SOURCE_SHA = "a".repeat(40);

function reader(currentSha = SOURCE_SHA) {
  const responses = new Map([
    ["repos/0xNad/ProxyWar", { visibility: "public", private: false }],
    ["repos/0xNad/ProxyWar/branches/main", { name: "main", protected: true }],
    [
      "repos/0xNad/ProxyWar/git/ref/heads/main",
      {
        ref: "refs/heads/main",
        object: { sha: currentSha, type: "commit" },
      },
    ],
  ]);
  return async (endpoint) => structuredClone(responses.get(endpoint));
}

test("authorizes public protected main at the exact frozen source", async () => {
  await assertCommanderXpMainAuthorization({
    repository: "0xNad/ProxyWar",
    sourceSha: SOURCE_SHA,
    readJson: reader(),
  });
});

test("fails the outward boundary when main advances after initial authorization", async () => {
  await assertCommanderXpMainAuthorization({
    repository: "0xNad/ProxyWar",
    sourceSha: SOURCE_SHA,
    readJson: reader(),
  });
  await assert.rejects(
    assertCommanderXpMainAuthorization({
      repository: "0xNad/ProxyWar",
      sourceSha: SOURCE_SHA,
      readJson: reader("b".repeat(40)),
    }),
    /protected main moved after authorization/,
  );
});

test("rejects private or unprotected repository state", async () => {
  await assert.rejects(
    assertCommanderXpMainAuthorization({
      repository: "0xNad/ProxyWar",
      sourceSha: SOURCE_SHA,
      readJson: async (endpoint) =>
        endpoint === "repos/0xNad/ProxyWar"
          ? { visibility: "private", private: true }
          : {},
    }),
    /repository is not public/,
  );

  const unprotectedReader = reader();
  await assert.rejects(
    assertCommanderXpMainAuthorization({
      repository: "0xNad/ProxyWar",
      sourceSha: SOURCE_SHA,
      readJson: async (endpoint) => {
        const value = await unprotectedReader(endpoint);
        return endpoint.endsWith("/branches/main")
          ? { ...value, protected: false }
          : value;
      },
    }),
    /main branch is not protected/,
  );
});

test("every Commander durable fence and outward request loop reauthorizes current main", () => {
  const step = (workflow, name) => {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1, `missing workflow step: ${name}`);
    const end = workflow.indexOf("\n      - name: ", start + 1);
    return workflow.slice(start, end === -1 ? undefined : end);
  };
  const provision = fs.readFileSync(
    new URL("../workflows/commander-xp-provision.yml", import.meta.url),
    "utf8",
  );
  const control = fs.readFileSync(
    new URL("../workflows/commander-xp-control.yml", import.meta.url),
    "utf8",
  );
  const evidence = fs.readFileSync(
    new URL("../workflows/commander-xp-evidence.yml", import.meta.url),
    "utf8",
  );

  for (const output of [
    "provision-fence-main-authorization.json",
    "ghcr-push-main-authorization.json",
    "policy-upload-main-authorization.json",
    "eval-upload-main-authorization.json",
  ]) {
    assert.match(
      provision,
      new RegExp(
        `commander-xp-main-authorization\\.mjs \\"\\$SOURCE_SHA\\" > \\"\\$RUNNER_TEMP/${output.replaceAll(".", "\\.")}\\"`,
      ),
    );
  }
  const controlFence = step(
    control,
    "Atomically create or verify the single preregistration fence",
  );
  assert.ok(
    controlFence.indexOf("control-fence-main-authorization.json") <
      controlFence.indexOf(
        'gh api --method POST "repos/$GITHUB_REPOSITORY/git/tags"',
      ),
  );
  const dispatchFence = step(
    evidence,
    "Create durable atomic pre-dispatch Git ref",
  );
  assert.ok(
    dispatchFence.indexOf("dispatch-fence-main-authorization.json") <
      dispatchFence.indexOf(
        'gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs"',
      ),
  );
  const dispatch = step(
    evidence,
    "Build exact dispatch authorization and submit once",
  );
  assert.ok(
    dispatch.indexOf("dispatch-main-authorization.json") <
      dispatch.indexOf("agent:commander:xp:dispatch"),
  );
  const waveTwo = step(
    evidence,
    "Resume from retained wave one and submit confirmatory wave two",
  );
  assert.ok(
    waveTwo.indexOf("confirmatory-wave-two-main-authorization.json") <
      waveTwo.indexOf("agent:commander:xp:dispatch"),
  );
});
