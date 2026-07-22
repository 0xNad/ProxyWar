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
    expect(parsed?.summary.markers).toHaveLength(1);
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
});
