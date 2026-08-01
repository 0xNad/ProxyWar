import { describe, expect, it } from "vitest";
import { isFeaturedEventRevealed, isPubliclyPromotable } from "../../../../src/server/agents/season/EventPackageGate";
import type { FeaturedMatch } from "../../../../src/server/agents/FeaturedMatch";
import type { EventPackage } from "../../../../src/server/agents/season/EventPackage";

const FEAT_ID = `feat_${"a".repeat(20)}`;

function baseMatch(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: FEAT_ID,
    lane: "premiere",
    episodeRequestId: "ereq_123",
    queueItemName: "20260801T000000Z-run1",
    title: "Auri vs Sefirot",
    description: "",
    participants: [
      { playerName: "Auri", agentId: "agt_auri", agentVersionId: "agtv_auri_v43", builderId: null },
      { playerName: "Sefirot", agentId: "agt_sefirot", agentVersionId: "agtv_sefirot_v10", builderId: null },
    ],
    map: "Pangaea",
    format: "2p duel",
    provenance: { source: "premiere-queue", sourceRef: "20260801T000000Z-run1", capturedAt: "2026-08-01T00:00:00.000Z" },
    state: "published",
    category: null,
    scheduledAt: "2026-08-08T18:00:00.000Z",
    revealAt: null,
    evidence: {
      dramaScore: null,
      dramaGrade: null,
      entertainmentScore: null,
      storyGrade: null,
      turnCount: 10000,
      decisionCount: null,
      degradedCount: 0,
      seatCount: 2,
      replayComplete: true,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function basePackage(overrides: Partial<EventPackage> = {}): EventPackage {
  return {
    schemaVersion: 1,
    featuredMatchId: FEAT_ID,
    title: "Auri vs Sefirot",
    subtitle: "Pangaea — 2p duel",
    reasonToWatch: {
      claims: [
        { text: "Auri debuts v43.", source: "version_debut", reference: "version:agtv_auri_v43:firstObservedAt=2026-08-01T00:00:00.000Z" },
      ],
    },
    mapLabel: "Pangaea",
    format: "2p duel",
    scheduledAt: "2026-08-08T18:00:00.000Z",
    directorCutEstimateSeconds: 480,
    canonicalMatchUrl: `/match/${FEAT_ID}`,
    canonicalPremiereUrl: "/premiere/abc123",
    embargoState: "embargoed",
    editorialNotes: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isFeaturedEventRevealed", () => {
  it("is always true for archive-lane matches", () => {
    expect(isFeaturedEventRevealed(baseMatch({ lane: "archive", state: "published" }))).toBe(true);
  });

  it("is false for a published (not yet revealed) premiere-lane match", () => {
    expect(isFeaturedEventRevealed(baseMatch({ state: "published" }))).toBe(false);
  });

  it("is true once a premiere-lane match reaches revealed/archived", () => {
    expect(isFeaturedEventRevealed(baseMatch({ state: "revealed" }))).toBe(true);
    expect(isFeaturedEventRevealed(baseMatch({ state: "archived" }))).toBe(true);
  });
});

describe("isPubliclyPromotable", () => {
  it("accepts a fully complete premiere-lane package", () => {
    const result = isPubliclyPromotable(baseMatch(), basePackage());
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it("rejects when no package exists at all — the anonymous-premiere case", () => {
    const result = isPubliclyPromotable(baseMatch(), null);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["event_package_missing"]);
  });

  it("rejects a package generated for a different match", () => {
    const result = isPubliclyPromotable(baseMatch(), basePackage({ featuredMatchId: `feat_${"b".repeat(20)}` }));
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("event_package_mismatched_featured_match_id");
  });

  it("flags a premiere-lane record still in candidate/scheduled state — never promotable ahead of premiere:publish", () => {
    expect(
      isPubliclyPromotable(baseMatch({ state: "candidate" }), basePackage()).missing,
    ).toContain("not_yet_published");
    expect(
      isPubliclyPromotable(baseMatch({ state: "scheduled" }), basePackage()).missing,
    ).toContain("not_yet_published");
  });

  it("never flags not_yet_published for an archive-lane record regardless of state", () => {
    const match = baseMatch({
      lane: "archive",
      state: "published",
      scheduledAt: null,
      queueItemName: null,
      provenance: { source: "league-archive", sourceRef: "ereq_123", capturedAt: "2026-08-01T00:00:00.000Z" },
    });
    const pkg = basePackage({ scheduledAt: null, canonicalPremiereUrl: null, embargoState: "revealed" });
    expect(isPubliclyPromotable(match, pkg).missing).not.toContain("not_yet_published");
  });

  it("flags a missing title", () => {
    const result = isPubliclyPromotable(baseMatch({ title: "" }), basePackage());
    expect(result.missing).toContain("title");
  });

  it("flags a missing subtitle", () => {
    expect(isPubliclyPromotable(baseMatch(), basePackage({ subtitle: "" })).missing).toContain("subtitle");
  });

  it("flags an empty reason-to-watch (no evidence claims)", () => {
    expect(
      isPubliclyPromotable(baseMatch(), basePackage({ reasonToWatch: { claims: [] } })).missing,
    ).toContain("reason_to_watch");
  });

  it("flags a premiere-lane match with no canonical episode reference", () => {
    expect(
      isPubliclyPromotable(baseMatch({ episodeRequestId: null }), basePackage()).missing,
    ).toContain("canonical_episode_reference");
  });

  it("flags zero participants", () => {
    expect(isPubliclyPromotable(baseMatch({ participants: [] }), basePackage()).missing).toContain("participants");
  });

  it("flags an unresolved participant identity, naming the player", () => {
    const match = baseMatch({
      participants: [
        { playerName: "Ghost", agentId: null, agentVersionId: null, builderId: null },
        { playerName: "Sefirot", agentId: "agt_sefirot", agentVersionId: "agtv_sefirot_v10", builderId: null },
      ],
    });
    const missing = isPubliclyPromotable(match, basePackage()).missing;
    expect(missing).toContain("participant_identity_unresolved:Ghost");
    expect(missing).toContain("participant_version_unresolved:Ghost");
  });

  it("flags an agent resolved but with no exact version", () => {
    const match = baseMatch({
      participants: [
        { playerName: "Auri", agentId: "agt_auri", agentVersionId: null, builderId: null },
        { playerName: "Sefirot", agentId: "agt_sefirot", agentVersionId: "agtv_sefirot_v10", builderId: null },
      ],
    });
    expect(isPubliclyPromotable(match, basePackage()).missing).toContain("participant_version_unresolved:Auri");
  });

  it("flags a missing map/format", () => {
    expect(isPubliclyPromotable(baseMatch({ map: "" }), basePackage()).missing).toContain("map");
    expect(isPubliclyPromotable(baseMatch({ format: "" }), basePackage()).missing).toContain("format");
  });

  it("flags a premiere-lane match with no scheduled time", () => {
    expect(
      isPubliclyPromotable(baseMatch({ scheduledAt: null }), basePackage({ scheduledAt: null })).missing,
    ).toContain("scheduled_time");
  });

  it("flags a missing Director Cut estimate", () => {
    expect(
      isPubliclyPromotable(baseMatch(), basePackage({ directorCutEstimateSeconds: null })).missing,
    ).toContain("director_cut_estimate");
  });

  it("flags a missing canonical match URL", () => {
    expect(isPubliclyPromotable(baseMatch(), basePackage({ canonicalMatchUrl: "" })).missing).toContain(
      "canonical_match_url",
    );
  });

  it("flags a premiere-lane match with no canonical premiere URL", () => {
    expect(
      isPubliclyPromotable(baseMatch(), basePackage({ canonicalPremiereUrl: null })).missing,
    ).toContain("canonical_premiere_url");
  });

  it("never requires a canonical premiere URL for an archive-lane match", () => {
    const match = baseMatch({
      lane: "archive",
      state: "published",
      scheduledAt: null,
      queueItemName: null,
      provenance: { source: "league-archive", sourceRef: "ereq_123", capturedAt: "2026-08-01T00:00:00.000Z" },
    });
    const pkg = basePackage({ scheduledAt: null, canonicalPremiereUrl: null, embargoState: "revealed" });
    expect(isPubliclyPromotable(match, pkg).missing).not.toContain("canonical_premiere_url");
  });

  it("flags an inconsistent embargo state — revealed on the package but not actually revealed", () => {
    expect(
      isPubliclyPromotable(baseMatch({ state: "published" }), basePackage({ embargoState: "revealed" })).missing,
    ).toContain("embargo_state_inconsistent");
  });

  it("accepts embargoState revealed once the match has actually revealed", () => {
    const result = isPubliclyPromotable(baseMatch({ state: "revealed" }), basePackage({ embargoState: "revealed" }));
    expect(result.missing).not.toContain("embargo_state_inconsistent");
  });
});
