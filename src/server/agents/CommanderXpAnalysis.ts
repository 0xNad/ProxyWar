import {
  computeCommanderXpConfirmatoryAnalysis,
  type CommanderXpConfirmatoryAnalysis,
} from "./CommanderArmReport";
import {
  sha256Canonical,
  type CommanderXpArm,
  type CommanderXpPreRegistrationV2,
} from "./CommanderXpProtocol";

export interface CommanderXpVerifiedOutcome {
  replicaIndex: number;
  arm: CommanderXpArm;
  seed: number;
  xpRequestID: string;
  episodeRequestID: string;
  jobID: string;
  episodeID: string;
  subjectSeat: number;
  winnerSlot: number;
  subjectWon: boolean;
  score: number;
  selectorAudit: CommanderXpSelectorAudit;
}

export interface CommanderXpSelectorAudit {
  installedPlanCount: number;
  selectedOptionDistribution: Record<string, number>;
  selectedOptionFamilyDistribution: Record<string, number>;
  deterministicPreferredAbsent: {
    count: number;
    opportunities: number;
  };
  selectorDisagreement: {
    count: number;
    opportunities: number;
  };
}

interface CommanderXpAnalysisPairArm {
  xpRequestID: string;
  episodeRequestID: string;
  jobID: string;
  episodeID: string;
  subjectSeat: number;
  winnerSlot: number;
  subjectWon: boolean;
  score: number;
  selectorAudit: CommanderXpSelectorAudit;
}

export interface CommanderXpAnalysisPair {
  replicaIndex: number;
  seed: number;
  B: CommanderXpAnalysisPairArm;
  C: CommanderXpAnalysisPairArm;
}

export interface CommanderXpConfirmatoryAnalysisEvidence {
  schemaVersion: 2;
  authority: "commander-xp-preregistered-paired-analysis-v1";
  experimentID: string;
  preRegistrationSha256: string;
  completePairCount: 48;
  pairs: CommanderXpAnalysisPair[];
  analysis: CommanderXpConfirmatoryAnalysis;
  analysisSha256: string;
}

