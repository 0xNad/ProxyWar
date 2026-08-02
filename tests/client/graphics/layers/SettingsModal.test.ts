/**
 * Coverage for the in-game Settings modal's focus-trap + focus-restore
 * fix (P1 t1-02, pass-8 QA): tabbed through all 12 toggle rows, then
 * focus landed on "Sign in" in the page header while the modal stayed
 * visually open. Escape already worked here before this fix (unlike the
 * Points modal); this suite guards the NEW behavior — the trap, and
 * restoring focus to the invoker on close — without regressing that.
 * Real `KeyboardEvent` dispatches throughout.
 */
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
