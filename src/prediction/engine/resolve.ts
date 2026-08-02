/**
 * Market resolution — SPEC §3.
 *
 * Pure function of a fixture's ground truth plus the market/seat the player
 * chose. No ledger, no stake, no odds — just "did this pick come true".
 */
import type {
  Checkpoint,
  CheckpointIndex,
  Fixture,
  MarketKind,
  ResolutionState,
  SeatId,
} from "../types";
import { eligibleSeats } from "../types";

/**
 * SPEC §3: every market, including winner, is offered only for seats alive
 * at the checkpoint. Shared by the UI and the odds-fitting pipeline so both
 * apply the identical filter — do not duplicate this check ad hoc.
 */
export function isEligibleToStake(
  checkpoint: Checkpoint,
  seatId: SeatId,
): boolean {
  return eligibleSeats(checkpoint).some((s) => s.seatId === seatId);
}

/**
 * A seat is "alive at turn T" iff it has no elimination record, or its
 * elimination turn is strictly after T. An elimination recorded *at* turn T
 * means the seat reached zero territory during that turn, so it is not
 * counted as alive at T.
 */
function isAliveAtTurn(fixture: Fixture, seatId: SeatId, turn: number): boolean {
  const record = fixture.outcome.eliminationOrder.find(
    (e) => e.seatId === seatId,
  );
  return record === undefined || record.turn > turn;
}

/**
 * First seat among those alive *at the checkpoint* to be eliminated strictly
 * after the checkpoint's turn. Void if no such elimination occurs (the game
 * ends with all of them still standing, or eliminations among that set were
 * already spent before the checkpoint).
 */
function resolveNextElimination(
  fixture: Fixture,
  checkpoint: Checkpoint,
  seatId: SeatId,
): ResolutionState {
  const aliveAtCheckpoint = new Set(
    eligibleSeats(checkpoint).map((s) => s.seatId),
  );
  const next = fixture.outcome.eliminationOrder
    .filter(
      (e) => e.turn > checkpoint.turn && aliveAtCheckpoint.has(e.seatId),
    )
    .sort((a, b) => a.turn - b.turn)[0];

  if (next === undefined) return "void";
  return next.seatId === seatId ? "won" : "lost";
}

/** Strictly greater than checkpoint share; exact ties resolve "lost" per SPEC §3 market 4. */
function resolveGainsShare(
  fixture: Fixture,
  checkpointIndex: CheckpointIndex,
  checkpoint: Checkpoint,
  seatId: SeatId,
): ResolutionState {
  const shareAtCheckpointBp =
    checkpoint.seats.find((s) => s.seatId === seatId)?.shareBp ?? 0;
  const shareAtResolutionBp =
    fixture.outcome.shareAtResolution[checkpointIndex]?.[seatId] ?? 0;
  return shareAtResolutionBp > shareAtCheckpointBp ? "won" : "lost";
}

export function resolveMarket(
  fixture: Fixture,
  checkpointIndex: CheckpointIndex,
  kind: MarketKind,
  seatId: SeatId,
): ResolutionState {
  const checkpoint = fixture.checkpoints[checkpointIndex];
  switch (kind) {
    case "winner":
      return fixture.outcome.winnerSeatId === seatId ? "won" : "lost";
    case "survives":
      return isAliveAtTurn(fixture, seatId, checkpoint.resolutionTurn)
        ? "won"
        : "lost";
    case "next_elimination":
      return resolveNextElimination(fixture, checkpoint, seatId);
    case "gains_share":
      return resolveGainsShare(fixture, checkpointIndex, checkpoint, seatId);
  }
}
