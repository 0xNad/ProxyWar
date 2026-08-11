import asyncio
import os
from pathlib import Path
from uuid import UUID

import pytest
import yaml
from anyio import WouldBlock
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

# Importing commissioners.proxywar_app also constructs the shared FastAPI app,
# whose default config name is not bundled in this game-specific image.
os.environ.setdefault("RULESET_STRATEGY_CONFIG_NAME", "proxywar")

from commissioners.common.adapters import schedule_rounds_for_request
from commissioners.common.protocol import (
    DivisionInfo,
    EPISODE_SEED_MAX,
    EpisodeRequest,
    LeagueInfo,
    MembershipInfo,
    RoundStart,
    ScheduleRoundsRequest,
    VariantInfo,
)
from commissioners.common.server import _send_episode_batch, create_app
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


QUALIFIER_DIVISION_ID = UUID("00000000-0000-0000-0000-000000000009")


def qualifier_round_start(entrant_count: int = 1) -> RoundStart:
    policy_ids = [
        UUID(f"00000000-0000-0000-0003-{index:012d}") for index in range(entrant_count)
    ]
    return RoundStart(
        round_id=UUID("00000000-0000-0000-0000-000000000005"),
        round_number=1,
        league=LeagueInfo(id=LEAGUE_ID, commissioner_key="proxywar_scaling"),
        divisions=[
            DivisionInfo(
                id=QUALIFIER_DIVISION_ID,
                name="Qualifiers",
                level=-99,
                type="staging",
            )
        ],
        memberships=[
            MembershipInfo(
                id=UUID(f"00000000-0000-0000-0004-{index:012d}"),
                league_id=LEAGUE_ID,
                division_id=QUALIFIER_DIVISION_ID,
                policy_version_id=policy_id,
                player_id=f"qualifier-{index}",
                status="qualifying",
                substatus="active",
                is_champion=False,
            )
            for index, policy_id in enumerate(policy_ids)
        ],
        recent_results=[],
        variants=[
            VariantInfo(
                id="qualifier-crash-check",
                name="Qualifier crash check",
                game_config={"num_agents": 1},
            )
        ],
        state={"round_config": {"current_division_id": str(QUALIFIER_DIVISION_ID)}},
    )


