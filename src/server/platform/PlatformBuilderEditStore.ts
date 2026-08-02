/**
 * Durable store for verified-Builder SELF-SERVICE profile field edits —
 * Season Zero's builder-improvement loop. Structurally identical to
 * `PlatformBuilderClaimStore.ts` (read that module's doc first — every
 * reason it gives for its storage shape applies verbatim here): free
 * functions, one JSON file, one cross-process `FileMutex` lock, atomic
 * temp-file+rename writes. This store is also mutated by two separate OS
 * processes — the running HTTP server (accepting submissions from verified
 * Builders) and an operator running `identity:edits publish/reject` — so
 * it needs the same stronger-than-in-process concurrency contract.
 *
 * The risk profile here is the OPPOSITE of claim approval, though: claim
 * approval is operator-run, trusted, infrequent, and writes DIRECTLY to
 * the tracked identity registry. Self-service field edits come from
 * untrusted end users and can be frequent, so a submission here NEVER
 * touches `resources/identity/*.json` directly — it only ever becomes a
 * `pending` record in this staged, audited store. A change only reaches
 * the tracked registry when an operator explicitly runs
 * `identity:edits publish <id>` (see `identity-edits.ts`), which is the
 * only writer of the real registry files, exactly like
 * `identity-claims.ts approve` is the only writer of `verifiedGithub`/
 * `builderId`.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { withFileMutex } from "../agents/FileMutex";
import {
  AgentProfileSchema,
  AgentVersionSchema,
  BuilderProfileSchema,
} from "../identity/IdentitySchemas";
import { resolvePlatformPrivateStateRoot } from "./PlatformSecrets";

export const BUILDER_EDIT_STATE_ROOT_ENV =
  "PROXYWAR_BUILDER_EDIT_STATE_ROOT" as const;
const STORE_FILE_NAME = "builder-profile-edits.json";
const MAX_REVIEW_NOTE_CODEPOINTS = 2_000;

/** Same override-with-safe-default shape as `resolveBuilderClaimStateRoot` — nested one directory below the platform's own private root, in its own subdirectory so its `FileMutex` lock file never collides with a sibling store's (this store's own writer, `identity:edits`, runs as a separate OS process from the server, exactly like `identity:claims` does for `PlatformBuilderClaimStore`). */
export function resolveBuilderEditStateRoot(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment[BUILDER_EDIT_STATE_ROOT_ENV]?.trim();
  if (configured !== undefined && configured !== "") {
    return path.resolve(configured);
  }
  return path.join(
    resolvePlatformPrivateStateRoot(environment, homeDirectory),
    "builder-edits",
  );
}

export const defaultBuilderEditStateRoot = resolveBuilderEditStateRoot();

const builderProfileEditSchema = z
  .object({
    id: z.string().regex(/^edit_[a-f0-9]{24}$/),
    accountId: z.string().regex(/^acct_[a-f0-9]{32}$/),
    targetKind: z.enum(["builder", "agent", "version"]),
    targetId: z.string().min(1),
    field: z.string().min(1),
    /** Snapshotted at submission time, for audit/diff display — never re-derived, so a diff shown alongside a stale registry state is still an honest record of "what the submitter saw". */
    previousValue: z.unknown(),
    proposedValue: z.unknown(),
    submittedAt: z.string(),
    status: z.enum(["pending", "published", "rejected"]),
    publishedAt: z.string().nullable(),
    reviewNote: z.string().max(MAX_REVIEW_NOTE_CODEPOINTS).nullable(),
  })
  .strict();
export type BuilderProfileEdit = z.infer<typeof builderProfileEditSchema>;
export type BuilderEditTargetKind = BuilderProfileEdit["targetKind"];
export type BuilderProfileEditStatus = BuilderProfileEdit["status"];

const builderEditStoreFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    edits: z.array(builderProfileEditSchema),
  })
  .strict();
export type BuilderEditStoreFile = z.infer<typeof builderEditStoreFileSchema>;

export function newBuilderEditId(): string {
  return `edit_${randomBytes(12).toString("hex")}`;
}

/**
 * The fields a verified Builder may self-service-edit per target kind —
 * enforced HERE (the source of truth `submitEdit` checks) and again, as
 * defense in depth, by `PlatformBuilderEditHttp.ts` BEFORE it even
 * snapshots `previousValue` from the registry. Any field not listed here
 * is either operator-only (`slug`, `id`, `status`, `verifiedGithub`,
 * `emblem`, colors, `policyMatchRule`, `qualificationStatus`, ...) or
 * never user-editable at all (registry provenance like `observedAt`).
 */
export const EDITABLE_FIELDS_BY_TARGET_KIND: Record<
  BuilderEditTargetKind,
  readonly string[]
