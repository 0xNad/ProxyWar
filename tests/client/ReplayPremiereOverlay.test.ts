import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (
    key: string,
    params?: Record<string, string | number>,
  ): string => {
    if (params === undefined) {
      return key;
    }
    return `${key}:${Object.entries(params)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(",")}`;
  },
}));

import {
  mountReplayPremiereOverlay,
  ReplayPremiereOverlayCallbacks,
  ReplayPremiereOverlayHandle,
  ReplayPremiereOverlayModel,
} from "../../src/client/ReplayPremiereOverlay";

const handles: ReplayPremiereOverlayHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ReplayPremiereOverlay", () => {
  it("renders a spoiler-neutral scheduled premiere without checkpoint options", () => {
    const model = makeModel({
      title: '<img src=x onerror="globalThis.__xss = true">',
      description: "A completed match with no outcome disclosed.",
    });
    const handle = mount(model, {
      onAddReminder: vi.fn(),
      onShare: vi.fn(),
    });

    expect(handle.element.dataset.state).toBe("scheduled");
    expect(handle.element.textContent).toContain(model.title);
    expect(handle.element.querySelector("img")).toBeNull();
    expect(handle.element.textContent).toContain("Pangaea");
    expect(handle.element.textContent).toContain("2-player FFA");
    expect(handle.element.textContent).toContain("Atlas Prime");
    expect(handle.element.textContent).toContain(
      "replay_premiere.policy_version:version=17",
    );
    expect(handle.element.textContent).toContain(
      "replay_premiere.policy_version_id:id=policy-version-atlas",
    );
    expect(handle.element.textContent).toContain(
      `replay_premiere.content_sha:hash=${"b".repeat(64)}`,
    );
    expect(handle.element.textContent).toContain(
      "replay_premiere.label_controlled",
    );
    expect(
      handle.element.querySelectorAll(".rp-prediction-button"),
    ).toHaveLength(0);
    expect(
      handle.element.querySelector("[data-focus-key=reminder]"),
    ).not.toBeNull();
    expect(
      handle.element.querySelector("[data-focus-key=canonical-share]"),
    ).not.toBeNull();
  });

  it("shows exactly one open 15-second checkpoint and locks one prediction", async () => {
    const onPrediction = vi.fn();
    const now = "2026-07-20T20:00:00.000Z";
    const model = makeModel({
      state: "checkpoint",
      authoritativeNow: now,
      activeCheckpointId: "checkpoint-1",
      checkpoints: [
        {
          id: "checkpoint-1",
          sequence: 350,
          state: "open",
          closesAt: "2026-07-20T20:00:15.000Z",
          options: [
            { seatId: "seat-a", displayName: "Atlas Prime" },
            { seatId: "seat-b", displayName: "Borealis" },
          ],
          // The server may include a distribution internally. The UI must not
          // reveal it until this participant votes or the window closes.
          distribution: [
            { seatId: "seat-a", percent: 75 },
            { seatId: "seat-b", percent: 25 },
          ],
        },
        checkpoint("checkpoint-2", 650),
      ],
    });
    const handle = mount(model, { onPrediction });

    expect(handle.element.textContent).toContain(
      "replay_premiere.checkpoint_intermission",
    );
    expect(handle.element.textContent).toContain(
      "replay_premiere.who_will_win",
    );
    expect(handle.element.textContent).toContain(
      "replay_premiere.resumes_in:time=0:15",
    );
    expect(
      handle.element.querySelectorAll(".rp-prediction-button"),
    ).toHaveLength(2);
    expect(handle.element.querySelector(".rp-distribution")).toBeNull();

    const atlasButton = handle.element.querySelector<HTMLButtonElement>(
      "[data-focus-key=prediction-seat-a]",
    );
    atlasButton?.click();
    await vi.waitFor(() =>
      expect(onPrediction).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        checkpointId: "checkpoint-1",
        selectedSeatId: "seat-a",
      }),
    );

    handle.hydrate({
      ...model,
      checkpoints: [
        {
          ...model.checkpoints[0],
          state: "submitted",
          selectedSeatId: "seat-a",
        },
        model.checkpoints[1],
      ],
    });
    expect(handle.element.textContent).toContain(
      "replay_premiere.prediction_locked",
    );
    expect(handle.element.querySelector(".rp-distribution")).not.toBeNull();
    expect(
      handle.element.querySelectorAll<HTMLButtonElement>(
        ".rp-prediction-button:not(:disabled)",
      ),
    ).toHaveLength(0);
  });

  it("offers only the five structured markers and emits released context", async () => {
    const onMarker = vi.fn();
    const handle = mount(
      makeModel({
        state: "playing",
        releasedSequence: 418,
        currentTurn: 730,
        markerPolicySeatId: "seat-b",
      }),
      { onMarker },
    );

    const markerButtons =
      handle.element.querySelectorAll<HTMLButtonElement>(".rp-marker-button");
    expect(markerButtons).toHaveLength(5);
    expect([...markerButtons].map((entry) => entry.dataset.kind)).toEqual([
      "turning_point",
      "smart",
      "mistake",
      "betrayal",
      "clip_this",
    ]);
    expect(handle.element.querySelector(".rp-markers input")).toBeNull();
    expect(handle.element.querySelector(".rp-markers textarea")).toBeNull();

    markerButtons[3].click();
    await vi.waitFor(() =>
      expect(onMarker).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        kind: "betrayal",
        sequence: 418,
        turn: 730,
        policySeatId: "seat-b",
      }),
    );
  });

  it("keeps edited caption text through hydration and emits share exports", async () => {
    const onShare = vi.fn();
    const onCopySuggestedCaption = vi.fn();
    const onExportCounterChallenge = vi.fn();
    const model = makeModel({
      state: "revealed",
      reveal: {
        outcome: "winner",
        winnerSeatId: "seat-a",
        summary: "Atlas held the final majority.",
      },
      canExportCounterChallenge: true,
      releasedSequence: 999,
      currentTurn: 1600,
    });
    const handle = mount(model, {
      onShare,
      onCopySuggestedCaption,
      onExportCounterChallenge,
    });

    expect(handle.element.textContent).toContain(
      "replay_premiere.winner:name=Atlas Prime",
    );
    const caption = handle.element.querySelector<HTMLTextAreaElement>(
      "#replay-premiere-caption",
    );
    expect(caption).not.toBeNull();
    caption!.focus();
    caption!.value = "My evidence-linked caption";
    caption!.dispatchEvent(new Event("input", { bubbles: true }));
    handle.hydrate({ ...model, headlineEvent: "A newly released event" });

    const hydratedCaption = handle.element.querySelector<HTMLTextAreaElement>(
      "#replay-premiere-caption",
    );
    expect(hydratedCaption?.value).toBe("My evidence-linked caption");
    expect(document.activeElement).toBe(hydratedCaption);

    handle.element
      .querySelector<HTMLButtonElement>("[data-focus-key=timestamp-share]")
      ?.click();
    handle.element
      .querySelector<HTMLButtonElement>("[data-focus-key=caption-copy]")
      ?.click();
    handle.element
      .querySelector<HTMLButtonElement>("[data-focus-key=counter-challenge]")
      ?.click();

    await vi.waitFor(() => {
      expect(onShare).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        kind: "timestamp",
        url: "https://proxywar.example/premiere/premiere-test?s=999",
        sequence: 999,
        turn: 1600,
      });
      expect(onCopySuggestedCaption).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        caption: "My evidence-linked caption",
        sequence: 999,
        turn: 1600,
      });
      expect(onExportCounterChallenge).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        replayUrl: "https://proxywar.example/premiere/premiere-test",
        sequence: 999,
        turn: 1600,
        policySeatId: null,
        mapName: "Pangaea",
        matchFormat: "2-player FFA",
        policies: model.policies,
      });
    });
  });

  it("switches to a compact ambient surface while keeping controls reachable", async () => {
    const onAmbientChange = vi.fn();
    const model = makeModel({ state: "playing" });
    const handle = mount(model, { onAmbientChange, onMarker: vi.fn() });
    const toggle = handle.element.querySelector<HTMLButtonElement>(
      "[data-focus-key=ambient]",
    );
    toggle?.click();
    await vi.waitFor(() =>
      expect(onAmbientChange).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        ambient: true,
      }),
    );

    handle.hydrate({ ...model, ambient: true });
    expect(handle.element.dataset.ambient).toBe("true");
    expect(document.body.classList).toContain("replay-premiere-ambient-mode");
    expect(
      handle.element
        .querySelector<HTMLButtonElement>("[data-focus-key=ambient]")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      handle.element.querySelectorAll<HTMLButtonElement>(".rp-marker-button"),
    ).toHaveLength(5);
    expect(handle.element.querySelector(".rp-leaders")).not.toBeNull();
    expect(handle.element.querySelector(".rp-headline")).not.toBeNull();
  });

  it("maps unknown public failure input to fixed copy without rendering it", () => {
    const rawFailure =
      "/private/source/replay.json: token=secret Error: stack trace";
    const handle = mount(
      makeModel({
        state: "failed",
        failureCode: rawFailure,
        releasedSequence: 412,
      }),
    );

    expect(handle.element.textContent).toContain(
      "replay_premiere.failure_generic",
    );
    expect(handle.element.textContent).toContain(
      "replay_premiere.frozen_position:sequence=412",
    );
    expect(handle.element.textContent).not.toContain(rawFailure);
    expect(handle.element.textContent).not.toContain("token=secret");
  });

  it("does not mislabel an absent reveal as an authoritative void", () => {
    const unavailable = mount(
      makeModel({
        state: "revealed",
        reveal: null,
        releasedSequence: 999,
      }),
    );

    expect(unavailable.element.textContent).toContain(
      "replay_premiere.failure_integrity",
    );
    expect(unavailable.element.textContent).not.toContain(
      "replay_premiere.result_void",
    );
    expect(unavailable.element.querySelector(".rp-counter")).toBeNull();

    const explicitVoid = mount(
      makeModel({
        state: "revealed",
        reveal: { outcome: "void", winnerSeatId: null },
        releasedSequence: 999,
      }),
    );
    expect(explicitVoid.element.textContent).toContain(
      "replay_premiere.result_void",
    );
    expect(explicitVoid.element.textContent).not.toContain(
      "replay_premiere.failure_integrity",
    );
  });

  it("renders an archived reveal without offering marker writes", () => {
    const handle = mount(
      makeModel({
        state: "archived",
        releasedSequence: 999,
        reveal: { outcome: "winner", winnerSeatId: "seat-b" },
        canExportCounterChallenge: true,
      }),
      {
        onMarker: vi.fn(),
        onShare: vi.fn(),
        onExportCounterChallenge: vi.fn(),
      },
    );

    expect(handle.element.textContent).toContain(
      "replay_premiere.archived_heading",
    );
    expect(handle.element.textContent).toContain(
      "replay_premiere.winner:name=Borealis",
    );
    expect(handle.element.querySelector(".rp-marker-button")).toBeNull();
    expect(
      handle.element.querySelector("[data-focus-key=timestamp-share]"),
    ).not.toBeNull();
    expect(
      handle.element.querySelector("[data-focus-key=counter-challenge]"),
    ).not.toBeNull();
  });

  it("blocks archived post-reveal actions when result evidence is invalid", () => {
    const handle = mount(
      makeModel({
        state: "archived",
        releasedSequence: 999,
        reveal: { outcome: "winner", winnerSeatId: "unknown-seat" },
        canExportCounterChallenge: true,
      }),
      {
        onShare: vi.fn(),
        onExportCounterChallenge: vi.fn(),
      },
    );

    expect(handle.element.textContent).toContain(
      "replay_premiere.failure_integrity",
    );
    expect(
      handle.element.querySelector("[data-focus-key=timestamp-share]"),
    ).toBeNull();
    expect(
      handle.element.querySelector("[data-focus-key=counter-challenge]"),
    ).toBeNull();
  });

  it("renders a prominent LIVE badge only during the live playing and checkpoint states", () => {
    const playing = mount(makeModel({ state: "playing" }), {
      onMarker: vi.fn(),
    });
    const playingBadge = playing.element.querySelector(".rp-live-now");
    expect(playingBadge).not.toBeNull();
    // A dedicated red dot plus the uppercase LIVE word, with a spoiler-free
    // accessible label — nothing about live-ness is invented, it mirrors state.
    expect(playingBadge?.querySelector(".rp-live-now-dot")).not.toBeNull();
    expect(playingBadge?.textContent).toContain("replay_premiere.live_badge");
    expect(playingBadge?.getAttribute("aria-label")).toBe(
      "replay_premiere.live_status",
    );
    // The decorative dot is hidden from assistive tech.
    expect(
      playingBadge
        ?.querySelector(".rp-live-now-dot")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    // It sits above the existing green "Shared playback" heading.
    const sharedPlayback = playing.element.querySelector(".rp-live-badge");
    expect(sharedPlayback).not.toBeNull();
    const relativePosition = playingBadge!.compareDocumentPosition(
      sharedPlayback as Node,
    );
    expect(relativePosition & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const checkpointView = mount(
      makeModel({
        state: "checkpoint",
        activeCheckpointId: "checkpoint-1",
        checkpoints: [
          {
            id: "checkpoint-1",
            sequence: 350,
            state: "open",
            closesAt: "2026-07-20T20:00:15.000Z",
            options: [
              { seatId: "seat-a", displayName: "Atlas Prime" },
              { seatId: "seat-b", displayName: "Borealis" },
            ],
          },
          checkpoint("checkpoint-2", 650),
        ],
      }),
      { onPrediction: vi.fn() },
    );
    expect(checkpointView.element.querySelector(".rp-live-now")).not.toBeNull();
  });

  it("omits the LIVE badge for scheduled, revealed, and archived states", () => {
    const scheduled = mount(makeModel({ state: "scheduled" }));
    expect(scheduled.element.querySelector(".rp-live-now")).toBeNull();

    const revealed = mount(
      makeModel({
        state: "revealed",
        releasedSequence: 999,
        reveal: { outcome: "winner", winnerSeatId: "seat-a" },
      }),
    );
    expect(revealed.element.querySelector(".rp-live-now")).toBeNull();

    const archived = mount(
      makeModel({
        state: "archived",
        releasedSequence: 999,
        reveal: { outcome: "winner", winnerSeatId: "seat-b" },
      }),
    );
    expect(archived.element.querySelector(".rp-live-now")).toBeNull();
  });

  it("fails closed when a runtime payload does not contain exactly two checkpoints", () => {
    const invalid = {
      ...makeModel(),
      checkpoints: [checkpoint("checkpoint-only", 350)],
    } as unknown as ReplayPremiereOverlayModel;
    const handle = mount(invalid);

    expect(handle.element.textContent).toContain(
      "replay_premiere.failure_integrity",
    );
    expect(handle.element.querySelector(".rp-prediction-button")).toBeNull();
  });

  it("keeps the clip control absent from the DOM before reveal", () => {
    const handle = mount(
      makeModel({
        state: "playing",
        releasedSequence: 418,
        currentTurn: 700,
        clip: { status: "idle", ready: null },
        canRequestClip: true,
      }),
      { onShare: vi.fn(), onRequestClip: vi.fn(), onMarker: vi.fn() },
    );

    expect(
      handle.element.querySelector("[data-focus-key=timestamp-share]"),
    ).not.toBeNull();
    expect(handle.element.querySelector(".rp-clip")).toBeNull();
    expect(
      handle.element.querySelector("[data-focus-key=clip-request]"),
    ).toBeNull();
  });

  it("anchors a clip download request to the current moment once revealed", async () => {
    const onRequestClip = vi.fn();
    const handle = mount(
      makeModel({
        state: "revealed",
        reveal: { outcome: "winner", winnerSeatId: "seat-a" },
        releasedSequence: 999,
        currentTurn: 1600,
        clip: { status: "idle", ready: null },
        canRequestClip: true,
      }),
      { onRequestClip, onShare: vi.fn() },
    );

    const request = handle.element.querySelector<HTMLButtonElement>(
      "[data-focus-key=clip-request]",
    );
    expect(request).not.toBeNull();
    expect(request?.disabled).toBe(false);
    request?.click();
    await vi.waitFor(() =>
      expect(onRequestClip).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        sequence: 999,
        turn: 1600,
      }),
    );
  });

  it("disables the clip request and shows a busy status when not permitted", () => {
    const handle = mount(
      makeModel({
        state: "revealed",
        reveal: { outcome: "winner", winnerSeatId: "seat-a" },
        releasedSequence: 999,
        currentTurn: 1600,
        clip: { status: "busy", ready: null },
        canRequestClip: false,
      }),
      { onRequestClip: vi.fn() },
    );

    expect(
      handle.element.querySelector<HTMLButtonElement>(
        "[data-focus-key=clip-request]",
      )?.disabled,
    ).toBe(true);
    expect(
      handle.element.querySelector('.rp-clip-status[data-clip-status="busy"]'),
    ).not.toBeNull();
    expect(handle.element.textContent).toContain("replay_premiere.clip_busy");
  });

  it("offers a download link and verbatim caption/reply copy once the clip is ready", async () => {
    const onCopyClipText = vi.fn();
    const handle = mount(
      makeModel({
        state: "revealed",
        reveal: { outcome: "winner", winnerSeatId: "seat-a" },
        releasedSequence: 999,
        currentTurn: 1600,
        clip: {
          status: "ready",
          ready: { downloadUrl: "/premiere/premiere-test/clip-v1-6.mp4" },
        },
        canRequestClip: true,
      }),
      { onCopyClipText, onRequestClip: vi.fn() },
    );

    const download = handle.element.querySelector<HTMLAnchorElement>(
      "[data-focus-key=clip-download]",
    );
    expect(download?.getAttribute("href")).toBe(
      "/premiere/premiere-test/clip-v1-6.mp4",
    );
    expect(download?.hasAttribute("download")).toBe(true);
    expect(handle.element.textContent).toContain("replay_premiere.clip_ready");

    handle.element
      .querySelector<HTMLButtonElement>("[data-focus-key=clip-copy-caption]")
      ?.click();
    handle.element
      .querySelector<HTMLButtonElement>("[data-focus-key=clip-copy-reply]")
      ?.click();
    await vi.waitFor(() => {
      expect(onCopyClipText).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        part: "caption",
      });
      expect(onCopyClipText).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        part: "reply",
      });
    });
  });

  it("keeps a ready clip downloadable on the archived surface with the request disabled", () => {
    const handle = mount(
      makeModel({
        state: "archived",
        releasedSequence: 999,
        reveal: { outcome: "winner", winnerSeatId: "seat-b" },
        clip: {
          status: "ready",
          ready: { downloadUrl: "/premiere/premiere-test/clip-v1-6.mp4" },
        },
        canRequestClip: false,
      }),
      { onCopyClipText: vi.fn(), onRequestClip: vi.fn(), onShare: vi.fn() },
    );

    expect(
      handle.element.querySelector("[data-focus-key=clip-download]"),
    ).not.toBeNull();
    expect(
      handle.element.querySelector<HTMLButtonElement>(
        "[data-focus-key=clip-request]",
      )?.disabled,
    ).toBe(true);
  });
});

