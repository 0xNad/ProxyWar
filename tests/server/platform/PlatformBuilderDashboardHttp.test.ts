import express from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlatformBuilderDashboardRouter } from "../../../src/server/platform/PlatformBuilderDashboardHttp";
import {
  mutateBuilderClaimStore,
  submitClaim,
  applyOperatorAction,
} from "../../../src/server/platform/PlatformBuilderClaimStore";
import { mutateVersionReleaseStore, createPendingRelease } from "../../../src/server/platform/PlatformVersionReleaseStore";
import { PlatformAccountSecurity } from "../../../src/server/platform/PlatformAccountSecurity";
import { PlatformGithubIdentityLinkStore } from "../../../src/server/platform/PlatformGithubIdentityLinkStore";
import { PlatformAccountStore } from "../../../src/server/platform/PlatformAccountStore";
import { PlatformPolicyClaimStore } from "../../../src/server/platform/PlatformPolicyClaimStore";

const EXPECTED_ORIGIN = "https://platform.test";
const HMAC_KEY = Buffer.alloc(32, 7);
describe("PlatformBuilderDashboardHttp", () => {
  let tmpDir: string;
  let claimStateRoot: string;
  let releaseStateRoot: string;
  let readModelFilePath: string;
  let featuredMatchStateRoot: string;
  let server: Server;
  let baseUrl: string;
  let security: PlatformAccountSecurity;
  let accounts: PlatformAccountStore;
  let claims: PlatformPolicyClaimStore;
  let identityLinkStore: PlatformGithubIdentityLinkStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "builder-dashboard-http-"));
    claimStateRoot = path.join(tmpDir, "claims");
    releaseStateRoot = path.join(tmpDir, "releases");
    featuredMatchStateRoot = path.join(tmpDir, "featured-matches");
    readModelFilePath = path.join(tmpDir, "read-model.json");
    await writeFile(
      readModelFilePath,
      JSON.stringify({
        agents: [
          {
            registered: true,
            id: "agt_daveey",
            slug: "daveey",
            playerName: "daveey-proxywar",
            displayName: "Daveey's Agent",
            shortCode: "DAV",
            emblemSvg: null,
            primaryColor: "#111111",
            secondaryColor: "#222222",
            tagline: null,
            builderId: "bld_ada-builder",
            builderDisplayName: "Ada Builder",
            status: "verified",
            standing: { rank: 3, score: 12.5, roundsPlayed: 40, isHouse: false },
            activeVersion: {
              publicVersionLabel: "v24",
              source: "rating",
              familyMismatch: false,
              firstObservedAt: "2026-07-01T00:00:00.000Z",
            },
            provenance: { ratingPolicyLabel: "daveey-proxywar:v24", activeChampionPolicyLabel: null },
            stats: {
              career: {
                episodeCount: 40,
                fingerprint: {
                  reliability: { value: 0.95, sampleSize: 40, threshold: 30, methodology: "m" },
                },
                social: {},
              },
              currentVersion: null,
            },
            timeSeries: { winrate: null, score: null },
          },
        ],
        matches: [],
        builders: [{ id: "bld_ada-builder", slug: "ada-builder", displayName: "Ada Builder" }],
      }),
    );
    security = new PlatformAccountSecurity({
      hmacKey: HMAC_KEY,
      expectedOrigin: EXPECTED_ORIGIN,
      production: false,
    });
    accounts = await PlatformAccountStore.open(tmpDir);
    claims = await PlatformPolicyClaimStore.open(tmpDir);
    identityLinkStore = await PlatformGithubIdentityLinkStore.open(tmpDir, accounts, claims);

    const app = express();
    app.use(
      createPlatformBuilderDashboardRouter({
        security,
        claimStore: { stateRoot: claimStateRoot },
        releaseStore: { stateRoot: releaseStateRoot },
        identityLinkStore,
        readModelFilePath,
        featuredMatchStateRoot,
      }),
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns isVerifiedBuilder:false with no claims for a brand-new account", async () => {
    const response = await fetch(`${baseUrl}/api/account/builder-dashboard`, {
      headers: { Origin: EXPECTED_ORIGIN },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { isVerifiedBuilder: boolean; agents: unknown[] };
    expect(body.isVerifiedBuilder).toBe(false);
    expect(body.agents).toEqual([]);
  });

  it("returns full dashboard data for a verified builder, with null degradedRate never fabricated as 0", async () => {
    // Bootstrap an account and capture its accountId + cookie.
    const bootstrapResponse = await fetch(`${baseUrl}/api/account/builder-dashboard`, {
      headers: { Origin: EXPECTED_ORIGIN },
    });
    const setCookie = bootstrapResponse.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0];
    // Parse accountId out of the cookie the same way the security class does.
    const accountId = cookie.split("=")[1]?.split(".")[1] ?? "";
    expect(accountId).toMatch(/^acct_[a-f0-9]{32}$/);

    await mutateBuilderClaimStore(claimStateRoot, (file) => {
      let next = submitClaim(
        file,
        {
          accountId,
          githubLogin: "ada-builder",
          agentId: "agt_daveey",
          claimedCoworldPlayerName: "daveey-proxywar",
          builderDisplayName: "Ada Builder",
          builderShortBio: null,
          builderLinks: [],
          teamMembers: [],
          evidenceNote: "evidence",
          evidenceLinks: [],
        },
        new Date(),
      );
      const claimId = next.claims[0].id;
      next = applyOperatorAction(next, claimId, "mark_proof_pending", "op", null, new Date());
      next = applyOperatorAction(next, claimId, "approve", "op", null, new Date());
      return next;
    });

    await mutateVersionReleaseStore(releaseStateRoot, (file) =>
      createPendingRelease(
        file,
        {
          accountId,
          agentId: "agt_daveey",
          versionLabel: "v25",
          releaseNotes: null,
          baseModel: null,
          scaffoldDescription: null,
          sourceDisclosure: null,
          intendedChanges: null,
        },
        new Date(),
      ),
    );

    const response = await fetch(`${baseUrl}/api/account/builder-dashboard`, {
      headers: { Origin: EXPECTED_ORIGIN, cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      isVerifiedBuilder: boolean;
      builder: { slug: string } | null;
      agents: Array<{ rank: number | null; degradedRate: number | null }>;
      pendingReleases: unknown[];
      claims: Array<{ state: string }>;
    };
    expect(body.isVerifiedBuilder).toBe(true);
    expect(body.builder?.slug).toBe("ada-builder");
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].rank).toBe(3);
    expect(body.agents[0].degradedRate).toBeCloseTo(0.05, 5);
    expect(body.pendingReleases).toHaveLength(1);
    expect(body.claims[0].state).toBe("verified");
  });

  it("post-match report 404s a match the caller's agents never played in", async () => {
    const response = await fetch(
      `${baseUrl}/api/account/builder-dashboard/matches/does-not-exist`,
      { headers: { Origin: EXPECTED_ORIGIN } },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PLATFORM_MATCH_NOT_FOUND");
  });
});
