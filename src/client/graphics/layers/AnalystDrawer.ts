import {
  aiLeagueSpectatorDisplayName,
  isAiLeagueReplayRoute,
} from "../../AiLeagueReplayMode";
import {
  formatReplayActionKind,
  replayDecisions,
  statedReason,
  type AiLeagueReplayUiDecision,
} from "../../ReplayDecisionStore";
import { translateText } from "../../Utils";
import { Layer } from "./Layer";

/**
 * ============================================================================
 * ANALYST DRAWER — the full sampled decision log, only revealed if wanted.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Agent reasoning is what makes an AI tournament worth watching, and the full
 * decision log lived on exactly one surface: the parked broadcast overlay,
 * which the native spectator skin keeps off-screen. The dossier shows one
 * decision for one followed nation and a toast shows one reason for one beat;
 * neither answers "let me read what the agents have been thinking". This is
 * the reference surface for that question — and because it is a reference,
 * not a broadcast element, it is COLLAPSED to a slim tab by default and
 * remembers nothing across loads. A viewer who never wants it never sees more
 * than 26px of tab.
 *
 * WHERE IT DOCKS, MEASURED AGAINST EVERY OTHER LANE
 * -------------------------------------------------
 * Every edge of this stage is spoken for: scorebug top-left with the dossier
 * below it down the left rail, transport cluster hugging the top-right,
 * toasts stacking up from bottom:58 on the right (~310px wide), the FOLLOWING
 * chip at right:14/bottom:82, and the scrubber along the bottom edge. The one
 * unclaimed seam is the RIGHT EDGE between the transport's underside and the
 * toast stack's ceiling — so the tab pins there (top: 132px clears the
 * transport toolbar in every state, including its wrapped catch-up row), and
 * the panel opens leftward and downward from the same line.
 *
 * The panel's height is capped at 60vh AND at the chrome below it, but a tall
 * toast burst can still brush an open panel's lower corner on a short frame.
 * That collision is settled by z-order, deliberately: toasts sit ABOVE the
 * drawer (50005 vs 50002), because a toast is transient news and the drawer
 * is a standing log — news must never be blocked by reference material, and
 * the log is whole again seven seconds later.
 *
 * WHAT IT SHOWS
 * -------------
 * At most ~60 decisions SAMPLED across the whole match (the server thins to
 * replayUiRecentDecisionLimit) — the header says "SAMPLED" for exactly that
 * reason, and nothing here may imply completeness. Newest first, because an
 * analyst opening a log wants "what just happened", not the spawn turn.
 *
 * SEEKING: THIS FILE DISPATCHES A TURN AND NOTHING ELSE
 * ----------------------------------------------------
 * Clicking a row fires the decision's turn number on `document` as an
 * `ai-league-replay-jump-turn` CustomEvent — the same event the scrubber's
 * rail click uses — and that is the WHOLE of this layer's involvement. Which
 * direction that seek is, and how it gets served, is decided entirely by
 * `Main.ts`'s `onReplayJump` handler, because only Main holds the pieces:
 * forward is a seek the engine can do (`ReplayJumpToTurnEvent` ->
 * `LocalServer.jumpReplayForward`), while backward is not — there is no
 * rewind in the engine, so the match has to be rebuilt in place from turn 0.
 *
 * This comment previously claimed a backward click "triggers the rewind path
 * automatically" while `onReplayJump` only ever seeked forward, so clicking
 * any past decision — most of the log, since the log is newest-first — did
 * nothing at all, silently. Comments here are read as spec, so: do not
 * re-assert seek behaviour in this file. State what is dispatched, and name
 * the handler that decides what happens to it.
 */

/** Poll cadence for the store. A log does not need frame rate. */
const TICK_MS = 400;

/**
 * Longest reason shown per row. The artifact bounds reasons at 1000 chars;
 * a scrolling log can afford full paragraphs less than it can afford one
 * entry owning the whole viewport.
 */
