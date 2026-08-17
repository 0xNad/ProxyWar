import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Alliance renewal in every shipped starter.
 *
 * Renewal is MUTUAL and one-shot: the core extends only once both sides have
 * asked inside a window worth ~10% of the alliance's life, and
 * `canExtendAlliance` goes false the moment you ask. 0.1.48 shipped the
 * server-side half of the fix — `allianceSelfAgreedToExtend` and
 * `allianceOtherAgreedToExtend` on the observation — after 40 of 42 hosted
 * renewal attempts died one-sided.
 *
 * The client half was missing entirely. Before this suite:
 *   - `alliance_extend` appeared ZERO times in all four shipped starters;
 *   - it was absent from the deterministic `preferredKinds` list, so those
 *     seats could not renew even when the action was offered;
 *   - it was absent from the LLM starter's `PLAN_KINDS`, so the model was never
 *     told the action exists;
 *   - `buildState` surfaced none of the renewal fields, so the model could not
 *     tell "my ally is waiting on me" from "renewal is unavailable".
 *
 * Measured consequence on the live ladder (2026-08-17, 85 mirrored episodes):
 * 3 of 35 extend pairs were mutual (8.6%) against the 2/42 = 4.8% pre-fix
 * baseline — Fisher exact p = 0.654, i.e. unmoved, with attempt frequency flat
 * at 4.2% vs 4.1% of alliances. A server-side fix nothing reads cannot move a
 * client-side number.
 */

const DETERMINISTIC_STARTERS = [
  // First: the copy the hosted image runs.
  path.join("coworld-adapter", "src", "starter-player.mjs"),
  path.join("coworld-adapter", "tester-starter", "starter-player.mjs"),
  path.join("coworld-adapter", "tester-starter-llm", "starter-player.mjs"),
];
const LLM_STARTER = path.join(
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);
const ALL_STARTERS = [...DETERMINISTIC_STARTERS, LLM_STARTER];

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

/** Present in some copies only (e.g. the promise-keeping filter). */
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

interface RenewalPicker {
  (actions: unknown[], obs: unknown): { id: string; kind: string } | null;
}

async function pendingRenewalFor(relativePath: string): Promise<RenewalPicker> {
  const source = await read(relativePath);
  return new Function(
    `${extractFunction(source, "pendingRenewalAction")}\nreturn pendingRenewalAction;`,
  )() as RenewalPicker;
}

const EXTEND_ACTION = {
  id: "alliance_extend:P_ALLY",
  kind: "alliance_extend",
  risk: { level: "none" },
  metadata: { targetID: "P_ALLY", targetName: "Ally" },
};
const ATTACK_ACTION = {
  id: "attack:P_FOE",
  kind: "attack",
  risk: { level: "low" },
  metadata: { targetID: "P_FOE" },
};

function observation(options: { otherAsked: boolean; inWindow?: boolean }) {
  return {
    phase: "active",
    turnNumber: 4_000,
    ownState: { playerID: "P_ME" },
    visiblePlayers: [
      {
        playerID: "P_ALLY",
        name: "Ally",
        isAlive: true,
        hasSpawned: true,
        isAllied: true,
        allianceInExtensionWindow: options.inWindow ?? true,
        allianceSelfAgreedToExtend: false,
        allianceOtherAgreedToExtend: options.otherAsked,
      },
      {
        playerID: "P_FOE",
        name: "Foe",
        isAlive: true,
        hasSpawned: true,
        isAllied: false,
      },
    ],
  };
}

describe.each(ALL_STARTERS)("alliance renewal: %s", (starter) => {
  it("answers an ally that already asked to renew", async () => {
    const pendingRenewal = await pendingRenewalFor(starter);
    const picked = pendingRenewal(
      [ATTACK_ACTION, EXTEND_ACTION],
      observation({ otherAsked: true }),
    );
    expect(picked).not.toBeNull();
    expect(picked!.kind).toBe("alliance_extend");
    expect(picked!.id).toBe("alliance_extend:P_ALLY");
  });

  it("does not fire when nobody is waiting on us", async () => {
    const pendingRenewal = await pendingRenewalFor(starter);
    expect(
      pendingRenewal(
        [ATTACK_ACTION, EXTEND_ACTION],
        observation({ otherAsked: false }),
      ),
    ).toBeNull();
  });

  it("never invents a renewal when the action is not offered", async () => {
    const pendingRenewal = await pendingRenewalFor(starter);
    expect(
      pendingRenewal([ATTACK_ACTION], observation({ otherAsked: true })),
    ).toBeNull();
  });

  it("tolerates a missing or malformed observation", async () => {
    const pendingRenewal = await pendingRenewalFor(starter);
    expect(pendingRenewal([EXTEND_ACTION], undefined)).toBeNull();
    expect(pendingRenewal([EXTEND_ACTION], {})).toBeNull();
    expect(pendingRenewal(undefined as unknown as unknown[], {})).toBeNull();
  });
});

