import { describe, expect, it, vi } from "vitest";
import { Logger } from "winston";
import { coworldResults } from "../../coworld-adapter/src/coworld-results";
import {
  normalizeCoworldExperimentConfig,
  resolveCoworldTeams,
} from "../../coworld-adapter/src/coworld-teams";
import { GameMode, PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { createAgentParticipants } from "../../src/server/agents/AgentLeagueMatch";
import { setup } from "../util/Setup";

describe("Coworld explicit team experiments", () => {
  it("normalizes namespaced experiment seeds without changing ordinary configs", () => {
    const config = { experiment_seed: 913001, experiment_episode_index: 5 };
    expect(normalizeCoworldExperimentConfig(config)).toEqual({
      seed: 913001,
      episodeIndex: 5,
    });
    expect(config).toEqual({
      experiment_seed: 913001,
      experiment_episode_index: 5,
    });
    expect(
      normalizeCoworldExperimentConfig({ seed: 42, episodeIndex: 0 }),
    ).toEqual({ seed: 42, episodeIndex: 0 });
  });
  it("rejects conflicting or invalid experiment seeds", () => {
    for (const config of [
      { seed: 4, experiment_seed: 4 },
      { episodeIndex: 0, experiment_episode_index: 0 },
      { experiment_seed: -1 },
      { experiment_seed: 11881376 },
      { experiment_seed: 1.5 },
      { experiment_episode_index: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(() => normalizeCoworldExperimentConfig(config)).toThrow();
  });
  it("keeps FFA the default and rejects partial or unequal assignments", () => {
    expect(resolveCoworldTeams({}, 12)).toBeNull();
    for (const config of [
      { team_count: 1, seat_teams: [0, 0] },
      { team_count: 2, seat_teams: [0] },
      { team_count: 2, seat_teams: [0, 2] },
      { team_count: 2, seat_teams: [0, 0] },
      { seat_teams: [0, 1] },
      { team_count: 2 },
    ])
      expect(() => resolveCoworldTeams(config, 2)).toThrow();
  });

  it.each([
    [2, 6],
    [3, 4],
    [4, 3],
    [5, 3],
  ])(
    "seats %i teams of %i in the real engine, with permanent friendliness",
    async (count, size) => {
      const seatTeams = Array.from(
        { length: count * size },
        (_, i) => i % count,
      );
      const teams = resolveCoworldTeams(
        { team_count: count, seat_teams: seatTeams },
        seatTeams.length,
      )!;
      const players = teams.clanTags.map(
        (clan, i) =>
          new PlayerInfo(
            `Seat ${i}`,
            PlayerType.Human,
            null,
            `seat${i}`,
            false,
            clan,
          ),
      );
      const game = await setup(
        "big_plains",
        { gameMode: GameMode.Team, playerTeams: count, nations: "disabled" },
        players,
      );
      const live = players.map((p) => game.player(p.id));
      expect(new Set(live.map((p) => p.team())).size).toBe(count);
      for (let i = 0; i < live.length; i++) {
        for (let j = 0; j < live.length; j++) {
          if (i === j) continue;
          expect(live[i].team() === live[j].team()).toBe(
            seatTeams[i] === seatTeams[j],
          );
          if (seatTeams[i] === seatTeams[j]) {
            expect(live[i].isFriendly(live[j])).toBe(true);
            expect(live[i].canAttackPlayer(live[j])).toBe(false);
          }
        }
      }
    },
  );

  it("passes the experiment group through the existing agent's client join", () => {
    const log = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const [participant] = createAgentParticipants(
      [{ username: "Alice", profile: "opportunistic", clanTag: "XP1" }],
      log,
    );
    const game = {
      id: "TEAMTEST",
      joinAgentClient: vi.fn().mockReturnValue("joined"),
    };
    participant.runner.attachToGame(game as never);
    expect(game.joinAgentClient.mock.calls[0][0].clanTag).toBe("XP1");
  });

  const result = (
    winnerTeam: string | null,
    winnerSlot: number | null = null,
  ) =>
    coworldResults({
      gameId: "TEAMTEST",
      seed: null,
      players: ["A", "B", "C", "D"].map((name) => ({ name })),
      records: [],
      finalState: {
        winnerTeam,
        winnerSlot,
        tick: 400,
        turnCount: 400,
        players: [
          { username: "A", team: "Red", tilesOwned: 60, isAlive: true },
          { username: "B", team: "Blue", tilesOwned: 20, isAlive: true },
          { username: "C", team: "Red", tilesOwned: 0, isAlive: false },
          { username: "D", team: "Blue", tilesOwned: 20, isAlive: true },
        ],
      },
    });

  it("shares a team win equally, including eliminated teammates", () => {
    expect(result("Red", 0)).toMatchObject({
      winner_slot: null,
      winner_team: "Red",
      scores: [0.5, 0, 0.5, 0],
    });
  });
  it("shares each team's territory score equally at the turn limit", () => {
    expect(result(null).scores).toEqual([0.3, 0.2, 0.3, 0.2]);
  });
  it("rejects a winner outside the seated teams", () => {
    expect(() => result("Green")).toThrow("Team winner");
  });
});
