import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BuilderEditNotFoundError,
  BuilderEditNotPendingError,
  BuilderEditValidationError,
  EDITABLE_FIELDS_BY_TARGET_KIND,
  findEditById,
  findEditsByAccount,
  mutateBuilderEditStore,
  publishEdit,
  readBuilderEditStore,
  rejectEdit,
  submitEdit,
  type BuilderEditStoreFile,
  type BuilderProfileEditSubmission,
} from "../../../src/server/platform/PlatformBuilderEditStore";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const ACCOUNT_ID = "acct_00000000000000000000000000000001";

function baseSubmission(
  overrides: Partial<BuilderProfileEditSubmission> = {},
): BuilderProfileEditSubmission {
  return {
    accountId: ACCOUNT_ID,
    targetKind: "builder",
    targetId: "bld_ada",
    field: "displayName",
    previousValue: "Old Name",
    proposedValue: "Ada the Builder",
    ...overrides,
  };
}

describe("PlatformBuilderEditStore", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "builder-edit-store-"));
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("cold-starts to an empty, schema-valid store", async () => {
    const file = await readBuilderEditStore(stateRoot);
    expect(file).toEqual({ schemaVersion: 1, edits: [] });
  });

  it("declares the exact contract-specified editable fields per target kind", () => {
    expect(EDITABLE_FIELDS_BY_TARGET_KIND).toEqual({
      builder: ["displayName", "shortBio", "links", "teamMembers"],
      agent: ["tagline", "publicStrategyDescription"],
      version: [
        "releaseNotes",
        "declaredBaseModel",
        "scaffoldDescription",
        "sourceRepositoryRef",
        "disclosureStatus",
      ],
    });
  });

  it("submitEdit creates a pending record with the submitted values", () => {
    const file = submitEdit(
      { schemaVersion: 1, edits: [] },
      baseSubmission(),
      NOW,
    );
    expect(file.edits).toHaveLength(1);
    const edit = file.edits[0];
    expect(edit.id).toMatch(/^edit_[a-f0-9]{24}$/);
    expect(edit.accountId).toBe(ACCOUNT_ID);
    expect(edit.targetKind).toBe("builder");
    expect(edit.targetId).toBe("bld_ada");
    expect(edit.field).toBe("displayName");
    expect(edit.previousValue).toBe("Old Name");
    expect(edit.proposedValue).toBe("Ada the Builder");
    expect(edit.status).toBe("pending");
    expect(edit.publishedAt).toBeNull();
    expect(edit.reviewNote).toBeNull();
    expect(edit.submittedAt).toBe(NOW.toISOString());
  });

  it("rejects a field not on the target kind's allowlist", () => {
    expect(() =>
      submitEdit(
        { schemaVersion: 1, edits: [] },
        baseSubmission({ targetKind: "builder", field: "verifiedGithub", proposedValue: "someone" }),
        NOW,
      ),
    ).toThrow(BuilderEditValidationError);
  });

  it("rejects a proposedValue that fails the field's own registry schema (displayName over 80 chars)", () => {
    const tooLong = "x".repeat(81);
    expect(() =>
      submitEdit(
        { schemaVersion: 1, edits: [] },
        baseSubmission({ field: "displayName", proposedValue: tooLong }),
        NOW,
      ),
    ).toThrow(BuilderEditValidationError);
  });

  it("rejects a links proposedValue containing a non-URL entry", () => {
    expect(() =>
      submitEdit(
        { schemaVersion: 1, edits: [] },
        baseSubmission({ field: "links", proposedValue: ["not-a-url"] }),
        NOW,
      ),
    ).toThrow(BuilderEditValidationError);
  });

  it("accepts a well-formed links proposedValue", () => {
    const file = submitEdit(
      { schemaVersion: 1, edits: [] },
      baseSubmission({ field: "links", proposedValue: ["https://example.com/ada"] }),
      NOW,
    );
    expect(file.edits[0].proposedValue).toEqual(["https://example.com/ada"]);
  });

  it("validates a version-target field (disclosureStatus enum) against its own schema", () => {
    expect(() =>
      submitEdit(
        { schemaVersion: 1, edits: [] },
        baseSubmission({
          targetKind: "version",
          targetId: "agtv_daveey_v24",
          field: "disclosureStatus",
          proposedValue: "not-a-real-status",
        }),
        NOW,
      ),
    ).toThrow(BuilderEditValidationError);

    const file = submitEdit(
      { schemaVersion: 1, edits: [] },
      baseSubmission({
        targetKind: "version",
        targetId: "agtv_daveey_v24",
        field: "disclosureStatus",
        proposedValue: "disclosed",
      }),
      NOW,
    );
    expect(file.edits[0].proposedValue).toBe("disclosed");
  });

  it("round-trips through the file store atomically via mutateBuilderEditStore", async () => {
    await mutateBuilderEditStore(stateRoot, (file) => submitEdit(file, baseSubmission(), NOW));
    const reloaded = await readBuilderEditStore(stateRoot);
    expect(reloaded.edits).toHaveLength(1);
    expect(reloaded.edits[0].targetId).toBe("bld_ada");
  });

  it("findEditsByAccount / findEditById filter and look up correctly", () => {
    let file: BuilderEditStoreFile = { schemaVersion: 1, edits: [] };
    file = submitEdit(file, baseSubmission(), NOW);
    file = submitEdit(
      file,
      baseSubmission({ accountId: "acct_00000000000000000000000000000002", field: "shortBio", proposedValue: "bio" }),
      NOW,
    );
    expect(findEditsByAccount(file, ACCOUNT_ID)).toHaveLength(1);
    const edit = findEditsByAccount(file, ACCOUNT_ID)[0];
    expect(findEditById(file, edit.id)).toEqual(edit);
    expect(findEditById(file, "edit_does_not_exist")).toBeNull();
  });

  it("publishEdit marks a pending edit published without altering its field/value", () => {
    const submitted = submitEdit({ schemaVersion: 1, edits: [] }, baseSubmission(), NOW);
    const editId = submitted.edits[0].id;
    const published = publishEdit(submitted, editId, NOW);
    const edit = findEditById(published, editId)!;
    expect(edit.status).toBe("published");
    expect(edit.publishedAt).toBe(NOW.toISOString());
    expect(edit.field).toBe("displayName");
    expect(edit.proposedValue).toBe("Ada the Builder");
  });

  it("publishEdit throws BuilderEditNotFoundError for an unknown id", () => {
    expect(() => publishEdit({ schemaVersion: 1, edits: [] }, "edit_missing", NOW)).toThrow(
      BuilderEditNotFoundError,
    );
  });

  it("publishEdit refuses to re-resolve an already-published edit", () => {
    const submitted = submitEdit({ schemaVersion: 1, edits: [] }, baseSubmission(), NOW);
    const editId = submitted.edits[0].id;
    const published = publishEdit(submitted, editId, NOW);
    expect(() => publishEdit(published, editId, NOW)).toThrow(BuilderEditNotPendingError);
  });

  it("rejectEdit marks a pending edit rejected with the note, and refuses on a non-pending edit", () => {
    const submitted = submitEdit({ schemaVersion: 1, edits: [] }, baseSubmission(), NOW);
    const editId = submitted.edits[0].id;
    const rejected = rejectEdit(submitted, editId, "Not a real display name change.", NOW);
    const edit = findEditById(rejected, editId)!;
    expect(edit.status).toBe("rejected");
    expect(edit.reviewNote).toBe("Not a real display name change.");
    expect(() => rejectEdit(rejected, editId, "again", NOW)).toThrow(BuilderEditNotPendingError);
  });

  it("rejectEdit refuses a blank note", () => {
    const submitted = submitEdit({ schemaVersion: 1, edits: [] }, baseSubmission(), NOW);
    const editId = submitted.edits[0].id;
    expect(() => rejectEdit(submitted, editId, "   ", NOW)).toThrow(BuilderEditValidationError);
  });
});
