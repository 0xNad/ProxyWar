import { html, LitElement, nothing, PropertyValues, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { z } from "zod";
import {
  fetchReadModel,
  PublicAgent,
  PublicFeaturedMatch,
  PublicMatch,
  ReadModel,
} from "./ReadModelSchema";
import {
  appShellFooter,
  appShellHeader,
  APP_SHELL_ROOT_CLASSES,
  waitForTranslationsReady,
} from "./AppShellChrome";
import { translateText } from "../Utils";
import { analytics } from "../analytics/AnalyticsClient";

/**
 * `/watch` — Season Zero activation prompt Phase 5 ("Watch page"): a
 * CONTENT PROGRAMME, not an archive query form. Order, top to bottom:
 *
 *   1. live/upcoming Featured Event (`isPubliclyPromotable`-gated — see
 *      `findPromotableEvent`'s own doc for why this is NEVER the raw,
 *      anonymous `ReadModel.premieres.live`/`latest` pointer);
 *   2. latest Director Cuts (evidence-ranked, full card completeness);
 *   3. Season Zero schedule (from `ReadModel.seasons`);
 *   4. the full replay archive, filters collapsed behind a `<details>`
 *      drawer AFTER the archive's own heading — never shown before the
 *      viewer has seen something worth watching.
 *
 * This page never fetches a game/replay bundle itself: every result stays
 * spoiler-safe behind a closed-by-default `<details>` "Reveal result",
 * and every "watch" affordance is a plain link to another page/route,
 * never an inline player.
 */
@customElement("watch-page")
export class WatchPage extends LitElement {
  @state() private loadState: "loading" | "ready" | "error" = "loading";
  @state() private readModel: ReadModel | null = null;
  @state() private promotableEvent: PublicFeaturedMatch | null = null;
  @state() private heroParticipants: FeaturedEventParticipant[] = [];

  /**
   * Snapshot of the CLIENT's own clock, taken once when the read model
   * finishes loading. The live-premiere countdown/elapsed note below is
   * computed against this value, not against the server's `generatedAt`.
   * Known simplification for this pass: no server-time calibration/skew
   * correction is applied, so a badly-skewed client clock will show a
   * wrong countdown.
   */
  @state() private clientNowMs = 0;

  // -- Archive filters (behind the drawer). Client-side only, over
  // `ReadModel.matches` -- no new endpoint, no server round trip on
  // change. "all" is every filter's neutral/no-op value throughout.
  @state() private filterAgentSlug = "all";
  @state() private filterMap = "all";
  @state() private filterMapSize = "all";
  @state() private filterFeatured: "all" | "featured" = "all";
  @state() private filterCleanliness: "all" | "clean" | "degraded" = "all";
  /** `<input type=date>` values, `""` when unset -- inclusive on both ends, compared against `completedAt`'s own date portion (UTC, matching the ISO string's own date segment, never locale-shifted). */
  @state() private filterDateFrom = "";
  @state() private filterDateTo = "";
  /**
   * Ranking of the (already filtered) archive — "recent" (default) keeps
   * the caller's completedAt-desc order; "dramatic" ranks by
   * `curatedDramaScoreOf` desc, evidence-less matches last. This is a
   * SORT, not a filter — no match is ever hidden by it.
   */
  @state() private sortOrder: "recent" | "dramatic" = "recent";
  private trackedImpressions = new Set<string>();

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `PlayerProfilePage`/`PremiereAccountPage`.
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    void waitForTranslationsReady().then(() => this.requestUpdate());
  }

  updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    const readModel = this.readModel;
    if (readModel === null) return;
    const featuredMatchIds = new Set(
      readModel.featuredMatches.map((match) => match.matchId),
    );
    for (const match of readModel.matches) {
      if (match.completedAt === null) continue;
      if (!featuredMatchIds.has(match.matchId)) continue;
      if (this.trackedImpressions.has(match.matchId)) continue;
      this.trackedImpressions.add(match.matchId);
      analytics.track("featured_event_impression", { matchId: match.matchId });
    }
  }

  private async load(): Promise<void> {
    this.loadState = "loading";
    this.heroParticipants = [];
    this.promotableEvent = null;
    try {
      const readModel = await fetchReadModel();
      this.readModel = readModel;
      this.clientNowMs = Date.now();
      this.loadState = "ready";
      const event = findPromotableEvent(readModel);
      this.promotableEvent = event;
      if (event !== null) {
        void this.loadHeroParticipants(event.matchId);
      }
    } catch {
      this.loadState = "error";
    }
  }

  private async loadHeroParticipants(matchId: string): Promise<void> {
    try {
      const participants = await fetchFeaturedEventParticipants(matchId);
      if (!this.isConnected) return;
      this.heroParticipants = participants;
    } catch {
      // Network failure or a schema mismatch — the featured-event card
      // still renders, just without a lineup section.
    }
  }

  render() {
    return html`
      ${appShellHeader("/watch", undefined, this.readModel?.links.accountUrl)}
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        <h1 id="watch-page-heading" class="mb-6 text-2xl font-bold text-ink">
          ${translateText("watch.heading")}
        </h1>
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
      ${translateText("watch.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("watch.load_error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("watch.try_again")}
        </button>
      </div>
    `;
  }

  private renderReady(readModel: ReadModel) {
    return html`
      <div class="flex flex-col gap-8">
        ${this.renderFeaturedEventSection(readModel)}
        ${this.renderLatestDirectorCuts(readModel)}
        ${this.renderSeasonSchedule(readModel)}
        ${this.renderReplayArchive(readModel)}
      </div>
    `;
  }

  // -- 1. Featured event (live / upcoming / none) --------------------------

  /**
   * Doc order item 1. Keyed off `isPubliclyPromotable` (see
   * `findPromotableEvent`'s own doc) — NEVER the raw
   * `ReadModel.premieres.live`/`latest` anonymous pointer. Renders
   * nothing (not even an empty section) when no promotable event exists
   * — the page simply starts at "Latest Director Cuts" instead, which is
   * the honest, non-fabricated state.
   */
  private renderFeaturedEventSection(readModel: ReadModel) {
    const event = this.promotableEvent;
    if (event === null) return nothing;
    const live = isEventLive(event, this.clientNowMs);
    const scheduleNote =
      event.scheduledAt !== null
        ? describeSchedule(event.scheduledAt, this.clientNowMs)
        : null;
    const watchHref =
      event.canonicalPremiereUrl ?? `/match/${encodeURIComponent(event.matchId)}`;
    return html`
      <section
        aria-labelledby="watch-featured-event-heading"
        class="rounded-lg border-2 ${live ? "border-live/50 bg-live/10" : "border-info/50 bg-info/10"} p-5"
      >
        <span
          class="inline-block rounded-full border ${live ? "border-live/60 text-live-text" : "border-info/60 text-info"} px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wide"
          >${live
            ? translateText("watch.live_premiere_badge")
            : translateText("watch.upcoming_premiere_badge")}</span
        >
        <h2 id="watch-featured-event-heading" class="mt-2 text-lg font-bold text-ink">
          ${event.title}
        </h2>
        ${event.subtitle !== null
          ? html`<p class="mt-1 text-sm text-ink-muted">${event.subtitle}</p>`
          : nothing}
        ${event.reasonToWatch !== null && event.reasonToWatch.length > 0
          ? html`<p class="mt-1 text-sm text-ink-dim">${event.reasonToWatch.join(" ")}</p>`
          : nothing}
        ${scheduleNote !== null
          ? html`<p class="mt-1 text-sm text-ink-muted">${scheduleNote}</p>`
          : nothing}
        ${this.heroParticipants.length > 0
          ? renderParticipantChips(this.heroParticipants)
          : nothing}
        <a
          href=${watchHref}
          class="mt-3 inline-block rounded-md bg-accent px-4 py-2 text-sm font-bold text-on-accent no-underline outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${live ? translateText("watch.watch_now") : translateText("watch.watch_link")}</a
        >
      </section>
    `;
  }

  // -- 2. Latest Director Cuts -----------------------------------------------

  /**
   * Doc order item 2. Full card completeness per the doc's own list:
   * title, participants, emblems, exact versions where useful, map,
   * runtime, date, one-sentence reason to watch, integrity status,
   * Director Cut CTA, Full Replay secondary action, spoiler reveal.
   * Ranked exactly like `LobbyPage`'s "Recent Director Cuts" (evidence
   * within a bounded recency window), independently rendered here with
   * the fuller per-card detail this page's own completeness bar calls
   * for.
   */
  private renderLatestDirectorCuts(readModel: ReadModel) {
    const recencyWindow = [...readModel.matches]
      .filter((match) => match.completedAt !== null && match.directorCut !== null)
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .slice(0, LATEST_DIRECTOR_CUT_RECENCY_WINDOW);
    if (recencyWindow.length === 0) return nothing;
    const scored = recencyWindow
      .filter((match) => curatedDramaScoreOf(match) !== null)
      .sort((a, b) => (curatedDramaScoreOf(b) ?? -1) - (curatedDramaScoreOf(a) ?? -1));
    const unscored = recencyWindow.filter((match) => curatedDramaScoreOf(match) === null);
    const featured = [...scored, ...unscored]
      .slice(0, LATEST_DIRECTOR_CUT_DISPLAY_COUNT)
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
    const featuredMatchIds = new Set(readModel.featuredMatches.map((match) => match.matchId));
    return html`
      <section aria-labelledby="watch-director-cuts-heading">
        <h2 id="watch-director-cuts-heading" class="mb-3 text-lg font-bold text-ink">
          ${translateText("watch.latest_director_cuts_heading")}
        </h2>
        <ul class="flex flex-col gap-3" role="list">
          ${featured.map((match) =>
            this.renderDirectorCutCard(match, readModel.agents, featuredMatchIds.has(match.matchId)),
          )}
        </ul>
      </section>
    `;
  }

  private renderDirectorCutCard(
    match: PublicMatch,
    agents: readonly PublicAgent[],
    isFeatured: boolean,
  ) {
    const winnerName = resolveWinnerName(match, agents);
    const watchHref = match.fullRenderHref ?? match.watchHref;
    const runtimeMinutes =
      match.directorCut !== null
        ? Math.max(1, Math.round(match.directorCut.durationEstimateSeconds / 60))
        : null;
    const dramaScore = curatedDramaScoreOf(match);
    return html`
      <li class="rounded-lg border border-line bg-surface-2 p-4 text-sm">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="font-semibold text-ink"
            >${match.map}
            ${isFeatured
              ? html`<span
                  class="ml-1 rounded-full border border-accent/50 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-accent"
                  >${translateText("watch.featured_badge")}</span
                >`
              : nothing}</span
          >
          ${match.completedAt !== null
            ? html`<span class="text-xs text-ink-muted">${formatAbsoluteTime(match.completedAt)}</span>`
            : nothing}
        </div>
        ${renderParticipantChipsFromMatch(match, agents)}
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          ${runtimeMinutes !== null
            ? html`<span>${translateText("watch.director_cut_duration", { minutes: runtimeMinutes })}</span>`
            : nothing}
          ${dramaScore !== null
            ? html`<span>${translateText("watch.drama_score", { score: dramaScore })}</span>`
            : nothing}
          ${renderDegradedNote(match)}
        </div>
        <details class="mt-2">
          <summary
            class="cursor-pointer text-xs font-semibold text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            ${translateText("watch.reveal_result")}
          </summary>
          <p class="mt-1 text-xs text-ink-muted">
            ${winnerName !== null
              ? translateText("watch.winner_label", { name: winnerName })
              : translateText("watch.no_winner")}
          </p>
        </details>
        <a
          href="/match/${encodeURIComponent(match.matchId)}"
          class="mt-2 inline-block text-xs font-semibold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("watch.view_match")}</a
        >
        ${watchHref !== null
          ? html`<a
              href=${watchHref}
              class="ml-3 mt-2 inline-block text-xs text-ink-muted outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("watch.watch_replay")}</a
            >`
          : html`<span class="ml-3 mt-2 inline-block text-xs text-ink-muted"
              >${translateText("watch.replay_pending")}</span
            >`}
      </li>
    `;
  }

  // -- 3. Season Zero schedule ------------------------------------------------

  /**
   * Doc order item 3. Full active-season programme (unlike `LobbyPage`'s
   * compact below-hero teaser) — every event slot, chronological,
   * resolved against `featuredMatches` for title/state where possible.
   *
   * 2026-08-01 P0 production review: an ARCHIVE-lane slot is a SPOTLIGHT
   * of an already-completed match, never an upcoming contest — a slot's
   * own `scheduledAt` is the season PROGRAMME's own "featuring starting"
   * date (when the operator chose to spotlight it), which is NOT the
   * same thing as a premiere's future air time, and must never be
   * presented as one. This branches on `resolved.lane` (the read model's
   * own ground truth, present regardless of which list a season
   * operator happened to file the reference under) to show a distinct
   * label per lane, plus the match's own ACTUAL `completedAt` for
   * archive lane so a viewer is never left assuming the match hasn't
   * happened yet.
   */
  private renderSeasonSchedule(readModel: ReadModel) {
    const active = readModel.seasons.find((season) => season.state === "active");
    if (active === undefined) return nothing;
    const featuredMatchById = new Map(readModel.featuredMatches.map((match) => [match.matchId, match]));
    const slots = [...active.eventSlots].sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""));
    return html`
      <section aria-labelledby="watch-season-schedule-heading">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="watch-season-schedule-heading" class="text-lg font-bold text-ink">
            ${translateText("watch.season_schedule_heading", { title: active.title })}
          </h2>
          <span class="text-xs text-ink-muted">
            ${new Date(active.startDate).toLocaleDateString()} – ${new Date(active.endDate).toLocaleDateString()}
          </span>
        </div>
        ${active.description !== ""
          ? html`<p class="mb-3 text-sm text-ink-muted">${active.description}</p>`
          : nothing}
        ${slots.length === 0
          ? html`<p class="text-sm text-ink-muted">${translateText("watch.season_schedule_empty")}</p>`
          : html`<ol class="flex flex-col gap-2" role="list">
              ${slots.map((slot) => {
                const resolved = featuredMatchById.get(slot.featuredMatchId);
                const isArchiveSpotlight = resolved !== undefined && resolved.lane === "archive";
                const dateLabel =
                  resolved === undefined
                    ? null
                    : isArchiveSpotlight
                      ? translateText("watch.season_schedule_spotlight_label", {
                          date: slot.scheduledAt !== null ? formatAbsoluteTime(slot.scheduledAt) : "—",
                        })
                      : translateText("watch.season_schedule_premiere_label", {
                          date: slot.scheduledAt !== null ? formatAbsoluteTime(slot.scheduledAt) : "—",
                        });
                return html`
                  <li class="flex flex-col gap-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3">
                    <span class="font-mono text-xs text-ink-muted">
                      ${dateLabel ?? (slot.scheduledAt !== null ? formatAbsoluteTime(slot.scheduledAt) : "—")}
                    </span>
                    ${resolved !== undefined
                      ? html`<a
                          href="/match/${encodeURIComponent(resolved.matchId)}"
                          class="min-w-0 flex-1 truncate font-semibold text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                          >${resolved.title}</a
                        >`
                      : html`<span class="min-w-0 flex-1 truncate text-ink-muted"
                          >${translateText("watch.season_schedule_tbd")}</span
                        >`}
                    ${isArchiveSpotlight && resolved.completedAt !== null
                      ? html`<span class="text-xs text-ink-muted"
                          >${translateText("watch.season_schedule_played_note", {
                            date: formatAbsoluteTime(resolved.completedAt),
                          })}</span
                        >`
                      : nothing}
                  </li>
                `;
              })}
            </ol>`}
      </section>
    `;
  }

  // -- 4. Full replay archive --------------------------------------------------

  private renderReplayArchive(readModel: ReadModel) {
    const completed = readModel.matches
      .filter(
        (match): match is PublicMatch & { completedAt: string } =>
          match.completedAt !== null,
      )
      .slice()
      .sort(
        (a, b) =>
          new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
      );
    const featuredMatchIds = new Set(
      readModel.featuredMatches.map((match) => match.matchId),
    );
    const filtered = filterArchiveMatches(completed, featuredMatchIds, {
      agentSlug: this.filterAgentSlug,
      map: this.filterMap,
      mapSize: this.filterMapSize,
      featured: this.filterFeatured,
      cleanliness: this.filterCleanliness,
      dateFrom: this.filterDateFrom === "" ? null : this.filterDateFrom,
      dateTo: this.filterDateTo === "" ? null : this.filterDateTo,
    });
    const sorted = sortArchiveMatches(filtered, this.sortOrder);
    return html`
      <section aria-labelledby="watch-archive-heading">
        <h2
          id="watch-archive-heading"
          class="mb-3 text-lg font-bold text-ink"
        >
          ${translateText("watch.replay_archive_heading")}
        </h2>
        ${completed.length === 0
          ? html`<p class="text-sm text-ink-muted">
              ${translateText("watch.no_completed_matches")}
            </p>`
          : html`
              <details class="mb-4 rounded-md border border-line bg-surface-2">
                <summary class="cursor-pointer px-3 py-2 text-sm font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  ${translateText("watch.filters_heading")}
                </summary>
                <div class="px-3 pb-3">${this.renderArchiveFilters(completed, readModel.agents)}</div>
              </details>
              ${sorted.length === 0
                ? html`<p class="text-sm text-ink-muted" role="status">
                    ${translateText("watch.no_filtered_matches")}
                  </p>`
                : html`<ul class="flex flex-col gap-3" role="list">
                    ${sorted.map((match) =>
                      this.renderMatchCard(
                        match,
                        readModel.agents,
                        featuredMatchIds.has(match.matchId),
                      ),
                    )}
                  </ul>`}
            `}
      </section>
    `;
  }

  /**
   * Filter controls over the already-fetched archive — plain `<select>`s
   * and native date inputs, applied client-side with no server round
   * trip. Options are derived from what's ACTUALLY in `completed` (never
   * a static/guessed list), so an option only ever appears when at least
   * one match could match it. Lives inside a `<details>` drawer (see
   * `renderReplayArchive`) — never shown before the viewer has already
   * seen the featured event/latest cuts/season schedule above.
   */
  private renderArchiveFilters(
    completed: readonly (PublicMatch & { completedAt: string })[],
    agents: readonly PublicAgent[],
  ) {
    const agentSlugsInArchive = new Set(
      completed.flatMap((match) =>
        match.participants
          .map((p) => p.agentSlug)
          .filter((slug): slug is string => slug !== null),
      ),
    );
    const agentOptions = agents
      .filter(
        (agent): agent is PublicAgent & { slug: string } =>
          agent.slug !== null && agentSlugsInArchive.has(agent.slug),
      )
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    const mapOptions = [...new Set(completed.map((match) => match.map))].sort(
      (a, b) => a.localeCompare(b),
    );
    const mapSizeOptions = [
      ...new Set(completed.map((match) => match.mapSize)),
    ].sort((a, b) => a.localeCompare(b));
    const onChange =
      (
        prop:
          | "filterAgentSlug"
          | "filterMap"
          | "filterMapSize"
          | "filterDateFrom"
          | "filterDateTo",
      ) =>
      (event: Event) => {
        this[prop] = (event.target as HTMLSelectElement | HTMLInputElement)
          .value;
      };
    return html`
      <fieldset
        class="flex flex-wrap items-end gap-3"
      >
        <legend class="sr-only">${translateText("watch.filters_heading")}</legend>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${translateText("watch.filter_agent")}
          <select
            class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
            .value=${this.filterAgentSlug}
            @change=${onChange("filterAgentSlug")}
          >
            <option value="all">${translateText("watch.filter_all")}</option>
            ${agentOptions.map(
              (agent) =>
                html`<option value=${agent.slug}>${agent.displayName}</option>`,
            )}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${translateText("watch.filter_map")}
          <select
            class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
            .value=${this.filterMap}
            @change=${onChange("filterMap")}
          >
            <option value="all">${translateText("watch.filter_all")}</option>
            ${mapOptions.map(
              (map) => html`<option value=${map}>${map}</option>`,
            )}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${translateText("watch.filter_match_size")}
          <select
            class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
            .value=${this.filterMapSize}
            @change=${onChange("filterMapSize")}
          >
            <option value="all">${translateText("watch.filter_all")}</option>
            ${mapSizeOptions.map(
              (size) => html`<option value=${size}>${size}</option>`,
            )}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${translateText("watch.filter_featured")}
          <select
            class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
            .value=${this.filterFeatured}
            @change=${(event: Event) => {
              this.filterFeatured = (event.target as HTMLSelectElement)
                .value as "all" | "featured";
            }}
          >
            <option value="all">${translateText("watch.filter_all")}</option>
            <option value="featured">
              ${translateText("watch.filter_featured_only")}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${translateText("watch.filter_cleanliness")}
          <select
            class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
            .value=${this.filterCleanliness}
            @change=${(event: Event) => {
              this.filterCleanliness = (event.target as HTMLSelectElement)
                .value as "all" | "clean" | "degraded";
            }}
          >
            <option value="all">${translateText("watch.filter_all")}</option>
            <option value="clean">${translateText("watch.filter_clean_only")}</option>
            <option value="degraded">
              ${translateText("watch.filter_degraded_only")}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${translateText("watch.filter_date_from")}
          <input
            type="date"
            class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
            .value=${this.filterDateFrom}
            @change=${onChange("filterDateFrom")}
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${translateText("watch.filter_date_to")}
          <input
            type="date"
            class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
            .value=${this.filterDateTo}
            @change=${onChange("filterDateTo")}
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${translateText("watch.sort_label")}
          <select
            class="rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
            .value=${this.sortOrder}
            @change=${(event: Event) => {
              this.sortOrder = (event.target as HTMLSelectElement)
                .value as "recent" | "dramatic";
            }}
          >
            <option value="recent">${translateText("watch.sort_recent")}</option>
            <option value="dramatic">
              ${translateText("watch.sort_dramatic")}
            </option>
          </select>
        </label>
      </fieldset>
    `;
  }

  private renderMatchCard(
    match: PublicMatch & { completedAt: string },
    agents: readonly PublicAgent[],
    isFeatured: boolean,
  ) {
    const meta: string[] = [];
    if (match.turnCount !== null)
      meta.push(translateText("watch.turns_count", { count: match.turnCount }));
    if (match.decisionCount !== null)
      meta.push(
        translateText("watch.decisions_count", {
          count: match.decisionCount,
        }),
      );
    if (match.directorCut !== null)
      meta.push(
        translateText("watch.director_cut_duration", {
          minutes: Math.max(
            1,
            Math.round(match.directorCut.durationEstimateSeconds / 60),
          ),
        }),
      );
    const dramaScore = curatedDramaScoreOf(match);
    if (dramaScore !== null)
      meta.push(
        translateText("watch.drama_score", {
          score: dramaScore,
        }),
      );
    const roundLabel =
      match.roundNumber === null
        ? "—"
        : translateText("watch.round_label", { round: match.roundNumber });
    const watchHref = match.fullRenderHref ?? match.watchHref;
    const winnerName = resolveWinnerName(match, agents);
    return html`
      <li
        class="rounded-lg border border-line bg-surface-2 p-4 text-sm"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="font-semibold text-ink"
            >${match.map}
            ${isFeatured
              ? html`<span
                  class="ml-1 rounded-full border border-accent/50 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-accent"
                  >${translateText("watch.featured_badge")}</span
                >`
              : nothing}</span
          >
          <span class="text-xs text-ink-muted"
            >${formatAbsoluteTime(match.completedAt)}</span
          >
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span>${roundLabel}</span>
          ${meta.length > 0 ? html`<span>${meta.join(" · ")}</span>` : nothing}
          ${renderDegradedNote(match)}
        </div>
        <details class="mt-2">
          <summary
            class="cursor-pointer text-xs font-semibold text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            ${translateText("watch.reveal_result")}
          </summary>
          <p class="mt-1 text-xs text-ink-muted">
            ${winnerName !== null
              ? translateText("watch.winner_label", { name: winnerName })
              : translateText("watch.no_winner")}
          </p>
        </details>
        <a
          href="/match/${encodeURIComponent(match.matchId)}"
          @click=${() => analytics.track("event_cta_clicked", { matchId: match.matchId })}
          class="mt-2 inline-block text-xs font-semibold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("watch.view_match")}</a
        >
        ${watchHref !== null
          ? html`<a
              href=${watchHref}
              @click=${() => analytics.track("event_cta_clicked", { matchId: match.matchId })}
              class="ml-3 mt-2 inline-block text-xs text-ink-muted outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("watch.watch_replay")}</a
            >`
          : html`<span class="ml-3 mt-2 inline-block text-xs text-ink-muted"
              >${translateText("watch.replay_pending")}</span
            >`}
      </li>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "watch-page": WatchPage;
  }
}

// -- Pure helpers (exported for unit testing / cross-page reuse) ------------

/**
 * Season Zero activation prompt Phase 5 — THE authority both `WatchPage`
 * and `LobbyPage` use to find the current live/upcoming Featured Event.
 * NEVER the raw `ReadModel.premieres.live`/`latest` pointer
 * (`CoworldLeaguePremiereCard` — anonymous, System-B's continuous roll):
 * only a premiere-lane record that has cleared
 * `EventPackageGate.isPubliclyPromotable` (a complete `EventPackage`,
 * `state: "published"` or later — see that gate's own doc) is eligible.
 * `state === "published"` specifically (not `"revealed"`/`"archived"`):
 * once a record reveals it belongs in the Director Cut / archive
 * sections instead, not the live/upcoming spotlight. Picks the
 * EARLIEST-scheduled eligible record when more than one exists (the
 * cadence is one flagship event at a time, but this stays defensive).
 */
export function findPromotableEvent(model: ReadModel): PublicFeaturedMatch | null {
  const candidates = model.featuredMatches
    .filter(
      (match) =>
        match.lane === "premiere" &&
        match.isPubliclyPromotable &&
        match.state === "published",
    )
    .sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""));
  return candidates.at(0) ?? null;
}

/** A promotable event's `scheduledAt` has arrived (by the client's own clock) — live vs. upcoming for both `WatchPage` and `LobbyPage`. */
export function isEventLive(event: PublicFeaturedMatch, nowMs: number): boolean {
  if (event.scheduledAt === null) return false;
  const startMs = Date.parse(event.scheduledAt);
  return !Number.isNaN(startMs) && startMs <= nowMs;
}

const featuredEventParticipantSchema = z.object({
  playerName: z.string(),
  displayName: z.string(),
  agentSlug: z.string().nullable(),
  emblemSvg: z.string().nullable(),
  primaryColor: z.string().nullable(),
  secondaryColor: z.string().nullable(),
  versionLabel: z.string().nullable(),
  builderId: z.string().nullable(),
  builderDisplayName: z.string().nullable(),
});
export type FeaturedEventParticipant = z.infer<typeof featuredEventParticipantSchema>;

const featuredMatchDetailResponseSchema = z.object({
  schemaVersion: z.literal(1),
  participants: z.array(featuredEventParticipantSchema),
});

/** Fetches the one narrow, per-match participant-identity channel (`GET /api/featured-matches/:matchId`) — see `FeaturedMatchParticipants.ts`'s own doc for why this can never be a bulk read-model field. Safe for any `isPubliclyPromotable` record (that gate already requires `state: "published"` or later). */
export async function fetchFeaturedEventParticipants(
  matchId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FeaturedEventParticipant[]> {
  const response = await fetchImpl(
    `/api/featured-matches/${encodeURIComponent(matchId)}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error(`featured_event_participants_fetch_failed_${response.status}`);
  }
  const body: unknown = await response.json();
  return featuredMatchDetailResponseSchema.parse(body).participants;
}