> = {
  builder: ["displayName", "shortBio", "links", "teamMembers"],
  agent: ["tagline", "publicStrategyDescription"],
  version: [
    "releaseNotes",
    "declaredBaseModel",
    "scaffoldDescription",
    "sourceRepositoryRef",
    "disclosureStatus",
  ],
};

/** Real per-field Zod pieces lifted straight off the registry's own schemas — `proposedValue` is checked against the EXACT constraint the field will be re-validated against at `identity:edits publish` time (see that CLI's `applyEditToRegistry`), so a submission that would fail publish-time re-validation is rejected up front instead of sitting in the queue as a landmine. */
const FIELD_SCHEMA_BY_TARGET_KIND: Record<
  BuilderEditTargetKind,
  Readonly<Record<string, z.ZodTypeAny>>
> = {
  builder: {
    displayName: BuilderProfileSchema.shape.displayName,
    shortBio: BuilderProfileSchema.shape.shortBio,
    links: BuilderProfileSchema.shape.links,
    teamMembers: BuilderProfileSchema.shape.teamMembers,
  },
  agent: {
    tagline: AgentProfileSchema.shape.tagline,
    publicStrategyDescription: AgentProfileSchema.shape.publicStrategyDescription,
  },
  version: {
    releaseNotes: AgentVersionSchema.shape.releaseNotes,
    declaredBaseModel: AgentVersionSchema.shape.declaredBaseModel,
    scaffoldDescription: AgentVersionSchema.shape.scaffoldDescription,
    sourceRepositoryRef: AgentVersionSchema.shape.sourceRepositoryRef,
    disclosureStatus: AgentVersionSchema.shape.disclosureStatus,
  },
};

const TARGET_ID_PATTERN_BY_KIND: Record<BuilderEditTargetKind, RegExp> = {
  builder: /^bld_[a-z0-9-]+$/,
  agent: /^agt_[a-z0-9-]+$/,
  version: /^agtv_[a-z0-9-]+_v[a-z0-9]+$/,
};

/** Input for a brand-new edit submission — `previousValue` is the CALLER's responsibility (an HTTP route that has already loaded the current registry record), same division of duty `BuilderClaimSubmission`/`submitClaim` keep for `githubLogin`. */
export interface BuilderProfileEditSubmission {
  readonly accountId: string;
  readonly targetKind: BuilderEditTargetKind;
  readonly targetId: string;
  readonly field: string;
  readonly previousValue: unknown;
  readonly proposedValue: unknown;
}

export class BuilderEditValidationError extends Error {
  constructor(public readonly field: string) {
    super(`builder_edit_invalid_field: ${field}`);
    this.name = "BuilderEditValidationError";
  }
}

export class BuilderEditNotFoundError extends Error {
  constructor(public readonly editId: string) {
    super(`builder_edit_not_found: ${editId}`);
    this.name = "BuilderEditNotFoundError";
  }
}

/** Both `publishEdit` and `rejectEdit` only ever apply to a `pending` edit — a published or already-rejected edit is a terminal record, matching `BuilderClaimRecord`'s terminal-state discipline. */
export class BuilderEditNotPendingError extends Error {
  constructor(
    public readonly editId: string,
    public readonly status: BuilderProfileEditStatus,
  ) {
    super(
      `builder_edit_not_pending: cannot resolve edit ${editId} already in status "${status}"`,
    );
    this.name = "BuilderEditNotPendingError";
  }
}

// ---------------------------------------------------------------------
// Storage — identical atomic-write shape to `PlatformBuilderClaimStore.ts`'s
// own `writeFileAtomic` (kept local here too, same reasoning: three lines,
// not worth extracting a shared util for).
// ---------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function writeFileAtomic(
  destinationPath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Never throws on a cold start (returns an empty, schema-valid store); throws on a corrupt file — a bad store is a loud failure, never a silent reset. */
export async function readBuilderEditStore(
  stateRoot: string,
): Promise<BuilderEditStoreFile> {
  const filePath = path.join(stateRoot, STORE_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { schemaVersion: 1, edits: [] };
    }
    throw error;
  }
  return builderEditStoreFileSchema.parse(JSON.parse(raw));
}

