import { colord, Colord, extend } from "colord";
import labPlugin from "colord/plugins/lab";
import { ColorAllocator } from "../src/core/configuration/ColorAllocator";
import {
  blueTeamColors,
  clampPlayerColorVisibility,
  fallbackColors,
  greenTeamColors,
  humanColors,
  MAX_VISIBLE_LIGHTNESS,
  MIN_VISIBLE_SATURATION,
  orangeTeamColors,
  purpleTeamColors,
  redTeamColors,
  tealTeamColors,
  yellowTeamColors,
} from "../src/core/configuration/Colors";
import { defaultAgentRegistryPath, loadAgentRegistry } from "../src/server/identity/IdentityRegistry";

extend([labPlugin]);

/**
 * Regression coverage for the "player colours read as transparent/
 * washed-out" bug. Root cause: `humanColors`/`fallbackColors`/
 * `generateTeamColors` (Colors.ts) could emit near-white pastels — e.g. the
 * live-measured `rgb(251,235,245)` ("Rose Powder", originally the 51st
 * entry of `humanColors`) — regardless of alpha. `clampPlayerColorVisibility`
 * now bounds every colour those pools hand out to
 * `saturation >= MIN_VISIBLE_SATURATION` and `lightness <= MAX_VISIBLE_LIGHTNESS`
 * (HSL). This file proves that clamp actually keeps every colour readable
 * against the backgrounds it is rendered over.
 *
 * "Readable" is measured with colord's own LAB `delta()` — the same
 * perceptual-difference primitive `PastelTheme.contrast()` already uses
 * in-repo (structureColors' contrastTarget check) — rather than a raw WCAG
 * luminance ratio: WCAG contrast only tracks brightness, so a saturated
 * hue-neutral pair (e.g. vivid green vs. light grey mountain terrain) can
 * read as "0 contrast" even though it's clearly not washed out, while a
 * pastel that's merely hue-similar to a background (e.g. any blue vs. blue
 * water, any yellow-green vs. yellow-green plains) reads as "low contrast"
 * for reasons unrelated to this bug. Gating on hue-adjacent terrain would
 * either produce false failures for legitimately vivid colours (blue vs.
 * water) or require also solving hue placement, which is out of scope —
 * this bug is specifically about lightness/saturation, not hue.
 */

// Terrain colours actually used by PastelTheme.terrainColor() (map fill).
const TERRAIN_BACKGROUNDS = {
  shore: "rgb(204,203,158)", // fixed shore colour
  plainsLightest: "rgb(190,220,138)", // magnitude 0
  plainsDarkest: "rgb(190,202,138)", // magnitude 9
  highlandLightest: "rgb(220,203,158)", // magnitude 10
  highlandDarkest: "rgb(238,221,176)", // magnitude 19
  mountainLightest: "rgb(230,230,230)", // magnitude 20 (near-white snowcap)
  mountainDarkest: "rgb(245,245,245)", // magnitude 30 (near-white snowcap)
};

// Near-white/light UI chrome the palette also has to read against
// (CoworldPlayerOverlay.ts tooltip/card surfaces, ReplayPremiereOverlay.ts
// light theme).
const UI_LIGHT_BACKGROUNDS = {
  uiWhite: "#ffffff",
  uiSlate: "#f8fafc",
  uiBlueTint: "#eff6ff",
};

// The set this bug is actually about: any background that is itself
// near-white/hue-neutral. A washed-out pastel fails against ALL of these;
// a legitimately vivid colour (even one that's merely hue-adjacent to a
// *coloured* terrain type like plains/water) clears all of them.
const NEAR_WHITE_BACKGROUNDS = {
  mountainLightest: TERRAIN_BACKGROUNDS.mountainLightest,
  mountainDarkest: TERRAIN_BACKGROUNDS.mountainDarkest,
  ...UI_LIGHT_BACKGROUNDS,
};

// Comfortably above the ~0.05-0.10 the pre-fix pastels measured, and
// comfortably below the ~0.20+ every clamped colour actually achieves —
// see `worstDeltaAgainstNearWhite` sweep result recorded in the fix commit.
const CONTRAST_FLOOR = 0.16;

function worstDeltaAgainstNearWhite(c: Colord): number {
  return Math.min(
    ...Object.values(NEAR_WHITE_BACKGROUNDS).map((bg) => c.delta(colord(bg))),
  );
}

