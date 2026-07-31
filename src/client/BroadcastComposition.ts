import { translateText } from "./Utils";

/**
 * Shared, pure, presentation-only structural components for the Stage 4
 * broadcast composition (product overhaul spec Stage 4 item 1: left
 * competitor rail, right War Room event feed, bottom timeline). "Restructure,
 * don't restart" — these are new REGIONS wired into the EXISTING
 * `AiLeagueReplayOverlay.ts` (Full Replay) and `ReplayPremiereOverlay.ts`
 * (Premiere), not a replacement for either.
 *
 * Deliberately STYLE-FREE: every element here gets a plain, semantic,
 * `broadcast-*`-prefixed class name and NOTHING else — no inline styles, no
 * design tokens baked in. Each overlay defines the actual CSS rules for
 * these class names inside its OWN existing `createStyle()` function, using
 * its OWN existing token prefix (`--pw-*` for AiLeagueReplayOverlay.ts,
 * `--rp-*` for ReplayPremiereOverlay.ts) — exactly like every other region
 * in both files already works. This file only ever builds DOM structure
 * from already-fully-derived, already-spoiler-safe input data; it never
 * fetches, filters, or judges what's safe to show — that is the caller's
 * job (see each derivation module's own doc for the premiere-vs-full-replay
 * spoiler-safety boundary).
 *
 * Data-in only: nothing here reads `AgentSpectatorTelemetry`/frame-state/
 * identity-registry types directly. Every field on every entry type below
 * is already resolved, already bounded (or not, for Full Replay), by the
 * caller before it reaches this module.
 */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className !== "") result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

// ---------------------------------------------------------------------------
// Left competitor rail
// ---------------------------------------------------------------------------

/**
 * One agent's rail row. Every field is independently optional/nullable —
 * render gracefully degrades per-field (never fabricates a value, never
 * hides the whole row because one field is unknown). `allies`/`wars` are
 * OTHER entries' `playerName`s (matched by the caller against this same
 * roster) — "where telemetry already supplies them" (spec wording): an
 * empty array means "none known", not "definitely none".
 */
export interface CompetitorRailEntry {
  playerName: string;
  displayName: string;
  agentSlug: string | null;
  emblemSvg: string | null;
  primaryColor: string | null;
  versionLabel: string | null;
  builderDisplayName: string | null;
  /** 0-100, or null when not derivable (e.g. no frame-state connected yet). */
  territoryPercent: number | null;
  /** 1-based, or null when not derivable. */
  inMatchRank: number | null;
  alive: boolean | null;
  allies: readonly string[];
  wars: readonly string[];
  /** Count of fallback/degraded decisions so far, or null when not tracked for this context. */
  degradedDecisionCount: number | null;
}

export function renderCompetitorRail(
  entries: readonly CompetitorRailEntry[],
): HTMLElement {
  const aside = element("aside", "broadcast-rail");
  aside.setAttribute("aria-label", translateText("broadcast.rail_heading"));
  const heading = element(
    "h3",
    "broadcast-rail-heading",
    translateText("broadcast.rail_heading"),
  );
  aside.append(heading);
  const list = element("ol", "broadcast-rail-list");
  list.setAttribute("role", "list");
  if (entries.length === 0) {
    list.append(
      element(
        "li",
        "broadcast-rail-empty",
        translateText("broadcast.rail_empty"),
      ),
    );
  }
  for (const entry of entries) {
    list.append(renderCompetitorRailEntry(entry));
  }
  aside.append(list);
  return aside;
}

