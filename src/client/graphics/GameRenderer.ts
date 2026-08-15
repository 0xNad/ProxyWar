import { EventBus } from "../../core/EventBus";
import { GameView } from "../../core/game/GameView";
import { UserSettings } from "../../core/game/UserSettings";
import { isAiLeagueNativeSpectatorUiEnabled } from "../AiLeagueReplayMode";
import { GameStartingModal } from "../GameStartingModal";
import { RefreshGraphicsEvent as RedrawGraphicsEvent } from "../InputHandler";
import { replayIntegrity } from "../ReplayIntegrityStore";
import { canvasPixelRatio, translateText } from "../Utils";
import { installCompetitorLocateBridge } from "./CompetitorLocateBridge";
import { FrameProfiler } from "./FrameProfiler";
import { isReplaySpectatorView, TransformHandler } from "./TransformHandler";
import { UIState } from "./UIState";
import { AlertFrame } from "./layers/AlertFrame";
import { mountAnalystDrawer } from "./layers/AnalystDrawer";
import { AttackingTroopsOverlay } from "./layers/AttackingTroopsOverlay";
import { AttacksDisplay } from "./layers/AttacksDisplay";
import { mountBroadcastScrubber } from "./layers/BroadcastScrubber";
import { mountBroadcastSpotlight } from "./layers/BroadcastSpotlight";
import { BuildMenu } from "./layers/BuildMenu";
import { ChatDisplay } from "./layers/ChatDisplay";
import { ChatModal } from "./layers/ChatModal";
import { ControlPanel } from "./layers/ControlPanel";
import { CoordinateGridLayer } from "./layers/CoordinateGridLayer";
import { DynamicUILayer } from "./layers/DynamicUILayer";
import { EventsDisplay } from "./layers/EventsDisplay";
import {
  followedCompetitorSmallId,
  installFollowedCompetitor,
} from "./layers/FollowedCompetitor";
import { FxLayer } from "./layers/FxLayer";
import { GameLeftSidebar } from "./layers/GameLeftSidebar";
import {
  GameRightSidebar,
  HUD_HIDDEN_BODY_CLASS,
} from "./layers/GameRightSidebar";
import { HeadsUpMessage } from "./layers/HeadsUpMessage";
import { ImmunityTimer } from "./layers/ImmunityTimer";
import { InGamePromo } from "./layers/InGamePromo";
import { Layer } from "./layers/Layer";
import { Leaderboard } from "./layers/Leaderboard";
import { MultiTabModal } from "./layers/MultiTabModal";
import { NameLayer } from "./layers/NameLayer";
import { mountNationDossier } from "./layers/NationDossier";
import { mountNukeCinema } from "./layers/NukeCinema";
import { NukeTrajectoryPreviewLayer } from "./layers/NukeTrajectoryPreviewLayer";
import { PerformanceOverlay } from "./layers/PerformanceOverlay";
import { PlayerInfoOverlay } from "./layers/PlayerInfoOverlay";
import { PlayerPanel } from "./layers/PlayerPanel";
import { RailroadLayer } from "./layers/RailroadLayer";
import { mountReplayEndCard } from "./layers/ReplayEndCard";
import { ReplayPanel } from "./layers/ReplayPanel";
import { SAMRadiusLayer } from "./layers/SAMRadiusLayer";
import { SpawnTimer } from "./layers/SpawnTimer";
import { StructureIconsLayer } from "./layers/StructureIconsLayer";
import { StructureLayer } from "./layers/StructureLayer";
import { TeamStats } from "./layers/TeamStats";
import { TerrainLayer } from "./layers/TerrainLayer";
import { TerritoryLayer } from "./layers/TerritoryLayer";
import { mountTradeAttackLanes } from "./layers/TradeAttackLanes";
import { UILayer } from "./layers/UILayer";
import { UnitDisplay } from "./layers/UnitDisplay";
import { UnitLayer } from "./layers/UnitLayer";
import { mountWarRoomToasts } from "./layers/WarRoomToasts";
import { WinModal } from "./layers/WinModal";

