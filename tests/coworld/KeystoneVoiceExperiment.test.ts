import { afterEach, describe, expect, it } from "vitest";
import {
  chooseKeystoneMessageMove,
  keystoneStableFraction,
  keystoneVoiceAbShare,
  keystoneVoiceCohort,
} from "../../coworld-adapter/src/keystone-player";
import { stableFraction } from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

const ENV = "PROXYWAR_KEYSTONE_VOICE_AB";

function observation(
  rivals: string[],
  gameID = "game-1",
  inbound: Array<{ senderID: string; turnNumber: number }> = [],
): AgentObservation {
  return {
    gameID,
    ownState: { playerID: "me" },
    visiblePlayers: rivals.map((id) => ({
      playerID: id,
      sharesBorder: true,
      isAllied: false,
    })),
    nonCombat: { inboundMessages: inbound },
    deals: { incomingProposals: [], outgoingProposals: [], activeDeals: [] },
  } as unknown as AgentObservation;
}

const offer = (rivalID: string): LegalAction =>
  ({
    id: `message:${rivalID}`,
    kind: "message",
    label: "m",
    intent: null,
    risk: { level: "none", score: 0 },
    metadata: { recipientID: rivalID },
  }) as unknown as LegalAction;

afterEach(() => {
  delete process.env[ENV];
});

describe("keystone voice experiment", () => {
  // The duplicated hash is only safe if it is genuinely the same function —
  // keystone cannot value-import the planner's copy (it resolves to nothing in
  // the deployed container), so this pins the two implementations together.
  it("reproduces the planner's stableFraction exactly", () => {
    for (const seed of [
      "",
      "a",
      "voice-ab:game-1:me:rival-a",
      "spawn:settle:abc:def",
      "☃ unicode ☃",
    ]) {
      expect(keystoneStableFraction(seed)).toBe(stableFraction(seed));
    }
  });

  it("is off unless a share in (0,1) is configured", () => {
    expect(keystoneVoiceAbShare({})).toBeNull();
    expect(keystoneVoiceAbShare({ [ENV]: "0" })).toBeNull();
    expect(keystoneVoiceAbShare({ [ENV]: "1" })).toBeNull();
    expect(keystoneVoiceAbShare({ [ENV]: "nonsense" })).toBeNull();
    expect(keystoneVoiceAbShare({ [ENV]: "0.5" })).toBe(0.5);
  });

  it("assigns deterministically, so an analyzer can recompute the arms", () => {
    const first = keystoneVoiceCohort("g", "me", "rival-a", 0.5);
    for (let i = 0; i < 50; i += 1) {
      expect(keystoneVoiceCohort("g", "me", "rival-a", 0.5)).toBe(first);
    }
  });

  it("splits a realistic rival pool near the configured share", () => {
    const rivals = Array.from({ length: 400 }, (_, i) => `rival-${i}`);
    const talk = rivals.filter((r) =>
      keystoneVoiceCohort("game-1", "me", r, 0.5),
    ).length;
    // Binomial(400, 0.5): |talk-200| > 50 is astronomically unlikely for a
    // sane hash, and a constant function would land at 0 or 400.
    expect(Math.abs(talk - 200)).toBeLessThan(50);
  });

  it("reshuffles per episode, so no rival is permanently silenced", () => {
    const rivals = Array.from({ length: 60 }, (_, i) => `rival-${i}`);
    const armFor = (gameID: string) =>
      rivals.map((r) => keystoneVoiceCohort(gameID, "me", r, 0.5)).join("");
    expect(armFor("game-1")).not.toBe(armFor("game-2"));
  });

  it("keeps every rival when the experiment is off", () => {
    const actions = [offer("rival-a"), offer("rival-b")];
    const move = chooseKeystoneMessageMove(
      actions,
      observation(["rival-a", "rival-b"]),
      new Set(),
    );
    expect(move).not.toBeNull();
  });

  it("never messages a control rival, on the opener path or the reply path", () => {
    process.env[ENV] = "0.5";
    const rivals = Array.from({ length: 40 }, (_, i) => `rival-${i}`);
    const control = rivals.filter(
      (r) => !keystoneVoiceCohort("game-1", "me", r, 0.5),
    );
    expect(control.length).toBeGreaterThan(5); // fixture actually exercises it

    for (const rival of control) {
      // opener path: this rival borders us and has never been written to
      expect(
        chooseKeystoneMessageMove(
          [offer(rival)],
          observation([rival]),
          new Set(),
        ),
      ).toBeNull();
      // reply path: this rival just wrote to us — still silence
      expect(
        chooseKeystoneMessageMove(
          [offer(rival)],
          observation([rival], "game-1", [
            { senderID: rival, turnNumber: 100 },
          ]),
          new Set(),
        ),
      ).toBeNull();
    }
  });

  it("still messages the treatment rivals under the same configuration", () => {
    process.env[ENV] = "0.5";
    const rivals = Array.from({ length: 40 }, (_, i) => `rival-${i}`);
    const treated = rivals.filter((r) =>
      keystoneVoiceCohort("game-1", "me", r, 0.5),
    );
    expect(treated.length).toBeGreaterThan(5);
    const spoken = treated.filter(
      (rival) =>
        chooseKeystoneMessageMove(
          [offer(rival)],
          observation([rival]),
          new Set(),
        ) !== null,
    );
    expect(spoken.length).toBe(treated.length);
  });
});
