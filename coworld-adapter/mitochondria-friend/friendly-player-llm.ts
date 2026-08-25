/** Production Coworld entrypoint for the LLM-powered MitochondriaFriend. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentBrainInput,
  AgentDecision,
} from "../../src/server/agents/AgentTypes";
import {
  CommanderBedrockProvider,
  commanderRuntimeEnvironment,
  createProductionCommanderBrain,
  PRODUCTION_COMMANDER_MODEL,
  PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
  withCommanderProviderEvidence,
} from "../commander-starter/commander-production-runtime";
import {
  decisionToResponse,
  requestToBrainInput,
  transportFallbackResponse,
  wireMaxActionsPerDecision,
  wireMaxSpawnPreferences,
  withoutKeystoneTreatyBreaches,
} from "../src/keystone-player";
import { createOwnerCapabilityEvidenceLogger } from "../tester-starter-llm/owner-capabilities.mjs";
import {
  createMitochondriaFriendLlmPolicy,
  type MitoLlmPreparation,
} from "./friendly-policy.mjs";

export function withMitoDiplomacy(
  decision: AgentDecision,
  preparation: MitoLlmPreparation,
): AgentDecision {
  return {
    ...decision,
    ...(typeof preparation.selectedDealActionId === "string"
      ? { dealActionID: preparation.selectedDealActionId }
      : {}),
    ...(typeof preparation.selectedMessageActionId === "string" &&
    typeof preparation.messageText === "string"
      ? {
          messageActionID: preparation.selectedMessageActionId,
          messageText: preparation.messageText,
        }
      : {}),
  };
}

export function mitoSpawnDecision(
  preparation: MitoLlmPreparation,
): AgentDecision | null {
  if (
    preparation.mode !== "spawn" ||
    typeof preparation.selectedLegalActionId !== "string" ||
    !Array.isArray(preparation.spawnPreferenceLegalActionIds)
  ) {
    return null;
  }
  return {
    actionID: preparation.selectedLegalActionId,
    spawnPreferenceActionIDs: preparation.spawnPreferenceLegalActionIds,
    reason: preparation.reason,
    metadata: {
      brain: "mitochondria-friend-spawn-preference",
      externalActionCall: false,
      fallbackUsed: false,
      llmPlannerDegraded: false,
    },
  };
}

export function mitoRelationshipOverride(
  preparation: MitoLlmPreparation,
  legalActions: AgentBrainInput["legalActions"],
): AgentDecision | null {
  if (
    preparation.mode !== "llm" ||
    typeof preparation.primaryOverrideActionId !== "string"
  ) {
    return null;
  }
  const offered = legalActions.find(
    (action) => action.id === preparation.primaryOverrideActionId,
  );
  if (
    offered === undefined ||
    ![
      "alliance_request",
      "alliance_extend",
      "donate_gold",
      "donate_troops",
    ].includes(offered.kind)
  ) {
    return null;
  }
  return {
    actionID: offered.id,
    reason: preparation.reason,
    metadata: {
      fallbackUsed: false,
      llmPlannerDegraded: false,
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const url = requiredEnv("COWORLD_PLAYER_WS_URL");
  const repoRoot = process.env.PROXYWAR_REPO ?? "/app/proxywar";
  const runtime = commanderRuntimeEnvironment(process.env, "diplomatic");
  const provider = new CommanderBedrockProvider(
    runtime.region,
    runtime.endpoint,
  );
  const brain = await createProductionCommanderBrain({
    repoRoot,
    provider,
    profile: runtime.profile,
  });
  const prepare = createMitochondriaFriendLlmPolicy();
  const ownerEvidence = createOwnerCapabilityEvidenceLogger();

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

  socket.on("open", () => {
    console.log(
      `MitochondriaFriend connected (brain=llm-commander, model=${PRODUCTION_COMMANDER_MODEL}, profile=${runtime.profile}, inferenceBudgetMs=${PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS})`,
    );
  });
  socket.on("message", (data: unknown) => {
    let message: {
      type?: unknown;
      requestID?: unknown;
      request?: unknown;
      protocol?: unknown;
      slot?: unknown;
    };
    try {
      message = JSON.parse(String(data));
    } catch (error) {
      console.error(
        `MitochondriaFriend dropped an invalid frame: ${error instanceof Error ? error.message : String(error)}`,
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
        const preparation = prepare({
          legalActions: input.legalActions,
          observation: input.observation,
          protocol: message.protocol,
        });
        const spawn = mitoSpawnDecision(preparation);
        let decision: AgentDecision;
        if (spawn !== null) {
          decision = spawn;
        } else {
          const allowed = new Set(preparation.allowedLegalActionIds ?? []);
          const relationshipSafeActions = input.legalActions.filter((action) =>
            allowed.has(action.id),
          );
          const compliantActions = withoutKeystoneTreatyBreaches(
            relationshipSafeActions,
            input.observation,
          );
          if (compliantActions.length === 0) {
            throw new Error("Mito relationship guard produced an empty menu");
          }
          const override = mitoRelationshipOverride(
            preparation,
            input.legalActions,
          );
          const primary =
            override ??
            (await brain.decide({ ...input, legalActions: compliantActions }));
          decision = withMitoDiplomacy(primary, preparation);
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
        ownerEvidence({
          requestID,
          slot: message.slot,
          actions: input.legalActions,
          observation: input.observation,
          response,
          spawn: preparation.mode === "spawn",
        });
        socket.send(JSON.stringify(response));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`MitochondriaFriend decision failed: ${reason}`);
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
