import { EventBus } from "../../../core/EventBus";
import { PlayerType, UnitType } from "../../../core/game/Game";
import { GameView, PlayerView } from "../../../core/game/GameView";
import {
  aiLeagueSpectatorDisplayName,
  isAiLeagueReplayRoute,
} from "../../AiLeagueReplayMode";
import {
  formatReplayActionKind,
  lastDecisionFor,
  statedReason,
} from "../../ReplayDecisionStore";
import {
  formatPercentage,
  renderDuration,
  renderNumber,
  renderTroops,
  translateText,
} from "../../Utils";
import { TransformHandler } from "../TransformHandler";
import { followedCompetitorSmallId } from "./FollowedCompetitor";
import { Layer } from "./Layer";

/**
 * ============================================================================
 * NATION DOSSIER — everything the board knows about the nation you picked.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Selecting a nation used to produce a 9px chip in the bottom-right corner
 * reading "FOLLOWING · NAME" and nothing else. Every fact a viewer would
 * actually ask on picking a side — how much of the map is theirs, who they are
 * allied to and for how much longer, who is shooting at them right now, what
 * they have built — was either buried in a 16-row table that shows three
 * columns, or not on screen at all. The click was a state change with no
 * payload.
 *
 * This is the payload. One panel, one nation, only facts that exist.
 *
 * THE LEFT LANE, MEASURED RATHER THAN GUESSED
 * --------------------------------------------
 * Every other edge of this stage is spoken for: scorebug top-left, transport
 * cluster top-right, toasts bottom-right, scrubber along the bottom, nuke
 * alert top-centre. The only free lane is the left band UNDER the scorebug —
 * and where that lane starts is not a constant. The scorebug is 16 rows at
 * 1280w, scales with --pw-hud-scale, gets a transform: scale() under 900w, and
 * is capped to a 396px scroller when the political radio is open. Any
 * hand-tuned top offset is wrong in at least three of those states.
 *
 * So the dock measures the scorebug's real bottom edge every sample and pins
 * itself under it. getBoundingClientRect() reports post-zoom, post-transform
 * on-screen pixels, which is exactly the number this needs.
 *
 * ...AND THE HEIGHT IS A BUDGET, NOT A WISH
 * ------------------------------------------
 * The same measurement gives the panel its ceiling: viewport minus the dock
 * top minus the bottom chrome. At 1280x720 with a full 16-seat scorebug that
 * can be under 200px, which is less than a fully-populated dossier wants. So
 * the panel renders everything it has and then TRIMS from the bottom up —
 * lowest-value line first — until it fits. Nothing is ever clipped, and
 * nothing is ever padded out: the panel is exactly as tall as the facts it
 * can afford to tell.
 *
 * This is also why, unlike the scorebug, the small-viewport rules here shrink
 * type and padding instead of applying transform: scale(). A transform would
 * make the panel's own height measurement disagree with its on-screen size,
 * and the budget is only worth anything while it is honest.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW
 * -----------------------------------
 * Zeroes. A nation with no navy has no NAVY line; a nation with no allies has
 * no ALLIED block. "0" and "None" are the two ways a panel lies about having
 * something to say, and this stage's rule is that a panel never renders empty
 * — which has to apply per section or it means nothing.
 *
 * PLAYER-VS-PLAYER, NEVER PLAYER-VS-ME
 * -------------------------------------
 * myPlayer() is null for a replay spectator, so every relationship here is
 * computed between two competitors. "At war with" in particular is
 * bidirectional and is NOT readable from one player's own record: a nation
 * being invaded may hold no target of its own. It is the union of this
 * nation's targets, everyone whose targets include it, and everyone with a
 * live attack in either direction.
 *
 * LIVE PLAY IS UNTOUCHED
 * ----------------------
 * mountNationDossier() returns [] off the replay route, so nothing here is
 * constructed, mounted or ticked during a live game.
 */

/**
 * How often the dossier re-reads the game.
 *
 * The expensive part is the unit sweep, which is O(all units on the board), so
 * this does not want to run at frame rate — the scorebug settles for 1000ms
 * for the same reason. But a SELECTION must feel instant, so a change of
 * followed nation bypasses the throttle entirely (see tick()). What this
 * interval actually governs is the steady-state refresh of a panel the viewer
 * is already reading, where a third of a second of lag is invisible.
 */
const SAMPLE_MS = 380;

/** Breathing room between the scorebug's bottom edge and the dock. */
const GAP_UNDER_SCOREBUG = 10;

/**
 * Bottom chrome the dock must never reach into: the scrubber owns bottom:14px
 * and stands ~34px tall, plus a margin so the panel does not crowd it.
 */
const BOTTOM_RESERVE = 74;

/**
 * Where the dock sits when there is no scorebug to measure — the native
 * spectator skin can be switched off with ?native-spectator-ui=0, and then the
 * whole left lane is free from the top down.
 */
const FALLBACK_TOP = 16;

/**
 * Below this many pixels of lane the panel does not open at all. At the
 * 640x360 embed floor the scorebug can leave less room than the identity block
 * alone needs, and a dossier trimmed past its own name is worse than no
 * dossier: the FOLLOWING chip is left in place to carry the selection instead
 * (see the body.pw-dossier-on rule in the stylesheet).
 */
const MIN_BUDGET = 132;

/** Longest ally / war lists before they collapse into a "+N more" line. */
const MAX_ALLY_ROWS = 3;
const MAX_WAR_ROWS = 4;

