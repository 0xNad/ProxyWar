/**
 * LEAD-CHANGE detection for the broadcast drama layer, shared by the two
 * surfaces that must agree on "the lead changed hands":
 *
 *  1. `AiLeagueReplayOverlay.ts`'s curated War Room feed / timeline markers
 *     derive whole-match `lead_change` beats from the sampled
 *     `match-state-series.json` artifact via `computeLeadChangeBeats` below.
 *  2. `Leaderboard.ts`'s broadcast scorebug tracks the SAME policy live off
 *     `GameView` ticks via the incremental `LeadChangeTracker` class, to
 *     decide which row wears the crown chip and when it pulses.
 *  3. `graphics/layers/BroadcastScrubber.ts` draws the ♔ mark on the
 *     transport. It never re-derives a beat — it harvests the overlay's own
 *     timeline markers — but it DOES have to read the nation that took the
 *     lead back out of a marker label to paint the crown in that seat's
 *     colour, so the one sentence template both sides use lives here
 *     (`LEAD_CHANGE_HEADLINE_KEY` / `leadChangeHeadlineDefault`).
 *
 * WHY A SEPARATE MODULE: the overlay and the scorebug live in different
 * dependency layers (`client/` vs `client/graphics/layers/`), and importing
 * the 6,700-line overlay module from a render layer for two constants would
 * be a cycle risk and a boot-cost tax — a REAL cycle, in fact, since the
 * overlay already imports `broadcastSpoilersEnabled` from the scrubber. This
 * file has zero imports, which is what makes it safe for both layers.
 *
 * WHY THESE RULES AND NOT AN INVENTED ONE: the server already publishes a
 * canonical lead-change definition — `computeLeadChanges` in
 * `server/agents/AgentMatchStateDerivations.ts` (margin >=
 * `LEAD_CHANGE_MARGIN_SHARE`, confirmed by still leading at the NEXT sampled
 * point), and `AgentDecisiveMoments.ts` already publishes those moments as
 * `"lead_change"` decisive moments. Two derivations of "when did the lead
 * change" must never disagree on the same match (this repo's own
 * "two derivations drift" rule — see GameRenderer.ts's incumbent-surfaces
 * block), so `computeLeadChangeBeats` mirrors that server function EXACTLY
 * rather than inventing a second rule. Client code never imports server
 * modules (same boundary that forced `AiLeagueMatchStateSample` to be a
 * client-local mirror in AiLeagueReplayOverlay.ts), hence the mirrored
 * constant + algorithm here, each annotated with its server source of truth.
 */

/**
 * Client mirror of `AgentMatchStateDerivations.ts`'s
 * `LEAD_CHANGE_MARGIN_SHARE` (0.03 = 3 percentage points of total claimed
 * territory). A new leader must clear the outgoing leader by at least this
 * much for the swap to count as a genuine overtake rather than noise between
 * two agents trading near-equal border tiles. If the server constant is ever
 * retuned, retune this one with it.
 */
export const LEAD_CHANGE_MARGIN_SHARE = 0.03;

/**
 * Hold window for the LIVE tick-axis tracker (`LeadChangeTracker`), which
 * has no "next sample" to confirm against — the scorebug observes roughly
 * once per second, so "still leading at the next observation" would confirm
 * after ~10 game turns, far twitchier than the sampled-series rule the feed
 * uses. 100 turns was chosen to approximate that rule's real confirmation
 * distance: match-state series are capped at 80 samples per match
 * (`MATCH_STATE_SERIES_MAX_SAMPLES`), so sample spacing is totalTurns/80 —
 * ~25 turns on a 2,000-turn match up to ~180 on the 14,200-turn theater
 * match the scrubber notes cite — putting 100 in the middle of the real
 * spacing range. It is also ~10 seconds of sustained lead at 1x playback
 * (10 turns/sec): long enough that a border war flickering #1/#2 can never
 * strobe the crown, short enough that a genuine takeover is crowned while
 * the viewer is still watching it happen.
 */
export const LEAD_CHANGE_HOLD_TURNS = 100;

/**
 * The ONE lang key for the lead-change sentence, and the ONE English default
 * behind it. Two surfaces render this template and a third READS it back:
 * `AiLeagueReplayOverlay.ts` builds the War Room headline, the lower-third
 * card and the timeline marker label from it, and `BroadcastScrubber.ts`
 * renders the identical template around sentinels to recover `{actor}` — the
 * nation that TOOK the lead — out of a harvested marker label, so its ♔ can
 * be painted in that nation's seat colour. If the two ever drifted apart the
 * scrubber would silently stop resolving seats and every crown would fall
 * back to flat amber, so the template is stated once, here, and neither side
 * writes its own.
 *
 * It carries all four facts the director asked a lead change to state — both
 * nations AND both shares — because the surfaces that matter most (the
 * lower-third card, the toast) render nothing but this one string.
 *
 * The key is deliberately NOT in resources/lang yet (that workstream is owned
 * elsewhere); `translateText`'s `defaultText` contract means a real
 * translation wins automatically the day one ships, and until then every
 * surface says exactly the same English sentence.
 */
