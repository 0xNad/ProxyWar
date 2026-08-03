import { assetUrl } from "src/core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import { PseudoRandom } from "../../../core/PseudoRandom";
import { Config, Theme } from "../../../core/configuration/Config";
import { Cell } from "../../../core/game/Game";
import { GameView, PlayerView } from "../../../core/game/GameView";
import { UserSettings } from "../../../core/game/UserSettings";
import { aiLeagueSpectatorDisplayName } from "../../AiLeagueReplayMode";
import { AlternateViewEvent, ReplaySpeedChangeEvent } from "../../InputHandler";
import { renderTroops } from "../../Utils";
import { defaultReplaySpeedMultiplier } from "../../utilities/ReplaySpeedMultiplier";
import {
  ALLIANCE_ICON_ID,
  AllianceProgressIconRefs,
  createAllianceProgressIconRefs,
  EMOJI_ICON_KIND,
  getFirstPlacePlayer,
  getPlayerIcons,
  IMAGE_ICON_KIND,
  PlayerIconDescriptor,
  PlayerIconId,
  TRAITOR_ICON_ID,
  updateAllianceProgressIconRefs,
} from "../PlayerIcons";
import {
  REPLAY_NAME_POSITION_REFRESH_MS,
  ReplayPresentationCadenceEvent,
  replayPresentationTransitionDurationForIntervalMs,
  replayPresentationTransitionDurationMs,
} from "../ReplayPresentationSmoothing";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";

const PLAYER_NAME = "player-name";
const PLAYER_NAME_SPAN = "player-name-span";
const PLAYER_TROOPS = "player-troops";
const PLAYER_ICONS = "player-icons";
const PLAYER_FLAG = "player-flag";

class RenderInfo {
  public icons: Map<PlayerIconId, HTMLElement> = new Map();
  public allianceIconRefs: AllianceProgressIconRefs | null = null;

  constructor(
    public player: PlayerView,
    public lastRenderCalc: number,
    public location: Cell | null,
    public fontSize: number,
    public fontColor: string,
    public element: HTMLElement,
    public nameDiv: HTMLDivElement,
    public nameSpan: HTMLSpanElement,
    public troopsDiv: HTMLDivElement,
    public flagImg: HTMLImageElement,
    public iconsDiv: HTMLDivElement,
    public lastTransform: string = "",
  ) {}
}

export class NameLayer implements Layer {
  private config: Config;
  private lastChecked = 0;
  private renderCheckRate = REPLAY_NAME_POSITION_REFRESH_MS;
  private renderRefreshRate = 500;
  private rand = new PseudoRandom(10);
  private renders: RenderInfo[] = [];
  private seenPlayers: Set<PlayerView> = new Set();
  private container: HTMLDivElement;
  private theme: Theme;
  private userSettings: UserSettings = new UserSettings();
  private isVisible: boolean = true;
  private firstPlace: PlayerView | null = null;
  private allianceDuration: number;
  private alliancesDisabled: boolean = false;
  private myPlayer: PlayerView | null = null;
  private lastContainerTransform: string = "";
  private basePlayerTemplate: HTMLDivElement;
  private iconTemplate: HTMLImageElement;
  private iconCenterTemplate: HTMLImageElement;
  private emojiTemplate: HTMLDivElement;
  private replayNameTransitionMs = 0;
  private progressivePresentationIntervalMs: number | null = null;

  constructor(
    private game: GameView,
    private transformHandler: TransformHandler,
    private eventBus: EventBus,
  ) {}

  shouldTransform(): boolean {
    return false;
  }

  redraw() {} // not affected by Canvas/WebGL context loss as this layer is DOM-based

