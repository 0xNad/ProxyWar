import { ReplaySpeedMultiplier } from "./utilities/ReplaySpeedMultiplier";
import {
  aiLeagueSpectatorDisplayName,
  aiLeagueSpectatorText,
  isAiLeagueNativeSpectatorUiEnabled,
} from "./AiLeagueReplayMode";

interface AiLeagueDecisionLogEntry {
  sequence: number;
  turnNumber: number;
  username: string;
  profile: string;
  brainType: string;
  selectedActionKind: string;
  selectedLegalActionId: string;
  batchActionIDs?: string[];
  legalActionIDsByKind?: Record<string, string[]>;
  selectedActionMetadata?: Record<string, unknown>;
  socialText?: string;
  socialTargetName?: string;
  reason: string;
  decisionLatencyMs: number;
  fallbackUsed: boolean;
  parseSuccess?: boolean;
  result: {
    accepted: boolean;
    reason: string;
  };
  auditStatus?: string;
  generatedIntent?: unknown;
}

interface AiLeagueReplayFrameEventDetail {
  tick: number;
  turnNumber: number;
  players: Array<{
    playerID: string;
    clientID: string | null;
    username: string;
    displayName: string;
    x: number;
    y: number;
    tilesOwned: number;
  }>;
}

interface AiLeagueSpectatorAgent {
  agentID: string;
  playerID: string | null;
  username: string;
  profile: string;
  colorIndex: number;
  finalTilesOwned?: number | null;
  finalTroops?: number | null;
  isAlive?: boolean | null;
}

interface AiLeagueSpectatorRelationship {
  fromAgentID: string;
  toAgentID: string;
  trust: number;
  distrust: number;
  tension: number;
  allianceState: string;
  attacksSent: number;
  attacksReceived: number;
  betrayals: number;
  tradeGivenGold: number;
  tradeGivenTroops: number;
  lastMajorEventTurn: number | null;
  currentLabel: string;
  reasons: string[];
}

interface AiLeagueSpectatorEvent {
  id: string;
  sequence: number;
  turnNumber: number;
  kind: string;
  tone: string;
  actorAgentID: string;
  actorName: string;
  targetAgentID: string | null;
  targetName: string | null;
  message: string;
  publicText?: string;
  importance: number;
}

interface AiLeagueSpectatorCommunicationThread {
  id: string;
  agentIDs: string[];
  title: string;
  latestTurn: number;
  tone: string;
  messages: AiLeagueSpectatorEvent[];
}

interface AiLeagueSpectatorTimelineBucket {
  startTurn: number;
  endTurn: number;
  events: AiLeagueSpectatorEvent[];
}

interface AiLeagueSpectatorTelemetry {
  version: 1;
  runID: string;
  agents: AiLeagueSpectatorAgent[];
  relationships: AiLeagueSpectatorRelationship[];
  events: AiLeagueSpectatorEvent[];
  communicationThreads: AiLeagueSpectatorCommunicationThread[];
  timelineBuckets: AiLeagueSpectatorTimelineBucket[];
}

interface AiLeagueMapSocialEvent {
  turnNumber: number;
  sequence: number;
  username: string;
  text: string;
  targetName: string | null;
  tone: string;
  kind: string;
  importance: number;
}

interface AiLeagueReplayOverlayInput {
  runID: string;
  decisions: AiLeagueDecisionLogEntry[];
  summary?: AiLeagueReplaySummary | null;
  spectatorTelemetry?: unknown;
  artifactBasePath: string;
  onReplaySpeedChange?: (speed: ReplaySpeedMultiplier) => void;
}

export function mountAiLeagueReplayOverlay(input: {
  runID: string;
  decisions: AiLeagueDecisionLogEntry[];
  summary?: AiLeagueReplaySummary | null;
  spectatorTelemetry?: unknown;
  artifactBasePath: string;
  onReplaySpeedChange?: (speed: ReplaySpeedMultiplier) => void;
}) {
  document.getElementById("ai-league-replay-overlay")?.remove();
  document.getElementById("ai-league-replay-mode-banner")?.remove();
  document.getElementById("ai-league-social-map-bubbles")?.remove();
  document.getElementById("ai-league-social-transcript")?.remove();
  document.getElementById("ai-league-story-timeline")?.remove();
  document.body.classList.add("ai-league-replay-mode");
  document.body.classList.toggle(
    "ai-league-native-spectator-ui",
    isAiLeagueNativeSpectatorUiEnabled(),
  );
  const spectatorTelemetry = normalizeSpectatorTelemetry(
    input.spectatorTelemetry,
  );
  const renderInput: AiLeagueReplayOverlayInput = {
    ...input,
    spectatorTelemetry,
  };
  const overlay = document.createElement("aside");
  overlay.id = "ai-league-replay-overlay";
  overlay.innerHTML = overlayHtml(renderInput);
  const banner = document.createElement("div");
  banner.id = "ai-league-replay-mode-banner";
  banner.textContent = "Replay mode: watching Proxy War agents";
  document.body.appendChild(overlay);
  document.body.appendChild(banner);
  mountAiLeagueMapSocialBubbles(input.decisions, spectatorTelemetry);
  mountAiLeagueStoryTimeline(spectatorTelemetry);
  mountReplayPanelControls(overlay);
  mountSpectatorRelationshipInteractions(overlay, spectatorTelemetry);
  mountReplayJumpControls(document);

  overlay
    .querySelectorAll<HTMLButtonElement>("[data-ai-league-toggle]")
    .forEach((button) => {
      button.addEventListener("click", () =>
        overlay.classList.toggle("collapsed"),
      );
    });
  const speedSlider = overlay.querySelector<HTMLInputElement>(
    "[data-ai-league-speed]",
  );
  const speedLabel = overlay.querySelector<HTMLElement>(
    "[data-ai-league-speed-label]",
  );
  speedSlider?.addEventListener("input", () => {
    const option = replaySpeedOption(Number(speedSlider.value));
    if (speedLabel !== null) {
      speedLabel.textContent = option.label;
    }
    input.onReplaySpeedChange?.(option.speed);
  });
}

