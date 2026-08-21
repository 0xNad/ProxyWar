import { html, LitElement, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Winner } from "../../../core/Schemas";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { GameView, PlayerView } from "../../../core/game/GameView";
import {
  aiLeagueSpectatorDisplayName,
  isAiLeagueReplayRoute,
} from "../../AiLeagueReplayMode";
import {
  formatReplayIntegrity,
  replayIntegrity,
} from "../../ReplayIntegrityStore";
import {
  formatPercentage,
  renderNumber,
  renderTroops,
  translateText,
} from "../../Utils";
import { Layer } from "./Layer";

/**
 * ============================================================================
 * REPLAY END CARD — the designed close of a Proxy War broadcast.
 * ============================================================================
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * The live game's `WinModal` is suppressed on replay surfaces (see the
 * `body.ai-league-replay-mode win-modal { display: none }` rule and its comment
 * in `AiLeagueReplayOverlay.ts`): it carried a store upsell — "Purchase a
 * territory skin to go ad-free!" — plus EXIT GAME / SPECTATE buttons. A
 * monetisation prompt and live-session navigation have no business in a surface
 * that is WATCHED, not played. But the winner still has to be announced, and a
 * tournament deserves better than a repurposed play-session dialog: this card
 * is the winner, the full final standings including everyone who died, a
 * category breakdown, and — the part a non-expert actually reads — one honest
 * plain-language line about what happened.
 *
 * THREE NON-OBVIOUS CORRECTNESS RULES ARE LOAD-BEARING HERE
 * ---------------------------------------------------------
 * 1. END-OF-MATCH IS READ FROM THE ENGINE UPDATE, NOT THE EVENT BUS.
 *    `SendWinnerEvent` is only emitted from `WinModal`'s "team" and "player"
 *    branches, so the "nation" and no-winner cases NEVER fire on it — and
 *    "nation" is the branch a bot/agent win actually takes, because
 *    `GameImpl.makeWinner()` returns `["nation", winner.name()]` for any winner
 *    whose `clientID()` is null, which is every AI agent in a rendered replay.
 *    Subscribing to the bus would silently miss the common case. We read
 *    `GameUpdateType.Win` out of `updatesSinceLastTick()` instead — the same
 *    idiom `HeadsUpMessage.tick()` uses.
 *
 * 2. THIS LAYER MUST NOT IMPLEMENT `getTickIntervalMs()`.
 *    `GameView.updatesSinceLastTick()` returns ONLY the most recent update
 *    batch (`this.lastUpdate?.updates`) — it does not accumulate. `GameRenderer`
 *    skips `tick()` entirely for any layer whose wall-clock interval has not
 *    elapsed, so a throttled layer that happened to be skipped on the winning
 *    tick would lose the Win update permanently and the card would never
 *    appear. Ticking every frame is the price of not missing the one update
 *    that matters. The per-tick work is 16 field reads; it is free.
 *
 * 3. FINAL STANDINGS COME FROM `game.playerViews()`, NOT THE REPLAY FRAME.
 *    `GameView._players` is insert-only — there is no delete path — so an
 *    eliminated player is still in it with `isAlive() === false` and
 *    `numTilesOwned() === 0`. That is exactly what a tournament card needs: the
 *    dead are results, not omissions. The replay-frame payload filters to
 *    survivors and would quietly turn a 16-competitor match into a 3-row card.
 */

/**
 * Rows shown before the card starts summarising. A Proxy War match is 16
 * competitors and the two-column standings grid is laid out for exactly that.
 * Kept as a property rather than a constant so an oversized field degrades to
 * "+N eliminated earlier" instead of overflowing the frame.
 */
const DEFAULT_MAX_ROWS = 16;

/**
 * The viewer can scrub backwards after the card is up. Re-arming when the clock
 * goes meaningfully BACKWARDS is not auto-dismissal — auto-dismissal is a timer
 * that takes the result away from a viewer who did nothing. This only fires
 * when the viewer themselves rewound into the match, and the card returns the
 * moment the replay reaches the end again. The slack absorbs the ordinary
 * jitter of a paused/stepping clock so a still frame can never flicker it off.
 */
const REWIND_TOLERANCE_TICKS = 20;
/**
 * Ticks the replay must sit at/after its final recorded turn with no `Win`
 * before the card declares a no-winner result.
 *
 * This MUST be 1, and the counter is here only to reject a stray call that
 * arrives before the replay is genuinely exhausted. `Layer.tick()` is driven
 * once per GAME TURN, not once per animation frame — the same warning is on
 * `TradeAttackLanes.ts` — and `game.ticks() >= totalTurns` first becomes true
 * on the final delivered update. `LocalServer` ends the game at exactly that
 * point and stops dispatching turns, so no tick ever follows it. Any value
 * above 1 therefore makes this counter unreachable and the card never appears,
 * leaving the viewer on a frozen clock: the bug this constant caused when it
 * was 30 under the belief that it counted 60Hz frames.
 *
 * A real victory arriving late cannot lose the race either. A `Win` in the
 * same update batch installs a snapshot, and `tick()` returns early on an
 * existing snapshot before this check runs.
 */
const END_CARD_EXHAUSTION_TICKS = 1;

/**
 * Trend guards for the verdict. A collapse claim ("X fell from 135K tiles to
 * 10K") is only allowed to reach the screen when we actually watched enough of
 * the match to say it. Peaks are sampled live, so if playback started late or
 * fast-forwarded past the early game, the recorded peak is a LOWER bound on the
 * true peak — understating a collapse is still true, but claiming one off six
 * samples is not.
 */
const MIN_TREND_SAMPLES = 60;
/** A "collapse" has to be a collapse: at least halved, from a real holding. */
const COLLAPSE_MIN_RATIO = 2;
const COLLAPSE_MIN_PEAK_SHARE = 0.05;
const COLLAPSE_MIN_TURNS = 30;

/** Winner share bands used by the verdict. Tuned to what a viewer SAW. */
const SHARE_DOMINANT = 0.6;
const SHARE_SOLID = 0.35;
/** Below this gap over the runner-up, the win was decided on points, not force. */
const MARGIN_NARROW = 0.06;

/** One competitor's line in the final standings. */
interface StandingRow {
  rank: number;
  /** Spectator-safe name (rebrand + Anonymous Names). Never raw displayName(). */
  name: string;
  /** The player's ACTUAL on-map fill, so the card and the board are one dataset. */
  seat: string;
  tiles: number;
  share: number;
  shareLabel: string;
  gold: string;
  troops: string;
  alive: boolean;
  eliminatedAtTurn: number | null;
  peakTiles: number | null;
  peakAtTurn: number | null;
  isWinner: boolean;
}

/** One tile in the category breakdown. */
interface CategoryTile {
  label: string;
  name: string;
  seat: string;
  value: string;
}

/**
 * Everything the card renders, computed ONCE at the winning tick and then
 * frozen. An end card is a statement about the final frame; recomputing it
 * while the engine keeps ticking out post-win cleanup would let the numbers
 * drift out from under a viewer who is still reading them.
 */
