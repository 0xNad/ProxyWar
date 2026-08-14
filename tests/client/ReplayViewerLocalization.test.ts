import IntlMessageFormat from "intl-messageformat";
import en from "../../resources/lang/en.json";

const replay = en.ai_league_replay as Record<string, string>;

describe("replay viewer localization", () => {
  test("defines every dynamically addressed action-kind label", () => {
    const kinds = [
      "spawn",
      "hold",
      "retreat",
      "attack",
      "boat",
      "boat_retreat",
      "build",
      "build_unit",
      "upgrade_structure",
      "move_warship",
      "warship",
      "donate_troops",
      "donate_gold",
      "embargo",
      "embargo_all",
      "alliance_request",
      "alliance_reject",
      "target_player",
      "quick_chat",
      "emoji",
      "delete_unit",
      "deal_propose",
      "deal_accept",
      "deal_reject",
      "deal_withdraw",
      "unknown",
    ];

    for (const kind of kinds) {
      expect(replay[`action_kind_${kind}`]).toEqual(expect.any(String));
    }
  });

  test("defines every dynamically addressed dossier and warhead label", () => {
    const dossierUnits = [
      "tiles",
      "troops",
      "city",
      "factory",
      "port",
      "missile_silo",
      "sam_site",
      "defense_post",
      "warship",
      "trade_ship",
      "transport",
      "betrayal",
      "embargo",
    ];
    for (const unit of dossierUnits) {
      expect(replay[`dossier_unit_${unit}`]).toEqual(expect.any(String));
    }

    for (const kind of ["competitor", "bot_nation", "nation"]) {
      expect(replay[`dossier_kind_${kind}`]).toEqual(expect.any(String));
    }
    for (const warhead of ["mirv", "hydrogen", "atom", "warhead"]) {
      expect(replay[`warhead_${warhead}`]).toEqual(expect.any(String));
    }
  });

  test("formats representative plural and narrative messages", () => {
    expect(
      new IntlMessageFormat(replay.dossier_unit_city, "en").format({
        count: 1,
      }),
    ).toBe("city");
    expect(
      new IntlMessageFormat(replay.dossier_unit_city, "en").format({
        count: 3,
      }),
    ).toBe("cities");
    expect(
      new IntlMessageFormat(replay.verdict_no_winner, "en").format({
        name: "relh",
        share: "24%",
        survivors: 3,
        field: 16,
        turn: "8,004",
      }),
    ).toBe(
      "No one closed it out — relh finishes on top with 24% of the map, 3 of 16 still standing after 8,004 turns.",
    );
  });
});