function renderCompetitorRailEntry(entry: CompetitorRailEntry): HTMLElement {
  const item = element("li", "broadcast-rail-entry");
  item.dataset.alive =
    entry.alive === null ? "unknown" : entry.alive ? "true" : "false";
  if (entry.primaryColor !== null) {
    item.style.setProperty("--broadcast-agent-color", entry.primaryColor);
  }

  const identityRow = element("div", "broadcast-rail-identity");
  if (entry.emblemSvg !== null) {
    const emblem = element("span", "broadcast-rail-emblem");
    emblem.innerHTML = entry.emblemSvg;
    emblem.setAttribute("aria-hidden", "true");
    identityRow.append(emblem);
  } else {
    const placeholder = element("span", "broadcast-rail-emblem-placeholder", "?");
    placeholder.setAttribute("aria-hidden", "true");
    identityRow.append(placeholder);
  }
  const nameBlock = element("div", "broadcast-rail-name-block");
  nameBlock.append(
    element("span", "broadcast-rail-name", entry.displayName),
  );
  if (entry.versionLabel !== null) {
    nameBlock.append(
      element("span", "broadcast-rail-version", entry.versionLabel),
    );
  }
  if (entry.builderDisplayName !== null) {
    nameBlock.append(
      element(
        "span",
        "broadcast-rail-builder",
        translateText("broadcast.rail_builder", {
          name: entry.builderDisplayName,
        }),
      ),
    );
  }
  identityRow.append(nameBlock);
  item.append(identityRow);

  const statsRow = element("div", "broadcast-rail-stats");
  if (entry.territoryPercent !== null) {
    statsRow.append(
      element(
        "span",
        "broadcast-rail-territory",
        translateText("broadcast.rail_territory", {
          percent: Math.round(entry.territoryPercent),
        }),
      ),
    );
  }
  if (entry.inMatchRank !== null) {
    statsRow.append(
      element(
        "span",
        "broadcast-rail-rank",
        translateText("broadcast.rail_rank", { rank: entry.inMatchRank }),
      ),
    );
  }
  if (entry.alive === false) {
    statsRow.append(
      element(
        "span",
        "broadcast-rail-eliminated",
        translateText("broadcast.rail_eliminated"),
      ),
    );
  }
  if (entry.degradedDecisionCount !== null && entry.degradedDecisionCount > 0) {
    statsRow.append(
      element(
        "span",
        "broadcast-rail-degraded",
        translateText("broadcast.rail_degraded", {
          count: entry.degradedDecisionCount,
        }),
      ),
    );
  }
  item.append(statsRow);

  if (entry.allies.length > 0 || entry.wars.length > 0) {
    const relations = element("div", "broadcast-rail-relations");
    if (entry.allies.length > 0) {
      relations.append(
        element(
          "span",
          "broadcast-rail-allies",
          translateText("broadcast.rail_allies", {
            names: entry.allies.join(", "),
          }),
        ),
      );
    }
    if (entry.wars.length > 0) {
      relations.append(
        element(
          "span",
          "broadcast-rail-wars",
          translateText("broadcast.rail_wars", {
            names: entry.wars.join(", "),
          }),
        ),
      );
    }
    item.append(relations);
  }

  return item;
}

// ---------------------------------------------------------------------------
// Right War Room — curated event feed
// ---------------------------------------------------------------------------

export type CuratedWarRoomEventKind =
  | "alliance"
  | "first_strike"
  | "betrayal"
  | "elimination"
  | "plan_change";

/**
 * Monochrome Unicode symbols only (visual direction: no emojis) — matches
 * `ReplayPremiereOverlay.ts`'s own existing `WAR_EVENT_GLYPHS` convention
 * (`⚔`/`†`/`☢`/`✕`) for the kinds that overlap; new kinds here pick from
 * the same dingbat/symbol block rather than emoji-presentation characters.
 */
const WAR_ROOM_GLYPHS: Record<CuratedWarRoomEventKind, string> = {
  alliance: "\u26AD", // ⚭ marriage/union symbol
  first_strike: "\u2192", // → arrow
  betrayal: "\u2020", // † dagger
  elimination: "\u2715", // ✕ multiplication x
  plan_change: "\u21BB", // ↻ clockwise open arrow
};

/**
 * One curated headline, already resolved to a public-safe presentation.
 * `publicReason` is explicitly labeled "the agent's stated reason" wherever
 * rendered (spec item 4: never presented as verified reasoning) — this
 * component enforces that by construction: it never renders `publicReason`
 * without the label wrapping it.
 */
export interface CuratedWarRoomEvent {
  id: string;
  kind: CuratedWarRoomEventKind;
  turn: number;
  sequence: number;
  headline: string;
  publicReason: string | null;
  participants: readonly string[];
  /** Extra detail shown only once the row is expanded. Null when there is nothing beyond the headline. */
  expandedDetail: string | null;
}

export interface WarRoomFeedCallbacks {
  onJumpToTurn?: (turn: number, sequence: number) => void;
}

export function renderWarRoomFeed(
  events: readonly CuratedWarRoomEvent[],
  callbacks: WarRoomFeedCallbacks = {},
): HTMLElement {
  const section = element("section", "broadcast-war-room");
  section.append(
    element(
      "h3",
      "broadcast-war-room-heading",
      translateText("broadcast.war_room_heading"),
    ),
  );
  const list = element("ol", "broadcast-war-room-list");
  list.setAttribute("role", "list");
  if (events.length === 0) {
    list.append(
      element(
        "li",
        "broadcast-war-room-empty",
        translateText("broadcast.war_room_empty"),
      ),
    );
  }
  for (const event of events) {
    list.append(renderWarRoomEvent(event, callbacks));
  }
  section.append(list);
  return section;
}