interface EndCardSnapshot {
  eyebrow: string;
  headline: string;
  headlineSeat: string | null;
  metricValue: string;
  metricLabel: string;
  verdict: string;
  rows: StandingRow[];
  hiddenRows: number;
  categories: CategoryTile[];
  field: number;
  survivors: number;
  finalTurn: number;
}

/** Context handed to the verdict writer. Pure input; no engine access. */
interface VerdictContext {
  kind: "player" | "team" | "none";
  /** The winner's label, already spectator-safe. */
  name: string;
  /** Winner's (or winning team's) share of contestable land, 0..1. */
  share: number;
  rows: StandingRow[];
  field: number;
  survivors: number;
  finalTurn: number;
  /** False when playback did not observe enough of the match to claim trends. */
  trendsTrustworthy: boolean;
}

@customElement("replay-end-card")
export class ReplayEndCard extends LitElement implements Layer {
  /** Assigned by `mountReplayEndCard()`. Nullable so a mis-wire degrades to a
   * no-op instead of throwing inside the render loop and killing the replay. */
  public game: GameView | null = null;

  @property({ type: Number }) maxRows = DEFAULT_MAX_ROWS;

  /** Null until the match ends. Non-null == the card is up, and it HOLDS. */
  @state()
  private snapshot: EndCardSnapshot | null = null;

  /** Engine tick the snapshot was taken at; drives the scrub-back re-arm. */
  private snapshotTick: number | null = null;

  // --- Live trend sampler -------------------------------------------------
  // The engine exposes the CURRENT board, not its history, and the verdict
  // needs history to be honest ("collapsed from 135K to 10K"). These four maps
  // are the whole cost of that: keyed by smallID, updated once per tick.
  private readonly peakTiles = new Map<number, number>();
  private readonly peakTick = new Map<number, number>();
  private readonly eliminatedTick = new Map<number, number>();
  /**
   * Players observed alive at least once. Without this, everyone reads as
   * "eliminated" during the spawn phase (they are `isAlive() === false` until
   * they spawn) and every death timestamp would be turn 0.
   */
  private readonly everAlive = new Set<number>();
  private sampleCount = 0;
  /** Game-turn renderer ticks at/after the final recorded turn without a Win. */
  private exhaustedTicks = 0;