/**
 * Longest stated reason / plan objective the decision section will quote.
 * The artifact bounds these at 1000 chars (replayUiTextLimit), which is a
 * paragraph — far more than a side panel owes a single line. Truncated in the
 * SNAPSHOT rather than by CSS clamp because the trim budget measures real
 * heights, and a clamped element lies to that measurement the same way a
 * transform would.
 */
const MAX_DECISION_TEXT = 160;

/** Ten engine ticks to the wall-clock second — the constant every timer here uses. */
const TICKS_PER_SECOND = 10;

/**
 * The unit classes worth naming on a broadcast, in the order a viewer reads
 * them: what the nation has built, then what it has floating.
 *
 * Counts are of COMPLETED units, not totalUnitLevels(). Levels are upgrades,
 * and a level-3 city is still one city on the map — reporting "3 cities" for
 * something a viewer can see is one dot would make the panel disagree with the
 * board it is describing.
 */
const FORCE_TYPES: {
  type: UnitType;
  key: string;
  one: string;
  many: string;
}[] = [
  { type: UnitType.City, key: "city", one: "city", many: "cities" },
  {
    type: UnitType.Factory,
    key: "factory",
    one: "factory",
    many: "factories",
  },
  { type: UnitType.Port, key: "port", one: "port", many: "ports" },
  {
    type: UnitType.MissileSilo,
    key: "missile_silo",
    one: "missile silo",
    many: "missile silos",
  },
  {
    type: UnitType.SAMLauncher,
    key: "sam_site",
    one: "SAM site",
    many: "SAM sites",
  },
  {
    type: UnitType.DefensePost,
    key: "defense_post",
    one: "defense post",
    many: "defense posts",
  },
  {
    type: UnitType.Warship,
    key: "warship",
    one: "warship",
    many: "warships",
  },
  {
    type: UnitType.TradeShip,
    key: "trade_ship",
    one: "trade ship",
    many: "trade ships",
  },
  {
    type: UnitType.TransportShip,
    key: "transport",
    one: "transport",
    many: "transports",
  },
];

/**
 * PlayerType as a broadcast reads it.
 *
 * HUMAN is the engine's word for "connected as a client", which is what every
 * league agent is — calling one a human on screen would be actively wrong, and
 * this surface already calls them competitors everywhere else. BOT is the
 * engine's filler nation, and telling those apart from the entrants is real
 * information a viewer cannot get anywhere else on this stage.
 */
const KIND_LABEL: Record<PlayerType, { key: string; fallback: string }> = {
  [PlayerType.Human]: { key: "competitor", fallback: "COMPETITOR" },
  [PlayerType.Bot]: { key: "bot_nation", fallback: "BOT NATION" },
  [PlayerType.Nation]: { key: "nation", fallback: "NATION" },
};

interface Fact {
  value: string;
  unit: string;
}

interface Row {
  name: string;
  value: string;
  /** Amber: an alliance inside its expiry window. */
  warn: boolean;
}

/**
 * The followed nation's most recent SAMPLED decision — the agent's own stated
 * WHY, which no other fact on this panel carries. `reason` is null for a
 * fallback/no-reason decision and the line is then omitted entirely (a panel
 * never renders an empty line); `objective` is the agent's standing plan when
 * it stated one.
 */
interface DecisionNote {
  kind: string;
  turn: number;
  reason: string | null;
  objective: string | null;
}

interface Snapshot {
  name: string;
  seat: string;
  rim: string;
  alive: boolean;
  rank: number;
  field: number;
  share: string;
  tiles: number;
  standing: Fact[];
  decision: DecisionNote | null;
  forces: Fact[];
  expansion: string | null;
  allies: Row[];
  moreAllies: number;
  wars: Row[];
  moreWars: number;
  traitor: string | null;
  record: Fact[];
  kind: string;
  disconnected: boolean;
}

export class NationDossier implements Layer {
  private panel: HTMLElement | null = null;
  private lastKey = "";
  private lastFollowed: number | null = null;
  private lastSampleMs = 0;
  /** Pixels of lane available below the scorebug; see layout(). */
  private budget = 0;
  private lastTopPx = -1;

  constructor(private game: GameView) {}

  init() {
    mountNationDossierStyles();
    // IDEMPOTENT MOUNT. An in-place rewind rebuilds the game without a page
    // reload, so init() runs again against a document that still holds the
    // previous instance's node — and the old one would sit there frozen
    // forever, because its layer is no longer ticked. Same fix, same reason as
    // WarRoomToasts.
    document.querySelector(".pw-dossier")?.remove();
    // The chip-suppressing body class belongs to a panel that no longer
    // exists; leaving it set would hide the FOLLOWING chip for a game that has
    // nothing to hide it behind.
    document.body.classList.remove("pw-dossier-on");
    const panel = document.createElement("aside");
    panel.className = "pw-dossier";
    panel.dataset.on = "0";
    document.body.appendChild(panel);
    this.panel = panel;
  }