function mountReplayPanelControls(overlay: HTMLElement) {
  const storageKey = "ai-league-spectator-layout-v1";
  const stored = readStoredPanelLayout(storageKey);
  if (stored !== null) {
    Object.assign(overlay.style, stored);
  }

  const dragHandle = overlay.querySelector<HTMLElement>("[data-ai-league-drag]");
  let dragState:
    | {
        startX: number;
        startY: number;
        left: number;
        top: number;
      }
    | null = null;
  dragHandle?.addEventListener("mousedown", (event) => {
    if ((event.target as HTMLElement).closest("button,a,input")) {
      return;
    }
    const rect = overlay.getBoundingClientRect();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    event.preventDefault();
  });

  const resizeHandle = overlay.querySelector<HTMLElement>(
    "[data-ai-league-resize]",
  );
  let resizeState:
    | {
        startX: number;
        startY: number;
        width: number;
        height: number;
      }
    | null = null;
  resizeHandle?.addEventListener("mousedown", (event) => {
    const rect = overlay.getBoundingClientRect();
    resizeState = {
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
    };
    event.preventDefault();
  });

  const onMove = (event: MouseEvent) => {
    if (dragState !== null) {
      const nextLeft = clamp(
        dragState.left + event.clientX - dragState.startX,
        8,
        window.innerWidth - 80,
      );
      const nextTop = clamp(
        dragState.top + event.clientY - dragState.startY,
        8,
        window.innerHeight - 80,
      );
      overlay.style.left = `${Math.round(nextLeft)}px`;
      overlay.style.top = `${Math.round(nextTop)}px`;
      overlay.style.right = "auto";
      persistPanelLayout(storageKey, overlay);
    }
    if (resizeState !== null) {
      overlay.style.width = `${Math.round(
        clamp(resizeState.width + event.clientX - resizeState.startX, 320, 760),
      )}px`;
      overlay.style.height = `${Math.round(
        clamp(resizeState.height + event.clientY - resizeState.startY, 260, window.innerHeight - 24),
      )}px`;
      overlay.style.maxHeight = "none";
      persistPanelLayout(storageKey, overlay);
    }
  };
  const onUp = () => {
    dragState = null;
    resizeState = null;
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  overlay
    .querySelector<HTMLButtonElement>("[data-ai-league-reset-layout]")
    ?.addEventListener("click", () => {
      localStorage.removeItem(storageKey);
      overlay.removeAttribute("style");
    });
}

function mountSpectatorRelationshipInteractions(
  overlay: HTMLElement,
  telemetry: AiLeagueSpectatorTelemetry | null,
) {
  if (telemetry === null) {
    return;
  }
  const label = overlay.querySelector<HTMLElement>(
    "[data-spectator-filter-label]",
  );
  const threads = Array.from(
    overlay.querySelectorAll<HTMLElement>("[data-spectator-thread]"),
  );
  const clear = () => {
    overlay
      .querySelectorAll<HTMLElement>("[data-spectator-relationship-cell]")
      .forEach((cell) => cell.classList.remove("active"));
    threads.forEach((thread) => thread.classList.remove("hidden"));
    if (label !== null) {
      label.textContent = "Showing all relationships";
    }
  };
  overlay
    .querySelector<HTMLButtonElement>("[data-spectator-clear-filter]")
    ?.addEventListener("click", clear);
  overlay
    .querySelectorAll<HTMLButtonElement>("[data-spectator-relationship-cell]")
    .forEach((cell) => {
      cell.addEventListener("click", () => {
        const fromAgentID = cell.dataset.fromAgent ?? "";
        const toAgentID = cell.dataset.toAgent ?? "";
        const fromName = cell.dataset.fromName ?? fromAgentID;
        const toName = cell.dataset.toName ?? toAgentID;
        overlay
          .querySelectorAll<HTMLElement>("[data-spectator-relationship-cell]")
          .forEach((candidate) => candidate.classList.remove("active"));
        cell.classList.add("active");
        threads.forEach((thread) => {
          const ids = (thread.dataset.agentIds ?? "").split(/\s+/);
          thread.classList.toggle(
            "hidden",
            !(ids.includes(fromAgentID) && ids.includes(toAgentID)),
          );
        });
        if (label !== null) {
          label.textContent = `Focused on ${fromName} -> ${toName}`;
        }
      });
    });
}

function mountReplayJumpControls(root: Document) {
  const win = window as Window & {
    __aiLeagueReplayJumpCleanup?: () => void;
  };
  win.__aiLeagueReplayJumpCleanup?.();
  let currentTurnNumber = 0;
  const onFrame = (event: Event) => {
    const detail = (event as CustomEvent<AiLeagueReplayFrameEventDetail>)
      .detail;
    if (detail && Number.isFinite(detail.turnNumber)) {
      currentTurnNumber = detail.turnNumber;
    }
  };
  const onClick = (event: Event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-ai-league-jump-turn]",
    );
    if (button === null || button === undefined) {
      return;
    }
    const turnNumber = Number(button.dataset.aiLeagueJumpTurn);
    if (!Number.isFinite(turnNumber)) {
      return;
    }
    if (turnNumber + 10 < currentTurnNumber) {
      const url = new URL(window.location.href);
      url.searchParams.set("replay", "");
      url.searchParams.set("turn", String(Math.floor(turnNumber)));
      window.location.href = url.toString();
      return;
    }
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-jump-turn", {
        detail: { turnNumber },
        bubbles: true,
      }),
    );
  };
  root.addEventListener("ai-league-replay-frame", onFrame);
  root.addEventListener("click", onClick);
  win.__aiLeagueReplayJumpCleanup = () => {
    root.removeEventListener("ai-league-replay-frame", onFrame);
    root.removeEventListener("click", onClick);
  };
}

