// @vitest-environment node
//
// Runtime (not source-text) regression coverage for the shipped Coworld
// starter agents' handling of the OPTIONAL diplomacy slot
// (`selectedDealActionId`, coworld-adapter/docs/player-protocol.md). Each
// starter-player.mjs is a standalone script, not an importable module (it
// connects a real WebSocket at top-level import time), so this drives the
// SAME wire protocol the real Coworld episode host uses
// (coworld-adapter/src/no-docker-coworld-episode.ts: CoworldProtocolServer /
// startPlayers spawn the identical file as a child process and talk
// decision_request/decision_response JSON frames over a `/player` socket).
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

type DecisionResponse = {
  type: string;
  requestID: string;
  selectedLegalActionId: string;
  selectedDealActionId?: string;
  reason: string;
  confidence?: number;
};

const STARTER_AGENTS: Array<{
  label: string;
  scriptPath: string;
  extraEnv?: Record<string, string>;
}> = [
  {
    label: "canonical (coworld-adapter/src/starter-player.mjs)",
    scriptPath: path.join(here, "starter-player.mjs"),
    // The canonical file resolves `ws` via `${PROXYWAR_REPO}/node_modules/ws`
    // (its production container-mount layout); point it at this checkout.
    extraEnv: { PROXYWAR_REPO: repoRoot },
  },
  {
    label: "tester-starter (rule-based quick-start twin)",
    scriptPath: path.join(
      repoRoot,
      "coworld-adapter/tester-starter/starter-player.mjs",
    ),
  },
  {
    label: "tester-starter-llm (no-LLM fallback companion to llm-player.mjs)",
    scriptPath: path.join(
      repoRoot,
      "coworld-adapter/tester-starter-llm/starter-player.mjs",
    ),
  },
];

function action(
  id: string,
  kind: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    kind,
    label: id,
    risk: { level: "low", score: 0.1 },
    ...overrides,
  };
}

const HOLD = action("hold", "hold", { risk: { level: "none", score: 0 } });
const ATTACK = action("attack:t1", "attack");
const SPAWN = action("spawn:t1", "spawn");

/**
 * Spins up a minimal stand-in for CoworldProtocolServer's `/player` socket,
 * spawns the REAL starter-player.mjs as a child process against it (exactly
 * as no-docker-coworld-episode.ts's startPlayers() does in production), and
 * captures the ONE decision_response frame it sends back for the given
 * legalActions menu.
 */
