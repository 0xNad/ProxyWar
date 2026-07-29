import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { z } from "zod";
import { formatSignedCredits } from "./pnlDisplay";
import { playerProfileUrl } from "../../../platform/playerProfileLink";

/** Octicon "mark-github" path data — same mark used by `GithubSignIn.ts`. */
const GITHUB_MARK_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z";

const pointsEntrySchema = z.object({
  participantId: z.string(),
  displayName: z.string().nullable(),
  lifetimePoints: z.number(),
  premieresTraded: z.number(),
  premieresWon: z.number(),
  /** Non-null only for a genuinely platform-linked account (see `BettingPlatformAccountLinkStore`) — never derivable from free text. Takes precedence in `labelFor`'s badge, not in the name itself: `displayName` is already sourced from the platform once linked. */
  platformAccountId: z.string().nullable(),
});

const leaderboardEntrySchema = pointsEntrySchema.extend({ rank: z.number() });
const leaderboardViewerSchema = pointsEntrySchema.extend({
  rank: z.number().nullable(),
});

const leaderboardResponseSchema = z.object({
  schemaVersion: z.literal(1),
  csrfToken: z.string(),
  leaderboard: z.object({
    entries: z.array(leaderboardEntrySchema),
    totalRankedParticipants: z.number(),
    viewer: leaderboardViewerSchema.nullable(),
  }),
});

type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
type LeaderboardViewer = z.infer<typeof leaderboardViewerSchema>;

/** Falls back to a stable `Guest ####` label when no display name has ever been set — never an empty string. */
function labelFor(entry: {
  displayName: string | null;
  participantId: string;
}): string {
  return entry.displayName ?? `Guest ${entry.participantId.slice(-4)}`;
}

/**
 * Cross-premiere points leaderboard, read-only for display name. Deliberately
 * NOT wired through `ReplayPremiereRuntimeController` — the leaderboard is
 * premiere-agnostic, so it authenticates independently via
 * `ReplayPremiereGuestSecurity.bootstrapRead` (`/api/premieres/points/leaderboard`),
 * reusing the SAME signed guest cookie identity a premiere session already
 * established — never a second identity. Display name itself is
 * platform-owned now (`app.proxywar.xyz`) — betting only ever reads it via
 * `BettingPlatformAccountLinkStore`, never writes it; manage it from your
 * account page on the platform, not here.
 */
@customElement("premiere-points-leaderboard")
export class PremierePointsLeaderboard extends LitElement {
  @property({ type: Boolean }) open = false;

  @state() private loading = false;
  @state() private loadError: string | null = null;
  @state() private entries: readonly LeaderboardEntry[] = [];
  @state() private totalRanked = 0;
  @state() private viewer: LeaderboardViewer | null = null;
  @state() private csrfToken: string | null = null;

  private previouslyFocused: HTMLElement | null = null;
  private loadedOnce = false;

  createRenderRoot() {
    return this;
  }

  updated(changed: Map<string, unknown>): void {
    if (!changed.has("open")) return;
    if (this.open) {
      this.previouslyFocused =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      queueMicrotask(() =>
        (this.querySelector('[role="dialog"]') as HTMLElement | null)?.focus(),
      );
      if (!this.loadedOnce) {
        this.loadedOnce = true;
        void this.load();
      }
    } else {
      this.previouslyFocused?.focus();
      this.previouslyFocused = null;
    }
  }

