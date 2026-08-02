import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { z } from "zod";

/**
 * Themed destination for a premiere id that no longer resolves — a stale
 * link, a bookmarked market, or a premiere the autocycler has already
 * replaced. Mounted by `Main.ts`'s `openPremiereEndedPage` in place of the
 * ordinary game/replay engine (same "standalone data page, no lobby/replay
 * concept behind it" shape as `premiere-account-page`/`player-profile-page`
 * — see their own docs) whenever the FIRST bootstrap fetch for `/premiere/
 * <id>` or `/bet/<id>` comes back 404 `PREMIERE_UNAVAILABLE`
 * (`ReplayPremiereNetworkError.code === "premiere_not_found"`).
 *
 * Replaces the previous behavior of the server sending the raw
 * `{"error":{"code":"PREMIERE_UNAVAILABLE"}}` JSON body as the top-level
 * document for a plain browser navigation (rendered by Chrome's own JSON
 * viewer, with zero site chrome) — see `ReplayPremierePublicPage.ts`'s
 * content-negotiated 404 branch, which now serves the ordinary app shell
 * instead so this component gets the chance to mount at all.
 *
 * Settlement data: what a premiere's own state genuinely retains post-
 * settlement is asymmetric. `cycle-premiere.sh` `rm -rf`s the ENTIRE
 * private state root (registry, market state, the archive-v1 summary
 * store — see `ReplayPremiereArchiveIndex.ts`) on every cycle transition,
 * with no grace window once that runs; the durable points ledger
 * (`ReplayPremierePointsLedger.ts`, rooted OUTSIDE the wiped state parent)
 * is the ONLY thing that survives indefinitely, and it only ever recorded
 * this participant's own net P&L per premiere — never the market's
 * winnerSeatId, standings, or territory. So this page can honestly answer
 * "how did I do on this one" (from `/api/premieres/account`'s
 * `betting.matches[]`, keyed by premiereId) forever, but can NEVER
 * honestly answer "who won" once the premiere is off the live registry —
 * claiming a winner from data that no longer exists would be exactly the
 * kind of dishonest UI this codebase's Honest UI rule forbids. A viewer
 * who wants the final territory/standings has to have been there live, or
 * catch it before the autocycler reclaims it.
 */
const premiereEndedAccountSchema = z.object({
  schemaVersion: z.literal(1),
  betting: z.object({
    lifetimePoints: z.number(),
    rank: z.number().nullable(),
    totalRankedParticipants: z.number(),
    matches: z.array(
      z.object({
        premiereId: z.string(),
        net: z.number(),
        revealedAt: z.string().nullable(),
      }),
    ),
  }),
});

type PremiereEndedAccount = z.infer<typeof premiereEndedAccountSchema>;

@customElement("premiere-ended-page")
export class PremiereEndedPage extends LitElement {
  @property({ type: String, attribute: "premiere-id" }) premiereId = "";
  /** Which route this was reached from — decides the "go watch something else" CTA and copy. */
  @property({ type: String }) surface: "bet" | "premiere" = "premiere";

  @state() private loading = true;
  @state() private account: PremiereEndedAccount | null = null;

  createRenderRoot() {
    this.classList.add("block", "w-full", "grow");
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch("/api/premieres/account", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const parsed = premiereEndedAccountSchema.safeParse(body);
        if (parsed.success) this.account = parsed.data;
      }
    } catch {
      // No wagering on this origin, or a transient failure — the generic
      // "ended" message below is still an honest, complete answer either
      // way; nothing here is worth retrying or surfacing as an error.
    } finally {
      this.loading = false;
    }
  }

  private settledMatch() {
    return (
      this.account?.betting.matches.find(
        (match) => match.premiereId === this.premiereId,
      ) ?? null
    );
  }

  render() {
    const primaryHref = this.surface === "bet" ? "/bet" : "/league";
    const primaryLabel =
      this.surface === "bet" ? "Go to the live market" : "Go to the league";
    return html`
      <div
        class="flex min-h-screen flex-col items-center bg-surface px-4 py-10 text-ink sm:px-6"
      >
        <div class="flex w-full max-w-md flex-col gap-6">
          <header>
            <a
              href="/"
              class="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden="true">‹</span> Proxy War
            </a>
          </header>
          <div
            class="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 p-6 text-center"
          >
            <h1 class="text-xl font-bold text-ink">This premiere has ended</h1>
            ${this.loading ? this.renderLoading() : this.renderBody()}
          </div>
          <a
            href=${primaryHref}
            class="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >
            ${primaryLabel}
          </a>
        </div>
      </div>
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      Checking your result…
    </p>`;
  }

  private renderBody() {
    const match = this.settledMatch();
    if (match === null) {
      return html`<p class="text-sm text-ink-muted">
        This match is no longer live, and this link no longer leads anywhere
        — nothing more is available for it here.
      </p>`;
    }
    return html`
      <p class="text-sm text-ink-muted">
        This match is no longer live, but you traded it. Here's how it
        settled for you.
      </p>
      <p class="text-2xl font-extrabold ${match.net > 0 ? "text-positive" : match.net < 0 ? "text-danger" : "text-ink"}">
        ${match.net > 0 ? "+" : ""}${match.net} points
      </p>
      <p class="text-xs text-ink-muted">
        ${match.net > 0
          ? "You came out ahead on this one."
          : match.net < 0
            ? "This one didn't go your way."
            : "You broke even on this one."}
      </p>
      ${this.account !== null
        ? html`<p class="border-t border-line pt-3 text-xs text-ink-muted">
            Lifetime: ${this.account.betting.lifetimePoints} points
            ${this.account.betting.rank !== null
              ? html` · rank #${this.account.betting.rank} of
                  ${this.account.betting.totalRankedParticipants}`
              : nothing}
          </p>`
        : nothing}
      <a
        href="/account"
        class="text-xs font-bold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
      >
        View your account →
      </a>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "premiere-ended-page": PremiereEndedPage;
  }
}
