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
  type CompetitorRailEntry,
  type CuratedWarRoomEvent,
  type TimelineMarker,
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
