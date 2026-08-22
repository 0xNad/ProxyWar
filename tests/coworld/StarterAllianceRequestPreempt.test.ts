import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DETERMINISTIC_STARTERS = [
  path.join("coworld-adapter", "src", "starter-player.mjs"),
  path.join("coworld-adapter", "tester-starter", "starter-player.mjs"),
  path.join("coworld-adapter", "tester-starter-llm", "starter-player.mjs"),
];
const PROMISE_AWARE_STARTER = path.join(
  "coworld-adapter",
  "tester-starter-llm",
  "starter-player.mjs",
);
const LLM_STARTER = path.join(
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);
const ALL_STARTERS = [...DETERMINISTIC_STARTERS, LLM_STARTER];

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

function optionalFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} missing`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

interface StarterAction {
  id: string;
  kind: string;
  label?: string;
  risk: { level: string };
  metadata?: Record<string, unknown>;
}

interface ActionPicker {
  (actions: StarterAction[], obs: unknown): StarterAction | null;
}

async function pendingAllianceRequestFor(
  relativePath: string,
): Promise<ActionPicker> {
  const source = await read(relativePath);
  return new Function(
    [
      extractFunction(source, "preferReciprocalAlliance"),
      extractFunction(source, "pendingAllianceRequestAction"),
      "return pendingAllianceRequestAction;",
    ].join("\n"),
  )() as ActionPicker;
}

async function deterministicChooseFor(
  relativePath: string,
): Promise<ActionPicker> {
  const source = await read(relativePath);
  const dealKinds = source.match(
    /const DEAL_ACTION_KINDS = \[[\s\S]*?\];/,
  )?.[0];
  expect(dealKinds, "DEAL_ACTION_KINDS missing").toBeDefined();
  return new Function(
    [
      dealKinds!,
      extractFunction(source, "isDealActionKind"),
      optionalFunction(source, "activePromiseConstraints"),
      optionalFunction(source, "wouldBreakPromise"),
      extractFunction(source, "preferReciprocalAlliance"),
      extractFunction(source, "pendingRenewalAction"),
      extractFunction(source, "pendingAllianceRequestAction"),
      extractFunction(source, "chooseAction"),
      "return chooseAction;",
    ].join("\n"),
  )() as ActionPicker;
}

const SPAWN_ACTION: StarterAction = {
  id: "spawn:12",
  kind: "spawn",
  risk: { level: "none" },
  metadata: { tile: 12 },
};
const ATTACK_ACTION: StarterAction = {
  id: "attack:P_FOE",
  kind: "attack",
  label: "Attack Foe",
  risk: { level: "low" },
  metadata: { targetID: "P_FOE", targetName: "Foe" },
};
const HIGH_RISK_ATTACK: StarterAction = {
  ...ATTACK_ACTION,
  id: "attack:P_FOE:high",
  risk: { level: "high" },
};
const AVOID_ATTACK: StarterAction = {
  ...ATTACK_ACTION,
  id: "attack:avoid:P_FOE",
};
const BUILD_ACTION: StarterAction = {
  id: "build:city:44",
  kind: "build",
  risk: { level: "none" },
};
const UPGRADE_ACTION: StarterAction = {
  id: "upgrade_structure:city:44",
  kind: "upgrade_structure",
  risk: { level: "none" },
};
const BOAT_ACTION: StarterAction = {
  id: "boat:P_FOE",
  kind: "boat",
  label: "Boat toward Foe",
  risk: { level: "low" },
  metadata: { targetID: "P_FOE", targetName: "Foe" },
};
const ASKED: StarterAction = {
  id: "alliance_request:P_ASKED",
  kind: "alliance_request",
  label: "Alliance with Asked",
  risk: { level: "low" },
  metadata: { targetID: "P_ASKED", targetName: "Asked" },
};
const HIGH_RISK_ASKED: StarterAction = {
  ...ASKED,
  id: "alliance_request:P_ASKED:high",
  risk: { level: "high" },
};
const STRANGER: StarterAction = {
  id: "alliance_request:P_STRANGER",
  kind: "alliance_request",
  label: "Alliance with Stranger",
  risk: { level: "low" },
  metadata: { targetID: "P_STRANGER", targetName: "Stranger" },
};

function allianceObs(incomingFrom: string | null) {
  return {
    phase: "active",
    turnNumber: 2_000,
    ownState: { playerID: "P_ME" },
    visiblePlayers: [
      {
        playerID: "P_STRANGER",
        name: "Stranger",
        isAlive: true,
        hasSpawned: true,
        sharesBorder: true,
        isAllied: false,
        hasIncomingAllianceRequest: incomingFrom === "P_STRANGER",
      },
      {
        playerID: "P_ASKED",
        name: "Asked",
        isAlive: true,
        hasSpawned: true,
        sharesBorder: true,
        isAllied: false,
        hasIncomingAllianceRequest: incomingFrom === "P_ASKED",
      },
      {
        playerID: "P_FOE",
        name: "Foe",
        isAlive: true,
        hasSpawned: true,
        sharesBorder: true,
        isAllied: false,
        hasIncomingAllianceRequest: false,
      },
    ],
  };
}

describe.each(ALL_STARTERS)(
  "pending alliance request helper: %s",
  (starter) => {
    it("returns the exact offered request aimed at the rival who asked", async () => {
      const pending = await pendingAllianceRequestFor(starter);
      expect(
        pending([ATTACK_ACTION, STRANGER, ASKED], allianceObs("P_ASKED")),
      ).toBe(ASKED);
      expect(
        pending([ATTACK_ACTION, STRANGER, ASKED], allianceObs("P_STRANGER")),
      ).toBe(STRANGER);
    });

    it("does not fire without both a pending signal and its offered id", async () => {
      const pending = await pendingAllianceRequestFor(starter);
      expect(pending([STRANGER, ASKED], allianceObs(null))).toBeNull();
      expect(pending([STRANGER], allianceObs("P_ASKED"))).toBeNull();
    });

    it("fails closed on malformed input", async () => {
      const pending = await pendingAllianceRequestFor(starter);
      expect(pending([ASKED], undefined)).toBeNull();
      expect(pending([ASKED], {})).toBeNull();
      expect(
        pending(
          undefined as unknown as StarterAction[],
          allianceObs("P_ASKED"),
        ),
      ).toBeNull();
    });
  },
);

describe("deterministic starter ordering", () => {
  it.each(DETERMINISTIC_STARTERS)(
    "%s pre-empts an otherwise eligible attack with the exact offered request",
    async (starter) => {
      const choose = await deterministicChooseFor(starter);

      expect(
        choose([ATTACK_ACTION, STRANGER, ASKED], allianceObs("P_ASKED")),
      ).toBe(ASKED);
      expect(
        choose([ATTACK_ACTION, STRANGER, ASKED], allianceObs("P_STRANGER")),
      ).toBe(STRANGER);
      expect(choose([ATTACK_ACTION, STRANGER, ASKED], allianceObs(null))).toBe(
        ATTACK_ACTION,
      );
      expect(choose([STRANGER, ASKED], allianceObs(null))).toBe(STRANGER);
    },
  );

  it.each(DETERMINISTIC_STARTERS)(
    "%s preserves spawn/build/upgrade/boat ordering and requires an eligible attack",
    async (starter) => {
      const choose = await deterministicChooseFor(starter);
      const pending = allianceObs("P_ASKED");

      expect(choose([SPAWN_ACTION, ATTACK_ACTION, ASKED], pending)).toBe(
        SPAWN_ACTION,
      );
      expect(choose([BUILD_ACTION, ASKED], pending)).toBe(BUILD_ACTION);
      expect(choose([UPGRADE_ACTION, ASKED], pending)).toBe(UPGRADE_ACTION);
      expect(choose([BOAT_ACTION, ASKED], pending)).toBe(BOAT_ACTION);
      expect(choose([HIGH_RISK_ATTACK, BUILD_ACTION, ASKED], pending)).toBe(
        BUILD_ACTION,
      );
      expect(choose([AVOID_ATTACK, BOAT_ACTION, ASKED], pending)).toBe(
        BOAT_ACTION,
      );
    },
  );

  it("keeps the promise-aware starter's attack eligibility filter binding", async () => {
    const choose = await deterministicChooseFor(PROMISE_AWARE_STARTER);
    const obs = {
      ...allianceObs("P_ASKED"),
      deals: {
        activeDeals: [
          {
            dealID: "deal:pact",
            template: "non_aggression_pact",
            proposerPlayerID: "P_ME",
            recipientPlayerID: "P_FOE",
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

    expect(choose([ATTACK_ACTION, BUILD_ACTION, ASKED], obs)).toBe(
      BUILD_ACTION,
    );
  });
});

interface LlmChoose {
  (
    plan: unknown,
    actions: StarterAction[],
    obs: unknown,
    avoided?: string[],
  ): StarterAction;
}

async function llmChoose(): Promise<LlmChoose> {
  const source = await read(LLM_STARTER);
  const constOf = (name: string) =>
    source.match(new RegExp(`const ${name} =[\\s\\S]*?;(?=\\n)`))?.[0] ?? "";
  return new Function(
    [
      constOf("DEAL_ACTION_KINDS"),
      constOf("DEAL_TEMPLATES"),
      constOf("DEAL_TRUST_MIN_RELIABILITY"),
      constOf("MESSAGE_MAX_CHARS"),
      constOf("DEFAULT_ORDER"),
      constOf("DEAL_PROPOSAL_RETRY_STEPS"),
      constOf("DEAL_PROPOSAL_MAX_ATTEMPTS_PER_KEY"),
      "const PLAN_EVERY = 6;",
      "const dealProposalAttempts = new Map();",
      "const proposalAttempts = new Map();",
      "const history = [];",
      "let avoided = [];",
      "function avoidActionIDs() { return avoided; }",
      "let plan = null;",
      extractFunction(source, "clean"),
      extractFunction(source, "cleanID"),
      extractFunction(source, "dealConstraints"),
      extractFunction(source, "hasOpenDeal"),
      extractFunction(source, "dealPolicyFor"),
      extractFunction(source, "failedReliabilityGate"),
      extractFunction(source, "chooseDealMove"),
      extractFunction(source, "chooseObligationMove"),
      extractFunction(source, "socialActionNote"),
      optionalFunction(source, "activePromiseConstraints"),
      optionalFunction(source, "wouldBreakPromise"),
      extractFunction(source, "preferReciprocalAlliance"),
      extractFunction(source, "pendingRenewalAction"),
      extractFunction(source, "pendingAllianceRequestAction"),
      extractFunction(source, "choose"),
      [
        "return (nextPlan, actions, obs, nextAvoided = []) => {",
        "  plan = nextPlan;",
        "  avoided = nextAvoided;",
        "  return choose(actions, obs);",
        "};",
      ].join("\n"),
    ].join("\n"),
  )() as LlmChoose;
}

describe("LLM starter ordering and controls", () => {
  const attackPlan = {
    focus: "attack",
    preferKinds: ["attack"],
    target: "Foe",
    reason: "pressure",
  };

  it("pre-empts only the attack candidate and returns the exact offered id", async () => {
    const choose = await llmChoose();
    expect(
      choose(
        attackPlan,
        [ATTACK_ACTION, STRANGER, ASKED],
        allianceObs("P_ASKED"),
      ),
    ).toBe(ASKED);
    expect(
      choose(
        attackPlan,
        [ATTACK_ACTION, STRANGER, ASKED],
        allianceObs("P_STRANGER"),
      ),
    ).toBe(STRANGER);
    expect(
      choose(attackPlan, [ATTACK_ACTION, STRANGER, ASKED], allianceObs(null)),
    ).toBe(ATTACK_ACTION);
  });

  it("keeps earlier planned/default actions ahead and does not trigger without an eligible attack", async () => {
    const choose = await llmChoose();
    const pending = allianceObs("P_ASKED");

    expect(choose(null, [SPAWN_ACTION, ATTACK_ACTION, ASKED], pending)).toBe(
      SPAWN_ACTION,
    );
    expect(
      choose(
        { ...attackPlan, preferKinds: ["build", "attack"] },
        [BUILD_ACTION, ATTACK_ACTION, ASKED],
        pending,
      ),
    ).toBe(BUILD_ACTION);
    expect(
      choose(
        { ...attackPlan, preferKinds: ["boat", "attack"] },
        [BOAT_ACTION, ATTACK_ACTION, ASKED],
        pending,
      ),
    ).toBe(BOAT_ACTION);
    expect(
      choose(
        { ...attackPlan, preferKinds: ["upgrade_structure", "attack"] },
        [UPGRADE_ACTION, ATTACK_ACTION, ASKED],
        pending,
      ),
    ).toBe(UPGRADE_ACTION);
    expect(choose(attackPlan, [BUILD_ACTION, ASKED], pending)).toBe(
      BUILD_ACTION,
    );
    expect(choose(null, [HIGH_RISK_ATTACK, BUILD_ACTION, ASKED], pending)).toBe(
      BUILD_ACTION,
    );
    expect(
      choose(attackPlan, [ATTACK_ACTION, BUILD_ACTION, ASKED], pending, [
        ATTACK_ACTION.id,
      ]),
    ).toBe(BUILD_ACTION);
  });

  it("keeps exact-id, target-avoidance, and high-risk controls binding", async () => {
    const choose = await llmChoose();
    const pending = allianceObs("P_ASKED");

    expect(
      choose(attackPlan, [ATTACK_ACTION, ASKED], pending, [ASKED.id]),
    ).toBe(ATTACK_ACTION);
    expect(choose(null, [STRANGER, ASKED], allianceObs(null))).toBe(STRANGER);
    expect(
      choose(
        { ...attackPlan, avoidTargets: ["Asked"] },
        [ATTACK_ACTION, ASKED],
        pending,
      ),
    ).toBe(ATTACK_ACTION);
    expect(choose(attackPlan, [ATTACK_ACTION, HIGH_RISK_ASKED], pending)).toBe(
      ATTACK_ACTION,
    );
    expect(
      choose(
        {
          ...attackPlan,
          preferKinds: ["attack", "alliance_request"],
          target: "Asked",
        },
        [ATTACK_ACTION, HIGH_RISK_ASKED],
        pending,
      ),
    ).toBe(HIGH_RISK_ASKED);
  });
});
