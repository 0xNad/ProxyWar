import { describe, expect, test } from "vitest";
import {
  assertRosterReconcilesWithStandings,
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
    player: { id: playerId, name: `Player ${playerId}` },
    ...overrides,
  };
}

function standingsRow(playerId: string, playerName = `Player ${playerId}`) {
  return { player_id: playerId, player_name: playerName };
}

// Standings default to `[]`: the fake never asserts reconciliation unless a
// test opts in by passing a standings list naming a player with no seat.
function fakeCoworldJson(
  memberships: unknown[],
  standings: unknown[] = [],
): CoworldJsonInvoker {
  return async (args: string[]) => {
    if (args[0] === "leagues") return LEAGUE_RAW;
    // `results` is called twice: by league id (-> divisions), then by the
    // resolved division id (-> standings).
    if (args[0] === "results" && args[1] === "league_abc") return DIVISIONS_RAW;
    if (args[0] === "results") return standings;
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
    // Real Coworld membership rows carry the player's display name under
    // `player.name`, not `player.username` — this pins the field this
    // parser actually reads (a prior version silently read the wrong key
    // and always produced `playerName: null`).
    expect(roster.seats.map((s) => s.playerName).sort()).toEqual([
      "Player player_1",
      "Player player_2",
      "Player player_3",
    ]);
    expect(roster.seats.map((s) => s.policyVersionId).sort()).toEqual([
      "pv_1",
      "pv_2",
      "pv_3",
    ]);
    expect(roster.divisionId).toBe("div_1");
  });

  test("excludes non-competing, inactive, non-champion, ended, and crashed memberships", async () => {
    const memberships = [
      membershipRow("pv_active", "a:v1", "p1"),
      membershipRow("pv_not_competing", "b:v1", "p2", { status: "pending" }),
      membershipRow("pv_inactive_sub", "c:v1", "p3", { substatus: "paused" }),
      membershipRow("pv_not_champion", "d:v1", "p4", { is_champion: false }),
      membershipRow("pv_ended", "e:v1", "p5", {
        end_time: "2026-07-01T00:00:00.000Z",
      }),
      membershipRow("pv_crashed", "f:v1", "p6", { substatus: "crash" }),
    ];
    const roster = await fetchActiveLeagueRoster({
      leagueId: "league_abc",
      coworldJson: fakeCoworldJson(memberships),
    });
    expect(roster.seats.map((s) => s.policyVersionId)).toEqual(["pv_active"]);
  });

  test("seats a champion whose substatus is 'champion', not just 'active' (regression: djizus/richard/James Boggs were silently dropped when the platform tagged their membership 'champion' instead of 'active' — both mean 'currently the reigning champion, still competing')", async () => {
    const memberships = [
      membershipRow("pv_1", "policy-a:v1", "player_1", { substatus: "active" }),
      membershipRow("pv_2", "policy-b:v1", "player_2", { substatus: "champion" }),
    ];
    const roster = await fetchActiveLeagueRoster({
      leagueId: "league_abc",
      coworldJson: fakeCoworldJson(memberships),
    });
    expect(roster.seats.map((s) => s.policyVersionId).sort()).toEqual(["pv_1", "pv_2"]);
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

  test("does not throw when standings resolve to seats exactly", async () => {
    const memberships = [membershipRow("pv_1", "policy-a:v1", "player_1")];
    const standings = [standingsRow("player_1")];
    const roster = await fetchActiveLeagueRoster({
      leagueId: "league_abc",
      coworldJson: fakeCoworldJson(memberships, standings),
    });
    expect(roster.seats).toHaveLength(1);
  });

  test("fails loudly, naming the player and the reason, when a standings player has no runnable seat (regression: silently seating fewer players than the league actually lists in standings)", async () => {
    const memberships = [
      membershipRow("pv_1", "policy-a:v1", "player_1"),
      // player_2's only membership row is disqualified/inactive — present in
      // the division, but not runnable.
      membershipRow("pv_2", "policy-b:v1", "player_2", {
        status: "disqualified",
        substatus: "inactive",
      }),
    ];
    const standings = [
      standingsRow("player_1"),
      standingsRow("player_2", "Dropped Player"),
    ];
    await expect(
      fetchActiveLeagueRoster({
        leagueId: "league_abc",
        coworldJson: fakeCoworldJson(memberships, standings),
      }),
    ).rejects.toThrow(/Dropped Player \(player_2\).*status="disqualified".*substatus="inactive"/s);
  });

  test("fails loudly when a standings player has no membership record in the division at all", async () => {
    const memberships = [membershipRow("pv_1", "policy-a:v1", "player_1")];
    const standings = [standingsRow("player_1"), standingsRow("player_ghost")];
    await expect(
      fetchActiveLeagueRoster({
        leagueId: "league_abc",
        coworldJson: fakeCoworldJson(memberships, standings),
      }),
    ).rejects.toThrow(/player_ghost.*no membership record found/s);
  });
});

describe("assertRosterReconcilesWithStandings", () => {
  test("is a pure check callable directly with an explicit seat list", () => {
    expect(() =>
      assertRosterReconcilesWithStandings(
        [standingsRow("player_1")],
        [membershipRow("pv_1", "policy-a:v1", "player_1")],
        [
          {
            policyVersionId: "pv_1",
            policyLabel: "policy-a:v1",
            playerId: "player_1",
            playerName: "Player player_1",
          },
        ],
      ),
    ).not.toThrow();
  });
});
