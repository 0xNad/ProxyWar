import { aiLeagueSpectatorDisplayName } from "./AiLeagueReplayMode";
import { translateText } from "./Utils";

/**
 * One sampled agent decision, as the replay envelope serializes it.
 *
 * RE-HOMED FROM `AiLeagueReplayArtifacts.ts`, which 0.1.42 deletes along with
 * the league overlay it fed. The shape is unchanged, character for character —
 * it is still the server's `replayUiRecentDecisions` row and still the shape
 * `decisionsFromSpectatorSnapshots` below builds. It lives here now because
 * this store is the only surface left that publishes or reads it, so the
 * declaration belongs beside the store rather than in a fetch module that no
 * longer exists.
 */
export interface AiLeagueReplayUiDecision {
  sequence: number;
  turnNumber: number;
  username: string;
  profile: string;
  brainType: string;
  selectedActionKind: string;
  selectedLegalActionId: string;
  selectedActionMetadata?: Record<string, unknown>;
  socialText?: string;
  socialTargetName?: string;
  reason: string;
  planObjective?: string;
  decisionLatencyMs: number;
  fallbackUsed: boolean;
  parseSuccess?: boolean;
  result: {
    accepted: boolean;
    reason: string;
  };
  auditStatus?: string;
}

/**
 * ============================================================================
 * REPLAY DECISION STORE — the one place agent reasoning is published.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The sampled decision log (replay-ui.json → recentDecisions) is the reason an
 * AI tournament is worth watching, and it was reachable from exactly one
 * surface: the parked broadcast overlay, which the native spectator skin keeps
 * off-screen. Main.ts hydrates that overlay directly, so any OTHER layer that
 * wanted a decision had no seam to read it from short of importing the whole
 * 6000-line overlay or re-fetching the artifact.
 *
 * This is that seam: Main.ts publishes here at the same moment it hydrates the
 * overlay, and the dossier / toast / analyst-drawer layers read here. A plain
 * module-level store rather than an event, because the readers are
 * tick()-driven layers that poll on their own cadence anyway — they want
 * "current value on demand", not a subscription they would have to buffer.
 *
 * WHAT THE DATA IS (AND IS NOT)
 * -----------------------------
 * At most ~60 decisions SAMPLED across the whole match — the server thins to
 * replayUiRecentDecisionLimit and keeps notable fallback/rejected decisions
 * preferentially. Any UI copy over this data must say "sampled" and never
 * imply completeness. `reason` is serialized by the server as
 * `boundedString(decision.reason) ?? ""` — a fallback/no-reason decision
 * arrives as the EMPTY STRING, not null, so statedReason() below is the one
 * shared judgement of "did the agent actually say why".
 */

let decisions: readonly AiLeagueReplayUiDecision[] = [];

/**
 * Called by Main.ts at the overlay hydration site: once with [] when a replay
 * attempt mounts (which also wipes the previous match's log across an in-place
 * rewind), and again with the real array when replay-ui.json lands.
 */
export function publishReplayDecisions(
  next: readonly AiLeagueReplayUiDecision[],
): void {
  decisions = next;
}

export function replayDecisions(): readonly AiLeagueReplayUiDecision[] {
  return decisions;
}

/**
 * The agent's stated reason, or null when it never stated one. Trimmed,
 * empty-string-is-null — see the module doc for why "" is how the artifact
 * spells null. Every surface rendering a reason must come through here so
 * "no stated reason" is one judgement, not three.
 */
export function statedReason(
  decision: AiLeagueReplayUiDecision,
): string | null {
  const reason = decision.reason.trim();
  if (reason.length === 0) return null;
  // Fallback/rule-engine decisions carry MACHINE CODES here, not prose —
  // measured on the real fixture: 96 of 240 snapshot decisions read like
  // "dgd:err:atk" or "rul:atk". Quoting a code as the agent's stated reason
  // would be nonsense on the dossier and toasts; the analyst drawer still
  // shows every decision (those rows carry their own FALLBACK flag). A code
  // is short, space-less, and colon-jointed; prose always has spaces.
  if (!reason.includes(" ") && reason.includes(":")) return null;
  return reason;
}

/** Localized display form for the bounded action-kind token. */
export function formatReplayActionKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  const safeKey = normalized.replace(/[^a-z0-9_]/g, "_") || "unknown";
  const words = (normalized || "unknown").replace(/_/g, " ");
  const fallback = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  return translateText(
    `ai_league_replay.action_kind_${safeKey}`,
    undefined,
    fallback,
  );
}

