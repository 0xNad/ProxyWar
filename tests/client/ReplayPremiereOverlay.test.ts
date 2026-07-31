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
import {
  BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT,
  BROADCAST_RAIL_FOLLOW_EVENT,
} from "../../src/client/graphics/layers/PointOfViewSelector";

const handles: ReplayPremiereOverlayHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    // Provenance is collapsed behind a "Verification details" disclosure, and
    // long hashes render truncated with the full value preserved in `title`.
    expect(handle.element.textContent).toContain(
      "replay_premiere.verification_details",
    );
    expect(handle.element.textContent).toContain(
      `replay_premiere.content_sha:hash=${"b".repeat(12)}…`,
    );
    const contentShaLine = [
      ...handle.element.querySelectorAll<HTMLElement>(".rp-policy-reference"),
    ].find((line) => line.title.includes("b".repeat(64)));
    expect(contentShaLine).not.toBeUndefined();
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

  it("shows exactly one open checkpoint window and locks one prediction", async () => {
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

  it("hides the clip mark without proven clip capability and emits released context", async () => {
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
    expect(markerButtons).toHaveLength(4);
    expect([...markerButtons].map((entry) => entry.dataset.kind)).toEqual([
      "turning_point",
      "smart",
      "mistake",
      "betrayal",
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

  it("shows the clip mark only when capability is explicitly proven", () => {
    const handle = mount(
      makeModel({
        state: "playing",
        clipMarkerAvailable: true,
      }),
      { onMarker: vi.fn() },
    );

    expect(
      handle.element.querySelector('.rp-marker-button[data-kind="clip_this"]'),
    ).not.toBeNull();
    expect(handle.element.querySelectorAll(".rp-marker-button")).toHaveLength(
      5,
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
    handle.hydrate({
      ...model,
      headlineEvent: "A newly released event",
      share: {
        ...model.share!,
        suggestedCaption: "A newer automatic caption",
      },
    });

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

  it("refreshes an untouched suggested caption during volatile playback hydration", () => {
    const model = makeModel({ state: "playing", currentTurn: 10 });
    const handle = mount(model);
    const caption = handle.element.querySelector<HTMLTextAreaElement>(
      "#replay-premiere-caption",
    );
    expect(caption?.value).toBe("Watch this Proxy War replay premiere moment.");

    handle.hydrate({
      ...model,
      currentTurn: 11,
      share: {
        ...model.share!,
        suggestedCaption: "Watch turn 11.",
      },
    });

    expect(
      handle.element.querySelector<HTMLTextAreaElement>(
        "#replay-premiere-caption",
      ),
    ).toBe(caption);
    expect(caption?.value).toBe("Watch turn 11.");
  });

  it("labels and emits a timestamp share anchored to the accepted mark", async () => {
    const onShare = vi.fn();
    const onCopySuggestedCaption = vi.fn();
    const model = makeModel({
      state: "playing",
      releasedSequence: 999,
      currentTurn: 1600,
    });
    const handle = mount(
      {
        ...model,
        share: {
          ...model.share!,
          sourceReactionId: `react_${"a".repeat(32)}`,
          sourceReactionSequence: 700,
          sourceReactionTurn: 1200,
          suggestedCaption: "Watch turn 1200.",
        },
      },
      { onShare, onCopySuggestedCaption },
    );
    const share = handle.element.querySelector<HTMLButtonElement>(
      "[data-focus-key=timestamp-share]",
    );
    const caption = handle.element.querySelector<HTMLTextAreaElement>(
      "#replay-premiere-caption",
    );

    expect(share?.textContent).toBe("replay_premiere.copy_marked_moment");
    expect(caption?.value).toBe("Watch turn 1200.");
    share?.click();
    handle.element
      .querySelector<HTMLButtonElement>("[data-focus-key=caption-copy]")
      ?.click();
    await vi.waitFor(() =>
      expect(onShare).toHaveBeenCalledWith({
        premiereId: "premiere-test",
        kind: "timestamp",
        url: "https://proxywar.example/premiere/premiere-test?s=999",
        sequence: 700,
        turn: 1200,
        sourceReactionId: `react_${"a".repeat(32)}`,
      }),
    );
    expect(onCopySuggestedCaption).toHaveBeenCalledWith({
      premiereId: "premiere-test",
      caption: "Watch turn 1200.",
      sequence: 999,
      turn: 1200,
    });
  });

  it("exposes a selectable manual URL after handled clipboard failure without a generic action error", async () => {
    const url = `https://proxywar.example/premiere/premiere-test?moment=share_${"8".repeat(32)}&attribution=${"a".repeat(16)}.${"b".repeat(16)}`;
    const model = makeModel({
      state: "playing",
      releasedSequence: 999,
      currentTurn: 1600,
    });
    const handleRef: { current: ReplayPremiereOverlayHandle | null } = {
      current: null,
    };
    const onShare = vi.fn(async () => {
      handleRef.current?.hydrate({
        ...model,
        share: {
          ...model.share!,
          manualCopyUrl: url,
          manualCopyReason: "clipboard_rejected",
        },
      });
    });
    const handle = mount(model, { onShare });
    handleRef.current = handle;

    handle.element
      .querySelector<HTMLButtonElement>("[data-focus-key=timestamp-share]")
      ?.click();

    await vi.waitFor(() => expect(onShare).toHaveBeenCalledTimes(1));
    const manual = handle.element.querySelector<HTMLInputElement>(
      ".rp-manual-copy-url",
    );
    expect(manual).not.toBeNull();
    expect(manual?.readOnly).toBe(true);
    expect(manual?.value).toBe(url);
    manual?.focus();
    expect(manual?.selectionStart).toBe(0);
    expect(manual?.selectionEnd).toBe(url.length);
    expect(
      handle.element.querySelector(".rp-manual-copy-status")?.textContent,
    ).toBe("replay_premiere.share_created_clipboard_rejected");
    expect(
      handle.element.querySelector("[data-premiere-action-status]")
        ?.textContent,
    ).toBe("");
    expect(handle.element.textContent).not.toContain(
      "replay_premiere.action_unavailable",
    );

    handle.hydrate({
      ...model,
      share: {
        ...model.share!,
        manualCopyUrl: url,
        manualCopyReason: "clipboard_unavailable",
      },
    });
    expect(
      handle.element.querySelector(".rp-manual-copy-status")?.textContent,
    ).toBe("replay_premiere.share_created_clipboard_unavailable");

    handle.hydrate({
      ...model,
      share: {
        ...model.share!,
        manualCopyUrl: null,
        manualCopyReason: null,
      },
    });
    expect(handle.element.querySelector(".rp-manual-copy-url")).toBeNull();
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
    ).toHaveLength(4);
    expect(handle.element.querySelector(".rp-leaders")).not.toBeNull();
    expect(handle.element.querySelector(".rp-headline")).not.toBeNull();
  });

  it("keeps the ambient toggle functional and visibly responsive in every live and terminal state", async () => {
    // Regression for "ambient mode doesn't work": the toggle must either work
    // (callback fires, [data-ambient] flips, the compact pane rules engage) or
    // be explicitly disabled with a reason — never a live-looking no-op.
    const states = [
      "playing",
      "checkpoint",
      "revealed",
      "failed",
      "cancelled",
      "archived",
    ] as const;
    for (const state of states) {
      const onAmbientChange = vi.fn();
      const model = makeModel({
        state,
        ...(state === "checkpoint"
          ? { activeCheckpointId: "checkpoint-1" }
          : {}),
        ...(state === "revealed" || state === "archived"
          ? {
              reveal: {
                outcome: "winner" as const,
                winnerSeatId: "seat-a",
                summary: null,
              },
            }
          : {}),
      });
      const handle = mount(model, { onAmbientChange });
      const toggle = handle.element.querySelector<HTMLButtonElement>(
        "[data-focus-key=ambient]",
      );
      expect(toggle, state).not.toBeNull();
      expect(toggle?.disabled, state).toBe(false);
      toggle?.click();
      await vi.waitFor(() =>
        expect(onAmbientChange).toHaveBeenCalledWith({
          premiereId: "premiere-test",
          ambient: true,
        }),
      );
      handle.hydrate({ ...model, ambient: true });
      expect(handle.element.dataset.ambient, state).toBe("true");
      expect(document.body.classList).toContain("replay-premiere-ambient-mode");
      // And back out again.
      handle.element
        .querySelector<HTMLButtonElement>("[data-focus-key=ambient]")
        ?.click();
      await vi.waitFor(() =>
        expect(onAmbientChange).toHaveBeenCalledWith({
          premiereId: "premiere-test",
          ambient: false,
        }),
      );
      handle.dispose();
    }
  });

  it("disables the ambient toggle with a visible reason before the premiere starts", () => {
    const onAmbientChange = vi.fn();
    const handle = mount(makeModel({ state: "scheduled" }), {
      onAmbientChange,
    });
    const toggle = handle.element.querySelector<HTMLButtonElement>(
      "[data-focus-key=ambient]",
    );
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.title).toBe("replay_premiere.ambient_unavailable");
    toggle?.click();
    expect(onAmbientChange).not.toHaveBeenCalled();
  });

  it("patches volatile frame data in place so live hydrates cannot swallow clicks", async () => {
    // Regression for the live render storm: frame-driven hydrates arrive many
    // times per second; a full rebuild per frame replaced buttons between
    // pointerdown and click, making ambient/reactions feel dead. Hydrates
    // that only move volatile fields must keep the same DOM nodes alive AND
    // handlers must read the LATEST sequence/turn at click time.
    const onMarker = vi.fn();
    const onAmbientChange = vi.fn();
    const model = makeModel({
      state: "playing",
      canMark: true,
      releasedSequence: 100,
      currentTurn: 100,
      leaders: [{ seatId: "seat-a", displayName: "Atlas Prime" }],
    });
    const handle = mount(model, { onMarker, onAmbientChange });
    const markerBefore = handle.element.querySelector<HTMLButtonElement>(
      '.rp-marker-button[data-kind="turning_point"]',
    );
    const ambientBefore = handle.element.querySelector<HTMLButtonElement>(
      "[data-focus-key=ambient]",
    );
    expect(markerBefore).not.toBeNull();

    // 60 volatile-only hydrates (one per simulated frame).
    for (let frame = 1; frame <= 60; frame += 1) {
      handle.hydrate({
        ...model,
        releasedSequence: 100 + frame,
        currentTurn: 100 + frame,
        leaders: [
          {
            seatId: "seat-a",
            displayName: "Atlas Prime",
            territoryPercent: frame,
          },
        ],
        headlineEvent: `headline-${frame}`,
      });
    }

    // Same DOM nodes — the buttons were never torn down.
    expect(
      handle.element.querySelector<HTMLButtonElement>(
        '.rp-marker-button[data-kind="turning_point"]',
      ),
    ).toBe(markerBefore);
    expect(
      handle.element.querySelector<HTMLButtonElement>(
        "[data-focus-key=ambient]",
      ),
    ).toBe(ambientBefore);
    // The volatile regions still updated in place.
    expect(handle.element.querySelector(".rp-position")?.textContent).toContain(
      "turn=160",
    );
    expect(handle.element.textContent).toContain("headline-60");

    // A click on the long-lived button reports the LATEST moment, not the
    // one from when the button was built.
    markerBefore?.click();
    await vi.waitFor(() =>
      expect(onMarker).toHaveBeenCalledWith(
        expect.objectContaining({ sequence: 160, turn: 160 }),
      ),
    );

    // A structural change (state flip) still rebuilds fully.
    handle.hydrate({
      ...model,
      state: "revealed",
      reveal: {
        outcome: "winner",
        winnerSeatId: "seat-a",
        summary: null,
      },
    });
    expect(handle.element.dataset.state).toBe("revealed");
    expect(
      handle.element.querySelector<HTMLButtonElement>(
        '.rp-marker-button[data-kind="turning_point"]',
      ),
    ).not.toBe(markerBefore);
  });

  it("shows the broadcast LIVE chip in the sticky header only while live", () => {
    for (const state of ["playing", "checkpoint"] as const) {
      const handle = mount(
        makeModel({
          state,
          ...(state === "checkpoint"
            ? { activeCheckpointId: "checkpoint-1" }
            : {}),
        }),
      );
      const chip = handle.element.querySelector(".rp-header .rp-live-chip");
      expect(chip, state).not.toBeNull();
      expect(chip?.textContent).toContain("replay_premiere.live_badge");
      handle.dispose();
    }
    for (const state of ["scheduled", "revealed"] as const) {
      const handle = mount(
        makeModel({
          state,
          ...(state === "revealed"
            ? {
                reveal: {
                  outcome: "winner" as const,
                  winnerSeatId: "seat-a",
                  summary: null,
                },
              }
            : {}),
        }),
      );
      expect(
        handle.element.querySelector(".rp-header .rp-live-chip"),
        state,
      ).toBeNull();
      handle.dispose();
    }
  });

  it("keeps the reaction row above the feed and leaders on the live surface", () => {
    const handle = mount(makeModel({ state: "playing" }), {
      onMarker: vi.fn(),
    });
    const sections = [
      ...handle.element.querySelectorAll(
        ".rp-body > .rp-section, .rp-body > .rp-ambient-evidence",
      ),
    ].map((section) => section.className);
    const markerIndex = sections.findIndex((name) =>
      name.includes("rp-markers"),
    );
    const feedIndex = sections.findIndex((name) =>
      name.includes("rp-war-feed"),
    );
    const evidenceIndex = sections.findIndex((name) =>
      name.includes("rp-ambient-evidence"),
    );
    expect(markerIndex).toBeGreaterThan(-1);
    expect(feedIndex).toBeGreaterThan(markerIndex);
    expect(evidenceIndex).toBeGreaterThan(feedIndex);
  });

  it("renders the battle feed with a visible empty state and live entries", () => {
    const model = makeModel({ state: "playing" });
    const handle = mount(model);
    expect(
      handle.element.querySelector(".rp-war-feed-empty")?.textContent,
    ).toBe("replay_premiere.war_feed_waiting");

    handle.hydrate({
      ...model,
      warEvents: [
        {
          kind: "nuke",
          actor: "Atlas Prime",
          target: null,
          detail: null,
          turn: 900,
        },
        {
          kind: "betrayal",
          actor: "Borealis",
          target: "Atlas Prime",
          detail: null,
          turn: 850,
        },
        {
          kind: "emote",
          actor: "Atlas Prime",
          target: "Borealis",
          detail: "😡",
          turn: 820,
        },
      ],
    });
    const items = [
      ...handle.element.querySelectorAll<HTMLElement>(".rp-war-feed-item"),
    ];
    expect(items).toHaveLength(3);
    expect(items[0].dataset.kind).toBe("nuke");
    expect(items[0].textContent).toContain(
      "replay_premiere.war_nuke:actor=Atlas Prime",
    );
    expect(items[1].textContent).toContain(
      "replay_premiere.war_betrayal:actor=Borealis,target=Atlas Prime",
    );
    expect(items[2].textContent).toContain("😡");
    // No outcome-bearing text sneaks in through the feed.
    expect(
      handle.element.querySelector(".rp-body")?.textContent ?? "",
    ).not.toContain("winner");
  });

  it("renders the reaction row with zero-count badges in live states, never collapsed", () => {
    // Regression for "where are annotations/reactions": with no prior
    // reactions the section must still render the four supported buttons with visible
    // 0-count badges and invite interaction.
    for (const state of ["playing", "checkpoint"] as const) {
      const handle = mount(
        makeModel({
          state,
          canMark: true,
          ...(state === "checkpoint"
            ? { activeCheckpointId: "checkpoint-1" }
            : {}),
        }),
        { onMarker: vi.fn() },
      );
      const buttons = [
        ...handle.element.querySelectorAll<HTMLButtonElement>(
          ".rp-marker-button",
        ),
      ];
      expect(buttons, state).toHaveLength(4);
      for (const button of buttons) {
        expect(button.disabled, state).toBe(false);
        expect(
          button.querySelector(".rp-marker-count")?.textContent,
          state,
        ).toBe("0");
      }
      handle.dispose();
    }
  });

  it("explains a not-yet-connected reaction row instead of leaving it silently dead", () => {
    const handle = mount(makeModel({ state: "playing", canMark: false }), {
      onMarker: vi.fn(),
    });
    const buttons = [
      ...handle.element.querySelectorAll<HTMLButtonElement>(
        ".rp-marker-button",
      ),
    ];
    expect(buttons).toHaveLength(4);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(handle.element.querySelector(".rp-marker-hint")?.textContent).toBe(
      "replay_premiere.reactions_connecting",
    );
  });

  it("shows per-kind own-mark counts and the server-confirmed mark line", () => {
    const handle = mount(
      makeModel({
        state: "playing",
        canMark: true,
        markerCounts: { betrayal: 2 },
        markerConfirmation: { kind: "betrayal", turn: 512 },
      }),
      { onMarker: vi.fn() },
    );
    const betrayal = handle.element.querySelector<HTMLButtonElement>(
      '.rp-marker-button[data-kind="betrayal"]',
    );
    expect(betrayal?.querySelector(".rp-marker-count")?.textContent).toBe("2");
    expect(betrayal?.dataset.marked).toBe("true");
    expect(
      handle.element.querySelector(".rp-marker-confirmed")?.textContent,
    ).toContain("turn=512");
  });

  it("labels aggregate counters as community marks while retaining own state", () => {
    const handle = mount(
      makeModel({
        state: "playing",
        canMark: true,
        markerCounts: { betrayal: 7 },
        ownMarkerCounts: { betrayal: 2 },
        markerParticipantCount: 4,
      }),
      { onMarker: vi.fn() },
    );
    const betrayal = handle.element.querySelector<HTMLButtonElement>(
      '.rp-marker-button[data-kind="betrayal"]',
    );

    expect(
      handle.element.querySelector(".rp-marker-heading")?.textContent,
    ).toBe("replay_premiere.community_marks");
    expect(betrayal?.querySelector(".rp-marker-count")?.textContent).toBe("7");
    expect(betrayal?.dataset.marked).toBe("true");
    expect(betrayal?.getAttribute("aria-label")).toContain(
      "replay_premiere.community_marker_with_count",
    );
    expect(handle.element.querySelector(".rp-marker-scope")?.textContent).toBe(
      "replay_premiere.community_marks_hint:count=4",
    );
  });

  it("labels preserved downgrade-era community counters as last known", () => {
    const handle = mount(
      makeModel({
        state: "playing",
        markerCounts: { betrayal: 7 },
        ownMarkerCounts: { betrayal: 2 },
        markerParticipantCount: 4,
        markerAggregateFresh: false,
      }),
      { onMarker: vi.fn() },
    );

    expect(
      handle.element.querySelector(".rp-marker-heading")?.textContent,
    ).toBe("replay_premiere.community_marks_last_known");
    expect(handle.element.querySelector(".rp-marker-scope")?.textContent).toBe(
      "replay_premiere.community_marks_stale_hint:count=4",
    );
  });

  it("shows the buffering chip as a polite status only while starved", () => {
    const model = makeModel({ state: "playing", buffering: true });
    const handle = mount(model);
    const chip = handle.element.querySelector(".rp-buffering");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("role")).toBe("status");
    expect(chip?.getAttribute("aria-live")).toBe("polite");
    expect(chip?.textContent).toContain("replay_premiere.buffering_live");

    handle.hydrate({ ...model, buffering: false });
    expect(handle.element.querySelector(".rp-buffering")).toBeNull();
  });

  it("never anchors the reveal or results panels at an invisible base state", () => {
    // Regression for the real-page "empty black panel": the entrance
    // animations own their pre-state (keyframes + fill-mode) — the BASE rules
    // must never set opacity:0, or an interrupted/disabled animation leaves
    // the payoff permanently invisible (reduced motion disables them).
    const handle = mount(
      makeModel({
        state: "revealed",
        reveal: {
          outcome: "winner",
          winnerSeatId: "seat-a",
          summary: null,
        },
      }),
    );
    const css = handle.element.querySelector("style")?.textContent ?? "";
    for (const selector of [".rp-reveal {", ".rp-results {"]) {
      const start = css.indexOf(selector);
      expect(start, selector).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf("}", start));
      expect(block).not.toContain("opacity");
    }
    // Reduced motion must fully disable the entrance animations so the
    // panels render at their (visible) base state.
    const reducedMotion = css.slice(
      css.indexOf("prefers-reduced-motion: reduce"),
    );
    expect(reducedMotion).toContain(".rp-reveal,");
    expect(reducedMotion).toContain(".rp-results,");
    expect(reducedMotion).toContain("animation: none !important");
  });

  it("maps unknown public failure input to fixed copy without rendering it", () => {
    const rawFailure =
      "/private/source/replay.json: token=secret Error: stack trace";
    const handle = mount(
      makeModel({
        state: "failed",
        failureCode: rawFailure,
        releasedSequence: 412,
        currentTurn: 730,
      }),
    );

    expect(handle.element.textContent).toContain(
      "replay_premiere.failure_generic",
    );
    // The frozen marker now speaks in viewer turns, not the internal sequence.
    expect(handle.element.textContent).toContain(
      "replay_premiere.playback_stopped_at_turn:turn=730",
    );
    // A terminal premiere is not a dead end: it reassures the outcome stays
    // sealed and offers a route back to the league.
    expect(handle.element.textContent).toContain(
      "replay_premiere.outcome_still_sealed",
    );
    const back = handle.element.querySelector<HTMLAnchorElement>(
      "[data-focus-key=back-to-league]",
    );
    expect(back?.getAttribute("href")).toBe("/league");
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

  it.each(["playing", "checkpoint"] as const)(
    "renders and submits an eligible clip request while %s",
    async (state) => {
      const onRequestClip = vi.fn();
      const handle = mount(
        makeModel({
          state,
          releasedSequence: 418,
          currentTurn: 700,
          clip: { status: "idle", ready: null },
          canRequestClip: true,
        }),
        { onShare: vi.fn(), onRequestClip, onMarker: vi.fn() },
      );
      const request = handle.element.querySelector<HTMLButtonElement>(
        "[data-focus-key=clip-request]",
      );

      expect(handle.element.querySelector(".rp-clip")).not.toBeNull();
      expect(request?.disabled).toBe(false);
      expect(
        handle.element.querySelector("[data-focus-key=timestamp-share]"),
      ).not.toBeNull();
      expect(
        handle.element.querySelector("[data-focus-key=marker-smart]"),
      ).not.toBeNull();

      request?.click();
      await vi.waitFor(() =>
        expect(onRequestClip).toHaveBeenCalledWith({
          premiereId: "premiere-test",
          sequence: 418,
          turn: 700,
        }),
      );
    },
  );

  it.each([
    {
      label: "unavailable",
      clip: null,
      canRequestClip: true,
    },
    {
      label: "flagged off",
      clip: { status: "idle" as const, ready: null },
      canRequestClip: false,
    },
    {
      label: "default off",
      clip: { status: "idle" as const, ready: null },
      canRequestClip: undefined,
    },
  ])("keeps the live clip affordance hidden when $label", (overrides) => {
    const handle = mount(
      makeModel({
        state: "playing",
        releasedSequence: 418,
        currentTurn: 700,
        clip: overrides.clip,
        canRequestClip: overrides.canRequestClip,
      }),
      { onRequestClip: vi.fn() },
    );

    expect(handle.element.querySelector(".rp-clip")).toBeNull();
    expect(
      handle.element.querySelector("[data-focus-key=clip-request]"),
    ).toBeNull();
  });

  it.each([
    {
      label: "preparing",
      clip: { status: "preparing" as const, ready: null },
      visibleSelector: '.rp-clip-status[data-clip-status="preparing"]',
    },
    {
      label: "ready",
      clip: {
        status: "ready" as const,
        ready: { downloadUrl: "/premiere/premiere-test/clip-v1-6.mp4" },
      },
      visibleSelector: "[data-focus-key=clip-download]",
    },
  ])(
    "keeps a $label live clip visible but request-disabled after eligibility drops",
    ({ clip, visibleSelector }) => {
      const onRequestClip = vi.fn();
      const handle = mount(
        makeModel({
          state: "playing",
          releasedSequence: 418,
          currentTurn: 700,
          clip,
          canRequestClip: false,
        }),
        { onRequestClip },
      );
      const request = handle.element.querySelector<HTMLButtonElement>(
        "[data-focus-key=clip-request]",
      );

      expect(handle.element.querySelector(".rp-clip")).not.toBeNull();
      expect(handle.element.querySelector(visibleSelector)).not.toBeNull();
      expect(request?.disabled).toBe(true);
      request?.click();
      expect(onRequestClip).not.toHaveBeenCalled();
    },
  );

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
          accuracyStatus: "scored",
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
          accuracyStatus: "scored",
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

  it("distinguishes a winner with zero votes from a void prediction", () => {
    const reveal = resultsReveal();
    const predictions = reveal.results!.predictions.map((prediction) => ({
      ...prediction,
      correctPercent: null,
      accuracyStatus: "no_predictions" as const,
      totalPredictions: 0,
      options: prediction.options.map((option) => ({ ...option, percent: 0 })),
    }));
    const handle = mount(
      makeModel({
        state: "revealed",
        reveal: {
          ...reveal,
          results: { ...reveal.results!, predictions },
        },
      }),
    );

    expect(handle.element.textContent).toContain(
      "replay_premiere.results_accuracy_no_predictions",
    );
    expect(handle.element.textContent).not.toContain(
      "replay_premiere.results_accuracy_void",
    );
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

  it("shows the current viewer's sealed choice and verdict after reveal", () => {
    const reveal = resultsReveal();
    const predictions = reveal.results!.predictions.map(
      (prediction, index) => ({
        ...prediction,
        selectedSeatId: index === 0 ? "seat-a" : "seat-b",
      }),
    );
    const handle = mount(
      makeModel({
        state: "revealed",
        reveal: {
          ...reveal,
          results: { ...reveal.results!, predictions },
        },
      }),
    );
    const picks = [
      ...handle.element.querySelectorAll<HTMLElement>(
        ".rp-results-personal-pick",
      ),
    ];

    expect(picks).toHaveLength(2);
    expect(picks[0].dataset.verdict).toBe("correct");
    expect(picks[0].textContent).toContain(
      "replay_premiere.results_your_pick_correct:name=Atlas Prime",
    );
    expect(picks[1].dataset.verdict).toBe("incorrect");
    expect(picks[1].textContent).toContain(
      "replay_premiere.results_your_pick_incorrect:name=Borealis",
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

describe("broadcast composition regions (Stage 4 item 1)", () => {
  it("renders the competitor rail, war room feed, and timeline for a live playing premiere", () => {
    const handle = mount(
      makeModel({
        state: "playing",
        releasedSequence: 200,
        currentTurn: 200,
        competitorRailSeats: [
          {
            seatId: "seat-a",
            playerName: "Atlas Prime",
            territoryPercent: 60,
            inMatchRank: 1,
            alive: true,
            allies: ["Borealis"],
            wars: [],
          },
          {
            seatId: "seat-b",
            playerName: "Borealis",
            territoryPercent: 40,
            inMatchRank: 2,
            alive: false,
            allies: ["Atlas Prime"],
            wars: [],
          },
        ],
        warRoomEvents: [
          {
            id: "wr-1",
            kind: "alliance",
            turn: 50,
            sequence: 100,
            headline: "Atlas Prime and Borealis formed an alliance",
            publicReason: null,
            participants: ["Atlas Prime", "Borealis"],
            expandedDetail: null,
          },
        ],
        timelineMarkers: [
          { kind: "spawn", turn: 0, sequence: 0, label: "Match begins" },
          {
            kind: "alliance",
            turn: 50,
            sequence: 100,
            label: "Atlas Prime and Borealis formed an alliance",
          },
        ],
        totalTurns: 200,
        maxSeekableTurn: 200,
      }),
    );

    const rail = handle.element.querySelector(".broadcast-rail");
    expect(rail).not.toBeNull();
    expect(rail?.textContent).toContain("Atlas Prime");
    expect(rail?.textContent).toContain("Borealis");
    const entries = rail?.querySelectorAll(".broadcast-rail-entry") ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[1].textContent).toContain("broadcast.rail_eliminated");
    expect(entries[0].textContent).not.toContain("broadcast.rail_eliminated");

    const warRoom = handle.element.querySelector(".broadcast-war-room");
    expect(warRoom).not.toBeNull();
    expect(warRoom?.textContent).toContain(
      "Atlas Prime and Borealis formed an alliance",
    );

    const timeline = handle.element.querySelector(".broadcast-timeline");
    expect(timeline).not.toBeNull();
    expect(
      timeline?.querySelectorAll(".broadcast-timeline-marker"),
    ).toHaveLength(2);
  });

  it("never makes a live Premiere timeline marker beyond the released turn boundary clickable", () => {
    const onSeek = vi.fn();
    const handle = mount(
      makeModel({
        state: "playing",
        releasedSequence: 100,
        currentTurn: 100,
        timelineMarkers: [
          { kind: "spawn", turn: 0, sequence: 0, label: "Match begins" },
          {
            kind: "elimination",
            turn: 500,
            sequence: 900,
            label: "Beta eliminated",
          },
        ],
        totalTurns: 100,
        maxSeekableTurn: 100,
      }),
      { onSeek },
    );
    const markers = handle.element.querySelectorAll(
      ".broadcast-timeline-marker",
    );
    expect(markers).toHaveLength(2);
    expect(markers[0].tagName).toBe("BUTTON");
    // Beyond the released boundary: a plain SPAN, never a clickable BUTTON —
    // the literal enforcement of "never navigable past the live edge during
    // a Premiere" (spec Stage 4 item 2).
    expect(markers[1].tagName).toBe("SPAN");
    expect((markers[1] as HTMLElement).dataset.seekable).toBe("false");
    (markers[1] as HTMLElement).click();
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("an archived/revealed rewatch gets unrestricted (Full-Replay-style) seeking", () => {
    const onSeek = vi.fn();
    const handle = mount(
      makeModel({
        state: "archived",
        releasedSequence: 999,
        reveal: { outcome: "winner", winnerSeatId: "seat-a" },
        timelineMarkers: [
          { kind: "finish", turn: 5000, sequence: 999, label: "Match finishes" },
        ],
        totalTurns: 5000,
        maxSeekableTurn: null,
      }),
      { onSeek },
    );
    const marker = handle.element.querySelector<HTMLElement>(
      ".broadcast-timeline-marker",
    );
    expect(marker?.tagName).toBe("BUTTON");
    expect(marker?.dataset.seekable).toBe("true");
    marker?.click();
    expect(onSeek).toHaveBeenCalledWith(5000);
  });

  it("resolves registered agent identity into the rail once fetched, and degrades an unmatched seat to its raw name", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        generatedAt: "2026-07-20T20:00:00.000Z",
        lastGoodSyncAt: "2026-07-20T20:00:00.000Z",
        stale: false,
        feedStates: { championFeedStale: false, replayFeedStale: false },
        league: {
          id: "league-1",
          name: "League",
          description: null,
          divisionName: "Open",
          roundIntervalMinutes: null,
          episodesPerRound: null,
          currentRoundNumber: null,
          currentRoundStatus: null,
          scoreLabel: "Score",
        },
        builders: [],
        agents: [
          {
            registered: true,
            id: "agent-1",
            slug: "atlas-prime",
            playerName: "Atlas Prime",
            displayName: "Atlas Prime",
            shortCode: "ATL",
            emblemSvg: "<svg></svg>",
            primaryColor: "#112233",
            secondaryColor: null,
            tagline: null,
            builderId: "builder-1",
            builderDisplayName: "Daveey",
            status: "verified",
            standing: null,
            activeVersion: {
              publicVersionLabel: "v24",
              source: "champion",
              familyMismatch: false,
              firstObservedAt: null,
            },
            provenance: {
              ratingPolicyLabel: null,
              activeChampionPolicyLabel: null,
            },
            stats: null,
          },
        ],
        versions: [],
        rounds: [],
        matches: [],
        featuredMatches: [],
        premieres: { live: null, latest: null },
        links: { enterTheLeagueUrl: "", platformLabel: "", accountUrl: "" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = mount(
      makeModel({
        state: "playing",
        releasedSequence: 10,
        currentTurn: 10,
        competitorRailSeats: [
          {
            seatId: "seat-a",
            playerName: "Atlas Prime",
            territoryPercent: 50,
            inMatchRank: 1,
            alive: true,
            allies: [],
            wars: [],
          },
          {
            seatId: "seat-b",
            playerName: "Unregistered Bot",
            territoryPercent: 50,
            inMatchRank: 2,
            alive: true,
            allies: [],
            wars: [],
          },
        ],
      }),
    );

    await vi.waitFor(() => {
      expect(handle.element.textContent).toContain("v24");
    });
    expect(handle.element.textContent).toContain(
      "broadcast.rail_builder:name=Daveey",
    );
    // An unmatched/unregistered seat renders its raw name — never a fabricated identity.
    expect(handle.element.textContent).toContain("Unregistered Bot");
  });
});

describe("Stage 4 second-half wiring: camera-follow, drawer, analyst mode, lower thirds", () => {
  it("dispatches the shared camera-follow event when a rail seat is clicked, and never automatically", () => {
    const handle = mount(
      makeModel({
        state: "playing",
        competitorRailSeats: [
          {
            seatId: "seat-a",
            playerName: "Atlas Prime",
            territoryPercent: 60,
            inMatchRank: 1,
            alive: true,
            allies: [],
            wars: [],
          },
        ],
      }),
    );
    const followEvents: Array<{ playerName: string }> = [];
    document.addEventListener(BROADCAST_RAIL_FOLLOW_EVENT, (event) => {
      followEvents.push(
        (event as CustomEvent<{ playerName: string }>).detail,
      );
    });
    const seatButton = handle.element.querySelector<HTMLButtonElement>(
      ".broadcast-rail-select",
    );
    expect(seatButton).not.toBeNull();
    expect(followEvents).toHaveLength(0);
    seatButton?.click();
    expect(followEvents).toEqual([{ playerName: "Atlas Prime" }]);
  });

  it("highlights whichever rail seat PointOfViewSelector reports as followed, via the followed-change event, without owning follow state itself", () => {
    const handle = mount(
      makeModel({
        state: "playing",
        competitorRailSeats: [
          {
            seatId: "seat-a",
            playerName: "Atlas Prime",
            territoryPercent: 60,
            inMatchRank: 1,
            alive: true,
            allies: [],
            wars: [],
          },
          {
            seatId: "seat-b",
            playerName: "Borealis",
            territoryPercent: 40,
            inMatchRank: 2,
            alive: true,
            allies: [],
            wars: [],
          },
        ],
      }),
    );
    const entries = () =>
      handle.element.querySelectorAll<HTMLElement>(".broadcast-rail-entry");
    expect(entries()[0].dataset.followed).toBe("false");
    expect(entries()[1].dataset.followed).toBe("false");

    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT, {
        detail: { playerName: "Borealis" },
      }),
    );
    expect(entries()[0].dataset.followed).toBe("false");
    expect(entries()[1].dataset.followed).toBe("true");

    document.dispatchEvent(
      new CustomEvent(BROADCAST_RAIL_FOLLOWED_CHANGE_EVENT, {
        detail: { playerName: null },
      }),
    );
    expect(entries()[1].dataset.followed).toBe("false");
  });

  it("switches the drawer's active tab on a tab click; every panel (including analysis) is always mounted in the DOM", () => {
    const handle = mount(makeModel({ state: "playing" }));
    const tabs = () =>
      handle.element.querySelectorAll<HTMLButtonElement>(
        ".broadcast-drawer-tab",
      );
    expect([...tabs()].map((tab) => tab.dataset.tabId)).toEqual([
      "agents",
      "events",
      "timeline",
      "analysis",
    ]);
    const panelFor = (id: string) =>
      handle.element.querySelector<HTMLElement>(
        `.broadcast-drawer-panel[data-tab-id="${id}"]`,
      );
    expect(panelFor("agents")?.dataset.tabActive).toBe("true");
    expect(panelFor("analysis")?.dataset.tabActive).toBe("false");

    const analysisTab = [...tabs()].find(
      (tab) => tab.dataset.tabId === "analysis",
    );
    analysisTab?.click();

    expect(panelFor("agents")?.dataset.tabActive).toBe("false");
    expect(panelFor("analysis")?.dataset.tabActive).toBe("true");
  });

  it("toggles analyst mode from the desktop header control (aria-pressed conveys state), independent of the drawer's active tab", () => {
    const handle = mount(makeModel({ state: "playing" }));
    expect(handle.element.dataset.analystMode).toBe("false");
    const toggle = () =>
      handle.element.querySelector<HTMLButtonElement>(".rp-analyst-toggle");
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(toggle()?.textContent).toContain("broadcast.analyst_heading");

    toggle()?.click();

    expect(handle.element.dataset.analystMode).toBe("true");
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("never renders the analyst toggle in states with no drawer", () => {
    for (const state of ["scheduled", "failed", "cancelled"] as const) {
      const handle = mount(
        makeModel({
          state,
          failureCode: state === "failed" ? "integrity_failure" : null,
        }),
      );
      expect(handle.element.querySelector(".rp-analyst-toggle")).toBeNull();
    }
  });

  it("analyst mode always reports decisions as sealed/unavailable, never a decision table, in every drawer-bearing state — the one invariant that must never regress", () => {
    const cases: Array<Partial<ReplayPremiereOverlayModel>> = [
      { state: "playing" },
      { state: "checkpoint" },
      { state: "revealed", reveal: resultsReveal() },
      { state: "archived", reveal: resultsReveal() },
    ];
    for (const overrides of cases) {
      const handle = mount(makeModel(overrides));
      const analyst = handle.element.querySelector(".broadcast-analyst");
      expect(analyst).not.toBeNull();
      expect(
        analyst?.querySelector(".broadcast-analyst-decisions-table"),
      ).toBeNull();
      expect(analyst?.textContent).toContain(
        "broadcast.analyst_unavailable_premiere_sealed",
      );
    }
  });

  it("fires a lower-third pulse over the map for a newly curated War Room event", () => {
    mount(
      makeModel({
        state: "playing",
        warRoomEvents: [
          {
            id: "wr-1",
            kind: "alliance",
            turn: 10,
            sequence: 5,
            headline: "Atlas Prime and Borealis formed an alliance",
            publicReason: null,
            participants: ["Atlas Prime", "Borealis"],
            expandedDetail: null,
          },
        ],
      }),
    );
    const host = document.getElementById(
      "replay-premiere-lower-third-host",
    );
    expect(host).not.toBeNull();
    const card = host?.querySelector(".broadcast-lower-third");
    expect(card?.getAttribute("data-kind")).toBe("alliance");
    expect(card?.textContent).toContain(
      "Atlas Prime and Borealis formed an alliance",
    );
  });

  it("fires the synthetic finish lower-third exactly once a verified reveal exists, reusing the same reveal headline the results card renders", () => {
    mount(makeModel({ state: "revealed", reveal: resultsReveal() }));
    const host = document.getElementById(
      "replay-premiere-lower-third-host",
    );
    const card = host?.querySelector(
      '.broadcast-lower-third[data-kind="finish"]',
    );
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("replay_premiere.winner");
  });

  it("de-dupes a lower-third pulse across repeated hydrates of the same curated event, and disposes the host on teardown", () => {
    vi.useFakeTimers();
    try {
      const warRoomEvents = [
        {
          id: "wr-1",
          kind: "alliance" as const,
          turn: 10,
          sequence: 5,
          headline: "Atlas Prime and Borealis formed an alliance",
          publicReason: null,
          participants: ["Atlas Prime", "Borealis"],
          expandedDetail: null,
        },
      ];
      const handle = mount(
        makeModel({ state: "playing", warRoomEvents }),
      );
      const host = () =>
        document.getElementById("replay-premiere-lower-third-host");
      expect(host()?.querySelector(".broadcast-lower-third")).not.toBeNull();
      vi.advanceTimersByTime(5000);
      expect(host()?.querySelector(".broadcast-lower-third")).toBeNull();
      handle.hydrate(makeModel({ state: "playing", warRoomEvents }));
      expect(host()?.querySelector(".broadcast-lower-third")).toBeNull();
      handle.dispose();
      expect(host()).toBeNull();
    } finally {
      vi.useRealTimers();
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
    competitorRailSeats: [],
    warRoomEvents: [],
    timelineMarkers: [],
    totalTurns: 1,
    maxSeekableTurn: 0,
    analystEvents: [],
    analystActionKindCounts: [],
    analystDecisionsUnavailableReason: "premiere_sealed",
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
