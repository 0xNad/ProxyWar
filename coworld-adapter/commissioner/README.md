# ProxyWar commissioner

Standalone ProxyWar tournament commissioner: the `ruleset_strategy` framework (vendored from
`Metta-AI/coworld-tools` `commissioners/`) plus two custom pieces in `ProxyWarCommissioner`,
`proxywar_app.py`.

Everything except those two pieces is plain config (`commissioners/ruleset_strategy_commissioner/configs/proxywar.yaml`):
Qualifiers is a self-play crash check that promotes on any completed episode; Competition scores by
per-episode win rate aggregated into a player-level current-form EWMA. The leaderboard uses a
24-completed-round half-life, displays `100 x EWMA`, and lists players with fewer than five valid
scored rounds after established players as provisional. Form history follows the player across
policy-version upgrades.

The first custom piece, `ProxyWarCommissioner.schedule_episodes_for_round_start`'s ladder routing:
counts the real distinct champions currently in the league and routes each round to the largest
declared seat-count rung (2p / 4p / 8p / 12p) that fits them, so the league runs today with as few
as 2 committed policies and scales up automatically as more join -- no re-publish required. This
isn't a stock `ruleset_strategy` knob: division/entrant matching in the framework only keys off
division name/type and membership status/substatus, never off how many entrants are currently
present.

A second custom piece: every episode `ProxyWarCommissioner` schedules (both the Competition
ladder path and the stock qualifier path it delegates to `super()` for) is stamped with a
deterministic `episodeIndex` in `game_config_overrides` before it is returned - a zero-based,
round-aware, round-number-derived ordinal (never a hash, never random, never the simulation
`seed`) that rotates which fairness-assigned spawn slot a roster lands on across repeated
same-map/same-roster episodes (`AgentSpawnAssignment.ts` on the ProxyWar side). `episodeIndex`
is declared in every shipped manifest's `game.config_schema` as an optional non-negative
integer defaulting to 0. See `ProxyWarCommissioner._with_episode_index` in `proxywar_app.py`
for the exact formula and its documented same-width-round assumption, and `EpisodeRequest.
game_config_overrides` in `commissioners/common/protocol.py` for the upstream
(`Metta-AI/coworld` `commissioner/protocol.py`) wire field this is additive against.

Built and bundled by `coworld build` as this coworld's `commissioner` runnable (see
`../coworld_compose.yaml`), so the league doesn't depend on a centrally-published commissioner
image.