  /**
   * Ticks every frame, works every SAMPLE_MS — except when the SELECTION
   * changed, which is the one thing a viewer is watching for and which must
   * never wait on a poll interval.
   */
  tick() {
    const panel = this.panel;
    if (panel === null) return;

    const followed = followedCompetitorSmallId();
    const now = performance.now();
    const switched = followed !== this.lastFollowed;
    if (!switched && now - this.lastSampleMs < SAMPLE_MS) return;
    this.lastFollowed = followed;
    this.lastSampleMs = now;

    if (followed === null) {
      this.close(panel);
      return;
    }
    const player = this.resolve(followed);
    if (player === null) {
      this.close(panel);
      return;
    }

    this.layout(panel);
    if (this.budget < MIN_BUDGET) {
      this.close(panel);
      return;
    }

    const snapshot = this.sample(player);
    // The diff key. A snapshot is ~20 plain fields and nothing else, so
    // stringifying it is both the cheapest honest comparison and the one that
    // cannot silently miss a field somebody adds later. The budget is folded in
    // (bucketed, so a one-pixel reflow is not a re-render) because the same
    // facts trim differently at a different height.
    const key = `${JSON.stringify(snapshot)}|${Math.round(this.budget / 16)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.paint(panel, snapshot);
  }

  /**
   * Resolve the followed nation WITHOUT game.playerBySmallID().
   *
   * That accessor THROWS on an unknown id rather than returning undefined
   * (the `small id N not found` path in GameView), and a scrub back past a
   * nation's spawn leaves exactly that: a followed id the current tick has
   * never heard of. A throw inside tick() takes the whole renderer's layer
   * loop with it. Sixteen seats make a linear scan free.
   */
  private resolve(smallId: number): PlayerView | null {
    for (const player of this.game.playerViews()) {
      if (player.smallID() === smallId) return player;
    }
    return null;
  }

  private close(panel: HTMLElement) {
    if (panel.dataset.on === "0") return;
    panel.dataset.on = "0";
    panel.replaceChildren();
    document.body.classList.remove("pw-dossier-on");
    this.lastKey = "";
  }

  /**
   * Pin the dock under the real scorebug and work out how much lane is left.
   * See the class doc for why both numbers are measured rather than declared.
   */
  private layout(panel: HTMLElement) {
    const scorebug = document.querySelector(
      "leader-board.ai-league-native-leaderboard",
    );
    let top = FALLBACK_TOP;
    if (scorebug !== null) {
      const rect = scorebug.getBoundingClientRect();
      // A hidden scorebug (the end card hides it) measures as a zero box at
      // the origin, which would drag the dock to the top of the frame. Only a
      // laid-out box is worth trusting.
      if (rect.height > 0) top = rect.bottom + GAP_UNDER_SCOREBUG;
    }
    top = Math.round(top);
    const budget = window.innerHeight - top - BOTTOM_RESERVE;
    // Both are written together, and only on a real change: a resize that only
    // shortens the window leaves the dock's top where it was but changes the
    // budget under it, and writing style on every sample would invalidate
    // layout ~3 times a second for nothing.
    if (top === this.lastTopPx && budget === this.budget) return;
    this.lastTopPx = top;
    this.budget = budget;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(0, budget)}px`;
  }

  // ------------------------------------------------------------------ data

  private sample(player: PlayerView): Snapshot {
    const game = this.game;
    const alive = player.isAlive();
    const tiles = player.numTilesOwned();

    // Rank among the LIVING, sorted by territory — the same field and the same
    // ordering the scorebug shows, so a viewer reading "RANK 3" here can find
    // the same nation third from the top up there. Two different rankings of
    // the same match on one screen would be a defect, not a feature.
    const living = game
      .playerViews()
      .filter((p) => p.isAlive())
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
    const rank = living.findIndex((p) => p.smallID() === player.smallID()) + 1;

    // Fallout tiles belong to nobody and are excluded from the denominator, so
    // the shares of every nation still add up after a strike. Copied from the
    // scorebug for the same "one dataset, not two" reason as the rank.
    const habitable = Math.max(
      1,
      game.numLandTiles() - game.numTilesWithFallout(),
    );

    const troops = player.troops();
    const gold = Number(player.gold());
    const standing: Fact[] = [];
    if (tiles > 0) {
      standing.push({
        value: renderNumber(tiles),
        unit: translatedUnit("tiles", tiles, "tile", "tiles"),
      });
    }
    if (troops > 0) {
      standing.push({
        value: renderTroops(troops),
        unit: translatedUnit("troops", troops, "troop", "troops"),
      });
    }
    if (gold > 0) {
      standing.push({
        value: renderNumber(gold),
        unit: translateText(
          "ai_league_replay.dossier_unit_gold",
          undefined,
          "gold",
        ),
      });
    }

    const kind = KIND_LABEL[player.type()] ?? KIND_LABEL[PlayerType.Nation];

    return {
      name: aiLeagueSpectatorDisplayName(player.displayName()).toUpperCase(),
      // The nation's ACTUAL on-map fill, straight off the same accessor
      // TerritoryLayer paints with — not theme().territoryColor(), which
      // returns the default and ignores cosmetic and pattern overrides. The
      // scorebug's seat chips are sourced the same way; all three agree.
      seat: player.territoryColor().toHex(),
      rim: player.borderColor().toHex(),
      alive,
      rank,
      field: living.length,
      share: formatPercentage(tiles / habitable),
      tiles,
      standing,
      decision: this.decision(player),
      forces: this.forces(player),
      expansion: this.expansion(player),
      ...this.diplomacy(player),
      traitor: player.isTraitor()
        ? renderDuration(
            Math.floor(player.getTraitorRemainingTicks() / TICKS_PER_SECOND),
          )
        : null,
      record: this.record(player),
      kind: translateText(
        `ai_league_replay.dossier_kind_${kind.key}`,
        undefined,
        kind.fallback,
      ),
      disconnected: player.isDisconnected(),
    };
  }

