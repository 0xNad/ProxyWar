/**
 * Coverage for the `game_info_modal.title` raw-i18n-key leak fix
 * (pass-8 QA aria snapshot — third instance of this leak class, after
 * `chat.cat.help` pass-5b and the nav leak pass-2). Root cause:
 * `translateText()` reads `<lang-selector>`'s translation state directly
 * at call time with no subscription of its own — a caller only ever
 * sees a real translation once SOMETHING re-renders after translations
 * finish loading. `GameInfoModal` lives outside `publicapp/`, so it
 * never got the `waitForTranslationsReady()` fix the 11 public pages
 * did. This test uses the REAL `translateText()` (not mocked) against a
 * minimal fake `<lang-selector>`, exactly reproducing the leak and its
 * fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/client/components/baseComponents/Modal";
import "../../src/client/GameInfoModal";
import { GameInfoModal } from "../../src/client/GameInfoModal";

type FakeTranslations = Record<string, string> | undefined;

class FakeLangSelector extends HTMLElement {
  currentLang = "en";
  translations: FakeTranslations = undefined;
  defaultTranslations: FakeTranslations = undefined;
}

describe("GameInfoModal translations-ready gating", () => {
  let langSelector: FakeLangSelector;
  let modal: GameInfoModal;

  beforeEach(async () => {
    vi.useFakeTimers();
    if (!customElements.get("lang-selector")) {
      customElements.define("lang-selector", FakeLangSelector);
    }
    langSelector = document.createElement("lang-selector") as FakeLangSelector;
    document.body.appendChild(langSelector);

    if (!customElements.get("game-info-modal")) {
      customElements.define("game-info-modal", GameInfoModal);
    }
    modal = document.createElement("game-info-modal") as GameInfoModal;
    document.body.appendChild(modal);
    await modal.updateComplete;
  });

  afterEach(() => {
    modal.remove();
    langSelector.remove();
    vi.useRealTimers();
  });

  function oModalTitle(): string {
    const oModal = modal.querySelector("o-modal");
    return (oModal as unknown as { title: string }).title;
  }

  it("shows the raw i18n key before translations load — reproduces the leak", () => {
    expect(oModalTitle()).toBe("game_info_modal.title");
  });

  it("re-renders with the real translated title once translations finish loading", async () => {
    expect(oModalTitle()).toBe("game_info_modal.title");

    langSelector.translations = {
      "game_info_modal.title": "Game Info",
    };
    // `waitForTranslationsReady`'s bounded 20ms poll (no `updateComplete`
    // on this fake element to await instead) picks up the now-loaded
    // translations and triggers `requestUpdate()`.
    await vi.advanceTimersByTimeAsync(20);
    await modal.updateComplete;

    expect(oModalTitle()).toBe("Game Info");
  });
});