  /**
   * Light DOM. MANDATORY: Tailwind's global stylesheet and the broadcast
   * `--pw-*` tokens (published on `body.ai-league-native-spectator-ui`) are both
   * light-DOM only. In a shadow root this card would render as an unstyled
   * sliver at 0,0 with all of its state perfectly correct — the exact failure
   * `WinModal` documents having shipped once already.
   */
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    mountReplayEndCardStyles();
  }

  init() {}

  /**
   * TEARDOWN — see `Layer.dispose()`. Two things here outlive their GameView:
   * this element on document.body, and `pw-endcard-open` on the body itself.
   *
   * THE CLASS IS THE DANGEROUS ONE. It does not merely hide this card — it
   * stands the ENTIRE HUD down (scorebug, scrubber, toasts, dossier, analyst
   * drawer, following chip, lull director, the incumbent overlay). Orphan it
   * and the next thing the viewer starts plays on a bare board with no chrome
   * at all. `reArmIfScrubbedBackwards()` is the only in-class remover and it
   * requires `game.ticks()` to run backwards inside ONE GameView, which the
   * leave path never does — a rewind is a rebuild, and leaving is not a seek.
   * `mountReplayEndCard()` clears it on the way in for exactly that reason;
   * this clears it on the way out. Nothing else in the client writes the class
   * (every other reference is a read inside a CSS selector), so removing it
   * unconditionally cannot step on another surface.
   *
   * The four sampler maps go too. They are small per entry but they are keyed
   * per competitor for the whole match, and they are the only reason a
   * disposed card would still pin anything.
   *
   * Idempotent: `remove()` on a node with no parent is a no-op, so this is
   * safe before the element is ever connected and safe twice; `classList
   * .remove()` of an absent class is likewise a no-op.
   */
  dispose() {
    this.remove();
    document.body.classList.remove("pw-endcard-open");
    this.snapshot = null;
    this.snapshotTick = null;
    this.peakTiles.clear();
    this.peakTick.clear();
    this.eliminatedTick.clear();
    this.everAlive.clear();
    this.sampleCount = 0;
    // Last, so nothing above can be reached through a GameView this layer no
    // longer has any business reading.
    this.game = null;
  }

  renderLayer(/* context: CanvasRenderingContext2D */) {}

  /** DOM overlay, not a canvas layer: never inside the map transform. */
  shouldTransform(): boolean {
    return false;
  }

  // NOTE: getTickIntervalMs() is deliberately NOT implemented. See rule 2 in
  // the file header — throttling would drop the Win update batch on the floor.

  tick() {
    const game = this.game;
    if (game === null) return;

    if (this.snapshot !== null) {
      this.reArmIfScrubbedBackwards(game);
      // Frozen by design: no resampling, no recompute, no timer.
      return;
    }

    this.sampleBoard(game);

    const updates = game.updatesSinceLastTick();
    const winUpdates = updates !== null ? updates[GameUpdateType.Win] : [];
    if (winUpdates.length === 0) {
      this.showResultIfReplayExhausted(game);
      return;
    }

    // Only one match can end, and only once. Take the first Win update.
    this.showResult(game, winUpdates[0].winner);
  }

  /**
   * END-01: a match that ends WITHOUT an in-simulation victory.
   *
   * League episodes are cut off by the commissioner's turn budget, and the
   * standings are decided on territory — nobody is eliminated, so
   * `GameImpl.setWinner` is never called and no `Win` update ever reaches this
   * layer. Observed live 2026-08-19: the transport froze at "00:07 ·
   * 11500/11500", the board micro-animated forever, and the end card never
   * came. The replay simply had no terminal event to end on.
   *
   * `buildSnapshot` already renders the honest no-winner case ("Result / No
   * winner", ranked by largest holding), so all that was missing was the
   * trigger. Exhaustion is read from the same `pwReplayTotalTurns` body key
   * the broadcast clock uses, so this cannot fire in live play (the key is
   * absent) and stays correct across a rewind (the key is republished).
   *
   * The renderer ticks once per delivered game turn, and the turn loop stops
   * after the final update. Therefore the exhausted replay gets exactly one
   * chance to trigger this path. A genuine victory's `Win` update is read
   * first in `tick()`, so it still wins over the no-winner exhaustion result.
   */
  private showResultIfReplayExhausted(game: GameView): void {
    const totalTurns = Number(document.body.dataset.pwReplayTotalTurns);
    if (!Number.isFinite(totalTurns) || totalTurns <= 0) {
      this.exhaustedTicks = 0;
      return;
    }
    if (game.ticks() < totalTurns) {
      this.exhaustedTicks = 0;
      return;
    }
    this.exhaustedTicks += 1;
    if (this.exhaustedTicks < END_CARD_EXHAUSTION_TICKS) return;
    this.showResult(game, undefined);
  }

  /**
   * Records per-player high-water marks and elimination turns. Cheap enough to
   * run every tick (16 map writes), which is what rule 2 requires anyway.
   */
  private sampleBoard(game: GameView) {
    const turn = game.ticks();
    this.sampleCount += 1;
    for (const player of game.playerViews()) {
      const id = player.smallID();
      const tiles = player.numTilesOwned();
      const best = this.peakTiles.get(id);
      if (best === undefined || tiles > best) {
        this.peakTiles.set(id, tiles);
        this.peakTick.set(id, turn);
      }
      if (player.isAlive()) {
        this.everAlive.add(id);
      } else if (this.everAlive.has(id) && !this.eliminatedTick.has(id)) {
        // Elimination == observed alive, then observed not alive. Reading
        // `!isAlive()` on its own would time-stamp every unspawned player's
        // "death" at turn 0 during the spawn phase.
        this.eliminatedTick.set(id, turn);
      }
    }
  }

  private reArmIfScrubbedBackwards(game: GameView) {
    if (this.snapshotTick === null) return;
    if (game.ticks() >= this.snapshotTick - REWIND_TOLERANCE_TICKS) return;
    // The viewer rewound into the match. Clear the card so it is not covering
    // the board they just went back to watch; the Win update is replayed when
    // playback reaches that tick again, and the card comes back. Peaks and
    // elimination turns are maxima/firsts and stay valid across a scrub, so
    // the sampler state is intentionally NOT reset.
    this.snapshot = null;
    this.snapshotTick = null;
    document.body.classList.remove("pw-endcard-open");
  }

  private showResult(game: GameView, winner: Winner) {
    // Exactly one end-of-match surface, always. `AiLeagueReplayOverlay` hides
    // `win-modal` via `body.ai-league-replay-mode`, and that same class is our
    // permission to draw: if it is absent, the live WinModal is on screen and
    // this card must stay out of the frame rather than stack on top of it.
    if (!document.body.classList.contains("ai-league-replay-mode")) return;

    const snapshot = this.buildSnapshot(game, winner);
    if (snapshot === null) return;
    this.snapshot = snapshot;
    this.snapshotTick = game.ticks();
    // The card carries the complete, FROZEN final standings; the live scorebug
    // and feed keep ticking underneath it (they run to the recorded last tick,
    // the card froze at the win tick), so leaving them visible puts two
    // disagreeing sets of numbers on screen at once. The body class lets the
    // broadcast stylesheet stand them down while the card holds.
    document.body.classList.add("pw-endcard-open");
  }

  // --- Snapshot ------------------------------------------------------------

  private buildSnapshot(
    game: GameView,
    winner: Winner,
  ): EndCardSnapshot | null {
    const players = game.playerViews();
    if (players.length === 0) return null;

    // The leaderboard's denominator, so the card's percentages and the
    // scorebug's agree to the decimal. Fallout tiles are nobody's and are
    // excluded; the guard covers a map where every land tile is irradiated
    // (denominator <= 0) rather than emitting Infinity/NaN shares.
    const contestable = game.numLandTiles() - game.numTilesWithFallout();
    const denominator =
      contestable > 0 ? contestable : Math.max(game.numLandTiles(), 1);

    const finalTurn = game.ticks();
    const winnerSet = resolveWinningPlayers(game, winner, players);
    const rows = this.buildRows(game, players, denominator, winnerSet);

    const survivors = rows.filter((r) => r.alive).length;
    const field = rows.length;

    const kind: VerdictContext["kind"] =
      winner === undefined ? "none" : winner[0] === "team" ? "team" : "player";

    const winnerRows = rows.filter((r) => r.isWinner);
    const leaderRow = rows[0];

    // Headline. The "team" case is a group, so it is labelled by the team
    // string from the update rather than by any one member's name.
    let eyebrow: string;
    let headline: string;
    let headlineSeat: string | null;
    let share: number;
    let metricLabel: string;

    if (kind === "none" || winnerRows.length === 0) {
      // Also the fallback when a winner was declared but could not be resolved
      // to a PlayerView: state the truth (no attributable winner) instead of
      // inventing one.
      eyebrow = translateText(
        "ai_league_replay.end_result",
        undefined,
        "Result",
      );
      headline = translateText(
        "ai_league_replay.end_no_winner",
        undefined,
        "No winner",
      );
      headlineSeat = null;
      share = leaderRow.share;
      metricLabel = translateText(
        "ai_league_replay.end_largest_holding",
        undefined,
        "largest holding",
      );
    } else if (kind === "team" && winner !== undefined) {
      eyebrow = translateText(
        "ai_league_replay.end_winning_team",
        undefined,
        "Winning team",
      );
      headline = String(winner[1]);
      headlineSeat = winnerRows[0].seat;
      share = winnerRows.reduce((sum, r) => sum + r.share, 0);
      metricLabel = translateText(
        "ai_league_replay.end_of_map",
        undefined,
        "of the map",
      );
    } else {
      eyebrow = translateText(
        "ai_league_replay.end_winner",
        undefined,
        "Winner",
      );
      headline = winnerRows[0].name;
      headlineSeat = winnerRows[0].seat;
      share = winnerRows[0].share;
      metricLabel = translateText(
        "ai_league_replay.end_of_map",
        undefined,
        "of the map",
      );
    }

    const verdictName =
      kind === "none" || winnerRows.length === 0 ? leaderRow.name : headline;

    const verdict = buildVerdict({
      kind: winnerRows.length === 0 ? "none" : kind,
      name: verdictName,
      share,
      rows,
      field,
      survivors,
      finalTurn,
      trendsTrustworthy: this.sampleCount >= MIN_TREND_SAMPLES,
    });

    const visible = rows.slice(0, Math.max(1, this.maxRows));

    return {
      eyebrow,
      headline,
      headlineSeat,
      metricValue: formatPercentage(share),
      metricLabel,
      verdict,
      rows: visible,
      hiddenRows: rows.length - visible.length,
      categories: buildCategories(rows, denominator),
      field,
      survivors,
      finalTurn,
    };
  }

  private buildRows(
    game: GameView,
    players: PlayerView[],
    denominator: number,
    winnerSet: ReadonlySet<number>,
  ): StandingRow[] {
    const rows = players.map((player): StandingRow => {
      const id = player.smallID();
      const tiles = player.numTilesOwned();
      const share = tiles / denominator;
      const peak = this.peakTiles.get(id) ?? null;
      return {
        rank: 0,
        // Every name on a broadcast surface goes through this: it applies the
        // spectator rebrand AND the "Anonymous Names" setting. Raw
        // displayName() would leak a real agent identity past both.
        name: aiLeagueSpectatorDisplayName(player.displayName()),
        seat: player.territoryColor().toHex(),
        tiles,
        share,
        shareLabel: formatPercentage(share),
        // A dead player's "gold" and "troops" are engine residue — gold zeroes
        // out and maxTroops() falls back to the spawn baseline (10.0K), so
        // twelve eliminated rows all read "0 / 10.0K" and look like
        // placeholder data. An em dash says "no longer in the game" honestly;
        // OUT T# already carries when they left it.
        gold: player.isAlive() ? renderNumber(player.gold()) : "—",
        troops: player.isAlive()
          ? renderTroops(game.config().maxTroops(player))
          : "—",
        alive: player.isAlive(),
        eliminatedAtTurn: this.eliminatedTick.get(id) ?? null,
        peakTiles: peak,
        peakAtTurn: this.peakTick.get(id) ?? null,
        isWinner: winnerSet.has(id),
      };
    });

    // Tournament placement, not a raw territory sort. Every eliminated player
    // is on 0 tiles, so sorting by territory alone would leave the entire lower
    // half in arbitrary Map-insertion order. Surviving > eliminated, then
    // territory, then LAST OUT ranks above first out — which is the ordering a
    // viewer already believes they are looking at.
    rows.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (b.tiles !== a.tiles) return b.tiles - a.tiles;
      const aOut = a.eliminatedAtTurn ?? -1;
      const bOut = b.eliminatedAtTurn ?? -1;
      if (bOut !== aOut) return bOut - aOut;
      const aPeak = a.peakTiles ?? 0;
      const bPeak = b.peakTiles ?? 0;
      if (bPeak !== aPeak) return bPeak - aPeak;
      // Final tie-break keeps the order stable across re-renders.
      return a.name.localeCompare(b.name);
    });

    rows.forEach((row, index) => {
      row.rank = index + 1;
    });
    return rows;
  }

  // --- Render --------------------------------------------------------------

  render() {
    const snapshot = this.snapshot;
    // Renders nothing at all until the match ends — the host element is
    // `:empty` and drops out of the layout, so it cannot shadow the board or
    // eat a hit test during play.
    if (snapshot === null) return html``;

    const finalResult = translateText(
      "ai_league_replay.final_result",
      undefined,
      "Final result",
    );
    const finalTurn = formatTurn(snapshot.finalTurn);
    let footerSummary =
      snapshot.survivors === 0
        ? translateText(
            "ai_league_replay.end_footer_none",
            { field: snapshot.field },
            `${snapshot.field.toLocaleString()} competitors · none left standing`,
          )
        : translateText(
            "ai_league_replay.end_footer_survivors",
            { field: snapshot.field, survivors: snapshot.survivors },
            `${snapshot.field.toLocaleString()} competitors · ${snapshot.survivors.toLocaleString()} still standing`,
          );
    if (snapshot.hiddenRows > 0) {
      footerSummary = translateText(
        "ai_league_replay.end_footer_hidden",
        { summary: footerSummary, count: snapshot.hiddenRows },
        `${footerSummary} · +${snapshot.hiddenRows.toLocaleString()} eliminated earlier`,
      );
    }

    return html`
      <div class="pw-ec-scrim"></div>
      <div class="pw-ec-anchor">
        <section class="pw-ec-card" role="region" aria-label=${finalResult}>
          <header class="pw-ec-topline">
            <span class="pw-ec-eyebrow">${finalResult}</span>
            <span class="pw-ec-eyebrow pw-ec-num"
              >${translateText(
                "ai_league_replay.turn_value",
                { turn: finalTurn },
                `Turn ${finalTurn}`,
              )}</span
            >
          </header>

          <div class="pw-ec-winner">
            <span
              class="pw-ec-seat pw-ec-seat-lg"
              style=${`--seat:${snapshot.headlineSeat ?? "#6f675d"}`}
              aria-hidden="true"
            ></span>
            <div class="pw-ec-winner-text">
              <div class="pw-ec-eyebrow">${snapshot.eyebrow}</div>
              <h2 class="pw-ec-winner-name">${snapshot.headline}</h2>
            </div>
            <div class="pw-ec-winner-metric">
              <div class="pw-ec-metric-value pw-ec-num">
                ${snapshot.metricValue}
              </div>
              <div class="pw-ec-eyebrow">${snapshot.metricLabel}</div>
            </div>
          </div>

          <p class="pw-ec-verdict">${snapshot.verdict}</p>

          ${snapshot.categories.length > 0
            ? html`<div class="pw-ec-cats">
                ${snapshot.categories.map((c) => this.renderCategory(c))}
              </div>`
            : null}
          ${this.renderStandings(snapshot)}

          <footer class="pw-ec-foot">
            <span class="pw-ec-eyebrow">${footerSummary}</span>
            <span class="pw-ec-eyebrow pw-ec-wordmark">Proxy War</span>
          </footer>
          ${this.renderIntegrity()}
        </section>
      </div>
    `;
  }

  private renderCategory(category: CategoryTile): TemplateResult {
    return html`
      <div class="pw-ec-cat">
        <div class="pw-ec-eyebrow">${category.label}</div>
        <div class="pw-ec-cat-body">
          <span
            class="pw-ec-seat"
            style=${`--seat:${category.seat}`}
            aria-hidden="true"
          ></span>
          <span class="pw-ec-cat-name">${category.name}</span>
        </div>
        <div class="pw-ec-cat-value pw-ec-num">${category.value}</div>
      </div>
    `;
  }

  /**
   * DID THE AGENTS ACTUALLY PLAY THIS MATCH?
   *
   * The end card is the frame that gets screenshotted and posted, which makes
   * it the right place for the one number that qualifies everything above it:
   * how many decisions came back from the agents, and how many fell back to a
   * default. On the reference fixture that is 1,262 decisions with 583
   * fallbacks and 525 degraded — so nearly half of what a viewer just watched
   * was not an agent choosing. A results card that reports a winner without
   * that caveat is overstating what it knows.
   *
   * Deliberately the quietest line on the card: it qualifies the result, it
   * does not compete with it. Renders NOTHING when the envelope carries no
   * integrity block — a fabricated "0% fallback" would be far worse than
   * silence, and this product does not render empty containers.
   */
  private renderIntegrity(): TemplateResult | null {
    const integrity = replayIntegrity();
    if (integrity === null) return null;
    return html`<p class="pw-ec-eyebrow pw-ec-integrity">
      ${formatReplayIntegrity(integrity)}
    </p>`;
  }

  private renderStandings(snapshot: EndCardSnapshot): TemplateResult {
    // Sixteen rows stacked vertically is a column that does not fit a 16:9
    // frame. Split into two balanced columns; the CSS collapses back to one
    // when the card is too narrow for the pair.
    const rows = snapshot.rows;
    const split = rows.length > 8 ? Math.ceil(rows.length / 2) : rows.length;
    const columns = [rows.slice(0, split), rows.slice(split)].filter(
      (c) => c.length > 0,
    );

    return html`
      <div
        class=${columns.length > 1
          ? "pw-ec-standings"
          : "pw-ec-standings pw-ec-standings-single"}
      >
        ${columns.map(
          (column) => html`
            <div class="pw-ec-col">
              <div class="pw-ec-row pw-ec-row-head">
                <span class="pw-ec-eyebrow">#</span>
                <span aria-hidden="true"></span>
                <span class="pw-ec-eyebrow"
                  >${translateText(
                    "ai_league_replay.end_competitor",
                    undefined,
                    "Competitor",
                  )}</span
                >
                <span class="pw-ec-eyebrow pw-ec-right"
                  >${translateText(
                    "ai_league_replay.end_map",
                    undefined,
                    "Map",
                  )}</span
                >
                <span class="pw-ec-eyebrow pw-ec-right"
                  >${translateText(
                    "ai_league_replay.end_gold",
                    undefined,
                    "Gold",
                  )}</span
                >
                <span class="pw-ec-eyebrow pw-ec-right"
                  >${translateText(
                    "ai_league_replay.end_troops",
                    undefined,
                    "Troops",
                  )}</span
                >
              </div>
              ${column.map((row) => this.renderRow(row))}
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderRow(row: StandingRow): TemplateResult {
    const classes = [
      "pw-ec-row",
      row.isWinner ? "pw-ec-row-win" : "",
      row.alive ? "" : "pw-ec-row-out",
    ]
      .filter((c) => c !== "")
      .join(" ");

    return html`
      <div
        class=${classes}
        style=${`animation-delay:${Math.min(row.rank, 8) * 26 + 180}ms`}
      >
        <span class="pw-ec-rank pw-ec-num">${row.rank}</span>
        <span
          class="pw-ec-seat"
          style=${`--seat:${row.seat}`}
          aria-hidden="true"
        ></span>
        <span class="pw-ec-name-cell">
          <span class="pw-ec-name">${row.name}</span>
          ${row.alive
            ? null
            : html`<span class="pw-ec-out pw-ec-num"
                >${row.eliminatedAtTurn === null
                  ? translateText("ai_league_replay.end_out", undefined, "out")
                  : translateText(
                      "ai_league_replay.end_out_turn",
                      { turn: formatTurn(row.eliminatedAtTurn) },
                      `out T${formatTurn(row.eliminatedAtTurn)}`,
                    )}</span
              >`}
        </span>
        <span class="pw-ec-cell pw-ec-num"
          >${row.alive ? row.shareLabel : "—"}</span
        >
        <span class="pw-ec-cell pw-ec-num">${row.gold}</span>
        <span class="pw-ec-cell pw-ec-num">${row.troops}</span>
      </div>
    `;
  }
}