  /**
   * The followed nation's most recent SAMPLED decision, up to the playhead.
   *
   * Capped at the current tick (turn and tick are the same scale — the
   * scrubber's currentTurn IS game.ticks()) so a viewer scrubbed back to the
   * early game is never shown a decision from their own future: "last" has to
   * mean "last so far", or a rewind spoils the match it exists to replay.
   *
   * Matched by `player.data.name`, NOT name()/displayName(): those two return
   * the anonymousName when the Anonymous Names setting is on, and decision
   * usernames live in the raw agent-name namespace (see the store's own doc).
   * data.displayName is the fallback for any seat whose engine name and
   * roster name diverge. Bot/nation seats simply never match a decision, so
   * the section stays out of their dossiers by construction.
   */
  private decision(player: PlayerView): DecisionNote | null {
    const upToTurn = this.game.ticks();
    const entry =
      lastDecisionFor(player.data.name, upToTurn) ??
      lastDecisionFor(player.data.displayName, upToTurn);
    if (entry === null) return null;
    const reason = statedReason(entry);
    const objective =
      typeof entry.planObjective === "string" &&
      entry.planObjective.trim().length > 0
        ? entry.planObjective.trim()
        : null;
    return {
      // "break_alliance" → "BREAK ALLIANCE": the panel's grammar is uppercase
      // labels, and the raw kind token is not broadcast copy.
      kind: formatReplayActionKind(
        entry.selectedActionKind,
      ).toLocaleUpperCase(),
      turn: entry.turnNumber,
      reason: reason === null ? null : truncate(reason, MAX_DECISION_TEXT),
      objective:
        objective === null ? null : truncate(objective, MAX_DECISION_TEXT),
    };
  }

  /**
   * What the nation has built and floated.
   *
   * ONE sweep, not nine. PlayerView.totalUnitLevels() and PlayerView.units()
   * each re-scan the entire board-wide unit table and then filter by owner, so
   * asking per type would walk every unit in the match nine times per sample.
   * Asking once for all nine types and tallying here is the same answer for a
   * ninth of the work.
   */
  private forces(player: PlayerView): Fact[] {
    const counts = new Map<UnitType, number>();
    for (const unit of player.units(...FORCE_TYPES.map((f) => f.type))) {
      // Under construction is not yet a force; it is a promise. The engine's
      // own totalUnitLevels() draws the line in the same place.
      if (unit.isUnderConstruction()) continue;
      counts.set(unit.type(), (counts.get(unit.type()) ?? 0) + 1);
    }
    const facts: Fact[] = [];
    for (const force of FORCE_TYPES) {
      const count = counts.get(force.type) ?? 0;
      if (count === 0) continue;
      facts.push({
        value: renderNumber(count),
        unit: translatedUnit(force.key, count, force.one, force.many),
      });
    }
    return facts;
  }

  /** Troops committed to taking unclaimed ground — targetID 0 is TerraNullius. */
  private expansion(player: PlayerView): string | null {
    let troops = 0;
    for (const attack of player.outgoingAttacks()) {
      if (attack.targetID === 0) troops += attack.troops;
    }
    return troops > 0 ? renderTroops(troops) : null;
  }

  /**
   * Alliances, wars and the troops on each front.
   *
   * Relationships are read off `player.data` rather than through targets() /
   * allies(), which map small ids through playerBySmallID() and therefore
   * THROW on anything stale. A dossier that can crash the layer loop because a
   * target died on the tick it was read is not worth the shorter call.
   */
  private diplomacy(player: PlayerView): {
    allies: Row[];
    moreAllies: number;
    wars: Row[];
    moreWars: number;
  } {
    const byId = new Map<string, PlayerView>();
    const bySmallId = new Map<number, PlayerView>();
    for (const other of this.game.playerViews()) {
      byId.set(other.id(), other);
      bySmallId.set(other.smallID(), other);
    }

    // ALLIES. alliances() carries the expiry, which is the only part of an
    // alliance that is news; the plain allies list carries the same names with
    // no clock on them.
    const now = this.game.ticks();
    const allies: { row: Row; remaining: number }[] = [];
    for (const alliance of player.alliances()) {
      const other = byId.get(alliance.other);
      if (other === undefined) continue;
      const remaining = Math.max(0, alliance.expiresAt - now);
      allies.push({
        remaining,
        row: {
          name: aiLeagueSpectatorDisplayName(other.displayName()),
          value: renderDuration(Math.floor(remaining / TICKS_PER_SECOND)),
          // hasExtensionRequest is set by the engine when an alliance has
          // entered its extension-prompt window — i.e. it is about to lapse,
          // which is precisely when it is worth flagging.
          warn: alliance.hasExtensionRequest,
        },
      });
    }
    // Nearest expiry first: the alliance about to lapse is the one that
    // changes the match.
    allies.sort((a, b) => a.remaining - b.remaining);

    // FRONTS. Live troop commitments in either direction, keyed by the other
    // nation, so a war row can say how much is actually being spent on it.
    const front = new Map<number, number>();
    for (const attack of player.outgoingAttacks()) {
      if (attack.targetID === 0) continue;
      front.set(
        attack.targetID,
        (front.get(attack.targetID) ?? 0) + attack.troops,
      );
    }
    for (const attack of player.incomingAttacks()) {
      front.set(
        attack.attackerID,
        (front.get(attack.attackerID) ?? 0) + attack.troops,
      );
    }

    // WAR is bidirectional and cannot be read off one record — see class doc.
    const belligerents = new Set<number>(player.data.targets);
    for (const other of this.game.playerViews()) {
      if (other.smallID() === player.smallID()) continue;
      if (other.data.targets.includes(player.smallID())) {
        belligerents.add(other.smallID());
      }
    }
    for (const smallId of front.keys()) belligerents.add(smallId);
    belligerents.delete(player.smallID());
    belligerents.delete(0);

    const wars: { row: Row; troops: number }[] = [];
    for (const smallId of belligerents) {
      const other = bySmallId.get(smallId);
      if (other === undefined) continue;
      const troops = front.get(smallId) ?? 0;
      wars.push({
        troops,
        row: {
          name: aiLeagueSpectatorDisplayName(other.displayName()),
          value: troops > 0 ? renderTroops(troops) : "",
          warn: false,
        },
      });
    }
    // Hottest front first; a declared war with nothing moving on it ranks
    // below one with an army on it.
    wars.sort((a, b) => b.troops - a.troops);

    return {
      allies: allies.slice(0, MAX_ALLY_ROWS).map((a) => a.row),
      moreAllies: Math.max(0, allies.length - MAX_ALLY_ROWS),
      wars: wars.slice(0, MAX_WAR_ROWS).map((w) => w.row),
      moreWars: Math.max(0, wars.length - MAX_WAR_ROWS),
    };
  }

