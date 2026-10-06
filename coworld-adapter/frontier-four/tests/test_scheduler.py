"""Unit tests for the Season 2 Frontier scheduler.

Run from coworld-adapter/frontier-four:  python3 -m unittest discover -s tests
No network and no coworld package needed: the hosted client is faked.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import sys
import tempfile
import unicodedata
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import scheduler as s  # noqa: E402

FIXTURES = HERE / "fixtures"
EXAMPLE = HERE.parent / "frontier-ffa.example.json"
MANIFEST = HERE.parent.parent / "coworld" / "coworld_manifest_frontier_ffa.json"
UTC = dt.timezone.utc

# buildAgentSpawnPriority (src/server/agents/AgentSpawnSelection.ts) run
# through competitiveSeatSpecs/labelledTeamSeatPlayers for the five seats,
# episodeIndex 0..6. Slot order does not change it.
ENGINE_PRIORITY = {
    0: ["Astra 1", "Fable 1", "Gemini 1", "Grok 1", "Opus 1"],
    1: ["Fable 1", "Gemini 1", "Grok 1", "Opus 1", "Astra 1"],
    2: ["Gemini 1", "Grok 1", "Opus 1", "Astra 1", "Fable 1"],
    3: ["Grok 1", "Opus 1", "Astra 1", "Fable 1", "Gemini 1"],
    4: ["Opus 1", "Astra 1", "Fable 1", "Gemini 1", "Grok 1"],
    5: ["Astra 1", "Fable 1", "Gemini 1", "Grok 1", "Opus 1"],
    6: ["Fable 1", "Gemini 1", "Grok 1", "Opus 1", "Astra 1"],
}

CONTRACT_B_KEYS = {
    "schemaVersion",
    "season",
    "format",
    "experienceRequestId",
    "episodeRequestId",
    "variantId",
    "map",
    "mapSize",
    "frontLabel",
    "completedAt",
    "replayUrl",
    "viewerUrl",
    "costUsd",
    "cycle",
    "gameIndex",
    "episodeIndex",
    "sides",
    "winnerLabel",
    "winType",
    "standings",
    "turnCount",
    "decisionCount",
    "degradedCount",
    "telemetry",
    "voices",
    "moments",
    "harness",
}
TELEMETRY_KEYS = {
    "plans",
    "planFailures",
    "timeouts",
    "latencyMsMedian",
    "latencyMsP90",
    "outputTokensMedian",
    "inputTokensMedian",
    "reasoningTokensMedian",
    "usd",
    "capped",
}


def example_config(state_dir: Path | None = None, **overrides) -> dict:
    raw = json.loads(EXAMPLE.read_text())
    if state_dir is not None:
        raw["state_dir"] = str(state_dir)
        raw["games_path"] = str(state_dir / "games.jsonl")
        raw["test_games_path"] = str(state_dir / "test-games.jsonl")
    for index, team in enumerate(raw["teams"]):
        team["policy_ref"] = f"policy-{team['label'].lower()}-{index}"
    raw["coworld_id"] = "cow_0123456789abcdef"
    raw.update(overrides)
    return s.load_config(raw, Path(state_dir or "/tmp") / "frontier-ffa.json")


def tiny_config(teams: int, fronts: int) -> dict:
    labels = ["Astra", "Fable", "Opus", "Gemini", "Grok", "Nova", "Kite", "Moss"][:teams]
    return s.load_config(
        {
            "coworld_id": "cow_x",
            "budget_coworld_name": "proxywar",
            "teams": [{"label": label, "model": f"m/{label}", "policy_ref": f"p{label}"} for label in labels],
            "fronts": [{"label": f"F{i}", "map": f"M{i}", "variant_id": f"v{i}"} for i in range(fronts)],
        },
        Path("/tmp/frontier-test/config.json"),
    )


def first_picker(plan: dict) -> str:
    return next(side["label"] for side in plan["sides"] if side["pickOrder"] == 1)


def ffa_replay(
    seats: list[dict], winner_team=None, turn_count=24400, snapshots=None, events=None, intents=None, ledger=None
) -> dict:
    """A small five-seat replay in the hosted shape. `seats` is slot order."""
    replay = {
        "config": {"map": "World", "map_size": "Compact", "turns_per_decision_step": 100},
        "results": {
            "winner_team": winner_team,
            "turn_count": turn_count,
            "decision_count": 1200,
            "degraded_count": 4,
            "players": [
                {
                    "slot": i,
                    "name": f"{seat['label']} 1",
                    "team": seat["team"],
                    "tiles_owned": seat["tiles"],
                    "is_alive": seat["alive"],
                }
                for i, seat in enumerate(seats)
            ],
        },
        "finalState": {
            "winnerTeam": winner_team,
            "turnCount": turn_count,
            "players": [
                {
                    "username": f"{seat['label']} 1",
                    "playerID": seat["pid"],
                    "team": seat["team"],
                    "isAlive": seat["alive"],
                    "tilesOwned": seat["tiles"],
                }
                for seat in seats
            ],
        },
        "spectatorReplay": {"snapshots": snapshots or []},
        "inlineRunArtifacts": {},
    }
    if events is not None:
        replay["inlineRunArtifacts"]["spectator-telemetry.json"] = json.dumps({"events": events})
    if intents is not None:
        replay["inlineRunArtifacts"]["game-record.json"] = json.dumps(
            {
                "info": {"players": [{"clientID": seat["cid"], "username": f"{seat['label']} 1"} for seat in seats]},
                "turns": intents,
            }
        )
    if ledger is not None:
        replay["inlineRunArtifacts"]["deal-ledger.json"] = json.dumps({"decisionSteps": ledger})
    return replay


def seats_for(plan: dict, tiles: dict, alive: dict | None = None) -> list[dict]:
    teams = ["Red", "Blue", "Yellow", "Green", "Purple"]
    alive = alive or {}
    labels = plan["overrides"]["team_labels"]
    return [
        {
            "label": label,
            "team": teams[slot],
            "tiles": tiles.get(label, 0),
            "alive": alive.get(label, tiles.get(label, 0) > 0),
            "pid": f"pid{label}",
            "cid": f"cid{label}",
        }
        for slot, label in enumerate(labels)
    ]


def request_record(plan: dict, test: bool = False) -> dict:
    return {
        "key": "k",
        "test": test,
        "cycle": plan["cycle"],
        "game_index": plan["game_index"],
        "episode_index": plan["episode_index"],
        "front": plan["front"],
        "sides": plan["sides"],
        "request": {"id": "xreq_1"},
        "body": {"roster": plan["roster"]},
    }


def usage(**fields) -> str:
    return "PROXYWAR_LLM_USAGE " + json.dumps(fields)


# ------------------------------------------------------------------ rotation
class RotationTest(unittest.TestCase):
    def test_spawn_priority_matches_the_engine(self):
        usernames = ["Gemini 1", "Opus 1", "Astra 1", "Grok 1", "Fable 1"]
        for episode_index, expected in ENGINE_PRIORITY.items():
            self.assertEqual(s.spawn_priority(usernames, episode_index), expected)

    def test_code_unit_order_puts_capitals_before_lowercase(self):
        # JavaScript string order, not locale order.
        self.assertEqual(s.spawn_priority(["alpha 1", "Zed 1", "Beta 1"], 0), ["Beta 1", "Zed 1", "alpha 1"])

    def test_plan_records_the_engine_pick_order(self):
        config = example_config()
        for game_index in range(12):
            plan = s.plan_game(config, game_index)
            expected = ENGINE_PRIORITY[plan["episode_index"] % 5]
            for side in plan["sides"]:
                self.assertEqual(side["pickOrder"], expected.index(f"{side['label']} 1") + 1)

    def test_every_block_of_n_games_gives_each_model_each_pick_once(self):
        config = example_config()
        labels = {team["label"] for team in config["teams"]}
        for block in range(60):
            plans = [s.plan_game(config, block * 5 + i) for i in range(5)]
            self.assertEqual({first_picker(plan) for plan in plans}, labels, block)
            for label in labels:
                picks = sorted(side["pickOrder"] for plan in plans for side in plan["sides"] if side["label"] == label)
                self.assertEqual(picks, [1, 2, 3, 4, 5])

    def test_each_front_sees_every_first_picker_over_n_cycles(self):
        for teams in (2, 3, 4, 5, 6, 8):
            for fronts in (1, 2, 3, 4, 5, 6, 10, 11, 12, 15):
                config = tiny_config(teams, fronts)
                labels = {team["label"] for team in config["teams"]}
                for front in range(fronts):
                    for start in (0, teams, 2 * teams):
                        cycles = range(start, start + teams)
                        seen = {first_picker(s.plan_game(config, c * fronts + front)) for c in cycles}
                        self.assertEqual(seen, labels, (teams, fronts, front, start))
                for block in range(3 * fronts):
                    seen = {first_picker(s.plan_game(config, block * teams + i)) for i in range(teams)}
                    self.assertEqual(seen, labels, (teams, fronts, block))

    def test_episode_index_is_increasing_and_unique(self):
        indices = [s.episode_index_for(g, 5, 10) for g in range(200)]
        self.assertEqual(indices, sorted(set(indices)))
        self.assertEqual(indices[:12], list(range(10)) + [11, 12])

    def test_slots_rotate_every_block_and_match_the_labels_sent(self):
        config = example_config()
        for block in range(10):
            plans = [s.plan_game(config, block * 5 + i) for i in range(5)]
            for label in ("Astra", "Grok"):
                slots = sorted(side["slots"][0] for plan in plans for side in plan["sides"] if side["label"] == label)
                self.assertEqual(slots, [0, 1, 2, 3, 4])
        for game_index in range(25):
            plan = s.plan_game(config, game_index)
            overrides = plan["overrides"]
            self.assertEqual(overrides["team_count"], 5)
            self.assertEqual(overrides["seat_teams"], [0, 1, 2, 3, 4])
            self.assertEqual(overrides["episodeIndex"], plan["episode_index"])
            policy = {team["label"]: team["policy_ref"] for team in config["teams"]}
            for side in plan["sides"]:
                slot = side["slots"][0]
                self.assertEqual(overrides["team_labels"][slot], side["label"])
                self.assertEqual(plan["roster"][slot], {"slot": slot, "player": {"policy_ref": policy[side["label"]]}})

    def test_slot_order_is_not_pick_order(self):
        config = example_config()
        same = 0
        for game_index in range(25):
            plan = s.plan_game(config, game_index)
            same += all(side["slots"][0] == side["pickOrder"] - 1 for side in plan["sides"])
        self.assertLess(same, 25)

    def test_fronts_cycle_in_config_order(self):
        config = example_config()
        plans = [s.plan_game(config, g) for g in range(23)]
        self.assertEqual([p["front"]["variant_id"] for p in plans[:11]], [f["variant_id"] for f in config["fronts"]])
        self.assertEqual([p["cycle"] for p in (plans[0], plans[10], plans[11], plans[22])], [1, 1, 2, 3])

    def test_test_variant_uses_the_next_games_rotation(self):
        config = example_config()
        plan = s.plan_game(config, 7, "ffa5-canary")
        self.assertEqual(plan["front"]["map"], "World")
        self.assertEqual(plan["sides"], s.plan_game(config, 7)["sides"])
        with self.assertRaises(ValueError):
            s.plan_game(config, 7, "ffa5-nowhere")


# -------------------------------------------------------------------- config
class ConfigTest(unittest.TestCase):
    def test_example_config_matches_the_manifest(self):
        config = example_config()
        manifest = json.loads(MANIFEST.read_text())
        variants = {variant["id"]: variant for variant in manifest["variants"]}
        self.assertEqual(manifest["game"]["name"], "proxywar-frontier-ffa")
        self.assertEqual(len(config["fronts"]), 11)
        for front in config["fronts"] + config["test_variants"]:
            game = variants[front["variant_id"]]["game_config"]
            self.assertEqual((game["map"], game["map_size"]), (front["map"], front["map_size"]))
            self.assertEqual(game["num_agents"], len(config["teams"]))
            self.assertEqual(game["team_count"], len(config["teams"]))
            self.assertEqual(game["seat_teams"], list(range(len(config["teams"]))))
        self.assertEqual(config["caps"]["per_seat_llm_usd"], 5.0)
        self.assertEqual(config["caps"]["test_per_seat_llm_usd"], 1.0)
        self.assertEqual(config["schedule"]["times_utc"], ["13:00", "19:00"])
        self.assertEqual(
            config["prices_per_million"]["anthropic/claude-opus-5.5"], {"input": 4, "output": 20, "cache_read": 0.4}
        )
        self.assertEqual(config["season"], 2)

    def test_example_paths_expand_into_home(self):
        config = s.load_config(json.loads(EXAMPLE.read_text()), Path("/tmp/x.json"))
        home = str(Path.home())
        for key in ("state_dir", "games_path", "test_games_path"):
            self.assertTrue(config[key].startswith(home), config[key])
        self.assertTrue(config["games_path"].endswith("frontier-ffa/frontier-ffa-games.jsonl"))

    def test_refuses_paths_on_volumes(self):
        raw = json.loads(EXAMPLE.read_text())
        for key in ("state_dir", "games_path", "test_games_path"):
            bad = dict(raw, **{key: "/Volumes/Crucial X9/ProxyWar/games.jsonl"})
            with self.assertRaisesRegex(ValueError, "/Volumes"):
                s.load_config(bad, Path("/tmp/x.json"))
        with self.assertRaisesRegex(ValueError, "Volumes"):
            s.load_config(dict(raw, state_dir="/volumes/x"), Path("/tmp/x.json"))

    def test_rejects_labels_the_engine_would_rename_and_publish_hooks(self):
        raw = json.loads(EXAMPLE.read_text())
        for label in ("Grok-4", "A" * 25, "", " Opus", "Opus "):
            bad = json.loads(json.dumps(raw))
            bad["teams"][0]["label"] = label
            with self.assertRaises(ValueError):
                s.load_config(bad, Path("/tmp/x.json"))
        dup = json.loads(json.dumps(raw))
        dup["teams"][1]["label"] = dup["teams"][0]["label"]
        with self.assertRaises(ValueError):
            s.load_config(dup, Path("/tmp/x.json"))
        with self.assertRaises(ValueError):
            s.load_config(dict(raw, publish={"argv": ["node"]}), Path("/tmp/x.json"))
        with self.assertRaises(ValueError):
            s.load_config(dict(raw, schedule={"times_utc": ["25:00"]}), Path("/tmp/x.json"))

    def test_spend_cap_is_per_seat_and_must_not_bind(self):
        raw = json.loads(EXAMPLE.read_text())
        for old in ("per_game_llm_usd", "test_llm_usd"):
            with self.assertRaisesRegex(ValueError, "per_seat_llm_usd"):
                s.load_config(dict(raw, caps={old: 8.0}), Path("/tmp/x.json"))
        # 17 Fable plans of 8.5k input and 3000 output tokens can cost 4.00.
        self.assertAlmostEqual(
            s.seat_spend_bound(raw["prices_per_million"]["anthropic/claude-fable-5.1"], s.DEFAULT_HARNESS), 3.995
        )
        # Season 1's $2 a seat would stop the two expensive models, as it did.
        with self.assertRaisesRegex(ValueError, r"could stop Astra, Fable mid-game: .* 4\.00 a seat"):
            s.load_config(dict(raw, caps={"per_seat_llm_usd": 2.0}), Path("/tmp/x.json"))
        with self.assertRaisesRegex(ValueError, "could stop Astra, Fable mid-game"):
            s.load_config(dict(raw, harness={"plansPerSeat": 30}), Path("/tmp/x.json"))
        config = s.load_config(dict(raw, caps={}), Path("/tmp/x.json"))
        # By default a day fits both appointments at the cap plus a canary.
        self.assertEqual(config["caps"]["daily_usd"], 5 * (5.0 * 2 + 1.0))

    def test_roster_size_comes_from_the_config(self):
        config = tiny_config(3, 4)
        plan = s.plan_game(config, 0)
        self.assertEqual(plan["overrides"]["team_count"], 3)
        self.assertEqual(len(plan["roster"]), 3)


# ------------------------------------------------------------------ schedule
class ScheduleTest(unittest.TestCase):
    times = ["19:00", "13:00"]

    def at(self, text: str) -> dt.datetime:
        return s.parse_iso(text)

    def test_due_slot_opens_at_the_time_and_closes_after_the_grace(self):
        self.assertIsNone(s.due_slot(self.at("2026-10-07T12:59:00Z"), self.times, 30, {}))
        self.assertEqual(
            s.slot_id(s.due_slot(self.at("2026-10-07T13:00:00Z"), self.times, 30, {})), "2026-10-07T13:00Z"
        )
        self.assertEqual(
            s.slot_id(s.due_slot(self.at("2026-10-07T13:29:59Z"), self.times, 30, {})), "2026-10-07T13:00Z"
        )
        self.assertIsNone(s.due_slot(self.at("2026-10-07T13:30:00Z"), self.times, 30, {}))
        self.assertEqual(
            s.slot_id(s.due_slot(self.at("2026-10-07T19:10:00Z"), self.times, 30, {})), "2026-10-07T19:00Z"
        )

    def test_a_used_slot_is_not_due_again(self):
        taken = {"2026-10-07T13:00Z": {"status": "launched"}}
        self.assertIsNone(s.due_slot(self.at("2026-10-07T13:05:00Z"), self.times, 30, taken))

    def test_next_slot_rolls_over_midnight(self):
        self.assertEqual(s.iso(s.next_slot(self.at("2026-10-07T19:00:00Z"), self.times)), "2026-10-08T13:00:00Z")
        self.assertEqual(s.iso(s.next_slot(self.at("2026-10-07T12:00:00Z"), self.times)), "2026-10-07T13:00:00Z")

    def test_missed_slots_since_the_season_start_only(self):
        since = self.at("2026-10-07T12:00:00Z")
        missed = s.missed_slots(self.at("2026-10-08T14:00:00Z"), self.times, 30, {"2026-10-07T19:00Z": {}}, since)
        self.assertEqual([s.slot_id(m) for m in missed], ["2026-10-07T13:00Z", "2026-10-08T13:00Z"])

    def test_times_are_validated_and_sorted(self):
        self.assertEqual(s.parse_times(["19:00", "9:05", "19:00"]), [(9, 5), (19, 0)])
        for bad in (["24:00"], ["12:60"], ["noon"], []):
            with self.assertRaises(ValueError):
                s.parse_times(bad)

    def test_next_refill_reads_the_refusal(self):
        now = self.at("2026-10-07T13:00:00Z")
        self.assertEqual(
            s.iso(s.next_refill("credits exhausted; next refill 2026-10-08T00:00:00Z.", now)), "2026-10-08T00:00:00Z"
        )
        self.assertEqual(s.iso(s.next_refill("402 without a time", now)), "2026-10-08T00:00:00Z")


# ---------------------------------------------------------------- sanitizing
class SanitizeTest(unittest.TestCase):
    def test_strips_urls_handles_and_control_characters(self):
        text = "Visit https://evil.example/x?y=1 or www.evil.example now @grok_bot!\x07\u202eok\n\tthen"
        self.assertEqual(s.sanitize_public_text(text, 140), "Visit or now ! ok then")

    def test_collapses_whitespace_and_drops_empty(self):
        self.assertEqual(s.sanitize_public_text("  hold   the  line  ", 140), "hold the line")
        self.assertEqual(s.sanitize_public_text("\U0001f525", 140), "\U0001f525")
        for value in ("", "   ", "https://x.example", "@someone", "\x00\x01", "!!! ...", None, 42):
            self.assertIsNone(s.sanitize_public_text(value, 140))

    def test_caps_length_on_a_word_boundary(self):
        text = "word " * 100
        dispatch = s.sanitize_public_text(text, s.DISPATCH_MAX_CHARS)
        message = s.sanitize_public_text(text, s.MESSAGE_MAX_CHARS)
        self.assertLessEqual(len(dispatch), 140)
        self.assertLessEqual(len(message), 280)
        self.assertTrue(dispatch.endswith("word..."))
        self.assertEqual(s.sanitize_public_text("x" * 300, 140), "x" * 137 + "...")

    def test_cut_text_stays_within_the_limit_after_the_publishers_nfkc(self):
        # The publisher normalises with NFKC and drops anything longer than
        # the limit, so a cut line must still fit afterwards.
        for text in ("x" * 300, "\u6211\u4eec" * 100, "a" * 138 + " " + "b" * 20, "\uff21" * 200, "word " * 100):
            for limit in (s.DISPATCH_MAX_CHARS, s.MESSAGE_MAX_CHARS):
                out = s.sanitize_public_text(text, limit)
                self.assertIsNotNone(out, text[:10])
                self.assertLessEqual(len(unicodedata.normalize("NFKC", out)), limit)
                self.assertEqual(unicodedata.normalize("NFKC", out), out)

    def test_links_split_by_invisible_characters_are_still_links(self):
        for text in (
            "Join me at www\u200b.warloot.shop/x today",
            "ht\u200btps\u200b://warloot.shop/x today",
            "Join me at w\u2060ww.warloot.shop today",
            "\ufeffhttps://warloot.shop/x today",
            "today \u770bwww.warloot.shop/x",
            "today warloot.shop/x",
            "today warloot.com",
            "today \uff57\uff57\uff57.warloot.shop",  # full-width letters fold to www under NFKC
        ):
            out = s.sanitize_public_text(text, 140)
            self.assertIsNotNone(out, text)
            self.assertNotIn("warloot", out, text)
            self.assertIn("today", out, text)

    def test_handles_lose_their_dots_like_the_publishers(self):
        self.assertEqual(s.sanitize_public_text("ask @grok.bot now", 140), "ask now")

    def test_is_idempotent(self):
        for text in (
            "plain words",
            "a" * 500,
            "see http://x and @y",
            "mixed\u200b zero width",
            "x.company " * 40,
            "\u2026" * 200,
        ):
            once = s.sanitize_public_text(text, 140)
            self.assertEqual(s.sanitize_public_text(once, 140), once)


# ----------------------------------------------------------------- seat logs
class SeatLogTest(unittest.TestCase):
    def test_season_one_log(self):
        parsed = s.parse_seat_log((FIXTURES / "season1-africa-slot02-policy-log.txt").read_text())
        seat = s.seat_usage(parsed)
        self.assertEqual(seat["plans"], 26)
        self.assertEqual(seat["planFailures"], 0)
        self.assertEqual(len(seat["latencyMs"]), 26)
        self.assertEqual(seat["tokens"], {"input": 134373, "cached": 26800, "output": 3773})
        telemetry = s.label_telemetry([seat], {"input": 10, "output": 50, "cache_read": 1})
        self.assertEqual(set(telemetry), TELEMETRY_KEYS)
        expected = ((134373 - 26800) * 10 + 26800 * 1 + 3773 * 50) / 1e6
        self.assertAlmostEqual(telemetry["usd"], round(expected, 4))
        self.assertIsNone(telemetry["reasoningTokensMedian"])
        self.assertFalse(telemetry["capped"])

    def test_contract_a_log(self):
        lines = [
            "connected to match (model=x-ai/grok-4.7, endpoint=sidecar, planEvery=15)",
            usage(
                event="plan_result",
                attempt=1,
                model="x-ai/grok-4.7",
                status="applied",
                latencyMs=1000,
                inputTokens=4000,
                outputTokens=300,
                reasoningTokens=120,
                cacheReadTokens=0,
                checkpoint=1,
                decisionStep=1,
                playerVersion="2.0.0",
                reasoning="low",
                maxOutputTokens=3000,
                planEvery=15,
                maxPlans=17,
            ),
            'PROXYWAR_PLAN {"checkpoint":1,"decisionStep":1,"model":"x-ai/grok-4.7","focus":"expand","status":"applied"}',
            'PROXYWAR_DISPATCH {"checkpoint":1,"decisionStep":1,"text":"The north is mine. www.x.example"}',
            usage(
                event="plan_result",
                attempt=2,
                model="x-ai/grok-4.7",
                status="timeout",
                latencyMs=50000,
                inputTokens=4100,
                outputTokens=0,
                reasoningTokens=None,
                cacheReadTokens=0,
                checkpoint=2,
                decisionStep=15,
            ),
            'PROXYWAR_PLAN {"checkpoint":2,"decisionStep":15,"model":"x-ai/grok-4.7","status":"timeout"}',
            usage(
                event="plan_result",
                attempt=3,
                model="x-ai/grok-4.7",
                status="applied",
                latencyMs=3000,
                inputTokens=4200,
                outputTokens=500,
                reasoningTokens=200,
                cacheReadTokens=1000,
                checkpoint=3,
                decisionStep=30,
            ),
            'PROXYWAR_PLAN {"checkpoint":3,"decisionStep":30,"status":"applied"}',
            '2026-10-07T13:20:00Z PROXYWAR_SAY {"decisionStep":31,"to":"Opus 1","toID":"pidOpus","text":"Truce?","accepted":true}',
            'PROXYWAR_SAY {"decisionStep":32,"to":"Opus 1","toID":"pidOpus","text":"ignored","accepted":false}',
            "PROXYWAR_PLAN {not json}",
            usage(
                event="summary",
                inputTokens=12300,
                outputTokens=800,
                cacheReadTokens=1000,
                plans=3,
                planFailures=1,
                checkpoints=3,
            ),
        ]
        parsed = s.parse_seat_log("\n".join(lines))
        self.assertEqual(len(parsed["plans"]), 3)
        self.assertEqual(len(parsed["dispatches"]), 1)
        self.assertEqual(len(parsed["says"]), 2)
        seat = s.seat_usage(parsed)
        self.assertEqual((seat["plans"], seat["planFailures"], seat["timeouts"]), (3, 1, 1))
        self.assertEqual(seat["latencyMs"], [1000, 50000, 3000])
        self.assertEqual(seat["tokens"], {"input": 12300, "cached": 1000, "output": 800})
        telemetry = s.label_telemetry([seat], {"input": 2, "output": 6, "cache_read": 0.5})
        self.assertEqual(telemetry["latencyMsMedian"], 3000)
        self.assertEqual(telemetry["latencyMsP90"], 50000)
        self.assertEqual(telemetry["outputTokensMedian"], 300)
        self.assertEqual(telemetry["reasoningTokensMedian"], 160)
        harness = s.harness_from_logs([parsed], s.DEFAULT_HARNESS)
        self.assertEqual(
            harness,
            {
                "playerVersion": "2.0.0",
                "planEvery": 15,
                "plansPerSeat": 17,
                "reasoning": "low",
                "maxOutputTokens": 3000,
            },
        )

    def test_plan_lines_count_when_there_is_no_summary(self):
        lines = [
            'PROXYWAR_PLAN {"checkpoint":1,"status":"applied"}',
            'PROXYWAR_PLAN {"checkpoint":2,"status":"failed"}',
            'PROXYWAR_PLAN {"checkpoint":3,"status":"timeout"}',
        ]
        seat = s.seat_usage(s.parse_seat_log("\n".join(lines)))
        self.assertEqual((seat["plans"], seat["planFailures"], seat["timeouts"]), (3, 2, 1))
        self.assertIsNone(seat["tokens"])
        self.assertIsNone(s.label_telemetry([seat], {"input": 1})["usd"])

    def test_spend_limit_marks_a_capped_seat(self):
        refusal = usage(
            event="request_error", model="anthropic/claude-fable-5.1", status="spend_limit", attempt=20, latencyMs=3
        )
        self.assertTrue(s.parse_seat_log(refusal)["capped"])
        text = "plan refresh failed: anthropic/claude-fable-5.1: HTTP 429 spend_limit: episode LLM spend limit reached ($2.00)"
        self.assertTrue(s.parse_seat_log(text)["capped"])
        self.assertFalse(s.parse_seat_log("connected to match")["capped"])

    def test_capped_checkpoints_do_not_count_as_fast_plans(self):
        lines = [
            usage(event="plan_result", attempt=i, status="applied", latencyMs=15000, outputTokens=900, checkpoint=i)
            for i in range(1, 9)
        ]
        lines.append(usage(event="request_error", attempt=9, status="spend_limit", latencyMs=40, checkpoint=9))
        lines.append(usage(event="plan_result", status="failed", latencyMs=45, checkpoint=9))
        lines += [usage(event="plan_result", status="failed", latencyMs=1, checkpoint=i) for i in range(10, 18)]
        lines.append(usage(event="plan_result", attempt=20, status="timeout", latencyMs=50000, checkpoint=18))
        seat = s.seat_usage(s.parse_seat_log("\n".join(lines)))
        telemetry = s.label_telemetry([seat], None)
        self.assertTrue(telemetry["capped"])
        self.assertEqual(telemetry["latencyMsMedian"], 15000)
        self.assertEqual(telemetry["latencyMsP90"], 50000)
        self.assertEqual(telemetry["outputTokensMedian"], 900)

    def test_decode_policy_log_bytes_literal(self):
        raw = repr(b'line one\nPROXYWAR_PLAN {"status":"applied"}\n').encode()
        self.assertEqual(s.decode_policy_log(raw), 'line one\nPROXYWAR_PLAN {"status":"applied"}\n')
        self.assertEqual(s.decode_policy_log(b"plain\ntext"), "plain\ntext")


# ------------------------------------------------------------------- records
class SeasonOneReplayTest(unittest.TestCase):
    """A real hosted Season-1 game (4 teams of 3), trimmed."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads((FIXTURES / "season1-africa-replay.json").read_text())
        logs = {slot: None for slot in range(12)}
        logs[1] = (FIXTURES / "season1-africa-slot01-policy-log.txt").read_text()
        logs[2] = (FIXTURES / "season1-africa-slot02-policy-log.txt").read_text()
        cls.record = s.assemble_game_record(
            example_config(), cls.fixture["request"], cls.fixture["episode"], cls.fixture["replay"], logs
        )

    def test_shape_is_contract_b(self):
        self.assertEqual(set(self.record), CONTRACT_B_KEYS)
        self.assertEqual((self.record["schemaVersion"], self.record["season"], self.record["format"]), (2, 2, "ffa"))
        json.dumps(self.record, allow_nan=False)

    def test_conquest_winner_and_standings(self):
        record = self.record
        self.assertEqual((record["winnerLabel"], record["winType"]), ("Grok", "conquest"))
        self.assertEqual([row["label"] for row in record["standings"]], ["Grok", "Gemini", "Astra", "Fable"])
        self.assertEqual([row["rank"] for row in record["standings"]], [1, 2, 3, 4])
        rows = {row["label"]: row for row in record["standings"]}
        self.assertEqual(rows["Grok"]["tilesOwned"], 451347 + 263660 + 1407036)
        self.assertAlmostEqual(sum(row["landShare"] for row in record["standings"]), 1.0, places=3)
        # A side is out when its last seat falls.
        self.assertEqual(rows["Astra"]["eliminatedAtTurn"], 20400)
        self.assertEqual(rows["Fable"]["eliminatedAtTurn"], 19100)
        self.assertIsNone(rows["Gemini"]["eliminatedAtTurn"])
        self.assertEqual(
            {side["label"]: side["team"] for side in record["sides"]},
            {"Astra": "Yellow", "Fable": "Green", "Gemini": "Red", "Grok": "Blue"},
        )
        self.assertEqual((record["turnCount"], record["decisionCount"], record["degradedCount"]), (23600, 2288, 184))

    def test_moments(self):
        moments = self.record["moments"]
        self.assertEqual([m["turn"] for m in moments], sorted(m["turn"] for m in moments))
        self.assertIn({"turn": 19100, "kind": "elimination", "text": "Fable was eliminated"}, moments)
        self.assertIn({"turn": 20400, "kind": "elimination", "text": "Astra was eliminated"}, moments)
        alliances = [m for m in moments if m["kind"] == "alliance"]
        self.assertEqual(
            len(alliances),
            len({frozenset(m["text"].replace(" formed an alliance", "").split(" and ")) for m in alliances}),
        )
        self.assertIn({"turn": 6800, "kind": "lead_change", "text": "Grok took the lead from Fable"}, moments)
        self.assertLessEqual(len(moments), s.MAX_MOMENTS)

    def test_messages_and_telemetry(self):
        voices = self.record["voices"]
        self.assertEqual(len(voices), 40)
        self.assertTrue(all(v["kind"] == "message" and len(v["text"]) <= 280 for v in voices))
        self.assertTrue(all(v["to"] in {"Astra", "Fable", "Gemini", "Grok"} for v in voices))
        pairs = {(v["label"], v["to"]) for v in voices}
        self.assertGreaterEqual(len(pairs), 6)
        self.assertEqual(set(self.record["telemetry"]), {"Astra", "Grok"})  # only seats with a readable log
        self.assertEqual(self.record["telemetry"]["Grok"]["plans"], 22)
        self.assertEqual(self.record["harness"]["planEvery"], 6)