// ===========================================================================
// Pure helpers. Kept outside the element so the result logic is testable and
// so nothing here can reach for engine state it was not handed.
// ===========================================================================

/**
 * Resolves the `Winner` tuple to the set of winning players' smallIDs.
 *
 * `winner[0]` discriminates "player" | "team" | "nation"; `undefined` means the
 * match ended with no winner at all.
 */
function resolveWinningPlayers(
  game: GameView,
  winner: Winner,
  players: PlayerView[],
): ReadonlySet<number> {
  const ids = new Set<number>();
  if (winner === undefined) return ids;

  if (winner[0] === "team") {
    const team = winner[1];
    for (const player of players) {
      if (player.team() === team) ids.add(player.smallID());
    }
    return ids;
  }

  if (winner[0] === "player") {
    const found = game.playerByClientID(winner[1]);
    if (found !== null) ids.add(found.smallID());
    return ids;
  }

  // "nation": `GameImpl.makeWinner()` puts `winner.name()` in slot 1 for any
  // winner without a clientID — i.e. every AI agent in a rendered replay.
  // Match on name first.
  const name = winner[1];
  for (const player of players) {
    if (player.name() === name) {
      ids.add(player.smallID());
      return ids;
    }
  }

  // Fallback: `PlayerView.name()` is itself anonymised when the "Anonymous
  // Names" setting is on, while the update payload carries the server-side real
  // name, so the match above can legitimately miss. A conquest win is by
  // definition held by the player with the most land at this instant, so the
  // territory leader is the correct — and only — safe inference. If even that
  // is empty the caller falls back to the honest "No winner" headline.
  let leader: PlayerView | null = null;
  for (const player of players) {
    if (leader === null || player.numTilesOwned() > leader.numTilesOwned()) {
      leader = player;
    }
  }
  if (leader !== null && leader.numTilesOwned() > 0) ids.add(leader.smallID());
  return ids;
}