  private closeModal(): void {
    this.dispatchEvent(new CustomEvent("close"));
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeModal();
    }
  };

  private async load(): Promise<void> {
    this.loading = true;
    this.loadError = null;
    try {
      const response = await fetch("/api/premieres/points/leaderboard", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = leaderboardResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("leaderboard_load_failed");
      }
      this.csrfToken = parsed.data.csrfToken;
      this.entries = parsed.data.leaderboard.entries;
      this.totalRanked = parsed.data.leaderboard.totalRankedParticipants;
      this.viewer = parsed.data.leaderboard.viewer;
    } catch {
      this.loadError = "Could not load points. Try again.";
    } finally {
      this.loading = false;
    }
  }

  render() {
    if (!this.open) return html``;
    return html`
      <div class="fixed inset-0 z-[53000] flex items-center justify-center p-4">
        <div
          class="absolute inset-0 bg-black/60"
          @click=${() => this.closeModal()}
        ></div>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="points-leaderboard-title"
          class="relative z-10 flex max-h-[85vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-lg border border-line bg-surface p-4 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
          tabindex="0"
          @keydown=${this.handleKeydown}
        >
          <div class="flex items-center justify-between gap-2">
            <h2
              id="points-leaderboard-title"
              class="text-base font-bold text-ink"
            >
              Points
            </h2>
            <button
              type="button"
              @click=${() => this.closeModal()}
              aria-label="Close points"
              class="rounded-md p-1 text-ink-muted outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          ${this.renderBody()}
        </div>
      </div>
    `;
  }

  private renderBody() {
    if (this.loading && this.entries.length === 0) {
      return html`
        <div
          class="flex items-center justify-center rounded-md border border-line bg-surface-2 px-4 py-6 text-sm text-ink-muted"
          role="status"
        >
          Loading points…
        </div>
      `;
    }
    if (this.loadError !== null) {
      return html`
        <div
          class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          ${this.loadError}
        </div>
      `;
    }
    if (this.entries.length === 0) {
      return html`
        <p class="px-1 text-sm text-ink-muted">
          No premieres have settled yet — trade one to be the first name here.
        </p>
      `;
    }
    const viewerRanked =
      this.viewer !== null &&
      this.entries.some((entry) => entry.participantId === this.viewer?.participantId);
    return html`
      <table class="w-full border-collapse text-sm">
        <caption class="sr-only">
          Top ${this.entries.length} of ${this.totalRanked} ranked players by
          lifetime realized profit and loss across settled premieres
        </caption>
        <thead>
          <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
            <th scope="col" class="py-1.5 pr-2 font-semibold">Rank</th>
            <th scope="col" class="py-1.5 pr-2 font-semibold">Player</th>
            <th scope="col" class="py-1.5 pr-2 text-right font-semibold">Points</th>
            <th scope="col" class="py-1.5 text-right font-semibold">Matches</th>
          </tr>
        </thead>
        <tbody>
          ${this.entries.map((entry) => this.renderRow(entry, entry.rank))}
          ${this.viewer !== null && !viewerRanked
            ? html`
                <tr aria-hidden="true">
                  <td colspan="4" class="pt-2 pb-1 text-center text-xs text-ink-muted">
                    ⋯
                  </td>
                </tr>
                ${this.renderRow(this.viewer, this.viewer.rank)}
              `
            : nothing}
        </tbody>
      </table>
    `;
  }
  private renderRow(
    entry: {
      participantId: string;
      displayName: string | null;
      platformAccountId: string | null;
      lifetimePoints: number;
      premieresTraded: number;
      premieresWon: number;
    },
    rank: number | null,
  ) {
    const isViewer = entry.participantId === this.viewer?.participantId;
    const linked = entry.platformAccountId !== null;
    return html`
      <tr
        class="border-b border-line/50 ${isViewer ? "bg-accent-soft" : ""}"
        aria-current=${isViewer ? "true" : nothing}
      >
        <td class="py-1.5 pr-2 font-mono tabular-nums text-ink-muted">
          ${rank === null ? "—" : `#${rank}`}
        </td>
        <td
          class="max-w-[9rem] truncate py-1.5 pr-2 text-ink"
          title=${linked
            ? `Linked platform account: ${labelFor(entry)}`
            : labelFor(entry)}
        >
          <span class="inline-flex max-w-full items-center gap-1">
            ${linked
              ? html`<svg
                  viewBox="0 0 16 16"
                  width="11"
                  height="11"
                  fill="currentColor"
                  aria-hidden="true"
                  class="shrink-0 text-ink-muted"
                >
                  <path d=${GITHUB_MARK_PATH}></path>
                </svg>`
              : nothing}
            <a
              href=${playerProfileUrl(labelFor(entry))}
              class="truncate text-accent outline-none hover:text-accent-strong hover:underline focus-visible:ring-2 focus-visible:ring-accent ${linked ? "font-semibold" : ""}"
              >${labelFor(entry)}</a
            >
          </span>${isViewer ? " (you)" : ""}
        </td>
        <td
          class="py-1.5 pr-2 text-right font-mono font-semibold tabular-nums ${entry.lifetimePoints >=
          0
            ? "text-positive"
            : "text-danger"}"
        >
          ${formatSignedCredits(entry.lifetimePoints)}
        </td>
        <td class="py-1.5 text-right font-mono tabular-nums text-ink-muted">
          ${entry.premieresWon}/${entry.premieresTraded}
        </td>
      </tr>
    `;
  }
}
