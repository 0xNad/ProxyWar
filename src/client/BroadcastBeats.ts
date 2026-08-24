/**
 * ============================================================================
 * BROADCAST BEATS — the curated-beats pipeline, re-homed for 0.1.42.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS. Every derivation below is a VERBATIM port out of
 * `AiLeagueReplayOverlay.ts`, which 0.1.42 deletes. That file was ~7,200 lines
 * of league-skin chrome wrapped around ~600 lines of curation, and the
 * curation was the only part any of our surfaces ever needed: the toast stack
 * (`graphics/layers/WarRoomToasts.ts`) harvests `.broadcast-war-room-item`,
 * and the transport (`graphics/layers/BroadcastScrubber.ts`) plus the pacer
 * (`LullDirector.ts`) harvest `.broadcast-timeline-marker` for `data-kind` and
 * the `--broadcast-timeline-position` custom property. When the overlay went,
 * `curatedWarRoomEvents` / `matchTimelineEventMarkers` went with it and all
 * three surfaces measured dead on the reference fixture: 0 markers, 0 scrubber
 * symbols, 0 war-room rows, 0 toasts.
 *
 * `BroadcastComposition.ts` — the RENDERERS — survived 0.1.42 untouched. Only
 * the producers were lost. So this module is producers plus one off-screen
 * host that runs those surviving renderers; not a re-design, and deliberately
 * not a second opinion about what a beat is.
 *
 * THE HOST IS A DATA SOURCE, NOT A SURFACE. `mountBroadcastBeats` renders the
 * war-room feed and the match timeline into a `left: -20000px` host — rendered
 * and laid out, never `display: none`, because the harvesters read real DOM
 * (`getBoundingClientRect` in the window patcher, resolved inline custom
 * properties on the markers). Our own broadcast chrome is the presentation;
 * nothing here is ever meant to be looked at.
 *
 * ENGLISH DEFAULTS, AND WHY THEY ARE HERE. 0.1.42 deleted the entire
 * `ai_league_replay.*` block from `resources/lang` along with the overlay —
 * verified against the built bundle's own `en.json`. `translateText` returns
 * the raw dotted key when a key resolves nowhere, so every headline would read
 * "ai_league_replay.event_eliminated" on air. Each call below therefore passes
 * `translateText`'s third argument, the `defaultText` fallback, carrying the
 * EXACT English string 0.1.35's `resources/lang/en.json` shipped for that key —
 * copied, not rewritten. This is the pattern the codebase already uses for
 * exactly this situation (`WAR_ROOM_KIND_FALLBACKS` in BroadcastComposition.ts,
 * `leadChangeHeadlineDefault` in LeadChangeTracker.ts): a real translation, if
 * the key ever ships again, still wins automatically. The defaults are
 * PRE-INTERPOLATED because `defaultText` is returned as-is and never fed
 * through ICU.
 */
import { AGENT_MESSAGE_EVENT_ID_REGEX } from "../core/Schemas";
import {
  aiLeagueSpectatorDisplayName,
  aiLeagueSpectatorText,
  isAiLeagueReplayRoute,
} from "./AiLeagueReplayMode";
import {
  renderMatchTimeline,
  renderWarRoomEvent,
  renderWarRoomFeed,
  type CuratedWarRoomEvent,
  type CuratedWarRoomEventKind,
  type TimelineMarker,
  type TimelineMarkerKind,
  type WarRoomFeedCallbacks,
} from "./BroadcastComposition";
import { broadcastSpoilersEnabled } from "./graphics/layers/BroadcastScrubber";
import {
  computeLeadChangeBeats,
  leadChangeHeadlineDefault,
  LEAD_CHANGE_HEADLINE_KEY,
  type LeadSample,
  type SeriesLeadChangeBeat,
} from "./LeadChangeTracker";
import {
  spectatorReplaySnapshots,
  spectatorReplayVersion,
  type SpectatorSnapshot,
} from "./SpectatorReplayStore";
import { formatPercentage, translateText } from "./Utils";

// ---------------------------------------------------------------------------
// Artifact shapes (client-local mirrors — client code never imports server
// modules, so this module owns its own runtime shape-checking exactly as the
// overlay did)
// ---------------------------------------------------------------------------

export interface AiLeagueSpectatorEvent {
  id: string;
  sequence: number;
  turnNumber: number;
  kind: string;
  tone: string;
  actorAgentID: string;
  actorName: string;
  targetAgentID: string | null;
  targetName: string | null;
  message: string;
  publicText?: string;
  /** Viewer-only agent-authored claim. Never merge this into publicText. */
  statedReason?: string;
  evidenceLevel?:
    | "confirmed_effect"
    | "accepted_action"
    | "state_derived"
    | "synthetic";
  fallbackUsed?: boolean;
  llmPlannerDegraded?: boolean;
  auditStatus?: string;
  auditReason?: string;
  importance: number;
}

export interface AiLeagueSpectatorTelemetry {
  version: 1;
  runID: string;
  agents: unknown[];
  // Legacy relationship-matrix telemetry. The N×N trust/distrust/tension matrix
  // it backed was removed in favor of the engine-authoritative diplomacy strip;
  // the field is still validated as an array for telemetry-shape compatibility
  // but no longer typed or consumed.
  relationships: unknown[];
  events: AiLeagueSpectatorEvent[];
  communicationThreads: unknown[];
  timelineBuckets: unknown[];
}

/**
 * The decision-log fields the `plan_change` derivation reads, and only those.
 * The overlay's own `AiLeagueDecisionLogEntry` carried two dozen more, every
 * one of them for chrome this module does not render.
 */
export interface BroadcastBeatsDecision {
  sequence: number;
  turnNumber: number;
  username: string;
  /** `null` for a fallback/failure decision with no stated reason — see server `AgentDecision.reason`'s doc. */
  reason: string | null;
  planObjective?: string;
  planRationale?: string;
}

export function normalizeSpectatorTelemetry(
  value: unknown,
): AiLeagueSpectatorTelemetry | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AiLeagueSpectatorTelemetry>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.agents) ||
    !Array.isArray(candidate.relationships) ||
    !Array.isArray(candidate.events) ||
    !Array.isArray(candidate.communicationThreads) ||
    !Array.isArray(candidate.timelineBuckets)
  ) {
    return null;
  }
  return candidate as AiLeagueSpectatorTelemetry;
}

/**
 * Client-local mirror of `AgentMatchStateSeries.ts`'s public shape (product
 * overhaul Season Zero broadcast Phase 5). Client code never imports server
 * modules, so this module owns its own runtime shape-checking of
 * `match-state-series.json` instead.
 */
export type AiLeagueMatchStatePhase = "spawn" | "active" | "finished";

export interface AiLeagueMatchStateSample {
  turn: number;
  phase: AiLeagueMatchStatePhase;
  agents: ReadonlyArray<{
    playerID: string;
    username: string;
    alive: boolean;
    territoryShare: number;
    rank: number;
  }>;
  activeAlliancePairs: ReadonlyArray<readonly [string, string]>;
}

export interface AiLeagueMatchStateSeries {
  totalTurns: number;
  samples: readonly AiLeagueMatchStateSample[];
}

export function normalizeMatchStateSeries(
  value: unknown,
): AiLeagueMatchStateSeries | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.totalTurns !== "number" ||
    !Array.isArray(candidate.samples)
  ) {
    return null;
  }
  for (const sample of candidate.samples) {
    if (
      typeof sample !== "object" ||
      sample === null ||
      typeof (sample as Partial<AiLeagueMatchStateSample>).turn !== "number" ||
      !["spawn", "active", "finished"].includes(
        (sample as Partial<AiLeagueMatchStateSample>).phase as string,
      ) ||
      !Array.isArray((sample as Partial<AiLeagueMatchStateSample>).agents) ||
      !Array.isArray(
        (sample as Partial<AiLeagueMatchStateSample>).activeAlliancePairs,
      )
    ) {
      return null;
    }
    for (const agent of (sample as AiLeagueMatchStateSample).agents) {
      if (
        typeof agent !== "object" ||
        agent === null ||
        typeof agent.playerID !== "string" ||
        typeof agent.username !== "string" ||
        typeof agent.alive !== "boolean" ||
        typeof agent.territoryShare !== "number" ||
        typeof agent.rank !== "number"
      ) {
        return null;
      }
    }
  }
  return candidate as unknown as AiLeagueMatchStateSeries;
}

// ---------------------------------------------------------------------------
// Evidence + deal-fact guards
// ---------------------------------------------------------------------------

/**
 * These legacy event kinds describe an effect even when the underlying
 * record only proves that an action was accepted. Curated/public effect
 * surfaces must require the auditor's confirmed-effect evidence.
 */
const AI_LEAGUE_EFFECT_EVENT_KINDS = new Set([
  "attack",
  "alliance_formed",
  "alliance_break",
  "nuke",
]);

function isAiLeagueEffectEventKind(kind: string): boolean {
  return AI_LEAGUE_EFFECT_EVENT_KINDS.has(kind);
}

