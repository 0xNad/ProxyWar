import crypto from "node:crypto";

export const SOCIAL_MATRIX_PROFILES = [
  "keeper",
  "defector",
  "skeptic",
  "deal-blind",
];

export const SOCIAL_MATRIX_ARMS = ["off", "ignored", "active"];

const DEAL_KINDS = [
  "deal_propose",
  "deal_accept",
  "deal_reject",
  "deal_withdraw",
];

const OBLIGATION_STATUSES = [
  "pending",
  "fulfilled",
  "violated",
  "expired_unfulfilled",
  "unverified",
  "moot",
];

export function parseJsonLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function summarizeSocialRun(input) {
  const profilesByName = new Map(
    SOCIAL_MATRIX_PROFILES.map((profile) => [socialPlayerName(profile), profile]),
  );
  const byProfile = Object.fromEntries(
    SOCIAL_MATRIX_PROFILES.map((profile) => [profile, emptyProfileSummary()]),
  );

  for (const record of input.decisions) {
    const profile = profilesByName.get(record.username);
    if (profile === undefined) continue;
    const summary = byProfile[profile];
    summary.decisions += 1;
    if (record.result?.accepted === true) summary.acceptedDecisions += 1;
    if (record.fallbackUsed === true) summary.fallbackDecisions += 1;
    if (record.llmPlannerDegraded === true) summary.degradedDecisions += 1;
    const primaryKind = String(record.selectedActionKind ?? "unknown");
    summary.primarySelections[primaryKind] =
      (summary.primarySelections[primaryKind] ?? 0) + 1;

    for (const kind of DEAL_KINDS) {
      const offered = Array.isArray(record.legalActionIDsByKind?.[kind])
        ? record.legalActionIDsByKind[kind].length
        : 0;
      summary.dealOpportunities[kind].offeredActions += offered;
      if (offered > 0) summary.dealOpportunities[kind].decisionWindows += 1;
    }
    if (typeof record.dealAction === "string") {
      const kind = `deal_${record.dealAction}`;
      if (summary.dealSelections[kind] !== undefined) {
        summary.dealSelections[kind] += 1;
      }
    }
  }

  const ledger = input.ledger;
  if (ledger !== null) {
    for (const deal of Array.isArray(ledger.deals) ? ledger.deals : []) {
      for (const obligation of Array.isArray(deal.obligations)
        ? deal.obligations
        : []) {
        const profile = profilesByName.get(obligation.obligorName);
        if (profile === undefined) continue;
        const status = String(obligation.status ?? "unknown");
        if (byProfile[profile].obligations[status] === undefined) {
          byProfile[profile].obligations[status] = 0;
        }
        byProfile[profile].obligations[status] += 1;
      }
    }
  }

  for (const profile of SOCIAL_MATRIX_PROFILES) {
    const summary = byProfile[profile];
    const verifiedTerminal =
      summary.obligations.fulfilled +
      summary.obligations.violated +
      summary.obligations.expired_unfulfilled;
    summary.verifiedTerminalObligations = verifiedTerminal;
    summary.commitmentReliability =
      verifiedTerminal === 0
        ? null
        : summary.obligations.fulfilled / verifiedTerminal;
    const proposalWindows = summary.dealOpportunities.deal_propose.decisionWindows;
    summary.proposalSelectionRate =
      proposalWindows === 0
        ? null
        : summary.dealSelections.deal_propose / proposalWindows;
    const responseWindows = new Set();
    for (let index = 0; index < input.decisions.length; index += 1) {
      const record = input.decisions[index];
      if (profilesByName.get(record.username) !== profile) continue;
      if (
        (record.legalActionIDsByKind?.deal_accept?.length ?? 0) > 0 ||
        (record.legalActionIDsByKind?.deal_reject?.length ?? 0) > 0
      ) {
        responseWindows.add(index);
      }
    }
    const responses =
      summary.dealSelections.deal_accept + summary.dealSelections.deal_reject;
    summary.responseSelectionRate =
      responseWindows.size === 0 ? null : responses / responseWindows.size;
  }

  return {
    arm: input.arm,
    seed: input.seed,
    map: input.map,
    episodeIndex: input.episodeIndex,
    gameID: input.results.game_id,
    resultSeed: input.results.seed,
    winnerSlot: input.results.winner_slot,
    scores: input.results.scores,
    decisionCount: input.results.decision_count,
    acceptedDecisionCount: input.results.accepted_decision_count,
    fallbackCount: input.results.fallback_count,
    degradedCount: input.results.degraded_count,
    ledgerPresent: ledger !== null,
    ledgerFinalized:
      ledger !== null && Number.isInteger(ledger.finalizedAtStep),
    dealEventCounts: countDealEvents(ledger?.events),
    byProfile,
    nonInterferenceSignature: nonInterferenceSignature(
      input.decisions,
      input.results,
    ),
  };
}

