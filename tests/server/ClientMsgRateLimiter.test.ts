import { describe, expect, it } from "vitest";
import {
  ClientMsgRateLimiter,
  clampRejoinFromTurn,
} from "../../src/server/ClientMsgRateLimiter";

const CLIENT_A = "clientA" as any;
const CLIENT_B = "clientB" as any;

const SMALL = 100;

describe("ClientMsgRateLimiter", () => {
  describe("intent messages", () => {
    it("allows intents within limits", () => {
      const limiter = new ClientMsgRateLimiter();
      expect(limiter.check(CLIENT_A, "intent", SMALL)).toBe("ok");
    });

    it("limits when per-second count exceeded", () => {
      const limiter = new ClientMsgRateLimiter();
      for (let i = 0; i < 10; i++) {
        expect(limiter.check(CLIENT_A, "intent", SMALL)).toBe("ok");
      }
      expect(limiter.check(CLIENT_A, "intent", SMALL)).toBe("limit");
    });

    it("rate limits are per client", () => {
      const limiter = new ClientMsgRateLimiter();
      for (let i = 0; i < 10; i++) {
        limiter.check(CLIENT_A, "intent", SMALL);
      }
      expect(limiter.check(CLIENT_B, "intent", SMALL)).toBe("ok");
    });

    it("allows intents up to MAX_INTENT_SIZE", () => {
      const limiter = new ClientMsgRateLimiter();
      expect(limiter.check(CLIENT_A, "intent", 2000)).toBe("ok");
    });

    it("kicks intents exceeding MAX_INTENT_SIZE", () => {
      const limiter = new ClientMsgRateLimiter();
      expect(limiter.check(CLIENT_A, "intent", 2001)).toBe("kick");
    });
  });

  describe("non-intent messages", () => {
    it("does not rate-limit non-intent messages", () => {
      const limiter = new ClientMsgRateLimiter();
      for (let i = 0; i < 20; i++) {
        expect(limiter.check(CLIENT_A, "winner", 50)).toBe("ok");
      }
    });

    it("does not rate-limit ping messages", () => {
      const limiter = new ClientMsgRateLimiter();
      for (let i = 0; i < 20; i++) {
        expect(limiter.check(CLIENT_A, "ping", 50)).toBe("ok");
      }
    });
  });

  describe("rejoin messages (DoS guard)", () => {
    it("allows rejoins up to the per-minute budget then limits", () => {
      const limiter = new ClientMsgRateLimiter();
      let ok = 0;
      let limited = 0;
      for (let i = 0; i < 30; i++) {
        const r = limiter.check(CLIENT_A, "rejoin", SMALL);
        if (r === "ok") ok++;
        else if (r === "limit") limited++;
      }
      // REJOINS_PER_MINUTE = 12; a rejoin forces a full turn-history re-send,
      // so excess rejoins are dropped to prevent a memory/CPU/bandwidth DoS.
      expect(ok).toBe(12);
      expect(limited).toBe(18);
    });

    it("rejoin budget is per client", () => {
      const limiter = new ClientMsgRateLimiter();
      for (let i = 0; i < 30; i++) limiter.check(CLIENT_A, "rejoin", SMALL);
      expect(limiter.check(CLIENT_B, "rejoin", SMALL)).toBe("ok");
    });
  });

  describe("clampRejoinFromTurn (rejoin slice magnitude guard)", () => {
    const LEN = 1000; // turns.length

    it("passes a normal in-range index through unchanged", () => {
      expect(clampRejoinFromTurn(500, LEN)).toBe(500);
    });

    it("clamps an index past the end to turns.length (empty tail, not OOB)", () => {
      expect(clampRejoinFromTurn(50_000, LEN)).toBe(LEN);
    });

    it("clamps negatives to 0 (no unbounded full-history slice from a negative)", () => {
      expect(clampRejoinFromTurn(-1, LEN)).toBe(0);
      expect(clampRejoinFromTurn(-50_000, LEN)).toBe(0);
    });

    it("treats NaN / non-finite / non-number as 0", () => {
      expect(clampRejoinFromTurn(NaN, LEN)).toBe(0);
      expect(clampRejoinFromTurn(undefined as unknown as number, LEN)).toBe(0);
      expect(clampRejoinFromTurn(null as unknown as number, LEN)).toBe(0);
      expect(clampRejoinFromTurn("garbage" as unknown as number, LEN)).toBe(0);
    });

    it("clamps +Infinity to turns.length and -Infinity to 0", () => {
      expect(clampRejoinFromTurn(Infinity, LEN)).toBe(LEN);
      expect(clampRejoinFromTurn(-Infinity, LEN)).toBe(0);
    });

    it("floors fractional indices to a valid integer", () => {
      expect(clampRejoinFromTurn(12.9, LEN)).toBe(12);
    });

    it("accepts the boundary indices 0 and turns.length", () => {
      expect(clampRejoinFromTurn(0, LEN)).toBe(0);
      expect(clampRejoinFromTurn(LEN, LEN)).toBe(LEN);
    });
  });

  describe("total bytes limit", () => {
    it("kicks when cumulative bytes reach 2MB", () => {
      const limiter = new ClientMsgRateLimiter();
      const chunkSize = 512 * 1024; // 512KB
      // Send 3 chunks = 1.5MB, should be ok
      for (let i = 0; i < 3; i++) {
        expect(limiter.check(CLIENT_A, "other", chunkSize)).toBe("ok");
      }
      // 4th chunk pushes to 2MB, should kick
      expect(limiter.check(CLIENT_A, "other", chunkSize)).toBe("kick");
    });

    it("byte tracking is per client", () => {
      const limiter = new ClientMsgRateLimiter();
      const almostFull = 2 * 1024 * 1024 - 1;
      expect(limiter.check(CLIENT_A, "other", almostFull)).toBe("ok");
      // CLIENT_B should still be fine
      expect(limiter.check(CLIENT_B, "other", 100)).toBe("ok");
    });

    it("kicks on bytes regardless of message type", () => {
      const limiter = new ClientMsgRateLimiter();
      const twoMB = 2 * 1024 * 1024;
      expect(limiter.check(CLIENT_A, "intent", twoMB)).toBe("kick");
    });
  });
});
