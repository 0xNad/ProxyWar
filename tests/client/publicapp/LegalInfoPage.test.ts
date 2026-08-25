import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

import "../../../src/client/publicapp/LegalInfoPage";

async function mount(pathname: string): Promise<HTMLElement> {
  window.history.replaceState({}, "", pathname);
  const page = document.createElement("legal-info-page");
  document.body.append(page);
  await Promise.resolve();
  return page;
}

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("legal-info-page", () => {
  it.each([
    ["/privacy", "legal.privacy_title", "legal.privacy_data_heading"],
    ["/terms", "legal.terms_title", "legal.terms_conduct_heading"],
    ["/credits", "legal.credits_title", "legal.credits_platform_heading"],
  ])("renders the truthful %s surface", async (path, title, section) => {
    const page = await mount(path);
    const text = page.textContent ?? "";

    expect(page.querySelector("h1")?.textContent?.trim()).toBe(title);
    expect(text).toContain(section);
    expect(page.querySelector('footer a[href="/privacy"]')).not.toBeNull();
    expect(page.querySelector('footer a[href="/terms"]')).not.toBeNull();
    expect(page.querySelector('footer a[href="/credits"]')).not.toBeNull();
  });

  it("links privacy, source-license, credits, and asset-license authority", async () => {
    const privacy = await mount("/privacy");
    expect(
      privacy.querySelector(
        'a[href*="docs/SEASON_ZERO_ANALYTICS.md"]',
      ),
    ).not.toBeNull();
    privacy.remove();

    const terms = await mount("/terms");
    expect(terms.querySelector('a[href$="/LICENSE"]')).not.toBeNull();
    terms.remove();

    const credits = await mount("/credits");
    expect(credits.querySelector('a[href$="/CREDITS.md"]')).not.toBeNull();
    expect(credits.querySelector('a[href$="/LICENSE-ASSETS"]')).not.toBeNull();
  });
});