function isAiLeagueConfirmedEffectEvent(
  event: AiLeagueSpectatorEvent,
): boolean {
  return (
    !isAiLeagueEffectEventKind(event.kind) ||
    event.evidenceLevel === "confirmed_effect"
  );
}

// Matches AgentDramaReport.ts's own HIGH_IMPORTANCE_THRESHOLD convention —
// the War Room feed is deliberately selective, not a mirror of every event.
const AI_LEAGUE_WAR_ROOM_IMPORTANCE_THRESHOLD = 80;
const AI_LEAGUE_DEAL_EVENT_KINDS = new Set<CuratedWarRoomEventKind>([
  "deal_proposed",
  "deal_accepted",
  "deal_rejected",
  "deal_expired",
  "deal_fulfilled",
  "deal_violated",
]);

function isAiLeagueDealEventKind(
  kind: string,
): kind is Extract<CuratedWarRoomEventKind, `deal_${string}`> {
  return AI_LEAGUE_DEAL_EVENT_KINDS.has(kind as CuratedWarRoomEventKind);
}

/**
 * The action stamp and ledger transition can both describe the same deal fact.
 * Collapse only byte-equivalent facts from the same turn/parties; distinct
 * lifecycle transitions remain separate even when they share a deal ID.
 */
function aiLeagueDealFactKey(event: AiLeagueSpectatorEvent): string {
  return [
    event.turnNumber,
    event.kind,
    event.actorAgentID,
    event.targetAgentID ?? "",
    event.publicText ?? event.message,
  ].join("|");
}