  /**
   * The standing record: things that happened, not things that are.
   * Both live on `player.data` with no getter of their own.
   */
  private record(player: PlayerView): Fact[] {
    const facts: Fact[] = [];
    const betrayals = player.data.betrayals ?? 0;
    if (betrayals > 0) {
      facts.push({
        value: renderNumber(betrayals),
        unit: translatedUnit("betrayal", betrayals, "betrayal", "betrayals"),
      });
    }
    const embargoes =
      player.data.embargoes instanceof Set ? player.data.embargoes.size : 0;
    if (embargoes > 0) {
      facts.push({
        value: renderNumber(embargoes),
        unit: translatedUnit("embargo", embargoes, "embargo", "embargoes"),
      });
    }
    return facts;
  }

  // ------------------------------------------------------------------- DOM

  private paint(panel: HTMLElement, s: Snapshot) {
    const kids: HTMLElement[] = [];
    /**
     * Trim groups, in DOM order, each ordered so that removing its members
     * front-to-back peels a section apart from its cheapest line to its label.
     * The budget loop below walks the groups bottom-up. Identity and standing
     * are not in here: they are the panel, and if they do not fit the panel
     * does not open at all (MIN_BUDGET).
     */
    const groups: HTMLElement[][] = [];

    // --- who ------------------------------------------------------------
    const head = div("pw-dossier-head");
    head.append(
      span(
        "pw-dossier-eyebrow",
        translateText(
          "ai_league_replay.dossier_following",
          undefined,
          "FOLLOWING",
        ),
      ),
    );
    const rank = span("pw-dossier-rank", "");
    if (s.alive) {
      // Never a bare figure: a rank is only meaningful against a field size,
      // and the field shrinks as nations are knocked out.
      rank.textContent = translateText(
        "ai_league_replay.dossier_rank",
        { rank: s.rank, field: s.field },
        `RANK ${s.rank.toLocaleString()} OF ${s.field.toLocaleString()}`,
      );
    } else {
      // The one sanctioned use of hazard coral outside a warhead.
      rank.dataset.out = "1";
      rank.textContent = translateText(
        "ai_league_replay.dossier_eliminated",
        undefined,
        "ELIMINATED",
      );
    }
    head.append(rank);
    kids.push(head);

    const identity = div("pw-dossier-id");
    const seat = div("pw-dossier-seat");
    seat.style.setProperty("--pw-seat", s.seat);
    seat.style.setProperty("--pw-rim", s.rim);
    const name = document.createElement("h2");
    name.className = "pw-dossier-name";
    name.textContent = s.name;
    identity.append(seat, name);
    kids.push(identity);

    // --- standing ---------------------------------------------------------
    if (s.tiles > 0) {
      const hero = div("pw-dossier-hero");
      hero.append(
        span("pw-dossier-figure", s.share),
        span(
          "pw-dossier-hero-unit",
          translateText(
            "ai_league_replay.dossier_of_land",
            undefined,
            "of the land",
          ),
        ),
      );
      kids.push(hero);
    }
    if (s.standing.length > 0) {
      kids.push(factLine("pw-dossier-facts", s.standing));
    }

    // --- last sampled decision -------------------------------------------
    // The one section no other fact source can write: the agent's own stated
    // WHY. Deliberately painted ABOVE forces/fronts so its trim group carries
    // a low index — the budget loop peels groups from the highest index down,
    // and on a tight lane the differentiator should be the last section
    // standing, not the first casualty. "SAMPLED" is in the label because the
    // artifact holds at most ~60 decisions across the whole match: this is
    // the latest the sample HAS, not the latest the agent MADE.
    if (s.decision !== null) {
      const section = div("pw-dossier-sec");
      const label = labelEl(
        translateText(
          "ai_league_replay.dossier_last_sampled_decision",
          undefined,
          "LAST SAMPLED DECISION",
        ),
      );
      const row = div("pw-dossier-row");
      row.append(span("pw-dossier-who", s.decision.kind));
      const when = span("pw-dossier-val", "");
      when.append(
        num(
          translateText(
            "ai_league_replay.turn_short",
            { turn: s.decision.turn },
            `T${s.decision.turn}`,
          ),
        ),
      );
      row.append(when);
      section.append(label, row);
      const trim: HTMLElement[] = [];
      // Reason first in DOM (it is the payload), objective under it as the
      // quieter standing-plan line. Trim order is the reverse of value:
      // objective goes first, the quoted reason second, the row itself last.
      if (s.decision.reason !== null) {
        const line = span("pw-dossier-quote", `“${s.decision.reason}”`);
        section.append(line);
        trim.push(line);
      }
      if (s.decision.objective !== null) {
        const line = span(
          "pw-dossier-plan",
          translateText(
            "ai_league_replay.dossier_plan",
            { objective: s.decision.objective },
            `Plan · ${s.decision.objective}`,
          ),
        );
        section.append(line);
        trim.unshift(line);
      }
      kids.push(section);
      trim.push(row, label, section);
      groups.push(trim);
    }

    // --- forces -----------------------------------------------------------
    if (s.forces.length > 0) {
      const section = div("pw-dossier-sec");
      const label = labelEl(
        translateText("ai_league_replay.dossier_forces", undefined, "FORCES"),
      );
      const line = factLine("pw-dossier-body", s.forces);
      section.append(label, line);
      kids.push(section);
      groups.push([line, section]);
    }

    // --- fronts -----------------------------------------------------------
    if (s.wars.length > 0) {
      const section = div("pw-dossier-sec");
      const label = labelEl(
        translateText(
          "ai_league_replay.dossier_at_war_with",
          undefined,
          "AT WAR WITH",
        ),
      );
      section.append(label);
      const trim: HTMLElement[] = [];
      for (const war of s.wars) {
        const row = rowEl(
          war,
          translateText(
            "ai_league_replay.dossier_troops_label",
            undefined,
            "troops",
          ),
        );
        section.append(row);
        trim.unshift(row);
      }
      if (s.moreWars > 0) {
        const more = span("pw-dossier-more", "");
        more.textContent = translateText(
          "ai_league_replay.dossier_more",
          { count: s.moreWars },
          `+${s.moreWars.toLocaleString()} more`,
        );
        section.append(more);
        trim.unshift(more);
      }
      kids.push(section);
      trim.push(label, section);
      groups.push(trim);
    }

    // --- diplomacy --------------------------------------------------------
    if (s.allies.length > 0) {
      const section = div("pw-dossier-sec");
      const label = labelEl(
        translateText(
          "ai_league_replay.dossier_allied_with",
          undefined,
          "ALLIED WITH",
        ),
      );
      section.append(label);
      const trim: HTMLElement[] = [];
      for (const ally of s.allies) {
        const row = rowEl(ally, null);
        section.append(row);
        trim.unshift(row);
      }
      if (s.moreAllies > 0) {
        const more = span("pw-dossier-more", "");
        more.textContent = translateText(
          "ai_league_replay.dossier_more",
          { count: s.moreAllies },
          `+${s.moreAllies.toLocaleString()} more`,
        );
        section.append(more);
        trim.unshift(more);
      }
      kids.push(section);
      trim.push(label, section);
      groups.push(trim);
    }

    if (s.expansion !== null) {
      const line = span("pw-dossier-note", "");
      line.textContent = translateText(
        "ai_league_replay.dossier_expanding",
        { troops: s.expansion },
        `Expanding into unclaimed ground · ${s.expansion} troops`,
      );
      kids.push(line);
      groups.push([line]);
    }

    if (s.traitor !== null) {
      const line = span("pw-dossier-note", "");
      line.dataset.warn = "1";
      line.textContent = translateText(
        "ai_league_replay.dossier_traitor",
        { duration: s.traitor },
        `Marked a traitor · ${s.traitor} remaining`,
      );
      kids.push(line);
      groups.push([line]);
    }

    // --- record -----------------------------------------------------------
    // Always present, because the kind label always is: this line can never be
    // the empty one.
    const record = span("pw-dossier-note", "");
    record.append(text(s.kind));
    if (s.disconnected) {
      record.append(
        text(
          translateText(
            "ai_league_replay.dossier_disconnected_suffix",
            undefined,
            " · disconnected",
          ),
        ),
      );
    }
    for (const fact of s.record) {
      record.append(text(" · "), num(fact.value), text(` ${fact.unit}`));
    }
    kids.push(record);
    groups.push([record]);

    panel.replaceChildren(...kids);
    panel.dataset.on = "1";
    document.body.classList.add("pw-dossier-on");
    this.trimToBudget(panel, groups);
  }

