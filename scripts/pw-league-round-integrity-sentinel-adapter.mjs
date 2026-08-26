/**
 * Dependency-free bridge between the machine-local league sentinel and the
 * repository-owned round-integrity detector. The installed copy loads the
 * generated sibling `pw-league-round-integrity.mjs`; tests may inject the same
 * detector exports directly without reaching hosted Coworld.
 */

const DEFAULT_ROUND_LIMIT = "10";
const DEFAULT_EPISODE_LIMIT = "100";

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record && Array.isArray(record.entries)) return record.entries;
  if (record && Array.isArray(record.divisions)) return record.divisions;
  if (record && Array.isArray(record.episodes)) return record.episodes;
  if (record && Array.isArray(record.rounds)) return record.rounds;
  return [];
}

function finiteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pickCompetitionDivision(value) {
  const divisions = asArray(value)
    .map((entry) => {
      const division = asRecord(entry);
      const id = nonemptyString(division?.id);
      if (id === null) return null;
      return {
        id,
        level: finiteNumber(division.level),
        memberCount: finiteNumber(division.member_count),
      };
    })
    .filter((division) => division !== null);
  if (divisions.length === 0) return null;
  const populated = divisions.filter((division) => division.memberCount > 0);
  const candidates = populated.length > 0 ? populated : divisions;
  candidates.sort(
    (left, right) =>
      right.level - left.level || right.memberCount - left.memberCount,
  );
  return candidates[0];
}

async function loadInstalledDetector() {
  return import(new URL("./pw-league-round-integrity.mjs", import.meta.url));
}

function summarizeEvaluation(evaluation) {
  if (evaluation.kind === "assessed") {
    return { kind: evaluation.kind, assessment: evaluation.assessment };
  }
  return { ...evaluation };
}

async function readLatestRoundAssessment({
  coworld,
  detector,
  leagueId,
  roundsRaw,
}) {
  const currentRoundsRaw =
    roundsRaw ??
    (await coworld(["rounds", "-l", leagueId, "--limit", DEFAULT_ROUND_LIMIT]));
  const latestRound = detector.recentTerminalCompletedRounds(
    currentRoundsRaw,
    1,
  )[0];
  if (latestRound === undefined) {
    return {
      evaluation: { kind: "ignored", reason: "no_terminal_completed_round" },
      divisionId: null,
    };
  }

  const [leagueRaw, divisionsRaw] = await Promise.all([
    coworld(["leagues", leagueId]),
    coworld(["results", leagueId]),
  ]);
  const settings = detector.parseCoworldLadderIntegritySettings(leagueRaw);
  if (settings === null) {
    return {
      evaluation: {
        kind: "incomplete",
        reason: "league_integrity_settings_unreadable",
      },
      divisionId: null,
    };
  }
  const division = pickCompetitionDivision(divisionsRaw);
  if (division === null) {
    return {
      evaluation: {
        kind: "incomplete",
        reason: "competition_division_unreadable",
      },
      divisionId: null,
    };
  }
  const roundId = nonemptyString(asRecord(latestRound)?.id);
  if (roundId === null) {
    return {
      evaluation: {
        kind: "incomplete",
        reason: "latest_round_id_unreadable",
      },
      divisionId: division.id,
    };
  }
  const episodeRowsRaw = await coworld([
    "episodes",
    "-r",
    roundId,
    "--limit",
    DEFAULT_EPISODE_LIMIT,
  ]);
  const episodeRows = detector.episodeRowsByRoundId(episodeRowsRaw);
  return {
    evaluation: detector.evaluateCoworldRoundIntegrity({
      round: latestRound,
      episodeRows: episodeRows.get(roundId) ?? [],
      settings,
    }),
    divisionId: division.id,
  };
}

/**
 * Returns a critical only after the same breached round/evidence hash survives
 * a second direct Coworld read at least 60 seconds later. Healthy, incomplete,
 * changed, and failed reads never become a failure count.
 */
export async function collectConfirmedCoworldRoundIntegrity({
  coworld,
  leagueId,
  initialRoundsRaw,
  detector: injectedDetector,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  confirmationMs,
}) {
  if (typeof coworld !== "function")
    throw new Error("coworld must be a function");
  if (typeof leagueId !== "string" || leagueId.length === 0) {
    throw new Error("leagueId must be a non-empty string");
  }
  const detector = injectedDetector ?? (await loadInstalledDetector());
  const minimumConfirmationMs =
    detector.COWORLD_ROUND_INTEGRITY_CONFIRMATION_MS;
  const requiredConfirmationMs = confirmationMs ?? minimumConfirmationMs;
  if (
    !Number.isFinite(requiredConfirmationMs) ||
    requiredConfirmationMs < minimumConfirmationMs
  ) {
    throw new Error(`confirmationMs must be at least ${minimumConfirmationMs}`);
  }

  const firstObservedAtMs = now();
  const first = await readLatestRoundAssessment({
    coworld,
    detector,
    leagueId,
    roundsRaw: initialRoundsRaw,
  });
  const firstEvidence = summarizeEvaluation(first.evaluation);
  if (
    first.evaluation.kind !== "assessed" ||
    first.evaluation.assessment.verdict !== "breach"
  ) {
    return {
      status:
        first.evaluation.kind === "assessed" ? "healthy" : "indeterminate",
      signal: null,
      evidence: {
        confirmationMs: requiredConfirmationMs,
        observedForMs: 0,
        divisionId: first.divisionId,
        first: firstEvidence,
        second: null,
      },
    };
  }

  await sleep(requiredConfirmationMs);
  const secondObservedAtMs = now();
  const second = await readLatestRoundAssessment({
    coworld,
    detector,
    leagueId,
    roundsRaw: undefined,
  });
  const secondEvidence = summarizeEvaluation(second.evaluation);
  const observedForMs = Math.max(0, secondObservedAtMs - firstObservedAtMs);
  const sameEvidence =
    second.evaluation.kind === "assessed" &&
    second.evaluation.assessment.verdict === "breach" &&
    second.evaluation.assessment.roundId ===
      first.evaluation.assessment.roundId &&
    second.evaluation.assessment.evidenceHash ===
      first.evaluation.assessment.evidenceHash;
  const confirmed = sameEvidence && observedForMs >= requiredConfirmationMs;
  return {
    status: confirmed ? "confirmed_breach" : "confirmation_lost",
    signal: confirmed
      ? detector.coworldRoundIntegrityCriticalSignal(
          second.evaluation.assessment,
        )
      : null,
    evidence: {
      confirmationMs: requiredConfirmationMs,
      observedForMs,
      divisionId: second.divisionId ?? first.divisionId,
      first: firstEvidence,
      second: secondEvidence,
    },
  };
}
