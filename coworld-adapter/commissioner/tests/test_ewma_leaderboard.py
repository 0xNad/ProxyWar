from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import yaml

from commissioners.common.models import (
    DivisionLeaderboardContext,
    DivisionSnapshot,
    LeaderboardRoundResultSnapshot,
    LeagueSnapshot,
    RoundSnapshot,
)
from commissioners.common.commissioners import RulesetStrategyCommissioner
from commissioners.common.ruleset_strategy.config import RulesetStrategyCommissionerConfig
from commissioners.common.utils import RANKED_SCORE_COUNT_METADATA_KEY, WIN_EPISODE_ROUND_SCORE_KIND


def _config(*, provisional_min_rounds: int = 5) -> RulesetStrategyCommissionerConfig:
    return RulesetStrategyCommissionerConfig.from_mapping(
        {
            "schedule_interval_minutes": 30,
            "scoring": {
                "round_score": "win",
                "leaderboard": {
                    "type": "ewma",
                    "half_life_rounds": 24,
                    "score_scale": 100,
                    "provisional_min_rounds": provisional_min_rounds,
                },
            },
            "divisions": {
                "competition": {
                    "name": "Competition",
                    "level": 1,
                    "match": {"type": "competition"},
                    "entrants": "champions",
                    "min_entries_to_start": 2,
                }
            },
        }
    )


def _rounds(count: int) -> list[RoundSnapshot]:
    division_id = UUID(int=2)
    now = datetime(2026, 7, 17, 12, tzinfo=UTC)
    return [
        RoundSnapshot(
            id=UUID(int=1000 + age),
            public_id=f"round-{count - age}",
            division_id=division_id,
            round_number=count - age,
            status="completed",
            round_config={},
            created_at=now - timedelta(hours=age * age + 1),
            started_at=now - timedelta(hours=age * age),
            completed_at=now - timedelta(hours=age * age),
        )
        for age in range(count)
    ]


def _result(
    round_row: RoundSnapshot,
    *,
    player_id: str,
    player_name: str,
    policy_version_id: UUID,
    score: float,
    ranked_score_count: int = 1,
) -> LeaderboardRoundResultSnapshot:
    return LeaderboardRoundResultSnapshot(
        round_id=round_row.id,
        policy_version_id=policy_version_id,
        player_id=player_id,
        player_name=player_name,
        rank=1,
        score=score,
        result_metadata={
            "score_kind": WIN_EPISODE_ROUND_SCORE_KIND,
            RANKED_SCORE_COUNT_METADATA_KEY: ranked_score_count,
        },
    )


def _context(
    rounds: list[RoundSnapshot],
    results: list[LeaderboardRoundResultSnapshot],
) -> DivisionLeaderboardContext:
    league_id = UUID(int=1)
    division_id = UUID(int=2)
    return DivisionLeaderboardContext(
        league=LeagueSnapshot(id=league_id, commissioner_key="proxywar_scaling", commissioner_config=None),
        division=DivisionSnapshot(
            id=division_id,
            name="Competition",
            level=1,
            league_id=league_id,
            type="competition",
        ),
        completed_rounds=rounds,
        recent_rounds=rounds[:5],
        round_results=results,
    )


def _rank(
    rounds: list[RoundSnapshot],
    results: list[LeaderboardRoundResultSnapshot],
    *,
    provisional_min_rounds: int = 5,
):
    commissioner = RulesetStrategyCommissioner(_config(provisional_min_rounds=provisional_min_rounds))
    return commissioner.rank_division(_context(rounds, results))


def test_round_half_life_uses_completed_round_age_and_scales_to_100() -> None:
    rounds = _rounds(25)
    policy_id = uuid4()
    rankings = _rank(
        rounds,
        [
            _result(
                rounds[0],
                player_id="player-a",
                player_name="Player A",
                policy_version_id=policy_id,
                score=0.0,
            ),
            _result(
                rounds[24],
                player_id="player-a",
                player_name="Player A",
                policy_version_id=policy_id,
                score=1.0,
            ),
        ],
        provisional_min_rounds=0,
    )

    assert rankings[0].score == pytest.approx(100 / 3)
    assert rankings[0].rounds_played == 2


def test_constant_round_form_keeps_its_percentage_scale() -> None:
    rounds = _rounds(5)
    policy_id = uuid4()
    results = [
        _result(
            round_row,
            player_id="player-a",
            player_name="Player A",
            policy_version_id=policy_id,
            score=0.25,
        )
        for round_row in rounds
    ]

    rankings = _rank(rounds, results)

    assert rankings[0].score == pytest.approx(25.0)


