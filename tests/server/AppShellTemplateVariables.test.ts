import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * index.html is rendered by TWO independent EJS callers:
 *
 *   1. src/server/RenderHtml.ts            — the live app shell
 *   2. src/scripts/replay-premiere-clip-worker.ts — the clip renderer's
 *      loopback capture host
 *
 * EJS throws ReferenceError on ANY undefined name, so a variable added to the
 * template but supplied by only one caller breaks the other at runtime. That is
 * not hypothetical: adding the social/OG tags supplied `socialPageUrl` from the
 * server only, and every clip render died with
 * "ReferenceError: socialPageUrl is not defined" — after ffmpeg and bundle
 * verification had already succeeded, so it surfaced as a generic clip failure.
 *
 * This test pins the invariant: every name the template interpolates must be
 * supplied by both renderers.
 */
const repoRoot = path.resolve(__dirname, "../..");

function templateVariableNames(): string[] {
  const html = readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const names = new Set<string>();
  // Matches <%- name %> and <%= name %>, ignoring scriptlets (<% ... %>).
  for (const match of html.matchAll(/<%[-=]\s*([A-Za-z_$][\w$]*)\s*%>/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function sourceOf(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("app shell EJS template variables", () => {
  const names = templateVariableNames();

  it("finds the template's interpolated names", () => {
    // Guards the extractor itself: if this drops to zero the test below would
    // vacuously pass and stop protecting anything.
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("socialPageUrl");
  });

  it.each([
    ["src/server/RenderHtml.ts"],
    ["src/scripts/replay-premiere-clip-worker.ts"],
  ])("%s supplies every name index.html interpolates", (relativePath) => {
    const source = sourceOf(relativePath);
    // Accept both `name: value` and ES object shorthand (`name,`).
    const missing = names.filter(
      (name) => !new RegExp(`\\b${name}\\b\\s*[:,]`).test(source),
    );
    expect(missing).toEqual([]);
  });
});