/** Compact emblem+name chips for a narrow-route-resolved participant list (full identity: emblem, version, builder). Shared by `WatchPage`'s featured-event card and `LobbyPage`'s event stage. */
export function renderParticipantChips(
  participants: readonly FeaturedEventParticipant[],
): TemplateResult {
  return html`
    <ul class="mt-2 flex flex-wrap gap-2" role="list">
      ${participants.map(
        (participant) => html`
          <li class="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5">
            ${participant.emblemSvg !== null
              ? html`<span class="inline-flex h-5 w-5 shrink-0 overflow-hidden" aria-hidden="true"
                  >${unsafeSVG(participant.emblemSvg)}</span
                >`
              : nothing}
            <span class="text-xs font-semibold text-ink">${participant.displayName}</span>
            ${participant.versionLabel !== null
              ? html`<span class="font-mono text-[11px] text-ink-muted">${participant.versionLabel}</span>`
              : nothing}
          </li>
        `,
      )}
    </ul>
  `;
}

/**
 * Compact emblem+name chips resolved from an ALREADY-PUBLIC
 * `PublicMatch.participants[]` (a completed, published league episode —
 * no narrow-route gate needed, unlike `renderParticipantChips` above).
 * Joins `agentSlug` against `agents[]` for the emblem only — exact
 * version isn't carried per-episode on `PublicMatchParticipant` (see
 * `CandidateReasonToWatch.ts`'s own honesty note on this same gap), so
 * this never fabricates one.
 */