  public init() {
    this.container = document.createElement("div");
    this.container.style.position = "fixed";
    this.container.style.left = "50%";
    this.container.style.top = "50%";
    this.container.style.pointerEvents = "none";
    this.container.style.zIndex = "2";
    document.body.appendChild(this.container);

    // Add CSS keyframes for traitor icon flashing animation
    // Append to container instead of document.head to keep styles scoped to this component
    const style = document.createElement("style");
    style.textContent = `
      @keyframes traitorFlash {
        0%, 100% {
          opacity: 1;
        }
        50% {
          opacity: 0.3;
        }
      }
    `;
    this.container.appendChild(style);

    this.myPlayer = this.game.myPlayer();
    this.config = this.game.config();
    this.theme = this.config.theme();

    if (this.config.isReplay()) {
      this.replayNameTransitionMs = replayPresentationTransitionDurationMs(
        defaultReplaySpeedMultiplier,
      );
      this.eventBus.on(ReplaySpeedChangeEvent, (event) =>
        this.onReplaySpeedChange(event),
      );
      this.eventBus.on(ReplayPresentationCadenceEvent, (event) =>
        this.onReplayPresentationCadence(event),
      );
    }

    this.alliancesDisabled = this.config.disableAlliances();
    this.allianceDuration = Math.max(1, this.config.allianceDuration());

    this.basePlayerTemplate = this.createBasePlayerElement();

    this.iconTemplate = document.createElement("img");

    this.iconCenterTemplate = document.createElement("img");
    this.iconCenterTemplate.style.position = "absolute";
    this.iconCenterTemplate.style.top = "50%";
    this.iconCenterTemplate.style.transform = "translateY(-50%)";

    this.emojiTemplate = document.createElement("div");
    this.emojiTemplate.style.position = "absolute";
    this.emojiTemplate.style.top = "50%";
    this.emojiTemplate.style.transform = "translateY(-50%)";

    this.eventBus.on(AlternateViewEvent, (e) => this.onAlternateViewChange(e));
  }

  private onAlternateViewChange(event: AlternateViewEvent) {
    this.isVisible = !event.alternateView;
    // Update visibility of all name elements immediately
    for (const render of this.renders) {
      this.updateElementVisibility(render);
    }
  }

  private updateElementVisibility(
    render: RenderInfo,
    baseSize?: number,
    unsafePanelRects: readonly DOMRect[] = [],
  ) {
    if (!render.player.nameLocation() || !render.player.isAlive()) {
      return;
    }

    baseSize =
      baseSize ?? Math.max(1, Math.floor(render.player.nameLocation().size));
    const size = this.transformHandler.scale * baseSize;
    const isOnScreen = render.location
      ? this.transformHandler.isOnScreen(render.location)
      : false;
    const maxZoomScale = 17;

    // Spec 01 rule 2: never render any part of a label underneath the
    // fixed AI League broadcast chrome (see computeUnsafePanelRects's own
    // doc for the suppress-vs-reposition deviation). Screen-space check --
    // render.location is world-space, so this must go through the same
    // world-to-screen transform the rest of this layer already uses.
    let underUnsafePanel = false;
    if (isOnScreen && render.location && unsafePanelRects.length > 0) {
      const screenPoint = this.transformHandler.worldToScreenCoordinates(
        render.location,
      );
      for (const rect of unsafePanelRects) {
        if (
          screenPoint.x >= rect.left &&
          screenPoint.x <= rect.right &&
          screenPoint.y >= rect.top &&
          screenPoint.y <= rect.bottom
        ) {
          underUnsafePanel = true;
          break;
        }
      }
    }

    const display =
      !this.isVisible ||
      size < 7 ||
      (this.transformHandler.scale > maxZoomScale && size > 100) ||
      !isOnScreen ||
      underUnsafePanel
        ? "none"
        : "flex";
    if (render.element.style.display !== display) {
      render.element.style.display = display;
    }
  }

  getTickIntervalMs() {
    return 1000;
  }

  public tick() {
    // Precompute the first-place player for performance
    this.firstPlace = getFirstPlacePlayer(this.game);

    for (const player of this.game.playerViews()) {
      if (player.isAlive()) {
        if (!this.seenPlayers.has(player)) {
          this.seenPlayers.add(player);
          this.renders.push(this.createPlayerElement(player));
        }
      }
    }
  }

