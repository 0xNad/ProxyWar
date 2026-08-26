import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  requestUpdateWhenTranslationsReady,
} from "./AppShellChrome";
import { fetchReadModel, type ReadModel } from "./ReadModelSchema";

type LoadState = "loading" | "ready" | "error";

/**
 * `/about` — static factual copy about what Proxy War is and how a round
 * works, per the overhaul spec §4 ("+ About/How it works..."). No route
 * attribute: this page is not parameterized like `player-profile-page`.
 *
 * The copy here is intentionally narrow: only claims explicitly cleared by
 * the product contract (persistent ranked league, agent-vs-agent
 * territorial wars, ~40 minute rounds, up-to-16-seat matches, direct
 * Competition entry, Coworld + OpenFront/AGPL credits,
 * self-serve entry). It does NOT claim deception is measured, betrayal is
 * directly observable, any "longest horizon"/"most agents"/"only
 * persistent multi-agent LLM environment" superlative, any venue/
 * peer-review implication, any model-coverage claim, or any inference of
 * which model/provider a policy label maps to. Every link is either a
 * real internal route (`/league`, `/watch`) or the read model's own
 * `enterTheLeagueUrl` — never a placeholder.
 *
 * The read model fetch is optional polish only (a live agent count and the
 * real "enter the league" URL for the entry CTA and the setup question
 * below) — every other section renders identically whether or not the
 * fetch succeeds, so a cold `connectedCallback()` on a directly-loaded
 * page never blocks on it.
 */
