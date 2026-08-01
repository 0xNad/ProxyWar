/**
 * `npm run identity:claims -- <list|approve|reject|revoke> ...` — the
 * OPERATOR-run half of Season Zero Phase 3's REAL Builder/Agent identity
 * claim workflow (the claimant-facing half is `PlatformBuilderClaimHttp.ts`).
 *
 * This is the ONLY place that ever sets `BuilderClaimRecord.state` to
 * `"verified"` (via `approve`) outside the gated, still-off nonce
 * auto-verify path (see `PolicyLabelNonceChallenge.ts`), and the only
 * place that writes the tracked `resources/identity/{builders,agents}.json`
 * as a consequence of a claim — exactly the same "operator CLI writes
 * tracked files, reviews the diff, commits by hand" precedent
 * `identity-generate-emblems.ts` already established for tracked SVGs.
 * This CLI never commits or pushes; it only edits the working tree.
 *
 * Mirrors `identity-validate.ts`'s argv/output/exit-code conventions
 * (space-separated `--flag value` pairs, `console.log`/`console.error`,
 * `process.exitCode = 1` on failure, `main().catch(...)` at the bottom),
 * extended with subcommands since this CLI has four distinct actions
 * instead of one.
 */
import {
  applyOperatorAction,
  findClaimById,
  mutateBuilderClaimStore,
  readBuilderClaimStore,
  resolveBuilderClaimStateRoot,
  type BuilderClaimRecord,
} from "../server/platform/PlatformBuilderClaimStore";
import {
  defaultAgentRegistryPath,
  defaultBuilderRegistryPath,
  defaultIdentityRegistryDir,
  loadAgentRegistry,
  loadBuilderRegistry,
  saveAgentRegistry,
  saveBuilderRegistry,
} from "../server/identity/IdentityRegistry";
import { SlugSchema, type AgentProfile, type BuilderProfile } from "../server/identity/IdentitySchemas";
import { emitServerAnalyticsEvent } from "../server/analytics/AnalyticsServerEmit";
import { resolveDefaultArtifactsRoot } from "./premiere-candidates";

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function resolveOperatorId(): string {
  const raw = process.env.USER?.trim();
  return raw !== undefined && raw.length > 0 ? raw : "operator";
}

/** Same shape as `BuildRegistrationSubmission.ts`'s private `slugify` — lowercase, non-alphanumeric runs collapsed to one hyphen, leading/trailing hyphens trimmed, capped length. Kept as its own copy rather than exported/shared: two call sites, neither wants to take on the other's future divergence. */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function runList(argv: readonly string[], claimStateRoot: string): Promise<void> {
  const stateFilter = flagValue(argv, "--state");
  const file = await readBuilderClaimStore(claimStateRoot);
  const claims = stateFilter === undefined
    ? file.claims
    : file.claims.filter((claim) => claim.state === stateFilter);
  if (claims.length === 0) {
    console.log(
      `identity:claims list — no claims${stateFilter === undefined ? "" : ` in state "${stateFilter}"`}`,
    );
    return;
  }
  for (const claim of claims) {
    console.log(
      `${claim.id}  ${claim.state.padEnd(16)} agent=${claim.agentId} account=${claim.accountId} github=${claim.githubLogin} createdAt=${claim.createdAt}`,
    );
  }
}

/** Creates a fresh `BuilderProfile` from an approved claim's evidence — used only when no existing row matches by `verifiedGithub` or derived slug. */
function newBuilderFromClaim(claim: BuilderClaimRecord, slug: string): BuilderProfile {
  return {
    id: `bld_${slug}`,
    slug,
    displayName: claim.builderProfileDraft.displayName,
    shortBio: claim.builderProfileDraft.shortBio,
    avatarUrl: null,
    verifiedGithub: claim.githubLogin,
    links: [...claim.builderProfileDraft.links],
    teamMembers: [...claim.builderProfileDraft.teamMembers],
    softmaxPlayerIdentities: [],
    status: "verified",
  };
}