  public renderLayer() {
    const screenPosOld = this.transformHandler.worldToScreenCoordinates(
      new Cell(0, 0),
    );
    const screenPos = new Cell(
      screenPosOld.x - window.innerWidth / 2,
      screenPosOld.y - window.innerHeight / 2,
    );
    const newTransform = `translate(${screenPos.x}px, ${screenPos.y}px) scale(${this.transformHandler.scale})`;
    if (this.lastContainerTransform !== newTransform) {
      this.container.style.transform = newTransform;
      this.lastContainerTransform = newTransform;
    }

    const now = Date.now();
    if (now >= this.lastChecked + this.renderCheckRate) {
      this.lastChecked = now;

      this.myPlayer ??= this.game.myPlayer();
      const transitiveTargets = this.myPlayer?.transitiveTargets() ?? [];
      // Spec 01 (label sizing/safe-frame): fixed-panel rects are read once
      // per throttled batch, never per label -- getBoundingClientRect
      // forces layout, and this already only runs at renderCheckRate
      // cadence (500ms/replay-presentation-interval), the same cost
      // envelope the rest of this batch already lives in.
      const safePanelRects = this.computeUnsafePanelRects();

      for (const render of this.renders) {
        this.renderPlayerInfo(render, transitiveTargets, safePanelRects);
      }
    }
  }

