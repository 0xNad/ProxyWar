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

interface AccountStub {
  ok: boolean;
  matches?: Array<{ premiereId: string; net: number; revealedAt: string | null }>;
  lifetimePoints?: number;
  rank?: number | null;
  totalRankedParticipants?: number;
}

interface SettlementStub {
  found: boolean;
  outcome?: "winner" | "refunded";
  winnerSeatId?: string | null;
  winnerDisplayName?: string | null;
  placements?: Array<{ seatId: string; displayName: string; placement: 1 | null }>;
  settledAt?: string;
  matchKind?: "real-league" | "exhibition";
  episodeRequestId?: string | null;
  totalParticipants?: number;
}

function stubFetch(account: AccountStub, settlement: SettlementStub = { found: false }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/premieres/account") {
        if (!account.ok) {
          return { ok: false, status: 404, json: async () => ({ error: { code: "PREMIERE_UNAVAILABLE" } }) } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            schemaVersion: 1,
            betting: {
              lifetimePoints: account.lifetimePoints ?? 0,
              rank: account.rank ?? null,
              totalRankedParticipants: account.totalRankedParticipants ?? 0,
              matches: account.matches ?? [],
            },
          }),
        } as Response;
      }
      if (/^\/api\/premieres\/[^/]+\/settlement$/.test(url)) {
        if (!settlement.found) {
          return { ok: false, status: 404, json: async () => ({ error: { code: "SETTLEMENT_NOT_FOUND" } }) } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            schemaVersion: 1,
            settlement: {
              premiereId: "prem_target0000000",
              episodeRequestId: settlement.episodeRequestId ?? null,
              matchKind: settlement.matchKind ?? "exhibition",
              outcome: settlement.outcome ?? "winner",
              winnerSeatId: settlement.winnerSeatId ?? "seat-1",
              winnerDisplayName: settlement.winnerDisplayName ?? "Aggressive Expander",
              placements: settlement.placements ?? [
                { seatId: "seat-1", displayName: "Aggressive Expander", placement: 1 },
                { seatId: "seat-2", displayName: "Defensive Builder", placement: null },
              ],
              settledAt: settlement.settledAt ?? "2026-08-01T00:00:00.000Z",
              totalParticipants: settlement.totalParticipants ?? 4,
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
  it("shows the generic ended message and links to the current live market on the bet surface when the viewer never traded this premiere and no settlement record exists", async () => {
    stubFetch({
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
    // Never claims a winner — no settlement record exists for this id
    // (pre-feature premiere, or wagering off), and this page never
    // fabricates one.
    expect(text.toLowerCase()).not.toContain("winner");
    const cta = el.querySelector<HTMLAnchorElement>("a[href='/bet']");
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("Go to the live market");
  });

  it("shows the viewer's settled net P&L and lifetime points when they traded this exact premiere, with no settlement record", async () => {
    stubFetch({
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
    stubFetch({
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
    stubFetch({ ok: false });
    const el = mount("prem_target0000000", "premiere");
    await flushMicrotasks(20);

    const text = el.textContent ?? "";
    expect(text).toContain("This premiere has ended");
    expect(text).toContain("nothing more is available");
    const cta = el.querySelector<HTMLAnchorElement>("a[href='/league']");
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("Go to the league");
  });

  it("names the winner and collapses placements beyond the visible limit when a settlement record exists", async () => {
    stubFetch(
      { ok: true, matches: [], lifetimePoints: 0, rank: null, totalRankedParticipants: 0 },
      {
        found: true,
        outcome: "winner",
        winnerSeatId: "seat-1",
        winnerDisplayName: "Aggressive Expander",
        placements: [
          { seatId: "seat-1", displayName: "Aggressive Expander", placement: 1 },
          { seatId: "seat-2", displayName: "Defensive Builder", placement: null },
          { seatId: "seat-3", displayName: "Turtle", placement: null },
          { seatId: "seat-4", displayName: "Rusher", placement: null },
          { seatId: "seat-5", displayName: "Diplomat", placement: null },
        ],
        settledAt: "2026-08-01T12:34:00.000Z",
      },
    );
    const el = mount("prem_target0000000", "bet");
    await flushMicrotasks(20);

    const text = el.textContent ?? "";
    expect(text).toContain("Winner");
    expect(text).toContain("Aggressive Expander");
    // Winner + 2 others visible, the remaining 2 collapsed.
    expect(text).toContain("Defensive Builder");
    expect(text).toContain("Turtle");
    expect(text).not.toContain("Rusher");
    expect(text).not.toContain("Diplomat");
    expect(text).toContain("+2 more");
    expect(text).toContain("Settled");
  });

  it("shows the viewer's own settled P&L alongside the named winner when both exist", async () => {
    stubFetch(
      {
        ok: true,
        matches: [{ premiereId: "prem_target0000000", net: 46, revealedAt: "2026-08-01T00:00:00.000Z" }],
        lifetimePoints: 88,
        rank: 2,
        totalRankedParticipants: 15,
      },
      {
        found: true,
        outcome: "winner",
        winnerSeatId: "seat-1",
        winnerDisplayName: "Aggressive Expander",
      },
    );
    const el = mount("prem_target0000000", "bet");
    await flushMicrotasks(20);

    const text = el.textContent ?? "";
    expect(text).toContain("Aggressive Expander");
    expect(text).toContain("Your result");
    expect(text).toContain("+46 points");
  });

  it("honestly reports a refunded market with no winner", async () => {
    stubFetch(
      { ok: true, matches: [], lifetimePoints: 0, rank: null, totalRankedParticipants: 0 },
      {
        found: true,
        outcome: "refunded",
        winnerSeatId: null,
        winnerDisplayName: null,
        placements: [
          { seatId: "seat-1", displayName: "Aggressive Expander", placement: null },
          { seatId: "seat-2", displayName: "Defensive Builder", placement: null },
        ],
      },
    );
    const el = mount("prem_target0000000", "bet");
    await flushMicrotasks(20);

    const text = el.textContent ?? "";
    expect(text).toContain("refunded");
    expect(text.toLowerCase()).not.toContain("winner:");
  });
});
