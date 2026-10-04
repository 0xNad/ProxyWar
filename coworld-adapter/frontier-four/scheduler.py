"""The Frontier Four scheduler: an endless competition between four teams.

Each cycle fights every front once as a hosted team game on the Frontier Four
coworld (4 teams of 3; each team's three seats run one policy pinned to one
frontier model). Completed games are appended to a games file that
`src/scripts/frontier-four-publish.ts` turns into `/world`.

Spend is held to the configured caps: a per-game LLM cap on every request,
a daily cap on what this loop spends, and a floor on the coworld's remaining
daily funds so the league's own rounds keep running. The loop refuses to
launch when either is crossed and resumes on the next day.

Usage:
    uvx --from coworld python scheduler.py --config frontier-four.json [--once] [--dry-run]

State lives next to the config: `<state_dir>/state.json` (cycle counter,
in-flight requests, daily spend) and `<state_dir>/requests/` (one JSON per
request, for resumption and audit).
"""

from __future__ import annotations

import argparse
import ast
import datetime as dt
import json
import random
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

from coworld.api_client import CoworldApiClient

SERVER = "https://softmax.com/api"
TERMINAL = {"completed", "failed", "cancelled"}


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    temp = path.with_suffix(path.suffix + ".part")
    temp.write_text(json.dumps(data, indent=2) + "\n")
    temp.replace(path)


def decode_policy_log(payload: bytes) -> str:
    """The policy-log endpoint returns the pod's log as a Python bytes literal
    (``b'...\\n...'``); turn it back into text with real newlines."""
    text = payload.decode("utf-8", "replace")
    if text.startswith(("b'", 'b"')):
        try:
            literal = ast.literal_eval(text)
            if isinstance(literal, bytes):
                return literal.decode("utf-8", "replace")
        except (ValueError, SyntaxError):
            return text.replace("\\n", "\n")
    return text


def log(event: str, **fields) -> None:
    print(json.dumps({"at": iso(utcnow()), "event": event, **fields}), flush=True)


