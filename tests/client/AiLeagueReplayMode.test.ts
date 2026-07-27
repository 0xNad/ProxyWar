import { describe, expect, it } from "vitest";
import {
  isAiLeagueReplayRoute,
  isReplayPremiereRoute,
} from "../../src/client/AiLeagueReplayMode";

describe("AiLeagueReplayMode", () => {
  it("recognizes only canonical replay premiere routes", () => {
    const premierePath = "/premiere/prem_0123456789abcdef";
    expect(isReplayPremiereRoute(premierePath)).toBe(true);
    expect(isAiLeagueReplayRoute(premierePath)).toBe(true);

    expect(isReplayPremiereRoute("/premiere/prem_short")).toBe(false);
    expect(
      isReplayPremiereRoute("/premiere/prem_0123456789abcdef/manifest"),
    ).toBe(false);
    expect(
      isReplayPremiereRoute("/premiere/prem_0123456789abcdef%2fsecret"),
    ).toBe(false);
    expect(isReplayPremiereRoute("/premiere/prem_0123456789ABCDEF")).toBe(
      false,
    );
  });
});
