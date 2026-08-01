/**
 * `POST`/`GET /api/account/builder-profile-edits` against a real Express
 * app + HTTP server, exactly the pattern `PlatformPovClaims.test.ts`
 * already established for `PlatformAccountHttp.ts` — this file is its
 * sibling for the builder-improvement loop's self-service edit route.
 */
import express from "express";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadIdentityRegistrySnapshot,
  saveAgentRegistry,
  saveAgentVersionRegistry,
  saveBuilderRegistry,
} from "../../../src/server/identity/IdentityRegistry";
import {
  applyOperatorAction,
  markProofPending,
  mutateBuilderClaimStore,
  submitClaim,
  type BuilderClaimSubmission,
} from "../../../src/server/platform/PlatformBuilderClaimStore";
import { createPlatformBuilderEditRouter } from "../../../src/server/platform/PlatformBuilderEditHttp";
import { PlatformAccountSecurity } from "../../../src/server/platform/PlatformAccountSecurity";
import { PlatformAccountStore } from "../../../src/server/platform/PlatformAccountStore";
import { PlatformGithubIdentityLinkStore } from "../../../src/server/platform/PlatformGithubIdentityLinkStore";
import { PlatformPolicyClaimStore } from "../../../src/server/platform/PlatformPolicyClaimStore";

const ORIGIN = "https://app.proxywar.xyz";
const NOW = new Date("2026-08-01T00:00:00.000Z");

let stateRoot: string;
let claimStateRoot: string;
let editStateRoot: string;
let registryDir: string;
let security: PlatformAccountSecurity;
let baseUrl: string;
let server: http.Server;

interface Fetched {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function request(
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Fetched> {
  let resolve!: (value: Fetched) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Fetched>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const request = http.request(
    `${baseUrl}${urlPath}`,
    { method, headers },
    (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (responseBody += chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: responseBody,
        }),
      );
    },
  );
  request.on("error", reject);
  if (body !== undefined) request.write(body);
  request.end();
  return promise;
}

function accountCookieFor(setCookie: readonly string[]): string {
  return setCookie
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => pair.includes("="))
    .join("; ");
}

/** Bootstraps a fresh account and returns its cookie header + csrfToken + accountId. */
async function bootstrapAccount(): Promise<{ cookie: string; csrfToken: string; accountId: string }> {
  const response = await request("GET", "/api/account/builder-profile-edits", {
    Origin: ORIGIN,
  });
  const setCookie = response.headers["set-cookie"] ?? [];
  const cookie = accountCookieFor(setCookie);
  const body = JSON.parse(response.body) as { edits: unknown[] };
  expect(body.edits).toEqual([]);
  // The GET route doesn't return csrfToken/accountId (only the account
  // route does) — mint a write-authorized session by round-tripping
  // through `security` directly against the same cookie the server just
  // issued, mirroring what `/api/account` would hand a real client.
  const bootstrap = security.bootstrapRead({ cookie, origin: ORIGIN });
  return { cookie, csrfToken: bootstrap.csrfToken, accountId: bootstrap.account.accountId };
}

