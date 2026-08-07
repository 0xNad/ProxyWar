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
import { fetchGameById } from "../../src/client/Api";
import { GameInfoModal } from "../../src/client/GameInfoModal";
import { RankType } from "../../src/client/components/baseComponents/ranking/GameInfoRanking";
import { GameMode, UnitType } from "../../src/core/game/Game";

/**
 * `fetchGameById` is mocked module-wide so the "stats-absent" test below
 * can force `loadGame()` down its failure path without a real network
 * call. Unused by every other test in this file (they never call
 * `loadGame()`), so the real implementation's absence is harmless there.
 */
vi.mock("../../src/client/Api", () => ({
  fetchGameById: vi.fn(),
}));

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

/**
 * Coverage for the modal-chrome accessibility gap QA reproduced: a bare
 * `.open()` call (no `loadGame()`) used to strand the viewer on an
 * infinite spinner with zero focusable elements and no Escape handling.
 * Root causes fixed: (1) `<o-modal>`'s close "X" is now a real
 * `<button>`, not an unfocusable `<div>`; (2) `GameInfoModal` now
 * extends `BaseModal`, picking up its Escape handling and focus trap;
 * (3) `isLoadingGame` is replaced by an honest `idle`/`loading`/
 * `loaded`/`failed` state machine so an unloaded or failed modal shows a
 * real message instead of spinning forever.
 */
describe("GameInfoModal modal chrome", () => {
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
    vi.mocked(fetchGameById).mockReset();
  });

  /** Mirrors `BaseModal.test.ts`'s own open-and-settle sequence exactly. */
  async function openModal(): Promise<void> {
    modal.open();
    await modal.updateComplete;
    const oModal = modal.querySelector("o-modal") as unknown as {
      updateComplete: Promise<unknown>;
    };
    await oModal.updateComplete;
  }

  /** `<o-modal>`'s close button lives in ITS OWN shadow root, not `modal`'s light DOM. */
  function closeButton(): HTMLButtonElement {
    const oModal = modal.querySelector("o-modal") as HTMLElement;
    return oModal.shadowRoot!.querySelector("button") as HTMLButtonElement;
  }

  function dispatchEscape(): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  it("Escape closes the modal", async () => {
    await openModal();
    expect(modal.isOpen()).toBe(true);

    dispatchEscape();

    expect(modal.isOpen()).toBe(false);
  });

  it("the close button is keyboard-focusable and clicking it closes the modal", async () => {
    await openModal();

    const button = closeButton();
    expect(button.tagName).toBe("BUTTON");
    // The only focusable descendant in the default (idle) state, so the
    // focus trap lands here on open — proof it's reachable by keyboard,
    // unlike the old bare `<div>`. `document.activeElement` itself
    // retargets to the shadow HOST (`<o-modal>`) once focus lives inside
    // its open shadow root — real, spec-defined behavior (see
    // `FocusTrap.ts`'s own `deepActiveElement` doc) — so the true focused
    // element is read off the shadow root instead.
    const oModalEl = modal.querySelector("o-modal") as HTMLElement;
    expect(document.activeElement).toBe(oModalEl);
    expect(oModalEl.shadowRoot!.activeElement).toBe(button);

    button.click();

    expect(modal.isOpen()).toBe(false);
  });

  it("content-load-failure still closable", async () => {
    // No loadGame() call — QA's exact bare `.open()` repro.
    await openModal();

    expect(modal.querySelector(".animate-spin")).toBeNull();
    expect(modal.textContent).toContain("game_info_modal.no_data");

    dispatchEscape();
    expect(modal.isOpen()).toBe(false);

    await openModal();
    closeButton().click();
    expect(modal.isOpen()).toBe(false);
  });

  it("stats-absent state honest", async () => {
    vi.mocked(fetchGameById).mockResolvedValueOnce(false);

    await modal.loadGame("missing-game-id");
    await modal.updateComplete;

    expect(modal.querySelector(".animate-spin")).toBeNull();
    expect(modal.textContent).toContain("game_info_modal.load_failed");
  });

  it("clears a historical Pirate ranking when loading a Warship-disabled game", async () => {
    modal.rankType = RankType.StolenGold;
    vi.mocked(fetchGameById).mockResolvedValueOnce({
      info: {
        config: {
          gameMap: "Pangaea",
          gameMode: GameMode.FFA,
          disabledUnits: [UnitType.Warship],
        },
        duration: 1,
        players: [],
      },
    } as never);

    await modal.loadGame("new-warship-disabled-game");

    expect(modal.rankType).toBe(RankType.TotalGold);
  });
});
