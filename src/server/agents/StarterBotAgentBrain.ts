import {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  LegalAction,
} from "./AgentTypes";

/**
 * StarterBotAgentBrain — an in-process, faithful port of the published Coworld
 * starter policy (`coworld-adapter/src/starter-player.mjs` `chooseAction`).
 *
 * Purpose: the FORGE eval needs the agent measured against the ACTUAL Coworld
 * field (raw starter bots), not OpenFront's built-in nation/tribe AI. Wrapping
 * the starter policy as an `AgentBrain` lets the league `brainFactory` seat
 * starter-bot opponents alongside the LLM agent — the held-out opponent class.
 *
 * It only ever selects an OFFERED `LegalAction.id` (same contract as every other
 * brain) — it does not emit raw intents and does not touch the validator/runner.
 *
 * Fidelity note: starter-player.mjs reads the WIRE legalActions; this brain reads
 * the INTERNAL legalActions. The dominant kinds (spawn/attack/build/boat/
 * alliance_request/quick_chat/emoji/hold) are identical on both sides. The one
 * gap is "upgrade" (starter string) vs internal "upgrade_structure" — we match
 * BOTH so the bot can pick upgrades regardless of which the Coworld wire uses;
 * verify the adapter's kind serialization if exact field parity is required.
 */
export class StarterBotAgentBrain implements AgentBrain {
  readonly brainType = "rule";

  decide(input: AgentBrainInput): AgentDecision {
    const action = chooseStarterAction(input.legalActions);
    return {
      actionID: action.id,
      reason: `Starter selected ${action.kind}: ${action.label}`,
    };
  }
}

// Priority order copied verbatim from starter-player.mjs. Both upgrade spellings
// sit in the one slot: the bundled player now emits the canonical
// "upgrade_structure" (its old "upgrade" matched no kind the builder emits), and
// the dead "upgrade" is kept here only so this stays a superset of any starter
// copy still carrying it. Priority-preserving either way.
const PREFERRED_KINDS: ReadonlyArray<string> = [
  "spawn",
  "attack",
  "build",
  "upgrade",
  "upgrade_structure",
  "boat",
  "alliance_request",
  "quick_chat",
  "emoji",
];

export function chooseStarterAction(actions: LegalAction[]): LegalAction {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("StarterBotAgentBrain requires at least one legal action");
  }
  for (const kind of PREFERRED_KINDS) {
    const action = actions.find(
      (candidate) =>
        candidate.kind === kind &&
        candidate.risk?.level !== "high" &&
        !String(candidate.id).includes("avoid"),
    );
    if (action) {
      return action;
    }
  }
  return actions.find((candidate) => candidate.kind === "hold") ?? actions[0];
}