async function writeBuilderEditStoreUnlocked(
  stateRoot: string,
  file: BuilderEditStoreFile,
): Promise<void> {
  const validated = builderEditStoreFileSchema.parse(file);
  await fs.mkdir(stateRoot, { recursive: true });
  await writeFileAtomic(
    path.join(stateRoot, STORE_FILE_NAME),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

/**
 * The canonical read-modify-write primitive — see this module's doc for
 * why every mutation (server routes AND the `identity:edits` CLI) MUST go
 * through this function rather than a separate read followed by a
 * separate write. Throws if `mutate` returns a store that fails schema
 * validation.
 */
export async function mutateBuilderEditStore(
  stateRoot: string,
  mutate: (file: BuilderEditStoreFile) => BuilderEditStoreFile,
): Promise<BuilderEditStoreFile> {
  return withFileMutex(stateRoot, async () => {
    const current = await readBuilderEditStore(stateRoot);
    const next = mutate(current);
    await writeBuilderEditStoreUnlocked(stateRoot, next);
    return next;
  });
}

// ---------------------------------------------------------------------
// Query helpers — pure, operate on an already-loaded store file.
// ---------------------------------------------------------------------

export function findEditsByAccount(
  file: BuilderEditStoreFile,
  accountId: string,
): readonly BuilderProfileEdit[] {
  return file.edits.filter((edit) => edit.accountId === accountId);
}

export function findEditById(
  file: BuilderEditStoreFile,
  editId: string,
): BuilderProfileEdit | null {
  return file.edits.find((edit) => edit.id === editId) ?? null;
}

// ---------------------------------------------------------------------
// Mutations — none of these touch the filesystem directly; callers wrap
// them in `mutateBuilderEditStore`.
// ---------------------------------------------------------------------

/**
 * Creates a brand-new `pending` edit. Enforces the field allowlist and the
 * field's own registry-schema shape (defense in depth alongside
 * `PlatformBuilderEditHttp.ts`'s identical checks) — a submission that
 * would fail `identity:edits publish`'s re-validation never even reaches
 * the queue.
 */
export function submitEdit(
  file: BuilderEditStoreFile,
  input: BuilderProfileEditSubmission,
  now: Date,
): BuilderEditStoreFile {
  const allowedFields = EDITABLE_FIELDS_BY_TARGET_KIND[input.targetKind];
  if (!allowedFields.includes(input.field)) {
    throw new BuilderEditValidationError(input.field);
  }
  if (!TARGET_ID_PATTERN_BY_KIND[input.targetKind].test(input.targetId)) {
    throw new BuilderEditValidationError("targetId");
  }
  const fieldSchema = FIELD_SCHEMA_BY_TARGET_KIND[input.targetKind][input.field];
  const parsedValue = fieldSchema.safeParse(input.proposedValue);
  if (!parsedValue.success) {
    throw new BuilderEditValidationError(input.field);
  }
  const record: BuilderProfileEdit = {
    id: newBuilderEditId(),
    accountId: input.accountId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    field: input.field,
    previousValue: input.previousValue,
    proposedValue: parsedValue.data,
    submittedAt: now.toISOString(),
    status: "pending",
    publishedAt: null,
    reviewNote: null,
  };
  return { ...file, edits: [...file.edits, record] };
}

function replaceEdit(
  file: BuilderEditStoreFile,
  updated: BuilderProfileEdit,
): BuilderEditStoreFile {
  return {
    ...file,
    edits: file.edits.map((edit) => (edit.id === updated.id ? updated : edit)),
  };
}

function requirePendingEdit(
  file: BuilderEditStoreFile,
  editId: string,
): BuilderProfileEdit {
  const edit = findEditById(file, editId);
  if (edit === null) throw new BuilderEditNotFoundError(editId);
  if (edit.status !== "pending") {
    throw new BuilderEditNotPendingError(editId, edit.status);
  }
  return edit;
}

/**
 * Marks a `pending` edit `published`. Deliberately does NOT touch the
 * identity registry itself — that is `identity:edits publish`'s job,
 * using the record this returns (`updated.edits` tail, or a subsequent
 * `findEditById`) to apply the field to the real, tracked registry file
 * BEFORE calling this. See this module's doc for why registry writes
 * never happen from server-mutated state.
 */
export function publishEdit(
  file: BuilderEditStoreFile,
  editId: string,
  now: Date,
): BuilderEditStoreFile {
  const edit = requirePendingEdit(file, editId);
  const updated: BuilderProfileEdit = {
    ...edit,
    status: "published",
    publishedAt: now.toISOString(),
  };
  return replaceEdit(file, updated);
}

/** Marks a `pending` edit `rejected` with an operator-supplied note — never touches the registry. */
export function rejectEdit(
  file: BuilderEditStoreFile,
  editId: string,
  note: string,
  now: Date,
): BuilderEditStoreFile {
  const edit = requirePendingEdit(file, editId);
  const trimmedNote = note.trim();
  if (trimmedNote.length === 0) {
    throw new BuilderEditValidationError("reviewNote");
  }
  const codepoints = Array.from(trimmedNote);
  const sanitizedNote =
    codepoints.length > MAX_REVIEW_NOTE_CODEPOINTS
      ? codepoints.slice(0, MAX_REVIEW_NOTE_CODEPOINTS).join("")
      : trimmedNote;
  const updated: BuilderProfileEdit = {
    ...edit,
    status: "rejected",
    reviewNote: sanitizedNote,
  };
  return replaceEdit(file, updated);
}
