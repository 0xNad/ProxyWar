import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveLineageSlug,
  PlatformPolicyClaimStore,
} from "../../../src/server/platform/PlatformPolicyClaimStore";

const acctA = `acct_${"a".repeat(32)}`;
const acctB = `acct_${"b".repeat(32)}`;

describe("deriveLineageSlug", () => {
  test("strips a trailing :v<N> version suffix", () => {
    expect(deriveLineageSlug("daveey-proxywar:v24")).toBe("daveey-proxywar");
    expect(deriveLineageSlug("daveey-proxywar:v1")).toBe("daveey-proxywar");
  });

  test("a label with no version suffix is its own lineage slug verbatim", () => {
    expect(deriveLineageSlug("hand-typed-name")).toBe("hand-typed-name");
  });
});

describe("PlatformPolicyClaimStore", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "platform-claims-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a never-claimed account reads back an empty set", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    expect(await store.getClaims(acctA)).toEqual([]);
  });

  test("claiming a versioned label derives and stores the lineage slug", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    const claims = await store.addClaim(acctA, "daveey-proxywar:v24");
    expect(claims).toMatchObject([
      { lineageSlug: "daveey-proxywar", label: "daveey-proxywar:v24" },
    ]);
  });

  test("claiming a later version of the SAME lineage still resolves to one entry", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.addClaim(acctA, "daveey-proxywar:v24");
    const updated = await store.addClaim(acctA, "daveey-proxywar:v25");
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      lineageSlug: "daveey-proxywar",
      label: "daveey-proxywar:v25",
    });
  });

  test("claimedAt is preserved across a re-pick of the SAME lineage, but a NEW lineage gets its OWN claimedAt", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    const [first] = await store.addClaim(acctA, "one-lineage:v1");
    const [second] = await store.addClaim(acctA, "one-lineage:v2");
    expect(second.claimedAt).toBe(first.claimedAt);
  });

  test("a NEW lineage never inherits an existing claim's claimedAt", async () => {
    // Seed one existing claim with an explicit, distinctive claimedAt —
    // real wall-clock timestamps from two calls in the same test can tie
    // at millisecond resolution, which would make an `expect(...).not.toBe`
    // assertion here flaky rather than a genuine behavior check.
    await fs.writeFile(
      path.join(root, "platform-policy-claims-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        claims: {
          [acctA]: {
            "one-lineage": {
              lineageSlug: "one-lineage",
              label: "one-lineage:v1",
              claimedAt: "2020-01-01T00:00:00.000Z",
              updatedAt: "2020-01-01T00:00:00.000Z",
            },
          },
        },
      }),
      "utf8",
    );
    const store = await PlatformPolicyClaimStore.open(root);
    const claims = await store.addClaim(acctA, "another-lineage:v3");
    const another = claims.find((c) => c.lineageSlug === "another-lineage")!;
    expect(another.claimedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("a blank label is rejected, not treated as 'clear everything'", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.addClaim(acctA, "daveey-proxywar:v24");
    await expect(store.addClaim(acctA, "   ")).rejects.toThrow("invalid_claim_label");
    // The existing claim survives the rejected call untouched.
    expect(await store.getClaims(acctA)).toHaveLength(1);
  });

  test("claiming a SECOND lineage keeps the first — an account claims a set, not a slot", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.addClaim(acctA, "daveey-proxywar:v24");
    const claims = await store.addClaim(acctA, "second-lineage:v7");
    expect(claims.map((c) => c.lineageSlug).sort()).toEqual([
      "daveey-proxywar",
      "second-lineage",
    ]);
  });

  test("removing one claimed lineage leaves every other one intact", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.addClaim(acctA, "daveey-proxywar:v24");
    await store.addClaim(acctA, "second-lineage:v7");
    const remaining = await store.removeClaim(acctA, "daveey-proxywar");
    expect(remaining.map((c) => c.lineageSlug)).toEqual(["second-lineage"]);
    expect(await store.getClaims(acctA)).toEqual(remaining);
  });

  test("removing a lineage that was never claimed is a no-op, not an error", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.addClaim(acctA, "daveey-proxywar:v24");
    const claims = await store.removeClaim(acctA, "never-claimed");
    expect(claims.map((c) => c.lineageSlug)).toEqual(["daveey-proxywar"]);
  });

  test("removing the only claimed lineage leaves the account with an empty set", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.addClaim(acctA, "daveey-proxywar:v24");
    expect(await store.removeClaim(acctA, "daveey-proxywar")).toEqual([]);
    expect(await store.getClaims(acctA)).toEqual([]);
  });

  test("getClaims orders oldest-claimed first, tie-broken by lineage slug on an exact tie", async () => {
    // Seed distinct claimedAt values directly — real wall-clock calls
    // within one test can tie at millisecond resolution, which would
    // make this assertion flaky if it relied on real timing.
    await fs.writeFile(
      path.join(root, "platform-policy-claims-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        claims: {
          [acctA]: {
            "zzz-lineage": {
              lineageSlug: "zzz-lineage",
              label: "zzz-lineage:v1",
              claimedAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
            },
            "aaa-lineage": {
              lineageSlug: "aaa-lineage",
              label: "aaa-lineage:v1",
              claimedAt: "2026-07-05T00:00:00.000Z",
              updatedAt: "2026-07-05T00:00:00.000Z",
            },
          },
        },
      }),
      "utf8",
    );
    const store = await PlatformPolicyClaimStore.open(root);
    const claims = await store.getClaims(acctA);
    expect(claims.map((c) => c.lineageSlug)).toEqual(["zzz-lineage", "aaa-lineage"]);
  });

  test("getClaims tie-breaks an EXACT claimedAt tie by lineage slug, alphabetically", async () => {
    await fs.writeFile(
      path.join(root, "platform-policy-claims-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        claims: {
          [acctA]: {
            "zzz-lineage": {
              lineageSlug: "zzz-lineage",
              label: "zzz-lineage:v1",
              claimedAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
            },
            "aaa-lineage": {
              lineageSlug: "aaa-lineage",
              label: "aaa-lineage:v1",
              claimedAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
            },
          },
        },
      }),
      "utf8",
    );
    const store = await PlatformPolicyClaimStore.open(root);
    const claims = await store.getClaims(acctA);
    expect(claims.map((c) => c.lineageSlug)).toEqual(["aaa-lineage", "zzz-lineage"]);
  });

  describe("merge (union — see PlatformPolicyClaimStore.mergeClaims doc)", () => {
    test("both accounts' distinct lineages survive the merge on the target", async () => {
      const store = await PlatformPolicyClaimStore.open(root);
      await store.addClaim(acctA, "source-lineage:v1");
      await store.addClaim(acctB, "target-lineage:v1");
      const { claims } = await store.mergeClaims(acctA, acctB);
      expect(claims.map((c) => c.lineageSlug).sort()).toEqual([
        "source-lineage",
        "target-lineage",
      ]);
      expect(await store.getClaims(acctA)).toEqual([]);
      expect((await store.getClaims(acctB)).map((c) => c.lineageSlug).sort()).toEqual([
        "source-lineage",
        "target-lineage",
      ]);
    });

    test("source's claims carry over when the target has none", async () => {
      const store = await PlatformPolicyClaimStore.open(root);
      await store.addClaim(acctA, "source-lineage:v1");
      const { claims } = await store.mergeClaims(acctA, acctB);
      expect(claims.map((c) => c.lineageSlug)).toEqual(["source-lineage"]);
    });

    test("the same lineage claimed on both sides collapses to ONE entry — the earlier claimedAt, the fresher label", async () => {
      // Seed both claims directly (current on-disk shape) with explicit,
      // deterministic timestamps rather than racing real wall-clock time:
      // acctB claimed EARLIER (older claimedAt) but with a STALER label
      // pick (older updatedAt); acctA claimed the same lineage LATER,
      // with a fresher label pick.
      await fs.writeFile(
        path.join(root, "platform-policy-claims-v1.json"),
        JSON.stringify({
          schemaVersion: 1,
          claims: {
            [acctB]: {
              "shared-lineage": {
                lineageSlug: "shared-lineage",
                label: "shared-lineage:v1",
                claimedAt: "2026-07-01T00:00:00.000Z",
                updatedAt: "2026-07-01T00:00:00.000Z",
              },
            },
            [acctA]: {
              "shared-lineage": {
                lineageSlug: "shared-lineage",
                label: "shared-lineage:v9",
                claimedAt: "2026-07-05T00:00:00.000Z",
                updatedAt: "2026-07-05T00:00:00.000Z",
              },
            },
          },
        }),
        "utf8",
      );
      const store = await PlatformPolicyClaimStore.open(root);
      const { claims } = await store.mergeClaims(acctA, acctB);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        lineageSlug: "shared-lineage",
        label: "shared-lineage:v9",
        claimedAt: "2026-07-01T00:00:00.000Z",
      });
    });

    test("merging an account with no claims into one that has some is a lossless no-op", async () => {
      const store = await PlatformPolicyClaimStore.open(root);
      await store.addClaim(acctB, "target-lineage:v1");
      const { claims } = await store.mergeClaims(acctA, acctB);
      expect(claims.map((c) => c.lineageSlug)).toEqual(["target-lineage"]);
    });

    test("merging an account into itself is a no-op that just reads back its current claims", async () => {
      const store = await PlatformPolicyClaimStore.open(root);
      await store.addClaim(acctA, "one-lineage:v1");
      const { claims } = await store.mergeClaims(acctA, acctA);
      expect(claims.map((c) => c.lineageSlug)).toEqual(["one-lineage"]);
    });
  });

  describe("migration from the pre-set single-claim shape", () => {
    /** The exact pre-2026-07-29 on-disk shape: one bare `StoredClaim` object per account, not a set keyed by lineage slug. */
    function legacyFileContents(): string {
      return JSON.stringify({
        schemaVersion: 1,
        claims: {
          [acctA]: {
            lineageSlug: "daveey-proxywar",
            label: "daveey-proxywar:v24",
            claimedAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        },
      });
    }

    test("an existing single-claim file is read back with nothing lost", async () => {
      await fs.writeFile(
        path.join(root, "platform-policy-claims-v1.json"),
        legacyFileContents(),
        "utf8",
      );
      const store = await PlatformPolicyClaimStore.open(root);
      const claims = await store.getClaims(acctA);
      expect(claims).toEqual([
        {
          lineageSlug: "daveey-proxywar",
          label: "daveey-proxywar:v24",
          claimedAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ]);
    });

    test("the migration is persisted back to disk in the new shape — a fresh instance never re-migrates", async () => {
      const filePath = path.join(root, "platform-policy-claims-v1.json");
      await fs.writeFile(filePath, legacyFileContents(), "utf8");
      await PlatformPolicyClaimStore.open(root);
      const onDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as {
        claims: Record<string, unknown>;
      };
      // New shape: a set keyed by lineage slug, not a bare claim object.
      expect(onDisk.claims[acctA]).toEqual({
        "daveey-proxywar": {
          lineageSlug: "daveey-proxywar",
          label: "daveey-proxywar:v24",
          claimedAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      });
    });

    test("a migrated single claim can still gain a second lineage afterward", async () => {
      await fs.writeFile(
        path.join(root, "platform-policy-claims-v1.json"),
        legacyFileContents(),
        "utf8",
      );
      const store = await PlatformPolicyClaimStore.open(root);
      const claims = await store.addClaim(acctA, "second-lineage:v1");
      expect(claims.map((c) => c.lineageSlug).sort()).toEqual([
        "daveey-proxywar",
        "second-lineage",
      ]);
    });

    test("a file already in the current set shape is left alone (no spurious migration)", async () => {
      const filePath = path.join(root, "platform-policy-claims-v1.json");
      const current = {
        schemaVersion: 1,
        claims: {
          [acctA]: {
            "daveey-proxywar": {
              lineageSlug: "daveey-proxywar",
              label: "daveey-proxywar:v24",
              claimedAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
            },
          },
        },
      };
      await fs.writeFile(filePath, JSON.stringify(current), "utf8");
      const beforeMtime = (await fs.stat(filePath)).mtimeMs;
      await PlatformPolicyClaimStore.open(root);
      const afterMtime = (await fs.stat(filePath)).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    });
  });

  test("survives a fresh instance over the same root — durable across a process restart", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.addClaim(acctA, "daveey-proxywar:v24");
    await store.addClaim(acctA, "second-lineage:v1");
    const reopened = await PlatformPolicyClaimStore.open(root);
    expect(
      (await reopened.getClaims(acctA)).map((c) => c.lineageSlug).sort(),
    ).toEqual(["daveey-proxywar", "second-lineage"]);
  });
});
