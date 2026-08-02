/**
 * A visual identity for a live Coworld participant with NO registered
 * `AgentProfile` — the P0 production review's "James Botts"/"Jordan"
 * incident (2026-08-01, see `docs/PROXYWAR_IDENTITY_MODEL.md`'s "Known
 * ambiguous roster links" and "Self-surfacing unmapped counts") found
 * that every public surface's SAFE degrade for this case (plain text,
 * `emblemSvg: null`, `slug: null`, no working profile link) reads as an
 * anonymous, broken-looking card for a REAL, currently-competing
 * participant — not a fabricated identity, just an absent one.
 *
 * This module closes that gap WITHOUT weakening the no-auto-attribution
 * invariant `IdentityMatching.ts` and this whole identity system are
 * built around: a provisional identity carries ONLY what the live mirror
 * itself already reported (`playerName`) plus a purely cosmetic,
 * deterministic emblem/color/slug derived from that same string. It
 * NEVER invents a Builder, a policy history, a short code, ownership, or
 * anything else — every caller that consumes a `ProvisionalIdentity`
 * MUST keep treating the participant as unregistered (`registered: false`,
 * `status: "unregistered"`) everywhere else.
 */
import { createHash } from "node:crypto";
import { deriveEmblemPalette, generateEmblemSvg } from "./IdentityEmblems";

export interface ProvisionalIdentity {
  readonly slug: string;
  readonly emblemSvg: string;
  readonly primaryColor: string;
  readonly secondaryColor: string;
}

/** Same shape as `BuildRegistrationSubmission.ts`'s private `slugify` — lowercase, non-alphanumeric runs collapsed to a single hyphen, leading/trailing hyphens trimmed. Not exported from that module, so duplicated here rather than importing across an unrelated concern boundary (registration drafts vs. live-render fallback). */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 6);
}

/**
 * Computes a stable, collision-safe provisional identity for one live
 * `playerName`.
 *
 * Collision safety: `reservedSlugs` MUST contain every slug this
 * provisional one must never shadow — at minimum every REAL registered
 * `AgentProfile.slug` (`/agent/:slug` must never let a provisional card
 * become unreachable behind, or silently stand in for, a real one), plus
 * any provisional slug already assigned earlier in the SAME batch (so two
 * unmapped participants in one publish cycle never collide with each
 * other either — pass an accumulating set across calls; see
 * `computeProvisionalIdentities` below for the batch-safe wrapper). On a
 * collision, appends a short, deterministic hash of the ORIGINAL
 * `playerName` (never a call-order-dependent counter), so the same
 * colliding roster always resolves to the same disambiguated slug on
 * every mirror sync, not just the first one.
 *
 * The emblem seed is prefixed `unreg_` — distinct from every registered
 * Agent's `agt_<slug>` seed namespace, so a provisional emblem can never
 * coincidentally reproduce a real Agent's emblem bytes.
 */
export function computeProvisionalIdentity(
  playerName: string,
  reservedSlugs: ReadonlySet<string>,
): ProvisionalIdentity {
  const base = slugify(playerName) || "participant";
  const slug = reservedSlugs.has(base) ? `${base}-${shortHash(playerName)}` : base;
  const seed = `unreg_${slug}`;
  const palette = deriveEmblemPalette(seed);
  return {
    slug,
    emblemSvg: generateEmblemSvg(seed),
    primaryColor: palette.primary,
    secondaryColor: palette.secondary,
  };
}

/**
 * Batch-safe wrapper: computes a provisional identity for each of
 * `playerNames`, threading newly-assigned slugs forward into
 * `reservedSlugs` as it goes, so two unmapped participants processed in
 * the same call never collide with each other (extremely unlikely in
 * practice — Coworld `playerName`s are league-unique — but the base slug
 * derived from two DIFFERENT names could still coincide after
 * normalization, e.g. two names differing only in punctuation).
 */
export function computeProvisionalIdentities(
  playerNames: readonly string[],
  registeredSlugs: ReadonlySet<string>,
): ReadonlyMap<string, ProvisionalIdentity> {
  const reserved = new Set(registeredSlugs);
  const result = new Map<string, ProvisionalIdentity>();
  for (const playerName of playerNames) {
    const identity = computeProvisionalIdentity(playerName, reserved);
    reserved.add(identity.slug);
    result.set(playerName, identity);
  }
  return result;
}