class FfaRecordTest(unittest.TestCase):
    def setUp(self):
        self.config = example_config()
        self.plan = s.plan_game(self.config, 3)
        self.episode = {
            "id": "ereq_1",
            "status": "completed",
            "replay_url": "https://example.test/r.replay",
            "completed_at": "2026-10-07T13:44:00Z",
            "cost_usd": 0.05,
        }

    def test_step_cap_is_decided_on_points(self):
        seats = seats_for(
            self.plan, {"Astra": 100, "Fable": 300, "Opus": 250, "Gemini": 50, "Grok": 0}, {"Grok": False}
        )
        snapshots = [
            {
                "turnNumber": 400,
                "players": [
                    {
                        "username": f"{x['label']} 1",
                        "playerID": x["pid"],
                        "isAlive": True,
                        "hasSpawned": True,
                        "tilesOwned": 10,
                    }
                    for x in seats
                ],
            },
            {
                "turnNumber": 1200,
                "players": [
                    {
                        "username": f"{x['label']} 1",
                        "playerID": x["pid"],
                        "isAlive": x["label"] != "Grok",
                        "hasSpawned": True,
                        "tilesOwned": {"Opus": 90}.get(x["label"], 20 if x["label"] != "Grok" else 0),
                    }
                    for x in seats
                ],
            },
            {
                "turnNumber": 2000,
                "players": [
                    {
                        "username": f"{x['label']} 1",
                        "playerID": x["pid"],
                        "isAlive": x["label"] != "Grok",
                        "hasSpawned": True,
                        "tilesOwned": {"Fable": 300}.get(x["label"], 10),
                    }
                    for x in seats
                ],
            },
        ]
        replay = ffa_replay(seats, winner_team=None, snapshots=snapshots)
        record = s.assemble_game_record(self.config, request_record(self.plan), self.episode, replay, {})
        self.assertEqual((record["winnerLabel"], record["winType"]), ("Fable", "points"))
        rows = {row["label"]: row for row in record["standings"]}
        self.assertEqual(rows["Grok"]["eliminatedAtTurn"], 1200)
        self.assertEqual(rows["Grok"]["rank"], 5)
        self.assertEqual(record["telemetry"], {})
        self.assertEqual(
            [m["text"] for m in record["moments"] if m["kind"] == "lead_change"], ["Fable took the lead from Opus"]
        )
        self.assertEqual(record["episodeIndex"], self.plan["episode_index"])
        self.assertEqual(
            {side["label"]: side["pickOrder"] for side in record["sides"]},
            {side["label"]: side["pickOrder"] for side in self.plan["sides"]},
        )

    def test_tie_at_the_top_has_no_winner(self):
        seats = seats_for(self.plan, {"Astra": 300, "Fable": 300, "Opus": 10, "Gemini": 10, "Grok": 10})
        record = s.assemble_game_record(self.config, request_record(self.plan), self.episode, ffa_replay(seats), {})
        self.assertEqual((record["winnerLabel"], record["winType"]), (None, "none"))
        self.assertEqual([row["rank"] for row in record["standings"]], [1, 1, 3, 3, 3])

    def test_engine_winner_at_the_timer_is_a_points_win(self):
        seats = seats_for(self.plan, {"Astra": 600, "Fable": 300, "Opus": 100, "Gemini": 0, "Grok": 0})
        team = next(x["team"] for x in seats if x["label"] == "Astra")
        early = s.assemble_game_record(
            self.config,
            request_record(self.plan),
            self.episode,
            ffa_replay(seats, winner_team=team, turn_count=20000),
            {},
        )
        late = s.assemble_game_record(
            self.config,
            request_record(self.plan),
            self.episode,
            ffa_replay(seats, winner_team=team, turn_count=36400),
            {},
        )
        self.assertEqual((early["winnerLabel"], early["winType"]), ("Astra", "conquest"))
        self.assertEqual((late["winnerLabel"], late["winType"]), ("Astra", "points"))

    def test_betrayals_nukes_and_alliances_from_telemetry(self):
        seats = seats_for(self.plan, {"Astra": 100, "Fable": 300, "Opus": 250, "Gemini": 50, "Grok": 40})
        events = [
            {
                "turnNumber": 900,
                "kind": "alliance_formed",
                "actorName": "Opus 1",
                "targetName": "Grok 1",
                "evidenceLevel": "confirmed_effect",
            },
            {
                "turnNumber": 950,
                "kind": "alliance_formed",
                "actorName": "Grok 1",
                "targetName": "Opus 1",
                "evidenceLevel": "confirmed_effect",
            },
            {
                "turnNumber": 960,
                "kind": "alliance_formed",
                "actorName": "Astra 1",
                "targetName": "Gemini 1",
                "evidenceLevel": "accepted_action",
            },
            # Accepted but never carried out: "moves to break", "attempts to escalate".
            {
                "turnNumber": 4000,
                "kind": "alliance_break",
                "actorName": "Opus 1",
                "targetName": "Grok 1",
                "evidenceLevel": "accepted_action",
            },
            {
                "turnNumber": 4100,
                "kind": "nuke",
                "actorName": "Astra 1",
                "targetName": "Fable 1",
                "evidenceLevel": "accepted_action",
            },
            {"turnNumber": 4200, "kind": "nuke", "actorName": "Astra 1", "targetName": "Fable 1"},
            {
                "turnNumber": 5000,
                "kind": "alliance_break",
                "actorName": "Grok 1",
                "targetName": "Opus 1",
                "evidenceLevel": "confirmed_effect",
            },
            {
                "turnNumber": 7000,
                "kind": "nuke",
                "actorName": "Fable 1",
                "targetName": "Grok 1",
                "evidenceLevel": "confirmed_effect",
            },
            {"turnNumber": 7100, "kind": "elimination", "actorName": "Grok 1"},
        ]
        record = s.assemble_game_record(
            self.config, request_record(self.plan), self.episode, ffa_replay(seats, events=events), {}
        )
        self.assertEqual(
            [(m["turn"], m["kind"], m["text"]) for m in record["moments"]],
            [
                (900, "alliance", "Opus and Grok formed an alliance"),
                (5000, "betrayal", "Grok broke its alliance with Opus"),
                (7000, "nuke", "Fable launched a nuke at Grok"),
            ],
        )

    def test_moments_from_intents_when_telemetry_is_missing(self):
        seats = seats_for(self.plan, {"Astra": 100, "Fable": 300, "Opus": 250, "Gemini": 50, "Grok": 40})
        intents = [
            {
                "turnNumber": 500,
                "intents": [{"type": "allianceRequest", "recipient": "pidOpus", "clientID": "cidGrok"}],
            },
            {
                "turnNumber": 600,
                "intents": [{"type": "allianceRequest", "recipient": "pidGrok", "clientID": "cidOpus"}],
            },
            {"turnNumber": 3000, "intents": [{"type": "breakAlliance", "recipient": "pidOpus", "clientID": "cidGrok"}]},
            {
                "turnNumber": 3100,
                "intents": [
                    {"type": "build_unit", "unit": "Hydrogen Bomb", "tile": 5, "clientID": "cidFable"},
                    {"type": "build_unit", "unit": "City", "tile": 6, "clientID": "cidFable"},
                ],
            },
            {
                "turnNumber": 3200,
                "intents": [
                    {
                        "type": "agent_message",
                        "recipient": "pidGrok",
                        "text": "You will regret that, @grok. https://x.example",
                        "clientID": "cidOpus",
                    }
                ],
            },
        ]
        record = s.assemble_game_record(
            self.config, request_record(self.plan), self.episode, ffa_replay(seats, intents=intents), {}
        )
        self.assertEqual(
            [m["text"] for m in record["moments"]],
            ["Grok and Opus formed an alliance", "Grok broke its alliance with Opus", "Fable launched a hydrogen bomb"],
        )
        self.assertEqual(
            record["voices"],
            [{"label": "Opus", "kind": "message", "to": "Grok", "turn": 3200, "text": "You will regret that,"}],
        )

    def test_breaking_an_alliance_that_never_formed_is_no_betrayal(self):
        seats = seats_for(self.plan, {"Astra": 100, "Fable": 300, "Opus": 250, "Gemini": 50, "Grok": 40})
        intents = [
            {
                "turnNumber": 500,
                "intents": [{"type": "allianceRequest", "recipient": "pidOpus", "clientID": "cidGrok"}],
            },
            {"turnNumber": 900, "intents": [{"type": "breakAlliance", "recipient": "pidOpus", "clientID": "cidGrok"}]},
        ]
        record = s.assemble_game_record(
            self.config, request_record(self.plan), self.episode, ffa_replay(seats, intents=intents), {}
        )
        self.assertEqual(record["moments"], [])

    def test_dispatches_and_says_from_seat_logs(self):
        seats = seats_for(self.plan, {"Astra": 100, "Fable": 300, "Opus": 250, "Gemini": 50, "Grok": 40})
        # decisionStep 15 is the server's step 14 (the player counts from 1).
        replay = ffa_replay(seats, ledger=[{"step": 14, "turnNumber": 1850}])
        slot_of = {side["label"]: side["slots"][0] for side in self.plan["sides"]}
        logs = {slot: None for slot in range(5)}
        logs[slot_of["Opus"]] = "\n".join(
            [
                'PROXYWAR_DISPATCH {"checkpoint":1,"decisionStep":15,"text":"Opus holds the strait. Visit https://spam.example"}',
                'PROXYWAR_DISPATCH {"checkpoint":2,"decisionStep":30,"text":"Opus holds the strait. Visit https://spam.example"}',
                'PROXYWAR_DISPATCH {"checkpoint":3,"decisionStep":45,"text":"   "}',
                'PROXYWAR_SAY {"decisionStep":16,"to":"Grok 1","toID":"pidGrok","text":"Stay north and we stay friends.","accepted":true}',
                usage(event="summary", inputTokens=1000, outputTokens=100, cacheReadTokens=0, plans=3, planFailures=0),
            ]
        )
        record = s.assemble_game_record(self.config, request_record(self.plan), self.episode, replay, logs)
        self.assertEqual(
            record["voices"],
            [
                {"label": "Opus", "kind": "dispatch", "to": None, "turn": 1850, "text": "Opus holds the strait. Visit"},
                {
                    "label": "Opus",
                    "kind": "message",
                    "to": "Grok",
                    "turn": 1900,
                    "text": "Stay north and we stay friends.",
                },
            ],
        )
        self.assertEqual(set(record["telemetry"]), {"Opus"})
        self.assertEqual(record["telemetry"]["Opus"]["usd"], round((1000 * 4 + 100 * 20) / 1e6, 4))

    def test_missing_replay_and_logs_still_make_a_record(self):
        record = s.assemble_game_record(self.config, request_record(self.plan), self.episode, None, {0: None})
        self.assertEqual(set(record), CONTRACT_B_KEYS)
        self.assertEqual(
            (record["winnerLabel"], record["winType"], record["voices"], record["moments"], record["telemetry"]),
            (None, "none", [], [], {}),
        )
        # Nothing is known about the board, so no standings are made up.
        self.assertEqual(record["standings"], [])
        self.assertEqual(record["harness"], self.config["harness"])

    def test_a_seat_that_never_connected_makes_no_contest(self):
        seats = seats_for(self.plan, {"Astra": 100, "Fable": 300, "Opus": 250, "Gemini": 50, "Grok": 0})
        replay = ffa_replay(seats)
        grok_slot = next(side["slots"][0] for side in self.plan["sides"] if side["label"] == "Grok")
        replay["unavailablePlayerSlots"] = [grok_slot]
        record = s.assemble_game_record(self.config, request_record(self.plan), self.episode, replay, {})
        self.assertEqual((record["winnerLabel"], record["winType"], record["standings"]), (None, "none", []))
        self.assertEqual(s.unavailable_labels(replay, self.plan["sides"]), ["Grok"])

    def test_odd_replay_shapes_thin_the_record_instead_of_failing(self):
        seats = seats_for(self.plan, {"Astra": 100, "Fable": 300, "Opus": 250, "Gemini": 50, "Grok": 40})
        odd = [
            {"spectator-telemetry.json": json.dumps({"events": [None, 3, {"kind": "nuke", "actorName": ["x"]}]})},
            {"spectator-telemetry.json": json.dumps([{"kind": "elimination"}])},
            {"deal-ledger.json": json.dumps({"decisionSteps": [None, {"step": "1", "turnNumber": 5}]})},
            {"game-record.json": json.dumps({"info": [], "turns": [None, {"turnNumber": 5, "intents": "x"}]})},
            {"game-record.json": json.dumps({"turns": [{"turnNumber": 5, "intents": [{"recipient": ["x"]}]}]})},
        ]
        for artifacts in odd:
            replay = ffa_replay(seats)
            replay["inlineRunArtifacts"] = artifacts
            replay["spectatorReplay"] = {
                "snapshots": [None, {"turnNumber": 400, "players": [None, {"tilesOwned": "9"}]}]
            }
            record = s.assemble_game_record(self.config, request_record(self.plan), self.episode, replay, {})
            self.assertEqual(record["winnerLabel"], "Fable")
        logs = {
            0: 'PROXYWAR_SAY {"decisionStep":3,"toID":["x"],"text":"hi","accepted":true}\n'
            + usage(event="summary", inputTokens=10, outputTokens="lots", plans=1)
        }
        record = s.assemble_game_record(self.config, request_record(self.plan), self.episode, ffa_replay(seats), logs)
        self.assertEqual(len(record["telemetry"]), 1)

    def test_viewer_url_needs_a_real_base(self):
        seats = seats_for(self.plan, {"Astra": 1})
        record = s.assemble_game_record(self.config, request_record(self.plan), self.episode, ffa_replay(seats), {})
        self.assertIsNone(record["viewerUrl"])  # the example base is still a placeholder
        config = dict(self.config, replay_viewer_base="https://viewer.example/index.html?v=2")
        record = s.assemble_game_record(config, request_record(self.plan), self.episode, ffa_replay(seats), {})
        self.assertEqual(
            record["viewerUrl"], "https://viewer.example/index.html?v=2#replay=https%3A%2F%2Fexample.test%2Fr.replay"
        )