function aiLeagueDealProvenanceDetail(
  event: AiLeagueSpectatorEvent,
): string | null {
  if (event.fallbackUsed === true) {
    return translateText(
      "ai_league_replay.deal_recovered_action",
      undefined,
      "Recovered action — selected by fallback play.",
    );
  }
  if (event.llmPlannerDegraded === true) {
    return translateText(
      "ai_league_replay.deal_degraded_action",
      undefined,
      "Planner degraded for this action.",
    );
  }
  return null;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// message (free-text agent negotiation)
// ---------------------------------------------------------------------------

/**
 * The page global the display kill switch stamps (blocker 5). The serving
 * process reads `PROXYWAR_TUNE_MESSAGE_BEATS_DISPLAY` (AgentTunables) and,
 * only when OFF, injects `window.__PROXYWAR_MESSAGE_BEATS_DISPLAY__ = false`
 * into the replay app shell (`withMessageBeatsDisplayFlag`,
 * ProxyWarDemoServerConfig.ts — declared literally on both sides so no
 * server module is dragged into the bundle). Absent global — the default,
 * every static bundle, every test — means ON. Suppression is DISPLAY ONLY:
 * the record, decisions and telemetry this page loads are untouched, so
 * flipping the switch can never rewrite evidence.
 */
export const MESSAGE_BEATS_DISPLAY_GLOBAL = "__PROXYWAR_MESSAGE_BEATS_DISPLAY__";

function messageBeatsDisplayEnabled(): boolean {
  const value = (globalThis as Record<string, unknown>)[
    MESSAGE_BEATS_DISPLAY_GLOBAL
  ];
  return value !== false && value !== "0" && value !== 0;
}

/**
 * One DELIVERED agent message, extracted from the replay record itself.
 *
 * THE TURN STREAM IS THE SOURCE, deliberately. decisions.jsonl also carries
 * the comms slot and its server-owned event id, while the GameServer now
 * reports every synchronous drop back to the runner as accepted:false. The
 * stamped `agent_message` intent remains the replay authority: if it is in
 * the record, every client simulated it and the recipient's observation
 * carried the same id. Beats built from intents cannot announce a
 * conversation that did not happen.
 */
export interface RecordedAgentMessage {
  /** Stable server-owned join; absent on archived pre-ID records. */
  messageEventID?: string;
  turn: number;
  /** Ordinal in record order — deterministic tiebreak among same-turn beats. */
  sequence: number;
  /** Sender username resolved from the record's own roster (info.players). */
  senderName: string;
  /** Persistent player id exactly as the intent carries it — resolved to a
   * name against the telemetry roster at curation time, never guessed. */
  recipientPlayerID: string;
  text: string;
}

/**
 * Walk a raw game record for delivered `agent_message` intents. Runtime
 * shape-checked like every other artifact this module consumes: the record
 * arrives as parsed JSON, and a malformed turn costs that turn's messages,
 * never the mount. Sender names resolve through `info.players` (clientID →
 * username), which every record carries; a message whose sender is missing
 * from the roster is dropped rather than misattributed.
 */
export function recordedAgentMessages(
  gameRecord: unknown,
): RecordedAgentMessage[] {
  if (gameRecord === null || typeof gameRecord !== "object") return [];
  const record = gameRecord as {
    info?: { players?: unknown };
    turns?: unknown;
  };
  const usernameByClientID = new Map<string, string>();
  if (Array.isArray(record.info?.players)) {
    for (const player of record.info.players) {
      const entry = player as { clientID?: unknown; username?: unknown };
      if (
        typeof entry.clientID === "string" &&
        typeof entry.username === "string"
      ) {
        usernameByClientID.set(entry.clientID, entry.username);
      }
    }
  }
  if (!Array.isArray(record.turns)) return [];
  const messages: RecordedAgentMessage[] = [];
  for (const turn of record.turns) {
    const entry = turn as { turnNumber?: unknown; intents?: unknown };
    if (typeof entry.turnNumber !== "number" || !Array.isArray(entry.intents)) {
      continue;
    }
    for (const intent of entry.intents) {
      const candidate = intent as {
        type?: unknown;
        clientID?: unknown;
        recipient?: unknown;
        text?: unknown;
        messageEventID?: unknown;
      };
      if (
        candidate.type !== "agent_message" ||
        typeof candidate.clientID !== "string" ||
        typeof candidate.recipient !== "string" ||
        typeof candidate.text !== "string" ||
        candidate.text.length === 0
      ) {
        continue;
      }
      const senderName = usernameByClientID.get(candidate.clientID);
      if (senderName === undefined) continue;
      messages.push({
        ...(typeof candidate.messageEventID === "string" &&
        AGENT_MESSAGE_EVENT_ID_REGEX.test(candidate.messageEventID)
          ? { messageEventID: candidate.messageEventID }
          : {}),
        turn: entry.turnNumber,
        sequence: messages.length,
        senderName,
        recipientPlayerID: candidate.recipient,
        text: candidate.text,
      });
    }
  }
  return messages;
}

/**
 * Recipient names come from the telemetry roster (`SpectatorAgent.playerID`
 * → `username`) — the record's own `info.players` has no playerID, and the
 * intent's `recipient` is nothing else. A run without telemetry loses its
 * message beats along with every other WHY surface (the mount's existing
 * best-effort contract), never a beat with a guessed name.
 */
function telemetryPlayerRoster(
  telemetry: AiLeagueSpectatorTelemetry | null,
): Map<string, string> {
  const roster = new Map<string, string>();
  for (const agent of telemetry?.agents ?? []) {
    const entry = agent as { playerID?: unknown; username?: unknown };
    if (
      typeof entry.playerID === "string" &&
      entry.playerID.length > 0 &&
      typeof entry.username === "string"
    ) {
      roster.set(entry.playerID, entry.username);
    }
  }
  return roster;
}

/**
 * Toast cadence: an ordered pair's FIRST message in this many turns is news
 * (tier 2 — the toast stack announces it); the back-and-forth inside the
 * window is transcript (tier 3 — feed and timeline record it, the stack
 * stays quiet, and `groupRoutineWarRoomEvents` collapses the runs). Same
 * editorial rule as deal proposals ("a pact that nobody answered is not
 * news"): the hosted proof exhibition produced 866 messages in one 4-seat
 * episode, and announcing every reply would make the one surface built for
 * news unreadable. Both directions of a conversation are separate ordered
 * pairs, so an opener AND its first reply both toast — exactly the approved
 * reference frame (opener, reply, rival counter-offer, three cards).
 */
const MESSAGE_BEAT_REANNOUNCE_TURNS = 1000;

/**
 * `message` beats — the free-text negotiation feature's viewer surface
 * (war-room feed rows + the toast stack's MESSAGE cards; see severityOf in
 * WarRoomToasts.ts for the gold "sharp" accent).
 *
 * EXCLUSIONS, BY DESIGN (2026-08-17 operator direction): a message is talk,
 * not an effect — the kind stays OUT of AI_LEAGUE_EFFECT_EVENT_KINDS above
 * and out of AgentDramaReport's EFFECT_CLAIM_KINDS, the same discipline as
 * alliance_renewal_offer. No timeline markers either: markers are sparse,
 * positional and spoiler-surfaced, and a talkative match would bury the
 * scrubber's few real symbols under hundreds of envelopes.
 *
 * Headline wording is `chat.agent_message` — the SAME key the participant
 * chat panel uses — so the one conversation is never worded two ways.
 * Names and the agent-authored body all pass the spectator anonymizer.
 */
function messageWarRoomEvents(
  messages: readonly RecordedAgentMessage[],
  telemetry: AiLeagueSpectatorTelemetry | null,
): CuratedWarRoomEvent[] {
  if (messages.length === 0) return [];
  const roster = telemetryPlayerRoster(telemetry);
  const lastAnnouncedTurnByPair = new Map<string, number>();
  const curated: CuratedWarRoomEvent[] = [];
  for (const message of messages) {
    const recipientName = roster.get(message.recipientPlayerID);
    if (recipientName === undefined) continue;
    const sender = aiLeagueSpectatorDisplayName(message.senderName);
    const recipient = aiLeagueSpectatorDisplayName(recipientName);
    // The body is a rival policy's own words — legal play, never markup and
    // never narration. The anonymizer scrubs embedded real names; the
    // renderers only ever assign it through textContent.
    const body = aiLeagueSpectatorText(message.text);
    // Pair key on RAW identities, not display names: flipping Anonymous
    // Names must never change which beats announce.
    const pairKey = `${message.senderName}|${message.recipientPlayerID}`;
    const lastAnnounced = lastAnnouncedTurnByPair.get(pairKey);
    const announces =
      lastAnnounced === undefined ||
      message.turn - lastAnnounced >= MESSAGE_BEAT_REANNOUNCE_TURNS;
    if (announces) {
      lastAnnouncedTurnByPair.set(pairKey, message.turn);
    }
    curated.push({
      id:
        message.messageEventID ?? `message:${message.turn}:${message.sequence}`,
      kind: "message",
      turn: message.turn,
      sequence: message.sequence,
      headline: translateText(
        "chat.agent_message",
        { sender, recipient, msg: body },
        `${sender} → ${recipient}: ${body}`,
      ),
      publicReason: null,
      participants: [sender, recipient],
      expandedDetail: null,
      tier: announces ? 2 : 3,
    });
  }
  return curated;
}

// ---------------------------------------------------------------------------
// plan_change
// ---------------------------------------------------------------------------

/**
 * `plan_change` events, curated from the replay's own decision log
 * (`BroadcastBeatsDecision.planObjective`). Neither AgentDramaReport.ts nor
 * AgentMatchStory.ts model a strategy/plan-shift signal (their
 * "kind"/"storyKind" fields only bucket individual decisions/spectator events,
 * never a change relative to the agent's own prior turn) — this is a genuinely
 * different, already-public, already-derivable signal, so it is used directly
 * rather than reaching for a fabricated heuristic. Selective by construction:
 * only an actual value transition curates an event, and decisions carry no
 * `importance` field to threshold against.
 */
function planChangeWarRoomEvents(
  decisions: readonly BroadcastBeatsDecision[],
): CuratedWarRoomEvent[] {
  const lastPlanByPlayer = new Map<string, string>();
  const curated: CuratedWarRoomEvent[] = [];
  const ordered = [...decisions].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  for (const decision of ordered) {
    const objective =
      typeof decision.planObjective === "string" &&
      decision.planObjective.trim().length > 0
        ? decision.planObjective.trim()
        : null;
    if (objective === null) continue;
    const key = normalizeName(decision.username);
    const previous = lastPlanByPlayer.get(key);
    lastPlanByPlayer.set(key, objective);
    if (previous === undefined || previous === objective) continue;
    const actor = aiLeagueSpectatorDisplayName(decision.username);
    curated.push({
      id: `plan-change:${decision.sequence}`,
      kind: "plan_change",
      turn: decision.turnNumber,
      sequence: decision.sequence,
      headline: translateText(
        "ai_league_replay.event_plan_change",
        { actor, plan: objective },
        `${actor} shifts plan to ${objective}`,
      ),
      publicReason: decision.reason,
      participants: [actor],
      expandedDetail:
        typeof decision.planRationale === "string" &&
        decision.planRationale.trim().length > 0
          ? decision.planRationale.trim()
          : null,
      tier: 2,
    });
  }
  return curated;
}

// ---------------------------------------------------------------------------
// lead_change
// ---------------------------------------------------------------------------

/**
 * The lead-change derivation runs once per DISTINCT raw artifact object,
 * not once per call: the host re-runs curatedWarRoomEvents on every
 * playhead-sync callback, and the raw `matchStateSeries` object's identity
 * only ever changes on a fresh mount, so WeakMap memos make the added
 * per-call cost of normalize + derive a map lookup instead of a full
 * 80-sample re-validation per frame. WeakMap (not a mount-scoped variable) so
 * the cache needs no lifecycle wiring and dies with the artifact object
 * itself.
 */
const AI_LEAGUE_SERIES_NORM_MEMO = new WeakMap<
  object,
  AiLeagueMatchStateSeries | null
>();
function memoizedMatchStateSeries(
  raw: unknown,
): AiLeagueMatchStateSeries | null {
  if (raw === null || typeof raw !== "object") return null;
  if (!AI_LEAGUE_SERIES_NORM_MEMO.has(raw)) {
    AI_LEAGUE_SERIES_NORM_MEMO.set(raw, normalizeMatchStateSeries(raw));
  }
  return AI_LEAGUE_SERIES_NORM_MEMO.get(raw) ?? null;
}

const AI_LEAGUE_LEAD_CHANGE_MEMO = new WeakMap<
  AiLeagueMatchStateSeries,
  readonly SeriesLeadChangeBeat[]
>();

/**
 * THE STATIC BUNDLE HAS NO `match-state-series.json`, AND NEVER WILL.
 *
 * Measured at r72 on the 0.1.35 tree: 195 timeline markers on Black Sea and
 * 164 on Pangaea, with ZERO `lead_change` on either — on the very fixture
 * `design/REPLAY_BRIEF.md` §3 documents as the one whose spine IS the lead
 * changing hands. The beats were not being filtered out downstream; they were
 * never produced, because the bundle is offline by design and there is no
 * artifact server to fetch `match-state-series.json` from in the first place.
 * 0.1.42 makes that permanent rather than incidental: it deletes
 * `AiLeagueReplayArtifacts` outright, so NO route fetches the series any more,
 * hosted or bundled.
 *
 * THE SERIES IS ALREADY IN MEMORY. `spectatorReplay.snapshots` — the
 * envelope's own periodic whole-board samples, retained by
 * SpectatorReplayStore — is what draws the territory-race graph under the
 * transport, so it is populated and correct on precisely the surface where
 * the beats were missing.
 *
 * PRECEDENCE: the server artifact always wins when it exists (it is the
 * canonical derivation, and two sources agreeing is the whole point of
 * mirroring `computeLeadChanges`). The snapshots are consulted only when it
 * is absent, and the RULES DO NOT CHANGE — same margin, same next-sample
 * confirmation, same recorded turn. This function only changes where samples
 * come from, never what counts as a lead change.
 */
let leadChangeSnapshotMemo: {
  version: number;
  beats: readonly SeriesLeadChangeBeat[];
} | null = null;

function aiLeagueLeadChangeBeats(
  series: AiLeagueMatchStateSeries | null,
): readonly SeriesLeadChangeBeat[] {
  if (series === null) return spectatorSnapshotLeadChangeBeats();
  let beats = AI_LEAGUE_LEAD_CHANGE_MEMO.get(series);
  if (beats === undefined) {
    beats = computeLeadChangeBeats(series.samples);
    AI_LEAGUE_LEAD_CHANGE_MEMO.set(series, beats);
  }
  return beats;
}

/**
 * Lead-change beats off the envelope's snapshot series, memoized by the
 * store's version counter (the series is match-static, so this runs once per
 * loaded record — `curatedWarRoomEvents` re-runs on every playhead sync, and
 * a 29-sample re-derivation per frame would be pure waste). A module-level
 * memo rather than a WeakMap because the store hands back the same array
 * identity anyway and the version counter is the honest cache key: it is what
 * moves when a new match record is published.
 */
function spectatorSnapshotLeadChangeBeats(): readonly SeriesLeadChangeBeat[] {
  const version = spectatorReplayVersion();
  if (leadChangeSnapshotMemo?.version === version) {
    return leadChangeSnapshotMemo.beats;
  }
  const beats = computeLeadChangeBeats(
    leadSamplesFromSpectatorSnapshots(spectatorReplaySnapshots()),
  );
  leadChangeSnapshotMemo = { version, beats };
  return beats;
}

/**
 * Adapt `spectatorReplay.snapshots` into the `LeadSample` shape
 * `computeLeadChangeBeats` already consumes. Every field is measured, not
 * inferred — the two places this series is shaped differently from the
 * server artifact are called out below, because both are places where it
 * would be easy to invent a fact the data does not carry.
 *
 * `territoryShare` = the player's `tilesOwned` over the SUM of tilesOwned in
 * that same snapshot. That is the identical quantity the server's share is
 * ("share of all claimed tiles"): a vanished player owns nothing, so the two
 * denominators agree, and the 3-point margin gate therefore measures the same
 * thing here as it does there.
 *
 * `rank` is recomputed to the server's exact ordering — tilesOwned desc,
 * troops desc, playerID asc — which this series can now express because the
 * capture writes `troops` per player per snapshot and the store retains it.
 * `leaderOf` selects on min-rank, so reproducing the ordering reproduces the
 * leader selection including its tiebreaks. When a snapshot omits troops the
 * ordering degrades to tilesOwned desc then playerID asc, which is the same
 * sort with one term missing, never a different rule.
 *
 * `alive` is presence-with-land. This series has no usable liveness field —
 * see the store's own gotcha list: `isAlive` is `true` for every player in
 * every snapshot even after twelve eliminations, and the eliminated simply
 * stop appearing. `tilesOwned > 0` is the honest reading, and it is also the
 * only one `leaderOf` needs (it picks the top of the living pool, and a
 * landless agent is never that).
 *
 * THE SPAWN SNAPSHOT IS NOT A STANDING. `computeLeadChangeBeats` already
 * refuses to read a leader out of the spawn phase — its pre-spawn filter
 * drops any sample where nobody has claimed territory. That filter is written
 * against the SERVER artifact, where the spawn phase reads as zero share; on
 * this series the spawn allocation reads as a real tile count, so the filter's
 * intent has to be honoured here instead of silently missing. Measured on the
 * Pangaea fixture: t400 has all sixteen players on exactly 52 tiles, 62,518
 * troops and 209,800 gold, identical to the digit. There is no leader in that
 * snapshot, only a tiebreak — and treating it as the baseline manufactured a
 * beat ("Andre von Houck takes the lead from Jordan" at t2000) describing an
 * overtake of someone who never led. A snapshot whose agents are all exactly
 * level carries no standing, so it is not offered as one. This is the
 * existing rule's intent applied to a differently-shaped source, NOT a new
 * suppression rule: nothing here loosens or tightens what counts as a lead
 * change once there is a real standing to change.
 *
 * WHAT THIS SERIES CANNOT DO, stated plainly rather than papered over: the
 * cadence is irregular and front-loaded sparse (400, 2000, 3600, 5200, then
 * 800s, then 400s, then 200s and 100s to the end). A beat is recorded at the
 * TRANSITION SAMPLE's turn — the server's own convention — so early in a
 * match the recorded turn can trail the real crossing by most of a sample
 * gap. The beats this actually yields on the fixture all land at t6000 or
 * later, where the spacing is 800 turns or tighter and the decisive one at
 * t10000 is confirmed over a 400-turn window, so nothing is being placed with
 * more precision than the samples support. If a future capture cadence went
 * coarser, that claim would need re-checking before trusting an early mark.
 */
function leadSamplesFromSpectatorSnapshots(
  snapshots: readonly SpectatorSnapshot[] | null,
): LeadSample[] {
  if (snapshots === null) return [];
  const samples: LeadSample[] = [];
  for (const snapshot of snapshots) {
    let totalTiles = 0;
    for (const player of snapshot.players) totalTiles += player.tilesOwned;
    if (totalTiles <= 0) continue;
    // A FIELD all exactly level == the spawn allocation, which is not a
    // standing. See this function's doc for the measurement behind it. The
    // >= 2 guard matters at the other end of the match: a snapshot down to a
    // single surviving player is trivially "all level" and has an entirely
    // unambiguous leader, and dropping the tail would strip the next-sample
    // confirmation a late beat depends on.
    const first = snapshot.players[0];
    const allLevel =
      snapshot.players.length >= 2 &&
      snapshot.players.every(
        (player) => player.tilesOwned === first.tilesOwned,
      );
    if (allLevel) continue;
    const agents = snapshot.players.map((player) => ({
      playerID: player.playerID ?? player.username,
      username: player.username,
      alive: player.tilesOwned > 0,
      territoryShare: player.tilesOwned / totalTiles,
      tilesOwned: player.tilesOwned,
      troops: player.troops ?? 0,
      // Overwritten immediately below; declared here so the ranked objects
      // are one allocation rather than a copy per agent.
      rank: 0,
    }));
    const ordered = [...agents].sort(
      (a, b) =>
        b.tilesOwned - a.tilesOwned ||
        b.troops - a.troops ||
        (a.playerID < b.playerID ? -1 : a.playerID > b.playerID ? 1 : 0),
    );
    ordered.forEach((agent, index) => {
      agent.rank = index + 1;
    });
    samples.push({ turn: snapshot.turnNumber, agents });
  }
  return samples;
}

/**
 * ONE headline builder shared by the War Room row and the timeline marker so
 * the same beat is never worded two ways — and, just as important, never
 * RE-worded: the toast layer keys already-announced rows by kind+turn+headline
 * text, so any wording drift for an already-emitted event re-announces it.
 * Names resolve through aiLeagueSpectatorDisplayName like every other curated
 * headline.
 *
 * IT STATES BOTH SHARES, not just both names. The surface that carries this
 * beat hardest renders the headline and NOTHING else — the toast
 * (`WarRoomToasts` harvests `.broadcast-war-room-headline`). Leaving the
 * numbers in `expandedDetail` alone meant the only place a viewer could learn
 * how big the overtake was was a drawer row they had to open, which is the
 * opposite of a broadcast cut. The shares are the beat's own, at the
 * transition sample, from the series it was derived from — never fabricated.
 *
 * The template itself lives in LeadChangeTracker.ts, not here: BroadcastScrubber
 * renders the identical template around sentinels to read `{actor}` back out
 * of a harvested marker label (that is how its ♔ finds the taking nation's
 * seat colour), and a wording change on one side only would silently break
 * the other. Its lang key ships with a pre-interpolated English default
 * (translateText's defaultText contract) because resources/lang is owned by
 * another workstream; a real translation, once added, wins automatically.
 */
function aiLeagueLeadChangeHeadline(beat: SeriesLeadChangeBeat): string {
  const actor = aiLeagueSpectatorDisplayName(beat.toUsername);
  const target = aiLeagueSpectatorDisplayName(beat.fromUsername);
  const toShare = formatPercentage(beat.toShare);
  const fromShare = formatPercentage(beat.fromShare);
  return translateText(
    LEAD_CHANGE_HEADLINE_KEY,
    { actor, target, toShare, fromShare },
    leadChangeHeadlineDefault(actor, target, toShare, fromShare),
  );
}

/**
 * `lead_change` events. Detection + hysteresis live in
 * `computeLeadChangeBeats` (client/LeadChangeTracker.ts): an EXACT mirror of
 * the server's canonical `computeLeadChanges`
 * (AgentMatchStateDerivations.ts) — the new leader must clear the outgoing one
 * by >= 3 points of claimed territory at the transition sample AND still be
 * leading at the next sampled point — so this feed, the scorebug's crown, and
 * the server-published decisive moments never tell three different stories
 * about when the lead changed. The event's turn is the transition sample's
 * turn (the server's own convention); consumers all window on
 * `turn <= playhead`, so nothing leaks ahead of the viewer.
 */
function leadChangeWarRoomEvents(
  series: AiLeagueMatchStateSeries | null,
): CuratedWarRoomEvent[] {
  return aiLeagueLeadChangeBeats(series).map((beat) => {
    const actor = aiLeagueSpectatorDisplayName(beat.toUsername);
    const target = aiLeagueSpectatorDisplayName(beat.fromUsername);
    return {
      id: `lead-change:${beat.turn}:${beat.toPlayerID}`,
      kind: "lead_change" as const,
      turn: beat.turn,
      // The series carries no telemetry sequence ordinal. 0 sorts a lead
      // change ahead of any same-turn telemetry event (real sequences are
      // positive) — an arbitrary but DETERMINISTIC position, which is all
      // patchDomWindowForward's position-indexed incremental patching needs.
      sequence: 0,
      headline: aiLeagueLeadChangeHeadline(beat),
      publicReason: null,
      participants: [actor, target],
      // The before/after-territory read the curation spec always wanted on
      // this kind: both shares AT the transition sample, from the same
      // series the beat itself was derived from — never a fabricated value.
      expandedDetail: translateText(
        "ai_league_replay.event_lead_change_detail",
        {
          actor,
          target,
          toShare: formatPercentage(beat.toShare),
          fromShare: formatPercentage(beat.fromShare),
        },
        `${actor} ${formatPercentage(beat.toShare)} vs ${target} ${formatPercentage(beat.fromShare)} of claimed land at the overtake`,
      ),
      // Tier 1: "who is actually winning changed" is the single most
      // watchable fact a standings-based broadcast can announce — the same
      // reasoning AgentDecisiveMoments.ts records for raising lead_change's
      // scoring floor.
      tier: 1 as const,
    };
  });
}

// ---------------------------------------------------------------------------
// Tiering + grouping
// ---------------------------------------------------------------------------

/**
 * Impact proxy for War Room tiering: the raw telemetry carries no per-strike
 * magnitude field at all — every "attack" event is emitted at a flat
 * importance=70 regardless of how much territory changed hands (verified
 * against production spectator-telemetry.json: every attack across a full
 * match sampled at exactly importance 70, elimination at exactly 90 — there is
 * no variance to read a "was this the biggest hit of the match" signal from).
 * So a first strike's own importance can never distinguish "routine" from
 * "notable". The closest signal actually present in the data: did either
 * participant go on to matter to the match's outcome (get eliminated, or
 * enter/break an alliance) at some point? A first strike touching one of
 * those agents is "notable" (tier 2); one between two agents who never
 * appear in a major moment for the rest of the match is "routine" (tier
 * 3) and gets collapsed by groupRoutineWarRoomEvents below.
 */
function consequentialAgentIDs(
  events: readonly AiLeagueSpectatorEvent[],
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const isMajor =
      event.kind === "elimination" ||
      (isAiLeagueConfirmedEffectEvent(event) &&
        (event.kind === "alliance_formed" ||
          (event.kind === "alliance_break" && event.tone === "betrayal"))) ||
      event.kind === "deal_accepted" ||
      event.kind === "deal_fulfilled" ||
      event.kind === "deal_violated";
    if (!isMajor) continue;
    ids.add(event.actorAgentID);
    if (event.targetAgentID !== null) ids.add(event.targetAgentID);
  }
  return ids;
}