/**
 * Category breakdown. Three columns always exist because they are read straight
 * off the final board. The fourth is earned: it reports a real collapse when
 * the sampler saw one, otherwise the high-water mark, otherwise nothing —
 * rather than padding the row with a repeat of the territory leader.
 */
function buildCategories(
  rows: StandingRow[],
  denominator: number,
): CategoryTile[] {
  if (rows.length === 0) return [];

  const tiles: CategoryTile[] = [];

  const territory = rows[0]; // rows are already ranked by placement
  tiles.push({
    label: translateText(
      "ai_league_replay.end_most_territory",
      undefined,
      "Most territory",
    ),
    name: territory.name,
    seat: territory.seat,
    value: territory.shareLabel,
  });

  // Gold and troops are pre-formatted strings on the row, so rank on a parsed
  // ordering rather than on the display text.
  const byGold = maxBy(rows, (r) => parseCompact(r.gold));
  if (byGold !== null) {
    tiles.push({
      label: translateText(
        "ai_league_replay.end_deepest_treasury",
        undefined,
        "Deepest treasury",
      ),
      name: byGold.name,
      seat: byGold.seat,
      value: byGold.gold,
    });
  }

  const byTroops = maxBy(rows, (r) => parseCompact(r.troops));
  if (byTroops !== null) {
    tiles.push({
      label: translateText(
        "ai_league_replay.end_largest_army",
        undefined,
        "Largest army",
      ),
      name: byTroops.name,
      seat: byTroops.seat,
      value: byTroops.troops,
    });
  }

  const collapse = findCollapse(rows, denominator, null);
  if (collapse !== null) {
    tiles.push({
      label: translateText(
        "ai_league_replay.end_biggest_collapse",
        undefined,
        "Biggest collapse",
      ),
      name: collapse.row.name,
      seat: collapse.row.seat,
      value: `−${renderNumber(collapse.lost)}`,
    });
    return tiles;
  }

  const byPeak = maxBy(rows, (r) => r.peakTiles ?? -1);
  if (byPeak !== null && (byPeak.peakTiles ?? 0) > 0) {
    tiles.push({
      label: translateText(
        "ai_league_replay.end_high_water_mark",
        undefined,
        "High-water mark",
      ),
      name: byPeak.name,
      seat: byPeak.seat,
      value: formatPercentage((byPeak.peakTiles ?? 0) / denominator),
    });
  }
  return tiles;
}

