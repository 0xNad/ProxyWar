import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import Countries from "resources/countries.json" with { type: "json" };
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import {
  PlayerActions,
  PlayerProfile,
  PlayerType,
  Relation,
} from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView, PlayerView } from "../../../core/game/GameView";
import "../../components/ui/Divider";
import {
  CloseViewEvent,
  ContextMenuEvent,
  MouseUpEvent,
} from "../../InputHandler";
import {
  renderDuration,
  renderNumber,
  renderTroops,
  translateText,
} from "../../Utils";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";
const traitorIcon = assetUrl("images/TraitorIconLightRed.svg");

/**
 * View-only player card. Right-click (or long-press) on a territory opens it
 * directly — there is no radial action wheel and no player-to-player actions:
 * ProxyWar viewers spectate agents, they never act in the match themselves.
 * It must therefore render fully without a "my player" (spectators/replays
 * have none); anything pairwise (relation to viewer, alliance countdown)
 * simply stays hidden in that case.
 */
@customElement("player-panel")
export class PlayerPanel extends LitElement implements Layer {
  public g: GameView;
  public eventBus: EventBus;
  public transformHandler: TransformHandler;

  private actions: PlayerActions | null = null;
  private tile: TileRef | null = null;
  private _profileForPlayerId: number | null = null;

  @state() public isVisible: boolean = false;
  @state() private allianceExpiryText: string | null = null;
  @state() private allianceExpirySeconds: number | null = null;
  @state() private otherProfile: PlayerProfile | null = null;

  createRenderRoot() {
    return this;
  }

  initEventBus(eventBus: EventBus) {
    this.eventBus = eventBus;
    eventBus.on(CloseViewEvent, () => {
      if (this.isVisible) {
        this.hide();
      }
    });
  }

  init() {
    this.eventBus.on(MouseUpEvent, () => {
      this.hide();
    });
    this.eventBus.on(ContextMenuEvent, (event) => {
      this.onContextMenu(event);
    });
  }

  private onContextMenu(event: ContextMenuEvent) {
    if (!this.transformHandler) return;
    const worldCoords = this.transformHandler.screenToWorldCoordinates(
      event.x,
      event.y,
    );
    if (!this.g.isValidCoord(worldCoords.x, worldCoords.y)) {
      return;
    }
    const tile = this.g.ref(worldCoords.x, worldCoords.y);
    const owner = this.g.owner(tile);
    if (!owner.isPlayer()) {
      // Right-clicking unowned land/ocean dismisses an open card.
      this.hide();
      return;
    }
    this.show(null, tile);
  }

  async tick() {
    if (this.isVisible && this.tile) {
      const owner = this.g.owner(this.tile);
      if (owner && owner.isPlayer()) {
        const pv = owner as PlayerView;
        const id = pv.id();
        // fetch only if we don't have it or the player changed
        if (this._profileForPlayerId !== Number(id)) {
          this.otherProfile = await pv.profile();
          this._profileForPlayerId = Number(id);
        }
      }

      // Refresh actions & alliance expiry (only meaningful with a viewer
      // player, i.e. never for replay spectators)
      const myPlayer = this.g.myPlayer();
      if (myPlayer !== null && myPlayer.isAlive()) {
        this.actions = await myPlayer.actions(this.tile, null);
        if (this.actions?.interaction?.allianceInfo?.expiresAt !== undefined) {
          const expiresAt = this.actions.interaction.allianceInfo.expiresAt;
          const remainingTicks = expiresAt - this.g.ticks();
          const remainingSeconds = Math.max(0, Math.floor(remainingTicks / 10)); // 10 ticks per second

          if (remainingTicks > 0) {
            this.allianceExpirySeconds = remainingSeconds;
            this.allianceExpiryText = renderDuration(remainingSeconds);
          } else {
            this.allianceExpirySeconds = null;
            this.allianceExpiryText = null;
          }
        } else {
          this.allianceExpirySeconds = null;
          this.allianceExpiryText = null;
        }
      }
      // Gold/troops keep moving during playback — refresh even without a
      // viewer player.
      this.requestUpdate();
    }
  }

  public show(actions: PlayerActions | null, tile: TileRef) {
    this.actions = actions;
    this.tile = tile;
    this.isVisible = true;
    this.requestUpdate();
  }

  public hide() {
    this.isVisible = false;
    this.requestUpdate();
  }

  private handleClose(e: Event) {
    e.stopPropagation();
    this.hide();
  }