function expectPassesFloor(c: Colord, label: string) {
  const worst = worstDeltaAgainstNearWhite(c);
  expect(worst, `${label} (${c.toRgbString()}) delta=${worst}`).toBeGreaterThanOrEqual(
    CONTRAST_FLOOR,
  );
}

describe("clampPlayerColorVisibility", () => {
  test("enforces the minimum saturation / maximum lightness bounds", () => {
    const raw = colord({ h: 322, s: 67, l: 95 }); // ~rgb(251,235,245)
    const clamped = clampPlayerColorVisibility(raw);
    const hsl = clamped.toHsl();
    expect(hsl.l).toBeLessThanOrEqual(MAX_VISIBLE_LIGHTNESS);
    expect(hsl.s).toBeGreaterThanOrEqual(MIN_VISIBLE_SATURATION);
  });

  test("leaves already-visible colours untouched (within HSL round-trip rounding)", () => {
    const emerald = colord("rgb(34,197,94)"); // s=71 l=45, well inside bounds
    const clamped = clampPlayerColorVisibility(emerald);
    const before = emerald.toRgb();
    const after = clamped.toRgb();
    expect(Math.abs(before.r - after.r)).toBeLessThanOrEqual(2);
    expect(Math.abs(before.g - after.g)).toBeLessThanOrEqual(2);
    expect(Math.abs(before.b - after.b)).toBeLessThanOrEqual(2);
  });

  test("the exact live-measured washed-out bug colour now passes the floor", () => {
    // rgb(251,235,245) — QA's "Rose Powder" measurement, ~S67/L95.
    const bugColor = colord("rgb(251,235,245)");
    expect(worstDeltaAgainstNearWhite(bugColor)).toBeLessThan(CONTRAST_FLOOR); // proves it WAS broken
    expectPassesFloor(clampPlayerColorVisibility(bugColor), "clamped bug colour");
  });

  test.each([
    ["Rose Powder", "rgb(251,235,245)"],
    ["Mint Whisper", "rgb(230,255,250)"],
    ["Ice Blue", "rgb(220,240,250)"],
    ["Meringue Blue", "rgb(220,220,255)"],
    ["Pastel Lemon", "rgb(250,250,210)"],
    ["Petal Mist", "rgb(255,225,255)"],
    ["Frosted Lilac", "rgb(240,240,255)"],
  ])("known-bad pastel %s no longer reads as washed-out once clamped", (_name, rgb) => {
    const before = colord(rgb);
    expect(worstDeltaAgainstNearWhite(before)).toBeLessThan(CONTRAST_FLOOR);
    expectPassesFloor(clampPlayerColorVisibility(before), rgb);
  });
});

describe("Colors.ts player colour pools stay above the contrast floor", () => {
  test("every humanColors entry (post-clamp) passes", () => {
    for (const c of humanColors) expectPassesFloor(c, "humanColors entry");
  });

  test("every fallbackColors entry (post-clamp) passes", () => {
    for (const c of fallbackColors) expectPassesFloor(c, "fallbackColors entry");
  });

  test("every generated team colour (all 7 bases x 64 variants) passes", () => {
    const allTeamColors = [
      ...redTeamColors,
      ...blueTeamColors,
      ...tealTeamColors,
      ...purpleTeamColors,
      ...yellowTeamColors,
      ...orangeTeamColors,
      ...greenTeamColors,
    ];
    expect(allTeamColors.length).toBe(7 * 64);
    for (const c of allTeamColors) expectPassesFloor(c, "generated team colour");
  });
});

describe("real match roster stays above the contrast floor", () => {
  test("every registered agent gets a passing territoryColor via ColorAllocator", async () => {
    const agents = await loadAgentRegistry(defaultAgentRegistryPath());
    expect(agents.length).toBeGreaterThanOrEqual(12); // sanity: this is a real multi-agent roster

    // Mirrors PastelTheme's own wiring: humanColorAllocator draws from
    // humanColors, falling back to fallbackColors once exhausted.
    const allocator = new ColorAllocator(humanColors, fallbackColors);
    for (const agent of agents) {
      const assigned = allocator.assignColor(agent.policyMatchRule.playerName);
      expectPassesFloor(assigned, `agent "${agent.slug}"`);
    }
  });
});
