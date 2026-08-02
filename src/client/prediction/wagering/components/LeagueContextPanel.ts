import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  fetchLeagueData,
  headToHead,
  recentForm,
  resolveSeatStanding,
  type FormEntry,
  type LeagueDataSnapshot,
  type LeagueStandingRow,
} from "../leagueData";
import type { MarketSeatOption } from "../types";

const RECENT_FORM_LIMIT = 5;

/**
 * "Who are these four and which should I back?" — reference material for a
 * trader, collapsed by default so the map stays the hero and the trade
 * ticket stays the action (Main: reachable, not shouting). Per seat: league
 * rank + rating, recent form, rounds played, and shared match history with
 * the other seats in THIS premiere.
 *
 * Deliberately NOT a tipsheet: no favorite badge, no computed pick, no
 * "back this one" language anywhere in this file — every line is a
 * historical fact, and the closing note says outright that this is evidence
 * for the viewer to weigh, not a recommendation.
 *
 * Fetches `/ai-league-runs/league/data.json` once on mount (see
 * `leagueData.ts` — no polling, no `aria-live`; this context does not tick
 * like the market does). A native `<details>` disclosure gives correct
 * keyboard reachability and expanded/collapsed announcement for free.
 */
@customElement("premiere-league-context-panel")
export class PremiereLeagueContextPanel extends LitElement {
  @property({ attribute: false }) seats: readonly MarketSeatOption[] = [];

  @state() private data: LeagueDataSnapshot | null = null;
  @state() private loaded = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    fetchLeagueData().then((snapshot) => {
      this.loaded = true;
      this.data = snapshot;
    });
  }

  render() {
    if (this.seats.length === 0) return nothing;
    return html`
      <details
        class="group rounded-lg border border-line bg-surface-2 text-sm"
      >
        <summary
          class="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"
        >
          <span>Agent scouting report</span>
          <span
            aria-hidden="true"
            class="text-ink-muted transition-transform duration-200 group-open:rotate-180"
            >▾</span
          >
        </summary>
        <div class="flex flex-col gap-2 border-t border-line px-3 py-2.5">
          ${this.renderStaleness()} ${this.renderBody()}
          <p class="pt-1 text-[11px] italic leading-snug text-ink-muted">
            Evidence, not advice — league rating, recent form, and past
            meetings, never a favorite.
          </p>
        </div>
      </details>
    `;
  }

  private renderStaleness() {
    const data = this.data;
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
        League data is stale — last confirmed ${asOf}. Treat the ratings
        below as dated.
      </p>
    `;
  }

  private renderBody() {
    if (!this.loaded) {
      return html`<p class="text-xs text-ink-muted">
        Loading league context…
      </p>`;
    }
    const data = this.data;
    if (data === null) {
      return html`<p class="text-xs text-ink-muted">
        League data is unavailable right now — no rating or form context for
        this match.
      </p>`;
    }
    return html`<div class="flex flex-col gap-2.5">
      ${this.seats.map((seat) => this.renderSeat(seat, data))}
    </div>`;
  }

  private renderSeat(seat: MarketSeatOption, data: LeagueDataSnapshot) {
    const standing = resolveSeatStanding(data, seat);
    if (standing === null) {
      // Per RealRoster's contract (see `resolveSeatStanding`), a
      // `local_manifest` identity is definitively a house exhibition
      // persona — say so outright rather than implying a league agent
      // whose standings link is merely missing.
      const isHousePersona =
        seat.policyIdentity?.namespace === "local_manifest";
      return html`
        <div class="flex flex-col gap-0.5 rounded-md bg-surface-3 px-2.5 py-2">
          <span class="truncate text-xs font-semibold text-ink"
            >${seat.displayName}</span
          >
          <span class="text-[11px] text-ink-muted"
            >${isHousePersona
              ? "House exhibition agent — not a league competitor."
              : "Not yet linked to league standings."}</span
          >
        </div>
      `;
    }
    const form = recentForm(data, standing.playerName, RECENT_FORM_LIMIT);
    const opponents = this.seats.filter((s) => s.seatId !== seat.seatId);
    return html`
      <div class="flex flex-col gap-1 rounded-md bg-surface-3 px-2.5 py-2">
        <div class="flex items-baseline justify-between gap-2">
          <span class="truncate text-xs font-semibold text-ink"
            >${seat.displayName}</span
          >
          <span
            class="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted"
            >Rank ${standing.rank} · Rating ${standing.score !== null
              ? standing.score.toFixed(1)
              : "—"}</span
          >
        </div>
        <span class="text-[11px] text-ink-muted"
          >${standing.roundsPlayed !== null
            ? `${standing.roundsPlayed.toLocaleString()} league rounds played`
            : "Rounds played unknown"}</span
        >
        ${this.renderForm(form)} ${this.renderMetBefore(data, standing, opponents)}
      </div>
    `;
  }

  private renderForm(form: readonly FormEntry[]) {
    if (form.length === 0) {
      return html`<p class="text-[11px] text-ink-muted">
        No recent completed rounds on record.
      </p>`;
    }
    const wordFor = (outcome: FormEntry["outcome"]) =>
      outcome === "won" ? "won" : outcome === "eliminated" ? "eliminated" : "survived, no win";
    const summary = `Recent form, most recent first: ${form.map((f) => wordFor(f.outcome)).join(", ")}.`;
    return html`
      <div class="flex items-center gap-1">
        <span class="sr-only">${summary}</span>
        ${form.map((entry) => {
          const glyph =
            entry.outcome === "won" ? "W" : entry.outcome === "eliminated" ? "E" : "S";
          return html`<span
            aria-hidden="true"
            title=${wordFor(entry.outcome)}
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold ${entry.outcome ===
            "won"
              ? "bg-ink text-surface"
              : "bg-surface text-ink-muted"}"
            >${glyph}</span
          >`;
        })}
      </div>
    `;
  }

  private renderMetBefore(
    data: LeagueDataSnapshot,
    standing: LeagueStandingRow,
    opponents: readonly MarketSeatOption[],
  ) {
    const rows = opponents.flatMap((opponent) => {
      const opponentStanding = resolveSeatStanding(data, opponent);
      if (opponentStanding === null) return [];
      const record = headToHead(data, standing.playerName, opponentStanding.playerName);
      if (record.meetings === 0) return [];
      return [{ displayName: opponent.displayName, record }];
    });
    if (rows.length === 0) return nothing;
    return html`
      <div class="flex flex-col gap-0.5 border-t border-line pt-1">
        <span
          class="text-[10px] font-semibold uppercase tracking-wide text-ink-muted"
          >Met before</span
        >
        ${rows.map(
          (row) => html`<span class="text-[11px] text-ink-muted"
            >vs ${row.displayName}: ${row.record.meetings} shared round${
              row.record.meetings === 1 ? "" : "s"
            } (${row.record.subjectWins}–${row.record.opponentWins} wins)</span
          >`,
        )}
      </div>
    `;
  }
}
