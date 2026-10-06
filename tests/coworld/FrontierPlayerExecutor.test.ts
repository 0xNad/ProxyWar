/**
 * The Frontier player (v2) executor: how a plan becomes this step's moves.
 * Each test serves one fixed plan through the sidecar stand-in and checks the
 * exact offered ids the seat sends back: the plan's target, build order,
 * betrayal and nuke are honoured; the model's say lines go out one per step
 * through the offered `message:<id>` action; diplomacy never takes the map
 * move (the Season 1 "unknown action id" holds); and filler is never sent.
 */
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureStdout,
  decide,
  defaultPlan,
  ffaActions,
  ffaObservation,
  gameOf,
  IDS,
  type Json,
  loadPlayer,
  nukeAction,
  signalListenerGuard,
  startStubSidecar,
} from "./FrontierPlayerHarness";

const FILLER = ["quick_chat", "emoji", "target_player", "message"];
const DIPLOMACY = [
  "alliance_request",
  "alliance_extend",
  "break_alliance",
  "donate_troops",
  "donate_gold",
  "embargo",
  "quick_chat",
  "emoji",
];

function kindOf(id: unknown, actions: Json[]): string {
  return String(actions.find((action) => action.id === id)?.kind);
}

describe("Frontier player: executor", () => {
  const sidecars: Server[] = [];
  let stdout: ReturnType<typeof captureStdout>;
  let releaseSignals: () => void;
  afterEach(async () => {
    for (const server of sidecars.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
    stdout?.restore();
    releaseSignals?.();
  });

  /** A seat whose every checkpoint returns `plan`. */
  async function seatWithPlan(
    plan: Json | ((call: number) => Json | string),
    env: Record<string, string> = {},
  ) {
    stdout = captureStdout();
    releaseSignals = signalListenerGuard();
    const sidecar = await startStubSidecar({
      plan: (call) =>
        typeof plan === "function"
          ? plan(call)
          : ({ ...defaultPlan, ...plan } as Json),
    });
    sidecars.push(sidecar.server);
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: sidecar.url,
      COWORLD_LLM_MODEL: "anthropic/claude-fable-5.1",
      ...env,
    });
    return { socket, sidecar };
  }

  it("honours the plan's target: attacks it, sized by the troop ratio, by its bare label too", async () => {
    const { socket } = await seatWithPlan({ focus: "attack", target: "Grok" });
    const response = await decide(socket, ffaObservation(), ffaActions());
    // Grok 1 has half our troops (ratio 2.1): the 40% attack.
    expect(response.selectedLegalActionId).toBe(`attack:${IDS.grok}:40`);
    expect(String(response.reason)).toContain("PLAN#1(attack -> Grok)");
  });

  it("lands by boat on a target it cannot reach by land", async () => {
    const { socket } = await seatWithPlan({
      focus: "attack",
      target: "Opus 1",
    });
    const observation = ffaObservation();
    const players = observation.visiblePlayers as Json[];
    players[3] = { ...players[3], relativeTroopRatio: 1.5 };
    const response = await decide(socket, observation, ffaActions());
    expect(response.selectedLegalActionId).toBe("boat:482272:16");
  });

  it("builds by the plan's build order, never by menu order", async () => {
    const { socket } = await seatWithPlan({
      focus: "economy",
      target: null,
      build: ["MissileSilo", "City"],
    });
    const actions = ffaActions();
    // Grok is poor here, so no nuclear threat puts a SAM first.
    const observation = ffaObservation();
    (observation.visiblePlayers as Json[])[2].gold = "100000";
    const picks = [];
    for (let step = 0; step < 6; step++)
      picks.push(
        (await decide(socket, observation, actions)).selectedLegalActionId,
      );
    const builds = picks.filter((id) => String(id).startsWith("build:"));
    expect(builds.slice(0, 2)).toEqual([
      "build:Missile Silo:333",
      "build:City:222",
    ]);
    // The Defense Post listed first in the menu is never taken.
    expect(picks).not.toContain("build:Defense Post:111");
    // An economy focus spends about two moves in three on the economy.
    expect(builds.length).toBeGreaterThanOrEqual(3);
  });

  it("escalates: a silo first when a nuke is planned, then the nuke on the named rival", async () => {
    const { socket } = await seatWithPlan({
      focus: "expand",
      target: null,
      nuke: "Grok 1",
      build: ["City"],
    });
    const noSilo = await decide(socket, ffaObservation(), ffaActions());
    expect(noSilo.selectedLegalActionId).toBe("build:Missile Silo:333");
    const armed = ffaObservation();
    (armed.ownState as Json).unitCounts = { City: 2, "Missile Silo": 1 };
    const launch = await decide(socket, armed, [
      ...ffaActions(),
      nukeAction(IDS.fable, "Fable 1"),
      nukeAction(IDS.grok, "Grok 1"),
    ]);
    expect(launch.selectedLegalActionId).toBe("build:Atom Bomb:555");
  });

  it("breaks the alliance the plan betrays, as a rider behind the map move", async () => {
    const { socket } = await seatWithPlan({
      focus: "attack",
      target: "Gemini 1",
      betray: "Gemini 1",
    });
    const actions = ffaActions();
    const response = await decide(socket, ffaObservation(), actions);
    const batch = response.selectedLegalActionIds as string[];
    expect(batch).toEqual([
      response.selectedLegalActionId,
      `break_alliance:${IDS.gemini}`,
    ]);
    expect(DIPLOMACY).not.toContain(
      kindOf(response.selectedLegalActionId, actions),
    );
    // Gemini 1 is still an ally this step: no attack on it is offered, so
    // the map move is something else and never a donation to it.
    expect(String(response.selectedLegalActionId)).not.toContain(IDS.gemini);
  });

  it("on an image without action batches, the betrayal takes the step's move", async () => {
    const { socket } = await seatWithPlan({ betray: "Gemini 1" });
    const response = await decide(socket, ffaObservation(), ffaActions(), {
      maxActionsPerDecision: 1,
      maxSpawnPreferences: 16,
    });
    expect(response.selectedLegalActionId).toBe(`break_alliance:${IDS.gemini}`);
    expect(response.selectedLegalActionIds).toBeUndefined();
  });

  /**
   * Season 1, game ereq_0033fafb, turn 1100: Gemini 1 asked Grok 3 for an
   * alliance first in roster order, so the server reserved both and struck
   * `alliance:x262ww19` from every later seat's menu after the menus were
   * sent; Astra 1, Astra 2, Astra 3, Gemini 2 and Gemini 3 had picked it and
   * were answered "decision selected unknown action id: alliance:x262ww19;
   * fallback=hold". Nine of twelve seats held that step. The v2 player never
   * puts a diplomacy id in the primary slot, so a struck id can only lose
   * itself, never the step's map move.
   */
  it("never puts diplomacy in the primary slot (the Season 1 unknown-action-id holds)", async () => {
    const { socket } = await seatWithPlan({
      focus: "expand",
      target: null,
      allies: ["Fable 1"],
    });
    const actions = ffaActions();
    const response = await decide(socket, ffaObservation(), actions);
    expect(response.selectedLegalActionId).toMatch(/^expand:terra-nullius:/);
    expect(response.selectedLegalActionIds).toEqual([
      response.selectedLegalActionId,
      `alliance:${IDS.fable}`,
    ]);
  });

  it("asks a planned ally at most once per ten steps, for as long as the plans name it", async () => {
    const { socket } = await seatWithPlan({
      focus: "expand",
      target: null,
      allies: ["Fable 1"],
    });
    const observation = ffaObservation();
    // Fable has not asked us this time.
    (observation.visiblePlayers as Json[])[0].hasIncomingAllianceRequest =
      false;
    const asks = [];
    for (let step = 1; step <= 45; step++) {
      const response = await decide(socket, observation, ffaActions());
      const rider = (response.selectedLegalActionIds as string[])?.[1];
      if (rider === `alliance:${IDS.fable}`) asks.push(step);
    }
    // No lifetime cap: the fifth ask still goes out.
    expect(asks).toEqual([1, 11, 21, 31, 41]);
  });

  it("asks again at once when the server struck the ask in a same-step conflict", async () => {
    const { socket } = await seatWithPlan({
      focus: "expand",
      target: null,
      allies: ["Fable 1"],
    });
    const observation = ffaObservation();
    (observation.visiblePlayers as Json[])[0].hasIncomingAllianceRequest =
      false;
    const first = await decide(socket, observation, ffaActions());
    expect((first.selectedLegalActionIds as string[])[1]).toBe(
      `alliance:${IDS.fable}`,
    );
    const struck = ffaObservation({
      recentDecisions: [
        {
          sequence: 7,
          actionID: `alliance:${IDS.fable}`,
          actionKind: "alliance_request",
          reason: null,
          accepted: false,
        },
      ],
    });
    (struck.visiblePlayers as Json[])[0].hasIncomingAllianceRequest = false;
    const second = await decide(socket, struck, ffaActions());
    expect((second.selectedLegalActionIds as string[])[1]).toBe(
      `alliance:${IDS.fable}`,
    );
  });

  it("lets an alliance lapse when the plan targets or nukes that ally, and renews it otherwise", async () => {
    const renewing = () => {
      const observation = ffaObservation();
      Object.assign((observation.visiblePlayers as Json[])[1], {
        allianceInExtensionWindow: true,
        allianceOtherAgreedToExtend: true,
        allianceSelfAgreedToExtend: false,
      });
      return observation;
    };
    const menu = [
      ...ffaActions(),
      {
        id: `alliance_extend:${IDS.gemini}`,
        kind: "alliance_extend",
        label: "extend alliance with Gemini 1",
        risk: { level: "low" },
        metadata: { targetID: IDS.gemini, targetName: "Gemini 1" },
      },
    ];
    const ridersFor = async (plan: Json) => {
      const { socket } = await seatWithPlan(plan);
      const response = await decide(socket, renewing(), menu);
      stdout.restore();
      releaseSignals();
      return [
        response.selectedLegalActionId,
        ...((response.selectedLegalActionIds as string[]) ?? []),
      ];
    };
    // Gemini asked to renew, but the plan names it as target or nuke: no
    // renewal, and no troops for the ally it means to hit.
    for (const plan of [
      { focus: "attack", target: "Gemini 1", allies: [] },
      { focus: "expand", target: null, nuke: "Gemini 1", allies: [] },
    ]) {
      const ids = await ridersFor(plan);
      expect(ids).not.toContain(`alliance_extend:${IDS.gemini}`);
      expect(ids).not.toContain(`donate_troops:${IDS.gemini}`);
    }
    // A plan with other aims answers the renewal on its own.
    const kept = await ridersFor({ focus: "expand", target: null });
    expect(kept).toContain(`alliance_extend:${IDS.gemini}`);
  });

  it("never reads a numbered name nobody holds as a living rival with the same label", async () => {
    const { socket } = await seatWithPlan({
      focus: "attack",
      target: "Grok 3",
      say: [{ to: "Grok 3", text: "Grok, stand down." }],
    });
    const response = await decide(socket, ffaObservation(), ffaActions());
    // Grok 3 is gone: no attack on Grok 1, no message to Grok 1.
    expect(String(response.selectedLegalActionId)).not.toContain(IDS.grok);
    expect(response.selectedMessageActionId).toBeUndefined();
    expect(stdout.tagged("PROXYWAR_SAY")).toMatchObject([
      {
        to: "Grok 3",
        toID: null,
        accepted: false,
        reason: "unknown_recipient",
      },
    ]);
    expect(stdout.tagged("PROXYWAR_PLAN")[0].target).toBeNull();
  });

  it("prints the plan's names as the seat will act on them", async () => {
    await seatWithPlan({
      focus: "attack",
      target: "Grok",
      nuke: "grok 1",
      betray: "Nobody",
      allies: ["Fable", "Nobody", "Grok 3", "Grok 1"],
      say: [{ to: "Opus", text: "Hello, Opus." }],
    }).then(({ socket }) => decide(socket, ffaObservation(), ffaActions()));
    expect(stdout.tagged("PROXYWAR_PLAN")[0]).toMatchObject({
      target: "Grok 1",
      nuke: "Grok 1",
      betray: null,
      // Grok 1 is the target, so it is not sought as an ally.
      allies: ["Fable 1"],
      say: [{ to: "Opus 1", chars: 12 }],
    });
  });

  it("reports an unreadable plan as a parse failure and keeps the previous plan", async () => {
    const { socket } = await seatWithPlan(
      (call) => (call === 1 ? defaultPlan : "Here is my plan: attack Grok."),
      { PLAN_EVERY: "2" },
    );
    await decide(socket, ffaObservation(), ffaActions());
    const late = await decide(socket, ffaObservation(), ffaActions());
    expect(late.selectedLegalActionId).toBe(`attack:${IDS.grok}:40`);
    expect(late.degradedCause).toBe("plan-parse");
    expect(late.llmPlannerDegraded).toBe(true);
  });

  it("sends no filler and donates only to allies", async () => {
    const { socket } = await seatWithPlan({ focus: "defend", target: null });
    const observation = ffaObservation();
    // Only filler, a donation to a rival, a donation to our besieged ally,
    // and hold are on offer.
    const menu = ffaActions().filter((action) =>
      ["quick_chat", "emoji", "donate_troops", "message", "hold"].includes(
        String(action.kind),
      ),
    );
    const response = await decide(socket, observation, menu);
    expect(response.selectedLegalActionId).toBe("hold");
    expect(response.selectedLegalActionIds).toEqual([
      "hold",
      `donate_troops:${IDS.gemini}`,
    ]);
    for (let step = 0; step < 6; step++) {
      const next = await decide(socket, observation, menu);
      const ids = [
        next.selectedLegalActionId,
        ...((next.selectedLegalActionIds as string[]) ?? []),
      ];
      expect(ids).not.toContain(`donate_troops:${IDS.grok}`);
      for (const id of ids) expect(FILLER).not.toContain(kindOf(id, menu));
    }
  });

  it("sends the model's say lines one per step through the offered message ids, dropping bad lines", async () => {
    const { socket, sidecar } = await seatWithPlan({
      say: [
        { to: "Fable 1", text: "Fable, keep your armies off my border." },
        { to: "Nobody", text: "Is anyone there?" },
        { to: "Grok", text: "Grok, the leader is too big. Hit them with me." },
      ],
    });
    const first = await decide(socket, ffaObservation(), ffaActions());
    expect(first.selectedMessageActionId).toBe(`message:${IDS.fable}`);
    expect(first.messageText).toBe("Fable, keep your armies off my border.");
    const second = await decide(socket, ffaObservation(), ffaActions());
    expect(second.selectedMessageActionId).toBe(`message:${IDS.grok}`);
    expect(second.messageText).toBe(
      "Grok, the leader is too big. Hit them with me.",
    );
    const third = await decide(socket, ffaObservation(), ffaActions());
    expect(third.selectedMessageActionId).toBeUndefined();
    expect(third.messageText).toBeUndefined();
    const says = stdout.tagged("PROXYWAR_SAY");
    expect(
      says.map((say) => [say.to, say.toID, say.accepted, say.reason ?? null]),
    ).toEqual([
      ["Fable 1", IDS.fable, true, null],
      ["Nobody", null, false, "unknown_recipient"],
      ["Grok 1", IDS.grok, true, null],
    ]);
    // What the seat said reaches its next plan, next to what it heard.
    const observation = ffaObservation({
      nonCombat: {
        inboundMessages: [
          {
            senderID: IDS.fable,
            senderName: "Fable 1",
            turnNumber: 1200,
            text: "Agreed. Stay west of the river.",
          },
        ],
      },
    });
    for (let step = 4; step <= 15; step++)
      await decide(socket, observation, ffaActions());
    expect(sidecar.calls).toHaveLength(2);
    const game = gameOf(sidecar.calls[1]);
    expect(game.messages).toEqual([
      {
        from: "Fable 1",
        fromID: IDS.fable,
        turn: 1200,
        text: "Agreed. Stay west of the river.",
      },
    ]);
    expect(game.youSaid).toHaveLength(2);
  });

  it("drops say lines that are too long or carry links, and never shortens them", async () => {
    const { socket } = await seatWithPlan({
      say: [
        { to: "Fable 1", text: "x".repeat(241) },
        { to: "Grok 1", text: "Read this: https://example.com" },
        { to: "Opus 1", text: "Line one\nline two" },
      ],
    });
    const first = await decide(socket, ffaObservation(), ffaActions());
    // Only the newline line survives, with its whitespace collapsed.
    expect(first.selectedMessageActionId).toBe(`message:${IDS.opus}`);
    expect(first.messageText).toBe("Line one line two");
    const says = stdout.tagged("PROXYWAR_SAY");
    expect(says.filter((say) => say.accepted === false)).toHaveLength(2);
    expect(
      says.filter((say) => say.accepted === false).map((say) => say.text),
    ).toEqual(["", ""]);
    const plan = stdout.tagged("PROXYWAR_PLAN")[0];
    expect(plan.say).toEqual([{ to: "Opus 1", chars: 17 }]);
  });

  it("drops say lines and dispatches with an @handle anywhere or a bare domain", async () => {
    const { socket } = await seatWithPlan({
      say: [
        { to: "Fable 1", text: "Talk to me,@grok_fan first." },
        { to: "Grok 1", text: "Terms are at example.com/deal for you." },
        // A full-width at sign is an @ once the publisher normalizes it.
        { to: "Opus 1", text: "Ask my envoy \uFF20opus_hq today." },
      ],
      dispatch: "Astra rises (@astra_official) today",
    });
    const response = await decide(socket, ffaObservation(), ffaActions());
    expect(response.selectedMessageActionId).toBeUndefined();
    expect(
      stdout.tagged("PROXYWAR_SAY").map((say) => [say.accepted, say.reason]),
    ).toEqual([
      [false, "invalid_text"],
      [false, "invalid_text"],
      [false, "invalid_text"],
    ]);
    expect(stdout.tagged("PROXYWAR_DISPATCH")).toEqual([]);
    stdout.restore();
    releaseSignals();
    // Ordinary punctuation is not a link.
    const plain =
      "Wait... to be clear, Grok: 50/50 on the north, e.g. the coast.";
    const next = await seatWithPlan({
      say: [{ to: "Grok 1", text: plain }],
      dispatch: "Astra holds. Fable, you are next...",
    });
    const sent = await decide(next.socket, ffaObservation(), ffaActions());
    expect(sent.messageText).toBe(plain);
    expect(stdout.tagged("PROXYWAR_DISPATCH")).toHaveLength(1);
  });

  it("shows the next plan every sender's newest lines, so a chatty rival cannot crowd out a quiet one", async () => {
    const { socket, sidecar } = await seatWithPlan({});
    const from = (senderID: string, senderName: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        senderID,
        senderName,
        turnNumber: 1000 + i,
        text: `${senderName} line ${i + 1}`,
      }));
    const inboundMessages = [
      ...from(IDS.fable, "Fable 1", 1),
      ...from(IDS.grok, "Grok 1", 5),
      ...from(IDS.opus, "Opus 1", 4),
      ...from(IDS.gemini, "Gemini 1", 3),
      ...from("e5xtra00", "Extra 1", 3),
    ];
    await decide(
      socket,
      ffaObservation({ nonCombat: { inboundMessages } }),
      ffaActions(),
    );
    const messages = gameOf(sidecar.calls[0]).messages as Json[];
    const texts = messages.map((m) => m.text);
    // The quiet rival's only offer survives.
    expect(texts).toContain("Fable 1 line 1");
    // Each sender keeps at most its three newest lines, twelve in all.
    expect(messages).toHaveLength(12);
    expect(texts).not.toContain("Grok 1 line 1");
    expect(texts).not.toContain("Grok 1 line 2");
    expect(texts).toContain("Grok 1 line 5");
    for (const id of [IDS.grok, IDS.opus, IDS.gemini, "e5xtra00"])
      expect(
        messages.filter((m) => m.fromID === id).length,
      ).toBeLessThanOrEqual(3);
  });

  it("prints the plan and the model's public dispatch line", async () => {
    await seatWithPlan({
      focus: "attack",
      target: "Grok 1",
      nuke: "Grok 1",
      allies: ["Fable 1"],
      build: ["City", "SAMLauncher", "Missile Silo"],
      dispatch: "Astra turns east. Grok has been warned.",
    }).then(({ socket }) => decide(socket, ffaObservation(), ffaActions()));
    expect(stdout.tagged("PROXYWAR_DISPATCH")).toEqual([
      {
        checkpoint: 1,
        decisionStep: 1,
        text: "Astra turns east. Grok has been warned.",
      },
    ]);
    expect(stdout.tagged("PROXYWAR_PLAN")).toEqual([
      {
        checkpoint: 1,
        decisionStep: 1,
        model: "anthropic/claude-fable-5.1",
        focus: "attack",
        target: "Grok 1",
        build: ["City", "SAM Launcher", "Missile Silo"],
        nuke: "Grok 1",
        betray: null,
        allies: ["Fable 1"],
        say: [],
        status: "applied",
      },
    ]);
  });

  it("prints no dispatch when the line breaks the rules", async () => {
    const { socket } = await seatWithPlan({
      dispatch: "Follow @astra for more at www.example.com",
    });
    await decide(socket, ffaObservation(), ffaActions());
    expect(stdout.tagged("PROXYWAR_DISPATCH")).toEqual([]);
  });

  it("keeps an accepted pact: no attack on a pact partner unless the plan breaks the deal", async () => {
    const pact = {
      dealID: "deal_1",
      template: "non_aggression_pact",
      proposerPlayerID: IDS.grok,
      proposerName: "Grok 1",
      recipientPlayerID: IDS.me,
      recipientName: "Astra 1",
      stepsRemaining: 20,
      obligations: [{ obligorPlayerID: IDS.me, status: "pending" }],
    };
    const observation = ffaObservation({
      deals: {
        decisionStep: 3,
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [pact],
        rivalReliability: [],
        proposalOptions: [],
      },
    });
    const kept = await seatWithPlan({ focus: "attack", target: "Grok 1" });
    const first = await decide(kept.socket, observation, ffaActions());
    expect(String(first.selectedLegalActionId)).not.toContain(IDS.grok);
    stdout.restore();
    releaseSignals();
    const broken = await seatWithPlan({
      focus: "attack",
      target: "Grok 1",
      breakDealIDs: ["deal_1"],
    });
    const second = await decide(broken.socket, observation, ffaActions());
    expect(second.selectedLegalActionId).toBe(`attack:${IDS.grok}:40`);
    expect(String(second.reason)).toContain("intentional breach deal_1");
  });
});
