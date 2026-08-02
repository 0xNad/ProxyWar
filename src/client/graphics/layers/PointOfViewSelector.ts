import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { GameView, PlayerView } from "../../../core/game/GameView";
import { aiLeagueSpectatorDisplayName } from "../../AiLeagueReplayMode";
import { fetchLeagueData } from "../../prediction/wagering/leagueData";
import {
  findPlayerForClaimedLineages,
  PointOfViewChangeEvent,
  readManualPovSelection,
  resolveClaimedLineageSlugs,
  writeManualPovSelection,
} from "../PointOfView";
import { FitWholeMapEvent, GoToPlayerEvent } from "../TransformHandler";
import { Layer } from "./Layer";

type PovSource = "manual" | "claim" | "neutral";

const WHOLE_BOARD_VALUE = "";

/**
 * Dispatched by the Stage 4 broadcast composition's competitor rail (either
 * overlay) with `detail: { playerName: string }` when a viewer clicks a
 * rail seat. This class is the ONLY listener — see `onFollowPlayerRequest`.
 */
export const BROADCAST_RAIL_FOLLOW_EVENT = "broadcast-rail-follow-player";

/**
 * Dispatched BY this class whenever the followed player changes (from a
 * rail click, the dropdown, the crosshair button, or the silent initial
 * claim/manual resolution) with `detail: { playerName: string | null }` —
 * `null` for "whole board". Both overlays listen for this to keep the
 * competitor rail's `followed`/`data-followed` state truthful.
 */
export const BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT =
  "broadcast-rail-followed-change";

/**
 * Replay/spectator "follow an agent" picker. Mounted once per game load,
 * only on spectator routes (`isReplaySpectatorView()` — see
 * `GameRenderer.ts`); live play never sees this element.
 *
 * What "PoV" means here, deliberately: NOT a camera lock. These are
 * full-map spectator routes — the whole board staying visible is the
 * point (`TransformHandler`'s cover-fit landing, zoom-out floor, and
 * bounded panning), and an earlier auto-pan-onto-one-nation was removed
 * as a defect (`ClientGameRunner.focusReplaySpectatorOnce` explicitly
 * skips even a ONE-TIME auto-pan for these exact routes). So the default
 * PoV — silent, on load, whether from a claim or neutral — NEVER moves
 * the camera. Following an agent means `TerritoryLayer` dims every other
 * nation's territory (and lets theirs read at full strength) plus
 * `Leaderboard` pinning their row so it's always visible. A camera nudge
 * only ever happens in direct response to the viewer's OWN click here —
 * picking someone from the dropdown, or the crosshair button — reusing
 * the exact same bounded, zoom-preserving `GoToPlayerEvent` a leaderboard
 * row click already dispatches, so it inherits the identical
 * spectator-safe bounds (see `TransformHandler.onGoToPlayer`).
 *
 * The default is a preference, never a fact: a claimed agent is
 * self-asserted (see `PointOfView.ts`'s `resolveClaimedLineageSlugs` doc)
 * and is labelled as such here, never as "your agent" or "owner". It is
 * also never sent anywhere — this component only reads the claim, it
 * never writes a manual pick back to any server, so no other viewer can
 * ever learn what a viewer picked.
 */
@customElement("pov-selector")
export class PointOfViewSelector extends LitElement implements Layer {
  public game: GameView | null = null;
  public eventBus: EventBus | null = null;

  @state() private players: PlayerView[] = [];
  @state() private selectedId: string | null = null;
  @state() private source: PovSource = "neutral";

  private initialSelectionStarted = false;

  createRenderRoot() {
    return this; // Enable Tailwind CSS
  }

