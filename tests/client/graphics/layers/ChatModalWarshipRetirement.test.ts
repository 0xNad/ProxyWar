import { describe, expect, it } from "vitest";
import { QuickChatKeySchema } from "../../../../src/core/Schemas";
import { quickChatPhrases } from "../../../../src/client/graphics/layers/ChatModal";

describe("retired Warship quick chat", () => {
  it("keeps the historical schema key but does not offer it in new menus", () => {
    expect(QuickChatKeySchema.safeParse("attack.build_warships").success).toBe(
      true,
    );
    expect(
      quickChatPhrases.attack.some((phrase) => phrase.key === "build_warships"),
    ).toBe(false);
  });
});