describe("renewal is reachable at all", () => {
  it.each(DETERMINISTIC_STARTERS)(
    "%s ranks alliance_extend, and ahead of courting a new ally",
    async (starter) => {
      const source = await read(starter);
      const list = source.slice(
        source.indexOf("const preferredKinds = ["),
        source.indexOf("];", source.indexOf("const preferredKinds = [")),
      );
      // Absent from this list, a deterministic seat can never renew: every
      // earlier kind matches first and the tail fallback prefers hold.
      expect(list).toContain('"alliance_extend"');
      expect(list.indexOf('"alliance_extend"')).toBeLessThan(
        list.indexOf('"alliance_request"'),
      );
    },
  );

  it("tells the model alliance_extend exists and shows it who is waiting", async () => {
    const source = await read(LLM_STARTER);
    const planKinds = source.slice(
      source.indexOf("const PLAN_KINDS = ["),
      source.indexOf("];", source.indexOf("const PLAN_KINDS = [")),
    );
    expect(planKinds).toContain('"alliance_extend"');
    // The state must carry the mutual-renewal signal, not just the expiry.
    expect(source).toContain("otherAskedToRenew");
    expect(source).toContain("allianceOtherAgreedToExtend");
  });

  it("every starter reads the field 0.1.48 added", async () => {
    for (const starter of ALL_STARTERS) {
      const source = await read(starter);
      expect(
        source.includes("allianceOtherAgreedToExtend"),
        `${starter} ignores allianceOtherAgreedToExtend`,
      ).toBe(true);
    }
  });
});

/**
 * The helper tests above prove the SIGNAL is read correctly; these prove the
 * entry point actually consults it. Mutation testing caught that gap: disabling
 * the pre-empt inside `chooseAction` left every helper-level assertion green.
 */
describe("the entry point actually reciprocates", () => {
  it.each(DETERMINISTIC_STARTERS)(
    "%s renews instead of attacking when its ally is waiting",
    async (starter) => {
      const source = await read(starter);
      const dealKinds = source.match(
        /const DEAL_ACTION_KINDS = \[[\s\S]*?\];/,
      )?.[0];
      expect(dealKinds, "DEAL_ACTION_KINDS missing").toBeDefined();
      const chooseAction = new Function(
        [
          dealKinds!,
          extractFunction(source, "isDealActionKind"),
          optionalFunction(source, "activePromiseConstraints"),
          optionalFunction(source, "wouldBreakPromise"),
          extractFunction(source, "preferReciprocalAlliance"),
          extractFunction(source, "pendingRenewalAction"),
          extractFunction(source, "chooseAction"),
          "return chooseAction;",
        ].join("\n"),
      )() as (actions: unknown[], obs: unknown) => { id: string; kind: string };

      // Attack normally wins: it sits above every alliance kind in
      // preferredKinds. A waiting ally must outrank it.
      const renewed = chooseAction(
        [ATTACK_ACTION, EXTEND_ACTION],
        observation({ otherAsked: true }),
      );
      expect(renewed.kind).toBe("alliance_extend");

      // With nobody waiting, the ordinary preference order stands — this fix
      // must not turn every seat into a renewal bot.
      const attacked = chooseAction(
        [ATTACK_ACTION, EXTEND_ACTION],
        observation({ otherAsked: false }),
      );
      expect(attacked.kind).toBe("attack");
    },
  );

  it("the LLM starter's choose() reciprocates before consulting the plan", async () => {
    const source = await read(LLM_STARTER);
    const constOf = (name: string) =>
      source.match(new RegExp(`const ${name} =[\\s\\S]*?;(?=\\n)`))?.[0] ?? "";
    const choose = new Function(
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
        "const history = [];",
        "function avoidActionIDs() { return []; }",
        // A plan that explicitly wants to attack: reciprocity must still win,
        // because the renewal window is one-shot and the plan is stale by up to
        // PLAN_EVERY decisions.
        'let plan = { focus: "attack", preferKinds: ["attack"], target: "Foe", reason: "pressure" };',
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
        extractFunction(source, "choose"),
        "return choose;",
      ].join("\n"),
    )() as (actions: unknown[], obs: unknown) => { id: string; kind: string };

    const renewed = choose(
      [ATTACK_ACTION, EXTEND_ACTION],
      observation({ otherAsked: true }),
    );
    expect(renewed.kind).toBe("alliance_extend");

    const attacked = choose(
      [ATTACK_ACTION, EXTEND_ACTION],
      observation({ otherAsked: false }),
    );
    expect(attacked.kind).toBe("attack");
  });
});

