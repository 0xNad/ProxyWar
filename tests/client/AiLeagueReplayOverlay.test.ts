import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("../../src/client/analytics/AnalyticsClient", () => ({
  analytics: { track: trackMock, trackVisitStart: vi.fn() },
}));
import {
  activeWarPairCount,
  deriveMatchStateStripFields,
  mountAiLeagueReplayOverlay,
  normalizeMatchStateSeries,
} from "../../src/client/AiLeagueReplayOverlay";
import {
  BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT,
  BROADCAST_RAIL_FOLLOW_EVENT,
} from "../../src/client/graphics/layers/PointOfViewSelector";
import type { PublicAgent } from "../../src/client/publicapp/ReadModelSchema";
import {
  initialReplayClipRenderableThroughTurn,
  replayClipPreviewTarget,
} from "../../src/client/ReplayClipControl";

describe("AiLeagueReplayOverlay", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 768,
    });
    document.body.innerHTML = "";
    localStorage.clear();
    trackMock.mockClear();
  });

  it("accepts only a matching fresh-document Clip Preview target", () => {
    expect(
      replayClipPreviewTarget(
        "?turn=605&renderFastForwardUntilTurn=605&clipPreview=1",
      ),
    ).toBe(605);
    expect(
      replayClipPreviewTarget(
        "?turn=605&renderFastForwardUntilTurn=604&clipPreview=1",
      ),
    ).toBeNull();
    expect(
      replayClipPreviewTarget("?turn=605&renderFastForwardUntilTurn=605"),
    ).toBeNull();
  });

  it("renders a read-only decision panel for the real ProxyWar replay route", () => {
    mountAiLeagueReplayOverlay({
      runID: "run-render-1",
      artifactBasePath: "/ai-league-runs/run-render-1",
      summary: {
        roster: [{ agentID: "a1" }],
        runnerConfig: {
          bots: 5,
          nations: 5,
          maxSteps: 15,
        },
        finalState: {
          opponents: [{ playerID: "n1" }, { playerID: "n2" }],
        },
      },
      decisions: [
        {
          sequence: 1,
          turnNumber: 300,
          username: "Agent One",
          profile: "aggressive",
          brainType: "mock-llm",
          selectedActionKind: "build",
          selectedLegalActionId: "build:Defense Post:10",
          legalActionIDsByKind: {
            build: ["build:Defense Post:10"],
          },
          planObjective: "fortify_core",
          reason: "Build a defensive post.",
          decisionLatencyMs: 25,
          fallbackUsed: false,
          parseSuccess: true,
          result: {
            accepted: true,
            reason: "accepted",
          },
          auditStatus: "confirmed",
          generatedIntent: {
            type: "build_unit",
          },
        },
        {
          sequence: 2,
          turnNumber: 400,
          username: "Agent One",
          profile: "aggressive",
          brainType: "mock-llm",
          selectedActionKind: "quick_chat",
          selectedLegalActionId: "quick_chat:rival:attack.attack",
          batchActionIDs: [
            "expand:terra-nullius:10",
            "quick_chat:rival:attack.attack",
          ],
          legalActionIDsByKind: {
            attack: ["expand:terra-nullius:10"],
            quick_chat: ["quick_chat:rival:attack.attack"],
          },
          selectedActionMetadata: {
            message: "Focus fire on Rival!",
            recipientName: "Rival",
          },
          reason: "Coordinate pressure on the weak rival.",
          decisionLatencyMs: 20,
          fallbackUsed: false,
          parseSuccess: true,
          result: {
            accepted: true,
            reason: "accepted",
          },
          auditStatus: "not_applicable",
          generatedIntent: {
            type: "send_quick_chat",
          },
        },
        {
          sequence: 3,
          turnNumber: 425,
          username: "Agent One",
          profile: "aggressive",
          brainType: "mock-llm",
          selectedActionKind: "attack",
          selectedLegalActionId: "expand:terra-nullius:10",
          legalActionIDsByKind: {
            attack: ["expand:terra-nullius:10"],
          },
          selectedActionMetadata: {
            expansion: true,
          },
          reason: "Take neutral land immediately.",
          decisionLatencyMs: 15,
          fallbackUsed: false,
          parseSuccess: true,
          result: {
            accepted: true,
            reason: "accepted",
          },
          auditStatus: "unknown",
          generatedIntent: {
            type: "attack",
          },
        },
      ],
    });

    const overlay = document.getElementById("ai-league-replay-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("ai_league_replay.title");
    // The decision log is windowed to the playhead, so nothing from turn 300
    // renders until playback has actually reached it.
    expect(overlay?.textContent).not.toContain("build:Defense Post:10");
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 500, turnNumber: 500, players: [] },
      }),
    );
    expect(overlay?.textContent).toContain("build:Defense Post:10");
    // The setup line goes through translateText (it used to be hardcoded
    // English). translateText echoes the key in tests, as with the title above.
    // Match identity moved from a body card into the header subtitle, and the
    // "Plays mostly" line was removed entirely.
    expect(
      overlay?.querySelector("[data-ai-league-subtitle]")?.textContent,
    ).toContain("ai_league_replay.setup_agents_vs_builtin");
    expect(overlay?.querySelector(".ai-league-playstyle")).toBeNull();
    expect(overlay?.querySelector(".ai-league-metrics")).not.toBeNull();
    // No speed slider, story card, or opening-neutral section in the overlay.
    expect(overlay?.querySelector("[data-ai-league-speed]")).toBeNull();
    expect(overlay?.querySelector(".ai-league-story")).toBeNull();
    expect(overlay?.textContent).not.toContain("Match story");
    expect(overlay?.textContent).not.toContain("Opening neutral land");
    // Directive (planObjective) is surfaced in the decision card.
    expect(overlay?.textContent).toContain("fortify_core");
    // Decision card no longer prints latency / intent type / audit status.
    expect(overlay?.textContent).not.toContain("25ms");
    expect(overlay?.textContent).not.toContain("build_unit");
    // Raw artifact download links were removed from the panel; nothing in the
    // body should link out to the run bundle any more.
    expect(overlay?.querySelector("a")).toBeNull();

    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: {
          tick: 410,
          turnNumber: 410,
          players: [
            {
              playerID: "agent-one",
              smallID: 1,
              clientID: "client-one",
              username: "Agent One",
              displayName: "Agent One",
              x: 320,
              y: 240,
              tilesOwned: 42,
              allies: [],
              embargoes: [],
              alliances: [],
            },
          ],
        },
      }),
    );

    // Floating map message bubbles were removed: no bubble layer is mounted.
    expect(document.getElementById("ai-league-social-map-bubbles")).toBeNull();
    expect(document.querySelector(".ai-league-map-social-bubble")).toBeNull();
    // The political-radio transcript stays and now carries the social line
    // (speaker + text) that used to render in the bubble.
    const transcript = document.getElementById("ai-league-social-transcript");
    expect(transcript?.textContent).toContain("Political radio");
    expect(transcript?.textContent).toContain("Focus fire on Rival!");
    expect(transcript?.textContent).toContain("Agent One");

    // Standings strip updates live from the frame event (ranked, share %).
    const standings = overlay?.querySelector("[data-ai-league-diplomacy-rows]");
    expect(standings?.textContent).toContain("Agent One");
    expect(standings?.textContent).toContain("100%");
  });

  it("renders a live diplomacy strip with ally and embargo glyphs from frame state", () => {
    mountAiLeagueReplayOverlay({
      runID: "diplomacy-render",
      artifactBasePath: "/ai-league-runs/diplomacy-render",
      decisions: [],
    });

    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: {
          tick: 1000,
          turnNumber: 1000,
          players: [
            {
              playerID: "p1",
              smallID: 1,
              clientID: "c1",
              username: "Crimson",
              displayName: "Crimson",
              x: 100,
              y: 100,
              color: "rgb(220, 38, 38)",
              tilesOwned: 60,
              allies: [2],
              targets: [3],
              embargoes: ["p3"],
              alliances: [
                { other: "p2", expiresAt: 5000, hasExtensionRequest: true },
              ],
            },
            {
              playerID: "p2",
              smallID: 2,
              clientID: "c2",
              username: "Azure",
              displayName: "Azure",
              x: 200,
              y: 200,
              color: "rgb(37, 99, 235)",
              tilesOwned: 30,
              allies: [1],
              targets: [],
              embargoes: [],
              alliances: [
                { other: "p1", expiresAt: 5000, hasExtensionRequest: false },
              ],
            },
            {
              playerID: "p3",
              smallID: 3,
              clientID: "c3",
              username: "Slate",
              displayName: "Slate",
              x: 300,
              y: 300,
              color: "rgb(22, 163, 74)",
              tilesOwned: 10,
              allies: [],
              targets: [],
              embargoes: [],
              alliances: [],
            },
          ],
        },
      }),
    );

    const rows = document.querySelector("[data-ai-league-diplomacy-rows]");
    expect(rows?.querySelectorAll(".ai-league-diplo-row").length).toBe(3);
    // Ranked by tiles: Crimson 60 (60%), Azure 30 (30%), Slate 10 (10%).
    expect(rows?.textContent).toContain("60%");
    expect(rows?.textContent).toContain("30%");
    expect(rows?.textContent).toContain("10%");
    // Ally + embargo + war stance chips render (type by class, not hue).
    const allyChip = rows?.querySelector<HTMLElement>(".ai-league-stance.ally");
    const embargoChip = rows?.querySelector<HTMLElement>(
      ".ai-league-stance.embargo",
    );
    const warChip = rows?.querySelector<HTMLElement>(".ai-league-stance.war");
    expect(allyChip).not.toBeNull();
    expect(embargoChip).not.toBeNull();
    // Crimson targets Slate -> a war chip is produced from frame target state.
    expect(warChip).not.toBeNull();
    // The relationship is shown by an ICON, not a trailing word: each chip's
    // glyph holds an inline <svg> and the translated label lives on title /
    // aria-label, NOT as a parenthesized inline text label.
    for (const chip of [allyChip, embargoChip, warChip]) {
      const glyph = chip?.querySelector<HTMLElement>(".ai-league-stance-glyph");
      expect(glyph?.querySelector("svg")).not.toBeNull();
    }
    expect(
      allyChip?.querySelector(".ai-league-stance-glyph")?.getAttribute("title"),
    ).toContain("ally");
    expect(
      embargoChip
        ?.querySelector(".ai-league-stance-glyph")
        ?.getAttribute("aria-label"),
    ).toContain("embargo");
    expect(
      warChip?.querySelector(".ai-league-stance-glyph")?.getAttribute("title"),
    ).toContain("war");
    // The relationship word is no longer rendered as a parenthesized inline
    // label next to the name.
    expect(rows?.textContent).not.toContain("(embargo)");
    expect(rows?.textContent).not.toContain("(ally)");
    expect(rows?.textContent).not.toContain("(war)");
    // The on-map engine color (rgb) drives the dots, not the fallback palette hex.
    const crimsonDot = rows?.querySelector<HTMLElement>(".ai-league-color-dot");
    expect(crimsonDot?.getAttribute("style")).toContain("rgb(220, 38, 38)");
    // No N x N relationship matrix any more.
    expect(
      document.querySelectorAll("[data-spectator-relationship-cell]").length,
    ).toBe(0);
    // Extension request still surfaces the renew glyph (now alongside the icon).
    expect(rows?.textContent).toContain("↻");
  });

  it("surfaces a headline lower-third for promotable events and toggles talks", () => {
    const jumps: number[] = [];
    document.addEventListener("ai-league-replay-jump-turn", (event) => {
      jumps.push(
        (event as CustomEvent<{ turnNumber: number }>).detail.turnNumber,
      );
    });

    mountAiLeagueReplayOverlay({
      runID: "politics-render",
      artifactBasePath: "/ai-league-runs/politics-render",
      decisions: [],
      spectatorTelemetry: spectatorTelemetryFixture(),
    });

    const overlay = document.getElementById("ai-league-replay-overlay");
    // Diplomacy talks feed is present but collapsed behind a toggle.
    const comms = overlay?.querySelector<HTMLElement>("[data-spectator-comms]");
    expect(comms).not.toBeNull();
    expect(comms?.hidden).toBe(true);
    expect(comms?.textContent).toContain("pact is over");
    const toggle = overlay?.querySelector<HTMLButtonElement>(
      "[data-spectator-talks-toggle]",
    );
    toggle?.click();
    expect(comms?.hidden).toBe(false);

    // Story timeline is gone.
    expect(document.getElementById("ai-league-story-timeline")).toBeNull();

    // Headline lower-third exists and reveals a betrayal headline on the frame.
    const headline = document.getElementById("ai-league-headline-event");
    expect(headline).not.toBeNull();
    expect(headline?.hidden).toBe(true);
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 505, turnNumber: 505, players: [] },
      }),
    );
    expect(headline?.hidden).toBe(false);
    expect(headline?.textContent).toContain(
      "ai_league_replay.headline_betrayal",
    );

    // Replay jump still works from the comm-thread turn buttons.
    const jump = overlay?.querySelector<HTMLButtonElement>(
      "[data-ai-league-jump-turn]",
    );
    jump?.click();
    expect(jumps.length).toBeGreaterThan(0);
  });

  it("keeps the political-radio transcript readable by showing at most two lines at once", () => {
    mountAiLeagueReplayOverlay({
      runID: "politics-map",
      artifactBasePath: "/ai-league-runs/politics-map",
      decisions: [],
      spectatorTelemetry: spectatorTelemetryFixture(),
    });

    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: {
          tick: 510,
          turnNumber: 510,
          players: [
            {
              playerID: "p1",
              smallID: 1,
              clientID: "c1",
              username: "Atlas",
              displayName: "Atlas",
              x: 300,
              y: 260,
              tilesOwned: 60,
              allies: [],
              embargoes: [],
              alliances: [],
            },
            {
              playerID: "p2",
              smallID: 2,
              clientID: "c2",
              username: "Blitz",
              displayName: "Blitz",
              x: 420,
              y: 280,
              tilesOwned: 90,
              allies: [],
              embargoes: [],
              alliances: [],
            },
            {
              playerID: "p3",
              smallID: 3,
              clientID: "c3",
              username: "Civic",
              displayName: "Civic",
              x: 520,
              y: 300,
              tilesOwned: 20,
              allies: [],
              embargoes: [],
              alliances: [],
            },
          ],
        },
      }),
    );

    // No floating map bubbles are mounted any more.
    expect(document.getElementById("ai-league-social-map-bubbles")).toBeNull();
    expect(document.querySelector(".ai-league-map-social-bubble")).toBeNull();
    // The political radio stays and caps at two lines at once.
    const transcript = document.getElementById("ai-league-social-transcript");
    expect(transcript?.textContent).toContain("Political radio");
    expect(
      transcript?.querySelectorAll(".ai-league-social-transcript-line"),
    ).toHaveLength(2);
  });

  it("lets spectators move and reset the replay panel", () => {
    mountAiLeagueReplayOverlay({
      runID: "move-panel",
      artifactBasePath: "/ai-league-runs/move-panel",
      decisions: [],
    });

    const overlay = document.getElementById("ai-league-replay-overlay")!;
    const dragHandle = overlay.querySelector<HTMLElement>(
      "[data-ai-league-drag]",
    )!;
    dragHandle.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: 110,
        clientY: 95,
      }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(overlay.style.left).not.toBe("");
    expect(overlay.style.right).toBe("auto");

    overlay
      .querySelector<HTMLButtonElement>("[data-ai-league-reset-layout]")
      ?.click();
    expect(overlay.getAttribute("style")).toBeNull();
  });

  it("starts as an accessible compact bottom sheet on narrow screens", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    localStorage.setItem(
      "ai-league-spectator-layout-v1",
      JSON.stringify({
        left: "900px",
        top: "600px",
        right: "auto",
        width: "700px",
        height: "600px",
        maxHeight: "none",
      }),
    );

    mountAiLeagueReplayOverlay({
      runID: "mobile-panel",
      artifactBasePath: "/ai-league-runs/mobile-panel",
      decisions: [],
      spectatorTelemetry: spectatorTelemetryFixture(),
    });

    const overlay = document.getElementById("ai-league-replay-overlay")!;
    const toggle = overlay.querySelector<HTMLButtonElement>(
      "[data-ai-league-toggle]",
    )!;
    const body = document.getElementById("ai-league-replay-panel-body");
    expect(overlay.classList.contains("mobile-bottom-sheet")).toBe(true);
    expect(overlay.classList.contains("collapsed")).toBe(true);
    expect(overlay.getAttribute("style")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(body?.id);

    toggle.click();
    expect(overlay.classList.contains("collapsed")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(overlay.classList.contains("collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 505, turnNumber: 505, players: [] },
      }),
    );
    const headline = document.getElementById("ai-league-headline-event");
    expect(headline?.hidden).toBe(false);
    expect(headline?.querySelector(".ai-league-headline-text")).not.toBeNull();
    const styles = overlay.querySelector("style")?.textContent ?? "";
    expect(styles).toContain("min-height: 44px");
    expect(styles).toContain(".ai-league-headline-text");
    expect(styles).toContain("white-space: nowrap");
  });

  it("no longer renders raw artifact download links in the panel", () => {
    // The "politics data · decisions · summary" row linked straight to raw
    // artifacts (decisions.jsonl is ~16 MB) and read as noise on a spectator
    // surface. Removed on operator request; match data stays reachable at the
    // same artifact paths, just not advertised from the panel.
    mountAiLeagueReplayOverlay({
      runID: "artifact-links",
      artifactBasePath: "/ai-league-runs/artifact-links",
      decisions: [],
      artifactAvailability: {
        visualReport: false,
        spectatorTelemetry: false,
        decisions: true,
        summary: true,
      },
    });

    const hrefs = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        "#ai-league-replay-overlay a",
      ),
      (link) => link.getAttribute("href"),
    );
    expect(hrefs).toEqual([]);
  });

  it("shows honest loading placeholders before optional match details arrive", () => {
    mountAiLeagueReplayOverlay({
      runID: "progressive-details",
      artifactBasePath: "/ai-league-runs/progressive-details",
      decisions: [],
      detailsLoading: true,
      artifactAvailability: {},
    });

    const overlay = document.getElementById("ai-league-replay-overlay")!;
    expect(
      Array.from(
        overlay.querySelectorAll(".ai-league-metric b"),
        (metric) => metric.textContent,
      ),
    ).toEqual(["—", "—", "—"]);
    expect(
      overlay.querySelector("[data-ai-league-details-loading]")?.textContent,
    ).toContain("ai_league_replay.loading_details");
    expect(overlay.querySelector(".ai-league-playstyle")).toBeNull();
    expect(
      overlay.querySelector(".ai-league-match-setup")?.textContent,
    ).not.toContain("Proxy War agents");
    expect(overlay.querySelector(".ai-league-playstyle")).toBeNull();
  });

  it("pins the panel grid column so a long run id cannot push controls out of reach", () => {
    // Regression: the panel is `display:grid` with only grid-template-rows set,
    // so the implicit column floored at min-content. Once the run id became
    // nowrap, that min-content width (the whole id string) widened the header
    // past the panel and overflow:hidden clipped "Hide panel"/"Reset" outside
    // the viewport entirely — the panel could not be collapsed at all.
    mountAiLeagueReplayOverlay({
      runID: "league-coworld-2026-07-25T13-50-41-478Z-3ff05139",
      artifactBasePath: "/ai-league-runs/x",
      decisions: [],
    });
    const style = document.querySelector("#ai-league-replay-overlay style")
      ?.textContent;
    expect(style).toContain("grid-template-columns: minmax(0, 1fr)");
    // The shrinkable title block and the fixed action cluster are what make
    // the pinned column actually resolve to a usable header.
    expect(style).toMatch(/\.ai-league-header-actions \{[^}]*flex: 0 0 auto/);
    expect(style).toMatch(/#ai-league-replay-overlay header \{[^}]*min-width: 0/);
  });

  it("sizes the Analyst chart count column to its content instead of clipping a 3+ digit tally mid-digit (P2 pass-1 p1-05/p1-06, 2026-08-02)", () => {
    mountAiLeagueReplayOverlay({
      runID: "analyst-chart-count-width",
      artifactBasePath: "/ai-league-runs/x",
      decisions: [],
    });
    const style = document.querySelector("#ai-league-replay-overlay style")
      ?.textContent;
    expect(style).toMatch(
      /\.broadcast-analyst-chart-row \{[^}]*grid-template-columns: 90px 1fr auto/,
    );
    expect(style).not.toMatch(
      /\.broadcast-analyst-chart-row \{[^}]*grid-template-columns: 90px 1fr 32px/,
    );
    expect(style).toMatch(
      /\.broadcast-analyst-chart-count \{[^}]*white-space: nowrap/,
    );
    expect(style).toMatch(
      /\.broadcast-analyst-chart-count \{[^}]*font-variant-numeric: tabular-nums/,
    );
  });

  it("omits the built-in-opponent clause and difficulty for agent-vs-agent matches", () => {
    // A league match has no built-in nations/bots. The setup line used to read
    // "12 Proxy War agents vs 0 built-in opponents", and showed a built-in
    // difficulty that has no meaning when no built-in opponent is playing.
    mountAiLeagueReplayOverlay({
      runID: "run-league-only",
      artifactBasePath: "/ai-league-runs/run-league-only",
      summary: {
        roster: [{ agentID: "a1" }, { agentID: "a2" }],
        runnerConfig: {
          bots: 0,
          nations: 0,
          maxSteps: 500,
          map: "World",
          difficulty: "Easy",
        },
      },
      decisions: [],
    });

    const setup = document.querySelector("[data-ai-league-subtitle]")
      ?.textContent;
    expect(setup).toContain("ai_league_replay.setup_agents_only");
    expect(setup).not.toContain("setup_agents_vs_builtin");
    expect(setup).not.toContain("Easy");
    // maxSteps counts decision steps, not game turns.
    expect(setup).toContain("ai_league_replay.setup_decisions");
    expect(setup).not.toContain("setup_turns");
  });

  it("ends optional-detail loading honestly when no evidence is available", () => {
    mountAiLeagueReplayOverlay({
      runID: "unavailable-details",
      artifactBasePath: "/ai-league-runs/unavailable-details",
      decisions: [],
      summary: null,
      spectatorTelemetry: null,
      detailsLoading: false,
      artifactAvailability: {},
    });

    const overlay = document.getElementById("ai-league-replay-overlay")!;
    expect(
      Array.from(
        overlay.querySelectorAll(".ai-league-metric b"),
        (metric) => metric.textContent,
      ),
    ).toEqual(["—", "—", "—"]);
    expect(
      overlay.querySelector("[data-ai-league-details-unavailable]")
        ?.textContent,
    ).toContain("ai_league_replay.details_unavailable");
    expect(
      overlay.querySelector("[data-ai-league-details-loading]"),
    ).toBeNull();
  });

  it("hydrates match details without resetting panel or live standings state", () => {
    const handle = mountAiLeagueReplayOverlay({
      runID: "hydrated-details",
      artifactBasePath: "/ai-league-runs/hydrated-details",
      decisions: [],
      detailsLoading: true,
      artifactAvailability: {},
    });
    const overlay = document.getElementById("ai-league-replay-overlay")!;
    const body = document.getElementById("ai-league-replay-panel-body")!;
    const toggle = overlay.querySelector<HTMLButtonElement>(
      "[data-ai-league-toggle]",
    )!;
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: {
          tick: 100,
          turnNumber: 100,
          players: [
            {
              playerID: "p1",
              smallID: 1,
              clientID: "c1",
              username: "Agent One",
              displayName: "Agent One",
              x: 100,
              y: 100,
              tilesOwned: 50,
              allies: [],
              embargoes: [],
              alliances: [],
            },
          ],
        },
      }),
    );
    toggle.click();
    overlay.style.left = "42px";
    body.scrollTop = 123;

    handle.hydrate({
      decisions: [decisionFixture(1)],
      detailsLoading: false,
      summary: {
        decisionCount: 12,
        rejectedCount: 1,
        fallbackCount: 2,
        actionCounts: { build: 12 },
      },
      artifactAvailability: { summary: true },
    });

    expect(document.getElementById("ai-league-replay-overlay")).toBe(overlay);
    expect(overlay.classList.contains("collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(overlay.style.left).toBe("42px");
    expect(body.scrollTop).toBe(123);
    expect(
      overlay.querySelector("[data-ai-league-diplomacy-rows]")?.textContent,
    ).toContain("Agent One");
    expect(
      Array.from(
        overlay.querySelectorAll(".ai-league-metric b"),
        (metric) => metric.textContent,
      ),
    ).toEqual(["12", "1", "2"]);
    expect(
      overlay.querySelector("[data-ai-league-details-loading]"),
    ).toBeNull();
    expect(overlay.querySelectorAll(".ai-league-decision")).toHaveLength(1);
  });

  it("disposes replay DOM, listeners, and replay-scoped body classes", () => {
    const handle = mountAiLeagueReplayOverlay({
      runID: "dispose-replay",
      artifactBasePath: "/ai-league-runs/dispose-replay",
      decisions: [],
      spectatorTelemetry: spectatorTelemetryFixture(),
    });
    expect(document.getElementById("ai-league-replay-overlay")).not.toBeNull();
    expect(
      document.getElementById("ai-league-social-transcript"),
    ).not.toBeNull();
    expect(document.getElementById("ai-league-headline-event")).not.toBeNull();
    expect(document.body.classList.contains("ai-league-replay-mode")).toBe(
      true,
    );

    handle.dispose();
    handle.dispose();

    expect(document.getElementById("ai-league-replay-overlay")).toBeNull();
    expect(document.getElementById("ai-league-social-transcript")).toBeNull();
    expect(document.getElementById("ai-league-headline-event")).toBeNull();
    expect(document.body.classList.contains("ai-league-replay-mode")).toBe(
      false,
    );
    expect(
      document.body.classList.contains("ai-league-native-spectator-ui"),
    ).toBe(false);

    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 505, turnNumber: 505, players: [] },
      }),
    );
    expect(document.getElementById("ai-league-headline-event")).toBeNull();
  });

  it("prefers complete summary metrics over a bounded recent decision list", () => {
    mountAiLeagueReplayOverlay({
      runID: "summary-metrics",
      artifactBasePath: "/ai-league-runs/summary-metrics",
      decisions: [decisionFixture(200)],
      summary: {
        decisionCount: 200,
        rejectedCount: 3,
        fallbackCount: 7,
        actionCounts: {
          hold: 150,
          nuke: 12,
          quick_chat: 10,
          build: 8,
        },
      },
    });

    const overlay = document.getElementById("ai-league-replay-overlay")!;
    expect(
      Array.from(
        overlay.querySelectorAll(".ai-league-metric b"),
        (metric) => metric.textContent,
      ),
    ).toEqual(["200", "3", "7"]);
    // The "Plays mostly" line was removed from the panel entirely; the metric
    // row above is what summary actionCounts still drive.
    expect(overlay.querySelector(".ai-league-playstyle")).toBeNull();
  });

  it("hydrates older decisions in bounded pages instead of building hidden cards", () => {
    mountAiLeagueReplayOverlay({
      runID: "incremental-decisions",
      artifactBasePath: "/ai-league-runs/incremental-decisions",
      decisions: Array.from({ length: 40 }, (_, index) =>
        decisionFixture(index + 1),
      ),
    });

    // The decision log is windowed to the playhead; advance past every fixture
    // turn so the paging behaviour under test is what's being exercised.
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 1_000_000, turnNumber: 1_000_000, players: [] },
      }),
    );

    const overlay = document.getElementById("ai-league-replay-overlay")!;
    const expander = overlay.querySelector<HTMLButtonElement>(
      "[data-ai-league-decision-expander]",
    )!;
    const pages = overlay.querySelector<HTMLElement>(
      "[data-ai-league-decision-pages]",
    )!;
    expect(overlay.querySelectorAll(".ai-league-decision")).toHaveLength(15);
    expect(pages.childElementCount).toBe(0);
    expect(expander.textContent).toContain(
      "ai_league_replay.decisions_show_older",
    );

    expander.click();
    expect(pages.querySelectorAll(".ai-league-decision")).toHaveLength(15);
    expect(overlay.querySelectorAll(".ai-league-decision")).toHaveLength(30);
    expect(expander.getAttribute("aria-expanded")).toBe("true");
    expect(expander.textContent).toContain(
      "ai_league_replay.decisions_show_older",
    );

    expander.click();
    expect(pages.querySelectorAll(".ai-league-decision")).toHaveLength(25);
    expect(overlay.querySelectorAll(".ai-league-decision")).toHaveLength(40);
    expect(expander.textContent).toContain(
      "ai_league_replay.decisions_show_recent",
    );

    expander.click();
    expect(pages.childElementCount).toBe(0);
    expect(overlay.querySelectorAll(".ai-league-decision")).toHaveLength(15);
    expect(expander.getAttribute("aria-expanded")).toBe("false");
  });

  it("enters read-only replay mode without mutating OpenFront-owned prompt DOM or adding a replay-mode banner", () => {
    document.body.innerHTML =
      '<div id="prompt">Choose a starting location</div>';

    mountAiLeagueReplayOverlay({
      runID: "run-render-2",
      artifactBasePath: "/ai-league-runs/run-render-2",
      decisions: [],
    });

    const prompt = document.getElementById("prompt");
    expect(prompt?.textContent).toBe("Choose a starting location");
    expect(document.body.classList.contains("ai-league-replay-mode")).toBe(
      true,
    );
    // The "Replay mode: watching Proxy War agents" banner was removed (it
    // overlapped the end-of-game winner banner); it must no longer be mounted.
    expect(document.getElementById("ai-league-replay-mode-banner")).toBeNull();
  });

  describe("social clip block", () => {
    function frame(turnNumber: number): void {
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: turnNumber, turnNumber, players: [] },
        }),
      );
    }

    it("offers the full one-second selector before playback reaches the moment", async () => {
      const runID = "league-clip-selector-1";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => clipCapabilitiesResponse(true)),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
          replayMaxTurn: 1_000,
        });
        const section = document.querySelector("[data-ai-league-clip]");
        expect(section).not.toBeNull();
        // Unknown capability fails closed while the read is in flight.
        expect(section?.hasAttribute("hidden")).toBe(true);
        await vi.waitFor(() => {
          expect(section?.hasAttribute("hidden")).toBe(false);
          expect(
            section?.querySelector("[data-ai-league-clip-render]"),
          ).not.toBeNull();
        });
        expect(
          section?.querySelector<HTMLInputElement>(
            "[data-ai-league-clip-moment]",
          )?.max,
        ).toBe("99");
        expect(
          section
            ?.querySelector("[data-ai-league-clip-selected-turn]")
            ?.getAttribute("data-ai-league-clip-selected-turn"),
        ).toBe("55");

        frame(120);
        expect(
          document
            .querySelector("[data-ai-league-clip-selected-turn]")
            ?.getAttribute("data-ai-league-clip-selected-turn"),
        ).toBe("125");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("keeps a manually selected bucket stable and previews it through pause plus an authoritative jump", async () => {
      const runID = "league-clip-manual-1";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => clipCapabilitiesResponse(true)),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
          replayMaxTurn: 1_000,
        });
        frame(615);
        await vi.waitFor(() => {
          expect(
            document.querySelector("[data-ai-league-clip-next-second]"),
          ).not.toBeNull();
        });

        document
          .querySelector<HTMLButtonElement>("[data-ai-league-clip-next-second]")
          ?.click();
        expect(
          document
            .querySelector("[data-ai-league-clip-selected-turn]")
            ?.getAttribute("data-ai-league-clip-selected-turn"),
        ).toBe("625");

        frame(900);
        expect(
          document
            .querySelector("[data-ai-league-clip-selected-turn]")
            ?.getAttribute("data-ai-league-clip-selected-turn"),
        ).toBe("625");

        const pauses: boolean[] = [];
        const jumps: number[] = [];
        const navigations: Array<{ turnNumber: number; url: string }> = [];
        const onJump = (event: Event) => {
          jumps.push(
            (event as CustomEvent<{ turnNumber: number }>).detail.turnNumber,
          );
        };
        document.addEventListener(
          "ai-league-replay-pause",
          (event) => {
            pauses.push(
              (event as CustomEvent<{ paused: boolean }>).detail.paused,
            );
          },
          { once: true },
        );
        document.addEventListener("ai-league-replay-jump-turn", onJump);
        document.addEventListener(
          "ai-league-replay-preview-navigation",
          (event) => {
            event.preventDefault();
            navigations.push(
              (event as CustomEvent<{ turnNumber: number; url: string }>)
                .detail,
            );
          },
          { once: true },
        );
        document
          .querySelector<HTMLButtonElement>("[data-ai-league-clip-preview]")
          ?.click();
        document.removeEventListener("ai-league-replay-jump-turn", onJump);
        expect(pauses).toEqual([true]);
        // Preview never trusts an in-process jump: queued fastest-playback
        // frames could otherwise overshoot even after pause was requested.
        expect(jumps).toEqual([]);
        expect(navigations[0]?.turnNumber).toBe(625);
        expect(navigations[0]?.url).toContain("turn=625");
        expect(navigations[0]?.url).toContain("renderFastForwardUntilTurn=625");
        expect(navigations[0]?.url).toContain("clipPreview=1");

        document
          .querySelector<HTMLButtonElement>("[data-ai-league-clip-use-current]")
          ?.click();
        expect(
          document
            .querySelector("[data-ai-league-clip-selected-turn]")
            ?.getAttribute("data-ai-league-clip-selected-turn"),
        ).toBe("905");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each([
      { relation: "same", adjust: false, expectedTurn: 615 },
      { relation: "forward", adjust: true, expectedTurn: 625 },
    ])(
      "restarts for a $relation-moment preview instead of risking queued-frame overshoot",
      async ({ adjust, expectedTurn }) => {
        const runID = `league-clip-preview-${expectedTurn}`;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => clipCapabilitiesResponse(true)),
        );
        try {
          mountAiLeagueReplayOverlay({
            runID,
            artifactBasePath: `/ai-league-runs/${runID}`,
            decisions: [],
            replayMaxTurn: 1_000,
          });
          frame(615);
          await vi.waitFor(() => {
            expect(
              document.querySelector("[data-ai-league-clip-preview]"),
            ).not.toBeNull();
          });
          if (adjust) {
            document
              .querySelector<HTMLButtonElement>(
                "[data-ai-league-clip-next-second]",
              )
              ?.click();
          }

          const jumps: number[] = [];
          const navigations: Array<{ turnNumber: number; url: string }> = [];
          const onJump = (event: Event) => {
            jumps.push(
              (event as CustomEvent<{ turnNumber: number }>).detail.turnNumber,
            );
          };
          document.addEventListener("ai-league-replay-jump-turn", onJump);
          document.addEventListener(
            "ai-league-replay-preview-navigation",
            (event) => {
              event.preventDefault();
              navigations.push(
                (event as CustomEvent<{ turnNumber: number; url: string }>)
                  .detail,
              );
            },
            { once: true },
          );
          document
            .querySelector<HTMLButtonElement>("[data-ai-league-clip-preview]")
            ?.click();
          document.removeEventListener("ai-league-replay-jump-turn", onJump);

          expect(jumps).toEqual([]);
          expect(navigations[0]?.turnNumber).toBe(expectedTurn);
          expect(navigations[0]?.url).toContain(`turn=${expectedTurn}`);
          expect(navigations[0]?.url).toContain(
            `renderFastForwardUntilTurn=${expectedTurn}`,
          );
          expect(navigations[0]?.url).toContain("clipPreview=1");
        } finally {
          vi.unstubAllGlobals();
        }
      },
    );

    it("caps a winner-bearing replay at the observed terminal instead of configured num_turns", async () => {
      const runID = "league-clip-early-winner-1";
      const replayMaxTurn = initialReplayClipRenderableThroughTurn({
        num_turns: 1_000,
        winner: ["player", "winner-id"],
      });
      expect(replayMaxTurn).toBeNull();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => clipCapabilitiesResponse(true)),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
          replayMaxTurn,
        });
        await vi.waitFor(() => {
          expect(
            document.querySelector("[data-ai-league-clip]")?.textContent,
          ).toContain("ai_league_replay.clip_range_pending");
        });

        // With no authoritative terminal yet, expose only fully observed
        // canonical centers, never the configured 1,000-turn upper bound.
        document.dispatchEvent(
          new CustomEvent("ai-league-replay-frame", {
            detail: {
              tick: 612,
              terminal: false,
              turnNumber: 900,
              players: [],
            },
          }),
        );
        expect(
          document.querySelector<HTMLInputElement>(
            "[data-ai-league-clip-moment]",
          )?.max,
        ).toBe("60");

        document.dispatchEvent(
          new CustomEvent("ai-league-replay-frame", {
            detail: {
              tick: 612,
              terminal: true,
              turnNumber: 900,
              players: [],
            },
          }),
        );
        expect(
          document.querySelector<HTMLInputElement>(
            "[data-ai-league-clip-moment]",
          )?.max,
        ).toBe("60");
        expect(
          document
            .querySelector("[data-ai-league-clip-selected-turn]")
            ?.getAttribute("data-ai-league-clip-selected-turn"),
        ).toBe("605");

        document.dispatchEvent(
          new CustomEvent("ai-league-replay-frame", {
            detail: {
              tick: 900,
              terminal: false,
              turnNumber: 1_000,
              players: [],
            },
          }),
        );
        expect(
          document.querySelector<HTMLInputElement>(
            "[data-ai-league-clip-moment]",
          )?.max,
        ).toBe("60");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each([
      { terminalTick: 54, expectedMax: null },
      { terminalTick: 55, expectedMax: "5" },
    ])(
      "handles the canonical minimum boundary at terminal tick $terminalTick",
      async ({ terminalTick, expectedMax }) => {
        const runID = `league-clip-terminal-boundary-${terminalTick}`;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => clipCapabilitiesResponse(true)),
        );
        try {
          mountAiLeagueReplayOverlay({
            runID,
            artifactBasePath: `/ai-league-runs/${runID}`,
            decisions: [],
            replayMaxTurn: null,
          });
          await vi.waitFor(() => {
            expect(
              document.querySelector("[data-ai-league-clip]")?.textContent,
            ).toContain("ai_league_replay.clip_range_pending");
          });
          document.dispatchEvent(
            new CustomEvent("ai-league-replay-frame", {
              detail: {
                tick: terminalTick,
                terminal: true,
                turnNumber: 900,
                players: [],
              },
            }),
          );

          const slider = document.querySelector<HTMLInputElement>(
            "[data-ai-league-clip-moment]",
          );
          if (expectedMax === null) {
            expect(slider).toBeNull();
            expect(
              document.querySelector("[data-ai-league-clip]")?.textContent,
            ).toContain("ai_league_replay.clip_too_short");
          } else {
            expect(slider?.min).toBe("5");
            expect(slider?.max).toBe(expectedMax);
            expect(
              document
                .querySelector("[data-ai-league-clip-selected-turn]")
                ?.getAttribute("data-ai-league-clip-selected-turn"),
            ).toBe("55");
          }
        } finally {
          vi.unstubAllGlobals();
        }
      },
    );

    it("exposes a capped no-winner record's declared range immediately", async () => {
      const runID = "league-clip-no-winner-range-1";
      const replayMaxTurn = initialReplayClipRenderableThroughTurn({
        num_turns: 1_000,
      });
      expect(replayMaxTurn).toBe(1_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => clipCapabilitiesResponse(true)),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
          replayMaxTurn,
        });
        await vi.waitFor(() => {
          expect(
            document.querySelector<HTMLInputElement>(
              "[data-ai-league-clip-moment]",
            )?.max,
          ).toBe("99");
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each([
      {
        name: "the server reports generation disabled",
        runID: "league-clip-disabled-1",
        response: (_url?: string) =>
          Promise.resolve(clipCapabilitiesResponse(false)),
      },
      {
        name: "the capability request fails",
        runID: "league-clip-capability-failure-1",
        response: (_url?: string) => Promise.reject(new TypeError("offline")),
      },
    ])(
      "hides the complete generation block when $name",
      async ({ runID, response }) => {
        const fetchMock = vi.fn(response);
        vi.stubGlobal("fetch", fetchMock);
        try {
          mountAiLeagueReplayOverlay({
            runID,
            artifactBasePath: `/ai-league-runs/${runID}`,
            decisions: [],
            replayMaxTurn: 1_000,
          });
          frame(500);
          await vi.waitFor(() => {
            const section = document.querySelector<HTMLElement>(
              "[data-ai-league-clip]",
            );
            expect(section?.hidden).toBe(true);
            expect(section?.childElementCount).toBe(0);
          });
          expect(
            document.querySelector("[data-ai-league-clip-render]"),
          ).toBeNull();
          // Stage 4 identity resolution (fetchReadModel) also fires once per
          // mount, hitting this same URL-agnostic mock — assert only the
          // clip-capabilities call count, not the mock's total call count.
          const clipCapabilityCalls = fetchMock.mock.calls.filter(
            ([url]) => url === "/api/clip-capabilities",
          );
          expect(clipCapabilityCalls).toHaveLength(1);
        } finally {
          vi.unstubAllGlobals();
        }
      },
    );

    it("fails closed when record metadata has no complete canonical Clip bucket", async () => {
      const runID = "league-clip-too-short-1";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => clipCapabilitiesResponse(true)),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
          replayMaxTurn: 54,
        });
        await vi.waitFor(() => {
          expect(
            document.querySelector("[data-ai-league-clip]")?.textContent,
          ).toContain("ai_league_replay.clip_too_short");
        });
        expect(
          document.querySelector("[data-ai-league-clip-render]"),
        ).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("posts the frozen selected moment, not the furthest frame, and renders the Download MP4 link", async () => {
      const runID = "league-clip-ready-1";
      const clipUrl = `/ai-league-runs/${runID}/clip-v1-60.mp4`;
      const requests: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url) === "/api/clip-capabilities") {
            return clipCapabilitiesResponse(true);
          }
          // Stage 4 identity resolution (fetchReadModel) also fires once per
          // mount — stub it out rather than letting it fall through into the
          // clip-request tracking below (it is not a clip request).
          if (String(url) === "/ai-league-runs/league/read-model.json") {
            return new Response(null, { status: 404 });
          }
          requests.push({
            url: String(url),
            body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
          });
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              premiereId: runID,
              bucket: 60,
              clipVersion: 1,
              state: "ready",
              ready: {
                clipUrl,
                byteLength: 96,
                sha256: "c".repeat(64),
                anchorTurn: 605,
                social: { caption: "caption text", firstReply: "watch url" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
          replayMaxTurn: 1_000,
        });
        frame(615);
        await vi.waitFor(() => {
          expect(
            document.querySelector("[data-ai-league-clip-render]"),
          ).not.toBeNull();
        });
        document
          .querySelector<HTMLButtonElement>(
            "[data-ai-league-clip-previous-second]",
          )
          ?.click();
        frame(900);
        const render = document.querySelector<HTMLButtonElement>(
          "[data-ai-league-clip-render]",
        );
        expect(render).not.toBeNull();
        render?.click();
        await vi.waitFor(() => {
          expect(
            document.querySelector("[data-ai-league-clip-download]"),
          ).not.toBeNull();
        });
        expect(requests[0].url).toBe(`/api/league-runs/${runID}/clips`);
        expect(requests[0].body).toEqual({ turn: 605 });
        const download = document.querySelector<HTMLAnchorElement>(
          "[data-ai-league-clip-download]",
        );
        expect(download?.getAttribute("href")).toBe(clipUrl);
        expect(download?.hasAttribute("download")).toBe(true);
        const section = document.querySelector("[data-ai-league-clip]");
        expect(section?.textContent).toContain(
          "ai_league_replay.clip_download_file",
        );
        expect(section?.textContent).toContain(
          "ai_league_replay.clip_copy_caption",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("keeps polling truthful pending work beyond the old 390-second client cutoff", async () => {
      const runID = "league-clip-pending-long-1";
      const pendingResponse = (phase: "queued" | "rendering") =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            premiereId: runID,
            bucket: 61,
            clipVersion: 1,
            state: "pending",
            ready: null,
            pending: {
              phase,
              jobsAhead: phase === "queued" ? 2 : 0,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      let statusReads = 0;
      const statusUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (String(url) === "/api/clip-capabilities") {
            return clipCapabilitiesResponse(true);
          }
          if (String(url).endsWith("/clips/61?progress=1")) {
            statusReads += 1;
            statusUrls.push(String(url));
            return pendingResponse("rendering");
          }
          return pendingResponse("queued");
        }),
      );
      const handle = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        replayMaxTurn: 1_000,
      });
      frame(615);
      await vi.waitFor(() => {
        expect(
          document.querySelector("[data-ai-league-clip-render]"),
        ).not.toBeNull();
      });

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        document
          .querySelector<HTMLButtonElement>("[data-ai-league-clip-render]")
          ?.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(
          document.querySelector("[data-ai-league-clip]")?.textContent,
        ).toContain("ai_league_replay.clip_queued_ahead");

        await vi.advanceTimersByTimeAsync(3_000 * 131);
        expect(statusReads).toBeGreaterThanOrEqual(131);
        expect(statusUrls[0]).toBe(
          `/api/league-runs/${runID}/clips/61?progress=1`,
        );
        expect(
          document.querySelector("[data-ai-league-clip]")?.textContent,
        ).toContain("ai_league_replay.clip_rendering");
        expect(
          document.querySelector("[data-ai-league-clip]")?.textContent,
        ).not.toContain("ai_league_replay.clip_failed");
      } finally {
        handle.dispose();
        vi.useRealTimers();
        consoleError.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it("surfaces a failed render as a retryable failure state", async () => {
      const runID = "league-clip-fail-1";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          String(url) === "/api/clip-capabilities"
            ? clipCapabilitiesResponse(true)
            : new Response(
                JSON.stringify({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } }),
                { status: 404 },
              ),
        ),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
          replayMaxTurn: 1_000,
        });
        frame(200);
        await vi.waitFor(() => {
          expect(
            document.querySelector("[data-ai-league-clip-render]"),
          ).not.toBeNull();
        });
        document
          .querySelector<HTMLButtonElement>("[data-ai-league-clip-render]")
          ?.click();
        await vi.waitFor(() => {
          expect(
            document.querySelector("[data-ai-league-clip]")?.textContent,
          ).toContain("ai_league_replay.clip_failed");
        });
        // The failure state keeps the render button for a retry.
        expect(
          document.querySelector("[data-ai-league-clip-render]"),
        ).not.toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("Stage 4 broadcast composition", () => {
    function frame(
      turnNumber: number,
      players: Array<{
        playerID: string;
        smallID: number;
        username: string;
        tilesOwned: number;
        allies?: number[];
        targets?: number[];
      }>,
    ): void {
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: {
            tick: turnNumber,
            turnNumber,
            players: players.map((player) => ({
              playerID: player.playerID,
              smallID: player.smallID,
              clientID: null,
              username: player.username,
              displayName: player.username,
              x: 0,
              y: 0,
              tilesOwned: player.tilesOwned,
              allies: player.allies ?? [],
              embargoes: [],
              alliances: [],
              targets: player.targets ?? [],
            })),
          },
        }),
      );
    }

    it("derives and renders the competitor rail from live frame state, decisions, and resolved identity", async () => {
      const runID = "broadcast-rail-1";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (String(url) === "/ai-league-runs/league/read-model.json") {
            return readModelResponse([
              publicAgentFixture({
                playerName: "Atlas",
                displayName: "Atlas Prime",
                slug: "atlas-prime",
                emblemSvg: "<svg data-testid=\"atlas-emblem\"></svg>",
                versionLabel: "v2.3",
                builderDisplayName: "Builder Bob",
              }),
            ]);
          }
          return new Response(null, { status: 404 });
        }),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [
            {
              ...decisionFixture(1),
              username: "Atlas",
              turnNumber: 10,
              planObjective: "expand",
              fallbackUsed: false,
            },
            {
              ...decisionFixture(2),
              username: "Atlas",
              turnNumber: 20,
              planObjective: "consolidate",
              fallbackUsed: true,
              auditStatus: "failed",
            },
          ],
          spectatorTelemetry: {
            version: 1,
            runID,
            agents: [
              {
                agentID: "a1",
                playerID: "p1",
                username: "Atlas",
                profile: "diplomatic",
                colorIndex: 0,
                finalTilesOwned: 60,
                finalTroops: 1000,
                isAlive: true,
              },
              {
                agentID: "a2",
                playerID: "p2",
                username: "Blitz",
                profile: "aggressive",
                colorIndex: 1,
                finalTilesOwned: 40,
                finalTroops: 900,
                isAlive: true,
              },
              {
                agentID: "a3",
                playerID: "p3",
                username: "Ghost",
                profile: "defensive",
                colorIndex: 2,
                finalTilesOwned: 0,
                finalTroops: 0,
                isAlive: false,
              },
            ],
            relationships: [],
            events: [],
            communicationThreads: [],
            timelineBuckets: [],
          },
        });

        frame(600, [
          { playerID: "p1", smallID: 1, username: "Atlas", tilesOwned: 60, targets: [2] },
          { playerID: "p2", smallID: 2, username: "Blitz", tilesOwned: 40 },
        ]);

        const rail = document.querySelector("[data-ai-league-broadcast-drawer]");
        expect(rail?.querySelectorAll(".broadcast-rail-entry")).toHaveLength(3);

        // Ghost never appears in a frame (eliminated before this replay's
        // current window) — alive comes from the telemetry roster's own
        // isAlive, territory/rank stay null (never fabricated for a player
        // absent from the live frame).
        const ghostEntry = document.querySelector(
          '.broadcast-rail-entry[data-alive="false"]',
        );
        expect(ghostEntry?.textContent).toContain("Ghost");
        expect(
          ghostEntry?.querySelector(".broadcast-rail-eliminated"),
        ).not.toBeNull();
        expect(
          ghostEntry?.querySelector(".broadcast-rail-territory"),
        ).toBeNull();
        expect(ghostEntry?.querySelector(".broadcast-rail-rank")).toBeNull();

        // Blitz: present in the frame, no registered identity — degrades to
        // the raw frame name, still gets live territory/rank/war relations.
        const blitzEntry = [
          ...document.querySelectorAll(".broadcast-rail-entry"),
        ].find((entry) => entry.textContent?.includes("Blitz"));
        expect(blitzEntry?.getAttribute("data-alive")).toBe("true");
        expect(
          blitzEntry?.querySelector(".broadcast-rail-territory"),
        ).not.toBeNull();
        // translateText echoes the raw key (no interpolation) without a
        // lang-selector in the DOM, so assert the wars branch fired rather
        // than the (untranslatable-here) interpolated agent name.
        expect(
          blitzEntry?.querySelector(".broadcast-rail-wars"),
        ).not.toBeNull();

        // Atlas: present in the frame AND identity-resolved once the
        // fetchReadModel() promise settles.
        await vi.waitFor(() => {
          expect(
            document.querySelector(".broadcast-rail-name")?.textContent,
          ).toContain("Atlas Prime");
        });
        const atlasEntry = [
          ...document.querySelectorAll(".broadcast-rail-entry"),
        ].find((entry) => entry.textContent?.includes("Atlas Prime"));
        expect(atlasEntry?.querySelector(".broadcast-rail-version")?.textContent).toBe(
          "v2.3",
        );
        expect(
          atlasEntry?.querySelector(".broadcast-rail-emblem")?.innerHTML,
        ).toContain("atlas-emblem");
        expect(
          atlasEntry?.querySelector(".broadcast-rail-builder"),
        ).not.toBeNull();
        expect(
          atlasEntry?.querySelector(".broadcast-rail-territory"),
        ).not.toBeNull();
        expect(
          atlasEntry?.querySelector(".broadcast-rail-degraded"),
        ).not.toBeNull();
        expect(
          atlasEntry?.querySelector(".broadcast-rail-wars"),
        ).not.toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("preserves scroll position in the diplomacy strip and competitor rail when their content changes mid-tick (P1 scroll-teleport fix: content-keyed patch, never a full container rebuild)", () => {
      const runID = "scroll-preserve-1";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 404 })),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
        });

        // Rook absorbs the tile delta below so Atlas's own rank/share stay
        // pixel-identical across the tick — isolates "an untouched entry's
        // own DOM node survives a sibling's content change" (the property
        // under test) from "did the derived numbers recompute correctly",
        // which the rail/diplomacy tests above already cover.
        frame(500, [
          { playerID: "p1", smallID: 1, username: "Atlas", tilesOwned: 60 },
          { playerID: "p2", smallID: 2, username: "Blitz", tilesOwned: 40 },
          { playerID: "p3", smallID: 3, username: "Rook", tilesOwned: 100 },
        ]);

        const diploContainer = document.querySelector<HTMLElement>(
          "[data-ai-league-diplomacy-rows]",
        );
        expect(diploContainer).not.toBeNull();
        const atlasDiploBefore = [
          ...diploContainer!.querySelectorAll(".ai-league-diplo-entry"),
        ].find((el) => el.textContent?.includes("Atlas"));
        expect(atlasDiploBefore).toBeDefined();
        expect(atlasDiploBefore?.textContent).toContain("30%");
        const blitzDiploBefore = [
          ...diploContainer!.querySelectorAll(".ai-league-diplo-entry"),
        ].find((el) => el.textContent?.includes("Blitz"));

        const railList = document.querySelector<HTMLElement>(
          ".broadcast-rail-list",
        );
        expect(railList).not.toBeNull();
        const atlasRailBefore = [
          ...railList!.querySelectorAll(".broadcast-rail-entry"),
        ].find((el) => el.textContent?.includes("Atlas"));
        expect(atlasRailBefore).toBeDefined();

        // jsdom has no real layout, so scrollTop is faked exactly like this
        // file's own War Room ticker scroll-preservation test above does.
        let diploScrollTop = 42;
        Object.defineProperty(diploContainer, "scrollTop", {
          configurable: true,
          get: () => diploScrollTop,
          set: (value: number) => {
            diploScrollTop = value;
          },
        });
        let railScrollTop = 77;
        Object.defineProperty(railList, "scrollTop", {
          configurable: true,
          get: () => railScrollTop,
          set: (value: number) => {
            railScrollTop = value;
          },
        });

        // Blitz gains 15 tiles from Rook: a pure content-changing tick for
        // both panels (total tiles, and therefore Atlas's own share/rank,
        // are unaffected). This is the exact shape that used to call
        // `container.innerHTML = rowsHtml` / `rail.replaceWith(nextRail)`
        // on the whole scrolled container, resetting `scrollTop` to 0 —
        // "some parts of the panel ... teleport me back when I try to
        // scroll in director cut".
        frame(501, [
          { playerID: "p1", smallID: 1, username: "Atlas", tilesOwned: 60 },
          { playerID: "p2", smallID: 2, username: "Blitz", tilesOwned: 55 },
          { playerID: "p3", smallID: 3, username: "Rook", tilesOwned: 85 },
        ]);

        // Scroll position held for both panels.
        expect(diploScrollTop).toBe(42);
        expect(railScrollTop).toBe(77);

        // The patch actually landed: Blitz's own diplomacy row changed
        // (its rail counterpart's untranslated-in-this-test-env label text
        // is identical either way, so it isn't a useful "did it change"
        // signal here — the scrollTop/same-node assertions below already
        // cover the rail).
        expect(
          [...diploContainer!.querySelectorAll(".ai-league-diplo-entry")].find(
            (el) => el.textContent?.includes("Blitz"),
          )?.textContent,
        ).toContain("28%");
        expect(
          [...diploContainer!.querySelectorAll(".ai-league-diplo-entry")].find(
            (el) => el.textContent?.includes("Blitz"),
          ),
        ).not.toBe(blitzDiploBefore);

        // ...while Atlas's own row — untouched by the patch — is the SAME
        // DOM node: proof this is a content-keyed patch, never a full
        // teardown/rebuild of the container.
        expect(
          [...diploContainer!.querySelectorAll(".ai-league-diplo-entry")].find(
            (el) => el.textContent?.includes("Atlas"),
          ),
        ).toBe(atlasDiploBefore);
        expect(
          [...railList!.querySelectorAll(".broadcast-rail-entry")].find((el) =>
            el.textContent?.includes("Atlas"),
          ),
        ).toBe(atlasRailBefore);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("curates a selective War Room feed and jumps to turn from an expanded event", () => {
      const runID = "broadcast-war-room-1";
      const jumps: number[] = [];
      document.addEventListener("ai-league-replay-jump-turn", (domEvent) => {
        jumps.push(
          (domEvent as CustomEvent<{ turnNumber: number }>).detail.turnNumber,
        );
      });
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        // High enough to include every curated event below (spec item 2:
        // the feed windows to the viewer's own playhead) — this test's own
        // point is curation SELECTIVITY, not windowing; windowing itself is
        // covered by its own dedicated test below.
        currentTurn: 999,
        decisions: [
          {
            ...decisionFixture(1),
            username: "Atlas",
            turnNumber: 10,
            planObjective: "expand",
          },
          {
            ...decisionFixture(2),
            username: "Atlas",
            turnNumber: 20,
            planObjective: "consolidate",
            reason: "Defend the core.",
            planRationale: "Blitz is massing troops nearby.",
          },
        ],
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events: [
            event(1, 50, "alliance_formed", "pact", "a1", "Atlas", "a3", "Civic", "Atlas and Civic form an alliance."),
            event(2, 100, "attack", "war", "a2", "Blitz", "a1", "Atlas", "Blitz attacks Atlas."),
            // Same ordered pair attacking again must NOT curate a second
            // first_strike — only the first attack between a pair counts.
            event(3, 150, "attack", "war", "a2", "Blitz", "a1", "Atlas", "Blitz attacks Atlas again."),
            event(4, 200, "alliance_break", "betrayal", "a3", "Civic", "a1", "Atlas", "Civic breaks the pact."),
            event(5, 999, "elimination", "war", "a2", "Blitz", null, null, "Blitz is eliminated."),
          ],
          communicationThreads: [],
          timelineBuckets: [],
        },
      });

      const warRoom = document.querySelector(".broadcast-war-room");
      expect(warRoom).not.toBeNull();
      const items = warRoom?.querySelectorAll(".broadcast-war-room-item") ?? [];
      expect(items).toHaveLength(5);
      expect(
        warRoom?.querySelectorAll('[data-kind="first_strike"]'),
      ).toHaveLength(1);
      expect(warRoom?.querySelector('[data-kind="alliance"]')).not.toBeNull();
      expect(warRoom?.querySelector('[data-kind="betrayal"]')).not.toBeNull();
      expect(
        warRoom?.querySelector('[data-kind="elimination"]'),
      ).not.toBeNull();
      const planChangeItem = warRoom?.querySelector('[data-kind="plan_change"]');
      expect(planChangeItem).not.toBeNull();

      // Expand the plan-change row and confirm the raw planRationale text
      // (not a translateText key) renders as the expanded detail, then jump
      // to its turn from the detail's jump button.
      planChangeItem
        ?.querySelector<HTMLButtonElement>(".broadcast-war-room-summary")
        ?.click();
      expect(
        planChangeItem?.querySelector(".broadcast-war-room-extra")
          ?.textContent,
      ).toBe("Blitz is massing troops nearby.");
      expect(
        planChangeItem?.querySelector(".broadcast-war-room-detail")
          ?.textContent,
      ).toContain("broadcast.war_room_stated_reason");
      planChangeItem
        ?.querySelector<HTMLButtonElement>(".broadcast-war-room-jump")
        ?.click();
      expect(jumps).toEqual([20]);
    });

    it("renders an unrestricted bottom timeline for Full Replay and dispatches jump-to-turn on seek", () => {
      const runID = "broadcast-timeline-1";
      const jumps: number[] = [];
      document.addEventListener("ai-league-replay-jump-turn", (domEvent) => {
        jumps.push(
          (domEvent as CustomEvent<{ turnNumber: number }>).detail.turnNumber,
        );
      });
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        replayMaxTurn: 1_000,
        // See the War Room curation test's own comment above — high enough
        // that windowing (spec item 2) never strips a fixture event this
        // test asserts on.
        currentTurn: 999,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events: [
            event(1, 5, "spawn", "info", "a1", "Atlas", null, null, "Atlas enters the match."),
            event(2, 50, "alliance_formed", "pact", "a1", "Atlas", "a3", "Civic", "Atlas and Civic form an alliance."),
            event(3, 100, "attack", "war", "a2", "Blitz", "a1", "Atlas", "Blitz attacks Atlas."),
            event(4, 200, "alliance_break", "betrayal", "a3", "Civic", "a1", "Atlas", "Civic breaks the pact."),
            event(5, 300, "nuke", "threat", "a2", "Blitz", "a3", "Civic", "Blitz escalates nuclear pressure against Civic."),
            event(6, 999, "elimination", "war", "a2", "Blitz", null, null, "Blitz is eliminated."),
          ],
          communicationThreads: [],
          timelineBuckets: [],
        },
      });

      const timeline = document.querySelector(".broadcast-timeline");
      expect(timeline).not.toBeNull();
      const markers = timeline?.querySelectorAll(".broadcast-timeline-marker") ?? [];
      // spawn, alliance, first_strike, betrayal, nuke, elimination, finish.
      expect(markers).toHaveLength(7);
      for (const kind of [
        "spawn",
        "alliance",
        "first_strike",
        "betrayal",
        "nuke",
        "elimination",
        "finish",
      ]) {
        expect(
          timeline?.querySelector(`[data-kind="${kind}"]`),
          `expected a ${kind} marker`,
        ).not.toBeNull();
      }
      // lead_change is never fabricated: this overlay only ever sees a live,
      // forward-only frame stream, never a stored territory time series.
      expect(timeline?.querySelector('[data-kind="lead_change"]')).toBeNull();
      // Full Replay is unrestricted — every marker stays clickable.
      expect(
        [...markers].every((marker) => marker.getAttribute("data-seekable") === "true"),
      ).toBe(true);

      const finishMarker = timeline?.querySelector<HTMLButtonElement>(
        '[data-kind="finish"]',
      );
      finishMarker?.click();
      expect(jumps).toEqual([1_000]);
    });

    it("removes the broadcast drawer and lower-third host on dispose", () => {
      const runID = "broadcast-dispose-1";
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
      });
      expect(document.querySelector(".broadcast-war-room")).not.toBeNull();
      expect(document.querySelector(".broadcast-timeline")).not.toBeNull();
      expect(document.getElementById("ai-league-lower-third-host")).not.toBeNull();
      overlay.dispose();
      expect(document.querySelector("[data-ai-league-broadcast-drawer]")).toBeNull();
      expect(document.querySelector(".broadcast-war-room")).toBeNull();
      expect(document.querySelector(".broadcast-timeline")).toBeNull();
    });

    it("dispatches BROADCAST_RAIL_FOLLOW_EVENT with the clicked seat's player name", () => {
      const runID = "broadcast-follow-1";
      const follows: Array<string | null> = [];
      document.addEventListener(BROADCAST_RAIL_FOLLOW_EVENT, (domEvent) => {
        follows.push(
          (domEvent as CustomEvent<{ playerName: string }>).detail.playerName,
        );
      });
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [
            {
              agentID: "a1",
              playerID: "p1",
              username: "Atlas",
              profile: "diplomatic",
              colorIndex: 0,
              finalTilesOwned: 60,
              finalTroops: 1000,
              isAlive: true,
            },
          ],
          relationships: [],
          events: [],
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      frame(600, [
        { playerID: "p1", smallID: 1, username: "Atlas", tilesOwned: 60 },
      ]);
      const seat = document.querySelector<HTMLButtonElement>(
        ".broadcast-rail-select",
      );
      expect(seat).not.toBeNull();
      seat?.click();
      expect(follows).toEqual(["Atlas"]);
    });

    it("reflects BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT as the rail's followed-seat highlight", () => {
      const runID = "broadcast-followed-state-1";
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [
            {
              agentID: "a1",
              playerID: "p1",
              username: "Atlas",
              profile: "diplomatic",
              colorIndex: 0,
              finalTilesOwned: 60,
              finalTroops: 1000,
              isAlive: true,
            },
            {
              agentID: "a2",
              playerID: "p2",
              username: "Blitz",
              profile: "aggressive",
              colorIndex: 1,
              finalTilesOwned: 40,
              finalTroops: 900,
              isAlive: true,
            },
          ],
          relationships: [],
          events: [],
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      frame(600, [
        { playerID: "p1", smallID: 1, username: "Atlas", tilesOwned: 60 },
        { playerID: "p2", smallID: 2, username: "Blitz", tilesOwned: 40 },
      ]);
      const entriesBefore = document.querySelectorAll(".broadcast-rail-entry");
      expect(
        [...entriesBefore].every(
          (entry) => entry.getAttribute("data-followed") === "false",
        ),
      ).toBe(true);

      document.dispatchEvent(
        new CustomEvent(BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT, {
          detail: { playerName: "Blitz" },
        }),
      );

      const atlasEntry = [
        ...document.querySelectorAll(".broadcast-rail-entry"),
      ].find((entry) => entry.textContent?.includes("Atlas"));
      const blitzEntry = [
        ...document.querySelectorAll(".broadcast-rail-entry"),
      ].find((entry) => entry.textContent?.includes("Blitz"));
      expect(atlasEntry?.getAttribute("data-followed")).toBe("false");
      expect(blitzEntry?.getAttribute("data-followed")).toBe("true");
      expect(
        blitzEntry
          ?.querySelector(".broadcast-rail-select")
          ?.getAttribute("aria-pressed"),
      ).toBe("true");
    });

    it("switches the active drawer tab and marks only that panel data-tab-active", () => {
      const runID = "broadcast-drawer-tabs-1";
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
      });
      const drawer = document.querySelector("[data-ai-league-broadcast-drawer]");
      expect(
        drawer?.querySelector('.broadcast-drawer-panel[data-tab-id="agents"]')
          ?.getAttribute("data-tab-active"),
      ).toBe("true");
      // "events" relocates to the document.body-level portal at a desktop
      // viewport (see mountAiLeagueBroadcastDrawer's own doc) — query
      // globally rather than scoped under the drawer placeholder.
      expect(
        document
          .querySelector('.broadcast-drawer-panel[data-tab-id="events"]')
          ?.getAttribute("data-tab-active"),
      ).toBe("false");

      drawer
        ?.querySelector<HTMLButtonElement>('.broadcast-drawer-tab[data-tab-id="events"]')
        ?.click();

      expect(
        drawer?.querySelector('.broadcast-drawer-panel[data-tab-id="agents"]')
          ?.getAttribute("data-tab-active"),
      ).toBe("false");
      expect(
        document
          .querySelector('.broadcast-drawer-panel[data-tab-id="events"]')
          ?.getAttribute("data-tab-active"),
      ).toBe("true");
      expect(
        drawer
          ?.querySelector('.broadcast-drawer-tab[data-tab-id="events"]')
          ?.getAttribute("aria-selected"),
      ).toBe("true");
    });

    it("toggles analyst mode via the desktop header button, showing the same analysis panel content the drawer's Analysis tab renders", () => {
      const runID = "broadcast-analyst-toggle-1";
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [decisionFixture(1)],
      });
      const toggle = document.querySelector<HTMLButtonElement>(
        "[data-ai-league-analyst-toggle]",
      );
      expect(toggle).not.toBeNull();
      expect(document.body.classList.contains("ai-league-analyst-mode")).toBe(false);
      expect(toggle?.getAttribute("aria-pressed")).toBe("false");
      expect(
        document.querySelector('.broadcast-drawer-panel[data-tab-id="analysis"].broadcast-analyst'),
      ).not.toBeNull();

      toggle?.click();
      expect(document.body.classList.contains("ai-league-analyst-mode")).toBe(true);
      expect(toggle?.getAttribute("aria-pressed")).toBe("true");

      toggle?.click();
      expect(document.body.classList.contains("ai-league-analyst-mode")).toBe(false);
      expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    });

    it("fires a lower-third pulse over the map when a new curated event arrives via hydrate", () => {
      const runID = "broadcast-lower-third-1";
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events: [],
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      const host = document.getElementById("ai-league-lower-third-host");
      expect(host).not.toBeNull();
      expect(host?.querySelector(".broadcast-lower-third")).toBeNull();

      overlay.hydrate({
        // The playhead must have reached the event's own turn (spec item 2:
        // windowed to the viewer's own playhead) — hydrate() alone, without
        // this, must never pulse a turn the viewer hasn't reached yet.
        currentTurn: 999,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events: [
            event(1, 999, "elimination", "war", "a2", "Blitz", null, null, "Blitz is eliminated."),
          ],
          communicationThreads: [],
          timelineBuckets: [],
        },
      });

      const pulse = host?.querySelector(".broadcast-lower-third");
      expect(pulse).not.toBeNull();
      expect(pulse?.getAttribute("data-kind")).toBe("elimination");
      expect(pulse?.getAttribute("role")).toBe("status");
    });


    it("windows the War Room feed to the viewer's own playhead — a future event never renders until playback reaches its turn (spec item 2)", () => {
      const runID = "broadcast-windowing-1";
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        // Deliberately omitted: currentTurn — a fresh/archived-rewatch load
        // starts at turn 0, exactly "playhead at 0" from the bug report.
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events: [
            event(1, 10, "elimination", "war", "a1", "Atlas", null, null, "Atlas is eliminated."),
            event(2, 500, "elimination", "war", "a2", "Blitz", null, null, "Blitz is eliminated."),
          ],
          communicationThreads: [],
          timelineBuckets: [],
        },
      });

      const warRoom = document.querySelector(".broadcast-war-room");
      // At turn 0, NEITHER curated event (turn 10, turn 500) has happened yet.
      expect(warRoom?.querySelectorAll(".broadcast-war-room-item")).toHaveLength(0);
      expect(warRoom?.textContent).toContain("broadcast.war_room_empty");

      // Advancing to turn 10 must reveal exactly the turn-10 event — never
      // the turn-500 one, which the viewer has not reached yet.
      frame(10, []);
      expect(document.querySelectorAll(".broadcast-war-room-item")).toHaveLength(1);

      // Only once the playhead reaches turn 500 does the second event appear.
      frame(499, []);
      expect(document.querySelectorAll(".broadcast-war-room-item")).toHaveLength(1);
      frame(500, []);
      expect(document.querySelectorAll(".broadcast-war-room-item")).toHaveLength(2);
    });

    // Raised timeout (matches package.json's own test:coverage/test:e2e
    // precedent of a longer testTimeout for heavier suites): fast in
    // isolation (well under 1s for the whole 2,000-event fixture), but a
    // full parallel `npm test` run under CPU contention needs more margin
    // than the 5s default.
    it("caps the War Room ticker's DOM node count under a large curated event set, backfills via 'show earlier' in bounded chunks, and never renders past the playhead regardless of window size (P2 ticker windowing)", () => {
      const runID = "broadcast-window-cap-1";
      // 2,000 distinct eliminations, one per turn — mirrors the real
      // production shape that grew the ticker unbounded (P2-Fxx: ~1,957
      // rows on a real replay). `decisions` stays empty: the Analyst
      // panel's own table is a SEPARATE, already-existing, out-of-scope
      // concern (it maps 1:1 off `decisions`, not the curated War Room
      // set) — inflating it here would only slow this test down without
      // exercising anything this change touches.
      const events = Array.from({ length: 2000 }, (_, index) =>
        event(
          index + 1,
          index + 1,
          "elimination",
          "war",
          `a${index + 1}`,
          `Agent ${index + 1}`,
          null,
          null,
          `Agent ${index + 1} is eliminated.`,
        ),
      );
      // One MORE event, far beyond the viewer's playhead below — proof
      // that a generous DOM window never widens what spoiler windowing
      // already hides (spec item 4: windowing only ever shows LESS).
      events.push(
        event(
          9999,
          2500,
          "elimination",
          "war",
          "a9999",
          "Secret future agent",
          null,
          null,
          "Secret future agent is eliminated.",
        ),
      );

      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        currentTurn: 2000,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });

      const warRoom = document.querySelector(".broadcast-war-room");
      expect(warRoom).not.toBeNull();
      // The full curated set is 2,000 — the DOM only ever mounts the
      // AI_LEAGUE_WAR_ROOM_DOM_WINDOW-sized (60) most-recent slice.
      expect(
        warRoom?.querySelectorAll(".broadcast-war-room-item"),
      ).toHaveLength(60);
      expect(warRoom?.textContent).not.toContain("Secret future agent");

      const earlier = warRoom?.querySelector<HTMLButtonElement>(
        ".broadcast-war-room-earlier button",
      );
      expect(earlier).not.toBeNull();
      expect(earlier?.textContent).toContain("broadcast.war_room_show_earlier");
      // translateText falls back to the raw key with no LangSelector
      // mounted in this test environment, so the interpolated {count} isn't
      // observable here — the hidden count is verified structurally below,
      // via how many rows "show earlier" actually reveals. Its click's own
      // `replaceWith` also swaps in a brand-new `.broadcast-war-room` node
      // (a window-size change is a deliberate rare exception to the
      // incremental fast path — see patchVolatile's own doc), so re-query
      // rather than reuse the pre-click `warRoom` reference below.
      earlier?.click();
      const warRoomAfter = document.querySelector(".broadcast-war-room");
      expect(
        warRoomAfter?.querySelectorAll(".broadcast-war-room-item"),
      ).toHaveLength(120);
      expect(
        warRoomAfter?.querySelector<HTMLButtonElement>(
          ".broadcast-war-room-earlier button",
        ),
      ).not.toBeNull();
      // Backfilling never leaks the future event either.
      expect(warRoomAfter?.textContent).not.toContain("Secret future agent");
    }, 30_000);

    it("appends new ticker rows incrementally without tearing down retained rows, and keeps their jump-to-turn buttons live (spec item 3, no full-subtree teardown per chunk)", () => {
      const runID = "broadcast-incremental-append-1";
      const jumps: number[] = [];
      document.addEventListener("ai-league-replay-jump-turn", (domEvent) => {
        jumps.push(
          (domEvent as CustomEvent<{ turnNumber: number }>).detail.turnNumber,
        );
      });
      const events = Array.from({ length: 40 }, (_, index) =>
        event(
          index + 1,
          index + 1,
          "elimination",
          "war",
          `a${index + 1}`,
          `Agent ${index + 1}`,
          null,
          null,
          `Agent ${index + 1} is eliminated.`,
        ),
      );
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      const frame = (turnNumber: number) =>
        document.dispatchEvent(
          new CustomEvent("ai-league-replay-frame", {
            detail: { tick: turnNumber, turnNumber, players: [] },
          }),
        );

      frame(1);
      const firstRowBefore = document.querySelector(
        ".broadcast-war-room-item",
      );
      expect(firstRowBefore).not.toBeNull();
      const listBefore = document.querySelector(".broadcast-war-room-list");

      // 39 more forward ticks, one event revealed per tick — all 40 stay
      // under the DOM window (60), so nothing is ever pruned; every tick
      // must be a pure append, never a rebuild.
      for (let turn = 2; turn <= 40; turn += 1) {
        frame(turn);
      }

      expect(
        document.querySelectorAll(".broadcast-war-room-item"),
      ).toHaveLength(40);
      // The list container and the very first rendered row are the SAME DOM
      // nodes 39 ticks later — proof of incremental append, not a
      // teardown-and-rebuild-per-chunk.
      expect(document.querySelector(".broadcast-war-room-list")).toBe(
        listBefore,
      );
      expect(document.querySelector(".broadcast-war-room-item")).toBe(
        firstRowBefore,
      );
      // The retained row's own interactive chrome is still live — expand it
      // and jump, exactly like a freshly-built row would (spec item 2:
      // windowing/incrementality must never strip per-row functionality).
      firstRowBefore
        ?.querySelector<HTMLButtonElement>(".broadcast-war-room-summary")
        ?.click();
      firstRowBefore
        ?.querySelector<HTMLButtonElement>(".broadcast-war-room-jump")
        ?.click();
      expect(jumps).toEqual([1]);
    });

    it("auto-follows the newest ticker entry when the viewer is at the tail, and preserves (height-compensates) scroll position when they've scrolled up to read older entries, across the window's incremental prune (spec item 3)", () => {
      const runID = "broadcast-ticker-scroll-1";
      const events = Array.from({ length: 300 }, (_, index) =>
        event(
          index + 1,
          index + 1,
          "elimination",
          "war",
          `a${index + 1}`,
          `Agent ${index + 1}`,
          null,
          null,
          `Agent ${index + 1} is eliminated.`,
        ),
      );
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        currentTurn: 200,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      const list = document.querySelector<HTMLElement>(
        ".broadcast-war-room-list",
      );
      expect(list).not.toBeNull();
      expect(list?.querySelectorAll(".broadcast-war-room-item")).toHaveLength(
        60,
      );

      // --- Scrolled up (reading older entries): must not be yanked. ---
      const oldestRows = Array.from(
        list!.querySelectorAll<HTMLElement>(".broadcast-war-room-item"),
      ).slice(0, 3);
      for (const row of oldestRows) {
        vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
          height: 40,
        } as DOMRect);
      }
      Object.defineProperty(list, "scrollHeight", {
        configurable: true,
        value: 2400,
      });
      Object.defineProperty(list, "clientHeight", {
        configurable: true,
        value: 200,
      });
      let scrollTopValue = 500; // far short of the tail (2400 - 200 = 2200)
      Object.defineProperty(list, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      // 3 more turns -> 3 more eligible events -> the 60-row window prunes
      // exactly the 3 oldest (just mocked above) to stay at 60.
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 203, turnNumber: 203, players: [] },
        }),
      );

      for (const row of oldestRows) {
        expect(row.isConnected).toBe(false);
      }
      expect(list?.querySelectorAll(".broadcast-war-room-item")).toHaveLength(
        60,
      );
      // Never yanked to the top or the tail — compensated by exactly the
      // pruned rows' own height (3 x 40px), so on-screen content holds still.
      expect(scrollTopValue).toBe(500 - 3 * 40);

      // --- At the tail (following live playback): auto-follows the newest
      // entry. ---
      Object.defineProperty(list, "scrollHeight", {
        configurable: true,
        value: 2600,
      });
      scrollTopValue = 2600 - 200; // already at the tail
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 204, turnNumber: 204, players: [] },
        }),
      );
      expect(scrollTopValue).toBe(2600);
    });

    it("caps mounted rows at the window size on a large forward seek within a SINGLE tick — the append source is bounded to the window, not the whole eligible delta (regression: a jump bigger than the window used to defeat the DOM cap entirely)", () => {
      const runID = "broadcast-large-seek-1";
      // 200 events, indices 0..199 (turn = index+1), all "elimination"
      // except two boundary markers: index 139 (one BEFORE the expected
      // window start) is "betrayal", index 140 (the expected window
      // start once all 200 are eligible with a 60-row window,
      // 200 - 60 = 140) is "alliance". translateText returns the bare
      // key in this jsdom environment (no <lang-selector>), so
      // interpolated turn/actor text isn't observable — `data-kind`
      // (never translated) is the only reliable per-row identity signal,
      // so the two boundary events get distinct kinds instead of relying
      // on the shared "elimination" kind everything else uses.
      const events = Array.from({ length: 200 }, (_, index) => {
        const sequence = index + 1;
        const turn = index + 1;
        if (index === 139) {
          return event(
            sequence,
            turn,
            "alliance_break",
            "betrayal",
            "aB",
            "Boundary Betrayer",
            "aBT",
            "Boundary Target",
            "boundary betrayal",
          );
        }
        if (index === 140) {
          return event(
            sequence,
            turn,
            "alliance_formed",
            "pact",
            "aA",
            "Boundary Ally",
            "aAT",
            "Boundary Ally Target",
            "boundary alliance",
          );
        }
        return event(
          sequence,
          turn,
          "elimination",
          "war",
          `a${sequence}`,
          `Agent ${sequence}`,
          null,
          null,
          `Agent ${sequence} is eliminated.`,
        );
      });
      // Mount small (10 of 200 eligible) — well under the 60-row window,
      // so the DOM starts in the ordinary "not yet full" incremental
      // state, not the already-capped state.
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        currentTurn: 10,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      expect(
        document.querySelectorAll(".broadcast-war-room-item"),
      ).toHaveLength(10);

      // ONE tick jumps the playhead from turn 10 straight to turn 300 (all
      // 200 events become eligible at once) — a single-frame delta of 190,
      // more than 3x the 60-row window. This is the exact shape a real
      // replay produces on a coarse/throttled frame stream, or a
      // jump-to-turn/seek: the eligible COUNT can jump by far more than
      // the window in one `ai-league-replay-frame` tick.
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 300, turnNumber: 300, players: [] },
        }),
      );

      const items = document.querySelectorAll<HTMLElement>(
        ".broadcast-war-room-item",
      );
      // The cap held — NOT 190+ rows silently mounted.
      expect(items).toHaveLength(60);
      // The row exactly one index before the window start (139) must never
      // have been mounted at all.
      expect(
        document.querySelector('.broadcast-war-room-item[data-kind="betrayal"]'),
      ).toBeNull();
      // The row exactly at the window start (140, i.e. eligibleCount(200) -
      // windowSize(60)) is the OLDEST mounted row — first in DOM order
      // (rows append oldest-to-newest) among the actual event rows.
      const list = document.querySelector(".broadcast-war-room-list");
      const firstItem = list?.querySelector(".broadcast-war-room-item");
      expect(firstItem?.getAttribute("data-kind")).toBe("alliance");
    });

    it("preserves incremental append (node identity) for a multi-event forward seek that stays UNDER the window size — only a jump bigger than the window forces a rebuild", () => {
      const runID = "broadcast-medium-seek-1";
      const events = Array.from({ length: 100 }, (_, index) =>
        event(
          index + 1,
          index + 1,
          "elimination",
          "war",
          `a${index + 1}`,
          `Agent ${index + 1}`,
          null,
          null,
          `Agent ${index + 1} is eliminated.`,
        ),
      );
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        currentTurn: 5,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      const firstItemBefore = document.querySelector(
        ".broadcast-war-room-item",
      );
      expect(firstItemBefore).not.toBeNull();
      expect(
        document.querySelectorAll(".broadcast-war-room-item"),
      ).toHaveLength(5);

      // One tick reveals 20 more events at once (5 -> 25 eligible) — a
      // multi-event jump, but still comfortably under the 60-row window,
      // so every row (old AND new) must end up mounted, and the original
      // first row must survive as the exact same DOM node (incremental
      // append, never a rebuild, when the delta fits the window).
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 25, turnNumber: 25, players: [] },
        }),
      );
      expect(
        document.querySelectorAll(".broadcast-war-room-item"),
      ).toHaveLength(25);
      expect(document.querySelector(".broadcast-war-room-item")).toBe(
        firstItemBefore,
      );
    });

    it("recovers correctly from a backward seek followed by another large forward seek — the window cap and boundary stay correct, not just on the very first jump", () => {
      const runID = "broadcast-backward-then-forward-seek-1";
      const events = Array.from({ length: 200 }, (_, index) => {
        const sequence = index + 1;
        const turn = index + 1;
        if (index === 139) {
          return event(
            sequence,
            turn,
            "alliance_break",
            "betrayal",
            "aB",
            "Boundary Betrayer",
            "aBT",
            "Boundary Target",
            "boundary betrayal",
          );
        }
        if (index === 140) {
          return event(
            sequence,
            turn,
            "alliance_formed",
            "pact",
            "aA",
            "Boundary Ally",
            "aAT",
            "Boundary Ally Target",
            "boundary alliance",
          );
        }
        return event(
          sequence,
          turn,
          "elimination",
          "war",
          `a${sequence}`,
          `Agent ${sequence}`,
          null,
          null,
          `Agent ${sequence} is eliminated.`,
        );
      });
      // Mount already at the full 200-eligible / 60-row-window state.
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        currentTurn: 300,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      expect(
        document.querySelectorAll(".broadcast-war-room-item"),
      ).toHaveLength(60);

      // Backward seek (e.g. a jump-to-turn to earlier content, or a replay
      // scrub): eligible count drops from 200 to 50 — fewer than the
      // window, so every eligible row fits and no "earlier" affordance is
      // needed.
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 50, turnNumber: 50, players: [] },
        }),
      );
      expect(
        document.querySelectorAll(".broadcast-war-room-item"),
      ).toHaveLength(50);
      expect(
        document.querySelector(".broadcast-war-room-earlier"),
      ).toBeNull();

      // Then a large forward seek again, right back to all 200 eligible —
      // the SAME bounded-append fix must still hold after the backward
      // rebuild reset its own bookkeeping, not just on a mount's first
      // ever incremental tick.
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 300, turnNumber: 300, players: [] },
        }),
      );
      const items = document.querySelectorAll<HTMLElement>(
        ".broadcast-war-room-item",
      );
      expect(items).toHaveLength(60);
      expect(
        document.querySelector('.broadcast-war-room-item[data-kind="betrayal"]'),
      ).toBeNull();
      const list = document.querySelector(".broadcast-war-room-list");
      const firstItem = list?.querySelector(".broadcast-war-room-item");
      expect(firstItem?.getAttribute("data-kind")).toBe("alliance");
    });

    it("lazy-mounts the Analyst tab — empty while closed (no chart/table/list DOM at all), builds windowed content only once opened, and unmounts it again on close (spec item 1 follow-up, P2 review)", () => {
      const runID = "broadcast-analyst-lazy-mount-1";
      const decisions = Array.from({ length: 10 }, (_, index) => ({
        ...decisionFixture(index + 1),
        turnNumber: index + 1,
      }));
      const events = Array.from({ length: 10 }, (_, index) =>
        event(
          index + 1,
          index + 1,
          "elimination",
          "war",
          `a${index + 1}`,
          `Agent ${index + 1}`,
          null,
          null,
          `Agent ${index + 1} is eliminated.`,
        ),
      );
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions,
        currentTurn: 10,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });

      const analystSection = document.querySelector(".broadcast-analyst");
      expect(analystSection).not.toBeNull();
      // Closed by default: the section root stays mounted (existing
      // tab/aria wiring, and every `.broadcast-drawer-panel[data-tab-id=
      // "analysis"].broadcast-analyst` selector, never has to know the
      // difference) — but NOTHING inside it is constructed.
      expect(analystSection?.children.length).toBe(0);
      expect(
        document.querySelector(".broadcast-analyst-decisions-table"),
      ).toBeNull();
      expect(
        document.querySelector(".broadcast-analyst-events-list"),
      ).toBeNull();

      const toggle = document.querySelector<HTMLButtonElement>(
        "[data-ai-league-analyst-toggle]",
      );
      toggle?.click();

      expect(
        document.querySelector(".broadcast-analyst")?.children.length,
      ).toBeGreaterThan(0);
      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(10);
      expect(
        document.querySelectorAll(".broadcast-analyst-events-row"),
      ).toHaveLength(10);

      toggle?.click();
      expect(
        document.querySelector(".broadcast-analyst")?.children.length,
      ).toBe(0);
    });

    it("caps both Analyst sub-lists' DOM node count under a large fixture, backfills each independently via show-earlier, and never renders past the playhead (spec items 1-3 follow-up, P2 review)", () => {
      const runID = "broadcast-analyst-window-cap-1";
      const decisions = Array.from(
        { length: 200 },
        (_, index) => ({
          ...decisionFixture(index + 1),
          turnNumber: index + 1,
        }),
      );
      decisions.push({
        ...decisionFixture(9999),
        turnNumber: 2500,
        reason: "Secret future decision",
      });
      const events = Array.from({ length: 200 }, (_, index) =>
        event(
          index + 1,
          index + 1,
          "elimination",
          "war",
          `a${index + 1}`,
          `Agent ${index + 1}`,
          null,
          null,
          `Agent ${index + 1} is eliminated.`,
        ),
      );
      events.push(
        event(
          9999,
          2500,
          "elimination",
          "war",
          "a9999",
          "Secret future agent",
          null,
          null,
          "Secret future agent is eliminated.",
        ),
      );
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions,
        currentTurn: 200,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      document
        .querySelector<HTMLButtonElement>("[data-ai-league-analyst-toggle]")
        ?.click();

      const analyst = document.querySelector(".broadcast-analyst");
      expect(
        analyst?.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(60);
      expect(
        analyst?.querySelectorAll(".broadcast-analyst-events-row"),
      ).toHaveLength(60);
      expect(analyst?.textContent).not.toContain("Secret future decision");
      expect(analyst?.textContent).not.toContain("Secret future agent");

      const decisionsEarlier = analyst?.querySelector<HTMLButtonElement>(
        ".broadcast-analyst-decisions-earlier button",
      );
      const eventsEarlier = analyst?.querySelector<HTMLButtonElement>(
        ".broadcast-analyst-events-earlier button",
      );
      expect(decisionsEarlier).not.toBeNull();
      expect(eventsEarlier).not.toBeNull();

      // Each sub-list's own "show earlier" only ever grows THAT sub-list —
      // independent windows, independent affordances.
      decisionsEarlier?.click();
      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(120);
      expect(
        document.querySelectorAll(".broadcast-analyst-events-row"),
      ).toHaveLength(60);

      eventsEarlier?.click();
      expect(
        document.querySelectorAll(".broadcast-analyst-events-row"),
      ).toHaveLength(120);
      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(120);
      expect(
        document.querySelector(".broadcast-analyst")?.textContent,
      ).not.toContain("Secret future decision");
      expect(
        document.querySelector(".broadcast-analyst")?.textContent,
      ).not.toContain("Secret future agent");
    });

    it("caps mounted Analyst rows at the window size on a large forward seek within a SINGLE tick, in both sub-lists (regression: a jump bigger than the window used to defeat the DOM cap entirely)", () => {
      const runID = "broadcast-analyst-large-seek-1";
      const decisions = Array.from({ length: 200 }, (_, index) => {
        const sequence = index + 1;
        if (index === 139) {
          return {
            ...decisionFixture(sequence),
            turnNumber: sequence,
            reason: "BOUNDARY_BEFORE_DECISION",
          };
        }
        if (index === 140) {
          return {
            ...decisionFixture(sequence),
            turnNumber: sequence,
            reason: "BOUNDARY_AT_DECISION",
          };
        }
        return { ...decisionFixture(sequence), turnNumber: sequence };
      });
      const events = Array.from({ length: 200 }, (_, index) => {
        const sequence = index + 1;
        const kind =
          index === 139
            ? "boundary-before"
            : index === 140
              ? "boundary-at"
              : "elimination";
        return event(
          sequence,
          sequence,
          kind,
          "war",
          `a${sequence}`,
          `Agent ${sequence}`,
          null,
          null,
          `Agent ${sequence} note.`,
        );
      });
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions,
        currentTurn: 10,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      document
        .querySelector<HTMLButtonElement>("[data-ai-league-analyst-toggle]")
        ?.click();
      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(10);

      // ONE tick jumps the playhead from turn 10 straight to turn 300 (all
      // 200 decisions/events become eligible at once).
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 300, turnNumber: 300, players: [] },
        }),
      );

      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(60);
      expect(
        document.querySelectorAll(".broadcast-analyst-events-row"),
      ).toHaveLength(60);
      const analyst = document.querySelector(".broadcast-analyst");
      expect(analyst?.textContent).not.toContain("BOUNDARY_BEFORE_DECISION");
      expect(analyst?.textContent).toContain("BOUNDARY_AT_DECISION");
      expect(
        document.querySelector(
          '.broadcast-analyst-events-row[data-kind="boundary-before"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector(
          '.broadcast-analyst-events-row[data-kind="boundary-at"]',
        ),
      ).not.toBeNull();
    });

    it("preserves incremental append (node identity) in both Analyst sub-lists for a multi-item forward seek that stays UNDER the window size", () => {
      const runID = "broadcast-analyst-medium-seek-1";
      const decisions = Array.from({ length: 100 }, (_, index) => ({
        ...decisionFixture(index + 1),
        turnNumber: index + 1,
      }));
      const events = Array.from({ length: 100 }, (_, index) =>
        event(
          index + 1,
          index + 1,
          "elimination",
          "war",
          `a${index + 1}`,
          `Agent ${index + 1}`,
          null,
          null,
          `Agent ${index + 1} note.`,
        ),
      );
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions,
        currentTurn: 5,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      document
        .querySelector<HTMLButtonElement>("[data-ai-league-analyst-toggle]")
        ?.click();

      const firstDecisionRowBefore = document.querySelector(
        ".broadcast-analyst-decisions-row",
      );
      const firstEventRowBefore = document.querySelector(
        ".broadcast-analyst-events-row",
      );
      expect(firstDecisionRowBefore).not.toBeNull();
      expect(firstEventRowBefore).not.toBeNull();
      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(5);

      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 25, turnNumber: 25, players: [] },
        }),
      );

      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(25);
      expect(
        document.querySelectorAll(".broadcast-analyst-events-row"),
      ).toHaveLength(25);
      expect(document.querySelector(".broadcast-analyst-decisions-row")).toBe(
        firstDecisionRowBefore,
      );
      expect(document.querySelector(".broadcast-analyst-events-row")).toBe(
        firstEventRowBefore,
      );
    });

    it("recovers correctly in both Analyst sub-lists from a backward seek followed by another large forward seek", () => {
      const runID = "broadcast-analyst-backward-then-forward-seek-1";
      const decisions = Array.from({ length: 200 }, (_, index) => {
        const sequence = index + 1;
        if (index === 139) {
          return {
            ...decisionFixture(sequence),
            turnNumber: sequence,
            reason: "BOUNDARY_BEFORE_DECISION",
          };
        }
        if (index === 140) {
          return {
            ...decisionFixture(sequence),
            turnNumber: sequence,
            reason: "BOUNDARY_AT_DECISION",
          };
        }
        return { ...decisionFixture(sequence), turnNumber: sequence };
      });
      const events = Array.from({ length: 200 }, (_, index) => {
        const sequence = index + 1;
        const kind =
          index === 139
            ? "boundary-before"
            : index === 140
              ? "boundary-at"
              : "elimination";
        return event(
          sequence,
          sequence,
          kind,
          "war",
          `a${sequence}`,
          `Agent ${sequence}`,
          null,
          null,
          `Agent ${sequence} note.`,
        );
      });
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions,
        currentTurn: 300,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events,
          communicationThreads: [],
          timelineBuckets: [],
        },
      });
      document
        .querySelector<HTMLButtonElement>("[data-ai-league-analyst-toggle]")
        ?.click();
      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(60);

      // Backward seek: 200 -> 50 eligible, fewer than the window.
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 50, turnNumber: 50, players: [] },
        }),
      );
      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(50);
      expect(
        document.querySelectorAll(".broadcast-analyst-events-row"),
      ).toHaveLength(50);
      expect(
        document.querySelector(".broadcast-analyst-decisions-earlier"),
      ).toBeNull();

      // Then a large forward seek again, right back to all 200 eligible —
      // the SAME bounded-append fix must still hold after the backward
      // rebuild reset its own bookkeeping.
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 300, turnNumber: 300, players: [] },
        }),
      );
      expect(
        document.querySelectorAll(".broadcast-analyst-decisions-row"),
      ).toHaveLength(60);
      expect(
        document.querySelectorAll(".broadcast-analyst-events-row"),
      ).toHaveLength(60);
      const analyst = document.querySelector(".broadcast-analyst");
      expect(analyst?.textContent).not.toContain("BOUNDARY_BEFORE_DECISION");
      expect(analyst?.textContent).toContain("BOUNDARY_AT_DECISION");
    });

    it("derives the Analyst action-kind chart from the eligible slice only — a kind occurring ONLY beyond the playhead is absent from the chart until the playhead reaches its first occurrence, and every count exactly matches a hand-computed slice (P2 follow-up review: the chart is an aggregate, not a windowed list, but is STILL a spoiler surface)", () => {
      const runID = "broadcast-analyst-chart-boundary-1";
      // Turns 1-50: kind "build". Turns 51-100: kind "expand". ONE decision
      // at turn 200 with a THIRD kind, "nuke", that never occurs any
      // earlier -- the exact shape a leaked full-match aggregate would
      // expose immediately (the chart used to derive from
      // `input.decisions` unfiltered, so "nuke" would have been visible
      // at turn 0 even though the match hadn't reached it yet).
      function chartRowCount(label: string): string | null {
        const rows = document.querySelectorAll(
          ".broadcast-analyst-chart-row",
        );
        for (const row of rows) {
          if (
            row.querySelector(".broadcast-analyst-chart-label")
              ?.textContent === label
          ) {
            return (
              row.querySelector(".broadcast-analyst-chart-count")
                ?.textContent ?? null
            );
          }
        }
        return null;
      }
      const decisions = [
        ...Array.from({ length: 50 }, (_, index) => ({
          ...decisionFixture(index + 1),
          turnNumber: index + 1,
          selectedActionKind: "build",
        })),
        ...Array.from({ length: 50 }, (_, index) => ({
          ...decisionFixture(51 + index),
          turnNumber: 51 + index,
          selectedActionKind: "expand",
        })),
        {
          ...decisionFixture(9999),
          turnNumber: 200,
          selectedActionKind: "nuke",
        },
      ];
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions,
        currentTurn: 100,
      });
      document
        .querySelector<HTMLButtonElement>("[data-ai-league-analyst-toggle]")
        ?.click();

      // At turn 100: exactly 100 eligible decisions (50 build + 50
      // expand) -- "nuke" (turn 200) has not happened yet.
      expect(
        document.querySelectorAll(".broadcast-analyst-chart-row"),
      ).toHaveLength(2);
      expect(chartRowCount("build")).toBe("50");
      expect(chartRowCount("expand")).toBe("50");
      expect(chartRowCount("nuke")).toBeNull();
      expect(
        document.querySelector(".broadcast-analyst-chart")?.textContent,
      ).not.toContain("nuke");

      // Seeking past turn 200 reveals it, with its own exact count (1),
      // while the earlier counts stay exactly what they always were.
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 200, turnNumber: 200, players: [] },
        }),
      );
      expect(
        document.querySelectorAll(".broadcast-analyst-chart-row"),
      ).toHaveLength(3);
      expect(chartRowCount("build")).toBe("50");
      expect(chartRowCount("expand")).toBe("50");
      expect(chartRowCount("nuke")).toBe("1");
    });

    it("re-shrinks the Analyst action-kind chart on a backward seek — a full recompute over the (now smaller) eligible slice every tick, never a stateful accumulator that could drift on rewind", () => {
      const runID = "broadcast-analyst-chart-backward-seek-1";
      const decisions = [
        ...Array.from({ length: 50 }, (_, index) => ({
          ...decisionFixture(index + 1),
          turnNumber: index + 1,
          selectedActionKind: "build",
        })),
        ...Array.from({ length: 50 }, (_, index) => ({
          ...decisionFixture(51 + index),
          turnNumber: 51 + index,
          selectedActionKind: "expand",
        })),
      ];
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions,
        currentTurn: 100,
      });
      document
        .querySelector<HTMLButtonElement>("[data-ai-league-analyst-toggle]")
        ?.click();
      expect(
        document.querySelectorAll(".broadcast-analyst-chart-row"),
      ).toHaveLength(2);

      // Backward seek to turn 30: only "build" (turns 1-30) is eligible —
      // "expand" (turns 51-100) never happened yet from this rewound
      // playhead's point of view, so its row must disappear entirely, not
      // just stop growing.
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: 30, turnNumber: 30, players: [] },
        }),
      );
      const rows = document.querySelectorAll<HTMLElement>(
        ".broadcast-analyst-chart-row",
      );
      expect(rows).toHaveLength(1);
      expect(
        rows[0]?.querySelector(".broadcast-analyst-chart-label")
          ?.textContent,
      ).toBe("build");
      expect(
        rows[0]?.querySelector(".broadcast-analyst-chart-count")
          ?.textContent,
      ).toBe("30");
    });

    it("redacts a future timeline marker's kind and label until the playhead reaches it, then reveals the real content (spec item 2)", () => {
      const runID = "broadcast-marker-redaction-1";
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        replayMaxTurn: 1_000,
        spectatorTelemetry: {
          version: 1,
          runID,
          agents: [],
          relationships: [],
          events: [
            event(1, 300, "alliance_break", "betrayal", "a2", "Blitz", "a1", "Atlas", "Blitz says the pact is over."),
          ],
          communicationThreads: [],
          timelineBuckets: [],
        },
      });

      const betrayalOrUpcoming = () =>
        document.querySelector<HTMLElement>(
          '.broadcast-timeline-marker:not([data-kind="finish"])',
        );
      let m = betrayalOrUpcoming();
      // Content-free tick: neither the real kind nor its label reach the DOM
      // at all while the marker's own turn is still ahead of the playhead.
      expect(m?.dataset.kind).toBe("upcoming");
      expect(m?.getAttribute("title")).toBe("broadcast.timeline_marker_upcoming");

      frame(300, []);
      m = betrayalOrUpcoming();
      // Once the playhead reaches the marker's own turn, the real kind and
      // label render — no longer the redaction placeholder.
      expect(m?.dataset.kind).toBe("betrayal");
      expect(m?.getAttribute("title")).not.toBe(
        "broadcast.timeline_marker_upcoming",
      );
    });
  });

  describe("Director Cut (Stage 5 player integration)", () => {
    function directorCutPlanFixture(runID: string) {
      return {
        schemaVersion: 1,
        reportKind: "director-cut-plan",
        runID,
        matchID: runID,
        generatedAt: "2026-07-31T00:00:00.000Z",
        totalTurns: 999,
        segments: [
          {
            startTurn: 0,
            endTurn: 199,
            speed: "fast",
            eventReason: "quiet_interval",
            importance: 0,
            participatingAgents: [],
          },
          {
            startTurn: 200,
            endTurn: 999,
            speed: "slow",
            eventReason: "nuke",
            importance: 95,
            participatingAgents: ["Auri"],
          },
        ],
        importantTurnCount: 800,
        estimatedDurationSeconds: 300,
        degraded: false,
        notes: [],
      };
    }

    function frame(tick: number): void {
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick, turnNumber: tick, players: [] },
        }),
      );
    }

    it("renders no toggle at all when no valid Director Cut plan is present", () => {
      const runID = "director-cut-none-1";
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
      });
      expect(
        document.querySelector("[data-ai-league-director-cut-toggle]"),
      ).toBeNull();
    });

    it("mounts enabled by default once a valid plan arrives via hydrate, and drives replay speed as the turn crosses segments", () => {
      const runID = "director-cut-toggle-1";
      const onReplaySpeedChange = vi.fn();
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        onReplaySpeedChange,
      });
      overlay.hydrate({
        directorCutPlan: directorCutPlanFixture(runID),
      });

      const toggle = document.querySelector<HTMLButtonElement>(
        "[data-ai-league-director-cut-toggle]",
      );
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute("aria-pressed")).toBe("true");
      // Mounting applies the opening segment's speed immediately.
      expect(onReplaySpeedChange).toHaveBeenCalledWith(0); // fastest
      onReplaySpeedChange.mockClear();

      frame(200);
      expect(onReplaySpeedChange).toHaveBeenCalledWith(2); // slow
    });

    it("hands control back to Full Replay when toggled off, and never emits another speed change from the plan", () => {
      const runID = "director-cut-toggle-2";
      const onReplaySpeedChange = vi.fn();
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        onReplaySpeedChange,
      });
      overlay.hydrate({
        directorCutPlan: directorCutPlanFixture(runID),
      });
      const toggle = document.querySelector<HTMLButtonElement>(
        "[data-ai-league-director-cut-toggle]",
      );
      onReplaySpeedChange.mockClear();

      toggle?.click();
      expect(toggle?.getAttribute("aria-pressed")).toBe("false");
      expect(onReplaySpeedChange).toHaveBeenCalledWith(1); // normal

      onReplaySpeedChange.mockClear();
      frame(200);
      expect(onReplaySpeedChange).not.toHaveBeenCalled();
    });

    it("applies the segment covering the current turn — not the opening one — when the plan hydrates after playback already advanced", () => {
      // Late plan hydration: `director-cut-plan.json` loads asynchronously,
      // same timing as spectator telemetry, so playback can already be
      // well past turn 0 by the time it resolves.
      const runID = "director-cut-late-hydrate";
      const onReplaySpeedChange = vi.fn();
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        onReplaySpeedChange,
      });
      frame(200);
      onReplaySpeedChange.mockClear();
      overlay.hydrate({
        directorCutPlan: directorCutPlanFixture(runID),
      });

      // Turn 200 is the plan's "slow" segment; a hardcoded-to-0 bug would
      // apply "fast" (turn 0's segment) instead.
      expect(onReplaySpeedChange).toHaveBeenCalledExactlyOnceWith(2); // slow
    });

    it("resyncs to the CURRENT turn's segment when toggled back on mid-match, not the opening segment", () => {
      const runID = "director-cut-toggle-resync";
      const onReplaySpeedChange = vi.fn();
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
        onReplaySpeedChange,
      });
      overlay.hydrate({
        directorCutPlan: directorCutPlanFixture(runID),
      });
      frame(200);
      expect(onReplaySpeedChange).toHaveBeenCalledWith(2); // slow

      const toggle = document.querySelector<HTMLButtonElement>(
        "[data-ai-league-director-cut-toggle]",
      );
      toggle?.click(); // off
      expect(onReplaySpeedChange).toHaveBeenCalledWith(1); // normal
      onReplaySpeedChange.mockClear();

      toggle?.click(); // back on, still at turn 200
      // The masking bug: re-enabling always reapplied the opening ("fast")
      // segment, self-correcting only at the next frame tick boundary.
      expect(onReplaySpeedChange).toHaveBeenCalledExactlyOnceWith(2); // slow
    });
  });

  describe("Match-state strip (Season Zero broadcast Phase 5)", () => {
    function agentSample(
      username: string,
      playerID: string,
      territoryShare: number,
      rank: number,
      alive = true,
    ) {
      return { agentID: playerID, playerID, username, alive, tilesOwned: Math.round(territoryShare * 1000), troops: 10, territoryShare, rank };
    }

    function matchStateSeriesFixture(runID: string) {
      return {
        schemaVersion: 1,
        runID,
        matchID: runID,
        generatedAt: "2026-08-01T00:00:00.000Z",
        source: "spectator-replay-snapshots",
        totalTurns: 1000,
        samples: [
          {
            turn: 0,
            tick: 0,
            phase: "spawn",
            agents: [
              agentSample("Auri", "p1", 0.5, 1),
              agentSample("Borealis", "p2", 0.5, 2),
            ],
            activeAlliancePairs: [],
          },
          {
            turn: 200,
            tick: 200,
            phase: "active",
            agents: [
              agentSample("Auri", "p1", 0.7, 1),
              agentSample("Borealis", "p2", 0.3, 2),
            ],
            activeAlliancePairs: [["p1", "p2"]],
          },
          {
            turn: 400,
            tick: 400,
            phase: "active",
            agents: [
              // Distinct from the turn=200 sample's own delta (+20) so the
              // two samples are distinguishable via the delta item's raw,
              // untranslated `formatSignedPercent` text — `translateText`
              // itself returns bare keys in this jsdom test environment (no
              // `<lang-selector>`), so leader/alive/relations VALUES (which
              // route through `translateText(key, params)`) cannot be
              // read back from `textContent` here; only the delta's raw
              // value bypasses that.
              agentSample("Auri", "p1", 0.95, 1),
              agentSample("Borealis", "p2", 0.05, 2, false),
            ],
            activeAlliancePairs: [],
          },
        ],
        notes: [],
      };
    }

    function frame(
      turnNumber: number,
      players: ReadonlyArray<{
        smallID: number;
        username: string;
        targets?: number[];
        allies?: number[];
      }> = [],
    ): void {
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: {
            tick: turnNumber,
            turnNumber,
            players: players.map((player) => ({
              playerID: `player-${player.smallID}`,
              smallID: player.smallID,
              clientID: null,
              username: player.username,
              displayName: player.username,
              x: 0,
              y: 0,
              tilesOwned: 0,
              allies: player.allies ?? [],
              targets: player.targets ?? [],
              embargoes: [],
              alliances: [],
            })),
          },
        }),
      );
    }

    it("windows the strip to the LATEST sample at or before the playhead, never a future one", () => {
      const runID = "state-strip-window-1";
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
      });
      overlay.hydrate({ matchStateSeries: matchStateSeriesFixture(runID) });

      // Turn 300 sits strictly between the turn=200 (delta +20) and turn=400
      // (delta +25) samples — the rendered delta must read +20, never +25
      // (which the playhead has not reached yet).
      frame(300);
      let delta = document.querySelector(".broadcast-state-strip-delta");
      expect(delta).not.toBeNull();
      expect(delta?.textContent).toContain("+20");
      expect(delta?.textContent).not.toContain("+25");

      // Advancing the playhead to turn 400 reveals the later sample.
      frame(400);
      delta = document.querySelector(".broadcast-state-strip-delta");
      expect(delta?.textContent).toContain("+25");
    });

    it("stays entirely absent before the playhead reaches the first released sample", () => {
      const runID = "state-strip-window-2";
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
      });
      const series = matchStateSeriesFixture(runID);
      overlay.hydrate({
        matchStateSeries: { ...series, samples: series.samples.slice(1) }, // first sample now at turn 200
      });
      frame(100);
      expect(document.querySelector(".broadcast-state-strip")).toBeNull();
    });

    it("is absent entirely when no match-state-series artifact is available", () => {
      const runID = "state-strip-absent-no-artifact";
      mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
      });
      frame(400);
      expect(document.querySelector(".broadcast-state-strip")).toBeNull();
    });

    it("derives activeWarCount honestly from the live frame's targets/allies — never from the series, which has no war concept", () => {
      // translateText returns bare keys in this jsdom environment (no
      // <lang-selector>), so the rendered relations VALUE can't be read
      // back from textContent — verify the pure derivation directly
      // instead, same as `activeWarPairCount`'s own unit coverage below.
      const framePlayers = [
        { smallID: 1, username: "Auri", allies: [], targets: [2, 3] },
        { smallID: 2, username: "Borealis", allies: [3], targets: [] },
        { smallID: 3, username: "Cascade", allies: [2], targets: [] },
      ] as unknown as Parameters<typeof activeWarPairCount>[0];
      // p1 attacks p2 and p3; p2 and p3 are allied (suppresses that pair) —
      // two real at-war pairs: (p1, p2) and (p1, p3).
      expect(activeWarPairCount(framePlayers)).toBe(2);
    });

    it("never double-counts a bidirectional attack as two war pairs", () => {
      const framePlayers = [
        { smallID: 1, username: "Auri", allies: [], targets: [2] },
        { smallID: 2, username: "Borealis", allies: [], targets: [1] },
      ] as unknown as Parameters<typeof activeWarPairCount>[0];
      expect(activeWarPairCount(framePlayers)).toBe(1);
    });

    it("windows the pure derivation to the latest sample at or before the playhead, with the correct diffed delta and honest null-territory-delta on the first released sample", () => {
      const series = normalizeMatchStateSeries(
        matchStateSeriesFixture("state-strip-derive-1"),
      );
      if (series === null) throw new Error("fixture must normalize");
      const identity = new Map<string, PublicAgent>();
      const first = deriveMatchStateStripFields(series, 0, [], identity);
      expect(first?.territoryShareDeltaPercent).toBeNull();
      expect(first?.leader?.territoryPercent).toBeCloseTo(50);

      const mid = deriveMatchStateStripFields(series, 300, [], identity);
      expect(mid?.leader?.territoryPercent).toBeCloseTo(70); // windowed to turn=200, not turn=400
      expect(mid?.territoryShareDeltaPercent).toBeCloseTo(20);
      expect(mid?.aliveCount).toBe(2);
      expect(mid?.activeAllianceCount).toBe(1);

      const late = deriveMatchStateStripFields(series, 400, [], identity);
      expect(late?.leader?.territoryPercent).toBeCloseTo(95);
      expect(late?.territoryShareDeltaPercent).toBeCloseTo(25);
      expect(late?.aliveCount).toBe(1); // Borealis eliminated by turn=400

      expect(deriveMatchStateStripFields(null, 400, [], identity)).toBeNull();
      // Before the first sample's own turn — no safe sample yet.
      const laterSeries = {
        ...series,
        samples: series.samples.slice(1),
      };
      expect(
        deriveMatchStateStripFields(laterSeries, 100, [], identity),
      ).toBeNull();
    });

    it("prefers the Director Cut active segment label over the sample's own phase when Director Cut mode is on", () => {
      const runID = "state-strip-phase-director-cut";
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
      });
      overlay.hydrate({
        matchStateSeries: matchStateSeriesFixture(runID),
        directorCutPlan: {
          schemaVersion: 1,
          reportKind: "director-cut-plan",
          runID,
          matchID: runID,
          generatedAt: "2026-08-01T00:00:00.000Z",
          totalTurns: 1000,
          segments: [
            {
              startTurn: 0,
              endTurn: 999,
              speed: "normal",
              eventReason: "First strike",
              importance: 50,
              participatingAgents: [],
            },
          ],
          importantTurnCount: 1,
          estimatedDurationSeconds: 60,
          degraded: false,
          notes: [],
        },
      });
      // Enabled by default for Full Replay (spec item 3).
      frame(200);
      expect(
        document.querySelector(".broadcast-state-strip")?.textContent,
      ).toContain("First strike");
    });

    it("falls back to the sample's own translated phase when Director Cut mode is off", () => {
      const runID = "state-strip-phase-fallback";
      const overlay = mountAiLeagueReplayOverlay({
        runID,
        artifactBasePath: `/ai-league-runs/${runID}`,
        decisions: [],
      });
      overlay.hydrate({ matchStateSeries: matchStateSeriesFixture(runID) });
      frame(200); // sample at turn 200 has phase "active"; no Director Cut plan hydrated
      expect(
        document.querySelector(".broadcast-state-strip")?.textContent,
      ).toContain("broadcast.phase_active");
    });
  });
});

