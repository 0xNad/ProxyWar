import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAgentStatsSections } from "../../src/client/AgentStatsSections";
import type {
  AgentMetric,
  AgentStatsSlice,
  PublicAgentStats,
} from "../../src/client/AgentStatsSchema";
import type * as UtilsModule from "../../src/client/Utils";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof UtilsModule>()),
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));

function metric(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    value: 0.5,
    sampleSize: 100,
    threshold: 50,
    methodology: "test methodology",
    ...overrides,
  };
}

function emptySlice(overrides: Partial<AgentStatsSlice> = {}): AgentStatsSlice {
  return {
    episodeCount: 10,
    fingerprint: {
      aggression: null,
      diplomacyInitiated: null,
      economicFocus: null,
      territory: { share: null, absoluteTiles: null, meanRank: null },
      armyStrength: null,
      reliability: null,
    },
    social: {
      alliancesInitiated: null,
      allianceAcceptanceRate: null,
      betrayalCount: null,
      frequentAllies: [],
      primaryAdversaries: [],
      treatyDuration: null,
    },
    ...overrides,
  };
}

function mountedContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("renderAgentStatsSections", () => {
  it("renders nothing at all when stats is null", () => {
    const container = mountedContainer();
    render(renderAgentStatsSections(null), container);
    expect(container.textContent?.trim()).toBe("");
  });

  it("renders nothing when the player has zero retained episodes", () => {
    const container = mountedContainer();
    const stats: PublicAgentStats = {
      career: emptySlice({ episodeCount: 0 }),
      currentVersion: null,
    };
    render(renderAgentStatsSections(stats), container);
    expect(container.textContent?.trim()).toBe("");
  });

  it("hides every below-threshold metric individually, showing only what clears its own threshold", () => {
    const container = mountedContainer();
    const stats: PublicAgentStats = {
      career: emptySlice({
        fingerprint: {
          aggression: metric({ value: 0.42 }),
          diplomacyInitiated: null, // below threshold -> hidden
          economicFocus: null,
          territory: { share: null, absoluteTiles: null, meanRank: null },
          armyStrength: null,
          reliability: null,
        },
      }),
      currentVersion: null,
    };
    render(renderAgentStatsSections(stats), container);
    expect(container.querySelectorAll(".agent-stat-row")).toHaveLength(1);
    expect(container.textContent).toContain("agent_stats.aggression");
    expect(container.textContent).not.toContain(
      "agent_stats.diplomacy_initiated",
    );
    // A below-threshold fingerprint entirely (no metric cleared its bar)
    // shows the honest "not enough data" note instead of an empty grid.
    expect(container.textContent).toContain(
      "agent_stats.social_below_threshold",
    );
  });

  it("shows a real-denominator territory share when resolved, and the absolute-tiles/rank fallback when it wasn't", () => {
    const withShare = mountedContainer();
    render(
      renderAgentStatsSections({
        career: emptySlice({
          fingerprint: {
            aggression: null,
            diplomacyInitiated: null,
            economicFocus: null,
            territory: {
              share: metric({ value: 0.31 }),
              absoluteTiles: { mean: 5000, sampleSize: 3 },
              meanRank: { value: 2.1, sampleSize: 3 },
            },
            armyStrength: null,
            reliability: null,
          },
        }),
        currentVersion: null,
      }),
      withShare,
    );
    expect(withShare.textContent).toContain("agent_stats.territory_share");
    expect(withShare.textContent).not.toContain("agent_stats.territory_tiles");

    const withoutShare = mountedContainer();
    render(
      renderAgentStatsSections({
        career: emptySlice({
          fingerprint: {
            aggression: null,
            diplomacyInitiated: null,
            economicFocus: null,
            territory: {
              share: null,
              absoluteTiles: { mean: 5000, sampleSize: 3 },
              meanRank: { value: 2.1, sampleSize: 3 },
            },
            armyStrength: null,
            reliability: null,
          },
        }),
        currentVersion: null,
      }),
      withoutShare,
    );
    expect(withoutShare.textContent).toContain("agent_stats.territory_tiles");
    expect(withoutShare.textContent).not.toContain(
      "agent_stats.territory_share",
    );
  });

  it("renders frequent allies and primary adversaries as named lists, omitted when empty", () => {
    const container = mountedContainer();
    render(
      renderAgentStatsSections({
        career: emptySlice({
          social: {
            alliancesInitiated: null,
            allianceAcceptanceRate: null,
            betrayalCount: null,
            frequentAllies: [{ name: "Blitz", count: 5 }],
            primaryAdversaries: [],
            treatyDuration: null,
          },
        }),
        currentVersion: null,
      }),
      container,
    );
    expect(container.textContent).toContain("Blitz");
    expect(container.textContent).toContain("agent_stats.frequent_allies");
    expect(container.textContent).not.toContain(
      "agent_stats.primary_adversaries",
    );
  });

  it("never renders currentVersion — the career slice is the only one rendered today", () => {
    const container = mountedContainer();
    render(
      renderAgentStatsSections({
        career: emptySlice({
          fingerprint: {
            aggression: metric({ value: 0.1 }),
            diplomacyInitiated: null,
            economicFocus: null,
            territory: { share: null, absoluteTiles: null, meanRank: null },
            armyStrength: null,
            reliability: null,
          },
        }),
        currentVersion: {
          ...emptySlice({
            fingerprint: {
              aggression: metric({ value: 0.99 }),
              diplomacyInitiated: null,
              economicFocus: null,
              territory: { share: null, absoluteTiles: null, meanRank: null },
              armyStrength: null,
              reliability: null,
            },
          }),
          versionLabel: "v99",
        },
      }),
      container,
    );
    // Only the career value (0.1 -> 10%) should be visible, never the
    // currentVersion value (0.99 -> 99%).
    expect(container.textContent).toContain("10%");
    expect(container.textContent).not.toContain("99%");
  });
});
