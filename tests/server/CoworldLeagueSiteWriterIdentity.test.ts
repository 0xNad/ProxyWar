import { describe, expect, test } from "vitest";
import {
  coworldLeagueIndexHtml,
  type CoworldLeagueMirrorData,
} from "../../src/server/agents/CoworldLeagueSiteWriter";
import type {
  AgentProfile,
  AgentVersion,
  BuilderProfile,
} from "../../src/server/identity/IdentitySchemas";
import type { IdentityRegistrySnapshot } from "../../src/server/identity/IdentityRegistry";

/**
 * Integration coverage for Stage 1 item 7: registry identities render on the
 * league mirror, raw Coworld player names and exact policy labels move into
 * the per-row integrity drawer (never disappearing), and an unverified
 * builder can never render as an attributed name.
 */

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agt_daveey",
    slug: "daveey",
    displayName: "daveey",
    shortCode: "DAV",
    builderId: null,
    tagline: null,
    description: null,
    emblem: {
      style: "geometric-svg-v1",
      seed: "agt_daveey",
      assetPath: "resources/identity/emblems/agt_daveey.svg",
    },
    primaryColor: "#c62f39",
    secondaryColor: "#689e2e",
    debutDate: null,
    policyMatchRule: { playerName: "daveey", policyFamily: "daveey-proxywar" },
    status: "unclaimed",
    publicStrategyDescription: null,
    ...overrides,
  };
}

function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: "agtv_daveey_v24",
    agentId: "agt_daveey",
    publicVersionLabel: "v24",
    softmaxPolicyLabel: "daveey-proxywar:v24",
    immutableDigest: null,
    releaseDate: null,
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["champion", "rating"],
    observedAt: "2026-07-31T00:30:00.000Z",
    firstObservedAt: null,
    ...overrides,
  };
}

function builder(overrides: Partial<BuilderProfile> = {}): BuilderProfile {
  return {
    id: "bld_someone",
    slug: "someone",
    displayName: "Someone Verified",
    shortBio: null,
    avatarUrl: null,
    verifiedGithub: null,
    links: [],
    teamMembers: [],
    softmaxPlayerIdentities: [],
    status: "verified",
    ...overrides,
  };
}

function baseData(): CoworldLeagueMirrorData {
  return {
    generatedAt: "2026-07-13T12:00:00.000Z",
    lastGoodSyncAt: "2026-07-13T12:00:00.000Z",
    stale: false,
    championFeedStale: false,
    replayFeedStale: false,
    lastGoodReplaySyncAt: "2026-07-13T12:00:00.000Z",
    league: {
      id: "league_test",
      name: "Proxywar",
      description: "Test league",
      divisionName: "Competition",
      roundIntervalMinutes: 30,
      episodesPerRound: 8,
      currentRoundNumber: 268,
      currentRoundStatus: "running",
      scoreLabel: "Score",
    },
    standings: [
      {
        rank: 1,
        playerName: "daveey",
        ratingPolicyLabel: "daveey-proxywar:v24",
        activeChampionPolicyLabel: "daveey-proxywar:v24",
        policyLabel: "daveey-proxywar:v24",
        score: 22.66,
        roundsPlayed: 748,
        isHouse: false,
      },
      {
        rank: 2,
        playerName: "a brand new participant",
        ratingPolicyLabel: null,
        activeChampionPolicyLabel: "some-new-family:v1",
        policyLabel: null,
        score: 5,
        roundsPlayed: 10,
        isHouse: false,
      },
      {
        rank: 3,
        playerName: "Auri",
        ratingPolicyLabel: "proxywar-keystone:v42",
        activeChampionPolicyLabel: "proxywar-keystone:v42",
        policyLabel: "proxywar-keystone:v42",
        score: 14.99,
        roundsPlayed: 860,
        isHouse: true,
      },
    ],
    rounds: [],
    episodes: [],
    links: {
      enterTheLeagueUrl: "https://github.com/0xNad/proxywar-coworld-starter",
      platformLabel: "Softmax Coworld",
    },
  };
}

/** Strips every `<details class="integrity-drawer">...</details>` block so what remains is exactly the primary, always-visible HTML — the surface the "no raw label outside the drawer" acceptance criterion is about. */
function withoutIntegrityDrawers(html: string): string {
  return html.replace(
    /<details class="integrity-drawer">[\s\S]*?<\/details>/g,
    "",
  );
}

