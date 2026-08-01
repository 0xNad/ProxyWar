/**
 * Real subprocess (`tsx`) end-to-end coverage of `identity:claims`'s four
 * subcommands — `list`/`approve`/`reject`/`revoke` — matching the pattern
 * `premiere-schedule-cli.test.ts` already established for this session's
 * operator CLIs: proves argv parsing, exit codes, and the real
 * `main().catch(...)` dispatch, not just the shared library functions.
 *
 * `approve`/`revoke` are the two commands with a registry side effect
 * (writing `resources/identity/{builders,agents}.json`-shaped files); both
 * are exercised end to end against temp registry files, never the tracked
 * ones.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyOperatorAction,
  mutateBuilderClaimStore,
  readBuilderClaimStore,
  submitClaim,
  type BuilderClaimSubmission,
} from "../../src/server/platform/PlatformBuilderClaimStore";
import { loadAgentRegistry, loadBuilderRegistry } from "../../src/server/identity/IdentityRegistry";

const repoRoot = path.resolve(__dirname, "../..");
const scriptsDir = path.join(repoRoot, "src", "scripts");
const NOW = new Date("2026-08-01T00:00:00.000Z");
const AGENT_ID = "agt_daveey";

function runCli(
  args: readonly string[],
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", path.join(scriptsDir, "identity-claims.ts"), ...args],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status: number; stdout: Buffer; stderr: Buffer };
    return {
      code: err.status,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? "",
    };
  }
}

function baseAgentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT_ID,
    slug: "daveey",
    displayName: "Daveey",
    shortCode: "DAV",
    builderId: null,
    tagline: null,
    description: null,
    emblem: {
      style: "geometric-svg-v1",
      seed: AGENT_ID,
      assetPath: `resources/identity/emblems/${AGENT_ID}.svg`,
    },
    primaryColor: "#112233",
    secondaryColor: "#445566",
    debutDate: null,
    policyMatchRule: { playerName: "daveey-proxywar", policyFamily: "daveey-proxywar" },
    status: "unclaimed",
    publicStrategyDescription: null,
    ...overrides,
  };
}

async function writeRegistryFixture(
  dir: string,
  agents: readonly unknown[] = [baseAgentFixture()],
  builders: readonly unknown[] = [],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "agents.json"),
    JSON.stringify({ schemaVersion: 1, agents }),
  );
  await writeFile(
    path.join(dir, "builders.json"),
    JSON.stringify({ schemaVersion: 1, builders }),
  );
  await writeFile(
    path.join(dir, "versions.json"),
    JSON.stringify({ schemaVersion: 1, versions: [] }),
  );
}

function baseSubmission(overrides: Partial<BuilderClaimSubmission> = {}): BuilderClaimSubmission {
  return {
    accountId: "acct_00000000000000000000000000000001",
    githubLogin: "ada-builder",
    agentId: AGENT_ID,
    claimedCoworldPlayerName: "daveey-proxywar",
    builderDisplayName: "Ada Builder",
    builderShortBio: "I build agents.",
    builderLinks: ["https://github.com/ada-builder"],
    teamMembers: ["Ada"],
    evidenceNote: "This is my GitHub repo and Coworld player.",
    evidenceLinks: ["https://github.com/ada-builder/proxywar-agent"],
    ...overrides,
  };
}

async function seedDraftClaim(
  claimStateRoot: string,
  overrides: Partial<BuilderClaimSubmission> = {},
): Promise<string> {
  let claimId = "";
  await mutateBuilderClaimStore(claimStateRoot, (file) => {
    const next = submitClaim(file, baseSubmission(overrides), NOW);
    claimId = next.claims[next.claims.length - 1].id;
    return next;
  });
  return claimId;
}

async function seedProofPendingClaim(
  claimStateRoot: string,
  overrides: Partial<BuilderClaimSubmission> = {},
): Promise<string> {
  const claimId = await seedDraftClaim(claimStateRoot, overrides);
  await mutateBuilderClaimStore(claimStateRoot, (file) =>
    applyOperatorAction(file, claimId, "mark_proof_pending", "seed", null, NOW),
  );
  return claimId;
}

describe("identity:claims CLI — real subprocess end to end", () => {
  let claimStateRoot: string;
  let registryDir: string;

  beforeEach(async () => {
    claimStateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-identity-claims-state-"));
    registryDir = await mkdtemp(path.join(os.tmpdir(), "pw-identity-claims-registry-"));
    await writeRegistryFixture(registryDir);
  });

  afterEach(async () => {
    await Promise.all(
      [claimStateRoot, registryDir].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it(
    "list prints every claim, and filters by --state",
    async () => {
      const draftId = await seedDraftClaim(claimStateRoot, { githubLogin: "drafter" });
      const proofPendingId = await seedProofPendingClaim(claimStateRoot, {
        accountId: "acct_00000000000000000000000000000002",
        githubLogin: "prover",
      });

      const all = runCli(["list", "--claim-state-root", claimStateRoot]);
      expect(all.code).toBe(0);
      expect(all.stdout).toContain(draftId);
      expect(all.stdout).toContain(proofPendingId);

      const filtered = runCli([
        "list",
        "--state",
        "proof_pending",
        "--claim-state-root",
        claimStateRoot,
      ]);
      expect(filtered.code).toBe(0);
      expect(filtered.stdout).toContain(proofPendingId);
      expect(filtered.stdout).not.toContain(draftId);
    },
    30_000,
  );

  it(
    "approve creates a NEW builder with verifiedGithub set and updates the agent's builderId/status",
    async () => {
      const claimId = await seedProofPendingClaim(claimStateRoot, {
        githubLogin: "ada-builder",
        builderDisplayName: "Ada Builder",
      });

      const result = runCli([
        "approve",
        claimId,
        "--note",
        "evidence checked out",
        "--dir",
        registryDir,
        "--claim-state-root",
        claimStateRoot,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(claimId);
      expect(result.stdout).toContain("verified");

      const claimFile = await readBuilderClaimStore(claimStateRoot);
      const claim = claimFile.claims.find((entry) => entry.id === claimId);
      expect(claim?.state).toBe("verified");
      expect(claim?.audit.at(-1)?.note).toBe("evidence checked out");

      const builders = await loadBuilderRegistry(path.join(registryDir, "builders.json"));
      expect(builders).toHaveLength(1);
      expect(builders[0].verifiedGithub).toBe("ada-builder");
      expect(builders[0].displayName).toBe("Ada Builder");
      expect(builders[0].status).toBe("verified");
      expect(builders[0].id).toBe("bld_ada-builder");

      const agents = await loadAgentRegistry(path.join(registryDir, "agents.json"));
      const agent = agents.find((entry) => entry.id === AGENT_ID);
      expect(agent?.builderId).toBe(builders[0].id);
      expect(agent?.status).toBe("verified");
    },
    30_000,
  );

  it(
    "approve on a non-proof_pending claim fails with exit 1 and mutates nothing",
    async () => {
      const draftId = await seedDraftClaim(claimStateRoot);

      const result = runCli([
        "approve",
        draftId,
        "--note",
        "too early",
        "--dir",
        registryDir,
        "--claim-state-root",
        claimStateRoot,
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("proof_pending");

      const claimFile = await readBuilderClaimStore(claimStateRoot);
      expect(claimFile.claims.find((entry) => entry.id === draftId)?.state).toBe("draft");

      const builders = await loadBuilderRegistry(path.join(registryDir, "builders.json"));
      expect(builders).toHaveLength(0);
      const agents = await loadAgentRegistry(path.join(registryDir, "agents.json"));
      expect(agents.find((entry) => entry.id === AGENT_ID)?.builderId).toBeNull();
    },
    30_000,
  );

  it(
    "reject requires --note and does not mutate without it; succeeds once provided",
    async () => {
      const claimId = await seedDraftClaim(claimStateRoot);

      const withoutNote = runCli(["reject", claimId, "--claim-state-root", claimStateRoot]);
      expect(withoutNote.code).toBe(1);
      expect(withoutNote.stderr).toContain("--note");
      const untouched = await readBuilderClaimStore(claimStateRoot);
      expect(untouched.claims.find((entry) => entry.id === claimId)?.state).toBe("draft");

      const withNote = runCli([
        "reject",
        claimId,
        "--note",
        "duplicate of another submission",
        "--claim-state-root",
        claimStateRoot,
      ]);
      expect(withNote.code).toBe(0);
      const rejected = await readBuilderClaimStore(claimStateRoot);
      expect(rejected.claims.find((entry) => entry.id === claimId)?.state).toBe("rejected");
    },
    30_000,
  );

  it(
    "revoke unlinks the agent (builderId null, status unclaimed) but leaves the BuilderProfile row intact",
    async () => {
      const claimId = await seedProofPendingClaim(claimStateRoot, {
        githubLogin: "ada-builder",
        builderDisplayName: "Ada Builder",
      });
      const approveResult = runCli([
        "approve",
        claimId,
        "--note",
        "ok",
        "--dir",
        registryDir,
        "--claim-state-root",
        claimStateRoot,
      ]);
      expect(approveResult.code).toBe(0);

      const revokeResult = runCli([
        "revoke",
        claimId,
        "--note",
        "evidence turned out to be fabricated",
        "--dir",
        registryDir,
        "--claim-state-root",
        claimStateRoot,
      ]);
      expect(revokeResult.code).toBe(0);

      const claimFile = await readBuilderClaimStore(claimStateRoot);
      expect(claimFile.claims.find((entry) => entry.id === claimId)?.state).toBe("revoked");

      const agents = await loadAgentRegistry(path.join(registryDir, "agents.json"));
      const agent = agents.find((entry) => entry.id === AGENT_ID);
      expect(agent?.builderId).toBeNull();
      expect(agent?.status).toBe("unclaimed");

      const builders = await loadBuilderRegistry(path.join(registryDir, "builders.json"));
      expect(builders).toHaveLength(1);
      expect(builders[0].verifiedGithub).toBe("ada-builder");
      expect(builders[0].status).toBe("verified");
    },
    30_000,
  );

  it(
    "revoke requires the claim to be verified",
    async () => {
      const draftId = await seedDraftClaim(claimStateRoot);
      const result = runCli([
        "revoke",
        draftId,
        "--note",
        "premature",
        "--dir",
        registryDir,
        "--claim-state-root",
        claimStateRoot,
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("verified");
      const claimFile = await readBuilderClaimStore(claimStateRoot);
      expect(claimFile.claims.find((entry) => entry.id === draftId)?.state).toBe("draft");
    },
    30_000,
  );

  it(
    "rejects an unknown subcommand with exit 1",
    async () => {
      const result = runCli(["bogus"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unknown subcommand");
    },
    30_000,
  );
});
