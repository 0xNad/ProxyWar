import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  composeCoworldDecision,
  normalizeDecisionResponse,
  type NormalizedDecisionResponse,
} from "../../coworld-adapter/src/coworld-decision-wire";
import type { AgentDecision } from "../../src/server/agents/AgentTypes";

/**
 * WHY THIS FILE EXISTS
 *
 * `AgentDecision` grew a third optional selection slot (the free-text comms
 * pair). Every in-process path honored it and every test passed — but
 * `normalizeDecisionResponse`, the Coworld adapter's decision wire, still
 * listed only `actionID` / `actionIDs` / `spawnPreferenceActionIDs` /
 * `dealActionID`. `Dockerfile.coworld` runs that entrypoint as the hosted
 * league image, so every hosted policy's message was dropped one layer below
 * the game and no league agent could speak at all. Nothing detected it,
 * because nothing anywhere asserted "the selection fields the brains forward
 * are the selection fields the adapter carries".
 *
 * This file is that assertion. It lives in `tests/` rather than beside the
 * adapter for two reasons: it polices three trees at once
 * (`src/server/agents/AgentTypes.ts`, the external brains, and the adapter),
 * so it is not a unit test of any one of them; and `tests/**` is inside the
 * root `tsconfig.json` `include`, while `coworld-adapter/**` is not — so the
 * compile-time half of this contract is checked by the `tsc --noEmit` everyone
 * runs, not only by the adapter's separate typecheck script.
 *
 * The key sets are DERIVED, not transcribed: the field list comes from
 * `AgentTypes.ts`, the forwarded list comes from the brains' own decision
 * literals, and the carried list comes from actually calling the wire. The one
 * hand-written table below (`DECISION_FIELD_CONTRACT`) is an acknowledgement
 * map, and the first test makes it impossible to leave it stale.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const AGENT_TYPES_PATH = "src/server/agents/AgentTypes.ts";

/**
 * Every brain that builds an `AgentDecision` from a parsed external reply.
 * Both are league-reachable: the HTTP brain serves self-hosted policies and
 * the relay brain serves managed ones, and they have already drifted apart
 * once, so both are scanned rather than just the one the review named.
 */
const DECISION_FORWARDER_PATHS = [
  "src/server/agents/ExternalHttpAgentBrain.ts",
  "src/server/agents/ExternalRelayAgentBrain.ts",
];

type FieldRole =
  /** A slot the agent picks. It MUST survive the Coworld wire. */
  | "selection"
  /** Not a selection, but still read off the player's reply by the wire. */
  | "carried"
  /** Produced by the adapter itself, never read off the player's reply. */
  | "adapter-composed";

type FieldContract =
  | {
      role: Extract<FieldRole, "selection">;
      /**
       * The `decision_response` keys a Coworld player sends for this slot.
       * Deliberately spelled with the WIRE names: the wire's names and the
       * `AgentDecision` names differ on purpose (`selectedMessageActionId` ->
       * `messageActionID`), so the mapping is what has to be pinned, not the
       * spelling.
       */
      wireMessage: Record<string, unknown>;
      /** What the wire must produce on the `AgentDecision`-shaped result. */
      expected: unknown;
    }
  | { role: Extract<FieldRole, "carried">; why: string }
  | { role: Extract<FieldRole, "adapter-composed">; why: string };

/**
 * One entry per field of `AgentDecision`. Not a list of names to keep in sync
 * by hand — the first test derives the real field set from `AgentTypes.ts` and
 * fails loudly if this table has drifted in either direction.
 */
