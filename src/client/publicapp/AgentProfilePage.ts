import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import {
  renderAgentFormSection,
  renderAgentStatsSections,
  renderAnalysisTab,
} from "../AgentStatsSections";
import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
} from "./AppShellChrome";
import {
  fetchReadModel,
  PublicAgent,
  PublicMatch,
  ReadModel,
} from "./ReadModelSchema";

type LoadState = "loading" | "ready" | "not-found" | "error";
type Standing = NonNullable<PublicAgent["standing"]>;
type ActiveVersion = NonNullable<PublicAgent["activeVersion"]>;

const STATUS_BADGE: Record<
  PublicAgent["status"],
  { key: string; cls: string }
> = {
  verified: {
    key: "agent_profile.status_verified",
    cls: "border-positive/40 bg-positive/10 text-positive",
  },
  house: {
    key: "agent_profile.status_house",
    cls: "border-caution/40 bg-caution/10 text-caution",
  },
  unclaimed: {
    key: "agent_profile.status_unclaimed",
    cls: "border-line bg-surface-2 text-ink-muted",
  },
  unregistered: {
    key: "agent_profile.status_unregistered",
    cls: "border-line bg-surface-2 text-ink-muted",
  },
};

/**
 * `/agent/:slug` — a single agent's public profile. Finds its `PublicAgent`
 * by `slug` in the shared read model (same "one fetch, find by slug"
 * pattern as `BuilderProfilePage`), never a dedicated per-agent endpoint.
 *
 * A REGISTERED agent's `slug` always wins first. When no registered slug
 * matches, this ALSO checks every unregistered `PublicAgent`'s
 * `provisionalSlug` (see server `ProvisionalIdentity.ts`'s module doc) —
 * a real, currently-competing participant with no registry entry yet
 * still gets a working profile page (generated emblem, standing, recent
 * matches) instead of an honest-but-unhelpful not-found, closing the gap
 * the 2026-08-01 P0 production review found ("James Botts"/"Jordan"
 * rendering as anonymous broken cards everywhere, `/agent/james-botts`
 * 404ing). `renderNotFound` remains the correct, honest outcome only for
 * a slug matching NEITHER a registered nor a live provisional identity.
 *
 * `slug` is a `@property`, matching `PlayerProfilePage`'s `name` attribute
 * pattern — the server-rendered app-shell document sets it directly from
 * the route on a cold load, never assuming client-side navigation state.
 */
@customElement("agent-profile-page")
export class AgentProfilePage extends LitElement {
  @property({ type: String }) slug = "";

