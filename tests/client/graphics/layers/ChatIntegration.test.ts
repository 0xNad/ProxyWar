/**
 * Coverage for the quick-chat raw-i18n-key leak in the RADIAL MENU surface
 * (`ChatIntegration.createQuickChatMenu`) — the sibling of the `ChatModal`
 * leak (see `ChatModal.test.ts`) that QA's 4-pass reproduction on
 * bet.proxywar.xyz also covers: the same category/phrase labels feed both
 * the modal AND the radial menu's visible + accessible (`name`) text.
 * Uses the REAL `translateText()` (not mocked) against no `<lang-selector>`
 * at all, reproducing the unbootstrapped `/bet` SPA shell per
 * `docs/BETTING_HANDOFF.md` §3.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../../../src/core/EventBus";
import { GameView, PlayerView } from "../../../../src/core/game/GameView";
import { ChatIntegration } from "../../../../src/client/graphics/layers/ChatIntegration";
import { ChatModal } from "../../../../src/client/graphics/layers/ChatModal";
import { MenuElementParams } from "../../../../src/client/graphics/layers/RadialMenuElements";

describe("ChatIntegration quick-chat radial menu i18n fallback — unbootstrapped shell (no <lang-selector>)", () => {
  let integration: ChatIntegration;
  let chatModalEl: ChatModal;
  let mockPlayer: PlayerView;
  let mockGame: GameView;
  let mockEventBus: EventBus;

  beforeEach(() => {
    if (!customElements.get("chat-modal")) {
      customElements.define("chat-modal", ChatModal);
    }
    chatModalEl = document.createElement("chat-modal") as ChatModal;
    document.body.appendChild(chatModalEl);

    mockPlayer = { id: () => "p1" } as unknown as PlayerView;
    mockGame = { myPlayer: () => mockPlayer } as unknown as GameView;
    mockEventBus = { emit: () => {} } as unknown as EventBus;

    integration = new ChatIntegration(mockGame, mockEventBus);
  });

  afterEach(() => {
    chatModalEl.remove();
  });

  it("renders real English category and phrase labels, never raw chat.* keys", () => {
    const menu = integration.createQuickChatMenu(mockPlayer);

    const categoryNames = menu.map((item) => item.name);
    expect(categoryNames).toContain("Help");
    expect(categoryNames).toContain("Attack");
    expect(categoryNames).toContain("Defend");
    expect(categoryNames).toContain("Greetings");
    expect(categoryNames).toContain("Miscellaneous");
    expect(categoryNames).toContain("Warnings");
    for (const name of categoryNames) {
      expect(name).not.toMatch(/chat\.[a-z_]+(\.[a-z_]+)?/);
    }

    const helpCategory = menu.find((item) => item.name === "Help")!;
    const phraseItems = helpCategory.subMenu!(
      {} as unknown as MenuElementParams,
    );
    const phraseNames = phraseItems.map((item) => item.name);
    expect(phraseNames).toContain("Please give me troops!");
    for (const name of phraseNames) {
      expect(name).not.toMatch(/chat\.[a-z_]+(\.[a-z_]+)?/);
    }
  });
});
