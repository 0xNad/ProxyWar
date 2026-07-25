import {
  aiLeagueSpectatorDisplayName,
  aiLeagueSpectatorText,
  isAiLeagueNativeSpectatorUiEnabled,
} from "./AiLeagueReplayMode";
import {
  mountReplayScopedLeagueClipControl,
  type ReplayScopedLeagueClipControlHandle,
} from "./ReplayClipControl";
import { REPLAY_RENDER_FAST_FORWARD_PARAM } from "./ReplayRenderFastForward";
import { ReplaySpeedMultiplier } from "./utilities/ReplaySpeedMultiplier";
import { translateText } from "./Utils";

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
  planObjective?: string;
  planRationale?: string;
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

interface AiLeagueReplayFrameAlliance {
  other: string;
  expiresAt: number;
  hasExtensionRequest: boolean;
}

interface AiLeagueReplayFramePlayer {
  playerID: string;
  smallID: number;
  clientID: string | null;
  username: string;
  displayName: string;
  x: number;
  y: number;
  // Real engine on-map color (PlayerView.territoryColor()), as an rgb string.
  // Optional so older frame payloads degrade to the identity palette.
  color?: string;
  tilesOwned: number;
  allies: number[];
  // smallIDs of rivals this player is actively attacking (PlayerView.targets()).
  targets?: number[];
  embargoes: string[];
  alliances: AiLeagueReplayFrameAlliance[];
}

interface AiLeagueReplayFrameEventDetail {
  tick: number;
  turnNumber: number;
  players: AiLeagueReplayFramePlayer[];
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
  // Legacy relationship-matrix telemetry. The N×N trust/distrust/tension matrix
  // it backed was removed in favor of the engine-authoritative diplomacy strip;
  // the field is still validated as an array for telemetry-shape compatibility
  // but no longer typed or consumed.
  relationships: unknown[];
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
  /** Canonical record range, used to expose every valid Clip v1 bucket. */
  replayMaxTurn?: number | null;
  artifactAvailability?: AiLeagueReplayArtifactAvailability;
  detailsLoading?: boolean;
  onReplaySpeedChange?: (speed: ReplaySpeedMultiplier) => void;
}

export interface AiLeagueReplayArtifactAvailability {
  visualReport?: boolean;
  spectatorTelemetry?: boolean;
  decisions?: boolean;
  summary?: boolean;
}

interface AiLeagueReplayOverlayHandle {
  hydrate(nextInput: Partial<AiLeagueReplayOverlayInput>): void;
  dispose(): void;
}

export function mountAiLeagueReplayOverlay(input: AiLeagueReplayOverlayInput) {
  document.getElementById("ai-league-replay-overlay")?.remove();
  document.getElementById("ai-league-social-transcript")?.remove();
  document.getElementById("ai-league-headline-event")?.remove();
  document.body.classList.add("ai-league-replay-mode");
  document.body.classList.toggle(
    "ai-league-native-spectator-ui",
    isAiLeagueNativeSpectatorUiEnabled(),
  );
  const spectatorTelemetry = normalizeSpectatorTelemetry(
    input.spectatorTelemetry,
  );
  let currentInput: AiLeagueReplayOverlayInput = {
    ...input,
    spectatorTelemetry,
  };
  const overlay = document.createElement("aside");
  overlay.id = "ai-league-replay-overlay";
  overlay.innerHTML = overlayHtml(currentInput);
  document.body.appendChild(overlay);
  mountReplayPanelDisclosure(overlay);
  mountReplayPanelControls(overlay);
  let clipControl = mountReplayDetailsBindings(overlay, currentInput);
  mountReplayJumpControls(document);
  let disposed = false;

  return {
    hydrate(nextInput: Partial<AiLeagueReplayOverlayInput>) {
      if (disposed) {
        return;
      }
      const nextTelemetry =
        nextInput.spectatorTelemetry === undefined
          ? currentInput.spectatorTelemetry
          : normalizeSpectatorTelemetry(nextInput.spectatorTelemetry);
      currentInput = {
        ...currentInput,
        ...nextInput,
        spectatorTelemetry: nextTelemetry,
      };
      const details = overlay.querySelector<HTMLElement>(
        "[data-ai-league-details]",
      );
      if (details === null || !overlay.isConnected) {
        return;
      }
      details.innerHTML = overlayDetailsHtml(currentInput);
      const previousClipControl = clipControl;
      clipControl = mountReplayDetailsBindings(overlay, currentInput);
      previousClipControl?.dispose();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clipControl?.dispose();
      clipControl = null;
      disposeReplayOverlay(overlay);
    },
  } satisfies AiLeagueReplayOverlayHandle;
}

function disposeReplayOverlay(overlay: HTMLElement) {
  // A stale handle must never tear down a newer replay mounted into the same
  // document. Every global hook below belongs to the current overlay only.
  if (document.getElementById("ai-league-replay-overlay") !== overlay) {
    return;
  }
  const win = window as Window & {
    __aiLeaguePanelDisclosureCleanup?: () => void;
    __aiLeaguePanelControlsCleanup?: () => void;
    __aiLeagueReplayJumpCleanup?: () => void;
    __aiLeagueHeadlineCleanup?: () => void;
    __aiLeagueDiplomacyCleanup?: () => void;
    __aiLeagueSocialBubblesCleanup?: () => void;
  };
  win.__aiLeaguePanelDisclosureCleanup?.();
  win.__aiLeaguePanelControlsCleanup?.();
  win.__aiLeagueReplayJumpCleanup?.();
  win.__aiLeagueHeadlineCleanup?.();
  win.__aiLeagueDiplomacyCleanup?.();
  win.__aiLeagueSocialBubblesCleanup?.();
  delete win.__aiLeaguePanelDisclosureCleanup;
  delete win.__aiLeaguePanelControlsCleanup;
  delete win.__aiLeagueReplayJumpCleanup;
  delete win.__aiLeagueHeadlineCleanup;
  delete win.__aiLeagueDiplomacyCleanup;
  delete win.__aiLeagueSocialBubblesCleanup;
  overlay.remove();
  document.getElementById("ai-league-social-transcript")?.remove();
  document.getElementById("ai-league-headline-event")?.remove();
  document.body.classList.remove(
    "ai-league-replay-mode",
    "ai-league-native-spectator-ui",
  );
}

function mountReplayDetailsBindings(
  overlay: HTMLElement,
  input: AiLeagueReplayOverlayInput,
): ReplayScopedLeagueClipControlHandle | null {
  const telemetry =
    input.spectatorTelemetry as AiLeagueSpectatorTelemetry | null;
  mountAiLeagueSocialTranscript(input.decisions, telemetry);
  mountAiLeagueHeadlineEvent(input.decisions, telemetry);
  mountAiLeagueDiplomacyStrip(overlay, input.decisions, telemetry);
  mountAiLeagueTalksToggle(overlay, telemetry);
  mountAiLeagueDecisionLogExpander(overlay, input.decisions);
  const clipContainer = overlay.querySelector<HTMLElement>(
    "[data-ai-league-clip]",
  );
  return clipContainer === null
    ? null
    : mountReplayScopedLeagueClipControl({
        container: clipContainer,
        runKey: input.runID,
        renderableThroughTurn: input.replayMaxTurn,
      });
}

const AI_LEAGUE_MOBILE_BREAKPOINT = 740;

function isNarrowReplayViewport(): boolean {
  return window.innerWidth <= AI_LEAGUE_MOBILE_BREAKPOINT;
}