export const LEAD_CHANGE_HEADLINE_KEY =
  "ai_league_replay.headline_lead_change_from";

/**
 * `LEAD_CHANGE_HEADLINE_KEY`'s pre-interpolated English fallback. Shares are
 * passed already formatted (the overlay's `formatPercentage`) rather than as
 * numbers so this module keeps its zero-import promise and one formatter
 * stays responsible for how a share reads on screen.
 */
export function leadChangeHeadlineDefault(
  actor: string,
  target: string,
  toShare: string,
  fromShare: string,
): string {
  return `${actor} takes the lead from ${target} — ${toShare} to ${fromShare}`;
}

/** Structural subset of `AiLeagueMatchStateSample`'s agents (AiLeagueReplayOverlay.ts) — declared here so this module imports nothing. */
export interface LeadSampleAgent {
  playerID: string;
  username: string;
  alive: boolean;
  /** 0..1 share of all claimed tiles in this sample. */
  territoryShare: number;
  /** 1-based, server-computed: tilesOwned desc, troops desc, playerID asc. */
  rank: number;
}

/** Structural subset of `AiLeagueMatchStateSample` itself. */
export interface LeadSample {
  turn: number;
  agents: ReadonlyArray<LeadSampleAgent>;
}

/** One confirmed lead change derived from the sampled series. */
export interface SeriesLeadChangeBeat {
  /** The transition sample's turn (matches the server's `LeadChange.turn`). */
  turn: number;
  fromPlayerID: string;
  fromUsername: string;
  /** Outgoing leader's share AT the transition sample. */
  fromShare: number;
  toPlayerID: string;
  toUsername: string;
  toShare: number;
  /** `toShare - fromShare`, always >= LEAD_CHANGE_MARGIN_SHARE. */
  marginShare: number;
}

/**
 * The sample's leader. The server's `leaderOf` sorts the alive pool (all
 * agents when none are alive) by territoryShare desc, troops desc, playerID
 * asc — the client sample mirror carries no `troops` field, but it does
 * carry the server-computed `rank`, whose ordering (tilesOwned desc, troops
 * desc, playerID asc — see `MatchStateSeriesAgentSample.rank`'s doc) is that
 * exact sort: territoryShare is tilesOwned over a shared denominator, so
 * min-rank within the pool selects the identical agent without needing the
 * missing field.
 */
function leaderOf(sample: LeadSample): LeadSampleAgent {
  const alive = sample.agents.filter((agent) => agent.alive);
  const pool = alive.length > 0 ? alive : sample.agents;
  return pool.reduce((best, agent) => (agent.rank < best.rank ? agent : best));
}

/**
 * EXACT client mirror of `AgentMatchStateDerivations.ts`'s
 * `computeLeadChanges` — same pre-spawn filter (a sample where nobody has
 * claimed territory yet has no meaningful leader), same margin gate at the
 * transition sample, same single-sample-flicker rejection (the new leader
 * must still be leading at the NEXT sampled point; a final-sample takeover
 * with no next point stands, exactly as on the server), same recorded turn
 * (the transition sample's, not the confirming one's). Kept rule-for-rule in
 * step so the broadcast beat and the server-published decisive moments never
 * disagree about the same match.
 */
export function computeLeadChangeBeats(
  samples: ReadonlyArray<LeadSample>,
): SeriesLeadChangeBeat[] {
  const eligible = samples.filter((sample) =>
    sample.agents.some((agent) => agent.territoryShare > 0),
  );
  if (eligible.length === 0) {
    return [];
  }
  const beats: SeriesLeadChangeBeat[] = [];
  let confirmedLeader = leaderOf(eligible[0]);
  for (let index = 1; index < eligible.length; index += 1) {
    const sample = eligible[index];
    const candidate = leaderOf(sample);
    if (candidate.playerID === confirmedLeader.playerID) {
      continue;
    }
    const confirmedShareNow =
      sample.agents.find((agent) => agent.playerID === confirmedLeader.playerID)
        ?.territoryShare ?? 0;
    const marginShare = candidate.territoryShare - confirmedShareNow;
    if (marginShare < LEAD_CHANGE_MARGIN_SHARE) {
      continue;
    }
    const nextSample = eligible[index + 1];
    if (
      nextSample !== undefined &&
      leaderOf(nextSample).playerID !== candidate.playerID
    ) {
      // Single-sample flicker — the "lead" reverted at the very next point.
      continue;
    }
    beats.push({
      turn: sample.turn,
      fromPlayerID: confirmedLeader.playerID,
      fromUsername: confirmedLeader.username,
      fromShare: confirmedShareNow,
      toPlayerID: candidate.playerID,
      toUsername: candidate.username,
      toShare: candidate.territoryShare,
      marginShare,
    });
    confirmedLeader = candidate;
  }
  return beats;
}

