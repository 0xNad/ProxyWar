import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRONTIER_TWINS,
  modeKey,
} from "../../../src/client/publicapp/WorldText";

const en = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "resources/lang/en.json"), "utf8"),
) as Record<string, Record<string, string>>;

function lookup(key: string): string | undefined {
  const [section, name] = key.split(".");
  return en[section]?.[name];
}

describe("modeKey", () => {
  it("reads the Frontier Four twin in that mode and the league key otherwise", () => {
    expect(modeKey({ mode: "frontier-four" }, "home_page.rules_rule")).toBe(
      "home_page.rules_rule_frontier",
    );
    expect(modeKey({ mode: "league" }, "home_page.rules_rule")).toBe(
      "home_page.rules_rule",
    );
    expect(modeKey({}, "home_page.rules_rule")).toBe("home_page.rules_rule");
    expect(modeKey({ mode: "frontier-four" }, "home_page.context")).toBe(
      "home_page.context",
    );
  });

  it("has every twin in en.json, saying team and never agent or league", () => {
    for (const [key, twin] of Object.entries(FRONTIER_TWINS)) {
      expect(lookup(key), key).toBeTypeOf("string");
      const text = lookup(twin);
      expect(text, twin).toBeTypeOf("string");
      expect(text, twin).not.toMatch(/\b(agents?|league)\b/i);
    }
  });
});