def competition_round_start(champion_count: int) -> RoundStart:
    policy_ids = [
        UUID(f"00000000-0000-0000-0001-{index:012d}") for index in range(champion_count)
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


def commissioner_with_stagger(seconds: float) -> ProxyWarCommissioner:
    mapping = yaml.safe_load(CONFIG_PATH.read_text())
    mapping["dispatch_throttle"]["stagger_seconds"] = seconds
    return ProxyWarCommissioner(
        RulesetStrategyCommissionerConfig.from_mapping(mapping)
    )


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
        for seat_count in (2, 4, 8, 12, 16)
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


def _sixteen_rung_variants() -> list[VariantInfo]:
    # The variant list a live RoundStart carries once the package declares the
    # 16-seat variant alongside the 12-seat pool.
    return [
        VariantInfo(
            id="tournament-12p-pangaea",
            name="12-player Pangaea",
            game_config={"num_agents": 12, "episode_timeout_seconds": 3600},
        ),
        VariantInfo(
            id="tournament-16p-pangaea",
            name="16-player Pangaea",
            game_config={"num_agents": 16, "episode_timeout_seconds": 4500},
        ),
    ]


def test_live_25_champion_field_routes_to_sixteen_seats_and_covers_every_entrant() -> (
    None
):
    round_start = competition_round_start(25)
    round_start.variants = _sixteen_rung_variants()

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    # 25 entrants at 16 seats: max(4, 25 - 16 + 1) = 10 rolling-window episodes.
    assert len(scheduled.episodes) == 10
    for episode in scheduled.episodes:
        assert episode.variant_id == "tournament-16p-pangaea"
        assert len(episode.policy_version_ids) == 16
        assert len(set(episode.policy_version_ids)) == 16
    scheduled_policy_ids = {
        policy_id
        for episode in scheduled.episodes
        for policy_id in episode.policy_version_ids
    }
    champion_policy_ids = {
        membership.policy_version_id for membership in round_start.memberships
    }
    assert scheduled_policy_ids == champion_policy_ids


def test_sixteen_champion_field_routes_to_sixteen_seats() -> None:
    # Exact boundary: at precisely 16 champions the 16-seat rung fits
    # (seats <= champions), producing the 4-episode floor of full-field games.
    round_start = competition_round_start(16)
    round_start.variants = _sixteen_rung_variants()

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    assert len(scheduled.episodes) == 4
    for episode in scheduled.episodes:
        assert episode.variant_id == "tournament-16p-pangaea"
        assert len(set(episode.policy_version_ids)) == 16


def test_fifteen_champion_field_stays_on_twelve_seats() -> None:
    round_start = competition_round_start(15)
    round_start.variants = _sixteen_rung_variants()

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    assert scheduled.episodes
    for episode in scheduled.episodes:
        assert episode.variant_id == "tournament-12p-pangaea"
        assert len(episode.policy_version_ids) == 12


def test_sixteen_rung_without_manifest_variant_falls_back_to_twelve_seats() -> None:
    # Rollout order safety: a commissioner that declares the 16-seat rung but
    # runs against a package without the 16p variant must keep scheduling
    # 12-seat rounds (the rung filters to available variants), so the
    # commissioner and package can ship in either order.
    round_start = competition_round_start(25)

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    assert scheduled.episodes
    for episode in scheduled.episodes:
        assert episode.variant_id == "tournament-12p-pangaea"
        assert len(episode.policy_version_ids) == 12


def test_manifest_schema_ceilings_cover_every_ladder_rung() -> None:
    # 2026-08-10 lesson, twice in one night: raising a rung's seat count
    # requires raising EVERY per-seat schema ceiling. The results_schema caps
    # were caught in review; the config_schema `tokens` cap was caught only by
    # the upload validator. This pins all seven ceilings to the ladder so the
    # next rung addition fails here, locally, first.
    import json

    from commissioners.proxywar_app import COMPETITION_LADDER

    max_seats = max(seat_count for seat_count, _pool in COMPETITION_LADDER)
    for name in ("coworld_manifest.json", "coworld_manifest_template.json"):
        manifest = json.loads(
            (Path(__file__).parents[2] / "coworld" / name).read_text()
        )
        config = manifest["game"]["config_schema"]["properties"]
        results = manifest["game"]["results_schema"]["properties"]
        ceilings = {
            "config num_agents.maximum": config["num_agents"]["maximum"],
            "config players.maxItems": config["players"]["maxItems"],
            "config tokens.maxItems": config["tokens"]["maxItems"],
            "results scores.maxItems": results["scores"]["maxItems"],
            "results players.maxItems": results["players"]["maxItems"],
        }
        for label, ceiling in ceilings.items():
            assert ceiling >= max_seats, f"{name}: {label}={ceiling} < {max_seats}"
        slot_ceilings = {
            "results players.slot.maximum": results["players"]["items"][
                "properties"
            ]["slot"]["maximum"],
            "results winner_slot.maximum": results["winner_slot"]["maximum"],
        }
        for label, ceiling in slot_ceilings.items():
            assert ceiling >= max_seats - 1, (
                f"{name}: {label}={ceiling} < {max_seats - 1}"
            )


def test_competition_ladder_ids_all_exist_in_the_manifest() -> None:
    # The ladder is declared "once here and in the manifest's variants[]";
    # this is the check that keeps a ladder edit and a manifest edit honest
    # with each other (a pool id missing from the manifest would surface as a
    # hosted round failure, not a local error, without it).
    import json

    from commissioners.proxywar_app import COMPETITION_LADDER

    manifest_path = Path(__file__).parents[2] / "coworld" / "coworld_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest_ids = {variant["id"] for variant in manifest["variants"]}
    for seat_count, pool in COMPETITION_LADDER:
        for variant_id in pool:
            assert variant_id in manifest_ids, (
                f"ladder rung {seat_count}p references {variant_id!r} "
                f"which is not in the manifest"
            )
            variant = next(v for v in manifest["variants"] if v["id"] == variant_id)
            assert variant["game_config"]["num_agents"] == seat_count


def test_twelve_seat_rotation_sweeps_every_map_in_the_pool() -> None:
    from commissioners.proxywar_app import COMPETITION_LADDER

    pool = dict(COMPETITION_LADDER)[12]
    expected_pool = {
        "tournament-12p-pangaea",
        "tournament-12p-world",
        "tournament-12p-asia",
        "tournament-12p-britannia",
        "tournament-12p-blacksea",
        "tournament-12p-eastasia",
        "tournament-12p-northamerica",
        "tournament-12p-oceania",
    }
    assert set(pool) == expected_pool, (
        "the automatic 12P Competition pool must contain exactly the eight "
        f"deadline-proven variants while Europe is quarantined; saw {pool!r}"
    )

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

    # Every map appears in exactly one of the 8 consecutive rounds (an
    # unbiased sweep, not just "the whole pool showed up somewhere").
    assert len(seen) == len(set(seen)) == 8, (
        f"8 consecutive rounds should hit 8 distinct maps with no repeats; saw {seen}"
    )
    assert set(seen) == set(pool), (
        f"consecutive rounds should sweep the whole pool; saw {seen}"
    )


def test_sixteen_seat_rotation_sweeps_every_map_in_the_pool() -> None:
    from commissioners.proxywar_app import COMPETITION_LADDER

    pool = dict(COMPETITION_LADDER)[16]
    expected_pool = {
        "tournament-16p-pangaea",
        "tournament-16p-world",
        "tournament-16p-asia",
        "tournament-16p-britannia",
        "tournament-16p-blacksea",
        "tournament-16p-eastasia",
        "tournament-16p-northamerica",
        "tournament-16p-oceania",
    }
    assert set(pool) == expected_pool, (
        "the automatic 16P Competition pool must contain exactly the eight "
        f"boot-proven variants while Europe is quarantined; saw {pool!r}"
    )

    round_start = competition_round_start(25)
    round_start.variants = [
        VariantInfo(
            id=variant_id,
            name=variant_id,
            game_config={"num_agents": 16},
        )
        for variant_id in pool
    ]

    seen: list[str] = []
    for offset in range(len(pool)):
        round_start.round_number = 3000 + offset
        scheduled = commissioner().schedule_episodes_for_round_start(round_start)
        variant_ids = {episode.variant_id for episode in scheduled.episodes}
        assert len(variant_ids) == 1, "a round runs exactly one map"
        seen.append(variant_ids.pop())

    assert len(seen) == len(set(seen)) == 8, (
        f"8 consecutive rounds should hit 8 distinct maps with no repeats; saw {seen}"
    )
    assert set(seen) == set(pool), (
        f"consecutive rounds should sweep the whole pool; saw {seen}"
    )


def test_twelve_seat_pool_quarantines_europe() -> None:
    # Europe remains declared for manual validation, but two live rounds have
    # reproduced its hosted artifact deadline failure. Automatic Competition
    # scheduling must stay off until a full hosted wall-clock proof passes.
    from commissioners.proxywar_app import COMPETITION_LADDER

    pool = dict(COMPETITION_LADDER)[12]
    assert "tournament-12p-europe" not in pool, (
        "tournament-12p-europe must remain quarantined from the 12P "
        f"Competition pool; saw {pool!r}"
    )


@pytest.mark.parametrize(
    "manifest_name", ["coworld_manifest.json", "coworld_manifest_template.json"]
)
def test_tournament_12p_europe_manifest_shape_matches_sibling_12p_variants(
    manifest_name: str,
) -> None:
    # World and Asia are the reference points named in the restoration
    # request: Europe's declared config must be byte-identical to theirs
    # except for the map itself, so the fix is "restore Europe", not "give
    # Europe a different, unproven ruleset".
    import json

    manifest_path = Path(__file__).parents[2] / "coworld" / manifest_name
    manifest = json.loads(manifest_path.read_text())
    variants = {v["id"]: v for v in manifest["variants"]}

    assert "tournament-12p-europe" in variants, (
        "tournament-12p-europe must be declared in the checked-in manifest"
    )
    europe = variants["tournament-12p-europe"]
    world = variants["tournament-12p-world"]

    assert europe["name"] == "Tournament 12P - Europe"
    europe_config = europe["game_config"]
    world_config = world["game_config"]

    assert europe_config["map"] == "Europe"
    assert europe_config["difficulty"] == world_config["difficulty"] == "Easy"
    assert europe_config["num_agents"] == world_config["num_agents"] == 12
    assert len(europe_config["players"]) == len(world_config["players"]) == 12

    # Same competitive budget as every other 12P map -- not shortened to
    # dodge the original timeout risk (per restoration requirement).
    for field in (
        "max_decision_steps",
        "turns_per_decision_step",
        "max_decision_ms",
        "map_size",
        "replay_tail_turns",
        "player_connect_timeout_seconds",
        "episode_timeout_seconds",
    ):
        assert europe_config[field] == world_config[field], (
            f"{field} diverges between Europe ({europe_config[field]!r}) and "
            f"World ({world_config[field]!r}); 12P variants must share one budget"
        )
    assert europe_config["max_decision_steps"] == 500
    assert europe_config["turns_per_decision_step"] == 100


def test_competition_ladder_twelve_p_ids_are_unique() -> None:
    from commissioners.proxywar_app import COMPETITION_LADDER

    pool = dict(COMPETITION_LADDER)[12]
    assert len(pool) == len(set(pool)), f"duplicate id in 12P pool: {pool!r}"


def _with_full_ladder(round_start: RoundStart) -> RoundStart:
    # `competition_round_start` only declares a single 12p variant by
    # default (matching the champion-field-heavy fixtures above); these
    # episodeIndex tests use a small 4-champion field, so the full declared
    # ladder (2/4/8/12) must be present for `_fit_ladder_rung` to route to
    # a rung the field can actually fill.
    round_start.variants = [
        VariantInfo(
            id=f"tournament-{seat_count}p-pangaea",
            name=f"{seat_count}-player Pangaea",
            game_config={"num_agents": seat_count},
        )
        for seat_count in (2, 4, 8, 12)
    ]
    return round_start


def test_competition_schedule_stamps_episode_index_overrides() -> None:
    round_start = _with_full_ladder(competition_round_start(4))
    round_start.round_number = 1

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    assert len(scheduled.episodes) > 0
    for episode in scheduled.episodes:
        assert "episodeIndex" in episode.game_config_overrides
        assert isinstance(episode.game_config_overrides["episodeIndex"], int)
        assert episode.game_config_overrides["episodeIndex"] >= 0
        assert episode.game_config_overrides["seed"] == episode.seed


def test_qualifier_schedule_stamps_episode_index_overrides() -> None:
    round_start = qualifier_round_start()

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    assert len(scheduled.episodes) > 0
    for episode in scheduled.episodes:
        assert "episodeIndex" in episode.game_config_overrides
        assert isinstance(episode.game_config_overrides["episodeIndex"], int)
        assert episode.game_config_overrides["episodeIndex"] >= 0
        assert episode.game_config_overrides["seed"] == episode.seed


@pytest.mark.parametrize("path", ["competition", "qualifier"])
def test_per_episode_indices_are_consecutive_within_a_round(path: str) -> None:
    if path == "competition":
        round_start = _with_full_ladder(competition_round_start(4))
        round_start.round_number = 1
    else:
        round_start = qualifier_round_start()

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)

    indices = [
        episode.game_config_overrides["episodeIndex"] for episode in scheduled.episodes
    ]
    n = len(indices)
    assert n > 0
    expected = list(range(indices[0], indices[0] + n))
    assert indices == expected, (
        f"episode indices within one round must be consecutive; got {indices}"
    )


