# ProxyWar commissioner

Standalone ProxyWar tournament commissioner: the `ruleset_strategy` framework (vendored from
`Metta-AI/coworld-tools` `commissioners/`) plus one custom override, `ProxyWarCommissioner` in
`proxywar_app.py`.

Everything except one thing is plain config (`commissioners/ruleset_strategy_commissioner/configs/proxywar.yaml`):
Qualifiers is a self-play crash check that promotes on any completed episode; Competition scores by
per-episode win rate aggregated into an OpenSkill (MMR) rating.

The one custom piece: Competition rounds don't run a single fixed variant. `ProxyWarCommissioner`
counts the real distinct champions currently in the league and routes each round to the largest
declared seat-count rung (2p / 4p / 8p / 12p) that fits them, so the league runs today with as few
as 2 committed policies and scales up automatically as more join -- no re-publish required. This
isn't a stock `ruleset_strategy` knob: division/entrant matching in the framework only keys off
division name/type and membership status/substatus, never off how many entrants are currently
present.

Built and bundled by `coworld build` as this coworld's `commissioner` runnable (see
`../coworld_compose.yaml`), so the league doesn't depend on a centrally-published commissioner
image.
