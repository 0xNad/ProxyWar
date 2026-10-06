"""The Frontier scheduler, Season 2: a free-for-all between frontier models.

Every battle is one hosted game on the Frontier FFA coworld: N models, one
nation each. The game runs in Team mode with N single-seat teams
(`team_count=N`, `seat_teams=[0..N-1]`, `team_labels` per request) so every
seat is named after its model ("Grok 1"). The roster is the config's `teams`
list; nothing here assumes five.

Fairness. The spawn ballot is a serial dictatorship ordered by seat name and
rotated by `episodeIndex` (src/server/agents/AgentSpawnSelection.ts
buildAgentSpawnPriority). Every request sets `game_config_overrides.episodeIndex`
so that in every aligned block of N games each model picks first exactly once,
and on every front each model picks first once over N cycles. Slots rotate
too, with a different stride, so slot order is not tied to pick order. Each
game records every side's pick order.

Cadence. Battles start at fixed UTC appointment times (`schedule.times_utc`,
default 13:00 and 19:00): one game per appointment, never two at once. An
appointment that cannot start within `slot_grace_minutes` (scheduler down, a
game still running, a hold) is skipped, never made up later.

Spend. Every request carries an LLM spend limit, a safety net sized never to
bind. The platform divides a request's `episode_player_llm_spend_limit_usd`
evenly across its seats, so the config names the cap per seat
(`caps.per_seat_llm_usd`, default 5.0) and the request sends it times N. The
config is refused when that cap is below what the most expensive model's
seat could spend on its plans. A daily cap holds the loop, and a floor on the
league coworld's remaining daily funds keeps the league's own rounds running.
A launch the platform refuses for lack of experience credits (HTTP 402) holds
the loop until the refill time the refusal names. In a fresh coworld the
first request reserves 10 x its limit, so launch the canary first.

Records. Each finished game becomes one schemaVersion-2 line in the games
file: standings, land shares, eliminations and the win type from the public
replay, moments, the models' own messages, and per-model telemetry and public
dispatches read from each seat's policy log (PROXYWAR_LLM_USAGE,
PROXYWAR_PLAN, PROXYWAR_DISPATCH, PROXYWAR_SAY lines). Missing replays or
seat logs make a thinner record, never a lost one.

This Python runs from HOME under launchd and must never touch /Volumes: the
config refuses any state or games path there, and publishing is a separate
job (deploy/mac/start-proxywar-frontier-four-publisher.zsh).

Usage:
    python scheduler.py --config frontier-ffa.json [--once] [--dry-run]
    python scheduler.py --config frontier-ffa.json --launch-now [--variant ffa5-canary [--seat-spend-limit 1]]

`--launch-now` starts the next season game at once (it advances the
rotation and is recorded in the games file). With `--variant` it is a test
launch instead: the next game's rotation on that variant, recorded only in
`test_games_path`, the rotation untouched, capped per seat at
`caps.test_per_seat_llm_usd` (or `--seat-spend-limit`). Season games always
use the season cap. When the scheduler is already running, `--launch-now`
leaves the request for it (`<state_dir>/launch-now.json`) and exits.

A season request that ends without a fair game (no completed episode, or a
seat whose policy never connected) is played again at the next appointment
with the same rotation, up to `max_game_retries` times, so every block of N
games keeps one first pick per model.

State lives in `state_dir`: `state.json` (rotation cursor, games to replay,
appointments, in-flight requests, daily spend, credits hold) and `requests/`
(one JSON per request, for resumption and audit).
"""

from __future__ import annotations

import argparse
import ast
import datetime as dt
import gzip
import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

SERVER = "https://softmax.com/api"
TERMINAL = {"completed", "failed", "cancelled"}
STATE_VERSION = 2

# The engine's seat names: `${label.trim()} ${ordinal}` normalised by
# coworld-adapter/src/coworld-seat-specs.ts proxyWarUsernames. Labels are held
# to characters that normalisation keeps, so a seat's name is exactly
# "<label> 1" and the spawn order computed here is the one the game uses.
LABEL_PATTERN = re.compile(r"^[A-Za-z0-9_.üÜ]+(?: [A-Za-z0-9_.üÜ]+)*$")
LABEL_MAX_LENGTH = 24  # config_schema team_labels.items.maxLength
USERNAME_MAX_LENGTH = 27  # src/core/validations/username.ts MAX_USERNAME_LENGTH
MAX_TEAMS = 8  # config_schema team_count.maximum

CONQUEST_SHARE = 0.95  # the engine's team win: 95% of the land
DISPATCH_MAX_CHARS = 140
MESSAGE_MAX_CHARS = 280
MAX_VOICES = 40
MAX_MOMENTS = 30
NEAR_MOMENT_TURNS = 500
NUKE_UNITS = {"Atom Bomb": "an atom bomb", "Hydrogen Bomb": "a hydrogen bomb", "MIRV": "a MIRV"}
# Telemetry events whose effect the game confirmed (AgentSpectatorTelemetry
# marks an action it only accepted "accepted_action").
CONFIRMED_EVIDENCE = {"confirmed_effect", "state_derived"}

# The input tokens one plan call is assumed to send when checking that the
# per-seat cap cannot bind. Season 1's largest prompts (Fable: 11 rivals and
# every legal action) averaged 8.3k; Season 2's names 4 rivals.
PLAN_INPUT_TOKENS_BOUND = 8500

DEFAULT_TIMES_UTC = ["13:00", "19:00"]
DEFAULT_HARNESS = {
    "playerVersion": None,
    "planEvery": 15,
    "plansPerSeat": 17,
    "reasoning": "low",
    "maxOutputTokens": 3000,
}


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=dt.timezone.utc)


