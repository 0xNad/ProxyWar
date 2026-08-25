from __future__ import annotations

import json
from collections import Counter
from math import floor, isfinite
from pathlib import Path
from typing import Any

from commissioners.common.app import commissioner_app, run
from commissioners.common.commissioners import register_commissioner
from commissioners.common.protocol import CommissionerRoundReport
from commissioners.common.protocol import (
    EpisodeFailed as CommissionerProtocolEpisodeFailed,
)
from commissioners.common.protocol import (
    EpisodeRequest as CommissionerProtocolEpisodeRequest,
)
from commissioners.common.protocol import (
    EpisodeResult as CommissionerProtocolEpisodeResult,
)
from commissioners.common.protocol import RoundComplete as CommissionerRoundComplete
from commissioners.common.protocol import RoundStart as CommissionerRoundStart
from commissioners.common.protocol import (
    ScheduleEpisodes as CommissionerScheduleEpisodes,
)
from commissioners.common.ruleset_strategy.commissioner import (
    RulesetStrategyCommissioner,
)
from commissioners.common.ruleset_strategy.entrants import select_rule
from commissioners.common.ruleset_strategy.round_start import RoundStartView
from commissioners.common.ruleset_strategy.scheduling import schedule_entries

MAP_ROTATION_CONTRACT_PATH = (
    Path(__file__).resolve().parent
    / "ruleset_strategy_commissioner"
    / "configs"
    / "proxywar-map-rotation.json"
)
_VARIANT_CONFIG_FIELDS = {
    "map": "map",
    "mapSize": "map_size",
    "maxDecisionSteps": "max_decision_steps",
    "turnsPerDecisionStep": "turns_per_decision_step",
    "episodeTimeoutSeconds": "episode_timeout_seconds",
}


def _load_map_rotation_contract() -> tuple[
    list[tuple[int, list[str]]], dict[str, dict[str, Any]]
]:
    """Load the release-pinned map pool and reject malformed scheduler authority.

    The JSON file is copied into the commissioner image and independently checked
    against the Coworld manifest by the release gate. Keeping the pool outside
    executable code lets release review compare the scheduler, manifest, and
    post-release monitoring expectations as one bounded contract.
    """

    payload = json.loads(MAP_ROTATION_CONTRACT_PATH.read_text())
    if payload.get("schemaVersion") != 1:
        raise ValueError("map rotation contract must use schemaVersion 1")
    rungs = payload.get("competitionRungs")
    if not isinstance(rungs, list) or not rungs:
        raise ValueError("map rotation contract must declare competitionRungs")

    ladder: list[tuple[int, list[str]]] = []
    variants_by_id: dict[str, dict[str, Any]] = {}
    previous_seats = 0
    for rung in rungs:
        if not isinstance(rung, dict) or set(rung) != {"seats", "variants"}:
            raise ValueError("each map rotation rung must contain seats and variants")
        seats = rung["seats"]
        variants = rung["variants"]
        if not isinstance(seats, int) or seats <= previous_seats:
            raise ValueError("map rotation seat counts must be strictly increasing")
        if not isinstance(variants, list) or not variants:
            raise ValueError(f"map rotation rung {seats} must contain variants")
        previous_seats = seats
        ids: list[str] = []
        for variant in variants:
            expected_keys = {"id", *_VARIANT_CONFIG_FIELDS}
            if not isinstance(variant, dict) or set(variant) != expected_keys:
                raise ValueError(
                    f"map rotation rung {seats} contains a malformed variant"
                )
            variant_id = variant["id"]
            if (
                not isinstance(variant_id, str)
                or variant_id in variants_by_id
                or not variant_id.startswith(f"tournament-{seats}p-")
            ):
                raise ValueError(f"invalid map rotation variant id: {variant_id!r}")
            if not isinstance(variant["map"], str) or not variant["map"]:
                raise ValueError(f"invalid map for {variant_id}")
            variants_by_id[variant_id] = {"seats": seats, **variant}
            ids.append(variant_id)
        ladder.append((seats, ids))
    return ladder, variants_by_id


