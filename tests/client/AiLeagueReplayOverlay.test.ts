import { beforeEach, describe, expect, it } from "vitest";
import { mountAiLeagueReplayOverlay } from "../../src/client/AiLeagueReplayOverlay";
import { ReplaySpeedMultiplier } from "../../src/client/utilities/ReplaySpeedMultiplier";

describe("AiLeagueReplayOverlay", () => {
  beforeEach(() => {
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
        matchStory: {
          entertainmentScore: 74,
          grade: "promising",
          summary: "The match had expansion, builds, and diplomacy.",
          spectatorHighlights: [
            "2 build action(s) created visible economy or defense moments.",
          ],
          boringnessWarnings: ["No direct combat yet."],
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
    expect(overlay?.textContent).toContain("Proxy War Replay");
    expect(overlay?.textContent).toContain("build:Defense Post:10");
    expect(overlay?.textContent).toContain(
      "1 Proxy War agents vs 10 built-in opponents",
    );
    expect(overlay?.textContent).toContain("Recent action feed");
    expect(overlay?.textContent).toContain("chat: 1");
    expect(overlay?.textContent).toContain("Focus fire on Rival!");
    expect(overlay?.textContent).toContain("Replay speed");
    expect(overlay?.textContent).toContain("Opening neutral land: 2/2");
    expect(overlay?.textContent).toContain(
      "The spawn phase blocks attacks",
    );
    expect(overlay?.textContent).toContain("Match story: 74/100 promising");
    expect(overlay?.textContent).toContain("The match had expansion");
    expect(overlay?.textContent).toContain("No direct combat yet.");
    expect(overlay?.textContent).toContain("real Proxy War replay renderer");
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
              clientID: "client-one",
              username: "Agent One",
              displayName: "Agent One",
              x: 320,
              y: 240,
              tilesOwned: 42,
            },
          ],
        },
      }),
    );

    const mapBubble = document.querySelector<HTMLElement>(
      "#ai-league-social-map-bubbles .ai-league-map-social-bubble",
    );
    expect(mapBubble?.textContent).toContain("Focus fire on Rival!");
    expect(mapBubble?.textContent).toContain("Agent One");
    expect(mapBubble?.style.left).toBe("224px");
    expect(document.getElementById("ai-league-social-transcript")?.textContent).toContain(
      "Political radio",
    );
  });

  it("changes replay speed from the overlay slider", () => {
    const speedChanges: ReplaySpeedMultiplier[] = [];

    mountAiLeagueReplayOverlay({
      runID: "run-render-speed",
      artifactBasePath: "/ai-league-runs/run-render-speed",
      decisions: [],
      onReplaySpeedChange: (speed) => {
        speedChanges.push(speed);
      },
    });

    const slider = document.querySelector<HTMLInputElement>(
      "[data-ai-league-speed]",
    );
    const label = document.querySelector<HTMLElement>(
      "[data-ai-league-speed-label]",
    );

    expect(slider).not.toBeNull();
    expect(slider?.value).toBe("3");
    expect(label?.textContent).toBe("Max");

    slider!.value = "1";
    slider!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(label?.textContent).toBe("1x");
    expect(speedChanges).toEqual([ReplaySpeedMultiplier.normal]);
  });

  it("renders relationship matrix, readable diplomacy feed, and replay jump controls", () => {
    const jumps: number[] = [];
    document.addEventListener("ai-league-replay-jump-turn", (event) => {
      jumps.push((event as CustomEvent<{ turnNumber: number }>).detail.turnNumber);
    });

    mountAiLeagueReplayOverlay({
      runID: "politics-render",
      artifactBasePath: "/ai-league-runs/politics-render",
      decisions: [],
      spectatorTelemetry: spectatorTelemetryFixture(),
    });

    const overlay = document.getElementById("ai-league-replay-overlay");
    expect(overlay?.textContent).toContain("Politics board");
    expect(overlay?.textContent).toContain("Leader: Blitz");
    expect(overlay?.textContent).toContain("Diplomacy feed");
    expect(overlay?.textContent).toContain("pact is over");
    expect(
      overlay?.querySelectorAll("[data-spectator-relationship-cell]").length,
    ).toBeGreaterThan(0);

    const cell = overlay?.querySelector<HTMLButtonElement>(
      '[data-spectator-relationship-cell][data-from-agent="a2"][data-to-agent="a1"]',
    );
    cell?.click();
    expect(cell?.classList.contains("active")).toBe(true);
    expect(
      overlay?.querySelector("[data-spectator-filter-label]")?.textContent,
    ).toContain("Blitz -> Atlas");

    const jump = overlay?.querySelector<HTMLButtonElement>(
      "[data-ai-league-jump-turn]",
    );
    jump?.click();
    expect(jumps.length).toBeGreaterThan(0);
    expect(document.getElementById("ai-league-story-timeline")?.textContent).toContain(
      "break",
    );
  });

  it("keeps map political callouts readable by showing at most two at once", () => {
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
              clientID: "c1",
              username: "Atlas",
              displayName: "Atlas",
              x: 300,
              y: 260,
              tilesOwned: 60,
            },
            {
              playerID: "p2",
              clientID: "c2",
              username: "Blitz",
              displayName: "Blitz",
              x: 420,
              y: 280,
              tilesOwned: 90,
            },
            {
              playerID: "p3",
              clientID: "c3",
              username: "Civic",
              displayName: "Civic",
              x: 520,
              y: 300,
              tilesOwned: 20,
            },
          ],
        },
      }),
    );

    expect(
      document.querySelectorAll(
        "#ai-league-social-map-bubbles .ai-league-map-social-bubble",
      ),
    ).toHaveLength(2);
    expect(
      document.getElementById("ai-league-social-transcript")?.textContent,
    ).toContain("Political radio");
  });

  it("lets spectators move and reset the replay panel", () => {
    mountAiLeagueReplayOverlay({
      runID: "move-panel",
      artifactBasePath: "/ai-league-runs/move-panel",
      decisions: [],
    });

    const overlay = document.getElementById("ai-league-replay-overlay")!;
    const dragHandle = overlay.querySelector<HTMLElement>("[data-ai-league-drag]")!;
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

  it("adds a read-only replay banner without mutating OpenFront-owned prompt DOM", () => {
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
    expect(
      document.getElementById("ai-league-replay-mode-banner")?.textContent,
    ).toBe("Replay mode: watching Proxy War agents");
  });
});

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
      event(1, 500, "alliance_break", "betrayal", "a2", "Blitz", "a1", "Atlas", "Blitz says the pact is over."),
      event(2, 505, "chat", "pact", "a1", "Atlas", "a2", "Blitz", "Atlas asks for a quiet border."),
      event(3, 506, "target_call", "threat", "a3", "Civic", "a2", "Blitz", "Civic calls for pressure on Blitz."),
    ],
    communicationThreads: [
      {
        id: "a1:a2",
        agentIDs: ["a1", "a2"],
        title: "a1 ↔ a2",
        latestTurn: 505,
        tone: "betrayal",
        messages: [
          event(1, 500, "alliance_break", "betrayal", "a2", "Blitz", "a1", "Atlas", "Blitz says the pact is over."),
          event(2, 505, "chat", "pact", "a1", "Atlas", "a2", "Blitz", "Atlas asks for a quiet border."),
        ],
      },
      {
        id: "a2:a3",
        agentIDs: ["a2", "a3"],
        title: "a2 ↔ a3",
        latestTurn: 506,
        tone: "threat",
        messages: [
          event(3, 506, "target_call", "threat", "a3", "Civic", "a2", "Blitz", "Civic calls for pressure on Blitz."),
        ],
      },
    ],
    timelineBuckets: [
      {
        startTurn: 0,
        endTurn: 999,
        events: [
          event(1, 500, "alliance_break", "betrayal", "a2", "Blitz", "a1", "Atlas", "Blitz says the pact is over."),
          event(3, 506, "target_call", "threat", "a3", "Civic", "a2", "Blitz", "Civic calls for pressure on Blitz."),
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