class VoiceSelectionTest(unittest.TestCase):
    labels = ["Astra", "Fable", "Opus", "Gemini", "Grok"]

    def test_caps_at_forty_and_keeps_every_model_and_first_messages(self):
        dispatches = [
            {"label": label, "kind": "dispatch", "to": None, "turn": 400 + step * 1500, "text": f"{label} {step}"}
            for label in self.labels
            for step in range(17)
        ]
        messages = [
            {"label": a, "kind": "message", "to": b, "turn": 1000 + 37 * i + 1000 * n, "text": f"{a}>{b} {n}"}
            for i, (a, b) in enumerate((a, b) for a in self.labels for b in self.labels if a != b)
            for n in range(3)
        ]
        voices = s.select_voices(dispatches, messages, [5000], self.labels)
        self.assertEqual(len(voices), 40)
        self.assertEqual([v["turn"] for v in voices], sorted(v["turn"] for v in voices))
        for label in self.labels:
            self.assertGreaterEqual(sum(1 for v in voices if v["kind"] == "dispatch" and v["label"] == label), 4)
        firsts = {(v["label"], v["to"]) for v in voices if v["kind"] == "message" and v["text"].endswith(" 0")}
        self.assertEqual(len(firsts), 20)

    def test_small_games_keep_everything(self):
        dispatches = [{"label": "Opus", "kind": "dispatch", "to": None, "turn": 400, "text": "a"}]
        messages = [{"label": "Grok", "kind": "message", "to": "Opus", "turn": 300, "text": "b"}]
        self.assertEqual(s.select_voices(dispatches, messages, [], self.labels), messages + dispatches)