def test_episode_index_advances_across_comparable_rounds_never_resets() -> None:
    # "Comparable" here means the same champion field -> the same ladder rung
    # -> the same per-round episode count, the documented precondition for
    # the rotation to stay aligned round over round.
    round_start = _with_full_ladder(competition_round_start(4))

    round_start.round_number = 5
    first_round = commissioner().schedule_episodes_for_round_start(round_start)
    first_indices = [
        episode.game_config_overrides["episodeIndex"]
        for episode in first_round.episodes
    ]

    round_start.round_number = 6
    second_round = commissioner().schedule_episodes_for_round_start(round_start)
    second_indices = [
        episode.game_config_overrides["episodeIndex"]
        for episode in second_round.episodes
    ]

    assert len(first_indices) == len(second_indices), (
        "this test's premise requires two comparable (same-width) rounds"
    )
    assert min(second_indices) > max(first_indices), (
        "the next equivalent round must advance the episode index, never reset it: "
        f"round 5 -> {first_indices}, round 6 -> {second_indices}"
    )


def test_n_indices_rotate_a_fixed_roster_through_n_slots() -> None:
    # For any single round of N episodes, `_with_episode_index` assigns N
    # CONSECUTIVE integers (proven by the consecutiveness test above). N
    # consecutive integers modulo N are, by construction, a complete
    # residue system - i.e. exactly {0, 1, ..., N-1} in some order. That
    # mod-N value is what `AgentSpawnAssignment.spawnSlotForRosterIndex`
    # uses on the ProxyWar side to pick a roster's fairness slot, so this
    # proves a fixed N-seat roster rotates through every one of its N
    # slots across N consecutive occurrences of a same-width round.
    round_start = _with_full_ladder(competition_round_start(4))
    round_start.round_number = 3

    scheduled = commissioner().schedule_episodes_for_round_start(round_start)
    indices = [
        episode.game_config_overrides["episodeIndex"] for episode in scheduled.episodes
    ]
    n = len(indices)
    assert n > 0
    residues = {index % n for index in indices}
    assert residues == set(range(n)), (
        f"{n} consecutive indices must cover every slot 0..{n - 1} mod {n}; "
        f"got residues {sorted(residues)} from indices {indices}"
    )