  private identityChipProps(type: PlayerType) {
    switch (type) {
      case PlayerType.Nation:
        return {
          labelKey: "player_type.nation",
          classes: "border-indigo-400/25 bg-indigo-500/10 text-indigo-200",
          icon: "🏛️",
        };
      case PlayerType.Bot:
        return {
          labelKey: "player_type.bot",
          classes: "border-purple-400/25 bg-purple-500/10 text-purple-200",
          icon: "⚔️",
        };
      case PlayerType.Human:
      default:
        return {
          labelKey: "player_type.player",
          classes: "border-zinc-400/20 bg-zinc-500/5 text-zinc-300",
          icon: "👤",
        };
    }
  }

  private getRelationClass(relation: Relation): string {
    const base =
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 " +
      "shadow-[inset_0_0_8px_rgba(255,255,255,0.04)]";

    switch (relation) {
      case Relation.Hostile:
        return `${base} border-red-400/30 bg-red-500/10 text-red-200`;
      case Relation.Distrustful:
        return `${base} border-red-300/40 bg-red-300/10 text-red-300`;
      case Relation.Friendly:
        return `${base} border-emerald-400/30 bg-emerald-500/10 text-emerald-200`;
      case Relation.Neutral:
      default:
        return `${base} border-zinc-400/30 bg-zinc-500/10 text-zinc-200`;
    }
  }

  private getRelationName(relation: Relation): string {
    switch (relation) {
      case Relation.Hostile:
        return translateText("relation.hostile");
      case Relation.Distrustful:
        return translateText("relation.distrustful");
      case Relation.Friendly:
        return translateText("relation.friendly");
      case Relation.Neutral:
      default:
        return translateText("relation.neutral");
    }
  }

  private getExpiryColorClass(seconds: number | null): string {
    if (seconds === null) return "text-white"; // Default color

    if (seconds <= 30) return "text-red-400"; // Last 30 seconds: Red
    if (seconds <= 60) return "text-yellow-400"; // Last 60 seconds: Yellow
    return "text-emerald-400"; // More than 60 seconds: Green
  }

  private getTraitorRemainingSeconds(player: PlayerView): number | null {
    const ticksLeft = player.data.traitorRemainingTicks ?? 0;
    if (!player.isTraitor() || ticksLeft <= 0) return null;
    return Math.ceil(ticksLeft / 10); // 10 ticks = 1 second
  }

  private renderTraitorBadge(other: PlayerView) {
    if (!other.isTraitor()) return html``;

    const secs = this.getTraitorRemainingSeconds(other);
    const label = secs !== null ? renderDuration(secs) : null;
    const dotCls =
      secs !== null
        ? `mx-1 size-1 rounded-full bg-red-400/70 ${secs <= 10 ? "animate-pulse" : ""}`
        : "";

    return html`
      <div class="mt-1" role="status" aria-live="polite" aria-atomic="true">
        <span
          class="inline-flex items-center gap-2 rounded-full border border-red-400/30
            bg-red-500/10 px-2.5 py-0.5 text-sm font-semibold text-red-200
            shadow-[inset_0_0_8px_rgba(239,68,68,0.12)]"
          title=${translateText("player_panel.traitor")}
        >
          <img src=${traitorIcon} alt="" aria-hidden="true" class="size-4.5" />
          <span class="tracking-tight"
            >${translateText("player_panel.traitor")}</span
          >
          ${label
            ? html`<span class=${dotCls}></span>
                <span
                  class="tabular-nums font-bold text-red-100 whitespace-nowrap text-sm"
                >
                  ${label}
                </span>`
            : ""}
        </span>
      </div>
    `;
  }

  private renderRelationPillIfNation(other: PlayerView, my: PlayerView | null) {
    if (other.type() !== PlayerType.Nation) return html``;
    if (other.isTraitor()) return html``;
    if (my?.isAlliedWith && my.isAlliedWith(other)) return html``;
    if (!this.otherProfile || !my) return html``;

    const relation =
      this.otherProfile.relations?.[my.smallID()] ?? Relation.Neutral;
    const cls = this.getRelationClass(relation);
    const name = this.getRelationName(relation);

    return html`
      <div class="mt-1">
        <span class="text-sm font-semibold ${cls}">${name}</span>
      </div>
    `;
  }