function clipCapabilitiesResponse(enabled: boolean): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      premiereGenerationEnabled: enabled,
      leagueGenerationEnabled: enabled,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function decisionFixture(sequence: number) {
  return {
    sequence,
    turnNumber: sequence * 10,
    username: `Agent ${sequence}`,
    profile: "balanced",
    brainType: "planner",
    selectedActionKind: "build",
    selectedLegalActionId: `build:${sequence}`,
    reason: `Decision ${sequence}`,
    decisionLatencyMs: 10,
    fallbackUsed: false,
    result: {
      accepted: true,
      reason: "accepted",
    },
  };
}

function spectatorTelemetryFixture() {
  return {
    version: 1,
    runID: "politics-render",
    generatedAt: "2026-01-01T00:00:00.000Z",
    agents: [
      {
        agentID: "a1",
        playerID: "p1",
        username: "Atlas",
        profile: "diplomatic",
        colorIndex: 0,
        finalTilesOwned: 60,
        finalTroops: 1000,
        isAlive: true,
      },
      {
        agentID: "a2",
        playerID: "p2",
        username: "Blitz",
        profile: "aggressive",
        colorIndex: 1,
        finalTilesOwned: 90,
        finalTroops: 2000,
        isAlive: true,
      },
      {
        agentID: "a3",
        playerID: "p3",
        username: "Civic",
        profile: "defensive",
        colorIndex: 2,
        finalTilesOwned: 20,
        finalTroops: 500,
        isAlive: true,
      },
    ],
    relationships: [
      relationship("a1", "a2", "ally", 82, 10, 12),
      relationship("a2", "a1", "betrayed", 8, 92, 88),
      relationship("a1", "a3", "neutral", 50, 10, 10),
      relationship("a3", "a1", "neutral", 50, 10, 10),
      relationship("a2", "a3", "rival", 25, 75, 70),
      relationship("a3", "a2", "target", 40, 60, 65),
    ],
    events: [
      event(
        1,
        500,
        "alliance_break",
        "betrayal",
        "a2",
        "Blitz",
        "a1",
        "Atlas",
        "Blitz says the pact is over.",
      ),
      event(
        2,
        505,
        "chat",
        "pact",
        "a1",
        "Atlas",
        "a2",
        "Blitz",
        "Atlas asks for a quiet border.",
      ),
      event(
        3,
        506,
        "target_call",
        "threat",
        "a3",
        "Civic",
        "a2",
        "Blitz",
        "Civic calls for pressure on Blitz.",
      ),
    ],
    communicationThreads: [
      {
        id: "a1:a2",
        agentIDs: ["a1", "a2"],
        title: "a1 ↔ a2",
        latestTurn: 505,
        tone: "betrayal",
        messages: [
          event(
            1,
            500,
            "alliance_break",
            "betrayal",
            "a2",
            "Blitz",
            "a1",
            "Atlas",
            "Blitz says the pact is over.",
          ),
          event(
            2,
            505,
            "chat",
            "pact",
            "a1",
            "Atlas",
            "a2",
            "Blitz",
            "Atlas asks for a quiet border.",
          ),
        ],
      },
      {
        id: "a2:a3",
        agentIDs: ["a2", "a3"],
        title: "a2 ↔ a3",
        latestTurn: 506,
        tone: "threat",
        messages: [
          event(
            3,
            506,
            "target_call",
            "threat",
            "a3",
            "Civic",
            "a2",
            "Blitz",
            "Civic calls for pressure on Blitz.",
          ),
        ],
      },
    ],
    timelineBuckets: [
      {
        startTurn: 0,
        endTurn: 999,
        events: [
          event(
            1,
            500,
            "alliance_break",
            "betrayal",
            "a2",
            "Blitz",
            "a1",
            "Atlas",
            "Blitz says the pact is over.",
          ),
          event(
            3,
            506,
            "target_call",
            "threat",
            "a3",
            "Civic",
            "a2",
            "Blitz",
            "Civic calls for pressure on Blitz.",
          ),
        ],
      },
    ],
  };
}