  init() {
    this.refreshPlayers();
    void this.applyInitialSelection();
    document.addEventListener(
      BROADCAST_RAIL_FOLLOW_EVENT,
      this.onFollowPlayerRequest,
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener(
      BROADCAST_RAIL_FOLLOW_EVENT,
      this.onFollowPlayerRequest,
    );
  }

  /**
   * Bridge for the Stage 4 broadcast composition's competitor rail (spec
   * item 6: camera-follow discoverability) — a rail seat click, in either
   * overlay (`AiLeagueReplayOverlay.ts`, `ReplayPremiereOverlay.ts`), lands
   * here via a DOM CustomEvent (the SAME cross-overlay bridge pattern
   * `ai-league-replay-jump-turn` already uses for a different control) and
   * is treated EXACTLY like a manual dropdown pick: `applyPov(..., {
   * persist: true, pan: true })` keeps this selector's own dropdown/
   * crosshair state, the session-persisted manual pick, and the actual
   * `GoToPlayerEvent`/`PointOfViewChangeEvent` emissions all in perfect
   * sync with a rail click, rather than a second, parallel follow
   * mechanism that could drift from this one.
   */
  private readonly onFollowPlayerRequest = (event: Event): void => {
    const detail = (event as CustomEvent<{ playerName?: string }>).detail;
    if (typeof detail?.playerName !== "string") return;
    const player =
      this.game
        ?.playerViews()
        .find(
          (p) =>
            p.displayName() === detail.playerName ||
            p.name() === detail.playerName,
        ) ?? null;
    if (player === null) return;
    this.applyPov(player, "manual", { persist: true, pan: true });
  };

  getTickIntervalMs() {
    return 2000;
  }

  tick() {
    this.refreshPlayers();
  }

  renderLayer() {}

  shouldTransform() {
    return false;
  }

  private refreshPlayers(): void {
    if (this.game === null) return;
    this.players = this.game
      .playerViews()
      .slice()
      .sort((a, b) => a.displayName().localeCompare(b.displayName()));
  }

  private findById(id: string): PlayerView | null {
    return this.game?.playerViews().find((p) => p.id() === id) ?? null;
  }

  /**
   * Resolves the default PoV once, in priority order: a manual pick from
   * earlier THIS session (including an explicit "whole board") always
   * wins outright — manual always overrides the default. Otherwise the
   * signed-in viewer's claimed agent, if any and if they're actually a
   * participant in this game; otherwise the neutral whole-board default.
   * Never touches the camera — see the class doc.
   */
  private async applyInitialSelection(): Promise<void> {
    if (this.initialSelectionStarted) return;
    this.initialSelectionStarted = true;

    const manual = readManualPovSelection();
    if (manual !== undefined) {
      const player =
        manual === null
          ? null
          : (this.game
              ?.playerViews()
              .find((p) => p.displayName() === manual) ?? null);
      this.applyPov(player, "manual", { persist: false, pan: false });
      return;
    }

    const lineageSlugs = await resolveClaimedLineageSlugs();
    // A manual pick made while the claim fetch was in flight must win —
    // never clobber a viewer's own click with a slower-arriving default.
    if (readManualPovSelection() !== undefined) return;
    const claimedPlayer =
      lineageSlugs.length === 0 || this.game === null
        ? null
        : findPlayerForClaimedLineages(
            this.game,
            (await fetchLeagueData())?.standings ?? [],
            lineageSlugs,
          );
    this.applyPov(claimedPlayer, claimedPlayer !== null ? "claim" : "neutral", {
      persist: false,
      pan: false,
    });
  }

  private applyPov(
    player: PlayerView | null,
    source: PovSource,
    opts: { persist: boolean; pan: boolean },
  ): void {
    this.selectedId = player?.id() ?? null;
    this.source = source;
    if (opts.persist) {
      writeManualPovSelection(player?.displayName() ?? null);
    }
    this.eventBus?.emit(new PointOfViewChangeEvent(player));
    // Rail visual sync (spec item 6 polish): both overlays listen for this
    // to highlight whichever rail seat is currently followed, keeping the
    // rail's `data-followed` state truthful regardless of whether the PoV
    // changed via a rail click, the dropdown, or the initial claim/manual
    // resolution above.
    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT, {
        detail: { playerName: player?.displayName() ?? null },
      }),
    );
    // A manual pan request always resolves to a camera move: a followed
    // player pans/tracks to them (GoToPlayerEvent, unchanged); "Whole
    // board" instead recentres to the literal whole-map fit
    // (FitWholeMapEvent) — the one-gesture way back out of the portrait
    // spectator overzoom default (see TransformHandler.centerAll's
    // PORTRAIT_TARGET_VERTICAL_FILL). The initial silent resolution in
    // applyInitialSelection() always passes `pan: false`, so this never
    // fires on load — only in direct response to the viewer's own dropdown
    // pick, rail click, or crosshair tap.
    if (opts.pan) {
      if (player) {
        this.eventBus?.emit(new GoToPlayerEvent(player));
      } else {
        this.eventBus?.emit(new FitWholeMapEvent());
      }
    }
  }

  private onSelectChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const player = value === WHOLE_BOARD_VALUE ? null : this.findById(value);
    this.applyPov(player, "manual", { persist: true, pan: true });
  }

  private onCenterClick(): void {
    const player = this.selectedId === null ? null : this.findById(this.selectedId);
    if (player) {
      this.eventBus?.emit(new GoToPlayerEvent(player));
    } else {
      this.eventBus?.emit(new FitWholeMapEvent());
    }
  }

  private captionText(): string {
    if (this.selectedId === null) {
      return "Whole board";
    }
    const player = this.findById(this.selectedId);
    const name = player
      ? aiLeagueSpectatorDisplayName(player.displayName())
      : "";
    return this.source === "claim"
      ? `Following ${name} — from your league claim, self-asserted and not verified`
      : `Following ${name}`;
  }

  /**
   * P0 fix (found live 2026-08-02 at 390x844 and 844x390): this widget used
   * to sit `fixed top-4 left-1/2 -translate-x-1/2` at EVERY viewport width,
   * with `z-[50003]` — far above `game-right-sidebar`'s own container
   * (`z-1000`, `fixed top-0 right-0` below the 1200px breakpoint; see
   * `index.html`). Below 1200px wide the two never reflow apart, so this
   * centered, high-z pill visually sat on top of the Pause/Speed/Settings
   * buttons — `elementFromPoint` on their centers returned this `<select>`
   * instead, making them untappable.
   *
   * Fix: reflow, not a z-index change (lowering this one would just make
   * the SIDEBAR untappable by the same overlap instead). Below 1200px this
   * moves to `top-14 left-2` (clear of the sidebar's own `top-0`/`right-0`
   * row, however wide the sidebar's own button cluster gets) and caps its
   * width to the viewport so it can never run under the sidebar's lane on
   * a narrow screen. At/above 1200px — `game-right-sidebar`'s own
   * breakpoint, where it drops to a compact `top-4 right-4` corner with
   * room to spare — this keeps its original centered-at-top placement.
   * The "from your league claim" caption below (rendered only when
   * `source === "claim"`) follows the SAME reflow, offset to sit under
   * wherever the main pill actually landed at each breakpoint.
   */
  render() {
    return html`
      <div
        class="fixed top-14 left-2 z-[50003] flex items-center gap-1.5 rounded-lg bg-gray-800/85 text-white text-[11px] md:text-xs px-2 py-1.5 shadow-lg max-w-[calc(100vw-1rem)] min-[1200px]:top-4 min-[1200px]:left-1/2 min-[1200px]:max-w-none min-[1200px]:-translate-x-1/2"
      >
        <label for="pov-select" class="font-semibold whitespace-nowrap"
          >Follow:</label
        >
        <select
          id="pov-select"
          class="bg-gray-700/80 border border-slate-500 rounded px-1.5 py-1 text-white max-w-[160px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-info/60"
          .value=${this.selectedId ?? WHOLE_BOARD_VALUE}
          @change=${(e: Event) => this.onSelectChange(e)}
        >
          <option value=${WHOLE_BOARD_VALUE}>Whole board</option>
          ${this.players.map(
            (player) =>
              html`<option value=${player.id()}>
                ${aiLeagueSpectatorDisplayName(player.displayName())}
              </option>`,
          )}
        </select>
        <button
          type="button"
          title=${this.selectedId !== null
            ? "Center camera on the followed agent"
            : "Fit the whole map"}
          aria-label=${this.selectedId !== null
            ? "Center camera on the followed agent"
            : "Fit the whole map"}
          class="p-1 rounded hover:bg-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-info/60"
          @click=${() => this.onCenterClick()}
        >
          <svg
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="2.25" />
            <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
          </svg>
        </button>
        <span class="sr-only" role="status">${this.captionText()}</span>
      </div>
      ${this.source === "claim"
        ? html`<div
            class="fixed top-24 left-2 z-[50003] text-[10px] text-slate-300/90 bg-gray-800/70 rounded px-2 py-0.5 max-w-[calc(100vw-1rem)] text-center min-[1200px]:top-[52px] min-[1200px]:left-1/2 min-[1200px]:-translate-x-1/2 min-[1200px]:max-w-[280px]"
          >
            from your league claim — self-asserted, not verified
          </div>`
        : nothing}
    `;
  }
}