export function buildCommanderXpConfirmatoryAnalysisEvidence(
  preregistration: Pick<
    CommanderXpPreRegistrationV2,
    "experimentID" | "preRegistrationSha256" | "analysis"
  >,
  outcomes: readonly CommanderXpVerifiedOutcome[],
): CommanderXpConfirmatoryAnalysisEvidence {
  if (
    outcomes.length !== 96 ||
    outcomes.some(
      (outcome) =>
        !["B", "C"].includes(outcome.arm) ||
        !Number.isInteger(outcome.replicaIndex) ||
        outcome.replicaIndex < 0 ||
        outcome.replicaIndex >= 48 ||
        !Number.isInteger(outcome.seed) ||
        outcome.seed < 0 ||
        !/^xreq_[A-Za-z0-9-]+$/.test(outcome.xpRequestID) ||
        !/^ereq_[A-Za-z0-9-]+$/.test(outcome.episodeRequestID) ||
        outcome.jobID.trim() === "" ||
        outcome.episodeID.trim() === "" ||
        !Number.isInteger(outcome.subjectSeat) ||
        outcome.subjectSeat < 0 ||
        outcome.subjectSeat > 3 ||
        !Number.isInteger(outcome.winnerSlot) ||
        outcome.winnerSlot < 0 ||
        outcome.winnerSlot > 3 ||
        outcome.subjectWon !== (outcome.subjectSeat === outcome.winnerSlot) ||
        !Number.isFinite(outcome.score) ||
        !isCommanderXpSelectorAudit(outcome.selectorAudit),
    )
  ) {
    throw new Error("Commander XP confirmatory outcomes are invalid");
  }
  for (const identity of [
    outcomes.map((outcome) => outcome.xpRequestID),
    outcomes.map((outcome) => outcome.episodeRequestID),
    outcomes.map((outcome) => outcome.jobID),
    outcomes.map((outcome) => outcome.episodeID),
  ]) {
    if (new Set(identity).size !== outcomes.length) {
      throw new Error("Commander XP confirmatory outcome identity is reused");
    }
  }
  const byPair = new Map<
    number,
    Partial<Record<"B" | "C", CommanderXpVerifiedOutcome>>
  >();
  for (const outcome of outcomes) {
    const pair = byPair.get(outcome.replicaIndex) ?? {};
    if (pair[outcome.arm as "B" | "C"] !== undefined) {
      throw new Error("Commander XP confirmatory outcome is duplicated");
    }
    pair[outcome.arm as "B" | "C"] = outcome;
    byPair.set(outcome.replicaIndex, pair);
  }
  const project = (
    outcome: CommanderXpVerifiedOutcome,
  ): CommanderXpAnalysisPairArm => ({
    xpRequestID: outcome.xpRequestID,
    episodeRequestID: outcome.episodeRequestID,
    jobID: outcome.jobID,
    episodeID: outcome.episodeID,
    subjectSeat: outcome.subjectSeat,
    winnerSlot: outcome.winnerSlot,
    subjectWon: outcome.subjectWon,
    score: outcome.score,
    selectorAudit: outcome.selectorAudit,
  });
  const pairs = Array.from({ length: 48 }, (_unused, replicaIndex) => {
    const pair = byPair.get(replicaIndex);
    const B = pair?.B;
    const C = pair?.C;
    if (B === undefined || C === undefined || B.seed !== C.seed) {
      throw new Error("Commander XP confirmatory pair is incomplete");
    }
    return {
      replicaIndex,
      seed: B.seed,
      B: project(B),
      C: project(C),
    };
  });
  if (new Set(pairs.map((pair) => pair.seed)).size !== pairs.length) {
    throw new Error("Commander XP confirmatory pair seed is reused");
  }
  const analysis = computeCommanderXpConfirmatoryAnalysis(
    preregistration.analysis,
    pairs.map((pair) => ({
      replicaIndex: pair.replicaIndex,
      seed: pair.seed,
      B: { won: pair.B.subjectWon, score: pair.B.score },
      C: { won: pair.C.subjectWon, score: pair.C.score },
    })),
  );
  const body = {
    schemaVersion: 2 as const,
    authority: "commander-xp-preregistered-paired-analysis-v1" as const,
    experimentID: preregistration.experimentID,
    preRegistrationSha256: preregistration.preRegistrationSha256,
    completePairCount: 48 as const,
    pairs,
    analysis,
  };
  return { ...body, analysisSha256: sha256Canonical(body) };
}

function isCommanderXpSelectorAudit(
  value: unknown,
): value is CommanderXpSelectorAudit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    [
      "deterministicPreferredAbsent",
      "installedPlanCount",
      "selectedOptionDistribution",
      "selectedOptionFamilyDistribution",
      "selectorDisagreement",
    ].join(",")
  ) {
    return false;
  }
  const distribution = record.selectedOptionDistribution;
  const families = record.selectedOptionFamilyDistribution;
  const preferred = record.deterministicPreferredAbsent;
  const disagreement = record.selectorDisagreement;
  const exactCounter = (counter: unknown): counter is Record<string, number> =>
    counter !== null &&
    typeof counter === "object" &&
    !Array.isArray(counter) &&
    Object.keys(counter).sort().join(",") === "count,opportunities" &&
    Object.values(counter).every(
      (entry) => Number.isInteger(entry) && Number(entry) >= 0,
    );
  const exactDistribution = (
    counter: unknown,
    keyPattern: RegExp,
  ): counter is Record<string, number> =>
    counter !== null &&
    typeof counter === "object" &&
    !Array.isArray(counter) &&
    Object.entries(counter).every(
      ([key, count]) =>
        keyPattern.test(key) && Number.isInteger(count) && Number(count) > 0,
    );
  if (
    !Number.isInteger(record.installedPlanCount) ||
    Number(record.installedPlanCount) < 0 ||
    !exactDistribution(
      distribution,
      /^(?:expand|develop_economy|survive|pressure_rival:[A-Za-z0-9_-]+)$/,
    ) ||
    !exactDistribution(
      families,
      /^(?:expand|develop_economy|pressure_rival|survive)$/,
    ) ||
    !exactCounter(preferred) ||
    !exactCounter(disagreement)
  ) {
    return false;
  }
  const installed = Number(record.installedPlanCount);
  return (
    Object.values(distribution).reduce((sum, count) => sum + count, 0) ===
      installed &&
    Object.values(families).reduce((sum, count) => sum + count, 0) ===
      installed &&
    preferred.count <= preferred.opportunities &&
    preferred.opportunities <= installed &&
    disagreement.count <= disagreement.opportunities &&
    disagreement.opportunities <= installed
  );
}