  /**
   * Fit the panel to its measured lane by dropping the least valuable lines.
   *
   * scrollHeight, not offsetHeight: the panel carries a max-height so it can
   * never spill over the scrubber even if this loop somehow fails, and
   * offsetHeight would report that ceiling rather than the content and the
   * loop would never fire. One forced layout per render at ~2.6Hz, plus one
   * per line actually removed.
   */
  private trimToBudget(panel: HTMLElement, groups: HTMLElement[][]) {
    if (this.budget > 0) {
      for (let g = groups.length - 1; g >= 0; g--) {
        for (const element of groups[g]) {
          if (panel.scrollHeight <= this.budget) {
            this.dropEmptySections(panel);
            return;
          }
          element.remove();
        }
      }
    }
    this.dropEmptySections(panel);
  }

  /**
   * A section whose last row was trimmed away is a heading over nothing, which
   * is the empty-panel failure one level down. The trim loop stops the instant
   * the panel fits, so it can and does leave one behind; this is the sweep that
   * takes it out.
   */
  private dropEmptySections(panel: HTMLElement) {
    for (const section of panel.querySelectorAll(".pw-dossier-sec")) {
      // One child means the label survived alone.
      if (section.childElementCount <= 1) section.remove();
    }
  }
}

// --------------------------------------------------------------- DOM helpers

