import { afterEach, describe, expect, it } from "vitest";
import {
  decisionsFromSpectatorSnapshots,
  publishReplayDecisions,
  replayDecisions,
} from "../../src/client/ReplayDecisionStore";
import {
  clearSpectatorReplay,
  publishSpectatorReplay,
  spectatorReplaySnapshots,
} from "../../src/client/SpectatorReplayStore";

/**
 * The hosted route's half of the WHY surfaces.
 *
 * `openAiLeagueReplay` now fetches `spectator-replay.json` beside the game
 * record and pushes it through exactly this chain: publish the envelope, read
 * the series back, adapt it to decisions. The static bundle got that for free
 * because the envelope arrives inline; `/ai-league-replay/` fetches the file
 * the mirror has been publishing all along.
 *
 * The fixture is the real published shape (verified against a league mirror
 * artifact): a top-level `snapshots` array whose entries carry `turnNumber`,
 * `players` and `decisions`. If the store's validator ever stops accepting it,
 * the analyst drawer, the dossier's decision line and the toast reasons go
 * quiet on the hosted plane with nothing else failing — so it is asserted here
 * rather than left to a visual check.
 */
function snapshot(turnNumber: number, username: string, reason: string) {
  return {
    turnNumber,
    tick: turnNumber,
    phase: "main",
    label: `T${turnNumber}`,
    players: [
      {
        username,
        agentID: "opportunistic-agent-1",
        playerID: "p3",
        tilesOwned: 52 + turnNumber,
        troops: 4200,
        gold: 217000,
        color: "#8cc62f",
      },
    ],
    decisions: [
      {
        sequence: turnNumber,
        agentID: "opportunistic-agent-1",
        username,
        turnNumber,
        selectedLegalActionId: `attack:${turnNumber}`,
        selectedActionKind: "attack",
        reason,
      },
    ],
  };
}

const HOSTED_ENVELOPE = {
  schemaVersion: 1,
  runID: "league-coworld-2026-08-15T23-20-11-358Z-f7195ab9",
  replayKind: "proxywar-coworld-local-poc",
  snapshots: [
    snapshot(
      400,
      "salomon shdow",
      "weakest bordering nation, and my troops recovered",
    ),
    snapshot(
      800,
      "salomon shdow",
      "holding the isthmus is worth more than the coast",
    ),
  ],
};

describe("hosted broadcast side artifacts", () => {
  afterEach(() => {
    clearSpectatorReplay();
    publishReplayDecisions([]);
  });

  it("turns the published spectator-replay.json into decisions the WHY surfaces read", () => {
    clearSpectatorReplay();
    publishSpectatorReplay(HOSTED_ENVELOPE);

    const snapshots = spectatorReplaySnapshots();
    expect(snapshots).not.toBeNull();
    expect(snapshots).toHaveLength(2);

    const decisions = decisionsFromSpectatorSnapshots(snapshots);
    expect(decisions).toHaveLength(2);
    expect(decisions[0].username).toBe("salomon shdow");
    expect(decisions[0].turnNumber).toBe(400);
    expect(decisions[0].reason).toContain("weakest bordering nation");
  });

  it("survives the clear-then-refill order the hosted open path uses", () => {
    // A previous match's log must not outlive it, but the wipe is only safe
    // because the refill lands right behind it — that ordering is the whole
    // reason the hosted route showed an empty analyst drawer before.
    publishSpectatorReplay({
      snapshots: [
        snapshot(1, "previous match", "stale"),
        snapshot(2, "previous match", "stale"),
      ],
    });
    publishReplayDecisions(
      decisionsFromSpectatorSnapshots(spectatorReplaySnapshots()),
    );
    expect(replayDecisions()).toHaveLength(2);
    expect(replayDecisions()[0].username).toBe("previous match");

    clearSpectatorReplay();
    publishSpectatorReplay(HOSTED_ENVELOPE);
    publishReplayDecisions(
      decisionsFromSpectatorSnapshots(spectatorReplaySnapshots()),
    );

    const decisions = replayDecisions();
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.username === "salomon shdow")).toBe(true);
  });

  it("leaves the surfaces empty, not broken, when the artifact is missing", () => {
    // A rotated-off-the-mirror or still-filling premiere replay legitimately
    // has no envelope. `fetchBroadcastSideArtifact` answers null, nothing is
    // published, and the board still plays; the drawer self-hides on an empty
    // log rather than opening onto nothing.
    clearSpectatorReplay();
    publishReplayDecisions(
      decisionsFromSpectatorSnapshots(spectatorReplaySnapshots()),
    );
    expect(spectatorReplaySnapshots()).toBeNull();
    expect(replayDecisions()).toHaveLength(0);
  });

  it("needs two samples before it is a series at all", () => {
    // The store is also the race graph's source, and one point is not a
    // series — so it rejects a single-snapshot envelope outright and the
    // decisions inside it are lost with it. Real league artifacts carry ~25,
    // but a match captured before its second sample lands has no WHY data on
    // EITHER plane. Pinned so a future "why is the drawer empty on a short
    // match" question has an answer that is not a bug hunt.
    clearSpectatorReplay();
    publishSpectatorReplay({
      snapshots: [snapshot(400, "salomon shdow", "the only sample")],
    });
    expect(spectatorReplaySnapshots()).toBeNull();
    expect(
      decisionsFromSpectatorSnapshots(spectatorReplaySnapshots()),
    ).toHaveLength(0);
  });
});
