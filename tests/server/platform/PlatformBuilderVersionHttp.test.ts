import express from "express";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlatformBuilderVersionRouter } from "../../../src/server/platform/PlatformBuilderVersionHttp";
import { PlatformAccountSecurity } from "../../../src/server/platform/PlatformAccountSecurity";
import { PlatformAccountStore } from "../../../src/server/platform/PlatformAccountStore";
import { PlatformGithubIdentityLinkStore } from "../../../src/server/platform/PlatformGithubIdentityLinkStore";
import { PlatformPolicyClaimStore } from "../../../src/server/platform/PlatformPolicyClaimStore";
import {
  applyOperatorAction,
  mutateBuilderClaimStore,
  submitClaim,
} from "../../../src/server/platform/PlatformBuilderClaimStore";
import { AnalyticsAggregateStore, totalEventCount } from "../../../src/server/analytics/AnalyticsAggregateStore";

const EXPECTED_ORIGIN = "https://platform.example.test";
const NOW = new Date("2026-08-01T00:00:00.000Z");

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function cookiePair(setCookieHeader: string | null): string {
  if (setCookieHeader === null) throw new Error("expected a Set-Cookie header");
  return setCookieHeader.split(";", 1)[0];
}

/** Verified `agt_daveey` claim for `accountId`, walking draft -> proof_pending -> verified via the operator path — identical sequence to `PlatformBuilderClaimStore.test.ts`'s own coverage of that path. */
async function seedVerifiedClaim(
  claimStateRoot: string,
  accountId: string,
  agentId: string,
): Promise<void> {
  let claimId = "";
  await mutateBuilderClaimStore(claimStateRoot, (file) => {
    const next = submitClaim(
      file,
      {
        accountId,
        githubLogin: "ada-builder",
        agentId,
        claimedCoworldPlayerName: "daveey-proxywar",
        builderDisplayName: "Ada Builder",
        builderShortBio: null,
        builderLinks: [],
        teamMembers: [],
        evidenceNote: "evidence",
        evidenceLinks: [],
      },
      NOW,
    );
    claimId = next.claims[next.claims.length - 1].id;
    return next;
  });
  await mutateBuilderClaimStore(claimStateRoot, (file) =>
    applyOperatorAction(file, claimId, "mark_proof_pending", "operator-jane", null, NOW),
  );
  await mutateBuilderClaimStore(claimStateRoot, (file) =>
    applyOperatorAction(file, claimId, "approve", "operator-jane", null, NOW),
  );
}

