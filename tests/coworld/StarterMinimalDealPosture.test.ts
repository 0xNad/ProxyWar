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
    `${dealKinds}\n${extractFunction(source, "isDealActionKind")}\n${extractFunction(source, "activePromiseConstraints")}\n${extractFunction(source, "wouldBreakPromise")}\n${extractFunction(source, "preferReciprocalAlliance")}\n${extractFunction(source, "pendingRenewalAction")}\n${extractFunction(source, "pendingAllianceRequestAction")}\n${extractFunction(source, "chooseAction")}\n${extractFunction(source, "chooseDealAction")}\nreturn { chooseAction, chooseDealAction };`,
  )() as {
    chooseAction: (actions: unknown[], obs: unknown) => { id: string };
    chooseDealAction: (actions: unknown[]) => { id: string } | null;
  };
}

// Every shipped starter copy that can pick a deal action. All three are
// container entrypoints, so the withdraw-fallthrough defect had to be fixed in
// each; this pins all of them.
const DEAL_SELECTOR_FILES = [
  path.join("coworld-adapter", "tester-starter-llm", "starter-player.mjs"),
  path.join("coworld-adapter", "tester-starter", "starter-player.mjs"),
  path.join("coworld-adapter", "src", "starter-player.mjs"),
];

async function dealSelectorFor(relativePath: string) {
  const source = await fs.readFile(
    path.join(process.cwd(), relativePath),
    "utf8",
  );
  const kinds = source.match(/const DEAL_ACTION_KINDS = \[[\s\S]*?\];/)?.[0];
  expect(kinds, `DEAL_ACTION_KINDS missing in ${relativePath}`).toBeDefined();
  // Present only in the copies that select via a kind loop.
  const selectionKinds =
    source.match(
      /const DEAL_SELECTION_KINDS = DEAL_ACTION_KINDS\.filter\([\s\S]*?\);/,
    )?.[0] ?? "";
  return new Function(
    `${kinds}\n${selectionKinds}\n${extractFunction(source, "chooseDealAction")}\nreturn chooseDealAction;`,
  )() as (actions: unknown[]) => { id: string; kind: string } | null;
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

  it("never withdraws its own offer just because nothing else is on the menu", async () => {
    const { chooseDealAction } = await selectors();
    // The step right after proposing: the pair already holds an open deal so no
    // deal_propose is offered for it, and the proposer is inside the 3-step
    // cooldown. Withdraw is the only deal action left on the menu. Taking it
    // here retracts the offer before the recipient has answered even once.
    const withdraw = {
      id: "deal_withdraw:D9",
      kind: "deal_withdraw",
      metadata: { dealID: "D9", template: "non_aggression_pact" },
    };
    expect(chooseDealAction([withdraw])).toBeNull();

    // Non-deal actions on the menu change nothing.
    const attack = {
      id: "attack:neutral:10",
      kind: "attack",
      metadata: { targetID: null, expansion: true },
    };
    expect(chooseDealAction([attack, withdraw])).toBeNull();

    // Answering still outranks everything when an answer is available.
    const acceptNap = {
      id: "deal_accept:D9",
      kind: "deal_accept",
      metadata: { dealID: "D9", template: "non_aggression_pact" },
    };
    expect(chooseDealAction([withdraw, acceptNap])?.id).toBe(acceptNap.id);

    // A fresh proposal opportunity is still preferred over withdrawing.
    const proposeNap = {
      id: "deal_propose:P_X:non_aggression_pact",
      kind: "deal_propose",
      metadata: { template: "non_aggression_pact" },
    };
    expect(chooseDealAction([withdraw, proposeNap])?.id).toBe(proposeNap.id);
  });
});

describe("every shipped starter refuses to withdraw as an idle fallback", () => {
  const withdraw = {
    id: "deal_withdraw:D9",
    kind: "deal_withdraw",
    metadata: { dealID: "D9", template: "non_aggression_pact" },
  };
  const acceptNap = {
    id: "deal_accept:D9",
    kind: "deal_accept",
    metadata: { dealID: "D9", template: "non_aggression_pact" },
  };
  const proposeNap = {
    id: "deal_propose:P_X:non_aggression_pact",
    kind: "deal_propose",
    metadata: { template: "non_aggression_pact" },
  };

  it.each(DEAL_SELECTOR_FILES)(
    "%s never selects deal_withdraw when it is the only deal action offered",
    async (file) => {
      const chooseDealAction = await dealSelectorFor(file);
      // The step right after proposing: the pair already holds an open deal so
      // no deal_propose is offered for it, and the proposer is inside the
      // 3-step cooldown. Withdraw must not be taken to fill the slot.
      expect(chooseDealAction([withdraw])).toBeNull();
      expect(chooseDealAction([withdraw, acceptNap])?.id).toBe(acceptNap.id);
      expect(chooseDealAction([withdraw, proposeNap])?.id).toBe(proposeNap.id);
    },
  );

  it.each(DEAL_SELECTOR_FILES)(
    "%s still lists deal_withdraw in DEAL_ACTION_KINDS so it stays out of the primary slot",
    async (file) => {
      const source = await fs.readFile(path.join(process.cwd(), file), "utf8");
      const kinds = source.match(
        /const DEAL_ACTION_KINDS = \[[\s\S]*?\];/,
      )?.[0];
      expect(kinds).toContain("deal_withdraw");
    },
  );
});
