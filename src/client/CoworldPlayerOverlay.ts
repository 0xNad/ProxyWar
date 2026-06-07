type CoworldDecisionRequest = {
  type: "decision_request";
  requestID: string;
  slot: number;
  request?: {
    protocolVersion?: string;
    match?: {
      phase?: string;
      turnNumber?: number;
    };
    observation?: {
      strategic?: {
        summary?: string;
      };
    };
    legalActions?: CoworldLegalAction[];
  };
};

type CoworldLegalAction = {
  id: string;
  kind?: string;
  label?: string;
  risk?: {
    level?: string;
    score?: number;
  };
};

type CoworldPlayerMessage =
  | { type: "hello"; slot: number }
  | { type: "final"; slot?: number }
  | CoworldDecisionRequest;

type CoworldPlayerState = {
  socket: WebSocket | null;
  request: CoworldDecisionRequest | null;
  finished: boolean;
  root: HTMLElement;
  status: HTMLElement;
  summary: HTMLElement;
  actions: HTMLElement;
  log: HTMLElement;
};

let currentState: CoworldPlayerState | null = null;

export function mountCoworldPlayerOverlay(): void {
  if (currentState !== null) {
    return;
  }
  installCoworldPlayerOverlayStyles();
  const root = document.createElement("aside");
  root.id = "coworld-player-overlay";
  root.innerHTML = `
    <header>
      <div>
        <h2>Coworld Player</h2>
        <p>Legal actions</p>
      </div>
      <strong data-coworld-player-status>connecting</strong>
    </header>
    <section data-coworld-player-summary class="coworld-player-summary">
      Waiting for a decision request.
    </section>
    <section data-coworld-player-actions class="coworld-player-actions"></section>
    <section class="coworld-player-log" data-coworld-player-log></section>
  `;
  document.body.appendChild(root);

  currentState = {
    socket: null,
    request: null,
    finished: false,
    root,
    status: requiredElement(root, "[data-coworld-player-status]"),
    summary: requiredElement(root, "[data-coworld-player-summary]"),
    actions: requiredElement(root, "[data-coworld-player-actions]"),
    log: requiredElement(root, "[data-coworld-player-log]"),
  };
  connectCoworldPlayer(currentState);
}

function connectCoworldPlayer(state: CoworldPlayerState): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${protocol}//${location.host}/player${location.search}`,
  );
  state.socket = socket;
  socket.addEventListener("open", () => setStatus(state, "connected"));
  socket.addEventListener("close", () => {
    if (!state.finished) {
      setStatus(state, "closed");
    }
  });
  socket.addEventListener("error", () => setStatus(state, "socket error"));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CoworldPlayerMessage;
    appendLog(state, message);
    if (message.type === "hello") {
      setStatus(state, `slot ${message.slot}`);
    } else if (message.type === "decision_request") {
      renderDecisionRequest(state, message);
    } else if (message.type === "final") {
      state.finished = true;
      setStatus(state, "match finished");
      state.actions.textContent = "";
      state.summary.textContent = "Match finished.";
    }
  });
}

function renderDecisionRequest(
  state: CoworldPlayerState,
  message: CoworldDecisionRequest,
): void {
  state.request = message;
  const request = message.request;
  const legalActions = request?.legalActions ?? [];
  const match = request?.match;
  const strategicSummary = request?.observation?.strategic?.summary;
  state.summary.innerHTML = `
    <dl>
      <div><dt>Request</dt><dd>${escapeHtml(message.requestID)}</dd></div>
      <div><dt>Slot</dt><dd>${message.slot}</dd></div>
      <div><dt>Phase</dt><dd>${escapeHtml(match?.phase ?? "unknown")}</dd></div>
      <div><dt>Turn</dt><dd>${escapeHtml(String(match?.turnNumber ?? "-"))}</dd></div>
      <div><dt>Options</dt><dd>${legalActions.length}</dd></div>
    </dl>
    ${strategicSummary ? `<p>${escapeHtml(strategicSummary)}</p>` : ""}
  `;
  state.actions.replaceChildren(
    ...legalActions.map((action) => actionButton(state, action)),
  );
}

function actionButton(
  state: CoworldPlayerState,
  action: CoworldLegalAction,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "coworld-player-action";
  button.innerHTML = `
    <strong>${escapeHtml(action.label ?? action.id)}</strong>
    <code>${escapeHtml(action.id)}</code>
    <span>${escapeHtml(action.kind ?? "action")}${riskLabel(action)}</span>
  `;
  button.addEventListener("click", () => chooseAction(state, action));
  return button;
}