function mountReplayPanelDisclosure(overlay: HTMLElement) {
  const toggle = overlay.querySelector<HTMLButtonElement>(
    "[data-ai-league-toggle]",
  );
  const body = overlay.querySelector<HTMLElement>(".ai-league-body");
  if (toggle === null || body === null) {
    return;
  }

  const setExpanded = (expanded: boolean) => {
    overlay.classList.toggle("collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = translateText(
      expanded ? "ai_league_replay.panel_hide" : "ai_league_replay.panel_show",
    );
  };

  let narrow = isNarrowReplayViewport();
  overlay.classList.toggle("mobile-bottom-sheet", narrow);
  setExpanded(!narrow);
  toggle.addEventListener("click", () => {
    setExpanded(overlay.classList.contains("collapsed"));
  });

  const onResize = () => {
    const nextNarrow = isNarrowReplayViewport();
    if (nextNarrow === narrow) {
      return;
    }
    narrow = nextNarrow;
    overlay.classList.toggle("mobile-bottom-sheet", narrow);
    // Crossing the breakpoint resets to the useful default for that layout:
    // map-first on phones and the full inspector on desktop.
    setExpanded(!narrow);
  };
  const win = window as Window & {
    __aiLeaguePanelDisclosureCleanup?: () => void;
  };
  win.__aiLeaguePanelDisclosureCleanup?.();
  window.addEventListener("resize", onResize);
  win.__aiLeaguePanelDisclosureCleanup = () => {
    window.removeEventListener("resize", onResize);
  };
}

