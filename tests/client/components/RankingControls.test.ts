import { afterEach, describe, expect, it } from "vitest";
import { RankType } from "../../../src/client/components/baseComponents/ranking/GameInfoRanking";
import { RankingControls } from "../../../src/client/components/baseComponents/ranking/RankingControls";

async function mountRankingControls(warshipsDisabled: boolean) {
  const controls = new RankingControls();
  controls.rankType = RankType.TotalGold;
  controls.warshipsDisabled = warshipsDisabled;
  document.body.appendChild(controls);
  await controls.updateComplete;
  return controls;
}

describe("RankingControls retired Warship statistic", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("hides the Pirate ranking in new games", async () => {
    const controls = await mountRankingControls(true);
    expect(controls.textContent).not.toContain("game_info_modal.pirate");
  });

  it("keeps the Pirate ranking for historical games", async () => {
    const controls = await mountRankingControls(false);
    expect(controls.textContent).toContain("game_info_modal.pirate");
  });
});
