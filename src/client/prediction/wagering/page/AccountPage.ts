import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { z } from "zod";
import "../components/GithubSignIn";
import { formatSignedCredits } from "../components/pnlDisplay";
import {
  fetchLeagueData,
  recentForm,
  type FormEntry,
  type LeagueDataSnapshot,
  type LeagueEpisodeRow,
  type LeagueStandingRow,
} from "../leagueData";

const MAX_CLAIM_PLAYER_NAME_LENGTH = 80;
const DISMISS_STORAGE_KEY = "pw-account-league-claim-dismissed";

const accountIdentitySchema = z.object({
  participantId: z.string(),
  displayName: z.string().nullable(),
  githubLogin: z.string().nullable(),
  githubAvatarUrl: z.string().nullable(),
});

const accountMatchSchema = z.object({
  premiereId: z.string(),
  net: z.number(),
  revealedAt: z.string().nullable(),
});

const accountCurrentPremiereSchema = z.object({
  premiereId: z.string(),
  status: z.enum(["open", "settled"]),
  balance: z.number().nullable(),
  positionCount: z.number(),
  unrealizedPnl: z.number(),
});

const accountBettingSchema = z.object({
  lifetimePoints: z.number(),
  premieresTraded: z.number(),
  premieresWon: z.number(),
  rank: z.number().nullable(),
  totalRankedParticipants: z.number(),
  matches: z.array(accountMatchSchema),
  currentPremiere: accountCurrentPremiereSchema.nullable(),
});

const accountClaimSchema = z.object({
  playerName: z.string(),
  claimedAt: z.string(),
  updatedAt: z.string(),
});

const accountResponseSchema = z.object({
  schemaVersion: z.literal(1),
  csrfToken: z.string(),
  identity: accountIdentitySchema,
  betting: accountBettingSchema,
  league: z.object({ claim: accountClaimSchema.nullable() }),
});

const claimResponseSchema = z.object({
  schemaVersion: z.literal(1),
  claim: accountClaimSchema.nullable(),
});

type AccountResponse = z.infer<typeof accountResponseSchema>;
type AccountMatch = z.infer<typeof accountMatchSchema>;

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, "1");
  } catch {
    // Best-effort — a private-browsing context that refuses localStorage
    // just re-shows the prompt next load, which is a mild nag at worst.
  }
}

/**
 * One place a participant sees everything the system knows about them,
 * both as a bettor (real, earned — from `ReplayPremierePointsLedger`) and,
 * if they've made one, as a self-asserted league-agent owner (a claim,
 * never verified — see the League section's own copy). Standalone route
 * (`/account`, see `Main.ts`'s `handleUrl`), NOT mounted inside the game
 * engine/replay viewer: this page has no premiere to render behind it.
 *
 * Works signed out: `/api/premieres/account` mints/reuses the same signed
 * guest cookie every other premiere surface uses (never a second
 * identity), so a first-time visitor sees a coherent empty state rather
 * than an error.
 */