def next_refill(message: str, now: dt.datetime | None = None) -> dt.datetime:
    """The refill time a credits refusal names, else the next UTC midnight."""
    match = re.search(r"next refill ([0-9T:+.Z-]+)", message)
    if match:
        try:
            return parse_iso(match.group(1).rstrip("."))
        except ValueError:
            pass
    now = now or utcnow()
    return (now + dt.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


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


# ------------------------------------------------------------------- config
def _home_path(value, fallback: Path) -> Path:
    path = Path(value).expanduser() if value else fallback
    path = path.resolve() if path.is_absolute() else path.absolute()
    if str(path).lower() == "/volumes" or str(path).lower().startswith("/volumes/"):
        # A launchd Python that touches a removable volume raises a TCC prompt
        # nobody answers, and every launchd job's volume access wedges.
        raise ValueError(f"{path} is on /Volumes; the scheduler keeps its files under HOME")
    return path


def seat_spend_bound(price: dict | None, harness: dict) -> float | None:
    """What one seat's plans can cost at most: every plan sends a full-size
    prompt and fills its output allowance. None for an unpriced model."""
    if not price:
        return None
    per_call = PLAN_INPUT_TOKENS_BOUND * float(price.get("input", 0)) + int(harness["maxOutputTokens"]) * float(
        price.get("output", 0)
    )
    return int(harness["plansPerSeat"]) * per_call / 1_000_000


def load_config(raw: dict, config_path: Path) -> dict:
    """Validate the config and fill in Season 2 defaults."""
    config = dict(raw)
    teams = config.get("teams")
    if not isinstance(teams, list) or not 2 <= len(teams) <= MAX_TEAMS:
        raise ValueError(f"teams must list 2 to {MAX_TEAMS} models")
    labels = set()
    for team in teams:
        label = team.get("label")
        if not isinstance(label, str) or len(label) > LABEL_MAX_LENGTH or not LABEL_PATTERN.match(label):
            raise ValueError(f"team label {label!r} must be 1-{LABEL_MAX_LENGTH} letters, digits, '_' or '.'")
        if label in labels:
            raise ValueError(f"team label {label!r} is used twice")
        labels.add(label)
        for key in ("model", "policy_ref"):
            if not isinstance(team.get(key), str) or not team[key]:
                raise ValueError(f"team {label} needs {key}")
    fronts = config.get("fronts")
    if not isinstance(fronts, list) or not fronts:
        raise ValueError("fronts must list at least one front")
    for front in fronts + list(config.get("test_variants") or []):
        for key in ("label", "variant_id"):
            if not isinstance(front.get(key), str) or not front[key]:
                raise ValueError(f"front {front} needs {key}")
    for key in ("coworld_id", "budget_coworld_name"):
        if not isinstance(config.get(key), str) or not config[key]:
            raise ValueError(f"{key} is required")
    if config.get("publish"):
        # Season 1 could run a publish command; it would run this Python's
        # child on the volume. Publishing is the publisher job's alone.
        raise ValueError("publish is not supported: publishing is a separate job")

    schedule = dict(config.get("schedule") or {})
    schedule["times_utc"] = [f"{h:02d}:{m:02d}" for h, m in parse_times(schedule.get("times_utc") or DEFAULT_TIMES_UTC)]
    schedule["slot_grace_minutes"] = float(schedule.get("slot_grace_minutes", 30))
    config["schedule"] = schedule
    config["harness"] = {**DEFAULT_HARNESS, **(config.get("harness") or {})}
    caps = dict(config.get("caps") or {})
    for old in ("per_game_llm_usd", "test_llm_usd"):
        if old in caps:
            # The platform splits a request's limit evenly across its seats;
            # a per-game number hides how little each seat gets.
            raise ValueError(f"caps.{old} is gone: set caps.per_seat_llm_usd and caps.test_per_seat_llm_usd")
    caps["per_seat_llm_usd"] = float(caps.get("per_seat_llm_usd", 5.0))
    caps["test_per_seat_llm_usd"] = float(caps.get("test_per_seat_llm_usd", 1.0))
    # By default a day fits every appointment at its worst case plus a canary.
    caps.setdefault(
        "daily_usd",
        len(teams) * (caps["per_seat_llm_usd"] * len(schedule["times_utc"]) + caps["test_per_seat_llm_usd"]),
    )
    caps.setdefault("min_remaining_usd", 60.0)
    config["caps"] = caps
    prices = config.get("prices_per_million") or {}
    bounds = {team["label"]: seat_spend_bound(prices.get(team["model"]), config["harness"]) for team in teams}
    stopped = [label for label, bound in bounds.items() if bound is not None and bound > caps["per_seat_llm_usd"]]
    if stopped:
        worst = max(bounds[label] for label in stopped)
        raise ValueError(
            f"caps.per_seat_llm_usd {caps['per_seat_llm_usd']} could stop {', '.join(stopped)} mid-game: "
            f"{config['harness']['plansPerSeat']} plans can cost up to {worst:.2f} a seat"
        )
    config.setdefault("season", 2)
    config.setdefault("timer_turns", 36000)
    config.setdefault("launch_now_ttl_minutes", 30)
    config.setdefault("record_retry_ticks", 10)
    config.setdefault("max_game_retries", 2)
    config.setdefault("test_variants", [])

    state_dir = _home_path(config.get("state_dir"), config_path.parent / "state")
    config["state_dir"] = str(state_dir)
    config["games_path"] = str(_home_path(config.get("games_path"), state_dir / "frontier-ffa-games.jsonl"))
    config["test_games_path"] = str(
        _home_path(config.get("test_games_path"), state_dir / "frontier-ffa-test-games.jsonl")
    )
    return config


# ----------------------------------------------------------------- rotation
def seat_username(label: str, ordinal: int = 1) -> str:
    return f"{label.strip()} {ordinal}"[:USERNAME_MAX_LENGTH].strip()


def _code_units(value: str) -> bytes:
    # JavaScript compares strings by UTF-16 code unit; big-endian UTF-16
    # bytes sort the same way.
    return value.encode("utf-16-be")


def spawn_priority(usernames: list[str], episode_index: int) -> list[str]:
    """buildAgentSpawnPriority for unique names: code-unit sort, rotate by
    episodeIndex."""
    stable = sorted(usernames, key=_code_units)
    offset = episode_index % len(stable)
    return stable[offset:] + stable[:offset]


def episode_index_for(game_index: int, team_count: int, front_count: int) -> int:
    """The episodeIndex of season game `game_index` (0-based).

    Pick offset is `episodeIndex % N`. Plain `game_index` already gives every
    aligned block of N games one first pick per model; the extra step every
    lcm(F, N) games makes each front see every offset over N cycles even when
    the front count F shares a factor with N (with 11 fronts and 5 models it
    never triggers before game 55).
    """
    block = team_count * front_count // math.gcd(team_count, front_count)
    return game_index + game_index // block


def slot_stride(team_count: int) -> int:
    for stride in range(2, team_count):
        if math.gcd(stride, team_count) == 1:
            return stride
    return 1


def plan_game(config: dict, game_index: int, variant_id: str | None = None) -> dict:
    """The roster, overrides and recorded sides of season game `game_index`,
    or of a test launch on `variant_id` with that game's rotation."""
    teams = config["teams"]
    fronts = config["fronts"]
    count = len(teams)
    if variant_id is None:
        front = fronts[game_index % len(fronts)]
    else:
        front = next(
            (f for f in list(fronts) + list(config.get("test_variants") or []) if f["variant_id"] == variant_id),
            None,
        )
        if front is None:
            raise ValueError(f"unknown variant {variant_id}; add it to fronts or test_variants")
    usernames = [seat_username(team["label"]) for team in teams]
    by_name = sorted(range(count), key=lambda index: _code_units(usernames[index]))
    rank = {team_index: position for position, team_index in enumerate(by_name)}
    stride = slot_stride(count)
    shift = stride * game_index + game_index // count
    slot_of = {index: (rank[index] + shift) % count for index in range(count)}
    episode_index = episode_index_for(game_index, count, len(fronts))
    priority = spawn_priority(usernames, episode_index)
    team_at_slot = {slot: index for index, slot in slot_of.items()}
    sides = [
        {
            "label": team["label"],
            "model": team["model"],
            "team": None,
            "slots": [slot_of[index]],
            "pickOrder": priority.index(usernames[index]) + 1,
        }
        for index, team in enumerate(teams)
    ]
    return {
        "game_index": game_index,
        "cycle": game_index // len(fronts) + 1,
        "front": front,
        "episode_index": episode_index,
        "sides": sides,
        "roster": [
            {"slot": slot, "player": {"policy_ref": teams[team_at_slot[slot]]["policy_ref"]}} for slot in range(count)
        ],
        "overrides": {
            "team_count": count,
            "seat_teams": list(range(count)),
            "team_labels": [teams[team_at_slot[slot]]["label"] for slot in range(count)],
            "episodeIndex": episode_index,
        },
    }


# ----------------------------------------------------------------- schedule
def parse_times(times) -> list[tuple[int, int]]:
    parsed = set()
    for value in times:
        match = re.fullmatch(r"(\d{1,2}):(\d{2})", str(value).strip())
        if not match or int(match.group(1)) > 23 or int(match.group(2)) > 59:
            raise ValueError(f"appointment time {value!r} is not HH:MM (UTC)")
        parsed.add((int(match.group(1)), int(match.group(2))))
    if not parsed:
        raise ValueError("schedule.times_utc needs at least one time")
    return sorted(parsed)


def slot_id(start: dt.datetime) -> str:
    return start.strftime("%Y-%m-%dT%H:%MZ")


def slot_starts(now: dt.datetime, times: list[str], days_back: int = 2, days_ahead: int = 1) -> list[dt.datetime]:
    day = now.astimezone(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    starts = []
    for offset in range(-days_back, days_ahead + 1):
        base = day + dt.timedelta(days=offset)
        for hour, minute in parse_times(times):
            starts.append(base.replace(hour=hour, minute=minute))
    return sorted(starts)


def due_slot(now: dt.datetime, times: list[str], grace_minutes: float, taken: dict) -> dt.datetime | None:
    """The appointment open now (started, within its grace) and not yet used."""
    grace = dt.timedelta(minutes=grace_minutes)
    for start in slot_starts(now, times):
        if start <= now < start + grace and slot_id(start) not in taken:
            return start
    return None


def next_slot(now: dt.datetime, times: list[str]) -> dt.datetime:
    return next(start for start in slot_starts(now, times) if start > now)


def missed_slots(
    now: dt.datetime, times: list[str], grace_minutes: float, taken: dict, since: dt.datetime
) -> list[dt.datetime]:
    """Appointments whose window closed unused since the season started."""
    grace = dt.timedelta(minutes=grace_minutes)
    return [
        start
        for start in slot_starts(now, times)
        if start >= since and start + grace <= now and slot_id(start) not in taken
    ]


# --------------------------------------------------------------- sanitizing
# The publisher's rules (src/server/agents/FrontierFourWorld.ts
# sanitizeFrontierPublicText), in its order. Its link patterns have no `u`
# flag, so `\b` there is an ASCII word boundary: re.ASCII keeps "看www.x"
# a link here too.
_URL = re.compile(r"(?:\b[a-z][a-z0-9+.-]*://|\bwww\.)\S*", re.IGNORECASE | re.ASCII)
_HANDLE = re.compile(r"@[\w.]+")
_DOMAIN_WITH_PATH = re.compile(r"\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/\S*", re.IGNORECASE | re.ASCII)
_BARE_DOMAIN = re.compile(
    r"\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|xyz|gg|co|app|dev|me|ly|tv|link|site|info|biz|sh|to)\b"
    r"(?:/\S*)?",
    re.IGNORECASE | re.ASCII,
)
_SPACE = re.compile(r"\s+")
ELLIPSIS = "..."  # ASCII: NFKC turns "…" into three characters, past the limit


def _strip_public_text(text: str) -> str:
    # Format characters (zero-width, bidi, BOM) are deleted, not spaced, so
    # "www" + U+200B + ".x.shop" is still a link; other controls are spaces.
    text = unicodedata.normalize("NFKC", text)
    text = "".join(
        " " if unicodedata.category(ch) in ("Cc", "Zl", "Zp") else ch for ch in text if unicodedata.category(ch) != "Cf"
    )
    for pattern in (_URL, _HANDLE, _DOMAIN_WITH_PATH, _BARE_DOMAIN):
        text = pattern.sub(" ", text)
    return _SPACE.sub(" ", text).strip()


def sanitize_public_text(value, limit: int) -> str | None:
    """Spectator-safe text: no links, @handles, control or invisible
    characters, single spaces, at most `limit` characters after the
    publisher's NFKC; None when no word is left."""
    if not isinstance(value, str):
        return None
    text = _strip_public_text(value)
    if len(text) > limit:
        cut = text[: limit - len(ELLIPSIS)]
        space = cut.rfind(" ")
        if space >= limit // 2:
            cut = cut[:space]
        # Cutting can turn a word into something link-shaped ("x.company"
        # into "x.co"): strip again, which only ever shortens.
        text = _strip_public_text(cut.rstrip(" ,;:-") + ELLIPSIS)
    # Punctuation alone says nothing (the publisher drops it too).
    if len(text) > limit or not any(ch.isalnum() or ord(ch) >= 0x1F000 for ch in text):
        return None
    return text


# ---------------------------------------------------------------- seat logs
_TAGGED = re.compile(r"(?:^|\s)(PROXYWAR_LLM_USAGE|PROXYWAR_PLAN|PROXYWAR_DISPATCH|PROXYWAR_SAY) (\{.*\})\s*$")


def parse_seat_log(text: str) -> dict:
    """The contract-A lines of one seat's log; other lines are ignored except
    for the spend-limit refusals that mark a capped seat."""
    parsed = {"usage": [], "plans": [], "dispatches": [], "says": [], "capped": False}
    keys = {
        "PROXYWAR_LLM_USAGE": "usage",
        "PROXYWAR_PLAN": "plans",
        "PROXYWAR_DISPATCH": "dispatches",
        "PROXYWAR_SAY": "says",
    }
    for line in text.splitlines():
        match = _TAGGED.search(line)
        if match is None:
            if "spend limit reached" in line.lower():
                parsed["capped"] = True
            continue
        try:
            payload = json.loads(match.group(2))
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        parsed[keys[match.group(1)]].append(payload)
        if match.group(1) == "PROXYWAR_LLM_USAGE" and payload.get("status") == "spend_limit":
            parsed["capped"] = True
    return parsed


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    value = ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2
    return round(value, 1)


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def seat_usage(parsed: dict) -> dict:
    """One seat's plan counts, per-call samples and token totals."""
    usage = parsed["usage"]
    summary = next((e for e in reversed(usage) if e.get("event") == "summary"), None)
    plan_results = [e for e in usage if e.get("event") == "plan_result"]
    # Season 2 players put latency and tokens on plan_result; Season 1
    # players put them on a separate "response" event per call.
    if any("latencyMs" in e or "checkpoint" in e for e in plan_results):
        # Only checkpoints where the model was asked and answered or ran out
        # the clock. A seat past its spend limit fails every later
        # checkpoint in about a millisecond without a call.
        calls = [e for e in plan_results if e.get("status") in ("applied", "invalid_json", "timeout")]
    else:
        calls = [e for e in usage if e.get("event") == "response"]
    plan_lines = parsed["plans"]
    if summary is not None and _number(summary.get("plans")) is not None:
        plans = int(summary["plans"])
    elif plan_lines:
        plans = len(plan_lines)
    else:
        plans = len(plan_results)
    if summary is not None and _number(summary.get("planFailures")) is not None:
        failures = int(summary["planFailures"])
    elif plan_lines:
        failures = sum(1 for p in plan_lines if p.get("status") != "applied")
    else:
        failures = sum(1 for e in plan_results if e.get("status") != "applied")
    timeouts = sum(1 for p in plan_lines if p.get("status") == "timeout") or sum(
        1 for e in plan_results if e.get("status") == "timeout"
    )

    def samples(key: str) -> list[float]:
        return [v for v in (_number(e.get(key)) for e in calls) if v is not None]

    if summary is not None and _number(summary.get("inputTokens")) is not None:
        tokens = {
            "input": int(_number(summary.get("inputTokens")) or 0),
            "cached": int(_number(summary.get("cacheReadInputTokens")) or _number(summary.get("cacheReadTokens")) or 0),
            "output": int(_number(summary.get("outputTokens")) or 0),
        }
    elif calls:
        tokens = {
            "input": int(sum(samples("inputTokens"))),
            "cached": int(sum(samples("cacheReadTokens")) or sum(samples("cacheReadInputTokens"))),
            "output": int(sum(samples("outputTokens"))),
        }
    else:
        tokens = None
    return {
        "plans": plans,
        "planFailures": failures,
        "timeouts": timeouts,
        "latencyMs": samples("latencyMs"),
        "inputTokens": samples("inputTokens"),
        "outputTokens": samples("outputTokens"),
        "reasoningTokens": samples("reasoningTokens"),
        "tokens": tokens,
        "capped": bool(parsed["capped"]),
    }


def price_tokens(tokens: dict | None, price: dict | None) -> float | None:
    if tokens is None or not price:
        return None
    uncached = max(0, tokens["input"] - tokens["cached"])
    return (
        uncached * float(price.get("input", 0))
        + tokens["cached"] * float(price.get("cache_read", price.get("input", 0)))
        + tokens["output"] * float(price.get("output", 0))
    ) / 1_000_000


def label_telemetry(seats: list[dict], price: dict | None) -> dict:
    """Contract-B telemetry for one side from its readable seats."""
    latency = [v for seat in seats for v in seat["latencyMs"]]
    usd = [price_tokens(seat["tokens"], price) for seat in seats]
    reasoning = [v for seat in seats for v in seat["reasoningTokens"]]
    return {
        "plans": sum(seat["plans"] for seat in seats),
        "planFailures": sum(seat["planFailures"] for seat in seats),
        "timeouts": sum(seat["timeouts"] for seat in seats),
        "latencyMsMedian": _median(latency),
        "latencyMsP90": _percentile(latency, 0.9),
        "outputTokensMedian": _median([v for seat in seats for v in seat["outputTokens"]]),
        "inputTokensMedian": _median([v for seat in seats for v in seat["inputTokens"]]),
        "reasoningTokensMedian": _median(reasoning) if reasoning else None,
        "usd": round(sum(usd), 4) if usd and all(v is not None for v in usd) else None,
        "capped": any(seat["capped"] for seat in seats),
    }


def harness_from_logs(parsed_logs: list[dict], defaults: dict) -> dict:
    """What the players say they ran, else the config's description of it."""
    harness = {key: defaults.get(key) for key in DEFAULT_HARNESS}
    aliases = {
        "playerVersion": ("playerVersion", "promptVariant"),
        "planEvery": ("planEvery",),
        "plansPerSeat": ("plansPerSeat", "maxPlans"),
        "reasoning": ("reasoning",),
        "maxOutputTokens": ("maxOutputTokens",),
    }
    for key, names in aliases.items():
        for parsed in parsed_logs:
            found = next((e[name] for e in parsed["usage"] for name in names if e.get(name) not in (None, "")), None)
            if found is not None:
                harness[key] = found
                break
    return harness


# ------------------------------------------------------------------ replays
# A replay is someone else's JSON: read every object and list through these,
# so an odd shape thins the record instead of stopping the season.
def _obj(value) -> dict:
    return value if isinstance(value, dict) else {}


def _dicts(value) -> list[dict]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _get(mapping: dict, key):
    return mapping.get(key) if isinstance(key, str) else None


def _inline_json(replay: dict, name: str) -> dict:
    raw = _obj(replay.get("inlineRunArtifacts")).get(name)
    if not isinstance(raw, str):
        return {}
    try:
        return _obj(json.loads(raw))
    except json.JSONDecodeError:
        return {}


def _label_for_name(name, labels_by_name: dict, labels: list[str]):
    if not isinstance(name, str):
        return None
    if name in labels_by_name:
        return labels_by_name[name]
    base = re.sub(r"\s+\d+$", "", name.strip())
    return base if base in labels else None


def replay_seats(replay: dict, sides: list[dict]) -> dict:
    """Slot -> what the game knows about that seat, and name/id -> label."""
    results = _obj(replay.get("results"))
    final = _obj(replay.get("finalState"))
    seats: dict[int, dict] = {}
    for slot, player in enumerate(_dicts(final.get("players"))):
        seats[slot] = {
            "name": player.get("username"),
            "playerID": player.get("playerID"),
            "team": player.get("team"),
            "tiles": player.get("tilesOwned"),
            "alive": player.get("isAlive"),
        }
    for player in _dicts(results.get("players")):
        slot = player.get("slot")
        if not isinstance(slot, int):
            continue
        seat = seats.setdefault(slot, {})
        for key, source in (("name", "name"), ("team", "team"), ("tiles", "tiles_owned"), ("alive", "is_alive")):
            if seat.get(key) is None and player.get(source) is not None:
                seat[key] = player.get(source)
    label_of_slot = {slot: side["label"] for side in sides for slot in side["slots"]}
    labels = [side["label"] for side in sides]
    by_name = {
        seat["name"]: label_of_slot[slot]
        for slot, seat in seats.items()
        if isinstance(seat.get("name"), str) and slot in label_of_slot
    }
    by_player = {}
    for slot, seat in seats.items():
        if isinstance(seat.get("playerID"), str) and slot in label_of_slot:
            by_player[seat["playerID"]] = label_of_slot[slot]
    for snapshot in _dicts(_obj(replay.get("spectatorReplay")).get("snapshots")):
        for player in _dicts(snapshot.get("players")):
            label = _label_for_name(player.get("username"), by_name, labels)
            if label and isinstance(player.get("playerID"), str):
                by_player.setdefault(player["playerID"], label)
    return {
        "seats": seats,
        "label_of_slot": label_of_slot,
        "by_name": by_name,
        "by_player": by_player,
        "labels": labels,
    }


def _tiles(seat: dict) -> int:
    value = _number(seat.get("tiles"))
    return int(max(0, value)) if value is not None else 0


def _elimination_turns(replay: dict) -> dict:
    """Seat name -> turn it was eliminated, from the spectator telemetry,
    else the first snapshot that shows it dead."""
    turns: dict[str, int] = {}
    for event in _dicts(_inline_json(replay, "spectator-telemetry.json").get("events")):
        name, turn = event.get("actorName"), event.get("turnNumber")
        if event.get("kind") == "elimination" and isinstance(name, str) and isinstance(turn, int):
            turns.setdefault(name, turn)
    spawned = set()
    for snapshot in _dicts(_obj(replay.get("spectatorReplay")).get("snapshots")):
        for player in _dicts(snapshot.get("players")):
            name = player.get("username")
            if not isinstance(name, str):
                continue
            if player.get("hasSpawned") or (_number(player.get("tilesOwned")) or 0) > 0:
                spawned.add(name)
            if name in spawned and player.get("isAlive") is False and isinstance(snapshot.get("turnNumber"), int):
                turns.setdefault(name, snapshot["turnNumber"])
    return turns


def unavailable_labels(replay: dict | None, sides: list[dict]) -> list[str]:
    """Sides with a seat whose policy never connected: the game seated it
    with no spawn and zero score, so the result is no fair contest."""
    slots = (replay or {}).get("unavailablePlayerSlots")
    slots = {slot for slot in slots if isinstance(slot, int)} if isinstance(slots, list) else set()
    return [side["label"] for side in sides if slots.intersection(side["slots"])]


def standings_from_replay(replay: dict, sides: list[dict], timer_turns: int | None) -> dict:
    """Standings, winner and win type for the recorded sides. A side the
    replay says nothing about gets no row rather than a made-up one."""
    known = replay_seats(replay, sides)
    seats = known["seats"]
    results = _obj(replay.get("results"))
    final = _obj(replay.get("finalState"))
    eliminated = _elimination_turns(replay)
    total = sum(_tiles(seat) for seat in seats.values())
    rows = []
    for side in sides:
        own = [seats[slot] for slot in side["slots"] if slot in seats]
        if not any(_number(seat.get("tiles")) is not None or isinstance(seat.get("alive"), bool) for seat in own):
            continue
        tiles = sum(_tiles(seat) for seat in own)
        alive = any(seat.get("alive") is True for seat in own)
        turns = [eliminated.get(seat.get("name")) for seat in own]
        elimination = None
        if not alive and len(own) == len(side["slots"]) and all(turn is not None for turn in turns):
            elimination = max(turns)
        rows.append(
            {
                "label": side["label"],
                "landShare": round(tiles / total, 4) if total > 0 else 0.0,
                "tilesOwned": tiles,
                "isAlive": alive,
                "eliminatedAtTurn": elimination,
            }
        )

    def strength(row: dict) -> tuple:
        return (
            row["tilesOwned"],
            row["isAlive"],
            row["eliminatedAtTurn"] if row["eliminatedAtTurn"] is not None else -1,
        )

    ordered = sorted(rows, key=strength, reverse=True)
    for position, row in enumerate(ordered):
        tied = position > 0 and strength(ordered[position - 1]) == strength(row)
        row["rank"] = ordered[position - 1]["rank"] if tied else position + 1

    engine_team = {}
    for side in sides:
        for slot in side["slots"]:
            team = seats.get(slot, {}).get("team")
            if isinstance(team, str) and team:
                engine_team.setdefault(side["label"], team)
                break
    declared = None
    winner_team = results.get("winner_team", final.get("winnerTeam"))
    if isinstance(winner_team, str) and winner_team:
        declared = next((label for label, team in engine_team.items() if team == winner_team), None)
    if declared is None:
        winner_slot = results.get("winner_slot", final.get("winnerSlot"))
        if isinstance(winner_slot, int) and not engine_team:
            declared = known["label_of_slot"].get(winner_slot)
    turn_count = results.get("turn_count", final.get("turnCount"))
    share = next((row["landShare"] for row in rows if row["label"] == declared), None)
    if unavailable_labels(replay, sides):
        # A seat that never connected lost nothing on the board: no winner,
        # and no standings to fold into anyone's form.
        ordered, winner, win_type = [], None, "none"
    elif declared is not None and share is not None:
        # A winner the engine names at its game timer is a points win; one
        # named earlier holds 95% of the land.
        timer = isinstance(turn_count, int) and timer_turns and turn_count >= timer_turns
        win_type = "points" if timer and share < CONQUEST_SHARE else "conquest"
        winner = declared
    else:
        top = [row for row in ordered if row["rank"] == 1]
        if len(top) == 1 and top[0]["tilesOwned"] > 0:
            winner, win_type = top[0]["label"], "points"
        else:
            winner, win_type = None, "none"
    return {
        "standings": ordered,
        "winnerLabel": winner,
        "winType": win_type,
        "engineTeam": engine_team,
        "turnCount": turn_count if isinstance(turn_count, int) else None,
        "decisionCount": results.get("decision_count") if isinstance(results.get("decision_count"), int) else None,
        "degradedCount": results.get("degraded_count") if isinstance(results.get("degraded_count"), int) else None,
        "known": known,
    }


def _spread(items: list, count: int) -> list:
    """`count` items evenly across the list, first and last included."""
    if count <= 0:
        return []
    if len(items) <= count:
        return list(items)
    if count == 1:
        return [items[-1]]
    step = (len(items) - 1) / (count - 1)
    return [items[round(index * step)] for index in range(count)]


def _client_names(record: dict) -> dict:
    return {p.get("clientID"): p.get("username") for p in _dicts(_obj(record.get("info")).get("players"))}


def moments_from_replay(replay: dict, known: dict, standings: list[dict]) -> list[dict]:
    """Eliminations, betrayals, nukes, alliances and lead changes."""
    labels = known["labels"]

    def label(name):
        return _label_for_name(name, known["by_name"], labels)

    found = {"elimination": [], "betrayal": [], "nuke": [], "alliance": [], "lead_change": []}
    for row in standings:
        if row["eliminatedAtTurn"] is not None:
            found["elimination"].append(
                {"turn": row["eliminatedAtTurn"], "kind": "elimination", "text": f"{row['label']} was eliminated"}
            )

    events = _dicts(_inline_json(replay, "spectator-telemetry.json").get("events"))
    allied: set = set()
    for event in events:
        kind, turn = event.get("kind"), event.get("turnNumber")
        actor, target = label(event.get("actorName")), label(event.get("targetName"))
        # Telemetry also reports actions the game accepted but never carried
        # out ("moves to break", "attempts to escalate"): only effects count.
        confirmed = event.get("evidenceLevel") in CONFIRMED_EVIDENCE
        if not isinstance(turn, int) or actor is None or actor == target or not confirmed:
            continue
        if kind == "alliance_break" and target:
            found["betrayal"].append(
                {"turn": turn, "kind": "betrayal", "text": f"{actor} broke its alliance with {target}"}
            )
            allied.discard(frozenset((actor, target)))
        elif kind == "nuke":
            text = f"{actor} launched a nuke" + (f" at {target}" if target else "")
            found["nuke"].append({"turn": turn, "kind": "nuke", "text": text})
        elif kind == "alliance_formed" and target:
            pair = frozenset((actor, target))
            if pair not in allied:
                allied.add(pair)
                found["alliance"].append(
                    {"turn": turn, "kind": "alliance", "text": f"{actor} and {target} formed an alliance"}
                )

    if not events:
        # No telemetry: read the same moments off the game's own intents.
        record = _inline_json(replay, "game-record.json")
        client_names = _client_names(record)
        requests: dict = {}
        for turn in _dicts(record.get("turns")):
            number = turn.get("turnNumber")
            for intent in _dicts(turn.get("intents")):
                actor = label(_get(client_names, intent.get("clientID")))
                kind = intent.get("type")
                if actor is None or not isinstance(number, int):
                    continue
                target = _get(known["by_player"], intent.get("recipient"))
                # Breaking an alliance that never formed does nothing.
                if kind == "breakAlliance" and target and frozenset((actor, target)) in allied:
                    found["betrayal"].append(
                        {"turn": number, "kind": "betrayal", "text": f"{actor} broke its alliance with {target}"}
                    )
                    allied.discard(frozenset((actor, target)))
                elif kind == "build_unit" and intent.get("unit") in NUKE_UNITS:
                    found["nuke"].append(
                        {"turn": number, "kind": "nuke", "text": f"{actor} launched {NUKE_UNITS[intent['unit']]}"}
                    )
                elif kind == "allianceRequest" and target and target != actor:
                    pair = frozenset((actor, target))
                    requests[(actor, target)] = number
                    if (target, actor) in requests and pair not in allied:
                        allied.add(pair)
                        found["alliance"].append(
                            {"turn": number, "kind": "alliance", "text": f"{target} and {actor} formed an alliance"}
                        )

    leader = None
    for snapshot in _dicts(_obj(replay.get("spectatorReplay")).get("snapshots")):
        tiles: dict[str, int] = {}
        for player in _dicts(snapshot.get("players")):
            owner = label(player.get("username"))
            if owner is not None:
                tiles[owner] = tiles.get(owner, 0) + max(0, _number(player.get("tilesOwned")) or 0)
        if not tiles or not isinstance(snapshot.get("turnNumber"), int):
            continue
        best = max(tiles.values())
        top = [name for name, value in tiles.items() if value == best]
        if best <= 0 or len(top) != 1:
            continue
        if leader is not None and top[0] != leader:
            found["lead_change"].append(
                {"turn": snapshot["turnNumber"], "kind": "lead_change", "text": f"{top[0]} took the lead from {leader}"}
            )
        leader = top[0]

    # Keep every elimination, betrayal and nuke; thin alliances and lead
    # changes evenly so a long game does not drown the rest.
    moments = found["elimination"] + found["betrayal"] + found["nuke"]
    room = max(0, MAX_MOMENTS - len(moments))
    moments += _spread(
        found["lead_change"], min(len(found["lead_change"]), max(room // 2, room - len(found["alliance"])))
    )
    moments += _spread(found["alliance"], max(0, MAX_MOMENTS - len(moments)))
    return sorted(moments[:MAX_MOMENTS], key=lambda moment: moment["turn"])


def messages_from_replay(replay: dict, known: dict) -> list[dict]:
    """The models' own messages: agent_message intents in the game record."""
    record = _inline_json(replay, "game-record.json")
    client_names = _client_names(record)
    messages = []
    for turn in _dicts(record.get("turns")):
        for intent in _dicts(turn.get("intents")):
            if intent.get("type") != "agent_message":
                continue
            sender = _label_for_name(_get(client_names, intent.get("clientID")), known["by_name"], known["labels"])
            text = sanitize_public_text(intent.get("text"), MESSAGE_MAX_CHARS)
            if sender is None or text is None or not isinstance(turn.get("turnNumber"), int):
                continue
            messages.append(
                {
                    "label": sender,
                    "kind": "message",
                    "to": _get(known["by_player"], intent.get("recipient")),
                    "turn": turn["turnNumber"],
                    "text": text,
                }
            )
    return messages


def step_turns(replay: dict | None) -> dict:
    """Decision step -> game turn, from the finalized deal ledger."""
    ledger = _inline_json(replay or {}, "deal-ledger.json")
    return {
        entry["step"]: entry["turnNumber"]
        for entry in _dicts(ledger.get("decisionSteps"))
        if isinstance(entry.get("step"), int) and isinstance(entry.get("turnNumber"), int)
    }


def _line_turn(payload: dict, steps: dict, turns_per_step: int) -> int | None:
    for key in ("turn", "turnNumber"):
        if isinstance(payload.get(key), int):
            return payload[key]
    step = payload.get("decisionStep")
    if not isinstance(step, int) or step < 1:
        return None
    # The player counts post-spawn decisions from 1; the ledger counts the
    # server's steps from 0, the first at turn 400.
    return steps.get(step - 1, 400 + (step - 1) * turns_per_step)


def select_voices(
    dispatches: list[dict], messages: list[dict], moment_turns: list[int], labels: list[str], limit: int = MAX_VOICES
) -> list[dict]:
    """At most `limit` voices: dispatches spread over the game for every
    model, then the first message of each ordered pair, then messages near
    moments, then whatever room is left."""
    chosen: list[dict] = []
    ids: set = set()

    def take(items):
        for item in items:
            if len(chosen) >= limit:
                return
            if id(item) not in ids:
                ids.add(id(item))
                chosen.append(item)

    by_label: dict = {}
    for voice in sorted(dispatches, key=lambda v: v["turn"]):
        by_label.setdefault(voice["label"], []).append(voice)
    per_label = max(1, (limit * 3 // 5) // max(1, len(labels)))
    for label in labels:
        take(_spread(by_label.get(label, []), per_label))
    ordered = sorted(messages, key=lambda v: v["turn"])
    firsts, pairs = [], set()
    for message in ordered:
        if (message["label"], message["to"]) not in pairs:
            pairs.add((message["label"], message["to"]))
            firsts.append(message)
    take(_spread(firsts, max(0, limit - len(chosen))))
    if moment_turns:
        near = [
            (min(abs(m["turn"] - t) for t in moment_turns), m)
            for m in ordered
            if id(m) not in ids and min(abs(m["turn"] - t) for t in moment_turns) <= NEAR_MOMENT_TURNS
        ]
        take([m for _, m in sorted(near, key=lambda pair: pair[0])])
    rest = [v for v in sorted(dispatches, key=lambda v: v["turn"]) if id(v) not in ids]
    take(_spread(rest, max(0, limit - len(chosen))))
    rest = [m for m in ordered if id(m) not in ids]
    take(_spread(rest, max(0, limit - len(chosen))))
    return sorted(chosen, key=lambda v: (v["turn"], v["kind"] != "dispatch", v["label"]))


def assemble_game_record(
    config: dict,
    request_record: dict,
    episode: dict,
    replay: dict | None,
    seat_logs: dict,
) -> dict:
    """One contract-B line. `seat_logs` maps slot -> log text (None when the
    log could not be read)."""
    sides = [dict(side) for side in request_record["sides"]]
    front = request_record["front"]
    replay = replay or {}
    summary = standings_from_replay(replay, sides, config.get("timer_turns"))
    for side in sides:
        side["team"] = summary["engineTeam"].get(side["label"])
    known = summary["known"]
    replay_config = _obj(replay.get("config"))
    turns_per_step = int(_number(replay_config.get("turns_per_decision_step")) or 100)
    steps = step_turns(replay)

    parsed_by_slot = {slot: parse_seat_log(text) for slot, text in seat_logs.items() if isinstance(text, str)}
    prices = config.get("prices_per_million", {})
    telemetry = {}
    dispatches, said = [], []
    for side in sides:
        parsed = [parsed_by_slot[slot] for slot in side["slots"] if slot in parsed_by_slot]
        if not parsed:
            continue  # no readable log for this model: no telemetry rather than made-up numbers
        telemetry[side["label"]] = label_telemetry([seat_usage(p) for p in parsed], prices.get(side["model"]))
        for seat in parsed:
            for line in seat["dispatches"]:
                text = sanitize_public_text(line.get("text"), DISPATCH_MAX_CHARS)
                turn = _line_turn(line, steps, turns_per_step)
                if text and turn is not None:
                    dispatches.append(
                        {"label": side["label"], "kind": "dispatch", "to": None, "turn": turn, "text": text}
                    )
            for line in seat["says"]:
                text = sanitize_public_text(line.get("text"), MESSAGE_MAX_CHARS)
                turn = _line_turn(line, steps, turns_per_step)
                if line.get("accepted") is True and text and turn is not None:
                    to = _get(known["by_player"], line.get("toID")) or _label_for_name(
                        line.get("to"), known["by_name"], known["labels"]
                    )
                    said.append({"label": side["label"], "kind": "message", "to": to, "turn": turn, "text": text})
    # One copy of a repeated dispatch per model.
    unique, seen = [], set()
    for voice in sorted(dispatches, key=lambda v: v["turn"]):
        if (voice["label"], voice["text"]) not in seen:
            seen.add((voice["label"], voice["text"]))
            unique.append(voice)

    moments = moments_from_replay(replay, known, summary["standings"])
    # The game record is the authority on what was said; seat logs stand in
    # when the replay is missing.
    messages = messages_from_replay(replay, known) or said
    voices = select_voices(unique, messages, [m["turn"] for m in moments], [s["label"] for s in sides])

    replay_url = episode.get("replay_url")
    viewer_base = config.get("replay_viewer_base")
    viewer_url = (
        f"{viewer_base}#replay={urllib.parse.quote(replay_url, safe='')}"
        if replay_url and viewer_base and "<" not in viewer_base
        else None
    )
    return {
        "schemaVersion": 2,
        "season": config["season"],
        "format": "ffa",
        "experienceRequestId": request_record["request"]["id"],
        "episodeRequestId": episode.get("id"),
        "variantId": front["variant_id"],
        "map": front.get("map") or replay_config.get("map"),
        "mapSize": front.get("map_size") or replay_config.get("map_size") or "",
        "frontLabel": front["label"],
        "completedAt": episode.get("completed_at") or iso(utcnow()),
        "replayUrl": replay_url,
        "viewerUrl": viewer_url,
        "costUsd": episode.get("cost_usd"),
        "cycle": request_record["cycle"],
        "gameIndex": request_record["game_index"],
        "episodeIndex": request_record["episode_index"],
        "sides": sides,
        "winnerLabel": summary["winnerLabel"],
        "winType": summary["winType"],
        "standings": summary["standings"],
        "turnCount": summary["turnCount"],
        "decisionCount": summary["decisionCount"],
        "degradedCount": summary["degradedCount"],
        "telemetry": telemetry,
        "voices": voices,
        "moments": moments,
        "harness": harness_from_logs(list(parsed_by_slot.values()), config["harness"]),
        **({"test": True} if request_record.get("test") else {}),
    }


def llm_spend(game: dict, seat_cap: float) -> float:
    """What a recorded game's model calls cost, for the daily cap. A model
    without priced telemetry counts at its seats' cap."""
    total = 0.0
    for side in game["sides"]:
        usd = (game.get("telemetry") or {}).get(side["label"], {}).get("usd")
        total += usd if isinstance(usd, (int, float)) else seat_cap * len(side["slots"])
    return total


def fetch_public(url: str, timeout: float = 180.0) -> bytes:
    """GET a public URL (the replay on S3) with no Softmax credentials."""
    try:
        import httpx  # noqa: PLC0415 - httpx ships with coworld and brings certifi

        response = httpx.get(url, timeout=timeout, follow_redirects=True)
        response.raise_for_status()
        return response.content
    except ImportError:
        with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 - https replay URL
            return response.read()


def decode_replay(payload: bytes) -> dict:
    if payload[:2] == b"\x1f\x8b":
        payload = gzip.decompress(payload)
    elif payload[:1] == b"\x78":
        payload = zlib.decompress(payload)
    replay = json.loads(payload)
    if not isinstance(replay, dict):
        raise ValueError("replay is not a JSON object")
    return replay


# ---------------------------------------------------------------- scheduler
def new_state(now: dt.datetime) -> dict:
    return {
        "stateVersion": STATE_VERSION,
        "cursor": 0,
        "retry": [],
        "inflight": [],
        "spend": {},
        "games": 0,
        "slots": {},
        "credits_hold_until": None,
        "launch_now": None,
        "since": iso(now),
    }


class Scheduler:
    def __init__(self, config: dict, dry_run: bool, client=None, mode: str = "season"):
        self.config = config
        self.state_dir = Path(config["state_dir"])
        self.requests_dir = self.state_dir / "requests"
        self.state_path = self.state_dir / "state.json"
        self.launch_now_path = self.state_dir / "launch-now.json"
        self.state = load_json(self.state_path, None) or new_state(utcnow())
        for key, value in new_state(utcnow()).items():
            self.state.setdefault(key, value)
        self.dry_run = dry_run
        # "season" runs appointments; "launch_now" serves one launch-now and
        # exits once it has settled.
        self.mode = mode
        self.last_hold: str | None = None
        self.last_wait: str | None = None
        self._client = client

    @property
    def client(self):
        if self._client is None:
            from coworld.api_client import CoworldApiClient  # noqa: PLC0415 - tests import this module without coworld

            self._client = CoworldApiClient.from_login(server_url=SERVER)
        return self._client

    # ------------------------------------------------------------ budget
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
        hold = self.state.get("credits_hold_until")
        if hold:
            if utcnow() < parse_iso(hold):
                return False, f"credits exhausted: next refill at {hold}"
            self.state["credits_hold_until"] = None
        budget = self.budget()
        if budget is None:
            return False, "budget unreadable"
        remaining = float(budget.get("remaining_usd") or 0)
        if remaining < caps["min_remaining_usd"]:
            return False, f"coworld remaining {remaining:.2f} below floor {caps['min_remaining_usd']}"
        if budget.get("budget_status") not in (None, "ok"):
            return False, f"budget status {budget.get('budget_status')}"
        return True, f"remaining {remaining:.2f}, spent today {self.spent_today():.2f}"

    # ------------------------------------------------------------- games
    def request_body(self, plan: dict, spend_limit: float, key: str, test: bool) -> dict:
        front = plan["front"]
        number = plan["game_index"] + 1
        title = (
            f"Frontier S{self.config['season']} test: {front['label']}"
            if test
            else f"Frontier S{self.config['season']} #{number}: {front['label']}"
        )
        return {
            "coworld_id": self.config["coworld_id"],
            "variant_id": front["variant_id"],
            "roster": plan["roster"],
            "num_episodes": 1,
            # Seats are named "<model> 1" on the map, whichever account owns
            # the policies; episodeIndex rotates the spawn ballot.
            "game_config_overrides": plan["overrides"],
            "episode_player_llm_spend_limit_usd": spend_limit,
            "title": title[:50],
            "description": (
                f"Frontier season {self.config['season']}, {len(plan['sides'])}-model free-for-all: "
                + ", ".join(
                    f"{s['label']} ({s['model']}) slot {s['slots'][0]} pick {s['pickOrder']}" for s in plan["sides"]
                )
            )[:600],
            "notes": (
                f"frontier-ffa season={self.config['season']} cycle={plan['cycle']} game={plan['game_index']} "
                f"episodeIndex={plan['episode_index']} front={front['label']}" + (" test" if test else "")
            ),
            "idempotency_key": key,
        }

    def next_launch(self, launch_now: dict | None, now: dt.datetime) -> tuple[dict, dict]:
        """The plan and request body of the next launch: a season game to
        play again, else the next season game, or the pending test launch."""
        variant = (launch_now or {}).get("variant")
        test = variant is not None
        retry = None if test or not self.state["retry"] else self.state["retry"][0]
        plan = plan_game(self.config, retry["game_index"] if retry else self.state["cursor"], variant)
        caps = self.config["caps"]
        seat_cap = float(
            ((launch_now or {}).get("seat_spend_limit") if test else None)
            or (caps["test_per_seat_llm_usd"] if test else caps["per_seat_llm_usd"])
        )
        # The platform divides the request's limit evenly across its seats.
        spend_limit = round(seat_cap * len(plan["roster"]), 2)
        cow = self.config["coworld_id"][4:12]
        if test:
            key = f"ffa-{cow}-test-{now.strftime('%Y%m%dT%H%M')}-{variant}"
        else:
            # A replay needs its own key, or the platform hands back the
            # request that failed.
            key = f"ffa-{cow}-g{plan['game_index']}-{plan['front']['variant_id']}" + (
                f"-r{retry['attempt']}" if retry else ""
            )
        return plan, {
            "key": key,
            "test": test,
            "retry": retry,
            "seat_spend_limit": seat_cap,
            "spend_limit": spend_limit,
            "body": self.request_body(plan, spend_limit, key, test),
        }

    def launch(self, slot: dt.datetime | None, launch_now: dict | None) -> bool:
        now = utcnow()
        plan, launch = self.next_launch(launch_now, now)
        key = launch["key"]
        record = {
            "key": key,
            "test": launch["test"],
            "slot": slot_id(slot) if slot else None,
            "cycle": plan["cycle"],
            "game_index": plan["game_index"],
            "episode_index": plan["episode_index"],
            "front": plan["front"],
            "sides": plan["sides"],
            "retry_attempt": launch["retry"]["attempt"] if launch["retry"] else 0,
            "seat_spend_limit": launch["seat_spend_limit"],
            "spend_limit": launch["spend_limit"],
            "body": launch["body"],
            "created_at": iso(now),
        }
        try:
            response = self.client.create_experience_request(launch["body"]).model_dump(mode="json")
        except Exception as error:  # noqa: BLE001 - a refused request is a hold, not a crash
            message = str(error)
            if not any(mark in message for mark in ("(402)", "402 Payment Required", "experience credits")):
                raise
            self.state["credits_hold_until"] = iso(next_refill(message))
            self.save()
            log("credits_exhausted", until=self.state["credits_hold_until"], error=message[:300])
            return False
        record["request"] = {k: response.get(k) for k in ("id", "status", "created_at", "cost_preview")}
        self.requests_dir.mkdir(parents=True, exist_ok=True)
        save_json(self.requests_dir / f"{key}.json", record)
        self.state["inflight"].append(key)
        self.state["last_launch_at"] = iso(now)
        if slot is not None:
            self.state["slots"][slot_id(slot)] = {"status": "launched", "key": key}
        if launch_now is not None:
            self.state["launch_now"] = None
        if launch["retry"]:
            self.state["retry"].pop(0)
        elif not launch["test"]:
            self.state["cursor"] += 1
        self.save()
        log(
            "launched",
            key=key,
            request=response.get("id"),
            variant=plan["front"]["variant_id"],
            episode_index=plan["episode_index"],
            picks={s["label"]: s["pickOrder"] for s in plan["sides"]},
            test=launch["test"],
            retry=launch["retry"]["attempt"] if launch["retry"] else None,
            cost_preview=response.get("cost_preview"),
        )
        return True

    def poll(self) -> None:
        for key in list(self.state["inflight"]):
            path = self.requests_dir / f"{key}.json"
            record = load_json(path, None)
            if record is None or "request" not in record:
                self.state["inflight"].remove(key)
                self.save()
                continue
            if "episodes" not in record:
                try:
                    detail = self.client.get_experience_request(record["request"]["id"]).model_dump(mode="json")
                except Exception as error:  # noqa: BLE001
                    log("poll_failed", key=key, error=str(error)[:200])
                    continue
                status = detail.get("status")
                if status not in TERMINAL:
                    continue
                try:
                    episodes = self.client._get(f"/v2/experience-requests/{record['request']['id']}/episodes", list)
                except Exception as error:  # noqa: BLE001
                    log("episodes_failed", key=key, error=str(error)[:200])
                    continue
                record["request"]["status"] = status
                record["request"]["completed_at"] = detail.get("completed_at")
                record["detail"] = {k: detail.get(k) for k in ("completed_count", "failed_count", "error")}
                record["episodes"] = episodes
                save_json(path, record)
            try:
                done = self.settle(record)
            except Exception as error:  # noqa: BLE001 - one bad record must not stop the season
                # The record (and its attempt count) is saved below, so a
                # record that keeps failing is let go, not retried for ever.
                done = record.get("record_attempts", 0) >= int(self.config["record_retry_ticks"])
                log("settle_failed", key=key, error=str(error)[:300], gave_up=done)
            save_json(path, record)
            if done:
                self.state["inflight"].remove(key)
                self.save()

    def settle(self, record: dict) -> bool:
        """Record every completed episode of a finished request; False while
        its replay or seat logs are still worth waiting for."""
        recorded = record.setdefault("recorded", [])
        attempts = record.get("record_attempts", 0) + 1
        record["record_attempts"] = attempts
        final_attempt = attempts >= int(self.config["record_retry_ticks"])
        seat_cap = float(record.get("spend_limit") or 0) / max(1, len(record["body"]["roster"]))
        cost = 0.0
        for episode in record["episodes"]:
            episode_id = episode.get("id")
            if episode_id in recorded:
                continue
            if episode.get("status") != "completed":
                # An episode that did not complete may still have spent up to the cap.
                cost += float(episode.get("cost_usd") or 0) + float(record.get("spend_limit") or 0)
                recorded.append(episode_id)
                log(
                    "episode_not_completed",
                    key=record["key"],
                    episode=episode_id,
                    status=episode.get("status"),
                    error=str(episode.get("error"))[:200],
                )
                continue
            replay = self.fetch_replay(episode.get("replay_url"))
            seat_logs = self.seat_logs(episode_id, record)
            if (replay is None or not any(seat_logs.values())) and not final_attempt:
                log(
                    "record_waiting",
                    key=record["key"],
                    replay=replay is not None,
                    seat_logs=sum(1 for v in seat_logs.values() if v),
                    attempt=attempts,
                )
                self.add_spend(cost)
                return False
            if replay is None:
                results = self.results_artifact(episode_id)
                replay = {"results": results} if results else None
            game = self.build_game(record, episode, replay, seat_logs)
            cost += float(episode.get("cost_usd") or 0) + llm_spend(game, seat_cap)
            self.append_game(game, test=bool(record.get("test")))
            recorded.append(episode_id)
            unavailable = unavailable_labels(replay, game["sides"])
            if unavailable:
                log("seats_unavailable", key=record["key"], episode=episode_id, labels=unavailable)
            else:
                record["fair_games"] = record.get("fair_games", 0) + 1
            if not record.get("test"):
                self.state["games"] += 1
        self.add_spend(cost)
        if not record.get("test") and not record.get("fair_games"):
            self.replay_later(record)
        log("settled", key=record["key"], status=record["request"].get("status"), games=self.state["games"])
        return True

    def build_game(self, record: dict, episode: dict, replay: dict | None, seat_logs: dict) -> dict:
        """The game's record, thinner and thinner until one can be built: a
        replay or seat log in a shape nobody expected loses its details,
        never the game."""
        error = None
        for use_replay, use_logs in ((replay, seat_logs), (None, seat_logs), (None, {})):
            try:
                return assemble_game_record(self.config, record, episode, use_replay, use_logs)
            except Exception as failure:  # noqa: BLE001
                error = failure
                log("record_build_failed", key=record["key"], error=str(failure)[:300])
        raise error

    def replay_later(self, record: dict) -> None:
        """Queue a season game that produced no fair result, so its block of
        N games still gives every model each pick once."""
        attempt = int(record.get("retry_attempt") or 0) + 1
        if attempt > int(self.config["max_game_retries"]):
            log("game_abandoned", key=record["key"], game_index=record["game_index"], attempts=attempt - 1)
            return
        self.state["retry"].append({"game_index": record["game_index"], "attempt": attempt})
        log("game_queued_again", key=record["key"], game_index=record["game_index"], attempt=attempt)

    def add_spend(self, cost: float) -> None:
        if cost:
            day = self.today()
            self.state["spend"][day] = round(float(self.state["spend"].get(day, 0.0)) + cost, 6)

    def fetch_replay(self, replay_url) -> dict | None:
        if not isinstance(replay_url, str) or not replay_url.startswith("https://"):
            return None
        try:
            return decode_replay(fetch_public(replay_url))
        except Exception as error:  # noqa: BLE001 - a missing replay makes a thinner record
            log("replay_unreadable", url=replay_url, error=str(error)[:200])
            return None

    def seat_logs(self, episode_request_id: str, record: dict) -> dict:
        # The policy a seat ran is the one the request seated there, which
        # may be older than the config's current version.
        policy_of_slot = {entry["slot"]: entry["player"]["policy_ref"] for entry in record["body"]["roster"]}
        logs = {}
        for slot, policy in sorted(policy_of_slot.items()):
            try:
                logs[slot] = decode_policy_log(
                    self.client.get_bytes(f"/v2/episode-requests/{episode_request_id}/{policy}/policy-logs/{slot}")
                )
            except Exception as error:  # noqa: BLE001
                log("seat_log_unreadable", episode=episode_request_id, slot=slot, error=str(error)[:120])
                logs[slot] = None
        return logs

    def results_artifact(self, episode_request_id: str) -> dict | None:
        try:
            return json.loads(self.client.get_bytes(f"/v2/episode-requests/{episode_request_id}/artifacts/results"))
        except Exception as error:  # noqa: BLE001
            log("results_artifact_failed", episode=episode_request_id, error=str(error)[:200])
            return None

    def append_game(self, game: dict, test: bool) -> None:
        games_path = Path(self.config["test_games_path" if test else "games_path"])
        games_path.parent.mkdir(parents=True, exist_ok=True)
        with games_path.open("a") as handle:
            handle.write(json.dumps(game, ensure_ascii=False) + "\n")
        log(
            "game_recorded",
            episode=game["episodeRequestId"],
            map=game["map"],
            winner=game["winnerLabel"],
            win_type=game["winType"],
            voices=len(game["voices"]),
            moments=len(game["moments"]),
            test=test,
        )

    def save(self) -> None:
        if self.dry_run:
            return
        self.state_dir.mkdir(parents=True, exist_ok=True)
        save_json(self.state_path, self.state)

    # ------------------------------------------------------- launch-now
    def queue_launch_now(self, variant: str | None, seat_spend_limit: float | None) -> None:
        if variant is not None:
            plan_game(self.config, 0, variant)  # an unknown variant fails here, not at launch
        self.state["launch_now"] = {
            "variant": variant,
            "seat_spend_limit": seat_spend_limit,
            "requested_at": iso(utcnow()),
        }
        self.save()
        log("launch_now_queued", variant=variant, seat_spend_limit=seat_spend_limit)

    def take_queued_request(self) -> None:
        """A launch-now another process left for this running scheduler."""
        request = load_json(self.launch_now_path, None)
        if request is None:
            return
        self.launch_now_path.unlink(missing_ok=True)
        self.state["launch_now"] = request
        self.save()
        log("launch_now_received", variant=request.get("variant"))

    def pending_launch_now(self, now: dt.datetime) -> dict | None:
        request = self.state.get("launch_now")
        if not request:
            return None
        ttl = dt.timedelta(minutes=float(self.config["launch_now_ttl_minutes"]))
        if now >= parse_iso(request["requested_at"]) + ttl:
            log("launch_now_expired", variant=request.get("variant"), why=self.last_hold)
            self.state["launch_now"] = None
            self.save()
            return None
        return request

    def idle(self) -> bool:
        return not self.state["inflight"] and not self.state.get("launch_now")

    # ------------------------------------------------------------- loop
    def mark_missed(self, now: dt.datetime) -> None:
        """Skip, never make up, appointments whose window closed unused."""
        schedule = self.config["schedule"]
        missed = missed_slots(
            now,
            schedule["times_utc"],
            schedule["slot_grace_minutes"],
            self.state["slots"],
            parse_iso(self.state["since"]),
        )
        for start in missed:
            why = "a game was still running" if self.state["inflight"] else (self.last_hold or "scheduler not running")
            self.state["slots"][slot_id(start)] = {"status": "missed", "why": why}
            log("slot_missed", slot=slot_id(start), why=why)
        cutoff = slot_id(now - dt.timedelta(days=14))
        kept = {k: v for k, v in self.state["slots"].items() if k >= cutoff}
        if missed or len(kept) != len(self.state["slots"]):
            self.state["slots"] = kept
            self.save()

    def tick(self) -> None:
        now = utcnow()
        self.take_queued_request()
        self.poll()
        schedule = self.config["schedule"]
        if self.mode == "season":
            self.mark_missed(now)
        if self.state["inflight"]:
            return  # never two at once
        if self.state["games"] >= self.config.get("max_games", 10**9):
            log("max_games_reached")
            return
        slot = None
        if self.mode == "season":
            slot = due_slot(now, schedule["times_utc"], schedule["slot_grace_minutes"], self.state["slots"])
        launch_now = None if slot is not None else self.pending_launch_now(now)
        if slot is None and launch_now is None:
            if self.mode == "season":
                upcoming = iso(next_slot(now, schedule["times_utc"]))
                if upcoming != self.last_wait:
                    log("waiting", next_slot=upcoming, cursor=self.state["cursor"])
                self.last_wait = upcoming
            return
        allowed, why = self.may_launch()
        if not allowed:
            # One line per reason, not one per minute.
            if why != self.last_hold:
                log("hold", why=why, slot=slot_id(slot) if slot else None)
            self.last_hold = why
            return
        self.last_hold = None
        log("launch_window", why=why, slot=slot_id(slot) if slot else None, launch_now=launch_now is not None)
        self.launch(slot, launch_now)

    def dry_run_report(self, launch_now: dict | None) -> None:
        """What the next launch would be, touching nothing on disk."""
        now = utcnow()
        schedule = self.config["schedule"]
        slot = due_slot(now, schedule["times_utc"], schedule["slot_grace_minutes"], self.state["slots"])
        plan, launch = self.next_launch(launch_now, now)
        log(
            "dry_run",
            state_dir=str(self.state_dir),
            state_exists=self.state_path.exists(),
            cursor=self.state["cursor"],
            inflight=self.state["inflight"],
            due_slot=slot_id(slot) if slot else None,
            next_slot=iso(next_slot(now, schedule["times_utc"])),
            launch_now=launch_now,
        )
        log(
            "dry_run_launch",
            key=launch["key"],
            test=launch["test"],
            variant=plan["front"]["variant_id"],
            cycle=plan["cycle"],
            game_index=plan["game_index"],
            episode_index=plan["episode_index"],
            sides=[(s["label"], s["slots"][0], s["pickOrder"]) for s in plan["sides"]],
            body=launch["body"],
        )
        allowed, why = self.may_launch()
        log("dry_run_budget", allowed=allowed, why=why)


def acquire_lock(state_dir: Path):
    """An exclusive lock on the state dir, or None while another scheduler
    holds it."""
    import fcntl  # noqa: PLC0415 - POSIX only, like the launchd job

    state_dir.mkdir(parents=True, exist_ok=True)
    handle = (state_dir / "scheduler.lock").open("a+")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true", help="one tick, then exit")
    parser.add_argument("--dry-run", action="store_true", help="show the next launch; create and write nothing")
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument(
        "--launch-now", action="store_true", help="launch the next game now instead of at an appointment"
    )
    parser.add_argument("--variant", help="with --launch-now: a test launch on this variant (not a season game)")
    parser.add_argument(
        "--seat-spend-limit",
        type=float,
        help="with --variant: each seat's LLM spend limit in USD for the test launch (season games use the config's)",
    )
    args = parser.parse_args(argv)
    if args.variant and not args.launch_now:
        parser.error("--variant needs --launch-now")
    if args.seat_spend_limit is not None and not args.variant:
        # A season game on a different cap would not be comparable.
        parser.error("--seat-spend-limit is for test launches: it needs --launch-now --variant")
    if args.seat_spend_limit is not None and not args.seat_spend_limit > 0:
        parser.error("--seat-spend-limit must be above 0")
    config_path = Path(args.config).expanduser().resolve()
    config = load_config(json.loads(config_path.read_text()), config_path)
    state_dir = Path(config["state_dir"])
    launch_now = {"variant": args.variant, "seat_spend_limit": args.seat_spend_limit} if args.launch_now else None

    if args.dry_run:
        scheduler = Scheduler(config, dry_run=True)
        if launch_now and args.variant:
            plan_game(config, 0, args.variant)
        scheduler.dry_run_report(launch_now)
        return 0

    placeholders = [config["coworld_id"]] + [team["policy_ref"] for team in config["teams"]]
    if any("REPLACE" in value for value in placeholders):
        log("config_has_placeholders", config=str(config_path))
        return 64

    lock = acquire_lock(state_dir)
    if lock is None:
        if launch_now is None:
            log("already_running", state_dir=str(state_dir))
            return 1
        if args.variant:
            plan_game(config, 0, args.variant)
        save_json(state_dir / "launch-now.json", {**launch_now, "requested_at": iso(utcnow())})
        log("launch_now_left_for_running_scheduler", variant=args.variant)
        return 0

    scheduler = Scheduler(config, dry_run=False, mode="launch_now" if launch_now else "season")
    if launch_now is not None:
        scheduler.queue_launch_now(args.variant, args.seat_spend_limit)
    log(
        "start",
        config=str(config_path),
        state_dir=str(state_dir),
        mode=scheduler.mode,
        cursor=scheduler.state["cursor"],
        games=scheduler.state["games"],
        times_utc=config["schedule"]["times_utc"],
    )
    while True:
        try:
            scheduler.tick()
        except KeyboardInterrupt:
            return 0
        except Exception as error:  # noqa: BLE001 - keep the loop alive, say what broke
            log("tick_failed", error=str(error)[:300])
        if args.once or (scheduler.mode == "launch_now" and scheduler.idle()):
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
