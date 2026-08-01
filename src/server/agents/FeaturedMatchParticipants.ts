import { generateEmblemSvg } from "../identity/IdentityEmblems";
import type { IdentityRegistrySnapshot } from "../identity/IdentityRegistry";
import {
  computeProvisionalIdentities,
  type ProvisionalIdentity,
} from "../identity/ProvisionalIdentity";
import type { FeaturedMatch, FeaturedMatchParticipant } from "./FeaturedMatch";

/**
 * One participant, resolved to safe display identity — Agent emblem/
 * colors/exact version, plus Builder attribution when claimed. Never the
 * match RESULT (that stays on `FeaturedMatch.result`, embargoed exactly as
 * `ProxyWarPublicReadModel.ts`'s `publicFeaturedMatchResult` already
 * enforces — this module is participant identity ONLY, orthogonal to that
 * embargo).
 *
 * `agentSlug`/`emblemSvg`/`primaryColor`/`secondaryColor` fall back to a
 * PURELY COSMETIC provisional identity (see `ProvisionalIdentity.ts`) when
 * no `AgentProfile` matched — a real, currently-competing participant
 * featured on the homepage hero or `/watch` never renders as an anonymous
 * card (2026-08-01 P0 fix). `builderId`/`builderDisplayName`/`versionLabel`
 * stay `null` regardless: a provisional identity carries NO ownership or
 * release history, only what the live mirror itself already reported.
 */
export interface FeaturedMatchParticipantCard {
  playerName: string;
  displayName: string;
  agentSlug: string | null;
  emblemSvg: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  /** e.g. "v24" — null when the participant has no registered version match. */
  versionLabel: string | null;
  builderId: string | null;
  builderDisplayName: string | null;
}

/**
 * Resolves a `FeaturedMatch`'s participants into display-safe cards.
 *
 * DELIBERATELY NOT part of `PublicFeaturedMatch`/`ProxyWarPublicReadModel`
 * (see that type's own doc: participant identity must never be embedded in
 * `read-model.json`, the one bulk, always-fetchable static artifact that
 * would otherwise leak every SCHEDULED-but-not-yet-live record's
 * participants at once, bypassing every per-match/per-live-premiere
 * spoiler gate). Callers MUST serve this only through a narrow, per-record
 * channel — one match id or one live premiere id at a time, never a bulk
 * list — see `/match/:matchId`'s and the lobby hero's own route docs for
 * the two sanctioned call sites.
 *
 * Gated on `state`: only `"published"` (the operator's premiere:publish
 * "yes, run this one" signal — see FeaturedMatch.ts's state-machine doc),
 * `"revealed"`, or `"archived"` return cards. `"candidate"`/`"scheduled"`
 * return `[]` — a record the operator hasn't explicitly published yet
 * never exposes who is in it, matching spec §5's embargo intent that
 * participant identity is safe to show once a match is committed to run,
 * not merely proposed. Spec §5 explicitly calls participant cards a
 * NORMAL pre-match feature ("Participant cards use pre-match snapshots
 * until reveal") — this gate gives that language teeth against the one
 * state (`"scheduled"`) that is not yet a real commitment.
 */
export function resolveFeaturedMatchParticipantCards(
  match: FeaturedMatch,
  identity: IdentityRegistrySnapshot,
): FeaturedMatchParticipantCard[] {
  if (match.state === "candidate" || match.state === "scheduled") return [];
  const builderById = new Map(identity.builders.map((builder) => [builder.id, builder]));
  const provisionalIdentities = computeProvisionalIdentities(
    match.participants.map((participant) => participant.playerName),
    new Set(identity.agents.map((agent) => agent.slug)),
  );
  return match.participants.map((participant) =>
    resolveOneParticipant(participant, identity, builderById, provisionalIdentities),
  );
}

function resolveOneParticipant(
  participant: FeaturedMatchParticipant,
  identity: IdentityRegistrySnapshot,
  builderById: ReadonlyMap<string, IdentityRegistrySnapshot["builders"][number]>,
  provisionalIdentities: ReadonlyMap<string, ProvisionalIdentity>,
): FeaturedMatchParticipantCard {
  const agent =
    participant.agentId === null
      ? undefined
      : identity.agents.find((candidate) => candidate.id === participant.agentId);
  const version =
    participant.agentVersionId === null
      ? undefined
      : identity.versions.find((candidate) => candidate.id === participant.agentVersionId);
  const builderId = participant.builderId ?? agent?.builderId ?? null;
  const builder = builderId === null ? undefined : builderById.get(builderId);
  const provisional =
    agent === undefined ? (provisionalIdentities.get(participant.playerName) ?? null) : null;
  return {
    playerName: participant.playerName,
    displayName: agent?.displayName ?? participant.playerName,
    agentSlug: agent?.slug ?? provisional?.slug ?? null,
    emblemSvg:
      agent === undefined
        ? (provisional?.emblemSvg ?? null)
        : generateEmblemSvg(agent.id),
    primaryColor: agent?.primaryColor ?? provisional?.primaryColor ?? null,
    secondaryColor: agent?.secondaryColor ?? provisional?.secondaryColor ?? null,
    versionLabel: version?.publicVersionLabel ?? null,
    builderId: builder?.id ?? null,
    builderDisplayName: builder?.displayName ?? null,
  };
}
