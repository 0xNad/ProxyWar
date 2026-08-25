/**
 * Production Coworld entrypoint for the LLM Strategic Commander.
 *
 * This deliberately omits the eval-only run key, provider preflight, and
 * artifact-finalization handshake used by commander-xp-player.ts. It accepts
 * the ordinary production player websocket contract and still preserves the
 * same state -> locked option -> private binding -> exact offered action path.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentBrainInput,
  AgentDecision,
} from "../../src/server/agents/AgentTypes";
import {
  chooseKeystoneDealMove,
  chooseKeystoneMessageMove,
  decisionToResponse,
  requestToBrainInput,
  spawnPreferenceDecision,
  transportFallbackResponse,
  wireMaxActionsPerDecision,
  wireMaxSpawnPreferences,
  withKeystoneDeal,
  withKeystoneMessage,
  withoutKeystoneTreatyBreaches,
} from "../src/keystone-player";
import {
  CommanderBedrockProvider,
  commanderBedrockRequest,
  commanderBedrockSidecarEndpoint,
  commanderProviderEvidenceFromResponse,
  commanderRuntimeEnvironment,
  createProductionCommanderBrain,
  PRODUCTION_COMMANDER_DECISION_BUDGET_MS,
  PRODUCTION_COMMANDER_MODEL,
  PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
  withCommanderProviderEvidence,
} from "./commander-production-runtime";

export {
  commanderBedrockRequest,
  commanderBedrockSidecarEndpoint,
  commanderProviderEvidenceFromResponse,
  commanderRuntimeEnvironment,
  createProductionCommanderBrain,
  PRODUCTION_COMMANDER_DECISION_BUDGET_MS,
  PRODUCTION_COMMANDER_MODEL,
  PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
  withCommanderProviderEvidence,
};

/**
 * Alliance acceptance is a returning alliance_request, not a separate action
 * kind. When another player is already waiting, reciprocating one exact
 * offered id is the highest-value social move and must not depend on the LLM
 * selecting a diplomacy family that turn.
 */
export function productionCommanderReciprocalAlliance(
  input: AgentBrainInput,
): AgentDecision | null {
  const incoming = new Set(
    (input.observation.visiblePlayers ?? [])
      .filter((player) => player.hasIncomingAllianceRequest === true)
      .map((player) => player.playerID),
  );
  const action = input.legalActions.find((candidate) => {
    const metadata = candidate.metadata as
      | { targetID?: unknown; recipientID?: unknown; playerID?: unknown }
      | undefined;
    const targetID =
      metadata?.targetID ?? metadata?.recipientID ?? metadata?.playerID;
    return (
      candidate.kind === "alliance_request" &&
      typeof targetID === "string" &&
      incoming.has(targetID)
    );
  });
  return action
    ? {
        actionID: action.id,
        reason:
          "Commander reciprocated an exact offered incoming alliance request",
        metadata: {
          runtimeMode: "commander-social-reciprocity",
          fallbackUsed: false,
          llmPlannerDegraded: false,
        },
      }
    : null;
}

export function withProductionCommanderSocial(input: {
  decision: AgentDecision;
  brainInput: AgentBrainInput;
  answeredMessages: Set<string>;
  proposedDeals: Set<string>;
}): AgentDecision {
  return withKeystoneDeal(
    withKeystoneMessage(
      input.decision,
      chooseKeystoneMessageMove(
        input.brainInput.legalActions,
        input.brainInput.observation,
        input.answeredMessages,
      ),
    ),
    chooseKeystoneDealMove({
      observation: input.brainInput.observation,
      legalActions: input.brainInput.legalActions,
      proposed: input.proposedDeals,
    }),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const url = requiredEnv("COWORLD_PLAYER_WS_URL");
  const repoRoot = process.env.PROXYWAR_REPO ?? "/app/proxywar";
  const runtime = commanderRuntimeEnvironment();
  const provider = new CommanderBedrockProvider(
    runtime.region,
    runtime.endpoint,
  );
  const brain = await createProductionCommanderBrain({
    repoRoot,
    provider,
    profile: runtime.profile,
  });

  const require = createRequire(import.meta.url);
  const { WebSocket } = require(`${repoRoot}/node_modules/ws`) as {
    WebSocket: new (url: string) => {
      on(event: string, listener: (...args: any[]) => void): void;
      send(body: string): void;
      close(): void;
    };
  };
  const socket = new WebSocket(url);
  let decisionChain: Promise<void> = Promise.resolve();
  let sawFinal = false;
  const answeredMessages = new Set<string>();
  const proposedDeals = new Set<string>();

  socket.on("open", () => {
    console.log(
      `commander connected (model=${PRODUCTION_COMMANDER_MODEL}, profile=${runtime.profile}, inferenceBudgetMs=${PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS})`,
    );
  });
  socket.on("message", (data: unknown) => {
    let message: {
      type?: unknown;
      requestID?: unknown;
      request?: unknown;
      protocol?: unknown;
    };
    try {
      message = JSON.parse(String(data));
    } catch (error) {
      console.error(
        `commander dropped an invalid frame: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (message.type === "final") {
      sawFinal = true;
      void decisionChain.finally(() => socket.close());
      return;
    }
    if (message.type !== "decision_request") return;

    decisionChain = decisionChain.then(async () => {
      const requestID = String(message.requestID ?? "");
      try {
        const evidenceCursor = provider.evidenceCursor();
        const input: AgentBrainInput = requestToBrainInput(
          message.request,
          runtime.profile,
        );
        const spawnDecision = spawnPreferenceDecision(
          input,
          wireMaxSpawnPreferences(message),
        );
        let decision: AgentDecision;
        if (spawnDecision !== null) {
          decision = spawnDecision;
        } else {
          let compliantActions = input.legalActions;
          try {
            compliantActions = withoutKeystoneTreatyBreaches(
              input.legalActions,
              input.observation,
            );
          } catch (error) {
            console.error(
              `commander treaty guard skipped: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const compliantInput = {
            ...input,
            legalActions: compliantActions,
          };
          const reciprocal = productionCommanderReciprocalAlliance(input);
          const decided = reciprocal ?? (await brain.decide(compliantInput));
          try {
            decision = withProductionCommanderSocial({
              decision: decided,
              brainInput: input,
              answeredMessages,
              proposedDeals,
            });
          } catch (socialError) {
            console.error(
              `commander social slots skipped: ${socialError instanceof Error ? socialError.message : String(socialError)}`,
            );
            decision = decided;
          }
        }
        const response = withCommanderProviderEvidence(
          decisionToResponse(
            requestID,
            decision,
            wireMaxActionsPerDecision(message),
            wireMaxSpawnPreferences(message),
          ),
          decision,
          provider.providerEvidenceAfter(evidenceCursor),
        );
        socket.send(JSON.stringify(response));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`commander decision failed: ${reason}`);
        socket.send(
          JSON.stringify(
            transportFallbackResponse(requestID, message.request, reason),
          ),
        );
      }
    });
  });
  socket.on("close", () => process.exit(sawFinal ? 0 : 1));
  socket.on("error", (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
