import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { translateText } from "../Utils";
import {
  appShellFooter,
  appShellHeader,
  APP_SHELL_ROOT_CLASSES,
} from "./AppShellChrome";
import {
  fetchReadModel,
  PublicAgent,
  PublicMatch,
  ReadModel,
} from "./ReadModelSchema";
import {
  computeDegradedShare,
  resolveWinnerName,
} from "./WatchPage";

/**
 * `/` — the event lobby (spec §4 Target IA: "no longer a bare redirect to
 * the league table"; Stage 2 item 4, three hero states). No game/replay
 * bundle loads here — every action is a plain link to another route
 * (spec Stage 2 item 6).
 *
 * Hero state, checked in order:
 *   A. `premieres.live` present and `premierePageLive === true` — an active
 *      premiere. Label is ALWAYS "Live Premiere", never wording implying the
 *      match is executing at this instant beyond that literal label.
 *   B. `premieres.live` present and `premierePageLive === false` — scheduled,
 *      counting down (client clock; same known simplification as
 *      `WatchPage`'s countdown, documented there).
 *   C. Neither — falls back to `premieres.latest` (an actual revealed
 *      premiere) when present, else the single most recently completed
 *      match with a watchable render. This is deliberately the SIMPLEST
 *      honest selection, not a drama-score ranking: no per-match "drama
 *      report" artifact is available for hosted league episodes in this
 *      read model today (Stage 5's Director Cut is what's actually specced
 *      to replace this placeholder), so state C never claims a drama-score
 *      selection it isn't actually running.
 */
@customElement("lobby-page")
export class LobbyPage extends LitElement {
  @state() private loadState: "loading" | "ready" | "error" = "loading";
  @state() private readModel: ReadModel | null = null;

