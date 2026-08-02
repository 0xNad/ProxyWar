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
import { loadAiLeagueReplayDetails } from "./AiLeagueReplayArtifacts";
import { mountAiLeagueReplayOverlay } from "./AiLeagueReplayOverlay";
import { getUserMe } from "./Api";
import { userAuth } from "./Auth";
import "./ClanModal";
import { joinLobby, type JoinLobbyResult } from "./ClientGameRunner";
import { getPlayerCosmeticsRefs } from "./Cosmetics";
import { mountCoworldPlayerOverlay } from "./CoworldPlayerOverlay";
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
  finishReplayLoadingScreen,
  holdReplayLoadingScreenUntilFirstFrame,
  JOIN_SYNC_TIMEOUT_MS,
  REPLAY_LOADING_SLOW_TIMEOUT_MS,
  runReplayStartup,
  setReplayLoadingProgress,
  showReplayLoadingFailure,
  showReplayLoadingScreen,
} from "./ReplayLoadingScreen";
import {
  mountArchivedReplayPremiereOverlay,
  readReplayPremiereArchivePayload,
  type ReplayPremiereArchivePayload,
} from "./ReplayPremiereArchiveView";
import type { ReplayPremiereOverlayHandle } from "./ReplayPremiereOverlay";
import type { ReplayPremiereProgressiveReplayConfig } from "./ReplayPremierePlayback";
import {
  parseReplayPremiereRoute,
  ReplayPremiereRuntimeController,
} from "./ReplayPremiereRuntime";
import {
  loadResumableReplayTurn,
  watchReplayPositionForResume,
} from "./ReplayPositionPersistence";
import {
  openBettingPremierePage,
  parseBettingPremiereRoute,
} from "./prediction/wagering/page/BettingPremierePage";
import "./platform/PlayerProfilePage";
import "./platform/TraderProfilePage";
import "./prediction/wagering/page/AccountPage";
import "./SinglePlayerModal";
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
import "./styles/game-shell-scroll-lock.css";

/**
 * `translateText()` (`Utils.ts`) requires a connected `<lang-selector>`
 * element to resolve keys. In the running game shell that element lives
 * inside `Footer.ts`, nested under the header/nav chrome — but the
 * standalone data pages this module mounts via `document.body.
 * replaceChildren(...)` (`openAccountPage`, `openPlayerProfilePage`,
 * `openTraderProfilePage`) wipe that body-nested element out, silently
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
  /**
   * Set when the join originated from the dedicated `/bet/<id>` betting
   * page rather than `/premiere/<id>` — both share `source: "replay-premiere"`
   * and the same join-lobby/runtime machinery, so this is the only signal
   * `handleJoinLobby`'s URL canonicalization has to pick the right path
   * (see its `premierePath` branch) instead of always rewriting the URL
   * bar to `/premiere/<id>`, which would silently strand the betting page
   * on a route with no trade ticket/bankroll/positions after the join
   * completes.
   */
  isBettingPremiere?: boolean;
  coworldReplayPath?: string;
  publicLobbyInfo?: GameInfo | PublicGameInfo;
}

class Client {
  private lobbyHandle: JoinLobbyResult | null = null;
  private eventBus: EventBus = new EventBus();
  private replayLoadingCleanup: (() => void) | null = null;
  private replayAttemptCleanup: (() => void) | null = null;
  private replayPremiereRuntime: ReplayPremiereRuntimeController | null = null;
  private replayPremiereArchiveOverlay: ReplayPremiereOverlayHandle | null =
    null;

