import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRONTIER_TWINS,
  modeKey,
  SEASON_TWO_TWINS,
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

  it("reads the Season 2 twin in that mode, falling back to the league key", () => {
    expect(modeKey({ mode: "frontier" }, "home_page.rules_rule")).toBe(
      "home_page.rules_rule_season2",
    );
    expect(modeKey({ mode: "frontier" }, "home_page.data_as_of")).toBe(
      "home_page.data_as_of_frontier",
    );
    expect(modeKey({ mode: "frontier" }, "home_page.context")).toBe(
      "home_page.context",
    );
  });

  it("has every Season 2 twin in en.json, saying model, with no window to count", () => {
    // Every key the Frontier Four twins also has a Season 2 twin.
    for (const key of Object.keys(FRONTIER_TWINS)) {
      expect(SEASON_TWO_TWINS[key], key).toBeTypeOf("string");
    }
    for (const [key, twin] of Object.entries(SEASON_TWO_TWINS)) {
      expect(lookup(key), key).toBeTypeOf("string");
      const text = lookup(twin);
      expect(text, twin).toBeTypeOf("string");
      expect(text, twin).not.toMatch(/\b(agents?|league|teams?)\b/i);
      expect(text, twin).not.toMatch(/\{window\}|siege|nerf|weaker/i);
    }
  });
});