  /**
   * Spec 01 rule 2 (safe-frame clamping): the fixed AI League broadcast
   * chrome a territory label must never render underneath. Deliberately
   * selector-driven rather than a new prop threaded through Layer's
   * constructor -- this file already reaches directly into AI-league-
   * specific behavior the same way (aiLeagueSpectatorDisplayName, imported
   * above), and every selector here simply resolves to nothing (empty
   * array, no-op) on an ordinary non-AI-league game, so this stays a pure
   * addition with zero effect outside the replay/DC surface these rules
   * are about.
   *
   * Deviation from the spec's own text, stated: the spec asks for
   * "clamp the anchor inward... draw a short leader line back to the true
   * centroid" for a label that would intersect the unsafe zone. This
   * implementation SUPPRESSES (hides) the label instead of repositioning
   * it. Repositioning requires per-label collision-aware placement (the
   * same machinery rule 3's priority/collision system needs) plus a new
   * leader-line rendering layer -- out of scope for this pass; suppression
   * still satisfies this spec's own acceptance criterion ("zero label
   * glyphs render with any part of their bounding box outside the safe
   * frame") without inventing a second render pass. Full anchor-clamping +
   * leader lines is a reasonable follow-up once rule 3's collision system
   * exists to share the placement pass with.
   */
  private computeUnsafePanelRects(): DOMRect[] {
    const selectors = [
      "#pw-game-control-cluster",
      "#ai-league-replay-overlay",
      '.broadcast-drawer-panel[data-tab-id="events"]',
      '.broadcast-drawer-panel[data-tab-id="timeline"]',
    ];
    const rects: DOMRect[] = [];
    for (const selector of selectors) {
      const el = document.querySelector<HTMLElement>(selector);
      // offsetParent is null for display:none (collapsed panels, a hidden
      // "Hide panel" state, position:fixed elements aside) -- a collapsed
      // panel reserves no screen space, so it must not shrink the safe
      // frame either.
      if (el !== null && el.offsetParent !== null) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          rects.push(rect);
        }
      }
    }
    return rects;
  }

  private createBasePlayerElement(): HTMLDivElement {
    const element = document.createElement("div");
    element.style.position = "absolute";
    element.style.flexDirection = "column";
    element.style.alignItems = "center";
    element.style.gap = "0px";
    this.applyReplayNameTransition(element);
    // Start off invisible so it doesn't flash at 0,0
    element.style.display = "none";

    const iconsDiv = document.createElement("div");
    iconsDiv.classList.add(PLAYER_ICONS);
    iconsDiv.style.display = "flex";
    iconsDiv.style.gap = "4px";
    iconsDiv.style.justifyContent = "center";
    iconsDiv.style.alignItems = "center";
    iconsDiv.style.zIndex = "2";
    iconsDiv.style.opacity = "0.8";
    element.appendChild(iconsDiv);

    const nameDiv = document.createElement("div");
    nameDiv.classList.add(PLAYER_NAME);
    nameDiv.style.whiteSpace = "nowrap";
    nameDiv.style.textOverflow = "ellipsis";
    nameDiv.style.zIndex = "3";
    nameDiv.style.display = "flex";
    nameDiv.style.justifyContent = "flex-end";
    nameDiv.style.alignItems = "center";
    // Spec 01 rule 4 (legibility floor): a light halo behind the dark
    // glyph fill guarantees contrast against any terrain color or any
    // translucent overlay the label happens to land on (a match-end
    // banner, another label, ocean vs. land) -- cheap, standard map-label
    // technique, independent of what's underneath.
    nameDiv.style.textShadow =
      "0 0 3px rgba(255,255,255,0.9), 0 0 3px rgba(255,255,255,0.9), 0 1px 2px rgba(255,255,255,0.9)";

    const flagImg = document.createElement("img");
    flagImg.classList.add(PLAYER_FLAG);
    flagImg.style.opacity = "0.8";
    flagImg.style.zIndex = "1";
    flagImg.style.objectFit = "contain";
    flagImg.style.display = "none";
    nameDiv.appendChild(flagImg);

    const nameSpan = document.createElement("span");
    nameSpan.classList.add(PLAYER_NAME_SPAN);
    nameDiv.appendChild(nameSpan);
    element.appendChild(nameDiv);

    const troopsDiv = document.createElement("div");
    troopsDiv.classList.add(PLAYER_TROOPS);
    troopsDiv.setAttribute("translate", "no");
    troopsDiv.style.zIndex = "3";
    troopsDiv.style.marginTop = "-5%";
    troopsDiv.style.fontWeight = "400";
    troopsDiv.style.textShadow = nameDiv.style.textShadow;
    element.appendChild(troopsDiv);

    return element;
  }

  private createPlayerElement(player: PlayerView): RenderInfo {
    const element = this.basePlayerTemplate.cloneNode(true) as HTMLDivElement;

    // Queryselector expensive but this runs only once per player and better maintainable
    const nameDiv = element.querySelector(`.${PLAYER_NAME}`) as HTMLDivElement;
    const nameSpan = element.querySelector(
      `.${PLAYER_NAME_SPAN}`,
    ) as HTMLSpanElement;
    const troopsDiv = element.querySelector(
      `.${PLAYER_TROOPS}`,
    ) as HTMLDivElement;
    const flagImg = element.querySelector(
      `.${PLAYER_FLAG}`,
    ) as HTMLImageElement;
    const iconsDiv = element.querySelector(
      `.${PLAYER_ICONS}`,
    ) as HTMLDivElement;

    const font = this.theme.font();
    nameDiv.style.fontFamily = font;

    const flag = player.cosmetics.flag;
    if (flag) {
      flagImg.src = assetUrl(flag);
      flagImg.style.display = "block";
    }

    const renderInfo = new RenderInfo(
      player,
      0,
      null,
      0,
      "",
      element,
      nameDiv,
      nameSpan,
      troopsDiv,
      flagImg,
      iconsDiv,
    );

    this.container.appendChild(element);
    return renderInfo;
  }

  renderPlayerInfo(
    render: RenderInfo,
    transitiveTargets: PlayerView[],
    unsafePanelRects: readonly DOMRect[] = [],
  ) {
    if (!render.player.nameLocation()) {
      return;
    }
    if (!render.player.isAlive()) {
      this.renders = this.renders.filter((r) => r !== render);
      render.element.remove();
      return;
    }

    // Update location and size, show or hide dependent on those
    const nameLocation = render.player.nameLocation();
    const newX = nameLocation.x;
    const newY = nameLocation.y;

    if (
      !render.location ||
      render.location.x !== newX ||
      render.location.y !== newY
    ) {
      render.location = new Cell(newX, newY);
    }

    const baseSize = Math.max(1, Math.floor(nameLocation.size));

    // Position is cheap and visible, so replay mode updates it at simulation
    // cadence. Ordinary play retains the original post-throttle DOM cadence.
    if (this.config.isReplay()) {
      this.updateElementTransform(render, newX, newY, baseSize);
    }

    this.updateElementVisibility(render, baseSize, unsafePanelRects);

    if (render.element.style.display === "none") {
      return;
    }

    // Throttle further updates
    const now = Date.now();
    if (now - render.lastRenderCalc <= this.renderRefreshRate) {
      return;
    }
    render.lastRenderCalc = now + this.rand.nextInt(0, 100);

    // Spec 01 rule 1 (label sizing): stop deriving font size from
    // territory strength/value alone -- derive it from available screen
    // space at current zoom, clamped by a hard viewport-relative ceiling.
    // See computeLabelFontSizePx's own doc for the formula.
    render.fontSize = computeLabelFontSizePx(
      baseSize,
      this.transformHandler.scale,
      Math.min(window.innerWidth, window.innerHeight),
    );
    render.nameDiv.style.fontSize = `${render.fontSize}px`;
    render.nameDiv.style.lineHeight = `${render.fontSize}px`;
    render.flagImg.style.height = `${render.fontSize}px`;
    // The value line ("385K") is visually SECONDARY to the name -- smaller
    // and lower-weight, not matched. 70% size, reduced opacity (the name
    // itself stays full-opacity via fontColor below).
    const troopsFontSize = Math.max(1, Math.round(render.fontSize * 0.7));
    render.troopsDiv.style.fontSize = `${troopsFontSize}px`;
    render.troopsDiv.style.opacity = "0.82";

    render.nameSpan.textContent = aiLeagueSpectatorDisplayName(
      render.player.displayName(),
    );
    render.troopsDiv.textContent = renderTroops(render.player.troops());

    const fontColor = this.theme.textColor(render.player);
    if (render.fontColor !== fontColor) {
      render.fontColor = fontColor;
      render.nameDiv.style.color = fontColor;
      render.troopsDiv.style.color = fontColor;
    }

    // Handle icons
    const iconSize = Math.min(render.fontSize * 1.5, 48);
    const darkMode = this.userSettings.darkMode();
    const darkModeStr = darkMode.toString();

    // Compute which icons should be shown for this player using shared logic
    const icons = getPlayerIcons({
      game: this.game,
      player: render.player,
      includeAllianceIcon: true,
      firstPlace: this.firstPlace,
      darkMode: darkMode,
      alliancesDisabled: this.alliancesDisabled,
      transitiveTargets: transitiveTargets,
    });

    // Build a set of desired icon IDs
    const desiredIconIds = new Set(icons.map((icon) => icon.id));

    // Remove any icons that are no longer needed
    for (const [id, element] of render.icons) {
      if (!desiredIconIds.has(id)) {
        if (id === ALLIANCE_ICON_ID) {
          render.allianceIconRefs?.wrapper.remove();
          render.allianceIconRefs = null;
          render.icons.delete(ALLIANCE_ICON_ID);
        } else {
          element.remove();
          render.icons.delete(id);
        }
      }
    }

    // Add or update icons that should be shown
    for (const icon of icons) {
      if (icon.kind === EMOJI_ICON_KIND && icon.text) {
        this.handleEmojiIcon(render, icon, iconSize);
        continue;
      } else if (!(icon.kind === IMAGE_ICON_KIND && icon.src)) {
        continue;
      }
      // Special handling for alliance icon with progress indicator
      if (icon.id === ALLIANCE_ICON_ID) {
        this.handleAllianceIcons(render, iconSize, darkModeStr);
        continue; // Skip regular image handling
      }

      const imgElement = this.handleOtherIcons(
        render,
        icon,
        iconSize,
        darkModeStr,
      );

      // Traitor flashing - smooth speed increase starting at 15s
      if (icon.id === TRAITOR_ICON_ID) {
        this.handleTraitorIconFlashing(render.player, imgElement);
      }
    }

    if (!this.config.isReplay()) {
      this.updateElementTransform(render, newX, newY, baseSize);
    }
  }

  private updateElementTransform(
    render: RenderInfo,
    x: number,
    y: number,
    baseSize: number,
  ) {
    // Spec 01 rule 1: fontSize (above) is now the sole, viewport-clamped
    // driver of a label's visible size. See computeElementScale's own doc
    // for why this used to compound with it.
    const scale = computeElementScale(baseSize);
    const transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
    if (render.lastTransform !== transform) {
      render.element.style.transform = transform;
      render.lastTransform = transform;
    }
  }

  private onReplaySpeedChange(event: ReplaySpeedChangeEvent) {
    // A live Premiere has a fixed committed presentation rate. Its LocalServer
    // intentionally ignores viewer replay-speed events, so the compositor must
    // ignore them too or labels drift behind the authoritative live cadence.
    if (this.progressivePresentationIntervalMs !== null) {
      return;
    }
    this.replayNameTransitionMs = replayPresentationTransitionDurationMs(
      event.replaySpeedMultiplier,
    );
    this.applyReplayNameTransitions();
  }

  private onReplayPresentationCadence(event: ReplayPresentationCadenceEvent) {
    if (
      !Number.isFinite(event.presentationIntervalMs) ||
      event.presentationIntervalMs <= 0
    ) {
      return;
    }
    this.progressivePresentationIntervalMs = event.presentationIntervalMs;
    this.renderCheckRate = event.presentationIntervalMs;
    this.replayNameTransitionMs =
      replayPresentationTransitionDurationForIntervalMs(
        event.presentationIntervalMs,
      );
    this.applyReplayNameTransitions();
  }

  private applyReplayNameTransitions() {
    this.applyReplayNameTransition(this.basePlayerTemplate);
    for (const render of this.renders) {
      this.applyReplayNameTransition(render.element);
    }
  }

  private applyReplayNameTransition(element: HTMLElement) {
    if (!this.config?.isReplay()) {
      return;
    }
    element.style.transition =
      this.replayNameTransitionMs === 0
        ? "none"
        : `transform ${this.replayNameTransitionMs}ms linear`;
  }

  private handleEmojiIcon(
    render: RenderInfo,
    icon: PlayerIconDescriptor,
    size: number,
  ) {
    let emojiDiv = render.icons.get(icon.id) as HTMLDivElement | undefined;

    if (!emojiDiv) {
      emojiDiv = this.emojiTemplate.cloneNode(true) as HTMLDivElement;
      render.iconsDiv.appendChild(emojiDiv);
      render.icons.set(icon.id, emojiDiv);
    }

    emojiDiv.textContent = icon.text ?? "";
    emojiDiv.style.fontSize = `${size}px`;
  }

  private handleAllianceIcons(
    render: RenderInfo,
    size: number,
    darkMode: string,
  ) {
    this.myPlayer ??= this.game.myPlayer();
    const allianceView = this.myPlayer
      ?.alliances()
      .find((a) => a.other === render.player.id());

    let fraction = 0;
    let hasExtensionRequest = false;
    if (allianceView) {
      const remaining = Math.max(0, allianceView.expiresAt - this.game.ticks());
      fraction = Math.max(0, Math.min(1, remaining / this.allianceDuration));
      hasExtensionRequest = allianceView.hasExtensionRequest;
    }

    if (!render.allianceIconRefs) {
      render.allianceIconRefs = createAllianceProgressIconRefs(
        size,
        fraction,
        hasExtensionRequest,
        darkMode,
      );

      render.iconsDiv.appendChild(render.allianceIconRefs.wrapper);
      render.icons.set(ALLIANCE_ICON_ID, render.allianceIconRefs.wrapper);
    } else {
      updateAllianceProgressIconRefs(
        render.allianceIconRefs,
        size,
        fraction,
        hasExtensionRequest,
        darkMode,
      );
    }
    return;
  }

  private handleOtherIcons(
    render: RenderInfo,
    icon: PlayerIconDescriptor,
    size: number,
    darkMode: string,
  ): HTMLImageElement {
    let imgElement = render.icons.get(icon.id) as HTMLImageElement | undefined;

    if (!imgElement) {
      imgElement = icon.center
        ? (this.iconCenterTemplate.cloneNode(true) as HTMLImageElement)
        : (this.iconTemplate.cloneNode(true) as HTMLImageElement);

      imgElement.src = icon.src ?? "";
      imgElement.style.width = `${size}px`;
      imgElement.style.height = `${size}px`;
      imgElement.setAttribute("dark-mode", darkMode);
      render.iconsDiv.appendChild(imgElement);
      render.icons.set(icon.id, imgElement);
    } else {
      // Update src if it changed (e.g., nuke red/white or dark-mode icons)
      if (imgElement.src !== icon.src) {
        imgElement.src = icon.src ?? "";
      }

      imgElement.style.width = `${size}px`;
      imgElement.style.height = `${size}px`;
      imgElement.setAttribute("dark-mode", darkMode);
    }
    return imgElement;
  }

  private handleTraitorIconFlashing(
    player: PlayerView,
    icon: HTMLImageElement,
  ) {
    const remainingTicks = player.getTraitorRemainingTicks();
    // Use precise seconds (not rounded) for smoother transitions, rounded to 0.5s intervals
    const remainingSeconds = Math.round((remainingTicks / 10) * 2) / 2;

    if (remainingSeconds <= 15) {
      // Smooth transition: starts at 1s at 15 seconds, decreases to 0.2s at 0 seconds
      // Using cubic ease-out for slower, more gradual acceleration
      const clampedSeconds = Math.max(0, Math.min(15, remainingSeconds));
      const normalizedTime = clampedSeconds / 15; // 0 to 1 (1 = 15s remaining, 0 = 0s remaining)

      // Cubic ease-out: slower acceleration, smoother transition
      const easedProgress = 1 - Math.pow(1 - normalizedTime, 3);
      const maxDuration = 1.0; // Slow flash at 15 seconds
      const minDuration = 0.2; // Fast flash at 0 seconds
      const duration =
        minDuration + (maxDuration - minDuration) * easedProgress;
      const animationDuration = `${duration.toFixed(2)}s`;

      icon.style.animation = `traitorFlash ${animationDuration} infinite`;
      icon.style.animationTimingFunction = "ease-in-out";
    } else {
      // Don't flash if more than 15 seconds remaining
      icon.style.animation = "none";
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Spec 01 rule 1 (label sizing) -- exported for direct unit testing rather
 * than exercising it through the full NameLayer class (which needs a real
 * GameView/TransformHandler/EventBus to construct).
 *
 *   labelHeightPx = clamp(
 *     territoryScreenBBox.height * 0.35,  // fit-to-shape target
 *     MIN_LABEL_HEIGHT,                    // legibility floor
 *     viewportShorterDimension * 0.035     // broadcast-safe ceiling
 *   )
 *
 * `territoryScreenBBox.height` is approximated as `baseSize * transformScale`
 * -- the same territory-footprint-in-screen-px value
 * `updateElementVisibility` already computes as "size" for its own
 * show/hide gate, so this reuses an existing signal rather than adding a
 * second, possibly-disagreeing notion of "how big is this territory on
 * screen right now".
 *
 * The returned value is CSS px BEFORE NameLayer's own container
 * `scale(transformScale)` transform is applied (see renderLayer), so the
 * target on-screen height is divided back down by `transformScale` to
 * land on the correct FINAL rendered size once that transform composes.
 */
export function computeLabelFontSizePx(
  baseSize: number,
  transformScale: number,
  viewportShorterDimension: number,
): number {
  const MIN_LABEL_HEIGHT = 11;
  const CEILING_RATIO = 0.035;
  const FIT_TO_SHAPE_RATIO = 0.35;
  const territoryScreenPx = baseSize * transformScale;
  const targetOnScreenHeight = clamp(
    territoryScreenPx * FIT_TO_SHAPE_RATIO,
    MIN_LABEL_HEIGHT,
    viewportShorterDimension * CEILING_RATIO,
  );
  return Math.max(
    1,
    Math.floor(targetOnScreenHeight / Math.max(transformScale, 0.0001)),
  );
}

/**
 * The label element's own (icons+name+troops as one block) CSS transform
 * scale. Used to grow up to 3x with baseSize (territory value),
 * compounding MULTIPLICATIVELY on top of computeLabelFontSizePx's own
 * baseSize-proportional growth -- exactly the runaway-size root cause
 * spec 01 describes ("softmaxwell" spanning ~220px / ~58px cap-height on
 * a 1440x900 desktop capture). Capped to a small 0.6-1.2 range: still
 * gives tiny territories a slight shrink and large ones a slight
 * emphasis, but can no longer multiply the now-capped fontSize back into
 * an oversized label.
 */
export function computeElementScale(baseSize: number): number {
  return clamp(baseSize * 0.15, 0.6, 1.2);
}
