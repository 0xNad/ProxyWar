import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPendingRelease,
  findReleasesByAccount,
  findReleasesByAgent,
  markObserved,
  mutateVersionReleaseStore,
  newVersionReleaseId,
  readVersionReleaseStore,
  VersionReleaseNotFoundError,
  VersionReleaseValidationError,
  type VersionReleaseStoreFile,
  type VersionReleaseSubmission,
} from "../../../src/server/platform/PlatformVersionReleaseStore";

const NOW = new Date("2026-08-01T00:00:00.000Z");

function baseSubmission(
  overrides: Partial<VersionReleaseSubmission> = {},
): VersionReleaseSubmission {
  return {
    accountId: "acct_00000000000000000000000000000001",
    agentId: "agt_daveey",
    versionLabel: "v25",
    releaseNotes: "Fixed a diplomacy bug",
    baseModel: "gpt-4.1",
    scaffoldDescription: "custom scaffold",
    sourceDisclosure: "https://github.com/example/repo",
    intendedChanges: "better alliance handling",
    ...overrides,
  };
}

describe("PlatformVersionReleaseStore", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(
      path.join(os.tmpdir(), "version-release-store-"),
    );
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("cold-starts to an empty, schema-valid store", async () => {
    const file = await readVersionReleaseStore(stateRoot);
    expect(file).toEqual({ schemaVersion: 1, releases: [] });
  });

  it("newVersionReleaseId mints the rel_<24hex> shape", () => {
    expect(newVersionReleaseId()).toMatch(/^rel_[a-f0-9]{24}$/);
  });

  it("createPendingRelease creates a pending record with sanitized fields", () => {
    let file: VersionReleaseStoreFile = { schemaVersion: 1, releases: [] };
    file = createPendingRelease(
      file,
      baseSubmission({ versionLabel: "  v25   released  " }),
      NOW,
    );
    expect(file.releases).toHaveLength(1);
    const [record] = file.releases;
    expect(record.id).toMatch(/^rel_[a-f0-9]{24}$/);
    expect(record.status).toBe("pending");
    expect(record.versionLabel).toBe("v25 released");
    expect(record.observedVersionId).toBeNull();
    expect(record.observedAt).toBeNull();
    expect(record.createdAt).toBe(NOW.toISOString());
  });

  it("createPendingRelease rejects a blank versionLabel", () => {
    const file: VersionReleaseStoreFile = { schemaVersion: 1, releases: [] };
    expect(() =>
      createPendingRelease(file, baseSubmission({ versionLabel: "   " }), NOW),
    ).toThrow(VersionReleaseValidationError);
  });

  it("createPendingRelease preserves explicit nulls for optional free-text fields", () => {
    let file: VersionReleaseStoreFile = { schemaVersion: 1, releases: [] };
    file = createPendingRelease(
      file,
      baseSubmission({
        releaseNotes: null,
        baseModel: null,
        scaffoldDescription: null,
        sourceDisclosure: null,
        intendedChanges: null,
      }),
      NOW,
    );
    expect(file.releases[0]).toMatchObject({
      releaseNotes: null,
      baseModel: null,
      scaffoldDescription: null,
      sourceDisclosure: null,
      intendedChanges: null,
    });
  });

  it("markObserved flips a release to observed and stamps the version/timestamp", () => {
    let file: VersionReleaseStoreFile = { schemaVersion: 1, releases: [] };
    file = createPendingRelease(file, baseSubmission(), NOW);
    const releaseId = file.releases[0].id;
    file = markObserved(
      file,
      releaseId,
      "agtv_daveey_v26",
      "2026-08-03T00:00:00.000Z",
    );
    expect(file.releases[0]).toMatchObject({
      status: "observed",
      observedVersionId: "agtv_daveey_v26",
      observedAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it("markObserved throws VersionReleaseNotFoundError for an unknown id", () => {
    const file: VersionReleaseStoreFile = { schemaVersion: 1, releases: [] };
    expect(() =>
      markObserved(file, "rel_does_not_exist", "agtv_x_v1", NOW.toISOString()),
    ).toThrow(VersionReleaseNotFoundError);
  });

  it("findReleasesByAccount/findReleasesByAgent filter correctly", () => {
    let file: VersionReleaseStoreFile = { schemaVersion: 1, releases: [] };
    file = createPendingRelease(
      file,
      baseSubmission({ accountId: "acct_00000000000000000000000000000001" }),
      NOW,
    );
    file = createPendingRelease(
      file,
      baseSubmission({
        accountId: "acct_00000000000000000000000000000002",
        agentId: "agt_other",
      }),
      NOW,
    );
    expect(
      findReleasesByAccount(file, "acct_00000000000000000000000000000001"),
    ).toHaveLength(1);
    expect(findReleasesByAgent(file, "agt_other")).toHaveLength(1);
    expect(findReleasesByAgent(file, "agt_daveey")).toHaveLength(1);
  });

  it("round-trips through the file store atomically via mutateVersionReleaseStore", async () => {
    const written = await mutateVersionReleaseStore(stateRoot, (file) =>
      createPendingRelease(file, baseSubmission(), NOW),
    );
    expect(written.releases).toHaveLength(1);
    const reread = await readVersionReleaseStore(stateRoot);
    expect(reread).toEqual(written);
  });
});