export function createRenderer(
  canvas: HTMLCanvasElement,
  game: GameView,
  eventBus: EventBus,
): GameRenderer {
  const transformHandler = new TransformHandler(game, eventBus, canvas);
  const userSettings = new UserSettings();
  // Handed to the GameRenderer so dispose() can undo everything installed
  // here that is not a Layer. See the constructor field for why.
  const broadcastTeardowns: Array<() => void> = [];
  const nativeSpectatorUiEnabled = isAiLeagueNativeSpectatorUiEnabled();
  document.body.classList.toggle(
    "ai-league-native-spectator-ui",
    nativeSpectatorUiEnabled,
  );
  mountAiLeagueNativeSpectatorStyles();
  mountHudVisibilityStyles();

  const uiState: UIState = {
    attackRatio: 20,
    ghostStructure: null,
    overlappingRailroads: [],
    ghostRailPaths: [],
    rocketDirectionUp: true,
  };

  //hide when the game renders
  const startingModal = document.querySelector(
    "game-starting-modal",
  ) as GameStartingModal;
  startingModal.hide();

  // TODO maybe append this to document instead of querying for them?
  const buildMenu = document.querySelector("build-menu") as BuildMenu;
  if (!buildMenu || !(buildMenu instanceof BuildMenu)) {
    console.error("BuildMenu element not found in the DOM");
  }
  buildMenu.game = game;
  buildMenu.eventBus = eventBus;
  buildMenu.uiState = uiState;
  buildMenu.transformHandler = transformHandler;

  const leaderboard = document.querySelector("leader-board") as Leaderboard;
  if (!leaderboard || !(leaderboard instanceof Leaderboard)) {
    console.error("LeaderBoard element not found in the DOM");
  }
  leaderboard.eventBus = eventBus;
  leaderboard.game = game;

  // SUPERSEDE, don't stack. Both broadcast nodes below are CREATED here rather
  // than queried from the document, and an in-place rewind runs this function
  // again without a page reload — so without this sweep a rewind left the
  // previous match's scorebug and identity plate painted underneath the new
  // ones, frozen on their final values, and NationDossier.layout() docked
  // itself to the stale scorebug. dispose() removes them on teardown; this
  // covers the re-entry path.
  document.querySelector("leader-board.ai-league-native-leaderboard")?.remove();
  document.getElementById("pw-board-identity")?.remove();

  const nativeSpectatorLeaderboard = nativeSpectatorUiEnabled
    ? (document.createElement("leader-board") as Leaderboard)
    : null;
  if (nativeSpectatorLeaderboard !== null) {
    nativeSpectatorLeaderboard.eventBus = eventBus;
    nativeSpectatorLeaderboard.game = game;
    nativeSpectatorLeaderboard.visible = true;
    // Broadcast scorebug: seat colour chips bound to the map, the name track
    // free to use real width, and the whole field visible. The expander is
    // pointer-events:none on this instance, so "top 5 + a + button" would be a
    // dead end for a viewer — 11 of 16 players unreachable.
    nativeSpectatorLeaderboard.broadcast = true;
    nativeSpectatorLeaderboard.maxRows = 16;
    Object.assign(nativeSpectatorLeaderboard.style, {
      position: "fixed",
      top: "16px",
      left: "16px",
      zIndex: "50002",
      // DOCKED INTO THE BAND, not floated over the board. --pw-band-left is
      // published by TransformHandler.centerAll() from the real letterbox
      // geometry, so this tracks the board at every viewport instead of being
      // hand-tuned for one. The fallback matches 1280x720.
      //
      // One rule covers both cases: ~292px of rail at 1280x720, collapsing to
      // ~134px at the 640x360 embed floor, where there is no band to dock into
      // and the rail must get out of the board's way.
      // Allowed a little past the band edge: the board's outer margin is open
      // ocean, so a small overlap costs nothing and buys the name column real
      // width. Strictly clamping to the band starved it.
      width: "min(440px, max(300px, calc(var(--pw-band-left, 316px) + 24px)))",
    });
    nativeSpectatorLeaderboard.classList.add("ai-league-native-leaderboard");
    nativeSpectatorLeaderboard.style.pointerEvents = "none";
    document.body.appendChild(nativeSpectatorLeaderboard);

    // THE BOARD IDENTIFIES ITSELF. Two failures this chip closes at once:
    // a viewer who "doesn't even know what map I'm on" (the game is never
    // named mid-match — an audit defect), and an entire review round spent
    // grading the WRONG viewer because nothing on screen said which build
    // was rendering. Map · seats · build stamp, bottom-right, out of every
    // lane. The stamp is the datestamped bundle marker — if you can't see
    // it, you are not looking at this build.
    const identityChip = document.createElement("div");
    identityChip.id = "pw-board-identity";
    const mapName = game
      .config()
      .gameConfig()
      .gameMap.replace(/([a-z])([A-Z])/g, "$1 $2")
      .toUpperCase();
    const seats =
      game.config().gameConfig().maxPlayers ?? game.playerViews().length;
    // NAME THE PREMISE. A first-encounter study watched this for five minutes
    // and never worked out that the sixteen colours are AI AGENTS — which is
    // the entire product. The sentence that says so already existed, in the
    // premiere overlay's header, on an element this skin parks at
    // left:-20000px; the only thing a viewer could actually read said
    // "16 SEATS", which describes a lobby, not a competition between policies.
    //
    // So the plate leads with what this IS: the map, that these are agents,
    // and how many decisions they made — the last being the number that says
    // whether the agents really played it (see ReplayIntegrityStore). The
    // build stamp stays, because grading the wrong build cost a whole review
    // round once, but it goes last where it belongs.
    const integrity = replayIntegrity();
    const decisions =
      integrity === null
        ? null
        : translateText(
            "ai_league_replay.identity_decisions",
            { count: integrity.decisions },
            `${integrity.decisions.toLocaleString()} DECISIONS`,
          );
    identityChip.textContent = [
      mapName,
      translateText(
        "ai_league_replay.identity_agents",
        { count: seats },
        `${seats.toLocaleString()} AI AGENTS`,
      ),
      decisions,
      translateText(
        "ai_league_replay.identity_revision",
        { revision: PW_BROADCAST_REV },
        `BROADCAST r${PW_BROADCAST_REV}`,
      ),
    ]
      .filter((part) => part !== null)
      .join(" · ");
    Object.assign(identityChip.style, {
      position: "fixed",
      right: "14px",
      // Sits on the band's top edge (86px, see BroadcastScrubber) + 8px of
      // air. It used to be at 58px, INSIDE the band — invisible while the
      // transport was docked to the map's letterbox and only overlapped its
      // right end, but the transport now spans the full frame and the plate
      // would sit on the territory-race graph. The toast stack starts above
      // it at 125px.
      bottom: "94px",
      zIndex: "50003",
      pointerEvents: "none",
      // The plate is an eyebrow — it names the frame, it is not content — so
      // it takes the shared recipe rather than its fourth private spelling of
      // it (it was 700 9px/1.4 at 0.14em with the ink hex inlined). The body
      // class and the stylesheet are both installed above, at the top of
      // createRenderer, so these resolve; the fallbacks are the previous
      // literals in case this plate is ever built outside that path.
      padding: "var(--pw-s-xs, 4px) var(--pw-s-md, 8px)",
      font: "var(--pw-eyebrow, 700 9px/1.2 'Avenir Next', system-ui, sans-serif)",
      letterSpacing: "var(--pw-eyebrow-track, 0.16em)",
      color: "var(--pw-eyebrow-ink, #6f675d)",
      background: "rgba(24, 20, 17, 0.7)",
      border: "1px solid rgba(242, 236, 226, 0.1)",
      borderRadius: "3px",
    });
    document.body.appendChild(identityChip);
    mountFirstWatchHint(broadcastTeardowns);
  }

  // Competitor rail one-shot camera locate — every spectator/replay route
  // (`isReplaySpectatorView()`: premiere, ai-league-replay, proxywar-replay,
  // legacy openfront-replay, Coworld routes), not just the promo UI.
  // Renders no UI of its own (a Competitors panel click resolves and
  // recenters once; no persisted "followed" selection, no dimming, no
  // leaderboard pin), so there is nothing to append to the DOM here.
  if (isReplaySpectatorView()) {
    // The EventBus outlives an in-place replay rewind. Retaining the disposer
    // prevents the old bridge from issuing a second, stale camera fit after a
    // replacement renderer takes ownership.
    broadcastTeardowns.push(installCompetitorLocateBridge(game, eventBus));
    // Right-click a nation to follow it. Nothing on this surface moves the
    // camera on its own; a follow is what opts the viewer into the nuke
    // cinema's punch-in. See FollowedCompetitor for why right-click is the
    // only gesture available here.
    // KEEP THE DISPOSER. Discarding it left three handlers on the
    // page-lifetime EventBus (ContextMenuEvent, MouseUpEvent, InputTouchEvent)
    // pointing at a torn-down GameView after the viewer left the replay. Worse
    // than the leak: EventBus.emit iterates handlers with no try/catch, and
    // these were registered BEFORE the live ClientGameRunner's own
    // MouseUpEvent handler, so a throw from a stale one — game.ref() on
    // out-of-range coordinates when the next map is smaller — would have
    // swallowed the live player's click entirely.
    broadcastTeardowns.push(
      installFollowedCompetitor(game, eventBus, transformHandler),
    );
  }

  const gameLeftSidebar = document.querySelector(
    "game-left-sidebar",
  ) as GameLeftSidebar;
  if (!gameLeftSidebar || !(gameLeftSidebar instanceof GameLeftSidebar)) {
    console.error("GameLeftSidebar element not found in the DOM");
  }
  gameLeftSidebar.game = game;
  gameLeftSidebar.eventBus = eventBus;

  const teamStats = document.querySelector("team-stats") as TeamStats;
  if (!teamStats || !(teamStats instanceof TeamStats)) {
    console.error("TeamStats element not found in the DOM");
  }
  teamStats.eventBus = eventBus;
  teamStats.game = game;

  const controlPanel = document.querySelector("control-panel") as ControlPanel;
  if (!(controlPanel instanceof ControlPanel)) {
    console.error("ControlPanel element not found in the DOM");
  }
  controlPanel.eventBus = eventBus;
  controlPanel.uiState = uiState;
  controlPanel.game = game;

  const eventsDisplay = document.querySelector(
    "events-display",
  ) as EventsDisplay;
  if (!(eventsDisplay instanceof EventsDisplay)) {
    console.error("events display not found");
  }
  eventsDisplay.eventBus = eventBus;
  eventsDisplay.game = game;
  eventsDisplay.uiState = uiState;

  const attacksDisplay = document.querySelector(
    "attacks-display",
  ) as AttacksDisplay;
  if (!(attacksDisplay instanceof AttacksDisplay)) {
    console.error("attacks display not found");
  }
  attacksDisplay.eventBus = eventBus;
  attacksDisplay.game = game;
  attacksDisplay.uiState = uiState;

  const chatDisplay = document.querySelector("chat-display") as ChatDisplay;
  if (!(chatDisplay instanceof ChatDisplay)) {
    console.error("chat display not found");
  }
  chatDisplay.eventBus = eventBus;
  chatDisplay.game = game;

  const playerInfo = document.querySelector(
    "player-info-overlay",
  ) as PlayerInfoOverlay;
  if (!(playerInfo instanceof PlayerInfoOverlay)) {
    console.error("player info overlay not found");
  }
  playerInfo.eventBus = eventBus;
  playerInfo.transform = transformHandler;
  playerInfo.game = game;

  const winModal = document.querySelector("win-modal") as WinModal;
  if (!(winModal instanceof WinModal)) {
    console.error("win modal not found");
  }
  winModal.eventBus = eventBus;
  winModal.game = game;

  const replayPanel = document.querySelector("replay-panel") as ReplayPanel;
  if (!(replayPanel instanceof ReplayPanel)) {
    console.error("replay panel not found");
  }
  replayPanel.eventBus = eventBus;
  replayPanel.game = game;

  const gameRightSidebar = document.querySelector(
    "game-right-sidebar",
  ) as GameRightSidebar;
  if (!(gameRightSidebar instanceof GameRightSidebar)) {
    console.error("Game Right bar not found");
  }
  gameRightSidebar.game = game;
  gameRightSidebar.eventBus = eventBus;

  const unitDisplay = document.querySelector("unit-display") as UnitDisplay;
  if (!(unitDisplay instanceof UnitDisplay)) {
    console.error("unit display not found");
  }
  unitDisplay.game = game;
  unitDisplay.eventBus = eventBus;
  unitDisplay.uiState = uiState;

  const playerPanel = document.querySelector("player-panel") as PlayerPanel;
  if (!(playerPanel instanceof PlayerPanel)) {
    console.error("player panel not found");
  }
  playerPanel.g = game;
  playerPanel.initEventBus(eventBus);
  playerPanel.transformHandler = transformHandler;

  const chatModal = document.querySelector("chat-modal") as ChatModal;
  if (!(chatModal instanceof ChatModal)) {
    console.error("chat modal not found");
  }
  chatModal.g = game;
  chatModal.initEventBus(eventBus);

  const multiTabModal = document.querySelector(
    "multi-tab-modal",
  ) as MultiTabModal;
  if (!(multiTabModal instanceof MultiTabModal)) {
    console.error("multi-tab modal not found");
  }
  multiTabModal.game = game;

  const headsUpMessage = document.querySelector(
    "heads-up-message",
  ) as HeadsUpMessage;
  if (!(headsUpMessage instanceof HeadsUpMessage)) {
    console.error("heads-up message not found");
  }
  headsUpMessage.game = game;

  const structureLayer = new StructureLayer(game, eventBus, transformHandler);
  const samRadiusLayer = new SAMRadiusLayer(game, eventBus, uiState);

  const performanceOverlay = document.querySelector(
    "performance-overlay",
  ) as PerformanceOverlay;
  if (!(performanceOverlay instanceof PerformanceOverlay)) {
    console.error("performance overlay not found");
  }
  performanceOverlay.eventBus = eventBus;
  performanceOverlay.userSettings = userSettings;

  const alertFrame = document.querySelector("alert-frame") as AlertFrame;
  if (!(alertFrame instanceof AlertFrame)) {
    console.error("alert frame not found");
  }
  alertFrame.game = game;

  const spawnTimer = document.querySelector("spawn-timer") as SpawnTimer;
  if (!(spawnTimer instanceof SpawnTimer)) {
    console.error("spawn timer not found");
  }
  spawnTimer.game = game;
  spawnTimer.eventBus = eventBus;
  spawnTimer.transformHandler = transformHandler;

  const immunityTimer = document.querySelector(
    "immunity-timer",
  ) as ImmunityTimer;
  if (!(immunityTimer instanceof ImmunityTimer)) {
    console.error("immunity timer not found");
  }
  immunityTimer.game = game;
  immunityTimer.eventBus = eventBus;

  const inGamePromo = document.querySelector("in-game-promo") as InGamePromo;
  if (!(inGamePromo instanceof InGamePromo)) {
    console.error("in-game promo not found");
  }
  inGamePromo.game = game;

  // When updating these layers please be mindful of the order.
  // Try to group layers by the return value of shouldTransform.
  // Not grouping the layers may cause excessive calls to context.save() and context.restore().
  const layers: Layer[] = [
    new TerrainLayer(game, transformHandler),
    new TerritoryLayer(game, eventBus, transformHandler),
    new RailroadLayer(game, eventBus, transformHandler, uiState),
    new CoordinateGridLayer(game, eventBus, transformHandler),
    structureLayer,
    samRadiusLayer,
    // Commerce vs invasion, drawn on the water beneath the ships themselves:
    // 219 boat attacks in this fixture against 12 nukes, and until now a trade
    // ship and a troop transport looked identical.
    ...mountTradeAttackLanes(game, transformHandler),
    new UnitLayer(game, eventBus, transformHandler),
    new FxLayer(game, eventBus, transformHandler),
    new UILayer(game, eventBus, transformHandler),
    new NukeTrajectoryPreviewLayer(game, eventBus, transformHandler, uiState),
    // Broadcast nuke cinema: alert, target reticle, punch-in, impact flash.
    // Drawn after FxLayer so the shockwave rings sit over the sprite blast it
    // frames. Self-gates on the replay route; returns [] live.
    ...mountNukeCinema(game, eventBus, transformHandler),
    new StructureIconsLayer(game, eventBus, uiState, transformHandler),
    new DynamicUILayer(game, transformHandler, eventBus),
    new NameLayer(game, transformHandler, eventBus),
    new AttackingTroopsOverlay(game, transformHandler, eventBus, userSettings),
    eventsDisplay,
    attacksDisplay,
    chatDisplay,
    buildMenu,
    spawnTimer,
    immunityTimer,
    leaderboard,
    ...(nativeSpectatorLeaderboard !== null
      ? [nativeSpectatorLeaderboard]
      : []),
    gameLeftSidebar,
    unitDisplay,
    gameRightSidebar,
    controlPanel,
    playerInfo,
    winModal,
    // Replay end-card: the designed replacement for win-modal on the broadcast
    // surface (win-modal is CSS-hidden there — it carries a store upsell and
    // live-game navigation). Self-gates on the replay route; returns [] live.
    ...mountReplayEndCard(game),
    // The transport a viewer can actually drive, and the beat feed as arriving
    // news rather than a standing card. Both replace hidden incumbents; both
    // self-gate on the replay route and return [] live.
    ...mountBroadcastScrubber(game),
    ...mountWarRoomToasts(game),
    // Hovering a nation's name in a toast lights that nation's border on the
    // map. Mounted AFTER the board layers so the outline draws over territory,
    // and before the HUD, which is DOM and not on this canvas at all.
    ...mountBroadcastSpotlight(game),
    // The dossier for whichever nation the viewer clicked. Renders nothing at
    // all until one is followed.
    ...mountNationDossier(game, eventBus, transformHandler),
    // The sampled decision log as a minimized right-edge drawer — the owner's
    // "only revealed if wanted". Self-gates on route + native skin.
    ...mountAnalystDrawer(),
    replayPanel,
    teamStats,
    playerPanel,
    // P0 fix (2026-08-03): dropped from this array as collateral during the
    // identity/account refactor. Nothing in that refactor's intent mentions
    // HeadsUpMessage; the removal was an oversight, not a decision. Without
    // this, tick()/init() never ran for it at all --
    // spawn/pause/immunity/catching-up status messages, AND item 3a's
    // (deploy 3.9) match-end combat-toast suppression, were silently inert.
    headsUpMessage,
    alertFrame,
    performanceOverlay,
  ];

  return new GameRenderer(
    game,
    eventBus,
    canvas,
    transformHandler,
    uiState,
    layers,
    performanceOverlay,
    broadcastTeardowns,
  );
}

/**
 * ONE SENTENCE, ONCE — the difference between a screen recording and a product.
 *
 * A first-encounter study spent five minutes here and never discovered that
 * clicking a nation opens its dossier: the agent's own last decision and its
 * stated plan, which is the most interesting thing this broadcast has. The
 * capability was there the whole time with nothing inviting it, and a viewer
 * cannot discover a gesture that leaves no trace when they do not make it.
 *
 * Deliberately small: it appears once per session, it leaves on the first
 * click anywhere on the board (the moment it has been obeyed it is clutter),
 * and it times out on its own for a viewer who never clicks. sessionStorage
 * rather than localStorage — a returning viewer next week is a first-time
 * viewer again as far as this gesture is concerned, but the same person
 * scrubbing around for an hour should not be told twice.
 */
