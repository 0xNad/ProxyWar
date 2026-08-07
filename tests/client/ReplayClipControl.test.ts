import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountReplayScopedLeagueClipControl } from "../../src/client/ReplayClipControl";

/**
 * Focused coverage for the poll-path defect: `pollLeagueClipStatus`'s
 * `!response.ok` branch used to retry forever on ANY non-404 failure
 * (network exception aside), never reaching the SAME `applyLeagueClipFailure`
 * terminal states the initial POST (`requestLeagueClip`) and the 404 case
 * already use. These two tests pin the fix: a persistent 503/500 on the
 * status poll now reaches "busy"/"failed" after exactly one further poll,
 * matching `requestLeagueClip`'s existing 429/503-vs-other convention
 * verbatim, and stops polling. Deliberately NOT covering the untouched
 * network-exception/malformed-JSON retry paths or the success path here —
 * those are out of scope for this fix.
 *
 * Each test uses its OWN `runKey`: `mountReplayScopedLeagueClipControl`
 * caches its mutable state on `window.__proxyWarLeagueClipStates`, keyed by
 * `runKey` (see `leagueClipState()`'s `existing !== undefined` early
 * return) — jsdom's `window` persists across `it()` blocks within one test
 * file, so two tests sharing a `runKey` would silently reuse the FIRST
 * test's already-terminal state instead of starting fresh.
 */
vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

// `leagueClipState()`'s default `selectedBucket` is `LEAGUE_CLIP_MIN_BUCKET`
// (5) — never the range's max — so the very first render request always
// targets bucket 5 for any `renderableThroughTurn` large enough to make the
// bucket range non-null.
const BUCKET = 5;

function capabilitiesResponse(): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      premiereGenerationEnabled: true,
      leagueGenerationEnabled: true,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function pendingResponse(runKey: string): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      premiereId: runKey,
      bucket: BUCKET,
      clipVersion: 1,
      state: "pending",
      ready: null,
      pending: { phase: "rendering", jobsAhead: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function clipUnavailableResponse(status: number): Response {
  return new Response(
    JSON.stringify({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
});

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Clicks the render button and drives the mount through capability-check + POST to "preparing", scheduling the first poll. */
async function startPreparing(
  runKey: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  mountReplayScopedLeagueClipControl({
    container,
    runKey,
    renderableThroughTurn: 1_000,
    fetchImpl,
  });
  // Let the mount's own /api/clip-capabilities fetch resolve so the
  // container un-hides and the Render button actually renders.
  await flushMicrotasks();
  const renderButton = container.querySelector<HTMLButtonElement>(
    "[data-ai-league-clip-render]",
  );
  expect(renderButton).not.toBeNull();
  renderButton!.click();
  // Let the POST resolve — this schedules the first 3s poll.
  await flushMicrotasks();
}

describe("ReplayClipControl — poll-path terminal error handling", () => {
  it("a persistent 503 on the status poll reaches terminal 'busy' after exactly one further poll, re-enables controls, and stops polling", async () => {
    const runKey = "clip-poll-503-run";
    let pollCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/clip-capabilities") return capabilitiesResponse();
      if (url === `/api/league-runs/${runKey}/clips`)
        return pendingResponse(runKey);
      if (url === `/api/league-runs/${runKey}/clips/${BUCKET}?progress=1`) {
        pollCount += 1;
        return clipUnavailableResponse(503);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.useFakeTimers();
    await startPreparing(runKey, fetchImpl);
    expect(pollCount).toBe(0); // no poll has fired yet — only the POST happened

    // The bug lives exactly here: advancing one poll interval must reach a
    // terminal state, not silently reschedule forever.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pollCount).toBe(1);

    expect(container.textContent).toContain("ai_league_replay.clip_busy");
    expect(container.textContent).not.toContain(
      "ai_league_replay.clip_rendering",
    );
    const fieldset = container.querySelector("fieldset");
    expect(fieldset?.disabled).toBe(false);
    const renderButton = container.querySelector<HTMLButtonElement>(
      "[data-ai-league-clip-render]",
    );
    expect(renderButton).not.toBeNull();

    // Prove polling actually stopped: many more elapsed intervals add zero
    // further fetch calls. This is what fails pre-fix (pollCount keeps
    // climbing forever).
    await vi.advanceTimersByTimeAsync(3_000 * 20);
    expect(pollCount).toBe(1);
  });

  it("a persistent 500 on the status poll reaches terminal 'failed' (not 'busy') after exactly one further poll, re-enables controls, and stops polling", async () => {
    const runKey = "clip-poll-500-run";
    let pollCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/clip-capabilities") return capabilitiesResponse();
      if (url === `/api/league-runs/${runKey}/clips`)
        return pendingResponse(runKey);
      if (url === `/api/league-runs/${runKey}/clips/${BUCKET}?progress=1`) {
        pollCount += 1;
        return clipUnavailableResponse(500);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.useFakeTimers();
    await startPreparing(runKey, fetchImpl);
    expect(pollCount).toBe(0);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(pollCount).toBe(1);

    expect(container.textContent).toContain("ai_league_replay.clip_failed");
    expect(container.textContent).not.toContain("ai_league_replay.clip_busy");
    expect(container.textContent).not.toContain(
      "ai_league_replay.clip_rendering",
    );
    const fieldset = container.querySelector("fieldset");
    expect(fieldset?.disabled).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000 * 20);
    expect(pollCount).toBe(1);
  });
});
