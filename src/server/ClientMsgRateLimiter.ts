import { RateLimiter } from "limiter";
import { ClientID } from "../core/Schemas";

const INTENTS_PER_SECOND = 10;
const INTENTS_PER_MINUTE = 150;
const REJOINS_PER_MINUTE = 12;
const MAX_INTENT_SIZE = 2000;
const TOTAL_BYTES = 2 * 1024 * 1024; // 2MB per client
export type RateLimitResult = "ok" | "limit" | "kick";

/**
 * Magnitude half of the rejoin-DoS defense (the per-client rejoin rate limiter
 * below is the frequency half). On a rejoin the server slices the turn history
 * from `lastTurn`; a negative / NaN / non-finite / oversized value must not
 * produce an unbounded or malformed slice. Clamp to a valid in-range integer
 * index within [0, turnsLength]: non-finite/NaN/non-number -> 0, negatives -> 0,
 * floats floored, and anything past the end -> turnsLength (an empty tail).
 *
 * Pure + exported so this security-relevant behavior is unit-tested
 * independently of the heavyweight GameServer it is called from.
 */
export function clampRejoinFromTurn(
  lastTurn: number,
  turnsLength: number,
): number {
  return Math.min(Math.max(0, Math.floor(Number(lastTurn) || 0)), turnsLength);
}

interface ClientBucket {
  perSecond: RateLimiter;
  perMinute: RateLimiter;
  rejoinPerMinute: RateLimiter;
  totalBytes: number;
}

export class ClientMsgRateLimiter {
  private buckets = new Map<ClientID, ClientBucket>();

  check(clientID: ClientID, type: string, bytes: number): RateLimitResult {
    const bucket = this.getOrCreate(clientID);
    bucket.totalBytes += bytes;

    if (bucket.totalBytes >= TOTAL_BYTES) return "kick";

    if (type === "intent") {
      // Intents are stored in turn history for the duration of the game, so
      // oversized intents would accumulate and fill up server RAM.
      // Intents are also sent to all players, so it increase outgoing
      // data.
      // Intents should never be larger than MAX_INTENT_SIZE, so we assume the client is malicious.
      if (bytes > MAX_INTENT_SIZE) {
        return "kick";
      }
      if (
        !bucket.perSecond.tryRemoveTokens(1) ||
        !bucket.perMinute.tryRemoveTokens(1)
      ) {
        return "limit";
      }
    }

    if (type === "rejoin") {
      // A rejoin makes the server re-serialize + send the full turn history, so
      // it is expensive regardless of the (small) request size. Bound the rate
      // so a client cannot force repeated full-history sends (a memory/CPU/
      // bandwidth DoS); a legitimate client only rejoins on reconnect/refresh.
      if (!bucket.rejoinPerMinute.tryRemoveTokens(1)) {
        return "limit";
      }
    }

    return "ok";
  }

  private getOrCreate(clientID: ClientID): ClientBucket {
    const existing = this.buckets.get(clientID);
    if (existing) {
      return existing;
    }
    const bucket = {
      perSecond: new RateLimiter({
        tokensPerInterval: INTENTS_PER_SECOND,
        interval: "second",
      }),
      perMinute: new RateLimiter({
        tokensPerInterval: INTENTS_PER_MINUTE,
        interval: "minute",
      }),
      rejoinPerMinute: new RateLimiter({
        tokensPerInterval: REJOINS_PER_MINUTE,
        interval: "minute",
      }),
      totalBytes: 0,
    };
    this.buckets.set(clientID, bucket);
    return bucket;
  }
}
