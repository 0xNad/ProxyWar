import { describe, expect, it } from "vitest";
import {
  computeProvisionalIdentities,
  computeProvisionalIdentity,
} from "../../../src/server/identity/ProvisionalIdentity";

describe("ProvisionalIdentity", () => {
  it("derives a lowercase, hyphenated slug from playerName", () => {
    const identity = computeProvisionalIdentity("James Botts", new Set());
    expect(identity.slug).toBe("james-botts");
  });

  it("is fully deterministic: same playerName -> same slug/emblem/colors every time", () => {
    const a = computeProvisionalIdentity("Jordan", new Set());
    const b = computeProvisionalIdentity("Jordan", new Set());
    expect(a).toEqual(b);
  });

  it("never collides with a reserved (real registered) slug — appends a stable hash suffix instead", () => {
    const identity = computeProvisionalIdentity(
      "James Botts",
      new Set(["james-botts"]),
    );
    expect(identity.slug).not.toBe("james-botts");
    expect(identity.slug).toMatch(/^james-botts-[a-f0-9]{6}$/);
    // Deterministic even in the collision branch.
    const again = computeProvisionalIdentity(
      "James Botts",
      new Set(["james-botts"]),
    );
    expect(again.slug).toBe(identity.slug);
  });

  it("generates a non-empty SVG and a distinct primary/secondary palette", () => {
    const identity = computeProvisionalIdentity("Jordan", new Set());
    expect(identity.emblemSvg).toContain("<svg");
    expect(identity.primaryColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(identity.secondaryColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("never falls back to an empty slug for a playerName with no alphanumeric characters", () => {
    const identity = computeProvisionalIdentity("!!!", new Set());
    expect(identity.slug).toBe("participant");
  });

  describe("computeProvisionalIdentities (batch)", () => {
    it("assigns every playerName a distinct slug, threading reservations forward within the batch", () => {
      const result = computeProvisionalIdentities(
        ["James Botts", "Jordan"],
        new Set(["james-boggs"]),
      );
      expect(result.get("James Botts")?.slug).toBe("james-botts");
      expect(result.get("Jordan")?.slug).toBe("jordan");
    });

    it("disambiguates two DIFFERENT playerNames that normalize to the same base slug", () => {
      const result = computeProvisionalIdentities(["Jordan", "Jordan!"], new Set());
      const first = result.get("Jordan")?.slug;
      const second = result.get("Jordan!")?.slug;
      expect(first).toBe("jordan");
      expect(second).not.toBe(first);
      expect(second).toMatch(/^jordan-[a-f0-9]{6}$/);
    });

    it("never reuses a real registered slug for any participant in the batch", () => {
      const result = computeProvisionalIdentities(
        ["daveey"],
        new Set(["daveey"]),
      );
      expect(result.get("daveey")?.slug).not.toBe("daveey");
    });
  });
});
