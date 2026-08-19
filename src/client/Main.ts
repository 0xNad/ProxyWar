import version from "resources/version.txt?raw";
import { UserMeResponse } from "../core/ApiSchemas";
import { assetUrl } from "../core/AssetUrls";
import { EventBus } from "../core/EventBus";
import {
  GAME_ID_REGEX,
  GameInfo,
  GameRecord,
  GameRecordSchema,
  GameStartInfo,
  PublicGameInfo,
} from "../core/Schemas";
import { GameEnv } from "../core/configuration/Config";
import { getRuntimeClientServerConfig } from "../core/configuration/ConfigLoader";
import { GameType } from "../core/game/Game";
import {
  DARK_MODE_KEY,
  USER_SETTINGS_CHANGED_EVENT,
  UserSettings,
} from "../core/game/UserSettings";
import "./AccountModal";
import { getUserMe } from "./Api";
import { userAuth } from "./Auth";
import { mountBroadcastBeats, recordedAgentMessages } from "./BroadcastBeats";
import "./ClanModal";
import { joinLobby, type JoinLobbyResult } from "./ClientGameRunner";
import { getPlayerCosmeticsRefs } from "./Cosmetics";
import { mountCoworldPlayerOverlay } from "./CoworldPlayerOverlay";
import {
  isCoworldStaticReplayViewer,
  loadCoworldStaticReplay,
} from "./CoworldStaticReplay";
import { crazyGamesSDK } from "./CrazyGamesSDK";
import "./FlagInput";
import { FlagInput } from "./FlagInput";
import "./FlagInputModal";
import { FlagInputModal } from "./FlagInputModal";
import { GameInfoModal } from "./GameInfoModal";
import "./GameModeSelector";
import { GameModeSelector } from "./GameModeSelector";
import { GameStartingModal } from "./GameStartingModal";
import "./GoogleAdElement";
import { HelpModal } from "./HelpModal";
import {
  isReplayOrGamePathShape,
  shouldPushAiLeagueReplayHistoryEntry,
} from "./HistoryGuard";
import "./HomepagePromos";
import { HostLobbyModal as HostPrivateLobbyModal } from "./HostLobbyModal";
import { ReplayJumpToTurnEvent, ReplaySpeedChangeEvent } from "./InputHandler";
import { JoinLobbyModal } from "./JoinLobbyModal";
import "./LangSelector";
import { LangSelector } from "./LangSelector";
import { initLayout } from "./Layout";
import "./LeaderboardModal";
import { installLullDirector } from "./LullDirector";
import "./Matchmaking";
import { MatchmakingModal } from "./Matchmaking";
import { initNavigation } from "./Navigation";
import "./NewsModal";
import "./PatternInput";
import {
  initialReplayClipRenderableThroughTurn,
  replayClipPreviewTarget,
} from "./ReplayClipControl";
import {
  decisionsFromSpectatorSnapshots,
  publishReplayDecisions,
} from "./ReplayDecisionStore";
import {
  disposeReplayFrameCache,
  installReplayFrameCapture,
  nearestFrameAtOrBefore,
} from "./ReplayFrameCache";
import { publishReplayIntegrity } from "./ReplayIntegrityStore";
import {
  createJoinSyncWatchdog,
  finishReplayLoadingScreen,
  holdReplayLoadingScreenUntilFirstFrame,
  REPLAY_LOADING_SLOW_TIMEOUT_MS,
  runReplayStartup,
  setReplayLoadingProgress,
  showReplayLoadingFailure,
  showReplayLoadingScreen,
} from "./ReplayLoadingScreen";
import {
  loadResumableReplayTurn,
  watchReplayPositionForResume,
} from "./ReplayPositionPersistence";
import {
  readReplayPremiereArchivePayload,
  type ReplayPremiereArchivePayload,
} from "./ReplayPremiereArchiveView";
import { ReplayPremiereNetworkError } from "./ReplayPremiereNetwork";
import type { ReplayPremiereProgressiveReplayConfig } from "./ReplayPremierePlayback";
import {
  parseReplayPremiereRoute,
  ReplayPremiereRuntimeController,
} from "./ReplayPremiereRuntime";
import {
  loadPersistedReplaySpeed,
  watchReplaySpeedForResume,
} from "./ReplaySpeedPersistence";
import { mountReplayWatchAnalytics } from "./ReplayWatchAnalytics";
import { raiseRewindCurtain } from "./RewindCurtain";
import "./SinglePlayerModal";
import {
  clearSpectatorReplay,
  publishSpectatorReplay,
  spectatorReplaySnapshots,
} from "./SpectatorReplayStore";
import { StoreModal } from "./Store";
import "./TerritoryPatternsModal";
import { TerritoryPatternsModal } from "./TerritoryPatternsModal";
import { TokenLoginModal } from "./TokenLoginModal";
import {
  PauseGameIntentEvent,
  SendKickPlayerIntentEvent,
  SendStartGameEvent,
  SendUpdateGameConfigIntentEvent,
} from "./Transport";
import { UserSettingModal } from "./UserSettingModal";
import "./UsernameInput";
import { genAnonUsername, UsernameInput } from "./UsernameInput";
import {
  getDiscordAvatarUrl,
  incrementGamesPlayed,
  isInIframe,
  translateText,
} from "./Utils";
import { REPLAY_SEEK_DEAD_ZONE_TURNS } from "./graphics/layers/BroadcastScrubber";
import {
  followedCompetitorSmallId,
  restoreFollowedCompetitor,
} from "./graphics/layers/FollowedCompetitor";
import "./platform/AccountPage";
import "./platform/PlayerProfilePage";
import "./platform/PremiereEndedPage";
import { ReplaySpeedMultiplier } from "./utilities/ReplaySpeedMultiplier";

import {
  isAiLeagueReplayRoute,
  isCoworldPlayerRoute,
  isCoworldReplayRoute,
} from "./AiLeagueReplayMode";
import "./components/DesktopNavBar";
import "./components/Footer";
import "./components/MainLayout";
import "./components/MobileNavBar";
import "./components/PlayPage";
import "./components/RankedModal";
import "./components/baseComponents/Button";
import "./components/baseComponents/Modal";
import "./styles.css";
import "./styles/core/typography.css";
import "./styles/core/variables.css";
import "./styles/layout/container.css";
import "./styles/layout/header.css";
import "./styles/modal/chat.css";
// Game-shell-only viewport lock (`body{overflow:hidden}`) — split out of the
// shared `styles.css` so it never leaks into the public app's pages
// (`PublicApp.ts` imports `styles.css` too, but NOT this file). See the
// stylesheet's own header comment for why.
import { isBroadcastReplayPresentation } from "../core/configuration/Colors";
import "./styles/game-shell-scroll-lock.css";

/**
 * `translateText()` (`Utils.ts`) requires a connected `<lang-selector>`
 * element to resolve keys. In the running game shell that element lives
 * inside `Footer.ts`, nested under the header/nav chrome — but the
 * standalone data pages this module mounts via `document.body.
 * replaceChildren(...)` (`openAccountPage`, `openPlayerProfilePage`) wipe
 * that body-nested element out, silently
 * breaking every `translateText()` call on those pages (same failure
 * mode `PublicApp.ts` already solved for the public app entry point).
 * Call this before any such replace so a `<lang-selector>` always
 * survives in `<head>`, which body swaps never touch.
 */
function ensureHeadLangSelector(): void {
  // Checked against `document.head` specifically, never `document`: a
  // body-nested `<lang-selector>` from `Footer.ts` may still be present
  // at this exact call site, an instant before the `replaceChildren`
  // call right after this one destroys it. Only a head-nested element
  // survives that, so only a head-nested element satisfies the guard.
  if (document.head.querySelector("lang-selector")) return;
  document.head.appendChild(document.createElement("lang-selector"));
}

function updateAccountNavButton(userMeResponse: UserMeResponse | false) {
  const button = document.getElementById("nav-account-button");
  if (!button) return;

  const avatarEl = document.getElementById("nav-account-avatar") as
    | (HTMLImageElement & { _navToken?: symbol })
    | null;
  const personIconEl = document.getElementById(
    "nav-account-person-icon",
  ) as SVGElement | null;
  const emailBadgeEl = document.getElementById(
    "nav-account-email-badge",
  ) as HTMLElement | null;
  const signInTextEl = document.getElementById(
    "nav-account-signin-text",
  ) as HTMLSpanElement | null;

  // Unique token for this update call
  const navToken = Symbol();
  if (avatarEl) avatarEl._navToken = navToken;

  const showAvatar = (src: string, alt?: string) => {
    if (avatarEl) {
      avatarEl.alt = alt ?? translateText("main.discord_avatar_alt");
      // If the avatar fails to load (bad URL / CDN issue / offline), fall back
      // to the default sign-in UI instead of leaving a broken image.
      avatarEl.onerror = () => {
        if (avatarEl._navToken !== navToken) return;
        avatarEl.onerror = null;
        avatarEl.src = "https://cdn.discordapp.com/embed/avatars/0.png";
      };
      avatarEl.onload = () => {
        // Only handle if this is the latest update
        if (avatarEl._navToken !== navToken) return;
        // Clear error handler after a successful load.
        avatarEl.onerror = null;
      };
      avatarEl.src = src;
      avatarEl.classList.remove("hidden");
    }
    personIconEl?.classList.add("hidden");
    emailBadgeEl?.classList.add("hidden");
    signInTextEl?.classList.add("hidden");
    button?.classList.remove("border", "border-white/20");
  };

  const showSignIn = () => {
    avatarEl?.classList.add("hidden");
    personIconEl?.classList.remove("hidden");
    emailBadgeEl?.classList.add("hidden");
    signInTextEl?.classList.remove("hidden");
    // Restore border when showing signin state
    button?.classList.add("border", "border-white/20");
  };

  const showEmailLoggedIn = () => {
    avatarEl?.classList.add("hidden");
    personIconEl?.classList.remove("hidden");
    emailBadgeEl?.classList.remove("hidden");
    signInTextEl?.classList.add("hidden");
    button?.classList.add("border", "border-white/20");
  };

  const discord =
    userMeResponse !== false ? userMeResponse.user.discord : undefined;
  if (discord && avatarEl) {
    const avatarAlt = translateText("main.user_avatar_alt", {
      username: discord.username,
    });
    const url = getDiscordAvatarUrl(discord);
    if (url) {
      showAvatar(url, avatarAlt);
      return;
    }
  }

  const email =
    userMeResponse !== false ? userMeResponse.user.email : undefined;
  if (email) {
    showEmailLoggedIn();
    return;
  }

  showSignIn();
}

declare global {
  interface Window {
    GIT_COMMIT: string;
    turnstile: any;
    adsEnabled: boolean;
    PageOS: {
      session: {
        newPageView: () => void;
      };
    };
    ramp: {
      que: Array<() => void>;
      passiveMode: boolean;
      spaAddAds: (ads: Array<{ type: string; selectorId?: string }>) => void;
      destroyUnits: (adType: string | string[]) => Promise<void>;
      settings?: {
        slots?: any;
      };
      spaNewPage: (url?: string) => void;
      spaAds: (config?: {
        ads?: Array<{ type: string; selectorId?: string }>;
        countPageview?: boolean;
        path?: string;
      }) => void;
      // Video ad methods
      onPlayerReady: (() => void) | null;
      addUnits: (units: Array<{ type: string }>) => Promise<void>;
      displayUnits: () => void;
    };
    Bolt: {
      on: (unitType: string, event: string, callback: () => void) => void;
      BOLT_AD_REQUEST_START: string;
      BOLT_AD_IMPRESSION: string;
      BOLT_AD_STARTED: string;
      BOLT_FIRST_QUARTILE: string;
      BOLT_MIDPOINT: string;
      BOLT_THIRD_QUARTILE: string;
      BOLT_AD_COMPLETE: string;
      BOLT_AD_ERROR: string;
      BOLT_AD_PAUSED: string;
      BOLT_AD_CLICKED: string;
      SHOW_HIDDEN_CONTAINER: string;
    };
    currentPageId?: string;
    showPage?: (pageId: string) => void;
  }

  // Extend the global interfaces to include your custom events
  interface DocumentEventMap {
    "join-lobby": CustomEvent<JoinLobbyEvent>;
    "kick-player": CustomEvent;
    "start-game": CustomEvent;
    "join-changed": CustomEvent;
    "open-matchmaking": CustomEvent<undefined>;
    userMeResponse: CustomEvent<UserMeResponse | false>;
    "leave-lobby": CustomEvent;
    "update-game-config": CustomEvent;
  }

  // Fixes the globalThis.addEventListener errors
  interface WindowEventMap {
    "event:user-settings-changed:settings.darkMode": CustomEvent<string>;
  }
}

export interface JoinLobbyEvent {
  // Multiplayer games only have gameID, gameConfig is not known until game starts.
  gameID: string;
  // GameConfig only exists when playing a singleplayer game.
  gameStartInfo?: GameStartInfo;
  // GameRecord exists when replaying an archived game.
  gameRecord?: GameRecord;
  // A Premiere receives only released, hash-verified turns.
  progressiveReplay?: ReplayPremiereProgressiveReplayConfig;
  // Validated fresh-document Clip Preview target for a plain archived replay.
  // LocalServer consumes this before replay pacing begins.
  replayClipPreviewTarget?: number;
  aiLeagueRunID?: string;
  premiereId?: string;
  source?:
    | "public"
    | "private"
    | "host"
    | "matchmaking"
    | "singleplayer"
    | "ai-league-replay"
    | "coworld-replay"
    | "replay-premiere";
  coworldReplayPath?: string;
  publicLobbyInfo?: GameInfo | PublicGameInfo;
}