class Scheduler:
    def __init__(self, config: dict, state_dir: Path, dry_run: bool):
        self.config = config
        self.state_dir = state_dir
        self.requests_dir = state_dir / "requests"
        self.requests_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = state_dir / "state.json"
        self.state = load_json(
            self.state_path,
            {"cycle": 0, "cursor": 0, "inflight": [], "spend": {}, "games": 0},
        )
        self.dry_run = dry_run
        self.client = CoworldApiClient.from_login(server_url=SERVER)
        self.teams = config["teams"]
        self.fronts = config["fronts"]
        self.layout = config["seat_teams"]

    # ---------------------------------------------------------------- budget
    def today(self) -> str:
        return utcnow().strftime("%Y-%m-%d")

    def spent_today(self) -> float:
        return float(self.state["spend"].get(self.today(), 0.0))

    def budget(self) -> dict | None:
        try:
            return self.client._get(f"/v2/coworlds/{self.config['budget_coworld_name']}/budget", dict)
        except Exception as error:  # noqa: BLE001 - a budget read failing must not crash the loop
            log("budget_read_failed", error=str(error)[:200])
            return None

    def may_launch(self) -> tuple[bool, str]:
        caps = self.config["caps"]
        if self.spent_today() >= caps["daily_usd"]:
            return False, f"daily cap {caps['daily_usd']} reached ({self.spent_today():.2f})"
        budget = self.budget()
        if budget is None:
            return False, "budget unreadable"
        remaining = float(budget.get("remaining_usd") or 0)
        if remaining < caps["min_remaining_usd"]:
            return False, f"coworld remaining {remaining:.2f} below floor {caps['min_remaining_usd']}"
        if budget.get("budget_status") not in (None, "ok"):
            return False, f"budget status {budget.get('budget_status')}"
        return True, f"remaining {remaining:.2f}, spent today {self.spent_today():.2f}"

    # ---------------------------------------------------------------- games
    def next_front(self) -> dict:
        front = self.fronts[self.state["cursor"] % len(self.fronts)]
        return front

    def advance_cursor(self) -> None:
        self.state["cursor"] += 1
        if self.state["cursor"] % len(self.fronts) == 0:
            self.state["cycle"] += 1

    def roster(self, game_index: int) -> tuple[list[dict], list[dict], list[int]]:
        """Seat each team's clones on one side; rotate which side a team gets.

        The variant fixes which slots belong to which team index
        (`seat_teams`). Rotating the team -> index map per game moves every
        team through every spawn group over a cycle; a seeded shuffle of the
        remaining order keeps pairings from repeating in lockstep.
        """
        order = list(range(len(self.teams)))
        rotation = game_index % len(self.teams)
        order = order[rotation:] + order[:rotation]
        rng = random.Random(f"{self.config['coworld_id']}:{game_index}")
        head, tail = order[0], order[1:]
        rng.shuffle(tail)
        order = [head] + tail
        roster = []
        sides = [
            {"label": team["label"], "model": team["model"], "team": None, "slots": []}
            for team in self.teams
        ]
        for slot, side in enumerate(self.layout):
            team_index = order[side]
            roster.append({"slot": slot, "player": {"policy_ref": self.teams[team_index]["policy_ref"]}})
            sides[team_index]["slots"].append(slot)
        return roster, sides, order

    def launch(self) -> None:
        front = self.next_front()
        cycle = self.state["cycle"] + 1
        game_index = self.state["cursor"]
        roster, sides, order = self.roster(game_index)
        key = f"ff-{self.config['coworld_id'][4:12]}-c{cycle}-g{game_index}-{front['variant_id']}"
        body = {
            "coworld_id": self.config["coworld_id"],
            "variant_id": front["variant_id"],
            "roster": roster,
            "num_episodes": 1,
            # Seats are named "<team> <n>" on the map, whichever account owns the policies.
            "game_config_overrides": {
                "team_labels": [self.teams[team_index]["label"] for team_index in order]
            },
            "episode_player_llm_spend_limit_usd": self.config["caps"]["per_game_llm_usd"],
            "title": f"Frontier Four c{cycle}: {front['label']}"[:50],
            "description": (
                "Frontier Four, four teams of three: "
                + ", ".join(f"{s['label']} ({s['model']}) on slots {s['slots']}" for s in sides)
            )[:600],
            "notes": f"frontier-four cycle={cycle} game={game_index} front={front['label']}",
            "idempotency_key": key,
        }
        record = {
            "key": key,
            "cycle": cycle,
            "game_index": game_index,
            "front": front,
            "sides": sides,
            "body": body,
            "created_at": iso(utcnow()),
        }
        if self.dry_run:
            # A dry run shows the next game and touches nothing on disk.
            log("dry_run_launch", key=key, variant=front["variant_id"], sides=[(s["label"], s["slots"]) for s in sides])
            return
        response = self.client.create_experience_request(body).model_dump(mode="json")
        record["request"] = {k: response.get(k) for k in ("id", "status", "created_at", "cost_preview")}
        save_json(self.requests_dir / f"{key}.json", record)
        self.state["inflight"].append(key)
        self.advance_cursor()
        self.save()
        log("launched", key=key, request=response.get("id"), variant=front["variant_id"], cost_preview=response.get("cost_preview"))

    def poll(self) -> None:
        for key in list(self.state["inflight"]):
            path = self.requests_dir / f"{key}.json"
            record = load_json(path, None)
            if record is None or "request" not in record:
                self.state["inflight"].remove(key)
                continue
            try:
                detail = self.client.get_experience_request(record["request"]["id"]).model_dump(mode="json")
            except Exception as error:  # noqa: BLE001
                log("poll_failed", key=key, error=str(error)[:200])
                continue
            status = detail.get("status")
            if status not in TERMINAL:
                continue
            record["request"]["status"] = status
            record["request"]["completed_at"] = detail.get("completed_at")
            record["detail"] = {k: detail.get(k) for k in ("completed_count", "failed_count", "error")}
            try:
                episodes = self.client._get(f"/v2/experience-requests/{record['request']['id']}/episodes", list)
            except Exception as error:  # noqa: BLE001
                log("episodes_failed", key=key, error=str(error)[:200])
                continue
            record["episodes"] = episodes
            self.state["inflight"].remove(key)
            for episode in episodes:
                cost = float(episode.get("cost_usd") or 0)
                day = self.today()
                if episode.get("status") == "completed":
                    game = self.game_record(record, episode)
                    if game is not None:
                        cost += float(game.get("llmUsdEstimate") or 0)
                        self.append_game(game)
                        self.state["games"] += 1
                else:
                    # An episode that did not complete may still have spent up to the cap.
                    cost += float(self.config["caps"]["per_game_llm_usd"])
                    log("episode_not_completed", key=key, episode=episode.get("id"), status=episode.get("status"), error=str(episode.get("error"))[:200])
                self.state["spend"][day] = float(self.state["spend"].get(day, 0.0)) + cost
            save_json(path, record)
            self.save()
            log("settled", key=key, status=status, cost_usd=sum(float(e.get("cost_usd") or 0) for e in episodes), games=self.state["games"])
            self.publish()

    def llm_usage(self, episode_request_id: str, sides: list[dict], roster: list[dict] | None = None) -> dict:
        """Price each seat's model calls from its own log.

        The platform's budget meter does not see sidecar spend, so the loop
        prices the `PROXYWAR_LLM_USAGE` summary every seat prints (input,
        cached-input and output tokens) with the config's per-model prices.
        A seat whose log is unreadable is priced at its share of the cap.
        """
        prices = self.config.get("prices_per_million", {})
        cap_share = float(self.config["caps"]["per_game_llm_usd"]) / max(1, len(self.layout))
        # The policy a seat ran is the one the request seated there, which may
        # be older than the config's current version.
        policy_of_slot = {entry["slot"]: entry["player"]["policy_ref"] for entry in roster or []}
        usage = {"usd": 0.0, "teams": {}}
        for side in sides:
            price = prices.get(side["model"], {})
            team = {"inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0, "calls": 0, "errors": 0, "usd": 0.0, "seatsPriced": 0}
            for slot in side["slots"]:
                try:
                    raw = decode_policy_log(
                        self.client.get_bytes(
                            f"/v2/episode-requests/{episode_request_id}/{policy_of_slot.get(slot) or self.policy_version_for(side)}/policy-logs/{slot}"
                        )
                    )
                except Exception as error:  # noqa: BLE001
                    log("seat_log_unreadable", episode=episode_request_id, slot=slot, error=str(error)[:120])
                    team["usd"] += cap_share
                    continue
                summary = None
                for match in re.finditer(r"PROXYWAR_LLM_USAGE (\{.*?\})(?=\n|$)", raw):
                    try:
                        event = json.loads(match.group(1))
                    except json.JSONDecodeError:
                        continue
                    if event.get("event") == "summary":
                        summary = event
                if summary is None:
                    team["usd"] += cap_share
                    continue
                inp = int(summary.get("inputTokens") or 0)
                cached = int(summary.get("cacheReadInputTokens") or 0)
                out = int(summary.get("outputTokens") or 0)
                team["inputTokens"] += inp
                team["cacheReadTokens"] += cached
                team["outputTokens"] += out
                team["calls"] += int(summary.get("responses") or 0)
                team["errors"] += int(summary.get("errors") or 0)
                team["seatsPriced"] += 1
                if price:
                    team["usd"] += (
                        max(0, inp - cached) * float(price.get("input", 0))
                        + cached * float(price.get("cache_read", price.get("input", 0)))
                        + out * float(price.get("output", 0))
                    ) / 1_000_000
                else:
                    team["usd"] += cap_share
            team["usd"] = round(team["usd"], 4)
            usage["teams"][side["label"]] = team
            usage["usd"] += team["usd"]
        usage["usd"] = round(usage["usd"], 4)
        return usage

    def policy_version_for(self, side: dict) -> str:
        for team in self.teams:
            if team["label"] == side["label"]:
                return team["policy_ref"]
        raise KeyError(side["label"])

    def results_artifact(self, episode_request_id: str) -> dict | None:
        try:
            raw = self.client.get_bytes(f"/v2/episode-requests/{episode_request_id}/artifacts/results")
            return json.loads(raw)
        except Exception as error:  # noqa: BLE001
            log("results_artifact_failed", episode=episode_request_id, error=str(error)[:200])
            return None

    def game_record(self, record: dict, episode: dict) -> dict | None:
        episode_request_id = episode.get("id")
        if not isinstance(episode_request_id, str):
            return None
        results = self.results_artifact(episode_request_id) or {}
        players = []
        for player in results.get("players") or []:
            players.append(
                {
                    "slot": player.get("slot"),
                    "name": player.get("name"),
                    "team": player.get("team"),
                    "tilesOwned": player.get("tiles_owned"),
                    "isAlive": player.get("is_alive"),
                }
            )
        # The engine names sides (Red, Blue, ...) only inside the game: read
        # each side's name off any of its seats.
        sides = []
        for side in record["sides"]:
            engine_team = None
            for player in players:
                if player["slot"] in side["slots"] and player.get("team"):
                    engine_team = player["team"]
                    break
            sides.append({**side, "team": engine_team})
        front = record["front"]
        usage = self.llm_usage(episode_request_id, sides, record.get("body", {}).get("roster"))
        replay_url = episode.get("replay_url")
        viewer_base = self.config.get("replay_viewer_base")
        viewer_url = (
            f"{viewer_base}#replay={urllib.parse.quote(replay_url, safe='')}"
            if replay_url and viewer_base
            else None
        )
        return {
            "schemaVersion": 1,
            "llmUsdEstimate": usage["usd"],
            "llmUsageByTeam": usage["teams"],
            "experienceRequestId": record["request"]["id"],
            "episodeRequestId": episode_request_id,
            "variantId": front["variant_id"],
            "map": front["map"],
            "mapSize": front.get("map_size", ""),
            "completedAt": episode.get("completed_at") or iso(utcnow()),
            "replayUrl": replay_url,
            "viewerUrl": viewer_url,
            "costUsd": episode.get("cost_usd"),
            "cycle": record["cycle"],
            "teams": sides,
            "winnerTeam": results.get("winner_team"),
            "scores": episode.get("scores") or results.get("scores") or [],
            "players": players,
            "turnCount": results.get("turn_count"),
            "decisionCount": results.get("decision_count"),
            "degradedCount": results.get("degraded_count"),
        }

    def append_game(self, game: dict) -> None:
        games_path = Path(self.config["games_path"])
        games_path.parent.mkdir(parents=True, exist_ok=True)
        with games_path.open("a") as handle:
            handle.write(json.dumps(game) + "\n")
        log("game_recorded", episode=game["episodeRequestId"], map=game["map"], winner=game["winnerTeam"], cost_usd=game["costUsd"], llm_usd=game.get("llmUsdEstimate"))

    def publish(self) -> None:
        publish = self.config.get("publish")
        if not publish:
            return
        try:
            subprocess.run(publish["argv"], cwd=publish.get("cwd"), check=True, timeout=300)
            log("published")
        except Exception as error:  # noqa: BLE001
            log("publish_failed", error=str(error)[:300])

    def save(self) -> None:
        save_json(self.state_path, self.state)

    # ---------------------------------------------------------------- loop
    def tick(self) -> None:
        self.poll()
        inflight = len(self.state["inflight"])
        if inflight >= self.config["concurrency"]:
            return
        if self.state["games"] + inflight >= self.config.get("max_games", 10**9):
            log("max_games_reached")
            return
        allowed, why = self.may_launch()
        if not allowed:
            log("hold", why=why)
            return
        log("launch_window", why=why)
        self.launch()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true", help="one tick, then exit")
    parser.add_argument("--dry-run", action="store_true", help="never create a request")
    parser.add_argument("--interval", type=int, default=60)
    args = parser.parse_args()
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text())
    state_dir = Path(config.get("state_dir") or config_path.parent / "state").resolve()
    scheduler = Scheduler(config, state_dir, args.dry_run)
    log("start", config=str(config_path), state_dir=str(state_dir), dry_run=args.dry_run, cycle=scheduler.state["cycle"], games=scheduler.state["games"])
    while True:
        try:
            scheduler.tick()
        except KeyboardInterrupt:
            return 0
        except Exception as error:  # noqa: BLE001 - keep the loop alive, say what broke
            log("tick_failed", error=str(error)[:300])
        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
