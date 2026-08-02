import { z } from "zod";
import {
  HexColorSchema,
  ShortCodeSchema,
  SlugSchema,
} from "./IdentitySchemas";
import { deriveEmblemPalette, generateEmblemSvg } from "./IdentityEmblems";

/**
 * `/build` Step 3's registration submission — spec Stage 7 item 1 step 3:
 * "Wire into the platform account claim + registry pipeline (Stage 1); if
 * instant self-service publication isn't safe, generate a validated profile
 * file + prefilled registration submission via the existing GitHub
 * workflow — never fake instant publication."
 *
 * Instant self-service publication is NOT safe: `IdentitySchemas.ts`'s own
 * module doc explains why ownership can never be derived from a
 * self-reported GitHub login, display name, or policy label (an
 * account-takeover primitive), and `BuilderProfile.verifiedGithub` stays
 * `null` "until a real verification mechanism produces one." This module
 * produces a VALIDATED DRAFT — real `AgentProfile`/`BuilderProfile` shapes,
 * checked against the exact schemas the registry itself enforces — plus a
 * prefilled GitHub issue for a human operator to review and merge. It never
 * writes to `resources/identity/*.json` itself. `claimedGithub` here is the
 * submitter's SELF-REPORTED GitHub handle, deliberately named apart from
 * the registry's `verifiedGithub`: an operator cross-checks it against the
 * submitter's actual platform-account-linked GitHub login (the one GitHub
 * OAuth produced) before ever copying it into a merged registry file.
 */

export const BuildRegistrationSubmissionInputSchema = z
  .object({
    agentName: z.string().trim().min(1).max(80),
    shortCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,4}$/, "2-4 uppercase alphanumeric characters"),
    tagline: z.string().trim().max(120).nullable(),
    publicStrategyDescription: z.string().trim().max(2000).nullable(),
    builderDisplayName: z.string().trim().min(1).max(80),
    builderShortBio: z.string().trim().max(280).nullable(),
    builderLinks: z.array(z.string().trim().url()).max(10),
    teamMembers: z.array(z.string().trim().min(1).max(80)).max(20),
    /** Self-reported only — see module doc. Never trusted as `verifiedGithub`. */
    claimedGithub: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9-]{1,39}$/, "expected a bare GitHub username")
      .nullable(),
    sourceRepositoryRef: z.string().trim().url().nullable(),
  })
  .strict();
export type BuildRegistrationSubmissionInput = z.infer<
  typeof BuildRegistrationSubmissionInputSchema
>;

/**
 * `/api/build/registration-submission`'s 400 response used to be a bare
 * `{ok: false, error: "invalid_submission"}` with no field indication — a
 * visitor who, say, typed a space into the optional GitHub-username field
 * (`claimedGithub`'s regex rejects anything but letters/digits/hyphens) saw
 * only a generic "check the required fields" banner with no clue WHICH
 * field, on a form with ten of them (2026-08-01 P1 fix). `firstFieldError`
 * turns the first Zod issue into a stable `{field, reason}` pair the route
 * handler echoes back and the client keys an inline, per-field message off
 * of — never exposing raw Zod internals over the wire.
 */
export type BuildRegistrationFieldErrorReason =
  | "format"
  | "required"
  | "too_short"
  | "too_long"
  | "invalid";

export interface BuildRegistrationFieldError {
  field: string;
  reason: BuildRegistrationFieldErrorReason;
}

function classifyIssueReason(
  issue: z.ZodError["issues"][number],
): BuildRegistrationFieldErrorReason {
  switch (issue.code) {
    case "invalid_format":
      return "format";
    case "too_small":
      // `minimum === 1` on a trimmed string means "was left empty", i.e.
      // the required-field case rather than a merely-too-short value.
      return "minimum" in issue && issue.minimum === 1 ? "required" : "too_short";
    case "too_big":
      return "too_long";
    case "invalid_type":
      return "required";
    default:
      return "invalid";
  }
}

export function firstFieldError(
  error: z.ZodError,
): BuildRegistrationFieldError | null {
  const issue = error.issues[0];
  if (issue === undefined) return null;
  const field = issue.path[0];
  if (typeof field !== "string") return null;
  return { field, reason: classifyIssueReason(issue) };
}