async function runApprove(
  claimId: string,
  argv: readonly string[],
  claimStateRoot: string,
  artifactsRootDir: string,
): Promise<void> {
  const note = flagValue(argv, "--note") ?? null;
  const dir = flagValue(argv, "--dir") ?? defaultIdentityRegistryDir;
  const operatorId = resolveOperatorId();
  const now = new Date();

  const before = await readBuilderClaimStore(claimStateRoot);
  const claim = findClaimById(before, claimId);
  if (claim === null) {
    console.error(`identity:claims approve — claim ${claimId} not found`);
    process.exitCode = 1;
    return;
  }
  if (claim.state !== "proof_pending") {
    console.error(
      `identity:claims approve — claim ${claimId} is in state "${claim.state}", must be "proof_pending" to approve`,
    );
    process.exitCode = 1;
    return;
  }

  const builderPath = defaultBuilderRegistryPath(dir);
  const agentPath = defaultAgentRegistryPath(dir);
  let builders: BuilderProfile[];
  let agents: AgentProfile[];
  try {
    builders = [...(await loadBuilderRegistry(builderPath))];
    agents = [...(await loadAgentRegistry(agentPath))];
  } catch (error) {
    console.error(`identity:claims approve — could not load registry: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const agentIndex = agents.findIndex((agent) => agent.id === claim.agentId);
  if (agentIndex === -1) {
    console.error(
      `identity:claims approve — agent ${claim.agentId} not found in registry at ${agentPath}`,
    );
    process.exitCode = 1;
    return;
  }

  // Everything above is a pure precondition check — nothing mutated yet.
  // Only now do we transition the claim, so a check failure above never
  // leaves the claim store and the registry disagreeing about approval.
  const updated = await mutateBuilderClaimStore(claimStateRoot, (file) =>
    applyOperatorAction(file, claimId, "approve", operatorId, note, now),
  );
  const approvedClaim = findClaimById(updated, claimId) as BuilderClaimRecord;
  if (approvedClaim.state === "verified") {
    await emitServerAnalyticsEvent(artifactsRootDir, "claim_verified", {
      claimId: approvedClaim.id,
      agentSlug: agents[agentIndex].slug,
    });
  }

  const slugCandidate = SlugSchema.safeParse(
    slugify(approvedClaim.builderProfileDraft.displayName),
  );
  const slug = slugCandidate.success ? slugCandidate.data : "unnamed-builder";

  const existingBuilderIndex = builders.findIndex(
    (builder) => builder.verifiedGithub === approvedClaim.githubLogin || builder.slug === slug,
  );
  const builder: BuilderProfile =
    existingBuilderIndex === -1
      ? newBuilderFromClaim(approvedClaim, slug)
      : {
          ...builders[existingBuilderIndex],
          displayName: approvedClaim.builderProfileDraft.displayName,
          shortBio: approvedClaim.builderProfileDraft.shortBio,
          links: [...approvedClaim.builderProfileDraft.links],
          teamMembers: [...approvedClaim.builderProfileDraft.teamMembers],
          verifiedGithub: approvedClaim.githubLogin,
          status: "verified",
        };
  builders =
    existingBuilderIndex === -1
      ? [...builders, builder]
      : builders.map((entry, index) => (index === existingBuilderIndex ? builder : entry));

  agents = agents.map((agent, index) =>
    index === agentIndex ? { ...agent, builderId: builder.id, status: "verified" } : agent,
  );

  await Promise.all([
    saveBuilderRegistry(builders, builderPath),
    saveAgentRegistry(agents, agentPath),
  ]);

  console.log(
    `identity:claims approve — approved ${approvedClaim.id}, builder ${builder.id}, agent ${approvedClaim.agentId} status verified — review and commit resources/identity/*.json`,
  );
}

async function runReject(
  claimId: string,
  argv: readonly string[],
  claimStateRoot: string,
): Promise<void> {
  const note = flagValue(argv, "--note");
  if (note === undefined) {
    console.error("identity:claims reject — --note <text> is required");
    process.exitCode = 1;
    return;
  }
  const operatorId = resolveOperatorId();
  try {
    const updated = await mutateBuilderClaimStore(claimStateRoot, (file) =>
      applyOperatorAction(file, claimId, "reject", operatorId, note, new Date()),
    );
    const claim = findClaimById(updated, claimId) as BuilderClaimRecord;
    console.log(`identity:claims reject — rejected ${claim.id}`);
  } catch (error) {
    console.error(`identity:claims reject — failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

async function runRevoke(
  claimId: string,
  argv: readonly string[],
  claimStateRoot: string,
): Promise<void> {
  const note = flagValue(argv, "--note");
  if (note === undefined) {
    console.error("identity:claims revoke — --note <text> is required");
    process.exitCode = 1;
    return;
  }
  const dir = flagValue(argv, "--dir") ?? defaultIdentityRegistryDir;
  const operatorId = resolveOperatorId();

  const before = await readBuilderClaimStore(claimStateRoot);
  const claim = findClaimById(before, claimId);
  if (claim === null) {
    console.error(`identity:claims revoke — claim ${claimId} not found`);
    process.exitCode = 1;
    return;
  }
  if (claim.state !== "verified") {
    console.error(
      `identity:claims revoke — claim ${claimId} is in state "${claim.state}", must be "verified" to revoke`,
    );
    process.exitCode = 1;
    return;
  }

  const agentPath = defaultAgentRegistryPath(dir);
  let agents: AgentProfile[];
  try {
    agents = [...(await loadAgentRegistry(agentPath))];
  } catch (error) {
    console.error(`identity:claims revoke — could not load registry: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const agentIndex = agents.findIndex((agent) => agent.id === claim.agentId);
  if (agentIndex === -1) {
    console.error(
      `identity:claims revoke — agent ${claim.agentId} not found in registry at ${agentPath}`,
    );
    process.exitCode = 1;
    return;
  }

  await mutateBuilderClaimStore(claimStateRoot, (file) =>
    applyOperatorAction(file, claimId, "revoke", operatorId, note, new Date()),
  );

  // The BuilderProfile row is deliberately left untouched — other Agents
  // may still reference the same Builder (a team that builds more than one
  // agent), so revoking one Agent's claim must never delete or unverify a
  // Builder row that other Agents still point at.
  agents = agents.map((agent, index) =>
    index === agentIndex ? { ...agent, builderId: null, status: "unclaimed" } : agent,
  );
  await saveAgentRegistry(agents, agentPath);

  console.log(
    `identity:claims revoke — revoked ${claimId}, agent ${claim.agentId} unlinked (status unclaimed) — review and commit resources/identity/agents.json`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  const claimStateRoot = flagValue(argv, "--claim-state-root") ?? resolveBuilderClaimStateRoot();

  if (subcommand === "list") {
    await runList(argv, claimStateRoot);
    return;
  }
  if (subcommand === "approve" || subcommand === "reject" || subcommand === "revoke") {
    const claimId = argv[1];
    if (claimId === undefined || claimId.startsWith("--")) {
      console.error(`identity:claims ${subcommand} — missing <claimId>`);
      process.exitCode = 1;
      return;
    }
    if (subcommand === "approve") {
      await runApprove(claimId, argv, claimStateRoot, resolveDefaultArtifactsRoot());
    } else if (subcommand === "reject") {
      await runReject(claimId, argv, claimStateRoot);
    } else {
      await runRevoke(claimId, argv, claimStateRoot);
    }
    return;
  }
  console.error(
    `identity:claims — unknown subcommand "${subcommand ?? ""}". Usage: identity:claims <list|approve|reject|revoke> [claimId] [--note <text>] [--dir <registryDir>] [--state <state>] [--claim-state-root <path>]`,
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
