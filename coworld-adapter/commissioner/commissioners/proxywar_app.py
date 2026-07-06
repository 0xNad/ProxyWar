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
COMPETITION_LADDER: list[tuple[str, int]] = [
    ("tournament-2p", 2),
    ("tournament-4p", 4),
    ("tournament-8p", 8),
    ("tournament-12p", 12),
]


class ProxyWarCommissioner(RulesetStrategyCommissioner):
    """Stock ruleset_strategy commissioner, plus one override: Competition rounds route to a
    seat-count ladder instead of a single fixed variant.

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

        if view.current_division.type != "competition":
            # Qualifiers (and anything else) keep the stock path: a division-declared
            # game_config.num_agents (the "qualifier" variant, always variants[0]) resolves
            # normally through view.variant().
            return super().schedule_episodes_for_round_start(round_start)

        rule = select_rule(config, view.current_division, view.memberships)
        entries = view.entries(rule)
        available_variant_ids = {variant.id for variant in round_start.variants}
        variant_id, num_agents = self._fit_ladder_rung(len(entries), available_variant_ids)

        return schedule_entries(
            pool=view.pool(rule),
            primary_entries=entries,
            filler_entries=view.filler_entries(entries),
            num_agents=num_agents,
            variant_id=variant_id,
            game_config=None,
            config=config,
            recent_results=round_start.recent_results,
        )

    def _fit_ladder_rung(self, champion_count: int, available_variant_ids: set[str]) -> tuple[str, int]:
        ladder = [rung for rung in COMPETITION_LADDER if rung[0] in available_variant_ids]
        if not ladder:
            raise ValueError(
                "none of the configured competition ladder variants "
                f"({[v for v, _ in COMPETITION_LADDER]}) are declared in this manifest"
            )
        # The largest rung the real champion count fills -- schedule_entries' rolling_window
        # seating then windows that field across multiple episodes if it exceeds the rung, so
        # every real champion still plays even at the smallest declared rung.
        fitting = [rung for rung in ladder if rung[1] <= champion_count]
        return fitting[-1] if fitting else ladder[0]


register_commissioner("proxywar_scaling", ProxyWarCommissioner)

app = commissioner_app("proxywar_scaling")


def main() -> None:
    run(app)


if __name__ == "__main__":
    main()