def test_with_episode_index_preserves_existing_overrides() -> None:
    from commissioners.common.protocol import EpisodeRequest, ScheduleEpisodes

    schedule = ScheduleEpisodes(
        episodes=[
            EpisodeRequest(
                request_id="0",
                variant_id="v",
                policy_version_ids=[],
                game_config_overrides={"existing_flag": "keep-me"},
                seed=1,
            ),
            EpisodeRequest(
                request_id="1",
                variant_id="v",
                policy_version_ids=[],
                seed=2,
            ),
        ]
    )

    stamped = ProxyWarCommissioner._with_episode_index(schedule, round_number=1)

    assert stamped.episodes[0].game_config_overrides == {
        "existing_flag": "keep-me",
        "episodeIndex": 0,
        "seed": 1,
    }
    assert stamped.episodes[1].game_config_overrides == {
        "episodeIndex": 1,
        "seed": 2,
    }


@pytest.mark.parametrize("seed", [-1, EPISODE_SEED_MAX + 1])
def test_episode_request_rejects_seed_outside_manifest_range(seed: int) -> None:
    with pytest.raises(ValueError):
        EpisodeRequest(
            request_id="out-of-range-seed",
            variant_id="v",
            policy_version_ids=[],
            seed=seed,
        )


def test_every_manifest_declares_episode_index_in_config_schema() -> None:
    import json

    manifest_dir = Path(__file__).parents[2] / "coworld"
    manifest_paths = sorted(manifest_dir.glob("coworld_manifest*.json"))
    assert len(manifest_paths) >= 10, (
        f"expected every shipped manifest under {manifest_dir}, found {manifest_paths}"
    )
    for manifest_path in manifest_paths:
        manifest = json.loads(manifest_path.read_text())
        schema = manifest["game"]["config_schema"]
        assert schema["additionalProperties"] is False, manifest_path
        properties = schema["properties"]
        assert "episodeIndex" in properties, (
            f"{manifest_path} config_schema is missing episodeIndex"
        )
        episode_index_schema = properties["episodeIndex"]
        assert episode_index_schema["type"] == "integer", manifest_path
        assert episode_index_schema["minimum"] == 0, manifest_path
        assert "episodeIndex" not in schema.get("required", []), (
            f"{manifest_path}: episodeIndex must stay optional (default 0)"
        )