interface Collapse {
  row: StandingRow;
  peak: number;
  lost: number;
  turns: number;
}

/**
 * The largest genuine collapse among non-winners, or null when nothing on the
 * board qualifies. Every guard here exists so the card cannot narrate a
 * dramatic fall that did not happen.
 */
function findCollapse(
  rows: StandingRow[],
  denominator: number,
  finalTurn: number | null,
): Collapse | null {
  let best: Collapse | null = null;
  for (const row of rows) {
    if (row.isWinner) continue;
    const peak = row.peakTiles;
    const peakTurn = row.peakAtTurn;
    if (peak === null || peakTurn === null) continue;
    if (peak / denominator < COLLAPSE_MIN_PEAK_SHARE) continue;
    if (peak < Math.max(row.tiles, 1) * COLLAPSE_MIN_RATIO) continue;

    const end = finalTurn ?? row.eliminatedAtTurn ?? peakTurn;
    const turns = Math.max(0, end - peakTurn);
    if (finalTurn !== null && turns < COLLAPSE_MIN_TURNS) continue;

    const lost = peak - row.tiles;
    if (best === null || lost > best.lost) {
      best = { row, peak, lost, turns };
    }
  }
  return best;
}

/**
 * THE ONE LINE A NON-EXPERT READS.
 *
 * It must be true before it is dramatic. A 22% win on a shattered board is a
 * 22% win, and this says so — reading strength off a struggling board is the
 * specific failure this function exists to prevent. Every clause below is
 * derived from numbers on the card, so a viewer can check it against the rows.
 */
function buildVerdict(ctx: VerdictContext): string {
  const runnerUp = ctx.rows.find((r) => !r.isWinner) ?? null;
  const runnerUpShare = runnerUp?.share ?? 0;
  const margin = ctx.share - runnerUpShare;
  const pct = formatPercentage(ctx.share);

  if (ctx.kind === "none") {
    const turn = formatTurn(ctx.finalTurn);
    return translateText(
      "ai_league_replay.verdict_no_winner",
      {
        name: ctx.name,
        share: pct,
        survivors: ctx.survivors,
        field: ctx.field,
        turn,
      },
      `No one closed it out — ${ctx.name} finishes on top with ${pct} of the map, ${ctx.survivors.toLocaleString()} of ${ctx.field.toLocaleString()} still standing after ${turn} turns.`,
    );
  }

  const subject =
    ctx.kind === "team"
      ? translateText(
          "ai_league_replay.verdict_team_subject",
          { name: ctx.name },
          `Team ${ctx.name}`,
        )
      : ctx.name;

  let head: string;
  let marginUsed = false;
  if (ctx.share >= SHARE_DOMINANT) {
    head = translateText(
      "ai_league_replay.verdict_dominant",
      { subject, share: pct },
      `${subject} takes it with ${pct} of the map`,
    );
  } else if (ctx.share >= SHARE_SOLID) {
    head = translateText(
      "ai_league_replay.verdict_solid",
      { subject, share: pct },
      `${subject} wins on ${pct} of the map`,
    );
  } else if (runnerUp !== null && margin < MARGIN_NARROW) {
    // Narrow AND small: the win was survival, not conquest. Say both.
    const marginLabel = formatPercentage(Math.max(margin, 0));
    head = translateText(
      "ai_league_replay.verdict_narrow",
      {
        subject,
        share: pct,
        margin: marginLabel,
        runnerUp: runnerUp.name,
      },
      `${subject} scrapes in on just ${pct} of the map, ${marginLabel} clear of ${runnerUp.name}`,
    );
    marginUsed = true;
  } else {
    head = translateText(
      "ai_league_replay.verdict_limp",
      { subject, share: pct },
      `${subject} limps in on just ${pct} of the map`,
    );
  }

  const tail =
    (ctx.trendsTrustworthy ? collapseClause(ctx) : null) ??
    (marginUsed ? null : marginClause(runnerUp, margin)) ??
    survivalClause(ctx);

  return tail === null
    ? translateText("ai_league_replay.verdict_complete", { head }, `${head}.`)
    : translateText(
        "ai_league_replay.verdict_complete_with_tail",
        { head, tail },
        `${head} — ${tail}.`,
      );
}

function collapseClause(ctx: VerdictContext): string | null {
  // Denominator recovered from any row with a non-zero share; the rows already
  // carry share = tiles / denominator, so this avoids threading it through.
  const scale = ctx.rows.find((r) => r.share > 0 && r.tiles > 0);
  if (scale === undefined) return null;
  const denominator = scale.tiles / scale.share;

  const collapse = findCollapse(ctx.rows, denominator, ctx.finalTurn);
  if (collapse === null) return null;

  const peak = renderNumber(collapse.peak);
  if (collapse.row.tiles === 0) {
    const turns = formatTurn(collapse.turns);
    return translateText(
      "ai_league_replay.verdict_collapse_gone",
      { name: collapse.row.name, peak, turns },
      `${collapse.row.name} peaked at ${peak} tiles and was gone ${turns} turns later`,
    );
  }
  const current = renderNumber(collapse.row.tiles);
  const turns = formatTurn(collapse.turns);
  return translateText(
    "ai_league_replay.verdict_collapse",
    { name: collapse.row.name, peak, current, turns },
    `${collapse.row.name} collapsed from ${peak} tiles to ${current} over ${turns} turns`,
  );
}

function marginClause(
  runnerUp: StandingRow | null,
  margin: number,
): string | null {
  if (runnerUp === null) return null;
  if (margin >= MARGIN_NARROW * 2) return null;
  const marginLabel = formatPercentage(Math.max(margin, 0));
  return translateText(
    "ai_league_replay.verdict_margin",
    { margin: marginLabel, runnerUp: runnerUp.name },
    `only ${marginLabel} of the map clear of ${runnerUp.name}`,
  );
}

function survivalClause(ctx: VerdictContext): string {
  const turn = formatTurn(ctx.finalTurn);
  if (ctx.survivors <= 1) {
    return translateText(
      "ai_league_replay.verdict_last_standing",
      { field: ctx.field, turn },
      `the last of ${ctx.field.toLocaleString()} left standing after ${turn} turns`,
    );
  }
  return translateText(
    "ai_league_replay.verdict_still_standing",
    { survivors: ctx.survivors, field: ctx.field, turn },
    `${ctx.survivors.toLocaleString()} of ${ctx.field.toLocaleString()} still standing at turn ${turn}`,
  );
}

function maxBy<T>(items: T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      bestScore = value;
      best = item;
    }
  }
  return best;
}

/**
 * Parses `renderNumber`'s compact output ("1.20K", "12.4M") back to a number,
 * purely for RANKING the category tiles. The card always displays the original
 * formatted string, so the rounding baked into the compact form never reaches
 * the viewer as a wrong figure — only, at worst, as a tie broken one way rather
 * than the other.
 */
