import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

import { appShellHeader } from "../../../src/client/publicapp/AppShellChrome";

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
