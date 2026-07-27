/**
 * Wires `SyntheticCrowdSimulator` into a LIVE running premiere.
 *
 * Unlike the rest of `wagering/simulation/**`, this file is NOT domain-
 * agnostic: it is the one place in the crowd stack allowed to interpret
 * match data, because it is the integration glue between the pure
 * simulator and the real, running server. `SyntheticCrowdSimulator` itself
 * still never sees anything but the plain `SyntheticCrowdSignalSnapshot`
 * this driver hands it once per poll — the structural leak-prevention
 * guarantee is unchanged, just satisfied one layer further out.
 *
 * Signal source is `ReplayPremiereRuntimeCoordinator.readLiveProjection` —
 * the exact same server-authoritative, presentation-clock-gated tap real
 * viewer clients poll (`ReplayPremiereNetwork.ts`'s `applyLiveProjection`)
 * — and NOTHING else. A record's `payload` is a raw core `Turn`
 * (`{turnNumber, intents}`); outcome-bearing fields (winner, final
 * standings, stats, ...) are stripped at import time
 * (`ReplayPremiereImport.ts`'s `assertNoOutcomeBearingReplayFields`), so
 * there is nothing here to leak even in principle. The signal is per-seat
 * intent-activity density, decayed across polls: for controlled-source
 * premieres `seatId === clientID` exactly (verified in
 * `ReplayPremierePublication.ts`'s `validateControlledSourceSeats`, which
 * looks a seat's clientID up by its own `seatId`), so every intent in a
 * turn attributes unambiguously to a seat with no extra mapping. This is a
 * coarse proxy for "who is currently doing the most" — not true territory
 * share, which would require re-running the deterministic simulation
 * client-side does (`src/core`, never imported here) — but it is real,
 * bounded to released data, and evolves with the match.
 *
 * Off by default. Gated by the caller (see `ReplayPremiereStartup.ts`'s
 * `syntheticCrowdEnabled` option) behind the exact same discipline as
 * `wageringEnabled`: a premiere with the flag off never constructs this
 * driver at all and behaves byte-identically to today.
 */
import type { PremiereReleasedRecord } from "../../ReplayPremiereContracts";
import { SyntheticCrowdSimulator } from "./SyntheticCrowdSimulator";
import type {
  SyntheticCrowdConfig,
  SyntheticCrowdMarketTarget,
  SyntheticCrowdSignalSnapshot,
} from "./SyntheticCrowdTypes";

/** Minimal surface this driver needs from the runtime coordinator. */
export interface SyntheticCrowdLiveProjectionSource {
  readLiveVisibleSequence(): number;
  readLiveProjection(afterSequence: number): readonly PremiereReleasedRecord[];
}

export interface SyntheticCrowdLiveDriverOptions {
  readonly runtime: SyntheticCrowdLiveProjectionSource;
  readonly target: SyntheticCrowdMarketTarget;
  readonly seatIds: readonly string[];
  /** Total released-sequence count at full reveal, for a 0..1 match-progress fraction. */
  readonly finalSequence: number;
  readonly config: SyntheticCrowdConfig;
  /** Real-time poll cadence. Defaults to 1000ms, matching `WAGERING_MAX_PRESENTATION_SPAN_MS` (the same bound that keeps release granularity fine enough for wagering integrity). */
  readonly pollIntervalMs?: number;
  /** Never throws out of the poll loop; failures are reported here instead. */
  readonly onError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extracts `intents[].clientID` from a raw core `Turn` payload, tolerating anything malformed as "no intents" rather than throwing. */
function intentClientIdsFromTurnPayload(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.intents)) return [];
  const clientIds: string[] = [];
  for (const intent of payload.intents) {
    if (isRecord(intent) && typeof intent.clientID === "string") {
      clientIds.push(intent.clientID);
    }
  }
  return clientIds;
}

/**
 * Polls a live premiere's release tap and drives a `SyntheticCrowdSimulator`
 * from it. One instance per premiere; construct, `start()` once the
 * premiere target is live, `stop()` on teardown/reclamation/settlement.
 */
export class SyntheticCrowdLiveDriver {
  private readonly simulator: SyntheticCrowdSimulator;
  private readonly options: SyntheticCrowdLiveDriverOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeenSequence = -1;
  /** Per-seat decayed intent-activity level, carried across polls so a quiet tick doesn't erase the prior signal. */
  private readonly activityLevel = new Map<string, number>();
  private stopped = false;

  constructor(options: SyntheticCrowdLiveDriverOptions) {
    this.options = options;
    this.simulator = new SyntheticCrowdSimulator({
      config: options.config,
      target: options.target,
    });
  }

  start(): void {
    if (this.timer !== null || this.stopped || !this.options.config.enabled) {
      return;
    }
    const intervalMs = this.options.pollIntervalMs ?? 1_000;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      const records = this.options.runtime.readLiveProjection(this.lastSeenSequence);
      if (records.length === 0) return;
      this.lastSeenSequence = records[records.length - 1].sequence;
      const snapshot = this.deriveSnapshot(records);
      const visibleSequence = this.options.runtime.readLiveVisibleSequence();
      const matchProgress =
        this.options.finalSequence > 0
          ? Math.min(1, Math.max(0, visibleSequence / this.options.finalSequence))
          : 0;
      await this.simulator.onReleasedFrame({
        snapshot,
        matchProgress,
        // -1 is the "nothing observed yet" sentinel `createViewerSession`
        // always accepts (ReplayPremiereInteractions.assertAuthoritative
        // ObservedSequence short-circuits on it) — synthetic bots don't
        // track a real per-session observed-sequence heartbeat the way a
        // real viewer client does, and the coarser chunk-release-based
        // check that field is validated against is unrelated to (and can
        // lag) the fine-grained `liveVisibleSequence` orders are sequenced
        // against below.
        observedSequence: -1,
      });
      const state = this.options.target.readMarketState(null);
      if (state !== null && state.status === "settled") this.stop();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private deriveSnapshot(
    records: readonly PremiereReleasedRecord[],
  ): SyntheticCrowdSignalSnapshot {
    const tickCounts = new Map<string, number>();
    for (const record of records) {
      for (const clientId of intentClientIdsFromTurnPayload(record.payload)) {
        tickCounts.set(clientId, (tickCounts.get(clientId) ?? 0) + 1);
      }
    }
    // Exponential decay: this tick's counts plus 70% of whatever was live
    // before, so activity from a few polls ago still colors the signal
    // instead of vanishing the instant a seat goes quiet for one tick.
    const decayFactor = 0.7;
    const weights: Record<string, number> = {};
    for (const seatId of this.options.seatIds) {
      const decayed = (this.activityLevel.get(seatId) ?? 0) * decayFactor;
      const next = decayed + (tickCounts.get(seatId) ?? 0);
      this.activityLevel.set(seatId, next);
      // +1 floor: an idle seat still gets a nonzero, non-collapsing weight
      // rather than 0, which would make normalizedFairValues fall back to
      // uniform for every quiet tick and swamp the real signal with noise.
      weights[seatId] = next + 1;
    }
    return { optionSeatIds: [...this.options.seatIds], favorabilityWeights: weights };
  }
}
