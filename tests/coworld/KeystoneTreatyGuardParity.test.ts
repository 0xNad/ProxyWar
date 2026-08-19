import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withoutKeystoneTreatyBreaches } from "../../coworld-adapter/src/keystone-player";
import type {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

/**
 * The compliance guard in `keystone-player.ts` must withhold exactly the
 * actions the referee in `AgentDealCompliance.ts` would judge as pact
 * breaches — no fewer (a breach ships and publishes a `betrayal` VERDICT into
 * the public reliability aggregate) and no more (the Commander loses moves it
 * is entitled to).
 *
 * That contract lived only in a source comment: "If a new violation shape is
 * ever added to the referee, it must be added here." A comment cannot fail a
 * build. These tests make the two sides fail together instead.
 *
 * Independently re-derived from the referee 2026-08-19: `attack` breaches
 * unless `expansion === true`; `nuke` breaches unconditionally on target;
 * `boat` breaches only when `navalInvasion === true && expansion === false`
 * (note the STRICT `false` — a boat with absent `expansion` is not a breach,
 * which is why the guard's attack and boat clauses are deliberately
 * asymmetric); `embargo`/`embargo_all` breach only on `action === "start"` and
 * ONLY under a `trade_security` obligation, because
 * `validatedManualEmbargoAgainst` is reached solely from the referee's
 * `trade_security` branch. Hostile actions are judged under BOTH pact kinds,
 * since `validatedHostileActionAgainst` is checked unconditionally in
 * `hasNegativeCovenantCoverage`.
 */

const REFEREE_SOURCE = path.join(
  __dirname,
  "../../src/server/agents/AgentDealCompliance.ts",
);
const GUARD_SOURCE = path.join(
  __dirname,
  "../../coworld-adapter/src/keystone-player.ts",
);

function action(
  kind: string,
  id: string,
  metadata: Record<string, unknown> = {},
): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: null,
    risk: { level: "medium", score: 0.5 },
    metadata,
  } as unknown as LegalAction;
}

/** One pending obligation of `kind`, owed by us to `partner`. */
function pactWith(partner: string, kind: string): AgentObservation {
  return {
    ownState: { playerID: "me" },
    visiblePlayers: [],
    deals: {
      incomingProposals: [],
      outgoingProposals: [],
      activeDeals: [
        {
          dealID: "d1",
          proposerPlayerID: "me",
          recipientPlayerID: partner,
          obligations: [
            { obligorPlayerID: "me", kind, status: "pending" },
          ],
        },
      ],
      proposalOptions: [],
    },
  } as unknown as AgentObservation;
}

const HOLD = action("hold", "hold");
const kept = (actions: LegalAction[], observation: AgentObservation) =>
  withoutKeystoneTreatyBreaches(actions, observation).map((a) => a.id);