  private currentUrl: string | null = null;

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
    this.turnstileTokenPromise = getTurnstileToken();

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
    const playerProfileMatch = window.location.pathname.match(
      /^\/player\/([^/]+)$/,
    );
    if (playerProfileMatch !== null) {
      await this.openPlayerProfilePage(
        decodeURIComponent(playerProfileMatch[1]),
      );
      return;
    }
    // The trader profile page is likewise standalone — same reasoning as
    // the account-page branch above, but keyed by the platform's opaque
    // accountId, never a display name (see `TraderProfilePage.ts`'s doc).
    const traderProfileMatch = window.location.pathname.match(
      /^\/trader\/([^/]+)$/,
    );
    if (traderProfileMatch !== null) {
      await this.openTraderProfilePage(
        decodeURIComponent(traderProfileMatch[1]),
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
    const bettingPremiereId = parseBettingPremiereRoute(
      window.location.pathname,
    );
    if (bettingPremiereId !== null) {
      await this.openBettingPremiere(bettingPremiereId);
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
   * any of `ReplayPremiereRuntimeController`/`openBettingPremiere`'s
   * machinery — there is no replay, session, or WASM engine behind this
   * route, only a data page over `/api/premieres/account`. The custom
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
   * Mounts the standalone `/trader/:accountId` betting profile page —
   * the destination the points leaderboard links a genuinely LINKED row
   * to. Same reasoning as `openPlayerProfilePage` just above, keyed by
   * account id instead of a league player name. The custom element is
   * registered by the static `TraderProfilePage` import above.
   */
  private async openTraderProfilePage(accountId: string): Promise<void> {
    ensureHeadLangSelector();
    const page = document.createElement("trader-profile-page");
    page.setAttribute("account-id", accountId);
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
    this.replayPremiereArchiveOverlay?.dispose();
    this.replayPremiereArchiveOverlay =
      mountArchivedReplayPremiereOverlay(payload);
    finishReplayLoadingScreen();
    if (payload.replayRunKey !== null) {
      try {
        await this.openAiLeagueReplay(payload.replayRunKey, {
          source: "ai-league-replay",
        });
      } catch (error) {
        console.warn("Archived premiere replay unavailable", error);
        finishReplayLoadingScreen();
      }
      // The ordinary replay path mounts its own overlays; re-assert the durable
      // results overlay so it floats on top of the rendered replay.
      this.replayPremiereArchiveOverlay?.dispose();
      this.replayPremiereArchiveOverlay =
        mountArchivedReplayPremiereOverlay(payload);
    }
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
    let joinSyncTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const clearJoinSyncTimeout = () => {
      if (joinSyncTimeoutTimer !== null) {
        clearTimeout(joinSyncTimeoutTimer);
        joinSyncTimeoutTimer = null;
      }
    };
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
      clearJoinSyncTimeout();
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
            clearJoinSyncTimeout();
            joinSyncTimeoutTimer = setTimeout(() => {
              joinSyncTimeoutTimer = null;
              if (!veilFinished) showReplayLoadingFailure();
            }, JOIN_SYNC_TIMEOUT_MS);
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
        // Scheduled countdown and terminal failure/cancel pages have no game
        // playback to wait for.
        finishVeil();
      },
      onJoinSync: (update) => {
        if (!active || this.replayPremiereRuntime !== runtime) return;
        if (update.state === "complete") {
          finishVeil();
          return;
        }
        if (veilFinished) return;
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
      clearJoinSyncTimeout();
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
      this.failReplayLoading(
        premiereId,
        "replay-premiere",
        "Replay Premiere failed to start",
        error,
      );
    }
  }

  /**
   * The dedicated betting page's own bootstrap — mirrors
   * `openReplayPremiere` exactly for the veil/join dance (same runtime
   * class, same game engine mounting), delegating the trading-specific
   * wiring (continuous market poll, bankroll, buy/sell) to
   * `openBettingPremierePage`. Deliberately reuses `replayPremiereRuntime`/
   * `replayAttemptCleanup`/`replayLoadingCleanup` rather than dedicated
   * fields and the `"replay-premiere"` join source rather than a new one:
   * the two surfaces are mutually exclusive routes over the SAME runtime
   * shape, so every existing interruption/cleanup path
   * (`handleJoinLobby`'s guard, `beforeunload`, `failReplayLoading`)
   * already does the right thing without new branches.
   */
  private async openBettingPremiere(premiereId: string): Promise<void> {
    this.replayAttemptCleanup?.();
    this.replayLoadingCleanup?.();

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
    let joinSyncTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const clearJoinSyncTimeout = () => {
      if (joinSyncTimeoutTimer !== null) {
        clearTimeout(joinSyncTimeoutTimer);
        joinSyncTimeoutTimer = null;
      }
    };
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
      clearJoinSyncTimeout();
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
    const handle = openBettingPremierePage(premiereId, {
      onProjectionReady: (projection) => {
        if (!active || this.replayPremiereRuntime !== handle.runtime) return;
        projectionMounted = true;
        if (
          projection.state === "playing" ||
          projection.state === "checkpoint"
        ) {
          if (!veilFinished) {
            clearVeilSlowTimer();
            showReplayLoadingScreen("replay_premiere.joining_live");
            // See openReplayPremiere's identical wiring: independent of
            // the (now-cleared) slow-load timer, and left running so a
            // join that genuinely finishes late still lifts normally.
            clearJoinSyncTimeout();
            joinSyncTimeoutTimer = setTimeout(() => {
              joinSyncTimeoutTimer = null;
              if (!veilFinished) showReplayLoadingFailure();
            }, JOIN_SYNC_TIMEOUT_MS);
          }
          return;
        }
        if (
          projection.state === "revealed" ||
          projection.state === "archived"
        ) {
          const onFirstFrame = () => finishVeil();
          document.addEventListener("ai-league-replay-frame", onFirstFrame, {
            once: true,
          });
          return;
        }
        finishVeil();
      },
      onJoinSync: (update) => {
        if (!active || this.replayPremiereRuntime !== handle.runtime) return;
        if (update.state === "complete") {
          finishVeil();
          return;
        }
        if (veilFinished) return;
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
          this.replayPremiereRuntime !== handle.runtime ||
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
              isBettingPremiere: true,
            } satisfies JoinLobbyEvent,
            bubbles: true,
            composed: true,
          }),
        );
      },
      onRevealSeek: (turn) => {
        if (!active || this.replayPremiereRuntime !== handle.runtime) return;
        this.eventBus.emit(new ReplayJumpToTurnEvent(turn));
      },
    });
    const cleanupAttempt = () => {
      if (!active) return;
      active = false;
      clearJoinSyncTimeout();
      handle.dispose();
      if (this.replayPremiereRuntime === handle.runtime) {
        this.replayPremiereRuntime = null;
      }
      if (this.replayAttemptCleanup === cleanupAttempt) {
        this.replayAttemptCleanup = null;
      }
    };
    this.replayPremiereRuntime = handle.runtime;
    this.replayAttemptCleanup = cleanupAttempt;

    try {
      await handle.runtime.start();
    } catch (error) {
      if (!active || this.replayPremiereRuntime !== handle.runtime) return;
      if (projectionMounted) {
        console.error("Betting premiere runtime stopped", error);
        return;
      }
      this.failReplayLoading(
        premiereId,
        "replay-premiere",
        "Betting premiere failed to start",
        error,
      );
    }
  }

  private async openAiLeagueReplay(
    runID: string,
    options: {
      source?: Extract<
        JoinLobbyEvent["source"],
        "ai-league-replay" | "coworld-replay"
      >;
      coworldReplayPath?: string;
      artifactBasePath?: string;
    } = {},
  ) {
    this.replayAttemptCleanup?.();
    this.replayLoadingCleanup?.();
    this.replayLoadingCleanup = holdReplayLoadingScreenUntilFirstFrame(
      undefined,
      undefined,
      runID,
    );

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
    clearTimeout(recordTimeout);

    let replayOverlay: ReturnType<typeof mountAiLeagueReplayOverlay>;
    try {
      replayOverlay = mountAiLeagueReplayOverlay({
        runID,
        decisions: [],
        summary: null,
        spectatorTelemetry: null,
        artifactBasePath,
        replayMaxTurn: initialReplayClipRenderableThroughTurn(parsed.data.info),
        detailsLoading: true,
        artifactAvailability: {
          visualReport: false,
          spectatorTelemetry: false,
          decisions: false,
          summary: false,
        },
        onReplaySpeedChange: (speed) => {
          this.eventBus.emit(new ReplaySpeedChangeEvent(speed));
        },
      });
    } catch (error) {
      this.failReplayLoading(
        runID,
        options.source,
        "Replay overlay failed to initialize",
        error,
      );
      return;
    }
    attemptCleanups.push(() => replayOverlay.dispose());

    const onReplayJump = (event: Event) => {
      const turnNumber = (event as CustomEvent<{ turnNumber?: number }>).detail
        ?.turnNumber;
      if (typeof turnNumber === "number" && Number.isFinite(turnNumber)) {
        this.eventBus.emit(new ReplayJumpToTurnEvent(turnNumber));
      }
    };
    const onReplayPause = (event: Event) => {
      const paused = (event as CustomEvent<{ paused?: boolean }>).detail
        ?.paused;
      this.eventBus.emit(new PauseGameIntentEvent(paused !== false));
    };
    document.addEventListener("ai-league-replay-jump-turn", onReplayJump);
    document.addEventListener("ai-league-replay-pause", onReplayPause);
    attemptCleanups.push(() => {
      document.removeEventListener("ai-league-replay-jump-turn", onReplayJump);
      document.removeEventListener("ai-league-replay-pause", onReplayPause);
    });

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
    if (
      options.source !== "coworld-replay" &&
      !(previewTarget === null && Number.isFinite(requestedTurn) && requestedTurn > 0)
    ) {
      const resumeTurn = loadResumableReplayTurn(runID);
      if (resumeTurn !== null) {
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

    const hydrateAfterFirstFrame = () => {
      document.removeEventListener(
        "ai-league-replay-frame",
        hydrateAfterFirstFrame,
      );
      if (this.replayAttemptCleanup !== cleanupAttempt) return;
      const detailsController = new AbortController();
      const abortDetails = () => detailsController.abort();
      attemptController.signal.addEventListener("abort", abortDetails, {
        once: true,
      });
      const detailsTimeout = setTimeout(
        () => detailsController.abort("Replay details request timed out"),
        15_000,
      );
      void loadAiLeagueReplayDetails(artifactBasePath, {
        signal: detailsController.signal,
        onPartial: (details) => {
          if (this.replayAttemptCleanup !== cleanupAttempt) {
            return;
          }
          replayOverlay.hydrate({
            decisions: details.recentDecisions,
            summary: details.summary,
            spectatorTelemetry: details.spectatorTelemetry,
            directorCutPlan: details.directorCutPlan,
            matchStateSeries: details.matchStateSeries,
            detailsLoading: false,
            artifactAvailability: details.artifactAvailability,
          });
        },
      })
        .then((details) => {
          if (this.replayAttemptCleanup !== cleanupAttempt) {
            return;
          }
          replayOverlay.hydrate({
            decisions: details.recentDecisions,
            summary: details.summary,
            spectatorTelemetry: details.spectatorTelemetry,
            directorCutPlan: details.directorCutPlan,
            matchStateSeries: details.matchStateSeries,
            detailsLoading: false,
            artifactAvailability: details.artifactAvailability,
          });
        })
        .catch((error) => {
          if (!detailsController.signal.aborted) {
            console.warn("Replay details unavailable", error);
          }
        })
        .finally(() => {
          clearTimeout(detailsTimeout);
          attemptController.signal.removeEventListener("abort", abortDetails);
        });
    };
    document.addEventListener(
      "ai-league-replay-frame",
      hydrateAfterFirstFrame,
      { once: true },
    );
    attemptCleanups.push(() =>
      document.removeEventListener(
        "ai-league-replay-frame",
        hydrateAfterFirstFrame,
      ),
    );

    document.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: parsed.data.info.gameID,
          gameRecord: parsed.data,
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
    showReplayLoadingFailure();
    console.error(`${message} for run ${runID}`, error);
  }

  private async openCoworldPlayer() {
    mountCoworldPlayerOverlay();
    await this.openCoworldReplay();
  }

  private async handleJoinLobby(event: CustomEvent<JoinLobbyEvent>) {
    const lobby = event.detail;
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
      // fired on ANY page with no hash, including a replay/premiere/bet
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
      const alreadyOnOwnTargetShape = isReplayOrGamePathShape(
        window.location.pathname,
      );
      if (
        !preserveCoworldReplayUrl &&
        !alreadyOnOwnTargetShape &&
        (window.location.hash === "" || window.location.hash === "#")
      ) {
        history.replaceState(null, "", window.location.origin + "#refresh");
      }
      const lobbyIdHidden = !this.userSettings.lobbyIdVisibility();
      if (lobby.progressiveReplay !== undefined && lobby.premiereId) {
        // Betting joins share this exact same branch (same `source`, same
        // `progressiveReplay`/`premiereId` shape) — without checking
        // `isBettingPremiere` this always canonicalized to `/premiere/<id>`,
        // silently stranding a `/bet/<id>` viewer on the wrong route (no
        // trade ticket/bankroll/positions there) the instant the join
        // completed, and breaking reload/second-tab for the betting page.
        const premierePath = lobby.isBettingPremiere === true
          ? `/bet/${encodeURIComponent(lobby.premiereId)}`
          : `/premiere/${encodeURIComponent(lobby.premiereId)}`;
        if (window.location.pathname !== premierePath) {
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
          // exact repro: home -> click a Director Cut link -> the anchor
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
          if (
            shouldPushAiLeagueReplayHistoryEntry(
              window.location.pathname,
              replayPath,
            )
          ) {
            history.pushState(null, "", replayPath);
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
          console.log("[DEBUG] Main.ts emitting ReplaySpeedChangeEvent(fastest)");
          this.eventBus.emit(
            new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fastest),
          );
        } else {
          console.log("[DEBUG] Main.ts NOT emitting fastest, clipPreviewTarget=", clipPreviewTarget);
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
