from __future__ import annotations

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
            "tournament-12p-world",
            "tournament-12p-asia",
            "tournament-12p-britannia",
            "tournament-12p-blacksea",
            "tournament-12p-eastasia",
            "tournament-12p-northamerica",
            "tournament-12p-oceania",
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
                super().schedule_episodes_for_round_start(round_start), round_number
            )

        rule = select_rule(config, view.current_division, view.memberships)
        entries = view.entries(rule)
        available_variant_ids = {variant.id for variant in round_start.variants}
        variant_id, num_agents = self._fit_ladder_rung(
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
            round_number,
        )

    @staticmethod
    def _with_episode_index(
        schedule: CommissionerScheduleEpisodes, round_number: int
    ) -> CommissionerScheduleEpisodes:
        """Stamps a stable, zero-based, round-aware `episodeIndex` onto every
        scheduled episode's `game_config_overrides`
        (`AgentLeagueMatchOptions.episodeIndex` on the ProxyWar side - rotates
        which fairness-assigned spawn slot a roster lands on across repeated
        same-map/same-roster episodes; see `AgentSpawnAssignment.ts`).

        Deterministic and stateless (no persisted counter, no hash/random,
        never touches `seed`): `base` is this round's zero-based ordinal
        (round_number 1 -> base 0, the same anchoring `_fit_ladder_rung`
        already uses for its own pool rotation) times THIS round's own
        episode count, so episode `i` within the round gets `base + i` -
        consecutive integers, which for any `N` in-round episodes form a
        complete residue system mod `N`. Round over round this strictly
        advances (never resets to 0) as `round_number` increases, so a
        roster that keeps landing at the same episode position across
        comparable rounds still keeps rotating through every fairness slot
        instead of replaying slot 0 forever.

        Assumption (documented, not enforced here): the modular alignment
        with a specific prior round's rotation is only guaranteed while
        comparable rounds (same map/roster) keep the SAME per-round episode
        count. A ladder/pool change that alters the count between rounds
        still never repeats an exact (base, position) pair - so it can
        never silently replay history - it just starts a new local residue
        cycle at the new width.
        """
        episode_count = len(schedule.episodes)
        if episode_count == 0:
            return schedule
        base = (max(round_number, 1) - 1) * episode_count
        return schedule.model_copy(
            update={
                "episodes": [
                    episode.model_copy(
                        update={
                            "game_config_overrides": {
                                **episode.game_config_overrides,
                                "episodeIndex": base + position,
                            }
                        }
                    )
                    for position, episode in enumerate(schedule.episodes)
                ]
            }
        )

    def _fit_ladder_rung(
        self, champion_count: int, available_variant_ids: set[str], round_number: int
    ) -> tuple[str, int]:
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
        # The largest rung the real champion count fills -- schedule_entries' rolling_window
        # seating then windows that field across multiple episodes if it exceeds the rung, so
        # every real champion still plays even at the smallest declared rung.
        fitting = [rung for rung in ladder if rung[0] <= champion_count]
        seats, pool = fitting[-1] if fitting else ladder[0]
        # Rotate the rung's map pool by round number: deterministic, stateless, and a
        # season sweeps every declared map. Anchored so round 1 (and the certifier's
        # round_number-less probe) lands on pool[0] -- the battle-tested Pangaea config.
        return pool[(max(round_number, 1) - 1) % len(pool)], seats


register_commissioner("proxywar_scaling", ProxyWarCommissioner)

app = commissioner_app("proxywar_scaling")


def main() -> None:
    run(app)


if __name__ == "__main__":
    main()
