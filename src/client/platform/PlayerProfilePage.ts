import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { z } from "zod";
import { PublicAgentStatsSchema } from "../AgentStatsSchema";
import { renderAgentStatsSections } from "../AgentStatsSections";

const standingSchema = z.object({
  rank: z.number(),
  ratingPolicyLabel: z.string().nullable(),
  activeChampionPolicyLabel: z.string().nullable(),
  score: z.number().nullable(),
  roundsPlayed: z.number().nullable(),
  isHouse: z.boolean(),
});

const episodeSchema = z.object({
  roundNumber: z.number().nullable(),
  completedAt: z.string().nullable(),
  map: z.string().nullable(),
  turnCount: z.number().nullable(),
  tilesOwned: z.number().nullable(),
  isAlive: z.boolean(),
  isWinner: z.boolean(),
  watchHref: z.string().nullable(),
  fullRenderHref: z.string().nullable(),
});

const leagueSectionSchema = z.object({
  generatedAt: z.string().nullable(),
  lastGoodSyncAt: z.string().nullable(),
  stale: z.boolean(),
  standing: standingSchema.nullable(),
  policyLineageNote: z.string().nullable(),
  episodes: z.array(episodeSchema),
  recentRecord: z.object({ wins: z.number(), played: z.number() }).nullable(),
  /**
   * Product overhaul spec Stage 6: the SAME `PublicAgentStatsSchema`
   * `/agent/:slug` validates against — "one computation source, two
   * views" holds at the schema level too, not just the server's shared
   * artifact.
   */
  stats: PublicAgentStatsSchema.nullable(),
});

const profileResponseSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  league: leagueSectionSchema.nullable(),
});

type ProfileResponse = z.infer<typeof profileResponseSchema>;
type LeagueSection = z.infer<typeof leagueSectionSchema>;
type Episode = z.infer<typeof episodeSchema>;

type LoadState = "loading" | "ready" | "not-found" | "error";

/**
 * The league player profile — the destination the PUBLIC league
 * standings link to (`playerProfileUrl` in `playerProfileLink.ts`, `GET
 * /api/players/:name` here). Lives on the platform origin: this is a
 * platform-level feature now that accounts are platform-level, not a
 * betting one.
 *
 * League-only, deliberately: a league player and a platform account are
 * only the same person by a claim nobody here can verify, and a
 * bettor's display name isn't even unique among linked accounts — see
 * `/api/players/:name`'s doc comment in `ai-agent-demo-server.ts`. A
 * bettor's own stats live at their own stable, account-id-keyed page
 * instead — see `TraderProfilePage.ts`.
 *
 * PUBLIC PAGE. Renders only what `/api/players/:name` returns, and that
 * route is itself constructed to never touch the private league-claim
 * store. This component adds no additional data of its own, so that
 * guarantee holds all the way to the screen.
 *
 * Standalone route (`/player/:name`, see `Main.ts`'s `handleUrl`), not
 * mounted inside the game engine/replay viewer — same pattern as
 * `premiere-account-page`.
 */
@customElement("player-profile-page")
export class PlayerProfilePage extends LitElement {
  @property({ type: String }) name = "";