@customElement("premiere-account-page")
export class PremiereAccountPage extends LitElement {
  @state() private loading = true;
  @state() private loadError = false;
  @state() private account: AccountResponse | null = null;
  @state() private leagueData: LeagueDataSnapshot | null = null;
  @state() private leagueDataLoaded = false;
  @state() private claimDismissed = readDismissed();
  @state() private editingClaim = false;
  @state() private claimDraft = "";
  @state() private savingClaim = false;
  @state() private claimError: string | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadAccount();
    fetchLeagueData().then((data) => {
      this.leagueData = data;
      this.leagueDataLoaded = true;
    });
  }

  private async loadAccount(): Promise<void> {
    this.loading = true;
    this.loadError = false;
    try {
      const response = await fetch("/api/premieres/account", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 404) {
        // Wagering isn't enabled on this deployment — a coherent, honest
        // "not here" state, distinct from a real load failure.
        this.account = null;
        this.loadError = false;
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const parsed = accountResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("account_load_failed");
      }
      this.account = parsed.data;
      this.claimDraft = parsed.data.league.claim?.playerName ?? "";
    } catch {
      this.account = null;
      this.loadError = true;
    } finally {
      this.loading = false;
    }
  }

  private async submitClaim(playerName: string): Promise<void> {
    const account = this.account;
    if (account === null || this.savingClaim) return;
    this.savingClaim = true;
    this.claimError = null;
    try {
      const response = await fetch("/api/premieres/account/league-claim", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-csrf-token": account.csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ playerName }),
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = claimResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("claim_save_failed");
      }
      this.editingClaim = false;
      // Re-fetch: cheapest correct way to pick up a fresh CSRF token and
      // reflect exactly what the server stored.
      await this.loadAccount();
    } catch {
      this.claimError = "Could not save your claim. Try again.";
    } finally {
      this.savingClaim = false;
    }
  }

  private dismissClaimPrompt(): void {
    this.claimDismissed = true;
    persistDismissed();
  }

  render() {
    return html`
      <div class="min-h-screen bg-surface text-ink">
        <div class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
          <header class="flex items-center justify-between gap-3">
            <a
              href="/"
              class="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden="true">‹</span> Proxy War
            </a>
            <h1 class="text-lg font-bold text-ink">Your account</h1>
          </header>
          ${this.renderBody()}
        </div>
      </div>
    `;
  }

  private renderBody() {
    if (this.loading) {
      return html`<div
        class="flex items-center justify-center rounded-lg border border-line bg-surface-2 px-4 py-10 text-sm text-ink-muted"
        role="status"
      >
        Loading your account…
      </div>`;
    }
    if (this.loadError) {
      return html`<div
        class="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
        role="alert"
      >
        Could not load your account. Try reloading the page.
      </div>`;
    }
    if (this.account === null) {
      return html`<div
        class="rounded-lg border border-line bg-surface-2 px-4 py-6 text-sm text-ink-muted"
      >
        Betting isn't live on this deployment right now, so there's nothing
        account-shaped to show yet.
      </div>`;
    }
    return html`
      ${this.renderIdentity()} ${this.renderBetting()} ${this.renderLeague()}
    `;
  }

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------

  private renderIdentity() {
    const identity = this.account!.identity;
    const label = identity.githubLogin ?? identity.displayName ?? `Guest ${identity.participantId.slice(-4)}`;
    return html`
      <section
        aria-labelledby="account-identity-heading"
        class="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
      >
        <h2
          id="account-identity-heading"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          Identity
        </h2>
        <div class="flex items-center gap-3">
          ${identity.githubAvatarUrl !== null
            ? html`<img
                src=${identity.githubAvatarUrl}
                alt=""
                class="h-10 w-10 shrink-0 rounded-full"
              />`
            : html`<span
                aria-hidden="true"
                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-bold text-ink-muted"
                >${label.slice(0, 1).toUpperCase()}</span
              >`}
          <div class="flex min-w-0 flex-col">
            <span class="truncate text-base font-bold text-ink">${label}</span>
            <span class="text-xs text-ink-muted">
              ${identity.githubLogin !== null
                ? "Verified via GitHub — this identity now follows your GitHub account, not just this browser."
                : "A guest identity tied to this browser (a signed cookie) — clearing cookies or switching browsers starts a new one, with no history."}
            </span>
          </div>
        </div>
        ${identity.githubLogin === null
          ? html`<div
              class="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-ink-muted"
            >
              <span>Linking GitHub carries your points and history to any browser you sign into.</span>
              <premiere-github-sign-in></premiere-github-sign-in>
            </div>`
          : nothing}
      </section>
    `;
  }

  // ---------------------------------------------------------------------
  // Betting
  // ---------------------------------------------------------------------

  private renderBetting() {
    const betting = this.account!.betting;
    if (betting.premieresTraded === 0) {
      return html`
        <section
          aria-labelledby="account-betting-heading"
          class="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
        >
          <h2
            id="account-betting-heading"
            class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
          >
            Betting
          </h2>
          <p class="text-sm text-ink-muted">
            You haven't placed a trade yet. Your starting bankroll doesn't earn
            anything by itself — only real trades, won or lost, count toward
            your rank.
          </p>
          <a
            href="/bet"
            class="inline-flex w-fit items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >
            Go to the live market →
          </a>
        </section>
      `;
    }
    const positive = betting.lifetimePoints >= 0;
    return html`
      <section
        aria-labelledby="account-betting-heading"
        class="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 p-4"
      >
        <h2
          id="account-betting-heading"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          Betting
        </h2>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="flex flex-col gap-0.5">
            <span class="text-[11px] uppercase tracking-wide text-ink-muted"
              >Lifetime net</span
            >
            <span
              class="font-mono text-lg font-bold tabular-nums ${positive
                ? "text-positive"
                : "text-danger"}"
              >${formatSignedCredits(betting.lifetimePoints)}</span
            >
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-[11px] uppercase tracking-wide text-ink-muted"
              >Matches traded</span
            >
            <span class="font-mono text-lg font-bold tabular-nums text-ink"
              >${betting.premieresTraded}</span
            >
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-[11px] uppercase tracking-wide text-ink-muted"
              >Matches won</span
            >
            <span class="font-mono text-lg font-bold tabular-nums text-ink"
              >${betting.premieresWon}</span
            >
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-[11px] uppercase tracking-wide text-ink-muted"
              >Leaderboard rank</span
            >
            <span class="font-mono text-lg font-bold tabular-nums text-ink"
              >${betting.rank === null
                ? "—"
                : `#${betting.rank} of ${betting.totalRankedParticipants}`}</span
            >
          </div>
        </div>
        <p class="text-[11px] leading-snug text-ink-muted">
          Rank is net realized profit or loss across settled matches only —
          sitting on your starting bankroll without trading earns nothing;
          being profitable is what moves you up, not being present.
        </p>
        ${this.renderCurrentPremiere(betting.currentPremiere)}
        ${this.renderMatchHistory(betting.matches)}
      </section>
    `;
  }

  private renderCurrentPremiere(
    currentPremiere: AccountResponse["betting"]["currentPremiere"],
  ) {
    if (currentPremiere === null) return nothing;
    const positive = currentPremiere.unrealizedPnl >= 0;
    return html`
      <div
        class="flex flex-col gap-2 rounded-md border border-line-strong bg-surface-3 px-3 py-2.5"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
            >Live position — current match</span
          >
          <a
            href="/bet/${currentPremiere.premiereId}"
            class="text-xs font-bold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            >Go to the live market →</a
          >
        </div>
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span class="text-ink-muted"
            >Bankroll
            <span class="font-mono font-semibold text-ink"
              >${currentPremiere.balance === null
                ? "—"
                : `${currentPremiere.balance.toLocaleString()} cr`}</span
            ></span
          >
          <span class="text-ink-muted"
            >Open positions
            <span class="font-mono font-semibold text-ink"
              >${currentPremiere.positionCount}</span
            ></span
          >
          <span class="text-ink-muted"
            >Unrealized
            <span
              class="font-mono font-semibold ${positive
                ? "text-positive"
                : "text-danger"}"
              >${formatSignedCredits(currentPremiere.unrealizedPnl)} cr</span
            ></span
          >
        </div>
      </div>
    `;
  }

  private renderMatchHistory(matches: readonly AccountMatch[]) {
    if (matches.length === 0) return nothing;
    const hasBackfilled = matches.some((match) => match.net === 0);
    return html`
      <div class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Match history
        </h3>
        <ul class="flex max-h-96 flex-col gap-1 overflow-y-auto pr-1">
          ${matches.map((match) => this.renderMatchRow(match))}
        </ul>
        ${hasBackfilled
          ? html`<p class="text-[11px] leading-snug text-ink-muted">
              † A flat 0 may be a real push, or a match settled before
              per-match history existed — older records can't tell the two
              apart.
            </p>`
          : nothing}
      </div>
    `;
  }

  private renderMatchRow(match: AccountMatch) {
    const positive = match.net > 0;
    const flat = match.net === 0;
    const dateLabel =
      match.revealedAt !== null
        ? new Date(match.revealedAt).toLocaleDateString()
        : "date unknown";
    return html`
      <li
        class="flex items-center justify-between gap-3 rounded-md bg-surface-3 px-2.5 py-1.5 text-sm"
      >
        <span class="text-ink-muted">${dateLabel}</span>
        <span class="flex items-center gap-2">
          <span
            class="font-mono font-semibold tabular-nums ${flat
              ? "text-ink-muted"
              : positive
                ? "text-positive"
                : "text-danger"}"
            >${formatSignedCredits(match.net)}${flat ? "†" : ""}</span
          >
          <a
            href="/premiere/${match.premiereId}"
            class="text-xs font-semibold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            >View →</a
          >
        </span>
      </li>
    `;
  }

  // ---------------------------------------------------------------------
  // League
  // ---------------------------------------------------------------------

  private renderLeague() {
    const claim = this.account!.league.claim;
    if (claim === null && !this.editingClaim) {
      return this.claimDismissed
        ? this.renderClaimDismissedRow()
        : this.renderClaimPrompt();
    }
    if (this.editingClaim) {
      return this.renderClaimPicker(claim?.playerName ?? null);
    }
    return this.renderClaimed(claim!);
  }

  private renderClaimDismissedRow() {
    return html`
      <section
        aria-labelledby="account-league-heading"
        class="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3"
      >
        <h2
          id="account-league-heading"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          League
        </h2>
        <button
          type="button"
          class="text-xs font-bold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => {
            this.editingClaim = true;
          }}
        >
          Own a league agent? Claim it →
        </button>
      </section>
    `;
  }

  private renderClaimPrompt() {
    return html`
      <section
        aria-labelledby="account-league-heading"
        class="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
      >
        <h2
          id="account-league-heading"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          League
        </h2>
        <p class="text-sm text-ink-muted">
          Do you own one of the fourteen agents competing in the league? Most
          traders don't — if that's you, no need to do anything here.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded-md bg-accent px-3 py-1.5 text-sm font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            @click=${() => {
              this.editingClaim = true;
            }}
          >
            Pick my agent
          </button>
          <button
            type="button"
            class="rounded-md border border-line px-3 py-1.5 text-sm font-semibold text-ink-muted outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            @click=${() => this.dismissClaimPrompt()}
          >
            I don't own an agent
          </button>
        </div>
      </section>
    `;
  }

  private renderClaimPicker(currentPlayerName: string | null) {
    const data = this.leagueData;
    return html`
      <section
        aria-labelledby="account-league-heading"
        class="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
      >
        <h2
          id="account-league-heading"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          League
        </h2>
        ${this.renderLeagueStaleness()}
        ${!this.leagueDataLoaded
          ? html`<p class="text-sm text-ink-muted">Loading league standings…</p>`
          : data === null || data.standings.length === 0
            ? html`<p class="text-sm text-ink-muted">
                League standings are unavailable right now — try again later.
              </p>`
            : this.renderClaimForm(data.standings, currentPlayerName)}
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            @click=${() => {
              this.editingClaim = false;
              this.claimError = null;
            }}
          >
            Cancel
          </button>
        </div>
      </section>
    `;
  }

  private renderClaimForm(
    standings: readonly LeagueStandingRow[],
    currentPlayerName: string | null,
  ) {
    const sorted = [...standings].sort((a, b) => a.rank - b.rank);
    const draft = this.claimDraft || currentPlayerName || sorted[0]?.playerName || "";
    return html`
      <div class="flex flex-col gap-2">
        <label
          for="account-league-claim-select"
          class="text-xs font-semibold text-ink-muted"
        >
          Which agent is yours?
        </label>
        <div class="flex flex-wrap items-center gap-2">
          <select
            id="account-league-claim-select"
            class="min-w-[16rem] rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
            .value=${draft}
            @change=${(event: Event) => {
              this.claimDraft = (event.target as HTMLSelectElement).value;
            }}
          >
            ${sorted.map(
              (standing) => html`
                <option value=${standing.playerName}>
                  #${standing.rank} ${standing.playerName}${standing.isHouse
                    ? " (house)"
                    : ""}
                </option>
              `,
            )}
          </select>
          <button
            type="button"
            ?disabled=${this.savingClaim}
            class="rounded-md bg-accent px-3 py-1.5 text-sm font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            @click=${() =>
              this.submitClaim(draft.slice(0, MAX_CLAIM_PLAYER_NAME_LENGTH))}
          >
            ${this.savingClaim ? "Saving…" : "This is me"}
          </button>
        </div>
        <p class="text-[11px] leading-snug text-ink-muted">
          This is a self-selected claim, not verified ownership — see below.
        </p>
        ${this.claimError !== null
          ? html`<p class="text-xs text-danger" role="alert">${this.claimError}</p>`
          : nothing}
      </div>
    `;
  }

  private renderClaimed(claim: { playerName: string; claimedAt: string }) {
    const data = this.leagueData;
    const standing =
      data?.standings.find((s) => s.playerName === claim.playerName) ?? null;
    return html`
      <section
        aria-labelledby="account-league-heading"
        class="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
      >
        <div class="flex items-center justify-between gap-2">
          <h2
            id="account-league-heading"
            class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
          >
            League
          </h2>
          <span
            class="rounded-full border border-line-strong bg-surface-3 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-muted"
            title="This is what you told us — nobody has verified you actually own this agent."
            >Self-selected · unverified</span
          >
        </div>
        <p class="text-[11px] leading-snug text-ink-muted">
          There is currently no way to prove GitHub-account ownership of a
          league agent, so this claim is private to you and never shown
          anywhere another player can see it. A verified path arrives with
          Softmax sign-in.
        </p>
        ${this.renderLeagueStaleness()}
        ${standing === null
          ? this.renderClaimedPlayerMissing(claim.playerName)
          : this.renderClaimedPlayerFound(standing, data!)}
        <button
          type="button"
          class="w-fit text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => {
            this.editingClaim = true;
            this.claimDraft = claim.playerName;
          }}
        >
          Change claim
        </button>
      </section>
    `;
  }

  private renderClaimedPlayerMissing(playerName: string) {
    return html`
      <p class="text-sm text-ink">
        You claimed
        <strong>${playerName}</strong>, but they're not in the current
        league standings mirror — dropped from rotation, renamed, or the
        mirror is between updates. Your claim is preserved either way; pick
        again if this is stale.
      </p>
    `;
  }

  private renderClaimedPlayerFound(
    standing: LeagueStandingRow,
    data: LeagueDataSnapshot,
  ) {
    if (standing.isHouse) {
      return html`
        <p class="text-sm text-ink">
          <strong>${standing.playerName}</strong> is the house agent — the
          platform's own bot, not a player-owned entry. Its stats aren't
          shown here.
        </p>
      `;
    }
    const form = recentForm(data, standing.playerName, 5);
    return html`
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="text-base font-bold text-ink">${standing.playerName}</span>
          <span class="font-mono text-xs tabular-nums text-ink-muted"
            >Rank #${standing.rank} · Rating ${standing.score !== null
              ? standing.score.toFixed(1)
              : "—"}</span
          >
        </div>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
          <span
            >${standing.roundsPlayed !== null
              ? `${standing.roundsPlayed.toLocaleString()} rounds played`
              : "Rounds played unknown"}</span
          >
          ${standing.policyLabel !== null
            ? html`<span>Policy ${standing.policyLabel}</span>`
            : nothing}
        </div>
        ${this.renderRecentFormWithLinks(form, data)}
      </div>
    `;
  }

  private renderRecentFormWithLinks(
    form: readonly FormEntry[],
    data: LeagueDataSnapshot,
  ) {
    if (form.length === 0) {
      return html`<p class="text-xs text-ink-muted">
        No recent completed rounds on record.
      </p>`;
    }
    const episodesById = new Map<string, LeagueEpisodeRow>(
      data.episodes.map((episode) => [episode.episodeRequestId, episode]),
    );
    return html`
      <ul class="flex flex-col gap-1">
        ${form.map((entry) => {
          const episode = episodesById.get(entry.episodeRequestId);
          const outcomeLabel =
            entry.outcome === "won"
              ? "Won"
              : entry.outcome === "eliminated"
                ? "Eliminated"
                : "Survived";
          const href = episode?.fullRenderHref ?? episode?.watchHref ?? null;
          return html`
            <li
              class="flex items-center justify-between gap-2 rounded-md bg-surface-3 px-2.5 py-1.5 text-xs"
            >
              <span class="flex items-center gap-2 text-ink-muted">
                <span
                  class="font-semibold ${entry.outcome === "won"
                    ? "text-ink"
                    : "text-ink-muted"}"
                  >${outcomeLabel}</span
                >
                ${episode?.map !== null && episode?.map !== undefined
                  ? html`<span>${episode.map}</span>`
                  : nothing}
              </span>
              ${href !== null
                ? html`<a
                    href=${href}
                    class="font-semibold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
                    >Watch →</a
                  >`
                : nothing}
            </li>
          `;
        })}
      </ul>
    `;
  }

  private renderLeagueStaleness() {
    const data = this.leagueData;
    if (data === null || !data.stale) return nothing;
    const asOf =
      data.lastGoodSyncAt !== null
        ? new Date(data.lastGoodSyncAt).toLocaleString()
        : "an unknown time";
    return html`
      <p
        class="rounded-md border border-caution/40 bg-caution/10 px-2 py-1 text-[11px] font-semibold text-caution"
        role="status"
      >
        League data is stale — last confirmed ${asOf}. Standings and form
        below may be dated.
      </p>
    `;
  }
}
