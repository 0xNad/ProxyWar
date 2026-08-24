import { WebSocket } from "ws";
import {
  createOwnerCapabilityEvidenceLogger,
  dealResponseFields,
  messageResponseFields,
  ownerCapabilityObservation,
} from "./owner-capabilities.mjs";
import { createMitochondriaFriendPolicy } from "./friendly-policy.mjs";

const url = process.env.COWORLD_PLAYER_WS_URL;
if (!url) throw new Error("COWORLD_PLAYER_WS_URL is required");

const choose = createMitochondriaFriendPolicy();
const ownerEvidence = createOwnerCapabilityEvidenceLogger();
const socket = new WebSocket(url);

socket.on("open", () => console.log("MitochondriaFriend connected"));
socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.type === "final") {
    socket.close();
    return;
  }
  if (message.type !== "decision_request") return;

  const actions = Array.isArray(message.request?.legalActions)
    ? message.request.legalActions
    : [];
  const observation = ownerCapabilityObservation(message.request?.observation);
  const decision = choose({
    legalActions: actions,
    observation,
    protocol: message.protocol,
  });
  const selectedDeal = actions.find(
    (action) => action.id === decision.selectedDealActionId,
  );
  const response = {
    type: "decision_response",
    requestID: message.requestID,
    selectedLegalActionId: decision.selectedLegalActionId,
    ...(decision.spawnPreferenceLegalActionIds
      ? {
          spawnPreferenceLegalActionIds:
            decision.spawnPreferenceLegalActionIds,
        }
      : {}),
    ...dealResponseFields({
      actions,
      observation,
      dealMove: selectedDeal,
    }),
    ...messageResponseFields({
      actions,
      protocol: message.protocol,
      messageMove:
        decision.selectedMessageActionId && decision.messageText
          ? {
              id: decision.selectedMessageActionId,
              text: decision.messageText,
            }
          : null,
    }),
    runtimeMode: "mitochondria-friend-diplomacy-v1",
    reason: decision.reason,
    confidence: decision.confidence,
    fallbackUsed: false,
    llmPlannerDegraded: false,
  };

  ownerEvidence({
    requestID: message.requestID,
    slot: message.slot,
    actions,
    observation,
    response,
    spawn: Boolean(decision.spawnPreferenceLegalActionIds),
  });
  socket.send(JSON.stringify(response));
});

const lingerMs = Number(
  process.env.PROXYWAR_PLAYER_POST_FINAL_LINGER_MS ?? "0",
);
const lingerArmed =
  process.env.KUBERNETES_SERVICE_HOST !== undefined ||
  process.env.PROXYWAR_PLAYER_FORCE_LINGER === "1";
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
socket.on("close", () => {
  if (lingerArmed && Number.isFinite(lingerMs) && lingerMs > 0) {
    setTimeout(() => process.exit(0), lingerMs);
    return;
  }
  process.exit(0);
});
socket.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
