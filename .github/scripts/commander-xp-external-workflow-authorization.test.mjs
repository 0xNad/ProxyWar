import assert from "node:assert/strict";
import test from "node:test";

import { assertCommanderXpExternalWorkflowAuthorization } from "./commander-xp-external-workflow-authorization.mjs";

const SOURCE = "1".repeat(40);
const AUTHORIZATION = "2".repeat(40);
const CURRENT = "3".repeat(40);
const BLOB = "4".repeat(40);

function fixture(overrides = {}) {
  return {
    repository: "0xNad/ProxyWar",
    sourceSha: SOURCE,
    authorizationSha: AUTHORIZATION,
    currentMainSha: CURRENT,
    repositoryVisibility: "public",
    repositoryPrivate: false,
    mainProtected: true,
    sourceToAuthorizationStatus: "ahead",
    authorizationToCurrentStatus: "ahead",
    sourceWorkflowBlobSha: BLOB,
    authorizationWorkflowBlobSha: BLOB,
    currentWorkflowBlobSha: BLOB,
    ...overrides,
  };
}

test("accepts unrelated protected-main advances with byte-identical seal workflow", () => {
  const result = assertCommanderXpExternalWorkflowAuthorization(fixture());
  assert.equal(result.authorizationSha, AUTHORIZATION);
  assert.equal(result.currentMainSha, CURRENT);
  assert.equal(result.workflowBlobSha, BLOB);
});

test("rejects a seal-workflow change after the experiment source", () => {
  assert.throws(
    () =>
      assertCommanderXpExternalWorkflowAuthorization(
        fixture({ authorizationWorkflowBlobSha: "5".repeat(40) }),
      ),
    /workflow bytes changed/,
  );
});

test("rejects a non-monotonic source or rewritten main", () => {
  assert.throws(
    () =>
      assertCommanderXpExternalWorkflowAuthorization(
        fixture({ sourceToAuthorizationStatus: "diverged" }),
      ),
    /not monotonic/,
  );
  assert.throws(
    () =>
      assertCommanderXpExternalWorkflowAuthorization(
        fixture({ authorizationToCurrentStatus: "behind" }),
      ),
    /not monotonic/,
  );
});

test("rejects private or unprotected repository authority", () => {
  assert.throws(
    () =>
      assertCommanderXpExternalWorkflowAuthorization(
        fixture({ repositoryPrivate: true }),
      ),
    /repository authority is invalid/,
  );
  assert.throws(
    () =>
      assertCommanderXpExternalWorkflowAuthorization(
        fixture({ mainProtected: false }),
      ),
    /repository authority is invalid/,
  );
});
