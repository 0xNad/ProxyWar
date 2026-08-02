/**
 * Component coverage for the "this premiere has ended" destination
 * (`Main.ts` mounts it on a `premiere_not_found` bootstrap failure — see
 * that file's `openPremiereEndedPage`). Follows the mount-into-jsdom
 * convention `AccountPage.test.ts` (same directory) already establishes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../../../src/client/prediction/wagering/page/PremiereEndedPage";
import type { PremiereEndedPage } from "../../../../../src/client/prediction/wagering/page/PremiereEndedPage";

function mount(premiereId: string, surface: "bet" | "premiere"): PremiereEndedPage {
  const el = document.createElement("premiere-ended-page") as PremiereEndedPage;
  el.setAttribute("premiere-id", premiereId);
  el.setAttribute("surface", surface);
  document.body.append(el);
  return el;
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function stubAccountFetch(
  response:
    | { ok: true; matches: Array<{ premiereId: string; net: number; revealedAt: string | null }>; lifetimePoints: number; rank: number | null; totalRankedParticipants: number }
    | { ok: false },
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/premieres/account") {
        if (!response.ok) {
          return { ok: false, status: 404, json: async () => ({ error: { code: "PREMIERE_UNAVAILABLE" } }) } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            schemaVersion: 1,
            betting: {
              lifetimePoints: response.lifetimePoints,
              rank: response.rank,
              totalRankedParticipants: response.totalRankedParticipants,
              matches: response.matches,
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("premiere-ended-page", () => {
  it("shows the generic ended message and links to the current live market on the bet surface when the viewer never traded this premiere", async () => {
    stubAccountFetch({
      ok: true,
      matches: [{ premiereId: "prem_other00000000", net: 12, revealedAt: null }],
      lifetimePoints: 40,
      rank: 3,
      totalRankedParticipants: 20,
    });
    const el = mount("prem_target0000000", "bet");
    await flushMicrotasks(20);

    const text = el.textContent ?? "";
    expect(text).toContain("This premiere has ended");
    expect(text).toContain("nothing more is available");
    // Never claims a winner — that data genuinely does not survive a
    // registry reclamation (see the component's own doc).
    expect(text.toLowerCase()).not.toContain("winner");
    const cta = el.querySelector<HTMLAnchorElement>("a[href='/bet']");
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("Go to the live market");
  });

  it("shows the viewer's settled net P&L and lifetime points when they traded this exact premiere", async () => {
    stubAccountFetch({
      ok: true,
      matches: [
        { premiereId: "prem_other00000000", net: -5, revealedAt: null },
        { premiereId: "prem_target0000000", net: 46, revealedAt: "2026-08-01T00:00:00.000Z" },
      ],
      lifetimePoints: 88,
      rank: 2,
      totalRankedParticipants: 15,
    });
    const el = mount("prem_target0000000", "bet");
    await flushMicrotasks(20);

    const text = el.textContent ?? "";
    const normalized = text.replace(/\s+/g, " ").trim();
    expect(text).toContain("+46 points");
    expect(text).toContain("came out ahead");
    expect(text).toContain("88 points");
    expect(normalized).toContain("rank #2 of 15");
    expect(el.querySelector("a[href='/account']")).not.toBeNull();
  });

  it("shows a losing settlement without the positive framing", async () => {
    stubAccountFetch({
      ok: true,
      matches: [{ premiereId: "prem_target0000000", net: -49, revealedAt: null }],
      lifetimePoints: -49,
      rank: null,
      totalRankedParticipants: 15,
    });
    const el = mount("prem_target0000000", "bet");
    await flushMicrotasks(20);

    const text = el.textContent ?? "";
    expect(text).toContain("-49 points");
    expect(text).toContain("didn't go your way");
  });

  it("degrades to the generic honest message when the account endpoint is unavailable (non-wagering origin)", async () => {
    stubAccountFetch({ ok: false });
    const el = mount("prem_target0000000", "premiere");
    await flushMicrotasks(20);

    const text = el.textContent ?? "";
    expect(text).toContain("This premiere has ended");
    expect(text).toContain("nothing more is available");
    const cta = el.querySelector<HTMLAnchorElement>("a[href='/league']");
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("Go to the league");
  });
});