describe("keystone treaty guard mirrors the referee", () => {
  // Each case is a shape the referee either does or does not call a breach.
  // `withheld` is the referee's verdict, re-derived from its source above.
  const CASES: Array<{
    name: string;
    pact: string;
    action: LegalAction;
    withheld: boolean;
  }> = [
    // attack: breach unless explicitly an expansion attack.
    {
      name: "targeted non-expansion attack",
      pact: "non_aggression",
      action: action("attack", "atk", { targetID: "p", expansion: false }),
      withheld: true,
    },
    {
      name: "targeted attack with absent expansion flag",
      pact: "non_aggression",
      action: action("attack", "atk", { targetID: "p" }),
      withheld: true,
    },
    {
      name: "expansion attack (referee carve-out)",
      pact: "non_aggression",
      action: action("attack", "atk", { targetID: "p", expansion: true }),
      withheld: false,
    },
    // nuke: breach on target alone, no expansion carve-out exists.
    {
      name: "nuke on partner",
      pact: "non_aggression",
      action: action("nuke", "nuke", { targetID: "p" }),
      withheld: true,
    },
    {
      name: "nuke on a third party",
      pact: "non_aggression",
      action: action("nuke", "nuke", { targetID: "other" }),
      withheld: false,
    },
    // boat: breach ONLY on navalInvasion === true && expansion === false.
    {
      name: "naval invasion launch",
      pact: "non_aggression",
      action: action("boat", "boat", {
        targetID: "p",
        navalInvasion: true,
        expansion: false,
      }),
      withheld: true,
    },
    {
      name: "naval invasion with absent expansion flag (referee is strict)",
      pact: "non_aggression",
      action: action("boat", "boat", { targetID: "p", navalInvasion: true }),
      withheld: false,
    },
    {
      name: "expansion boat",
      pact: "non_aggression",
      action: action("boat", "boat", {
        targetID: "p",
        navalInvasion: true,
        expansion: true,
      }),
      withheld: false,
    },
    // embargo: judged ONLY under trade_security.
    {
      name: "targeted embargo under trade_security",
      pact: "trade_security",
      action: action("embargo", "emb", { targetID: "p", action: "start" }),
      withheld: true,
    },
    {
      name: "targeted embargo under a plain non-aggression pact",
      pact: "non_aggression",
      action: action("embargo", "emb", { targetID: "p", action: "start" }),
      withheld: false,
    },
    {
      name: "lifting an embargo is never a breach",
      pact: "trade_security",
      action: action("embargo", "emb", { targetID: "p", action: "stop" }),
      withheld: false,
    },
    // embargo_all: target-independent under trade_security.
    {
      name: "embargo_all under trade_security",
      pact: "trade_security",
      action: action("embargo_all", "embAll", { action: "start" }),
      withheld: true,
    },
    {
      name: "embargo_all under a plain non-aggression pact",
      pact: "non_aggression",
      action: action("embargo_all", "embAll", { action: "start" }),
      withheld: false,
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.withheld ? "withholds" : "keeps"} ${testCase.name}`, () => {
      const observation = pactWith("p", testCase.pact);
      const ids = kept([testCase.action, HOLD], observation);
      expect(ids.includes(testCase.action.id)).toBe(!testCase.withheld);
    });
  }

  it("protects partners under both pact kinds, not just non-aggression", () => {
    // hasNegativeCovenantCoverage checks validatedHostileActionAgainst before
    // branching on obligation kind, so a trade_security pact bars attacks too.
    const attack = action("attack", "atk", { targetID: "p", expansion: false });
    expect(kept([attack, HOLD], pactWith("p", "trade_security"))).toEqual([
      "hold",
    ]);
  });

  it("leaves every action alone when no pact is held", () => {
    const noPact = {
      ownState: { playerID: "me" },
      visiblePlayers: [],
      deals: {
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [],
      },
    } as unknown as AgentObservation;
    const menu = CASES.map((c) => c.action).concat(HOLD);
    expect(kept(menu, noPact)).toHaveLength(menu.length);
  });

  it("ignores obligations owed BY the counterparty rather than by us", () => {
    const theirs = {
      ownState: { playerID: "me" },
      visiblePlayers: [],
      deals: {
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [
          {
            dealID: "d1",
            proposerPlayerID: "me",
            recipientPlayerID: "p",
            obligations: [
              // Obligor is THEM: our own hands stay free.
              { obligorPlayerID: "p", kind: "non_aggression", status: "pending" },
            ],
          },
        ],
        proposalOptions: [],
      },
    } as unknown as AgentObservation;
    const attack = action("attack", "atk", { targetID: "p", expansion: false });
    expect(kept([attack, HOLD], theirs)).toContain("atk");
  });

  it("ignores obligations that are no longer pending", () => {
    const settled = pactWith("p", "non_aggression") as unknown as {
      deals: { activeDeals: Array<{ obligations: Array<{ status: string }> }> };
    };
    settled.deals.activeDeals[0].obligations[0].status = "fulfilled";
    const attack = action("attack", "atk", { targetID: "p", expansion: false });
    expect(
      kept([attack, HOLD], settled as unknown as AgentObservation),
    ).toContain("atk");
  });

  /**
   * Structural canary. If someone teaches the referee a NEW breaching action
   * kind, this fails until the guard learns it too — which is the failure the
   * source comment could only ask for politely.
   */
  it("handles every action kind the referee judges", () => {
    const referee = readFileSync(REFEREE_SOURCE, "utf8");
    const judged = new Set<string>();
    for (const fnName of [
      "validatedHostileActionAgainst",
      "validatedManualEmbargoAgainst",
    ]) {
      const start = referee.indexOf(`function ${fnName}(`);
      expect(start, `${fnName} not found — did the referee rename it?`).toBeGreaterThan(-1);
      // Body ends at the next top-level `\n}` after the signature.
      const end = referee.indexOf("\n}", start);
      const body = referee.slice(start, end);
      for (const match of body.matchAll(
        /chosenActionKind\s*===\s*"([a-z_]+)"/g,
      )) {
        judged.add(match[1]);
      }
    }
    expect(judged.size).toBeGreaterThan(0);

    const guard = readFileSync(GUARD_SOURCE, "utf8");
    const guardStart = guard.indexOf("export function withoutKeystoneTreatyBreaches");
    expect(guardStart).toBeGreaterThan(-1);
    const guardBody = guard.slice(guardStart, guard.indexOf("\n}", guardStart));
    const handled = new Set(
      [...guardBody.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]),
    );

    const unhandled = [...judged].filter((kind) => !handled.has(kind));
    expect(
      unhandled,
      `the referee judges ${unhandled.join(", ")} but withoutKeystoneTreatyBreaches has no case for it — ` +
        `keystone would sign pacts it then breaks`,
    ).toEqual([]);
  });
});
