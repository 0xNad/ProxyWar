import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { leagueClaimMergerFor, ReplayPremiereLeagueClaimStore } from "../../../../src/server/replay-premiere/account/ReplayPremiereLeagueClaimStore";
import {
  pointsMergerFor,
  ReplayPremiereIdentityLinkStore,
  type ReplayPremiereLeagueClaimMerger,
  type ReplayPremierePointsMerger,
} from "../../../../src/server/replay-premiere/points/ReplayPremiereIdentityLinkStore";
import { ReplayPremierePointsLedger } from "../../../../src/server/replay-premiere/points/ReplayPremierePointsLedger";

const guestA = `guest_${"a".repeat(32)}`;
const guestB = `guest_${"b".repeat(32)}`;
const guestC = `guest_${"c".repeat(32)}`;

function recordingMerger(): ReplayPremierePointsMerger & {
  calls: Array<{ from: string; into: string }>;
} {
  const calls: Array<{ from: string; into: string }> = [];
  return {
    calls,
    async mergeParticipant(from: string, into: string) {
      calls.push({ from, into });
    },
  };
}

/** A league-claim merger that never has anything to reconcile — for tests exercising the GitHub-link/merge machinery itself, not claim reconciliation. */
function noopLeagueClaimMerger(): ReplayPremiereLeagueClaimMerger {
  return {
    async mergeClaim() {
      return { claim: null, sourceClaimReplaced: false };
    },
  };
}