def test_one_round_lucky_player_sorts_after_established_player() -> None:
    rounds = _rounds(5)
    established_policy = uuid4()
    newcomer_policy = uuid4()
    results = [
        _result(
            round_row,
            player_id="established",
            player_name="Established",
            policy_version_id=established_policy,
            score=0.20,
        )
        for round_row in rounds
    ]
    results.append(
        _result(
            rounds[0],
            player_id="newcomer",
            player_name="Newcomer",
            policy_version_id=newcomer_policy,
            score=1.0,
        )
    )

    rankings = _rank(rounds, results)

    assert [(row.player_id, row.rank, row.rounds_played, row.score) for row in rankings] == [
        ("established", 1, 5, pytest.approx(20.0)),
        ("newcomer", 2, 1, pytest.approx(100.0)),
    ]


def test_fifth_valid_round_moves_player_into_score_order() -> None:
    rounds = _rounds(5)
    established_policy = uuid4()
    newcomer_policy = uuid4()
    results = [
        _result(
            round_row,
            player_id="established",
            player_name="Established",
            policy_version_id=established_policy,
            score=0.20,
        )
        for round_row in rounds
    ]
    results.extend(
        _result(
            round_row,
            player_id="newcomer",
            player_name="Newcomer",
            policy_version_id=newcomer_policy,
            score=1.0,
        )
        for round_row in rounds
    )

    rankings = _rank(rounds, results)

    assert [row.player_id for row in rankings] == ["newcomer", "established"]
    assert rankings[0].rounds_played == 5
    assert rankings[0].score == pytest.approx(100.0)


def test_placement_history_follows_player_across_versions() -> None:
    rounds = _rounds(5)
    version_one = uuid4()
    version_two = uuid4()
    competitor = uuid4()
    results = [
        _result(
            round_row,
            player_id="lineage",
            player_name="Lineage",
            policy_version_id=version_one if index < 4 else version_two,
            score=0.50,
        )
        for index, round_row in enumerate(rounds)
    ]
    results.extend(
        _result(
            round_row,
            player_id="competitor",
            player_name="Competitor",
            policy_version_id=competitor,
            score=0.25,
        )
        for round_row in rounds
    )

    rankings = _rank(rounds, results)

    assert rankings[0].player_id == "lineage"
    assert rankings[0].rounds_played == 5
    assert rankings[0].policy_version_ids == {version_one, version_two}


def test_zero_exposure_result_does_not_advance_placement() -> None:
    rounds = _rounds(5)
    policy_id = uuid4()
    results = [
        _result(
            round_row,
            player_id="player-a",
            player_name="Player A",
            policy_version_id=policy_id,
            score=1.0,
            ranked_score_count=0 if index == 0 else 1,
        )
        for index, round_row in enumerate(rounds)
    ]
    established_policy = uuid4()
    results.extend(
        _result(
            round_row,
            player_id="established",
            player_name="Established",
            policy_version_id=established_policy,
            score=0.10,
        )
        for round_row in rounds
    )

    rankings = _rank(rounds, results)
    player = next(row for row in rankings if row.player_id == "player-a")

    assert player.rounds_played == 4
    assert player.rank == 2


def test_same_player_and_round_counts_once_across_versions() -> None:
    rounds = _rounds(1)
    version_one = uuid4()
    version_two = uuid4()
    rankings = _rank(
        rounds,
        [
            _result(
                rounds[0],
                player_id="player-a",
                player_name="Player A",
                policy_version_id=version_one,
                score=0.25,
            ),
            _result(
                rounds[0],
                player_id="player-a",
                player_name="Player A",
                policy_version_id=version_two,
                score=0.75,
            ),
        ],
        provisional_min_rounds=0,
    )

    assert len(rankings) == 1
    assert rankings[0].rounds_played == 1
    assert rankings[0].score == pytest.approx(75.0)
    assert rankings[0].policy_version_ids == {version_two}


def test_proxywar_config_and_public_copy_describe_form_ranking() -> None:
    config_path = (
        Path(__file__).resolve().parents[1]
        / "commissioners"
        / "ruleset_strategy_commissioner"
        / "configs"
        / "proxywar.yaml"
    )
    config = RulesetStrategyCommissionerConfig.from_mapping(yaml.safe_load(config_path.read_text()))

    assert config.scoring is not None
    assert config.scoring.leaderboard.type == "ewma"
    assert config.scoring.leaderboard.half_life_rounds == 24
    assert config.scoring.leaderboard.score_scale == 100
    assert config.scoring.leaderboard.provisional_min_rounds == 5
    assert config.scoring_mechanics is not None
    assert "24 completed rounds" in config.scoring_mechanics
    assert "multiplied by 100" in config.scoring_mechanics
    assert "fewer than 5 valid scored rounds remain provisional" in config.scoring_mechanics
    assert "OpenSkill" not in config.scoring_mechanics
    assert "2-hour" not in config.scoring_mechanics
