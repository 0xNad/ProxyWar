/**
 * `/api/account/builder-claims*` — the claimant-facing HTTP surface for
 * Season Zero Phase 3's REAL Builder/Agent claim workflow. Covers every
 * route, every state transition reachable from HTTP, and every documented
 * error code — see `PlatformBuilderClaimHttp.ts`'s doc for the contract.
 *
 * Deliberately never lets a claim reach `verified` here: that transition
 * is `identity:claims approve`'s alone (see `identity-claims.test.ts`),
 * and this file's job is to prove the HTTP layer never provides a second
 * path to it.
 */
import express from "express";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyOperatorAction,
  mutateBuilderClaimStore,
  submitClaim,
  type BuilderClaimSubmission,
} from "../../../src/server/platform/PlatformBuilderClaimStore";
import { createPlatformBuilderClaimRouter } from "../../../src/server/platform/PlatformBuilderClaimHttp";
import { PlatformAccountSecurity } from "../../../src/server/platform/PlatformAccountSecurity";
import { PlatformAccountStore } from "../../../src/server/platform/PlatformAccountStore";
import { PlatformGithubIdentityLinkStore } from "../../../src/server/platform/PlatformGithubIdentityLinkStore";
import { PlatformPolicyClaimStore } from "../../../src/server/platform/PlatformPolicyClaimStore";

const ORIGIN = "https://proxywar.test";
const AGENT_ID = "agt_daveey";

let accountStateRoot: string;
let claimStateRoot: string;
let identityRegistryDir: string;
let server: http.Server;
let baseUrl: string;
let security: PlatformAccountSecurity;
let identityLinkStore: PlatformGithubIdentityLinkStore;
let nextGithubUserId = 900_000;

function baseAgentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT_ID,
    slug: "daveey",
    displayName: "Daveey",
    shortCode: "DAV",
    builderId: null,
    tagline: null,
    description: null,
    emblem: {
      style: "geometric-svg-v1",
      seed: AGENT_ID,
      assetPath: `resources/identity/emblems/${AGENT_ID}.svg`,
    },
    primaryColor: "#112233",
    secondaryColor: "#445566",
    debutDate: null,
    policyMatchRule: { playerName: "daveey-proxywar", policyFamily: "daveey-proxywar" },
    status: "unclaimed",
    publicStrategyDescription: null,
    ...overrides,
  };
}

async function writeRegistryFixture(
  dir: string,
  agents: readonly unknown[] = [baseAgentFixture()],
  builders: readonly unknown[] = [],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "agents.json"),
    JSON.stringify({ schemaVersion: 1, agents }),
  );
  await writeFile(
    path.join(dir, "builders.json"),
    JSON.stringify({ schemaVersion: 1, builders }),
  );
  await writeFile(
    path.join(dir, "versions.json"),
    JSON.stringify({ schemaVersion: 1, versions: [] }),
  );
}

interface SignedInAccount {
  readonly accountId: string;
  readonly cookie: string;
  readonly csrfToken: string;
}

/** Mints a fresh platform account directly through `security.bootstrap` (bypassing HTTP, exactly like `PlatformGithubAuth.test.ts` does for its own setup) and links it to a synthetic GitHub identity. */
async function mintSignedInAccount(login: string): Promise<SignedInAccount> {
  const bootstrap = security.bootstrap(undefined);
  nextGithubUserId += 1;
  await identityLinkStore.linkOrMerge(bootstrap.account.accountId, {
    githubUserId: nextGithubUserId,
    login,
    avatarUrl: null,
  });
  const cookie = bootstrap.setCookie !== null ? bootstrap.setCookie.split(";")[0] : "";
  return { accountId: bootstrap.account.accountId, cookie, csrfToken: bootstrap.csrfToken };
}

/** Mints an account with NO GitHub link — the `PLATFORM_GITHUB_SIGNIN_REQUIRED` case. */
function mintUnlinkedAccount(): SignedInAccount {
  const bootstrap = security.bootstrap(undefined);
  const cookie = bootstrap.setCookie !== null ? bootstrap.setCookie.split(";")[0] : "";
  return { accountId: bootstrap.account.accountId, cookie, csrfToken: bootstrap.csrfToken };
}