describe("ReplayPremiereIdentityLinkStore", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "identity-link-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("first sign-in for a GitHub id makes the linking guest canonical", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    const result = await store.linkOrMerge(guestA, {
      githubUserId: 12345,
      login: "daveey",
      avatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    expect(result).toEqual({
      canonicalParticipantId: guestA,
      login: "daveey",
      avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      merged: false,
      leagueClaimReplaced: false,
    });
    expect(merger.calls).toHaveLength(0);
    const status = await store.getStatus(guestA);
    expect(status).toEqual({
      signedIn: true,
      login: "daveey",
      avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      canonicalParticipantId: guestA,
    });
  });

  test("a different guest linking the same GitHub id merges into the existing canonical, and an old cookie resolves through the alias", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    await store.linkOrMerge(guestA, {
      githubUserId: 999,
      login: "daveey",
      avatarUrl: null,
    });
    const merge = await store.linkOrMerge(guestB, {
      githubUserId: 999,
      login: "daveey",
      avatarUrl: null,
    });
    expect(merge).toEqual({
      canonicalParticipantId: guestA,
      login: "daveey",
      avatarUrl: null,
      merged: true,
      leagueClaimReplaced: false,
    });
    expect(merger.calls).toEqual([{ from: guestB, into: guestA }]);
    // guestB's old cookie still resolves to the canonical account.
    expect(await store.resolveCanonicalParticipantId(guestB)).toBe(guestA);
    const statusFromOldCookie = await store.getStatus(guestB);
    expect(statusFromOldCookie).toEqual({
      signedIn: true,
      login: "daveey",
      avatarUrl: null,
      canonicalParticipantId: guestA,
    });
  });

  test("merges the real points ledger correctly end to end through pointsMergerFor", async () => {
    const ledgerRoot = await fs.mkdtemp(path.join(root, "ledger-"));
    const ledger = await ReplayPremierePointsLedger.open(ledgerRoot);
    await ledger.recordPremiereSettlement("prem_aaaaaaaaaaaaaaaa", [
      { participantId: guestA, granted: 1_000, balance: 1_200 },
    ]);
    await ledger.recordPremiereSettlement("prem_bbbbbbbbbbbbbbbb", [
      { participantId: guestB, granted: 1_000, balance: 700 },
    ]);
    const store = await ReplayPremiereIdentityLinkStore.open(
      root,
      pointsMergerFor(ledger),
      noopLeagueClaimMerger(),
    );
    await store.linkOrMerge(guestA, {
      githubUserId: 1,
      login: "a",
      avatarUrl: null,
    });
    await store.linkOrMerge(guestB, {
      githubUserId: 1,
      login: "a",
      avatarUrl: null,
    });
    const board = await ledger.readLeaderboard({ viewerParticipantId: guestA });
    expect(board.viewer?.lifetimePoints).toBe(-100); // +200 - 300
    expect(board.entries.some((entry) => entry.participantId === guestB)).toBe(
      false,
    );
  });

  test("renamed handle: login/avatar refresh on every sign-in, even a no-op re-link", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    await store.linkOrMerge(guestA, {
      githubUserId: 42,
      login: "old-handle",
      avatarUrl: "https://example.test/old.png",
    });
    const relinked = await store.linkOrMerge(guestA, {
      githubUserId: 42,
      login: "new-handle",
      avatarUrl: "https://example.test/new.png",
    });
    expect(relinked).toEqual({
      canonicalParticipantId: guestA,
      login: "new-handle",
      avatarUrl: "https://example.test/new.png",
      merged: false,
      leagueClaimReplaced: false,
    });
    const status = await store.getStatus(guestA);
    expect(status.login).toBe("new-handle");
    expect(status.avatarUrl).toBe("https://example.test/new.png");
  });

  test("two simultaneous callbacks for the same GitHub id (different guests) produce exactly one canonical identity and never double-merge", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    const [first, second] = await Promise.all([
      store.linkOrMerge(guestA, {
        githubUserId: 7,
        login: "x",
        avatarUrl: null,
      }),
      store.linkOrMerge(guestB, {
        githubUserId: 7,
        login: "x",
        avatarUrl: null,
      }),
    ]);
    // Exactly one of the two is treated as the original link (merged:
    // false) and the other as the merge (merged: true) — the write queue
    // strictly orders concurrent callers even though they were issued
    // concurrently.
    const outcomes = [first, second];
    const merges = outcomes.filter((o) => o.merged);
    const originals = outcomes.filter((o) => !o.merged);
    expect(merges).toHaveLength(1);
    expect(originals).toHaveLength(1);
    expect(first.canonicalParticipantId).toBe(second.canonicalParticipantId);
    // Exactly one merge call was made into the ledger — never two, never
    // a self-merge.
    expect(merger.calls).toHaveLength(1);
    expect(merger.calls[0].into).toBe(first.canonicalParticipantId);
    expect(merger.calls[0].from).not.toBe(first.canonicalParticipantId);

    const statusA = await store.getStatus(guestA);
    const statusB = await store.getStatus(guestB);
    expect(statusA.canonicalParticipantId).toBe(first.canonicalParticipantId);
    expect(statusB.canonicalParticipantId).toBe(first.canonicalParticipantId);
  });

  test("a three-way merge chain collapses aliases to a single hop", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    // guestB links first under githubId 1 (guestA hasn't signed in yet).
    await store.linkOrMerge(guestB, {
      githubUserId: 1,
      login: "b",
      avatarUrl: null,
    });
    // guestA later signs in with a DIFFERENT GitHub id first, establishing
    // itself as canonical for githubId 2 — unrelated to githubId 1.
    await store.linkOrMerge(guestA, {
      githubUserId: 2,
      login: "a",
      avatarUrl: null,
    });
    // Now guestC signs in with githubId 1 — merges into guestB (githubId
    // 1's existing canonical).
    await store.linkOrMerge(guestC, {
      githubUserId: 1,
      login: "b",
      avatarUrl: null,
    });
    expect(await store.resolveCanonicalParticipantId(guestC)).toBe(guestB);
    expect(await store.resolveCanonicalParticipantId(guestB)).toBe(guestB);
  });

  test("unknown participant is reported as not signed in and resolves to itself", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    const status = await store.getStatus(guestA);
    expect(status).toEqual({
      signedIn: false,
      login: null,
      avatarUrl: null,
      canonicalParticipantId: guestA,
    });
    expect(await store.resolveCanonicalParticipantId(guestA)).toBe(guestA);
  });

  test("describeMany decorates only linked participants, in one bulk read", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    await store.linkOrMerge(guestA, {
      githubUserId: 5,
      login: "daveey",
      avatarUrl: "https://example.test/a.png",
    });
    const described = await store.describeMany([guestA, guestB]);
    expect(described.get(guestA)).toEqual({
      login: "daveey",
      avatarUrl: "https://example.test/a.png",
    });
    expect(described.has(guestB)).toBe(false);
  });

  test("survives a fresh store instance pointed at the same root — durable across a process restart", async () => {
    const merger = recordingMerger();
    const first = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    await first.linkOrMerge(guestA, {
      githubUserId: 99,
      login: "daveey",
      avatarUrl: null,
    });
    const second = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    const status = await second.getStatus(guestA);
    expect(status.signedIn).toBe(true);
    expect(status.login).toBe("daveey");
  });
});

