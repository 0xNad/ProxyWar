import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression coverage for the `/build` step-3 (Identity) scroll trap: the
 * shared `styles.css` (imported by BOTH `Main.ts`'s game shell AND
 * `PublicApp.ts`'s public pages — `/`, `/watch`, `/agents`, `/builders`,
 * `/agent/:slug`, `/builder/:slug`, `/match/:matchId`, `/about`, `/build`)
 * used to carry `body { overflow: hidden !important }` — a lock the game
 * shell genuinely wants ("the main page never scrolls; modals handle
 * internal scrolling") but that silently clipped any public page taller
 * than the viewport with NO way to reach the rest: mouse-wheel/touch/
 * keyboard scrolling were all blocked (only programmatic `scrollTo` still
 * worked, which is not how a real visitor interacts). Confirmed live on
 * `/build` step 3, `/`, `/watch`, and `/about`.
 *
 * The fix splits the lock into its own stylesheet
 * (`styles/game-shell-scroll-lock.css`) imported ONLY by `Main.ts`. This
 * test pins the split structurally (source inspection, not jsdom computed
 * style — vitest's jsdom environment does not run the real CSS cascade for
 * imported stylesheets) so nobody re-merges the lock back into the shared
 * file or re-adds an equivalent clip to `AppShellChrome.ts`'s
 * `APP_SHELL_ROOT_CLASSES`, which every public page's `createRenderRoot()`
 * applies to its own root element.
 */
const repoRoot = path.resolve(__dirname, "../../..");

function sourceOf(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("public app pages never inherit the game shell's viewport scroll lock", () => {
  it("the shared styles.css (imported by both Main.ts and PublicApp.ts) carries no body/html overflow:hidden rule", () => {
    const css = sourceOf("src/client/styles.css");
    // A body/html rule block whose declarations set overflow to hidden —
    // matches regardless of !important, whitespace, or declaration order.
    const lockPattern =
      /\b(?:html|body)\b[^{]*\{[^}]*overflow\s*:\s*hidden/i;
    expect(lockPattern.test(css)).toBe(false);
  });

  it("the game-shell-only scroll lock still exists, for the game shell to opt into", () => {
    const css = sourceOf("src/client/styles/game-shell-scroll-lock.css");
    expect(/\bbody\b[^{]*\{[^}]*overflow\s*:\s*hidden/i.test(css)).toBe(true);
  });

  it("Main.ts (the game shell entry) imports the scroll lock", () => {
    const source = sourceOf("src/client/Main.ts");
    expect(source).toContain("./styles/game-shell-scroll-lock.css");
  });

  it("PublicApp.ts (every public page's entry) does NOT import the scroll lock", () => {
    const source = sourceOf("src/client/PublicApp.ts");
    expect(source).not.toContain("game-shell-scroll-lock.css");
  });

  it("APP_SHELL_ROOT_CLASSES carries no viewport-clipping utility class", () => {
    const source = sourceOf("src/client/publicapp/AppShellChrome.ts");
    const match = source.match(
      /export const APP_SHELL_ROOT_CLASSES = \[([\s\S]*?)\] as const;/,
    );
    expect(match).not.toBeNull();
    const classes = [...(match?.[1].matchAll(/"([^"]+)"/g) ?? [])].map(
      (m) => m[1],
    );
    expect(classes.length).toBeGreaterThan(0);
    for (const disallowed of [
      "overflow-hidden",
      "h-screen",
      "max-h-screen",
      "h-full",
    ]) {
      expect(classes).not.toContain(disallowed);
    }
  });
});
