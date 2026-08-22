from __future__ import annotations

from uuid import UUID

from commissioners.common.app import commissioner_app, run
from commissioners.common.commissioners import register_commissioner
from commissioners.common.protocol import RoundStart as CommissionerRoundStart
from commissioners.common.protocol import ScheduleEpisodes as CommissionerScheduleEpisodes
from commissioners.common.ruleset_strategy.commissioner import RulesetStrategyCommissioner
from commissioners.common.ruleset_strategy.entrants import select_rule
from commissioners.common.ruleset_strategy.round_start import RoundStartView
from commissioners.common.ruleset_strategy.scheduling import schedule_entries

# Declared once here and in the manifest's variants[] -- each id must exist there, and each
# entry's game_config.num_agents must equal the seat count declared for it below.
# Each rung declares a MAP POOL (variant ids differing only by map); rounds rotate
# through the pool by round_number so a season sweeps every map deterministically.
# Pool order matters: index 0 is the most battle-tested map (Pangaea) so round 1 of
# any fresh league lands on proven config.
COMPETITION_LADDER: list[tuple[int, list[str]]] = [
    (2, ["tournament-2p-pangaea", "tournament-2p-asia"]),
    (4, ["tournament-4p-pangaea", "tournament-4p-asia", "tournament-4p-europe"]),
    (8, ["tournament-8p-pangaea", "tournament-8p-world", "tournament-8p-asia"]),
    (
        12,
        [
            # Battle-tested first (fresh-league round 1 lands on index 0); the
            # 2026-08-02 additions are ordered by hosted confidence and were
            # each qualified through the memory-regression gate (80-step native
            # 12P episode under the hosted heap posture) before shipping.
            "tournament-12p-pangaea",
            "tournament-12p-asia",
            "tournament-12p-blacksea",
            "tournament-12p-eastasia",
            "tournament-12p-oceania",
            # tournament-12p-europe remains a declared manual variant, but is
            # quarantined from automatic Competition scheduling. The missing
            # pre-promotion wall-clock gate recurred in live rounds 1323 and
            # 1332: 10 Europe episodes timed out before results/replay across
            # 0.1.24 and 0.1.26. Re-add only after a full hosted deadline proof.
            #
            # tournament-12p-{world,britannia,northamerica} are likewise
            # declared manual variants quarantined 2026-08-11 (operator-
            # directed) for round wall-time: engine cost per 100-turn decision
            # cycle scales with land tiles, so these continental maps run
            # multi-hour rounds (12P NorthAmerica rounds hit 171-324 min).
            # Re-add per map after engine work plus a full-length hosted probe
            # on that map lands well inside the 100-min artifact deadline.
        ],
    ),
    (
        16,
        [
            # Added 2026-08-10 for whole-company league events
            # (operator-directed, requested by the platform team): denser games
            # and fewer episodes per round at 16+ entrants. Pool widened to the
            # proven 12P rotation on 2026-08-11 (operator-directed) after
            # per-map 16-seat boot proofs plus full-length 16-seat games on
            # Pangaea and World bracketing the map-size spectrum. Europe stays
            # excluded while its 12P hosted-deadline quarantine stands.
            # Reverting the league to 12-seat rounds is a commissioner-only
            # patch that removes this entry; individual maps can be pulled from
            # this pool the same way.
            "tournament-16p-pangaea",
            "tournament-16p-asia",
            "tournament-16p-blacksea",
            "tournament-16p-eastasia",
            "tournament-16p-oceania",
            # tournament-16p-{world,britannia,northamerica} remain declared
            # manual variants but are quarantined 2026-08-11 (operator-
            # directed) for round wall-time. Engine cost per 100-turn decision
            # cycle scales with land tiles (~15s/cycle on NorthAmerica's 1.24M
            # land tiles vs ~5s on Oceania's 195k), so these maps ran 62/45/40
            # min average episodes and 126-187 min rounds vs 36-52 min on the
            # compact maps; NorthAmerica also produced the rung's only
            # episode_timeout kills (100 min burned, no scores). Re-add per
            # map after engine work plus a full-length hosted 16-seat probe on
            # that map lands well inside the 100-min artifact deadline.
        ],
    ),
]


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
                rated_play=False,
            )

        rule = select_rule(config, view.current_division, view.memberships)
        entries = view.entries(rule)
        available_variant_ids = {variant.id for variant in round_start.variants}
        variant_id, num_agents, variant_round_occurrence_index = self._fit_ladder_rung(
            len(entries), available_variant_ids, round_number
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
            player_id_by_policy={
                membership.policy_version_id: membership.player_id
                for membership in round_start.memberships
            },
            rated_play=True,
        )

    @staticmethod
    def _with_episode_index(
        schedule: CommissionerScheduleEpisodes,
        variant_round_occurrence_index: int,
        *,
        player_id_by_policy: dict[UUID, str | None] | None = None,
        rated_play: bool | None = None,
    ) -> CommissionerScheduleEpisodes:
        """Stamp consecutive same-variant spawn-priority occurrence indices.

        Spawn priority is computed from sorted immutable player identities, not
        display names or seat position, so every scheduled episode can advance the
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
        stamped_episodes = []
        for position, episode in enumerate(schedule.episodes):
            overrides = {
                **episode.game_config_overrides,
                "episodeIndex": first_episode_index + position,
                "seed": episode.seed,
            }
            if rated_play is not None:
                overrides["rated_play"] = rated_play
            if rated_play:
                if player_id_by_policy is None:
                    raise ValueError(
                        "rated ProxyWar scheduling requires immutable player ids"
                    )
                player_ids = [
                    player_id_by_policy.get(policy_version_id)
                    for policy_version_id in episode.policy_version_ids
                ]
                if any(
                    not isinstance(player_id, str) or not player_id
                    for player_id in player_ids
                ):
                    raise ValueError(
                        "rated ProxyWar scheduling requires one immutable player id per policy"
                    )
                if len(player_ids) != len(set(player_ids)):
                    raise ValueError(
                        "rated ProxyWar scheduling requires unique player ids per episode"
                    )
                overrides["player_ids"] = player_ids
            stamped_episodes.append(
                episode.model_copy(update={"game_config_overrides": overrides})
            )
        return schedule.model_copy(update={"episodes": stamped_episodes})

    def _fit_ladder_rung(
        self, champion_count: int, available_variant_ids: set[str], round_number: int
    ) -> tuple[str, int, int]:
        ladder = [
            (seats, pool)
            for seats, variant_pool in COMPETITION_LADDER
            if (pool := [v for v in variant_pool if v in available_variant_ids])
        ]
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
