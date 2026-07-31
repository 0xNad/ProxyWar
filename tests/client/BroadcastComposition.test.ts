vi.mock("../../src/client/Utils", () => ({
  translateText: (
    key: string,
    params?: Record<string, string | number>,
  ): string => {
    if (params === undefined) return key;
    return `${key}:${Object.entries(params)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(",")}`;
  },
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderCompetitorRail,
  renderMatchTimeline,
  renderWarRoomFeed,
  renderBroadcastDrawer,
  renderAnalystPanel,
  LowerThirdController,
  type CompetitorRailEntry,
  type CuratedWarRoomEvent,
  type TimelineMarker,
  type BroadcastDrawerTab,
  type LowerThirdEvent,
  type AnalystPanelData,
} from "../../src/client/BroadcastComposition";

afterEach(() => {
  document.body.innerHTML = "";
});

function railEntry(overrides: Partial<CompetitorRailEntry> = {}): CompetitorRailEntry {
  return {
    playerName: "Auri",
    displayName: "Auri",
    agentSlug: "auri",
    emblemSvg: null,
    primaryColor: null,
    versionLabel: null,
    builderDisplayName: null,
    territoryPercent: null,
    inMatchRank: null,
    alive: null,
    allies: [],
    wars: [],
    degradedDecisionCount: null,
    followed: false,
    ...overrides,
  };
}

describe("renderCompetitorRail", () => {
  it("renders an honest empty state with no fabricated rows", () => {
    const rail = renderCompetitorRail([]);
    document.body.append(rail);
    expect(rail.textContent).toContain("broadcast.rail_empty");
    expect(rail.querySelectorAll(".broadcast-rail-entry")).toHaveLength(0);
  });

  it("renders every field when fully populated", () => {
    const rail = renderCompetitorRail([
      railEntry({
        displayName: "Auri",
        emblemSvg: "<svg></svg>",
        versionLabel: "v24",
        builderDisplayName: "Daveey",
        territoryPercent: 42.6,
        inMatchRank: 1,
        alive: true,
        allies: ["Beta"],
        wars: ["Gamma"],
        degradedDecisionCount: 3,
      }),
    ]);
    document.body.append(rail);
    const entry = rail.querySelector(".broadcast-rail-entry");
    expect(entry).not.toBeNull();
    expect(rail.textContent).toContain("Auri");
    expect(rail.textContent).toContain("v24");
    expect(rail.textContent).toContain("broadcast.rail_builder:name=Daveey");
    expect(rail.textContent).toContain("broadcast.rail_territory:percent=43");
    expect(rail.textContent).toContain("broadcast.rail_rank:rank=1");
    expect(rail.textContent).toContain("broadcast.rail_allies:names=Beta");
    expect(rail.textContent).toContain("broadcast.rail_wars:names=Gamma");
    expect(rail.textContent).not.toContain("broadcast.rail_eliminated");
    expect(entry?.querySelector(".broadcast-rail-emblem")).not.toBeNull();
    expect(
      entry?.querySelector(".broadcast-rail-emblem-placeholder"),
    ).toBeNull();
  });

  it("degrades every field independently when unknown — never hides the whole row", () => {
    const rail = renderCompetitorRail([railEntry()]);
    document.body.append(rail);
    const entry = rail.querySelector(".broadcast-rail-entry");
    expect(entry).not.toBeNull();
    expect(entry?.getAttribute("data-alive")).toBe("unknown");
    expect(entry?.querySelector(".broadcast-rail-emblem-placeholder")).not.toBeNull();
    expect(rail.textContent).not.toContain("broadcast.rail_territory");
    expect(rail.textContent).not.toContain("broadcast.rail_rank");
    expect(rail.textContent).not.toContain("broadcast.rail_allies");
    expect(rail.textContent).not.toContain("broadcast.rail_wars");
  });

  it("shows an explicit eliminated marker only when alive is exactly false, never for unknown", () => {
    const rail = renderCompetitorRail([
      railEntry({ alive: false }),
      railEntry({ playerName: "Beta", alive: null }),
    ]);
    document.body.append(rail);
    const entries = rail.querySelectorAll(".broadcast-rail-entry");
    expect(entries[0].getAttribute("data-alive")).toBe("false");
    expect(entries[0].textContent).toContain("broadcast.rail_eliminated");
    expect(entries[1].getAttribute("data-alive")).toBe("unknown");
    expect(entries[1].textContent).not.toContain("broadcast.rail_eliminated");
  });

  it("shows degraded-decision count only when it is a positive number", () => {
    const rail = renderCompetitorRail([
      railEntry({ degradedDecisionCount: 0 }),
      railEntry({ playerName: "Beta", degradedDecisionCount: null }),
    ]);
    document.body.append(rail);
    expect(rail.textContent).not.toContain("broadcast.rail_degraded");
  });

  it("renders a non-interactive rail (no button, no onSelect wiring) when no callbacks are given — camera follow is opt-in infrastructure, never forced", () => {
    const rail = renderCompetitorRail([railEntry()]);
    document.body.append(rail);
    expect(rail.querySelector("button.broadcast-rail-select")).toBeNull();
    expect(rail.querySelector("div.broadcast-rail-select")).not.toBeNull();
  });

  it("clicking a rail seat invokes onSelect with that seat's playerName — camera-follow discoverability (spec item 6)", () => {
    const onSelect = vi.fn();
    const rail = renderCompetitorRail(
      [railEntry({ playerName: "auri-internal", displayName: "Auri" })],
      { onSelect },
    );
    document.body.append(rail);
    const button = rail.querySelector(
      "button.broadcast-rail-select",
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    expect(onSelect).toHaveBeenCalledWith("auri-internal");
  });

  it("marks the followed seat via data-followed and aria-pressed, distinct from every other seat", () => {
    const onSelect = vi.fn();
    const rail = renderCompetitorRail(
      [
        railEntry({ playerName: "Auri", followed: true }),
        railEntry({ playerName: "Beta", followed: false }),
      ],
      { onSelect },
    );
    document.body.append(rail);
    const entries = rail.querySelectorAll(".broadcast-rail-entry");
    expect((entries[0] as HTMLElement).dataset.followed).toBe("true");
    expect((entries[1] as HTMLElement).dataset.followed).toBe("false");
    const followedButton = entries[0].querySelector(
      "button.broadcast-rail-select",
    ) as HTMLButtonElement;
    expect(followedButton.getAttribute("aria-pressed")).toBe("true");
  });
});

function warRoomEvent(
  overrides: Partial<CuratedWarRoomEvent> = {},
): CuratedWarRoomEvent {
  return {
    id: "evt1",
    kind: "alliance",
    turn: 120,
    sequence: 500,
    headline: "Auri and Beta form an alliance",
    publicReason: null,
    participants: ["Auri", "Beta"],
    expandedDetail: null,
    ...overrides,
  };
}

describe("renderWarRoomFeed", () => {
  it("renders an honest empty state", () => {
    const feed = renderWarRoomFeed([]);
    document.body.append(feed);
    expect(feed.textContent).toContain("broadcast.war_room_empty");
  });

  it("renders a headline row for each curated event, collapsed by default", () => {
    const feed = renderWarRoomFeed([
      warRoomEvent({ expandedDetail: "extra context" }),
      warRoomEvent({ id: "evt2", kind: "betrayal" }),
    ]);
    document.body.append(feed);
    const items = feed.querySelectorAll(".broadcast-war-room-item");
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-kind")).toBe("alliance");
    expect(items[1].getAttribute("data-kind")).toBe("betrayal");
    const detail = items[0].querySelector(".broadcast-war-room-detail") as HTMLElement | null;
    expect(detail?.hidden).toBe(true);
  });

  it("labels a public reason as the agent's STATED reason, never raw or unverified", () => {
    const feed = renderWarRoomFeed([
      warRoomEvent({ publicReason: "border pressure from Gamma" }),
    ]);
    document.body.append(feed);
    expect(feed.textContent).toContain(
      "broadcast.war_room_stated_reason:reason=border pressure from Gamma",
    );
  });

  it("expands on click, revealing the jump-to-turn control only when onJumpToTurn is wired", () => {
    const onJumpToTurn = vi.fn();
    const feed = renderWarRoomFeed(
      [warRoomEvent({ expandedDetail: "extra context" })],
      { onJumpToTurn },
    );
    document.body.append(feed);
    const summary = feed.querySelector(".broadcast-war-room-summary") as HTMLButtonElement;
    const detail = feed.querySelector(".broadcast-war-room-detail") as HTMLElement;
    expect(detail.hidden).toBe(true);
    summary.click();
    expect(detail.hidden).toBe(false);
    expect(summary.getAttribute("aria-expanded")).toBe("true");

    const jumpButton = feed.querySelector(".broadcast-war-room-jump") as HTMLButtonElement;
    expect(jumpButton).not.toBeNull();
    jumpButton.click();
    expect(onJumpToTurn).toHaveBeenCalledWith(120, 500);
  });

  it("never renders an expand affordance when there is nothing beyond the headline", () => {
    const feed = renderWarRoomFeed([
      warRoomEvent({ publicReason: null, expandedDetail: null }),
    ]);
    document.body.append(feed);
    expect(feed.querySelector(".broadcast-war-room-detail")).toBeNull();
  });
});

function marker(overrides: Partial<TimelineMarker> = {}): TimelineMarker {
  return { kind: "elimination", turn: 100, sequence: 400, label: "Beta eliminated", ...overrides };
}

describe("renderMatchTimeline", () => {
  it("renders one marker element per input marker, positioned proportionally", () => {
    const timeline = renderMatchTimeline(
      [marker({ turn: 50 }), marker({ turn: 100 })],
      { totalTurns: 200, maxSeekableTurn: null },
    );
    document.body.append(timeline);
    const markers = timeline.querySelectorAll(".broadcast-timeline-marker");
    expect(markers).toHaveLength(2);
    expect((markers[0] as HTMLElement).style.getPropertyValue("--broadcast-timeline-position")).toBe("25%");
    expect((markers[1] as HTMLElement).style.getPropertyValue("--broadcast-timeline-position")).toBe("50%");
  });

  it("renders every marker as a clickable button when maxSeekableTurn is null (Full Replay — unrestricted)", () => {
    const onSeek = vi.fn();
    const timeline = renderMatchTimeline([marker({ turn: 50 })], {
      totalTurns: 200,
      maxSeekableTurn: null,
      onSeek,
    });
    document.body.append(timeline);
    const el = timeline.querySelector(".broadcast-timeline-marker") as HTMLButtonElement;
    expect(el.tagName).toBe("BUTTON");
    expect(el.dataset.seekable).toBe("true");
    el.click();
    expect(onSeek).toHaveBeenCalledWith(50);
  });

  it("never makes a marker beyond maxSeekableTurn clickable — enforced by construction, not by trusting the caller (Premiere: never navigable past the live edge)", () => {
    const onSeek = vi.fn();
    const timeline = renderMatchTimeline(
      [marker({ turn: 50 }), marker({ turn: 150 })],
      { totalTurns: 200, maxSeekableTurn: 100, onSeek },
    );
    document.body.append(timeline);
    const markers = timeline.querySelectorAll(".broadcast-timeline-marker");
    expect(markers[0].tagName).toBe("BUTTON");
    expect((markers[0] as HTMLElement).dataset.seekable).toBe("true");
    expect(markers[1].tagName).toBe("SPAN");
    expect((markers[1] as HTMLElement).dataset.seekable).toBe("false");
    // A SPAN has no click handler wired at all — clicking it cannot invoke onSeek.
    (markers[1] as HTMLElement).click();
    expect(onSeek).not.toHaveBeenCalled();
  });
});

function lowerThirdEvent(overrides: Partial<LowerThirdEvent> = {}): LowerThirdEvent {
  return { id: "evt1", kind: "alliance", headline: "Auri and Beta form an alliance", ...overrides };
}

describe("LowerThirdController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the first announced event immediately", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const controller = new LowerThirdController(host, { reducedMotion: false });
    controller.sync([lowerThirdEvent()]);
    const card = host.querySelector(".broadcast-lower-third");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-kind")).toBe("alliance");
    expect(host.textContent).toContain("Auri and Beta form an alliance");
    controller.dispose();
  });

  it("shows only ONE lower third at a time and auto-dismisses after displayMs, then advances to the next queued event", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const controller = new LowerThirdController(host, {
      displayMs: 1000,
      reducedMotion: false,
    });
    controller.sync([
      lowerThirdEvent({ id: "evt1", headline: "First event" }),
      lowerThirdEvent({ id: "evt2", headline: "Second event" }),
    ]);
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(1);
    expect(host.textContent).toContain("First event");
    expect(host.textContent).not.toContain("Second event");

    vi.advanceTimersByTime(999);
    expect(host.textContent).toContain("First event");

    vi.advanceTimersByTime(1);
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(1);
    expect(host.textContent).not.toContain("First event");
    expect(host.textContent).toContain("Second event");
    controller.dispose();
  });

  it("never re-announces the same event id across repeated sync() calls (idempotent re-hydrate safety)", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const controller = new LowerThirdController(host, {
      displayMs: 1000,
      reducedMotion: false,
    });
    controller.sync([lowerThirdEvent({ id: "evt1", headline: "First event" })]);
    vi.advanceTimersByTime(1000);
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(0);
    // The SAME event id re-appears in the caller's full list on every
    // re-hydrate (both overlays re-render every frame) — it must never
    // pulse a second time.
    controller.sync([lowerThirdEvent({ id: "evt1", headline: "First event" })]);
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(0);
    controller.dispose();
  });

  it("respects prefers-reduced-motion via a data attribute, without changing the auto-dismiss timing", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const controller = new LowerThirdController(host, {
      displayMs: 500,
      reducedMotion: true,
    });
    controller.sync([lowerThirdEvent()]);
    const card = host.querySelector(".broadcast-lower-third") as HTMLElement;
    expect(card.dataset.reducedMotion).toBe("true");
    vi.advanceTimersByTime(500);
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(0);
    controller.dispose();
  });

  it("dispose() clears the pending timer and empties the host — a disposed controller never shows anything again", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const controller = new LowerThirdController(host, {
      displayMs: 1000,
      reducedMotion: false,
    });
    controller.sync([lowerThirdEvent()]);
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(1);
    controller.dispose();
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(0);
    controller.sync([lowerThirdEvent({ id: "evt2" })]);
    vi.advanceTimersByTime(2000);
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(0);
  });

  it("never stacks: a burst of many new events in one sync() call still shows exactly one at a time", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const controller = new LowerThirdController(host, {
      displayMs: 1000,
      reducedMotion: false,
    });
    controller.sync([
      lowerThirdEvent({ id: "evt1" }),
      lowerThirdEvent({ id: "evt2" }),
      lowerThirdEvent({ id: "evt3" }),
      lowerThirdEvent({ id: "evt4" }),
    ]);
    for (let step = 0; step < 4; step++) {
      expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(1);
      vi.advanceTimersByTime(1000);
    }
    expect(host.querySelectorAll(".broadcast-lower-third")).toHaveLength(0);
    controller.dispose();
  });
});