function parseCompact(value: string): number {
  const match = /^(-?[\d.]+)([KM]?)$/.exec(value.trim());
  if (match === null) return -1;
  const base = Number(match[1]);
  if (Number.isNaN(base)) return -1;
  if (match[2] === "K") return base * 1_000;
  if (match[2] === "M") return base * 1_000_000;
  return base;
}

/** Turn counts are read as counts, not magnitudes: "1,204", never "1.20K". */
function formatTurn(turn: number): string {
  return Math.max(0, Math.round(turn)).toLocaleString();
}

// ===========================================================================
// Styles
// ===========================================================================

const REPLAY_END_CARD_STYLE_ID = "replay-end-card-styles";

/**
 * Injected into <head> once, matching the way `GameRenderer` mounts the
 * broadcast skin. It cannot live in `static styles` because that only applies
 * inside a shadow root, and this element is deliberately light-DOM (see
 * `createRenderRoot`). Every selector is prefixed with the tag name, so this is
 * scoped in practice despite being a global sheet.
 *
 * ART DIRECTION — the same lock as the rest of the broadcast: warm near-black
 * glass, amber as the single accent, hazard reserved for elimination, seat
 * colour held to each competitor as identity, tabular mono for every numeral,
 * uppercase letterspaced eyebrows that label without competing. Never pure
 * #000/#fff. Every token carries its literal fallback so the card is still
 * correct on a replay surface that has not set `.ai-league-native-spectator-ui`.
 */
