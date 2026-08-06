import os
from pathlib import Path
from uuid import UUID

import pytest
import yaml

# Importing commissioners.proxywar_app also constructs the shared FastAPI app,
# whose default config name is not bundled in this game-specific image.
os.environ.setdefault("RULESET_STRATEGY_CONFIG_NAME", "proxywar")

from commissioners.common.adapters import schedule_rounds_for_request
from commissioners.common.protocol import (
    DivisionInfo,
    LeagueInfo,
    MembershipInfo,
    RoundStart,
    ScheduleRoundsRequest,
    VariantInfo,
)
from commissioners.common.ruleset_strategy.config import (
    RulesetStrategyCommissionerConfig,
)
from commissioners.proxywar_app import ProxyWarCommissioner

CONFIG_PATH = (
    Path(__file__).parents[1]
    / "commissioners"
    / "ruleset_strategy_commissioner"
    / "configs"
    / "proxywar.yaml"
)
LEAGUE_ID = UUID("00000000-0000-0000-0000-000000000001")
DIVISION_ID = UUID("00000000-0000-0000-0000-000000000002")
QUALIFIER_POLICY_ID = UUID("00000000-0000-0000-0003-000000000001")


def competition_round_start(champion_count: int) -> RoundStart:
    policy_ids = [
        UUID(f"00000000-0000-0000-0001-{index:012d}")
        for index in range(champion_count)
    ]
    return RoundStart(
        round_id=UUID("00000000-0000-0000-0000-000000000003"),
        round_number=1030,
        league=LeagueInfo(
            id=LEAGUE_ID,
            commissioner_key="proxywar_scaling",
        ),
        divisions=[
            DivisionInfo(
                id=DIVISION_ID,
                name="Competition",
                level=1,
                type="competition",
            )
        ],
        memberships=[
            MembershipInfo(
                id=UUID(f"00000000-0000-0000-0002-{index:012d}"),
                league_id=LEAGUE_ID,
                division_id=DIVISION_ID,
                policy_version_id=policy_id,
                player_id=f"player-{index}",
                status="competing",
                substatus="active",
                is_champion=True,
            )
            for index, policy_id in enumerate(policy_ids)
        ],
        recent_results=[],
        variants=[
            VariantInfo(
                id="tournament-12p-pangaea",
                name="12-player Pangaea",
                game_config={"num_agents": 12},
            )
        ],
        state={
            "round_config": {
                "current_division_id": str(DIVISION_ID),
                "entrant_policy_version_ids": [
                    str(policy_id) for policy_id in policy_ids
                ],
            }
        },
    )


def commissioner() -> ProxyWarCommissioner:
    config = RulesetStrategyCommissionerConfig.from_mapping(
        yaml.safe_load(CONFIG_PATH.read_text())
    )
    return ProxyWarCommissioner(config)


def test_qualifier_self_play_survives_scheduling_protocol_round_trip() -> None:
    qualifier = DivisionInfo(
        id=DIVISION_ID,
        name="Qualifiers",
        level=-99,
        type="staging",
    )
    membership = MembershipInfo(
        id=UUID("00000000-0000-0000-0004-000000000001"),
        league_id=LEAGUE_ID,
        division_id=DIVISION_ID,
        policy_version_id=QUALIFIER_POLICY_ID,
        player_id="qualifying-player",
        status="qualifying",
    )
    scheduled = schedule_rounds_for_request(
        commissioner(),
        ScheduleRoundsRequest(
            league=LeagueInfo(id=LEAGUE_ID, commissioner_key="container"),
            divisions=[qualifier],
            active_memberships=[membership],
            recent_rounds=[],
        ),
    )

    assert len(scheduled.rounds) == 1
    round_config = scheduled.to_json()["rounds"][0]["round_config"]
    assert round_config["stages"][0]["self_play"] is True

    episodes = commissioner().schedule_episodes_for_round_start(
        RoundStart(
            round_id=UUID("00000000-0000-0000-0005-000000000001"),
            round_number=1,
            league=LeagueInfo(id=LEAGUE_ID, commissioner_key="container"),
            divisions=[qualifier],
            memberships=[membership],
            recent_results=[],
            variants=[
                VariantInfo(
                    id="tournament-2p-pangaea",
                    name="2-player Pangaea",
                    game_config={"num_agents": 2},
                )
            ],
            state={"round_config": round_config},
        )
    )

    assert len(episodes.episodes) == 2
    assert all(
        episode.policy_version_ids == [QUALIFIER_POLICY_ID, QUALIFIER_POLICY_ID]
        for episode in episodes.episodes
    )