/**
 * Named (rather than inline on `openAiLeagueReplay`) so the in-place rewind
 * can RETAIN the exact argument set a replay was opened with and re-open from
 * it later without re-deriving anything.
 */
interface AiLeagueReplayOpenOptions {
  source?: Extract<
    JoinLobbyEvent["source"],
    "ai-league-replay" | "coworld-replay"
  >;
  coworldReplayPath?: string;
  artifactBasePath?: string;
  gameRecord?: GameRecord;
  /**
   * Broadcast artifacts already in hand, skipping the network hydrate.
   * The static bundle has no artifact server, so these arrive inline in
   * the replay envelope instead.
   *
   * 0.1.42: `inlineRunResults` is the one of the three with a live consumer
   * (`publishReplayIntegrity`). Upstream deleted the league overlay that read
   * the telemetry and summary — and with it `curatedWarRoomEvents`, the only
   * code that ever turned telemetry into anything a viewer saw — so those two
   * are carried, not consumed. They stay wired because the envelope still
   * ships them and re-homing a curated feed later must not also have to
   * re-thread the plumbing; the alternative was silently dropping the two
   * richest artifacts the bundle contains.
   *
   * The old `loadArtifactDetails` flag went with that overlay: it gated
   * `AiLeagueReplayArtifacts.loadAiLeagueReplayDetails`, which 0.1.42 deletes.
   * No route fetches `replay-ui.json` any more, hosted or bundled — the
   * envelope replaced it as the decision source (see
   * `hydrateHostedBroadcastArtifacts`, which is how a HOSTED route gets one).
   */
  inlineSpectatorTelemetry?: unknown | null;
  inlineMatchSummary?: unknown | null;
  inlineRunResults?: unknown | null;
  /**
   * The hosted route's own copy of the envelope, retained on the rewind
   * context the same way `gameRecord` is: a backward seek re-enters
   * `openAiLeagueReplay` and must not pay for these artifacts twice.
   */
  inlineSpectatorReplay?: unknown | null;
  /**
   * The static envelope parser has published this match's snapshot series to
   * SpectatorReplayStore. Retained across an in-place rewind of the same
   * record; absent on hosted routes, which must clear any prior static match.
   */
  useStaticSpectatorSnapshots?: boolean;
  /**
   * Set only by `rewindReplayInPlace`. This method otherwise ALWAYS raises
   * the boot-style veil (`holdReplayLoadingScreenUntilFirstFrame`, right
   * below) -- correct for a fresh page load, where there is nothing on
   * screen yet to protect. An in-place rewind has a live board with a
   * viewer's attention on it and uses its own treatment instead (the
   * `RewindCurtain` dimmed hold raised by the caller before this method is
   * even entered) -- so for that one call site this flag skips raising the
   * boot veil entirely rather than raising and instantly re-hiding it,
   * which would still be a visible flash and would still fire the
   * `replay_load_started` analytics event for something that is not,
   * conceptually, a load.
   */
  suppressBootCover?: boolean;
}

/**
 * REWIND IN-FLIGHT GUARD — module-level on purpose.
 *
 * A backward seek tears the game down and builds a new one in place, which
 * destroys every layer instance including the scrubber. The only guard this
 * ever had was `BroadcastScrubber`'s own `rewinding` field, and the rebuild
 * mounts a FRESH scrubber whose flag starts false — while `RewindCurtain` over
 * it is `pointer-events: none` by design (it is a hold, not a modal). So the
 * new transport was fully clickable mid-resimulation and a second rewind could
 * start on top of the first: two `openAiLeagueReplay` attempts racing over one
 * document, the loser's listeners already retired by the winner's
 * `replayAttemptCleanup`. Nothing that lives on a layer, a DOM node or an
 * attempt can guard this; only module scope survives the rebuild.
 */
let rewindInFlight = false;

/**
 * Backstop for the flag above: it is normally released the moment the
 * resimulation reaches the target (with the curtain drop). If that frame never
 * arrives — a record that terminates early, or a future change to the one-shot
 * jump this rides on — a stuck flag would leave the transport permanently
 * unable to seek backward, which is worse than the double-rewind it prevents.
 * Three minutes is far beyond the measured worst case (~0.6ms/turn, so ~4s for
 * a 6,000-turn rewind).
 */
const REWIND_GUARD_FAILSAFE_MS = 180_000;

class Client {
  private lobbyHandle: JoinLobbyResult | null = null;
  private eventBus: EventBus = new EventBus();
  private replayLoadingCleanup: (() => void) | null = null;
  private replayAttemptCleanup: (() => void) | null = null;
  private replayPremiereRuntime: ReplayPremiereRuntimeController | null = null;

  /**
   * Everything a backward seek needs to rebuild the CURRENT replay in place,
   * captured the moment its record is in hand.
   *
   * The whole point is `options.gameRecord`: `decompressGameRecord()`
   * (core/Util.ts) expands turns IN PLACE and returns the same object, so this
   * is the identical already-expanded array `LocalServer.replayTurns` is
   * reading. Re-opening from it skips the 6MB `cache: "no-store"` refetch, two
   * JSON.parse passes and a `GameRecordSchema.safeParse` over ~14,000 turns
   * that the old reload-based rewind paid for state that never left memory.
   */
  private replayRewindContext: {
    runID: string;
    options: AiLeagueReplayOpenOptions;
  } | null = null;
  /**
   * Last speed the VIEWER picked, mirrored here because H6: the rewind builds
   * a fresh LocalServer whose `userOverrodeReplaySpeed` latch starts false, so
   * `applyArchivedReplayDefaultSpeed()` would otherwise snap a deliberate 1x
   * back to the broadcast default. sessionStorage already covers this for the
   * reload path, but only for sources that arm `watchReplaySpeedForResume` —
   * never `coworld-replay`, which is exactly the static broadcast bundle the
   * scrubber ships on.
   */
  private lastUserReplaySpeed: ReplaySpeedMultiplier | null = null;

  private currentUrl: string | null = null;

  /** Releases replay-only module state before the SPA returns to live play. */
  private disposeReplaySessionState(): void {
    disposeReplayFrameCache();
    clearSpectatorReplay();
    this.replayRewindContext = null;
  }

  private usernameInput: UsernameInput | null = null;
  private flagInput: FlagInput | null = null;

  private hostModal: HostPrivateLobbyModal;
  private joinModal: JoinLobbyModal;
  private gameModeSelector: GameModeSelector;
  private userSettings: UserSettings = new UserSettings();
  private storeModal: StoreModal;
  private tokenLoginModal: TokenLoginModal;
  private matchmakingModal: MatchmakingModal;
  private mostRecentJoinEvent: number;

  private turnstileTokenPromise: Promise<{
    token: string;
    createdAt: number;
  }> | null = null;

