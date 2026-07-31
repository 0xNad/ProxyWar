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
  formatDuration,
  resolveWinnerName,
} from "./WatchPage";
import { buildIcsEvent } from "./Ics";

/**
 * `/` — the event lobby (spec §4 Target IA: "no longer a bare redirect to
 * the league table"; Stage 2 item 4, three hero states). No game/replay
 * bundle loads here — every action is a plain link to another route
 * (spec Stage 2 item 6).
 *
 * Hero state, checked in order:
 *   A. `premieres.live` present and `premierePageLive === true` — an active
 *      premiere. Label is ALWAYS "Live Premiere", never wording implying the
 *      match is executing at this instant beyond that literal label. Shows a
 *      live, ticking elapsed-time note (`renderHeroActivePremiere`):
 *      `now - scheduledAt`, updated ~1s by a component-owned interval
 *      (`connectedCallback`/`disconnectedCallback`) — `scheduledAt` is the
 *      only anchor `CoworldLeaguePremiereCard` carries, so it doubles as the
 *      elapsed-time origin once the premiere IS live.
 *   B. `premieres.live` present and `premierePageLive === false` — scheduled,
 *      counting down (client clock; same known simplification as
 *      `WatchPage`'s countdown, documented there). The countdown ticks live
 *      the same way state A's elapsed timer does. Deliberately still a pure
 *      client-clock countdown, NOT skew-corrected against the read model's
 *      `generatedAt`: that timestamp is a periodic-mirror-poll snapshot
 *      (`COWORLD_LEAGUE_POLL_INTERVAL_MS`, up to ~30s stale), so treating it
 *      as a live clock-sync signal would trade small, usually-sub-second
 *      client clock error for a systematic ~0-30s bias — not an honest
 *      improvement. State B also offers "Add to calendar" (`Ics.ts`, a pure
 *      client-side `.ics` download, no server round-trip) and a purely
 *      local "Remind me" (localStorage-armed, same-tab visual cue + tab
 *      title flash at start time — NOT a push/OS notification; this
 *      codebase has no service worker to back that promise).
 *   C. Neither — falls back to `premieres.latest` (an actual revealed
 *      premiere) when present, else the single most recently completed
 *      match with a watchable render. This is deliberately the SIMPLEST
 *      honest selection, not a drama-score ranking: no per-match "drama
 *      report" artifact is available for hosted league episodes in this
 *      read model today (Stage 5's Director Cut is what's actually specced
 *      to replace this placeholder), so state C never claims a drama-score
 *      selection it isn't actually running.
 *
 * DELIBERATE DEFERRAL: states A/B stay exactly as spoiler-conservative on
 * participant identity as before — no agent name, emblem, version, color,
 * or Builder was added here. `CoworldLeaguePremiereCard` is intentionally
 * limited to 5 fields precisely so the premiere leak audit can guarantee no
 * held premiere is ever spoiled; widening it (or sourcing identity from
 * elsewhere) needs its own security review of the leak-surface list before
 * it's safe, which is out of scope for this pass.
 */