def test_current_manifests_match_the_commissioner_seed_range() -> None:
    import json

    manifest_dir = Path(__file__).parents[2] / "coworld"
    for name in ["coworld_manifest.json", "coworld_manifest_template.json"]:
        manifest_path = manifest_dir / name
        manifest = json.loads(manifest_path.read_text())
        seed_schema = manifest["game"]["config_schema"]["properties"]["seed"]
        assert seed_schema["minimum"] == 0, manifest_path
        assert seed_schema["maximum"] == EPISODE_SEED_MAX, manifest_path


def test_live_dispatch_throttle_caps_competition_at_five_episodes() -> None:
    throttle = commissioner().dispatch_throttle_config()

    assert throttle.enabled is True
    # Live 12-seat episodes run episode_timeout_seconds=3600 and get the full
    # configured max_in_flight ceiling.
    assert throttle.max_concurrent_episodes(3600) == 5
    # Short-timeout certification smokes stay below the ceiling because the
    # duty-cycle load formula binds first.
    assert throttle.max_concurrent_episodes(180) == 3
    assert throttle.episode_stagger_seconds(3600) == 0


def test_dispatch_acknowledgements_preserve_capacity_and_named_rejections_drain() -> None:
    round_start = competition_round_start(24)

    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(round_start.to_json())
        initial_message = websocket.receive_json()
        assert [
            episode["request_id"] for episode in initial_message["episodes"]
        ] == ["0"]

        # Each acknowledgement opens exactly one more request until the
        # max_in_flight=5 window is full.
        for accepted_index in range(4):
            websocket.send_json(
                {
                    "type": "episodes_accepted",
                    "request_ids": [str(accepted_index)],
                }
            )
            opened = websocket.receive_json()
            assert [episode["request_id"] for episode in opened["episodes"]] == [
                str(accepted_index + 1)
            ]

        # An explicit, named rejection settles only that request and drains
        # exactly one queued replacement into the newly free slot.
        websocket.send_json(
            {
                "type": "episodes_rejected",
                "request_ids": ["4"],
                "errors": {"4": "synthetic platform rejection"},
            }
        )
        replacement = websocket.receive_json()
        assert [episode["request_id"] for episode in replacement["episodes"]] == [
            "5"
        ]

        # Duplicate acceptance is idempotent. A terminal failure may also be
        # followed by a late duplicate acknowledgement without reopening the
        # dispatch window.
        websocket.send_json({"type": "episodes_accepted", "request_ids": ["0"]})
        with pytest.raises(WouldBlock):
            websocket.portal.call(websocket._send_rx.receive_nowait)
        websocket.send_json(
            {
                "type": "episode_failed",
                "request_id": "1",
                "error": "synthetic settlement-before-duplicate-ack",
            }
        )
        next_replacement = websocket.receive_json()
        assert [
            episode["request_id"] for episode in next_replacement["episodes"]
        ] == ["6"]
        websocket.send_json({"type": "episodes_accepted", "request_ids": ["1"]})
        with pytest.raises(WouldBlock):
            websocket.portal.call(websocket._send_rx.receive_nowait)

        websocket.send_json(
            {"type": "round_abort", "reason": "synthetic acknowledgement test complete"}
        )


@pytest.mark.parametrize(
    "message, expected_reason",
    [
        (
            {"type": "episodes_accepted", "request_ids": ["999"]},
            "accepted unknown or unsent episode request id",
        ),
        (
            {
                "type": "episodes_rejected",
                "request_ids": ["999"],
                "errors": {"999": "synthetic"},
            },
            "rejected unknown or unsent episode request id",
        ),
    ],
)
def test_dispatch_rejects_unknown_acknowledgement_ids(
    message: dict[str, object], expected_reason: str
) -> None:
    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(competition_round_start(24).to_json())
        websocket.receive_json()
        websocket.send_json(message)
        close_message = websocket.receive()
        assert close_message["type"] == "websocket.close"
        assert close_message["code"] == 1008
        assert expected_reason in close_message["reason"]


def test_dispatch_does_not_accept_acknowledgement_before_staggered_send() -> None:
    with TestClient(create_app(commissioner_with_stagger(60))).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(competition_round_start(17).to_json())
        first = websocket.receive_json()
        assert [episode["request_id"] for episode in first["episodes"]] == ["0"]

        # Request 1 reserves throttle capacity but its delay has not elapsed,
        # so the platform cannot validly acknowledge or reject it yet.
        websocket.send_json(
            {
                "type": "episodes_rejected",
                "request_ids": ["1"],
                "errors": {"1": "premature synthetic rejection"},
            }
        )
        close_message = websocket.receive()
        assert close_message["type"] == "websocket.close"
        assert close_message["code"] == 1008
        assert "rejected unknown or unsent episode request id" in close_message["reason"]


