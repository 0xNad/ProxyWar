import { LitElement, html } from "lit";
import { customElement, query } from "lit/decorators.js";

import { PlayerType } from "../../../core/game/Game";
import { GameView, PlayerView } from "../../../core/game/GameView";

import enTranslations from "resources/lang/en.json";
import quickChatData from "resources/QuickChat.json";
import { EventBus } from "../../../core/EventBus";
import { CloseViewEvent } from "../../InputHandler";
import { SendQuickChatEvent } from "../../Transport";
import { translateText } from "../../Utils";

export type QuickChatPhrase = {
  key: string;
  requiresPlayer: boolean;
};

export type QuickChatPhrases = Record<string, QuickChatPhrase[]>;

// Keep retired keys in the schema for historical replay compatibility, but do
// not offer them in new chat menus. Empty since warships returned (2026-08-16
// operator decision reversed the 2026-08-07 retirement); the mechanism stays
// for any future phrase retirement.
const retiredQuickChatKeys = new Set<string>();

export const quickChatPhrases: QuickChatPhrases = Object.fromEntries(
  Object.entries(quickChatData).map(([category, phrases]) => [
    category,
    phrases.filter(
      (phrase) => !retiredQuickChatKeys.has(`${category}.${phrase.key}`),
    ),
  ]),
);

/**
 * Best-effort English fallback for a dotted `chat.*` translation key, read
 * directly from `resources/lang/en.json` — the single source of truth for
 * these strings — instead of hand-duplicating ~50 quick-chat phrase
 * strings here where they'd drift. Passed as `translateText`'s
 * `defaultText` argument so this shared component renders real English
 * instead of a raw `chat.*` key when no translation can be resolved. Returns
 * `key` itself
 * if the path doesn't resolve to a string (keeps `translateText`'s own
 * no-default behavior as the worst case, never throws).
 */
export function englishChatFallback(key: string): string {
  let node: unknown = enTranslations;
  for (const segment of key.split(".")) {
    if (node !== null && typeof node === "object" && segment in node) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return key;
    }
  }
  return typeof node === "string" ? node : key;
}

@customElement("chat-modal")
export class ChatModal extends LitElement {
  @query("o-modal") private modalEl!: HTMLElement & {
    open: () => void;
    close: () => void;
  };

  createRenderRoot() {
    return this;
  }

  private players: PlayerView[] = [];

  private playerSearchQuery: string = "";
  private previewText: string | null = null;
  private requiresPlayerSelection: boolean = false;
  private selectedCategory: string | null = null;
  private selectedPhraseText: string | null = null;
  private selectedPhraseTemplate: string | null = null;
  private selectedQuickChatKey: string | null = null;
  private selectedPlayer: PlayerView | null = null;

  private recipient: PlayerView;
  private sender: PlayerView;
  public eventBus: EventBus;

  public g: GameView;

  quickChatPhrases: Record<
    string,
    Array<{ text: string; requiresPlayer: boolean }>
  > = {
    help: [{ text: "Please give me troops!", requiresPlayer: false }],
    attack: [{ text: "Attack [P1]!", requiresPlayer: true }],
    defend: [{ text: "Defend [P1]!", requiresPlayer: true }],
    greet: [{ text: "Hello!", requiresPlayer: false }],
    misc: [{ text: "Let's go!", requiresPlayer: false }],
  };

  public categories = [
    { id: "help" },
    { id: "attack" },
    { id: "defend" },
    { id: "greet" },
    { id: "misc" },
    { id: "warnings" },
  ];

  private getPhrasesForCategory(categoryId: string) {
    return quickChatPhrases[categoryId] ?? [];
  }

