from __future__ import annotations

import random
import time
from collections import defaultdict
from typing import Any

from openskill.models import PlackettLuce

from commissioners.common.models import PolicyPool, PolicyPoolEntry, PoolConfig
from commissioners.common.protocol import EpisodeRequest as CommissionerEpisodeRequest
from commissioners.common.protocol import ScheduleEpisodes as CommissionerScheduleEpisodes
from commissioners.common.utils import (
    _build_entry_indices,
    _build_rolling_window_entry_indices,
    _build_sliding_window_entry_indices,
    _entry_index_offset,
    _pool_episode_count,
)
from commissioners.common.ruleset_strategy.config import RulesetStrategyCommissionerConfig


def schedule_entries(
    *,
    pool: PolicyPool,
    primary_entries: list[PolicyPoolEntry],
    filler_entries: list[PolicyPoolEntry],
    num_agents: int,
    variant_id: str,
    game_config: dict[str, Any] | None,
    config: RulesetStrategyCommissionerConfig,
    recent_results: list[Any] | None = None,
) -> CommissionerScheduleEpisodes:
    if not primary_entries:
        raise ValueError("pool must have at least one primary entry")
    pool_config = PoolConfig.model_validate(pool.config)
    if pool_config.self_play:
        episodes_per_entrant = pool_config.min_episodes_per_entrant or pool_config.num_episodes
        return CommissionerScheduleEpisodes(
            episodes=[
                CommissionerEpisodeRequest(
                    request_id=str(entry_index * episodes_per_entrant + episode_index),
                    variant_id=variant_id,
                    game_config=game_config,
                    policy_version_ids=[entry.policy_version_id] * num_agents,
                    tags={"pool_id": str(pool.id)},
                )
                for entry_index, entry in enumerate(primary_entries)
                for episode_index in range(episodes_per_entrant)
            ]
        )

    if config.seating == "team_blocks":
        team_count = config.defaults.team_count
        if len(primary_entries) < team_count:
            raise ValueError(f"team_blocks seating requires at least {team_count} primary entries")
        if num_agents % team_count != 0:
            raise ValueError(f"team_blocks seating requires num_agents divisible by {team_count}")

        team_size = num_agents // team_count
        num_episodes = _pool_episode_count(
            config=pool_config,
            num_entries=len(primary_entries),
            num_agents=team_count,
        )
        episodes: list[CommissionerEpisodeRequest] = []
        for job_index in range(num_episodes):
            entry_indices = [
                (job_index * team_count + team_index) % len(primary_entries) for team_index in range(team_count)
            ]
            rotation = job_index % team_count
            entry_indices = entry_indices[rotation:] + entry_indices[:rotation]
            episodes.append(
                CommissionerEpisodeRequest(
                    request_id=str(job_index),
                    variant_id=variant_id,
                    game_config=game_config,
                    policy_version_ids=[
                        primary_entries[entry_index].policy_version_id
                        for entry_index in entry_indices
                        for _slot in range(team_size)
                    ],
                    tags={"pool_id": str(pool.id)},
                )
            )
        return CommissionerScheduleEpisodes(episodes=episodes)

    if config.seating == "leaderboard_neighbors":
        return _schedule_leaderboard_neighbors(
            pool=pool,
            pool_config=pool_config,
            primary_entries=primary_entries,
            filler_entries=filler_entries,
            num_agents=num_agents,
            variant_id=variant_id,
            game_config=game_config,
            recent_results=recent_results or [],
        )

    if config.seating == "shuffled_window":
        # baseline_window / rolling_window seat a fixed-width window of CONSECUTIVE entries in a
        # seed order that is stable across rounds, so two entries co-occur only when their circular
        # distance is below num_agents -- distant entries never share an episode no matter how many
        # rounds run (a banded matchup graph, not a round-robin). shuffled_window permutes the entry
        # order each time a round is scheduled so the band precesses and full pairwise coverage
        # accrues across rounds (the granularity the EWMA leaderboard aggregates at) while preserving
        # balanced per-entrant appearances. The permutation is seeded from the wall clock, not from
        # any round/pool id, so a re-scheduled round never reuses its previous order.
        primary_entries = _round_shuffled_entries(primary_entries)

    if config.seating == "mmr_neighbors":
        # Order entries by current skill (OpenSkill mu, replayed from recent results) and then
        # rolling-window seat below, so each episode is a cohort of num_agents skill-neighbours --
        # close, informative matches whose outcome actually moves ratings, instead of uniformly
        # random cohorts. The overlapping windows keep the whole field connected (a skill chain) so
        # the MMR ranker can still order across it; a small wall-clock jitter breaks near-ties so
        # cohorts vary round to round and unrated policies (all at the default mu -- e.g. a cold
        # start with no results yet) are seated randomly among themselves.
        primary_entries = _mmr_ordered_entries(primary_entries, recent_results or [])

    num_episodes = _pool_episode_count(
        config=pool_config,
        num_entries=len(primary_entries),
        num_agents=num_agents,
    )
    return CommissionerScheduleEpisodes(
        episodes=[
            CommissionerEpisodeRequest(
                request_id=str(job_index),
                variant_id=variant_id,
                game_config=game_config,
                policy_version_ids=[
                    entry.policy_version_id
                    for entry in episode_entries(
                        job_index,
                        primary_entries=primary_entries,
                        filler_entries=filler_entries,
                        num_agents=num_agents,
                        config=config,
                    )
                ],
                tags={"pool_id": str(pool.id)},
            )
            for job_index in range(num_episodes)
        ]
    )


