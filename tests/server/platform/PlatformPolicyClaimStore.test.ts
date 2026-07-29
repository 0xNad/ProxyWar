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

  test("a never-claimed account reads back null", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    expect(await store.getClaim(acctA)).toBeNull();
  });

  test("claiming a versioned label derives and stores the lineage slug", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    const claim = await store.setClaim(acctA, "daveey-proxywar:v24");
    expect(claim).toMatchObject({
      lineageSlug: "daveey-proxywar",
      label: "daveey-proxywar:v24",
    });
  });

  test("claiming a later version of the SAME lineage still resolves to one lineage slug", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.setClaim(acctA, "daveey-proxywar:v24");
    const updated = await store.setClaim(acctA, "daveey-proxywar:v25");
    expect(updated?.lineageSlug).toBe("daveey-proxywar");
    expect(updated?.label).toBe("daveey-proxywar:v25");
  });

  test("claimedAt is preserved across a re-pick, even a different lineage", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    const first = await store.setClaim(acctA, "one-lineage:v1");
    const second = await store.setClaim(acctA, "another-lineage:v3");
    expect(second?.claimedAt).toBe(first?.claimedAt);
    expect(second?.lineageSlug).toBe("another-lineage");
  });

  test("a blank label clears the claim", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.setClaim(acctA, "daveey-proxywar:v24");
    const cleared = await store.setClaim(acctA, "   ");
    expect(cleared).toBeNull();
    expect(await store.getClaim(acctA)).toBeNull();
  });

  test("merge: target's claim wins on a lineage conflict, and reports the replacement", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.setClaim(acctA, "source-lineage:v1");
    await store.setClaim(acctB, "target-lineage:v1");
    const { claim, sourceClaimReplaced } = await store.mergeClaim(acctA, acctB);
    expect(claim?.lineageSlug).toBe("target-lineage");
    expect(sourceClaimReplaced).toBe(true);
    expect(await store.getClaim(acctA)).toBeNull();
  });

  test("merge: source's claim carries over when the target has none", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.setClaim(acctA, "source-lineage:v1");
    const { claim, sourceClaimReplaced } = await store.mergeClaim(acctA, acctB);
    expect(claim?.lineageSlug).toBe("source-lineage");
    expect(sourceClaimReplaced).toBe(false);
  });

  test("merge: same lineage on both sides is a no-op, never reported as a replacement", async () => {
    const store = await PlatformPolicyClaimStore.open(root);
    await store.setClaim(acctA, "shared-lineage:v1");
    await store.setClaim(acctB, "shared-lineage:v9");
    const { sourceClaimReplaced } = await store.mergeClaim(acctA, acctB);
    expect(sourceClaimReplaced).toBe(false);
  });
});