export function renderParticipantChipsFromMatch(
  match: PublicMatch,
  agents: readonly PublicAgent[],
): TemplateResult | typeof nothing {
  if (match.participants.length === 0) return nothing;
  const agentBySlug = new Map(
    agents.filter((agent) => agent.slug !== null).map((agent) => [agent.slug, agent]),
  );
  return html`
    <ul class="mt-2 flex flex-wrap gap-2" role="list">
      ${match.participants.map((participant) => {
        const agent =
          participant.agentSlug === null ? undefined : agentBySlug.get(participant.agentSlug);
        return html`
          <li class="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5">
            ${agent?.emblemSvg !== null && agent?.emblemSvg !== undefined
              ? html`<span class="inline-flex h-5 w-5 shrink-0 overflow-hidden" aria-hidden="true"
                  >${unsafeSVG(agent.emblemSvg)}</span
                >`
              : nothing}
            <span class="text-xs font-semibold text-ink">${participant.displayName}</span>
          </li>
        `;
      })}
    </ul>
  `;
}

const LATEST_DIRECTOR_CUT_RECENCY_WINDOW = 8;
const LATEST_DIRECTOR_CUT_DISPLAY_COUNT = 5;

/** Mirrors `CoworldLeagueSiteWriter.ts`'s `.degraded`/`.degraded.elevated` threshold naming — `>= 15%` degraded turns is "elevated", surfaced with a warning tone; below that, a plain neutral note. `decisionCount === null` (no data at all) or `0` decisions renders no share at all — never a fabricated `0%`. */
export const DEGRADED_WARNING_PERCENT = 15;

