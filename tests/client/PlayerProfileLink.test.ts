import { describe, expect, test } from "vitest";
import {
  PLAYER_PROFILE_ORIGIN,
  playerProfileUrl,
} from "../../src/client/platform/playerProfileLink";

describe("playerProfileUrl", () => {
  test("builds an absolute platform-origin url, never relative", () => {
    const url = playerProfileUrl("daveey-proxywar");
    expect(url).toBe(`${PLAYER_PROFILE_ORIGIN}/player/daveey-proxywar`);
    expect(url.startsWith("https://")).toBe(true);
  });

  test("encodes spaces, slashes, and other reserved characters in the name", () => {
    expect(playerProfileUrl("odin free")).toBe(
      `${PLAYER_PROFILE_ORIGIN}/player/odin%20free`,
    );
    expect(playerProfileUrl("a/b")).toBe(
      `${PLAYER_PROFILE_ORIGIN}/player/a%2Fb`,
    );
    expect(playerProfileUrl("daveey-proxywar:v24")).toBe(
      `${PLAYER_PROFILE_ORIGIN}/player/daveey-proxywar%3Av24`,
    );
  });

  test("league standings link to the platform origin", () => {
    expect(playerProfileUrl("x")).toContain(PLAYER_PROFILE_ORIGIN);
  });
});