# Pool order is release authority: index 0 is the most battle-tested map, and
# round N deterministically selects index (N - 1) modulo pool length. The 12p
# and 16p rungs intentionally share the same conservative five-map comparison
# pool: Pangaea, Asia, Black Sea, East Asia, and Oceania. Europe and the large
# continental maps remain declared manual variants but quarantined from
# automatic scheduling for their recorded hosted artifact-deadline failures.
COMPETITION_LADDER, COMPETITION_VARIANTS = _load_map_rotation_contract()

# This is the source-side counterpart of the live league's
# settings.ladder.fulfillment.allowed_failures=0.05 contract. The platform does
# not include that setting in the commissioner RoundStart payload, so the
# package must pin the same rate itself to keep incomplete terminal rows from
# becoming ratings. A fractional episode is never allowed: at 25 requests this
# permits one failure, while six evidence-less completed rows quarantine the
# entire rated round.
PROXYWAR_RATED_ALLOWED_FAILURE_RATE = 0.05


def _score_bearing_episode_result(
    scheduled: CommissionerProtocolEpisodeRequest,
    result: CommissionerProtocolEpisodeResult,
) -> bool:
    """Return true only for an exact, finite score row per scheduled seat.

    `type=episode_result` is only a terminal transport label. It is not rating
    evidence by itself: Coworld has emitted completed requests with an empty
    `scores` list. Counter equality deliberately supports qualifier self-play,
    where the same policy may occupy more than one scheduled seat.
    """

    return (
        len(result.scores) == len(scheduled.policy_version_ids)
        and Counter(score.policy_version_id for score in result.scores)
        == Counter(scheduled.policy_version_ids)
        and all(isfinite(score.score) for score in result.scores)
    )


def _rated_round_integrity(
    scheduled_episodes: list[CommissionerProtocolEpisodeRequest],
    episode_results: list[CommissionerProtocolEpisodeResult],
    failed_episodes: list[CommissionerProtocolEpisodeFailed],
) -> tuple[list[CommissionerProtocolEpisodeResult], dict[str, object]]:
    """Classify terminal Competition evidence before any rating is emitted."""

    scheduled_by_id = {episode.request_id: episode for episode in scheduled_episodes}
    failed_ids = {episode.request_id for episode in failed_episodes}
    valid_results: list[CommissionerProtocolEpisodeResult] = []
    invalid_result_ids: set[str] = set()
    seen_result_ids: set[str] = set()
    for result in episode_results:
        scheduled = scheduled_by_id.get(result.request_id)
        if (
            scheduled is None
            or result.request_id in seen_result_ids
            or not _score_bearing_episode_result(scheduled, result)
        ):
            invalid_result_ids.add(result.request_id)
        else:
            valid_results.append(result)
        seen_result_ids.add(result.request_id)

    valid_results = [
        result
        for result in valid_results
        if result.request_id not in invalid_result_ids
        and result.request_id not in failed_ids
    ]

    missing_request_ids = set(scheduled_by_id) - seen_result_ids - failed_ids
    unknown_failure_ids = failed_ids - set(scheduled_by_id)
    effective_failure_ids = (
        (failed_ids & set(scheduled_by_id))
        | invalid_result_ids
        | missing_request_ids
        | unknown_failure_ids
    )
    expected_count = len(scheduled_episodes)
    allowed_failure_count = floor(
        expected_count * PROXYWAR_RATED_ALLOWED_FAILURE_RATE + 1e-12
    )
    return valid_results, {
        "status": (
            "quarantined"
            if len(effective_failure_ids) > allowed_failure_count
            else "score_bearing"
        ),
        "expected_episode_count": expected_count,
        "score_bearing_count": len(valid_results),
        "effective_failure_count": len(effective_failure_ids),
        "allowed_failure_count": allowed_failure_count,
        "allowed_failure_rate": PROXYWAR_RATED_ALLOWED_FAILURE_RATE,
        "failed_request_ids": sorted(effective_failure_ids),
        "invalid_result_request_ids": sorted(invalid_result_ids),
        "missing_request_ids": sorted(missing_request_ids),
    }