@customElement("about-page")
export class AboutPage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private readModel: ReadModel | null = null;

  createRenderRoot() {
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    requestUpdateWhenTranslationsReady(this);
  }

  private async load(): Promise<void> {
    this.loadState = "loading";
    try {
      this.readModel = await fetchReadModel();
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader("/about", undefined, this.readModel?.links.accountUrl)}
      <main class="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 class="mb-4 text-2xl font-bold text-ink">
          ${translateText("about.title")}
        </h1>
        <p class="mb-2 text-sm leading-relaxed text-ink-muted">
          ${translateText("about.intro")}
        </p>
        <p class="mb-2 text-sm leading-relaxed text-ink-muted">
          ${translateText("about.determinism_note")}
        </p>
        ${this.renderParticipantNote()}

        <section aria-labelledby="about-how-it-works-heading" class="mt-8">
          <h2
            id="about-how-it-works-heading"
            class="mb-3 text-lg font-bold text-ink"
          >
            ${translateText("about.how_it_works_heading")}
          </h2>

          <h3
            class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted"
          >
            ${translateText("about.match_heading")}
          </h3>
          <ol
            class="mb-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink-muted"
          >
            ${this.renderSteps([
              ["about.match_step_1_label", "about.match_step_1_text"],
              ["about.match_step_2_label", "about.match_step_2_text"],
              ["about.match_step_3_label", "about.match_step_3_text"],
              ["about.match_step_4_label", "about.match_step_4_text"],
              ["about.match_step_5_label", "about.match_step_5_text"],
            ])}
          </ol>
          <p class="mb-6 text-sm font-semibold leading-relaxed text-ink">
            ${translateText("about.match_constraint")}
          </p>
          <p class="text-sm leading-relaxed text-ink-muted">
            ${translateText("about.policy_label_intro")}
            <code class="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs"
              >daveey-proxywar:v24</code
            >
            ${translateText("about.policy_label_outro")}
          </p>

          <h3
            class="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-ink-muted"
          >
            ${translateText("about.league_heading")}
          </h3>
          <p class="mb-2 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.league_round_cycle")}
          </p>
          <p class="mb-2 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.league_rating")}
          </p>
          <p class="mb-2 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.league_rank")}
          </p>
          <p class="text-sm leading-relaxed text-ink-muted">
            ${translateText("about.league_retention")}
          </p>
        </section>

        <section aria-labelledby="about-roles-heading" class="mt-8">
          <h2 id="about-roles-heading" class="mb-3 text-lg font-bold text-ink">
            ${translateText("about.roles_heading")}
          </h2>
          <dl class="space-y-3 text-sm leading-relaxed text-ink-muted">
            <div>
              <dt class="font-bold text-ink">
                ${translateText("about.roles_builder_label")}
              </dt>
              <dd>${translateText("about.roles_builder_text")}</dd>
            </div>
            <div>
              <dt class="font-bold text-ink">
                ${translateText("about.roles_agent_label")}
              </dt>
              <dd>${translateText("about.roles_agent_text")}</dd>
            </div>
            <div>
              <dt class="font-bold text-ink">
                ${translateText("about.roles_agent_version_label")}
              </dt>
              <dd>${translateText("about.roles_agent_version_text")}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="about-self-serve-heading" class="mt-8">
          <h2
            id="about-self-serve-heading"
            class="mb-3 text-lg font-bold text-ink"
          >
            ${translateText("about.self_serve_heading")}
          </h2>
          <ol
            class="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink-muted"
          >
            ${this.renderSteps([
              ["about.self_serve_step_1_label", "about.self_serve_step_1_text"],
              ["about.self_serve_step_2_label", "about.self_serve_step_2_text"],
              ["about.self_serve_step_3_label", "about.self_serve_step_3_text"],
              ["about.self_serve_step_4_label", "about.self_serve_step_4_text"],
              ["about.self_serve_step_5_label", "about.self_serve_step_5_text"],
            ])}
          </ol>
          <div class="mt-4">${this.renderEntryCta()}</div>
        </section>

        <section aria-labelledby="about-softmax-heading" class="mt-8">
          <h2
            id="about-softmax-heading"
            class="mb-2 text-lg font-bold text-ink"
          >
            ${translateText("about.softmax_heading")}
          </h2>
          <p class="mb-3 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.softmax_intro")}
          </p>
          <ul
            class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-muted"
          >
            <li>${translateText("about.softmax_execution")}</li>
            <li>${translateText("about.softmax_infrastructure")}</li>
            <li>${translateText("about.softmax_authority")}</li>
          </ul>
        </section>

        <section aria-labelledby="about-limitations-heading" class="mt-8">
          <h2
            id="about-limitations-heading"
            class="mb-2 text-lg font-bold text-ink"
          >
            ${translateText("about.limitations_heading")}
          </h2>
          <p class="mb-2 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.limitations_reasoning")}
          </p>
          <p class="mb-2 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.limitations_recovered_turns")}
          </p>
          <p class="text-sm leading-relaxed text-ink-muted">
            ${translateText("about.limitations_data_availability")}
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
          <p class="mt-2 text-sm leading-relaxed text-ink-muted">
            ${translateText("about.credits_auditable")}
          </p>
        </section>

        <section aria-labelledby="about-questions-heading" class="mt-8">
          <h2
            id="about-questions-heading"
            class="mb-3 text-lg font-bold text-ink"
          >
            ${translateText("about.questions_heading")}
          </h2>
          <dl class="space-y-3 text-sm leading-relaxed text-ink-muted">
            <div>
              <dt class="font-bold text-ink">
                ${translateText("about.questions_setup_label")}
              </dt>
              <dd>${this.renderSetupAnswer()}</dd>
            </div>
            <div>
              <dt class="font-bold text-ink">
                ${translateText("about.questions_league_label")}
              </dt>
              <dd>
                ${translateText("about.questions_league_text")}
                <a
                  href="/league"
                  class="font-semibold text-ink-muted underline decoration-line outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
                  >${translateText("about.questions_league_link")}</a
                >
              </dd>
            </div>
            <div>
              <dt class="font-bold text-ink">
                ${translateText("about.questions_watch_label")}
              </dt>
              <dd>
                ${translateText("about.questions_watch_text")}
                <a
                  href="/watch"
                  class="font-semibold text-ink-muted underline decoration-line outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
                  >${translateText("about.questions_watch_link")}</a
                >
              </dd>
            </div>
            <div>
              <dt class="font-bold text-ink">
                ${translateText("about.questions_code_label")}
              </dt>
              <dd>${translateText("about.questions_code_text")}</dd>
            </div>
          </dl>
        </section>

        <p class="mt-10 text-sm font-semibold leading-relaxed text-ink">
          ${translateText("about.closing")}
        </p>
      </main>
      ${appShellFooter()}
    `;
  }

  /** Renders a numbered-step list from [labelKey, textKey] pairs — shared by "A Single Match" and "The Self-Serve Path". */
  private renderSteps(
    steps: ReadonlyArray<readonly [string, string]>,
  ): TemplateResult[] {
    return steps.map(
      ([labelKey, textKey]) => html`
        <li>
          <span class="font-semibold text-ink"
            >${translateText(labelKey)}.</span
          >
          ${translateText(textKey)}
        </li>
      `,
    );
  }

  private renderParticipantNote() {
    if (this.loadState !== "ready" || this.readModel === null) return nothing;
    const count = this.readModel.agents.length;
    return html`<p class="mb-6 text-xs text-ink-muted">
      ${translateText("about.participant_note", { count })}
    </p>`;
  }

  /** The "Technical setup?" answer links to the real, live enter-the-league URL when loaded — never a placeholder. */
  private renderSetupAnswer() {
    if (this.loadState === "ready" && this.readModel !== null) {
      return html`${translateText("about.questions_setup_text")}
        <a
          href=${this.readModel.links.enterTheLeagueUrl}
          class="font-semibold text-ink-muted underline decoration-line outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("about.questions_setup_link")}</a
        >`;
    }
    return html`${translateText("about.questions_setup_text")}`;
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
