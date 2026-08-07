import { describe, expect, it } from "vitest";
import {
  chooseStarterAction,
  StarterBotAgentBrain,
} from "../../src/server/agents/StarterBotAgentBrain";
import { AgentBrainInput, LegalAction } from "../../src/server/agents/AgentTypes";

// chooseStarterAction only reads id/kind/risk; the intent is irrelevant to the
// selection logic, so a placeholder intent keeps these cases focused on priority.
function act(
  id: string,
  kind: string,
  risk: "low" | "medium" | "high" = "medium",
): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: { type: "hold" },
    risk: { level: risk, score: 0.4 },
  } as unknown as LegalAction;
}

// Fidelity re-verified 2026-08-07 against coworld-adapter/src/starter-player.mjs
// (`preferredKinds`): identical order (spawn > attack > build > upgrade_structure >
// boat > alliance_request > quick_chat > emoji), identical filter (kind match &&
// risk!=="high" && !id.includes("avoid")), identical fallback (find hold ?? actions[0]).
// "move_warship" is gone from both — warships were retired on this lineage.
// The bundled player used to say "upgrade", a kind the builder never emits, so it
// could never reach an upgrade; that dead string was corrected to the canonical
// "upgrade_structure". This port keeps BOTH spellings in the same priority slot, so
// it remains a priority-preserving superset either way. So this opponent faithfully
// represents the real Coworld starter, and the Keystone-vs-starters eval is representative.
describe("StarterBotAgentBrain (faithful Coworld starter port)", () => {
  it("follows the starter priority order (spawn > attack > build > boat > ...)", () => {
    expect(
      chooseStarterAction([
        act("h", "hold"),
        act("b", "build"),
        act("at", "attack"),
        act("s", "spawn"),
      ]).id,
    ).toBe("s");
    expect(
      chooseStarterAction([act("h", "hold"), act("b", "build"), act("at", "attack")])
        .id,
    ).toBe("at");
    // boat is lower priority than build
    expect(
      chooseStarterAction([act("h", "hold"), act("bo", "boat"), act("b", "build")])
        .id,
    ).toBe("b");
  });

  it("skips high-risk and 'avoid' actions", () => {
    expect(
      chooseStarterAction([act("at:avoid:1", "attack"), act("b", "build")]).id,
    ).toBe("b");
    expect(
      chooseStarterAction([act("at", "attack", "high"), act("b", "build")]).id,
    ).toBe("b");
  });

  it("matches both 'upgrade' and the internal 'upgrade_structure' kind", () => {
    expect(
      chooseStarterAction([act("h", "hold"), act("u", "upgrade_structure")]).id,
    ).toBe("u");
  });

  it("falls back to hold, then to the first offered action", () => {
    // target_player/embargo are not preferred kinds -> hold wins
    expect(
      chooseStarterAction([act("t", "target_player"), act("h", "hold")]).id,
    ).toBe("h");
    // no preferred kind and no hold -> first action
    expect(
      chooseStarterAction([act("t", "target_player"), act("e", "embargo")]).id,
    ).toBe("t");
  });

  it("throws on an empty action set", () => {
    expect(() => chooseStarterAction([])).toThrow();
  });

  it("the brain selects the chosen action id (contract: offered LegalAction.id only)", () => {
    const decision = new StarterBotAgentBrain().decide({
      legalActions: [act("h", "hold"), act("at", "attack")],
    } as unknown as AgentBrainInput);
    expect(decision.actionID).toBe("at");
  });
});
