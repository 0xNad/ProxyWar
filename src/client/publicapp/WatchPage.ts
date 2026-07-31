import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  fetchReadModel,
  PublicAgent,
  PublicMatch,
  ReadModel,
} from "./ReadModelSchema";
import {
  appShellFooter,
  appShellHeader,
  APP_SHELL_ROOT_CLASSES,
} from "./AppShellChrome";
import { translateText } from "../Utils";

/**
 * `/watch` — the public "what can I watch right now" landing page (spec §4
 * Target IA, Stage 2 core route). Three states, checked in order: a live
 * premiere counting down/running (`ReadModel.premieres.live`), else the most
 * recent already-revealed premiere (`ReadModel.premieres.latest`), else an
 * honest empty note — followed unconditionally by the full replay archive
 * (`ReadModel.matches`, most recently completed first). Same lifecycle
 * pattern as `PlayerProfilePage`: light-DOM `createRenderRoot()`,
 * `connectedCallback` triggers `load()`, `render()` switches on
 * `loadState`. No attributes — this route takes no path params.
 *
 * This page never fetches a game/replay bundle itself: every result stays
 * spoiler-safe behind a closed-by-default `<details>` "Reveal result", and
 * every "watch" affordance is a plain link to another page/route, never an
 * inline player.
 */
@customElement("watch-page")
export class WatchPage extends LitElement {
  @state() private loadState: "loading" | "ready" | "error" = "loading";
  @state() private readModel: ReadModel | null = null;

