import { AgentOpponentModelEntry } from "./AgentTypes";

/**
 * Theory-of-mind accuracy scorer.
 *
 * Scores the opponent-model `predictedNextAction` (the deterministic prior we feed the LLM
 * agent) against each rival's ACTUAL next-snapshot behavior. Purpose: tell the FORGE loop
 * whether the prior is accurate enough to be worth showing the LLM — an inaccurate prior
 * could actively mislead it.
 *
 * IMPORTANT (honest scope): this measures the HEURISTIC prior, NOT the LLM's own theory of
 * mind. Measuring the LLM's own ToM would require the LLM to emit its own predictions, which
 * is an LLM-track change. This scorer is deterministic and free.
 *
 * Input: the ordered per-decision opponent-model arrays from ONE game (snapshot[t] is the
 * `observation.opponentModel` at decision t). A rival is matched across consecutive snapshots
 * by `playerID`; predictions about a rival missing from the next snapshot (e.g. eliminated)
 * are unverifiable and skipped.
 */

export interface ToMPredictionOutcome {
  playerID: string;
  prediction: string;
  /** Whether this prediction kind can be checked against the next snapshot. */
  verifiable: boolean;
  /** true/false when verifiable; null when not verifiable. */
  correct: boolean | null;
}

export interface ToMTypeBreakdown {
  verifiable: number;
  correct: number;
  accuracy: number;
}

export interface ToMAccuracyReport {
  totalPredictions: number;
  verifiablePredictions: number;
  correct: number;
  /** correct / verifiablePredictions, or 0 when there is nothing verifiable. */
  accuracy: number;
  /** Per-prediction-kind breakdown. */
  byType: Record<string, ToMTypeBreakdown>;
  outcomes: ToMPredictionOutcome[];
}

/** Territory-share change below this counts as "no real change". */
const TILESHARE_EPS = 0.002;

/**
 * Verify a single rival's prediction at snapshot t against its state at snapshot t+1.
 * Returns null when the prediction kind is not verifiable from the snapshots.
 */
function verifyPrediction(
  cur: AgentOpponentModelEntry,
  next: AgentOpponentModelEntry,
): boolean | null {
  const grew = next.tileShare > cur.tileShare + TILESHARE_EPS;
  const shrank = next.tileShare < cur.tileShare - TILESHARE_EPS;
  const attackedMeAgain = next.attacksOnMe > cur.attacksOnMe;
  const allianceEnded = cur.isAllied && !next.isAllied;

  switch (cur.predictedNextAction) {
    case "expanding":
    case "snowballing_to_win":
      return grew;
    case "losing_ground":
      return shrank;
    case "may_attack_me":
    case "attacking_me":
      return attackedMeAgain;
    case "strong_ally_betrayal_risk":
      return next.betrayedMe || attackedMeAgain || allianceEnded;
    case "wants_alliance_with_me":
      return next.isAllied;
    case "alliance_expiring":
      return allianceEnded;
    case "stable":
      return !grew && !shrank && !attackedMeAgain;
    default:
      // Unknown / non-predictive label -> not scored.
      return null;
  }
}

export function scoreToMAccuracy(
  snapshots: AgentOpponentModelEntry[][],
): ToMAccuracyReport {
  const outcomes: ToMPredictionOutcome[] = [];
  for (let t = 0; t + 1 < snapshots.length; t++) {
    const nextByID = new Map<string, AgentOpponentModelEntry>();
    for (const entry of snapshots[t + 1] ?? []) {
      nextByID.set(entry.playerID, entry);
    }
    for (const cur of snapshots[t] ?? []) {
      const next = nextByID.get(cur.playerID);
      if (next === undefined) {
        // Rival not present next snapshot -> unverifiable.
        outcomes.push({
          playerID: cur.playerID,
          prediction: cur.predictedNextAction,
          verifiable: false,
          correct: null,
        });
        continue;
      }
      const result = verifyPrediction(cur, next);
      outcomes.push({
        playerID: cur.playerID,
        prediction: cur.predictedNextAction,
        verifiable: result !== null,
        correct: result,
      });
    }
  }

  const byType: Record<string, ToMTypeBreakdown> = {};
  let verifiablePredictions = 0;
  let correct = 0;
  for (const outcome of outcomes) {
    if (!outcome.verifiable || outcome.correct === null) {
      continue;
    }
    verifiablePredictions += 1;
    if (outcome.correct) {
      correct += 1;
    }
    const bucket = (byType[outcome.prediction] ??= {
      verifiable: 0,
      correct: 0,
      accuracy: 0,
    });
    bucket.verifiable += 1;
    if (outcome.correct) {
      bucket.correct += 1;
    }
  }
  for (const bucket of Object.values(byType)) {
    bucket.accuracy =
      bucket.verifiable > 0 ? bucket.correct / bucket.verifiable : 0;
  }

  return {
    totalPredictions: outcomes.length,
    verifiablePredictions,
    correct,
    accuracy:
      verifiablePredictions > 0 ? correct / verifiablePredictions : 0,
    byType,
    outcomes,
  };
}