  async initialize(): Promise<void> {
    crazyGamesSDK.maybeInit();
    // Prefetch turnstile token so it is available when
    // the user joins a lobby.
    if (!isCoworldStaticReplayViewer()) {
      this.turnstileTokenPromise = getTurnstileToken();
    }

    // Wait for components to render before setting version
    await customElements.whenDefined("mobile-nav-bar");
    await customElements.whenDefined("desktop-nav-bar");

    const openFrontFont = new FontFace(
      "OpenFront",
      `url(${assetUrl("fonts/OpenFront.ttf")})`,
    );
    document.fonts.add(openFrontFont);
    openFrontFont.load().catch(() => {});

    const versionElements = document.querySelectorAll(
      "#game-version, .game-version-display",
    );
    if (versionElements.length === 0) {
      console.warn("Game version element not found");
    } else {
      const trimmed = version.trim();
      // version.txt ships as a placeholder ("x.xx.xx") that release tooling is
      // meant to overwrite. Until it carries a real (digit-bearing) version,
      // hide the subtitle rather than render the placeholder — in the pixel
      // display font "vx.xx.xx" reads as garbled "VH.HH.HH".
      const hasRealVersion = /\d/.test(trimmed);
      const displayVersion = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
      versionElements.forEach((el) => {
        const host = el as HTMLElement;
        host.style.fontFamily = '"OpenFront", Inter, sans-serif';
        host.style.display = hasRealVersion ? "" : "none";
        host.textContent = hasRealVersion ? displayVersion : "";
      });
    }

    const langSelector = document.querySelector(
      "lang-selector",
    ) as LangSelector;
    if (!langSelector) {
      console.warn("Lang selector element not found");
    }

    this.flagInput = document.querySelector("flag-input") as FlagInput;
    if (!this.flagInput) {
      console.warn("Flag input element not found");
    }

    this.usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput;
    if (!this.usernameInput) {
      console.warn("Username input element not found");
    }

    this.gameModeSelector = document.querySelector(
      "game-mode-selector",
    ) as GameModeSelector;

    window.addEventListener("beforeunload", async () => {
      console.log("Browser is closing");
      this.replayAttemptCleanup?.();
      this.disposeReplaySessionState();
      if (this.lobbyHandle !== null) {
        this.lobbyHandle.stop(true);
        await crazyGamesSDK.gameplayStop();
      }
    });

    document.addEventListener("join-lobby", (event) => {
      const isReplayJoin =
        event.detail.gameRecord !== undefined ||
        event.detail.progressiveReplay !== undefined;
      if (!isReplayJoin || !isAiLeagueReplayRoute()) {
        this.disposeReplaySessionState();
        void this.handleJoinLobby(event);
        return;
      }

      void runReplayStartup(
        () => this.handleJoinLobby(event),
        (error) => {
          this.failReplayLoading(
            event.detail.aiLeagueRunID ?? event.detail.gameID,
            event.detail.source === "coworld-replay"
              ? "coworld-replay"
              : event.detail.source === "replay-premiere"
                ? "replay-premiere"
                : "ai-league-replay",
            "Replay failed to start",
            error,
          );
        },
      );
    });
    document.addEventListener("leave-lobby", this.handleLeaveLobby.bind(this));
    document.addEventListener("kick-player", this.handleKickPlayer.bind(this));
    document.addEventListener("start-game", this.handleStartGame.bind(this));
    document.addEventListener(
      "update-game-config",
      this.handleUpdateGameConfig.bind(this),
    );
    document.addEventListener(
      "open-matchmaking",
      this.handleOpenMatchmaking.bind(this),
    );

    const hlpModal = document.querySelector("help-modal") as HelpModal;
    if (!hlpModal || !(hlpModal instanceof HelpModal)) {
      console.warn("Help modal element not found");
    }
    const giModal = document.querySelector("game-info-modal") as GameInfoModal;
    if (!giModal || !(giModal instanceof GameInfoModal)) {
      console.warn("Game info modal element not found");
    }
    const helpButton = document.getElementById("help-button");
    if (helpButton) {
      helpButton.addEventListener("click", () => {
        if (hlpModal && hlpModal instanceof HelpModal) {
          hlpModal.open();
        }
      });
    }

    const flagInputModal = document.querySelector(
      "flag-input-modal",
    ) as FlagInputModal;
    if (!flagInputModal || !(flagInputModal instanceof FlagInputModal)) {
      console.warn("Flag input modal element not found");
    }

    // Attach listener to any flag-input component (desktop or potentially others)
    document.querySelectorAll("flag-input").forEach((flagInput) => {
      flagInput.addEventListener("flag-input-click", () => {
        if (flagInputModal && flagInputModal instanceof FlagInputModal) {
          flagInputModal.open();
        }
      });
    });

    this.storeModal = document.getElementById("page-item-store") as StoreModal;
    if (!this.storeModal || !(this.storeModal instanceof StoreModal)) {
      console.warn("Store modal element not found");
    }

    const patternsModal = document.getElementById(
      "territory-patterns-modal",
    ) as TerritoryPatternsModal;
    if (!patternsModal || !(patternsModal instanceof TerritoryPatternsModal)) {
      console.warn("Patterns modal element not found");
    }

    // Attach listener to any pattern-input component
    document.querySelectorAll("pattern-input").forEach((patternInput) => {
      patternInput.addEventListener("pattern-input-click", () => {
        patternsModal.open();
      });
    });

    if (isInIframe()) {
      const mobilePat = document.getElementById("pattern-input-mobile");
      if (mobilePat) mobilePat.style.display = "none";
    }

    if (!this.storeModal || !(this.storeModal instanceof StoreModal)) {
      console.warn("Store modal element not found");
    }

    // We no longer need to manually manage the preview button as PatternInput handles it component-side.
    // However, we still want to ensure the modal can be opened.
    // The setupPatternInput above handles the click event for the new buttons.

    this.storeModal.refresh();

    window.addEventListener("showPage", (e: any) => {
      if (typeof e?.detail === "string" && e.detail === "page-play") {
        setTimeout(() => {
          this.storeModal.refresh();
        }, 50);
      }
    });

    this.tokenLoginModal = document.querySelector(
      "token-login",
    ) as TokenLoginModal;
    if (
      !this.tokenLoginModal ||
      !(this.tokenLoginModal instanceof TokenLoginModal)
    ) {
      console.warn("Token login modal element not found");
    }

    this.matchmakingModal = document.querySelector(
      "matchmaking-modal",
    ) as MatchmakingModal;
    if (
      !this.matchmakingModal ||
      !(this.matchmakingModal instanceof MatchmakingModal)
    ) {
      console.warn("Matchmaking modal element not found");
    }

    const onUserMe = async (userMeResponse: UserMeResponse | false) => {
      updateAccountNavButton(userMeResponse);
      const isAdFree =
        userMeResponse !== false && userMeResponse.player?.adfree === true;
      window.adsEnabled = !isAdFree && !crazyGamesSDK.isOnCrazyGames();
      document.dispatchEvent(
        new CustomEvent("userMeResponse", {
          detail: userMeResponse,
          bubbles: true,
          cancelable: true,
        }),
      );

      if (userMeResponse !== false) {
        // Authorized
        console.log(
          `Your player ID is ${userMeResponse.player.publicId}\n` +
            "Sharing this ID will allow others to view your game history and stats.",
        );
      }
    };

    if ((await userAuth()) === false) {
      // Not logged in
      onUserMe(false);
    } else {
      // JWT appears to be valid
      // TODO: Add caching
      getUserMe().then(onUserMe);
    }

    const settingsModal = document.querySelector(
      "user-setting",
    ) as UserSettingModal;
    if (!settingsModal || !(settingsModal instanceof UserSettingModal)) {
      console.warn("User settings modal element not found");
    }
    document
      .getElementById("settings-button")
      ?.addEventListener("click", () => {
        if (settingsModal && settingsModal instanceof UserSettingModal) {
          settingsModal.open();
        }
      });

    this.hostModal = document.querySelector(
      "host-lobby-modal",
    ) as HostPrivateLobbyModal;
    if (!this.hostModal || !(this.hostModal instanceof HostPrivateLobbyModal)) {
      console.warn("Host private lobby modal element not found");
    } else {
      this.hostModal.eventBus = this.eventBus;
    }

    this.joinModal = document.querySelector(
      "join-lobby-modal",
    ) as JoinLobbyModal;
    if (!this.joinModal || !(this.joinModal instanceof JoinLobbyModal)) {
      console.warn("Join lobby modal element not found");
    } else {
      this.joinModal.eventBus = this.eventBus;
    }

    const applyDarkMode = (isDark: boolean) => {
      if (isDark) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    };

    applyDarkMode(this.userSettings.darkMode());

    globalThis.addEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${DARK_MODE_KEY}`,
      (e: CustomEvent<string>) => {
        const isDark = e.detail === "true";
        applyDarkMode(isDark);
      },
    );

    // Attempt to join lobby
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.handleUrl());
    } else {
      this.handleUrl();
    }

    const onHashUpdate = () => {
      // Reset the UI to its initial state
      this.joinModal?.close();

      onJoinChanged();
    };

    const onPopState = () => {
      if (this.currentUrl !== null && this.lobbyHandle !== null) {
        console.info("Game is active");

        if (!this.lobbyHandle.stop()) {
          console.info("Player is active, ask before leaving game");

          const isConfirmed = confirm(
            translateText("help_modal.exit_confirmation"),
          );

          if (!isConfirmed) {
            // Rollback navigator history
            history.pushState(null, "", this.currentUrl);
            return;
          }
        }

        console.info("Player is not active, leave the game immediately");

        crazyGamesSDK.gameplayStop().then(() => {
          // redirect to the home page
          window.location.href = "/";
        });
      } else {
        console.info("Game not active, handle hash update");

        onHashUpdate();
      }
    };

    const onJoinChanged = () => {
      if (this.lobbyHandle !== null) {
        this.handleLeaveLobby();
      }

      // Attempt to join lobby
      this.handleUrl();
    };

    // Handle browser navigation & manual hash edits
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashUpdate);
    window.addEventListener("join-changed", onJoinChanged);

    function updateSliderProgress(slider: HTMLInputElement) {
      const percent =
        ((Number(slider.value) - Number(slider.min)) /
          (Number(slider.max) - Number(slider.min))) *
        100;
      slider.style.setProperty("--progress", `${percent}%`);
    }

    document
      .querySelectorAll<HTMLInputElement>(
        "#bots-count, #private-lobby-bots-count",
      )
      .forEach((slider) => {
        updateSliderProgress(slider);
        slider.addEventListener("input", () => updateSliderProgress(slider));
      });
  }

  private async handleUrl() {
    if (isCoworldStaticReplayViewer()) {
      await this.openCoworldStaticReplay();
      return;
    }

    // The account page is a standalone route with no lobby/game/replay
    // concept behind it — mount it and return before any of the
    // modal-definition waits or lobby-join logic below, none of which it
    // needs. `replaceChildren` is safe here: every link the account page
    // renders is a plain `<a href>` (real navigation, not client-side
    // routing), so nothing downstream ever needs the DOM nodes this
    // clears, and a real navigation away reloads the document anyway.
    if (window.location.pathname === "/account") {
      await this.openAccountPage();
      return;
    }
    // The player profile page is likewise standalone — same reasoning as
    // the account-page branch just above.
    const playerProfileMatch =
      window.location.pathname.match(/^\/player\/([^/]+)$/);
    if (playerProfileMatch !== null) {
      await this.openPlayerProfilePage(
        decodeURIComponent(playerProfileMatch[1]),
      );
      return;
    }
    // Wait for modal custom elements to be defined
    await Promise.all([
      customElements.whenDefined("join-lobby-modal"),
      customElements.whenDefined("host-lobby-modal"),
    ]);

    // Coworld surfaces (Observatory replays / browser player) go straight
    // into the match — never run landing-page hash/SDK logic for them.
    const premiereId = parseReplayPremiereRoute(window.location.pathname);
    if (premiereId !== null) {
      const archived = readReplayPremiereArchivePayload();
      if (archived !== null && archived.premiereId === premiereId) {
        await this.openArchivedReplayPremiere(archived);
      } else {
        await this.openReplayPremiere(premiereId);
      }
      return;
    }
    if (isCoworldPlayerRoute()) {
      await this.openCoworldPlayer();
      return;
    }
    if (isCoworldReplayRoute()) {
      await this.openCoworldReplay();
      return;
    }

    // Check if CrazyGames SDK is enabled first (no hash needed in CrazyGames)
    if (crazyGamesSDK.isOnCrazyGames()) {
      const lobbyId = await crazyGamesSDK.getInviteGameId();
      console.log("got game id", lobbyId);
      if (lobbyId && GAME_ID_REGEX.test(lobbyId)) {
        console.log("game parsed successfully");
        // Wait 2 seconds to ensure all elements are actually loaded,
        // On low end-chromebooks the join modal was not registered in time.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        window.showPage?.("page-join-lobby");
        this.joinModal?.open(lobbyId);
        console.log(`CrazyGames: joining lobby ${lobbyId} from invite param`);
        return;
      }
    }
    crazyGamesSDK.isInstantMultiplayer().then((isInstant) => {
      if (isInstant) {
        console.log(
          `CrazyGames: joining instant multiplayer lobby from CrazyGames`,
        );
        this.hostModal.open();
      }
    });

    const strip = () =>
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );

    const alertAndStrip = (message: string) => {
      alert(message);
      strip();
    };

    const hash = window.location.hash;

    // Decode the hash first to handle encoded characters
    const decodedHash = decodeURIComponent(hash);
    const params = new URLSearchParams(decodedHash.split("?")[1] || "");

    // Handle different hash sections
    if (decodedHash.startsWith("#purchase-completed")) {
      // Parse params after the ?
      const status = params.get("status");

      if (status !== "true") {
        alertAndStrip("purchase failed");
        return;
      }

      const type = params.get("type");
      if (type === "currency_pack") {
        alertAndStrip(translateText("store.currency_pack_purchase_success"));
        return;
      }

      const cosmeticName = params.get("cosmetic");
      if (!cosmeticName) {
        alert("Something went wrong. Please contact support.");
        console.error("purchase-completed but no pattern name");
        return;
      }

      const setCosmetic = () => {
        if (cosmeticName.startsWith("pattern:")) {
          this.userSettings.setSelectedPatternName(cosmeticName);
        } else if (cosmeticName.startsWith("flag:")) {
          this.userSettings.setFlag(cosmeticName);
        }
      };
      const token = params.get("login-token");

      if (token) {
        strip();
        window.addEventListener("beforeunload", () => {
          // The page reloads after token login, so we need to save the pattern name
          // in case it is unset during reload.
          setCosmetic();
        });
        this.tokenLoginModal.openWithToken(token);
      } else {
        alertAndStrip(`purchase succeeded: ${cosmeticName}`);
        setCosmetic();
        this.storeModal.refresh();
      }
      return;
    }

    if (decodedHash.startsWith("#token-login")) {
      const token = params.get("token-login");

      if (!token) {
        alertAndStrip(
          `login failed! Please try again later or contact support.`,
        );
        return;
      }

      strip();
      this.tokenLoginModal.openWithToken(token);
      return;
    }

    const pathMatch = window.location.pathname.match(
      /^\/(?:w\d+\/)?game\/([^/]+)/,
    );
    const aiLeagueReplayMatch = window.location.pathname.match(
      /^\/(?:ai-league-replay|proxywar-replay|openfront-replay)\/([^/]+)/,
    );
    if (aiLeagueReplayMatch) {
      await this.openAiLeagueReplay(decodeURIComponent(aiLeagueReplayMatch[1]));
      return;
    }
    const lobbyId =
      pathMatch && GAME_ID_REGEX.test(pathMatch[1]) ? pathMatch[1] : null;
    if (lobbyId) {
      window.showPage?.("page-join-lobby");
      this.joinModal.open(lobbyId);
      console.log(`joining lobby ${lobbyId}`);
      return;
    }
    if (decodedHash.startsWith("#affiliate=")) {
      const affiliateCode = decodedHash.replace("#affiliate=", "");
      strip();
      if (affiliateCode) {
        this.storeModal?.open(affiliateCode);
      }
    }
    if (decodedHash.startsWith("#refresh")) {
      window.location.href = "/";
    }

    // Handle requeue parameter for ranked matchmaking
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.has("requeue")) {
      // Remove only the requeue parameter, preserving other params and hash
      searchParams.delete("requeue");
      const newUrl =
        window.location.pathname +
        (searchParams.toString() ? "?" + searchParams.toString() : "") +
        window.location.hash;
      history.replaceState(null, "", newUrl);
      // Wait for matchmaking button to be defined, then trigger its click handler.
      customElements.whenDefined("matchmaking-button").then(() => {
        const matchmakingButton = document.querySelector(
          "matchmaking-button button",
        ) as HTMLButtonElement | null;
        if (matchmakingButton) {
          matchmakingButton.click();
        } else {
          console.warn(
            "Requeue requested, but matchmaking button not found in DOM.",
          );
        }
      });
    }
  }

  /**
   * Mounts the standalone `/account` page. Deliberately NOT routed through
   * any replay-runtime machinery — there is no replay, session, or WASM
   * engine behind this route, only a data page over `/api/account`. The custom
   * element is registered by the static `AccountPage` import above.
   */
  private async openAccountPage(): Promise<void> {
    ensureHeadLangSelector();
    document.body.replaceChildren(
      document.createElement("premiere-account-page"),
    );
  }

  /**
   * Mounts the standalone `/player/:name` league profile page — the
   * destination the public league standings link to. Same reasoning as
   * `openAccountPage` just above: no lobby/game/replay concept behind
   * it, only a data page over `/api/players/:name`. The custom element
   * is registered by the static `PlayerProfilePage` import above.
   */
  private async openPlayerProfilePage(name: string): Promise<void> {
    ensureHeadLangSelector();
    const page = document.createElement("player-profile-page");
    page.setAttribute("name", name);
    document.body.replaceChildren(page);
  }

  /**
   * Mounts the themed "this premiere has ended" page in place of the
   * ordinary game/replay engine — the honest destination for a
   * `premiere_not_found` bootstrap failure (see `openReplayPremiere`'s
   * catch block below), replacing what used
   * to be a raw JSON document Chrome's own viewer rendered before the
   * server ever got the chance to serve this app shell at all (see
   * `ReplayPremierePublicPage.ts`'s content-negotiated 404 branch). Same
   * "standalone data page, no lobby/replay concept" shape as
   * `openAccountPage` just above, but reached via the SAME cleanup path
   * a genuine `failReplayLoading` would take (releasing the loading veil
   * and the in-flight runtime attempt) rather than that method's own
   * generic "Replay unavailable" failure screen.
   */
  private openPremiereEndedPage(premiereId: string): void {
    this.replayLoadingCleanup?.();
    this.replayLoadingCleanup = null;
    this.replayAttemptCleanup?.();
    this.disposeReplaySessionState();
    // `showReplayLoadingScreen` (already active by this point on both
    // callers) marks `document.documentElement` with the CSS class that
    // hides every OTHER body child until a real frame/ready state lifts
    // it (index.html's `proxywar-replay-booting` rule) — `replaceChildren`
    // below removes the veil element itself but never that class, so
    // without this the freshly-mounted page would render fully correct
    // markup that CSS keeps invisible. Same lift `finishVeil()` already
    // does for every OTHER terminal outcome.
    finishReplayLoadingScreen();
    ensureHeadLangSelector();
    const page = document.createElement("premiere-ended-page");
    page.setAttribute("premiere-id", premiereId);
    document.body.replaceChildren(page);
  }

  /**
   * Renders an archived premiere's durable results-summary page: the polished
   * results overlay from the persisted summary, plus a best-effort render of the
   * ordinary league replay behind it. The overlay renders immediately and stands
   * alone if the underlying replay has aged off the mirror.
   */
  private async openArchivedReplayPremiere(
    payload: ReplayPremiereArchivePayload,
  ): Promise<void> {
    // The archived-results skin is retired: an archived premiere is the
    // ordinary league replay under the plain OpenFront HUD. When the replay
    // has aged off the mirror there is nothing left to play, so the themed
    // premiere-ended page is the honest destination.
    if (payload.replayRunKey !== null) {
      try {
        await this.openAiLeagueReplay(payload.replayRunKey, {
          source: "ai-league-replay",
        });
        return;
      } catch (error) {
        console.warn("Archived premiere replay unavailable", error);
        finishReplayLoadingScreen();
      }
    }
    this.openPremiereEndedPage(payload.premiereId);
  }

  private async openReplayPremiere(premiereId: string): Promise<void> {
    this.replayAttemptCleanup?.();
    this.replayLoadingCleanup?.();

    // Premiere-specific veil hold. Unlike ordinary replays this must NOT lift
    // on the first rendered frame: a live join first renders turn 0 and then
    // free-runs to the entry position — the veil covers that entire sync so
    // the viewer never sees the turn-0 map, the catch-up blur, or the
    // teleport. It lifts per lifecycle state below.
    showReplayLoadingScreen("replay_premiere.loading_premiere");
    let veilFinished = false;
    let veilSlowTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!veilFinished) {
        showReplayLoadingScreen("ai_league_replay.loading_slow");
      }
    }, REPLAY_LOADING_SLOW_TIMEOUT_MS);
    const clearVeilSlowTimer = () => {
      if (veilSlowTimer !== null) {
        clearTimeout(veilSlowTimer);
        veilSlowTimer = null;
      }
    };
    // Honest, INACTIVITY-based join-sync watchdog (not a fixed deadline):
    // see `createJoinSyncWatchdog`'s own doc for the full rationale --
    // a catch-up on a backlogged market can legitimately take longer
    // than JOIN_SYNC_TIMEOUT_MS while still actively converging, so a
    // fixed one-shot timer used to fire regardless, latching a "Replay
    // unavailable" failure OVER a sync that was still advancing (the
    // turn counter kept climbing behind the dishonest error).
    const joinSyncWatchdog = createJoinSyncWatchdog({
      onStalled: () => {
        if (!veilFinished) showReplayLoadingFailure();
      },
      onRecovered: () => {
        // The underlying sync recovered after a latched stall notice --
        // clear the dishonest-looking failure and resume the honest
        // veil instead of leaving "Replay unavailable" up over a join
        // that is actively making progress again.
        if (!veilFinished)
          showReplayLoadingScreen("replay_premiere.joining_live");
      },
    });
    const onVeilReplayError = () => {
      if (veilFinished) return;
      veilFinished = true;
      clearVeilSlowTimer();
      showReplayLoadingFailure();
    };
    document.addEventListener(
      "ai-league-replay-load-error",
      onVeilReplayError,
      {
        once: true,
      },
    );
    const releaseVeilHold = () => {
      clearVeilSlowTimer();
      document.removeEventListener(
        "ai-league-replay-load-error",
        onVeilReplayError,
      );
    };
    const finishVeil = () => {
      if (veilFinished) return;
      veilFinished = true;
      joinSyncWatchdog.clear();
      releaseVeilHold();
      setReplayLoadingProgress(null);
      finishReplayLoadingScreen();
      if (this.replayLoadingCleanup === releaseVeilHold) {
        this.replayLoadingCleanup = null;
      }
    };
    this.replayLoadingCleanup = releaseVeilHold;

    let active = true;
    let projectionMounted = false;
    const runtime = new ReplayPremiereRuntimeController({
      premiereId,
      onProjectionReady: (projection) => {
        if (!active || this.replayPremiereRuntime !== runtime) return;
        projectionMounted = true;
        if (
          projection.state === "playing" ||
          projection.state === "checkpoint"
        ) {
          // Live join: keep the veil up with join-sync messaging until the
          // runtime reports the trail-buffered entry position is reached
          // (onJoinSync "complete" below).
          if (!veilFinished) {
            clearVeilSlowTimer();
            showReplayLoadingScreen("replay_premiere.joining_live");
            // Independent of the (now-cleared) slow-load timer above: a
            // join that never converges must still surface Retry/Back
            // rather than hang indefinitely with nothing reachable. Left
            // running (not `veilFinished`-gated) so a join that genuinely
            // finishes late still lifts the veil normally afterward.
            joinSyncWatchdog.arm();
          }
          return;
        }
        if (
          projection.state === "revealed" ||
          projection.state === "archived"
        ) {
          // Post-reveal pages intentionally replay from the start; lift on
          // the first rendered frame like an ordinary replay.
          const onFirstFrame = () => finishVeil();
          document.addEventListener("ai-league-replay-frame", onFirstFrame, {
            once: true,
          });
          return;
        }
        if (projection.state === "scheduled") {
          // The retired premiere skin rendered a countdown page here; the
          // veil itself is now the pre-live surface until the runtime
          // advances to the live join.
          if (!veilFinished) {
            clearVeilSlowTimer();
            showReplayLoadingScreen("replay_premiere.waiting_for_start");
          }
          return;
        }
        // Terminal failure/cancel before any playback: the themed
        // premiere-ended page is the honest destination now that the skin's
        // failure panels are retired.
        if (!veilFinished) {
          veilFinished = true;
          joinSyncWatchdog.clear();
          this.openPremiereEndedPage(premiereId);
        }
      },
      onJoinSync: (update) => {
        if (!active || this.replayPremiereRuntime !== runtime) return;
        if (update.state === "complete") {
          finishVeil();
          return;
        }
        if (veilFinished) return;
        joinSyncWatchdog.recordProgress(update.currentTurn);
        if (joinSyncWatchdog.stalled) return;
        setReplayLoadingProgress(
          update.currentTurn === null
            ? translateText("replay_premiere.join_sync_target", {
                target: update.targetTurn,
              })
            : translateText("replay_premiere.join_sync_progress", {
                current: update.currentTurn,
                target: update.targetTurn,
                percent: Math.min(
                  100,
                  Math.max(
                    0,
                    Math.floor((update.currentTurn / update.targetTurn) * 100),
                  ),
                ),
              }),
        );
      },
      onJoinReady: (request) => {
        if (
          !active ||
          this.replayPremiereRuntime !== runtime ||
          request.premiereId !== premiereId
        ) {
          return;
        }
        document.dispatchEvent(
          new CustomEvent("join-lobby", {
            detail: {
              gameID: request.gameID,
              gameStartInfo: request.gameStartInfo,
              progressiveReplay: request.progressiveReplay,
              source: "replay-premiere",
              premiereId,
            } satisfies JoinLobbyEvent,
            bubbles: true,
            composed: true,
          }),
        );
      },
      onRevealSeek: (turn) => {
        if (!active || this.replayPremiereRuntime !== runtime) return;
        this.eventBus.emit(new ReplayJumpToTurnEvent(turn));
      },
    });
    const cleanupAttempt = () => {
      if (!active) return;
      active = false;
      joinSyncWatchdog.clear();
      runtime.dispose();
      if (this.replayPremiereRuntime === runtime) {
        this.replayPremiereRuntime = null;
      }
      if (this.replayAttemptCleanup === cleanupAttempt) {
        this.replayAttemptCleanup = null;
      }
    };
    this.replayPremiereRuntime = runtime;
    this.replayAttemptCleanup = cleanupAttempt;

    try {
      await runtime.start();
    } catch (error) {
      if (!active || this.replayPremiereRuntime !== runtime) return;
      if (projectionMounted) {
        console.error("Replay Premiere runtime stopped", error);
        return;
      }
      if (
        error instanceof ReplayPremiereNetworkError &&
        error.code === "premiere_not_found"
      ) {
        this.openPremiereEndedPage(premiereId);
        return;
      }
      this.failReplayLoading(
        premiereId,
        "replay-premiere",
        "Replay Premiere failed to start",
        error,
      );
    }
  }

  /**
   * A broadcast side artifact, or null if it is not there.
   *
   * Deliberately NOT routed through `failReplayLoading`: these enrich the
   * replay, they are not the replay. `null` is a first-class answer — a
   * premiere still filling in, a match whose extras rotated off the mirror
   * ahead of its record, or a route that never published them at all. The
   * caller's `?? null` fallbacks all already mean "no beats / no decisions",
   * which is exactly right and strictly better than a dead board.
   *
   * The abort signal is the ATTEMPT's, so a leave or a rewind mid-flight
   * cancels these with everything else rather than resolving into a page that
   * has moved on.
   */
  private async fetchBroadcastSideArtifact(
    url: string,
    signal: AbortSignal,
  ): Promise<unknown | null> {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      if (signal.aborted) return null;
      console.warn(`Broadcast side artifact unavailable: ${url}`, error);
      return null;
    }
  }

  private async openAiLeagueReplay(
    runID: string,
    options: AiLeagueReplayOpenOptions = {},
  ) {
    this.replayAttemptCleanup?.();
    this.replayLoadingCleanup?.();
    // See `AiLeagueReplayOpenOptions.suppressBootCover`'s own doc: every
    // route into this method except the in-place rewind wants the ordinary
    // boot veil, held until the first rendered frame of the new attempt.
    this.replayLoadingCleanup = options.suppressBootCover
      ? null
      : holdReplayLoadingScreenUntilFirstFrame(undefined, undefined, runID);

    const artifactBasePath =
      options.artifactBasePath ??
      `/ai-league-runs/${encodeURIComponent(runID)}`;
    const attemptController = new AbortController();
    const attemptCleanups: Array<() => void> = [];
    const cleanupAttempt = () => {
      attemptController.abort();
      for (const cleanup of attemptCleanups.splice(0)) cleanup();
      if (this.replayAttemptCleanup === cleanupAttempt) {
        this.replayAttemptCleanup = null;
      }
    };
    this.replayAttemptCleanup = cleanupAttempt;
    let gameRecord = options.gameRecord;
    if (gameRecord === undefined) {
      const recordTimeout = setTimeout(
        () => attemptController.abort("Replay record request timed out"),
        REPLAY_LOADING_SLOW_TIMEOUT_MS,
      );
      attemptCleanups.push(() => clearTimeout(recordTimeout));

      let recordResponse: Response;
      try {
        recordResponse = await fetch(`${artifactBasePath}/game-record.json`, {
          signal: attemptController.signal,
        });
      } catch (error) {
        if (this.replayAttemptCleanup !== cleanupAttempt) return;
        this.failReplayLoading(
          runID,
          options.source,
          "Replay record request failed",
          error,
        );
        return;
      }
      if (!recordResponse.ok) {
        try {
          const spectatorResponse = await fetch(
            `${artifactBasePath}/spectator.html`,
            {
              method: "HEAD",
              signal: attemptController.signal,
            },
          );
          if (spectatorResponse.ok) {
            cleanupAttempt();
            window.location.replace(`${artifactBasePath}/spectator.html`);
            return;
          }
        } catch (error) {
          console.warn("Replay timeline fallback request failed", error);
        }

        this.failReplayLoading(
          runID,
          options.source,
          `Replay record returned HTTP ${recordResponse.status}`,
        );
        return;
      }

      let recordJson: unknown;
      try {
        recordJson = await recordResponse.json();
      } catch (error) {
        this.failReplayLoading(
          runID,
          options.source,
          "Replay record is not valid JSON",
          error,
        );
        return;
      }

      const parsed = GameRecordSchema.safeParse(recordJson);
      if (!parsed.success) {
        this.failReplayLoading(
          runID,
          options.source,
          "Replay record failed schema validation",
          parsed.error,
        );
        return;
      }
      gameRecord = parsed.data;
      clearTimeout(recordTimeout);
    }

    /**
     * THE WHY ARTIFACTS, on the hosted route.
     *
     * The static bundle carries the envelope and the telemetry inline, so the
     * Coworld surface lit up the analyst drawer, the dossier's "last decision,
     * and why", the war-room toasts and the scrubber's beat markers. Nothing
     * fetched them on `/ai-league-replay/` — 0.1.42 deleted the hosted artifact
     * loader along with the league overlay, and the envelope path that replaced
     * it was only ever wired into `openCoworldStaticReplay`. Same match, same
     * mirror, and proxywar.xyz rendered a bare board while Coworld rendered the
     * broadcast: the drawer hid itself (`[data-on="0"]`, correctly — it had no
     * decisions), the toasts had nothing to say, and the scrubber had no beats.
     *
     * The artifacts were published the whole time (`spectator-replay.json`,
     * `spectator-telemetry.json`, beside the `game-record.json` fetched above);
     * only the fetch was missing. ~200 KB compressed for the pair against the
     * bundle's own 836 KB, so this is hydrate-and-wait rather than a
     * progressive fill: `mountBroadcastBeats` below consumes the telemetry
     * ONCE at mount, and a late arrival would leave the beat feed permanently
     * empty on exactly the surfaces this exists to fill.
     *
     * Best-effort by construction. A 404, a parse failure or a timeout costs
     * the WHY surfaces and nothing else — the board still plays. That matters
     * most for the premiere and rotated-off-the-mirror routes, where a replay
     * legitimately outlives its side artifacts.
     */
    if (options.useStaticSpectatorSnapshots !== true) {
      const [spectatorReplay, spectatorTelemetry] = await Promise.all([
        options.inlineSpectatorReplay !== undefined
          ? Promise.resolve(options.inlineSpectatorReplay)
          : this.fetchBroadcastSideArtifact(
              `${artifactBasePath}/spectator-replay.json`,
              attemptController.signal,
            ),
        options.inlineSpectatorTelemetry !== undefined
          ? Promise.resolve(options.inlineSpectatorTelemetry)
          : this.fetchBroadcastSideArtifact(
              `${artifactBasePath}/spectator-telemetry.json`,
              attemptController.signal,
            ),
      ]);
      // A newer attempt (or a leave) landed while those were in flight; its
      // own cleanup already owns the page. Publishing now would hand the new
      // match this one's decisions.
      if (this.replayAttemptCleanup !== cleanupAttempt) return;
      options = { ...options, inlineSpectatorReplay: spectatorReplay };
      if (options.inlineSpectatorTelemetry === undefined) {
        options = { ...options, inlineSpectatorTelemetry: spectatorTelemetry };
      }
    }

    // The record is now in hand however it got here (fetched above, or handed
    // in by the static bundle). Retaining it is what makes a backward seek a
    // ~4s resimulation instead of a 15-25s page load — see the field's doc.
    // The side artifacts ride along for the same reason: a rewind re-enters
    // this method and must not refetch what this attempt already holds.
    this.replayRewindContext = { runID, options: { ...options, gameRecord } };

    // Publish the match's SCHEDULED end (gameRecord.info.num_turns) where the
    // broadcast clock can read it. The first attempt piped this through the
    // catch-up event's turnsTotal — but that event only carries a non-null
    // detail DURING catch-up, and a straight linear playthrough never enters
    // catch-up, so the clock silently never armed. A body dataset is passive:
    // no timing dependency, no event plumbing, absent entirely in live play.
    document.body.dataset.pwReplayTotalTurns = String(
      gameRecord.info.num_turns,
    );
    // ...and taken back off when this attempt is torn down, because "absent
    // entirely in live play" is only true if someone removes it. This client
    // is a single-page app: `handleLeaveLobby` is stop() + replaceState with
    // NO page reload, so a key left on <body> outlives the replay and is still
    // there when the next LIVE match mounts its HUD — which read it and counted
    // a live FFA down from this record's turn count instead of the engine's
    // maxTimerValue. `attemptCleanups` is the right home rather than the leave
    // handler alone: `handleLeaveLobby` drains exactly this list (via
    // `replayAttemptCleanup`), and so do `failReplayLoading` and a
    // non-premiere `handleJoinLobby`, so one push covers every exit from a
    // replay. Safe for the in-place rewind, which re-enters this method: the
    // drain happens at the top of the new attempt and the line above rewrites
    // the key long before any renderer reads it, and `rewindReplayInPlace` has
    // already taken its own copy (see its note there) before that point.
    attemptCleanups.push(() => {
      delete document.body.dataset.pwReplayTotalTurns;
    });

    // The decision store is the WHY surfaces' single source (dossier decision
    // line, toast reasons, analyst drawer). Republished on every entry so an
    // in-place rewind re-entering here wipes the previous match's log instead
    // of leaking it across games.
    //
    // ...but the wipe cannot be UNCONDITIONAL, because it must always be
    // followed by a refill. The only other refill lived in
    // `openCoworldStaticReplay`, which a rewind never re-enters — it calls
    // this method directly. So the first backward seek permanently deleted the
    // agent rationale for the rest of the session: an empty analyst drawer and
    // no "last decision, and why" on the dossier, which on this product is the
    // whole differentiator.
    //
    // `SpectatorReplayStore` is module-level and holds the envelope's own
    // (richer) decision log from parse time, so it survives the rebuild and is
    // the right refill source on every entry, not just the first. Hosted
    // routes clear the store explicitly before reading it: a static -> hosted
    // SPA transition must never inherit the previous match's series.
    //
    // 0.1.42 NOTE: this used to mirror the league overlay's own network
    // hydrate (`replay-ui.json` via `AiLeagueReplayArtifacts`). Upstream
    // deleted both the overlay and that artifact loader, so the envelope is
    // now the ONLY decision source on every route, not just the bundle.
    if (options.useStaticSpectatorSnapshots !== true) {
      // Clear THEN refill from this attempt's own envelope (hydrated above, or
      // carried on the rewind context). The clear is what stops a previous
      // match's log leaking across an SPA transition; without the refill right
      // behind it the hosted route would keep the empty store it has had since
      // 0.1.42 deleted the artifact loader.
      clearSpectatorReplay();
      if (
        options.inlineSpectatorReplay !== null &&
        options.inlineSpectatorReplay !== undefined
      ) {
        publishSpectatorReplay(options.inlineSpectatorReplay);
      }
    }
    publishReplayDecisions(
      decisionsFromSpectatorSnapshots(spectatorReplaySnapshots()),
    );
    // The run's own decision tallies, for the surfaces that report whether
    // this match was actually agent-driven. Published beside the decisions
    // because they answer the same question at two scales: this is what one
    // agent decided, and this is how often the agents decided at all.
    publishReplayIntegrity(options.inlineRunResults ?? null);

    /**
     * THE CURATED BEATS, and the consumer `inlineSpectatorTelemetry` spent
     * 0.1.42 waiting for.
     *
     * 0.1.42 deleted `AiLeagueReplayOverlay.ts`, and the beat curation lived
     * INSIDE it rather than in `BroadcastComposition.ts` — so the telemetry
     * threaded through this method reached nothing, and three of our own
     * surfaces went dark with it: `WarRoomToasts` harvests
     * `.broadcast-war-room-item`, `BroadcastScrubber` and `LullDirector`
     * harvest `.broadcast-timeline-marker`. `BroadcastBeats.ts` is that
     * curation, re-homed; its host renders the two incumbent regions
     * off-screen purely so those harvesters have real DOM to read.
     *
     * `inlineMatchSummary` deliberately stays unconsumed: its only 0.1.35
     * readers were the deleted overlay's details header, roster and share
     * card — chrome our own surfaces replaced outright, not data any beat is
     * derived from. Passing it here would be plumbing to nowhere.
     *
     * Per-attempt, disposed with the attempt, so an in-place rewind rebuilds
     * one host rather than accumulating a feed per seek.
     */
    attemptCleanups.push(
      mountBroadcastBeats({
        runID,
        spectatorTelemetry: options.inlineSpectatorTelemetry ?? null,
        // The whole-match series artifact is unreachable on every 0.1.42
        // route (upstream deleted the artifact loader with the overlay), so
        // lead-change beats always come from the envelope's own snapshots via
        // `SpectatorReplayStore` — see `aiLeagueLeadChangeBeats`.
        matchStateSeries: null,
        replayMaxTurn: initialReplayClipRenderableThroughTurn(gameRecord.info),
        // Free-text negotiation, off the record's own delivered intents (the
        // turn stream, never the runner's accepted flag) — the MESSAGE beat
        // cards' only source. Empty on every pre-freetext record.
        agentMessages: recordedAgentMessages(gameRecord),
      }).dispose,
    );

    // Plain OpenFront HUD only — the custom league skin is retired. The
    // retention milestones it carried live on in ReplayWatchAnalytics.
    attemptCleanups.push(
      mountReplayWatchAnalytics({
        matchId: runID,
        totalTurns: gameRecord.turns.length,
      }),
    );

    /**
     * THE PLAYHEAD, tracked off the same per-frame event every other replay
     * subsystem in this method already rides (see
     * `ReplayPositionPersistence.ts`'s doc for why that event is always the
     * right subscription). `onReplayJump` below has to know where the viewer
     * IS before it can tell a forward jump from a resimulation, and nothing
     * else in this scope has it: `JoinLobbyResult` exposes only
     * `stop`/`prestart`/`join`, never the GameView. Per-attempt, so a rewind's
     * rebuilt match counts from its own turn 0 instead of inheriting the
     * pre-rewind playhead.
     */
    let renderedReplayTurn = 0;
    const trackRenderedTurn = (event: Event) => {
      const turnNumber = (event as CustomEvent<{ turnNumber?: unknown }>).detail
        ?.turnNumber;
      if (typeof turnNumber === "number" && Number.isFinite(turnNumber)) {
        renderedReplayTurn = turnNumber;
      }
    };
    document.addEventListener("ai-league-replay-frame", trackRenderedTurn);

    /**
     * THE ONE SEEK POLICY, and the reason it lives here.
     *
     * Every surface that wants to move the playhead dispatches
     * `ai-league-replay-jump-turn`: the scrubber, the analyst drawer
     * (AnalystDrawer.ts:131), the jump controls and EVERY timeline marker
     * (AiLeagueReplayOverlay.ts:1215 / :4850 in 0.1.35; that file is gone in
     * 0.1.42, the markers with it), the premiere archive view
     * (ReplayPremiereArchiveView.ts:132) and the auto-pacer (LullDirector.ts:
     * 511). Only the scrubber ever branched forward-vs-backward, so from all
     * the others a backward ask reached `LocalServer.jumpReplayForward()` —
     * which clamps to `Math.max(this.turns.length, ...)` and CANNOT move
     * backward — and was a silent no-op with no feedback at all. The analyst
     * drawer lists decisions newest-first across the whole match, so most of
     * its visible rows are behind the playhead: most of the drawer was dead,
     * as was every timeline marker left of the playhead.
     *
     * So the branch is here, once, and no dispatcher gets an opinion about it.
     * `REPLAY_SEEK_DEAD_ZONE_TURNS` is the engine's own reach (its doc in
     * BroadcastScrubber.ts has the derivation): anything nearer than that in
     * either direction is somewhere playback is about to be anyway, and paying
     * a resimulation for it would be absurd — those fall through to the
     * forward emit, where the engine clamps them to a no-op.
     */
    const onReplayJump = (event: Event) => {
      const turnNumber = (event as CustomEvent<{ turnNumber?: number }>).detail
        ?.turnNumber;
      if (typeof turnNumber !== "number" || !Number.isFinite(turnNumber)) {
        return;
      }
      const target = Math.max(0, Math.floor(turnNumber));
      if (target < renderedReplayTurn - REPLAY_SEEK_DEAD_ZONE_TURNS) {
        this.seekReplayBackward(target);
        return;
      }
      this.eventBus.emit(new ReplayJumpToTurnEvent(target));
    };
    const onReplayPause = (event: Event) => {
      const paused = (event as CustomEvent<{ paused?: boolean }>).detail
        ?.paused;
      this.eventBus.emit(new PauseGameIntentEvent(paused !== false));
    };
    /**
     * The backward half of the transport. Forward is a seek the engine can do
     * (`onReplayJump` above -> `LocalServer.jumpReplayForward`); backward is
     * not — there is no rewind in the engine, so the match has to be run again
     * from turn 0. What changed is that "again from turn 0" no longer means a
     * page load.
     *
     * `preventDefault()` is the answer back to the dispatcher: the scrubber
     * reads `dispatchEvent()`'s return value and falls back to its original
     * `location.replace(?turn=N)` when nothing here claimed the seek (no
     * retained record — a replay that never reached `openAiLeagueReplay`'s
     * record-in-hand point can only be rebuilt by reloading).
     */
    const onReplayRewind = (event: Event) => {
      const turnNumber = (event as CustomEvent<{ turnNumber?: number }>).detail
        ?.turnNumber;
      if (typeof turnNumber !== "number" || !Number.isFinite(turnNumber)) {
        return;
      }
      if (this.replayRewindContext === null) return;
      event.preventDefault();
      void this.rewindReplayInPlace(Math.max(1, Math.floor(turnNumber)));
    };
    document.addEventListener("ai-league-replay-jump-turn", onReplayJump);
    document.addEventListener("ai-league-replay-pause", onReplayPause);
    document.addEventListener("ai-league-replay-rewind-turn", onReplayRewind);
    // The scrubber's drag-preview frame cache starts capturing with the same
    // per-frame event everything above rides on. Armed HERE — the one point
    // every replay entry path (archived, static bundle, rewind re-entry)
    // funnels through with the other document-level replay listeners — and
    // NOT in attemptCleanups: the cache and its listener are module-scoped
    // and deliberately OUTLIVE the attempt, because a rewind replays the
    // same deterministic match and the frames stay true. The installer is
    // idempotent for the same runID and atomically resets frames plus pending
    // encodes when a different match enters this SPA.
    installReplayFrameCapture(runID);
    attemptCleanups.push(() => {
      document.removeEventListener("ai-league-replay-jump-turn", onReplayJump);
      document.removeEventListener("ai-league-replay-pause", onReplayPause);
      document.removeEventListener(
        "ai-league-replay-rewind-turn",
        onReplayRewind,
      );
      document.removeEventListener("ai-league-replay-frame", trackRenderedTurn);
    });

    // H6's mirror (see `lastUserReplaySpeed`). Registered per attempt and
    // taken back off with it, so this never accumulates across rewinds the way
    // the handlers it exists to compensate for used to.
    const onUserSpeedPick = (event: ReplaySpeedChangeEvent) => {
      if (event.source !== "user") return;
      this.lastUserReplaySpeed = event.replaySpeedMultiplier;
    };
    this.eventBus.on(ReplaySpeedChangeEvent, onUserSpeedPick);
    attemptCleanups.push(() =>
      this.eventBus.off(ReplaySpeedChangeEvent, onUserSpeedPick),
    );

    const replaySearchParams = new URLSearchParams(window.location.search);
    const requestedTurn = Number(replaySearchParams.get("turn"));
    const previewTarget = replayClipPreviewTarget(window.location.search);
    if (
      previewTarget === null &&
      Number.isFinite(requestedTurn) &&
      requestedTurn > 0
    ) {
      const jumpAfterFirstFrame = () => {
        this.eventBus.emit(new ReplayJumpToTurnEvent(requestedTurn));
        document.removeEventListener(
          "ai-league-replay-frame",
          jumpAfterFirstFrame,
        );
      };
      document.addEventListener("ai-league-replay-frame", jumpAfterFirstFrame);
      attemptCleanups.push(() =>
        document.removeEventListener(
          "ai-league-replay-frame",
          jumpAfterFirstFrame,
        ),
      );
    }

    // P2 fix (2026-08-02): refresh-resume for archived Full Replay -- see
    // ReplayPositionPersistence.ts's own doc. An explicit `?turn=` URL
    // param (just above) is a deliberate share-link target and always
    // wins; resume only applies when the visitor arrived with no such
    // param. Never for `coworld-replay` (a distinct lightweight replay
    // source with no equivalent "leave and come back" viewing pattern).
    // The LullDirector install below reads this flag: a scheduled resume
    // jump is a viewer's own place in the match, and the intro skip must
    // never race it to the first frame.
    let resumeTurnScheduled = false;
    if (
      options.source !== "coworld-replay" &&
      !(
        previewTarget === null &&
        Number.isFinite(requestedTurn) &&
        requestedTurn > 0
      )
    ) {
      const resumeTurn = loadResumableReplayTurn(runID);
      // A viewer who already watched to the end wants a rewatch, not an
      // instant winner banner over seemingly dead playback controls —
      // resume only positions meaningfully before the final recorded turn.
      const lastRecordedTurn =
        gameRecord.turns.length > 0
          ? gameRecord.turns[gameRecord.turns.length - 1].turnNumber
          : 0;
      if (resumeTurn !== null && resumeTurn < lastRecordedTurn - 50) {
        // The intro skip must stand down when the viewer is being returned
        // to a remembered position (see installLullDirector's allowIntroSkip).
        resumeTurnScheduled = true;
        const resumeAfterFirstFrame = () => {
          this.eventBus.emit(new ReplayJumpToTurnEvent(resumeTurn));
          document.removeEventListener(
            "ai-league-replay-frame",
            resumeAfterFirstFrame,
          );
        };
        document.addEventListener(
          "ai-league-replay-frame",
          resumeAfterFirstFrame,
        );
        attemptCleanups.push(() =>
          document.removeEventListener(
            "ai-league-replay-frame",
            resumeAfterFirstFrame,
          ),
        );
      }
    }
    if (options.source !== "coworld-replay") {
      attemptCleanups.push(watchReplayPositionForResume(runID));
    }

    // P0 fix (2026-08-03): restore the viewer's own last manually-picked
    // speed across the `?turn=` backward-seek reload path -- see
    // ReplaySpeedPersistence.ts's own doc for why an in-memory-only record
    // of the pick can't survive a real page reload. Excluded the same way
    // position-resume/clip-preview are: `coworld-replay` has no equivalent
    // session, and a clip preview's target speed is an explicit render
    // parameter, never a viewer pick to restore. Re-applied through the
    // SAME `ReplaySpeedChangeEvent` `source: "user"` path a live
    // in-session speed change already uses (not a separate bypass), so
    // downstream consumers see an identical event to a fresh manual pick.
    if (options.source !== "coworld-replay" && previewTarget === null) {
      const persistedSpeed = loadPersistedReplaySpeed(runID);
      if (persistedSpeed !== null) {
        const restoreSpeedAfterFirstFrame = () => {
          this.eventBus.emit(
            new ReplaySpeedChangeEvent(persistedSpeed, "user"),
          );
          document.removeEventListener(
            "ai-league-replay-frame",
            restoreSpeedAfterFirstFrame,
          );
        };
        document.addEventListener(
          "ai-league-replay-frame",
          restoreSpeedAfterFirstFrame,
        );
        attemptCleanups.push(() =>
          document.removeEventListener(
            "ai-league-replay-frame",
            restoreSpeedAfterFirstFrame,
          ),
        );
      }
      attemptCleanups.push(watchReplaySpeedForResume(runID, this.eventBus));
    }

    // AUTO-PACING (LullDirector.ts): the intro skip + PaintBot-style
    // fast-forward through quiet stretches. Armed HERE, with the rest of
    // this attempt's document-level replay listeners, because this is the
    // one point that has everything the director needs in hand at once: the
    // decompression-shared GameRecord (its intent stream is the lull
    // signal), the page EventBus (its speed changes ride the same
    // ReplaySpeedChangeEvent channel the panel and LocalServer use), and —
    // for the intro-skip gate — the ?turn= deep link, the clip-preview
    // target and the resume schedule, all already resolved just above. The
    // dispose rides attemptCleanups like every other listener, so an
    // in-place rewind retires this director with its attempt and arms a
    // fresh one (whose intro skip stays off: the rewind path writes ?turn=
    // into the URL before re-entering here).
    attemptCleanups.push(
      installLullDirector({
        gameRecord,
        eventBus: this.eventBus,
        allowIntroSkip:
          previewTarget === null &&
          !(Number.isFinite(requestedTurn) && requestedTurn > 0) &&
          !resumeTurnScheduled,
      }),
    );

    document.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: gameRecord.info.gameID,
          gameRecord,
          source: options.source ?? "ai-league-replay",
          aiLeagueRunID: runID,
          coworldReplayPath: options.coworldReplayPath,
          replayClipPreviewTarget: previewTarget ?? undefined,
        } satisfies JoinLobbyEvent,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * The backward half of the one seek policy (see `onReplayJump`). Backward is
   * a resimulation — there is no rewind in the engine — so it is either the
   * in-place rebuild below or, for an attempt that never reached the point
   * where the record is retained, the `?turn=` reload that rebuild replaced.
   *
   * The scrubber used to own this decision AND this fallback privately, which
   * is exactly why the other four dispatchers had no backward seek at all.
   * It now dispatches like everything else and this is the only implementation.
   */
  private seekReplayBackward(target: number): void {
    const turn = Math.max(1, Math.floor(target));
    if (this.replayRewindContext !== null) {
      void this.rewindReplayInPlace(turn);
      return;
    }
    // No retained record. Unreachable in practice — the context is assigned in
    // `openAiLeagueReplay` before any of these listeners exist — but a
    // backward seek silently doing nothing is the entire defect this policy
    // exists to remove, so the honest slow path stays.
    const url = new URL(window.location.href);
    url.searchParams.set("turn", String(turn));
    window.location.replace(url.toString());
  }

  /**
   * BACKWARD SEEK WITHOUT A PAGE LOAD.
   *
   * Measured before: 15-25 seconds, essentially none of it simulation. The
   * `?turn=` reload refetched a 6MB `.replay` with `cache: "no-store"`, ran
   * two JSON.parse passes and a `GameRecordSchema.safeParse` over ~14,000
   * turns, and re-initialised the whole page — to rebuild state that had never
   * left memory. The resimulation itself measured ~0.6ms/turn (3,300 turns in
   * ~2s), so a 6,000-turn rewind is ~4s of real work.
   *
   * What is REBUILT rather than reused, and why it has to be: GameView is
   * constructed fresh through the ordinary join path because none of it
   * survives a rewind — `_players` is insert-only (an eliminated competitor
   * would linger frozen at its death-time snapshot), `_units` keys collide
   * once `GameImpl._nextUnitID` restarts at 1, and `_map` is a Uint16Array
   * mutated in place, so every tile the rewound range never touches would keep
   * its FUTURE owner. Only the immutable game RECORD is carried over.
   *
   * Routed through `openAiLeagueReplay` rather than a hand-rolled
   * `joinLobby()` call: that method's `replayAttemptCleanup` correctly retires
   * the previous attempt's overlay, listeners and position-persistence watcher
   * and re-arms them, and its existing `?turn=` branch is exactly the one-shot
   * first-frame jump this needs — so the rewind adds no second mechanism for
   * "start a replay and land on turn N".
   *
   * Never reached in live play: the only dispatcher is the broadcast
   * scrubber, and the listener that calls this exists only for the duration of
   * an `openAiLeagueReplay` attempt.
   *
   * THE LOADING TREATMENT lives entirely in `RewindCurtain.ts`, raised and
   * dropped by this method only — never the boot-style veil
   * `openAiLeagueReplay` raises for every other entry point (see
   * `AiLeagueReplayOpenOptions.suppressBootCover`'s own doc), and never the
   * outgoing map left on screen to visibly re-simulate itself from turn 0.
   * Product decision, verbatim: "Dimmed hold — keep the last frame, dim it,
   * overlay REWINDING TO 13:50 with a real progress bar (turn N of M). Never
   * the boot screen, never the racing map."
   */
  private async rewindReplayInPlace(targetTurn: number): Promise<void> {
    const context = this.replayRewindContext;
    if (context === null) return;
    // ONE REWIND AT A TIME — see `rewindInFlight`'s doc for why the flag has
    // to be module-level (the rebuild destroys every instance that could
    // otherwise hold it, and the curtain does not block input).
    if (rewindInFlight) return;
    rewindInFlight = true;
    const guardFailsafe = window.setTimeout(() => {
      rewindInFlight = false;
    }, REWIND_GUARD_FAILSAFE_MS);
    const releaseRewindGuard = () => {
      window.clearTimeout(guardFailsafe);
      rewindInFlight = false;
    };
    // Kept in sync with the URL bar before anything else so a manual refresh
    // mid-rewind lands where the viewer asked to go — and so this same URL is
    // the honest fallback target if the in-place path fails below.
    const url = new URL(window.location.href);
    url.searchParams.set("turn", String(targetTurn));
    // Captured HERE, before anything below touches the outgoing game: once
    // `stop()` runs, the renderer tears down and the board canvas's backing
    // store is zeroed (a fresh `width`/`height`, the idiomatic "clear the
    // bitmap"), so a reference taken any later paints a blank rectangle
    // instead of the last real frame. `RewindCurtain` blits this into its
    // own canvas the instant it is raised and never reads it again, so the
    // live canvas tearing down a moment later cannot flicker the curtain.
    //
    // `"body > canvas"` and not a bare `"canvas"`: the board is the one canvas
    // mounted directly on <body> (GameRenderer.initialize's appendChild) while
    // the curtain's own canvas and the scrubber's drag preview live nested in
    // their overlay divs. A back-to-back rewind therefore had a curtain root
    // already ahead of the board in document order, and the bare selector
    // would blit the PREVIOUS curtain's frozen frame into the new one. Same
    // selector, same reasoning, as `ReplayFrameCache.ts:260` — they disagreed.
    const lastFrame =
      document.querySelector<HTMLCanvasElement>("body > canvas");
    // Same reasoning, same reason it has to happen before `stop()`:
    // `installFollowedCompetitor` resets its module-level follow state to
    // null on every install, and the outgoing renderer's disposal (inside
    // `stop()`) is what triggers that reset for the instance being replaced
    // here. Whoever the viewer was following has to be read off before this
    // point or it is simply gone — there is nothing left to restore from.
    const followedSmallId = followedCompetitorSmallId();
    // The whole match's turn count, not this seek's target -- read from the
    // OUTGOING instance's dataset write (`openAiLeagueReplay`'s own doc on
    // `pwReplayTotalTurns`), which is stable across a rewind because a
    // rewind never changes which match is playing, only where in it the
    // viewer is. Falls back to `targetTurn` only if that dataset write is
    // somehow missing, so the progress caption never divides by zero.
    const totalTurnsRaw = Number(document.body.dataset.pwReplayTotalTurns);
    const totalTurns =
      Number.isFinite(totalTurnsRaw) && totalTurnsRaw > 0
        ? totalTurnsRaw
        : targetTurn;
    let curtain: ReturnType<typeof raiseRewindCurtain> | null = null;
    try {
      // The curtain goes up BEFORE the outgoing game is stopped. A rewind is
      // seconds of nothing; the one thing that must never happen is a viewer
      // left staring at a board that has silently stopped moving with
      // nothing overlaid to explain it.
      //
      // DESTINATION PREVIEW: when the frame cache holds a picture at or
      // before the seek target (it usually does — the first watch captured
      // frames on the way through), the curtain paints THAT instead of the
      // outgoing frame: a ~3s resimulation reads as arriving where the
      // viewer asked to go, not staring at where they came from. `null`
      // falls back to the pre-existing outgoing-frame behaviour exactly
      // (the curtain option is additive/optional).
      const destination = nearestFrameAtOrBefore(targetTurn);
      curtain = raiseRewindCurtain({
        targetTurn,
        totalTurns,
        lastFrame,
        destination,
      });
      // Stop FIRST, then re-arm below. The outgoing game is still emitting
      // `ai-league-replay-frame` until its runner is stopped — arming the
      // curtain's own frame listener before this would let a frame from the
      // game being torn down retire it early.
      if (this.lobbyHandle !== null) {
        this.lobbyHandle.stop(true, true);
        this.lobbyHandle = null;
      }
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      const options: AiLeagueReplayOpenOptions = {
        ...context.options,
        // The static bundle deliberately restores its own URL on join
        // (`handleJoinLobby`'s `preserveCoworldReplayUrl` branch) from the
        // path captured when it opened — which predates the `?turn=` just
        // written above and would quietly drop it.
        ...(context.options.coworldReplayPath !== undefined
          ? { coworldReplayPath: url.pathname + url.search }
          : {}),
        // The curtain raised above IS this attempt's loading treatment;
        // without this, `openAiLeagueReplay` would still raise its own
        // boot-style veil underneath it for the (synchronous, in this path)
        // moment before the code below can react — a flash of the very
        // thing this whole feature exists to avoid. See the option's doc.
        suppressBootCover: true,
      };
      await this.openAiLeagueReplay(context.runID, options);

      // Drives the curtain's progress bar off the SAME per-frame event the
      // rest of this file's replay machinery already reads (position-resume,
      // speed-resume, the `?turn=` jump itself) rather than a bespoke timer —
      // see `ReplayPositionPersistence.ts`'s own doc for why that event is
      // always the right one to subscribe to. Registered after the restart
      // is underway, same footing `restoreSpeedAfterFirstFrame` below
      // already relies on: no frame can land in between, since everything
      // above this point is synchronous once the record is in hand. Not
      // `{ once: true }` — this has to see every frame of the resimulation,
      // not just the first, and removes itself once the target is reached.
      const raisedCurtain = curtain;
      const onRewindFrame = (event: Event) => {
        const turnNumber = (event as CustomEvent<{ turnNumber?: unknown }>)
          .detail?.turnNumber;
        if (typeof turnNumber !== "number" || !Number.isFinite(turnNumber)) {
          return;
        }
        raisedCurtain.updateProgress(turnNumber);
        // `>=` rather than `===`: the one-shot jump this rides on
        // (`openAiLeagueReplay`'s own `?turn=` branch) lands on exactly
        // `targetTurn`, but guarding with `>=` means a future change to that
        // mechanism landing slightly past the target still retires the
        // curtain instead of leaving it stranded.
        if (turnNumber >= targetTurn) {
          document.removeEventListener("ai-league-replay-frame", onRewindFrame);
          raisedCurtain.drop();
          // The viewer gets the transport back at exactly the moment the
          // curtain comes off, not a frame before it.
          releaseRewindGuard();
        }
      };
      document.addEventListener("ai-league-replay-frame", onRewindFrame);

      // Selection persistence: restored as EARLY as the rebuilt instance
      // allows, then kept trying until it sticks. Early matters — the dossier
      // and camera gating read `followedCompetitorSmallId()` live each tick,
      // so an early restore means following is active for the whole
      // resimulation, not just once playback lands. But the first rendered
      // frame is near turn 0, and `GameView._players` is populated as the
      // resim's update batches arrive — a competitor who spawns later does
      // not EXIST yet at frame one, `restoreFollowedCompetitor` would no-op
      // (its lookup THROWS for unknown ids, so it commits nothing), and a
      // fire-once listener would silently lose the follow. So: retry each
      // frame until the id resolves and commits, giving up only when the
      // catch-up reaches the target (if the player is not registered by
      // then, the id really is stale).
      //
      // TWO BUGS THAT MADE THE RETRY LOOP ABOVE A LIE, both fixed here:
      // the registration carried `{ once: true }`, so it fired against frame
      // one (near turn 0, before a late-spawning competitor exists), committed
      // nothing and was gone — the follow was silently lost after EVERY
      // rewind, which is precisely what the paragraph above says must not
      // happen. And the give-up test read `detail.turn`, a field this event
      // does not have: `ClientGameRunner.ts:828` dispatches `turnNumber` (and
      // `tick`), so the `?? 0` fallback made `turn >= targetTurn` false
      // forever. The listener removes itself from inside, on the commit status
      // `restoreFollowedCompetitor` returns for exactly this purpose.
      const restoreFollowAfterFirstFrame = (event: Event) => {
        const done = restoreFollowedCompetitor(followedSmallId);
        const turn = Number(
          (event as CustomEvent<{ turnNumber?: number }>).detail?.turnNumber ??
            0,
        );
        if (done || turn >= targetTurn) {
          document.removeEventListener(
            "ai-league-replay-frame",
            restoreFollowAfterFirstFrame,
          );
        }
      };
      document.addEventListener(
        "ai-league-replay-frame",
        restoreFollowAfterFirstFrame,
      );

      // H6. Armed after the restart is underway (no frame can land in
      // between — everything above is synchronous once the record is in hand)
      // and re-emitted as a `"user"` pick because that is precisely what it
      // is: the same event a fresh manual pick sends, which is what re-latches
      // `LocalServer.userOverrodeReplaySpeed` against the archived-replay
      // default speed the new instance is about to apply.
      const restoreSpeed = this.lastUserReplaySpeed;
      if (restoreSpeed !== null) {
        const restoreSpeedAfterFirstFrame = () => {
          document.removeEventListener(
            "ai-league-replay-frame",
            restoreSpeedAfterFirstFrame,
          );
          this.eventBus.emit(new ReplaySpeedChangeEvent(restoreSpeed, "user"));
        };
        document.addEventListener(
          "ai-league-replay-frame",
          restoreSpeedAfterFirstFrame,
          { once: true },
        );
      }
    } catch (error) {
      // A failed rewind must never leave the viewer on a dead board: the old
      // game is already stopped by this point, so there is nothing to recover
      // to in-page. Fall back to the behaviour this replaced -- but the
      // curtain has to come down FIRST, or the navigation below would leave
      // it painted over the last thing rendered before the browser tears the
      // document down, which on a slow navigation can be visible for a beat.
      curtain?.drop();
      releaseRewindGuard();
      console.error("In-place replay rewind failed, reloading instead", error);
      window.location.replace(url.toString());
    }
  }

  private async openCoworldStaticReplay(): Promise<void> {
    showReplayLoadingScreen("ai_league_replay.loading_replay");
    try {
      const replay = await loadCoworldStaticReplay();
      await this.openAiLeagueReplay(replay.runID, {
        source: "coworld-replay",
        coworldReplayPath: window.location.pathname + window.location.search,
        artifactBasePath: ".",
        gameRecord: replay.gameRecord,
        inlineSpectatorTelemetry: replay.spectatorTelemetry,
        inlineMatchSummary: replay.matchSummary,
        inlineRunResults: replay.runResults,
        useStaticSpectatorSnapshots: true,
      });
      // NOTHING FETCHES replay-ui.json ANY MORE — the bundle is offline by
      // design and 0.1.42 deleted the hosted artifact loader with the league
      // overlay — so the WHY surfaces (dossier decision line, toast reasons,
      // analyst drawer) would sit empty forever without this. The envelope
      // itself carries a RICHER log — the spectatorReplay snapshots hold 240
      // decisions on the real fixture versus the 60 the network artifact
      // sampled — so feed the store from what the parser already retained.
      // AFTER openAiLeagueReplay: its mount publishes an empty array first
      // (the rewind-wipe), and this must land on top of that wipe, not under
      // it.
      publishReplayDecisions(
        decisionsFromSpectatorSnapshots(spectatorReplaySnapshots()),
      );
    } catch (error) {
      this.failReplayLoading(
        "static-coworld-replay",
        "coworld-replay",
        "Static Coworld replay failed to load",
        error,
      );
    }
  }

  private async openCoworldReplay() {
    const coworldReplayPath = window.location.pathname + window.location.search;
    showReplayLoadingScreen("ai_league_replay.waiting_for_replay");
    const slowTimer = setTimeout(
      () => showReplayLoadingScreen("ai_league_replay.loading_slow"),
      REPLAY_LOADING_SLOW_TIMEOUT_MS,
    );

    while (true) {
      try {
        const response = await fetch("../coworld/replay-info", {
          cache: "no-store",
        });
        if (response.ok) {
          const info = await response.json();
          if (info.ready === true && typeof info.runID === "string") {
            clearTimeout(slowTimer);
            showReplayLoadingScreen("ai_league_replay.loading_replay");
            await this.openAiLeagueReplay(info.runID, {
              source: "coworld-replay",
              coworldReplayPath,
              artifactBasePath: `../ai-league-runs/${encodeURIComponent(
                info.runID,
              )}`,
            });
            return;
          }
        }
      } catch (error) {
        console.warn("Coworld replay status request failed", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private failReplayLoading(
    runID: string,
    _source:
      | "ai-league-replay"
      | "coworld-replay"
      | "replay-premiere"
      | undefined,
    message: string,
    error?: unknown,
  ): void {
    this.replayLoadingCleanup?.();
    this.replayLoadingCleanup = null;
    this.replayAttemptCleanup?.();
    this.disposeReplaySessionState();
    showReplayLoadingFailure();
    console.error(`${message} for run ${runID}`, error);
  }

  private async openCoworldPlayer() {
    mountCoworldPlayerOverlay();
    await this.openCoworldReplay();
  }

  private async handleJoinLobby(event: CustomEvent<JoinLobbyEvent>) {
    const lobby = event.detail;
    // P0 REOPEN fix (pass-4 repro, 2026-08-02): captured immediately, before
    // any of this method's `await`s (`getRuntimeClientServerConfig()`,
    // `userAuth()`, `getPlayerCosmeticsRefs()`, `getTurnstileToken()`, then
    // `joinLobby()`/`LocalServer.start()`'s own synchronous cascade back
    // into this same event loop turn). A live re-read of
    // `window.location.pathname` after that chain observably does NOT
    // reliably reflect the real hard-navigation URL by the time
    // `lobbyHandle.join.then()` below runs — a live-browser repro confirmed
    // it can transiently read back as `/` right at that point even on a
    // direct hard navigation straight to `/ai-league-replay/:runID` (root
    // cause not fully isolated; downstream of one of those awaits, not this
    // file). Snapshotting here, closest to the real navigation commit and
    // before anything async can interfere, is what "did the browser already
    // land on this path" should actually mean.
    const pathnameAtJoinStart = window.location.pathname;
    const hashAtJoinStart = window.location.hash;
    if (
      lobby.source !== "replay-premiere" &&
      this.replayPremiereRuntime !== null
    ) {
      this.replayAttemptCleanup?.();
    }
    this.mostRecentJoinEvent = event.timeStamp;
    if (
      lobby.gameRecord === undefined &&
      lobby.progressiveReplay === undefined &&
      this.usernameInput &&
      !this.usernameInput.validateOrShowError()
    ) {
      return;
    }

    console.log(`joining lobby ${lobby.gameID}`);
    if (this.lobbyHandle !== null) {
      console.log("joining lobby, stopping existing game");
      this.lobbyHandle.stop(true);
      document.body.classList.remove("in-game");
    }
    if (lobby.source === "public") {
      this.joinModal?.open(lobby.gameID, lobby.publicLobbyInfo);
    }
    const config = await getRuntimeClientServerConfig();
    // Only update URL immediately for private lobbies, not public ones
    if (
      lobby.source !== "public" &&
      lobby.gameRecord === undefined &&
      lobby.progressiveReplay === undefined
    ) {
      this.updateJoinUrlForShare(lobby.gameID, config);
    }
    const auth = await userAuth();
    const playerRole = auth !== false ? (auth.claims.role ?? null) : null;
    const clipPreviewTarget =
      lobby.gameRecord !== undefined &&
      lobby.progressiveReplay === undefined &&
      lobby.aiLeagueRunID !== undefined &&
      Number.isSafeInteger(lobby.replayClipPreviewTarget) &&
      (lobby.replayClipPreviewTarget ?? 0) > 0
        ? lobby.replayClipPreviewTarget!
        : null;
    const newLobbyHandle = joinLobby(this.eventBus, {
      gameID: lobby.gameID,
      serverConfig: config,
      cosmetics: await getPlayerCosmeticsRefs(),
      turnstileToken: await this.getTurnstileToken(lobby),
      playerName: this.usernameInput?.getUsername() ?? genAnonUsername(),
      playerClanTag: this.usernameInput?.getClanTag() ?? null,
      playerRole,
      gameStartInfo: lobby.gameStartInfo ?? lobby.gameRecord?.info,
      gameRecord: lobby.gameRecord,
      progressiveReplay: lobby.progressiveReplay,
      replayClipPreviewTarget: clipPreviewTarget ?? undefined,
    });

    if (this.mostRecentJoinEvent !== event.timeStamp) {
      newLobbyHandle.stop(true);
      console.warn("Join requested, but was superseded");
      return;
    }

    this.lobbyHandle = newLobbyHandle;

    this.lobbyHandle.prestart.then(() => {
      console.log("Closing modals");
      document.getElementById("settings-button")?.classList.add("hidden");
      if (this.usernameInput) {
        // fix edge case where username-validation-error is re-rendered and hidden tag removed
        this.usernameInput.validationError = "";
      }
      document
        .getElementById("username-validation-error")
        ?.classList.add("hidden");
      this.joinModal?.closeWithoutLeaving();
      [
        "single-player-modal",
        "host-lobby-modal",
        "game-starting-modal",
        "game-top-bar",
        "help-modal",
        "user-setting",
        "troubleshooting-modal",
        "territory-patterns-modal",
        "store-modal",
        "language-modal",
        "news-modal",
        "flag-input-modal",
        "account-button",
        "leaderboard-button",
        "token-login",
        "matchmaking-modal",
        "clan-modal",
        "lang-selector",
        "homepage-promos",
      ].forEach((tag) => {
        const modal = document.querySelector(tag) as HTMLElement & {
          close?: () => void;
          isModalOpen?: boolean;
        };
        if (modal?.close) {
          modal.close();
        } else if (modal && "isModalOpen" in modal) {
          modal.isModalOpen = false;
        }
      });
      this.gameModeSelector.stop();
      document.querySelectorAll(".ad").forEach((ad) => {
        (ad as HTMLElement).style.display = "none";
      });

      crazyGamesSDK.loadingStart();

      // show when the game loads
      const startingModal = document.querySelector(
        "game-starting-modal",
      ) as GameStartingModal;
      if (startingModal && startingModal instanceof GameStartingModal) {
        startingModal.show();
      }
    });

    this.lobbyHandle.join.then(() => {
      this.joinModal?.closeWithoutLeaving();
      this.gameModeSelector.stop();
      incrementGamesPlayed();

      document.querySelectorAll(".ad").forEach((ad) => {
        (ad as HTMLElement).style.display = "none";
      });

      if (
        lobby.source !== "ai-league-replay" &&
        lobby.source !== "coworld-replay" &&
        lobby.source !== "replay-premiere" &&
        window.PageOS?.session?.newPageView
      ) {
        window.PageOS.session.newPageView();
      }
      crazyGamesSDK.loadingStop();
      crazyGamesSDK.gameplayStart();
      document.body.classList.add("in-game");

      const preserveCoworldReplayUrl = lobby.source === "coworld-replay";
      // Ensure there's a homepage entry in history before adding the lobby
      // entry. P0 fix (found live 2026-08-02): the hash-only guard below
      // fired on ANY page with no hash, including a replay/premiere
      // page the user re-joined via Back/Forward (none of those carry a
      // hash either) — `replaceState`ing the CURRENT entry there silently
      // rewrote an already-legitimate history entry to `#refresh`,
      // orphaning whatever the browser's session history expected to sit
      // there. Clicking Forward afterward tried to resolve that now-
      // mutated entry and failed ("History entry not found"). Only mark
      // the homepage entry when we are actually ON a plain content page
      // (never one of this same function's own target shapes below), so
      // a re-join from an existing replay/game/premiere entry leaves that
      // entry's identity untouched.
      // Snapshotted at `handleJoinLobby`'s own start (see
      // `pathnameAtJoinStart`'s doc) rather than re-read live here — by
      // this point several `await`s deep, `window.location.pathname` can
      // no longer be trusted to still reflect the real navigation.
      const alreadyOnOwnTargetShape =
        isReplayOrGamePathShape(pathnameAtJoinStart);
      if (
        !preserveCoworldReplayUrl &&
        !alreadyOnOwnTargetShape &&
        (hashAtJoinStart === "" || hashAtJoinStart === "#")
      ) {
        history.replaceState(null, "", window.location.origin + "#refresh");
      }
      const lobbyIdHidden = !this.userSettings.lobbyIdVisibility();
      if (lobby.progressiveReplay !== undefined && lobby.premiereId) {
        const premierePath = `/premiere/${encodeURIComponent(lobby.premiereId)}`;
        if (pathnameAtJoinStart !== premierePath) {
          history.replaceState(
            null,
            "",
            `${premierePath}${window.location.search}`,
          );
        }
      } else if (lobby.gameRecord !== undefined && lobby.aiLeagueRunID) {
        if (!preserveCoworldReplayUrl) {
          // P0 REOPEN fix (pass-3 repro, 2026-08-02): this used to push
          // UNCONDITIONALLY, unlike the premiere branch just above (which
          // already guards on `pathname !== premierePath`). On a fresh
          // hard navigation straight to `/ai-league-replay/<runID>` (the
          // exact repro: home -> click a replay link -> the anchor
          // is a plain, un-intercepted <a> causing a REAL page load), this
          // join flow's `pushState` fired again for the SAME url the
          // browser had already registered its own real navigation entry
          // for, 2.5-5s after `onload` — Chrome's "no session-history
          // entry created for a pushState this far past onload without
          // fresh user activation" heuristic (Chromium issue 330744614)
          // then silently dropped that push, desyncing the page's
          // believed history depth from the browser's real stack. Native
          // Back (lands on the real, pre-existing entry) followed by
          // Forward then failed with "History entry not found" — the
          // browser trying to resolve a stack slot that was never
          // actually created. Guarding on path equality, same as the
          // premiere branch, means a fresh direct/hard load never pushes
          // a redundant entry; a genuine in-app join (arriving from a
          // DIFFERENT path, e.g. a modal-driven join with no prior URL
          // change) still gets its first real pushState here, unaffected.
          const replayPath = `/ai-league-replay/${encodeURIComponent(lobby.aiLeagueRunID)}`;
          if (pathnameAtJoinStart !== replayPath) {
            // We did NOT start on this exact path (a genuine in-app join
            // arriving from a different page, e.g. a modal-driven join)
            // -- this is the first real history entry for it, as close to
            // the triggering user gesture as this async chain gets, so
            // `pushState` (adds a new entry) is correct and safe here.
            if (
              shouldPushAiLeagueReplayHistoryEntry(
                pathnameAtJoinStart,
                replayPath,
              )
            ) {
              history.pushState(null, "", replayPath);
            }
          } else if (window.location.pathname !== replayPath) {
            // We DID start on this exact path (the real hard-navigation
            // entry `pathnameAtJoinStart` already captured) -- the browser
            // already owns a valid, real session-history entry for it. If
            // `window.location.pathname` no longer matches by now, some
            // other in-page mutation moved the live URL out from under us
            // during this method's own `await`s (observed live, root cause
            // not fully isolated -- see `pathnameAtJoinStart`'s doc).
            // `replaceState` corrects the CURRENT entry in place rather
            // than adding a new one, so it can never produce the orphaned/
            // dropped-pushState desync above -- and it matters beyond the
            // URL bar: `isAiLeagueReplayRoute()` (used live by
            // `ClientGameRunner.dispatchAiLeagueReplayFrame` and others)
            // reads `window.location.pathname` fresh on every call, so a
            // drifted URL silently starves the replay of its own
            // `ai-league-replay-frame` events -- confirmed live: the
            // loading veil never lifts, stuck on "Loading replay…"
            // indefinitely.
            history.replaceState(null, "", replayPath);
          }
        } else if (lobby.coworldReplayPath !== undefined) {
          history.replaceState(null, "", lobby.coworldReplayPath);
        }
        const runtimeWindow = window as typeof window & {
          __openFrontPromoCaptureLock?: boolean;
        };
        if (runtimeWindow.__openFrontPromoCaptureLock === true) {
          this.eventBus.emit(new PauseGameIntentEvent(true));
        } else if (clipPreviewTarget === null) {
          // The broadcast surface opens at a watchable 2x, not the analyst
          // skim speed — same rule as LocalServer.applyArchivedReplayDefault-
          // Speed(), applied on both sides of the emit/subscribe race that
          // function's doc describes.
          const broadcastPresentation = isBroadcastReplayPresentation();
          this.eventBus.emit(
            new ReplaySpeedChangeEvent(
              broadcastPresentation
                ? ReplaySpeedMultiplier.fast
                : ReplaySpeedMultiplier.fastest,
              "auto",
            ),
          );
        } else {
          console.log(
            "[DEBUG] Main.ts NOT emitting fastest, clipPreviewTarget=",
            clipPreviewTarget,
          );
        }
      } else {
        history.pushState(
          null,
          "",
          lobbyIdHidden
            ? "/streamer-mode"
            : `/${config.workerPath(lobby.gameID)}/game/${lobby.gameID}?live`,
        );
      }

      // Store current URL for popstate confirmation
      this.currentUrl = window.location.href;
    });
  }

  private updateJoinUrlForShare(
    lobbyId: string,
    config: Awaited<ReturnType<typeof getRuntimeClientServerConfig>>,
  ) {
    const lobbyIdHidden = !this.userSettings.lobbyIdVisibility();
    const targetUrl = lobbyIdHidden
      ? "/streamer-mode"
      : `/${config.workerPath(lobbyId)}/game/${lobbyId}`;
    const currentUrl = window.location.pathname;

    if (currentUrl !== targetUrl) {
      history.replaceState(null, "", targetUrl);
    }
  }

  private async handleLeaveLobby(event?: CustomEvent) {
    this.replayAttemptCleanup?.();
    this.replayAttemptCleanup = null;
    this.disposeReplaySessionState();
    if (this.lobbyHandle === null) {
      return;
    }
    console.log("leaving lobby, cancelling game");
    this.lobbyHandle.stop(true);
    this.lobbyHandle = null;
    this.currentUrl = null;

    try {
      history.replaceState(null, "", "/");
    } catch (e) {
      console.warn("Failed to restore URL on leave:", e);
    }

    document.body.classList.remove("in-game");

    if (this.joinModal.isOpen()) {
      this.joinModal.close();
      if (event?.detail.cause === "full-lobby") {
        window.dispatchEvent(
          new CustomEvent("show-message", {
            detail: {
              message: translateText("public_lobby.join_timeout"),
              color: "red",
              duration: 3500,
            },
          }),
        );
      }
    }

    crazyGamesSDK.gameplayStop();
  }

  private handleOpenMatchmaking(_event: CustomEvent<undefined>) {
    this.matchmakingModal?.open();
  }

  private handleKickPlayer(event: CustomEvent) {
    const { target } = event.detail;

    // Forward to eventBus if available
    if (this.eventBus) {
      this.eventBus.emit(new SendKickPlayerIntentEvent(target));
    }
  }

  private handleStartGame() {
    if (this.eventBus) {
      this.eventBus.emit(new SendStartGameEvent());
    }
  }

  private handleUpdateGameConfig(event: CustomEvent) {
    const { config } = event.detail;

    // Forward to eventBus if available
    if (this.eventBus) {
      this.eventBus.emit(new SendUpdateGameConfigIntentEvent(config));
    }
  }

  private async getTurnstileToken(
    lobby: JoinLobbyEvent,
  ): Promise<string | null> {
    const config = await getRuntimeClientServerConfig();
    if (
      lobby.gameRecord !== undefined ||
      lobby.progressiveReplay !== undefined ||
      config.env() === GameEnv.Dev ||
      lobby.gameStartInfo?.config.gameType === GameType.Singleplayer
    ) {
      return null;
    }

    // Always request a new token on crazygames.
    if (this.turnstileTokenPromise === null || crazyGamesSDK.isOnCrazyGames()) {
      console.log("No prefetched turnstile token, getting new token");
      return (await getTurnstileToken())?.token ?? null;
    }

    const token = await this.turnstileTokenPromise;
    // Clear promise so a new token is fetched next time
    this.turnstileTokenPromise = null;
    if (!token) {
      console.log("No turnstile token");
      return null;
    }

    const tokenTTL = 3 * 60 * 1000;
    if (Date.now() < token.createdAt + tokenTTL) {
      console.log("Prefetched turnstile token is valid");

      return token.token;
    } else {
      console.log("Turnstile token expired, getting new token");
      return (await getTurnstileToken())?.token ?? null;
    }
  }
}

