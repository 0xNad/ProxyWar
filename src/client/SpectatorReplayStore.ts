/**
 * ============================================================================
 * SPECTATOR REPLAY STORE — the envelope's territory samples, kept this time.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The static replay envelope carries `spectatorReplay.snapshots`: periodic
 * whole-board samples (turnNumber, per-player tilesOwned/troops/gold) recorded
 * by the capture side while the match actually ran. `parseCoworldStaticReplay`
 * JSON.parses the whole envelope, its zod schema is `.passthrough()` so the
 * field survives validation untyped — and then the return statement
 * cherry-picked five fields and dropped it on the floor. The one dataset that
 * can draw the territory race under the scrubber (PaintBot's momentum graph,
 * translated to this product) was being parsed and discarded on every load.
 *
 * This module is the retention point. The parser publishes here on a
 * successful parse — and ONLY the static-bundle path runs that parser, so the
 * store is populated exactly when the broadcast surface exists, with no
 * Main.ts wiring at all. The scrubber reads it back whenever it likes; the
 * data is match-static so there is no subscription machinery, just a version
 * counter so a consumer can tell "new match record" from "same one".
 *
 * DEFENSIVE BY CONTRACT
 * ---------------------
 * A malformed or absent `spectatorReplay` must mean "no graph", never a
 * throw — the board must still play from an older or trimmed envelope. So
 * validation here is a hand-rolled shape walk that quietly drops anything it
 * does not recognise, keeps only the fields the graph needs, and refuses to
 * publish a series too thin to draw (fewer than two usable snapshots).
 *
 * SNAPSHOT GOTCHAS (verified against the real fixture — encode them here so
 * no consumer rediscovers them the hard way):
 * - Cadence is IRREGULAR (400, 2000, 3600, ... then every ~100 turns late in
 *   the match). Consumers must plot by `turnNumber`, never by index. The
 *   store sorts by turnNumber and de-dupes so that is at least safe to do.
 * - Eliminated players VANISH from later snapshots — there is never an
 *   `isAlive: false` entry. Track identity across snapshots by username and
 *   treat "missing" as tilesOwned = 0 from that point on, not as no-data.
 *   The raw snapshots DO carry an `isAlive` field and it is a trap: measured
 *   across all 29 snapshots of the Pangaea fixture (16 players down to 4) it
 *   is `true` for every player in every snapshot, including the sample right
 *   after twelve eliminations. It is deliberately NOT retained below —
 *   presence in `players[]` is the only honest aliveness signal, and a
 *   retained always-true field would invite a consumer to trust it.
 * - The FIRST snapshot is the spawn allocation, not a standing. On the
 *   Pangaea fixture t400 has all sixteen players on exactly 52 tiles, 62,518
 *   troops and 209,800 gold — identical to the digit. Any "leader" there is a
 *   tiebreak artifact, so a consumer ranking this series must not read a
 *   standing off a snapshot whose agents are all level (see
 *   `leadSamplesFromSpectatorSnapshots` in AiLeagueReplayOverlay.ts, which is
 *   where that judgement is made and justified).
 * - The snapshot `color` field is the STOCK engine palette, NOT this
 *   broadcast's seat colors. It is retained only as a last-resort fallback;
 *   display colors must be resolved at runtime against the live PlayerViews.
 * - `results.players[].tiles_owned` elsewhere in the envelope is 0 for every
 *   player (broken capture path) — these snapshots are the only real series.
 */

export interface SpectatorSnapshotPlayer {
  username: string;
  /** Stable capture-side id; secondary identity key after username. */
  agentID: string | null;
  /**
   * The capture side's own player id, retained because the LEAD-CHANGE
   * derivation keys agents by it.
   *
   * It was being read off the artifact and dropped, the same way troops and
   * gold were: every snapshot player in the reference fixture carries a
   * non-empty string `playerID`, and the beats the broadcast derives from
   * this series (`fromPlayerID`/`toPlayerID` on a `SeriesLeadChangeBeat`)
   * need an identity that is not the display name — usernames are what the
   * anonymous-names mode rewrites. Null when a snapshot genuinely omits it,
   * so a consumer can fall back to username rather than key on "".
   */
  playerID: string | null;
  tilesOwned: number;
  /**
   * The other two standing axes, carried per snapshot.
   *
   * These were being READ OFF THE ARTIFACT AND THROWN AWAY: the capture writes
   * troops and gold for every player at every snapshot, and this extractor
   * kept only tilesOwned — so the broadcast could draw a territory race and
   * nothing else, while the army race and the economy race sat in the file
   * unused. Null when a snapshot genuinely omits them, so a consumer can tell
   * "no data" from "zero".
   */
  troops: number | null;
  gold: number | null;
  /**
   * Stock-palette color from the capture side. Fallback ONLY — see the module
   * doc; the broadcast's real seat colors live on PlayerView.territoryColor().
   */
  color: string | null;
}

