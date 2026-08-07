import { afterEach, describe, expect, it } from "vitest";
import { TeamStats } from "../../../../src/client/graphics/layers/TeamStats";
import { UnitType } from "../../../../src/core/game/Game";
import { GameView } from "../../../../src/core/game/GameView";

function mountTeamStats(warshipsDisabled: boolean): TeamStats {
  const stats = new TeamStats();
  stats.game = {
    config: () => ({
      isUnitDisabled: (unit: UnitType) =>
        unit === UnitType.Warship && warshipsDisabled,
    }),
  } as unknown as GameView;
  stats.visible = true;
  (
    stats as unknown as {
      showUnits: boolean;
    }
  ).showUnits = true;
  stats.teams = [
    {
      teamName: "Red",
      isMyTeam: true,
      totalScoreStr: "50%",
      totalGold: "10",
      totalMaxTroops: "20",
      totalSAMs: "1",
      totalLaunchers: "2",
      totalWarShips: "7",
      totalCities: "3",
      totalScoreSort: 50,
      players: [],
    },
  ];
  document.body.appendChild(stats);
  return stats;
}

describe("TeamStats retired Warship compatibility", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("hides the Warship column in new games", async () => {
    const stats = mountTeamStats(true);
    await stats.updateComplete;

    expect(stats.textContent).not.toContain("leaderboard.warships");
    expect(stats.textContent).not.toContain("7");
  });

  it("keeps the Warship column for historical replay configs", async () => {
    const stats = mountTeamStats(false);
    await stats.updateComplete;

    expect(stats.textContent).toContain("leaderboard.warships");
    expect(stats.textContent).toContain("7");
  });
});