# ------------------------------------------------------------------ the loop
class FakeResponse:
    def __init__(self, data):
        self.data = data

    def model_dump(self, mode=None):
        return dict(self.data)


class FakeClient:
    def __init__(self):
        self.created: list[dict] = []
        self.status: dict[str, str] = {}
        self.episodes: dict[str, list] = {}
        self.logs: dict[str, bytes] = {}
        self.refusal: str | None = None
        self.budget = {"remaining_usd": 500.0, "budget_status": "ok"}

    def create_experience_request(self, body):
        if self.refusal:
            raise RuntimeError(self.refusal)
        self.created.append(body)
        request_id = f"xreq_{len(self.created)}"
        self.status[request_id] = "running"
        return FakeResponse(
            {"id": request_id, "status": "queued", "created_at": "now", "cost_preview": {"estimated_cost_credits": 30}}
        )

    def get_experience_request(self, request_id):
        return FakeResponse(
            {"id": request_id, "status": self.status[request_id], "completed_at": "2026-10-07T13:45:00Z"}
        )

    def _get(self, path, kind):
        if path.endswith("/budget"):
            return self.budget
        return self.episodes[path.split("/")[3]]

    def get_bytes(self, path):
        if path in self.logs:
            return self.logs[path]
        raise RuntimeError("404")

    def finish(self, request_id: str, body: dict):
        self.status[request_id] = "completed"
        self.episodes[request_id] = [
            {
                "id": f"ereq_{request_id}",
                "status": "completed",
                "replay_url": f"https://replays.example/{request_id}.replay",
                "completed_at": "2026-10-07T13:44:00Z",
                "cost_usd": 0.05,
            }
        ]
        for entry in body["roster"]:
            self.logs[
                f"/v2/episode-requests/ereq_{request_id}/{entry['player']['policy_ref']}/policy-logs/{entry['slot']}"
            ] = repr(
                (
                    "PROXYWAR_LLM_USAGE "
                    + json.dumps(
                        {"event": "summary", "inputTokens": 1000, "outputTokens": 100, "plans": 2, "planFailures": 0}
                    )
                    + "\n"
                ).encode()
            ).encode()

    def fail(self, request_id: str):
        self.status[request_id] = "failed"
        self.episodes[request_id] = [{"id": f"ereq_{request_id}", "status": "failed", "error": "pod crashed"}]