/** One observation of the live standings, fed to `LeadChangeTracker.observe` once per scorebug tick. */
export interface LeadObservation {
  /** Game turn axis (`GameView.ticks()` — the same executed-turn count the replay's frame `turnNumber` advances by). */
  turn: number;
  /** Current top player by tiles among the living. */
  leaderId: string;
  /** That player's share of all currently-owned tiles, 0..1. */
  leaderShare: number;
  /** The currently-confirmed leader's share right now (0 when gone). */
  incumbentShare: number;
  /**
   * False once the confirmed leader has been ELIMINATED — and only then.
   *
   * CALLER CONTRACT, because this is the one input that bypasses both the
   * margin gate and the hold: pass `false` for a death, never for "I could
   * not find that player". A caller that resolves the incumbent by id against
   * a live view list and collapses "not found" into "not alive" (the shape
   * `Leaderboard.trackLead` uses) hands an immediate, unheld crown move to
   * whoever happens to be on top the moment a lookup misses — a pulse for an
   * event that did not happen. The rebuild case that could produce a miss is
   * covered upstream today (a rewind restarts the turn axis, so the backward-
   * seek re-baseline in `observe` fires first and silently), but the guarantee
   * belongs here in writing.
   */
  incumbentAlive: boolean;
}

/** A hysteresis-confirmed change of leader on the live axis. */
export interface LeadChangeBeat {
  turn: number;
  leaderId: string;
  previousLeaderId: string;
}

/**
 * Incremental, live-axis version of the same policy for the broadcast
 * scorebug's crown: a challenger only takes the crown after clearing the
 * SAME `LEAD_CHANGE_MARGIN_SHARE` margin AND holding raw rank 1
 * continuously for `LEAD_CHANGE_HOLD_TURNS` — see each constant's own doc
 * for why those two values. Two deliberate divergences from the pure series
 * rule, both facts rather than flicker:
 *
 *  - An eliminated incumbent surrenders the crown IMMEDIATELY (a dead agent
 *    cannot hold the lead; waiting out a hold window would leave the crown
 *    on a struck-through "OUT" row for ~10 seconds).
 *  - A backward seek re-baselines silently (no beat): the viewer jumped the
 *    playhead, nothing "happened" in the match, so replaying a crown pulse
 *    would announce a fictional event.
 */
export class LeadChangeTracker {
  private confirmed: string | null = null;
  private candidate: string | null = null;
  private candidateSince = 0;
  private lastTurn = -1;

  /** The hysteresis-confirmed leader — the row that wears the crown. */
  get confirmedLeaderId(): string | null {
    return this.confirmed;
  }

  /** Returns a beat exactly when the confirmed leader changes; null otherwise. */
  observe(observation: LeadObservation): LeadChangeBeat | null {
    if (observation.turn < this.lastTurn) {
      // Backward seek — re-baseline to whoever leads here, silently.
      this.lastTurn = observation.turn;
      this.confirmed = observation.leaderId;
      this.candidate = null;
      return null;
    }
    this.lastTurn = observation.turn;
    if (this.confirmed === null) {
      // First observation is the baseline, never a "change" — nobody was
      // overtaken, so there is no beat (and no pulse) to announce.
      this.confirmed = observation.leaderId;
      return null;
    }
    if (observation.leaderId === this.confirmed) {
      // Incumbent (still or again) on top: any challenge is abandoned.
      this.candidate = null;
      return null;
    }
    if (!observation.incumbentAlive) {
      return this.adopt(observation);
    }
    if (
      observation.leaderShare - observation.incumbentShare <
      LEAD_CHANGE_MARGIN_SHARE
    ) {
      // Raw rank 1 but inside the noise margin — not a genuine overtake
      // yet, and any running hold window restarts from a real overtake.
      this.candidate = null;
      return null;
    }
    if (this.candidate !== observation.leaderId) {
      this.candidate = observation.leaderId;
      this.candidateSince = observation.turn;
      return null;
    }
    if (observation.turn - this.candidateSince >= LEAD_CHANGE_HOLD_TURNS) {
      return this.adopt(observation);
    }
    return null;
  }

  private adopt(observation: LeadObservation): LeadChangeBeat | null {
    const previous = this.confirmed;
    this.confirmed = observation.leaderId;
    this.candidate = null;
    if (previous === null || previous === observation.leaderId) {
      return null;
    }
    return {
      turn: observation.turn,
      leaderId: observation.leaderId,
      previousLeaderId: previous,
    };
  }
}
