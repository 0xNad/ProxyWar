import { isDealActionKind } from "./AgentDealManager";
import { FREETEXT_MESSAGE_MAX_CHARS } from "./AgentTunables";
import {
  AgentDecision,
  AgentPrimaryActionValidationPolicy,
  LegalAction,
} from "./AgentTypes";

export interface AgentDecisionValidationOptions {
  /**
   * Defaults to the documented legacy protocol, where a structured deal may
   * occupy the primary slot. The in-house social prompt opts into the stricter
   * ordinary-only contract through server-owned validation context.
   */
  primaryActionPolicy?: AgentPrimaryActionValidationPolicy;
}

export type AgentDecisionValidation =
  | { ok: true; action: LegalAction }
  | { ok: false; reason: string; fallback: LegalAction | null };

export type AgentDealDecisionValidation =
  | { ok: true; action: LegalAction }
  | { ok: false; reason: string };

export type AgentMessageDecisionValidation =
  | { ok: true; action: LegalAction; text: string }
  | { ok: false; reason: string };

/**
 * Validates the OPTIONAL second selection, `AgentDecision.dealActionID` (the
 * diplomacy slot). Returns null only when the field is absent — the shipped
 * single-action path is then completely untouched. A present string is
 * matched verbatim; whitespace is not authority to rewrite an action id.
 *
 * Two gates, both mandatory:
 * 1. exact-id match against the SAME offered menu as `actionID` (no off-menu
 *    ids, exactly like every other selection);
 * 2. the action's kind must be one of the four deal meta-action kinds.
 *
 * Gate 2 is the raw-intent-bypass boundary: without it a policy could name an
 * attack/nuke/build id here and get a second game action per decision. There
 * is NO fallback — an invalid deal selection is reported and dropped, never
 * substituted, so a rejected deal selection can never change what reaches the
 * game.
 */
export function validateAgentDealDecision(
  decision: AgentDecision,
  legalActions: LegalAction[],
): AgentDealDecisionValidation | null {
  if (typeof decision.dealActionID !== "string") {
    return null;
  }
  const requestedID = decision.dealActionID;
  const action = legalActions.find((candidate) => candidate.id === requestedID);
  if (action === undefined) {
    return {
      ok: false,
      reason: `deal selection named unknown action id: ${loggableActionID(requestedID)}`,
    };
  }
  if (!isDealActionKind(action.kind)) {
    return {
      ok: false,
      reason: `deal selection named a non-deal action kind (${action.kind}): ${loggableActionID(requestedID)}`,
    };
  }
  return { ok: true, action };
}

/**
 * Validates the OPTIONAL third selection — the comms slot
 * (`AgentDecision.messageActionID` + `messageText`). Returns null only when
 * both fields are absent, leaving every shipped path untouched. A partial or
 * malformed-present pair is rejected rather than erased.
 *
 * This is the ONLY validator that admits agent-authored free text, so it is
 * deliberately the strictest. Four mandatory gates:
 * 1. exact-id match against the SAME offered menu as `actionID`;
 * 2. the action's kind must be `message` — the raw-intent-bypass boundary,
 *    without which a policy could name an attack id here and buy itself a
 *    second game action per decision;
 * 3. the raw body must be present, non-blank, and within
 *    FREETEXT_MESSAGE_MAX_CHARS;
 * 4. the raw body must contain no control, line/paragraph separator, bidi, or
 *    zero-width characters.
 *
 * Violations are REJECTED, never repaired. Truncating or stripping would put
 * words the agent did not write in its mouth, and every negotiation claim we
 * later make rests on the text being verbatim. There is no fallback: a
 * rejected message is dropped and the game action proceeds untouched.
 *
 * NOT this function's job: judging whether the text is manipulative. Messages
 * that try to talk a rival's model into a bad move are legal play in this
 * league, and the starter is hardened to treat inbound text as untrusted
 * claims rather than instructions.
 */
