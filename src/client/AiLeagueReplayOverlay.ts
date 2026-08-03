import {
  aiLeagueSpectatorDisplayName,
  aiLeagueSpectatorText,
  isAiLeagueNativeSpectatorUiEnabled,
} from "./AiLeagueReplayMode";
import {
  LowerThirdController,
  renderAnalystPanel,
  renderAnalystActionChart,
  renderAnalystDecisions,
  renderAnalystDecisionRow,
  renderAnalystEventLog,
  renderAnalystEventRow,
  renderBroadcastDrawer,
  renderCompetitorRail,
  renderMatchStateStrip,
  renderMatchTimeline,
  renderWarRoomFeed,
  renderWarRoomEvent,
  patchKeyedRegion,
  type AnalystActionKindCount,
  type AnalystDecisionRow,
  type AnalystEventRow,
  type AnalystModeUnavailableReason,
  type AnalystPanelData,
  type BroadcastDrawerTab,
  type BroadcastDrawerTabId,
  type CompetitorRailEntry,
  type CuratedWarRoomEvent,
  type LowerThirdEvent,
  type MatchStateStripInput,
  type TimelineMarker,
  type TimelineMarkerKind,
  type WarRoomFeedCallbacks,
} from "./BroadcastComposition";
import {
  BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT,
  BROADCAST_RAIL_FOLLOW_EVENT,
} from "./graphics/layers/PointOfViewSelector";
import { analytics } from "./analytics/AnalyticsClient";
import {
  mountDirectorCutController,
  normalizeDirectorCutPlan,
  segmentForTurn,
  type DirectorCutControllerHandle,
} from "./DirectorCutController";
import { fetchReadModel, type PublicAgent } from "./publicapp/ReadModelSchema";
import {
  mountReplayScopedLeagueClipControl,
  type ReplayScopedLeagueClipControlHandle,
} from "./ReplayClipControl";
import { REPLAY_RENDER_FAST_FORWARD_PARAM } from "./ReplayRenderFastForward";
import {
  REPLAY_SHARE_IMAGE_REQUEST_EVENT,
  REPLAY_SHARE_IMAGE_RESULT_EVENT,
  type ReplayShareImageResultDetail,
} from "./ReplayShareImageBinding";
import { ReplaySpeedMultiplier } from "./utilities/ReplaySpeedMultiplier";
import { translateText } from "./Utils";
import {
  ANONYMOUS_NAMES_KEY,
  USER_SETTINGS_CHANGED_EVENT,
} from "../core/game/UserSettings";

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
  /** `null` for a fallback/failure decision with no stated reason — see server `AgentDecision.reason`'s doc. */
  reason: string | null;
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