/**
 * Collapses consecutive runs of tier-3 "routine" War Room events (length
 * >= 2) into ONE synthetic tier-3 summary event per run: on a large match,
 * routine first-strike noise between agents that never become consequential is
 * exactly what floods the list. A lone tier-3 event with no adjacent
 * tier-3 neighbor is left as-is (nothing to group). A run never crosses a
 * tier-1/2 event, so grouping only ever merges rows that were already
 * sitting next to each other in the curated order.
 *
 * Applied ONCE to the full ordered array `curatedWarRoomEvents` returns
 * (never per-tick or per-window-slice), so the same underlying events
 * always collapse into the same group across ticks — required for
 * `patchWarRoomWindowForward`'s position-indexed incremental patching over
 * this array to stay correct.
 */
function groupRoutineWarRoomEvents(
  events: readonly CuratedWarRoomEvent[],
): CuratedWarRoomEvent[] {
  const grouped: CuratedWarRoomEvent[] = [];
  let run: CuratedWarRoomEvent[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      grouped.push(run[0]);
    } else {
      const first = run[0];
      const last = run[run.length - 1];
      const participants = [...new Set(run.flatMap((e) => e.participants))];
      // A collapsed run of quiet negotiation is "+N more messages", not
      // "+N more skirmishes" — a mixed run keeps the incumbent wording,
      // because combat noise is what floods mixed runs.
      const allMessages = run.every((event) => event.kind === "message");
      grouped.push({
        id: `war-room-group:${first.id}:${last.id}`,
        kind: last.kind,
        turn: last.turn,
        sequence: last.sequence,
        headline: allMessages
          ? translateText(
              "ai_league_replay.war_room_grouped_messages",
              { count: run.length },
              `+${run.length} more ${run.length === 1 ? "message" : "messages"}`,
            )
          : translateText(
              "ai_league_replay.war_room_grouped_skirmishes",
              { count: run.length },
              `+${run.length} more ${run.length === 1 ? "skirmish" : "skirmishes"}`,
            ),
        publicReason: null,
        participants,
        expandedDetail: run
          .map(
            (e) =>
              `${translateText("broadcast.war_room_turn", { turn: e.turn })} — ${e.headline}`,
          )
          .join("\n"),
        tier: 3,
      });
    }
    run = [];
  };
  for (const event of events) {
    if (event.tier === 3) {
      run.push(event);
    } else {
      flushRun();
      grouped.push(event);
    }
  }
  flushRun();
  return grouped;
}