const MAX_ROW_REASON = 420;

export class AnalystDrawer implements Layer {
  private root: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  /** Session-scoped only — deliberately forgotten on reload and on rewind. */
  private open = false;
  /** Reference of the last-rendered array; publish replaces the reference. */
  private rendered: readonly AiLeagueReplayUiDecision[] | null = null;
  /**
   * Scopes every DOM listener this layer registers, so `dispose()` can take
   * them all off with one `abort()` instead of recovering identity from inline
   * arrows — the idiom `InputHandler` established. Both listeners here live on
   * nodes inside our own root, so removing the root would collect them anyway;
   * the signal is belt-and-braces and, more usefully, the thing a fourth
   * listener added later cannot forget to join. Null until init(), and
   * re-created by it, because an AbortController cannot be un-aborted.
   */
  private teardown: AbortController | null = null;

  getTickIntervalMs(): number {
    return TICK_MS;
  }

  init() {
    mountAnalystStyles();
    // BACKSTOP, NOT THE TEARDOWN. `dispose()` below is what takes this drawer
    // off the document now, and it runs on every way out of a game. This line
    // stays because it covers the one case dispose() cannot: two
    // `openAiLeagueReplay` attempts racing over one document, where the loser's
    // renderer is never stopped and so never disposes (Main.ts documents that
    // race on its module-level `rewindInFlight` guard). Note that it is NOT
    // what resets `open` — a rebuild constructs a fresh instance whose field
    // already starts false — so the "remembers nothing" contract does not
    // depend on this line.
    document.querySelector(".pw-analyst")?.remove();
    const teardown = new AbortController();
    this.teardown = teardown;
    const root = document.createElement("div");
    root.className = "pw-analyst";
    root.dataset.open = "0";
    root.dataset.on = "0";

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "pw-analyst-tab";
    tab.setAttribute("aria-expanded", "false");
    tab.setAttribute("aria-controls", "pw-analyst-panel");
    // Chevron first, drawn with two borders — no glyph font, no emoji. It
    // points into the board while closed (an "open me" direction) and flips
    // via CSS when the drawer is open.
    const chevron = document.createElement("span");
    chevron.className = "pw-analyst-chevron";
    chevron.setAttribute("aria-hidden", "true");
    const tabLabel = document.createElement("span");
    tabLabel.className = "pw-analyst-tab-label";
    tabLabel.textContent = translateText(
      "ai_league_replay.analyst",
      undefined,
      "ANALYST",
    );
    tab.append(chevron, tabLabel);
    tab.addEventListener("click", () => this.toggle());

    const panel = document.createElement("section");
    panel.className = "pw-analyst-panel";
    panel.id = "pw-analyst-panel";
    const header = document.createElement("h3");
    header.className = "pw-analyst-header";
    const count = document.createElement("span");
    count.className = "pw-analyst-count";
    const headerStart = translateText(
      "ai_league_replay.analyst_header_start",
      undefined,
      "ANALYST — ",
    );
    const headerEnd = translateText(
      "ai_league_replay.analyst_header_end",
      undefined,
      " SAMPLED DECISIONS",
    );
    header.append(
      document.createTextNode(headerStart),
      count,
      document.createTextNode(headerEnd),
    );
    const list = document.createElement("div");
    list.className = "pw-analyst-list";
    // One delegated listener instead of one per row: rows are rebuilt on every
    // publish and a listener that lives on the list survives all of them.
    list.addEventListener("click", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-turn]",
      );
      if (row === null) return;
      const turnNumber = Number(row.dataset.turn);
      if (!Number.isFinite(turnNumber)) return;
      document.dispatchEvent(
        new CustomEvent("ai-league-replay-jump-turn", {
          detail: { turnNumber },
        }),
      );
    });
    panel.append(header, list);

    root.append(tab, panel);
    document.body.appendChild(root);
    this.root = root;
    this.list = list;
    this.countEl = count;
  }

  tick() {
    const root = this.root;
    if (root === null) return;
    const decisions = replayDecisions();
    // A tab that opens onto an empty panel is the empty-panel lie with an
    // extra click in front of it: until the sampled log actually arrives
    // (or when a bundle ships without one), the whole drawer stays off the
    // stage rather than apologising on it.
    const on = decisions.length > 0 ? "1" : "0";
    if (root.dataset.on !== on) root.dataset.on = on;
    if (decisions === this.rendered) return;
    this.rendered = decisions;
    this.paint(decisions);
  }

  private toggle() {
    const root = this.root;
    if (root === null) return;
    this.open = !this.open;
    root.dataset.open = this.open ? "1" : "0";
    root
      .querySelector(".pw-analyst-tab")
      ?.setAttribute("aria-expanded", this.open ? "true" : "false");
  }

  private paint(decisions: readonly AiLeagueReplayUiDecision[]) {
    const list = this.list;
    const countEl = this.countEl;
    if (list === null || countEl === null) return;
    countEl.textContent = String(decisions.length);

    // Newest first — see class doc. Sequence breaks turn ties because several
    // seats decide on the same turn.
    const ordered = [...decisions].sort(
      (a, b) => b.turnNumber - a.turnNumber || b.sequence - a.sequence,
    );
    const rows: HTMLElement[] = [];
    for (const decision of ordered) {
      rows.push(this.row(decision));
    }
    list.replaceChildren(...rows);
  }

  private row(decision: AiLeagueReplayUiDecision): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pw-analyst-row";
    row.dataset.turn = String(decision.turnNumber);

    const meta = document.createElement("div");
    meta.className = "pw-analyst-row-meta";
    const turn = document.createElement("span");
    turn.className = "pw-analyst-turn";
    turn.textContent = translateText(
      "ai_league_replay.turn_short",
      { turn: decision.turnNumber },
      `T${decision.turnNumber}`,
    );
    const seat = document.createElement("span");
    seat.className = "pw-analyst-seat";
    // The same rebrand choke point every other surface uses, so this log
    // never disagrees with the scorebug about who a seat is.
    seat.textContent = aiLeagueSpectatorDisplayName(decision.username);
    const kind = document.createElement("span");
    kind.className = "pw-analyst-kind";
    kind.textContent = formatReplayActionKind(decision.selectedActionKind);
    meta.append(turn, seat, kind);
    // FALLBACK is amber — the one accent, marking "the brain did not decide
    // this". REJECTED is faint, NOT coral: a refused order is bookkeeping,
    // and coral stays reserved for violence on this stage.
    if (decision.fallbackUsed) {
      meta.append(
        flag(
          translateText(
            "ai_league_replay.decision_fallback",
            undefined,
            "FALLBACK",
          ),
          "fallback",
        ),
      );
    }
    if (!decision.result.accepted) {
      meta.append(
        flag(
          translateText(
            "ai_league_replay.decision_rejected",
            undefined,
            "REJECTED",
          ),
          "rejected",
        ),
      );
    }

    const reason = document.createElement("p");
    reason.className = "pw-analyst-reason";
    const stated = statedReason(decision);
    if (stated === null) {
      reason.dataset.none = "1";
      reason.textContent = translateText(
        "ai_league_replay.no_stated_reason",
        undefined,
        "no stated reason",
      );
    } else {
      reason.textContent = `“${clip(stated, MAX_ROW_REASON)}”`;
    }

    row.append(meta, reason);
    return row;
  }
}

