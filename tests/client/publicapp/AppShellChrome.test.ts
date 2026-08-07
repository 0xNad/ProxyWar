import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appShellFooter,
  appShellHeader,
  requestUpdateWhenTranslationsReady,
  waitForTranslationsReady,
} from "../../../src/client/publicapp/AppShellChrome";

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

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

  function renderHeader(accountUrl: string | undefined): HTMLElement {
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
 * Footer community link: the shared shell includes a Telegram community
 * link in the footer, alongside the GitHub repository and About links.
 * The link is accessible with an aria-label, opens in a new tab with
 * security attributes, and uses the correct Telegram group URL.
 */
describe("appShellFooter community link", () => {
  let container: HTMLElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
  });

  function renderFooter(): HTMLElement {
    const el = document.createElement("div");
    document.body.appendChild(el);
    container = el;
    render(appShellFooter(), el);
    return el;
  }

  it("includes the Telegram community link with correct href and security attributes", () => {
    const root = renderFooter();
    const telegramLink = root.querySelector<HTMLAnchorElement>(
      'a[href="https://t.me/+TeaDXnPwbxk1Mjk8"]',
    );
    expect(telegramLink).toBeTruthy();
    // Mock translateText (lines 4-6) returns the key directly, so visible text is the translation key itself
    expect(telegramLink?.textContent).toBe("app_shell.footer_telegram");
    expect(telegramLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(telegramLink?.getAttribute("target")).toBe("_blank");
    expect(telegramLink?.getAttribute("aria-label")).toBe(
      "Telegram community group",
    );
  });

  it("is a real link with href, not a button or JavaScript handler", () => {
    const root = renderFooter();
    const telegramLink = root.querySelector<HTMLAnchorElement>(
      'a[href="https://t.me/+TeaDXnPwbxk1Mjk8"]',
    );
    expect(telegramLink?.tagName).toBe("A");
    expect(telegramLink?.hasAttribute("href")).toBe(true);
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

  it("resolves immediately (never throws) when document is unavailable — the exact test-teardown race that produced an intermittent 'Unhandled Rejection: document is not defined' in the full suite (2026-08-02)", async () => {
    vi.stubGlobal("document", undefined);
    try {
      await expect(waitForTranslationsReady()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Regression coverage for the `isConnected` guard in
 * `requestUpdateWhenTranslationsReady` (2026-08-07): every public page's
 * `connectedCallback` used to call `waitForTranslationsReady().then(() =>
 * this.requestUpdate())` directly — a fire-and-forget chain with no such
 * guard. `waitForTranslationsReady`'s own bounded retry can still be
 * pending when the calling element is unmounted (a real navigation away
 * in a browser, or — the failure actually seen live — an element torn
 * down between test files while this promise chain sat starved of CPU
 * and only settled much later): calling `requestUpdate()` on an
 * already-disconnected element schedules a Lit update whose later
 * `render()` has no guarantee `document` still exists (confirmed live:
 * an intermittent "Unhandled Rejection: ReferenceError: document is not
 * defined" from exactly this pattern — GH Actions run 31137636588,
 * `AgentsDirectoryPage.test.ts`, ~53s after that file's own tests had
 * already finished and passed). `element` is a plain structural fake, not
 * a real Lit component — this tests the guard itself, deterministically,
 * without needing to reproduce the cross-file jsdom-teardown timing race.
 */
describe("requestUpdateWhenTranslationsReady", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls requestUpdate() once translations become ready, while the element is still connected", async () => {
    vi.useFakeTimers();
    const requestUpdate = vi.fn();
    const element = { isConnected: true, requestUpdate };
    requestUpdateWhenTranslationsReady(element);
    // No <lang-selector> in the DOM: every attempt falls through to the
    // bounded 20ms retry branch (see `waitForTranslationsReady`'s own
    // tests above) — advance past its full 20-attempt budget.
    await vi.advanceTimersByTimeAsync(20 * 20);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("never calls requestUpdate() once the element has been disconnected before translations become ready", async () => {
    vi.useFakeTimers();
    const requestUpdate = vi.fn();
    const element = { isConnected: true, requestUpdate };
    requestUpdateWhenTranslationsReady(element);
    element.isConnected = false; // simulates unmount/jsdom teardown mid-wait
    await vi.advanceTimersByTimeAsync(20 * 20);
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});