function mountReplayPanelControls(overlay: HTMLElement) {
  const storageKey = "ai-league-spectator-layout-v1";
  let narrow = isNarrowReplayViewport();
  if (!narrow) {
    const stored = readStoredPanelLayout(storageKey);
    if (stored !== null) {
      Object.assign(overlay.style, stored);
    }
  }

  const dragHandle = overlay.querySelector<HTMLElement>(
    "[data-ai-league-drag]",
  );
  let dragState: {
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null = null;
  dragHandle?.addEventListener("mousedown", (event) => {
    if (narrow) {
      return;
    }
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
  let resizeState: {
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null = null;
  resizeHandle?.addEventListener("mousedown", (event) => {
    if (narrow) {
      return;
    }
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
    if (narrow) {
      return;
    }
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
        clamp(
          resizeState.height + event.clientY - resizeState.startY,
          260,
          window.innerHeight - 24,
        ),
      )}px`;
      overlay.style.maxHeight = "none";
      persistPanelLayout(storageKey, overlay);
    }
  };
  const onUp = () => {
    dragState = null;
    resizeState = null;
  };
  const onResize = () => {
    const nextNarrow = isNarrowReplayViewport();
    if (nextNarrow === narrow) {
      return;
    }
    narrow = nextNarrow;
    dragState = null;
    resizeState = null;
    overlay.removeAttribute("style");
    if (!narrow) {
      const stored = readStoredPanelLayout(storageKey);
      if (stored !== null) {
        Object.assign(overlay.style, stored);
      }
    }
  };
  // Same remount-cleanup pattern as every other document-level mount in this
  // file: without it each overlay remount stacks another listener pair, and
  // every onMove closure pins the previous detached overlay element.
  const win = window as Window & {
    __aiLeaguePanelControlsCleanup?: () => void;
  };
  win.__aiLeaguePanelControlsCleanup?.();
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  window.addEventListener("resize", onResize);
  win.__aiLeaguePanelControlsCleanup = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    window.removeEventListener("resize", onResize);
  };
  overlay
    .querySelector<HTMLButtonElement>("[data-ai-league-reset-layout]")
    ?.addEventListener("click", () => {
      localStorage.removeItem(storageKey);
      overlay.removeAttribute("style");
    });
}

// Wires the collapsible "Show talks" toggle for the diplomacy comm-thread feed.
// (Formerly mountSpectatorRelationshipInteractions, which also drove the now-
// removed relationship matrix; the matrix is gone, so only the toggle remains.)
function mountAiLeagueTalksToggle(
  overlay: HTMLElement,
  telemetry: AiLeagueSpectatorTelemetry | null,
) {
  if (telemetry === null) {
    return;
  }
  const toggle = overlay.querySelector<HTMLButtonElement>(
    "[data-spectator-talks-toggle]",
  );
  const comms = overlay.querySelector<HTMLElement>("[data-spectator-comms]");
  if (toggle === null || comms === null) {
    return;
  }
  toggle.addEventListener("click", () => {
    const nowHidden = !comms.hidden;
    comms.hidden = nowHidden;
    toggle.setAttribute("aria-expanded", String(!nowHidden));
    toggle.textContent = nowHidden
      ? translateText("ai_league_replay.talks_show")
      : translateText("ai_league_replay.talks_hide");
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
    const preview = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-ai-league-preview-turn]",
    );
    if (preview !== null && preview !== undefined) {
      const turnNumber = Number(preview.dataset.aiLeaguePreviewTurn);
      if (!Number.isSafeInteger(turnNumber) || turnNumber < 0) {
        return;
      }
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-pause", {
          detail: { paused: true },
          bubbles: true,
        }),
      );
      // Preview always starts a fresh replay document. Even a same/forward
      // in-process jump can overshoot while fastest-playback frames already
      // queued ahead of the pause are draining. The render fast-forward lane
      // coalesces the restart, and Main pauses before the exact target jump.
      const url = new URL(window.location.href);
      url.searchParams.set("replay", "");
      url.searchParams.set("turn", String(turnNumber));
      url.searchParams.set(
        REPLAY_RENDER_FAST_FORWARD_PARAM,
        String(turnNumber),
      );
      url.searchParams.set("clipPreview", "1");
      const navigation = new CustomEvent(
        "ai-league-replay-preview-navigation",
        {
          detail: { turnNumber, url: url.toString() },
          cancelable: true,
        },
      );
      if (root.dispatchEvent(navigation)) {
        window.location.href = url.toString();
      }
      return;
    }
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

interface AiLeagueHeadlineEvent {
  turnNumber: number;
  sequence: number;
  kind: "betrayal" | "elimination" | "first_strike";
  toneClass: string;
  text: string;
}

function headlineEventsFor(
  telemetry: AiLeagueSpectatorTelemetry | null,
): AiLeagueHeadlineEvent[] {
  if (telemetry === null) {
    return [];
  }
  const headlines: AiLeagueHeadlineEvent[] = [];
  const firstStrikeSeen = new Set<string>();
  const ordered = [...telemetry.events].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  for (const event of ordered) {
    const actor = aiLeagueSpectatorDisplayName(event.actorName);
    const target = event.targetName
      ? aiLeagueSpectatorDisplayName(event.targetName)
      : null;
    if (
      (event.kind === "alliance_break" || event.tone === "betrayal") &&
      target !== null
    ) {
      headlines.push({
        turnNumber: event.turnNumber,
        sequence: event.sequence,
        kind: "betrayal",
        toneClass: "betrayal",
        text: translateText("ai_league_replay.headline_betrayal", {
          actor,
          target,
        }),
      });
      continue;
    }
    if (event.kind === "elimination" && target !== null) {
      headlines.push({
        turnNumber: event.turnNumber,
        sequence: event.sequence,
        kind: "elimination",
        toneClass: "war",
        text: translateText("ai_league_replay.headline_elimination", {
          actor,
          target,
        }),
      });
      continue;
    }
    if (
      (event.kind === "attack" || event.kind === "target_call") &&
      target !== null
    ) {
      const pairKey = `${event.actorAgentID}->${event.targetAgentID ?? target}`;
      if (!firstStrikeSeen.has(pairKey)) {
        firstStrikeSeen.add(pairKey);
        headlines.push({
          turnNumber: event.turnNumber,
          sequence: event.sequence,
          kind: "first_strike",
          toneClass: "threat",
          text: translateText("ai_league_replay.headline_first_strike", {
            actor,
            target,
          }),
        });
      }
    }
  }
  return headlines;
}

function mountAiLeagueHeadlineEvent(
  decisions: readonly AiLeagueDecisionLogEntry[],
  telemetry: AiLeagueSpectatorTelemetry | null,
) {
  const win = window as Window & {
    __aiLeagueHeadlineCleanup?: () => void;
  };
  win.__aiLeagueHeadlineCleanup?.();
  const headlines = headlineEventsFor(telemetry);
  void decisions;
  // Headlines are the marquee moments (betrayals, eliminations, nukes) — hold
  // them at least as long as the social transcript holds an important line
  // (theatreEventBubbleDuration tops out at 700 turns; 60 turns blinked past
  // in under a second at Max replay speed).
  const HEADLINE_VISIBLE_TURNS = 300;
  const lowerThird = document.createElement("div");
  lowerThird.id = "ai-league-headline-event";
  lowerThird.setAttribute("aria-live", "polite");
  lowerThird.hidden = true;
  document.body.appendChild(lowerThird);
  if (headlines.length === 0) {
    win.__aiLeagueHeadlineCleanup = () => {
      lowerThird.remove();
    };
    return;
  }
  const onFrame = (event: Event) => {
    const detail = (event as CustomEvent<AiLeagueReplayFrameEventDetail>)
      .detail;
    if (!detail || !Number.isFinite(detail.turnNumber)) {
      return;
    }
    const active = headlines
      .filter(
        (headline) =>
          headline.turnNumber <= detail.turnNumber &&
          detail.turnNumber <= headline.turnNumber + HEADLINE_VISIBLE_TURNS,
      )
      .sort(
        (a, b) => b.turnNumber - a.turnNumber || b.sequence - a.sequence,
      )[0];
    if (active === undefined) {
      lowerThird.hidden = true;
      lowerThird.innerHTML = "";
      return;
    }
    lowerThird.hidden = false;
    lowerThird.className = `ai-league-headline ${escapeHtml(active.toneClass)}`;
    lowerThird.innerHTML = `<span class="ai-league-headline-tag">${escapeHtml(headlineKindLabel(active.kind))}</span><span class="ai-league-headline-text">${escapeHtml(active.text)}</span>`;
  };
  document.addEventListener("ai-league-replay-frame", onFrame);
  win.__aiLeagueHeadlineCleanup = () => {
    document.removeEventListener("ai-league-replay-frame", onFrame);
    lowerThird.remove();
  };
}

function headlineKindLabel(kind: AiLeagueHeadlineEvent["kind"]): string {
  if (kind === "betrayal") {
    return translateText("ai_league_replay.headline_tag_betrayal");
  }
  if (kind === "elimination") {
    return translateText("ai_league_replay.headline_tag_elimination");
  }
  return translateText("ai_league_replay.headline_tag_first_strike");
}

function overlayHtml(input: AiLeagueReplayOverlayInput): string {
  return `
    <style>
      /*
       * Chrome is aligned to the premiere overlay so the two spectator panels
       * read as one product: same geometry, radius, blur and type stack. The
       * premiere is the flagship surface, so it sets the direction rather than
       * the reverse. Only chrome is shared here — the button system and control
       * layout deliberately stay put until the two panels converge into one
       * component, because matching controls that behave differently would
       * promise capabilities this panel does not have.
       */
      #ai-league-replay-overlay {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 50000;
        width: min(376px, calc(100vw - 24px));
        max-height: calc(100vh - 24px);
        overflow: hidden;
        display: grid;
        grid-template-rows: auto 1fr;
        border: 1px solid var(--pw-line-strong, #3a4656);
        border-radius: var(--pw-r-xl, 18px);
        background: var(--pw-glass-strong, rgba(10, 14, 20, 0.95));
        color: var(--pw-text, #edf1f7);
        box-shadow: var(--pw-shadow, 0 26px 74px rgba(0, 0, 0, 0.52));
        backdrop-filter: blur(18px) saturate(1.15);
        font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-variant-numeric: tabular-nums;
      }
      body.ai-league-native-spectator-ui #ai-league-replay-overlay {
        top: auto;
        right: auto;
        left: 12px;
        bottom: 12px;
        width: min(376px, calc(100vw - 24px));
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
        border-bottom: 1px solid var(--pw-line, #2a3442);
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
      /*
       * The run id is support/debug provenance, not a headline. Left to wrap it
       * took three lines and dominated the header. Keep it to one line with the
       * full value in the tooltip (and selectable for copy/paste). Mobile
       * already did this; it was only ever gated behind a breakpoint.
       */
      .ai-league-run-id {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
        user-select: all;
        cursor: text;
      }
      .ai-league-header-actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      #ai-league-replay-overlay button {
        border: 1px solid var(--pw-line-strong, #3a4656);
        background: var(--pw-surface-2, #18202b);
        color: var(--pw-text, #edf1f7);
        border-radius: 8px;
        padding: 6px 8px;
        cursor: pointer;
        font-weight: 700;
      }
      #ai-league-replay-overlay button:hover {
        border-color: var(--pw-accent, #f4a64a);
        color: var(--pw-accent, #f4a64a);
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
        border-right: 2px solid var(--pw-line-strong, #3a4656);
        border-bottom: 2px solid var(--pw-line-strong, #3a4656);
      }
      .ai-league-muted {
        color: var(--pw-muted, #a4afbf);
        font-size: 12px;
      }
      .ai-league-metrics {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-bottom: 10px;
      }
      .ai-league-metric {
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 6px;
        background: var(--pw-surface-2, #18202b);
        font-size: 12px;
      }
      .ai-league-metric b {
        display: block;
        font-size: 14px;
        font-variant-numeric: tabular-nums;
      }
      .ai-league-metric-share {
        display: block;
        margin-top: 1px;
        font-size: 10px;
        font-weight: 600;
        opacity: 0.75;
      }
      .ai-league-metric.warn {
        background: var(--pw-caution-soft, rgba(251, 191, 36, 0.14));
        border-color: var(--pw-caution, #fbbf24);
        color: var(--pw-caution-text, #fde68a);
      }
      .ai-league-actions {
        margin: 0 0 10px;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .ai-league-playstyle {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
        margin: 0 0 10px;
        color: var(--pw-text-dim, #cbd5e1);
        font-size: 12px;
      }
      .ai-league-standings {
        display: grid;
        gap: 5px;
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 9px;
        margin: 0 0 10px;
        background: var(--pw-surface, #111720);
      }
      .ai-league-standings-title {
        font-weight: 900;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .ai-league-diplo-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        font-weight: 700;
      }
      .ai-league-diplo-rank {
        min-width: 16px;
        color: var(--pw-muted, #a4afbf);
        font-variant-numeric: tabular-nums;
      }
      .ai-league-color-dot {
        flex: 0 0 auto;
        width: 11px;
        height: 11px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.35);
      }
      .ai-league-diplo-name {
        font-weight: 900;
        color: var(--pw-text, #edf1f7);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        /* Was a flat 96px, which truncated the identifying part of most league
           names ("K1Z Mickey …", "Captain Unde…"). Let the name take the row's
           free space instead; the rank, dot and share column are fixed. */
        flex: 1 1 auto;
        min-width: 0;
      }
      .ai-league-diplo-share {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
        font-weight: 900;
        color: var(--pw-text-dim, #cbd5e1);
      }
      /*
       * Diplomacy stances belong to the ranked row directly above them. They
       * used to render flush-left at nearly the same size and weight as a
       * ranked row, so a stance entry ("softmaxwell ⊘") read as another player
       * — a 9-player match looked like ~14 entries. Indent them under the name
       * column, bind them to the parent row with a rule, and demote the type
       * so the ranking stays the dominant structure.
       */
      .ai-league-diplo-stances {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 2px 0 6px 20px;
        padding-left: 8px;
        border-left: 1px solid var(--pw-line, #2a3442);
        flex-wrap: wrap;
        font-size: 11px;
        font-weight: 600;
        color: var(--pw-muted, #a4afbf);
      }
      .ai-league-stance {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .ai-league-stance .ai-league-color-dot {
        width: 9px;
        height: 9px;
      }
      .ai-league-stance-glyph {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-weight: 900;
        line-height: 0;
      }
      .ai-league-stance-glyph svg {
        display: block;
      }
      .ai-league-stance-renew {
        font-size: 11px;
        line-height: 1;
      }
      .ai-league-stance.ally .ai-league-stance-glyph {
        color: var(--pw-positive, #34d399);
      }
      .ai-league-stance.war .ai-league-stance-glyph {
        color: var(--pw-danger, #f87171);
      }
      .ai-league-stance.embargo .ai-league-stance-glyph {
        color: var(--pw-caution, #fbbf24);
      }
      .ai-league-stance.expiring {
        opacity: 0.55;
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
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 8px;
        background: var(--pw-surface-2, #18202b);
      }
      .ai-league-feed-item strong {
        display: block;
      }
      .ai-league-feed-item p {
        margin: 2px 0 0;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .ai-league-chat-bubble {
        display: inline-block;
        margin: 5px 0 0;
        padding: 6px 8px;
        border: 1px solid var(--pw-info-soft, rgba(56, 189, 248, 0.16));
        border-radius: 12px 12px 12px 3px;
        background: var(--pw-info-soft, rgba(56, 189, 248, 0.16));
        color: var(--pw-text, #edf1f7);
        font-weight: 800;
      }
      .ai-league-match-setup {
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 9px;
        margin-bottom: 10px;
        background: var(--pw-surface-2, #18202b);
      }
      .ai-league-politics {
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 9px;
        margin: 0 0 10px;
        background: var(--pw-surface, #111720);
      }
      .ai-league-politics-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }
      .ai-league-talks[hidden] {
        display: none;
      }
      .ai-league-comms {
        display: grid;
        gap: 8px;
        max-height: 360px;
        overflow: auto;
        margin-bottom: 10px;
      }
      .ai-league-thread {
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 8px;
        background: var(--pw-surface, #111720);
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
        color: var(--pw-info, #56c7f5);
        font-size: 11px;
      }
      .ai-league-message p {
        margin: 1px 0 0;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .ai-league-decision {
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 9px;
        margin: 8px 0;
        background: var(--pw-surface, #111720);
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
        background: var(--pw-info-soft, rgba(56, 189, 248, 0.16));
        color: var(--pw-info, #56c7f5);
        font-size: 12px;
        font-weight: 800;
      }
      .ai-league-clip {
        display: grid;
        gap: 7px;
        margin: 12px 0;
      }
      .ai-league-clip-selector {
        display: grid;
        gap: 7px;
        min-width: 0;
        margin: 0;
        padding: 8px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 8px;
        background: #f8fafc;
      }
      .ai-league-clip-selector legend {
        padding: 0 4px;
        color: #334155;
        font-size: 12px;
        font-weight: 900;
      }
      .ai-league-clip-selected {
        color: #17202a;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        font-weight: 900;
      }
      .ai-league-clip-selector input[type="range"] {
        width: 100%;
        margin: 0;
      }
      .ai-league-clip-moment-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      .ai-league-clip-moment-actions button:disabled {
        cursor: default;
        opacity: 0.45;
      }
      .ai-league-badge.ok {
        background: var(--pw-positive-soft, rgba(16, 185, 129, 0.18));
        color: var(--pw-positive-text, #a7f3d0);
      }
      /*
       * Rejected/invalid decision badge: neutral slate, NOT red. Red is
       * reserved exclusively for war/betrayal signals (the war glyph and
       * betrayal social tones) so the aggression cue stays unambiguous.
       */
      .ai-league-badge.bad {
        background: var(--pw-surface-3, #212b38);
        color: var(--pw-muted, #a4afbf);
      }
      .ai-league-badge.warn {
        background: var(--pw-caution-soft, rgba(251, 191, 36, 0.14));
        color: var(--pw-caution-text, #fde68a);
      }
      .ai-league-directive {
        margin: 4px 0 0;
        color: var(--pw-text-dim, #cbd5e1);
        font-size: 12px;
      }
      .ai-league-directive b {
        color: var(--pw-text, #edf1f7);
      }
      .ai-league-decisions-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin: 12px 0 0;
      }
      .ai-league-decisions-title {
        font-weight: 900;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .ai-league-decision-extra[hidden] {
        display: none;
      }
      #ai-league-replay-overlay code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow-wrap: anywhere;
      }
      #ai-league-replay-overlay a {
        color: var(--pw-info, #56c7f5);
        font-weight: 700;
        text-decoration: none;
      }
      /*
       * Spectator/replay declutter. These surfaces all assume a LOCAL HUMAN
       * player (attack-ratio slider, build menu, your-nation sidebar, emoji
       * picker, action/quick-chat panels, spawn pickers, player-action modals).
       * A replay has no local player, so they are dead clutter / a credibility
       * problem. Hiding the host custom-elements is the minimal replay-scoped
       * fix: the ai-league-replay-mode body class is added ONLY by
       * mountAiLeagueReplayOverlay (ai-league + Coworld replays), so live play
       * is untouched. We deliberately KEEP spectator-useful surfaces visible:
       * events-display (event log), leader-board / team-stats (standings),
       * game-right-sidebar + replay-panel (the replay scrubber/speed/options),
       * win-modal + alert-frame (outcome reveal).
       */
      body.ai-league-replay-mode heads-up-message,
      body.ai-league-replay-mode control-panel,
      body.ai-league-replay-mode unit-display,
      body.ai-league-replay-mode build-menu,
      body.ai-league-replay-mode emoji-table,
      body.ai-league-replay-mode player-panel,
      body.ai-league-replay-mode chat-display,
      body.ai-league-replay-mode chat-modal,
      body.ai-league-replay-mode send-resource-modal,
      body.ai-league-replay-mode player-moderation-modal,
      body.ai-league-replay-mode spawn-timer,
      body.ai-league-replay-mode immunity-timer {
        display: none !important;
      }
      /*
       * game-left-sidebar is the local player's nation/team card. Hide it in
       * replay too, but NOT when the native-spectator showcase is active — that
       * mode manages game-left-sidebar itself (it hides the personal one and
       * mounts its own native leaderboard). The :not(...) keeps the two modes
       * from fighting over the same element.
       */
      body.ai-league-replay-mode:not(.ai-league-native-spectator-ui) game-left-sidebar {
        display: none !important;
      }
      /*
       * The raw game id is useful to a player who wants to report or share their
       * own match. In a replay it is provenance nobody asked for — and for
       * Coworld episodes the id IS the fixed seed (e.g. "COWRLD01"), identical
       * in every match, so it identifies nothing. The run id in the panel header
       * is the real identifier here.
       */
      body.ai-league-replay-mode .ai-league-game-id {
        display: none !important;
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
        border: 1px solid var(--pw-line-strong, #3a4656);
        border-radius: 8px;
        padding: 8px 10px;
        background: var(--pw-glass-strong, rgba(10, 14, 20, 0.95));
        box-shadow: var(--pw-shadow-soft, 0 12px 32px rgba(0, 0, 0, 0.35));
      }
      .ai-league-social-transcript-line b {
        display: block;
        color: var(--pw-text, #edf1f7);
      }
      .ai-league-social-transcript-line span {
        color: var(--pw-text-dim, #cbd5e1);
      }
      .ai-league-social-tone {
        border-radius: 999px;
        padding: 2px 7px;
        background: var(--pw-info-soft, rgba(56, 189, 248, 0.16));
        color: var(--pw-info, #56c7f5);
        font-size: 11px;
        font-weight: 900;
      }
      .ai-league-social-tone.betrayal {
        background: var(--pw-mk-betrayal-soft, rgba(248, 113, 113, 0.18));
        color: var(--pw-mk-betrayal, #f87171);
      }
      .ai-league-social-tone.conspiracy {
        background: var(--pw-mk-turning-soft, rgba(167, 139, 250, 0.18));
        color: var(--pw-mk-turning, #a78bfa);
      }
      .ai-league-social-tone.threat {
        background: var(--pw-caution-soft, rgba(251, 191, 36, 0.14));
        color: var(--pw-caution, #fbbf24);
      }
      .ai-league-social-tone.war {
        background: var(--pw-danger-soft, rgba(239, 68, 68, 0.16));
        color: var(--pw-danger, #f87171);
      }
      .ai-league-social-tone.trade {
        background: var(--pw-positive-soft, rgba(16, 185, 129, 0.18));
        color: var(--pw-positive-text, #a7f3d0);
      }
      #ai-league-headline-event {
        position: fixed;
        left: 50%;
        bottom: 9%;
        transform: translateX(-50%);
        z-index: 49997;
        pointer-events: none;
        display: inline-flex;
        align-items: center;
        gap: 9px;
        max-width: min(640px, 92vw);
        padding: 9px 15px;
        border-radius: 10px;
        background: rgba(15, 23, 42, 0.82);
        color: #fff;
        box-shadow: 0 12px 34px rgba(15, 23, 42, 0.3);
        backdrop-filter: blur(8px);
        font: 800 15px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: left;
      }
      .ai-league-headline-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #ai-league-headline-event[hidden] {
        display: none;
      }
      .ai-league-headline-tag {
        flex: 0 0 auto;
        border-radius: 999px;
        padding: 2px 8px;
        background: rgba(255, 255, 255, 0.18);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ai-league-headline.betrayal {
        background: rgba(136, 19, 55, 0.9);
      }
      .ai-league-headline.war {
        background: rgba(153, 27, 27, 0.9);
      }
      .ai-league-headline.threat {
        background: rgba(124, 45, 18, 0.9);
      }
      @media (max-width: 740px) {
        #ai-league-replay-overlay,
        body.ai-league-native-spectator-ui #ai-league-replay-overlay {
          top: auto;
          right: 8px;
          left: 8px;
          bottom: max(8px, env(safe-area-inset-bottom));
          width: auto;
          max-height: min(58vh, 520px);
          border-radius: 14px;
        }
        #ai-league-replay-overlay:not(.collapsed) {
          height: min(58vh, 520px);
        }
        #ai-league-replay-overlay.collapsed {
          width: auto;
          max-height: none;
        }
        #ai-league-replay-overlay header {
          align-items: center;
          min-height: 56px;
          box-sizing: border-box;
          padding: 6px 8px 6px 12px;
          gap: 6px;
          cursor: default;
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
          min-width: 44px;
          min-height: 44px;
          padding: 9px 12px;
        }
        #ai-league-replay-overlay .ai-league-resize-handle {
          display: none;
        }
        .ai-league-metrics {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        #ai-league-social-transcript {
          display: none;
        }
        #ai-league-headline-event {
          bottom: calc(72px + env(safe-area-inset-bottom));
          width: calc(100vw - 16px);
          max-width: none;
          box-sizing: border-box;
          overflow: hidden;
          white-space: nowrap;
        }
        #ai-league-replay-overlay:not(.collapsed) ~ #ai-league-headline-event {
          bottom: calc(min(58vh, 520px) + 16px + env(safe-area-inset-bottom));
        }
      }
    </style>
    <header data-ai-league-drag>
      <div>
        <h2>${escapeHtml(translateText("ai_league_replay.title"))}</h2>
        <div class="ai-league-muted ai-league-run-id" title="${escapeHtml(input.runID)}">${escapeHtml(input.runID)}</div>
      </div>
      <div class="ai-league-header-actions">
        <button type="button" data-ai-league-reset-layout title="${escapeHtml(translateText("ai_league_replay.reset_layout_title"))}">${escapeHtml(translateText("ai_league_replay.reset_layout"))}</button>
        <button type="button" data-ai-league-toggle aria-expanded="true" aria-controls="ai-league-replay-panel-body">${escapeHtml(translateText("ai_league_replay.panel_hide"))}</button>
      </div>
    </header>
    <div class="ai-league-body" id="ai-league-replay-panel-body">
      <section class="ai-league-standings" data-ai-league-diplomacy aria-label="${escapeHtml(translateText("ai_league_replay.standings_title"))}">
        <div class="ai-league-standings-title">${escapeHtml(translateText("ai_league_replay.standings_title"))}</div>
        <div data-ai-league-diplomacy-rows>
          <div class="ai-league-muted">${escapeHtml(translateText("ai_league_replay.standings_waiting"))}</div>
        </div>
      </section>
      <div data-ai-league-details>${overlayDetailsHtml(input)}</div>
    </div>
    <div class="ai-league-resize-handle" data-ai-league-resize aria-hidden="true"></div>`;
}

function overlayDetailsHtml(input: AiLeagueReplayOverlayInput): string {
  const localRejectedCount = input.decisions.filter(
    (decision) => !decision.result.accepted,
  ).length;
  const localFallbackCount = input.decisions.filter(
    (decision) => decision.fallbackUsed,
  ).length;
  const localActionCounts = input.decisions.reduce<Record<string, number>>(
    (counts, decision) => {
      const kind = actionLabel(decision);
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const decisionCount =
    nonNegativeCount(input.summary?.decisionCount) ?? input.decisions.length;
  const rejectedCount =
    nonNegativeCount(input.summary?.rejectedCount) ?? localRejectedCount;
  const fallbackCount =
    nonNegativeCount(input.summary?.fallbackCount) ?? localFallbackCount;
  const actionCounts =
    summaryActionCounts(input.summary?.actionCounts) ?? localActionCounts;
  const playstyleKinds = Object.entries(actionCounts)
    .filter(([kind]) => kind !== "hold" && kind !== "spawn")
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([kind]) => kind);
  const agentCount = input.summary?.roster?.length ?? 0;
  const bots = input.summary?.runnerConfig?.bots ?? null;
  const nations = input.summary?.runnerConfig?.nations ?? null;
  const maxSteps = input.summary?.runnerConfig?.maxSteps ?? null;
  const configuredOpponentCount = numericCount(nations) + numericCount(bots);
  // League matches are agent-vs-agent, so the "vs N built-in opponents" clause
  // is only meaningful when built-in opponents actually exist — it used to
  // render the nonsense "vs 0 built-in opponents". Both branches go through
  // translateText (this line was previously hardcoded English).
  const setupLine =
    agentCount > 0 && configuredOpponentCount > 0
      ? translateText("ai_league_replay.setup_agents_vs_builtin", {
          agents: agentCount,
          opponents: configuredOpponentCount,
        })
      : agentCount > 0
        ? translateText("ai_league_replay.setup_agents_only", {
            agents: agentCount,
          })
        : translateText("ai_league_replay.setup_generic");
  const mapName =
    typeof input.summary?.runnerConfig?.map === "string"
      ? input.summary.runnerConfig.map
      : null;
  // Built-in difficulty describes the nation AI, which has no bearing on an
  // agent-vs-agent match; /league dropped it for the same reason. Keep it only
  // when built-in opponents are actually present.
  const difficulty =
    configuredOpponentCount > 0 &&
    typeof input.summary?.runnerConfig?.difficulty === "string"
      ? input.summary.runnerConfig.difficulty
      : null;
  const configLine = [
    mapName,
    difficulty,
    // maxSteps counts agent DECISION steps, not game turns — labelling it
    // "500-turn" next to a live turn counter reading 4425 looked broken.
    maxSteps !== null && maxSteps !== undefined
      ? translateText("ai_league_replay.setup_decisions", { steps: maxSteps })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const spectatorTelemetry =
    input.spectatorTelemetry as AiLeagueSpectatorTelemetry | null;
  const detailsUnavailable =
    input.detailsLoading !== true &&
    (input.summary === null || input.summary === undefined) &&
    input.decisions.length === 0 &&
    spectatorTelemetry === null;
  const metricValue = (value: number) =>
    input.detailsLoading || detailsUnavailable ? "—" : String(value);
  const setupHtml = input.detailsLoading
    ? `<section class="ai-league-match-setup ai-league-muted" data-ai-league-details-loading>${escapeHtml(translateText("ai_league_replay.loading_details"))}</section>`
    : detailsUnavailable
      ? `<section class="ai-league-match-setup ai-league-muted" data-ai-league-details-unavailable>${escapeHtml(translateText("ai_league_replay.details_unavailable"))}</section>`
      : `<section class="ai-league-match-setup">
        <strong>${escapeHtml(setupLine)}</strong>
        ${configLine ? `<div class="ai-league-muted">${escapeHtml(configLine)}</div>` : ""}
      </section>`;

  return `
    <section class="ai-league-metrics">
      <div class="ai-league-metric" title="${escapeHtml(translateText("ai_league_replay.metric_moves_tip"))}">${escapeHtml(translateText("ai_league_replay.metric_moves"))}<b>${metricValue(decisionCount)}</b></div>
      <div class="ai-league-metric" title="${escapeHtml(translateText("ai_league_replay.metric_invalid_tip"))}">${escapeHtml(translateText("ai_league_replay.metric_invalid"))}<b>${metricValue(rejectedCount)}</b></div>
      <div class="ai-league-metric${!input.detailsLoading && fallbackCount > 0 ? " warn" : ""}" title="${escapeHtml(translateText("ai_league_replay.metric_recovered_tip"))}">${escapeHtml(translateText("ai_league_replay.metric_recovered"))}<b>${metricValue(fallbackCount)}</b>${recoveredShareHtml(input, fallbackCount, decisionCount, detailsUnavailable)}</div>
    </section>
    ${setupHtml}
    ${!input.detailsLoading && !detailsUnavailable && playstyleKinds.length > 0 ? playstyleLineHtml(playstyleKinds) : ""}
    ${spectatorTelemetry ? communicationThreadsHtml(spectatorTelemetry) : ""}
    <p class="ai-league-muted">${escapeHtml(translateText("ai_league_replay.disclaimer"))}</p>
    ${artifactLinksHtml(input)}
    <section class="ai-league-clip" data-ai-league-clip></section>
    ${decisionLogHtml(input.decisions)}`;
}

/**
 * Share of moves that fell back, shown under the Recovered count. A bare "175"
 * reads as alarming (or as nothing) with no denominator; "7% of moves" is the
 * number a viewer can actually judge. Omitted at zero so a clean match stays
 * quiet, and while details are still loading/unavailable.
 */
function recoveredShareHtml(
  input: AiLeagueReplayOverlayInput,
  fallbackCount: number,
  decisionCount: number,
  detailsUnavailable: boolean,
): string {
  if (input.detailsLoading || detailsUnavailable) return "";
  if (fallbackCount <= 0 || decisionCount <= 0) return "";
  const percent = Math.round((fallbackCount / decisionCount) * 100);
  return `<span class="ai-league-metric-share">${escapeHtml(
    translateText("ai_league_replay.metric_recovered_share", {
      percent: String(percent),
    }),
  )}</span>`;
}

function playstyleLineHtml(kinds: string[]): string {
  const badges = kinds
    .map(
      (kind) =>
        `<span class="ai-league-badge">${escapeHtml(actionLabelFromKind(kind))}</span>`,
    )
    .join(" ");
  return `<p class="ai-league-playstyle"><strong>${escapeHtml(translateText("ai_league_replay.playstyle_label"))}</strong> ${badges}</p>`;
}

function artifactLinksHtml(input: AiLeagueReplayOverlayInput): string {
  const availability = input.artifactAvailability;
  const isAvailable = (key: keyof AiLeagueReplayArtifactAvailability) =>
    availability === undefined || availability[key] === true;
  const links = [
    isAvailable("visualReport")
      ? `<a href="${escapeHtml(input.artifactBasePath)}/visual-report.html">${escapeHtml(translateText("ai_league_replay.link_visual_report"))}</a>`
      : null,
    isAvailable("spectatorTelemetry")
      ? `<a href="${escapeHtml(input.artifactBasePath)}/spectator-telemetry.json">${escapeHtml(translateText("ai_league_replay.link_politics_data"))}</a>`
      : null,
    isAvailable("decisions")
      ? `<a href="${escapeHtml(input.artifactBasePath)}/decisions.jsonl">${escapeHtml(translateText("ai_league_replay.link_decisions"))}</a>`
      : null,
    isAvailable("summary")
      ? `<a href="${escapeHtml(input.artifactBasePath)}/match-summary.json">${escapeHtml(translateText("ai_league_replay.link_summary"))}</a>`
      : null,
  ].filter((link): link is string => link !== null);
  return links.length > 0 ? `<p>${links.join(" · ")}</p>` : "";
}

const AI_LEAGUE_DECISION_LOG_CAP = 15;

function decisionLogHtml(decisions: AiLeagueDecisionLogEntry[]): string {
  if (decisions.length === 0) {
    return "";
  }
  const visible = decisions.slice(-AI_LEAGUE_DECISION_LOG_CAP);
  const olderCount = Math.max(0, decisions.length - visible.length);
  const expander =
    olderCount > 0
      ? `<button type="button" class="ai-league-badge" data-ai-league-decision-expander aria-expanded="false" aria-controls="ai-league-older-decisions">${escapeHtml(translateText("ai_league_replay.decisions_show_older", { count: olderCount }))}</button>`
      : "";
  return `
    <div class="ai-league-decisions-head">
      <span class="ai-league-decisions-title">${escapeHtml(translateText("ai_league_replay.decisions_title"))}</span>
      ${expander}
    </div>
    ${olderCount > 0 ? `<div id="ai-league-older-decisions" data-ai-league-decision-pages></div>` : ""}
    ${visible.map(decisionHtml).join("")}`;
}

function mountAiLeagueDecisionLogExpander(
  overlay: HTMLElement,
  decisions: readonly AiLeagueDecisionLogEntry[],
) {
  const expander = overlay.querySelector<HTMLButtonElement>(
    "[data-ai-league-decision-expander]",
  );
  const pages = overlay.querySelector<HTMLElement>(
    "[data-ai-league-decision-pages]",
  );
  if (expander === null || pages === null) {
    return;
  }
  const initialOlderCount = Math.max(
    0,
    decisions.length - AI_LEAGUE_DECISION_LOG_CAP,
  );
  let olderEnd = initialOlderCount;
  expander.addEventListener("click", () => {
    if (olderEnd === 0) {
      pages.replaceChildren();
      olderEnd = initialOlderCount;
      expander.setAttribute("aria-expanded", "false");
      expander.textContent = translateText(
        "ai_league_replay.decisions_show_older",
        { count: olderEnd },
      );
      return;
    }

    const olderStart = Math.max(0, olderEnd - AI_LEAGUE_DECISION_LOG_CAP);
    pages.insertAdjacentHTML(
      "afterbegin",
      decisions.slice(olderStart, olderEnd).map(decisionHtml).join(""),
    );
    olderEnd = olderStart;
    expander.setAttribute("aria-expanded", "true");
    expander.textContent =
      olderEnd > 0
        ? translateText("ai_league_replay.decisions_show_older", {
            count: olderEnd,
          })
        : translateText("ai_league_replay.decisions_show_recent");
  });
}

// Deuteranopia-separable identity palette (no red/green-only pair). Hue encodes
// player identity ONLY; relationship type is carried by glyph/class, never hue.
const AI_LEAGUE_PLAYER_PALETTE = [
  "#1f77b4",
  "#ff7f0e",
  "#9467bd",
  "#17becf",
  "#bcbd22",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
];

function aiLeaguePlayerColor(smallID: number): string {
  const index =
    ((Math.trunc(smallID) % AI_LEAGUE_PLAYER_PALETTE.length) +
      AI_LEAGUE_PLAYER_PALETTE.length) %
    AI_LEAGUE_PLAYER_PALETTE.length;
  return AI_LEAGUE_PLAYER_PALETTE[index]!;
}

// Prefer the real engine on-map color so the diplomacy/standings dots match
// what the spectator sees on the map; fall back to the identity palette only
// when the frame payload omits a color (older payloads / missing field).
function aiLeagueDisplayColor(player: AiLeagueReplayFramePlayer): string {
  if (typeof player.color === "string" && player.color.trim().length > 0) {
    return player.color;
  }
  return aiLeaguePlayerColor(player.smallID);
}

function mountAiLeagueDiplomacyStrip(
  overlay: HTMLElement,
  decisions: readonly AiLeagueDecisionLogEntry[],
  telemetry: AiLeagueSpectatorTelemetry | null,
) {
  void telemetry;
  const container = overlay.querySelector<HTMLElement>(
    "[data-ai-league-diplomacy-rows]",
  );
  if (container === null) {
    return;
  }
  const win = window as Window & {
    __aiLeagueDiplomacyCleanup?: () => void;
  };
  win.__aiLeagueDiplomacyCleanup?.();
  const directiveByName = latestDirectiveByPlayer(decisions);
  // Frames fire every game tick; standings only change on ownership/diplomacy
  // events. Skipping identical re-renders avoids per-tick innerHTML churn
  // (layout + listener teardown) on the hottest spectator surface.
  let lastRowsHtml = "";
  const onFrame = (event: Event) => {
    const detail = (event as CustomEvent<AiLeagueReplayFrameEventDetail>)
      .detail;
    if (
      !detail ||
      !Array.isArray(detail.players) ||
      detail.players.length === 0
    ) {
      return;
    }
    const rowsHtml = diplomacyRowsHtml(
      detail.players,
      detail.tick,
      directiveByName,
    );
    if (rowsHtml === lastRowsHtml) {
      return;
    }
    lastRowsHtml = rowsHtml;
    container.innerHTML = rowsHtml;
  };
  document.addEventListener("ai-league-replay-frame", onFrame);
  win.__aiLeagueDiplomacyCleanup = () => {
    document.removeEventListener("ai-league-replay-frame", onFrame);
  };
}

function latestDirectiveByPlayer(
  decisions: readonly AiLeagueDecisionLogEntry[],
): Map<string, string> {
  const byName = new Map<string, string>();
  for (const decision of decisions) {
    const objective =
      typeof decision.planObjective === "string" &&
      decision.planObjective.trim().length > 0
        ? decision.planObjective.trim()
        : null;
    if (objective === null) {
      continue;
    }
    byName.set(normalizeName(decision.username), objective);
  }
  return byName;
}

function diplomacyRowsHtml(
  players: AiLeagueReplayFramePlayer[],
  currentTick: number,
  directiveByName: Map<string, string>,
): string {
  const totalTiles = players.reduce(
    (sum, player) => sum + Math.max(0, player.tilesOwned),
    0,
  );
  const bySmallID = new Map<number, AiLeagueReplayFramePlayer>();
  const byPlayerID = new Map<string, AiLeagueReplayFramePlayer>();
  for (const player of players) {
    bySmallID.set(player.smallID, player);
    byPlayerID.set(player.playerID, player);
  }
  const rankedAll = [...players].sort((a, b) => b.tilesOwned - a.tilesOwned);
  // Bots/tribes are frame players too — a bots>0 replay would otherwise flood
  // the strip with dozens of rows. Cap to the contenders; the map tells the rest.
  const STANDINGS_MAX_ROWS = 12;
  const ranked = rankedAll.slice(0, STANDINGS_MAX_ROWS);
  const hiddenCount = rankedAll.length - ranked.length;
  const moreLine =
    hiddenCount > 0
      ? `<p class="ai-league-diplo-more">${escapeHtml(
          translateText("ai_league_replay.standings_more").replace(
            "{count}",
            String(hiddenCount),
          ),
        )}</p>`
      : "";
  return (
    ranked
      .map((player, index) => {
        const share =
          totalTiles > 0
            ? Math.round((player.tilesOwned / totalTiles) * 100)
            : 0;
        const stances = diplomacyStancesHtml(
          player,
          bySmallID,
          byPlayerID,
          currentTick,
        );
        const directive = directiveByName.get(normalizeName(player.username));
        return `
        <div class="ai-league-diplo-row">
          <span class="ai-league-diplo-rank">${index + 1}</span>
          <span class="ai-league-color-dot" style="background:${escapeHtml(aiLeagueDisplayColor(player))}"></span>
          <span class="ai-league-diplo-name">${escapeHtml(aiLeagueSpectatorDisplayName(player.displayName || player.username))}</span>
          <span class="ai-league-diplo-share">${share}%</span>
        </div>
        ${stances ? `<div class="ai-league-diplo-stances">${stances}</div>` : ""}
        ${
          directive
            ? `<p class="ai-league-directive"><b>${escapeHtml(translateText("ai_league_replay.directive_label"))}</b> ${escapeHtml(directive)}</p>`
            : ""
        }`;
      })
      .join("") + moreLine
  );
}

function diplomacyStancesHtml(
  player: AiLeagueReplayFramePlayer,
  bySmallID: Map<number, AiLeagueReplayFramePlayer>,
  byPlayerID: Map<string, AiLeagueReplayFramePlayer>,
  currentTick: number,
): string {
  const stances: string[] = [];
  // Players already shown as an ally. Ally is the dominant label: we don't
  // additionally tag an ally with war/embargo icons (keeps the row readable).
  // War and embargo are independent dimensions and do NOT suppress each other —
  // a rival can carry both a war ● and an embargo ⊘ toward the same player.
  const alliedSmallIDs = new Set<number>();
  const expiringByOther = new Map<string, boolean>();
  const extensionByOther = new Map<string, boolean>();
  const NEAR_EXPIRY_TICKS = 300;
  const allies = Array.isArray(player.allies) ? player.allies : [];
  const targets = Array.isArray(player.targets) ? player.targets : [];
  const embargoes = Array.isArray(player.embargoes) ? player.embargoes : [];
  const alliances = Array.isArray(player.alliances) ? player.alliances : [];
  for (const alliance of alliances) {
    expiringByOther.set(
      alliance.other,
      alliance.expiresAt - currentTick < NEAR_EXPIRY_TICKS,
    );
    extensionByOther.set(alliance.other, alliance.hasExtensionRequest);
  }
  for (const allySmallID of allies) {
    const ally = bySmallID.get(allySmallID);
    if (ally === undefined) {
      continue;
    }
    alliedSmallIDs.add(allySmallID);
    const expiring = expiringByOther.get(ally.playerID) === true;
    const extension = extensionByOther.get(ally.playerID) === true;
    stances.push(
      stanceChipHtml(
        "ally",
        ally,
        translateText("ai_league_replay.stance_ally"),
        expiring,
        extension,
      ),
    );
  }
  // War is bidirectional: this player attacking a rival, or a rival attacking
  // this player. Encoded by the red crossed-swords icon (type by icon + the
  // war class's red color, not a new identity hue).
  const warSmallIDs = new Set<number>(targets);
  for (const other of bySmallID.values()) {
    if (other.smallID === player.smallID) {
      continue;
    }
    if (
      Array.isArray(other.targets) &&
      other.targets.includes(player.smallID)
    ) {
      warSmallIDs.add(other.smallID);
    }
  }
  for (const warSmallID of warSmallIDs) {
    const rival = bySmallID.get(warSmallID);
    if (rival === undefined || alliedSmallIDs.has(warSmallID)) {
      continue;
    }
    stances.push(
      stanceChipHtml(
        "war",
        rival,
        translateText("ai_league_replay.stance_war"),
        false,
        false,
      ),
    );
  }
  // Embargoes are bidirectional: either party can be the source.
  const embargoTargets = new Set<string>(embargoes);
  for (const other of byPlayerID.values()) {
    if (other.playerID === player.playerID) {
      continue;
    }
    if (
      Array.isArray(other.embargoes) &&
      other.embargoes.includes(player.playerID)
    ) {
      embargoTargets.add(other.playerID);
    }
  }
  for (const targetPlayerID of embargoTargets) {
    const target = byPlayerID.get(targetPlayerID);
    if (target === undefined || alliedSmallIDs.has(target.smallID)) {
      continue;
    }
    stances.push(
      stanceChipHtml(
        "embargo",
        target,
        translateText("ai_league_replay.stance_embargo"),
        false,
        false,
      ),
    );
  }
  return stances.join("");
}

// Inline relationship icons. These mirror the native client's diplomacy
// iconography (resources/images/AllianceIcon.svg green handshake,
// EmbargoWhiteIcon.svg no-trade circle, SwordIcon.svg crossed blade) but are
// INLINED (no assetUrl / no CDN fetch) so the replay overlay stays fully
// self-contained — no new fetch/WebSocket and no asset-bucket dependency.
// `currentColor` lets each icon inherit the per-stance color set in CSS
// (.ai-league-stance.ally/.war/.embargo .ai-league-stance-glyph), so RED stays
// reserved for war only. The icon carries the human label via title +
// aria-label; the relationship word is no longer printed inline.
const AI_LEAGUE_STANCE_ICON_SVG: Record<"ally" | "war" | "embargo", string> = {
  // Alliance: clasped hands (handshake) — alliance/cooperation.
  ally:
    `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M3 12l3-3 4 3 2-2 3 3"/><path d="M14 9l3-3 4 4-3 3"/><path d="M11 13l2 2"/></svg>`,
  // War: crossed swords — active conflict.
  war:
    `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M4 4l11 11"/><path d="M3 7l2-3 3 2"/><path d="M14 17l3 3 3-3-3-3"/>` +
    `<path d="M20 4L9 15"/><path d="M21 7l-2-3-3 2"/><path d="M10 17l-3 3-3-3 3-3"/></svg>`,
  // Embargo: a circle with a diagonal bar — no-trade / blocked.
  embargo:
    `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>`,
};

function stanceChipHtml(
  kind: "ally" | "war" | "embargo",
  other: AiLeagueReplayFramePlayer,
  label: string,
  expiring: boolean,
  hasExtensionRequest: boolean,
): string {
  // The relationship is shown ONLY by the icon; `label` (translated
  // ally/war/embargo) is the accessible name on the icon, never an inline word.
  // The renew glyph (↻) for a pending alliance extension is appended to the
  // accessible label so it stays conveyed without a trailing text label.
  const accessibleLabel = `${label}${hasExtensionRequest ? " ↻" : ""}`;
  return `<span class="ai-league-stance ${kind}${expiring ? " expiring" : ""}">
      <span class="ai-league-color-dot" style="background:${escapeHtml(aiLeagueDisplayColor(other))}"></span>
      <span>${escapeHtml(aiLeagueSpectatorDisplayName(other.displayName || other.username))}</span>
      <span class="ai-league-stance-glyph" role="img" title="${escapeHtml(accessibleLabel)}" aria-label="${escapeHtml(accessibleLabel)}">${AI_LEAGUE_STANCE_ICON_SVG[kind]}${hasExtensionRequest ? `<span class="ai-league-stance-renew" aria-hidden="true">↻</span>` : ""}</span>
    </span>`;
}

function communicationThreadsHtml(
  telemetry: AiLeagueSpectatorTelemetry,
): string {
  const threads = telemetry.communicationThreads.slice(0, 8);
  if (threads.length === 0) {
    return "";
  }
  return `
    <section class="ai-league-politics">
      <div class="ai-league-politics-head">
        <strong>${escapeHtml(translateText("ai_league_replay.talks_title"))}</strong>
        <button type="button" class="ai-league-badge" data-spectator-talks-toggle aria-expanded="false">${escapeHtml(translateText("ai_league_replay.talks_show"))}</button>
      </div>
      <div class="ai-league-comms ai-league-talks" data-spectator-comms hidden>
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

function decisionHtml(decision: AiLeagueDecisionLogEntry): string {
  const directive =
    typeof decision.planObjective === "string" &&
    decision.planObjective.trim().length > 0
      ? decision.planObjective.trim()
      : null;
  return `
    <article class="ai-league-decision">
      <div class="ai-league-row">
        <strong>${escapeHtml(decision.username)}</strong>
        <span class="ai-league-muted">${escapeHtml(translateText("ai_league_replay.turn_label", { turn: decision.turnNumber }))}</span>
      </div>
      <div class="ai-league-badges">
        <span class="ai-league-badge">${escapeHtml(actionLabel(decision))}</span>
        <span class="ai-league-badge ${decision.result.accepted ? "ok" : "bad"}">${escapeHtml(decision.result.accepted ? translateText("ai_league_replay.decision_accepted") : translateText("ai_league_replay.decision_rejected"))}</span>
        ${
          decision.fallbackUsed
            ? `<span class="ai-league-badge warn">${escapeHtml(translateText("ai_league_replay.decision_recovered"))}</span>`
            : ""
        }
      </div>
      <code>${escapeHtml(decision.selectedLegalActionId)}</code>
      ${socialBubbleHtml(decision)}
      ${directive ? `<p class="ai-league-directive"><b>${escapeHtml(translateText("ai_league_replay.directive_label"))}</b> ${escapeHtml(directive)}</p>` : ""}
      <p>${escapeHtml(decision.reason)}</p>
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

// Mounts ONLY the bottom-left "political radio" social transcript. The floating
// map message bubbles that used to hover over each agent were removed (operator
// direction): they cluttered the map. The transcript panel is the kept social
// surface. The per-event visibility window is still gated by
// theatreEventBubbleDuration so the radio shows each line for the same duration
// it previously showed the bubble.
function mountAiLeagueSocialTranscript(
  decisions: readonly AiLeagueDecisionLogEntry[],
  telemetry: AiLeagueSpectatorTelemetry | null,
) {
  const win = window as Window & {
    __aiLeagueSocialBubblesCleanup?: () => void;
  };
  win.__aiLeagueSocialBubblesCleanup?.();
  const transcript = document.createElement("div");
  transcript.id = "ai-league-social-transcript";
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
      .sort(
        (a, b) => b.importance - a.importance || b.turnNumber - a.turnNumber,
      )
      .slice(0, 2);
    transcript.innerHTML = socialTranscriptHtml(active);
  };
  document.addEventListener("ai-league-replay-frame", onFrame);
  win.__aiLeagueSocialBubblesCleanup = () => {
    document.removeEventListener("ai-league-replay-frame", onFrame);
    transcript.remove();
  };
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

function theatreEventBubbleDuration(
  socialEvent: AiLeagueMapSocialEvent,
): number {
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

interface AiLeagueReplaySummary {
  roster?: unknown[];
  decisionCount?: number | null;
  rejectedCount?: number | null;
  fallbackCount?: number | null;
  actionCounts?: Record<string, number | null | undefined> | null;
  runnerConfig?: {
    bots?: number | string | null;
    nations?: number | string | null;
    maxSteps?: number | null;
    map?: string | null;
    difficulty?: string | null;
  } | null;
  finalState?: {
    opponents?: unknown[];
  } | null;
}

function nonNegativeCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.trunc(value));
}

function summaryActionCounts(
  value: Record<string, number | null | undefined> | null | undefined,
): Record<string, number> | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([kind, count]) => {
      const normalized = nonNegativeCount(count);
      return normalized !== null && normalized > 0 ? [[kind, normalized]] : [];
    }),
  );
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

function agentName(
  telemetry: AiLeagueSpectatorTelemetry,
  agentID: string,
): string {
  return aiLeagueSpectatorDisplayName(
    telemetry.agents.find((agent) => agent.agentID === agentID)?.username ??
      agentID,
  );
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

// Action-kind labels for the playstyle badges. Known kinds route through
// translateText (ai_league_replay.action_<kind>); unknown kinds fall back to
// the raw game-internal identifier so a new kind never renders blank.
// Keys are the labels produced by actionLabel()/actionLabelFromKind() callers
// (note: "expand"/"chat"/"target" are already-derived labels, while the rest
// are raw selectedActionKind values). Unknown kinds fall back to the raw id.
const AI_LEAGUE_ACTION_LABEL_KEYS: Record<string, string> = {
  attack: "ai_league_replay.action_attack",
  expand: "ai_league_replay.action_expand",
  build: "ai_league_replay.action_build",
  chat: "ai_league_replay.action_chat",
  quick_chat: "ai_league_replay.action_chat",
  emoji: "ai_league_replay.action_emoji",
  target: "ai_league_replay.action_target",
  target_player: "ai_league_replay.action_target",
  alliance_request: "ai_league_replay.action_alliance_request",
  alliance_extend: "ai_league_replay.action_alliance_extend",
  alliance_reject: "ai_league_replay.action_alliance_reject",
  break_alliance: "ai_league_replay.action_break_alliance",
  donate_gold: "ai_league_replay.action_donate_gold",
  donate_troops: "ai_league_replay.action_donate_troops",
  embargo: "ai_league_replay.action_embargo",
  embargo_all: "ai_league_replay.action_embargo_all",
  nuke: "ai_league_replay.action_nuke",
  // Kinds the legal-action builder actually emits that had no label, so they
  // leaked raw snake_case ids into the panel ("upgrade_structure", "boat").
  boat: "ai_league_replay.action_boat",
  boat_retreat: "ai_league_replay.action_boat_retreat",
  delete_unit: "ai_league_replay.action_delete_unit",
  hold: "ai_league_replay.action_hold",
  move_warship: "ai_league_replay.action_move_warship",
  retreat: "ai_league_replay.action_retreat",
  spawn: "ai_league_replay.action_spawn",
  upgrade_structure: "ai_league_replay.action_upgrade_structure",
};

function actionLabelFromKind(kind: string): string {
  const key = AI_LEAGUE_ACTION_LABEL_KEYS[kind];
  if (key !== undefined) {
    return translateText(key);
  }
  // Never surface a raw id. An unmapped kind (new action shipped ahead of its
  // label) degrades to a readable phrase instead of "upgrade_structure".
  return kind.replace(/_/g, " ");
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
