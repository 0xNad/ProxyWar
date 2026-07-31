import os
from pathlib import Path
from uuid import UUID

from anyio import WouldBlock
from fastapi.testclient import TestClient
import pytest
import yaml

# Importing commissioners.proxywar_app also constructs the shared FastAPI app,
# whose default config name is not bundled in this game-specific image.
os.environ.setdefault("RULESET_STRATEGY_CONFIG_NAME", "proxywar")

from commissioners.common.protocol import (
    DivisionInfo,
    LeagueInfo,
    MembershipInfo,
    RoundStart,
    VariantInfo,
)
from commissioners.common.server import create_app
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
                game_config={
                    "num_agents": 12,
                    "episode_timeout_seconds": 3600,
                },
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


def test_live_dispatch_throttle_caps_competition_at_three_episodes() -> None:
    throttle = commissioner().dispatch_throttle_config()

    assert throttle.enabled is True
    assert throttle.max_concurrent_episodes(3600) == 3
    assert throttle.max_concurrent_episodes(180) == 3
    assert throttle.episode_stagger_seconds(3600) == 0


def test_live_17_champion_server_dispatches_three_then_drains_the_queue() -> None:
    round_start = competition_round_start(17)

    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(round_start.to_json())

        initial_messages = [websocket.receive_json() for _ in range(3)]
        assert [message["type"] for message in initial_messages] == [
            "schedule_episodes"
        ] * 3
        assert [
            message["episodes"][0]["request_id"] for message in initial_messages
        ] == ["0", "1", "2"]
        assert all(len(message["episodes"]) == 1 for message in initial_messages)

        with pytest.raises(WouldBlock):
            websocket.portal.call(websocket._send_rx.receive_nowait)

        for settled_index in range(3):
            websocket.send_json(
                {
                    "type": "episode_failed",
                    "request_id": str(settled_index),
                    "error": "synthetic throttle-test settlement",
                }
            )
            replacement = websocket.receive_json()
            assert replacement["type"] == "schedule_episodes"
            assert replacement["episodes"][0]["request_id"] == str(
                settled_index + 3
            )

        with pytest.raises(WouldBlock):
            websocket.portal.call(websocket._send_rx.receive_nowait)

        websocket.send_json(
            {"type": "round_abort", "reason": "synthetic throttle test complete"}
        )
