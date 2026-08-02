import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

import {
  appShellHeader,
  waitForTranslationsReady,
} from "../../../src/client/publicapp/AppShellChrome";

/**
 * Coverage for `appShellHeader`'s account chip/link — the shared public
 * shell must link to the platform account authority (`readModel.links.
 * accountUrl`) on every Stage 2+ page, per the account-chip parity gap
 * against the mirror-written `/league` page's own `.account-link` chip
 * (`CoworldLeagueSiteWriter.ts`). Deliberately a plain link: no
 * session-state fetch happens in the shell (the shell stays account-
 * unaware beyond the URL, same as every other cross-origin platform link
 * already in this codebase).
 */
describe("appShellHeader account chip", () => {
  let container: HTMLElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
  });

  function renderHeader(
    accountUrl: string | undefined,
  ): HTMLElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    render(appShellHeader("/", undefined, accountUrl), container);
    return container;
  }

  it("renders a plain link to the projected account URL when the read model has loaded", () => {
    const root = renderHeader("https://app.proxywar.xyz/account");
    const link = root.querySelector<HTMLAnchorElement>(
      'header a[href="https://app.proxywar.xyz/account"]',
    );
    expect(link).not.toBeNull();
    expect(link?.textContent?.trim()).toBe("app_shell.account_link");
  });

  it("omits the account chip entirely while the read model has not loaded yet (accountUrl undefined) — never a broken or placeholder link", () => {
    const root = renderHeader(undefined);
    const links = Array.from(
      root.querySelectorAll<HTMLAnchorElement>("header a"),
    );
    // Only the brand-mark link ("/") and the five nav links are present.
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/",
      "/watch",
      "/league",
      "/agents",
      "/builders",
      "/build",
    ]);
  });

  it("projects whatever origin the caller passes — no hardcoded platform host in the shell itself", () => {
    const root = renderHeader("http://127.0.0.1:8798/account");
    const link = root.querySelector<HTMLAnchorElement>(
      'a[href="http://127.0.0.1:8798/account"]',
    );
    expect(link?.getAttribute("href")).toBe("http://127.0.0.1:8798/account");
  });

  it("issues no network request from the shell itself — a plain <a>, not a fetch-backed component", () => {
    const root = renderHeader("https://app.proxywar.xyz/account");
    const link = root.querySelector<HTMLAnchorElement>(
      'header a[href="https://app.proxywar.xyz/account"]',
    );
    // A real navigation target, not a button/click-handler wrapping a fetch.
    expect(link?.tagName).toBe("A");
    expect(link?.hasAttribute("href")).toBe(true);
  });
});

/**
 * P2 mobile-nav fix (2026-08-02): the 5-item nav scrolls horizontally on
 * narrow viewports (`overflow-x-auto`) rather than wrapping or
 * collapsing to a hamburger — but with no visual cue, the last item
 * ("Build") was simply cut off with nothing suggesting more content sat
 * offscreen. `.app-shell-nav` carries a right-edge scroll-fade
 * (`mask-image`, styles.css), cleared above the `sm:` breakpoint where
 * the nav stops scrolling.
 */
describe("appShellHeader nav scroll-fade affordance", () => {
  it("marks the nav with the scroll-fade class every render, regardless of active route", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(appShellHeader("/watch"), container);
    const nav = container.querySelector("header nav");
    expect(nav?.classList.contains("app-shell-nav")).toBe(true);
    container.remove();
  });
});

/**
 * P0 fix (found live 2026-08-02, under 3G throttle): the shared shell's
 * nav (`app_shell.nav_*`, rendered by `appShellHeader` above) showed raw
 * translation keys for as long as a slow connection took — `translateText`
 * has no subscription of its own, so a caller only sees a real value once
 * SOMETHING re-renders after `<lang-selector>`'s async translations load
 * resolves. `waitForTranslationsReady` is the extracted, shared fix every
 * public page's `connectedCallback` now calls.
 */
describe("waitForTranslationsReady", () => {
  let langSelector: HTMLElement | null = null;

  afterEach(() => {
    langSelector?.remove();
    langSelector = null;
    vi.useRealTimers();
  });

  it("resolves immediately when <lang-selector>'s translations are already loaded", async () => {
    langSelector = document.createElement("lang-selector");
    (langSelector as unknown as { translations: unknown }).translations = {};
    document.body.appendChild(langSelector);

    const before = Date.now();
    await waitForTranslationsReady();
    // No polling delay incurred — the very first check already succeeded.
    expect(Date.now() - before).toBeLessThan(20);
  });

  it("awaits <lang-selector>'s updateComplete, then resolves once translations land", async () => {
    langSelector = document.createElement("lang-selector");
    let resolveUpdate!: () => void;
    const updateComplete = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });
    const target = langSelector as unknown as {
      translations?: unknown;
      updateComplete: Promise<void>;
    };
    target.updateComplete = updateComplete;
    document.body.appendChild(langSelector);

    let settled = false;
    const pending = waitForTranslationsReady().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    target.translations = {};
    resolveUpdate();
    await pending;
    expect(settled).toBe(true);
  });

  it("gives up after its bounded retry budget when <lang-selector> is never found — never an indefinite loop", async () => {
    // No <lang-selector> in the DOM at all: every attempt falls through to
    // the 20ms setTimeout branch. Fake timers advance that instantly so
    // this proves the loop terminates (bounded at 20 attempts) without a
    // real 400ms wall-clock wait.
    vi.useFakeTimers();
    const pending = waitForTranslationsReady();
    await vi.advanceTimersByTimeAsync(20 * 20);
    await expect(pending).resolves.toBeUndefined();
  });
});
