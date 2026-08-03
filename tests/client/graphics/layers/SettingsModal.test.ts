/**
 * Coverage for the in-game Settings modal's focus-trap + focus-restore
 * fix (P1 t1-02, pass-8 QA): tabbed through all 12 toggle rows, then
 * focus landed on "Sign in" in the page header while the modal stayed
 * visually open. Escape already worked here before this fix (unlike the
 * Points modal); this suite guards the NEW behavior — the trap, and
 * restoring focus to the invoker on close — without regressing that.
 * Real `KeyboardEvent` dispatches throughout.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SettingsModal,
  ShowSettingsModalEvent,
} from "../../../../src/client/graphics/layers/SettingsModal";
import { EventBus } from "../../../../src/core/EventBus";
import { UserSettings } from "../../../../src/core/game/UserSettings";

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
}));

vi.mock("../../../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    gameplayStart: vi.fn(),
    gameplayStop: vi.fn(),
  },
}));

function tab(options: { shift?: boolean } = {}): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: options.shift ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function escape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * `isVisible` is a private field on `SettingsModal`; this test-only
 * accessor reads it through one named, justified cast (a well-known
 * internal shape, not external data) rather than inlining the assertion
 * at each call site.
 */
type SettingsModalInternals = { isVisible: boolean };
function isModalVisible(modal: SettingsModal): boolean {
  return (modal as unknown as SettingsModalInternals).isVisible;
}

describe("SettingsModal focus trap and focus restore", () => {
  let invoker: HTMLButtonElement;
  let headerSignIn: HTMLButtonElement;
  let modal: SettingsModal;

  beforeEach(async () => {
    if (!customElements.get("settings-modal")) {
      customElements.define("settings-modal", SettingsModal);
    }

    invoker = document.createElement("button");
    invoker.textContent = "Settings";
    document.body.appendChild(invoker);

    // Stands in for the real page header control QA reported focus
    // landing on ("Sign in" in the page header) once it had escaped.
    headerSignIn = document.createElement("button");
    headerSignIn.textContent = "Sign in";
    document.body.appendChild(headerSignIn);

    modal = document.createElement("settings-modal") as SettingsModal;
    modal.eventBus = new EventBus();
    modal.userSettings = new UserSettings();
    document.body.appendChild(modal);
    modal.init();
    await modal.updateComplete;

    invoker.focus();
    modal.eventBus.emit(new ShowSettingsModalEvent(true, false, false));
    await modal.updateComplete;
    // The trap activates in a microtask after render settles.
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    modal.remove();
    invoker.remove();
    headerSignIn.remove();
  });

  it("moves focus into the modal when it opens", () => {
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab from walking focus out into the page header", () => {
    const toggles = Array.from(
      modal.querySelectorAll<HTMLElement>("button:not([disabled])"),
    );
    expect(toggles.length).toBeGreaterThan(5); // all 12 toggle rows + exit
    toggles[toggles.length - 1].focus();

    tab();

    expect(document.activeElement).not.toBe(headerSignIn);
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it("still closes on Escape (already worked before this fix — guards against regressing it)", () => {
    escape();
    expect(isModalVisible(modal)).toBe(false);
  });

  it("restores focus to the invoker once closed", async () => {
    escape();
    await modal.updateComplete;
    await Promise.resolve();

    expect(document.activeElement).toBe(invoker);
  });
});

/**
 * P1 ghost-modal fix (pass-10 t1-03): with Analyst mode on, this modal's
 * overlay div (`z-2000`) rendered with plausible-looking computed styles
 * (z-index 2000, opacity 1, display block) but was fully painted over by
 * `AiLeagueReplayOverlay.ts`'s Analyst-mode-promoted panel, which sits
 * `position: fixed`, CENTERED (the same screen region this modal opens
 * into), at `z-index: 50010` — well above this modal's old 2000. It was
 * both invisible (buried under that panel) and non-blocking
 * (`elementFromPoint` over it returned a `<span>` from the replay
 * overlay's standings rail instead of the modal). jsdom does not run the
 * real CSS cascade/paint for these Tailwind/inline styles (same
 * limitation `PointOfViewSelector.test.ts`'s own z-index regression and
 * `PublicAppScroll.test.ts`'s stylesheet-split regression both document),
 * so this pins the fix two ways: the literal rendered class carries a
 * z-index above every current overlay band, AND a source-level scan
 * confirms no `z-index` declared anywhere in the league replay overlay
 * (Analyst mode's own highest band) exceeds it — so a future overlay
 * bump can't silently reintroduce the ghost modal.
 */
describe("SettingsModal z-index (Analyst-mode ghost-modal regression)", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const SETTINGS_MODAL_Z_INDEX = 60000;

  it("renders its overlay above every z-index this app's other feature overlays declare", async () => {
    if (!customElements.get("settings-modal")) {
      customElements.define("settings-modal", SettingsModal);
    }
    const modal = document.createElement("settings-modal") as SettingsModal;
    modal.eventBus = new EventBus();
    modal.userSettings = new UserSettings();
    document.body.appendChild(modal);
    modal.init();
    modal.eventBus.emit(new ShowSettingsModalEvent(true, false, false));
    await modal.updateComplete;

    const overlay = modal.querySelector<HTMLElement>(".modal-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toContain(`z-[${SETTINGS_MODAL_Z_INDEX}]`);

    const overlaySource = readFileSync(
      path.join(repoRoot, "src/client/AiLeagueReplayOverlay.ts"),
      "utf8",
    );
    const declaredZIndexes = [...overlaySource.matchAll(/z-index:\s*(\d+)/g)].map(
      (match) => Number(match[1]),
    );
    expect(declaredZIndexes.length).toBeGreaterThan(0);
    // The Analyst-mode-promoted centered panel is the specific overlap
    // this bug came from — assert it explicitly, not just the max.
    expect(overlaySource).toContain("z-index: 50010");
    expect(Math.max(...declaredZIndexes)).toBeLessThan(SETTINGS_MODAL_Z_INDEX);

    modal.remove();
  });
});