async function decisionResponseFor(
  agent: (typeof STARTER_AGENTS)[number],
  legalActions: unknown[],
): Promise<DecisionResponse> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake player server did not bind a TCP port");
  }

  let child: ChildProcess | null = null;
  try {
    const responsePromise = new Promise<DecisionResponse>((resolve, reject) => {
      wss.once("connection", (socket) => {
        socket.on("message", (data) => {
          try {
            const message = JSON.parse(String(data));
            if (message.type === "decision_response") {
              resolve(message);
            }
          } catch (error) {
            reject(error);
          }
        });
        socket.send(
          JSON.stringify({
            type: "decision_request",
            requestID: "req_test1",
            slot: 0,
            request: { legalActions, observation: {} },
          }),
        );
      });
      wss.once("error", reject);
    });

    child = spawn(process.execPath, [agent.scriptPath], {
      env: {
        ...process.env,
        COWORLD_PLAYER_WS_URL: `ws://127.0.0.1:${address.port}`,
        ...agent.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

    // Real wall-clock bound, deliberately: this is a genuine OS child
    // process talking over a genuine localhost socket (the same transport
    // production uses), not a debounce/race being synchronized. There is no
    // in-process promise or event to await instead — a hung/crashed starter
    // process must fail the test loudly rather than hang the suite.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `${agent.label} did not send a decision_response within 5s` +
              (stderrChunks.length > 0
                ? `; stderr: ${Buffer.concat(stderrChunks).toString("utf8")}`
                : ""),
          ),
        );
      }, 5000);
    });
    try {
      return await Promise.race([responsePromise, timeout]);
    } finally {
      // Clear as soon as the race settles either way — a real response
      // arrives in milliseconds, so leaving this armed would otherwise
      // stack a live 5s timer per test case for the whole suite run.
      clearTimeout(timeoutHandle);
    }
  } finally {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe.each(STARTER_AGENTS)(
  "shipped Coworld starter agent — diplomacy slot ($label)",
  (agent) => {
    it("sends selectedDealActionId=deal_accept alongside the unrelated primary action", async () => {
      const response = await decisionResponseFor(agent, [
        HOLD,
        ATTACK,
        action("deal_accept:deal:P_B:P_A:non_aggression_pact:1", "deal_accept"),
        action("deal_reject:deal:P_B:P_A:non_aggression_pact:1", "deal_reject"),
      ]);
      expect(response.selectedLegalActionId).toBe(ATTACK.id);
      expect(response.selectedDealActionId).toBe(
        "deal_accept:deal:P_B:P_A:non_aggression_pact:1",
      );
    }, 15000);

    it("prioritizes deal_accept over deal_reject/deal_propose/deal_withdraw when several are offered", async () => {
      const response = await decisionResponseFor(agent, [
        HOLD,
        SPAWN,
        action("deal_propose:P_Y:non_aggression_pact", "deal_propose"),
        action("deal_reject:deal:P_Z:P_A:trade_security_pact:1", "deal_reject"),
        action("deal_withdraw:deal:P_A:P_W:support_request:1", "deal_withdraw"),
        action("deal_accept:deal:P_X:P_A:non_aggression_pact:1", "deal_accept"),
      ]);
      expect(response.selectedDealActionId).toBe(
        "deal_accept:deal:P_X:P_A:non_aggression_pact:1",
      );
    }, 15000);

    it("falls back to deal_reject when no deal_accept is offered", async () => {
      const response = await decisionResponseFor(agent, [
        HOLD,
        SPAWN,
        action("deal_propose:P_Y:non_aggression_pact", "deal_propose"),
        action("deal_withdraw:deal:P_A:P_W:support_request:1", "deal_withdraw"),
        action("deal_reject:deal:P_Z:P_A:trade_security_pact:1", "deal_reject"),
      ]);
      expect(response.selectedDealActionId).toBe(
        "deal_reject:deal:P_Z:P_A:trade_security_pact:1",
      );
    }, 15000);

    it("falls back to deal_propose over deal_withdraw when neither accept nor reject is offered", async () => {
      const response = await decisionResponseFor(agent, [
        HOLD,
        SPAWN,
        action("deal_withdraw:deal:P_A:P_W:support_request:1", "deal_withdraw"),
        action("deal_propose:P_Y:non_aggression_pact", "deal_propose"),
      ]);
      expect(response.selectedDealActionId).toBe(
        "deal_propose:P_Y:non_aggression_pact",
      );
    }, 15000);

    it("omits selectedDealActionId entirely when no deal action is offered (flag-off / no-deal invariance)", async () => {
      const response = await decisionResponseFor(agent, [HOLD, SPAWN, ATTACK]);
      expect(response.selectedLegalActionId).toBe(SPAWN.id);
      expect("selectedDealActionId" in response).toBe(false);
    }, 15000);

    it("never selects a deal_* action as the primary game action, even when hold is the only non-deal alternative", async () => {
      const response = await decisionResponseFor(agent, [
        HOLD,
        action("deal_accept:deal:P_B:P_A:non_aggression_pact:1", "deal_accept"),
        action("deal_reject:deal:P_B:P_A:non_aggression_pact:1", "deal_reject"),
      ]);
      expect(response.selectedLegalActionId).toBe("hold");
      // The diplomacy slot still fires independently of the primary pick.
      expect(response.selectedDealActionId).toBe(
        "deal_accept:deal:P_B:P_A:non_aggression_pact:1",
      );
    }, 15000);
  },
);