function chooseAction(
  state: CoworldPlayerState,
  action: CoworldLegalAction,
): void {
  if (
    state.request === null ||
    state.socket === null ||
    state.socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }
  const response = {
    type: "decision_response",
    requestID: state.request.requestID,
    selectedLegalActionId: action.id,
    reason: "selected in Coworld browser player",
    confidence: 0.8,
  };
  state.socket.send(JSON.stringify(response));
  appendLog(state, response);
  state.request = null;
  state.actions.textContent = "";
  state.summary.textContent = "Decision sent. Waiting for the next request.";
}

function riskLabel(action: CoworldLegalAction): string {
  return action.risk?.level ? ` · ${action.risk.level} risk` : "";
}

function setStatus(state: CoworldPlayerState, status: string): void {
  state.status.textContent = status;
}

function appendLog(state: CoworldPlayerState, message: unknown): void {
  const entry = document.createElement("pre");
  entry.textContent = JSON.stringify(message, null, 2);
  state.log.prepend(entry);
  while (state.log.children.length > 8) {
    state.log.lastElementChild?.remove();
  }
}

function requiredElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`missing Coworld player overlay element: ${selector}`);
  }
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function installCoworldPlayerOverlayStyles(): void {
  if (document.getElementById("coworld-player-overlay-styles")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "coworld-player-overlay-styles";
  style.textContent = `
    #coworld-player-overlay {
      position: fixed;
      top: 16px;
      right: 16px;
      bottom: 16px;
      z-index: 100002;
      width: min(420px, calc(100vw - 32px));
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) minmax(90px, 0.45fr);
      gap: 10px;
      padding: 12px;
      color: #17202a;
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(148, 163, 184, 0.55);
      border-radius: 8px;
      box-shadow: 0 16px 44px rgba(15, 23, 42, 0.2);
      font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #coworld-player-overlay header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.35);
    }

    #coworld-player-overlay h2,
    #coworld-player-overlay p {
      margin: 0;
    }

    #coworld-player-overlay h2 {
      font-size: 17px;
      line-height: 1.2;
    }

    #coworld-player-overlay header p,
    #coworld-player-overlay dt,
    #coworld-player-overlay .coworld-player-action span {
      color: #526172;
    }

    #coworld-player-overlay header strong {
      flex: 0 0 auto;
      padding: 4px 8px;
      border: 1px solid rgba(37, 99, 235, 0.25);
      border-radius: 999px;
      color: #1d4ed8;
      background: #eff6ff;
      font-size: 12px;
    }

    #coworld-player-overlay dl {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 0 0 8px;
    }

    #coworld-player-overlay dt {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    #coworld-player-overlay dd {
      margin: 1px 0 0;
      overflow-wrap: anywhere;
      font-weight: 700;
    }

    #coworld-player-overlay .coworld-player-summary {
      min-width: 0;
      padding: 10px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 8px;
      background: #f8fafc;
      overflow: auto;
    }

    #coworld-player-overlay .coworld-player-actions {
      display: grid;
      gap: 8px;
      align-content: start;
      overflow: auto;
      padding-right: 2px;
    }

    #coworld-player-overlay .coworld-player-action {
      display: grid;
      gap: 3px;
      width: 100%;
      min-height: 68px;
      padding: 9px 10px;
      text-align: left;
      color: #17202a;
      background: #fff;
      border: 1px solid rgba(148, 163, 184, 0.45);
      border-radius: 8px;
      cursor: pointer;
    }

    #coworld-player-overlay .coworld-player-action:hover {
      border-color: #2563eb;
      box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.18);
    }

    #coworld-player-overlay code,
    #coworld-player-overlay pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    #coworld-player-overlay .coworld-player-action code {
      color: #334155;
      font-size: 12px;
    }

    #coworld-player-overlay .coworld-player-log {
      display: grid;
      gap: 8px;
      overflow: auto;
      min-height: 0;
    }

    #coworld-player-overlay .coworld-player-log pre {
      margin: 0;
      padding: 8px;
      color: #334155;
      background: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 8px;
      font-size: 11px;
    }

    @media (max-width: 760px) {
      #coworld-player-overlay {
        top: auto;
        left: 8px;
        right: 8px;
        bottom: 8px;
        width: auto;
        max-height: 58vh;
      }
    }
  `;
  document.head.appendChild(style);
}
