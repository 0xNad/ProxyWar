import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAYER_FILES = ["starter-player.mjs", "llm-player.mjs"];

function holdAction() {
  return {
    id: "hold",
    kind: "hold",
    label: "Hold position",
    risk: { level: "none", score: 0 },
  };
}

function capabilityRequest() {
  const dealID = "deal:P_B:P_A:non_aggression_pact:41";
  return {
    type: "decision_request",
    requestID: "req_owner_contract",
    slot: 0,
    protocol: {
      maxActionsPerDecision: 5,
      maxSpawnPreferences: 16,
      maxMessageChars: 280,
    },
    request: {
      protocolVersion: "proxywar-agent-v1",
      observation: {
        phase: "active",
        ownState: {
          playerID: "P_A",
          name: "Owner Agent",
          tileShare: 0.2,
          troops: 1_000,
          troopRatio: 1,
          gold: "1000",
          borderTiles: 10,
          incomingAttacks: 0,
          unitCounts: { City: 1 },
        },
        visiblePlayers: [
          {
            playerID: "P_B",
            name: "Rival B",
            isAlive: true,
            sharesBorder: true,
            isAllied: false,
            isFriendly: true,
            relation: 0,
            canAttack: true,
            bearing: "east",
            distanceClass: "adjacent",
            borderWithYou: {
              tiles: 18,
              shareOfYourBorder: 45,
              terrain: "mixed",
              defensePostsCovering: 1,
              underAttackHere: false,
            },
            bordersWith: [],
          },
        ],
        deals: {
          decisionStep: 42,
          incomingProposals: [
            {
              dealID,
              proposerPlayerID: "P_B",
              proposerName: "Rival B",
              recipientPlayerID: "P_A",
              recipientName: "Owner Agent",
              terms: {
                template: "non_aggression_pact",
                durationSteps: 12,
              },
              proposedAtStep: 41,
              answerableThroughStep: 45,
            },
          ],
          outgoingProposals: [],
          activeDeals: [],
          proposalOptions: [],
          rivalReliability: [],
        },
        nonCombat: { inboundMessages: [] },
        spatial: {
          schemaVersion: 1,
          visibilityModel: "global-lockstep-public-map-v1",
          ownShape: {
            quadrant: "west",
            regionAnalysis: "complete",
            centroidBasis: "largest_region_border",
            coastShare: 25,
            centroid: { xPct: 31, yPct: 54 },
          },
          minimap: {
            schemaVersion: 1,
            width: 24,
            height: 12,
            rows: Array.from({ length: 12 }, () => ".".repeat(24)),
            legend: [],
          },
        },
      },
      legalActions: [
        holdAction(),
        {
          id: `deal_accept:${dealID}`,
          kind: "deal_accept",
          label: "Accept Rival B's non-aggression pact",
          risk: { level: "medium", score: 0.35 },
          metadata: {
            dealID,
            recipientID: "P_B",
            template: "non_aggression_pact",
          },
        },
        {
          id: `deal_reject:${dealID}`,
          kind: "deal_reject",
          label: "Reject Rival B's non-aggression pact",
          risk: { level: "none", score: 0 },
          metadata: {
            dealID,
            recipientID: "P_B",
            template: "non_aggression_pact",
          },
        },
        {
          id: "message:P_B",
          kind: "message",
          label: "Send a private message to Rival B",
          risk: { level: "none", score: 0 },
          metadata: { recipientID: "P_B" },
        },
      ],
    },
  };
}

function absentRequest() {
  return {
    type: "decision_request",
    requestID: "req_absent_contract",
    slot: 0,
    protocol: { maxActionsPerDecision: 5, maxSpawnPreferences: 16 },
    request: {
      protocolVersion: "proxywar-agent-v1",
      observation: {
        phase: "active",
        ownState: { playerID: "P_A", unitCounts: {} },
        visiblePlayers: [],
      },
      legalActions: [holdAction()],
    },
  };
}

function malformedOptionalRequest() {
  const request = absentRequest();
  request.requestID = "req_malformed_optional";
  request.protocol.maxMessageChars = 280;
  request.request.observation.visiblePlayers = {};
  request.request.observation.deals = {
    decisionStep: 1,
    incomingProposals: {},
    outgoingProposals: [],
    activeDeals: [],
    proposalOptions: [],
    rivalReliability: [],
  };
  request.request.observation.nonCombat = {
    inboundMessages: { senderID: "P_B" },
  };
  request.request.observation.spatial = {
    schemaVersion: 1,
    visibilityModel: "private-fog-bypass",
  };
  return request;
}

async function runPlayer(playerFile, request) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const url = `ws://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, [path.join(HERE, playerFile)], {
    cwd: HERE,
    env: {
      ...process.env,
      COWORLD_PLAYER_WS_URL: url,
      AWS_REGION: "us-east-1",
      AWS_EC2_METADATA_DISABLED: "true",
      BEDROCK_MODEL: "owner-contract-no-provider-call",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `${playerFile} timed out; stdout=${stdout}; stderr=${stderr}`,
          ),
        );
      }, 8_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (code !== 0 && signal === null) {
          clearTimeout(timer);
          reject(
            new Error(
              `${playerFile} exited ${code}; stdout=${stdout}; stderr=${stderr}`,
            ),
          );
        }
      });
      server.once("connection", (socket) => {
        socket.once("message", (payload) => {
          clearTimeout(timer);
          const response = JSON.parse(String(payload));
          socket.send(JSON.stringify({ type: "final" }));
          resolve(response);
        });
        socket.send(JSON.stringify(request));
      });
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const playerFile of PLAYER_FILES) {
  test(`${playerFile} preserves exact independent slot authority`, async () => {
    const request = capabilityRequest();
    const response = await runPlayer(playerFile, request);
    const offered = new Set(
      request.request.legalActions.map((action) => action.id),
    );
    assert.equal(response.type, "decision_response");
    assert.ok(offered.has(response.selectedLegalActionId));
    assert.ok(offered.has(response.selectedDealActionId));
    if (playerFile === "starter-player.mjs") {
      assert.equal(response.selectedMessageActionId, "message:P_B");
      assert.equal(typeof response.messageText, "string");
      assert.ok(response.messageText.length > 0);
      assert.ok(response.messageText.length <= 280);
    } else {
      // This harness deliberately provides no Bedrock response. The LLM path
      // must stay silent rather than substituting deterministic negotiation.
      assert.equal("selectedMessageActionId" in response, false);
      assert.equal("messageText" in response, false);
      assert.equal(response.llmPlannerDegraded, true);
    }
  });

  test(`${playerFile} preserves absent-field compatibility`, async () => {
    const response = await runPlayer(playerFile, absentRequest());
    assert.equal(response.selectedLegalActionId, "hold");
    assert.equal("selectedDealActionId" in response, false);
    assert.equal("selectedMessageActionId" in response, false);
    assert.equal("messageText" in response, false);
  });

  test(`${playerFile} fails malformed optional containers closed`, async () => {
    const response = await runPlayer(playerFile, malformedOptionalRequest());
    assert.equal(response.selectedLegalActionId, "hold");
    assert.equal("selectedDealActionId" in response, false);
    assert.equal("selectedMessageActionId" in response, false);
    assert.equal("messageText" in response, false);
  });
}
