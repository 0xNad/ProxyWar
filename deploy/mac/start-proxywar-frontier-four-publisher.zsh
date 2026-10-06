#!/bin/zsh
set -euo pipefail

# The Frontier publisher: one run turns the scheduler's games file into
# /world (world.json, frontier-form.json, the match rows and the world-source
# marker in the league site directory), then exits.
# com.proxywar.frontier-four-publisher.plist runs it every minute; it does
# nothing while its inputs and the UTC hour are unchanged. The hour is an
# input because world.json says when the next battle is.
#
# Season 2 (the default) publishes the free-for-all games file, with Season
# 1's file for the recap and its old match links, and reads (never writes)
# the Season 2 scheduler's config and state for the battle times and any
# credits hold. PROXYWAR_FRONTIER_SEASON=1 publishes the Season 1 world from
# games.jsonl as before.
#
# It is a job of its own, with zsh as the program and the granted node binary
# doing the work (the shape of the league mirror), because the scheduler's
# Python must never touch a volume. See docs/PROXYWAR_FRONTIER_FOUR.md.

PROJECT_DIR="${PROXYWAR_PROJECT_DIR:-$HOME/Documents/ProxyWar}"
ARTIFACTS_ROOT="${PROXYWAR_ARTIFACTS_ROOT:-/Volumes/Crucial X9/ProxyWar/live-artifacts}"
SITE_DIR="${PROXYWAR_FRONTIER_FOUR_SITE_DIR:-$ARTIFACTS_ROOT/ai-league-runs/league}"
STATE_HOME="${PROXYWAR_FRONTIER_FOUR_HOME:-$HOME/Library/Application Support/ProxyWar/frontier-four}"
FFA_HOME="${PROXYWAR_FRONTIER_FFA_HOME:-$HOME/Library/Application Support/ProxyWar/frontier-ffa}"
SEASON="${PROXYWAR_FRONTIER_SEASON:-2}"
SEASON_ONE_GAMES="${PROXYWAR_FRONTIER_SEASON_ONE_GAMES:-$STATE_HOME/games.jsonl}"
FFA_GAMES="${PROXYWAR_FRONTIER_FFA_GAMES:-$FFA_HOME/frontier-ffa-games.jsonl}"
FFA_CONFIG="${PROXYWAR_FRONTIER_FFA_CONFIG:-$FFA_HOME/frontier-ffa.json}"
FFA_STATE="$FFA_HOME/state.json"
STAMP="$STATE_HOME/frontier-world.published"
LOG="$HOME/Library/Logs/proxywar-frontier-four-publisher.log"

if [[ "$SEASON" == "1" ]]; then
  GAMES="$SEASON_ONE_GAMES"
  [[ -f "$GAMES" ]] || exit 0
  PUBLISH_ARGS=(--site-dir "$SITE_DIR" --games "$GAMES")
else
  GAMES="$FFA_GAMES"
  PUBLISH_ARGS=(--site-dir "$SITE_DIR" --ffa-games "$GAMES")
  if [[ -f "$SEASON_ONE_GAMES" ]]; then
    PUBLISH_ARGS+=(--season1-games "$SEASON_ONE_GAMES")
  fi
  if [[ -f "$FFA_CONFIG" ]]; then
    PUBLISH_ARGS+=(--scheduler-config "$FFA_CONFIG")
  fi
  if [[ -f "$FFA_STATE" ]]; then
    PUBLISH_ARGS+=(--scheduler-state "$FFA_STATE")
  fi
  if [[ -n "${PROXYWAR_FRONTIER_BATTLE_TIMES:-}" ]]; then
    PUBLISH_ARGS+=(--battle-times "$PROXYWAR_FRONTIER_BATTLE_TIMES")
  fi
  # "none" while battles are paused by hand; unset works it out, credits
  # holds included.
  if [[ -n "${PROXYWAR_FRONTIER_NEXT_BATTLE_AT:-}" ]]; then
    PUBLISH_ARGS+=(--next-battle-at "$PROXYWAR_FRONTIER_NEXT_BATTLE_AT")
  fi
  if [[ -n "${PROXYWAR_FRONTIER_ROSTER:-}" ]]; then
    PUBLISH_ARGS+=(--roster "$PROXYWAR_FRONTIER_ROSTER")
  fi
fi

# What a publish would be made from. A game appended while the publish runs
# changes it, so the next run publishes again. The scheduler's state changes
# every minute, so a credits hold shows on the next hourly publish.
fingerprint() {
  {
    print -r -- "season $SEASON ${PUBLISH_ARGS[*]}"
    if [[ -f "$GAMES" ]]; then shasum -a 256 "$GAMES" | cut -d' ' -f1; fi
    if [[ -f "$SEASON_ONE_GAMES" ]]; then shasum -a 256 "$SEASON_ONE_GAMES" | cut -d' ' -f1; fi
    if [[ "$SEASON" != "1" && -f "$FFA_CONFIG" ]]; then shasum -a 256 "$FFA_CONFIG" | cut -d' ' -f1; fi
    if [[ -n "${PROXYWAR_FRONTIER_ROSTER:-}" && -f "$PROXYWAR_FRONTIER_ROSTER" ]]; then shasum -a 256 "$PROXYWAR_FRONTIER_ROSTER" | cut -d' ' -f1; fi
    date -u +%Y-%m-%dT%H
  } | shasum -a 256 | cut -d' ' -f1
}

before="$(fingerprint)"
if [[ -f "$STAMP" && "$(< "$STAMP")" == "$before" ]]; then
  exit 0
fi
mkdir -p "$STATE_HOME"
if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "ProxyWar project directory not found: $PROJECT_DIR" >&2
  exit 64
fi
if [[ -f "$LOG" && $(stat -f %z "$LOG") -gt 1048576 ]]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

cd "$PROJECT_DIR"
if node --import tsx/esm src/scripts/frontier-four-publish.ts "${PUBLISH_ARGS[@]}" >> "$LOG" 2>&1; then
  after="$(fingerprint)"
  if [[ "$before" == "$after" ]]; then
    print -r -- "$after" > "$STAMP"
  fi
  games=0
  if [[ -f "$GAMES" ]]; then games="$(wc -l < "$GAMES" | tr -d ' ')"; fi
  echo "[frontier-four-publisher $(date -u +%FT%TZ)] published season $SEASON ($games games) to $SITE_DIR" >> "$LOG"
else
  rc=$?
  echo "[frontier-four-publisher $(date -u +%FT%TZ)] publish failed with exit $rc" >> "$LOG"
  exit $rc
fi