function relationship(
  fromAgentID: string,
  toAgentID: string,
  currentLabel: string,
  trust: number,
  distrust: number,
  tension: number,
) {
  return {
    fromAgentID,
    toAgentID,
    trust,
    distrust,
    tension,
    allianceState: currentLabel === "ally" ? "allied" : "none",
    tradeGivenGold: 0,
    tradeGivenTroops: 0,
    attacksSent: currentLabel === "rival" ? 2 : 0,
    attacksReceived: 0,
    betrayals: currentLabel === "betrayed" ? 1 : 0,
    lastMajorEventTurn: 500,
    currentLabel,
    reasons: [`${fromAgentID} feels ${currentLabel} toward ${toAgentID}`],
  };
}

function event(
  sequence: number,
  turnNumber: number,
  kind: string,
  tone: string,
  actorAgentID: string,
  actorName: string,
  targetAgentID: string | null,
  targetName: string | null,
  message: string,
) {
  return {
    id: `${turnNumber}:${sequence}:${kind}`,
    sequence,
    turnNumber,
    kind,
    tone,
    actorAgentID,
    actorName,
    targetAgentID,
    targetName,
    message,
    publicText: message,
    actionKind: "quick_chat",
    actionID: `${kind}:${sequence}`,
    importance: kind === "alliance_break" ? 100 : 85,
  };
}

