import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { z } from "zod";
import { afterFirstIdentityBootstrap } from "../../../identity/GuestBootstrapGate";
import "../components/GithubSignIn";
import {
  fetchLeagueData,
  type LeagueDataSnapshot,
  type LeagueStandingRow,
} from "../leagueData";

const MAX_CLAIM_LABEL_LENGTH = 120;
const DISMISS_STORAGE_KEY = "pw-account-claim-dismissed";

const accountIdentitySchema = z.object({
  accountId: z.string(),
  displayName: z.string().nullable(),
  githubLogin: z.string().nullable(),
  githubAvatarUrl: z.string().nullable(),
});

const accountClaimSchema = z.object({
  lineageSlug: z.string(),
  label: z.string(),
  claimedAt: z.string(),
  updatedAt: z.string(),
});
type AccountClaim = z.infer<typeof accountClaimSchema>;

const accountResponseSchema = z.object({
  schemaVersion: z.literal(1),
  csrfToken: z.string(),
  identity: accountIdentitySchema,
  claims: z.array(accountClaimSchema),
});

const claimResponseSchema = z.object({
  schemaVersion: z.literal(1),
  claims: z.array(accountClaimSchema),
});

type AccountResponse = z.infer<typeof accountResponseSchema>;

/** `<slug>:v<N>` -> `<slug>` — mirrors the server's `deriveLineageSlug` (see `PlatformPolicyClaimStore.ts`). Client-side only for grouping the picker; the server derives its own copy from whatever `label` is actually submitted, never trusts this one. */
function deriveLineageSlug(label: string): string {
  return label.replace(/:v\d+$/i, "");
}

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISS_STORAGE_KEY, "1");
  } catch {
    // Best-effort — private browsing or a full storage quota just means
    // the dismissal doesn't survive a reload.
  }
}

/**
 * `proxywar.xyz`'s own account page — identity (display name, GitHub
 * link) and a self-asserted "these model lineages are mine" claim SET: a
 * person can own more than one lineage (the operator, verbatim:
 * "accounts are for all model"), so this page lets a viewer claim,
 * list, and individually remove several. Nothing betting-specific lives
 * here anymore: the platform is the sole account authority (see the
 * platform build's contract), but it owns identity only, never a child
 * app's own domain data (points, positions). Works signed out:
 * `/api/account` mints/reuses the same signed platform cookie every
 * platform surface uses, so a first-time visitor sees a coherent empty
 * state rather than an error. Reachable with wagering off everywhere —
 * this page has no dependency on any wagering flag at all.
 */
@customElement("premiere-account-page")
export class PremiereAccountPage extends LitElement {
  @state() private loading = true;
  @state() private loadError = false;
  @state() private account: AccountResponse | null = null;
  @state() private leagueData: LeagueDataSnapshot | null = null;
  @state() private leagueDataLoaded = false;
  @state() private claimDismissed = readDismissed();
  @state() private addingClaim = false;
  @state() private claimDraft = "";
  @state() private savingClaim = false;
  @state() private removingLineageSlug: string | null = null;
  @state() private claimError: string | null = null;

