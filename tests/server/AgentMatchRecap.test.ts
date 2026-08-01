import { describe, expect, it } from "vitest";
import {
  buildAgentMatchRecap,
  type AgentMatchRecapBeat,
} from "../../src/server/agents/AgentMatchRecap";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import { buildAgentDramaReport } from "../../src/server/agents/AgentDramaReport";
import type { AgentDecisionRecord, LegalActionKind } from "../../src/server/agents/AgentTypes";
import type { AgentRunFinalState } from "../../src/server/agents/AgentDecisionLogWriter";

// Same synthetic-record/finalState convention `DirectorCutPlan.test.ts`
// already established — `buildAgentSpectatorTelemetry` is the real,
// unmocked producer of the `SpectatorEvent[]` `buildAgentMatchRecap`
// consumes, so these fixtures exercise the actual event-derivation pipeline,
// not a hand-rolled telemetry stub.

function record(
  sequence: number,
  turnNumber: number,
  agentID: string,
  username: string,
  playerID: string,
  kind: LegalActionKind,
  metadata: Record<string, string | number | boolean | null> = {},
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "MATCH-RECAP",
    agentID,
    clientID: `client-${agentID}`,
    username,
    profile: "diplomatic",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 12,
    observationSummary: `${username} sees the board`,
    legalActionIDs: [`${kind}:${sequence}`],
    legalActionIDsByKind: { [kind]: [`${kind}:${sequence}`] },
    attackActionIDs: kind === "attack" ? [`${kind}:${sequence}`] : [],
    chosenActionID: `${kind}:${sequence}`,
    chosenActionKind: kind,
    reason: `${username} selects ${kind}`,
    chosenActionMetadata: metadata,
    intent: null,
    result: { accepted: true, reason: "ok", submittedIntent: null },
    fallbackUsed: false,
  } as AgentDecisionRecord;
}

const ROSTER = [
  { agentID: "a1", username: "Atlas", profile: "diplomatic" as const, clientID: "c1", brainType: "planner-executor" as const },
  { agentID: "a2", username: "Blitz", profile: "aggressive" as const, clientID: "c2", brainType: "planner-executor" as const },
  { agentID: "a3", username: "Cinder", profile: "opportunistic" as const, clientID: "c3", brainType: "planner-executor" as const },
];

function finalState(
  totalTurns: number,
  players: { agentID: string; username: string; isAlive: boolean }[],
): AgentRunFinalState {
  return {
    phase: "finished",
    tick: totalTurns,
    turnCount: totalTurns,
    players: players.map((p) => ({
      agentID: p.agentID,
      username: p.username,
      profile: "diplomatic",
      playerID: `p-${p.agentID}`,
      isAlive: p.isAlive,
      tilesOwned: p.isAlive ? 100 : 0,
      troops: p.isAlive ? 2000 : 0,
      gold: "500",
    })),
  };
}

