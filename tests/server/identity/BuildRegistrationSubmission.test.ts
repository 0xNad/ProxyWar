import { describe, expect, test } from "vitest";
import {
  buildRegistrationDraft,
  buildRegistrationIssueUrl,
  BuildRegistrationSubmissionInputSchema,
  type BuildRegistrationSubmissionInput,
} from "../../../src/server/identity/BuildRegistrationSubmission";
import { deriveEmblemPalette } from "../../../src/server/identity/IdentityEmblems";

function baseInput(
  overrides: Partial<BuildRegistrationSubmissionInput> = {},
): BuildRegistrationSubmissionInput {
  return {
    agentName: "Cyan Hellstar",
    shortCode: "CHS",
    tagline: "Fast expansion, faster betrayal.",
    publicStrategyDescription: "Rushes the nearest neutral tile.",
    builderDisplayName: "Ada Builder",
    builderShortBio: "Solo hobbyist.",
    builderLinks: ["https://example.com/ada"],
    teamMembers: [],
    claimedGithub: "ada-builder",
    sourceRepositoryRef: "https://github.com/ada-builder/my-policy",
    ...overrides,
  };
}

describe("BuildRegistrationSubmissionInputSchema", () => {
  test("accepts a well-formed submission", () => {
    expect(
      BuildRegistrationSubmissionInputSchema.safeParse(baseInput()).success,
    ).toBe(true);
  });

  test("rejects an unrecognized field (strict schema)", () => {
    const parsed = BuildRegistrationSubmissionInputSchema.safeParse({
      ...baseInput(),
      verifiedGithub: "not-allowed",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects a short code outside 2-4 uppercase alphanumeric characters", () => {
    expect(
      BuildRegistrationSubmissionInputSchema.safeParse(
        baseInput({ shortCode: "toolong" }),
      ).success,
    ).toBe(false);
  });
});

describe("buildRegistrationDraft", () => {
  test("slugifies the Agent name into a URL-safe slug", () => {
    const draft = buildRegistrationDraft(baseInput());
    expect(draft.proposedAgent.slug).toBe("cyan-hellstar");
  });

  test("never sets verifiedGithub on the actual draft data — only claimedGithub, which an operator must confirm", () => {
    const draft = buildRegistrationDraft(baseInput());
    expect(draft.proposedBuilder.claimedGithub).toBe("ada-builder");
    expect(draft.proposedBuilder).not.toHaveProperty("verifiedGithub");
    const parsed = JSON.parse(draft.profileFileJson);
    expect(parsed.proposedBuilder).not.toHaveProperty("verifiedGithub");
    // The human-readable note MAY explain when an operator sets
    // verifiedGithub — that's the whole point of not faking instant
    // publication — but it must read as future/operator action, not a
    // value already assigned to this submission.
    expect(parsed.note).toContain("operator");
  });

  test("derives emblem colors identically to the real registry generator for the same seed", () => {
    const draft = buildRegistrationDraft(baseInput());
    const palette = deriveEmblemPalette(draft.proposedAgent.emblem.seed);
    expect(draft.proposedAgent.primaryColor).toBe(palette.primary);
    expect(draft.proposedAgent.secondaryColor).toBe(palette.secondary);
  });

  test("the emblem seed matches the AgentProfile id convention (agt_<slug>)", () => {
    const draft = buildRegistrationDraft(baseInput());
    expect(draft.proposedAgent.emblem.seed).toBe("agt_cyan-hellstar");
    expect(draft.proposedAgent.emblem.assetPath).toBe(
      "resources/identity/emblems/agt_cyan-hellstar.svg",
    );
  });

  test("never includes policyMatchRule, id, builderId, or status — an operator assigns those at merge time", () => {
    const draft = buildRegistrationDraft(baseInput());
    expect(draft.proposedAgent).not.toHaveProperty("policyMatchRule");
    expect(draft.proposedAgent).not.toHaveProperty("id");
    expect(draft.proposedAgent).not.toHaveProperty("status");
  });

  test("appends sourceRepositoryRef onto the Builder's links without duplicating it if already present", () => {
    const draft = buildRegistrationDraft(baseInput());
    expect(draft.proposedBuilder.links).toEqual([
      "https://example.com/ada",
      "https://github.com/ada-builder/my-policy",
    ]);
  });

  test("omits sourceRepositoryRef from links when not provided", () => {
    const draft = buildRegistrationDraft(
      baseInput({ sourceRepositoryRef: null }),
    );
    expect(draft.proposedBuilder.links).toEqual(["https://example.com/ada"]);
  });

  test("produces valid, parseable JSON in profileFileJson", () => {
    const draft = buildRegistrationDraft(baseInput());
    expect(() => JSON.parse(draft.profileFileJson)).not.toThrow();
  });

  test("emblemPreviewSvg is deterministic for the same Agent name", () => {
    const first = buildRegistrationDraft(baseInput());
    const second = buildRegistrationDraft(baseInput());
    expect(first.emblemPreviewSvg).toBe(second.emblemPreviewSvg);
  });
});

describe("buildRegistrationIssueUrl", () => {
  test("targets the real registry repo with a prefilled title, body, and label", () => {
    const draft = buildRegistrationDraft(baseInput());
    const url = buildRegistrationIssueUrl(draft);
    expect(url.startsWith("https://github.com/0xNad/ProxyWar/issues/new?")).toBe(
      true,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).toContain("Cyan Hellstar");
    expect(parsed.searchParams.get("labels")).toBe("agent-registration");
    expect(parsed.searchParams.get("body")).toContain("claimedGithub");
  });

  test("never auto-includes a verifiedGithub claim in the issue body", () => {
    const draft = buildRegistrationDraft(baseInput());
    const url = buildRegistrationIssueUrl(draft);
    const body = new URL(url).searchParams.get("body") ?? "";
    expect(body).not.toContain('"verifiedGithub"');
  });
});
