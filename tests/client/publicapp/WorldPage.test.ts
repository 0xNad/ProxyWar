/**
 * Component coverage for `/world`: the page fetches and validates
 * `world.json`, draws one label per region plus the Crown medallion, names
 * every holder in the legend under the map, lists every front as a row with
 * its state, race and last battles, tells every event as a sentence linked
 * to its battle, opens a front's history in a dialog (by label, legend, row
 * or `#front-<id>`), and tells a returning visitor which fronts changed
 * hands. Follows the mount-into-jsdom convention of the other public page
 * tests, with the real English strings and a pinned clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldModel } from "../../../src/client/publicapp/WorldModelSchema";
import "../../../src/client/publicapp/WorldPage";
import type { WorldPage } from "../../../src/client/publicapp/WorldPage";
import { installEnglish, removeEnglish } from "./EnglishLangSelector";
import { worldFixture } from "./WorldFixtures";

/** The fixture's moment: 23 minutes after its newest battle. */
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

function serve(model: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(model)),
  );
}

async function settle(el: WorldPage): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await el.updateComplete;
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The text a screen reader gets: decoration marked `aria-hidden` is left out. */
function text(el: Element | null | undefined): string {
  if (el === null || el === undefined) return "";
  const copy = el.cloneNode(true) as Element;
  copy
    .querySelectorAll('[aria-hidden="true"]')
    .forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function find<T extends Element>(
  el: WorldPage,
  selector: string,
  content: string,
): T | undefined {
  return [...el.querySelectorAll<T>(selector)].find((node) =>
    text(node).includes(content),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.stubGlobal("localStorage", memoryStorage());
  installEnglish();
  window.history.replaceState(null, "", "/world");
  serve(worldFixture());
});

afterEach(() => {
  document.body.innerHTML = "";
  removeEnglish();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    const labels = el.querySelectorAll(".wp-label");
    expect(labels).toHaveLength(10);
    const asia = find<HTMLElement>(el, ".wp-label", "Asia");
    expect(asia?.dataset.state).toBe("contested");
    expect(text(asia)).toBe("Asia (under siege) Matt Van");
    expect(text(el.querySelector(".wp-crown"))).toContain("relh");

    expect(el.querySelectorAll(".wp-row")).toHaveLength(11);
    expect(el.querySelectorAll(".wp-dispatch")).toHaveLength(2);
    expect(el.querySelectorAll(".wp-powers tbody tr").length).toBeGreaterThan(
      2,
    );
    expect(
      el.querySelector('.wp-powers a[href="/agent/matt-van"]'),
    ).not.toBeNull();
  });

  it("lists every front as a row: its state in words, the race and its last battles", async () => {
    const el = mount();
    await settle(el);
    const rows = [...el.querySelectorAll<HTMLElement>(".wp-row")];
    // The Crown first, then sieges first and unclaimed fronts last.
    expect(text(rows[0].querySelector(".wp-row-name"))).toBe("The Crown");
    expect(rows[1].dataset.state).toBe("contested");
    expect(rows[rows.length - 1].dataset.state).toBe("unclaimed");

    const asia = rows[1];
    expect(text(asia.querySelector(".wp-row-front"))).toBe("Asia Under siege");
    expect(text(asia.querySelector(".wp-row-holder"))).toBe(
      "Matt Van since Sep 28 relh is level at 2 wins each",
    );
    expect(text(asia.querySelector(".wp-row-last"))).toContain(
      "795 battles fought",
    );
    const strip = asia.querySelector(".wp-strip");
    expect(strip?.getAttribute("aria-label")).toBe(
      "The last 5 battles: Matt Van won 2, relh won 2, and 1 with no winner",
    );
    // Twelve cells: seven not yet fought, then the five battles, oldest first.
    expect(strip?.querySelectorAll("i")).toHaveLength(12);
    expect(strip?.querySelectorAll(".wp-strip-empty")).toHaveLength(7);
    expect(strip?.querySelectorAll(".wp-strip-none")).toHaveLength(1);

    const oceania = find<HTMLElement>(el, ".wp-row", "Oceania");
    expect(text(oceania?.querySelector(".wp-row-holder"))).toBe(
      "Alpha since Sep 29 Leads Matt Van, 3 wins to 1",
    );
    expect(text(rows[rows.length - 1].querySelector(".wp-row-holder"))).toBe(
      "No battles yet",
    );
  });

  it("opens a front's history from its row", async () => {
    const el = mount();
    await settle(el);
    const row = find<HTMLElement>(el, ".wp-row", "Oceania");
    expect(row?.querySelector(".wp-row-hit")?.getAttribute("aria-label")).toBe(
      "Open Oceania",
    );
    row?.querySelector<HTMLButtonElement>(".wp-row-hit")?.click();
    await settle(el);
    expect(window.location.hash).toBe("#front-oceania");
    expect(text(el.querySelector('[role="dialog"] h2'))).toBe("Oceania");
  });

  it("tells each event as a sentence and links the whole row to its battle", async () => {
    const el = mount();
    await settle(el);
    const [siege, conquest] = [
      ...el.querySelectorAll<HTMLAnchorElement>(".wp-dispatch"),
    ];
    expect(siege.getAttribute("href")).toBe("/match/ereq_asia5");
    expect(text(siege.querySelector(".wp-dispatch-text"))).toBe(
      "relh put Asia under siege: 2 wins each with Matt Van.",
    );
    expect(siege.getAttribute("aria-label")).toBe(
      "Watch the battle: relh put Asia under siege: 2 wins each with Matt Van.",
    );
    // Not fought on the front's namesake map, so the map is named.
    expect(text(conquest.querySelector(".wp-dispatch-text"))).toBe(
      "relh took the Crown from Andre von Houck on Pangaea, 4 wins to 3.",
    );
    expect(text(el.querySelector(".wp-panel-intro"))).toBe(
      "Scores count wins in the front's last 12 battles.",
    );
  });

  it("opens a front's history from its label, says how it is held, and closes with Escape", async () => {
    const el = mount();
    await settle(el);
    find<HTMLButtonElement>(el, ".wp-label", "Asia")?.click();
    await settle(el);

    const dialog = el.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(window.location.hash).toBe("#front-asia");
    expect(
      [...el.querySelectorAll(".wp-drawer-since")].map((line) => text(line)),
    ).toEqual(["Held since Sep 28", "3 of 9 battles won since then"]);
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
    // Two holders, the Crown, then the unclaimed fronts.
    expect(rows).toHaveLength(4);

    const matt = find<HTMLLIElement>(el, ".wp-legend li", "Matt Van");
    expect(text(matt)).toBe("Matt Van Asia (under siege)");
    expect(matt?.querySelector("a.wp-legend-name")?.getAttribute("href")).toBe(
      "/agent/matt-van",
    );
    expect(text(find(el, ".wp-legend li", "Alpha"))).toBe("Alpha Oceania");
    expect(text(find(el, ".wp-legend li", "relh"))).toBe("relh The Crown");
    const open = rows[rows.length - 1];
    expect(text(open)).toContain("Unclaimed");
    expect(open.querySelectorAll(".wp-legend-front")).toHaveLength(8);
  });

  it("opens a front's history from the legend under the map", async () => {
    const el = mount();
    await settle(el);
    find<HTMLButtonElement>(el, ".wp-legend-front", "Oceania")?.click();
    await settle(el);
    expect(window.location.hash).toBe("#front-oceania");
    expect(text(el.querySelector('[role="dialog"] h2'))).toBe("Oceania");
  });

  it("keys the map with swatches painted like the map", async () => {
    const el = mount();
    await settle(el);
    const key = el.querySelector(".wp-key");
    expect(text(key)).toBe("Hatched: under siege (tied) Slate: unclaimed");
    expect(key?.querySelector(".wp-sw")?.getAttribute("style")).toContain(
      "repeating-linear-gradient",
    );
  });

  it("says in words when a front has gone quiet", async () => {
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
    const el = mount();
    await settle(el);
    expect(text(find(el, ".wp-legend-front", "Oceania"))).toBe(
      "Oceania (quiet)",
    );
    expect(text(el.querySelector(".wp-key"))).toContain(
      "Faded: no battle for 14+ days",
    );
    expect(find(el, ".wp-label", "Oceania")?.getAttribute("aria-label")).toBe(
      "Oceania: held by Alpha, quiet since Sep 29. Open front.",
    );
    expect(
      text(find(el, ".wp-row", "Oceania")?.querySelector(".wp-row-state")),
    ).toBe("Quiet");
  });

  it("says a front whose battles all ended without a winner has no winner yet", async () => {
    const base = worldFixture();
    const battle = (id: string, at: string) => ({
      episodeRequestId: id,
      map: "Africa",
      winner: null,
      at,
      href: `/match/${id}`,
    });
    serve({
      ...base,
      theatres: base.theatres.map((theatre) =>
        theatre.id === "africa"
          ? {
              ...theatre,
              battleCount: 3,
              lastBattleAt: "2026-09-29T20:00:00.000Z",
              window: [
                battle("ereq_af1", "2026-09-29T18:00:00.000Z"),
                battle("ereq_af2", "2026-09-29T19:00:00.000Z"),
                battle("ereq_af3", "2026-09-29T20:00:00.000Z"),
              ],
            }
          : theatre,
      ),
    } satisfies WorldModel);
    const el = mount();
    await settle(el);
    const row = find<HTMLElement>(el, ".wp-row", "Africa");
    expect(text(row?.querySelector(".wp-row-holder"))).toBe(
      "3 battles, no winner yet",
    );
    expect(row?.querySelector(".wp-strip")?.getAttribute("aria-label")).toBe(
      "The last 3 battles: 3 with no winner",
    );
    expect(text(find(el, ".wp-label", "Africa"))).toBe(
      "Africa 3 battles, no winner yet",
    );
    row?.querySelector<HTMLButtonElement>(".wp-row-hit")?.click();
    await settle(el);
    expect(text(el.querySelector(".wp-drawer .wp-front-empty"))).toBe(
      "3 battles have been fought on its maps (Africa), none with a winner. The first win there claims it.",
    );
  });

  it("writes only #rrggbb colours into style attributes", async () => {
    const base = worldFixture();
    // Twelve agents take the twelve banner colours; the next keeps its
    // identity colour, which is not trusted.
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
    serve({
      ...base,
      agents: [...base.agents, ...fillers, mallory],
      events: [
        {
          kind: "conquest",
          theatreId: "oceania",
          at: "2026-09-29T21:50:00.000Z",
          episodeRequestId: "ereq_mallory",
          map: "Oceania",
          agent: "Mallory",
          rival: "Alpha",
          agentWins: 4,
          rivalWins: 3,
          href: "/match/ereq_mallory",
        },
        ...base.events,
      ],
    } satisfies WorldModel);
    const el = mount();
    await settle(el);
    const chip = el.querySelector(
      '.wp-dispatch[href="/match/ereq_mallory"] .wp-dispatch-chip',
    );
    expect(chip?.getAttribute("style")).toBe("--chip:#94a3b8");
    const styles = [...el.querySelectorAll("[style]")].map(
      (node) => node.getAttribute("style") ?? "",
    );
    expect(styles.some((style) => style.includes("url("))).toBe(false);
  });

  it("opens the front named in the URL hash", async () => {
    window.history.replaceState(null, "", "/world#front-crown");
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-drawer-title"))).toBe("The Crown");
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
    expect(text(el.querySelector(".wp-label[data-changed]"))).toContain("Asia");
    // The visit is recorded for next time.
    const stored = JSON.parse(
      localStorage.getItem("proxywar.world.lastVisit") ?? "{}",
    );
    expect(stored.holders.asia).toBe("Matt Van");
  });

  it("shows a retryable error when world.json cannot be loaded or fails validation", async () => {
    serve({ schemaVersion: 2 });
    const el = mount();
    await settle(el);
    expect(text(el.querySelector('[role="alert"]'))).toContain(
      "The world map could not be loaded.",
    );
    expect(el.querySelector(".wp-stage")).toBeNull();
  });
});
