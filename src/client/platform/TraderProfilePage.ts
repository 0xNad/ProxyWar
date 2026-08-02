import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { z } from "zod";
import { formatSignedCredits } from "../prediction/wagering/components/pnlDisplay";

const bettingSectionSchema = z.object({
  lifetimePoints: z.number(),
  premieresTraded: z.number(),
  premieresWon: z.number(),
  rank: z.number(),
  totalRankedParticipants: z.number(),
});

const profileResponseSchema = z.object({
  schemaVersion: z.literal(1),
  accountId: z.string(),
  displayName: z.string().nullable(),
  betting: bettingSectionSchema.nullable(),
});

type ProfileResponse = z.infer<typeof profileResponseSchema>;

type LoadState = "loading" | "ready" | "not-found" | "error";

/**
 * A bettor's own public profile — the destination the betting points
 * leaderboard links a genuinely LINKED row to (`accountProfileUrl` in
 * `playerProfileLink.ts`, `GET /api/accounts/:accountId/betting-profile`
 * here). Keyed by the platform's own stable, opaque `accountId`, NEVER a
 * display name — two linked accounts can share one, so a name match can
 * silently surface the wrong account's stats. See
 * `BettingPlatformAccountLinkStore.getByPlatformAccountId`'s doc for the
 * full reasoning.
 *
 * Deliberately NOT the same page as `PlayerProfilePage` (league identity)
 * or `/account` (a signed-in caller's OWN account, with edit controls):
 * a league player and an account are only the same person by a claim
 * nobody here can verify, so this page never merges the two — it shows
 * only what this one account's link to betting can prove about itself.
 *
 * PUBLIC, READ-ONLY PAGE. Renders only what
 * `/api/accounts/:accountId/betting-profile` returns; `betting` is
 * `null` — never a 500 — whenever betting is unreachable, or this
 * account has never traded.
 *
 * Standalone route (`/trader/:accountId`, see `Main.ts`'s `handleUrl`),
 * not mounted inside the game engine/replay viewer — same pattern as
 * `PlayerProfilePage`.
 */
@customElement("trader-profile-page")
export class TraderProfilePage extends LitElement {
  @property({ type: String, attribute: "account-id" }) accountId = "";

  @state() private loadState: LoadState = "loading";
  @state() private profile: ProfileResponse | null = null;

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `PlayerProfilePage`.
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
        `/api/accounts/${encodeURIComponent(this.accountId)}/betting-profile`,
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
        throw new Error("trader_profile_load_failed");
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
      Loading trader…
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        Could not load this trader.
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
      <p class="text-sm text-ink-muted">
        We don't have any account matching this link.
      </p>
    `;
  }

  private renderProfile(profile: ProfileResponse) {
    const label = profile.displayName ?? `Trader ${profile.accountId.slice(-4)}`;
    return html`
      <header class="mb-5">
        <h1 class="text-xl font-bold text-ink" id="trader-profile-heading">
          ${label}
        </h1>
      </header>
      ${profile.betting !== null
        ? this.renderBettingSection(profile.betting)
        : html`<p class="text-sm text-ink-muted">
            This account hasn't settled a premiere yet.
          </p>`}
    `;
  }

  private renderBettingSection(
    betting: z.infer<typeof bettingSectionSchema>,
  ) {
    return html`
      <section aria-labelledby="trader-profile-betting-heading">
        <h2
          id="trader-profile-betting-heading"
          class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted"
        >
          Betting
        </h2>
        <dl class="grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt class="text-[11px] uppercase text-ink-muted">
              Lifetime P&amp;L
            </dt>
            <dd
              class="font-mono font-semibold ${betting.lifetimePoints >= 0
                ? "text-positive"
                : "text-danger"}"
            >
              ${formatSignedCredits(betting.lifetimePoints)}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] uppercase text-ink-muted">Rank</dt>
            <dd class="font-mono font-semibold text-ink">
              #${betting.rank} of ${betting.totalRankedParticipants}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] uppercase text-ink-muted">Record</dt>
            <dd class="font-mono font-semibold text-ink">
              ${betting.premieresWon}/${betting.premieresTraded}
            </dd>
          </div>
        </dl>
      </section>
    `;
  }
}