  private renderIdentityRow(other: PlayerView, my: PlayerView | null) {
    const flagCode = other.cosmetics.flag;
    const country =
      typeof flagCode === "string"
        ? Countries.find((c) => c.code === flagCode)
        : undefined;

    const chip =
      other.type() === PlayerType.Human
        ? null
        : this.identityChipProps(other.type());

    return html`
      <div class="flex items-center gap-2.5 flex-wrap">
        ${country && typeof flagCode === "string"
          ? html`<img
              src=${assetUrl(`flags/${encodeURIComponent(flagCode)}.svg`)}
              alt=${country?.name ?? "Flag"}
              class="h-10 w-10 rounded-full object-cover"
              @error=${(e: Event) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />`
          : ""}

        <div class="flex-1 min-w-0">
          <h2
            class="text-xl font-bold tracking-[-0.01em] text-zinc-50 truncate"
            title=${other.displayName()}
          >
            ${other.displayName()}
          </h2>
        </div>
        ${chip
          ? html`<span
              class=${`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${chip.classes}`}
              role="status"
              aria-label=${translateText(chip.labelKey)}
              title=${translateText(chip.labelKey)}
            >
              <span aria-hidden="true" class="leading-none">${chip.icon}</span>
              <span class="tracking-tight"
                >${translateText(chip.labelKey)}</span
              >
            </span>`
          : html``}
      </div>
      ${this.renderTraitorBadge(other)}
      ${this.renderRelationPillIfNation(other, my)}
    `;
  }

  private renderResources(other: PlayerView) {
    return html`
      <div class="mb-1 flex justify-between gap-2">
        <div
          class="inline-flex items-center gap-1.5 rounded-lg bg-white/4 px-3 py-1.5 shrink-0
                    text-white w-35"
        >
          <span class="mr-0.5">💰</span>
          <span translate="no" class="tabular-nums w-[5ch] font-semibold">
            ${renderNumber(other.gold() || 0)}
          </span>
          <span class="text-zinc-200 whitespace-nowrap">
            ${translateText("player_panel.gold")}</span
          >
        </div>

        <div
          class="inline-flex items-center gap-1.5 rounded-lg bg-white/4 px-3 py-1.5
                    text-white w-35 shrink-0"
        >
          <span class="mr-0.5">🛡️</span>
          <span translate="no" class="tabular-nums w-[5ch] font-semibold">
            ${renderTroops(other.troops() || 0)}
          </span>
          <span class="text-zinc-200 whitespace-nowrap">
            ${translateText("player_panel.troops")}</span
          >
        </div>
      </div>
    `;
  }

  private renderStats(other: PlayerView, my: PlayerView | null) {
    // With a viewer player the trading row is pairwise (does `other` embargo
    // *me*); a spectator has no side, so it reflects the player's global
    // stance instead: stopped once they embargo anyone.
    const stoppedTrading =
      my !== null
        ? other.hasEmbargoAgainst(my)
        : other.data.embargoes.size > 0;

    return html`
      <!-- Betrayals -->
      <div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <div
          class="flex items-center gap-2 text-[15px] font-medium text-zinc-100 leading-snug"
        >
          <span aria-hidden="true">⚠️</span>
          <span>${translateText("player_panel.betrayals")}</span>
        </div>
        <div class="text-right text-[14px] font-semibold text-zinc-200">
          ${other.data.betrayals ?? 0}
        </div>
      </div>

      <!-- Trading / Embargo -->
      <div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <div
          class="flex items-center gap-2 text-[15px] font-medium text-zinc-100 leading-snug"
        >
          <span aria-hidden="true">⚓</span>
          <span>${translateText("player_panel.trading")}</span>
        </div>
        <div
          class="flex items-center justify-end gap-2 text-[14px] font-semibold"
        >
          ${stoppedTrading
            ? html`<span class="text-amber-400"
                >${translateText("player_panel.stopped")}</span
              >`
            : html`<span class="text-blue-400"
                >${translateText("player_panel.active")}</span
              >`}
        </div>
      </div>
    `;
  }

  private renderAlliances(other: PlayerView) {
    const allies = other.allies();

    const nameCollator = new Intl.Collator(undefined, { sensitivity: "base" });
    const alliesSorted = [...allies].sort((a, b) =>
      nameCollator.compare(a.displayName(), b.displayName()),
    );

    return html`
      <div class="select-none">
        <div class="flex items-center justify-between mb-2">
          <div
            id="alliances-title"
            class="text-[15px] font-medium text-zinc-200"
          >
            ${translateText("player_panel.alliances")}
          </div>
          <span
            aria-labelledby="alliances-title"
            class="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-[10px]
                 text-[12px] text-zinc-100 bg-white/10 border border-white/20"
          >
            ${allies.length}
          </span>
        </div>

        <div
          class="rounded-lg bg-zinc-800/70 ring-1 ring-zinc-700/60 w-full min-w-0"
        >
          <ul
            class="max-h-30 overflow-y-auto p-2
                 flex flex-wrap gap-1.5
                 scrollbar-thin scrollbar-thumb-zinc-600 hover:scrollbar-thumb-zinc-500 scrollbar-track-zinc-800"
            role="list"
            aria-labelledby="alliances-title"
            translate="no"
          >
            ${alliesSorted.length === 0
              ? html`<li class="text-zinc-400 text-[14px] px-1">
                  ${translateText("common.none")}
                </li>`
              : alliesSorted.map(
                  (p) =>
                    html`<li
                      class="max-w-full inline-flex items-center gap-1.5
                             rounded-md border border-white/10 bg-white/5
                             px-2.5 py-1 text-[14px] text-zinc-100
                             hover:bg-white/8 active:scale-[0.99] transition"
                      title=${p.displayName()}
                    >
                      <span class="truncate">${p.displayName()}</span>
                    </li>`,
                )}
          </ul>
        </div>
      </div>
    `;
  }

  private renderAllianceExpiry() {
    if (this.allianceExpiryText === null) return html``;
    return html`
      <div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-base">
        <div class="font-semibold text-zinc-300">
          ${translateText("player_panel.alliance_time_remaining")}
        </div>
        <div class="text-right font-semibold">
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-[14px] font-bold ${this.getExpiryColorClass(
              this.allianceExpirySeconds,
            )}"
            >${this.allianceExpiryText}</span
          >
        </div>
      </div>
    `;
  }

  render() {
    if (!this.isVisible) return html``;

    if (!this.tile) return html``;

    // Spectators/replays have no viewer player; the card renders without one.
    const my = this.g.myPlayer();

    const owner = this.g.owner(this.tile);
    if (!owner || !owner.isPlayer()) {
      this.hide();
      console.warn("Tile is not owned by a player");
      return html``;
    }
    const other = owner as PlayerView;

    return html`
      <style>
        /* Soft glowing ring animation for traitors */
        .traitor-ring {
          border-radius: 1rem;
          box-shadow:
            0 0 0 2px rgba(239, 68, 68, 0.34),
            0 0 12px 4px rgba(239, 68, 68, 0.22),
            inset 0 0 14px rgba(239, 68, 68, 0.13);
          animation: glowPulse 2.4s ease-in-out infinite;
        }
        @keyframes glowPulse {
          0%,
          100% {
            box-shadow:
              0 0 0 2px rgba(239, 68, 68, 0.22),
              0 0 8px 2px rgba(239, 68, 68, 0.15),
              inset 0 0 8px rgba(239, 68, 68, 0.07);
          }
          50% {
            box-shadow:
              0 0 0 4px rgba(239, 68, 68, 0.38),
              0 0 18px 6px rgba(239, 68, 68, 0.26),
              inset 0 0 18px rgba(239, 68, 68, 0.15);
          }
        }
      </style>

      <div
        class="fixed inset-0 z-10001 flex items-center justify-center overflow-auto
               bg-black/15 backdrop-brightness-110 pointer-events-auto"
        @contextmenu=${(e: MouseEvent) => e.preventDefault()}
        @wheel=${(e: MouseEvent) => e.stopPropagation()}
        @click=${() => this.hide()}
      >
        <div
          class="pointer-events-auto max-h-[90vh] min-w-75 max-w-100 px-4 py-2"
          @click=${(e: MouseEvent) => e.stopPropagation()}
        >
          <div class="relative">
            <div
              class="absolute inset-2 -z-10 rounded-2xl bg-black/25 backdrop-blur-[2px]"
            ></div>
            <div
              class=${`relative w-full bg-zinc-900/95 rounded-2xl text-zinc-100 shadow-2xl shadow-black/50
                 ${other.isTraitor() ? "traitor-ring" : "ring-1 ring-white/5"}`}
            >
              <div class="overflow-visible">
                <div
                  class="overflow-auto [-webkit-overflow-scrolling:touch] resize-y max-h-[calc(100vh-120px-env(safe-area-inset-bottom))]"
                >
                  <div class="sticky top-0 z-20 flex justify-end p-2">
                    <button
                      @click=${this.handleClose}
                      class="absolute right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-700 text-white shadow-sm hover:bg-red-500 transition-colors"
                      aria-label=${translateText("common.close") || "Close"}
                      title=${translateText("common.close") || "Close"}
                    >
                      ✕
                    </button>
                  </div>

                  <div
                    class="p-6 flex flex-col gap-2 font-sans antialiased text-[14.5px] leading-relaxed"
                  >
                    <!-- Identity (flag, name, type, traitor, relation) -->
                    <div class="mb-1">${this.renderIdentityRow(other, my)}</div>

                    <ui-divider></ui-divider>

                    <!-- Resources -->
                    ${this.renderResources(other)}

                    <ui-divider></ui-divider>

                    <!-- Stats: betrayals / trading -->
                    ${this.renderStats(other, my)}

                    <ui-divider></ui-divider>

                    <!-- Alliances list -->
                    ${this.renderAlliances(other)}

                    <!-- Alliance time remaining -->
                    ${this.renderAllianceExpiry()}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