function resultsReveal(): NonNullable<ReplayPremiereOverlayModel["reveal"]> {
  return {
    outcome: "winner",
    winnerSeatId: "seat-a",
    results: {
      turnCount: 640,
      standings: [
        { seatId: "seat-a", displayName: "Atlas Prime", won: true },
        { seatId: "seat-b", displayName: "Borealis", won: false },
      ],
      predictions: [
        {
          checkpointId: "checkpoint-1",
          sequence: 350,
          correctPercent: 75,
          totalPredictions: 4,
          options: [
            { seatId: "seat-a", displayName: "Atlas Prime", percent: 75 },
            { seatId: "seat-b", displayName: "Borealis", percent: 25 },
          ],
        },
        {
          checkpointId: "checkpoint-2",
          sequence: 650,
          correctPercent: 50,
          totalPredictions: 4,
          options: [
            { seatId: "seat-a", displayName: "Atlas Prime", percent: 50 },
            { seatId: "seat-b", displayName: "Borealis", percent: 50 },
          ],
        },
      ],
      markers: [
        { kind: "betrayal", turn: 300, count: 2 },
        { kind: "smart", turn: 500, count: 1 },
      ],
    },
  };
}

describe("results summary panel", () => {
  it("renders standings, prediction accuracy, and notable markers on reveal", () => {
    const handle = mount(
      makeModel({ state: "revealed", reveal: resultsReveal() }),
    );
    const panel = handle.element.querySelector(".rp-results");
    expect(panel).not.toBeNull();
    const text = panel?.textContent ?? "";
    expect(text).toContain("replay_premiere.results_heading");
    expect(text).toContain("replay_premiere.results_standings");
    expect(text).toContain("replay_premiere.results_winner_badge");
    expect(text).toContain("replay_premiere.results_accuracy:percent=75");
    expect(text).toContain("replay_premiere.results_markers");
    expect(text).toContain(
      "replay_premiere.results_marker_detail:turn=300,count=2",
    );
    // The winning seat's standing row carries the positive treatment.
    const winRow = handle.element.querySelector(
      ".rp-results-standing.rp-results-win",
    );
    expect(winRow?.textContent).toContain("Atlas Prime");
  });

  it("renders the panel on an archived premiere as well", () => {
    const handle = mount(
      makeModel({ state: "archived", reveal: resultsReveal() }),
    );
    expect(handle.element.querySelector(".rp-results")).not.toBeNull();
    expect(handle.element.textContent).toContain(
      "replay_premiere.results_markers",
    );
  });

  it("shows no results panel when the reveal carries no summary", () => {
    const handle = mount(
      makeModel({
        state: "revealed",
        reveal: { outcome: "winner", winnerSeatId: "seat-a" },
      }),
    );
    // The section renders empty + hidden, so its heading never appears.
    expect(handle.element.textContent).not.toContain(
      "replay_premiere.results_heading",
    );
    const panel = handle.element.querySelector<HTMLElement>(".rp-results");
    if (panel !== null) {
      expect(panel.hidden).toBe(true);
    }
  });
});