function publicAgentFixture(overrides: {
  playerName: string;
  displayName: string;
  slug: string;
  emblemSvg: string;
  versionLabel: string;
  builderDisplayName: string;
}): PublicAgent {
  return {
    registered: true,
    id: overrides.slug,
    slug: overrides.slug,
    playerName: overrides.playerName,
    displayName: overrides.displayName,
    shortCode: null,
    emblemSvg: overrides.emblemSvg,
    primaryColor: "#112233",
    secondaryColor: null,
    tagline: null,
    builderId: "builder-1",
    builderDisplayName: overrides.builderDisplayName,
    status: "verified",
    standing: null,
    activeVersion: {
      publicVersionLabel: overrides.versionLabel,
      source: "champion",
      familyMismatch: false,
      firstObservedAt: null,
    },
    provenance: {
      ratingPolicyLabel: null,
      activeChampionPolicyLabel: null,
    },
    stats: null,
    timeSeries: { winrate: null, score: null },
  };
}

function readModelResponse(agents: PublicAgent[]): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      lastGoodSyncAt: "2026-01-01T00:00:00.000Z",
      stale: false,
      feedStates: { championFeedStale: false, replayFeedStale: false },
      league: {
        id: "league-1",
        name: "Proxy War League",
        description: null,
        divisionName: "Open",
        roundIntervalMinutes: null,
        episodesPerRound: null,
        currentRoundNumber: null,
        currentRoundStatus: null,
        scoreLabel: "Rating",
      },
      builders: [],
      agents,
      versions: [],
      rounds: [],
      matches: [],
      featuredMatches: [],
      seasons: [],
      premieres: { live: null, latest: null },
      links: {
        enterTheLeagueUrl: "https://example.test/enter",
        platformLabel: "Proxy War",
        accountUrl: "https://example.test/account",
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Phase 7 analytics: Director Cut, timeline jump, watch-progress milestones", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 768,
    });
    document.body.innerHTML = "";
    localStorage.clear();
    trackMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function directorCutPlanFixture(runID: string) {
    return {
      schemaVersion: 1,
      reportKind: "director-cut-plan",
      runID,
      matchID: runID,
      generatedAt: "2026-07-31T00:00:00.000Z",
      totalTurns: 999,
      segments: [
        {
          startTurn: 0,
          endTurn: 999,
          speed: "fast",
          eventReason: "quiet_interval",
          importance: 0,
          participatingAgents: [],
        },
      ],
      importantTurnCount: 800,
      estimatedDurationSeconds: 300,
      degraded: false,
      notes: [],
    };
  }

  it("tracks director_cut_started once when the plan mounts enabled by default", () => {
    const runID = "analytics-dc-mount-1";
    const overlay = mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      decisions: [],
    });
    expect(trackMock).not.toHaveBeenCalledWith(
      "director_cut_started",
      expect.anything(),
    );
    overlay.hydrate({ directorCutPlan: directorCutPlanFixture(runID) });
    expect(trackMock).toHaveBeenCalledExactlyOnceWith("director_cut_started", {
      matchId: runID,
      replayMode: "director_cut",
    });
  });

  it("tracks director_cut_started again on an explicit toggle-on, never on toggle-off", () => {
    const runID = "analytics-dc-toggle-1";
    const overlay = mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      decisions: [],
    });
    overlay.hydrate({ directorCutPlan: directorCutPlanFixture(runID) });
    trackMock.mockClear();

    const toggle = document.querySelector<HTMLButtonElement>(
      "[data-ai-league-director-cut-toggle]",
    );
    toggle?.click(); // off
    expect(trackMock).not.toHaveBeenCalledWith(
      "director_cut_started",
      expect.anything(),
    );
    toggle?.click(); // back on
    expect(trackMock).toHaveBeenCalledExactlyOnceWith("director_cut_started", {
      matchId: runID,
      replayMode: "director_cut",
    });
  });

  it("tracks timeline_jump when the War Room feed's jump-to-turn action fires", () => {
    const runID = "analytics-timeline-jump-1";
    const jumps: number[] = [];
    document.addEventListener("ai-league-replay-jump-turn", (domEvent) => {
      jumps.push(
        (domEvent as CustomEvent<{ turnNumber: number }>).detail.turnNumber,
      );
    });
    mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      currentTurn: 999,
      decisions: [
        { ...decisionFixture(1), username: "Atlas", turnNumber: 10, planObjective: "expand" },
        {
          ...decisionFixture(2),
          username: "Atlas",
          turnNumber: 20,
          planObjective: "consolidate",
          reason: "Defend the core.",
          planRationale: "Blitz is massing troops nearby.",
        },
      ],
      spectatorTelemetry: {
        version: 1,
        runID,
        agents: [],
        relationships: [],
        events: [],
        communicationThreads: [],
        timelineBuckets: [],
      },
    });
    const planChangeItem = document.querySelector('[data-kind="plan_change"]');
    expect(planChangeItem).not.toBeNull();
    planChangeItem
      ?.querySelector<HTMLButtonElement>(".broadcast-war-room-summary")
      ?.click();
    trackMock.mockClear();
    planChangeItem
      ?.querySelector<HTMLButtonElement>(".broadcast-war-room-jump")
      ?.click();
    expect(jumps).toEqual([20]);
    expect(trackMock).toHaveBeenCalledWith("timeline_jump", { matchId: runID });
  });

  it("tracks watched_30s and watched_2m from ACCUMULATED ACTIVE playback seconds across steady frames, not wall-clock elapsed time", () => {
    vi.useFakeTimers();
    const runID = "analytics-watch-time-1";
    mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      decisions: [],
      replayMaxTurn: 1000,
    });
    // Every mount registered by an earlier test in this file also reacts to
    // this document-level event (none of them dispose); scope every
    // assertion to THIS test's own runID so accumulated listeners from
    // sibling tests never produce a false positive or negative here.
    const callsFor = (name: string) =>
      trackMock.mock.calls.filter(
        ([calledName, context]) =>
          calledName === name &&
          (context as { matchId?: string } | undefined)?.matchId === runID,
      );
    const frame = (turnNumber: number) =>
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: turnNumber, turnNumber, players: [] },
        }),
      );

    frame(1); // first frame — no prior frame to diff against, contributes nothing
    expect(callsFor("watched_30s")).toHaveLength(0);

    // 15 steady 2s-spaced frames = 30,000ms of real, at-the-cap delta each.
    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(2_000);
      frame(2 + i);
    }
    expect(callsFor("watched_30s")).toHaveLength(1);
    expect(callsFor("watched_2m")).toHaveLength(0);

    // 45 more steady 2s-spaced frames = 90,000ms more, crossing 120,000ms total.
    for (let i = 0; i < 45; i++) {
      vi.advanceTimersByTime(2_000);
      frame(20 + i);
    }
    expect(callsFor("watched_2m")).toEqual([
      ["watched_2m", { matchId: runID, replayMode: "full_replay" }],
    ]);
  });

  it("caps a paused/stalled gap's contribution — a long wall-clock gap between frames never counts as watched time", () => {
    vi.useFakeTimers();
    const runID = "analytics-watch-paused-1";
    mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      decisions: [],
      replayMaxTurn: 1000,
    });
    const callsFor = (name: string) =>
      trackMock.mock.calls.filter(
        ([calledName, context]) =>
          calledName === name &&
          (context as { matchId?: string } | undefined)?.matchId === runID,
      );
    const frame = (turnNumber: number) =>
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: turnNumber, turnNumber, players: [] },
        }),
      );

    frame(1);
    // A single 60-second real-time gap (paused/buffering/stalled playback)
    // must contribute at most the 2-second cap, nowhere near the 30s
    // threshold on its own.
    vi.advanceTimersByTime(60_000);
    frame(2);
    expect(callsFor("watched_30s")).toHaveLength(0);

    // Repeating that 60-second-gap pattern would blow past 30s of WALL
    // CLOCK almost instantly if wall-clock elapsed time were still being
    // used — but each gap is capped at 2s of ACTIVE playback, so it takes
    // exactly 15 such gaps (1 above + 14 here) to accumulate 30,000ms.
    for (let i = 0; i < 13; i++) {
      vi.advanceTimersByTime(60_000);
      frame(3 + i);
    }
    expect(callsFor("watched_30s")).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    frame(20);
    expect(callsFor("watched_30s")).toHaveLength(1);
  });

  it("halts accumulation entirely while the document is hidden, even if frames keep arriving", () => {
    vi.useFakeTimers();
    const runID = "analytics-watch-hidden-1";
    mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      decisions: [],
      replayMaxTurn: 1000,
    });
    const callsFor = (name: string) =>
      trackMock.mock.calls.filter(
        ([calledName, context]) =>
          calledName === name &&
          (context as { matchId?: string } | undefined)?.matchId === runID,
      );
    const frame = (turnNumber: number) =>
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: turnNumber, turnNumber, players: [] },
        }),
      );
    const hiddenSpy = vi.spyOn(document, "hidden", "get");

    hiddenSpy.mockReturnValue(false);
    frame(1);
    vi.advanceTimersByTime(2_000);
    frame(2); // 2,000ms accumulated while visible
    expect(callsFor("watched_30s")).toHaveLength(0);

    // Tab backgrounded: frames keep arriving (the underlying playback
    // driver need not pause), but none of this time may count as watched.
    hiddenSpy.mockReturnValue(true);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(2_000);
      frame(3 + i);
    }
    expect(callsFor("watched_30s")).toHaveLength(0);

    // Foregrounded again: accumulation resumes.
    hiddenSpy.mockReturnValue(false);
    for (let i = 0; i < 14; i++) {
      vi.advanceTimersByTime(2_000);
      frame(30 + i);
    }
    // 2,000ms (before backgrounding) + 14 x 2,000ms (after foregrounding) = 30,000ms.
    expect(callsFor("watched_30s")).toHaveLength(1);
    hiddenSpy.mockRestore();
  });

  it("tracks watched_50pct once turn progress crosses half of the finish turn", () => {
    const runID = "analytics-watch-50pct-1";
    mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      decisions: [],
      replayMaxTurn: 1000,
    });
    const callsFor = (name: string) =>
      trackMock.mock.calls.filter(
        ([calledName, context]) =>
          calledName === name &&
          (context as { matchId?: string } | undefined)?.matchId === runID,
      );
    const frame = (turnNumber: number) =>
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: { tick: turnNumber, turnNumber, players: [] },
        }),
      );

    frame(499);
    expect(callsFor("watched_50pct")).toHaveLength(0);
    frame(500);
    expect(callsFor("watched_50pct")).toEqual([
      ["watched_50pct", { matchId: runID, replayMode: "full_replay" }],
    ]);
    frame(501);
    expect(callsFor("watched_50pct")).toHaveLength(1);
  });

  it("tracks completed exactly once when a terminal frame arrives, tagged with the active replay mode", () => {
    const runID = "analytics-watch-completed-1";
    const overlay = mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      decisions: [],
      replayMaxTurn: 1000,
    });
    overlay.hydrate({ directorCutPlan: directorCutPlanFixture(runID) });
    trackMock.mockClear();
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 999, turnNumber: 999, terminal: true, players: [] },
      }),
    );
    expect(trackMock).toHaveBeenCalledWith("completed", {
      matchId: runID,
      replayMode: "director_cut",
    });
    const completedCallsForThisRun = trackMock.mock.calls.filter(
      ([name, context]) =>
        name === "completed" &&
        (context as { matchId?: string } | undefined)?.matchId === runID,
    );
    expect(completedCallsForThisRun).toHaveLength(1);
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 999, turnNumber: 999, terminal: true, players: [] },
      }),
    );
    expect(
      trackMock.mock.calls.filter(
        ([name, context]) =>
          name === "completed" &&
          (context as { matchId?: string } | undefined)?.matchId === runID,
      ),
    ).toHaveLength(1);
  });

  it("stops emitting watch-progress milestones once the overlay is disposed", () => {
    vi.useFakeTimers();
    const runID = "analytics-watch-dispose-1";
    const overlay = mountAiLeagueReplayOverlay({
      runID,
      artifactBasePath: `/ai-league-runs/${runID}`,
      decisions: [],
      replayMaxTurn: 1000,
    });
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 1, turnNumber: 1, players: [] },
      }),
    );
    overlay.dispose();
    trackMock.mockClear();
    vi.advanceTimersByTime(200_000);
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 2, turnNumber: 2, players: [] },
      }),
    );
    expect(
      trackMock.mock.calls.filter(
        ([, context]) =>
          (context as { matchId?: string } | undefined)?.matchId === runID,
      ),
    ).toHaveLength(0);
  });
});