function mountReplayEndCardStyles() {
  if (document.getElementById(REPLAY_END_CARD_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = REPLAY_END_CARD_STYLE_ID;
  style.textContent = `
    replay-end-card {
      position: fixed;
      inset: 0;
      display: block;
      /* Above the broadcast chrome (drawer 50010, scorebug 50002) because the
       * result is the last thing on screen and nothing may sit over it. */
      z-index: 50040;
      /* PURELY VISUAL. The card offers no navigation and must never intercept
       * a click meant for the board or the replay scrubber underneath. */
      pointer-events: none;
      font-family: var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      color: var(--pw-ink, #f2ece2);
      contain: layout style;
    }
    /* Nothing rendered until the match ends: no stacking context, no cost. */
    replay-end-card:empty { display: none; }

    @keyframes pw-ec-scrim-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pw-ec-rise {
      from { opacity: 0; transform: translate3d(0, 16px, 0) scale(0.985); }
      to { opacity: 1; transform: none; }
    }
    @keyframes pw-ec-row-in {
      from { opacity: 0; transform: translate3d(0, 5px, 0); }
      to { opacity: 1; transform: none; }
    }

    /* Vignette, not a blackout: the final board stays legible around the card,
     * which is the frame the card is describing. */
    replay-end-card .pw-ec-scrim {
      position: absolute;
      inset: 0;
      background: radial-gradient(
        125% 95% at 50% 50%,
        rgba(20, 17, 15, 0.90) 0%,
        rgba(20, 17, 15, 0.74) 42%,
        rgba(20, 17, 15, 0.30) 76%,
        rgba(20, 17, 15, 0) 100%
      );
      /* 'both' + no timer: it fades in and HOLDS. Nothing removes this. */
      animation: pw-ec-scrim-in 520ms cubic-bezier(0.2, 0.7, 0.25, 1) both;
    }

    /* Anchor owns the centring transform so the card's own transform is free
     * for the entrance animation (one element cannot hold both). */
    replay-end-card .pw-ec-anchor {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
    }

    replay-end-card .pw-ec-card {
      position: relative;
      box-sizing: border-box;
      width: min(760px, calc(100vw - 40px));
      max-height: calc(100vh - 40px);
      overflow: hidden;
      padding: 20px 24px 16px;
      background: var(--pw-panel, rgba(24, 20, 17, 0.82));
      backdrop-filter: blur(14px) saturate(115%);
      -webkit-backdrop-filter: blur(14px) saturate(115%);
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border-radius: 12px;
      box-shadow:
        0 26px 74px rgba(0, 0, 0, 0.55),
        inset 0 1px 0 rgba(242, 236, 226, 0.05);
      animation: pw-ec-rise 620ms cubic-bezier(0.2, 0.7, 0.25, 1) both;
    }
    /* Single amber rule: the one accent, used once, at the top of the card. */
    replay-end-card .pw-ec-card::before {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      height: 2px;
      background: linear-gradient(
        90deg,
        var(--pw-accent, #ffc24a),
        rgba(255, 194, 74, 0)
      );
    }

    replay-end-card .pw-ec-eyebrow {
      display: block;
      font-size: 9px;
      font-weight: 700;
      line-height: 1.4;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--pw-ink-faint, #6f675d);
    }
    replay-end-card .pw-ec-num {
      font-family: var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      font-variant-numeric: tabular-nums;
    }

    replay-end-card .pw-ec-topline {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 11px;
      border-bottom: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
    }

    replay-end-card .pw-ec-winner {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 14px;
      padding: 15px 0 0;
    }
    /* Seat colour is identity: the same fill the board paints this player with,
     * carried onto every mention of them. */
    replay-end-card .pw-ec-seat {
      display: inline-block;
      width: 3px;
      height: 11px;
      border-radius: 2px;
      background: var(--seat, #6f675d);
      flex: none;
    }
    replay-end-card .pw-ec-seat-lg {
      width: 4px;
      height: 46px;
      box-shadow: 0 0 20px -4px var(--seat, #6f675d);
    }
    replay-end-card .pw-ec-winner-name {
      margin: 2px 0 0;
      /* The blur-test winner. At 34px the champion's name blurred into the
       * same grey mass as the stat strip; the finale must be readable as a
       * headline from across a room. */
      font-size: clamp(34px, 4.6vw, 46px);
      font-weight: 700;
      line-height: 1.05;
      letter-spacing: 0.012em;
      text-transform: uppercase;
      color: var(--pw-ink, #f2ece2);
      overflow-wrap: anywhere;
    }
    replay-end-card .pw-ec-winner-metric { text-align: right; }
    replay-end-card .pw-ec-metric-value {
      font-size: 40px;
      font-weight: 700;
      line-height: 1;
      color: var(--pw-accent, #ffc24a);
    }
    replay-end-card .pw-ec-winner-metric .pw-ec-eyebrow { margin-top: 4px; }

    replay-end-card .pw-ec-verdict {
      margin: 12px 0 0;
      max-width: 64ch;
      font-size: 14px;
      line-height: 1.5;
      color: var(--pw-ink-dim, #a79e92);
    }

    /* Hairline-gap grid: the 1px gaps ARE the rules, so no per-tile borders. */
    replay-end-card .pw-ec-cats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
      gap: 1px;
      margin-top: 15px;
      background: var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border-radius: 8px;
      overflow: hidden;
    }
    replay-end-card .pw-ec-cat {
      /* Near-panel: the strip is reference material, not a second headline. */
      background: rgba(26, 22, 19, 0.55);
      padding: 8px 11px 9px;
      min-width: 0;
    }
    replay-end-card .pw-ec-cat-body {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 5px;
      min-width: 0;
    }
    replay-end-card .pw-ec-cat-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--pw-ink, #f2ece2);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    replay-end-card .pw-ec-cat-value {
      margin-top: 2px;
      font-size: 15px;
      font-weight: 700;
      color: var(--pw-ink-dim, #a79e92);
    }

    replay-end-card .pw-ec-standings {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 26px;
      margin-top: 15px;
    }
    /* A short field (<= 8) is one column; two would leave half the card empty. */
    replay-end-card .pw-ec-standings-single { grid-template-columns: 1fr; }
    replay-end-card .pw-ec-col { min-width: 0; }
    replay-end-card .pw-ec-row {
      display: grid;
      grid-template-columns: 17px 3px minmax(0, 1fr) 50px 48px 46px;
      align-items: center;
      gap: 0 8px;
      padding: 3px 6px 3px 4px;
      border-radius: 3px;
      border-bottom: 1px solid rgba(242, 236, 226, 0.045);
      font-size: 12px;
      color: var(--pw-ink-dim, #a79e92);
      animation: pw-ec-row-in 380ms cubic-bezier(0.2, 0.7, 0.25, 1) both;
    }
    replay-end-card .pw-ec-row-head {
      border-bottom-color: var(--pw-hairline, rgba(242, 236, 226, 0.11));
      padding-bottom: 5px;
      animation-delay: 140ms;
    }
    replay-end-card .pw-ec-rank { color: var(--pw-ink-faint, #6f675d); }
    replay-end-card .pw-ec-name-cell {
      display: flex;
      align-items: baseline;
      gap: 7px;
      min-width: 0;
    }
    replay-end-card .pw-ec-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    replay-end-card .pw-ec-cell { text-align: right; }
    replay-end-card .pw-ec-right { text-align: right; }

    /* THE WINNER WINS THE SQUINT TEST. Every other row is data; this one is
     * the result. */
    replay-end-card .pw-ec-row-win {
      color: var(--pw-ink, #f2ece2);
      font-weight: 700;
      background: linear-gradient(
        90deg,
        rgba(255, 194, 74, 0.16),
        rgba(255, 194, 74, 0)
      );
    }
    replay-end-card .pw-ec-row-win .pw-ec-rank { color: var(--pw-accent, #ffc24a); }

    /* Eliminated: struck through and recessive, but STILL PRESENT. A dead
     * competitor is a result, not an omission. */
    /* Recessive but LEGIBLE: #6f675d measured 2.47:1 against the panel —
     * ranks 9-16 were disappearing. Dim is a relationship, not an absence. */
    replay-end-card .pw-ec-row-out { color: #9a9186; }
    replay-end-card .pw-ec-row-out .pw-ec-seat { opacity: 0.34; }
    replay-end-card .pw-ec-row-out .pw-ec-name {
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      text-decoration-color: rgba(242, 236, 226, 0.3);
    }
    /* Hazard is reserved for elimination — the only other hue on the card. */
    replay-end-card .pw-ec-out {
      flex: none;
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--pw-hazard, #ff6b4a);
      opacity: 0.75;
    }

    /* Quietest line on the card, sitting under the footer rule: it qualifies
     * the result rather than competing with it. Same eyebrow recipe as the
     * footer, one step further down in ink. */
    replay-end-card .pw-ec-integrity {
      margin: 7px 0 0;
      color: var(--pw-ink-faint, #6f675d);
      font-variant-numeric: tabular-nums;
    }
    replay-end-card .pw-ec-foot {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-top: 13px;
      padding-top: 10px;
      border-top: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
    }
    replay-end-card .pw-ec-wordmark { letter-spacing: 0.28em; }

    /* Narrow: one standings column rather than two 90px-wide ones. */
    @media (max-width: 640px) {
      replay-end-card .pw-ec-standings { grid-template-columns: 1fr; }
    }
    /* Short frames. The broadcast's stated floor is a 640x360 embed, where the
     * card has ~320px of usable height: shed the category strip (the standings
     * carry the same facts) before shedding the result or the verdict. */
    @media (max-height: 700px) {
      replay-end-card .pw-ec-card { padding: 15px 18px 12px; }
      replay-end-card .pw-ec-winner { padding-top: 11px; }
      replay-end-card .pw-ec-verdict { font-size: 13px; margin-top: 9px; }
      replay-end-card .pw-ec-row { font-size: 11px; padding-top: 2px; padding-bottom: 2px; }
    }
    @media (max-height: 470px) {
      replay-end-card .pw-ec-cats { display: none; }
      replay-end-card .pw-ec-seat-lg { height: 34px; }
      replay-end-card .pw-ec-winner-name { font-size: 22px; }
      replay-end-card .pw-ec-metric-value { font-size: 21px; }
    }

    /* Motion is decoration here; the held end state is the content. */
    @media (prefers-reduced-motion: reduce) {
      replay-end-card .pw-ec-scrim,
      replay-end-card .pw-ec-card,
      replay-end-card .pw-ec-row {
        animation-duration: 1ms !important;
        animation-delay: 0ms !important;
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Creates, mounts and returns the end card as a `Layer`, or an empty list on a
 * live game.
 *
 * Returns an array so the call site is a single spread inside `GameRenderer`'s
 * `layers` list and the surface gate lives HERE rather than being re-derived by
 * every caller: `isAiLeagueReplayRoute()` covers every watched surface
 * (premiere, ai-league-replay, proxywar-replay, the legacy openfront-replay
 * links, the Coworld routes, and the static replay bundle). A live game keeps
 * `WinModal`; a replay gets this. `ReplayEndCard.showResult()` re-checks the
 * `ai-league-replay-mode` body class at the moment of the win — the exact
 * condition under which `WinModal` is hidden — so the two can never both be on
 * screen and the match can never end with neither.
 */
export function mountReplayEndCard(game: GameView): Layer[] {
  if (!isAiLeagueReplayRoute()) return [];
  // BACKSTOP, NOT THE TEARDOWN. `ReplayEndCard.dispose()` is what takes the
  // card and its body class off now, and it runs on every way out of a game.
  // These two lines stay because they cover the one case dispose() cannot: two
  // `openAiLeagueReplay` attempts racing over one document, where the loser's
  // renderer is never stopped and so never disposes (Main.ts documents that
  // race on its module-level `rewindInFlight` guard). Removing a node that is
  // already gone, and a class that is already off, both cost nothing.
  document.querySelector("replay-end-card")?.remove();
  // The class goes with the element. pw-endcard-open stands the ENTIRE HUD
  // down (scorebug, scrubber, toasts, dossier, chip), so orphaning it means
  // the next match plays on a bare board.
  document.body.classList.remove("pw-endcard-open");
  const card = document.createElement("replay-end-card") as ReplayEndCard;
  card.game = game;
  document.body.appendChild(card);
  return [card];
}