  render() {
    return html`
      <o-modal
        title="${translateText(
          "chat.title",
          undefined,
          englishChatFallback("chat.title"),
        )}"
      >
        <div class="chat-columns">
          <div class="chat-column">
            <div class="column-title">
              ${translateText(
                "chat.category",
                undefined,
                englishChatFallback("chat.category"),
              )}
            </div>
            ${this.categories.map(
              (category) => html`
                <button
                  class="chat-option-button ${this.selectedCategory ===
                  category.id
                    ? "selected"
                    : ""}"
                  @click=${() => this.selectCategory(category.id)}
                >
                  ${translateText(
                    `chat.cat.${category.id}`,
                    undefined,
                    englishChatFallback(`chat.cat.${category.id}`),
                  )}
                </button>
              `,
            )}
          </div>

          ${this.selectedCategory
            ? html`
                <div class="chat-column">
                  <div class="column-title">
                    ${translateText(
                      "chat.phrase",
                      undefined,
                      englishChatFallback("chat.phrase"),
                    )}
                  </div>
                  <div class="phrase-scroll-area">
                    ${this.getPhrasesForCategory(this.selectedCategory).map(
                      (phrase) => html`
                        <button
                          class="chat-option-button ${this
                            .selectedPhraseText ===
                          translateText(
                            `chat.${this.selectedCategory}.${phrase.key}`,
                            undefined,
                            englishChatFallback(
                              `chat.${this.selectedCategory}.${phrase.key}`,
                            ),
                          )
                            ? "selected"
                            : ""}"
                          @click=${() => this.selectPhrase(phrase)}
                        >
                          ${this.renderPhrasePreview(phrase)}
                        </button>
                      `,
                    )}
                  </div>
                </div>
              `
            : null}
          ${this.requiresPlayerSelection || this.selectedPlayer
            ? html`
                <div class="chat-column">
                  <div class="column-title">
                    ${translateText(
                      "chat.player",
                      undefined,
                      englishChatFallback("chat.player"),
                    )}
                  </div>

