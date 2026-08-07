/**
 * Pins the league-build wagering exclusion at its cheap, fast layer (the
 * full two-build proof is `npm run verify:league-client`):
 *
 *  1. every league stub exports exactly the same runtime names as the real
 *     wagering module it replaces (so aliasing can never break an import);
 *  2. the stub map (`stubMap.ts`) and this test cover the same module
 *     pairs (so neither can drift without the other noticing);
 *  3. the sentinel wiring holds — the real modules carry the build
 *     sentinel, the stubs never do, and vite.config.ts still wires the
 *     alias map plus the wagering load guard;
 *  4. the stubs behave inertly at the shapes `Main.ts` actually relies on.
 *
 * Import order matters: real modules FIRST — their `@customElement`
 * registrations are unguarded, while the stubs' registrations are guarded,
 * so this order lets both live in one jsdom module graph.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { WAGERING_BUILD_SENTINEL } from "../../../../src/client/prediction/wagering/buildSentinel";
import * as realPnlDisplay from "../../../../src/client/prediction/wagering/components/pnlDisplay";
import * as realAccountPage from "../../../../src/client/prediction/wagering/page/AccountPage";
import * as realBettingPremierePage from "../../../../src/client/prediction/wagering/page/BettingPremierePage";
import * as realPremiereEndedPage from "../../../../src/client/prediction/wagering/page/PremiereEndedPage";

import * as stubAccountPage from "../../../../src/client/prediction/leagueStubs/AccountPage";
import * as stubBettingPremierePage from "../../../../src/client/prediction/leagueStubs/BettingPremierePage";
import * as stubPremiereEndedPage from "../../../../src/client/prediction/leagueStubs/PremiereEndedPage";
import * as stubPnlDisplay from "../../../../src/client/prediction/leagueStubs/pnlDisplay";
import { LEAGUE_WAGERING_STUB_MAP } from "../../../../src/client/prediction/leagueStubs/stubMap";

const repoRoot = path.resolve(__dirname, "../../../..");

const PAIRS = [
  {
    realModule: "src/client/prediction/wagering/page/BettingPremierePage",
    stubModule: "src/client/prediction/leagueStubs/BettingPremierePage",
    real: realBettingPremierePage,
    stub: stubBettingPremierePage,
  },
  {
    realModule: "src/client/prediction/wagering/page/AccountPage",
    stubModule: "src/client/prediction/leagueStubs/AccountPage",
    real: realAccountPage,
    stub: stubAccountPage,
  },
  {
    realModule: "src/client/prediction/wagering/page/PremiereEndedPage",
    stubModule: "src/client/prediction/leagueStubs/PremiereEndedPage",
    real: realPremiereEndedPage,
    stub: stubPremiereEndedPage,
  },
  {
    realModule: "src/client/prediction/wagering/components/pnlDisplay",
    stubModule: "src/client/prediction/leagueStubs/pnlDisplay",
    real: realPnlDisplay,
    stub: stubPnlDisplay,
  },
] as const;

function sourceOf(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

/** Every .ts/.tsx file under dir, recursively, as repo-rooted posix paths. */
function walkSourceFiles(dirAbs: string): string[] {
  const out: string[] = [];
  const stack = [dirAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push(path.relative(repoRoot, full).split(path.sep).join("/"));
      }
    }
  }
  return out.sort();
}

/**
 * Every VALUE-import specifier in one source file: side-effect imports,
 * `import ... from` / `export ... from` clauses (top-level `import type` /
 * `export type` are erased at build and therefore excluded — a mixed
 * `import { type A, B }` still counts, correctly, as a value import), and
 * dynamic `import("...")`.
 */
function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // import/export ... from "spec" — group 2 catches TOP-LEVEL `type`
  // (type-only, erased); the clause may span lines but never contains
  // quotes or semicolons.
  const fromRe =
    /(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(fromRe)) {
    if (match[2] === undefined) specifiers.push(match[4]);
  }
  // Side-effect imports: import "spec";
  for (const match of source.matchAll(/import\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  // Dynamic imports: import("spec")
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** Resolve an import specifier to a repo-rooted, extensionless module path. */
function resolveSpecifier(fileRel: string, specifier: string): string {
  if (specifier.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(fileRel), specifier),
    );
  }
  // tsconfig-paths style ("src/...") — already repo-rooted. Anything else
  // is returned verbatim and will fail map membership loudly.
  return specifier;
}

/**
 * `new StubElementClass()` only works once the class is registered with the
 * custom-element registry ("Illegal constructor" otherwise). In this test's
 * graph the REAL modules win the shared tags, so the stub classes stay
 * unregistered — register them under a test-only tag on demand. Falls back
 * through a plain `new` first so this keeps working if the stub's guarded
 * define ever wins the real tag instead.
 */