export function computeDegradedShare(
  degradedCount: number,
  decisionCount: number | null,
): { share: number | null; elevated: boolean } {
  if (decisionCount === null || decisionCount === 0 || degradedCount === 0) {
    return { share: null, elevated: false };
  }
  const share = Math.round((degradedCount / decisionCount) * 100);
  return { share, elevated: share >= DEGRADED_WARNING_PERCENT };
}

/**
 * Spec Stage 6 item 4: Agent / map / match-size / Featured-or-All /
 * data-quality / date-range filters, applied together (AND, never OR)
 * over the already-fetched archive. Every filter's neutral value is the
 * literal string `"all"` (or `null` for the two date bounds) — never
 * hidden by a default filter the viewer didn't choose.
 */
export function filterArchiveMatches(
  matches: readonly (PublicMatch & { completedAt: string })[],
  featuredMatchIds: ReadonlySet<string>,
  filters: {
    agentSlug: string;
    map: string;
    mapSize: string;
    featured: "all" | "featured";
    cleanliness: "all" | "clean" | "degraded";
    dateFrom: string | null;
    dateTo: string | null;
  },
): (PublicMatch & { completedAt: string })[] {
  return matches.filter((match) => {
    if (
      filters.agentSlug !== "all" &&
      !match.participants.some((p) => p.agentSlug === filters.agentSlug)
    ) {
      return false;
    }
    if (filters.map !== "all" && match.map !== filters.map) return false;
    if (filters.mapSize !== "all" && match.mapSize !== filters.mapSize) return false;
    if (filters.featured === "featured" && !featuredMatchIds.has(match.matchId)) {
      return false;
    }
    if (filters.cleanliness !== "all") {
      const { elevated } = computeDegradedShare(match.degradedCount ?? 0, match.decisionCount);
      if (filters.cleanliness === "clean" && elevated) return false;
      if (filters.cleanliness === "degraded" && !elevated) return false;
    }
    const completedDate = match.completedAt.slice(0, 10);
    if (filters.dateFrom !== null && completedDate < filters.dateFrom) return false;
    if (filters.dateTo !== null && completedDate > filters.dateTo) return false;
    return true;
  });
}