def episode_entries(
    job_index: int,
    *,
    primary_entries: list[PolicyPoolEntry],
    filler_entries: list[PolicyPoolEntry],
    num_agents: int,
    config: RulesetStrategyCommissionerConfig,
) -> list[PolicyPoolEntry]:
    if len(primary_entries) >= num_agents:
        if config.seating == "baseline_window":
            indices = _build_entry_indices(
                num_entries=len(primary_entries),
                num_agents=num_agents,
                offset=_entry_index_offset(
                    job_index=job_index,
                    num_entries=len(primary_entries),
                    num_agents=num_agents,
                ),
            )
        elif config.seating == "mmr_neighbors":
            # Non-wrapping sliding window over the (skill-ordered) entries: cohorts are
            # skill-neighbours and the top never wraps around to face the bottom. Adjacent windows
            # overlap by num_agents-1, so the field stays a single connected chain.
            indices = _build_sliding_window_entry_indices(
                job_index=job_index,
                num_entries=len(primary_entries),
                num_agents=num_agents,
            )
        else:
            indices = _build_rolling_window_entry_indices(
                job_index=job_index,
                num_entries=len(primary_entries),
                num_agents=num_agents,
            )
        return [primary_entries[index] for index in indices]

    seats = list(primary_entries)
    if config.insufficient_players.strategy == "strict":
        raise ValueError(f"not enough primary entries to fill {num_agents} seats")
    if config.insufficient_players.strategy == "fill_from_divisions":
        seats.extend(cycled(filler_entries, num_agents - len(seats), offset=job_index))
    if len(seats) < num_agents and config.insufficient_players.duplicate_after_fill:
        seats.extend(cycled(seats or primary_entries, num_agents - len(seats), offset=job_index))
    if len(seats) < num_agents:
        raise ValueError(f"not enough entries to fill {num_agents} seats")
    return seats[:num_agents]


def cycled(entries: list[PolicyPoolEntry], count: int, *, offset: int = 0) -> list[PolicyPoolEntry]:
    if count <= 0 or not entries:
        return []
    return [entries[(offset + index) % len(entries)] for index in range(count)]


def _round_shuffle_seed() -> int:
    # Wall-clock seed so each scheduling draws a fresh, never-reused permutation (a round id would be
    # reused if the same round were re-scheduled). Isolated in a function so tests can pin it.
    return time.time_ns()


