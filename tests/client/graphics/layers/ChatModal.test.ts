/**
 * Coverage for the quick-chat raw-i18n-key leak (`chat.category`,
 * `chat.cat.help/attack/
 * defend/greet/misc/warnings`, `chat.build`, `chat.send` rendered as
 * literal strings, both visually and in the accessible tree). Root cause:
 * `ChatModal` lives in the shared game shell. `translateText()` returns
 * the raw key whenever it can't resolve a real translation (no
 * `<lang-selector>` in the DOM, translations still loading, or the key
 * missing) — hardcoding English would regress the bootstrapped shell, so
 * the fix is an explicit English `defaultText` argument (now supported by
 * `translateText` itself, see `Utils.ts`) at every quick-chat call site,
 * sourced verbatim from `resources/lang/en.json` via `englishChatFallback`
 * so it can never drift from the real strings.
 *
 * Uses the REAL `translateText()` (not mocked), exactly like
 * `GameInfoModal.test.ts`'s precedent for this leak class, against either
 * no `<lang-selector>` at all or a fake one with loaded
 * translations (a translated shell) to prove both sides of the contract.
 */
import { afterEach, describe, expect, it } from "vitest";
import "../../../../src/client/components/baseComponents/Modal";
import {
  ChatModal,
  englishChatFallback,
  quickChatPhrases,
} from "../../../../src/client/graphics/layers/ChatModal";
import { QuickChatKeySchema } from "../../../../src/core/Schemas";

type FakeTranslations = Record<string, string> | undefined;

class FakeLangSelector extends HTMLElement {
  currentLang = "en";
  translations: FakeTranslations = undefined;
  defaultTranslations: FakeTranslations = undefined;
}

function mountChatModal(): ChatModal {
  if (!customElements.get("chat-modal")) {
    customElements.define("chat-modal", ChatModal);
  }
  const modal = document.createElement("chat-modal") as ChatModal;
  document.body.appendChild(modal);
  return modal;
}

describe("englishChatFallback", () => {
  it("resolves a dotted chat.* key against resources/lang/en.json verbatim", () => {
    expect(englishChatFallback("chat.category")).toBe("Category");
    expect(englishChatFallback("chat.cat.help")).toBe("Help");
    expect(englishChatFallback("chat.build")).toBe("Build your message...");
    expect(englishChatFallback("chat.send")).toBe("Send");
    expect(englishChatFallback("chat.help.troops")).toBe(
      "Please give me troops!",
    );
  });

  it("returns the key itself if the path doesn't resolve to a string", () => {
    expect(englishChatFallback("chat.does_not_exist")).toBe(
      "chat.does_not_exist",
    );
    expect(englishChatFallback("chat.cat")).toBe("chat.cat"); // resolves to an object, not a string
  });
});

describe("retired quick-chat compatibility", () => {
  it("parses the historical Warship key without offering it in new menus", () => {
    expect(QuickChatKeySchema.safeParse("attack.build_warships").success).toBe(
      true,
    );
    expect(
      quickChatPhrases.attack.some((phrase) => phrase.key === "build_warships"),
    ).toBe(false);
  });
});

describe("ChatModal quick-chat i18n fallback without <lang-selector>", () => {
  let modal: ChatModal;

  afterEach(() => {
    modal?.remove();
  });

  it("renders real English text instead of raw i18n keys for every QA-reported leak site", async () => {
    modal = mountChatModal();
    await modal.updateComplete;

    const text = modal.textContent ?? "";
    // None of the leaked raw keys survive as literal text.
    expect(text).not.toMatch(/chat\.[a-z_]+(\.[a-z_]+)?/);

    expect(text).toContain("Category");
    expect(text).toContain("Help");
    expect(text).toContain("Attack");
    expect(text).toContain("Defend");
    expect(text).toContain("Greetings");
    expect(text).toContain("Miscellaneous");
    expect(text).toContain("Warnings");
    expect(text).toContain("Build your message...");
    expect(text).toContain("Send");

    const oModal = modal.querySelector("o-modal") as unknown as {
      title: string;
    };
    expect(oModal.title).toBe("Quick Chat");
  });

  it("falls back to real English for a dynamic phrase key (chat.<category>.<phrase>) once a phrase is selected — the leak class extends beyond the 4 statically-listed keys", async () => {
    modal = mountChatModal();
    await modal.updateComplete;

    modal.openWithSelection("help", "troops");
    await modal.updateComplete;

    const text = modal.textContent ?? "";
    expect(text).toContain("Please give me troops!");
    expect(text).not.toMatch(/chat\.[a-z_]+(\.[a-z_]+)?/);
  });
});

describe("ChatModal quick-chat i18n — bootstrapped, translated shell (league origin)", () => {
  let modal: ChatModal;
  let langSelector: FakeLangSelector;

  afterEach(() => {
    modal?.remove();
    langSelector?.remove();
  });

  it("shows the real translated text once <lang-selector> has loaded — defaultText never overrides a resolved translation", async () => {
    if (!customElements.get("lang-selector")) {
      customElements.define("lang-selector", FakeLangSelector);
    }
    langSelector = document.createElement("lang-selector") as FakeLangSelector;
    langSelector.currentLang = "fr";
    langSelector.translations = {
      "chat.title": "Chat rapide",
      "chat.category": "Catégorie",
      "chat.cat.help": "Aide",
      "chat.cat.attack": "Attaque",
      "chat.cat.defend": "Défendre",
      "chat.cat.greet": "Salutations",
      "chat.cat.misc": "Divers",
      "chat.cat.warnings": "Avertissements",
      "chat.build": "Construisez votre message...",
      "chat.send": "Envoyer",
    };
    document.body.appendChild(langSelector);

    modal = mountChatModal();
    await modal.updateComplete;

    const text = modal.textContent ?? "";
    expect(text).toContain("Catégorie");
    expect(text).toContain("Aide");
    expect(text).toContain("Construisez votre message...");
    expect(text).toContain("Envoyer");
    // Real translation wins — the English default text must not leak in.
    expect(text).not.toContain("Build your message...");

    const oModal = modal.querySelector("o-modal") as unknown as {
      title: string;
    };
    expect(oModal.title).toBe("Chat rapide");
  });
});