const DECISION_FIELD_CONTRACT: Record<string, FieldContract> = {
  actionID: {
    role: "selection",
    wireMessage: { selectedLegalActionId: "attack:P_B" },
    expected: "attack:P_B",
  },
  actionIDs: {
    role: "selection",
    wireMessage: {
      selectedLegalActionId: "attack:P_B",
      selectedLegalActionIds: ["attack:P_B", "build:city"],
    },
    expected: ["attack:P_B", "build:city"],
  },
  spawnPreferenceActionIDs: {
    role: "selection",
    wireMessage: {
      selectedLegalActionId: "spawn:first",
      spawnPreferenceLegalActionIds: ["spawn:first", "spawn:second"],
    },
    expected: ["spawn:first", "spawn:second"],
  },
  dealActionID: {
    role: "selection",
    wireMessage: {
      selectedLegalActionId: "attack:P_B",
      selectedDealActionId: "deal_propose:P_B:non_aggression",
    },
    expected: "deal_propose:P_B:non_aggression",
  },
  messageActionID: {
    role: "selection",
    wireMessage: {
      selectedLegalActionId: "attack:P_B",
      selectedMessageActionId: "message:P_B",
      messageText: "Truce on our shared border until turn 300.",
    },
    expected: "message:P_B",
  },
  messageText: {
    role: "selection",
    wireMessage: {
      selectedLegalActionId: "attack:P_B",
      selectedMessageActionId: "message:P_B",
      messageText: "Truce on our shared border until turn 300.",
    },
    expected: "Truce on our shared border until turn 300.",
  },
  reason: {
    role: "carried",
    why: "The agent's own rationale, not a selection. The wire carries it with a default when the player sends none.",
  },
  metadata: {
    role: "adapter-composed",
    why: "Episode-local provenance (slot, requestID, offered menu size, degradation flags). composeCoworldDecision builds it; it is never read off the player's selection.",
  },
};

const FIX_INSTRUCTIONS = [
  "If you added a new selection slot to AgentDecision:",
  "  1. Carry it in coworld-adapter/src/coworld-decision-wire.ts — BOTH the",
  "     NormalizedDecisionResponse interface and the object normalizeDecisionResponse",
  "     returns. Dockerfile.coworld runs that entrypoint as the hosted league image,",
  "     so a slot the adapter drops is a slot no league policy can ever use, no",
  "     matter how many in-process tests pass.",
  "  2. Add an entry to DECISION_FIELD_CONTRACT in this file with role 'selection'",
  "     and a wireMessage fixture, so the wire-name -> AgentDecision-name mapping is",
  "     pinned by an actual call.",
  "  3. If the field is NOT a selection, classify it 'carried' or 'adapter-composed'",
  "     and say why.",
  "Do not delete this test to make it pass: the comms slot shipped with no adapter",
  "carry, and every hosted league message was silently dropped until PR #125.",
].join("\n");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/**
 * Reads a field off a decision by NAME. The whole point of this file is to
 * check fields the compiler cannot enumerate for us at runtime, so the lookup
 * is deliberately dynamic — a typed property access would only ever prove the
 * fields we already remembered to write down.
 */
function fieldOf(decision: object, field: string): unknown {
  return (decision as unknown as Record<string, unknown>)[field];
}

/**
 * Slices a `{ ... }` (or `( ... )`) block starting at `openIndex`, respecting
 * comments and string/template literals so a brace inside a doc comment or a
 * string cannot end the block early.
 */
function sliceBalancedBlock(source: string, openIndex: number): string {
  const open = source[openIndex];
  const close = open === "{" ? "}" : ")";
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    if (pair === "//") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (pair === "/*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < source.length && source[index] !== char) {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex, index + 1);
      }
    }
    index += 1;
  }
  throw new Error(
    `Unbalanced '${open}' block starting at index ${openIndex}. ${FIX_INSTRUCTIONS}`,
  );
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Declared field names of an interface, in source order. */
function interfaceFieldNames(source: string, interfaceName: string): string[] {
  const header = `export interface ${interfaceName} {`;
  const headerIndex = source.indexOf(header);
  expect(
    headerIndex,
    `Could not find '${header}'. If it was renamed or moved, repoint this test — do not delete it.\n${FIX_INSTRUCTIONS}`,
  ).toBeGreaterThanOrEqual(0);
  const block = stripComments(
    sliceBalancedBlock(source, headerIndex + header.length - 1),
  );
  const names: string[] = [];
  let depth = 0;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    const match = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
    // Depth 1 is the interface body itself; anything deeper belongs to a
    // nested object type and is not a field of this interface.
    if (depth === 1 && match !== null) {
      names.push(match[1]);
    }
    depth += (rawLine.match(/[{(]/g) ?? []).length;
    depth -= (rawLine.match(/[})]/g) ?? []).length;
  }
  return names;
}