function mountAiLeagueStoryTimeline(
  telemetry: AiLeagueSpectatorTelemetry | null,
) {
  if (telemetry === null) {
    return;
  }
  const timelineEvents = telemetry.timelineBuckets
    .flatMap((bucket) => bucket.events)
    .sort((a, b) => b.importance - a.importance || a.turnNumber - b.turnNumber)
    .slice(0, 18)
    .sort((a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence);
  if (timelineEvents.length === 0) {
    return;
  }
  const timeline = document.createElement("nav");
  timeline.id = "ai-league-story-timeline";
  timeline.setAttribute("aria-label", "Political replay timeline");
  timeline.innerHTML = `<span class="ai-league-timeline-title">Story</span>${timelineEvents
    .map(
      (event) =>
        `<button type="button" class="ai-league-timeline-marker ${escapeHtml(event.tone)}" data-ai-league-jump-turn="${event.turnNumber}" title="${escapeHtml(event.message)}">${escapeHtml(timelineEventLabel(event))}</button>`,
    )
    .join("")}`;
  document.body.appendChild(timeline);
}

function overlayHtml(input: AiLeagueReplayOverlayInput): string {
  const nonHold = input.decisions.filter(
    (decision) =>
      decision.selectedActionKind !== "hold" &&
      decision.selectedActionKind !== "spawn",
  );
  const rejected = input.decisions.filter(
    (decision) => !decision.result.accepted,
  );
  const fallback = input.decisions.filter((decision) => decision.fallbackUsed);
  const actionCounts = input.decisions.reduce<Record<string, number>>(
    (counts, decision) => {
      counts[decision.selectedActionKind] =
        (counts[decision.selectedActionKind] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const agentCount = input.summary?.roster?.length ?? 0;
  const visibleOpponentCount =
    input.summary?.finalState?.opponents?.length ?? 0;
  const bots = input.summary?.runnerConfig?.bots ?? null;
  const nations = input.summary?.runnerConfig?.nations ?? null;
  const maxSteps = input.summary?.runnerConfig?.maxSteps ?? null;
  const configuredOpponentCount = numericCount(nations) + numericCount(bots);
  const battleHighlights = input.decisions
    .filter(
      (decision) =>
        decision.selectedActionKind !== "spawn" &&
        decision.selectedActionKind !== "hold",
    )
    .slice(-10)
    .reverse();
  const setupLine =
    agentCount > 0 || configuredOpponentCount > 0
      ? `${agentCount} Proxy War agents vs ${configuredOpponentCount} built-in opponents`
      : "Proxy War agents vs built-in opposition";
  const configLine = [
    nations !== null && nations !== undefined
      ? `${nations} built-in nations`
      : null,
    bots !== null && bots !== undefined ? `${bots} tribes/bots` : null,
    maxSteps !== null && maxSteps !== undefined
      ? `${maxSteps} decision cycles`
      : null,
    visibleOpponentCount > 0
      ? `${visibleOpponentCount} visible in final mirror snapshot`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const matchStory = input.summary?.matchStory ?? null;
  const openingNeutral = openingNeutralSummary(input.decisions);
  const spectatorTelemetry =
    input.spectatorTelemetry as AiLeagueSpectatorTelemetry | null;

  return `
    <style>
      #ai-league-replay-overlay {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 50000;
        width: min(420px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow: hidden;
        display: grid;
        grid-template-rows: auto 1fr;
        border: 1px solid rgba(15, 23, 42, 0.22);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.94);
        color: #17202a;
        box-shadow: 0 18px 60px rgba(15, 23, 42, 0.22);
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body.ai-league-native-spectator-ui #ai-league-replay-overlay {
        top: auto;
        right: auto;
        left: 16px;
        bottom: 16px;
        width: min(440px, calc(100vw - 32px));
        max-height: min(58vh, 520px);
      }
      #ai-league-replay-overlay.collapsed {
        width: auto;
      }
      #ai-league-replay-overlay.collapsed .ai-league-body {
        display: none;
      }
      #ai-league-replay-overlay header {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 10px;
        padding: 12px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.12);
        cursor: move;
        user-select: none;
      }
      #ai-league-replay-overlay header > div:first-child {
        min-width: 0;
      }
      #ai-league-replay-overlay h2 {
        margin: 0 0 2px;
        font-size: 15px;
      }
      .ai-league-header-actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      #ai-league-replay-overlay button {
        border: 1px solid rgba(15, 23, 42, 0.18);
        background: #fff;
        border-radius: 6px;
        padding: 6px 8px;
        cursor: pointer;
        font-weight: 700;
      }
      .ai-league-body {
        overflow: auto;
        padding: 12px;
      }
      .ai-league-resize-handle {
        position: absolute;
        right: 4px;
        bottom: 4px;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        border-right: 2px solid rgba(15, 23, 42, 0.28);
        border-bottom: 2px solid rgba(15, 23, 42, 0.28);
      }
      .ai-league-muted {
        color: #64748b;
        font-size: 12px;
      }
      .ai-league-metrics {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-bottom: 10px;
      }
      .ai-league-metric {
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 8px;
        padding: 8px;
        background: #f8fafc;
      }
      .ai-league-metric b {
        display: block;
        font-size: 16px;
      }
      .ai-league-actions {
        margin: 0 0 10px;
        color: #475569;
      }
      .ai-league-speed {
        display: grid;
        gap: 7px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 8px;
        padding: 9px;
        margin: 0 0 10px;
        background: #fff;
      }
      .ai-league-speed-row {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: center;
      }
      .ai-league-speed input {
        width: 100%;
        accent-color: #215a9c;
      }
      .ai-league-speed-labels {
        display: flex;
        justify-content: space-between;
        color: #64748b;
        font-size: 11px;
        font-weight: 700;
      }
      .ai-league-feed {
        display: grid;
        gap: 7px;
        margin: 0 0 12px;
      }
      .ai-league-feed-item {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 7px;
        align-items: start;
        border: 1px solid rgba(15, 23, 42, 0.1);
        border-radius: 8px;
        padding: 8px;
        background: #f8fafc;
      }
      .ai-league-feed-item strong {
        display: block;
      }
      .ai-league-feed-item p {
        margin: 2px 0 0;
        color: #475569;
      }
      .ai-league-chat-bubble {
        display: inline-block;
        margin: 5px 0 0;
        padding: 6px 8px;
        border: 1px solid #c8dcf2;
        border-radius: 12px 12px 12px 3px;
        background: #eef6ff;
        color: #17324d;
        font-weight: 800;
      }
      .ai-league-match-setup {
        border: 1px solid rgba(29, 94, 143, 0.2);
        border-radius: 8px;
        padding: 9px;
        margin-bottom: 10px;
        background: #eef7fb;
      }
      .ai-league-story {
        border: 1px solid rgba(33, 90, 156, 0.18);
        border-radius: 8px;
        padding: 9px;
        margin: 0 0 10px;
        background: #fff;
      }
      .ai-league-story ul {
        margin: 6px 0 0 18px;
        padding: 0;
      }
      .ai-league-story li {
        margin: 3px 0;
      }
      .ai-league-politics {
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 8px;
        padding: 9px;
        margin: 0 0 10px;
        background: #fff;
      }
      .ai-league-politics-head {
        display: flex;
        justify-content: space-between;
        align-items: start;
        gap: 10px;
        margin-bottom: 8px;
      }
      .ai-league-relationship-grid {
        display: grid;
        gap: 5px;
        overflow-x: auto;
        padding-bottom: 2px;
      }
      .ai-league-relationship-name,
      .ai-league-relationship-cell,
      .ai-league-relationship-empty {
        min-width: 92px;
        min-height: 58px;
      }
      .ai-league-relationship-name {
        display: flex;
        align-items: center;
        font-weight: 900;
        color: #334155;
        font-size: 12px;
      }
      .ai-league-relationship-cell {
        display: grid;
        gap: 3px;
        text-align: left;
        background: #f8fafc;
        border-color: rgba(15, 23, 42, 0.12);
        font-size: 11px;
        font-weight: 800;
      }
      .ai-league-relationship-cell.active {
        outline: 2px solid #215a9c;
        outline-offset: 1px;
      }
      .ai-league-relationship-cell.ally {
        background: #e7f8ef;
        color: #14532d;
      }
      .ai-league-relationship-cell.rival,
      .ai-league-relationship-cell.target {
        background: #fff1e7;
        color: #7c2d12;
      }
      .ai-league-relationship-cell.betrayed {
        background: #ffe4e6;
        color: #881337;
      }
      .ai-league-relationship-label {
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0;
      }
      .ai-league-comms {
        display: grid;
        gap: 8px;
        max-height: 360px;
        overflow: auto;
        margin-bottom: 10px;
      }
      .ai-league-thread {
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 8px;
        padding: 8px;
        background: #fff;
      }
      .ai-league-thread.hidden {
        display: none;
      }
      .ai-league-message {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 7px;
        margin-top: 7px;
        align-items: start;
      }
      .ai-league-jump {
        min-width: 48px;
        padding: 4px 6px !important;
        color: #215a9c;
        font-size: 11px;
      }
      .ai-league-message p {
        margin: 1px 0 0;
        color: #334155;
      }
      .ai-league-decision {
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 8px;
        padding: 9px;
        margin: 8px 0;
        background: #fff;
      }
      .ai-league-row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: start;
      }
      .ai-league-badges {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
        margin: 6px 0;
      }
      .ai-league-badge {
        display: inline-flex;
        border-radius: 999px;
        padding: 2px 7px;
        background: #e7eef7;
        color: #215a9c;
        font-size: 11px;
        font-weight: 800;
      }
      .ai-league-badge.ok {
        background: #e5f8ef;
        color: #19764b;
      }
      .ai-league-badge.bad {
        background: #fde8ed;
        color: #a32135;
      }
      .ai-league-badge.warn {
        background: #fff2dc;
        color: #a55b00;
      }
      #ai-league-replay-overlay code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow-wrap: anywhere;
      }
      #ai-league-replay-overlay a {
        color: #215a9c;
        font-weight: 700;
        text-decoration: none;
      }
      body.ai-league-replay-mode heads-up-message {
        display: none !important;
      }
      #ai-league-replay-mode-banner {
        position: fixed;
        top: 15%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 49999;
        pointer-events: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        max-width: min(560px, 90vw);
        padding: 7px 14px;
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.76);
        color: #fff;
        font: 700 15px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: center;
        backdrop-filter: blur(8px);
      }
      #ai-league-social-map-bubbles {
        position: fixed;
        inset: 0;
        z-index: 49998;
        pointer-events: none;
        overflow: hidden;
        font: 800 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .ai-league-map-social-bubble {
        position: absolute;
        max-width: min(340px, 46vw);
        min-width: 180px;
        transform: translate(-50%, -115%);
        padding: 9px 11px;
        border: 2px solid rgba(29, 94, 143, 0.9);
        border-radius: 10px 10px 10px 3px;
        background: rgba(238, 246, 255, 0.96);
        color: #17324d;
        box-shadow: 0 12px 34px rgba(15, 23, 42, 0.22);
        text-align: left;
        overflow-wrap: break-word;
      }
      body.ai-league-native-spectator-ui .ai-league-map-social-bubble {
        transform: translate(-50%, 0);
      }
      .ai-league-map-social-bubble.emoji {
        min-width: 44px;
        max-width: 72px;
        font-size: 26px;
        line-height: 1;
        border-color: rgba(161, 98, 7, 0.9);
        background: rgba(255, 247, 237, 0.96);
        text-align: center;
      }
      .ai-league-map-social-bubble.betrayal {
        border-color: rgba(169, 50, 38, 0.95);
        background: rgba(255, 241, 242, 0.97);
        color: #6f1d1b;
      }
      .ai-league-map-social-bubble.conspiracy {
        border-color: rgba(88, 28, 135, 0.9);
        background: rgba(245, 243, 255, 0.97);
        color: #3b0764;
      }
      .ai-league-map-social-bubble.threat {
        border-color: rgba(180, 83, 9, 0.95);
        background: rgba(255, 247, 237, 0.97);
        color: #713f12;
      }
      .ai-league-map-social-speaker {
        display: block;
        margin-bottom: 3px;
        color: rgba(15, 23, 42, 0.72);
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0;
      }
      .ai-league-map-social-bubble small {
        display: block;
        margin-top: 3px;
        color: #64748b;
        font-size: 11px;
      }
      #ai-league-social-transcript {
        position: fixed;
        left: 18px;
        bottom: 18px;
        z-index: 50001;
        width: min(520px, calc(100vw - 36px));
        display: grid;
        gap: 7px;
        pointer-events: none;
        font: 700 13px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .ai-league-social-transcript-title {
        justify-self: start;
        border-radius: 999px;
        padding: 4px 9px;
        background: rgba(15, 23, 42, 0.78);
        color: #fff;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0;
      }
      .ai-league-social-transcript-line {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 8px;
        align-items: start;
        border: 1px solid rgba(15, 23, 42, 0.16);
        border-radius: 8px;
        padding: 8px 10px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 12px 34px rgba(15, 23, 42, 0.18);
      }
      .ai-league-social-transcript-line b {
        display: block;
        color: #17202a;
      }
      .ai-league-social-transcript-line span {
        color: #475569;
      }
      .ai-league-social-tone {
        border-radius: 999px;
        padding: 2px 7px;
        background: #e7eef7;
        color: #215a9c;
        font-size: 11px;
        font-weight: 900;
      }
      .ai-league-social-tone.betrayal {
        background: #ffe4e6;
        color: #9f1239;
      }
      .ai-league-social-tone.conspiracy {
        background: #ede9fe;
        color: #5b21b6;
      }
      .ai-league-social-tone.threat {
        background: #ffedd5;
        color: #9a3412;
      }
      .ai-league-social-tone.war {
        background: #fee2e2;
        color: #991b1b;
      }
      .ai-league-social-tone.trade {
        background: #dcfce7;
        color: #166534;
      }
      #ai-league-story-timeline {
        position: fixed;
        left: 50%;
        bottom: 16px;
        transform: translateX(-50%);
        z-index: 50000;
        width: min(760px, calc(100vw - 36px));
        display: flex;
        gap: 6px;
        align-items: center;
        overflow-x: auto;
        padding: 8px;
        border: 1px solid rgba(15, 23, 42, 0.16);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 12px 34px rgba(15, 23, 42, 0.18);
        font: 700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .ai-league-timeline-title {
        flex: 0 0 auto;
        color: #334155;
        font-weight: 900;
      }
      .ai-league-timeline-marker {
        flex: 0 0 auto;
        border: 1px solid rgba(15, 23, 42, 0.16);
        border-radius: 999px;
        background: #f8fafc;
        color: #17202a;
        padding: 5px 8px;
        cursor: pointer;
        font-weight: 800;
      }
      .ai-league-timeline-marker.betrayal {
        background: #ffe4e6;
        color: #881337;
      }
      .ai-league-timeline-marker.pact {
        background: #e7f8ef;
        color: #14532d;
      }
      .ai-league-timeline-marker.threat,
      .ai-league-timeline-marker.war {
        background: #ffedd5;
        color: #7c2d12;
      }
      @media (max-width: 740px) {
        #ai-league-replay-overlay {
          top: 8px;
          right: 8px;
          left: 8px;
          width: auto;
          max-height: 58vh;
        }
        #ai-league-replay-overlay header {
          padding: 10px;
          gap: 6px;
        }
        #ai-league-replay-overlay h2 {
          font-size: 14px;
        }
        #ai-league-replay-overlay header .ai-league-muted {
          max-width: 150px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #ai-league-replay-overlay [data-ai-league-reset-layout] {
          display: none;
        }
        #ai-league-replay-overlay button {
          padding: 5px 7px;
        }
        .ai-league-metrics {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        #ai-league-social-transcript {
          display: none;
        }
        #ai-league-story-timeline {
          bottom: 8px;
          width: calc(100vw - 16px);
        }
      }
    </style>
    <header data-ai-league-drag>
      <div>
        <h2>Proxy War Replay</h2>
        <div class="ai-league-muted">${escapeHtml(input.runID)}</div>
      </div>
      <div class="ai-league-header-actions">
        <button type="button" data-ai-league-reset-layout title="Reset panel position">Reset</button>
        <button type="button" data-ai-league-toggle>Panel</button>
      </div>
    </header>
    <div class="ai-league-body">
      <section class="ai-league-metrics">
        <div class="ai-league-metric">Decisions<b>${input.decisions.length}</b></div>
        <div class="ai-league-metric">Non-hold<b>${nonHold.length}</b></div>
        <div class="ai-league-metric">Rejected<b>${rejected.length}</b></div>
        <div class="ai-league-metric">Fallbacks<b>${fallback.length}</b></div>
      </section>
      <section class="ai-league-match-setup">
        <strong>${escapeHtml(setupLine)}</strong>
        ${configLine ? `<div class="ai-league-muted">${escapeHtml(configLine)}</div>` : ""}
      </section>
      ${
        matchStory
          ? `<section class="ai-league-story">
        <strong>Match story: ${escapeHtml(String(matchStory.entertainmentScore ?? "n/a"))}/100 ${escapeHtml(matchStory.grade ?? "")}</strong>
        <div class="ai-league-muted">${escapeHtml(matchStory.summary ?? "Story summary unavailable.")}</div>
        ${
          matchStory.spectatorHighlights?.length
            ? `<ul>${matchStory.spectatorHighlights
                .slice(0, 3)
                .map((highlight) => `<li>${escapeHtml(highlight)}</li>`)
                .join("")}</ul>`
            : ""
        }
        ${matchStory.boringnessWarnings?.length ? `<p class="ai-league-muted">Warnings: ${escapeHtml(matchStory.boringnessWarnings.slice(0, 2).join(" · "))}</p>` : ""}
      </section>`
          : ""
      }
      ${
        openingNeutral !== null
          ? `<section class="ai-league-match-setup">
        <strong>Opening neutral land: ${openingNeutral.chosen}/${openingNeutral.available} legal chances taken</strong>
        <div class="ai-league-muted">${openingNeutral.firstTurn === null ? "No neutral expansion action was recorded." : `First visible neutral expansion: turn ${openingNeutral.firstTurn}. The spawn phase blocks attacks before active play, so the replay starts with a short static countdown.`}</div>
      </section>`
          : ""
      }
      <section class="ai-league-speed" aria-label="Replay speed control">
        <div class="ai-league-speed-row">
          <strong>Replay speed</strong>
          <span class="ai-league-badge" data-ai-league-speed-label>Max</span>
        </div>
        <input data-ai-league-speed type="range" min="0" max="3" step="1" value="3" aria-label="Replay speed">
        <div class="ai-league-speed-labels" aria-hidden="true">
          <span>0.5x</span>
          <span>1x</span>
          <span>2x</span>
          <span>Max</span>
        </div>
      </section>
      ${spectatorTelemetry ? politicsBoardHtml(spectatorTelemetry) : ""}
      ${spectatorTelemetry ? communicationThreadsHtml(spectatorTelemetry) : ""}
      ${battleHighlights.length > 0 ? battleFeedHtml(battleHighlights) : ""}
      <p class="ai-league-actions">Action counts: ${actionCountBadges(actionCounts)}</p>
      <p class="ai-league-muted">This uses the real Proxy War replay renderer. The viewer has no player identity and replay intents are read-only.</p>
      <p>
        <a href="${escapeHtml(input.artifactBasePath)}/visual-report.html">visual report</a>
        · <a href="${escapeHtml(input.artifactBasePath)}/match-story.md">story</a>
        · <a href="${escapeHtml(input.artifactBasePath)}/spectator-telemetry.json">politics data</a>
        · <a href="${escapeHtml(input.artifactBasePath)}/decisions.jsonl">decisions</a>
        · <a href="${escapeHtml(input.artifactBasePath)}/match-summary.json">summary</a>
      </p>
      ${input.decisions.map(decisionHtml).join("")}
    </div>
    <div class="ai-league-resize-handle" data-ai-league-resize aria-hidden="true"></div>`;
}

function openingNeutralSummary(
  decisions: AiLeagueDecisionLogEntry[],
): { available: number; chosen: number; firstTurn: number | null } | null {
  const opening = decisions.filter((decision) => decision.turnNumber <= 900);
  const available = opening.filter(hasNeutralExpansionLegalAction).length;
  const chosen = opening.filter(
    (decision) =>
      hasNeutralExpansionLegalAction(decision) &&
      isNeutralExpansionAction(decision),
  ).length;
  const firstTurn =
    decisions
      .filter(isNeutralExpansionAction)
      .map((decision) => decision.turnNumber)
      .sort((a, b) => a - b)[0] ?? null;
  if (available === 0 && firstTurn === null) {
    return null;
  }
  return { available, chosen, firstTurn };
}

function hasNeutralExpansionLegalAction(
  decision: AiLeagueDecisionLogEntry,
): boolean {
  return (decision.legalActionIDsByKind?.attack ?? []).some((actionID) =>
    actionID.startsWith("expand:terra-nullius"),
  );
}

function isNeutralExpansionAction(decision: AiLeagueDecisionLogEntry): boolean {
  return (
    (decision.batchActionIDs ?? []).some((actionID) =>
      actionID.startsWith("expand:terra-nullius"),
    ) ||
    decision.selectedLegalActionId.startsWith("expand:terra-nullius") ||
    (decision.selectedActionKind === "attack" &&
      decision.selectedActionMetadata?.expansion === true)
  );
}

function replaySpeedOption(index: number): {
  label: string;
  speed: ReplaySpeedMultiplier;
} {
  const options = [
    { label: "0.5x", speed: ReplaySpeedMultiplier.slow },
    { label: "1x", speed: ReplaySpeedMultiplier.normal },
    { label: "2x", speed: ReplaySpeedMultiplier.fast },
    { label: "Max", speed: ReplaySpeedMultiplier.fastest },
  ];
  return options[Math.max(0, Math.min(options.length - 1, Math.round(index)))]!;
}

function politicsBoardHtml(
  telemetry: AiLeagueSpectatorTelemetry,
): string {
  const agents = telemetry.agents;
  const leader = [...agents]
    .filter((agent) => typeof agent.finalTilesOwned === "number")
    .sort((a, b) => (b.finalTilesOwned ?? 0) - (a.finalTilesOwned ?? 0))[0];
  const columns = `132px repeat(${Math.max(1, agents.length)}, minmax(92px, 1fr))`;
  const headerCells = [
    '<div class="ai-league-relationship-name">From / To</div>',
    ...agents.map(
      (agent) =>
        `<div class="ai-league-relationship-name">${escapeHtml(aiLeagueSpectatorDisplayName(agent.username))}</div>`,
    ),
  ].join("");
  const rows = agents
    .map((from) =>
      [
        `<div class="ai-league-relationship-name">${escapeHtml(aiLeagueSpectatorDisplayName(from.username))}</div>`,
        ...agents.map((to) => {
          if (from.agentID === to.agentID) {
            return '<div class="ai-league-relationship-empty"></div>';
          }
          const relationship = relationshipFor(
            telemetry,
            from.agentID,
            to.agentID,
          );
          if (relationship === null) {
            return '<div class="ai-league-relationship-empty"></div>';
          }
          return relationshipCellHtml(relationship, from, to);
        }),
      ].join(""),
    )
    .join("");
  return `
    <section class="ai-league-politics" data-ai-league-politics>
      <div class="ai-league-politics-head">
        <div>
          <strong>Politics board</strong>
          <div class="ai-league-muted">${leader ? `Leader: ${escapeHtml(aiLeagueSpectatorDisplayName(leader.username))} (${leader.finalTilesOwned ?? 0} tiles)` : "Leader data unavailable"}</div>
        </div>
        <button type="button" data-spectator-clear-filter>All talks</button>
      </div>
      <div class="ai-league-muted" data-spectator-filter-label>Showing all relationships</div>
      <div class="ai-league-relationship-grid" style="grid-template-columns:${columns}">
        ${headerCells}${rows}
      </div>
    </section>`;
}

function relationshipCellHtml(
  relationship: AiLeagueSpectatorRelationship,
  from: AiLeagueSpectatorAgent,
  to: AiLeagueSpectatorAgent,
): string {
  const label = relationship.currentLabel || "neutral";
  const reason = relationship.reasons[0] ?? "No recent direct event.";
  return `
    <button
      type="button"
      class="ai-league-relationship-cell ${escapeHtml(label)}"
      data-spectator-relationship-cell
      data-from-agent="${escapeHtml(from.agentID)}"
      data-to-agent="${escapeHtml(to.agentID)}"
      data-from-name="${escapeHtml(aiLeagueSpectatorDisplayName(from.username))}"
      data-to-name="${escapeHtml(aiLeagueSpectatorDisplayName(to.username))}"
      title="${escapeHtml(reason)}"
    >
      <span class="ai-league-relationship-label">${escapeHtml(label)}</span>
      <span>T ${relationship.trust} / D ${relationship.distrust}</span>
      <span>Heat ${relationship.tension}</span>
    </button>`;
}

function communicationThreadsHtml(
  telemetry: AiLeagueSpectatorTelemetry,
): string {
  const threads = telemetry.communicationThreads.slice(0, 8);
  if (threads.length === 0) {
    return `
      <section class="ai-league-politics">
        <strong>Diplomacy feed</strong>
        <div class="ai-league-muted">No direct political messages were recorded.</div>
      </section>`;
  }
  return `
    <section class="ai-league-politics">
      <strong>Diplomacy feed</strong>
      <div class="ai-league-comms" data-spectator-comms>
        ${threads.map((thread) => communicationThreadHtml(thread, telemetry)).join("")}
      </div>
    </section>`;
}

function communicationThreadHtml(
  thread: AiLeagueSpectatorCommunicationThread,
  telemetry: AiLeagueSpectatorTelemetry,
): string {
  const names = thread.agentIDs
    .map((agentID) => agentName(telemetry, agentID))
    .join(" vs ");
  return `
    <article class="ai-league-thread" data-spectator-thread data-agent-ids="${escapeHtml(thread.agentIDs.join(" "))}">
      <div class="ai-league-row">
        <strong>${escapeHtml(names)}</strong>
        <span class="ai-league-social-tone ${escapeHtml(thread.tone)}">${escapeHtml(theatreToneLabel(thread.tone))}</span>
      </div>
      ${thread.messages
        .slice(-6)
        .map((event) => communicationMessageHtml(event))
        .join("")}
    </article>`;
}

function communicationMessageHtml(event: AiLeagueSpectatorEvent): string {
  const message = aiLeagueSpectatorText(event.publicText ?? event.message);
  const target = event.targetName
    ? ` to ${aiLeagueSpectatorDisplayName(event.targetName)}`
    : "";
  return `
    <div class="ai-league-message">
      <button type="button" class="ai-league-jump" data-ai-league-jump-turn="${event.turnNumber}">turn ${event.turnNumber}</button>
      <div>
        <b>${escapeHtml(aiLeagueSpectatorDisplayName(event.actorName))}${escapeHtml(target)}</b>
        <p>${escapeHtml(shortText(message, 180))}</p>
      </div>
    </div>`;
}

function battleFeedHtml(decisions: AiLeagueDecisionLogEntry[]): string {
  return `
    <section>
      <strong>Recent action feed</strong>
      <div class="ai-league-feed">
        ${decisions
          .map(
            (decision) => `
              <div class="ai-league-feed-item">
                <span class="ai-league-badge">${escapeHtml(actionLabel(decision))}</span>
                <div>
                  <strong>${escapeHtml(aiLeagueSpectatorDisplayName(decision.username))}</strong>
                  <code>${escapeHtml(decision.selectedLegalActionId)}</code>
                  ${socialBubbleHtml(decision)}
                  <p>${escapeHtml(shortText(decision.reason, 150))}</p>
                </div>
              </div>`,
          )
          .join("")}
      </div>
    </section>`;
}

function actionCountBadges(actionCounts: Record<string, number>): string {
  return Object.entries(actionCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(
      ([kind, count]) =>
        `<span class="ai-league-badge">${escapeHtml(actionLabelFromKind(kind))}: ${count}</span>`,
    )
    .join(" ");
}

function decisionHtml(decision: AiLeagueDecisionLogEntry): string {
  return `
    <article class="ai-league-decision">
      <div class="ai-league-row">
        <strong>${decision.sequence}. ${escapeHtml(decision.username)}</strong>
        <span class="ai-league-muted">turn ${decision.turnNumber}</span>
      </div>
      <div class="ai-league-badges">
        <span class="ai-league-badge">${escapeHtml(actionLabel(decision))}</span>
        <span class="ai-league-badge ${decision.result.accepted ? "ok" : "bad"}">${decision.result.accepted ? "accepted" : "rejected"}</span>
        ${
          decision.fallbackUsed
            ? '<span class="ai-league-badge warn">fallback</span>'
            : ""
        }
        ${
          decision.auditStatus
            ? `<span class="ai-league-badge">${escapeHtml(decision.auditStatus)}</span>`
            : ""
        }
      </div>
      <code>${escapeHtml(decision.selectedLegalActionId)}</code>
      ${socialBubbleHtml(decision)}
      <p>${escapeHtml(decision.reason)}</p>
      <div class="ai-league-muted">${decision.decisionLatencyMs}ms · ${escapeHtml(intentSummary(decision.generatedIntent))}</div>
    </article>`;
}

function socialBubbleHtml(decision: AiLeagueDecisionLogEntry): string {
  const socialText =
    typeof decision.socialText === "string"
      ? decision.socialText
      : socialTextFromMetadata(decision);
  if (socialText === null) {
    return "";
  }
  const target =
    typeof decision.socialTargetName === "string"
      ? decision.socialTargetName
      : typeof decision.selectedActionMetadata?.recipientName === "string"
        ? decision.selectedActionMetadata.recipientName
        : typeof decision.selectedActionMetadata?.targetName === "string"
          ? decision.selectedActionMetadata.targetName
          : null;
  return `<div class="ai-league-chat-bubble">${escapeHtml(aiLeagueSpectatorText(socialText))}${
    target
      ? ` <span class="ai-league-muted">to ${escapeHtml(aiLeagueSpectatorDisplayName(target))}</span>`
      : ""
  }</div>`;
}

function socialTextFromMetadata(
  decision: AiLeagueDecisionLogEntry,
): string | null {
  const metadata = decision.selectedActionMetadata ?? {};
  if (decision.selectedActionKind === "quick_chat") {
    if (typeof metadata.message === "string") {
      return metadata.message;
    }
    if (typeof metadata.quickChatKey === "string") {
      return metadata.quickChatKey;
    }
  }
  if (decision.selectedActionKind === "emoji") {
    if (typeof metadata.emojiText === "string") {
      return metadata.emojiText;
    }
    if (typeof metadata.emoji === "number") {
      return `emoji ${metadata.emoji}`;
    }
  }
  return null;
}

function mapSocialEvents(
  decisions: readonly AiLeagueDecisionLogEntry[],
  telemetry: AiLeagueSpectatorTelemetry | null,
): AiLeagueMapSocialEvent[] {
  const telemetryEvents =
    telemetry?.events
      .filter((event) =>
        [
          "chat",
          "emoji",
          "alliance_request",
          "alliance_formed",
          "alliance_break",
          "trade",
          "target_call",
          "embargo",
          "nuke",
        ].includes(event.kind),
      )
      .map((event) => ({
        turnNumber: event.turnNumber,
        sequence: event.sequence,
        username: event.actorName,
        text: event.publicText ?? event.message,
        targetName: event.targetName,
        tone: event.tone,
        kind: event.kind,
        importance: event.importance,
      })) ?? [];
  if (telemetryEvents.length > 0) {
    return telemetryEvents.sort(
      (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
    );
  }
  return decisions
    .map((decision) => {
      const text = theatreTextForDecision(decision);
      if (text === null) {
        return null;
      }
      const target =
        typeof decision.socialTargetName === "string"
          ? decision.socialTargetName
          : typeof decision.selectedActionMetadata?.recipientName === "string"
            ? decision.selectedActionMetadata.recipientName
            : typeof decision.selectedActionMetadata?.targetName === "string"
              ? decision.selectedActionMetadata.targetName
              : null;
      return {
        turnNumber: decision.turnNumber,
        sequence: decision.sequence,
        username: decision.username,
        text,
        targetName: target,
        tone: theatreTone(decision),
        kind: decision.selectedActionKind,
        importance: theatreImportance(decision),
      };
    })
    .filter((event): event is AiLeagueMapSocialEvent => event !== null)
    .sort((a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence);
}

function mountAiLeagueMapSocialBubbles(
  decisions: readonly AiLeagueDecisionLogEntry[],
  telemetry: AiLeagueSpectatorTelemetry | null,
) {
  const win = window as Window & {
    __aiLeagueSocialBubblesCleanup?: () => void;
  };
  win.__aiLeagueSocialBubblesCleanup?.();
  const layer = document.createElement("div");
  layer.id = "ai-league-social-map-bubbles";
  const transcript = document.createElement("div");
  transcript.id = "ai-league-social-transcript";
  document.body.appendChild(layer);
  document.body.appendChild(transcript);
  const socialEvents = mapSocialEvents(decisions, telemetry);
  const onFrame = (event: Event) => {
    const detail = (event as CustomEvent<AiLeagueReplayFrameEventDetail>)
      .detail;
    if (!detail || !Array.isArray(detail.players)) {
      return;
    }
    const active = socialEvents
      .filter(
        (socialEvent) =>
          socialEvent.turnNumber <= detail.turnNumber &&
          detail.turnNumber <=
            socialEvent.turnNumber + theatreEventBubbleDuration(socialEvent),
      )
      .sort((a, b) => b.importance - a.importance || b.turnNumber - a.turnNumber)
      .slice(0, 2);
    layer.innerHTML = active
      .map((socialEvent, index) =>
        mapSocialBubbleHtml(socialEvent, detail, index),
      )
      .filter(Boolean)
      .join("");
    transcript.innerHTML = socialTranscriptHtml(active);
  };
  document.addEventListener("ai-league-replay-frame", onFrame);
  win.__aiLeagueSocialBubblesCleanup = () => {
    document.removeEventListener("ai-league-replay-frame", onFrame);
    layer.remove();
    transcript.remove();
  };
}

function mapSocialBubbleHtml(
  socialEvent: AiLeagueMapSocialEvent,
  frame: AiLeagueReplayFrameEventDetail,
  index: number,
): string {
  const player = frame.players.find(
    (candidate) =>
      normalizeName(candidate.username) === normalizeName(socialEvent.username) ||
      normalizeName(candidate.displayName) === normalizeName(socialEvent.username),
  );
  if (player === undefined) {
    return "";
  }
  const offsets = bubbleOffset(index);
  const x = clamp(player.x + offsets.x, 88, window.innerWidth - 88);
  const y = clamp(player.y - 40 + offsets.y, 46, window.innerHeight - 56);
  const tone = socialEvent.tone;
  const className = [
    "ai-league-map-social-bubble",
    socialEvent.kind === "emoji" ? "emoji" : "",
    tone,
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="${className}" style="left:${x}px;top:${y}px">${
    socialEvent.kind === "emoji"
      ? ""
      : `<span class="ai-league-map-social-speaker">${escapeHtml(aiLeagueSpectatorDisplayName(socialEvent.username))}</span>`
  }${escapeHtml(shortText(aiLeagueSpectatorText(socialEvent.text), socialEvent.kind === "emoji" ? 6 : 118))}${
    socialEvent.targetName && socialEvent.kind !== "emoji"
      ? `<small>to ${escapeHtml(aiLeagueSpectatorDisplayName(socialEvent.targetName))}</small>`
      : ""
  }</div>`;
}

function theatreTextForDecision(
  decision: AiLeagueDecisionLogEntry,
): string | null {
  const social =
    typeof decision.socialText === "string"
      ? decision.socialText
      : socialTextFromMetadata(decision);
  if (social !== null) {
    return social;
  }
  const metadata = decision.selectedActionMetadata ?? {};
  const targetName =
    typeof metadata.targetName === "string"
      ? metadata.targetName
      : typeof metadata.recipientName === "string"
        ? metadata.recipientName
        : "the board";
  switch (decision.selectedActionKind) {
    case "alliance_request":
      return `Offering ${targetName} a public pact. For now.`;
    case "alliance_extend":
      return `${targetName}, I renew the pact. Keep the border quiet.`;
    case "alliance_reject":
      return `${targetName}, no deal. I see the trap.`;
    case "break_alliance":
      return `${targetName}, the pact is over. Everyone saw this coming except you.`;
    case "donate_gold":
      return `${targetName}, take the gold and keep your side of the bargain.`;
    case "donate_troops":
      return `${targetName}, troops sent. Spend them where I pointed.`;
    case "target_player":
      return `${targetName} is the public target. Quiet borders elsewhere.`;
    case "embargo":
    case "embargo_all":
      return `Trade doors are closing. Someone is getting squeezed.`;
    case "nuke":
      return `${targetName}, this is deterrence with a countdown.`;
    default:
      return null;
  }
}

function theatreEventBubbleDuration(socialEvent: AiLeagueMapSocialEvent): number {
  if (socialEvent.kind === "emoji") {
    return 220;
  }
  if (socialEvent.tone === "betrayal" || socialEvent.kind === "nuke") {
    return 700;
  }
  return 520;
}

function theatreImportance(decision: AiLeagueDecisionLogEntry): number {
  if (
    decision.selectedActionKind === "break_alliance" ||
    decision.selectedActionKind === "nuke"
  ) {
    return 95;
  }
  if (
    decision.selectedActionKind === "alliance_request" ||
    decision.selectedActionKind === "target_player"
  ) {
    return 75;
  }
  if (decision.selectedActionKind === "emoji") {
    return 40;
  }
  return 55;
}

function bubbleOffset(index: number): { x: number; y: number } {
  const offsets = [
    { x: -96, y: -72 },
    { x: 96, y: -36 },
    { x: -44, y: -128 },
    { x: 44, y: -92 },
  ];
  return offsets[index % offsets.length]!;
}

function socialTranscriptHtml(
  socialEvents: readonly AiLeagueMapSocialEvent[],
): string {
  if (socialEvents.length === 0) {
    return "";
  }
  return `<div class="ai-league-social-transcript-title">Political radio</div>${socialEvents
    .map((socialEvent) => {
      const tone = socialEvent.tone;
      return `<div class="ai-league-social-transcript-line"><div class="ai-league-social-tone ${escapeHtml(tone)}">${escapeHtml(theatreToneLabel(tone))}</div><div><b>${escapeHtml(aiLeagueSpectatorDisplayName(socialEvent.username))}</b><span>${escapeHtml(shortText(aiLeagueSpectatorText(socialEvent.text), 150))}</span></div></div>`;
    })
    .join("")}`;
}

function theatreTone(decision: AiLeagueDecisionLogEntry): string {
  if (
    decision.selectedActionKind === "break_alliance" ||
    decision.selectedActionMetadata?.emojiContext === "betrayal_signal"
  ) {
    return "betrayal";
  }
  if (
    decision.selectedActionKind === "alliance_request" ||
    decision.selectedActionKind === "alliance_extend" ||
    decision.selectedActionKind === "donate_gold" ||
    decision.selectedActionKind === "donate_troops"
  ) {
    return "conspiracy";
  }
  if (
    decision.selectedActionKind === "target_player" ||
    decision.selectedActionKind === "embargo" ||
    decision.selectedActionKind === "embargo_all" ||
    decision.selectedActionKind === "nuke" ||
    decision.selectedActionMetadata?.emojiContext === "pressure_target" ||
    decision.selectedActionMetadata?.emojiContext === "anger_under_attack"
  ) {
    return "threat";
  }
  return "";
}

function theatreToneLabel(tone: string): string {
  if (tone === "betrayal") return "betrayal";
  if (tone === "conspiracy" || tone === "pact") return "pact";
  if (tone === "threat") return "threat";
  if (tone === "trade") return "trade";
  if (tone === "war") return "war";
  return "chat";
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function intentSummary(intent: unknown): string {
  if (intent === null || intent === undefined) {
    return "no intent";
  }
  if (typeof intent === "object") {
    const type =
      "type" in intent ? String((intent as { type?: unknown }).type) : "intent";
    return type;
  }
  return String(intent);
}

interface AiLeagueReplaySummary {
  roster?: unknown[];
  runnerConfig?: {
    bots?: number | string | null;
    nations?: number | string | null;
    maxSteps?: number | null;
  } | null;
  finalState?: {
    opponents?: unknown[];
  } | null;
  matchStory?: {
    entertainmentScore?: number;
    grade?: string;
    summary?: string;
    spectatorHighlights?: string[];
    boringnessWarnings?: string[];
  } | null;
}

function normalizeSpectatorTelemetry(
  value: unknown,
): AiLeagueSpectatorTelemetry | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AiLeagueSpectatorTelemetry>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.agents) ||
    !Array.isArray(candidate.relationships) ||
    !Array.isArray(candidate.events) ||
    !Array.isArray(candidate.communicationThreads) ||
    !Array.isArray(candidate.timelineBuckets)
  ) {
    return null;
  }
  return candidate as AiLeagueSpectatorTelemetry;
}

function relationshipFor(
  telemetry: AiLeagueSpectatorTelemetry,
  fromAgentID: string,
  toAgentID: string,
): AiLeagueSpectatorRelationship | null {
  return (
    telemetry.relationships.find(
      (relationship) =>
        relationship.fromAgentID === fromAgentID &&
        relationship.toAgentID === toAgentID,
    ) ?? null
  );
}

function agentName(
  telemetry: AiLeagueSpectatorTelemetry,
  agentID: string,
): string {
  return (
    aiLeagueSpectatorDisplayName(
      telemetry.agents.find((agent) => agent.agentID === agentID)?.username ??
        agentID,
    )
  );
}

function timelineEventLabel(event: AiLeagueSpectatorEvent): string {
  const prefix =
    event.kind === "alliance_break"
      ? "break"
      : event.kind === "alliance_formed"
        ? "pact"
        : event.kind === "nuke"
          ? "nuke"
          : event.kind === "attack"
            ? "war"
            : event.kind === "trade"
              ? "trade"
              : event.kind === "target_call"
                ? "target"
                : event.kind;
  return `${prefix} ${event.turnNumber}`;
}

function readStoredPanelLayout(
  storageKey: string,
): Partial<CSSStyleDeclaration> | null {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === null) {
      return null;
    }
    const parsed = JSON.parse(stored) as Record<string, string>;
    return {
      left: parsed.left,
      top: parsed.top,
      right: parsed.right,
      width: parsed.width,
      height: parsed.height,
      maxHeight: parsed.maxHeight,
    };
  } catch {
    return null;
  }
}

function persistPanelLayout(storageKey: string, overlay: HTMLElement) {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        left: overlay.style.left,
        top: overlay.style.top,
        right: overlay.style.right,
        width: overlay.style.width,
        height: overlay.style.height,
        maxHeight: overlay.style.maxHeight,
      }),
    );
  } catch {
    // Layout persistence is optional.
  }
}

function actionLabel(decision: AiLeagueDecisionLogEntry): string {
  if (
    decision.selectedActionKind === "attack" &&
    (decision.selectedLegalActionId.startsWith("expand:") ||
      decision.selectedActionMetadata?.expansion === true)
  ) {
    return "expand";
  }
  if (decision.selectedActionKind === "quick_chat") {
    return "chat";
  }
  if (decision.selectedActionKind === "target_player") {
    return "target";
  }
  return decision.selectedActionKind;
}

function actionLabelFromKind(kind: string): string {
  if (kind === "quick_chat") return "chat";
  if (kind === "target_player") return "target";
  return kind;
}

function numericCount(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function shortText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
