import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isEpisodeAlreadyPublic,
  type LoopConfig,
} from "../../../src/scripts/replay-premiere-loop";

/**
 * The loop's pre-admission "already public" origin probe. When the mirror has
 * already published a completed round's public run-key bundle, the loop must
 * skip it BEFORE pin/contract/admit so the admission leak collector never
 * fetches (and aborts) the multi-MB public replay. The probe is fail-open: only
 * an unambiguous 200 marks the episode public.
 */

const MANAGED_RUN_KEY = "league-coworld-abc123def456";

function config(overrides: Partial<LoopConfig>): LoopConfig {
  return { deploymentOrigin: null, ...overrides } as unknown as LoopConfig;
}

function stubFetch(
  impl: (url: string, init: RequestInit) => { status: number; body: null },
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (input: string | URL, init?: RequestInit) =>
      impl(String(input), init ?? {}) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isEpisodeAlreadyPublic", () => {
  test("returns true on a 200 and probes the run-key with a bodyless HEAD", async () => {
    const fetchMock = stubFetch(() => ({ status: 200, body: null }));
    const result = await isEpisodeAlreadyPublic(
      MANAGED_RUN_KEY,
      config({ deploymentOrigin: "https://beta.example.test" }),
    );
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://beta.example.test/ai-league-runs/${MANAGED_RUN_KEY}/spectator.html`,
    );
    expect(init.method).toBe("HEAD");
    expect(init.redirect).toBe("error");
  });

  test("returns false (claimable) on a 404 — not yet published", async () => {
    stubFetch(() => ({ status: 404, body: null }));
    const result = await isEpisodeAlreadyPublic(
      MANAGED_RUN_KEY,
      config({ deploymentOrigin: "https://beta.example.test" }),
    );
    expect(result).toBe(false);
  });

  test("fail-open: a network error leaves the episode claimable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const result = await isEpisodeAlreadyPublic(
      MANAGED_RUN_KEY,
      config({ deploymentOrigin: "https://beta.example.test" }),
    );
    expect(result).toBe(false);
  });

  test("no deployment origin: never probes, stays claimable", async () => {
    const fetchMock = stubFetch(() => ({ status: 200, body: null }));
    const result = await isEpisodeAlreadyPublic(
      MANAGED_RUN_KEY,
      config({ deploymentOrigin: null }),
    );
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("unmanaged / unsafe run key: never probes, stays claimable", async () => {
    const fetchMock = stubFetch(() => ({ status: 200, body: null }));
    for (const unsafe of [
      "league-not-coworld",
      "league-coworld-ok/../escape",
      "../../etc/passwd",
    ]) {
      expect(
        await isEpisodeAlreadyPublic(
          unsafe,
          config({ deploymentOrigin: "https://beta.example.test" }),
        ),
      ).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