export function matchedOffIgnoredChecks(runs) {
  const byCell = new Map();
  for (const run of runs) {
    if (run.arm !== "off" && run.arm !== "ignored") continue;
    const key = `${run.seed}|${run.map}|${run.episodeIndex}`;
    const cell = byCell.get(key) ?? {};
    cell[run.arm] = run;
    byCell.set(key, cell);
  }
  return [...byCell.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cell, pair]) => ({
      cell,
      complete: pair.off !== undefined && pair.ignored !== undefined,
      identical:
        pair.off !== undefined &&
        pair.ignored !== undefined &&
        pair.off.nonInterferenceSignature ===
          pair.ignored.nonInterferenceSignature,
      offSignature: pair.off?.nonInterferenceSignature ?? null,
      ignoredSignature: pair.ignored?.nonInterferenceSignature ?? null,
    }));
}

export function aggregateSocialMatrix(runs) {
  const byProfile = Object.fromEntries(
    SOCIAL_MATRIX_PROFILES.map((profile) => [
      profile,
      {
        activeRuns: 0,
        dealSelections: Object.fromEntries(DEAL_KINDS.map((kind) => [kind, 0])),
        dealOpportunityWindows: Object.fromEntries(
          DEAL_KINDS.map((kind) => [kind, 0]),
        ),
        obligations: Object.fromEntries(
          OBLIGATION_STATUSES.map((status) => [status, 0]),
        ),
        verifiedTerminalObligations: 0,
        commitmentReliability: null,
        fallbackDecisions: 0,
        degradedDecisions: 0,
      },
    ]),
  );

  for (const run of runs.filter((candidate) => candidate.arm === "active")) {
    for (const profile of SOCIAL_MATRIX_PROFILES) {
      const source = run.byProfile[profile];
      const target = byProfile[profile];
      target.activeRuns += 1;
      target.fallbackDecisions += source.fallbackDecisions;
      target.degradedDecisions += source.degradedDecisions;
      for (const kind of DEAL_KINDS) {
        target.dealSelections[kind] += source.dealSelections[kind];
        target.dealOpportunityWindows[kind] +=
          source.dealOpportunities[kind].decisionWindows;
      }
      for (const status of OBLIGATION_STATUSES) {
        target.obligations[status] += source.obligations[status];
      }
    }
  }

  for (const profile of SOCIAL_MATRIX_PROFILES) {
    const value = byProfile[profile];
    value.verifiedTerminalObligations =
      value.obligations.fulfilled +
      value.obligations.violated +
      value.obligations.expired_unfulfilled;
    value.commitmentReliability =
      value.verifiedTerminalObligations === 0
        ? null
        : value.obligations.fulfilled / value.verifiedTerminalObligations;
  }

  const nonInterference = matchedOffIgnoredChecks(runs);
  const aggregate = {
    schemaVersion: 1,
    runCount: runs.length,
    activeRunCount: runs.filter((run) => run.arm === "active").length,
    seeds: [...new Set(runs.map((run) => run.seed))].sort((a, b) => a - b),
    maps: [...new Set(runs.map((run) => run.map))].sort(),
    episodeIndices: [...new Set(runs.map((run) => run.episodeIndex))].sort(
      (a, b) => a - b,
    ),
    arms: [...new Set(runs.map((run) => run.arm))].sort(),
    nonInterference: {
      cells: nonInterference,
      completeCells: nonInterference.filter((cell) => cell.complete).length,
      identicalCells: nonInterference.filter((cell) => cell.identical).length,
      passed:
        nonInterference.length > 0 &&
        nonInterference.every((cell) => cell.complete && cell.identical),
    },
    byProfile,
  };
  aggregate.commitmentConstruct = evaluateCommitmentConstruct(runs, aggregate);
  return aggregate;
}

