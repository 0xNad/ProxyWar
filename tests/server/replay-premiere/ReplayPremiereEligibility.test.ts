import { describe, expect, test } from "vitest";
import {
  isProxyWarPublicLeaguePath,
  proxyWarPublicRunArtifacts,
} from "../../../src/server/agents/ProxyWarPublicArtifacts";
import {
  assessPremiereEligibility,
  computeEligibilityRecordCommitment,
  createHashedPremiereEligibility,
} from "../../../src/server/replay-premiere/ReplayPremiereEligibility";
import { toPublicReplayPremiereFailure } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  eligibilityFixture,
  eligibilityOptions,
} from "./ReplayPremiereFixtures";

describe("ReplayPremiereEligibility", () => {
  test("requires exact observations and creates a nonce-bound commitment", () => {
    const record = eligibilityFixture();
    const firstNonce = Buffer.alloc(32, 1);
    const secondNonce = Buffer.alloc(32, 2);
    const assessment = assessPremiereEligibility(
      record,
      eligibilityOptions(firstNonce),
    );

    expect(assessment.eligible).toBe(true);
    expect(assessment.leakAudit.status).toBe("passed");
    expect(assessment.eligibilityRecordHash).toBe(
      computeEligibilityRecordCommitment(record, firstNonce),
    );
    expect(computeEligibilityRecordCommitment(record, secondNonce)).not.toBe(
      assessment.eligibilityRecordHash,
    );
    expect(
      createHashedPremiereEligibility(record, eligibilityOptions(firstNonce)),
    ).toMatchObject({
      eligibilityRecordHash: assessment.eligibilityRecordHash,
    });
  });

  test("recomputes exposure instead of trusting a fabricated pass bit", () => {
    const record = eligibilityFixture();
    const protectedObservation = record.proxyWarLeakChecks.find(
      (check) => check.checkId === "game-record-route",
    );
    expect(protectedObservation).toBeDefined();
    protectedObservation!.observedHttpStatus = 200;
    (protectedObservation as unknown as { passed: boolean }).passed = true;

    const assessment = assessPremiereEligibility(record, eligibilityOptions());

    expect(assessment.eligible).toBe(false);
    expect(assessment.operatorFailureCodes).toContain(
      "leak_check_exposed_status",
    );
  });

  test("fails a missing exact target and forbidden content in a public body", () => {
    const record = eligibilityFixture();
    record.proxyWarLeakChecks = record.proxyWarLeakChecks.filter(
      (check) => check.checkId !== "decision-tail-route",
    );
    const league = record.proxyWarLeakChecks.find(
      (check) => check.checkId === "league-page",
    )!;
    league.observedBodyText = `winner ${record.sourceRunId}`;
    league.observedContentHash = sha256Hex(league.observedBodyText);

    const assessment = assessPremiereEligibility(record, eligibilityOptions());

    expect(assessment.eligible).toBe(false);
    expect(assessment.operatorFailureCodes).toEqual(
      expect.arrayContaining([
        "missing_leak_check_observation",
        "leak_check_forbidden_body_content",
      ]),
    );
  });

  test("rejects short commitment nonces and sanitizes operator details", () => {
    const record = eligibilityFixture();
    let thrown: unknown;
    try {
      assessPremiereEligibility(record, eligibilityOptions(Buffer.alloc(15)));
    } catch (error) {
      thrown = error;
    }
    expect(toPublicReplayPremiereFailure(thrown)).toEqual({
      error: { code: "PREMIERE_INVALID_REQUEST" },
    });
    expect(JSON.stringify(toPublicReplayPremiereFailure(thrown))).not.toContain(
      record.sourceRunId,
    );
  });

  test("covers every exact public run artifact across direct, alias, and cache keys", () => {
    const manifest = eligibilityFixture().proxyWarLeakAuditManifest;
    const targets = new Set(manifest.targets.map((target) => target.target));
    for (const artifact of proxyWarPublicRunArtifacts) {
      expect(targets).toContain(
        `https://beta.proxywar.xyz/ai-league-runs/controlled-run-001/${artifact}`,
      );
      expect(targets).toContain(
        `https://beta.proxywar.xyz/ai-league-runs/league-controlled-run-001/${artifact}`,
      );
      expect(
        manifest.targets.filter(
          (target) =>
            target.target.endsWith(`/${artifact}`) &&
            target.surface === "browser_or_cdn_cache",
        ).length,
      ).toBeGreaterThanOrEqual(2);
    }
    for (const checkId of ["league-data", "battle-card-data"]) {
      const target = manifest.targets.find(
        (entry) => entry.checkId === checkId,
      )!;
      expect(isProxyWarPublicLeaguePath(new URL(target.target).pathname)).toBe(
        true,
      );
    }
  });

  test("fingerprint-scans soft-error bodies, headers, and structured league data", () => {
    const record = eligibilityFixture();
    const soft404 = record.proxyWarLeakChecks.find(
      (check) => check.checkId === "game-record-route",
    )!;
    soft404.observedBodyText = `missing ${record.sourceRunId}`;
    soft404.observedContentHash = sha256Hex(soft404.observedBodyText);
    const structured = record.proxyWarLeakChecks.find(
      (check) => check.checkId === "league-data",
    )!;
    structured.observedBodyText = JSON.stringify({
      matches: [{ sourceRunId: record.sourceRunId, winner: "SEAT0001" }],
    });
    structured.observedContentHash = sha256Hex(structured.observedBodyText);
    const header = record.proxyWarLeakChecks.find(
      (check) => check.checkId === "social-metadata-route",
    )!;
    header.observedHeaders.cacheControl = `private-${record.sourceReplaySha256}`;

    const assessment = assessPremiereEligibility(record, eligibilityOptions());
    expect(assessment.eligible).toBe(false);
    expect(assessment.operatorFailureCodes).toEqual(
      expect.arrayContaining([
        "leak_check_forbidden_response_fingerprint",
        "leak_check_structured_source_entry_present",
      ]),
    );
  });
});
