import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const POLICY_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "testing",
  "hosted-social-counterparty-policy.mjs",
);
const PLAYER_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "testing",
  "hosted-social-counterparty-player.mjs",
);
const DOCKERFILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "testing",
  "Dockerfile.hosted-social-counterparty",
);

type Decision = {
  selectedLegalActionId: string;
  selectedDealActionId?: string;
  reason: string;
};

async function policy(profile: string) {
  const module = (await import(pathToFileURL(POLICY_FILE).href)) as {
    createHostedSocialCounterpartyPolicy: (
      value: string,
    ) => (input: unknown) => Decision;
    resolveHostedSocialCounterpartyConfig: (input: unknown) => unknown;
  };
  return {
    choose: module.createHostedSocialCounterpartyPolicy(profile),
    resolve: module.resolveHostedSocialCounterpartyConfig,
  };
}

async function driveDonationProbe(requests: unknown[]): Promise<Decision[]> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const frames: Decision[] = [];
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("non-friendly donation probe did not answer")),
      10_000,
    );
    server.on("connection", (socket) => {
      let index = 0;
      socket.send(JSON.stringify(requests[index]));
      socket.on("message", (data) => {
        frames.push(JSON.parse(String(data)) as Decision);
        index += 1;
        if (index === requests.length) {
          clearTimeout(timer);
          resolve();
          return;
        }
        socket.send(JSON.stringify(requests[index]));
      });
    });
  });
  const child = spawn(process.execPath, [PLAYER_FILE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COWORLD_PLAYER_WS_URL: `ws://127.0.0.1:${port}`,
      PROXYWAR_HOSTED_SOCIAL_COUNTERPARTY: "nonfriendly-donation-probe",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    await finished;
  } catch (error) {
    throw new Error(`${String(error)}\nstderr: ${stderr.join("")}`, {
      cause: error,
    });
  } finally {
    child.kill("SIGKILL");
    for (const client of server.clients) client.terminate();
    server.close();
  }
  return frames;
}

const HOLD = { id: "hold", kind: "hold", risk: { level: "none" } };
const SPAWN = { id: "spawn:1234", kind: "spawn", risk: { level: "low" } };
const GOLD = {
  id: "donate_gold:P_STARTER",
  kind: "donate_gold",
  risk: { level: "low" },
  metadata: { recipientID: "P_STARTER", gold: 50_000 },
};
const TROOPS = {
  id: "donate_troops:P_STARTER",
  kind: "donate_troops",
  risk: { level: "low" },
  metadata: { recipientID: "P_STARTER", troops: 5_000 },
};
const MESSAGE = {
  id: "message:P_STARTER:hello",
  kind: "message",
  risk: { level: "none" },
  metadata: { recipientID: "P_STARTER" },
};
const ALLIANCE = {
  id: "alliance_request:P_STARTER",
  kind: "alliance_request",
  risk: { level: "low" },
  metadata: { recipientID: "P_STARTER" },
};
const EXPAND = {
  id: "attack:neutral:10",
  kind: "attack",
  risk: { level: "low" },
  metadata: { expansion: true },
};
const ATTACK = {
  id: "attack:P_STARTER:20",
  kind: "attack",
  risk: { level: "medium" },
  metadata: { targetID: "P_STARTER", expansion: false },
};
const NAP = {
  id: "deal_propose:P_STARTER:non_aggression_pact",
  kind: "deal_propose",
  risk: { level: "low" },
  metadata: {
    recipientID: "P_STARTER",
    template: "non_aggression_pact",
  },
};
const SUPPORT = {
  id: "deal_propose:P_STARTER:support_request",
  kind: "deal_propose",
  risk: { level: "low" },
  metadata: { recipientID: "P_STARTER", template: "support_request" },
};

function baseObservation(step = 10) {
  return {
    ownState: {
      playerID: "P_CONTROL",
      tileShare: 0.2,
      troopRatio: 0.5,
      incomingAttacks: 0,
    },
    visiblePlayers: [
      {
        playerID: "P_STARTER",
        isAlive: true,
        isFriendly: false,
        sharesBorder: true,
        canAttack: true,
        tileShare: 0.3,
        troops: 20_000,
        maxTroops: 100_000,
      },
    ],
    deals: {
      decisionStep: step,
      incomingProposals: [],
      outgoingProposals: [],
      activeDeals: [],
      rivalReliability: [] as Array<{
        playerID: string;
        fulfilled: number;
        terminalNonMoot: number;
        reliability: number;
      }>,
    },
  };
}

