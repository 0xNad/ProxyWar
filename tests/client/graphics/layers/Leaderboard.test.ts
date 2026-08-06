import { describe, expect, it } from "vitest";
import { Leaderboard } from "../../../../src/client/graphics/layers/Leaderboard";

/**
 * Regression: a prior POV-removal edit accidentally swept `createRenderRoot()`
 * out along with the deleted `povPlayerId`/`init()` PointOfViewChangeEvent
 * subscription it happened to sit beside. Without `createRenderRoot()`
 * returning `this`, LitElement falls back to its default behavior of
 * attaching a real Shadow DOM root — which would put every leaderboard row
 * behind a shadow boundary Tailwind's global stylesheet can never reach,
 * rendering it completely unstyled in production. This pins the light-DOM
 * contract directly, independent of any POV-related behavior.
 */
describe("Leaderboard light DOM (Tailwind support)", () => {
  it("createRenderRoot() returns the element itself, not a Shadow DOM boundary", () => {
    const leaderboard = new Leaderboard();
    const root = leaderboard.createRenderRoot();
    expect(root).toBe(leaderboard);
  });

  it("never attaches a shadowRoot — global Tailwind stylesheets must reach every rendered row", () => {
    const leaderboard = new Leaderboard();
    leaderboard.createRenderRoot();
    expect(leaderboard.shadowRoot).toBeNull();
  });
});