function flag(label: string, kind: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "pw-analyst-flag";
  el.dataset.flag = kind;
  el.textContent = label;
  return el;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}

let stylesMounted = false;

function mountAnalystStyles() {
  if (stylesMounted) return;
  stylesMounted = true;
  const style = document.createElement("style");
  style.id = "pw-analyst-styles";
  style.textContent = `
    /* The root is a positioning fiction: only the tab and the panel exist to
     * a pointer, everything else lets the board's click-to-follow gesture
     * through untouched. */
    .pw-analyst {
      pointer-events: none;
    }
    .pw-analyst[data-on="0"] { display: none; }

    /* THE TAB. The right-edge seam between the transport cluster's underside
     * and the toast stack's ceiling — see the class doc for the survey of
     * every other lane. Flush to the edge so it reads as the drawer handle it
     * is, not as a floating button. */
    .pw-analyst-tab {
      position: fixed;
      right: 0;
      top: 132px;
      z-index: 50002;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--pw-s-sm, 6px);
      margin: 0;
      padding: var(--pw-s-md, 8px) var(--pw-s-sm, 6px);
      background: var(--pw-panel, rgba(24, 20, 17, 0.82));
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border-right: none;
      border-radius: 7px 0 0 7px;
      color: var(--pw-accent, #ffc24a);
      cursor: pointer;
      box-shadow: 0 10px 24px rgba(10, 7, 5, 0.3);
    }
    .pw-analyst-tab:hover {
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
    }
    .pw-analyst-tab:focus-visible {
      outline: 1px solid var(--pw-accent, #ffc24a);
      outline-offset: 1px;
    }
    /* The handle's caps label is the same eyebrow as every other caps label on
     * this stage; it just runs vertically. (Was 8.5px/0.18em — its own private
     * spelling of the recipe.) */
    .pw-analyst-tab-label {
      font: var(
        --pw-eyebrow,
        700 9px / 1.2 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif)
      );
      letter-spacing: var(--pw-eyebrow-track, 0.16em);
      writing-mode: vertical-rl;
    }
    /* A chevron drawn from two borders — points onto the board ("open")
     * while closed, flips toward the edge ("put it back") while open. */
    .pw-analyst-chevron {
      width: 6px;
      height: 6px;
      border-left: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg);
      transition: transform 160ms ease-out;
    }
    .pw-analyst[data-open="1"] .pw-analyst-chevron {
      transform: rotate(-135deg);
    }

    /* THE PANEL. Opens beside the tab, never over it — the tab stays the
     * close affordance. Height is 60vh capped by the chrome below; width
     * matches the dossier's 340 so the two reference panels agree. */
    .pw-analyst-panel {
      position: fixed;
      right: 34px;
      top: 132px;
      z-index: 50002;
      pointer-events: auto;
      display: none;
      box-sizing: border-box;
      width: min(340px, calc(100vw - 58px));
      max-height: min(60vh, calc(100vh - 132px - 96px));
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: var(--pw-s-lg, 12px);
      background: var(--pw-panel, rgba(24, 20, 17, 0.82));
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      border-radius: 9px;
      box-shadow: 0 14px 32px rgba(10, 7, 5, 0.34);
      font-family: var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      color: var(--pw-ink-dim, #a79e92);
    }
    .pw-analyst[data-open="1"] .pw-analyst-panel {
      display: block;
      animation: pw-analyst-in 170ms ease-out 1;
    }
    @keyframes pw-analyst-in {
      from { opacity: 0; transform: translateX(6px); }
      to   { opacity: 1; transform: none; }
    }

    /* The panel's own title: the eyebrow recipe, but amber rather than the
     * default faint ink — this one names the surface you just opened, which is
     * the case the recipe's colour is explicitly a default for. */
    .pw-analyst-header {
      margin: 0 0 var(--pw-s-md, 8px);
      font: var(
        --pw-eyebrow,
        700 9px / 1.2 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif)
      );
      letter-spacing: var(--pw-eyebrow-track, 0.16em);
      color: var(--pw-accent, #ffc24a);
    }
    /* Mono is for numbers and only for numbers — the count qualifies. */
    .pw-analyst-count {
      font-family: var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      font-variant-numeric: tabular-nums;
    }

    .pw-analyst-list {
      display: flex;
      flex-direction: column;
    }
    /* Rows are buttons because they seek; styled as list lines because this
     * is a log. One hairline between rows, none around them. */
    .pw-analyst-row {
      display: block;
      width: 100%;
      margin: 0;
      padding: var(--pw-s-sm, 6px) var(--pw-s-hair, 2px);
      background: none;
      border: none;
      border-top: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      text-align: left;
      font-family: inherit;
      cursor: pointer;
    }
    .pw-analyst-row:first-child { border-top: none; }
    .pw-analyst-row:hover {
      background: rgba(242, 236, 226, 0.05);
    }
    .pw-analyst-row:focus-visible {
      outline: 1px solid var(--pw-accent, #ffc24a);
      outline-offset: -1px;
    }

    .pw-analyst-row-meta {
      display: flex;
      align-items: baseline;
      gap: var(--pw-s-md, 8px);
      min-width: 0;
    }
    /* The meta line runs on ONE rung. Turn stamp, action kind and flags all
     * label the row; only the seat is content, and it separates by weight and
     * ink rather than by another half-pixel of size — which is what 9.5 / 11 /
     * 9 / 8 was trying and failing to do. */
    .pw-analyst-turn {
      flex: none;
      font: 500 var(--pw-type-micro, 9px) / 1.2
        var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      font-variant-numeric: tabular-nums;
      color: var(--pw-ink-faint, #6f675d);
    }
    .pw-analyst-seat {
      font-size: var(--pw-type-label, 11px);
      font-weight: 700;
      color: var(--pw-ink, #f2ece2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pw-analyst-kind {
      flex: none;
      font: var(
        --pw-eyebrow,
        700 9px / 1.2 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif)
      );
      letter-spacing: var(--pw-eyebrow-track, 0.16em);
      text-transform: uppercase;
      color: var(--pw-ink-dim, #a79e92);
    }
    .pw-analyst-flag {
      flex: none;
      font: var(
        --pw-eyebrow,
        700 9px / 1.2 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif)
      );
      letter-spacing: var(--pw-eyebrow-track, 0.16em);
    }
    .pw-analyst-flag[data-flag="fallback"] { color: var(--pw-accent, #ffc24a); }
    .pw-analyst-flag[data-flag="rejected"] { color: var(--pw-ink-faint, #6f675d); }

    .pw-analyst-reason {
      margin: var(--pw-s-xs, 4px) 0 0;
      font-size: var(--pw-type-label, 11px);
      line-height: 1.45;
      color: var(--pw-ink-dim, #a79e92);
      overflow-wrap: anywhere;
    }
    /* "no stated reason" is a fact about the sample, stated faintly — never
     * an empty line, never a fabricated quote. */
    .pw-analyst-reason[data-none="1"] {
      color: var(--pw-ink-faint, #6f675d);
    }

    /* The result owns the frame; the end card carries its own story. */
    body.pw-endcard-open .pw-analyst { display: none !important; }

    /* At the embed floor there is no right-edge seam left to dock into —
     * the toasts alone take 46vw. The drawer stands down entirely. */
    @media (max-width: 740px) {
      .pw-analyst { display: none !important; }
    }

    @media (prefers-reduced-motion: reduce) {
      .pw-analyst[data-open="1"] .pw-analyst-panel { animation: none; }
      .pw-analyst-chevron { transition: none; }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Mounts the drawer on the native broadcast skin only. Returns [] anywhere
 * else, so live play and the escape-hatch (?native-spectator-ui=0) surface —
 * where the incumbent overlay's own decision log is visible — never construct
 * it. Same self-gate as mountWarRoomToasts.
 */
export function mountAnalystDrawer(): Layer[] {
  if (!isAiLeagueReplayRoute()) return [];
  if (!document.body.classList.contains("ai-league-native-spectator-ui")) {
    return [];
  }
  return [new AnalystDrawer()];
}