  createRenderRoot() {
    this.classList.add("block", "w-full", "grow");
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
      const response = await afterFirstIdentityBootstrap(() =>
        fetch("/api/account", {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        }),
      );
      const body: unknown = await response.json().catch(() => null);
      const parsed = accountResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("account_load_failed");
      }
      this.account = parsed.data;
    } catch {
      this.account = null;
      this.loadError = true;
    } finally {
      this.loading = false;
    }
  }

  private async submitClaim(label: string): Promise<void> {
    const account = this.account;
    if (account === null || this.savingClaim) return;
    this.savingClaim = true;
    this.claimError = null;
    try {
      const response = await fetch("/api/account/claim", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-csrf-token": account.csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ label }),
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = claimResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("claim_save_failed");
      }
      this.addingClaim = false;
      this.claimDraft = "";
      await this.loadAccount();
    } catch {
      this.claimError = "Could not save your claim. Try again.";
    } finally {
      this.savingClaim = false;
    }
  }

  private async removeClaim(lineageSlug: string): Promise<void> {
    const account = this.account;
    if (account === null || this.removingLineageSlug !== null) return;
    this.removingLineageSlug = lineageSlug;
    this.claimError = null;
    try {
      const response = await fetch("/api/account/claim/remove", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-csrf-token": account.csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ lineageSlug }),
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = claimResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("claim_remove_failed");
      }
      await this.loadAccount();
    } catch {
      this.claimError = "Could not remove that claim. Try again.";
    } finally {
      this.removingLineageSlug = null;
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
    if (this.loadError || this.account === null) {
      return html`<div
        class="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
        role="alert"
      >
        Could not load your account. Try reloading the page.
      </div>`;
    }
    return html` ${this.renderIdentity()} ${this.renderClaim()} `;
  }

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------

  private renderIdentity() {
    const identity = this.account!.identity;
    const label =
      identity.githubLogin ??
      identity.displayName ??
      `Guest ${identity.accountId.slice(-4)}`;
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
                : "An account tied to this browser (a signed cookie) — clearing cookies or switching browsers starts a new one, with no history."}
            </span>
          </div>
        </div>
        ${identity.githubLogin === null
          ? html`<div
              class="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-ink-muted"
            >
              <span
                >Linking GitHub carries your identity to any betting or
                league browser you sign into.</span
              >
              <premiere-github-sign-in></premiere-github-sign-in>
            </div>`
          : nothing}
      </section>
    `;
  }

  // ---------------------------------------------------------------------
  // League model/policy claim SET — a person can own more than one
  // lineage ("accounts are for all model"), so this section lists every
  // claimed lineage with its own remove affordance, plus an "add
  // another" flow that reuses the same picker for the first claim.
  // ---------------------------------------------------------------------

  private renderClaim() {
    const claims = this.account!.claims;
    if (claims.length === 0 && !this.addingClaim) {
      return this.claimDismissed
        ? this.renderClaimDismissedRow()
        : this.renderClaimPrompt();
    }
    if (this.addingClaim) {
      return this.renderClaimPicker(claims);
    }
    return this.renderClaimedList(claims);
  }

  private renderClaimDismissedRow() {
    return html`
      <section
        aria-labelledby="account-claim-heading"
        class="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3"
      >
        <h2
          id="account-claim-heading"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          League models
        </h2>
        <button
          type="button"
          class="text-xs font-bold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => {
            this.addingClaim = true;
          }}
        >
          Own a league model? Claim it →
        </button>
      </section>
    `;
  }

  private renderClaimPrompt() {
    return html`
      <section
        aria-labelledby="account-claim-heading"
        class="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
      >
        <h2
          id="account-claim-heading"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          League models
        </h2>
        <p class="text-sm text-ink-muted">
          Do you own one (or more) of the models competing in the league?
          A person owns a whole lineage of models and policies — claiming
          any one version claims the whole line, past and future — and can
          own several lineages. Most visitors don't own one — if that's
          you, no need to do anything here.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded-md bg-accent px-3 py-1.5 text-sm font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
            @click=${() => {
              this.addingClaim = true;
            }}
          >
            Pick my lineage
          </button>
          <button
            type="button"
            class="rounded-md border border-line px-3 py-1.5 text-sm font-semibold text-ink-muted outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            @click=${() => this.dismissClaimPrompt()}
          >
            I don't own a model
          </button>
        </div>
      </section>
    `;
  }

  private renderClaimPicker(existingClaims: readonly AccountClaim[]) {
    const data = this.leagueData;
    return html`
      <section
        aria-labelledby="account-claim-heading"
        class="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
      >
        <h2
          id="account-claim-heading"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          League models
        </h2>
        ${this.renderLeagueStaleness()}
        ${!this.leagueDataLoaded
          ? html`<p class="text-sm text-ink-muted">
              Loading league standings…
            </p>`
          : data === null || data.standings.length === 0
            ? html`<p class="text-sm text-ink-muted">
                League standings are unavailable right now — try again later.
              </p>`
            : this.renderClaimForm(data.standings, existingClaims)}
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            @click=${() => {
              this.addingClaim = false;
              this.claimDraft = "";
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
    existingClaims: readonly AccountClaim[],
  ) {
    const alreadyClaimedSlugs = new Set(existingClaims.map((c) => c.lineageSlug));
    // One entry per lineage — a lineage typically has only its latest
    // version live in current standings anyway, but de-dupe defensively
    // (first one wins, standings are already rank-sorted) — and skip
    // whatever's already in the claim set, so the picker only ever offers
    // a genuinely NEW lineage to add.
    const byLineage = new Map<string, LeagueStandingRow>();
    for (const standing of [...standings].sort((a, b) => a.rank - b.rank)) {
      const label = standing.policyLabel ?? standing.playerName;
      const slug = deriveLineageSlug(label);
      if (!alreadyClaimedSlugs.has(slug) && !byLineage.has(slug)) {
        byLineage.set(slug, standing);
      }
    }
    const lineages = [...byLineage.entries()];
    if (lineages.length === 0) {
      return html`<p class="text-sm text-ink-muted">
        You've already claimed every lineage currently in the league
        standings.
      </p>`;
    }
    const draftSlug =
      this.claimDraft.length > 0 ? deriveLineageSlug(this.claimDraft) : lineages[0][0];
    return html`
      <div class="flex flex-col gap-2">
        <label
          for="account-claim-select"
          class="text-xs font-semibold text-ink-muted"
        >
          Which model lineage is yours?
        </label>
        <div class="flex flex-wrap items-center gap-2">
          <select
            id="account-claim-select"
            class="min-w-[16rem] rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
            .value=${draftSlug}
            @change=${(event: Event) => {
              const slug = (event.target as HTMLSelectElement).value;
              const standing = byLineage.get(slug);
              this.claimDraft =
                (standing?.policyLabel ?? standing?.playerName ?? slug).slice(
                  0,
                  MAX_CLAIM_LABEL_LENGTH,
                );
            }}
          >
            ${lineages.map(
              ([slug, standing]) => html`
                <option value=${slug}>
                  #${standing.rank} ${standing.playerName}
                  (${standing.policyLabel ?? slug})${standing.isHouse
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
            @click=${() => {
              const standing = byLineage.get(draftSlug);
              const label = (
                standing?.policyLabel ??
                standing?.playerName ??
                draftSlug
              ).slice(0, MAX_CLAIM_LABEL_LENGTH);
              void this.submitClaim(label);
            }}
          >
            ${this.savingClaim ? "Saving…" : "This is me"}
          </button>
        </div>
        <p class="text-[11px] leading-snug text-ink-muted">
          This is a self-selected claim, not verified ownership — see below.
        </p>
        ${this.claimError !== null
          ? html`<p class="text-xs text-danger" role="alert">
              ${this.claimError}
            </p>`
          : nothing}
      </div>
    `;
  }

  private renderClaimedList(claims: readonly AccountClaim[]) {
    return html`
      <section
        aria-labelledby="account-claim-heading"
        class="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
      >
        <div class="flex items-center justify-between gap-2">
          <h2
            id="account-claim-heading"
            class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
          >
            League models
          </h2>
          <span
            class="rounded-full border border-line-strong bg-surface-3 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-muted"
            title="This is what you told us — nobody has verified you actually own these model lineages."
            >Self-selected · unverified</span
          >
        </div>
        <p class="text-[11px] leading-snug text-ink-muted">
          There is currently no way to prove GitHub-account ownership of a
          league model, so these claims are private to you and never shown
          anywhere another player can see them — not on a public profile, a
          leaderboard, or in any premiere. A verified path arrives with
          Softmax sign-in.
        </p>
        ${this.renderLeagueStaleness()}
        <ul class="flex flex-col gap-3">
          ${claims.map(
            (claim) => html`
              <li
                class="flex flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0"
              >
                ${this.renderClaimedRow(claim)}
              </li>
            `,
          )}
        </ul>
        ${this.claimError !== null
          ? html`<p class="text-xs text-danger" role="alert">
              ${this.claimError}
            </p>`
          : nothing}
        <button
          type="button"
          class="w-fit text-xs font-semibold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => {
            this.addingClaim = true;
          }}
        >
          + Claim another lineage
        </button>
      </section>
    `;
  }

  private renderClaimedRow(claim: AccountClaim) {
    const data = this.leagueData;
    const standing =
      data?.standings.find(
        (s) => deriveLineageSlug(s.policyLabel ?? s.playerName) === claim.lineageSlug,
      ) ?? null;
    const removing = this.removingLineageSlug === claim.lineageSlug;
    const removeButton = html`
      <button
        type="button"
        ?disabled=${removing}
        class="w-fit shrink-0 text-xs font-semibold text-danger outline-none transition-colors hover:text-danger-strong focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        @click=${() => void this.removeClaim(claim.lineageSlug)}
      >
        ${removing ? "Removing…" : "Remove"}
      </button>
    `;
    if (standing === null) {
      return html`
        <div class="flex items-start justify-between gap-3">
          <p class="text-sm text-ink">
            You claimed <strong>${claim.label}</strong>
            (lineage <strong>${claim.lineageSlug}</strong>), but it's not
            in the current league standings mirror — dropped from
            rotation, renamed, or the mirror is between updates. Your
            claim is preserved either way.
          </p>
          ${removeButton}
        </div>
      `;
    }
    if (standing.isHouse) {
      return html`
        <div class="flex items-start justify-between gap-3">
          <p class="text-sm text-ink">
            <strong>${standing.playerName}</strong> is the house agent —
            the platform's own bot, not a player-owned entry. Its stats
            aren't shown here.
          </p>
          ${removeButton}
        </div>
      `;
    }
    return html`
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-1 flex-col gap-2">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <span class="text-base font-bold text-ink">${standing.playerName}</span>
            <span class="font-mono text-xs tabular-nums text-ink-muted"
              >Rank #${standing.rank} · Rating
              ${standing.score !== null ? standing.score.toFixed(1) : "—"}</span
            >
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            <span
              >${standing.roundsPlayed !== null
                ? `${standing.roundsPlayed.toLocaleString()} rounds played`
                : "Rounds played unknown"}</span
            >
            <span>Currently claimed as ${claim.label}</span>
          </div>
        </div>
        ${removeButton}
      </div>
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
        League data is stale — last confirmed ${asOf}. Standings below may
        be dated.
      </p>
    `;
  }
}