export function evaluateCommitmentConstruct(runs, aggregate) {
  if (aggregate === null || aggregate === undefined) {
    throw new Error("evaluateCommitmentConstruct requires a matrix aggregate");
  }
  const summary = aggregate;
  const activeRuns = runs.filter((run) => run.arm === "active");
  const heldOutRuns = activeRuns.filter((run) => run.seed !== 424242);
  const expectedRunCount =
    summary.seeds.length *
    summary.maps.length *
    summary.episodeIndices.length *
    summary.arms.length;
  const policies = Object.fromEntries(
    ["keeper", "defector"].map((profile) => {
      const heldOut = constructSlice(heldOutRuns, profile);
      const byMap = Object.fromEntries(
        summary.maps.map((map) => [
          map,
          constructSlice(
            heldOutRuns.filter((run) => run.map === map),
            profile,
          ),
        ]),
      );
      const byEpisodeIndex = Object.fromEntries(
        summary.episodeIndices.map((episodeIndex) => [
          episodeIndex,
          constructSlice(
            heldOutRuns.filter(
              (run) => run.episodeIndex === episodeIndex,
            ),
            profile,
          ),
        ]),
      );
      const threshold = profile === "keeper" ? 0.9 : 0.25;
      const reliabilityPass = (slice) =>
        slice.commitmentReliability !== null &&
        (profile === "keeper"
          ? slice.commitmentReliability >= threshold
          : slice.commitmentReliability <= threshold);
      const coveragePass =
        heldOut.runCount > 0 && heldOut.verifiedCoverageRate >= 0.75;
      return [
        profile,
        {
          threshold,
          heldOut,
          byMap,
          byEpisodeIndex,
          coveragePass,
          reliabilityPass: reliabilityPass(heldOut),
          mapBalancePass: Object.values(byMap).every(reliabilityPass),
          spawnRotationPass: Object.values(byEpisodeIndex).every(
            reliabilityPass,
          ),
        },
      ];
    }),
  );
  const completeMatrix = runs.length === expectedRunCount;
  const healthyRuns = runs.every(
    (run) =>
      run.fallbackCount === 0 &&
      run.degradedCount === 0 &&
      run.acceptedDecisionCount === run.decisionCount,
  );
  const provenanceComplete = runs.every(
    (run) => run.resultSeed === run.seed && typeof run.gameID === "string",
  );
  const abstentionNotRewarded = ["skeptic", "deal-blind"].every(
    (profile) => summary.byProfile[profile].commitmentReliability === null,
  );
  const passed =
    completeMatrix &&
    healthyRuns &&
    provenanceComplete &&
    summary.nonInterference.passed &&
    abstentionNotRewarded &&
    Object.values(policies).every(
      (policy) =>
        policy.coveragePass &&
        policy.reliabilityPass &&
        policy.mapBalancePass &&
        policy.spawnRotationPass,
    );
  return {
    status: passed ? "internally_validated_control_construct" : "not_validated",
    passed,
    developmentSeed: 424242,
    heldOutSeeds: summary.seeds.filter((seed) => seed !== 424242),
    expectedRunCount,
    completeMatrix,
    healthyRuns,
    provenanceComplete,
    nonInterferencePass: summary.nonInterference.passed,
    abstentionNotRewarded,
    policies,
    claimBoundary:
      "Distinguishes frozen commitment-control policies under matched internal conditions only; no general social-skill or LLM-trait claim.",
  };
}

export function socialPlayerName(profile) {
  return `Social ${profile}`;
}

function emptyProfileSummary() {
  return {
    decisions: 0,
    acceptedDecisions: 0,
    fallbackDecisions: 0,
    degradedDecisions: 0,
    primarySelections: {},
    dealOpportunities: Object.fromEntries(
      DEAL_KINDS.map((kind) => [
        kind,
        { decisionWindows: 0, offeredActions: 0 },
      ]),
    ),
    dealSelections: Object.fromEntries(DEAL_KINDS.map((kind) => [kind, 0])),
    obligations: Object.fromEntries(
      OBLIGATION_STATUSES.map((status) => [status, 0]),
    ),
    verifiedTerminalObligations: 0,
    commitmentReliability: null,
    proposalSelectionRate: null,
    responseSelectionRate: null,
  };
}

function countDealEvents(events) {
  const counts = {};
  for (const event of Array.isArray(events) ? events : []) {
    const kind = String(event.event ?? "unknown");
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function constructSlice(runs, profile) {
  const totals = {
    fulfilled: 0,
    violated: 0,
    expired_unfulfilled: 0,
  };
  let runsWithVerifiedTerminal = 0;
  for (const run of runs) {
    const value = run.byProfile[profile];
    totals.fulfilled += value.obligations.fulfilled;
    totals.violated += value.obligations.violated;
    totals.expired_unfulfilled += value.obligations.expired_unfulfilled;
    if (value.verifiedTerminalObligations > 0) {
      runsWithVerifiedTerminal += 1;
    }
  }
  const verifiedTerminalObligations =
    totals.fulfilled + totals.violated + totals.expired_unfulfilled;
  return {
    runCount: runs.length,
    runsWithVerifiedTerminal,
    verifiedCoverageRate:
      runs.length === 0 ? 0 : runsWithVerifiedTerminal / runs.length,
    obligations: totals,
    verifiedTerminalObligations,
    commitmentReliability:
      verifiedTerminalObligations === 0
        ? null
        : totals.fulfilled / verifiedTerminalObligations,
  };
}

function nonInterferenceSignature(decisions, results) {
  const normalized = {
    decisions: decisions.map((record) => ({
      username: record.username,
      turnNumber: record.turnNumber,
      selectedLegalActionId: record.selectedLegalActionId,
      selectedActionKind: record.selectedActionKind,
      accepted: record.result?.accepted === true,
      resultReason: record.result?.reason ?? null,
      submittedIntent: record.result?.submittedIntent ?? null,
      fallbackUsed: record.fallbackUsed === true,
      llmPlannerDegraded: record.llmPlannerDegraded === true,
    })),
    result: {
      game_id: results.game_id,
      seed: results.seed,
      scores: results.scores,
      winner_slot: results.winner_slot,
      turn_count: results.turn_count,
      tick: results.tick,
      decision_count: results.decision_count,
      accepted_decision_count: results.accepted_decision_count,
      fallback_count: results.fallback_count,
      degraded_count: results.degraded_count,
      players: results.players,
    },
  };
  return sha256(JSON.stringify(normalized));
}
