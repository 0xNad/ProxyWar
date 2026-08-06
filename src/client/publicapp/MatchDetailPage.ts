import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { z } from "zod";
import { analytics } from "../analytics/AnalyticsClient";
import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  waitForTranslationsReady,
} from "./AppShellChrome";
import {
  fetchReadModel,
  PublicAgent,
  PublicFeaturedMatchSchema,
  PublicMatch,
  ReadModel,
  type PublicFeaturedMatch,
} from "./ReadModelSchema";
import {
  computeDegradedShare,
  formatDuration,
  renderDegradedNote,
} from "./WatchPage";
import {
  armReminder,
  downloadIcsFile,
  fireReminderIfDue,
  readReminderState,
  type ReminderState,
} from "./PremiereReminder";

const featuredMatchParticipantCardSchema = z.object({
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
type FeaturedMatchParticipantCard = z.infer<
  typeof featuredMatchParticipantCardSchema
>;

/**
 * `GET /api/featured-matches/:matchId`'s response shape — same "client
 * validates its own trust boundary" discipline `ReadModelSchema.ts`
 * applies to the bulk read model (see that file's doc), kept local to
 * this page since this narrow per-match route is deliberately never
 * folded into `ReadModelSchema.ts` itself (see `FeaturedMatchParticipants.ts`'s
 * doc for why participant identity stays off the bulk mirror).
 */
const featuredMatchDetailResponseSchema = z.object({
  schemaVersion: z.literal(1),
  match: PublicFeaturedMatchSchema,
  derivedPremiereId: z.string().nullable(),
  participants: z.array(featuredMatchParticipantCardSchema),
});

/**
 * `GET /api/matches/:episodeId`'s response shape (product overhaul: the
 * ordinary-league-episode sibling of the schema above) — see
 * `LeagueEpisodeMatchPage.ts`'s own doc for why every field here is
 * already public. `players` is placement-ordered (winner first); `recap`
 * is `null` whenever no real `match-story.md` artifact backs it — never a
 * placeholder.
 */
const leagueEpisodePlayerSchema = z.object({
  slot: z.number(),
  name: z.string(),
  tilesOwned: z.number(),
  isAlive: z.boolean(),
  isWinner: z.boolean(),
  color: z.string(),
  placement: z.number(),
});

/** `Season Zero Phase 2`: `GET /api/matches/:episodeId`'s `decisiveMoments` — see `AgentDecisiveMoments.ts`'s own doc for the exactly-3-to-5, never-padded selection contract. `null` when no artifact backs it (never a placeholder). */
const leagueEpisodeDecisiveMomentAgentStateSchema = z.object({
  username: z.string(),
  tilesOwned: z.number(),
  troops: z.number(),
  territoryShare: z.number(),
  rank: z.number(),
  alive: z.boolean(),
});
const leagueEpisodeDecisiveMomentStateSchema = z.object({
  turn: z.number(),
  agents: z.array(leagueEpisodeDecisiveMomentAgentStateSchema),
});
const leagueEpisodeDecisiveMomentSchema = z.object({
  turn: z.number(),
  type: z.string(),
  headline: z.string(),
  involvedAgents: z.array(z.string()),
  beforeState: leagueEpisodeDecisiveMomentStateSchema.nullable(),
  afterState: leagueEpisodeDecisiveMomentStateSchema.nullable(),
  jumpToReplayTurn: z.number(),
  statedReason: z.string().nullable(),
});

const leagueEpisodeMatchSchema = z.object({
  episodeRequestId: z.string(),
  shortId: z.string(),
  runKey: z.string().nullable(),
  roundNumber: z.number().nullable(),
  completedAt: z.string().nullable(),
  map: z.string(),
  mapSize: z.string(),
  turnCount: z.number().nullable(),
  decisionCount: z.number().nullable(),
  degradedCount: z.number().nullable(),
  winnerName: z.string().nullable(),
  players: z.array(leagueEpisodePlayerSchema),
  watchHref: z.string().nullable(),
  fullRenderHref: z.string().nullable(),
  premiereHref: z.string().nullable(),
  directorCut: z
    .object({
      durationEstimateSeconds: z.number(),
      segmentCount: z.number(),
    })
    .nullable(),
  recap: z
    .object({ summary: z.string(), beats: z.array(z.string()) })
    .nullable(),
  decisiveMoments: z.array(leagueEpisodeDecisiveMomentSchema).nullable(),
});
type LeagueEpisodeMatch = z.infer<typeof leagueEpisodeMatchSchema>;

const leagueEpisodeMatchDetailResponseSchema = z.object({
  schemaVersion: z.literal(1),
  match: leagueEpisodeMatchSchema,
  participants: z.array(featuredMatchParticipantCardSchema),
});

type LoadState = "loading" | "ready" | "not-found" | "error";

const STATE_LABEL: Record<PublicFeaturedMatch["state"], string> = {
  candidate: "match_detail.state_candidate",
  scheduled: "match_detail.state_scheduled",
  published: "match_detail.state_published",
  revealed: "match_detail.state_revealed",
  archived: "match_detail.state_archived",
  cancelled: "match_detail.state_cancelled",
};

const RECENT_FORM_LIMIT = 5;

// 2026-08-01 P0 (F8): a large FFA's registered roster produces
// n*(n-1)/2 candidate pairs (66 for a 12-player match) -- in a small,
// repeatedly-competing league most of those qualify (`headToHeadCount >
// 0`), so leaving this unbounded dumped dozens of rivalry lines into the
// storylines section. Capped and sorted by rivalry depth (most-played
// pair first) in `renderStorylines`, same magnitude as this file's own
// `RECENT_FORM_LIMIT` and `LobbyPage.ts`'s preview-list limits.
const HEAD_TO_HEAD_LIMIT = 5;

/**
 * `/match/:matchId` — the canonical public page for one `FeaturedMatch`
 * record (product overhaul spec Stage 3 item 6). Fetches BOTH the shared
 * read model (`fetchReadModel()`, for `premieres.live`) and the narrow
 * `GET /api/featured-matches/:matchId` detail route, then resolves to
 * exactly one of four outcomes, checked in this priority order:
 *
 *   1. Not found — the detail route 404s (the record is absent, or still
 *      `"candidate"` — see `FeaturedMatchParticipants.ts`'s doc for why
 *      `"candidate"` is never public). Same `renderNotFound` pattern as
 *      `AgentProfilePage`.
 *   2. Live-redirect — `derivedPremiereId` matches the read model's
 *      current `premieres.live.premiereId`: this record IS the premiere
 *      playing back RIGHT NOW. Stage 4 owns that broadcast layout, not
 *      this page — `window.location.replace(...)` to the existing
 *      `/premiere/:id` route (`replace`, not `assign`, so this URL never
 *      sits in back-history ahead of the live page a visitor actually
 *      wants). This component never renders a broadcast UI itself; the
 *      "Live Premiere" label lives entirely on that other page.
 *   3. Post-match — `match.result !== null`. The server's own embargo
 *      projection (`publicFeaturedMatch` in `ProxyWarPublicReadModel.ts`)
 *      is the ONLY thing that ever populates `result`; this page trusts
 *      it completely rather than re-deriving reveal state from `state`/
 *      `revealAt` itself. That matters concretely: an archive-lane
 *      record is revealed immediately on creation regardless of its raw
 *      `state` string (see `isFeaturedMatchRevealed`'s doc), so
 *      `result !== null` is the one correct signal here, not
 *      `state === "revealed"`.
 *   4. Pre-match — everything else (`state` is `"scheduled"` or
 *      `"published"`, not yet live, not yet revealed). A `"cancelled"`
 *      premiere-lane record also lands in this bucket by elimination —
 *      it gets its own honest notice rather than a misleading countdown.
 *
 * PLACEMENTS-CORRELATION DECISION (post-match state, see
 * `resolvePlacementAgent`): `result.placements`/`result.winnerAgentId`
 * carry identity-registry Agent ids (`FeaturedMatchResultSchema`'s own
 * doc), but the `participants` array this page also receives is already-
 * resolved `FeaturedMatchParticipantCard`s with NO `agentId` field of
 * their own (deliberately — see `FeaturedMatchParticipants.ts`'s doc), so
 * a placement can't be matched against a participant CARD directly. It
 * CAN, however, be resolved against the already-fetched bulk read
 * model's `agents` array: every `PublicAgent.id` is the SAME identity-
 * registry Agent id (`ProxyWarPublicReadModel.ts`'s `publicAgentFromView`
 * sets `id: view.agent.id` off that same registry), and `agents` is
 * exhaustive of every registered Agent regardless of standing (see
 * `publicAgents`'s own doc: "standings first, then any registered Agent
 * the live standings didn't mention"). This is a sound correlation, not
 * a bulk participant-identity leak: the general Agent roster is already
 * public on every page, independent of this match, and by the time the
 * client can see a non-null `result` the server has already decided the
 * record is revealed. A placement whose `agentId` is `null` (an
 * unregistered participant) or that doesn't resolve against `agents` (a
 * removed/never-registered id) renders an honest "unknown" label —
 * never a fabricated name.
 *
 * DIRECTOR CUT / FULL REPLAY LINK (post-match state): `match.watchHref`/
 * `.fullRenderHref` — resolved server-side against the live mirror by
 * `episodeRequestId`, the SAME way `match.completedAt` already is (see
 * `ProxyWarPublicReadModel.ts`'s `PublicFeaturedMatch.watchHref`/
 * `.fullRenderHref` doc; full-replay-access bugfix, 2026-08-05). `null`
 * whenever the episode hasn't reached the mirror yet, exactly like
 * `completedAt` — never fabricated. `renderPostMatch` renders this with
 * `renderReplayActions`, reusing `renderLeagueEpisodeActions`'s exact
 * primary/secondary CTA pattern (fullRenderHref primary, watchHref
 * secondary only when it differs).
 */
@customElement("match-detail-page")
export class MatchDetailPage extends LitElement {
  @property({ type: String, attribute: "match-id" }) matchId = "";

  @state() private loadState: LoadState = "loading";
  @state() private match: PublicFeaturedMatch | null = null;
  @state() private episodeMatch: LeagueEpisodeMatch | null = null;
  @state() private participants: FeaturedMatchParticipantCard[] = [];
  @state() private readModel: ReadModel | null = null;
  /** Drives the pre-match state's live countdown — same client-clock-only convention `LobbyPage`'s state B documents (never skew-corrected against the read model's periodic-mirror-poll `generatedAt`). */
  @state() private nowMs = Date.now();
  private tickHandle: number | null = null;

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `AgentProfilePage`/`LobbyPage`.
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    void waitForTranslationsReady().then(() => this.requestUpdate());
    this.tickHandle = window.setInterval(() => {
      this.nowMs = Date.now();
      if (
        this.match !== null &&
        this.match.result === null &&
        this.match.scheduledAt !== null &&
        fireReminderIfDue(this.matchId, this.match.scheduledAt, this.nowMs)
      ) {
        this.requestUpdate();
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

  /**
   * Resolution order (product overhaul: every mirrored league episode now
   * gets a page too, not just `FeaturedMatch` records) — dispatched purely
   * from `matchId`'s prefix, never by probing both routes: `feat_...` is
   * the `FeaturedMatch` store's own id namespace
   * (`/^feat_[a-f0-9]{20}$/`, `FeaturedMatch.ts`), `ereq_...` is Coworld's
   * own episode-request id namespace
   * (`/^ereq_[A-Za-z0-9_-]+$/`, `CoworldLeagueMirrorCore.ts`'s
   * `isSafeCoworldEpisodeRequestId`) — the two never collide (see
   * `PremiereReminder.ts`'s own doc for the same observation about this
   * exact pair of id spaces), so there is no ambiguity to resolve by
   * trying one then the other.
   */
  private async load(): Promise<void> {
    this.loadState = "loading";
    const isFeaturedMatchId = this.matchId.startsWith("feat_");
    try {
      const [readModel, response] = await Promise.all([
        fetchReadModel(),
        fetch(
          isFeaturedMatchId
            ? `/api/featured-matches/${encodeURIComponent(this.matchId)}`
            : `/api/matches/${encodeURIComponent(this.matchId)}`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            credentials: "same-origin",
            cache: "no-store",
          },
        ),
      ]);
      this.readModel = readModel;
      if (response.status === 404) {
        this.match = null;
        this.episodeMatch = null;
        this.participants = [];
        this.loadState = "not-found";
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (isFeaturedMatchId) {
        const parsed = featuredMatchDetailResponseSchema.safeParse(body);
        if (!response.ok || !parsed.success) {
          throw new Error("featured_match_detail_load_failed");
        }
        const live = readModel.premieres.live;
        if (
          live !== null &&
          parsed.data.derivedPremiereId !== null &&
          parsed.data.derivedPremiereId === live.premiereId
        ) {
          // State 2 — Live-redirect. Stage 4 owns the broadcast layout; this
          // page never renders it (see class doc). `replace`, not `assign`,
          // per that same doc.
          window.location.replace(
            `/premiere/${encodeURIComponent(live.premiereId)}`,
          );
          return;
        }
        this.match = parsed.data.match;
        this.episodeMatch = null;
        this.participants = parsed.data.participants;
        this.loadState = "ready";
        return;
      }
      // League episode — always completed+published by definition (the
      // mirror only ever lists an episode once it has a downloaded
      // replay), so there is no pre-match/live-redirect branch here.
      const parsed = leagueEpisodeMatchDetailResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("league_episode_detail_load_failed");
      }
      this.match = null;
      this.episodeMatch = parsed.data.match;
      this.participants = parsed.data.participants;
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader(
        null,
        undefined,
        this.readModel?.links.accountUrl ?? undefined,
      )}
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "not-found" ? this.renderNotFound() : nothing}
        ${this.loadState === "ready" &&
        this.match !== null &&
        this.readModel !== null
          ? this.renderMatch(this.match, this.participants, this.readModel)
          : nothing}
        ${this.loadState === "ready" &&
        this.episodeMatch !== null &&
        this.readModel !== null
          ? this.renderLeagueEpisodeMatch(
              this.episodeMatch,
              this.participants,
              this.readModel,
            )
          : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("match_detail.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("match_detail.load_error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("match_detail.try_again")}
        </button>
      </div>
    `;
  }

  private renderNotFound() {
    return html`
      <h1 class="mb-2 text-xl font-bold text-ink">
        ${translateText("match_detail.not_found_title")}
      </h1>
      <p class="mb-4 text-sm text-ink-muted">
        ${translateText("match_detail.not_found_body")}
      </p>
      <a
        href="/watch"
        class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-4 text-sm font-bold text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
      >
        ${translateText("match_detail.not_found_cta")}
      </a>
    `;
  }

  private renderMatch(
    match: PublicFeaturedMatch,
    participants: readonly FeaturedMatchParticipantCard[],
    readModel: ReadModel,
  ): TemplateResult {
    return html`
      <h1 class="mb-1 text-2xl font-bold text-ink">${match.title}</h1>
      ${match.description !== ""
        ? html`<p class="mb-2 text-sm text-ink-dim">${match.description}</p>`
        : nothing}
      <p class="mb-4 font-mono text-xs text-ink-muted">
        ${match.map} · ${match.format}
      </p>
      ${this.renderMatchBody(match, participants, readModel)}
    `;
  }

  /**
   * Three-way dispatch. `state: "revealed"/"archived"` with `result: null`
   * is a genuine, honest, bounded state — `FeaturedMatchReconcile.ts`'s own
   * doc explains why: the runtime marks a premiere revealed immediately,
   * but the outcome summary only becomes durable ~30 minutes later at
   * reclamation. Routing that combination into `renderPreMatch` would show
   * a countdown to an event that already happened; this gets its own
   * "revealed, outcome pending" rendering instead.
   */
  private renderMatchBody(
    match: PublicFeaturedMatch,
    participants: readonly FeaturedMatchParticipantCard[],
    readModel: ReadModel,
  ): TemplateResult {
    if (match.result !== null) {
      return this.renderPostMatch(match, match.result, participants, readModel);
    }
    if (match.state === "revealed" || match.state === "archived") {
      return this.renderResultPending(match, participants);
    }
    return this.renderPreMatch(match, participants);
  }

  private renderResultPending(
    match: PublicFeaturedMatch,
    participants: readonly FeaturedMatchParticipantCard[],
  ): TemplateResult {
    return html`
      <span
        class="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide text-ink-muted"
      >
        ${translateText(STATE_LABEL[match.state])}
      </span>
      <p
        class="mt-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-muted"
      >
        ${translateText("match_detail.result_pending")}
      </p>
      <section class="mt-6" aria-labelledby="match-detail-participants-heading">
        <h2
          id="match-detail-participants-heading"
          class="mb-2 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("match_detail.participants_heading")}
        </h2>
        ${this.renderParticipantCards(participants)}
      </section>
    `;
  }

  // ---- Post-match (state 3) ---------------------------------------------

  private renderPostMatch(
    match: PublicFeaturedMatch,
    result: NonNullable<PublicFeaturedMatch["result"]>,
    participants: readonly FeaturedMatchParticipantCard[],
    readModel: ReadModel,
  ): TemplateResult {
    const agents = readModel.agents;
    const winner = resolvePlacementAgent(result.winnerAgentId, agents);
    const placements = [...result.placements].sort(
      (a, b) => a.placement - b.placement,
    );
    return html`
      <span
        class="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs font-extrabold uppercase tracking-wide text-ink-muted"
      >
        ${translateText(STATE_LABEL[match.state])}
      </span>
      ${match.revealAt !== null
        ? html`<p class="mt-2 text-xs text-ink-muted">
            ${translateText("match_detail.revealed_at", {
              time: new Date(match.revealAt).toLocaleString(),
            })}
          </p>`
        : nothing}
      <div class="mt-4 rounded-lg border border-line bg-surface-2 p-4">
        <p class="text-sm font-black uppercase tracking-wide text-ink-muted">
          ${translateText("match_detail.winner_heading")}
        </p>
        <p class="mt-1 text-lg font-bold text-ink">
          ${winner === null
            ? translateText("match_detail.winner_unknown")
            : winner.href !== null
              ? html`<a
                  href=${winner.href}
                  class="text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                  >${winner.label}</a
                >`
              : winner.label}
        </p>
      </div>
      ${placements.length > 0
        ? html`
            <div class="mt-4">
              <p
                class="text-sm font-black uppercase tracking-wide text-ink-muted"
              >
                ${translateText("match_detail.placements_heading")}
              </p>
              <ol class="mt-2 flex flex-col gap-1.5" role="list">
                ${placements.map((placement) => {
                  const agent = resolvePlacementAgent(
                    placement.agentId,
                    agents,
                  );
                  return html`
                    <li
                      class="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-sm"
                    >
                      <span
                        class="w-6 shrink-0 font-mono font-black text-ink-muted"
                        >#${placement.placement}</span
                      >
                      <span class="flex-1 truncate font-semibold text-ink">
                        ${agent === null
                          ? translateText("match_detail.placement_unknown")
                          : agent.href !== null
                            ? html`<a
                                href=${agent.href}
                                class="text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                                >${agent.label}</a
                              >`
                            : agent.label}
                      </span>
                    </li>
                  `;
                })}
              </ol>
            </div>
          `
        : nothing}
      ${this.renderReplayActions(
        match.fullRenderHref,
        match.watchHref,
        match.directorCutEstimateSeconds !== null
          ? Math.round(match.directorCutEstimateSeconds / 60)
          : null,
      )}
      ${match.postMatchSummary !== null
        ? html`<p class="mt-4 text-sm text-ink-dim">
            ${match.postMatchSummary}
          </p>`
        : nothing}
      <p
        class="mt-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted"
      >
        ${translateText("match_detail.integrity_note")}
      </p>
      <section class="mt-6" aria-labelledby="match-detail-participants-heading">
        <h2
          id="match-detail-participants-heading"
          class="mb-2 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("match_detail.participants_heading")}
        </h2>
        ${this.renderParticipantCards(participants)}
      </section>
      ${this.renderMatchAnalysis(match, readModel)}
    `;
  }

  /**
   * Match-level Analysis disclosure (spec Stage 6 item 5): the deeper
   * event-composition cut this `FeaturedMatch` record itself never
   * carries (`PublicFeaturedMatchSchema` has no turnCount/decisionCount/
   * degradedCount — those live on the archive's `PublicMatch`, a
   * different record this page hasn't otherwise needed). Cross-
   * references `readModel.matches` by `matchId`: the underlying archive
   * row exists once the episode has synced into the mirror, which for a
   * REVEALED featured match is normally true but not guaranteed the
   * instant reveal lands — absent entirely (never a fabricated 0) when
   * it hasn't yet. Reuses `computeDegradedShare` from `WatchPage.ts`
   * (the SAME >= 15% elevated definition the archive cards and their
   * filters already use), never a second definition of "degraded" for
   * this page.
   */
  private renderMatchAnalysis(
    match: PublicFeaturedMatch,
    readModel: ReadModel,
  ): TemplateResult | typeof nothing {
    const archiveMatch = readModel.matches.find(
      (candidate) => candidate.matchId === match.matchId,
    );
    if (archiveMatch === undefined) return nothing;
    const rows: (TemplateResult | typeof nothing)[] = [];
    if (archiveMatch.turnCount !== null) {
      rows.push(html`
        <div class="agent-analysis-row">
          <dt>${translateText("match_detail.analysis_turn_count")}</dt>
          <dd>${archiveMatch.turnCount.toLocaleString()}</dd>
        </div>
      `);
    }
    if (archiveMatch.decisionCount !== null) {
      rows.push(html`
        <div class="agent-analysis-row">
          <dt>${translateText("match_detail.analysis_decision_count")}</dt>
          <dd>${archiveMatch.decisionCount.toLocaleString()}</dd>
        </div>
      `);
    }
    if (archiveMatch.degradedCount !== null) {
      const { share, elevated } = computeDegradedShare(
        archiveMatch.degradedCount,
        archiveMatch.decisionCount,
      );
      rows.push(html`
        <div class="agent-analysis-row">
          <dt title=${translateText("match_detail.analysis_degraded_count_tooltip")}>
            ${translateText("match_detail.analysis_degraded_count")}
          </dt>
          <dd>
            ${archiveMatch.degradedCount.toLocaleString()}
            ${share !== null
              ? html`<span class="agent-analysis-detail"
                  >${elevated ? "⚠ " : ""}${share}%</span
                >`
              : nothing}
          </dd>
        </div>
      `);
    }
    return html`
      <details class="agent-stats-section agent-analysis-tab mt-6">
        <summary>${translateText("match_detail.analysis_heading")}</summary>
        <p class="agent-analysis-updated">
          ${translateText("match_detail.analysis_last_updated", {
            date: new Date(readModel.generatedAt).toLocaleString(),
          })}
        </p>
        ${rows.length > 0
          ? html`<dl class="agent-analysis-grid">${rows}</dl>`
          : html`<p class="agent-analysis-empty">
              ${translateText("match_detail.analysis_no_composition")}
            </p>`}
      </details>
    `;
  }

  // ---- Pre-match (state 4) -----------------------------------------------

  private renderPreMatch(
    match: PublicFeaturedMatch,
    participants: readonly FeaturedMatchParticipantCard[],
  ): TemplateResult {
    if (match.state === "cancelled") {
      return html`
        <p
          class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-muted"
        >
          ${translateText("match_detail.cancelled_note")}
        </p>
      `;
    }
    const scheduled =
      match.scheduledAt !== null ? new Date(match.scheduledAt) : null;
    const scheduledValid = scheduled !== null && !Number.isNaN(scheduled.getTime());
    const countdown = scheduledValid
      ? formatDuration(Math.max(0, scheduled.getTime() - this.nowMs))
      : null;
    const reminder = readReminderState(this.matchId);
    return html`
      ${scheduledValid
        ? html`
            <p class="text-sm text-ink-muted">
              ${translateText("match_detail.scheduled_for")}
              <time datetime=${match.scheduledAt as string}
                >${scheduled.toLocaleString()}
                ${translateText("match_detail.local_time_suffix")}</time
              >
            </p>
            <p
              class="mt-1 font-mono text-lg font-black text-ink"
              role="timer"
              aria-live="polite"
            >
              ${translateText("match_detail.countdown_value", {
                duration: countdown as string,
              })}
            </p>
            <div class="mt-3 flex flex-wrap items-center gap-3">
              <a
                href="#"
                class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-4 text-sm font-bold text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
                @click=${(event: MouseEvent) => this.downloadIcs(event, match)}
                >${translateText("match_detail.add_to_calendar")}</a
              >
              ${this.renderRemindMe(reminder)}
            </div>
            ${reminder === "fired"
              ? html`<p
                  class="mt-3 rounded-md border border-live/50 bg-live/10 px-3 py-2 text-sm font-bold text-live-text"
                  role="status"
                >
                  ${translateText("match_detail.remind_me_live_cue")}
                </p>`
              : nothing}
          `
        : html`<p class="text-sm text-ink-muted">
            ${translateText("match_detail.schedule_unavailable")}
          </p>`}
      <section class="mt-6" aria-labelledby="match-detail-participants-heading">
        <h2
          id="match-detail-participants-heading"
          class="mb-2 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("match_detail.participants_heading")}
        </h2>
        ${this.renderParticipantCards(participants)}
      </section>
      ${this.renderStorylines(participants)}
    `;
  }

  /** Client-side only, no server round-trip — see `PremiereReminder.ts`'s `downloadIcsFile`. `match.title` is already the page's own public `<h1>`, so it carries no more spoiler risk here than it does rendered above. */
  private downloadIcs(event: MouseEvent, match: PublicFeaturedMatch): void {
    event.preventDefault();
    if (match.scheduledAt === null) return;
    const url = `${window.location.origin}/match/${encodeURIComponent(this.matchId)}`;
    downloadIcsFile(
      { title: match.title, scheduledAt: match.scheduledAt, url },
      `proxy-war-match-${this.matchId}`,
    );
  }

  // ---- Remind me (local, same-tab only) ----------------------------------
  //
  // PURELY client-side, no server write — see `PremiereReminder.ts`'s own
  // doc for exactly what "armed"/"fired" persistence does and doesn't
  // guarantee.

  private renderRemindMe(state: ReminderState): TemplateResult {
    if (state === "fired") {
      return html`<span class="text-sm font-semibold text-ink-muted"
        >${translateText("match_detail.remind_me_sent")}</span
      >`;
    }
    return html`
      <button
        type="button"
        title=${translateText("match_detail.remind_me_tooltip")}
        class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-4 text-sm font-bold text-ink outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
        ?disabled=${state === "armed"}
        @click=${() => {
          armReminder(this.matchId);
          this.requestUpdate();
        }}
      >
        ${state === "armed"
          ? translateText("match_detail.remind_me_armed")
          : translateText("match_detail.remind_me_button")}
      </button>
    `;
  }

  // ---- Participant cards (shared by both branches) -----------------------

  private renderParticipantCards(
    participants: readonly FeaturedMatchParticipantCard[],
  ): TemplateResult {
    if (participants.length === 0) {
      return html`<p class="text-sm text-ink-muted">
        ${translateText("match_detail.participants_pending")}
      </p>`;
    }
    return html`
      <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2" role="list">
        ${participants.map((participant) =>
          this.renderParticipantCard(participant),
        )}
      </ul>
    `;
  }

  private renderParticipantCard(
    participant: FeaturedMatchParticipantCard,
  ): TemplateResult {
    return html`
      <li
        class="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3 py-2"
      >
        ${participant.emblemSvg !== null
          ? html`<span
              class="inline-flex h-10 w-10 shrink-0 overflow-hidden"
              aria-hidden="true"
              >${unsafeSVG(participant.emblemSvg)}</span
            >`
          : html`<span
              class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line text-sm text-ink-muted"
              aria-hidden="true"
              >?</span
            >`}
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-ink">
            ${participant.agentSlug !== null
              ? html`<a
                  href="/agent/${encodeURIComponent(participant.agentSlug)}"
                  @click=${() =>
                    analytics.track("agent_profile_opened_from_match", {
                      matchId: this.matchId,
                      agentSlug: participant.agentSlug!,
                    })}
                  class="text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                  >${participant.displayName}</a
                >`
              : participant.displayName}
          </p>
          <p class="flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
            ${participant.versionLabel !== null
              ? html`<span class="font-mono">${participant.versionLabel}</span>`
              : nothing}
            ${participant.builderDisplayName !== null
              ? html`<span
                  >${translateText("match_detail.builder_label")}:
                  ${participant.builderDisplayName}</span
                >`
              : nothing}
          </p>
        </div>
      </li>
    `;
  }

  // ---- Storylines: recent form / head-to-head -----------------------------
  //
  // Pure, evidence-only computation off the already-fetched read model's
  // `matches` array — the same source `AgentProfilePage`'s own recent-
  // matches section reads, reimplemented here (not imported) because the
  // only existing recent-form/head-to-head helpers
  // (`src/client/prediction/wagering/leagueData.ts`'s `recentForm`/
  // `headToHead`) are wagering-only, keyed by a different `LeagueDataSnapshot`
  // shape fetched from a different endpoint (`/ai-league-runs/league/data.json`)
  // this page must not depend on. Skipped entirely (never a fabricated
  // "no history" claim) for a participant with no registered `agentSlug`.

  private renderStorylines(
    participants: readonly FeaturedMatchParticipantCard[],
  ): TemplateResult | typeof nothing {
    const readModel = this.readModel;
    if (readModel === null) return nothing;
    const registered = participants.filter(
      (participant): participant is FeaturedMatchParticipantCard & {
        agentSlug: string;
      } => participant.agentSlug !== null,
    );
    if (registered.length === 0) return nothing;
    // F8: sorted by rivalry depth (most-played pair first) and capped at
    // HEAD_TO_HEAD_LIMIT before rendering — see that constant's own doc for
    // why an uncapped pairwise dump is a real problem for large FFAs.
    const qualifyingMatchups = pairwise(registered)
      .map(([a, b]): [typeof a, typeof b, number] => [
        a,
        b,
        headToHeadCount(readModel.matches, a.agentSlug, b.agentSlug),
      ])
      .filter(([, , count]) => count > 0)
      .sort((x, y) => y[2] - x[2]);
    const matchups = qualifyingMatchups.slice(0, HEAD_TO_HEAD_LIMIT);
    const hiddenMatchupCount = qualifyingMatchups.length - matchups.length;
    return html`
      <section class="mt-6" aria-labelledby="match-detail-storylines-heading">
        <h2
          id="match-detail-storylines-heading"
          class="mb-2 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("match_detail.storylines_heading")}
        </h2>
        <ul class="flex flex-col gap-2" role="list">
          ${registered.map((participant) => {
            const form = recentFormForAgentSlug(
              readModel.matches,
              participant.agentSlug,
            );
            return html`
              <li class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
                <span class="font-semibold text-ink"
                  >${participant.displayName}</span
                >
                <span class="ml-2 text-ink-muted">
                  ${form.played === 0
                    ? translateText("match_detail.no_recent_form")
                    : translateText("match_detail.recent_form", {
                        wins: form.wins,
                        played: form.played,
                      })}
                </span>
              </li>
            `;
          })}
        </ul>
        ${matchups.length > 0
          ? html`
              <ul class="mt-2 flex flex-col gap-2" role="list">
                ${matchups.map(([a, b, count]) => {
                  return html`<li
                    class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-muted"
                  >
                    ${translateText("match_detail.head_to_head", {
                      a: a.displayName,
                      b: b.displayName,
                      count,
                    })}
                  </li>`;
                })}
              </ul>
              ${hiddenMatchupCount > 0
                ? html`<p class="mt-2 text-xs text-ink-muted">
                    ${translateText("match_detail.head_to_head_more", {
                      count: hiddenMatchupCount,
                    })}
                  </p>`
                : nothing}
            `
          : nothing}
        <p class="mt-2 text-[11px] italic leading-snug text-ink-muted">
          ${translateText("match_detail.storylines_note")}
        </p>
      </section>
    `;
  }

  // ---- League episode (ordinary league match) render path ---------------
  //
  // Product overhaul: every mirrored league episode now gets a canonical
  // page too, not just `FeaturedMatch` records — resolved via
  // `GET /api/matches/:episodeId` (see `load()`'s id-prefix dispatch).
  // League episodes are completed+published by definition (the mirror
  // only ever lists an episode once it has a downloaded replay), so this
  // is ALWAYS a post-match render — no pre-match/live-redirect states
  // apply here, unlike the `FeaturedMatch` branch above.

  private renderLeagueEpisodeMatch(
    match: LeagueEpisodeMatch,
    participants: readonly FeaturedMatchParticipantCard[],
    readModel: ReadModel,
  ): TemplateResult {
    return html`
      ${this.renderLeagueEpisodeHeader(match)}
      ${this.renderLeagueEpisodeResult(match, participants)}
      ${this.renderLeagueEpisodeActions(match)}
      ${this.renderLeagueEpisodeRecap(match)}
      ${this.renderLeagueEpisodeDecisiveMoments(match, participants)}
      <section
        class="mt-6"
        aria-labelledby="match-detail-participants-heading"
      >
        <h2
          id="match-detail-participants-heading"
          class="mb-2 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("match_detail.participants_heading")}
        </h2>
        ${this.renderParticipantCards(participants)}
      </section>
      ${this.renderStorylines(participants)}
      ${this.renderLeagueEpisodeTechnicalDrawer(match, readModel)}
    `;
  }

  private renderLeagueEpisodeHeader(match: LeagueEpisodeMatch): TemplateResult {
    const roundLabel =
      match.roundNumber !== null
        ? translateText("watch.round_label", { round: match.roundNumber })
        : null;
    return html`
      <h1 class="mb-1 text-2xl font-bold text-ink">
        ${match.map}${roundLabel !== null ? html` · ${roundLabel}` : nothing}
      </h1>
      <p
        class="mb-4 flex flex-wrap items-center gap-1 font-mono text-xs text-ink-muted"
      >
        <span
          >${match.completedAt !== null
            ? new Date(match.completedAt).toLocaleString()
            : translateText("watch.unknown_time")}</span
        >
        ${renderDegradedNote(match)}
      </p>
    `;
  }

  /**
   * Winner + placements, sourced directly from `match.players` (already
   * placement-ordered by the server — see `LeagueEpisodeMatchPage.ts`'s
   * `placementOrderedPlayers`) rather than the `agentId`-keyed correlation
   * the `FeaturedMatch` branch's `renderPostMatch` needs — an episode's
   * players carry their own `name`/`tilesOwned`/`isWinner` directly, so no
   * bulk-`agents`-array lookup is required. Agent profile links come from
   * zipping against `participants` by `playerName` — the SAME
   * `FeaturedMatchParticipantCard` identity resolution every other branch
   * of this page already uses.
   */
  private renderLeagueEpisodeResult(
    match: LeagueEpisodeMatch,
    participants: readonly FeaturedMatchParticipantCard[],
  ): TemplateResult {
    const cardByName = new Map(
      participants.map((participant) => [
        participant.playerName,
        participant,
      ]),
    );
    const winnerCard =
      match.winnerName === null ? null : (cardByName.get(match.winnerName) ?? null);
    const winnerSlug = winnerCard?.agentSlug ?? null;
    return html`
      <div class="mt-4 rounded-lg border border-line bg-surface-2 p-4">
        <p class="text-sm font-black uppercase tracking-wide text-ink-muted">
          ${translateText("match_detail.winner_heading")}
        </p>
        <p class="mt-1 text-lg font-bold text-ink">
          ${match.winnerName === null
            ? translateText("watch.no_winner")
            : winnerSlug !== null
              ? html`<a
                  href="/agent/${encodeURIComponent(winnerSlug)}"
                  @click=${() =>
                    analytics.track("agent_profile_opened_from_match", {
                      matchId: this.matchId,
                      agentSlug: winnerSlug,
                    })}
                  class="text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                  >${winnerCard?.displayName ?? match.winnerName}</a
                >`
              : (winnerCard?.displayName ?? match.winnerName)}
        </p>
      </div>
      <div class="mt-4">
        <p class="text-sm font-black uppercase tracking-wide text-ink-muted">
          ${translateText("match_detail.placements_heading")}
        </p>
        <ol class="mt-2 flex flex-col gap-1.5" role="list">
          ${match.players.map((player) => {
            const card = cardByName.get(player.name) ?? null;
            const displayName = card?.displayName ?? player.name;
            const agentSlug = card?.agentSlug ?? null;
            return html`
              <li
                class="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-sm"
              >
                <span
                  class="w-6 shrink-0 font-mono font-black text-ink-muted"
                  >#${player.placement}</span
                >
                <span class="flex-1 truncate font-semibold text-ink">
                  ${agentSlug !== null
                    ? html`<a
                        href="/agent/${encodeURIComponent(agentSlug)}"
                        @click=${() =>
                          analytics.track("agent_profile_opened_from_match", {
                            matchId: this.matchId,
                            agentSlug,
                          })}
                        class="text-ink no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                        >${displayName}</a
                      >`
                    : displayName}
                </span>
                ${player.isAlive
                  ? nothing
                  : html`<span
                      class="shrink-0 font-mono text-xs text-ink-muted"
                      >${translateText("coworld_league.eliminated")}</span
                    >`}
              </li>
            `;
          })}
        </ol>
      </div>
      <p
        class="mt-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted"
      >
        ${translateText("match_detail.integrity_note")}
      </p>
    `;
  }

  /**
   * Primary action: Director Cut (when a Director Cut runtime is known
   * for this run) or plain Full Replay, both pointing at `fullRenderHref`
   * — Director Cut is a PLAYBACK MODE inside that same real-client
   * renderer (`AiLeagueReplayOverlay.ts`'s `mountDirectorCutController`,
   * enabled by default for archived matches), never a separate URL.
   * Secondary action: the lightweight `watchHref` spectator page, shown
   * only when it's a genuinely different link (a fixture/test row can
   * point both hrefs at the same URL). Shared by `renderLeagueEpisodeActions`
   * (`LeagueEpisodeMatch`, `ereq_...`) and `renderPostMatch` (`FeaturedMatch`,
   * `feat_...`) — full-replay-access bugfix (2026-08-05) — so both id
   * namespaces render the identical primary/secondary CTA rather than a
   * second near-duplicate template.
   */
  private renderReplayActions(
    fullRenderHref: string | null,
    watchHref: string | null,
    directorCutMinutes: number | null,
  ): TemplateResult {
    const primaryHref = fullRenderHref;
    const primaryLabel =
      directorCutMinutes !== null
        ? translateText("watch.director_cut_duration", {
            minutes: Math.max(1, directorCutMinutes),
          })
        : translateText("watch.watch_replay");
    const secondaryHref =
      watchHref !== null && watchHref !== primaryHref ? watchHref : null;
    return html`
      <div class="mt-6 flex flex-wrap items-center gap-3">
        ${primaryHref !== null
          ? html`<a
              href=${primaryHref}
              class="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-bold text-surface no-underline outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent"
              >${primaryLabel}</a
            >`
          : html`<span class="text-sm text-ink-muted"
              >${translateText("watch.replay_pending")}</span
            >`}
        ${secondaryHref !== null
          ? html`<a
              href=${secondaryHref}
              class="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface-2 px-4 text-sm font-bold text-ink no-underline outline-none hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("match_detail.quick_replay_link")}</a
            >`
          : nothing}
      </div>
    `;
  }

  private renderLeagueEpisodeActions(match: LeagueEpisodeMatch): TemplateResult {
    return this.renderReplayActions(
      match.fullRenderHref,
      match.watchHref,
      match.directorCut !== null
        ? Math.round(match.directorCut.durationEstimateSeconds / 60)
        : null,
    );
  }

  /**
   * Conditional recap section (product overhaul spec: "a recap SECTION
   * ONLY when real artifacts support it"). `match.recap` is already
   * `null` unless a real `match-recap.json` backs it — see
   * `LeagueEpisodeMatchPage.ts`'s `readLeagueEpisodeRecap` — so no
   * additional "is this worth showing" check is needed here; absence IS
   * the honest signal, never a placeholder.
   */
  private renderLeagueEpisodeRecap(
    match: LeagueEpisodeMatch,
  ): TemplateResult | typeof nothing {
    if (match.recap === null) return nothing;
    const recap = match.recap;
    return html`
      <section class="mt-6" aria-labelledby="match-detail-recap-heading">
        <h2
          id="match-detail-recap-heading"
          class="mb-2 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("match_detail.episode_recap_heading")}
        </h2>
        ${recap.summary.length > 0
          ? html`<p class="text-sm text-ink-dim">${recap.summary}</p>`
          : nothing}
        ${recap.beats.length > 0
          ? html`<ul class="mt-2 flex flex-col gap-1.5" role="list">
              ${recap.beats.map(
                (beat) => html`<li
                  class="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink-dim"
                >
                  ${beat}
                </li>`,
              )}
            </ul>`
          : nothing}
      </section>
    `;
  }

  /**
   * Conditional "Decisive moments" section (Season Zero Phase 2 spec:
   * "Every featured post-match page should present exactly three to five
   * decisive moments where supported"). `match.decisiveMoments` is
   * already `null` unless a real `decisive-moments.json` backs it — see
   * `LeagueEpisodeMatchPage.ts`'s `readLeagueEpisodeDecisiveMoments` — so
   * absence here IS the honest signal, never a placeholder, same
   * convention `renderLeagueEpisodeRecap` follows. Each card's jump link
   * appends `?turn=N` to `fullRenderHref`, the SAME query param
   * `Main.ts`'s cold-load fast-forward and `AiLeagueReplayOverlay.ts`'s
   * own in-app jump already read — no new mechanism. `statedReason` is
   * always rendered under its own explicitly-labeled "stated by the
   * agent" row, never merged into the headline, per the spec's
   * stated-not-verified requirement.
   */
  private renderLeagueEpisodeDecisiveMoments(
    match: LeagueEpisodeMatch,
    participants: readonly FeaturedMatchParticipantCard[],
  ): TemplateResult | typeof nothing {
    if (match.decisiveMoments === null) return nothing;
    const moments = match.decisiveMoments;
    const cardByName = new Map(
      participants.map((participant) => [participant.playerName, participant]),
    );
    const jumpHref = (turn: number): string | null => {
      if (match.fullRenderHref === null) return null;
      const url = new URL(match.fullRenderHref, window.location.origin);
      url.searchParams.set("turn", String(turn));
      return `${url.pathname}${url.search}`;
    };
    return html`
      <section
        class="mt-6"
        aria-labelledby="match-detail-decisive-moments-heading"
      >
        <h2
          id="match-detail-decisive-moments-heading"
          class="mb-2 text-sm font-black uppercase tracking-wide text-ink-muted"
        >
          ${translateText("match_detail.decisive_moments_heading")}
        </h2>
        <ul class="mt-2 flex flex-col gap-2" role="list">
          ${moments.map((moment) => {
            const href = jumpHref(moment.jumpToReplayTurn);
            return html`
              <li
                class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="rounded-full border border-line px-2 py-0.5 font-mono text-xs uppercase tracking-wide text-ink-muted"
                    >${translateText(
                      `match_detail.decisive_moment_type_${moment.type}`,
                    )}</span
                  >
                  <span class="font-mono text-xs text-ink-muted"
                    >${translateText("match_detail.decisive_moment_turn", {
                      turn: moment.jumpToReplayTurn,
                    })}</span
                  >
                </div>
                <p class="mt-1 text-ink-dim">${moment.headline}</p>
                <p class="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                  ${moment.involvedAgents.map((name) => {
                    const card = cardByName.get(name) ?? null;
                    const slug = card?.agentSlug ?? null;
                    const displayName = card?.displayName ?? name;
                    return slug !== null
                      ? html`<a
                          href="/agent/${encodeURIComponent(slug)}"
                          @click=${() =>
                            analytics.track("agent_profile_opened_from_match", {
                              matchId: this.matchId,
                              agentSlug: slug,
                            })}
                          class="text-ink-muted no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                          >${displayName}</a
                        >`
                      : html`<span>${displayName}</span>`;
                  })}
                </p>
                ${moment.statedReason !== null
                  ? html`<p class="mt-1 text-xs italic text-ink-muted">
                      ${translateText(
                        "match_detail.decisive_moment_stated_reason_label",
                      )}: “${moment.statedReason}”
                    </p>`
                  : nothing}
                ${href !== null
                  ? html`<a
                      href=${href}
                      @click=${() =>
                        analytics.track("decisive_moment_opened", {
                          matchId: this.matchId,
                        })}
                      class="mt-1.5 inline-flex min-h-8 items-center text-xs font-bold text-accent no-underline outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent"
                      >${translateText(
                        "match_detail.decisive_moment_jump_link",
                      )}</a
                    >`
                  : nothing}
              </li>
            `;
          })}
        </ul>
      </section>
    `;
  }

  /**
   * Technical/integrity drawer — same `<details class="agent-stats-section
   * agent-analysis-tab">` disclosure pattern `renderMatchAnalysis` already
   * establishes on the `FeaturedMatch` branch (episodeRequestId/run key/
   * raw participant labels/provenance instead of turn/decision counts
   * alone, since an episode page has no separate archive row to cross-
   * reference — every field is already on `match` itself).
   */
  private renderLeagueEpisodeTechnicalDrawer(
    match: LeagueEpisodeMatch,
    readModel: ReadModel,
  ): TemplateResult {
    const rows: (TemplateResult | typeof nothing)[] = [];
    if (match.turnCount !== null) {
      rows.push(html`
        <div class="agent-analysis-row">
          <dt>${translateText("match_detail.analysis_turn_count")}</dt>
          <dd>${match.turnCount.toLocaleString()}</dd>
        </div>
      `);
    }
    if (match.decisionCount !== null) {
      rows.push(html`
        <div class="agent-analysis-row">
          <dt>${translateText("match_detail.analysis_decision_count")}</dt>
          <dd>${match.decisionCount.toLocaleString()}</dd>
        </div>
      `);
    }
    if (match.degradedCount !== null) {
      const { share, elevated } = computeDegradedShare(
        match.degradedCount,
        match.decisionCount,
      );
      rows.push(html`
        <div class="agent-analysis-row">
          <dt title=${translateText("match_detail.analysis_degraded_count_tooltip")}>
            ${translateText("match_detail.analysis_degraded_count")}
          </dt>
          <dd>
            ${match.degradedCount.toLocaleString()}
            ${share !== null
              ? html`<span class="agent-analysis-detail"
                  >${elevated ? "⚠ " : ""}${share}%</span
                >`
              : nothing}
          </dd>
        </div>
      `);
    }
    rows.push(html`
      <div class="agent-analysis-row">
        <dt>${translateText("match_detail.episode_episode_id_label")}</dt>
        <dd class="font-mono">${match.episodeRequestId}</dd>
      </div>
    `);
    rows.push(html`
      <div class="agent-analysis-row">
        <dt>${translateText("match_detail.episode_run_key_label")}</dt>
        <dd class="font-mono">
          ${match.runKey ??
          translateText("match_detail.episode_run_key_unavailable")}
        </dd>
      </div>
    `);
    rows.push(html`
      <div class="agent-analysis-row">
        <dt>${translateText("match_detail.episode_raw_labels_label")}</dt>
        <dd>${match.players.map((player) => player.name).join(", ")}</dd>
      </div>
    `);
    return html`
      <details class="agent-stats-section agent-analysis-tab mt-6">
        <summary>
          ${translateText("match_detail.episode_technical_heading")}
        </summary>
        <p class="agent-analysis-updated">
          ${translateText("match_detail.analysis_last_updated", {
            date: new Date(readModel.generatedAt).toLocaleString(),
          })}
        </p>
        <dl class="agent-analysis-grid">${rows}</dl>
        <p class="mt-2 text-[11px] italic leading-snug text-ink-muted">
          ${translateText("match_detail.episode_provenance_note")}
        </p>
      </details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "match-detail-page": MatchDetailPage;
  }
}

// ---- Pure helpers ----------------------------------------------------------

interface ResolvedPlacementAgent {
  label: string;
  href: string | null;
}

/** See the class doc's "PLACEMENTS-CORRELATION DECISION" for why this lookup against the bulk read model's `agents` array is sound. Returns `null` — never a fabricated name — for a `null` `agentId` or one that doesn't resolve against the current roster. */
function resolvePlacementAgent(
  agentId: string | null,
  agents: readonly PublicAgent[],
): ResolvedPlacementAgent | null {
  if (agentId === null) return null;
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined) return null;
  return {
    label: agent.displayName,
    href:
      agent.slug !== null ? `/agent/${encodeURIComponent(agent.slug)}` : null,
  };
}

/** Wins/played across this agent's most recent `RECENT_FORM_LIMIT` matches (most recent `completedAt` first, a `null` `completedAt` sorting last) — pure evidence off the read model, no rank/score computation of its own. */
function recentFormForAgentSlug(
  matches: readonly PublicMatch[],
  agentSlug: string,
): { wins: number; played: number } {
  const recent = matches
    .filter((match) =>
      match.participants.some((p) => p.agentSlug === agentSlug),
    )
    .sort((a, b) => {
      const at = a.completedAt === null ? -Infinity : Date.parse(a.completedAt);
      const bt = b.completedAt === null ? -Infinity : Date.parse(b.completedAt);
      return bt - at;
    })
    .slice(0, RECENT_FORM_LIMIT);
  return {
    wins: recent.filter((match) => match.winnerAgentSlug === agentSlug).length,
    played: recent.length,
  };
}

/** Count of past completed matches where BOTH agent slugs appear as participants — the read model's own evidence for "these two have met before", nothing inferred. */
function headToHeadCount(
  matches: readonly PublicMatch[],
  slugA: string,
  slugB: string,
): number {
  return matches.filter(
    (match) =>
      match.participants.some((p) => p.agentSlug === slugA) &&
      match.participants.some((p) => p.agentSlug === slugB),
  ).length;
}

/** Every unique unordered pair from `items`, i<j order preserved. */
function pairwise<T>(items: readonly T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push([items[i], items[j]]);
    }
  }
  return pairs;
}
