import { describe, expect, it } from "vitest";

import {
  buildCommanderXpConfirmatoryAnalysisEvidence,
  renderCommanderXpConfirmatoryAnalysisMarkdown,
  type CommanderXpVerifiedOutcome,
} from "../../src/server/agents/CommanderXpAnalysis";
import { sha256Canonical } from "../../src/server/agents/CommanderXpProtocol";

const preregistration = {
  experimentID: "commander-xp-analysis-test",
  preRegistrationSha256: "1".repeat(64),
  analysis: {
    analysisID: "strategic-commander-xp-b-vs-c-paired-v3",
    population: "48-complete-preregistered-bc-pairs",
    alternative: "C-superior-to-B",
    alpha: 0.05,
    confidenceLevel: 0.95,
    missingnessPolicy: "no-missing-pairs",
    primaryEndpoint: "subject-win",
    scoreRole: "redundant-descriptive-only",
    multiplicityPolicy: "single-primary-no-adjustment",
    minimumWinRateEffectCMinusB: 0.1,
    winMethod: "exact-two-sided-mcnemar",
    intervalMethod: "seeded-paired-bootstrap-percentile",
    resamplingSeed: "strategic-commander-xp-b-vs-c-analysis-v3",
    bootstrapIterations: 4096,
    decisionRule:
      "all-48-complete-and-integrity-green-and-win-estimate-gt-minimum-and-p-lte-alpha-and-ci-lower-gt-minimum",
    canaryClaimGate: "never",
    performanceClaimGate: "external-seal-independent-review-required",
  },
} as const;

function outcomes(): CommanderXpVerifiedOutcome[] {
  return Array.from({ length: 48 }, (_unused, replicaIndex) =>
    (["B", "C"] as const).map((arm) => {
      const subjectWon =
        arm === "B" ? replicaIndex % 4 === 0 : replicaIndex % 3 === 0;
      const subjectSeat = replicaIndex % 4;
      return {
        replicaIndex,
        arm,
        seed: 10_000 + replicaIndex,
        xpRequestID: `xreq_${arm}-${replicaIndex}`,
        episodeRequestID: `ereq_${arm}-${replicaIndex}`,
        jobID: `job_${arm}_${replicaIndex}`,
        episodeID: `episode_${arm}_${replicaIndex}`,
        subjectSeat,
        winnerSlot: subjectWon ? subjectSeat : (subjectSeat + 1) % 4,
        subjectWon,
        score: Number(subjectWon),
        selectorAudit: selectorAuditFixture(arm),
      };
    }),
  ).flat();
}

