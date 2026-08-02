import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runIdentityEditsCli } from "../../src/scripts/identity-edits";
import {
  loadAgentRegistry,
  loadBuilderRegistry,
  saveAgentRegistry,
  saveBuilderRegistry,
} from "../../src/server/identity/IdentityRegistry";
import {
  BUILDER_EDIT_STATE_ROOT_ENV,
  mutateBuilderEditStore,
  readBuilderEditStore,
  submitEdit,
} from "../../src/server/platform/PlatformBuilderEditStore";

const NOW = new Date("2026-08-01T00:00:00.000Z");

let editStateRoot: string;
let registryDir: string;
let stdout: string[];
let stderr: string[];

const io = () => ({
  stdout: (line: string) => stdout.push(line),
  stderr: (line: string) => stderr.push(line),
});

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-edits-cli-"));
  editStateRoot = path.join(root, "edits");
  registryDir = path.join(root, "registry");
  await mkdir(registryDir, { recursive: true });
  process.env[BUILDER_EDIT_STATE_ROOT_ENV] = editStateRoot;
  stdout = [];
  stderr = [];

  await saveBuilderRegistry(
    [
      {
        id: "bld_ada",
        slug: "ada",
        displayName: "Ada",
        shortBio: null,
        avatarUrl: null,
        verifiedGithub: null,
        links: [],
        teamMembers: [],
        softmaxPlayerIdentities: [],
        status: "verified",
      },
    ],
    path.join(registryDir, "builders.json"),
  );
  await saveAgentRegistry(
    [
      {
        id: "agt_daveey",
        slug: "daveey",
        displayName: "Daveey",
        shortCode: "DAV",
        builderId: "bld_ada",
        tagline: "Old tagline",
        description: null,
        emblem: {
          style: "geometric-svg-v1",
          seed: "agt_daveey",
          assetPath: "resources/identity/emblems/agt_daveey.svg",
        },
        primaryColor: "#112233",
        secondaryColor: "#445566",
        debutDate: null,
        policyMatchRule: { playerName: "daveey-proxywar", policyFamily: "daveey-proxywar" },
        status: "verified",
        publicStrategyDescription: null,
      },
    ],
    path.join(registryDir, "agents.json"),
  );
});

afterEach(async () => {
  delete process.env[BUILDER_EDIT_STATE_ROOT_ENV];
  await rm(path.dirname(editStateRoot), { recursive: true, force: true });
});

async function seedEdit(
  overrides: Partial<Parameters<typeof submitEdit>[1]> = {},
): Promise<string> {
  const file = await mutateBuilderEditStore(editStateRoot, (current) =>
    submitEdit(
      current,
      {
        accountId: "acct_00000000000000000000000000000001",
        targetKind: "builder",
        targetId: "bld_ada",
        field: "displayName",
        previousValue: "Ada",
        proposedValue: "Ada the Great",
        ...overrides,
      },
      NOW,
    ),
  );
  return file.edits[file.edits.length - 1].id;
}

describe("identity:edits list", () => {
  test("reports no edits found on a cold store", async () => {
    const code = await runIdentityEditsCli(["list"], io());
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("no edits found");
  });

  test("lists all edits, and --status filters to just that status", async () => {
    const pendingId = await seedEdit();
    const rejectedId = await seedEdit({ field: "shortBio", proposedValue: "bio" });
    await runIdentityEditsCli(["reject", rejectedId, "--note", "not needed"], io());

    stdout = [];
    const code = await runIdentityEditsCli(["list"], io());
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain(pendingId);
    expect(stdout.join("\n")).toContain(rejectedId);

    stdout = [];
    const filteredCode = await runIdentityEditsCli(["list", "--status", "pending"], io());
    expect(filteredCode).toBe(0);
    expect(stdout.join("\n")).toContain(pendingId);
    expect(stdout.join("\n")).not.toContain(rejectedId);
  });

  test("refuses an invalid --status value", async () => {
    const code = await runIdentityEditsCli(["list", "--status", "bogus"], io());
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("identity_edits_cli_invalid_status");
  });
});

