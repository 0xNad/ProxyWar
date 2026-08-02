import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidClaimOnTerminalClaimError,
  applyOperatorAction,
  findClaimById,
  findVerifiedBuilderAccountIds,
  findVerifiedClaimForAgent,
  issueChallenge,
  markProofPending,
  mutateBuilderClaimStore,
  readBuilderClaimStore,
  submitClaim,
  withdrawClaim,
  type BuilderClaimStoreFile,
  type BuilderClaimSubmission,
} from "../../../src/server/platform/PlatformBuilderClaimStore";

const NOW = new Date("2026-08-01T00:00:00.000Z");

function baseSubmission(overrides: Partial<BuilderClaimSubmission> = {}): BuilderClaimSubmission {
  return {
    accountId: "acct_00000000000000000000000000000001",
    githubLogin: "ada-builder",
    agentId: "agt_daveey",
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

describe("PlatformBuilderClaimStore", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "builder-claim-store-"));
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("cold-starts to an empty, schema-valid store", async () => {
    const file = await readBuilderClaimStore(stateRoot);
    expect(file).toEqual({ schemaVersion: 1, claims: [] });
  });

  it("submitClaim creates a draft with one audit row and sanitized fields", () => {
    const file = submitClaim(
      { schemaVersion: 1, claims: [] },
      baseSubmission({ builderDisplayName: "  Ada   Builder  " }),
      NOW,
    );
    expect(file.claims).toHaveLength(1);
    const claim = file.claims[0];
    expect(claim.state).toBe("draft");
    expect(claim.builderProfileDraft.displayName).toBe("Ada Builder");
    expect(claim.audit).toHaveLength(1);
    expect(claim.audit[0].action).toBe("submit");
    expect(claim.audit[0].actor).toEqual({
      kind: "claimant",
      id: baseSubmission().accountId,
    });
  });

  it("round-trips through the file store atomically via mutateBuilderClaimStore", async () => {
    const written = await mutateBuilderClaimStore(stateRoot, (file) =>
      submitClaim(file, baseSubmission(), NOW),
    );
    expect(written.claims).toHaveLength(1);
    const reread = await readBuilderClaimStore(stateRoot);
    expect(reread).toEqual(written);
  });

  it("walks draft -> proof_pending -> verified via the operator path and appends audit rows in order", () => {
    let file: BuilderClaimStoreFile = { schemaVersion: 1, claims: [] };
    file = submitClaim(file, baseSubmission(), NOW);
    const claimId = file.claims[0].id;

    file = applyOperatorAction(
      file,
      claimId,
      "mark_proof_pending",
      "operator-jane",
      "evidence looks credible",
      new Date("2026-08-01T01:00:00.000Z"),
    );
    expect(findClaimById(file, claimId)?.state).toBe("proof_pending");

    file = applyOperatorAction(
      file,
      claimId,
      "approve",
      "operator-jane",
      "verified via evidence review",
      new Date("2026-08-01T02:00:00.000Z"),
    );
    const claim = findClaimById(file, claimId);
    expect(claim?.state).toBe("verified");
    expect(claim?.audit.map((row) => row.action)).toEqual([
      "submit",
      "mark_proof_pending",
      "approve",
    ]);
    expect(findVerifiedClaimForAgent(file, "agt_daveey")?.id).toBe(claimId);
    expect(findVerifiedBuilderAccountIds(file).has(baseSubmission().accountId)).toBe(
      true,
    );
  });

  it("issueChallenge mints a nonce and instructions, walking draft -> challenge_issued", () => {
    let file: BuilderClaimStoreFile = { schemaVersion: 1, claims: [] };
    file = submitClaim(file, baseSubmission(), NOW);
    const claimId = file.claims[0].id;
    file = issueChallenge(
      file,
      claimId,
      baseSubmission().accountId,
      "Daveey's Agent",
      NOW,
    );
    const claim = findClaimById(file, claimId);
    expect(claim?.state).toBe("challenge_issued");
    expect(claim?.nonceChallenge?.nonce).toMatch(/^pwn-[a-f0-9]{12}$/);
    expect(claim?.nonceChallenge?.instructions).toContain(
      claim?.nonceChallenge?.nonce ?? "",
    );
  });

  it("markProofPending appends a new evidence entry without discarding the first", () => {
    let file: BuilderClaimStoreFile = { schemaVersion: 1, claims: [] };
    file = submitClaim(file, baseSubmission(), NOW);
    const claimId = file.claims[0].id;
    file = markProofPending(
      file,
      claimId,
      baseSubmission().accountId,
      "Submitted the nonce policy.",
      ["https://example.com/proof"],
      NOW,
    );
    const claim = findClaimById(file, claimId);
    expect(claim?.state).toBe("proof_pending");
    expect(claim?.evidence).toHaveLength(2);
  });

  it("withdrawClaim moves a non-terminal claim to rejected with a distinct audit note", () => {
    let file: BuilderClaimStoreFile = { schemaVersion: 1, claims: [] };
    file = submitClaim(file, baseSubmission(), NOW);
    const claimId = file.claims[0].id;
    file = withdrawClaim(file, claimId, baseSubmission().accountId, NOW);
    const claim = findClaimById(file, claimId);
    expect(claim?.state).toBe("rejected");
    expect(claim?.audit.at(-1)?.action).toBe("withdraw");
    expect(claim?.audit.at(-1)?.note).toBe("withdrawn by claimant");
  });

  it("refuses any further transition once a claim is terminal", () => {
    let file: BuilderClaimStoreFile = { schemaVersion: 1, claims: [] };
    file = submitClaim(file, baseSubmission(), NOW);
    const claimId = file.claims[0].id;
    file = withdrawClaim(file, claimId, baseSubmission().accountId, NOW);
    expect(() =>
      applyOperatorAction(file, claimId, "approve", "operator-jane", null, NOW),
    ).toThrow(InvalidClaimOnTerminalClaimError);
  });

  it("never lets a claimant act on a claim owned by a different account", () => {
    let file: BuilderClaimStoreFile = { schemaVersion: 1, claims: [] };
    file = submitClaim(file, baseSubmission(), NOW);
    const claimId = file.claims[0].id;
    expect(() =>
      withdrawClaim(file, claimId, "acct_ffffffffffffffffffffffffffffffff", NOW),
    ).toThrow();
  });
});