describe("ReplayPremiereIdentityLinkStore league-claim reconciliation on merge", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "identity-link-claims-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function harness(): Promise<{
    store: ReplayPremiereIdentityLinkStore;
    claims: ReplayPremiereLeagueClaimStore;
  }> {
    const claims = await ReplayPremiereLeagueClaimStore.open(
      path.join(root, "claims"),
    );
    const store = await ReplayPremiereIdentityLinkStore.open(
      path.join(root, "identity-links"),
      recordingMerger(),
      leagueClaimMergerFor(claims),
    );
    return { store, claims };
  }

  test("a guest claims a league agent, then links GitHub — the claim survives on the canonical identity", async () => {
    const { store, claims } = await harness();
    await claims.setClaim(guestA, "daveey");
    const result = await store.linkOrMerge(guestA, {
      githubUserId: 1,
      login: "octo",
      avatarUrl: null,
    });
    expect(result.merged).toBe(false); // first-ever link, no merge
    expect(result.leagueClaimReplaced).toBe(false);
    const claim = await claims.getClaim(result.canonicalParticipantId);
    expect(claim?.playerName).toBe("daveey");
  });

  test("two guests both claim different players and merge — the canonical target's claim wins, deterministically, and the replacement is reported", async () => {
    const { store, claims } = await harness();
    // guestA links first, becoming canonical for this GitHub id, having
    // already claimed "daveey".
    await claims.setClaim(guestA, "daveey");
    await store.linkOrMerge(guestA, {
      githubUserId: 1,
      login: "octo",
      avatarUrl: null,
    });
    // guestB — a different browser/session — separately claimed a
    // different player, then signs in with the SAME GitHub account,
    // merging into guestA's canonical identity.
    await claims.setClaim(guestB, "relh");
    const merge = await store.linkOrMerge(guestB, {
      githubUserId: 1,
      login: "octo",
      avatarUrl: null,
    });
    expect(merge.merged).toBe(true);
    expect(merge.leagueClaimReplaced).toBe(true);
    const claim = await claims.getClaim(merge.canonicalParticipantId);
    expect(claim?.playerName).toBe("daveey"); // canonical target's claim wins
    // The merged-away source id no longer independently carries a claim.
    expect(await claims.getClaim(guestB)).toBeNull();
  });

  test("only the source guest claims a player — the claim carries over to the canonical target", async () => {
    const { store, claims } = await harness();
    await store.linkOrMerge(guestA, {
      githubUserId: 1,
      login: "octo",
      avatarUrl: null,
    });
    // guestB claims a player only AFTER guestA is already canonical, then
    // signs in and merges into guestA.
    await claims.setClaim(guestB, "relh");
    const merge = await store.linkOrMerge(guestB, {
      githubUserId: 1,
      login: "octo",
      avatarUrl: null,
    });
    expect(merge.merged).toBe(true);
    expect(merge.leagueClaimReplaced).toBe(false);
    const claim = await claims.getClaim(merge.canonicalParticipantId);
    expect(claim?.playerName).toBe("relh");
  });

  test("both sides claim the SAME player — a no-op merge, not reported as a replacement", async () => {
    const { store, claims } = await harness();
    await claims.setClaim(guestA, "daveey");
    await store.linkOrMerge(guestA, {
      githubUserId: 1,
      login: "octo",
      avatarUrl: null,
    });
    await claims.setClaim(guestB, "daveey");
    const merge = await store.linkOrMerge(guestB, {
      githubUserId: 1,
      login: "octo",
      avatarUrl: null,
    });
    expect(merge.leagueClaimReplaced).toBe(false);
    const claim = await claims.getClaim(merge.canonicalParticipantId);
    expect(claim?.playerName).toBe("daveey");
  });
});

describe("ReplayPremiereIdentityLinkStore corruption handling", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(
      path.join(realTemporaryRoot, "identity-link-corrupt-"),
    );
  });

  test("refuses to start empty over a readable-but-invalid store, rather than silently forgetting every link", async () => {
    const merger = recordingMerger();
    const first = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    await first.linkOrMerge(guestA, {
      githubUserId: 4242,
      login: "daveey",
      avatarUrl: null,
    });

    // Valid JSON, wrong shape — a truncated write, a hand-edit, a schema
    // change. Falling through to an empty store would let the next sign-in
    // save over it and destroy every account link on the box.
    const files = await fs.readdir(root);
    const storeFile = files.find((name) => name.includes("identity"));
    expect(storeFile).toBeDefined();
    const storePath = path.join(root, storeFile!);
    await fs.writeFile(storePath, JSON.stringify({ unexpected: "shape" }));

    const second = await ReplayPremiereIdentityLinkStore.open(
      root,
      merger,
      noopLeagueClaimMerger(),
    );
    await expect(second.getStatus(guestA)).rejects.toThrow(/unreadable/);

    // And the original bytes are still on disk, recoverable by a human.
    const after = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(after).toEqual({ unexpected: "shape" });
  });
});