class Clock:
    def __init__(self, text: str):
        self.now = s.parse_iso(text)

    def set(self, text: str):
        self.now = s.parse_iso(text)

    def __call__(self):
        return self.now


class LoopTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.temp.name) / "frontier-ffa"
        self.config = example_config(self.state_dir)
        self.clock = Clock("2026-10-07T12:00:00Z")
        self.client = FakeClient()
        self.replays: dict[str, bytes] = {}
        patches = [
            mock.patch.object(s, "utcnow", self.clock),
            mock.patch.object(s, "fetch_public", lambda url, timeout=180.0: self.replays[url]),
            contextlib.redirect_stdout(io.StringIO()),
        ]
        self.stack = contextlib.ExitStack()
        for patch in patches:
            self.stack.enter_context(patch)

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def scheduler(self, mode="season") -> s.Scheduler:
        return s.Scheduler(self.config, dry_run=False, client=self.client, mode=mode)

    def finish_last(self, unavailable_slots=None):
        request_id = f"xreq_{len(self.client.created)}"
        body = self.client.created[-1]
        self.client.finish(request_id, body)
        labels = body["game_config_overrides"]["team_labels"]
        seats = [
            {"label": label, "team": f"T{i}", "tiles": 100 * (i + 1), "alive": True, "pid": f"p{i}", "cid": f"c{i}"}
            for i, label in enumerate(labels)
        ]
        replay = ffa_replay(seats)
        if unavailable_slots is not None:
            replay["unavailablePlayerSlots"] = unavailable_slots
        self.replays[f"https://replays.example/{request_id}.replay"] = json.dumps(replay).encode()

    def games(self, test=False) -> list[dict]:
        path = Path(self.config["test_games_path" if test else "games_path"])
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_one_game_per_appointment_never_two_at_once_and_missed_slots_skipped(self):
        scheduler = self.scheduler()
        scheduler.tick()
        self.assertEqual(self.client.created, [])
        self.clock.set("2026-10-07T13:02:00Z")
        scheduler.tick()
        self.assertEqual(len(self.client.created), 1)
        first = self.client.created[0]
        self.assertEqual(first["variant_id"], "ffa5-pangaea")
        # The platform splits the request's limit evenly: 5 seats at 5.0 each.
        self.assertEqual(first["episode_player_llm_spend_limit_usd"], 25.0)
        self.assertEqual(first["game_config_overrides"]["episodeIndex"], 0)
        self.assertEqual(first["idempotency_key"], "ffa-01234567-g0-ffa5-pangaea")
        self.clock.set("2026-10-07T13:10:00Z")
        scheduler.tick()
        self.assertEqual(len(self.client.created), 1)
        # Still running through the whole 19:00 window: that appointment is skipped.
        for moment in ("2026-10-07T19:00:00Z", "2026-10-07T19:29:00Z", "2026-10-07T19:31:00Z"):
            self.clock.set(moment)
            scheduler.tick()
        self.assertEqual(len(self.client.created), 1)
        self.assertEqual(
            scheduler.state["slots"]["2026-10-07T19:00Z"], {"status": "missed", "why": "a game was still running"}
        )
        self.finish_last()
        self.clock.set("2026-10-07T19:40:00Z")
        scheduler.tick()
        self.assertEqual(len(self.client.created), 1)  # not made up
        self.assertEqual(len(self.games()), 1)
        self.assertEqual(self.games()[0]["gameIndex"], 0)
        self.assertEqual(scheduler.state["inflight"], [])
        self.clock.set("2026-10-08T13:00:00Z")
        scheduler.tick()
        self.assertEqual(len(self.client.created), 2)
        self.assertEqual(self.client.created[1]["variant_id"], "ffa5-asia")
        self.assertEqual(self.client.created[1]["game_config_overrides"]["episodeIndex"], 1)
        state = json.loads((self.state_dir / "state.json").read_text())
        self.assertEqual(state["cursor"], 2)
        self.assertGreater(state["spend"]["2026-10-07"], 0.05)

    def test_a_game_without_a_fair_result_is_played_again_with_its_rotation(self):
        scheduler = self.scheduler()
        self.clock.set("2026-10-07T13:01:00Z")
        scheduler.tick()
        first = self.client.created[0]
        self.client.fail("xreq_1")
        self.clock.set("2026-10-07T13:20:00Z")
        scheduler.tick()
        self.assertEqual(scheduler.state["retry"], [{"game_index": 0, "attempt": 1}])
        self.assertEqual(self.games(), [])
        # The next appointment plays game 0 again, under a fresh key.
        self.clock.set("2026-10-07T19:01:00Z")
        scheduler.tick()
        again = self.client.created[1]
        self.assertEqual(again["idempotency_key"], first["idempotency_key"] + "-r1")
        for field in ("variant_id", "roster", "game_config_overrides"):
            self.assertEqual(again[field], first[field])
        self.assertEqual((scheduler.state["retry"], scheduler.state["cursor"]), ([], 1))
        # A seat that never connected is no fair game either.
        self.finish_last(unavailable_slots=[2])
        self.clock.set("2026-10-07T19:20:00Z")
        scheduler.tick()
        (game,) = self.games()
        self.assertEqual((game["gameIndex"], game["winType"], game["standings"]), (0, "none", []))
        self.assertEqual(scheduler.state["retry"], [{"game_index": 0, "attempt": 2}])
        self.clock.set("2026-10-08T13:01:00Z")
        scheduler.tick()
        self.assertTrue(self.client.created[2]["idempotency_key"].endswith("-r2"))
        self.client.fail("xreq_3")
        self.clock.set("2026-10-08T13:20:00Z")
        scheduler.tick()
        # Retries run out: the season moves on to game 1.
        self.assertEqual(scheduler.state["retry"], [])
        self.clock.set("2026-10-08T19:01:00Z")
        scheduler.tick()
        self.assertEqual(self.client.created[3]["variant_id"], "ffa5-asia")
        self.assertEqual(scheduler.state["cursor"], 2)

    def test_a_record_that_cannot_be_built_does_not_stop_the_season(self):
        self.config["record_retry_ticks"] = 2
        scheduler = self.scheduler()
        self.clock.set("2026-10-07T13:01:00Z")
        scheduler.tick()
        self.finish_last()
        real = s.assemble_game_record

        def replay_breaks(config, record, episode, replay, logs):
            if replay is not None:
                raise AttributeError("'list' object has no attribute 'get'")
            return real(config, record, episode, replay, logs)

        with mock.patch.object(s, "assemble_game_record", replay_breaks):
            scheduler.tick()
        (game,) = self.games()
        self.assertEqual(len(game["telemetry"]), 5)  # the seat logs still made it in
        self.assertEqual(scheduler.state["inflight"], [])
        self.clock.set("2026-10-07T19:01:00Z")
        scheduler.tick()
        self.assertEqual(len(self.client.created), 2)
        with mock.patch.object(s, "assemble_game_record", side_effect=RuntimeError("broken")):
            self.finish_last()
            scheduler.tick()
            self.assertEqual(len(scheduler.state["inflight"]), 1)
            record = json.loads((self.state_dir / "requests" / f"{scheduler.state['inflight'][0]}.json").read_text())
            self.assertEqual(record["record_attempts"], 1)  # saved although settling failed
            scheduler.tick()
        self.assertEqual(scheduler.state["inflight"], [])  # let go after record_retry_ticks

    def test_a_restart_inside_the_window_does_not_launch_twice(self):
        self.clock.set("2026-10-07T13:01:00Z")
        self.scheduler().tick()
        self.finish_last()
        self.clock.set("2026-10-07T13:20:00Z")
        restarted = self.scheduler()
        restarted.tick()
        self.assertEqual(len(self.client.created), 1)
        self.assertEqual(len(self.games()), 1)

    def test_credits_refusal_holds_until_the_refill(self):
        self.client.refusal = "Request failed (402) for /v2/experience-requests: experience credits exhausted; next refill 2026-10-08T00:00:00Z"
        scheduler = self.scheduler()
        self.clock.set("2026-10-07T13:01:00Z")
        scheduler.tick()
        self.assertEqual(scheduler.state["credits_hold_until"], "2026-10-08T00:00:00Z")
        self.client.refusal = None
        self.clock.set("2026-10-07T13:10:00Z")
        scheduler.tick()
        self.assertEqual(self.client.created, [])
        self.clock.set("2026-10-07T13:31:00Z")
        scheduler.tick()
        self.assertIn("credits exhausted", scheduler.state["slots"]["2026-10-07T13:00Z"]["why"])
        self.clock.set("2026-10-08T13:00:00Z")
        scheduler.tick()
        self.assertEqual(len(self.client.created), 1)
        self.assertEqual(self.client.created[0]["variant_id"], "ffa5-pangaea")

    def test_budget_floor_and_daily_cap_hold(self):
        self.client.budget = {"remaining_usd": 10.0, "budget_status": "ok"}
        scheduler = self.scheduler()
        self.clock.set("2026-10-07T13:01:00Z")
        scheduler.tick()
        self.assertEqual(self.client.created, [])
        self.client.budget = {"remaining_usd": 500.0, "budget_status": "ok"}
        scheduler.state["spend"]["2026-10-07"] = self.config["caps"]["daily_usd"]
        scheduler.tick()
        self.assertEqual(self.client.created, [])
        self.assertTrue(scheduler.last_hold.startswith("daily cap"))

    def test_test_launch_keeps_the_rotation_and_the_season_file(self):
        scheduler = self.scheduler(mode="launch_now")
        scheduler.queue_launch_now("ffa5-canary", None)
        scheduler.tick()
        body = self.client.created[0]
        self.assertEqual(body["variant_id"], "ffa5-canary")
        self.assertEqual(body["episode_player_llm_spend_limit_usd"], 5.0)
        self.assertEqual(body["game_config_overrides"]["episodeIndex"], 0)
        self.assertEqual(scheduler.state["cursor"], 0)
        self.assertFalse(scheduler.idle())
        self.finish_last()
        scheduler.tick()
        self.assertTrue(scheduler.idle())
        self.assertEqual(self.games(), [])
        (game,) = self.games(test=True)
        self.assertTrue(game["test"])
        self.assertEqual(game["variantId"], "ffa5-canary")
        self.assertEqual(game["map"], "World")
        self.assertEqual(set(game["telemetry"]), {"Astra", "Fable", "Opus", "Gemini", "Grok"})
        self.assertEqual(game["winnerLabel"], body["game_config_overrides"]["team_labels"][-1])

    def test_launch_now_without_variant_is_the_next_season_game(self):
        scheduler = self.scheduler(mode="launch_now")
        scheduler.queue_launch_now(None, None)
        scheduler.tick()
        self.assertEqual(self.client.created[0]["variant_id"], "ffa5-pangaea")
        self.assertEqual(scheduler.state["cursor"], 1)
        self.assertEqual(scheduler.state["slots"], {})

    def test_seat_spend_limit_is_only_for_test_launches(self):
        config_path = Path(self.temp.name) / "frontier-ffa.json"
        config_path.write_text(EXAMPLE.read_text())
        with contextlib.redirect_stderr(io.StringIO()):
            for argv in (["--launch-now", "--seat-spend-limit", "3"], ["--seat-spend-limit", "3"]):
                with self.assertRaises(SystemExit):
                    s.main(["--config", str(config_path), *argv])
        scheduler = self.scheduler(mode="launch_now")
        scheduler.queue_launch_now("ffa5-canary", 0.5)
        scheduler.tick()
        self.assertEqual(self.client.created[0]["episode_player_llm_spend_limit_usd"], 2.5)
        # A season game left in launch-now.json with a cap of its own still
        # runs on the season cap.
        self.finish_last()
        scheduler.tick()
        scheduler.queue_launch_now(None, 0.5)
        scheduler.tick()
        self.assertEqual(self.client.created[1]["episode_player_llm_spend_limit_usd"], 25.0)

    def test_launch_now_expires(self):
        scheduler = self.scheduler(mode="launch_now")
        scheduler.queue_launch_now("ffa5-canary", 1.0)
        self.client.budget = {"remaining_usd": 0.0}
        scheduler.tick()
        self.clock.set("2026-10-07T12:31:00Z")
        scheduler.tick()
        self.assertTrue(scheduler.idle())
        self.assertEqual(self.client.created, [])

    def test_launch_now_is_left_for_a_running_scheduler(self):
        config_path = Path(self.temp.name) / "frontier-ffa.json"
        raw = json.loads(EXAMPLE.read_text())
        raw.update(
            state_dir=str(self.state_dir),
            games_path=str(self.state_dir / "g.jsonl"),
            test_games_path=str(self.state_dir / "t.jsonl"),
        )
        config_path.write_text(json.dumps(raw))
        # The example's placeholder ids never reach a real launch.
        self.assertEqual(s.main(["--config", str(config_path), "--once"]), 64)
        self.assertFalse(self.state_dir.exists())
        raw["coworld_id"] = "cow_0123456789abcdef"
        for team in raw["teams"]:
            team["policy_ref"] = f"policy-{team['label']}"
        config_path.write_text(json.dumps(raw))
        lock = s.acquire_lock(self.state_dir)
        try:
            self.assertEqual(s.main(["--config", str(config_path), "--launch-now", "--variant", "ffa5-canary"]), 0)
            self.assertEqual(s.main(["--config", str(config_path), "--once"]), 1)
        finally:
            lock.close()
        queued = json.loads((self.state_dir / "launch-now.json").read_text())
        self.assertEqual(queued["variant"], "ffa5-canary")
        scheduler = self.scheduler()
        scheduler.tick()
        self.assertFalse((self.state_dir / "launch-now.json").exists())
        self.assertEqual(self.client.created[0]["variant_id"], "ffa5-canary")

    def test_record_waits_for_the_replay_then_degrades(self):
        self.config["record_retry_ticks"] = 3
        scheduler = self.scheduler()
        self.clock.set("2026-10-07T13:01:00Z")
        scheduler.tick()
        self.client.finish("xreq_1", self.client.created[0])  # no replay published
        for _ in range(2):
            scheduler.tick()
            self.assertEqual(scheduler.state["inflight"], ["ffa-01234567-g0-ffa5-pangaea"])
        scheduler.tick()
        self.assertEqual(scheduler.state["inflight"], [])
        (game,) = self.games()
        self.assertEqual(game["winType"], "none")
        self.assertEqual(len(game["telemetry"]), 5)

    def test_dry_run_creates_nothing(self):
        config_path = Path(self.temp.name) / "frontier-ffa.json"
        raw = json.loads(EXAMPLE.read_text())
        raw.update(state_dir=str(self.state_dir))
        raw.pop("games_path")
        raw.pop("test_games_path")
        config_path.write_text(json.dumps(raw))
        before = sorted(Path(self.temp.name).rglob("*"))
        output = io.StringIO()
        with (
            mock.patch.object(s.Scheduler, "client", new_callable=mock.PropertyMock, return_value=self.client),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(s.main(["--config", str(config_path), "--dry-run", "--once"]), 0)
            self.assertEqual(
                s.main(["--config", str(config_path), "--dry-run", "--launch-now", "--variant", "ffa5-canary"]), 0
            )
        self.assertEqual(sorted(Path(self.temp.name).rglob("*")), before)
        self.assertFalse(self.state_dir.exists())
        self.assertEqual(self.client.created, [])
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        launches = [e for e in events if e["event"] == "dry_run_launch"]
        self.assertEqual([e["variant"] for e in launches], ["ffa5-pangaea", "ffa5-canary"])
        self.assertEqual(launches[0]["body"]["game_config_overrides"]["episodeIndex"], 0)
        self.assertTrue(any(e["event"] == "dry_run_budget" and e["allowed"] for e in events))


if __name__ == "__main__":
    unittest.main()
