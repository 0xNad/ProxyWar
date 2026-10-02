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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WorldModel } from "../../../src/client/publicapp/WorldModelSchema";
import "../../../src/client/publicapp/WorldPage";
import type { WorldPage } from "../../../src/client/publicapp/WorldPage";
import { installEnglish, removeEnglish } from "./EnglishLangSelector";
import { worldFixture } from "./WorldFixtures";

/** The fixture's moment: 23 minutes after its newest battle. */
const NOW = new Date("2026-09-29T22:10:00.000Z");

// Days, dates and times are the visitor's; pin the visitor to UTC so the
// assertions hold on any machine (each test file runs in its own process).
const ZONE = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (ZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE;
});

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
    // The front page's placards: held fronts tagged, unclaimed ones lettered.
    const labels = el.querySelectorAll(".hp-mark, .hp-open");
    expect(labels).toHaveLength(10);
    const asia = find<HTMLElement>(el, ".hp-mark", "Asia");
    expect(asia?.dataset.state).toBe("contested");
    expect(text(asia)).toBe("Matt Van Asia, under siege relh drew level, 2–2");
    expect(asia?.getAttribute("aria-label")).toBe(
      "Asia: held by Matt Van, under siege by relh. Open front.",
    );
    expect(text(el.querySelector(".hp-seal"))).toContain("relh");
    // Ages read the same as on the front page.
    expect(text(el.querySelector(".wp-feed"))).toBe(
      "Live Last battle 22 min ago",
    );

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
    // Grouped by the visitor's day.
    expect(
      [...el.querySelectorAll(".wp-dispatch-day")].map((day) => text(day)),
    ).toEqual(["Today", "Yesterday"]);
  });

  it("explains the Powers table and links each holding like the legend", async () => {
    const el = mount();
    await settle(el);
    const powers = el.querySelector(".wp-powers")?.closest("section");
    expect(text(powers?.querySelector(".wp-panel-intro"))).toBe(
      "Conquests are fronts taken from their holder. Wins are battles won on the world's maps. Both count since Jul 17.",
    );
    const row = (name: string) =>
      [...el.querySelectorAll(".wp-powers tbody tr")].find((tr) =>
        text(tr.querySelector("th")).includes(name),
      );
    expect(text(row("Matt Van")?.querySelector(".wp-power-fronts"))).toBe(
      "Asia (under siege)",
    );
    // The Crown is a holding like any other, not an unlabelled icon.
    expect(text(row("relh")?.querySelector(".wp-power-fronts"))).toBe(
      "The Crown",
    );
    expect(
      [...(row("Matt Van")?.querySelectorAll(".wp-num") ?? [])].map((cell) =>
        text(cell),
      ),
    ).toEqual(["250", "1,564"]);
    row("Matt Van")
      ?.querySelector<HTMLButtonElement>(".wp-legend-front")
      ?.click();
    await settle(el);
    expect(window.location.hash).toBe("#front-asia");
  });

  it("opens a front's history from its label, says how it is held, and closes with Escape", async () => {
    const el = mount();
    await settle(el);
    find<HTMLButtonElement>(el, ".hp-mark", "Asia")?.click();
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
    // Every battle here was on the Asia map, so no row repeats it.
    expect(el.querySelector(".wp-battle-map")).toBeNull();
    expect(
      [...el.querySelectorAll(".wp-reign-span")].map((span) => text(span)),
    ).toEqual(["Sep 28 – now", "Sep 25 – Sep 28"]);
    // The front's own strip and its day-by-day reigns, as on the page.
    expect(
      el.querySelector(".wp-drawer .wp-strip")?.getAttribute("aria-label"),
    ).toBe(
      "The last 5 battles: Matt Van won 2, relh won 2, and 1 with no winner",
    );
    const solo = el.querySelector(".wp-drawer .wp-tl-solo");
    expect(solo?.getAttribute("aria-hidden")).toBe("true");
    expect(
      [...(solo?.querySelectorAll(".wp-tl-run") ?? [])].map((run) => text(run)),
    ).toEqual(["Alpha", "Matt Van"]);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle(el);
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("dates a reign within one day once, and names maps only when they differ", async () => {
    const model = worldFixture();
    const asia = model.theatres.find((theatre) => theatre.id === "asia")!;
    serve({
      ...model,
      theatres: model.theatres.map((theatre) =>
        theatre !== asia
          ? theatre
          : {
              ...asia,
              reigns: asia.reigns.map((reign) =>
                reign.to === null
                  ? reign
                  : { ...reign, from: "2026-09-28T02:00:00.000Z" },
              ),
              window: asia.window.map((battle, index) =>
                index === 0 ? { ...battle, map: "Baikal" } : battle,
              ),
            },
      ),
    });
    window.history.replaceState(null, "", "/world#front-asia");
    const el = mount();
    await settle(el);
    expect(
      [...el.querySelectorAll(".wp-reign-span")].map((span) => text(span)),
    ).toEqual(["Sep 28 – now", "Sep 28"]);
    expect(
      [...el.querySelectorAll(".wp-battle-map")].map((map) => text(map)),
    ).toEqual(["Asia", "Asia", "Asia", "Asia", "Baikal"]);
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
    expect(key?.tagName).toBe("UL");
    expect(key?.getAttribute("aria-label")).toBe("How to read the map");
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
    expect(find(el, ".hp-mark", "Oceania")?.getAttribute("aria-label")).toBe(
      "Oceania: held by Alpha, quiet since Sep 29. Open front.",
    );
    expect(
      text(find(el, ".wp-row", "Oceania")?.querySelector(".wp-row-state")),
    ).toBe("Quiet");
    // A tie that has gone quiet is still a tie, not a lead.
    const asia = find<HTMLElement>(el, ".wp-row", "Asia");
    expect(text(asia?.querySelector(".wp-row-state"))).toBe("Quiet");
    expect(text(asia?.querySelector(".wp-row-race"))).toBe(
      "relh is level at 2 wins each",
    );
  });

  it("keeps its clock running when world.json stops changing, and says when the feed pauses", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval"],
      now: NOW,
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-feed"))).toBe(
      "Live Last battle 22 min ago",
    );
    vi.setSystemTime(new Date("2026-09-30T03:10:00.000Z"));
    vi.advanceTimersByTime(30_000);
    await settle(el);
    expect(text(el.querySelector(".wp-feed"))).toBe(
      "Paused Last battle 5 h ago. The map moves again when battles do.",
    );
    visibility.mockRestore();
  });

  it("names the Crown's siege in the headline numbers, and lists tied leaders in words", async () => {
    const base = worldFixture();
    serve({
      ...base,
      theatres: base.theatres.map((theatre) => {
        if (theatre.id === "crown") {
          return {
            ...theatre,
            status: "contested" as const,
            challenger: "Andre von Houck",
            challengerWins: 4,
          };
        }
        if (theatre.id === "europe") {
          return { ...theatre, status: "held" as const, holder: "Matt Van" };
        }
        if (theatre.id === "africa") {
          return { ...theatre, status: "held" as const, holder: "Alpha" };
        }
        return theatre;
      }),
    } satisfies WorldModel);
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-stat-crown"))).toBe(
      "Crown: relh, under siege",
    );
    expect(text(el.querySelector("h1"))).toBe(
      "Alpha and Matt Van share the lead",
    );
    expect(document.title).toBe("The World · Proxy War");
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
    expect(text(find(el, ".hp-open", "Africa"))).toBe(
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

  it("shows who held each front each day, and steps through the days by keyboard", async () => {
    const el = mount();
    await settle(el);
    // One row per front, the Crown first; long reigns are named on the bar.
    expect(
      [...el.querySelectorAll(".wp-tl-front")].map((label) => text(label)),
    ).toEqual([
      "The Crown",
      "North America",
      "South America",
      "Britannia",
      "Europe",
      "Black Sea",
      "Middle East",
      "Africa",
      "Asia",
      "East Asia",
      "Oceania",
    ]);
    const asia = el.querySelector('.wp-tl-bar[data-front="asia"]');
    expect(
      [...(asia?.querySelectorAll(".wp-tl-run") ?? [])].map((run) => [
        text(run),
        run.getAttribute("style")?.match(/flex-grow:(\d+)/)?.[1],
      ]),
    ).toEqual([
      ["Alpha", "1"],
      ["Matt Van", "2"],
    ]);
    // A front no one has held yet says so; it stays slate.
    expect(
      text(el.querySelector('.wp-tl-bar[data-front="africa"] .wp-tl-open')),
    ).toBe("Unclaimed");

    const grid = el.querySelector<HTMLElement>('.wp-tl [role="slider"]');
    expect(grid?.getAttribute("tabindex")).toBe("0");
    expect(grid?.getAttribute("aria-valuetext")).toBe(
      "Sep 29: the Crown held by relh, Asia held by Matt Van, and Oceania held by Alpha",
    );
    grid?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await settle(el);
    expect(grid?.getAttribute("aria-valuenow")).toBe("0");
    const day =
      "Sep 27: the Crown held by Andre von Houck, Asia held by Alpha, and Oceania held by Alpha";
    expect(grid?.getAttribute("aria-valuetext")).toBe(day);
    expect(text(el.querySelector(".wp-tl-readout"))).toBe(day);
    grid?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await settle(el);
    expect(grid?.getAttribute("aria-valuenow")).toBe("1");
  });

  it("labels league days by their UTC date in any time zone, and a front never held as such", async () => {
    process.env.TZ = "Pacific/Auckland";
    try {
      const el = mount();
      await settle(el);
      const grid = el.querySelector<HTMLElement>('.wp-tl [role="slider"]');
      // Sep 29 is the league's day even where it is already Sep 30.
      expect(grid?.getAttribute("aria-valuetext")).toMatch(/^Sep 29: /);
      const africa = el.querySelector<HTMLElement>(
        '.wp-tl-bar[data-front="africa"]',
      );
      if (africa === null) throw new Error("no Africa bar");
      africa.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 300, height: 22 }) as DOMRect;
      africa
        .querySelector(".wp-tl-run")
        ?.dispatchEvent(
          new MouseEvent("pointermove", { clientX: 150, bubbles: true }),
        );
      await settle(el);
      expect(text(africa.querySelector(".wp-tl-tip"))).toBe(
        "No one has held Africa yet",
      );
    } finally {
      process.env.TZ = "UTC";
    }
  });

  it("keeps a pointed placard's own front lit, not the land under it", async () => {
    const el = mount();
    await settle(el);
    const page = el as unknown as { hoverFront: string | null };
    const asia = find<HTMLButtonElement>(el, ".hp-mark", "Asia");
    asia?.dispatchEvent(new MouseEvent("pointerenter"));
    asia?.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 1, clientY: 1, bubbles: true }),
    );
    await settle(el);
    expect(page.hoverFront).toBe("asia");
  });

  it("names the Crown's siege for screen readers", async () => {
    const base = worldFixture();
    serve({
      ...base,
      theatres: base.theatres.map((theatre) =>
        theatre.id === "crown"
          ? {
              ...theatre,
              status: "contested" as const,
              challenger: "Andre von Houck",
              challengerWins: 4,
            }
          : theatre,
      ),
    } satisfies WorldModel);
    const el = mount();
    await settle(el);
    expect(el.querySelector(".hp-seal")?.getAttribute("aria-label")).toBe(
      "The Crown, held by relh, under siege by Andre von Houck. Open its history.",
    );
    expect(text(el.querySelector(".hp-seal .hp-mark-siege"))).toBe(
      "Andre von Houck drew level, 4–4",
    );
  });

  it("names the reign under the pointer", async () => {
    const el = mount();
    await settle(el);
    const bar = el.querySelector<HTMLElement>('.wp-tl-bar[data-front="asia"]');
    if (bar === null) throw new Error("no Asia bar");
    bar.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 300, height: 22 }) as DOMRect;
    // Three days across 300 px: x = 250 is the last day, inside Matt Van's
    // reign, which is still going.
    bar
      .querySelector(".wp-tl-run")
      ?.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 250, bubbles: true }),
      );
    await settle(el);
    expect(text(bar.querySelector(".wp-tl-tip"))).toBe(
      "Matt Van has held Asia since Sep 28",
    );
    expect(bar.querySelector(".wp-tl-pointed")?.textContent).toContain(
      "Matt Van",
    );
    bar
      .querySelector(".wp-tl-run")
      ?.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 10, bubbles: true }),
      );
    await settle(el);
    expect(text(bar.querySelector(".wp-tl-tip"))).toBe(
      "Alpha held Asia on Sep 27",
    );
  });

  it("tells assistive tech that a front opens a dialog, and keeps Tab inside it", async () => {
    const el = mount();
    await settle(el);
    for (const selector of [
      ".hp-mark",
      ".hp-seal",
      ".wp-legend-front",
      ".wp-row-hit",
    ]) {
      expect(el.querySelector(selector)?.getAttribute("aria-haspopup")).toBe(
        "dialog",
      );
    }
    find<HTMLButtonElement>(el, ".wp-legend-front", "Asia")?.click();
    await settle(el);
    const sheet = el.querySelector<HTMLElement>('[role="dialog"]');
    const close = el.querySelector<HTMLButtonElement>(".wp-drawer-close");
    const links = sheet?.querySelectorAll<HTMLElement>("a[href]") ?? [];
    const last = links[links.length - 1];
    expect(document.activeElement).toBe(close);
    last.focus();
    sheet?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(document.activeElement).toBe(close);
    sheet?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(document.activeElement).toBe(last);
  });

  it("slides the sheet in only where someone can watch it", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    window.history.replaceState(null, "", "/world#front-asia");
    let el = mount();
    await settle(el);
    // A hidden tab runs no animation clock: the sheet must simply be there.
    expect(el.querySelector(".wp-drawer")?.classList).not.toContain(
      "wp-drawer-enter",
    );
    el.remove();
    visibility.mockReturnValue("visible");
    window.history.replaceState(null, "", "/world");
    el = mount();
    await settle(el);
    find<HTMLButtonElement>(el, ".hp-mark", "Asia")?.click();
    await settle(el);
    expect(el.querySelector(".wp-drawer")?.classList).toContain(
      "wp-drawer-enter",
    );
    visibility.mockRestore();
  });

  it("opens the front named in the URL hash", async () => {
    window.history.replaceState(null, "", "/world#front-crown");
    const el = mount();
    await settle(el);
    expect(text(el.querySelector(".wp-drawer-title"))).toBe("The Crown");
    // No recorded reigns yet, but the day-by-day bar still shows who held it.
    expect(
      [...el.querySelectorAll(".wp-drawer .wp-tl-solo .wp-tl-run")].map((run) =>
        text(run),
      ),
    ).toEqual(["Andre von Houck", "relh"]);
    // Focus moves into the sheet, as when it is opened by a click.
    expect(document.activeElement).toBe(el.querySelector(".wp-drawer-close"));
    expect(text(el.querySelector(".wp-drawer-maps"))).toBe(
      "Fought on Pangaea (9,396 battles) and World (1,316 battles)",
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
    expect(text(el.querySelector(".hp-mark[data-changed]"))).toContain("Asia");
    // The visit is recorded for next time.
    const stored = JSON.parse(
      localStorage.getItem("proxywar.world.lastVisit") ?? "{}",
    );
    expect(stored.holders.asia).toBe("Matt Van");
  });

  it("refuses a world.json whose battle link points anywhere but /match/", async () => {
    const base = worldFixture();
    for (const href of [
      "javascript:alert(1)",
      "https://elsewhere.test/match/x",
      "//elsewhere.test/match/x",
    ]) {
      serve({
        ...base,
        events: base.events.map((event) => ({ ...event, href })),
      } satisfies WorldModel);
      const el = mount();
      await settle(el);
      expect(text(el.querySelector('[role="alert"]'))).toContain(
        "The world map could not be loaded.",
      );
      expect(el.querySelector(`a[href="${href}"]`)).toBeNull();
      el.remove();
    }
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
