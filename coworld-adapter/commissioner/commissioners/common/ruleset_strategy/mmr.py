"""Per-policy OpenSkill (Plackett-Luce) MMR ranking for a division leaderboard.

Each completed round is treated as one free-for-all match: the participating policy versions are
fed to the Bayesian rater ordered by their finishing rank (lower is better; ties allowed), so a
policy's rating reflects the strength of the opponents it actually beat, not a raw score. Rounds
are replayed oldest-first so ratings evolve causally. The displayed MMR is the conservative ordinal
mu - 3*sigma. A newly-uploaded champion from a player who already has a rated policy inherits that
player's best established mu and is treated as already placed -- it keeps the score and is ranked
immediately, with no placement period. Only a genuinely new player's first policy must complete the
placement games before it earns a numeric rank (so a single lucky win can't rocket it to the top).

Mirrors the platform-side ranker in app_backend `v2/commissioners.rank_division_by_mmr`.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any
from uuid import UUID

from openskill.models import PlackettLuce

from commissioners.common.models import (
    DivisionLeaderboardContext,
    DivisionLeaderboardSnapshot,
    LeaderboardRoundResultSnapshot,
)

# A policy must complete at least this many rated games before it earns a numeric rank. Until then
# it is rated (its games still shift others' ratings) but sorts after ranked policies, so a single
# lucky win can't rocket a brand-new policy to the top.
MMR_PLACEMENT_MIN_GAMES = 5


class _MmrPolicy:
    """Mutable per-policy rating state accumulated while replaying a division's rounds."""

    def __init__(self, result: LeaderboardRoundResultSnapshot, rating: Any, inherited: bool) -> None:
        self.policy_version_id = result.policy_version_id
        self.player_id = result.player_id
        self.player_name = result.player_name
        self.rating = rating
        # True when this policy started from its player's established rating (a newly-uploaded
        # champion from a player who already has a rated policy). Such a policy keeps that rating
        # and is treated as already placed, so it never sits in the placement period.
        self.inherited = inherited
        self.wins = 0
        self.losses = 0
        self.games_played = 0


def rank_division_by_mmr(
    ctx: DivisionLeaderboardContext,
    *,
    placement_min_games: int = MMR_PLACEMENT_MIN_GAMES,
) -> list[DivisionLeaderboardSnapshot]:
    if not ctx.round_results or not ctx.completed_rounds:
        return []

    # Keep each policy's best result per round (highest score, ties broken by lower rank), so a round
    # contributes one finishing position per policy even if it posted multiple episodes.
    best_result: dict[tuple[UUID, UUID], LeaderboardRoundResultSnapshot] = {}
    for result in ctx.round_results:
        key = (result.policy_version_id, result.round_id)
        current = best_result.get(key)
        if current is None or (result.score, -result.rank) > (current.score, -current.rank):
            best_result[key] = result

    results_by_round: dict[UUID, list[LeaderboardRoundResultSnapshot]] = defaultdict(list)
    for result in best_result.values():
        results_by_round[result.round_id].append(result)

    model = PlackettLuce()
    player_prior_mu: dict[Any, float] = {}
    policies: dict[UUID, _MmrPolicy] = {}

    # ctx.completed_rounds is newest-first; replay oldest-first so ratings evolve causally.
    for round_row in reversed(ctx.completed_rounds):
        round_results = results_by_round.get(round_row.id)
        if not round_results or len(round_results) < 2:
            continue  # a one-policy round is not a match — nothing to learn from it
        for result in round_results:
            if result.policy_version_id not in policies:
                prior_mu = player_prior_mu.get(result.player_id)
                rating = model.rating(mu=prior_mu) if prior_mu is not None else model.rating()
                policies[result.policy_version_id] = _MmrPolicy(result, rating, inherited=prior_mu is not None)

        ordered = sorted(round_results, key=lambda r: r.rank)
        rated = model.rate(
            [[policies[r.policy_version_id].rating] for r in ordered],
            ranks=[r.rank for r in ordered],
        )
        for result, team in zip(ordered, rated, strict=True):
            policy = policies[result.policy_version_id]
            policy.rating = team[0]
            policy.games_played += 1
            if result.rank == 1:
                policy.wins += 1
            else:
                policy.losses += 1
            if policy.games_played >= placement_min_games and policy.player_id is not None:
                best = player_prior_mu.get(policy.player_id)
                if best is None or policy.rating.mu > best:
                    player_prior_mu[policy.player_id] = policy.rating.mu

    # Placed policies first (by descending MMR), then in-placement, also by MMR. A policy that
    # inherited its player's established rating is already placed -- a newly-uploaded champion keeps
    # the score and skips placement; only a genuinely new player's first policy must place.
    ordered_policies = sorted(
        policies.values(),
        key=lambda p: (
            p.games_played < placement_min_games and not p.inherited,
            -p.rating.ordinal(),
            str(p.policy_version_id),
        ),
    )
    return [
        DivisionLeaderboardSnapshot(
            player_id=policy.player_id,
            player_name=policy.player_name,
            rank=rank,
            score=policy.rating.ordinal(),
            rounds_played=policy.games_played,
            policy_version_ids={policy.policy_version_id},
        )
        for rank, policy in enumerate(ordered_policies, start=1)
        if policy.player_id is not None
    ]
