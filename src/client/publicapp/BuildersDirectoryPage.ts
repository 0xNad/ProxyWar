import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
} from "./AppShellChrome";
import {
  fetchReadModel,
  PublicAgent,
  PublicBuilder,
  ReadModel,
} from "./ReadModelSchema";
import { translateText } from "../Utils";

type LoadState = "loading" | "ready" | "error";

/**
 * Computed at RENDER time, never at module-import time: `translateText()`
 * calls made while the module first evaluates (before `<lang-selector>`
 * has even fetched its translations, since that's an async operation
 * kicked off separately) would freeze on the raw key forever — Lit only
 * re-invokes `render()`, never re-evaluates module-level constants. Every
 * OTHER `translateText()` call on this page already runs inside `render()`
 * or its helpers, gated behind `fetchReadModel()`'s own network round
 * trip, which is why only this one needed fixing — see the
 * `builders-directory` browser-verification note in this component's
 * history for how this was actually caught (live, not by the mocked-
 * translateText unit tests, which can't see the timing at all).
 */
function statusBadge(status: PublicBuilder["status"]): {
  label: string;
  cls: string;
} {
  switch (status) {
    case "verified":
      return {
        label: translateText("builders_directory.status_verified"),
        cls: "border-positive/40 bg-positive/10 text-positive",
      };
    case "house":
      return {
        label: translateText("builders_directory.status_house"),
        cls: "border-caution/40 bg-caution/10 text-caution",
      };
    case "unclaimed":
      return {
        label: translateText("builders_directory.status_unclaimed"),
        cls: "border-line bg-surface-2 text-ink-muted",
      };
  }
}

/**
 * `/builders` — the public builders directory (spec §4's fifth primary nav
 * destination, Stage 6 item 3). Builder identity in this overhaul is
 * claim-gated: a `PublicBuilder` only exists once a claim has been
 * verified — never invented from an agent's raw `builderDisplayName`
 * (see `IdentitySchemas.ts`'s module doc). As of this component shipping,
 * 0 `BuilderProfile`s have been seeded, so a directory that only ever
 * lists `ReadModel.builders` would show nothing but empty copy despite 17
 * real registered agents existing.
 *
 * Instead this page tells the FULL truthful story in two parts:
 * (1) any REAL claimed builders (`ReadModel.builders`, still linking to
 * `/builder/:slug` exactly as before), and (2) an honest UNCLAIMED-slot
 * card per registered agent with no claim yet (`PublicAgent.builderId ===
 * null`) — never a fabricated `BuilderProfile`, just the true "this
 * agent's operator hasn't verified a claim" state, plus a verification
 * explainer pointing at the real onboarding entry point
 * (`ReadModel.links.enterTheLeagueUrl` — there is no `/build` route to
 * link instead; see this file's own history for that check). House
 * agents (operator/Softmax baseline) are excluded from the unclaimed
 * list entirely — "house" is an intentional ownership state, not a claim
 * waiting to happen, same distinction `AgentProfilePage.ts`'s builder
 * line already draws.
 */
@customElement("builders-directory-page")
export class BuildersDirectoryPage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private readModel: ReadModel | null = null;

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `PlayerProfilePage`/`PremiereAccountPage`.
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
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader("/builders", undefined, this.readModel?.links.accountUrl)}
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        <h1 class="mb-2 text-xl font-bold text-ink">
          ${translateText("builders_directory.title")}
        </h1>
        <p class="mb-6 text-sm text-ink-muted">
          ${translateText("builders_directory.subtitle")}
        </p>
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "ready" && this.readModel !== null
          ? this.renderDirectory(this.readModel)
          : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("builders_directory.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("builders_directory.error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("builders_directory.retry")}
        </button>
      </div>
    `;
  }

  private renderDirectory(readModel: ReadModel) {
    const registeredAgents = readModel.agents.filter(
      (agent): agent is PublicAgent & { slug: string } => agent.slug !== null,
    );
    const unclaimedAgents = registeredAgents.filter(
      (agent) => agent.builderId === null && agent.status !== "house",
    );
    if (readModel.builders.length === 0 && registeredAgents.length === 0) {
      return html`
        <p
          class="rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted"
        >
          ${translateText("builders_directory.empty")}
        </p>
      `;
    }
    return html`
      ${this.renderVerificationExplainer(readModel.links.enterTheLeagueUrl)}
      <h2 class="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-ink-muted">
        ${translateText("builders_directory.claimed_heading")}
      </h2>
      ${readModel.builders.length > 0
        ? html`
            <ul class="flex flex-col gap-2" role="list">
              ${readModel.builders.map((builder) =>
                this.renderBuilderRow(builder),
              )}
            </ul>
          `
        : html`
            <p
              class="rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted"
            >
              ${translateText("builders_directory.claimed_empty")}
            </p>
          `}
      ${unclaimedAgents.length > 0
        ? html`
            <details open class="mt-8 border-t border-line pt-4">
              <summary
                class="cursor-pointer text-xs font-bold uppercase tracking-wide text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                ${translateText("builders_directory.unclaimed_heading")}
                (${unclaimedAgents.length})
              </summary>
              <ul class="mt-2 flex flex-col gap-2" role="list">
                ${unclaimedAgents.map((agent) =>
                  this.renderUnclaimedAgentSlot(agent),
                )}
              </ul>
            </details>
          `
        : nothing}
    `;
  }

  /**
   * Explains WHY so many slots read "Unclaimed" (claim-gated verification,
   * never a name/email match — same invariant `IdentityMatching.ts`
   * enforces), points at the real self-serve `/claim` flow (Season Zero
   * activation Phase 3) for someone who already has an agent, and links
   * the external onboarding entry point (`enterTheLeagueUrl`) for someone
   * who hasn't entered the league at all yet — two different CTAs for two
   * different visitors, never conflated.
   */
  private renderVerificationExplainer(enterTheLeagueUrl: string) {
    return html`
      <div
        class="rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted"
      >
        <p>${translateText("builders_directory.verification_explainer")}</p>
        <a
          href="/claim"
          class="mt-2 inline-block text-xs font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("builders_directory.claim_cta")}</a
        >
        <a
          href=${enterTheLeagueUrl}
          class="mt-2 ml-4 inline-block text-xs font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("builders_directory.verification_cta")}</a
        >
      </div>
    `;
  }

  private renderUnclaimedAgentSlot(
    agent: PublicAgent & { slug: string },
  ): TemplateResult {
    const badge = statusBadge("unclaimed");
    return html`
      <li>
        <a
          href="/agent/${encodeURIComponent(agent.slug)}"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm no-underline outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span class="font-semibold text-ink">${agent.displayName}</span>
          <span
            class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
            >${badge.label}</span
          >
        </a>
      </li>
    `;
  }

  private renderBuilderRow(builder: PublicBuilder): TemplateResult {
    const badge = statusBadge(builder.status);
    const label = builder.displayName ?? builder.slug;
    return html`
      <li>
        <a
          href="/builder/${encodeURIComponent(builder.slug)}"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm no-underline outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span class="font-semibold text-ink">${label}</span>
          <span
            class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
            >${badge.label}</span
          >
          ${builder.shortBio !== null
            ? html`<span class="basis-full text-xs text-ink-muted"
                >${builder.shortBio}</span
              >`
            : nothing}
        </a>
      </li>
    `;
  }
}