export interface SpectatorSnapshot {
  turnNumber: number;
  players: SpectatorSnapshotPlayer[];
  /**
   * Carried through UNTOUCHED for the decision store's adapter. The momentum
   * graph never reads it, but reconstructing the snapshot without it silently
   * severed the static bundle's only decision source — the drawer read
   * "0 SAMPLED DECISIONS" against a fixture carrying 240.
   */
  decisions?: unknown;
}

let snapshots: SpectatorSnapshot[] | null = null;
let version = 0;

/**
 * Validate and retain the envelope's `spectatorReplay`. Called by
 * `parseCoworldStaticReplay` with whatever the envelope carried — including
 * `undefined` from older envelopes, which lands here as "no data" and clears
 * any previous match's series rather than leaving it to bleed across loads.
 */
export function publishSpectatorReplay(raw: unknown): void {
  snapshots = extractSnapshots(raw);
  version += 1;
}

/** The validated series, or null when the envelope had nothing usable. */
export function spectatorReplaySnapshots(): SpectatorSnapshot[] | null {
  return snapshots;
}

/**
 * Bumps on every publish. A consumer that builds something expensive from the
 * series (the scrubber builds its polylines once, not per frame) records the
 * version it built against and rebuilds only when this moves — which in
 * practice is once per page load, and again only if an in-place rebuild ever
 * re-parses the record.
 */
export function spectatorReplayVersion(): number {
  return version;
}

function extractSnapshots(raw: unknown): SpectatorSnapshot[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const list = (raw as { snapshots?: unknown }).snapshots;
  if (!Array.isArray(list)) return null;

  const clean: SpectatorSnapshot[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const turnNumber = (entry as { turnNumber?: unknown }).turnNumber;
    const players = (entry as { players?: unknown }).players;
    if (
      typeof turnNumber !== "number" ||
      !Number.isFinite(turnNumber) ||
      turnNumber < 0 ||
      !Array.isArray(players)
    ) {
      continue;
    }
    const cleanPlayers: SpectatorSnapshotPlayer[] = [];
    for (const p of players) {
      if (typeof p !== "object" || p === null) continue;
      const username = (p as { username?: unknown }).username;
      const tilesOwned = (p as { tilesOwned?: unknown }).tilesOwned;
      if (typeof username !== "string" || username.length === 0) continue;
      if (
        typeof tilesOwned !== "number" ||
        !Number.isFinite(tilesOwned) ||
        tilesOwned < 0
      ) {
        continue;
      }
      const agentID = (p as { agentID?: unknown }).agentID;
      const playerID = (p as { playerID?: unknown }).playerID;
      const color = (p as { color?: unknown }).color;
      // Same validation shape as tilesOwned, but MISSING IS NOT FATAL: a
      // snapshot without troops or gold is still a usable territory sample, so
      // these degrade to null rather than dropping the player.
      const rawTroops = (p as { troops?: unknown }).troops;
      const rawGold = (p as { gold?: unknown }).gold;
      const finiteOrNull = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
      cleanPlayers.push({
        username,
        agentID: typeof agentID === "string" ? agentID : null,
        playerID:
          typeof playerID === "string" && playerID.length > 0 ? playerID : null,
        tilesOwned,
        troops: finiteOrNull(rawTroops),
        gold: finiteOrNull(rawGold),
        color: typeof color === "string" ? color : null,
      });
    }
    // A snapshot with no readable players still carries a fact — "nobody the
    // capture recognised held land" — but for the race graph it is noise;
    // drop it rather than draw a spurious everyone-to-zero step.
    if (cleanPlayers.length === 0) continue;
    clean.push({
      turnNumber,
      players: cleanPlayers,
      decisions: (entry as { decisions?: unknown }).decisions,
    });
  }

  if (clean.length < 2) return null;

  // Sort by turnNumber and de-dupe (keep the LAST sample for a repeated turn:
  // if the capture side ever wrote a turn twice, the later write is the one
  // that saw more of the match). After this, plot-by-turnNumber is safe.
  clean.sort((a, b) => a.turnNumber - b.turnNumber);
  const deduped: SpectatorSnapshot[] = [];
  for (const s of clean) {
    const prev = deduped[deduped.length - 1];
    if (prev !== undefined && prev.turnNumber === s.turnNumber) {
      deduped[deduped.length - 1] = s;
    } else {
      deduped.push(s);
    }
  }
  return deduped.length >= 2 ? deduped : null;
}