function translatedUnit(
  key: string,
  count: number,
  one: string,
  many: string,
): string {
  return translateText(
    `ai_league_replay.dossier_unit_${key}`,
    { count },
    count === 1 ? one : many,
  );
}

function div(className: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function span(className: string, content: string): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  if (content !== "") element.textContent = content;
  return element;
}

function labelEl(content: string): HTMLElement {
  const element = document.createElement("h3");
  element.className = "pw-dossier-label";
  element.textContent = content;
  return element;
}

/** Word-boundary truncation with an honest ellipsis; see MAX_DECISION_TEXT. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function text(content: string): Text {
  return document.createTextNode(content);
}

/**
 * A figure. Mono is reserved for numbers on this stage and prose is never set
 * in it, so every value is wrapped and every unit stays in the display face —
 * which is also what makes columns of them line up.
 */
function num(content: string): HTMLElement {
  return span("pw-dossier-n", content);
}

/** "6 cities · 3 missile silos · 11 warships" — figures mono, units prose. */
function factLine(className: string, facts: Fact[]): HTMLElement {
  const line = span(className, "");
  facts.forEach((fact, index) => {
    if (index > 0) line.append(span("pw-dossier-sep", "·"));
    line.append(num(fact.value), text(` ${fact.unit}`));
  });
  return line;
}

/**
 * A name on the left, a figure on the right, nothing between them. `unit` is
 * null for a figure that already carries its own (a duration), and a row with
 * no figure at all is just the name — a declared war with no army moving on it
 * is still a fact, and padding it with a "0" would be a lie about activity.
 */
function rowEl(row: Row, unit: string | null): HTMLElement {
  const element = div("pw-dossier-row");
  if (row.warn) element.dataset.warn = "1";
  element.append(span("pw-dossier-who", row.name));
  if (row.value !== "") {
    const value = span("pw-dossier-val", "");
    value.append(num(row.value));
    if (unit !== null) value.append(text(` ${unit}`));
    element.append(value);
  }
  return element;
}

let stylesMounted = false;

