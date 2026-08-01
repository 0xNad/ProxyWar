import { describe, expect, it } from "vitest";
import { findUnreferencedProseClaims } from "../../../../src/server/agents/season/EventPackageProseClaims";
import type { EventPackageClaim } from "../../../../src/server/agents/season/EventPackage";

const CLAIMS: EventPackageClaim[] = [
  {
    text: "Auri debuts v43 after winning 4 of its last 5 retained matches.",
    source: "version_debut",
    reference: "version:agtv_auri_v43:firstObservedAt=2026-08-01T00:00:00.000Z",
  },
];

describe("findUnreferencedProseClaims", () => {
  it("returns no warnings when prose only restates numbers already backed by a claim", () => {
    const warnings = findUnreferencedProseClaims(
      "Auri debuts v43 after winning 4 of its last 5 retained matches.",
      CLAIMS,
      ["Auri", "Sefirot"],
    );
    expect(warnings).toEqual([]);
  });

  it("flags an unreferenced number in prose", () => {
    const warnings = findUnreferencedProseClaims(
      "Sefirot has won 9 straight matches on this map.",
      CLAIMS,
      ["Auri", "Sefirot"],
    );
    expect(warnings.some((warning) => warning.includes('"9"'))).toBe(true);
  });

  it("flags a known agent name mentioned with no backing claim", () => {
    const warnings = findUnreferencedProseClaims(
      "Sefirot is the clear favorite here.",
      CLAIMS,
      ["Auri", "Sefirot"],
    );
    expect(warnings.some((warning) => warning.includes('"Sefirot"'))).toBe(true);
  });

  it("does not flag an agent name that IS backed by a claim's own text", () => {
    const warnings = findUnreferencedProseClaims(
      "Auri is the one to watch.",
      CLAIMS,
      ["Auri", "Sefirot"],
    );
    expect(warnings.some((warning) => warning.includes('"Auri"'))).toBe(false);
  });

  it("never blocks — always returns warnings only, prose is not rejected", () => {
    const warnings = findUnreferencedProseClaims("17 unbacked facts and Ghost mentioned.", [], ["Ghost"]);
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("returns no warnings for prose with no numbers or known names at all", () => {
    expect(findUnreferencedProseClaims("A clean, close match on a contested map.", CLAIMS, ["Auri"])).toEqual([]);
  });
});
