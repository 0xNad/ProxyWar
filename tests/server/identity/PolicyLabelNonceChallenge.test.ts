import { afterEach, describe, expect, it } from "vitest";
import {
  buildNonceInstructions,
  extractNonceFromLabel,
  generateChallengeNonce,
  isNonceAutoVerifyEnabled,
  NONCE_AUTO_VERIFY_GATE_ENV,
} from "../../../src/server/identity/PolicyLabelNonceChallenge";

describe("PolicyLabelNonceChallenge", () => {
  it("generates a pwn-<12 hex> nonce", () => {
    const nonce = generateChallengeNonce();
    expect(nonce).toMatch(/^pwn-[a-f0-9]{12}$/);
  });

  it("generates distinct nonces across calls", () => {
    const nonces = new Set(Array.from({ length: 20 }, () => generateChallengeNonce()));
    expect(nonces.size).toBe(20);
  });
  it("instructions carry the exact nonce and the agent's display name, and reassure no credential is needed", () => {
    const nonce = "pwn-abcdef123456";
    const instructions = buildNonceInstructions(nonce, "Daveey's Agent");
    expect(instructions).toContain(nonce);
    expect(instructions).toContain("Daveey's Agent");
    expect(instructions.toLowerCase()).toContain("does not require sharing");
  });

  it("extracts a nonce embedded anywhere in a label", () => {
    const nonce = generateChallengeNonce();
    expect(extractNonceFromLabel(`daveey-${nonce}:v26`)).toBe(nonce);
    expect(extractNonceFromLabel(`${nonce}`)).toBe(nonce);
  });

  it("returns null when no nonce is present", () => {
    expect(extractNonceFromLabel("daveey-proxywar:v24")).toBeNull();
  });

  describe("isNonceAutoVerifyEnabled", () => {
    afterEach(() => {
      delete process.env[NONCE_AUTO_VERIFY_GATE_ENV];
    });

    it("defaults to disabled with no env override", () => {
      expect(isNonceAutoVerifyEnabled({})).toBe(false);
    });

    it("stays disabled for any value other than the exact string '1'", () => {
      expect(isNonceAutoVerifyEnabled({ [NONCE_AUTO_VERIFY_GATE_ENV]: "true" })).toBe(
        false,
      );
      expect(isNonceAutoVerifyEnabled({ [NONCE_AUTO_VERIFY_GATE_ENV]: "yes" })).toBe(
        false,
      );
    });

    it("is enabled only when explicitly set to '1'", () => {
      expect(isNonceAutoVerifyEnabled({ [NONCE_AUTO_VERIFY_GATE_ENV]: "1" })).toBe(true);
    });

    it("reads the real process.env by default", () => {
      expect(isNonceAutoVerifyEnabled()).toBe(false);
      process.env[NONCE_AUTO_VERIFY_GATE_ENV] = "1";
      expect(isNonceAutoVerifyEnabled()).toBe(true);
    });
  });
});