// ---------------------------------------------------------------------------
// The two producers our surfaces harvest
// ---------------------------------------------------------------------------

/**
 * Curated War Room feed. Selective by kind:
 *  - alliance/betrayal/nuke/elimination gate on
 *    AI_LEAGUE_WAR_ROOM_IMPORTANCE_THRESHOLD (matching AgentDramaReport.ts's
 *    own HIGH_IMPORTANCE_THRESHOLD) — a no-op in practice today (these kinds
 *    are always emitted at 90+ importance server-side) but an honest,
 *    future-proof guard rather than an unconditional pass-through.
 *  - first_strike is selective by construction (first attack per ordered
 *    pair only) rather than by importance: raw "attack" events are emitted
 *    at importance 70, structurally below the threshold, so gating on
 *    importance here would silently drop every first strike.
 *  - elimination events (`addEliminationEvents`) never carry a target — the
 *    eliminated agent IS the actor — so the headline is built from `actor`
 *    alone. Never credit a kill: the artifacts carry no attacker.
 *  - lead_change gates on neither importance nor telemetry at all: it is
 *    derived from the sampled match-state series via
 *    leadChangeWarRoomEvents (see that function's own doc for the
 *    margin + next-sample hysteresis and why it mirrors the server's
 *    canonical rule exactly). A null/absent series falls back to the
 *    envelope's own snapshots — never a fabricated beat.
 *
 * Every event is classified into a tier (see CuratedWarRoomEvent.tier's own
 * doc and consequentialAgentIDs above), then consecutive tier-3 runs are
 * collapsed via groupRoutineWarRoomEvents before returning — the RETURNED
 * array is already the one every caller should render directly.
 */
export function curatedWarRoomEvents(
  telemetry: AiLeagueSpectatorTelemetry | null,
  decisions: readonly BroadcastBeatsDecision[],
  matchStateSeries: AiLeagueMatchStateSeries | null,
  agentMessages: readonly RecordedAgentMessage[] = [],
): CuratedWarRoomEvent[] {
  const curated: CuratedWarRoomEvent[] = [];
  const firstStrikeSeen = new Set<string>();
  const dealFactsSeen = new Set<string>();
  const dealProposalPairSeen = new Set<string>();
  const consequential = consequentialAgentIDs(telemetry?.events ?? []);
  const ordered = [...(telemetry?.events ?? [])].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  for (const event of ordered) {
    if (!isAiLeagueConfirmedEffectEvent(event)) continue;
    const actor = aiLeagueSpectatorDisplayName(event.actorName);
    const target =
      event.targetName !== null
        ? aiLeagueSpectatorDisplayName(event.targetName)
        : null;
    // Keep every server/referee fact separate from an agent-authored claim.
    // Both still pass through the spectator-text anonymizer so names cannot
    // leak when Anonymous Names is enabled.
    const serverFact = aiLeagueSpectatorText(event.publicText ?? event.message);
    const agentClaim =
      typeof event.statedReason === "string" &&
      event.statedReason.trim().length > 0
        ? aiLeagueSpectatorText(event.statedReason.trim())
        : null;

    if (isAiLeagueDealEventKind(event.kind)) {
      const factKey = aiLeagueDealFactKey(event);
      if (dealFactsSeen.has(factKey)) continue;
      dealFactsSeen.add(factKey);
      if (event.kind === "deal_proposed") {
        const pairKey = `${event.actorAgentID}|${event.targetAgentID ?? ""}`;
        if (dealProposalPairSeen.has(pairKey)) continue;
        dealProposalPairSeen.add(pairKey);
      }
      curated.push({
        id: event.id,
        kind: event.kind,
        turn: event.turnNumber,
        sequence: event.sequence,
        // Server-authored/referee-authored fact. The agent's own words stay
        // in publicReason below, where BroadcastComposition labels them as a
        // claim rather than verified reasoning.
        headline: serverFact,
        publicReason: agentClaim,
        participants: target !== null ? [actor, target] : [actor],
        expandedDetail: aiLeagueDealProvenanceDetail(event),
        // A PACT THAT NOBODY ANSWERED IS NOT NEWS.
        //
        // Signed, fulfilled and violated pacts are the beats — something
        // actually changed between two nations. Proposals, rejections and
        // expiries are the churn around them, and on the reference fixture
        // there are 54 proposals and 19 expiries against 3 signings: 19 of 22
        // pacts simply lapsed unanswered. At tier 2 every one of those toasted,
        // so the single most common NON-event in the data was the thing most
        // often on air, at the same size and duration as an elimination.
        //
        // Tier 3 keeps them in the feed, on the timeline and in the analyst
        // record — nothing is lost — while the toast stack stops announcing
        // them, because it skips tier 3 by design.
        tier:
          event.kind === "deal_accepted" ||
          event.kind === "deal_fulfilled" ||
          event.kind === "deal_violated"
            ? 1
            : 3,
      });
      continue;
    }

    if (event.kind === "attack" && target !== null) {
      const pairKey = `${event.actorAgentID}|${event.targetAgentID ?? target}`;
      if (!firstStrikeSeen.has(pairKey)) {
        firstStrikeSeen.add(pairKey);
        const isConsequential =
          consequential.has(event.actorAgentID) ||
          (event.targetAgentID !== null &&
            consequential.has(event.targetAgentID));
        curated.push({
          id: event.id,
          kind: "first_strike",
          turn: event.turnNumber,
          sequence: event.sequence,
          headline: translateText(
            "ai_league_replay.headline_first_strike",
            { actor, target },
            `${actor} strikes ${target}`,
          ),
          publicReason: null,
          participants: [actor, target],
          expandedDetail: null,
          tier: isConsequential ? 2 : 3,
        });
      }
      continue;
    }
    if (event.importance < AI_LEAGUE_WAR_ROOM_IMPORTANCE_THRESHOLD) continue;
    if (event.kind === "alliance_formed" && target !== null) {
      curated.push({
        id: event.id,
        kind: "alliance",
        turn: event.turnNumber,
        sequence: event.sequence,
        headline: translateText(
          "ai_league_replay.event_alliance_formed",
          { actor, target },
          `${actor} and ${target} form an alliance`,
        ),
        publicReason: null,
        participants: [actor, target],
        expandedDetail: null,
        tier: 1,
      });
      continue;
    }
    if (
      event.kind === "alliance_break" &&
      event.tone === "betrayal" &&
      target !== null
    ) {
      curated.push({
        id: event.id,
        kind: "betrayal",
        turn: event.turnNumber,
        sequence: event.sequence,
        headline: translateText(
          "ai_league_replay.headline_betrayal",
          { actor, target },
          `${actor} breaks alliance with ${target}`,
        ),
        publicReason: null,
        participants: [actor, target],
        expandedDetail: null,
        tier: 1,
      });
      continue;
    }
    // Nuke launches are importance 95 server-side, the single
    // highest-importance event kind this pipeline emits. ANNOUNCE THE LAUNCH,
    // NEVER THE HIT: every nuke arrives with `auditStatus: unknown`, so the
    // wording is escalation/pressure, never an outcome. Tier 1: a WMD strike
    // is exactly the kind of event this feed's own "major" tier exists for.
    if (event.kind === "nuke") {
      curated.push({
        id: event.id,
        kind: "nuke",
        turn: event.turnNumber,
        sequence: event.sequence,
        headline:
          target !== null
            ? translateText(
                "ai_league_replay.event_nuke_target",
                { actor, target },
                `${actor} escalates nuclear pressure against ${target}`,
              )
            : translateText(
                "ai_league_replay.event_nuke",
                { actor },
                `${actor} escalates nuclear pressure`,
              ),
        publicReason: null,
        participants: target !== null ? [actor, target] : [actor],
        expandedDetail: null,
        tier: 1,
      });
      continue;
    }
    if (event.kind === "elimination") {
      curated.push({
        id: event.id,
        kind: "elimination",
        turn: event.turnNumber,
        sequence: event.sequence,
        headline: translateText(
          "ai_league_replay.event_eliminated",
          { actor },
          `${actor} is eliminated`,
        ),
        publicReason: null,
        participants: [actor],
        expandedDetail: null,
        tier: 1,
      });
    }
  }
  curated.push(...planChangeWarRoomEvents(decisions));
  curated.push(...leadChangeWarRoomEvents(matchStateSeries));
  // The blocker-5 kill switch gates ONLY this push: with the page global
  // stamped false, the feed simply carries no message beats while every
  // other beat — and every artifact — is untouched.
  if (messageBeatsDisplayEnabled()) {
    curated.push(...messageWarRoomEvents(agentMessages, telemetry));
  }
  const sorted = curated.sort(
    (a, b) => a.turn - b.turn || a.sequence - b.sequence,
  );
  return groupRoutineWarRoomEvents(sorted);
}

