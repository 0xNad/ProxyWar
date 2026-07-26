import { describe, expect, test } from "vitest";
import { classifyPremiereWageringProvenance } from "../../../src/scripts/premiere-wagering/PremiereWageringProvenance";

describe("classifyPremiereWageringProvenance", () => {
  test("a bundle dir matching the mirror's managed public run key is never sealable, even if declared xp-request", () => {
    const verdict = classifyPremiereWageringProvenance({
      bundleDirName: "league-coworld-2026-07-26T09-12-41-706Z-ea6da6f4",
      declaredSource: "xp_request",
    });
    expect(verdict.source).toBe("public_league_mirror");
    expect(verdict.sealable).toBe(false);
  });

  test("a bundle dir matching the managed pattern is refused with no declaration too", () => {
    const verdict = classifyPremiereWageringProvenance({
      bundleDirName: "league-coworld-abc-123",
    });
    expect(verdict.sealable).toBe(false);
    expect(verdict.source).toBe("public_league_mirror");
  });

  test("declared xp-request on a non-managed directory name is sealable", () => {
    const verdict = classifyPremiereWageringProvenance({
      bundleDirName: "xpreq-coworld-2026-07-26T20-00-00-000Z-deadbeef",
      declaredSource: "xp_request",
    });
    expect(verdict.source).toBe("xp_request");
    expect(verdict.sealable).toBe(true);
  });

  test("declared public-league-mirror is refused", () => {
    const verdict = classifyPremiereWageringProvenance({
      bundleDirName: "xpreq-something",
      declaredSource: "public_league_mirror",
    });
    expect(verdict.sealable).toBe(false);
  });

  test("undeclared, non-managed directory name refuses rather than guessing private", () => {
    const verdict = classifyPremiereWageringProvenance({
      bundleDirName: "some-local-bundle",
    });
    expect(verdict.source).toBe("unknown");
    expect(verdict.sealable).toBe(false);
  });
});