describe("identity:edits publish", () => {
  test("applies the exact field to the exact registry record, re-validates, and marks the edit published", async () => {
    const editId = await seedEdit();
    const code = await runIdentityEditsCli(["publish", editId, "--dir", registryDir], io());
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("before: \"Ada\"");
    expect(stdout.join("\n")).toContain("after:  \"Ada the Great\"");
    expect(stdout.join("\n")).toContain("git add resources/identity/*.json");

    const builders = await loadBuilderRegistry(path.join(registryDir, "builders.json"));
    expect(builders.find((builder) => builder.id === "bld_ada")?.displayName).toBe(
      "Ada the Great",
    );

    const store = await readBuilderEditStore(editStateRoot);
    const edit = store.edits.find((candidate) => candidate.id === editId)!;
    expect(edit.status).toBe("published");
    expect(edit.publishedAt).not.toBeNull();
  });

  test("applies an agent-target field edit to the agents registry", async () => {
    const editId = await seedEdit({
      targetKind: "agent",
      targetId: "agt_daveey",
      field: "tagline",
      previousValue: "Old tagline",
      proposedValue: "New tagline",
    });
    const code = await runIdentityEditsCli(["publish", editId, "--dir", registryDir], io());
    expect(code).toBe(0);
    const agents = await loadAgentRegistry(path.join(registryDir, "agents.json"));
    expect(agents.find((agent) => agent.id === "agt_daveey")?.tagline).toBe("New tagline");
  });

  test("refuses to publish an edit that is not pending, and never touches the registry", async () => {
    const editId = await seedEdit();
    await runIdentityEditsCli(["publish", editId, "--dir", registryDir], io());

    stdout = [];
    stderr = [];
    const code = await runIdentityEditsCli(["publish", editId, "--dir", registryDir], io());
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("not pending");

    // Republishing must not have re-written the registry with a different
    // displayName or otherwise mutated it a second time.
    const builders = await loadBuilderRegistry(path.join(registryDir, "builders.json"));
    expect(builders.find((builder) => builder.id === "bld_ada")?.displayName).toBe(
      "Ada the Great",
    );
  });

  test("refuses to publish an unknown edit id", async () => {
    const code = await runIdentityEditsCli(["publish", "edit_does_not_exist", "--dir", registryDir], io());
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("edit not found");
  });

  test("fails loudly and does not write the registry when the target record no longer exists", async () => {
    const editId = await seedEdit({ targetId: "bld_missing" });
    // Force a store record pointing at a builder that isn't in the registry
    // by seeding directly against a non-existent target id above — publish
    // must refuse rather than partially write.
    const code = await runIdentityEditsCli(["publish", editId, "--dir", registryDir], io());
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("not found");
    const store = await readBuilderEditStore(editStateRoot);
    expect(store.edits.find((candidate) => candidate.id === editId)?.status).toBe("pending");
  });
});

describe("identity:edits reject", () => {
  test("requires --note", async () => {
    const editId = await seedEdit();
    const code = await runIdentityEditsCli(["reject", editId], io());
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("requires_note");

    const store = await readBuilderEditStore(editStateRoot);
    expect(store.edits.find((candidate) => candidate.id === editId)?.status).toBe("pending");
  });

  test("marks the edit rejected with the note and never touches the registry", async () => {
    const editId = await seedEdit();
    const code = await runIdentityEditsCli(["reject", editId, "--note", "Duplicate submission."], io());
    expect(code).toBe(0);

    const store = await readBuilderEditStore(editStateRoot);
    const edit = store.edits.find((candidate) => candidate.id === editId)!;
    expect(edit.status).toBe("rejected");
    expect(edit.reviewNote).toBe("Duplicate submission.");

    const builders = await loadBuilderRegistry(path.join(registryDir, "builders.json"));
    expect(builders.find((builder) => builder.id === "bld_ada")?.displayName).toBe("Ada");
  });
});

describe("identity:edits — argv errors", () => {
  test("rejects an unknown subcommand", async () => {
    const code = await runIdentityEditsCli(["bogus"], io());
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("identity_edits_cli_unknown_subcommand");
  });
});