def _round_shuffled_entries(entries: list[PolicyPoolEntry]) -> list[PolicyPoolEntry]:
    shuffled = list(entries)
    random.Random(_round_shuffle_seed()).shuffle(shuffled)
    return shuffled


def _rate_mu_from_recent(recent_results: list[Any]) -> dict[Any, float]:
    """Replay recent round results through OpenSkill and return each policy's current mu.

    Each round is one free-for-all match (policies ordered by finishing rank), replayed oldest-first
    by round number. Mirrors the MMR ranker, but here we only need the mean skill estimate (mu) to
    seat skill-neighbours, so the conservative ordinal and player priors are not applied.
    """
    by_round: dict[Any, list[Any]] = defaultdict(list)
    round_number: dict[Any, Any] = {}
    for result in recent_results:
        round_id = result.round_id
        by_round[round_id].append(result)
        round_number[round_id] = getattr(result, "round_number", 0)

    model = PlackettLuce()
    ratings: dict[Any, Any] = {}
    for round_id in sorted(by_round, key=lambda r: round_number[r]):
        results = by_round[round_id]
        if len(results) < 2:
            continue  # a one-policy round is not a match
        for result in results:
            if result.policy_version_id not in ratings:
                ratings[result.policy_version_id] = model.rating()
        ordered = sorted(results, key=lambda r: r.rank)
        rated = model.rate(
            [[ratings[r.policy_version_id]] for r in ordered],
            ranks=[r.rank for r in ordered],
        )
        for result, team in zip(ordered, rated, strict=True):
            ratings[result.policy_version_id] = team[0]
    return {policy_version_id: rating.mu for policy_version_id, rating in ratings.items()}


def _mmr_ordered_entries(entries: list[PolicyPoolEntry], recent_results: list[Any]) -> list[PolicyPoolEntry]:
    mu_by_policy = _rate_mu_from_recent(recent_results)
    base = PlackettLuce().rating()
    # Wall-clock jitter (~a quarter of the default sigma) breaks near-ties so cohorts vary round to
    # round and unrated policies (all at the default mu) don't form a fixed block, without overriding
    # real skill gaps. Unrated policies sort at the default mu (mid-field) until they earn results.
    rng = random.Random(_round_shuffle_seed())
    jitter_scale = base.sigma * 0.25

    def sort_key(entry: PolicyPoolEntry) -> float:
        mu = mu_by_policy.get(entry.policy_version_id, base.mu)
        return -(mu + rng.gauss(0.0, jitter_scale))

    return sorted(entries, key=sort_key)


def _schedule_leaderboard_neighbors(
    *,
    pool: PolicyPool,
    pool_config: PoolConfig,
    primary_entries: list[PolicyPoolEntry],
    filler_entries: list[PolicyPoolEntry],
    num_agents: int,
    variant_id: str,
    game_config: dict[str, Any] | None,
    recent_results: list[Any],
) -> CommissionerScheduleEpisodes:
    if num_agents != 2:
        raise ValueError("leaderboard_neighbors seating requires a two-player variant")

    episodes_per_entrant = pool_config.min_episodes_per_entrant or pool_config.num_episodes
    ordered_primary_entries = _leaderboard_ordered_entries(primary_entries, recent_results)
    opponent_entries = _dedupe_entries([*ordered_primary_entries, *filler_entries])
    if len(opponent_entries) < 2:
        return CommissionerScheduleEpisodes(episodes=[])

    episodes: list[CommissionerEpisodeRequest] = []
    for anchor_index, anchor in enumerate(ordered_primary_entries):
        ordered_opponents = [entry for entry in opponent_entries if entry.policy_version_id != anchor.policy_version_id]
        if not ordered_opponents:
            continue
        if opponent_entries == ordered_primary_entries:
            neighbors = _leaderboard_neighbors(
                ordered_primary_entries,
                anchor_index,
                episodes_per_entrant,
            )
        else:
            neighbors = _repeat_to_count(ordered_opponents, episodes_per_entrant)
        for opponent in neighbors:
            episodes.append(
                CommissionerEpisodeRequest(
                    request_id=str(len(episodes)),
                    variant_id=variant_id,
                    game_config=game_config,
                    policy_version_ids=[anchor.policy_version_id, opponent.policy_version_id],
                    tags={"pool_id": str(pool.id)},
                )
            )
    return CommissionerScheduleEpisodes(episodes=episodes)


