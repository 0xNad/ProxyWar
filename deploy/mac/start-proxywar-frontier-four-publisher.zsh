#!/bin/zsh
set -euo pipefail

# The Frontier Four publisher: one run turns the scheduler's games file into
# /world (world.json, the match rows and the world-source marker in the league
# site directory), then exits. com.proxywar.frontier-four-publisher.plist runs
# it every minute; it does nothing while the games file is unchanged.
#
# It is a job of its own, with zsh as the program and the granted node binary
# doing the work (the shape of the league mirror), because the scheduler's
# Python must never touch a volume. See docs/PROXYWAR_FRONTIER_FOUR.md.

PROJECT_DIR="${PROXYWAR_PROJECT_DIR:-$HOME/Documents/ProxyWar}"
ARTIFACTS_ROOT="${PROXYWAR_ARTIFACTS_ROOT:-/Volumes/Crucial X9/ProxyWar/live-artifacts}"
SITE_DIR="${PROXYWAR_FRONTIER_FOUR_SITE_DIR:-$ARTIFACTS_ROOT/ai-league-runs/league}"
STATE_HOME="${PROXYWAR_FRONTIER_FOUR_HOME:-$HOME/Library/Application Support/ProxyWar/frontier-four}"
GAMES="$STATE_HOME/games.jsonl"
PUBLISHED="$STATE_HOME/games.published.jsonl"
LOG="$HOME/Library/Logs/proxywar-frontier-four-publisher.log"

[[ -f "$GAMES" ]] || exit 0
if [[ -f "$PUBLISHED" ]] && cmp -s "$GAMES" "$PUBLISHED"; then
  exit 0
fi
if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "ProxyWar project directory not found: $PROJECT_DIR" >&2
  exit 64
fi
if [[ -f "$LOG" && $(stat -f %z "$LOG") -gt 1048576 ]]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# A game appended while the publish runs leaves the games file different from
# what was published, so the next run publishes again.
before="$(shasum -a 256 "$GAMES" | cut -d' ' -f1)"
cd "$PROJECT_DIR"
if node --import tsx/esm src/scripts/frontier-four-publish.ts --site-dir "$SITE_DIR" --games "$GAMES" >> "$LOG" 2>&1; then
  after="$(shasum -a 256 "$GAMES" | cut -d' ' -f1)"
  if [[ "$before" == "$after" ]]; then
    cp "$GAMES" "$PUBLISHED"
  fi
  echo "[frontier-four-publisher $(date -u +%FT%TZ)] published $(wc -l < "$GAMES" | tr -d ' ') games to $SITE_DIR" >> "$LOG"
else
  rc=$?
  echo "[frontier-four-publisher $(date -u +%FT%TZ)] publish failed with exit $rc" >> "$LOG"
  exit $rc
fi