// Hide elements with no-crazygames class if on CrazyGames
const hideCrazyGamesElements = () => {
  if (crazyGamesSDK.isOnCrazyGames()) {
    document.querySelectorAll(".no-crazygames").forEach((el) => {
      (el as HTMLElement).style.display = "none";
    });
  }
};

// Initialize the client when the DOM is loaded
const bootstrap = () => {
  initLayout();
  new Client().initialize();
  initNavigation();

  // Hide elements immediately
  hideCrazyGamesElements();

  // Also hide elements after a short delay to catch late-rendered components
  setTimeout(hideCrazyGamesElements, 100);
  setTimeout(hideCrazyGamesElements, 500);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}

async function getTurnstileToken(): Promise<{
  token: string;
  createdAt: number;
}> {
  // Wait for Turnstile script to load (handles slow connections)
  let attempts = 0;
  while (typeof window.turnstile === "undefined" && attempts < 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    attempts++;
  }

  if (typeof window.turnstile === "undefined") {
    throw new Error("Failed to load Turnstile script");
  }

  const config = await getRuntimeClientServerConfig();
  const widgetId = window.turnstile.render("#turnstile-container", {
    sitekey: config.turnstileSiteKey(),
    size: "normal",
    appearance: "interaction-only",
    theme: "light",
  });

  return new Promise((resolve, reject) => {
    window.turnstile.execute(widgetId, {
      callback: (token: string) => {
        window.turnstile.remove(widgetId);
        console.log(`Turnstile token received: ${token}`);
        resolve({ token, createdAt: Date.now() });
      },
      "error-callback": (errorCode: string) => {
        window.turnstile.remove(widgetId);
        console.error(`Turnstile error: ${errorCode}`);
        alert(`Turnstile error: ${errorCode}. Please refresh and try again.`);
        reject(new Error(`Turnstile failed: ${errorCode}`));
      },
    });
  });
}