def _leaderboard_ordered_entries(
    entries: list[PolicyPoolEntry],
    recent_results: list[Any],
) -> list[PolicyPoolEntry]:
    entries = _dedupe_entries(entries)
    entry_index = {entry.policy_version_id: index for index, entry in enumerate(entries)}
    scores: dict[Any, list[float]] = {entry.policy_version_id: [] for entry in entries}
    ranks: dict[Any, list[float]] = {entry.policy_version_id: [] for entry in entries}

    for result in recent_results:
        policy_version_id = getattr(result, "policy_version_id", None)
        if policy_version_id not in entry_index:
            continue
        scores[policy_version_id].append(float(getattr(result, "score")))
        ranks[policy_version_id].append(float(getattr(result, "rank")))

    def sort_key(entry: PolicyPoolEntry) -> tuple[int, float, float, int]:
        policy_scores = scores[entry.policy_version_id]
        if not policy_scores:
            return (1, 0.0, float("inf"), entry_index[entry.policy_version_id])
        mean_score = sum(policy_scores) / len(policy_scores)
        mean_rank = sum(ranks[entry.policy_version_id]) / max(1, len(ranks[entry.policy_version_id]))
        return (0, -mean_score, mean_rank, entry_index[entry.policy_version_id])

    return sorted(entries, key=sort_key)


def _leaderboard_neighbors(
    ordered_entries: list[PolicyPoolEntry],
    anchor_index: int,
    count: int,
) -> list[PolicyPoolEntry]:
    max_unique = len(ordered_entries) - 1
    if count <= 0 or max_unique <= 0:
        return []

    below_target = (count + 1) // 2
    above_target = count // 2
    selected: list[PolicyPoolEntry] = []
    selected.extend(_below(ordered_entries, anchor_index, start=1, count=below_target))
    selected.extend(_above(ordered_entries, anchor_index, start=1, count=above_target))

    if len(selected) < min(count, max_unique):
        selected.extend(_below(ordered_entries, anchor_index, start=below_target + 1, count=count))
    if len(selected) < min(count, max_unique):
        selected.extend(_above(ordered_entries, anchor_index, start=above_target + 1, count=count))

    return _repeat_to_count(_dedupe_entries(selected), count)


def _below(
    ordered_entries: list[PolicyPoolEntry],
    anchor_index: int,
    *,
    start: int,
    count: int,
) -> list[PolicyPoolEntry]:
    if count <= 0:
        return []
    first = anchor_index + start
    return ordered_entries[first : first + count]


def _above(
    ordered_entries: list[PolicyPoolEntry],
    anchor_index: int,
    *,
    start: int,
    count: int,
) -> list[PolicyPoolEntry]:
    if count <= 0:
        return []
    first = anchor_index - start
    last = max(-1, first - count)
    return [ordered_entries[index] for index in range(first, last, -1) if index >= 0]


def _repeat_to_count(entries: list[PolicyPoolEntry], count: int) -> list[PolicyPoolEntry]:
    if count <= 0 or not entries:
        return []
    return [entries[index % len(entries)] for index in range(count)]


def _dedupe_entries(entries: list[PolicyPoolEntry]) -> list[PolicyPoolEntry]:
    seen: set[Any] = set()
    deduped: list[PolicyPoolEntry] = []
    for entry in entries:
        if entry.policy_version_id in seen:
            continue
        seen.add(entry.policy_version_id)
        deduped.append(entry)
    return deduped
