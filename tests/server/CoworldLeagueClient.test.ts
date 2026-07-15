import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  COWORLD_LEAGUE_DATA_PATH,
  COWORLD_LEAGUE_POLL_INTERVAL_MS,
  COWORLD_LEAGUE_POLL_TIMEOUT_MS,
  coworldLeagueClientJavaScript,
} from "../../src/server/agents/CoworldLeagueSiteWriter";

const generatedAt = "2026-07-15T15:00:00.000Z";

function startLeagueClient(
  fetchMock: ReturnType<typeof vi.fn>,
  options: {
    hidden?: boolean;
    includeAbortController?: boolean;
    includeFetch?: boolean;
  } = {},
) {
  const dataset: Record<string, string> = {
    generatedAt,
    stale: "false",
  };
  const status = {
    hidden: true,
    textContent:
      "Update check unavailable — showing this snapshot; retrying automatically.",
  };
  const fallbackRefresh = { remove: vi.fn() };
  const reload = vi.fn();
  const documentListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, () => void>();
  const fakeWindow = {
    addEventListener: (type: string, listener: () => void) => {
      windowListeners.set(type, listener);
    },
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    location: { reload },
    setInterval: globalThis.setInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };
  const fakeDocument = {
    addEventListener: (type: string, listener: () => void) => {
      documentListeners.set(type, listener);
    },
    documentElement: { dataset },
    getElementById: (id: string) => {
      if (id === "live-update-status") return status;
      if (id === "league-refresh-fallback") return fallbackRefresh;
      return null;
    },
    hidden: options.hidden ?? false,
    querySelectorAll: () => [],
  };

  const context: Record<string, unknown> = {
    document: fakeDocument,
    window: fakeWindow,
  };
  if (options.includeAbortController !== false) {
    context.AbortController = AbortController;
  }
  if (options.includeFetch !== false) {
    context.fetch = fetchMock;
  }
  runInNewContext(coworldLeagueClientJavaScript(), context);
  return {
    dataset,
    dispatchDocumentEvent: (type: string) => documentListeners.get(type)?.(),
    dispatchWindowEvent: (type: string) => windowListeners.get(type)?.(),
    fallbackRefresh,
    reload,
    setHidden: (hidden: boolean) => {
      fakeDocument.hidden = hidden;
    },
    status,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

describe("coworldLeagueClientJavaScript", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("revalidates the public snapshot and stays quiet after one transient failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const client = startLeagueClient(fetchMock);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.fallbackRefresh.remove).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      COWORLD_LEAGUE_DATA_PATH,
      expect.objectContaining({ cache: "no-cache" }),
    );
    expect(client.status.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.status.hidden).toBe(false);
    expect(client.dataset.updateState).toBe("retrying");
  });

  test.each([
    { includeAbortController: false, includeFetch: true },
    { includeAbortController: true, includeFetch: false },
  ])(
    "keeps the timed fallback when polling capabilities are unavailable (%o)",
    async (options) => {
      const fetchMock = vi.fn();
      const client = startLeagueClient(fetchMock, options);

      await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_INTERVAL_MS * 2);

      expect(client.fallbackRefresh.remove).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(client.reload).not.toHaveBeenCalled();
    },
  );

  test("clears the retry warning after polling recovers", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ generatedAt, stale: false }),
      });
    const client = startLeagueClient(fetchMock);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_INTERVAL_MS);
    expect(client.status.hidden).toBe(false);

    await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.status.hidden).toBe(true);
    expect(client.dataset.updateState).toBe("current");
    expect(client.reload).not.toHaveBeenCalled();
  });

  test("reloads immediately when a newer snapshot appears", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generatedAt: "2026-07-15T15:05:00.000Z",
        stale: false,
      }),
    });
    const client = startLeagueClient(fetchMock);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.dataset.updateState).toBe("reloading");
    expect(client.reload).toHaveBeenCalledOnce();

    client.dispatchWindowEvent("online");
    client.dispatchDocumentEvent("visibilitychange");
    await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(client.reload).toHaveBeenCalledOnce();
  });

  test("reloads when stale state changes at the same snapshot timestamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ generatedAt, stale: true }),
    });
    const client = startLeagueClient(fetchMock);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.dataset.updateState).toBe("reloading");
    expect(client.reload).toHaveBeenCalledOnce();
  });

  test("does not reload for an older snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generatedAt: "2026-07-15T14:55:00.000Z",
        stale: false,
      }),
    });
    const client = startLeagueClient(fetchMock);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.dataset.updateState).toBe("current");
    expect(client.reload).not.toHaveBeenCalled();
  });

  test("skips hidden-tab polling and checks immediately when visible", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ generatedAt, stale: false }),
    });
    const client = startLeagueClient(fetchMock, { hidden: true });

    await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_INTERVAL_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();

    client.setHidden(false);
    client.dispatchDocumentEvent("visibilitychange");
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("coalesces interval, visibility, and online checks while one is pending", async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const client = startLeagueClient(fetchMock);
    await flushMicrotasks();

    client.dispatchWindowEvent("online");
    client.dispatchDocumentEvent("visibilitychange");
    await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFetch?.({
      ok: true,
      json: async () => ({ generatedAt, stale: false }),
    });
    await flushMicrotasks();
    expect(client.dataset.updateState).toBe("current");
  });

  test("aborts hung checks and warns after two timed-out attempts", async () => {
    const fetchMock = vi.fn(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const client = startLeagueClient(fetchMock);

    await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_TIMEOUT_MS);
    expect(client.status.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(
      COWORLD_LEAGUE_POLL_INTERVAL_MS - COWORLD_LEAGUE_POLL_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(COWORLD_LEAGUE_POLL_TIMEOUT_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.status.hidden).toBe(false);
    expect(client.dataset.updateState).toBe("retrying");
  });
});
