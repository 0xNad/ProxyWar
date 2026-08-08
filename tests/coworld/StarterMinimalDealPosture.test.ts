import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const STARTER_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "tester-starter-llm",
  "starter-player.mjs",
);

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} missing`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

async function selectors() {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  const dealKinds = source.match(
    /const DEAL_ACTION_KINDS = \[[\s\S]*?\];/,
  )?.[0];
  expect(dealKinds).toBeDefined();
  return new Function(
    `${dealKinds}\n${extractFunction(source, "isDealActionKind")}\n${extractFunction(source, "activePromiseConstraints")}\n${extractFunction(source, "wouldBreakPromise")}\n${extractFunction(source, "chooseAction")}\n${extractFunction(source, "chooseDealAction")}\nreturn { chooseAction, chooseDealAction };`,
  )() as {
    chooseAction: (actions: unknown[], obs: unknown) => { id: string };
    chooseDealAction: (actions: unknown[]) => { id: string } | null;
  };
}

describe("minimal starter structured-promise posture", () => {
  it("keeps a pending pact rather than accidentally attacking its partner", async () => {
    const { chooseAction } = await selectors();
    const attackPartner = {
      id: "attack:P_OTHER:25",
      kind: "attack",
      risk: { level: "medium" },
      metadata: { targetID: "P_OTHER", expansion: false },
    };
    const expand = {
      id: "attack:neutral:10",
      kind: "attack",
      risk: { level: "low" },
      metadata: { targetID: null, expansion: true },
    };
    const obs = {
      ownState: { playerID: "P_ME" },
      deals: {
        activeDeals: [
          {
            template: "non_aggression_pact",
            proposerPlayerID: "P_ME",
            recipientPlayerID: "P_OTHER",
            obligations: [
              {
                obligorPlayerID: "P_ME",
                status: "pending",
              },
            ],
          },
        ],
      },
    };
    expect(chooseAction([attackPartner, expand], obs).id).toBe(expand.id);

    // Safe fallback still applies the promise filter even when the action kind
    // is not in the starter's preferred list and no hold is present.
    const safeCustom = {
      id: "custom:safe",
      kind: "custom_safe_action",
      risk: { level: "none" },
      metadata: { targetID: "P_NEUTRAL" },
    };
    expect(chooseAction([attackPartner, safeCustom], obs).id).toBe(
      safeCustom.id,
    );
  });

  it("accepts only promises it can keep, declines unsupported commitments, and proposes only non-aggression", async () => {
    const { chooseDealAction } = await selectors();
    const acceptNap = {
      id: "deal_accept:D1",
      kind: "deal_accept",
      metadata: { dealID: "D1", template: "non_aggression_pact" },
    };
    const rejectNap = {
      id: "deal_reject:D1",
      kind: "deal_reject",
      metadata: { dealID: "D1", template: "non_aggression_pact" },
    };
    expect(chooseDealAction([rejectNap, acceptNap])?.id).toBe(acceptNap.id);

    const acceptSupport = {
      id: "deal_accept:D2",
      kind: "deal_accept",
      metadata: { dealID: "D2", template: "support_request" },
    };
    const rejectSupport = {
      id: "deal_reject:D2",
      kind: "deal_reject",
      metadata: { dealID: "D2", template: "support_request" },
    };
    expect(chooseDealAction([acceptSupport, rejectSupport])?.id).toBe(
      rejectSupport.id,
    );

    const proposeAttack = {
      id: "deal_propose:P_X:joint_attack",
      kind: "deal_propose",
      metadata: { template: "joint_attack" },
    };
    const proposeNap = {
      id: "deal_propose:P_X:non_aggression_pact",
      kind: "deal_propose",
      metadata: { template: "non_aggression_pact" },
    };
    expect(chooseDealAction([proposeAttack, proposeNap])?.id).toBe(
      proposeNap.id,
    );
  });
});