export function validateAgentMessageDecision(
  decision: AgentDecision,
  legalActions: LegalAction[],
): AgentMessageDecisionValidation | null {
  const requestedID = decision.messageActionID;
  const text = decision.messageText;
  const requestedIDAbsent = requestedID === null || requestedID === undefined;
  const textAbsent = text === null || text === undefined;
  if (requestedIDAbsent && textAbsent) {
    return null;
  }
  if (typeof requestedID !== "string") {
    return {
      ok: false,
      reason: "messageText was present without a string messageActionID",
    };
  }
  if (typeof text !== "string") {
    return {
      ok: false,
      reason: `message selection ${loggableActionID(requestedID)} carried no messageText`,
    };
  }
  const action = legalActions.find((candidate) => candidate.id === requestedID);
  if (action === undefined) {
    return {
      ok: false,
      reason: `message selection named unknown action id: ${loggableActionID(requestedID)}`,
    };
  }
  if (action.kind !== "message") {
    return {
      ok: false,
      reason: `message selection named a non-message action kind (${action.kind}): ${loggableActionID(requestedID)}`,
    };
  }
  // C0 controls (including tab, LF, and CR), DEL, and C1 controls can alter
  // transcript layout, terminal framing, or prompt boundaries. Check the RAW
  // text before any blank/length handling: accepting then collapsing these
  // characters would silently rewrite the agent's negotiation evidence.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(text)) {
    return {
      ok: false,
      reason: "messageText contained control characters",
    };
  }
  // Invisible formatting characters are checked on the RAW text, BEFORE any
  // other validation. Three distinct abuses:
  //
  // 1. BIDI OVERRIDES (U+202A-202E, U+2066-2069, U+200E-200F, U+061C) visually
  //    reorder the rendered line. The transcript renders as
  //    "{sender} -> {recipient}: {msg}" and we own only the English string --
  //    Crowdin owns every other locale, and any locale placing {msg} first
  //    would let attacker text reorder the ATTRIBUTION. Spoofing who said what
  //    in a negotiation transcript corrupts the very evidence this feature
  //    exists to produce, and `unsafeDescription: false` makes the line a
  //    single text node, so it cannot be repaired with <bdi> at render time.
  //
  // 2. ZERO-WIDTH PADDING (U+200B-200D, U+2060, U+00AD, U+FEFF) buys up to 280
  //    invisible characters that cost real tokens in every recipient's prompt
  //    and render as a blank chat row.
  //
  // 3. LINE/PARAGRAPH SEPARATORS (U+2028-2029) create raw layout boundaries
  //    even though they sit outside the C0/C1 ranges above.
  //
  // Rejected rather than stripped, like every other violation here: silently
  // removing characters would change what the agent wrote.
  //
  // ORDER MATTERS, and getting it wrong previously made the U+FEFF arm DEAD
  // CODE. JS `\s` matches U+FEFF, so the old whitespace collapse removed FEFF
  // before this check: `"deal\uFEFF\uFEFFnow"` was ACCEPTED and silently
  // rewritten to `"deal now"`, and `commsSlotText` recorded a sentence with a
  // word boundary the agent never wrote. For a feature whose whole purpose is
  // negotiation EVIDENCE, a rewritten quote is worse than a rejected one, so
  // this check remains on the raw string.
  if (
    /[\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/u.test(
      text,
    )
  ) {
    return {
      ok: false,
      reason:
        "messageText contained invisible formatting or bidi-override characters",
    };
  }
  if (text.trim().length === 0) {
    return {
      ok: false,
      reason: `message selection ${loggableActionID(requestedID)} carried blank messageText`,
    };
  }
  if (text.length > FREETEXT_MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      reason: `messageText is ${text.length} chars, over the ${FREETEXT_MESSAGE_MAX_CHARS}-char cap (rejected, not truncated)`,
    };
  }
  return { ok: true, action, text };
}

/**
 * The rejection reason is stamped into decisions.jsonl by the league runner,
 * so the agent-controlled id it quotes is bounded here (the lookup above
 * still uses the full id, so a long-but-legal id can never be mismatched).
 */
const MAX_QUOTED_DEAL_ACTION_ID = 120;

function loggableActionID(requestedID: string): string {
  return requestedID.length <= MAX_QUOTED_DEAL_ACTION_ID
    ? requestedID
    : `${requestedID.slice(0, MAX_QUOTED_DEAL_ACTION_ID)}... (${requestedID.length} chars)`;
}

export interface AgentDecisionBatchValidation {
  ok: boolean;
  actions: LegalAction[];
  rejectedActionIDs: string[];
  fallback: LegalAction | null;
  reason: string;
}

export function validateAgentDecision(
  decision: AgentDecision,
  legalActions: LegalAction[],
  options: AgentDecisionValidationOptions = {},
): AgentDecisionValidation {
  const action = legalActions.find(
    (candidate) => candidate.id === decision.actionID,
  );
  const fallback =
    legalActions.find((candidate) => candidate.kind === "hold") ?? null;
  if (action !== undefined) {
    const primarySlotRejection = primarySlotRejectionReason(
      action,
      options.primaryActionPolicy ?? "legacy-deal-compatible",
    );
    if (primarySlotRejection !== null) {
      return {
        ok: false,
        reason: primarySlotRejection,
        fallback,
      };
    }
    return { ok: true, action };
  }

  return {
    ok: false,
    reason: `decision selected unknown action id: ${decision.actionID}`,
    fallback,
  };
}