function renderWarRoomEvent(
  event: CuratedWarRoomEvent,
  callbacks: WarRoomFeedCallbacks,
): HTMLElement {
  const item = element("li", "broadcast-war-room-item");
  item.dataset.kind = event.kind;
  const summary = element("button", "broadcast-war-room-summary");
  summary.type = "button";
  const expanded =
    event.expandedDetail !== null || event.publicReason !== null;
  summary.setAttribute("aria-expanded", "false");
  const glyph = element(
    "span",
    "broadcast-war-room-glyph",
    WAR_ROOM_GLYPHS[event.kind] ?? "\u2022",
  );
  glyph.setAttribute("aria-hidden", "true");
  summary.append(
    glyph,
    element(
      "span",
      "broadcast-war-room-kind",
      translateText(`broadcast.war_room_kind_${event.kind}`),
    ),
    element("span", "broadcast-war-room-headline", event.headline),
    element(
      "span",
      "broadcast-war-room-turn",
      translateText("broadcast.war_room_turn", { turn: event.turn }),
    ),
  );
  item.append(summary);

  if (expanded) {
    const detail = element("div", "broadcast-war-room-detail");
    detail.hidden = true;
    if (event.publicReason !== null) {
      detail.append(
        element(
          "p",
          "broadcast-war-room-reason",
          translateText("broadcast.war_room_stated_reason", {
            reason: event.publicReason,
          }),
        ),
      );
    }
    if (event.expandedDetail !== null) {
      detail.append(
        element("p", "broadcast-war-room-extra", event.expandedDetail),
      );
    }
    if (callbacks.onJumpToTurn !== undefined) {
      const jumpButton = element(
        "button",
        "broadcast-war-room-jump",
        translateText("broadcast.war_room_jump_to_turn", {
          turn: event.turn,
        }),
      ) as HTMLButtonElement;
      jumpButton.type = "button";
      jumpButton.addEventListener("click", (domEvent) => {
        domEvent.stopPropagation();
        callbacks.onJumpToTurn?.(event.turn, event.sequence);
      });
      detail.append(jumpButton);
    }
    summary.addEventListener("click", () => {
      const nowHidden = !detail.hidden;
      detail.hidden = nowHidden;
      summary.setAttribute("aria-expanded", nowHidden ? "false" : "true");
    });
    item.append(detail);
  }

  return item;
}

// ---------------------------------------------------------------------------
// Bottom timeline
// ---------------------------------------------------------------------------

export type TimelineMarkerKind =
  | "spawn"
  | "alliance"
  | "first_strike"
  | "lead_change"
  | "betrayal"
  | "nuke"
  | "elimination"
  | "finish";

export interface TimelineMarker {
  kind: TimelineMarkerKind;
  turn: number;
  sequence: number;
  label: string;
}

export interface MatchTimelineOptions {
  /** Total turn span the timeline represents (the finish turn for a completed/Full-Replay match, or the currently-known turn ceiling for a live premiere). */
  totalTurns: number;
  /**
   * Highest turn a click/seek may target. `null` means unrestricted (Full
   * Replay). A live premiere passes the current released-chunks boundary —
   * "never navigable past the live edge during a Premiere" (spec item 2) —
   * and this component enforces it by construction: `onSeek` is simply
   * never invoked for a turn beyond this value, no matter what the caller
   * wires up.
   */
  maxSeekableTurn: number | null;
  onSeek?: (turn: number) => void;
}

export function renderMatchTimeline(
  markers: readonly TimelineMarker[],
  options: MatchTimelineOptions,
): HTMLElement {
  const section = element("section", "broadcast-timeline");
  section.setAttribute(
    "aria-label",
    translateText("broadcast.timeline_heading"),
  );
  const track = element("div", "broadcast-timeline-track");
  track.setAttribute("role", "list");
  const totalTurns = Math.max(1, options.totalTurns);
  for (const marker of markers) {
    const positionPercent = Math.min(
      100,
      Math.max(0, (marker.turn / totalTurns) * 100),
    );
    const seekable =
      options.maxSeekableTurn === null ||
      marker.turn <= options.maxSeekableTurn;
    const markerElement = seekable
      ? (element("button", "broadcast-timeline-marker") as HTMLButtonElement)
      : element("span", "broadcast-timeline-marker");
    markerElement.dataset.kind = marker.kind;
    markerElement.dataset.seekable = String(seekable);
    markerElement.style.setProperty(
      "--broadcast-timeline-position",
      `${positionPercent}%`,
    );
    markerElement.title = marker.label;
    markerElement.setAttribute("aria-label", marker.label);
    if (seekable && markerElement instanceof HTMLButtonElement) {
      markerElement.type = "button";
      markerElement.addEventListener("click", () => {
        options.onSeek?.(marker.turn);
      });
    }
    track.append(markerElement);
  }
  section.append(track);
  return section;
}