  @state() private loadState: LoadState = "loading";
  @state() private agent: PublicAgent | null = null;
  @state() private recentMatches: ReadonlyArray<PublicMatch> = [];
  @state() private accountUrl: string | null = null;
  @state() private generatedAt: string | null = null;

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
      this.accountUrl = readModel.links.accountUrl;
      this.generatedAt = readModel.generatedAt;
      const agent =
        readModel.agents.find((candidate) => candidate.slug === this.slug) ??
        readModel.agents.find(
          (candidate) =>
            !candidate.registered &&
            (candidate.provisionalSlug ?? null) === this.slug,
        ) ??
        null;
      if (agent === null) {
        this.agent = null;
        this.recentMatches = [];
        this.loadState = "not-found";
        return;
      }
      this.agent = agent;
      // A provisional identity has no `slug` (it's `null` by design — see
      // `ProxyWarPublicReadModel.ts`) to key `PublicMatch.participants[]`
      // against, which is resolved by `agentSlug` (a REGISTERED slug
      // only); fall back to matching this agent's own raw `playerName`
      // against `PublicMatchParticipant.displayName`, the one field every
      // participant carries regardless of registration.
      this.recentMatches = agent.registered
        ? recentMatchesForAgent(readModel.matches, this.slug)
        : recentMatchesForPlayerName(readModel.matches, agent.playerName);
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader("/agents", undefined, this.accountUrl ?? undefined)}
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "not-found" ? this.renderNotFound() : nothing}
        ${this.loadState === "ready" && this.agent !== null
          ? this.renderProfile(this.agent, this.recentMatches)
          : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("agent_profile.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("agent_profile.load_error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("agent_profile.try_again")}
        </button>
      </div>
    `;
  }

  private renderNotFound() {
    return html`
      <h1 class="mb-2 text-xl font-bold text-ink">${this.slug}</h1>
      <p class="text-sm text-ink-muted">
        ${translateText("agent_profile.not_found_body")}
      </p>
    `;
  }

  private renderProfile(
    agent: PublicAgent,
    matches: ReadonlyArray<PublicMatch>,
  ) {
    const badge = STATUS_BADGE[agent.status];
    const label = agent.registered ? agent.displayName : agent.playerName;
    const emblemSvg = agent.registered
      ? agent.emblemSvg
      : (agent.provisionalEmblemSvg ?? null);
    return html`
      <header class="mb-2 flex flex-wrap items-center gap-2">
        ${emblemSvg !== null
          ? html`<span
              class="inline-flex h-10 w-10 shrink-0 overflow-hidden"
              aria-hidden="true"
              >${unsafeSVG(emblemSvg)}</span
            >`
          : nothing}
        <h1 class="text-xl font-bold text-ink">${label}</h1>
        ${agent.registered && agent.shortCode !== null
          ? html`<span class="font-mono text-xs text-ink-muted"
              >${agent.shortCode}</span
            >`
          : nothing}
        <span
          class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
          >${translateText(badge.key)}</span
        >
      </header>
      ${!agent.registered
        ? html`<p class="mb-3 text-sm text-ink-muted">
            ${translateText("agent_profile.provisional_note")}
          </p>`
        : nothing}
      ${this.renderBuilderLine(agent)}
      ${agent.tagline !== null
        ? html`<p class="mb-4 text-sm text-ink-muted">${agent.tagline}</p>`
        : nothing}
      ${agent.standing !== null ? this.renderStanding(agent.standing) : nothing}
      ${agent.activeVersion !== null
        ? this.renderActiveVersion(agent.activeVersion)
        : nothing}
      ${renderAgentStatsSections(agent.stats)}
      ${renderAgentFormSection(agent.timeSeries ?? { winrate: null, score: null })}
      ${renderAnalysisTab(agent.stats, this.generatedAt)}
      ${this.renderRecentMatches(agent, matches)}
    `;
  }

  /** `builderDisplayName` or an honest, unobtrusive "Unclaimed" — skipped entirely for a house agent, whose status badge above already covers that classification (same rule `CoworldLeagueSiteWriter.builderNoteMarkup` applies). An unclaimed, registered Agent additionally gets a small "start a verified claim" CTA (Season Zero activation Phase 3) — deliberately plain text next to the label, never a second competing headline, so "Unclaimed" stays a status note rather than the dominant identity on the page. */
  private renderBuilderLine(agent: PublicAgent) {
    if (agent.status === "house" || !agent.registered) return nothing;
    const label =
      agent.builderDisplayName ?? translateText("agent_profile.builder_unclaimed");
    const claimHref =
      agent.status === "unclaimed" && agent.slug !== null
        ? `/claim/${encodeURIComponent(agent.slug)}`
        : null;
    return html`<p class="mb-3 text-sm text-ink-muted">
      ${translateText("agent_profile.builder_label")}: <span class="font-semibold text-ink">${label}</span>
      ${claimHref !== null
        ? html`<a
            href=${claimHref}
            class="ml-2 font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            >${translateText("agent_profile.claim_cta")}</a
          >`
        : nothing}
    </p>`;
  }

  private renderStanding(standing: Standing) {
    return html`
      <dl class="mb-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt class="text-[11px] uppercase text-ink-muted">${translateText("agent_profile.rank")}</dt>
          <dd class="font-mono font-semibold text-ink">#${standing.rank}</dd>
        </div>
        <div>
          <dt class="text-[11px] uppercase text-ink-muted">${translateText("agent_profile.score")}</dt>
          <dd class="font-mono font-semibold text-ink">
            ${standing.score === null ? "—" : standing.score.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt class="text-[11px] uppercase text-ink-muted">${translateText("agent_profile.rated_rounds")}</dt>
          <dd class="font-mono font-semibold text-ink">
            ${standing.roundsPlayed ?? "—"}
          </dd>
        </div>
      </dl>
    `;
  }

  private renderActiveVersion(activeVersion: ActiveVersion) {
    return html`
      <p class="mb-4 text-sm text-ink-muted">
        ${translateText("agent_profile.active_version_label")}:
        <span class="font-mono font-semibold text-ink"
          >${activeVersion.publicVersionLabel}</span
        >
        ${activeVersion.familyMismatch
          ? html`<span
              class="ml-2 rounded-full border border-caution/40 bg-caution/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-caution"
              title=${translateText("agent_profile.pending_review_title")}
              >${translateText("agent_profile.pending_review")}</span
            >`
          : nothing}
        ${activeVersion.firstObservedAt !== null
          ? html`<span class="ml-2 text-xs text-ink-muted"
              >${translateText("agent_profile.first_observed", {
                date: new Date(
                  activeVersion.firstObservedAt,
                ).toLocaleDateString(),
              })}</span
            >`
          : nothing}
      </p>
    `;
  }

  private renderRecentMatches(
    agent: PublicAgent,
    matches: ReadonlyArray<PublicMatch>,
  ) {
    return html`
      <section aria-labelledby="agent-profile-matches-heading">
        <h2
          id="agent-profile-matches-heading"
          class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted"
        >
          ${translateText("agent_profile.recent_matches_heading")}
        </h2>
        ${matches.length === 0
          ? html`<p class="text-sm text-ink-muted">
              ${translateText("agent_profile.no_matches")}
            </p>`
          : html`
              <ul class="flex flex-col gap-1.5" role="list">
                ${matches.map((match) => this.renderMatchRow(agent, match))}
              </ul>
            `}
      </section>
    `;
  }

  /** Registered agents key their own row via `PublicMatchParticipant.agentSlug`; a provisional (unregistered) identity has no `agentSlug` to match on (that field is only ever set for a registered participant — see `ProxyWarPublicReadModel.ts`'s `publicMatch`), so this falls back to `displayName === agent.playerName`, the one field every participant carries regardless of registration. */
  private renderMatchRow(agent: PublicAgent, match: PublicMatch) {
    const participant = agent.registered
      ? (match.participants.find((p) => p.agentSlug === agent.slug) ?? null)
      : (match.participants.find((p) => p.displayName === agent.playerName) ??
        null);
    // Same "outcome carries the word, colour stays reserved" call
    // `PlayerProfilePage.renderEpisodeRow` makes — this page never sits next
    // to a betting P&L view today, but the language stays consistent across
    // every public profile regardless.
    const outcome =
      participant === null
        ? { label: "—", cls: "text-ink-muted" }
        : participant.isWinner
          ? { label: translateText("agent_profile.outcome_won"), cls: "font-semibold text-ink" }
          : participant.isAlive
            ? { label: translateText("agent_profile.outcome_survived"), cls: "text-ink-muted" }
            : { label: translateText("agent_profile.outcome_eliminated"), cls: "text-ink-muted" };
    const when =
      match.completedAt !== null
        ? new Date(match.completedAt).toLocaleDateString()
        : "—";
    const href = match.fullRenderHref ?? match.watchHref;
    return html`
      <li
        class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs"
      >
        <span class="text-ink-muted">${match.map}</span>
        <span class="text-ink-muted">${when}</span>
        <span class="font-semibold ${outcome.cls}">${outcome.label}</span>
        <a
          href="/match/${encodeURIComponent(match.matchId)}"
          class="ml-auto font-semibold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("agent_profile.view_match_link")}</a
        >
        ${href !== null
          ? html`<a
              href=${href}
              class="font-semibold text-ink-muted outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("agent_profile.watch_link")}</a
            >`
          : nothing}
      </li>
    `;
  }
}

/** Matches where any participant's `agentSlug` equals this agent's `slug`, most recent `completedAt` first (a `null` `completedAt` sorts last, not first — an in-progress/incomplete record is never "most recent"), capped at 10. */
function recentMatchesForAgent(
  matches: readonly PublicMatch[],
  agentSlug: string,
): PublicMatch[] {
  return sortMatchesByRecency(
    matches.filter((match) =>
      match.participants.some((p) => p.agentSlug === agentSlug),
    ),
  );
}

/** The provisional-identity sibling of `recentMatchesForAgent`, above — keys on `PublicMatchParticipant.displayName` (the raw Coworld `playerName`, always present) instead of `agentSlug` (only ever set for a registered participant). */
function recentMatchesForPlayerName(
  matches: readonly PublicMatch[],
  playerName: string,
): PublicMatch[] {
  return sortMatchesByRecency(
    matches.filter((match) =>
      match.participants.some((p) => p.displayName === playerName),
    ),
  );
}

function sortMatchesByRecency(
  matches: readonly PublicMatch[],
): PublicMatch[] {
  return [...matches]
    .sort((a, b) => {
      const at = a.completedAt === null ? -Infinity : Date.parse(a.completedAt);
      const bt = b.completedAt === null ? -Infinity : Date.parse(b.completedAt);
      return bt - at;
    })
    .slice(0, 10);
}
