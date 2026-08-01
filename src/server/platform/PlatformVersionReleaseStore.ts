/**
 * Durable store for BUILDER-submitted "I released a new agent version"
 * notices — Season Zero Phase 6's builder-improvement loop.
 *
 * A record here is NOT the tracked `AgentVersion` registry entry itself:
 * that stays `sync-version-registry.ts`'s exclusive write path, sourced
 * from what the league mirror actually observed live, never from what a
 * builder SAYS they shipped. A {@link PendingVersionRelease} is the
 * builder's own disclosure of intent (`releaseNotes`/`baseModel`/
 * `scaffoldDescription`/`sourceDisclosure`/`intendedChanges`) plus a
 * promise: "the next qualifying version the mirror observes for this
 * agent is the one I mean". `VersionReleaseReconcile.ts` is the ONLY
 * thing that ever flips `status` away from `"pending"`, and only once
 * `sync-version-registry.ts` has actually recorded a matching
 * `AgentVersion` (see that module's doc for the exact matching rule).
 *
 * Same cross-process concurrency contract and reasoning as
 * `PlatformBuilderClaimStore.ts` (read that module's doc for the full
 * argument): a verified builder can submit a release notice from the live
 * HTTP server at any moment, while `identity:releases reconcile` runs as
 * a SEPARATE OS process reading the league mirror's freshly-synced
 * version registry. This store copies that one's exact shape verbatim —
 * free functions, one JSON file, one cross-process `FileMutex` lock keyed
 * on this store's OWN state root so an unrelated store's hold can never
 * block a release submission or a reconcile pass.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { withFileMutex } from "../agents/FileMutex";
import { resolvePlatformPrivateStateRoot } from "./PlatformSecrets";

export const VERSION_RELEASE_STATE_ROOT_ENV =
  "PROXYWAR_VERSION_RELEASE_STATE_ROOT" as const;
const STORE_FILE_NAME = "version-releases.json";
const MAX_FREE_TEXT_CODEPOINTS = 2_000;
const MAX_VERSION_LABEL_CODEPOINTS = 80;

/** Same override-with-safe-default shape as `resolveBuilderClaimStateRoot` — nested one directory below the platform's own private root, in its own subdirectory so its `FileMutex` lock file never collides with a sibling store's. */
export function resolveVersionReleaseStateRoot(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment[VERSION_RELEASE_STATE_ROOT_ENV]?.trim();
  if (configured !== undefined && configured !== "") {
    return path.resolve(configured);
  }
  return path.join(
    resolvePlatformPrivateStateRoot(environment, homeDirectory),
    "version-releases",
  );
}

export const defaultVersionReleaseStateRoot = resolveVersionReleaseStateRoot();

const pendingVersionReleaseSchema = z
  .object({
    id: z.string().regex(/^rel_[a-f0-9]{24}$/),
    accountId: z.string().regex(/^acct_[a-f0-9]{32}$/),
    agentId: z.string().regex(/^agt_[a-z0-9-]+$/),
    versionLabel: z.string().min(1).max(MAX_VERSION_LABEL_CODEPOINTS),
    releaseNotes: z.string().max(MAX_FREE_TEXT_CODEPOINTS).nullable(),
    baseModel: z.string().max(MAX_FREE_TEXT_CODEPOINTS).nullable(),
    scaffoldDescription: z.string().max(MAX_FREE_TEXT_CODEPOINTS).nullable(),
    sourceDisclosure: z.string().max(MAX_FREE_TEXT_CODEPOINTS).nullable(),
    intendedChanges: z.string().max(MAX_FREE_TEXT_CODEPOINTS).nullable(),
    createdAt: z.string(),
    status: z.enum(["pending", "observed", "stale"]),
    observedVersionId: z
      .string()
      .regex(/^agtv_[a-z0-9-]+_v[a-z0-9]+$/)
      .nullable(),
    observedAt: z.string().nullable(),
  })
  .strict();
export type PendingVersionRelease = z.infer<typeof pendingVersionReleaseSchema>;

const versionReleaseStoreFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    releases: z.array(pendingVersionReleaseSchema),
  })
  .strict();
export type VersionReleaseStoreFile = z.infer<
  typeof versionReleaseStoreFileSchema
>;

export function newVersionReleaseId(): string {
  return `rel_${randomBytes(12).toString("hex")}`;
}

/** Same discipline as `PlatformBuilderClaimStore.ts`'s local `sanitizeFreeText` (copied verbatim — that one isn't exported, and it's eight lines, not worth extracting a shared util for): collapse whitespace, drop invisible control/format characters, trim, cap length. `null` means "blank — reject the submission". */
function sanitizeFreeText(raw: string, maxCodepoints: number): string | null {
  const collapsed = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return null;
  const codepoints = Array.from(collapsed);
  return codepoints.length > maxCodepoints
    ? codepoints.slice(0, maxCodepoints).join("")
    : collapsed;
}

/** Input for a brand-new release notice — `accountId` and `agentId` are the CALLER's responsibility to have already authorized (see `PlatformBuilderVersionHttp.ts`'s doc for the "must hold a verified claim for THIS agent" check this function deliberately does not and cannot perform itself). */
export interface VersionReleaseSubmission {
  readonly accountId: string;
  readonly agentId: string;
  readonly versionLabel: string;
  readonly releaseNotes: string | null;
  readonly baseModel: string | null;
  readonly scaffoldDescription: string | null;
  readonly sourceDisclosure: string | null;
  readonly intendedChanges: string | null;
}

