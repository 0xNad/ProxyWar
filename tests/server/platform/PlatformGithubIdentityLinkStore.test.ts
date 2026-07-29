import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlatformAccountStore } from "../../../src/server/platform/PlatformAccountStore";
import { PlatformGithubIdentityLinkStore } from "../../../src/server/platform/PlatformGithubIdentityLinkStore";
import { PlatformPolicyClaimStore } from "../../../src/server/platform/PlatformPolicyClaimStore";

const acctA = `acct_${"a".repeat(32)}`;
const acctB = `acct_${"b".repeat(32)}`;

describe("PlatformGithubIdentityLinkStore", () => {
  let root: string;
  let accounts: PlatformAccountStore;
  let claims: PlatformPolicyClaimStore;
  let links: PlatformGithubIdentityLinkStore;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "platform-github-links-"));
    accounts = await PlatformAccountStore.open(root);
    claims = await PlatformPolicyClaimStore.open(root);
    links = await PlatformGithubIdentityLinkStore.open(root, accounts, claims);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("resolveCanonicalAccountId is the identity function before any link exists", async () => {
    expect(await links.resolveCanonicalAccountId(acctA)).toBe(acctA);
  });

  test("first link for a GitHub id becomes its own canonical account", async () => {
    const result = await links.linkOrMerge(acctA, {
      githubUserId: 918273,
      login: "octocat-alice",
      avatarUrl: null,
    });
    expect(result).toEqual({
      canonicalAccountId: acctA,
      login: "octocat-alice",
      avatarUrl: null,
      merged: false,
      claimReplaced: false,
    });
    const status = await links.getStatus(acctA);
    expect(status).toEqual({
      signedIn: true,
      login: "octocat-alice",
      avatarUrl: null,
      canonicalAccountId: acctA,
    });
  });

  test("a second account linking the SAME GitHub id merges into the first's canonical account, folding displayName and claim", async () => {
    await accounts.setDisplayName(acctA, "FirstDisplayName");
    await claims.setClaim(acctA, "first-lineage:v1");
    await links.linkOrMerge(acctA, {
      githubUserId: 555,
      login: "shared-handle",
      avatarUrl: null,
    });
    await accounts.setDisplayName(acctB, "SecondDisplayName");
    const result = await links.linkOrMerge(acctB, {
      githubUserId: 555,
      login: "shared-handle",
      avatarUrl: "https://example.test/avatar.png",
    });
    expect(result.canonicalAccountId).toBe(acctA);
    expect(result.merged).toBe(true);
    expect(await links.resolveCanonicalAccountId(acctB)).toBe(acctA);
    // Target (acctA) already had a display name — it wins on merge.
    expect((await accounts.getAccount(acctA))?.displayName).toBe("FirstDisplayName");
    // Refreshed login/avatar from the latest sign-in are visible under the canonical id.
    const status = await links.getStatus(acctB);
    expect(status.avatarUrl).toBe("https://example.test/avatar.png");
    expect(status.canonicalAccountId).toBe(acctA);
  });

  test("a re-sign-in for the SAME account (no merge) refreshes login/avatar without becoming a merge", async () => {
    await links.linkOrMerge(acctA, {
      githubUserId: 42,
      login: "old-login",
      avatarUrl: null,
    });
    const result = await links.linkOrMerge(acctA, {
      githubUserId: 42,
      login: "renamed-login",
      avatarUrl: "https://example.test/new.png",
    });
    expect(result).toEqual({
      canonicalAccountId: acctA,
      login: "renamed-login",
      avatarUrl: "https://example.test/new.png",
      merged: false,
      claimReplaced: false,
    });
  });

  test("linking an account already linked to a DIFFERENT GitHub id is refused, not silently repointed", async () => {
    await links.linkOrMerge(acctA, {
      githubUserId: 1,
      login: "first",
      avatarUrl: null,
    });
    await expect(
      links.linkOrMerge(acctA, { githubUserId: 2, login: "second", avatarUrl: null }),
    ).rejects.toThrow("github_identity_conflict");
  });

  test("merge folds a conflicting claim, canonical wins, and reports the replacement", async () => {
    await claims.setClaim(acctA, "canonical-lineage:v1");
    await links.linkOrMerge(acctA, { githubUserId: 7, login: "a", avatarUrl: null });
    await claims.setClaim(acctB, "source-lineage:v1");
    const result = await links.linkOrMerge(acctB, {
      githubUserId: 7,
      login: "a",
      avatarUrl: null,
    });
    expect(result.claimReplaced).toBe(true);
    expect((await claims.getClaim(acctA))?.lineageSlug).toBe("canonical-lineage");
  });

  test("survives a fresh instance over the same root — durable across a process restart", async () => {
    await links.linkOrMerge(acctA, {
      githubUserId: 99,
      login: "durable-login",
      avatarUrl: null,
    });
    const reopenedAccounts = await PlatformAccountStore.open(root);
    const reopenedClaims = await PlatformPolicyClaimStore.open(root);
    const reopened = await PlatformGithubIdentityLinkStore.open(
      root,
      reopenedAccounts,
      reopenedClaims,
    );
    expect(await reopened.getStatus(acctA)).toEqual({
      signedIn: true,
      login: "durable-login",
      avatarUrl: null,
      canonicalAccountId: acctA,
    });
  });
});
