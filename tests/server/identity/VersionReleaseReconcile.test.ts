import { describe, expect, it } from "vitest";
import {
  MIN_MATCHES_FOR_VERSION_COMPARISON,
  isVersionComparisonReady,
  reconcilePendingReleases,
} from "../../../src/server/identity/VersionReleaseReconcile";
import type { AgentVersion } from "../../../src/server/identity/IdentitySchemas";
import type { PendingVersionRelease } from "../../../src/server/platform/PlatformVersionReleaseStore";

function release(
  overrides: Partial<PendingVersionRelease> = {},
): PendingVersionRelease {
  return {
    id: "rel_000000000000000000000001",
    accountId: "acct_00000000000000000000000000000001",
    agentId: "agt_daveey",
    versionLabel: "v25",
    releaseNotes: null,
    baseModel: null,
    scaffoldDescription: null,
    sourceDisclosure: null,
    intendedChanges: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "pending",
    observedVersionId: null,
    observedAt: null,
    ...overrides,
  };
}

function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: "agtv_daveey_v25",
    agentId: "agt_daveey",
    publicVersionLabel: "v25",
    softmaxPolicyLabel: "daveey-proxywar:v25",
    immutableDigest: null,
    releaseDate: null,
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["rating"],
    observedAt: "2026-08-02T00:00:00.000Z",
    firstObservedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("VersionReleaseReconcile", () => {
  describe("reconcilePendingReleases", () => {
    it("leaves a pending release unchanged when no observed version matches", () => {
      const pending = [release()];
      const result = reconcilePendingReleases(pending, [
        version({ agentId: "agt_someone-else", id: "agtv_someone-else_v1" }),
      ]);
      expect(result.changed).toBe(false);
      expect(result.updated).toEqual(pending);
    });

    it("marks observed when exactly one qualifying observed version exists", () => {
      const pending = [release()];
      const observed = version({
        id: "agtv_daveey_v26",
        firstObservedAt: "2026-08-03T00:00:00.000Z",
      });
      const result = reconcilePendingReleases(pending, [observed]);
      expect(result.changed).toBe(true);
      expect(result.updated).toHaveLength(1);
      expect(result.updated[0]).toMatchObject({
        status: "observed",
        observedVersionId: "agtv_daveey_v26",
        observedAt: "2026-08-03T00:00:00.000Z",
      });
    });

    it("never matches a version first observed before the release was filed", () => {
      const pending = [
        release({ createdAt: "2026-08-05T00:00:00.000Z" }),
      ];
      const observed = version({
        id: "agtv_daveey_v24",
        firstObservedAt: "2026-08-01T00:00:00.000Z",
      });
      const result = reconcilePendingReleases(pending, [observed]);
      expect(result.changed).toBe(false);
      expect(result.updated[0].status).toBe("pending");
      expect(result.updated[0].observedVersionId).toBeNull();
    });

    it("matches a version first observed at exactly the release's createdAt (inclusive lower bound)", () => {
      const pending = [release({ createdAt: "2026-08-05T00:00:00.000Z" })];
      const observed = version({
        id: "agtv_daveey_v24",
        firstObservedAt: "2026-08-05T00:00:00.000Z",
      });
      const result = reconcilePendingReleases(pending, [observed]);
      expect(result.changed).toBe(true);
      expect(result.updated[0].observedVersionId).toBe("agtv_daveey_v24");
    });

    it("picks the earliest qualifying observed version when several exist", () => {
      const pending = [release()];
      const later = version({
        id: "agtv_daveey_v27",
        firstObservedAt: "2026-08-10T00:00:00.000Z",
      });
      const earlier = version({
        id: "agtv_daveey_v26",
        firstObservedAt: "2026-08-03T00:00:00.000Z",
      });
      const result = reconcilePendingReleases(pending, [later, earlier]);
      expect(result.updated[0].observedVersionId).toBe("agtv_daveey_v26");
    });

    it("never double-links two pending releases for the same agent to the same observed version", () => {
      const firstRelease = release({
        id: "rel_000000000000000000000001",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      const secondRelease = release({
        id: "rel_000000000000000000000002",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      const observed = version({
        id: "agtv_daveey_v26",
        firstObservedAt: "2026-08-03T00:00:00.000Z",
      });
      const result = reconcilePendingReleases(
        [firstRelease, secondRelease],
        [observed],
      );
      expect(result.changed).toBe(true);
      const linked = result.updated.filter(
        (r) => r.observedVersionId === "agtv_daveey_v26",
      );
      expect(linked).toHaveLength(1);
      const stillPending = result.updated.filter((r) => r.status === "pending");
      expect(stillPending).toHaveLength(1);
    });

    it("skips a version already claimed by an existing (non-pending) release", () => {
      const alreadyObserved = release({
        id: "rel_000000000000000000000001",
        status: "observed",
        observedVersionId: "agtv_daveey_v26",
        observedAt: "2026-08-03T00:00:00.000Z",
      });
      const stillPending = release({
        id: "rel_000000000000000000000002",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      const observed = version({
        id: "agtv_daveey_v26",
        firstObservedAt: "2026-08-03T00:00:00.000Z",
      });
      const result = reconcilePendingReleases(
        [alreadyObserved, stillPending],
        [observed],
      );
      expect(result.changed).toBe(false);
      expect(
        result.updated.find((r) => r.id === "rel_000000000000000000000002")
          ?.status,
      ).toBe("pending");
    });

    it("never matches an observed version for a different agent", () => {
      const pending = [release({ agentId: "agt_daveey" })];
      const otherAgentVersion = version({
        id: "agtv_other-agent_v1",
        agentId: "agt_other-agent",
        firstObservedAt: "2026-08-05T00:00:00.000Z",
      });
      const result = reconcilePendingReleases(pending, [otherAgentVersion]);
      expect(result.changed).toBe(false);
    });
  });

  describe("isVersionComparisonReady", () => {
    it("is not ready one match below the threshold", () => {
      expect(
        isVersionComparisonReady(MIN_MATCHES_FOR_VERSION_COMPARISON - 1),
      ).toBe(false);
    });

    it("is ready exactly at the threshold", () => {
      expect(isVersionComparisonReady(MIN_MATCHES_FOR_VERSION_COMPARISON)).toBe(
        true,
      );
    });

    it("is ready above the threshold", () => {
      expect(
        isVersionComparisonReady(MIN_MATCHES_FOR_VERSION_COMPARISON + 1),
      ).toBe(true);
    });
  });
});
