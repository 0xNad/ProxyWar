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
  PublicFeaturedMatch,
  PublicMatch,
  ReadModel,
} from "./ReadModelSchema";
import {
  computeDegradedShare,
  curatedDramaScoreOf,
  fetchFeaturedEventParticipants,
  findPromotableEvent,
  formatDuration,
  isEventLive,
  renderParticipantChips,
  renderParticipantChipsFromMatch,
  resolveWinnerName,
  type FeaturedEventParticipant,
} from "./WatchPage";
import {
  armReminder,
  downloadIcsFile,
  fireReminderIfDue,
  readReminderState,
  type ReminderState,
} from "./PremiereReminder";

/**
 * `/` — the event lobby (Season Zero activation prompt Phase 5,
 * "Homepage"). The first viewport is EVENT-FIRST: a single visual event
 * stage, never the old generic eyebrow/mission-headline/plain-bordered-
 * event-box/map+round/CTA pattern this file used to render — see
 * `renderHero`'s own doc for the three states this now dispatches on.
 *
 * The load-bearing change from the prior design: hero selection now keys
 * off `ReadModel.featuredMatches[].isPubliclyPromotable` via
 * `WatchPage.findPromotableEvent` (Season Zero Phase 4's gate —
 * `EventPackageGate.isPubliclyPromotable`, wired through
 * `ProxyWarPublicReadModel.ts`), NEVER off the raw, anonymous
 * `ReadModel.premieres.live`/`latest` pointers (`CoworldLeaguePremiereCard`
 * — map/round/time only, no title, no reason to watch — System B's
 * continuous, un-packaged premiere roll). A premiere-lane record can only
 * ever report `isPubliclyPromotable: true` once it carries a complete
 * `EventPackage` AND has reached `state: "published"` (the operator's own
 * `premiere:publish` "yes, run this one" signal) — see that gate's own
 * state-check doc. No game/replay bundle loads here — every action is a
 * plain link to another route.
 *
 * `findPromotableEvent`/`isEventLive`/participant-fetch/chip-render
 * helpers live in `WatchPage.ts` and are shared verbatim with this file —
 * see that module's own doc for why (one source of truth for "is there a
 * live/upcoming Featured Event right now").
 */

/**
 * Bounded recency window (most-recent-N by `completedAt`) that the
 * Director-Cut fallback hero state and Recent Director Cuts both rank by
 * `dramaEvidence.curatedDramaScore` within — matches the scale of this
 * file's other bounded lists (e.g. the league pulse's top 5). Bounding
 * the window means a high-scoring match that has already aged off the
 * front page is never dredged back up on score alone.
 */
const DRAMA_RECENCY_WINDOW_SIZE = 8;

/** Agents-to-know cap — small enough to stay a highlight reel, not a second standings table. */
const AGENTS_TO_KNOW_LIMIT = 5;
/** League-movement cap — same reasoning. */
const LEAGUE_MOVEMENT_LIMIT = 5;
/** Season-schedule preview cap — the schedule module is a below-hero teaser, not the full programme (that's `/watch`'s job). */
const SEASON_SCHEDULE_PREVIEW_LIMIT = 3;

@customElement("lobby-page")
export class LobbyPage extends LitElement {
  @state() private loadState: "loading" | "ready" | "error" = "loading";
  @state() private readModel: ReadModel | null = null;
  @state() private promotableEvent: PublicFeaturedMatch | null = null;
  @state() private heroParticipants: FeaturedEventParticipant[] = [];
  /** Drives the live/upcoming countdown-or-elapsed note — ticked ~1s by a component-owned interval, never a longer-lived timer and never the server clock continuously (a periodic-mirror-poll snapshot is not a live clock-sync signal). */
  @state() private nowMs = Date.now();
  private tickHandle: number | null = null;