export class VersionReleaseValidationError extends Error {
  constructor(public readonly field: string) {
    super(`version_release_invalid_field: ${field}`);
    this.name = "VersionReleaseValidationError";
  }
}

export class VersionReleaseNotFoundError extends Error {
  constructor(public readonly releaseId: string) {
    super(`version_release_not_found: ${releaseId}`);
    this.name = "VersionReleaseNotFoundError";
  }
}

// ---------------------------------------------------------------------
// Storage — identical atomic-write shape to `PlatformBuilderClaimStore.ts`'s
// own `writeFileAtomic` (kept local here too, same reasoning: three lines,
// not worth extracting a shared util for).
// ---------------------------------------------------------------------

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
export async function readVersionReleaseStore(
  stateRoot: string,
): Promise<VersionReleaseStoreFile> {
  const filePath = path.join(stateRoot, STORE_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { schemaVersion: 1, releases: [] };
    }
    throw error;
  }
  return versionReleaseStoreFileSchema.parse(JSON.parse(raw));
}

async function writeVersionReleaseStoreUnlocked(
  stateRoot: string,
  file: VersionReleaseStoreFile,
): Promise<void> {
  const validated = versionReleaseStoreFileSchema.parse(file);
  await fs.mkdir(stateRoot, { recursive: true });
  await writeFileAtomic(
    path.join(stateRoot, STORE_FILE_NAME),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

/**
 * The canonical read-modify-write primitive — see this module's doc for
 * why every mutation (server routes AND the `identity:releases reconcile`
 * CLI) MUST go through this function rather than a separate read followed
 * by a separate write. Throws if `mutate` returns a store that fails
 * schema validation.
 */
export async function mutateVersionReleaseStore(
  stateRoot: string,
  mutate: (file: VersionReleaseStoreFile) => VersionReleaseStoreFile,
): Promise<VersionReleaseStoreFile> {
  return withFileMutex(stateRoot, async () => {
    const current = await readVersionReleaseStore(stateRoot);
    const next = mutate(current);
    await writeVersionReleaseStoreUnlocked(stateRoot, next);
    return next;
  });
}

// ---------------------------------------------------------------------
// Query helpers — pure, operate on an already-loaded store file. Kept
// free-standing (not store methods) so both HTTP routes and CLIs share
// one implementation without instantiating anything.
// ---------------------------------------------------------------------

export function findReleasesByAccount(
  file: VersionReleaseStoreFile,
  accountId: string,
): readonly PendingVersionRelease[] {
  return file.releases.filter((release) => release.accountId === accountId);
}

export function findReleasesByAgent(
  file: VersionReleaseStoreFile,
  agentId: string,
): readonly PendingVersionRelease[] {
  return file.releases.filter((release) => release.agentId === agentId);
}

// ---------------------------------------------------------------------
// Mutations — none of these touch the filesystem directly; callers wrap
// them in `mutateVersionReleaseStore`.
// ---------------------------------------------------------------------

/** Creates a brand-new `pending` release notice. */
export function createPendingRelease(
  file: VersionReleaseStoreFile,
  input: VersionReleaseSubmission,
  now: Date,
): VersionReleaseStoreFile {
  const versionLabel = sanitizeFreeText(
    input.versionLabel,
    MAX_VERSION_LABEL_CODEPOINTS,
  );
  if (versionLabel === null) {
    throw new VersionReleaseValidationError("versionLabel");
  }
  const sanitizeOptional = (value: string | null): string | null =>
    value === null ? null : sanitizeFreeText(value, MAX_FREE_TEXT_CODEPOINTS);
  const record: PendingVersionRelease = {
    id: newVersionReleaseId(),
    accountId: input.accountId,
    agentId: input.agentId,
    versionLabel,
    releaseNotes: sanitizeOptional(input.releaseNotes),
    baseModel: sanitizeOptional(input.baseModel),
    scaffoldDescription: sanitizeOptional(input.scaffoldDescription),
    sourceDisclosure: sanitizeOptional(input.sourceDisclosure),
    intendedChanges: sanitizeOptional(input.intendedChanges),
    createdAt: now.toISOString(),
    status: "pending",
    observedVersionId: null,
    observedAt: null,
  };
  return { ...file, releases: [...file.releases, record] };
}

/** Flips one release from `pending` to `observed` — see `VersionReleaseReconcile.ts` for the ONLY sanctioned caller and the matching rule that decides `observedVersionId`/`observedAt`. */
export function markObserved(
  file: VersionReleaseStoreFile,
  releaseId: string,
  observedVersionId: string,
  observedAt: string,
): VersionReleaseStoreFile {
  const release = file.releases.find((candidate) => candidate.id === releaseId);
  if (release === undefined) {
    throw new VersionReleaseNotFoundError(releaseId);
  }
  const updated: PendingVersionRelease = {
    ...release,
    status: "observed",
    observedVersionId,
    observedAt,
  };
  return {
    ...file,
    releases: file.releases.map((candidate) =>
      candidate.id === releaseId ? updated : candidate,
    ),
  };
}