/** Lowercase, hyphenated, URL-safe — same shape `SlugSchema` requires. */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export interface BuildRegistrationDraft {
  /** A validated `AgentProfile`-shaped object MINUS `id`/`builderId`/`status`/`debutDate`/`policyMatchRule` — an operator assigns those at merge time, once the submitter's real Coworld player name is known (Step 5, not yet run when Step 3 submits). */
  proposedAgent: {
    slug: string;
    displayName: string;
    shortCode: string;
    tagline: string | null;
    description: null;
    publicStrategyDescription: string | null;
    emblem: { style: "geometric-svg-v1"; seed: string; assetPath: string };
    primaryColor: string;
    secondaryColor: string;
  };
  /** A validated `BuilderProfile`-shaped object MINUS `id`/`status`/`softmaxPlayerIdentities` — same reason. `verifiedGithub` is deliberately absent: only an operator, after confirming the submitter's platform-account GitHub login, ever sets it. */
  proposedBuilder: {
    slug: string;
    displayName: string;
    shortBio: string | null;
    avatarUrl: null;
    links: readonly string[];
    teamMembers: readonly string[];
    claimedGithub: string | null;
  };
  emblemPreviewSvg: string;
  /** Rendered for the "copy this" panel — the exact JSON an operator pastes into a PR against `resources/identity/agents.json` / `builders.json`. */
  profileFileJson: string;
}

const REGISTRY_REPO = "0xNad/ProxyWar" as const;

export function buildRegistrationDraft(
  input: BuildRegistrationSubmissionInput,
): BuildRegistrationDraft {
  const agentSlugCandidate = SlugSchema.safeParse(slugify(input.agentName));
  const agentSlug = agentSlugCandidate.success
    ? agentSlugCandidate.data
    : "unnamed-agent";
  const builderSlugCandidate = SlugSchema.safeParse(
    slugify(input.builderDisplayName),
  );
  const builderSlug = builderSlugCandidate.success
    ? builderSlugCandidate.data
    : "unnamed-builder";

  const emblemSeed = `agt_${agentSlug}`;
  const palette = deriveEmblemPalette(emblemSeed);
  const primaryColor = HexColorSchema.parse(palette.primary);
  const secondaryColor = HexColorSchema.parse(palette.secondary);
  const shortCode = ShortCodeSchema.parse(input.shortCode);

  const proposedAgent: BuildRegistrationDraft["proposedAgent"] = {
    slug: agentSlug,
    displayName: input.agentName,
    shortCode,
    tagline: input.tagline,
    description: null,
    publicStrategyDescription: input.publicStrategyDescription,
    emblem: {
      style: "geometric-svg-v1",
      seed: emblemSeed,
      assetPath: `resources/identity/emblems/${emblemSeed}.svg`,
    },
    primaryColor,
    secondaryColor,
  };
  const proposedBuilder: BuildRegistrationDraft["proposedBuilder"] = {
    slug: builderSlug,
    displayName: input.builderDisplayName,
    shortBio: input.builderShortBio,
    avatarUrl: null,
    links: input.sourceRepositoryRef
      ? [...input.builderLinks, input.sourceRepositoryRef]
      : input.builderLinks,
    teamMembers: input.teamMembers,
    claimedGithub: input.claimedGithub,
  };

  return {
    proposedAgent,
    proposedBuilder,
    emblemPreviewSvg: generateEmblemSvg(emblemSeed),
    profileFileJson: JSON.stringify(
      {
        proposedAgent,
        proposedBuilder,
        note:
          "policyMatchRule (playerName + policyFamily) and Agent.status/Builder.status/verifiedGithub are set by an operator at merge time, once the submitter's real Coworld player name is confirmed (see /build Step 5).",
      },
      null,
      2,
    ),
  };
}

/** GitHub's documented "New Issue" URL-prefill query params (`title`, `body`, `labels`) — https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue#creating-an-issue-from-a-url-query. Never auto-submitted; the submitter reviews and clicks "Submit new issue" themselves in their own browser session. */
export function buildRegistrationIssueUrl(
  draft: BuildRegistrationDraft,
): string {
  const title = `Agent registration: ${draft.proposedAgent.displayName}`;
  const body = [
    "New Agent registration submitted via /build Step 3.",
    "",
    "An operator must confirm this submitter's GitHub login (via their signed-in Proxy War account) matches `claimedGithub` below before setting `verifiedGithub` and merging.",
    "",
    "```json",
    draft.profileFileJson,
    "```",
  ].join("\n");
  const params = new URLSearchParams({
    title,
    body,
    labels: "agent-registration",
  });
  return `https://github.com/${REGISTRY_REPO}/issues/new?${params.toString()}`;
}