/**
 * `AgentMatchRecap`'s deduped 0-100 public "best battles" ranking score
 * (2026-08-01 fix) — the preferred evidence signal over the legacy raw
 * `AgentDramaReport` composite, which this client never reads at all
 * (never shipped to the wire in the first place). `null` when the
 * mirror's narrative backfill hasn't reached this episode yet, or found
 * nothing story-worthy — never a fabricated score.
 */
export function curatedDramaScoreOf(match: PublicMatch): number | null {
  return match.dramaEvidence?.curatedDramaScore ?? null;
}

/**
 * Ranks the (already filtered) archive for display. "recent" re-sorts by
 * `completedAt` desc (the caller's own natural order, restated here so
 * this function is a real sort regardless of input order). "dramatic"
 * ranks by `curatedDramaScoreOf` desc, with every evidence-less match
 * sorted after every scored one (never blended in ascending-tiebreak
 * order with a real score) — WITHIN each of those two groups, ties keep
 * `completedAt` desc as the secondary order.
 */
export function sortArchiveMatches(
  matches: readonly (PublicMatch & { completedAt: string })[],
  sortOrder: "recent" | "dramatic",
): (PublicMatch & { completedAt: string })[] {
  if (sortOrder === "recent") {
    return [...matches].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }
  return [...matches].sort((a, b) => {
    const scoreA = curatedDramaScoreOf(a);
    const scoreB = curatedDramaScoreOf(b);
    if (scoreA === null && scoreB === null) return b.completedAt.localeCompare(a.completedAt);
    if (scoreA === null) return 1;
    if (scoreB === null) return -1;
    return scoreB - scoreA || b.completedAt.localeCompare(a.completedAt);
  });
}

