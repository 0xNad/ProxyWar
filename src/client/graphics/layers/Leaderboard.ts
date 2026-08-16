import { html, nothing, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { renderTroops, translateText } from "../../../client/Utils";
import { EventBus } from "../../../core/EventBus";
import type { GameView } from "../../../core/game/GameView";
import { PlayerView } from "../../../core/game/GameView";
import { aiLeagueSpectatorDisplayName } from "../../AiLeagueReplayMode";
import { type StatsRow, StatsTable } from "../../components/StatsTable";
import { LeadChangeTracker } from "../../LeadChangeTracker";
import type { StatsTableKind } from "../../StatsConstants";
import { formatPercentage, renderNumber } from "../../Utils";
import { GoToPlayerEvent } from "../TransformHandler";
import { Layer } from "./Layer";
import { type ColumnDef, columnValues } from "./lib/StatsColumns";

// Sort-direction caret. Replaces the ⬆️/⬇️ emoji so the indicator matches the
// UI font, inherits the header text color, and renders identically across
// platforms (emoji glyphs vary and read as clip-art in a data table).
const sortCaret = (order: "asc" | "desc") =>
  html`<svg
    viewBox="0 0 10 10"
    width="9"
    height="9"
    fill="currentColor"
    aria-hidden="true"
    class="inline-block ml-0.5 align-middle opacity-80"
  >
    <path d=${order === "asc" ? "M5 3 1.5 7h7z" : "M5 7 1.5 3h7z"} />
  </svg>`;

// Crown chip worn by the hysteresis-CONFIRMED leader's row on the broadcast
// scorebug (never the live sidebar). Drawn inline SVG, not emoji (house
// rule: emoji glyphs vary per platform and read as clip-art — same reason
// sortCaret above exists), in amber because the crown IS this stage's one
// chrome-accent moment (--pw-accent, published by GameRenderer's broadcast
// stage; the fallback matches its value). data-crown is the hook the
// confirmed-lead-change pulse animation targets in playCrownPulse().
const crownChip = html`<svg
  data-crown
  viewBox="0 0 12 10"
  width="11"
  height="9"
  fill="currentColor"
  aria-hidden="true"
  class="shrink-0"
  style="color: var(--pw-accent, #ffc24a);"
>
  <path d="M1 9V3.4l2.6 1.9L6 1.2l2.4 4.1L11 3.4V9Z" />
</svg>`;

/**
 * The elimination clock that trails "OUT" on a dead broadcast row. Held as a
 * string constant so the template that uses it stays one short line: the
 * share track is capped at 52px and the marker MUST NOT wrap onto a second
 * line, which is also why the template puts no space character before this
 * span and pays for the gap with margin-left instead — a space is a break
 * opportunity, a margin is not.
 */
const outClockStyle =
  "margin-left: 2px; font-size: 9px; font-family: var(--pw-num, ui-monospace, monospace);";

/**
 * The second line under the leading value of the column the viewer sorted by.
 * Same 9px block the crown's margin note uses, but in ink-dim rather than
 * amber: amber is the CROWN's signal, and a second amber mark sitting on a
 * different row would read as a second leader — the exact confusion the
 * positional wash used to cause.
 */
/**
 * The leader's margin-over-second, under their NAME.
 *
 * It used to sit under the share, inside the OWNED cell — a fixed ~52px track,
 * where "+39.2 over 2nd" could only wrap to two or three lines. That is what
 * made the crowned row 52px against every other row's 29px, and a 52px band
 * with a single number in it is the "tall yellow banner" the owner reported
 * twice: the height was never decoration, it was this note looking for room.
 *
 * The name column is the flexible 1fr track, so here the note fits on ONE line
 * and the row grows by a single 11px line instead of two or three. It also
 * reads better: "softmaxwell / +39.2 over 2nd" is a sentence about the leader,
 * where the old placement was a sentence about the percentage above it.
 *
 * Seat-coloured by the caller? No — ink-dim. The band and the rail already
 * carry the leader's colour; a third coloured mark on the same row would be
 * noise, and this is a measurement, not an identity.
 */
const marginNoteStyle =
  "display: block; font-size: 9px; line-height: 1.25; font-family: var(--pw-num, ui-monospace, monospace); color: var(--pw-ink-dim, #a79e92); white-space: nowrap;";

const columnNoteStyle =
  "display: block; font-size: 9px; line-height: 1.3; font-family: var(--pw-num, ui-monospace, monospace); color: var(--pw-ink-dim, #a79e92);";

// L62: the name track takes the slack and the numeric tracks are allowed to
// SHRINK (minmax(0,...)). The hard 100px cap the live table used is why the
// leader rendered as "SIAN VOIDCR..." with 240px of unused width beside it —
// no broadcast graphic truncates the leader's name.
// Numeric caps are TIGHT here on purpose. Docked into the letterbox band the
// rail is ~300px, and the old 70/55/105 caps consumed 260px of it —
// collapsing the name column to single letters ("S...", "0..."). Identity
// outranks precision on a broadcast: the name gets the slack, the numbers get
// just enough to stay legible.
// The last track is the widest of the three numeric ones because its HEADER is
// the longest string on the card: at 52px "MAX TROOPS" clipped to
// "MAX TROO..." while the figures under it fitted fine. The name track is 1fr
// so it simply absorbs the difference.
const broadcastGridTemplate =
  "minmax(22px, 26px) minmax(0, 1fr) minmax(0, 52px) minmax(0, 46px) minmax(0, 62px)";
const compactScorebugMediaQuery = "(max-width: 980px)";

interface Entry {
  name: string;
  /**
   * Standing on the TILE axis — NOT the row's position in the table. The two
   * are the same only while the table is sorted by territory; see
   * tileStanding for why they must not be conflated now that the headers are
   * clickable.
   */
  position: number;
  /**
   * Share of the map — or, on a DEAD broadcast row, the "OUT mm:ss" marker.
   * A template rather than a plain string only because the elimination clock
   * rides at a smaller size than the word it follows (see outMarker).
   */
  score: string | TemplateResult;
  /**
   * Both carry an optional second line — the "over 2nd" gap, on the leading
   * row of whichever column the viewer sorted by (see sortedColumnLead).
   * Templates for the same reason `score` is one: the note has to ride inside
   * the value's own binding so the cell keeps exactly the node structure the
   * stage sheet's selectors were measured against.
   */
  gold: string | TemplateResult;
  maxTroops: string | TemplateResult;
  isMyPlayer: boolean;
  isOnSameTeam: boolean;
  player: PlayerView;
  /**
   * The player's ACTUAL on-map territory fill, so the standings and the board
   * read as one dataset instead of two unrelated ones. Sourced from
   * PlayerView.territoryColor() — the same accessor TerritoryLayer paints the
   * map with — and NOT from theme().territoryColor(), which returns the
   * default and ignores cosmetics/pattern overrides.
   */
  seatColor: string;
  seatRim: string;
  /**
   * Broadcast-only additions: `alive` drives the kept-but-dimmed dead rows,
   * `crowned` marks the hysteresis-confirmed leader's row (see
   * updateLeaderboard's lead tracking), and `marginNote` is the leader's
   * margin-over-second read ("▲N.N over 2nd") in the same share points the
   * score column itself displays.
   */
  alive: boolean;
  crowned: boolean;
  marginNote: string | null;
}

/** The "over 2nd" note for the sorted column, and whose row it belongs on. */
interface SortedColumnLead {
  id: string;
  key: "gold" | "maxtroops";
  note: string;
}

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
 *
 * TWO TABLES IN ONE ELEMENT, and the seam is `broadcast`.
 *
 * The LIVE game gets upstream's StatsTable verbatim: every path below that
 * is not explicitly gated on `this.broadcast` delegates to `super`, so the
 * live sidebar's markup, virtualization, column picker and sort are exactly
 * upstream's. The BROADCAST scorebug renders its own fixed five-column rail
 * instead (renderBroadcast) — it is a scorebug, not a spreadsheet: no column
 * picker, no virtualized window (the whole 16-nation field is the point),
 * seat swatches bound to the map, crowned leader, kept-but-dimmed dead rows.
 * GameRenderer's stage sheet is written against that rail's grid, and
 * `pointer-events: none` on the broadcast instance is why a picker menu and
 * a scroll window would be dead controls there anyway.
 */
@customElement("leader-board")
export class Leaderboard extends StatsTable implements Layer {
  public eventBus: EventBus | null = null;

  protected readonly tableKind: StatsTableKind = "player";

  players: Entry[] = [];

  /**
   * Broadcast scorebug mode. The LIVE sidebar must leave this false — this
   * component is shared between the live game and the replay, so every visible
   * divergence is gated here rather than applied globally.
   */
  @property({ type: Boolean }) broadcast = false;
  /** Rows shown while collapsed. Broadcast shows the whole field. */
  @property({ type: Number }) maxRows = 5;
  private showTopFive = true;

  @state()
  private _sortKey: "tiles" | "gold" | "maxtroops" = "tiles";

  @state()
  private _sortOrder: "asc" | "desc" = "desc";

  /**
   * Compact mode hides the gold and max-troops columns. If either one was the
   * active desktop sort when the viewer exits fullscreen, retaining it would
   * make the visible top rows depend on an invisible metric. The media-query
   * listener restores territory sorting at the same breakpoint that hides
   * those columns, so the compact scorebug always explains its own order.
   */
  private compactScorebugMedia: MediaQueryList | null = null;
  private readonly handleCompactScorebugChange = (
    event: MediaQueryListEvent,
  ): void => {
    if (event.matches) this.restoreVisibleCompactSort();
  };

  /**
   * LEAD-CHANGE beat state (broadcast only). The tracker applies the same
   * overtake policy the curated feed's lead_change events use (see
   * LeadChangeTracker.ts: 3-share-point margin, mirrored from the server's
   * canonical computeLeadChanges, plus a 100-turn hold on this live axis),
   * so the crown never strobes when a border war flickers raw rank 1/2 —
   * the crown stays with the incumbent's row through the flicker and only
   * travels (with a pulse) once the takeover is hysteresis-confirmed.
   */
  private leadTracker = new LeadChangeTracker();
  /** Incremented once per CONFIRMED lead change; updated() pulses the crown when it moves. */
  private crownPulseToken = 0;
  private lastPulsedCrownToken = 0;

  /**
   * FLIP bookkeeping. Cell rects are snapshotted in updateLeaderboard BEFORE
   * Lit re-renders a changed order (the DOM still shows the old order at
   * that point) and played back in updated(). Keyed player-id:column because
   * the row wrapper is display:contents — IT HAS NO BOX, so the row element
   * itself can never be measured or transformed; the grid cells are the real
   * boxes.
   */
  private pendingFlipRects: Map<string, DOMRect> | null = null;
  /** Row order of the last render; FLIP only arms when this CHANGES (never on a mere number tick). */
  private lastOrderKey = "";

  /**
   * Elimination records for the broadcast's kept dead rows: when a player
   * seen alive goes dead, the tick and their last-alive tile count are
   * recorded so dead rows can sort by elimination recency (fallback: tiles
   * at death, for players already dead when this component started
   * observing, e.g. after a seek). An alive re-observation deletes the
   * record — a backward jump legitimately resurrects.
   */
  private deathInfo = new Map<
    string,
    { deathTick: number | null; tilesAtDeath: number }
  >();
  private lastAliveTiles = new Map<string, number>();

  getTickIntervalMs() {
    return 1000;
  }

  init() {}

  connectedCallback(): void {
    super.connectedCallback();
    if (
      !this.broadcast ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    this.compactScorebugMedia = window.matchMedia(compactScorebugMediaQuery);
    this.compactScorebugMedia.addEventListener(
      "change",
      this.handleCompactScorebugChange,
    );
    if (this.compactScorebugMedia.matches) this.restoreVisibleCompactSort();
  }

  disconnectedCallback(): void {
    this.compactScorebugMedia?.removeEventListener(
      "change",
      this.handleCompactScorebugChange,
    );
    this.compactScorebugMedia = null;
    super.disconnectedCallback();
  }

  tick() {
    if (!this.broadcast) {
      this.refresh();
      return;
    }
    if (this.game === null) throw new Error("Not initialized");
    if (!this.visible) return;
    this.updateLeaderboard();
  }

  renderLayer(_context: CanvasRenderingContext2D) {}

  shouldTransform(): boolean {
    return false;
  }

  willUpdate(changed: Map<string, unknown>) {
    if (!this.broadcast) {
      super.willUpdate(changed);
      return;
    }
    // `broadcast` joins `visible` as a trigger, which it did not have to be on
    // 0.1.35. There the live and broadcast tables shared one `players` array,
    // so whichever branch ran first left something to render. Here the base
    // class fills its own private `rows` and this subclass fills `players`, so
    // an update that arrives with `broadcast` newly true and `visible`
    // unchanged would paint the rail from an array nothing had populated — an
    // empty scorebug until the first tick() a second later.
    if ((changed.has("visible") || changed.has("broadcast")) && this.visible) {
      this.updateLeaderboard();
    }
  }

  updated() {
    if (!this.broadcast) {
      // Upstream's post-render measurement of the virtualized scroll window.
      // The broadcast rail has no such window, so it must not run there.
      super.updated();
      return;
    }
    this.playFlip();
    this.playCrownPulse();
  }

  /**
   * Upstream's row source, used by the LIVE table only — the broadcast rail
   * builds its own Entry[] in updateLeaderboard because it carries fields
   * (seat colour, crown, elimination clock) that have no ColumnId.
   */
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

  private setBroadcastSort(key: "tiles" | "gold" | "maxtroops") {
    if (this._sortKey === key) {
      this._sortOrder = this._sortOrder === "asc" ? "desc" : "asc";
    } else {
      this._sortKey = key;
      this._sortOrder = "desc";
    }
    this.updateLeaderboard();
  }

  private restoreVisibleCompactSort(): void {
    if (this._sortKey === "tiles") return;
    this._sortKey = "tiles";
    this._sortOrder = "desc";
    if (this.game === null) {
      this.requestUpdate();
      return;
    }
    this.updateLeaderboard();
  }

  private updateLeaderboard() {
    if (this.game === null) throw new Error("Not initialized");
    const myPlayer = this.game.myPlayer();

    let sorted = this.game.playerViews();

    const compare = (a: number, b: number) =>
      this._sortOrder === "asc" ? a - b : b - a;

    const maxTroops = (p: PlayerView) => this.game!.config().maxTroops(p);

    switch (this._sortKey) {
      case "gold":
        sorted = sorted.sort((a, b) =>
          compare(Number(a.gold()), Number(b.gold())),
        );
        break;
      case "maxtroops":
        sorted = sorted.sort((a, b) => compare(maxTroops(a), maxTroops(b)));
        break;
      default:
        sorted = sorted.sort((a, b) =>
          compare(a.numTilesOwned(), b.numTilesOwned()),
        );
    }

    const numTilesWithoutFallout =
      this.game.numLandTiles() - this.game.numTilesWithFallout();

    const alivePlayers = sorted.filter((player) => player.isAlive());

    // Lead tracking always runs on the TILE axis (the standing axis),
    // independent of whatever column the table is momentarily sorted by.
    this.trackEliminations(sorted);
    const standing = this.tileStanding(alivePlayers);
    const columnLead = this.sortedColumnLead(alivePlayers);
    let crownedId = this.trackLead(alivePlayers);
    // A CROWN ON A LOSING ROW IS NOT A CROWN.
    //
    // The tracker holds the crown through noise on purpose — that hysteresis
    // is what stops it strobing when two nations trade rank 1 every few
    // ticks. But "hold through a flicker" is not "hold while the incumbent
    // slides to eleventh": the owner caught the scorebug crowning a nation
    // at rank 11 on 3.8%, its own margin note reading "3.1 behind", while
    // the map crowned the actual leader at 6.9%. Two crowns in one frame,
    // disagreeing, and the losing one was ours.
    //
    // So the crown is suppressed the moment its holder is no longer at the
    // top of the tile standing. That is the honest state: the lead is
    // genuinely contested, nobody is confirmed, and NO crown says that
    // better than a crown on the wrong row. The tracker keeps its own
    // incumbent and hold untouched underneath — the moment it confirms
    // whoever is actually leading, the crown returns to them.
    if (crownedId !== null && standing.get(crownedId) !== 1) {
      crownedId = null;
    }
    const marginNote = this.crownMarginNote(
      alivePlayers,
      crownedId,
      numTilesWithoutFallout,
    );
    // DEAD PLAYERS KEEP THEIR ROW on the broadcast: an elimination used to
    // read as a row silently vanishing (documented brief violation). Dead
    // rows sort below every living one, most recent elimination first —
    // the just-eliminated seat is the newsworthy one, so it sits nearest
    // the living field rather than sinking straight to the bottom.
    const deadPlayers = sorted
      .filter((player) => !player.isAlive())
      .sort((a, b) => this.compareDead(a, b));
    const field = [...alivePlayers, ...deadPlayers];
    const playersToShow = this.showTopFive
      ? field.slice(0, this.maxRows)
      : field;

    // FLIP arm: snapshot every cell's rect BEFORE Lit re-renders, and ONLY
    // when the row ORDER actually changed — per-second number ticks re-render
    // constantly and must never re-measure 80 rects or spawn animations.
    const orderKey = playersToShow.map((player) => player.id()).join("|");
    if (this.lastOrderKey !== "" && orderKey !== this.lastOrderKey) {
      this.captureFlipRects();
    }
    this.lastOrderKey = orderKey;

    this.players = playersToShow.map((player, index) => {
      const playerMaxTroops = this.game!.config().maxTroops(player);
      const tilesOwned = player.numTilesOwned();
      // NOBODY IS "OUT" BEFORE THE MATCH HAS STARTED.
      //
      // isAlive() is false for a player who has not spawned yet, and the
      // broadcast now opens PAST the dead opening (LullDirector's intro skip)
      // — which landed the viewer on a frame where all sixteen rows were
      // struck through and marked OUT over a board with no territory painted
      // on it yet. The first thing a new viewer saw was a graveyard.
      //
      // Elimination is only a meaningful reading once the spawn phase is over;
      // before that, a player with no tiles is simply a player who has not
      // arrived. Judged on the clock rather than on "have we seen them alive",
      // so it is also correct when the viewer mounts mid-match or seeks.
      const alive = player.isAlive() || !this.spawnPhaseOver();
      const crowned = alive && crownedId !== null && player.id() === crownedId;
      let goldNote: string | null = null;
      let troopsNote: string | null = null;
      if (columnLead !== null && columnLead.id === player.id()) {
        if (columnLead.key === "gold") goldNote = columnLead.note;
        else troopsNote = columnLead.note;
      }
      return {
        name: aiLeagueSpectatorDisplayName(player.displayName()),
        position: standing.get(player.id()) ?? index + 1,
        // Dead broadcast rows read "OUT" in the share column — drawn text in
        // the row's own faint ink, NEVER coral: coral is reserved for the
        // elimination beat itself (12 coral rows was a named aesthetic-gate
        // failure on the end card).
        score: !alive
          ? this.outMarker(player)
          : formatPercentage(tilesOwned / numTilesWithoutFallout),
        // A dead player's gold and max troops are ENGINE RESIDUE, not
        // standings: gold zeroes out and maxTroops() falls back to the spawn
        // baseline, so every eliminated row rendered "0" and "10.0K" — in the
        // same ink, the same column and the same weight as a living player's
        // measured figures. Numbers that look measured and are not are worse
        // than no numbers. ReplayEndCard.buildRows dashes them for exactly
        // this reason; the scorebug now agrees, with the same em dash.
        gold: !alive
          ? "—"
          : this.withColumnNote(renderNumber(player.gold()), goldNote),
        maxTroops: !alive
          ? "—"
          : this.withColumnNote(renderTroops(playerMaxTroops), troopsNote),
        isMyPlayer: player === myPlayer,
        isOnSameTeam:
          myPlayer !== null &&
          (player === myPlayer || player.isOnSameTeam(myPlayer)),
        player: player,
        seatColor: player.territoryColor().toHex(),
        seatRim: player.borderColor().toHex(),
        alive,
        crowned,
        marginNote: crowned ? marginNote : null,
      };
    });

    // Inherited from the table this forked: if the viewer's own seat missed
    // the window, it replaces the last row. A league broadcast is a spectator
    // view (myPlayer() is null), so this is inert there — kept because the
    // element is still the shared <leader-board> and a future embedded
    // player-side broadcast would want it.
    if (
      myPlayer !== null &&
      this.players.find((p) => p.isMyPlayer) === undefined
    ) {
      let place = 0;
      for (const p of sorted) {
        place++;
        if (p === myPlayer) {
          break;
        }
      }

      if (myPlayer.isAlive()) {
        const myPlayerMaxTroops = this.game!.config().maxTroops(myPlayer);
        const myTilesOwned = myPlayer.numTilesOwned();
        this.players.pop();
        this.players.push({
          name: aiLeagueSpectatorDisplayName(myPlayer.displayName()),
          position: place,
          score: formatPercentage(myTilesOwned / this.game.numLandTiles()),
          gold: renderNumber(myPlayer.gold()),
          maxTroops: renderTroops(myPlayerMaxTroops),
          isMyPlayer: true,
          isOnSameTeam: true,
          player: myPlayer,
          seatColor: myPlayer.territoryColor().toHex(),
          seatRim: myPlayer.borderColor().toHex(),
          alive: true,
          crowned: false,
          marginNote: null,
        });
      }
    }

    this.requestUpdate();
  }

  /**
   * Feeds one standings observation per tick to the lead tracker and
   * returns the confirmed leader's id (the crown holder). The observation
   * is on the tile axis over the LIVING field; shares use the sum of
   * currently-owned tiles so the tracker's margin gate
   * (LEAD_CHANGE_MARGIN_SHARE, the server's own overtake margin) measures
   * the same "share of claimed land" quantity the series-derived feed
   * events measure. The turn axis is GameView.ticks() — the same
   * executed-turn count the replay frame's turnNumber advances by — so
   * LEAD_CHANGE_HOLD_TURNS means the same wall of game time here as in
   * that constant's own doc.
   */
  private trackLead(alivePlayers: PlayerView[]): string | null {
    const game = this.game!;
    let top: PlayerView | null = null;
    let topTiles = -1;
    let totalOwned = 0;
    for (const player of alivePlayers) {
      const tiles = player.numTilesOwned();
      totalOwned += tiles;
      if (tiles > topTiles) {
        top = player;
        topTiles = tiles;
      }
    }
    if (top === null || totalOwned <= 0) {
      return this.leadTracker.confirmedLeaderId;
    }
    const incumbentId = this.leadTracker.confirmedLeaderId;
    const incumbent =
      incumbentId === null
        ? null
        : (game.playerViews().find((p) => p.id() === incumbentId) ?? null);
    const incumbentAlive = incumbent !== null && incumbent.isAlive();
    const beat = this.leadTracker.observe({
      turn: game.ticks(),
      leaderId: top.id(),
      leaderShare: topTiles / totalOwned,
      incumbentShare: incumbentAlive
        ? incumbent!.numTilesOwned() / totalOwned
        : 0,
      incumbentAlive,
    });
    if (beat !== null) {
      this.crownPulseToken += 1;
    }
    return this.leadTracker.confirmedLeaderId;
  }

  /**
   * The margin-over-second read for the crowned row: the gap between the
   * confirmed leader and the best OTHER living player, in the SAME share
   * points the score column displays (identical denominator —
   * numTilesWithoutFallout — so "12.4%  ▲2.1 over 2nd" is one consistent
   * quantity, never two subtly different percentages). While a challenger
   * is out in front but not yet confirmed, the crowned incumbent can be
   * momentarily behind — that renders as "▼N.N behind" rather than
   * pretending the crown is still ahead.
   */
  private crownMarginNote(
    alivePlayers: PlayerView[],
    crownedId: string | null,
    numTilesWithoutFallout: number,
  ): string | null {
    if (crownedId === null || numTilesWithoutFallout <= 0) return null;
    const crowned = alivePlayers.find((p) => p.id() === crownedId);
    if (crowned === undefined) return null;
    let bestOtherTiles = -1;
    for (const player of alivePlayers) {
      if (player.id() === crownedId) continue;
      const tiles = player.numTilesOwned();
      if (tiles > bestOtherTiles) bestOtherTiles = tiles;
    }
    // Last nation standing: there is no "2nd" to measure against, and a
    // fabricated margin would be worse than none.
    if (bestOtherTiles < 0) return null;
    const deltaPoints =
      ((crowned.numTilesOwned() - bestOtherTiles) / numTilesWithoutFallout) *
      100;
    const points = Math.abs(deltaPoints).toFixed(1);
    return deltaPoints >= 0
      ? translateText(
          "leaderboard.broadcast_margin_over_second",
          { points },
          `▲${points} over 2nd`,
        )
      : translateText(
          "leaderboard.broadcast_margin_behind",
          { points },
          `▼${points} behind`,
        );
  }

  /**
   * Standing on the TILE axis, keyed by player id — deliberately NOT the row's
   * index in the table. "#" in a standings column means STANDING, and now that
   * the headers are clickable, numbering the display order would print "1"
   * beside the nation with the fifth-largest empire the moment a viewer sorted
   * by gold. Sorting re-orders the ROWS; it does not re-rank the match.
   *
   * Under the default tiles-descending sort this is identical to the row index,
   * so the resting broadcast state is unchanged. Under any other sort the
   * out-of-sequence # column is itself the signal that the table has been
   * re-ordered — read together with the caret in the header that did it, which
   * is a truthful pair of cues rather than one lying number.
   */
  private tileStanding(alivePlayers: PlayerView[]): Map<string, number> {
    const standing = new Map<string, number>();
    [...alivePlayers]
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
      .forEach((player, index) => standing.set(player.id(), index + 1));
    return standing;
  }

  /**
   * "▲N over 2nd" for the column the viewer SORTED BY — the only context GOLD
   * and MAX TROOPS can honestly carry out of data this component already
   * holds. A share was the obvious first idea and is not available: there is
   * no "all the gold there is" the way there is a whole map, so any percentage
   * would need a denominator invented for the occasion. A rank would only
   * restate the row order the sort just produced. The gap to the runner-up is
   * measured, in the column's own units and the same renderer as the column
   * itself, and it answers the question the sort was asked: is this lead real?
   *
   * Only on the sorted column, and never on tiles — the crowned row's margin
   * note already speaks for the tile axis. The note costs its row a second
   * line, which is worth paying once in response to a viewer's own click and
   * emphatically not worth paying on sixteen rows of a panel whose height is
   * someone else's lane.
   */
  private sortedColumnLead(
    alivePlayers: PlayerView[],
  ): SortedColumnLead | null {
    const key = this._sortKey;
    if (key === "tiles") return null;
    const valueOf = (player: PlayerView) =>
      key === "gold"
        ? Number(player.gold())
        : this.game!.config().maxTroops(player);
    let leader: PlayerView | null = null;
    let best = -1;
    let second = -1;
    for (const player of alivePlayers) {
      const amount = valueOf(player);
      if (amount > best) {
        second = best;
        leader = player;
        best = amount;
      } else if (amount > second) {
        second = amount;
      }
    }
    // One nation left, or a dead heat at the top: there is no gap to report,
    // and a fabricated one would be worse than the bare number it replaces.
    if (leader === null || second < 0 || best <= second) return null;
    const gap =
      key === "gold"
        ? renderNumber(best - second)
        : renderTroops(best - second);
    return {
      id: leader.id(),
      key,
      note: translateText(
        "leaderboard.broadcast_column_over_second",
        { amount: gap },
        `▲${gap} over 2nd`,
      ),
    };
  }

  /**
   * A column value plus its optional second line, as ONE binding: the note has
   * to ride inside the value's own template expression so the cell keeps
   * exactly the node structure the stage sheet was measured against.
   */
  private withColumnNote(
    value: string,
    note: string | null,
  ): string | TemplateResult {
    if (note === null) return value;
    return html`${value}<span style=${columnNoteStyle}>${note}</span>`;
  }

  /**
   * Whether the spawn phase is behind us. Cached because it is read per row
   * per frame and the config value never changes for a match.
   */
  private spawnPhaseTurnsCache = -1;
  private spawnPhaseOver(): boolean {
    if (this.game === null) return true;
    if (this.spawnPhaseTurnsCache < 0) {
      this.spawnPhaseTurnsCache = this.game.config().numSpawnPhaseTurns();
    }
    return this.game.ticks() > this.spawnPhaseTurnsCache;
  }

  private trackEliminations(players: PlayerView[]): void {
    const ticks = this.game!.ticks();
    // Same rule as the row build: before the spawn phase ends, a player with
    // no tiles has not arrived rather than died, and recording a death for
    // them here would outlive the phase and strike their row out for the
    // rest of the match.
    if (!this.spawnPhaseOver()) return;
    for (const player of players) {
      const id = player.id();
      if (player.isAlive()) {
        this.lastAliveTiles.set(id, player.numTilesOwned());
        this.deathInfo.delete(id);
      } else if (!this.deathInfo.has(id)) {
        this.deathInfo.set(id, {
          // Only players actually SEEN alive get a death tick; a player
          // already dead when observation began (mid-match mount, seek)
          // has an unknown death time and must not be assigned a fake one.
          deathTick: this.lastAliveTiles.has(id) ? ticks : null,
          tilesAtDeath: this.lastAliveTiles.get(id) ?? 0,
        });
      }
    }
  }

  /** Most recent elimination first; unknown death times sort after every known one, then by tiles held at death, then name. */
  private compareDead(a: PlayerView, b: PlayerView): number {
    const infoA = this.deathInfo.get(a.id());
    const infoB = this.deathInfo.get(b.id());
    const tickA = infoA?.deathTick ?? -1;
    const tickB = infoB?.deathTick ?? -1;
    if (tickA !== tickB) return tickB - tickA;
    const tilesA = infoA?.tilesAtDeath ?? 0;
    const tilesB = infoB?.tilesAtDeath ?? 0;
    if (tilesA !== tilesB) return tilesB - tilesA;
    return a.displayName().localeCompare(b.displayName());
  }

  /**
   * The OUT marker for a dead broadcast row, carrying WHEN the seat went out.
   * A bare "OUT" says a player is gone but not in what ORDER the field fell,
   * and that order IS the shape of the match — three eliminations inside a
   * minute is a collapse, three across ten is attrition, and the panel read
   * identically either way. The clock is the transport's clock, so a viewer
   * can put an elimination against a position on the scrubber.
   *
   * Two honest limits, both deliberate. A player already dead when this
   * component began observing (mid-match mount, or a seek landing past their
   * elimination) has no recorded tick and gets the BARE marker rather than a
   * fabricated time — trackEliminations only stamps players it saw alive
   * first. And the stamp is a POLL: tick() runs at most once a second
   * (getTickIntervalMs), so it can trail the true elimination by up to one
   * interval — about a second of match clock at 1x, proportionally more under
   * fast playback. The ORDER it establishes is exact regardless, which is
   * what the marker is for.
   */
  private outMarker(player: PlayerView): string | TemplateResult {
    const out = translateText("leaderboard.broadcast_out", undefined, "OUT");
    const deathTick = this.deathInfo.get(player.id())?.deathTick ?? null;
    if (deathTick === null) return out;
    const clock = this.formatMatchClock(deathTick);
    return html`${out}<span style=${outClockStyle}>${clock}</span>`;
  }

  /**
   * mm:ss on the match clock: ten engine ticks a second. Deliberately a
   * duplicate of BroadcastScrubber's formatClock rather than an import — that
   * one is module-private there, and the two readouts only have to agree on a
   * four-line convention, which is cheaper to copy than to promote into a new
   * cross-layer export.
   */
  private formatMatchClock(tick: number): string {
    const seconds = Math.max(0, Math.round(tick / 10));
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  /** FLIP identity for a broadcast cell. */
  private flipCell(entry: Entry, column: number): string {
    return `${entry.player.id()}:${column}`;
  }

  /**
   * The whole inline style for one BROADCAST cell.
   *
   * THE CROWN AND THE WASH ARE ONE FACT, SO THEY ARE READ FROM ONE FIELD.
   * The stage sheet used to wash the leader's row POSITIONALLY
   * (".contents:not(.font-bold):nth-of-type(2)") while the crown chip followed
   * the hysteresis-CONFIRMED leader off `crowned`. Those two disagreed for
   * exactly as long as a takeover went unconfirmed — crown on one row, amber
   * on another, the panel naming two different leaders at once. Sorting by any
   * other column would have broken the positional rule outright. Both now come
   * off `crowned`, so they cannot drift apart no matter how long the tracker
   * holds or how the viewer re-orders the table.
   *
   * ONLY the crowned row is styled here. A non-crowned row is left entirely to
   * the stage sheet, which is what keeps its :hover wash alive — an inline
   * background, even `transparent`, is element-attached and outranks a
   * stylesheet rule of the same importance, so "cancelling" the wash on the
   * other fifteen rows would silently take the hover response down with it.
   * (An earlier revision did cancel, because the sheet still washed row 2 by
   * position; those rules are gone, so the cancel went with them.)
   *
   * `color` is the one declaration that still needs `!important`: the sheet
   * forces every cell to ink-dim with it, and the crowned row has to beat
   * that. `background` deliberately does NOT — nothing competes for it now,
   * and leaving it normal keeps the hover treatment the sheet's call rather
   * than a wall this file builds. As landed, the crowned row is the one row
   * with no hover response, which is the right trade while hover is a
   * background: a hover that REPLACED the amber would blank the leader signal
   * for as long as the pointer sat on it. A stackable hover property (an
   * inset box-shadow rather than a background) would give the crowned row a
   * hover too, and needs no change here.
   */
  private cellStyle(entry: Entry, column: number): string | typeof nothing {
    const parts: string[] = [];
    if (entry.crowned) {
      // OWNER OVERRIDE: THE LEADER'S BAND IS THEIR OWN COLOUR, not the chrome
      // amber — the same call he made for elimination skulls ("they should be
      // of the color that dies"), pointed the other way. It is the better
      // rule: the band and the territory on the map are then the same colour,
      // so "who is winning" is answered once instead of twice in two
      // vocabularies. Amber remains the fallback for a seat that does not
      // resolve, because the crowned row must never lose its band.
      //
      // 0.14 rather than the amber's 0.10: seat colours run darker than the
      // accent, and at 0.10 the darker seats did not separate from the panel.
      // seatColor is always a string, but an empty one would silently produce
      // an invalid color-mix and drop the band entirely, so it falls back.
      const seat =
        entry.seatColor.length > 0
          ? entry.seatColor
          : "var(--pw-accent, #ffc24a)";
      parts.push(`background: color-mix(in srgb, ${seat} 14%, transparent);`);
      parts.push(
        column === 0
          ? `color: ${seat} !important;`
          : "color: var(--pw-ink, #f2ece2) !important;",
      );
      parts.push("font-weight: 700;");
      // VERTICALLY CENTRED, and this is the "tall empty banner" fix.
      //
      // The crowned row is 52px where every other row is 29px, because the
      // margin note ("+37.4 over 2nd") wraps to a second line inside the
      // OWNED cell. The wash fills all 52px of EVERY cell — correct, the band
      // has to be continuous — but the gold and troops columns have no second
      // line, so their number sat at the top of a tall block with an empty
      // half beneath it, which reads as a banner rather than as a row. The
      // cell keeps its full height (the band stays unbroken); only the
      // content inside it centres.
      // ONLY the columns that actually had the empty half: rank, gold and max
      // troops. The NAME cell (1) and the OWNED cell (2) are left as blocks on
      // purpose — flexing them re-flowed their contents, truncating
      // "softmaxwell" to "softmaxw." against the percentage beside it and
      // wrapping the margin note from two lines to three. Their children are
      // laid out by the component (a truncating name track, a block note under
      // a value) and that layout is what makes the row tall in the first
      // place; those two cells have no empty half to fix.
      if (column === 0 || column >= 3) {
        parts.push(
          "display: flex; align-items: center; justify-content: flex-end;",
        );
      }
      // The rank cell carries the leader's rail — the single directional
      // accent on the panel, and the reason the eye finds the crowned row
      // before it has read a single number.
      if (column === 0) {
        parts.push(`box-shadow: inset 2px 0 0 ${seat};`);
      }
    }
    if (!entry.alive) {
      // Dead-row dimming via OPACITY, not color: the stage forces every cell's
      // color with !important (".contents > div { color: var(--pw-ink-dim)
      // !important }"), which beats any inline color — a trap hit while
      // writing this. Opacity has no competing rule. Applied per CELL because
      // the row wrapper is display:contents: opacity is a box property, and a
      // boxless element silently ignores it.
      //
      // 0.45 was chosen believing it landed "at the ink-faint weight the
      // design asks for". Measured, it did not: it put twelve of sixteen rows
      // at 2.36:1 against the panel, 29% below ink-faint's own 3.32:1 and far
      // under any legibility floor. Dimmed must still mean READABLE — these
      // rows carry who died and when, which is the shape of the match. 0.62
      // lands at roughly ink-faint, which is what was meant.
      //
      // Dead rows are HALF-STATURE as well as dimmed. With ten of sixteen
      // seats out late in a match, full-height dead rows pushed the scorebug
      // to ~505px at 720p — which, combined with the momentum graph growing
      // the scrubber band to 60px, starved the nation dossier's lane below its
      // 132px minimum and the click payoff silently stopped rendering. The
      // dead carry three fields (dash, struck name, OUT); they do not need a
      // living row's stature.
      //
      // The size and padding MUST be !important, and shipped for a while
      // without it doing nothing at all: the same stage rule that forces color
      // also forces `font-size: 12px` and 5px padding on every cell, so the
      // plain inline declarations underneath it never landed and the ~120px
      // this comment claims was never actually recovered. Same trap as the
      // color one directly above, one property family over.
      parts.push(
        "opacity: 0.62; font-size: 11px !important; line-height: 1.1 !important; padding-top: 2px !important; padding-bottom: 2px !important;",
      );
    }
    return parts.length === 0 ? nothing : parts.join(" ");
  }

  private captureFlipRects(): void {
    const rects = new Map<string, DOMRect>();
    for (const cell of this.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = cell.getAttribute("data-flip");
      if (key !== null) rects.set(key, cell.getBoundingClientRect());
    }
    this.pendingFlipRects = rects.size > 0 ? rects : null;
  }

  /**
   * FLIP playback over the CELLS (the wrapper has no box — see
   * pendingFlipRects's doc): each cell gets an inverted transform from its
   * pre-render rect and eases back to identity, so a rank change reads as
   * rows sliding past each other instead of teleporting. The crown chip
   * lives inside its row's name cell, so it rides along for free. Cost per
   * reorder: up to 80 rect reads before + 80 after (one forced layout
   * each) and up to 80 short WAAPI animations — and reorders are rare by
   * construction (the orderKey gate). prefers-reduced-motion viewers get
   * the instant reorder with no transforms at all. Known imprecision:
   * GameRenderer scales this panel with zoom (--pw-hud-scale), under which
   * measured rect deltas are visual px while transforms apply pre-zoom, so
   * below 1280w travel starts slightly short of the exact old position —
   * the motion still reads correctly and is not worth a computed-zoom
   * correction.
   */
  private playFlip(): void {
    const previous = this.pendingFlipRects;
    this.pendingFlipRects = null;
    if (previous === null) return;
    if (this.prefersReducedMotion()) return;
    for (const cell of this.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = cell.getAttribute("data-flip");
      if (key === null) continue;
      const before = previous.get(key);
      if (before === undefined) continue;
      const after = cell.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      cell.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        { duration: 300, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" },
      );
    }
  }

  /**
   * One scale+glow pulse on the crown, fired ONLY when the tracker confirms
   * a lead change (crownPulseToken) — never on raw rank flicker, which by
   * design does not move the crown at all. WAAPI rather than a stylesheet
   * keyframe so this component injects no style element (its CSS budget is
   * Tailwind utilities plus GameRenderer's stage rules).
   */
  private playCrownPulse(): void {
    if (this.crownPulseToken === this.lastPulsedCrownToken) return;
    this.lastPulsedCrownToken = this.crownPulseToken;
    if (this.prefersReducedMotion()) return;
    const crown = this.querySelector<SVGElement>("[data-crown]");
    if (crown === null) return;
    crown.animate(
      [
        {
          transform: "scale(1)",
          filter: "drop-shadow(0 0 0 rgba(255, 194, 74, 0))",
        },
        {
          transform: "scale(1.45)",
          filter: "drop-shadow(0 0 5px rgba(255, 194, 74, 0.9))",
          offset: 0.35,
        },
        {
          transform: "scale(1)",
          filter: "drop-shadow(0 0 0 rgba(255, 194, 74, 0))",
        },
      ],
      { duration: 900, easing: "ease-out" },
    );
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  private handleRowClickPlayer(player: PlayerView) {
    if (this.eventBus === null) return;
    this.eventBus.emit(new GoToPlayerEvent(player));
  }

  render() {
    if (!this.visible) {
      return html``;
    }
    // The live game is upstream's table, untouched. Only the broadcast
    // instance (GameRenderer sets `broadcast` on the spectator-only element
    // it creates) takes the scorebug rail below.
    if (!this.broadcast) {
      return super.render();
    }
    return this.renderBroadcast();
  }

  private renderBroadcast() {
    return html`
      <div
        class="max-h-[35vh] overflow-y-auto text-white text-xs md:text-xs lg:text-sm md:max-h-[50vh] mt-2 ${this
          .visible
          ? ""
          : "hidden"}"
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <div
          class="grid bg-gray-800/85 w-full text-xs md:text-xs lg:text-sm rounded-lg overflow-hidden"
          style="grid-template-columns: ${broadcastGridTemplate};"
        >
          <div class="contents font-bold bg-gray-700/60">
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500"
              data-scorebug-column="rank"
            >
              #
            </div>
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500 truncate"
              data-scorebug-column="player"
            >
              ${translateText("leaderboard.player")}
            </div>
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500 cursor-pointer whitespace-nowrap truncate"
              data-scorebug-column="owned"
              @click=${() => this.setBroadcastSort("tiles")}
            >
              ${translateText("leaderboard.owned")}
              ${this._sortKey === "tiles" ? sortCaret(this._sortOrder) : ""}
            </div>
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500 cursor-pointer whitespace-nowrap truncate"
              data-scorebug-column="gold"
              @click=${() => this.setBroadcastSort("gold")}
            >
              ${translateText("leaderboard.gold")}
              ${this._sortKey === "gold" ? sortCaret(this._sortOrder) : ""}
            </div>
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500 cursor-pointer whitespace-nowrap truncate"
              data-scorebug-column="max-troops"
              @click=${() => this.setBroadcastSort("maxtroops")}
            >
              ${translateText("leaderboard.maxtroops")}
              ${this._sortKey === "maxtroops" ? sortCaret(this._sortOrder) : ""}
            </div>
          </div>

          ${repeat(
            this.players,
            (p) => p.player.id(),
            (player, index) => html`
              <div
                class="contents hover:bg-slate-600/60 ${player.isOnSameTeam
                  ? "font-bold"
                  : ""} cursor-pointer"
                data-scorebug-row="player"
                @click=${() => this.handleRowClickPlayer(player.player)}
              >
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                  data-scorebug-column="rank"
                  data-flip=${this.flipCell(player, 0)}
                  style=${this.cellStyle(player, 0)}
                >
                  ${player.alive ? player.position : "–"}
                </div>
                <div
                  class="py-1 md:py-2 pl-1 min-w-0 flex items-center gap-1.5 ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                  data-scorebug-column="player"
                  data-flip=${this.flipCell(player, 1)}
                  style=${this.cellStyle(player, 1)}
                >
                  <!--
                    The chip is the ONLY thing binding this row to a shape
                    on the map. Without it the standings and the board are
                    two unrelated datasets and a viewer cannot answer
                    "which blob is #1?" — worse, the visually dominant blob
                    is often not the leader, so the naive read is wrong.
                  -->
                  <span
                    class="shrink-0 rounded-sm"
                    style="width:9px;height:9px;background:${player.seatColor};box-shadow:inset 0 0 0 1px ${player.seatRim};"
                    aria-hidden="true"
                  ></span>
                  ${player.crowned ? crownChip : nothing}
                  <span class="min-w-0 flex-1">
                    <span
                      class="block truncate ${player.alive
                        ? ""
                        : "line-through"}"
                      >${player.name}</span
                    >
                    ${player.marginNote === null
                      ? nothing
                      : html`<span data-scorebug-margin style=${marginNoteStyle}
                          >${player.marginNote}</span
                        >`}
                  </span>
                </div>
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                  data-scorebug-column="owned"
                  data-flip=${this.flipCell(player, 2)}
                  style=${this.cellStyle(player, 2)}
                >
                  ${player.score}
                </div>
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                  data-scorebug-column="gold"
                  data-flip=${this.flipCell(player, 3)}
                  style=${this.cellStyle(player, 3)}
                >
                  ${player.gold}
                </div>
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                  data-scorebug-column="max-troops"
                  data-flip=${this.flipCell(player, 4)}
                  style=${this.cellStyle(player, 4)}
                >
                  ${player.maxTroops}
                </div>
              </div>
            `,
          )}
        </div>
      </div>

      <button
        class="mt-2 p-0.5 px-1.5 md:px-2 text-xs md:text-xs lg:text-sm
        border rounded-md border-slate-500 transition-colors
        text-white mx-auto block hover:bg-white/10 bg-gray-700/50"
        @click=${() => {
          this.showTopFive = !this.showTopFive;
          this.updateLeaderboard();
        }}
      >
        ${this.showTopFive ? "+" : "-"}
      </button>
    `;
  }
}