/**
 * Adapter for the STATIC-BUNDLE path, where replay-ui.json is never fetched
 * (the bundle is offline) but the envelope's spectatorReplay snapshots carry
 * a RICHER decision log — 240 entries on the real fixture versus the 60 the
 * network artifact samples. Maps the snapshot decision shape onto the
 * replay-ui shape every consumer already speaks.
 */
export function decisionsFromSpectatorSnapshots(
  snapshots: unknown,
): AiLeagueReplayUiDecision[] {
  if (!Array.isArray(snapshots)) return [];
  const out: AiLeagueReplayUiDecision[] = [];
  for (const snap of snapshots) {
    const decisions = (snap as { decisions?: unknown })?.decisions;
    if (!Array.isArray(decisions)) continue;
    for (const raw of decisions) {
      const d = raw as Record<string, unknown>;
      if (typeof d.username !== "string" || typeof d.turnNumber !== "number") {
        continue;
      }
      out.push({
        sequence: typeof d.sequence === "number" ? d.sequence : out.length,
        turnNumber: d.turnNumber,
        username: d.username,
        profile: typeof d.profile === "string" ? d.profile : "",
        brainType: typeof d.brainType === "string" ? d.brainType : "",
        selectedActionKind:
          typeof d.selectedActionKind === "string"
            ? d.selectedActionKind
            : "unknown",
        selectedLegalActionId:
          typeof d.selectedLegalActionId === "string"
            ? d.selectedLegalActionId
            : null,
        reason: typeof d.reason === "string" ? d.reason : "",
        // Snapshot decisions carry objectiveSummary where replay-ui carries
        // planObjective — same content, different era of the schema.
        planObjective:
          typeof d.objectiveSummary === "string" &&
          d.objectiveSummary.length > 0
            ? d.objectiveSummary
            : undefined,
        decisionLatencyMs:
          typeof d.decisionLatencyMs === "number" ? d.decisionLatencyMs : 0,
        fallbackUsed: d.fallbackUsed === true,
        result: {
          accepted: d.accepted !== false,
          reason: typeof d.resultReason === "string" ? d.resultReason : "",
        },
        auditStatus:
          typeof d.auditStatus === "string" ? d.auditStatus : undefined,
      } as AiLeagueReplayUiDecision);
    }
  }
  out.sort((a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence);
  return out;
}

/**
 * The most recent sampled decision for one seat: max sequence per username,
 * optionally capped at the current playhead turn so a scrubbed-back viewer is
 * never shown a decision from their own future.
 *
 * MATCHING. Decision usernames are raw agent names — the same namespace as
 * PlayerView.data.name (ClientGameRunner builds replay frames with
 * `username: player.name()`, and the parked overlay's latestDirectiveByPlayer
 * matches frame `player.username` by trim+lowercase, which this mirrors).
 * The raw case-insensitive comparison is therefore the whole match for real
 * fixtures (softmaxwell, relh, SIAN VOIDCROWN…). The rebrand fallback exists
 * for the promo roster, where a caller may only hold the rebranded name
 * ("Iron Atlas" for "Aggressive Agent 1"): both sides are pushed through
 * aiLeagueSpectatorDisplayName — the same choke point every display surface
 * uses — which is deterministic within a page load and injective per real
 * name, so it is equality-safe even under the Anonymous Names setting. It is
 * only consulted after a raw miss, so the common path never touches it.
 */
export function lastDecisionFor(
  username: string,
  upToTurn: number = Number.POSITIVE_INFINITY,
): AiLeagueReplayUiDecision | null {
  const wanted = normalizeName(username);
  if (wanted.length === 0) return null;
  let best: AiLeagueReplayUiDecision | null = null;
  for (const decision of decisions) {
    if (decision.turnNumber > upToTurn) continue;
    if (!sameSeat(decision.username, username, wanted)) continue;
    if (best === null || decision.sequence > best.sequence) best = decision;
  }
  return best;
}

function sameSeat(
  decisionUsername: string,
  queryUsername: string,
  normalizedQuery: string,
): boolean {
  if (normalizeName(decisionUsername) === normalizedQuery) return true;
  return (
    normalizeName(aiLeagueSpectatorDisplayName(decisionUsername)) ===
    normalizeName(aiLeagueSpectatorDisplayName(queryUsername))
  );
}

/** Same normalization latestDirectiveByPlayer uses: trim + lowercase. */
function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
