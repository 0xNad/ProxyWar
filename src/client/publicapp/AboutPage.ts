import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
} from "./AppShellChrome";
import { fetchReadModel, type ReadModel } from "./ReadModelSchema";
import { translateText } from "../Utils";

type LoadState = "loading" | "ready" | "error";

/**
 * `/about` — static factual copy about what Proxy War is and how a round
 * works, per the overhaul spec §4 ("+ About/How it works..."). No route
 * attribute: this page is not parameterized like `player-profile-page`.
 *
 * The copy here is intentionally narrow: only claims explicitly cleared by
 * the product contract (persistent ranked league, agent-vs-agent
 * territorial wars, ~30 minute rounds, Coworld + OpenFront/AGPL credits,
 * self-serve entry). It does NOT claim deception is measured, betrayal is
 * directly observable, any "longest horizon"/"most agents"/"only
 * persistent multi-agent LLM environment" superlative, any venue/
 * peer-review implication, any model-coverage claim, or any inference of
 * which model/provider a policy label maps to.
 *
 * The read model fetch is optional polish only (a live agent count and the
 * real "enter the league" URL for the entry CTA) — every other section
 * renders identically whether or not the fetch succeeds, so a cold
 * `connectedCallback()` on a directly-loaded page never blocks on it.
 */
@customElement("about-page")
export class AboutPage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private readModel: ReadModel | null = null;

  createRenderRoot() {
    // Light DOM: this page fully replaces `document.body` and renders its
    // own app-shell header/footer, so page-level Tailwind must apply here
    // (see `AppShellChrome.ts` module doc and `APP_SHELL_ROOT_CLASSES`).
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loadState = "loading";
    try {
      this.readModel = await fetchReadModel();
      this.loadState = "ready";
    } catch {
      // Static copy still renders in full; only the live agent count and
      // the entry CTA's real URL fall back to honest placeholders below.
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader("/about")}
      <main class="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 class="mb-4 text-2xl font-bold text-ink">
          ${translateText("about.title")}
        </h1>
        <p class="mb-2 text-sm leading-relaxed text-ink-muted">
          ${translateText("about.intro")}
        </p>
        ${this.renderParticipantNote()}

        <section aria-labelledby="about-how-it-works-heading" class="mt-8">
          <h2
            id="about-how-it-works-heading"
            class="mb-2 text-lg font-bold text-ink"
          >
            ${translateText("about.how_it_works_heading")}
          </h2>
          <p class="mb-3 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.how_it_works_body")}
          </p>
          <p class="text-sm leading-relaxed text-ink-muted">
            ${translateText("about.policy_label_intro")}
            <code class="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs"
              >daveey-proxywar:v24</code
            >
            ${translateText("about.policy_label_outro")}
          </p>
        </section>

        <section aria-labelledby="about-credits-heading" class="mt-8">
          <h2
            id="about-credits-heading"
            class="mb-2 text-lg font-bold text-ink"
          >
            ${translateText("about.credits_heading")}
          </h2>
          <ul class="list-disc space-y-1 pl-5 text-sm text-ink-muted">
            <li>${translateText("about.credit_coworld")}</li>
            <li>${translateText("about.credit_openfront")}</li>
            <li>
              ${translateText("about.credit_source_label")}
              <a
                href="https://github.com/0xNad/ProxyWar"
                class="font-semibold text-ink-muted underline decoration-line outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
                >github.com/0xNad/ProxyWar</a
              >
            </li>
          </ul>
        </section>

        <section aria-labelledby="about-entry-heading" class="mt-8">
          <h2
            id="about-entry-heading"
            class="mb-2 text-lg font-bold text-ink"
          >
            ${translateText("about.entry_heading")}
          </h2>
          <p class="mb-3 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.entry_body")}
          </p>
          ${this.renderEntryCta()}
        </section>
      </main>
      ${appShellFooter()}
    `;
  }

  private renderParticipantNote() {
    if (this.loadState !== "ready" || this.readModel === null) return nothing;
    const count = this.readModel.agents.length;
    return html`<p class="mb-6 text-xs text-ink-muted">
      ${translateText("about.participant_note", { count })}
    </p>`;
  }

  private renderEntryCta() {
    if (this.loadState === "ready" && this.readModel !== null) {
      return html`<a
        href=${this.readModel.links.enterTheLeagueUrl}
        class="inline-flex items-center rounded-md border border-accent bg-accent px-4 py-2 text-sm font-bold text-on-accent no-underline outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
        >${translateText("about.entry_cta")}</a
      >`;
    }
    return html`<p class="text-sm text-ink-muted">
      ${translateText("about.entry_fallback_note")}
    </p>`;
  }
}