def test_live_17_champion_field_schedules_every_entrant() -> None:
    round_start = competition_round_start(17)

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    assert len(scheduled.episodes) == 6
    scheduled_policy_ids = {
        policy_id
        for episode in scheduled.episodes
        for policy_id in episode.policy_version_ids
    }
    champion_policy_ids = {
        membership.policy_version_id for membership in round_start.memberships
    }
    assert scheduled_policy_ids == champion_policy_ids
    assert (
        round_start.memberships[-1].policy_version_id
        in scheduled.episodes[-1].policy_version_ids
    )


def test_configured_four_episode_floor_is_preserved_at_12_champions() -> None:
    round_start = competition_round_start(12)

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    assert len(scheduled.episodes) == 4
    assert all(len(episode.policy_version_ids) == 12 for episode in scheduled.episodes)


@pytest.mark.parametrize("champion_count", [2, 3, 4, 5, 8, 9, 12, 13, 17, 24])
def test_every_supported_ladder_shape_schedules_every_entrant(
    champion_count: int,
) -> None:
    round_start = competition_round_start(champion_count)
    round_start.variants = [
        VariantInfo(
            id=f"tournament-{seat_count}p-pangaea",
            name=f"{seat_count}-player Pangaea",
            game_config={"num_agents": seat_count},
        )
        for seat_count in (2, 4, 8, 12)
    ]

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    scheduled_policy_ids = {
        policy_id
        for episode in scheduled.episodes
        for policy_id in episode.policy_version_ids
    }
    champion_policy_ids = {
        membership.policy_version_id for membership in round_start.memberships
    }
    assert scheduled_policy_ids == champion_policy_ids


def test_competition_ladder_ids_all_exist_in_the_manifest() -> None:
    # The ladder is declared "once here and in the manifest's variants[]";
    # this is the check that keeps a ladder edit and a manifest edit honest
    # with each other (a pool id missing from the manifest would surface as a
    # hosted round failure, not a local error, without it).
    import json

    from commissioners.proxywar_app import COMPETITION_LADDER

    manifest_path = (
        Path(__file__).parents[2] / "coworld" / "coworld_manifest.json"
    )
    manifest = json.loads(manifest_path.read_text())
    manifest_ids = {variant["id"] for variant in manifest["variants"]}
    for seat_count, pool in COMPETITION_LADDER:
        for variant_id in pool:
            assert variant_id in manifest_ids, (
                f"ladder rung {seat_count}p references {variant_id!r} "
                f"which is not in the manifest"
            )
            variant = next(
                v for v in manifest["variants"] if v["id"] == variant_id
            )
            assert variant["game_config"]["num_agents"] == seat_count


def test_twelve_seat_rotation_sweeps_every_map_in_the_pool() -> None:
    from commissioners.proxywar_app import COMPETITION_LADDER

    pool = dict(COMPETITION_LADDER)[12]
    assert len(pool) >= 7, "the 2026-08-02 rotation expansion should be present"

    round_start = competition_round_start(12)
    round_start.variants = [
        VariantInfo(
            id=variant_id,
            name=variant_id,
            game_config={"num_agents": 12},
        )
        for variant_id in pool
    ]

    seen: list[str] = []
    for offset in range(len(pool)):
        round_start.round_number = 2000 + offset
        scheduled = commissioner().schedule_episodes_for_round_start(round_start)
        variant_ids = {episode.variant_id for episode in scheduled.episodes}
        assert len(variant_ids) == 1, "a round runs exactly one map"
        seen.append(variant_ids.pop())

    assert set(seen) == set(pool), (
        f"consecutive rounds should sweep the whole pool; saw {seen}"
    )
