import { describe, expect, it } from "vitest";
import {
  findNonceObservationMatches,
  reconcileNonceObservations,
} from "../../../src/server/identity/NonceObservationReconcile";
import { NONCE_AUTO_VERIFY_GATE_ENV } from "../../../src/server/identity/PolicyLabelNonceChallenge";
import {
  applySystemAutoVerify,
  issueChallenge,
  submitClaim,
  type BuilderClaimStoreFile,
} from "../../../src/server/platform/PlatformBuilderClaimStore";

const NOW = new Date("2026-08-01T00:00:00.000Z");

function claimInChallengeState(nonce?: string): BuilderClaimStoreFile {
  let file: BuilderClaimStoreFile = { schemaVersion: 1, claims: [] };
  file = submitClaim(
    file,
    {
      accountId: "acct_00000000000000000000000000000001",
      githubLogin: "ada-builder",
      agentId: "agt_daveey",
      claimedCoworldPlayerName: "daveey-proxywar",
      builderDisplayName: "Ada Builder",
      builderShortBio: null,
      builderLinks: [],
      teamMembers: [],
      evidenceNote: "evidence",
      evidenceLinks: [],
    },
    NOW,
  );
  const claimId = file.claims[0].id;
  file = issueChallenge(
    file,
    claimId,
    "acct_00000000000000000000000000000001",
    "Daveey's Agent",
    NOW,
  );
  return file;
}

describe("NonceObservationReconcile", () => {
  it("still finds a raw label match when the gate is off, but reports disabled — callers must check `enabled` before acting", () => {
    const file = claimInChallengeState();
    const nonce = file.claims[0].nonceChallenge?.nonce ?? "";
    const result = findNonceObservationMatches(
      file.claims,
      [`daveey-proxywar-${nonce}:v25`],
      {},
    );
    expect(result.enabled).toBe(false);
    expect(result.matches).toEqual([
      { claimId: file.claims[0].id, observedPolicyLabel: `daveey-proxywar-${nonce}:v25` },
    ]);
  });

  it("finds a match when the gate is on and a label carries the exact nonce", () => {
    const file = claimInChallengeState();
    const nonce = file.claims[0].nonceChallenge?.nonce ?? "";
    const result = findNonceObservationMatches(
      file.claims,
      [`daveey-proxywar-${nonce}:v25`],
      { [NONCE_AUTO_VERIFY_GATE_ENV]: "1" },
    );
    expect(result.enabled).toBe(true);
    expect(result.matches).toEqual([
      { claimId: file.claims[0].id, observedPolicyLabel: `daveey-proxywar-${nonce}:v25` },
    ]);
  });

  it("never matches an unrelated label with no nonce", () => {
    const file = claimInChallengeState();
    const result = findNonceObservationMatches(file.claims, ["someone-else:v3"], {
      [NONCE_AUTO_VERIFY_GATE_ENV]: "1",
    });
    expect(result.matches).toEqual([]);
  });

  describe("reconcileNonceObservations", () => {
    it("is a complete no-op with the gate off — file reference and claim state both unchanged", () => {
      const file = claimInChallengeState();
      const nonce = file.claims[0].nonceChallenge?.nonce ?? "";
      const { file: next, changed } = reconcileNonceObservations(
        file,
        [`daveey-proxywar-${nonce}:v25`],
        NOW,
        applySystemAutoVerify,
        {},
      );
      expect(changed).toBe(false);
      expect(next).toBe(file);
      expect(next.claims[0].state).toBe("challenge_issued");
    });

    it("auto-verifies a matched claim only when the gate is explicitly on", () => {
      const file = claimInChallengeState();
      const nonce = file.claims[0].nonceChallenge?.nonce ?? "";
      const { file: next, changed } = reconcileNonceObservations(
        file,
        [`daveey-proxywar-${nonce}:v25`],
        NOW,
        applySystemAutoVerify,
        { [NONCE_AUTO_VERIFY_GATE_ENV]: "1" },
      );
      expect(changed).toBe(true);
      expect(next.claims[0].state).toBe("verified");
      const lastAudit = next.claims[0].audit.at(-1);
      expect(lastAudit?.actor).toEqual({
        kind: "system",
        id: "nonce-observation-reconciler",
      });
      expect(lastAudit?.action).toBe("auto_verify_from_observation");
    });
  });
});