/**
 * `spawn`/`alliance`/`first_strike`/`betrayal`/`nuke`/`elimination` markers,
 * derived from the same telemetry events as the War Room feed (unfiltered by
 * importance here — timeline markers are inherently sparse/positional, not a
 * feed that needs curating down). `lead_change` markers come from the
 * sampled match-state series — the SAME beats, rule and memo as
 * leadChangeWarRoomEvents (see that function's doc), with the SAME headline
 * builder, so the marker tooltip and the War Room row never word one beat
 * two ways.
 *
 * NEVER DERIVE WHERE. A marker carries a TURN and a label, never a tile: the
 * artifacts carry no position for an attack, so nothing downstream may be
 * offered one.
 */
export function matchTimelineEventMarkers(
  telemetry: AiLeagueSpectatorTelemetry | null,
  matchStateSeries: AiLeagueMatchStateSeries | null,
): TimelineMarker[] {
  const markers: TimelineMarker[] = [];
  const firstStrikeSeen = new Set<string>();
  const dealFactsSeen = new Set<string>();
  const ordered = [...(telemetry?.events ?? [])].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  const push = (
    kind: TimelineMarkerKind,
    event: AiLeagueSpectatorEvent,
    label: string,
  ) => {
    markers.push({
      kind,
      turn: event.turnNumber,
      sequence: event.sequence,
      label,
    });
  };
  for (const event of ordered) {
    if (!isAiLeagueConfirmedEffectEvent(event)) continue;
    const actor = aiLeagueSpectatorDisplayName(event.actorName);
    const target =
      event.targetName !== null
        ? aiLeagueSpectatorDisplayName(event.targetName)
        : null;
    if (isAiLeagueDealEventKind(event.kind)) {
      const factKey = aiLeagueDealFactKey(event);
      if (dealFactsSeen.has(factKey)) continue;
      dealFactsSeen.add(factKey);
      push(
        event.kind,
        event,
        aiLeagueSpectatorText(event.publicText ?? event.message),
      );
      continue;
    }
    switch (event.kind) {
      case "spawn":
        push(
          "spawn",
          event,
          translateText(
            "ai_league_replay.event_spawn",
            { actor },
            `${actor} enters the match`,
          ),
        );
        break;
      case "alliance_formed":
        if (target !== null) {
          push(
            "alliance",
            event,
            translateText(
              "ai_league_replay.event_alliance_formed",
              { actor, target },
              `${actor} and ${target} form an alliance`,
            ),
          );
        }
        break;
      case "alliance_break":
        if (event.tone === "betrayal" && target !== null) {
          push(
            "betrayal",
            event,
            translateText(
              "ai_league_replay.headline_betrayal",
              { actor, target },
              `${actor} breaks alliance with ${target}`,
            ),
          );
        }
        break;
      case "attack":
        if (target !== null) {
          const pairKey = `${event.actorAgentID}|${event.targetAgentID ?? target}`;
          if (!firstStrikeSeen.has(pairKey)) {
            firstStrikeSeen.add(pairKey);
            push(
              "first_strike",
              event,
              translateText(
                "ai_league_replay.headline_first_strike",
                { actor, target },
                `${actor} strikes ${target}`,
              ),
            );
          }
        }
        break;
      case "nuke":
        push(
          "nuke",
          event,
          target !== null
            ? translateText(
                "ai_league_replay.event_nuke_target",
                { actor, target },
                `${actor} escalates nuclear pressure against ${target}`,
              )
            : translateText(
                "ai_league_replay.event_nuke",
                { actor },
                `${actor} escalates nuclear pressure`,
              ),
        );
        break;
      case "elimination":
        push(
          "elimination",
          event,
          translateText(
            "ai_league_replay.event_eliminated",
            { actor },
            `${actor} is eliminated`,
          ),
        );
        break;
      default:
        break;
    }
  }
  for (const beat of aiLeagueLeadChangeBeats(matchStateSeries)) {
    markers.push({
      kind: "lead_change",
      turn: beat.turn,
      sequence: 0,
      label: aiLeagueLeadChangeHeadline(beat),
    });
  }
  return markers;
}

/** The canonical record range (same value already used for the Clip control
 * and as `replayMaxTurn`) — falls back to the highest observed turn number
 * across decisions/events only while that canonical bound has not arrived
 * yet. */
function beatsFinishTurn(
  replayMaxTurn: number | null | undefined,
  decisions: readonly BroadcastBeatsDecision[],
  telemetry: AiLeagueSpectatorTelemetry | null,
): number {
  if (typeof replayMaxTurn === "number" && replayMaxTurn > 0) {
    return replayMaxTurn;
  }
  const decisionMax = decisions.reduce(
    (max, decision) => Math.max(max, decision.turnNumber),
    0,
  );
  const eventMax = (telemetry?.events ?? []).reduce(
    (max, event) => Math.max(max, event.turnNumber),
    0,
  );
  return Math.max(1, decisionMax, eventMax);
}

// ---------------------------------------------------------------------------
// Bounded DOM window (ported verbatim — the harvesters read this list)
// ---------------------------------------------------------------------------

const AI_LEAGUE_TICKER_DOM_WINDOW = 60;

interface WarRoomWindowCallbacks extends WarRoomFeedCallbacks {
  /** Grows the DOM window by AI_LEAGUE_TICKER_DOM_WINDOW and re-renders — the manual backfill affordance. Only ever rendered as a row when there is something older to reveal. */
  onShowEarlier: () => void;
}

/**
 * Count of `sortedByTurn` items (ascending by `turnOf`) eligible at
 * `turnNumber`. Equivalent to `sortedByTurn.filter(x => turnOf(x) <=
 * turnNumber).length` but O(log n) instead of O(n) — this re-runs on every
 * `ai-league-replay-frame` tick against the full, unbounded set.
 */
