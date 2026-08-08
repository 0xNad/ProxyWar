import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";

function endedText(key: string, defaultText: string): string {
  return translateText(`premiere_ended.${key}`, undefined, defaultText);
}

/** Honest destination for a stale or retired premiere link. */
@customElement("premiere-ended-page")
export class PremiereEndedPage extends LitElement {
  @property({ type: String, attribute: "premiere-id" }) premiereId = "";

  createRenderRoot() {
    this.classList.add("block", "w-full", "grow");
    return this;
  }

  render() {
    return html`
      <div
        class="flex min-h-screen flex-col items-center bg-surface px-4 py-10 text-ink sm:px-6"
      >
        <div class="flex w-full max-w-md flex-col gap-6">
          <header>
            <a
              href="/"
              class="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden="true">‹</span> Proxy War
            </a>
          </header>
          <div
            class="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 p-6 text-center"
          >
            <h1 class="text-xl font-bold text-ink">
              ${endedText("title", "This premiere has ended")}
            </h1>
            <p class="text-sm text-ink-muted">
              ${endedText(
                "body",
                "This match is no longer live, and this link no longer has a replay available.",
              )}
            </p>
          </div>
          <a
            href="/league"
            class="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >
            ${endedText("cta", "Go to the league")}
          </a>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "premiere-ended-page": PremiereEndedPage;
  }
}