                  <input
                    class="player-search-input"
                    type="text"
                    placeholder="${translateText(
                      "chat.search",
                      undefined,
                      englishChatFallback("chat.search"),
                    )}"
                    .value=${this.playerSearchQuery}
                    @input=${this.onPlayerSearchInput}
                  />

                  <div class="player-scroll-area">
                    ${this.getSortedFilteredPlayers().map(
                      (player) => html`
                        <button
                          class="chat-option-button ${this.selectedPlayer ===
                          player
                            ? "selected"
                            : ""}"
                          style="border: 2px solid ${player
                            .territoryColor()
                            .toHex()};"
                          @click=${() => this.selectPlayer(player)}
                        >
                          ${player.displayName()}
                        </button>
                      `,
                    )}
                  </div>
                </div>
              `
            : null}
        </div>

        <div class="chat-preview">
          ${this.previewText
            ? translateText(
                this.previewText,
                undefined,
                englishChatFallback(this.previewText),
              )
            : translateText(
                "chat.build",
                undefined,
                englishChatFallback("chat.build"),
              )}
        </div>
        <div class="chat-send">
          <button
            class="chat-send-button"
            @click=${this.sendChatMessage}
            ?disabled=${!this.previewText ||
            (this.requiresPlayerSelection && !this.selectedPlayer)}
          >
            ${translateText(
              "chat.send",
              undefined,
              englishChatFallback("chat.send"),
            )}
          </button>
        </div>
      </o-modal>
    `;
  }

  initEventBus(eventBus: EventBus) {
    this.eventBus = eventBus;
    eventBus.on(CloseViewEvent, (e) => {
      if (!this.hidden) {
        this.close();
      }
    });
  }

  private selectCategory(categoryId: string) {
    this.selectedCategory = categoryId;
    this.selectedPhraseText = null;
    this.previewText = null;
    this.requiresPlayerSelection = false;
    this.requestUpdate();
  }

  private selectPhrase(phrase: QuickChatPhrase) {
    this.selectedQuickChatKey = this.getFullQuickChatKey(
      this.selectedCategory!,
      phrase.key,
    );
    const phraseKey = `chat.${this.selectedCategory}.${phrase.key}`;
    this.selectedPhraseTemplate = translateText(
      phraseKey,
      undefined,
      englishChatFallback(phraseKey),
    );
    this.selectedPhraseText = translateText(
      phraseKey,
      undefined,
      englishChatFallback(phraseKey),
    );
    this.previewText = phraseKey;
    this.requiresPlayerSelection = phrase.requiresPlayer;
    this.requestUpdate();
  }

  private renderPhrasePreview(phrase: { key: string }) {
    const phraseKey = `chat.${this.selectedCategory}.${phrase.key}`;
    return translateText(phraseKey, undefined, englishChatFallback(phraseKey));
  }

  private selectPlayer(player: PlayerView) {
    if (this.previewText) {
      this.previewText =
        this.selectedPhraseTemplate?.replace("[P1]", player.displayName()) ??
        null;
      this.selectedPlayer = player;
      this.requiresPlayerSelection = false;
      this.requestUpdate();
    }
  }

  private sendChatMessage() {
    console.log("Sent message:", this.previewText);
    console.log("Sender:", this.sender);
    console.log("Recipient:", this.recipient);
    console.log("Key:", this.selectedQuickChatKey);

    if (this.sender && this.recipient && this.selectedQuickChatKey) {
      this.eventBus.emit(
        new SendQuickChatEvent(
          this.recipient,
          this.selectedQuickChatKey,
          this.selectedPlayer?.id(),
        ),
      );
    }

    this.previewText = null;
    this.selectedCategory = null;
    this.requiresPlayerSelection = false;
    this.close();

    this.requestUpdate();
  }

  private onPlayerSearchInput(e: Event) {
    const target = e.target as HTMLInputElement;
    this.playerSearchQuery = target.value.toLowerCase();
    this.requestUpdate();
  }

  private getSortedFilteredPlayers(): PlayerView[] {
    const sorted = [...this.players].sort((a, b) =>
      a.displayName().localeCompare(b.displayName()),
    );
    const filtered = sorted.filter((p) =>
      p.displayName().toLowerCase().includes(this.playerSearchQuery),
    );
    const others = sorted.filter(
      (p) => !p.displayName().toLowerCase().includes(this.playerSearchQuery),
    );
    return [...filtered, ...others];
  }

  private getFullQuickChatKey(category: string, phraseKey: string): string {
    return `${category}.${phraseKey}`;
  }

  public open(sender?: PlayerView, recipient?: PlayerView) {
    if (sender && recipient) {
      console.log("Sent message:", recipient);
      console.log("Sent message:", sender);
      this.players = this.g
        .players()
        .filter((p) => p.isAlive() && p.data.playerType !== PlayerType.Bot);

      this.recipient = recipient;
      this.sender = sender;
    }
    this.requestUpdate();
    this.modalEl?.open();
  }

  public close() {
    this.selectedCategory = null;
    this.selectedPhraseText = null;
    this.previewText = null;
    this.requiresPlayerSelection = false;
    this.modalEl?.close();
  }

  public setRecipient(value: PlayerView) {
    this.recipient = value;
  }

  public setSender(value: PlayerView) {
    this.sender = value;
  }

  public openWithSelection(
    categoryId: string,
    phraseKey: string,
    sender?: PlayerView,
    recipient?: PlayerView,
  ) {
    if (sender && recipient) {
      this.players = this.g
        .players()
        .filter((p) => p.isAlive() && p.data.playerType !== PlayerType.Bot);

      this.recipient = recipient;
      this.sender = sender;
    }

    this.selectCategory(categoryId);

    const phrase = this.getPhrasesForCategory(categoryId).find(
      (p) => p.key === phraseKey,
    );

    if (phrase) {
      this.selectPhrase(phrase);
    }

    this.requestUpdate();
    this.modalEl?.open();
  }
}
