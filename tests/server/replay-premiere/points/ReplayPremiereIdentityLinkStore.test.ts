import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pointsMergerFor,
  ReplayPremiereIdentityLinkStore,
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
    const store = await ReplayPremiereIdentityLinkStore.open(root, merger);
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
    const store = await ReplayPremiereIdentityLinkStore.open(root, merger);
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
    );
    await store.linkOrMerge(guestA, { githubUserId: 1, login: "a", avatarUrl: null });
    await store.linkOrMerge(guestB, { githubUserId: 1, login: "a", avatarUrl: null });
    const board = await ledger.readLeaderboard({ viewerParticipantId: guestA });
    expect(board.viewer?.lifetimePoints).toBe(-100); // +200 - 300
    expect(board.entries.some((entry) => entry.participantId === guestB)).toBe(false);
  });

  test("renamed handle: login/avatar refresh on every sign-in, even a no-op re-link", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(root, merger);
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
    });
    const status = await store.getStatus(guestA);
    expect(status.login).toBe("new-handle");
    expect(status.avatarUrl).toBe("https://example.test/new.png");
  });

  test("two simultaneous callbacks for the same GitHub id (different guests) produce exactly one canonical identity and never double-merge", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(root, merger);
    const [first, second] = await Promise.all([
      store.linkOrMerge(guestA, { githubUserId: 7, login: "x", avatarUrl: null }),
      store.linkOrMerge(guestB, { githubUserId: 7, login: "x", avatarUrl: null }),
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
    const store = await ReplayPremiereIdentityLinkStore.open(root, merger);
    // guestB links first under githubId 1 (guestA hasn't signed in yet).
    await store.linkOrMerge(guestB, { githubUserId: 1, login: "b", avatarUrl: null });
    // guestA later signs in with a DIFFERENT GitHub id first, establishing
    // itself as canonical for githubId 2 — unrelated to githubId 1.
    await store.linkOrMerge(guestA, { githubUserId: 2, login: "a", avatarUrl: null });
    // Now guestC signs in with githubId 1 — merges into guestB (githubId
    // 1's existing canonical).
    await store.linkOrMerge(guestC, { githubUserId: 1, login: "b", avatarUrl: null });
    expect(await store.resolveCanonicalParticipantId(guestC)).toBe(guestB);
    expect(await store.resolveCanonicalParticipantId(guestB)).toBe(guestB);
  });

  test("unknown participant is reported as not signed in and resolves to itself", async () => {
    const merger = recordingMerger();
    const store = await ReplayPremiereIdentityLinkStore.open(root, merger);
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
    const store = await ReplayPremiereIdentityLinkStore.open(root, merger);
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
    const first = await ReplayPremiereIdentityLinkStore.open(root, merger);
    await first.linkOrMerge(guestA, {
      githubUserId: 99,
      login: "daveey",
      avatarUrl: null,
    });
    const second = await ReplayPremiereIdentityLinkStore.open(root, merger);
    const status = await second.getStatus(guestA);
    expect(status.signedIn).toBe(true);
    expect(status.login).toBe("daveey");
  });
});