function drawerTab(
  id: BroadcastDrawerTab["id"],
  text: string,
): BroadcastDrawerTab {
  const content = document.createElement("div");
  content.textContent = text;
  return { id, content };
}

describe("renderBroadcastDrawer", () => {
  it("keeps every tab's panel present in the DOM (desktop shows all; CSS alone hides inactive ones at narrow widths)", () => {
    const drawer = renderBroadcastDrawer(
      [
        drawerTab("agents", "Agents content"),
        drawerTab("events", "Events content"),
        drawerTab("timeline", "Timeline content"),
        drawerTab("analysis", "Analysis content"),
      ],
      { activeTab: "agents" },
    );
    document.body.append(drawer);
    expect(drawer.querySelectorAll(".broadcast-drawer-panel")).toHaveLength(4);
    expect(drawer.textContent).toContain("Agents content");
    expect(drawer.textContent).toContain("Analysis content");
  });

  it("marks exactly one panel data-tab-active=true — the active tab — and the rest false", () => {
    const drawer = renderBroadcastDrawer(
      [drawerTab("agents", "A"), drawerTab("events", "B")],
      { activeTab: "events" },
    );
    document.body.append(drawer);
    const agents = drawer.querySelector('.broadcast-drawer-panel[data-tab-id="agents"]') as HTMLElement;
    const events = drawer.querySelector('[data-tab-id="events"].broadcast-drawer-panel') as HTMLElement;
    expect(agents.dataset.tabActive).toBe("false");
    expect(events.dataset.tabActive).toBe("true");
  });

  it("clicking a tab button invokes onTabChange with that tab's id — the caller re-renders with the new activeTab", () => {
    const onTabChange = vi.fn();
    const drawer = renderBroadcastDrawer(
      [drawerTab("agents", "A"), drawerTab("timeline", "C")],
      { activeTab: "agents", onTabChange },
    );
    document.body.append(drawer);
    const timelineButton = drawer.querySelector(
      'button[data-tab-id="timeline"]',
    ) as HTMLButtonElement;
    timelineButton.click();
    expect(onTabChange).toHaveBeenCalledWith("timeline");
  });

  it("sets aria-selected only on the active tab button, matching data-tab-active", () => {
    const drawer = renderBroadcastDrawer(
      [drawerTab("agents", "A"), drawerTab("events", "B")],
      { activeTab: "agents" },
    );
    document.body.append(drawer);
    const agentsButton = drawer.querySelector('button[data-tab-id="agents"]');
    const eventsButton = drawer.querySelector('button[data-tab-id="events"]');
    expect(agentsButton?.getAttribute("aria-selected")).toBe("true");
    expect(eventsButton?.getAttribute("aria-selected")).toBe("false");
  });

  it("shows a badge only when badgeCount is a positive number", () => {
    const drawer = renderBroadcastDrawer(
      [
        { ...drawerTab("events", "B"), badgeCount: 3 },
        { ...drawerTab("agents", "A"), badgeCount: 0 },
        { ...drawerTab("timeline", "C"), badgeCount: null },
      ],
      { activeTab: "agents" },
    );
    document.body.append(drawer);
    expect(
      drawer.querySelector('button[data-tab-id="events"] .broadcast-drawer-tab-badge')
        ?.textContent,
    ).toBe("3");
    expect(
      drawer.querySelector('button[data-tab-id="agents"] .broadcast-drawer-tab-badge'),
    ).toBeNull();
    expect(
      drawer.querySelector('button[data-tab-id="timeline"] .broadcast-drawer-tab-badge'),
    ).toBeNull();
  });
});

