import { z } from "zod";

/**
 * Typed, validated schemas for the Proxy War identity registry —
 * `BuilderProfile` / `AgentProfile` / `AgentVersion`, per the product
 * overhaul spec (Stage 1 §4). These are the ONLY fields a registry file may
 * carry: every object schema is `.strict()`, so an unrecognized key (a stray
 * secret, a private field, a typo) fails validation instead of round-tripping
 * silently. `identity:validate` runs this over every tracked registry file.
 *
 * Ownership is unverified by construction here: nothing in this module ever
 * derives a Builder from a GitHub login, display name, email, or policy
 * label — see `IdentityMatching.ts`'s doc for why that would be an
 * account-takeover primitive. A `BuilderProfile` exists only once a real
 * verification mechanism produces one (Stage 1 item 2, not yet built); until
 * then `AgentProfile.builderId` stays `null` and `status` stays
 * `"unclaimed"` (or `"house"` for operator/Softmax baseline agents).
 */

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** URL-safe, lowercase, hyphen-separated — safe in a path segment with no encoding. */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    slugPattern,
    "slug must be lowercase alphanumeric segments joined by single hyphens",
  );

/** 2-4 uppercase alphanumeric characters — short enough for a standings-table column, long enough to stay distinguishable (see the registry's own confusability review in its seed commit). */
export const ShortCodeSchema = z
  .string()
  .regex(
    /^[A-Z0-9]{2,4}$/,
    "short code must be 2-4 uppercase alphanumeric characters",
  );

/** `#rrggbb`, lowercase hex — matches the case CSS/SVG both accept without normalization surprises. */
export const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, "expected a lowercase #rrggbb hex color");

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO YYYY-MM-DD date");
const IsoTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  "expected an ISO-8601 UTC timestamp",
);

export const IdentityStatusSchema = z.enum(["verified", "house", "unclaimed"]);
export type IdentityStatus = z.infer<typeof IdentityStatusSchema>;

export const BuilderProfileSchema = z
  .object({
    id: z.string().regex(/^bld_[a-z0-9-]+$/, "expected bld_<slug>"),
    slug: SlugSchema,
    displayName: z.string().min(1).max(80).nullable(),
    shortBio: z.string().max(280).nullable(),
    avatarUrl: z.string().url().nullable(),
    /** GitHub login, populated ONLY once sign-in verification exists — never inferred. */
    verifiedGithub: z.string().min(1).nullable(),
    links: z.array(z.string().url()).max(10),
    teamMembers: z.array(z.string().min(1).max(80)).max(20),
    /**
     * Softmax player identities this Builder has DEMONSTRATED control of
     * (Stage 1 item 2's unsolved verification, not self-assertion). Empty
     * until that mechanism exists — never populated from a name match.
     */
    softmaxPlayerIdentities: z.array(z.string().min(1)).max(50),
    status: IdentityStatusSchema,
  })
  .strict();
export type BuilderProfile = z.infer<typeof BuilderProfileSchema>;

/**
 * How a live mirror row is matched to this Agent. `playerName` is the
 * primary, authoritative key — Coworld's `playerName` is stable and unique
 * within the league (the mirror's own contract; see
 * `CoworldLeagueMirrorCore.ts`). `policyFamily` is the policy-label prefix
 * observed at seed time, carried for display/validation only: a version
 * bump under the SAME family (`daveey-proxywar:v24` -> `:v25`) is expected
 * and auto-maps; a family that no longer matches is a signal worth an
 * operator's attention, not a re-match trigger (see `IdentityMatching.ts`).
 */
export const PolicyMatchRuleSchema = z
  .object({
    playerName: z.string().min(1),
    policyFamily: z.string().min(1),
  })
  .strict();
export type PolicyMatchRule = z.infer<typeof PolicyMatchRuleSchema>;

export const EmblemRefSchema = z
  .object({
    /** Only one generator exists today; the field exists so a future style never has to migrate every record. */
    style: z.literal("geometric-svg-v1"),
    /** Deterministic seed the generator hashes — see `IdentityEmblems.ts`. Always the Agent's own stable `id`. */
    seed: z.string().min(1),
    /** Path relative to the repo root, e.g. `resources/identity/emblems/agt_daveey.svg`. */
    assetPath: z.string().min(1),
  })
  .strict();
export type EmblemRef = z.infer<typeof EmblemRefSchema>;

