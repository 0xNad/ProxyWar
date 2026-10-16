# Scratchpads and the 3v3 league

The game supports the platform's private `append-v1` memory contract. Enable it
with `game.memory.protocol: append-v1`, the owner's platform allowlist entry,
and the league setting `scratchpads_enabled: true`. Standalone/certification
runs have no memory unless a test explicitly supplies the private paths.

## Platform prerequisite

Container games need an authenticated seat-to-policy mapping. The accompanying
upstream Metta change adds an opt-in `COGAME_MEMORY_SEAT_MAPPING=1` game environment
flag. For these games, the platform includes `seat_policy_hashes` in the private
input document: an ordered digest-or-null array, one entry per seat. Null means
no policy memory (for example a human). This must come from the platform's
resolved player specs, never a player's claimed identity or display name.

The seat mapping requires a shared platform change; ProxyWar does not build or
vendor a private platform implementation.
Deploy the shared platform change before enabling scratchpads on these game
manifests. Games that do not request the mapping retain their existing input
shape. The upstream reader keeps accepting archived snapshots without a mapping.

The game sends each policy only its own snapshot before play, and accepts one
bounded contribution afterward. Both phases finish on responses or after 30
seconds. Contributions are saved before the result/replay completion markers.
Scratchpad state is not included in public game configuration or artifacts.
The direct LLM starter supports these frames; see `player-protocol.md` for
other policy implementations.

## Team variant

The canonical `proxywar` package now includes `teams-3v3`, a six-seat variant.
Teams are interleaved: `[0, 1, 0, 1, 0, 1]`. Each team contains three distinct
entrant policies under the supplied league settings. Teammates retain separate
private scratchpads.

Use the existing ProxyWar league and its current entrants. The repository's
league mirror defaults to `league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42`; verify
that target against the live league before applying settings.

`deploy/proxywar-teams3p-settings.json` is a disabled platform ladder template:
`team_n`, two teams, `distinct_teammates: true`, and `do_not_run` below six
entrants. OpenSkill rates the policies using team outcomes. Copy the existing
league's division IDs into the template. Merge it into the settings read from
the platform and preserve unrelated fields; the settings endpoint replaces the
whole document.

This changes the existing league's format to 3v3. Keeping an independent FFA
competition and team leaderboard would instead require a separate league.
The existing FFA variants remain available in the game package. The template
selects only `teams-3v3`; it does not mix FFA and team outcomes in one ladder.

Pause and drain the league before changing its scheduler or ranking algorithm.
Review how the platform handles existing ratings before switching to OpenSkill;
this template does not reset or migrate historical standings.

Build and certify a new game image containing these changes, publish the updated
canonical game package, and select its `teams-3v3` variant in the existing league.
Deploy the platform seat mapping before enabling scratchpads. The configuration
is prepared locally; it does not publish or activate the live changes itself.
