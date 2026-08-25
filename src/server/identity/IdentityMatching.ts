import { AgentProfile, AgentVersion, BuilderProfile } from "./IdentitySchemas";

/**
 * Maps live Coworld mirror rows to registry identities. `playerName` is the
 * ONLY key ever used to find an Agent — never a GitHub login, display name,
 * email, or policy label. Those are user-settable namespaces with no
 * constraint to agree with each other; matching on them is an
 * account-takeover primitive (a wrong auto-claim publicly attributes
 * someone else's agent — see the product spec's Stage 1 item 2). This
 * module never creates or edits a `BuilderProfile`; it only resolves which
 * already-registered `AgentProfile` a live row belongs to.
 */

/** A minimal view of a live mirror row — deliberately narrower than `CoworldLeagueStandingRow`/`CoworldLeagueEpisodePlayerRow` so this module has no import-time dependency on the site writer. */
export interface LiveIdentityInput {
  playerName: string;
  ratingPolicyLabel: string | null;
  activeChampionPolicyLabel: string | null;
}

/** `"family:version"` split on the LAST colon — policy labels occasionally contain colons of their own only in the family half (none observed to date, but the split direction is the deliberate choice). Returns `null` for a malformed label (no colon). */
export function parsePolicyLabel(
  label: string,
): { family: string; version: string } | null {
  const separatorIndex = label.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === label.length - 1) {
    return null;
  }
  return {
    family: label.slice(0, separatorIndex),
    version: label.slice(separatorIndex + 1),
  };
}

/** Exact-match only — Coworld's `playerName` is the league's stable per-participant key (see `CoworldLeagueMirrorCore.ts`); no fuzzy or case-insensitive matching, which would risk merging two distinct participants. */
export function findAgentForPlayerName(
  playerName: string,
  agents: readonly AgentProfile[],
): AgentProfile | null {
  return (
    agents.find((agent) => agent.policyMatchRule.playerName === playerName) ??
    null
  );
}

/**
 * One public house/non-house classification for every surface. Coworld's
 * membership-derived bit is still the only evidence available for an
 * unregistered participant. Once an exact `playerName` resolves to a tracked
 * AgentProfile, however, the registry's explicit status is authoritative:
 * publishing `status: "house"` beside `isHouse: false` is internally
 * contradictory, and a transiently unavailable champion feed must not
 * silently reclassify a known house agent as community-owned.
 */
export function resolvePublicHouseStatus(
  playerName: string,
  observedIsHouse: boolean,
  agents: readonly AgentProfile[],
): boolean {
  const agent = findAgentForPlayerName(playerName, agents);
  return agent === null ? observedIsHouse : agent.status === "house";
}

export interface ObservedVersion {
  /** The label actually live right now — champion when present, else rating. */
  policyLabel: string;
  /** `"champion"` unless only a rating label exists (e.g. a player whose champion feed lags). */
  source: "champion" | "rating";
  /** Parsed version suffix, e.g. `"v24"` — `null` only for a malformed label. */
  publicVersionLabel: string | null;
  /** True when the observed policy family no longer matches the Agent's registered `policyMatchRule.policyFamily` — a real "this participant's lineage changed" signal, surfaced for operator review rather than silently re-mapped or hidden. */
  familyMismatch: boolean;
  /** The matching `AgentVersion` record, if one has been registered for this exact label — `null` is expected and NOT an error: a fresh version bump (e.g. `:v24` -> `:v25` under the same family) is a normal "new observed version" the mirror still renders correctly from the live label alone (spec item 2: "flagged as new observed version", not blocked). */
  registered: AgentVersion | null;
}

/**
 * Resolves what an Agent's live standings row is actually running.
 * Champion-vs-rating preference matches the mirror's own precedent
 * (`CoworldLeagueSiteWriter`'s `policyProvenance`): the live champion label
 * is authoritative when present; the rating label is the fallback only when
 * champion is null (a player whose rating feed has data but whose champion
 * feed hasn't reported yet — see the seed notes' 8-participant case).
 */
export function resolveObservedVersion(
  agent: AgentProfile,
  versions: readonly AgentVersion[],
  row: LiveIdentityInput,
): ObservedVersion | null {
  const source: "champion" | "rating" | null =
    row.activeChampionPolicyLabel !== null
      ? "champion"
      : row.ratingPolicyLabel !== null
        ? "rating"
        : null;
  if (source === null) {
    return null;
  }
  const policyLabel =
    source === "champion"
      ? row.activeChampionPolicyLabel!
      : row.ratingPolicyLabel!;
  const parsed = parsePolicyLabel(policyLabel);
  const registered =
    versions.find(
      (version) =>
        version.agentId === agent.id &&
        version.softmaxPolicyLabel === policyLabel,
    ) ?? null;
  return {
    policyLabel,
    source,
    publicVersionLabel: parsed?.version ?? null,
    familyMismatch:
      parsed !== null && parsed.family !== agent.policyMatchRule.policyFamily,
    registered,
  };
}

/**
 * Live participants (by `playerName`) with no registered `AgentProfile` —
 * exactly what `identity:list-unmapped` reports. Returns empty for a fully
 * seeded roster; any non-empty result means a real participant is about to
 * render with only a provisional (name-only, no emblem/short-code/builder)
 * identity on the league page.
 */
export function computeUnmappedPlayerNames(
  livePlayerNames: readonly string[],
  agents: readonly AgentProfile[],
): readonly string[] {
  const registeredPlayerNames = new Set(
    agents.map((agent) => agent.policyMatchRule.playerName),
  );
  return livePlayerNames.filter(
    (playerName) => !registeredPlayerNames.has(playerName),
  );
}

/** Everything a render call site needs for one live participant, resolved in one pass. `builder` is non-null only once a verified claim exists — `agent.builderId` is the only path to it, never a name/email/GitHub match (see module doc). */
export interface AgentIdentityView {
  agent: AgentProfile | null;
  builder: BuilderProfile | null;
  version: ObservedVersion | null;
}

/** The one function mirror rendering actually calls: agent lookup, its registered Builder (if any), and its observed version, together. Never partial — `builder`/`version` are only meaningful when `agent` is non-null, and both stay `null` alongside a `null` agent. */
export function resolveAgentIdentityView(
  row: LiveIdentityInput,
  agents: readonly AgentProfile[],
  builders: readonly BuilderProfile[],
  versions: readonly AgentVersion[],
): AgentIdentityView {
  const agent = findAgentForPlayerName(row.playerName, agents);
  if (agent === null) {
    return { agent: null, builder: null, version: null };
  }
  const builder =
    agent.builderId === null
      ? null
      : (builders.find((candidate) => candidate.id === agent.builderId) ??
        null);
  return {
    agent,
    builder,
    version: resolveObservedVersion(agent, versions, row),
  };
}