class ProxyWarCommissioner(RulesetStrategyCommissioner):
    """Stock ruleset_strategy commissioner, plus one override: Competition rounds route to a
    seat-count ladder instead of a single fixed variant, and rotate through each rung's
    map pool by round number.

    Everything else (Qualifiers' self-play crash check, scoring, seating, promotion) is pure
    YAML config (see configs/proxywar.yaml) -- this override exists only because the platform
    has no config knob for "pick the variant whose seat count best fits how many real policies
    are here right now" (confirmed against ruleset_strategy/entrants.py: DivisionMatch/
    EntrantSelector match on division name/type/membership status, never on entrant count).
    """

    def complete_round_for_round_start(
        self,
        round_start: CommissionerRoundStart,
        episode_results: list[CommissionerProtocolEpisodeResult],
        scheduled_episodes: list[CommissionerProtocolEpisodeRequest] | None = None,
        failed_episodes: list[CommissionerProtocolEpisodeFailed] | None = None,
    ) -> CommissionerRoundComplete:
        view = RoundStartView(round_start, self._config())
        # Qualifiers are not rated and need their normal failure observations to
        # drive promotion/disqualification. Competition is the rating boundary.
        if view.current_division.type != "competition":
            return super().complete_round_for_round_start(
                round_start,
                episode_results,
                scheduled_episodes,
                failed_episodes,
            )
        if not scheduled_episodes:
            integrity = {
                "status": "quarantined",
                "expected_episode_count": 0,
                "score_bearing_count": 0,
                "effective_failure_count": 1,
                "allowed_failure_count": 0,
                "allowed_failure_rate": PROXYWAR_RATED_ALLOWED_FAILURE_RATE,
                "failed_request_ids": [],
                "invalid_result_request_ids": [],
                "missing_request_ids": [],
                "reason": "scheduled episode evidence was absent",
            }
            valid_results: list[CommissionerProtocolEpisodeResult] = []
        else:
            valid_results, integrity = _rated_round_integrity(
                scheduled_episodes,
                episode_results,
                failed_episodes or [],
            )
        if integrity["status"] == "quarantined":
            # An empty result list is the platform-compatible quarantine: the
            # terminal round is recorded, but no entrant receives a rating row
            # and no membership transition is fabricated from incomplete play.
            return CommissionerRoundComplete(
                results=[],
                policy_membership_events=[],
                membership_changes=[],
                round_display={"integrity": integrity},
                observability=CommissionerRoundReport(
                    rule_id="proxywar_rated_round_integrity_quarantine",
                    rule_description=(
                        "No rating was emitted because terminal score-bearing "
                        "episode failures exceeded the configured tolerance."
                    ),
                    division_id=view.current_division.id,
                    entrants=[],
                    notes=[
                        f"Quarantined {integrity['effective_failure_count']} effective "
                        f"failure(s); allowed {integrity['allowed_failure_count']}."
                    ],
                    extra=integrity,
                ),
            )
        complete = super().complete_round_for_round_start(
            round_start,
            valid_results,
            scheduled_episodes,
            failed_episodes,
        )
        if complete.round_display is None:
            complete.round_display = {}
        complete.round_display["integrity"] = integrity
        return complete

    def schedule_episodes_for_round_start(
        self, round_start: CommissionerRoundStart
    ) -> CommissionerScheduleEpisodes:
        config = self._config()
        view = RoundStartView(round_start, config)
        round_number = getattr(round_start, "round_number", 0) or 0

        if view.current_division.type != "competition":
            # Qualifiers (and anything else) keep the stock path: a division-declared
            # game_config.num_agents (the "qualifier" variant, always variants[0]) resolves
            # normally through view.variant().
            return self._with_episode_index(
                super().schedule_episodes_for_round_start(round_start),
                max(round_number, 1) - 1,
            )

        rule = select_rule(config, view.current_division, view.memberships)
        entries = view.entries(rule)
        variant_id, num_agents, variant_round_occurrence_index = self._fit_ladder_rung(
            len(entries), round_start.variants, round_number
        )
        pool = view.pool(rule)
        pool_config = dict(pool.config)
        # rolling_window advances by one entrant per episode.  The shared
        # ceil(entries / seats) minimum assumes disjoint windows, so it can
        # leave a suffix of the field unscheduled when entries > seats.  Keep
        # the configured episode floor, but add enough one-seat offsets for
        # the final entrant to appear.
        pool_config["num_episodes"] = max(
            int(pool_config.get("num_episodes", 1)),
            len(entries) - num_agents + 1,
        )
        pool = pool.model_copy(update={"config": pool_config})

        return self._with_episode_index(
            schedule_entries(
                pool=pool,
                primary_entries=entries,
                filler_entries=view.filler_entries(entries),
                num_agents=num_agents,
                variant_id=variant_id,
                game_config=None,
                config=config,
                recent_results=round_start.recent_results,
            ),
            variant_round_occurrence_index,
        )

    @staticmethod
    def _with_episode_index(
        schedule: CommissionerScheduleEpisodes, variant_round_occurrence_index: int
    ) -> CommissionerScheduleEpisodes:
        """Stamp consecutive same-variant spawn-priority occurrence indices.

        Spawn priority is computed from sorted unique usernames, not seat
        position, so every scheduled episode can advance the report-independent
        rotation without aliasing against shuffled-window seating. For a fixed
        roster and map, same-variant round occurrence `k` begins at
        `k * episode_count`; the episodes in that round then receive the next
        consecutive indices. Repeated comparable rounds therefore continue one
        deterministic priority cycle instead of resetting or holding one
        priority order for the entire round.

        `episodeIndex` remains the additive game-config wire field consumed by
        AgentLeagueMatch. The request's bounded seed is copied unchanged so the
        adapter applies and reports the same deterministic episode identity.
        """
        episode_count = len(schedule.episodes)
        if episode_count == 0:
            return schedule
        first_episode_index = variant_round_occurrence_index * episode_count
        return schedule.model_copy(
            update={
                "episodes": [
                    episode.model_copy(
                        update={
                            "game_config_overrides": {
                                **episode.game_config_overrides,
                                "episodeIndex": first_episode_index + position,
                                "seed": episode.seed,
                            }
                        }
                    )
                    for position, episode in enumerate(schedule.episodes)
                ]
            }
        )

    def _fit_ladder_rung(
        self,
        champion_count: int,
        available_variants: list[Any],
        round_number: int,
    ) -> tuple[str, int, int]:
        variants_by_id = {variant.id: variant for variant in available_variants}
        if len(variants_by_id) != len(available_variants):
            raise ValueError("round start contains duplicate variant ids")

        ladder: list[tuple[int, list[str]]] = []
        for seats, pool in COMPETITION_LADDER:
            present = [
                variant_id for variant_id in pool if variant_id in variants_by_id
            ]
            if not present:
                # Whole-rung absence is supported for package/commissioner
                # rollout compatibility. A partly declared rung is not: it
                # silently changes modulo rotation and comparison coverage.
                continue
            if present != pool:
                missing = [
                    variant_id
                    for variant_id in pool
                    if variant_id not in variants_by_id
                ]
                raise ValueError(
                    f"competition rung {seats} is incomplete; missing {missing}"
                )
            for variant_id in pool:
                expected = COMPETITION_VARIANTS[variant_id]
                game_config = variants_by_id[variant_id].game_config
                if game_config.get("num_agents") != seats:
                    raise ValueError(
                        f"{variant_id} num_agents does not match {seats}-seat rung"
                    )
                for contract_field, game_config_field in _VARIANT_CONFIG_FIELDS.items():
                    if game_config.get(game_config_field) != expected[contract_field]:
                        raise ValueError(
                            f"{variant_id} {game_config_field} does not match "
                            "the release map contract"
                        )
            ladder.append((seats, pool))
        if not ladder:
            raise ValueError(
                "none of the configured competition ladder variants "
                f"({[v for _, pool in COMPETITION_LADDER for v in pool]}) "
                "are declared in this manifest"
            )
        # The largest rung the real champion count fills -- schedule_entries' shuffled_window
        # seating then windows that field across multiple episodes if it exceeds the rung, so
        # every real champion still plays even at the smallest declared rung.
        fitting = [rung for rung in ladder if rung[0] <= champion_count]
        seats, pool = fitting[-1] if fitting else ladder[0]
        # Rotate the rung's map pool by round number: deterministic, stateless, and a
        # season sweeps every declared map. Anchored so round 1 (and the certifier's
        # round_number-less probe) lands on pool[0] -- the battle-tested Pangaea config.
        zero_based_round = max(round_number, 1) - 1
        return (
            pool[zero_based_round % len(pool)],
            seats,
            zero_based_round // len(pool),
        )


register_commissioner("proxywar_scaling", ProxyWarCommissioner)

app = commissioner_app("proxywar_scaling")


def main() -> None:
    run(app)


if __name__ == "__main__":
    main()