async function harness(
  releaseStateRoot: string,
  claimStateRoot: string,
  artifactsRootDir: string,
) {
  const accounts = await PlatformAccountStore.open(await tempDir("accounts-"));
  const policyClaims = await PlatformPolicyClaimStore.open(
    await tempDir("policy-claims-"),
  );
  const identityLinkStore = await PlatformGithubIdentityLinkStore.open(
    await tempDir("gh-links-"),
    accounts,
    policyClaims,
  );
  const security = new PlatformAccountSecurity({
    hmacKey: Buffer.alloc(32, 7),
    expectedOrigin: EXPECTED_ORIGIN,
    production: true,
    now: () => NOW,
  });
  const operatorErrors: unknown[] = [];
  const app = express();
  app.use(
    createPlatformBuilderVersionRouter({
      security,
      releaseStore: { stateRoot: releaseStateRoot },
      claimStore: { stateRoot: claimStateRoot },
      identityLinkStore,
      artifactsRootDir,
      onOperatorError: (code, error) => operatorErrors.push({ code, error }),
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server address unavailable");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    security,
    operatorErrors,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

/** Mints a fresh account (cookie + CSRF token) directly off the SAME `security` instance the router uses — this is exactly what a real first-visit `bootstrapRead`/`bootstrap` call does, done here without an extra HTTP round trip since the router's own GET route does not echo `csrfToken` (see `PlatformAccountHttp.ts`'s `/api/account` for where a real client gets one). */
function mintAccount(security: PlatformAccountSecurity): {
  accountId: string;
  cookie: string;
  csrfToken: string;
} {
  const bootstrap = security.bootstrapRead({ origin: EXPECTED_ORIGIN });
  return {
    accountId: bootstrap.account.accountId,
    cookie: cookiePair(bootstrap.setCookie),
    csrfToken: bootstrap.csrfToken,
  };
}

describe("PlatformBuilderVersionHttp", () => {
  let releaseStateRoot: string;
  let claimStateRoot: string;
  let artifactsRootDir: string;

  beforeEach(async () => {
    releaseStateRoot = await tempDir("version-release-store-");
    claimStateRoot = await tempDir("builder-claim-store-");
    artifactsRootDir = await tempDir("version-http-artifacts-");
  });

  afterEach(async () => {
    await rm(releaseStateRoot, { recursive: true, force: true });
    await rm(claimStateRoot, { recursive: true, force: true });
    await rm(artifactsRootDir, { recursive: true, force: true });
  });

  it("lets a verified builder submit a release notice for their own agent", async () => {
    const owner = { accountId: "" };
    const server = await harness(releaseStateRoot, claimStateRoot, artifactsRootDir);
    try {
      const security = server.security;
      const account = mintAccount(security);
      owner.accountId = account.accountId;
      await seedVerifiedClaim(claimStateRoot, account.accountId, "agt_daveey");

      const response = await fetch(`${server.baseUrl}/api/account/version-releases`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: EXPECTED_ORIGIN,
          Cookie: account.cookie,
          "x-csrf-token": account.csrfToken,
        },
        body: JSON.stringify({
          agentId: "agt_daveey",
          versionLabel: "v25",
          releaseNotes: "fixed diplomacy",
          baseModel: null,
          scaffoldDescription: null,
          sourceDisclosure: null,
          intendedChanges: null,
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        schemaVersion: number;
        release: { agentId: string; status: string; versionLabel: string };
      };
      expect(body.schemaVersion).toBe(1);
      expect(body.release).toMatchObject({
        agentId: "agt_daveey",
        status: "pending",
        versionLabel: "v25",
      });
      expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");

      const getResponse = await fetch(
        `${server.baseUrl}/api/account/version-releases`,
        { headers: { Origin: EXPECTED_ORIGIN, Cookie: account.cookie } },
      );
      expect(getResponse.status).toBe(200);
      const getBody = (await getResponse.json()) as {
        releases: readonly { agentId: string }[];
      };
      expect(getBody.releases).toHaveLength(1);
      expect(getBody.releases[0].agentId).toBe("agt_daveey");
    } finally {
      await server.close();
    }
  });

  it("emits a version_release_created analytics event after a successful submit", async () => {
    const server = await harness(releaseStateRoot, claimStateRoot, artifactsRootDir);
    try {
      const account = mintAccount(server.security);
      await seedVerifiedClaim(claimStateRoot, account.accountId, "agt_daveey");

      const response = await fetch(`${server.baseUrl}/api/account/version-releases`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: EXPECTED_ORIGIN,
          Cookie: account.cookie,
          "x-csrf-token": account.csrfToken,
        },
        body: JSON.stringify({
          agentId: "agt_daveey",
          versionLabel: "v25",
          releaseNotes: null,
          baseModel: null,
          scaffoldDescription: null,
          sourceDisclosure: null,
          intendedChanges: null,
        }),
      });
      expect(response.status).toBe(200);

      const file = await new AnalyticsAggregateStore(artifactsRootDir).readAll();
      expect(totalEventCount(file, "version_release_created")).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("rejects a release notice for an agent the caller has no verified claim for (403 PLATFORM_NOT_YOUR_AGENT)", async () => {
    const server = await harness(releaseStateRoot, claimStateRoot, artifactsRootDir);
    try {
      const security = server.security;
      const ownerAccount = mintAccount(security);
      await seedVerifiedClaim(claimStateRoot, ownerAccount.accountId, "agt_daveey");

      // A different account — never granted a verified claim for agt_daveey.
      const otherAccount = mintAccount(security);
      const response = await fetch(`${server.baseUrl}/api/account/version-releases`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: EXPECTED_ORIGIN,
          Cookie: otherAccount.cookie,
          "x-csrf-token": otherAccount.csrfToken,
        },
        body: JSON.stringify({
          agentId: "agt_daveey",
          versionLabel: "v99-hostile",
          releaseNotes: null,
          baseModel: null,
          scaffoldDescription: null,
          sourceDisclosure: null,
          intendedChanges: null,
        }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PLATFORM_NOT_YOUR_AGENT");

      const getResponse = await fetch(
        `${server.baseUrl}/api/account/version-releases`,
        { headers: { Origin: EXPECTED_ORIGIN, Cookie: ownerAccount.cookie } },
      );
      const getBody = (await getResponse.json()) as { releases: readonly unknown[] };
      expect(getBody.releases).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a write with no CSRF token", async () => {
    const server = await harness(releaseStateRoot, claimStateRoot, artifactsRootDir);
    try {
      const account = mintAccount(server.security);
      const response = await fetch(`${server.baseUrl}/api/account/version-releases`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: EXPECTED_ORIGIN,
          Cookie: account.cookie,
        },
        body: JSON.stringify({ agentId: "agt_daveey", versionLabel: "v1" }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PLATFORM_UNAUTHORIZED");
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid request body with 400 PLATFORM_INVALID_REQUEST", async () => {
    const server = await harness(releaseStateRoot, claimStateRoot, artifactsRootDir);
    try {
      const account = mintAccount(server.security);
      await seedVerifiedClaim(claimStateRoot, account.accountId, "agt_daveey");
      const response = await fetch(`${server.baseUrl}/api/account/version-releases`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: EXPECTED_ORIGIN,
          Cookie: account.cookie,
          "x-csrf-token": account.csrfToken,
        },
        body: JSON.stringify({ agentId: "agt_daveey" }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PLATFORM_INVALID_REQUEST");
    } finally {
      await server.close();
    }
  });
});