export function validateAgentDecisionBatch(
  decision: AgentDecision,
  legalActions: LegalAction[],
  options: AgentDecisionValidationOptions = {},
): AgentDecisionBatchValidation {
  const requestedActionIDs = requestedBatchActionIDs(decision);
  const actions: LegalAction[] = [];
  const rejectedActionIDs: string[] = [];
  const unknownActionIDs: string[] = [];
  const primarySlotRejectedActionIDs: string[] = [];
  const primaryActionPolicy =
    options.primaryActionPolicy ?? "legacy-deal-compatible";

  for (const actionID of requestedActionIDs) {
    const action = legalActions.find((candidate) => candidate.id === actionID);
    if (action === undefined) {
      rejectedActionIDs.push(actionID);
      unknownActionIDs.push(actionID);
      continue;
    }
    if (primarySlotRejectionReason(action, primaryActionPolicy) !== null) {
      rejectedActionIDs.push(actionID);
      primarySlotRejectedActionIDs.push(actionID);
      continue;
    }
    actions.push(action);
  }

  if (actions.length > 0) {
    return {
      ok: rejectedActionIDs.length === 0,
      actions,
      rejectedActionIDs,
      fallback: null,
      reason:
        rejectedActionIDs.length === 0
          ? "all requested action ids are legal"
          : batchRejectionReason(
              "ignored",
              unknownActionIDs,
              primarySlotRejectedActionIDs,
            ),
    };
  }

  const fallback =
    legalActions.find((candidate) => candidate.kind === "hold") ?? null;
  return {
    ok: false,
    actions: fallback ? [fallback] : [],
    rejectedActionIDs,
    fallback,
    reason:
      rejectedActionIDs.length > 0
        ? batchRejectionReason(
            "decision selected no eligible",
            unknownActionIDs,
            primarySlotRejectedActionIDs,
          )
        : "decision selected no action ids",
  };
}

function primarySlotRejectionReason(
  action: LegalAction,
  policy: AgentPrimaryActionValidationPolicy,
): string | null {
  // A `message` id is offered, but it belongs in the COMMS slot. Selected as
  // the game action it would submit no intent and send no message — the agent
  // would silently forfeit its move and believe it had spoken. Refuse it in
  // every contract, including the legacy one.
  if (action.kind === "message") {
    return "message actions belong in the comms slot (messageActionID + messageText), not the game action slot; nothing was sent";
  }
  // Existing external policies may still play one deal as their primary
  // action. Only the armed in-house social prompt promises that deals live in
  // the separate diplomacy slot and therefore opts into this stricter rule.
  if (policy === "ordinary-only" && isDealActionKind(action.kind)) {
    return "deal actions belong in the diplomacy slot (dealActionID), not the ordinary game action slot under the in-house social prompt contract";
  }
  return null;
}

function batchRejectionReason(
  prefix: "ignored" | "decision selected no eligible",
  unknownActionIDs: string[],
  primarySlotRejectedActionIDs: string[],
): string {
  if (prefix === "ignored") {
    if (primarySlotRejectedActionIDs.length === 0) {
      // Preserve the legacy unknown-only wording byte for byte.
      return `ignored unknown action ids: ${unknownActionIDs.join(",")}`;
    }
    if (unknownActionIDs.length === 0) {
      return `ignored primary-slot-forbidden action ids: ${primarySlotRejectedActionIDs.join(",")}`;
    }
    return `ignored unknown action ids: ${unknownActionIDs.join(",")}; primary-slot-forbidden action ids: ${primarySlotRejectedActionIDs.join(",")}`;
  }
  if (prefix === "decision selected no eligible") {
    if (primarySlotRejectedActionIDs.length === 0) {
      // Preserve the legacy unknown-only wording byte for byte.
      return `decision selected no known action ids: ${unknownActionIDs.join(",")}`;
    }
    if (unknownActionIDs.length === 0) {
      return `decision selected no primary-slot-eligible action ids: ${primarySlotRejectedActionIDs.join(",")}`;
    }
  }
  const parts: string[] = [];
  if (unknownActionIDs.length > 0) {
    parts.push(`unknown action ids: ${unknownActionIDs.join(",")}`);
  }
  if (primarySlotRejectedActionIDs.length > 0) {
    parts.push(
      `primary-slot-forbidden action ids: ${primarySlotRejectedActionIDs.join(",")}`,
    );
  }
  return `${prefix} action ids; ${parts.join("; ")}`;
}

function requestedBatchActionIDs(decision: AgentDecision): string[] {
  const raw =
    decision.actionIDs !== undefined && decision.actionIDs.length > 0
      ? decision.actionIDs
      : [decision.actionID];
  const deduplicated: string[] = [];
  for (const id of raw) {
    if (id.trim().length > 0 && !deduplicated.includes(id)) {
      deduplicated.push(id);
    }
  }
  return deduplicated;
}
