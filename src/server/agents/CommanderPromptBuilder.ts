import { Buffer } from "node:buffer";
import { canonicalCommanderJson } from "./CommanderStateBuilder";
import { UNTRUSTED_DISPLAY_RULE } from "./PromptSanitizer";
import {
  commanderReplanTriggers,
  type CommanderState,
} from "./StrategicCommanderTypes";

export const MAX_COMMANDER_STATE_JSON_BYTES = 16_384;
export const MAX_COMMANDER_PROMPT_BYTES = 20_000;

export class CommanderPromptBuilder {
  build(state: CommanderState): string {
    return buildCommanderPrompt(state);
  }
}

/**
 * Builds the complete StrategicCommanderV0 prompt. It intentionally has no
 * dependency on the action-selector prompt, playbooks, or executable bindings.
 */
export function buildCommanderPrompt(state: CommanderState): string {
  const stateJson = canonicalCommanderJson(state);
  if (Buffer.byteLength(stateJson, "utf8") > MAX_COMMANDER_STATE_JSON_BYTES) {
    throw new Error("Commander state JSON exceeds its prompt byte bound");
  }
  const prompt = [
    "You command an autonomous nation in Proxy War.",
    "Your job is strategy, not low-level execution.",
    UNTRUSTED_DISPLAY_RULE,
    "Choose exactly one currently offered StrategicOption by its id.",
    "A deterministic executor will later translate the selected option into legal game actions.",
    "Goal: maximize the probability of winning the match.",
    "Reason about relative position, threats, opportunity cost, momentum, and timing.",
    "Do not invent options.",
    "Do not select individual build tiles, attack percentages, boats, units, raw game actions, or LegalAction IDs.",
    `Allowed replanTriggers: ${commanderReplanTriggers.join(", ")}.`,
    "horizonDecisions defaults to 3 when omitted; integer values are clamped from 2 through 6.",
    "intent is required and nonempty; whitespace and controls are normalized and the result is capped at 160 characters.",
    "replanTriggers is optional; when present it must be an array using only the allowed values, without duplicates.",
    "confidence is optional; invalid values outside the finite range from 0 through 1 are ignored.",
    "Return one JSON object only, with no prose or markdown.",
    "Required response shape:",
    '{"selectedStrategicOptionId":"<one offered option id>","horizonDecisions":4,"intent":"<bounded strategic intent>","replanTriggers":[],"confidence":0.5}',
    "COMMANDER_STATE_JSON:",
    stateJson,
    "END_COMMANDER_STATE_JSON",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_COMMANDER_PROMPT_BYTES) {
    throw new Error("Commander prompt exceeds its byte bound");
  }
  return prompt;
}