/** Alliance, a first strike, a repeat attack on the same pair (must NOT re-trigger first strike), a betrayal, a late-match repeat attack inside the endgame window (the final confrontation candidate), and an elimination at match end. */
function dramaticRecords(totalTurns: number): AgentDecisionRecord[] {
  return [
    record(1, 500, "a1", "Atlas", "p-a1", "alliance_request", {
      recipientID: "p-a2",
      recipientName: "Blitz",
    }),
    record(2, 501, "a2", "Blitz", "p-a2", "alliance_request", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }),
    record(3, 2000, "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
    record(4, 2100, "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
    record(5, 5000, "a2", "Blitz", "p-a2", "break_alliance", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }),
    record(6, totalTurns - 100, "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
  ];
}

describe("buildAgentMatchRecap", () => {
  it("curates the War Room vocabulary: alliance, first strike (once per pair), betrayal, final confrontation, and elimination", () => {
    const totalTurns = 10_000;
    const records = dramaticRecords(totalTurns);
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-1",
      records,
      roster: ROSTER,
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
        { agentID: "a3", username: "Cinder", isAlive: false },
      ]),
    });
    const recap = buildAgentMatchRecap({
      runID: "run-1",
      telemetry,
      finalTurnCount: totalTurns,
      series: null,
    });
    expect(recap).not.toBeNull();
    const kinds = recap?.beats.map((beat) => beat.kind);
    expect(kinds).toEqual([
      "alliance",
      "first_strike",
      "betrayal",
      "final_confrontation",
      "elimination",
    ]);
    const turns = recap?.beats.map((beat) => beat.turnNumber);
    expect(turns).toEqual([501, 2000, 5000, totalTurns - 100, totalTurns]);
    expect(recap?.beats[1].message).toBe("Blitz strikes first against Cinder.");
    expect(recap?.beats[3].message).toContain("Final clash:");
    expect(recap?.beats[4].message).toBe("Cinder is eliminated.");
    expect(recap?.summary.length).toBeGreaterThan(0);
    // Never a second first-strike beat for the repeat a2->a3 attack at turn 2100.
    const firstStrikeCount = recap?.beats.filter(
      (beat: AgentMatchRecapBeat) => beat.kind === "first_strike",
    ).length;
    expect(firstStrikeCount).toBe(1);
  });

  it("returns null — never a padded placeholder — for a match with no story-worthy events", () => {
    const totalTurns = 1000;
    const records = [
      record(1, 1, "a1", "Atlas", "p-a1", "spawn"),
      record(2, 2, "a2", "Blitz", "p-a2", "spawn"),
      record(3, 50, "a1", "Atlas", "p-a1", "hold"),
      record(4, 60, "a2", "Blitz", "p-a2", "attack", { expansion: true }),
    ];
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-quiet",
      records,
      roster: ROSTER.slice(0, 2),
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
      ]),
    });
    const recap = buildAgentMatchRecap({
      runID: "run-quiet",
      telemetry,
      finalTurnCount: totalTurns,
      series: null,
    });
    expect(recap).toBeNull();
  });

  it("is deterministic — identical input produces identical beats/summary", () => {
    const totalTurns = 10_000;
    const records = dramaticRecords(totalTurns);
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-det",
      records,
      roster: ROSTER,
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
        { agentID: "a3", username: "Cinder", isAlive: false },
      ]),
    });
    const input = { runID: "run-det", telemetry, finalTurnCount: totalTurns, series: null };
    const first = buildAgentMatchRecap(input);
    const second = buildAgentMatchRecap(input);
    expect(first?.beats).toEqual(second?.beats);
    expect(first?.summary).toEqual(second?.summary);
  });

  it("falls back to the telemetry's own max event turn when finalTurnCount is null", () => {
    const records = [
      record(1, 100, "a1", "Atlas", "p-a1", "alliance_request", {
        recipientID: "p-a2",
        recipientName: "Blitz",
      }),
      record(2, 101, "a2", "Blitz", "p-a2", "alliance_request", {
        recipientID: "p-a1",
        recipientName: "Atlas",
      }),
    ];
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-degraded",
      records,
      roster: ROSTER.slice(0, 2),
      // finalState IS supplied so target-agent resolution works (playerID
      // needs a source — see AgentSpectatorTelemetry.ts's
      // `playerIDFromRecords` fallback, which this fixture's records don't
      // populate via `audit`); the point of this test is `finalTurnCount:
      // null` below overriding buildAgentMatchRecap's OWN fallback, not
      // whatever turnCount `finalState` happens to carry.
      finalState: finalState(9999, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
      ]),
    });
    const recap = buildAgentMatchRecap({
      runID: "run-degraded",
      telemetry,
      finalTurnCount: null,
      series: null,
    });
    expect(recap).not.toBeNull();
    expect(recap?.beats).toEqual([
      {
        turnNumber: 101,
        kind: "alliance",
        message: "Blitz and Atlas form an alliance.",
      },
    ]);
  });

  it("aggregates same-pair alliance churn, resets on betrayal, and caps public beats without ever dropping a betrayal (2026-08-01 live-verification fix)", () => {
    const totalTurns = 50_000;
    const records: AgentDecisionRecord[] = [];
    let sequence = 0;

    // Alliance churn: c1<->c2 re-request an alliance 5 times with NO
    // intervening break — must aggregate into ONE beat anchored at the
    // first formation (turn 100), "renewed 4 times through turn 104".
    for (let i = 0; i < 5; i++) {
      const turn = 100 + i * 5;
      sequence += 1;
      records.push(
        record(sequence, turn, "c1", "Cobalt", "p-c1", "alliance_request", {
          recipientID: "p-c2",
          recipientName: "Copper",
        }),
      );
      sequence += 1;
      records.push(
        record(sequence, turn + 1, "c2", "Copper", "p-c2", "alliance_request", {
          recipientID: "p-c1",
          recipientName: "Cobalt",
        }),
      );
    }

    // Two real betrayal arcs (form once, break once) — d-pair at turn
    // ~200/250, e-pair at turn ~300/350. Both betrayal beats and both
    // (unaggregated, count=1) alliance beats must survive the cap.
    for (const [pair, formTurn, breakTurn] of [
      [["d1", "Delta", "d2", "Echo"], 200, 250],
      [["e1", "Foxtrot", "e2", "Golf"], 300, 350],
    ] as const) {
      const [aID, aName, bID, bName] = pair;
      sequence += 1;
      records.push(
        record(sequence, formTurn, aID, aName, `p-${aID}`, "alliance_request", {
          recipientID: `p-${bID}`,
          recipientName: bName,
        }),
      );
      sequence += 1;
      records.push(
        record(sequence, formTurn + 1, bID, bName, `p-${bID}`, "alliance_request", {
          recipientID: `p-${aID}`,
          recipientName: aName,
        }),
      );
      sequence += 1;
      records.push(
        record(sequence, breakTurn, aID, aName, `p-${aID}`, "break_alliance", {
          recipientID: `p-${bID}`,
          recipientName: bName,
        }),
      );
    }

    // 18 distinct ordered first-strike pairs (b1..b18 -> victim), turns
    // 1000, 1010, ... 1170 — enough to exceed the cap on their own once
    // combined with the 3 alliance beats above (3 + 18 = 21 trimmable
    // candidates, remaining budget after 2 never-trimmed betrayals is 14).
    const attackerIDs: string[] = [];
    for (let i = 1; i <= 18; i++) {
      const attackerID = `b${i}`;
      attackerIDs.push(attackerID);
      sequence += 1;
      records.push(
        record(sequence, 1000 + (i - 1) * 10, attackerID, `Bandit${i}`, `p-${attackerID}`, "attack", {
          targetID: "p-victim",
          targetName: "Victim",
        }),
      );
    }

    const roster = [
      { agentID: "c1", username: "Cobalt", profile: "diplomatic" as const, clientID: "cc1", brainType: "planner-executor" as const },
      { agentID: "c2", username: "Copper", profile: "diplomatic" as const, clientID: "cc2", brainType: "planner-executor" as const },
      { agentID: "d1", username: "Delta", profile: "diplomatic" as const, clientID: "cd1", brainType: "planner-executor" as const },
      { agentID: "d2", username: "Echo", profile: "diplomatic" as const, clientID: "cd2", brainType: "planner-executor" as const },
      { agentID: "e1", username: "Foxtrot", profile: "diplomatic" as const, clientID: "ce1", brainType: "planner-executor" as const },
      { agentID: "e2", username: "Golf", profile: "diplomatic" as const, clientID: "ce2", brainType: "planner-executor" as const },
      { agentID: "victim", username: "Victim", profile: "defensive" as const, clientID: "cv", brainType: "planner-executor" as const },
      ...attackerIDs.map((id, i) => ({
        agentID: id,
        username: `Bandit${i + 1}`,
        profile: "aggressive" as const,
        clientID: `c${id}`,
        brainType: "planner-executor" as const,
      })),
    ];
    const players = roster.map((entry) => ({
      agentID: entry.agentID,
      username: entry.username,
      isAlive: true,
    }));

    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-churn",
      records,
      roster,
      finalState: finalState(totalTurns, players),
    });
    const build = () =>
      buildAgentMatchRecap({ runID: "run-churn", telemetry, finalTurnCount: totalTurns, series: null });
    const recap = build();
    expect(recap).not.toBeNull();
    if (recap === null) return;

    // Cap respected.
    expect(recap.beats.length).toBe(16);

    // Betrayals never dropped, and never aggregated away.
    const betrayalBeats = recap.beats.filter((beat) => beat.kind === "betrayal");
    expect(betrayalBeats.length).toBe(2);
    expect(betrayalBeats.map((beat) => beat.turnNumber)).toEqual([250, 350]);

    // Alliance churn aggregated into one beat with a "renewed" count; the
    // two form-then-break pairs stay unaggregated (count 1, no "renewed"
    // suffix) since each only formed once before its betrayal.
    const allianceBeats = recap.beats.filter((beat) => beat.kind === "alliance");
    expect(allianceBeats.length).toBe(3);
    expect(allianceBeats.map((beat) => beat.turnNumber)).toEqual([101, 201, 301]);
    expect(allianceBeats[0].message).toBe(
      "Copper and Cobalt form an alliance (renewed 8 times through turn 121).",
    );
    expect(allianceBeats[1].message).toBe("Echo and Delta form an alliance.");
    expect(allianceBeats[2].message).toBe("Golf and Foxtrot form an alliance.");

    // First strikes trimmed to fit the remaining budget (16 - 2 betrayals
    // - 3 alliances = 11), earliest-turn-first, never re-ordered.
    const firstStrikeBeats = recap.beats.filter((beat) => beat.kind === "first_strike");
    expect(firstStrikeBeats.length).toBe(11);
    expect(firstStrikeBeats.map((beat) => beat.turnNumber)).toEqual([
      1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100,
    ]);

    // Chronological ordering of the final trimmed list.
    const turns = recap.beats.map((beat) => beat.turnNumber);
    expect(turns).toEqual([...turns].sort((a, b) => a - b));

    // The summary line reports the FULL raw counts (9+1+1=11 alliance
    // formations — c1/c2's repeated re-requests each independently
    // re-trigger `alliance_formed` once both directions have ever been
    // pending, a real `AgentSpectatorTelemetry.ts` characteristic, not
    // something this module fabricates — 2 betrayals, 18 first strikes),
    // independent of how many beats survived the cap — "nothing is hidden".
    expect(recap.summary).toBe(
      "This match featured 11 alliances, 2 betrayals and 18 first strikes.",
    );

    // Determinism.
    const second = build();
    expect(second?.beats).toEqual(recap.beats);
    expect(second?.summary).toEqual(recap.summary);
  });
});

