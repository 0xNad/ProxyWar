export interface Layer {
  init?: () => void;
  tick?: () => void;
  // Optional hint to throttle expensive ticks by wall-clock.
  // If omitted or <= 0, the layer ticks whenever GameRenderer ticks.
  getTickIntervalMs?: () => number;
  renderLayer?: (context: CanvasRenderingContext2D) => void;
  shouldTransform?: () => boolean;
  redraw?: () => void;
  /**
   * TEARDOWN. Called for every layer from `GameRenderer.dispose()`.
   *
   * The client is a single-page app: leaving a match does `history.replaceState`
   * with NO page reload, and an in-place rewind rebuilds the game the same way.
   * A layer that appends to `document.body`, registers a window listener or
   * subscribes to the page-lifetime EventBus therefore outlives its own game
   * unless it takes those back. Before this existed, five layers each hand-rolled
   * the same teardown in the WRONG place — "remove my node at the top of my next
   * init()" — which only fires if another replay starts, so leaving a replay for
   * a live game left broadcast chrome painted over it.
   *
   * Implementations must be idempotent: dispose() may run before init(), and
   * twice.
   */
  dispose?: () => void;
}
