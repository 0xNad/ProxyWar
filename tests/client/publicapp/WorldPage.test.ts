/**
 * Component coverage for `/world`: the page fetches and validates
 * `world.json`, draws one label per region plus the Crown medallion, names
 * every holder in the legend under the map, lists every front with its form
 * guide, links every battle to its match page, opens a front's history in a
 * dialog (by label, legend or `#front-<id>`), and tells a returning visitor
 * which fronts changed hands. Follows the mount-into-jsdom convention of the
 * other public page tests; the clock is pinned so front states never age.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/WorldPage";
import type { WorldPage } from "../../../src/client/publicapp/WorldPage";
import { worldFixture } from "./WorldFixtures";

const NOW = new Date("2026-09-29T22:10:00.000Z");

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
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
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
  vi.useRealTimers();
});

function legendRow(el: WorldPage, text: string): HTMLLIElement | undefined {
  return [...el.querySelectorAll<HTMLLIElement>(".wp-legend li")].find((row) =>
    row.textContent?.includes(text),
  );
}

function squish(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

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

  it("names every holder under the map, with each front's state in words", async () => {
    const el = mount();
    await settle(el);
    const rows = el.querySelectorAll(".wp-legend li");
    // Two holders, the Crown, then the fronts never fought.
    expect(rows).toHaveLength(4);

    const matt = legendRow(el, "Matt Van");
    expect(squish(matt?.textContent)).toContain(
      "world_page.front_asia (world_page.legend_siege)",
    );
    expect(
      matt
        ?.querySelector<HTMLAnchorElement>("a.wp-legend-name")
        ?.getAttribute("href"),
    ).toBe("/agent/matt-van");
    expect(squish(legendRow(el, "Alpha")?.textContent)).not.toContain(
      "legend_siege",
    );
    expect(legendRow(el, "relh")?.textContent).toContain(
      "world_page.front_crown",
    );
    const open = legendRow(el, "world_page.legend_never_fought");
    expect(open?.querySelectorAll(".wp-legend-front")).toHaveLength(8);
    expect(rows[rows.length - 1]).toBe(open);
  });

  it("opens a front's history from the legend under the map", async () => {
    const el = mount();
    await settle(el);
    const oceania = [
      ...el.querySelectorAll<HTMLButtonElement>(".wp-legend-front"),
    ].find((button) =>
      button.textContent?.includes("world_page.front_oceania"),
    );
    oceania?.click();
    await settle(el);
    expect(window.location.hash).toBe("#front-oceania");
    expect(
      el.querySelector('[role="dialog"] .wp-drawer-title')?.textContent,
    ).toContain("world_page.front_oceania");
  });

  it("keys the map with swatches painted like the map", async () => {
    const el = mount();
    await settle(el);
    const key = el.querySelector(".wp-key");
    expect(key?.textContent).toContain("world_page.key_siege");
    expect(key?.textContent).toContain("world_page.key_open");
    // Nothing has gone quiet yet, so the key does not explain fading.
    expect(key?.textContent).not.toContain("world_page.key_quiet");
    expect(key?.querySelector(".wp-sw")?.getAttribute("style")).toContain(
      "repeating-linear-gradient",
    );
  });

  it("says in words when a front has gone quiet", async () => {
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
    const el = mount();
    await settle(el);
    const oceania = [...el.querySelectorAll(".wp-legend-front")].find(
      (button) => button.textContent?.includes("world_page.front_oceania"),
    );
    expect(squish(oceania?.textContent)).toContain("(world_page.legend_quiet)");
    expect(el.querySelector(".wp-key")?.textContent).toContain(
      "world_page.key_quiet",
    );
  });

  it("writes only #rrggbb colours into style attributes", async () => {
    const base = worldFixture();
    // Twelve agents take the twelve banner colours; the thirteenth keeps
    // its identity colour, which is not trusted.
    const fillers = Array.from({ length: 12 }, (_, index) => ({
      ...base.agents[0],
      name: `Filler ${index}`,
      label: `Filler ${index}`,
      slug: `filler-${index}`,
      theatres: [],
    }));
    const mallory = {
      ...base.agents[0],
      name: "Mallory",
      label: "Mallory",
      slug: "mallory",
      color: "red;background:url(https://tracker.test/x)",
      theatres: [],
    };
    const model = {
      ...base,
      agents: [...base.agents, ...fillers, mallory],
      theatres: base.theatres.map((theatre) =>
        theatre.id === "asia"
          ? {
              ...theatre,
              window: [
                ...theatre.window,
                {
                  episodeRequestId: "ereq_mallory",
                  map: "Asia",
                  winner: "Mallory",
                  at: "2026-09-29T21:30:00.000Z",
                  href: "/match/ereq_mallory",
                },
              ],
            }
          : theatre,
      ),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(model)),
    );
    const el = mount();
    await settle(el);
    const cell = el.querySelector('.wp-form-cell[href="/match/ereq_mallory"]');
    expect(cell?.getAttribute("style")).toBe("--c:#94a3b8");
    const styles = [...el.querySelectorAll("[style]")].map(
      (node) => node.getAttribute("style") ?? "",
    );
    expect(styles.some((style) => style.includes("url("))).toBe(false);
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
