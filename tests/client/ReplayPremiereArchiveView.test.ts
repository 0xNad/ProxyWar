import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined
      ? key
      : `${key}:${Object.entries(params)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(",")}`,
}));

import {
  mountArchivedReplayPremiereOverlay,
  readReplayPremiereArchivePayload,
  type ReplayPremiereArchivePayload,
} from "../../src/client/ReplayPremiereArchiveView";

const PREMIERE_ID = "prem_archiveview00001";

function samplePayload(): ReplayPremiereArchivePayload {
  return {
    premiereId: PREMIERE_ID,
    sourceRunId: "coworld-run-001",
    sourceKind: "rated_coworld",
    terminalState: "revealed",
    revealedAt: "2026-07-20T18:00:00.000Z",
    replayRunKey: "league-coworld-run-001",
    clipGenerationTarget: {
      kind: "league_run",
      replayRunKey: "league-coworld-run-001",
    },
    summary: {
      premiereId: PREMIERE_ID,
      sourceRunId: "coworld-run-001",
      sourceKind: "rated_coworld",
      terminalState: "revealed",
      revealedAt: "2026-07-20T18:00:00.000Z",
      outcome: {
        winner: { category: "player", groupLabel: null, seatIds: ["SEAT0001"] },
        turnCount: 6,
        completedAt: "2026-07-20T18:00:00.600Z",
        standings: [
          { seatId: "SEAT0001", displayName: "Alpha", won: true },
          { seatId: "SEAT0002", displayName: "Beta", won: false },
        ],
      },
      predictions: [
        {
          checkpointId: "cp_first00000001",
          sequence: 35,
          totalPredictions: 4,
          correctPredictions: 3,
          options: [
            { seatId: "SEAT0001", count: 3 },
            { seatId: "SEAT0002", count: 1 },
          ],
        },
      ],
      markers: [{ kind: "betrayal", turn: 3, count: 2 }],
    },
  } as unknown as ReplayPremiereArchivePayload;
}

function inject(text: string): void {
  const element = document.createElement("script");
  element.type = "application/json";
  element.id = "proxywar-premiere-archive";
  element.textContent = text;
  document.head.appendChild(element);
}

afterEach(() => {
  document.getElementById("proxywar-premiere-archive")?.remove();
  document.getElementById("replay-premiere-overlay")?.remove();
  document.body.innerHTML = "";
  delete (
    window as Window & {
      __proxyWarLeagueClipStates?: Map<string, unknown>;
    }
  ).__proxyWarLeagueClipStates;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readReplayPremiereArchivePayload", () => {
  it("returns null when the archive island is absent", () => {
    expect(readReplayPremiereArchivePayload()).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    inject("{ not json");
    expect(readReplayPremiereArchivePayload()).toBeNull();
  });

  it("returns null when the premiere id shape is invalid", () => {
    const bad = samplePayload();
    inject(JSON.stringify({ ...bad, premiereId: "not-a-premiere" }));
    expect(readReplayPremiereArchivePayload()).toBeNull();
  });

  it("parses a valid injected payload", () => {
    inject(JSON.stringify(samplePayload()));
    const parsed = readReplayPremiereArchivePayload();
    expect(parsed?.premiereId).toBe(PREMIERE_ID);
    expect(parsed?.replayRunKey).toBe("league-coworld-run-001");
    expect(parsed?.clipGenerationTarget).toEqual({
      kind: "league_run",
      replayRunKey: "league-coworld-run-001",
    });
    expect(parsed?.summary.markers).toHaveLength(1);
  });

  it("treats absent, malformed, and mismatched generation targets as unavailable", () => {
    const fetchMock = vi.fn(async (_url: string) => clipCapabilitiesResponse(true));
    vi.stubGlobal("fetch", fetchMock);
    const invalidTargets: unknown[] = [
      undefined,
      null,
      { kind: "premiere", replayRunKey: "league-coworld-run-001" },
      { kind: "league_run" },
      { kind: "league_run", replayRunKey: "league-coworld-other" },
    ];

    for (const clipGenerationTarget of invalidTargets) {
      const candidate = {
        ...samplePayload(),
        clipGenerationTarget,
      } as unknown as Record<string, unknown>;
      if (clipGenerationTarget === undefined) {
        delete candidate.clipGenerationTarget;
      }
      inject(JSON.stringify(candidate));
      const parsed = readReplayPremiereArchivePayload();
      expect(parsed).not.toBeNull();
      expect(parsed?.clipGenerationTarget).toBeNull();

      const handle = mountArchivedReplayPremiereOverlay(parsed!);
      expect(
        handle.element.querySelector(".rp-archived-clip-generation"),
      ).toBeNull();
      handle.dispose();
      handle.element.remove();
      document.getElementById("proxywar-premiere-archive")?.remove();
    }

    // A rejected generation target never even probes the process capability
    // (the overlay's own once-per-mount identity resolution against the
    // public read-model is unrelated and expected regardless).
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url !== "/ai-league-runs/league/read-model.json",
      ),
    ).toHaveLength(0);
  });
});