function writeHeaders(account: SignedInAccount): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: ORIGIN,
    Cookie: account.cookie,
    "x-csrf-token": account.csrfToken,
  };
}

function readHeaders(account: SignedInAccount): Record<string, string> {
  return { Origin: ORIGIN, Cookie: account.cookie };
}

function validSubmissionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: AGENT_ID,
    claimedCoworldPlayerName: "daveey-proxywar",
    builderDisplayName: "Ada Builder",
    builderShortBio: "I build agents.",
    builderLinks: ["https://github.com/ada-builder"],
    teamMembers: ["Ada"],
    evidenceNote: "This is my GitHub repo and Coworld player.",
    evidenceLinks: ["https://github.com/ada-builder/proxywar-agent"],
    ...overrides,
  };
}

beforeEach(async () => {
  accountStateRoot = await mkdtemp(
    path.join(os.tmpdir(), "pw-builder-claim-http-account-"),
  );
  claimStateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-builder-claim-http-claims-"));
  identityRegistryDir = await mkdtemp(
    path.join(os.tmpdir(), "pw-builder-claim-http-registry-"),
  );
  await writeRegistryFixture(identityRegistryDir);

  const accounts = await PlatformAccountStore.open(accountStateRoot);
  const policyClaims = await PlatformPolicyClaimStore.open(accountStateRoot);
  identityLinkStore = await PlatformGithubIdentityLinkStore.open(
    accountStateRoot,
    accounts,
    policyClaims,
  );
  security = new PlatformAccountSecurity({
    hmacKey: new Uint8Array(32).fill(7),
    expectedOrigin: ORIGIN,
    production: false,
  });

  const app = express();
  app.use(
    createPlatformBuilderClaimRouter({
      security,
      claimStore: { stateRoot: claimStateRoot },
      identityLinkStore,
      identityRegistryDir,
    }),
  );
  server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(accountStateRoot, { recursive: true, force: true });
  await rm(claimStateRoot, { recursive: true, force: true });
  await rm(identityRegistryDir, { recursive: true, force: true });
});

