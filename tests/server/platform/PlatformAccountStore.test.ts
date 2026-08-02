import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlatformAccountStore } from "../../../src/server/platform/PlatformAccountStore";

const acctA = `acct_${"a".repeat(32)}`;
const acctB = `acct_${"b".repeat(32)}`;

describe("PlatformAccountStore", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "platform-accounts-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a never-touched account reads back null, not an error", async () => {
    const store = await PlatformAccountStore.open(root);
    expect(await store.getAccount(acctA)).toBeNull();
  });

  test("sets, sanitizes, and reads back a display name; survives a fresh instance over the same root", async () => {
    const store = await PlatformAccountStore.open(root);
    const entry = await store.setDisplayName(acctA, "  Da\u0000veey\u200b   the\tGreat  ");
    expect(entry.displayName).toBe("Daveey the Great");
    expect(entry.accountId).toBe(acctA);

    const long = await store.setDisplayName(acctA, "x".repeat(100));
    expect(long.displayName).toHaveLength(32);

    const cleared = await store.setDisplayName(acctA, "   \u0000  ");
    expect(cleared.displayName).toBeNull();

    await store.setDisplayName(acctA, "Daveey");
    const reopened = await PlatformAccountStore.open(root);
    expect((await reopened.getAccount(acctA))?.displayName).toBe("Daveey");
  });

  test("merges: the canonical (target) side's display name wins when both sides have one", async () => {
    const store = await PlatformAccountStore.open(root);
    await store.setDisplayName(acctA, "SourceName");
    await store.setDisplayName(acctB, "TargetName");
    const merged = await store.mergeAccount(acctA, acctB);
    expect(merged?.displayName).toBe("TargetName");
    expect(await store.getAccount(acctA)).toBeNull();
  });

  test("merges: the source's display name carries over when the target has none", async () => {
    const store = await PlatformAccountStore.open(root);
    await store.setDisplayName(acctA, "SourceName");
    const merged = await store.mergeAccount(acctA, acctB);
    expect(merged?.displayName).toBe("SourceName");
  });

  test("merging two accounts with neither side ever touched is a safe no-op", async () => {
    const store = await PlatformAccountStore.open(root);
    expect(await store.mergeAccount(acctA, acctB)).toBeNull();
  });

  test("rejects a malformed account id", async () => {
    const store = await PlatformAccountStore.open(root);
    await expect(store.getAccount("not-an-account-id")).rejects.toThrow();
  });
});