function domEligibleCount<T>(
  sortedByTurn: readonly T[],
  turnOf: (item: T) => number,
  turnNumber: number,
): number {
  let lo = 0;
  let hi = sortedByTurn.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (turnOf(sortedByTurn[mid]!) <= turnNumber) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** First eligible index still inside a DOM window of `windowSize`, given `eligibleCount` total eligible items. */
function domWindowStart(eligibleCount: number, windowSize: number): number {
  return Math.max(0, eligibleCount - windowSize);
}

/**
 * Inserts, updates, or removes the shared "N earlier" backfill row/button
 * for a bounded list, so the affordance itself never needs a list rebuild
 * just to update its own hidden count as the window slides forward.
 */
function syncDomWindowEarlierRow(
  list: HTMLElement,
  earlierSelector: string,
  hiddenCount: number,
  buildEarlierRow: (hiddenCount: number) => HTMLElement,
  earlierLabel: (hiddenCount: number) => string,
): void {
  const earlierRow = list.querySelector<HTMLElement>(earlierSelector);
  if (hiddenCount > 0) {
    if (earlierRow === null) {
      list.prepend(buildEarlierRow(hiddenCount));
    } else {
      const button = earlierRow.querySelector("button");
      if (button !== null) {
        button.textContent = earlierLabel(hiddenCount);
      }
    }
  } else {
    earlierRow?.remove();
  }
}

/**
 * Generic DOM-window incremental-append/prune primitive: for a pure forward
 * tick (more eligible items, same window size), appends the newly eligible
 * rows and prunes whichever rows the sliding window drops off the front,
 * WITHOUT tearing down or rebuilding rows that stay in the window. Retained
 * rows keep their exact DOM node identity — which is what keeps
 * `WarRoomToasts`'s already-announced set stable across ticks instead of
 * re-announcing the whole visible feed on every frame.
 *
 * The append source is NEVER `[prevEligibleCount, nextEligibleCount)` —
 * for a jump bigger than the window (a long idle tick, a forward
 * seek/jump-to-turn that crosses hundreds of eligible items at once) that
 * range is far wider than `windowSize` and would silently defeat the
 * whole DOM cap (a real, shipped regression this exact bound fixed). Only the
 * slice that actually lands inside the new window —
 * `[max(prevEligibleCount, nextStart), nextEligibleCount)` — may ever be
 * appended; anything older than `nextStart` was already excluded by the
 * removal loop below (or never mounted to begin with).
 */
function patchDomWindowForward<T>(
  list: HTMLElement,
  rowSelector: string,
  allItems: readonly T[],
  prevEligibleCount: number,
  nextEligibleCount: number,
  windowSize: number,
  buildRow: (item: T) => HTMLElement,
  syncEarlier: (hiddenCount: number) => void,
): void {
  const prevStart = domWindowStart(prevEligibleCount, windowSize);
  const nextStart = domWindowStart(nextEligibleCount, windowSize);
  const removedCount = nextStart - prevStart;

  const rows = list.querySelectorAll<HTMLElement>(rowSelector);
  for (let i = 0; i < removedCount && i < rows.length; i++) {
    rows[i]!.remove();
  }
  const appendStart = Math.max(prevEligibleCount, nextStart);
  for (const item of allItems.slice(appendStart, nextEligibleCount)) {
    list.append(buildRow(item));
  }

  syncEarlier(nextStart);
}

function warRoomEarlierLabel(count: number): string {
  return translateText(
    "broadcast.war_room_show_earlier",
    { count },
    `Show ${count} earlier`,
  );
}

function buildWarRoomEarlierRow(
  hiddenCount: number,
  onShowEarlier: () => void,
): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "broadcast-war-room-earlier";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "broadcast-war-room-earlier-button";
  button.textContent = warRoomEarlierLabel(hiddenCount);
  button.addEventListener("click", onShowEarlier);
  row.append(button);
  return row;
}

/**
 * Builds the whole War Room region for the current window — used whenever
 * the window can't be reached by a pure incremental append: first mount, a
 * backward seek/jump that drops trailing events out of the window, or
 * `onShowEarlier` growing the window. `patchWarRoomWindowForward` below is
 * the hot per-tick path that avoids this.
 */
function buildWarRoomSection(
  allEvents: readonly CuratedWarRoomEvent[],
  eligibleCount: number,
  windowSize: number,
  callbacks: WarRoomWindowCallbacks,
): HTMLElement {
  const start = domWindowStart(eligibleCount, windowSize);
  const section = renderWarRoomFeed(
    allEvents.slice(start, eligibleCount),
    callbacks,
  );
  if (start > 0) {
    const list = section.querySelector<HTMLElement>(".broadcast-war-room-list");
    list?.prepend(buildWarRoomEarlierRow(start, callbacks.onShowEarlier));
  }
  return section;
}

/**
 * Incrementally patches an already-mounted War Room region for a pure
 * forward tick — a thin `patchDomWindowForward` adapter wiring the War
 * Room's own list selector, row builder, and "show earlier" affordance
 * into the shared primitive.
 */
function patchWarRoomWindowForward(
  section: HTMLElement,
  allEvents: readonly CuratedWarRoomEvent[],
  prevEligibleCount: number,
  nextEligibleCount: number,
  windowSize: number,
  callbacks: WarRoomWindowCallbacks,
): void {
  const list = section.querySelector<HTMLElement>(".broadcast-war-room-list");
  if (list === null) return;
  patchDomWindowForward(
    list,
    ".broadcast-war-room-item",
    allEvents,
    prevEligibleCount,
    nextEligibleCount,
    windowSize,
    (event) => renderWarRoomEvent(event, callbacks),
    (hiddenCount) =>
      syncDomWindowEarlierRow(
        list,
        ".broadcast-war-room-earlier",
        hiddenCount,
        () => buildWarRoomEarlierRow(hiddenCount, callbacks.onShowEarlier),
        warRoomEarlierLabel,
      ),
  );
}

/**
 * `renderMatchTimeline()` (BroadcastComposition.ts) renders one real,
 * focusable `<button>` per timeline marker, including every marker still
 * ahead of the playhead — those are redacted in place to a content-free
 * "Upcoming event — not yet revealed" tick rather than omitted, so a
 * spoiler can never leak through the marker's own tooltip.
 *
 * `BroadcastScrubber.ts` and `LullDirector.ts` harvest these exact elements
 * by DOM query (`data-kind` + the `--broadcast-timeline-position` custom
 * property) to place their own symbols and lull guards — so the elements
 * themselves, and both of those attributes, can never be removed or skipped
 * here. What CAN change is how loud an already-redacted marker is to
 * assistive tech: `aria-hidden` drops it from the accessibility tree and
 * `tabindex="-1"` drops it from Tab order, while the node is untouched.
 */
function suppressUpcomingTimelineMarkerNoise(timeline: HTMLElement): void {
  const upcoming = timeline.querySelectorAll<HTMLElement>(
    '.broadcast-timeline-marker[data-kind="upcoming"]',
  );
  for (const marker of upcoming) {
    marker.setAttribute("aria-hidden", "true");
    marker.tabIndex = -1;
  }
}

// ---------------------------------------------------------------------------
// The off-screen host
// ---------------------------------------------------------------------------

export const BROADCAST_BEATS_HOST_ID = "pw-broadcast-beats-host";

/**
 * The scrubber's own spoiler-toggle broadcast (`setSpoilersOn`,
 * BroadcastScrubber.ts). Its dispatch site says in so many words that it
 * exists "so the overlay's own timeline redaction can follow suit once it is
 * wired to listen" — this module is that listener. Named here rather than
 * imported so the dependency on the scrubber stays one function wide
 * (`broadcastSpoilersEnabled`).
 */
const BROADCAST_SPOILERS_CHANGED_EVENT = "ai-league-replay-spoilers-changed";

export interface BroadcastBeatsInput {
  runID: string;
  /** Raw, unvalidated `spectator-telemetry.json` (inline on the static bundle). */
  spectatorTelemetry?: unknown;
  /** Raw, unvalidated `match-state-series.json`. Absent on every 0.1.42 route — see `aiLeagueLeadChangeBeats`. */
  matchStateSeries?: unknown;
  /** Canonical record range, the timeline's own 100% mark. */
  replayMaxTurn?: number | null;
  decisions?: readonly BroadcastBeatsDecision[];
  /** Delivered free-text messages off the record's own turns — see `recordedAgentMessages`. */
  agentMessages?: readonly RecordedAgentMessage[];
}

export interface BroadcastBeatsHandle {
  dispose(): void;
}

/**
 * Mount the beat feed and the match timeline into an off-screen host.
 *
 * OFF-SCREEN BUT RENDERED, deliberately: `left: -20000px`, never
 * `display: none` and never `visibility: hidden`. The scrubber reads each
 * marker's resolved `--broadcast-timeline-position`, the lull director reads
 * the same property, and the toast stack reads rendered row text — all of
 * which need the subtree to be a real, laid-out part of the document. A
 * display:none host silently produces a full marker set that measures as
 * nothing downstream.
 *
 * The old overlay's stylesheet went with the overlay, so the host supplies
 * its own positioning inline. It is `inert` + `aria-hidden`: a duplicate feed
 * in the Tab order and the accessibility tree is exactly the noise our own
 * chrome exists to replace.
 */