function mountFirstWatchHint(teardowns: Array<() => void>): void {
  const SEEN_KEY = "pw-first-watch-hint";
  try {
    if (window.sessionStorage.getItem(SEEN_KEY) === "1") return;
    window.sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Private browsing or a blocked storage partition. Showing the hint once
    // per load is a far better failure than never showing it at all.
  }
  const hint = document.createElement("div");
  hint.id = "pw-first-watch-hint";
  hint.textContent = translateText(
    "ai_league_replay.first_watch_hint",
    undefined,
    "Click any nation to follow it",
  );
  document.body.appendChild(hint);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    hint.dataset.leaving = "1";
    window.setTimeout(() => hint.remove(), 400);
    document.removeEventListener("pointerdown", onBoardClick, true);
    window.clearTimeout(timer);
  };
  const onBoardClick = (event: PointerEvent) => {
    // Only a click on the BOARD counts as "understood". Pressing play or
    // dragging the transport is not the gesture this is teaching.
    const target = event.target as HTMLElement | null;
    if (target !== null && target.tagName === "CANVAS") remove();
  };
  document.addEventListener("pointerdown", onBoardClick, true);
  const timer = window.setTimeout(remove, 9000);
  teardowns.push(() => {
    window.clearTimeout(timer);
    document.removeEventListener("pointerdown", onBoardClick, true);
    hint.remove();
  });
}

/**
 * Build revision stamped onto the board identity chip. Bump on every bundle
 * rebuild that changes something visible, so "which build am I looking at"
 * is answered by the frame itself, never by guesswork.
 */
const PW_BROADCAST_REV = 85;

/**
 * Whether the warm broadcast stage applies. Read from the body class the
 * spectator mode sets, so the renderer never has to re-derive the route and
 * the live game can never take this branch.
 */
function nativeSpectatorStageEnabled(): boolean {
  return document.body.classList.contains("ai-league-native-spectator-ui");
}

/**
 * Style sheet backing the sidebar's "hide interface" toggle: with
 * HUD_HIDDEN_BODY_CLASS on <body>, every HUD element disappears except
 * game-right-sidebar, which renders only its restore button in that mode.
 */