  @state() private loadState: LoadState = "loading";
  @state() private profile: ProfileResponse | null = null;

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `PremiereAccountPage`.
    this.classList.add("block", "w-full", "grow");
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loadState = "loading";
    try {
      const response = await fetch(
        `/api/players/${encodeURIComponent(this.name)}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        },
      );
      if (response.status === 404) {
        this.loadState = "not-found";
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const parsed = profileResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("player_profile_load_failed");
      }
      this.profile = parsed.data;
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  render() {
    return html`
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "not-found" ? this.renderNotFound() : nothing}
        ${this.loadState === "ready" && this.profile !== null
          ? this.renderProfile(this.profile)
          : nothing}
      </main>
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      Loading player…
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        Could not load this player.
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          Try again
        </button>
      </div>
    `;
  }

  private renderNotFound() {
    return html`
      <h1 class="mb-2 text-xl font-bold text-ink">${this.name}</h1>
      <p class="text-sm text-ink-muted">
        We don't have any league standings for this name yet.
      </p>
    `;
  }

  private renderProfile(profile: ProfileResponse) {
    const isHouse = profile.league?.standing?.isHouse ?? false;
    return html`
      <header class="mb-5 flex flex-wrap items-center gap-2">
        <h1 class="text-xl font-bold text-ink" id="player-profile-heading">
          ${profile.name}
        </h1>
        ${isHouse
          ? html`<span
              class="rounded-full border border-caution/40 bg-caution/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-caution"
              title="A house-run exhibition seat, not an independent competitor."
              >House</span
            >`
          : nothing}
      </header>
      <div class="flex flex-col gap-6">
        ${profile.league !== null
          ? this.renderLeagueSection(profile.league)
          : nothing}
        ${profile.league === null
          ? html`<p class="text-sm text-ink-muted">
              No league data available for this name.
            </p>`
          : nothing}
      </div>
    `;
  }

  private renderStaleness(league: LeagueSection) {
    if (!league.stale) return nothing;
    const asOf =
      league.lastGoodSyncAt !== null
        ? new Date(league.lastGoodSyncAt).toLocaleString()
        : "an unknown time";
    return html`
      <p
        class="mb-2 rounded-md border border-caution/40 bg-caution/10 px-2 py-1 text-[11px] font-semibold text-caution"
        role="status"
      >
        League data is stale — last confirmed ${asOf}. Standing and results
        below may be dated.
      </p>
    `;
  }

  private renderLeagueSection(league: LeagueSection) {
    const standing = league.standing;
    return html`
      <section aria-labelledby="player-profile-league-heading">
        <h2
          id="player-profile-league-heading"
          class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted"
        >
          League
        </h2>
        ${this.renderStaleness(league)}
        ${standing === null
          ? html`<p class="mb-3 text-sm text-ink-muted">
              Not currently in the ranked standings.
            </p>`
          : html`
              <dl class="mb-3 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt class="text-[11px] uppercase text-ink-muted">Rank</dt>
                  <dd class="font-mono font-semibold text-ink">
                    #${standing.rank}
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase text-ink-muted">Rating</dt>
                  <dd class="font-mono font-semibold text-ink">
                    ${standing.score === null ? "—" : standing.score.toFixed(2)}
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase text-ink-muted">
                    Rated rounds
                  </dt>
                  <dd class="font-mono font-semibold text-ink">
                    ${standing.roundsPlayed ?? "—"}
                  </dd>
                </div>
              </dl>
            `}
        ${league.policyLineageNote !== null
          ? html`<p
              class="mb-3 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-muted"
            >
              ${league.policyLineageNote}
            </p>`
          : nothing}
        ${renderAgentStatsSections(league.stats)}
        ${this.renderRecentResults(league)}
      </section>
    `;
  }

  private renderRecentResults(league: LeagueSection) {
    if (league.episodes.length === 0) {
      return html`<p class="text-sm text-ink-muted">
        No completed rounds in the retained history yet.
      </p>`;
    }
    const record = league.recentRecord;
    return html`
      <div class="mb-2 flex items-baseline justify-between gap-2">
        <h3 class="text-xs font-bold uppercase tracking-wide text-ink-muted">
          Recent results
        </h3>
        ${record !== null
          ? html`<span class="text-xs text-ink-muted"
              >${record.wins}/${record.played} won</span
            >`
          : nothing}
      </div>
      <p class="mb-2 text-[11px] text-ink-muted">
        Only the last ${league.episodes.length} rounds are retained — this is a
        recent window, not a full career record.
      </p>
      <ul class="flex flex-col gap-1.5" role="list">
        ${league.episodes.map((episode) => this.renderEpisodeRow(episode))}
      </ul>
    `;
  }

  private renderEpisodeRow(episode: Episode) {
    // Match outcome is deliberately NOT green/red. Those are reserved for
    // P&L across this codebase, and a linked account's profile shows betting
    // P&L on this very page — so colouring wins green here would make the
    // same two colours mean two different things a few hundred pixels apart.
    // The scouting panel made the same call for the same reason: weight and
    // wording carry the outcome, colour carries money.
    const outcome = episode.isWinner
      ? { label: "Won", cls: "font-semibold text-ink" }
      : episode.isAlive
        ? { label: "Survived", cls: "text-ink-muted" }
        : { label: "Eliminated", cls: "text-ink-muted" };
    const when =
      episode.completedAt !== null
        ? new Date(episode.completedAt).toLocaleDateString()
        : "—";
    const href = episode.fullRenderHref ?? episode.watchHref;
    return html`
      <li
        class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs"
      >
        <span class="font-mono text-ink-muted"
          >${episode.roundNumber === null
            ? "—"
            : `Round ${episode.roundNumber}`}</span
        >
        <span class="text-ink-muted">${episode.map ?? "Unknown map"}</span>
        <span class="text-ink-muted">${when}</span>
        <span class="font-semibold ${outcome.cls}">${outcome.label}</span>
        ${episode.tilesOwned !== null
          ? html`<span class="font-mono text-ink-muted"
              >${episode.tilesOwned.toLocaleString()} tiles</span
            >`
          : nothing}
        ${href !== null
          ? html`<a
              href=${href}
              class="ml-auto font-semibold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
              >Watch →</a
            >`
          : nothing}
      </li>
    `;
  }
}