function instantiateStubElement<T extends HTMLElement>(
  ctor: new () => T,
  testTag: string,
): T {
  try {
    return new ctor();
  } catch {
    if (customElements.get(testTag) === undefined) {
      customElements.define(testTag, ctor);
    }
    return new ctor();
  }
}

describe("league wagering stub parity", () => {
  it("the stub map and this test pin the same module pairs", () => {
    expect(
      LEAGUE_WAGERING_STUB_MAP.map((entry) => ({
        realModule: entry.realModule,
        stubModule: entry.stubModule,
      })).sort((a, b) => a.realModule.localeCompare(b.realModule)),
    ).toEqual(
      PAIRS.map((pair) => ({
        realModule: pair.realModule,
        stubModule: pair.stubModule,
      })).sort((a, b) => a.realModule.localeCompare(b.realModule)),
    );
  });

  it.each(PAIRS.map((pair) => [pair.realModule, pair] as const))(
    "stub exports the same runtime names as %s",
    (_name, pair) => {
      expect(Object.keys(pair.stub).sort()).toEqual(
        Object.keys(pair.real).sort(),
      );
    },
  );

  it("every stubbed real module carries the build sentinel; no stub does", () => {
    for (const pair of PAIRS) {
      // Real modules import the sentinel module so any league-bundle leak
      // brings the literal with it.
      expect(sourceOf(`${pair.realModule}.ts`)).toContain("buildSentinel");
      // Stubs must never contain even the literal's prefix (a half-copied
      // sentinel would break the absent-scan's meaning).
      expect(sourceOf(`${pair.stubModule}.ts`)).not.toMatch(
        /PROXYWAR-WAGERING-SENTINEL/,
      );
    }
    expect(
      sourceOf("src/client/prediction/leagueStubs/leagueStubShared.ts"),
    ).not.toMatch(/PROXYWAR-WAGERING-SENTINEL/);
  });

  it("the sentinel literal in source, at runtime, and on globalThis agree", () => {
    const source = sourceOf("src/client/prediction/wagering/buildSentinel.ts");
    const match = source.match(
      /export const WAGERING_BUILD_SENTINEL\s*=\s*"([^"]+)"/,
    );
    expect(match?.[1]).toBe(WAGERING_BUILD_SENTINEL);
    expect(WAGERING_BUILD_SENTINEL).toMatch(
      /^PROXYWAR-WAGERING-SENTINEL-[0-9a-f]{8}$/,
    );
    // The module-evaluation global write is the minification-proof "actually
    // used" anchor — importing the real modules above must have performed it.
    expect(
      (globalThis as Record<string, unknown>)["__PROXYWAR_WAGERING_BUILD__"],
    ).toBe(WAGERING_BUILD_SENTINEL);
  });

  it("vite.config.ts wires the stub map and the wagering load guard", () => {
    const source = sourceOf("vite.config.ts");
    expect(source).toContain("LEAGUE_WAGERING_STUB_MAP");
    expect(source).toContain("PROXYWAR_LEAGUE_CLIENT");
    expect(source).toContain('"/src/client/prediction/wagering/"');
    expect(source).toContain("leagueWageringGuard");
  });

  it("every value-import of prediction/wagering across src/client is stub-mapped", () => {
    // Fast-feedback twin of the vite load guard: a NEW wagering import
    // added anywhere in src/client would otherwise only surface as a
    // league VITE build failure at build:image time. This turns it into a
    // red unit test in seconds. Type-only imports are excluded (erased at
    // build, legitimately unmapped); the wagering tree itself and the
    // stubs are excluded (internal imports never bundle in league mode —
    // their importers are what get stubbed).
    const mappedModules = new Set(
      LEAGUE_WAGERING_STUB_MAP.map((entry) => entry.realModule),
    );
    const found = new Map<string, string[]>();
    for (const fileRel of walkSourceFiles(path.join(repoRoot, "src/client"))) {
      if (
        fileRel.startsWith("src/client/prediction/wagering/") ||
        fileRel.startsWith("src/client/prediction/leagueStubs/")
      ) {
        continue;
      }
      for (const specifier of valueImportSpecifiers(sourceOf(fileRel))) {
        if (!specifier.includes("prediction/wagering")) continue;
        const resolved = resolveSpecifier(fileRel, specifier);
        found.set(resolved, [...(found.get(resolved) ?? []), fileRel]);
      }
    }
    // Every discovered value-import must be stub-mapped...
    const unmapped = [...found.entries()].filter(
      ([resolved]) => !mappedModules.has(resolved),
    );
    expect(
      unmapped.map(
        ([resolved, importers]) =>
          `${resolved} (imported by ${importers.join(", ")}) has no ` +
          `LEAGUE_WAGERING_STUB_MAP entry — add a stub, never widen the ` +
          `league bundle`,
      ),
    ).toEqual([]);
    // ...and every mapped module must still have at least one importer, so
    // this scan can never rot into a vacuous pass (and dead map entries
    // get pruned instead of lingering).
    const dead = [...mappedModules].filter((module) => !found.has(module));
    expect(dead).toEqual([]);
  });

  it("stubbed betting premiere page is inert at Main.ts's contact points", async () => {
    // Route classification must MATCH the real module — `/bet/<id>` still
    // classifies (then redirects) rather than falling through to the lobby.
    const premiereId = "prem_0123456789abcdef";
    expect(stubBettingPremierePage.parseBettingPremiereRoute("/bet/x")).toBe(
      realBettingPremierePage.parseBettingPremiereRoute("/bet/x"),
    );
    expect(
      stubBettingPremierePage.parseBettingPremiereRoute(`/bet/${premiereId}`),
    ).toBe(
      realBettingPremierePage.parseBettingPremiereRoute(`/bet/${premiereId}`),
    );
    expect(
      stubBettingPremierePage.parseBettingPremiereRoute(
        `/premiere/${premiereId}`,
      ),
    ).toBeNull();

    const handle = stubBettingPremierePage.openBettingPremierePage(premiereId, {
      onJoinReady: () => {
        throw new Error("stub must never join a lobby");
      },
    });
    // Main.ts awaits start() right after mounting; the stub's promise must
    // exist and must not reject (a rejection would flash the failure veil).
    const settled = await Promise.race([
      (handle.runtime.start() as Promise<void>).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(settled).toBe("pending");
    expect(() => handle.dispose()).not.toThrow();
    await expect(
      stubBettingPremierePage.resolveCurrentBettingPremiereId(),
    ).resolves.toBeNull();
  });

  it("stubbed premiere-ended page renders the themed copy with a league CTA", () => {
    // The REAL module owns the `premiere-ended-page` tag in this test's
    // module graph (its unguarded decorator define runs first; the stub's
    // define is guarded), so instantiate the stub CLASS under a test-only
    // tag and drive its lifecycle directly — never mount the real element
    // here (its connectedCallback fires real account/settlement fetches).
    const stub = instantiateStubElement(
      stubPremiereEndedPage.PremiereEndedPage,
      "test-league-stub-premiere-ended",
    );
    stub.connectedCallback();
    expect(stub.textContent).toContain("This premiere has ended");
    const cta = Array.from(stub.querySelectorAll("a")).find(
      (anchor) => anchor.getAttribute("href") === "/league",
    );
    expect(cta?.textContent).toContain("Go to the league");
    // No wagering data surfaces: the stub renders synchronously from
    // nothing (the real page's loading state advertises itself via
    // role=status).
    expect(stub.querySelector("[role=status]")).toBeNull();
  });

  it("stubbed account page registers the tag and stays inert", () => {
    // The tag itself is registered (by the real module here; by the stub in
    // a league bundle) — Main.ts's openAccountPage mounts it by tag name.
    expect(customElements.get("premiere-account-page")).toBeDefined();
    const stub = instantiateStubElement(
      stubAccountPage.PremiereAccountPage,
      "test-league-stub-account",
    );
    expect(() => stub.connectedCallback()).not.toThrow();
    expect(stub.childElementCount).toBe(0);
  });

  it("stub pnl formatting matches the real module where the league uses it", () => {
    for (const value of [0, 1, -1, 1234, -56789]) {
      expect(stubPnlDisplay.formatSignedCredits(value)).toBe(
        realPnlDisplay.formatSignedCredits(value),
      );
    }
    for (const percent of [null, 0, 12.34, -5.678]) {
      expect(stubPnlDisplay.formatSignedPercent(percent)).toBe(
        realPnlDisplay.formatSignedPercent(percent),
      );
    }
    expect(stubPnlDisplay.pnlPercent(40, 200)).toBe(
      realPnlDisplay.pnlPercent(40, 200),
    );
    expect(stubPnlDisplay.pnlPercent(40, 0)).toBeNull();
    // Direction parity only — magnitude tiers are deliberately dropped in
    // the stub (see its module doc).
    expect(stubPnlDisplay.pnlTier(10, 50).icon).toBe(
      realPnlDisplay.pnlTier(10, 50).icon,
    );
    expect(stubPnlDisplay.pnlTier(-10, -50).icon).toBe(
      realPnlDisplay.pnlTier(-10, -50).icon,
    );
    expect(stubPnlDisplay.pnlTier(0, null).icon).toBe(
      realPnlDisplay.pnlTier(0, null).icon,
    );
  });
});
