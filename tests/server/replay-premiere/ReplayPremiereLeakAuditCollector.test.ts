import { describe, expect, test, vi } from "vitest";
import {
  collectReplayPremiereLeakAudit,
  VerifiedReplayPremiereLeakAuditReceipt,
  type ReplayPremiereLeakAuditCollectorLimits,
} from "../../../src/server/replay-premiere/ReplayPremiereLeakAuditCollector";
import { VerifiedPremiereEligibilityGate } from "../../../src/server/replay-premiere/ReplayPremierePublication";
import {
  collectFixtureLeakAudit,
  eligibilityFixture,
  eligibilityOptions,
  NOW,
} from "./ReplayPremiereFixtures";

const limits: ReplayPremiereLeakAuditCollectorLimits = {
  maxTargets: 256,
  maxTargetUrlBytes: 4_096,
  maxBodyBytesPerTarget: 1_000_000,
  maxTotalBodyBytes: 8_000_000,
  maxHeaderBytesPerTarget: 16_384,
  maxHeaderCountPerTarget: 64,
  requestTimeoutMs: 1_000,
  totalTimeoutMs: 10_000,
};

describe("ReplayPremiere leak-audit collector", () => {
  test("collects every exact same-origin target without auth or redirects", async () => {
    const eligibility = eligibilityFixture();
    const byTarget = new Map(
      eligibility.proxyWarLeakChecks.map((entry) => [entry.target, entry]),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      const target = typeof input === "string" ? input : input.toString();
      const expected = byTarget.get(target)!;
      return new Response(expected.observedBodyText ?? "", {
        status: expected.observedHttpStatus!,
        headers: { "cache-control": "no-store" },
      });
    });
    const receipt = await collectReplayPremiereLeakAudit({
      manifest: eligibility.proxyWarLeakAuditManifest,
      expectedOrigin: "https://beta.proxywar.xyz",
      assessmentOptions: eligibilityOptions(),
      limits,
      fetch,
      now: () => NOW,
    });
    expect(fetch).toHaveBeenCalledTimes(
      eligibility.proxyWarLeakAuditManifest.targets.length,
    );
    expect(receipt.transfers()).toHaveLength(fetch.mock.calls.length);
    expect(receipt.transfers()[0]).toMatchObject({
      redirected: false,
      bodyHashScope: "fetch_decoded_utf8",
      rawBodySha256: null,
    });
    const record = {
      ...eligibility,
      proxyWarLeakChecks: receipt.evidence(),
    };
    expect(() =>
      VerifiedReplayPremiereLeakAuditReceipt.verifyForEligibility({
        receipt,
        eligibilityRecord: record,
        assessmentOptions: eligibilityOptions(),
      }),
    ).not.toThrow();
  });

  test("fails before fetch for a cross-origin target and caps streamed bodies", async () => {
    const eligibility = eligibilityFixture();
    const crossOrigin = structuredClone(eligibility.proxyWarLeakAuditManifest);
    crossOrigin.targets[0].target = "https://attacker.invalid/league";
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      collectReplayPremiereLeakAudit({
        manifest: crossOrigin,
        expectedOrigin: "https://beta.proxywar.xyz",
        assessmentOptions: eligibilityOptions(),
        limits,
        fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      publicCode: "PREMIERE_SOURCE_INELIGIBLE",
    });
    expect(fetch).not.toHaveBeenCalled();

    await expect(
      collectReplayPremiereLeakAudit({
        manifest: eligibility.proxyWarLeakAuditManifest,
        expectedOrigin: "https://beta.proxywar.xyz",
        assessmentOptions: eligibilityOptions(),
        limits: {
          ...limits,
          maxBodyBytesPerTarget: 4,
          maxTotalBodyBytes: 8,
        },
        fetch: async () => new Response("oversized"),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      publicCode: "PREMIERE_CAPACITY_EXCEEDED",
    });
  });

  test("does not trust a serialized or prototype-fabricated receipt", async () => {
    const collected = await collectFixtureLeakAudit(
      eligibilityFixture(),
      eligibilityOptions(),
    );
    const serialized = JSON.parse(JSON.stringify(collected.receipt));
    const fabricated = Object.assign(
      Object.create(VerifiedReplayPremiereLeakAuditReceipt.prototype),
      serialized,
    );
    expect(() =>
      VerifiedReplayPremiereLeakAuditReceipt.verifyForEligibility({
        receipt: fabricated,
        eligibilityRecord: collected.eligibility,
        assessmentOptions: eligibilityOptions(),
      }),
    ).toThrow(/integrity/i);
    expect(VerifiedPremiereEligibilityGate.isAuthentic(fabricated)).toBe(false);
    expect(() =>
      Reflect.construct(VerifiedReplayPremiereLeakAuditReceipt, [
        Symbol("forged-issuer"),
      ]),
    ).toThrow(/integrity/i);
  });
});
