/**
 * Component coverage for `/world`: the page fetches and validates
 * `world.json`, draws one label per region plus the Crown medallion, lists
 * every front with its form guide, links every battle to its match page,
 * opens a front's history in a dialog (by label or `#front-<id>`), and
 * tells a returning visitor which fronts changed hands. Follows the
 * mount-into-jsdom convention of the other public page tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/WorldPage";
import type { WorldPage } from "../../../src/client/publicapp/WorldPage";
import { worldFixture } from "./WorldFixtures";

function mount(): WorldPage {
  const el = document.createElement("world-page") as WorldPage;
  document.body.append(el);
  return el;
}

/** In-memory `localStorage` — independent of whether the Node/jsdom pair provides one. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
  };
}

async function settle(el: WorldPage): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await el.updateComplete;
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  window.history.replaceState(null, "", "/world");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(worldFixture())),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("world-page", () => {
  it("fetches world.json and renders the map, labels, Crown, fronts, dispatches and powers", async () => {
    const el = mount();
    await settle(el);

    expect(fetch).toHaveBeenCalledWith(
      "/ai-league-runs/league/world.json",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(el.querySelector("canvas.wp-map")).not.toBeNull();
    const labels = [...el.querySelectorAll<HTMLElement>(".wp-label")];
    expect(labels).toHaveLength(10);
    const asia = labels.find((label) =>
      label.textContent?.includes("world_page.front_asia"),
    );
    expect(asia?.dataset.state).toBe("contested");
    expect(asia?.textContent).toContain("Matt Van");
    expect(el.querySelector(".wp-crown")?.textContent).toContain("relh");

    const fronts = el.querySelectorAll(".wp-front");
    expect(fronts).toHaveLength(11);
    expect(fronts[0].classList.contains("wp-front-crown")).toBe(true);
    // Contested fronts lead the list, unclaimed fronts come last.
    expect((fronts[1] as HTMLElement).dataset.state).toBe("contested");
    expect((fronts[fronts.length - 1] as HTMLElement).dataset.state).toBe(
      "unclaimed",
    );

    const formLinks = [
      ...el.querySelectorAll<HTMLAnchorElement>(".wp-form-cell"),
    ];
    expect(formLinks.map((a) => a.getAttribute("href"))).toContain(
      "/match/ereq_asia5",
    );
    expect(el.querySelectorAll(".wp-dispatch")).toHaveLength(2);
    expect(
      el
        .querySelector<HTMLAnchorElement>(".wp-dispatch-link")
        ?.getAttribute("href"),
    ).toBe("/match/ereq_asia5");
    const powerRows = el.querySelectorAll(".wp-powers tbody tr");
    expect(powerRows.length).toBeGreaterThanOrEqual(3);
    expect(
      el.querySelector<HTMLAnchorElement>(
        '.wp-powers a[href="/agent/matt-van"]',
      ),
    ).not.toBeNull();
  });

  it("opens a front's history from its label and closes it with Escape", async () => {
    const el = mount();
    await settle(el);
    const asia = [...el.querySelectorAll<HTMLButtonElement>(".wp-label")].find(
      (label) => label.textContent?.includes("world_page.front_asia"),
    );
    asia?.click();
    await settle(el);

    const dialog = el.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(window.location.hash).toBe("#front-asia");
    const battles = [...el.querySelectorAll<HTMLAnchorElement>(".wp-battle")];
    expect(battles).toHaveLength(5);
    // Newest first.
    expect(battles[0].getAttribute("href")).toBe("/match/ereq_asia5");
    expect(el.querySelectorAll(".wp-reigns li")).toHaveLength(2);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle(el);
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("opens the front named in the URL hash", async () => {
    window.history.replaceState(null, "", "/world#front-crown");
    const el = mount();
    await settle(el);
    expect(el.querySelector(".wp-drawer-title")?.textContent).toContain(
      "world_page.front_crown",
    );
  });

  it("tells a returning visitor which fronts changed hands", async () => {
    localStorage.setItem(
      "proxywar.world.lastVisit",
      JSON.stringify({
        at: "2026-09-27T00:00:00.000Z",
        holders: { asia: "Alpha", oceania: "Alpha", crown: "relh" },
      }),
    );
    const el = mount();
    await settle(el);
    const banner = el.querySelector(".wp-since");
    expect(banner).not.toBeNull();
    expect(banner?.querySelectorAll(".wp-since-front")).toHaveLength(1);
    expect(
      el.querySelector<HTMLElement>(".wp-label[data-changed]")?.textContent,
    ).toContain("world_page.front_asia");
    // The visit is recorded for next time.
    const stored = JSON.parse(
      localStorage.getItem("proxywar.world.lastVisit") ?? "{}",
    );
    expect(stored.holders.asia).toBe("Matt Van");
  });

  it("shows a retryable error when world.json cannot be loaded or fails validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ schemaVersion: 2 })),
    );
    const el = mount();
    await settle(el);
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("world_page.error");
    expect(el.querySelector(".wp-stage")).toBeNull();
  });
});