describe("registry identity rendering on the league mirror", () => {
  test("a matched agent renders emblem, display name, short code, and active version outside the drawer", () => {
    const identity: IdentityRegistrySnapshot = {
      builders: [],
      agents: [agent()],
      versions: [version()],
    };
    const html = coworldLeagueIndexHtml(baseData(), identity);
    expect(html).toContain('<span class="agent-emblem"><svg');
    expect(html).toContain(
      '<span class="agent-identity"><span class="agent-emblem">',
    );
    expect(html).toContain('<span class="agent-shortcode">DAV</span>');
    expect(html).toContain(
      '<span class="builder-note">Active version: v24</span>',
    );
    // Primary visible text is the exact live version, not the full raw label.
    const primary = withoutIntegrityDrawers(html);
    expect(primary).toContain("Active version: v24");
    expect(primary).not.toContain("daveey-proxywar:v24");
  });

  test("the exact raw policy label and the raw Coworld player name are present ONLY inside the integrity drawer — never outside it", () => {
    const identity: IdentityRegistrySnapshot = {
      builders: [],
      agents: [agent({ displayName: "The Daveey Agent" })],
      versions: [version()],
    };
    const html = coworldLeagueIndexHtml(baseData(), identity);
    // The raw label appears somewhere (never disappears)...
    expect(html).toContain("daveey-proxywar:v24");
    // ...but ONLY inside a drawer.
    const primary = withoutIntegrityDrawers(html);
    expect(primary).not.toContain("daveey-proxywar:v24");
    // The drawer itself carries the label.
    const drawerMatch = html.match(
      /<details class="integrity-drawer">[\s\S]*?<\/details>/,
    );
    expect(drawerMatch?.[0]).toContain("daveey-proxywar:v24");
    expect(drawerMatch?.[0]).toContain("Coworld player name: daveey");
  });

  test("an unmapped live player renders a provisional identity — player name plus a generated emblem, never a short code or builder — matching exactly what identity:list-unmapped would report", () => {
    const identity: IdentityRegistrySnapshot = {
      builders: [],
      agents: [agent()], // only "daveey" is registered; "a brand new participant" is not
      versions: [version()],
    };
    const html = coworldLeagueIndexHtml(baseData(), identity);
    expect(html).toContain(
      '<span class="agent-emblem"><svg',
    );
    expect(html).toContain("a brand new participant</span>");
    // No short-code markup ever attached to the unmapped row (that concept
    // only applies to a real registered AgentProfile) — provable because
    // the ONLY agent-shortcode in the page belongs to daveey.
    const shortCodeCount = (html.match(/class="agent-shortcode"/g) ?? []).length;
    expect(shortCodeCount).toBe(1);
    // daveey (registered), "a brand new participant", AND "Auri" (both
    // unregistered in THIS test's identity snapshot, which only contains
    // "daveey") all now carry an emblem — 2026-08-01 P0 fix; a real,
    // currently-competing participant is never anonymous.
    const emblemCount = (html.match(/class="agent-emblem"/g) ?? []).length;
    expect(emblemCount).toBe(3);
  });

  test("a house agent shows the existing HOUSE badge and no separate Unclaimed note", () => {
    const identity: IdentityRegistrySnapshot = {
      builders: [],
      agents: [
        agent({
          id: "agt_auri",
          slug: "auri",
          displayName: "Auri",
          shortCode: "AUR",
          policyMatchRule: { playerName: "Auri", policyFamily: "proxywar-keystone" },
          status: "house",
          emblem: { style: "geometric-svg-v1", seed: "agt_auri", assetPath: "resources/identity/emblems/agt_auri.svg" },
        }),
      ],
      versions: [],
    };
    const html = coworldLeagueIndexHtml(baseData(), identity);
    expect(html).toContain('<span class="badge house">HOUSE</span>');
    expect(html).not.toContain("Unclaimed");
  });

  test("no-auto-attribution: an unverified (builderId null) AgentProfile always renders \"Unclaimed\", never a builder display name, even though a BuilderProfile with a similar name exists in the registry", () => {
    const identity: IdentityRegistrySnapshot = {
      // A builder exists in the registry, but NO AgentProfile references it
      // (builderId stays null) — matching by proximity/similarity must never
      // happen; the render must show "Unclaimed", not this builder's name.
      builders: [
        builder({ id: "bld_daveey", slug: "daveey", displayName: "daveey (unrelated builder account)" }),
      ],
      agents: [agent({ builderId: null })],
      versions: [version()],
    };
    const html = coworldLeagueIndexHtml(baseData(), identity);
    expect(html).toContain(
      '<span class="builder-note">Unclaimed</span>',
    );
    expect(html).not.toContain("unrelated builder account");
  });

  test("once builderId genuinely references a registered BuilderProfile, its display name renders as Builder: <name>", () => {
    const identity: IdentityRegistrySnapshot = {
      builders: [builder()],
      agents: [agent({ builderId: "bld_someone", status: "verified" })],
      versions: [version()],
    };
    const html = coworldLeagueIndexHtml(baseData(), identity);
    expect(html).toContain(
      '<span class="builder-note">Builder: Someone Verified</span>',
    );
  });

  test("without an identity snapshot argument (legacy call site), every row falls back to a provisional identity — no crash, a generated emblem, never a short code/builder", () => {
    const html = coworldLeagueIndexHtml(baseData());
    expect(html).toContain('<span class="agent-emblem"><svg');
    expect(html).toContain("daveey</span>");
    expect(html).not.toContain('class="agent-shortcode"');
  });
});