/** localStorage key prefix for the local-only "Remind me" reminder state (see the class's Remind-me section for exactly what this does and doesn't guarantee). */
const REMINDER_KEY_PREFIX = "proxywar:premiere-reminder:";
@customElement("lobby-page")
export class LobbyPage extends LitElement {
  @state() private loadState: "loading" | "ready" | "error" = "loading";
  @state() private readModel: ReadModel | null = null;
  /** Drives hero state A's elapsed timer and state B's countdown — ticked ~1s by a component-owned interval, never a longer-lived timer and never the server clock continuously (see class doc on why the countdown stays client-clock-only). */
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
      const live = this.readModel?.premieres.live;
      if (live !== null && live !== undefined && !live.premierePageLive) {
        this.fireReminderIfDue(live, this.nowMs);
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
    // `CoworldLeaguePremiereCard` carries only `premierePageLive` and
    // `scheduledAt` — there is no separate "actual start" timestamp, so
    // once the premiere IS live, `scheduledAt` doubles as the
    // elapsed-time anchor. It's the only signal available, and the
    // correct one: the premiere pipeline flips `premierePageLive` at (or
    // immediately after) `scheduledAt` by construction.
    const startMs = Date.parse(live.scheduledAt);
    const elapsed = Number.isNaN(startMs)
      ? null
      : formatDuration(Math.max(0, this.nowMs - startMs));
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
        ${elapsed !== null
          ? html`<p
              class="mt-1 font-mono text-sm font-bold text-live"
              role="timer"
              aria-live="polite"
            >
              ${translateText("lobby.live_elapsed", { duration: elapsed })}
            </p>`
          : nothing}
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
    // Pure client-clock countdown — see class doc for why this stays
    // honest rather than skew-correcting against `generatedAt`.
    const countdown = scheduledValid
      ? formatDuration(Math.max(0, scheduled.getTime() - this.nowMs))
      : null;
    const reminder = this.reminderState(live.premiereId);
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
            </p>
            <p
              class="mt-1 font-mono text-lg font-black text-ink"
              role="timer"
              aria-live="polite"
            >
              ${translateText("lobby.countdown_value", { duration: countdown! })}
            </p>
            <p class="mt-1 text-xs text-ink-muted">
              ${translateText("lobby.countdown_note")}
            </p>`
          : nothing}
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <a
            href="/premiere/${encodeURIComponent(live.premiereId)}"
            class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-5 font-black text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
            >${translateText("lobby.view_matchup")}</a
          >
          ${scheduledValid ? this.renderAddToCalendar(live) : nothing}
          ${scheduledValid ? this.renderRemindMe(live, reminder) : nothing}
        </div>
        ${reminder === "fired"
          ? html`<p
              class="mt-3 rounded-md border border-live/50 bg-live/10 px-3 py-2 text-sm font-bold text-live"
              role="status"
            >
              ${translateText("lobby.remind_me_live_cue")}
            </p>`
          : nothing}
      `,
      "border-info/40",
    );
  }

  // ---- Add to calendar (ICS) ---------------------------------------------

  private renderAddToCalendar(
    live: NonNullable<ReadModel["premieres"]["live"]>,
  ): TemplateResult {
    return html`
      <a
        href="#"
        class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-4 text-sm font-bold text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
        @click=${(event: MouseEvent) => this.downloadIcs(event, live)}
        >${translateText("lobby.add_to_calendar")}</a
      >
    `;
  }

  /** Client-side only, no server round-trip — builds the .ics in-browser (`Ics.ts`) and offers it as a Blob download. `title` uses ONLY already-safe fields (round number, map label), same participant-identity constraint as the hero itself (see class doc). */
  private downloadIcs(
    event: MouseEvent,
    live: NonNullable<ReadModel["premieres"]["live"]>,
  ): void {
    event.preventDefault();
    const title =
      live.roundNumber !== null
        ? `Proxy War Premiere — Round ${live.roundNumber} (${live.mapLabel})`
        : `Proxy War Premiere (${live.mapLabel})`;
    const url = `${window.location.origin}/premiere/${encodeURIComponent(live.premiereId)}`;
    const ics = buildIcsEvent({ title, scheduledAt: live.scheduledAt, url });
    const objectUrl = URL.createObjectURL(
      new Blob([ics], { type: "text/calendar;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `proxy-war-premiere-${live.premiereId}.ics`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  // ---- Remind me (local, same-tab only) ----------------------------------
  //
  // PURELY client-side, no server write (spec: "Remind me (local)"). This
  // codebase has no service worker, so a reminder can never survive a
  // closed tab or deliver an OS-level push notification — the button's own
  // tooltip says exactly that. "Armed" persists in localStorage so a
  // reload doesn't re-prompt; "fired" persists so a reload after start
  // time doesn't re-show the cue or re-flash the tab title.

  private reminderState(premiereId: string): "idle" | "armed" | "fired" {
    try {
      const raw = localStorage.getItem(`${REMINDER_KEY_PREFIX}${premiereId}`);
      return raw === "armed" || raw === "fired" ? raw : "idle";
    } catch {
      return "idle";
    }
  }

  private armReminder(premiereId: string): void {
    try {
      localStorage.setItem(`${REMINDER_KEY_PREFIX}${premiereId}`, "armed");
    } catch {
      // Storage unavailable (private browsing, quota) — no-op this session, never a crash.
    }
    this.requestUpdate();
  }

  /** Called every tick while a premiere is upcoming. Fires once, at or after `scheduledAt`: marks "fired" in localStorage and flashes the document title so the cue is visible even from a background tab — still requires the tab to stay open (see the button's tooltip copy). */
  private fireReminderIfDue(
    live: NonNullable<ReadModel["premieres"]["live"]>,
    nowMs: number,
  ): void {
    if (this.reminderState(live.premiereId) !== "armed") return;
    const startMs = Date.parse(live.scheduledAt);
    if (Number.isNaN(startMs) || nowMs < startMs) return;
    try {
      localStorage.setItem(`${REMINDER_KEY_PREFIX}${live.premiereId}`, "fired");
    } catch {
      // Best effort — the visual cue still renders this tick regardless.
    }
    // Checked without a trailing space: the DOM's title-setting algorithm
    // trims trailing whitespace, so `LIVE: ${title}` against an EMPTY base
    // title normalizes to the stored value "LIVE:" with no trailing space —
    // a `startsWith("LIVE: ")` check would never match its own output in
    // that case and re-prepend the prefix on every subsequent tick.
    if (!document.title.startsWith("LIVE:")) {
      document.title = `LIVE: ${document.title}`;
    }
    this.requestUpdate();
  }

  private renderRemindMe(
    live: NonNullable<ReadModel["premieres"]["live"]>,
    state: "idle" | "armed" | "fired",
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
        @click=${() => this.armReminder(live.premiereId)}
      >
        ${state === "armed"
          ? translateText("lobby.remind_me_armed")
          : translateText("lobby.remind_me_button")}
      </button>
    `;
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
