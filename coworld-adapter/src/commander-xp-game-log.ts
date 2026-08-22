import { COMMANDER_XP_GAME_EVIDENCE_PREFIX } from "../../src/server/agents/CommanderXpGameEvidence";

const CONTAINER_HEADER = "===== container: ";
const MAX_LOG_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Decode the exact multi-container bytes-repr framing printed by Coworld 0.1.42. */
export function commanderXpGameEvidenceFromCoworld042Output(
  output: string,
): string[] {
  if (Buffer.byteLength(output, "utf8") > MAX_LOG_OUTPUT_BYTES) {
    throw new Error("Coworld game-log output exceeds bounded parser limit");
  }
  const containers = parseContainers(output);
  const game = containers.get("game");
  if (game === undefined) {
    throw new Error("Coworld game-log output has no game container");
  }
  return game
    .split(/\r?\n/)
    .flatMap((line) =>
      line.startsWith(COMMANDER_XP_GAME_EVIDENCE_PREFIX)
        ? [line.slice(COMMANDER_XP_GAME_EVIDENCE_PREFIX.length)]
        : [],
    );
}

/** Extract evidence from the platform-issued bundle's decoded game.log. */
export function commanderXpGameEvidenceFromRawGameLog(log: string): string[] {
  if (Buffer.byteLength(log, "utf8") > MAX_LOG_OUTPUT_BYTES) {
    throw new Error("Coworld game log exceeds bounded parser limit");
  }
  return log
    .split(/\r?\n/)
    .flatMap((line) =>
      line.startsWith(COMMANDER_XP_GAME_EVIDENCE_PREFIX)
        ? [line.slice(COMMANDER_XP_GAME_EVIDENCE_PREFIX.length)]
        : [],
    );
}

function parseContainers(output: string): Map<string, string> {
  if (output.includes("\r")) {
    throw new Error("Coworld game-log framing contains unsupported CR bytes");
  }
  const result = new Map<string, string>();
  let cursor = 0;
  while (cursor < output.length) {
    if (!output.startsWith(CONTAINER_HEADER, cursor)) {
      throw new Error("Coworld game-log container header is malformed");
    }
    const headerEnd = output.indexOf(" =====\n", cursor);
    if (headerEnd < 0) {
      throw new Error("Coworld game-log container header is unterminated");
    }
    const name = output.slice(cursor + CONTAINER_HEADER.length, headerEnd);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || result.has(name)) {
      throw new Error(
        "Coworld game-log container name is invalid or duplicate",
      );
    }
    const literalStart = headerEnd + " =====\n".length;
    const nextHeader = output.indexOf(`\n\n${CONTAINER_HEADER}`, literalStart);
    const literalEnd = nextHeader < 0 ? output.length : nextHeader;
    let literal = output.slice(literalStart, literalEnd);
    if (nextHeader < 0 && literal.endsWith("\n"))
      literal = literal.slice(0, -1);
    if (literal.includes("\n")) {
      throw new Error("Coworld game-log container has multiple literal lines");
    }
    result.set(name, decodePythonBytesRepr(literal));
    cursor = nextHeader < 0 ? output.length : nextHeader + 2;
  }
  return result;
}

function decodePythonBytesRepr(literal: string): string {
  if (
    literal.length < 3 ||
    literal[0] !== "b" ||
    !["'", '"'].includes(literal[1]!) ||
    literal.at(-1) !== literal[1]
  ) {
    throw new Error("Coworld game-log body is not one Python bytes literal");
  }
  const quote = literal[1]!;
  const bytes: number[] = [];
  for (let index = 2; index < literal.length - 1; index += 1) {
    const character = literal[index]!;
    if (character !== "\\") {
      const code = character.charCodeAt(0);
      if (code > 0x7f || character === quote) {
        throw new Error("Coworld game-log bytes literal has an invalid byte");
      }
      bytes.push(code);
      continue;
    }
    index += 1;
    const escaped = literal[index];
    if (escaped === undefined || index >= literal.length - 1) {
      throw new Error("Coworld game-log bytes escape is truncated");
    }
    if (escaped === "x") {
      const hex = literal.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new Error("Coworld game-log hex escape is malformed");
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    const simple: Record<string, number> = {
      "\\": 0x5c,
      "'": 0x27,
      '"': 0x22,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      v: 0x0b,
    };
    const value = simple[escaped];
    if (value === undefined) {
      throw new Error("Coworld game-log bytes escape is unsupported");
    }
    bytes.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    throw new Error("Coworld game-log bytes are not valid UTF-8");
  }
}
