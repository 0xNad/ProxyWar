/**
 * Component coverage for the account page's claim SET UI: claiming a
 * second lineage keeps the first, removing one leaves the other, and the
 * picker never re-offers an already-claimed lineage. Follows the
 * mount-into-jsdom convention in components.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/platform/AccountPage";
import type { PremiereAccountPage } from "../../../src/client/platform/AccountPage";
import { resetLeagueDataCacheForTests } from "../../../src/client/platform/LeagueData";

function mount(): PremiereAccountPage {
  const el = document.createElement(
    "premiere-account-page",
  ) as PremiereAccountPage;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

interface AccountClaim {
  lineageSlug: string;
  label: string;
  claimedAt: string;
  updatedAt: string;
}

function claim(lineageSlug: string, label = `${lineageSlug}:v1`): AccountClaim {
  return {
    lineageSlug,
    label,
    claimedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function leagueData(
  standings: readonly { playerName: string; policyLabel: string }[],
) {
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    lastGoodSyncAt: "2026-07-01T00:00:00.000Z",
    stale: false,
    standings: standings.map((s, i) => ({
      rank: i + 1,
      playerName: s.playerName,
      ratingPolicyLabel: null,
      activeChampionPolicyLabel: null,
      policyLabel: s.policyLabel,
      score: 1000 - i,
      roundsPlayed: 10,
      isHouse: false,
    })),
    episodes: [],
  };
}

/** Routes a stubbed global fetch by request URL/method — the account page hits `/api/account`, `/api/account/claim`, `/api/account/claim/remove`, and the league data JSON, all via the global `fetch`. */
function stubFetch(
  state: { claims: AccountClaim[] },
  standings: unknown[],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/ai-league-runs/league/data.json")) {
        return {
          ok: true,
          json: async () => leagueData(standings as never),
        } as Response;
      }
      if (url === "/api/account" && (init?.method ?? "GET") === "GET") {
        return {
          ok: true,
          json: async () => ({
            schemaVersion: 1,
            csrfToken: "csrf-token",
            identity: {
              accountId: "acct_" + "a".repeat(32),
              displayName: null,
              githubLogin: null,
              githubAvatarUrl: null,
            },
            claims: state.claims,
          }),
        } as Response;
      }
      if (url === "/api/account/claim" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { label: string };
        const lineageSlug = body.label.replace(/:v\d+$/i, "");
        const existingIndex = state.claims.findIndex(
          (c) => c.lineageSlug === lineageSlug,
        );
        const newClaim = claim(lineageSlug, body.label);
        if (existingIndex === -1) {
          state.claims = [...state.claims, newClaim];
        } else {
          state.claims = state.claims.map((c, i) =>
            i === existingIndex ? newClaim : c,
          );
        }
        return {
          ok: true,
          json: async () => ({ schemaVersion: 1, claims: state.claims }),
        } as Response;
      }
      if (url === "/api/account/claim/remove" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { lineageSlug: string };
        state.claims = state.claims.filter(
          (c) => c.lineageSlug !== body.lineageSlug,
        );
        return {
          ok: true,
          json: async () => ({ schemaVersion: 1, claims: state.claims }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(() => {
  resetLeagueDataCacheForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("premiere-account-page claim set", () => {
  it("claiming a second lineage keeps the first — both show in the claimed list", async () => {
    const state = { claims: [claim("daveey-proxywar")] };
    stubFetch(state, [
      { playerName: "Daveey", policyLabel: "daveey-proxywar:v24" },
      { playerName: "Second Agent", policyLabel: "second-lineage:v3" },
    ]);
    const el = mount();
    await flushMicrotasks(20);

    // Open the picker via the real "+ Claim another lineage" affordance —
    // never poke private component state directly.
    const addAnotherButton = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Claim another lineage"),
    );
    expect(addAnotherButton).toBeDefined();
    addAnotherButton!.dispatchEvent(new MouseEvent("click"));
    await flushMicrotasks(5);
    const select = el.querySelector<HTMLSelectElement>("#account-claim-select");
    expect(select).not.toBeNull();
    // The already-claimed lineage must not be offered again.
    const optionValues = [...select!.options].map((o) => o.value);
    expect(optionValues).not.toContain("daveey-proxywar");
    expect(optionValues).toContain("second-lineage");
    select!.value = "second-lineage";
    select!.dispatchEvent(new Event("change"));
    await flushMicrotasks(5);

    const submitButton = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("This is me"),
    );
    expect(submitButton).toBeDefined();
    submitButton!.dispatchEvent(new MouseEvent("click"));
    await flushMicrotasks(20);

    expect(state.claims.map((c) => c.lineageSlug).sort()).toEqual([
      "daveey-proxywar",
      "second-lineage",
    ]);
    const text = el.textContent ?? "";
    expect(text).toContain("Daveey");
    expect(text).toContain("Second Agent");
  });

  it("removing one claimed lineage keeps the other", async () => {
    const state = {
      claims: [claim("daveey-proxywar"), claim("second-lineage")],
    };
    stubFetch(state, [
      { playerName: "Daveey", policyLabel: "daveey-proxywar:v24" },
      { playerName: "Second Agent", policyLabel: "second-lineage:v3" },
    ]);
    const el = mount();
    await flushMicrotasks(20);

    const removeButtons = [...el.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Remove",
    );
    expect(removeButtons).toHaveLength(2);
    // Remove the first rendered row (order comes straight from the
    // server response, oldest-claimed first).
    removeButtons[0].dispatchEvent(new MouseEvent("click"));
    await flushMicrotasks(20);

    expect(state.claims.map((c) => c.lineageSlug)).toEqual(["second-lineage"]);
    const text = el.textContent ?? "";
    expect(text).not.toContain("Daveey");
    expect(text).toContain("Second Agent");
  });

  it("an account with no claims shows the prompt, not the claimed list", async () => {
    const state = { claims: [] as AccountClaim[] };
    stubFetch(state, []);
    const el = mount();
    await flushMicrotasks(20);
    expect(el.textContent ?? "").toContain("Pick my lineage");
  });
});
