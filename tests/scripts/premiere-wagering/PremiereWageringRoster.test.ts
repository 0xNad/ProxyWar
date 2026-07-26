import { describe, expect, test } from "vitest";
import {
  fetchActiveLeagueRoster,
  PremiereWageringRosterError,
  type CoworldJsonInvoker,
} from "../../../src/scripts/premiere-wagering/PremiereWageringRoster";

const LEAGUE_RAW = { id: "league_abc", name: "Proxy War" };
const DIVISIONS_RAW = [
  { id: "div_1", name: "Open", level: 1, member_count: 12 },
];

function membershipRow(
  policyVersionId: string,
  label: string,
  playerId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    status: "competing",
    substatus: "active",
    is_champion: true,
    end_time: null,
    start_time: "2026-07-01T00:00:00.000Z",
    policy_version: {
      id: policyVersionId,
      label,
      player_id: playerId,
    },
    player: { id: playerId, username: `player-${playerId}` },
    ...overrides,
  };
}

function fakeCoworldJson(memberships: unknown[]): CoworldJsonInvoker {
  return async (args: string[]) => {
    if (args[0] === "leagues") return LEAGUE_RAW;
    if (args[0] === "results") return DIVISIONS_RAW;
    if (args[0] === "memberships") return memberships;
    throw new Error(`unexpected verb ${args[0]}`);
  };
}

describe("fetchActiveLeagueRoster", () => {
  test("seats every active champion policy — not a sample", async () => {
    const memberships = [
      membershipRow("pv_1", "policy-a:v1", "player_1"),
      membershipRow("pv_2", "policy-b:v3", "player_2"),
      membershipRow("pv_3", "policy-c:v2", "player_3"),
    ];
    const roster = await fetchActiveLeagueRoster({
      leagueId: "league_abc",
      coworldJson: fakeCoworldJson(memberships),
    });
    expect(roster.seats).toHaveLength(3);
    expect(roster.seats.map((s) => s.policyVersionId).sort()).toEqual([
      "pv_1",
      "pv_2",
      "pv_3",
    ]);
    expect(roster.divisionId).toBe("div_1");
  });

  test("excludes non-competing, inactive, non-champion, and ended memberships", async () => {
    const memberships = [
      membershipRow("pv_active", "a:v1", "p1"),
      membershipRow("pv_not_competing", "b:v1", "p2", { status: "pending" }),
      membershipRow("pv_inactive_sub", "c:v1", "p3", { substatus: "paused" }),
      membershipRow("pv_not_champion", "d:v1", "p4", { is_champion: false }),
      membershipRow("pv_ended", "e:v1", "p5", {
        end_time: "2026-07-01T00:00:00.000Z",
      }),
    ];
    const roster = await fetchActiveLeagueRoster({
      leagueId: "league_abc",
      coworldJson: fakeCoworldJson(memberships),
    });
    expect(roster.seats.map((s) => s.policyVersionId)).toEqual(["pv_active"]);
  });

  test("de-duplicates by policyVersionId across multiple membership rows for the same policy", async () => {
    const memberships = [
      membershipRow("pv_dup", "dup:v1", "p1"),
      membershipRow("pv_dup", "dup:v1", "p1", {
        start_time: "2026-06-01T00:00:00.000Z",
      }),
    ];
    const roster = await fetchActiveLeagueRoster({
      leagueId: "league_abc",
      coworldJson: fakeCoworldJson(memberships),
    });
    expect(roster.seats).toHaveLength(1);
  });

  test("throws rather than seating a zero-policy roster", async () => {
    await expect(
      fetchActiveLeagueRoster({
        leagueId: "league_abc",
        coworldJson: fakeCoworldJson([]),
      }),
    ).rejects.toThrow(PremiereWageringRosterError);
  });

  test("throws when the league cannot be resolved", async () => {
    const coworldJson: CoworldJsonInvoker = async (args) => {
      if (args[0] === "leagues") return null;
      return [];
    };
    await expect(
      fetchActiveLeagueRoster({ leagueId: "league_abc", coworldJson }),
    ).rejects.toThrow(PremiereWageringRosterError);
  });
});