/**
 * The `AgentDecision` keys a brain's decision literal can emit. Anchored on
 * the literal that builds a decision from a parsed reply (`actionID:
 * parsed.selectedLegalActionId`) rather than on a method name, so renaming
 * `decideRequested` does not silently blind this test.
 */
function forwardedDecisionKeys(source: string): Set<string> {
  const keys = new Set<string>();
  let searchFrom = 0;
  let blocksFound = 0;
  while (true) {
    const returnIndex = source.indexOf("return {", searchFrom);
    if (returnIndex === -1) {
      break;
    }
    const braceIndex = source.indexOf("{", returnIndex);
    const block = stripComments(sliceBalancedBlock(source, braceIndex));
    searchFrom = returnIndex + 1;
    if (!block.includes("actionID: parsed.selectedLegalActionId")) {
      continue;
    }
    blocksFound += 1;
    for (const key of objectLiteralKeys(block)) {
      keys.add(key);
    }
  }
  expect(
    blocksFound,
    `Found no decision literal (a 'return {' containing 'actionID: parsed.selectedLegalActionId'). If the brains were refactored, repoint this scanner — do not delete it.\n${FIX_INSTRUCTIONS}`,
  ).toBeGreaterThan(0);
  return keys;
}

/**
 * Identifiers in KEY position inside one object literal — `{ key: value }` and
 * shorthand `{ key }` alike. Shorthand matters: the wire module already writes
 * the comms pair that way, so a scanner that only understood `key:` could go
 * quietly blind the moment a brain was tidied up the same way.
 *
 * Over-collection (a nested literal's keys) is the deliberate failure
 * direction: an extra key fails loudly, a missed key fails silently.
 */
function keyPositionNames(objectLiteral: string): string[] {
  return [
    ...objectLiteral.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[:,}])/g),
  ].map((match) => match[1]);
}

/**
 * Keys of a decision object literal: the plain top-level keys, plus the keys
 * inside top-level conditional spreads (`...(cond ? { key: value } : {})`),
 * which is how every optional slot is forwarded. Keys nested deeper — above
 * all the `metadata: { ... }` envelope and its own conditional spreads — are
 * NOT decision keys and are excluded by the depth check.
 */
