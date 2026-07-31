import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
} from "./AppShellChrome";
import { fetchReadModel, PublicAgent, ReadModel } from "./ReadModelSchema";
import { translateText } from "../Utils";

type LoadState = "loading" | "ready" | "error";

/**
 * `/agents` — the full public roster: every league participant the read
 * model knows about, registered or not. `ReadModel.agents` already merges
 * standings-seen players with any registered Agent standings skipped this
 * cycle (see `ProxyWarPublicReadModel.publicAgents`'s doc), so this page
 * adds no cross-referencing of its own, only sorting and rendering.
 *
 * Sorted by standing rank ascending first (the live competitive order,
 * `sortAgentsForRoster` below) — unranked/unregistered participants after,
 * in their original read-model order. Never re-sorted alphabetically: this
 * reads as a leaderboard, not a phone book.
 *
 * Same identity discipline as `BuilderProfilePage.renderAgentRow`: an
 * unregistered participant (`registered === false`) shows only its raw
 * `playerName`, never an emblem, short code, or builder line, and never a
 * profile link — its `slug` is null, so there is nowhere to link it to.
 */
@customElement("agents-directory-page")
export class AgentsDirectoryPage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private agents: ReadonlyArray<PublicAgent> = [];

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `PlayerProfilePage`/`BuilderProfilePage`.
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
      const readModel: ReadModel = await fetchReadModel();
      this.agents = sortAgentsForRoster(readModel.agents);
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader("/agents")}
      <main class="mx-auto w-full max-w-5xl px-4 py-8">
        <h1 class="mb-5 text-xl font-bold text-ink">${translateText("agents_directory.title")}</h1>
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "ready" ? this.renderRoster(this.agents) : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("agents_directory.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("agents_directory.error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("agents_directory.retry")}
        </button>
      </div>
    `;
  }

  private renderRoster(agents: ReadonlyArray<PublicAgent>) {
    if (agents.length === 0) {
      return html`<p class="text-sm text-ink-muted">
        ${translateText("agents_directory.empty")}
      </p>`;
    }
    return html`
      <ul
        role="list"
        class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        ${agents.map((agent) => this.renderAgentCard(agent))}
      </ul>
    `;
  }

  private renderAgentCard(agent: PublicAgent): TemplateResult {
    const label = agent.registered ? agent.displayName : agent.playerName;
    const href =
      agent.registered && agent.slug !== null
        ? `/agent/${encodeURIComponent(agent.slug)}`
        : null;
    const cardClasses =
      "flex h-full flex-col gap-2 rounded-md border border-line bg-surface-2 px-4 py-3 text-sm";
    const content = html`
      <div class="flex flex-wrap items-center gap-2">
        ${agent.registered && agent.emblemSvg !== null
          ? html`<span
              class="inline-flex h-8 w-8 shrink-0 overflow-hidden"
              aria-hidden="true"
              >${unsafeSVG(agent.emblemSvg)}</span
            >`
          : nothing}
        <span class="font-semibold text-ink">${label}</span>
        ${agent.registered && agent.shortCode !== null
          ? html`<span class="font-mono text-xs text-ink-muted"
              >${agent.shortCode}</span
            >`
          : nothing}
        ${agent.status === "house"
          ? html`<span
              class="rounded-full border border-caution/40 bg-caution/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-caution"
              title=${translateText("agents_directory.house_badge_title")}
              >${translateText("agents_directory.house_badge")}</span
            >`
          : nothing}
      </div>
      ${this.renderBuilderLine(agent)}
      <div
        class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted"
      >
        ${agent.standing !== null
          ? html`<span class="font-mono"
              >#${agent.standing.rank}${agent.standing.score !== null
                ? html` · ${agent.standing.score.toFixed(2)}`
                : nothing}</span
            >`
          : nothing}
        ${agent.activeVersion !== null
          ? html`<span class="font-mono"
              >${agent.activeVersion.publicVersionLabel}</span
            >`
          : nothing}
      </div>
    `;
    return html`
      <li>
        ${href !== null
          ? html`<a
              href=${href}
              class="${cardClasses} no-underline outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent"
              >${content}</a
            >`
          : html`<div class="${cardClasses}">${content}</div>`}
      </li>
    `;
  }

  /** `builderDisplayName` or an honest "Unclaimed" — never rendered for an unregistered participant (no builder concept applies) or a house agent (the House badge above already covers that classification, matching `CoworldLeagueSiteWriter.builderNoteMarkup`'s rule). */
  private renderBuilderLine(agent: PublicAgent) {
    if (!agent.registered || agent.status === "house") return nothing;
    const label = agent.builderDisplayName ?? translateText("agents_directory.unclaimed");
    return html`<span class="text-xs text-ink-muted">${label}</span>`;
  }
}

/** Stable sort (native `Array.prototype.sort` is spec-guaranteed stable) by `standing.rank` ascending, pushing unranked/unregistered agents to the end in their original read-model order — never re-sorted by name. */
function sortAgentsForRoster(agents: readonly PublicAgent[]): PublicAgent[] {
  return [...agents].sort((a, b) => {
    const rankA = a.standing?.rank ?? Number.POSITIVE_INFINITY;
    const rankB = b.standing?.rank ?? Number.POSITIVE_INFINITY;
    return rankA - rankB;
  });
}