  createRenderRoot() {
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    this.tickHandle = window.setInterval(() => {
      this.nowMs = Date.now();
      const event = this.promotableEvent;
      if (event !== null && event.scheduledAt !== null) {
        if (fireReminderIfDue(event.matchId, event.scheduledAt, this.nowMs)) {
          this.requestUpdate();
        }
      }
    }, 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private async load(): Promise<void> {
    this.loadState = "loading";
    this.heroParticipants = [];
    this.promotableEvent = null;
    try {
      this.readModel = await fetchReadModel();
      this.loadState = "ready";
      const event = findPromotableEvent(this.readModel);
      this.promotableEvent = event;
      if (event !== null) {
        void this.loadHeroParticipants(event.matchId);
      }
    } catch {
      this.loadState = "error";
    }
  }

  /**
   * Fires alongside — never blocking — `load()`'s own ready/error
   * transition: a failure here degrades silently to "no participant
   * section", it never flips `loadState` to `"error"` on its own and
   * never shows a second spinner.
   *
   * Guarded by `isConnected`, the same disconnect-race guard this
   * codebase already uses for exactly this "fetch resolves after
   * teardown" case — `heroParticipants` MUST never be written after
   * `disconnectedCallback` has already run.
   */
  private async loadHeroParticipants(matchId: string): Promise<void> {
    try {
      const participants = await fetchFeaturedEventParticipants(matchId);
      if (!this.isConnected) return;
      this.heroParticipants = participants;
    } catch {
      // Network failure or a schema mismatch — leave `heroParticipants`
      // empty, i.e. no participant section renders.
    }
  }

  render() {
    return html`
      ${appShellHeader(
        "/",
        this.isCurrentEventLive()
          ? { label: translateText("lobby.live_premiere_badge"), tone: "live" }
          : this.readModel?.stale === true
            ? { label: translateText("lobby.stale_data_badge"), tone: "stale" }
            : undefined,
        this.readModel?.links.accountUrl,
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

  private isCurrentEventLive(): boolean {
    return this.promotableEvent !== null && isEventLive(this.promotableEvent, this.nowMs);
  }

  /**
   * A structural skeleton — not just a spinner/text line — reserving
   * roughly the same vertical space as `renderReady()`'s hero + below-hero
   * modules. Every block is decorative (`aria-hidden`); the accessible
   * loading state is still announced via the single `role="status"` text
   * below. Pulses respect `prefers-reduced-motion` globally.
   */
  private renderLoading() {
    const block = (extra = "") =>
      html`<div
        class="animate-pulse rounded-md bg-surface-2 ${extra}"
        aria-hidden="true"
      ></div>`;
    return html`
      <p class="sr-only" role="status">${translateText("lobby.loading")}</p>
      <section
        class="overflow-hidden rounded-xl border border-line bg-surface p-6 sm:p-8"
        aria-hidden="true"
      >
        ${block("h-5 w-40")}
        <div class="mt-3">${block("h-9 w-2/3 max-w-xl")}</div>
        <div class="mt-3">${block("h-4 w-full max-w-2xl")}</div>
        <div class="mt-5 flex gap-2">
          ${block("h-9 w-9 rounded-full")}${block("h-9 w-9 rounded-full")}${block("h-9 w-9 rounded-full")}
        </div>
        <div class="mt-5">${block("h-11 w-56")}</div>
      </section>
      <div class="mt-8" aria-hidden="true">${block("h-24 w-full")}</div>
      <div
        class="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3"
        aria-hidden="true"
      >
        <div class="lg:col-span-2">${block("h-64 w-full")}</div>
        <div>${block("h-64 w-full")}</div>
      </div>
      <div class="mt-10" aria-hidden="true">${block("h-40 w-full")}</div>
      <div class="mt-10" aria-hidden="true">${block("h-32 w-full")}</div>
    `;
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
      ${this.renderHero(model)}
      ${this.renderSeasonSchedule(model)}
      <div class="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div class="lg:col-span-2">${this.renderLeagueMovement(model)}</div>
        <div>${this.renderAgentsToKnow(model)}</div>
      </div>
      ${this.renderRecentDirectorCuts(model)} ${this.renderBuilderBand(model)}
    `;
  }

  // ---- Hero / event stage -------------------------------------------------

  /**
   * Three states, checked in order:
   *   A. A complete, `isPubliclyPromotable` premiere-lane event exists
   *      (`state: "published"`) — the visual event stage: title, reason
   *      to watch, status, full lineup, Director Cut runtime once known,
   *      one primary CTA. Live vs. upcoming is a pure `scheduledAt <=
   *      now` comparison against the client clock (`isEventLive`).
   *   B. No promotable event — falls back to the single best recent
   *      Director Cut within a bounded recency window (evidence-ranked by
   *      `dramaEvidence.curatedDramaScore`, ties/absence falling back to
   *      recency), shown with its own competitors/reason/runtime — NEVER
   *      a bare map+round card.
   *   C. Neither exists yet (a fresh league with no retained history) —
   *      an honest empty note.
   */
  private renderHero(model: ReadModel): TemplateResult {
    if (this.promotableEvent !== null) {
      return this.renderHeroPromotableEvent(this.promotableEvent);
    }
    return this.renderHeroDirectorCutFallback(model);
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

  private renderHeroPromotableEvent(event: PublicFeaturedMatch): TemplateResult {
    const live = this.isCurrentEventLive();
    const scheduled =
      event.scheduledAt !== null ? new Date(event.scheduledAt) : null;
    const scheduledValid = scheduled !== null && !Number.isNaN(scheduled.getTime());
    const elapsedOrCountdown =
      live && scheduledValid
        ? formatDuration(Math.max(0, this.nowMs - scheduled!.getTime()))
        : !live && scheduledValid
          ? formatDuration(Math.max(0, scheduled!.getTime() - this.nowMs))
          : null;
    const reminder = readReminderState(event.matchId);
    const watchHref = event.canonicalPremiereUrl ?? `/match/${encodeURIComponent(event.matchId)}`;
    return this.heroShell(
      html`
        <span
          class="inline-flex items-center gap-2 rounded-full border ${live
            ? "border-live/60 bg-live/10 text-live-text"
            : "border-info/50 bg-info/10 text-info"} px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide"
        >
          ${live
            ? html`<span class="h-2 w-2 rounded-full bg-live" aria-hidden="true"></span>`
            : nothing}
          ${live
            ? translateText("lobby.live_premiere_badge")
            : translateText("lobby.upcoming_premiere_badge")}
        </span>
        <h1 class="mt-3 text-3xl font-black leading-tight text-ink sm:text-4xl">
          ${event.title}
        </h1>
        ${event.subtitle !== null
          ? html`<p class="mt-1 text-base text-ink-dim">${event.subtitle}</p>`
          : nothing}
        ${event.reasonToWatch !== null && event.reasonToWatch.length > 0
          ? html`<p class="mt-3 max-w-2xl text-sm text-ink-muted">
              ${event.reasonToWatch.join(" ")}
            </p>`
          : nothing}
        ${scheduledValid
          ? html`<p class="mt-3 text-sm text-ink-muted">
              ${live
                ? translateText("lobby.live_elapsed", { duration: elapsedOrCountdown! })
                : html`${translateText("lobby.scheduled_for")}
                    <time datetime=${event.scheduledAt!}
                      >${scheduled!.toLocaleString()}
                      ${translateText("lobby.local_time_suffix")}</time
                    >
                    · ${translateText("lobby.countdown_value", { duration: elapsedOrCountdown! })}`}
            </p>`
          : nothing}
        ${event.directorCutEstimateSeconds !== null
          ? html`<p class="mt-1 text-xs font-semibold text-ink-muted">
              ${translateText("lobby.event_stage_director_cut_runtime", {
                minutes: Math.max(1, Math.round(event.directorCutEstimateSeconds / 60)),
              })}
            </p>`
          : nothing}
        ${this.heroParticipants.length > 0
          ? html`<div class="mt-4 border-t border-line pt-4">
              <p class="text-sm font-black uppercase tracking-wide text-ink-muted">
                ${translateText("lobby.hero_participants_heading")}
              </p>
              ${renderParticipantChips(this.heroParticipants)}
            </div>`
          : nothing}
        <div class="mt-5 flex flex-wrap items-center gap-3">
          <a
            href=${watchHref}
            class="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 font-black text-on-accent no-underline outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            >${live
              ? translateText("lobby.event_stage_watch_live_cta")
              : scheduledValid
                ? translateText("lobby.event_stage_watch_premiere_cta", {
                    time: scheduled!.toLocaleString(),
                  })
                : translateText("lobby.watch_now")}</a
          >
          ${!live && scheduledValid ? this.renderAddToCalendar(event) : nothing}
          ${!live && scheduledValid ? this.renderRemindMe(event, reminder) : nothing}
        </div>
        ${reminder === "fired"
          ? html`<p
              class="mt-3 rounded-md border border-live/50 bg-live/10 px-3 py-2 text-sm font-bold text-live-text"
              role="status"
            >
              ${translateText("lobby.remind_me_live_cue")}
            </p>`
          : nothing}
      `,
      live ? "border-live/50" : "border-info/40",
    );
  }

  // ---- Add to calendar (ICS) ---------------------------------------------

  private renderAddToCalendar(event: PublicFeaturedMatch): TemplateResult {
    return html`
      <a
        href="#"
        class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-4 text-sm font-bold text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
        @click=${(clickEvent: MouseEvent) => this.downloadIcs(clickEvent, event)}
        >${translateText("lobby.add_to_calendar")}</a
      >
    `;
  }

  /** Client-side only, no server round-trip — see `PremiereReminder.ts`'s `downloadIcsFile`. Uses the event's own real title/subtitle: safe at this point because `isPubliclyPromotable` already requires `state: "published"` or later, the same floor participant identity itself goes public at. */
  private downloadIcs(clickEvent: MouseEvent, event: PublicFeaturedMatch): void {
    clickEvent.preventDefault();
    if (event.scheduledAt === null) return;
    const url =
      event.canonicalPremiereUrl ??
      `${window.location.origin}/match/${encodeURIComponent(event.matchId)}`;
    downloadIcsFile(
      { title: event.title, scheduledAt: event.scheduledAt, url },
      `proxy-war-premiere-${event.matchId}`,
    );
  }

  // ---- Remind me (local, same-tab only) ----------------------------------

  private renderRemindMe(
    event: PublicFeaturedMatch,
    state: ReminderState,
  ): TemplateResult {
    if (state === "fired") {
      return html`<span class="text-sm font-semibold text-ink-muted"
        >${translateText("lobby.remind_me_sent")}</span
      >`;
    }
    return html`
      <button
        type="button"
        title=${translateText("lobby.remind_me_tooltip")}
        class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-4 text-sm font-bold text-ink outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
        ?disabled=${state === "armed"}
        @click=${() => {
          armReminder(event.matchId);
          this.requestUpdate();
        }}
      >
        ${state === "armed"
          ? translateText("lobby.remind_me_armed")
          : translateText("lobby.remind_me_button")}
      </button>
    `;
  }

  // ---- Hero fallback: best recent Director Cut ---------------------------

  /**
   * No promotable Featured Event exists right now — the doc's own
   * fallback: "lead with the best recent Director Cut; show its
   * competitors; show why it is worth watching; show its runtime; show
   * the next expected schedule window." Ranked exactly like `renderHero`'s
   * OLD state-C fallback (evidence-aware within a bounded recency
   * window), but now with competitors + Director Cut runtime rendered
   * inline, never just a bare map+round label.
   */
  private renderHeroDirectorCutFallback(model: ReadModel): TemplateResult {
    const recencyWindow = [...model.matches]
      .filter(
        (match) => match.completedAt !== null && match.fullRenderHref !== null,
      )
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .slice(0, DRAMA_RECENCY_WINDOW_SIZE);
    const scoredInWindow = recencyWindow.filter(
      (match) => curatedDramaScoreOf(match) !== null,
    );
    const fallback =
      scoredInWindow.length > 0
        ? [...scoredInWindow].sort(
            (a, b) =>
              (curatedDramaScoreOf(b) ?? -1) - (curatedDramaScoreOf(a) ?? -1) ||
              (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
          )[0]
        : recencyWindow.at(0);
    if (fallback === undefined) {
      return this.heroShell(
        html`<h1 class="text-2xl font-extrabold text-ink">
            ${translateText("lobby.no_premiere_title")}
          </h1>
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
    const dramaScore = curatedDramaScoreOf(fallback);
    const roundLabel =
      fallback.roundNumber !== null
        ? translateText("lobby.round_suffix", { round: fallback.roundNumber })
        : "";
    const runtimeMinutes =
      fallback.directorCut !== null
        ? Math.max(1, Math.round(fallback.directorCut.durationEstimateSeconds / 60))
        : null;
    return this.heroShell(
      html`
        <span
          class="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide text-ink-muted"
        >
          ${translateText("lobby.recent_battle_badge")}
        </span>
        ${dramaScore !== null
          ? html`<span
              class="ml-2 inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide text-ink-muted"
            >
              ${translateText("lobby.high_drama_badge", { score: dramaScore })}
            </span>`
          : nothing}
        <h1 class="mt-3 text-2xl font-extrabold text-ink sm:text-3xl">
          ${fallback.map}${roundLabel}
        </h1>
        <p class="mt-1 text-sm text-ink-muted">
          ${translateText("lobby.recent_battle_note")}
        </p>
        ${runtimeMinutes !== null
          ? html`<p class="mt-1 text-xs font-semibold text-ink-muted">
              ${translateText("lobby.event_stage_director_cut_runtime", {
                minutes: runtimeMinutes,
              })}
            </p>`
          : nothing}
        ${renderParticipantChipsFromMatch(fallback, model.agents)}
        ${this.renderNextExpectedWindow(model)}
        <div class="mt-5">
          <a
            href=${fallback.fullRenderHref!}
            class="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 font-black text-on-accent no-underline outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            >${runtimeMinutes !== null
              ? translateText("lobby.event_stage_director_cut_cta", {
                  minutes: runtimeMinutes,
                })
              : translateText("lobby.browse_all_matches")}</a
          >
        </div>
      `,
      "border-line",
    );
  }

  /** Season Zero activation prompt Phase 5: "show the next expected schedule window" — the earliest FUTURE event slot across every active season, regardless of whether it already has a complete package. Omitted entirely when none exists (never a fabricated date). */
  private renderNextExpectedWindow(model: ReadModel): TemplateResult | typeof nothing {
    const nowIso = new Date(this.nowMs).toISOString();
    const nextSlot = model.seasons
      .filter((season) => season.state === "active")
      .flatMap((season) => season.eventSlots)
      .filter((slot) => slot.scheduledAt !== null && slot.scheduledAt > nowIso)
      .sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""))
      .at(0);
    if (nextSlot === undefined || nextSlot.scheduledAt === null) return nothing;
    return html`
      <p class="mt-3 text-xs font-semibold text-ink-muted">
        ${translateText("lobby.next_expected_window", {
          date: new Date(nextSlot.scheduledAt).toLocaleString(),
        })}
      </p>
    `;
  }

  // ---- Season Zero schedule -----------------------------------------------

  /**
   * Doc: "Next event or Season Zero schedule" — a compact preview of the
   * active Season's programme (up to `SEASON_SCHEDULE_PREVIEW_LIMIT`
   * upcoming slots), complementing the hero's single spotlight rather
   * than duplicating it. Omitted entirely when no season is active.
   */
  private renderSeasonSchedule(model: ReadModel): TemplateResult | typeof nothing {
    const active = model.seasons.find((season) => season.state === "active");
    if (active === undefined) return nothing;
    const featuredMatchById = new Map(
      model.featuredMatches.map((match) => [match.matchId, match]),
    );
    const upcomingSlots = [...active.eventSlots]
      .sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""))
      .slice(0, SEASON_SCHEDULE_PREVIEW_LIMIT);
    return html`
      <section class="mt-8 rounded-xl border border-line bg-surface-2 p-5" aria-labelledby="season-schedule-heading">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="season-schedule-heading" class="text-sm font-black uppercase tracking-wide text-ink-muted">
            ${translateText("lobby.season_schedule_heading", { title: active.title })}
          </h2>
          <span class="font-mono text-xs text-ink-muted">
            ${new Date(active.startDate).toLocaleDateString()} – ${new Date(active.endDate).toLocaleDateString()}
          </span>
        </div>
        ${upcomingSlots.length === 0
          ? html`<p class="mt-2 text-sm text-ink-muted">
              ${translateText("lobby.season_schedule_empty")}
            </p>`
          : html`<ol class="mt-3 flex flex-col gap-2" role="list">
              ${upcomingSlots.map((slot) => {
                const resolved = featuredMatchById.get(slot.featuredMatchId);
                return html`
                  <li class="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2">
                    <span class="font-mono text-xs text-ink-muted">
                      ${slot.scheduledAt !== null
                        ? new Date(slot.scheduledAt).toLocaleDateString()
                        : "—"}
                    </span>
                    ${resolved !== undefined
                      ? html`<a
                          href="/match/${encodeURIComponent(resolved.matchId)}"
                          class="min-w-0 flex-1 truncate text-sm font-semibold text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                          >${resolved.title}</a
                        >`
                      : html`<span class="min-w-0 flex-1 truncate text-sm text-ink-muted"
                          >${translateText("lobby.season_schedule_tbd")}</span
                        >`}
                  </li>
                `;
              })}
            </ol>`}
      </section>
    `;
  }

  // ---- League movement -----------------------------------------------------

  /**
   * Doc: "rank changes; version debuts; meaningful recent form." Replaces
   * the prior static top-5-by-rank list with a delta-aware one: each
   * agent's rank movement is read straight off `timeSeries.score.points`
   * (`ScoreSeriesPoint.rank`, comparing the last two recorded points —
   * `AgentTimeSeries`'s own doc: below-threshold series are `null`, never
   * a fabricated 1-2 point "trend"), and `versionFirstObserved` on the
   * latest point flags a genuine version debut — no invented notability.
   */
  private renderLeagueMovement(model: ReadModel): TemplateResult {
    const withMovement = model.agents
      .filter((agent) => agent.standing !== null)
      .map((agent) => {
        const points = agent.timeSeries?.score?.points ?? [];
        const latest = points.at(-1);
        const previous = points.at(-2);
        const rankDelta =
          latest !== undefined && previous !== undefined
            ? previous.rank - latest.rank
            : null;
        return {
          agent,
          rankDelta,
          isDebut: latest?.versionFirstObserved === true,
        };
      })
      .sort((a, b) => (a.agent.standing?.rank ?? 0) - (b.agent.standing?.rank ?? 0))
      .slice(0, LEAGUE_MOVEMENT_LIMIT);
    return html`
      <section aria-labelledby="league-movement-heading">
        <div class="mb-3 flex items-baseline justify-between gap-2">
          <h2
            id="league-movement-heading"
            class="text-sm font-black uppercase tracking-wide text-ink-muted"
          >
            ${translateText("lobby.league_movement_heading")}
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
        ${withMovement.length === 0
          ? html`<p class="text-sm text-ink-muted">
              ${translateText("lobby.no_standings")}
            </p>`
          : html`<ol class="flex flex-col gap-2" role="list">
              ${withMovement.map((entry) => this.renderMovementRow(entry))}
            </ol>`}
        <a
          href="/league"
          class="mt-3 inline-block text-sm font-bold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("lobby.full_standings")}</a
        >
      </section>
    `;
  }

  private renderMovementRow(entry: {
    agent: PublicAgent;
    rankDelta: number | null;
    isDebut: boolean;
  }): TemplateResult {
    const { agent, rankDelta, isDebut } = entry;
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
        ${isDebut
          ? html`<span
              class="rounded-full border border-accent/50 px-1.5 py-0.5 font-mono text-[10px] font-extrabold uppercase tracking-wide text-accent"
              >${translateText("lobby.version_debut_badge")}</span
            >`
          : nothing}
        ${rankDelta !== null && rankDelta !== 0
          ? html`<span
              class="font-mono text-xs font-bold ${rankDelta > 0 ? "text-live-text" : "text-danger"}"
              >${rankDelta > 0
                ? translateText("lobby.rank_change_up", { delta: rankDelta })
                : translateText("lobby.rank_change_down", { delta: Math.abs(rankDelta) })}</span
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

  // ---- Agents to know ------------------------------------------------------

  /**
   * Doc: "actual identity and style; not simply 'has at least two wins.'"
   * Selection: registered agents with an operator-written `tagline`
   * (real identity/style copy) first, ranked by standing rank; agents
   * with no tagline fill remaining slots ranked by recent win count as a
   * fallback signal — still evidence-based, never a fabricated
   * personality blurb.
   */
  private renderAgentsToKnow(model: ReadModel): TemplateResult {
    const winsBySlug = new Map<string, number>();
    for (const match of model.matches) {
      if (match.winnerAgentSlug === null) continue;
      winsBySlug.set(match.winnerAgentSlug, (winsBySlug.get(match.winnerAgentSlug) ?? 0) + 1);
    }
    const withTagline = model.agents
      .filter((agent) => agent.registered && agent.tagline !== null)
      .sort((a, b) => (a.standing?.rank ?? 999) - (b.standing?.rank ?? 999));
    const withoutTagline = model.agents
      .filter(
        (agent) =>
          !(agent.registered && agent.tagline !== null) &&
          agent.slug !== null &&
          (winsBySlug.get(agent.slug) ?? 0) >= 2,
      )
      .sort((a, b) => (winsBySlug.get(b.slug ?? "") ?? 0) - (winsBySlug.get(a.slug ?? "") ?? 0));
    const notable = [...withTagline, ...withoutTagline].slice(0, AGENTS_TO_KNOW_LIMIT);
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
              ${notable.map((agent) => this.renderAgentToKnowRow(agent, winsBySlug))}
            </ul>`}
      </section>
    `;
  }

  private renderAgentToKnowRow(
    agent: PublicAgent,
    winsBySlug: ReadonlyMap<string, number>,
  ): TemplateResult {
    return html`
      <li class="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2">
        ${agent.registered && agent.emblemSvg !== null
          ? html`<span class="mt-0.5 inline-flex h-6 w-6 shrink-0 overflow-hidden" aria-hidden="true"
              >${unsafeSVG(agent.emblemSvg)}</span
            >`
          : nothing}
        <div class="min-w-0 flex-1">
          <a
            href=${agent.slug !== null ? `/agent/${encodeURIComponent(agent.slug)}` : "/league"}
            class="truncate text-sm font-semibold text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
            >${agent.displayName}</a
          >
          ${agent.tagline !== null
            ? html`<p class="truncate text-xs text-ink-muted">${agent.tagline}</p>`
            : html`<p class="text-xs text-ink-muted">
                ${translateText("lobby.recent_wins", {
                  count: winsBySlug.get(agent.slug ?? "") ?? 0,
                })}
              </p>`}
        </div>
      </li>
    `;
  }

  // ---- Recent Director Cuts ------------------------------------------------

  /**
   * Doc: "visible lineups; title; reason to watch; runtime; spoiler-safe
   * result." Ranks a bounded recency window by `curatedDramaScoreOf` desc
   * (scored matches first, unscored matches keeping their own relative
   * recency order — a stable partition, never a fabricated tie-break) to
   * pick which 3 broadcasts earn the slot, then re-sorts just those 3
   * back to newest-first for display — selection and display order are
   * separate concerns.
   */
  private renderRecentDirectorCuts(model: ReadModel): TemplateResult {
    const recencyWindow = [...model.matches]
      .filter((match) => match.completedAt !== null)
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .slice(0, DRAMA_RECENCY_WINDOW_SIZE);
    const scored = recencyWindow
      .filter((match) => curatedDramaScoreOf(match) !== null)
      .sort(
        (a, b) => (curatedDramaScoreOf(b) ?? -1) - (curatedDramaScoreOf(a) ?? -1),
      );
    const unscored = recencyWindow.filter(
      (match) => curatedDramaScoreOf(match) === null,
    );
    const recent = [...scored, ...unscored]
      .slice(0, 3)
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
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
        ${renderParticipantChipsFromMatch(match, agents)}
        ${match.directorCut !== null
          ? html`<p class="mt-2 inline-block rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
              ${translateText("lobby.event_stage_director_cut_runtime", {
                minutes: Math.max(1, Math.round(match.directorCut.durationEstimateSeconds / 60)),
              })}
            </p>`
          : nothing}
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
        ${(() => {
          const dramaScore = curatedDramaScoreOf(match);
          return dramaScore !== null
            ? html`<p
                class="mt-1 inline-block rounded border border-accent/50 px-1.5 py-0.5 font-mono text-[11px] text-accent"
              >
                ${translateText("lobby.drama_score_badge", { score: dramaScore })}
              </p>`
            : nothing;
        })()}
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
        <a
          href="/match/${encodeURIComponent(match.matchId)}"
          class="mt-2 inline-block text-sm font-bold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("lobby.view_match")}</a
        >
        ${watchHref !== null
          ? html`<a
              href=${watchHref}
              class="ml-3 mt-2 inline-block text-sm text-ink-muted no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
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

declare global {
  interface HTMLElementTagNameMap {
    "lobby-page": LobbyPage;
  }
}
