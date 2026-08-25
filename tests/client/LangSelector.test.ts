import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/client/LangSelector";

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("lang-selector document title translation", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    localStorage.clear();
  });

  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("translates the generic app-shell title marked with data-i18n", async () => {
    document.head.innerHTML = '<title data-i18n="main.title">OpenFront</title>';
    document.head.append(document.createElement("lang-selector"));
    await flushMicrotasks();

    expect(document.title).toBe("Proxy War");
  });

  it("preserves a route-specific title without a data-i18n marker during hydration", async () => {
    document.head.innerHTML =
      "<title>Battle 1937 — Proxy War Replay Premiere</title>";
    document.head.append(document.createElement("lang-selector"));
    await flushMicrotasks();

    expect(document.title).toBe("Battle 1937 — Proxy War Replay Premiere");
  });
});