function objectLiteralKeys(block: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let index = 0;
  while (index < block.length) {
    const char = block[index];
    if (char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        break;
      }
      continue;
    }
    if (depth === 1 && block.startsWith("...(", index)) {
      const spread = sliceBalancedBlock(block, index + 3);
      // Only the object literals inside the spread carry keys; the condition
      // in front of the `?` is code, and scanning it would invent keys.
      let inner = 0;
      while (inner < spread.length) {
        if (spread[inner] !== "{") {
          inner += 1;
          continue;
        }
        const literal = sliceBalancedBlock(spread, inner);
        keys.push(...keyPositionNames(literal));
        inner += literal.length;
      }
      index += spread.length + 3;
      continue;
    }
    if (depth === 1) {
      const previous = block.slice(0, index).trimEnd().slice(-1);
      const match = /^([A-Za-z_$][\w$]*)\s*(?=[:,}])/.exec(block.slice(index));
      if (match !== null && (previous === "{" || previous === ",")) {
        keys.push(match[1]);
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
  return keys;
}

const declaredDecisionFields = interfaceFieldNames(
  readRepoFile(AGENT_TYPES_PATH),
  "AgentDecision",
);

const selectionFields = Object.entries(DECISION_FIELD_CONTRACT)
  .filter(([, contract]) => contract.role === "selection")
  .map(([field]) => field);

const nonSelectionFields = new Set(
  Object.entries(DECISION_FIELD_CONTRACT)
    .filter(([, contract]) => contract.role !== "selection")
    .map(([field]) => field),
);

/** Every selection fixture merged into one reply, as a real player could send. */
const kitchenSinkWireMessage: Record<string, unknown> = Object.values(
  DECISION_FIELD_CONTRACT,
).reduce<Record<string, unknown>>(
  (accumulated, contract) =>
    contract.role === "selection"
      ? { ...accumulated, ...contract.wireMessage }
      : accumulated,
  { reason: "kitchen sink" },
);

describe("AgentDecision field contract", () => {
  it("classifies every declared AgentDecision field (fails when a new slot appears)", () => {
    const unclassified = declaredDecisionFields.filter(
      (field) => DECISION_FIELD_CONTRACT[field] === undefined,
    );
    expect(
      unclassified,
      `AgentDecision has field(s) this contract does not classify: ${unclassified.join(", ")}\n\n${FIX_INSTRUCTIONS}`,
    ).toEqual([]);
  });

  it("keeps the contract from outliving the fields it claims to describe", () => {
    const declared = new Set(declaredDecisionFields);
    const stale = Object.keys(DECISION_FIELD_CONTRACT).filter(
      (field) => !declared.has(field),
    );
    expect(
      stale,
      `This contract classifies field(s) AgentDecision no longer declares: ${stale.join(", ")}. Remove them (and their wire carry, if the slot is gone).`,
    ).toEqual([]);
  });

  it("derives the field list from source rather than trusting the table", () => {
    // Health check on the scanner itself: a regex that silently matched
    // nothing would make every assertion above vacuously true.
    expect(declaredDecisionFields).toContain("actionID");
    expect(declaredDecisionFields).toContain("reason");
    expect(declaredDecisionFields.length).toBeGreaterThanOrEqual(
      Object.keys(DECISION_FIELD_CONTRACT).length,
    );
  });
});

describe("external brains forward only selections the Coworld wire carries", () => {
  const forwarded = new Map(
    DECISION_FORWARDER_PATHS.map((relativePath) => [
      relativePath,
      forwardedDecisionKeys(readRepoFile(relativePath)),
    ]),
  );

  it.each(DECISION_FORWARDER_PATHS)(
    "scans a real decision literal out of %s",
    (relativePath) => {
      // Health check: if the scanner breaks, the subset assertion below would
      // pass against an empty set — exactly the "test that cannot fail" the
      // P0 already taught us to distrust.
      const keys = forwarded.get(relativePath) ?? new Set<string>();
      expect(keys).toContain("actionID");
      expect(keys).toContain("reason");
      expect(keys).toContain("metadata");
      expect(keys.size).toBeGreaterThanOrEqual(4);
    },
  );

  it.each(DECISION_FORWARDER_PATHS)(
    "carries every selection field %s forwards through normalizeDecisionResponse",
    (relativePath) => {
      const forwardedSelections = [
        ...(forwarded.get(relativePath) ?? new Set<string>()),
      ]
        .filter((key) => !nonSelectionFields.has(key))
        .sort();
      const carried = new Set(
        Object.keys(normalizeDecisionResponse(kitchenSinkWireMessage)),
      );
      const dropped = forwardedSelections.filter((key) => !carried.has(key));
      expect(
        dropped,
        `${relativePath} forwards selection field(s) the Coworld decision wire drops: ${dropped.join(", ")}\n\n${FIX_INSTRUCTIONS}`,
      ).toEqual([]);
    },
  );

  it("keeps both brains' forwarded selection sets identical to each other", () => {
    // The relay brain's comment says it forwards "for parity with the HTTP
    // brain". Parity that is only asserted in a comment is how one path grows
    // a slot the other never gets.
    const [first, ...rest] = DECISION_FORWARDER_PATHS.map((relativePath) =>
      [...(forwarded.get(relativePath) ?? new Set<string>())].sort(),
    );
    for (const other of rest) {
      expect(other).toEqual(first);
    }
  });
});

describe("normalizeDecisionResponse selection mapping", () => {
  it.each(selectionFields)(
    "maps the wire reply onto AgentDecision.%s",
    (field) => {
      const contract = DECISION_FIELD_CONTRACT[field];
      if (contract.role !== "selection") {
        throw new Error(`Expected ${field} to be a selection contract.`);
      }
      const normalized = normalizeDecisionResponse(contract.wireMessage);
      expect(
        fieldOf(normalized, field),
        `normalizeDecisionResponse dropped or renamed AgentDecision.${field}. The wire's own key names differ on purpose, so the MAPPING is the contract.\n\n${FIX_INSTRUCTIONS}`,
      ).toEqual(contract.expected);
    },
  );

  it("carries every selection at once, exactly like a maximal player reply", () => {
    const normalized = normalizeDecisionResponse(kitchenSinkWireMessage);
    const missing = selectionFields.filter(
      (field) => fieldOf(normalized, field) === undefined,
    );
    expect(
      missing,
      `A reply exercising every slot lost: ${missing.join(", ")}\n\n${FIX_INSTRUCTIONS}`,
    ).toEqual([]);
  });

  it("invents no key that AgentDecision does not declare", () => {
    // Catches the near-miss rename (`messageActionId` for `messageActionID`),
    // which would type-check inside the adapter and be dropped by the league.
    const declared = new Set(declaredDecisionFields);
    const invented = Object.keys(
      normalizeDecisionResponse(kitchenSinkWireMessage),
    ).filter((key) => !declared.has(key));
    expect(
      invented,
      `The Coworld wire emits key(s) AgentDecision does not declare: ${invented.join(", ")}. The league reads AgentDecision, so these are dead fields.`,
    ).toEqual([]);
  });
});

describe("composeCoworldDecision (the real last hop into AgentLeagueMatch)", () => {
  it("preserves every selection the wire normalized", () => {
    // This is the composition no-docker-coworld-episode.ts actually resolves.
    // It used to be reachable only by hand-reconstruction in a test, which
    // could not catch the spread being replaced by explicit field picking.
    const normalized = normalizeDecisionResponse(kitchenSinkWireMessage);
    const composed = composeCoworldDecision({
      normalized,
      message: kitchenSinkWireMessage,
      slot: 2,
      requestID: "req_42",
      offeredLegalActionCount: 7,
    });
    const dropped = selectionFields.filter(
      (field) => fieldOf(composed, field) === undefined,
    );
    expect(
      dropped,
      `composeCoworldDecision dropped selection field(s) the wire normalized: ${dropped.join(", ")}\n\n${FIX_INSTRUCTIONS}`,
    ).toEqual([]);
  });

  it("adds only the metadata envelope on top of the normalized decision", () => {
    const normalized = normalizeDecisionResponse(kitchenSinkWireMessage);
    const composed = composeCoworldDecision({
      normalized,
      message: kitchenSinkWireMessage,
      slot: 0,
      requestID: "req_1",
      offeredLegalActionCount: 3,
    });
    const { metadata, ...selection } = composed;
    expect(selection).toEqual(normalized);
    expect(metadata.brain).toBe("coworld-websocket");
  });
});

describe("compile-time half of the contract", () => {
  /**
   * A real `tsc --noEmit` failure, not a runtime one: if the wire ever
   * declares a key `AgentDecision` does not have, this stops being `true` and
   * the assignment below fails to compile. The runtime expectation exists only
   * so the value is used.
   */
  type WireKeysAreDecisionKeys =
    Exclude<keyof NormalizedDecisionResponse, keyof AgentDecision> extends never
      ? true
      : false;
  const wireKeysAreDecisionKeys: WireKeysAreDecisionKeys = true;

  it("declares no wire key outside AgentDecision", () => {
    expect(wireKeysAreDecisionKeys).toBe(true);
  });
});