function incoming(dealID: string, template: string) {
  return {
    dealID,
    proposerPlayerID: "P_STARTER",
    terms: {
      template,
      goldAmount: "50000",
      troopAmount: 5000,
    },
    answerableThroughStep: 20,
  };
}

function response(dealID: string, kind: "deal_accept" | "deal_reject") {
  return {
    id: `${kind}:${dealID}`,
    kind,
    risk: { level: "none" },
    metadata: { dealID },
  };
}

describe("hosted social counterparty policy", () => {
  it("freezes the build profile ahead of runtime overrides", async () => {
    const { resolve } = await policy("deal-blind");
    expect(
      resolve({
        builtConfig: { profile: "pact-keeper" },
        argv: ["pact-breaker"],
        env: { PROXYWAR_HOSTED_SOCIAL_COUNTERPARTY: "mutual-aid" },
      }),
    ).toEqual({ profile: "pact-keeper", source: "build" });
  });

  it("keeps the deal-blind control out of the diplomacy slot", async () => {
    const { choose } = await policy("deal-blind");
    const decision = choose({
      legalActions: [NAP, EXPAND, HOLD],
      observation: baseObservation(),
    });
    expect(decision.selectedLegalActionId).toBe(EXPAND.id);
    expect(decision.selectedDealActionId).toBeUndefined();
  });

  it("selects exact offered non-friendly gold then troops from slot zero only", async () => {
    const { choose } = await policy("nonfriendly-donation-probe");
    expect(
      choose({
        slot: 0,
        legalActions: [SPAWN],
        observation: baseObservation(),
      }).selectedLegalActionId,
    ).toBe(SPAWN.id);
    const first = choose({
      slot: 0,
      legalActions: [TROOPS, NAP, MESSAGE, ALLIANCE, GOLD, HOLD],
      observation: baseObservation(),
    });
    expect(first.selectedLegalActionId).toBe(GOLD.id);
    expect(first.selectedDealActionId).toBeUndefined();
    expect(first.reason).toContain("never allies, messages, or deals");

    const second = choose({
      slot: 0,
      legalActions: [GOLD, TROOPS, NAP, MESSAGE, ALLIANCE, HOLD],
      observation: baseObservation(11),
    });
    expect(second.selectedLegalActionId).toBe(TROOPS.id);
    expect(second.selectedDealActionId).toBeUndefined();

    expect(
      choose({
        slot: 0,
        legalActions: [GOLD, TROOPS, NAP, MESSAGE, ALLIANCE, HOLD],
        observation: baseObservation(12),
      }).selectedLegalActionId,
    ).toBe(HOLD.id);
  });

  it("holds rather than switching recipients, allying, messaging, or dealing", async () => {
    const donor = (await policy("nonfriendly-donation-probe")).choose;
    const recipient = (await policy("nonfriendly-donation-probe")).choose;
    const otherTroops = {
      id: "donate_troops:P_OTHER",
      kind: "donate_troops",
      risk: { level: "low" },
      metadata: { recipientID: "P_OTHER", troops: 5_000 },
    };
    expect(
      recipient({
        slot: 1,
        legalActions: [SPAWN],
        observation: baseObservation(),
      }).selectedLegalActionId,
    ).toBe(SPAWN.id);
    expect(
      donor({
        slot: 0,
        legalActions: [GOLD, HOLD],
        observation: baseObservation(),
      }).selectedLegalActionId,
    ).toBe(GOLD.id);
    expect(
      donor({
        slot: 0,
        legalActions: [otherTroops, NAP, MESSAGE, ALLIANCE, HOLD],
        observation: {
          ...baseObservation(),
          visiblePlayers: [
            ...baseObservation().visiblePlayers,
            {
              playerID: "P_OTHER",
              isAlive: true,
              isFriendly: false,
            },
          ],
        },
      }).selectedLegalActionId,
    ).toBe(HOLD.id);

    const passive = recipient({
      slot: 1,
      legalActions: [GOLD, NAP, MESSAGE, ALLIANCE, HOLD],
      observation: baseObservation(),
    });
    expect(passive.selectedLegalActionId).toBe(HOLD.id);
    expect(passive.selectedDealActionId).toBeUndefined();

    expect(
      recipient({
        legalActions: [GOLD, NAP, MESSAGE, ALLIANCE, HOLD],
        observation: baseObservation(),
      }).selectedLegalActionId,
    ).toBe(HOLD.id);
  });

  it("requires an observed non-friendly recipient and preserves the slot build contract", async () => {
    const { choose, resolve } = await policy("nonfriendly-donation-probe");
    const friendly = baseObservation();
    friendly.visiblePlayers[0].isFriendly = true;
    expect(
      choose({
        slot: 0,
        legalActions: [GOLD, HOLD],
        observation: friendly,
      }).selectedLegalActionId,
    ).toBe(HOLD.id);
    expect(
      resolve({ builtConfig: { profile: "nonfriendly-donation-probe" } }),
    ).toEqual({ profile: "nonfriendly-donation-probe", source: "build" });
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    expect(dockerfile).toContain('"nonfriendly-donation-probe"');
    expect(dockerfile).toContain(
      "node:24-bookworm-slim@sha256:ccd0612136f105d59d7266585b0bff88016e3da94c8ebfc8ad1154b529f59e7b",
    );
  });

  it("executes the shipped player entrypoint with the Coworld slot carrier", async () => {
    const request = (requestID: string, legalActions: unknown[]) => ({
      type: "decision_request",
      requestID,
      slot: 0,
      request: { legalActions, observation: baseObservation() },
    });
    const frames = await driveDonationProbe([
      request("gold", [GOLD, TROOPS, NAP, HOLD]),
      request("troops", [GOLD, TROOPS, NAP, HOLD]),
    ]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      selectedLegalActionId: GOLD.id,
      requestID: "gold",
    });
    expect(frames[1]).toMatchObject({
      selectedLegalActionId: TROOPS.id,
      requestID: "troops",
    });
    expect(
      frames.every((frame) => frame.selectedDealActionId === undefined),
    ).toBe(true);
    expect(
      frames.every(
        (frame) => !("selectedMessageActionId" in (frame as object)),
      ),
    ).toBe(true);
  });

  it("makes keeping and breaking the same accepted pact observably different", async () => {
    const active = {
      ...baseObservation(12),
      deals: {
        ...baseObservation(12).deals,
        activeDeals: [
          {
            dealID: "PACT",
            template: "non_aggression_pact",
            proposerPlayerID: "P_STARTER",
            recipientPlayerID: "P_CONTROL",
            activeFromStep: 12,
            obligations: [
              {
                obligorPlayerID: "P_CONTROL",
                status: "pending",
                kind: "non_aggression",
              },
            ],
          },
        ],
      },
    };
    const keeper = (await policy("pact-keeper")).choose({
      legalActions: [ATTACK, HOLD],
      observation: active,
    });
    const breaker = (await policy("pact-breaker")).choose({
      legalActions: [ATTACK, HOLD],
      observation: active,
    });
    expect(keeper.selectedLegalActionId).toBe(HOLD.id);
    expect(breaker.selectedLegalActionId).toBe(ATTACK.id);
    expect(breaker.reason).toContain("intentionally violates");
  });

  it("rejects positive promises the profile does not explicitly fulfill", async () => {
    const { choose } = await policy("pact-keeper");
    const proposal = incoming("JOINT", "joint_attack");
    expect(
      choose({
        legalActions: [
          response("JOINT", "deal_accept"),
          response("JOINT", "deal_reject"),
          HOLD,
        ],
        observation: {
          ...baseObservation(),
          deals: {
            ...baseObservation().deals,
            incomingProposals: [proposal],
          },
        },
      }).selectedDealActionId,
    ).toBe("deal_reject:JOINT");
  });

  it("offers at most two bordered NAPs with a meaningful retry interval", async () => {
    const { choose } = await policy("pact-keeper");
    const decide = (step: number) =>
      choose({
        legalActions: [NAP, EXPAND, HOLD],
        observation: baseObservation(step),
      });
    expect(decide(4).selectedDealActionId).toBe(NAP.id);
    expect(decide(5).selectedDealActionId).toBeUndefined();
    expect(decide(34).selectedDealActionId).toBe(NAP.id);
    expect(decide(64).selectedDealActionId).toBeUndefined();
  });

  it("requests bounded support only when disadvantaged", async () => {
    const { choose } = await policy("mutual-aid");
    const observation = baseObservation(18);
    observation.visiblePlayers[0].isFriendly = true;
    expect(
      choose({
        legalActions: [SUPPORT, EXPAND, HOLD],
        observation,
      }).selectedDealActionId,
    ).toBeUndefined();
    observation.deals.rivalReliability = [
      {
        playerID: "P_STARTER",
        fulfilled: 1,
        terminalNonMoot: 1,
        reliability: 1,
      },
    ];
    const first = choose({
      legalActions: [SUPPORT, EXPAND, HOLD],
      observation,
    });
    expect(first.selectedDealActionId).toBe(SUPPORT.id);
    const immediate = choose({
      legalActions: [SUPPORT, EXPAND, HOLD],
      observation: {
        ...observation,
        deals: { ...observation.deals, decisionStep: 19 },
      },
    });
    expect(immediate.selectedDealActionId).toBeUndefined();
    const retry = choose({
      legalActions: [SUPPORT, EXPAND, HOLD],
      observation: {
        ...observation,
        deals: { ...observation.deals, decisionStep: 78 },
      },
    });
    expect(retry.selectedDealActionId).toBe(SUPPORT.id);
  });

  it("accepts and fulfills support only after the partner has earned reciprocity", async () => {
    const { choose } = await policy("mutual-aid");
    const support = incoming("SUPPORT", "support_request");
    const accept = response("SUPPORT", "deal_accept");
    const reject = response("SUPPORT", "deal_reject");
    const donate = {
      id: "donate_gold:P_STARTER",
      kind: "donate_gold",
      risk: { level: "low" },
      metadata: { recipientID: "P_STARTER", gold: 50000 },
    };
    const unearnedBase = baseObservation(20);
    const unearned = {
      ...unearnedBase,
      visiblePlayers: unearnedBase.visiblePlayers.map((player) => ({
        ...player,
        isFriendly: true,
      })),
      deals: {
        ...unearnedBase.deals,
        incomingProposals: [support],
      },
    };
    expect(
      choose({
        legalActions: [accept, reject, donate, HOLD],
        observation: unearned,
      }).selectedDealActionId,
    ).toBe(reject.id);

    const earned = {
      ...unearned,
      deals: {
        ...unearned.deals,
        rivalReliability: [
          {
            playerID: "P_STARTER",
            fulfilled: 1,
            terminalNonMoot: 1,
            reliability: 1,
          },
        ],
      },
    };
    expect(
      choose({
        legalActions: [accept, reject, donate, HOLD],
        observation: earned,
      }).selectedDealActionId,
    ).toBe(accept.id);

    const troopOnly = {
      id: "donate_troops:P_STARTER",
      kind: "donate_troops",
      risk: { level: "medium" },
      metadata: { recipientID: "P_STARTER", troops: 7000 },
    };
    const nearCap = {
      ...earned,
      visiblePlayers: earned.visiblePlayers.map((player) => ({
        ...player,
        troops: 98_000,
        maxTroops: 100_000,
      })),
    };
    expect(
      choose({
        legalActions: [accept, reject, troopOnly, HOLD],
        observation: nearCap,
      }).selectedDealActionId,
    ).toBe(reject.id);

    const active = {
      ...earned,
      deals: {
        ...earned.deals,
        incomingProposals: [],
        activeDeals: [
          {
            dealID: "SUPPORT",
            proposerPlayerID: "P_STARTER",
            recipientPlayerID: "P_CONTROL",
            obligations: [
              {
                obligorPlayerID: "P_CONTROL",
                status: "pending",
                kind: "send_support",
                goldAmount: "50000",
                troopAmount: 5000,
                donatedGold: "0",
                donatedTroops: 0,
              },
            ],
          },
        ],
      },
    };
    expect(
      choose({ legalActions: [EXPAND, donate, HOLD], observation: active })
        .selectedLegalActionId,
    ).toBe(donate.id);
  });
});