export interface AiLeagueReplayFramePlayer {
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
  /**
   * Turn currently rendered on the map. The decision log and diplomacy talks are
   * windowed to it so a viewer never reads the end of the match while watching
   * the beginning. Internal: set by the overlay's own playhead sync.
   */
  currentTurn?: number;
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
  /**
   * Product overhaul spec Stage 5. Raw, unvalidated JSON from
   * `director-cut-plan.json` — this overlay owns runtime shape-checking via
   * `normalizeDirectorCutPlan` (same split `spectatorTelemetry` already
   * uses). Arrives asynchronously via `hydrate()`, same timing as
   * `spectatorTelemetry`; the controller mounts (enabled by default — spec
   * item 3) the first time a valid plan shows up and never re-mounts.
   */
  directorCutPlan?: unknown;
  /**
   * Season Zero broadcast match-state strip (spec Phase 5). Raw,
   * unvalidated JSON from `match-state-series.json` — this overlay owns
   * runtime shape-checking via `normalizeMatchStateSeries`, the same split
   * `directorCutPlan` above already uses. Arrives asynchronously via
   * `hydrate()`, same timing as `directorCutPlan`. This overlay only ever
   * mounts for Full Replay / archived re-watch (never a sealed live
   * Premiere — see `ReplayPremiereOverlay.ts`'s `matchStateStrip` doc for
   * why a sealed Premiere must never fetch this whole-match artifact at
   * all), so windowing it to the viewer's own playhead here is always
   * safe.
   */
  matchStateSeries?: unknown;
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

/**
 * Structural fix (P0 incident, 2026-08-03): the War Room drawer panel used
 * to clear the top-right playback control cluster (game-right-sidebar +
 * replay-panel, index.html's `#pw-game-control-cluster`) via a single
 * hardcoded `top: 76px`, tuned for the cluster's DESKTOP button size
 * (`CONTROL_BUTTON_CLASS`'s 34px targets, >=1200px viewport width). Below
 * 1200px the SAME buttons switch to 44px touch targets (still nowhere near
 * "mobile" -- the drawer's own `max-width: 740px` breakpoint is far
 * narrower), so at any viewport in that 741-1199px band the cluster is
 * taller than the 76px budget assumed, and the panel silently overlapped
 * the controls again -- found live at 1178px. No fixed pixel constant can
 * be correct at every window size, so this measures the cluster's actual
 * rendered footprint (`getBoundingClientRect().bottom`, which already
 * folds in its own top offset AND height, at any breakpoint) and republishes
 * it as `--pw-control-cluster-bottom` on the root element; the War Room
 * panel's `top` (createStyle's own CSS, `.broadcast-drawer-panel
 * [data-tab-id="events"]`) reads that custom property instead of a
 * constant. `#pw-game-control-cluster` also carries a guaranteed-topmost
 * z-index (index.html) as defense in depth: even a stale/pre-first-
 * measurement value can never make the controls unclickable, only
 * cosmetically crowd them for one frame.
 */
function mountControlClusterGeometrySync(): () => void {
  const cluster = document.getElementById("pw-game-control-cluster");
  if (cluster === null) {
    return () => {};
  }
  const sync = () => {
    document.documentElement.style.setProperty(
      "--pw-control-cluster-bottom",
      `${Math.ceil(cluster.getBoundingClientRect().bottom)}px`,
    );
  };
  sync();
  const resizeObserver = new ResizeObserver(sync);
  resizeObserver.observe(cluster);
  // Belt-and-suspenders: a viewport resize that crosses the `top-4`
  // breakpoint (position-only, no size change) wouldn't otherwise fire the
  // ResizeObserver above on its own -- in practice it always co-occurs
  // with the button-size breakpoint at the same 1200px threshold, but this
  // costs nothing and removes the dependency on that coincidence.
  window.addEventListener("resize", sync);
  return () => {
    resizeObserver.disconnect();
    window.removeEventListener("resize", sync);
    document.documentElement.style.removeProperty(
      "--pw-control-cluster-bottom",
    );
  };
}

export function mountAiLeagueReplayOverlay(input: AiLeagueReplayOverlayInput) {
  document.getElementById("ai-league-replay-overlay")?.remove();
  document.getElementById("ai-league-social-transcript")?.remove();
  document.getElementById("ai-league-headline-event")?.remove();
  document.getElementById("ai-league-lower-third-host")?.remove();
  document.getElementById(AI_LEAGUE_BROADCAST_DRAWER_PORTAL_ID)?.remove();
  document.body.classList.remove("ai-league-analyst-mode");
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
  mountReplayPanelControls(overlay, currentInput.runID);
  const disposeControlClusterGeometrySync = mountControlClusterGeometrySync();
  // Identity (emblem/version/builder) is always public — never spoiler-
  // sensitive on its own — so it fetches once per mount and degrades to
  // "nothing resolved yet" (never blocks or fails the mount) on any error.
  // Resolved once the fetch lands, then only the broadcast drawer
  // re-renders (not the whole details block) so disclosure/toggle state is
  // untouched.
  let identityByPlayerName: ReadonlyMap<string, PublicAgent> = new Map();
  // Camera-follow discoverability (spec item 6): mirrors identityByPlayerName
  // above — closure state updated by a document-level listener registered
  // once at mount (below), passed down into every broadcast-drawer render so
  // the rail's `followed` seat always reflects PointOfViewSelector's own
  // current pick, however it was set (rail click, dropdown, crosshair,
  // initial resolution).
  let followedClientID: string | null = null;
  void resolveAiLeagueIdentities().then((resolved) => {
    identityByPlayerName = resolved;
    if (!overlay.isConnected) return;
    mountAiLeagueBroadcastDrawer(
      overlay,
      currentInput,
      identityByPlayerName,
      followedClientID,
      directorCutHandle,
    );
  });
  // Director Cut (spec Stage 5): one controller per overlay mount, mounted
  // the first time a valid `director-cut-plan.json` arrives via hydrate()
  // (it loads asynchronously, same timing as spectatorTelemetry) and never
  // re-mounted afterward — `mountDirectorCutController` owns its own
  // enabled/disabled state from then on, the toggle button only reads it.
  let directorCutHandle: DirectorCutControllerHandle | null = null;
  const syncDirectorCutController = (): void => {
    if (directorCutHandle !== null) return;
    const plan = normalizeDirectorCutPlan(currentInput.directorCutPlan);
    if (plan === null) return;
    directorCutHandle = mountDirectorCutController({
      plan,
      // Spec item 3: "Director Cut is the default for archived matches".
      // This overlay only ever mounts for Full Replay (archived matches) —
      // live/re-watched premieres run through ReplayPremiereRuntime.ts's
      // own sealed real-time timeline instead, which never wires a
      // director-cut-plan.json into this input at all.
      enabledByDefault: true,
      onSpeedChange: (speed) => currentInput.onReplaySpeedChange?.(speed),
      // Late hydration: the plan can resolve well after playback started
      // (see comment above), so mounting enabled must apply the segment
      // covering the CURRENT turn, never unconditionally the opening one.
      currentTurn: currentInput.currentTurn ?? 0,
    });
  };
  syncDirectorCutController();
  let clipControl = mountReplayDetailsBindings(
    overlay,
    currentInput,
    identityByPlayerName,
    followedClientID,
    directorCutHandle,
    () => currentInput.currentTurn ?? 0,
  );
  mountReplayJumpControls(document);

  // Phase 7 watch-progress milestones. Hooks the SAME `ai-league-replay-frame`
  // event every other per-frame subsystem here already listens to (playhead
  // sync, Director Cut, lower thirds) — never a new timer or RAF loop.
  // `activePlaybackMs` — NOT wall-clock `Date.now() - firstFrameAt` — drives
  // the 30s/2m milestones: a paused, backgrounded, or buffering viewer must
  // never inflate the retention funnel Season Zero actually measures. Each
  // consecutive frame pair's real delta is added, capped at
  // `MAX_FRAME_DELTA_MS` so a long pause/buffering stall (or simply the gap
  // before the very first frame) can never masquerade as watched time, and
  // accumulation halts entirely while `document.hidden` (a backgrounded tab
  // contributes zero regardless of delta size, even if the underlying
  // playback driver keeps dispatching frames while hidden). Turn progress
  // against the match's own finish turn (the same `aiLeagueFinishTurn` the
  // lower-thirds sync above already computes) drives 50%/completion — those
  // were already correct and stay turn-based, not time-based. Each milestone
  // is a one-shot flag in `watchMilestonesSent`, guaranteeing exactly one
  // `analytics.track` call per milestone per view.
  const MAX_FRAME_DELTA_MS = 2_000;
  const watchMilestonesSent = new Set<string>();
  let lastFrameAt: number | null = null;
  let activePlaybackMs = 0;
  const trackWatchMilestoneOnce = (
    name: "watched_30s" | "watched_2m" | "watched_50pct" | "completed",
  ): void => {
    if (watchMilestonesSent.has(name)) return;
    watchMilestonesSent.add(name);
    analytics.track(name, {
      matchId: currentInput.runID,
      replayMode: directorCutHandle !== null ? "director_cut" : "full_replay",
    });
  };
  const onWatchProgressFrame = (event: Event): void => {
    const detail = (
      event as CustomEvent<{ turnNumber?: unknown; terminal?: unknown }>
    ).detail;
    if (
      typeof detail?.turnNumber !== "number" ||
      !Number.isFinite(detail.turnNumber)
    ) {
      return;
    }
    const now = Date.now();
    if (lastFrameAt !== null && !document.hidden) {
      const deltaMs = now - lastFrameAt;
      if (deltaMs > 0) {
        activePlaybackMs += Math.min(deltaMs, MAX_FRAME_DELTA_MS);
      }
    }
    lastFrameAt = now;
    if (activePlaybackMs >= 30_000) trackWatchMilestoneOnce("watched_30s");
    if (activePlaybackMs >= 120_000) trackWatchMilestoneOnce("watched_2m");
    const telemetry =
      currentInput.spectatorTelemetry as AiLeagueSpectatorTelemetry | null;
    const totalTurns = aiLeagueFinishTurn(currentInput, telemetry);
    if (totalTurns > 0 && detail.turnNumber / totalTurns >= 0.5) {
      trackWatchMilestoneOnce("watched_50pct");
    }
    if (detail.terminal === true) trackWatchMilestoneOnce("completed");
  };
  document.addEventListener("ai-league-replay-frame", onWatchProgressFrame);

  // Lower thirds (spec item 3): one controller per overlay mount, positioned
  // over the map (never inside the scrollable side panel) so a pulse stays
  // visible without opening/scrolling anything. Synced from the SAME
  // curatedWarRoomEvents() source the War Room drawer tab already reads,
  // plus a synthetic "finish" event once the viewer's own playhead reaches
  // the match's canonical finish turn — Full Replay has no premiere seal, so
  // "concludes" here means "the viewer has watched to the end", not "the
  // data becomes available" (it always is).
  const lowerThirdHost = document.createElement("div");
  lowerThirdHost.id = "ai-league-lower-third-host";
  document.body.appendChild(lowerThirdHost);
  const lowerThird = new LowerThirdController(lowerThirdHost);
  const syncLowerThirds = (): void => {
    const telemetry =
      currentInput.spectatorTelemetry as AiLeagueSpectatorTelemetry | null;
    const totalTurns = aiLeagueFinishTurn(currentInput, telemetry);
    const currentTurn = currentInput.currentTurn ?? 0;
    // Windowed to the viewer's own playhead (spec item 2): curatedWarRoomEvents
    // returns the FULL match's curated set regardless of how far playback has
    // gotten, so a pulse for a turn the viewer hasn't reached yet must be
    // filtered out here — otherwise the controller's own de-dupe (`seenIds`)
    // would mark it "already announced" on this very first sync and it would
    // never correctly pulse once the playhead actually reaches it.
    const events: LowerThirdEvent[] = curatedWarRoomEvents(
      telemetry,
      currentInput.decisions,
    )
      .filter((event) => event.turn <= currentTurn)
      .map((event) => ({
        id: event.id,
        kind: event.kind,
        headline: event.headline,
      }));
    if (currentTurn >= totalTurns) {
      events.push({
        id: "finish",
        kind: "finish",
        headline: translateText("ai_league_replay.timeline_finish"),
      });
    }
    lowerThird.sync(events);
  };
  syncLowerThirds();

  // Camera-follow discoverability (spec item 6): registered once here (not
  // per-hydrate) since it must survive every renderDetails()/hydrate() call
  // and only ever needs one live listener per overlay mount — same
  // window-cleanup idiom as every other document-level listener in this
  // file (e.g. __aiLeagueCompetitorRailCleanup's successor below).
  const followedPlayerWin = window as Window & {
    __aiLeagueFollowedPlayerCleanup?: () => void;
  };
  followedPlayerWin.__aiLeagueFollowedPlayerCleanup?.();
  const onFollowedPlayerChange = (event: Event): void => {
    const detail = (
      event as CustomEvent<{ playerName: string | null; clientID?: string | null }>
    ).detail;
    if (detail === undefined || (detail.clientID ?? null) === followedClientID) {
      return;
    }
    followedClientID = detail.clientID ?? null;
    if (!overlay.isConnected) return;
    mountAiLeagueBroadcastDrawer(
      overlay,
      currentInput,
      identityByPlayerName,
      followedClientID,
      directorCutHandle,
    );
  };
  document.addEventListener(
    BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT,
    onFollowedPlayerChange,
  );
  followedPlayerWin.__aiLeagueFollowedPlayerCleanup = () => {
    document.removeEventListener(
      BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT,
      onFollowedPlayerChange,
    );
  };

  let disposed = false;

  // Single re-render path for the details block, shared by hydrate() and the
  // playhead sync so both keep the subtitle and clip control consistent.
  const renderDetails = (): void => {
    const details = overlay.querySelector<HTMLElement>(
      "[data-ai-league-details]",
    );
    if (details === null || !overlay.isConnected) return;
    details.innerHTML = overlayDetailsHtml(currentInput);
    const subtitle = overlay.querySelector<HTMLElement>(
      "[data-ai-league-subtitle]",
    );
    const subtitleText = matchSubtitle(currentInput);
    if (subtitle !== null && subtitleText !== null) {
      subtitle.textContent = subtitleText;
    }
    const previousClipControl = clipControl;
    syncDirectorCutController();
    clipControl = mountReplayDetailsBindings(
      overlay,
      currentInput,
      identityByPlayerName,
      followedClientID,
      directorCutHandle,
      () => currentInput.currentTurn ?? 0,
    );
    previousClipControl?.dispose();
    syncLowerThirds();
  };

  // P0 fix (2026-08-03): the "Anonymous Names" setting toggling mid-session
  // used to leave every already-rendered agent name frozen at whatever it
  // was when the details/drawer last painted -- `aiLeagueSpectatorDisplayName`/
  // `aiLeagueSpectatorText` read the live setting on every call, but nothing
  // ever re-invoked them after the toggle, so the War Room feed, rail,
  // timeline, Analyst panel, decision log, diplomacy strip and social
  // transcript all kept showing real names (or vice versa) until the next
  // unrelated re-render happened to occur. `renderDetails()` already
  // rebuilds every one of those regions in one call (via
  // `mountReplayDetailsBindings` -> `mountAiLeagueBroadcastDrawer`), so
  // reusing it here is sufficient -- same window-cleanup idiom as
  // `onFollowedPlayerChange` above, since this listener must also survive
  // every renderDetails()/hydrate() call and be torn down by the NEXT
  // mount if `dispose()` was never called. Listens on `window` (not
  // `document`): `UserSettings.emitChange` dispatches on `globalThis`
  // (== `window`), which every other `USER_SETTINGS_CHANGED_EVENT`
  // consumer in the codebase (Main.ts, FlagInput.ts, PatternInput.ts)
  // already listens on for exactly that reason -- a non-bubbling custom
  // event fired on `window` never reaches a `document`-level listener.
  const anonymousNamesWin = window as Window & {
    __aiLeagueAnonymousNamesCleanup?: () => void;
  };
  anonymousNamesWin.__aiLeagueAnonymousNamesCleanup?.();
  const onAnonymousNamesChange = (): void => {
    if (!overlay.isConnected) return;
    renderDetails();
  };
  window.addEventListener(
    `${USER_SETTINGS_CHANGED_EVENT}:${ANONYMOUS_NAMES_KEY}`,
    onAnonymousNamesChange,
  );
  anonymousNamesWin.__aiLeagueAnonymousNamesCleanup = () => {
    window.removeEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${ANONYMOUS_NAMES_KEY}`,
      onAnonymousNamesChange,
    );
  };
  const disposePlayheadSync = mountAiLeaguePlayheadSync(
    overlay,
    (turn) => {
      currentInput = { ...currentInput, currentTurn: turn };
      syncLowerThirds();
      // Refresh ONLY the decision-log region. Re-rendering the whole details
      // block would re-mount the political-radio transcript, the headline
      // lower-third and the clip control, discarding their accumulated state.
      const region = overlay.querySelector<HTMLElement>(
        "[data-ai-league-decisions-region]",
      );
      if (region === null) return;
      const wasOpen =
        region
          .querySelector("[data-ai-league-decisions-toggle]")
          ?.getAttribute("aria-expanded") === "true";
      region.outerHTML = decisionLogHtml(currentInput.decisions, turn);
      mountAiLeagueDecisionLogExpander(overlay, currentInput.decisions);
      mountAiLeagueDecisionsDisclosure(overlay);
      if (wasOpen) {
        overlay
          .querySelector<HTMLButtonElement>("[data-ai-league-decisions-toggle]")
          ?.click();
      }
    },
    (turn) =>
      currentInput.decisions.filter(
        (decision) =>
          !Number.isFinite(decision.turnNumber) || decision.turnNumber <= turn,
      ).length,
  );

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
      renderDetails();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposePlayheadSync();
      disposeControlClusterGeometrySync();
      document.removeEventListener(
        "ai-league-replay-frame",
        onWatchProgressFrame,
      );
      lowerThird.dispose();
      clipControl?.dispose();
      clipControl = null;
      directorCutHandle?.dispose();
      directorCutHandle = null;
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
    __aiLeagueBroadcastDrawerCleanup?: () => void;
    __aiLeagueFollowedPlayerCleanup?: () => void;
    __aiLeagueAnonymousNamesCleanup?: () => void;
  };
  win.__aiLeaguePanelDisclosureCleanup?.();
  win.__aiLeaguePanelControlsCleanup?.();
  win.__aiLeagueReplayJumpCleanup?.();
  win.__aiLeagueHeadlineCleanup?.();
  win.__aiLeagueDiplomacyCleanup?.();
  win.__aiLeagueSocialBubblesCleanup?.();
  win.__aiLeagueBroadcastDrawerCleanup?.();
  win.__aiLeagueFollowedPlayerCleanup?.();
  win.__aiLeagueAnonymousNamesCleanup?.();
  delete win.__aiLeaguePanelDisclosureCleanup;
  delete win.__aiLeaguePanelControlsCleanup;
  delete win.__aiLeagueReplayJumpCleanup;
  delete win.__aiLeagueHeadlineCleanup;
  delete win.__aiLeagueDiplomacyCleanup;
  delete win.__aiLeagueSocialBubblesCleanup;
  delete win.__aiLeagueBroadcastDrawerCleanup;
  delete win.__aiLeagueFollowedPlayerCleanup;
  delete win.__aiLeagueAnonymousNamesCleanup;
  overlay.remove();
  document.getElementById("ai-league-social-transcript")?.remove();
  document.getElementById("ai-league-headline-event")?.remove();
  document.getElementById("ai-league-lower-third-host")?.remove();
  document.getElementById(AI_LEAGUE_BROADCAST_DRAWER_PORTAL_ID)?.remove();
  document.body.classList.remove(
    "ai-league-replay-mode",
    "ai-league-native-spectator-ui",
    "ai-league-analyst-mode",
  );
}

function mountReplayDetailsBindings(
  overlay: HTMLElement,
  input: AiLeagueReplayOverlayInput,
  identityByPlayerName: ReadonlyMap<string, PublicAgent>,
  followedClientID: string | null,
  directorCutHandle: DirectorCutControllerHandle | null,
  getCurrentTurn: () => number,
): ReplayScopedLeagueClipControlHandle | null {
  const telemetry =
    input.spectatorTelemetry as AiLeagueSpectatorTelemetry | null;
  mountAiLeagueSocialTranscript(input.decisions, telemetry);
  mountAiLeagueHeadlineEvent(input.decisions, telemetry);
  mountAiLeagueDiplomacyStrip(overlay, input.decisions, telemetry);
  mountAiLeagueTalksToggle(overlay, telemetry);
  mountAiLeagueDecisionLogExpander(overlay, input.decisions);
  mountAiLeagueDecisionsDisclosure(overlay);
  mountAiLeagueRadioToggle(overlay);
  mountAiLeagueAnalystToggle(overlay);
  mountAiLeagueDirectorCutToggle(
    overlay,
    directorCutHandle,
    getCurrentTurn,
    input.runID,
  );
  mountAiLeagueShareImageButton(overlay);
  mountAiLeagueBroadcastDrawer(
    overlay,
    input,
    identityByPlayerName,
    followedClientID,
    directorCutHandle,
  );
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

/**
 * Share button. The capture itself happens in the renderer binding, which owns
 * the canvas; this only asks for it and reports the outcome. The button is
 * disabled while a capture is in flight so a double click cannot queue two
 * encodes, and it self-resets if no binding is listening.
 */
function mountAiLeagueShareImageButton(overlay: HTMLElement): void {
  const button = overlay.querySelector<HTMLButtonElement>(
    "[data-ai-league-share-button]",
  );
  const status = overlay.querySelector<HTMLElement>(
    "[data-ai-league-share-status]",
  );
  if (button === null) return;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  const settle = (message: string): void => {
    button.disabled = false;
    if (status !== null) status.textContent = message;
    if (resetTimer !== null) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      if (status !== null) status.textContent = "";
    }, 4000);
  };
  document.addEventListener(REPLAY_SHARE_IMAGE_RESULT_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<ReplayShareImageResultDetail>).detail;
    settle(
      translateText(
        detail?.ok !== true
          ? "ai_league_replay.share_image_failed"
          : detail.delivery === "clipboard"
            ? "ai_league_replay.share_image_copied"
            : "ai_league_replay.share_image_saved",
      ),
    );
  });
  button.addEventListener("click", () => {
    button.disabled = true;
    if (status !== null) {
      status.textContent = translateText(
        "ai_league_replay.share_image_working",
      );
    }
    document.dispatchEvent(new CustomEvent(REPLAY_SHARE_IMAGE_REQUEST_EVENT));
    // No binding mounted (details-only page, or the renderer is gone): the
    // request goes nowhere, so recover the button instead of wedging it.
    if (resetTimer !== null) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      if (button.disabled) {
        settle(translateText("ai_league_replay.share_image_failed"));
      }
    }, 8000);
  });
}

/**
 * Disclosure for the decision log. It is the panel's largest block and pure
 * reference material, so it ships collapsed and the viewer opts in.
 */
function mountAiLeagueDecisionsDisclosure(overlay: HTMLElement): void {
  const toggle = overlay.querySelector<HTMLButtonElement>(
    "[data-ai-league-decisions-toggle]",
  );
  const body = overlay.querySelector<HTMLElement>(
    "[data-ai-league-decisions-body]",
  );
  if (toggle === null || body === null) return;
  toggle.addEventListener("click", () => {
    const nowOpen = body.hidden;
    body.hidden = !nowOpen;
    toggle.setAttribute("aria-expanded", String(nowOpen));
    toggle.textContent = translateText(
      nowOpen
        ? "ai_league_replay.decisions_hide"
        : "ai_league_replay.decisions_show",
    );
  });
}

/**
 * Political radio (the floating social transcript) is atmosphere, not signal,
 * and it covers the map's lower-left corner. Ship it OFF and let the viewer
 * turn it on from a small control in the panel header actions.
 */
function mountAiLeagueRadioToggle(overlay: HTMLElement): void {
  const actions = overlay.querySelector<HTMLElement>(
    ".ai-league-header-actions",
  );
  if (actions === null) return;
  if (actions.querySelector("[data-ai-league-radio-toggle]") !== null) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.aiLeagueRadioToggle = "";
  toggle.setAttribute("aria-pressed", "false");
  toggle.textContent = translateText("ai_league_replay.radio_show");
  const apply = (on: boolean) => {
    document.body.classList.toggle("ai-league-radio-on", on);
    toggle.setAttribute("aria-pressed", String(on));
    // Label stays constant so the header does not reflow on toggle; the
    // pressed state is what communicates on/off.
    toggle.textContent = translateText(
      on ? "ai_league_replay.radio_hide" : "ai_league_replay.radio_show",
    );
    toggle.classList.toggle("is-on", on);
  };
  apply(false);
  toggle.addEventListener("click", () => {
    apply(!document.body.classList.contains("ai-league-radio-on"));
  });
  actions.prepend(toggle);
}

/**
 * Fired whenever the desktop analyst-mode toggle flips. Independent from
 * the mobile drawer's own "Analysis" tab switch (that path already
 * re-renders through `AI_LEAGUE_DRAWER_ACTIVE_TAB` + `rerenderWithLastFrame`
 * on every tab click) — this toggle instead flips a `document.body` class
 * with no render cycle of its own, so `mountAiLeagueBroadcastDrawer`
 * listens for this event to lazy-mount/unmount the Analyst tab's heavy
 * content (spec item 1 follow-up, P2 review) the instant visibility
 * changes, without waiting for the next `ai-league-replay-frame` tick.
 */
const AI_LEAGUE_ANALYST_MODE_CHANGE_EVENT = "ai-league-analyst-mode-change";

/**
 * Analyst mode (spec item 5): a separate, explicit desktop toggle from the
 * mobile drawer's "Analysis" tab — shows/hides the SAME renderAnalystPanel()
 * output the drawer's "analysis" tab already renders. The class lives on
 * document.body (same convention as mountAiLeagueRadioToggle's own
 * `ai-league-radio-on`), never on the overlay root: the analysis panel is
 * relocated to a document.body-level portal on desktop (see
 * mountAiLeagueBroadcastDrawer's own doc), so an overlay-scoped class would
 * stop matching it the moment it moves. Ships off by default (the curated
 * rail/War Room/timeline view never auto-opens analyst mode), self-guards
 * against a duplicate button on re-hydrate, and the DOM class IS the
 * persisted state — untouched by every subsequent hydrate() since only the
 * header (not this button) gets re-created.
 */
function mountAiLeagueAnalystToggle(overlay: HTMLElement): void {
  const actions = overlay.querySelector<HTMLElement>(
    ".ai-league-header-actions",
  );
  if (actions === null) return;
  if (actions.querySelector("[data-ai-league-analyst-toggle]") !== null) {
    return;
  }
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.aiLeagueAnalystToggle = "";
  toggle.setAttribute("aria-pressed", "false");
  toggle.textContent = translateText("broadcast.analyst_heading");
  const apply = (on: boolean) => {
    document.body.classList.toggle("ai-league-analyst-mode", on);
    toggle.setAttribute("aria-pressed", String(on));
    toggle.classList.toggle("is-on", on);
    document.dispatchEvent(
      new CustomEvent(AI_LEAGUE_ANALYST_MODE_CHANGE_EVENT),
    );
  };
  apply(false);
  toggle.addEventListener("click", () => {
    apply(!document.body.classList.contains("ai-league-analyst-mode"));
  });
  actions.prepend(toggle);
}

/**
 * Director Cut / Full Replay (spec Stage 5 item 3). Absent entirely until a
 * valid plan has actually mounted a controller (no button for a match with
 * no plan yet, or a legacy bundle with none at all — never a disabled
 * button that does nothing). Self-guards against a duplicate on re-hydrate,
 * same as `mountAiLeagueAnalystToggle`. State lives on the controller
 * itself (mounted once, enabled by default per spec item 3), not on a DOM
 * class: `directorCutHandle.isEnabled()` is the single source of truth this
 * button reads and writes, so a re-hydrate that calls this again (button
 * already exists, so it no-ops) never fights the controller's own state.
 */
function mountAiLeagueDirectorCutToggle(
  overlay: HTMLElement,
  directorCutHandle: DirectorCutControllerHandle | null,
  getCurrentTurn: () => number,
  runID: string,
): void {
  if (directorCutHandle === null) return;
  const actions = overlay.querySelector<HTMLElement>(
    ".ai-league-header-actions",
  );
  if (actions === null) return;
  if (
    actions.querySelector("[data-ai-league-director-cut-toggle]") !== null
  ) {
    return;
  }
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.aiLeagueDirectorCutToggle = "";
  const apply = (on: boolean) => {
    toggle.setAttribute("aria-pressed", String(on));
    toggle.classList.toggle("is-on", on);
    toggle.textContent = translateText(
      on
        ? "ai_league_replay.director_cut_on"
        : "ai_league_replay.director_cut_off",
    );
  };
  const initiallyEnabled = directorCutHandle.isEnabled();
  apply(initiallyEnabled);
  // First-ever creation of this button (guarded above) IS the one-shot
  // "Director Cut mounted" point — fires once for the spec's "enabled by
  // default" case, exactly like `analytics.track("director_cut_started")`
  // fires again below only on an explicit user toggle-ON (never on toggle-
  // OFF, and never twice for the same mount since the button only mounts
  // once).
  if (initiallyEnabled) {
    analytics.track("director_cut_started", {
      matchId: runID,
      replayMode: "director_cut",
    });
  }
  toggle.addEventListener("click", () => {
    const next = !directorCutHandle.isEnabled();
    // Re-enabling mid-match must resync to the segment covering the
    // CURRENT turn, never the opening one (see DirectorCutController.ts's
    // `setEnabled` doc) — irrelevant when turning off.
    directorCutHandle.setEnabled(next, getCurrentTurn());
    apply(next);
    if (next) {
      analytics.track("director_cut_started", {
        matchId: runID,
        replayMode: "director_cut",
      });
    }
  });
  actions.prepend(toggle);
}

/**
 * Advance the playhead-windowed panels as the replay runs. Re-renders the whole
 * details block on a throttle (not every frame — that block is expensive), and
 * only when the visible decision count actually changes, so an idle or paused
 * replay costs nothing. Disclosure state for the decision log and talks is
 * preserved across the re-render so the panels do not snap shut underneath the
 * viewer.
 */
function mountAiLeaguePlayheadSync(
  overlay: HTMLElement,
  applyTurn: (turn: number) => void,
  visibleDecisionCount: (turn: number) => number,
): () => void {
  const THROTTLE_MS = 750;
  let lastRenderedAt = 0;
  let lastVisibleCount = -1;
  // Per-listener, NOT global: aiLeagueCurrentTurn is shared render-time state,
  // so gating on it would let whichever listener ran first swallow the event and
  // leave every other mounted overlay frozen.
  let lastSeenTurn = -1;
  const onFrame = (event: Event) => {
    const detail = (event as CustomEvent<{ turnNumber?: unknown }>).detail;
    if (typeof detail?.turnNumber !== "number") return;
    if (!Number.isFinite(detail.turnNumber)) return;
    if (detail.turnNumber <= lastSeenTurn) return;
    lastSeenTurn = detail.turnNumber;
    const now = Date.now();
    if (now - lastRenderedAt < THROTTLE_MS) return;
    const count = visibleDecisionCount(detail.turnNumber);
    if (count === lastVisibleCount) return;
    lastVisibleCount = count;
    lastRenderedAt = now;
    applyTurn(detail.turnNumber);
  };
  document.addEventListener("ai-league-replay-frame", onFrame);
  return () => document.removeEventListener("ai-league-replay-frame", onFrame);
}

const AI_LEAGUE_MOBILE_BREAKPOINT = 740;
// A landscape phone (e.g. 844x390) is wider than AI_LEAGUE_MOBILE_BREAKPOINT
// but just as cramped vertically — treat "short and wider than tall" the
// same as "narrow" so the panel defaults to its collapsed slim strip there
// too (see the matching `@media (max-height: ...) and (orientation:
// landscape)` rule in overlayHtml's stylesheet).
const AI_LEAGUE_MOBILE_LANDSCAPE_MAX_HEIGHT = 430;

function isNarrowReplayViewport(): boolean {
  return (
    window.innerWidth <= AI_LEAGUE_MOBILE_BREAKPOINT ||
    (window.innerHeight <= AI_LEAGUE_MOBILE_LANDSCAPE_MAX_HEIGHT &&
      window.innerWidth > window.innerHeight)
  );
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

function mountReplayPanelControls(overlay: HTMLElement, runID: string) {
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
      // P2 fix (pass-10 t4-03): this was ONLY a panel-position reset, but
      // it is the ONE control this header labels "Reset" — right next to
      // Play/Pause, exactly where a viewer expects "restart the match"
      // to live, and it visibly did nothing once the DC reached its end
      // screen. `LocalServer.ts`'s `jumpReplayForward()` (the engine
      // behind `ReplayJumpToTurnEvent`) is deliberately forward-only —
      // its own `Math.max(this.turns.length, …)` clamp means a turn-0
      // request after every turn has already played is a genuine no-op,
      // not a bug in that function; this app has no backward-seek path
      // through an already-replayed simulation, in ANY playback state.
      // A full reload is the one path already proven (QA's own repro) to
      // restart cleanly from turn 0 — safe specifically on this
      // coworld/DC replay route because `ReplayPositionPersistence.ts`'s
      // refresh-resume feature explicitly excludes `source ===
      // "coworld-replay"` (see `Main.ts`), so there is no saved position
      // to resume into. Same reload-to-restart convention this codebase
      // already uses elsewhere (`AccountModal.ts`, `Cosmetics.ts`,
      // `ReplayLoadingScreen.ts`'s own retry button).
      //
      // P0 fix (2026-08-03, deploy 2B): `window.location.reload()` trusts
      // whatever the LIVE address bar currently holds. `handleJoinLobby`'s
      // own `pathnameAtJoinStart` doc (Main.ts) already documents a real,
      // live-confirmed, not-fully-isolated case where `window.location.
      // pathname` transiently reads back wrong mid-navigation; QA caught
      // Reset itself landing on the site homepage instead of restarting
      // this replay, matching that exact class of URL-state drift. Reset
      // must always restart THIS replay regardless of whatever the
      // address bar happens to hold at click time, so it navigates to the
      // canonical `/ai-league-replay/:runID` path explicitly — the SAME
      // path shape `handleJoinLobby` itself pushes for this exact route —
      // instead of reloading in place.
      window.location.href = `/ai-league-replay/${encodeURIComponent(runID)}`;
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
        /*
         * Left-anchored: the top-right corner is the playback cluster's lane
         * (game-right-sidebar: time, speed, pause, settings, fullscreen,
         * leave). That strip has no stacking context of its own, so a panel
         * pinned top-right sat on top of it and made every playback control
         * unclickable. Moving to the left keeps both reachable and gives the
         * panel back its full height. game-left-sidebar is hidden in replay
         * mode, so this lane is free.
         */
        top: 12px;
        left: 12px;
        z-index: 50000;
        width: min(376px, calc(100vw - 24px));
        max-height: calc(100vh - 24px);
        overflow: hidden;
        display: grid;
        grid-template-rows: auto 1fr;
        /*
         * The implicit grid column is auto-sized, which floors at min-content.
         * Any unbreakable child (the nowrap run id) therefore widens the track
         * past the panel's own width, and overflow:hidden silently clips the
         * header controls out of reach instead of shrinking them. Pin the
         * column and let children shrink.
         */
        grid-template-columns: minmax(0, 1fr);
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
        /* Grid/flex children default to min-width:auto and refuse to shrink
           below their content; without this the run id pushes the header
           actions outside the panel. */
        min-width: 0;
      }
      #ai-league-replay-overlay header > div:first-child {
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
      }
      #ai-league-replay-overlay h2 {
        margin: 0 0 2px;
        font-size: 15px;
        white-space: nowrap;
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
        gap: 5px;
        align-items: center;
        flex: 0 0 auto;
      }
      .ai-league-header-actions button {
        padding: 5px 7px;
        font-size: 12px;
        white-space: nowrap;
      }
      .ai-league-header-actions button.is-on {
        border-color: var(--pw-accent, #f4a64a);
        color: var(--pw-accent, #f4a64a);
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
        min-width: 0;
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
      .ai-league-standings {
        display: grid;
        /* Header stays put, rows scroll. Without the fixed row track the block
           grew and shrank every frame (ranks reorder, stance chips come and
           go), which shoved every section below it up and down continuously. */
        grid-template-rows: auto minmax(0, 1fr);
        gap: 5px;
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 9px;
        margin: 0 0 10px;
        background: var(--pw-surface, #111720);
        height: 244px;
      }
      [data-ai-league-diplomacy-rows] {
        overflow-y: auto;
        overflow-x: hidden;
        min-height: 0;
        /* Keep the scrollbar from reflowing content when it appears. */
        scrollbar-gutter: stable;
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
      .ai-league-share {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 0 0;
        min-height: 30px;
      }
      .ai-league-share-button {
        border: 1px solid var(--pw-border, rgba(148, 163, 184, 0.28));
        background: var(--pw-surface, #111720);
        color: var(--pw-text, #e6edf6);
        border-radius: var(--pw-r-sm, 8px);
        padding: 6px 11px;
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition:
          background 120ms ease,
          border-color 120ms ease;
      }
      .ai-league-share-button:hover:not(:disabled) {
        background: var(--pw-surface-raised, #18202b);
        border-color: var(--pw-accent, #f4a64a);
      }
      .ai-league-share-button:focus-visible {
        outline: 2px solid var(--pw-accent, #f4a64a);
        outline-offset: 2px;
      }
      .ai-league-share-button:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .ai-league-share-status {
        font-size: 12px;
        color: var(--pw-text-muted, rgba(230, 237, 246, 0.62));
      }
      @media (pointer: coarse) {
        .ai-league-share-button {
          min-height: 44px;
          padding: 6px 14px;
        }
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
      /*
       * The clip moment picker shipped on the clips line while the panel was
       * still light, so it kept a white card (#f8fafc on slate borders) after
       * the panel went dark — the one visibly out-of-place block left on this
       * surface. Bring it onto the shared tokens like every other card here.
       */
      .ai-league-clip-selector {
        display: grid;
        gap: 7px;
        min-width: 0;
        margin: 0;
        padding: 8px;
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        background: var(--pw-surface-2, #18202b);
      }
      .ai-league-clip-selector legend {
        padding: 0 4px;
        color: var(--pw-text-dim, #cbd5e1);
        font-size: 12px;
        font-weight: 900;
      }
      .ai-league-clip-selected {
        color: var(--pw-text, #edf1f7);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        font-weight: 900;
      }
      /* Range track/thumb inherit the panel accent instead of the OS default,
         which renders near-invisible on a dark card. */
      .ai-league-clip-selector input[type="range"] {
        width: 100%;
        margin: 0;
        accent-color: var(--pw-accent, #f4a64a);
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
      /* Political radio is opt-in: hidden until the header toggle adds
         .ai-league-radio-on to <body>. It overlays the map's lower-left corner,
         so defaulting it on made the replay noisier than it needed to be. */
      body:not(.ai-league-radio-on) #ai-league-social-transcript {
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
        #ai-league-lower-third-host {
          bottom: calc(132px + env(safe-area-inset-bottom));
        }
        #ai-league-replay-overlay:not(.collapsed) ~ #ai-league-lower-third-host {
          bottom: calc(min(58vh, 520px) + 68px + env(safe-area-inset-bottom));
        }
      }
      /*
       * Stage 4 broadcast composition: ONE renderBroadcastDrawer() output
       * mounted inline in this panel's body (spec item 7) with four tabs —
       * agents (competitor rail), events (War Room feed), timeline, and
       * analysis (spec item 5). On desktop the tab bar stays hidden and
       * three of the four panels break out to fixed positions matching this
       * panel's original chrome layout (agents inline alongside the
       * diplomacy strip, events top-right, timeline bottom bar) — only
       * the --pw-* token wiring for the shared, deliberately style-free
       * BroadcastComposition module lives here. The mobile/landscape media
       * queries near the end of this stylesheet undo the fixed positioning
       * and turn this into an actual tabbed sheet on a narrow/short
       * viewport.
       */
      [data-ai-league-broadcast-drawer] .broadcast-drawer-tabs {
        display: none;
      }
      .broadcast-drawer-tab {
        border: 1px solid var(--pw-line-strong, #3a4656);
        background: var(--pw-surface-2, #18202b);
        color: var(--pw-text, #edf1f7);
        border-radius: 8px;
        font-weight: 700;
        cursor: pointer;
      }
      .broadcast-drawer-tab[aria-selected="true"] {
        border-color: var(--pw-accent, #f4a64a);
        color: var(--pw-accent, #f4a64a);
      }
      .broadcast-drawer-tab-badge {
        display: inline-block;
        margin-left: 4px;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--pw-danger, #f87171);
        color: #1a0505;
        font-size: 10px;
        font-weight: 900;
      }
      .broadcast-state-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 8px 9px;
        margin: 0 0 10px;
        background: var(--pw-surface, #111720);
      }
      .broadcast-state-strip-item {
        display: flex;
        align-items: baseline;
        gap: 5px;
        font-size: 12px;
      }
      .broadcast-state-strip-label {
        color: var(--pw-text-dim, #cbd5e1);
        font-weight: 700;
      }
      .broadcast-state-strip-value {
        color: var(--pw-text, #edf1f7);
        font-weight: 600;
      }
      .broadcast-state-strip-delta[data-direction="up"] .broadcast-state-strip-value {
        color: var(--pw-positive, #34d399);
      }
      .broadcast-state-strip-delta[data-direction="down"] .broadcast-state-strip-value {
        color: var(--pw-danger, #f87171);
      }
      .broadcast-rail {
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        padding: 9px;
        margin: 0 0 10px;
        background: var(--pw-surface, #111720);
      }
      .broadcast-rail-heading-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin: 0 0 6px;
      }
      .broadcast-rail-heading {
        margin: 0;
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--pw-text-dim, #cbd5e1);
      }
      /*
       * Collapse/expand (spec item 1): a side rail must never be
       * permanently half the viewport with no way to shrink it back. The
       * caret rotates via [aria-expanded] rather than swapping glyphs.
       */
      .broadcast-rail-collapse-toggle,
      .broadcast-war-room-collapse-toggle {
        flex: 0 0 auto;
        border: 1px solid var(--pw-line-strong, #3a4656);
        background: var(--pw-surface-2, #18202b);
        color: var(--pw-text-dim, #cbd5e1);
        border-radius: 6px;
        width: 22px;
        height: 22px;
        line-height: 1;
        cursor: pointer;
        transition: transform 0.15s ease;
      }
      .broadcast-rail-collapse-toggle[aria-expanded="false"],
      .broadcast-war-room-collapse-toggle[aria-expanded="false"] {
        transform: rotate(-90deg);
      }
      .broadcast-rail[data-collapsed="true"] .broadcast-rail-list,
      .broadcast-war-room[data-collapsed="true"] .broadcast-war-room-list {
        display: none;
      }
      /*
       * P0 fix (2026-08-03, deploy 2A -- corrected): collapsing the War
       * Room list only hid the list itself (rule above) -- the drawer
       * panel's OWN box (".broadcast-drawer-panel[data-tab-id="events"]",
       * fixed max-height above) kept its full height regardless, so
       * "Collapse" freed no screen space (the "impossible to minimize"
       * report). FIRST attempt here used a :has(.broadcast-war-room
       * [data-collapsed="true"]) ancestor selector, matching
       * ReplayPremiereOverlay.ts's own analogous fix -- but in THIS file
       * renderWarRoomFeed's own section carries "broadcast-war-room"
       * AND preserveDrawerPanelWrapperIdentity copies "broadcast-drawer-
       * panel"/data-tab-id onto that SAME element (never a wrapper), so
       * ".broadcast-drawer-panel[data-tab-id="events"]" and
       * ".broadcast-war-room[data-collapsed="true"]" are literally the
       * SAME node -- there is no ancestor/descendant relationship for
       * :has() to match, so the rule silently never applied (confirmed
       * live: computed max-height stayed at the full uncollapsed value).
       * A plain compound selector on that one element is correct here.
       */
      .broadcast-drawer-panel[data-tab-id="events"][data-collapsed="true"] {
        max-height: 58px;
      }
      .broadcast-rail-list {
        display: grid;
        gap: 8px;
        max-height: 320px;
        overflow-y: auto;
        overflow-x: hidden;
        min-height: 0;
        scrollbar-gutter: stable;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .broadcast-rail-empty {
        color: var(--pw-muted, #a4afbf);
        font-size: 12px;
      }
      .broadcast-rail-entry {
        display: grid;
        gap: 5px;
        padding: 7px 8px;
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        background: var(--pw-surface-2, #18202b);
        border-left: 3px solid var(--broadcast-agent-color, var(--pw-line-strong, #3a4656));
      }
      .broadcast-rail-entry[data-alive="false"] {
        opacity: 0.55;
      }
      .broadcast-rail-entry[data-followed="true"] {
        border-color: var(--pw-accent, #f4a64a);
        box-shadow: 0 0 0 1px var(--pw-accent, #f4a64a) inset;
      }
      .broadcast-rail-select {
        display: grid;
        gap: 5px;
        width: 100%;
        background: transparent;
        border: none;
        padding: 0;
        margin: 0;
        text-align: left;
        font: inherit;
        color: inherit;
      }
      button.broadcast-rail-select {
        cursor: pointer;
      }
      button.broadcast-rail-select[aria-pressed="true"] .broadcast-rail-name {
        color: var(--pw-accent, #f4a64a);
      }
      .broadcast-rail-identity {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      .broadcast-rail-emblem,
      .broadcast-rail-emblem-placeholder {
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .broadcast-rail-emblem svg {
        width: 100%;
        height: 100%;
      }
      .broadcast-rail-emblem-placeholder {
        border-radius: 50%;
        background: var(--pw-surface-3, #212b38);
        color: var(--pw-muted, #a4afbf);
        font-size: 11px;
        font-weight: 900;
      }
      .broadcast-rail-name-block {
        display: grid;
        min-width: 0;
      }
      .broadcast-rail-name {
        font-weight: 900;
        color: var(--pw-text, #edf1f7);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .broadcast-rail-version,
      .broadcast-rail-builder {
        display: block;
        font-size: 10px;
        color: var(--pw-muted, #a4afbf);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .broadcast-rail-stats {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        font-size: 11px;
        font-weight: 700;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .broadcast-rail-eliminated {
        color: var(--pw-danger, #f87171);
        font-weight: 900;
      }
      .broadcast-rail-degraded {
        color: var(--pw-caution-text, #fde68a);
      }
      .broadcast-rail-relations {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 11px;
        color: var(--pw-muted, #a4afbf);
      }
      .broadcast-rail-wars {
        color: var(--pw-danger, #f87171);
      }
      .broadcast-rail-allies {
        color: var(--pw-positive-text, #a7f3d0);
      }
      .broadcast-drawer-panel[data-tab-id="events"] {
        position: fixed;
        /*
         * Structural fix (P0 incident, 2026-08-03), see
         * mountControlClusterGeometrySync's own doc: a fixed "top: 76px"
         * assumed the playback control cluster (game-right-sidebar +
         * replay-panel, index.html's "#pw-game-control-cluster") never
         * exceeds ~66px, true only at >=1200px viewport width. Below that
         * (but still well above the drawer's own 740px mobile breakpoint)
         * the SAME buttons grow to 44px touch targets and the cluster gets
         * taller than the budget, so this panel silently overlapped the
         * controls again in that band -- found live at 1178px. "top" now
         * reads the cluster's ACTUAL measured bottom edge (kept live by a
         * ResizeObserver + resize listener), correct at every viewport
         * width, not just the two breakpoints this constant was tuned for.
         * "76px" stays only as the pre-first-measurement fallback, and
         * "#pw-game-control-cluster"'s own z-index (index.html, above
         * every band used here) is the belt-and-suspenders guarantee that
         * even a stale fallback can never make the controls unclickable.
         */
        top: calc(var(--pw-control-cluster-bottom, 76px) + 10px);
        right: 12px;
        z-index: 50000;
        width: min(360px, calc(100vw - 24px));
        max-height: calc(100vh - var(--pw-control-cluster-bottom, 76px) - 22px);
        overflow: hidden;
        border: 1px solid var(--pw-line-strong, #3a4656);
        border-radius: var(--pw-r-xl, 18px);
        background: var(--pw-glass-strong, rgba(10, 14, 20, 0.95));
        color: var(--pw-text, #edf1f7);
        box-shadow: var(--pw-shadow, 0 26px 74px rgba(0, 0, 0, 0.52));
        backdrop-filter: blur(18px) saturate(1.15);
        font: 13px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .broadcast-war-room {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
        height: 100%;
        padding: 12px;
        gap: 8px;
        box-sizing: border-box;
      }
      .broadcast-war-room-heading-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .broadcast-war-room-heading {
        margin: 0;
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .broadcast-war-room-list {
        display: grid;
        gap: 7px;
        margin: 0;
        padding: 0;
        list-style: none;
        overflow-y: auto;
        min-height: 0;
        scrollbar-gutter: stable;
      }
      .broadcast-war-room-empty {
        color: var(--pw-muted, #a4afbf);
        font-size: 12px;
      }
      .broadcast-war-room-earlier {
        display: flex;
        justify-content: center;
      }
      .broadcast-war-room-item {
        border: 1px solid var(--pw-line, #2a3442);
        border-radius: 8px;
        background: var(--pw-surface-2, #18202b);
      }
      /*
       * Tier 3 "routine" rows (War Room curation spec, deploy 3.3): compact
       * single-line treatment so a viewer can visually tell "a lot just
       * happened" from "routine skirmish" by row weight alone, without
       * reading text (spec acceptance criterion). Consecutive tier-3 runs
       * are pre-collapsed into one grouped summary row by
       * groupRoutineWarRoomEvents() before this ever renders, so this only
       * ever needs to shrink a genuinely routine singleton or a group
       * summary — never hide content outright.
       */
      .broadcast-war-room-item[data-tier="3"] {
        background: transparent;
        border-color: transparent;
      }
      .broadcast-war-room-item[data-tier="3"] .broadcast-war-room-summary {
        padding: 3px 9px;
        opacity: 0.62;
        font-size: 11px;
      }
      .broadcast-war-room-item[data-tier="3"] .broadcast-war-room-glyph,
      .broadcast-war-room-item[data-tier="3"] .broadcast-war-room-kind {
        display: none;
      }
      /*
       * Tier 1 "major" rows: full-width, bold, distinct accent border — the
       * handful of moments (elimination/alliance/betrayal) that actually
       * matter, weighted to stand out from the tier-2 default style around
       * them.
       */
      .broadcast-war-room-item[data-tier="1"] {
        border-color: var(--pw-line-strong, #3a4656);
        background: var(--pw-surface-3, #202b3a);
      }
      .broadcast-war-room-item[data-tier="1"] .broadcast-war-room-summary {
        padding: 9px 11px;
      }
      .broadcast-war-room-item[data-tier="1"] .broadcast-war-room-headline {
        font-weight: 800;
      }
      .broadcast-war-room-item[data-tier="1"] .broadcast-war-room-glyph {
        font-size: 15px;
      }
      .broadcast-war-room-summary {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        padding: 7px 9px;
        background: transparent;
        border: none;
        text-align: left;
        font: inherit;
        color: inherit;
        cursor: pointer;
      }
      .broadcast-war-room-glyph {
        flex: 0 0 auto;
        font-weight: 900;
        color: var(--pw-info, #56c7f5);
      }
      .broadcast-war-room-kind {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--pw-info, #56c7f5);
      }
      /*
       * Name truncation fix (War Room curation spec item 3, deploy 3.3):
       * a fixed nowrap+ellipsis silently cut off long agent names
       * ("Captain Underpants Maximum strike…", "K1Z Mickey Mouse strikes
       * SIAN VOID…") with no way to see the rest. The row already lives in
       * its own repositioned column with room to grow, so this now wraps
       * onto a second line instead of truncating — nothing is ever
       * silently cut off.
       */
      .broadcast-war-room-headline {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: break-word;
        white-space: normal;
      }
      .broadcast-war-room-turn {
        flex: 0 0 auto;
        font-size: 11px;
        color: var(--pw-muted, #a4afbf);
        font-variant-numeric: tabular-nums;
      }
      .broadcast-war-room-item[data-kind="betrayal"] .broadcast-war-room-glyph,
      .broadcast-war-room-item[data-kind="elimination"] .broadcast-war-room-glyph {
        color: var(--pw-danger, #f87171);
      }
      .broadcast-war-room-item[data-kind="alliance"] .broadcast-war-room-glyph {
        color: var(--pw-positive, #34d399);
      }
      .broadcast-war-room-item[data-kind="first_strike"] .broadcast-war-room-glyph,
      .broadcast-war-room-item[data-kind="plan_change"] .broadcast-war-room-glyph {
        color: var(--pw-caution, #fbbf24);
      }
      .broadcast-war-room-detail {
        padding: 0 9px 9px;
        display: grid;
        gap: 4px;
        font-size: 12px;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .broadcast-war-room-detail[hidden] {
        display: none;
      }
      .broadcast-war-room-reason {
        margin: 0;
      }
      /*
       * white-space: pre-line (not the plain margin: 0 every other War
       * Room detail paragraph gets): a grouped tier-3 summary row
       * (groupRoutineWarRoomEvents, spec item 1) packs each collapsed
       * skirmish's headline into this field newline-separated, so a
       * viewer who expands "+N more skirmishes" sees one line per
       * skirmish instead of one run-on sentence.
       */
      .broadcast-war-room-extra {
        margin: 0;
        white-space: pre-line;
      }
      .broadcast-war-room-jump {
        justify-self: start;
      }
      .broadcast-drawer-panel[data-tab-id="timeline"] {
        position: fixed;
        left: 404px;
        right: 388px;
        bottom: 12px;
        z-index: 49995;
        border: 1px solid var(--pw-line-strong, #3a4656);
        border-radius: var(--pw-r-xl, 18px);
        background: var(--pw-glass-strong, rgba(10, 14, 20, 0.95));
        box-shadow: var(--pw-shadow-soft, 0 12px 32px rgba(0, 0, 0, 0.35));
        backdrop-filter: blur(12px) saturate(1.1);
        padding: 8px 12px;
        box-sizing: border-box;
      }
      .broadcast-timeline-track {
        position: relative;
        height: 20px;
        margin: 0;
        padding: 0;
        border-radius: 999px;
        background: var(--pw-surface-2, #18202b);
      }
      .broadcast-timeline-marker {
        position: absolute;
        top: 50%;
        left: var(--broadcast-timeline-position, 0%);
        transform: translate(-50%, -50%);
        width: 10px;
        height: 10px;
        padding: 0;
        border: 1px solid var(--pw-line-strong, #3a4656);
        border-radius: 50%;
        background: var(--pw-info, #56c7f5);
        cursor: pointer;
      }
      .broadcast-timeline-marker[data-seekable="false"] {
        cursor: default;
        opacity: 0.55;
      }
      .broadcast-timeline-marker[data-kind="spawn"] {
        background: var(--pw-muted, #a4afbf);
      }
      .broadcast-timeline-marker[data-kind="alliance"] {
        background: var(--pw-positive, #34d399);
      }
      .broadcast-timeline-marker[data-kind="first_strike"] {
        background: var(--pw-caution, #fbbf24);
      }
      .broadcast-timeline-marker[data-kind="lead_change"] {
        background: var(--pw-info, #56c7f5);
      }
      .broadcast-timeline-marker[data-kind="betrayal"],
      .broadcast-timeline-marker[data-kind="elimination"],
      .broadcast-timeline-marker[data-kind="nuke"] {
        background: var(--pw-danger, #f87171);
      }
      .broadcast-timeline-marker[data-kind="nuke"] {
        width: 12px;
        height: 12px;
      }
      .broadcast-timeline-marker[data-kind="finish"] {
        background: var(--pw-text, #edf1f7);
      }
      /*
       * Analyst mode (spec item 5): hidden on desktop by default (the
       * curated rail/War Room/timeline view never auto-opens it) — the
       * header's "Analyst mode" toggle adds ai-league-analyst-mode to the
       * overlay root, which promotes this SAME drawer panel (identical DOM
       * to the mobile "Analysis" tab's content) to a centered fixed panel.
       */
      .broadcast-drawer-panel[data-tab-id="analysis"] {
        display: none;
      }
      body.ai-league-analyst-mode .broadcast-drawer-panel[data-tab-id="analysis"] {
        display: block;
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 50010;
        width: min(640px, calc(100vw - 32px));
        max-height: min(80vh, 720px);
        overflow-y: auto;
        border: 1px solid var(--pw-line-strong, #3a4656);
        border-radius: var(--pw-r-xl, 18px);
        background: var(--pw-glass-strong, rgba(10, 14, 20, 0.95));
        color: var(--pw-text, #edf1f7);
        box-shadow: var(--pw-shadow, 0 26px 74px rgba(0, 0, 0, 0.52));
        backdrop-filter: blur(18px) saturate(1.15);
        padding: 14px;
        box-sizing: border-box;
      }
      .broadcast-analyst {
        display: grid;
        gap: 14px;
        font-size: 12px;
      }
      .broadcast-analyst-chart {
        display: grid;
        gap: 6px;
      }
      .broadcast-analyst-chart-heading,
      .broadcast-analyst-decisions-heading,
      .broadcast-analyst-events-heading {
        margin: 0;
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--pw-text-dim, #cbd5e1);
      }
      .broadcast-analyst-chart-row {
        display: grid;
        grid-template-columns: 90px 1fr auto;
        align-items: center;
        gap: 8px;
      }
      /*
       * P2 fix (pass-1 p1-05/p1-06, 2026-08-02): the count column was a
       * fixed 32px — plenty for a single/double-digit count but silently
       * clipping mid-digit once a match's action-kind tally passed 999
       * (CSS Grid clips overflowing content with no ellipsis by
       * default). "auto" above sizes the column to its real content;
       * tabular-nums (same fix .broadcast-war-room-turn already
       * uses) keeps digits from jittering in width as they tick up live.
       */
      .broadcast-analyst-chart-count {
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .broadcast-analyst-chart-bar {
        height: 8px;
        border-radius: 999px;
        background: var(--pw-surface-2, #18202b);
        overflow: hidden;
      }
      .broadcast-analyst-chart-bar > span {
        display: block;
        height: 100%;
        background: var(--pw-info, #56c7f5);
        width: var(--broadcast-analyst-chart-width, 0%);
      }
      .broadcast-analyst-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
      }
      .broadcast-analyst-table th,
      .broadcast-analyst-table td {
        text-align: left;
        padding: 4px 6px;
        border-bottom: 1px solid var(--pw-line, #2a3442);
      }
      .broadcast-analyst-empty {
        color: var(--pw-muted, #a4afbf);
        font-size: 12px;
      }
      .broadcast-analyst-decisions-earlier td,
      .broadcast-analyst-events-earlier {
        display: flex;
        justify-content: center;
      }
      /*
       * Lower thirds (spec item 3): fixed over the map (never inside this
       * panel's scrollable body), pointer-events: none on the host so a
       * pulse never blocks a map click, and the entrance animation gates on
       * [data-reduced-motion="false"] — LowerThirdController itself sets
       * that attribute; a reduced-motion viewer only ever gets a static
       * opacity fade, never the scale pulse.
       *
       * Bottom-anchored, above the desktop-fixed timeline bar (spec item 3
       * fix: this previously sat at top:16px, the EXACT lane
       * pov-selector's "Follow:" control also occupies — see
       * PointOfViewSelector.ts's fixed top-4 left-1/2 -translate-x-1/2
       * root — so every pulse visually buried the follow control behind
       * it. Reserving a distinct bottom lane, clear of the timeline bar
       * (.broadcast-drawer-panel[data-tab-id="timeline"]'s bottom:12px
       * + ~38px height) and of the older #ai-league-headline-event
       * banner's own bottom:9% lane, removes the overlap without
       * touching either of those.
       */
      #ai-league-lower-third-host {
        position: fixed;
        left: 50%;
        bottom: 60px;
        transform: translateX(-50%);
        z-index: 50005;
        pointer-events: none;
        display: flex;
        justify-content: center;
      }
      .broadcast-lower-third {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        border: 1px solid var(--pw-line-strong, #3a4656);
        border-radius: 999px;
        background: var(--pw-glass-strong, rgba(10, 14, 20, 0.95));
        color: var(--pw-text, #edf1f7);
        box-shadow: var(--pw-shadow, 0 26px 74px rgba(0, 0, 0, 0.52));
        backdrop-filter: blur(18px) saturate(1.15);
        font-weight: 700;
        font-size: 13px;
        opacity: 0;
        animation: broadcast-lower-third-static-in 0.15s ease forwards;
      }
      .broadcast-lower-third[data-reduced-motion="false"] {
        animation: broadcast-lower-third-pulse-in 0.4s ease forwards;
      }
      .broadcast-lower-third-glyph {
        font-weight: 900;
        color: var(--pw-info, #56c7f5);
      }
      .broadcast-lower-third[data-kind="betrayal"] .broadcast-lower-third-glyph,
      .broadcast-lower-third[data-kind="elimination"] .broadcast-lower-third-glyph {
        color: var(--pw-danger, #f87171);
      }
      .broadcast-lower-third[data-kind="alliance"] .broadcast-lower-third-glyph {
        color: var(--pw-positive, #34d399);
      }
      .broadcast-lower-third[data-kind="first_strike"] .broadcast-lower-third-glyph,
      .broadcast-lower-third[data-kind="plan_change"] .broadcast-lower-third-glyph {
        color: var(--pw-caution, #fbbf24);
      }
      @keyframes broadcast-lower-third-static-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes broadcast-lower-third-pulse-in {
        0% { opacity: 0; transform: scale(0.85); }
        60% { opacity: 1; transform: scale(1.05); }
        100% { opacity: 1; transform: scale(1); }
      }
      /*
       * Mobile bottom-sheet drawer (spec item 7): undo every desktop fixed-
       * position break-out above so all four panels sit back in normal flow
       * inside this panel's own body, show the tab bar, and only render the
       * active tab's panel — the SAME data-tab-active BroadcastComposition
       * already stamps on every panel, never a second, parallel visibility
       * mechanism.
       */
      @media (max-width: 740px) {
        [data-ai-league-broadcast-drawer] .broadcast-drawer-tabs {
          display: flex;
          gap: 4px;
          margin: 0 0 8px;
        }
        .broadcast-drawer-tab {
          flex: 1 1 0;
          min-width: 0;
          min-height: 44px;
          padding: 6px 4px;
          font-size: 11px;
        }
        /*
         * The plain .broadcast-drawer-panel reset below is (class-only)
         * specificity 0,1,0 -- LOWER than the desktop .broadcast-drawer-
         * panel[data-tab-id="events"]/[data-tab-id="timeline"] rules
         * (class + attribute = 0,2,0), so CSS specificity -- not source
         * order, not the media query -- decided the winner: the desktop
         * position:fixed rules kept winning here regardless. Timeline
         * kept its desktop-only left:404px; right:388px; at a 390px
         * viewport (an already-negative computed width), rendering
         * entirely off-screen and permanently unreachable on mobile
         * (found live during the P1 mobile sweep). Repeating the same
         * [data-tab-id] attribute selectors here matches that
         * specificity exactly; being later in source order then wins the
         * cascade tie the way every other selector in this block already
         * (correctly) relies on.
         */
        .broadcast-drawer-panel,
        .broadcast-drawer-panel[data-tab-id="events"],
        .broadcast-drawer-panel[data-tab-id="timeline"] {
          position: static;
          top: auto;
          left: auto;
          right: auto;
          bottom: auto;
          transform: none;
          width: auto;
          max-height: none;
          z-index: auto;
          display: none;
        }
        .broadcast-drawer-panel[data-tab-active="true"] {
          display: block;
        }
        body.ai-league-analyst-mode .broadcast-drawer-panel[data-tab-id="analysis"] {
          position: static;
          transform: none;
          width: auto;
          max-height: none;
        }
        [data-ai-league-analyst-toggle] {
          display: none;
        }
        .broadcast-rail-list {
          max-height: none;
        }
      }
      /*
       * Landscape phones (e.g. 844x390): width alone stays above the
       * @media (max-width: 740px) breakpoint above, so this panel's own
       * default (desktop) chrome would otherwise cover almost the full,
       * already-short viewport height. Gate on height instead: same tabbed,
       * in-flow drawer as the portrait rule above, plus a narrower/shorter
       * panel geometry so the map stays dominant.
       */
      @media (max-height: 430px) and (orientation: landscape) {
        #ai-league-replay-overlay,
        body.ai-league-native-spectator-ui #ai-league-replay-overlay {
          top: 8px;
          left: 8px;
          right: auto;
          bottom: auto;
          width: min(260px, 42vw);
          max-height: calc(100vh - 16px);
          border-radius: 12px;
        }
        #ai-league-replay-overlay:not(.collapsed) {
          height: min(85vh, 360px);
        }
        #ai-league-replay-overlay header {
          min-height: 40px;
          padding: 5px 8px;
        }
        [data-ai-league-broadcast-drawer] .broadcast-drawer-tabs {
          display: flex;
          gap: 3px;
          margin: 0 0 6px;
        }
        .broadcast-drawer-tab {
          flex: 1 1 0;
          min-width: 0;
          min-height: 36px;
          padding: 4px;
          font-size: 10px;
        }
        .broadcast-drawer-panel,
        .broadcast-drawer-panel[data-tab-id="events"],
        .broadcast-drawer-panel[data-tab-id="timeline"] {
          position: static;
          top: auto;
          left: auto;
          right: auto;
          bottom: auto;
          transform: none;
          width: auto;
          max-height: none;
          z-index: auto;
          display: none;
        }
        .broadcast-drawer-panel[data-tab-active="true"] {
          display: block;
        }
        body.ai-league-analyst-mode .broadcast-drawer-panel[data-tab-id="analysis"] {
          position: static;
          transform: none;
          width: auto;
          max-height: none;
        }
        [data-ai-league-analyst-toggle] {
          display: none;
        }
        .broadcast-rail-list {
          max-height: 30vh;
        }
        /*
         * P2 fix (pass-10, small item): the tab bar (Agents/Events/
         * Timeline/Analysis) lives INSIDE [data-ai-league-broadcast-
         * drawer], but that container renders AFTER .ai-league-
         * standings in DOM order — fine at every other breakpoint
         * (plenty of vertical room), but at this viewport's ~277px
         * visible body height, Standings' own (unbounded, up to 12
         * agents) rows plus the match-state strip above the tabs pushed
         * the tab bar to ~y:419 in a 390px-tall viewport — reachable by
         * scrolling the panel, but not visible on open (QA pass-10 t2-02:
         * "tabs container was measured OFF the visible viewport on
         * initial open"). Standings' own ranked-agent content is already
         * duplicated by the drawer's own "Agents" tab, so reordering
         * (never hiding — still one scroll away, same as every other
         * off-fold section) the drawer ahead of it is a pure visual
         * reorder: Standings' DOM position/tab order/scroll-anchoring
         * are untouched, only where it PAINTS relative to the drawer.
         */
        .ai-league-body {
          display: flex;
          flex-direction: column;
        }
        [data-ai-league-broadcast-drawer] {
          order: 1;
        }
        .ai-league-standings {
          order: 2;
        }
        [data-ai-league-details] {
          order: 3;
        }
      }
    </style>
    <header data-ai-league-drag>
      <div>
        <h2>${escapeHtml(translateText("ai_league_replay.title"))}</h2>
        <!--
          Subtitle carries what a viewer needs to place the match (map, agent
          count, length). The run id is support provenance, not a headline, so
          it moves to the tooltip. Populated by the details render because the
          summary arrives after the shell mounts.
        -->
        <div class="ai-league-muted ai-league-run-id" data-ai-league-subtitle title="${escapeHtml(input.runID)}">${escapeHtml(matchSubtitle(input) ?? input.runID)}</div>
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
      <div data-ai-league-broadcast-drawer></div>
      <div data-ai-league-details>${overlayDetailsHtml(input)}</div>
    </div>
    <div class="ai-league-resize-handle" data-ai-league-resize aria-hidden="true"></div>`;
}

function overlayDetailsHtml(input: AiLeagueReplayOverlayInput): string {
  // Playhead window for the decision log and talks. Per-overlay (carried on the
  // input), never module state: two mounted overlays must not share it.
  const currentTurn = input.currentTurn ?? 0;
  const localRejectedCount = input.decisions.filter(
    (decision) => !decision.result.accepted,
  ).length;
  const localFallbackCount = input.decisions.filter(
    (decision) => decision.fallbackUsed,
  ).length;
  const decisionCount =
    nonNegativeCount(input.summary?.decisionCount) ?? input.decisions.length;
  const rejectedCount =
    nonNegativeCount(input.summary?.rejectedCount) ?? localRejectedCount;
  const fallbackCount =
    nonNegativeCount(input.summary?.fallbackCount) ?? localFallbackCount;

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
      : "";

  return `
    <section class="ai-league-metrics">
      <div class="ai-league-metric" title="${escapeHtml(translateText("ai_league_replay.metric_moves_tip"))}">${escapeHtml(translateText("ai_league_replay.metric_moves"))}<b>${metricValue(decisionCount)}</b></div>
      <div class="ai-league-metric" title="${escapeHtml(translateText("ai_league_replay.metric_invalid_tip"))}">${escapeHtml(translateText("ai_league_replay.metric_invalid"))}<b>${metricValue(rejectedCount)}</b></div>
      <div class="ai-league-metric${!input.detailsLoading && fallbackCount > 0 ? " warn" : ""}" title="${escapeHtml(translateText("ai_league_replay.metric_recovered_tip"))}">${escapeHtml(translateText("ai_league_replay.metric_recovered"))}<b>${metricValue(fallbackCount)}</b>${recoveredShareHtml(input, fallbackCount, decisionCount, detailsUnavailable)}</div>
    </section>
    ${input.detailsLoading || detailsUnavailable ? setupHtml : ""}
    ${spectatorTelemetry ? communicationThreadsHtml(spectatorTelemetry) : ""}
    <section class="ai-league-share">
      <button type="button" class="ai-league-share-button" data-ai-league-share-button
        title="${escapeHtml(translateText("ai_league_replay.share_image_tip"))}">
        ${escapeHtml(translateText("ai_league_replay.share_image"))}
      </button>
      <span class="ai-league-share-status" data-ai-league-share-status role="status" aria-live="polite"></span>
    </section>
    <section class="ai-league-clip" data-ai-league-clip></section>
    ${decisionLogHtml(input.decisions, currentTurn)}`;
}

/**
 * One-line match identity for the panel header: map, agent count, and length.
 * Replaces the raw run id, which wrapped, dominated the header, and told a
 * viewer nothing. Returns null while the summary has not arrived, in which case
 * the header keeps showing the run id.
 */
function matchSubtitle(input: AiLeagueReplayOverlayInput): string | null {
  const summary = input.summary;
  if (summary === null || summary === undefined) return null;
  const agentCount = summary.roster?.length ?? 0;
  const mapName =
    typeof summary.runnerConfig?.map === "string"
      ? summary.runnerConfig.map
      : null;
  const maxSteps = summary.runnerConfig?.maxSteps ?? null;
  const bots = summary.runnerConfig?.bots ?? null;
  const nations = summary.runnerConfig?.nations ?? null;
  const builtInCount = numericCount(nations) + numericCount(bots);
  // Built-in opponents only exist outside the agent-vs-agent league, and the
  // "vs N built-in opponents" clause is meaningless when there are none.
  const roster =
    agentCount > 0 && builtInCount > 0
      ? translateText("ai_league_replay.setup_agents_vs_builtin", {
          agents: agentCount,
          opponents: builtInCount,
        })
      : agentCount > 0
        ? translateText("ai_league_replay.setup_agents_only", {
            agents: agentCount,
          })
        : null;
  const parts = [
    mapName,
    roster,
    maxSteps !== null && maxSteps !== undefined
      ? translateText("ai_league_replay.setup_decisions", { steps: maxSteps })
      : null,
  ].filter((part): part is string => part !== null && part !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
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

const AI_LEAGUE_DECISION_LOG_CAP = 15;

function decisionLogHtml(
  decisions: AiLeagueDecisionLogEntry[],
  currentTurn: number,
): string {
  decisions = decisions.filter(
    (decision) =>
      !Number.isFinite(decision.turnNumber) ||
      decision.turnNumber <= currentTurn,
  );
  // Always emit the region wrapper, even with nothing to show yet: the playhead
  // sync refreshes this element in place, so it has to exist from first paint
  // (at turn 0 every decision is still in the future).
  if (decisions.length === 0) {
    return `<div data-ai-league-decisions-region></div>`;
  }
  const visible = decisions.slice(-AI_LEAGUE_DECISION_LOG_CAP);
  const olderCount = Math.max(0, decisions.length - visible.length);
  const expander =
    olderCount > 0
      ? `<button type="button" class="ai-league-badge" data-ai-league-decision-expander aria-expanded="false" aria-controls="ai-league-older-decisions">${escapeHtml(translateText("ai_league_replay.decisions_show_older", { count: olderCount }))}</button>`
      : "";
  // The decision log is the panel's largest block and is reference material,
  // not something a viewer wants open by default. Ship it collapsed behind a
  // disclosure; the older-pages expander lives inside the disclosed region.
  return `
    <div data-ai-league-decisions-region>
    <div class="ai-league-decisions-head">
      <span class="ai-league-decisions-title">${escapeHtml(translateText("ai_league_replay.decisions_title"))}</span>
      <button type="button" class="ai-league-badge" data-ai-league-decisions-toggle aria-expanded="false" aria-controls="ai-league-decisions-body">${escapeHtml(translateText("ai_league_replay.decisions_show"))}</button>
    </div>
    <div id="ai-league-decisions-body" data-ai-league-decisions-body hidden>
      ${expander}
      ${olderCount > 0 ? `<div id="ai-league-older-decisions" data-ai-league-decision-pages></div>` : ""}
      ${visible.map(decisionHtml).join("")}
    </div>
    </div>`;
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
  // events. Skipping identical re-renders avoids per-tick DOM churn (layout
  // + listener teardown) on the hottest spectator surface. When content DOES
  // change, patch the scrolled container's rows in place, keyed by player
  // identity (`patchKeyedRegion`) — this region is independently scrollable
  // (`[data-ai-league-diplomacy-rows] { overflow-y: auto }`, spec: standings
  // panel), and a wholesale `container.innerHTML =` reset its `scrollTop` to
  // 0 on every ownership/diplomacy change during active play — the "teleports
  // me back when I try to scroll in director cut" class.
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
    const fresh = document.createElement("div");
    fresh.innerHTML = rowsHtml;
    patchKeyedRegion(container, fresh, "data-diplo-key");
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
  // Each player's block is wrapped in one keyed wrapper element so
  // `patchKeyedRegion` (mountAiLeagueDiplomacyStrip's onFrame) can diff and
  // move it as a single unit — `playerID` is a stable per-agent identity,
  // matching the `bySmallID`/`byPlayerID` maps built above.
  const moreLine =
    hiddenCount > 0
      ? `<div class="ai-league-diplo-entry" data-diplo-key="__more__"><p class="ai-league-diplo-more">${escapeHtml(
          translateText("ai_league_replay.standings_more").replace(
            "{count}",
            String(hiddenCount),
          ),
        )}</p></div>`
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
        <div class="ai-league-diplo-entry" data-diplo-key="${escapeHtml(player.playerID)}">
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
        }
        </div>`;
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

// ---------------------------------------------------------------------------
// Stage 4 broadcast composition — left competitor rail, right War Room feed,
// bottom timeline. These wire the SHARED, style-free `BroadcastComposition`
// components into this overlay's own existing data (frame state, decision
// log, spectator telemetry) and existing turn-navigation mechanism
// (`ai-league-replay-jump-turn`, the same event `mountReplayJumpControls`
// already dispatches for the standings/comms "jump to turn" buttons). Full
// Replay is unbounded/complete data — no spoiler restriction — so, unlike
// the playhead-windowed decision log, none of this is windowed to the
// current turn.
// ---------------------------------------------------------------------------

// Same reasoning as diplomacyRowsHtml's STANDINGS_MAX_ROWS: bots/tribes are
// frame players too, and an uncapped rail would flood with dozens of rows.
const AI_LEAGUE_RAIL_MAX_ROWS = 12;

// Matches AgentDramaReport.ts's own HIGH_IMPORTANCE_THRESHOLD convention —
// the War Room feed is deliberately selective, not a mirror of every event.
const AI_LEAGUE_WAR_ROOM_IMPORTANCE_THRESHOLD = 80;

/**
 * Agent identity (emblem, exact version label, builder, color) is always
 * public — only match OUTCOME is embargoed — so this fetches once per
 * overlay mount via the existing public read model. A failed fetch degrades
 * to "nothing resolved yet", exactly like an unmatched player (never blocks
 * or fails the overlay mount).
 */
async function resolveAiLeagueIdentities(): Promise<
  ReadonlyMap<string, PublicAgent>
> {
  try {
    const readModel = await fetchReadModel();
    const byPlayerName = new Map<string, PublicAgent>();
    for (const agent of readModel.agents) {
      byPlayerName.set(agent.playerName, agent);
    }
    return byPlayerName;
  } catch {
    return new Map();
  }
}

/** Full roster of raw player names ever known to this match: every telemetry
 * agent (the complete, pre-frame roster) plus any current-frame player not
 * yet reflected there (defensive — telemetry should already be a superset).
 */
function aiLeagueCompetitorRoster(
  telemetry: AiLeagueSpectatorTelemetry | null,
  framePlayers: readonly AiLeagueReplayFramePlayer[],
): { username: string; playerID: string | null }[] {
  const seen = new Set<string>();
  const roster: { username: string; playerID: string | null }[] = [];
  for (const agent of telemetry?.agents ?? []) {
    const key = agent.playerID ?? normalizeName(agent.username);
    if (seen.has(key)) continue;
    seen.add(key);
    roster.push({ username: agent.username, playerID: agent.playerID });
  }
  for (const player of framePlayers) {
    const key = player.playerID ?? normalizeName(player.username);
    if (seen.has(key)) continue;
    seen.add(key);
    roster.push({ username: player.username, playerID: player.playerID });
  }
  return roster;
}

/**
 * Degraded-decision count per agent — fallback recovery (already the
 * panel's own "Recovered" signal, see recoveredShareHtml) or a failed audit
 * (the engine could not confirm the decision's effect). "unknown" auditStatus
 * is deliberately excluded: it just means unaudited (e.g. most non-combat
 * actions), not degraded.
 */
function degradedDecisionCountByPlayer(
  decisions: readonly AiLeagueDecisionLogEntry[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    if (!decision.fallbackUsed && decision.auditStatus !== "failed") continue;
    const key = normalizeName(decision.username);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Allies/wars resolved to display names, reusing diplomacyStancesHtml's own
 * bidirectional war detection (a rival targeting this player counts even if
 * this player has not targeted back) and the same ally-suppresses-war
 * precedence. Only resolvable for a player present in the CURRENT frame —
 * `bySmallID` only ever covers the live frame, so an eliminated/not-yet-
 * spawned player's allies/wars are "none known" (empty array), never
 * fabricated.
 */
function aiLeagueRailRelations(
  player: AiLeagueReplayFramePlayer,
  bySmallID: ReadonlyMap<number, AiLeagueReplayFramePlayer>,
  identityByPlayerName: ReadonlyMap<string, PublicAgent>,
): { allies: string[]; wars: string[] } {
  const nameFor = (other: AiLeagueReplayFramePlayer): string =>
    identityByPlayerName.get(other.username)?.displayName ??
    aiLeagueSpectatorDisplayName(other.displayName || other.username);

  const allies = Array.isArray(player.allies) ? player.allies : [];
  const alliedSmallIDs = new Set<number>(allies);
  const allyNames = allies
    .map((smallID) => bySmallID.get(smallID))
    .filter((other): other is AiLeagueReplayFramePlayer => other !== undefined)
    .map(nameFor);

  const targets = Array.isArray(player.targets) ? player.targets : [];
  const warSmallIDs = new Set<number>(targets);
  for (const other of bySmallID.values()) {
    if (other.smallID === player.smallID) continue;
    if (
      Array.isArray(other.targets) &&
      other.targets.includes(player.smallID)
    ) {
      warSmallIDs.add(other.smallID);
    }
  }
  const warNames = [...warSmallIDs]
    .filter((smallID) => !alliedSmallIDs.has(smallID))
    .map((smallID) => bySmallID.get(smallID))
    .filter((other): other is AiLeagueReplayFramePlayer => other !== undefined)
    .map(nameFor);

  return { allies: allyNames, wars: warNames };
}

/**
 * Derives every CompetitorRailEntry for the CURRENT frame. `territoryPercent`
 * and `inMatchRank` mirror diplomacyRowsHtml's own math exactly (share of
 * the currently-alive+spawned frame roster's tilesOwned, ranked descending)
 * — a player absent from the current frame (eliminated or not yet spawned)
 * gets `null` for both rather than a stale/fabricated value. `alive` prefers
 * frame presence (the file's own live alive signal — ClientGameRunner only
 * ever puts `isAlive() && hasSpawned()` players into a frame) and falls back
 * to the telemetry roster's own `isAlive` field for a player currently
 * absent from the frame.
 */
function competitorRailEntries(
  telemetry: AiLeagueSpectatorTelemetry | null,
  decisions: readonly AiLeagueDecisionLogEntry[],
  framePlayers: readonly AiLeagueReplayFramePlayer[],
  identityByPlayerName: ReadonlyMap<string, PublicAgent>,
): CompetitorRailEntry[] {
  const roster = aiLeagueCompetitorRoster(telemetry, framePlayers);
  if (roster.length === 0) {
    return [];
  }

  const bySmallID = new Map<number, AiLeagueReplayFramePlayer>();
  const byPlayerID = new Map<string, AiLeagueReplayFramePlayer>();
  for (const player of framePlayers) {
    bySmallID.set(player.smallID, player);
    byPlayerID.set(player.playerID, player);
  }
  const totalTiles = framePlayers.reduce(
    (sum, player) => sum + Math.max(0, player.tilesOwned),
    0,
  );
  const rankBySmallID = new Map<number, number>();
  [...framePlayers]
    .sort((a, b) => b.tilesOwned - a.tilesOwned)
    .forEach((player, index) => rankBySmallID.set(player.smallID, index + 1));

  const telemetryByPlayerID = new Map<string, AiLeagueSpectatorAgent>();
  const telemetryByName = new Map<string, AiLeagueSpectatorAgent>();
  for (const agent of telemetry?.agents ?? []) {
    if (agent.playerID !== null) {
      telemetryByPlayerID.set(agent.playerID, agent);
    }
    telemetryByName.set(normalizeName(agent.username), agent);
  }
  const degradedByName = degradedDecisionCountByPlayer(decisions);

  const entries = roster.map(({ username, playerID }) => {
    const framePlayer =
      (playerID !== null ? byPlayerID.get(playerID) : undefined) ?? undefined;
    const telemetryAgent =
      (playerID !== null ? telemetryByPlayerID.get(playerID) : undefined) ??
      telemetryByName.get(normalizeName(username)) ??
      null;
    const identity = identityByPlayerName.get(username) ?? null;
    // P0 fix (2026-08-03, deploy 2B): a resolved public identity's own
    // displayName used to bypass aiLeagueSpectatorDisplayName entirely --
    // the ONE Competitors-rail path that kept leaking a real agent name
    // with "Anonymous Names" on, since every other name in this rail
    // (and everywhere else in this file) already funnels through it.
    const displayName = aiLeagueSpectatorDisplayName(
      identity?.displayName ?? ((framePlayer?.displayName ?? "") || username),
    );
    const territoryPercent =
      framePlayer !== undefined && totalTiles > 0
        ? (framePlayer.tilesOwned / totalTiles) * 100
        : null;
    const inMatchRank =
      framePlayer !== undefined
        ? (rankBySmallID.get(framePlayer.smallID) ?? null)
        : null;
    const alive =
      framePlayer !== undefined ? true : (telemetryAgent?.isAlive ?? null);
    const relations =
      framePlayer !== undefined
        ? aiLeagueRailRelations(framePlayer, bySmallID, identityByPlayerName)
        : { allies: [], wars: [] };
    return {
      playerName: username,
      // Camera-follow discoverability (spec item 6/item 4 P0 fix):
      // PointOfViewSelector's actual PlayerView identity has NO
      // relationship to the AI League roster's `username` -- GameView's
      // own name()/displayName() are procedurally-generated in-game
      // nation names ("Somali Host", "Almohad Regime", ...), a totally
      // disjoint namespace (confirmed live: neither the toolbar dropdown
      // (already keyed by GameView's own player.id(), self-consistent)
      // nor the per-agent rail button (dispatched the roster username,
      // which PointOfViewSelector's name-based lookup can never resolve
      // to a real PlayerView) could establish a shared identity before
      // this fix). `clientID` is the one identifier BOTH sides already
      // expose in the SAME value space (AiLeagueReplayFramePlayer.clientID
      // / PlayerView.clientID()) -- this is what BROADCAST_RAIL_FOLLOW_EVENT
      // and BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT now correlate on instead.
      clientID: framePlayer?.clientID ?? null,
      displayName,
      agentSlug: identity?.slug ?? null,
      emblemSvg: identity?.emblemSvg ?? null,
      primaryColor:
        framePlayer !== undefined
          ? aiLeagueDisplayColor(framePlayer)
          : (identity?.primaryColor ?? null),
      versionLabel: identity?.activeVersion?.publicVersionLabel ?? null,
      builderDisplayName: identity?.builderDisplayName ?? null,
      territoryPercent,
      inMatchRank,
      alive,
      allies: relations.allies,
      wars: relations.wars,
      degradedDecisionCount: degradedByName.get(normalizeName(username)) ?? null,
      followed: false,
    } satisfies CompetitorRailEntry;
  });

  const ranked = [...entries].sort((a, b) => {
    if (a.inMatchRank !== null && b.inMatchRank !== null) {
      return a.inMatchRank - b.inMatchRank;
    }
    if (a.inMatchRank !== null) return -1;
    if (b.inMatchRank !== null) return 1;
    return 0;
  });
  return ranked.slice(0, AI_LEAGUE_RAIL_MAX_ROWS);
}

// Re-mounted independently of the frame stream (identity resolution lands
// asynchronously; hydrate() re-renders the whole details block) — keyed by
// the drawer's own container so a re-mount replays the LAST known frame
// instead of resetting to an empty roster and waiting for the next tick.
const AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME = new WeakMap<
  HTMLElement,
  readonly AiLeagueReplayFramePlayer[]
>();

// Same re-mount problem as AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME above, for
// the playhead turn a re-render (tab change, identity resolution, follow
// change) needs to re-window the War Room feed / redact timeline markers
// against — without this, any re-render NOT triggered by a fresh
// `ai-league-replay-frame` event would fall back to turn 0 and spoil every
// event back into view until the next tick.
const AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN = new WeakMap<HTMLElement, number>();

// Mobile drawer tab selection (spec item 7), keyed the same way — the
// placeholder container itself is never replaced across a hydrate (only its
// CHILDREN are, via container.replaceChildren() below), so this persists a
// viewer's tab choice across every renderDetails()/hydrate() call without
// needing a second piece of closure state threaded through
// mountReplayDetailsBindings.
const AI_LEAGUE_DRAWER_ACTIVE_TAB = new WeakMap<
  HTMLElement,
  BroadcastDrawerTabId
>();

/**
 * Analyst mode (spec item 5): the SAME already-public decisions/events this
 * overlay's curated rail/War Room/timeline already read. Full Replay is
 * complete data (no premiere seal, no released-chunks boundary) —
 * decisionsUnavailableReason is only ever "no_data" (a genuinely
 * decision-less match/context), never "premiere_sealed".
 *
 * SUPERSEDED (P2 ticker-fix follow-up review, 2026-08-02): this file's own
 * prior design record here read "...unfiltered" — Analyst mode was
 * deliberately scoped as an explicit toggle exposing every already-public
 * row raw and complete, un-curated by importance/kind AND un-windowed by
 * the viewer's own playhead, on the reasoning that Full Replay covers an
 * already-finished match with no live spoiler risk. That data-exposure
 * scope is UNCHANGED (every field here is still exactly as public as it
 * always was — see BroadcastComposition.ts's own "uncurated" doc for the
 * still-current importance/kind boundary) — only WHEN within a viewing
 * session changed: the caller below (see allAnalystDecisions/
 * allAnalystEvents in mountAiLeagueBroadcastDrawer) now filters both lists
 * to `turnNumber <= playhead`, matching the SAME convention every other
 * region in this file already follows post-fix (War Room feed, timeline
 * markers, match-state strip) — a re-watching viewer parked at turn 0
 * used to see the match's ENTIRE analyst-mode history immediately, which
 * is exactly the "future rows leak on a re-watch" shape the War Room DOM-
 * window fix (AI_LEAGUE_TICKER_DOM_WINDOW above) was written to close
 * everywhere else. Returns the FULL, sorted-ascending-by-turn sets — the
 * caller applies both the playhead filter and the DOM window, exactly
 * like `curatedWarRoomEvents`'s own contract.
 */
function aiLeagueAnalystPanelData(
  input: AiLeagueReplayOverlayInput,
  telemetry: AiLeagueSpectatorTelemetry | null,
): AnalystPanelData {
  const hasDecisions = input.decisions.length > 0;
  // P0 fix (2026-08-03): both sub-lists below used to pass real agent
  // identity straight through -- every other consumer of this same raw
  // `AiLeagueDecisionLogEntry`/`AiLeagueSpectatorEvent` data
  // (curatedWarRoomEvents, matchTimelineEventMarkers,
  // communicationThreadHtml) already resolves names through
  // `aiLeagueSpectatorDisplayName`/`aiLeagueSpectatorText`, so the
  // Analyst decisions table's Agent column and the Analyst event log
  // leaked real names even with Anonymous Names on.
  const decisions: AnalystDecisionRow[] = input.decisions
    .map((decision) => ({
      sequence: decision.sequence,
      turnNumber: decision.turnNumber,
      playerName: aiLeagueSpectatorDisplayName(decision.username),
      brainType: decision.brainType,
      selectedActionKind: decision.selectedActionKind,
      selectedLegalActionId: decision.selectedLegalActionId,
      reason: decision.reason,
      planObjective: decision.planObjective ?? null,
      decisionLatencyMs: decision.decisionLatencyMs,
      fallbackUsed: decision.fallbackUsed,
      accepted: decision.result.accepted,
      auditStatus: decision.auditStatus ?? null,
    }))
    .sort((a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence);
  const events: AnalystEventRow[] = (telemetry?.events ?? [])
    .map((event) => ({
      sequence: event.sequence,
      turnNumber: event.turnNumber,
      kind: event.kind,
      tone: event.tone,
      actorName: aiLeagueSpectatorDisplayName(event.actorName),
      targetName:
        event.targetName !== null
          ? aiLeagueSpectatorDisplayName(event.targetName)
          : null,
      secondaryName: null,
      message: aiLeagueSpectatorText(event.publicText ?? event.message),
    }))
    .sort((a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence);
  return {
    decisions: hasDecisions ? decisions : null,
    decisionsUnavailableReason: hasDecisions ? null : "no_data",
    events,
    // NEVER the full-match distribution (P2 follow-up review, playhead
    // boundary #2): analystActionKindCounts below re-derives this from
    // the eligible slice on every render, exactly like the decisions/
    // events sub-lists — an aggregate is still a spoiler surface even
    // though no individual future ROW is ever rendered, so this field is
    // a structurally-required placeholder only; every real caller
    // (buildAnalystPanelWindow) always overrides it.
    actionKindCounts: [],
  };
}

/**
 * Action-kind distribution for the Analyst chart, derived from an ALREADY
 * playhead-filtered slice (the caller passes
 * `allAnalystDecisions.slice(0, eligibleAnalystDecisionsCount)` — see
 * mountAiLeagueBroadcastDrawer's own doc). Always a full recompute over
 * that slice, never an incremental accumulator: the slice can shrink on a
 * backward seek exactly like the decisions/events sub-lists do, and a
 * stateful running total would either need its own separate
 * forward/backward-aware bookkeeping (duplicating the exact
 * eligible-count logic this function's caller already computes) or drift
 * wrong on rewind — the same class of bug the ticker's own append-bound
 * fix exists to prevent. A plain array scan over at most a few thousand
 * rows costs a fraction of a millisecond, is trivially correct in both
 * directions, and only ever runs while the Analyst tab is actually
 * visible (lazy-mounted) — the DOM patch that consumes this result is
 * what stays key-gated, never this computation.
 */
function analystActionKindCounts(
  decisions: readonly AnalystDecisionRow[],
): AnalystActionKindCount[] {
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    counts.set(
      decision.selectedActionKind,
      (counts.get(decision.selectedActionKind) ?? 0) + 1,
    );
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/**
 * ONE renderBroadcastDrawer() mount for all four tabs (spec item 7),
 * replacing the file's former three independent mount points
 * (mountAiLeagueCompetitorRail/mountAiLeagueWarRoom/mountAiLeagueTimeline).
 * Every tab's DERIVATION stays exactly what it always was —
 * competitorRailEntries()/curatedWarRoomEvents()/matchTimelineEventMarkers()
 * are reused verbatim, only WHERE their output mounts changed.
 * `followedClientID` (spec item 6) is threaded in from the outer mount
 * closure so the rail's `followed` seat always reflects
 * PointOfViewSelector's current pick.
 *
 * Desktop "escape to a floating panel" quirk: #ai-league-replay-overlay
 * itself uses backdrop-filter for its frosted-glass chrome, and per the CSS
 * spec, filter/backdrop-filter on an element makes THAT element the
 * containing block for any position:fixed descendant — so an events/
 * timeline/analysis panel nested inside the overlay could never actually
 * float free of it, no matter what fixed coordinates its own CSS declared.
 * AI_LEAGUE_BROADCAST_DRAWER_PORTAL_ID is a plain (no filter) document.body
 * child that the "events"/"timeline"/"analysis" panels physically relocate
 * into on a desktop-width viewport, escaping that trap; on a narrow/short
 * viewport (this file's own mobile/landscape media queries put every panel
 * back into `position: static`, immune to the same quirk) they relocate
 * back into the drawer's own panel host, alongside "agents", for one
 * cohesive tabbed sheet. "agents" itself never relocates — it always reads
 * naturally inside this panel's own body, alongside the diplomacy strip,
 * exactly like the rail did before this restructuring.
 */
const AI_LEAGUE_BROADCAST_DRAWER_PORTAL_ID = "ai-league-broadcast-drawer-portal";

function relocateAiLeagueBroadcastDrawerPanels(
  portal: HTMLElement,
  panelsHost: HTMLElement,
): void {
  const desktop = !isNarrowReplayViewport();
  for (const tabId of ["events", "timeline", "analysis"] as const) {
    const panel = document.querySelector<HTMLElement>(
      `.broadcast-drawer-panel[data-tab-id="${tabId}"]`,
    );
    if (panel === null) continue;
    const home = desktop ? portal : panelsHost;
    if (panel.parentElement !== home) {
      home.appendChild(panel);
    }
  }
}

// DOM-count window shared by every bounded ticker list in this file: the
// War Room event feed (the public-facing "decision ticker"), and (per the
// P2 ticker-fix follow-up review) the Analyst tab's own decisions table
// and event log. Spoiler windowing (`turn <= turnNumber`, already applied
// before this constant is ever consulted) bounds WHICH items are eligible
// to render; this separately bounds HOW MANY of those eligible items are
// ever mounted as DOM nodes at once. A live Premiere never needs this for
// the War Room feed — ReplayPremiereRuntime.ts's own MAX_WAR_ROOM_EVENTS
// already caps that feed at the MODEL level (64 entries: "a generous cap
// . . . a hard ceiling") — and its own Analyst events read from that SAME
// already-bounded source (see ReplayPremiereOverlay.ts's own model doc);
// only Full Replay keeps COMPLETE, unbounded history for all three lists
// on purpose (spoiler-safety here is a pure turn-window, never a data
// truncation — a viewer must always be able to see everything up to their
// own playhead), so an unbounded match can mount thousands of DOM rows in
// any of them: the measured production bloat this constant fixes (War
// Room: ~1,957 rows + ~527 per-row action buttons on a real replay,
// growing without bound during playback, P2-Fxx spectator-overlay-subtree
// report; Analyst decisions/events: the same shape, off `decisions`/
// `telemetry.events` directly, confirmed separately during the P2
// follow-up review). 60 mirrors that same "generous ceiling" reasoning —
// comfortably more than the ~340px own-scroll viewport
// (BroadcastComposition.ts's `.broadcast-war-room-list`, styled here and
// reused by ReplayPremiereOverlay.ts) ever shows without scrolling, while
// cutting a multi-thousand-row list down to a number that costs nothing to
// lay out. "Show earlier" (below) grows each window by the same amount
// per click — the same reveal-in-chunks shape as the decisions panel's
// own AI_LEAGUE_DECISION_LOG_CAP expander.
const AI_LEAGUE_TICKER_DOM_WINDOW = 60;

interface WarRoomWindowCallbacks extends WarRoomFeedCallbacks {
  /** Grows the DOM window by AI_LEAGUE_TICKER_DOM_WINDOW and re-renders — the manual backfill affordance. Only ever rendered as a row when there is something older to reveal (see buildWarRoomEarlierRow/patchWarRoomWindowForward). */
  onShowEarlier: () => void;
}

/**
 * Count of `sortedByTurn` items (ascending by `turnOf`) eligible at
 * `turnNumber`. Equivalent to `sortedByTurn.filter(x => turnOf(x) <=
 * turnNumber).length` but O(log n) instead of O(n) — shared by every
 * bounded list in this file (War Room, Analyst decisions, Analyst
 * events), each of which re-runs this on every `ai-league-replay-frame`
 * tick against its own full, unbounded set.
 */
function domEligibleCount<T>(
  sortedByTurn: readonly T[],
  turnOf: (item: T) => number,
  turnNumber: number,
): number {
  let lo = 0;
  let hi = sortedByTurn.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (turnOf(sortedByTurn[mid]!) <= turnNumber) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** First eligible index still inside a DOM window of `windowSize`, given `eligibleCount` total eligible items. Shared by every bounded list in this file. */
function domWindowStart(eligibleCount: number, windowSize: number): number {
  return Math.max(0, eligibleCount - windowSize);
}

/**
 * Inserts, updates, or removes the shared "N earlier" backfill row/button
 * for a bounded list — used by every `patchDomWindowForward` caller so the
 * affordance itself never needs a list rebuild just to update its own
 * hidden count as the window slides forward.
 */
function syncDomWindowEarlierRow(
  list: HTMLElement,
  earlierSelector: string,
  hiddenCount: number,
  buildEarlierRow: (hiddenCount: number) => HTMLElement,
  earlierLabel: (hiddenCount: number) => string,
): void {
  const earlierRow = list.querySelector<HTMLElement>(earlierSelector);
  if (hiddenCount > 0) {
    if (earlierRow === null) {
      list.prepend(buildEarlierRow(hiddenCount));
    } else {
      const button = earlierRow.querySelector("button");
      if (button !== null) {
        button.textContent = earlierLabel(hiddenCount);
      }
    }
  } else {
    earlierRow?.remove();
  }
}

/**
 * Generic DOM-window incremental-append/prune primitive shared by every
 * bounded ticker list in this file (War Room, Analyst decisions, Analyst
 * events): for a pure forward tick (more eligible items, same window
 * size), appends the newly eligible rows and prunes whichever rows the
 * sliding window drops off the front, WITHOUT tearing down or rebuilding
 * rows that stay in the window (spec item 3: appends must be incremental,
 * never a full-subtree teardown per chunk). Retained rows keep their
 * exact DOM node identity, so any per-row open/closed state survives the
 * tick — the same correctness property `ReplayPremiereOverlay.ts`'s own
 * `applyVolatileModelUpdates` war-room patch already relies on. Also
 * preserves the viewer's own scroll intent: auto-follows the newest entry
 * only while the viewer is already scrolled to the tail, and never yanks
 * the view while they've scrolled up to read older entries (pruned height
 * above the viewport is subtracted from `scrollTop` instead, so whatever
 * content is already on screen doesn't jump).
 *
 * The append source is NEVER `[prevEligibleCount, nextEligibleCount)` —
 * for a jump bigger than the window (a long idle tick, a forward
 * seek/jump-to-turn that crosses hundreds of eligible items at once) that
 * range is far wider than `windowSize` and would silently defeat the
 * whole DOM cap (a real, shipped regression this exact bound fixed — see
 * the seek-shape regression tests). Only the slice that actually lands
 * inside the new window — `[max(prevEligibleCount, nextStart),
 * nextEligibleCount)` — may ever be appended; anything older than
 * `nextStart` was already excluded by the removal loop below (or never
 * mounted to begin with).
 */
function patchDomWindowForward<T>(
  list: HTMLElement,
  rowSelector: string,
  allItems: readonly T[],
  prevEligibleCount: number,
  nextEligibleCount: number,
  windowSize: number,
  buildRow: (item: T) => HTMLElement,
  syncEarlier: (hiddenCount: number) => void,
): void {
  const prevStart = domWindowStart(prevEligibleCount, windowSize);
  const nextStart = domWindowStart(nextEligibleCount, windowSize);
  const removedCount = nextStart - prevStart;

  const TAIL_EPSILON_PX = 4;
  const wasAtTail =
    list.scrollHeight - list.scrollTop - list.clientHeight <= TAIL_EPSILON_PX;

  const rows = list.querySelectorAll<HTMLElement>(rowSelector);
  let removedHeight = 0;
  for (let i = 0; i < removedCount && i < rows.length; i++) {
    removedHeight += rows[i]!.getBoundingClientRect().height;
    rows[i]!.remove();
  }
  const appendStart = Math.max(prevEligibleCount, nextStart);
  for (const item of allItems.slice(appendStart, nextEligibleCount)) {
    list.append(buildRow(item));
  }

  syncEarlier(nextStart);

  if (wasAtTail) {
    list.scrollTop = list.scrollHeight;
  } else if (removedHeight > 0) {
    list.scrollTop = Math.max(0, list.scrollTop - removedHeight);
  }
}

function buildWarRoomEarlierRow(
  hiddenCount: number,
  onShowEarlier: () => void,
): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "broadcast-war-room-earlier";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-league-badge";
  button.textContent = translateText("broadcast.war_room_show_earlier", {
    count: hiddenCount,
  });
  button.addEventListener("click", onShowEarlier);
  row.append(button);
  return row;
}

/**
 * Copies the drawer-panel wrapper identity (renderBroadcastDrawer()'s own
 * .broadcast-drawer-panel class, data-tab-id, data-tab-active, id,
 * role="tabpanel", aria-labelledby) from an outgoing top-level drawer panel
 * onto its replacement — for every patchVolatile rebuild path that swaps a
 * WHOLE panel (War Room/Timeline/Analysis) via element.replaceWith(fresh).
 * buildWarRoomSection()/renderMatchTimeline()/buildAnalystPanelWindow()/
 * buildAnalystPanelPlaceholder() only ever build the bare panel content;
 * renderBroadcastDrawer() applies this wrapper identity ONLY on the
 * first-mount structural path (renderStructural), never re-applies it on a
 * later patchVolatile rebuild. Losing it silently strips data-tab-id,
 * which this file's own CSS keys the desktop position:fixed / centered
 * placement of these body-portal-relocated panels off of — the panel then
 * falls back to normal document flow inside its zero-size portal and
 * becomes permanently invisible/unusable (found live in production, P1
 * interaction sweep: Timeline on virtually every tick, since its own key
 * changes almost every frame; War Room on the very first tick any event
 * becomes eligible for a replay that starts with none, since
 * mountedWarRoomCount > 0 is false until then and the rebuild — not the
 * in-place patch — path fires; Analyst the same way the first time it's
 * toggled visible or hidden after any such rebuild already happened).
 * `activeTab`/collapse flags never change on this path (only user clicks
 * change them, always via renderStructural instead) — copying the
 * outgoing element's dataset verbatim is exactly correct here, never
 * stale.
 */
function preserveDrawerPanelWrapperIdentity(
  outgoing: HTMLElement,
  incoming: HTMLElement,
): void {
  incoming.className = outgoing.className;
  incoming.id = outgoing.id;
  for (const [key, value] of Object.entries(outgoing.dataset)) {
    incoming.dataset[key] = value;
  }
  const role = outgoing.getAttribute("role");
  if (role !== null) incoming.setAttribute("role", role);
  const labelledBy = outgoing.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    incoming.setAttribute("aria-labelledby", labelledBy);
  }
}

/**
 * Builds the whole War Room region for the current window — used whenever
 * the window can't be reached by a pure incremental append: first mount, a
 * backward seek/jump that drops trailing events out of the window, or
 * `onShowEarlier` growing the window. `patchWarRoomWindowForward` below is
 * the hot per-tick path that avoids this.
 */
function buildWarRoomSection(
  allEvents: readonly CuratedWarRoomEvent[],
  eligibleCount: number,
  windowSize: number,
  callbacks: WarRoomWindowCallbacks,
): HTMLElement {
  const start = domWindowStart(eligibleCount, windowSize);
  const section = renderWarRoomFeed(
    allEvents.slice(start, eligibleCount),
    callbacks,
  );
  if (start > 0) {
    const list = section.querySelector<HTMLElement>(
      ".broadcast-war-room-list",
    );
    list?.prepend(buildWarRoomEarlierRow(start, callbacks.onShowEarlier));
  }
  return section;
}

/**
 * Incrementally patches an already-mounted War Room region for a pure
 * forward tick — a thin `patchDomWindowForward` adapter wiring the War
 * Room's own list selector, row builder, and "show earlier" affordance
 * into the shared primitive (see that function's own doc for the full
 * correctness rationale — including the auto-follow-at-tail /
 * height-compensated-when-scrolled-up scroll preservation spec item 2
 * needs; already implemented there, not duplicated here).
 */
function patchWarRoomWindowForward(
  section: HTMLElement,
  allEvents: readonly CuratedWarRoomEvent[],
  prevEligibleCount: number,
  nextEligibleCount: number,
  windowSize: number,
  callbacks: WarRoomWindowCallbacks,
): void {
  const list = section.querySelector<HTMLElement>(".broadcast-war-room-list");
  if (list === null) return;
  patchDomWindowForward(
    list,
    ".broadcast-war-room-item",
    allEvents,
    prevEligibleCount,
    nextEligibleCount,
    windowSize,
    (event) => renderWarRoomEvent(event, callbacks),
    (hiddenCount) =>
      syncDomWindowEarlierRow(
        list,
        ".broadcast-war-room-earlier",
        hiddenCount,
        () => buildWarRoomEarlierRow(hiddenCount, callbacks.onShowEarlier),
        (count) =>
          translateText("broadcast.war_room_show_earlier", { count }),
      ),
  );
}

// ---------------------------------------------------------------------------
// Analyst tab (spec item 5 follow-up, P2 review): lazy-mounted (its heavy
// decisions table / event log are only ever constructed while the tab is
// actually visible — desktop analyst-mode toggle on, or the mobile
// "Analysis" drawer tab active) and windowed exactly like the War Room
// ticker above (same AI_LEAGUE_TICKER_DOM_WINDOW, same "show earlier",
// same incremental patch discipline via patchDomWindowForward). See
// `aiLeagueAnalystPanelData`'s own doc for the playhead-filtering
// supersession this follow-up also applied.
// ---------------------------------------------------------------------------

/** Matches renderAnalystDecisionRow's own column count (turn/player/brain/action/latency/audit/reason — see renderAnalystDecisions's header loop in BroadcastComposition.ts). */
const AI_LEAGUE_ANALYST_DECISIONS_COLUMN_COUNT = 7;

function buildAnalystDecisionsEarlierRow(
  hiddenCount: number,
  onShowEarlier: () => void,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "broadcast-analyst-decisions-earlier";
  const td = document.createElement("td");
  td.colSpan = AI_LEAGUE_ANALYST_DECISIONS_COLUMN_COUNT;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-league-badge";
  button.textContent = translateText("broadcast.analyst_show_earlier", {
    count: hiddenCount,
  });
  button.addEventListener("click", onShowEarlier);
  td.append(button);
  tr.append(td);
  return tr;
}

function buildAnalystEventsEarlierRow(
  hiddenCount: number,
  onShowEarlier: () => void,
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "broadcast-analyst-events-earlier";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-league-badge";
  button.textContent = translateText("broadcast.analyst_show_earlier", {
    count: hiddenCount,
  });
  button.addEventListener("click", onShowEarlier);
  li.append(button);
  return li;
}

/**
 * Empty lazy-mount placeholder for the Analyst tab — same root shape/class
 * `renderAnalystPanel` returns (so every existing
 * `.broadcast-drawer-panel[data-tab-id="analysis"].broadcast-analyst`
 * selector still resolves), but with no children at all: the chart/
 * decisions table/event log are only ever constructed once the tab is
 * actually visible.
 */
function buildAnalystPanelPlaceholder(): HTMLElement {
  const section = document.createElement("section");
  section.className = "broadcast-analyst";
  section.setAttribute(
    "aria-label",
    translateText("broadcast.analyst_heading"),
  );
  return section;
}

/**
 * Cold-builds JUST the Analyst decisions table region (`.broadcast-analyst-
 * decisions`) for the current window — used for the whole-panel first-
 * visible build below, AND independently whenever ONLY the decisions
 * sub-list needs a cold rebuild (a decisions-only window-size change via
 * onShowEarlier, or a backward seek) while the events sub-list next to it
 * is left completely untouched.
 */
function buildAnalystDecisionsSection(
  allDecisions: readonly AnalystDecisionRow[],
  decisionsUnavailableReason: AnalystModeUnavailableReason | null,
  eligibleCount: number,
  windowSize: number,
  onShowEarlier: () => void,
): HTMLElement {
  const start = domWindowStart(eligibleCount, windowSize);
  const wrap = renderAnalystDecisions({
    decisions:
      decisionsUnavailableReason !== null
        ? null
        : allDecisions.slice(start, eligibleCount),
    decisionsUnavailableReason,
  });
  if (start > 0) {
    const body = wrap.querySelector<HTMLElement>(
      ".broadcast-analyst-decisions-table tbody",
    );
    body?.prepend(buildAnalystDecisionsEarlierRow(start, onShowEarlier));
  }
  return wrap;
}

/** Cold-builds JUST the Analyst event log region (`.broadcast-analyst-events`) — see `buildAnalystDecisionsSection`'s own doc for the full rationale. */
function buildAnalystEventsSection(
  allEvents: readonly AnalystEventRow[],
  eligibleCount: number,
  windowSize: number,
  onShowEarlier: () => void,
): HTMLElement {
  const start = domWindowStart(eligibleCount, windowSize);
  const wrap = renderAnalystEventLog(allEvents.slice(start, eligibleCount));
  if (start > 0) {
    const list = wrap.querySelector<HTMLElement>(
      ".broadcast-analyst-events-list",
    );
    list?.prepend(buildAnalystEventsEarlierRow(start, onShowEarlier));
  }
  return wrap;
}

/**
 * Builds the full Analyst tab content for the CURRENT window sizes — used
 * whenever visibility just turned on, or first mount while already
 * visible. Composes the SAME `renderAnalystActionChart`-bearing
 * `renderAnalystPanel` shell every caller already expects, then swaps in
 * the windowed decisions/events sub-sections built above (chart aside,
 * this is the only place that ever rebuilds BOTH sub-lists together —
 * `patchVolatile` below patches/rebuilds each one independently once the
 * panel is already mounted). The chart itself is derived HERE, internally,
 * from the SAME eligible decisions slice the decisions table windows off
 * of — never a caller-supplied aggregate — so there is exactly one place
 * that can get the playhead boundary wrong for the chart, not one per
 * caller (see `analystActionKindCounts`'s own doc for why this is always
 * a full recompute, never an incremental accumulator).
 */
function buildAnalystPanelWindow(
  decisionsUnavailableReason: AnalystModeUnavailableReason | null,
  allDecisions: readonly AnalystDecisionRow[],
  allEvents: readonly AnalystEventRow[],
  eligibleDecisionsCount: number,
  eligibleEventsCount: number,
  decisionsWindowSize: number,
  eventsWindowSize: number,
  onShowEarlierDecisions: () => void,
  onShowEarlierEvents: () => void,
): HTMLElement {
  const section = renderAnalystPanel({
    decisions: [],
    decisionsUnavailableReason,
    events: [],
    actionKindCounts: analystActionKindCounts(
      allDecisions.slice(0, eligibleDecisionsCount),
    ),
  });
  section
    .querySelector(".broadcast-analyst-decisions")
    ?.replaceWith(
      buildAnalystDecisionsSection(
        allDecisions,
        decisionsUnavailableReason,
        eligibleDecisionsCount,
        decisionsWindowSize,
        onShowEarlierDecisions,
      ),
    );
  section
    .querySelector(".broadcast-analyst-events")
    ?.replaceWith(
      buildAnalystEventsSection(
        allEvents,
        eligibleEventsCount,
        eventsWindowSize,
        onShowEarlierEvents,
      ),
    );
  return section;
}

/** Thin `patchDomWindowForward` adapter for the Analyst decisions table (see that function's own doc). `null` when the section has no table yet (unavailable/empty state) — the caller falls back to a cold `buildAnalystPanelWindow` rebuild for that transition, exactly like the War Room ticker's own empty-state handling. */
function patchAnalystDecisionsWindowForward(
  section: HTMLElement,
  allDecisions: readonly AnalystDecisionRow[],
  prevEligibleCount: number,
  nextEligibleCount: number,
  windowSize: number,
  onShowEarlier: () => void,
): void {
  const body = section.querySelector<HTMLElement>(
    ".broadcast-analyst-decisions-table tbody",
  );
  if (body === null) return;
  patchDomWindowForward(
    body,
    ".broadcast-analyst-decisions-row",
    allDecisions,
    prevEligibleCount,
    nextEligibleCount,
    windowSize,
    renderAnalystDecisionRow,
    (hiddenCount) =>
      syncDomWindowEarlierRow(
        body,
        ".broadcast-analyst-decisions-earlier",
        hiddenCount,
        () => buildAnalystDecisionsEarlierRow(hiddenCount, onShowEarlier),
        (count) =>
          translateText("broadcast.analyst_show_earlier", { count }),
      ),
  );
}

/** Thin `patchDomWindowForward` adapter for the Analyst event log (see that function's own doc). */
function patchAnalystEventsWindowForward(
  section: HTMLElement,
  allEvents: readonly AnalystEventRow[],
  prevEligibleCount: number,
  nextEligibleCount: number,
  windowSize: number,
  onShowEarlier: () => void,
): void {
  const list = section.querySelector<HTMLElement>(
    ".broadcast-analyst-events-list",
  );
  if (list === null) return;
  patchDomWindowForward(
    list,
    ".broadcast-analyst-events-row",
    allEvents,
    prevEligibleCount,
    nextEligibleCount,
    windowSize,
    renderAnalystEventRow,
    (hiddenCount) =>
      syncDomWindowEarlierRow(
        list,
        ".broadcast-analyst-events-earlier",
        hiddenCount,
        () => buildAnalystEventsEarlierRow(hiddenCount, onShowEarlier),
        (count) =>
          translateText("broadcast.analyst_show_earlier", { count }),
      ),
  );
}

function mountAiLeagueBroadcastDrawer(
  overlay: HTMLElement,
  input: AiLeagueReplayOverlayInput,
  identityByPlayerName: ReadonlyMap<string, PublicAgent>,
  followedClientID: string | null,
  directorCutHandle: DirectorCutControllerHandle | null,
): void {
  const container = overlay.querySelector<HTMLElement>(
    "[data-ai-league-broadcast-drawer]",
  );
  if (container === null) {
    return;
  }
  let portal = document.getElementById(AI_LEAGUE_BROADCAST_DRAWER_PORTAL_ID);
  if (portal === null) {
    portal = document.createElement("div");
    portal.id = AI_LEAGUE_BROADCAST_DRAWER_PORTAL_ID;
    document.body.appendChild(portal);
  }
  const drawerPortal = portal;
  const win = window as Window & {
    __aiLeagueBroadcastDrawerCleanup?: () => void;
  };
  win.__aiLeagueBroadcastDrawerCleanup?.();
  const telemetry =
    input.spectatorTelemetry as AiLeagueSpectatorTelemetry | null;
  const decisions = input.decisions;
  const totalTurns = aiLeagueFinishTurn(input, telemetry);
  // Full, unwindowed curated set — NEVER rendered directly (spec item 2: a
  // viewer at turn N must never see an event from turn > N). Both render
  // paths below window this down to the viewer's own playhead AND (spec
  // item 1, AI_LEAGUE_TICKER_DOM_WINDOW above) to a bounded DOM count.
  const allWarRoomEvents = curatedWarRoomEvents(telemetry, decisions);
  const timelineMarkers: TimelineMarker[] = [
    ...matchTimelineEventMarkers(telemetry),
    {
      kind: "finish",
      turn: totalTurns,
      sequence: Number.MAX_SAFE_INTEGER,
      label: translateText("ai_league_replay.timeline_finish"),
    },
  ];
  const analystData = aiLeagueAnalystPanelData(input, telemetry);
  // Full, unwindowed sets (sorted ascending by turn — see
  // aiLeagueAnalystPanelData's own doc) — NEVER rendered directly. Exactly
  // like allWarRoomEvents above: both the playhead boundary (spec item 2)
  // and the DOM window (spec item 1, AI_LEAGUE_TICKER_DOM_WINDOW) apply
  // before either ever reaches the DOM.
  const allAnalystDecisions = analystData.decisions ?? [];
  const allAnalystEvents = analystData.events;
  // Parsed once per mount (like everything else above), not per frame — the
  // artifact itself never changes within one mount's lifetime, only which
  // sample is windowed into view does.
  const matchStateSeries = normalizeMatchStateSeries(input.matchStateSeries);
  const directorCutPlan = normalizeDirectorCutPlan(input.directorCutPlan);
  /**
   * Turn 2 of the pass-10 CHECK item: audited every consumer of this
   * shared dispatch (War Room feed's "jump to turn" action via
   * `onJumpToTurn`, and the Match Timeline's `onSeek`, both wired below)
   * — a decision/event row in the Analyst tab (`renderAnalystDecisionRow`/
   * `renderAnalystEventRow`, `BroadcastComposition.ts`) carries NO
   * turn-jump affordance at all (plain table/list cells, no button), so
   * there is nothing there to fix. The ONE other jump-to-turn consumer in
   * this file, the political-radio/comms "turn N" link
   * (`data-ai-league-jump-turn`, `communicationMessageHtml`), is handled
   * by the SEPARATE `mountReplayJumpControls` below — which ALREADY
   * implements this exact backward-seek-via-navigation (missed as prior
   * art in the first pass of this fix). Moved the fix HERE, into the one
   * function every OTHER jump-to-turn consumer shares, rather than
   * keeping the previous per-consumer `dispatchTimelineSeek` wrapper: all
   * of War Room/Timeline/(any future consumer of this function) want the
   * identical contract — "take the viewer to turn N" — so a per-consumer
   * split only risked the exact inconsistency this turn's review caught
   * (Timeline fixed, War Room silently left broken). Matches
   * `mountReplayJumpControls`'s own tolerance/params exactly (a same-
   * session forward-only clamp within 10 turns is an imperceptible no-op,
   * not worth a full reload; `replay=`/`turn=` are the same two params
   * that function already sets) so both code paths read as one
   * intentional policy, not two independently-invented ones.
   */
  const dispatchJumpToTurn = (turn: number): void => {
    analytics.track("timeline_jump", { matchId: input.runID });
    const knownTurn = AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.get(container) ?? 0;
    if (turn + 10 < knownTurn) {
      const url = new URL(window.location.href);
      url.searchParams.set("replay", "");
      url.searchParams.set("turn", String(Math.max(0, Math.floor(turn))));
      window.location.href = url.toString();
      return;
    }
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-jump-turn", {
        detail: { turnNumber: turn },
        bubbles: true,
      }),
    );
  };

  // Collapse/expand (spec item 1): read once per mount, same "caller-owned,
  // localStorage-persisted" pattern as mountReplayPanelControls's own layout
  // persistence below — toggling flips the in-closure flag, persists it,
  // then re-renders with the LAST known frame/turn (never resets either).
  let railCollapsed = false;
  let warRoomCollapsed = false;
  try {
    railCollapsed =
      localStorage.getItem(AI_LEAGUE_RAIL_COLLAPSED_KEY) === "true";
    warRoomCollapsed =
      localStorage.getItem(AI_LEAGUE_WAR_ROOM_COLLAPSED_KEY) === "true";
  } catch {
    // Collapse-state persistence is optional.
  }

  // War Room DOM window (spec item 1) — grows via onShowEarlier below.
  let warRoomWindowSize = AI_LEAGUE_TICKER_DOM_WINDOW;
  // Eligible-count/window-size the DOM currently reflects, as of the last
  // structural OR incremental render. -1 (and 0, the structural "no events
  // yet" placeholder) both force the next tick through a structural rebuild
  // rather than the incremental fast path — see patchVolatile below.
  let mountedWarRoomCount = -1;
  let mountedWarRoomWindowSize = warRoomWindowSize;
  // Analyst DOM windows (spec item 1 follow-up, P2 review) — independent
  // per sub-list, same shape as the War Room window above.
  let analystDecisionsWindowSize = AI_LEAGUE_TICKER_DOM_WINDOW;
  let analystEventsWindowSize = AI_LEAGUE_TICKER_DOM_WINDOW;
  let mountedAnalystDecisionsCount = -1;
  let mountedAnalystEventsCount = -1;
  let mountedAnalystDecisionsWindowSize = analystDecisionsWindowSize;
  let mountedAnalystEventsWindowSize = analystEventsWindowSize;
  // Action-kind chart key (P2 follow-up, playhead boundary #2): the
  // chart is an AGGREGATE over the eligible decisions, not a windowed
  // list, so it has no "window size" of its own — only a change gate,
  // exactly like the match-state strip's own lastStripKey below. `null`
  // means "never structurally rendered yet" (matches the strip's own
  // convention rather than mountedWarRoomCount's -1/count sentinel,
  // since the chart's key is a JSON string, not a count).
  let mountedAnalystChartKey: string | null = null;
  // Lazy-mount (spec item 1 follow-up): the Analyst tab's heavy children
  // (chart/table/list) are only ever constructed while the tab is actually
  // visible — desktop analyst-mode toggle on, OR the mobile "Analysis"
  // drawer tab active (see mountAiLeagueAnalystToggle's own doc for why
  // those are two independent entry points to the SAME content). `null`
  // means "never structurally rendered yet".
  let mountedAnalystVisible: boolean | null = null;
  const isAnalystVisible = (): boolean =>
    document.body.classList.contains("ai-league-analyst-mode") ||
    AI_LEAGUE_DRAWER_ACTIVE_TAB.get(container) === "analysis";
  // Match-state strip key (spec item 3): the strip is a single small,
  // display-only element, but it can appear/disappear (null <-> non-null)
  // as match-state samples arrive, so it still needs its own change gate
  // rather than being unconditionally rebuilt every tick.
  let lastStripKey: string | null = null;

  const rerenderWithLastFrame = (): void => {
    renderStructural(
      AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME.get(container) ?? [],
      AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.get(container) ?? 0,
    );
  };

  const railCallbacks = () => ({
    onSelect: (playerName: string, clientID: string | null) => {
      document.dispatchEvent(
        new CustomEvent(BROADCAST_RAIL_FOLLOW_EVENT, {
          detail: { playerName, clientID },
        }),
      );
    },
    collapsed: railCollapsed,
    onToggleCollapsed: () => {
      railCollapsed = !railCollapsed;
      try {
        localStorage.setItem(
          AI_LEAGUE_RAIL_COLLAPSED_KEY,
          String(railCollapsed),
        );
      } catch {
        // Collapse-state persistence is optional.
      }
      rerenderWithLastFrame();
    },
  });

  const warRoomCallbacks = (): WarRoomWindowCallbacks => ({
    onJumpToTurn: dispatchJumpToTurn,
    collapsed: warRoomCollapsed,
    onToggleCollapsed: () => {
      warRoomCollapsed = !warRoomCollapsed;
      try {
        localStorage.setItem(
          AI_LEAGUE_WAR_ROOM_COLLAPSED_KEY,
          String(warRoomCollapsed),
        );
      } catch {
        // Collapse-state persistence is optional.
      }
      rerenderWithLastFrame();
    },
    onShowEarlier: () => {
      warRoomWindowSize += AI_LEAGUE_TICKER_DOM_WINDOW;
      // patchVolatile (not renderStructural): its own per-region key checks
      // no-op the rail/timeline/strip (nothing about them changed) and take
      // the war-room "else" branch below (window size changed), so this
      // ends up rebuilding ONLY the war-room region, never the whole drawer.
      patchVolatile(
        AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME.get(container) ?? [],
        AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.get(container) ?? 0,
      );
    },
  });

  // Same "grow the window, re-run patchVolatile" shape as the War Room's
  // own onShowEarlier above — each ends up rebuilding ONLY its own list
  // (never the whole drawer), since patchVolatile's per-region key checks
  // no-op everything whose window size didn't just change.
  const onShowEarlierAnalystDecisions = (): void => {
    analystDecisionsWindowSize += AI_LEAGUE_TICKER_DOM_WINDOW;
    patchVolatile(
      AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME.get(container) ?? [],
      AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.get(container) ?? 0,
    );
  };
  const onShowEarlierAnalystEvents = (): void => {
    analystEventsWindowSize += AI_LEAGUE_TICKER_DOM_WINDOW;
    patchVolatile(
      AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME.get(container) ?? [],
      AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.get(container) ?? 0,
    );
  };

  // Full structural rebuild of all four tabs — used only for genuinely
  // structural changes: first mount, active-tab switch, and a collapse
  // toggle (same "toggle re-renders in full" precedent
  // ReplayPremiereOverlay.ts's own BroadcastState setters already use).
  // `patchVolatile` below is the automatic per-tick path.
  const renderStructural = (
    framePlayers: readonly AiLeagueReplayFramePlayer[],
    turnNumber: number,
  ): void => {
    AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME.set(container, framePlayers);
    AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.set(container, turnNumber);
    const activeTab = AI_LEAGUE_DRAWER_ACTIVE_TAB.get(container) ?? "agents";
    const railEntries = competitorRailEntries(
      telemetry,
      decisions,
      framePlayers,
      identityByPlayerName,
    ).map((entry) => ({
      ...entry,
      followed: entry.clientID !== null && entry.clientID === followedClientID,
    }));
    const eligibleWarRoomCount = domEligibleCount(
      allWarRoomEvents,
      (event) => event.turn,
      turnNumber,
    );
    const eligibleAnalystDecisionsCount = domEligibleCount(
      allAnalystDecisions,
      (row) => row.turnNumber,
      turnNumber,
    );
    const eligibleAnalystEventsCount = domEligibleCount(
      allAnalystEvents,
      (row) => row.turnNumber,
      turnNumber,
    );
    const analystVisible = isAnalystVisible();
    // Director Cut segment (when that mode is on) takes priority over the
    // sample's own phase — spec item 3. `segmentForTurn` is a cheap binary
    // search, safe to call every frame exactly like the rest of this
    // closure already does.
    const activeSegment =
      directorCutHandle?.isEnabled() === true && directorCutPlan !== null
        ? (segmentForTurn(directorCutPlan, turnNumber)?.segment ?? null)
        : null;
    const stripFields = deriveMatchStateStripFields(
      matchStateSeries,
      turnNumber,
      framePlayers,
      identityByPlayerName,
    );
    const stripInput: MatchStateStripInput | null =
      stripFields === null
        ? null
        : {
            leader: stripFields.leader,
            territoryShareDeltaPercent: stripFields.territoryShareDeltaPercent,
            aliveCount: stripFields.aliveCount,
            totalCount: stripFields.totalCount,
            activeAllianceCount: stripFields.activeAllianceCount,
            activeWarCount: stripFields.activeWarCount,
            currentPhaseLabel:
              activeSegment !== null
                ? activeSegment.eventReason
                : translateText(
                    MATCH_STATE_PHASE_LABEL_KEYS[stripFields.samplePhase],
                  ),
          };
    // A previous render generation may have relocated panels into the
    // portal; those are now-orphaned nodes container.replaceChildren()
    // below can never reach (they live outside `container`), so clear them
    // explicitly before building the new generation.
    drawerPortal.replaceChildren();
    const rail = renderCompetitorRail(railEntries, railCallbacks());
    rail.dataset.railKey = JSON.stringify(railEntries);
    const warRoomRegion = buildWarRoomSection(
      allWarRoomEvents,
      eligibleWarRoomCount,
      warRoomWindowSize,
      warRoomCallbacks(),
    );
    // Lazy-mount (spec item 1 follow-up): only construct the Analyst tab's
    // heavy children while it's actually visible — an empty placeholder
    // otherwise, same root shape/class so the tab machinery (aria wiring,
    // relocation, existing selectors/tests) never has to know the
    // difference.
    const analystRegion = analystVisible
      ? buildAnalystPanelWindow(
          analystData.decisionsUnavailableReason,
          allAnalystDecisions,
          allAnalystEvents,
          eligibleAnalystDecisionsCount,
          eligibleAnalystEventsCount,
          analystDecisionsWindowSize,
          analystEventsWindowSize,
          onShowEarlierAnalystDecisions,
          onShowEarlierAnalystEvents,
        )
      : buildAnalystPanelPlaceholder();
    const timeline = renderMatchTimeline(timelineMarkers, {
      totalTurns,
      // Full Replay is unrestricted (unlike a live Premiere, which must
      // never seek past the live edge) — this literally IS the spec's
      // `maxSeekableTurn: null` case.
      maxSeekableTurn: null,
      // Content-free ticks ahead of playhead is the safe default (spec
      // item 2): a marker's own tooltip is itself a spoiler surface,
      // independent of `maxSeekableTurn` above.
      currentTurn: turnNumber,
      onSeek: dispatchJumpToTurn,
    });
    timeline.dataset.timelineKey = String(turnNumber);
    const tabs: BroadcastDrawerTab[] = [
      { id: "agents", content: rail },
      { id: "events", content: warRoomRegion },
      { id: "timeline", content: timeline },
      { id: "analysis", content: analystRegion },
    ];
    container.replaceChildren(
      ...(stripInput !== null ? [renderMatchStateStrip(stripInput)] : []),
      renderBroadcastDrawer(tabs, {
        activeTab,
        onTabChange: (nextTab) => {
          AI_LEAGUE_DRAWER_ACTIVE_TAB.set(container, nextTab);
          rerenderWithLastFrame();
        },
      }),
    );
    mountedWarRoomCount = eligibleWarRoomCount;
    mountedWarRoomWindowSize = warRoomWindowSize;
    mountedAnalystVisible = analystVisible;
    mountedAnalystDecisionsCount = analystVisible
      ? eligibleAnalystDecisionsCount
      : -1;
    mountedAnalystEventsCount = analystVisible ? eligibleAnalystEventsCount : -1;
    mountedAnalystChartKey = analystVisible
      ? JSON.stringify(
          analystActionKindCounts(
            allAnalystDecisions.slice(0, eligibleAnalystDecisionsCount),
          ),
        )
      : null;
    mountedAnalystDecisionsWindowSize = analystDecisionsWindowSize;
    mountedAnalystEventsWindowSize = analystEventsWindowSize;
    lastStripKey = JSON.stringify(stripInput);
    const nextPanelsHost = container.querySelector<HTMLElement>(
      ".broadcast-drawer-panels",
    );
    if (nextPanelsHost !== null) {
      relocateAiLeagueBroadcastDrawerPanels(drawerPortal, nextPanelsHost);
    }
  };

  // Automatic per-tick path (spec item 3: "no full-subtree teardown per
  // chunk"). Patches exactly the regions whose own derived content changed
  // in place — never a `container.replaceChildren()` teardown of all four
  // tabs — mirroring ReplayPremiereOverlay.ts's own
  // `applyVolatileModelUpdates`/structural-key split. `activeTab` and the
  // collapse flags never change on this path (only user clicks change
  // them, always via renderStructural above), so only rail/war-room/
  // timeline/strip/analyst need a key check here — the Analyst tab is
  // ALSO lazy-mounted/windowed on this path now (spec item 1 follow-up,
  // P2 review): patched exactly like the War Room ticker while visible,
  // and torn down to the empty placeholder the moment it stops being
  // visible, so its own DOM cost is zero while closed.
  const patchVolatile = (
    framePlayers: readonly AiLeagueReplayFramePlayer[],
    turnNumber: number,
  ): void => {
    const drawer = container.querySelector<HTMLElement>(".broadcast-drawer");
    if (drawer === null) {
      renderStructural(framePlayers, turnNumber);
      return;
    }
    AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME.set(container, framePlayers);
    AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.set(container, turnNumber);

    const railEntries = competitorRailEntries(
      telemetry,
      decisions,
      framePlayers,
      identityByPlayerName,
    ).map((entry) => ({
      ...entry,
      followed: entry.clientID !== null && entry.clientID === followedClientID,
    }));
    const rail = container.querySelector<HTMLElement>(".broadcast-rail");
    if (rail !== null) {
      const nextRailKey = JSON.stringify(railEntries);
      if (rail.dataset.railKey !== nextRailKey) {
        rail.dataset.railKey = nextRailKey;
        // Territory/rank/allies/wars change on nearly every tick during
        // active play, so a `rail.replaceWith(nextRail)` full teardown here
        // reset the rail's own scrolled `.broadcast-rail-list`'s
        // `scrollTop` to 0 on almost every frame — the same
        // "teleports me back" class the diplomacy strip had. Patch the
        // list's rows in place, keyed by agent identity, and leave the
        // rest of `.broadcast-rail` (heading, collapse toggle — static
        // across ticks, only user clicks change them) untouched.
        const nextRail = renderCompetitorRail(railEntries, railCallbacks());
        const liveList = rail.querySelector<HTMLElement>(
          ".broadcast-rail-list",
        );
        const freshList = nextRail.querySelector<HTMLElement>(
          ".broadcast-rail-list",
        );
        if (liveList !== null && freshList !== null) {
          patchKeyedRegion(liveList, freshList, "data-rail-entry-key");
        }
      }
    }

    // "events"/"timeline" panels may currently live inside `drawerPortal`
    // (a `document.body` child, outside `container` — see
    // relocateAiLeagueBroadcastDrawerPanels's own doc), so — exactly like
    // that function's own panel lookups — these are document-scoped, not
    // container-scoped.
    const warRoomSection = document.querySelector<HTMLElement>(
      ".broadcast-war-room",
    );
    if (warRoomSection !== null) {
      const eligibleWarRoomCount = domEligibleCount(
        allWarRoomEvents,
        (event) => event.turn,
        turnNumber,
      );
      if (
        mountedWarRoomCount > 0 &&
        eligibleWarRoomCount >= mountedWarRoomCount &&
        warRoomWindowSize === mountedWarRoomWindowSize
      ) {
        // Pure forward tick: incremental append/prune, no rebuild.
        if (eligibleWarRoomCount !== mountedWarRoomCount) {
          patchWarRoomWindowForward(
            warRoomSection,
            allWarRoomEvents,
            mountedWarRoomCount,
            eligibleWarRoomCount,
            warRoomWindowSize,
            warRoomCallbacks(),
          );
        }
      } else {
        // Non-monotonic (a seek/jump backward dropped trailing events),
        // still in the empty placeholder state, or the window size just
        // changed (onShowEarlier) — rebuild ONLY this region, never the
        // whole drawer.
        const nextWarRoom = buildWarRoomSection(
          allWarRoomEvents,
          eligibleWarRoomCount,
          warRoomWindowSize,
          warRoomCallbacks(),
        );
        preserveDrawerPanelWrapperIdentity(warRoomSection, nextWarRoom);
        warRoomSection.replaceWith(nextWarRoom);
      }
      mountedWarRoomCount = eligibleWarRoomCount;
      mountedWarRoomWindowSize = warRoomWindowSize;
    }

    // Analyst tab (spec item 1 follow-up, P2 review): lazy-mounted, and —
    // while visible — windowed exactly like the War Room ticker above,
    // with its two sub-lists (decisions table, event log) patched fully
    // independently of each other.
    const analystSection = document.querySelector<HTMLElement>(
      ".broadcast-analyst",
    );
    if (analystSection !== null) {
      const analystVisible = isAnalystVisible();
      if (!analystVisible) {
        // Reclaim the DOM the instant it's no longer visible — never keep
        // patching content nobody can see.
        if (mountedAnalystVisible !== false) {
          const placeholder = buildAnalystPanelPlaceholder();
          preserveDrawerPanelWrapperIdentity(analystSection, placeholder);
          analystSection.replaceWith(placeholder);
        }
        mountedAnalystVisible = false;
        mountedAnalystDecisionsCount = -1;
        mountedAnalystEventsCount = -1;
        mountedAnalystChartKey = null;
      } else {
        const eligibleAnalystDecisionsCount = domEligibleCount(
          allAnalystDecisions,
          (row) => row.turnNumber,
          turnNumber,
        );
        const eligibleAnalystEventsCount = domEligibleCount(
          allAnalystEvents,
          (row) => row.turnNumber,
          turnNumber,
        );
        // Aggregate, not a windowed list — see analystActionKindCounts's
        // own doc for why this is always a full recompute over the
        // eligible slice, keyed exactly like the match-state strip below
        // so the tiny chart region only ever gets touched when the
        // computed distribution actually changed.
        const nextAnalystChartCounts = analystActionKindCounts(
          allAnalystDecisions.slice(0, eligibleAnalystDecisionsCount),
        );
        const nextAnalystChartKey = JSON.stringify(nextAnalystChartCounts);
        if (mountedAnalystVisible !== true) {
          // Just turned visible (or the very first tick with it already
          // on) — cold build the whole panel, the same way the War Room
          // ticker handles its own "was empty" transition.
          const nextAnalyst = buildAnalystPanelWindow(
            analystData.decisionsUnavailableReason,
            allAnalystDecisions,
            allAnalystEvents,
            eligibleAnalystDecisionsCount,
            eligibleAnalystEventsCount,
            analystDecisionsWindowSize,
            analystEventsWindowSize,
            onShowEarlierAnalystDecisions,
            onShowEarlierAnalystEvents,
          );
          preserveDrawerPanelWrapperIdentity(analystSection, nextAnalyst);
          analystSection.replaceWith(nextAnalyst);
        } else {
          if (
            mountedAnalystDecisionsCount > 0 &&
            eligibleAnalystDecisionsCount >= mountedAnalystDecisionsCount &&
            analystDecisionsWindowSize === mountedAnalystDecisionsWindowSize
          ) {
            if (
              eligibleAnalystDecisionsCount !== mountedAnalystDecisionsCount
            ) {
              patchAnalystDecisionsWindowForward(
                analystSection,
                allAnalystDecisions,
                mountedAnalystDecisionsCount,
                eligibleAnalystDecisionsCount,
                analystDecisionsWindowSize,
                onShowEarlierAnalystDecisions,
              );
            }
          } else {
            analystSection
              .querySelector(".broadcast-analyst-decisions")
              ?.replaceWith(
                buildAnalystDecisionsSection(
                  allAnalystDecisions,
                  analystData.decisionsUnavailableReason,
                  eligibleAnalystDecisionsCount,
                  analystDecisionsWindowSize,
                  onShowEarlierAnalystDecisions,
                ),
              );
          }
          if (
            mountedAnalystEventsCount > 0 &&
            eligibleAnalystEventsCount >= mountedAnalystEventsCount &&
            analystEventsWindowSize === mountedAnalystEventsWindowSize
          ) {
            if (eligibleAnalystEventsCount !== mountedAnalystEventsCount) {
              patchAnalystEventsWindowForward(
                analystSection,
                allAnalystEvents,
                mountedAnalystEventsCount,
                eligibleAnalystEventsCount,
                analystEventsWindowSize,
                onShowEarlierAnalystEvents,
              );
            }
          } else {
            analystSection
              .querySelector(".broadcast-analyst-events")
              ?.replaceWith(
                buildAnalystEventsSection(
                  allAnalystEvents,
                  eligibleAnalystEventsCount,
                  analystEventsWindowSize,
                  onShowEarlierAnalystEvents,
                ),
              );
          }
          if (nextAnalystChartKey !== mountedAnalystChartKey) {
            const existingChart = analystSection.querySelector<HTMLElement>(
              ".broadcast-analyst-chart",
            );
            if (nextAnalystChartCounts.length === 0) {
              existingChart?.remove();
            } else if (existingChart !== null) {
              existingChart.replaceWith(
                renderAnalystActionChart(nextAnalystChartCounts),
              );
            } else {
              analystSection.prepend(
                renderAnalystActionChart(nextAnalystChartCounts),
              );
            }
          }
        }
        mountedAnalystVisible = true;
        mountedAnalystDecisionsCount = eligibleAnalystDecisionsCount;
        mountedAnalystEventsCount = eligibleAnalystEventsCount;
        mountedAnalystDecisionsWindowSize = analystDecisionsWindowSize;
        mountedAnalystEventsWindowSize = analystEventsWindowSize;
        mountedAnalystChartKey = nextAnalystChartKey;
      }
    }

    const timeline = document.querySelector<HTMLElement>(
      ".broadcast-timeline",
    );
    if (timeline !== null) {
      const nextTimelineKey = String(turnNumber);
      if (timeline.dataset.timelineKey !== nextTimelineKey) {
        const nextTimeline = renderMatchTimeline(timelineMarkers, {
          totalTurns,
          maxSeekableTurn: null,
          currentTurn: turnNumber,
          onSeek: dispatchJumpToTurn,
        });
        // `renderMatchTimeline()` only ever returns a bare `.broadcast-
        // timeline` section — see `preserveDrawerPanelWrapperIdentity`'s
        // own doc for why the wrapper identity has to be copied back on:
        // losing it collapsed the whole timeline to 0×0 and made it
        // permanently unusable starting on the SECOND tick after mount
        // (found live in production during the P1 interaction sweep — the
        // timeline key changes on virtually every frame, unlike War
        // Room/Analyst, which patch their list in place on the common
        // forward-tick path and only ever replaceWith() on a rarer jump).
        preserveDrawerPanelWrapperIdentity(timeline, nextTimeline);
        nextTimeline.dataset.timelineKey = nextTimelineKey;
        timeline.replaceWith(nextTimeline);
      }
    }

    const activeSegment =
      directorCutHandle?.isEnabled() === true && directorCutPlan !== null
        ? (segmentForTurn(directorCutPlan, turnNumber)?.segment ?? null)
        : null;
    const stripFields = deriveMatchStateStripFields(
      matchStateSeries,
      turnNumber,
      framePlayers,
      identityByPlayerName,
    );
    const stripInput: MatchStateStripInput | null =
      stripFields === null
        ? null
        : {
            leader: stripFields.leader,
            territoryShareDeltaPercent: stripFields.territoryShareDeltaPercent,
            aliveCount: stripFields.aliveCount,
            totalCount: stripFields.totalCount,
            activeAllianceCount: stripFields.activeAllianceCount,
            activeWarCount: stripFields.activeWarCount,
            currentPhaseLabel:
              activeSegment !== null
                ? activeSegment.eventReason
                : translateText(
                    MATCH_STATE_PHASE_LABEL_KEYS[stripFields.samplePhase],
                  ),
          };
    const nextStripKey = JSON.stringify(stripInput);
    if (nextStripKey !== lastStripKey) {
      lastStripKey = nextStripKey;
      const existingStrip = container.querySelector<HTMLElement>(
        ".broadcast-state-strip",
      );
      if (stripInput === null) {
        existingStrip?.remove();
      } else if (existingStrip !== null) {
        existingStrip.replaceWith(renderMatchStateStrip(stripInput));
      } else {
        container.insertBefore(
          renderMatchStateStrip(stripInput),
          container.firstChild,
        );
      }
    }
  };

  renderStructural(
    AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME.get(container) ?? [],
    AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.get(container) ?? input.currentTurn ?? 0,
  );
  const onFrame = (event: Event) => {
    const detail = (event as CustomEvent<AiLeagueReplayFrameEventDetail>)
      .detail;
    if (!detail || !Array.isArray(detail.players)) {
      return;
    }
    const turnNumber = Number.isFinite(detail.turnNumber)
      ? detail.turnNumber
      : (AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.get(container) ?? 0);
    patchVolatile(detail.players, turnNumber);
  };
  const onResize = (): void => {
    const panelsHost = container.querySelector<HTMLElement>(
      ".broadcast-drawer-panels",
    );
    if (panelsHost !== null) {
      relocateAiLeagueBroadcastDrawerPanels(drawerPortal, panelsHost);
    }
  };
  // Desktop analyst-mode toggle (spec item 1 follow-up): its own
  // `document.body` class flip has no render cycle of its own (see
  // AI_LEAGUE_ANALYST_MODE_CHANGE_EVENT's own doc), so patch immediately
  // on the SAME "last known frame/turn" basis every other manual trigger
  // in this closure (collapse toggles, show-earlier) already uses, rather
  // than waiting for the next automatic tick.
  const onAnalystModeChange = (): void => {
    patchVolatile(
      AI_LEAGUE_BROADCAST_DRAWER_LAST_FRAME.get(container) ?? [],
      AI_LEAGUE_BROADCAST_DRAWER_LAST_TURN.get(container) ?? 0,
    );
  };
  document.addEventListener("ai-league-replay-frame", onFrame);
  window.addEventListener("resize", onResize);
  document.addEventListener(
    AI_LEAGUE_ANALYST_MODE_CHANGE_EVENT,
    onAnalystModeChange,
  );
  win.__aiLeagueBroadcastDrawerCleanup = () => {
    document.removeEventListener("ai-league-replay-frame", onFrame);
    window.removeEventListener("resize", onResize);
    document.removeEventListener(
      AI_LEAGUE_ANALYST_MODE_CHANGE_EVENT,
      onAnalystModeChange,
    );
  };
}

/**
 * `plan_change` events, curated from THIS overlay's own decision log
 * (`AiLeagueDecisionLogEntry.planObjective`) — the same field
 * `latestDirectiveByPlayer` already surfaces as the per-agent "Directive"
 * line. Neither AgentDramaReport.ts nor AgentMatchStory.ts model a
 * strategy/plan-shift signal (their "kind"/"storyKind" fields only bucket
 * individual decisions/spectator events, never a change relative to the
 * agent's own prior turn) — this is a genuinely different, already-public,
 * already-derivable signal already flowing into this exact overlay, so it is
 * used directly rather than reaching for a fabricated heuristic. Selective
 * by construction: only an actual value transition curates an event, and
 * decisions carry no `importance` field to threshold against.
 */
function planChangeWarRoomEvents(
  decisions: readonly AiLeagueDecisionLogEntry[],
): CuratedWarRoomEvent[] {
  const lastPlanByPlayer = new Map<string, string>();
  const curated: CuratedWarRoomEvent[] = [];
  const ordered = [...decisions].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  for (const decision of ordered) {
    const objective =
      typeof decision.planObjective === "string" &&
      decision.planObjective.trim().length > 0
        ? decision.planObjective.trim()
        : null;
    if (objective === null) continue;
    const key = normalizeName(decision.username);
    const previous = lastPlanByPlayer.get(key);
    lastPlanByPlayer.set(key, objective);
    if (previous === undefined || previous === objective) continue;
    const actor = aiLeagueSpectatorDisplayName(decision.username);
    curated.push({
      id: `plan-change:${decision.sequence}`,
      kind: "plan_change",
      turn: decision.turnNumber,
      sequence: decision.sequence,
      headline: translateText("ai_league_replay.event_plan_change", {
        actor,
        plan: objective,
      }),
      publicReason: decision.reason,
      participants: [actor],
      expandedDetail:
        typeof decision.planRationale === "string" &&
        decision.planRationale.trim().length > 0
          ? decision.planRationale.trim()
          : null,
      tier: 2,
    });
  }
  return curated;
}

/**
 * Impact proxy for War Room tiering (content curation spec item 1, deploy
 * 3.3): the raw telemetry carries no per-strike magnitude field at all —
 * every "attack" event is emitted at a flat importance=70 regardless of how
 * much territory changed hands (verified against production
 * spectator-telemetry.json: every attack across a full match sampled at
 * exactly importance 70, elimination at exactly 90 — there is no variance
 * to read a "was this the biggest hit of the match" signal from). So a
 * first strike's own importance can never distinguish "routine" from
 * "notable". The closest signal actually present in the data: did either
 * participant go on to matter to the match's outcome (get eliminated, or
 * enter/break an alliance) at some point? A first strike touching one of
 * those agents is "notable" (tier 2); one between two agents who never
 * appear in a major moment for the rest of the match is "routine" (tier
 * 3) and gets collapsed by groupRoutineWarRoomEvents below.
 */
function consequentialAgentIDs(
  events: readonly AiLeagueSpectatorEvent[],
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const isMajor =
      event.kind === "elimination" ||
      event.kind === "alliance_formed" ||
      (event.kind === "alliance_break" && event.tone === "betrayal");
    if (!isMajor) continue;
    ids.add(event.actorAgentID);
    if (event.targetAgentID !== null) ids.add(event.targetAgentID);
  }
  return ids;
}

/**
 * Collapses consecutive runs of tier-3 "routine" War Room events (length
 * >= 2) into ONE synthetic tier-3 summary event per run — spec item 1's
 * "this is the single highest-leverage change": on a large match, routine
 * first-strike noise between agents that never become consequential is
 * exactly what floods the list. A lone tier-3 event with no adjacent
 * tier-3 neighbor is left as-is (nothing to group). A run never crosses a
 * tier-1/2 event, so grouping only ever merges rows that were already
 * sitting next to each other in the curated order.
 *
 * Applied ONCE to the full ordered array `curatedWarRoomEvents` returns
 * (never per-tick or per-window-slice), so the same underlying events
 * always collapse into the same group across ticks — required for
 * `patchWarRoomWindowForward`'s position-indexed incremental patching over
 * this array to stay correct.
 */
function groupRoutineWarRoomEvents(
  events: readonly CuratedWarRoomEvent[],
): CuratedWarRoomEvent[] {
  const grouped: CuratedWarRoomEvent[] = [];
  let run: CuratedWarRoomEvent[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      grouped.push(run[0]);
    } else {
      const first = run[0];
      const last = run[run.length - 1];
      const participants = [...new Set(run.flatMap((e) => e.participants))];
      grouped.push({
        id: `war-room-group:${first.id}:${last.id}`,
        kind: last.kind,
        turn: last.turn,
        sequence: last.sequence,
        headline: translateText("ai_league_replay.war_room_grouped_skirmishes", {
          count: run.length,
        }),
        publicReason: null,
        participants,
        expandedDetail: run
          .map(
            (e) =>
              `${translateText("broadcast.war_room_turn", { turn: e.turn })} — ${e.headline}`,
          )
          .join("\n"),
        tier: 3,
      });
    }
    run = [];
  };
  for (const event of events) {
    if (event.tier === 3) {
      run.push(event);
    } else {
      flushRun();
      grouped.push(event);
    }
  }
  flushRun();
  return grouped;
}

/**
 * Curated War Room feed. Selective by kind:
 *  - alliance/betrayal/elimination gate on
 *    AI_LEAGUE_WAR_ROOM_IMPORTANCE_THRESHOLD (matching AgentDramaReport.ts's
 *    own HIGH_IMPORTANCE_THRESHOLD) — a no-op in practice today (these kinds
 *    are always emitted at 90+ importance server-side) but an honest,
 *    future-proof guard rather than an unconditional pass-through.
 *  - first_strike is selective by construction (first attack per ordered
 *    pair only) rather than by importance: raw "attack" events are emitted
 *    at importance 70, structurally below the threshold, so gating on
 *    importance here would silently drop every first strike.
 *  - elimination events (`addEliminationEvents`) never carry a target — the
 *    eliminated agent IS the actor — so the headline is built from `actor`
 *    alone.
 * `lead_change`/before-after-territory `expandedDetail` are NOT produced:
 * this overlay only ever sees a live, forward-only frame stream (no stored
 * turn-by-turn territory series), so neither is derivable without
 * fabricating a value.
 *
 * Content curation (spec item 1, deploy 3.3): every event is classified
 * into a tier (see CuratedWarRoomEvent.tier's own doc and
 * consequentialAgentIDs above), then consecutive tier-3 runs are collapsed
 * via groupRoutineWarRoomEvents before returning — the RETURNED array is
 * already the one every caller (War Room ticker, lower thirds, timeline
 * pulse dedup) should render directly.
 */
function curatedWarRoomEvents(
  telemetry: AiLeagueSpectatorTelemetry | null,
  decisions: readonly AiLeagueDecisionLogEntry[],
): CuratedWarRoomEvent[] {
  const curated: CuratedWarRoomEvent[] = [];
  const firstStrikeSeen = new Set<string>();
  const consequential = consequentialAgentIDs(telemetry?.events ?? []);
  const ordered = [...(telemetry?.events ?? [])].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  for (const event of ordered) {
    const actor = aiLeagueSpectatorDisplayName(event.actorName);
    const target =
      event.targetName !== null
        ? aiLeagueSpectatorDisplayName(event.targetName)
        : null;
    // P0 fix (2026-08-03): the expanded row's "stated reason" text (raw
    // `publicText`/`message`) leaked a real agent's name straight through
    // even with Anonymous Names on -- `headline`/`participants` above were
    // already anonymized, but this field was passed through verbatim.
    const publicReason = aiLeagueSpectatorText(event.publicText ?? event.message);

    if (event.kind === "attack" && target !== null) {
      const pairKey = `${event.actorAgentID}|${event.targetAgentID ?? target}`;
      if (!firstStrikeSeen.has(pairKey)) {
        firstStrikeSeen.add(pairKey);
        const isConsequential =
          consequential.has(event.actorAgentID) ||
          (event.targetAgentID !== null &&
            consequential.has(event.targetAgentID));
        curated.push({
          id: event.id,
          kind: "first_strike",
          turn: event.turnNumber,
          sequence: event.sequence,
          headline: translateText("ai_league_replay.headline_first_strike", {
            actor,
            target,
          }),
          publicReason,
          participants: [actor, target],
          expandedDetail: null,
          tier: isConsequential ? 2 : 3,
        });
      }
      continue;
    }
    if (event.importance < AI_LEAGUE_WAR_ROOM_IMPORTANCE_THRESHOLD) continue;
    if (event.kind === "alliance_formed" && target !== null) {
      curated.push({
        id: event.id,
        kind: "alliance",
        turn: event.turnNumber,
        sequence: event.sequence,
        headline: translateText("ai_league_replay.event_alliance_formed", {
          actor,
          target,
        }),
        publicReason,
        participants: [actor, target],
        expandedDetail: null,
        tier: 1,
      });
      continue;
    }
    if (event.kind === "alliance_break" && event.tone === "betrayal" && target !== null) {
      curated.push({
        id: event.id,
        kind: "betrayal",
        turn: event.turnNumber,
        sequence: event.sequence,
        headline: translateText("ai_league_replay.headline_betrayal", {
          actor,
          target,
        }),
        publicReason,
        participants: [actor, target],
        expandedDetail: null,
        tier: 1,
      });
      continue;
    }
    if (event.kind === "elimination") {
      curated.push({
        id: event.id,
        kind: "elimination",
        turn: event.turnNumber,
        sequence: event.sequence,
        headline: translateText("ai_league_replay.event_eliminated", {
          actor,
        }),
        publicReason,
        participants: [actor],
        expandedDetail: null,
        tier: 1,
      });
    }
  }
  curated.push(...planChangeWarRoomEvents(decisions));
  const sorted = curated.sort(
    (a, b) => a.turn - b.turn || a.sequence - b.sequence,
  );
  return groupRoutineWarRoomEvents(sorted);
}

/**
 * `spawn`/`alliance`/`first_strike`/`betrayal`/`nuke`/`elimination` markers,
 * derived from the same telemetry events as the War Room feed (unfiltered by
 * importance here — timeline markers are inherently sparse/positional, not a
 * feed that needs curating down). `lead_change` is intentionally never
 * produced: see curatedWarRoomEvents's doc — no turn-by-turn territory
 * series is available to this overlay, only a live forward-only frame
 * stream, so lead-change detection is genuinely infeasible without
 * fabricating a moment.
 */
function matchTimelineEventMarkers(
  telemetry: AiLeagueSpectatorTelemetry | null,
): TimelineMarker[] {
  const markers: TimelineMarker[] = [];
  const firstStrikeSeen = new Set<string>();
  const ordered = [...(telemetry?.events ?? [])].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  const push = (kind: TimelineMarkerKind, event: AiLeagueSpectatorEvent, label: string) => {
    markers.push({ kind, turn: event.turnNumber, sequence: event.sequence, label });
  };
  for (const event of ordered) {
    const actor = aiLeagueSpectatorDisplayName(event.actorName);
    const target =
      event.targetName !== null
        ? aiLeagueSpectatorDisplayName(event.targetName)
        : null;
    switch (event.kind) {
      case "spawn":
        push("spawn", event, translateText("ai_league_replay.event_spawn", { actor }));
        break;
      case "alliance_formed":
        if (target !== null) {
          push("alliance", event, translateText("ai_league_replay.event_alliance_formed", { actor, target }));
        }
        break;
      case "alliance_break":
        if (event.tone === "betrayal" && target !== null) {
          push("betrayal", event, translateText("ai_league_replay.headline_betrayal", { actor, target }));
        }
        break;
      case "attack":
        if (target !== null) {
          const pairKey = `${event.actorAgentID}|${event.targetAgentID ?? target}`;
          if (!firstStrikeSeen.has(pairKey)) {
            firstStrikeSeen.add(pairKey);
            push("first_strike", event, translateText("ai_league_replay.headline_first_strike", { actor, target }));
          }
        }
        break;
      case "nuke":
        push(
          "nuke",
          event,
          target !== null
            ? translateText("ai_league_replay.event_nuke_target", { actor, target })
            : translateText("ai_league_replay.event_nuke", { actor }),
        );
        break;
      case "elimination":
        push("elimination", event, translateText("ai_league_replay.event_eliminated", { actor }));
        break;
      default:
        break;
    }
  }
  return markers;
}

/** The canonical record range (same value already used for the Clip control
 * and as `replayMaxTurn`) — falls back to the highest observed turn number
 * across decisions/events only while that canonical bound has not arrived
 * yet. */
function aiLeagueFinishTurn(
  input: AiLeagueReplayOverlayInput,
  telemetry: AiLeagueSpectatorTelemetry | null,
): number {
  if (typeof input.replayMaxTurn === "number" && input.replayMaxTurn > 0) {
    return input.replayMaxTurn;
  }
  const decisionMax = input.decisions.reduce(
    (max, decision) => Math.max(max, decision.turnNumber),
    0,
  );
  const eventMax = (telemetry?.events ?? []).reduce(
    (max, event) => Math.max(max, event.turnNumber),
    0,
  );
  return Math.max(1, decisionMax, eventMax);
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
      <p>${escapeHtml(decision.reason ?? "(no stated reason — fallback decision)")}</p>
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

/**
 * Client-local mirror of `AgentMatchStateSeries.ts`'s public shape (product
 * overhaul Season Zero broadcast Phase 5). Client code never imports server
 * modules — same pattern `DirectorCutController.ts`'s own top-of-file doc
 * already establishes for `director-cut-plan.json`.
 */
export type AiLeagueMatchStatePhase = "spawn" | "active" | "finished";

export interface AiLeagueMatchStateSample {
  turn: number;
  phase: AiLeagueMatchStatePhase;
  agents: ReadonlyArray<{
    playerID: string;
    username: string;
    alive: boolean;
    territoryShare: number;
    rank: number;
  }>;
  activeAlliancePairs: ReadonlyArray<readonly [string, string]>;
}

export interface AiLeagueMatchStateSeries {
  totalTurns: number;
  samples: readonly AiLeagueMatchStateSample[];
}

export function normalizeMatchStateSeries(value: unknown): AiLeagueMatchStateSeries | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.totalTurns !== "number" ||
    !Array.isArray(candidate.samples)
  ) {
    return null;
  }
  for (const sample of candidate.samples) {
    if (
      typeof sample !== "object" ||
      sample === null ||
      typeof (sample as Partial<AiLeagueMatchStateSample>).turn !== "number" ||
      !["spawn", "active", "finished"].includes(
        (sample as Partial<AiLeagueMatchStateSample>).phase as string,
      ) ||
      !Array.isArray((sample as Partial<AiLeagueMatchStateSample>).agents) ||
      !Array.isArray(
        (sample as Partial<AiLeagueMatchStateSample>).activeAlliancePairs,
      )
    ) {
      return null;
    }
    for (const agent of (sample as AiLeagueMatchStateSample).agents) {
      if (
        typeof agent !== "object" ||
        agent === null ||
        typeof agent.playerID !== "string" ||
        typeof agent.username !== "string" ||
        typeof agent.alive !== "boolean" ||
        typeof agent.territoryShare !== "number" ||
        typeof agent.rank !== "number"
      ) {
        return null;
      }
    }
  }
  return candidate as unknown as AiLeagueMatchStateSeries;
}

const MATCH_STATE_PHASE_LABEL_KEYS: Record<AiLeagueMatchStatePhase, string> = {
  spawn: "broadcast.phase_spawn",
  active: "broadcast.phase_active",
  finished: "broadcast.phase_finished",
};

/**
 * Windows the whole-match `match-state-series.json` artifact down to the
 * ONE sample at or before the viewer's own playhead — the same released/
 * redaction boundary every other broadcast region in this file already
 * enforces (`warRoomEvents.filter(event.turn <= turnNumber)` above), just
 * applied to a differently-shaped artifact. Never a future sample: if the
 * playhead is before the first sample, there is no safe sample yet and this
 * returns `null` — the strip stays entirely absent for that frame, exactly
 * like `renderMatchStateStrip`'s own null-tolerant `leader`/`currentPhaseLabel`
 * fields already do for a single missing field.
 *
 * `activeWarCount` deliberately does NOT come from the series — it has no
 * war/peace concept at all (`AgentMatchStateSeries.ts`'s own module doc:
 * a formal war flag "would have to be inferred from attack recency — not a
 * real recorded state", the same fabrication class that doc already
 * refuses). Instead this reuses the SAME live-frame `targets`/`allies`
 * arrays `aiLeagueRailRelations` already trusts for the identical "wars"
 * concept on the competitor rail, aggregated into unique pairs.
 *
 * `currentPhaseLabel` is resolved by the caller (Director Cut's active
 * segment when that mode is on; this sample's own `phase` — translated —
 * otherwise), so it is not part of this function's return.
 */
export function deriveMatchStateStripFields(
  series: AiLeagueMatchStateSeries | null,
  currentTurn: number,
  framePlayers: readonly AiLeagueReplayFramePlayer[],
  identityByPlayerName: ReadonlyMap<string, PublicAgent>,
): (Omit<MatchStateStripInput, "currentPhaseLabel"> & {
  samplePhase: AiLeagueMatchStatePhase;
}) | null {
  if (series === null) return null;
  let sample: AiLeagueMatchStateSample | null = null;
  let previousSample: AiLeagueMatchStateSample | null = null;
  for (const candidate of series.samples) {
    if (candidate.turn > currentTurn) break;
    previousSample = sample;
    sample = candidate;
  }
  if (sample === null) return null;
  const leaderAgent = sample.agents.find((agent) => agent.rank === 1) ?? null;
  // The leader identity/percent PREFER the SAME live per-tick frame data
  // the Standings/Competitors rail renders from (identical formula to
  // `competitorRailEntries`'s own `totalTiles`/`territoryPercent`: tiles
  // owned over the sum of every current frame player's tiles owned, and
  // "leader" = the frame player ranked #1 by that same sort) — never the
  // coarse match-state-series sample, which is captured at most every
  // ~200 turns (`MATCH_STATE_SERIES_MAX_SAMPLES` over a whole match) and
  // can lag well behind the live tick. That lag is exactly what produced
  // pass-10's P1 finding (t4-01/t4-02): "Leader relh · 64%" against the
  // Standings/Competitors' live "89%" for the SAME agent at the SAME
  // instant — the strip was reading a stale sample instead of the tick
  // the rest of the panel was already rendering. Only fall back to the
  // series sample when no live frame data has arrived yet (defensive:
  // both real call sites always pass a live frame by the time this runs).
  const totalTiles = framePlayers.reduce(
    (sum, player) => sum + Math.max(0, player.tilesOwned),
    0,
  );
  const topFramePlayer =
    totalTiles > 0
      ? [...framePlayers].sort((a, b) => b.tilesOwned - a.tilesOwned)[0]
      : null;
  const leader =
    topFramePlayer !== null
      ? {
          displayName:
            identityByPlayerName.get(topFramePlayer.username)?.displayName ??
            aiLeagueSpectatorDisplayName(
              (topFramePlayer.displayName ?? "") || topFramePlayer.username,
            ),
          territoryPercent: (topFramePlayer.tilesOwned / totalTiles) * 100,
        }
      : leaderAgent === null
        ? null
        : {
            displayName:
              identityByPlayerName.get(leaderAgent.username)?.displayName ??
              aiLeagueSpectatorDisplayName(leaderAgent.username),
            territoryPercent: leaderAgent.territoryShare * 100,
          };
  let territoryShareDeltaPercent: number | null = null;
  const deltaPlayerID = topFramePlayer?.playerID ?? leaderAgent?.playerID ?? null;
  if (deltaPlayerID !== null && previousSample !== null && leader !== null) {
    const previousAgent = previousSample.agents.find(
      (agent) => agent.playerID === deltaPlayerID,
    );
    if (previousAgent !== undefined) {
      territoryShareDeltaPercent =
        leader.territoryPercent - previousAgent.territoryShare * 100;
    }
  }
  return {
    leader,
    territoryShareDeltaPercent,
    aliveCount: sample.agents.filter((agent) => agent.alive).length,
    totalCount: sample.agents.length,
    activeAllianceCount: sample.activeAlliancePairs.length,
    activeWarCount: activeWarPairCount(framePlayers),
    samplePhase: sample.phase,
  };
}

/** Unique at-war PAIRS (never double-counted A-vs-B/B-vs-A) among the
 * current live frame roster, same bidirectional-targets-minus-allies
 * detection `aiLeagueRailRelations` already uses per-player, aggregated. */
export function activeWarPairCount(
  framePlayers: readonly AiLeagueReplayFramePlayer[],
): number {
  const bySmallID = new Map(framePlayers.map((player) => [player.smallID, player]));
  const counted = new Set<string>();
  for (const player of framePlayers) {
    const allied = new Set(Array.isArray(player.allies) ? player.allies : []);
    const targets = Array.isArray(player.targets) ? player.targets : [];
    for (const targetSmallID of targets) {
      if (allied.has(targetSmallID) || !bySmallID.has(targetSmallID)) continue;
      const pairKey = [player.smallID, targetSmallID]
        .sort((a, b) => a - b)
        .join(":");
      counted.add(pairKey);
    }
  }
  return counted.size;
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

// Collapse/expand persistence (spec item 1) for the broadcast composition's
// two side panels — same try/catch-optional idiom as
// readStoredPanelLayout/persistPanelLayout above, deliberately independent
// of that panel-position storage key since collapse state and drag/resize
// position are orthogonal preferences a viewer may set separately. Read/
// write inline at each of the two call sites in
// mountAiLeagueBroadcastDrawer (no wrapper — each is a single localStorage
// call guarded by try/catch, not durable behavior worth naming).
const AI_LEAGUE_RAIL_COLLAPSED_KEY = "ai-league-broadcast-rail-collapsed-v1";
const AI_LEAGUE_WAR_ROOM_COLLAPSED_KEY =
  "ai-league-broadcast-war-room-collapsed-v1";

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
