/**
 * Readiness protocol between a static Coworld replay bundle and the page that
 * embeds it (the Coworld Observatory iframe). The host keeps a "Loading
 * replay..." overlay over the iframe and only lifts it on `ready`; the phase
 * marks let it measure fetch / parse / first-draw separately. The host stamps
 * every message with its own clock on receipt, so nothing here carries a
 * timestamp. Target origin is `"*"`: the bundle cannot know its embedder, the
 * host checks the sender window, and the payload is timings only.
 */
export type CoworldReplayHostMessage =
  | { type: "loading" }
  | {
      type: "phase";
      phase: "bundle_ready" | "replay_fetch_start" | "replay_parsed";
    }
  | {
      type: "phase";
      phase: "replay_fetch_end";
      bytes: number;
      compressed: boolean;
    }
  | { type: "ready" }
  | { type: "error"; message: string };

export function postToReplayHost(message: CoworldReplayHostMessage): void {
  if (window.parent === window) return;
  window.parent.postMessage({ src: "coworld-replay", ...message }, "*");
}