@pytest.mark.parametrize(
    "message, expected_reason",
    [
        (
            {"type": "episode_result", "request_id": "1", "scores": []},
            "result for unknown or unsent episode request id",
        ),
        (
            {
                "type": "episode_failed",
                "request_id": "1",
                "error": "premature synthetic failure",
            },
            "failure for unknown or unsent episode request id",
        ),
    ],
)
def test_dispatch_rejects_terminal_message_before_staggered_send(
    message: dict[str, object], expected_reason: str
) -> None:
    with TestClient(create_app(commissioner_with_stagger(60))).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(competition_round_start(17).to_json())
        websocket.receive_json()
        websocket.send_json(message)
        close_message = websocket.receive()
        assert close_message["type"] == "websocket.close"
        assert close_message["code"] == 1008
        assert expected_reason in close_message["reason"]


def test_episode_batch_is_not_marked_sent_while_waiting_for_send_lock() -> None:
    async def scenario() -> None:
        lock = asyncio.Lock()
        await lock.acquire()
        messages: list[dict[str, object]] = []
        marked: list[str] = []

        class FakeWebSocket:
            async def send_json(self, message: dict[str, object]) -> None:
                messages.append(message)

        episode = EpisodeRequest(
            request_id="0",
            variant_id="v",
            policy_version_ids=[],
        )
        task = asyncio.create_task(
            _send_episode_batch(
                FakeWebSocket(),  # type: ignore[arg-type]
                lock,
                [episode],
                lambda sent: marked.extend(item.request_id for item in sent),
            )
        )
        await asyncio.sleep(0)
        assert messages == []
        assert marked == []
        lock.release()
        await task
        assert len(messages) == 1
        assert marked == ["0"]

    asyncio.run(scenario())


def test_episode_batch_is_not_marked_sent_when_transmission_fails() -> None:
    async def scenario() -> None:
        marked: list[str] = []

        class FailingWebSocket:
            async def send_json(self, _message: dict[str, object]) -> None:
                raise RuntimeError("synthetic transport failure")

        episode = EpisodeRequest(
            request_id="0",
            variant_id="v",
            policy_version_ids=[],
        )
        with pytest.raises(RuntimeError, match="synthetic transport failure"):
            await _send_episode_batch(
                FailingWebSocket(),  # type: ignore[arg-type]
                asyncio.Lock(),
                [episode],
                lambda sent: marked.extend(item.request_id for item in sent),
            )
        assert marked == []

    asyncio.run(scenario())


def test_dispatch_rejects_accept_then_reject_contradiction() -> None:
    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(competition_round_start(24).to_json())
        websocket.receive_json()
        websocket.send_json({"type": "episodes_accepted", "request_ids": ["0"]})
        scheduled = websocket.receive_json()
        assert [episode["request_id"] for episode in scheduled["episodes"]] == ["1"]
        websocket.send_json(
            {
                "type": "episodes_rejected",
                "request_ids": ["0"],
                "errors": {"0": "synthetic contradiction"},
            }
        )
        close_message = websocket.receive()
        assert close_message["type"] == "websocket.close"
        assert close_message["code"] == 1008
        assert "rejected previously accepted episode request id" in close_message["reason"]


def test_unthrottled_server_accepts_batch_acknowledgement_and_completes() -> None:
    round_start = competition_round_start(12)
    unthrottled = commissioner()
    unthrottled.dispatch_throttle_config = lambda: None  # type: ignore[method-assign]

    with TestClient(create_app(unthrottled)).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(round_start.to_json())
        scheduled = websocket.receive_json()
        request_ids = [
            episode["request_id"] for episode in scheduled["episodes"]
        ]
        assert scheduled["type"] == "schedule_episodes"
        assert request_ids

        websocket.send_json(
            {"type": "episodes_accepted", "request_ids": request_ids}
        )
        for request_id in request_ids:
            websocket.send_json(
                {
                    "type": "episode_failed",
                    "request_id": request_id,
                    "error": "synthetic unthrottled settlement",
                }
            )
        complete = websocket.receive_json()
        assert complete["type"] == "round_complete"