function mount(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks = {},
): ReplayPremiereOverlayHandle {
  const handle = mountReplayPremiereOverlay(model, callbacks);
  handles.push(handle);
  return handle;
}

function makeModel(
  overrides: Partial<ReplayPremiereOverlayModel> = {},
): ReplayPremiereOverlayModel {
  return {
    premiereId: "premiere-test",
    state: "scheduled",
    title: "Atlas versus Borealis",
    description: "A spoiler-neutral completed replay premiere.",
    sourceKind: "controlled_exhibition",
    publicLabel: "premiere",
    scheduledAt: "2026-07-20T20:10:00.000Z",
    authoritativeNow: "2026-07-20T20:00:00.000Z",
    playbackRate: 2,
    mapName: "Pangaea",
    matchFormat: "2-player FFA",
    policies: [
      {
        seatId: "seat-a",
        displayName: "Atlas Prime",
        policyIdentity: {
          namespace: "softmax_policy_version",
          policyVersionId: "policy-version-atlas",
          policyName: "atlas",
          serverAssignedVersion: "17",
        },
      },
      {
        seatId: "seat-b",
        displayName: "Borealis",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "borealis",
          declaredVersion: "manifest-5",
          manifestSha256: "a".repeat(64),
          contentSha256: "b".repeat(64),
        },
      },
    ],
    releasedSequence: 0,
    currentTurn: null,
    checkpoints: [
      checkpoint("checkpoint-1", 350),
      checkpoint("checkpoint-2", 650),
    ],
    activeCheckpointId: null,
    leaders: [
      { seatId: "seat-a", displayName: "Atlas Prime", territoryPercent: 53 },
      { seatId: "seat-b", displayName: "Borealis", territoryPercent: 47 },
    ],
    headlineEvent: "Atlas expands across the northern coast.",
    markerPolicySeatId: null,
    share: {
      canonicalUrl: "https://proxywar.example/premiere/premiere-test",
      timestampUrl: "https://proxywar.example/premiere/premiere-test?s=999",
      suggestedCaption: "Watch this Proxy War replay premiere moment.",
    },
    reveal: null,
    failureCode: null,
    ambient: false,
    canMark: true,
    canExportCounterChallenge: false,
    ...overrides,
  };
}

function checkpoint(id: string, sequence: number) {
  return {
    id,
    sequence,
    state: "pending" as const,
    closesAt: null,
    options: [],
  };
}