export const AgentProfileSchema = z
  .object({
    id: z.string().regex(/^agt_[a-z0-9-]+$/, "expected agt_<slug>"),
    slug: SlugSchema,
    /** Falls back to the Coworld player name for an unclaimed Agent — never a fabricated brand name. */
    displayName: z.string().min(1).max(80),
    shortCode: ShortCodeSchema,
    builderId: z.string().regex(/^bld_[a-z0-9-]+$/).nullable(),
    tagline: z.string().max(120).nullable(),
    description: z.string().max(1000).nullable(),
    emblem: EmblemRefSchema,
    primaryColor: HexColorSchema,
    secondaryColor: HexColorSchema,
    /** ISO date this Agent first appeared in the league, if known — null rather than a guessed date. */
    debutDate: IsoDateSchema.nullable(),
    policyMatchRule: PolicyMatchRuleSchema,
    status: IdentityStatusSchema,
    publicStrategyDescription: z.string().max(2000).nullable(),
  })
  .strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const DisclosureStatusSchema = z.enum(["undisclosed", "disclosed"]);
export const QualificationStatusSchema = z.enum(["active", "retired"]);

/**
 * `observedVia` preserves the mirror's champion-vs-rating distinction at the
 * VERSION level (Stage 1 item 7's "preserve verbatim" requirement): a
 * version seen only as the live champion (rating feed hasn't caught up, or
 * never had one) records `["champion"]`; one seen in both feeds (the common
 * case once rating catches up) records `["champion", "rating"]`. Never
 * collapses the two into one undifferentiated "current version" flag.
 */
export const ObservedViaSchema = z.array(z.enum(["champion", "rating"])).min(1).max(2);

export const AgentVersionSchema = z
  .object({
    id: z.string().regex(/^agtv_[a-z0-9-]+_v[a-z0-9]+$/, "expected agtv_<agent-slug>_v<version>"),
    agentId: z.string().regex(/^agt_[a-z0-9-]+$/),
    /** Public label shown to viewers, e.g. "v24" — derived from the policy label's version suffix, never renumbered. */
    publicVersionLabel: z.string().min(1).max(20),
    /** Exact Softmax policy label this version corresponds to, e.g. "daveey-proxywar:v24". */
    softmaxPolicyLabel: z.string().min(1),
    /** Content-addressed digest of the policy artifact, where Softmax exposes one — Softmax does not today (see softmax-platform-feedback.md); always null until it does. */
    immutableDigest: z.string().min(1).nullable(),
    releaseDate: IsoDateSchema.nullable(),
    releaseNotes: z.string().max(2000).nullable(),
    /** Only ever set from the builder's OWN disclosure — never inferred from a policy name. */
    declaredBaseModel: z.string().min(1).nullable(),
    scaffoldDescription: z.string().max(1000).nullable(),
    sourceRepositoryRef: z.string().min(1).nullable(),
    disclosureStatus: DisclosureStatusSchema,
    qualificationStatus: QualificationStatusSchema,
    observedVia: ObservedViaSchema,
    /** When this record was added/last confirmed observed — registry provenance, not a Softmax-reported field. */
    observedAt: IsoTimestampSchema,
    /**
     * The FIRST time the mirror ever detected this exact `softmaxPolicyLabel`
     * live (spec Stage 6 item 3) — set once, on creation, and never
     * overwritten afterward, unlike `observedAt` above (which the mirror
     * bumps on every re-confirmation). Distinct from `releaseDate`: this is
     * registry provenance the mirror derives itself, `releaseDate` is a
     * builder disclosure that may predate or postdate it, or may never
     * arrive at all. `null` only when a record predates this field's
     * introduction and no retained match history could backfill it
     * (`sync-version-registry.ts`'s own doc) — never a guessed date.
     */
    firstObservedAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type AgentVersion = z.infer<typeof AgentVersionSchema>;

export const BuilderRegistryFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    builders: z.array(BuilderProfileSchema),
  })
  .strict();
export type BuilderRegistryFile = z.infer<typeof BuilderRegistryFileSchema>;

export const AgentRegistryFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    agents: z.array(AgentProfileSchema),
  })
  .strict();
export type AgentRegistryFile = z.infer<typeof AgentRegistryFileSchema>;

export const AgentVersionRegistryFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    versions: z.array(AgentVersionSchema),
  })
  .strict();
export type AgentVersionRegistryFile = z.infer<typeof AgentVersionRegistryFileSchema>;
