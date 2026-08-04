/**
 * P0 fix (found live 2026-08-02 at 390x844 and 844x390): the Follow/Fit
 * widget used to sit `fixed top-4 left-1/2 -translate-x-1/2` with
 * `z-[50003]` at EVERY viewport width, overlapping `game-right-sidebar`'s
 * own `fixed top-0 right-0` row (below its 1200px breakpoint) so
 * `elementFromPoint` on the Pause/Speed/Settings buttons returned this
 * `<select>` instead. jsdom does not compute real layout/paint order, so
 * this pins the fix at the CSS-class level (the same "assert the literal
 * Tailwind classes are present" convention `CoworldLeagueSiteWriter.test.ts`
 * uses for its own mobile-breakpoint regression) rather than an
 * elementFromPoint measurement.
 */
import { EventBus } from "../../../../src/core/EventBus";
import { PointOfViewSelector } from "../../../../src/client/graphics/layers/PointOfViewSelector";
import { FitWholeMapEvent } from "../../../../src/client/graphics/TransformHandler";
import { writeManualPovSelection } from "../../../../src/client/graphics/PointOfView";

interface LitLikeTemplateResult {
  strings: TemplateStringsArray;
  values: unknown[];
}

function isLitLikeTemplateResult(
  value: unknown,
): value is LitLikeTemplateResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "strings" in value &&
    "values" in value
  );
}

// Lit's `html` tag puts literal text in `.strings` and every `${...}`
// expression (including a nested `html\`...\`` from a ternary, exactly
// the "claim" caption branch below) in `.values` — flattening only
// `.strings` misses any conditionally-rendered nested template entirely.
function renderedHtml(selector: PointOfViewSelector): string {
  const flatten = (value: unknown): string => {
    if (isLitLikeTemplateResult(value)) {
      return value.strings
        .map((part, index) => part + flatten(value.values[index] ?? ""))
        .join("");
    }
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    return "";
  };
  return flatten(selector.render());
}

describe("PointOfViewSelector mobile layout", () => {
  it("reflows away from game-right-sidebar's top-0/right-0 row below the 1200px breakpoint", () => {
    const selector = new PointOfViewSelector();
    const html = renderedHtml(selector);
    // Below 1200px: anchored top-left, clear of the sidebar's own row
    // (whose CSS lives at index.html:564, `fixed top-0 right-0`), and
    // capped to the viewport width so it can never extend under the
    // sidebar's lane regardless of how wide its own button cluster gets.
    expect(html).toContain("fixed top-14 left-2");
    expect(html).toContain("max-w-[calc(100vw-1rem)]");
    // At/above 1200px (game-right-sidebar's own breakpoint, where it drops
    // to a compact top-4/right-4 corner with room to spare) this keeps the
    // original centered-at-top placement.
    expect(html).toContain("min-[1200px]:top-4");
    expect(html).toContain("min-[1200px]:left-1/2");
    expect(html).toContain("min-[1200px]:-translate-x-1/2");
    expect(html).toContain("min-[1200px]:max-w-none");
    // Never reintroduces the old always-centered placement as the BASE
    // (unprefixed) class — only the min-[1200px]: variant may center it.
    const classMatch = /class="([^"]*)"/.exec(html);
    expect(classMatch).not.toBeNull();
    const classTokens = (classMatch?.[1] ?? "").split(/\s+/);
    expect(classTokens).not.toContain("left-1/2");
    expect(classTokens).not.toContain("-translate-x-1/2");
    expect(classTokens).not.toContain("top-4");
  });

  it("reflows the 'from your league claim' caption in tandem with the main pill", () => {
    const selector = new PointOfViewSelector();
    // Test-only poke of a private field to reach the "claim" branch —
    // `source` is set internally by `applyPov`, never from a public setter.
    (selector as unknown as { source: string }).source = "claim";
    const html = renderedHtml(selector);
    expect(html).toContain("from your league claim");
    expect(html).toContain("fixed top-24 left-2");
    expect(html).toContain("min-[1200px]:top-[52px]");
    expect(html).toContain("min-[1200px]:left-1/2");
    expect(html).toContain("min-[1200px]:-translate-x-1/2");
  });
});

interface MinimalPlayerView {
  id: () => string;
  displayName: () => string;
  clientID: () => string;
}

interface PointOfViewSelectorTestHooks {
  eventBus: EventBus | null;
  game: unknown;
  selectedId: string | null;
  init: () => void;
  applyPov: (
    player: MinimalPlayerView | null,
    source: string,
    opts: { persist: boolean; pan: boolean },
  ) => void;
}

describe("PointOfViewSelector match-end reset (deploy 3.9, item 3b)", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("resets the dropdown to 'Whole board' when FitWholeMapEvent fires (e.g. WinModal's match-end camera pullback)", () => {
    // Synchronous "explicit whole board" manual pick short-circuits
    // applyInitialSelection()'s async claim-fetch branch entirely, so
    // init() settles before this test's own assertions run.
    writeManualPovSelection(null);
    const selector = new PointOfViewSelector() as unknown as PointOfViewSelectorTestHooks;
    const eventBus = new EventBus();
    selector.eventBus = eventBus;
    selector.game = null;
    selector.init();

    // Simulate a viewer already following an agent (a manual dropdown pick
    // or rail click) before the match ends.
    const player: MinimalPlayerView = {
      id: () => "p1",
      displayName: () => "Somali Host",
      clientID: () => "c1",
    };
    selector.applyPov(player, "manual", { persist: false, pan: false });
    expect(selector.selectedId).toBe("p1");

    eventBus.emit(new FitWholeMapEvent());

    expect(selector.selectedId).toBeNull();
  });

  it("is a harmless no-op when FitWholeMapEvent fires with nothing followed", () => {
    writeManualPovSelection(null);
    const selector = new PointOfViewSelector() as unknown as PointOfViewSelectorTestHooks;
    const eventBus = new EventBus();
    selector.eventBus = eventBus;
    selector.game = null;
    selector.init();

    expect(selector.selectedId).toBeNull();
    eventBus.emit(new FitWholeMapEvent());
    expect(selector.selectedId).toBeNull();
  });
});
