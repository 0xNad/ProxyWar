import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountAiLeagueReplayOverlay } from "../../src/client/AiLeagueReplayOverlay";

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
    expect(overlay?.textContent).toContain("build:Defense Post:10");
    expect(overlay?.textContent).toContain(
      "1 Proxy War agents vs 10 built-in opponents",
    );
    // Playstyle line replaces the action-count tally and recent-action feed.
    expect(overlay?.querySelector(".ai-league-playstyle")).not.toBeNull();
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
    expect(overlay?.querySelector("a")?.getAttribute("href")).toContain(
      "/ai-league-runs/run-render-1",
    );

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

  it("renders only known-existing artifact links when availability is provided", () => {
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
    expect(hrefs).toEqual([
      "/ai-league-runs/artifact-links/decisions.jsonl",
      "/ai-league-runs/artifact-links/match-summary.json",
    ]);
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
    const playstyle = overlay.querySelector(
      ".ai-league-playstyle",
    )?.textContent;
    expect(playstyle).toContain("nuke");
    expect(playstyle).toContain("chat");
    expect(playstyle).toContain("build");
    expect(playstyle).not.toContain("hold");
  });

  it("hydrates older decisions in bounded pages instead of building hidden cards", () => {
    mountAiLeagueReplayOverlay({
      runID: "incremental-decisions",
      artifactBasePath: "/ai-league-runs/incremental-decisions",
      decisions: Array.from({ length: 40 }, (_, index) =>
        decisionFixture(index + 1),
      ),
    });

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
          detail: { tick: turnNumber * 2, turnNumber, players: [] },
        }),
      );
    }

    it("locks the clip button until playback reaches a clippable turn", async () => {
      const runID = "league-clip-lock-1";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => clipCapabilitiesResponse(true)),
      );
      try {
        mountAiLeagueReplayOverlay({
          runID,
          artifactBasePath: `/ai-league-runs/${runID}`,
          decisions: [],
        });
        const section = document.querySelector("[data-ai-league-clip]");
        expect(section).not.toBeNull();
        // Unknown capability fails closed while the read is in flight.
        expect(section?.hasAttribute("hidden")).toBe(true);
        await vi.waitFor(() => {
          expect(section?.hasAttribute("hidden")).toBe(false);
          expect(section?.textContent).toContain(
            "ai_league_replay.clip_waiting_playback",
          );
        });
        expect(
          section?.querySelector("[data-ai-league-clip-render]"),
        ).toBeNull();

        frame(120);
        const unlocked = document.querySelector("[data-ai-league-clip]");
        expect(
          unlocked?.querySelector("[data-ai-league-clip-render]"),
        ).not.toBeNull();
        expect(unlocked?.textContent).toContain("ai_league_replay.clip_render");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each([
      {
        name: "the server reports generation disabled",
        runID: "league-clip-disabled-1",
        response: () => Promise.resolve(clipCapabilitiesResponse(false)),
      },
      {
        name: "the capability request fails",
        runID: "league-clip-capability-failure-1",
        response: () => Promise.reject(new TypeError("offline")),
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
          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(fetchMock).toHaveBeenCalledWith(
            "/api/clip-capabilities",
            expect.objectContaining({ method: "GET" }),
          );
        } finally {
          vi.unstubAllGlobals();
        }
      },
    );

    it("requests a clip for the current moment and renders the Download MP4 link when ready", async () => {
      const runID = "league-clip-ready-1";
      const clipUrl = `/ai-league-runs/${runID}/clip-v1-61.mp4`;
      const requests: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url) === "/api/clip-capabilities") {
            return clipCapabilitiesResponse(true);
          }
          requests.push({
            url: String(url),
            body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
          });
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              premiereId: runID,
              bucket: 61,
              clipVersion: 1,
              state: "ready",
              ready: {
                clipUrl,
                byteLength: 96,
                sha256: "c".repeat(64),
                anchorTurn: 615,
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
        });
        frame(615);
        await vi.waitFor(() => {
          expect(
            document.querySelector("[data-ai-league-clip-render]"),
          ).not.toBeNull();
        });
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
        expect(requests[0].body).toEqual({ turn: 615 });
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