describe("mountArchivedReplayPremiereOverlay", () => {
  it("renders the archived results overlay from the summary", () => {
    const handle = mountArchivedReplayPremiereOverlay(samplePayload());
    expect(handle.element.querySelector(".rp-results")).not.toBeNull();
    const text = handle.element.textContent ?? "";
    expect(text).toContain("replay_premiere.results_markers");
    // Prediction accuracy = 3/4 = 75% (computed client-side from counts).
    expect(text).toContain("replay_premiere.results_accuracy:percent=75");
    expect(text).toContain("Alpha");
    // Winner-led H1 in the header, not the generic "Premiere replay".
    expect(handle.element.querySelector(".rp-title")?.textContent).toContain(
      "replay_premiere.archived_winner_heading:name=Alpha",
    );
    handle.dispose();
  });

  it("labels a winner with zero archived votes as no predictions, not void", () => {
    const payload = samplePayload();
    payload.summary.predictions[0] = {
      ...payload.summary.predictions[0],
      totalPredictions: 0,
      correctPredictions: 0,
      options: payload.summary.predictions[0].options.map((option) => ({
        ...option,
        count: 0,
      })),
    };
    const handle = mountArchivedReplayPremiereOverlay(payload);

    expect(handle.element.textContent).toContain(
      "replay_premiere.results_accuracy_no_predictions",
    );
    expect(handle.element.textContent).not.toContain(
      "replay_premiere.results_accuracy_void",
    );
    handle.dispose();
  });

  it("adds a copy-link action, plus a watch action only when a replay exists", () => {
    const withReplay = mountArchivedReplayPremiereOverlay(samplePayload());
    const actions = withReplay.element.querySelector(".rp-archived-actions");
    expect(actions).not.toBeNull();
    expect(actions?.textContent).toContain("replay_premiere.copy_link");
    expect(actions?.textContent).toContain("replay_premiere.watch_full_replay");
    withReplay.dispose();

    const noReplay = mountArchivedReplayPremiereOverlay({
      ...samplePayload(),
      replayRunKey: null,
    });
    const actions2 = noReplay.element.querySelector(".rp-archived-actions");
    expect(actions2?.textContent).toContain("replay_premiere.copy_link");
    expect(actions2?.textContent).not.toContain(
      "replay_premiere.watch_full_replay",
    );
    noReplay.dispose();
  });

  it("renders the durable clip download only when the payload carries one", () => {
    const clipUrl = `/premiere/${PREMIERE_ID}/clip.mp4`;
    const withClip = mountArchivedReplayPremiereOverlay({
      ...samplePayload(),
      clip: { url: clipUrl, byteLength: 12345 },
    });
    const download = withClip.element.querySelector<HTMLAnchorElement>(
      ".rp-archived-clip-download",
    );
    expect(download).not.toBeNull();
    expect(download?.getAttribute("href")).toBe(clipUrl);
    expect(download?.hasAttribute("download")).toBe(true);
    expect(download?.textContent).toBe(
      "replay_premiere.archived_clip_download",
    );
    withClip.dispose();

    // No clip artifact => no section at all (not a broken-looking button) —
    // exactly the legacy-archive presentation.
    const withoutClip = mountArchivedReplayPremiereOverlay({
      ...samplePayload(),
      clip: null,
    });
    expect(
      withoutClip.element.querySelector(".rp-archived-clip-download"),
    ).toBeNull();
    expect(withoutClip.element.textContent).not.toContain(
      "replay_premiere.archived_clip_download",
    );
    withoutClip.dispose();
  });

  it("hides archived generation when the process capability is off but keeps a promoted download", async () => {
    const fetchMock = vi.fn(async (_url: string) => clipCapabilitiesResponse(false));
    vi.stubGlobal("fetch", fetchMock);
    const payload = samplePayload();
    payload.clip = {
      url: `/premiere/${PREMIERE_ID}/clip.mp4`,
      byteLength: 12345,
    };
    const handle = mountArchivedReplayPremiereOverlay(payload);

    await vi.waitFor(() => {
      const generation = handle.element.querySelector<HTMLElement>(
        ".rp-archived-clip-generation",
      );
      expect(generation?.hidden).toBe(true);
      expect(generation?.childElementCount).toBe(0);
    });
    expect(
      handle.element.querySelector(".rp-archived-clip-download"),
    ).not.toBeNull();
    // One clip-capability probe, plus the overlay's own once-per-mount
    // identity resolution against the public read-model (unrelated).
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url !== "/ai-league-runs/league/read-model.json",
      ),
    ).toHaveLength(1);
    handle.dispose();
  });

  it("requests a clip for a retained archived rated replay without a Premiere interaction session", async () => {
    const payload = samplePayload();
    payload.clip = null;
    payload.summary.outcome!.turnCount = 1_000;
    const runKey = payload.replayRunKey!;
    const clipUrl = `/ai-league-runs/${runKey}/clip-v1-61.mp4`;
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (
          url === "/api/clip-capabilities" ||
          url === "/ai-league-runs/league/read-model.json"
        ) {
          return clipCapabilitiesResponse(true);
        }
        requests.push({
          url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            premiereId: runKey,
            bucket: 61,
            clipVersion: 1,
            state: "ready",
            ready: {
              clipUrl,
              byteLength: 96,
              sha256: "c".repeat(64),
              anchorTurn: 615,
              social: { caption: "caption text", firstReply: "watch url" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const handle = mountArchivedReplayPremiereOverlay(payload);
    await vi.waitFor(() => {
      expect(
        handle.element.querySelector("[data-ai-league-clip]")?.textContent,
      ).toContain("ai_league_replay.clip_range_pending");
    });
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: {
          tick: 615,
          terminal: false,
          turnNumber: 900,
          players: [],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(
        handle.element.querySelector("[data-ai-league-clip-render]"),
      ).not.toBeNull();
      expect(
        handle.element.querySelector<HTMLInputElement>(
          "[data-ai-league-clip-moment]",
        )?.max,
      ).toBe("61");
    });
    handle.element
      .querySelector<HTMLButtonElement>("[data-ai-league-clip-render]")
      ?.click();
    await vi.waitFor(() => {
      expect(
        handle.element.querySelector("[data-ai-league-clip-download]"),
      ).not.toBeNull();
    });

    expect(requests).toEqual([
      {
        url: `/api/league-runs/${runKey}/clips`,
        method: "POST",
        body: { turn: 615 },
      },
    ]);
    expect(
      requests.some(({ url }) =>
        url.includes(`/api/premieres/${PREMIERE_ID}/sessions`),
      ),
    ).toBe(false);
    expect(
      handle.element
        .querySelector<HTMLAnchorElement>("[data-ai-league-clip-download]")
        ?.getAttribute("href"),
    ).toBe(clipUrl);
    handle.dispose();
  });

  it("does not show or probe generation when the archived replay source is unavailable", () => {
    const fetchMock = vi.fn(async (_url: string) => clipCapabilitiesResponse(true));
    vi.stubGlobal("fetch", fetchMock);
    const handle = mountArchivedReplayPremiereOverlay({
      ...samplePayload(),
      replayRunKey: null,
      clip: null,
    });

    expect(
      handle.element.querySelector(".rp-archived-clip-generation"),
    ).toBeNull();
    // The overlay's own once-per-mount identity resolution against the
    // public read-model is unrelated and expected regardless.
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url !== "/ai-league-runs/league/read-model.json",
      ),
    ).toHaveLength(0);
    handle.dispose();
  });

  it("parses the clip strictly: only this premiere's exact durable route", () => {
    const good = {
      ...samplePayload(),
      clip: { url: `/premiere/${PREMIERE_ID}/clip.mp4`, byteLength: 77 },
    };
    inject(JSON.stringify(good));
    expect(readReplayPremiereArchivePayload()?.clip).toEqual({
      url: `/premiere/${PREMIERE_ID}/clip.mp4`,
      byteLength: 77,
    });
    document.getElementById("proxywar-premiere-archive")?.remove();

    // A foreign or absolute url is dropped (clip treated as absent), never
    // linked — the page only ever links its own same-origin durable route.
    const foreign = {
      ...samplePayload(),
      clip: { url: "https://evil.example/clip.mp4", byteLength: 77 },
    };
    inject(JSON.stringify(foreign));
    expect(readReplayPremiereArchivePayload()?.clip).toBeNull();
    document.getElementById("proxywar-premiere-archive")?.remove();

    // Legacy payload without the field parses with clip null.
    const legacy = samplePayload() as unknown as Record<string, unknown>;
    delete legacy.clip;
    inject(JSON.stringify(legacy));
    expect(readReplayPremiereArchivePayload()?.clip).toBeNull();
  });
});

function clipCapabilitiesResponse(enabled: boolean): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      premiereGenerationEnabled: enabled,
      leagueGenerationEnabled: enabled,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
