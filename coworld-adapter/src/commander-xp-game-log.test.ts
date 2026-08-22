import { describe, expect, it } from "vitest";

import { commanderXpGameEvidenceFromCoworld042Output } from "./commander-xp-game-log";

const evidence = JSON.stringify({
  schemaVersion: 2,
  requestID: "req_exact",
  note: "player's move",
});
const doubleQuotedBytesEvidence = evidence.replaceAll('"', '\\"');

describe("Coworld 0.1.42 Commander XP game-log framing", () => {
  it("decodes the exact multi-container Python bytes representation", () => {
    const output = [
      "===== container: coworld-init-config =====",
      "b''",
      "",
      "===== container: bedrock-sidecar =====",
      "b'bedrock_sidecar_started\\n'",
      "",
      "===== container: game =====",
      `b"using dev server config\\n\\xe2\\x97\\x87 env\\nCOMMANDER_XP_GAME_EVIDENCE ${doubleQuotedBytesEvidence}\\n{\\n  \\"ok\\": true\\n}\\n"`,
      "",
      "===== container: worker =====",
      "b''",
      "",
    ].join("\n");
    expect(commanderXpGameEvidenceFromCoworld042Output(output)).toEqual([
      evidence,
    ]);
  });

  it.each([
    [
      "duplicate game",
      "===== container: game =====\nb''\n\n===== container: game =====\nb''",
    ],
    ["concatenated literals", "===== container: game =====\nb'' b''"],
    ["malformed escape", "===== container: game =====\nb'\\x0z'"],
    [
      "embedded non-column-zero prefix",
      "===== container: game =====\nb'xCOMMANDER_XP_GAME_EVIDENCE {}\\n'",
    ],
  ])("rejects or ignores %s", (_label, output) => {
    if (_label === "embedded non-column-zero prefix") {
      expect(commanderXpGameEvidenceFromCoworld042Output(output)).toEqual([]);
    } else {
      expect(() =>
        commanderXpGameEvidenceFromCoworld042Output(output),
      ).toThrow();
    }
  });
});