def test_live_17_champion_server_dispatches_five_then_drains_the_queue() -> None:
    round_start = competition_round_start(17)

    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(round_start.to_json())

        # Open the max_in_flight=5 window one acknowledged request at a time.
        # Production proved that back-to-back single messages admitted only the
        # first request, while one three-request batch admitted none.
        initial_message = websocket.receive_json()
        assert initial_message["type"] == "schedule_episodes"
        assert [episode["request_id"] for episode in initial_message["episodes"]] == [
            "0"
        ]

        for accepted_index in range(4):
            websocket.send_json(
                {
                    "type": "episodes_accepted",
                    "request_ids": [str(accepted_index)],
                }
            )
            next_message = websocket.receive_json()
            assert next_message["type"] == "schedule_episodes"
            assert [episode["request_id"] for episode in next_message["episodes"]] == [
                str(accepted_index + 1)
            ]

        websocket.send_json({"type": "episodes_accepted", "request_ids": ["4"]})

        with pytest.raises(WouldBlock):
            websocket.portal.call(websocket._send_rx.receive_nowait)

        # 17 champions -> 6 episodes, so the queue holds exactly one episode
        # beyond the five-slot window. The first settlement drains it; further
        # settlements find the queue empty and open nothing.
        websocket.send_json(
            {
                "type": "episode_failed",
                "request_id": "0",
                "error": "synthetic throttle-test settlement",
            }
        )
        replacement = websocket.receive_json()
        assert replacement["type"] == "schedule_episodes"
        # One slot freed -> exactly one replacement episode, still sent
        # as its own single-episode batch.
        assert [episode["request_id"] for episode in replacement["episodes"]] == [
            "5"
        ]
        websocket.send_json({"type": "episodes_accepted", "request_ids": ["5"]})

        for settled_index in (1, 2):
            websocket.send_json(
                {
                    "type": "episode_failed",
                    "request_id": str(settled_index),
                    "error": "synthetic throttle-test settlement",
                }
            )
            with pytest.raises(WouldBlock):
                websocket.portal.call(websocket._send_rx.receive_nowait)

        websocket.send_json(
            {"type": "round_abort", "reason": "synthetic throttle test complete"}
        )


@pytest.mark.parametrize("terminal_type", ["episode_result", "episode_failed"])
def test_duplicate_terminal_message_does_not_reopen_dispatch_capacity(
    terminal_type: str,
) -> None:
    # 18 champions -> 7 episodes: after the window fills and one settlement
    # dispatches "5", episode "6" is still queued, so a wrongly reopened slot
    # would observably emit it instead of blocking.
    round_start = competition_round_start(18)
    terminal = (
        {"type": "episode_result", "request_id": "0", "scores": []}
        if terminal_type == "episode_result"
        else {"type": "episode_failed", "request_id": "0", "error": "synthetic"}
    )

    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(round_start.to_json())
        for request_id in ("0", "1", "2", "3", "4"):
            scheduled = websocket.receive_json()
            assert [episode["request_id"] for episode in scheduled["episodes"]] == [
                request_id
            ]
            websocket.send_json(
                {"type": "episodes_accepted", "request_ids": [request_id]}
            )

        websocket.send_json(terminal)
        replacement = websocket.receive_json()
        assert [episode["request_id"] for episode in replacement["episodes"]] == [
            "5"
        ]
        websocket.send_json({"type": "episodes_accepted", "request_ids": ["5"]})

        websocket.send_json(terminal)
        with pytest.raises(WouldBlock):
            websocket.portal.call(websocket._send_rx.receive_nowait)

        websocket.send_json({"type": "round_abort", "reason": "duplicate tested"})


@pytest.mark.parametrize(
    "first, second, expected_reason",
    [
        (
            {"type": "episode_result", "request_id": "0", "scores": []},
            {
                "type": "episode_result",
                "request_id": "0",
                "scores": [],
                "game_results": {"winner": "different"},
            },
            "conflicting duplicate result",
        ),
        (
            {
                "type": "episode_failed",
                "request_id": "0",
                "error": "first failure",
            },
            {
                "type": "episode_failed",
                "request_id": "0",
                "error": "different failure",
            },
            "failure contradicts prior terminal failure",
        ),
        (
            {"type": "episode_result", "request_id": "0", "scores": []},
            {
                "type": "episode_failed",
                "request_id": "0",
                "error": "contradiction",
            },
            "failure contradicts prior result",
        ),
        (
            {
                "type": "episode_failed",
                "request_id": "0",
                "error": "first failure",
            },
            {"type": "episode_result", "request_id": "0", "scores": []},
            "result contradicts prior terminal failure",
        ),
    ],
)
def test_conflicting_terminal_messages_close_the_round_socket(
    first: dict[str, object],
    second: dict[str, object],
    expected_reason: str,
) -> None:
    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(competition_round_start(17).to_json())
        scheduled = websocket.receive_json()
        assert [episode["request_id"] for episode in scheduled["episodes"]] == [
            "0"
        ]
        websocket.send_json(first)
        websocket.receive_json()  # replacement request opens the freed slot
        websocket.send_json(second)
        close_message = websocket.receive()
        assert close_message["type"] == "websocket.close"
        assert close_message["code"] == 1008
        assert expected_reason in close_message["reason"]


def test_result_after_rejection_closes_the_round_socket() -> None:
    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(competition_round_start(17).to_json())
        websocket.receive_json()
        websocket.send_json(
            {
                "type": "episodes_rejected",
                "request_ids": ["0"],
                "errors": {"0": "synthetic admission refusal"},
            }
        )
        websocket.receive_json()  # replacement request opens the freed slot
        websocket.send_json(
            {"type": "episode_result", "request_id": "0", "scores": []}
        )
        close_message = websocket.receive()
        assert close_message["type"] == "websocket.close"
        assert close_message["code"] == 1008
        assert "result contradicts prior terminal failure or rejection" in close_message[
            "reason"
        ]


