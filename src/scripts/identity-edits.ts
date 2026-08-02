#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  AgentProfileSchema,
  AgentVersionSchema,
  BuilderProfileSchema,
} from "../server/identity/IdentitySchemas";
import {
  defaultAgentRegistryPath,
  defaultAgentVersionRegistryPath,
  defaultBuilderRegistryPath,
  defaultIdentityRegistryDir,
  loadAgentRegistry,
  loadAgentVersionRegistry,
  loadBuilderRegistry,
  saveAgentRegistry,
  saveAgentVersionRegistry,
  saveBuilderRegistry,
} from "../server/identity/IdentityRegistry";
import {
  findEditById,
  mutateBuilderEditStore,
  publishEdit,
  readBuilderEditStore,
  rejectEdit,
  resolveBuilderEditStateRoot,
  type BuilderProfileEdit,
  type BuilderProfileEditStatus,
} from "../server/platform/PlatformBuilderEditStore";

/**
 * `identity:edits` — the operator side of the builder-improvement loop's
 * self-service field edits (see `PlatformBuilderEditStore.ts`'s module
 * doc for the trust split this CLI exists to enforce). `list` and
 * `reject` only ever touch the edit queue; `publish` is the ONLY thing in
 * this whole track that writes the tracked `resources/identity/*.json`
 * registry files, and it does so exactly like `identity-generate-emblems.
 * ts` already does: writes the files, prints a diff-review summary, and
 * leaves committing to the operator. Same argv/exit-code/`main().catch`
 * conventions as `identity-validate.ts`.
 */

interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

type EditsCommand =
  | { readonly kind: "list"; readonly status: BuilderProfileEditStatus | undefined }
  | { readonly kind: "publish"; readonly editId: string; readonly dir: string | undefined }
  | { readonly kind: "reject"; readonly editId: string; readonly note: string };

function isEditStatus(value: string): value is BuilderProfileEditStatus {
  return value === "pending" || value === "published" || value === "rejected";
}

function parseArgs(argv: readonly string[]): EditsCommand {
  const [subcommand, ...rest] = argv;
  if (subcommand === "list") {
    let status: BuilderProfileEditStatus | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] !== "--status") {
        throw new Error(`identity_edits_cli_unknown_argument: ${rest[i]}`);
      }
      const value = rest[i + 1];
      if (value === undefined || !isEditStatus(value)) {
        throw new Error(`identity_edits_cli_invalid_status: ${value ?? "<missing>"}`);
      }
      status = value;
      i += 1;
    }
    return { kind: "list", status };
  }
  if (subcommand === "publish" || subcommand === "reject") {
    const editId = rest[0];
    if (editId === undefined || editId.startsWith("--")) {
      throw new Error(`identity_edits_cli_missing_edit_id: ${subcommand}`);
    }
    let dir: string | undefined;
    let note: string | undefined;
    for (let i = 1; i < rest.length; i += 1) {
      if (subcommand === "publish" && rest[i] === "--dir") {
        dir = rest[i + 1];
        i += 1;
        continue;
      }
      if (subcommand === "reject" && rest[i] === "--note") {
        note = rest[i + 1];
        i += 1;
        continue;
      }
      throw new Error(`identity_edits_cli_unknown_argument: ${rest[i]}`);
    }
    if (subcommand === "publish") {
      return { kind: "publish", editId, dir };
    }
    if (note === undefined || note.trim().length === 0) {
      throw new Error("identity_edits_cli_reject_requires_note: --note <text>");
    }
    return { kind: "reject", editId, note };
  }
  throw new Error(
    `identity_edits_cli_unknown_subcommand: ${subcommand ?? "<missing>"} (expected list|publish|reject)`,
  );
}

function formatEditsTable(edits: readonly BuilderProfileEdit[]): string {
  if (edits.length === 0) return "identity:edits — no edits found";
  const rows = edits.map(
    (edit) =>
      `${edit.id}  ${edit.status.padEnd(9)}  ${edit.targetKind}:${edit.targetId}  field=${edit.field}  submitted=${edit.submittedAt}`,
  );
  return [`identity:edits — ${edits.length} edit(s)`, ...rows].join("\n");
}

type RegistryApplyResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Applies `edit.field: edit.proposedValue` to the ONE target record it
 * names, re-validates the FULL record against its real Zod schema, and
 * saves the whole registry file — never a partial write. A corrupt or
 * now-stale edit (target record deleted, or the proposed value no longer
 * satisfies the schema after other changes) fails loudly here and the
 * registry file is never touched, matching `saveBuilderRegistry`'s own
 * "throws, never silently corrupts" discipline.
 */