describe("curatedDramaScore", () => {
  // The discriminating assertion this whole fix exists for: the legacy
  // `AgentDramaReport.dramaScore` saturates at 100 on raw, un-deduped
  // alliance-churn event counts (see `AgentDramaReport.ts`'s own
  // 2026-08-01 doc — a real production match hit 37 same-pair
  // reformations and saturated almost from `allianceFormedCount * 8`
  // alone), while `curatedDramaScore` — computed from the SAME deduped
  // beats the public recap shows — must score that exact scenario LOW,
  // and a genuinely dramatic multi-pair betrayal-heavy match HIGH.
  it("scores pure same-pair alliance churn LOW even though the legacy dramaScore saturates at 100", () => {
    const totalTurns = 20_000;
    const records: AgentDecisionRecord[] = [];
    let sequence = 0;
    // 37 reciprocal alliance re-requests between the SAME pair, no
    // intervening break — mirrors the real production churn match
    // `AgentDramaReport.ts`'s doc describes. No attacks, no eliminations,
    // no other agents: every raw `alliance_formed` event this produces
    // belongs to the one aggregated pair.
    for (let i = 0; i < 37; i++) {
      const turn = 100 + i * 5;
      sequence += 1;
      records.push(
        record(sequence, turn, "p1", "Pact1", "p-p1", "alliance_request", {
          recipientID: "p-p2",
          recipientName: "Pact2",
        }),
      );
      sequence += 1;
      records.push(
        record(sequence, turn + 1, "p2", "Pact2", "p-p2", "alliance_request", {
          recipientID: "p-p1",
          recipientName: "Pact1",
        }),
      );
    }
    const roster = [
      { agentID: "p1", username: "Pact1", profile: "diplomatic" as const, clientID: "cp1", brainType: "planner-executor" as const },
      { agentID: "p2", username: "Pact2", profile: "diplomatic" as const, clientID: "cp2", brainType: "planner-executor" as const },
    ];
    const players = roster.map((entry) => ({ agentID: entry.agentID, username: entry.username, isAlive: true }));
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-pure-churn",
      records,
      roster,
      finalState: finalState(totalTurns, players),
    });
    const dramaReport = buildAgentDramaReport({
      runID: "run-pure-churn",
      matchID: "run-pure-churn",
      scenario: "test",
      brainMode: "planner-executor",
      records,
      roster,
      finalState: finalState(totalTurns, players),
    });
    // Sanity: this fixture really does reproduce the known saturation bug.
    expect(dramaReport.allianceFormedCount).toBeGreaterThan(12);
    expect(dramaReport.dramaScore).toBe(100);
    expect(dramaReport.dramaGrade).toBe("dramatic");

    const recap = buildAgentMatchRecap({ runID: "run-pure-churn", telemetry, finalTurnCount: totalTurns, series: null });
    expect(recap).not.toBeNull();
    if (recap === null) return;
    // One aggregated alliance pair, nothing else — the curated score must
    // NOT inherit the legacy metric's saturation.
    expect(recap.beats.filter((b) => b.kind === "alliance").length).toBe(1);
    expect(recap.curatedDramaScore).toBeLessThanOrEqual(15);
    expect(recap.curatedDramaScore).toBeLessThan(dramaReport.dramaScore);
  });

  it("scores a genuine multi-pair betrayal-heavy match HIGH", () => {
    const totalTurns = 20_000;
    const records: AgentDecisionRecord[] = [];
    let sequence = 0;

    // Four distinct betrayal arcs (form once, break once) across four
    // separate pairs — real, non-churned political beats.
    const betrayalPairs: readonly [string, string, string, string][] = [
      ["b1", "Bishop1", "b2", "Bishop2"],
      ["b3", "Bishop3", "b4", "Bishop4"],
      ["b5", "Bishop5", "b6", "Bishop6"],
      ["b7", "Bishop7", "b8", "Bishop8"],
    ];
    let arcTurn = 1000;
    for (const [aID, aName, bID, bName] of betrayalPairs) {
      sequence += 1;
      records.push(record(sequence, arcTurn, aID, aName, `p-${aID}`, "alliance_request", { recipientID: `p-${bID}`, recipientName: bName }));
      sequence += 1;
      records.push(record(sequence, arcTurn + 1, bID, bName, `p-${bID}`, "alliance_request", { recipientID: `p-${aID}`, recipientName: aName }));
      sequence += 1;
      records.push(record(sequence, arcTurn + 50, aID, aName, `p-${aID}`, "break_alliance", { recipientID: `p-${bID}`, recipientName: bName }));
      arcTurn += 100;
    }

    // Six distinct first-strike attackers against one victim, plus a
    // repeat attack from the first attacker late in the match, inside the
    // final-confrontation window (last 400 of 20,000 turns).
    const attackerIDs = ["f1", "f2", "f3", "f4", "f5", "f6"];
    attackerIDs.forEach((attackerID, i) => {
      sequence += 1;
      records.push(record(sequence, 2000 + i * 10, attackerID, `Foe${i + 1}`, `p-${attackerID}`, "attack", { targetID: "p-victim", targetName: "Victim" }));
    });
    sequence += 1;
    records.push(record(sequence, totalTurns - 300, "f1", "Foe1", "p-f1", "attack", { targetID: "p-victim", targetName: "Victim" }));

    const roster = [
      ...betrayalPairs.flatMap(([aID, aName, bID, bName]) => [
        { agentID: aID, username: aName, profile: "diplomatic" as const, clientID: `c${aID}`, brainType: "planner-executor" as const },
        { agentID: bID, username: bName, profile: "diplomatic" as const, clientID: `c${bID}`, brainType: "planner-executor" as const },
      ]),
      { agentID: "victim", username: "Victim", profile: "defensive" as const, clientID: "cv", brainType: "planner-executor" as const },
      ...attackerIDs.map((id, i) => ({ agentID: id, username: `Foe${i + 1}`, profile: "aggressive" as const, clientID: `c${id}`, brainType: "planner-executor" as const })),
      { agentID: "e1", username: "Elim1", profile: "defensive" as const, clientID: "ce1", brainType: "planner-executor" as const },
      { agentID: "e2", username: "Elim2", profile: "defensive" as const, clientID: "ce2", brainType: "planner-executor" as const },
      { agentID: "e3", username: "Elim3", profile: "defensive" as const, clientID: "ce3", brainType: "planner-executor" as const },
    ];
    const players = roster.map((entry) => ({
      agentID: entry.agentID,
      username: entry.username,
      isAlive: !["e1", "e2", "e3"].includes(entry.agentID),
    }));
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-betrayal-heavy",
      records,
      roster,
      finalState: finalState(totalTurns, players),
    });
    const recap = buildAgentMatchRecap({ runID: "run-betrayal-heavy", telemetry, finalTurnCount: totalTurns, series: null });
    expect(recap).not.toBeNull();
    if (recap === null) return;
    expect(recap.beats.filter((b) => b.kind === "betrayal").length).toBe(4);
    expect(recap.beats.filter((b) => b.kind === "elimination").length).toBe(3);
    expect(recap.beats.some((b) => b.kind === "final_confrontation")).toBe(true);
    expect(recap.curatedDramaScore).toBeGreaterThanOrEqual(90);
    expect(recap.curatedDramaScore).toBeLessThanOrEqual(100);
  });

  it("ships a non-empty, formula-describing methodology string", () => {
    const totalTurns = 10_000;
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-methodology",
      records: dramaticRecords(totalTurns),
      roster: ROSTER,
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
        { agentID: "a3", username: "Cinder", isAlive: false },
      ]),
    });
    const recap = buildAgentMatchRecap({ runID: "run-methodology", telemetry, finalTurnCount: totalTurns, series: null });
    expect(recap).not.toBeNull();
    if (recap === null) return;
    expect(recap.curatedDramaScoreMethodology.length).toBeGreaterThan(20);
    expect(recap.curatedDramaScoreMethodology).toContain("betrayal");
  });
});