/**
 * Reused by `MatchDetailPage.ts`'s league-episode render path (a
 * completed match's own `degradedCount`/`decisionCount` pair) so the
 * archive card and the match page show the exact same wording rather than
 * two independently-drifting copies.
 */
export function renderDegradedNote(match: {
  degradedCount: number | null;
  decisionCount: number | null;
}): TemplateResult | typeof nothing {
  if (match.degradedCount === null || match.degradedCount === 0) return nothing;
  const { share } = computeDegradedShare(match.degradedCount, match.decisionCount);
  return html`<span title=${translateText("watch.degraded_turns_tooltip")}
    >${share === null
      ? translateText("watch.recovered_plain", { count: match.degradedCount })
      : translateText("watch.recovered_share", {
          count: match.degradedCount,
          percent: share,
        })}</span
  >`;
}

/**
 * Resolves the winner's display name for a completed match: prefer the
 * registered Agent's own `displayName` (looked up by `winnerAgentSlug`);
 * fall back to the raw participant `displayName` already embedded on
 * `PublicMatch.participants` when the winner has no registered Agent at
 * all. `null` only when the match genuinely records no winner.
 */
export function resolveWinnerName(
  match: PublicMatch,
  agents: readonly PublicAgent[],
): string | null {
  if (match.winnerAgentSlug === null) return null;
  const registered = agents.find((agent) => agent.slug === match.winnerAgentSlug);
  if (registered !== undefined) return registered.displayName;
  const participant = match.participants.find(
    (p) => p.agentSlug === match.winnerAgentSlug,
  );
  return participant?.displayName ?? null;
}

/** Exported (2026-08-01 P0) so `LobbyPage`'s own season-schedule strip formats a slot's date/time identically — one source of truth, matching `formatDuration`'s own export precedent just below. */
export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * Countdown-or-elapsed note for a live premiere, computed purely from the
 * client's own clock against `scheduledAtIso` — same known
 * simplification as this file's own `clientNowMs` doc (no server-skew
 * correction).
 */
export function describeSchedule(scheduledAtIso: string, nowMs: number): string {
  const scheduledMs = Date.parse(scheduledAtIso);
  if (Number.isNaN(scheduledMs)) return translateText("watch.schedule_unavailable");
  const deltaMs = scheduledMs - nowMs;
  if (deltaMs > 0) {
    return translateText("watch.starts_in", { duration: formatDuration(deltaMs) });
  }
  return translateText("watch.started_ago", { duration: formatDuration(-deltaMs) });
}

/**
 * `Xh Ym` / `Xm Ys` / `Xs` duration formatting, exported so `LobbyPage`'s
 * hero-state countdown/elapsed-timer reuses the exact same convention
 * instead of a second implementation.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