function mountNationDossierStyles() {
  if (stylesMounted) return;
  stylesMounted = true;
  const style = document.createElement("style");
  style.id = "pw-nation-dossier-styles";
  style.textContent = `
    /* THE DOCK. Left lane, under the scorebug, out of every other lane on the
     * stage. top and max-height are written from the measured scorebug at
     * runtime (see layout()); the values here are only what applies before the
     * first sample. Never rendered empty and never rendered at all with
     * nothing followed. */
    .pw-dossier {
      position: fixed;
      left: 16px;
      top: 16px;
      z-index: 50004;
      /* Nothing in here is clickable: the map IS the control surface, and a
       * click anywhere on it selects or clears. A panel that ate clicks over
       * the board would be taking the gesture away from the thing it
       * describes. */
      pointer-events: none;
      display: none;
      box-sizing: border-box;
      /* Docked into the letterbox band the camera publishes, same rule as the
       * scorebug it hangs from, so it tracks the board at every viewport
       * instead of being tuned for one. */
      width: min(340px, max(212px, calc(var(--pw-band-left, 316px) + 20px)));
      /* Backstop only. trimToBudget() is what actually makes the panel fit;
       * this exists so that a bad measurement can never put a dossier on top
       * of the scrubber. */
      overflow: hidden;
      padding: 10px 13px 12px;
      background: var(--pw-panel, rgba(24, 20, 17, 0.82));
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border-radius: 9px;
      box-shadow: 0 14px 32px rgba(10, 7, 5, 0.34);
      font-family: var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      color: var(--pw-ink-dim, #a79e92);
      contain: layout style;
    }
    .pw-dossier[data-on="1"] {
      display: block;
      animation: pw-dossier-in 190ms ease-out 1;
    }
    @keyframes pw-dossier-in {
      from { opacity: 0; transform: translateY(-5px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* The result owns the frame; the end card carries its own standings. */
    body.pw-endcard-open .pw-dossier { display: none !important; }

    /* THE CHIP AND THE PANEL SAY THE SAME THING. FollowedCompetitor's amber
     * "FOLLOWING · NAME" chip was the entire selection payload before this
     * panel existed; with the dossier open it is a second copy of the name in
     * the opposite corner. It stands down only while the dossier is actually
     * speaking — which matters, because at the embed floor there may be no
     * lane for the dossier at all (MIN_BUDGET) and the chip is then the only
     * thing telling a viewer their click landed. */
    body.pw-dossier-on .pw-following-chip { display: none !important; }

    .pw-dossier-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    /* Amber, matching the chip it replaces: this is the follow state, and
     * amber is the only chrome accent on this stage. */
    .pw-dossier-eyebrow {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.16em;
      color: var(--pw-accent, #ffc24a);
    }
    .pw-dossier-rank {
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.13em;
      color: var(--pw-ink-faint, #6f675d);
      white-space: nowrap;
    }
    .pw-dossier-rank[data-out="1"] { color: var(--pw-hazard, #ff6b4a); }

    .pw-dossier-id {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 5px;
    }
    /* The seat colour, as an identity swatch and not as decoration: it is the
     * one thing that ties this panel to a shape on the board. */
    .pw-dossier-seat {
      flex: none;
      width: 11px;
      height: 11px;
      border-radius: 2px;
      background: var(--pw-seat, #a79e92);
      box-shadow: inset 0 0 0 1px var(--pw-rim, rgba(20, 17, 15, 0.55));
    }
    /* A name is never clipped and never ellipsised — the nuke alert learned
     * that the hard way. Long ones wrap. */
    .pw-dossier-name {
      margin: 0;
      font-size: 19px;
      font-weight: 700;
      line-height: 1.12;
      letter-spacing: 0.03em;
      color: var(--pw-ink, #f2ece2);
      overflow-wrap: anywhere;
    }

    /* The one figure that wins the squint test. Territory share is what the
     * standings are ordered by, so it is what "how are they doing" means. */
    .pw-dossier-hero {
      display: flex;
      align-items: baseline;
      gap: 7px;
      margin-top: 9px;
    }
    .pw-dossier-figure {
      font-family: var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      font-size: 26px;
      font-weight: 600;
      line-height: 1;
      color: var(--pw-ink, #f2ece2);
      font-variant-numeric: tabular-nums;
    }
    .pw-dossier-hero-unit {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--pw-ink-faint, #6f675d);
    }
    .pw-dossier-facts {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      line-height: 1.5;
    }

    .pw-dossier-sec { margin-top: 9px; }
    /* Hierarchy comes from weight, size and space. No rules, no boxes, no
     * stripes: one hairline in the whole panel is the border around it. */
    .pw-dossier-label {
      margin: 0 0 2px;
      font-size: 8.5px;
      font-weight: 700;
      line-height: 1.4;
      letter-spacing: 0.17em;
      color: var(--pw-ink-faint, #6f675d);
    }
    .pw-dossier-body {
      display: block;
      font-size: 11px;
      line-height: 1.5;
    }
    .pw-dossier-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      font-size: 11.5px;
      line-height: 1.55;
    }
    .pw-dossier-who {
      color: var(--pw-ink, #f2ece2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pw-dossier-val {
      flex: none;
      font-size: 10px;
      color: var(--pw-ink-dim, #a79e92);
    }
    .pw-dossier-row[data-warn="1"] .pw-dossier-val,
    .pw-dossier-row[data-warn="1"] .pw-dossier-n {
      color: var(--pw-accent, #ffc24a);
    }
    .pw-dossier-more {
      display: block;
      font-size: 10px;
      color: var(--pw-ink-faint, #6f675d);
    }
    /* The agent's own words, and only the agent's words, get quotation marks:
     * the quotes ARE the label that this is a stated claim, not a verified
     * fact. Dim ink, not full ink — testimony, not measurement. */
    .pw-dossier-quote {
      display: block;
      margin-top: 2px;
      font-size: 10.5px;
      line-height: 1.45;
      color: var(--pw-ink-dim, #a79e92);
      overflow-wrap: anywhere;
    }
    /* The standing plan under it, one step quieter again. */
    .pw-dossier-plan {
      display: block;
      margin-top: 2px;
      font-size: 10px;
      line-height: 1.45;
      color: var(--pw-ink-faint, #6f675d);
      overflow-wrap: anywhere;
    }
    .pw-dossier-note {
      display: block;
      margin-top: 8px;
      font-size: 10px;
      line-height: 1.45;
      letter-spacing: 0.03em;
      color: var(--pw-ink-faint, #6f675d);
    }
    .pw-dossier-note[data-warn="1"] { color: var(--pw-accent, #ffc24a); }

    /* Mono is for numbers and only for numbers. */
    .pw-dossier-n {
      font-family: var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      font-variant-numeric: tabular-nums;
      color: var(--pw-ink, #f2ece2);
    }
    .pw-dossier-sep {
      padding: 0 4px;
      color: var(--pw-ink-faint, #6f675d);
    }

    /* On wide (2:1) maps there is no band to dock into and the scorebug
     * narrows to 230px as an overlay; the dossier matches it rather than
     * trespassing further onto the board than the panel it hangs from. */
    @media (min-width: 981px) {
      body.pw-narrow-band .pw-dossier {
        width: 230px;
        background: rgba(24, 20, 17, 0.74);
      }
    }

    /* SMALL FRAMES SHRINK THE TYPE, NOT THE PANEL. The scorebug uses
     * transform: scale() here; this cannot, because its height is measured
     * against the viewport and a transform would make that measurement
     * describe a box that is not the one on screen. */
    @media (max-width: 900px) {
      .pw-dossier {
        left: 10px;
        width: min(258px, calc(100vw - 20px));
        padding: 8px 10px 10px;
      }
      .pw-dossier-name { font-size: 16px; }
      .pw-dossier-figure { font-size: 21px; }
      .pw-dossier-row { font-size: 11px; }
    }
    @media (max-width: 740px) {
      .pw-dossier {
        left: 8px;
        width: 206px;
        border-radius: 7px;
      }
      .pw-dossier-name { font-size: 14px; }
      .pw-dossier-figure { font-size: 18px; }
      .pw-dossier-facts,
      .pw-dossier-body { font-size: 10px; }
      .pw-dossier-row { font-size: 10.5px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .pw-dossier[data-on="1"] { animation: none; }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Mounts the dossier on broadcast surfaces only. Returns [] for live play, so
 * the layer is never constructed there and its cost is exactly zero — the same
 * self-gate mountNukeCinema() uses.
 */
export function mountNationDossier(
  game: GameView,
  _eventBus: EventBus,
  _transformHandler: TransformHandler,
): Layer[] {
  if (!isAiLeagueReplayRoute()) return [];
  return [new NationDossier(game)];
}
