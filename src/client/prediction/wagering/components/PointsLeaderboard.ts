import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { z } from "zod";
import { formatSignedCredits } from "./pnlDisplay";

const MAX_DISPLAY_NAME_LENGTH = 32;

const pointsEntrySchema = z.object({
  participantId: z.string(),
  displayName: z.string().nullable(),
  lifetimePoints: z.number(),
  premieresTraded: z.number(),
  premieresWon: z.number(),
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

const displayNameResponseSchema = z.object({
  schemaVersion: z.literal(1),
  entry: pointsEntrySchema,
});

type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
type LeaderboardViewer = z.infer<typeof leaderboardViewerSchema>;

/** Anonymous fallback for a participant who has never set a display name — never the raw `guest_<hmac>` id itself. */
function labelFor(entry: { displayName: string | null; participantId: string }): string {
  return entry.displayName ?? `Guest ${entry.participantId.slice(-4)}`;
}

/**
 * Cross-premiere points leaderboard + display-name editor. Deliberately
 * NOT wired through `ReplayPremiereRuntimeController` — the leaderboard is
 * premiere-agnostic, so it authenticates independently via
 * `ReplayPremiereGuestSecurity.bootstrapRead`/`authorizeWrite`
 * (`/api/points/leaderboard`, `/api/points/display-name`), reusing the
 * SAME signed guest cookie identity a premiere session already established
 * — never a second identity.
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
  @state() private nameDraft = "";
  @state() private savingName = false;
  @state() private nameError: string | null = null;

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
      const response = await fetch("/api/points/leaderboard", {
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
      this.nameDraft = this.viewer?.displayName ?? "";
    } catch {
      this.loadError = "Could not load the leaderboard. Try again.";
    } finally {
      this.loading = false;
    }
  }

  private async saveName(): Promise<void> {
    if (this.csrfToken === null || this.savingName) return;
    this.savingName = true;
    this.nameError = null;
    try {
      const response = await fetch("/api/points/display-name", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-csrf-token": this.csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ displayName: this.nameDraft }),
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = displayNameResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error("display_name_save_failed");
      }
      // Re-fetch: cheapest correct way to reflect the sanitized name the
      // server actually stored (it may differ from the raw draft — see
      // `sanitizeDisplayName`) and hand back a fresh CSRF token.
      await this.load();
    } catch {
      this.nameError = "Could not save your name. Try again.";
    } finally {
      this.savingName = false;
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
              Leaderboard
            </h2>
            <button
              type="button"
              @click=${() => this.closeModal()}
              aria-label="Close leaderboard"
              class="rounded-md p-1 text-ink-muted outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          ${this.renderNameEditor()} ${this.renderBody()}
        </div>
      </div>
    `;
  }

  private renderNameEditor() {
    return html`
      <div class="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2.5">
        <label
          for="points-leaderboard-name"
          class="text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          Your display name
        </label>
        <div class="flex items-center gap-2">
          <input
            id="points-leaderboard-name"
            type="text"
            maxlength=${MAX_DISPLAY_NAME_LENGTH}
            placeholder=${this.viewer === null
              ? "Guest"
              : labelFor(this.viewer)}
            .value=${this.nameDraft}
            @input=${(event: InputEvent) => {
              this.nameDraft = (event.target as HTMLInputElement).value;
            }}
            class="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
          />
          <button
            type="button"
            ?disabled=${this.savingName}
            @click=${() => this.saveName()}
            class="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            ${this.savingName ? "Saving…" : "Save"}
          </button>
        </div>
        ${this.nameError !== null
          ? html`<p class="text-xs text-danger" role="alert">${this.nameError}</p>`
          : nothing}
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
          Loading leaderboard…
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
    entry: { participantId: string; displayName: string | null; lifetimePoints: number; premieresTraded: number; premieresWon: number },
    rank: number | null,
  ) {
    const isViewer = entry.participantId === this.viewer?.participantId;
    return html`
      <tr
        class="border-b border-line/50 ${isViewer ? "bg-accent-soft" : ""}"
        aria-current=${isViewer ? "true" : nothing}
      >
        <td class="py-1.5 pr-2 font-mono tabular-nums text-ink-muted">
          ${rank === null ? "—" : `#${rank}`}
        </td>
        <td class="max-w-[9rem] truncate py-1.5 pr-2 text-ink" title=${labelFor(entry)}>
          ${labelFor(entry)}${isViewer ? " (you)" : ""}
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