async function applyEditToRegistry(
  edit: BuilderProfileEdit,
  dir: string,
): Promise<RegistryApplyResult> {
  if (edit.targetKind === "builder") {
    const filePath = defaultBuilderRegistryPath(dir);
    const builders = await loadBuilderRegistry(filePath);
    const index = builders.findIndex((builder) => builder.id === edit.targetId);
    if (index === -1) return { ok: false, error: `builder not found: ${edit.targetId}` };
    const candidate = { ...builders[index], [edit.field]: edit.proposedValue };
    const parsed = BuilderProfileSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        error: `re-validation failed for builder ${edit.targetId}.${edit.field}: ${parsed.error.message}`,
      };
    }
    await saveBuilderRegistry(
      builders.map((builder, i) => (i === index ? parsed.data : builder)),
      filePath,
    );
    return { ok: true };
  }
  if (edit.targetKind === "agent") {
    const filePath = defaultAgentRegistryPath(dir);
    const agents = await loadAgentRegistry(filePath);
    const index = agents.findIndex((agent) => agent.id === edit.targetId);
    if (index === -1) return { ok: false, error: `agent not found: ${edit.targetId}` };
    const candidate = { ...agents[index], [edit.field]: edit.proposedValue };
    const parsed = AgentProfileSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        error: `re-validation failed for agent ${edit.targetId}.${edit.field}: ${parsed.error.message}`,
      };
    }
    await saveAgentRegistry(
      agents.map((agent, i) => (i === index ? parsed.data : agent)),
      filePath,
    );
    return { ok: true };
  }
  const filePath = defaultAgentVersionRegistryPath(dir);
  const versions = await loadAgentVersionRegistry(filePath);
  const index = versions.findIndex((version) => version.id === edit.targetId);
  if (index === -1) return { ok: false, error: `version not found: ${edit.targetId}` };
  const candidate = { ...versions[index], [edit.field]: edit.proposedValue };
  const parsed = AgentVersionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: `re-validation failed for version ${edit.targetId}.${edit.field}: ${parsed.error.message}`,
    };
  }
  await saveAgentVersionRegistry(
    versions.map((version, i) => (i === index ? parsed.data : version)),
    filePath,
  );
  return { ok: true };
}

async function runPublish(
  stateRoot: string,
  editId: string,
  dirOverride: string | undefined,
  io: CliIo,
): Promise<number> {
  const store = await readBuilderEditStore(stateRoot);
  const edit = findEditById(store, editId);
  if (edit === null) {
    io.stderr(`identity:edits publish — edit not found: ${editId}`);
    return 1;
  }
  if (edit.status !== "pending") {
    io.stderr(
      `identity:edits publish — edit ${editId} is not pending (status=${edit.status}); refusing to publish`,
    );
    return 1;
  }
  const dir = dirOverride ?? defaultIdentityRegistryDir;
  const applied = await applyEditToRegistry(edit, dir);
  if (!applied.ok) {
    io.stderr(`identity:edits publish — ${applied.error}`);
    return 1;
  }
  await mutateBuilderEditStore(stateRoot, (file) => publishEdit(file, editId, new Date()));
  io.stdout(`identity:edits publish — ${editId}: ${edit.targetKind} ${edit.targetId} . ${edit.field}`);
  io.stdout(`  before: ${JSON.stringify(edit.previousValue)}`);
  io.stdout(`  after:  ${JSON.stringify(edit.proposedValue)}`);
  io.stdout(
    "identity:edits publish — registry written; review the diff, then `git add resources/identity/*.json` and commit.",
  );
  return 0;
}

export async function runIdentityEditsCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  try {
    const command = parseArgs(argv);
    const stateRoot = resolveBuilderEditStateRoot();
    if (command.kind === "list") {
      const store = await readBuilderEditStore(stateRoot);
      const edits =
        command.status === undefined
          ? store.edits
          : store.edits.filter((edit) => edit.status === command.status);
      io.stdout(formatEditsTable(edits));
      return 0;
    }
    if (command.kind === "publish") {
      return await runPublish(stateRoot, command.editId, command.dir, io);
    }
    await mutateBuilderEditStore(stateRoot, (file) =>
      rejectEdit(file, command.editId, command.note, new Date()),
    );
    io.stdout(`identity:edits reject — ${command.editId} rejected (${command.note})`);
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = await runIdentityEditsCli(process.argv.slice(2));
}
