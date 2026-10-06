import { vi } from "vitest";
import "../../../src/client/publicapp/WorldPage";
import type { WorldPage } from "../../../src/client/publicapp/WorldPage";

/**
 * Mounting `<world-page>` in jsdom for the Season 2 tests: stubbed
 * `world.json` and `frontier-form.json`, an in-memory `localStorage`, and
 * the page's text as a reader sees it.
 */

export function memoryStorage(): Storage {
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

/** `world.json` and `frontier-form.json` by path; `null` form is a 404. */
export function serve(world: unknown, form: unknown = null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/frontier-form.json")) {
        return form === null
          ? new Response("artifact not available", { status: 404 })
          : Response.json(form);
      }
      return Response.json(world);
    }),
  );
}

export function mount(): WorldPage {
  const el = document.createElement("world-page") as WorldPage;
  document.body.append(el);
  return el;
}

export async function settle(el: WorldPage): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await el.updateComplete;
  }
}

/** Visible text, whitespace collapsed, decorative parts left out. */
export function text(el: Element | null | undefined): string {
  if (el === null || el === undefined) return "";
  const copy = el.cloneNode(true) as Element;
  copy
    .querySelectorAll('[aria-hidden="true"]')
    .forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A Nerf Watch card by the model's shown name. */
export function card(el: WorldPage, name: string): Element | undefined {
  return [...el.querySelectorAll(".wp-form-card")].find(
    (entry) => text(entry.querySelector(".wp-form-name")) === name,
  );
}