  /**
   * Snapshot of the CLIENT's own clock, taken once when the read model
   * finishes loading. The live-premiere countdown/elapsed note below is
   * computed against this value, not against the server's `generatedAt`.
   * Known simplification for this pass: no server-time calibration/skew
   * correction is applied, so a badly-skewed client clock will show a
   * wrong countdown. Good enough for Stage 2; a proper fix would diff
   * against `ReadModel.generatedAt` and apply the offset.
   */
  @state() private clientNowMs = 0;

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
      const readModel = await fetchReadModel();
      this.readModel = readModel;
      this.clientNowMs = Date.now();
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader("/watch")}
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
        ${this.renderPremiereSection(readModel)}
        ${this.renderReplayArchive(readModel)}
      </div>
    `;
  }

  // -- Premiere section (live / latest / none) -----------------------------

  private renderPremiereSection(readModel: ReadModel) {
    const live = readModel.premieres.live;
    if (live !== null) {
      return this.renderLivePremiere(live);
    }
    const latest = readModel.premieres.latest;
    if (latest !== null) {
      return this.renderArchivedPremiere(latest);
    }
    return html`
      <section aria-labelledby="watch-no-premiere-heading">
        <h2 id="watch-no-premiere-heading" class="sr-only">${translateText("watch.premiere_heading")}</h2>
        <p
          class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-muted"
        >
          ${translateText("watch.no_premiere")}
        </p>
      </section>
    `;
  }

  private renderLivePremiere(live: ReadModel["premieres"]["live"] & object) {
    const scheduleNote = describeSchedule(live.scheduledAt, this.clientNowMs);
    const roundLabel =
      live.roundNumber === null
        ? "—"
        : translateText("watch.round_label", { round: live.roundNumber });
    return html`
      <section
        aria-labelledby="watch-live-heading"
        class="rounded-lg border-2 border-live/50 bg-live/10 p-5"
      >
        <span
          class="inline-block rounded-full border border-live/60 px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-live"
          >${translateText("watch.live_premiere_badge")}</span
        >
        <h2 id="watch-live-heading" class="mt-2 text-lg font-bold text-ink">
          ${live.mapLabel}
        </h2>
        <p class="mt-1 text-sm text-ink-muted">${roundLabel}</p>
        <p class="mt-1 text-sm text-ink-muted">${scheduleNote}</p>
        <a
          href="/premiere/${encodeURIComponent(live.premiereId)}"
          class="mt-3 inline-block rounded-md bg-accent px-4 py-2 text-sm font-bold text-on-accent no-underline outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("watch.watch_now")}</a
        >
      </section>
    `;
  }

  private renderArchivedPremiere(
    latest: ReadModel["premieres"]["latest"] & object,
  ) {
    const roundLabel =
      latest.roundNumber === null
        ? "—"
        : translateText("watch.round_label", { round: latest.roundNumber });
    const revealedAt = formatAbsoluteTime(latest.revealedAt);
    return html`
      <section
        aria-labelledby="watch-archived-premiere-heading"
        class="rounded-lg border border-line bg-surface-2 p-5"
      >
        <span
          class="inline-block rounded-full border border-line px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-ink-muted"
          >${translateText("watch.archived_premiere_badge")}</span
        >
        <h2
          id="watch-archived-premiere-heading"
          class="mt-2 text-lg font-bold text-ink"
        >
          ${latest.mapLabel}
        </h2>
        <p class="mt-1 text-sm text-ink-muted">${roundLabel}</p>
        <p class="mt-1 text-sm text-ink-muted">${translateText("watch.revealed_at", { time: revealedAt })}</p>
        <a
          href=${latest.href}
          class="mt-3 inline-block rounded-md border border-accent px-4 py-2 text-sm font-bold text-accent no-underline outline-none hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("watch.watch_link")}</a
        >
      </section>
    `;
  }

  // -- Full replay archive --------------------------------------------------

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
          : html`<ul class="flex flex-col gap-3" role="list">
              ${completed.map((match) =>
                this.renderMatchCard(match, readModel.agents),
              )}
            </ul>`}
      </section>
    `;
  }

  private renderMatchCard(
    match: PublicMatch & { completedAt: string },
    agents: readonly PublicAgent[],
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
          <span class="font-semibold text-ink">${match.map}</span>
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
        ${watchHref !== null
          ? html`<a
              href=${watchHref}
              class="mt-2 inline-block text-xs font-semibold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("watch.watch_replay")}</a
            >`
          : html`<span class="mt-2 inline-block text-xs text-ink-muted"
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

// -- Pure helpers (exported for unit testing) -------------------------------

/**
 * Mirrors `CoworldLeagueSiteWriter.ts`'s `.degraded`/`.degraded.elevated`
 * treatment: a recovered-turns note that only wears the warning colour
 * above `DEGRADED_WARNING_PERCENT` of `decisionCount` — below that
 * threshold it's ordinary match noise, not an alarm. Same copy as that
 * writer's `coworld_league.recovered_plain` / `coworld_league.recovered_share`
 * / `coworld_league.degraded_tip` translation keys (see `translationKeys`
 * in the delivery report — `en.json` is off-limits for this task, so these
 * are plain literals here, pending the orchestrator wiring the keys).
 */
export const DEGRADED_WARNING_PERCENT = 15;

export function computeDegradedShare(
  degradedCount: number,
  decisionCount: number | null,
): { share: number | null; elevated: boolean } {
  const share =
    decisionCount !== null && decisionCount > 0
      ? Math.round((degradedCount / decisionCount) * 100)
      : null;
  const elevated = share !== null && share >= DEGRADED_WARNING_PERCENT;
  return { share, elevated };
}

function renderDegradedNote(match: PublicMatch): TemplateResult | typeof nothing {
  const count = match.degradedCount;
  if (count === null || count <= 0) return nothing;
  const { share, elevated } = computeDegradedShare(count, match.decisionCount);
  const label =
    share === null
      ? translateText("watch.recovered_plain", { count })
      : translateText("watch.recovered_share", { count, percent: share });
  return html`<span
    class="rounded border px-1.5 py-0.5 font-mono text-[10px] font-extrabold ${elevated
      ? "border-caution/50 text-caution"
      : "border-line text-ink-muted"}"
    title=${translateText("watch.degraded_tip")}
    >${elevated ? "⚠ " : ""}${label}</span
  >`;
}

/**
 * Resolves the winner's display name for a completed match: prefer the
 * registered agent's `displayName` looked up by `winnerAgentSlug` in
 * `ReadModel.agents` (never the raw Coworld policy label), falling back to
 * the winning participant's own `displayName` (as recorded on the match)
 * when the slug doesn't resolve to a known agent — e.g. an unregistered
 * player, or an agent that has since been removed from the roster.
 */
export function resolveWinnerName(
  match: PublicMatch,
  agents: readonly PublicAgent[],
): string | null {
  if (match.winnerAgentSlug === null) return null;
  const agent = agents.find((candidate) => candidate.slug === match.winnerAgentSlug);
  if (agent !== undefined) return agent.displayName;
  const participant =
    match.participants.find(
      (candidate) => candidate.agentSlug === match.winnerAgentSlug,
    ) ?? match.participants.find((candidate) => candidate.isWinner);
  return participant?.displayName ?? null;
}

function formatAbsoluteTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return translateText("watch.unknown_time");
  return new Date(ms).toLocaleString();
}

/**
 * Countdown-or-elapsed note for a live premiere, computed purely from the
 * CLIENT's own clock (`nowMs`, a `Date.now()` snapshot) against the
 * server-supplied `scheduledAt`. Deliberately never claims the match is
 * "playing" or "in progress" — only reports the schedule relationship — so
 * the only place this page asserts liveness is the literal "Live Premiere"
 * label itself.
 */
export function describeSchedule(scheduledAtIso: string, nowMs: number): string {
  const scheduledMs = Date.parse(scheduledAtIso);
  if (Number.isNaN(scheduledMs)) return translateText("watch.schedule_unavailable");
  const diffMs = scheduledMs - nowMs;
  const duration = formatDuration(Math.abs(diffMs));
  return diffMs > 0
    ? translateText("watch.starts_in", { duration })
    : translateText("watch.started_ago", { duration });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