  createRenderRoot() {
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
      ${appShellHeader(
        "/",
        this.readModel?.premieres.live?.premierePageLive === true
          ? { label: translateText("lobby.live_premiere_badge"), tone: "live" }
          : this.readModel?.stale === true
            ? { label: translateText("lobby.stale_data_badge"), tone: "stale" }
            : undefined,
      )}
      <main id="lobby-main" class="mx-auto w-full max-w-6xl px-4 py-8">
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "ready" && this.readModel !== null
          ? this.renderReady(this.readModel)
          : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("lobby.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("lobby.load_error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("lobby.try_again")}
        </button>
      </div>
    `;
  }

  private renderReady(model: ReadModel): TemplateResult {
    return html`
      ${model.stale
        ? html`<div
            class="mb-4 rounded-md border border-caution/40 bg-caution/10 px-3 py-2 text-xs font-semibold text-caution"
            role="status"
          >
            ${translateText("lobby.stale_snapshot", {
              date: new Date(model.lastGoodSyncAt).toLocaleString(),
            })}
          </div>`
        : nothing}
      <section class="mb-4">
        <p class="font-mono text-xs font-extrabold uppercase tracking-widest text-accent">
          ${translateText("lobby.eyebrow")}
        </p>
        <h1 class="mt-1 text-4xl font-black leading-tight text-ink sm:text-5xl">
          ${translateText("lobby.hero_title")}
        </h1>
        <p class="mt-3 max-w-2xl text-base text-ink-dim">
          ${translateText("lobby.hero_subtitle")}
        </p>
      </section>
      ${this.renderHero(model)}
      <div class="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div class="lg:col-span-2">${this.renderLeaguePulse(model)}</div>
        <div>${this.renderAgentsToWatch(model)}</div>
      </div>
      ${this.renderRecentBroadcasts(model)} ${this.renderBuilderBand(model)}
    `;
  }

  // ---- Hero -----------------------------------------------------------

  private renderHero(model: ReadModel): TemplateResult {
    const live = model.premieres.live;
    if (live !== null && live.premierePageLive) {
      return this.renderHeroActivePremiere(live);
    }
    if (live !== null && !live.premierePageLive) {
      return this.renderHeroUpcomingPremiere(live);
    }
    return this.renderHeroNoPremiere(model);
  }

  private heroShell(inner: TemplateResult, accentClass: string): TemplateResult {
    return html`
      <section
        class="rounded-xl border ${accentClass} bg-surface p-6 sm:p-8"
        aria-label=${translateText("lobby.hero_aria_label")}
      >
        ${inner}
      </section>
    `;
  }

  // State A — Active Premiere.
  private renderHeroActivePremiere(
    live: NonNullable<ReadModel["premieres"]["live"]>,
  ): TemplateResult {
    return this.heroShell(
      html`
        <span
          class="inline-flex items-center gap-2 rounded-full border border-live/60 bg-live/10 px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide text-live"
        >
          <span class="h-2 w-2 rounded-full bg-live" aria-hidden="true"></span>
          ${translateText("lobby.live_premiere_badge")}
        </span>
        <h2 class="mt-3 text-2xl font-extrabold text-ink">
          ${live.mapLabel}${live.roundNumber !== null
            ? translateText("lobby.round_suffix", { round: live.roundNumber })
            : ""}
        </h2>
        <p class="mt-1 text-sm text-ink-muted">
          ${translateText("lobby.active_premiere_note")}
        </p>
        <div class="mt-4">
          <a
            href="/premiere/${encodeURIComponent(live.premiereId)}"
            class="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 font-black text-on-accent no-underline outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            >${translateText("lobby.watch_now")}</a
          >
        </div>
      `,
      "border-live/50",
    );
  }

  // State B — Upcoming Premiere.
  private renderHeroUpcomingPremiere(
    live: NonNullable<ReadModel["premieres"]["live"]>,
  ): TemplateResult {
    const scheduled = new Date(live.scheduledAt);
    const scheduledValid = !Number.isNaN(scheduled.getTime());
    return this.heroShell(
      html`
        <span
          class="inline-flex items-center gap-2 rounded-full border border-info/50 bg-info/10 px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide text-info"
        >
          ${translateText("lobby.upcoming_premiere_badge")}
        </span>
        <h2 class="mt-3 text-2xl font-extrabold text-ink">
          ${live.mapLabel}${live.roundNumber !== null
            ? translateText("lobby.round_suffix", { round: live.roundNumber })
            : ""}
        </h2>
        ${scheduledValid
          ? html`<p class="mt-1 text-sm text-ink-muted">
              ${translateText("lobby.scheduled_for")}
              <time datetime=${live.scheduledAt}
                >${scheduled.toLocaleString()}
                ${translateText("lobby.local_time_suffix")}</time
              >
              ${translateText("lobby.countdown_note")}
            </p>`
          : nothing}
        <div class="mt-4">
          <a
            href="/premiere/${encodeURIComponent(live.premiereId)}"
            class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-5 font-black text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
            >${translateText("lobby.view_matchup")}</a
          >
        </div>
      `,
      "border-info/40",
    );
  }

  // State C — No scheduled Premiere.
  private renderHeroNoPremiere(model: ReadModel): TemplateResult {
    const latest = model.premieres.latest;
    if (latest !== null) {
      return this.heroShell(
        html`
          <span
            class="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide text-ink-muted"
          >
            ${translateText("lobby.latest_premiere_badge")}
          </span>
          <h2 class="mt-3 text-2xl font-extrabold text-ink">
            ${latest.mapLabel}${latest.roundNumber !== null
              ? translateText("lobby.round_suffix", { round: latest.roundNumber })
              : ""}
          </h2>
          <p class="mt-1 text-sm text-ink-muted">
            ${translateText("lobby.latest_premiere_note")}
          </p>
          <div class="mt-4">
            <a
              href=${latest.href}
              class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-5 font-black text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("lobby.browse_all_matches")}</a
            >
          </div>
        `,
        "border-line",
      );
    }
    // No premiere at all yet — the simplest honest fallback: the single
    // most recently completed, watchable match (see class doc for why this
    // is not a drama-score selection).
    const fallback = [...model.matches]
      .filter(
        (match) => match.completedAt !== null && match.fullRenderHref !== null,
      )
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .at(0);
    if (fallback === undefined) {
      return this.heroShell(
        html`<h2 class="text-2xl font-extrabold text-ink">
            ${translateText("lobby.no_premiere_title")}
          </h2>
          <p class="mt-1 text-sm text-ink-muted">
            ${translateText("lobby.no_premiere_note")}
          </p>
          <div class="mt-4">
            <a
              href="/league"
              class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-5 font-black text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("lobby.browse_all_matches")}</a
            >
          </div>`,
        "border-line",
      );
    }
    return this.heroShell(
      html`
        <span
          class="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide text-ink-muted"
        >
          ${translateText("lobby.recent_battle_badge")}
        </span>
        <h2 class="mt-3 text-2xl font-extrabold text-ink">
          ${fallback.map}${fallback.roundNumber !== null
            ? translateText("lobby.round_suffix", { round: fallback.roundNumber })
            : ""}
        </h2>
        <p class="mt-1 text-sm text-ink-muted">
          ${translateText("lobby.recent_battle_note")}
        </p>
        <div class="mt-4">
          <a
            href=${fallback.fullRenderHref!}
            class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-5 font-black text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
            >${translateText("lobby.browse_all_matches")}</a
          >
        </div>
      `,
      "border-line",
    );
  }

  // ---- League pulse -----------------------------------------------------

  private renderLeaguePulse(model: ReadModel): TemplateResult {
    const top5 = [...model.agents]
      .filter((agent) => agent.standing !== null)
      .sort((a, b) => (a.standing?.rank ?? 0) - (b.standing?.rank ?? 0))
      .slice(0, 5);
    return html`
      <section aria-labelledby="league-pulse-heading">
        <div class="mb-3 flex items-baseline justify-between gap-2">
          <h2
            id="league-pulse-heading"
            class="text-sm font-black uppercase tracking-wide text-ink-muted"
          >
            ${translateText("lobby.league_pulse_heading")}
          </h2>
          <span class="font-mono text-xs text-ink-muted">
            ${model.league.currentRoundNumber !== null
              ? translateText("lobby.round_number", {
                  round: model.league.currentRoundNumber,
                })
              : ""}${model.league.currentRoundStatus === "running"
              ? translateText("lobby.live_suffix")
              : ""}
          </span>
        </div>
        ${top5.length === 0
          ? html`<p class="text-sm text-ink-muted">
              ${translateText("lobby.no_standings")}
            </p>`
          : html`<ol class="flex flex-col gap-2" role="list">
              ${top5.map((agent) => this.renderPulseRow(agent))}
            </ol>`}
        <a
          href="/league"
          class="mt-3 inline-block text-sm font-bold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("lobby.full_standings")}</a
        >
      </section>
    `;
  }

  private renderPulseRow(agent: PublicAgent): TemplateResult {
    return html`
      <li
        class="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3 py-2"
      >
        <span class="w-6 shrink-0 font-mono text-sm font-black text-ink-muted"
          >#${agent.standing?.rank}</span
        >
        ${agent.registered && agent.emblemSvg !== null
          ? html`<span
              class="inline-flex h-6 w-6 shrink-0 overflow-hidden"
              aria-hidden="true"
              >${unsafeSVG(agent.emblemSvg)}</span
            >`
          : nothing}
        <a
          href=${agent.slug !== null
            ? `/agent/${encodeURIComponent(agent.slug)}`
            : "/league"}
          class="min-w-0 flex-1 truncate text-sm font-semibold text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
          >${agent.displayName}</a
        >
        ${agent.activeVersion !== null
          ? html`<span class="font-mono text-xs text-ink-muted"
              >${agent.activeVersion.publicVersionLabel}</span
            >`
          : nothing}
        <span class="font-mono text-xs font-bold text-ink-muted"
          >${agent.standing?.score === null ||
          agent.standing?.score === undefined
            ? "—"
            : agent.standing.score.toFixed(2)}</span
        >
      </li>
    `;
  }

  // ---- Agents to watch ---------------------------------------------------

  /** Evidence-based only: agents with 2+ wins among the matches this read model carries — no invented notability score. */
  private renderAgentsToWatch(model: ReadModel): TemplateResult {
    const winsBySlug = new Map<string, number>();
    for (const match of model.matches) {
      if (match.winnerAgentSlug === null) continue;
      winsBySlug.set(
        match.winnerAgentSlug,
        (winsBySlug.get(match.winnerAgentSlug) ?? 0) + 1,
      );
    }
    const notable = model.agents
      .filter((agent) => agent.slug !== null && (winsBySlug.get(agent.slug) ?? 0) >= 2)
      .sort(
        (a, b) =>
          (winsBySlug.get(b.slug ?? "") ?? 0) -
          (winsBySlug.get(a.slug ?? "") ?? 0),
      )
      .slice(0, 5);
    return html`
      <section aria-labelledby="agents-to-watch-heading">
        <h2
          id="agents-to-watch-heading"
          class="mb-3 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("lobby.agents_to_watch_heading")}
        </h2>
        ${notable.length === 0
          ? html`<p class="text-sm text-ink-muted">
              ${translateText("lobby.no_notable_agents")}
            </p>`
          : html`<ul class="flex flex-col gap-2" role="list">
              ${notable.map(
                (agent) => html`
                  <li
                    class="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2"
                  >
                    ${agent.registered && agent.emblemSvg !== null
                      ? html`<span
                          class="inline-flex h-6 w-6 shrink-0 overflow-hidden"
                          aria-hidden="true"
                          >${unsafeSVG(agent.emblemSvg)}</span
                        >`
                      : nothing}
                    <a
                      href=${agent.slug !== null
                        ? `/agent/${encodeURIComponent(agent.slug)}`
                        : "/league"}
                      class="min-w-0 flex-1 truncate text-sm font-semibold text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                      >${agent.displayName}</a
                    >
                    <span class="font-mono text-xs text-ink-muted"
                      >${translateText("lobby.recent_wins", {
                        count: winsBySlug.get(agent.slug ?? "") ?? 0,
                      })}</span
                    >
                  </li>
                `,
              )}
            </ul>`}
      </section>
    `;
  }

  // ---- Recent broadcasts --------------------------------------------------

  private renderRecentBroadcasts(model: ReadModel): TemplateResult {
    const recent = [...model.matches]
      .filter((match) => match.completedAt !== null)
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .slice(0, 3);
    if (recent.length === 0) {
      return html``;
    }
    return html`
      <section class="mt-10" aria-labelledby="recent-broadcasts-heading">
        <h2
          id="recent-broadcasts-heading"
          class="mb-3 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("lobby.recent_broadcasts_heading")}
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          ${recent.map((match) => this.renderBroadcastCard(match, model.agents))}
        </div>
      </section>
    `;
  }

  private renderBroadcastCard(
    match: PublicMatch,
    agents: readonly PublicAgent[],
  ): TemplateResult {
    const { share, elevated } = computeDegradedShare(
      match.degradedCount ?? 0,
      match.decisionCount,
    );
    const winnerName = resolveWinnerName(match, agents);
    const watchHref = match.fullRenderHref ?? match.watchHref;
    return html`
      <div class="rounded-lg border border-line bg-surface-2 p-4">
        <p class="font-mono text-xs text-ink-muted">
          ${match.map}${match.roundNumber !== null
            ? translateText("lobby.round_suffix", { round: match.roundNumber })
            : ""}
        </p>
        ${match.degradedCount !== null && match.degradedCount > 0
          ? html`<p
              class="mt-1 inline-block rounded border px-1.5 py-0.5 font-mono text-[11px] ${elevated
                ? "border-caution/50 text-caution"
                : "border-line text-ink-muted"}"
              title=${translateText("lobby.degraded_turns_tooltip")}
            >
              ${share === null
                ? translateText("lobby.recovered_turns", {
                    count: match.degradedCount,
                  })
                : translateText("lobby.recovered_turns_with_share", {
                    count: match.degradedCount,
                    share,
                  })}
            </p>`
          : nothing}
        <details class="mt-2">
          <summary
            class="cursor-pointer text-sm font-bold text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            ${translateText("lobby.reveal_result")}
          </summary>
          <p class="mt-1 text-sm text-ink">
            ${winnerName === null
              ? translateText("lobby.no_winner")
              : translateText("lobby.winner_announcement", { winner: winnerName })}
          </p>
        </details>
        ${watchHref !== null
          ? html`<a
              href=${watchHref}
              class="mt-2 inline-block text-sm font-bold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("lobby.watch_replay")}</a
            >`
          : nothing}
      </div>
    `;
  }

  // ---- Builder acquisition band -------------------------------------------

  private renderBuilderBand(model: ReadModel): TemplateResult {
    return html`
      <section
        class="mt-10 rounded-xl border border-accent/40 bg-accent-soft px-6 py-6 text-center"
      >
        <h2 class="text-xl font-extrabold text-ink">
          ${translateText("lobby.builder_band_title")}
        </h2>
        <p class="mx-auto mt-1 max-w-xl text-sm text-ink-dim">
          ${translateText("lobby.builder_band_note")}
        </p>
        <div class="mt-4">
          <a
            href=${model.links.enterTheLeagueUrl}
            class="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 font-black text-on-accent no-underline outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            >${translateText("lobby.starter_repo_link")}</a
          >
        </div>
      </section>
    `;
  }
}