function baseSubmission(overrides: Partial<BuilderClaimSubmission> = {}): BuilderClaimSubmission {
  return {
    accountId: "acct_00000000000000000000000000000001",
    githubLogin: "ada-builder",
    agentId: "agt_daveey",
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

/** Walks a claim all the way to `verified` for `accountId` on `agentId`. */
async function verifyClaim(accountId: string, agentId: string): Promise<void> {
  await mutateBuilderClaimStore(claimStateRoot, (file) => {
    let next = submitClaim(file, baseSubmission({ accountId, agentId }), NOW);
    const claimId = next.claims[next.claims.length - 1].id;
    next = markProofPending(next, claimId, accountId, "proof", [], NOW);
    next = applyOperatorAction(next, claimId, "approve", "operator-test", "looks good", NOW);
    return next;
  });
}

async function seedRegistry(): Promise<void> {
  await mkdir(registryDir, { recursive: true });
  await saveBuilderRegistry(
    [
      {
        id: "bld_ada",
        slug: "ada",
        displayName: "Ada",
        shortBio: null,
        avatarUrl: null,
        verifiedGithub: null,
        links: [],
        teamMembers: [],
        softmaxPlayerIdentities: [],
        status: "verified",
      },
      {
        id: "bld_other",
        slug: "other",
        displayName: "Other Builder",
        shortBio: null,
        avatarUrl: null,
        verifiedGithub: null,
        links: [],
        teamMembers: [],
        softmaxPlayerIdentities: [],
        status: "verified",
      },
    ],
    path.join(registryDir, "builders.json"),
  );
  await saveAgentRegistry(
    [
      {
        id: "agt_daveey",
        slug: "daveey",
        displayName: "Daveey",
        shortCode: "DAV",
        builderId: "bld_ada",
        tagline: "Old tagline",
        description: null,
        emblem: { style: "geometric-svg-v1", seed: "agt_daveey", assetPath: "resources/identity/emblems/agt_daveey.svg" },
        primaryColor: "#112233",
        secondaryColor: "#445566",
        debutDate: null,
        policyMatchRule: { playerName: "daveey-proxywar", policyFamily: "daveey-proxywar" },
        status: "verified",
        publicStrategyDescription: null,
      },
      {
        id: "agt_other",
        slug: "other-agent",
        displayName: "Other Agent",
        shortCode: "OTH",
        builderId: "bld_other",
        tagline: null,
        description: null,
        emblem: { style: "geometric-svg-v1", seed: "agt_other", assetPath: "resources/identity/emblems/agt_other.svg" },
        primaryColor: "#112233",
        secondaryColor: "#445566",
        debutDate: null,
        policyMatchRule: { playerName: "other-player", policyFamily: "other-player" },
        status: "verified",
        publicStrategyDescription: null,
      },
    ],
    path.join(registryDir, "agents.json"),
  );
  await saveAgentVersionRegistry(
    [
      {
        id: "agtv_daveey_v24",
        agentId: "agt_daveey",
        publicVersionLabel: "v24",
        softmaxPolicyLabel: "daveey-proxywar:v24",
        immutableDigest: null,
        releaseDate: null,
        releaseNotes: null,
        declaredBaseModel: null,
        scaffoldDescription: null,
        sourceRepositoryRef: null,
        disclosureStatus: "undisclosed",
        qualificationStatus: "active",
        observedVia: ["champion"],
        observedAt: "2026-08-01T00:00:00.000Z",
        firstObservedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    path.join(registryDir, "versions.json"),
  );
}

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "pw-builder-edit-http-"));
  claimStateRoot = path.join(stateRoot, "claims");
  editStateRoot = path.join(stateRoot, "edits");
  registryDir = path.join(stateRoot, "registry");
  await seedRegistry();

  const accounts = await PlatformAccountStore.open(stateRoot);
  const policyClaims = await PlatformPolicyClaimStore.open(stateRoot);
  const identityLinkStore = await PlatformGithubIdentityLinkStore.open(
    stateRoot,
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
    createPlatformBuilderEditRouter({
      security,
      editStore: { stateRoot: editStateRoot },
      claimStore: { stateRoot: claimStateRoot },
      identityLinkStore,
      identityRegistryDir: registryDir,
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
  await rm(stateRoot, { recursive: true, force: true });
});

function postHeaders(cookie: string, csrfToken: string): Record<string, string> {
  return {
    Origin: ORIGIN,
    Cookie: cookie,
    "x-csrf-token": csrfToken,
    "content-type": "application/json",
  };
}

describe("GET /api/account/builder-profile-edits", () => {
  test("returns only the caller's own edits, with Cache-Control: no-store", async () => {
    const response = await request("GET", "/api/account/builder-profile-edits", { Origin: ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    const body = JSON.parse(response.body) as { schemaVersion: number; edits: unknown[] };
    expect(body).toEqual({ schemaVersion: 1, edits: [] });
  });
});

describe("POST /api/account/builder-profile-edits", () => {
  test("a caller with no verified claim is refused with PLATFORM_NOT_A_VERIFIED_BUILDER", async () => {
    const { cookie, csrfToken } = await bootstrapAccount();
    const response = await request(
      "POST",
      "/api/account/builder-profile-edits",
      postHeaders(cookie, csrfToken),
      JSON.stringify({
        targetKind: "builder",
        targetId: "bld_ada",
        field: "displayName",
        proposedValue: "New Name",
      }),
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: { code: "PLATFORM_NOT_A_VERIFIED_BUILDER" } });
  });

  test("a verified builder targeting a DIFFERENT builder's profile is refused with PLATFORM_NOT_YOUR_BUILDER_PROFILE", async () => {
    const { cookie, csrfToken, accountId } = await bootstrapAccount();
    await verifyClaim(accountId, "agt_daveey");
    const response = await request(
      "POST",
      "/api/account/builder-profile-edits",
      postHeaders(cookie, csrfToken),
      JSON.stringify({
        targetKind: "builder",
        targetId: "bld_other",
        field: "displayName",
        proposedValue: "Hijacked Name",
      }),
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: { code: "PLATFORM_NOT_YOUR_BUILDER_PROFILE" } });
  });

  test("a disallowed field on an owned builder is refused with PLATFORM_FIELD_NOT_EDITABLE", async () => {
    const { cookie, csrfToken, accountId } = await bootstrapAccount();
    await verifyClaim(accountId, "agt_daveey");
    const response = await request(
      "POST",
      "/api/account/builder-profile-edits",
      postHeaders(cookie, csrfToken),
      JSON.stringify({
        targetKind: "builder",
        targetId: "bld_ada",
        field: "verifiedGithub",
        proposedValue: "someone-else",
      }),
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: { code: "PLATFORM_FIELD_NOT_EDITABLE" } });
  });

  test("a malformed proposedValue (displayName over 80 chars) is refused with PLATFORM_INVALID_REQUEST and never queued", async () => {
    const { cookie, csrfToken, accountId } = await bootstrapAccount();
    await verifyClaim(accountId, "agt_daveey");
    const response = await request(
      "POST",
      "/api/account/builder-profile-edits",
      postHeaders(cookie, csrfToken),
      JSON.stringify({
        targetKind: "builder",
        targetId: "bld_ada",
        field: "displayName",
        proposedValue: "x".repeat(81),
      }),
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: { code: "PLATFORM_INVALID_REQUEST" } });

    const getResponse = await request("GET", "/api/account/builder-profile-edits", {
      Origin: ORIGIN,
      Cookie: cookie,
    });
    expect(JSON.parse(getResponse.body).edits).toEqual([]);
  });

  test("a valid builder-target edit from its owner is queued pending, with a correct previousValue snapshot", async () => {
    const { cookie, csrfToken, accountId } = await bootstrapAccount();
    await verifyClaim(accountId, "agt_daveey");
    const response = await request(
      "POST",
      "/api/account/builder-profile-edits",
      postHeaders(cookie, csrfToken),
      JSON.stringify({
        targetKind: "builder",
        targetId: "bld_ada",
        field: "displayName",
        proposedValue: "Ada the Great",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    const body = JSON.parse(response.body) as { schemaVersion: number; edit: Record<string, unknown> };
    expect(body.edit.status).toBe("pending");
    expect(body.edit.targetKind).toBe("builder");
    expect(body.edit.targetId).toBe("bld_ada");
    expect(body.edit.field).toBe("displayName");
    expect(body.edit.previousValue).toBe("Ada");
    expect(body.edit.proposedValue).toBe("Ada the Great");

    const getResponse = await request("GET", "/api/account/builder-profile-edits", {
      Origin: ORIGIN,
      Cookie: cookie,
    });
    const edits = JSON.parse(getResponse.body).edits as unknown[];
    expect(edits).toHaveLength(1);
  });

  test("an agent-target edit is authorized via the agent's builderId, not the agent id itself", async () => {
    const { cookie, csrfToken, accountId } = await bootstrapAccount();
    await verifyClaim(accountId, "agt_daveey");
    const response = await request(
      "POST",
      "/api/account/builder-profile-edits",
      postHeaders(cookie, csrfToken),
      JSON.stringify({
        targetKind: "agent",
        targetId: "agt_daveey",
        field: "tagline",
        proposedValue: "A new tagline",
      }),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { edit: Record<string, unknown> };
    expect(body.edit.previousValue).toBe("Old tagline");
    expect(body.edit.proposedValue).toBe("A new tagline");
  });

  test("a version-target edit is authorized via versionAgent -> agent.builderId", async () => {
    const { cookie, csrfToken, accountId } = await bootstrapAccount();
    await verifyClaim(accountId, "agt_daveey");
    const response = await request(
      "POST",
      "/api/account/builder-profile-edits",
      postHeaders(cookie, csrfToken),
      JSON.stringify({
        targetKind: "version",
        targetId: "agtv_daveey_v24",
        field: "declaredBaseModel",
        proposedValue: "gpt-test",
      }),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { edit: Record<string, unknown> };
    expect(body.edit.previousValue).toBeNull();
    expect(body.edit.proposedValue).toBe("gpt-test");
  });

  test("never touches the tracked identity registry itself — the edit stays staged", async () => {
    const { cookie, csrfToken, accountId } = await bootstrapAccount();
    await verifyClaim(accountId, "agt_daveey");
    await request(
      "POST",
      "/api/account/builder-profile-edits",
      postHeaders(cookie, csrfToken),
      JSON.stringify({
        targetKind: "builder",
        targetId: "bld_ada",
        field: "displayName",
        proposedValue: "Ada the Great",
      }),
    );
    const snapshot = await loadIdentityRegistrySnapshot(registryDir);
    const builder = snapshot.builders.find((candidate) => candidate.id === "bld_ada");
    expect(builder?.displayName).toBe("Ada");
  });
});
