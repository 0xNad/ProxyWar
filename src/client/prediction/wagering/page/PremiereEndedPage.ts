import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { z } from "zod";
// Build-provenance sentinel (side-effect import; see its own doc): if this
// module ever leaks into a league client bundle, the sentinel leaks with it
// and `scripts/scan-wagering-sentinel.mjs` fails that build.
import "../buildSentinel";

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
 * with no grace window once that runs. Two things survive it, both rooted
 * OUTSIDE the wiped state parent:
 *
 * - `ReplayPremierePointsLedger.ts` — this participant's own net P&L per
 *   premiere (`/api/premieres/account`'s `betting.matches[]`).
 * - `ReplayPremiereSettlementLedger.ts` — one durable "who won" record per
 *   premiere, written the moment the market settles (`GET
 *   /api/premieres/:id/settlement`, 404 when absent). Public data only
 *   (winner, final placements, market closing prices, settledAt) — the
 *   winner was always public the instant the market settled, so this is
 *   safe to serve with no viewer identity attached.
 *
 * A premiere settled BEFORE this ledger existed has no record — honest
 * absence, not a bug: the winnerSeatId/standings it would have carried
 * were already destroyed by an earlier cycle wipe before this feature
 * landed, and there is no way to recover them after the fact (no backfill
 * is possible or attempted). For those, and for a wagering-disabled
 * deployment where no settlement is ever recorded, this page falls back
 * to the honest generic copy: it names no winner, and says so.
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

const premiereSettlementResponseSchema = z.object({
  schemaVersion: z.literal(1),
  settlement: z.object({
    premiereId: z.string(),
    episodeRequestId: z.string().nullable(),
    matchKind: z.enum(["real-league", "exhibition"]),
    outcome: z.enum(["winner", "refunded"]),
    winnerSeatId: z.string().nullable(),
    winnerDisplayName: z.string().nullable(),
    placements: z.array(
      z.object({
        seatId: z.string(),
        displayName: z.string(),
        placement: z.literal(1).nullable(),
      }),
    ),
    settledAt: z.string(),
    totalParticipants: z.number(),
  }),
});

type PremiereSettlement = z.infer<
  typeof premiereSettlementResponseSchema
>["settlement"];

/** Winner + up to this many additional seats shown before collapsing the rest. */
const PLACEMENTS_VISIBLE_LIMIT = 3;

@customElement("premiere-ended-page")
export class PremiereEndedPage extends LitElement {
  @property({ type: String, attribute: "premiere-id" }) premiereId = "";
  /** Which route this was reached from — decides the "go watch something else" CTA and copy. */
  @property({ type: String }) surface: "bet" | "premiere" = "premiere";

  @state() private loading = true;
  @state() private account: PremiereEndedAccount | null = null;
  @state() private settlement: PremiereSettlement | null = null;

  createRenderRoot() {
    this.classList.add("block", "w-full", "grow");
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    await Promise.all([this.loadAccount(), this.loadSettlement()]);
    this.loading = false;
  }

  private async loadAccount(): Promise<void> {
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
    }
  }

  /** Public read, no credentials needed — the winner was always public post-settlement. 404/error/malformed all collapse to "no record", the same honest fallback as a pre-feature premiere. */
  private async loadSettlement(): Promise<void> {
    if (this.premiereId === "") return;
    try {
      const response = await fetch(
        `/api/premieres/${encodeURIComponent(this.premiereId)}/settlement`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        },
      );
      if (response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const parsed = premiereSettlementResponseSchema.safeParse(body);
        if (parsed.success) this.settlement = parsed.data.settlement;
      }
    } catch {
      // Transient failure — falls back to the honest "no record" copy,
      // same as a genuinely absent (pre-feature) settlement.
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
    if (this.settlement === null) {
      // No durable settlement record for this id — either it settled
      // before this feature existed (the data is gone, permanently, and
      // there is no backfill) or wagering never recorded one for it. Stay
      // honest: name no winner, but still show the viewer's own P&L when
      // we have it.
      if (match === null) {
        return html`<p class="text-sm text-ink-muted">
          This match is no longer live, and this link no longer leads anywhere —
          nothing more is available for it here.
        </p>`;
      }
      return html`
        <p class="text-sm text-ink-muted">
          This match is no longer live, but you traded it. Here's how it settled
          for you.
        </p>
        ${this.renderNet(match.net)} ${this.renderLifetime()}
      `;
    }
    return html`
      ${this.renderSettlement(this.settlement)}
      ${match !== null
        ? html`<div class="border-t border-line pt-3">
            <p class="text-xs font-bold uppercase tracking-wide text-ink-muted">
              Your result
            </p>
            ${this.renderNet(match.net)}
          </div>`
        : nothing}
      ${this.renderLifetime()}
    `;
  }

  private renderSettlement(settlement: PremiereSettlement) {
    if (settlement.outcome === "refunded") {
      return html`
        <p class="text-lg font-extrabold text-ink">Market refunded</p>
        <p class="text-xs text-ink-muted">
          This match's result couldn't be determined, so every position was
          refunded — no winner was declared.
        </p>
      `;
    }
    const winnerName = settlement.winnerDisplayName ?? "Unknown";
    const others = settlement.placements.filter(
      (placement) => placement.seatId !== settlement.winnerSeatId,
    );
    const visibleOthers = others.slice(0, PLACEMENTS_VISIBLE_LIMIT - 1);
    const hiddenCount = others.length - visibleOthers.length;
    return html`
      <p class="text-xs font-bold uppercase tracking-wide text-ink-muted">
        Winner
      </p>
      <p class="text-lg font-extrabold text-ink">${winnerName}</p>
      ${visibleOthers.length > 0
        ? html`<ul class="flex flex-col gap-0.5 text-xs text-ink-muted">
            ${visibleOthers.map(
              (placement) => html`<li>${placement.displayName}</li>`,
            )}
            ${hiddenCount > 0 ? html`<li>+${hiddenCount} more</li>` : nothing}
          </ul>`
        : nothing}
      <p class="text-[11px] text-ink-muted">
        Settled ${new Date(settlement.settledAt).toLocaleString()}
      </p>
    `;
  }

  private renderNet(net: number) {
    return html`
      <p
        class="text-2xl font-extrabold ${net > 0
          ? "text-positive"
          : net < 0
            ? "text-danger"
            : "text-ink"}"
      >
        ${net > 0 ? "+" : ""}${net} points
      </p>
      <p class="text-xs text-ink-muted">
        ${net > 0
          ? "You came out ahead on this one."
          : net < 0
            ? "This one didn't go your way."
            : "You broke even on this one."}
      </p>
    `;
  }

  private renderLifetime() {
    if (this.account === null) return nothing;
    return html`<p class="border-t border-line pt-3 text-xs text-ink-muted">
        Lifetime: ${this.account.betting.lifetimePoints} points
        ${this.account.betting.rank !== null
          ? html` · rank #${this.account.betting.rank} of
            ${this.account.betting.totalRankedParticipants}`
          : nothing}
      </p>
      <a
        href="/account"
        class="text-xs font-bold text-accent outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
      >
        View your account →
      </a>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "premiere-ended-page": PremiereEndedPage;
  }
}