export function renderCommanderXpConfirmatoryAnalysisMarkdown(
  evidence: CommanderXpConfirmatoryAnalysisEvidence,
): string {
  const selectorAudit = Object.fromEntries(
    (["B", "C"] as const).map((arm) => {
      const rows = evidence.pairs.map((pair) => pair[arm].selectorAudit);
      const sumRecord = (
        key: "selectedOptionDistribution" | "selectedOptionFamilyDistribution",
      ): Record<string, number> => {
        const output: Record<string, number> = {};
        for (const row of rows) {
          for (const [name, count] of Object.entries(row[key])) {
            output[name] = (output[name] ?? 0) + count;
          }
        }
        return output;
      };
      return [
        arm,
        {
          installedPlanCount: rows.reduce(
            (total, row) => total + row.installedPlanCount,
            0,
          ),
          selectedOptionDistribution: sumRecord("selectedOptionDistribution"),
          selectedOptionFamilyDistribution: sumRecord(
            "selectedOptionFamilyDistribution",
          ),
          deterministicPreferredAbsent: {
            count: rows.reduce(
              (total, row) => total + row.deterministicPreferredAbsent.count,
              0,
            ),
            opportunities: rows.reduce(
              (total, row) =>
                total + row.deterministicPreferredAbsent.opportunities,
              0,
            ),
          },
          selectorDisagreement: {
            count: rows.reduce(
              (total, row) => total + row.selectorDisagreement.count,
              0,
            ),
            opportunities: rows.reduce(
              (total, row) => total + row.selectorDisagreement.opportunities,
              0,
            ),
          },
        },
      ];
    }),
  );
  const lines = [
    "# Commander XP confirmatory analysis",
    "",
    `- Experiment: ${evidence.experimentID}`,
    `- Complete preregistered B/C pairs: ${evidence.completePairCount}`,
    `- Analysis SHA-256: ${evidence.analysisSha256}`,
    "- Primary endpoint: subject win (score is redundant descriptive evidence only)",
    `- Minimum C minus B win-rate effect: ${evidence.analysis.specification.minimumWinRateEffectCMinusB}`,
    `- Superiority rule satisfied: ${String(evidence.analysis.superiorityDecision.ruleSatisfied)}`,
    `- Performance claim authorized: ${String(evidence.analysis.superiorityDecision.performanceClaimAuthorized)}`,
    `- Game-owned selector audit: ${JSON.stringify(selectorAudit)}`,
    "",
    "| Primary metric | C minus B estimate | 95% interval | p-value | Method |",
    "| --- | ---: | ---: | ---: | --- |",
    `| ${evidence.analysis.primaryResult.metric} | ${evidence.analysis.primaryResult.estimateCMinusB} | [${evidence.analysis.primaryResult.confidenceInterval95.lower}, ${evidence.analysis.primaryResult.confidenceInterval95.upper}] | ${evidence.analysis.primaryResult.pValue} | ${evidence.analysis.primaryResult.pValueMethod} |`,
    "",
    `Descriptive redundant score difference (C minus B): ${evidence.analysis.descriptiveScore.estimateCMinusB}. No score hypothesis or second performance claim is tested.`,
    "",
    "Canary evidence never authorizes a performance claim. Even a satisfied confirmatory superiority rule remains unauthorized until external sealing and independent review.",
    "",
  ];
  return lines.join("\n");
}