function analystData(overrides: Partial<AnalystPanelData> = {}): AnalystPanelData {
  return {
    decisions: [],
    decisionsUnavailableReason: null,
    events: [],
    actionKindCounts: [],
    ...overrides,
  };
}

describe("renderAnalystPanel", () => {
  it("renders every already-public decision field the curated view leaves out", () => {
    const panel = renderAnalystPanel(
      analystData({
        decisions: [
          {
            sequence: 10,
            turnNumber: 40,
            playerName: "Auri",
            brainType: "llm",
            selectedActionKind: "attack",
            selectedLegalActionId: "attack:beta:25",
            reason: "pressing the border",
            planObjective: "expand east",
            decisionLatencyMs: 812,
            fallbackUsed: false,
            accepted: true,
            auditStatus: "confirmed",
          },
        ],
      }),
    );
    document.body.append(panel);
    expect(panel.textContent).toContain("Auri");
    expect(panel.textContent).toContain("llm");
    expect(panel.textContent).toContain("attack");
    expect(panel.textContent).toContain("confirmed");
    expect(panel.textContent).toContain("pressing the border");
    expect(panel.textContent).toContain("broadcast.analyst_latency_ms:ms=812");
    const row = panel.querySelector(".broadcast-analyst-decisions-row") as HTMLElement;
    expect(row.dataset.fallbackUsed).toBe("false");
    expect(row.dataset.accepted).toBe("true");
  });

  it("shows the premiere_sealed unavailable message instead of an empty table, and never renders a decisions table in that state", () => {
    const panel = renderAnalystPanel(
      analystData({ decisions: null, decisionsUnavailableReason: "premiere_sealed" }),
    );
    document.body.append(panel);
    expect(panel.textContent).toContain("broadcast.analyst_unavailable_premiere_sealed");
    expect(panel.querySelector(".broadcast-analyst-decisions-table")).toBeNull();
  });

  it("renders the full unfiltered public event log, including fields the curated War Room omits", () => {
    const panel = renderAnalystPanel(
      analystData({
        events: [
          {
            sequence: 1,
            turnNumber: 5,
            kind: "trade",
            tone: "trade",
            actorName: "Auri",
            targetName: "Beta",
            secondaryName: "Gamma",
            message: "proposed a trade",
          },
        ],
      }),
    );
    document.body.append(panel);
    const row = panel.querySelector(".broadcast-analyst-events-row") as HTMLElement;
    expect(row.dataset.kind).toBe("trade");
    expect(row.textContent).toContain("Gamma");
    expect(row.textContent).toContain("proposed a trade");
  });

  it("renders a cheap bar chart of action-kind counts only when counts are non-empty", () => {
    const withCounts = renderAnalystPanel(
      analystData({ actionKindCounts: [{ kind: "attack", count: 12 }] }),
    );
    document.body.append(withCounts);
    const bar = withCounts.querySelector(".broadcast-analyst-chart-bar") as HTMLElement;
    expect(bar.style.getPropertyValue("--broadcast-chart-fraction")).toBe("1");
    expect(withCounts.textContent).toContain("12");

    const withoutCounts = renderAnalystPanel(analystData());
    expect(withoutCounts.querySelector(".broadcast-analyst-chart")).toBeNull();
  });

  it("never mixes premiere_sealed unavailability with the event log — the full event log stays available even when decisions are sealed", () => {
    const panel = renderAnalystPanel(
      analystData({
        decisions: null,
        decisionsUnavailableReason: "premiere_sealed",
        events: [
          {
            sequence: 1,
            turnNumber: 5,
            kind: "attack",
            tone: "threat",
            actorName: "Auri",
            targetName: "Beta",
            secondaryName: null,
            message: "attacks Beta",
          },
        ],
      }),
    );
    document.body.append(panel);
    expect(panel.textContent).toContain("broadcast.analyst_unavailable_premiere_sealed");
    expect(panel.textContent).toContain("attacks Beta");
  });
});
