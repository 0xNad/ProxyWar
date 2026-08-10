import { customElement } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import type { GameView } from "../../../core/game/GameView";
import { aiLeagueSpectatorDisplayName } from "../../AiLeagueReplayMode";
import { type StatsRow, StatsTable } from "../../components/StatsTable";
import type { StatsTableKind } from "../../StatsConstants";
import { GoToPlayerEvent } from "../TransformHandler";
import { Layer } from "./Layer";
import { type ColumnDef, columnValues } from "./lib/StatsColumns";

/**
 * The in-game player leaderboard, on today's upstream OpenFront design:
 * icon column headers, sortable columns, a ⚙️ column picker
 * (clan/owned/gold/troops/max-troops/structures/allies/betrayals), and the
 * viewer's own row pinned beneath the scroll window when they rank below
 * the fold. Kept as the same `<leader-board>` element with the same
 * `visible`/`game`/`eventBus` contract the sidebar and GameRenderer drive.
 *
 * Names stay routed through `aiLeagueSpectatorDisplayName` — the league's
 * Anonymous-Names choke point — exactly like the table this replaces.
 */
@customElement("leader-board")
export class Leaderboard extends StatsTable implements Layer {
  public eventBus: EventBus | null = null;

  protected readonly tableKind: StatsTableKind = "player";

  getTickIntervalMs() {
    return 1000;
  }

  init() {}

  tick() {
    this.refresh();
  }

  renderLayer(_context: CanvasRenderingContext2D) {}

  shouldTransform(): boolean {
    return false;
  }

  protected buildRows(
    game: GameView,
    columns: readonly ColumnDef[],
  ): StatsRow[] {
    const myPlayer = game.myPlayer();

    return game
      .playerViews()
      .filter((player) => player.isAlive())
      .map((player) => ({
        key: String(player.id()),
        name: aiLeagueSpectatorDisplayName(player.displayName()),
        clanTag: null,
        values: columnValues(player, game, columns),
        emphasized:
          myPlayer !== null &&
          (player === myPlayer || player.isOnSameTeam(myPlayer)),
        pinned: player === myPlayer,
        onClick: () => {
          if (this.eventBus !== null) {
            this.eventBus.emit(new GoToPlayerEvent(player));
          }
        },
      }));
  }
}