/**
 * Acceptance is a RETURNING alliance request — there is no `alliance_accept`
 * kind — so an alliance forms only when both sides ask. Measured locally before
 * this: 6 deterministic seats over 7,300 turns sent 19 alliance requests and
 * formed ZERO alliances, because nothing consulted `hasIncomingAllianceRequest`
 * (our own executor adds +20 for it).
 *
 * These pin AIM, not appetite: the starter must not ask for MORE alliances, it
 * must aim the ask it was already going to make at the rival who already asked.
 * Appetite changes would risk the social stalemate the 2026-08-07 territorial
 * backstop exists to catch.
 */
describe("alliance requests are aimed at whoever already asked", () => {
  const ASKED = {
    id: "alliance_request:P_ASKED",
    kind: "alliance_request",
    risk: { level: "low" },
    metadata: { targetID: "P_ASKED", targetName: "Asked" },
  };
  const STRANGER = {
    id: "alliance_request:P_STRANGER",
    kind: "alliance_request",
    risk: { level: "low" },
    metadata: { targetID: "P_STRANGER", targetName: "Stranger" },
  };
  const allianceObs = (incomingFrom: string | null) => ({
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
    ],
  });

  it.each(ALL_STARTERS)(
    "%s prefers the rival who already asked",
    async (starter) => {
      const source = await read(starter);
      const prefer = new Function(
        `${extractFunction(source, "preferReciprocalAlliance")}\nreturn preferReciprocalAlliance;`,
      )() as (
        actions: unknown[],
        obs: unknown,
        kind: string,
      ) => { id: string } | null;

      // Stranger is offered FIRST, so first-match order would pick it.
      expect(
        prefer([STRANGER, ASKED], allianceObs("P_ASKED"), "alliance_request")
          ?.id,
      ).toBe("alliance_request:P_ASKED");
      // Nobody asked: no override, the caller's own ordering stands.
      expect(
        prefer([STRANGER, ASKED], allianceObs(null), "alliance_request"),
      ).toBeNull();
      // Never fires for another kind, so appetite for other actions is untouched.
      expect(
        prefer([STRANGER, ASKED], allianceObs("P_ASKED"), "attack"),
      ).toBeNull();
    },
  );

  it.each(DETERMINISTIC_STARTERS)(
    "%s still asks nobody extra: appetite is unchanged",
    async (starter) => {
      const source = await read(starter);
      const dealKinds = source.match(
        /const DEAL_ACTION_KINDS = \[[\s\S]*?\];/,
      )?.[0];
      const chooseAction = new Function(
        [
          dealKinds!,
          extractFunction(source, "isDealActionKind"),
          optionalFunction(source, "activePromiseConstraints"),
          optionalFunction(source, "wouldBreakPromise"),
          extractFunction(source, "preferReciprocalAlliance"),
          extractFunction(source, "pendingRenewalAction"),
          extractFunction(source, "chooseAction"),
          "return chooseAction;",
        ].join("\n"),
      )() as (actions: unknown[], obs: unknown) => { id: string; kind: string };

      // Attack outranks alliance_request in preferredKinds, and a pending
      // request must NOT change that — otherwise this becomes an appetite change.
      const withAttack = chooseAction(
        [ATTACK_ACTION, STRANGER, ASKED],
        allianceObs("P_ASKED"),
      );
      expect(withAttack.kind).toBe("attack");

      // With no attack available the seat asks anyway — and now aims correctly.
      const asked = chooseAction([STRANGER, ASKED], allianceObs("P_ASKED"));
      expect(asked.id).toBe("alliance_request:P_ASKED");
    },
  );
});