function mountHudVisibilityStyles() {
  if (document.getElementById("proxywar-hud-visibility-styles") !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = "proxywar-hud-visibility-styles";
  style.textContent = `
    body.${HUD_HIDDEN_BODY_CLASS} :is(
      attacks-display, control-panel, unit-display, chat-display,
      events-display, build-menu, win-modal, player-panel, spawn-timer,
      immunity-timer, in-game-promo, alert-frame, chat-modal, multi-tab-modal,
      game-left-sidebar, player-info-overlay, leader-board, team-stats,
      heads-up-message, replay-panel, performance-overlay,
      #pw-board-identity, #pw-first-watch-hint, .pw-scrubber, .pw-toasts,
      .pw-analyst, .pw-dossier, #ai-league-replay-overlay,
      #ai-league-social-transcript, #ai-league-headline-event,
      #ai-league-lower-third-host, .broadcast-drawer-panel, replay-end-card,
      .pw-nuke-cinema, .pw-following-chip, .pw-rewind-curtain
    ) {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function mountAiLeagueNativeSpectatorStyles() {
  if (document.getElementById("ai-league-native-spectator-styles") !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = "ai-league-native-spectator-styles";
  style.textContent = `
    /* =====================================================================
     * BROADCAST SKIN — art direction lock: "Situation Display"
     *
     * A dark, precisely-lit world under glass in a modern operations centre,
     * where the only saturated things on screen are the sixteen combatants and
     * the fronts between them.
     *
     * The rule that drives every value below: the BOARD owns colour. Territory
     * fills are player identity, so the chrome must never compete with them.
     * Panels are warm near-black glass; the single accent is amber; hazard is
     * the only other hue and it is reserved for eliminations and nukes.
     *
     * Scoped to body.ai-league-native-spectator-ui, which only the replay sets,
     * so the live game is untouched.
     * ===================================================================== */
    body.ai-league-native-spectator-ui {
      /* Warm near-black, never a blue-charcoal default and never pure #000. */
      --pw-stage: #14110f;
      --pw-panel: rgba(24, 20, 17, 0.82);
      --pw-panel-solid: #1a1613;
      --pw-hairline: rgba(242, 236, 226, 0.11);
      --pw-ink: #f2ece2;
      --pw-ink-dim: #a79e92;
      --pw-ink-faint: #6f675d;
      --pw-accent: #ffc24a;
      --pw-hazard: #ff6b4a;
      --pw-live: #7fd4a3;
      --pw-display: "Avenir Next", "Futura", system-ui, sans-serif;
      --pw-num: ui-monospace, "SF Mono", Menlo, monospace;

      /* ---- TYPE SCALE -----------------------------------------------------
       * Six steps, and a step exists only if it does hierarchic work at a
       * glance. This surface shipped 22 sizes, eleven of them between 8 and
       * 13px in half-pixel increments: a 5.5% difference at 9px is not a
       * level, it is noise, and a viewer parsing a live board has no time to
       * resolve it. What each step is FOR:
       *
       *   micro   - it LABELS, it does not speak. Uppercase eyebrows, turn
       *             stamps, column headers, severity flags. Never a sentence.
       *   label   - the densest thing a viewer actually READS: standings rows,
       *             row metadata, the quoted reason under a headline. Rank
       *             INSIDE this step is carried by weight and ink, not size -
       *             that is the whole reason 10.5 / 11 / 11.5 could collapse
       *             into one rung without losing a distinction.
       *   body    - the sentence register. One beat, stated once, in prose: a
       *             toast headline, a line of narration.
       *   subhead - THE STEP THIS SURFACE WAS MISSING. Everything was either
       *             an 8-10px cap or the end card's hero, so a nation name in
       *             a panel had nowhere to sit and got set as a label. This is
       *             "read it from the sofa, but it is not the finale": panel
       *             titles, nation names, a verdict line.
       *   figure  - a NUMBER that has to win its own tile: the headline share
       *             on a dossier, a metric on the end card. Tabular, --pw-num.
       *   hero    - the finale only. One per frame, only on the end card.
       *
       * Ratios run ~1.2 through the reading sizes, where several steps must
       * coexist inside one small panel without shouting at each other, and
       * ~1.35 through the display sizes, where the step IS the shout. The
       * 13 -> 18 gap is the widest on purpose: it is the seam between "text in
       * a panel" and "type on a stage", and nothing should land inside it.
       *
       * Snapping rule for anything still carrying a one-off: move it to the
       * NEAREST rung. Do not add a rung. The two things that may keep an
       * off-scale size are (a) overrides inside the 640x360 embed-floor media
       * queries, which exist to survive a frame this scale was not authored
       * for, and (b) a value whose comment records a measurement.
       *
       * subhead / figure / hero have no consumer IN THIS FILE — nothing here
       * is bigger than a toast headline. They are not dead: their consumers
       * are NationDossier (name 19px, figure 26px), NukeCinema and
       * ReplayEndCard (winner name, metric values), which are owned
       * elsewhere and are being migrated onto these rungs. Do not delete them
       * as unused before that lands.
       */
      --pw-type-micro: 9px;
      --pw-type-label: 11px;
      --pw-type-body: 13px;
      --pw-type-subhead: 18px;
      --pw-type-figure: 24px;
      --pw-type-hero: 40px;

      /* ---- THE EYEBROW, ONCE ----------------------------------------------
       * About twenty places on this surface re-invent the uppercase
       * micro-label, at five sizes, two weights and NINE letter-spacings. It
       * is one thing with one job - naming the block beneath it while staying
       * under that block in the reading order - so it is one recipe. A
       * consumer sets font + letter-spacing from these and adds its own
       * text-transform: uppercase.
       *
       * The tracking is not decoration: at 9px, caps set solid close into a
       * grey bar and stop being readable as words. Where a caps string has to
       * fit a MEASURED column instead - the scorebug header, whose
       * "MAX TROOPS" was clipping to "MAX TR." - the tight track is the
       * documented exception, and it is a token so the exception is countable
       * rather than another loose number.
       *
       * Ink here is the DEFAULT, not the rule. Where an eyebrow carries
       * meaning - toast severity, a panel's own title - the accent or hazard
       * colour is the message and overrides this.
       */
      --pw-eyebrow: 700 var(--pw-type-micro) / 1.2 var(--pw-display);
      --pw-eyebrow-track: 0.16em;
      --pw-eyebrow-track-tight: 0.07em;
      --pw-eyebrow-ink: var(--pw-ink-faint);

      /* ---- SPACING --------------------------------------------------------
       * Ten panels shipped ten padding recipes: 22 distinct padding/margin
       * values including 6.5px and 7.5px, plus 11 gap values. One ladder
       * replaces them, and the four rungs that already exist in
       * styles/tokens.css are ALIASED here rather than re-typed, so that
       * family finally has consumers instead of being a dead declaration.
       *
       * It is deliberately not a pure 4px ladder. A broadcast HUD does most of
       * its work between 2 and 12px, and 4px is too coarse a first step to
       * separate a turn stamp from the name beside it - which is exactly how
       * 3px, 5px, 6.5px and 7px got invented one panel at a time. So the
       * bottom of the ladder is 2px-fine and the top is coarse.
       *   hair - separation WITHIN one line of type.
       *   xs   - inside a control, or between a headline and its subordinate.
       *   sm   - between stacked lines that belong to the same thought.
       *   md   - between elements in a card, and between cards in a stack.
       *   lg   - a panel's own inset.
       *   xl   - between regions of a panel.
       *   2xl  - full-frame surfaces only.
       */
      --pw-s-hair: 2px;
      --pw-s-xs: var(--pw-space-1, 4px);
      --pw-s-sm: 6px;
      --pw-s-md: var(--pw-space-2, 8px);
      --pw-s-lg: var(--pw-space-3, 12px);
      --pw-s-xl: var(--pw-space-4, 16px);
      --pw-s-2xl: var(--pw-space-6, 24px);

      background: var(--pw-stage) !important;
    }

    /* THE BOARD IS A CONTROL, so it has to look like one. A first-encounter
     * study spent five minutes on this and never discovered that clicking a
     * nation opens its dossier — the agent's own last decision and stated
     * plan, which is the single most interesting thing the product has. The
     * canvas was cursor:auto, i.e. an arrow, i.e. "this is a picture".
     *
     * A pointer over the whole board is the honest signal: everywhere on it
     * IS clickable (land selects a nation, water clears the selection), so
     * unlike a hover-tested cursor this never promises something that is not
     * there. Panning still works; a drag reads as a drag regardless of the
     * resting cursor. */
    body.ai-league-native-spectator-ui > canvas {
      cursor: pointer;
    }

    /* The first-watch hint. Docked under the board plate at the same right
     * edge so the bottom-right corner reads as one column of chrome, and in
     * the accent because it is the one thing on screen ASKING to be acted on
     * — the only place amber is spent on an instruction rather than on state.
     * Never over the transport: it clears the band's 86px like everything
     * else in that corner. */
    #pw-first-watch-hint {
      position: fixed;
      right: 14px;
      bottom: 125px;
      z-index: 50004;
      pointer-events: none;
      padding: var(--pw-s-sm, 6px) var(--pw-s-lg, 12px);
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      border: 1px solid rgba(255, 194, 74, 0.35);
      border-radius: 3px;
      font: var(--pw-eyebrow, 700 9px/1.2 "Avenir Next", system-ui, sans-serif);
      letter-spacing: var(--pw-eyebrow-track, 0.16em);
      text-transform: uppercase;
      color: var(--pw-accent, #ffc24a);
      animation: pw-hint-in 320ms cubic-bezier(0.2, 0.9, 0.3, 1) 1;
    }
    #pw-first-watch-hint[data-leaving="1"] {
      opacity: 0;
      transition: opacity 380ms ease-in;
    }
    @keyframes pw-hint-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      #pw-first-watch-hint { animation: none; }
    }

    /* THE PERFORMANCE OVERLAY GETS ITS OWN CORNER.
     *
     * It opens top-left at 50% width by default and lands squarely under the
     * scorebug, where it is unreadable and hides the standings behind it. It
     * renders into a SHADOW root, so this sheet cannot reach the panel itself
     * — but the component positions that panel from three custom properties
     * (--top / --left / --transform), and custom properties inherit through a
     * shadow boundary, so the host is a legitimate hook.
     *
     * translateY(-100%) is measured against the element's OWN height, which is
     * what makes this work without knowing how tall the panel is: pin its top
     * to the viewport's bottom edge, then lift it by its full height plus the
     * 94px the transport band occupies. Result: bottom-left, sitting on the
     * band, clear of the scorebug entirely. */
    /* (The panel's opening corner is set by the component itself — see
     * performanceOverlayHome() in PerformanceOverlay.ts. It computes an inline
     * position per render from its own draggable state, so a stylesheet
     * override here would either lose to that inline style or, with
     * !important, break dragging.) */

    body.ai-league-native-spectator-ui game-left-sidebar {
      display: none !important;
    }

    /* THE HUD SCALES WITH THE FRAME. Every panel was authored in fixed pixels
     * against a 1280x720 assumption — but the Observatory embeds this surface
     * at ~900px on the theater stage and ~420px in head-to-head tiles, where a
     * 340px scorebug is a third to three-quarters of the frame. Breakpoints
     * can't fix that; the whole HUD has to shrink in proportion. One factor,
     * derived from the viewport, applied as zoom to every floating panel:
     * 1.0 at >=1280w, shrinking linearly, floored so text never becomes dust.
     * (zoom, not transform: it participates in layout, so the band-docking
     * math keeps meaning something.) */
    body.ai-league-native-spectator-ui {
      --pw-hud-scale: clamp(0.42, calc(100vw / 1280), 1);
    }
    body.ai-league-native-spectator-ui leader-board.ai-league-native-leaderboard,
    body.ai-league-native-spectator-ui #pw-game-control-cluster,
    body.ai-league-native-spectator-ui #ai-league-replay-overlay,
    body.ai-league-native-spectator-ui #ai-league-social-transcript,
    body.ai-league-native-spectator-ui #ai-league-headline-event,
    body.ai-league-native-spectator-ui #ai-league-lower-third-host,
    body.ai-league-native-spectator-ui .broadcast-drawer-panel {
      zoom: var(--pw-hud-scale);
    }

    /* --- Scorebug ------------------------------------------------------- */
    body.ai-league-native-spectator-ui leader-board.ai-league-native-leaderboard {
      background: var(--pw-panel) !important;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid var(--pw-hairline) !important;
      border-radius: 9px !important;
      overflow: hidden;
      font-family: var(--pw-display) !important;
    }
    /*
     * NOTE ON SELECTORS: Leaderboard.ts renders NO table elements — it is a
     * CSS grid of <div class="contents"> rows. Styling th/td here matches
     * nothing and fails silently, which is exactly how a "restyle" can look
     * applied in the source and be invisible on screen.
     */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .grid {
      background: transparent !important;
      border-radius: 0 !important;
      /* THE CARD'S HORIZONTAL INSET, and it belongs to the GRID BOX, not to
       * the cells. Once the numeric tracks were right-aligned, the last column
       * had nothing between its figures and the panel border, so 934K / 1.08M
       * / 495K sat flush against the glass and the card read as if it were
       * clipping itself. One token now sets both edges, so the left inset and
       * the right inset are the same number by construction rather than by
       * coincidence.
       *
       * WHY THE CONTAINER AND NOT THE LAST CELL — three traps, in order:
       *   1. The row wrapper is display:contents. It has no box, so padding on
       *      it does nothing (this sheet already documents that trap for
       *      opacity and for pointer-events). The container is a real box.
       *   2. Cell padding would come out of a FIXED track. The last track is
       *      minmax(0, 62px) and it is 62 rather than 52 for one measured
       *      reason: "MAX TROOPS" is the longest string on the card and
       *      clipped to "MAX TROO..." at 52px. At the header's 8px/0.07em that
       *      label measures ~54px in mono and ~58px in the display face — so a
       *      6px inset taken out of the cell re-opens a bug that was closed on
       *      purpose. Container padding comes out of the 1fr NAME track
       *      instead and leaves every fixed track untouched, so the header
       *      keeps the slack it was given.
       *   3. The vertical rhythm is set by padding-top/padding-bottom
       *      !important on .contents > div, and dead rows override those with
       *      their own !important (Leaderboard.cellStyle). These are
       *      padding-left/right longhands on a different element, so they
       *      neither disturb that rhythm nor get beaten by it.
       *
       * Header and figures share one right edge automatically: both live in
       * the same 62px track and both take text-align: right from the rule
       * below, which is not scoped away from the header row.
       *
       * The cost is 2 x the inset off the name column (114px -> 102px at the
       * 300px narrow-band rail). That is the correct thing to spend it on:
       * the name track is minmax(0, 1fr) precisely so it absorbs slack.
       */
      padding-left: var(--pw-s-sm) !important;
      padding-right: var(--pw-s-sm) !important;
    }
    /* Row cells. The header row carries .font-bold, so it is addressable
     * separately without needing a hook the component doesn't emit. */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .contents > div {
      color: var(--pw-ink-dim) !important;
      border-color: var(--pw-hairline) !important;
      /* The standings row is the densest thing on the stage a viewer really
       * reads, so it sits on the LABEL rung (was 12px, a rung that existed
       * only here). Losing a pixel also buys the five tracks back some room
       * in a 300px rail - see the width note below. */
      font-size: var(--pw-type-label) !important;
      padding-top: var(--pw-s-sm) !important;
      padding-bottom: var(--pw-s-sm) !important;
    }
    /* Eyebrow header: uppercase, letterspaced, recessive. It labels; it is not
     * content, so it must not read at a player's weight. */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .contents.font-bold {
      background: transparent !important;
    }
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .contents.font-bold > div {
      color: var(--pw-eyebrow-ink) !important;
      font: var(--pw-eyebrow) !important;
      letter-spacing: var(--pw-eyebrow-track) !important;
      text-transform: uppercase !important;
    }
    /* Numbers tabular so columns align and a rank change reads as MOVEMENT
     * rather than reflow (L44: mono restricted to numbers, never prose). */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .contents > div:nth-child(1),
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .contents > div:nth-child(n + 3) {
      font-family: var(--pw-num) !important;
      font-variant-numeric: tabular-nums;
      /* RIGHT-ALIGNED, because tabular figures centred are not aligned at all.
       * The component centres every cell, so "34.1%" and "0.3%" had right
       * edges 4px apart and decimal points 4px apart — and both move every
       * tick as the values change width, which is the opposite of what
       * tabular numerals are for. The end card already right-aligns the same
       * data; this makes the scorebug agree with it. Names stay left, where
       * the eye starts reading. */
      text-align: right !important;
    }
    /* THE LEADER WINS THE SQUINT TEST. A table's promise is that every row is
     * equal; a broadcast's job is the exact opposite.
     *
     * The wash used to be positional — nth-of-type(2), i.e. whoever happened to
     * be drawn first. The CROWN is placed on the hysteresis-confirmed leader
     * instead, so during the 100-turn hold that the lead tracker exists to
     * provide, the washed row and the crowned row were two DIFFERENT nations
     * and the scorebug asserted two leaders at once. It is now painted from the
     * same crowned field the crown reads (Leaderboard.cellStyle), so they
     * cannot disagree. Sorting by another column would have broken the
     * positional rule outright, which is the second reason it had to go. */
    /* The component paints its own slate over the panel; these are the
     * hardcoded Tailwind utilities that would otherwise win. */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .bg-gray-800\\/85,
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .bg-gray-700\\/60 {
      background: transparent !important;
    }
    /* 16 rows need room; the component caps itself at 35-50vh and would
     * internally scroll, clipping the bottom seats. */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .max-h-\\[35vh\\],
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .md\\:max-h-\\[50vh\\] {
      max-height: none !important;
    }

    /* COMPACT SCOREBUG. Below the full broadcast rail, the map needs the
     * horizontal space more than it needs two secondary economy columns.
     * Rank, identity, and territory share remain visible; GOLD and MAX TROOPS
     * return at 981px with the full five-track table. A viewport-relative
     * width replaces the old fixed-width + transform stack, whose physical
     * footprint jumped from 27% to 34% as the iframe narrowed.
     *
     * Keep this rule on semantic column hooks rather than nth-child selectors:
     * the grid is display:contents rows, and a future column insertion must
     * not silently hide the wrong data. */
    @media (max-width: 980px) {
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard {
        width: clamp(142px, 24vw, 220px) !important;
        top: clamp(8px, 1.1vw, 12px) !important;
        left: clamp(8px, 1.1vw, 12px) !important;
        transform: none !important;
        zoom: 1 !important;
      }
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard .grid {
        grid-template-columns:
          minmax(18px, 22px) minmax(0, 1fr) minmax(40px, 46px) !important;
      }
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard > .mt-2 {
        margin-top: var(--pw-s-xs) !important;
      }
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard
        [data-scorebug-column="gold"],
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard
        [data-scorebug-column="max-troops"] {
        display: none !important;
      }
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard
        [data-scorebug-margin] {
        display: none !important;
      }
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard .contents > div {
        font-size: 10px !important;
        padding-top: 2px !important;
        padding-bottom: 2px !important;
      }
    }

    /* WIDE (2:1) MAPS: the board is near-full-bleed and there is almost no
     * band, so the scorebug becomes an OVERLAY rather than something docked
     * beside the board. It still carries the FULL table.
     *
     * r31 shrank it here to rank/seat/name/share on the argument that an
     * overlay "must earn its pixels", dropping GOLD and MAX TROOPS. Two things
     * were wrong with that. It silently scrambled the table for months (see
     * the track-count note below). And it was the wrong call regardless:
     * economy and army size are how you read whether a leader is actually
     * winning or just holding ground, and the owner asked for them back.
     *
     * The rail is widened instead, to fit all five tracks (26+122+52+46+52 =
     * 298px of content) rather than dropping two of them. Only >=981px is
     * affected; the 640x360 embed floor has its own narrower treatment. */
    @media (min-width: 981px) {
      body.ai-league-native-spectator-ui.pw-narrow-band
        leader-board.ai-league-native-leaderboard {
        width: 300px !important;
        background: rgba(24, 20, 17, 0.72) !important;
      }
    }

    /* THE EXPANDER IS A DEAD CONTROL HERE. Leaderboard.ts renders a +/- button
     * that toggles showTopFive, but the broadcast instance is built with
     * maxRows=16 (every competitor already visible) and is pointer-events:none,
     * so it cannot be clicked and would have nothing to do if it could. It read
     * as an "add player" affordance on a replay, which is not a thing that
     * exists. It is the only <button> inside this element. */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard button {
      display: none !important;
    }

    /* ===================================================================
     * THREE INCUMBENT SURFACES STAND DOWN
     * ===================================================================
     * All hidden, never removed: each is still the SOURCE its replacement
     * reads from. Deleting them would mean re-deriving "what happened when" a
     * second time, and two derivations drift.
     *
     * 1. THE OVERLAY SHELL. Its .ai-league-body is already display:none, so
     *    what remained on screen was a 66px header of Analyst mode / Radio /
     *    Reset / Hide pills above an empty card — controls for a panel that is
     *    not there.
     * 2. THE WAR ROOM PANEL -> WarRoomToasts. It covered the right 23% of the
     *    board and its newest row sat underneath the transport cluster, so the
     *    clock was permanently parked on the most recent beat.
     * 3. THE TIMELINE PANEL -> BroadcastScrubber. 195 markers, 6 visible, no
     *    playhead, no drag: six reachable points in 14,200 turns.
     *
     * Parked off-screen rather than display:none so their layout still
     * resolves and the harvesters can read position/turn values out of them.
     *
     * THIS BLOCK HAS BEEN DELETED ONCE ALREADY, by a careless region replace
     * while restoring the scorebug columns, which brought the war-room card
     * and the dead toolbar straight back onto the board. If you are editing
     * anything between the scorebug rules and here, check this survived.
     *
     * 0.1.42 STATUS: none of these three elements is mounted on the static
     * replay route any more. Upstream deleted AiLeagueReplayOverlay.ts, and
     * with it the only code that ever put #ai-league-replay-overlay,
     * .broadcast-war-room or .broadcast-timeline into this document —
     * BroadcastComposition still emits them, but only ReplayPremiereOverlay /
     * ReplayPremiereRuntime mount it, and neither is on this route. The rules
     * are kept because they cost nothing, they are still correct if a premiere
     * surface is ever composed into this stage, and the harvesters
     * (WarRoomToasts, BroadcastScrubber, LullDirector) still query for those
     * exact classes and simply find nothing. */
    body.ai-league-native-spectator-ui #ai-league-replay-overlay,
    body.ai-league-native-spectator-ui .broadcast-war-room,
    body.ai-league-native-spectator-ui .broadcast-timeline {
      position: fixed !important;
      left: -20000px !important;
      top: 0 !important;
      width: 320px !important;
      max-width: 320px !important;
      opacity: 0 !important;
      pointer-events: none !important;
      z-index: -1 !important;
    }
    /* A modal backdrop was found covering the entire frame (fixed inset-0,
     * bg-black/30, backdrop-blur) with nothing open behind it — dimming and
     * blurring the whole board for no reason a viewer could act on. */
    body.ai-league-native-spectator-ui > div.fixed.inset-0[class*="backdrop-blur"] {
      display: none !important;
    }

    /* THE LOWER THIRD IS A DUPLICATE. #ai-league-headline-event announces the
     * same beats the toasts do, in the same seconds, in a second place — and
     * it is the auto-dismissing banner L59 already objected to. It also
     * collides with the toast stack, which clips it mid-sentence. One feed,
     * one location. (Deleted once by the same careless region replace that
     * took out the stand-down block above; check it survived.) */
    body.ai-league-native-spectator-ui #ai-league-headline-event {
      display: none !important;
    }

    /* ONE PILL. The transport cluster was TWO conflicting containers stacked:
     * the skin's warm 999px pill (rgba(24,20,17,.82)) wrapping the stock
     * cluster's cool-slate 8px rounded rect (aside.bg-glass, rgba(17,23,32,
     * .92)) — measured live after the owner flagged "2 pill designs
     * conflicting". The inner one stands down entirely; the outer pill is the
     * container. The divider hairline warms to the house ink. */
    /* Symmetric, tight: the owner flagged excess bottom padding — the pill
     * carried stock spacing below the aside while items sat high. Explicit
     * 4px all round; the aside's own py-2 px-3 is the interior rhythm. */
    body.ai-league-native-spectator-ui #pw-game-control-cluster {
      padding: var(--pw-s-xs) !important;
    }
    /* THE PILL'S EXTRA BOTTOM SPACE, MEASURED AT LAST.
     *
     * Reported three times as "too much space at the bottom", and twice I
     * adjusted padding — which was never the cause. The cluster is a flex
     * COLUMN with an 8px gap and TWO children: the control row, and a
     * replay-panel that renders completely empty on this surface (its only
     * child nodes are Lit's comment markers). Two pixels of nothing, dragging
     * an 8px gap behind it: the pill measured 70px tall around 50px of
     * content, 5px of air above and 15px below.
     *
     * :empty rather than a blanket hide, because :empty ignores comment nodes
     * (verified against the live element) and self-corrects — if this panel
     * ever renders something, it comes back and its gap comes back with it.
     * The art lock's rule that panels never render empty, enforced in CSS. */
    body.ai-league-native-spectator-ui
      #pw-game-control-cluster
      replay-panel:empty {
      display: none !important;
    }
    body.ai-league-native-spectator-ui #pw-game-control-cluster aside {
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    body.ai-league-native-spectator-ui #pw-game-control-cluster aside span[class*="bg-white"] {
      background: rgba(242, 236, 226, 0.14) !important;
    }

    /* --- War Room feed --------------------------------------------------- */
    body.ai-league-native-spectator-ui .broadcast-drawer,
    body.ai-league-native-spectator-ui [data-ai-league-broadcast-drawer] > * {
      background: var(--pw-panel) !important;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-color: var(--pw-hairline) !important;
      border-radius: 9px !important;
      font-family: var(--pw-display) !important;
    }
    body.ai-league-native-spectator-ui .broadcast-war-room-heading,
    body.ai-league-native-spectator-ui .broadcast-rail-heading {
      color: var(--pw-eyebrow-ink) !important;
      font: var(--pw-eyebrow) !important;
      letter-spacing: var(--pw-eyebrow-track) !important;
      text-transform: uppercase !important;
    }
    /* Beat kinds carry the only non-amber hue in the chrome, and only the two
     * that are genuinely violent get it. */
    body.ai-league-native-spectator-ui [class*="elimination"],
    body.ai-league-native-spectator-ui [class*="nuke"] {
      color: var(--pw-hazard) !important;
    }

    /* --- Transport ------------------------------------------------------- */
    body.ai-league-native-spectator-ui #pw-game-control-cluster,
    body.ai-league-native-spectator-ui replay-panel {
      background: var(--pw-panel) !important;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid var(--pw-hairline) !important;
      border-radius: 999px !important;
      font-family: var(--pw-num) !important;
    }

    /* --- ONE colour system ------------------------------------------------
     * The aesthetic gate pixel-sampled the frame and found two design systems
     * on screen: the scorebug/stage were on-lock warm, but the drawer panels,
     * cards, tabs and cluster were still stock slate (#0a0e14/#18202b/#3a4656)
     * because the earlier skin targeted classes those components don't use.
     * These are the REAL class names from BroadcastComposition.ts.
     */
    body.ai-league-native-spectator-ui .broadcast-drawer-panel,
    body.ai-league-native-spectator-ui .broadcast-drawer,
    body.ai-league-native-spectator-ui .broadcast-state-strip {
      background: var(--pw-panel) !important;
      border-color: var(--pw-hairline) !important;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    body.ai-league-native-spectator-ui .broadcast-war-room-item {
      background: rgba(31, 26, 22, 0.85) !important;
      border-color: var(--pw-hairline) !important;
    }
    body.ai-league-native-spectator-ui .broadcast-drawer-tabs,
    body.ai-league-native-spectator-ui .broadcast-drawer-tabs button {
      background: transparent !important;
      border-color: var(--pw-hairline) !important;
      color: var(--pw-ink-dim) !important;
    }
    /* THE WHOLE OVERLAY IS PARAMETERIZED AND NOBODY EVER SET THE PARAMETERS.
     * Every panel, ticker and card reads var(--pw-*, <slate fallback>) — the
     * slate the aesthetic gate kept sampling was the FALLBACKS firing, not a
     * competing design. Defining the token family warm re-skins every
     * component that was built against it, including the lower-third ticker
     * and the toolbar, in one block.
     *
     * --pw-info was cyan #56c7f5 — colliding with a seat colour, so chrome and
     * player identity were indistinguishable. Chrome speaks amber; only the
     * sixteen seats get to be anything else. */
    body.ai-league-native-spectator-ui {
      --pw-info: var(--pw-accent);
      --pw-info-soft: rgba(255, 194, 74, 0.14);
      --pw-text: var(--pw-ink);
      --pw-text-dim: var(--pw-ink-dim);
      --pw-muted: var(--pw-ink-faint);
      --pw-line: var(--pw-hairline);
      --pw-line-strong: rgba(242, 236, 226, 0.18);
      --pw-surface: rgba(31, 26, 22, 0.85);
      --pw-surface-strong: #1e1815;
      --pw-glass-strong: rgba(24, 20, 17, 0.93);
      --pw-danger: var(--pw-hazard);
      --pw-caution: #e8a33d;
      --pw-caution-soft: rgba(232, 163, 61, 0.14);
      --pw-caution-text: #ffd9a0;
      --pw-positive: var(--pw-live);
      --pw-positive-text: #b9e8cd;
      --pw-shadow: 0 26px 74px rgba(10, 7, 5, 0.55);
      --pw-shadow-soft: 0 12px 34px rgba(10, 7, 5, 0.4);
    }
    /* The transport's inner sidebar paints its own Tailwind slate over the
     * warm pill; pure-white icons drop to warm ink. */
    body.ai-league-native-spectator-ui #pw-game-control-cluster * {
      color: var(--pw-ink) !important;
    }
    body.ai-league-native-spectator-ui #pw-game-control-cluster svg {
      fill: var(--pw-ink);
      stroke: var(--pw-ink);
    }

    /* "Precisely-lit world under glass": the board itself is flat by
     * construction (the engine paints constant colours), so the LIGHT is
     * layered over it — a key-light falloff into the stage corners. Fixed,
     * full-frame, pointer-transparent, above the canvas and below the HUD. */
    body.ai-league-native-spectator-ui::after {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 5;
      pointer-events: none;
      background:
        radial-gradient(
          ellipse 62% 78% at 50% 44%,
          rgba(255, 214, 140, 0.05),
          transparent 58%
        ),
        radial-gradient(
          ellipse 85% 95% at 50% 50%,
          transparent 52%,
          rgba(8, 5, 3, 0.42) 100%
        );
    }
    /* Severity, not uniformity: strikes read hot, eliminations and nukes read
     * hazard, routine diplomacy recedes. Eight identical cards spotlighting a
     * "DEAL EXPIRED" is a flat feed no matter how good the copy is. */
    body.ai-league-native-spectator-ui
      .broadcast-war-room-item[data-kind="elimination"] .broadcast-war-room-kind,
    body.ai-league-native-spectator-ui
      .broadcast-war-room-item[data-kind="elimination"] .broadcast-war-room-glyph,
    body.ai-league-native-spectator-ui
      .broadcast-war-room-item[data-kind="nuke"] .broadcast-war-room-kind,
    body.ai-league-native-spectator-ui
      .broadcast-war-room-item[data-kind="nuke"] .broadcast-war-room-glyph {
      color: var(--pw-hazard) !important;
    }
    body.ai-league-native-spectator-ui
      .broadcast-war-room-item[data-kind="deal_expired"] .broadcast-war-room-kind,
    body.ai-league-native-spectator-ui
      .broadcast-war-room-item[data-kind="deal_expired"] .broadcast-war-room-glyph,
    body.ai-league-native-spectator-ui
      .broadcast-war-room-item[data-kind="deal_proposed"] .broadcast-war-room-kind,
    body.ai-league-native-spectator-ui
      .broadcast-war-room-item[data-kind="deal_proposed"] .broadcast-war-room-glyph {
      color: var(--pw-ink-faint) !important;
    }
    /* Feed cards PACK from the top. In a tall column the list was
     * distributing three cards across 900px of panel — sparse content should
     * leave empty space BELOW it, not between it. */
    body.ai-league-native-spectator-ui .broadcast-war-room-list {
      display: flex !important;
      flex-direction: column !important;
      justify-content: flex-start !important;
      gap: var(--pw-s-md) !important;
    }
    body.ai-league-native-spectator-ui .broadcast-war-room-list > li {
      flex: 0 0 auto !important;
    }
    body.ai-league-native-spectator-ui .broadcast-war-room-turn {
      color: var(--pw-ink-faint) !important;
      font-family: var(--pw-num) !important;
    }
    /* Let the headline use the card's full width. With the fixed label gutter,
     * body copy was wrapping into nine-line towers ("underpants honored the
     * non-aggression pact with...") inside a ~340px rail. Kind + turn form the
     * card's eyebrow line; the headline drops below them, full width. */
    body.ai-league-native-spectator-ui .broadcast-war-room-summary {
      flex-wrap: wrap !important;
    }
    body.ai-league-native-spectator-ui .broadcast-war-room-headline {
      flex: 1 1 100% !important;
      order: 10;
      margin-top: var(--pw-s-xs);
    }

    /* --- Chrome stragglers the token family cannot reach ------------------
     * These paint literal hex, not var(--pw-*), so the warm tokens never
     * applied: the transport's inner sidebar (#12161e sampled), the timeline
     * track (#18202b), and the toolbar's own buttons. Inner layers go
     * transparent so the warm pill/panel behind them shows through.
     */
    body.ai-league-native-spectator-ui #pw-game-control-cluster game-right-sidebar,
    body.ai-league-native-spectator-ui #pw-game-control-cluster game-right-sidebar > div,
    body.ai-league-native-spectator-ui #pw-game-control-cluster replay-panel > div {
      background: transparent !important;
      border-color: var(--pw-hairline) !important;
    }
    body.ai-league-native-spectator-ui .broadcast-timeline-track {
      background: rgba(31, 26, 22, 0.7) !important;
      border-color: var(--pw-hairline) !important;
    }
    /* The timeline dots were a second saturated field — 24% saturated pixels
     * "reading as confetti" against the board's 42%. Colour is spent where
     * severity earns it: routine markers recede to ink, strikes take amber,
     * eliminations and nukes take hazard. The board stays the only place
     * sixteen hues live. */
    /* A timeline tick must be INFORMATION. The strip carried 138 markers —
     * 96 of them "upcoming" placeholders — which reads as a smear, not a
     * timeline ("the dots are all so close together they don't provide any
     * real info"). Verified in the DOM: markers are .broadcast-timeline-marker
     * (NOT li > button — an earlier selector matched nothing, silently).
     * Routine beats live in the War Room feed; the strip keeps only what a
     * viewer would scrub TO: eliminations, nukes, the finish. */
    body.ai-league-native-spectator-ui .broadcast-timeline-marker {
      display: none !important;
    }
    body.ai-league-native-spectator-ui
      .broadcast-timeline-marker[data-kind="elimination"],
    body.ai-league-native-spectator-ui
      .broadcast-timeline-marker[data-kind="nuke"],
    body.ai-league-native-spectator-ui
      .broadcast-timeline-marker[data-kind="finish"] {
      display: inline-block !important;
    }
    body.ai-league-native-spectator-ui
      .broadcast-timeline-marker[data-kind="elimination"],
    body.ai-league-native-spectator-ui
      .broadcast-timeline-marker[data-kind="nuke"] {
      background: var(--pw-hazard) !important;
    }
    body.ai-league-native-spectator-ui
      .broadcast-timeline-marker[data-kind="finish"] {
      background: var(--pw-accent) !important;
    }

    /* SIZE TIERS, not just proportion. Zoom keeps the HUD's share of the
     * frame constant, but a 430px head-to-head TILE is a thumbnail — its job
     * is "look, a live match", and the parent page already provides names and
     * standings. Chrome yields progressively:
     *   <=560px  (tiles):   map + clock only.
     *   561-640px (floor):  top-3 compact scorebug, no feed.
     *   641-740px (embed):  top-4 compact scorebug, no feed.
     *   741-980px (stage):  top-6 compact scorebug, feed stays.
     */
    @media (max-width: 560px) {
      body.ai-league-native-spectator-ui leader-board.ai-league-native-leaderboard,
      body.ai-league-native-spectator-ui .broadcast-drawer-panel,
      body.ai-league-native-spectator-ui #ai-league-replay-overlay,
      body.ai-league-native-spectator-ui #ai-league-social-transcript {
        display: none !important;
      }
      body.ai-league-native-spectator-ui #pw-game-control-cluster {
        zoom: 0.55;
      }
    }
    @media (min-width: 561px) and (max-width: 640px) {
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard
        .contents[data-scorebug-row]:nth-of-type(n + 5) {
        display: none !important;
      }
    }
    @media (min-width: 641px) and (max-width: 740px) {
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard
        .contents[data-scorebug-row]:nth-of-type(n + 6) {
        display: none !important;
      }
    }
    @media (min-width: 741px) and (max-width: 980px) {
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard
        .contents[data-scorebug-row]:nth-of-type(n + 8) {
        display: none !important;
      }
    }
    /* first_strike looked rare and is not — one per ordered PAIR of players,
     * so a 16-seat match can carry hundreds. Only genuinely rare beats get a
     * hue; everything else is ink, or the strip turns back into confetti. */
    body.ai-league-native-spectator-ui
      .broadcast-drawer-panel[data-tab-id="timeline"] li > button[data-kind="elimination"],
    body.ai-league-native-spectator-ui
      .broadcast-drawer-panel[data-tab-id="timeline"] li > button[data-kind="nuke"] {
      background: var(--pw-hazard) !important;
      opacity: 1;
    }
    /* THE SCOREBUG IS OPERABLE AGAIN. The host stays pointer-events:none so
     * the panel's empty ground still passes clicks through to the board; the
     * CELLS opt back in. It has to be the cells and never the row wrapper —
     * the wrapper is display:contents, so it has no box and pointer-events on
     * it does nothing (the same trap this file already documents for opacity).
     * Clicks land on a cell and bubble to the wrapper's handler.
     *
     * This restores two capabilities the stock leaderboard has and the
     * broadcast was rendering the affordances for while swallowing the input:
     * sorting by gold or max troops (the sort caret was drawn on a dead
     * header), and click-a-row-to-put-the-camera-on-that-nation, which is also
     * the discoverability answer for the follow gesture. The +/- expander is
     * separately display:none below and stays gone: on a 16-row panel that
     * shows the whole field, "top 5 + more" is a dead end. */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard
      .contents:not(.font-bold)
      > div,
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard
      .contents.font-bold
      > div:nth-child(n + 3) {
      pointer-events: auto !important;
      cursor: pointer;
    }
    /* Clickable with no response is worse than not clickable. The wash sits on
     * the cells for the same display:contents reason as above. */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard
      .contents:not(.font-bold):hover
      > div {
      background: rgba(242, 236, 226, 0.06);
    }
    /* "MAX TROOPS" was clipping to "MAX TR." — the eyebrow row gets a size
     * that fits the tracks it labels.
     *
     * THE ONE DOCUMENTED DEVIATION FROM THE TYPE SCALE, and it stays. The
     * scorebug's grid-template-columns is fixed (26+122+52+46+52), so this
     * caps string has 52px and no reflow to fall back on: at the micro rung
     * plus the standard eyebrow track it measures wider than its column and
     * truncates again. The track now comes from --pw-eyebrow-track-tight, so
     * the exception is a named token rather than one more loose number, and
     * the size is the only value on this surface that sits off the scale on
     * purpose. Do not "tidy" it to var(--pw-type-micro) without re-measuring
     * the header against the column widths. */
    body.ai-league-native-spectator-ui
      leader-board.ai-league-native-leaderboard .contents.font-bold > div {
      font-size: 8px !important;
      letter-spacing: var(--pw-eyebrow-track-tight) !important;
    }

    /* --- LAYOUT DOCTRINE: every element has ONE home, and nothing overlaps.
     * Measured at 1280x720 before this block existed: five overlapping pairs,
     * all in the bottom band — radio over toolbar over timeline, radio over
     * the headline toast, war room running 38px past the timeline's top, and
     * radio covering 8% of the board. The lanes, bottom-up:
     *   timeline lane   (bottom 12, spans the board — everything clears IT)
     *   toast lane      (bottom 62, centred: headline)
     *   callout lane    (bottom 112, centred: lower-third)
     *   left-band stack (toolbar bottom 12, radio stacked above it at 116)
     * Left-band widgets are capped to the band so they never touch the board
     * or the timeline's left end.
     */
    body.ai-league-native-spectator-ui #ai-league-replay-overlay {
      /* Floored: on a 2:1 map (Black Sea, World) the band can be ~100px and
       * band-derived widths starved this card to 80px, running the buttons
       * off it with no way to reach them. A control is reachable or it does
       * not exist. */
      width: min(296px, max(230px, calc(var(--pw-band-left, 316px) - 20px))) !important;
      /* The panel's CONTENTS are hidden in broadcast mode (standings, details,
       * relocated drawer) — but the container kept its reserved height, so
       * viewers saw a ~450px EMPTY box with a resize handle. A container owns
       * no space its content doesn't use. */
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
    }
    body.ai-league-native-spectator-ui #ai-league-replay-overlay .ai-league-body,
    body.ai-league-native-spectator-ui #ai-league-replay-overlay .ai-league-resize-handle {
      display: none !important;
    }
    /* Four buttons at a 296px cap clipped the fourth ("Hide" rendered cut in
     * half). Toolbars wrap; they do not truncate. */
    body.ai-league-native-spectator-ui #ai-league-replay-overlay .ai-league-header-actions {
      flex-wrap: wrap !important;
    }
    /* A PANEL NEVER RENDERS EMPTY. During the spawn phase the War Room showed
     * a full-height box containing one grey sentence. When the list has no
     * real items, the panel collapses to its header line. */
    body.ai-league-native-spectator-ui
      .broadcast-drawer-panel[data-tab-id="events"]:has(.broadcast-war-room-empty) {
      max-height: 64px !important;
      overflow: hidden !important;
    }
    body.ai-league-native-spectator-ui #ai-league-social-transcript {
      left: 12px !important;
      bottom: 116px !important;
      width: min(296px, calc(var(--pw-band-left, 316px) - 20px)) !important;
      /* Three messages visible, the rest scroll. A transcript is a reading
       * surface, not a wall. */
      max-height: 150px !important;
      overflow-y: auto !important;
    }
    /* The left band cannot hold a 16-row scorebug AND the radio AND the
     * toolbar at 720px — measured: 517 + 244 + 92 > 720. Priority is by
     * use-case: the scorebug is persistent, the radio is opt-in. Opening the
     * radio compresses the standings to a scrolling window; closing it gives
     * the full field back. Nothing ever overlaps in either state. */
    body.ai-league-native-spectator-ui.ai-league-radio-on
      leader-board.ai-league-native-leaderboard {
      max-height: 396px !important;
      overflow-y: auto !important;
    }
    body.ai-league-native-spectator-ui
      .broadcast-drawer-panel[data-tab-id="events"] {
      max-height: calc(
        100vh - var(--pw-control-cluster-bottom, 76px) - 84px
      ) !important;
    }
    body.ai-league-native-spectator-ui #ai-league-headline-event {
      bottom: 62px !important;
    }
    body.ai-league-native-spectator-ui #ai-league-lower-third-host {
      bottom: 112px !important;
    }
    /* An embedded broadcast has nowhere to "leave" to. */
    body.ai-league-native-spectator-ui [title="Leave match"],
    body.ai-league-native-spectator-ui [aria-label="Leave match"] {
      display: none !important;
    }
    /* The inspect card yields to the finale. */
    body.pw-endcard-open player-info-overlay {
      display: none !important;
    }
    /* THE HOVER INSPECT CARD IS BACK — DO NOT RE-DELETE IT TO FIX STALENESS.
     * History: the card had a REAL bug on the broadcast. It is a singleton
     * createRenderer QUERIES, not creates; an in-place rewind reassigned
     * .game while Lit @state kept the previous run's PlayerView, so it
     * showed frozen mixed-era numbers for minutes (measured 233K gold on
     * the card vs the true 157K on the scorebug, same instant). The r58
     * response display:none'd the element here and early-returned in
     * maybeShow(), which amputated the whole feature — the owner wants
     * hover info back (tile owner, and ship owner/type/troops over water).
     * The staleness bug is now fixed IN the component: init() clears
     * retained state on every createRenderer pass, and a willUpdate guard
     * re-resolves any retained view against the CURRENT GameView (by
     * smallID / unit id) before every render, standing down if it no
     * longer exists. So the card runs on the broadcast; it is suppressed
     * only where audits found real harm:
     *   - under body.pw-endcard-open (rule above): yields to the finale.
     *   - at the 640x360 embed floor (below): at that width it overlapped
     *     the scorebug and crowded the clock. */
    @media (max-width: 740px) {
      body.ai-league-native-spectator-ui player-info-overlay {
        display: none !important;
      }
    }
    /* RESKIN: the card is Lit rendering Tailwind utility classes into
     * light DOM (createRenderRoot returns this), so we restyle the classes
     * its template actually emits. Attribute [class*=...] selectors
     * because the interesting class names carry slashes (bg-gray-800/92)
     * that would need escaping inside this template literal. Targets, read
     * from the template in PlayerInfoOverlay.ts:
     *   - bg-gray-800/92 — the card surface (slate glass): warm glass,
     *     hairline border, ink text, house display font.
     *   - text-white and text-white/40 — name/bar labels and the idle
     *     attack column: ink, and faint ink for the deliberately-dim idle
     *     state (the generic rule matches both; the /40 rule follows it
     *     in source order to win the cascade at equal specificity).
     *   - text-gray-400 — the player-type/team label: dim ink.
     *   - border-gray-500 / border-gray-600 / border-yellow-400 — unit
     *     chips, troop-bar track, gold chip: one hairline everywhere.
     *   - text-yellow-400 — the gold readout: amber accent (gold is the
     *     one place an accent is genuinely meaningful on this card).
     *   - bg-gray-900/60 — troop-bar track: warm near-black.
     *   - bg-sky-700 / bg-malibu-blue — the two BLUE troop-bar fills:
     *     standing troops become translucent ink (a neutral gauge), the
     *     attacking share becomes amber — it is the live signal.
     *   - text-aquarius — the active attack counter: amber, same signal.
     * Numbers keep their own size/weight/tabular styling, and the card
     * stays top-center where the owner expects to find it. */
    body.ai-league-native-spectator-ui player-info-overlay [class*="bg-gray-800"] {
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93)) !important;
      border: 1px solid var(--pw-hairline) !important;
      color: var(--pw-ink) !important;
      font-family: var(--pw-display) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="text-white"] {
      color: var(--pw-ink) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="text-white/40"] {
      color: var(--pw-ink-faint) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="text-gray-400"] {
      color: var(--pw-ink-dim) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="border-gray-500"],
    body.ai-league-native-spectator-ui player-info-overlay [class*="border-gray-600"],
    body.ai-league-native-spectator-ui player-info-overlay [class*="border-yellow-400"] {
      border-color: var(--pw-hairline) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="text-yellow-400"] {
      color: var(--pw-accent) !important;
    }
    /* PURE BLACK IS OFF THIS PALETTE. The template hardcodes
     * drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] on the labels and the unit
     * icons — a legibility device, and a reasonable one over a bright map,
     * but #000 appears nowhere else on this stage (the stage itself is
     * #14110f, a warm near-black chosen precisely so nothing is ever pure
     * black). Same shadow, same job, in the stage's own darkness.
     *
     * TWO RULES, and they must stay two. Tailwind compiles brightness-0,
     * invert and drop-shadow-[...] into the SAME filter property, so a single
     * override would silently drop the brightness/invert that makes the unit
     * sprites visible at all — a dark sprite on a dark card, i.e. invisible
     * icons. The icon rule therefore restates them; the text rule must NOT,
     * or every label would be forced to pure white. */
    body.ai-league-native-spectator-ui
      player-info-overlay
      [class*="drop-shadow"]:not([class*="brightness-0"]) {
      filter: drop-shadow(0 1px 1px rgba(10, 7, 5, 0.85)) !important;
    }
    body.ai-league-native-spectator-ui
      player-info-overlay
      [class*="brightness-0"] {
      filter: brightness(0) invert(1)
        drop-shadow(0 1px 1px rgba(10, 7, 5, 0.85)) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="bg-gray-900"] {
      background: rgba(20, 17, 15, 0.6) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="bg-sky-700"] {
      background: rgba(242, 236, 226, 0.26) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="bg-malibu-blue"] {
      background: var(--pw-accent) !important;
    }
    body.ai-league-native-spectator-ui player-info-overlay [class*="text-aquarius"] {
      color: var(--pw-accent) !important;
    }
    /* ONE ANNOUNCER. #ai-league-lower-third-host is the SECOND lower-third:
     * LowerThirdController syncs it to the same beat feed WarRoomToasts
     * presents, so two announcers could be live at once (the first,
     * #ai-league-headline-event, was already hidden further up for exactly
     * this reason). The "bottom: 112px" docking rule earlier in this sheet
     * is intentionally left in place — display:none supersedes it, and
     * removing it would mean editing an existing region of a stylesheet
     * that has been damaged twice by region replaces. */
    body.ai-league-native-spectator-ui #ai-league-lower-third-host {
      display: none !important;
    }

    /* --- The end-card owns the finale ------------------------------------
     * It carries the complete frozen standings; the live scorebug and feed
     * keep ticking to the recorded last tick underneath it, which put two
     * disagreeing numbers for the winner on screen at once (77.3% vs 80.3%).
     * While the card holds, they stand down. The transport stays: scrubbing
     * back is exactly how a viewer leaves the card.
     */
    body.pw-endcard-open leader-board.ai-league-native-leaderboard,
    body.pw-endcard-open .broadcast-drawer-panel,
    body.pw-endcard-open #ai-league-lower-third-host,
    body.pw-endcard-open #ai-league-replay-overlay {
      display: none !important;
    }

    /* --- The 640x360 embed floor ------------------------------------------
     * There is no band to dock into at this size. The overlay panel (whose
     * collapsed toggle rendered as "w panel" half-under the scorebug) is cut
     * entirely: the scorebug carries who's winning, the lower third carries
     * what just happened, and the board needs every remaining pixel. The
     * transport scales down instead of eating 69% of the frame width.
     */
    @media (max-width: 740px) {
      body.ai-league-native-spectator-ui #ai-league-replay-overlay {
        display: none !important;
      }
      body.ai-league-native-spectator-ui #pw-game-control-cluster {
        transform: scale(0.78);
        transform-origin: top right;
      }
      /* The band is ~158px here — narrower than any readable rail — so the
       * scorebug must minimise its trespass onto the board: tighter insets,
       * smaller type, and glass transparent enough that territory reads
       * through it.
       *
       * OFF-SCALE ON PURPOSE. The type scale is authored for a frame with a
       * band; the 640x360 embed has none, and every rung below the label rung
       * is an eyebrow rung, which a data row must not become. These two
       * values survive the floor, they do not describe a level - leave them
       * literal so nobody reads them as a seventh step. */
      body.ai-league-native-spectator-ui leader-board.ai-league-native-leaderboard {
        background: rgba(24, 20, 17, 0.66) !important;
      }
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard .grid {
        padding-left: var(--pw-s-xs) !important;
        padding-right: var(--pw-s-xs) !important;
      }
      body.ai-league-native-spectator-ui
        leader-board.ai-league-native-leaderboard .contents > div {
        font-size: 10px !important;
        padding-top: 2px !important;
        padding-bottom: 2px !important;
      }
    }
    body.ai-league-native-spectator-ui leader-board.ai-league-native-leaderboard {
      filter: drop-shadow(0 14px 32px rgba(2, 6, 23, 0.32));
    }
  `;
  document.head.appendChild(style);
}

export class GameRenderer {
  private context: CanvasRenderingContext2D;
  private layerTickState = new Map<Layer, { lastTickAtMs: number }>();
  private renderFramesSinceLastTick: number = 0;
  private renderLayerDurationsSinceLastTick: Record<string, number> = {};

  // H2 (2026-08-12, in-place rewind): `renderGame()` used to re-arm its
  // requestAnimationFrame unconditionally with no way to ever stop it, and the
  // re-arming closure pins this renderer — which pins the layer array, every
  // full-map offscreen canvas those layers hold (tens of MB), and the GameView
  // behind them. A page load used to be the only teardown; the scrubber's
  // backward seek now rebuilds the game in place, so a renderer that cannot be
  // stopped means every rewind adds another full render loop painting a dead
  // GameView over the live board's frames.
  private running = false;
  private rafId: number | null = null;
  private fullscreenRafId: number | null = null;
  private disposed = false;
  // Stored rather than inline so `dispose()` can actually take them back off:
  // both `removeEventListener` and `EventBus.off()` match by identity.
  private readonly onWindowResize = () => {
    this.resizeCanvas();
    this.refitBoardToViewport();
  };

  /**
   * FULLSCREEN, SPECIFICALLY — reported from an embed: "you get a small map in
   * a big grey field."
   *
   * A resize normally covers it, but not reliably on this path. Entering
   * fullscreen can deliver `fullscreenchange` before the viewport has actually
   * settled at its new size, and in an EMBED it is the parent document that
   * goes fullscreen, so the frame is resized by the host rather than by the
   * user's own window manager — browsers differ on the ordering and on whether
   * an inner `resize` arrives at all. Two rAFs put the re-fit after layout has
   * definitely settled, and re-fitting twice is harmless: it is idempotent.
   *
   * Only the viewer itself can fix this. The embed is cross-origin, so a
   * parent page cannot reach in and re-fit the camera for us.
   */
  private readonly onFullscreenChange = () => {
    if (this.fullscreenRafId !== null) {
      cancelAnimationFrame(this.fullscreenRafId);
    }
    this.fullscreenRafId = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.fullscreenRafId = requestAnimationFrame(() => {
        this.fullscreenRafId = null;
        if (this.disposed) return;
        this.resizeCanvas();
        this.refitBoardToViewport();
      });
    });
  };

  /**
   * RE-FIT THE BOARD WHEN THE FRAME CHANGES SHAPE.
   *
   * The landing scale is computed once, at initialize(), from the viewport as
   * it was then — and TransformHandler deliberately refreshes only its clamp
   * bounds on resize, never scale or offsets. That is correct for the live
   * game, where the camera belongs to the player and yanking it mid-match
   * would be hostile. It is wrong here: on a broadcast nothing else moves the
   * camera, so after a resize the board simply keeps a scale fitted to a frame
   * that no longer exists — measured at 1920x1080 as roughly 16% of the width
   * left as dead stage on ONE side, which reads as a rendering fault rather
   * than as framing. A viewer hits this by resizing a window, going
   * fullscreen, or rotating a device.
   *
   * Not while FOLLOWING: the viewer has pointed the camera at a nation, and a
   * resize must not throw that away.
   */
  private refitBoardToViewport() {
    if (!isReplaySpectatorView()) return;
    if (
      followedCompetitorSmallId() !== null ||
      this.transformHandler.userCameraIntentEpoch() > 0
    ) {
      // The HUD still needs fresh docking dimensions for the new frame even
      // though the viewer-owned camera must stay exactly where they put it.
      this.transformHandler.updateBroadcastLayout(0.9);
      return;
    }
    this.transformHandler.centerAll(0.9);
  }
  /** Torn off in dispose(); see watchPixelRatio for why it re-arms. */
  private pixelRatioWatch: MediaQueryList | null = null;
  private readonly onPixelRatioChange = () => {
    this.resizeCanvas();
    this.redraw();
    this.watchPixelRatio();
  };

  /**
   * DRAGGING THE WINDOW TO ANOTHER MONITOR changes devicePixelRatio without
   * necessarily changing innerWidth/innerHeight, so the "resize" listener
   * above can miss it entirely and the board keeps a backing store sized for
   * the old display — the exact softness the ratio exists to prevent, but now
   * only on the second screen and only after a move, which is a miserable bug
   * to chase.
   *
   * A resolution media query is the only reliable signal. It matches ONE
   * ratio, so it has to be re-armed at the new ratio each time it fires.
   */
  private watchPixelRatio() {
    if (typeof window.matchMedia !== "function") return;
    this.pixelRatioWatch?.removeEventListener(
      "change",
      this.onPixelRatioChange,
    );
    if (this.disposed) {
      this.pixelRatioWatch = null;
      return;
    }
    this.pixelRatioWatch = window.matchMedia(
      `(resolution: ${window.devicePixelRatio || 1}dppx)`,
    );
    this.pixelRatioWatch.addEventListener("change", this.onPixelRatioChange);
  }
  private readonly onRedrawGraphics = () => this.redraw();

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private canvas: HTMLCanvasElement,
    public transformHandler: TransformHandler,
    public uiState: UIState,
    private layers: Layer[],
    private performanceOverlay: PerformanceOverlay,
    /**
     * Teardowns for things `createRenderer` installed that are NOT layers and
     * so cannot be reached through `layers[].dispose()` — today, the
     * followed-competitor gesture handlers and the two broadcast nodes this
     * function creates. Collected at install time because that is the only
     * place their handles exist.
     */
    private readonly broadcastTeardowns: Array<() => void> = [],
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("2d context not supported");
    this.context = context;
  }

  /**
   * The surface the game is drawn on. Exposed read-only so share-image capture
   * can read the current frame without reaching into the DOM for it.
   */
  get gameCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  initialize() {
    this.eventBus.on(RedrawGraphicsEvent, this.onRedrawGraphics);
    this.layers.forEach((l) => l.init?.());

    // only append the canvas if it's not already in the document to avoid reparenting side-effects
    if (!document.body.contains(this.canvas)) {
      document.body.appendChild(this.canvas);
    }

    window.addEventListener("resize", this.onWindowResize);
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    this.watchPixelRatio();
    this.resizeCanvas();

    //show whole map on startup
    this.transformHandler.centerAll(0.9);
    // Dev/replay hook: expose the transform handler so replay tooling (e.g. promo
    // recording) can lock the camera to the whole map. No-op for normal gameplay.
    (window as unknown as Record<string, unknown>).__proxywarTransform =
      this.transformHandler;

    // The frame id moved from a closure-local to a field so `dispose()` can
    // cancel whatever is in flight; context-lost/restored keep their existing
    // behaviour on top of it, except that a restore after teardown must not
    // resurrect the loop.
    this.running = true;
    this.rafId = requestAnimationFrame(() => this.renderGame());
    this.canvas.addEventListener("contextlost", () => {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    });
    this.canvas.addEventListener("contextrestored", () => {
      if (!this.running) return;
      this.redraw();
      this.rafId = requestAnimationFrame(() => this.renderGame());
    });
  }

  /**
   * Stops this renderer for good. Paired with `ClientGameRunner.stop()`; there
   * is no restart — a rewind builds a whole new renderer, because GameView
   * cannot be reused (insert-only `_players`, colliding unit ids after
   * `_nextUnitID` restarts at 1, and a map buffer mutated in place that would
   * otherwise keep FUTURE owners on every tile the rewound range never
   * touches).
   *
   * `releaseCanvas` is opt-in and only the rewind path passes it: an ordinary
   * live-game stop leaves the last painted frame exactly where it was, while a
   * rewind is about to append a REPLACEMENT full-screen canvas and would
   * otherwise strand this one's device-pixel backing store (width x height x
   * ratio^2 x 4 bytes — tens of MB) in the document forever.
   */
  dispose(options: { releaseCanvas?: boolean } = {}) {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.fullscreenRafId !== null) {
      cancelAnimationFrame(this.fullscreenRafId);
      this.fullscreenRafId = null;
    }
    window.removeEventListener("resize", this.onWindowResize);
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    this.pixelRatioWatch?.removeEventListener(
      "change",
      this.onPixelRatioChange,
    );
    this.pixelRatioWatch = null;
    this.eventBus.off(RedrawGraphicsEvent, this.onRedrawGraphics);
    // The camera has bus subscriptions and a possible eased-goTo interval of
    // its own; orphaning it was the code review's worst rewind leak (a 16ms
    // timer nothing could ever stop, plus seven handlers mutating dead state).
    this.transformHandler.dispose();

    // THE BROADCAST HAS TO LEAVE WITH THE GAME IT BELONGS TO.
    //
    // This client is a single-page app: leaving a match does
    // `history.replaceState` with no reload (Main.handleLeaveLobby), and an
    // in-place rewind rebuilds the game the same way. Every broadcast surface
    // appends to document.body and — before this — was removed only by the
    // NEXT init() of its own module, i.e. only if another replay started. So
    // "watch a replay, leave, start a single-player game" left the transport
    // bar, the scorebug, the identity plate and the analyst drawer painted
    // over the live board, frozen on a match that no longer existed. The
    // gesture handlers survived too, on a page-lifetime EventBus, still
    // hit-testing a torn-down GameView.
    for (const layer of this.layers) {
      try {
        layer.dispose?.();
      } catch (err) {
        // One layer failing to tear down must not strand the rest — this runs
        // on the path OUT of a game, where there is nothing left to salvage by
        // rethrowing.
        console.error("layer dispose failed", err);
      }
    }
    for (const teardown of this.broadcastTeardowns) {
      try {
        teardown();
      } catch (err) {
        console.error("broadcast teardown failed", err);
      }
    }
    // Created by createRenderer rather than queried, so nothing else owns them.
    document
      .querySelector("leader-board.ai-league-native-leaderboard")
      ?.remove();
    document.getElementById("pw-board-identity")?.remove();
    // Debug handle installed at initialize(); a stale one points at a dead
    // transform and reads as live state to anyone poking at the console.
    delete (window as unknown as Record<string, unknown>).__proxywarTransform;

    if (options.releaseCanvas === true) {
      this.canvas.remove();
      // Removal alone does not free the backing store while anything still
      // references the element; resizing to 0 does.
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
  }

  resizeCanvas() {
    // Backing store in DEVICE pixels, CSS box still 100%/100% (see
    // createCanvas) — so the canvas keeps its on-screen size but gains real
    // resolution. Everything that draws stays in CSS-pixel space; the ratio is
    // folded into the base transform below and into handleTransform, so no
    // layer and no hit-test needs to know about it.
    const ratio = canvasPixelRatio();
    this.canvas.width = Math.round(window.innerWidth * ratio);
    this.canvas.height = Math.round(window.innerHeight * ratio);
    this.transformHandler.updateCanvasBoundingRect();
    //this.redraw()
  }

  redraw() {
    this.layers.forEach((l) => {
      if (l.redraw) {
        l.redraw();
      }
    });
  }

  renderGame() {
    // A disposed renderer must never paint again: its layers may already be
    // reading a GameView whose worker is gone, and on the rewind path a live
    // replacement renderer owns the screen by now.
    if (this.disposed) return;
    const shouldProfileFrame = FrameProfiler.isEnabled();
    if (shouldProfileFrame) {
      FrameProfiler.clear();
    }
    const start = performance.now();
    // Set background
    // THE STAGE. Off the board, the broadcast paints a warm near-black rather
    // than the engine's cool theme background — art-direction lock "Situation
    // Display". A blue-charcoal surround is the single most reliable
    // "AI-default dashboard" tell, and it also competes with the ocean, which
    // is the one thing on screen that IS legitimately blue.
    //
    // Never pure #000. Replay-only: the live game keeps its theme exactly.
    // The frame's base transform: CSS pixels in, device pixels out. Layers
    // that opt out of the world transform draw against THIS, not identity, so
    // an untransformed layer is not silently half-size on a HiDPI screen.
    const ratio = canvasPixelRatio();
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.context.fillStyle = nativeSpectatorStageEnabled()
      ? "#14110f"
      : this.game.config().theme().backgroundColor().toHex();
    this.context.fillRect(
      0,
      0,
      this.canvas.width / ratio,
      this.canvas.height / ratio,
    );

    const handleTransformState = (
      needsTransform: boolean,
      active: boolean,
    ): boolean => {
      if (needsTransform && !active) {
        this.context.save();
        this.transformHandler.handleTransform(this.context);
        return true;
      } else if (!needsTransform && active) {
        this.context.restore();
        return false;
      }
      return active;
    };

    let isTransformActive = false;

    for (const layer of this.layers) {
      const needsTransform = layer.shouldTransform?.() ?? false;
      isTransformActive = handleTransformState(
        needsTransform,
        isTransformActive,
      );

      if (shouldProfileFrame) {
        const layerStart = FrameProfiler.start();
        layer.renderLayer?.(this.context);
        FrameProfiler.end(
          layer.constructor?.name ?? "UnknownLayer",
          layerStart,
        );
      } else {
        layer.renderLayer?.(this.context);
      }
    }
    handleTransformState(false, isTransformActive); // Ensure context is clean after rendering
    this.transformHandler.resetChanged();

    // The re-arm is what made this loop immortal. Gated on `running`, teardown
    // is simply the last frame that ever schedules a successor.
    if (this.running) {
      this.rafId = requestAnimationFrame(() => this.renderGame());
    }
    const duration = performance.now() - start;

    if (shouldProfileFrame) {
      const layerDurations = FrameProfiler.consume();
      this.renderFramesSinceLastTick++;
      for (const [name, ms] of Object.entries(layerDurations)) {
        this.renderLayerDurationsSinceLastTick[name] =
          (this.renderLayerDurationsSinceLastTick[name] ?? 0) + ms;
      }
      this.performanceOverlay.updateFrameMetrics(duration, layerDurations);
    }

    // Behind the profiler, because on this surface the warning fires for the
    // wrong reason. A broadcast forward-seek deliberately renders as fast as
    // the machine allows, so >50ms frames are the EXPECTED shape of a seek,
    // not a fault — and unconditional warning turned the one signal that would
    // reveal a genuine frame regression into background noise nobody reads.
    // FrameProfiler.isEnabled() is how someone actually looking at frame cost
    // asks for it.
    if (duration > 50 && FrameProfiler.isEnabled()) {
      console.warn(
        `tick ${this.game.ticks()} took ${duration}ms to render frame`,
      );
    }
  }

  tick() {
    const nowMs = performance.now();
    const shouldProfileTick = FrameProfiler.isEnabled();

    if (shouldProfileTick) {
      this.performanceOverlay.updateRenderPerTickMetrics(
        this.renderFramesSinceLastTick,
        this.renderLayerDurationsSinceLastTick,
      );
      this.renderFramesSinceLastTick = 0;
      this.renderLayerDurationsSinceLastTick = {};
    }

    const tickLayerDurations: Record<string, number> = {};

    for (const layer of this.layers) {
      if (!layer.tick) {
        continue;
      }

      const state = this.layerTickState.get(layer) ?? {
        lastTickAtMs: -Infinity,
      };

      const intervalMs = layer.getTickIntervalMs?.() ?? 0;
      if (intervalMs > 0 && nowMs - state.lastTickAtMs < intervalMs) {
        this.layerTickState.set(layer, state);
        continue;
      }

      state.lastTickAtMs = nowMs;
      this.layerTickState.set(layer, state);

      const tickStart = shouldProfileTick ? performance.now() : 0;
      layer.tick();
      if (shouldProfileTick && tickStart !== 0) {
        const duration = performance.now() - tickStart;
        const label = layer.constructor?.name ?? "UnknownLayer";
        tickLayerDurations[label] = (tickLayerDurations[label] ?? 0) + duration;
      }
    }

    if (shouldProfileTick) {
      this.performanceOverlay.updateTickLayerMetrics(tickLayerDurations);
    }
  }
}