describe("Commander XP confirmatory analysis", () => {
  it("reuses the preregistered paired statistics deterministically", () => {
    const first = buildCommanderXpConfirmatoryAnalysisEvidence(
      preregistration,
      outcomes(),
    );
    const second = buildCommanderXpConfirmatoryAnalysisEvidence(
      preregistration,
      structuredClone(outcomes()).reverse(),
    );
    expect(second).toEqual(first);
    expect(first.completePairCount).toBe(48);
    expect(first.analysis).toMatchObject({
      status: "complete",
      completePairs: 48,
      missingPairs: 0,
    });
    expect(first.analysis.primaryResult.metric).toBe("win");
    expect(first.analysis.descriptiveScore).toMatchObject({
      metric: "score",
      role: "redundant-descriptive-only",
    });
    expect(first.analysis.superiorityDecision).toMatchObject({
      minimumWinRateEffectCMinusB: 0.1,
      performanceClaimAuthorized: false,
      claimReviewStatus: "external-seal-independent-review-required",
    });
    const { analysisSha256, ...body } = first;
    expect(analysisSha256).toBe(sha256Canonical(body));
    expect(renderCommanderXpConfirmatoryAnalysisMarkdown(first)).toContain(
      "Performance claim authorized: false",
    );
    expect(first.pairs[0]?.B.selectorAudit).toEqual(selectorAuditFixture("B"));
    expect(renderCommanderXpConfirmatoryAnalysisMarkdown(first)).toContain(
      '"selectedOptionDistribution":{"survive":48}',
    );
  });

  it("authorizes no local claim and makes only directional win superiority eligible", () => {
    const forced = (
      bWon: boolean,
      cWon: boolean,
      bScore: number,
      cScore: number,
    ) => {
      const rows = outcomes();
      for (const row of rows) {
        row.subjectWon = row.arm === "B" ? bWon : cWon;
        row.winnerSlot = row.subjectWon
          ? row.subjectSeat
          : (row.subjectSeat + 1) % 4;
        row.score = row.arm === "B" ? bScore : cScore;
      }
      return buildCommanderXpConfirmatoryAnalysisEvidence(preregistration, rows)
        .analysis;
    };

    const superior = forced(false, true, 0, 1);
    expect(superior.superiorityDecision).toMatchObject({
      estimateExceedsMinimum: true,
      pValueAtOrBelowAlpha: true,
      confidenceLowerBoundExceedsMinimum: true,
      ruleSatisfied: true,
      performanceClaimEligibleForExternalReview: true,
      performanceClaimAuthorized: false,
    });

    const subjectLossEvidence = buildCommanderXpConfirmatoryAnalysisEvidence(
      preregistration,
      outcomes().map((row) => ({
        ...row,
        subjectWon: row.arm === "C",
        winnerSlot:
          row.arm === "C" ? row.subjectSeat : (row.subjectSeat + 1) % 4,
        score: Number(row.arm === "C"),
      })),
    );
    expect(subjectLossEvidence.pairs.every((pair) => !pair.B.subjectWon)).toBe(
      true,
    );
    expect(
      subjectLossEvidence.analysis.superiorityDecision
        .performanceClaimEligibleForExternalReview,
    ).toBe(true);

    for (const analysis of [
      forced(false, false, 0, 0),
      forced(true, true, 1, 1),
      forced(true, false, 0, 1000),
    ]) {
      expect(analysis.superiorityDecision.ruleSatisfied).toBe(false);
      expect(
        analysis.superiorityDecision.performanceClaimEligibleForExternalReview,
      ).toBe(false);
      expect(analysis.superiorityDecision.performanceClaimAuthorized).toBe(
        false,
      );
    }
  });

  it("rejects a missing pair and duplicate arm outcome", () => {
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(
        preregistration,
        outcomes().slice(0, -1),
      ),
    ).toThrow(/outcomes are invalid/);
    const duplicated = outcomes();
    duplicated[1] = structuredClone(duplicated[0]!);
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(preregistration, duplicated),
    ).toThrow(/duplicated|incomplete|reused/);
  });

  it("rejects non-finite or identity-tampered outcome rows", () => {
    const nonFinite = outcomes();
    nonFinite[0]!.score = Number.NaN;
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(preregistration, nonFinite),
    ).toThrow(/outcomes are invalid/);
    const selectorTamper = outcomes();
    selectorTamper[0]!.selectorAudit.selectedOptionDistribution = {
      survive: 2,
    };
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(
        preregistration,
        selectorTamper,
      ),
    ).toThrow(/outcomes are invalid/);
    const identityTamper = outcomes();
    identityTamper[0]!.xpRequestID = "attacker";
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(
        preregistration,
        identityTamper,
      ),
    ).toThrow(/outcomes are invalid/);
  });
});

function selectorAuditFixture(arm: "B" | "C") {
  return {
    installedPlanCount: 1,
    selectedOptionDistribution: { survive: 1 },
    selectedOptionFamilyDistribution: { survive: 1 },
    deterministicPreferredAbsent: { count: 0, opportunities: 1 },
    selectorDisagreement: {
      count: 0,
      opportunities: arm === "C" ? 1 : 0,
    },
  };
}