describe("PlatformBuilderClaimHttp", () => {
  it("submits a draft, lists it, issues a nonce challenge, then marks proof pending", async () => {
    const account = await mintSignedInAccount("ada-builder");

    const submitResponse = await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(account),
      body: JSON.stringify(validSubmissionBody()),
    });
    expect(submitResponse.status).toBe(200);
    expect(submitResponse.headers.get("cache-control")).toBe("no-store, max-age=0");
    const submitBody = await submitResponse.json();
    expect(submitBody.schemaVersion).toBe(1);
    expect(submitBody.claim.state).toBe("draft");
    expect(submitBody.claim.agentId).toBe(AGENT_ID);
    expect(submitBody.claim.accountId).toBe(account.accountId);
    expect(submitBody.claim.githubLogin).toBe("ada-builder");
    const claimId = submitBody.claim.id as string;

    const listResponse = await fetch(`${baseUrl}/api/account/builder-claims`, {
      headers: readHeaders(account),
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.schemaVersion).toBe(1);
    expect(listBody.claims).toHaveLength(1);
    expect(listBody.claims[0].id).toBe(claimId);

    const challengeResponse = await fetch(
      `${baseUrl}/api/account/builder-claims/${claimId}/challenge`,
      { method: "POST", headers: writeHeaders(account), body: "{}" },
    );
    expect(challengeResponse.status).toBe(200);
    const challengeBody = await challengeResponse.json();
    expect(challengeBody.claim.state).toBe("challenge_issued");
    expect(challengeBody.claim.nonceChallenge).not.toBeNull();
    expect(challengeBody.claim.nonceChallenge.instructions).toContain("Daveey");

    const proofResponse = await fetch(
      `${baseUrl}/api/account/builder-claims/${claimId}/proof`,
      {
        method: "POST",
        headers: writeHeaders(account),
        body: JSON.stringify({
          evidenceNote: "Submitted a policy version carrying the nonce.",
          evidenceLinks: ["https://github.com/ada-builder/proxywar-agent/commit/abc"],
        }),
      },
    );
    expect(proofResponse.status).toBe(200);
    const proofBody = await proofResponse.json();
    expect(proofBody.claim.state).toBe("proof_pending");
    expect(proofBody.claim.evidence).toHaveLength(2);
  });

  it("lists only the caller's own claims, never another account's", async () => {
    const accountA = await mintSignedInAccount("ada-builder");
    const accountB = await mintSignedInAccount("bea-builder");
    await writeRegistryFixture(identityRegistryDir, [
      baseAgentFixture(),
      baseAgentFixture({ id: "agt_other", slug: "other", displayName: "Other" }),
    ]);

    await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(accountA),
      body: JSON.stringify(validSubmissionBody()),
    });
    await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(accountB),
      body: JSON.stringify(validSubmissionBody({ agentId: "agt_other" })),
    });

    const listA = await (
      await fetch(`${baseUrl}/api/account/builder-claims`, { headers: readHeaders(accountA) })
    ).json();
    expect(listA.claims).toHaveLength(1);
    expect(listA.claims[0].accountId).toBe(accountA.accountId);

    const listB = await (
      await fetch(`${baseUrl}/api/account/builder-claims`, { headers: readHeaders(accountB) })
    ).json();
    expect(listB.claims).toHaveLength(1);
    expect(listB.claims[0].accountId).toBe(accountB.accountId);
  });

  it("rejects submission with 403 PLATFORM_GITHUB_SIGNIN_REQUIRED when the caller never linked GitHub", async () => {
    const account = mintUnlinkedAccount();
    const response = await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(account),
      body: JSON.stringify(validSubmissionBody()),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("PLATFORM_GITHUB_SIGNIN_REQUIRED");
  });

  it("rejects submission with 404 PLATFORM_AGENT_NOT_FOUND for an unknown agentId", async () => {
    const account = await mintSignedInAccount("ada-builder");
    const response = await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(account),
      body: JSON.stringify(validSubmissionBody({ agentId: "agt_does_not_exist" })),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("PLATFORM_AGENT_NOT_FOUND");
  });

  it("rejects submission with 400 PLATFORM_INVALID_REQUEST for a malformed body", async () => {
    const account = await mintSignedInAccount("ada-builder");
    const response = await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(account),
      body: JSON.stringify({ agentId: AGENT_ID }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("PLATFORM_INVALID_REQUEST");
  });

  it("rejects submission with 409 PLATFORM_ALREADY_VERIFIED when another account already holds a verified claim on the agent", async () => {
    const verifiedHolder = await mintSignedInAccount("verified-holder");
    const now = new Date("2026-08-01T00:00:00.000Z");
    const seedSubmission: BuilderClaimSubmission = {
      accountId: verifiedHolder.accountId,
      githubLogin: "verified-holder",
      agentId: AGENT_ID,
      claimedCoworldPlayerName: "daveey-proxywar",
      builderDisplayName: "Verified Holder",
      builderShortBio: null,
      builderLinks: [],
      teamMembers: [],
      evidenceNote: "evidence",
      evidenceLinks: [],
    };
    let seededClaimId = "";
    await mutateBuilderClaimStore(claimStateRoot, (file) => {
      const submitted = submitClaim(file, seedSubmission, now);
      seededClaimId = submitted.claims[submitted.claims.length - 1].id;
      const proofPending = applyOperatorAction(
        submitted,
        seededClaimId,
        "mark_proof_pending",
        "test-operator",
        null,
        now,
      );
      return applyOperatorAction(
        proofPending,
        seededClaimId,
        "approve",
        "test-operator",
        null,
        now,
      );
    });

    const challenger = await mintSignedInAccount("challenger");
    const response = await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(challenger),
      body: JSON.stringify(validSubmissionBody()),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("PLATFORM_ALREADY_VERIFIED");
  });

  it("returns 404 PLATFORM_BUILDER_CLAIM_NOT_FOUND (never 403) when a non-owner acts on someone else's claim", async () => {
    const owner = await mintSignedInAccount("owner-builder");
    const submitResponse = await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(owner),
      body: JSON.stringify(validSubmissionBody()),
    });
    const claimId = (await submitResponse.json()).claim.id as string;

    const intruder = await mintSignedInAccount("intruder-builder");
    const proofAttempt = await fetch(
      `${baseUrl}/api/account/builder-claims/${claimId}/proof`,
      {
        method: "POST",
        headers: writeHeaders(intruder),
        body: JSON.stringify({ evidenceNote: "not mine", evidenceLinks: [] }),
      },
    );
    expect(proofAttempt.status).toBe(404);
    expect((await proofAttempt.json()).error.code).toBe("PLATFORM_BUILDER_CLAIM_NOT_FOUND");

    const withdrawAttempt = await fetch(
      `${baseUrl}/api/account/builder-claims/${claimId}/withdraw`,
      { method: "POST", headers: writeHeaders(intruder), body: "{}" },
    );
    expect(withdrawAttempt.status).toBe(404);
    expect((await withdrawAttempt.json()).error.code).toBe("PLATFORM_BUILDER_CLAIM_NOT_FOUND");

    const challengeAttempt = await fetch(
      `${baseUrl}/api/account/builder-claims/${claimId}/challenge`,
      { method: "POST", headers: writeHeaders(intruder), body: "{}" },
    );
    expect(challengeAttempt.status).toBe(404);
    expect((await challengeAttempt.json()).error.code).toBe("PLATFORM_BUILDER_CLAIM_NOT_FOUND");
  });

  it("returns 404 PLATFORM_BUILDER_CLAIM_NOT_FOUND for a claim id that never existed", async () => {
    const account = await mintSignedInAccount("ada-builder");
    const response = await fetch(
      `${baseUrl}/api/account/builder-claims/clm_00000000000000000000000000/withdraw`,
      { method: "POST", headers: writeHeaders(account), body: "{}" },
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("PLATFORM_BUILDER_CLAIM_NOT_FOUND");
  });

  it("returns 409 PLATFORM_BUILDER_CLAIM_INVALID_TRANSITION for an illegal transition", async () => {
    const account = await mintSignedInAccount("ada-builder");
    const submitResponse = await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: writeHeaders(account),
      body: JSON.stringify(validSubmissionBody()),
    });
    const claimId = (await submitResponse.json()).claim.id as string;

    const withdrawResponse = await fetch(
      `${baseUrl}/api/account/builder-claims/${claimId}/withdraw`,
      { method: "POST", headers: writeHeaders(account), body: "{}" },
    );
    expect(withdrawResponse.status).toBe(200);
    expect((await withdrawResponse.json()).claim.state).toBe("rejected");

    // A withdrawn (terminal) claim can never transition again.
    const secondWithdraw = await fetch(
      `${baseUrl}/api/account/builder-claims/${claimId}/withdraw`,
      { method: "POST", headers: writeHeaders(account), body: "{}" },
    );
    expect(secondWithdraw.status).toBe(409);
    expect((await secondWithdraw.json()).error.code).toBe(
      "PLATFORM_BUILDER_CLAIM_INVALID_TRANSITION",
    );

    const proofAfterWithdraw = await fetch(
      `${baseUrl}/api/account/builder-claims/${claimId}/proof`,
      {
        method: "POST",
        headers: writeHeaders(account),
        body: JSON.stringify({ evidenceNote: "too late", evidenceLinks: [] }),
      },
    );
    expect(proofAfterWithdraw.status).toBe(409);
    expect((await proofAfterWithdraw.json()).error.code).toBe(
      "PLATFORM_BUILDER_CLAIM_INVALID_TRANSITION",
    );
  });

  it("rejects a write with no CSRF token as an unauthorized platform-security failure, not a claim-store error", async () => {
    const account = await mintSignedInAccount("ada-builder");
    const response = await fetch(`${baseUrl}/api/account/builder-claims`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: account.cookie,
      },
      body: JSON.stringify(validSubmissionBody()),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("PLATFORM_UNAUTHORIZED");
  });
});