export function mountBroadcastBeats(
  input: BroadcastBeatsInput,
): BroadcastBeatsHandle {
  // Same gate as every other broadcast surface in this tree. Live play never
  // reaches this function anyway (it is called from `openAiLeagueReplay`), but
  // the gate is what makes that a guarantee rather than a call-site habit.
  if (!isAiLeagueReplayRoute()) {
    return { dispose: () => {} };
  }

  const telemetry = normalizeSpectatorTelemetry(
    input.spectatorTelemetry ?? null,
  );
  const decisions = input.decisions ?? [];
  const matchStateSeries = memoizedMatchStateSeries(input.matchStateSeries);
  const totalTurns = beatsFinishTurn(
    input.replayMaxTurn,
    decisions,
    telemetry,
  );

  // Full, unwindowed curated set — NEVER rendered directly: a viewer at turn
  // N must never see an event from turn > N. The render paths below window
  // this down to the viewer's own playhead AND to a bounded DOM count.
  const allWarRoomEvents = curatedWarRoomEvents(
    telemetry,
    decisions,
    matchStateSeries,
    input.agentMessages ?? [],
  );
  const timelineMarkers: TimelineMarker[] = [
    ...matchTimelineEventMarkers(telemetry, matchStateSeries),
    {
      kind: "finish",
      turn: totalTurns,
      sequence: Number.MAX_SAFE_INTEGER,
      label: translateText(
        "ai_league_replay.timeline_finish",
        undefined,
        "Match ends",
      ),
    },
  ];

  /**
   * Change gate for the Match Timeline — the `marksKey` idiom
   * `BroadcastScrubber.harvestMarks()` uses, applied to the producer side.
   *
   * This key used to be `${turnNumber}:${spoilers}`, which changes on
   * virtually every frame event, so the ENTIRE 167-marker subtree was torn
   * down and rebuilt ~20x/sec: ~26,700 DOM operations and a fresh click
   * closure per marker per second. With spoilers ON the produced DOM was
   * byte-identical every single time, because `currentTurn` is pinned to
   * Number.MAX_SAFE_INTEGER in that mode and nothing else the render reads
   * varies — the whole cost bought nothing.
   *
   * Why this signature is complete: `renderMatchTimeline()` reads exactly
   * four things. `timelineMarkers` and `totalTurns` are both mount-consts
   * (assembled above from mount-time telemetry, never mutated; a different
   * marker set only arrives with a whole new mount, which builds fresh DOM
   * structurally anyway) — the marker count carries them here. `onSeek` is
   * the same `dispatchJumpToTurn` closure every time. The only per-frame
   * input is the redaction predicate, `kind !== "finish" && turn >
   * currentTurn`, which is monotone in `currentTurn` over a FIXED marker
   * multiset — so the NUMBER of redacted markers pins down exactly WHICH
   * markers are redacted (equal-turn markers flip as one group), and no two
   * playhead positions with the same redacted count can differ in the DOM.
   * That count is also what `suppressUpcomingTimelineMarkerNoise()` keys off
   * (it only ever touches `[data-kind="upcoming"]` markers), so its output
   * is covered too.
   */
  const timelineRenderKey = (turn: number): string => {
    if (broadcastSpoilersEnabled()) {
      // MAX_SAFE_INTEGER playhead: nothing is ever redacted, so the DOM is a
      // pure function of the (mount-const) marker set.
      return `${timelineMarkers.length}:s1`;
    }
    let redacted = 0;
    for (const marker of timelineMarkers) {
      if (marker.kind !== "finish" && marker.turn > turn) redacted += 1;
    }
    return `${timelineMarkers.length}:s0:${redacted}`;
  };

  // A previous attempt's host (two openAiLeagueReplay attempts racing over one
  // document, the race Main.ts guards with `rewindInFlight`) would otherwise
  // leave a second feed in the document for every harvester to read twice.
  document.getElementById(BROADCAST_BEATS_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = BROADCAST_BEATS_HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");
  host.style.position = "fixed";
  host.style.left = "-20000px";
  host.style.top = "0";
  // A real box, because the renderers' own laid-out geometry is what the
  // harvesters read. Wide enough that the timeline track resolves marker
  // positions at usable precision; tall enough that the windowed feed lays
  // out its rows rather than collapsing them.
  host.style.width = "1200px";
  host.style.height = "900px";
  host.style.overflow = "hidden";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);

  const dispatchJumpToTurn = (turn: number): void => {
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-jump-turn", {
        detail: { turnNumber: turn },
      }),
    );
  };

  let warRoomWindowSize = AI_LEAGUE_TICKER_DOM_WINDOW;
  let mountedWarRoomCount = 0;
  let mountedWarRoomWindowSize = warRoomWindowSize;
  let lastTurnNumber = 0;

  const warRoomCallbacks = (): WarRoomWindowCallbacks => ({
    onJumpToTurn: (turn) => dispatchJumpToTurn(turn),
    onShowEarlier: () => {
      warRoomWindowSize += AI_LEAGUE_TICKER_DOM_WINDOW;
      render(lastTurnNumber);
    },
  });

  const render = (turnNumber: number): void => {
    lastTurnNumber = turnNumber;
    const eligibleWarRoomCount = domEligibleCount(
      allWarRoomEvents,
      (event) => event.turn,
      turnNumber,
    );
    const warRoomSection = host.querySelector<HTMLElement>(
      ".broadcast-war-room",
    );
    if (
      warRoomSection !== null &&
      mountedWarRoomCount > 0 &&
      eligibleWarRoomCount >= mountedWarRoomCount &&
      warRoomWindowSize === mountedWarRoomWindowSize
    ) {
      // Pure forward tick: incremental append/prune, no rebuild.
      if (eligibleWarRoomCount !== mountedWarRoomCount) {
        patchWarRoomWindowForward(
          warRoomSection,
          allWarRoomEvents,
          mountedWarRoomCount,
          eligibleWarRoomCount,
          warRoomWindowSize,
          warRoomCallbacks(),
        );
      }
    } else {
      // Non-monotonic (a seek/jump backward dropped trailing events), still in
      // the empty placeholder state, or the window size just changed.
      const nextWarRoom = buildWarRoomSection(
        allWarRoomEvents,
        eligibleWarRoomCount,
        warRoomWindowSize,
        warRoomCallbacks(),
      );
      if (warRoomSection !== null) {
        warRoomSection.replaceWith(nextWarRoom);
      } else {
        host.appendChild(nextWarRoom);
      }
    }
    mountedWarRoomCount = eligibleWarRoomCount;
    mountedWarRoomWindowSize = warRoomWindowSize;

    const timeline = host.querySelector<HTMLElement>(".broadcast-timeline");
    const nextTimelineKey = timelineRenderKey(turnNumber);
    if (timeline === null || timeline.dataset.timelineKey !== nextTimelineKey) {
      const nextTimeline = renderMatchTimeline(timelineMarkers, {
        totalTurns,
        // Full Replay is unrestricted (unlike a live Premiere, which must
        // never seek past the live edge).
        maxSeekableTurn: null,
        // Content-free ticks ahead of the playhead is the safe default: a
        // marker's own tooltip is itself a spoiler surface. The BROADCAST
        // inverts that default under its owner-chosen spoilers toggle
        // (default ON): with spoilers on, future markers keep their real
        // kinds so the scrubber's harvested cloud/skull symbols exist for the
        // whole match. The scrubber re-applies this exact redaction locally
        // whenever the toggle is OFF, so flipping it can never leak through
        // this path.
        currentTurn: broadcastSpoilersEnabled()
          ? Number.MAX_SAFE_INTEGER
          : turnNumber,
        onSeek: dispatchJumpToTurn,
      });
      suppressUpcomingTimelineMarkerNoise(nextTimeline);
      nextTimeline.dataset.timelineKey = nextTimelineKey;
      if (timeline !== null) {
        timeline.replaceWith(nextTimeline);
      } else {
        host.appendChild(nextTimeline);
      }
    }
  };

  render(0);

  const onFrame = (event: Event) => {
    const detail = (event as CustomEvent<{ turnNumber?: unknown }>).detail;
    if (!detail) return;
    const turnNumber =
      typeof detail.turnNumber === "number" && Number.isFinite(detail.turnNumber)
        ? detail.turnNumber
        : lastTurnNumber;
    render(turnNumber);
  };
  // Spoilers flipping changes the redaction of every marker at once, and the
  // toggle has no render cycle of its own — repaint on the last known turn
  // rather than waiting for the next tick, exactly as the timeline key
  // already accounts for.
  const onSpoilersChange = () => render(lastTurnNumber);
  document.addEventListener("ai-league-replay-frame", onFrame);
  document.addEventListener(
    BROADCAST_SPOILERS_CHANGED_EVENT,
    onSpoilersChange,
  );

  return {
    dispose: () => {
      document.removeEventListener("ai-league-replay-frame", onFrame);
      document.removeEventListener(
        BROADCAST_SPOILERS_CHANGED_EVENT,
        onSpoilersChange,
      );
      host.remove();
    },
  };
}