def test_conflicting_duplicate_rejection_closes_the_round_socket() -> None:
    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(competition_round_start(17).to_json())
        websocket.receive_json()
        websocket.send_json(
            {
                "type": "episodes_rejected",
                "request_ids": ["0"],
                "errors": {"0": "first refusal"},
            }
        )
        websocket.receive_json()  # replacement request opens the freed slot
        websocket.send_json(
            {
                "type": "episodes_rejected",
                "request_ids": ["0"],
                "errors": {"0": "different refusal"},
            }
        )
        close_message = websocket.receive()
        assert close_message["type"] == "websocket.close"
        assert close_message["code"] == 1008
        assert "conflicting duplicate rejection" in close_message["reason"]


@pytest.mark.parametrize("terminal_type", ["episode_result", "episode_failed"])
def test_queued_undispatched_terminal_message_is_rejected(
    terminal_type: str,
) -> None:
    round_start = competition_round_start(17)
    future = (
        {"type": "episode_result", "request_id": "1", "scores": []}
        if terminal_type == "episode_result"
        else {
            "type": "episode_failed",
            "request_id": "1",
            "error": "future synthetic",
        }
    )

    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(round_start.to_json())
        first = websocket.receive_json()
        assert [episode["request_id"] for episode in first["episodes"]] == ["0"]
        websocket.send_json(future)
        with pytest.raises(WebSocketDisconnect) as closed:
            websocket.receive_json()
        assert closed.value.code == 1008


def test_live_25_champion_round_drains_all_fourteen_episodes_via_acknowledged_windows() -> (
    None
):
    # 25 champions / 12 seats -> 14 episodes (rolling-window coverage),
    # max_in_flight=5 from the live config -- the exact live shape. The full
    # acknowledged drain to round_complete is what round 1323 (0.1.24) failed
    # to reach.
    round_start = competition_round_start(25)

    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(round_start.to_json())

        initial_message = websocket.receive_json()
        assert initial_message["type"] == "schedule_episodes"
        assert [episode["request_id"] for episode in initial_message["episodes"]] == [
            "0"
        ]

        for accepted_index in range(4):
            websocket.send_json(
                {
                    "type": "episodes_accepted",
                    "request_ids": [str(accepted_index)],
                }
            )
            next_message = websocket.receive_json()
            assert next_message["type"] == "schedule_episodes"
            assert [episode["request_id"] for episode in next_message["episodes"]] == [
                str(accepted_index + 1)
            ]

        websocket.send_json({"type": "episodes_accepted", "request_ids": ["4"]})

        with pytest.raises(WouldBlock):
            websocket.portal.call(websocket._send_rx.receive_nowait)

        for settled_index in range(9):
            websocket.send_json(
                {
                    "type": "episode_failed",
                    "request_id": str(settled_index),
                    "error": "synthetic full-drain settlement",
                }
            )
            replacement = websocket.receive_json()
            assert replacement["type"] == "schedule_episodes"
            assert [episode["request_id"] for episode in replacement["episodes"]] == [
                str(settled_index + 5)
            ]
            websocket.send_json(
                {
                    "type": "episodes_accepted",
                    "request_ids": [str(settled_index + 5)],
                }
            )

        with pytest.raises(WouldBlock):
            websocket.portal.call(websocket._send_rx.receive_nowait)

        for settled_index in range(9, 13):
            websocket.send_json(
                {
                    "type": "episode_failed",
                    "request_id": str(settled_index),
                    "error": "synthetic full-drain settlement",
                }
            )
            with pytest.raises(WouldBlock):
                websocket.portal.call(websocket._send_rx.receive_nowait)

        websocket.send_json(
            {
                "type": "episode_failed",
                "request_id": "13",
                "error": "synthetic full-drain settlement",
            }
        )
        complete_message = websocket.receive_json()
        assert complete_message["type"] == "round_complete"


def test_rejected_episode_is_recorded_and_dispatch_window_continues() -> None:
    round_start = competition_round_start(17)

    with TestClient(create_app(commissioner())).websocket_connect(
        "/round"
    ) as websocket:
        websocket.send_json(round_start.to_json())
        initial_message = websocket.receive_json()
        assert [episode["request_id"] for episode in initial_message["episodes"]] == [
            "0"
        ]

        websocket.send_json(
            {
                "type": "episodes_rejected",
                "request_ids": ["0"],
                "errors": {"0": "synthetic admission refusal"},
            }
        )
        replacement = websocket.receive_json()
        assert replacement["type"] == "schedule_episodes"
        assert [episode["request_id"] for episode in replacement["episodes"]] == ["1"]

        websocket.send_json(
            {"type": "round_abort", "reason": "synthetic rejection test complete"}
        )
